// Headless map checker linked against a fheroes2 build (see scripts/fh2check.ts).
//
// Loads a .fh2m map exactly like the game does for a new standard game (Maps::Map_Format::loadMap,
// Maps::FileInfo::loadResurrectionMap, Players::Init, World::loadResurrectionMap) and prints a JSON summary:
// players, castle/hero counts and the per-tile passability fheroes2 computed. A debug build of fheroes2
// (FHEROES2_WITH_DEBUG=1) also runs the game's internal asserts on the map data.

#include <iostream>
#include <string>

#include "color.h"
#include "kingdom.h"
#include "map_format_info.h"
#include "maps.h"
#include "maps_fileinfo.h"
#include "maps_tiles.h"
#include "mp2.h"
#include "players.h"
#include "settings.h"
#include "world.h"
#include "world_pathfinding.h"
#include "heroes.h"

int main( int argc, char ** argv )
{
    if ( argc < 2 ) {
        std::cerr << "Usage: fh2check <map.fh2m>" << std::endl;
        return 1;
    }

    const std::string path = argv[1];

    // The game enables this when HEROES2X.AGG is present; .fh2m maps always require it.
    Settings::Get().EnablePriceOfLoyaltySupport( true );

    Maps::Map_Format::MapFormat mapFormat;
    if ( !Maps::Map_Format::loadMap( path, mapFormat ) ) {
        std::cout << "{\"ok\":false,\"stage\":\"loadMap\"}" << std::endl;
        return 2;
    }

    Maps::FileInfo fileInfo;
    if ( !fileInfo.loadResurrectionMap( mapFormat, path ) ) {
        std::cout << "{\"ok\":false,\"stage\":\"fileInfo\"}" << std::endl;
        return 2;
    }

    Settings & conf = Settings::Get();
    conf.setCurrentMapInfo( fileInfo );
    Players & players = conf.GetPlayers();
    players.Init( conf.getCurrentMapInfo() );
    players.SetStartGame();

    if ( !world.loadResurrectionMap( path ) ) {
        std::cout << "{\"ok\":false,\"stage\":\"world\"}" << std::endl;
        return 2;
    }

    const int32_t size = world.w() * world.h();

    std::cout << "{\"ok\":true,\"width\":" << world.w() << ",\"name\":\"" << fileInfo.name.size() << "\",\"kingdoms\":" << static_cast<int>( fileInfo.kingdomColors )
              << ",\"humans\":" << static_cast<int>( fileInfo.colorsAvailableForHumans ) << ",\"computers\":" << static_cast<int>( fileInfo.colorsAvailableForComp )
              << ",\"castles\":" << world.getCastleCount() << ",\"kingdomsInfo\":[";

    bool first = true;
    for ( const PlayerColor color : PlayerColorsVector( fileInfo.kingdomColors ) ) {
        const Kingdom & kingdom = world.GetKingdom( color );
        std::cout << ( first ? "" : "," ) << "{\"color\":" << static_cast<int>( color ) << ",\"castles\":" << kingdom.GetCastles().size()
                  << ",\"heroes\":" << kingdom.GetHeroes().size() << "}";
        first = false;
    }

    std::cout << "],\"passability\":[";
    for ( int32_t i = 0; i < size; ++i ) {
        std::cout << ( i ? "," : "" ) << world.getTile( i ).GetPassable();
    }
    std::cout << "],\"objectTypes\":[";
    for ( int32_t i = 0; i < size; ++i ) {
        std::cout << ( i ? "," : "" ) << static_cast<int>( world.getTile( i ).getMainObjectType( false ) );
    }
    std::cout << "],\"water\":[";
    for ( int32_t i = 0; i < size; ++i ) {
        std::cout << ( i ? "," : "" ) << ( world.getTile( i ).isWater() ? 1 : 0 );
    }
    std::cout << "]";

    // Tiles reachable by each kingdom's first hero according to the game's own pathfinder (fog cleared).
    // The pathfinder does not walk through action objects, so the frontier of action tiles is included.
    for ( int32_t i = 0; i < size; ++i ) {
        world.getTile( i ).ClearFog( fileInfo.kingdomColors );
    }
    std::cout << ",\"heroReach\":[";
    first = true;
    for ( const PlayerColor color : PlayerColorsVector( fileInfo.kingdomColors ) ) {
        const Kingdom & kingdom = world.GetKingdom( color );
        if ( kingdom.GetHeroes().empty() ) {
            continue;
        }
        const Heroes * hero = kingdom.GetHeroes().front();
        PlayerWorldPathfinder pathfinder;
        pathfinder.reset();
        pathfinder.reEvaluateIfNeeded( *hero );
        std::cout << ( first ? "" : "," ) << "{\"color\":" << static_cast<int>( color ) << ",\"start\":" << hero->GetIndex() << ",\"tiles\":[";
        bool firstTile = true;
        for ( int32_t i = 0; i < size; ++i ) {
            if ( i == hero->GetIndex() || !pathfinder.buildPath( i ).empty() ) {
                std::cout << ( firstTile ? "" : "," ) << i;
                firstTile = false;
            }
        }
        std::cout << "]}";
        first = false;
    }
    std::cout << "]}" << std::endl;
    return 0;
}
