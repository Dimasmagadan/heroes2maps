# HoMM2 Random Map Generator — Project Spec

Generator of single-player maps for Heroes of Might and Magic II, written in TypeScript,
targeting the **fheroes2 `.fh2m` format (version 13)**. Maps are played in fheroes2
(installed locally via Homebrew, game data in `~/Library/Application Support/fheroes2`).

## Decisions made

| Topic | Decision |
|---|---|
| Language | TypeScript, Node 26 native type stripping (no build step); pin via `"engines": { "node": ">=26" }` |
| Type checking | Type stripping does not check types. `tsc` is added as a dev dependency (with `@types/node`) and run via `npm run typecheck` once the registry is reachable; until then types are unchecked |
| Dependencies | None at runtime. Dev-only tooling (e.g. `typescript`) is allowed but nothing in `src/` may require it |
| License | GPL-2.0-or-later (same as fheroes2). Steps 2–3 port tables and algorithms from fheroes2 and the fixtures are GPL, so the project is a derived work. Add `LICENSE` now |
| Output format | `.fh2m` v13 (not `.mp2`); `.mp2` export is out of scope unless requested later |
| Map type | Single-player, varied (not tournament-balanced for multiplayer) |
| Players | Exactly 1 human + 1–5 computer players (2–6 players total, HoMM2 has 6 colors). Allowed player counts are limited per map size (see step 4) |
| Determinism | Same seed + options produce an identical uncompressed body (`encodeBody`). The compressed file may differ across zlib/Node versions. All randomness goes through `src/rng.ts`; no `Math.random`, and any `Rand` calls in ported fheroes2 code are replaced by our PRNG |
| Tests | `node --test` (`npm test`) |
| Syntax constraints | `erasableSyntaxOnly`: no `enum`, no parameter properties, imports use `.ts` extensions |
| Strings | Raw bytes in the map language's code page, handled as latin1 (1 char = 1 byte); generate English/ASCII by default |

## Reference material

- fheroes2 source (clone to scratchpad when needed): `https://github.com/ihhub/fheroes2`
  - `src/fheroes2/maps/map_format_info.{h,cpp}` — file format (done, see `src/fh2m`)
  - `src/fheroes2/maps/map_object_info.{h,cpp}` — object table: groups, indices, parts, layers
  - `src/fheroes2/maps/map_format_helper.cpp` — terrain transitions, roads, streams logic
  - `src/fheroes2/maps/ground.cpp` — ground tileset layout and tile variants
  - `src/fheroes2/maps/map_random_generator*.cpp` — fheroes2's own random generator (see "Relation to fheroes2's generator")
  - `src/fheroes2/monster/monster.cpp`, `monster_info.cpp` — monster stats and strength
  - `src/fheroes2/resource/artifact.cpp` — artifact IDs, levels, expansion flags
  - `src/fheroes2/kingdom/race.cpp`, `src/fheroes2/heroes/` — races and hero indices
  - editor validation code (search for map checks in `src/fheroes2/editor/`) — what fheroes2 requires of a valid map
  - `maps/*.fh2m` — sample maps (already copied to `fixtures/`)

## Relation to fheroes2's generator

fheroes2 ships its own random generator. Since the project is GPL anyway, porting from it is allowed.
Read for 1.1.17 (`map_random_generator*.cpp`). Its design: regions grown from seeds on two rings, border tiles turned
into tree walls, connectors between regions, castles at region centers, mines placed in tile "rings" around the
castle, prefab object sets (treasures behind trees) with a monster in front, decorations by ground, and
`forceTempRoadOnTile` roads to everything.

Reused directly (ported):

- `selectTerrainVariantForObject` idea and its tree/mountain tables, generalized: art sets per ground in
  `src/objects.ts` (`ICN_TERRAINS`).
- `objectGoldValue` (gold-equivalent values of objects), extended to all objects we place: `src/content/catalog.ts`.
- Index helpers `getTownBasementId`, `getMineObjectInfoId`, hero/flag sprite layout: `src/content/catalog.ts`.
- Castle placement recipe (basement + town with one UID, flags on both sides, hero on the entrance, entrance road):
  `placeCastle` in `src/content/content.ts`.
- "Action objects need a free tile below them" (`canPlaceObject`), and guards on the entrance tile of mines.
- `getMonstersByValue` idea of guards scaled by value, but replaced by explicit stacks sized by fheroes2 monster strength.

Written from scratch, and why:

- Layout: noisy weighted Voronoi zones with a start ring, a center zone and an MST + loops connection graph
  (`src/layout/zones.ts`); fheroes2 only supports a mirrored two-ring layout and needs a full `world`/Editor instance.
- Value budgets per zone that grow with distance from the nearest start, fair per-player mine kits, unguarded pickup
  scatter calibrated against the fixture maps, water presets (continent, lakes, islands with boats, wasteland).
- Reachability validation and repair against a conservative model of the game's movement rules (fheroes2's generator
  relies on its region structure and does not validate).
- Everything runs without the fheroes2 engine: all tables are generated (`scripts/extract-objects.ts`) and the
  terrain/road/stream logic of `map_format_helper.cpp` is ported (`src/terrain/`).

## Current state

All steps are implemented. Summary of what exists and what was learned:

- Step 1: codec (`src/fh2m`), unchanged.
- Step 1b: `scripts/smoke.ts` writes a modified fixture into the fheroes2 maps directory. Beyond the manual check,
  `tools/fh2check` (built by `scripts/build-fh2check.sh` against a debug build of fheroes2 1.1.17) loads any map with
  the game's own code (`World::loadResurrectionMap`, debug asserts on) and reports the game's tile passability;
  `node src/cli.ts check <map>` and `test/game.test.ts` use it when `$FH2CHECK` is set. All fixtures and all
  generated maps of the seed sweep load without asserts. It caught two real bugs (wrong `BUILD_CASTLE` value,
  random castles' passability) that our own decoder could not.
- Step 2: `scripts/extract-objects.ts` compiles `map_object_info.cpp`, `monster_info.cpp`, `monster.cpp` and
  `mp2.cpp` with a dump program (stubs in `scripts/extract-stubs.cpp`) and writes `src/data/{objects,enums,monsters}.ts`:
  all objects with parts, layers and metadata, per-type action flags (entry directions, pickup, capture), enums
  (object/ICN types, grounds and image ranges, races, resources, heroes, monsters, buildings), artifact levels and
  expansion flags (parsed from `Artifact::Level`), monster stats and strength. Query API: `src/objects.ts`.
  Answers to the open questions:
  - Layer types: OBJECT and BACKGROUND parts affect passability; SHADOW and TERRAIN parts (roads, streams, the castle
    entrance road) do not. An action part (MP2 type with bit 128) makes its tile enterable only from
    `getActionObjectDirection(type)`; the hero stops there. A non-action part gets "center row + bottom row"
    passability, which `updatePassability` often clears; the game does let heroes step onto some object bottom
    rows. Our model treats all non-action object tiles as blocked: it is stricter than the game (verified against
    fh2check on all fixtures and sweep maps: never more permissive), which is safe for generation.
  - Castles: `LANDSCAPE_TOWN_BASEMENTS` (index by ground) and `KINGDOM_TOWNS` on the same tile with the same UID,
    `LANDSCAPE_FLAGS` (color * 2, +1 for the right flag) on the tiles left and right with the same UID; the owner
    color comes from the flags (6 = neutral). Random castles/towns become real towns at game start and get castle
    passability.
  - Heroes: `KINGDOM_HEROES` index = color * 7 + race (6 = random race).
  - Valid map: at least one player (castle or hero), human/computer colors covering the available colors, castle
    metadata with `BUILD_CASTLE` or `BUILD_TENT` matching castle/town, hero metadata race matching the object,
    metadata entries for monsters/artifacts/signs/events/sphinxes, victory/loss metadata as `FileInfo` expects.
- Step 3: `src/rng.ts` (sfc32 + labeled forks), `src/terrain/ground.ts`, `transitions.ts` (port; agrees with all 9
  fixtures modulo variants, idempotent because existing variants are kept), `roads.ts` (roads and streams; agrees with
  all fixture roads), `noise.ts`, `landscape.ts`, previews in `src/preview/`.
  fheroes2's diagonal rule matters for routing: a hero cannot move diagonally past a tall object beside the lower
  tile, so roads and corridors only take diagonal steps whose side tile stays free (`diagonalSideTile`).
- Step 4: `src/content/` (builder/placement engine, catalog, guards, content, roads, decoration, repair),
  `src/validate.ts`, `src/generate.ts`. Water-aware reachability with boats.
- Step 5: `src/cli.ts`, `src/options.ts`, `src/summary.ts`, PNG/ASCII previews, `--install`.
- Step 6: `test/` (codec, object table, terrain, roads, validator, placement, generator, statistics against fixture
  ranges, seed sweep), `scripts/sweep.ts` (parallel 100-seed sweep over all sizes and player counts, optional game check).
  Last full run (2026-10-03): 1500 maps (100 seeds x 15 size/player combinations, rotating water/preset/difficulty/
  victory/expansion), 0 failures with `--check`; 18 maps needed a retry. Single-threaded generation takes about
  0.1 s (36), 0.4 s (72), 1.5 s (108) and 3.5 s (144).
- Step 7: presets, themed names/texts, expansion content behind `--expansion`, README. Not done: `.mp2` export,
  web UI, cp1251 texts (all optional).
- Type checking: `typescript` and `@types/node` are installed as dev dependencies; `npm run typecheck` passes.
- Follow-up (2026-10-03): `--teams` (commit 0c68307), then the review fixes from "Review fixes" at the end of this
  document: two-side alliance victory (type 4), a guaranteed wall seal with `keeper`-tagged walls, zone-aware roads
  and corridors, dry shores around walled zones, and a seal check in the generator, tests and sweep.
- Follow-up (2026-10-25): `--template` (five macro layouts, see "Templates" at the end of this document) and the
  teams seal robustness fixes from "Templates and the teams seal (2026-10-25)", then `--deadlands` (see "The Dead
  Lands (2026-10-25)").

Still manual: playing a generated map in fheroes2 (visual check, AI turns). See step 6 checklist.

### Step 1b — In-game smoke test

Prove fheroes2 accepts files written by our encoder, not only our own decoder:

- `scripts/smoke.ts`: decode a fixture, change the map name and a few terrain tiles, encode, write to the fheroes2 maps directory.
- Open it in fheroes2: map is listed, loads, changes are visible.
- Repeat this in-game check at the end of every following step (see step 6 checklist).

## Step 2 — Object table

Goal: a data module the generator can query: for any `(group, index)` know what it looks like on the grid.

- Extract from `map_object_info.cpp` for every object: group, index, `objectType` (MP2 type), ground-level parts (tile offset, layer type) and top-level parts, metadata.
- Derive per object: footprint (occupied cells), passability/action cells (which cells block movement, which trigger the action), bounding box, terrain restrictions if any.
- Mark every object, monster and artifact that belongs to the Price of Loyalty expansion, so the generator can include or exclude expansion content without re-extracting.
- Produce a generated TS data file (`src/data/objects.ts`) by a one-off script (`scripts/extract-objects.ts`), checked into git, so the build never needs the C++ source.
- Provide a typed query API: `objectsByGroup`, `getObjectInfo(group, index)`, `findObjects({ type, terrain, expansion })`.
- Also extract enumerations the generator needs (sources listed in Reference material): ground types and their tile index ranges, monster IDs and strength, artifact IDs and levels, resource/mine types, castle races and their object indices, hero indices.
- Tests: spot-check known objects (e.g. a castle, a mine, a tree) and verify every `(group, index)` found in the 9 fixture maps resolves in the table.

Open questions to investigate in the source:

- how layer types map to passability;
- how town basements and flags are attached to castles;
- how hero/castle colors are encoded in the index;
- what fheroes2 requires of a valid map (at least one human color, limits on heroes/castles per player, required metadata fields).

## Step 3 — Terrain, roads, rivers

Goal: a valid, good-looking landscape. Terrain in `.fh2m` is stored as tile indices, so transitions between ground types must be computed.

- Seeded PRNG module first (`src/rng.ts`, e.g. sfc32 or mulberry32), used everywhere.
- Minimal preview early: ASCII dump and/or a simple PNG (ground type as color) via a tiny `node:zlib` PNG encoder. Extended in step 5.
- Port the terrain-transition logic from `setTerrainWithTransition` / `setTerrainOnTile` (`map_format_helper.cpp`) and the ground tileset layout (`ground.cpp`): given a ground type per cell, choose `terrainIndex` and `terrainFlags` (shape/rotation bits) for each tile.
- Terrain generation: seeded noise (value/simplex) and/or cellular automata to produce biomes (grass, snow, swamp, lava, desert, dirt, wasteland, beach) and water.
- Coastlines: beach tiles at water/land borders.
- Roads: port `setRoadOnTile` / `updateRoadOnTile` / `updateAllRoads` to pick road sprite objects by neighbor connectivity (group `ROADS`). Road routing between points of interest with A* over terrain cost.
- Streams (rivers): port `addStream` / `updateStreamsAround` and delta handling (group `STREAMS`).
- Tests:
  - generated terrain has no invalid transitions;
  - re-running the transition pass is idempotent;
  - fixture regression: decode a fixture, recompute transitions from its ground types, compare with the original. fheroes2 likely picks randomly among equivalent tile variants, so compare **modulo variant** (shape class + rotation flags), not raw `terrainIndex`. Confirm the variant scheme in `ground.cpp` first.
- In-game: a terrain-only map loads and transitions look right.

## Step 4 — Game content

Goal: a playable map with players, towns, economy, and challenges. Split into three sub-steps, each ending with a map that loads and is checked in-game.

Map size × player count limits (initial proposal, tune after play-testing):

| Size | Players total |
|---|---|
| 36×36 | 2–3 |
| 72×72 | 2–4 |
| 108×108 | 2–6 |
| 144×144 | 2–6 |

### Step 4a — Minimal playable map (MVP)

- Player setup: 1 human + N computer players, colors, races, alliances, starting castle and starting hero (`KINGDOM_TOWNS`, `KINGDOM_HEROES`), `availablePlayerColors` / `humanPlayerColors` / `computerPlayerColors`.
- Simple layout: player starts spread apart, mines and resources near each start.
- Object placement engine: footprint-aware collision, 1-cell margin rules, access cell guarantees, removal of objects that would block a path.
- Default victory and loss conditions (defeat all enemies / lose all heroes and castles).
- Map name, description, difficulty, size (36/72/108/144 tiles).
- Validation pass (`src/validate.ts`), run in every test from here on:
  - all points of interest reachable from each start;
  - no object overlaps;
  - every castle has at least one open entrance;
  - every guarded item is reachable through its guard;
  - reachability models water: land regions connected only by water count as connected only if there is a reachable shipyard or boat; until boats are generated, the validator rejects maps where starts or required objects are cut off by water.

### Step 4b — Zones and value budget

- Zone layout: partition the map into regions (Voronoi or template graph): player start zones, neutral zones, a center. Each zone gets a theme (biome, richness, danger). Connections between zones through guarded passages.
- Placement with a difficulty/value budget by distance from the nearest start:
  - resources and mines (all 7 types, fair share per start zone)
  - dwellings, power-ups (shrines, libraries, etc.), treasures (chests, lamps, etc.)
  - artifacts, spell scrolls, random artifacts by tier
  - monsters guarding items and chokepoints, with counts scaled by value and distance (`MonsterMetadata`)
- Boats and shipyards where water separates land regions.

### Step 4c — Flavor and extras

- Landscape decoration: mountains, rocks, trees, water objects, miscellaneous, as filler and to shape paths.
- Neutral towns and castles, capturable objects, signs, events, sphinx riddles, rumors, daily events.
- Optional alternative victory conditions (capture a town, find an artifact).

## Step 5 — CLI and preview

- CLI: `node src/cli.ts generate --seed 123 --size 72 --players 4 --water medium --difficulty normal --out out/my_map.fh2m` (`--players` is the total count, human included).
- Config object for the generator (`GeneratorOptions`) shared by CLI and tests.
- Installation helper: copy a map into fheroes2's maps directory (`~/Library/Application Support/fheroes2/maps`) via `--install`.
- Full PNG preview (extending the step 3 preview): terrain colors, objects as markers, player starts, guards, zones. ASCII preview for terminals.
- Map summary output: counts of objects by type, zone sizes, resource totals per player.

## Step 6 — In-game verification

- Manual checklist (run at the end of every step from 1b on): the map appears in the fheroes2 map list, loads without errors, shows correct size and players, terrain transitions look right, objects render and are passable/blocking as expected, AI players move.
- Automated structural checks in tests: decode generated maps with our own codec, run the validation pass from step 4, and compare statistics against the fixture maps (object density, monster value distribution).
- Seed sweep: generate many seeds (e.g. 100) for every allowed size × player count and run the validator on each. Single-example tests will not catch rare unreachable maps.
- If fheroes2 logs errors on load, run it from a terminal and capture the log (`fheroes2` prints to stderr; add `--debug` style options as supported by the installed version).
- Compatibility note: pin the supported version (13). If a newer fheroes2 bumps the format, update `FORMAT_VERSION` and re-run round-trip tests on its bundled maps.

## Step 7 — Polish and optional extras

- Generation templates/presets (island, continent, many-lakes, wasteland, etc.). Island presets rely on the water-aware validator and boat placement from step 4.
- Themed map names and descriptions, optional Russian text with cp1251 encoding.
- Price of Loyalty content (the expansion data is present as `HEROES2X.AGG`): enable expansion objects, artifacts and monsters using the flags from step 2, behind an option.
- Optional: `.mp2` writer for the original game, only if explicitly wanted.
- Optional: small web UI (needs a dependency-free approach or a bundler once the registry is reachable).
- README with usage.

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
scripts/           one-off extractors that produce src/data, smoke-test helpers
test/
fixtures/          sample .fh2m maps (GPL, from fheroes2)
```

## Risks

- **fheroes2 rejecting our files**: our codec only proves self-consistency. Mitigated by the step 1b smoke test and in-game checks after every step.
- **Terrain transitions** are the least documented part; port directly from `map_format_helper.cpp` and validate against fixtures (modulo tile variants) before building on it.
- **Object table extraction** from 6k lines of C++ could be error-prone; verify with fixtures and prefer a scripted extraction over hand-copying.
- **Guaranteed reachability** is the main source of unplayable maps, especially with water; build the validator in step 4a and run it in every test and in the seed sweep.
- **fheroes2 format drift**: the format is versioned and evolving; keep the codec strict and tests on real maps.
- **No registry access** at times: keep runtime dependency-free; type checking may be unavailable until `typescript` can be installed.

## Definition of done

- `node src/cli.ts generate ...` produces a `.fh2m` that opens in the installed fheroes2 and is playable start to finish (starting town, reachable resources, guarded treasures, enemies, a winnable victory condition).
- Same seed gives the same map (identical uncompressed body).
- Maps for all four sizes and every allowed player count generate in a few seconds and pass the validator across the seed sweep.
- Generated map statistics (object density, resources per player, monster value distribution) fall within the range observed in the fixture maps.
- Tests cover the codec, object table, terrain, placement and validation.

## Review fixes: teams and zone sealing (2026-10-03)

Review of `--teams` (commit 0c68307) found that the feature does not work as intended in the game and that its
central design element — the walled-in team — is not actually sealed.

Findings:

1. **Alliances are never applied in-game.** fheroes2 reads `map.alliances` only for `VICTORY_DEFEAT_OTHER_SIDE`
   (victory type 4) and supports exactly two sides (`assert(map.alliances.size() == 2)` + `FillUnions` in
   `maps_fileinfo.cpp`). For every other victory condition alliances are serialized, sanitized by
   `updateMapPlayers`, and then ignored. Our maps write three alliances with victory types 0/1/3, so the three
   teams do not exist in gameplay. Also: `updateMapPlayers` runs on the game load path (`world_loadmap.cpp`) and
   appends every unused available color to the **last** alliance, so under type 4 all players end up on one of
   the two sides — three sides cannot be expressed.
2. **The wall seal leaks on every team map.** A passability probe of 84 generated maps (72/108/144, 4–6 players,
   all water levels) found 4–49 open walkable crossings into the walled team's zones on each. Causes: road
   routing (`routeRoads`) is not zone-constrained and reserves border tiles as `Reserve.ROAD`, where no wall can
   be placed; `wallZoneBorders` is best-effort and leaves free border tiles; `repairReachability` treats
   `'border'` walls as removable and may punch a path through them.
3. **Boats bypass the seal.** 54/84 probed maps have walled zones with a coastline; every start region gets
   boats, and a hero can disembark on any shore tile.
4. **The validator cannot see any of this.** Monsters are visitable in the movement model, so everything is
   "reachable" and the sweep reports 0 failures while the design is void.

### Decisions

| Topic | Decision |
|---|---|
| Teams in-game | Two alliances: side 1 = the human, side 2 = all computers (the middle computers join the rich team's side, since unused colors are appended to the last alliance). `victoryConditionType = 4` + `allowNormalVictory = true`. The three-tier economy (poor human / standard / rich walled-in) remains as map design. |
| `--victory` with `--teams` | Incompatible: a map has one victory condition and type 4 replaces capture-town/artifact. `validateOptions` rejects the combination. |
| Walled zones and water | All tiles of walled team zones go into `protectedLand` (never water) instead of restricting water levels. |
| Keeper walls and repair | Walls on walled-team borders get the tag `keeper`; `repairReachability` never removes them. |
| Peasant field vs AI | Accepted behavior: passing AI heroes may clear the field (it is weak by design). Documented in README. |

### Work items (implemented 2026-10-03)

All items below are implemented. The seal lives in `src/content/seal.ts`: the border ring of the walled zones is
defined by 8-adjacency (diagonal corners leak too), `checkZoneSeal` runs over `ContentContext` + `MovementModel` in
`generateAttempt` (before `finishMetadata`), in the teams test and in the sweep. Corridors inside walled zones keep
off the ring, corridor reservations never land on the ring, and `dryWalledShores` converts water that the terrain
transition fallback left next to the wall back to beach (the fallback replaces a corner tile's ground with a
neighboring one). `repairReachability` never removes `keeper`-tagged objects; the keeper stands on the road on the
walled side of its gate or the attempt fails.

1. **Seal check in the generator (P0).** Not in `validateMap` (it works on the encoded map without layout
   knowledge): add a check over `ContentContext` + `MovementModel` — no orthogonally adjacent enterable tile pair
   with one tile in a walled zone and one outside, except the keeper gate pairs. Run it in `generateAttempt`
   (before `finishMetadata`), in the teams test, and in the sweep. Land it first: it turns the invisible failure
   into visible sweep failures that items 2–5 then eliminate.
2. **Roads (P0).** `routeRoads`: a road path must not cross a walled-team border except through the keeper gate
   (zone-aware `passable` for `link`, the way the corridor legs in `landscape.ts` are already zone-scoped). After
   routing, assert that no `Reserve.ROAD` tile pair crosses a walled border.
3. **Guaranteed walls (P0).** `wallZoneBorders`: after the existing passes, fill every still-free tile on a
   walled-team border with a 1-tile obstacle (verify the object table has one for every ground), tagged `keeper`.
   If a tile still cannot be filled, throw `GenerationError`.
4. **Repair (P0).** Exclude the tag `keeper` from `REMOVABLE_TAGS`.
5. **Water (P0).** `generateLandscape`: with `teams`, add every tile of team-3 start zones to `protectedLand`.
6. **Two-side alliances (P1).** `finishMetadata`: `alliances = [teamMask(1), teamMask(2) | teamMask(3)]`,
   `victoryConditionType = 4`, `allowNormalVictory = true`. Check the fheroes2 source for what
   `VICTORY_DEFEAT_OTHER_SIDE` expects from `victoryConditionMetadata` and `isVictoryConditionApplicableForAI`,
   and set both accordingly. `validateOptions`: reject `teams` with `victory !== 'normal'`.
7. **Layout errors (P2).** `connectZones`: a walled group with no outgoing edge throws a labeled
   `GenerationError` instead of silently continuing and failing validation later.
8. **Tests and sweep (P0).** Teams test: alliances of length 2, victory type 4, the seal check, no water
   adjacency of walled zones, keeper guard records. Acceptance: 0 seal leaks and under 5% retries across a
   100-seed sweep (baseline: 18/1500 ≈ 1.2%).
9. **Docs (P2).** README: rewrite the Teams section (two sides, what actually changes in-game, keeper strength
   scales with difficulty — 3600 easy / 6000 normal / 11400 expert). This section covers SPEC.

### Verification

- `node src/cli.ts check` (fh2check, debug asserts) on teams maps: with victory type 4 the loader asserts
  `alliances.size() == 2`, so the game-code checker becomes load-bearing for this feature — run it on every teams
  seed in the sweep.
- Manual in-game checklist: the map list shows the alliance victory condition; computers do not attack each other
  or the walled team; team-3 income events arrive on day 1 and weekly; the keeper stands on the walled side of its
  gate; no path or boat route enters the walled team without passing the keeper; the peasant field and its rumor
  exist.
- Watch item: fheroes2 may lift the two-alliance limit ("As of now only 2 alliances are supported" in
  `maps_fileinfo.cpp`); revisit the three-team mapping when it does.

## Templates and the teams seal (2026-10-25)

The generator built every map on the same macro shape (starts on a ring, a center zone, best-candidate neutral
zones, MST + loops): seeds only jittered what the shape already was. `--template` adds five macro layouts, and
`random` (the default) picks one per seed.

| Template | Seeds | Connection policy |
|---|---|---|
| `ring` | As before: starts on a ring, center zone on 72+ maps, best-candidate neutral fill. | Unchanged (start-start edges penalized). |
| `hub` | Starts on a slightly wider ring; neutral seeds rejected within 0.42·W of the center, so every start zone borders the center zone. | Edges not touching the center cost 6x; the center zone gets `budgetScale` 1.6; non-center loops are rare (0.12). |
| `split` | Even players on one side of a random axis (x = W/2 or y = W/2), odd players on the other; no center zone. | Edges between the halves cost 8x unless they touch a bridge zone (a neutral zone with tiles on the axis whose neighbors include both halves; up to two, one per axis half, `budgetScale` 1.5). Landscape piles extra water score along the axis, so a strait crosses the map and the bridges stay dry. |
| `spine` | A wavy chain of zones across the map; starts on evenly spaced chain positions, both ends included; no center zone. | Edge cost grows with chain distance (1 / 2.2 / 10); loops only between chain neighbors. |
| `rings` | Starts on an outer ring (0.40·W), 2–4 inner-ring neutral zones at 0.16·W with `budgetScale` 1.8; no center zone. | Inner-inner edges cost 1, inner-outer gates 6x, extra gates into the inner ring rare (0.04). Inner zones claim more space in the Voronoi (weight 0.9) so they stay adjacent to each other. |

Template annotations live on `Zone` (`group`, `order`, `tag`, `budgetScale`) and `Layout` (`template`, `bridges`,
`splitVertical`); the rest of the pipeline (landscape, content, validation) works on any zone graph. The strict
"statistics within fixture ranges" test is pinned to `template: 'ring'` (the fixtures are hand-made classic
layouts); `test/template.test.ts` checks each template with loose bounds and structural asserts (hub star, split
bridge-only crossings, spine chain order, rings gates).

### Teams seal robustness

Probing teams maps exposed a severe regression that had slipped in with the 2026-10-03 seal rework and was
invisible because the sweep had not been re-run since: on 144/6 necromancer teams maps 16 of 24 arbitrary seeds
failed all 8 attempts (mostly "Cannot seal the walled team corridor"). Root causes, all fixed:

1. **Corridor side tiles spilled outside the walled zones.** A walled leg's diagonal steps rejected side tiles
   on the border ring, but not side tiles in a *neighboring* zone right next to the ring — such a tile sits on
   the outside of a slit and can never be walled. `legPass` now requires walled legs' diagonal side tiles to
   stay inside the walled zones (`src/terrain/landscape.ts`).
2. **The slit loop did not exempt keeper gates.** `generate.ts` sealed every corridor tile on the walled border,
   including the keeper gate itself — whose outside neighbors carry the approach road by design.
   `checkZoneSeal` exempts keeper gates; the slit loop now does the same.
3. **Slit neighborhoods were only enforced per connection.** The re-route of the outside leg could fail (kept
   via `?? legB`), and internal walled-walled corridors had no outside leg to re-route at all. Corridors are
   consumed only as tile sets (water protection, road reservations — `routeRoads` routes independently), so
   `generateLandscape` now drops, from any corridor line, the tiles outside the walled zones that are
   8-adjacent to a slit; the seal can then wall them. Keeper-gate approaches are exempt (the gate is the
   guarded crossing).

Two more changes the templates needed, both also helping the base generator:

- `placeCastle` searches with a cascade of widening windows (border distance 5→3→1 from the seed, distance up
  to 60): template zones can be thin strips (a spine cell on a 36-map is a ribbon with no tile 3 tiles from
  its border), and 36-sized zones with water had no deep interior at all. `canPlace` still guarantees the
  footprint.
- `rings` on 36-sized maps builds one inner vault instead of a ring, and `spine` keeps one extra zone, so
  scenario objects (victory town, crypt) always have non-start land.

Full-sweep comparison (100 seeds × 15 size/player combinations, same rotation): baseline HEAD 71 failures
(108/144 accounts for 70, almost all teams maps) versus 7 failures with the templates — 0 on 36/72 maps, all
7 remaining are teams + high water on 108/144 ("thin wall" at the map edge, or the repair unable to reconnect
the human's castle on wasteland/high). That residual class predates the templates and needs its own pass over
the water–wall interaction; retries went from 93 to 181 of 1500 (12%, above the old 5% bar — the cost of five
layouts, dominated by unlucky template/option combinations that the 8-attempt retry escapes).

### Templates

## The Dead Lands (2026-10-25)

`--deadlands` ("The Dead Lands", `src/content/deadlands.ts`, tests in `test/deadlands.test.ts`): a scenario map for
a necromancy playthrough, built on the teams machinery. The human is Lord Corlagon, a necromancer; the computers are
the living kingdoms; the richest of them sits walled behind its keeper (all of it reused from `--teams`, including
the seal, the two-alliance victory of type 4 and the three-tier economy). `resolveOptions` implies
`race: 'necromancer'`, `teams`, `twist`, `expansion`; `validateOptions` requires 4+ players, size 72+, the normal
victory, and rejects combining it with `--tale`.

What the mode adds on top of `--teams --race necromancer`:

- **Blight gradient** (`assignDeadlandsGrounds` in `src/layout/zones.ts`, first branch of `assignGrounds`): the
  human starts on wasteland, zones 0–1 BFS steps away over zone adjacency are dead (wasteland, dirt, swamp, lava),
  step 2 is a dirt band, farther zones and every computer's start zone are grass. The landscape's secondary-ground
  patches (enlarged for the necromancer race) keep working on any of these grounds.
- **Three fields of peasants** instead of one (`placePeasantFields`): fodder for the skeleton host; the first
  fields sit closest to the human's start. Only a total failure to place any field throws.
- **The prison of Morvath the Bonekeeper** (`placeDeadlandsPrison`): a jail one or two zones from the human's start
  with a necromancer prisoner (Necromancy 2, Wisdom 1) — the guaranteed Necromancy source, since a witch's hut
  cannot teach it in fheroes2. Guarded (5000), tagged required so the repair keeps it.
- **Texts and names** (ASCII English): fixed map name "The Dead Lands" and a story description; Deadwood Keep /
  Lord Corlagon, named living castles and heroes, rotting neutral town names, five load-bearing rumors (fields,
  prison, keeper, crypt, graveyards), dead-lands signs, and dead-lands messages for the twist and team-3 events.

`scripts/sweep.ts` rotates `--deadlands` in (4+ players, seed % 9 === 4). The ideas this mode implements and the
rejected alternatives live in `IDEAS.md`.

## The Long Night (2026-10-29)

`--dawn` ("The Long Night", `src/content/dawn.ts`, tests in `test/dawn.test.ts`): a necromancer scenario built on a
fixed calendar of reversals. Needs 3+ players, size 72+; implies the necromancer race and the expansion; incompatible
with `--teams`, `--twist`, `--victory`, `--tale`, `--deadlands`.

- **Victory and loss**: victory type 1 (capture the town) on Dawnspire, normal victory also counts; loss type 3
  (out of time) with metadata `[56]`. Dawnspire (`placeDawnspire`) is placed before the neutral zones are filled, in the
  zone farthest from the human's start, with five explicit garrison stacks (`defenderMonsterType/Count`).
- **Calendar** (`DAWN_EVENTS`): daily events alternating between the human (days 1, 21, 35, 49) and the computers
  (days 14, 28, 42), each with a story message. The twist option is not used, the calendar replaces the Pale Tide.
- **The tomb** (`placeTomb`): event object, human only, in the farthest zone other than Dawnspire's if possible:
  `monsterType` Bone Dragon x6, experience, resources, a major artifact, strong guard. Whether the game hands the
  monsters to the hero is not verified against fheroes2 (the other rewards are).
- **Prisons** (`placePrison`, shared with `--deadlands`): a necromancer with Necromancy and a defector knight.
- The ground gradient of the dead lands, two peasant fields, ASCII English texts; `scripts/sweep.ts` rotates `--dawn`
  in (3+ players, size 72+, seed % 9 === 7).
