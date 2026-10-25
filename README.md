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
| `--template <t>` | random, ring, hub, split, spine, rings — the macro layout of the map (see "Templates") | random |
| `--race <r>` | random, knight, barbarian, sorceress, warlock, wizard, necromancer (the human player's faction; computer players stay random) | random |
| `--victory <v>` | normal, capture-town (a neutral town far away), artifact (a guarded major artifact) | normal |
| `--expansion` | include The Price of Loyalty objects and artifacts | off |
| `--teams` | two alliances in-game (human vs all computers) and a rich walled-in computer team behind one huge guard; needs 4+ players (see "Teams") | off |
| `--twist` | mid-game twist: on day 21 every computer gets a windfall (25000 gold, resources); a guarded crypt in the farthest neutral zone gives the human the counter (8000 exp, 12000 gold, rare resources, a major artifact); a rumor hints at it | off |
| `--tale` | scenario "Koschei the Deathless": Russian texts (cp1251, language 4), Koschei vs the heroes of Russian tales, prisons with friendly heroes, the place of power; implies necromancer, expansion and twist; size 72+ (see "Tale") | off |
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

1. **Layout** (`src/layout/zones.ts`): a template picks the macro shape (see "Templates") — where the start
   zones, the center and the neutral zones sit, and which zones are connected. Tiles go to zones by noisy
   weighted Voronoi. Zones are connected by a spanning tree plus extra loops; each connection has a gate on the
   shared border, and the template reweights the edges to push the graph into its shape.
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

### Templates

Every map has one of five macro layouts. By default (`--template random`) the seed picks one, so consecutive
seeds produce structurally different maps, not just reshuffled versions of the same shape. The template sets
the seed placement and the connection graph; water presets, content budgets and everything downstream stay the
same and work on any of them.

| Template | Layout |
|---|---|
| `ring` | The classic: start zones on a ring around the map, a center zone on bigger maps, neutral zones everywhere else. |
| `hub` | Everything routes through a rich center zone: start zones form a tight ring around it, neutral zones are pushed to the outskirts, and the connection graph is a star. The center carries extra content and a neutral town more often — breaking out of your own zone and reaching the middle is the whole game. |
| `split` | Two halves (even players west/north, odd players east/south) divided by a water strait (with any water level above `none`). Only one or two neutral "bridge" zones straddle the strait, keep their land dry, and carry the roads between the halves — guarded chokepoints by construction. |
| `spine` | A chain of zones across the map (either diagonal), with the starts spread along it, both ends included. A linear progression: every step past the next gate is deeper into neutral land. |
| `rings` | Starts on an outer ring around a rich inner ring of neutral zones (1.8x content budget) that connect mostly within itself and open to the outside through few guarded gates. The middle of the map is the prize. |

Teams (`--teams`), the necromancer tuning, victory conditions and the tale work with every template; `split`
even spreads the walled-in team across both halves, one keeper gate each.

### Teams

`--teams` needs 4+ players. In-game it creates two alliances — the `.fh2m` format (and fheroes2) supports only two
sides, and they apply only to the victory condition "defeat the other side", which the map sets: side 1 is the
human, side 2 all computers. The normal victory (defeating everyone) wins too. The three-tier economy below stays
as map design; the middle computers simply share the walled team's side.

- Team 3 (the walled-in computers) starts rich: all rare mines plus a gold mine, 1.7 times the start content, a bigger
  zone, 10000 gold and some resources on day 1, and 2500 gold every week. Its zones are sealed by a wall of obstacles
  that the generator never removes, with a single way in per group of team zones: a gate held by one huge guard
  standing on the road — about 3600 army strength on easy, 6000 on normal and 11400 on expert difficulty. Roads and
  corridors keep off the wall, the zones never touch water, and the generator verifies the seal on every map; the
  seed sweep checks it too.
- Team 1 (the human) starts poor: only one rare mine and half the start content.
- Somewhere in a neutral zone at least two zones away from the human's start (in a far corner of it) lies a field of
  12 peasant stacks of 150-350. They are weak by design and passing AI heroes may clear the field; beating them still
  raises many skeletons for a necromancer: the army to break the huge guard. One of the rumors hints at the field.

### Tale

`--tale` builds a story map. The human is Koschei the Deathless (necromancer), who abducted Marya Morevna; the computers
are Ilya Muromets, Ivan Tsarevich, Vasilisa the Wise, Sadko and Dobrynya Nikitich, each with a fixed faction. All
texts are Russian, stored as cp1251 with the map language set to Russian (switch the game to Russian to read them).

- Prisons with friendly heroes (the villains of the tales): Baba Yaga (Necromancy, Wisdom), Zmey Gorynych and
  Solovey the Robber, each behind a guard in a neutral zone.
- The Bald Mountain, a place of power in a neutral zone: Tree of Knowledge, Arena, Gazebo and Baba Yaga's hut
  (Wisdom), each guarded, with a sign. A witch's hut cannot teach Necromancy in fheroes2, hence Baba Yaga in prison.
- The twist: day 21, "the Grey Wolf shows the heroes the way to Buyan" gives every computer 25000 gold and resources.
  The counter is the oak on Buyan, a guarded event object in the farthest neutral zone (8000 experience, 12000 gold,
  rare resources, a major artifact). A necromancer cannot build a tavern, so the hint sits on a sign far from the castle.
- No Sphinx (the riddle answers would have to be typed in cp1251). Neutral towns and castles get names from the tales.

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
