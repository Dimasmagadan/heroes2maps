# her2: random maps for Heroes of Might and Magic II

A random map generator for single-player games of Heroes of Might and Magic II. It writes maps in the
[fheroes2](https://github.com/ihhub/fheroes2) `.fh2m` format (version 13, fheroes2 1.1.17).

Each map has 1 human and 1–5 computer players. Every player starts with a castle, a hero and the same set of
mines. Zones are separated by walls of obstacles and linked through guarded gates. Content gets richer and better
guarded the farther it is from the starts.

## Requirements

- Node.js 26 or newer. TypeScript runs through Node's type stripping, so there is no build step.
- fheroes2 with The Price of Loyalty data (`HEROES2X.AGG`) to play the maps. All `.fh2m` maps require it.

## Usage

```sh
node src/cli.ts generate --seed 123 --size 72 --players 4 --water medium --difficulty normal --out out/my_map.fh2m
```

| Option | Values | Default |
|---|---|---|
| `--seed <n>` | 0–4294967295 | random |
| `--size <n>` | 36, 72, 108, 144 | 72 |
| `--players <n>` | total count, human included: 36 → 2–3, 72 → 2–4, 108/144 → 2–6 | 2 |
| `--water <level>` | none, low, medium, high | low |
| `--difficulty <d>` | easy, normal, hard, expert (scales guard strength) | normal |
| `--preset <p>` | continent, lakes, islands (zones on separate islands, boats provided), wasteland | continent |
| `--race <r>` | random, knight, barbarian, sorceress, warlock, wizard, necromancer (the human player's faction; computer players stay random) | random |
| `--victory <v>` | normal, capture-town (a neutral town far away), artifact (a guarded major artifact) | normal |
| `--expansion` | include The Price of Loyalty objects and artifacts | off |
| `--teams` | three teams, needs 4+ players (see "Teams") | off |
| `--name <text>` | map name (ASCII) | generated |
| `--out <file>` | output file | `out/random_<seed>.fh2m` |
| `--install` | copy the map into the fheroes2 maps directory | |
| `--preview <file.png>` | PNG preview: ground colors, roads, obstacles, objects by category, zone borders | |
| `--ascii` | ASCII preview | |
| `--summary` | statistics: object counts, density, guard strength, zones, mines per player | |
| `--check` | load the map with the real game code (see "Checking against the game") | |

The same seed with the same options always produces the same map: the uncompressed map body is identical. The
compressed file can still differ between zlib versions.

Other commands work on any `.fh2m` map, including hand-made ones:

```sh
node src/cli.ts preview  <map.fh2m> [--out file.png] [--ascii]
node src/cli.ts summary  <map.fh2m>
node src/cli.ts validate <map.fh2m>
node src/cli.ts check    <map.fh2m>
node src/cli.ts install  <map.fh2m>
```

`--install` and `install` copy the map to `~/Library/Application Support/fheroes2/maps` on macOS and
`~/.local/share/fheroes2/maps` on Linux. Set `$FHEROES2_MAPS_DIR` to use another directory. In the game, open
**New Game → Standard Game** and pick the map from the list.

## How it works

1. **Layout** (`src/layout/zones.ts`): start zones sit on a ring around the center. Bigger maps also get a
   center zone, and neutral zones fill the rest. Tiles go to zones by noisy weighted Voronoi. Zones are connected
   by a spanning tree plus extra loops; each connection has a gate on the shared border.
2. **Landscape** (`src/terrain/landscape.ts`): noise-based seas and lakes, but never on the corridors between
   zones or around starts. Each zone has a biome with patches of a second ground, beaches along coasts, and a
   smoothing pass.
3. **Terrain images** (`src/terrain/transitions.ts`): a port of fheroes2's terrain transition logic. It picks the
   tile image and flips for every tile from the grounds around it.
4. **Content** (`src/content/`): castles with starting heroes, then mines. Every player gets the same mines.
   Each zone then spends a value budget on treasures, artifacts, dwellings and power-ups, and guards are scaled
   to value, distance and difficulty. Next come pickups, roads, gate guards, boats, rivers, and finally walls
   along zone borders and clustered decoration.
5. **Validation and repair** (`src/validate.ts`, `src/content/repair.ts`): checks that every object is
   reachable from every start, that castle entrances are open, and that no objects overlap. It models action
   object entrances, fheroes2's diagonal-move rule, and boats. Decorations that block a path are removed; if an
   object still can't be reached, it is removed.

The object table (`src/data/`) is generated from the fheroes2 C++ source by `scripts/extract-objects.ts`. The
script compiles fheroes2's own `map_object_info.cpp` with a small dump program, so no table is copied by hand.

### Teams

`--teams` splits the players into three alliances: team 1 is the human alone, team 3 is 1 computer (2 if there are 4
or more computers) and team 2 is the other computers.

- Team 3 starts rich: all rare mines plus a gold mine, 1.7 times the start content, a bigger zone, 10000 gold and some
  resources on day 1, and 2500 gold every week. Its zones touch the rest of the map through a single connection per
  group of team zones, held by one huge guard (about 6000 army strength at normal difficulty).
- Team 1 starts poor: only one rare mine and half the start content.
- Somewhere in a neutral zone at least two zones away from the human's start (in a far corner of it) lies a field of
  12 peasant stacks of 150-350. They are weak, so beating them raises many skeletons for a necromancer: the army to
  break the huge guard. One of the rumors hints at the field.

### Necromancer tuning

`--race necromancer` gives the human a necromancer castle and hero on wasteland, and shapes the map for a necromancy
playthrough: graveyards, skeletons, Cities of the Dead and Barrow Mounds are three times as likely, neutral zones
carry 20% more guarded content, and guards come in larger stacks (more casualties to raise). With `--expansion`, a
guarded Spade of Necromancy lies in a far neutral zone.

## Checking against the game

`tools/fh2check` is a headless checker linked against a debug build of fheroes2. It loads a map exactly as the
game does when you start a new game, runs the game's internal asserts, and reports the passability the game
computed. Our movement model must never allow a move the game forbids; the tests compare the two.

```sh
git clone https://github.com/ihhub/fheroes2 && cd fheroes2 && git checkout 1.1.17
FHEROES2_WITH_DEBUG=1 make -C src/dist -j8          # needs SDL2 and SDL2_mixer
cd - && scripts/build-fh2check.sh path/to/fheroes2   # writes path/to/fheroes2/fh2check
export FH2CHECK=path/to/fheroes2/fh2check
node src/cli.ts check out/my_map.fh2m
```

## Development

```sh
npm test               # node --test; set FH2CHECK to also run the game checks, SWEEP_SEEDS=n for a longer sweep
npm run typecheck      # tsc
node scripts/sweep.ts --seeds 100 [--check]          # seed sweep over every size and player count
node scripts/smoke.ts  # writes a slightly modified fixture into the fheroes2 maps directory (in-game smoke test)
node scripts/extract-objects.ts path/to/fheroes2      # regenerate src/data from the fheroes2 source
```

## License

GPL-2.0-or-later, the same as fheroes2. The tables and algorithms ported from fheroes2 and the fixture maps are
GPL, so this project is a derived work. See [LICENSE](LICENSE).
