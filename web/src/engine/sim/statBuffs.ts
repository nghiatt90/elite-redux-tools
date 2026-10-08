// Port of ChangeStatBuffs, ChangeStatBuffsImplicit, and Cmd_statbuffchange
// (src/battle_script_commands.c:9709-9955 at the pinned SHA).
//
// Handles stat stage modifications (clamping to 0..12, Contrary, Simple, Subdue,
// drop-block abilities, Mist, Clear Amulet, Mirror Armor, Eject Pack, Defiant/Competitive).

import type { BattleState, BattlerState } from './state'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ACC,
  STAT_ATK,
  STAT_SPATK,
  STATUS1_BLEED,
  STATUS1_POISON_ANY,
  STATUS3_EMBARGO,
  STATUS3_GASTRO_ACID,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_ANY,
  hasFlag,
} from './constants'
import { battlerHasAbility } from '../abilities/dispatch'
import type { SimDataContext } from './dataContext'
import { MOLD_BREAKABLE_ABILITIES, UNSUPPRESSABLE_ABILITIES } from './ai/aiAbilityHelpers'
import { weatherHasEffect } from './fieldEndTurn'
import type { GroundingContext } from './grounding'

const MOLD_BREAKABLE_SET = new Set(MOLD_BREAKABLE_ABILITIES)
const UNSUPPRESSABLE_SET = new Set(UNSUPPRESSABLE_ABILITIES)

// Bit flags for statbuffchange and ChangeStatBuffs
// include/constants/battle_script_commands.h:313-316
export const STAT_BUFF_ALLOW_PTR = 1 << 0
export const STAT_BUFF_NOT_PROTECT_AFFECTED = 1 << 5
export const STAT_BUFF_UPDATE_MOVE_EFFECT = 1 << 6
export const STAT_BUFF_DONT_SET_BUFFERS = 1 << 7

// tools/codegen/src/er/defines/MoveEffectGenerator.kt:20-22
export const MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES = 1 << 13 // 0x2000
export const MOVE_EFFECT_AFFECTS_USER = 1 << 14 // 0x4000
export const MOVE_EFFECT_CERTAIN = 1 << 15 // 0x8000

// include/constants/battle_string_ids.h:1086-1098
export const B_MSG_ATTACKER_STAT_ROSE = 0
export const B_MSG_DEFENDER_STAT_ROSE = 1
export const B_MSG_STAT_WONT_INCREASE = 2

export const B_MSG_ATTACKER_STAT_FELL = 0
export const B_MSG_DEFENDER_STAT_FELL = 1
export const B_MSG_STAT_WONT_DECREASE = 2

/** IsBattlerAlive check, src/battle_util.c:6685-6694. Kept local to avoid circular import. */
function isAlive(state: BattleState, battlerId: number): boolean {
  if (battlerId >= state.battlersCount) return false
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (battler.mon.hp === 0) return false
  return !(state.absentBattlerFlags & (1 << battlerId))
}

/** Check if any alive battler on `side` holds `abilityId`. */
function isAbilityAliveOnSide(state: BattleState, side: number, abilityId: string): boolean {
  for (let id = 0; id < state.battlersCount; id++) {
    if ((id & 1) !== side) continue
    if (!isAlive(state, id)) continue
    const battler = state.battlers[id]
    if (battler && battlerHasAbility(battler.mon.abilities, abilityId, () => false)) return true
  }
  return false
}

/** BenefitsFromStatBuffs, src/battle_util.c:8988-8993. */
export function benefitsFromStatBuffs(state: BattleState, battlerId: number): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return true
  if (hasFlag(battler.mon.status1, STATUS1_BLEED)) return false
  if (isAbilityAliveOnSide(state, battlerId ^ 1, 'ABILITY_BLOOD_STAIN')) return false
  if (hasFlag(battler.mon.status1, STATUS1_POISON_ANY) && isAbilityAliveOnSide(state, battlerId ^ 1, 'ABILITY_HEMOLYSIS')) return false
  return true
}

/** Check if ability is suppressed under Neutralizing Gas / Gastro Acid or Mold Breaker. */
export function isSimAbilitySuppressed(
  state: BattleState,
  battler: BattlerState,
  abilityId: string,
  checkMoldBreaker: boolean,
  attackerId: number,
  attackerHasMoldBreaker: boolean,
  dataContext: SimDataContext,
): boolean {
  if (
    (checkMoldBreaker && battler.id !== attackerId && attackerHasMoldBreaker && MOLD_BREAKABLE_SET.has(abilityId)) ||
    ((state.field.timers.neutralizingGas || hasFlag(battler.statuses3, STATUS3_GASTRO_ACID)) && !UNSUPPRESSABLE_SET.has(abilityId))
  ) {
    const item = battler.mon.itemId ? dataContext.item(battler.mon.itemId) : undefined
    const hasShield = item?.resolvedHoldEffect === 'HOLD_EFFECT_ABILITY_SHIELD' && !hasFlag(battler.statuses3, STATUS3_EMBARGO)
    return !hasShield
  }
  return false
}

/** Sim-side BattlerHasAbility with full suppression check. */
export function battlerHasSimAbility(
  state: BattleState,
  battler: BattlerState,
  abilityId: string,
  checkMoldBreaker: boolean,
  attackerId: number,
  attackerHasMoldBreaker: boolean,
  dataContext: SimDataContext,
): boolean {
  return battlerHasAbility(battler.mon.abilities, abilityId, (id) =>
    isSimAbilitySuppressed(state, battler, id, checkMoldBreaker, attackerId, attackerHasMoldBreaker, dataContext),
  )
}

/** Check if attacker has Mold Breaker active. */
export function attackerHasMoldBreakerActive(
  attacker: BattlerState,
  deps: { grounding?: { attackerHasMoldBreaker: boolean } },
): boolean {
  if (deps.grounding?.attackerHasMoldBreaker) return true
  return (
    battlerHasAbility(attacker.mon.abilities, 'ABILITY_MOLD_BREAKER', () => false) ||
    battlerHasAbility(attacker.mon.abilities, 'ABILITY_TERAVOLT', () => false) ||
    battlerHasAbility(attacker.mon.abilities, 'ABILITY_TURBOBLAZE', () => false)
  )
}

/**
 * IsBattlerWeatherAffected, src/battle_util.c:8644-8653.
 * Checks weather flag, weatherHasEffect, and HOLD_EFFECT_UTILITY_UMBRELLA for sun/rain.
 */
export function isBattlerWeatherAffected(
  state: BattleState,
  battlerId: number,
  weatherFlags: number,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
): boolean {
  if (
    hasFlag(state.field.weather, weatherFlags) &&
    (deps.grounding ? weatherHasEffect(state, deps.grounding) : true)
  ) {
    if (hasFlag(state.field.weather, WEATHER_SUN_ANY | WEATHER_RAIN_ANY)) {
      const battler = state.battlers[battlerId]
      if (battler && !hasFlag(battler.statuses3, STATUS3_EMBARGO) && battler.mon.itemId) {
        const item = deps.dataContext.item(battler.mon.itemId)
        if (item?.resolvedHoldEffect === 'HOLD_EFFECT_UTILITY_UMBRELLA') {
          return false
        }
      }
    }
    return true
  }
  return false
}

/** The 11 abilities with hooks.onBlockStatDrops in data/v2.65beta/abilityHooks.json. */
export const STAT_DROP_BLOCK_ABILITIES = [
  'ABILITY_CLEAR_BODY',
  'ABILITY_FULL_METAL_BODY',
  'ABILITY_LIMBER',
  'ABILITY_LUCKY_HALO',
  'ABILITY_HYPER_CUTTER',
  'ABILITY_KEEN_EYE',
  'ABILITY_MINDS_EYE',
  'ABILITY_DESERT_CLOAK',
  'ABILITY_DUNE_VEIL',
  'ABILITY_FLOWER_VEIL',
  'ABILITY_JUNGLES_GUARD',
] as const

/** GetStatDropBlock, src/abilities.cc:437-461. */
function getStatDropBlock(
  state: BattleState,
  battler: BattlerState,
  statId: number,
  affectsUser: boolean,
  attackerId: number,
  attackerHasMoldBreaker: boolean,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
  unmodelled: string[],
): boolean {
  // Clear Body (:852) and Full Metal Body (:861) block unconditionally.
  if (battlerHasSimAbility(state, battler, 'ABILITY_CLEAR_BODY', true, attackerId, attackerHasMoldBreaker, deps.dataContext)) return true
  if (battlerHasSimAbility(state, battler, 'ABILITY_FULL_METAL_BODY', true, attackerId, attackerHasMoldBreaker, deps.dataContext)) return true

  // Self-stat drops (affectsUser == TRUE) are blocked by Limber (:588) and Lucky Halo (:12313).
  if (affectsUser) {
    if (battlerHasSimAbility(state, battler, 'ABILITY_LIMBER', true, attackerId, attackerHasMoldBreaker, deps.dataContext)) return true
    if (battlerHasSimAbility(state, battler, 'ABILITY_LUCKY_HALO', true, attackerId, attackerHasMoldBreaker, deps.dataContext)) return true
  }

  // External stat drops (!affectsUser) are blocked by specific-stat or conditional abilities.
  if (!affectsUser) {
    if (statId === STAT_ACC && battlerHasSimAbility(state, battler, 'ABILITY_KEEN_EYE', true, attackerId, attackerHasMoldBreaker, deps.dataContext)) return true
    if (statId === STAT_ACC && battlerHasSimAbility(state, battler, 'ABILITY_MINDS_EYE', true, attackerId, attackerHasMoldBreaker, deps.dataContext)) return true
    if ((statId === STAT_ATK || statId === STAT_SPATK) && battlerHasSimAbility(state, battler, 'ABILITY_HYPER_CUTTER', true, attackerId, attackerHasMoldBreaker, deps.dataContext)) return true
    if (
      isBattlerWeatherAffected(state, battler.id, WEATHER_SANDSTORM_ANY, deps) &&
      (battlerHasSimAbility(state, battler, 'ABILITY_DESERT_CLOAK', true, attackerId, attackerHasMoldBreaker, deps.dataContext) ||
       battlerHasSimAbility(state, battler, 'ABILITY_DUNE_VEIL', true, attackerId, attackerHasMoldBreaker, deps.dataContext))
    ) {
      return true
    }
    if (
      battler.mon.types.includes('GRASS') &&
      (battlerHasSimAbility(state, battler, 'ABILITY_FLOWER_VEIL', true, attackerId, attackerHasMoldBreaker, deps.dataContext) ||
       battlerHasSimAbility(state, battler, 'ABILITY_JUNGLES_GUARD', true, attackerId, attackerHasMoldBreaker, deps.dataContext))
    ) {
      return true
    }
  }

  // Doubles partner scan (:447-458): only when a partner exists.
  const partnerId = battler.id ^ 2
  if (partnerId < state.battlersCount && isAlive(state, partnerId)) {
    unmodelled.push('GetStatDropBlock partner scan (abilities.cc:447-458) is not modelled')
  }

  return false
}

function hasClearAmulet(battler: BattlerState, dataContext: SimDataContext): boolean {
  if (hasFlag(battler.statuses3, STATUS3_EMBARGO)) return false
  if (!battler.mon.itemId) return false
  return dataContext.item(battler.mon.itemId)?.resolvedHoldEffect === 'HOLD_EFFECT_CLEAR_AMULET'
}

function hasMirrorArmor(
  state: BattleState,
  battler: BattlerState,
  attackerId: number,
  attackerHasMoldBreaker: boolean,
  dataContext: SimDataContext,
): boolean {
  return (
    battlerHasSimAbility(state, battler, 'ABILITY_MIRROR_ARMOR', true, attackerId, attackerHasMoldBreaker, dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_CRYSTALLINE_ARMOR', true, attackerId, attackerHasMoldBreaker, dataContext)
  )
}

function isMistActive(state: BattleState, battlerId: number): boolean {
  const side = battlerId & 1
  return (state.sides[side]?.timers.mistTimer ?? 0) > 0
}

function attackerInfiltrates(
  state: BattleState,
  attacker: BattlerState,
  attackerId: number,
  dataContext: SimDataContext,
): boolean {
  return battlerHasSimAbility(state, attacker, 'ABILITY_INFILTRATOR', false, attackerId, false, dataContext)
}

/** GetHighestAttackingStatId, src/battle_util.c:8748-8767. */
export function getHighestAttackingStatId(
  state: BattleState,
  battlerId: number,
  statStageRatios: [number, number][],
): number {
  const battler = state.battlers[battlerId]
  if (!battler) return STAT_ATK

  const benefits = benefitsFromStatBuffs(state, battlerId)

  let atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  if (!benefits) atkStage = Math.min(atkStage, DEFAULT_STAT_STAGE)
  const atkRatio = statStageRatios[atkStage] ?? [1, 1]
  const atkStat = Math.floor((battler.mon.rawStats.atk * atkRatio[0]) / atkRatio[1])

  let spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  if (!benefits) spAtkStage = Math.min(spAtkStage, DEFAULT_STAT_STAGE)
  const spAtkRatio = statStageRatios[spAtkStage] ?? [1, 1]
  const spAtkStat = Math.floor((battler.mon.rawStats.spatk * spAtkRatio[0]) / spAtkRatio[1])

  // In C: for (i = STAT_ATK; i <= STAT_SPATK; i += STAT_SPATK - STAT_ATK)
  // Ties prefer STAT_ATK because check is strictly greater (`>`).
  if (spAtkStat > atkStat) return STAT_SPATK
  return STAT_ATK
}

/**
 * JumpIfMoveAffectedByProtect(0), src/battle_script_commands.c:1240-1249 and battle_util.c:6571-6645.
 */
function jumpIfMoveAffectedByProtect(state: BattleState, targetId: number, unmodelled: string[]): boolean {
  const target = state.battlers[targetId]
  if (!target) return false
  const pm = target.round.protectMove
  // IsBattlerProtected(gBattlerTarget, MOVE_NONE): MOVE_NONE is PHYSICAL and carries ignoresProtect,
  // so evadesProtect is TRUE and the main protectMove switch never runs; Ice Burn / Freeze Shock give
  // PROTECT_TOUCH_BUT_DAMAGED (no PROTECT_BLOCK bit). Only Detect / Merculight can block, through
  // GetTotalAccuracy(attacker, target, MOVE_NONE) < 101, which this sim does not evaluate for MOVE_NONE.
  if (pm === 'MOVE_DETECT' || pm === 'MOVE_MERCULIGHT') {
    unmodelled.push('ChangeStatBuffs :9789 JumpIfMoveAffectedByProtect(0) against Detect/Merculight needs GetTotalAccuracy(.., MOVE_NONE) (battle_util.c:6579-6585); treated as not blocked')
  }
  return false
}

export interface ChangeStatBuffsResult {
  delta: number
  multistringChooser: number
  missed?: boolean
}

/**
 * Port of ChangeStatBuffs, src/battle_script_commands.c:9713-9946.
 */
export function changeStatBuffs(
  state: BattleState,
  battlerId: number,
  attackerId: number,
  targetId: number,
  initialStatValue: number,
  statId: number,
  flags: number,
  hasBsPtr: boolean,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
  unmodelled: string[],
  currentMoveId?: string,
): ChangeStatBuffsResult {
  const battler = state.battlers[battlerId]
  if (!battler) return { delta: 0, multistringChooser: B_MSG_STAT_WONT_INCREASE, missed: false }

  const certain = (flags & MOVE_EFFECT_CERTAIN) !== 0
  const affectsUser = (flags & MOVE_EFFECT_AFFECTS_USER) !== 0
  const notProtectAffected = (flags & STAT_BUFF_NOT_PROTECT_AFFECTED) !== 0
  const dontSetBuffers = (flags & STAT_BUFF_DONT_SET_BUFFERS) !== 0
  let statValue = initialStatValue
  let activeFlags = flags
  if (!hasBsPtr) activeFlags &= ~STAT_BUFF_ALLOW_PTR

  // :9736 -- gTurnStructs[battler].changedStatsBattlerId = gBattlerAttacker
  battler.turn.changedStatsBattlerId = attackerId

  const attacker = state.battlers[attackerId]
  const attackerHasMoldBreaker = attacker ? attackerHasMoldBreakerActive(attacker, deps) : false

  // :9749 -- BATTLER_HAS_ABILITY(battler, ABILITY_CONTRARY)
  if (battlerHasSimAbility(state, battler, 'ABILITY_CONTRARY', true, attackerId, attackerHasMoldBreaker, deps.dataContext)) {
    statValue *= -1
  }

  // :9756
  if (dontSetBuffers) activeFlags = 0

  // :9758 -- BattlerHasAbility(battler, ABILITY_SIMPLE, FALSE)
  if (battlerHasSimAbility(state, battler, 'ABILITY_SIMPLE', false, attackerId, attackerHasMoldBreaker, deps.dataContext)) {
    statValue *= 2
  }

  // :9760 -- if (!affectsUser && BattlerHasAbility(gBattlerAttacker, ABILITY_SUBDUE, FALSE) && statValue <= -1)
  if (!affectsUser && attacker && battlerHasSimAbility(state, attacker, 'ABILITY_SUBDUE', false, attackerId, attackerHasMoldBreaker, deps.dataContext) && statValue <= -1) {
    statValue *= 2
  }

  let multistringChooser = 0

  // :9762 -- stat decrease
  if (statValue <= -1) {
    const dropBlocked = getStatDropBlock(state, battler, statId, affectsUser, attackerId, attackerHasMoldBreaker, deps, unmodelled)
    const mistActive = isMistActive(state, battlerId)
    const infiltrates = attacker ? attackerInfiltrates(state, attacker, attackerId, deps.dataContext) : false

    if (mistActive && !certain && currentMoveId !== 'MOVE_CURSE' && !(!affectsUser && infiltrates)) {
      return { delta: 0, multistringChooser: B_MSG_STAT_WONT_DECREASE, missed: false }
    } else if (currentMoveId !== 'MOVE_CURSE' && !notProtectAffected && jumpIfMoveAffectedByProtect(state, targetId, unmodelled)) {
      // :9787-9791 -- JumpIfMoveAffectedByProtect(0) sets MOVE_RESULT_MISSED and returns 0
      return { delta: 0, multistringChooser: B_MSG_STAT_WONT_DECREASE, missed: true }
    } else if (dropBlocked) {
      return { delta: 0, multistringChooser: B_MSG_STAT_WONT_DECREASE, missed: false }
    } else if (hasMirrorArmor(state, battler, attackerId, attackerHasMoldBreaker, deps.dataContext) && !affectsUser && attackerId !== targetId && battlerId === targetId) {
      unmodelled.push("Mirror Armor stat reflection (battle_script_commands.c:9811) is not modelled")
      return { delta: 0, multistringChooser: B_MSG_STAT_WONT_DECREASE, missed: false }
    } else if (!certain && !affectsUser && hasClearAmulet(battler, deps.dataContext)) {
      return { delta: 0, multistringChooser: B_MSG_STAT_WONT_DECREASE, missed: false }
    } else {
      const currentStage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
      statValue = Math.max(statValue, -currentStage)

      if (!dontSetBuffers) {
        if (currentStage === MIN_STAT_STAGE) {
          multistringChooser = B_MSG_STAT_WONT_DECREASE
        } else {
          battler.round.statFell = true
          multistringChooser = !affectsUser ? B_MSG_DEFENDER_STAT_FELL : B_MSG_ATTACKER_STAT_FELL

          if (!battler.round.disableEjectPack) {
            const hasEjectPackAbility = battlerHasSimAbility(state, battler, 'ABILITY_EJECT_PACK_ABILITY', false, attackerId, false, deps.dataContext)
            const item = battler.mon.itemId ? deps.dataContext.item(battler.mon.itemId) : undefined
            const hasEjectPackItem = item?.resolvedHoldEffect === 'HOLD_EFFECT_EJECT_PACK'
            if (hasEjectPackAbility || hasEjectPackItem) {
              unmodelled.push("Eject Pack switch trigger (battle_script_commands.c:9877-9893) is not modelled")
            }
          }
        }
      }
    }
  } else {
    // :9898 -- stat increase
    const currentStage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
    statValue = Math.min(statValue, MAX_STAT_STAGE - currentStage)

    if (!dontSetBuffers) {
      if (currentStage === MAX_STAT_STAGE) {
        multistringChooser = B_MSG_STAT_WONT_INCREASE
      } else {
        multistringChooser = targetId === battlerId ? B_MSG_DEFENDER_STAT_ROSE : B_MSG_ATTACKER_STAT_ROSE
        battler.round.statRaised = true
      }
    }
  }

  // :9933-9935
  const currentStage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
  let newStage = currentStage + statValue
  if (newStage < MIN_STAT_STAGE) newStage = MIN_STAT_STAGE
  if (newStage > MAX_STAT_STAGE) newStage = MAX_STAT_STAGE
  battler.mon.statStages[statId] = newStage

  // :9937-9940 -- reactive triggers
  if (statValue < 0 && !affectsUser) {
    if (
      battlerHasSimAbility(state, battler, 'ABILITY_DEFIANT', false, attackerId, false, deps.dataContext) ||
      battlerHasSimAbility(state, battler, 'ABILITY_COMPETITIVE', false, attackerId, false, deps.dataContext)
    ) {
      unmodelled.push("Defiant / Competitive onStatLowered trigger (battle_script_commands.c:9938, abilities.cc:11764) is not modelled")
    }
  }
  if (statValue > 0 && battler.round.statRaised) {
    const opposingSide = (battlerId & 1) ^ 1
    for (let id = 0; id < state.battlersCount; id++) {
      if ((id & 1) !== opposingSide || !isAlive(state, id)) continue
      const foe = state.battlers[id]
      if (!foe) continue
      const foeItem = foe.mon.itemId ? deps.dataContext.item(foe.mon.itemId) : undefined
      if (foeItem?.resolvedHoldEffect === 'HOLD_EFFECT_MIRROR_HERB') {
        unmodelled.push("Mirror Herb copy stat trigger (battle_util.c:4738-4762) is not modelled")
      }
      if (battlerHasSimAbility(state, foe, 'ABILITY_OPPORTUNIST', false, attackerId, false, deps.dataContext)) {
        unmodelled.push("Opportunist copy stat trigger is not modelled")
      }
    }
  }

  // :9942 -- if (WONT_INCREASE && flags & STAT_BUFF_ALLOW_PTR) gMoveResultFlags |= MOVE_RESULT_MISSED;
  let missed = false
  if (multistringChooser === B_MSG_STAT_WONT_INCREASE && (activeFlags & STAT_BUFF_ALLOW_PTR)) {
    missed = true
  }

  // :9944
  if (multistringChooser === B_MSG_STAT_WONT_INCREASE && !(activeFlags & STAT_BUFF_ALLOW_PTR)) {
    return { delta: 0, multistringChooser, missed }
  }

  return { delta: statValue, multistringChooser, missed }
}

/**
 * Port of ChangeStatBuffsImplicit, src/battle_script_commands.c:9709-9711.
 */
export function changeStatBuffsImplicit(
  state: BattleState,
  attackerId: number,
  targetId: number,
  statValue: number,
  statId: number,
  flags: number,
  hasBsPtr: boolean,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
  unmodelled: string[],
  currentMoveId?: string,
): ChangeStatBuffsResult {
  const battlerId = (flags & MOVE_EFFECT_AFFECTS_USER) ? attackerId : targetId
  return changeStatBuffs(
    state,
    battlerId,
    attackerId,
    targetId,
    statValue,
    statId,
    flags,
    hasBsPtr,
    deps,
    unmodelled,
    currentMoveId,
  )
}

// pipeline/.upstream/er-config/MoveEffect.proto:28-41, 47, 52-65
export const MOVE_EFFECT_ATK_PLUS_1 = 17
export const MOVE_EFFECT_DEF_PLUS_1 = 18
export const MOVE_EFFECT_SPD_PLUS_1 = 19
export const MOVE_EFFECT_SP_ATK_PLUS_1 = 20
export const MOVE_EFFECT_SP_DEF_PLUS_1 = 21
export const MOVE_EFFECT_ACC_PLUS_1 = 22
export const MOVE_EFFECT_EVS_PLUS_1 = 23
export const MOVE_EFFECT_ATK_MINUS_1 = 24
export const MOVE_EFFECT_DEF_MINUS_1 = 25
export const MOVE_EFFECT_SPD_MINUS_1 = 26
export const MOVE_EFFECT_SP_ATK_MINUS_1 = 27
export const MOVE_EFFECT_SP_DEF_MINUS_1 = 28
export const MOVE_EFFECT_ACC_MINUS_1 = 29
export const MOVE_EFFECT_EVS_MINUS_1 = 30
export const MOVE_EFFECT_ALL_STATS_UP = 36
export const MOVE_EFFECT_ATK_PLUS_2 = 41
export const MOVE_EFFECT_DEF_PLUS_2 = 42
export const MOVE_EFFECT_SPD_PLUS_2 = 43
export const MOVE_EFFECT_SP_ATK_PLUS_2 = 44
export const MOVE_EFFECT_SP_DEF_PLUS_2 = 45
export const MOVE_EFFECT_ACC_PLUS_2 = 46
export const MOVE_EFFECT_EVS_PLUS_2 = 47
export const MOVE_EFFECT_ATK_MINUS_2 = 48
export const MOVE_EFFECT_DEF_MINUS_2 = 49
export const MOVE_EFFECT_SPD_MINUS_2 = 50
export const MOVE_EFFECT_SP_ATK_MINUS_2 = 51
export const MOVE_EFFECT_SP_DEF_MINUS_2 = 52
export const MOVE_EFFECT_ACC_MINUS_2 = 53
export const MOVE_EFFECT_EVS_MINUS_2 = 54

/**
 * Port of ReverseStatChangeMoveEffect, src/battle_script_commands.c:9641-9705.
 * Reverses a stat change move effect (+1 <-> -1, +2 <-> -2) under Contrary.
 */
export function reverseStatChangeMoveEffect(moveEffect: number): number {
  switch (moveEffect) {
    // +1 -> -1
    case MOVE_EFFECT_ATK_PLUS_1: return MOVE_EFFECT_ATK_MINUS_1
    case MOVE_EFFECT_DEF_PLUS_1: return MOVE_EFFECT_DEF_MINUS_1
    case MOVE_EFFECT_SPD_PLUS_1: return MOVE_EFFECT_SPD_MINUS_1
    case MOVE_EFFECT_SP_ATK_PLUS_1: return MOVE_EFFECT_SP_ATK_MINUS_1
    case MOVE_EFFECT_SP_DEF_PLUS_1: return MOVE_EFFECT_SP_DEF_MINUS_1
    case MOVE_EFFECT_ACC_PLUS_1: return MOVE_EFFECT_ACC_MINUS_1
    case MOVE_EFFECT_EVS_PLUS_1: return MOVE_EFFECT_EVS_MINUS_1

    // -1 -> +1
    case MOVE_EFFECT_ATK_MINUS_1: return MOVE_EFFECT_ATK_PLUS_1
    case MOVE_EFFECT_DEF_MINUS_1: return MOVE_EFFECT_DEF_PLUS_1
    case MOVE_EFFECT_SPD_MINUS_1: return MOVE_EFFECT_SPD_PLUS_1
    case MOVE_EFFECT_SP_ATK_MINUS_1: return MOVE_EFFECT_SP_ATK_PLUS_1
    case MOVE_EFFECT_SP_DEF_MINUS_1: return MOVE_EFFECT_SP_DEF_PLUS_1
    case MOVE_EFFECT_ACC_MINUS_1: return MOVE_EFFECT_ACC_PLUS_1
    case MOVE_EFFECT_EVS_MINUS_1: return MOVE_EFFECT_EVS_PLUS_1

    // +2 -> -2
    case MOVE_EFFECT_ATK_PLUS_2: return MOVE_EFFECT_ATK_MINUS_2
    case MOVE_EFFECT_DEF_PLUS_2: return MOVE_EFFECT_DEF_MINUS_2
    case MOVE_EFFECT_SPD_PLUS_2: return MOVE_EFFECT_SPD_MINUS_2
    case MOVE_EFFECT_SP_ATK_PLUS_2: return MOVE_EFFECT_SP_ATK_MINUS_2
    case MOVE_EFFECT_SP_DEF_PLUS_2: return MOVE_EFFECT_SP_DEF_MINUS_2
    case MOVE_EFFECT_ACC_PLUS_2: return MOVE_EFFECT_ACC_MINUS_2
    case MOVE_EFFECT_EVS_PLUS_2: return MOVE_EFFECT_EVS_MINUS_2

    // -2 -> +2
    case MOVE_EFFECT_ATK_MINUS_2: return MOVE_EFFECT_ATK_PLUS_2
    case MOVE_EFFECT_DEF_MINUS_2: return MOVE_EFFECT_DEF_PLUS_2
    case MOVE_EFFECT_SPD_MINUS_2: return MOVE_EFFECT_SPD_PLUS_2
    case MOVE_EFFECT_SP_ATK_MINUS_2: return MOVE_EFFECT_SP_ATK_PLUS_2
    case MOVE_EFFECT_SP_DEF_MINUS_2: return MOVE_EFFECT_SP_DEF_PLUS_2
    case MOVE_EFFECT_ACC_MINUS_2: return MOVE_EFFECT_ACC_PLUS_2
    case MOVE_EFFECT_EVS_MINUS_2: return MOVE_EFFECT_EVS_PLUS_2

    default: return moveEffect
  }
}
