// Batch AM: Sheer Force. FLAG_SHEER_FORCE_BOOST (src/abilities.cc:1858,
// battle_util.c:8563) is a static per-move data flag, but it's never emitted by the
// pipeline as its own key -- BattleMovesGenerator.kt derives it entirely from fields
// we already have: `sheerForce = split != STATUS && effectChance != 0 &&
// !noSheerForce` (both the move's own effect and, for two-turn moves, its argument's
// effect can set noSheerForce -- the argument half isn't threaded into MoveData, so
// this ports the common case, matching this engine's existing move-argument
// approximations elsewhere). Recompute the same condition instead of adding a
// pipeline field for it.

import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

export const SHEER_FORCE_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_SHEER_FORCE',
    src: 'src/abilities.cc:1855',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'STATUS') return
      if (ctx.moveEffectChance === 0) return
      if (ctx.moveFlags.noSheerForce) return
      MUL(ctx, 1.3)
    },
  },
]
