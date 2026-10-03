// Terrain transitions. Port of setTerrain / setTerrainBoundaries / updateTerrainTransitionOnTile /
// updateTerrainTransitionOnArea from fheroes2 src/fheroes2/maps/map_format_helper.cpp.
//
// Differences from fheroes2:
//   - randomness comes from our Rng (Rand::Get(n) == rng.get(n));
//   - setTerrain keeps the current image when it already has the requested shape (same shape class and flips),
//     so re-running the transition pass does not reshuffle variants and is idempotent.

import { ObjectGroup, type MapFormat, type TileInfo } from '../fh2m/types.ts';
import { Direction, DIRECTION_ALL, DIRECTION_BOTTOM_ROW, DIRECTION_CENTER_ROW, DIRECTION_TOP_ROW, Grid, NEIGHBOR_DIRECTIONS, directionOffset } from '../grid.ts';
import type { RandomSource } from '../rng.ts';
import {
  Ground,
  doesTerrainImageContainEmbeddedObjects,
  groundByImageIndex,
  isTerrainTransitionImage,
  randomTerrainImageIndex,
  terrainShapeClass,
  terrainStartImageIndex,
} from './ground.ts';

const hasBits = (value: number, bits: number) => (value & bits) === bits;
const hasNoBits = (value: number, bits: number) => (value & bits) === 0;

export function tileGround(tile: TileInfo): Ground {
  return groundByImageIndex(tile.terrainIndex);
}

export function containsRoad(tile: TileInfo): boolean {
  return tile.objects.some((o) => o.group === ObjectGroup.ROADS);
}

export function containsStream(tile: TileInfo): boolean {
  return tile.objects.some((o) => o.group === ObjectGroup.STREAMS);
}

export class TerrainEditor {
  readonly map: MapFormat;
  readonly grid: Grid;
  readonly rng: RandomSource;

  constructor(map: MapFormat, rng: RandomSource) {
    this.map = map;
    this.grid = new Grid(map.width);
    this.rng = rng;
  }

  private tile(index: number): TileInfo {
    return this.map.tiles[index] as TileInfo;
  }

  ground(index: number): Ground {
    return tileGround(this.tile(index));
  }

  // Port of setTerrain(). `vertical`/`horizontal` are the flip flags.
  setTerrain(index: number, imageIndex: number, horizontalFlip: boolean, verticalFlip: boolean): void {
    const tile = this.tile(index);
    const flags = (verticalFlip ? 1 : 0) + (horizontalFlip ? 2 : 0);
    const newGround = groundByImageIndex(imageIndex);

    const requestedClass = terrainShapeClass(imageIndex);
    if (terrainShapeClass(tile.terrainIndex) === requestedClass) {
      const plain = !isTerrainTransitionImage(imageIndex);
      if (plain || tile.terrainFlags === flags) {
        // Same shape: keep the current variant.
        tile.terrainFlags = plain ? 0 : flags;
        if (plain && newGround !== Ground.WATER && (containsRoad(tile) || containsStream(tile)) && doesTerrainImageContainEmbeddedObjects(tile.terrainIndex)) {
          tile.terrainIndex = randomTerrainImageIndex(this.rng, newGround, false);
        }
        return;
      }
    }

    tile.terrainFlags = flags;
    if (newGround !== Ground.WATER && (containsRoad(tile) || containsStream(tile)) && doesTerrainImageContainEmbeddedObjects(imageIndex)) {
      // There cannot be extra objects under roads and streams.
      tile.terrainIndex = randomTerrainImageIndex(this.rng, newGround, false);
    } else {
      tile.terrainIndex = imageIndex;
    }
  }

  // Sets a plain random image of the ground without updating transitions (Maps::setTerrainOnTile).
  setGround(index: number, ground: Ground): void {
    this.setTerrain(index, randomTerrainImageIndex(this.rng, ground, true), false, false);
  }

  // Direction bits from the center tile to neighbors whose ground is `ground` (CENTER bit for the tile itself).
  // Tiles beyond the map border are treated as the nearest map tile.
  groundDirection(center: number, ground: Ground): number {
    const g = this.grid;
    const cx = g.x(center);
    const cy = g.y(center);
    const max = g.width - 1;
    let result = this.ground(center) === ground ? Direction.CENTER : 0;
    for (const d of NEIGHBOR_DIRECTIONS) {
      const [dx, dy] = directionOffset(d);
      const x = Math.min(max, Math.max(0, cx + dx));
      const y = Math.min(max, Math.max(0, cy + dy));
      if (this.ground(g.index(x, y)) === ground) result |= d;
    }
    return result;
  }

  private variant(): number {
    return this.rng.get(3);
  }

  // Port of setTerrainBoundaries(). Returns true if the transition was set or not needed.
  private setTerrainBoundaries(groundDirection: number, beachDirection: number, index: number, imageOffset: number): boolean {
    const D = Direction;
    const set = (offset: number, h: boolean, v: boolean) => this.setTerrain(index, imageOffset + offset, h, v);

    if (groundDirection === DIRECTION_ALL) return true;

    if (groundDirection === (D.TOP_RIGHT | D.TOP | DIRECTION_BOTTOM_ROW | DIRECTION_CENTER_ROW)) {
      set(12 + (hasNoBits(beachDirection, D.TOP_LEFT) ? 0 : 16) + this.variant(), true, false);
      return true;
    }
    if (groundDirection === (D.TOP_LEFT | D.TOP | DIRECTION_BOTTOM_ROW | DIRECTION_CENTER_ROW)) {
      set(12 + (hasNoBits(beachDirection, D.TOP_RIGHT) ? 0 : 16) + this.variant(), false, false);
      return true;
    }
    if (groundDirection === (D.BOTTOM_LEFT | D.BOTTOM | DIRECTION_TOP_ROW | DIRECTION_CENTER_ROW)) {
      set(12 + (hasNoBits(beachDirection, D.BOTTOM_RIGHT) ? 0 : 16) + this.variant(), false, true);
      return true;
    }
    if (groundDirection === (D.BOTTOM_RIGHT | D.BOTTOM | DIRECTION_TOP_ROW | DIRECTION_CENTER_ROW)) {
      set(12 + (hasNoBits(beachDirection, D.BOTTOM_LEFT) ? 0 : 16) + this.variant(), true, true);
      return true;
    }

    const tileIsNotWater = () => this.ground(index) !== Ground.WATER;

    if (hasBits(groundDirection, D.LEFT | D.TOP | D.BOTTOM) && (tileIsNotWater() || hasBits(groundDirection, D.TOP_LEFT | D.BOTTOM_LEFT))) {
      // No ground to the right.
      if (hasBits(beachDirection, D.RIGHT)) {
        set(8 + 16 + this.variant(), false, false);
        return true;
      }
      if (hasNoBits(groundDirection, D.RIGHT)) {
        if (hasBits(beachDirection, D.TOP_RIGHT)) set(35, false, false);
        else if (hasBits(beachDirection, D.BOTTOM_RIGHT)) set(35, false, true);
        else set(8 + this.variant(), false, false);
        return true;
      }
    }

    if (hasBits(groundDirection, D.RIGHT | D.TOP | D.BOTTOM) && (tileIsNotWater() || hasBits(groundDirection, D.TOP_RIGHT | D.BOTTOM_RIGHT))) {
      // No ground to the left.
      if (hasBits(beachDirection, D.LEFT)) {
        set(8 + 16 + this.variant(), true, false);
        return true;
      }
      if (hasNoBits(groundDirection, D.LEFT)) {
        if (hasBits(beachDirection, D.TOP_LEFT)) set(35, true, false);
        else if (hasBits(beachDirection, D.BOTTOM_LEFT)) set(35, true, true);
        else set(8 + this.variant(), true, false);
        return true;
      }
    }

    if (hasBits(groundDirection, D.BOTTOM | D.LEFT | D.RIGHT) && (tileIsNotWater() || hasBits(groundDirection, D.BOTTOM_LEFT | D.BOTTOM_RIGHT))) {
      // No ground to the top.
      if (hasBits(beachDirection, D.TOP)) {
        set(16 + this.variant(), false, false);
        return true;
      }
      if (hasNoBits(groundDirection, D.TOP)) {
        if (hasBits(beachDirection, D.TOP_RIGHT)) set(34, false, false);
        else if (hasBits(beachDirection, D.TOP_LEFT)) set(34, true, false);
        else set(this.variant(), false, false);
        return true;
      }
    }

    if (hasBits(groundDirection, D.TOP | D.LEFT | D.RIGHT) && (tileIsNotWater() || hasBits(groundDirection, D.TOP_LEFT | D.TOP_RIGHT))) {
      // No ground to the bottom.
      if (hasBits(beachDirection, D.BOTTOM)) {
        set(16 + this.variant(), false, true);
        return true;
      }
      if (hasNoBits(groundDirection, D.BOTTOM)) {
        if (hasBits(beachDirection, D.BOTTOM_RIGHT)) set(34, false, true);
        else if (hasBits(beachDirection, D.BOTTOM_LEFT)) set(34, true, true);
        else set(this.variant(), false, true);
        return true;
      }
    }

    if (hasBits(groundDirection, D.RIGHT | D.BOTTOM_RIGHT | D.BOTTOM)) {
      // No ground to the top, top-left and left.
      if (hasBits(beachDirection, D.TOP | D.LEFT) || hasBits(beachDirection, D.TOP | D.BOTTOM_LEFT) || hasBits(beachDirection, D.TOP_RIGHT | D.LEFT)) {
        set(4 + 16 + this.variant(), true, false);
        return true;
      }
      if (hasNoBits(groundDirection, D.TOP | D.LEFT)) {
        if (hasBits(beachDirection, D.TOP)) set(36, true, false);
        else if (hasBits(beachDirection, D.LEFT)) set(37, true, false);
        else if (hasBits(beachDirection, D.TOP_RIGHT)) set(33, true, false);
        else if (hasBits(beachDirection, D.BOTTOM_LEFT)) set(32, true, false);
        else set(4 + this.variant(), true, false);
        return true;
      }
    }

    if (hasBits(groundDirection, D.LEFT | D.BOTTOM_LEFT | D.BOTTOM)) {
      // No ground to the top, top-right and right.
      if (hasBits(beachDirection, D.TOP | D.RIGHT) || hasBits(beachDirection, D.TOP | D.BOTTOM_RIGHT) || hasBits(beachDirection, D.TOP_LEFT | D.RIGHT)) {
        set(4 + 16 + this.variant(), false, false);
        return true;
      }
      if (hasNoBits(groundDirection, D.TOP | D.RIGHT)) {
        if (hasBits(beachDirection, D.TOP)) set(36, false, false);
        else if (hasBits(beachDirection, D.RIGHT)) set(37, false, false);
        else if (hasBits(beachDirection, D.TOP_LEFT)) set(33, false, false);
        else if (hasBits(beachDirection, D.BOTTOM_RIGHT)) set(32, false, false);
        else set(4 + this.variant(), false, false);
        return true;
      }
    }

    if (hasBits(groundDirection, D.TOP | D.TOP_LEFT | D.LEFT)) {
      // No ground to the right, bottom-right and bottom.
      if (hasBits(beachDirection, D.RIGHT | D.BOTTOM) || hasBits(beachDirection, D.RIGHT | D.BOTTOM_LEFT) || hasBits(beachDirection, D.TOP_RIGHT | D.BOTTOM)) {
        set(4 + 16 + this.variant(), false, true);
        return true;
      }
      if (hasNoBits(groundDirection, D.RIGHT | D.BOTTOM)) {
        if (hasBits(beachDirection, D.BOTTOM)) set(36, false, true);
        else if (hasBits(beachDirection, D.RIGHT)) set(37, false, true);
        else if (hasBits(beachDirection, D.BOTTOM_LEFT)) set(33, false, true);
        else if (hasBits(beachDirection, D.TOP_RIGHT)) set(32, false, true);
        else set(4 + this.variant(), false, true);
        return true;
      }
    }

    if (hasBits(groundDirection, D.TOP | D.TOP_RIGHT | D.RIGHT)) {
      // No ground to the left, bottom-left and bottom.
      if (hasBits(beachDirection, D.LEFT | D.BOTTOM) || hasBits(beachDirection, D.LEFT | D.BOTTOM_RIGHT) || hasBits(beachDirection, D.TOP_LEFT | D.BOTTOM)) {
        set(4 + 16 + this.variant(), true, true);
        return true;
      }
      if (hasNoBits(groundDirection, D.LEFT | D.BOTTOM)) {
        if (hasBits(beachDirection, D.BOTTOM)) set(36, true, true);
        else if (hasBits(beachDirection, D.LEFT)) set(37, true, true);
        else if (hasBits(beachDirection, D.BOTTOM_RIGHT)) set(33, true, true);
        else if (hasBits(beachDirection, D.TOP_LEFT)) set(32, true, true);
        else set(4 + this.variant(), true, true);
        return true;
      }
    }

    if (hasBits(groundDirection, D.TOP | D.RIGHT | D.BOTTOM | D.LEFT)) {
      const ground = this.ground(index);
      if (ground !== Ground.WATER) {
        // More than one corner needs a transition; fheroes2 has no images for this and leaves a plain tile.
        this.setTerrain(index, randomTerrainImageIndex(this.rng, ground, true), false, false);
        return true;
      }
    }

    return false;
  }

  // Port of updateTerrainTransitionOnTile(). Returns true if the transition was set or not needed.
  updateTransitionOnTile(index: number): boolean {
    const tile = this.tile(index);
    const ground = this.ground(index);
    if (ground === Ground.BEACH) return true;

    const tileGroundDirection =
      ground === Ground.DIRT
        ? DIRECTION_ALL - (this.groundDirection(index, Ground.WATER) | this.groundDirection(index, Ground.BEACH))
        : this.groundDirection(index, ground) | Direction.CENTER;

    if (tileGroundDirection === DIRECTION_ALL) {
      if (isTerrainTransitionImage(tile.terrainIndex)) {
        this.setTerrain(index, randomTerrainImageIndex(this.rng, ground, true), false, false);
      }
      return true;
    }

    if (ground === Ground.WATER || ground === Ground.DIRT) {
      return this.setTerrainBoundaries(tileGroundDirection, 0, index, terrainStartImageIndex(ground));
    }
    const beachDirection = this.groundDirection(index, Ground.WATER) | this.groundDirection(index, Ground.BEACH);
    return this.setTerrainBoundaries(tileGroundDirection, beachDirection, index, terrainStartImageIndex(ground));
  }

  // Port of updateTerrainTransitionOnArea() for a list of tiles. When a tile cannot get a valid transition,
  // its ground is replaced by a neighboring one (or Beach next to water / Dirt on land), as fheroes2 does.
  updateTransitions(indices: Iterable<number>, preferredGround: Ground | null = null, depth = 0): void {
    for (const index of indices) {
      if (this.updateTransitionOnTile(index)) continue;

      const groundOnTile = this.ground(index);
      const newGrounds: Ground[] = [];
      if (preferredGround !== null && groundOnTile !== preferredGround) newGrounds.push(preferredGround);

      let isWater = groundOnTile === Ground.WATER;
      const around = this.grid.around(index);
      for (const n of around) {
        const g = this.ground(n);
        if (g !== groundOnTile && !newGrounds.includes(g)) newGrounds.push(g);
        isWater ||= g === Ground.WATER;
      }
      const lastChance = isWater ? Ground.BEACH : Ground.DIRT;
      if (!newGrounds.includes(lastChance)) newGrounds.push(lastChance);

      let needRevert = true;
      for (const g of newGrounds) {
        this.setTerrain(index, randomTerrainImageIndex(this.rng, g, true), false, false);
        if (!this.updateTransitionOnTile(index)) continue;
        for (const n of around) {
          if (!this.updateTransitionOnTile(n) && depth < 8) this.updateTransitions([n], preferredGround, depth + 1);
        }
        needRevert = false;
        break;
      }
      if (needRevert) this.setTerrain(index, randomTerrainImageIndex(this.rng, groundOnTile, true), false, false);
    }
  }

  // Recomputes transitions for the whole map. Ground replacements made by the fallback can invalidate tiles
  // processed earlier, so the pass is repeated on the remaining invalid tiles until none are left.
  updateAllTransitions(): void {
    let pending: number[] = [];
    for (let i = 0; i < this.grid.size; ++i) pending.push(i);
    for (let round = 0; round < 6 && pending.length > 0; ++round) {
      this.updateTransitions(pending);
      pending = findInvalidTransitions(this.map);
    }
  }

  // Port of setTerrainWithTransition() for a rectangle.
  setTerrainWithTransition(x0: number, y0: number, x1: number, y1: number, ground: Ground): void {
    const g = this.grid;
    const changed: number[] = [];
    for (let y = Math.max(0, y0); y <= Math.min(g.width - 1, y1); ++y) {
      for (let x = Math.max(0, x0); x <= Math.min(g.width - 1, x1); ++x) {
        this.setGround(g.index(x, y), ground);
        changed.push(g.index(x, y));
      }
    }
    const ring = new Set<number>();
    for (const i of changed) {
      ring.add(i);
      for (const n of g.around(i)) ring.add(n);
    }
    this.updateTransitions([...ring].sort((a, b) => a - b), ground);
  }
}

// Expected shape class of every tile given only the ground types, using fheroes2's rules.
// Returns indices of tiles whose current image does not match (modulo random variant) or that have no valid image.
export function findInvalidTransitions(map: MapFormat): number[] {
  const copy: MapFormat = { ...map, tiles: map.tiles.map((t) => ({ terrainIndex: t.terrainIndex, terrainFlags: t.terrainFlags, objects: t.objects })) };
  const editor = new TerrainEditor(copy, new FixedRng());
  const invalid: number[] = [];
  for (let i = 0; i < copy.tiles.length; ++i) {
    const tile = copy.tiles[i] as TileInfo;
    const before = { index: tile.terrainIndex, flags: tile.terrainFlags };
    const ok = editor.updateTransitionOnTile(i);
    const changed = terrainShapeClass(before.index) !== terrainShapeClass(tile.terrainIndex) || (isTerrainTransitionImage(before.index) && before.flags !== tile.terrainFlags);
    if (!ok || changed) invalid.push(i);
    tile.terrainIndex = before.index;
    tile.terrainFlags = before.flags;
  }
  return invalid;
}

// Deterministic stand-in used when only the shape class matters.
class FixedRng implements RandomSource {
  get(): number {
    return 0;
  }
}

export function groundsOf(map: MapFormat): Ground[] {
  return map.tiles.map((t) => tileGround(t));
}
