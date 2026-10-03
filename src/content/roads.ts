// Road routing: every castle is linked to the gates of its zone, and zones without a castle link their gates
// through the zone center. Paths are found with Dijkstra over free land (cheaper on existing roads, more
// expensive on rough ground) and turned into road sprites with the ported fheroes2 road logic.

import { ObjectGroup } from '../fh2m/types.ts';
import type { Zone } from '../layout/zones.ts';
import { Ground } from '../terrain/ground.ts';
import { diagonalSideTile, shortestPath } from '../terrain/landscape.ts';
import { containsRoad } from '../terrain/transitions.ts';
import { Reserve } from './builder.ts';
import type { ContentContext } from './content.ts';

const GROUND_COST: Record<number, number> = {
  [Ground.DESERT]: 2,
  [Ground.SWAMP]: 1.75,
  [Ground.SNOW]: 1.5,
  [Ground.WASTELAND]: 1.25,
  [Ground.BEACH]: 1.25,
};

export function routeRoads(ctx: ContentContext): number[] {
  const b = ctx.b;
  const g = ctx.grid;
  const roadTiles = new Set<number>();
  const cost = (t: number) => {
    if (containsRoad(b.tile(t)) || roadTiles.has(t)) return 0.35;
    const base = GROUND_COST[b.ground(t)] ?? 1;
    return base + (b.reserved[t] === Reserve.ACCESS ? 3 : 0);
  };
  const passable = (t: number) => !b.isWater(t) && b.isFree(t);

  const sides = new Set<number>();
  const link = (from: number, to: number) => {
    if (from === to) return;
    const path = shortestPath(g, from, to, passable, cost, passable);
    if (!path) return;
    for (const t of path) if (passable(t)) roadTiles.add(t);
    for (let i = 1; i < path.length; ++i) {
      const side = diagonalSideTile(g, path[i - 1] as number, path[i] as number);
      if (side >= 0) sides.add(side);
    }
  };

  const zones = ctx.layout.zones;
  for (const zone of zones) {
    const gates: number[] = [];
    for (const c of ctx.layout.connections) {
      if (c.a === zone.id) gates.push(c.gateA);
      if (c.b === zone.id) gates.push(c.gateB);
    }
    const castle = ctx.castles.find((s) => s.zone === zone.id);
    const hub = castle ? castle.tile + 2 * g.width : nearestFree(ctx, zone);
    if (hub < 0) continue;
    if (castle) roadTiles.add(castle.tile + g.width);
    for (const gate of gates) if (passable(gate)) link(hub, gate);
    // Mines of start zones get a road to their entrance.
    if (zone.kind === 'start') {
      for (const r of ctx.records) {
        if (r.zone !== zone.id || r.kind !== 'mine') continue;
        const entrance = r.tile + g.width;
        if (entrance < g.size && passable(entrance)) link(hub, entrance);
      }
    }
  }
  for (const c of ctx.layout.connections) {
    if (passable(c.gateA) && passable(c.gateB)) {
      roadTiles.add(c.gateA);
      roadTiles.add(c.gateB);
    }
  }

  const ordered = [...roadTiles].sort((p, q) => p - q);
  for (const t of ordered) {
    b.roads.setRoad(t);
    b.reserve(t, Reserve.ROAD);
  }
  b.roads.updateAllRoads();
  // Side tiles of diagonal road steps must stay free of obstacles.
  for (const t of sides) if (!roadTiles.has(t)) b.reserve(t, Reserve.KEEP_CLEAR);
  return ordered;
}

function nearestFree(ctx: ContentContext, zone: Zone): number {
  const g = ctx.grid;
  let best = -1;
  let bestD = Infinity;
  for (const t of zone.tiles) {
    if (ctx.b.isWater(t) || !ctx.b.isFree(t) || !ctx.usable(t)) continue;
    const d = g.euclid(t, zone.seed);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

export function countRoads(ctx: ContentContext): number {
  let n = 0;
  for (const t of ctx.b.map.tiles) n += t.objects.filter((o) => o.group === ObjectGroup.ROADS).length;
  return n;
}
