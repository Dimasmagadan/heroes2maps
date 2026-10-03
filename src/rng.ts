// Seeded PRNG (sfc32 seeded through splitmix32). All randomness in the generator goes through this module.

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

// FNV-1a, used to derive independent sub-streams from labels.
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; ++i) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// The part of Rng used by ported fheroes2 code: Rand::Get(n), uniform in [0, n].
export interface RandomSource {
  get(n: number): number;
}

export class Rng implements RandomSource {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const init = splitmix32(this.seed);
    this.a = init();
    this.b = init();
    this.c = init();
    this.d = init();
    for (let i = 0; i < 12; ++i) this.nextU32();
  }

  // A new generator whose sequence depends only on this generator's seed and the label,
  // so adding draws to one pipeline stage does not change the others.
  fork(label: string): Rng {
    return new Rng((this.seed ^ hashString(label)) >>> 0);
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  // Uniform float in [0, 1).
  next(): number {
    return this.nextU32() / 4294967296;
  }

  // Uniform integer in [0, n).
  int(n: number): number {
    if (n <= 0) throw new Error(`Rng.int: invalid bound ${n}`);
    return Math.floor(this.next() * n);
  }

  // Uniform integer in [min, max] (inclusive), like fheroes2 Rand::Get(min, max).
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  // fheroes2 Rand::Get(n): uniform integer in [0, n] (inclusive).
  get(n: number): number {
    return this.int(n + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty list');
    return items[this.int(items.length)] as T;
  }

  // Picks an item with probability proportional to weight(item).
  weighted<T>(items: readonly T[], weight: (item: T) => number): T {
    let total = 0;
    for (const item of items) total += Math.max(0, weight(item));
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (const item of items) {
      r -= Math.max(0, weight(item));
      if (r < 0) return item;
    }
    return items[items.length - 1] as T;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; --i) {
      const j = this.int(i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}
