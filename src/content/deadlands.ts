// The "dead lands" scenario: Lord Corlagon, a necromancer, has risen against the living kingdoms. English texts
// (ASCII, stored as latin1 like every non-tale map). The blight spreads from his start; the richest living realm
// sits walled behind one keeper gate; the fodder fields of peasants feed the skeleton host.

// fheroes2 Skill::Secondary ids.
const NECROMANCY = 13;
const WISDOM = 8;

export const DEADLANDS_NAME = 'The Dead Lands';

export const DEADLANDS_DESCRIPTION =
  'Lord Corlagon has risen from the grave to claim the living kingdoms. The blight follows his banner: dead land ' +
  'creeps out from Deadwood Keep while the last green realms muster behind their walls. Harvest the living in the ' +
  'far fields to raise a host of skeletons, free the imprisoned necromancer to master the craft, and break the one ' +
  'pass into the walled kingdom. Make haste: on the third week the royal treasuries arm the living.';

// Human hero and castle.
export const CORLAGON_HERO = 'Lord Corlagon';
export const CORLAGON_CASTLE = 'Deadwood Keep';

// The living kingdoms: computer players' castles and starting heroes (player index 1..), and the neutral towns.
export const LIVING_CASTLES: readonly string[] = ['Kingshold', 'Sunmarch', 'Rosewood', 'Goldenvale', 'Stormwatch'];
export const LIVING_HEROES: readonly string[] = ['King Aldric', 'Duke Roland', 'Sir Gareth', 'Lady Isolde', 'Abbot Conrad'];
export const DEADLANDS_TOWNS: readonly string[] = ['Marrowford', 'Hollowmere', 'Ravenhill', 'Gloamfield', 'Ashcross', 'Gravemarch'];

// The imprisoned necromancer near the human's start: the guaranteed source of the Necromancy skill, which no
// witch's hut teaches in fheroes2. Skills: [id, level 1-3].
export const DEADLANDS_PRISONER: { name: string; skills: readonly (readonly [number, number])[] } = {
  name: 'Morvath the Bonekeeper',
  skills: [
    [NECROMANCY, 2],
    [WISDOM, 1],
  ],
};

export const HOME_SIGN =
  'The grass dies where my shadow falls. Let the kingdoms of the living send their harvest to me. — Corlagon';

export const DEADLANDS_SIGNS: readonly string[] = [
  'Turn back, knight. The dead do not kneel, and the ground here does not forgive.',
  'Behind the wall lies the granary of the living. One pass leads in, and the King\'s Champion holds it.',
  'Harvest the living, and the harvest will follow you.',
];

export const DEADLANDS_RUMORS: readonly string[] = [
  'A great crowd of peasants wanders the far fields beyond any castle wall. A necromancer would know what to do with them.',
  'A necromancer rots in a cage not far from these lands. Free him, and he will teach the dead to serve.',
  'The living kingdoms hide their richest realm behind a wall of stone and thorn. One gate leads in, and a huge guard holds it.',
  'On the third week the royal treasuries arm the living. A crypt far from the roads holds a like gift for the dead.',
  'Graveyards are not resting places. To a patient master, they are armories.',
];

export const PALE_TIDE_DEADLANDS = 'The royal treasuries overflow: the living kingdoms arm themselves against the dead.';
export const TREASURY_DEADLANDS = 'The royal treasury of the living is full: the war against the dead is funded.';
export const TAXES_DEADLANDS = 'The living realms levy taxes to fund their army.';
