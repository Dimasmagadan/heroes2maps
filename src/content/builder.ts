// MapBuilder: owns the MapFormat being generated, allocates object UIDs, creates per-object metadata the way
// the fheroes2 editor does (Maps::addObjectToMap) and tracks which tiles are taken.
//
// Placement rules (see canPlace):
//   - every ground part except shadows and every top-level part must lie inside the map;
//   - occupied tiles (OBJECT/BACKGROUND layers) must be free and not reserved;
//   - all non-shadow ground parts must be on land (on water for water objects), like the editor requires;
//   - action objects that are entered from below need a free, non-reserved land tile below the action tile,
//     which then gets reserved so nothing blocks the entrance later.

import { ObjectGroup, type CastleMetadata, type HeroMetadata, type MapFormat, type TileInfo } from '../fh2m/types.ts';
import { FORMAT_VERSION } from '../fh2m/types.ts';
import { Grid } from '../grid.ts';
import { getObjectInfo, type ObjectInfo } from '../objects.ts';
import type { Rng } from '../rng.ts';
import { Ground } from '../terrain/ground.ts';
import { RoadEditor } from '../terrain/roads.ts';
import { TerrainEditor, tileGround } from '../terrain/transitions.ts';
import { buildings, objectTypes, races } from '../data/enums.ts';
import { DIRECTION_ALL } from '../grid.ts';

export const Reserve = {
  NONE: 0,
  ROAD: 1, // road or corridor tile that must stay passable
  ACCESS: 2, // entrance tile of an action object
  KEEP_CLEAR: 3, // generic "do not put obstacles here"
} as const;

export interface PlacedObject {
  uid: number;
  group: ObjectGroup;
  index: number;
  tile: number;
  info: ObjectInfo;
  tag?: string;
}


const raceByIndex = [races.KNGT, races.BARB, races.SORC, races.WRLK, races.WZRD, races.NECR, races.MULT, races.RAND];

export function emptyMap(width: number): MapFormat {
  const tiles: TileInfo[] = [];
  for (let i = 0; i < width * width; ++i) tiles.push({ terrainIndex: 16, terrainFlags: 0, objects: [] });
  return {
    version: FORMAT_VERSION,
    isCampaign: false,
    difficulty: 1,
    availablePlayerColors: 0,
    humanPlayerColors: 0,
    computerPlayerColors: 0,
    alliances: [],
    playerRace: [0, 0, 0, 0, 0, 0],
    victoryConditionType: 0,
    isVictoryConditionApplicableForAI: false,
    allowNormalVictory: false,
    victoryConditionMetadata: [],
    lossConditionType: 0,
    lossConditionMetadata: [],
    width,
    mainLanguage: 0,
    name: '',
    description: '',
    creatorNotes: '',
    translations: new Map(),
    additionalInfo: [],
    tiles,
    dailyEvents: [],
    rumors: [],
    castleMetadata: new Map(),
    heroMetadata: new Map(),
    sphinxMetadata: new Map(),
    signMetadata: new Map(),
    adventureMapEventMetadata: new Map(),
    selectionObjectMetadata: new Map(),
    capturableObjectsMetadata: new Map(),
    monsterMetadata: new Map(),
    artifactMetadata: new Map(),
    resourceMetadata: new Map(),
    translationInfo: new Map(),
  };
}

export function defaultCastleMetadata(): CastleMetadata {
  return {
    customName: '',
    defenderMonsterType: [0, 0, 0, 0, 0],
    defenderMonsterCount: [0, 0, 0, 0, 0],
    customBuildings: false,
    builtBuildings: [],
    bannedBuildings: [],
    mustHaveSpells: new Map(),
    bannedSpells: [],
    availableToHireMonsterCount: [-1, 0, 0, 0, 0, 0],
  };
}

export function defaultHeroMetadata(race: number): HeroMetadata {
  return {
    customName: '',
    customPortrait: 0,
    armyMonsterType: [0, 0, 0, 0, 0],
    armyMonsterCount: [0, 0, 0, 0, 0],
    artifact: new Array(14).fill(0),
    artifactMetadata: new Array(14).fill(0),
    availableSpells: [],
    isOnPatrol: false,
    patrolRadius: 0,
    secondarySkill: new Array(8).fill(0),
    secondarySkillLevel: new Array(8).fill(0),
    customLevel: -1,
    customExperience: -1,
    customAttack: -1,
    customDefense: -1,
    customKnowledge: -1,
    customSpellPower: -1,
    magicPoints: -1,
    race,
  };
}

export interface PlaceOptions {
  // Skip the terrain-art check (objects whose art does not match the ground are still allowed by the game).
  anyTerrain?: boolean;
  // Allow occupied tiles on reserved tiles of these kinds.
  allowReserved?: readonly number[];
  // Do not reserve the entrance tile.
  noAccess?: boolean;
  // Allow non-shadow parts outside the map (non-action objects only, as the editor does).
  allowOutside?: boolean;
  tag?: string;
}

export class MapBuilder {
  readonly map: MapFormat;
  readonly grid: Grid;
  readonly rng: Rng;
  readonly terrain: TerrainEditor;
  readonly roads: RoadEditor;
  // UID of the object occupying a tile (OBJECT/BACKGROUND layer parts), 0 if none.
  readonly occupant: Int32Array;
  readonly reserved: Uint8Array;
  readonly objects = new Map<number, PlacedObject>();
  private lastUid = 0;

  constructor(width: number, rng: Rng) {
    this.map = emptyMap(width);
    this.grid = new Grid(width);
    this.rng = rng;
    this.terrain = new TerrainEditor(this.map, rng.fork('terrain-images'));
    this.roads = new RoadEditor(this.map, rng.fork('road-sprites'), (tile, group, index) => {
      this.addObject(tile, group, index, this.newUid());
    });
    this.occupant = new Int32Array(this.grid.size);
    this.reserved = new Uint8Array(this.grid.size);
  }

  newUid(): number {
    return ++this.lastUid;
  }

  ground(index: number): Ground {
    return tileGround(this.map.tiles[index] as TileInfo);
  }

  isWater(index: number): boolean {
    return this.ground(index) === Ground.WATER;
  }

  tile(index: number): TileInfo {
    return this.map.tiles[index] as TileInfo;
  }

  isFree(index: number): boolean {
    return this.occupant[index] === 0;
  }

  // Adds a map object record (TileObjectInfo) and its default metadata, like Maps::addObjectToMap.
  addObject(tileIndex: number, group: ObjectGroup, index: number, uid: number): void {
    this.tile(tileIndex).objects.push({ id: uid, group, index });
    const info = getObjectInfo(group, index);
    const m = this.map;
    switch (group) {
      case ObjectGroup.KINGDOM_HEROES:
        m.heroMetadata.set(uid, defaultHeroMetadata(raceByIndex[info.metadata[1]] ?? races.RAND));
        break;
      case ObjectGroup.KINGDOM_TOWNS: {
        const c = defaultCastleMetadata();
        c.builtBuildings.push(info.metadata[1] === 0 ? buildings.BUILD_TENT : buildings.BUILD_CASTLE);
        m.castleMetadata.set(uid, c);
        break;
      }
      case ObjectGroup.MONSTERS:
        m.monsterMetadata.set(uid, { count: 0, joinCondition: 0, isWeeklyGrowthDisabled: false, selected: [] });
        break;
      case ObjectGroup.ADVENTURE_ARTIFACTS:
        m.artifactMetadata.set(uid, { radius: 0, captureCondition: 0, selected: [] });
        break;
      case ObjectGroup.ADVENTURE_MISCELLANEOUS:
        if (info.objectType === objectTypes.OBJ_JAIL) m.heroMetadata.set(uid, defaultHeroMetadata(races.RAND));
        else if (info.objectType === objectTypes.OBJ_EVENT) {
          m.adventureMapEventMetadata.set(uid, {
            message: '',
            humanPlayerColors: 0,
            computerPlayerColors: 0,
            isRecurringEvent: false,
            artifact: 0,
            artifactMetadata: 0,
            resources: { wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 0 },
            attack: 0,
            defense: 0,
            knowledge: 0,
            spellPower: 0,
            experience: 0,
            secondarySkill: 0,
            secondarySkillLevel: 0,
            monsterType: 0,
            monsterCount: 0,
          });
        } else if (info.objectType === objectTypes.OBJ_SIGN) m.signMetadata.set(uid, { message: '' });
        else if (info.objectType === objectTypes.OBJ_SPHINX) {
          m.sphinxMetadata.set(uid, { riddle: '', answers: [], artifact: 0, artifactMetadata: 0, resources: { wood: 0, mercury: 0, ore: 0, sulfur: 0, crystal: 0, gems: 0, gold: 0 } });
        }
        break;
      case ObjectGroup.ADVENTURE_WATER:
        if (info.objectType === objectTypes.OBJ_BOTTLE) m.signMetadata.set(uid, { message: '' });
        break;
      default:
        break;
    }
  }

  // Whether `info` can be placed with its main tile at (x, y).
  canPlace(info: ObjectInfo, x: number, y: number, opts: PlaceOptions = {}): boolean {
    const g = this.grid;
    const allowed = opts.allowReserved ?? [];
    const outsideOk = opts.allowOutside === true && !info.isAction;
    for (const p of info.groundParts) {
      if (p.layer === 2) continue; // shadows may hang over the edge
      const px = x + p.dx;
      const py = y + p.dy;
      if (!g.inside(px, py)) {
        if (outsideOk) continue;
        return false;
      }
      const i = g.index(px, py);
      if ((this.ground(i) === Ground.WATER) !== info.water) return false;
    }
    for (const p of info.topParts) {
      if (!g.inside(x + p.dx, y + p.dy) && !outsideOk) return false;
    }
    for (const o of info.occupied) {
      const px = x + o.dx;
      const py = y + o.dy;
      if (!g.inside(px, py)) continue;
      const i = g.index(px, py);
      if (this.occupant[i] !== 0) return false;
      const r = this.reserved[i] as number;
      if (r !== Reserve.NONE && !allowed.includes(r)) return false;
    }
    if (!opts.anyTerrain && info.terrains !== null && !info.terrains.includes(this.ground(g.index(x, y)))) return false;

    if (info.isAction && !opts.noAccess && needsAccessBelow(info)) {
      for (const a of info.actionCells) {
        const ax = x + a.dx;
        const ay = y + a.dy + 1;
        if (!g.inside(ax, ay)) return false;
        const i = g.index(ax, ay);
        if (this.occupant[i] !== 0 || this.isWater(i)) return false;
      }
    }
    return true;
  }

  // Places an object (main tile at x, y) without checks. Returns the placed object.
  forcePlace(group: ObjectGroup, index: number, x: number, y: number, opts: PlaceOptions = {}, uid = this.newUid()): PlacedObject {
    const info = getObjectInfo(group, index);
    const tile = this.grid.index(x, y);
    this.addObject(tile, group, index, uid);
    for (const o of info.occupied) {
      const px = x + o.dx;
      const py = y + o.dy;
      if (this.grid.inside(px, py)) this.occupant[this.grid.index(px, py)] = uid;
    }
    if (info.isAction && !opts.noAccess && needsAccessBelow(info)) {
      for (const a of info.actionCells) {
        const ax = x + a.dx;
        const ay = y + a.dy + 1;
        if (this.grid.inside(ax, ay)) this.reserve(this.grid.index(ax, ay), Reserve.ACCESS);
      }
    }
    const placed: PlacedObject = { uid, group, index, tile, info, ...(opts.tag !== undefined ? { tag: opts.tag } : {}) };
    // Several records (castle basement + town + flags) can share one UID; keep the main one.
    if (!this.objects.has(uid) || group === ObjectGroup.KINGDOM_TOWNS) this.objects.set(uid, placed);
    return placed;
  }

  place(group: ObjectGroup, index: number, x: number, y: number, opts: PlaceOptions = {}): PlacedObject | null {
    const info = getObjectInfo(group, index);
    if (!this.canPlace(info, x, y, opts)) return null;
    return this.forcePlace(group, index, x, y, opts);
  }

  reserve(index: number, kind: number): void {
    if (this.reserved[index] === Reserve.NONE || kind === Reserve.ACCESS) this.reserved[index] = kind;
  }

  // Removes an object placed by this builder (all records with its UID).
  remove(uid: number): void {
    const placed = this.objects.get(uid);
    if (!placed) return;
    for (const t of this.map.tiles) {
      if (t.objects.some((o) => o.id === uid)) t.objects = t.objects.filter((o) => o.id !== uid);
    }
    for (let i = 0; i < this.occupant.length; ++i) if (this.occupant[i] === uid) this.occupant[i] = 0;
    const m = this.map;
    for (const meta of [
      m.castleMetadata,
      m.heroMetadata,
      m.sphinxMetadata,
      m.signMetadata,
      m.adventureMapEventMetadata,
      m.selectionObjectMetadata,
      m.capturableObjectsMetadata,
      m.monsterMetadata,
      m.artifactMetadata,
      m.resourceMetadata,
    ] as Map<number, unknown>[]) {
      meta.delete(uid);
    }
    this.objects.delete(uid);
  }
}

// Objects entered only from the sides and below (most buildings) need the tile below kept free.
// Pickups, monsters and other "stand in front" objects can be entered from every direction.
export function needsAccessBelow(info: ObjectInfo): boolean {
  return info.entryDirections !== DIRECTION_ALL;
}
