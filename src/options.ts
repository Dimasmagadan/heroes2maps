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

// Macro layout of the map (see "Templates" in the README). 'random' picks one per seed.
export const TEMPLATES = ['random', 'ring', 'hub', 'split', 'spine', 'rings'] as const;
export type MapTemplate = (typeof TEMPLATES)[number];
// The concrete layouts a seed can resolve to.
export const CONCRETE_TEMPLATES = ['ring', 'hub', 'split', 'spine', 'rings'] as const;
export type ConcreteTemplate = (typeof CONCRETE_TEMPLATES)[number];

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
  // Macro layout; 'random' resolves to a concrete template per seed (see Layout.template).
  template: MapTemplate;
  victory: VictoryCondition;
  race: Race;
  // Include The Price of Loyalty objects and artifacts.
  expansion: boolean;
  // Three teams (see playerTeams): the human alone, a middle team of computers, and a rich, walled-in team behind one
  // powerful guard. Needs at least 4 players.
  teams: boolean;
  // Mid-game twist: on day 21 the computers get a windfall (the Pale Tide); a guarded crypt far from the human's start
  // holds the counter (experience, resources, an artifact).
  twist: boolean;
  // Scenario: Koschei the Deathless against the heroes of the Russian tales (see content/tale). Russian texts, prisons with
  // friendly heroes, a place of power. Implies the necromancer race, the expansion and the twist.
  tale: boolean;
  // Scenario: The Dead Lands (see content/deadlands). Lord Corlagon, a necromancer, against the living kingdoms: the
  // blight spreads from his start, the richest living realm is walled in behind one keeper. Implies the necromancer
  // race, teams, the twist and the expansion. Needs 4+ players and size 72+.
  deadlands: boolean;
  // Scenario: The Long Night (see content/dawn). Lord Malachar, a necromancer, has eight weeks to capture Dawnspire before
  // the sun burns the dead out of the world (loss by time). The gold tide swings weekly between the living and the dead,
  // a sleeping legion waits in a far tomb, a paladin lies in chains. Implies the necromancer race and the expansion.
  // Needs 3+ players and size 72+.
  dawn: boolean;
  name?: string;
}

export const DEFAULT_OPTIONS: Omit<GeneratorOptions, 'seed'> = {
  size: 72,
  players: 2,
  water: 'low',
  difficulty: 'normal',
  preset: 'continent',
  template: 'random',
  victory: 'normal',
  race: 'random',
  expansion: false,
  teams: false,
  twist: false,
  tale: false,
  deadlands: false,
  dawn: false,
};

export function resolveOptions(partial: Partial<GeneratorOptions> & { seed: number }): GeneratorOptions {
  const options: GeneratorOptions = { ...DEFAULT_OPTIONS, ...partial };
  if (options.tale) Object.assign(options, { race: 'necromancer', expansion: true, twist: true });
  if (options.deadlands) Object.assign(options, { race: 'necromancer', teams: true, twist: true, expansion: true });
  if (options.dawn) Object.assign(options, { race: 'necromancer', expansion: true });
  validateOptions(options);
  return options;
}

// Team (1-3) of every player index. Team 1 is the human, team 3 the computers with the best start (1 computer for up
// to 3 computers, otherwise 2), team 2 the rest.
export function playerTeams(o: Pick<GeneratorOptions, 'players' | 'teams'>): number[] {
  if (!o.teams) return Array.from({ length: o.players }, (_, i) => i + 1);
  const computers = o.players - 1;
  const team3 = computers >= 4 ? 2 : 1;
  return Array.from({ length: o.players }, (_, i) => (i === 0 ? 1 : i <= computers - team3 ? 2 : 3));
}

export function validateOptions(o: GeneratorOptions): void {
  if (!Number.isInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff) throw new Error(`Invalid seed ${o.seed}: expected an integer in [0, 4294967295]`);
  if (!MAP_SIZES.includes(o.size)) throw new Error(`Invalid size ${o.size}: expected one of ${MAP_SIZES.join(', ')}`);
  const [min, max] = PLAYER_LIMITS[o.size];
  if (!Number.isInteger(o.players) || o.players < min || o.players > max) {
    throw new Error(`Invalid player count ${o.players} for size ${o.size}: expected ${min}-${max} (human included)`);
  }
  if (o.tale && o.size < 72) throw new Error('The tale needs room for its prisons and the place of power: use size 72 or more');
  if (o.deadlands && o.tale) throw new Error('The dead lands and the tale are different scenarios: choose one');
  if (o.deadlands && o.size < 72) throw new Error('The dead lands need room for the blight and the fodder fields: use size 72 or more');
  if (o.deadlands && o.players < 4) throw new Error('The dead lands pit the necromancer against the living kingdoms: use at least 4 players');
  if (o.deadlands && o.victory !== 'normal') throw new Error('The dead lands define their own victory condition (defeat the living side); do not combine --deadlands with --victory');
  if (o.dawn && (o.tale || o.deadlands)) throw new Error('The long night, the tale and the dead lands are different scenarios: choose one');
  if (o.dawn && o.size < 72) throw new Error('The long night needs room for Dawnspire, the tomb and the prisons: use size 72 or more');
  if (o.dawn && o.players < 3) throw new Error('The long night pits the necromancer against the living kingdoms: use at least 3 players');
  if (o.dawn && (o.victory !== 'normal' || o.teams || o.twist)) throw new Error('The long night defines its own victory, calendar and sides; do not combine --dawn with --victory, --teams or --twist');
  if (o.teams && o.players < 4) throw new Error(`Teams need at least 4 players (got ${o.players})`);
  if (o.teams && o.preset === 'islands') throw new Error('Teams are not available on the islands preset');
  if (o.teams && o.victory !== 'normal') throw new Error('Teams define their own victory condition (defeat the other side); do not combine --teams with --victory');
  if (!WATER_LEVELS.includes(o.water)) throw new Error(`Invalid water level ${o.water}: expected one of ${WATER_LEVELS.join(', ')}`);
  if (!DIFFICULTIES.includes(o.difficulty)) throw new Error(`Invalid difficulty ${o.difficulty}: expected one of ${DIFFICULTIES.join(', ')}`);
  if (!PRESETS.includes(o.preset)) throw new Error(`Invalid preset ${o.preset}: expected one of ${PRESETS.join(', ')}`);
  if (!TEMPLATES.includes(o.template)) throw new Error(`Invalid template ${o.template}: expected one of ${TEMPLATES.join(', ')}`);
  if (!VICTORY_CONDITIONS.includes(o.victory)) throw new Error(`Invalid victory condition ${o.victory}: expected one of ${VICTORY_CONDITIONS.join(', ')}`);
  if (!RACES.includes(o.race)) throw new Error(`Invalid race ${o.race}: expected one of ${RACES.join(', ')}`);
  if (o.name !== undefined && !o.tale && !/^[\x20-\x7e]*$/.test(o.name)) throw new Error('Map name must be printable ASCII');
}
