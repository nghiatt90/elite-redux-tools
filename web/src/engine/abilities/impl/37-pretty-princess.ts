// Batch AL: Pretty Princess -- IsUnaware(battler) is the ATTACKER checking its OWN
// Unaware flag (self, never suppressed even though Unaware is breakable -- matches
// every other self-check in this registry, e.g. computeChooseOffensiveStat's own
// abilities), gating whether it "notices" the DEFENDER's lowered stats at all.
// HasAnyLoweredStat(target) already existed as ConditionBattlerContext.
// negativeStatStageCount (CountBattlerStatDecreases, used by Lash Out) -- just
// needed threading onto OffensiveMultiplierContext as a derived boolean.

import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

export const PRETTY_PRINCESS_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_PRETTY_PRINCESS',
    src: 'src/abilities.cc:5258',
    onOffensiveMultiplier: (ctx) => {
      if (!ctx.attackerIsUnaware && ctx.defenderHasAnyLoweredStat) MUL(ctx, 1.5)
    },
  },
]
