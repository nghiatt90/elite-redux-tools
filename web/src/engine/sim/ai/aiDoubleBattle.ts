// AI_DoubleBattle, battle_ai_main.c:2213-2511 -- complete: the partner-target
// attack-effect switch landed in dbl-4b3 (cycle 3d3s) on top of the dbl-4b
// cycle 3d3q and dbl-4b2 cycle 3d3r ports, plus GetAllyChosenMove
// (battle_ai_util.c:2277-2287).
// Ported: the prologue (:2214-2233), the partner-move-effect switch
// (:2236-2254), the own-effect-relative-to-partner switch (:2257-2272), the
// global-weather switch (:2274-2301), the partner-target DAMAGE GATE and
// 15-ability loop (:2303-2398, cycle 3d3r), the partner-target attack-effect
// switch (:2395-2482, cycle 3d3s) and the opponent branch (:2485-2510).
//
// `moveType` (`SetTypeBeforeUsingMove`/`GET_MOVE_TYPE`, :2227-2228) is read
// only inside the partner-target branch, so it is computed there rather than
// as a prologue local: no other branch has a reader for it.
// `partnerProtecting`, `atkPartnerHoldEffect` and the two ability-rating
// locals (:2220-2223) are likewise partner-branch-only and are computed
// inside it.
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
import { hasFlag, MAX_STAT_STAGE, STAT_ATK, STAT_SPATK, STAT_SPEED, STATUS1_ANY, STATUS2_ESCAPE_PREVENTION, STATUS2_WRAPPED, STATUS4_COMMANDED } from '../constants'
import { isBattlerGrounded } from '../grounding'
import { getWhoStrikesFirst } from '../turnOrder'
import { getBattlerBattleMoveTargetFlags } from '../moveTargetFlags'
import { aiHoldEffectParam, holdEffectId, type AiDamageDeps } from './aiCalcDamage'
import { aiGetMoveEffectiveness, canIndexMoveFaintTarget, getMoveDamageResult, isStatLoweringEffect, isTargetingPartner, MOVE_POWER_WEAK } from './aiScorers'
import { battlerAbility, battlerStatCanRise, canBeConfused, doesBattlerIgnoreAbilityChecks, getAllyChosenMove, hasMoveWithSplit, hasMoveWithType, isBattlerOfType, moveType as resolveMoveType } from './aiCheckBadMove'
import { defAbility, isSuppressed, selfAbility } from './aiAbilityHelpers'
import { getAbilityRating, isAbilityOfRating } from './aiAbilityRatings'
import { isBattlerAlive } from './aiPipeline'
import { AI_FLAG_HP_AWARE } from './aiFlags'
import { hasDamagingMove, hasMoveWithLowAccuracy, shouldSetFog, shouldSetHail, shouldSetRain, shouldSetSandstorm, shouldSetSun } from './aiCheckViability'

// Kept as this module's public name for existing callers (cycle3d3q's own test);
// the definition moved to aiCheckBadMove.ts to avoid a runtime import cycle.
export { getAllyChosenMove }

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
 * GetAllyChosenMove (battle_ai_util.c:2277-2287) now lives in aiCheckBadMove.ts:
 * this module imports aiCheckBadMove, so importing it back would close a
 * runtime cycle. The partner helpers that also read it are there too.
 */

/**
 * AI_DoubleBattle, battle_ai_main.c:2213-2511.
 * The same `Scorer` shape as the DISPATCH entries in aiPipeline.ts; `moveIndex`
 * is `AI_THINKING_STRUCT->movesetIndex` (the C's own function takes no slot
 * index, but its partner-branch `GetMoveDamageResult`/`CanIndexMoveFaintTarget`
 * calls read the global, so it is threaded in here).
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
  moveIndex: number,
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
    // :2303-2398 -- the partner-target damage gate and ability loop. The C's
    // prologue locals this reads: `moveType` (:2227-2228) and
    // `partnerProtecting` (:2221).
    const moveType = resolveMoveType(moveId, deps, unmodelled)
    const partnerProtecting = partnerMoveData?.effect === 'EFFECT_PROTECT'
    // :2220, :2222-2223 -- read only by the attack-effect switch below.
    const atkPartnerHoldEffect = aiHoldEffectParam(partner, deps)
    const attackerHasBadAbility = getAbilityRating(battlerAbility(attacker)) < 0
    const partnerHasBadAbility = getAbilityRating(partner.mon.abilities.ability) < 0
    const damageResult = getMoveDamageResult(state, battlerAtk, battlerDef, moveId, moveIndex, deps)
    unmodelled.push(...damageResult.unmodelled)
    if (damageResult.result === MOVE_POWER_WEAK) {
      // partner ability checks. `DoesBattlerIgnoreAbilityChecks(battlerAtk,
      // battlerDef, move)` passes the PARTNER as battlerDef.
      if (!partnerProtecting && move?.target !== 'BOTH' && !doesBattlerIgnoreAbilityChecks(state, battlerAtk, partnerId, deps)) {
        // GetNumPossibleAbilitiesForBattler: ability + innates. GetAbilityAtIndex
        // (pokemon.c:6414) is a raw slot read returning ABILITY_NONE while
        // IsSuppressed holds (checkMoldBreaker TRUE), so a suppressed slot is
        // skipped here rather than matching ABILITY_NONE (which has no case).
        const partnerAbilitySlots = [partner.mon.abilities.ability, ...partner.mon.abilities.innates].filter((id): id is string => !!id)
        for (const abilityId of partnerAbilitySlots) {
          if (isSuppressed(state, partner, abilityId, true, deps.grounding.attackerHasMoldBreaker, deps)) continue
          switch (abilityId) {
            case 'ABILITY_VOLT_ABSORB':
            case 'ABILITY_EARTH_EATER':
              if (!hasFlag(state.aiFlags, AI_FLAG_HP_AWARE)) {
                return { score: score - 10, unmodelled } // RETURN_SCORE_MINUS(10)
              }
              break // handled in AI_HPAware
            case 'ABILITY_MOTOR_DRIVE':
              if (moveType === 'ELECTRIC' && battlerStatCanRise(state, partner, STAT_SPEED, deps)) {
                return { score: score + 1, unmodelled }
              }
              break
            case 'ABILITY_LIGHTNING_ROD':
              if (moveType === 'ELECTRIC' && hasMoveWithSplit(partner, 'SPECIAL', deps) && battlerStatCanRise(state, partner, STAT_SPATK, deps)) {
                return { score: score + 1, unmodelled }
              }
              break
            case 'ABILITY_WATER_ABSORB':
            case 'ABILITY_DRY_SKIN':
              if (!hasFlag(state.aiFlags, AI_FLAG_HP_AWARE)) {
                return { score: score - 10, unmodelled } // RETURN_SCORE_MINUS(10)
              }
              break // handled in AI_HPAware
            case 'ABILITY_RESERVOIR':
            case 'ABILITY_STORM_DRAIN':
              if (moveType === 'WATER' && hasMoveWithSplit(partner, 'SPECIAL', deps) && battlerStatCanRise(state, partner, STAT_SPATK, deps)) {
                return { score: score + 1, unmodelled }
              }
              break
            case 'ABILITY_WATER_COMPACTION': {
              // `if (moveType == TYPE_WATER && GetMoveDamageResult(move) == MOVE_POWER_WEAK)`
              // -- the damage call is short-circuited behind the type check.
              if (moveType === 'WATER') {
                const compactionDamage = getMoveDamageResult(state, battlerAtk, battlerDef, moveId, moveIndex, deps)
                unmodelled.push(...compactionDamage.unmodelled)
                if (compactionDamage.result === MOVE_POWER_WEAK) {
                  return { score: score + 1, unmodelled } // only mon with this ability is weak to water so only make it okay if we do very little damage
                }
              }
              // the C's RETURN_SCORE_MINUS(10) sits OUTSIDE the if, so it is
              // reached whenever the +1 above is not.
              return { score: score - 10, unmodelled }
            }
            case 'ABILITY_FLASH_FIRE':
              if (
                moveType === 'FIRE' &&
                hasMoveWithType(partner, 'FIRE', deps) &&
                !partner.volatiles.flashFire &&
                aiHoldEffectParam(partner, deps) !== holdEffectId('HOLD_EFFECT_MEGA_STONE', deps) // Don't use fire move on ally's pre-mega Houndoom
              ) {
                return { score: score + 1, unmodelled }
              }
              break
            case 'ABILITY_SAP_SIPPER':
              if (moveType === 'GRASS' && hasMoveWithSplit(partner, 'PHYSICAL', deps) && battlerStatCanRise(state, partner, STAT_ATK, deps)) {
                return { score: score + 1, unmodelled }
              }
              break
            case 'ABILITY_JUSTIFIED': {
              if (!(moveType === 'DARK' && !isMoveStatus(move) && hasMoveWithSplit(partner, 'PHYSICAL', deps) && battlerStatCanRise(state, partner, STAT_ATK, deps))) break
              const faintCheck = canIndexMoveFaintTarget(state, battlerAtk, partnerId, moveId, 1, deps)
              unmodelled.push(...faintCheck.unmodelled)
              if (!faintCheck.faints) return { score: score + 1, unmodelled }
              break
            }
            case 'ABILITY_RATTLED': {
              if (!(!isMoveStatus(move) && (moveType === 'DARK' || moveType === 'GHOST' || moveType === 'BUG') && battlerStatCanRise(state, partner, STAT_SPEED, deps))) break
              const faintCheck = canIndexMoveFaintTarget(state, battlerAtk, partnerId, moveId, 1, deps)
              unmodelled.push(...faintCheck.unmodelled)
              if (!faintCheck.faints) return { score: score + 1, unmodelled }
              break
            }
            case 'ABILITY_CONTRARY':
              if (isStatLoweringEffect(effect)) return { score: score + 2, unmodelled }
              break
            case 'ABILITY_CONTEMPT':
            case 'ABILITY_DEFIANT':
              if (isStatLoweringEffect(effect) && battlerStatCanRise(state, partner, STAT_ATK, deps)) {
                return { score: score + 1, unmodelled }
              }
              break
            case 'ABILITY_COMPETITIVE':
              if (isStatLoweringEffect(effect) && battlerStatCanRise(state, partner, STAT_SPATK, deps)) {
                return { score: score + 1, unmodelled }
              }
              break
          }
        }
      } // ability checks
    } // move power check

    // :2395-2482 -- attacker move effects specifically targeting partner.
    // Each RETURN_SCORE_PLUS(n) exits with `score + n`; a `break` (or a case
    // that matches nothing) falls through to :2484's `score -= 30`.
    if (!partnerProtecting) {
      switch (effect) {
        case 'EFFECT_PURIFY': // :2398-2402
          if (partner.mon.status1 & STATUS1_ANY) {
            return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
          }
          break
        case 'EFFECT_SWAGGER': // :2403-2409
          if (
            partner.mon.statStages[STAT_ATK] < MAX_STAT_STAGE &&
            hasMoveWithSplit(partner, 'PHYSICAL', deps) &&
            (!canBeConfused(partner, unmodelled) ||
              atkPartnerHoldEffect === holdEffectId('HOLD_EFFECT_CURE_CONFUSION', deps) ||
              atkPartnerHoldEffect === holdEffectId('HOLD_EFFECT_CURE_STATUS', deps))
          ) {
            return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
          }
          break
        case 'EFFECT_FLATTER': // :2410-2416
          if (
            partner.mon.statStages[STAT_SPATK] < MAX_STAT_STAGE &&
            hasMoveWithSplit(partner, 'SPECIAL', deps) &&
            (!canBeConfused(partner, unmodelled) ||
              atkPartnerHoldEffect === holdEffectId('HOLD_EFFECT_CURE_CONFUSION', deps) ||
              atkPartnerHoldEffect === holdEffectId('HOLD_EFFECT_CURE_STATUS', deps))
          ) {
            return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
          }
          break
        case 'EFFECT_BEAT_UP': // :2417-2424
          // The C's `&&` chain short-circuits before the faint check, which is
          // the last operand.
          if (
            defAbility(state, deps, partner, 'ABILITY_JUSTIFIED', deps.grounding.attackerHasMoldBreaker) &&
            moveType === 'DARK' &&
            !isMoveStatus(move) &&
            hasMoveWithSplit(partner, 'PHYSICAL', deps) &&
            battlerStatCanRise(state, partner, STAT_ATK, deps)
          ) {
            const faintCheck = canIndexMoveFaintTarget(state, battlerAtk, partnerId, moveId, 0, deps)
            unmodelled.push(...faintCheck.unmodelled)
            if (!faintCheck.faints) {
              return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
            }
          }
          break
        case 'EFFECT_SKILL_SWAP': { // :2425-2436
          const attackerAbility = battlerAbility(attacker)
          // GetBattlerAbility(battlerAtk) vs the partner's raw `abilities[0]`.
          if (attackerAbility !== partner.mon.abilities.ability && !attackerHasBadAbility) {
            if (partner.mon.abilities.ability !== 'ABILITY_TRUANT') {
              return { score: score + 10, unmodelled } // RETURN_SCORE_PLUS(10)
            } else if (attackerAbility === 'ABILITY_COMPOUND_EYES' && hasMoveWithLowAccuracy(partner, 90, true, deps, unmodelled)) {
              // The C also passes the partner's foe and both hold effects; they
              // feed only AI_GetMoveAccuracy, which hasMoveWithLowAccuracy
              // documents as approximated by the move's declared accuracy.
              return { score: score + 3, unmodelled } // RETURN_SCORE_PLUS(3)
            }
          }
          break
        }
        case 'EFFECT_ROLE_PLAY': // :2437-2440
          if (attackerHasBadAbility && !partnerHasBadAbility) {
            return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
          }
          break
        case 'EFFECT_WORRY_SEED': // :2441-2446
        case 'EFFECT_GASTRO_ACID':
        case 'EFFECT_SIMPLE_BEAM':
          if (partnerHasBadAbility) {
            return { score: score + 2, unmodelled } // RETURN_SCORE_PLUS(2)
          }
          break
        case 'EFFECT_ENTRAINMENT': // :2447-2450
          if (partnerHasBadAbility && isAbilityOfRating(battlerAbility(attacker), 0)) {
            return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
          }
          break
        case 'EFFECT_SOAK': // :2451-2457
          // The `||` chain is transcribed as written: it is true for every mon
          // that is not Water/Water/Water.
          if (
            defAbility(state, deps, partner, 'ABILITY_WONDER_GUARD', deps.grounding.attackerHasMoldBreaker) &&
            (partner.mon.types[0] !== 'WATER' || partner.mon.types[1] !== 'WATER' || partner.mon.types[2] !== 'WATER')
          ) {
            return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
          }
          break
        case 'EFFECT_INSTRUCT': { // :2458-2468
          const instructedMove =
            getWhoStrikesFirst(state, battlerAtk, partnerId, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0
              ? partnerMove
              : partner.lastMove
          // `gBattleMoves[instructedMove].target & (BOTH | FOES_AND_ALLY)`
          // reads the move TABLE target, not the dynamic target flags.
          const instructedData = instructedMove === null ? undefined : deps.moveData(instructedMove)
          if (
            instructedMove !== null &&
            !isMoveStatus(instructedData) &&
            (instructedData?.target === 'BOTH' || instructedData?.target === 'FOES_AND_ALLY')
          ) {
            return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
          }
          break
        }
        case 'EFFECT_AFTER_YOU': { // :2469-2477
          // FOE(battler) = (battler ^ BIT_SIDE) & BIT_SIDE, battle_ai_util.h:10,
          // which is the opposite side of the battler (bit 0 flipped);
          // BATTLE_PARTNER(FOE) flips bit 1. The `||` short-circuits, so the
          // second tie-break draw only happens when the first comparison
          // returns 0.
          const foe = 1 - (partnerId & 1)
          if (
            getWhoStrikesFirst(state, partnerId, foe, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 1 ||
            getWhoStrikesFirst(state, partnerId, foe ^ 2, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 1
          ) {
            if (partnerMoveData?.effect === 'EFFECT_COUNTER' || partnerMoveData?.effect === 'EFFECT_MIRROR_COAT') {
              break // These moves need to go last
            }
            return { score: score + 1, unmodelled } // RETURN_SCORE_PLUS(1)
          }
          break
        }
      } // attacker move effects
    } // check partner protecting

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
