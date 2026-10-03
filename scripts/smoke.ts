// In-game smoke test helper (step 1b): proves fheroes2 accepts files written by our encoder.
//
// Usage: node scripts/smoke.ts [fixture.fh2m] [--dir <maps dir>]
//
// Decodes a fixture, renames it, paints a small lava square (with proper transitions) on the first area without
// objects, encodes it and writes "her2_smoke.fh2m" into the fheroes2 maps directory. Then open fheroes2: the map
// "her2 smoke test" must be listed, load, and show the lava square at the reported position.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeMap, encodeMap } from '../src/fh2m/codec.ts';
import { fheroes2MapsDir } from '../src/cli.ts';
import { Rng } from '../src/rng.ts';
import { Ground } from '../src/terrain/ground.ts';
import { TerrainEditor, findInvalidTransitions } from '../src/terrain/transitions.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' } } });
const fixture = positionals[0] ?? new URL('../fixtures/Tetra_conflict.fh2m', import.meta.url).pathname;
const map = decodeMap(new Uint8Array(readFileSync(fixture)));

// First 5x4 area (with a 1-tile margin) that has no objects, so painting does not strand any object.
const [w, h] = [5, 4];
let spot: [number, number] | null = null;
for (let y = 1; y + h < map.width - 1 && !spot; ++y) {
  for (let x = 1; x + w < map.width - 1 && !spot; ++x) {
    let clear = true;
    for (let yy = y - 1; yy <= y + h && clear; ++yy) for (let xx = x - 1; xx <= x + w && clear; ++xx) clear = map.tiles[yy * map.width + xx]?.objects.length === 0;
    if (clear) spot = [x, y];
  }
}
if (!spot) throw new Error('No free area to paint');
const [x0, y0] = spot;

map.name = 'her2 smoke test';
map.description = `Smoke test written by her2 from ${fixture.split('/').pop()}: a lava square was painted at ${x0},${y0}-${x0 + w - 1},${y0 + h - 1}.`;
const editor = new TerrainEditor(map, new Rng(1));
editor.setTerrainWithTransition(x0, y0, x0 + w - 1, y0 + h - 1, Ground.LAVA);
const invalid = findInvalidTransitions(map).length;
if (invalid > 0) throw new Error(`${invalid} invalid terrain transitions after painting`);

const dir = values.dir ?? fheroes2MapsDir();
mkdirSync(dir, { recursive: true });
const target = join(dir, 'her2_smoke.fh2m');
writeFileSync(target, encodeMap(map));
console.log(`Wrote ${target}\nOpen fheroes2 -> New Game -> Standard Game -> select "her2 smoke test" and look for the lava square at ${x0},${y0}.`);
