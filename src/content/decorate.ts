// Landscape decoration: rivers, walls of obstacles along zone borders (left open only at the guarded gates) and
// clustered forests, mountains, rocks and small details inside zones.

import { GenerationError } from '../errors.ts';
import { ObjectGroup } from '../fh2m/types.ts';
import { NEIGHBOR_DIRECTIONS, ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import { findObjects, fitsTerrain, type ObjectInfo } from '../objects.ts';
import { Ground } from '../terrain/ground.ts';
import { ValueNoise } from '../terrain/noise.ts';
import { containsRoad } from '../terrain/transitions.ts';
import { Reserve } from './builder.ts';
import type { ContentContext } from './content.ts';
import { noBuildTiles, sealInfo, type SealInfo } from './seal.ts';

interface ObstacleSets {
  big: ObjectInfo[]; // mountains and multi-tile tree groups
  trees: ObjectInfo[];
  mountains: ObjectInfo[];
  small: ObjectInfo[]; // single-tile blockers
  details: ObjectInfo[]; // rocks, shrubs, lakes, flowers
  flat: ObjectInfo[]; // non-blocking ground details (cracks, holes)
}

const LANDSCAPE_GROUPS = [ObjectGroup.LANDSCAPE_MOUNTAINS, ObjectGroup.LANDSCAPE_TREES, ObjectGroup.LANDSCAPE_ROCKS, ObjectGroup.LANDSCAPE_MISCELLANEOUS] as const;

const setsCache = new Map<string, ObstacleSets>();

export function obstacleSets(ground: Ground, expansion: boolean): ObstacleSets {
  const key = `${ground}/${expansion}`;
  const cached = setsCache.get(key);
  if (cached) return cached;
  const all: ObjectInfo[] = [];
  for (const group of LANDSCAPE_GROUPS) {
    for (const info of findObjects({ group, terrain: ground })) {
      if (!expansion && info.expansion) continue;
      // Neutral art (null terrains) is fine for mountains and rocks; skip neutral misc objects (river deltas etc.).
      if (info.terrains === null && group === ObjectGroup.LANDSCAPE_MISCELLANEOUS) continue;
      all.push(info);
    }
  }
  const sets: ObstacleSets = {
    big: all.filter((o) => (o.group === ObjectGroup.LANDSCAPE_MOUNTAINS || o.group === ObjectGroup.LANDSCAPE_TREES) && o.occupied.length >= 3),
    trees: all.filter((o) => o.group === ObjectGroup.LANDSCAPE_TREES && o.occupied.length > 0),
    mountains: all.filter((o) => o.group === ObjectGroup.LANDSCAPE_MOUNTAINS && o.occupied.length > 0),
    small: all.filter((o) => o.occupied.length === 1 && o.group !== ObjectGroup.LANDSCAPE_MISCELLANEOUS),
    details: all.filter((o) => (o.group === ObjectGroup.LANDSCAPE_ROCKS || o.group === ObjectGroup.LANDSCAPE_MISCELLANEOUS) && o.occupied.length > 0),
    flat: all.filter((o) => o.occupied.length === 0 && o.group === ObjectGroup.LANDSCAPE_MISCELLANEOUS),
  };
  if (sets.small.length === 0) sets.small = all.filter((o) => o.occupied.length === 1);
  setsCache.set(key, sets);
  return sets;
}

function tryPlace(ctx: ContentContext, info: ObjectInfo, t: number, tag: string): boolean {
  const g = ctx.grid;
  return ctx.b.place(info.group, info.index, g.x(t), g.y(t), { tag }) !== null;
}

// --- Rivers ---

export function placeRivers(ctx: ContentContext, count: number): number {
  const b = ctx.b;
  const g = ctx.grid;
  const waterTiles: number[] = [];
  for (let t = 0; t < g.size; ++t) if (b.isWater(t)) waterTiles.push(t);
  if (waterTiles.length === 0) return 0;
  // Orthogonal distance from water over land.
  const dist = new Int32Array(g.size).fill(-1);
  const queue = [...waterTiles];
  for (const t of waterTiles) dist[t] = 0;
  for (let h = 0; h < queue.length; ++h) {
    const cur = queue[h] as number;
    for (const d of ORTHOGONAL_DIRECTIONS) {
      const n = g.neighbor(cur, d);
      if (n >= 0 && dist[n] === -1) {
        dist[n] = (dist[cur] as number) + 1;
        queue.push(n);
      }
    }
  }
  const usableForStream = (t: number) => !b.isWater(t) && b.isFree(t) && b.reserved[t] === Reserve.NONE && !containsRoad(b.tile(t));
  const sources = [];
  for (let t = 0; t < g.size; ++t) if ((dist[t] as number) >= 8 && (dist[t] as number) <= 22 && usableForStream(t) && ctx.usable(t)) sources.push(t);
  ctx.rng.shuffle(sources);

  let placed = 0;
  const streamTiles = new Set<number>();
  for (const source of sources) {
    if (placed >= count) break;
    if ([...streamTiles].some((s) => g.distance(s, source) < 6)) continue;
    const path = [source];
    let cur = source;
    while ((dist[cur] as number) > 1) {
      const next = ORTHOGONAL_DIRECTIONS.map((d) => g.neighbor(cur, d))
        .filter((n) => n >= 0 && (dist[n] as number) === (dist[cur] as number) - 1 && usableForStream(n) && !streamTiles.has(n))
        .sort((p, q) => p - q);
      if (next.length === 0) break;
      cur = ctx.rng.pick(next);
      path.push(cur);
    }
    if ((dist[cur] as number) !== 1 || path.length < 6) continue;
    for (const t of path) {
      b.roads.addStream(t);
      b.reserve(t, Reserve.KEEP_CLEAR);
      streamTiles.add(t);
    }
    ++placed;
  }
  return placed;
}

// --- Zone borders ---

// Places a single-tile obstacle tagged `keeper`: the walled-in team's seal must never be removed by the
// reachability repair. Streams and road-diagonal side tiles (KEEP_CLEAR) may carry an obstacle.
function placeKeeperObstacle(ctx: ContentContext, t: number): boolean {
  const b = ctx.b;
  const g = ctx.grid;
  const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
  const options = ctx.rng.shuffle([...sets.small, ...sets.trees.filter((o) => o.occupied.length === 1)]);
  for (const info of options) {
    if (b.place(info.group, info.index, g.x(t), g.y(t), { tag: 'keeper', allowReserved: [Reserve.KEEP_CLEAR] })) return true;
  }
  // Any single-tile landscape object regardless of its art, rather than an open border.
  for (const info of ctx.rng.shuffle([...sets.small])) {
    if (b.place(info.group, info.index, g.x(t), g.y(t), { tag: 'keeper', allowReserved: [Reserve.KEEP_CLEAR], anyTerrain: true })) return true;
  }
  return false;
}

// Fallback for a border tile that cannot take an obstacle (a road, an object entrance): block every neighboring
// tile outside the walled zones instead — one blocked tile per crossing pair is enough to seal. `avoid` lists
// tiles that must stay open (corridor lines); an avoid-neighbor that needs walling makes the seal impossible.
export function sealFromNeighbors(ctx: ContentContext, seal: SealInfo, t: number, avoid?: ReadonlySet<number>): boolean {
  const b = ctx.b;
  const g = ctx.grid;
  let sealed = true;
  for (const d of NEIGHBOR_DIRECTIONS) {
    const n = g.neighbor(t, d);
    if (n < 0 || seal.zones.has(ctx.layout.zoneOf[n] as number)) continue;
    if (seal.keeperGates.has(n) || seal.internalGates.has(n)) continue; // intended crossings stay open
    if (avoid?.has(n)) {
      sealed = false;
      continue;
    }
    if (b.isWater(n)) {
      sealed = false;
      continue;
    }
    if (!b.isFree(n)) {
      // Already walled — but only real walls seal; anything the hero can pass is an open crossing.
      const p = b.objects.get(b.occupant[n] as number);
      if (!p || (p.tag !== 'keeper' && p.tag !== 'border')) sealed = false;
      continue;
    }
    if (b.reserved[n] === Reserve.ROAD || b.reserved[n] === Reserve.ACCESS || !placeKeeperObstacle(ctx, n)) sealed = false;
  }
  return sealed;
}

export function wallZoneBorders(ctx: ContentContext): void {
  const b = ctx.b;
  const g = ctx.grid;
  const zoneOf = ctx.layout.zoneOf;
  const seal = sealInfo(ctx);
  const band: number[] = [];
  for (let t = 0; t < g.size; ++t) {
    if (b.isWater(t) || (ctx.borderDist[t] as number) > 1) continue;
    const x = g.x(t);
    const y = g.y(t);
    const onMapEdge = x === 0 || y === 0 || x === g.width - 1 || y === g.width - 1;
    let touchesOtherZone = false;
    for (const d of NEIGHBOR_DIRECTIONS) {
      const n = g.neighbor(t, d);
      if (n >= 0 && zoneOf[n] !== zoneOf[t] && !b.isWater(n)) touchesOtherZone = true;
    }
    if ((ctx.borderDist[t] as number) === 0 && !touchesOtherZone && onMapEdge) continue;
    band.push(t);
  }
  // Obstacles covering a walled-team border tile are part of the seal and must never be removed by the repair.
  // They must be single-tile and lie entirely inside the walled zones: a wall reaching over the border would
  // seal the roads and paths around the keeper gate, and one reaching inward would be an uncarvable barrier
  // between the gate and the team's castle.
  const tryPlace = (info: ObjectInfo, t: number): boolean => {
    let coversSeal = false;
    if (seal.border.size > 0) {
      for (const o of info.occupied) {
        const x = g.x(t) + o.dx;
        const y = g.y(t) + o.dy;
        if (!g.inside(x, y)) continue;
        if (!seal.border.has(g.index(x, y))) continue;
        coversSeal = true;
        break;
      }
      if (coversSeal) {
        if (info.occupied.length !== 1) return false;
        for (const o of info.occupied) {
          const x = g.x(t) + o.dx;
          const y = g.y(t) + o.dy;
          if (g.inside(x, y) && !seal.zones.has(zoneOf[g.index(x, y)] as number)) return false;
        }
        return b.place(info.group, info.index, g.x(t), g.y(t), { tag: 'keeper' }) !== null;
      }
    }
    return b.place(info.group, info.index, g.x(t), g.y(t), { tag: 'border' }) !== null;
  };
  ctx.rng.shuffle(band);
  // Big obstacles first, then single tiles to close the gaps.
  for (const t of band) {
    if (!b.isFree(t) || b.reserved[t] !== Reserve.NONE) continue;
    const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
    const options = ctx.rng.shuffle([...sets.big]);
    for (const info of options.slice(0, 8)) if (tryPlace(info, t)) break;
  }
  for (const t of band) {
    if (!b.isFree(t) || b.reserved[t] !== Reserve.NONE) continue;
    if ((ctx.borderDist[t] as number) > 0) continue;
    const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
    for (const info of ctx.rng.shuffle([...sets.small, ...sets.trees.filter((o) => o.occupied.length <= 2)]).slice(0, 10)) {
      if (tryPlace(info, t)) break;
    }
  }
  // Guaranteed seal of the walled-in team: every border tile that is still open gets an obstacle.
  for (const t of [...seal.border].sort((p, q) => p - q)) {
    if (b.isWater(t)) throw new GenerationError(`Walled team zone contains water at ${g.x(t)},${g.y(t)}`);
    if (seal.keeperGates.has(t)) continue; // the guarded crossing stays open
    if (!b.isFree(t)) continue; // already blocked by a keeper-tagged wall from the passes above
    if (seal.internalGates.has(t) || !placeKeeperObstacle(ctx, t)) {
      if (!sealFromNeighbors(ctx, seal, t)) throw new GenerationError(`Cannot seal the walled team border at ${g.x(t)},${g.y(t)}`);
    }
  }
}

// --- Interior decoration ---

export function decorateZones(ctx: ContentContext, density: number): void {
  const b = ctx.b;
  const g = ctx.grid;
  // Never decorate the walled team's seal: obstacles there are keeper-tagged, and internal gate tiles must stay open.
  const seal = sealInfo(ctx);
  const sealZones = seal.zones;
  const noBuild = noBuildTiles(seal);
  const coversNoBuild = (info: ObjectInfo, t: number) => noBuild.size > 0 && info.occupied.some((o) => noBuild.has(g.index(g.x(t) + o.dx, g.y(t) + o.dy)));
  const forest = new ValueNoise(ctx.rng.fork('forest-noise'));
  const hills = new ValueNoise(ctx.rng.fork('hill-noise'));
  for (const zone of ctx.layout.zones) {
    const land = zone.tiles.filter((t) => !b.isWater(t));
    if (land.length === 0) continue;
    // Walled zones stay more open: their content is denser and every pocket behind the seal is a liability.
    const zoneDensity = sealZones.size > 0 && sealZones.has(zone.id) ? density * 0.7 : density;
    const target = Math.round(land.length * zoneDensity);
    let blocked = land.filter((t) => !b.isFree(t)).length;
    const candidates = ctx.rng.shuffle(land.filter((t) => b.isFree(t) && b.reserved[t] === Reserve.NONE && !noBuild.has(t)));
    // Prefer tiles inside forest/mountain noise blobs so obstacles form clusters.
    const score = (t: number) => Math.max(forest.fbm(g.x(t) / 7, g.y(t) / 7, 3), hills.fbm(g.x(t) / 9, g.y(t) / 9, 3));
    candidates.sort((p, q) => score(q) - score(p) || p - q);
    for (const t of candidates) {
      if (blocked >= target) break;
      if (!b.isFree(t) || b.reserved[t] !== Reserve.NONE) continue;
      const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
      const f = forest.fbm(g.x(t) / 7, g.y(t) / 7, 3);
      const h = hills.fbm(g.x(t) / 9, g.y(t) / 9, 3);
      const pool = h > f && sets.mountains.length > 0 ? sets.mountains : sets.trees.length > 0 && ctx.rng.chance(0.75) ? sets.trees : sets.details;
      if (pool.length === 0) continue;
      for (const info of ctx.rng.shuffle([...pool]).slice(0, 6)) {
        if (!coversNoBuild(info, t) && tryPlace(ctx, info, t, 'decoration')) {
          blocked += info.occupied.length;
          break;
        }
      }
    }
    // Small details (rocks, shrubs, flowers, single trees) and a few non-blocking ground details for texture.
    const detailTarget = Math.round(land.length * 0.05);
    let details = 0;
    for (const t of ctx.rng.shuffle(land.filter((x) => b.isFree(x) && b.reserved[x] === Reserve.NONE && !noBuild.has(x)))) {
      if (details >= detailTarget) break;
      const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
      const pool = [...sets.small, ...sets.details.filter((o) => o.occupied.length <= 3)];
      if (pool.length > 0 && tryPlace(ctx, ctx.rng.pick(pool), t, 'decoration')) ++details;
    }
    const flatCount = Math.round(land.length / 120);
    for (let k = 0; k < flatCount; ++k) {
      const t = ctx.rng.pick(land);
      const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
      if (sets.flat.length === 0 || !b.isFree(t) || containsRoad(b.tile(t)) || b.tile(t).objects.length > 0) continue;
      tryPlace(ctx, ctx.rng.pick(sets.flat), t, 'decoration');
    }
  }
}

// Decorates unusable land (islands without content) and puts a few rocks into the sea.
export function decorateIslandsAndSea(ctx: ContentContext): void {
  const b = ctx.b;
  const g = ctx.grid;
  for (let t = 0; t < g.size; ++t) {
    if (b.isWater(t) || ctx.usable(t) || !b.isFree(t) || !ctx.rng.chance(0.3)) continue;
    const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
    const pool = [...sets.trees, ...sets.details];
    if (pool.length > 0) tryPlace(ctx, ctx.rng.pick(pool), t, 'decoration');
  }
  const seaRocks = findObjects({ group: ObjectGroup.LANDSCAPE_WATER, expansion: ctx.opts.expansion ? undefined : false }).filter((o) => o.occupied.length > 0);
  if (seaRocks.length === 0) return;
  for (let t = 0; t < g.size; ++t) {
    if (!b.isWater(t) || !b.isFree(t) || !ctx.rng.chance(0.004)) continue;
    // Only in open water, away from coasts, so boats are never trapped.
    if (g.around(t, 2).some((n) => !b.isWater(n) || !b.isFree(n))) continue;
    const info = ctx.rng.pick(seaRocks);
    if (fitsTerrain(info, Ground.WATER)) tryPlace(ctx, info, t, 'decoration');
  }
}

export function blockedFraction(ctx: ContentContext): number {
  let land = 0;
  let blocked = 0;
  for (let t = 0; t < ctx.grid.size; ++t) {
    if (ctx.b.isWater(t)) continue;
    ++land;
    if (!ctx.b.isFree(t)) ++blocked;
  }
  return land === 0 ? 0 : blocked / land;
}
