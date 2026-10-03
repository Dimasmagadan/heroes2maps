import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Rng } from '../src/rng.ts';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; ++i) assert.equal(a.nextU32(), b.nextU32());
    assert.notEqual(new Rng(1).nextU32(), new Rng(2).nextU32());
  });

  it('keeps forked streams independent of the parent position', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    b.nextU32();
    assert.equal(a.fork('x').nextU32(), b.fork('x').nextU32());
    assert.notEqual(a.fork('x').nextU32(), a.fork('y').nextU32());
  });

  it('respects ranges', () => {
    const r = new Rng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; ++i) {
      const v = r.get(3);
      assert.ok(v >= 0 && v <= 3 && Number.isInteger(v));
      seen.add(v);
      const f = r.next();
      assert.ok(f >= 0 && f < 1);
      const k = r.range(-2, 2);
      assert.ok(k >= -2 && k <= 2);
    }
    assert.equal(seen.size, 4);
  });

  it('shuffles and picks by weight', () => {
    const r = new Rng(9);
    const list = [1, 2, 3, 4, 5, 6];
    assert.deepEqual([...r.shuffle([...list])].sort(), list);
    let heavy = 0;
    for (let i = 0; i < 1000; ++i) if (r.weighted(['a', 'b'], (x) => (x === 'a' ? 9 : 1)) === 'a') ++heavy;
    assert.ok(heavy > 800 && heavy < 980, String(heavy));
  });
});
