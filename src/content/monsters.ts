// Guard selection: picks a monster type and stack size whose total strength (fheroes2 Monster::GetMonsterStrength
// times count) matches a target derived from the guarded value.

import { monsterInfo, type MonsterInfo } from '../data/monsters.ts';
import type { Difficulty } from '../options.ts';
import type { Rng } from '../rng.ts';

export const DIFFICULTY_FACTOR: Record<Difficulty, number> = { easy: 0.6, normal: 1, hard: 1.4, expert: 1.9 };

// Monsters that are poor map guards (Ghosts multiply when attacking, Genies/Phoenixes are rare showpieces).
const EXCLUDED = new Set(['Ghost']);

export interface Guard {
  monster: MonsterInfo;
  count: number;
  strength: number;
}

// Target guard strength for something worth `value` gold, `distance` in [0, 1] from the nearest start.
export function guardStrength(value: number, distance: number, difficulty: Difficulty): number {
  return (value / 18) * DIFFICULTY_FACTOR[difficulty] * (0.75 + 0.75 * distance);
}

// Typical monster levels for a target strength: weak guards use low-level creatures in larger stacks.
function levelRange(strength: number): [number, number] {
  if (strength < 60) return [1, 2];
  if (strength < 160) return [1, 3];
  if (strength < 350) return [2, 4];
  if (strength < 800) return [3, 5];
  if (strength < 1800) return [4, 6];
  return [5, 6];
}

// `preferredCount` is the stack size the choice leans toward; necromancer maps use bigger stacks (more casualties to raise).
export function chooseGuard(rng: Rng, strength: number, preferredCount = 14): Guard {
  const [minLevel, maxLevel] = levelRange(strength);
  const scored: { m: MonsterInfo; count: number; weight: number }[] = [];
  for (const m of monsterInfo) {
    if (EXCLUDED.has(m.name) || m.level < minLevel || m.level > maxLevel) continue;
    const count = Math.round(strength / m.strength);
    if (count < 2 || count > 80) continue;
    // Prefer stacks of about 8-25 creatures.
    const weight = 1 / (1 + Math.abs(Math.log(count / preferredCount)));
    scored.push({ m, count, weight });
  }
  if (scored.length === 0) {
    // Fall back to the monster whose strength is closest to the target per creature.
    const sorted = [...monsterInfo].filter((m) => !EXCLUDED.has(m.name)).sort((a, b) => Math.abs(Math.log(strength / a.strength / 10)) - Math.abs(Math.log(strength / b.strength / 10)));
    const m = sorted[0] as MonsterInfo;
    const count = Math.max(1, Math.min(99, Math.round(strength / m.strength)));
    return { monster: m, count, strength: count * m.strength };
  }
  const pick = rng.weighted(scored, (s) => s.weight);
  return { monster: pick.m, count: pick.count, strength: pick.count * pick.m.strength };
}
