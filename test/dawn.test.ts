import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generate } from '../src/generate.ts';
import { resolveOptions } from '../src/options.ts';
import { Ground } from '../src/terrain/ground.ts';
import { findInvalidTransitions } from '../src/terrain/transitions.ts';
import { validateMap } from '../src/validate.ts';

describe('long night', () => {
  it('implies the necromancer race and the expansion, and rejects conflicting options', () => {
    const o = resolveOptions({ seed: 1, players: 3, dawn: true });
    assert.equal(o.race, 'necromancer');
    assert.equal(o.expansion, true);
    assert.throws(() => resolveOptions({ seed: 1, players: 3, size: 36, dawn: true }), /size 72/);
    assert.throws(() => resolveOptions({ seed: 1, players: 2, dawn: true }), /at least 3/);
    assert.throws(() => resolveOptions({ seed: 1, players: 4, dawn: true, victory: 'artifact' }), /victory/);
    assert.throws(() => resolveOptions({ seed: 1, players: 4, dawn: true, teams: true }), /teams/);
    assert.throws(() => resolveOptions({ seed: 1, players: 4, dawn: true, deadlands: true }), /different scenarios/);
  });

  it('builds Dawnspire, the deadline, the calendar, the tomb and the prisons', () => {
    for (const [seed, size, players] of [
      [71, 72, 3],
      [72, 108, 5],
    ] as const) {
      const r = generate({ seed, size, players, dawn: true });
      const map = r.map;
      // Victory: capture Dawnspire; loss: the sun comes up at the end of the eighth week.
      assert.equal(map.victoryConditionType, 1);
      assert.equal(map.allowNormalVictory, true);
      assert.equal(map.lossConditionType, 3);
      assert.deepEqual(map.lossConditionMetadata, [56]);
      const dawnspire = [...map.castleMetadata.values()].find((c) => c.customName === 'Dawnspire');
      assert.ok(dawnspire, 'Dawnspire exists');
      assert.ok(dawnspire.defenderMonsterCount.every((n) => n > 0), 'Dawnspire has a full garrison');
      assert.ok(r.context.castles.some((c) => c.tile === map.victoryConditionMetadata[0] && c.player < 0), 'the victory target is a neutral town');
      // The calendar swings between the sides.
      const day = (d: number) => map.dailyEvents.find((e) => e.firstOccurrenceDay === d && e.repeatPeriodInDays === 0);
      for (const d of [1, 21, 35, 49]) assert.ok(day(d)?.humanPlayerColors && !day(d)?.computerPlayerColors, `day ${d} favors the dead`);
      for (const d of [14, 28, 42]) assert.ok(!day(d)?.humanPlayerColors && day(d)?.computerPlayerColors, `day ${d} favors the living`);
      // No Pale Tide: the calendar replaces the twist.
      assert.ok(!map.dailyEvents.some((e) => e.message.includes('pale tide')));
      // The tomb wakes a legion for the human only.
      const tomb = [...map.adventureMapEventMetadata.values()].find((e) => e.monsterCount > 0);
      assert.ok(tomb, 'the tomb of the Dead King');
      assert.equal(tomb.monsterType, 57);
      assert.equal(tomb.computerPlayerColors, 0);
      // Both prisoners: the guaranteed necromancer and the defector.
      const heroes = [...map.heroMetadata.values()];
      const warden = heroes.find((h) => h.customName === 'Ilsa the Gravewarden');
      assert.ok(warden && warden.secondarySkill.includes(13) && warden.race === 1 << 5);
      const oathbreaker = heroes.find((h) => h.customName === 'Sir Roderic the Oathbreaker');
      assert.ok(oathbreaker && oathbreaker.race === 1);
      assert.equal(map.name, 'The Long Night');
      assert.ok(heroes.some((h) => h.customName === 'Lord Malachar'));
      assert.equal(map.rumors.length, 5);
      const home = r.layout.zones.find((z) => z.kind === 'start' && z.player === 0);
      assert.equal(home?.ground, Ground.WASTELAND);
      const report = validateMap(map, { strictOverlaps: true });
      assert.deepEqual(report.errors, []);
      assert.deepEqual(findInvalidTransitions(map), []);
    }
  });
});
