// Stubs for symbols referenced by the compiled fheroes2 sources but not needed by the dump.
// Anything that would affect extracted data aborts instead of returning a fake value.

#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>

#include "rand.h"
#include "race.h"
#include "resource.h"
#include "settings.h"
#include "speed.h"
#include "spell.h"
#include "tools.h"
#include "translations.h"

[[noreturn]] static void unexpected( const char * name )
{
    std::cerr << "extract-stubs: unexpected call to " << name << std::endl;
    std::abort();
}

void StringReplace( std::string &, const char *, const std::string_view )
{
    unexpected( "StringReplace" );
}

const char * Translation::gettext( const char * str )
{
    return str;
}

const char * Translation::ngettext( const char * str, const char * plural, size_t n )
{
    return n == 1 ? str : plural;
}

const char * Race::String( int )
{
    unexpected( "Race::String" );
}

uint32_t Rand::Get( uint32_t, uint32_t )
{
    unexpected( "Rand::Get" );
}

const char * Speed::String( uint32_t )
{
    unexpected( "Speed::String" );
}

Settings & Settings::Get()
{
    unexpected( "Settings::Get" );
}

bool Settings::isPriceOfLoyaltySupported() const
{
    unexpected( "Settings::isPriceOfLoyaltySupported" );
}

std::string Funds::String() const
{
    unexpected( "Funds::String" );
}

Funds Funds::operator-( const Funds & ) const
{
    unexpected( "Funds::operator-" );
}

Funds Funds::operator*( uint32_t ) const
{
    unexpected( "Funds::operator*" );
}

bool Spell::isAliveOnly() const
{
    unexpected( "Spell::isAliveOnly" );
}

bool Spell::isUndeadOnly() const
{
    unexpected( "Spell::isUndeadOnly" );
}

bool Spell::isMindInfluence() const
{
    unexpected( "Spell::isMindInfluence" );
}

bool Spell::isApplyToEnemies() const
{
    unexpected( "Spell::isApplyToEnemies" );
}

uint32_t Spell::Damage() const
{
    unexpected( "Spell::Damage" );
}

const char * Spell::GetName() const
{
    unexpected( "Spell::GetName" );
}
