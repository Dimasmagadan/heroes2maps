// Zone layout: partitions the map into player start zones, neutral zones and a center zone, and decides which
// zones are connected (through guarded gates).
//
// Seeds: start zones on a ring around the map center, the center zone in the middle (72+ maps), neutral seeds by
// best-candidate sampling. Tiles go to the seed with the smallest noise-perturbed weighted distance, giving
// irregular Voronoi cells. Connections: a minimum spanning tree over adjacent zones (start-start edges are
// penalized so players meet through neutral land) plus some extra edges for loops.

import { Grid, ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import type { GeneratorOptions } from '../options.ts';
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
}

export interface Connection {
  a: number;
  b: number;
  gateA: number; // border tile on zone a's side
  gateB: number; // adjacent border tile on zone b's side
}

export interface Layout {
  grid: Grid;
  zoneOf: Int16Array;
  zones: Zone[];
  connections: Connection[];
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

export function generateLayout(opts: GeneratorOptions, rng: Rng): Layout {
  const W = opts.size;
  const grid = new Grid(W);
  const cx = (W - 1) / 2;
  const cy = (W - 1) / 2;
  const total = zoneCount(opts);

  // --- Seeds ---
  const seeds: { x: number; y: number; kind: ZoneKind; player: number }[] = [];
  const margin = Math.max(4, Math.round(W * 0.1));
  const ringRadius = W * (opts.players === 2 ? 0.36 : 0.34);
  const angle0 = rng.next() * Math.PI * 2;
  for (let p = 0; p < opts.players; ++p) {
    const a = angle0 + (p * Math.PI * 2) / opts.players + (rng.next() - 0.5) * 0.35;
    const r = ringRadius * (0.92 + rng.next() * 0.16);
    const x = Math.round(Math.min(W - 1 - margin, Math.max(margin, cx + Math.cos(a) * r)));
    const y = Math.round(Math.min(W - 1 - margin, Math.max(margin, cy + Math.sin(a) * r)));
    seeds.push({ x, y, kind: 'start', player: p });
  }
  if (W >= 72 && total > opts.players) {
    seeds.push({ x: Math.round(cx + (rng.next() - 0.5) * 4), y: Math.round(cy + (rng.next() - 0.5) * 4), kind: 'center', player: -1 });
  }
  while (seeds.length < total) {
    // Best candidate: the sample farthest from all existing seeds.
    let best: { x: number; y: number } | null = null;
    let bestDist = -1;
    for (let k = 0; k < 40; ++k) {
      const x = rng.range(margin - 2, W - 1 - margin + 2);
      const y = rng.range(margin - 2, W - 1 - margin + 2);
      let d = Infinity;
      for (const s of seeds) d = Math.min(d, Math.hypot(s.x - x, s.y - y));
      if (d > bestDist) {
        bestDist = d;
        best = { x, y };
      }
    }
    if (!best) break;
    seeds.push({ ...best, kind: 'neutral', player: -1 });
  }

  // --- Tile assignment ---
  const noise = new ValueNoise(rng.fork('zone-noise'));
  const amp = W * 0.07;
  const weight = (kind: ZoneKind) => (kind === 'start' ? 0.93 : kind === 'center' ? 0.97 : 1);
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
      const d = Math.hypot(x + nx - s.x, y + ny - s.y) * weight(s.kind);
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

  assignGrounds(zones, opts, rng.fork('zone-grounds'));
  const connections = connectZones(grid, zoneOf, zones, rng.fork('connections'));
  return { grid, zoneOf, zones, connections };
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

function assignGrounds(zones: Zone[], opts: GeneratorOptions, rng: Rng): void {
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

function connectZones(grid: Grid, zoneOf: Int16Array, zones: Zone[], rng: Rng): Connection[] {
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
  for (const e of edges) {
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) {
      parent[ra] = rb;
      chosen.push(e);
    } else {
      rest.push(e);
    }
  }
  // Extra loops, avoiding direct start-to-start shortcuts.
  for (const e of rest) {
    const both = (zones[e.a] as Zone).kind === 'start' && (zones[e.b] as Zone).kind === 'start';
    if (!both && rng.chance(0.35)) chosen.push(e);
  }

  const connections: Connection[] = [];
  for (const e of chosen) {
    const gate = pickGate(grid, zoneOf, zones[e.a] as Zone, zones[e.b] as Zone);
    if (gate) connections.push({ a: e.a, b: e.b, gateA: gate[0], gateB: gate[1] });
  }
  return connections;
}

// Border tile pair (a side, b side) closest to the middle of the two seeds, away from the map edge.
function pickGate(grid: Grid, zoneOf: Int16Array, a: Zone, b: Zone): [number, number] | null {
  const mx = (grid.x(a.seed) + grid.x(b.seed)) / 2;
  const my = (grid.y(a.seed) + grid.y(b.seed)) / 2;
  let best: [number, number] | null = null;
  let bestScore = Infinity;
  for (const t of a.tiles) {
    const x = grid.x(t);
    const y = grid.y(t);
    if (x < 3 || y < 3 || x > grid.width - 4 || y > grid.width - 4) continue;
    for (const d of ORTHOGONAL_DIRECTIONS) {
      const n = grid.neighbor(t, d);
      if (n < 0 || zoneOf[n] !== b.id) continue;
      const score = Math.hypot(x - mx, y - my);
      if (score < bestScore) {
        bestScore = score;
        best = [t, n];
      }
    }
  }
  return best;
}
