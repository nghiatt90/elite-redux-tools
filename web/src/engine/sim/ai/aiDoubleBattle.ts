// AI_DoubleBattle, battle_ai_main.c:2213-2511 -- the NON-PARTNER-TARGET halves
// (dbl-4b, cycle 3d3q), plus GetAllyChosenMove (battle_ai_util.c:2277-2287).
// Ported: the prologue (:2214-2233, minus the two ability-rating locals only the
// partner branch reads), the partner-move-effect switch (:2236-2254), the
// own-effect-relative-to-partner switch (:2257-2272), the global-weather switch
// (:2274-2301) and the opponent branch (:2485-2510).
//
// Not ported (dbl-4b2): the body of the `if (IsTargetingPartner(...))` branch,
// battle_ai_main.c:2303-2483 -- the 15-ability partner loop and the
// EFFECT_PURIFY..EFFECT_AFTER_YOU switch. The branch's tail
// (`score -= 30`, :2484) IS ported, preceded by a named gap line; dbl-4b2
// replaces that line.
//
// `moveType` (`SetTypeBeforeUsingMove`/`GET_MOVE_TYPE`, :2229-2230) is read
// only inside the unported branch, so it is not computed here: this slice has
// no reader for it and a dead local would only be noise. `partnerProtecting`,
// `atkPartnerHoldEffect`, `attackerHasBadAbility` and `partnerHasBadAbility`
// (:2219-2222) are likewise partner-branch-only and stay for dbl-4b2.
//
// `AI_DATA->partnerMove` is `getAllyChosenMove` below; the C fills it in
// ChooseMoveOrAction_Doubles (:368), which this sim's chooser still does not do
// (dbl-4b wires it). Reading it from `state.chosenMovePositions` here is the
// same value the C's AI_DATA copy would hold, so the scorer is self-contained.
//
// GetMovesArray (battle_ai_util.c:1349-1357) is not ported anywhere: every
// trainer carries AI_FLAG_CHECK_FOE, which makes it return
// `gBattleMons[battler].moves` unconditionally on this build (aiScorers.ts's
// own canTargetFaintAi doc), so the helpers below scan the real moveset.

import type { BattleState, BattlerState } from '../state'
import type { MoveData } from '../../calculate'
import { hasFlag, STATUS2_ESCAPE_PREVENTION, STATUS2_WRAPPED, STATUS4_COMMANDED } from '../constants'
import { isBattlerGrounded } from '../grounding'
import { getWhoStrikesFirst } from '../turnOrder'
import { getBattlerBattleMoveTargetFlags } from '../moveTargetFlags'
import { isBattlerAIControlled, type AiDamageDeps } from './aiCalcDamage'
import { aiGetMoveEffectiveness, isTargetingPartner } from './aiScorers'
import { battlerAbility, isBattlerOfType } from './aiCheckBadMove'
import { selfAbility } from './aiAbilityHelpers'
import { isAbilityOfRating } from './aiAbilityRatings'
import { isBattlerAlive } from './aiPipeline'
import { hasDamagingMove, shouldSetFog, shouldSetHail, shouldSetRain, shouldSetSandstorm, shouldSetSun } from './aiCheckViability'

/** AI_EFFECTIVENESS_x0, constants/battle_ai.h:18. */
const AI_EFFECTIVENESS_x0 = 0

/** BATTLE_PARTNER, constants/battle.h:37 (`battler ^ 2`). */
function battlePartner(battlerId: number): number {
  return battlerId ^ 2
}

/** `IS_MOVE_STATUS(move)`, include/battle.h:745 (`split == SPLIT_STATUS`). */
function isMoveStatus(move: MoveData | undefined): boolean {
  return move?.split === 'STATUS'
}

/** `HasMove(battler, move)`, battle_ai_util.c:1416-1425. */
function hasMove(battler: BattlerState | undefined, moveId: string): boolean {
  return !!battler && battler.mon.moves.includes(moveId)
}

/** IsTrappingMoveEffect, battle_ai_util.c:1501-1513. EFFECT_NO_RETREAT is
 * commented out in the C and stays out here. */
const TRAPPING_MOVE_EFFECTS = new Set([
  'EFFECT_MEAN_LOOK', 'EFFECT_TRAP', 'EFFECT_WHIRLPOOL', 'EFFECT_HIT_PREVENT_ESCAPE', 'EFFECT_FAIRY_LOCK',
])
function isTrappingMoveEffect(effect: string | null): boolean {
  return effect !== null && TRAPPING_MOVE_EFFECTS.has(effect)
}

/** `HasTrappingMoveEffect(battler)`, battle_ai_util.c:1515-1522. */
function hasTrappingMoveEffect(battler: BattlerState | undefined, deps: AiDamageDeps): boolean {
  if (!battler) return false
  return battler.mon.moves.some((m) => !!m && isTrappingMoveEffect(deps.moveData(m)?.effect ?? null))
}

/** IsAttackBoostMoveEffect, battle_ai_util.c:1547-1560. */
const ATTACK_BOOST_EFFECTS = new Set([
  'EFFECT_ATTACK_UP', 'EFFECT_ATTACK_UP_2', 'EFFECT_ATTACK_ACCURACY_UP', 'EFFECT_ATTACK_SPATK_UP',
  'EFFECT_DRAGON_DANCE', 'EFFECT_COIL', 'EFFECT_BELLY_DRUM', 'EFFECT_BULK_UP', 'EFFECT_GROWTH',
])
function isAttackBoostMoveEffect(effect: string | null): boolean {
  return effect !== null && ATTACK_BOOST_EFFECTS.has(effect)
}

/** IsUngroundingEffect, battle_ai_util.c:1537-1544 -- EFFECT_MAGNET_RISE only. */
function isUngroundingEffect(effect: string | null): boolean {
  return effect === 'EFFECT_MAGNET_RISE'
}

/**
 * GetAllyChosenMove, battle_ai_util.c:2277-2287 -- the AI's partner's chosen
 * move, or MOVE_NONE (`null`). `sBattler_AI` is the caller's own `battlerAtk`.
 *
 * The `partnerBattler > sBattler_AI` guard is the "lower id chooses first"
 * rule: the AI only knows its ally's pick when the ally is the earlier battler.
 * `IsBattlerAIControlled` is aiCalcDamage.ts's port of the same C function; on
 * this build it is "opponent side" (`(id & 1) === B_SIDE_OPPONENT`), so a
 * player-side partner reads as not AI-controlled.
 *
 * `gBattleStruct->chosenMovePositions[partner]` is `state.chosenMovePositions`;
 * the stored value is a move SLOT index, and the array access it feeds
 * (`gBattleMons[partner].moves[slot]`) yields MOVE_NONE for an empty slot,
 * which is the sim's `null`.
 */
export function getAllyChosenMove(state: BattleState, battlerAtk: number): string | null {
  const partner = battlePartner(battlerAtk)
  if (!isBattlerAlive(state, partner) || !isBattlerAIControlled(partner)) return null
  else if (partner > battlerAtk) return null // Battler with the lower id chooses the move first.
  const chosenMove = state.chosenMovePositions[partner]
  return state.battlers[partner]?.mon.moves[chosenMove] ?? null
}

/**
 * AI_DoubleBattle, battle_ai_main.c:2213-2511, minus :2303-2483 (dbl-4b2).
 * The same `Scorer` shape as the DISPATCH entries in aiPipeline.ts; `moveIndex`
 * is unused because the C's own AI_DoubleBattle takes no slot index (its
 * partner-branch calls name `AI_THINKING_STRUCT->movesetIndex`, which dbl-4b2
 * will need).
 *
 * `effect` is the scored move's own effect. MOVE_NONE's effect is 0 in the C
 * (EFFECT_HIT), matching "no case label matches"; here an absent move data
 * reads as `null`, which likewise matches no case.
 */
export function aiDoubleBattle(
  state: BattleState,
  battlerAtk: number,
  battlerDef: number,
  moveId: string,
  _moveIndex: number,
  score: number,
  deps: AiDamageDeps,
): { score: number; unmodelled: string[] } {
  const unmodelled: string[] = []
  const attacker = state.battlers[battlerAtk]
  if (!attacker) return { score, unmodelled }

  const move = deps.moveData(moveId)
  const effect = move?.effect ?? null
  const partnerId = battlePartner(battlerAtk)
  const partner = state.battlers[partnerId]
  // Doubles-only scorer: BATTLE_PARTNER always names a real slot on the wired
  // path (DISPATCH bit 7 is only dispatched from ChooseMoveOrAction_Doubles).
  // Guarding keeps a direct call on a singles 2-slot state from reading
  // `undefined` where the C would read gBattleMons[3]'s zeroed struct.
  if (!partner) return { score, unmodelled }
  const partnerMove = getAllyChosenMove(state, battlerAtk)
  const partnerMoveData = partnerMove === null ? undefined : deps.moveData(partnerMove)
  const predictedMove = state.battlers[battlerDef]?.lastMove ?? null

  // check what effect partner is using, :2236-2254
  if (partnerMove !== null) {
    switch (partnerMoveData?.effect ?? null) {
      case 'EFFECT_HELPING_HAND':
        if (isMoveStatus(move)) score += 5
        break
      case 'EFFECT_PERISH_SONG': {
        const defender = state.battlers[battlerDef]
        if (
          !hasFlag(defender?.mon.status2 ?? 0, STATUS2_ESCAPE_PREVENTION | STATUS2_WRAPPED) &&
          !hasFlag(defender?.statuses4 ?? 0, STATUS4_COMMANDED)
        ) {
          if (isTrappingMoveEffect(effect) || predictedMove === 'MOVE_INGRAIN') score++
        }
        break
      }
      case 'EFFECT_ALWAYS_CRIT':
        // Ally decided to use Frost Breath on us. we must have Anger Point as our ability
        if (selfAbility(state, deps, attacker, 'ABILITY_ANGER_POINT')) {
          // partner moving first
          if (getWhoStrikesFirst(state, battlerAtk, partnerId, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 1) {
            // discourage raising our attack since it's about to be maxed out
            if (isAttackBoostMoveEffect(effect)) score -= 3
            // encourage moves hitting multiple opponents
            if (!isMoveStatus(move)) {
              const statusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }
              const targetFlag = getBattlerBattleMoveTargetFlags(state, battlerAtk, moveId, deps.dataContext.move(moveId), deps, statusDeps)
              if (targetFlag === 'BOTH' || targetFlag === 'FOES_AND_ALLY') score += 3
            }
          }
        }
        break
    }
  } // check partner move effect

  // consider our move effect relative to partner state, :2257-2272
  switch (effect) {
    case 'EFFECT_HELPING_HAND':
      if (partnerMove !== null && !hasDamagingMove(partner, deps)) score -= 5
      break
    case 'EFFECT_PERISH_SONG':
      if (partnerMove !== null && hasTrappingMoveEffect(partner, deps)) score++
      break
    case 'EFFECT_MAGNET_RISE':
      if (
        isBattlerGrounded(state, battlerAtk, deps.grounding) &&
        (hasMove(partner, 'MOVE_EARTHQUAKE') || hasMove(partner, 'MOVE_MAGNITUDE'))
      ) {
        // Doesn't resist ground move
        const effectiveness = aiGetMoveEffectiveness(state, 'MOVE_EARTHQUAKE', battlerAtk, partnerId, deps)
        unmodelled.push(...effectiveness.unmodelled)
        if (effectiveness.effectiveness !== AI_EFFECTIVENESS_x0) {
          return { score: score + 2, unmodelled } // RETURN_SCORE_PLUS(2)
        }
      }
      break
  } // our effect relative to partner

  // consider global move effects, :2274-2301 -- each is RETURN_SCORE_PLUS, so
  // the first matching weather ends scoring. Only HAIL has the alive check.
  switch (effect) {
    case 'EFFECT_SANDSTORM':
      if (shouldSetSandstorm(state, partnerId, deps)) return { score: score + 1, unmodelled }
      break
    case 'EFFECT_RAIN_DANCE':
      if (shouldSetRain(state, partnerId, deps)) return { score: score + 1, unmodelled }
      break
    case 'EFFECT_SUNNY_DAY':
      if (shouldSetSun(state, partnerId, deps)) return { score: score + 1, unmodelled }
      break
    case 'EFFECT_EERIE_FOG':
      if (shouldSetFog(state, partnerId, deps)) return { score: score + 1, unmodelled }
      break
    case 'EFFECT_HAIL':
      if (isBattlerAlive(state, partnerId) && shouldSetHail(state, partnerId, deps)) return { score: score + 2, unmodelled }
      break
  } // global move effect check

  // check specific target, :2303-2510
  if (isTargetingPartner(battlerAtk, battlerDef)) {
    unmodelled.push('AI_DoubleBattle: partner-target branch (battle_ai_main.c:2303-2483) not ported')
    score -= 30 // otherwise, don't target partner
  } else {
    // checking opponent, :2485-2510 -- these checks mostly handled in
    // AI_CheckBadMove and AI_CheckViability.
    switch (effect) {
      case 'EFFECT_SKILL_SWAP': {
        const attackerAbility = battlerAbility(attacker)
        if (attackerAbility === 'ABILITY_TRUANT') score += 5
        else {
          // GetBattlerAbility is a raw `abilities[0]` slot read
          // (battle_util.c:9327), so no suppression applies to either side.
          const defender = state.battlers[battlerDef]
          const defenderAbility = defender ? battlerAbility(defender) : 'ABILITY_NONE'
          // we want to transfer our bad ability or take their awesome ability
          if (isAbilityOfRating(attackerAbility, 0) || isAbilityOfRating(defenderAbility, 10)) score += 2
        }
        break
      }
      case 'EFFECT_EARTHQUAKE':
      case 'EFFECT_MAGNITUDE':
        if (
          !isBattlerGrounded(state, partnerId, deps.grounding) ||
          (getWhoStrikesFirst(state, battlerAtk, partnerId, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 1 &&
            isUngroundingEffect(partnerMoveData?.effect ?? null))
        ) {
          score += 2
        } else if (
          isBattlerOfType(partner, 'FIRE') ||
          isBattlerOfType(partner, 'ELECTRIC') ||
          isBattlerOfType(partner, 'POISON') ||
          isBattlerOfType(partner, 'ROCK')
        ) {
          score -= 10 // partner will be hit by earthquake and is weak to it
        } else {
          score -= 3
        }
        break
    }

    // lightning rod, flash fire against enemy handled in AI_CheckBadMove
  }

  return { score, unmodelled }
}
