// Batch Y: onAbsorb family -- census hook added in the field-report audit.
// TestAbsorbingAbilities (src/battle_util.c:8961-8969), called from
// AbilityBattleEffects(ABILITYEFFECT_ABSORBING) during normal move resolution
// (src/battle_script_commands.c:1224): when it returns truthy, the move deals ZERO
// damage and is redirected into a heal/stat-boost/Flash-Fire-flag script instead.
// WIRED into calculate.ts (computeIsAbsorbed, right after the type-effectiveness
// check) -- unlike batch X's Parental Bond, this genuinely changes today's number
// to 0, the same way a type immunity does.
//
// checkMoldBreaker=TRUE in the C, so every entry below is `breakable` EXCEPT
// Justified and Elemental Vortex, matching abilityHooks.json exactly (verified,
// not assumed) -- neither declares `.breakable = TRUE` in abilities.cc.
//
// 20 of this batch's 22 census abilities get a fresh entry here; Dry Skin and
// Elemental Vortex already had a real entry for a DIFFERENT hook elsewhere and
// were patched in place, not duplicated.
//
// Flash Fire's onOffensiveMultiplier half (a 1.5x boost gated on the C's
// per-battler RESOURCE_FLAG_FLASH_FIRE, i.e. "did Flash Fire actually activate
// this battle") is NOT ported here -- this calculator has no `abilityOn`-style
// activation-state scenario toggle yet (field-report group C: Flash Fire/
// Unburden/Protosynthesis/... all need one). Only Flash Fire's onAbsorb half
// (real, testable, and independent of that gap) is ported.

import type { AbilityImpl } from '../types'

export const ABSORB_ABILITIES: AbilityImpl[] = [
  { id: 'ABILITY_AERODYNAMICS', src: 'src/abilities.cc:3750', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'FLYING' },
  { id: 'ABILITY_EARTH_EATER', src: 'src/abilities.cc:5790', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'GROUND' },
  { id: 'ABILITY_EVAPORATE', src: 'src/abilities.cc:5727', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'WATER' },
  { id: 'ABILITY_FIRE_ASPECT', src: 'src/abilities.cc:10472', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'FIRE' },
  {
    // onOffensiveMultiplier (Flash-Fire-activated 1.5x boost) not ported -- see the
    // file-level note above; no scenario state exists yet for "did this activate".
    id: 'ABILITY_FLASH_FIRE',
    src: 'src/abilities.cc:695',
    flags: { breakable: true },
    onAbsorb: (ctx) => ctx.moveType === 'FIRE',
  },
  { id: 'ABILITY_HEAT_SINK', src: 'src/abilities.cc:10440', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'FIRE' },
  { id: 'ABILITY_ICE_DEW', src: 'src/abilities.cc:4783', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'ICE' },
  // Not breakable -- ER's own condition, verified against abilities.cc (no
  // `.breakable = TRUE` on this block, unlike every other ability in this batch).
  { id: 'ABILITY_JUSTIFIED', src: 'src/abilities.cc:2177', onAbsorb: (ctx) => ctx.moveType === 'DARK' },
  { id: 'ABILITY_LIGHTNING_ASPECT', src: 'src/abilities.cc:10462', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'ELECTRIC' },
  { id: 'ABILITY_LIGHTNING_ROD', src: 'src/abilities.cc:853', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'ELECTRIC' },
  { id: 'ABILITY_MOLTEN_CORE', src: 'src/abilities.cc:10609', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'ROCK' },
  { id: 'ABILITY_MOTOR_DRIVE', src: 'src/abilities.cc:1391', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'ELECTRIC' },
  { id: 'ABILITY_POISON_ABSORB', src: 'src/abilities.cc:4406', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'POISON' },
  { id: 'ABILITY_RESERVOIR', src: 'src/abilities.cc:9195', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'WATER' },
  { id: 'ABILITY_SAP_SIPPER', src: 'src/abilities.cc:2206', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'GRASS' },
  { id: 'ABILITY_STORM_DRAIN', src: 'src/abilities.cc:1740', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'WATER' },
  { id: 'ABILITY_VOLT_ABSORB', src: 'src/abilities.cc:598', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'ELECTRIC' },
  { id: 'ABILITY_WATER_ABSORB', src: 'src/abilities.cc:607', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'WATER' },
  { id: 'ABILITY_WELL_BAKED_BODY', src: 'src/abilities.cc:5749', flags: { breakable: true }, onAbsorb: (ctx) => ctx.moveType === 'FIRE' },
  { id: 'ABILITY_WIND_RIDER', src: 'src/abilities.cc:6240', flags: { breakable: true }, onAbsorb: (ctx) => Boolean(ctx.moveFlags.airBased) },
]
