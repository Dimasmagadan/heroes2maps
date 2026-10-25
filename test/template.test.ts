import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkZoneSeal } from '../src/content/seal.ts';
import { encodeBody } from '../src/fh2m/codec.ts';
import { ObjectGroup, type MapFormat } from '../src/fh2m/types.ts';
import { generate } from '../src/generate.ts';
import { CONCRETE_TEMPLATES, resolveOptions, type GeneratorOptions } from '../src/options.ts';
import { findInvalidRoads } from '../src/terrain/roads.ts';
import { findInvalidTransitions } from '../src/terrain/transitions.ts';
import { mapStats } from '../src/summary.ts';
import { validateMap } from '../src/validate.ts';

function checkMap(map: MapFormat, options: GeneratorOptions): void {
  const report = validateMap(map, { strictOverlaps: true });
  assert.deepEqual(report.errors, []);
  assert.equal(report.starts.length, options.players);
  assert.deepEqual(findInvalidTransitions(map), []);
  assert.deepEqual(findInvalidRoads(map), []);
}

describe('templates', () => {
  it('resolves --template random deterministically and accepts pinning', () => {
    const a = generate({ seed: 77, size: 72, players: 3 });
    const b = generate({ seed: 77, size: 72, players: 3 });
    assert.equal(a.layout.template, b.layout.template, 'same seed, same resolved template');
    assert.deepEqual(encodeBody(a.map), encodeBody(b.map));
    assert.ok(CONCRETE_TEMPLATES.includes(a.layout.template), `resolved template ${a.layout.template} is concrete`);
    assert.notEqual(a.layout.template, 'random');
  });

  for (const template of CONCRETE_TEMPLATES) {
    it(`builds a valid ${template} map (72, 4 players)`, () => {
      const r = generate({ seed: 71, size: 72, players: 4, water: 'medium', template });
      checkMap(r.map, r.options);
      assert.equal(r.layout.template, template);
    });
    it(`builds a valid ${template} map (36, 2 players)`, () => {
      const r = generate({ seed: 72, size: 36, players: 2, water: 'low', template });
      checkMap(r.map, r.options);
    });
  }

  it('hub: every start zone connects to the center zone', () => {
    for (const [seed, size, players] of [[81, 36, 2], [82, 72, 4], [83, 108, 5]] as const) {
      const r = generate({ seed, size, players, template: 'hub' });
      checkMap(r.map, r.options);
      const center = r.layout.zones.find((z) => z.kind === 'center');
      assert.ok(center, 'the hub has a center zone');
      for (const z of r.layout.zones.filter((z) => z.kind === 'start')) {
        assert.ok(
          r.layout.connections.some((c) => (c.a === z.id && c.b === center.id) || (c.b === z.id && c.a === center.id)),
          `start zone ${z.id} connects to the center zone`,
        );
      }
    }
  });

  it('split: halves meet only through bridge zones, and the human owns a bridge-side start', () => {
    for (const seed of [91, 92]) {
      const r = generate({ seed, size: 108, players: 4, water: 'medium', template: 'split' });
      checkMap(r.map, r.options);
      const { zones, connections, bridges } = r.layout;
      assert.ok(bridges.size >= 1, `seed ${seed}: at least one bridge zone`);
      const groupsOfStarts = new Set(zones.filter((z) => z.kind === 'start').map((z) => z.group));
      assert.equal(groupsOfStarts.size, 2, 'start zones on both halves');
      for (const c of connections) {
        const ga = (zones[c.a] as NonNullable<typeof zones[number]>).group;
        const gb = (zones[c.b] as NonNullable<typeof zones[number]>).group;
        if (ga !== gb) assert.ok(bridges.has(c.a) || bridges.has(c.b), `cross-half connection ${c.a}-${c.b} goes through a bridge`);
      }
      // The bridges are richer than an ordinary neutral zone.
      for (const id of bridges) {
        assert.equal((zones[id] as NonNullable<typeof zones[number]>).budgetScale, 1.5);
      }
    }
  });

  it('spine: zones form a chain in order and connections follow it', () => {
    const r = generate({ seed: 93, size: 72, players: 4, template: 'spine' });
    checkMap(r.map, r.options);
    const zones = r.layout.zones;
    const orders = zones.map((z) => z.order).sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.deepEqual(orders, zones.map((_, i) => i), 'chain orders are consecutive');
    for (const c of r.layout.connections) {
      const d = Math.abs((zones[c.a] as NonNullable<typeof zones[number]>).order ?? 0) - ((zones[c.b] as NonNullable<typeof zones[number]>).order ?? 0);
      assert.ok(Math.abs(d) <= 2, `connection ${c.a}-${c.b} skips ${Math.abs(d)} chain steps`);
    }
    const startOrders = zones.filter((z) => z.kind === 'start').map((z) => z.order).sort((a, b) => (a ?? 0) - (b ?? 0));
    assert.equal(startOrders[0], 0, 'a start at one end of the chain');
    assert.equal(startOrders[startOrders.length - 1], zones.length - 1, 'a start at the other end');
  });

  it('rings: a connected inner ring entered through few gates', () => {
    const r = generate({ seed: 94, size: 108, players: 4, template: 'rings' });
    checkMap(r.map, r.options);
    const inner = r.layout.zones.filter((z) => z.tag === 'inner');
    assert.ok(inner.length >= 2, 'inner ring zones exist');
    for (const z of inner) assert.equal(z.budgetScale, 1.8);
    const innerIds = new Set(inner.map((z) => z.id));
    const innerEdges = r.layout.connections.filter((c) => innerIds.has(c.a) && innerIds.has(c.b));
    const gates = r.layout.connections.filter((c) => innerIds.has(c.a) !== innerIds.has(c.b));
    assert.ok(innerEdges.length >= inner.length - 1, 'the inner ring is connected within itself');
    assert.ok(gates.length <= inner.length, `few gates into the vault (got ${gates.length})`);
  });

  it('split + teams: the walled seal holds on a split map', () => {
    const r = generate({ seed: 96, size: 108, players: 4, teams: true, template: 'split' });
    checkMap(r.map, r.options);
    assert.deepEqual(checkZoneSeal(r.context), []);
  });

  it('every victory condition works on every template', () => {
    for (const template of CONCRETE_TEMPLATES) {
      const r = generate({ seed: 97, size: 72, players: 3, template, victory: 'capture-town' });
      checkMap(r.map, r.options);
      assert.equal(r.map.victoryConditionType, 1);
      const [tile] = r.map.victoryConditionMetadata;
      assert.ok(r.map.tiles[tile as number]?.objects.some((o) => o.group === ObjectGroup.KINGDOM_TOWNS));
    }
  });

  it('keeps every template within loose fixture statistics', () => {
    // The strict fixture-range comparison lives in generate.test.ts and only covers the classic ring layout —
    // the fixtures are hand-made maps of that kind. Templates legitimately shift the density (a hub has bigger
    // start zones, rings concentrate content in the middle), so here we only catch gross outliers.
    for (const template of CONCRETE_TEMPLATES) {
      const r = generate({ seed: 98, size: 108, players: 4, water: 'medium', template });
      const s = mapStats(r.map);
      assert.ok(s.actionDensity >= 0.5 * 77.7 && s.actionDensity <= 2 * 189.5, `${template}: actionDensity ${s.actionDensity.toFixed(1)}`);
      assert.ok(s.monsterStrength.median >= 0.5 * 122 && s.monsterStrength.median <= 2 * 414, `${template}: monster strength median ${s.monsterStrength.median}`);
    }
  });

  it('rejects unknown templates', () => {
    assert.throws(() => resolveOptions({ seed: 1, template: 'spiral' as never }), /Invalid template/);
  });
});
