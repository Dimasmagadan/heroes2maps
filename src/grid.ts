// Square map grid helpers. Tiles are addressed by index = y * width + x, like in fheroes2.
// Direction bit values match fheroes2 (heroes/direction.h).

export const Direction = {
  UNKNOWN: 0x0000,
  TOP_LEFT: 0x0001,
  TOP: 0x0002,
  TOP_RIGHT: 0x0004,
  RIGHT: 0x0008,
  BOTTOM_RIGHT: 0x0010,
  BOTTOM: 0x0020,
  BOTTOM_LEFT: 0x0040,
  LEFT: 0x0080,
  CENTER: 0x0100,
} as const;

export const DIRECTION_TOP_ROW = Direction.TOP_LEFT | Direction.TOP | Direction.TOP_RIGHT;
export const DIRECTION_BOTTOM_ROW = Direction.BOTTOM_LEFT | Direction.BOTTOM | Direction.BOTTOM_RIGHT;
export const DIRECTION_CENTER_ROW = Direction.LEFT | Direction.CENTER | Direction.RIGHT;
export const DIRECTION_ALL = DIRECTION_TOP_ROW | DIRECTION_BOTTOM_ROW | DIRECTION_CENTER_ROW;

// Same order as fheroes2 Direction::allNeighboringDirections.
export const NEIGHBOR_DIRECTIONS = [
  Direction.TOP_LEFT,
  Direction.TOP,
  Direction.TOP_RIGHT,
  Direction.RIGHT,
  Direction.BOTTOM_RIGHT,
  Direction.BOTTOM,
  Direction.BOTTOM_LEFT,
  Direction.LEFT,
] as const;

export const ORTHOGONAL_DIRECTIONS = [Direction.LEFT, Direction.TOP, Direction.RIGHT, Direction.BOTTOM] as const;

const OFFSETS: Record<number, readonly [number, number]> = {
  [Direction.TOP_LEFT]: [-1, -1],
  [Direction.TOP]: [0, -1],
  [Direction.TOP_RIGHT]: [1, -1],
  [Direction.RIGHT]: [1, 0],
  [Direction.BOTTOM_RIGHT]: [1, 1],
  [Direction.BOTTOM]: [0, 1],
  [Direction.BOTTOM_LEFT]: [-1, 1],
  [Direction.LEFT]: [-1, 0],
  [Direction.CENTER]: [0, 0],
};

export function directionOffset(direction: number): readonly [number, number] {
  const o = OFFSETS[direction];
  if (!o) throw new Error(`Not a single direction: ${direction}`);
  return o;
}

export function reflect(direction: number): number {
  switch (direction) {
    case Direction.TOP_LEFT:
      return Direction.BOTTOM_RIGHT;
    case Direction.TOP:
      return Direction.BOTTOM;
    case Direction.TOP_RIGHT:
      return Direction.BOTTOM_LEFT;
    case Direction.RIGHT:
      return Direction.LEFT;
    case Direction.BOTTOM_RIGHT:
      return Direction.TOP_LEFT;
    case Direction.BOTTOM:
      return Direction.TOP;
    case Direction.BOTTOM_LEFT:
      return Direction.TOP_RIGHT;
    case Direction.LEFT:
      return Direction.RIGHT;
    default:
      return Direction.UNKNOWN;
  }
}

export class Grid {
  readonly width: number;
  readonly size: number;

  constructor(width: number) {
    this.width = width;
    this.size = width * width;
  }

  x(index: number): number {
    return index % this.width;
  }

  y(index: number): number {
    return Math.floor(index / this.width);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.width;
  }

  // Index of the neighbor in the given direction, or -1 if it is outside the map.
  neighbor(index: number, direction: number): number {
    const [dx, dy] = directionOffset(direction);
    const x = this.x(index) + dx;
    const y = this.y(index) + dy;
    return this.inside(x, y) ? this.index(x, y) : -1;
  }

  // Valid tiles around (excluding the center), row by row like fheroes2 Maps::getAroundIndexes.
  around(index: number, distance = 1): number[] {
    const cx = this.x(index);
    const cy = this.y(index);
    const result: number[] = [];
    for (let y = Math.max(0, cy - distance); y <= Math.min(this.width - 1, cy + distance); ++y) {
      for (let x = Math.max(0, cx - distance); x <= Math.min(this.width - 1, cx + distance); ++x) {
        if (x !== cx || y !== cy) result.push(this.index(x, y));
      }
    }
    return result;
  }

  // Direction from one tile to an adjacent one (CENTER for the same tile, UNKNOWN if not adjacent).
  direction(from: number, to: number): number {
    if (from === to) return Direction.CENTER;
    const dx = this.x(to) - this.x(from);
    const dy = this.y(to) - this.y(from);
    for (const d of NEIGHBOR_DIRECTIONS) {
      const [ox, oy] = directionOffset(d);
      if (ox === dx && oy === dy) return d;
    }
    return Direction.UNKNOWN;
  }

  // Chebyshev distance.
  distance(a: number, b: number): number {
    return Math.max(Math.abs(this.x(a) - this.x(b)), Math.abs(this.y(a) - this.y(b)));
  }

  euclid(a: number, b: number): number {
    return Math.hypot(this.x(a) - this.x(b), this.y(a) - this.y(b));
  }

  // Breadth-first flood fill over 8-connected tiles accepted by `pass`, from the given seeds.
  // Returns distances (in steps) per tile, -1 for unreached tiles.
  flood(seeds: readonly number[], pass: (index: number) => boolean): Int32Array {
    const dist = new Int32Array(this.size).fill(-1);
    const queue: number[] = [];
    for (const s of seeds) {
      if (dist[s] === -1) {
        dist[s] = 0;
        queue.push(s);
      }
    }
    for (let head = 0; head < queue.length; ++head) {
      const cur = queue[head] as number;
      const d = (dist[cur] as number) + 1;
      for (const dir of NEIGHBOR_DIRECTIONS) {
        const n = this.neighbor(cur, dir);
        if (n >= 0 && dist[n] === -1 && pass(n)) {
          dist[n] = d;
          queue.push(n);
        }
      }
    }
    return dist;
  }
}
