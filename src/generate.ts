// Generation pipeline: options -> MapFormat.
//
//   layout (zones, connections) -> landscape (water, biomes) -> terrain images and transitions
//   -> castles and heroes -> mines, resources, valuables with guards -> roads -> gate guards -> boats
//   -> rivers -> zone border walls and decorations -> reachability repair -> players, victory, texts.
//
// All randomness comes from one Rng seeded with options.seed; each stage uses its own forked stream so changes
// in one stage do not reshuffle the others. A whole attempt is retried with a derived seed if a hard
// requirement (e.g. room for a castle) cannot be met; the attempt number is part of the result.

import { artifacts, objectTypes } from './data/enums.ts';
import { GenerationError } from './errors.ts';
import { ObjectGroup, type MapFormat } from './fh2m/types.ts';
import type { Layout, Zone } from './layout/zones.ts';
import { generateLayout } from './layout/zones.ts';
import { playerTeams, resolveOptions, type GeneratorOptions } from './options.ts';
import { Rng } from './rng.ts';
import { Ground, GROUND_NAMES } from './terrain/ground.ts';
import { generateLandscape, type Landscape } from './terrain/landscape.ts';
import { findInvalidTransitions } from './terrain/transitions.ts';
import { findObjects } from './objects.ts';
import { MapBuilder, Reserve } from './content/builder.ts';
import {
  ContentContext,
  fillZone,
  scatterPickups,
  guardGates,
  guardThinWalls,
  thinWallSpots,
  placeBoats,
  placeCastle,
  placeMine,
  placeStartingHero,
  scatterResources,
  type CastleSite,
} from './content/content.ts';
import { NEUTRAL_COLOR_INDEX, RACE_NAMES, artifactObjectIndex, firstIndexOfType, monsterObjectIndex, type ResourceName } from './content/catalog.ts';
import { blockedFraction, decorateIslandsAndSea, decorateZones, placeRivers, sealFromNeighbors, wallZoneBorders } from './content/decorate.ts';
import {
  BUYAN_EVENT,
  BUYAN_HINT_SIGN,
  KOSCHEI_CASTLE,
  KOSCHEI_HERO,
  MARYA_SIGN,
  PALE_TIDE_EVENT,
  POWER_PLACE_SIGN,
  RUSSIAN_LANGUAGE,
  TALE_DESCRIPTION,
  TALE_NAME,
  TALE_NEUTRAL_TOWNS,
  TALE_PRISONERS,
  TALE_RIVALS,
  TALE_RUMORS,
  TALE_SIGNS,
  WEEKLY_CARAVAN,
  ru,
} from './content/tale.ts';
import { PEASANT_RUMORS, RIDDLES, RUMORS, SIGN_MESSAGES, TWIST_RUMORS, mapName } from './content/names.ts';
import { repairReachability } from './content/repair.ts';
import { checkZoneSeal, dryWalledShores, reserveGateAprons, sealInfo } from './content/seal.ts';
import { routeRoads } from './content/roads.ts';
import { validateMap, type ValidationReport } from './validate.ts';

export interface GenerationResult {
  map: MapFormat;
  options: GeneratorOptions;
  layout: Layout;
  context: ContentContext;
  report: ValidationReport;
  attempt: number;
  stats: { removedDecorations: number; removedObjects: number; blockedFraction: number };
}

export { GenerationError };

const ZONE_BUDGET: Record<number, number> = { 36: 30000, 72: 36000, 108: 40000, 144: 42000 };
const RARE_RESOURCES: readonly ResourceName[] = ['mercury', 'sulfur', 'crystal', 'gems'];

export interface DebugOptions {
  skipRepair?: boolean;
  attempts?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export function generate(partial: Partial<GeneratorOptions> & { seed: number }, debug: DebugOptions = {}): GenerationResult {
  const options = resolveOptions(partial);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < (debug.attempts ?? 8); ++attempt) {
    try {
      return generateAttempt(options, attempt, debug);
    } catch (e) {
      if (!(e instanceof GenerationError)) throw e;
      debug.onRetry?.(attempt, e);
      lastError = e;
    }
  }
  throw new Error(`Could not generate a valid map for seed ${options.seed}: ${String(lastError)}`);
}

function generateAttempt(options: GeneratorOptions, attempt: number, debug: DebugOptions): GenerationResult {
  const root = new Rng((options.seed + Math.imul(attempt, 0x9e3779b1)) >>> 0);
  const layout = generateLayout(options, root.fork('layout'));
  const landscape = generateLandscape(layout, options, root.fork('landscape'));

  const b = new MapBuilder(options.size, root.fork('builder'));
  for (let t = 0; t < b.grid.size; ++t) b.terrain.setGround(t, landscape.ground[t] as Ground);
  b.terrain.updateAllTransitions();
  // The transition pass may have replaced corner grounds with water; the walled team's seal needs dry land there.
  dryWalledShores(b, layout, options);

  const ctx = new ContentContext(b, layout, options, root.fork('content'));
  chooseUsableRegions(ctx, layout, options);
  // Corridor tiles are kept free of obstacles — including the walled team's ring, where the corridor crosses it
  // through a slit — and outside the internal gates' halo, whose outside neighbors must stay sealable.
  const seal = sealInfo(ctx);
  const internalHalo = new Set<number>();
  for (const t of seal.internalGates) for (const n of ctx.grid.around(t)) internalHalo.add(n);
  const corridorTiles = new Set<number>();
  for (const line of landscape.corridors) for (const t of line) corridorTiles.add(t);
  // Seal the slits where a walled zone's corridor crosses its own border ring: the slit stays open for the team,
  // and its outside neighbors are walled now, before roads and content could take the space.
  for (const t of corridorTiles) {
    if (!seal.border.has(t) || !seal.zones.has(ctx.layout.zoneOf[t] as number)) continue;
    // The keeper gate itself is the guarded crossing: heroes are supposed to reach it from outside
    // (checkZoneSeal exempts it the same way); its outside neighbors carry the approach road.
    if (seal.keeperGates.has(t)) continue;
    if (!sealFromNeighbors(ctx, seal, t, corridorTiles)) throw new GenerationError(`Cannot seal the walled team corridor at ${ctx.grid.x(t)},${ctx.grid.y(t)}`);
  }
  for (const line of landscape.corridors) {
    for (const t of line) {
      if (b.isWater(t)) continue;
      if (internalHalo.has(t) && !seal.zones.has(ctx.layout.zoneOf[t] as number)) continue;
      b.reserve(t, Reserve.ROAD);
    }
  }

  // --- Players ---
  const startZones = layout.zones.filter((z) => z.kind === 'start').sort((a, c) => a.player - c.player);
  const castles: CastleSite[] = [];
  for (const zone of startZones) {
    // Only the human player (color 0) gets a fixed faction; the computer players stay random.
    const rival = options.tale && zone.player > 0 ? (TALE_RIVALS[(zone.player - 1) % TALE_RIVALS.length] as (typeof TALE_RIVALS)[number]) : null;
    const raceIndex = rival ? rival.race : zone.player === 0 && options.race !== 'random' ? RACE_NAMES.indexOf(options.race) : -1;
    const site = placeCastle(ctx, zone, zone.player, raceIndex, true);
    if (!site) throw new GenerationError(`No room for the castle of player ${zone.player}`);
    if (!placeStartingHero(ctx, site, zone.player, raceIndex)) throw new GenerationError(`No room for the hero of player ${zone.player}`);
    castles.push(site);
  }

  // --- Start zone kit: same for every player ---
  const kitRng = root.fork('kit');
  const rareCount = options.size <= 36 ? 1 : 2;
  const rares = kitRng.shuffle([...RARE_RESOURCES]).slice(0, rareCount);
  // Teams: team 1 (the human) starts poor, team 3 (walled in) starts rich, team 2 gets the standard kit.
  const teams = playerTeams(options);
  const START_QUALITY: Record<number, number> = { 1: 0.5, 2: 1, 3: 1.7 };
  for (const site of castles) {
    const zone = layout.zones[site.zone] as Zone;
    const entrance = site.tile + 2 * b.grid.width;
    const team = options.teams ? (teams[site.player] as number) : 2;
    for (const r of ['wood', 'ore'] as const) {
      if (!placeMine(ctx, zone, r, entrance, 4, 10, 1e9)) throw new GenerationError(`No room for the ${r} mine of player ${site.player}`);
    }
    for (const r of team === 3 ? RARE_RESOURCES : team === 1 ? rares.slice(0, 1) : rares) placeMine(ctx, zone, r, entrance, 7, 16, 40);
    if (team === 3) placeMine(ctx, zone, 'gold', entrance, 6, 14, 40);
    scatterResources(ctx, zone, entrance, team === 1 ? ['wood', 'ore'] : ['wood', 'ore', 'wood', 'ore'], 2, 7);
    fillZone(ctx, zone, ZONE_BUDGET[options.size]! * 0.45 * (START_QUALITY[team] as number) * sizeFactor(ctx, zone), entrance, 80);
  }

  // --- Neutral zones ---
  const neutral = layout.zones.filter((z) => z.kind !== 'start').sort((a, c) => a.distance - c.distance || a.id - c.id);
  const otherRares = RARE_RESOURCES.filter((r) => !rares.includes(r));
  let rareCursor = 0;
  const townRng = root.fork('towns');
  let neutralTowns = 0;
  const maxTowns = Math.max(1, Math.round(neutral.length / 3));
  for (const zone of neutral) {
    const anchor = zone.seed;
    if (!ctx.usable(anchor) && !zone.tiles.some((t) => ctx.usable(t))) continue;
    // Neutral towns: the center zone and some others.
    if ((zone.kind === 'center' || townRng.chance(0.35)) && neutralTowns < maxTowns) {
      if (placeCastle(ctx, zone, NEUTRAL_COLOR_INDEX, -1, townRng.chance(0.3))) ++neutralTowns;
    }
    // Mines: rotate through the rare resources not in the start kits, then any; gold further out.
    const mineCount = options.size <= 36 ? 1 : 2;
    for (let k = 0; k < mineCount; ++k) {
      const pool = otherRares.length > 0 && k === 0 ? otherRares : RARE_RESOURCES;
      const r = pool[rareCursor++ % pool.length] as ResourceName;
      placeMine(ctx, zone, r, anchor, 2, 30);
    }
    if (zone.distance >= 0.45 || zone.kind === 'center') placeMine(ctx, zone, 'gold', anchor, 2, 30);
    if (ctx.rng.chance(0.6)) placeMine(ctx, zone, ctx.rng.pick(['wood', 'ore'] as const), anchor, 2, 30);
    // Necromancer maps carry more guarded content: every fight raises more skeletons.
    const necroFactor = options.race === 'necromancer' ? 1.2 : 1;
    // The template can make a zone richer (the hub's center, the split's bridges, the inner ring of rings).
    const budget = ZONE_BUDGET[options.size]! * (0.7 + 1.5 * zone.distance) * (zone.kind === 'center' ? 1.4 : 1) * (zone.budgetScale ?? 1) * sizeFactor(ctx, zone) * necroFactor;
    fillZone(ctx, zone, budget, anchor);
  }

  // Teams: a field of peasants for the human to find (necromancy fodder against the huge guard of team 3).
  if (options.teams) placePeasantField(ctx, layout, castles, neutral);

  // The capture-town victory needs a neutral town: put one into the farthest zone that has room.
  if (options.victory === 'capture-town' && !ctx.castles.some((c) => c.player < 0)) {
    // Prefer neutral zones far from the starts, then computer players' zones (never the human's).
    const zones = [...[...neutral].reverse(), ...startZones.filter((z) => z.player > 0).reverse()];
    const placed = zones.some((zone) => placeCastle(ctx, zone, NEUTRAL_COLOR_INDEX, -1, true) !== null);
    if (!placed) throw new GenerationError('No room for the town of the capture-town victory condition');
  }

  // --- Unguarded pickups everywhere ---
  for (const zone of layout.zones) scatterPickups(ctx, zone, Math.round(zone.tiles.filter((t) => ctx.usable(t)).length / 36));

  // --- Special victory objects ---
  let victoryArtifact = 0;
  if (options.victory === 'artifact') {
    victoryArtifact = placeVictoryArtifact(ctx, layout);
    if (victoryArtifact === 0) throw new GenerationError('No room for the artifact of the artifact victory condition');
  }

  // The Spade of Necromancy (expansion): a guarded prize in a zone far from the human start.
  if (options.race === 'necromancer' && options.expansion) placeSpadeOfNecromancy(ctx, neutral);

  if (options.twist) placeCrypt(ctx, neutral, startZones);
  if (options.tale) {
    placeJails(ctx, neutral);
    placePowerPlace(ctx, neutral);
    placeHintSign(ctx, neutral, startZones);
  }

  // --- Roads, gates, boats ---
  reserveGateAprons(ctx);
  routeRoads(ctx);
  guardGates(ctx);
  placeBoatsWhereNeeded(ctx, layout, castles);

  // --- Landscape details ---
  placeRivers(ctx, { 36: 1, 72: 3, 108: 5, 144: 7 }[options.size] ?? 3);
  placeSigns(ctx, castles);
  if (!options.tale) placeSphinx(ctx, layout);
  wallZoneBorders(ctx);
  decorateZones(ctx, 0.56);
  decorateIslandsAndSea(ctx);

  // The walled team's seal gives the repair more work: longer paths through the keeper gate, more pockets.
  const repair = debug.skipRepair
    ? { report: validateMap(b.map, { strictOverlaps: true }), removedDecorations: 0, removedObjects: 0 }
    : repairReachability(ctx, options.teams ? 24 : 12);
  if (!repair.report.ok && !debug.skipRepair) throw new GenerationError(`Validation failed: ${repair.report.errors.slice(0, 3).join('; ')}`);

  // Back every thin stretch of the walled team's wall with a keeper-strength monster, then make sure the new
  // guards did not cut anything off.
  if (options.teams && guardThinWalls(ctx) > 0 && !debug.skipRepair) {
    const after = repairReachability(ctx, 12);
    if (!after.report.ok) throw new GenerationError(`Validation failed after wall guards: ${after.report.errors.slice(0, 3).join('; ')}`);
    repair.removedDecorations += after.removedDecorations;
    repair.removedObjects += after.removedObjects;
    repair.report = after.report;
  }

  for (const uid of ctx.required) if (!b.objects.has(uid)) throw new GenerationError('The repair removed a scenario object (a prison, the crypt or the place of power)');

  if (findInvalidTransitions(b.map).length > 0) throw new GenerationError('Invalid terrain transitions');

  // The walled-in team must be reachable only through its keeper gates (checks the finished map's movement model).
  const sealLeaks = checkZoneSeal(ctx);
  if (sealLeaks.length > 0) throw new GenerationError(`The walled team is not sealed: ${sealLeaks.slice(0, 3).join('; ')}`);
  const thin = thinWallSpots(ctx);
  if (thin.length > 0) throw new GenerationError(`The walled team's wall is thin and unguarded at ${thin.slice(0, 3).map((t) => `${ctx.grid.x(t)},${ctx.grid.y(t)}`).join('; ')}`);

  finishMetadata(ctx, options, landscape, victoryArtifact, root.fork('texts'));
  return {
    map: b.map,
    options,
    layout,
    context: ctx,
    report: repair.report,
    attempt,
    stats: { removedDecorations: repair.removedDecorations, removedObjects: repair.removedObjects, blockedFraction: blockedFraction(ctx) },
  };
}

// Budgets are tuned for zones of about 600 usable tiles; bigger zones get proportionally more content.
function sizeFactor(ctx: ContentContext, zone: Zone): number {
  const usable = zone.tiles.filter((t) => ctx.usable(t)).length;
  return Math.min(1.8, Math.max(0.5, usable / 600));
}

// Land regions that get content: the mainland with the starts, and for the islands preset every island big
// enough to be worth a trip (reached by boats).
function chooseUsableRegions(ctx: ContentContext, layout: Layout, options: GeneratorOptions): void {
  const sizes = new Map<number, number>();
  for (let t = 0; t < ctx.grid.size; ++t) {
    const r = ctx.region[t] as number;
    if (r >= 0) sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  for (const z of layout.zones) {
    if (z.kind === 'start') ctx.usableRegions.add(ctx.region[z.seed] as number);
  }
  if (options.preset === 'islands' || options.water === 'high') {
    for (const [r, size] of sizes) if (size >= 40) ctx.usableRegions.add(r);
  }
}

// Every usable land region with content must be reachable: regions without a start get reached by boat,
// so start regions get boats whenever other regions exist.
function placeBoatsWhereNeeded(ctx: ContentContext, layout: Layout, castles: readonly CastleSite[]): void {
  const startRegions = new Set(castles.map((c) => ctx.region[c.tile] as number));
  const others = [...ctx.usableRegions].filter((r) => !startRegions.has(r));
  if (others.length === 0) return;
  for (const c of castles) placeBoats(ctx, ctx.region[c.tile] as number, c.tile, 2, c.zone);
  // One boat on every other island so heroes can travel on from there.
  for (const r of others) {
    let anchor = -1;
    for (let t = 0; t < ctx.grid.size && anchor < 0; ++t) if (ctx.region[t] === r) anchor = t;
    const zone = layout.zoneOf[anchor] as number;
    placeBoats(ctx, r, anchor, 1, zone);
  }
}

// A crowd of weak, large peasant stacks in a hidden corner of a neutral zone two or more zones from the human's start.
// Beating them raises plenty of skeletons for a necromancer.
function placePeasantField(ctx: ContentContext, layout: Layout, castles: readonly CastleSite[], neutral: readonly Zone[]): void {
  const home = castles.find((c) => c.player === 0)?.zone;
  if (home === undefined) return;
  const steps = new Map<number, number>([[home, 0]]);
  for (let queue = [home]; queue.length > 0; ) {
    const cur = queue.shift() as number;
    for (const c of layout.connections) {
      const next = c.a === cur ? c.b : c.b === cur ? c.a : -1;
      if (next >= 0 && !steps.has(next)) {
        steps.set(next, (steps.get(cur) as number) + 1);
        queue.push(next);
      }
    }
  }
  const g = ctx.grid;
  const homeSeed = (layout.zones[home] as Zone).seed;
  const zones = neutral
    .filter((z) => (steps.get(z.id) ?? 0) >= 2 && z.tiles.some((t) => ctx.usable(t)))
    .sort((a, b) => (steps.get(a.id) as number) - (steps.get(b.id) as number) || g.euclid(a.seed, homeSeed) - g.euclid(b.seed, homeSeed) || a.id - b.id);
  for (const zone of zones) {
    // The hidden corner: the usable tile deepest inside the zone and farthest from its seed.
    const spots = zone.tiles.filter((t) => ctx.usable(t) && (ctx.borderDist[t] as number) >= 5);
    if (spots.length === 0) continue;
    const anchor = spots.reduce((best, t) => (g.euclid(t, zone.seed) > g.euclid(best, zone.seed) ? t : best));
    let placedCount = 0;
    for (let k = 0; k < 40 && placedCount < 12; ++k) {
      const p = ctx.placeInZone(zone, ObjectGroup.MONSTERS, monsterObjectIndex(1), { anchor, min: 0, max: 7, prefer: 3, margin: 3, tag: 'peasants' });
      if (!p) continue;
      const meta = ctx.b.map.monsterMetadata.get(p.uid);
      if (meta) meta.count = ctx.rng.range(150, 350);
      ctx.record({ uid: p.uid, zone: zone.id, kind: 'misc', value: 0, tile: p.tile });
      ++placedCount;
    }
    if (placedCount >= 6) return;
  }
  throw new GenerationError('No room for the field of peasants');
}

function placeSpadeOfNecromancy(ctx: ContentContext, neutral: readonly Zone[]): void {
  const spade = artifacts.find((a) => a.name === 'SPADE_NECROMANCY');
  if (!spade) return;
  const zones = [...neutral].filter((z) => z.distance >= 0.5).sort((a, b) => b.distance - a.distance || a.id - b.id);
  for (const zone of zones) {
    if (!zone.tiles.some((t) => ctx.usable(t))) continue;
    const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_ARTIFACTS, artifactObjectIndex(spade.id), { anchor: zone.seed, min: 0, max: 40, prefer: 4 });
    if (!placed) continue;
    ctx.record({ uid: placed.uid, zone: zone.id, kind: 'artifact', value: 8000, tile: placed.tile });
    ctx.guard(placed, zone, 8000);
    return;
  }
}

// The twist's counter: an event object (human only, once) in the neutral zone farthest from the human's start,
// behind a strong guard. Experience, rare resources and a major artifact.
function placeCrypt(ctx: ContentContext, neutral: readonly Zone[], startZones: readonly Zone[]): void {
  const home = startZones[0];
  const index = firstIndexOfType(ObjectGroup.ADVENTURE_MISCELLANEOUS, objectTypes.OBJ_EVENT);
  const pool = artifacts.filter((a) => a.level === 'major' && (ctx.opts.expansion || !a.expansion));
  const art = ctx.rng.pick(pool);
  const dist = (z: Zone) => (home ? ctx.grid.distance(home.seed, z.seed) : z.distance);
  const zones = [...neutral].sort((a, b) => dist(b) - dist(a) || a.id - b.id);
  for (const zone of zones) {
    if (!zone.tiles.some((t) => ctx.usable(t))) continue;
    const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_MISCELLANEOUS, index, { anchor: zone.seed, min: 0, max: 40, prefer: 4 });
    if (!placed) continue;
    const meta = ctx.b.map.adventureMapEventMetadata.get(placed.uid);
    if (meta) {
      meta.message = ctx.opts.tale ? ru(BUYAN_EVENT) : 'You wake the lich king\'s crypt. The dead bow to a living master and leave a hoard behind.';
      meta.humanPlayerColors = ctx.b.map.humanPlayerColors;
      meta.computerPlayerColors = 0;
      meta.artifact = art.id;
      meta.experience = 8000;
      meta.resources = { wood: 0, mercury: 8, ore: 0, sulfur: 8, crystal: 8, gems: 8, gold: 12000 };
    }
    ctx.required.add(placed.uid);
    ctx.record({ uid: placed.uid, zone: zone.id, kind: 'misc', value: 12000, tile: placed.tile });
    ctx.guard(placed, zone, 12000, 60);
    return;
  }
  throw new GenerationError('No room for the crypt of the twist option');
}

const SKILL_COUNT = 8;

function signIndexFor(ctx: ContentContext, tile: number): number {
  // Sign art per ground (ADVENTURE_MISCELLANEOUS 18-21), 22 is the generic one.
  return { [Ground.SNOW]: 18, [Ground.SWAMP]: 19, [Ground.LAVA]: 20, [Ground.DESERT]: 21 }[ctx.b.ground(tile) as number] ?? 22;
}

// Prisons with friendly heroes (the villains of the tales) in the middle and far neutral zones, each behind a guard.
function placeJails(ctx: ContentContext, neutral: readonly Zone[]): void {
  const index = firstIndexOfType(ObjectGroup.ADVENTURE_MISCELLANEOUS, objectTypes.OBJ_JAIL);
  const zones = [...neutral].filter((z) => z.distance >= 0.1).sort((a, b) => a.distance - b.distance || a.id - b.id);
  const step = Math.max(1, Math.floor(zones.length / TALE_PRISONERS.length));
  let next = 0;
  for (const prisoner of TALE_PRISONERS) {
    let placedHere = false;
    for (let k = 0; k < zones.length && !placedHere; ++k) {
      const zone = zones[(next + k) % zones.length] as Zone;
      if (!zone.tiles.some((t) => ctx.usable(t))) continue;
      const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_MISCELLANEOUS, index, { anchor: zone.seed, min: 3, max: 30 });
      if (!placed) continue;
      const meta = ctx.b.map.heroMetadata.get(placed.uid);
      if (meta) {
        meta.customName = ru(prisoner.name);
        meta.race = 1 << prisoner.race;
        meta.secondarySkill = new Array(SKILL_COUNT).fill(0).map((_, i) => prisoner.skills[i]?.[0] ?? 0);
        meta.secondarySkillLevel = new Array(SKILL_COUNT).fill(0).map((_, i) => prisoner.skills[i]?.[1] ?? 0);
      }
      ctx.required.add(placed.uid);
      ctx.record({ uid: placed.uid, zone: zone.id, kind: 'misc', value: 5000, tile: placed.tile });
      ctx.guard(placed, zone, 5000, 40);
      placedHere = true;
      next += step;
    }
    if (!placedHere) throw new GenerationError(`No room for the prison of ${prisoner.name}`);
  }
}

// The Bald Mountain: a place of power where the necromancer levels up. Tree of Knowledge, Arena, Gazebo and Baba
// Yaga's hut (a witch's hut teaching Wisdom), each behind a guard, with a sign naming the place.
function placePowerPlace(ctx: ContentContext, neutral: readonly Zone[]): void {
  const T = objectTypes;
  const pieces = [T.OBJ_TREE_OF_KNOWLEDGE, T.OBJ_ARENA, T.OBJ_GAZEBO, T.OBJ_WITCHS_HUT].map((type) => ({ type, info: findObjects({ type })[0] }));
  const zones = [...neutral].filter((z) => z.distance >= 0.1).sort((a, b) => b.tiles.length - a.tiles.length || a.id - b.id);
  for (const zone of zones) {
    const placedUids: number[] = [];
    let ok = true;
    for (const piece of pieces) {
      if (!piece.info) continue;
      const placed = ctx.placeInZone(zone, piece.info.group, piece.info.index, { anchor: zone.seed, min: 0, max: 20, prefer: 5 });
      if (!placed) {
        // The Tree of Knowledge is the heart of the place; the other pieces are best effort.
        if (piece.type === T.OBJ_TREE_OF_KNOWLEDGE) {
          ok = false;
          break;
        }
        continue;
      }
      placedUids.push(placed.uid);
      if (piece.type === T.OBJ_WITCHS_HUT) ctx.b.map.selectionObjectMetadata.set(placed.uid, { selectedItems: [8] });
      if (piece.type === T.OBJ_TREE_OF_KNOWLEDGE || piece.type === T.OBJ_WITCHS_HUT) ctx.required.add(placed.uid);
      ctx.record({ uid: placed.uid, zone: zone.id, kind: 'powerup', value: 4000, tile: placed.tile });
      ctx.guard(placed, zone, 4000, 40);
    }
    if (!ok) {
      for (const uid of placedUids) ctx.b.remove(uid);
      continue;
    }
    const sign = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_MISCELLANEOUS, signIndexFor(ctx, zone.seed), { anchor: zone.seed, min: 0, max: 14, prefer: 4 });
    if (sign) {
      const meta = ctx.b.map.signMetadata.get(sign.uid);
      if (meta) meta.message = ru(POWER_PLACE_SIGN);
      ctx.record({ uid: sign.uid, zone: zone.id, kind: 'misc', value: 0, tile: sign.tile });
    }
    return;
  }
  throw new GenerationError('No room for the place of power');
}

// The hint about the twist, on a sign far from the human's castle (but not in the crypt's own zone).
function placeHintSign(ctx: ContentContext, neutral: readonly Zone[], startZones: readonly Zone[]): void {
  const home = startZones[0];
  const crypt = ctx.records.find((r) => r.kind === 'misc' && r.value === 12000);
  const zones = [...neutral].filter((z) => z.id !== crypt?.zone && z.distance >= 0.3).sort((a, b) => (home ? ctx.grid.distance(home.seed, a.seed) - ctx.grid.distance(home.seed, b.seed) : 0) || a.id - b.id);
  for (const zone of zones) {
    const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_MISCELLANEOUS, signIndexFor(ctx, zone.seed), { anchor: zone.seed, min: 3, max: 24 });
    if (!placed) continue;
    const meta = ctx.b.map.signMetadata.get(placed.uid);
    if (meta) meta.message = ru(BUYAN_HINT_SIGN);
    ctx.required.add(placed.uid);
    ctx.record({ uid: placed.uid, zone: zone.id, kind: 'misc', value: 0, tile: placed.tile });
    return;
  }
  throw new GenerationError('No room for the hint sign');
}

function placeVictoryArtifact(ctx: ContentContext, layout: Layout): number {
  const candidates = artifacts.filter((a) => a.level === 'major' && (ctx.opts.expansion || !a.expansion));
  const art = ctx.rng.pick(candidates);
  // The farthest zone from the starts that has room for it.
  const zones = [...layout.zones].sort((a, b) => b.distance - a.distance || a.id - b.id);
  for (const zone of zones) {
    if (!zone.tiles.some((t) => ctx.usable(t))) continue;
    const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_ARTIFACTS, artifactObjectIndex(art.id), { anchor: zone.seed, min: 0, max: 40, prefer: 4 });
    if (!placed) continue;
    ctx.record({ uid: placed.uid, zone: zone.id, kind: 'artifact', value: 20000, tile: placed.tile });
    ctx.guard(placed, zone, 20000);
    return art.id;
  }
  return 0;
}

function placeSigns(ctx: ContentContext, castles: readonly CastleSite[]): void {
  const g = ctx.grid;
  for (const c of castles) {
    const zone = ctx.layout.zones[c.zone] as Zone;
    // Sign art per ground (ADVENTURE_MISCELLANEOUS 18-21), 22 is the generic one.
    const signIndex = { [Ground.SNOW]: 18, [Ground.SWAMP]: 19, [Ground.LAVA]: 20, [Ground.DESERT]: 21 }[ctx.b.ground(c.tile) as number] ?? 22;
    const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_MISCELLANEOUS, signIndex, { anchor: c.tile + 2 * g.width, min: 2, max: 5 });
    if (!placed) continue;
    const meta = ctx.b.map.signMetadata.get(placed.uid);
    if (meta) meta.message = ctx.opts.tale ? ru(c.player === 0 ? MARYA_SIGN : ctx.rng.pick(TALE_SIGNS)) : ctx.rng.pick(SIGN_MESSAGES);
    ctx.record({ uid: placed.uid, zone: zone.id, kind: 'misc', value: 0, tile: placed.tile });
  }
}

function placeSphinx(ctx: ContentContext, layout: Layout): void {
  const desert = layout.zones.filter((z) => z.kind !== 'start' && z.ground === Ground.DESERT);
  if (desert.length === 0) return;
  const zone = ctx.rng.pick(desert);
  const index = firstIndexOfType(ObjectGroup.ADVENTURE_MISCELLANEOUS, objectTypes.OBJ_SPHINX);
  const placed = ctx.placeInZone(zone, ObjectGroup.ADVENTURE_MISCELLANEOUS, index, { anchor: zone.seed, min: 2, max: 20 });
  if (!placed) return;
  const meta = ctx.b.map.sphinxMetadata.get(placed.uid);
  if (meta) {
    const r = ctx.rng.pick(RIDDLES);
    meta.riddle = r.riddle;
    meta.answers = [...r.answers];
    meta.resources = { wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 5, gold: 5000 };
  }
  ctx.record({ uid: placed.uid, zone: zone.id, kind: 'misc', value: 8000, tile: placed.tile });
}

function finishMetadata(ctx: ContentContext, options: GeneratorOptions, landscape: Landscape, victoryArtifact: number, rng: Rng): void {
  const map = ctx.b.map;
  let available = 0;
  for (let p = 0; p < options.players; ++p) available |= 1 << p;
  map.availablePlayerColors = available;
  map.humanPlayerColors = 1; // blue
  map.computerPlayerColors = available & ~1;
  // Random race for everyone except a human with a chosen faction.
  const humanRace = options.race === 'random' ? 128 : 1 << RACE_NAMES.indexOf(options.race);
  map.playerRace = [0, 0, 0, 0, 0, 0].map((_, i) => (i >= options.players ? 0 : i === 0 ? humanRace : options.tale ? 1 << (TALE_RIVALS[(i - 1) % TALE_RIVALS.length] as (typeof TALE_RIVALS)[number]).race : 128));
  map.difficulty = { easy: 0, normal: 1, hard: 2, expert: 3 }[options.difficulty];
  const teams = playerTeams(options);
  // Colors of each team as bitmasks; no alliances without the teams option. fheroes2 supports exactly two sides,
  // so the map expresses the human against all computers; the three-tier economy stays as map design.
  const teamMask = (t: number) => teams.reduce((mask, team, p) => (team === t ? mask | (1 << p) : mask), 0);
  map.alliances = options.teams ? [teamMask(1), teamMask(2) | teamMask(3)] : [];
  map.lossConditionType = 0;
  map.lossConditionMetadata = [];
  map.victoryConditionType = 0;
  map.victoryConditionMetadata = [];
  map.allowNormalVictory = false;
  map.isVictoryConditionApplicableForAI = false;

  if (options.victory === 'capture-town') {
    const towns = ctx.castles.filter((c) => c.player < 0).sort((a, b) => (ctx.layout.zones[b.zone] as Zone).distance - (ctx.layout.zones[a.zone] as Zone).distance || a.tile - b.tile);
    const town = towns[0];
    if (town) {
      map.victoryConditionType = 1;
      map.victoryConditionMetadata = [town.tile, 0];
      map.allowNormalVictory = true;
    }
  } else if (options.victory === 'artifact' && victoryArtifact > 0) {
    map.victoryConditionType = 3;
    map.victoryConditionMetadata = [victoryArtifact];
    map.allowNormalVictory = true;
  }

  // Teams: fheroes2 applies alliances only for the victory condition "defeat the other side" (type 4). The
  // computer side may win by defeating the human, and the normal victory (defeat everyone) also counts.
  if (options.teams) {
    map.victoryConditionType = 4;
    map.victoryConditionMetadata = [];
    map.allowNormalVictory = true;
    map.isVictoryConditionApplicableForAI = true;
  }

  // Dominant ground for the name.
  const counts = new Map<Ground, number>();
  for (const g of landscape.ground) if (g !== Ground.WATER) counts.set(g, (counts.get(g) ?? 0) + 1);
  const dominant = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? Ground.GRASS;
  map.name = options.tale ? ru(options.name ?? TALE_NAME).slice(0, 64) : (options.name ?? mapName(rng, dominant)).slice(0, 64);
  map.description =
    `Random map ${options.size}x${options.size}, ${options.players} players (1 human), ${options.water} water, ${options.difficulty}, ` +
    `${options.preset} preset, ${ctx.layout.template} layout, mostly ${GROUND_NAMES[dominant]}. Seed ${options.seed}.`;
  if (options.tale) {
    map.description = ru(TALE_DESCRIPTION);
    map.mainLanguage = RUSSIAN_LANGUAGE;
    nameTaleCharacters(ctx);
  }
  map.creatorNotes = `Generated by her2 (https://github.com/ihhub/fheroes2 format v13). Seed ${options.seed}, options ${JSON.stringify(options)}.`;

  map.rumors = rng.shuffle([...RUMORS]).slice(0, 3);
  if (options.teams) map.rumors.push(rng.pick(PEASANT_RUMORS));
  if (options.twist) map.rumors.push(rng.pick(TWIST_RUMORS));
  if (options.tale) map.rumors = TALE_RUMORS.map(ru);
  // A weekly caravan for everyone: a little wood and ore every 7 days from day 7.
  map.dailyEvents = [
    {
      message: options.tale ? ru(WEEKLY_CARAVAN) : 'A merchant caravan delivers building materials.',
      humanPlayerColors: map.humanPlayerColors,
      computerPlayerColors: map.computerPlayerColors,
      firstOccurrenceDay: 7,
      repeatPeriodInDays: 7,
      resources: { wood: 3, mercury: 0, ore: 3, sulfur: 0, crystal: 0, gems: 0, gold: 0 },
    },
  ];
  // The Pale Tide: on day 21 every computer player gets a windfall that turns the second half of the game.
  if (options.twist) {
    map.dailyEvents.push({
      message: options.tale ? ru(PALE_TIDE_EVENT) : 'A pale tide rolls over the land. The living arm themselves, and treasuries overflow.',
      humanPlayerColors: 0,
      computerPlayerColors: map.computerPlayerColors,
      firstOccurrenceDay: 21,
      repeatPeriodInDays: 0,
      resources: { wood: 20, mercury: 10, ore: 20, sulfur: 10, crystal: 10, gems: 10, gold: 25000 },
    });
  }
  // Team 3 starts rich: a treasury on day 1, then gold every week.
  if (options.teams) {
    const none = { wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 0 };
    map.dailyEvents.push(
      { message: 'The treasury of the fortress is full.', humanPlayerColors: 0, computerPlayerColors: teamMask(3), firstOccurrenceDay: 1, repeatPeriodInDays: 0, resources: { wood: 15, mercury: 6, ore: 15, sulfur: 6, crystal: 6, gems: 6, gold: 10000 } },
      { message: 'Taxes arrive from the fortress lands.', humanPlayerColors: 0, computerPlayerColors: teamMask(3), firstOccurrenceDay: 7, repeatPeriodInDays: 7, resources: { ...none, gold: 2500 } },
    );
  }
}


// Names of the castles and starting heroes: Koschei and the heroes of the tales.
function nameTaleCharacters(ctx: ContentContext): void {
  const map = ctx.b.map;
  let neutralTowns = 0;
  for (const r of ctx.records) {
    if (r.kind === 'castle') {
      const meta = map.castleMetadata.get(r.uid);
      if (!meta) continue;
      const name = r.player === undefined ? TALE_NEUTRAL_TOWNS[neutralTowns++ % TALE_NEUTRAL_TOWNS.length] : r.player === 0 ? KOSCHEI_CASTLE : TALE_RIVALS[(r.player - 1) % TALE_RIVALS.length]?.castle;
      if (name) meta.customName = ru(name);
    } else if (r.kind === 'hero' && r.player !== undefined) {
      const meta = map.heroMetadata.get(r.uid);
      const name = r.player === 0 ? KOSCHEI_HERO : TALE_RIVALS[(r.player - 1) % TALE_RIVALS.length]?.hero;
      if (meta && name) meta.customName = ru(name);
    }
  }
}
