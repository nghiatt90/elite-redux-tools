// Batch AQ: Illusion and Lethargy. Illusion's `gBattleStruct->illusion[battler].on
// && !broken` is a per-battle activation-state flag, the same class of mechanism the
// generic attackerAbilityOn toggle already covers (Flash Fire, Avenger, Soothsayer,
// ...) -- reused directly rather than adding a new single-purpose field.
//
// Lethargy reads the EXACT value of gVolatileStructs[battler].slowStartTimer for a
// 5-tier multiplier, unlike Slow Start's own plain `if (timer)` boolean check on the
// SAME underlying per-battler timer (already ported as the generic abilityOn
// toggle, see 29-ability-activation.ts) -- a boolean can't represent 5 distinct
// tiers, so this needed a new numeric BattlerBattleState.slowStartTimer scenario
// field instead of reusing abilityOn.

import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

export const ILLUSION_LETHARGY_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_ILLUSION',
    src: 'src/abilities.cc:2118',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.attackerAbilityOn) MUL(ctx, 1.3)
    },
  },
  {
    id: 'ABILITY_LETHARGY',
    src: 'src/abilities.cc:4934',
    onOffensiveMultiplier: (ctx) => {
      switch (ctx.attackerSlowStartTimer) {
        case 0:
        case 1:
          MUL(ctx, 0.2)
          return
        case 2:
          MUL(ctx, 0.4)
          return
        case 3:
          MUL(ctx, 0.6)
          return
        case 4:
          MUL(ctx, 0.8)
          return
      }
    },
  },
]
