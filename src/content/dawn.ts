// The "dawn" scenario: The Long Night. Lord Malachar, a necromancer, has eight weeks of night to take Dawnspire, the
// cathedral city whose morning bell will burn the dead out of the world. English texts (ASCII, stored as latin1).
//
// The story turns on a fixed calendar: the economic tide swings between the living and the dead every week, a sleeping
// legion waits in a far tomb, a paladin of Dawnspire lies in chains, and the sun itself is the deadline.

// fheroes2 Skill::Secondary ids and Monster ids.
const NECROMANCY = 13;
const WISDOM = 8;
const LEADERSHIP = 7;
const LOGISTICS = 3;
export const BONE_DRAGON = 57;

export const DAWN_NAME = 'The Long Night';

// The loss condition: the end of the eighth week.
export const DAWN_DEADLINE_DAY = 56;

export const DAWN_DESCRIPTION =
  'The Pale Moon has risen and will stay for eight weeks. Lord Malachar, a necromancer, must take Dawnspire before ' +
  'the end of the eighth week: when its morning bell tolls, every dead thing in the world turns to dust. The tide of ' +
  'gold swings between the living and the dead each week, a sleeping legion waits in a far tomb, and a paladin of ' +
  'Dawnspire lies in chains, doubting his oath. Capture Dawnspire before the sun does.';

export const MALACHAR_HERO = 'Lord Malachar';
export const MALACHAR_CASTLE = 'Gravehold';
export const DAWNSPIRE = 'Dawnspire';

// Dawnspire's garrison: [monster id, count] x 5 (Crusader, Champion, Master Swordsman, Ranger).
export const DAWNSPIRE_GARRISON: readonly (readonly [number, number])[] = [
  [11, 20],
  [11, 20],
  [9, 30],
  [7, 50],
  [3, 60],
];

// Prisoners: the guaranteed Necromancy source, and the defector. Skills: [id, level 1-3].
export const GRAVEWARDEN: { name: string; race: 'necromancer' | 'knight'; skills: readonly (readonly [number, number])[] } = {
  name: 'Ilsa the Gravewarden',
  race: 'necromancer',
  skills: [
    [NECROMANCY, 2],
    [WISDOM, 1],
  ],
};

export const OATHBREAKER: { name: string; race: 'necromancer' | 'knight'; skills: readonly (readonly [number, number])[] } = {
  name: 'Sir Roderic the Oathbreaker',
  race: 'knight',
  skills: [
    [LEADERSHIP, 2],
    [LOGISTICS, 1],
  ],
};

export const HOME_SIGN = 'The Pale Moon is mine for eight weeks. Whatever the sun leaves standing, I will raise. - Malachar';

export const DAWN_SIGNS: readonly string[] = [
  'Eight weeks. Then the bell. Then nothing.',
  'Dawnspire stands in the farthest lands. A garrison of crusaders holds it, and they do not sleep.',
  'When the moon is full the dead prosper. When it is dark, the living.',
];

export const DAWN_RUMORS: readonly string[] = [
  'The Long Night lasts eight weeks. When the bell of Dawnspire tolls at the end of the eighth, every dead thing in the world turns to dust.',
  'Dawnspire stands alone in the farthest lands, held by crusaders who never sleep. Skeletons alone will not take it.',
  'A tomb far from the roads holds the Dead King\'s legion, still asleep. Whoever wakes it commands bone dragons.',
  'A paladin lies in chains for refusing to ring the bell. Free him, and he may break more than his oath.',
  'The tide of gold swings with the moon: the living fill their treasuries in the second, fourth and sixth weeks, the dead in the third, fifth and seventh.',
];

export const TOMB_MESSAGE =
  'The Dead King\'s tomb splits open. His legion rises from the stone and kneels to a new master. The Long Night has a king again.';

// The calendar. `side` picks who gets the windfall: the human (the dead) or the computers (the living).
export interface DawnEvent {
  day: number;
  side: 'dead' | 'living';
  message: string;
  // gold, wood/ore, and the four rare resources each.
  gold: number;
  common: number;
  rare: number;
}

export const DAWN_EVENTS: readonly DawnEvent[] = [
  {
    day: 1,
    side: 'dead',
    message:
      'The Pale Moon rises over Gravehold. The living call it the Long Night; you call it opportunity. Dawn comes at the end of the eighth week, and with it the bell of Dawnspire. Take the city first, or the sun will burn your dead from the world.',
    gold: 3000,
    common: 5,
    rare: 0,
  },
  {
    day: 14,
    side: 'living',
    message: 'The Sun Choir sings in Dawnspire. The living kingdoms hear it and open their treasuries: the first crusade musters.',
    gold: 12000,
    common: 10,
    rare: 4,
  },
  {
    day: 21,
    side: 'dead',
    message: 'The Harvest Moon. The graveyards of the old wars give up their dead freely tonight, and the coffers of the fallen fill.',
    gold: 9000,
    common: 10,
    rare: 5,
  },
  {
    day: 28,
    side: 'living',
    message: 'The Crusade. A relic of the Sun is carried to every living court. Banners rise and the treasuries overflow.',
    gold: 22000,
    common: 15,
    rare: 8,
  },
  {
    day: 35,
    side: 'dead',
    message: 'Eclipse. For one night the sun fails entirely. Tombs split, old debts come due, and tribute flows to the Pale Moon.',
    gold: 20000,
    common: 15,
    rare: 8,
  },
  {
    day: 42,
    side: 'living',
    message: 'The bell of Dawnspire tolls its first stroke ahead of time. Every living lord answers the call and the last reserves are spent.',
    gold: 28000,
    common: 20,
    rare: 10,
  },
  {
    day: 49,
    side: 'dead',
    message: 'The Last Week. The sky greys at the edge of the world. One week of night remains. Spend everything.',
    gold: 30000,
    common: 20,
    rare: 12,
  },
];
