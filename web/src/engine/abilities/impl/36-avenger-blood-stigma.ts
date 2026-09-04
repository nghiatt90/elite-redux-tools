// Batch AJ: two independent one-offs bundled together as the last of the easy
// cross-battler-fact checks.
//
// Avenger reads gSideTimers[side].retaliateTimer (a per-side history fact -- "did
// this side use Retaliate recently" -- this calculator has no turn history to
// derive). Rather than add a brand-new single-purpose field, this reuses the
// existing generic attackerAbilityOn toggle (BattlerBattleState.abilityOn) --
// exactly the same class of mechanism (a persistent in-battle activation flag this
// engine can't derive), just a different real ability reading it.
//
// Blood Stigma reads the move's TARGET's status1/hasBloodStainEffect, both of
// which already exist as per-battler condition data -- no new scenario field
// needed, just threading defenderStatus1/defenderHasBloodStainEffect onto
// OffensiveMultiplierContext (see its own doc).

import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

export const AVENGER_BLOOD_STIGMA_ABILITIES: AbilityImpl[] = [
  {
    // gSideTimers[side].retaliateTimer -- reuses the generic abilityOn toggle
    // rather than adding a single-purpose field for one ability.
    id: 'ABILITY_AVENGER',
    src: 'src/abilities.cc:3851',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.attackerAbilityOn) MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_BLOOD_STIGMA',
    src: 'src/abilities.cc:8373',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderStatus1.has('STATUS1_BLEED') || ctx.defenderHasBloodStainEffect) MUL(ctx, 2)
    },
  },
]
