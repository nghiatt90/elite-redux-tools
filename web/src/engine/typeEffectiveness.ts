// Type effectiveness, ported from CalcTypeEffectivenessMultiplierInternal
// (src/battle_util.c:7942-8014) and MulByTypeEffectiveness (:7861-7913).
//
// ER defenders can carry up to THREE types (type1/type2/type3 -- e.g. Trick-or-Treat/
// Forest's Curse, or an innate tri-typing). The C computes each defending type's
// multiplier independently starting from UQ_4_12(1.0), then folds the (up to three)
// results into the running modifier with THREE SEPARATE MulModifier calls -- not one
// product of all multipliers. Because MulModifier re-quantizes at every call, this is
// observably different from `chart[a] * chart[b] * chart[c]` computed as one product
// in floating point, so the fold below mirrors the three-call structure exactly.

import { mulModifier, uq } from './fixed'

export type TypeChart = Record<string, Record<string, number>> // chart[attackingType][defendingType] = multiplier (0, 0.25, 0.5, 1, 2, or 4)

/**
 * One defending type's multiplier against one attacking type, as a UQ_4_12 value --
 * MulByTypeEffectiveness's base-chart lookup (:7869), before any ability/item/Ring
 * Target/Foresight override (none of which this function models; see calculate.ts
 * for where those hooks belong once the ability registry exists).
 */
export function baseTypeEffectiveness(attackingType: string, defendingType: string, chart: TypeChart): number {
  const multiplier = chart[attackingType]?.[defendingType]
  return uq(multiplier ?? 1)
}

/**
 * CalcTypeEffectivenessMultiplierInternal's three-type fold (:7947-7957). `defenderTypes`
 * should already be deduplicated by the caller in the C's own order (type1, then type2
 * if distinct, then type3 if distinct from both and not "no third type") -- this
 * function folds however many distinct types (1-3) it's given, in the order given.
 *
 * `isGrounded` mirrors `IsBattlerGroundedIgnoreType(battlerDef)` (:7973): a Ground-type
 * move against a non-grounded defender (pure Flying, Levitate, Air Balloon, ...) is a
 * flat immunity applied AFTER the type-chart fold, overriding whatever the chart said
 * (e.g. Ground vs Ground/Flying still misses). Thousand Arrows-style
 * "ignoresLevitation" moves are not modelled by this function -- that flag restores
 * the immunity to neutral and belongs in the caller alongside the rest of move-flag
 * handling.
 */
export function calcTypeEffectiveness(
  attackingType: string,
  defenderTypes: string[],
  chart: TypeChart,
  isGrounded = true,
): number {
  let modifier = uq(1.0)
  for (const defendingType of defenderTypes) {
    modifier = mulModifier(modifier, baseTypeEffectiveness(attackingType, defendingType, chart))
  }
  if (modifier !== 0 && attackingType === 'GROUND' && !isGrounded) {
    modifier = 0
  }
  return modifier
}

/**
 * Dedupes a defender's 1-3 types into the fold order CalcTypeEffectivenessMultiplierInternal
 * uses: type1 always; type2 only if it differs from type1; type3 only if it's not
 * "no third type" and differs from both type1 and type2. `noneType` is the bare
 * sentinel ("MYSTERY" in this pipeline's emitted chart, matching TYPE_MYSTERY) used
 * when a species has fewer than 3 types.
 */
export function distinctDefendingTypes(types: string[], noneType = 'MYSTERY'): string[] {
  const [type1, type2, type3] = types
  const out = [type1]
  if (type2 && type2 !== type1) out.push(type2)
  if (type3 && type3 !== noneType && type3 !== type1 && type3 !== type2) out.push(type3)
  return out
}
