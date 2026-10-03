import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { emptyMap } from '../src/content/builder.ts';
import { decodeMap } from '../src/fh2m/codec.ts';
import { ObjectGroup } from '../src/fh2m/types.ts';
import { Rng } from '../src/rng.ts';
import { ALL_GROUNDS, Ground, groundByImageIndex, randomTerrainImageIndex, terrainShapeClass, terrainStartImageIndex } from '../src/terrain/ground.ts';
import { RoadEditor, findInvalidRoads } from '../src/terrain/roads.ts';
import { TerrainEditor, findInvalidTransitions } from '../src/terrain/transitions.ts';

const dir = new URL('../fixtures/', import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.fh2m'));

function snapshot(map: { tiles: { terrainIndex: number; terrainFlags: number }[] }): string {
  return map.tiles.map((t) => `${t.terrainIndex}/${t.terrainFlags}`).join(',');
}

describe('ground tileset', () => {
  it('maps image ranges to grounds', () => {
    for (const g of ALL_GROUNDS) assert.equal(groundByImageIndex(terrainStartImageIndex(g)), g);
    assert.equal(groundByImageIndex(431), Ground.BEACH);
  });

  it('picks random plain images of the requested ground', () => {
    const rng = new Rng(5);
    for (const g of ALL_GROUNDS) {
      for (let i = 0; i < 50; ++i) {
        const index = randomTerrainImageIndex(rng, g, true);
        assert.equal(groundByImageIndex(index), g);
        assert.match(terrainShapeClass(index), /plain$/);
      }
    }
  });
});

describe('terrain transitions', () => {
  for (const file of fixtures) {
    it(`agree with ${file} modulo tile variants`, () => {
      const map = decodeMap(new Uint8Array(readFileSync(new URL(file, dir))));
      assert.deepEqual(findInvalidTransitions(map), []);
    });
  }

  it('detects broken transitions', () => {
    const map = decodeMap(new Uint8Array(readFileSync(new URL('Lost_Temple.fh2m', dir))));
    const tile = map.tiles.find((t) => terrainShapeClass(t.terrainIndex).includes(':t'));
    assert.ok(tile);
    tile.terrainFlags ^= 1;
    assert.equal(findInvalidTransitions(map).length, 1);
  });

  it('produces valid and idempotent transitions for random ground layouts', () => {
    const rng = new Rng(42);
    for (let round = 0; round < 5; ++round) {
      const map = emptyMap(36);
      const editor = new TerrainEditor(map, rng);
      for (let i = 0; i < map.tiles.length; ++i) editor.setGround(i, Ground.WATER);
      // Random rectangles of random grounds, including single tiles and thin strips.
      for (let k = 0; k < 40; ++k) {
        const x = rng.int(36);
        const y = rng.int(36);
        editor.setTerrainWithTransition(x, y, Math.min(35, x + rng.int(6)), Math.min(35, y + rng.int(6)), rng.pick(ALL_GROUNDS));
      }
      editor.updateAllTransitions();
      assert.deepEqual(findInvalidTransitions(map), [], `round ${round}`);
      const before = snapshot(map);
      editor.updateAllTransitions();
      assert.equal(snapshot(map), before, 'second pass changes nothing');
    }
  });
});

describe('roads', () => {
  for (const file of fixtures) {
    it(`agree with ${file} modulo sprite variants`, () => {
      const map = decodeMap(new Uint8Array(readFileSync(new URL(file, dir))));
      assert.deepEqual(findInvalidRoads(map), []);
    });
  }

  it('builds connected road sprites and keeps them on update', () => {
    const map = emptyMap(16);
    const rng = new Rng(3);
    const terrain = new TerrainEditor(map, rng);
    for (let i = 0; i < map.tiles.length; ++i) terrain.setGround(i, Ground.GRASS);
    let uid = 0;
    const roads = new RoadEditor(map, rng, (tile, group, index) => map.tiles[tile]?.objects.push({ id: ++uid, group, index }));
    const path = [17, 18, 19, 35, 51, 52, 69, 86];
    for (const t of path) assert.ok(roads.setRoad(t));
    assert.deepEqual(findInvalidRoads(map), []);
    const before = JSON.stringify(map.tiles.map((t) => t.objects));
    roads.updateAllRoads();
    assert.equal(JSON.stringify(map.tiles.map((t) => t.objects)), before);
    assert.equal(map.tiles.flatMap((t) => t.objects).filter((o) => o.group === ObjectGroup.ROADS).length, path.length);
  });

  it('adds streams that connect orthogonally', () => {
    const map = emptyMap(12);
    const rng = new Rng(4);
    const terrain = new TerrainEditor(map, rng);
    for (let i = 0; i < map.tiles.length; ++i) terrain.setGround(i, Ground.GRASS);
    let uid = 0;
    const roads = new RoadEditor(map, rng, (tile, group, index) => map.tiles[tile]?.objects.push({ id: ++uid, group, index }));
    for (const t of [13, 25, 37, 38, 39]) assert.ok(roads.addStream(t));
    const index = (t: number) => map.tiles[t]?.objects.find((o) => o.group === ObjectGroup.STREAMS)?.index;
    assert.ok([3, 12].includes(index(25) as number), 'vertical');
    assert.equal(index(37), 4, 'from the top to the right');
    assert.ok([2, 5].includes(index(38) as number), 'horizontal');
  });
});
