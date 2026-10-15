// Zone seal: the walled-in team (teams option) must be reachable only through its keeper gate.
//
// The wall ring around the walled zones (wallZoneBorders) only seals if no enterable tile of a walled zone
// touches an enterable tile of the rest of the map — or water, from which a hero could disembark. Roads and
// corridors keep off the border ring (routeRoads, the corridor legs), wallZoneBorders guarantees an obstacle on
// every remaining ring tile, and checkZoneSeal verifies the finished map against its movement model.

import { NEIGHBOR_DIRECTIONS } from '../grid.ts';
import { walledBorderTiles, walledZoneIds, type Layout, type Zone } from '../layout/zones.ts';
import { playerTeams, type GeneratorOptions } from '../options.ts';
import { Ground } from '../terrain/ground.ts';
import { MovementModel } from '../validate.ts';
import { Reserve } from './builder.ts';
import type { MapBuilder } from './builder.ts';
import type { ContentContext } from './content.ts';

export interface SealInfo {
  // Zone ids of the walled-in team.
  readonly zones: Set<number>;
  // Tiles of walled zones that touch the rest of the map (8-adjacency, water included).
  readonly border: Set<number>;
  // Walled-side gate tiles of keeper connections: the intended crossing, exempt from the wall fill.
  readonly keeperGates: Set<number>;
  // Gate tiles of connections between two walled zones: kept open for the team, sealed against the outside.
  readonly internalGates: Set<number>;
}

export function sealInfo(ctx: ContentContext): SealInfo {
  const teams = ctx.opts.teams ? playerTeams(ctx.opts) : null;
  const zones = walledZoneIds(ctx.layout.zones, teams);
  const border = walledBorderTiles(ctx.grid, ctx.layout.zoneOf, ctx.layout.zones, zones);
  const keeperGates = new Set<number>();
  const internalGates = new Set<number>();
  if (zones.size > 0) {
    for (const c of ctx.layout.connections) {
      if (c.keeper !== undefined) keeperGates.add(c.keeper === c.a ? c.gateA : c.gateB);
      else if (zones.has(c.a) && zones.has(c.b)) {
        internalGates.add(c.gateA);
        internalGates.add(c.gateB);
      }
    }
  }
  return { zones, border, keeperGates, internalGates };
}

// Every tile of a walled zone that may not be built over or decorated (the border ring and the internal gates,
// which must stay open for the team itself).
export function noBuildTiles(seal: SealInfo): Set<number> {
  if (seal.internalGates.size === 0) return seal.border;
  return new Set([...seal.border, ...seal.internalGates]);
}

// The terrain transition pass replaces the ground of corner tiles that have no valid transition image with a
// neighboring ground — sometimes water. The walled-in team's seal needs dry land on the wall ring and on the
// tiles next to it (a hero could disembark there), so convert any water that close back to beach. Beach counts
// as water for the neighbors' transitions, so no other tile needs to change.
export function dryWalledShores(b: MapBuilder, layout: Layout, opts: GeneratorOptions): void {
  if (!opts.teams) return;
  const zones = walledZoneIds(layout.zones, playerTeams(opts));
  if (zones.size === 0) return;
  const dry = new Set<number>();
  for (const id of zones) {
    for (const t of (layout.zones[id] as Zone).tiles) {
      dry.add(t);
      for (const d of NEIGHBOR_DIRECTIONS) {
        const n = layout.grid.neighbor(t, d);
        if (n >= 0) dry.add(n);
      }
    }
  }
  for (let pass = 0; pass < 4; ++pass) {
    const wet = [...dry].filter((t) => b.isWater(t));
    if (wet.length === 0) return;
    for (const t of wet) {
      b.terrain.setGround(t, Ground.BEACH);
      b.terrain.updateTransitions(b.grid.around(t));
    }
  }
}

// Keeps a free apron around the outside side of every keeper gate: the wall belt and decoration must not close
// the last tiles in front of the gate, or no path reaches the keeper and the team is unreachable behind it.
export function reserveGateAprons(ctx: ContentContext): void {
  if (!ctx.opts.teams) return;
  const seal = sealInfo(ctx);
  if (seal.zones.size === 0) return;
  const g = ctx.grid;
  for (const c of ctx.layout.connections) {
    if (c.keeper === undefined) continue;
    const outside = c.keeper === c.a ? c.gateB : c.gateA;
    for (const t of g.around(outside, 2)) {
      if (seal.zones.has(ctx.layout.zoneOf[t] as number) || ctx.b.isWater(t) || !ctx.b.isFree(t)) continue;
      ctx.b.reserve(t, Reserve.ROAD);
    }
  }
}

// Returns one message per seal leak; an empty list means the walled team can only be entered through its keepers.
export function checkZoneSeal(ctx: ContentContext): string[] {
  const seal = sealInfo(ctx);
  if (seal.zones.size === 0) return [];
  const model = new MovementModel(ctx.b.map);
  const g = model.grid;
  const zoneOf = ctx.layout.zoneOf;
  const errors: string[] = [];
  const at = (t: number) => `${g.x(t)},${g.y(t)}`;
  const enterable = (t: number) => !model.water[t] && model.passability[t] !== 0;
  for (const zid of seal.zones) {
    for (const t of (ctx.layout.zones[zid] as Zone).tiles) {
      if (model.water[t]) {
        errors.push(`walled zone ${zid} contains water at ${at(t)}`);
        continue;
      }
      if (!enterable(t)) continue; // blocked by the wall ring or an obstacle
      for (const d of NEIGHBOR_DIRECTIONS) {
        const n = g.neighbor(t, d);
        if (n < 0 || seal.zones.has(zoneOf[n] as number)) continue;
        if (seal.keeperGates.has(t)) continue; // the guarded crossing
        if (model.water[n]) errors.push(`walled zone ${zid} is enterable from water at ${at(t)}`);
        else if (enterable(n)) errors.push(`walled zone ${zid} is enterable from zone ${zoneOf[n]} at ${at(t)} -> ${at(n)}`);
      }
    }
  }
  return errors;
}
