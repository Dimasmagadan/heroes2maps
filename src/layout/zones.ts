// Zone layout: partitions the map into player start zones, neutral zones and a center zone, and decides which
// zones are connected (through guarded gates).
//
// The macro layout comes from a template (see "Templates" in the README): ring (players on a ring around a
// center), hub (everything connects through a rich center), split (two halves joined by bridge zones), spine
// (a chain of zones from one end of the map to the other) and rings (a rich inner ring behind few gates).
// Seeds: start zones on a ring / in halves / along a line, the center zone in the middle (72+ maps), neutral
// seeds by best-candidate sampling. Tiles go to the seed with the smallest noise-perturbed weighted distance,
// giving irregular Voronoi cells. Connections: a minimum spanning tree over adjacent zones (start-start edges
// are penalized so players meet through neutral land) plus some extra edges for loops; every template reweights
// the edges to push the graph into its shape.

import { GenerationError } from '../errors.ts';
import { Grid, NEIGHBOR_DIRECTIONS, ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import { CONCRETE_TEMPLATES, playerTeams, type ConcreteTemplate, type GeneratorOptions } from '../options.ts';
import type { Rng } from '../rng.ts';
import { Ground } from '../terrain/ground.ts';
import { ValueNoise } from '../terrain/noise.ts';

export type ZoneKind = 'start' | 'neutral' | 'center';

export interface Zone {
  id: number;
  kind: ZoneKind;
  player: number; // player index (0 = human) for start zones, -1 otherwise
  seed: number; // tile index
  tiles: number[];
  ground: Ground;
  // Normalized distance of the zone seed from the nearest player start: 0 = start zone, 1 = farthest zone.
  distance: number;
  neighbors: Map<number, number>; // zone id -> shared border length
  // Template annotations (all optional).
  group?: number; // split: which half of the map the zone belongs to (0/1)
  order?: number; // spine: position along the progression chain
  tag?: 'inner'; // rings: a rich inner-ring zone
  budgetScale?: number; // multiplier on the zone's content budget (rings inner zones, split bridges, hub center)
}

export interface Connection {
  a: number;
  b: number;
  gateA: number; // border tile on zone a's side
  gateB: number; // adjacent border tile on zone b's side
  // The only way into a walled-in team (teams option): guarded by one huge monster.
  keeper?: number; // id of the walled-in zone
}

// Zone ids of the walled-in team (teams option): the start zones of team 3.
export function walledZoneIds(zones: readonly Zone[], teams: readonly number[] | null): Set<number> {
  const ids = new Set<number>();
  if (teams) for (const z of zones) if (z.kind === 'start' && teams[z.player] === 3) ids.add(z.id);
  return ids;
}

// Tiles of the walled zones that touch the rest of the map (orthogonally or diagonally; water tiles belong to
// other zones). Nothing enterable may remain here except the keeper gates, or a hero can slip in without
// fighting the keeper — including over a diagonal corner, so the border is defined by 8-adjacency.
export function walledBorderTiles(grid: Grid, zoneOf: Int16Array, zones: readonly Zone[], walled: Set<number>): Set<number> {
  const tiles = new Set<number>();
  if (walled.size === 0) return tiles;
  for (const id of walled) {
    for (const t of (zones[id] as Zone).tiles) {
      for (const d of NEIGHBOR_DIRECTIONS) {
        const n = grid.neighbor(t, d);
        if (n >= 0 && !walled.has(zoneOf[n] as number)) {
          tiles.add(t);
          break;
        }
      }
    }
  }
  return tiles;
}

export interface Layout {
  grid: Grid;
  zoneOf: Int16Array;
  zones: Zone[];
  connections: Connection[];
  // The template this layout was built with ('random' resolved by the seed).
  template: ConcreteTemplate;
  // split: zones whose land stays dry across the barrier and may connect the two halves.
  bridges: ReadonlySet<number>;
  // split: the barrier axis through the map center (x = W/2 if true, y = W/2 if false).
  splitVertical: boolean;
}

const TILES_PER_ZONE: Record<number, number> = { 36: 300, 72: 520, 108: 640, 144: 760 };

const START_GROUNDS: readonly Ground[] = [Ground.GRASS, Ground.DIRT, Ground.SNOW, Ground.LAVA, Ground.WASTELAND, Ground.SWAMP, Ground.DESERT];
const NEUTRAL_GROUNDS: readonly Ground[] = [Ground.GRASS, Ground.DIRT, Ground.SNOW, Ground.LAVA, Ground.WASTELAND, Ground.SWAMP, Ground.DESERT, Ground.BEACH];
const WASTELAND_GROUNDS: readonly Ground[] = [Ground.WASTELAND, Ground.LAVA, Ground.DIRT, Ground.DESERT];

export function zoneCount(opts: GeneratorOptions): number {
  const landShare = { none: 1, low: 0.92, medium: 0.8, high: 0.68 }[opts.water];
  const land = opts.size * opts.size * landShare;
  const perZone = TILES_PER_ZONE[opts.size] ?? 600;
  return Math.max(opts.players + 1, Math.round(land / perZone));
}

// Bigger maps have more zones; templates add or remove a few.
function ringsInnerCount(opts: GeneratorOptions): number {
  const byPlayers = Math.max(2, opts.players - 1);
  // Small maps cannot afford the extra zones: one central vault instead of a ring.
  return opts.size === 36 ? Math.max(1, Math.min(2, byPlayers)) : Math.min(4, byPlayers);
}

function templateZoneCount(template: ConcreteTemplate, opts: GeneratorOptions): number {
  const base = zoneCount(opts);
  switch (template) {
    case 'rings':
      return Math.max(opts.players + ringsInnerCount(opts), base);
    case 'spine':
      // At least one non-start zone: scenario objects (the crypt) need neutral land.
      return Math.max(opts.players + 1, Math.round(base * 0.85));
    default:
      return base;
  }
}

interface Seed {
  x: number;
  y: number;
  kind: ZoneKind;
  player: number;
  tag?: 'inner';
  order?: number;
  group?: number;
}

function clampCoord(v: number, W: number, margin: number): number {
  return Math.min(W - 1 - margin, Math.max(margin, v));
}

// Neutral seeds by best-candidate sampling: the accepted sample farthest from all existing seeds. With
// `minCenterDist` > 0 (hub) samples near the map center are rejected, so start zones keep their border with
// the center zone; if nothing is accepted (tiny maps), the constraint is dropped.
function fillNeutralSeeds(seeds: Seed[], total: number, W: number, cx: number, cy: number, margin: number, rng: Rng, minCenterDist: number): void {
  let skipRadius = false;
  while (seeds.length < total) {
    let best: { x: number; y: number } | null = null;
    let bestDist = -1;
    for (let k = 0; k < 40; ++k) {
      const x = rng.range(margin - 2, W - 1 - margin + 2);
      const y = rng.range(margin - 2, W - 1 - margin + 2);
      if (!skipRadius && minCenterDist > 0 && Math.hypot(x - cx, y - cy) < minCenterDist) continue;
      let d = Infinity;
      for (const s of seeds) d = Math.min(d, Math.hypot(s.x - x, s.y - y));
      if (d > bestDist) {
        bestDist = d;
        best = { x, y };
      }
    }
    if (!best) {
      if (!skipRadius && minCenterDist > 0) {
        skipRadius = true;
        continue;
      }
      break;
    }
    seeds.push({ ...best, kind: 'neutral', player: -1 });
  }
}

export function generateLayout(opts: GeneratorOptions, rng: Rng): Layout {
  const W = opts.size;
  const grid = new Grid(W);
  const cx = (W - 1) / 2;
  const cy = (W - 1) / 2;
  const template = opts.template === 'random' ? (rng.pick(CONCRETE_TEMPLATES) as ConcreteTemplate) : opts.template;
  const total = templateZoneCount(template, opts);
  const margin = Math.max(4, Math.round(W * 0.1));
  let splitVertical = true;

  // --- Seeds ---
  const seeds: Seed[] = [];
  if (template === 'ring' || template === 'hub') {
    // Players on a ring around the center. The hub pushes them slightly outward and keeps neutral seeds
    // outside the ring, so every start zone borders the center zone.
    const ringRadius = W * (opts.players === 2 ? 0.36 : template === 'hub' ? 0.38 : 0.34);
    const angle0 = rng.next() * Math.PI * 2;
    for (let p = 0; p < opts.players; ++p) {
      const a = angle0 + (p * Math.PI * 2) / opts.players + (rng.next() - 0.5) * 0.35;
      const r = ringRadius * (0.92 + rng.next() * 0.16);
      seeds.push({ x: Math.round(clampCoord(cx + Math.cos(a) * r, W, margin)), y: Math.round(clampCoord(cy + Math.sin(a) * r, W, margin)), kind: 'start', player: p });
    }
    if (template === 'hub' || (W >= 72 && total > opts.players)) {
      seeds.push({ x: Math.round(cx + (rng.next() - 0.5) * 4), y: Math.round(cy + (rng.next() - 0.5) * 4), kind: 'center', player: -1 });
    }
    fillNeutralSeeds(seeds, total, W, cx, cy, margin, rng, template === 'hub' ? W * 0.42 : 0);
  } else if (template === 'split') {
    // Two halves; even players west/north, odd players east/south. The middle of the map is a barrier
    // (water in landscape.ts) crossed on dry bridge zones chosen after the zones are built.
    splitVertical = rng.chance(0.5);
    const axisLow = Math.round(cx - W * 0.16);
    const axisHigh = Math.round(cx + W * 0.16);
    const groups: number[][] = [[], []];
    for (let p = 0; p < opts.players; ++p) (groups[p % 2] as number[]).push(p);
    for (const g of [0, 1] as const) {
      const members = groups[g] as number[];
      if (members.length === 0) continue;
      members.forEach((p, k) => {
        const t = (k + 0.5) / members.length + (rng.next() - 0.5) * 0.25 / members.length;
        const along = margin + 2 + (W - 2 * margin - 4) * t;
        const across = g === 0 ? rng.range(margin + 1, axisLow) : rng.range(axisHigh, W - 1 - margin);
        const x = splitVertical ? across : along;
        const y = splitVertical ? along : across;
        seeds.push({ x: Math.round(clampCoord(x, W, margin)), y: Math.round(clampCoord(y, W, margin)), kind: 'start', player: p });
      });
    }
    fillNeutralSeeds(seeds, total, W, cx, cy, margin, rng, 0);
    const half = (W - 1) / 2;
    for (const s of seeds) s.group = (splitVertical ? s.x : s.y) <= half ? 0 : 1;
  } else if (template === 'spine') {
    // A chain of zones across the map; starts sit on evenly spaced chain positions, both ends included.
    const vertical = rng.chance(0.5);
    const flip = rng.chance(0.5);
    for (let i = 0; i < total; ++i) {
      const t = (i + 0.5) / total;
      const a = Math.round(W * (0.08 + 0.84 * t));
      const perp = Math.round(W * (0.5 + (rng.next() - 0.5) * 0.22));
      const along = flip ? W - 1 - a : a;
      seeds.push({ x: Math.round(clampCoord(vertical ? perp : along, W, margin)), y: Math.round(clampCoord(vertical ? along : perp, W, margin)), kind: 'neutral', player: -1, order: i });
    }
    for (let p = 0; p < opts.players; ++p) {
      const s = seeds[Math.round((p * (total - 1)) / (opts.players - 1))] as Seed;
      s.kind = 'start';
      s.player = p;
    }
  } else {
    // rings: starts on an outer ring, a rich inner ring of neutral zones around the middle, no center zone.
    const ringRadius = W * (opts.players === 2 ? 0.42 : 0.4);
    const angle0 = rng.next() * Math.PI * 2;
    for (let p = 0; p < opts.players; ++p) {
      const a = angle0 + (p * Math.PI * 2) / opts.players + (rng.next() - 0.5) * 0.35;
      const r = ringRadius * (0.92 + rng.next() * 0.16);
      seeds.push({ x: Math.round(clampCoord(cx + Math.cos(a) * r, W, margin)), y: Math.round(clampCoord(cy + Math.sin(a) * r, W, margin)), kind: 'start', player: p });
    }
    const innerCount = ringsInnerCount(opts);
    const innerAngle0 = rng.next() * Math.PI * 2;
    for (let k = 0; k < innerCount; ++k) {
      const a = innerAngle0 + (k * Math.PI * 2) / innerCount + (rng.next() - 0.5) * 0.5;
      const r = W * 0.16 * (0.85 + rng.next() * 0.3);
      seeds.push({ x: Math.round(clampCoord(cx + Math.cos(a) * r, W, margin)), y: Math.round(clampCoord(cy + Math.sin(a) * r, W, margin)), kind: 'neutral', player: -1, tag: 'inner' });
    }
    fillNeutralSeeds(seeds, total, W, cx, cy, margin, rng, 0);
  }

  // --- Tile assignment ---
  const noise = new ValueNoise(rng.fork('zone-noise'));
  const amp = W * 0.07;
  const teams = playerTeams(opts);
  // The walled-in team gets bigger zones; inner-ring zones claim more space so they stay adjacent to each other.
  const weight = (s: { kind: ZoneKind; player: number; tag?: 'inner' }) =>
    s.kind === 'start' ? (opts.teams && teams[s.player] === 3 ? 0.85 : 0.93) : s.tag === 'inner' ? 0.9 : s.kind === 'center' ? 0.97 : 1;
  const zoneOf = new Int16Array(grid.size);
  for (let t = 0; t < grid.size; ++t) {
    const x = grid.x(t);
    const y = grid.y(t);
    const nx = (noise.fbm(x / 9, y / 9, 3) - 0.5) * amp;
    const ny = (noise.fbm(x / 9 + 50, y / 9 + 50, 3) - 0.5) * amp;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < seeds.length; ++i) {
      const s = seeds[i] as (typeof seeds)[number];
      const d = Math.hypot(x + nx - s.x, y + ny - s.y) * weight(s);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    zoneOf[t] = best;
  }

  // Seeds always belong to their zone.
  seeds.forEach((s, i) => (zoneOf[grid.index(s.x, s.y)] = i));
  fixZoneConnectivity(grid, zoneOf, seeds.map((s) => grid.index(s.x, s.y)));

  // --- Zones ---
  const zones: Zone[] = seeds.map((s, i) => ({
    id: i,
    kind: s.kind,
    player: s.player,
    seed: grid.index(s.x, s.y),
    tiles: [],
    ground: Ground.GRASS,
    distance: 0,
    neighbors: new Map(),
    ...(s.tag !== undefined ? { tag: s.tag } : {}),
    ...(s.order !== undefined ? { order: s.order } : {}),
    ...(s.group !== undefined ? { group: s.group } : {}),
  }));
  for (let t = 0; t < grid.size; ++t) (zones[zoneOf[t] as number] as Zone).tiles.push(t);
  for (let t = 0; t < grid.size; ++t) {
    const z = zoneOf[t] as number;
    for (const d of ORTHOGONAL_DIRECTIONS) {
      const n = grid.neighbor(t, d);
      if (n < 0) continue;
      const o = zoneOf[n] as number;
      if (o !== z) {
        const zone = zones[z] as Zone;
        zone.neighbors.set(o, (zone.neighbors.get(o) ?? 0) + 1);
      }
    }
  }

  // Distance from the nearest start, normalized.
  const startSeeds = zones.filter((z) => z.kind === 'start').map((z) => z.seed);
  let maxD = 1;
  for (const z of zones) {
    z.distance = Math.min(...startSeeds.map((s) => grid.euclid(s, z.seed)));
    maxD = Math.max(maxD, z.distance);
  }
  for (const z of zones) z.distance = z.kind === 'start' ? 0 : Math.min(1, z.distance / maxD);

  // --- Template annotations ---
  const bridges = new Set<number>();
  if (template === 'hub') {
    for (const z of zones) if (z.kind === 'center') z.budgetScale = 1.6;
  } else if (template === 'rings') {
    for (const z of zones) if (z.tag === 'inner') z.budgetScale = 1.8;
  } else if (template === 'split') {
    for (const id of chooseBridges(grid, zoneOf, zones, splitVertical)) {
      bridges.add(id);
      (zones[id] as Zone).budgetScale = 1.5;
    }
  }

  assignGrounds(zones, opts, rng.fork('zone-grounds'));
  const connections = connectZones(grid, zoneOf, zones, rng.fork('connections'), opts.teams ? teams : null, template, bridges);
  return { grid, zoneOf, zones, connections, template, bridges, splitVertical };
}

// split: neutral zones with tiles on the barrier axis whose neighbors include both halves. Up to two of them,
// on opposite parts of the axis, become bridges: their land stays dry across the barrier (see the water
// barrier in landscape.ts) and only they may connect the two halves. Empty set = no zone straddles the axis;
// the connection policy then only prefers intra-half edges instead of requiring bridges.
function chooseBridges(grid: Grid, zoneOf: Int16Array, zones: Zone[], vertical: boolean): Set<number> {
  const bridges = new Set<number>();
  const half = (grid.width - 1) / 2;
  const stats = new Map<number, { tiles: number; sum: number }>();
  for (let t = 0; t < grid.size; ++t) {
    const d = vertical ? Math.abs(grid.x(t) - half) : Math.abs(grid.y(t) - half);
    if (d > 2) continue;
    const id = zoneOf[t] as number;
    if ((zones[id] as Zone).kind === 'start') continue;
    const s = stats.get(id) ?? { tiles: 0, sum: 0 };
    s.tiles += 1;
    s.sum += vertical ? grid.y(t) : grid.x(t);
    stats.set(id, s);
  }
  const candidates: { zone: Zone; tiles: number; along: number }[] = [];
  for (const [id, s] of stats) {
    const zone = zones[id] as Zone;
    const groups = new Set([...zone.neighbors.keys()].map((n) => (zones[n] as Zone).group));
    if (groups.has(0) && groups.has(1)) candidates.push({ zone, tiles: s.tiles, along: s.sum / s.tiles });
  }
  // One bridge from each half of the axis, the strongest straddler first.
  for (const [lo, hi] of [[0, 0.5], [0.5, 1.1]] as const) {
    const pool = candidates.filter((c) => !bridges.has(c.zone.id) && c.along >= grid.width * lo && c.along < grid.width * hi);
    const best = pool.reduce<typeof pool[number] | null>((b, c) => (b === null || c.tiles > b.tiles ? c : b), null);
    if (best) bridges.add(best.zone.id);
  }
  return bridges;
}

// Keeps only the 4-connected part of each zone that contains its seed; other tiles join a neighboring zone.
function fixZoneConnectivity(grid: Grid, zoneOf: Int16Array, seeds: readonly number[]): void {
  for (let iteration = 0; iteration < 8; ++iteration) {
    const keep = new Uint8Array(grid.size);
    seeds.forEach((seed, z) => {
      const queue = [seed];
      keep[seed] = 1;
      for (let h = 0; h < queue.length; ++h) {
        const cur = queue[h] as number;
        for (const d of ORTHOGONAL_DIRECTIONS) {
          const n = grid.neighbor(cur, d);
          if (n >= 0 && !keep[n] && zoneOf[n] === z) {
            keep[n] = 1;
            queue.push(n);
          }
        }
      }
    });
    let changed = false;
    for (let t = 0; t < grid.size; ++t) {
      if (keep[t]) continue;
      // Join the most common kept neighbor zone.
      const counts = new Map<number, number>();
      for (const d of ORTHOGONAL_DIRECTIONS) {
        const n = grid.neighbor(t, d);
        if (n >= 0 && keep[n]) counts.set(zoneOf[n] as number, (counts.get(zoneOf[n] as number) ?? 0) + 1);
      }
      let best = -1;
      let bestCount = 0;
      for (const [z, c] of counts) {
        if (c > bestCount || (c === bestCount && z < best)) {
          best = z;
          bestCount = c;
        }
      }
      if (best >= 0 && best !== zoneOf[t]) {
        zoneOf[t] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

// Necromancer maps follow the hand-made maps (Apocalypse, Eruption): one blighted ground covers most of the map in
// big connected regions, a few contrasting realms stand out against it. Adjacent zones may share a ground, so the
// borders between them are only marked by walls.
function assignNecromancerGrounds(zones: Zone[], rng: Rng): void {
  const blight = rng.pick([Ground.DIRT, Ground.LAVA]);
  const accents = rng.shuffle([Ground.SNOW, Ground.SWAMP, Ground.GRASS, Ground.DESERT]);
  const startPool = rng.shuffle([...START_GROUNDS]);
  let k = 0;
  for (const z of zones) {
    if (z.kind === 'start') {
      z.ground = z.player === 0 ? Ground.WASTELAND : (startPool[k++ % startPool.length] as Ground);
    } else if (z.kind === 'center') {
      z.ground = blight;
    } else {
      const roll = rng.next();
      z.ground = roll < 0.5 ? blight : roll < 0.75 ? Ground.WASTELAND : (accents[z.id % 2] as Ground);
    }
  }
}

function assignGrounds(zones: Zone[], opts: GeneratorOptions, rng: Rng): void {
  if (opts.race === 'necromancer' && opts.preset !== 'wasteland') {
    assignNecromancerGrounds(zones, rng);
    return;
  }
  const startPool = rng.shuffle([...(opts.preset === 'wasteland' ? WASTELAND_GROUNDS : START_GROUNDS)]);
  let k = 0;
  for (const z of zones) {
    if (z.kind === 'start') {
      z.ground = startPool[k++ % startPool.length] as Ground;
      // A necromancer's home ground is wasteland.
      if (z.player === 0 && opts.race === 'necromancer') z.ground = Ground.WASTELAND;
    } else if (z.kind === 'center') {
      z.ground = rng.pick(opts.preset === 'wasteland' ? WASTELAND_GROUNDS : [Ground.LAVA, Ground.WASTELAND, Ground.DIRT, Ground.DESERT]);
    } else {
      z.ground = rng.pick(opts.preset === 'wasteland' ? WASTELAND_GROUNDS : NEUTRAL_GROUNDS);
    }
  }
  // Avoid two adjacent zones with the same ground: borders look better with a transition.
  for (const z of zones) {
    if (z.kind === 'start') continue;
    const used = new Set([...z.neighbors.keys()].map((n) => (zones[n] as Zone).ground));
    if (used.has(z.ground)) {
      const options = (opts.preset === 'wasteland' ? WASTELAND_GROUNDS : NEUTRAL_GROUNDS).filter((g) => !used.has(g));
      if (options.length > 0) z.ground = rng.pick(options);
    }
  }
}

function connectZones(grid: Grid, zoneOf: Int16Array, zones: Zone[], rng: Rng, teams: readonly number[] | null, template: ConcreteTemplate, bridges: ReadonlySet<number>): Connection[] {
  // The walled-in team (3) is reachable through exactly one connection per group of adjacent team zones.
  const walled = (z: Zone) => teams !== null && z.kind === 'start' && teams[z.player] === 3;
  // Sealed interior of the walled group: tiles the border wall will not cover. The keeper gate must open into
  // this interior, or the wall closes around the gate and the team's zones stay unreachable behind it.
  let opensInside: ((t: number) => boolean) | null = null;
  if (teams !== null) {
    const walledIds = new Set(zones.filter((z) => walled(z)).map((z) => z.id));
    if (walledIds.size > 0) {
      const ring = walledBorderTiles(grid, zoneOf, zones, walledIds);
      const seedTiles = zones.filter((z) => walled(z)).map((z) => z.seed);
      const comp = new Int32Array(grid.size).fill(-1);
      let comps = 0;
      for (const s of seedTiles) {
        if ((comp[s] as number) >= 0) continue;
        const queue = [s];
        comp[s] = comps;
        for (let h = 0; h < queue.length; ++h) {
          const cur = queue[h] as number;
          for (const d of NEIGHBOR_DIRECTIONS) {
            const n = grid.neighbor(cur, d);
            if (n < 0 || (comp[n] as number) >= 0 || !walledIds.has(zoneOf[n] as number)) continue;
            if (ring.has(n) && !seedTiles.includes(n)) continue;
            comp[n] = comps;
            queue.push(n);
          }
        }
        ++comps;
      }
      const allIn = seedTiles.every((s) => comp[s] === comp[seedTiles[0] as number]) ? (comp[seedTiles[0] as number] as number) : null;
      const interior = new Set<number>();
      if (allIn !== null) for (let t = 0; t < grid.size; ++t) if (comp[t] === allIn) interior.add(t);
      // The gate must have an orthogonally adjacent open tile inside: a diagonal step into the gate is blocked
      // by fheroes2's diagonal rule as soon as the wall stands beside it, and the team could not walk out.
      opensInside = (t: number) => ORTHOGONAL_DIRECTIONS.some((d) => interior.has(grid.neighbor(t, d) as number));
    }
  }
  interface Edge {
    a: number;
    b: number;
    w: number;
  }
  const edges: Edge[] = [];
  for (const z of zones) {
    for (const [n, border] of z.neighbors) {
      if (n <= z.id || border < 3) continue;
      const other = zones[n] as Zone;
      let w = grid.euclid(z.seed, other.seed) * (0.85 + rng.next() * 0.3);
      if (z.kind === 'start' && other.kind === 'start') w *= 2.5;
      w *= edgeWeightMultiplier(template, bridges, z, other);
      edges.push({ a: z.id, b: n, w });
    }
  }
  edges.sort((e, f) => e.w - f.w);

  const parent = zones.map((z) => z.id);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i] as number] as number;
    return i;
  };
  const chosen: Edge[] = [];
  const rest: Edge[] = [];
  const keepers = new Map<Edge, number>();
  if (teams) {
    // Group the walled-in zones that touch each other (own union-find), connect each group inside, then give it
    // a single way out.
    const group = zones.map((z) => z.id);
    const groupOf = (i: number): number => {
      while (group[i] !== i) i = group[i] = group[group[i] as number] as number;
      return i;
    };
    for (const e of edges) {
      if (walled(zones[e.a] as Zone) && walled(zones[e.b] as Zone) && groupOf(e.a) !== groupOf(e.b)) {
        group[groupOf(e.a)] = groupOf(e.b);
        parent[find(e.a)] = find(e.b);
        chosen.push(e);
      }
    }
    const inside = (e: Edge) => (walled(zones[e.a] as Zone) ? e.a : e.b);
    const done = new Set<number>();
    for (const z of zones.filter(walled)) {
      const root = groupOf(z.id);
      if (done.has(root)) continue;
      // Shortest edge from the group to a neutral or center zone (any other zone if there is none), preferring
      // edges whose gate can open into the sealed interior of the group.
      const out = edges.filter((e) => walled(zones[e.a] as Zone) !== walled(zones[e.b] as Zone) && groupOf(inside(e)) === root);
      const opens = (e: Edge) => {
        if (opensInside === null) return true;
        const walledSide = inside(e);
        const gate = pickGate(grid, zoneOf, zones[e.a] as Zone, zones[e.b] as Zone, null, (pair) => opensInside(zoneOf[pair[0]] === walledSide ? pair[0] : pair[1]));
        return gate !== null && opensInside(zoneOf[gate[0]] === walledSide ? gate[0] : gate[1]);
      };
      const best =
        out.find((e) => opens(e) && (zones[inside(e) === e.a ? e.b : e.a] as Zone).kind !== 'start') ??
        out.find((e) => opens(e)) ??
        out.find((e) => (zones[inside(e) === e.a ? e.b : e.a] as Zone).kind !== 'start') ??
        out[0];
      if (!best) throw new GenerationError(`Walled team zone ${z.id} (player ${z.player}) has no connection to the rest of the map`);
      done.add(root);
      parent[find(best.a)] = find(best.b);
      chosen.push(best);
      keepers.set(best, inside(best));
    }
  }
  for (const e of edges) {
    if (chosen.includes(e)) continue;
    if (teams && (walled(zones[e.a] as Zone) || walled(zones[e.b] as Zone))) {
      rest.push(e);
      continue;
    }
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) {
      parent[ra] = rb;
      chosen.push(e);
    } else {
      rest.push(e);
    }
  }
  // Extra loops, avoiding direct start-to-start shortcuts and honoring the template's shape.
  for (const e of rest) {
    const both = (zones[e.a] as Zone).kind === 'start' && (zones[e.b] as Zone).kind === 'start';
    if (teams && (walled(zones[e.a] as Zone) || walled(zones[e.b] as Zone))) continue;
    if (!both && rng.chance(loopChance(template, bridges, zones[e.a] as Zone, zones[e.b] as Zone))) chosen.push(e);
  }

  const connections: Connection[] = [];
  for (const e of chosen) {
    const keeperOf = keepers.get(e);
    const bothWalled = teams !== null && walled(zones[e.a] as Zone) && walled(zones[e.b] as Zone);
    // Gates between two walled zones must stay open for the team itself while the seal closes everything around
    // them, so they may not touch the rest of the map; keeper gates and internal gates must open into the
    // sealed interior, or the wall closes around the gate and the team is unreachable behind it.
    const awayFrom = bothWalled ? new Set(zones.filter((z) => !walled(z)).map((z) => z.id)) : null;
    const prefer =
      opensInside === null || (!bothWalled && keeperOf === undefined)
        ? null
        : (pair: [number, number]) => (bothWalled ? opensInside(pair[0]) && opensInside(pair[1]) : opensInside(zoneOf[pair[0]] === keeperOf ? pair[0] : pair[1]));
    const gate = pickGate(grid, zoneOf, zones[e.a] as Zone, zones[e.b] as Zone, awayFrom, prefer);
    if (gate) connections.push({ a: e.a, b: e.b, gateA: gate[0], gateB: gate[1], ...(keeperOf !== undefined ? { keeper: keeperOf } : {}) });
  }
  return connections;
}

// Multiplier on the base edge weight; the MST and the loop picks see the shaped graph through it.
//   hub:    everything through the center zone (other edges are expensive),
//   split:  halves meet only at bridge zones,
//   spine:  the chain in order, skips of one and rare shortcuts,
//   rings:  inner-ring zones connect to each other; every gate into the inner ring is expensive.
function edgeWeightMultiplier(template: ConcreteTemplate, bridges: ReadonlySet<number>, a: Zone, b: Zone): number {
  switch (template) {
    case 'hub':
      return a.kind === 'center' || b.kind === 'center' ? 1 : 6;
    case 'split':
      return a.group !== b.group && !bridges.has(a.id) && !bridges.has(b.id) ? 8 : 1;
    case 'spine': {
      const d = Math.abs((a.order ?? 0) - (b.order ?? 0));
      return d <= 1 ? 1 : d === 2 ? 2.2 : 10;
    }
    case 'rings':
      return (a.tag === 'inner') !== (b.tag === 'inner') ? 6 : 1;
    default:
      return 1;
  }
}

function loopChance(template: ConcreteTemplate, bridges: ReadonlySet<number>, a: Zone, b: Zone): number {
  switch (template) {
    case 'hub':
      return a.kind === 'center' || b.kind === 'center' ? 0.35 : 0.12;
    case 'split':
      return a.group !== b.group && !bridges.has(a.id) && !bridges.has(b.id) ? 0 : 0.3;
    case 'spine':
      return Math.abs((a.order ?? 0) - (b.order ?? 0)) <= 2 ? 0.3 : 0;
    case 'rings':
      // The spanning tree needs one gate per inner component; extra gates into the vault are rare.
      return (a.tag === 'inner') !== (b.tag === 'inner') ? 0.04 : 0.35;
    default:
      return 0.35;
  }
}

// Border tile pair (a side, b side) closest to the middle of the two seeds, away from the map edge. With
// `awayFrom`, pairs with an 8-adjacent tile of one of those zones are only used as a last resort. `prefer`
// pairs (e.g. gates that open into the walled group's interior) win over all others.
function pickGate(grid: Grid, zoneOf: Int16Array, a: Zone, b: Zone, awayFrom: Set<number> | null = null, prefer: ((pair: [number, number]) => boolean) | null = null): [number, number] | null {
  const mx = (grid.x(a.seed) + grid.x(b.seed)) / 2;
  const my = (grid.y(a.seed) + grid.y(b.seed)) / 2;
  let best: [number, number] | null = null;
  let bestScore = Infinity;
  let bestRank = Infinity;
  let fallback: [number, number] | null = null;
  let fallbackScore = Infinity;
  for (const t of a.tiles) {
    const x = grid.x(t);
    const y = grid.y(t);
    if (x < 3 || y < 3 || x > grid.width - 4 || y > grid.width - 4) continue;
    for (const d of ORTHOGONAL_DIRECTIONS) {
      const n = grid.neighbor(t, d);
      if (n < 0 || zoneOf[n] !== b.id) continue;
      const score = Math.hypot(x - mx, y - my);
      const away = awayFrom !== null && grid.around(t).some((s) => awayFrom.has(zoneOf[s] as number)) && grid.around(n).some((s) => awayFrom.has(zoneOf[s] as number));
      const rank = (prefer !== null && prefer([t, n]) ? 0 : 1) * 2 + (away ? 1 : 0);
      if (rank < bestRank || (rank === bestRank && score < bestScore)) {
        bestRank = rank;
        bestScore = score;
        best = [t, n];
      }
      if (score < fallbackScore) {
        fallbackScore = score;
        fallback = [t, n];
      }
    }
  }
  return best ?? fallback;
}
