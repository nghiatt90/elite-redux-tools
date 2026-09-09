// The two macros nearly every ability port needs, src/abilities.cc:133-139:
//
//   #define MUL(val) MUL_MODIFIER(modifier, val)
//   #define RESISTANCE(val) { MUL_MODIFIER(resistance, val); MUL_MODIFIER(modifier, val); }
//
// `resistance` is tracked on ModifierAccumulator purely for signature fidelity --
// CalculateAbilityMultipliers' damage call site passes `&ignored` for it
// (src/battle_util.c:7531, verified), so it never affects a damage number. MUL and
// RESISTANCE are therefore interchangeable here; ports use whichever the source line
// literally says, so a diff against the C stays trivial to eyeball.

import { mulModifier, uq } from '../fixed'
import type { ModifierAccumulator } from './types'

/** MUL(val), src/abilities.cc:133. `val` is a decimal multiplier (e.g. `MUL(1.5)` in
 * the C), not a pre-computed UQ_4_12 value -- matches call sites like `MUL(1.5);`
 * verbatim. */
export function MUL(ctx: ModifierAccumulator, val: number): void {
  ctx.modifier = mulModifier(ctx.modifier, uq(val))
}

/** RESISTANCE(val), src/abilities.cc:134-138. */
export function RESISTANCE(ctx: ModifierAccumulator, val: number): void {
  ctx.resistance = mulModifier(ctx.resistance, uq(val))
  ctx.modifier = mulModifier(ctx.modifier, uq(val))
}

/** CHECK(cond), src/abilities.cc's early-return convention -- ports express this as
 * a plain `if (!cond) return` rather than a macro, since JS has no early-return
 * statement expression; documented here so ports can cite the pattern by name. */
