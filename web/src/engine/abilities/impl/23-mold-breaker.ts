// Batch W: the onMoldBreaker family, PLUS (found tractable after all on a later
// pass, see this session's own audit) Deadly Precision/Flawless Precision/Mach 3/
// Overrule/Stonecutter -- their onMoldBreaker condition reads as circular (Mold
// Breaker is needed to compute type effectiveness/crit, but these abilities need
// type effectiveness/crit to decide Mold Breaker) but isn't actually one: it's a
// bounded two-branch lookup (calculate.ts computes the hypothetical ONCE, forcing
// Mold Breaker active, and hands the result to onMoldBreakerContext), not an
// iterative fixed point. See OnMoldBreakerContext's own doc (types.ts) for the
// exact fields (moveType/hypotheticalTypeEffectiveness/isForcedCrit) and who
// computes them.

import type { AbilityImpl } from '../types'

const SUPER_EFFECTIVE = 2048 // GetSuperEffectiveMult() == UQ_4_12(2.0)

export const MOLD_BREAKER_ABILITIES: AbilityImpl[] = [
  {
    // Referenced by Teravolt/Turboblaze/Blind Rage's onMoldBreaker (this batch,
    // and 12-adds-type.ts/10-aliases.ts's ADD-ONS below).
    id: 'ABILITY_MOLD_BREAKER',
    src: 'src/abilities.cc:1617',
    onMoldBreaker: () => true,
  },
  {
    id: 'ABILITY_MYCELIUM_MIGHT',
    src: 'src/abilities.cc:11147',
    onMoldBreaker: (ctx) => ctx.moveSplit === 'STATUS',
    // onInfiltrate (batch AA): same CHECK(IS_MOVE_STATUS(move)) condition, screens
    // bypass instead of mold breaker.
    onInfiltrate: (ctx) => ctx.moveSplit === 'STATUS',
  },
  {
    // src/abilities.cc:11162-11175. onAccuracy (its OTHER real hook, ported
    // separately -- accuracy isn't in this damage-only calculator's scope at all)
    // shares the exact same "already super-effective" condition, but computed
    // WITHOUT Mold Breaker there -- onMoldBreaker's own version forces it on
    // first, per the C's own nested CalculateMoveDamageAndEffectiveness call.
    // Flawless Precision (10-aliases.ts) and Mach 3 (10-aliases.ts) alias this
    // same onMoldBreaker; Overrule and Stonecutter (their own entries, already
    // ported elsewhere for their other hooks) have their own distinct conditions
    // (crit-based and Rock-type-based respectively), added directly onto their
    // existing entries in 11-offensive-multiplier-d.ts/10-aliases.ts rather than
    // here, to avoid a duplicate-registration error (one AbilityImpl object per
    // id, not one per hook).
    id: 'ABILITY_DEADLY_PRECISION',
    src: 'src/abilities.cc:11162',
    onMoldBreaker: (ctx) => ctx.hypotheticalTypeEffectiveness !== null && ctx.hypotheticalTypeEffectiveness >= SUPER_EFFECTIVE,
  },
]
