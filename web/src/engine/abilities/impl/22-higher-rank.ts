// Batch T: Higher Rank, unblocked by threading move.priority through to
// OffensiveMultiplierContext.

import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

export const HIGHER_RANK_ABILITIES: AbilityImpl[] = [
  {
    // GetMovePriority(battler, move, target) > 0 -- ability-adjusted priority
    // (Prankster etc.) isn't modelled, just the move's own declared value.
    id: 'ABILITY_HIGHER_RANK',
    src: 'src/abilities.cc:8220',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.movePriority > 0) MUL(ctx, 1.2)
    },
  },
]
