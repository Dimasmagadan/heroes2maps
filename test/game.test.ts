// Checks against the real game code. Skipped unless $FH2CHECK points to the fh2check tool
// (built with scripts/build-fh2check.sh against a debug build of fheroes2).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { decodeMap } from '../src/fh2m/codec.ts';
import { compareWithGame, findChecker, runGameCheck } from '../src/fh2check.ts';
import { generate } from '../src/generate.ts';

const checker = findChecker();
const dir = new URL('../fixtures/', import.meta.url);

describe('fheroes2 game check', { skip: checker === null ? 'FH2CHECK is not set' : false }, () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.fh2m'))) {
    it(`our movement model is never more permissive than the game on ${file}`, () => {
      const map = decodeMap(new Uint8Array(readFileSync(new URL(file, dir))));
      const result = runGameCheck(map, checker as string);
      assert.ok(result.ok, `${result.stage} ${result.error ?? ''}`);
      assert.deepEqual(compareWithGame(map, result), []);
    });
  }

  for (const options of [
    { seed: 101, size: 36, players: 3, water: 'medium', victory: 'capture-town' },
    { seed: 102, size: 72, players: 4, water: 'high', preset: 'islands' },
    { seed: 103, size: 108, players: 6, water: 'low', victory: 'artifact', expansion: true },
    { seed: 104, size: 144, players: 2, water: 'none', preset: 'wasteland', difficulty: 'expert' },
  ] as const) {
    it(`the game loads a generated ${options.size}x${options.size} map with ${options.players} players`, () => {
      const generated = generate(options);
      const result = runGameCheck(generated.map, checker as string);
      assert.ok(result.ok, `${result.stage} ${result.error ?? ''}`);
      assert.equal(result.kingdomsInfo?.length, options.players);
      for (const k of result.kingdomsInfo ?? []) {
        assert.equal(k.castles, 1, `color ${k.color} castles`);
        assert.equal(k.heroes, 1, `color ${k.color} heroes`);
      }
      assert.equal(result.humans, 1);
      assert.deepEqual(compareWithGame(generated.map, result), []);
    });
  }
});
