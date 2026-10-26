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
  NUM_BATTLE_STATS,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_STAGE_CHECK_IN_PROGRESS,
  STAT_STAGE_CHECK_NEEDED,
  STAT_STAGE_CHECK_NOT_NEEDED,
  STATUS1_BLEED,
  STATUS1_POISON_ANY,
  STATUS3_EMBARGO,
  STATUS3_GASTRO_ACID,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_ANY,
  hasFlag,
  MOVE_EFFECT_ATK_PLUS_1,
  MOVE_EFFECT_DEF_PLUS_1,
  MOVE_EFFECT_SPD_PLUS_1,
  MOVE_EFFECT_SP_ATK_PLUS_1,
  MOVE_EFFECT_SP_DEF_PLUS_1,
  MOVE_EFFECT_ACC_PLUS_1,
  MOVE_EFFECT_EVS_PLUS_1,
  MOVE_EFFECT_ATK_MINUS_1,
  MOVE_EFFECT_DEF_MINUS_1,
  MOVE_EFFECT_SPD_MINUS_1,
  MOVE_EFFECT_SP_ATK_MINUS_1,
  MOVE_EFFECT_SP_DEF_MINUS_1,
  MOVE_EFFECT_ACC_MINUS_1,
  MOVE_EFFECT_EVS_MINUS_1,
  MOVE_EFFECT_ATK_PLUS_2,
  MOVE_EFFECT_DEF_PLUS_2,
  MOVE_EFFECT_SPD_PLUS_2,
  MOVE_EFFECT_SP_ATK_PLUS_2,
  MOVE_EFFECT_SP_DEF_PLUS_2,
  MOVE_EFFECT_ACC_PLUS_2,
  MOVE_EFFECT_EVS_PLUS_2,
  MOVE_EFFECT_ATK_MINUS_2,
  MOVE_EFFECT_DEF_MINUS_2,
  MOVE_EFFECT_SPD_MINUS_2,
  MOVE_EFFECT_SP_ATK_MINUS_2,
  MOVE_EFFECT_SP_DEF_MINUS_2,
  MOVE_EFFECT_ACC_MINUS_2,
  MOVE_EFFECT_EVS_MINUS_2,
} from './constants'
import { battlerHasAbility } from '../abilities/dispatch'
import { findAbilitySlot } from './statusEffects'
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

export function hasClearAmulet(battler: BattlerState, dataContext: SimDataContext): boolean {
  if (hasFlag(battler.statuses3, STATUS3_EMBARGO)) return false
  if (!battler.mon.itemId) return false
  return dataContext.item(battler.mon.itemId)?.resolvedHoldEffect === 'HOLD_EFFECT_CLEAR_AMULET'
}

/**
 * IsStatDropBlocked, src/abilities.cc:432-435.
 * Checks whether a stat drop on battler is blocked by its own or partner's abilities.
 */
export function isStatDropBlocked(
  state: BattleState,
  battler: BattlerState,
  statId: number,
  selfStatDrop: boolean,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
  unmodelled: string[],
): boolean {
  return getStatDropBlock(state, battler, statId, selfStatDrop, battler.id, false, deps, unmodelled)
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
 * GetHighestDefendingStatId, src/battle_util.c:8769-8788.
 * Evaluates Defense vs Special Defense with stat stages (if includeStatStages is true).
 * In C: for (i = STAT_DEF; i <= STAT_SPDEF; i += STAT_SPDEF - STAT_DEF)
 * Ties prefer STAT_DEF because check is strictly greater (`>`).
 */
export function getHighestDefendingStatId(
  state: BattleState,
  battlerId: number,
  statStageRatios: [number, number][],
): number {
  const battler = state.battlers[battlerId]
  if (!battler) return STAT_DEF

  const benefits = benefitsFromStatBuffs(state, battlerId)

  let defStage = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  if (!benefits) defStage = Math.min(defStage, DEFAULT_STAT_STAGE)
  const defRatio = statStageRatios[defStage] ?? [1, 1]
  const defStat = Math.floor((battler.mon.rawStats.def * defRatio[0]) / defRatio[1])

  let spDefStage = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE
  if (!benefits) spDefStage = Math.min(spDefStage, DEFAULT_STAT_STAGE)
  const spDefRatio = statStageRatios[spDefStage] ?? [1, 1]
  const spDefStat = Math.floor((battler.mon.rawStats.spdef * spDefRatio[0]) / spDefRatio[1])

  if (spDefStat > defStat) return STAT_SPDEF
  return STAT_DEF
}

/**
 * GetHighestStatId, src/battle_util.c:8746, 8724-8744.
 * Walks in C struct order: STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF.
 * Ties prefer earlier stat because check is strictly greater (`>`).
 */
export function getHighestStatId(
  state: BattleState,
  battlerId: number,
  statStageRatios: [number, number][],
): number {
  const battler = state.battlers[battlerId]
  if (!battler) return STAT_ATK

  const benefits = benefitsFromStatBuffs(state, battlerId)

  const stats: Array<[number, keyof BattlerState['mon']['rawStats']]> = [
    [STAT_ATK, 'atk'],
    [STAT_DEF, 'def'],
    [STAT_SPEED, 'spe'],
    [STAT_SPATK, 'spatk'],
    [STAT_SPDEF, 'spdef'],
  ]

  let highestId = STAT_ATK
  let highestStat = 0

  for (const [id, key] of stats) {
    let stage = battler.mon.statStages[id] ?? DEFAULT_STAT_STAGE
    if (!benefits) stage = Math.min(stage, DEFAULT_STAT_STAGE)
    const ratio = statStageRatios[stage] ?? [1, 1]
    const val = Math.floor((battler.mon.rawStats[key] * ratio[0]) / ratio[1])

    if (val > highestStat) {
      highestStat = val
      highestId = id
    }
  }

  return highestId
}

/**
 * GetHighestStatIdExcept with includeStatStages = FALSE, src/battle_util.c:8724-8744. The only caller,
 * MOVE_EFFECT_HIGHEST_STAT_EXCEPT_SPEED_PLUS_1 (battle_script_commands.c:3013), passes FALSE.
 */
export function getHighestStatIdExcept(battler: BattlerState, excludeStat: number): number {
  const stats: Array<[number, keyof BattlerState['mon']['rawStats']]> = [
    [STAT_ATK, 'atk'],
    [STAT_DEF, 'def'],
    [STAT_SPEED, 'spe'],
    [STAT_SPATK, 'spatk'],
    [STAT_SPDEF, 'spdef'],
  ]

  let highestId = STAT_ATK
  let highestStat = 0

  for (const [id, key] of stats) {
    if (id === excludeStat) continue
    const val = battler.mon.rawStats[key]
    if (val > highestStat) {
      highestStat = val
      highestId = id
    }
  }

  return highestId
}

// src/battle_script_commands.h:50-52
export const RESET_ALL_STATS = 0
export const RESET_STAT_BUFFS = 1
export const RESET_STAT_DROPS = -1

/**
 * TryResetBattlerStatChanges, src/battle_script_commands.c:9957-9986.
 */
export function tryResetBattlerStatChanges(
  state: BattleState,
  battlerId: number,
  comparison: number,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false

  battler.volatiles.stockpileDef = 0
  battler.volatiles.stockpileSpDef = 0

  let ret = false
  for (let j = 0; j < NUM_BATTLE_STATS; j++) {
    const current = battler.mon.statStages[j] ?? DEFAULT_STAT_STAGE
    if (comparison === RESET_ALL_STATS && current === DEFAULT_STAT_STAGE) continue
    if (comparison === RESET_STAT_BUFFS && current <= DEFAULT_STAT_STAGE) continue
    if (comparison === RESET_STAT_DROPS && current >= DEFAULT_STAT_STAGE) continue

    ret = true
    battler.mon.statStages[j] = DEFAULT_STAT_STAGE
  }

  if (
    (comparison === RESET_ALL_STATS || comparison === RESET_STAT_BUFFS) &&
    battler.volatiles.critBoost
  ) {
    ret = true
    battler.volatiles.critBoost = 0
  }

  return ret
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
            const hasEjectPackItem =
              item?.resolvedHoldEffect === 'HOLD_EFFECT_EJECT_PACK' &&
              !isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)
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

  // src/battle_script_commands.c:9937-9940 -- record stat changes for reactive triggers
  if (
    statValue !== 0 &&
    (state.statStageCheckState ?? STAT_STAGE_CHECK_NOT_NEEDED) !== STAT_STAGE_CHECK_IN_PROGRESS &&
    statId < NUM_BATTLE_STATS
  ) {
    state.statStageCheckState = STAT_STAGE_CHECK_NEEDED
    if (!state.statChangesToCheck) {
      state.statChangesToCheck = Array.from({ length: state.battlersCount }, () =>
        new Array<number>(NUM_BATTLE_STATS - 1).fill(0),
      )
    }
    if (!state.statChangesToCheck[battlerId]) {
      state.statChangesToCheck[battlerId] = new Array<number>(NUM_BATTLE_STATS - 1).fill(0)
    }
    state.statChangesToCheck[battlerId][statId - 1] =
      (state.statChangesToCheck[battlerId][statId - 1] ?? 0) + statValue
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

/**
 * CanRaiseStat, src/battle_util.c:9364 -> CompareStat (:8545-8561), which flips under Contrary.
 */
export function canRaiseStat(
  state: BattleState,
  battlerId: number,
  statId: number,
  dataContext: SimDataContext,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  const stage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
  const contrary = battlerHasSimAbility(state, battler, 'ABILITY_CONTRARY', true, battlerId, false, dataContext)
  return contrary ? stage > MIN_STAT_STAGE : stage < MAX_STAT_STAGE
}

const UNNERVE_ABILITIES = [
  'ABILITY_UNNERVE',
  'ABILITY_AS_ONE_ICE_RIDER',
  'ABILITY_AS_ONE_SHADOW_RIDER',
  'ABILITY_CROWNED_KING',
] as const

/**
 * IsUnnerveAbilityOnOpposingSide, src/battle_util.c:8387-8397. Both branches scan
 * BATTLE_OPPOSITE(battlerId) for the `unnerve` flag (the four abilities above); the
 * second only changes which battler must be alive. The opposite's partner is never scanned.
 */
export function isUnnerveAbilityOnOpposingSide(
  state: BattleState,
  battlerId: number,
  dataContext: SimDataContext,
): boolean {
  const opposite = battlerId ^ 1
  const partner = opposite ^ 2
  const gate = isAlive(state, opposite) || (partner < state.battlersCount && isAlive(state, partner))
  const opp = state.battlers[opposite]
  if (!gate || !opp) return false
  return UNNERVE_ABILITIES.some((ability) => battlerHasSimAbility(state, opp, ability, false, battlerId, false, dataContext))
}

function getAbilitySlotsReverse(slots: BattlerState['mon']['abilities']): { abilityId: string; slotIndex: number }[] {
  const result: { abilityId: string; slotIndex: number }[] = []
  if (slots.innates[2]) result.push({ abilityId: slots.innates[2], slotIndex: 3 })
  if (slots.innates[1]) result.push({ abilityId: slots.innates[1], slotIndex: 2 })
  if (slots.innates[0]) result.push({ abilityId: slots.innates[0], slotIndex: 1 })
  if (slots.ability) result.push({ abilityId: slots.ability, slotIndex: 0 })
  return result
}

type AbilityOnStatLoweredHandler = (
  state: BattleState,
  battlerId: number,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
  unmodelled: string[],
  statChanges?: { battlerId: number; stat: number; change: number }[],
) => boolean

interface OnStatLoweredEntry {
  applyOn: 'APPLY_ON_SELF' | 'APPLY_ON_ALLY'
  handler: AbilityOnStatLoweredHandler
}

function raiseStatByHook(
  state: BattleState,
  battlerId: number,
  statId: number,
  stages: number,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
  unmodelled: string[],
  statChanges?: { battlerId: number; stat: number; change: number }[],
): boolean {
  if (!canRaiseStat(state, battlerId, statId, deps.dataContext)) {
    return false
  }
  const res = changeStatBuffs(
    state,
    battlerId,
    battlerId,
    battlerId,
    stages,
    statId,
    // BattleScript_StackBattlerStatUp (data/battle_scripts_1.s:9028-9037)
    MOVE_EFFECT_AFFECTS_USER,
    true,
    deps,
    unmodelled,
  )
  if (res.delta !== 0 && statChanges) {
    statChanges.push({ battlerId, stat: statId, change: res.delta })
  }
  return true
}

const ON_STAT_LOWERED_HOOKS: Record<string, OnStatLoweredEntry> = {
  // src/abilities.cc:11764-11769
  ABILITY_DEFIANT: {
    applyOn: 'APPLY_ON_SELF',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      return raiseStatByHook(state, battlerId, STAT_ATK, 2, deps, unmodelled, statChanges)
    },
  },
  // src/abilities.cc:11774-11779
  ABILITY_COMPETITIVE: {
    applyOn: 'APPLY_ON_SELF',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      return raiseStatByHook(state, battlerId, STAT_SPATK, 2, deps, unmodelled, statChanges)
    },
  },
  // src/abilities.cc:11784 (alias ABILITY_DEFIANT)
  ABILITY_CONTEMPT: {
    applyOn: 'APPLY_ON_SELF',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      return raiseStatByHook(state, battlerId, STAT_ATK, 2, deps, unmodelled, statChanges)
    },
  },
  // src/abilities.cc:11790-11795
  ABILITY_RUN_AWAY: {
    applyOn: 'APPLY_ON_SELF',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      return raiseStatByHook(state, battlerId, STAT_SPEED, 2, deps, unmodelled, statChanges)
    },
  },
  // src/abilities.cc:11800-11815
  ABILITY_KINGS_WRATH: {
    applyOn: 'APPLY_ON_ALLY',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      let any = false
      if (raiseStatByHook(state, battlerId, STAT_DEF, 1, deps, unmodelled, statChanges)) any = true
      if (raiseStatByHook(state, battlerId, STAT_ATK, 1, deps, unmodelled, statChanges)) any = true
      return any
    },
  },
  // src/abilities.cc:11819-11834
  ABILITY_QUEENS_MOURNING: {
    applyOn: 'APPLY_ON_ALLY',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      let any = false
      if (raiseStatByHook(state, battlerId, STAT_SPDEF, 1, deps, unmodelled, statChanges)) any = true
      if (raiseStatByHook(state, battlerId, STAT_SPATK, 1, deps, unmodelled, statChanges)) any = true
      return any
    },
  },
  // src/abilities.cc:11838-11863
  ABILITY_EMPERORS_WRATH: {
    applyOn: 'APPLY_ON_ALLY',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      let any = false
      if (raiseStatByHook(state, battlerId, STAT_SPDEF, 1, deps, unmodelled, statChanges)) any = true
      if (raiseStatByHook(state, battlerId, STAT_DEF, 1, deps, unmodelled, statChanges)) any = true
      if (raiseStatByHook(state, battlerId, STAT_SPATK, 1, deps, unmodelled, statChanges)) any = true
      if (raiseStatByHook(state, battlerId, STAT_ATK, 1, deps, unmodelled, statChanges)) any = true
      return any
    },
  },
  // src/abilities.cc:11868-11870 (alias ABILITY_DEFIANT, with onStatLoweredFor = APPLY_ON_ALLY)
  ABILITY_LUCHA_LIBRE: {
    applyOn: 'APPLY_ON_ALLY',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      return raiseStatByHook(state, battlerId, STAT_ATK, 2, deps, unmodelled, statChanges)
    },
  },
  // src/abilities.cc:11877-11878 (alias ABILITY_KINGS_WRATH, onStatLoweredFor = APPLY_ON_ALLY)
  ABILITY_FIRE_RULER: {
    applyOn: 'APPLY_ON_ALLY',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      let any = false
      if (raiseStatByHook(state, battlerId, STAT_DEF, 1, deps, unmodelled, statChanges)) any = true
      if (raiseStatByHook(state, battlerId, STAT_ATK, 1, deps, unmodelled, statChanges)) any = true
      return any
    },
  },
  // src/abilities.cc:11884-11899
  ABILITY_NARCISSIST: {
    applyOn: 'APPLY_ON_ALLY',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      let any = false
      if (raiseStatByHook(state, battlerId, STAT_SPATK, 2, deps, unmodelled, statChanges)) any = true
      if (raiseStatByHook(state, battlerId, STAT_ATK, 2, deps, unmodelled, statChanges)) any = true
      return any
    },
  },
  // src/abilities.cc:12554 (alias ABILITY_COMPETITIVE)
  ABILITY_DUALITY: {
    applyOn: 'APPLY_ON_SELF',
    handler: (state, battlerId, deps, unmodelled, statChanges) => {
      return raiseStatByHook(state, battlerId, STAT_SPATK, 2, deps, unmodelled, statChanges)
    },
  },
}

/**
 * Dispatcher for onStatLowered reactions (Defiant / Competitive family).
 * Port of battle_util.c:1222-1255 (PrepareStringBattle on STRINGID_DEFENDERSSTATFELL):
 * When a defender's stat is lowered by a cross-side battler, executes onStatLowered
 * for gBattlerTarget (if alive) and then for its partner (if alive), each gated by
 * IsApplyOnFlagAppropriate(gBattlerTarget, <battler>, onStatLoweredFor).
 */
export function dispatchOnStatLowered(
  state: BattleState,
  targetId: number,
  attackerId: number,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
  unmodelled: string[],
  statChanges?: { battlerId: number; stat: number; change: number }[],
): boolean {
  if (targetId >= state.battlersCount || attackerId >= state.battlersCount) {
    return false
  }

  // Cross-side check: GetBattlerSide(changedStatsBattlerId) != GetBattlerSide(gBattlerTarget)
  if ((targetId & 1) === (attackerId & 1)) {
    return false
  }

  let anyTriggered = false

  // In C order: gBattlerTarget, then BATTLE_PARTNER(gBattlerTarget)
  const targets: { battlerId: number; isTarget: boolean }[] = []
  if (isAlive(state, targetId)) {
    targets.push({ battlerId: targetId, isTarget: true })
  }
  const partnerId = targetId ^ 2
  if (partnerId < state.battlersCount && isAlive(state, partnerId)) {
    targets.push({ battlerId: partnerId, isTarget: false })
  }

  for (const { battlerId, isTarget } of targets) {
    const battler = state.battlers[battlerId]
    if (!battler) continue

    const slots = getAbilitySlotsReverse(battler.mon.abilities)
    for (const { abilityId } of slots) {
      if (isSimAbilitySuppressed(state, battler, abilityId, false, attackerId, false, deps.dataContext)) {
        continue
      }

      const hook = ON_STAT_LOWERED_HOOKS[abilityId]
      if (!hook) continue

      // IsApplyOnFlagAppropriate(gBattlerTarget, battler, hook.applyOn):
      // When battler is targetId (contextBattler == sourceBattler):
      //   APPLY_ON_SELF or APPLY_ON_ALLY both pass (neither has APPLY_IGNORE_SELF).
      // When battler is partnerId (contextBattler != sourceBattler, same side):
      //   Only APPLY_ON_ALLY passes.
      if (!isTarget && hook.applyOn !== 'APPLY_ON_ALLY') {
        continue
      }

      const triggered = hook.handler(state, battlerId, deps, unmodelled, statChanges)
      if (triggered) {
        anyTriggered = true
      }
    }
  }

  return anyTriggered
}

/**
 * BattleScript_AttackerAteItem / Cmd_removeitem (data/battle_scripts_1.s:10795-10802,
 * src/battle_script_commands.c:6040-6053).
 */
export function consumeHeldItem(state: BattleState, battler: BattlerState, unmodelled: string[]): void {
  const itemId = battler.mon.itemId
  if (itemId) {
    battler.usedHeldItem = itemId
  }
  const slotU = findAbilitySlot(battler.mon.abilities, 'ABILITY_UNBURDEN')
  if (slotU !== -1) battler.volatiles.abilityState[slotU] = 1
  const slotS = findAbilitySlot(battler.mon.abilities, 'ABILITY_SUGAR_RUSH')
  if (slotS !== -1) battler.volatiles.abilityState[slotS] = 1

  const hasAbility = (b: BattlerState, id: string) => battlerHasAbility(b.mon.abilities, id, () => false)
  if (hasAbility(battler, 'ABILITY_GREEDY')) {
    unmodelled.push("UpdateBattlerItem's Greedy ability state (battle_script_commands.c:2209-2212) is not modelled")
  }
  if (itemId !== 'ITEM_BIG_NUGGET' && state.battlers.some((b) => b && hasAbility(b, 'ABILITY_POWER_OF_ALCHEMY'))) {
    unmodelled.push("UpdateBattlerItem's Power of Alchemy item memory (battle_script_commands.c:2206-2207) is not modelled")
  }
  battler.mon.itemId = null
}

/**
 * Port of AbilityBattleEffects(ABILITYEFFECT_REACTIVE, ...) (src/battle_util.c:4733-4774)
 * and BattleScript_PerformCopyStatEffects / VARIOUS_DO_COPY_STAT_CHANGE
 * (src/battle_script_commands.c:8202-8309).
 *
 * Runs reactive triggers when stats change:
 * 1. Mirror Herb scan (battle_util.c:4737-4751)
 * 2. onReactive for every alive battler (battle_util.c:4765-4768):
 *    - ABILITY_RETRIBUTION_BLOW (abilities.cc:5145-5160): out-of-turn attack (gapped)
 *    - ABILITY_EGOIST (abilities.cc:7074-7092): copies opponent stat raises
 *    - ABILITY_SHARING_IS_CARING (abilities.cc:7368-7386): copies all stat changes
 * 3. Copy execution passes:
 *    - Egoist pass (battle_script_commands.c:8206-8241)
 *    - Sharing is Caring pass (battle_script_commands.c:8243-8279)
 *    - Mirror Herb pass (battle_script_commands.c:8280-8305): copies opponent stat raises,
 *      eats item on first stat raised.
 * 4. Cleans up statChangesToCheck and resets statStageCheckState to STAT_STAGE_CHECK_NOT_NEEDED.
 */
export function runReactiveAbilityEffects(
  state: BattleState,
  deps: { dataContext: SimDataContext; grounding?: GroundingContext },
  unmodelled: string[],
  statChanges?: { battlerId: number; stat: number; change: number }[],
  battlerOrder?: readonly number[],
): boolean {
  if ((state.statStageCheckState ?? STAT_STAGE_CHECK_NOT_NEEDED) !== STAT_STAGE_CHECK_NEEDED) {
    return false
  }

  // 1. Mirror Herb scan (battle_util.c:4737-4751)
  let mirrorHerbFound = false
  for (let i = 0; i < state.battlersCount; i++) {
    if (!isAlive(state, i)) continue
    const battler = state.battlers[i]
    if (!battler) continue
    const item = battler.mon.itemId ? deps.dataContext.item(battler.mon.itemId) : undefined
    if (
      item?.resolvedHoldEffect === 'HOLD_EFFECT_MIRROR_HERB' &&
      !hasFlag(battler.statuses3, STATUS3_EMBARGO) &&
      !isUnnerveAbilityOnOpposingSide(state, i, deps.dataContext)
    ) {
      for (let statId = STAT_ATK; statId < NUM_BATTLE_STATS; statId++) {
        for (let j = 0; j < state.battlersCount; j++) {
          if ((i & 1) === (j & 1)) continue // opponents only
          if ((state.statChangesToCheck?.[j]?.[statId - 1] ?? 0) > 0) {
            mirrorHerbFound = true
            break
          }
        }
        if (mirrorHerbFound) break
      }
    }
    if (mirrorHerbFound) break
  }

  if (mirrorHerbFound) {
    state.statStageCheckState = STAT_STAGE_CHECK_IN_PROGRESS
  }

  // 2. onReactive for every alive battler (battle_util.c:4765-4768)
  const egoistActive: boolean[] = new Array(state.battlersCount).fill(false)
  let sharingIsCaringActive = false

  for (let i = 0; i < state.battlersCount; i++) {
    if (!isAlive(state, i)) continue
    const battler = state.battlers[i]
    if (!battler) continue

    const slots = getAbilitySlotsReverse(battler.mon.abilities)
    for (const { abilityId } of slots) {
      if (isSimAbilitySuppressed(state, battler, abilityId, false, i, false, deps.dataContext)) {
        continue
      }

      if (abilityId === 'ABILITY_EGOIST') {
        // abilities.cc:7075-7091
        if (state.statStageCheckState !== STAT_STAGE_CHECK_NOT_NEEDED) {
          let opponentHasPositive = false
          for (let opp = (i & 1) ^ 1; opp < state.battlersCount; opp += 2) {
            for (let stat = STAT_ATK; stat < NUM_BATTLE_STATS; stat++) {
              if ((state.statChangesToCheck?.[opp]?.[stat - 1] ?? 0) > 0) {
                opponentHasPositive = true
                break
              }
            }
            if (opponentHasPositive) break
          }
          if (opponentHasPositive) {
            state.statStageCheckState = STAT_STAGE_CHECK_IN_PROGRESS
            egoistActive[i] = true
          }
        }
      } else if (abilityId === 'ABILITY_SHARING_IS_CARING') {
        // abilities.cc:7368-7385
        if (state.statStageCheckState === STAT_STAGE_CHECK_NEEDED || state.statStageCheckState === STAT_STAGE_CHECK_IN_PROGRESS) {
          state.statStageCheckState = STAT_STAGE_CHECK_IN_PROGRESS
          sharingIsCaringActive = true
        }
      } else if (abilityId === 'ABILITY_RETRIBUTION_BLOW') {
        // abilities.cc:5145-5160: Retribution Blow
        if (state.statStageCheckState !== STAT_STAGE_CHECK_NOT_NEEDED) {
          for (let opp = 0; opp < state.battlersCount; opp++) {
            if ((opp & 1) === (i & 1)) continue
            for (let stat = STAT_ATK; stat < NUM_BATTLE_STATS; stat++) {
              if ((state.statChangesToCheck?.[opp]?.[stat - 1] ?? 0) > 0) {
                unmodelled.push("Retribution Blow out-of-turn attack (abilities.cc:5145-5160) is not modelled")
                break
              }
            }
          }
        }
      }
    }
  }

  // If no reactive effect triggered, reset to NOT_NEEDED and zero (battle_util.c:4770-4773)
  if (state.statStageCheckState === STAT_STAGE_CHECK_NEEDED) {
    state.statStageCheckState = STAT_STAGE_CHECK_NOT_NEEDED
    if (state.statChangesToCheck) {
      for (let b = 0; b < state.battlersCount; b++) {
        state.statChangesToCheck[b]?.fill(0)
      }
    }
    return false
  }

  // 3. Perform copy effects (battle_script_commands.c:8202-8309)
  let anyCopied = false

  // Pass 1: Egoist (battle_script_commands.c:8206-8241)
  const order = battlerOrder ?? Array.from({ length: state.battlersCount }, (_, idx) => idx)
  for (const battlerId of order) {
    if (!isAlive(state, battlerId) || !egoistActive[battlerId]) continue
    const battler = state.battlers[battlerId]
    if (!battler) continue

    // `s8 change = 0` is declared outside the stat loop (:8209) and only reset by the `return`
    // after a successful copy, so a copy that ChangeStatBuffs refuses carries into the next stat.
    let change = 0
    for (let stat = STAT_ATK; stat < NUM_BATTLE_STATS; stat++) {
      for (let other = 0; other < state.battlersCount; other++) {
        if ((other & 1) === (battlerId & 1)) continue // opponents only
        const val = state.statChangesToCheck?.[other]?.[stat - 1] ?? 0
        if (val > 0) change += val
      }
      if (change !== 0) {
        const res = changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          change,
          stat,
          MOVE_EFFECT_AFFECTS_USER,
          true,
          deps,
          unmodelled,
        )
        if (res.delta !== 0) {
          anyCopied = true
          if (statChanges) {
            statChanges.push({ battlerId, stat, change: res.delta })
          }
          change = 0
        }
      }
    }
  }

  // Pass 2: Sharing is Caring (battle_script_commands.c:8243-8279)
  if (sharingIsCaringActive) {
    for (let b = 0; b < state.battlersCount; b++) {
      if (!isAlive(state, b)) continue
      for (let stat = STAT_ATK; stat < NUM_BATTLE_STATS; stat++) {
        let change = 0
        for (let other = 0; other < state.battlersCount; other++) {
          if (other === b) continue
          change += state.statChangesToCheck?.[other]?.[stat - 1] ?? 0
        }
        if (change !== 0) {
          const res = changeStatBuffs(
            state,
            b,
            b,
            b,
            change,
            stat,
            MOVE_EFFECT_AFFECTS_USER,
            true,
            deps,
            unmodelled,
          )
          if (res.delta !== 0) {
            anyCopied = true
            if (statChanges) {
              statChanges.push({ battlerId: b, stat, change: res.delta })
            }
          }
        }
      }
    }
  }

  // Pass 3: Mirror Herb (battle_script_commands.c:8280-8305)
  for (let effectBattler = 0; effectBattler < state.battlersCount; effectBattler++) {
    if (!isAlive(state, effectBattler)) continue
    const battler = state.battlers[effectBattler]
    if (!battler) continue
    const item = battler.mon.itemId ? deps.dataContext.item(battler.mon.itemId) : undefined
    if (
      item?.resolvedHoldEffect !== 'HOLD_EFFECT_MIRROR_HERB' ||
      hasFlag(battler.statuses3, STATUS3_EMBARGO) ||
      isUnnerveAbilityOnOpposingSide(state, effectBattler, deps.dataContext)
    ) {
      continue
    }

    let ateItem = false
    for (let stat = STAT_ATK; stat < NUM_BATTLE_STATS; stat++) {
      let change = 0
      for (let i = 0; i < state.battlersCount; i++) {
        if ((i & 1) === (effectBattler & 1)) continue // opponents only
        const val = state.statChangesToCheck?.[i]?.[stat - 1] ?? 0
        if (val > 0) change += val
      }
      if (change > 0) {
        const res = changeStatBuffs(
          state,
          effectBattler,
          effectBattler,
          effectBattler,
          change,
          stat,
          MOVE_EFFECT_AFFECTS_USER,
          true,
          deps,
          unmodelled,
        )
        if (res.delta !== 0) {
          anyCopied = true
          if (!ateItem) {
            consumeHeldItem(state, battler, unmodelled)
            ateItem = true
          }
          if (statChanges) {
            statChanges.push({ battlerId: effectBattler, stat, change: res.delta })
          }
        }
      }
    }
  }

  // 4. Reset state and zero statChangesToCheck (battle_script_commands.c:8306-8307)
  if (state.statChangesToCheck) {
    for (let b = 0; b < state.battlersCount; b++) {
      state.statChangesToCheck[b]?.fill(0)
    }
  }
  state.statStageCheckState = STAT_STAGE_CHECK_NOT_NEEDED

  return anyCopied || mirrorHerbFound || egoistActive.some(Boolean) || sharingIsCaringActive
}

// Defined in constants.ts (a leaf module) so moveEffects.ts can build SECONDARY_MOVE_EFFECT_MAP without an import cycle
// leaving them undefined; re-exported here for the existing importers.
export {
  MOVE_EFFECT_ATK_PLUS_1,
  MOVE_EFFECT_DEF_PLUS_1,
  MOVE_EFFECT_SPD_PLUS_1,
  MOVE_EFFECT_SP_ATK_PLUS_1,
  MOVE_EFFECT_SP_DEF_PLUS_1,
  MOVE_EFFECT_ACC_PLUS_1,
  MOVE_EFFECT_EVS_PLUS_1,
  MOVE_EFFECT_ATK_MINUS_1,
  MOVE_EFFECT_DEF_MINUS_1,
  MOVE_EFFECT_SPD_MINUS_1,
  MOVE_EFFECT_SP_ATK_MINUS_1,
  MOVE_EFFECT_SP_DEF_MINUS_1,
  MOVE_EFFECT_ACC_MINUS_1,
  MOVE_EFFECT_EVS_MINUS_1,
  MOVE_EFFECT_ALL_STATS_UP,
  MOVE_EFFECT_ATK_PLUS_2,
  MOVE_EFFECT_DEF_PLUS_2,
  MOVE_EFFECT_SPD_PLUS_2,
  MOVE_EFFECT_SP_ATK_PLUS_2,
  MOVE_EFFECT_SP_DEF_PLUS_2,
  MOVE_EFFECT_ACC_PLUS_2,
  MOVE_EFFECT_EVS_PLUS_2,
  MOVE_EFFECT_ATK_MINUS_2,
  MOVE_EFFECT_DEF_MINUS_2,
  MOVE_EFFECT_SPD_MINUS_2,
  MOVE_EFFECT_SP_ATK_MINUS_2,
  MOVE_EFFECT_SP_DEF_MINUS_2,
  MOVE_EFFECT_ACC_MINUS_2,
  MOVE_EFFECT_EVS_MINUS_2,
  MOVE_EFFECT_ATK_DEF_DOWN,
  MOVE_EFFECT_DEF_SPDEF_DOWN,
  MOVE_EFFECT_HIGHEST_STAT_EXCEPT_SPEED_PLUS_1,
  MOVE_EFFECT_RECHARGE,
} from './constants'
