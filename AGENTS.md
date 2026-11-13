# Working on her2

## Context

- Read `README.md` for supported commands and features, `SPEC.md` for design decisions and format constraints, and `IDEAS.md` for scenario plans.
- This is a single-player Heroes of Might and Magic II random map generator targeting fheroes2 1.1.17, `.fh2m` format version 13.
- Keep documentation consistent with changes to options, scenarios, generation, or validation.

## Runtime and commands

- Use Node.js >=26 with native TypeScript type stripping; there is no build step.
- Install development dependencies with `npm ci` when needed.
- Run `npm run typecheck` and `npm test` after code changes. Type stripping alone does not check types.
- Generate a sample: `node src/cli.ts generate --seed 123 --size 72 --players 4 --out out/sample.fh2m --summary`.
- For broader generation checks: `node scripts/sweep.ts --seeds 100`. `SWEEP_SEEDS=n npm test` expands the test sweep.
- For engine checks, use the auto-detected `out/tools/fheroes2/fh2check` or set `FH2CHECK` to a checker built against a debug build of fheroes2 1.1.17, then run `npm test` and `node scripts/sweep.ts --seeds 1 --check`. Without an available checker, engine tests are skipped; report that limitation.
- `scripts/build-fh2check.sh <fheroes2-checkout>` builds the checker after the engine has been compiled with `FHEROES2_WITH_DEBUG=1 make -C src/dist -j8`.
- `--install` and `scripts/smoke.ts` write to the game's maps directory outside the repository. Prefer generating to `out/` unless installation is part of the task.

## Implementation constraints

- Keep `src/` free of runtime dependencies; development tooling is allowed.
- Use erasable TypeScript syntax: no enums or parameter properties. Use `.ts` extensions in imports and preserve strict type checking.
- All generation randomness must use `src/rng.ts`; never use `Math.random()`. The same seed and options must produce an identical uncompressed map body. Compressed bytes may vary across zlib versions.
- Preserve the `.fh2m` v13 binary contract. Map strings are raw bytes represented as latin1; default text is ASCII. Russian tale text uses cp1251 with the appropriate map language.
- `src/data/` tables are generated from the fheroes2 source by `scripts/extract-objects.ts`; regenerate rather than manually changing tables.
- Our movement model must never allow a move forbidden by the engine. Preserve action-object entrance rules, diagonal movement restrictions, boat access, castle entrances, and team-wall seals.
- Preserve per-player mine fairness, valid player counts, scenario option implications and conflicts, and deterministic generation.
- The code, ported algorithms, generated tables, and fixtures are GPL-2.0-or-later. Preserve license attribution.

## Verification

- Use focused regression tests for behavior changes and existing fixtures for codec or terrain compatibility.
- For changes to map encoding, objects, or passability, run the engine checks when available. A successful internal validator alone does not establish compatibility with the game.
- Keep temporary output in ignored `out/` or a temporary directory. Do not commit generated maps, dependencies, local engine checkouts, game assets, or machine-specific paths.
