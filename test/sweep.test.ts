// Seed sweep over every map size and allowed player count. SWEEP_SEEDS sets the number of seeds per combination
// (default 1 to keep `npm test` fast); scripts/sweep.ts runs the full 100-seed sweep in parallel.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generate } from '../src/generate.ts';
import { MAP_SIZES, PLAYER_LIMITS, PRESETS, WATER_LEVELS } from '../src/options.ts';
import { validateMap } from '../src/validate.ts';

const seeds = Number(process.env['SWEEP_SEEDS'] ?? 1);

describe('seed sweep', () => {
  for (const size of MAP_SIZES) {
    const [min, max] = PLAYER_LIMITS[size];
    for (let players = min; players <= max; ++players) {
      it(`${size}x${size}, ${players} players, ${seeds} seed(s)`, () => {
        for (let seed = 1; seed <= seeds; ++seed) {
          const water = WATER_LEVELS[(seed + players) % WATER_LEVELS.length] as (typeof WATER_LEVELS)[number];
          const preset = PRESETS[(seed + size) % PRESETS.length] as (typeof PRESETS)[number];
          const result = generate({ seed: 7000 + seed, size, players, water, preset });
          const report = validateMap(result.map, { strictOverlaps: true });
          assert.deepEqual(report.errors, [], `seed ${7000 + seed} ${water} ${preset}`);
          assert.equal(report.starts.length, players);
        }
      });
    }
  }
});
