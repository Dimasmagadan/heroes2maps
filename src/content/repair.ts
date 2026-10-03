// Reachability repair: when the validator finds unreachable objects, clears the cheapest path through
// decoration obstacles (removing them), and as a last resort removes the unreachable object and its guard.

import { MinHeap } from '../terrain/landscape.ts';
import { ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import { ObjectGroup } from '../fh2m/types.ts';
import { MovementModel, playerStarts, reach, validateMap, type MapObjectRef, type ValidationReport } from '../validate.ts';
import type { ContentContext } from './content.ts';

const REMOVABLE_TAGS = new Set(['decoration', 'border']);

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

// Dijkstra from reached land to the object, where decoration tiles cost extra; removes decorations on the path.
// Only orthogonal steps are used, so the cleared path does not depend on fheroes2's diagonal-move rule.
function clearPathTo(ctx: ContentContext, model: MovementModel, reached: Uint8Array, target: MapObjectRef): number {
  const g = ctx.grid;
  const b = ctx.b;
  const decorationAt = (t: number): number => {
    const uid = b.occupant[t] as number;
    if (uid === 0) return 0;
    const placed = b.objects.get(uid);
    return placed && placed.tag !== undefined && REMOVABLE_TAGS.has(placed.tag) ? uid : -1;
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
      if (n < 0 || model.water[n]) continue;
      let step = 1;
      if (!goals.has(n)) {
        const deco = decorationAt(n);
        if (deco < 0) continue;
        if (deco > 0) step += 10;
        else if ((model.actionAt[n] as number) >= 0) continue;
      }
      if (d + step < (dist[n] as number)) {
        dist[n] = d + step;
        prev[n] = cur;
        heap.push(n, d + step);
      }
    }
  }
  if (found < 0) return 0;
  const toRemove = new Set<number>();
  for (let t = found; t !== -1; t = prev[t] as number) {
    const deco = decorationAt(t);
    if (deco > 0) toRemove.add(deco);
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
