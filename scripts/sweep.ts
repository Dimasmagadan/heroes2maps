// Seed sweep: generates many maps for every map size and allowed player count and checks each one.
//
// Usage: node scripts/sweep.ts [--seeds 100] [--threads 8] [--check]
//
// For each seed the water level, preset, difficulty and victory condition rotate, so all options get covered.
// Every map must generate, pass the validator, have valid terrain transitions and roads, and (with --check and
// $FH2CHECK set) load in the real game code with a movement model that is never more permissive than the game's.

import { availableParallelism } from 'node:os';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { compareWithGame, findChecker, runGameCheck } from '../src/fh2check.ts';
import { generate } from '../src/generate.ts';
import { checkZoneSeal } from '../src/content/seal.ts';
import { DIFFICULTIES, MAP_SIZES, PLAYER_LIMITS, PRESETS, RACES, VICTORY_CONDITIONS, WATER_LEVELS, type GeneratorOptions } from '../src/options.ts';
import { findInvalidRoads } from '../src/terrain/roads.ts';
import { findInvalidTransitions } from '../src/terrain/transitions.ts';
import { validateMap } from '../src/validate.ts';

interface Job {
  options: GeneratorOptions;
}

interface JobResult {
  options: GeneratorOptions;
  ms: number;
  attempt: number;
  error?: string;
}

function jobs(seeds: number): Job[] {
  const list: Job[] = [];
  for (const size of MAP_SIZES) {
    const [min, max] = PLAYER_LIMITS[size];
    for (let players = min; players <= max; ++players) {
      for (let seed = 1; seed <= seeds; ++seed) {
        const k = seed + players;
        const preset = PRESETS[(k >> 1) % PRESETS.length] as GeneratorOptions['preset'];
        const teams = players >= 4 && preset !== 'islands' && seed % 3 === 0;
        list.push({
          options: {
            seed: seed * 1000 + size + players,
            size,
            players,
            water: WATER_LEVELS[k % WATER_LEVELS.length] as GeneratorOptions['water'],
            preset,
            difficulty: DIFFICULTIES[(k >> 2) % DIFFICULTIES.length] as GeneratorOptions['difficulty'],
            // Teams maps carry their own victory condition (defeat the other side).
            victory: teams ? 'normal' : (VICTORY_CONDITIONS[seed % VICTORY_CONDITIONS.length] as GeneratorOptions['victory']),
            race: RACES[(seed + size) % RACES.length] as GeneratorOptions['race'],
            expansion: seed % 5 === 0,
            teams,
            twist: seed % 4 === 0,
            tale: false,
          },
        });
      }
    }
  }
  return list;
}

function runJob(job: Job, check: boolean): JobResult {
  const started = Date.now();
  try {
    const result = generate(job.options);
    const errors: string[] = [];
    const report = validateMap(result.map, { strictOverlaps: true });
    if (!report.ok) errors.push(...report.errors.slice(0, 3));
    if (report.starts.length !== job.options.players) errors.push(`${report.starts.length} players instead of ${job.options.players}`);
    if (findInvalidTransitions(result.map).length > 0) errors.push('invalid terrain transitions');
    if (findInvalidRoads(result.map).length > 0) errors.push('invalid roads');
    if (job.options.teams) {
      const leaks = checkZoneSeal(result.context);
      if (leaks.length > 0) errors.push(`seal: ${leaks.slice(0, 3).join('; ')}`);
    }
    const checker = check ? findChecker() : null;
    if (checker) {
      const game = runGameCheck(result.map, checker);
      if (!game.ok) errors.push(`fheroes2: ${game.stage} ${game.error ?? ''}`);
      else if (compareWithGame(result.map, game).length > 0) errors.push('movement model more permissive than the game');
    }
    return { options: job.options, ms: Date.now() - started, attempt: result.attempt, ...(errors.length ? { error: errors.join('; ') } : {}) };
  } catch (e) {
    return { options: job.options, ms: Date.now() - started, attempt: -1, error: e instanceof Error ? e.message : String(e) };
  }
}

if (!isMainThread) {
  const { list, check } = workerData as { list: Job[]; check: boolean };
  for (const job of list) parentPort?.postMessage(runJob(job, check));
} else {
  const { values } = parseArgs({ options: { seeds: { type: 'string' }, threads: { type: 'string' }, check: { type: 'boolean' } } });
  const seeds = Number(values.seeds ?? 100);
  const threads = Math.max(1, Number(values.threads ?? Math.max(1, availableParallelism() - 1)));
  const check = values.check === true;
  if (check && !findChecker()) {
    console.error('--check needs $FH2CHECK (see scripts/build-fh2check.sh)');
    process.exit(1);
  }
  const all = jobs(seeds);
  const started = Date.now();
  const results: JobResult[] = [];
  const parts: Job[][] = Array.from({ length: threads }, () => []);
  all.forEach((job, i) => parts[i % threads]?.push(job));
  await Promise.all(
    parts.map(
      (list) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: { list, check } });
          worker.on('message', (r: JobResult) => {
            results.push(r);
            if (r.error) console.log(`FAIL ${JSON.stringify(r.options)}: ${r.error}`);
            if (results.length % 50 === 0) console.log(`${results.length}/${all.length} maps...`);
          });
          worker.on('error', reject);
          worker.on('exit', () => resolve());
        }),
    ),
  );

  const failures = results.filter((r) => r.error);
  console.log(`\n${results.length} maps in ${((Date.now() - started) / 1000).toFixed(1)} s, ${failures.length} failures${check ? ' (with game check)' : ''}`);
  for (const size of MAP_SIZES) {
    const rs = results.filter((r) => r.options.size === size);
    const times = rs.map((r) => r.ms).sort((a, b) => a - b);
    const retries = rs.filter((r) => r.attempt > 0).length;
    console.log(
      `  ${size}x${size}: ${rs.length} maps, median ${times[Math.floor(times.length / 2)]} ms, max ${times[times.length - 1]} ms, ${retries} needed retries, ${rs.filter((r) => r.error).length} failures`,
    );
  }
  process.exitCode = failures.length ? 1 : 0;
}
