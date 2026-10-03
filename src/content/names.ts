// Themed map names, rumors, signs and riddles (ASCII only, stored as latin1 in the map).

import type { Rng } from '../rng.ts';
import { Ground } from '../terrain/ground.ts';

const ADJECTIVES = ['Shattered', 'Forgotten', 'Golden', 'Burning', 'Frozen', 'Silent', 'Whispering', 'Sunken', 'Broken', 'Twin', 'Hidden', 'Crimson', 'Emerald', 'Ashen', 'Wild', 'Lost'];
const NOUNS = ['Realms', 'Isles', 'Marches', 'Valleys', 'Crowns', 'Frontier', 'Kingdoms', 'Wastes', 'Shores', 'Heights', 'Dominion', 'Reaches', 'Lands', 'Thrones'];
const GROUND_WORDS: Partial<Record<Ground, readonly string[]>> = {
  [Ground.SNOW]: ['Frost', 'Winter', 'Ice'],
  [Ground.LAVA]: ['Fire', 'Ember', 'Cinder'],
  [Ground.DESERT]: ['Sand', 'Sun', 'Dune'],
  [Ground.SWAMP]: ['Mire', 'Fen', 'Bog'],
  [Ground.GRASS]: ['Green', 'Meadow', 'Spring'],
  [Ground.WASTELAND]: ['Dust', 'Ruin', 'Bone'],
  [Ground.DIRT]: ['Oak', 'Stone', 'Iron'],
};

export function mapName(rng: Rng, dominant: Ground): string {
  const words = GROUND_WORDS[dominant];
  if (words && rng.chance(0.5)) return `${rng.pick(words)} ${rng.pick(NOUNS)}`;
  return `The ${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)}`;
}

export const RUMORS: readonly string[] = [
  'They say a dragon sleeps where the roads end.',
  'A merchant swears the old mines still hold gold.',
  'Travelers speak of an artifact hidden in the heart of the land.',
  'The guards at the passes grow stronger every week.',
  'Some say the wise ones answer any question for a price.',
  'Watch the coast: boats are worth more than gold to those who know the sea.',
  'Peasants whisper of shrines that teach forgotten spells.',
];

export const SIGN_MESSAGES: readonly string[] = [
  'Welcome, traveler. Guard your mines well.',
  'Beyond the pass lie riches and danger in equal measure.',
  'The road ahead is long. Recruit wisely.',
  'Turn back, or seek glory in the wild lands.',
];

export const RIDDLES: readonly { riddle: string; answers: string[] }[] = [
  { riddle: 'I have keys but open no locks. I have space but no room. What am I?', answers: ['keyboard'] },
  { riddle: 'The more of me you take, the more you leave behind. What am I?', answers: ['footsteps', 'steps'] },
  { riddle: 'What has roots as nobody sees, is taller than trees, up, up it goes, and yet never grows?', answers: ['mountain', 'a mountain'] },
  { riddle: 'Voiceless it cries, wingless flutters, toothless bites, mouthless mutters. What is it?', answers: ['wind', 'the wind'] },
  { riddle: 'What can run but never walks, has a mouth but never talks?', answers: ['river', 'a river'] },
];
