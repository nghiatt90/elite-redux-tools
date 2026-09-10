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
 * "ignoresLevitation" moves are ported, but not by this function -- that flag
 * restores the WHOLE modifier to neutral (battle_util.c:7981-7984) and lives in
 * calculate.ts's resolveTypeEffectiveness alongside the rest of move-flag
 * handling, same as this doc always said it should. (Separately, forced
 * grounding -- Iron Ball/Gravity -- restores just the Flying-vs-Ground
 * PER-COMPONENT value even without that move flag; see
 * dispatchCalc.ts's resolveTypeEffectivenessComponent.)
 *
 * `ringTargetHeld` mirrors MulByTypeEffectiveness's own Ring Target check
 * (:7881-7884): PER-DEFENDING-TYPE, not on the final folded modifier -- a Ring
 * Target holder that's immune via only ONE of its (up to 3) types still keeps its
 * OTHER types' real (resisted/super-effective) multiplier, rather than the whole
 * hit going flatly neutral. The C only applies this when no ability's
 * onTypeEffectiveness hook already changed that component -- this engine doesn't
 * dispatch that hook here yet either (see calculate.ts's own module doc), so
 * there's no double-dip to guard against in practice.
 */
export function calcTypeEffectiveness(
  attackingType: string,
  defenderTypes: string[],
  chart: TypeChart,
  isGrounded = true,
  ringTargetHeld = false,
): number {
  let modifier = uq(1.0)
  for (const defendingType of defenderTypes) {
    let componentModifier = baseTypeEffectiveness(attackingType, defendingType, chart)
    if (componentModifier === 0 && ringTargetHeld) componentModifier = uq(1.0)
    modifier = mulModifier(modifier, componentModifier)
  }
  if (modifier !== 0 && attackingType === 'GROUND' && !isGrounded) {
    modifier = 0
  }
  return modifier
}

/**
 * GetTypeModifier's own toggle inputs (battle_util.c:8021-8038) -- which chart to
 * select and the one special-case override, all independent of any specific
 * (attackingType, defendingType) pair.
 */
export interface TypeModifierInputs {
  /** IsInverseRoomActive() -- the Inverse Room field effect (STATUS_FIELD_INVERSE_ROOM,
   * suppressed by ABILITY_CLUELESS). Collapses both causes into one caller-supplied
   * fact, same precedent as FieldBattleState.gravityActive (also Clueless-suppressible
   * in the C but not independently modelled there either). */
  isInverseRoomActive: boolean
  /** B_FLAG_INVERSE_BATTLE -- a whole-battle-format config flag, a SEPARATE toggle
   * from the Inverse Room field effect above (both XOR together, see getTypeModifier's
   * own doc). */
  isInverseBattleFlagSet: boolean
  /** gStatuses3[battlerAtk] & STATUS3_MIRACLE_EYED for the attacking battler. */
  attackerHasMiracleEye: boolean
  /** gStatuses3[battlerDef] & STATUS3_MIRACLE_EYED for the defending battler. */
  defenderHasMiracleEye: boolean
}

/**
 * GetTypeModifier, battle_util.c:8021-8038 -- selects the forward or inverse type
 * chart for ONE (attackingType, defendingType) pair, XORing "inverted" across THREE
 * independent sources (not an OR -- two active at once cancel out): the Inverse Room
 * field effect, Miracle Eye on EITHER battler, and the B_FLAG_INVERSE_BATTLE format
 * flag.
 *
 * Separately (:8035), Miracle Eye on EITHER battler -- regardless of whether the
 * three-way XOR above actually ended up inverted or not -- forces Dark-vs-Psychic
 * specifically to a flat 0. This is counterintuitive (Miracle Eye conventionally
 * REMOVES a target's immunities, and Dark is normally super-effective (2x) against
 * Psychic in both this chart and the inverse one's 0.5, never an immunity to begin
 * with), but it's exactly what the C does -- ported faithfully rather than "corrected"
 * to what Miracle Eye is supposed to do.
 */
export function getTypeModifier(attackingType: string, defendingType: string, chart: TypeChart, inverseChart: TypeChart, inputs: TypeModifierInputs): number {
  let inverted = inputs.isInverseRoomActive
  if (inputs.attackerHasMiracleEye) inverted = !inverted
  if (inputs.defenderHasMiracleEye) inverted = !inverted
  if (inputs.isInverseBattleFlagSet) inverted = !inverted

  let ret = baseTypeEffectiveness(attackingType, defendingType, inverted ? inverseChart : chart)

  if ((inputs.attackerHasMiracleEye || inputs.defenderHasMiracleEye) && attackingType === 'DARK' && defendingType === 'PSYCHIC') ret = 0

  return ret
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
