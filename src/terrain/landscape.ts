// Landscape generation: ground type per tile (water, biomes, beaches) from the zone layout.
//
//   1. Corridors: a noisy shortest path seed -> gate -> gate -> seed for every connection, plus the area around
//      start seeds, are protected from water so every zone stays reachable over land (except the islands preset,
//      where zones are separate islands linked by boats).
//   2. Water: the highest-scoring unprotected tiles of a noise field (seas near the map edge for "continent",
//      inland lakes for "lakes", sea between zones for "islands").
//   3. Biomes: each zone's ground with noise patches of a secondary ground, beaches along coasts, then smoothing so
//      that tiles have enough same-ground neighbors for clean transitions.

import { Grid, NEIGHBOR_DIRECTIONS, ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import type { Layout, Zone } from '../layout/zones.ts';
import type { GeneratorOptions } from '../options.ts';
import type { Rng } from '../rng.ts';
import { Ground } from './ground.ts';
import { ValueNoise } from './noise.ts';

export interface Landscape {
  ground: Ground[];
  // Tiles that must stay open land: corridors between zones and start areas.
  protectedLand: Uint8Array;
  // Corridor center lines per connection (same order as layout.connections).
  corridors: number[][];
}

const WATER_FRACTION = { none: 0, low: 0.07, medium: 0.16, high: 0.27 } as const;

const SECONDARY: Record<number, readonly Ground[]> = {
  [Ground.GRASS]: [Ground.DIRT, Ground.SWAMP],
  [Ground.DIRT]: [Ground.GRASS, Ground.WASTELAND],
  [Ground.SNOW]: [Ground.DIRT, Ground.WASTELAND],
  [Ground.SWAMP]: [Ground.GRASS, Ground.DIRT],
  [Ground.LAVA]: [Ground.WASTELAND, Ground.DIRT],
  [Ground.DESERT]: [Ground.BEACH, Ground.WASTELAND],
  [Ground.WASTELAND]: [Ground.DIRT, Ground.LAVA],
  [Ground.BEACH]: [Ground.DESERT, Ground.GRASS],
};

export function generateLandscape(layout: Layout, opts: GeneratorOptions, rng: Rng): Landscape {
  const grid = layout.grid;
  const W = grid.width;
  const zoneOf = layout.zoneOf;
  const zones = layout.zones;
  const protectedLand = new Uint8Array(grid.size);

  // --- Corridors ---
  const corridorNoise = new ValueNoise(rng.fork('corridor-noise'));
  const corridors: number[][] = [];
  for (const c of layout.connections) {
    const za = zones[c.a] as Zone;
    const zb = zones[c.b] as Zone;
    const cost = (t: number) => 1 + corridorNoise.fbm(grid.x(t) / 5, grid.y(t) / 5, 2) * 3;
    const legA = shortestPath(grid, za.seed, c.gateA, (t) => zoneOf[t] === c.a, cost, (side) => zoneOf[side] === c.a) ?? [za.seed, c.gateA];
    const legB = shortestPath(grid, c.gateB, zb.seed, (t) => zoneOf[t] === c.b, cost, (side) => zoneOf[side] === c.b) ?? [c.gateB, zb.seed];
    const line = [...legA, ...legB];
    // Keep diagonal steps walkable: their side tiles become part of the corridor.
    for (let i = 1; i < line.length; ++i) {
      const side = diagonalSideTile(grid, line[i - 1] as number, line[i] as number);
      if (side >= 0) line.push(side);
    }
    corridors.push(line);
    if (opts.preset !== 'islands') for (const t of line) dilate(grid, t, 1, (n) => (protectedLand[n] = 1));
  }
  for (const z of zones) {
    const r = z.kind === 'start' ? 7 : z.kind === 'center' ? 4 : 3;
    dilate(grid, z.seed, r, (n) => {
      if (zoneOf[n] === z.id) protectedLand[n] = 1;
    });
  }

  // --- Water ---
  const water = new Uint8Array(grid.size);
  const fraction = opts.preset === 'islands' ? Math.max(0.38, WATER_FRACTION[opts.water]) : WATER_FRACTION[opts.water];
  if (fraction > 0) {
    const noise = new ValueNoise(rng.fork('water-noise'));
    const scale = opts.preset === 'lakes' ? W / 9 : W / 5;
    const score = new Float64Array(grid.size);
    // Distance of each tile to its zone border, for the islands preset.
    const borderDist = opts.preset === 'islands' ? distanceToZoneBorder(grid, zoneOf) : null;
    for (let t = 0; t < grid.size; ++t) {
      const x = grid.x(t);
      const y = grid.y(t);
      let s = noise.fbm(x / scale, y / scale, 4);
      if (opts.preset === 'continent' || opts.preset === 'wasteland') {
        const edge = Math.min(x, y, W - 1 - x, W - 1 - y) / (W * 0.22);
        s += 0.45 * Math.max(0, 1 - edge);
      }
      if (borderDist) s = 0.35 * s + Math.max(0, 1 - (borderDist[t] as number) / 4);
      score[t] = s;
    }
    const candidates: number[] = [];
    for (let t = 0; t < grid.size; ++t) if (!protectedLand[t]) candidates.push(t);
    candidates.sort((a, b) => (score[b] as number) - (score[a] as number) || a - b);
    const target = Math.min(candidates.length, Math.round(grid.size * fraction));
    for (let i = 0; i < target; ++i) water[candidates[i] as number] = 1;

    // Clean up: no tiny lakes, no tiny islands, no single-tile notches.
    for (let pass = 0; pass < 3; ++pass) {
      for (let t = 0; t < grid.size; ++t) {
        let same = 0;
        for (const d of NEIGHBOR_DIRECTIONS) {
          const n = grid.neighbor(t, d);
          if (n >= 0 && water[n] === water[t]) ++same;
        }
        if (same <= 2 && !(water[t] === 0 && protectedLand[t])) water[t] = water[t] ? 0 : 1;
      }
    }
    removeSmallComponents(grid, water, 1, 10, 0);
    removeSmallComponents(grid, water, 0, opts.preset === 'islands' ? 30 : 12, 1, protectedLand);
    for (let t = 0; t < grid.size; ++t) if (protectedLand[t]) water[t] = 0;
  }

  // --- Biomes ---
  const patchNoise = new ValueNoise(rng.fork('patch-noise'));
  const coastNoise = new ValueNoise(rng.fork('coast-noise'));
  const secondary = zones.map((z) => rng.pick(SECONDARY[z.ground] ?? [Ground.DIRT]));
  const ground: Ground[] = new Array(grid.size);
  for (let t = 0; t < grid.size; ++t) {
    if (water[t]) {
      ground[t] = Ground.WATER;
      continue;
    }
    const z = zones[zoneOf[t] as number] as Zone;
    let g = z.ground;
    const p = patchNoise.fbm(grid.x(t) / 6, grid.y(t) / 6, 3);
    if (p > 0.66 && grid.distance(t, z.seed) > 6) g = secondary[z.id] as Ground;
    ground[t] = g;
  }
  // Beaches.
  for (let t = 0; t < grid.size; ++t) {
    if (water[t]) continue;
    let coast = false;
    for (const d of NEIGHBOR_DIRECTIONS) {
      const n = grid.neighbor(t, d);
      if (n >= 0 && water[n]) coast = true;
    }
    if (!coast) continue;
    const z = zones[zoneOf[t] as number] as Zone;
    if (z.ground === Ground.DESERT || z.ground === Ground.BEACH || coastNoise.fbm(grid.x(t) / 7, grid.y(t) / 7, 2) > 0.48) ground[t] = Ground.BEACH;
  }
  smoothGrounds(grid, ground, 3);
  return { ground, protectedLand, corridors };
}

// Changes isolated land tiles (fewer than 3 equal neighbors) to the most common neighboring land ground.
function smoothGrounds(grid: Grid, ground: Ground[], passes: number): void {
  for (let pass = 0; pass < passes; ++pass) {
    for (let t = 0; t < grid.size; ++t) {
      const g = ground[t] as Ground;
      if (g === Ground.WATER) continue;
      const counts = new Map<Ground, number>();
      let same = 0;
      for (const d of NEIGHBOR_DIRECTIONS) {
        const n = grid.neighbor(t, d);
        if (n < 0) {
          ++same;
          continue;
        }
        const ng = ground[n] as Ground;
        if (ng === g) ++same;
        else if (ng !== Ground.WATER) counts.set(ng, (counts.get(ng) ?? 0) + 1);
      }
      if (same >= 3) continue;
      let best: Ground | null = null;
      let bestCount = 0;
      for (const [k, c] of counts) {
        if (c > bestCount || (c === bestCount && best !== null && k < best)) {
          best = k;
          bestCount = c;
        }
      }
      if (best !== null) ground[t] = best;
    }
  }
}

function dilate(grid: Grid, center: number, radius: number, fn: (t: number) => void): void {
  const cx = grid.x(center);
  const cy = grid.y(center);
  for (let y = cy - radius; y <= cy + radius; ++y) {
    for (let x = cx - radius; x <= cx + radius; ++x) {
      if (grid.inside(x, y) && (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius + radius) fn(grid.index(x, y));
    }
  }
}

// Replaces components of `value` smaller than `minSize` (8-connected) with `replacement`, except protected tiles.
function removeSmallComponents(grid: Grid, mask: Uint8Array, value: number, minSize: number, replacement: number, keep?: Uint8Array): void {
  const seen = new Uint8Array(grid.size);
  for (let t = 0; t < grid.size; ++t) {
    if (seen[t] || mask[t] !== value) continue;
    const comp = [t];
    seen[t] = 1;
    let isProtected = false;
    for (let h = 0; h < comp.length; ++h) {
      const cur = comp[h] as number;
      if (keep?.[cur]) isProtected = true;
      for (const d of NEIGHBOR_DIRECTIONS) {
        const n = grid.neighbor(cur, d);
        if (n >= 0 && !seen[n] && mask[n] === value) {
          seen[n] = 1;
          comp.push(n);
        }
      }
    }
    if (comp.length < minSize && !isProtected) for (const c of comp) mask[c] = replacement;
  }
}

function distanceToZoneBorder(grid: Grid, zoneOf: Int16Array): Int32Array {
  const seeds: number[] = [];
  for (let t = 0; t < grid.size; ++t) {
    for (const d of ORTHOGONAL_DIRECTIONS) {
      const n = grid.neighbor(t, d);
      if (n >= 0 && zoneOf[n] !== zoneOf[t]) {
        seeds.push(t);
        break;
      }
    }
  }
  return grid.flood(seeds, () => true);
}

// For a diagonal step between two tiles, the side tile that must stay free so heroes can make the move:
// fheroes2 forbids diagonal moves past a tall object standing beside the lower tile (Tile::updatePassability).
export function diagonalSideTile(grid: Grid, a: number, b: number): number {
  const [lower, upper] = grid.y(a) > grid.y(b) ? [a, b] : [b, a];
  if (grid.x(lower) === grid.x(upper) || grid.y(lower) === grid.y(upper)) return -1;
  return grid.index(grid.x(upper), grid.y(lower));
}

// Dijkstra over 8-connected tiles accepted by `pass` with per-tile entry cost.
// Diagonal steps are taken only if `diagonalOk(sideTile)` accepts the side tile (see diagonalSideTile).
export function shortestPath(
  grid: Grid,
  from: number,
  to: number,
  pass: (t: number) => boolean,
  cost: (t: number) => number,
  diagonalOk: (side: number) => boolean = () => true,
): number[] | null {
  const dist = new Float64Array(grid.size).fill(Infinity);
  const prev = new Int32Array(grid.size).fill(-1);
  const heap = new MinHeap();
  dist[from] = 0;
  heap.push(from, 0);
  while (heap.size > 0) {
    const [cur, d] = heap.pop();
    if (d > (dist[cur] as number)) continue;
    if (cur === to) break;
    for (const dir of NEIGHBOR_DIRECTIONS) {
      const n = grid.neighbor(cur, dir);
      if (n < 0 || (n !== to && !pass(n))) continue;
      const diagonal = grid.x(n) !== grid.x(cur) && grid.y(n) !== grid.y(cur);
      if (diagonal && !diagonalOk(diagonalSideTile(grid, cur, n))) continue;
      const nd = d + cost(n) * (diagonal ? 1.41 : 1);
      if (nd < (dist[n] as number)) {
        dist[n] = nd;
        prev[n] = cur;
        heap.push(n, nd);
      }
    }
  }
  if (dist[to] === Infinity) return null;
  const path: number[] = [];
  for (let t = to; t !== -1; t = prev[t] as number) path.push(t);
  return path.reverse();
}

export class MinHeap {
  private readonly keys: number[] = [];
  private readonly prios: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, prio: number): void {
    this.keys.push(key);
    this.prios.push(prio);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.prios[p] as number) < prio || ((this.prios[p] as number) === prio && (this.keys[p] as number) <= key)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): [number, number] {
    const top: [number, number] = [this.keys[0] as number, this.prios[0] as number];
    const lastKey = this.keys.pop() as number;
    const lastPrio = this.prios.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.less(l, m)) m = l;
        if (r < this.keys.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const pa = this.prios[a] as number;
    const pb = this.prios[b] as number;
    return pa < pb || (pa === pb && (this.keys[a] as number) < (this.keys[b] as number));
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b] as number, this.keys[a] as number];
    [this.prios[a], this.prios[b]] = [this.prios[b] as number, this.prios[a] as number];
  }
}
