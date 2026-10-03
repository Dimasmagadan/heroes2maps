// Ground types and the terrain tileset layout. Port of fheroes2 src/fheroes2/maps/ground.cpp.
//
// Each ground owns a contiguous range of terrain image indices:
//   - Water, Dirt: [0, 16) transitions (4 shapes x 4 variants), then plain images (Water 16..19, Dirt 16..23),
//     Dirt then has images with embedded objects (24+). Water 20..29 are not used by the editor.
//   - Grass, Snow, Swamp, Lava, Desert, Wasteland: [0, 32) transitions (8 shapes x 4 variants), 32..37 special
//     transitions (single images), 38..45 plain, 46+ plain with embedded objects.
//   - Beach: 0..7 plain, 8+ embedded objects. Beach never has transitions.
// Shape images are mirrored with terrainFlags: bit 0 = vertical flip, bit 1 = horizontal flip.

import { grounds, groundImageStart } from '../data/enums.ts';
import type { RandomSource } from '../rng.ts';

export const Ground = {
  DESERT: grounds.DESERT,
  SNOW: grounds.SNOW,
  SWAMP: grounds.SWAMP,
  WASTELAND: grounds.WASTELAND,
  BEACH: grounds.BEACH,
  LAVA: grounds.LAVA,
  DIRT: grounds.DIRT,
  GRASS: grounds.GRASS,
  WATER: grounds.WATER,
} as const;
export type Ground = (typeof Ground)[keyof typeof Ground];

export const ALL_GROUNDS: readonly Ground[] = [
  Ground.WATER,
  Ground.GRASS,
  Ground.SNOW,
  Ground.SWAMP,
  Ground.LAVA,
  Ground.DESERT,
  Ground.DIRT,
  Ground.WASTELAND,
  Ground.BEACH,
];

export const GROUND_NAMES: Record<Ground, string> = {
  [Ground.WATER]: 'water',
  [Ground.GRASS]: 'grass',
  [Ground.SNOW]: 'snow',
  [Ground.SWAMP]: 'swamp',
  [Ground.LAVA]: 'lava',
  [Ground.DESERT]: 'desert',
  [Ground.DIRT]: 'dirt',
  [Ground.WASTELAND]: 'wasteland',
  [Ground.BEACH]: 'beach',
};

// Ascending start indices; a ground owns [start, next start).
const RANGES: readonly (readonly [number, Ground])[] = [
  [groundImageStart.WATER_START_IMAGE_INDEX, Ground.WATER],
  [groundImageStart.GRASS_START_IMAGE_INDEX, Ground.GRASS],
  [groundImageStart.SNOW_START_IMAGE_INDEX, Ground.SNOW],
  [groundImageStart.SWAMP_START_IMAGE_INDEX, Ground.SWAMP],
  [groundImageStart.LAVA_START_IMAGE_INDEX, Ground.LAVA],
  [groundImageStart.DESERT_START_IMAGE_INDEX, Ground.DESERT],
  [groundImageStart.DIRT_START_IMAGE_INDEX, Ground.DIRT],
  [groundImageStart.WASTELAND_START_IMAGE_INDEX, Ground.WASTELAND],
  [groundImageStart.BEACH_START_IMAGE_INDEX, Ground.BEACH],
];

export const MAX_IMAGE_INDEX = groundImageStart.MAX_IMAGE_INDEX;

export function terrainStartImageIndex(ground: Ground): number {
  for (const [start, g] of RANGES) if (g === ground) return start;
  throw new Error(`Unknown ground ${ground}`);
}

export function groundByImageIndex(imageIndex: number): Ground {
  if (imageIndex < 0 || imageIndex >= MAX_IMAGE_INDEX) throw new Error(`Invalid terrain image index ${imageIndex}`);
  let result: Ground = Ground.WATER;
  for (const [start, g] of RANGES) if (imageIndex >= start) result = g;
  return result;
}

export function isTerrainTransitionImage(imageIndex: number): boolean {
  const ground = groundByImageIndex(imageIndex);
  const offset = imageIndex - terrainStartImageIndex(ground);
  if (ground === Ground.WATER || ground === Ground.DIRT) return offset < 16;
  if (ground === Ground.BEACH) return false;
  return offset < 38;
}

export function doesTerrainImageContainEmbeddedObjects(imageIndex: number): boolean {
  const ground = groundByImageIndex(imageIndex);
  const offset = imageIndex - terrainStartImageIndex(ground);
  switch (ground) {
    case Ground.WATER:
      return false;
    case Ground.DIRT:
      return offset > 23;
    case Ground.BEACH:
      return offset > 7;
    default:
      return offset > 45;
  }
}

// Port of Maps::Ground::getRandomTerrainImageIndex. rng.get(n) is fheroes2's Rand::Get(n), inclusive.
export function randomTerrainImageIndex(rng: RandomSource, ground: Ground, allowEmbeddedObjects: boolean): number {
  const start = terrainStartImageIndex(ground);
  if (ground === Ground.WATER) return rng.get(3) + 16 + start;

  if (allowEmbeddedObjects && rng.get(6) === 0) {
    switch (ground) {
      case Ground.GRASS:
      case Ground.SWAMP:
        return rng.get(15) + 46 + start;
      case Ground.SNOW:
      case Ground.WASTELAND:
      case Ground.LAVA:
        return rng.get(7) + 46 + start;
      case Ground.DESERT:
        return rng.get(12) + 46 + start;
      case Ground.DIRT:
        return rng.get(15) + 24 + start;
      case Ground.BEACH:
        return rng.get(8) + 8 + start;
    }
  }

  const offset = rng.get(7);
  switch (ground) {
    case Ground.DIRT:
      return offset + 16 + start;
    case Ground.BEACH:
      return offset + start;
    default:
      return offset + 38 + start;
  }
}

// Shape class of a terrain image: tiles in the same class differ only by a random variant.
// 'plain' covers all images without a transition (with or without embedded objects).
export function terrainShapeClass(imageIndex: number): string {
  const ground = groundByImageIndex(imageIndex);
  const offset = imageIndex - terrainStartImageIndex(ground);
  if (!isTerrainTransitionImage(imageIndex)) return `${ground}:plain`;
  if (offset < 32) return `${ground}:t${Math.floor(offset / 4)}`;
  return `${ground}:s${offset}`;
}
