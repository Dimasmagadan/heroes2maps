// Reachability repair: when the validator finds unreachable objects, clears the cheapest path through removable
// obstacles (decoration first, content as a last resort; the walled team's `keeper` seal and gate keepers are
// never touched), and as a last resort removes the unreachable object and its guard.

import { MinHeap } from '../terrain/landscape.ts';
import { ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import { ObjectGroup } from '../fh2m/types.ts';
import { MovementModel, isRemovable, playerStarts, reach, validateMap, type MapObjectRef, type ValidationReport } from '../validate.ts';
import type { ContentContext } from './content.ts';

export interface RepairResult {
  report: ValidationReport;
  removedDecorations: number;
  removedObjects: number;
}

export function repairReachability(ctx: ContentContext, rounds = 12): RepairResult {
  let removedDecorations = 0;
  let removedObjects = 0;
  let report = validateMap(ctx.b.map, { strictOverlaps: true });
  for (let round = 0; round < rounds && !report.ok; ++round) {
    const model = new MovementModel(ctx.b.map);
    const handled = new Set<number>();
    let changed = false;
    for (const start of playerStarts(model)) {
      const r = reach(model, start.tiles, { boats: true });
      for (let i = 0; i < model.objects.length; ++i) {
        const o = model.objects[i] as MapObjectRef;
        if (!o.info.isAction || r.visited.has(i) || start.tiles.includes(o.tile) || handled.has(o.uid)) continue;
        handled.add(o.uid);
        // The model may be stale after earlier changes in this round; clearing only removes obstacles, so it is safe.
        const cleared = clearPathTo(ctx, model, r.land, o);
        if (cleared > 0) {
          removedDecorations += cleared;
          changed = true;
        } else if (round >= 2) {
          if (o.group === ObjectGroup.KINGDOM_TOWNS || o.group === ObjectGroup.KINGDOM_HEROES) continue; // never drop players or towns
          const placed = ctx.b.objects.get(o.uid);
          if (placed?.tag === 'gate-guard') continue; // the keeper of the walled team stays, whatever it guards
          removeWithGuard(ctx, o.uid);
          ++removedObjects;
          changed = true;
        }
      }
    }
    report = validateMap(ctx.b.map, { strictOverlaps: true });
    if (!changed && round >= 2) break;
  }
  return { report, removedDecorations, removedObjects };
}

// Dijkstra from reached land to the object. Tile costs mirror the movement model: removable objects (pickups,
// monsters, heroes, boats) are visited and do not block; blocked tiles are cleared if their object is
// expendable — decoration and border walls cheaply, game content as a last resort — and never if it is part of
// the walled team's seal, a castle, a hero or the target itself. Only orthogonal steps are used, so the cleared
// path does not depend on fheroes2's diagonal-move rule.

// Clearing costs: decoration first, game content (chests, dwellings, power-ups) as a last resort. The map
// economy is never carved away: mines, castles, heroes and the walled team's seal stay.
const CLEAR_DECORATION = 10;
const CLEAR_CONTENT = 60;
const NEVER_CARVE = new Set<number>([ObjectGroup.ADVENTURE_MINES, ObjectGroup.KINGDOM_TOWNS, ObjectGroup.KINGDOM_HEROES]);

function clearPathTo(ctx: ContentContext, model: MovementModel, reached: Uint8Array, target: MapObjectRef): number {
  const g = ctx.grid;
  const b = ctx.b;
  // -1: impassable even after clearing; 1: free to walk (nothing to remove); > 1: cost of clearing the tile.
  // The live builder state is the truth: the model is stale for tiles cleared for earlier targets this round.
  const stepCost = (t: number): number => {
    if (model.water[t]) return -1;
    const uid = b.occupant[t] as number;
    if (uid === 0) return 1;
    const a = model.actionAt[t] as number;
    if (a >= 0) {
      const obj = model.objects[a] as MapObjectRef;
      if (isRemovable(obj.info)) return 1; // the hero visits it and moves on
      return NEVER_CARVE.has(obj.group) ? -1 : CLEAR_CONTENT; // the hero would have to stop here
    }
    const placed = b.objects.get(uid) ?? null;
    if (!placed) return -1;
    if (placed.uid === target.uid || placed.tag === 'keeper' || NEVER_CARVE.has(placed.group)) return -1;
    return placed.tag === 'decoration' || placed.tag === 'border' ? CLEAR_DECORATION : CLEAR_CONTENT;
  };
  const goals = new Set(target.info.actionCells.map((a) => g.index(g.x(target.tile) + a.dx, g.y(target.tile) + a.dy)));
  const dist = new Float64Array(g.size).fill(Infinity);
  const prev = new Int32Array(g.size).fill(-1);
  const heap = new MinHeap();
  for (let t = 0; t < g.size; ++t) {
    if (reached[t]) {
      dist[t] = 0;
      heap.push(t, 0);
    }
  }
  let found = -1;
  while (heap.size > 0) {
    const [cur, d] = heap.pop();
    if (d > (dist[cur] as number)) continue;
    if (goals.has(cur)) {
      found = cur;
      break;
    }
    for (const dir of ORTHOGONAL_DIRECTIONS) {
      const n = g.neighbor(cur, dir);
      if (n < 0) continue;
      const cost = goals.has(n) ? 1 : stepCost(n);
      if (cost < 0) continue;
      const nd = d + cost;
      if (nd < (dist[n] as number)) {
        dist[n] = nd;
        prev[n] = cur;
        heap.push(n, nd);
      }
    }
  }
  if (found < 0) return 0;
  const toRemove = new Set<number>();
  for (let t = found; t !== -1; t = prev[t] as number) {
    if (goals.has(t) || stepCost(t) <= 1) continue;
    const uid = b.occupant[t] as number;
    if (uid !== 0) toRemove.add(uid);
  }
  for (const uid of toRemove) b.remove(uid);
  return toRemove.size;
}

function removeWithGuard(ctx: ContentContext, uid: number): void {
  for (const r of ctx.records) {
    if (r.guardOf === uid) ctx.b.remove(r.uid);
  }
  ctx.b.remove(uid);
  for (let i = ctx.records.length - 1; i >= 0; --i) {
    const r = ctx.records[i];
    if (r && (r.uid === uid || r.guardOf === uid)) ctx.records.splice(i, 1);
  }
}
