// Optional check against the real game: runs the fh2check tool (tools/fh2check, built with
// scripts/build-fh2check.sh against a debug build of fheroes2) on a map file.
//
// The tool loads the map with fheroes2's own code (with its debug asserts) and reports the passability that the
// game computed. compareWithGame() verifies that our movement model never allows a move the game forbids.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMap } from './fh2m/codec.ts';
import type { MapFormat } from './fh2m/types.ts';
import { MovementModel } from './validate.ts';

export interface GameCheck {
  ok: boolean;
  stage?: string;
  error?: string;
  width?: number;
  kingdoms?: number;
  humans?: number;
  computers?: number;
  castles?: number;
  kingdomsInfo?: { color: number; castles: number; heroes: number }[];
  passability?: number[];
  objectTypes?: number[];
  water?: number[];
  heroReach?: { color: number; start: number; tiles: number[] }[];
}

// Explicit override, or the conventional ignored local engine checkout.
export function findChecker(): string | null {
  const path = process.env['FH2CHECK'] ?? fileURLToPath(new URL('../out/tools/fheroes2/fh2check', import.meta.url));
  return path && existsSync(path) ? path : null;
}

export function runGameCheck(map: MapFormat, checker: string): GameCheck {
  const dir = mkdtempSync(join(tmpdir(), 'her2-check-'));
  const file = join(dir, 'map.fh2m');
  try {
    writeFileSync(file, encodeMap(map));
    return runGameCheckFile(file, checker);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function runGameCheckFile(file: string, checker: string): GameCheck {
  try {
    const out = execFileSync(checker, [file], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out) as GameCheck;
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; status?: number; signal?: string };
    const stderr = (err.stderr ?? '').toString().trim().split('\n').slice(-3).join(' | ');
    return { ok: false, stage: 'crash', error: `${err.signal ?? `exit ${err.status}`}: ${stderr}` };
  }
}

// Tiles where our model allows a direction that the game does not.
export function compareWithGame(map: MapFormat, check: GameCheck): number[] {
  const model = new MovementModel(map);
  const unsafe: number[] = [];
  const real = check.passability ?? [];
  for (let i = 0; i < model.grid.size; ++i) {
    const mine = model.passability[i] as number;
    if ((mine & ~(real[i] ?? 0)) !== 0) unsafe.push(i);
  }
  return unsafe;
}
