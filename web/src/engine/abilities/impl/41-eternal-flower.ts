// Batch AP: Eternal Flower. Applies to ALL 5 stats (unlike the single-stat Ruin
// abilities), on the OPPONENT (applyOn.onStatFor: APPLY_ON_OTHER, same shape as
// Ruin), gated by a non-stacking flag in the SAME shared NonStackingState bitfield
// Ruin uses (a separate bit, abilities.hh:70-74) -- at most one Eternal Flower
// effect applies per stat computation, independent of Ruin's own bit.
//
// `BattlerHasAbility(battler, ABILITY_ETERNAL_FLOWER, FALSE)` is the STAT OWNER's
// own self-immunity check (an Eternal Flower holder never gets debuffed by another
// Eternal Flower holder) -- ctx has no other way to see the stat owner's own
// ability slots, so computeOnStatModifier (dispatchCalc.ts) computes this once per
// call as ctx.statOwnerHasEternalFlower.
//
// GetBaseSpeciesFromMega(species) reduces to species.json's own `megas`/`primals`
// lists being nonempty (this species itself IS a Mega/Primal form right now) --
// see ConditionBattlerContext.isMegaEvolved's own doc for the reverse-mapping
// generator that establishes this equivalence.

import { APPLY_ON_OTHER } from '../applyOn'
import type { AbilityImpl } from '../types'

export const ETERNAL_FLOWER_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_ETERNAL_FLOWER',
    src: 'src/abilities.cc:11630',
    applyOn: { onStatFor: APPLY_ON_OTHER },
    onStat: (ctx) => {
      if (ctx.statOwnerHasEternalFlower) return
      if (!ctx.isMegaEvolved) return
      if (ctx.flags.nonStackingEternalFlower) return
      ctx.stat = Math.trunc(ctx.stat * 0.8)
      ctx.flags.nonStackingEternalFlower = true
    },
  },
]
