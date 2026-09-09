// Batch S: abilities whose applyOn scope is ALLY-ONLY (Rat King's onStatFor) or
// excludes self (Mosh Pit's onOffensiveMultiplierFor: APPLY_ON_ALLY_ONLY) --
// verified against isApplyOnFlagAppropriate's own bit logic (applyOn.ts) that
// these NEVER fire in this v1 singles engine regardless of their body, the same
// way Plus/Minus/Telepathy are already documented as permanently inert. Ported
// with real (if partial, for Mosh Pit) bodies anyway for completeness, since the
// applyOn scope -- not the body -- is what makes them inert.

import { MUL } from '../macros'
import { APPLY_ON_ALLY, APPLY_ON_ALLY_ONLY } from '../applyOn'
import type { AbilityImpl } from '../types'

export const ALLY_ONLY_ABILITIES: AbilityImpl[] = [
  {
    // IsRecklessBoosted's full condition also checks STATUS2_ENRAGED and a
    // self-ability onRecoil hook, neither tracked -- moot here since
    // onOffensiveMultiplierFor: APPLY_ON_ALLY_ONLY means this never fires without
    // a live ally battler.
    id: 'ABILITY_MOSH_PIT',
    src: 'src/abilities.cc:8335',
    applyOn: { onOffensiveMultiplierFor: APPLY_ON_ALLY_ONLY },
    onOffensiveMultiplier: (ctx) => MUL(ctx, ctx.moveFlags.reckless ? 1.5 : 1.25),
  },
  {
    id: 'ABILITY_RAT_KING',
    src: 'src/abilities.cc:10797',
    applyOn: { onStatFor: APPLY_ON_ALLY },
    onStat: () => {},
  },
]
