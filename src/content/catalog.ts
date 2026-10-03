// Object catalog for content placement: index lookups by role and terrain, and gold-equivalent values.
//
// Index helpers port fheroes2 code: getTownBasementId / getMineObjectInfoId (gui/ui_map_object.cpp), hero and flag
// sprite layout (populateKingdomHeroes / populateLandscapeFlags) and selectTerrainVariantForObject
// (map_random_generator_helper.cpp). Values extend fheroes2's objectGoldValue table
// (1500 gold = 1000 experience, 1 primary skill point = 2000 gold).

import { artifacts, objectTypes, resources } from '../data/enums.ts';
import { ObjectGroup } from '../fh2m/types.ts';
import { findObjects, fitsTerrain, getObjectInfo, objectsByGroup, type ObjectInfo } from '../objects.ts';
import { Ground } from '../terrain/ground.ts';

export const NEUTRAL_COLOR_INDEX = 6;
export const RANDOM_CASTLE_INDEX = 12;
export const RANDOM_TOWN_INDEX = 13;
export const RANDOM_RACE_HERO = 6;

export const RACE_NAMES = ['knight', 'barbarian', 'sorceress', 'warlock', 'wizard', 'necromancer'] as const;

export function townIndex(raceIndex: number, isCastle: boolean): number {
  if (raceIndex < 0 || raceIndex > 5) return isCastle ? RANDOM_CASTLE_INDEX : RANDOM_TOWN_INDEX;
  return raceIndex * 2 + (isCastle ? 0 : 1);
}

export function townBasementIndex(ground: Ground): number {
  const order: readonly Ground[] = [Ground.GRASS, Ground.SNOW, Ground.SWAMP, Ground.LAVA, Ground.DESERT, Ground.DIRT, Ground.WASTELAND, Ground.BEACH];
  return Math.max(0, order.indexOf(ground));
}

export function flagIndex(colorIndex: number, right: boolean): number {
  return colorIndex * 2 + (right ? 1 : 0);
}

// raceIndex 0..5 for a race, 6 for a random hero.
export function heroIndex(colorIndex: number, raceIndex: number): number {
  return colorIndex * 7 + Math.min(6, raceIndex);
}

const MINE_GROUND_ORDER = [Ground.WATER, Ground.GRASS, Ground.SNOW, Ground.SWAMP, Ground.LAVA, Ground.DESERT, Ground.DIRT, Ground.WASTELAND];

export type ResourceName = 'wood' | 'mercury' | 'ore' | 'sulfur' | 'crystal' | 'gems' | 'gold';
export const RESOURCE_NAMES: readonly ResourceName[] = ['wood', 'mercury', 'ore', 'sulfur', 'crystal', 'gems', 'gold'];
export const RESOURCE_IDS: Record<ResourceName, number> = {
  wood: resources.WOOD,
  mercury: resources.MERCURY,
  ore: resources.ORE,
  sulfur: resources.SULFUR,
  crystal: resources.CRYSTAL,
  gems: resources.GEMS,
  gold: resources.GOLD,
};

// Port of fheroes2::getMineObjectInfoId (ADVENTURE_MINES index).
export function mineIndex(resource: ResourceName, ground: Ground): number {
  const groundIndex = Math.max(0, MINE_GROUND_ORDER.indexOf(ground === Ground.BEACH ? Ground.WATER : ground));
  const sawmill = { [Ground.GRASS]: 0, [Ground.SNOW]: 1, [Ground.SWAMP]: 0, [Ground.LAVA]: 2, [Ground.DESERT]: 3, [Ground.DIRT]: 4, [Ground.WASTELAND]: 5, [Ground.BEACH]: 3 } as Record<number, number>;
  switch (resource) {
    case 'ore':
      return groundIndex * 5;
    case 'sulfur':
      return groundIndex * 5 + 1;
    case 'crystal':
      return groundIndex * 5 + 2;
    case 'gems':
      return groundIndex * 5 + 3;
    case 'gold':
      return groundIndex * 5 + 4;
    case 'wood':
      return 48 + (sawmill[ground] ?? 0);
    case 'mercury':
      return ground === Ground.SNOW ? 55 : 54;
  }
}

export function resourcePickupIndex(resource: ResourceName): number {
  const id = RESOURCE_IDS[resource];
  const found = objectsByGroup(ObjectGroup.ADVENTURE_TREASURES).find((o) => o.objectType === objectTypes.OBJ_RESOURCE && o.metadata[0] === id);
  if (!found) throw new Error(`No resource pickup for ${resource}`);
  return found.index;
}

export function monsterObjectIndex(monsterId: number): number {
  return monsterId - 1;
}

export function artifactObjectIndex(artifactId: number): number {
  const found = objectsByGroup(ObjectGroup.ADVENTURE_ARTIFACTS).find((o) => o.objectType === objectTypes.OBJ_ARTIFACT && o.metadata[0] === artifactId);
  if (!found) throw new Error(`No artifact object for artifact ${artifactId}`);
  return found.index;
}

export function firstIndexOfType(group: ObjectGroup, type: number): number {
  const found = objectsByGroup(group).find((o) => o.objectType === type);
  if (!found) throw new Error(`No object of type ${type} in group ${group}`);
  return found.index;
}

// Variant of an object type that fits the ground: art made for this ground first, then neutral art.
export function variantFor(group: ObjectGroup, type: number, ground: Ground, expansion: boolean): ObjectInfo | null {
  const all = findObjects({ group, type }).filter((o) => expansion || !o.expansion);
  const exact = all.filter((o) => o.terrains !== null && o.terrains.includes(ground) && fitsTerrain(o, ground));
  if (exact.length > 0) return exact[0] as ObjectInfo;
  const neutral = all.filter((o) => o.terrains === null && fitsTerrain(o, ground));
  return neutral[0] ?? null;
}

// Gold-equivalent value of visiting/owning an object.
const VALUES = new Map<number, number>([
  // Mines (per fheroes2; ore and wood are worth like a sawmill, gold like an abandoned mine).
  [objectTypes.OBJ_ALCHEMIST_LAB, 3500],
  [objectTypes.OBJ_MINE, 3500],
  [objectTypes.OBJ_SAWMILL, 1000],
  [objectTypes.OBJ_ABANDONED_MINE, 7500],
  // Pickups.
  [objectTypes.OBJ_CAMPFIRE, 1000],
  [objectTypes.OBJ_GENIE_LAMP, 7000],
  [objectTypes.OBJ_RANDOM_ARTIFACT, 4500],
  [objectTypes.OBJ_RANDOM_ARTIFACT_MAJOR, 10000],
  [objectTypes.OBJ_RANDOM_ARTIFACT_MINOR, 5000],
  [objectTypes.OBJ_RANDOM_ARTIFACT_TREASURE, 2000],
  [objectTypes.OBJ_RANDOM_RESOURCE, 650],
  [objectTypes.OBJ_RESOURCE, 650],
  [objectTypes.OBJ_TREASURE_CHEST, 1500],
  // Power-ups.
  [objectTypes.OBJ_FORT, 3000],
  [objectTypes.OBJ_GAZEBO, 2000],
  [objectTypes.OBJ_MERCENARY_CAMP, 3000],
  [objectTypes.OBJ_SHRINE_FIRST_CIRCLE, 1000],
  [objectTypes.OBJ_SHRINE_SECOND_CIRCLE, 2500],
  [objectTypes.OBJ_SHRINE_THIRD_CIRCLE, 4000],
  [objectTypes.OBJ_STANDING_STONES, 3000],
  [objectTypes.OBJ_TREE_OF_KNOWLEDGE, 5000],
  [objectTypes.OBJ_WITCH_DOCTORS_HUT, 3000],
  [objectTypes.OBJ_XANADU, 10000],
  [objectTypes.OBJ_FOUNTAIN, 600],
  [objectTypes.OBJ_MAGIC_WELL, 800],
  [objectTypes.OBJ_IDOL, 600],
  [objectTypes.OBJ_TEMPLE, 1200],
  [objectTypes.OBJ_FAERIE_RING, 600],
  [objectTypes.OBJ_OASIS, 800],
  [objectTypes.OBJ_WATERING_HOLE, 800],
  [objectTypes.OBJ_ARTESIAN_SPRING, 1500],
  [objectTypes.OBJ_ARENA, 3000],
  // Miscellaneous adventure objects.
  [objectTypes.OBJ_WINDMILL, 2000],
  [objectTypes.OBJ_WATER_WHEEL, 2000],
  [objectTypes.OBJ_LEAN_TO, 1000],
  [objectTypes.OBJ_MAGIC_GARDEN, 1500],
  [objectTypes.OBJ_OBELISK, 1000],
  [objectTypes.OBJ_OBSERVATION_TOWER, 500],
  [objectTypes.OBJ_HILL_FORT, 3000],
  [objectTypes.OBJ_ORACLE, 500],
  [objectTypes.OBJ_TRADING_POST, 1500],
  [objectTypes.OBJ_WAGON, 1500],
  [objectTypes.OBJ_SKELETON, 1500],
  [objectTypes.OBJ_GRAVEYARD, 6000],
  [objectTypes.OBJ_PYRAMID, 15000],
  [objectTypes.OBJ_DAEMON_CAVE, 6000],
  [objectTypes.OBJ_WITCHS_HUT, 2500],
  [objectTypes.OBJ_FREEMANS_FOUNDRY, 2000],
  [objectTypes.OBJ_SIGN, 0],
  [objectTypes.OBJ_LIGHTHOUSE, 500],
  [objectTypes.OBJ_TRAVELLER_TENT, 500],
  [objectTypes.OBJ_JAIL, 6000],
  [objectTypes.OBJ_SPHINX, 8000],
  // Dwellings.
  [objectTypes.OBJ_AIR_ALTAR, 5000],
  [objectTypes.OBJ_ARCHER_HOUSE, 2000],
  [objectTypes.OBJ_CAVE, 1500],
  [objectTypes.OBJ_DESERT_TENT, 3000],
  [objectTypes.OBJ_DWARF_COTTAGE, 2000],
  [objectTypes.OBJ_EARTH_ALTAR, 5000],
  [objectTypes.OBJ_EXCAVATION, 1500],
  [objectTypes.OBJ_FIRE_ALTAR, 5000],
  [objectTypes.OBJ_GOBLIN_HUT, 1500],
  [objectTypes.OBJ_HALFLING_HOLE, 1500],
  [objectTypes.OBJ_PEASANT_HUT, 650],
  [objectTypes.OBJ_RUINS, 5000],
  [objectTypes.OBJ_TREE_CITY, 1500],
  [objectTypes.OBJ_TREE_HOUSE, 1500],
  [objectTypes.OBJ_WAGON_CAMP, 2000],
  [objectTypes.OBJ_WATCH_TOWER, 2000],
  [objectTypes.OBJ_WATER_ALTAR, 5000],
  [objectTypes.OBJ_CITY_OF_DEAD, 6000],
  [objectTypes.OBJ_DRAGON_CITY, 12000],
  [objectTypes.OBJ_TROLL_BRIDGE, 6000],
  [objectTypes.OBJ_BARROW_MOUNDS, 3000],
]);

export function objectValue(info: ObjectInfo): number {
  if (info.objectType === objectTypes.OBJ_MINE || info.objectType === objectTypes.OBJ_SAWMILL) {
    // Mines store the resource in metadata[0].
    const r = info.metadata[0];
    if (r === resources.GOLD) return 7500;
    if (r === resources.WOOD || r === resources.ORE) return 1000;
    return 3500;
  }
  if (info.objectType === objectTypes.OBJ_ARTIFACT) {
    const a = artifacts.find((x) => x.id === info.metadata[0]);
    return { treasure: 2000, minor: 5000, major: 10000, ultimate: 30000, none: 6000 }[a?.level ?? 'none'];
  }
  return VALUES.get(info.objectType) ?? 1000;
}

export function valueOf(group: ObjectGroup, index: number): number {
  return objectValue(getObjectInfo(group, index));
}
