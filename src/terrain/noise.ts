// Seeded 2D value noise with fractal (fBm) octaves. Deterministic for a given Rng seed.

import type { Rng } from '../rng.ts';

export class ValueNoise {
  private readonly perm: Uint16Array;
  private readonly values: Float64Array;

  constructor(rng: Rng) {
    const n = 256;
    this.values = new Float64Array(n);
    for (let i = 0; i < n; ++i) this.values[i] = rng.next();
    const p = Array.from({ length: n }, (_, i) => i);
    rng.shuffle(p);
    this.perm = new Uint16Array(n * 2);
    for (let i = 0; i < n * 2; ++i) this.perm[i] = p[i % n] as number;
  }

  private lattice(ix: number, iy: number): number {
    const x = ix & 255;
    const y = iy & 255;
    return this.values[this.perm[(this.perm[x] as number) + y] as number] as number;
  }

  // Smooth noise in [0, 1].
  sample(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = this.lattice(x0, y0);
    const b = this.lattice(x0 + 1, y0);
    const c = this.lattice(x0, y0 + 1);
    const d = this.lattice(x0 + 1, y0 + 1);
    const top = a + (b - a) * sx;
    const bottom = c + (d - c) * sx;
    return top + (bottom - top) * sy;
  }

  // Fractal noise in [0, 1]: `octaves` layers, each with double frequency and `persistence` amplitude.
  fbm(x: number, y: number, octaves = 4, persistence = 0.5): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; ++o) {
      sum += this.sample(x * frequency + o * 17.3, y * frequency + o * 31.7) * amplitude;
      norm += amplitude;
      amplitude *= persistence;
      frequency *= 2;
    }
    return sum / norm;
  }
}

// A noise field over a square map, normalized to [0, 1] by rank so thresholds map to tile fractions.
export function noiseField(rng: Rng, width: number, scale: number, octaves = 4): Float64Array {
  const noise = new ValueNoise(rng);
  const field = new Float64Array(width * width);
  for (let y = 0; y < width; ++y) {
    for (let x = 0; x < width; ++x) field[y * width + x] = noise.fbm(x / scale, y / scale, octaves);
  }
  return field;
}

// Value v such that `fraction` of the given entries are >= v.
export function quantileThreshold(values: readonly number[], fraction: number): number {
  if (values.length === 0 || fraction <= 0) return Infinity;
  if (fraction >= 1) return -Infinity;
  const sorted = [...values].sort((a, b) => b - a);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
}
