// Batch AE: the aura family -- Dark Aura/Fairy Aura boost same-type moves used by
// EITHER battler (onOffensiveMultiplierFor: APPLY_ON_ANY, so the offensive loop's
// existing attacker-slots AND defender-slots passes both invoke this hook
// regardless of who's actually attacking), reduced instead of boosted if any
// battler on the field holds an `auraBreak`-flagged ability (Aura Break, Nihil
// Blaster; see AbilityFlags.auraBreak's own doc). isAuraBreakActive is computed
// once per hit in calculate.ts (both battlers' slots) and handed in on the
// context, since this hook only ever sees its own holder's facts otherwise.
//
// Pixie Power already aliases Fairy Aura's onOffensiveMultiplier (batch H,
// 10-aliases.ts) -- no patch needed there, it starts working once the target
// stops being an unmodelled stub.

import { MUL } from '../macros'
import { APPLY_ON_ANY } from '../applyOn'
import type { AbilityImpl } from '../types'

export const AURA_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_DARK_AURA',
    src: 'src/abilities.cc:2493',
    applyOn: { onOffensiveMultiplierFor: APPLY_ON_ANY },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType !== 'DARK') return
      MUL(ctx, ctx.isAuraBreakActive ? 0.75 : 1.33)
    },
  },
  {
    id: 'ABILITY_FAIRY_AURA',
    src: 'src/abilities.cc:2508',
    applyOn: { onOffensiveMultiplierFor: APPLY_ON_ANY },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType !== 'FAIRY') return
      MUL(ctx, ctx.isAuraBreakActive ? 0.75 : 1.33)
    },
  },
]
