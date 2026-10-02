# HoMM2 Random Map Generator — Project Spec

Generator of single-player maps for Heroes of Might and Magic II, written in TypeScript,
targeting the **fheroes2 `.fh2m` format (version 13)**. Maps are played in fheroes2
(installed locally via Homebrew, game data in `~/Library/Application Support/fheroes2`).

## Decisions made

| Topic | Decision |
|---|---|
| Language | TypeScript, Node 26 native type stripping (no build step) |
| Dependencies | None at runtime. Registry access was unreliable; keep deps at zero unless clearly needed |
| Output format | `.fh2m` v13 (not `.mp2`); `.mp2` export is out of scope unless requested later |
| Map type | Single-player, varied (not tournament-balanced for multiplayer) |
| Tests | `node --test` (`npm test`) |
| Syntax constraints | `erasableSyntaxOnly`: no `enum`, no parameter properties, imports use `.ts` extensions |
| Strings | Raw bytes in the map language's code page, handled as latin1 (1 char = 1 byte); generate English/ASCII by default |

## Reference material

- fheroes2 source (clone to scratchpad when needed): `https://github.com/ihhub/fheroes2`
  - `src/fheroes2/maps/map_format_info.{h,cpp}` — file format (done, see `src/fh2m`)
  - `src/fheroes2/maps/map_object_info.{h,cpp}` — object table: groups, indices, parts, layers
  - `src/fheroes2/maps/map_format_helper.cpp` — terrain transitions, roads, streams logic
  - `src/fheroes2/maps/map_random_generator*.cpp` — fheroes2's own random generator, useful for ideas and sanity checks
  - `maps/*.fh2m` — sample maps (already copied to `fixtures/`)
- fheroes2 is GPL-2.0. Anything ported from it (tables, algorithms) makes the derived code GPL-2.0 too; decide on the project license before publishing.

## Current state

Step 1 is done (commit `3bf859c`):

- `src/fh2m/stream.ts` — big-endian Reader/Writer
- `src/fh2m/types.ts` — typed map model (`MapFormat`, `TileInfo`, `ObjectGroup`, metadata structures)
- `src/fh2m/codec.ts` — `decodeMap`, `encodeMap`, `encodeBody`, `inflateBody`
- `test/roundtrip.test.ts` — 9 bundled v13 maps decode and re-encode byte-for-byte
- Only version 13 is read. Older versions are rejected on purpose.

## Step 2 — Object table

Goal: a data module the generator can query: for any `(group, index)` know what it looks like on the grid.

- Extract from `map_object_info.cpp` for every object: group, index, `objectType` (MP2 type), ground-level parts (tile offset, layer type) and top-level parts, metadata.
- Derive per object: footprint (occupied cells), passability/action cells (which cells block movement, which trigger the action), bounding box, terrain restrictions if any.
- Produce a generated TS data file (`src/data/objects.ts`) by a one-off script (`scripts/extract-objects.ts`), checked into git, so the build never needs the C++ source.
- Provide a typed query API: `objectsByGroup`, `getObjectInfo(group, index)`, `findObjects({ type, terrain })`.
- Also extract enumerations the generator needs: ground types and their tile index ranges, monster IDs and strength, artifact IDs, resource/mine types, castle races and their object indices, hero indices.
- Tests: spot-check known objects (e.g. a castle, a mine, a tree) and verify every `(group, index)` found in the 9 fixture maps resolves in the table.

Open questions to investigate in the source: how layer types map to passability, how town basements and flags are attached to castles, how hero/castle colors are encoded in the index.

## Step 3 — Terrain, roads, rivers

Goal: a valid, good-looking landscape. Terrain in `.fh2m` is stored as tile indices, so transitions between ground types must be computed.

- Port the terrain-transition logic from `setTerrainWithTransition` / `setTerrainOnTile` (`map_format_helper.cpp`) and the ground tileset layout (`ground.cpp`): given a ground type per cell, choose `terrainIndex` and `terrainFlags` (shape/rotation bits) for each tile.
- Terrain generation: seeded noise (value/simplex) and/or cellular automata to produce biomes (grass, snow, swamp, lava, desert, dirt, wasteland, beach) and water. Seeded PRNG module (`src/rng.ts`, e.g. mulberry32 or sfc32) used everywhere; no `Math.random`.
- Coastlines: beach tiles at water/land borders.
- Roads: port `setRoadOnTile` / `updateRoadOnTile` / `updateAllRoads` to pick road sprite objects by neighbor connectivity (group `ROADS`). Road routing between points of interest with A* over terrain cost.
- Streams (rivers): port `addStream` / `updateStreamsAround` and delta handling (group `STREAMS`).
- Tests: generated terrain has no invalid transitions; re-running the transition pass is idempotent; decoding a fixture, recomputing transitions from its ground types and comparing with the original is a good regression check.

## Step 4 — Game content

Goal: a playable map with players, towns, economy, and challenges.

- Player setup: 1 human + N computer players (1–5), colors, races, alliances, starting castle and starting hero (`KINGDOM_TOWNS`, `KINGDOM_HEROES`), `availablePlayerColors` / `humanPlayerColors` / `computerPlayerColors`.
- Zone layout: partition the map into regions (Voronoi or template graph): player start zones, neutral zones, a center. Each zone gets a theme (biome, richness, danger). Connections between zones through guarded passages.
- Placement with a difficulty/value budget by distance from the nearest start:
  - resources and mines (all 7 types, fair share per start zone)
  - dwellings, power-ups (shrines, libraries, etc.), treasures (chests, lamps, etc.)
  - artifacts, spell scrolls, random artifacts by tier
  - monsters guarding items and chokepoints, with counts scaled by value and distance (`MonsterMetadata`)
  - neutral towns and castles, capturable objects, signs, events, sphinx riddles, rumors, daily events
- Object placement engine: footprint-aware collision, 1-cell margin rules, access cell guarantees, removal of objects that would block a path.
- Landscape decoration: mountains, rocks, trees, water objects, miscellaneous, as filler and to shape paths.
- Victory and loss conditions (default: defeat all enemies / lose all heroes and castles), optional alternatives (capture a town, find an artifact).
- Map name, description, difficulty, size (36/72/108/144 tiles).
- Validation pass: all points of interest reachable from each start, no object overlaps, every castle has at least one open entrance, every guarded item is reachable through its guard.

## Step 5 — CLI and preview

- CLI: `node src/cli.ts generate --seed 123 --size 72 --players 4 --water medium --difficulty normal --out out/my_map.fh2m`.
- Config object for the generator (`GeneratorOptions`) shared by CLI and tests; same seed + options produce byte-identical output.
- Installation helper: copy a map into fheroes2's maps directory (`~/Library/Application Support/fheroes2/maps`) via `--install`.
- PNG preview: a tiny dependency-free PNG encoder (`node:zlib`) that renders terrain colors, objects as markers, player starts, and guards. Optional ASCII preview for terminals.
- Map summary output: counts of objects by type, zone sizes, resource totals per player.

## Step 6 — In-game verification

- Manual checklist: the map appears in the fheroes2 map list, loads without errors, shows correct size and players, terrain transitions look right, objects render and are passable/blocking as expected, AI players move.
- Automated structural checks in tests: decode generated maps with our own codec, run the validation pass from step 4, and compare statistics against the fixture maps (object density, monster value distribution).
- If fheroes2 logs errors on load, run it from a terminal and capture the log (`fheroes2` prints to stderr; add `--debug` style options as supported by the installed version).
- Compatibility note: pin the supported version (13). If a newer fheroes2 bumps the format, update `FORMAT_VERSION` and re-run round-trip tests on its bundled maps.

## Step 7 — Polish and optional extras

- Generation templates/presets (island, continent, many-lakes, wasteland, etc.).
- Themed map names and descriptions, optional Russian text with cp1251 encoding.
- Support for the Price of Loyalty content (the expansion data is present as `HEROES2X.AGG`): expansion objects, artifacts, and monsters.
- Optional: `.mp2` writer for the original game, only if explicitly wanted.
- Optional: small web UI (needs a dependency-free approach or a bundler once the registry is reachable).
- Project license decision (see GPL note above), README with usage.

## Suggested module layout

```
src/
  fh2m/            format codec (done)
  data/            generated tables: objects, grounds, monsters, artifacts
  rng.ts           seeded PRNG
  grid.ts          map grid helpers (neighbors, distances, flood fill)
  terrain/         noise, biomes, transitions, roads, streams
  layout/          zones, connections, player starts
  content/         object placement, monsters, treasure budgets
  validate.ts      reachability and overlap checks
  generate.ts      pipeline: options -> MapFormat
  preview/         PNG/ASCII renderers
  cli.ts
scripts/           one-off extractors that produce src/data
test/
fixtures/          sample .fh2m maps (GPL, from fheroes2)
```

## Risks

- **Terrain transitions** are the least documented part; port directly from `map_format_helper.cpp` and validate against fixtures before building on it.
- **Object table extraction** from 6k lines of C++ could be error-prone; verify with fixtures and prefer a scripted extraction over hand-copying.
- **Guaranteed reachability** is the main source of unplayable maps; build the validator early (step 4) and run it in every test.
- **fheroes2 format drift**: the format is versioned and evolving; keep the codec strict and tests on real maps.
- **No registry access** at times: keep dependency-free tooling working.

## Definition of done

- `node src/cli.ts generate ...` produces a `.fh2m` that opens in the installed fheroes2 and is playable start to finish (starting town, reachable resources, guarded treasures, enemies, a winnable victory condition).
- Same seed gives the same map.
- Tests cover the codec, object table, terrain, placement and validation.
- Maps for all four sizes and 1–5 players generate in a few seconds.
