import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkZoneSeal } from '../src/content/seal.ts';
import { generate } from '../src/generate.ts';
import { playerTeams, resolveOptions } from '../src/options.ts';
import { Ground } from '../src/terrain/ground.ts';
import { findInvalidTransitions } from '../src/terrain/transitions.ts';
import { validateMap } from '../src/validate.ts';

describe('dead lands', () => {
  it('implies the necromancer race, teams, the twist and the expansion', () => {
    const o = resolveOptions({ seed: 1, players: 4, deadlands: true });
    assert.equal(o.race, 'necromancer');
    assert.equal(o.teams, true);
    assert.equal(o.twist, true);
    assert.equal(o.expansion, true);
    assert.throws(() => resolveOptions({ seed: 1, players: 2, deadlands: true, size: 36 }), /size 72/);
    assert.throws(() => resolveOptions({ seed: 1, players: 3, deadlands: true }), /at least 4/);
    assert.throws(() => resolveOptions({ seed: 1, players: 4, deadlands: true, victory: 'artifact' }), /victory/);
    assert.throws(() => resolveOptions({ seed: 1, players: 4, deadlands: true, tale: true }), /different scenarios/);
  });

  it('builds the living kingdoms: walled team, fodder fields, the prison, the blight gradient', () => {
    for (const [seed, size, players] of [
      [51, 72, 4],
      [52, 108, 5],
    ] as const) {
      const r = generate({ seed, size, players, deadlands: true });
      // Teams in-game: two alliances, victory "defeat the other side".
      assert.deepEqual(r.map.alliances, [1, (1 << players) - 2]);
      assert.equal(r.map.victoryConditionType, 4);
      assert.equal(r.map.allowNormalVictory, true);
      assert.equal(r.map.isVictoryConditionApplicableForAI, true);
      // The seal holds, and the walled zones never touch water.
      assert.deepEqual(checkZoneSeal(r.context), []);
      const teams = playerTeams(r.options);
      const walled = r.layout.zones.filter((z) => z.kind === 'start' && teams[z.player] === 3);
      assert.ok(walled.length >= 1);
      for (const z of walled) for (const t of z.tiles) assert.equal(r.context.b.isWater(t), false, `walled zone tile ${t} is water`);
      // The blight: the human starts on wasteland, the living kingdoms on grass, and the neutral land carries
      // both dead grounds and living ones.
      const home = r.layout.zones.find((z) => z.kind === 'start' && z.player === 0);
      assert.equal(home?.ground, Ground.WASTELAND);
      for (const z of r.layout.zones) {
        if (z.kind === 'start' && z.player > 0) assert.equal(z.ground, Ground.GRASS, `the living kingdom ${z.player} must sit on grass`);
      }
      const neutralGrounds = r.layout.zones.filter((z) => z.kind !== 'start').map((z) => z.ground);
      assert.ok(neutralGrounds.includes(Ground.GRASS), 'living land beyond the start zones');
      assert.ok(
        neutralGrounds.some((g) => g === Ground.WASTELAND || g === Ground.DIRT || g === Ground.SWAMP || g === Ground.LAVA),
        'the blight spreads beyond the home zone',
      );
      // Several fields of peasants: many big stacks of the weakest monster.
      const peasants = [...r.map.monsterMetadata.values()].filter((m) => m.count >= 150);
      assert.ok(peasants.length >= 12, `expected at least two fields of peasants, got ${peasants.length} stacks`);
      // The imprisoned necromancer: the guaranteed Necromancy source.
      const prison = [...r.map.heroMetadata.values()].find((h) => h.customName === 'Morvath the Bonekeeper');
      assert.ok(prison, 'the prison of Morvath the Bonekeeper');
      assert.equal(prison.race, 1 << 5);
      assert.ok(prison.secondarySkill.includes(13), 'Necromancy among the prisoner skills');
      // Texts and names.
      assert.equal(r.map.name, 'The Dead Lands');
      assert.ok(r.map.description.includes('Corlagon'));
      const castleNames = [...r.map.castleMetadata.values()].map((c) => c.customName);
      assert.ok(castleNames.includes('Deadwood Keep'), "the human's castle is named");
      assert.ok(castleNames.some((n) => ['Kingshold', 'Sunmarch', 'Rosewood', 'Goldenvale', 'Stormwatch'].includes(n)), 'a living kingdom castle is named');
      assert.ok(r.map.rumors.some((x) => x.includes('peasants')), 'a rumor hints at the fodder fields');
      // The twist is implied: the day-21 windfall for the computers.
      assert.ok(r.map.dailyEvents.some((e) => e.firstOccurrenceDay === 21 && e.computerPlayerColors !== 0));
      // The map is valid and the terrain is clean.
      const report = validateMap(r.map, { strictOverlaps: true });
      assert.deepEqual(report.errors, []);
      assert.equal(report.starts.length, players);
      assert.deepEqual(findInvalidTransitions(r.map), []);
    }
  });
});
