// The "tale" scenario: Koschei the Deathless (the human, a necromancer) abducted Marya Morevna; the heroes of the
// Russian tales ride against him. All texts are Russian. Map strings are raw bytes in the code page of the map
// language, so everything goes through `ru` (Unicode -> cp1251, one char per byte).

// fheroes2 Skill::Secondary ids.
const secondarySkills = { PATHFINDING: 1, LOGISTICS: 3, SCOUTING: 4, LEADERSHIP: 7, WISDOM: 8, NECROMANCY: 13 } as const;

export const RUSSIAN_LANGUAGE = 4; // fheroes2 SupportedLanguage::Russian

// Unicode text -> cp1251 bytes as latin1 characters. Throws on characters outside cp1251.
export function ru(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out += ch;
    else if (c >= 0x410 && c <= 0x44f) out += String.fromCharCode(c - 0x410 + 0xc0);
    else if (c === 0x401) out += String.fromCharCode(0xa8);
    else if (c === 0x451) out += String.fromCharCode(0xb8);
    else if (c === 0xab || c === 0xbb) out += String.fromCharCode(c);
    else if (c === 0x2014) out += String.fromCharCode(0x97);
    else if (c === 0x2116) out += String.fromCharCode(0xb9);
    else throw new Error(`Character ${JSON.stringify(ch)} is not in cp1251`);
  }
  return out;
}

export const TALE_NAME = 'Кощеево царство';

export const TALE_DESCRIPTION =
  'Кощей Бессмертный похитил Марью Моревну и унёс её в своё подземное царство. Против него поднялась вся Русь: ' +
  'Илья Муромец, Иван-царевич, Василиса Премудрая, Садко и Добрыня Никитич. Смерть Кощеева спрятана на острове Буяне: ' +
  'на дубе сундук, в сундуке заяц, в зайце утка, в утке яйцо, в яйце игла. Доберись до неё первым, а ещё поищи ' +
  'в темницах друзей: Баба-Яга, Змей Горыныч и Соловей-Разбойник давно ждут хозяина.';

// Human hero and castle.
export const KOSCHEI_HERO = 'Кощей Бессмертный';
export const KOSCHEI_CASTLE = 'Кощеево царство';

// Computer players: race index (see RACE_NAMES: knight 0, barbarian 1, sorceress 2, warlock 3, wizard 4) and hero.
export const TALE_RIVALS: readonly { race: number; hero: string; castle: string }[] = [
  { race: 1, hero: 'Илья Муромец', castle: 'Муром' },
  { race: 0, hero: 'Иван-царевич', castle: 'Киев-град' },
  { race: 2, hero: 'Василиса Премудрая', castle: 'Ростов Великий' },
  { race: 4, hero: 'Садко', castle: 'Новгород' },
  { race: 0, hero: 'Добрыня Никитич', castle: 'Владимир' },
];

export const TALE_NEUTRAL_TOWNS: readonly string[] = ['Китеж-град', 'Лукоморье', 'Тмутаракань', 'Синегорье', 'Белый Камень', 'Кудыкина гора'];

// Friendly heroes in prisons (race index as above, 5 = necromancer; skills: [id, level 1-3]).
export const TALE_PRISONERS: readonly { name: string; race: number; skills: readonly (readonly [number, number])[] }[] = [
  { name: 'Баба-Яга', race: 5, skills: [[secondarySkills.NECROMANCY, 2], [secondarySkills.WISDOM, 1]] },
  { name: 'Змей Горыныч', race: 3, skills: [[secondarySkills.LEADERSHIP, 2], [secondarySkills.LOGISTICS, 1]] },
  { name: 'Соловей-Разбойник', race: 1, skills: [[secondarySkills.SCOUTING, 2], [secondarySkills.PATHFINDING, 1]] },
];

export const TALE_RUMORS: readonly string[] = [
  'Сказывают, в подземном царстве Кощея томится красавица, краше которой нет на белом свете.',
  'Баба-Яга сидит в темнице, и коли выпустить её, она научит мёртвых служить живым.',
  'На Лысой горе ведьмы справляют шабаш: кто дойдёт до неё, вернётся сильнее.',
  'Богатыри собираются в дорогу: на третьей неделе придёт беда большая.',
];

export const TALE_SIGNS: readonly string[] = [
  'Прямо пойдёшь, коня потеряешь. Налево пойдёшь, богатым будешь. Направо пойдёшь, женатым будешь.',
  'Здесь русский дух, здесь Русью пахнет!',
  'Дорога дальняя, а сказка долгая.',
  'Не хвались, идучи на рать, а хвались, идучи с рати.',
];

export const MARYA_SIGN = 'Здесь, в высоком тереме, томится Марья Моревна. Кощей не отпустит её никогда.';

export const BUYAN_HINT_SIGN =
  'На острове Буяне стоит дуб, на дубе сундук, в сундуке заяц, в зайце утка, в утке яйцо, в яйце игла: смерть Кощеева. ' +
  'Успей добраться до неё, пока Серый волк не вывел богатырей на тот берег. Это случится на третьей неделе.';

export const POWER_PLACE_SIGN = 'Лысая гора. Здесь ведьмы справляют шабаш, и силу берёт тот, кто осмелится прийти.';

export const BUYAN_EVENT =
  'Ты добрался до дуба на острове Буяне. Сундук вскрыт, заяц, утка и яйцо в твоих руках. Иглу ты спрятал заново, ' +
  'а сила Кощеева бессмертия растёт, и казна полна.';

export const PALE_TIDE_EVENT = 'Серый волк указал богатырям дорогу к Буяну. Вся Русь поднимается на Кощея: казна полна, дружины растут.';

export const WEEKLY_CARAVAN = 'Купеческий обоз привёз брёвна и руду.';
