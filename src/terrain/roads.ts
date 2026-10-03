// Roads and streams. Port of the road and stream helpers from fheroes2 src/fheroes2/maps/map_format_helper.cpp
// (getRoadObjectIndex, setRoadOnTile, updateRoadOnTile, updateAllRoads, getStreamIndex, addStream, updateStreamsAround).
//
// Objects are added through the `addObject` callback so the caller controls UIDs. As in setTerrain, an existing
// road sprite keeps its variant (index or index + 256) when its direction does not change, which makes updates idempotent.

import { ObjectGroup, type MapFormat, type TileInfo } from '../fh2m/types.ts';
import { Direction, Grid, ORTHOGONAL_DIRECTIONS } from '../grid.ts';
import type { RandomSource } from '../rng.ts';
import { Ground, doesTerrainImageContainEmbeddedObjects, groundByImageIndex, randomTerrainImageIndex } from './ground.ts';
import { containsRoad, containsStream } from './transitions.ts';

export const CASTLE_ENTRANCE_ROAD_INDEX = 512;

export type AddObject = (tileIndex: number, group: ObjectGroup, index: number) => void;

const hasBits = (value: number, bits: number) => (value & bits) === bits;
const hasNoBits = (value: number, bits: number) => (value & bits) === 0;

function containsCastleEntrance(tile: TileInfo): boolean {
  return tile.objects.some((o) => o.group === ObjectGroup.KINGDOM_TOWNS);
}

function clearEmbeddedObjects(tile: TileInfo, rng: RandomSource): void {
  if (doesTerrainImageContainEmbeddedObjects(tile.terrainIndex)) {
    const ground = groundByImageIndex(tile.terrainIndex);
    tile.terrainIndex = randomTerrainImageIndex(rng, ground, false);
    tile.terrainFlags = 0;
  }
}

export class RoadEditor {
  readonly map: MapFormat;
  readonly grid: Grid;
  readonly rng: RandomSource;
  private readonly addObject: AddObject;

  constructor(map: MapFormat, rng: RandomSource, addObject: AddObject) {
    this.map = map;
    this.grid = new Grid(map.width);
    this.rng = rng;
    this.addObject = addObject;
  }

  private tile(index: number): TileInfo {
    return this.map.tiles[index] as TileInfo;
  }

  // Road sprite index for a tile from the roads around it. `current` keeps the existing variant if it still fits.
  roadObjectIndex(index: number, current = -1): number {
    const w = this.map.width;
    if (index > w && containsCastleEntrance(this.tile(index - w))) return CASTLE_ENTRANCE_ROAD_INDEX;

    let roadDirection = 0;
    for (const n of this.grid.around(index)) {
      if (containsRoad(this.tile(n))) roadDirection |= this.grid.direction(index, n);
    }
    if (current >= 0 && current < CASTLE_ENTRANCE_ROAD_INDEX && current % 256 === roadDirection) return current;
    return roadDirection + this.rng.get(1) * 256;
  }

  // Places a new road on a tile and updates the road sprites around it. Returns false if there is a road already.
  setRoad(index: number): boolean {
    const tile = this.tile(index);
    if (containsRoad(tile)) return false;
    this.addObject(index, ObjectGroup.ROADS, this.roadObjectIndex(index));
    for (const n of this.grid.around(index)) this.updateRoad(n);
    clearEmbeddedObjects(tile, this.rng);
    return true;
  }

  updateRoad(index: number): boolean {
    const road = this.tile(index).objects.find((o) => o.group === ObjectGroup.ROADS);
    if (!road) return false;
    const next = this.roadObjectIndex(index, road.index);
    if (next === road.index) return false;
    road.index = next;
    return true;
  }

  updateAllRoads(): void {
    for (let i = 0; i < this.grid.size; ++i) this.updateRoad(i);
  }

  // --- Streams ---

  private isStreamToDeltaConnectionNeeded(index: number, direction: number, deltaDirectionAt: (tile: number) => number): boolean {
    const next = this.grid.neighbor(index, direction);
    if (next < 0) return false;
    // The delta's center tile is the next one; it must point back.
    return deltaDirectionAt(next) === reflectOrthogonal(direction);
  }

  private streamDirection(index: number, forceStreamOnTile: boolean, deltaDirectionAt: (tile: number) => number): number {
    if (!forceStreamOnTile && !containsStream(this.tile(index))) return Direction.UNKNOWN;
    let result: number = Direction.CENTER;
    for (const d of ORTHOGONAL_DIRECTIONS) {
      const n = this.grid.neighbor(index, d);
      if (n < 0) continue;
      if (containsStream(this.tile(n)) || this.isStreamToDeltaConnectionNeeded(n, d, deltaDirectionAt)) result |= d;
    }
    return result;
  }

  // Port of getStreamIndex(). `current` keeps the existing variant of straight streams.
  streamIndex(direction: number, current = -1): number {
    const D = Direction;
    if (hasNoBits(direction, D.CENTER)) return -1;
    if (hasBits(direction, D.LEFT | D.BOTTOM) && hasNoBits(direction, D.TOP | D.RIGHT)) return 0;
    if (hasBits(direction, D.RIGHT | D.BOTTOM) && hasNoBits(direction, D.TOP | D.LEFT)) return 1;
    if (hasBits(direction, D.RIGHT | D.TOP) && hasNoBits(direction, D.BOTTOM | D.LEFT)) return 4;
    if (hasBits(direction, D.LEFT | D.TOP) && hasNoBits(direction, D.BOTTOM | D.RIGHT)) return 7;
    if (hasBits(direction, D.LEFT | D.TOP | D.RIGHT) && hasNoBits(direction, D.BOTTOM)) return 8;
    if (hasBits(direction, D.BOTTOM | D.TOP | D.RIGHT) && hasNoBits(direction, D.LEFT)) return 9;
    if (hasBits(direction, D.BOTTOM | D.TOP | D.LEFT) && hasNoBits(direction, D.RIGHT)) return 10;
    if (hasBits(direction, D.BOTTOM | D.LEFT | D.RIGHT) && hasNoBits(direction, D.TOP)) return 11;
    if (hasBits(direction, D.BOTTOM | D.LEFT | D.TOP | D.RIGHT)) return 6;
    if ((hasBits(direction, D.LEFT) || hasBits(direction, D.RIGHT)) && hasNoBits(direction, D.TOP | D.BOTTOM)) {
      if (current === 2 || current === 5) return current;
      return this.rng.get(1) ? 2 : 5;
    }
    if (current === 3 || current === 12) return current;
    return this.rng.get(1) ? 3 : 12;
  }

  private updateStreamObject(index: number, forceStreamOnTile: boolean, deltaDirectionAt: (tile: number) => number): void {
    const direction = this.streamDirection(index, forceStreamOnTile, deltaDirectionAt);
    if (hasNoBits(direction, Direction.CENTER)) return;
    const tile = this.tile(index);
    const stream = tile.objects.find((o) => o.group === ObjectGroup.STREAMS);
    const objectIndex = this.streamIndex(direction, stream ? stream.index : -1);
    if (objectIndex < 0) return;
    if (stream) stream.index = objectIndex;
    else this.addObject(index, ObjectGroup.STREAMS, objectIndex);
  }

  // Port of Maps::addStream(). `deltaDirectionAt` returns the river delta direction of a tile (UNKNOWN if none).
  addStream(index: number, deltaDirectionAt: (tile: number) => number = () => Direction.UNKNOWN): boolean {
    const tile = this.tile(index);
    if (containsStream(tile) || groundByImageIndex(tile.terrainIndex) === Ground.WATER) return false;
    this.updateStreamObject(index, true, deltaDirectionAt);
    for (const d of ORTHOGONAL_DIRECTIONS) {
      const n = this.grid.neighbor(index, d);
      if (n >= 0) this.updateStreamObject(n, false, deltaDirectionAt);
    }
    clearEmbeddedObjects(tile, this.rng);
    return true;
  }
}

function reflectOrthogonal(direction: number): number {
  switch (direction) {
    case Direction.TOP:
      return Direction.BOTTOM;
    case Direction.BOTTOM:
      return Direction.TOP;
    case Direction.LEFT:
      return Direction.RIGHT;
    case Direction.RIGHT:
      return Direction.LEFT;
    default:
      return Direction.UNKNOWN;
  }
}

// Expected road sprite direction for every road tile, compared with the stored one (modulo the 2 sprite variants).
export function findInvalidRoads(map: MapFormat): number[] {
  const grid = new Grid(map.width);
  const invalid: number[] = [];
  for (let i = 0; i < grid.size; ++i) {
    const tile = map.tiles[i] as TileInfo;
    const road = tile.objects.find((o) => o.group === ObjectGroup.ROADS);
    if (!road) continue;
    if (i > map.width && containsCastleEntrance(map.tiles[i - map.width] as TileInfo)) {
      if (road.index !== CASTLE_ENTRANCE_ROAD_INDEX) invalid.push(i);
      continue;
    }
    let dir = 0;
    for (const n of grid.around(i)) if (containsRoad(map.tiles[n] as TileInfo)) dir |= grid.direction(i, n);
    if (road.index % 256 !== dir || road.index >= CASTLE_ENTRANCE_ROAD_INDEX) invalid.push(i);
  }
  return invalid;
}
