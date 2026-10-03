#!/bin/sh
# Builds tools/fh2check against a fheroes2 checkout that was built with:
#   FHEROES2_WITH_DEBUG=1 make -C src/dist -j
# Usage: scripts/build-fh2check.sh <fheroes2-checkout>   (writes <fheroes2-checkout>/fh2check)
set -e
ROOT=$(cd "$1" && pwd)
HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/src"
OBJ="$SRC/dist/fheroes2"
INC=$(find "$SRC/fheroes2" "$SRC/engine" -type d | sed 's/^/-I/' | tr '\n' ' ')
SDL=$(sdl2-config --cflags 2>/dev/null || echo "-I/opt/homebrew/include/SDL2")
# shellcheck disable=SC2086
c++ -std=c++17 -DWITH_DEBUG $INC $SDL -c "$HERE/tools/fh2check/fh2check.cpp" -o "$ROOT/fh2check.o"
OBJS=$(ls "$OBJ"/*.o | grep -v '/fheroes2\.o$')
# shellcheck disable=SC2086
c++ -o "$ROOT/fh2check" "$ROOT/fh2check.o" $OBJS "$SRC/dist/engine/libengine.a" "$SRC/dist/thirdparty/libsmacker/libsmacker.a" \
  -lSDL2_mixer -L/opt/homebrew/lib -lSDL2main -lSDL2 -Wl,-framework,Cocoa -lz -pthread
echo "Built $ROOT/fh2check"
