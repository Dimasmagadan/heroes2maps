import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { artifacts, objectTypes } from '../src/data/enums.ts';
import { monsterInfo } from '../src/data/monsters.ts';
import { decodeMap } from '../src/fh2m/codec.ts';
import { ObjectGroup } from '../src/fh2m/types.ts';
import { DIRECTION_ALL, DIRECTION_BOTTOM_ROW, DIRECTION_CENTER_ROW } from '../src/grid.ts';
import { findObjects, getObjectInfo, hasObject, objectsByGroup } from '../src/objects.ts';
import { Ground } from '../src/terrain/ground.ts';

const dir = new URL('../fixtures/', import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.fh2m'));

describe('object table', () => {
  it('has the group sizes of fheroes2 1.1.17', () => {
    assert.equal(objectsByGroup(ObjectGroup.ROADS).length, 513);
    assert.equal(objectsByGroup(ObjectGroup.ADVENTURE_MINES).length, 56);
    assert.equal(objectsByGroup(ObjectGroup.KINGDOM_TOWNS).length, 14);
    assert.equal(objectsByGroup(ObjectGroup.KINGDOM_HEROES).length, 42);
    assert.equal(objectsByGroup(ObjectGroup.MONSTERS).length, 71);
  });

  it('describes a castle', () => {
    const castle = getObjectInfo(ObjectGroup.KINGDOM_TOWNS, 0);
    assert.equal(castle.typeName, 'CASTLE');
    assert.deepEqual(castle.metadata, [0, 1]); // knight, castle
    assert.ok(castle.isAction);
    assert.deepEqual(castle.actionCells, [{ dx: 0, dy: 0 }]);
    assert.equal(castle.entryDirections, DIRECTION_CENTER_ROW | DIRECTION_BOTTOM_ROW);
    assert.equal(castle.occupied.length, 8);
    assert.equal(castle.topParts.length, 8);
    assert.deepEqual(castle.bounds, { minX: -5, minY: -3, maxX: 2, maxY: 1 });
  });

  it('describes a mine with its resource and terrain', () => {
    const mine = getObjectInfo(ObjectGroup.ADVENTURE_MINES, 5); // ore mine, grass art
    assert.equal(mine.typeName, 'MINE');
    assert.equal(mine.metadata[0], 4); // Resource::ORE
    assert.deepEqual(mine.terrains, [Ground.GRASS]);
    assert.deepEqual(mine.actionCells, [{ dx: 0, dy: 0 }]);
    assert.equal(mine.blocked.length, 3);
  });

  it('describes a tree group as a blocking non-action object', () => {
    const tree = getObjectInfo(ObjectGroup.LANDSCAPE_TREES, 0);
    assert.equal(tree.typeName, 'TREES');
    assert.ok(!tree.isAction);
    assert.equal(tree.actionCells.length, 0);
    assert.equal(tree.occupied.length, 4);
    assert.equal(tree.blocked.length, 4);
  });

  it('finds action cells on the background layer', () => {
    const hole = findObjects({ type: 'WATERING_HOLE' })[0];
    assert.ok(hole);
    assert.ok(hole.actionCells.length > 0);
  });

  it('treats pickups as enterable from all directions', () => {
    const chest = findObjects({ type: objectTypes.OBJ_TREASURE_CHEST })[0];
    assert.ok(chest);
    assert.equal(chest.entryDirections, DIRECTION_ALL);
    assert.ok(chest.isPickup);
  });

  it('marks Price of Loyalty objects and artifacts', () => {
    const expansionTypes = new Set(findObjects({ expansion: true }).map((o) => o.typeName));
    for (const t of ['JAIL', 'BARRIER', 'TRAVELLER_TENT', 'ALCHEMIST_TOWER']) assert.ok(expansionTypes.has(t), t);
    assert.ok(!expansionTypes.has('MINE'));
    const pol = artifacts.filter((a) => a.expansion).map((a) => a.name);
    assert.ok(pol.includes('SPELL_SCROLL'));
    assert.ok(pol.includes('HEART_FIRE'));
    assert.ok(!pol.includes('GOLDEN_GOOSE'));
  });

  it('has artifact levels and monster strengths', () => {
    assert.equal(artifacts.find((a) => a.name === 'ULTIMATE_BOOK')?.level, 'ultimate');
    assert.equal(artifacts.find((a) => a.name === 'MEDAL_VALOR')?.level, 'treasure');
    assert.equal(artifacts.find((a) => a.name === 'MAGIC_BOOK')?.level, 'none');
    const dragon = monsterInfo.find((m) => m.name === 'Black Dragon');
    const peasant = monsterInfo.find((m) => m.name === 'Peasant');
    assert.ok(dragon && peasant && dragon.strength > 100 * peasant.strength);
  });

  it('queries objects by type and terrain', () => {
    const snowMines = findObjects({ group: ObjectGroup.ADVENTURE_MINES, terrain: Ground.SNOW });
    assert.ok(snowMines.length > 0);
    assert.ok(snowMines.every((o) => o.terrains === null || o.terrains.includes(Ground.SNOW)));
    assert.ok(findObjects({ terrain: Ground.WATER }).every((o) => o.water));
  });

  for (const file of fixtures) {
    it(`resolves every object of ${file}`, () => {
      const map = decodeMap(new Uint8Array(readFileSync(new URL(file, dir))));
      let count = 0;
      for (const tile of map.tiles) {
        for (const o of tile.objects) {
          assert.ok(hasObject(o.group, o.index), `group ${o.group} index ${o.index}`);
          assert.ok(getObjectInfo(o.group, o.index).groundParts.length > 0);
          ++count;
        }
      }
      assert.ok(count > 0);
    });
  }
});
