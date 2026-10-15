// Game content: castles, starting heroes, mines, treasures, dwellings, power-ups, artifacts and guards.
//
// Every start zone gets the same kit: a castle with a hero, wood and ore mines close by, the same set of rare
// mines a bit further out, some unguarded resources, a dwelling and a power-up. Neutral zones get a value budget
// that grows with the distance from the nearest start; the budget is spent on mines, treasures, artifacts,
// dwellings and power-ups, each guarded by monsters scaled to its value, the zone distance and the difficulty.

import { artifacts, objectTypes } from '../data/enums.ts';
import { GenerationError } from '../errors.ts';
import { ObjectGroup } from '../fh2m/types.ts';
import { Direction, Grid, NEIGHBOR_DIRECTIONS, ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import type { Layout, Zone } from '../layout/zones.ts';
import { findObjects, getObjectInfo, type ObjectInfo } from '../objects.ts';
import type { GeneratorOptions } from '../options.ts';
import type { Rng } from '../rng.ts';
import { Ground } from '../terrain/ground.ts';
import { MapBuilder, Reserve, needsAccessBelow, type PlacedObject } from './builder.ts';
import {
  NEUTRAL_COLOR_INDEX,
  RANDOM_CASTLE_INDEX,
  RANDOM_RACE_HERO,
  RANDOM_TOWN_INDEX,
  RESOURCE_NAMES,
  firstIndexOfType,
  flagIndex,
  heroIndex,
  mineIndex,
  monsterObjectIndex,
  objectValue,
  resourcePickupIndex,
  townBasementIndex,
  variantFor,
  type ResourceName,
} from './catalog.ts';
import { DIFFICULTY_FACTOR, chooseGuard, guardStrength } from './monsters.ts';
import { sealInfo } from './seal.ts';
import { MovementModel, guardedTiles } from '../validate.ts';

export type ContentKind = 'castle' | 'hero' | 'mine' | 'resource' | 'treasure' | 'artifact' | 'dwelling' | 'powerup' | 'guard' | 'boat' | 'misc';

export interface ContentRecord {
  uid: number;
  zone: number;
  kind: ContentKind;
  value: number;
  tile: number;
  guardOf?: number; // for guards: UID of the guarded object (0 for gate guards)
  resource?: ResourceName;
  strength?: number; // for guards
  player?: number; // for castles and heroes
}

export interface CastleSite {
  zone: number;
  player: number; // -1 for neutral towns
  tile: number;
  uid: number;
}

export class ContentContext {
  readonly b: MapBuilder;
  readonly layout: Layout;
  readonly opts: GeneratorOptions;
  readonly rng: Rng;
  readonly grid: Grid;
  // Distance (in steps) from each tile to the border of its zone.
  readonly borderDist: Int32Array;
  // Land region (8-connected land component) of each tile, -1 for water.
  readonly region: Int32Array;
  readonly records: ContentRecord[] = [];
  // Objects the map cannot do without (scenario objects); generation fails if the repair removed one.
  readonly required = new Set<number>();
  readonly castles: CastleSite[] = [];
  // Land regions that heroes can reach (all regions with content).
  readonly usableRegions = new Set<number>();

  constructor(b: MapBuilder, layout: Layout, opts: GeneratorOptions, rng: Rng) {
    this.b = b;
    this.layout = layout;
    this.opts = opts;
    this.rng = rng;
    this.grid = b.grid;
    this.borderDist = zoneBorderDistance(b.grid, layout.zoneOf);
    this.region = landRegions(b);
  }

  record(r: ContentRecord): void {
    this.records.push(r);
  }

  usable(t: number): boolean {
    const r = this.region[t] as number;
    return r >= 0 && this.usableRegions.has(r);
  }

  // Tries tiles of a zone ordered by closeness to a preferred distance from `anchor`.
  placeInZone(
    zone: Zone,
    group: ObjectGroup,
    index: number,
    spot: { anchor: number; min: number; max: number; prefer?: number; margin?: number; tag?: string; allowReserved?: readonly number[] },
  ): PlacedObject | null {
    const g = this.grid;
    const info = getObjectInfo(group, index);
    const prefer = spot.prefer ?? (spot.min + spot.max) / 2;
    const margin = spot.margin ?? 2;
    const candidates: { t: number; score: number }[] = [];
    for (const t of zone.tiles) {
      if (!this.usable(t) || (this.borderDist[t] as number) < margin) continue;
      const d = g.euclid(t, spot.anchor);
      if (d < spot.min || d > spot.max) continue;
      candidates.push({ t, score: Math.abs(d - prefer) + this.rng.next() * 3 });
    }
    candidates.sort((a, b) => a.score - b.score || a.t - b.t);
    for (const c of candidates.slice(0, 250)) {
      const placed = this.b.place(group, index, g.x(c.t), g.y(c.t), {
        ...(spot.tag !== undefined ? { tag: spot.tag } : {}),
        ...(spot.allowReserved ? { allowReserved: spot.allowReserved } : {}),
      });
      if (placed) {
        if (!needsAccessBelow(info)) this.reserveApproach(placed.tile, spot.anchor);
        return placed;
      }
    }
    return null;
  }

  // Keeps one free neighbor of an action tile clear of obstacles (the one closest to `toward`).
  reserveApproach(tile: number, toward: number): void {
    const g = this.grid;
    let best = -1;
    let bestD = Infinity;
    for (const d of NEIGHBOR_DIRECTIONS) {
      const n = g.neighbor(tile, d);
      if (n < 0 || !this.b.isFree(n) || this.b.isWater(n)) continue;
      const dist = g.euclid(n, toward);
      if (dist < bestD) {
        bestD = dist;
        best = n;
      }
    }
    if (best >= 0) this.b.reserve(best, Reserve.KEEP_CLEAR);
  }

  // Places a monster guard next to (or in front of) an object.
  guard(target: PlacedObject, zone: Zone, value: number, minStrength = 25): PlacedObject | null {
    const strength = guardStrength(value, zone.distance, this.opts.difficulty);
    if (strength < minStrength) return null;
    const g = this.grid;
    const info = target.info;
    const spots: number[] = [];
    const tx = g.x(target.tile);
    const ty = g.y(target.tile);
    if (needsAccessBelow(info)) {
      for (const a of info.actionCells) {
        if (g.inside(tx + a.dx, ty + a.dy + 1)) spots.push(g.index(tx + a.dx, ty + a.dy + 1));
      }
    } else {
      const around = g.around(target.tile).filter((n) => !this.b.isWater(n));
      around.sort((a, b) => g.euclid(a, zone.seed) - g.euclid(b, zone.seed) || a - b);
      spots.push(...around);
    }
    const choice = chooseGuard(this.rng, strength, this.opts.race === 'necromancer' ? 24 : 14);
    for (const s of spots) {
      const placed = this.b.place(ObjectGroup.MONSTERS, monsterObjectIndex(choice.monster.id), g.x(s), g.y(s), {
        allowReserved: [Reserve.ACCESS, Reserve.KEEP_CLEAR],
        tag: 'guard',
      });
      if (!placed) continue;
      const meta = this.b.map.monsterMetadata.get(placed.uid);
      if (meta) meta.count = choice.count;
      this.reserveApproach(placed.tile, zone.seed);
      this.record({ uid: placed.uid, zone: zone.id, kind: 'guard', value: 0, tile: placed.tile, guardOf: target.uid, strength: choice.strength });
      return placed;
    }
    return null;
  }
}

// --- Castles and heroes ---

export function placeCastle(ctx: ContentContext, zone: Zone, colorIndex: number, raceIndex: number, isCastle: boolean): CastleSite | null {
  const b = ctx.b;
  const g = ctx.grid;
  const townIdx = colorIndex === NEUTRAL_COLOR_INDEX ? (isCastle ? RANDOM_CASTLE_INDEX : RANDOM_TOWN_INDEX) : raceIndex >= 0 ? raceIndex * 2 + (isCastle ? 0 : 1) : RANDOM_CASTLE_INDEX;
  const town = getObjectInfo(ObjectGroup.KINGDOM_TOWNS, townIdx);
  const candidates = zone.tiles
    .filter((t) => ctx.usable(t) && (ctx.borderDist[t] as number) >= 5 && g.distance(t, zone.seed) <= 8)
    .map((t) => ({ t, score: g.euclid(t, zone.seed) + ctx.rng.next() * 1.5 }))
    .sort((a, b) => a.score - b.score || a.t - b.t);

  for (const { t } of candidates) {
    const x = g.x(t);
    const y = g.y(t);
    if (y + 2 >= g.width || x < 3 || x > g.width - 4) continue;
    const ground = b.ground(t);
    if (ground === Ground.WATER) continue;
    const basement = getObjectInfo(ObjectGroup.LANDSCAPE_TOWN_BASEMENTS, townBasementIndex(ground));
    // Castles may cover corridor tiles: the roads are routed later from the castle entrance.
    const allow = { anyTerrain: true, allowReserved: [Reserve.ROAD] };
    if (!b.canPlace(town, x, y, { ...allow, noAccess: true }) || !b.canPlace(basement, x, y, allow)) continue;
    // The entrance and the tile below it stay open for the hero and the road.
    const entrance = g.index(x, y + 1);
    const below = g.index(x, y + 2);
    if (!b.isFree(entrance) || !b.isFree(below) || b.isWater(entrance) || b.isWater(below)) continue;

    const uid = b.newUid();
    b.forcePlace(ObjectGroup.LANDSCAPE_TOWN_BASEMENTS, basement.index, x, y, {}, uid);
    const placed = b.forcePlace(ObjectGroup.KINGDOM_TOWNS, townIdx, x, y, { noAccess: true }, uid);
    b.addObject(t - 1, ObjectGroup.LANDSCAPE_FLAGS, flagIndex(colorIndex, false), uid);
    b.addObject(t + 1, ObjectGroup.LANDSCAPE_FLAGS, flagIndex(colorIndex, true), uid);
    if (colorIndex === NEUTRAL_COLOR_INDEX) {
      // Neutral towns get the default random defenders (Maps::setDefaultCastleDefenderArmy).
      const meta = b.map.castleMetadata.get(uid);
      if (meta) {
        meta.defenderMonsterType = [-1, -1, -1, -1, -1];
        meta.defenderMonsterCount = [0, 0, 0, 0, 0];
      }
    }
    // Reservations are undone when the candidate is rejected, so no stale keep-clear areas remain.
    const reservedBefore: [number, number][] = [];
    const reserve = (i: number, kind: number) => {
      reservedBefore.push([i, b.reserved[i] as number]);
      b.reserve(i, kind);
    };
    reserve(entrance, Reserve.ACCESS);
    // ACCESS, not ROAD: a road starts here later, but another castle's body must not cover the approach.
    reserve(below, Reserve.ACCESS);
    // Keep a ring around the castle free of obstacles.
    for (let yy = y - 1; yy <= y + 3; ++yy) {
      for (let xx = x - 3; xx <= x + 3; ++xx) {
        if (g.inside(xx, yy) && b.isFree(g.index(xx, yy))) reserve(g.index(xx, yy), Reserve.KEEP_CLEAR);
      }
    }
    // The entrance approach must reach the open area of the zone through free land: the castle's own body plus
    // nearby obstacles or a lake could otherwise seal the pocket behind the entrance, and the reachability
    // repair could not reopen it (castle bodies are never removed).
    if (!entranceConnects(ctx, below, zone.seed)) {
      b.remove(uid);
      for (const [i, v] of reservedBefore) b.reserved[i] = v;
      continue;
    }
    const site: CastleSite = { zone: zone.id, player: colorIndex === NEUTRAL_COLOR_INDEX ? -1 : colorIndex, tile: t, uid: placed.uid };
    ctx.castles.push(site);
    ctx.record({ uid, zone: zone.id, kind: 'castle', value: isCastle ? 10000 : 6000, tile: t, ...(site.player >= 0 ? { player: site.player } : {}) });
    return site;
  }
  return null;
}

// Orthogonal flood through free land, from `from` to `target`.
function entranceConnects(ctx: ContentContext, from: number, target: number): boolean {
  const g = ctx.grid;
  if (from === target) return true;
  const seen = new Set<number>([from]);
  const queue = [from];
  for (let h = 0; h < queue.length; ++h) {
    const cur = queue[h] as number;
    for (const d of ORTHOGONAL_DIRECTIONS) {
      const n = g.neighbor(cur, d);
      if (n < 0 || seen.has(n) || ctx.b.isWater(n) || !ctx.b.isFree(n)) continue;
      if (n === target) return true;
      seen.add(n);
      queue.push(n);
    }
  }
  return false;
}

export function placeStartingHero(ctx: ContentContext, castle: CastleSite, colorIndex: number, raceIndex = -1): PlacedObject | null {
  const g = ctx.grid;
  const entrance = castle.tile + g.width;
  const hero = ctx.b.place(ObjectGroup.KINGDOM_HEROES, heroIndex(colorIndex, raceIndex >= 0 ? raceIndex : RANDOM_RACE_HERO), g.x(entrance), g.y(entrance), {
    allowReserved: [Reserve.ACCESS],
    anyTerrain: true,
  });
  if (hero) ctx.record({ uid: hero.uid, zone: castle.zone, kind: 'hero', value: 0, tile: entrance, player: colorIndex });
  return hero;
}

// --- Mines ---

export function placeMine(ctx: ContentContext, zone: Zone, resource: ResourceName, anchor: number, min: number, max: number, guardMin = 25): PlacedObject | null {
  // Use the art for the ground near the anchor; fall back to any ground variant that fits the tile.
  const grounds = [zone.ground, ctx.b.ground(anchor), Ground.GRASS, Ground.DIRT, Ground.SNOW, Ground.SWAMP, Ground.LAVA, Ground.DESERT, Ground.WASTELAND];
  for (const ground of grounds) {
    if (ground === Ground.WATER) continue;
    const index = mineIndex(resource, ground);
    const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_MINES, index, { anchor, min, max, margin: 3 });
    if (!placed) continue;
    const value = objectValue(placed.info);
    ctx.record({ uid: placed.uid, zone: zone.id, kind: 'mine', value, tile: placed.tile, resource });
    ctx.guard(placed, zone, value, guardMin);
    return placed;
  }
  return null;
}

// --- Treasures and other valuables ---

interface Valuable {
  boost?: number;
  kind: ContentKind;
  group: ObjectGroup;
  index: number;
  value: number;
}

function valuablePool(ctx: ContentContext, zone: Zone): Valuable[] {
  const ground = zone.ground === Ground.BEACH ? Ground.DESERT : zone.ground;
  const exp = ctx.opts.expansion;
  const pool: Valuable[] = [];
  const necro = ctx.opts.race === 'necromancer';
  const add = (kind: ContentKind, info: ObjectInfo | null) => {
    if (!info) return;
    // Necromancer maps lean toward graveyards and undead dwellings: they feed necromancy and the army.
    const boost = necro && NECRO_OBJECTS.has(info.objectType) ? NECRO_BOOST : 1;
    pool.push({ kind, group: info.group, index: info.index, value: objectValue(info), boost });
  };
  const T = objectTypes;
  for (const type of [T.OBJ_TREASURE_CHEST, T.OBJ_CAMPFIRE, T.OBJ_RANDOM_RESOURCE, T.OBJ_GENIE_LAMP]) add('treasure', variantFor(ObjectGroup.ADVENTURE_TREASURES, type, ground, exp));
  for (const type of [T.OBJ_RANDOM_ARTIFACT_TREASURE, T.OBJ_RANDOM_ARTIFACT_MINOR, T.OBJ_RANDOM_ARTIFACT_MAJOR]) add('artifact', variantFor(ObjectGroup.ADVENTURE_ARTIFACTS, type, ground, exp));
  // Dwellings and power-ups that fit the zone's ground (terrain art or neutral art).
  for (const info of findObjects({ group: ObjectGroup.ADVENTURE_DWELLINGS, terrain: ground, ...(exp ? {} : { expansion: false }) })) {
    if (info.actionCells.length > 0) add('dwelling', info);
  }
  for (const info of findObjects({ group: ObjectGroup.ADVENTURE_POWER_UPS, terrain: ground, ...(exp ? {} : { expansion: false }) })) {
    if (info.actionCells.length > 0) add('powerup', info);
  }
  const misc = [T.OBJ_WINDMILL, T.OBJ_WATER_WHEEL, T.OBJ_LEAN_TO, T.OBJ_MAGIC_GARDEN, T.OBJ_OBELISK, T.OBJ_HILL_FORT, T.OBJ_TRADING_POST, T.OBJ_WAGON, T.OBJ_SKELETON, T.OBJ_GRAVEYARD, T.OBJ_PYRAMID, T.OBJ_DAEMON_CAVE, T.OBJ_WITCHS_HUT, T.OBJ_FREEMANS_FOUNDRY, T.OBJ_OBSERVATION_TOWER];
  for (const type of misc) {
    const candidates = findObjects({ group: ObjectGroup.ADVENTURE_MISCELLANEOUS, type, terrain: ground }).filter((o) => exp || !o.expansion);
    if (candidates.length > 0) add(type === T.OBJ_GRAVEYARD || type === T.OBJ_PYRAMID || type === T.OBJ_DAEMON_CAVE ? 'treasure' : 'powerup', candidates[0] as ObjectInfo);
  }
  return pool;
}

const NECRO_OBJECTS: ReadonlySet<number> = new Set([objectTypes.OBJ_GRAVEYARD, objectTypes.OBJ_SKELETON, objectTypes.OBJ_CITY_OF_DEAD, objectTypes.OBJ_BARROW_MOUNDS]);
const NECRO_BOOST = 3;

// Relative share of each kind among guarded valuables (normalized by how many objects of the kind fit the zone).
const KIND_WEIGHTS: Record<string, number> = { treasure: 3, artifact: 2.5, dwelling: 1.5, powerup: 2.5 };

// Spends a zone's value budget on guarded valuables.
export function fillZone(ctx: ContentContext, zone: Zone, budget: number, anchor: number, guardMin = 25): void {
  const pool = valuablePool(ctx, zone);
  if (pool.length === 0) return;
  const kindCounts = new Map<string, number>();
  for (const v of pool) kindCounts.set(v.kind, (kindCounts.get(v.kind) ?? 0) + 1);
  let spent = 0;
  let failures = 0;
  // Keep each object type rare within a zone.
  const used = new Map<string, number>();
  while (spent < budget && failures < 12) {
    const remaining = budget - spent;
    const affordable = pool.filter((v) => v.value <= Math.max(remaining, 2000) && (used.get(`${v.group}/${v.index}`) ?? 0) < (v.kind === 'treasure' || v.kind === 'artifact' ? 4 : 1));
    if (affordable.length === 0) break;
    const v = ctx.rng.weighted(
      affordable,
      (x) => ((KIND_WEIGHTS[x.kind] ?? 1) / (kindCounts.get(x.kind) ?? 1)) * (x.boost ?? 1) * (x.kind === 'artifact' && x.value >= 10000 ? zone.distance + 0.1 : 1),
    );
    const placed = ctx.placeInZone(zone, v.group, v.index, { anchor, min: 3, max: 60, prefer: 6 + ctx.rng.next() * 20, margin: 2 });
    if (!placed) {
      ++failures;
      continue;
    }
    used.set(`${v.group}/${v.index}`, (used.get(`${v.group}/${v.index}`) ?? 0) + 1);
    spent += v.value;
    ctx.record({ uid: placed.uid, zone: zone.id, kind: v.kind, value: v.value, tile: placed.tile });
    restrictRandomArtifact(ctx, placed);
    // Cheap pickups and power-ups stay unguarded.
    if (v.value >= 2500 || v.kind === 'dwelling') ctx.guard(placed, zone, v.value, guardMin);
  }
}

// Unguarded small pickups (resources, chests, campfires, minor artifacts) scattered over a zone, denser near roads.
export function scatterPickups(ctx: ContentContext, zone: Zone, count: number): void {
  const ground = zone.ground === Ground.BEACH ? Ground.DESERT : zone.ground;
  const T = objectTypes;
  const options: { info: ObjectInfo; weight: number; kind: ContentKind }[] = [];
  for (const r of RESOURCE_NAMES) options.push({ info: getObjectInfo(ObjectGroup.ADVENTURE_TREASURES, resourcePickupIndex(r)), weight: r === 'gold' ? 2 : 1, kind: 'resource' });
  for (const [type, weight] of [
    [T.OBJ_RANDOM_RESOURCE, 3],
    [T.OBJ_TREASURE_CHEST, 3],
    [T.OBJ_CAMPFIRE, 2],
  ] as const) {
    const info = variantFor(ObjectGroup.ADVENTURE_TREASURES, type, ground, ctx.opts.expansion);
    if (info) options.push({ info, weight, kind: 'treasure' });
  }
  const minor = variantFor(ObjectGroup.ADVENTURE_ARTIFACTS, T.OBJ_RANDOM_ARTIFACT_TREASURE, ground, ctx.opts.expansion);
  if (minor) options.push({ info: minor, weight: 1 + zone.distance * 2, kind: 'artifact' });
  const g = ctx.grid;
  const tiles = ctx.rng.shuffle(zone.tiles.filter((t) => ctx.usable(t) && ctx.b.isFree(t) && ctx.b.reserved[t] === Reserve.NONE && (ctx.borderDist[t] as number) >= 2));
  let placed = 0;
  for (const t of tiles) {
    if (placed >= count) break;
    const o = ctx.rng.weighted(options, (x) => x.weight);
    const p = ctx.b.place(o.info.group, o.info.index, g.x(t), g.y(t));
    if (!p) continue;
    ctx.reserveApproach(p.tile, zone.seed);
    ctx.record({ uid: p.uid, zone: zone.id, kind: o.kind, value: objectValue(o.info), tile: p.tile });
    restrictRandomArtifact(ctx, p);
    ++placed;
  }
}

// Without the expansion, random artifacts may only become original-game artifacts.
function restrictRandomArtifact(ctx: ContentContext, placed: PlacedObject): void {
  if (ctx.opts.expansion || placed.group !== ObjectGroup.ADVENTURE_ARTIFACTS) return;
  const level = {
    [objectTypes.OBJ_RANDOM_ARTIFACT_TREASURE]: 'treasure',
    [objectTypes.OBJ_RANDOM_ARTIFACT_MINOR]: 'minor',
    [objectTypes.OBJ_RANDOM_ARTIFACT_MAJOR]: 'major',
  }[placed.info.objectType];
  if (!level) return;
  const meta = ctx.b.map.artifactMetadata.get(placed.uid);
  if (meta) meta.selected = artifacts.filter((a) => a.level === level && !a.expansion).map((a) => a.id);
}

// Small unguarded piles of resources around a point.
export function scatterResources(ctx: ContentContext, zone: Zone, anchor: number, kinds: readonly ResourceName[], min: number, max: number): void {
  for (const r of kinds) {
    const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_TREASURES, resourcePickupIndex(r), { anchor, min, max, margin: 2 });
    if (placed) ctx.record({ uid: placed.uid, zone: zone.id, kind: 'resource', value: 650, tile: placed.tile, resource: r });
  }
}

// --- Gates ---

// Strength of the monster at the gate of a walled-in team (fheroes2 army strength at normal difficulty).
const KEEPER_STRENGTH = 6000;

// A monster on each connection's gate: stronger between neutral zones deeper in the map.
export function guardGates(ctx: ContentContext): void {
  const g = ctx.grid;
  const seal = sealInfo(ctx);
  const place = (choice: ReturnType<typeof chooseGuard>, spots: readonly number[], keeper = false): boolean => {
    for (const s of spots) {
      if (ctx.b.isWater(s) || !ctx.usable(s)) continue;
      // Other guards never stand inside a walled zone; the keeper only on its gate or on the road behind it.
      if (seal.zones.has(ctx.layout.zoneOf[s] as number) && !seal.keeperGates.has(s) && !(keeper && ctx.b.reserved[s] === Reserve.ROAD)) continue;
      const placed = ctx.b.place(ObjectGroup.MONSTERS, monsterObjectIndex(choice.monster.id), g.x(s), g.y(s), {
        allowReserved: [Reserve.ROAD, Reserve.KEEP_CLEAR, Reserve.ACCESS],
        tag: 'gate-guard',
      });
      if (!placed) continue;
      const meta = ctx.b.map.monsterMetadata.get(placed.uid);
      if (meta) meta.count = choice.count;
      ctx.record({ uid: placed.uid, zone: (ctx.layout.zones[ctx.layout.zoneOf[s] as number] as Zone).id, kind: 'guard', value: 0, tile: s, guardOf: 0, strength: choice.strength });
      return true;
    }
    return false;
  };
  for (const c of ctx.layout.connections) {
    const za = ctx.layout.zones[c.a] as Zone;
    const zb = ctx.layout.zones[c.b] as Zone;
    if (c.keeper !== undefined) {
      // The single way into the walled-in team: one huge stack standing on the road on the walled side of the
      // gate, so the fight cannot be walked around.
      const gate = c.keeper === c.a ? c.gateA : c.gateB;
      const inward = g
        .around(gate)
        .filter((t) => ctx.layout.zoneOf[t] === c.keeper && ctx.b.reserved[t] === Reserve.ROAD && ctx.b.isFree(t) && !ctx.b.isWater(t))
        .sort((p, q) => g.euclid(p, gate) - g.euclid(q, gate) || p - q);
      const choice = chooseGuard(ctx.rng, KEEPER_STRENGTH * DIFFICULTY_FACTOR[ctx.opts.difficulty], 10);
      if (!place(choice, [gate, ...inward], true)) throw new GenerationError(`No room for the keeper of the walled team zone ${c.keeper}`);
      continue;
    }
    // Guard on the side of the zone farther from the starts.
    const [zone, gate] = za.distance >= zb.distance ? [za, c.gateA] : [zb, c.gateB];
    const value = 3500 + 5000 * Math.max(za.distance, zb.distance);
    const strength = guardStrength(value, zone.distance, ctx.opts.difficulty) * (za.kind === 'start' || zb.kind === 'start' ? 0.8 : 1.2);
    const choice = chooseGuard(ctx.rng, strength);
    // Use the gate tile or the nearest free tile on the corridor.
    const spots = [gate, ...g.around(gate, 2).sort((p, q) => g.euclid(p, gate) - g.euclid(q, gate) || p - q)];
    place(choice, spots);
  }
}

// Outside tiles that a hero could reach where the wall around the walled team is only one tile thick: an enterable
// outside tile within two steps of an enterable walled tile, with neither tile guarded by a monster yet. The keeper
// gates are the intended crossing and do not count.
export function thinWallSpots(ctx: ContentContext): number[] {
  const seal = sealInfo(ctx);
  if (seal.zones.size === 0) return [];
  const model = new MovementModel(ctx.b.map);
  const g = model.grid;
  const guarded = guardedTiles(model);
  const walled = (t: number) => seal.zones.has(ctx.layout.zoneOf[t] as number);
  const enterable = (t: number) => !model.water[t] && model.passability[t] !== 0;
  const spots = new Set<number>();
  for (const zid of seal.zones) {
    for (const t of (ctx.layout.zones[zid] as Zone).tiles) {
      if (!enterable(t) || guarded[t] || seal.keeperGates.has(t)) continue;
      for (const n of g.around(t, 2)) {
        if (!walled(n) && enterable(n) && !guarded[n] && model.actionAt[n] === -1) spots.add(n);
      }
    }
  }
  return [...spots].sort((a, b) => a - b);
}

// Backs the wall of the walled-in team with monsters as strong as its keeper wherever the wall is thin, so even a
// gap the movement model misses (or a hero that slips through a corner) runs into a fight no weaker than the gate.
// Each guard covers its own tile and its neighbors (zone of control); picks greedily the spot covering the most.
export function guardThinWalls(ctx: ContentContext): number {
  const g = ctx.grid;
  const seal = sealInfo(ctx);
  let placedCount = 0;
  for (let round = 0; round < 64; ++round) {
    const spots = thinWallSpots(ctx);
    if (spots.length === 0) break;
    const open = new Set(spots);
    const cover = (t: number) => (open.has(t) ? 1 : 0) + g.around(t).filter((n) => open.has(n)).length;
    // The spot itself, or an outside neighbor whose zone of control still covers it.
    const pool = new Set<number>();
    for (const s of spots) for (const t of [s, ...g.around(s)]) if (!seal.zones.has(ctx.layout.zoneOf[t] as number) && !ctx.b.isWater(t)) pool.add(t);
    const candidates = [...pool].filter((t) => ctx.b.isFree(t) && cover(t) > 0).sort((a, b) => cover(b) - cover(a) || a - b);
    const choice = chooseGuard(ctx.rng, KEEPER_STRENGTH * DIFFICULTY_FACTOR[ctx.opts.difficulty], 10);
    let placed = false;
    for (const s of candidates) {
      const p = ctx.b.place(ObjectGroup.MONSTERS, monsterObjectIndex(choice.monster.id), g.x(s), g.y(s), {
        allowReserved: [Reserve.ROAD, Reserve.KEEP_CLEAR, Reserve.ACCESS],
        tag: 'wall-guard',
      });
      if (!p) continue;
      const meta = ctx.b.map.monsterMetadata.get(p.uid);
      if (meta) meta.count = choice.count;
      ctx.record({ uid: p.uid, zone: (ctx.layout.zones[ctx.layout.zoneOf[s] as number] as Zone).id, kind: 'guard', value: 0, tile: s, guardOf: 0, strength: choice.strength });
      placed = true;
      ++placedCount;
      break;
    }
    if (!placed) break;
  }
  return placedCount;
}

// --- Boats ---

// Places boats on water next to the coast of a land region, near an anchor tile.
export function placeBoats(ctx: ContentContext, region: number, anchor: number, count: number, zoneId: number): number {
  const g = ctx.grid;
  const b = ctx.b;
  const boatIndex = firstIndexOfType(ObjectGroup.ADVENTURE_WATER, objectTypes.OBJ_BOAT);
  const candidates: { t: number; d: number }[] = [];
  for (let t = 0; t < g.size; ++t) {
    if (!b.isWater(t) || !b.isFree(t)) continue;
    // Water tile next to a free land tile of the region (where the hero boards) and open water around.
    let shore = false;
    let water = 0;
    for (const d of NEIGHBOR_DIRECTIONS) {
      const n = g.neighbor(t, d);
      if (n < 0) continue;
      if (b.isWater(n)) ++water;
      else if (ctx.region[n] === region && b.isFree(n) && (d === Direction.TOP || d === Direction.BOTTOM || d === Direction.LEFT || d === Direction.RIGHT)) shore = true;
    }
    if (shore && water >= 4) candidates.push({ t, d: g.euclid(t, anchor) });
  }
  candidates.sort((p, q) => p.d - q.d || p.t - q.t);
  let placed = 0;
  const used: number[] = [];
  for (const c of candidates) {
    if (placed >= count) break;
    if (used.some((u) => g.distance(u, c.t) < 3)) continue;
    const boat = b.place(ObjectGroup.ADVENTURE_WATER, boatIndex, g.x(c.t), g.y(c.t), { anyTerrain: true });
    if (!boat) continue;
    // Keep the boarding tile free.
    for (const d of NEIGHBOR_DIRECTIONS) {
      const n = g.neighbor(c.t, d);
      if (n >= 0 && !b.isWater(n) && ctx.region[n] === region && b.isFree(n)) b.reserve(n, Reserve.KEEP_CLEAR);
    }
    used.push(c.t);
    ctx.record({ uid: boat.uid, zone: zoneId, kind: 'boat', value: 0, tile: c.t });
    ++placed;
  }
  return placed;
}

// --- Helpers ---

export function zoneBorderDistance(grid: Grid, zoneOf: Int16Array): Int32Array {
  const seeds: number[] = [];
  for (let t = 0; t < grid.size; ++t) {
    const x = grid.x(t);
    const y = grid.y(t);
    if (x === 0 || y === 0 || x === grid.width - 1 || y === grid.width - 1) {
      seeds.push(t);
      continue;
    }
    for (const d of NEIGHBOR_DIRECTIONS) {
      const n = grid.neighbor(t, d);
      if (n >= 0 && zoneOf[n] !== zoneOf[t]) {
        seeds.push(t);
        break;
      }
    }
  }
  return grid.flood(seeds, () => true);
}

export function landRegions(b: MapBuilder): Int32Array {
  const g = b.grid;
  const region = new Int32Array(g.size).fill(-1);
  let next = 0;
  for (let t = 0; t < g.size; ++t) {
    if (region[t] !== -1 || b.isWater(t)) continue;
    const queue = [t];
    region[t] = next;
    for (let h = 0; h < queue.length; ++h) {
      const cur = queue[h] as number;
      for (const d of NEIGHBOR_DIRECTIONS) {
        const n = g.neighbor(cur, d);
        if (n >= 0 && region[n] === -1 && !b.isWater(n)) {
          region[n] = next;
          queue.push(n);
        }
      }
    }
    ++next;
  }
  return region;
}

