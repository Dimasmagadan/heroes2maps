// Command-line interface.
//
//   node src/cli.ts generate --seed 123 --size 72 --players 4 --water medium --difficulty normal --out out/my_map.fh2m
//   node src/cli.ts preview <map.fh2m> [--out preview.png] [--ascii]
//   node src/cli.ts summary <map.fh2m>
//   node src/cli.ts validate <map.fh2m>
//   node src/cli.ts check <map.fh2m>          (needs $FH2CHECK, see scripts/build-fh2check.sh)
//   node src/cli.ts install <map.fh2m>

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeMap, encodeMap } from './fh2m/codec.ts';
import type { MapFormat } from './fh2m/types.ts';
import { compareWithGame, findChecker, runGameCheck } from './fh2check.ts';
import { generate } from './generate.ts';
import { DIFFICULTIES, MAP_SIZES, PLAYER_LIMITS, PRESETS, RACES, TEMPLATES, VICTORY_CONDITIONS, WATER_LEVELS, type GeneratorOptions } from './options.ts';
import { renderAscii, renderPng } from './preview/render.ts';
import { formatStats, mapStats } from './summary.ts';
import { validateMap } from './validate.ts';

const USAGE = `Usage:
  node src/cli.ts generate [options]
      --seed <n>            random seed (default: random)
      --size <n>            map size: ${MAP_SIZES.join(', ')} (default 72)
      --players <n>         total players, human included (allowed per size: ${MAP_SIZES.map((s) => `${s}: ${PLAYER_LIMITS[s].join('-')}`).join(', ')})
      --water <level>       ${WATER_LEVELS.join(', ')} (default low)
      --difficulty <d>      ${DIFFICULTIES.join(', ')} (default normal)
      --preset <p>          ${PRESETS.join(', ')} (default continent)
      --template <t>        ${TEMPLATES.join(', ')}; random picks one per seed (see "Templates" in the README)
      --race <r>            human player's faction: ${RACES.join(', ')} (default random); necromancer also tunes the map
      --victory <v>         ${VICTORY_CONDITIONS.join(', ')} (default normal)
      --expansion           include The Price of Loyalty objects and artifacts
      --teams               two alliances in-game (human vs all computers), rich walled-in computer team behind one huge guard (4+ players)
      --twist               mid-game twist: computers get a windfall on day 21, a guarded crypt holds the human's counter
      --tale                scenario: Koschei the Deathless vs the heroes of Russian tales (Russian texts; implies necromancer, expansion, twist)
      --dawn                scenario: The Long Night — take Dawnspire in eight weeks before the sun burns the dead (implies necromancer, expansion; loss by time; 3+ players, size 72+)
      --deadlands           scenario: The Dead Lands — Lord Corlagon vs the living kingdoms; the blight spreads from your start (implies necromancer, teams, twist, expansion; 4+ players, size 72+)
      --name <text>         map name (default: generated)
      --out <file>          output .fh2m (default out/random_<seed>.fh2m)
      --install             also copy the map into the fheroes2 maps directory
      --preview <file.png>  write a PNG preview
      --ascii               print an ASCII preview
      --summary             print map statistics
      --check               load the map with the real game code ($FH2CHECK)
  node src/cli.ts preview <map.fh2m> [--out <file.png>] [--ascii]
  node src/cli.ts summary <map.fh2m>
  node src/cli.ts validate <map.fh2m>
  node src/cli.ts check <map.fh2m>
  node src/cli.ts install <map.fh2m>`;

export function fheroes2MapsDir(): string {
  const env = process.env['FHEROES2_MAPS_DIR'];
  if (env) return env;
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'fheroes2', 'maps');
  if (platform() === 'win32') return join(process.env['APPDATA'] ?? homedir(), 'fheroes2', 'maps');
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'fheroes2', 'maps');
}

function install(file: string): string {
  const dir = fheroes2MapsDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(file));
  copyFileSync(file, target);
  return target;
}

function readMap(file: string): MapFormat {
  return decodeMap(new Uint8Array(readFileSync(file)));
}

function writeFile(file: string, data: Uint8Array | string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

function check(map: MapFormat): boolean {
  const checker = findChecker();
  if (!checker) {
    console.error('Set FH2CHECK to the fh2check binary (build it with scripts/build-fh2check.sh).');
    return false;
  }
  const result = runGameCheck(map, checker);
  if (!result.ok) {
    console.error(`fheroes2 rejected the map (${result.stage}): ${result.error ?? ''}`);
    return false;
  }
  const unsafe = compareWithGame(map, result);
  const kingdoms = (result.kingdomsInfo ?? []).map((k) => `color ${k.color}: ${k.castles} castles, ${k.heroes} heroes`).join('; ');
  console.log(`fheroes2 loaded the map: ${result.castles} castles; ${kingdoms}`);
  if (unsafe.length > 0) {
    console.error(`${unsafe.length} tiles are more permissive in our movement model than in the game`);
    return false;
  }
  return true;
}

function intOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      seed: { type: 'string' },
      size: { type: 'string' },
      players: { type: 'string' },
      water: { type: 'string' },
      difficulty: { type: 'string' },
      preset: { type: 'string' },
      template: { type: 'string' },
      victory: { type: 'string' },
      race: { type: 'string' },
      expansion: { type: 'boolean' },
      teams: { type: 'boolean' },
      twist: { type: 'boolean' },
      tale: { type: 'boolean' },
      dawn: { type: 'boolean' },
      deadlands: { type: 'boolean' },
      name: { type: 'string' },
      out: { type: 'string' },
      install: { type: 'boolean' },
      preview: { type: 'string' },
      ascii: { type: 'boolean' },
      summary: { type: 'boolean' },
      check: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !command || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  switch (command) {
    case 'generate': {
      const seed = intOption(values.seed, 'seed') ?? Math.floor(Math.random() * 1_000_000);
      const partial: Partial<GeneratorOptions> & { seed: number } = { seed };
      const size = intOption(values.size, 'size');
      if (size !== undefined) partial.size = size as GeneratorOptions['size'];
      const players = intOption(values.players, 'players');
      if (players !== undefined) partial.players = players;
      if (values.water) partial.water = values.water as GeneratorOptions['water'];
      if (values.difficulty) partial.difficulty = values.difficulty as GeneratorOptions['difficulty'];
      if (values.preset) partial.preset = values.preset as GeneratorOptions['preset'];
      if (values.template) partial.template = values.template as GeneratorOptions['template'];
      if (values.race) partial.race = values.race as GeneratorOptions['race'];
      if (values.victory) partial.victory = values.victory as GeneratorOptions['victory'];
      if (values.expansion) partial.expansion = true;
      if (values.teams) partial.teams = true;
      if (values.twist) partial.twist = true;
      if (values.tale) partial.tale = true;
      if (values.dawn) partial.dawn = true;
      if (values.deadlands) partial.deadlands = true;
      if (values.name !== undefined) partial.name = values.name;

      const started = Date.now();
      const result = generate(partial);
      const out = values.out ?? join('out', `random_${seed}.fh2m`);
      writeFile(out, encodeMap(result.map));
      const o = result.options;
      console.log(`Generated "${o.tale ? new TextDecoder('windows-1251').decode(Buffer.from(result.map.name, 'latin1')) : result.map.name}" (${o.size}x${o.size}, ${o.players} players, ${o.water} water, ${o.difficulty}, ${o.preset}, seed ${o.seed}) in ${Date.now() - started} ms`);
      console.log(`Wrote ${out}`);
      if (values.preview) {
        writeFile(values.preview, renderPng(result.map, { zoneOf: result.layout.zoneOf }));
        console.log(`Wrote ${values.preview}`);
      }
      if (values.ascii) console.log(renderAscii(result.map));
      if (values.summary) {
        console.log(formatStats(mapStats(result.map)));
        console.log(`Zones: ${result.layout.zones.map((z) => `${z.id}:${z.kind}${z.player >= 0 ? `(p${z.player})` : ''} ${z.tiles.length} tiles`).join(', ')}`);
        console.log(perPlayerSummary(result));
      }
      if (values.check && !check(result.map)) return 2;
      if (values.install) console.log(`Installed ${install(out)}`);
      return 0;
    }
    case 'preview': {
      const file = positionals[0];
      if (!file) throw new Error('preview: map file required');
      const map = readMap(file);
      const out = values.out ?? file.replace(/\.fh2m$/i, '') + '.png';
      writeFile(out, renderPng(map));
      console.log(`Wrote ${out}`);
      if (values.ascii) console.log(renderAscii(map));
      return 0;
    }
    case 'summary': {
      const file = positionals[0];
      if (!file) throw new Error('summary: map file required');
      console.log(formatStats(mapStats(readMap(file))));
      return 0;
    }
    case 'validate': {
      const file = positionals[0];
      if (!file) throw new Error('validate: map file required');
      const report = validateMap(readMap(file));
      if (report.ok) console.log(`OK: ${report.starts.length} players, all objects reachable`);
      else for (const e of report.errors) console.log(e);
      return report.ok ? 0 : 2;
    }
    case 'check': {
      const file = positionals[0];
      if (!file) throw new Error('check: map file required');
      return check(readMap(file)) ? 0 : 2;
    }
    case 'install': {
      const file = positionals[0];
      if (!file || !existsSync(file)) throw new Error('install: existing map file required');
      readMap(file); // make sure it is a valid map
      console.log(`Installed ${install(file)}`);
      return 0;
    }
    default:
      console.error(`Unknown command ${command}\n${USAGE}`);
      return 1;
  }
}

function perPlayerSummary(result: ReturnType<typeof generate>): string {
  const lines: string[] = [];
  for (const zone of result.layout.zones.filter((z) => z.kind === 'start')) {
    const mines = result.context.records.filter((r) => r.zone === zone.id && r.kind === 'mine').map((r) => r.resource);
    const value = result.context.records.filter((r) => r.zone === zone.id && r.kind !== 'guard').reduce((s, r) => s + r.value, 0);
    lines.push(`Player ${zone.player}: mines ${mines.join(', ')}; content value ${value}`);
  }
  return lines.join('\n');
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
