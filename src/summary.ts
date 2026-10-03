// Map statistics: object counts by type, density, guard strength distribution and per-player resources.
// Works on any MapFormat (generated or decoded) so generated maps can be compared with hand-made ones.

import { monsterInfo } from './data/monsters.ts';
import { ObjectGroup, type MapFormat, type TileInfo } from './fh2m/types.ts';
import { Ground, groundByImageIndex } from './terrain/ground.ts';
import { MovementModel, isMonster } from './validate.ts';
import { categoryOf, type Category } from './preview/render.ts';

export interface MapStats {
  width: number;
  landTiles: number;
  waterFraction: number;
  // Fraction of land tiles blocked by objects (our conservative movement model).
  blockedFraction: number;
  // Action objects per 1000 land tiles.
  actionDensity: number;
  // Landscape objects (mountains, rocks, trees, misc) per 1000 land tiles.
  landscapeDensity: number;
  roads: number;
  streams: number;
  byCategory: Record<Category, number>;
  byType: Record<string, number>;
  monsters: number;
  // Total strength of monster stacks; stacks with a random count or type use the expected value of the game's roll.
  // randomCount: stacks of a known type with a random count; randomType: stacks of a random monster type.
  monsterStrength: { median: number; p90: number; max: number; randomCount: number; randomType: number };
}

const strengthById = new Map(monsterInfo.map((m) => [m.id, m.strength]));

// Expected size of a stack placed with count 0: fheroes2 rolls Rand::Get(R / 2, R) (Monster::GetRNDSize).
const RANDOM_SIZE_OUTLIERS: Record<string, number> = {
  Peasant: 80,
  Rogue: 40,
  Pikeman: 30,
  'Veteran Pikeman': 30,
  Wolf: 30,
  Elf: 30,
  'Grand Elf': 30,
  Gargoyle: 25,
  Ghost: 20,
  Medusa: 20,
  Minotaur: 16,
  'Minotaur King': 16,
  Roc: 16,
  Vampire: 16,
  'Vampire Lord': 16,
  Unicorn: 16,
  Cavalry: 18,
  Champion: 18,
  Paladin: 12,
  Crusader: 12,
  Cyclops: 12,
  Phoenix: 12,
};
const DEFAULT_RANDOM_SIZE = [0, 50, 30, 25, 25, 12, 8];

const RANDOM_TYPE_LEVEL: Record<string, number> = {
  RANDOM_MONSTER: 0,
  RANDOM_MONSTER_WEAK: 1,
  RANDOM_MONSTER_MEDIUM: 2,
  RANDOM_MONSTER_STRONG: 3,
  RANDOM_MONSTER_VERY_STRONG: 4,
};

// Expected strength of a stack of a random monster type (level 0 = any level) with `count` creatures (0 = random).
export function expectedRandomTypeStrength(level: number, count: number): number {
  const pool = monsterInfo.filter((m) => level === 0 || m.randomLevel === level);
  if (pool.length === 0) return 0;
  const sum = pool.reduce((acc, m) => acc + (count > 0 ? count : expectedRandomCount(m.id)) * m.strength, 0);
  return sum / pool.length;
}

export function expectedRandomCount(monsterId: number): number {
  const m = monsterInfo.find((x) => x.id === monsterId);
  if (!m) return 0;
  const r = RANDOM_SIZE_OUTLIERS[m.name] ?? DEFAULT_RANDOM_SIZE[m.level] ?? 0;
  return r > 1 ? r * 0.75 : 1;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

export function mapStats(map: MapFormat): MapStats {
  const model = new MovementModel(map);
  const size = map.width * map.width;
  let land = 0;
  let blocked = 0;
  let roads = 0;
  let streams = 0;
  let landscape = 0;
  for (let t = 0; t < size; ++t) {
    const tile = map.tiles[t] as TileInfo;
    if (groundByImageIndex(tile.terrainIndex) !== Ground.WATER) {
      ++land;
      if (model.blocked[t]) ++blocked;
    }
    for (const o of tile.objects) {
      if (o.group === ObjectGroup.ROADS) ++roads;
      else if (o.group === ObjectGroup.STREAMS) ++streams;
      else if (o.group >= ObjectGroup.LANDSCAPE_MOUNTAINS && o.group <= ObjectGroup.LANDSCAPE_MISCELLANEOUS) ++landscape;
    }
  }
  const byCategory: Record<Category, number> = { castle: 0, hero: 0, mine: 0, monster: 0, treasure: 0, artifact: 0, dwelling: 0, powerup: 0, other: 0 };
  const byType: Record<string, number> = {};
  const strengths: number[] = [];
  let randomCount = 0;
  let randomType = 0;
  let actions = 0;
  for (const o of model.objects) {
    if (!o.info.isAction) continue;
    ++actions;
    byCategory[categoryOf(o)] += 1;
    byType[o.info.typeName] = (byType[o.info.typeName] ?? 0) + 1;
    if (isMonster(o.info)) {
      const s = o.group === ObjectGroup.MONSTERS ? strengthById.get(o.index + 1) : undefined;
      if (s === undefined) {
        ++randomType;
        const level = RANDOM_TYPE_LEVEL[o.info.typeName];
        if (level !== undefined) strengths.push(expectedRandomTypeStrength(level, map.monsterMetadata.get(o.uid)?.count ?? 0));
        continue;
      }
      let count = map.monsterMetadata.get(o.uid)?.count ?? 0;
      if (count <= 0) {
        count = expectedRandomCount(o.index + 1);
        ++randomCount;
      }
      strengths.push(count * s);
    }
  }
  strengths.sort((a, b) => a - b);
  return {
    width: map.width,
    landTiles: land,
    waterFraction: 1 - land / size,
    blockedFraction: land ? blocked / land : 0,
    actionDensity: land ? (actions * 1000) / land : 0,
    landscapeDensity: land ? (landscape * 1000) / land : 0,
    roads,
    streams,
    byCategory,
    byType,
    monsters: byCategory.monster,
    monsterStrength: { median: quantile(strengths, 0.5), p90: quantile(strengths, 0.9), max: strengths[strengths.length - 1] ?? 0, randomCount, randomType },
  };
}

export function formatStats(s: MapStats): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `Size ${s.width}x${s.width}, land ${s.landTiles} tiles, water ${pct(s.waterFraction)}, blocked land ${pct(s.blockedFraction)}`,
    `Action objects ${s.actionDensity.toFixed(1)} per 1000 land tiles, landscape objects ${s.landscapeDensity.toFixed(1)} per 1000, roads ${s.roads}, streams ${s.streams}`,
    `By category: ${Object.entries(s.byCategory)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}`,
    `Monsters ${s.monsters}: strength median ${s.monsterStrength.median.toFixed(0)}, p90 ${s.monsterStrength.p90.toFixed(0)}, max ${s.monsterStrength.max.toFixed(0)}, random-count stacks ${s.monsterStrength.randomCount}, random-type stacks ${s.monsterStrength.randomType}`,
  ];
  return lines.join('\n');
}
