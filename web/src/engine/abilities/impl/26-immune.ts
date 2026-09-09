// Batch Z: onImmune family -- census hook added in the field-report audit.
// TestImmunityAbilities (src/battle_util.c:8978-8997), called from
// AbilityBattleEffects(ABILITYEFFECT_MOVES_BLOCK) before a move's script runs: a
// true return aborts the move outright (0 damage, no heal/stat-boost side effect --
// unlike onAbsorb). WIRED into calculate.ts (computeIsImmune, right after the
// onAbsorb check), forcing typeEffectiveness to 0 the same way.
//
// checkMoldBreaker=TRUE, so every entry below is `breakable` except Delta Stream
// (verified against abilities.cc: no `.breakable = TRUE` on its block).
//
// See OnImmuneContext's own doc (types.ts) for the three C conditions this engine
// treats as fixed always-true/always-false constants rather than real context
// fields: same-side/self-target/gProcessingExtraAttacks checks that are trivial or
// unmodelled multi-hit state.
//
// 14 of this batch's 19 census abilities get a fresh entry here; the other 5
// (Empress, Sand Fiend, Sand Guard, Sepia Lens, Sun Basking) already had a real
// entry for a different hook elsewhere and were patched in place.

import { aliasImmune } from './alias'
import type { AbilityImpl } from '../types'

export const IMMUNE_ABILITIES: AbilityImpl[] = [
  {
    // GetMovePriority(attacker, move, battler) > 0 -- the C also checks
    // gProcessingExtraAttacks and same-side, both fixed always-true/false here
    // (see OnImmuneContext's doc).
    id: 'ABILITY_QUEENLY_MAJESTY',
    src: 'src/abilities.cc:2955',
    flags: { breakable: true },
    onImmune: (ctx) => ctx.movePriority > 0,
  },
  { id: 'ABILITY_ARMOR_TAIL', src: 'src/abilities.cc:7223', flags: { breakable: true }, onImmune: aliasImmune('ABILITY_QUEENLY_MAJESTY') },
  { id: 'ABILITY_ROYAL_DECREE', src: 'src/abilities.cc:10299', flags: { breakable: true }, onImmune: aliasImmune('ABILITY_QUEENLY_MAJESTY') },
  {
    id: 'ABILITY_DAZZLING',
    src: 'src/abilities.cc:3008',
    flags: { breakable: true },
    onImmune: aliasImmune('ABILITY_QUEENLY_MAJESTY'),
  },
  { id: 'ABILITY_LUCHA_LIBRE', src: 'src/abilities.cc:11838', flags: { breakable: true }, onImmune: aliasImmune('ABILITY_DAZZLING') },
  {
    id: 'ABILITY_BULLETPROOF',
    src: 'src/abilities.cc:2327',
    flags: { breakable: true },
    onImmune: (ctx) => Boolean(ctx.moveFlags.ballistic),
  },
  { id: 'ABILITY_CHESTNUT_SHIELD', src: 'src/abilities.cc:11458', flags: { breakable: true, magicGuard: true }, onImmune: aliasImmune('ABILITY_BULLETPROOF') },
  {
    id: 'ABILITY_SOUNDPROOF',
    src: 'src/abilities.cc:1025',
    flags: { breakable: true },
    onImmune: (ctx) => Boolean(ctx.moveFlags.sound),
  },
  { id: 'ABILITY_NOISE_CANCEL', src: 'src/abilities.cc:7510', flags: { breakable: true }, onImmune: aliasImmune('ABILITY_SOUNDPROOF') },
  { id: 'ABILITY_PARROTING', src: 'src/abilities.cc:6854', flags: { breakable: true }, onImmune: aliasImmune('ABILITY_SOUNDPROOF') },
  {
    // Not breakable -- verified against abilities.cc (no `.breakable = TRUE`).
    id: 'ABILITY_DELTA_STREAM',
    src: 'src/abilities.cc:2549',
    onImmune: (ctx) => Boolean(ctx.moveFlags.weatherBased),
  },
  { id: 'ABILITY_WEATHER_CONTROL', src: 'src/abilities.cc:4524', flags: { breakable: true }, onImmune: aliasImmune('ABILITY_DELTA_STREAM') },
  {
    id: 'ABILITY_GOOD_AS_GOLD',
    src: 'src/abilities.cc:7332',
    flags: { breakable: true },
    onImmune: (ctx) => ctx.moveSplit === 'STATUS',
  },
  {
    id: 'ABILITY_RADIANCE',
    src: 'src/abilities.cc:5517',
    flags: { breakable: true },
    onImmune: (ctx) => ctx.moveType === 'DARK',
  },
]
