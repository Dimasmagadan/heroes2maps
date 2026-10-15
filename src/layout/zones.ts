// Zone layout: partitions the map into player start zones, neutral zones and a center zone, and decides which
// zones are connected (through guarded gates).
//
// Seeds: start zones on a ring around the map center, the center zone in the middle (72+ maps), neutral seeds by
// best-candidate sampling. Tiles go to the seed with the smallest noise-perturbed weighted distance, giving
// irregular Voronoi cells. Connections: a minimum spanning tree over adjacent zones (start-start edges are
// penalized so players meet through neutral land) plus some extra edges for loops.

import { GenerationError } from '../errors.ts';
import { Grid, NEIGHBOR_DIRECTIONS, ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import { playerTeams, type GeneratorOptions } from '../options.ts';
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
  const teams = playerTeams(opts);
  // The walled-in team gets bigger zones.
  const weight = (s: { kind: ZoneKind; player: number }) => (s.kind === 'start' ? (opts.teams && teams[s.player] === 3 ? 0.85 : 0.93) : s.kind === 'center' ? 0.97 : 1);
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
  const connections = connectZones(grid, zoneOf, zones, rng.fork('connections'), opts.teams ? teams : null);
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

function connectZones(grid: Grid, zoneOf: Int16Array, zones: Zone[], rng: Rng, teams: readonly number[] | null): Connection[] {
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
  // Extra loops, avoiding direct start-to-start shortcuts.
  for (const e of rest) {
    const both = (zones[e.a] as Zone).kind === 'start' && (zones[e.b] as Zone).kind === 'start';
    if (teams && (walled(zones[e.a] as Zone) || walled(zones[e.b] as Zone))) continue;
    if (!both && rng.chance(0.35)) chosen.push(e);
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
