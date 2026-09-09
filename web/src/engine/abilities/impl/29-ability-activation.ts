// Batch AC: the "ability activation state" family -- src/abilities.cc's
// GetAbilityState/SetAbilityState (a persistent per-battler flag) or an
// isFirstTurn/slowStartTimer volatile, none of which this non-turn-simulating
// calculator can derive on its own. Modelled as a single generic per-battler
// scenario toggle (BattlerBattleState.abilityOn, see its own doc), matching
// @smogon/calc's own `abilityOn` field for the same class of mechanism.
//
// abilityOn mirrors the RAW internal flag each ability's own GetAbilityState call
// reads -- NOT "is the boost currently active." Some abilities read it directly
// (Flash Fire: flag set == boosted), others invert it (Power Outage/Chuckster/
// Drakelp Head: flag set == ALREADY DISCHARGED == no longer boosted). Each entry's
// comment says which.
//
// Flash Fire's onAbsorb half is already ported (batch Y, 25-absorb.ts) -- this
// batch adds its onOffensiveMultiplier half to that same entry.

import { MUL } from '../macros'
import { ALWAYS_CRIT } from '../../crit'
import type { AbilityImpl } from '../types'

export const ABILITY_ACTIVATION_ABILITIES: AbilityImpl[] = [
  {
    // flag set == item lost (the actual trigger condition) -- direct read.
    id: 'ABILITY_UNBURDEN',
    src: 'src/abilities.cc:1451',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && ctx.abilityOn) ctx.stat *= 2
    },
  },
  {
    // flag set == already discharged (burned off its own type once) -- inverted.
    id: 'ABILITY_POWER_OUTAGE',
    src: 'src/abilities.cc:12331',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ELECTRIC' && !ctx.attackerAbilityOn) MUL(ctx, 2)
    },
  },
  {
    // flag set == already triggered this battle (single-use) -- inverted.
    id: 'ABILITY_CHUCKSTER',
    src: 'src/abilities.cc:10413',
    onDefensiveMultiplier: (ctx) => {
      if (!ctx.defenderAbilityOn && ctx.moveFlags.contact) MUL(ctx, 0.5)
    },
  },
  {
    // flag set == already triggered this battle (single-use) -- inverted.
    id: 'ABILITY_DRAKELP_HEAD',
    src: 'src/abilities.cc:12034',
    onDefensiveMultiplier: (ctx) => {
      if (!ctx.defenderAbilityOn) MUL(ctx, 0.65)
    },
  },
  {
    // isFirstTurn -- flag set == this IS the battler's first turn out. Modelled on
    // the ATTACKER's own toggle, matching @smogon/calc's own Stakeout ('Stakeout'
    // reads attacker.abilityOn there too, despite the C condition technically
    // being about the move's TARGET's isFirstTurn state).
    id: 'ABILITY_STAKEOUT',
    src: 'src/abilities.cc:2696',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.attackerAbilityOn) MUL(ctx, 2.0)
    },
  },
  {
    // isFirstTurn -- flag set == this battler's first turn out.
    id: 'ABILITY_AMBUSH',
    src: 'src/abilities.cc:5496',
    onCrit: (ctx) => (ctx.abilityOn ? ALWAYS_CRIT : 0),
  },
  {
    // slowStartTimer nonzero -- flag set == still within the first 5 turns since
    // switch-in. Real C is 5-tier decaying by exact turn count (Lethargy's own
    // ability body, :4941-4960); this engine has no turn counter, so it's
    // collapsed to the timer's own boolean "still running" (matching the timer's
    // OWN check, `if (timer)`) -- Lethargy's tiered version is left unmodelled for
    // exactly this reason.
    id: 'ABILITY_SLOW_START',
    src: 'src/abilities.cc:1715',
    onStat: (ctx) => {
      if ((ctx.statId === 'atk' || ctx.statId === 'spatk' || ctx.statId === 'spe') && ctx.abilityOn) ctx.stat /= 2
    },
  },
]
