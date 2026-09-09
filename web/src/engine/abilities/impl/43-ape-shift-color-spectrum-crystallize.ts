// Batch AR: Ape Shift, Color Spectrum, Crystallize.
//
// Ape Shift's onCrit is a plain self-species check (SPECIES_SLAKING_MEGA_APE_SHIFT)
// -- new OnCritContext.speciesId field (self, per-side-resolved the same way
// abilityOn already is), since no existing hook threaded species per-side.
//
// Color Spectrum's onEndTurn randomly reassigns its own type every turn -- not
// simulated (no turn history) -- but its onOffensiveMultiplier condition
// (StabMultiplierInHalves > 2) is just "does this move currently get STAB at all,"
// independent of how the attacker came to have that type. New
// OffensiveMultiplierContext.attackerHasStab field reuses calculate.ts's own
// stabInHalves() call, computed earlier than its usual (later) call site.
//
// Crystallize converts Rock->Ice (onMoveType, sets ateBoost) and its own
// onOffensiveMultiplier checks moveType==ICE && ateBoost -- UNLIKE Superconductor's
// analogous Steel->Electric conversion (checks moveType==NORMAL, never matching its
// own output), Crystallize's own conversion DOES satisfy its own bonus condition,
// so this one fires from a single ability with no multi-ability combo needed.

import { MUL } from '../macros'
import { ALWAYS_CRIT } from '../../crit'
import type { AbilityImpl } from '../types'

export const APE_SHIFT_COLOR_SPECTRUM_CRYSTALLIZE_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_APE_SHIFT',
    src: 'src/abilities.cc:9036',
    onCrit: (ctx) => {
      return ctx.speciesId === 'SPECIES_SLAKING_MEGA_APE_SHIFT' ? ALWAYS_CRIT : 0
    },
  },
  {
    id: 'ABILITY_COLOR_SPECTRUM',
    src: 'src/abilities.cc:8710',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.attackerHasStab) MUL(ctx, 1.2)
    },
  },
  {
    id: 'ABILITY_CRYSTALLIZE',
    src: 'src/abilities.cc:3729',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ICE' && ctx.ateBoost) MUL(ctx, 1.1)
    },
    onMoveType: (ctx) => {
      if (ctx.moveType !== 'ROCK') return
      ctx.moveType = 'ICE'
      ctx.ateBoost = true
    },
  },
]
