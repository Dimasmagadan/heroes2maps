// Landscape decoration: rivers, walls of obstacles along zone borders (left open only at the guarded gates) and
// clustered forests, mountains, rocks and small details inside zones.

import { ObjectGroup } from '../fh2m/types.ts';
import { NEIGHBOR_DIRECTIONS, ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import { findObjects, fitsTerrain, type ObjectInfo } from '../objects.ts';
import { Ground } from '../terrain/ground.ts';
import { ValueNoise } from '../terrain/noise.ts';
import { containsRoad } from '../terrain/transitions.ts';
import { Reserve } from './builder.ts';
import type { ContentContext } from './content.ts';

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

export function wallZoneBorders(ctx: ContentContext): void {
  const b = ctx.b;
  const g = ctx.grid;
  const zoneOf = ctx.layout.zoneOf;
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
  ctx.rng.shuffle(band);
  // Big obstacles first, then single tiles to close the gaps.
  for (const t of band) {
    if (!b.isFree(t) || b.reserved[t] !== Reserve.NONE) continue;
    const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
    const options = ctx.rng.shuffle([...sets.big]);
    for (const info of options.slice(0, 8)) if (tryPlace(ctx, info, t, 'border')) break;
  }
  for (const t of band) {
    if (!b.isFree(t) || b.reserved[t] !== Reserve.NONE) continue;
    if ((ctx.borderDist[t] as number) > 0) continue;
    const sets = obstacleSets(b.ground(t), ctx.opts.expansion);
    for (const info of ctx.rng.shuffle([...sets.small, ...sets.trees.filter((o) => o.occupied.length <= 2)]).slice(0, 10)) {
      if (tryPlace(ctx, info, t, 'border')) break;
    }
  }
}

// --- Interior decoration ---

export function decorateZones(ctx: ContentContext, density: number): void {
  const b = ctx.b;
  const g = ctx.grid;
  const forest = new ValueNoise(ctx.rng.fork('forest-noise'));
  const hills = new ValueNoise(ctx.rng.fork('hill-noise'));
  for (const zone of ctx.layout.zones) {
    const land = zone.tiles.filter((t) => !b.isWater(t));
    if (land.length === 0) continue;
    const target = Math.round(land.length * density);
    let blocked = land.filter((t) => !b.isFree(t)).length;
    const candidates = ctx.rng.shuffle(land.filter((t) => b.isFree(t) && b.reserved[t] === Reserve.NONE));
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
        if (tryPlace(ctx, info, t, 'decoration')) {
          blocked += info.occupied.length;
          break;
        }
      }
    }
    // Small details (rocks, shrubs, flowers, single trees) and a few non-blocking ground details for texture.
    const detailTarget = Math.round(land.length * 0.05);
    let details = 0;
    for (const t of ctx.rng.shuffle(land.filter((x) => b.isFree(x) && b.reserved[x] === Reserve.NONE))) {
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
