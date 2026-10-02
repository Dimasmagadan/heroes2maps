import { deflateSync, inflateSync } from 'node:zlib';
import { Reader, Writer } from './stream.ts';
import {
  FORMAT_VERSION,
  type AdventureMapEventMetadata,
  type ArtifactMetadata,
  type BaseMapFormat,
  type CapturableObjectMetadata,
  type CastleMetadata,
  type DailyEvent,
  type Funds,
  type HeroMetadata,
  type MapFormat,
  type ObjectGroup,
  type MonsterMetadata,
  type ResourceMetadata,
  type SelectionObjectMetadata,
  type SignMetadata,
  type SphinxMetadata,
  type TileInfo,
  type TileObjectInfo,
  type TranslationBaseMapMetadata,
  type TranslationFormat,
  type TranslationSphinxMetadata,
} from './types.ts';

const MAGIC = Uint8Array.from([0x68, 0x32, 0x6d, 0x61, 0x70, 0x00]); // "h2map\0"
const MIN_FILE_SIZE = 512;

type Read<T> = (r: Reader) => T;
type Write<T> = (w: Writer, v: T) => void;

const rU8: Read<number> = (r) => r.u8();
const rI8: Read<number> = (r) => r.i8();
const rU32: Read<number> = (r) => r.u32();
const rI32: Read<number> = (r) => r.i32();
const rStr: Read<string> = (r) => r.string();
const wU8: Write<number> = (w, v) => void w.u8(v);
const wI8: Write<number> = (w, v) => void w.i8(v);
const wU32: Write<number> = (w, v) => void w.u32(v);
const wI32: Write<number> = (w, v) => void w.i32(v);
const wStr: Write<string> = (w, v) => void w.string(v);

const readFunds: Read<Funds> = (r) => ({
  wood: r.i32(),
  mercury: r.i32(),
  ore: r.i32(),
  sulfur: r.i32(),
  crystal: r.i32(),
  gems: r.i32(),
  gold: r.i32(),
});
const writeFunds: Write<Funds> = (w, f) => {
  w.i32(f.wood).i32(f.mercury).i32(f.ore).i32(f.sulfur).i32(f.crystal).i32(f.gems).i32(f.gold);
};

const readObject: Read<TileObjectInfo> = (r) => ({ id: r.u32(), group: r.u8() as ObjectGroup, index: r.u32() });
const writeObject: Write<TileObjectInfo> = (w, o) => void w.u32(o.id).u8(o.group).u32(o.index);

const readTile: Read<TileInfo> = (r) => ({
  terrainIndex: r.u16(),
  terrainFlags: r.u8(),
  objects: r.vec(readObject),
});
const writeTile: Write<TileInfo> = (w, t) => {
  w.u16(t.terrainIndex).u8(t.terrainFlags).vec(t.objects, writeObject);
};

const readDailyEvent: Read<DailyEvent> = (r) => ({
  message: r.string(),
  humanPlayerColors: r.u8(),
  computerPlayerColors: r.u8(),
  firstOccurrenceDay: r.u32(),
  repeatPeriodInDays: r.u32(),
  resources: readFunds(r),
});
const writeDailyEvent: Write<DailyEvent> = (w, e) => {
  w.string(e.message).u8(e.humanPlayerColors).u8(e.computerPlayerColors).u32(e.firstOccurrenceDay).u32(e.repeatPeriodInDays);
  writeFunds(w, e.resources);
};

const readCastle: Read<CastleMetadata> = (r) => ({
  customName: r.string(),
  defenderMonsterType: r.array(5, rI32),
  defenderMonsterCount: r.array(5, rI32),
  customBuildings: r.bool(),
  builtBuildings: r.vec(rU32),
  bannedBuildings: r.vec(rU32),
  mustHaveSpells: r.map(rU8, rI32),
  bannedSpells: r.vec(rI32),
  availableToHireMonsterCount: r.array(6, rI32),
});
const writeCastle: Write<CastleMetadata> = (w, c) => {
  w.string(c.customName).array(5, c.defenderMonsterType, wI32).array(5, c.defenderMonsterCount, wI32).bool(c.customBuildings);
  w.vec(c.builtBuildings, wU32).vec(c.bannedBuildings, wU32).map(c.mustHaveSpells, wU8, wI32).vec(c.bannedSpells, wI32);
  w.array(6, c.availableToHireMonsterCount, wI32);
};

const readHero: Read<HeroMetadata> = (r) => ({
  customName: r.string(),
  customPortrait: r.i32(),
  armyMonsterType: r.array(5, rI32),
  armyMonsterCount: r.array(5, rI32),
  artifact: r.array(14, rI32),
  artifactMetadata: r.array(14, rI32),
  availableSpells: r.vec(rI32),
  isOnPatrol: r.bool(),
  patrolRadius: r.u8(),
  secondarySkill: r.array(8, rI8),
  secondarySkillLevel: r.array(8, rU8),
  customLevel: r.i16(),
  customExperience: r.i32(),
  customAttack: r.i16(),
  customDefense: r.i16(),
  customKnowledge: r.i16(),
  customSpellPower: r.i16(),
  magicPoints: r.i16(),
  race: r.u8(),
});
const writeHero: Write<HeroMetadata> = (w, h) => {
  w.string(h.customName).i32(h.customPortrait).array(5, h.armyMonsterType, wI32).array(5, h.armyMonsterCount, wI32);
  w.array(14, h.artifact, wI32).array(14, h.artifactMetadata, wI32).vec(h.availableSpells, wI32);
  w.bool(h.isOnPatrol).u8(h.patrolRadius).array(8, h.secondarySkill, wI8).array(8, h.secondarySkillLevel, wU8);
  w.i16(h.customLevel).i32(h.customExperience).i16(h.customAttack).i16(h.customDefense).i16(h.customKnowledge).i16(h.customSpellPower);
  w.i16(h.magicPoints).u8(h.race);
};

const readSphinx: Read<SphinxMetadata> = (r) => ({
  riddle: r.string(),
  answers: r.vec(rStr),
  artifact: r.i32(),
  artifactMetadata: r.i32(),
  resources: readFunds(r),
});
const writeSphinx: Write<SphinxMetadata> = (w, s) => {
  w.string(s.riddle).vec(s.answers, wStr).i32(s.artifact).i32(s.artifactMetadata);
  writeFunds(w, s.resources);
};

const readSign: Read<SignMetadata> = (r) => ({ message: r.string() });
const writeSign: Write<SignMetadata> = (w, s) => void w.string(s.message);

const readEvent: Read<AdventureMapEventMetadata> = (r) => ({
  message: r.string(),
  humanPlayerColors: r.u8(),
  computerPlayerColors: r.u8(),
  isRecurringEvent: r.bool(),
  artifact: r.i32(),
  artifactMetadata: r.i32(),
  resources: readFunds(r),
  attack: r.i16(),
  defense: r.i16(),
  knowledge: r.i16(),
  spellPower: r.i16(),
  experience: r.i32(),
  secondarySkill: r.u8(),
  secondarySkillLevel: r.u8(),
  monsterType: r.i32(),
  monsterCount: r.i32(),
});
const writeEvent: Write<AdventureMapEventMetadata> = (w, e) => {
  w.string(e.message).u8(e.humanPlayerColors).u8(e.computerPlayerColors).bool(e.isRecurringEvent).i32(e.artifact).i32(e.artifactMetadata);
  writeFunds(w, e.resources);
  w.i16(e.attack).i16(e.defense).i16(e.knowledge).i16(e.spellPower).i32(e.experience);
  w.u8(e.secondarySkill).u8(e.secondarySkillLevel).i32(e.monsterType).i32(e.monsterCount);
};

const readSelection: Read<SelectionObjectMetadata> = (r) => ({ selectedItems: r.vec(rI32) });
const writeSelection: Write<SelectionObjectMetadata> = (w, s) => void w.vec(s.selectedItems, wI32);

const readCapturable: Read<CapturableObjectMetadata> = (r) => ({ ownerColor: r.u8() });
const writeCapturable: Write<CapturableObjectMetadata> = (w, c) => void w.u8(c.ownerColor);

const readMonster: Read<MonsterMetadata> = (r) => ({
  count: r.i32(),
  joinCondition: r.i32(),
  isWeeklyGrowthDisabled: r.bool(),
  selected: r.vec(rI32),
});
const writeMonster: Write<MonsterMetadata> = (w, m) => {
  w.i32(m.count).i32(m.joinCondition).bool(m.isWeeklyGrowthDisabled).vec(m.selected, wI32);
};

const readArtifact: Read<ArtifactMetadata> = (r) => ({
  radius: r.i32(),
  captureCondition: r.i32(),
  selected: r.vec(rI32),
});
const writeArtifact: Write<ArtifactMetadata> = (w, a) => {
  w.i32(a.radius).i32(a.captureCondition).vec(a.selected, wI32);
};

const readResource: Read<ResourceMetadata> = (r) => ({ count: r.i32() });
const writeResource: Write<ResourceMetadata> = (w, m) => void w.i32(m.count);

const readTranslationSphinx: Read<TranslationSphinxMetadata> = (r) => ({ riddle: r.string(), answers: r.vec(rStr) });
const writeTranslationSphinx: Write<TranslationSphinxMetadata> = (w, s) => void w.string(s.riddle).vec(s.answers, wStr);

const readTranslationBase: Read<TranslationBaseMapMetadata> = (r) => ({
  name: r.string(),
  description: r.string(),
  creatorNotes: r.string(),
});
const writeTranslationBase: Write<TranslationBaseMapMetadata> = (w, t) => {
  w.string(t.name).string(t.description).string(t.creatorNotes);
};

const readTranslation: Read<TranslationFormat> = (r) => ({
  dailyEvents: r.vec(rStr),
  rumors: r.vec(rStr),
  castleMetadata: r.map(rU32, rStr),
  heroMetadata: r.map(rU32, rStr),
  sphinxMetadata: r.map(rU32, readTranslationSphinx),
  signMetadata: r.map(rU32, rStr),
  adventureMapEventMetadata: r.map(rU32, rStr),
});
const writeTranslation: Write<TranslationFormat> = (w, t) => {
  w.vec(t.dailyEvents, wStr).vec(t.rumors, wStr).map(t.castleMetadata, wU32, wStr).map(t.heroMetadata, wU32, wStr);
  w.map(t.sphinxMetadata, wU32, writeTranslationSphinx).map(t.signMetadata, wU32, wStr).map(t.adventureMapEventMetadata, wU32, wStr);
};

function readBase(r: Reader): BaseMapFormat {
  const version = r.u16();
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported .fh2m version ${version} (only ${FORMAT_VERSION} is supported)`);
  }
  const map: BaseMapFormat = {
    version,
    isCampaign: r.bool(),
    difficulty: r.u8(),
    availablePlayerColors: r.u8(),
    humanPlayerColors: r.u8(),
    computerPlayerColors: r.u8(),
    alliances: r.vec(rU8),
    playerRace: r.array(6, rU8),
    victoryConditionType: r.u8(),
    isVictoryConditionApplicableForAI: r.bool(),
    allowNormalVictory: r.bool(),
    victoryConditionMetadata: r.vec(rU32),
    lossConditionType: r.u8(),
    lossConditionMetadata: r.vec(rU32),
    width: r.i32(),
    mainLanguage: r.u8(),
    name: r.string(),
    description: r.string(),
    creatorNotes: r.string(),
    translations: r.map(rU8, readTranslationBase),
  };
  if (map.width <= 0) throw new Error(`Invalid map width ${map.width}`);
  return map;
}

function writeBase(w: Writer, m: BaseMapFormat): void {
  w.u16(FORMAT_VERSION).bool(m.isCampaign).u8(m.difficulty).u8(m.availablePlayerColors).u8(m.humanPlayerColors).u8(m.computerPlayerColors);
  w.vec(m.alliances, wU8).array(6, m.playerRace, wU8).u8(m.victoryConditionType).bool(m.isVictoryConditionApplicableForAI).bool(m.allowNormalVictory);
  w.vec(m.victoryConditionMetadata, wU32).u8(m.lossConditionType).vec(m.lossConditionMetadata, wU32).i32(m.width).u8(m.mainLanguage);
  w.string(m.name).string(m.description).string(m.creatorNotes).map(m.translations, wU8, writeTranslationBase);
}

function readBody(r: Reader, base: BaseMapFormat): MapFormat {
  const additionalInfo = r.vec(rU32);
  const tiles = r.vec(readTile);
  if (tiles.length !== base.width * base.width) throw new Error('Tile count does not match map width');
  return {
    ...base,
    additionalInfo,
    tiles,
    dailyEvents: r.vec(readDailyEvent),
    rumors: r.vec(rStr),
    castleMetadata: r.map(rU32, readCastle),
    heroMetadata: r.map(rU32, readHero),
    sphinxMetadata: r.map(rU32, readSphinx),
    signMetadata: r.map(rU32, readSign),
    adventureMapEventMetadata: r.map(rU32, readEvent),
    selectionObjectMetadata: r.map(rU32, readSelection),
    capturableObjectsMetadata: r.map(rU32, readCapturable),
    monsterMetadata: r.map(rU32, readMonster),
    artifactMetadata: r.map(rU32, readArtifact),
    resourceMetadata: r.map(rU32, readResource),
    translationInfo: r.map(rU8, readTranslation),
  };
}

// The part of the file that fheroes2 compresses with zlib, before compression.
export function encodeBody(m: MapFormat): Uint8Array {
  const w = new Writer();
  w.vec(m.additionalInfo, wU32).vec(m.tiles, writeTile).vec(m.dailyEvents, writeDailyEvent).vec(m.rumors, wStr);
  w.map(m.castleMetadata, wU32, writeCastle).map(m.heroMetadata, wU32, writeHero).map(m.sphinxMetadata, wU32, writeSphinx);
  w.map(m.signMetadata, wU32, writeSign).map(m.adventureMapEventMetadata, wU32, writeEvent).map(m.selectionObjectMetadata, wU32, writeSelection);
  w.map(m.capturableObjectsMetadata, wU32, writeCapturable).map(m.monsterMetadata, wU32, writeMonster);
  w.map(m.artifactMetadata, wU32, writeArtifact).map(m.resourceMetadata, wU32, writeResource).map(m.translationInfo, wU8, writeTranslation);
  return w.toBytes();
}

function readHeader(file: Uint8Array): { base: BaseMapFormat; reader: Reader } {
  if (file.length < MIN_FILE_SIZE) throw new Error('File is too small to be a .fh2m map');
  const reader = new Reader(file);
  const magic = reader.bytes(MAGIC.length);
  if (!MAGIC.every((b, i) => magic[i] === b)) throw new Error('Not a .fh2m file (bad magic)');
  return { base: readBase(reader), reader };
}

// Returns the decompressed zlib part of a file (everything after the uncompressed base header).
export function inflateBody(file: Uint8Array): Uint8Array {
  return new Uint8Array(inflateSync(readHeader(file).reader.rest()));
}

export function decodeMap(file: Uint8Array): MapFormat {
  const { base, reader } = readHeader(file);
  const body = new Reader(inflateSync(reader.rest()));
  const map = readBody(body, base);
  if (body.remaining !== 0) throw new Error(`${body.remaining} unread bytes at the end of the map body`);
  return map;
}

export function encodeMap(m: MapFormat): Uint8Array {
  const w = new Writer();
  w.raw(MAGIC);
  writeBase(w, m);
  w.raw(deflateSync(encodeBody(m)));
  const out = w.toBytes();
  if (out.length < MIN_FILE_SIZE) {
    // fheroes2 rejects files smaller than this.
    throw new Error(`Encoded map is ${out.length} bytes, fheroes2 requires at least ${MIN_FILE_SIZE}`);
  }
  return out;
}
