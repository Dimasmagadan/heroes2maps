// One-off extractor: builds src/data/*.ts from the fheroes2 C++ source.
//
// Usage: node scripts/extract-objects.ts <path-to-fheroes2-checkout>
//
// The object table in map_object_info.cpp is built by C++ code with loops and copies, so instead of parsing it
// we compile it together with a small dump program and read the result as JSON. Enum member names are parsed from
// headers with regular expressions, but their values are always computed by the compiler.
// Artifact levels live in a function that depends on game settings, so they are parsed from its switch statement.
//
// Requires clang++ (or $CXX) and SDL2 headers (fheroes2 engine headers include them).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('Usage: node scripts/extract-objects.ts <path-to-fheroes2-checkout>');
  process.exit(1);
}
const src = join(root, 'src', 'fheroes2');
const outDir = new URL('../src/data/', import.meta.url);
const read = (rel: string): string => readFileSync(join(src, rel), 'latin1');

// --- Enum parsing ---------------------------------------------------------------------------------------------

// Returns member names of the first enum block whose opening line matches `start`.
function enumMembers(text: string, start: RegExp): string[] {
  const m = start.exec(text);
  if (!m) throw new Error(`Enum not found: ${start}`);
  const open = text.indexOf('{', m.index);
  const close = text.indexOf('};', open);
  const body = text
    .slice(open + 1, close)
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const names: string[] = [];
  for (const line of body.split(/[,\n]/)) {
    const id = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=.*)?$/.exec(line);
    if (id?.[1]) names.push(id[1]);
  }
  return names;
}

interface EnumSpec {
  key: string;
  file: string;
  start: RegExp;
  scope: string;
}

const enums: EnumSpec[] = [
  { key: 'objectTypes', file: 'maps/mp2.h', start: /enum MapObjectType\b/, scope: 'MP2::' },
  { key: 'icnTypes', file: 'maps/mp2.h', start: /enum ObjectIcnType\b/, scope: 'MP2::' },
  { key: 'monsters', file: 'monster/monster.h', start: /enum MonsterType\b/, scope: 'Monster::' },
  { key: 'artifacts', file: 'resource/artifact.h', start: /enum : int32_t/, scope: 'Artifact::' },
  { key: 'races', file: 'kingdom/race.h', start: /enum\s*\n\s*\{/, scope: 'Race::' },
  { key: 'resources', file: 'resource/resource.h', start: /enum\s*\n\s*\{\s*\n\s*UNKNOWN = 0x00/, scope: 'Resource::' },
  { key: 'grounds', file: 'maps/ground.h', start: /enum : int32_t/, scope: 'Maps::Ground::' },
  { key: 'groundImageStart', file: 'maps/ground.h', start: /enum GroundImageStartIndex\b/, scope: 'Maps::Ground::' },
  { key: 'heroes', file: 'heroes/heroes.h', start: /enum : int32_t/, scope: 'Heroes::' },
  { key: 'buildings', file: 'castle/castle.h', start: /enum BuildingType\b/, scope: '' },
];

const enumNames = new Map<string, string[]>();
for (const e of enums) enumNames.set(e.key, enumMembers(read(e.file), e.start));

// --- Artifact levels (parsed from Artifact::Level / LoyaltyLevel) -----------------------------------------------

function switchCases(fnText: string): Map<string, string> {
  // Maps every `case X:` to the `return ART_...` that follows it.
  const result = new Map<string, string>();
  let pending: string[] = [];
  for (const line of fnText.split('\n')) {
    const c = /case\s+([A-Z_0-9]+)\s*:/.exec(line);
    if (c?.[1]) pending.push(c[1]);
    const r = /return\s+(?:\(.*\?\s*)?(ART_[A-Z_]+)/.exec(line);
    if (r?.[1] && pending.length > 0) {
      for (const p of pending) result.set(p, r[1]);
      pending = [];
    }
  }
  return result;
}

function functionBody(text: string, signature: string): string {
  const i = text.indexOf(signature);
  if (i < 0) throw new Error(`Function not found: ${signature}`);
  let depth = 0;
  for (let j = text.indexOf('{', i); j < text.length; ++j) {
    if (text[j] === '{') ++depth;
    else if (text[j] === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  throw new Error(`Unterminated function: ${signature}`);
}

const artifactCpp = read('resource/artifact.cpp');
const artifactLevel = switchCases(functionBody(artifactCpp, 'int Artifact::Level() const'));
const loyaltyLevel = switchCases(functionBody(artifactCpp, 'int Artifact::LoyaltyLevel() const'));
const ultimateArtifacts = [...switchCases(functionBody(artifactCpp, 'bool Artifact::isUltimate() const').replace('return true', 'return ART_ULTIMATE')).keys()];

// --- Dump program ---------------------------------------------------------------------------------------------

function enumTable(e: EnumSpec): string {
  const names = enumNames.get(e.key) ?? [];
  const rows = names.map((n) => `{ "${n}", static_cast<long long>( ${e.scope}${n} ) }`).join(',\n');
  return `{ const std::vector<std::pair<const char *, long long>> t = {\n${rows}\n}; out << "\\"${e.key}\\":"; dumpEnum( out, t ); out << ","; }`;
}

const dumpCpp = `
#include <iostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "artifact.h"
#include "castle.h"
#include "ground.h"
#include "heroes.h"
#include "map_object_info.h"
#include "monster.h"
#include "monster_info.h"
#include "mp2.h"
#include "race.h"
#include "resource.h"

static void dumpEnum( std::ostream & out, const std::vector<std::pair<const char *, long long>> & t )
{
    out << "[";
    for ( size_t i = 0; i < t.size(); ++i ) {
        out << ( i ? "," : "" ) << "[\\"" << t[i].first << "\\"," << t[i].second << "]";
    }
    out << "]";
}

static std::string jsonString( const char * s )
{
    std::string r = "\\"";
    for ( const char * p = s; p && *p; ++p ) {
        if ( *p == '"' || *p == '\\\\' ) r += '\\\\';
        r += *p;
    }
    return r + "\\"";
}

int main()
{
    std::ostringstream out;
    out << "{";
    ${enums.map(enumTable).join('\n    ')}

    out << "\\"objects\\":[";
    for ( int g = 0; g < static_cast<int>( Maps::ObjectGroup::GROUP_COUNT ); ++g ) {
        out << ( g ? "," : "" ) << "[";
        const auto & objects = Maps::getObjectsByGroup( static_cast<Maps::ObjectGroup>( g ) );
        for ( size_t i = 0; i < objects.size(); ++i ) {
            const auto & o = objects[i];
            out << ( i ? "," : "" ) << "{\\"type\\":" << static_cast<int>( o.objectType ) << ",\\"metadata\\":[" << o.metadata[0] << "," << o.metadata[1] << "],\\"ground\\":[";
            for ( size_t p = 0; p < o.groundLevelParts.size(); ++p ) {
                const auto & part = o.groundLevelParts[p];
                out << ( p ? "," : "" ) << "[" << part.tileOffset.x << "," << part.tileOffset.y << "," << static_cast<int>( part.layerType ) << ","
                    << static_cast<int>( part.objectType ) << "," << static_cast<int>( part.icnType ) << "," << part.icnIndex << "]";
            }
            out << "],\\"top\\":[";
            for ( size_t p = 0; p < o.topLevelParts.size(); ++p ) {
                const auto & part = o.topLevelParts[p];
                out << ( p ? "," : "" ) << "[" << part.tileOffset.x << "," << part.tileOffset.y << "," << static_cast<int>( part.objectType ) << ","
                    << static_cast<int>( part.icnType ) << "," << part.icnIndex << "]";
            }
            out << "]}";
        }
        out << "]";
    }
    out << "],";

    out << "\\"objectTypeFlags\\":[";
    {
        bool firstType = true;
        for ( int t = 0; t < 256; ++t ) {
            const auto type = static_cast<MP2::MapObjectType>( t );
            if ( !MP2::isOffGameActionObject( type ) ) continue;
            out << ( firstType ? "" : "," ) << "[" << t << "," << MP2::getActionObjectDirection( type ) << "," << MP2::isPickupObject( type ) << ","
                << MP2::isCaptureObject( type ) << "," << MP2::isWaterActionObject( type ) << "," << MP2::isInGameActionObject( type ) << "]";
            firstType = false;
        }
    }
    out << "],";

    out << "\\"monsterStats\\":[";
    bool first = true;
    for ( int id = Monster::PEASANT; id <= Monster::WATER_ELEMENT; ++id ) {
        const auto & d = fheroes2::getMonsterData( id );
        const auto & b = d.battleStats;
        const auto & s = d.generalStats;
        out << ( first ? "" : "," ) << "{\\"id\\":" << id << ",\\"name\\":" << jsonString( s.untranslatedName ) << ",\\"pluralName\\":" << jsonString( s.untranslatedPluralName )
            << ",\\"race\\":" << s.race << ",\\"level\\":" << s.level << ",\\"growth\\":" << s.baseGrowth << ",\\"attack\\":" << b.attack << ",\\"defense\\":" << b.defense
            << ",\\"damageMin\\":" << b.damageMin << ",\\"damageMax\\":" << b.damageMax << ",\\"hp\\":" << b.hp << ",\\"speed\\":" << b.speed << ",\\"shots\\":" << b.shots
            << ",\\"baseStrength\\":" << b.monsterBaseStrength << ",\\"strength\\":" << Monster( id ).GetMonsterStrength() << ",\\"gold\\":" << s.cost.gold
            << ",\\"randomLevel\\":" << static_cast<int>( Monster( id ).GetRandomUnitLevel() ) << "}";
        first = false;
    }
    out << "]}";

    std::cout << out.str() << std::endl;
    return 0;
}
`;

// --- Compile and run ------------------------------------------------------------------------------------------

function includeDirs(dir: string): string[] {
  const result = [dir];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) result.push(...includeDirs(p));
  }
  return result;
}

const work = mkdtempSync(join(tmpdir(), 'her2-extract-'));
writeFileSync(join(work, 'dump.cpp'), dumpCpp);
writeFileSync(join(work, 'stubs.cpp'), readFileSync(new URL('./extract-stubs.cpp', import.meta.url)));

const cxx = process.env['CXX'] ?? 'clang++';
const incs = [...includeDirs(src), ...includeDirs(join(root, 'src', 'engine'))].flatMap((d) => ['-I', d]);
const sdl = execFileSync('sh', ['-c', 'sdl2-config --cflags 2>/dev/null || echo -I/opt/homebrew/include/SDL2'], { encoding: 'utf8' }).trim().split(/\s+/);
const sources = [
  join(work, 'dump.cpp'),
  join(work, 'stubs.cpp'),
  join(src, 'maps/map_object_info.cpp'),
  join(src, 'monster/monster_info.cpp'),
  join(src, 'monster/monster.cpp'),
  join(src, 'maps/mp2.cpp'),
];
const exe = join(work, 'dump');
execFileSync(cxx, ['-std=c++17', '-O0', '-w', '-DNDEBUG', ...sdl, ...incs, ...sources, '-o', exe], { stdio: 'inherit' });
const dump = JSON.parse(execFileSync(exe, { encoding: 'utf8', maxBuffer: 1 << 28 })) as Record<string, unknown>;

// --- Emit TypeScript ------------------------------------------------------------------------------------------

type Pair = [string, number];
const pairs = (key: string): Pair[] => dump[key] as Pair[];
const record = (key: string): Record<string, number> => Object.fromEntries(pairs(key));

const header = (what: string) =>
  `// Generated by scripts/extract-objects.ts from fheroes2 (${what}). Do not edit by hand.\n// Source: https://github.com/ihhub/fheroes2 (GPL-2.0-or-later)\n\n`;

const version = readFileSync(join(root, 'version.txt'), 'utf8').trim();

// Enumerations.
const artifactNames = pairs('artifacts');
const artifactRows = artifactNames
  .filter(([name]) => name !== 'UNKNOWN' && name !== 'ARTIFACT_COUNT')
  .map(([name, id]) => {
    const level = ultimateArtifacts.includes(name) ? 'ART_ULTIMATE' : (artifactLevel.get(name) ?? 'ART_NONE');
    const expansion = level === 'ART_LOYALTY';
    const effective = expansion ? (loyaltyLevel.get(name) ?? 'ART_NONE') : level;
    const levelName = { ART_LEVEL_TREASURE: 'treasure', ART_LEVEL_MINOR: 'minor', ART_LEVEL_MAJOR: 'major', ART_ULTIMATE: 'ultimate', ART_NORANDOM: 'none', ART_NONE: 'none' }[effective];
    if (!levelName) throw new Error(`Unknown artifact level ${effective} for ${name}`);
    return `  { id: ${id}, name: '${name}', level: '${levelName}', expansion: ${expansion} },`;
  });

writeFileSync(
  new URL('enums.ts', outDir),
  header(`version ${version}: mp2.h, ground.h, race.h, resource.h, heroes.h, monster.h, artifact.h, castle.h`) +
    `export const FHEROES2_VERSION = '${version}';\n\n` +
    ['objectTypes', 'icnTypes', 'grounds', 'groundImageStart', 'races', 'resources', 'heroes', 'monsters', 'buildings']
      .map((k) => `export const ${k} = ${JSON.stringify(record(k), null, 2).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:')} as const;\n`)
      .join('\n') +
    `\nexport type ArtifactLevel = 'treasure' | 'minor' | 'major' | 'ultimate' | 'none';\n\n` +
    `// level 'none' means the artifact is never chosen randomly. expansion = The Price of Loyalty.\n` +
    `export const artifacts: readonly { id: number; name: string; level: ArtifactLevel; expansion: boolean }[] = [\n${artifactRows.join('\n')}\n];\n`,
);

// Monsters.
interface MonsterStat {
  randomLevel: number;
  id: number;
  name: string;
  pluralName: string;
  race: number;
  level: number;
  growth: number;
  attack: number;
  defense: number;
  damageMin: number;
  damageMax: number;
  hp: number;
  speed: number;
  shots: number;
  baseStrength: number;
  strength: number;
  gold: number;
}
const monsterStats = dump['monsterStats'] as MonsterStat[];
writeFileSync(
  new URL('monsters.ts', outDir),
  header(`version ${version}: monster_info.cpp`) +
    `// The Price of Loyalty adds no monsters, so there is no expansion flag here.\n` +
    `// strength = Monster::GetMonsterStrength() (attack/defense-adjusted base strength), the value fheroes2 uses for army strength.\n` +
    `// randomLevel = Monster::GetRandomUnitLevel(): the pool (1-4) a random monster of that level is drawn from.\n\n` +
    `export interface MonsterInfo {\n  id: number;\n  name: string;\n  pluralName: string;\n  race: number;\n  level: number;\n  growth: number;\n  attack: number;\n  defense: number;\n  damageMin: number;\n  damageMax: number;\n  hp: number;\n  speed: number;\n  shots: number;\n  baseStrength: number;\n  strength: number;\n  gold: number;\n  randomLevel: number;\n}\n\n` +
    `export const monsterInfo: readonly MonsterInfo[] = [\n${monsterStats.map((m) => `  { ${Object.entries(m).map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : v}`).join(', ')} },`).join('\n')}\n];\n`,
);

// Objects: compact rows, expanded by src/data/object-table.ts.
const objects = dump['objects'] as { type: number; metadata: number[]; ground: number[][]; top: number[][] }[][];
const lines = objects.map((group, g) => {
  const rows = group.map((o) => `    [${o.type}, ${JSON.stringify(o.metadata)}, ${JSON.stringify(o.ground)}, ${JSON.stringify(o.top)}],`);
  return `  // group ${g}\n  [\n${rows.join('\n')}\n  ],`;
});
writeFileSync(
  new URL('objects.ts', outDir),
  header(`version ${version}: map_object_info.cpp`) +
    `// objectData[group][index] = [objectType, metadata, groundParts, topParts]\n` +
    `//   groundPart = [dx, dy, layer, objectType, icnType, icnIndex]\n` +
    `//   topPart    = [dx, dy, objectType, icnType, icnIndex]\n` +
    `// Layers: 0 OBJECT, 1 BACKGROUND, 2 SHADOW, 3 TERRAIN.\n\n` +
    `export type RawGroundPart = readonly [number, number, number, number, number, number];\n` +
    `export type RawTopPart = readonly [number, number, number, number, number];\n` +
    `export type RawObject = readonly [number, readonly number[], readonly RawGroundPart[], readonly RawTopPart[]];\n\n` +
    `export const objectData: readonly (readonly RawObject[])[] = [\n${lines.join('\n')}\n];\n\n` +
    `// Per action object type (MP2 type >= 128): [type, entryDirections, isPickup, isCapture, isWaterAction, isInGameAction].\n` +
    `// entryDirections = MP2::getActionObjectDirection(): directions from which the action tile can be entered.\n` +
    `export const actionTypeFlags: readonly (readonly [number, number, number, number, number, number])[] = [\n${(dump['objectTypeFlags'] as number[][]).filter((r) => Object.values(record('objectTypes')).includes(r[0] as number)).map((r) => `  ${JSON.stringify(r)},`).join('\n')}\n];\n`,
);

console.log(`Wrote src/data/{enums,monsters,objects}.ts from fheroes2 ${version}: ${objects.map((g) => g.length).join('/')} objects per group`);
