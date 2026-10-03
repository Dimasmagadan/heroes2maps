import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MapBuilder, Reserve } from '../src/content/builder.ts';
import { flagIndex, heroIndex, mineIndex, townBasementIndex } from '../src/content/catalog.ts';
import { objectTypes } from '../src/data/enums.ts';
import { ObjectGroup } from '../src/fh2m/types.ts';
import { findObjects } from '../src/objects.ts';
import { Rng } from '../src/rng.ts';
import { Ground } from '../src/terrain/ground.ts';
import { MovementModel, reach, validateMap } from '../src/validate.ts';

// A 36x36 grass map, optionally with water where `water(x, y)` is true, and a blue hero at (5, 5).
function makeBuilder(water: (x: number, y: number) => boolean = () => false): MapBuilder {
  const b = new MapBuilder(36, new Rng(1));
  for (let t = 0; t < b.grid.size; ++t) b.terrain.setGround(t, water(b.grid.x(t), b.grid.y(t)) ? Ground.WATER : Ground.GRASS);
  b.terrain.updateAllTransitions();
  assert.ok(b.place(ObjectGroup.KINGDOM_HEROES, heroIndex(0, 0), 5, 5));
  return b;
}

const TREE_1x1 = findObjects({ group: ObjectGroup.LANDSCAPE_TREES, terrain: Ground.GRASS }).find((o) => o.occupied.length === 1 && o.occupied[0]?.dx === 0 && o.occupied[0]?.dy === 0);
const BOAT = findObjects({ group: ObjectGroup.ADVENTURE_WATER, type: objectTypes.OBJ_BOAT })[0];

describe('validator', () => {
  it('accepts reachable objects', () => {
    const b = makeBuilder();
    assert.ok(b.place(ObjectGroup.ADVENTURE_MINES, mineIndex('ore', Ground.GRASS), 20, 20));
    const report = validateMap(b.map, { strictOverlaps: true });
    assert.deepEqual(report.errors, []);
    assert.equal(report.starts.length, 1);
  });

  it('rejects an object walled in by obstacles', () => {
    assert.ok(TREE_1x1);
    const b = makeBuilder();
    const chest = findObjects({ type: objectTypes.OBJ_TREASURE_CHEST })[0];
    assert.ok(chest);
    assert.ok(b.place(chest.group, chest.index, 20, 20));
    for (const n of b.grid.around(b.grid.index(20, 20))) assert.ok(b.place(TREE_1x1.group, TREE_1x1.index, b.grid.x(n), b.grid.y(n)));
    const report = validateMap(b.map);
    assert.equal(report.ok, false);
    assert.match(report.errors[0] ?? '', /TREASURE_CHEST .* unreachable/);
  });

  it('does not walk diagonally past a tall object', () => {
    assert.ok(TREE_1x1);
    const b = makeBuilder();
    // Open diagonal gap between (10,10) and (11,9): the side tile (11,10) has a tree, the other corner (10,9) too.
    for (const [x, y] of [
      [11, 10],
      [10, 9],
    ] as const)
      assert.ok(b.place(TREE_1x1.group, TREE_1x1.index, x, y));
    const model = new MovementModel(b.map);
    assert.equal(model.canMove(b.grid.index(10, 10), 0x0004 /* TOP_RIGHT */, false), -1);
  });

  it('enters buildings only from the sides and below', () => {
    const b = makeBuilder();
    const mine = b.place(ObjectGroup.ADVENTURE_MINES, mineIndex('ore', Ground.GRASS), 20, 20);
    assert.ok(mine);
    const model = new MovementModel(b.map);
    const g = b.grid;
    assert.equal(model.canMove(g.index(20, 21), 0x0002 /* TOP */, false), g.index(20, 20));
    assert.equal(model.canMove(g.index(20, 19), 0x0020 /* BOTTOM */, false), -1);
  });

  it('requires a boat to reach another island', () => {
    assert.ok(BOAT);
    // Water column at x = 15..20 splits the map.
    const b = makeBuilder((x) => x >= 15 && x <= 20);
    const chest = findObjects({ type: objectTypes.OBJ_TREASURE_CHEST })[0];
    assert.ok(chest && b.place(chest.group, chest.index, 28, 10));
    assert.equal(validateMap(b.map).ok, false, 'no boat');
    assert.ok(b.place(BOAT.group, BOAT.index, 15, 6, { anyTerrain: true }));
    const report = validateMap(b.map);
    assert.deepEqual(report.errors, [], 'with a boat on the near shore');
    const r = reach(new MovementModel(b.map), [b.grid.index(5, 5)]);
    assert.equal(r.water[b.grid.index(18, 6)], 1);
  });

  it('checks castle entrances and overlaps', () => {
    const b = makeBuilder();
    const uid = b.newUid();
    const basement = townBasementIndex(Ground.GRASS);
    b.forcePlace(ObjectGroup.LANDSCAPE_TOWN_BASEMENTS, basement, 20, 20, {}, uid);
    b.forcePlace(ObjectGroup.KINGDOM_TOWNS, 0, 20, 20, { noAccess: true }, uid);
    b.addObject(b.grid.index(19, 20), ObjectGroup.LANDSCAPE_FLAGS, flagIndex(6, false), uid);
    b.addObject(b.grid.index(21, 20), ObjectGroup.LANDSCAPE_FLAGS, flagIndex(6, true), uid);
    assert.deepEqual(validateMap(b.map, { strictOverlaps: true }).errors, []);
    // Close the entrance and its approaches.
    assert.ok(TREE_1x1);
    for (const [x, y] of [
      [19, 21],
      [20, 21],
      [21, 21],
    ] as const)
      b.forcePlace(TREE_1x1.group, TREE_1x1.index, x, y);
    const report = validateMap(b.map, { strictOverlaps: true });
    assert.ok(report.errors.some((e) => e.includes('no open entrance')));
    assert.ok(report.errors.some((e) => e.includes('overlap')));
  });
});

describe('placement engine', () => {
  it('rejects overlaps, water and reserved tiles', () => {
    const b = makeBuilder((x) => x > 30);
    const index = mineIndex('ore', Ground.GRASS);
    assert.ok(b.place(ObjectGroup.ADVENTURE_MINES, index, 10, 10));
    assert.equal(b.place(ObjectGroup.ADVENTURE_MINES, index, 11, 10), null, 'overlap');
    assert.equal(b.place(ObjectGroup.ADVENTURE_MINES, index, 31, 10), null, 'water');
    b.reserve(b.grid.index(20, 20), Reserve.ROAD);
    assert.equal(b.place(ObjectGroup.ADVENTURE_MINES, index, 20, 20), null, 'reserved');
  });

  it('keeps the entrance of buildings free', () => {
    const b = makeBuilder();
    const index = mineIndex('ore', Ground.GRASS);
    assert.ok(b.place(ObjectGroup.ADVENTURE_MINES, index, 10, 10));
    assert.equal(b.reserved[b.grid.index(10, 11)], Reserve.ACCESS);
    assert.ok(TREE_1x1);
    assert.equal(b.place(TREE_1x1.group, TREE_1x1.index, 10, 11), null);
  });

  it('removes objects with their metadata', () => {
    const b = makeBuilder();
    const monster = b.place(ObjectGroup.MONSTERS, 10, 12, 12);
    assert.ok(monster && b.map.monsterMetadata.has(monster.uid));
    b.remove(monster.uid);
    assert.ok(!b.map.monsterMetadata.has(monster.uid));
    assert.ok(b.isFree(b.grid.index(12, 12)));
  });
});
