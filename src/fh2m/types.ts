// In-memory model of the fheroes2 .fh2m map format (version 13).
// Mirrors src/fheroes2/maps/map_format_info.h from fheroes2.

export const FORMAT_VERSION = 13;

// Order matters: values are stored in map files.
export const ObjectGroup = {
  NONE: 0,
  ROADS: 1,
  STREAMS: 2,
  LANDSCAPE_MOUNTAINS: 3,
  LANDSCAPE_ROCKS: 4,
  LANDSCAPE_TREES: 5,
  LANDSCAPE_WATER: 6,
  LANDSCAPE_MISCELLANEOUS: 7,
  LANDSCAPE_TOWN_BASEMENTS: 8,
  LANDSCAPE_FLAGS: 9,
  ADVENTURE_ARTIFACTS: 10,
  ADVENTURE_DWELLINGS: 11,
  ADVENTURE_MINES: 12,
  ADVENTURE_POWER_UPS: 13,
  ADVENTURE_TREASURES: 14,
  ADVENTURE_WATER: 15,
  ADVENTURE_MISCELLANEOUS: 16,
  KINGDOM_HEROES: 17,
  KINGDOM_TOWNS: 18,
  MONSTERS: 19,
  MAP_EXTRAS: 20,
} as const;
export type ObjectGroup = (typeof ObjectGroup)[keyof typeof ObjectGroup];

export interface TileObjectInfo {
  id: number; // uint32 object UID
  group: ObjectGroup;
  index: number; // uint32 index inside the group
}

export interface TileInfo {
  terrainIndex: number; // uint16
  terrainFlags: number; // uint8
  objects: TileObjectInfo[];
}

// Order of fields follows fheroes2 Funds serialization.
export interface Funds {
  wood: number;
  mercury: number;
  ore: number;
  sulfur: number;
  crystal: number;
  gems: number;
  gold: number;
}

export interface CastleMetadata {
  customName: string;
  defenderMonsterType: number[]; // 5 x int32
  defenderMonsterCount: number[]; // 5 x int32
  customBuildings: boolean;
  builtBuildings: number[];
  bannedBuildings: number[];
  mustHaveSpells: Map<number, number>; // uint8 -> int32
  bannedSpells: number[];
  availableToHireMonsterCount: number[]; // 6 x int32
}

export interface HeroMetadata {
  customName: string;
  customPortrait: number;
  armyMonsterType: number[]; // 5
  armyMonsterCount: number[]; // 5
  artifact: number[]; // 14
  artifactMetadata: number[]; // 14
  availableSpells: number[];
  isOnPatrol: boolean;
  patrolRadius: number;
  secondarySkill: number[]; // 8 x int8
  secondarySkillLevel: number[]; // 8 x uint8
  customLevel: number; // int16
  customExperience: number; // int32
  customAttack: number; // int16
  customDefense: number;
  customKnowledge: number;
  customSpellPower: number;
  magicPoints: number;
  race: number; // uint8
}

export interface SphinxMetadata {
  riddle: string;
  answers: string[];
  artifact: number;
  artifactMetadata: number;
  resources: Funds;
}

export interface SignMetadata {
  message: string;
}

export interface AdventureMapEventMetadata {
  message: string;
  humanPlayerColors: number;
  computerPlayerColors: number;
  isRecurringEvent: boolean;
  artifact: number;
  artifactMetadata: number;
  resources: Funds;
  attack: number;
  defense: number;
  knowledge: number;
  spellPower: number;
  experience: number;
  secondarySkill: number;
  secondarySkillLevel: number;
  monsterType: number;
  monsterCount: number;
}

export interface SelectionObjectMetadata {
  selectedItems: number[];
}

export interface CapturableObjectMetadata {
  ownerColor: number;
}

export interface MonsterMetadata {
  count: number;
  joinCondition: number;
  isWeeklyGrowthDisabled: boolean;
  selected: number[];
}

export interface ArtifactMetadata {
  radius: number;
  captureCondition: number;
  selected: number[];
}

export interface ResourceMetadata {
  count: number;
}

export interface DailyEvent {
  message: string;
  humanPlayerColors: number;
  computerPlayerColors: number;
  firstOccurrenceDay: number;
  repeatPeriodInDays: number;
  resources: Funds;
}

export interface TranslationSphinxMetadata {
  riddle: string;
  answers: string[];
}

export interface TranslationBaseMapMetadata {
  name: string;
  description: string;
  creatorNotes: string;
}

export interface TranslationFormat {
  dailyEvents: string[];
  rumors: string[];
  castleMetadata: Map<number, string>;
  heroMetadata: Map<number, string>;
  sphinxMetadata: Map<number, TranslationSphinxMetadata>;
  signMetadata: Map<number, string>;
  adventureMapEventMetadata: Map<number, string>;
}

export interface BaseMapFormat {
  version: number;
  isCampaign: boolean;
  difficulty: number; // 0 easy, 1 normal, 2 hard, 3 expert
  availablePlayerColors: number; // bitmask
  humanPlayerColors: number;
  computerPlayerColors: number;
  alliances: number[]; // bitmasks
  playerRace: number[]; // 6
  victoryConditionType: number;
  isVictoryConditionApplicableForAI: boolean;
  allowNormalVictory: boolean;
  victoryConditionMetadata: number[];
  lossConditionType: number;
  lossConditionMetadata: number[];
  width: number; // maps are square
  mainLanguage: number; // uint8 SupportedLanguage
  name: string;
  description: string;
  creatorNotes: string;
  translations: Map<number, TranslationBaseMapMetadata>;
}

export interface MapFormat extends BaseMapFormat {
  additionalInfo: number[];
  tiles: TileInfo[]; // width * width, row-major
  dailyEvents: DailyEvent[];
  rumors: string[];
  castleMetadata: Map<number, CastleMetadata>;
  heroMetadata: Map<number, HeroMetadata>;
  sphinxMetadata: Map<number, SphinxMetadata>;
  signMetadata: Map<number, SignMetadata>;
  adventureMapEventMetadata: Map<number, AdventureMapEventMetadata>;
  selectionObjectMetadata: Map<number, SelectionObjectMetadata>;
  capturableObjectsMetadata: Map<number, CapturableObjectMetadata>;
  monsterMetadata: Map<number, MonsterMetadata>;
  artifactMetadata: Map<number, ArtifactMetadata>;
  resourceMetadata: Map<number, ResourceMetadata>;
  translationInfo: Map<number, TranslationFormat>;
}
