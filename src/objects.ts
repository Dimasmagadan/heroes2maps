// Typed query API over the extracted fheroes2 object table (src/data/objects.ts).
//
// Passability model (from fheroes2 Maps::Tile::getTileIndependentPassability and the editor rules):
//   - Ground parts on OBJECT_LAYER or BACKGROUND_LAYER occupy their tile. SHADOW_LAYER and TERRAIN_LAYER parts
//     (shadows, roads, streams, castle entrance road) do not affect passability. Top-level parts never do.
//   - A part whose object type is an action type (MP2 type & 128) is an action tile: heroes enter it only from
//     `entryDirections` and stop there. All other occupied tiles block movement.
//   - Flags (FLAG32) are fully passable.

import { icnTypes, objectTypes } from './data/enums.ts';
import { actionTypeFlags, objectData } from './data/objects.ts';
import { ObjectGroup } from './fh2m/types.ts';
import { DIRECTION_BOTTOM_ROW, DIRECTION_CENTER_ROW, reflect } from './grid.ts';
import { Ground } from './terrain/ground.ts';

export const Layer = {
  OBJECT: 0,
  BACKGROUND: 1,
  SHADOW: 2,
  TERRAIN: 3,
} as const;
export type Layer = (typeof Layer)[keyof typeof Layer];

export const ACTION_OBJECT_TYPE = 128;

export interface GroundPart {
  dx: number;
  dy: number;
  layer: Layer;
  objectType: number;
  icnType: number;
  icnIndex: number;
}

export interface TopPart {
  dx: number;
  dy: number;
  objectType: number;
  icnType: number;
  icnIndex: number;
}

export interface Offset {
  dx: number;
  dy: number;
}

export interface ObjectInfo {
  group: ObjectGroup;
  index: number;
  objectType: number;
  typeName: string; // MP2 type name without the OBJ_ prefix, e.g. 'MINE'
  metadata: readonly [number, number];
  groundParts: readonly GroundPart[];
  topParts: readonly TopPart[];
  isAction: boolean;
  // Tiles whose passability the object changes (OBJECT and BACKGROUND layers), relative to the main tile.
  occupied: readonly Offset[];
  // Occupied tiles that block movement (all occupied tiles except action tiles).
  blocked: readonly Offset[];
  // Action tiles (usually only the main tile).
  actionCells: readonly Offset[];
  // Directions from which action tiles can be entered (fheroes2 MP2::getActionObjectDirection), 0 if not an action object.
  entryDirections: number;
  // Tiles touched by any ground part except shadows (the editor's "used" tiles, which must satisfy terrain rules).
  used: readonly Offset[];
  // Bounding box of all parts, including shadows and top-level parts.
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  // Grounds the object's art fits (null = any). Water objects must be placed on water, all others on land.
  terrains: readonly Ground[] | null;
  water: boolean;
  // Uses art that exists only in The Price of Loyalty.
  expansion: boolean;
  isPickup: boolean;
  isCapture: boolean;
}

const typeNames = new Map<number, string>(Object.entries(objectTypes).map(([name, value]) => [value, name.replace(/^OBJ_/, '')]));
const actionFlags = new Map(actionTypeFlags.map((r) => [r[0], r]));

const EXPANSION_ICNS = new Set<number>([icnTypes.OBJ_ICN_TYPE_X_LOC1, icnTypes.OBJ_ICN_TYPE_X_LOC2, icnTypes.OBJ_ICN_TYPE_X_LOC3]);

// Terrain-specific art sets: the grounds an object drawn from this ICN looks natural on.
// Tree sets follow the choices of fheroes2's own random generator (treeTypeFromGroundType) plus close matches.
const ICN_TERRAINS = new Map<number, readonly Ground[]>([
  [icnTypes.OBJ_ICN_TYPE_MTNSNOW, [Ground.SNOW]],
  [icnTypes.OBJ_ICN_TYPE_TRESNOW, [Ground.SNOW]],
  [icnTypes.OBJ_ICN_TYPE_OBJNSNOW, [Ground.SNOW]],
  [icnTypes.OBJ_ICN_TYPE_MTNSWMP, [Ground.SWAMP]],
  [icnTypes.OBJ_ICN_TYPE_OBJNSWMP, [Ground.SWAMP]],
  [icnTypes.OBJ_ICN_TYPE_MTNLAVA, [Ground.LAVA]],
  [icnTypes.OBJ_ICN_TYPE_OBJNLAVA, [Ground.LAVA]],
  [icnTypes.OBJ_ICN_TYPE_OBJNLAV2, [Ground.LAVA]],
  [icnTypes.OBJ_ICN_TYPE_OBJNLAV3, [Ground.LAVA]],
  [icnTypes.OBJ_ICN_TYPE_MTNDSRT, [Ground.DESERT, Ground.BEACH]],
  [icnTypes.OBJ_ICN_TYPE_OBJNDSRT, [Ground.DESERT, Ground.BEACH]],
  [icnTypes.OBJ_ICN_TYPE_MTNDIRT, [Ground.DIRT]],
  [icnTypes.OBJ_ICN_TYPE_OBJNDIRT, [Ground.DIRT]],
  [icnTypes.OBJ_ICN_TYPE_MTNCRCK, [Ground.WASTELAND]],
  [icnTypes.OBJ_ICN_TYPE_OBJNCRCK, [Ground.WASTELAND]],
  [icnTypes.OBJ_ICN_TYPE_MTNGRAS, [Ground.GRASS]],
  [icnTypes.OBJ_ICN_TYPE_OBJNGRAS, [Ground.GRASS]],
  [icnTypes.OBJ_ICN_TYPE_OBJNGRA2, [Ground.GRASS]],
  [icnTypes.OBJ_ICN_TYPE_TREJNGL, [Ground.GRASS, Ground.SWAMP]],
  [icnTypes.OBJ_ICN_TYPE_TREEVIL, [Ground.LAVA, Ground.WASTELAND]],
  [icnTypes.OBJ_ICN_TYPE_TREFALL, [Ground.WASTELAND, Ground.DIRT]],
  [icnTypes.OBJ_ICN_TYPE_TREFIR, [Ground.DIRT, Ground.GRASS]],
  [icnTypes.OBJ_ICN_TYPE_TREDECI, [Ground.DESERT, Ground.BEACH, Ground.GRASS]],
]);

const WATER_GROUPS = new Set<number>([ObjectGroup.LANDSCAPE_WATER, ObjectGroup.ADVENTURE_WATER]);

function isActionType(type: number): boolean {
  return (type & ACTION_OBJECT_TYPE) === ACTION_OBJECT_TYPE;
}

function build(group: ObjectGroup, index: number): ObjectInfo {
  const raw = objectData[group]?.[index];
  if (!raw) throw new Error(`No object ${index} in group ${group}`);
  const [objectType, metadata, rawGround, rawTop] = raw;
  const groundParts: GroundPart[] = rawGround.map(([dx, dy, layer, type, icnType, icnIndex]) => ({
    dx,
    dy,
    layer: layer as Layer,
    objectType: type,
    icnType,
    icnIndex,
  }));
  const topParts: TopPart[] = rawTop.map(([dx, dy, type, icnType, icnIndex]) => ({ dx, dy, objectType: type, icnType, icnIndex }));

  const uniq = (offsets: Offset[]): Offset[] => {
    const seen = new Set<string>();
    return offsets.filter((o) => {
      const k = `${o.dx},${o.dy}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const isFlag = (p: GroundPart) => p.icnType === icnTypes.OBJ_ICN_TYPE_FLAG32;
  const occupied = uniq(groundParts.filter((p) => (p.layer === Layer.OBJECT || p.layer === Layer.BACKGROUND) && !isFlag(p)));
  const actionCells = uniq(groundParts.filter((p) => (p.layer === Layer.OBJECT || p.layer === Layer.BACKGROUND) && isActionType(p.objectType)));
  const isAction = isActionType(objectType);
  const blocked = occupied.filter((o) => !actionCells.some((a) => a.dx === o.dx && a.dy === o.dy));
  const used = uniq(groundParts.filter((p) => p.layer !== Layer.SHADOW));

  const all = [...groundParts, ...topParts];
  const bounds = {
    minX: Math.min(...all.map((p) => p.dx)),
    minY: Math.min(...all.map((p) => p.dy)),
    maxX: Math.max(...all.map((p) => p.dx)),
    maxY: Math.max(...all.map((p) => p.dy)),
  };

  let terrains: readonly Ground[] | null = null;
  for (const p of all) {
    const t = ICN_TERRAINS.get(p.icnType);
    if (t !== undefined) {
      terrains = t;
      break;
    }
  }
  const water = WATER_GROUPS.has(group);
  if (water) terrains = [Ground.WATER];

  const flags = actionFlags.get(objectType);
  let entryDirections = 0;
  if (isAction) entryDirections = flags?.[1] || DIRECTION_CENTER_ROW | DIRECTION_BOTTOM_ROW;
  // Random towns become real towns when the game starts, so they get castle passability.
  if (objectType === objectTypes.OBJ_RANDOM_CASTLE || objectType === objectTypes.OBJ_RANDOM_TOWN) {
    entryDirections = actionFlags.get(objectTypes.OBJ_CASTLE)?.[1] ?? DIRECTION_CENTER_ROW | DIRECTION_BOTTOM_ROW;
  }

  return {
    group,
    index,
    objectType,
    typeName: typeNames.get(objectType) ?? `TYPE_${objectType}`,
    metadata: [metadata[0] ?? 0, metadata[1] ?? 0],
    groundParts,
    topParts,
    isAction,
    occupied: occupied.map(({ dx, dy }) => ({ dx, dy })),
    blocked: blocked.map(({ dx, dy }) => ({ dx, dy })),
    actionCells: actionCells.map(({ dx, dy }) => ({ dx, dy })),
    entryDirections,
    used: used.map(({ dx, dy }) => ({ dx, dy })),
    bounds,
    terrains,
    water,
    expansion: all.some((p) => EXPANSION_ICNS.has(p.icnType)),
    isPickup: (flags?.[2] ?? 0) !== 0,
    isCapture: (flags?.[3] ?? 0) !== 0,
  };
}

const cache: ObjectInfo[][] = objectData.map(() => []);

export function getObjectInfo(group: ObjectGroup, index: number): ObjectInfo {
  const groupCache = cache[group];
  if (!groupCache) throw new Error(`Unknown object group ${group}`);
  return (groupCache[index] ??= build(group, index));
}

export function objectsByGroup(group: ObjectGroup): readonly ObjectInfo[] {
  const count = objectData[group]?.length ?? 0;
  const result: ObjectInfo[] = [];
  for (let i = 0; i < count; ++i) result.push(getObjectInfo(group, i));
  return result;
}

export function hasObject(group: number, index: number): boolean {
  return index >= 0 && index < (objectData[group]?.length ?? 0);
}

export interface ObjectQuery {
  group?: ObjectGroup;
  type?: number | string; // MP2 type value or name ('MINE' or 'OBJ_MINE')
  // Objects that fit this ground: objects with matching terrain art or terrain-neutral art (water objects only on water).
  terrain?: Ground;
  expansion?: boolean; // false = exclude Price of Loyalty art, true = only expansion art
  action?: boolean;
  where?: (info: ObjectInfo) => boolean;
}

export function typeValue(type: number | string): number {
  if (typeof type === 'number') return type;
  const key = type.startsWith('OBJ_') ? type : `OBJ_${type}`;
  const value = (objectTypes as Record<string, number>)[key];
  if (value === undefined) throw new Error(`Unknown object type ${type}`);
  return value;
}

export function fitsTerrain(info: ObjectInfo, ground: Ground): boolean {
  if ((ground === Ground.WATER) !== info.water) return false;
  return info.terrains === null || info.terrains.includes(ground);
}

export function findObjects(query: ObjectQuery): ObjectInfo[] {
  const groups = query.group !== undefined ? [query.group] : objectData.map((_, g) => g as ObjectGroup);
  const type = query.type !== undefined ? typeValue(query.type) : undefined;
  const result: ObjectInfo[] = [];
  for (const g of groups) {
    for (const info of objectsByGroup(g)) {
      if (type !== undefined && info.objectType !== type) continue;
      if (query.terrain !== undefined && !fitsTerrain(info, query.terrain)) continue;
      if (query.expansion !== undefined && info.expansion !== query.expansion) continue;
      if (query.action !== undefined && info.isAction !== query.action) continue;
      if (query.where && !query.where(info)) continue;
      result.push(info);
    }
  }
  return result;
}

// True if a hero can enter the action tile of `info` when moving in direction `moveDirection`.
// The tile is entered from the side opposite to the move.
export function canEnterAction(info: ObjectInfo, moveDirection: number): boolean {
  return (info.entryDirections & reflect(moveDirection)) !== 0;
}
