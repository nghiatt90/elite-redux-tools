// Multi-hit resolution: GetMultihitType/GetParentalBondType/GetParentalBondCount
// (src/battle_script_commands.c:958-1064) collapsed into one function, since the
// C's own control flow makes them mutually exclusive -- CANCELLER_MULTIHIT_MOVES
// (a move's OWN multi-hit effect) always runs first and sets multiHitCounter;
// GetParentalBondType's caller only even checks Parental Bond `if
// (!multiHitCounter)` (battle_script_commands.c:1086), so a move that's already
// multi-hit by its own effect can never ALSO get a Parental Bond bonus hit.
//
// Every hit of a move's own multi-hit effect (Double Hit, Population Bomb, the
// Skill-Link/Loaded-Dice-boosted forms of EFFECT_MULTI_HIT) deals FULL,
// unscaled power via THIS module's hitModifier -- confirmed against
// CalcMoveBasePower's own switch (battle_util.c:6825-6907), which has no case
// for these effects at all. Only a Parental-Bond-family bonus hit (index >= 1)
// uses anything other than 1.0 here. Triple Kick/Triple Axel (MULTIHIT_TRIPLE_KICK)
// scale power too, but NOT via hitModifier -- their scaling happens at
// CalcMoveBasePower's own pipeline stage (basePower.ts's applyPreModifierBasePower,
// keyed on hitIndex), which calculate.ts's per-hit loop threads separately from
// the hitModifier this module returns; see that function's own doc for why the
// two stages can't share one mechanism and stay bit-exact.
//
// MULTIHIT_BEAT_UP (party-based hit count) IS resolved here now, via its own
// beatUpHitCount scenario toggle -- see that function's own doc.

import { uq } from './fixed'
import { computeParentalBondTrigger, getParentalBondMultiplier } from './abilities/dispatchCalc'
import type { AbilitySlots } from './abilities/dispatch'
import type { OnParentalBondContext, ParentalBondTrigger } from './abilities/types'

export interface HitPlan {
  hitCount: number
  /** UQ_4_12 -- the modifier for the (0-indexed) hit, folded into CalcFinalDmg's
   * own parentalBondMultiplier stage regardless of which mechanism produced it. */
  hitModifier: (hitIndex: number) => number
}

export type HitPlanResult = HitPlan | { unmodelled: string } | null

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * GetParentalBondCount, src/battle_script_commands.c:1010-1044. MINION_CONTROL's
 * own count is a live count of the attacker's non-fainted, non-egg, non-status
 * party members -- this v1 singles engine has no party/team concept (same class
 * of gap as Soul Harvest/Supreme Overlord before alliesFainted existed), so it's
 * surfaced as unmodelled rather than guessed. TWO_TO_FIVE (Unrelenting,
 * src/abilities.cc:12247-12249's onParentalBond) has NO case in that switch --
 * only PARENTAL_BOND_HYPER_AGGRESSIVE/PRIMAL_MAW/DUAL_WIELD/ICE_COLD_HUNTER/
 * THREE_HEADED/MINION_CONTROL are handled (include/abilities.hh:36-54's
 * PARENTAL_BOND_* values), so it falls through to the switch's own `return 1`,
 * and Cmd_attackcanceler's `i > 1` gate (:1082-1090) then never sets
 * multiHitCounter/parentalBondOn at all -- Unrelenting never actually grants a
 * bonus hit in the real game.
 */
function parentalBondHitCount(trigger: ParentalBondTrigger): { hitCount: number } | { unmodelled: string } {
  switch (trigger) {
    case 'HYPER_AGGRESSIVE':
    case 'PRIMAL_MAW':
    case 'DUAL_WIELD':
    case 'ICE_COLD_HUNTER':
      return { hitCount: 2 }
    case 'THREE_HEADED':
      return { hitCount: 3 }
    case 'TWO_TO_FIVE':
      return { hitCount: 1 }
    case 'MINION_CONTROL':
      return { unmodelled: 'Minion Control: party-based hit count not modelled (no team concept in this engine)' }
  }
}

export interface MultiHitMoveData {
  effect: string | null
  multiHitArgument: number | null
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS' | null
  flags: Record<string, true>
}

export function resolveHitPlan(
  move: MultiHitMoveData,
  attackerSlots: AbilitySlots,
  defenderSlots: AbilitySlots,
  attackerHasSkillLink: boolean,
  attackerResolvedHoldEffect: string | null,
  scenarioHitCount: number,
  parentalBondCtx: OnParentalBondContext,
  scenarioBeatUpHitCount: number,
): HitPlanResult {
  // A move's own multi-hit effect (CANCELLER_MULTIHIT_MOVES, battle_util.c:3496-3542).
  if (move.effect === 'EFFECT_DOUBLE_HIT') {
    return { hitCount: move.multiHitArgument === 3 ? 3 : 2, hitModifier: () => uq(1.0) }
  }
  if (move.effect === 'EFFECT_TEN_HITS') {
    return { hitCount: 10, hitModifier: () => uq(1.0) }
  }
  if (move.effect === 'EFFECT_MULTI_HIT') {
    if (attackerHasSkillLink) return { hitCount: 5, hitModifier: () => uq(1.0) }
    const usesLoadedDice = attackerResolvedHoldEffect === 'HOLD_EFFECT_LOADED_DICE'
    const [min, max] = usesLoadedDice ? [4, 5] : [2, 5]
    return { hitCount: clamp(scenarioHitCount, min, max), hitModifier: () => uq(1.0) }
  }
  // MULTIHIT_TRIPLE_KICK (Triple Kick/Triple Axel share EFFECT_TRIPLE_KICK) --
  // always exactly 3 hits, fixed (battle_util.c:3506-3509, no Skill Link/Loaded
  // Dice interaction: those only ever apply to MULTIHIT_TWO_TO_FIVE-family moves).
  // hitModifier stays uq(1.0) for every hit -- the power scaling isn't a
  // final-stage multiplier, it happens earlier via basePower.ts's own hitIndex
  // parameter (applyPreModifierBasePower's EFFECT_TRIPLE_KICK case), matching the
  // C's own pipeline stage (CalcMoveBasePower, not CalcFinalDmg).
  if (move.effect === 'EFFECT_TRIPLE_KICK') {
    return { hitCount: 3, hitModifier: () => uq(1.0) }
  }
  // MULTIHIT_BEAT_UP -- a live count of the attacker's non-fainted, non-egg,
  // non-status party members (battle_script_commands.c:1023-1038), exposed
  // directly as its own scenario toggle (beatUpHitCount) since there's no party
  // roster to derive it from -- same shape as Triple Kick's own hitModifier
  // (power scaling happens via basePower.ts's EFFECT_BEAT_UP case, not here).
  if (move.effect === 'EFFECT_BEAT_UP') {
    return { hitCount: clamp(scenarioBeatUpHitCount, 1, 6), hitModifier: () => uq(1.0) }
  }

  // Parental Bond family (IsMoveAffectedByParentalBond + GetParentalBondType/Count,
  // battle_script_commands.c:992-1004,1011-1040,13190+) -- only the two cheap,
  // already-available exclusion checks are ported (status moves, and the move's
  // own noParentalBond flag); the doubles-only and two-turn-move exclusions don't
  // apply to this v1 singles, non-charge-turn engine.
  if (move.split === 'STATUS' || move.flags.noParentalBond) return null
  const trigger = computeParentalBondTrigger(attackerSlots, defenderSlots, parentalBondCtx)
  if (!trigger) return null
  const countResult = parentalBondHitCount(trigger)
  if ('unmodelled' in countResult) return countResult
  if (countResult.hitCount <= 1) return null
  return {
    hitCount: countResult.hitCount,
    hitModifier: (hitIndex) => (hitIndex === 0 ? uq(1.0) : getParentalBondMultiplier(trigger, hitIndex)),
  }
}
