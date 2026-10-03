// Validation pass: reachability and overlap checks for a MapFormat.
//
// Movement model (conservative approximation of fheroes2 world pathfinding):
//   - a tile with a blocking object part (OBJECT/BACKGROUND layer of a non-action object or of a non-action part of
//     an action object) cannot be entered; fheroes2 sometimes allows a bit more, never less;
//   - an action tile can be entered only from its object's entry directions and the hero stops there; removable
//     objects (monsters, pickups, artifacts, heroes, boats) are treated as gone after the visit, so paths continue;
//   - moving diagonally up (TOP_LEFT / TOP_RIGHT) is not possible past a tall object on the side tile;
//   - heroes walk on land only. From land a hero can board a boat (on an adjacent water tile), sail over water
//     (not through land corners) and disembark on a free land tile. Shipyards are not modelled.

import { objectTypes } from './data/enums.ts';
import { ObjectGroup, type MapFormat, type TileInfo } from './fh2m/types.ts';
import { Direction, DIRECTION_ALL, Grid, NEIGHBOR_DIRECTIONS, reflect } from './grid.ts';
import { getObjectInfo, hasObject, type ObjectInfo } from './objects.ts';
import { Ground, groundByImageIndex } from './terrain/ground.ts';

export interface MapObjectRef {
  uid: number;
  group: ObjectGroup;
  index: number;
  tile: number;
  info: ObjectInfo;
}

const REMOVABLE_TYPES = new Set<number>([
  objectTypes.OBJ_MONSTER,
  objectTypes.OBJ_HERO,
  objectTypes.OBJ_BOAT,
  objectTypes.OBJ_ARTIFACT,
  objectTypes.OBJ_RANDOM_ARTIFACT,
  objectTypes.OBJ_RANDOM_ARTIFACT_TREASURE,
  objectTypes.OBJ_RANDOM_ARTIFACT_MINOR,
  objectTypes.OBJ_RANDOM_ARTIFACT_MAJOR,
  objectTypes.OBJ_RANDOM_RESOURCE,
  objectTypes.OBJ_RANDOM_MONSTER,
  objectTypes.OBJ_RANDOM_MONSTER_WEAK,
  objectTypes.OBJ_RANDOM_MONSTER_MEDIUM,
  objectTypes.OBJ_RANDOM_MONSTER_STRONG,
  objectTypes.OBJ_RANDOM_MONSTER_VERY_STRONG,
]);

const MONSTER_TYPES = new Set<number>([
  objectTypes.OBJ_MONSTER,
  objectTypes.OBJ_RANDOM_MONSTER,
  objectTypes.OBJ_RANDOM_MONSTER_WEAK,
  objectTypes.OBJ_RANDOM_MONSTER_MEDIUM,
  objectTypes.OBJ_RANDOM_MONSTER_STRONG,
  objectTypes.OBJ_RANDOM_MONSTER_VERY_STRONG,
]);

export function isRemovable(info: ObjectInfo): boolean {
  return info.isPickup || REMOVABLE_TYPES.has(info.objectType);
}

export function isMonster(info: ObjectInfo): boolean {
  return MONSTER_TYPES.has(info.objectType);
}

// Per-tile movement model derived from a map.
export class MovementModel {
  readonly map: MapFormat;
  readonly grid: Grid;
  readonly objects: MapObjectRef[] = [];
  readonly water: Uint8Array;
  readonly blocked: Uint8Array;
  // Object owning the action tile, or -1.
  readonly actionAt: Int32Array;
  // Passability bits (fheroes2 Direction) of each tile: directions from which it can be entered and left.
  readonly passability: Uint16Array;
  // Distinct UIDs of objects occupying each tile (for overlap checks).
  readonly occupiedBy: number[][];

  constructor(map: MapFormat) {
    this.map = map;
    const g = (this.grid = new Grid(map.width));
    this.water = new Uint8Array(g.size);
    this.blocked = new Uint8Array(g.size);
    this.actionAt = new Int32Array(g.size).fill(-1);
    this.passability = new Uint16Array(g.size);
    this.occupiedBy = Array.from({ length: g.size }, () => []);

    const seenMain = new Set<number>();
    for (let t = 0; t < g.size; ++t) {
      const tile = map.tiles[t] as TileInfo;
      this.water[t] = groundByImageIndex(tile.terrainIndex) === Ground.WATER ? 1 : 0;
      for (const o of tile.objects) {
        if (!hasObject(o.group, o.index)) throw new Error(`Unknown object group ${o.group} index ${o.index} at tile ${t}`);
        if (o.group === ObjectGroup.LANDSCAPE_FLAGS) continue;
        const info = getObjectInfo(o.group, o.index);
        // Castle basement and town share a UID; keep the town as the object.
        if (o.group === ObjectGroup.LANDSCAPE_TOWN_BASEMENTS) {
          this.markParts(info, t, o.id, -1);
          continue;
        }
        const ref: MapObjectRef = { uid: o.id, group: o.group, index: o.index, tile: t, info };
        const refIndex = this.objects.length;
        this.objects.push(ref);
        seenMain.add(o.id);
        this.markParts(info, t, o.id, refIndex);
      }
    }

    for (let t = 0; t < g.size; ++t) {
      const a = this.actionAt[t] as number;
      if (a >= 0) this.passability[t] = (this.objects[a] as MapObjectRef).info.entryDirections;
      else this.passability[t] = this.blocked[t] ? 0 : DIRECTION_ALL;
    }
    // Tall objects on the side tile forbid diagonal moves upwards (fheroes2 Tile::updatePassability).
    for (let t = 0; t < g.size; ++t) {
      for (const [diag, side] of [
        [Direction.TOP_LEFT, Direction.LEFT],
        [Direction.TOP_RIGHT, Direction.RIGHT],
      ] as const) {
        if (((this.passability[t] as number) & diag) === 0) continue;
        const s = g.neighbor(t, side);
        if (s < 0) continue;
        if (this.blocked[s] || (this.actionAt[s] !== -1 && ((this.passability[s] as number) & Direction.TOP) === 0)) {
          this.passability[t] = (this.passability[t] as number) & ~diag;
        }
      }
    }
  }

  private markParts(info: ObjectInfo, tile: number, uid: number, refIndex: number): void {
    const g = this.grid;
    const x = g.x(tile);
    const y = g.y(tile);
    const actionSet = new Set(info.actionCells.map((c) => `${c.dx},${c.dy}`));
    for (const o of info.occupied) {
      if (!g.inside(x + o.dx, y + o.dy)) continue;
      const i = g.index(x + o.dx, y + o.dy);
      const list = this.occupiedBy[i] as number[];
      if (!list.includes(uid)) list.push(uid);
      if (refIndex >= 0 && actionSet.has(`${o.dx},${o.dy}`)) {
        // Heroes are temporary: fheroes2 takes passability from the object under the hero (e.g. a castle entrance).
        const current = this.actionAt[i] as number;
        const isHero = info.objectType === objectTypes.OBJ_HERO;
        if (current === -1 || (!isHero && (this.objects[current] as MapObjectRef).info.objectType === objectTypes.OBJ_HERO)) this.actionAt[i] = refIndex;
      } else {
        this.blocked[i] = 1;
      }
    }
  }

  // fheroes2 isMovementAllowed for a hero on land or water, without fog and allied objects.
  canMove(from: number, direction: number, onWater: boolean): number {
    const g = this.grid;
    const to = g.neighbor(from, direction);
    if (to < 0) return -1;
    if (onWater && (direction === Direction.TOP_LEFT || direction === Direction.TOP_RIGHT || direction === Direction.BOTTOM_LEFT || direction === Direction.BOTTOM_RIGHT)) {
      // Cannot sail through a corner formed by land.
      const fx = g.x(from);
      const fy = g.y(from);
      const tx = g.x(to);
      const ty = g.y(to);
      if (this.water[to] && (!this.water[g.index(tx, fy)] || !this.water[g.index(fx, ty)])) return -1;
    }
    if (((this.passability[from] as number) & direction) === 0 && this.actionAt[from] === -1) return -1;
    if (((this.passability[to] as number) & reflect(direction)) === 0) return -1;
    return to;
  }

  objectAt(tile: number): MapObjectRef | null {
    const a = this.actionAt[tile] as number;
    return a >= 0 ? (this.objects[a] as MapObjectRef) : null;
  }
}

export interface ReachOptions {
  // Treat monsters as impassable and stop at tiles guarded by monsters (zone of control).
  respectGuards?: boolean;
  // Allow boats.
  boats?: boolean;
}

export interface Reach {
  land: Uint8Array; // tiles a hero can stand on (or visit) on land
  water: Uint8Array; // water tiles reachable by boat
  visited: Set<number>; // indices into model.objects of visited action objects
}

// Breadth-first reachability from start tiles (heroes start on land).
export function reach(model: MovementModel, starts: readonly number[], opts: ReachOptions = {}): Reach {
  const g = model.grid;
  const land = new Uint8Array(g.size);
  const water = new Uint8Array(g.size);
  const visited = new Set<number>();
  const guarded = opts.respectGuards ? guardedTiles(model) : null;

  const queue: number[] = []; // encoded tile * 2 + (onWater ? 1 : 0)
  for (const s of starts) {
    if (!land[s]) {
      land[s] = 1;
      queue.push(s * 2);
    }
  }

  for (let head = 0; head < queue.length; ++head) {
    const code = queue[head] as number;
    const cur = code >> 1;
    const onWater = (code & 1) === 1;
    if (!onWater && guarded && guarded[cur] && !starts.includes(cur)) continue;

    for (const d of NEIGHBOR_DIRECTIONS) {
      const to = model.canMove(cur, d, onWater);
      if (to < 0) continue;
      const obj = model.objectAt(to);
      const toWater = model.water[to] === 1;

      if (onWater) {
        if (toWater) {
          if (obj && obj.info.objectType === objectTypes.OBJ_BOAT) continue;
          if (obj) {
            visited.add(model.actionAt[to] as number);
            continue;
          }
          if (!water[to]) {
            water[to] = 1;
            queue.push(to * 2 + 1);
          }
        } else {
          // Disembark only on a free land tile.
          if (obj || model.blocked[to]) continue;
          if (!land[to]) {
            land[to] = 1;
            queue.push(to * 2);
          }
        }
        continue;
      }

      if (toWater) {
        // From land a hero can step onto water only to board a boat (or visit a shipwreck).
        if (!obj) continue;
        visited.add(model.actionAt[to] as number);
        if (obj.info.objectType === objectTypes.OBJ_BOAT && opts.boats !== false && !water[to]) {
          water[to] = 1;
          queue.push(to * 2 + 1);
        }
        continue;
      }

      if (obj) {
        visited.add(model.actionAt[to] as number);
        if (opts.respectGuards && isMonster(obj.info)) continue;
        if (!isRemovable(obj.info)) continue;
      }
      if (!land[to]) {
        land[to] = 1;
        queue.push(to * 2);
      }
    }
  }
  return { land, water, visited };
}

// Tiles adjacent to (or on) a monster: entering them starts a fight.
export function guardedTiles(model: MovementModel): Uint8Array {
  const g = model.grid;
  const result = new Uint8Array(g.size);
  for (let t = 0; t < g.size; ++t) {
    const obj = model.objectAt(t);
    if (!obj || !isMonster(obj.info)) continue;
    result[t] = 1;
    for (const n of g.around(t)) if (!model.water[n]) result[n] = 1;
  }
  return result;
}

export interface PlayerStart {
  color: number; // color index 0..5
  tiles: number[]; // hero tiles and castle entrance tiles
}

export function playerStarts(model: MovementModel): PlayerStart[] {
  const byColor = new Map<number, number[]>();
  const add = (color: number, tile: number) => {
    const list = byColor.get(color) ?? [];
    list.push(tile);
    byColor.set(color, list);
  };
  for (const o of model.objects) {
    if (o.group === ObjectGroup.KINGDOM_HEROES) add(o.info.metadata[0], o.tile);
    if (o.group === ObjectGroup.KINGDOM_TOWNS) {
      const color = townColor(model.map, o.tile, o.uid);
      if (color < 6) add(color, o.tile);
    }
  }
  return [...byColor.entries()].sort((a, b) => a[0] - b[0]).map(([color, tiles]) => ({ color, tiles }));
}

// Color index of a town from its flags (6 = neutral), like Maps::getTownColorIndex.
export function townColor(map: MapFormat, tile: number, uid: number): number {
  const left = (map.tiles[tile - 1] as TileInfo).objects.find((o) => o.group === ObjectGroup.LANDSCAPE_FLAGS && o.id === uid);
  const right = (map.tiles[tile + 1] as TileInfo).objects.find((o) => o.group === ObjectGroup.LANDSCAPE_FLAGS && o.id === uid);
  const l = left ? getObjectInfo(ObjectGroup.LANDSCAPE_FLAGS, left.index).metadata[0] : 0;
  const r = right ? getObjectInfo(ObjectGroup.LANDSCAPE_FLAGS, right.index).metadata[0] : 0;
  return l === r ? l : -1;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  starts: PlayerStart[];
  unreachable: MapObjectRef[];
}

export interface ValidateOptions {
  // Report any two objects occupying the same tile (our generator never overlaps; hand-made maps often do).
  strictOverlaps?: boolean;
  // Object types that do not need to be reachable.
  ignoreTypes?: readonly number[];
  maxErrors?: number;
}

function describe(model: MovementModel, o: MapObjectRef): string {
  return `${o.info.typeName} (group ${o.group}, index ${o.index}) at ${model.grid.x(o.tile)},${model.grid.y(o.tile)}`;
}

export function validateMap(map: MapFormat, opts: ValidateOptions = {}): ValidationReport {
  const model = new MovementModel(map);
  const g = model.grid;
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxErrors = opts.maxErrors ?? 50;
  const error = (msg: string) => {
    if (errors.length < maxErrors) errors.push(msg);
  };

  // Overlaps.
  for (let t = 0; t < g.size; ++t) {
    const uids = model.occupiedBy[t] as number[];
    if (uids.length > 1) {
      const actionParts = uids.filter((u) => model.objects.some((o) => o.uid === u && o.info.isAction));
      if (opts.strictOverlaps || actionParts.length > 1) error(`Objects ${uids.join(', ')} overlap at ${g.x(t)},${g.y(t)}`);
    }
  }

  // Unique UIDs except for castle parts.
  const uidTiles = new Map<number, number>();
  for (let t = 0; t < g.size; ++t) {
    for (const o of (map.tiles[t] as TileInfo).objects) {
      if (o.group === ObjectGroup.LANDSCAPE_FLAGS || o.group === ObjectGroup.LANDSCAPE_TOWN_BASEMENTS) continue;
      if (uidTiles.has(o.id)) error(`Duplicate object UID ${o.id}`);
      uidTiles.set(o.id, t);
    }
  }

  const starts = playerStarts(model);
  if (starts.length === 0) error('No players on the map');

  const ignore = new Set<number>([objectTypes.OBJ_EVENT, ...(opts.ignoreTypes ?? [])]);
  const unreachable: MapObjectRef[] = [];
  for (const start of starts) {
    const r = reach(model, start.tiles, { boats: true });
    for (let i = 0; i < model.objects.length; ++i) {
      const o = model.objects[i] as MapObjectRef;
      if (!o.info.isAction || ignore.has(o.info.objectType)) continue;
      if (start.tiles.includes(o.tile)) continue;
      if (!r.visited.has(i)) {
        if (!unreachable.includes(o)) unreachable.push(o);
        error(`Player ${start.color}: ${describe(model, o)} is unreachable`);
      }
    }
  }

  // Castle entrances.
  for (const o of model.objects) {
    if (o.group !== ObjectGroup.KINGDOM_TOWNS) continue;
    let open = false;
    for (const d of NEIGHBOR_DIRECTIONS) {
      const n = g.neighbor(o.tile, reflect(d));
      if (n < 0 || model.water[n]) continue;
      if (model.canMove(n, d, false) === o.tile && !model.blocked[n]) open = true;
    }
    if (!open) error(`Castle at ${g.x(o.tile)},${g.y(o.tile)} has no open entrance`);
  }

  return { ok: errors.length === 0, errors, warnings, starts, unreachable };
}
