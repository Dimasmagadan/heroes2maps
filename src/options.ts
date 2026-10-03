// Generator options shared by the CLI and tests.

export const MAP_SIZES = [36, 72, 108, 144] as const;
export type MapSize = (typeof MAP_SIZES)[number];

// Total player count (human included) allowed per map size.
export const PLAYER_LIMITS: Record<MapSize, readonly [number, number]> = {
  36: [2, 3],
  72: [2, 4],
  108: [2, 6],
  144: [2, 6],
};

export const WATER_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type WaterLevel = (typeof WATER_LEVELS)[number];

export const DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const PRESETS = ['continent', 'lakes', 'islands', 'wasteland'] as const;
export type Preset = (typeof PRESETS)[number];

export const VICTORY_CONDITIONS = ['normal', 'capture-town', 'artifact'] as const;
export type VictoryCondition = (typeof VICTORY_CONDITIONS)[number];

// Human player's faction. Necromancer also tunes the map for a necromancy playthrough (see content/necromancer).
export const RACES = ['random', 'knight', 'barbarian', 'sorceress', 'warlock', 'wizard', 'necromancer'] as const;
export type Race = (typeof RACES)[number];

export interface GeneratorOptions {
  seed: number;
  size: MapSize;
  players: number; // total, human included
  water: WaterLevel;
  difficulty: Difficulty;
  preset: Preset;
  victory: VictoryCondition;
  race: Race;
  // Include The Price of Loyalty objects and artifacts.
  expansion: boolean;
  name?: string;
}

export const DEFAULT_OPTIONS: Omit<GeneratorOptions, 'seed'> = {
  size: 72,
  players: 2,
  water: 'low',
  difficulty: 'normal',
  preset: 'continent',
  victory: 'normal',
  race: 'random',
  expansion: false,
};

export function resolveOptions(partial: Partial<GeneratorOptions> & { seed: number }): GeneratorOptions {
  const options: GeneratorOptions = { ...DEFAULT_OPTIONS, ...partial };
  validateOptions(options);
  return options;
}

export function validateOptions(o: GeneratorOptions): void {
  if (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff) throw new Error(`Invalid seed ${o.seed}: expected an integer in [0, 4294967295]`);
  if (!MAP_SIZES.includes(o.size)) throw new Error(`Invalid size ${o.size}: expected one of ${MAP_SIZES.join(', ')}`);
  const [min, max] = PLAYER_LIMITS[o.size];
  if (!Number.isInteger(o.players) || o.players < min || o.players > max) {
    throw new Error(`Invalid player count ${o.players} for size ${o.size}: expected ${min}-${max} (human included)`);
  }
  if (!WATER_LEVELS.includes(o.water)) throw new Error(`Invalid water level ${o.water}: expected one of ${WATER_LEVELS.join(', ')}`);
  if (!DIFFICULTIES.includes(o.difficulty)) throw new Error(`Invalid difficulty ${o.difficulty}: expected one of ${DIFFICULTIES.join(', ')}`);
  if (!PRESETS.includes(o.preset)) throw new Error(`Invalid preset ${o.preset}: expected one of ${PRESETS.join(', ')}`);
  if (!VICTORY_CONDITIONS.includes(o.victory)) throw new Error(`Invalid victory condition ${o.victory}: expected one of ${VICTORY_CONDITIONS.join(', ')}`);
  if (!RACES.includes(o.race)) throw new Error(`Invalid race ${o.race}: expected one of ${RACES.join(', ')}`);
  if (o.name !== undefined && !/^[\x20-\x7e]*$/.test(o.name)) throw new Error('Map name must be printable ASCII');
}
