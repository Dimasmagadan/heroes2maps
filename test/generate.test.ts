import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { artifacts } from '../src/data/enums.ts';
import { checkZoneSeal } from '../src/content/seal.ts';
import { decodeMap, encodeBody, encodeMap } from '../src/fh2m/codec.ts';
import { ObjectGroup, type MapFormat } from '../src/fh2m/types.ts';
import { generate } from '../src/generate.ts';
import { getObjectInfo } from '../src/objects.ts';
import { playerTeams, resolveOptions, type GeneratorOptions } from '../src/options.ts';
import { mapStats, type MapStats } from '../src/summary.ts';
import { findInvalidTransitions } from '../src/terrain/transitions.ts';
import { findInvalidRoads } from '../src/terrain/roads.ts';
import { validateMap } from '../src/validate.ts';

const fixturesDir = new URL('../fixtures/', import.meta.url);

interface Metrics {
  actionDensity: number;
  landscapeDensity: number;
  blockedFraction: number;
  monstersPer1k: number;
}

function metrics(s: MapStats): Metrics {
  return {
    actionDensity: s.actionDensity,
    landscapeDensity: s.landscapeDensity,
    blockedFraction: s.blockedFraction,
    monstersPer1k: (s.monsters * 1000) / s.landTiles,
  };
}

// Ranges observed in the fixture maps (7_deserts is mostly water and a scenario map; it is included anyway).
const fixtureStats = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.fh2m'))
  .map((f) => mapStats(decodeMap(new Uint8Array(readFileSync(new URL(f, fixturesDir))))));
const ranges = Object.fromEntries(
  (Object.keys(metrics(fixtureStats[0] as MapStats)) as (keyof Metrics)[]).map((k) => {
    const values = fixtureStats.map((s) => metrics(s)[k]);
    return [k, [Math.min(...values), Math.max(...values)]];
  }),
) as Record<keyof Metrics, [number, number]>;
// Random monster counts and types are estimated with the expected value of the game's roll.
const knownStrengths = fixtureStats.map((s) => s.monsterStrength.median);
const strengthRange = [Math.min(...knownStrengths), Math.max(...knownStrengths)];

function checkMap(map: MapFormat, options: GeneratorOptions): void {
  const report = validateMap(map, { strictOverlaps: true });
  assert.deepEqual(report.errors, []);
  assert.equal(report.starts.length, options.players);
  assert.deepEqual(findInvalidTransitions(map), []);
  assert.deepEqual(findInvalidRoads(map), []);
  // The file round-trips through our codec.
  assert.deepEqual(encodeBody(decodeMap(encodeMap(map))), encodeBody(map));
}

describe('generator', () => {
  it('is deterministic: same seed and options give an identical body', () => {
    const a = generate({ seed: 1234, size: 72, players: 3, water: 'medium' });
    const b = generate({ seed: 1234, size: 72, players: 3, water: 'medium' });
    assert.deepEqual(encodeBody(a.map), encodeBody(b.map));
    assert.equal(a.map.name, b.map.name);
    const c = generate({ seed: 1235, size: 72, players: 3, water: 'medium' });
    assert.notDeepEqual(encodeBody(a.map), encodeBody(c.map));
  });

  it('rejects invalid options', () => {
    assert.throws(() => resolveOptions({ seed: 1, size: 50 as never }), /Invalid size/);
    assert.throws(() => resolveOptions({ seed: 1, size: 36, players: 4 }), /Invalid player count/);
    assert.throws(() => resolveOptions({ seed: 1, players: 1 }), /Invalid player count/);
    assert.throws(() => resolveOptions({ seed: -1 }), /Invalid seed/);
    assert.throws(() => resolveOptions({ seed: 1, water: 'lots' as never }), /Invalid water/);
  });

  for (const options of [
    { seed: 11, size: 36, players: 2, water: 'low', template: 'ring' },
    { seed: 12, size: 72, players: 4, water: 'medium', template: 'ring' },
    { seed: 13, size: 108, players: 5, water: 'low', preset: 'lakes', template: 'ring' },
    { seed: 14, size: 144, players: 6, water: 'medium', template: 'ring' },
    { seed: 15, size: 108, players: 3, water: 'high', preset: 'islands', template: 'ring' },
    { seed: 16, size: 72, players: 3, water: 'none', preset: 'wasteland', template: 'ring' },
  ] as const) {
    it(`generates a valid ${options.size}x${options.size} map for ${options.players} players (${options.water} water, ${'preset' in options ? options.preset : 'continent'})`, () => {
      const result = generate(options);
      checkMap(result.map, result.options);

      const map = result.map;
      assert.equal(map.width, options.size);
      assert.equal(map.humanPlayerColors, 1);
      assert.equal(map.availablePlayerColors, (1 << options.players) - 1);
      assert.equal(map.computerPlayerColors, map.availablePlayerColors & ~1);
      assert.ok(map.name.length > 0 && /^[\x20-\x7e]*$/.test(map.name + map.description));

      // Every player has a castle, a hero, wood and ore mines and the same rare mines.
      const kits = result.layout.zones
        .filter((z) => z.kind === 'start')
        .map((z) => result.context.records.filter((r) => r.zone === z.id && r.kind === 'mine').map((r) => r.resource).sort().join(','));
      assert.equal(kits.length, options.players);
      for (const kit of kits) {
        assert.ok(kit.includes('wood') && kit.includes('ore'), kit);
        assert.equal(kit, kits[0], 'fair share of mines');
      }

      // Statistics are within the range of the hand-made fixture maps.
      const m = metrics(mapStats(map));
      for (const [k, [min, max]] of Object.entries(ranges)) {
        const v = m[k as keyof Metrics];
        assert.ok(v >= min && v <= max, `${k} = ${v.toFixed(3)} outside fixture range [${min.toFixed(3)}, ${max.toFixed(3)}]`);
      }
      const median = mapStats(map).monsterStrength.median;
      assert.ok(median >= (strengthRange[0] as number) && median <= (strengthRange[1] as number), `monster strength median ${median}`);
    });
  }

  it('sets the capture-town and artifact victory conditions', () => {
    const town = generate({ seed: 21, size: 36, players: 2, victory: 'capture-town' });
    checkMap(town.map, town.options);
    assert.equal(town.map.victoryConditionType, 1);
    const [tile, color] = town.map.victoryConditionMetadata;
    assert.equal(color, 0);
    assert.ok(town.map.tiles[tile as number]?.objects.some((o) => o.group === ObjectGroup.KINGDOM_TOWNS));

    const art = generate({ seed: 22, size: 72, players: 3, victory: 'artifact' });
    checkMap(art.map, art.options);
    assert.equal(art.map.victoryConditionType, 3);
    const artifactId = art.map.victoryConditionMetadata[0];
    const placed = art.map.tiles.flatMap((t) => t.objects).some((o) => o.group === ObjectGroup.ADVENTURE_ARTIFACTS && getObjectInfo(o.group, o.index).metadata[0] === artifactId);
    assert.ok(placed, 'the victory artifact is on the map');
  });

  it('uses Price of Loyalty content only when asked', () => {
    const usesExpansion = (map: MapFormat) =>
      map.tiles.some((t) => t.objects.some((o) => getObjectInfo(o.group, o.index).expansion)) ||
      [...map.artifactMetadata.values()].some((m) => m.selected.some((id) => artifacts.find((a) => a.id === id)?.expansion));
    const plain = generate({ seed: 31, size: 72, players: 2 });
    assert.equal(usesExpansion(plain.map), false);
    // Random artifacts are restricted to original artifacts.
    assert.ok([...plain.map.artifactMetadata.values()].some((m) => m.selected.length > 0));
  });

  it('builds the Koschei tale: Russian texts, prisons, a place of power', () => {
    for (const [seed, size, players] of [[51, 72, 4], [52, 108, 5]] as const) {
      const r = generate({ seed, size, players, tale: true });
      checkMap(r.map, r.options);
      assert.equal(r.options.race, 'necromancer');
      assert.equal(r.map.mainLanguage, 4);
      const m = r.map;
      const text = (s: string) => new TextDecoder('windows-1251').decode(Buffer.from(s, 'latin1'));
      assert.equal(text(m.name), 'Кощеево царство');
      const heroes = [...m.heroMetadata.values()].map((h) => text(h.customName));
      for (const name of ['Кощей Бессмертный', 'Баба-Яга', 'Змей Горыныч', 'Соловей-Разбойник']) assert.ok(heroes.includes(name), name);
      const signs = [...m.signMetadata.values()].map((x) => text(x.message));
      assert.ok(signs.some((x) => x.startsWith('Лысая гора')));
      assert.ok(signs.some((x) => x.includes('острове Буяне')));
      assert.equal(m.adventureMapEventMetadata.size, 1);
      assert.ok(m.dailyEvents.some((e) => e.firstOccurrenceDay === 21));
    }
    assert.throws(() => resolveOptions({ seed: 1, size: 36, tale: true }), /size 72/);
  });

  it('builds three teams: poor human, middle computers, rich walled-in computers', () => {
    for (const [seed, size, players] of [[41, 72, 4], [42, 108, 5], [43, 144, 6]] as const) {
      const r = generate({ seed, size, players, race: 'necromancer', teams: true });
      checkMap(r.map, r.options);
      const teams = playerTeams(r.options);
      // In-game there are two alliances (the format cannot express three): the human against all computers.
      assert.deepEqual(r.map.alliances, [1, (1 << players) - 2]);
      assert.equal(r.map.victoryConditionType, 4);
      assert.equal(r.map.allowNormalVictory, true);
      assert.equal(r.map.isVictoryConditionApplicableForAI, true);
      // Team 3 is reachable only through its keepers, and every keeper stands on the road at its gate.
      const walled = new Set(r.layout.zones.filter((z) => z.kind === 'start' && teams[z.player] === 3).map((z) => z.id));
      const outside = r.layout.connections.filter((c) => walled.has(c.a) !== walled.has(c.b));
      assert.ok(outside.length >= 1 && outside.every((c) => c.keeper !== undefined && walled.has(c.keeper)));
      const keepers = r.context.records.filter((x) => x.kind === 'guard' && (x.strength ?? 0) > 5000);
      assert.ok(keepers.length >= outside.length);
      for (const c of outside) {
        const gate = c.keeper === c.a ? c.gateA : c.gateB;
        assert.ok(
          keepers.some((k) => k.tile === gate || (r.context.grid.distance(k.tile, gate) <= 1 && r.layout.zoneOf[k.tile] === c.keeper)),
          'the keeper stands on the walled side of its gate',
        );
      }
      // The seal: no enterable tile of a walled zone touches the rest of the map, and walled zones touch no water.
      assert.deepEqual(checkZoneSeal(r.context), []);
      for (const zid of walled) {
        for (const t of (r.layout.zones[zid] as NonNullable<typeof r.layout.zones[number]>).tiles) {
          assert.equal(r.context.b.isWater(t), false, `walled zone tile ${t} is water`);
          for (const n of r.context.grid.around(t)) assert.equal(r.context.b.isWater(n), false, `walled zone tile ${t} touches water`);
        }
      }
      // The field of peasants: many big stacks of the weakest monster.
      const peasants = [...r.map.monsterMetadata.values()].filter((m) => m.count >= 150);
      assert.ok(peasants.length >= 6);
      const team3 = teams.reduce((mask, team, p) => (team === 3 ? mask | (1 << p) : mask), 0);
      assert.ok(r.map.dailyEvents.some((e) => e.humanPlayerColors === 0 && e.computerPlayerColors === team3));
    }
    assert.throws(() => resolveOptions({ seed: 1, players: 3, teams: true }), /at least 4/);
    assert.throws(() => resolveOptions({ seed: 1, players: 4, teams: true, victory: 'artifact' }), /victory/);
  });
});
