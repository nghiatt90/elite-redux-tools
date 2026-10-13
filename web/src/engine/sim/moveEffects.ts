// Move effect dispatch and status move handlers.
//
// A handled effect's handler owns the execution of its script after attackcanceler.
// Status setup moves (e.g. Swords Dance, Belly Drum) do not roll accuracy in the C,
// deduct PP after attackcanceler, and apply stat changes/HP modifications directly.

import type { BattleState, BattlerState } from './state'
import type { ChosenAction, TurnOrder } from './turnOrder'
import type { ActionOutcome, StatChangeOutcome, StatusAppliedOutcome, TurnLoopDeps } from './turn'
import { buildAccuracyInputs, getTotalAccuracy, isBattlerAlive, isBattlerProtected, ProtectType } from './turn'
import { gapsToUnmodelled } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  ENUM_WEATHER_FOG,
  ENUM_WEATHER_HAIL,
  ENUM_WEATHER_RAIN,
  ENUM_WEATHER_SANDSTORM,
  ENUM_WEATHER_SUN,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  RESOURCE_FLAG_ROOST,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_CRAFTY_SHIELD,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_MIST,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_TOXIC_SPIKES,
  SIDE_STATUS_WIDE_GUARD,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_ANY,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_POISON,
  STATUS2_CURSED,
  STATUS2_DEFENSE_CURL,
  STATUS2_DESTINY_BOND,
  STATUS2_ENRAGED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_FLINCHED,
  STATUS2_NIGHTMARE,
  STATUS2_SUBSTITUTE,
  STATUS2_TORMENT,
  STATUS2_WRAPPED,
  STATUS3_ALWAYS_HITS,
  STATUS3_ALWAYS_HITS_TURN,
  STATUS3_AQUA_RING,
  STATUS3_CHARGED_UP,
  STATUS3_EMBARGO,
  STATUS3_HEAL_BLOCK,
  STATUS3_LASER_FOCUS,
  STATUS3_LEECHSEED,
  STATUS3_MAGNET_RISE,
  STATUS3_MIRACLE_EYED,
  STATUS3_MINIMIZED,
  STATUS3_ON_AIR,
  STATUS3_PERISH_SONG,
  STATUS3_ROOTED,
  STATUS3_SEMI_INVULNERABLE,
  STATUS3_TELEKINESIS,
  STATUS3_YAWN,
  STATUS4_COILED,
  STATUS4_CUTTHROAT,
  STATUS4_FEAR,
  STATUS4_FORESIGHT,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRAVITY,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_INVERSE_ROOM,
  STATUS_FIELD_MAGIC_ROOM,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  STATUS_FIELD_WONDER_ROOM,
  SIDE_STATUS_STICKY_WEB,
  STATUS_FIELD_TERRAIN_ANY,
  TERRAIN_DURATION,
  TERRAIN_DURATION_EXTENDED,
  GRAVITY_DURATION,
  INVERSE_ROOM_DURATION,
  MAGIC_ROOM_DURATION,
  TRICK_ROOM_DURATION,
  WONDER_ROOM_DURATION,
  WEATHER_FOG_ANY,
  WEATHER_FOG_PERMANENT,
  WEATHER_HAIL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_ANY,
  clearFlag,
  hasFlag,
  setCounter,
  setFlag,
  statusInfatuatedWith,
} from './constants'
import {
  MOVE_EFFECT_AFFECTS_USER,
  MOVE_EFFECT_CERTAIN,
  STAT_BUFF_ALLOW_PTR,
  STAT_BUFF_UPDATE_MOVE_EFFECT,
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
  attackerHasMoldBreakerActive,
  B_MSG_DEFENDER_STAT_FELL,
  battlerHasSimAbility,
  benefitsFromStatBuffs,
  changeStatBuffs,
  changeStatBuffsImplicit,
  dispatchOnStatLowered,
  getHighestAttackingStatId,
  isBattlerWeatherAffected,
  RESET_ALL_STATS,
  tryResetBattlerStatChanges,
} from './statBuffs'
import { canBattlerHeal, isHealingBlocked } from './endTurn'
import { tryChangeBattleWeather, trySetStickyWeb, trySetTailwind } from './switchInAbility'
import { dispatchOnWeatherChange } from './onWeather'
import { syncPartyHp } from './outcome'
import { rapidSpinFree } from './hazards'
import { attackPreModify, calculateBattleStat } from '../battleStat'
import type { SimDataContext } from './dataContext'
import type { MoveBehaviors } from '../basePower'
import type { StatusCheck } from './statusEffects'
import {
  CHECK_CONFUSION,
  CHECK_FLINCH,
  MOVE_EFFECT_BLEED,
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_CONFUSION,
  MOVE_EFFECT_FLINCH,
  MOVE_EFFECT_FREEZE,
  MOVE_EFFECT_FROSTBITE,
  MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES,
  MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_POISON,
  MOVE_EFFECT_SLEEP,
  MOVE_EFFECT_TOXIC,
  MOVE_EFFECT_TRI_ATTACK,
  applyPrimaryStatusEffect,
  canBeBurned,
  canBeConfused,
  canBeParalyzed,
  canBeParalyzedIgnoreType,
  canBePoisoned,
  canBleed,
  canGetFrostbite,
  canInfatuate,
  canSleep,
  cancelMultiTurnMoves,
  CHECK_HEAL_BLOCK,
  CHECK_RESTRICTING,
  CHECK_SLEEP,
  doesSubstituteBlockMove,
  findAbilitySlot,
  getMoveEffectChance,
  isAbilityStatusProtected,
  isBattlerTerrainAffected,
  isPreventableSecondaryEffect,
  testSheerForceFlag,
  type StatusDeps,
} from './statusEffects'

export interface MoveEffectContext {
  state: BattleState
  battlerId: number
  targetId: number | null
  action: ChosenAction
  turnOrderIndex: number
  order?: TurnOrder
  deps: TurnLoopDeps
  unmodelled: string[]
  deductPp: (state: BattleState, attackerId: number, moveId: string, moveEffect: string | null, unmodelled: string[]) => void
  applyDamage: (state: BattleState, battlerId: number, damage: number | null, fainted: number[]) => void
}

export type MoveEffectHandler = (ctx: MoveEffectContext) => ActionOutcome

/**
 * Outcome builder for move effect handlers.
 * Defaults targetId to ctx.battlerId per Finding 5 (MOVE_TARGET_USER, src/battle_util.c:239-242, 6403-6405).
 */
function outcome(
  ctx: MoveEffectContext,
  fields?: Partial<ActionOutcome>,
): ActionOutcome {
  return {
    turnOrderIndex: ctx.turnOrderIndex,
    battlerId: ctx.battlerId,
    action: ctx.action.action,
    skippedBecauseFainted: false,
    battleOver: false,
    missed: false,
    targetId: fields?.targetId !== undefined ? fields.targetId : ctx.battlerId,
    targetDamage: null,
    attackerDamage: null,
    cancelledBy: null,
    confusionSelfHitDamage: null,
    statChanges: [],
    statusApplied: null,
    unmodelled: ctx.unmodelled,
    fainted: [],
    ...fields,
  }
}

/**
 * Accuracy check helper at its script position (Cmd_accuracycheck, battle_script_commands.c:1398-1447).
 * Evaluates GetTotalAccuracy and draws Random() % 100 from state.rng.
 * Returns true if the move missed.
 */
function checkAccuracy(
  ctx: MoveEffectContext,
  targetId: number,
  moveId: string,
): boolean {
  const { state, battlerId, deps, unmodelled, turnOrderIndex, order } = ctx
  const targetIndex = order ? order.battlerByTurnOrder.indexOf(targetId) : -1
  const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < turnOrderIndex

  const moveData = deps.dataContext.move(moveId)
  const isContact = moveData?.flags?.contact === true

  // Cmd_accuracycheck:1422 calls JumpIfMoveAffectedByProtect(move) before accuracy calculation.
  const protectType = isBattlerProtected(state, battlerId, targetId, moveId, targetHasActedThisTurn, deps, unmodelled)
  if (protectType !== ProtectType.PROTECT_NONE) {
    if (protectType === ProtectType.PROTECT_BLOCK_ALWAYS_TOUCH || isContact) {
      state.battlers[battlerId]!.round.touchedProtectLike = true
    }
  }
  if ((protectType & ProtectType.PROTECT_BLOCK) !== 0) {
    return true
  }

  const { inputs, gaps, defenderHasAnticipation } = buildAccuracyInputs(
    state,
    battlerId,
    targetId,
    moveId,
    targetHasActedThisTurn,
    deps,
  )
  unmodelled.push(...gapsToUnmodelled(gaps))
  if (defenderHasAnticipation) {
    unmodelled.push(
      "Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432) is not modelled: GetSingleUseAbilityCounter has no state anywhere in this codebase, and the type-effectiveness multiplier it needs is not known until the damage resolver runs afterwards",
    )
  }
  const accResult = getTotalAccuracy(inputs)
  unmodelled.push(...gapsToUnmodelled(accResult.gaps))
  return state.rng.random16() % 100 >= accResult.accuracy
}

/** Helper for plain EFFECT_*_UP and EFFECT_*_UP_2/3 using BattleScript_EffectStatUp. */
function handleSingleStatUp(
  ctx: MoveEffectContext,
  statId: number,
  stages: number,
): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)

  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    stages,
    statId,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId, stat: statId, change: res.delta })
  }

  return outcome(ctx, { statChanges, missed: res.missed ?? false })
}

/**
 * BattleScript_EffectStatDown, data/battle_scripts_1.s:3666-3687.
 * Single-stat target drops:
 * - attackcanceler (handled by caller / target check)
 * - jumpifsubstituteblocks BattleScript_ButItFailedAtkStringPpReduce (:3668)
 * - accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:3669)
 * - attackstring (:3671)
 * - ppreduce (:3672)
 * - statbuffchange STAT_BUFF_ALLOW_PTR, BattleScript_StatDownEnd (:3673)
 * - onStatLowered reaction via dispatchOnStatLowered
 */
function handleSingleStatDown(
  ctx: MoveEffectContext,
  statId: number,
  stages: number,
): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. jumpifsubstituteblocks BattleScript_ButItFailedAtkStringPpReduce (:3668)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId })
  }

  // 2. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:3669)
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. statbuffchange STAT_BUFF_ALLOW_PTR, BattleScript_StatDownEnd (:3673)
  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -stages,
    statId,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: statId, change: res.delta })
  }
  if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
    dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
  }

  return outcome(ctx, { targetId, statChanges, missed: res.missed ?? false })
}

/**
 * BattleScript_EffectScaryFace, data/battle_scripts_1.s:12050-12065.
 * Scary Face has its own script:
 * - attackcanceler
 * - attackstring & ppreduce (:12052-12053)
 * - statbuffchange STAT_BUFF_ALLOW_PTR, BattleScript_EffectScaryFace_Fear (:12057)
 * - setmoveeffect MOVE_EFFECT_FEAR, seteffectprimary (:12063-12064)
 */
function handleScaryFace(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -2,
    STAT_SPEED,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: STAT_SPEED, change: res.delta })
  }
  if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
    dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
  }

  // seteffectprimary MOVE_EFFECT_FEAR: SetMoveEffect returns early on a fainted effect battler
  // (battle_script_commands.c:2364-2382) or a substitute (:2387), needs !fear (:2996-2999), and
  // BattleScript_SetFear skips when STATUS4_FEAR is set (battle_scripts_1.s:2451-2453); VARIOUS_SET_FEAR :8178-8181.
  if (
    target.mon.hp > 0 &&
    !doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled) &&
    !target.volatiles.fear &&
    !hasFlag(target.statuses4, STATUS4_FEAR)
  ) {
    target.statuses4 = setFlag(target.statuses4, STATUS4_FEAR)
    target.volatiles.fear = true
    target.volatiles.started.fear = true
  }

  return outcome(ctx, { targetId, statChanges, missed: res.missed ?? false })
}

/**
 * Helper for two-stat target drops:
 * - EFFECT_TICKLE (BattleScript_EffectTickle, data/battle_scripts_1.s:6610-6636): Atk -1, Def -1
 * - EFFECT_NOBLE_ROAR (BattleScript_EffectNobleRoar, data/battle_scripts_1.s:1772-1798): Atk -1, SpAtk -1
 */
function handleTwoStatDown(
  ctx: MoveEffectContext,
  stat1: number,
  stat2: number,
): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const s1Stage = target.mon.statStages[stat1] ?? DEFAULT_STAT_STAGE
  const s2Stage = target.mon.statStages[stat2] ?? DEFAULT_STAT_STAGE

  // BattleScript_CantLowerMultipleStats check
  if (s1Stage === MIN_STAT_STAGE && s2Stage === MIN_STAT_STAGE) {
    return outcome(ctx, { targetId })
  }

  // accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  const statChanges: StatChangeOutcome[] = []

  // Stat drop 1
  const r1 = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -1,
    stat1,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (r1.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: stat1, change: r1.delta })
  }
  if (r1.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
    dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
  }

  // Stat drop 2
  const r2 = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -1,
    stat2,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (r2.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: stat2, change: r2.delta })
  }
  if (r2.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
    dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
  }

  return outcome(ctx, { targetId, statChanges, missed: (r1.missed || r2.missed) ?? false })
}

/** BattleScript_EffectBulkUp, data/battle_scripts_1.s:6670-6693. */
function handleBulkUp(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const defStage = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE

  if (atkStage < MAX_STAT_STAGE || defStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_DEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_DEF, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectCalmMind, data/battle_scripts_1.s:6739-6763. */
function handleCalmMind(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const spDefStage = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE

  if (spAtkStage < MAX_STAT_STAGE || spDefStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPDEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectCosmicPower, data/battle_scripts_1.s:6645-6668. */
function handleCosmicPower(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const defStage = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  const spDefStage = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE

  if (defStage < MAX_STAT_STAGE || spDefStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_DEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_DEF, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPDEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectCoil, data/battle_scripts_1.s:2019-2061. */
function handleCoil(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const defStage = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  const accStage = battler.mon.statStages[STAT_ACC] ?? DEFAULT_STAT_STAGE
  // jumpifabilityflag ABILITY_COIL_UP -> CheckAbilityFlag (battle_script_commands.c:6707-6708), the coilUp
  // bitfield: Coil Up, Curlipede, Sidewinder (abilityHooks.json).
  const hasCoilUp = ['ABILITY_COIL_UP', 'ABILITY_CURLIPEDE', 'ABILITY_SIDEWINDER'].some((id) =>
    battlerHasSimAbility(state, battler, id, false, battlerId, false, deps.dataContext),
  )
  const isCoiled = hasFlag(battler.statuses4, STATUS4_COILED)

  if (atkStage < MAX_STAT_STAGE || defStage < MAX_STAT_STAGE || accStage < MAX_STAT_STAGE || (hasCoilUp && !isCoiled)) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_DEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_DEF, change: r2.delta })

    const r3 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ACC,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r3.delta !== 0) statChanges.push({ battlerId, stat: STAT_ACC, change: r3.delta })

    if (hasCoilUp && !hasFlag(battler.statuses4, STATUS4_COILED)) {
      battler.statuses4 = setFlag(battler.statuses4, STATUS4_COILED)
    }
  }

  return outcome(ctx, { statChanges })
}

/**
 * BattleScript_EffectAttackUpUserAlly, data/battle_scripts_1.s:34-69.
 * Howl raises user's Attack by 1, and partner's Attack by 1 in doubles.
 */
function handleHowl(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const partnerId = battlerId ^ 2
  const hasPartner = (state.battleTypeFlags & BATTLE_TYPE_DOUBLE) !== 0 && isBattlerAlive(state, partnerId)

  if (!hasPartner) {
    return handleSingleStatUp(ctx, STAT_ATK, 1)
  }

  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const partner = state.battlers[partnerId]!
  const userAtk = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const partnerAtk = partner.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE

  if (userAtk < MAX_STAT_STAGE || partnerAtk < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      partnerId,
      1,
      STAT_ATK,
      STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId: partnerId, stat: STAT_ATK, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/**
 * BattleScript_EffectMeditate, data/battle_scripts_1.s:6714-6737.
 * Meditate raises user's Attack and Special Defense by 1 stage.
 * C lines 6718-6719 gate by spAtkStage < MAX_STAT_STAGE || spDefStage < MAX_STAT_STAGE.
 */
function handleMeditate(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const spDefStage = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE

  if (spAtkStage < MAX_STAT_STAGE || spDefStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPDEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/**
 * BattleScript_EffectDefenseCurl, data/battle_scripts_1.s:5896-5908.
 * Defense Curl sets STATUS2_DEFENSE_CURL (Cmd_setdefensecurlbit, battle_script_commands.c:11428-11431)
 * and raises Defense by 1.
 */
function handleDefenseCurl(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  battler.mon.status2 = setFlag(battler.mon.status2, STATUS2_DEFENSE_CURL)

  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_DEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId, stat: STAT_DEF, change: res.delta })
  }

  return outcome(ctx, { statChanges, missed: res.missed ?? false })
}

/**
 * BattleScript_EffectAttackAccUp, data/battle_scripts_1.s:2167-2190.
 * Raises user's Attack and Accuracy by 1 stage.
 */
function handleAttackAccuracyUp(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const accStage = battler.mon.statStages[STAT_ACC] ?? DEFAULT_STAT_STAGE

  if (atkStage < MAX_STAT_STAGE || accStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ACC,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_ACC, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/**
 * BattleScript_EffectAttackSpAttackUp, data/battle_scripts_1.s:2142-2165.
 * Raises user's Attack and Special Attack by 1 stage.
 */
function handleAttackSpAtkUp(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE

  if (atkStage < MAX_STAT_STAGE || spAtkStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/**
 * BattleScript_EffectShiftGear, data/battle_scripts_1.s:1988-2017.
 * Raises user's Speed by 2 stages and Attack by 1 stage.
 */
function handleShiftGear(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const speedStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE

  if (speedStage < MAX_STAT_STAGE || atkStage < MAX_STAT_STAGE) {
    // jumpifstat STAT_SPEED > 10 -> BattleScript_ShiftGearSpeedBy1 (:1997, 2001-2003).
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      speedStage > 10 ? 1 : 2,
      STAT_SPEED,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectDragonDance, data/battle_scripts_1.s:6817-6836. */
function handleDragonDance(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE

  if (atkStage < MAX_STAT_STAGE || speStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPEED,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectQuiverDance, data/battle_scripts_1.s:2063-2093. */
function handleQuiverDance(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const spDefStage = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE

  if (spAtkStage < MAX_STAT_STAGE || spDefStage < MAX_STAT_STAGE || speStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPDEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: r2.delta })

    const r3 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPEED,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r3.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: r3.delta })
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectVictoryDance, data/battle_scripts_1.s:2095-2125. */
function handleVictoryDance(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const defStage = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE

  if (atkStage < MAX_STAT_STAGE || defStage < MAX_STAT_STAGE || speStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_DEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_DEF, change: r2.delta })

    const r3 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPEED,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r3.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: r3.delta })
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectMysticDance, data/battle_scripts_1.s:6773-6797. */
function handleMysticDance(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE

  if (spAtkStage < MAX_STAT_STAGE || speStage < MAX_STAT_STAGE) {
    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: r1.delta })

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      STAT_SPEED,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

export const CHLOROPLAST_ABILITIES = [
  'ABILITY_BIG_LEAVES',
  'ABILITY_CHLOROPLAST',
  'ABILITY_SOLAR_FLARE',
] as const

function hasChloroplast(
  state: BattleState,
  battler: BattlerState,
  deps: { dataContext: SimDataContext },
): boolean {
  for (const ab of CHLOROPLAST_ABILITIES) {
    if (battlerHasSimAbility(state, battler, ab, false, battler.id, false, deps.dataContext)) {
      return true
    }
  }
  return false
}

/** BattleScript_EffectGrowth, data/battle_scripts_1.s:1912-1946. */
function handleGrowth(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE

  if (atkStage < MAX_STAT_STAGE || spAtkStage < MAX_STAT_STAGE) {
    // Both checks run twice, once per stat, keeping that order (Finding 3):
    // 1. isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, deps)
    // 2. hasChloroplast (jumpifabilityflag BS_ATTACKER, ABILITY_CHLOROPLAST)
    const inSun1 =
      isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, deps) ||
      hasChloroplast(state, battler, deps)
    const amount1 = inSun1 ? 2 : 1

    const r1 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      amount1,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r1.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: r1.delta })

    const inSun2 =
      isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, deps) ||
      hasChloroplast(state, battler, deps)
    const amount2 = inSun2 ? 2 : 1

    const r2 = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      amount2,
      STAT_SPATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: r2.delta })
  }

  return outcome(ctx, { statChanges })
}

export const CUTTHROAT_ABILITIES = [
  'ABILITY_CUTTHROAT',
  'ABILITY_EDGELORD',
] as const

function hasCutthroat(
  state: BattleState,
  battler: BattlerState,
  deps: { dataContext: SimDataContext },
): boolean {
  for (const ab of CUTTHROAT_ABILITIES) {
    if (battlerHasSimAbility(state, battler, ab, false, battler.id, false, deps.dataContext)) {
      return true
    }
  }
  return false
}

/** BattleScript_EffectSharpen, data/battle_scripts_1.s:12008-12046. */
function handleSharpen(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const highestStat = getHighestAttackingStatId(state, battlerId, deps.statStageRatios)
  const r = changeStatBuffs(
    state,
    battlerId,
    battlerId,
    battlerId,
    1,
    highestStat,
    MOVE_EFFECT_AFFECTS_USER,
    false,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )

  if (r.delta !== 0) {
    statChanges.push({ battlerId, stat: highestStat, change: r.delta })
    // increasecrit BS_ATTACKER, 1, BattleScript_MoveEnd
    // VARIOUS_INCREASE_CRIT: min(3 - critBoost, increase). If increase <= 0, jumps to MoveEnd: NO Cutthroat!
    const increase = Math.min(3 - battler.volatiles.critBoost, 1)
    if (increase > 0) {
      battler.volatiles.critBoost += increase
      if (
        !hasFlag(battler.statuses4, STATUS4_CUTTHROAT) &&
        hasCutthroat(state, battler, deps)
      ) {
        battler.statuses4 |= STATUS4_CUTTHROAT
      }
    }
  } else {
    // BattleScript_EffectSharpen_CritOnly
    // increasecrit BS_ATTACKER, 1, BattleScript_EffectSharpen_CutthroatOnly
    const increase = Math.min(3 - battler.volatiles.critBoost, 1)
    if (increase > 0) {
      battler.volatiles.critBoost += increase
      if (
        !hasFlag(battler.statuses4, STATUS4_CUTTHROAT) &&
        hasCutthroat(state, battler, deps)
      ) {
        battler.statuses4 |= STATUS4_CUTTHROAT
      }
    } else {
      // BattleScript_EffectSharpen_CutthroatOnly
      if (
        !hasFlag(battler.statuses4, STATUS4_CUTTHROAT) &&
        hasCutthroat(state, battler, deps)
      ) {
        battler.statuses4 |= STATUS4_CUTTHROAT
      }
    }
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectShelter, data/battle_scripts_1.s:11940-11977. */
function handleShelter(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const defStage = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE

  // In singles, partner is absent, so if defStage == MAX_STAT_STAGE, it fails.
  if (defStage < MAX_STAT_STAGE) {
    const r = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      2,
      STAT_DEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r.delta !== 0) statChanges.push({ battlerId, stat: STAT_DEF, change: r.delta })
  }

  return outcome(ctx, { statChanges })
}

/**
 * BattleScript_EffectGearUp (data/battle_scripts_1.s:1212-1241).
 * If Speed < MAX_STAT_STAGE or SpAtk < MAX_STAT_STAGE:
 * - Speed +2 (or +1 if Speed stage > 10)
 * - SpAtk +1
 * If both are already at MAX_STAT_STAGE, jumps to BattleScript_CantRaiseMultipleStats (fails).
 */
function handleGearUp(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
  const spaStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE

  if (speStage >= MAX_STAT_STAGE && spaStage >= MAX_STAT_STAGE) {
    return outcome(ctx, { missed: true, statChanges: [] })
  }

  const speBoost = speStage > 10 ? 1 : 2
  const rSpe = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    speBoost,
    STAT_SPEED,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (rSpe.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: rSpe.delta })

  const rSpa = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_SPATK,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (rSpa.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: rSpa.delta })

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectShellSmash, data/battle_scripts_1.s:1800-1846. */
function handleShellSmash(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []

  const battler = state.battlers[battlerId]!
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
  const defStage = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  const spDefStage = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE

  const canWork =
    atkStage < MAX_STAT_STAGE ||
    spAtkStage < MAX_STAT_STAGE ||
    speStage < MAX_STAT_STAGE ||
    defStage > MIN_STAT_STAGE ||
    spDefStage > MIN_STAT_STAGE

  if (canWork) {
    const rDef = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      -1,
      STAT_DEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR | MOVE_EFFECT_CERTAIN,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (rDef.delta !== 0) statChanges.push({ battlerId, stat: STAT_DEF, change: rDef.delta })

    const rSpDef = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      -1,
      STAT_SPDEF,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR | MOVE_EFFECT_CERTAIN,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (rSpDef.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: rSpDef.delta })

    const rAtk = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      2,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (rAtk.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: rAtk.delta })

    const rSpAtk = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      2,
      STAT_SPATK,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (rSpAtk.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: rSpAtk.delta })

    const rSpe = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      2,
      STAT_SPEED,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (rSpe.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: rSpe.delta })
  }

  return outcome(ctx, { statChanges })
}

/** BattleScript_EffectBellyDrum, data/battle_scripts_1.s:5592-5604, src/battle_script_commands.c:11338-11354. */
function handleBellyDrum(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp, applyDamage } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  const statChanges: StatChangeOutcome[] = []
  let attackerDamage: number | null = null
  const fainted: number[] = []

  const battler = state.battlers[battlerId]!
  const halfHp = Math.max(1, Math.floor(battler.mon.maxHp / 2))

  if (battler.mon.hp > halfHp) {
    const r = changeStatBuffs(
      state,
      battlerId,
      battlerId,
      battlerId,
      12,
      STAT_ATK,
      MOVE_EFFECT_AFFECTS_USER,
      false,
      deps,
      unmodelled,
      action.chosenMove!.id,
    )
    if (r.delta !== 0) {
      statChanges.push({ battlerId, stat: STAT_ATK, change: r.delta })
      attackerDamage = halfHp
      applyDamage(state, battlerId, halfHp, fainted)
    }
  }

  return outcome(ctx, { statChanges, attackerDamage, fainted })
}

/**
 * EFFECT_SLEEP handler (Hypnosis, Sleep Powder, Dark Void).
 * BattleScript_EffectSleep, data/battle_scripts_1.s:3103-3113.
 */
function handleSleep(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id

  // 1. ppreduce (:3106)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // Powder immunity is CANCELLER_POWDER_MOVE (battle_util.c:3455), before the script -- see attackCanceller.ts.

  // 2. requirecandoeffect BS_TARGET, MOVE_EFFECT_SLEEP (:3107, VARIOUS_REQUIRE_CAN_DO_EFFECT :8509-8520).
  // Every reason CanSleep can fail is caught by a fail branch; Substitute is only checked there
  // (JumpIfStandardStatusBlocking :6600) once CanSleep has failed, so a Substitute alone does not stop
  // the accuracy draw -- SetMoveEffect's own DoesSubstituteBlockMove blocks the status afterwards.
  if (!canSleep(state, targetId, battlerId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 4. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:3108)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 5. setmoveeffect MOVE_EFFECT_SLEEP, seteffectprimary (:3111-3112)
  const res = applyPrimaryStatusEffect(
    state,
    battlerId,
    targetId,
    MOVE_EFFECT_SLEEP,
    moveId,
    deps,
    unmodelled,
    true,
    false,
  )

  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'SLEEP' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_TOXIC handler (Toxic).
 * BattleScript_EffectToxic, data/battle_scripts_1.s:3957-3970.
 */
function handleToxic(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id

  // 1. ppreduce (:3960)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. requirecandoeffect BS_TARGET, MOVE_EFFECT_TOXIC (:3961, VARIOUS_REQUIRE_CAN_DO_EFFECT :8540-8548).
  // Substitute only matters here once CanBePoisoned has failed (see handleSleep).
  if (!canBePoisoned(state, battlerId, targetId, moveId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:3962)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. setmoveeffect MOVE_EFFECT_TOXIC, seteffectprimary (:3965-3966)
  const res = applyPrimaryStatusEffect(
    state,
    battlerId,
    targetId,
    MOVE_EFFECT_TOXIC,
    moveId,
    deps,
    unmodelled,
    true,
    false,
  )

  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'TOXIC' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_POISON handler (Poison Powder).
 * BattleScript_EffectPoison, data/battle_scripts_1.s:4332-4344.
 */
function handlePoison(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id

  // 1. ppreduce (:4335)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. requirecandoeffect BS_TARGET, MOVE_EFFECT_POISON (:4336, battle_script_commands.c:8544-8552)
  if (!canBePoisoned(state, battlerId, targetId, moveId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:4337)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. setmoveeffect MOVE_EFFECT_POISON, seteffectprimary (:4340-4341)
  const res = applyPrimaryStatusEffect(
    state,
    battlerId,
    targetId,
    MOVE_EFFECT_POISON,
    moveId,
    deps,
    unmodelled,
    true,
    false,
  )

  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'POISON' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_FROSTBITE handler (Flash Freeze).
 * BattleScript_EffectFrostbite, data/battle_scripts_1.s:3127-3138.
 */
function handleFrostbite(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id

  // 1. ppreduce (:3130)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. requirecandoeffect BS_TARGET, MOVE_EFFECT_FROSTBITE (:3131, battle_script_commands.c:8534-8542)
  if (!canGetFrostbite(state, targetId, battlerId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:3132)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. jumpifsafeguard BattleScript_SafeguardProtected (:3133)
  const targetSide = targetId & 1
  if (hasFlag(state.sides[targetSide].statuses, SIDE_STATUS_SAFEGUARD)) {
    return outcome(ctx, { targetId })
  }

  // 5. setmoveeffect MOVE_EFFECT_FROSTBITE, seteffectprimary (:3136-3137)
  const res = applyPrimaryStatusEffect(
    state,
    battlerId,
    targetId,
    MOVE_EFFECT_FROSTBITE,
    moveId,
    deps,
    unmodelled,
    true,
    false,
  )

  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'FROSTBITE' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_BLEED handler (Blood Shot).
 * BattleScript_EffectBleed, data/battle_scripts_1.s:3115-3125.
 */
function handleBleed(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id

  // 1. ppreduce (:3118)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. requirecandoeffect BS_TARGET, MOVE_EFFECT_BLEED (:3119, battle_script_commands.c:8522-8533)
  if (!canBleed(state, targetId, battlerId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:3120)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. setmoveeffect MOVE_EFFECT_BLEED, seteffectprimary (:3123-3124)
  const res = applyPrimaryStatusEffect(
    state,
    battlerId,
    targetId,
    MOVE_EFFECT_BLEED,
    moveId,
    deps,
    unmodelled,
    true,
    false,
  )

  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'BLEED' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_WILL_O_WISP handler (Will-O-Wisp).
 * BattleScript_EffectWillOWisp, data/battle_scripts_1.s:6090-6103.
 */
function handleWillOWisp(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id

  // 1. ppreduce (:6093)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. jumpifsubstituteblocks BattleScript_ButItFailed (:6094)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId })
  }

  // 3. requirecandoeffect BS_TARGET, MOVE_EFFECT_BURN (:6095)
  if (!canBeBurned(state, targetId, battlerId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 4. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:6096)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 5. jumpifsafeguard BattleScript_SafeguardProtected (:6097)
  const targetSide = targetId & 1
  if (hasFlag(state.sides[targetSide].statuses, SIDE_STATUS_SAFEGUARD)) {
    return outcome(ctx, { targetId })
  }

  // 6. setmoveeffect MOVE_EFFECT_BURN, seteffectprimary (:6100-6101)
  const res = applyPrimaryStatusEffect(
    state,
    battlerId,
    targetId,
    MOVE_EFFECT_BURN,
    moveId,
    deps,
    unmodelled,
    true,
    false,
  )

  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'BURN' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_PARALYZE handler (Thunder Wave).
 * BattleScript_EffectParalyze, data/battle_scripts_1.s:4362-4376.
 */
function handleParalyze(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. ppreduce (:4365)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. typecalc (:4366, src/battle_script_commands.c:1617-1624, src/battle_util.c:7985-7996, 7899-7913)
  // Thunder Wave is Electric-type. Electric against Ground type has 0x effectiveness,
  // setting MOVE_RESULT_DOESNT_AFFECT_FOE which causes accuracycheck (:4369)
  // via JumpIfMoveFailed (:1213) to jump to BattleScript_ButItFailed without rolling accuracy.
  const moveType = (deps.dataContext.move(moveId)?.type ?? 'TYPE_ELECTRIC').replace(/^TYPE_/, '')
  if (moveType === 'ELECTRIC' && target.mon.types.includes('GROUND')) {
    return outcome(ctx, { targetId })
  }

  // 3. requirecandoeffect BS_TARGET, MOVE_EFFECT_PARALYSIS | MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES (:4367, battle_script_commands.c:8553-8558)
  // Checks status1, Safeguard, Misty Terrain, and ability status immunities (Limber, etc.).
  if (!canBeParalyzedIgnoreType(state, battlerId, targetId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 4. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:4369)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 5. setmoveeffect MOVE_EFFECT_PARALYSIS, seteffectprimary (:4372-4373, battle_script_commands.c:2474-2499)
  const res = applyPrimaryStatusEffect(
    state,
    battlerId,
    targetId,
    MOVE_EFFECT_PARALYSIS,
    moveId,
    deps,
    unmodelled,
    true,
    false,
  )

  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'PARALYSIS' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_PARALYZE_IGNORE_TYPE handler (Glare, Stun Spore).
 * BattleScript_EffectParalyzeIgnoreType, data/battle_scripts_1.s:4346-4360.
 */
function handleParalyzeIgnoreType(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id

  // 1. ppreduce (:4349)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. requirecandoeffect BS_TARGET, MOVE_EFFECT_PARALYSIS | MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES (:4350)
  // Glare / Stun Spore omits typecalc, so Ground typing does not block the move.
  if (!canBeParalyzedIgnoreType(state, battlerId, targetId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:4352)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. setmoveeffect MOVE_EFFECT_PARALYSIS | MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES, seteffectprimary (:4356-4357)
  const res = applyPrimaryStatusEffect(
    state,
    battlerId,
    targetId,
    MOVE_EFFECT_PARALYSIS | MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES,
    moveId,
    deps,
    unmodelled,
    true,
    false,
  )

  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'PARALYSIS' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_YAWN handler (Yawn).
 * BattleScript_EffectYawn, data/battle_scripts_1.s:6411-6422.
 */
function handleYawn(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. ppreduce (:6414)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. requirecandoeffect BS_TARGET, MOVE_EFFECT_SLEEP (:6415). Substitute only matters once CanSleep has
  // failed (see handleSleep), and Cmd_setyawn (:11840-11855) never checks it, so Yawn goes through one.
  if (!canSleep(state, targetId, battlerId, deps)) {
    return outcome(ctx, { targetId })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:6416)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. setyawn BattleScript_ButItFailed (:6417, Cmd_setyawn at battle_script_commands.c:11840-11855)
  if (
    hasFlag(target.statuses3, STATUS3_YAWN) ||
    hasFlag(target.mon.status1, STATUS1_ANY) ||
    isBattlerTerrainAffected(state, targetId, STATUS_FIELD_ELECTRIC_TERRAIN, deps) ||
    isBattlerTerrainAffected(state, targetId, STATUS_FIELD_MISTY_TERRAIN, deps)
  ) {
    return outcome(ctx, { targetId })
  }

  target.statuses3 = setCounter(target.statuses3, STATUS3_YAWN, 2)
  return outcome(ctx, { targetId, statusApplied: { battlerId: targetId, status: 'YAWN' } })
}

/**
 * EFFECT_SWAGGER handler (Swagger).
 * BattleScript_EffectSwagger, data/battle_scripts_1.s:5134-5154.
 */
function handleSwagger(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. jumpifsubstituteblocks BattleScript_MakeMoveMissed (:5136)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:5137)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 3. ppreduce (:5139)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. jumpifenragedandstatmaxed STAT_ATK, BattleScript_ButItFailed (:5140)
  const isEnraged = hasFlag(target.mon.status2, STATUS2_ENRAGED)
  const isAtkMaxed = (target.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE) >= MAX_STAT_STAGE
  if (isEnraged && isAtkMaxed) {
    return outcome(ctx, { targetId })
  }

  // 5. Stat change: target's Attack raised +2 (:5143-5149)
  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    2,
    STAT_ATK,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: res.delta })
  }

  // 6. BattleScript_SwaggerTryConfuse: setmoveeffect MOVE_EFFECT_ENRAGE (:5151)
  let statusApplied: StatusAppliedOutcome | null = null
  if (!hasFlag(target.mon.status2, STATUS2_ENRAGED)) {
    target.mon.status2 = setFlag(target.mon.status2, STATUS2_ENRAGED)
    const slot = findAbilitySlot(target.mon.abilities, 'ABILITY_MENTAL_POLLUTION')
    if (slot >= 0) {
      target.volatiles.abilityState[slot] = 1
    }
    statusApplied = { battlerId: targetId, status: 'ENRAGED' }
  }

  return outcome(ctx, { targetId, statChanges, statusApplied })
}

/**
 * JumpIfStandardStatusBlocking, src/battle_script_commands.c:6593-6616 -- the fail branches
 * VARIOUS_REQUIRE_CAN_DO_EFFECT (:8583-8588 for confusion) takes only after CanBeConfused has
 * failed. When none applies the script carries on to its accuracycheck, so an already-confused
 * target with no status1 still draws accuracy and SetMoveEffect then does nothing.
 */
function isStandardStatusBlocking(ctx: MoveEffectContext, targetId: number, check: StatusCheck): boolean {
  const { state, battlerId, action, deps, unmodelled } = ctx
  const target = state.battlers[targetId]!
  if (target.mon.status1) return true
  if (doesSubstituteBlockMove(state, battlerId, targetId, action.chosenMove!.id, deps, unmodelled)) return true
  if (isBattlerTerrainAffected(state, targetId, STATUS_FIELD_MISTY_TERRAIN, deps)) return true
  if (hasFlag(state.sides[targetId & 1].statuses, SIDE_STATUS_SAFEGUARD)) return true
  return isAbilityStatusProtected(state, targetId, check, battlerId, deps) !== null
}

/** requirecandoeffect BS_TARGET, MOVE_EFFECT_CONFUSION: true when the script jumps away. */
function confusionBlocked(ctx: MoveEffectContext, targetId: number): boolean {
  return !canBeConfused(ctx.state, targetId, ctx.battlerId, ctx.deps) && isStandardStatusBlocking(ctx, targetId, CHECK_CONFUSION)
}

/**
 * EFFECT_CONFUSE handler (Confuse Ray, Supersonic).
 * BattleScript_EffectConfuse, data/battle_scripts_1.s:4219-4231.
 */
function handleConfuse(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id

  // ppreduce (:4222), requirecandoeffect (:4223), accuracycheck BattleScript_ButItFailed (:4224)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
  if (confusionBlocked(ctx, targetId)) return outcome(ctx, { targetId })
  if (checkAccuracy(ctx, targetId, moveId)) return outcome(ctx, { targetId, missed: true })

  // setmoveeffect MOVE_EFFECT_CONFUSION, seteffectprimary (:4227-4228)
  const res = applyPrimaryStatusEffect(state, battlerId, targetId, MOVE_EFFECT_CONFUSION, moveId, deps, unmodelled, true, false)
  const statusApplied: StatusAppliedOutcome | null = res.applied ? { battlerId: targetId, status: 'CONFUSION' } : null
  return outcome(ctx, { targetId, statusApplied })
}

/** SetMoveEffect MOVE_EFFECT_ATTRACT (battle_script_commands.c:2727-2731) after its preamble's
 * fainted-battler and substitute exits (:2364-2387). */
function setAttractMoveEffect(ctx: MoveEffectContext, targetId: number): boolean {
  const { state, battlerId, action, deps, unmodelled } = ctx
  const target = state.battlers[targetId]!
  if (target.mon.hp === 0) return false
  if (doesSubstituteBlockMove(state, battlerId, targetId, action.chosenMove!.id, deps, unmodelled)) return false
  if (!canInfatuate(state, battlerId, targetId, deps)) return false
  target.mon.status2 = setFlag(target.mon.status2, statusInfatuatedWith(battlerId))
  return true
}

/**
 * EFFECT_SWEET_KISS handler (Sweet Kiss).
 * BattleScript_EffectSweetKiss, data/battle_scripts_1.s:4202-4216. The script tests confusion and
 * accuracy BEFORE its ppreduce, so a miss (BattleScript_ButItFailed) costs no PP. A blocked
 * confusion takes requirecandoeffect's afterPtr, BattleScript_EffectAttract, which is all of Attract.
 */
function handleSweetKiss(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id

  if (confusionBlocked(ctx, targetId)) return handleAttract(ctx)
  if (checkAccuracy(ctx, targetId, moveId)) return outcome(ctx, { targetId, missed: true })
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  let statusApplied: StatusAppliedOutcome | null = null
  const conf = applyPrimaryStatusEffect(state, battlerId, targetId, MOVE_EFFECT_CONFUSION, moveId, deps, unmodelled, true, false)
  if (conf.applied) statusApplied = { battlerId: targetId, status: 'CONFUSION' }
  if (setAttractMoveEffect(ctx, targetId) && !statusApplied) statusApplied = { battlerId: targetId, status: 'INFATUATION' }
  return outcome(ctx, { targetId, statusApplied })
}

/**
 * EFFECT_FLATTER handler (Flatter).
 * BattleScript_EffectFlatter, data/battle_scripts_1.s:6069-6088.
 */
function handleFlatter(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. jumpifsubstituteblocks BattleScript_MakeMoveMissed (:6071)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:6072)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 3. ppreduce (:6074)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. jumpifenragedandstatmaxed STAT_SPATK, BattleScript_ButItFailed (:6075)
  const isEnraged = hasFlag(target.mon.status2, STATUS2_ENRAGED)
  const isSpAtkMaxed = (target.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE) >= MAX_STAT_STAGE
  if (isEnraged && isSpAtkMaxed) {
    return outcome(ctx, { targetId })
  }

  // 5. Stat change: target's SpAtk raised +1 (:6078-6084)
  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    1,
    STAT_SPATK,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: STAT_SPATK, change: res.delta })
  }

  // 6. BattleScript_FlatterTryConfuse: setmoveeffect MOVE_EFFECT_ENRAGE (:6086)
  let statusApplied: StatusAppliedOutcome | null = null
  if (!hasFlag(target.mon.status2, STATUS2_ENRAGED)) {
    target.mon.status2 = setFlag(target.mon.status2, STATUS2_ENRAGED)
    const slot = findAbilitySlot(target.mon.abilities, 'ABILITY_MENTAL_POLLUTION')
    if (slot >= 0) {
      target.volatiles.abilityState[slot] = 1
    }
    statusApplied = { battlerId: targetId, status: 'ENRAGED' }
  }

  return outcome(ctx, { targetId, statChanges, statusApplied })
}

/**
 * EFFECT_TEETER_DANCE handler (Teeter Dance).
 * BattleScript_EffectTeeterDance, data/battle_scripts_1.s:6544-6566: every battler but the user,
 * in id order; a blocked confusion skips to the next battler, a fainted one is skipped, and a
 * miss goes to BattleScript_TeeterDanceMissed.
 */
function handleTeeterDance(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  let statusApplied: StatusAppliedOutcome | null = null
  for (let tId = 0; tId < state.battlersCount; tId++) {
    if (tId === battlerId || !state.battlers[tId]) continue
    if (confusionBlocked(ctx, tId)) continue
    if (state.battlers[tId]!.mon.hp === 0) continue
    if (checkAccuracy(ctx, tId, moveId)) continue
    const res = applyPrimaryStatusEffect(state, battlerId, tId, MOVE_EFFECT_CONFUSION, moveId, deps, unmodelled, true, false)
    if (res.applied && !statusApplied) statusApplied = { battlerId: tId, status: 'CONFUSION' }
  }
  return outcome(ctx, { targetId: targetId ?? battlerId, statusApplied })
}

/**
 * EFFECT_ATTRACT handler (Attract).
 * BattleScript_EffectAttract, data/battle_scripts_1.s:5224-5236. ER has no gender requirement:
 * tryinfatuating (battle_script_commands.c:10419-10429) only asks CanInfatuate (battle_util.c:5135-5143).
 */
function handleAttract(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!
  const attacker = state.battlers[battlerId]!

  // ppreduce (:5227), accuracycheck (:5228), jumpifabilitystatusimmunity + tryinfatuating (:5229-5230)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
  if (checkAccuracy(ctx, targetId, moveId)) return outcome(ctx, { targetId, missed: true })
  if (!canInfatuate(state, battlerId, targetId, deps)) return outcome(ctx, { targetId })
  target.mon.status2 = setFlag(target.mon.status2, statusInfatuatedWith(battlerId))

  // BattleScript_TryDestinyKnotAttacker (:5212-5222): infatuatewithbattler with no CanInfatuate check.
  if (deps.grounding.holdEffectOf(targetId) === 'HOLD_EFFECT_DESTINY_KNOT') {
    attacker.mon.status2 = setFlag(attacker.mon.status2, statusInfatuatedWith(targetId))
  }
  return outcome(ctx, { targetId, statusApplied: { battlerId: targetId, status: 'INFATUATION' } })
}

/** sProtectSuccessRates, src/battle_script_commands.c:727 */
export const PROTECT_SUCCESS_RATES = [65535, 32767, 16383, 8191]

/**
 * Port of BattleScript_EffectProtect / BattleScript_EffectEndure,
 * data/battle_scripts_1.s:5034-5046, Cmd_setprotectlike (src/battle_script_commands.c:9161-9205),
 * and ProtectSucceeds (:6649-6655).
 */
export function handleProtect(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp, order, turnOrderIndex } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // Cmd_ppreduce runs before setprotectlike in BattleScript_ProtectLikeAtkString (data/battle_scripts_1.s:5038-5040)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // ProtectSucceeds, battle_script_commands.c:6649-6655
  // If last resulting move is not a protection move (moves.json flag `isProtection`), reset protectUses to 0
  const lastMoveId = battler.lastMove
  const lastMoveData = lastMoveId ? deps.dataContext.move(lastMoveId) : undefined
  if (!lastMoveData?.flags?.isProtection) {
    battler.volatiles.protectUses = 0
  }

  let protectSucceeds = false
  if (battler.volatiles.protectUses <= 3) {
    // :6653 -- `sProtectSuccessRates[protectUses] >= Random()`
    // Compares against the whole Random() 16-bit draw, NOT % 100.
    const threshold = PROTECT_SUCCESS_RATES[battler.volatiles.protectUses]!
    const roll = state.rng.random16()
    if (threshold >= roll) {
      protectSucceeds = true
    }
  }

  // Cmd_setprotectlike, :9161-9205
  // :9165 -- if (gCurrentTurnActionNumber == (gBattlersCount - 1)) notLastTurn = FALSE;
  const isLastMover = order ? turnOrderIndex === order.battlerByTurnOrder.length - 1 : false
  const notLastTurn = !isLastMover

  let fail = true
  if (protectSucceeds && notLastTurn) {
    // :9168 -- if (!gBattleMoves[gCurrentMove].argument) Protects one mon only.
    // Wide Guard, Crafty Shield, Mat Block protect the whole side.
    if (moveId === 'MOVE_WIDE_GUARD') {
      const side = battlerId & 1
      if (!(state.sides[side].statuses & SIDE_STATUS_WIDE_GUARD)) {
        state.sides[side].statuses |= SIDE_STATUS_WIDE_GUARD
        battler.volatiles.protectUses++
        fail = false
      }
    } else if (moveId === 'MOVE_CRAFTY_SHIELD') {
      const side = battlerId & 1
      if (!(state.sides[side].statuses & SIDE_STATUS_CRAFTY_SHIELD)) {
        state.sides[side].statuses |= SIDE_STATUS_CRAFTY_SHIELD
        battler.volatiles.protectUses++
        fail = false
      }
    } else if (moveId === 'MOVE_MAT_BLOCK') {
      const side = battlerId & 1
      if (!(state.sides[side].statuses & SIDE_STATUS_MAT_BLOCK)) {
        state.sides[side].statuses |= SIDE_STATUS_MAT_BLOCK
        // Mat Block does not increment protectUses in C (:9194)
        fail = false
      }
    } else {
      if (moveEffect === 'EFFECT_ENDURE') {
        battler.round.endured = true
      } else {
        battler.round.protectMove = moveId
      }
      battler.volatiles.protectUses++
      fail = false
    }
  }

  if (fail) {
    // :9200 -- gVolatileStructs[gBattlerAttacker].protectUses = 0;
    battler.volatiles.protectUses = 0
    battler.lastMove = moveId
    return outcome(ctx, { missed: true })
  }

  battler.lastMove = moveId
  return outcome(ctx, { missed: false })
}

/**
 * Abilities with bitfields.unaware = "TRUE" in data/v2.65beta/abilityHooks.json
 * (IsUnaware, battle_util.c:9006-9009).
 */
const UNAWARE_ABILITIES: readonly string[] = [
  'ABILITY_CONTEMPT',
  'ABILITY_LEPIDOPTERAN',
  'ABILITY_SWORD_OF_DAMNATION',
  'ABILITY_UNAWARE',
]

/** healthbarupdate + datahpupdate for a heal (battle_script_commands.c:1908-1911). */
function healBattler(state: BattleState, battlerId: number, battler: BattlerState, heal: number): void {
  battler.mon.hp = Math.min(battler.mon.maxHp, battler.mon.hp + heal)
  syncPartyHp(state, battlerId)
}

/**
 * BattleScript_EffectRestoreHp (data/battle_scripts_1.s:3940-3955),
 * BattleScript_EffectSoftboiled (:5909-5924) and BattleScript_EffectRoost
 * (:2736-2742), all through Cmd_tryhealhalfhealth (battle_script_commands.c:
 * 9255-9274). Roost has no jumpifhealingblocked, so a heal-blocked Roost does
 * not fail: tryhealhalfhealth just zeroes the heal. A bleeding user always
 * reaches BattleScript_MoveUsedBleedHeal (:156), whose curestatus
 * (VARIOUS_CURE_STATUS, :7685-7689) clears all of status1 instead of healing.
 */
function handleHealHalf(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, action.chosenMove!.id, moveEffect, unmodelled)

  if (moveEffect !== 'EFFECT_ROOST' && isHealingBlocked(state, battlerId, battler, unmodelled)) {
    return outcome(ctx, { targetId: battlerId })
  }

  let heal = 0
  if (canBattlerHeal(state, battlerId, battler, unmodelled)) {
    if (battler.mon.hp === battler.mon.maxHp) return outcome(ctx, { targetId: battlerId })
    heal = Math.trunc(battler.mon.maxHp / 2)
    if (heal === 0) heal = 1
  }

  if (moveEffect === 'EFFECT_ROOST') {
    // Cmd_setroost (battle_script_commands.c:4022-4047)
    // The sim spells a mono type as [X, 'MYSTERY', ...] where the C has type1 == type2,
    // so the pure-Flying test accepts either. Only type1/type2 are saved or rewritten;
    // a Flying type3 alone matches no branch and ENDTURN_ROOST restores whatever
    // roostTypes already held, as in the C.
    battler.resourceFlags = setFlag(battler.resourceFlags ?? 0, RESOURCE_FLAG_ROOST)
    const [t1, t2, t3] = battler.mon.types
    if (t1 === 'FLYING' && (t2 === 'FLYING' || t2 === 'MYSTERY')) {
      battler.roostTypes = ['FLYING', 'FLYING']
      battler.mon.types = ['NORMAL', 'NORMAL', 'MYSTERY'] // SET_BATTLER_TYPE(.., TYPE_NORMAL)
    } else if (t1 === 'FLYING' || t2 === 'FLYING') {
      battler.roostTypes = [t1, t2]
      battler.mon.types = [t1 === 'FLYING' ? 'MYSTERY' : t1, t2 === 'FLYING' ? 'MYSTERY' : t2, t3]
    } else if (t3 !== 'FLYING') {
      battler.roostTypes = [t1, t2]
    }
  }

  if (hasFlag(battler.mon.status1, STATUS1_BLEED)) {
    battler.mon.status1 = 0
    return outcome(ctx, { targetId: battlerId })
  }

  healBattler(state, battlerId, battler, heal)
  return outcome(ctx, { targetId: battlerId })
}

/**
 * BattleScript_EffectMorningSun / Synthesis / Moonlight / ShoreUp (data/
 * battle_scripts_1.s:5495-5503) -> Cmd_recoverbasedonsunlight (battle_script_
 * commands.c:11433-11460) -> BattleScript_PresentHealTarget (:5915-5924).
 * Neither command checks CanBattlerHeal, so Heal Block does not stop these.
 */
function handleWeatherRecovery(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // :11435-11437 -- bleed first, then PresentHealTarget's jumpifstatus cures it.
  if (hasFlag(battler.mon.status1, STATUS1_BLEED)) {
    battler.mon.status1 = 0
    return outcome(ctx, { targetId: battlerId })
  }
  if (battler.mon.hp === battler.mon.maxHp) return outcome(ctx, { targetId: battlerId })

  const maxHp = battler.mon.maxHp
  let heal: number
  if (moveId === 'MOVE_SHORE_UP') {
    heal = isBattlerWeatherAffected(state, battlerId, WEATHER_SANDSTORM_ANY, deps) ? Math.trunc((2 * maxHp) / 3) : Math.trunc(maxHp / 2)
  } else if (
    moveId === 'MOVE_MOONLIGHT' &&
    battlerHasSimAbility(state, battler, 'ABILITY_MOON_SPIRIT', false, battlerId, false, deps.dataContext)
  ) {
    heal = Math.trunc((maxHp * 3) / 4)
  } else if (isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, deps) || hasChloroplast(state, battler, deps)) {
    heal = Math.trunc((maxHp * 2) / 3)
  } else if (
    isBattlerWeatherAffected(state, battlerId, WEATHER_RAIN_ANY | WEATHER_SANDSTORM_ANY | WEATHER_FOG_ANY | WEATHER_HAIL_ANY, deps)
  ) {
    heal = Math.trunc(maxHp / 4)
  } else {
    heal = Math.trunc(maxHp / 2)
  }
  if (heal === 0) heal = 1

  healBattler(state, battlerId, battler, heal)
  return outcome(ctx, { targetId: battlerId })
}

/**
 * BattleScript_EffectJungleHealing (data/battle_scripts_1.s:773-804),
 * singles only: VARIOUS_JUMP_IF_TEAM_HEALTHY (battle_script_commands.c:
 * 7883-7895) and VARIOUS_TRY_HEAL_PERCENT_HP (:7896-7907). Life Dew skips the
 * status cure (:791).
 */
function handleJungleHealing(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  if (battler.mon.hp === battler.mon.maxHp && !(battler.mon.status1 & STATUS1_ANY)) {
    return outcome(ctx, { targetId: battlerId })
  }

  if (battler.mon.hp !== battler.mon.maxHp && canBattlerHeal(state, battlerId, battler, unmodelled)) {
    let heal = Math.trunc((battler.mon.maxHp * 25) / 100)
    if (heal === 0) heal = 1
    healBattler(state, battlerId, battler, heal)
  }

  if (moveId !== 'MOVE_LIFE_DEW' && (battler.mon.status1 & STATUS1_ANY) !== 0) {
    battler.mon.status1 = 0
  }

  return outcome(ctx, { targetId: battlerId })
}

/**
 * BattleScript_EffectPainSplit (data/battle_scripts_1.s:4691-4707).
 *
 * `accuracycheck ..., NO_ACC_CALC_CHECK_LOCK_ON` (battle_script_commands.c:
 * 1403-1411) draws no RNG: Lock-On passes, a semi-invulnerable target fails,
 * and otherwise JumpIfMoveAffectedByProtect(0) runs IsBattlerProtected with
 * move 0 (MOVE_NONE) -- not Pain Split. The Commander branch (:1404) needs a
 * doubles ally and is unreachable in singles.
 */
function handlePainSplit(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp, turnOrderIndex, order } = ctx
  const battler = state.battlers[battlerId]!
  if (targetId === null) return outcome(ctx, { targetId: null })
  const target = state.battlers[targetId]
  if (!target) return outcome(ctx, { targetId })
  const moveId = action.chosenMove!.id
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  const lockedOn = hasFlag(target.statuses3, STATUS3_ALWAYS_HITS) && target.volatiles.battlerWithSureHit === battlerId
  if (!lockedOn) {
    if (hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)) return outcome(ctx, { targetId })
    const targetIndex = order ? order.battlerByTurnOrder.indexOf(targetId) : -1
    const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < turnOrderIndex
    const protectType = isBattlerProtected(state, battlerId, targetId, 'MOVE_NONE', targetHasActedThisTurn, deps, unmodelled)
    if ((protectType & ProtectType.PROTECT_BLOCK) !== 0) return outcome(ctx, { targetId, missed: true })
  }

  // Cmd_painsplitdmgcalc, :10765-10786
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId })
  }
  const hpDiff = Math.trunc((battler.mon.hp + target.mon.hp) / 2)
  battler.mon.hp = Math.min(battler.mon.maxHp, hpDiff)
  target.mon.hp = Math.min(target.mon.maxHp, hpDiff)
  syncPartyHp(state, battlerId)
  syncPartyHp(state, targetId)

  return outcome(ctx, { targetId })
}

/**
 * BattleScript_EffectStrengthSap (data/battle_scripts_1.s:896-942).
 *
 * The heal amount is VARIOUS_GET_STAT_VALUE (battle_script_commands.c:
 * 6809-6811): CalculateStat(target, STAT_ATK, 0, MOVE_NONE, ...) with the
 * USER's Unaware. Two script quirks are kept: when the user is at full HP,
 * heal-blocked or bleeding, the drop goes through BattleScript_StrengthSapMustLower,
 * whose success path still reaches BattleScript_StrengthSapHp and heals
 * (datahpupdate, :1908-1911, has no heal-block check); and on the ordinary path
 * a blocked drop jumps straight to StrengthSapHp and heals anyway.
 * ChangeStatBuffs never sets B_MSG_STAT_FELL_EMPTY, so the script's checks for
 * it never fire.
 */
function handleStrengthSap(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  if (targetId === null) return outcome(ctx, { targetId: null })
  const target = state.battlers[targetId]
  if (!target) return outcome(ctx, { targetId })
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId })
  }
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { targetId, missed: true })

  const statChanges: StatChangeOutcome[] = []
  const lowerAttack = (): number => {
    const res = changeStatBuffsImplicit(state, battlerId, targetId, -1, STAT_ATK, STAT_BUFF_ALLOW_PTR, true, deps, unmodelled, moveId)
    if (res.delta !== 0) statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: res.delta })
    if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
      dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
    }
    return res.delta
  }

  // :903-908
  if ((target.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE) === MIN_STAT_STAGE) {
    lowerAttack()
    return outcome(ctx, { targetId, statChanges })
  }

  // :910
  if (hasFlag(target.mon.status1, STATUS1_BURN)) {
    unmodelled.push("Strength Sap's CalculateStat burn halving does not check IgnoresBurnAtkDrop (battle_util.c:7138)")
  }
  unmodelled.push(
    "Strength Sap's CalculateStat (battle_util.c:7105-7217) applies no onStat ability hooks and ignores Wonder Room",
  )
  const userIsUnaware = UNAWARE_ABILITIES.some((ab) =>
    battlerHasSimAbility(state, battler, ab, false, battlerId, false, deps.dataContext),
  )
  let statValue = calculateBattleStat({
    rawStat: target.mon.rawStats.atk,
    extraStatLevel: target.volatiles.extraAttackLevel ?? 0,
    statStage: target.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE,
    isUnaware: userIsUnaware,
    isWonderRoomActive: false,
    isOffensiveStatForWonderRoom: true,
    isCrit: false,
    isAttackRole: true,
    benefitsFromStatBuffs: benefitsFromStatBuffs(state, targetId),
    preModify: attackPreModify({
      violentRush: !!target.volatiles.violentRush,
      showdownMode: !!target.volatiles.showdownMode,
      readiedAction: !!target.volatiles.readiedAction,
      isBurned: hasFlag(target.mon.status1, STATUS1_BURN),
    }),
    applyOnStatHooks: (s) => s,
    secondaryStatPercent: 0,
    statStageRatios: deps.statStageRatios,
  })

  const mustLower =
    battler.mon.hp === battler.mon.maxHp ||
    isHealingBlocked(state, battlerId, battler, unmodelled) ||
    hasFlag(battler.mon.status1, STATUS1_BLEED)
  const lowered = lowerAttack() !== 0
  if (mustLower && !lowered) return outcome(ctx, { targetId, statChanges })

  // BattleScript_StrengthSapHp, :928-934 -- manipulatedamage DMG_BIG_ROOT (GetDrainedBigRootHp, battle_util.c:2369-2376)
  if (battler.mon.hp === battler.mon.maxHp) return outcome(ctx, { targetId, statChanges })
  if (statValue === 0) statValue = 1
  const holdEffect = battler.mon.itemId ? deps.dataContext.item(battler.mon.itemId)?.resolvedHoldEffect : null
  if (holdEffect === 'HOLD_EFFECT_BIG_ROOT') statValue = Math.trunc((statValue * 3) / 2)
  if (battlerHasSimAbility(state, battler, 'ABILITY_ABSORBANT', false, battlerId, false, deps.dataContext)) {
    statValue = Math.trunc((statValue * 3) / 2)
  }
  healBattler(state, battlerId, battler, statValue)

  return outcome(ctx, { targetId, statChanges })
}

/**
 * BattleScript_EffectLeechSeed (data/battle_scripts_1.s:4579-4592) and
 * Cmd_setseeded (battle_script_commands.c:9341-9355). A missed accuracy check
 * still runs setseeded, which then fails on MOVE_RESULT_NO_EFFECT.
 */
function handleLeechSeed(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null) return outcome(ctx, { targetId: null })
  const target = state.battlers[targetId]
  if (!target) return outcome(ctx, { targetId })
  const moveId = action.chosenMove!.id
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId })
  }
  if (checkAccuracy(ctx, targetId, moveId)) return outcome(ctx, { targetId, missed: true })

  if (hasFlag(target.statuses3, STATUS3_LEECHSEED) || target.mon.types.includes('GRASS')) {
    return outcome(ctx, { targetId, missed: true })
  }
  target.statuses3 |= battlerId | STATUS3_LEECHSEED

  return outcome(ctx, { targetId })
}

const TYPE_NAME_TO_ID: Record<string, number> = {
  TYPE_NORMAL: 0,
  TYPE_FIGHTING: 1,
  TYPE_FLYING: 2,
  TYPE_POISON: 3,
  TYPE_GROUND: 4,
  TYPE_ROCK: 5,
  TYPE_BUG: 6,
  TYPE_GHOST: 7,
  TYPE_STEEL: 8,
  TYPE_MYSTERY: 9,
  TYPE_FIRE: 10,
  TYPE_WATER: 11,
  TYPE_GRASS: 12,
  TYPE_ELECTRIC: 13,
  TYPE_PSYCHIC: 14,
  TYPE_ICE: 15,
  TYPE_DRAGON: 16,
  TYPE_DARK: 17,
  TYPE_FAIRY: 18,
  TYPE_STELLAR: 19,
}

function getMoveTypeNumber(moveType: string | null | undefined): number {
  if (!moveType) return 5
  const key = moveType.startsWith('TYPE_') ? moveType : `TYPE_${moveType}`
  return TYPE_NAME_TO_ID[key] ?? 5
}

/** GetBattlerHoldEffect(battler, TRUE) -- grounding.holdEffectOf already applies Klutz/Embargo. */
function getHoldEffect(ctx: MoveEffectContext, battlerId: number): string | null {
  return ctx.deps.grounding.holdEffectOf(battlerId)
}

/**
 * BattleScript_EffectReflect (data/battle_scripts_1.s:4320-4330) and
 * Cmd_setreflect (src/battle_script_commands.c:9319-9339).
 */
function handleReflect(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const side = battlerId & 1
  const sideState = state.sides[side]!
  const hasReflect = hasFlag(sideState.statuses, SIDE_STATUS_REFLECT)
  const hasScreenCleaner = battlerHasSimAbility(state, battler, 'ABILITY_SCREEN_CLEANER', false, battlerId, false, deps.dataContext)

  if (hasReflect && !hasScreenCleaner) {
    return outcome(ctx, { missed: true })
  }

  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_REFLECT)
  sideState.timers.started.reflect = true
  sideState.timers.reflectBattlerId = battlerId

  const isExtended = getHoldEffect(ctx, battlerId) === 'HOLD_EFFECT_LIGHT_CLAY'
  sideState.timers.reflectTimer = isExtended ? 8 : 5

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectLightScreen (data/battle_scripts_1.s:4016-4021) and
 * Cmd_setlightscreen (src/battle_script_commands.c:10252-10273).
 */
function handleLightScreen(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const side = battlerId & 1
  const sideState = state.sides[side]!
  const hasLightScreen = hasFlag(sideState.statuses, SIDE_STATUS_LIGHTSCREEN)
  const hasScreenCleaner = battlerHasSimAbility(state, battler, 'ABILITY_SCREEN_CLEANER', false, battlerId, false, deps.dataContext)

  if (hasLightScreen && !hasScreenCleaner) {
    return outcome(ctx, { missed: true })
  }

  sideState.timers.started.lightscreen = true
  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_LIGHTSCREEN)
  sideState.timers.lightscreenBattlerId = battlerId

  const isExtended = getHoldEffect(ctx, battlerId) === 'HOLD_EFFECT_LIGHT_CLAY'
  sideState.timers.lightscreenTimer = isExtended ? 8 : 5

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectAuroraVeil (data/battle_scripts_1.s:3985-3990) and
 * VARIOUS_SET_AURORA_VEIL (src/battle_script_commands.c:7749-7767).
 */
function handleAuroraVeil(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const side = battlerId & 1
  const sideState = state.sides[side]!
  const hasAuroraVeil = hasFlag(sideState.statuses, SIDE_STATUS_AURORA_VEIL)
  const hasScreenCleaner = battlerHasSimAbility(state, battler, 'ABILITY_SCREEN_CLEANER', false, battlerId, false, deps.dataContext)
  const isHail = isBattlerWeatherAffected(state, battlerId, WEATHER_HAIL_ANY, deps)
  const hasAuroraBorealis = battlerHasSimAbility(state, battler, 'ABILITY_AURORA_BOREALIS', false, battlerId, false, deps.dataContext)

  if ((hasAuroraVeil && !hasScreenCleaner) || (!isHail && !hasAuroraBorealis)) {
    return outcome(ctx, { missed: true })
  }

  sideState.timers.started.auroraVeil = true
  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_AURORA_VEIL)
  sideState.timers.auroraVeilBattlerId = battlerId

  const isExtended = getHoldEffect(ctx, battlerId) === 'HOLD_EFFECT_LIGHT_CLAY'
  sideState.timers.auroraVeilTimer = isExtended ? 8 : 5

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectBarrier (data/battle_scripts_1.s:3992-4014),
 * Cmd_setlightscreen (src/battle_script_commands.c:10252-10273) and
 * Cmd_setreflect (src/battle_script_commands.c:9319-9339).
 * The script has no ppreduce, so Barrier never spends PP. A failed setlightscreen's
 * MOVE_RESULT_MISSED is cleared by bichalfword; a failed setreflect sets it either way,
 * so the move counts as missed exactly when Reflect fails.
 */
function handleBarrier(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, deps } = ctx
  const battler = state.battlers[battlerId]!

  if (!hasFlag(state.field.statuses, STATUS_FIELD_PSYCHIC_TERRAIN)) {
    return outcome(ctx, { missed: true })
  }

  const side = battlerId & 1
  const sideState = state.sides[side]!
  const hasScreenCleaner = battlerHasSimAbility(state, battler, 'ABILITY_SCREEN_CLEANER', false, battlerId, false, deps.dataContext)
  const isExtended = getHoldEffect(ctx, battlerId) === 'HOLD_EFFECT_LIGHT_CLAY'
  const timer = isExtended ? 8 : 5

  const hasLightScreen = hasFlag(sideState.statuses, SIDE_STATUS_LIGHTSCREEN)
  const hasReflect = hasFlag(sideState.statuses, SIDE_STATUS_REFLECT)

  const lightScreenFailed = hasLightScreen && !hasScreenCleaner
  const reflectFailed = hasReflect && !hasScreenCleaner

  if (!lightScreenFailed) {
    sideState.timers.started.lightscreen = true
    sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_LIGHTSCREEN)
    sideState.timers.lightscreenBattlerId = battlerId
    sideState.timers.lightscreenTimer = timer
  }

  if (!reflectFailed) {
    sideState.timers.started.reflect = true
    sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_REFLECT)
    sideState.timers.reflectBattlerId = battlerId
    sideState.timers.reflectTimer = timer
  }

  return outcome(ctx, reflectFailed ? { missed: true } : {})
}

/**
 * BattleScript_EffectMist (data/battle_scripts_1.s:4179-4188) and
 * Cmd_setmist (src/battle_script_commands.c:10456-10469).
 */
function handleMist(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const side = battlerId & 1
  const sideState = state.sides[side]!

  if (sideState.timers.mistTimer !== 0) {
    return outcome(ctx, {})
  }

  sideState.timers.started.mist = true
  sideState.timers.mistTimer = 5
  sideState.timers.mistBattlerId = battlerId
  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_MIST)

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectSafeguard (data/battle_scripts_1.s:5246-5252) and
 * Cmd_setsafeguard (src/battle_script_commands.c:11234-11248).
 */
function handleSafeguard(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const side = battlerId & 1
  const sideState = state.sides[side]!

  if (hasFlag(sideState.statuses, SIDE_STATUS_SAFEGUARD)) {
    return outcome(ctx, { missed: true })
  }

  sideState.timers.started.safeguard = true
  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_SAFEGUARD)
  sideState.timers.safeguardTimer = 5
  sideState.timers.safeguardBattlerId = battlerId

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectTailwind (data/battle_scripts_1.s:2693-2704) and
 * Cmd_settailwind (src/battle_script_commands.c:10961-10973).
 */
function handleTailwind(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const side = battlerId & 1
  if (!trySetTailwind(state, side, battlerId, 3)) {
    return outcome(ctx, {})
  }

  // BattleScript_OnTailwindStart (data/battle_scripts_1.s:9266-9296): callifability is
  // jumpifability -> BATTLER_HAS_ABILITY (mold breaker checked, no alive check).
  // raisehighestattackingstat (VARIOUS_RAISE_HIGHEST_ATTACKING_STAT, battle_script_
  // commands.c:8159-8170) passes BS_ptr 0; setcharge (:11620-11623) sets STATUS3_CHARGED_UP.
  const attackerHasMB = attackerHasMoldBreakerActive(state.battlers[battlerId]!, deps)
  for (const bId of [battlerId, battlerId ^ 2]) {
    const b = state.battlers[bId]
    if (!b) continue
    if (battlerHasSimAbility(state, b, 'ABILITY_WIND_RIDER', true, battlerId, attackerHasMB, deps.dataContext)) {
      const statId = getHighestAttackingStatId(state, bId, deps.statStageRatios)
      changeStatBuffs(state, bId, battlerId, battlerId, 1, statId, MOVE_EFFECT_AFFECTS_USER, false, deps, unmodelled, moveId)
    }
    if (
      battlerHasSimAbility(state, b, 'ABILITY_WIND_POWER', true, battlerId, attackerHasMB, deps.dataContext) &&
      !hasFlag(b.statuses3, STATUS3_CHARGED_UP)
    ) {
      b.statuses3 = setFlag(b.statuses3, STATUS3_CHARGED_UP)
    }
  }

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectSpikes (data/battle_scripts_1.s:5058-5067) and
 * Cmd_trysetspikes (src/battle_script_commands.c:11115-11125).
 */
function handleSpikes(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const targetSide = (battlerId & 1) ^ 1
  const sideState = state.sides[targetSide]!

  if (sideState.timers.spikesAmount >= 3) {
    return outcome(ctx, {})
  }

  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_SPIKES)
  sideState.timers.spikesAmount++

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectStealthRock (data/battle_scripts_1.s:2559-2569) and
 * Cmd_setstealthrock (src/battle_script_commands.c:11979-11989).
 */
function handleStealthRock(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const targetSide = (battlerId & 1) ^ 1
  const sideState = state.sides[targetSide]!

  if (hasFlag(sideState.statuses, SIDE_STATUS_STEALTH_ROCK)) {
    return outcome(ctx, {})
  }

  const moveData = deps.dataContext.move(moveId)
  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_STEALTH_ROCK)
  sideState.timers.stealthRockType = getMoveTypeNumber(moveData?.type)

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectToxicSpikes (data/battle_scripts_1.s:2616-2626) and
 * Cmd_settoxicspikes (src/battle_script_commands.c:11820-11829).
 */
function handleToxicSpikes(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const targetSide = (battlerId & 1) ^ 1
  const sideState = state.sides[targetSide]!

  if (sideState.timers.toxicSpikesAmount >= 2) {
    return outcome(ctx, {})
  }

  sideState.timers.toxicSpikesAmount++
  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_TOXIC_SPIKES)

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectStickyWeb (data/battle_scripts_1.s:2570-2580) and
 * Cmd_setstickyweb (src/battle_script_commands.c:11462-11472).
 */
function handleStickyWeb(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const targetSide = (battlerId & 1) ^ 1
  if (!trySetStickyWeb(state, targetSide, 0, false)) {
    return outcome(ctx, {})
  }

  unmodelled.push(
    'Cmd_setstickyweb (battle_script_commands.c:11469): gBattleStruct->stickyWebUser is not modelled in BattleState',
  )

  return outcome(ctx, {})
}

/**
 * WEATHER_DURATION (8) and WEATHER_DURATION_EXTENDED (12) -- include/battle_util.h:50-51.
 * Note: while the brief mentioned "(5, and the extending hold effect...)", upstream C
 * explicitly defines WEATHER_DURATION as 8 and WEATHER_DURATION_EXTENDED as 12.
 */
export { WEATHER_DURATION, WEATHER_DURATION_EXTENDED } from './constants'

/**
 * Common implementation for weather moves:
 * - Macro checkprimalweather (battle_script.inc:2511-2526): fails if gBattleWeather has WEATHER_PRIMAL_ANY.
 * - Cmd_various VARIOUS_SET_WEATHER (src/battle_script_commands.c:8634-8644).
 * - TryChangeBattleWeather (src/battle_util.c:3721-3743) via tryChangeBattleWeather.
 * - VARIOUS_ON_WEATHER_CHANGE (src/battle_script_commands.c:8183-8190) / BattleScript_OnWeatherChange
 *   (data/battle_scripts_1.s:9833-9841): gaps onWeather ability hook when weather changes.
 */
function applyWeatherMove(
  ctx: MoveEffectContext,
  weatherEnum: number,
): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const changed = tryChangeBattleWeather(state, battlerId, weatherEnum, false, deps)
  if (changed) {
    dispatchOnWeatherChange(state, deps, unmodelled)
  }

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectRainDance (data/battle_scripts_1.s:5505-5511),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_RAIN (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleRainDance(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(ctx, ENUM_WEATHER_RAIN)
}

/**
 * BattleScript_EffectSunnyDay (data/battle_scripts_1.s:5520-5527),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_SUN (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleSunnyDay(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(ctx, ENUM_WEATHER_SUN)
}

/**
 * BattleScript_EffectSandstorm (data/battle_scripts_1.s:5117-5123),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_SANDSTORM (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleSandstorm(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(ctx, ENUM_WEATHER_SANDSTORM)
}

/**
 * BattleScript_EffectHail (data/battle_scripts_1.s:6048-6055),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_HAIL (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleHail(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(ctx, ENUM_WEATHER_HAIL)
}

/**
 * BattleScript_EffectEerieFog (data/battle_scripts_1.s:12406-12413),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_FOG (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleEerieFog(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(ctx, ENUM_WEATHER_FOG)
}

/** Abilities with an onTerrain hook (abilityHooks.json), run by BattleScript_OnTerrainChanged
 * (data/battle_scripts_1.s:9947-9955, VARIOUS_ON_TERRAIN_CHANGE) -- not ported. */
const ON_TERRAIN_ABILITIES = [
  'ABILITY_DRAKELP_HEAD', 'ABILITY_ENERGIZED', 'ABILITY_GENERATOR', 'ABILITY_HARUKAZE',
  'ABILITY_MIMICRY', 'ABILITY_QUARK_DRIVE', 'ABILITY_TOXIC_BOOST',
]

/**
 * Terrain moves: BattleScript_EffectElectricTerrain and its aliases (data/battle_scripts_1.s:2192-2206)
 * -> setterrain -> HandleTerrainMove (src/battle_script_commands.c:6404-6463). Unlike
 * TryChangeBattleTerrain it fails only when the same terrain is already up -- a permanent
 * terrain is replaced. EFFECT_TOXIC_TERRAIN shares the Misty script; HandleTerrainMove picks
 * the terrain from the move effect.
 */
function applyTerrainMove(ctx: MoveEffectContext, terrainFlag: number): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  deductPp(state, battlerId, action.chosenMove!.id, action.chosenMove!.effect, unmodelled)
  if (hasFlag(state.field.statuses, terrainFlag)) return outcome(ctx, { missed: true })

  state.field.statuses = setFlag(clearFlag(state.field.statuses, STATUS_FIELD_TERRAIN_ANY), terrainFlag)
  state.field.timers.started.terrain = true
  state.field.timers.terrainBattlerId = battlerId
  state.field.timers.terrainTimer =
    deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_TERRAIN_EXTENDER' ? TERRAIN_DURATION_EXTENDED : TERRAIN_DURATION

  for (let i = 0; i < state.battlersCount; i++) {
    const b = state.battlers[i]
    const held = b && ON_TERRAIN_ABILITIES.find((id) => battlerHasSimAbility(state, b, id, false, i, false, deps.dataContext))
    if (held) unmodelled.push(`battler ${i}: ${held}'s onTerrain reaction (BattleScript_OnTerrainChanged, battle_scripts_1.s:9947-9955) is not applied`)
  }
  return outcome(ctx, {})
}

function handleElectricTerrain(ctx: MoveEffectContext): ActionOutcome {
  return applyTerrainMove(ctx, STATUS_FIELD_ELECTRIC_TERRAIN)
}

function handleGrassyTerrain(ctx: MoveEffectContext): ActionOutcome {
  return applyTerrainMove(ctx, STATUS_FIELD_GRASSY_TERRAIN)
}

function handleMistyTerrain(ctx: MoveEffectContext): ActionOutcome {
  return applyTerrainMove(ctx, STATUS_FIELD_MISTY_TERRAIN)
}

function handlePsychicTerrain(ctx: MoveEffectContext): ActionOutcome {
  return applyTerrainMove(ctx, STATUS_FIELD_PSYCHIC_TERRAIN)
}

function handleToxicTerrain(ctx: MoveEffectContext): ActionOutcome {
  return applyTerrainMove(ctx, STATUS_FIELD_TOXIC_TERRAIN)
}

/**
 * Common handler for room-setting moves.
 * BattleScript_EffectTrickRoom (data/battle_scripts_1.s:2638-2655),
 * BattleScript_EffectInverseRoom / BattleScript_EffectWonderRoom / BattleScript_EffectMagicRoom (:2657-2667),
 * Cmd_setroom / HandleRoomMove (src/battle_script_commands.c:11866-11921).
 */
function handleRoomMove(
  ctx: MoveEffectContext,
  statusFlag: number,
  duration: number,
  startedKey: 'trickRoom' | 'wonderRoom' | 'magicRoom' | 'inverseRoom',
  timerKey: 'trickRoomTimer' | 'wonderRoomTimer' | 'magicRoomTimer' | 'inverseRoomTimer',
): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // Permanent room check: if active and timer > 10, fails (BattleScript_ButItFailed).
  if (hasFlag(state.field.statuses, statusFlag) && state.field.timers[timerKey] > 10) {
    return outcome(ctx, { missed: true })
  }

  if (hasFlag(state.field.statuses, statusFlag)) {
    // Toggles off: gFieldStatuses &= ~statusFlag; *timer = 0
    state.field.statuses = clearFlag(state.field.statuses, statusFlag)
    state.field.timers[timerKey] = 0
    state.field.timers.started[startedKey] = true
  } else {
    // Toggles on: gFieldStatuses |= statusFlag; *timer = duration
    state.field.statuses = setFlag(state.field.statuses, statusFlag)
    state.field.timers[timerKey] = duration
    state.field.timers.started[startedKey] = true
  }

  return outcome(ctx, {})
}

function handleTrickRoom(ctx: MoveEffectContext): ActionOutcome {
  const { state, deps, unmodelled } = ctx
  const res = handleRoomMove(ctx, STATUS_FIELD_TRICK_ROOM, TRICK_ROOM_DURATION, 'trickRoom', 'trickRoomTimer')
  if (hasFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM)) {
    for (let i = 0; i < state.battlersCount; i++) {
      if (deps.grounding.holdEffectOf(i) === 'HOLD_EFFECT_ROOM_SERVICE') {
        unmodelled.push(`battler ${i}: Room Service (tryroomservice, battle_scripts_1.s:2647-2652) is not applied`)
      }
    }
  }
  return res
}

function handleWonderRoom(ctx: MoveEffectContext): ActionOutcome {
  return handleRoomMove(ctx, STATUS_FIELD_WONDER_ROOM, WONDER_ROOM_DURATION, 'wonderRoom', 'wonderRoomTimer')
}

function handleMagicRoom(ctx: MoveEffectContext): ActionOutcome {
  return handleRoomMove(ctx, STATUS_FIELD_MAGIC_ROOM, MAGIC_ROOM_DURATION, 'magicRoom', 'magicRoomTimer')
}

function handleInverseRoom(ctx: MoveEffectContext): ActionOutcome {
  return handleRoomMove(ctx, STATUS_FIELD_INVERSE_ROOM, INVERSE_ROOM_DURATION, 'inverseRoom', 'inverseRoomTimer')
}

/**
 * BattleScript_EffectGravity (data/battle_scripts_1.s:2713-2734),
 * Cmd_setgravity (src/battle_script_commands.c:6004-6013),
 * VARIOUS_GRAVITY_ON_AIRBORNE_MONS (src/battle_script_commands.c:6887-6891).
 */
function handleGravity(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (hasFlag(state.field.statuses, STATUS_FIELD_GRAVITY)) {
    return outcome(ctx, { missed: true })
  }

  state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_GRAVITY)
  state.field.timers.started.gravity = true
  state.field.timers.gravityTimer = GRAVITY_DURATION

  // BattleScript_GravityLoop / VARIOUS_GRAVITY_ON_AIRBORNE_MONS
  for (let i = 0; i < state.battlersCount; i++) {
    const battler = state.battlers[i]
    if (!battler || battler.mon.hp === 0) continue
    if (hasFlag(battler.statuses3, STATUS3_ON_AIR | STATUS3_MAGNET_RISE | STATUS3_TELEKINESIS)) {
      if (hasFlag(battler.statuses3, STATUS3_ON_AIR)) {
        cancelMultiTurnMoves(battler)
      }
      battler.statuses3 = clearFlag(
        battler.statuses3,
        STATUS3_ON_AIR | STATUS3_MAGNET_RISE | STATUS3_TELEKINESIS,
      )
    }
  }

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectHaze (data/battle_scripts_1.s:3723-3733),
 * Cmd_normalisebuffs (src/battle_script_commands.c:9988-9995),
 * TryResetBattlerStatChanges (src/battle_script_commands.c:9957-9986).
 */
function handleHaze(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  for (let i = 0; i < state.battlersCount; i++) {
    tryResetBattlerStatChanges(state, i, RESET_ALL_STATS)
  }

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectClearSkies (data/battle_scripts_1.s:12453-12463),
 * trysetclearskies -> VARIOUS_SET_CLEAR_SKIES (src/battle_script_commands.c:8683-8691),
 * BattleScript_OnWeatherChange (data/battle_scripts_1.s:9833-9841).
 */
function handleClearSkies(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (state.field.timers.clearSkiesTimer > 0) {
    return outcome(ctx, { missed: true })
  }

  state.field.timers.clearSkiesTimer = 5
  state.field.timers.started.clearSkiesTimer = true
  dispatchOnWeatherChange(state, deps, unmodelled)

  return outcome(ctx, {})
}

/**
 * ClearDefogHazards(battler, FALSE), src/battle_script_commands.c:6506-6560.
 * Checks whether Defog can clear any hazards, screens, or fog.
 */
function canDefogClear(state: BattleState, attackerId: number): boolean {
  const attackerSide = attackerId & 1
  for (let i = 0; i < 2; i++) {
    const side = state.sides[i]
    if (!side) continue
    if (i !== attackerSide) {
      if (
        hasFlag(side.statuses, SIDE_STATUS_REFLECT) ||
        hasFlag(side.statuses, SIDE_STATUS_LIGHTSCREEN) ||
        hasFlag(side.statuses, SIDE_STATUS_MIST) ||
        hasFlag(side.statuses, SIDE_STATUS_AURORA_VEIL) ||
        hasFlag(side.statuses, SIDE_STATUS_SAFEGUARD)
      ) {
        return true
      }
    }
    if (
      hasFlag(side.statuses, SIDE_STATUS_SPIKES) ||
      hasFlag(side.statuses, SIDE_STATUS_STEALTH_ROCK) ||
      hasFlag(side.statuses, SIDE_STATUS_TOXIC_SPIKES) ||
      (!side.timers.foamyWeb && hasFlag(side.statuses, SIDE_STATUS_STICKY_WEB)) ||
      side.timers.caltrops ||
      side.timers.hotCoals
    ) {
      return true
    }
  }
  if (hasFlag(state.field.weather, WEATHER_FOG_ANY)) {
    return true
  }
  return false
}

/**
 * ClearDefogHazards(battler, TRUE), src/battle_script_commands.c:6506-6560. Each call clears one
 * thing and VARIOUS_DEFOG (:7599-7610) re-runs it until it returns FALSE, so everything goes. The
 * Smokescreen line tests SIDE_STATUS_LIGHTSCREEN (:6519), already cleared by then, so Smokescreen
 * stays. DEFOG_CLEAR (:6493-6504) zeroes the timer field only, never `started`.
 */
function clearDefog(
  state: BattleState,
  attackerId: number,
  deps: MoveEffectContext['deps'],
  unmodelled: string[],
): void {
  const attackerSide = attackerId & 1
  for (let i = 0; i < 2; i++) {
    const side = state.sides[i]
    if (!side) continue
    if (i !== attackerSide) {
      if (hasFlag(side.statuses, SIDE_STATUS_REFLECT)) {
        side.statuses = clearFlag(side.statuses, SIDE_STATUS_REFLECT)
        side.timers.reflectTimer = 0
      }
      if (hasFlag(side.statuses, SIDE_STATUS_LIGHTSCREEN)) {
        side.statuses = clearFlag(side.statuses, SIDE_STATUS_LIGHTSCREEN)
        side.timers.lightscreenTimer = 0
      }
      if (hasFlag(side.statuses, SIDE_STATUS_MIST)) {
        side.statuses = clearFlag(side.statuses, SIDE_STATUS_MIST)
        side.timers.mistTimer = 0
      }
      if (hasFlag(side.statuses, SIDE_STATUS_AURORA_VEIL)) {
        side.statuses = clearFlag(side.statuses, SIDE_STATUS_AURORA_VEIL)
        side.timers.auroraVeilTimer = 0
      }
      if (hasFlag(side.statuses, SIDE_STATUS_SAFEGUARD)) {
        side.statuses = clearFlag(side.statuses, SIDE_STATUS_SAFEGUARD)
        side.timers.safeguardTimer = 0
      }
    }
    if (hasFlag(side.statuses, SIDE_STATUS_SPIKES)) {
      side.statuses = clearFlag(side.statuses, SIDE_STATUS_SPIKES)
      side.timers.spikesAmount = 0
    }
    if (hasFlag(side.statuses, SIDE_STATUS_STEALTH_ROCK)) {
      side.statuses = clearFlag(side.statuses, SIDE_STATUS_STEALTH_ROCK)
      side.timers.stealthRockType = 0
    }
    if (hasFlag(side.statuses, SIDE_STATUS_TOXIC_SPIKES)) {
      side.statuses = clearFlag(side.statuses, SIDE_STATUS_TOXIC_SPIKES)
      side.timers.toxicSpikesAmount = 0
    }
    if (!side.timers.foamyWeb && hasFlag(side.statuses, SIDE_STATUS_STICKY_WEB)) {
      side.statuses = clearFlag(side.statuses, SIDE_STATUS_STICKY_WEB)
      side.timers.stickyWebTimer = 0
    }
    if (side.timers.caltrops) {
      side.timers.caltrops = false
    }
    if (side.timers.hotCoals) {
      side.timers.hotCoals = false
    }
  }

  if (hasFlag(state.field.weather, WEATHER_FOG_ANY)) {
    if (hasFlag(state.field.weather, WEATHER_FOG_PERMANENT)) {
      state.field.timers.fogReturnTimer = 99
    } else {
      state.field.timers.fogReturnTimer = (state.field.weatherDuration - 1) & 0xff // u8
    }
    state.field.weather = clearFlag(state.field.weather, WEATHER_FOG_ANY)
    dispatchOnWeatherChange(state, deps, unmodelled)
  }
}

/**
 * BattleScript_EffectDefog (data/battle_scripts_1.s:1560-1593),
 * VARIOUS_DEFOG / ClearDefogHazards (src/battle_script_commands.c:6506-6560, 7599-7610),
 * BattleScript_FogBlownAway (data/battle_scripts_1.s:7385-7389).
 */
function handleDefog(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. Check if substitute blocks or evasion is at MIN_STAT_STAGE (0)
  const subBlocks = doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)
  const evsAtMin = (target.mon.statStages[STAT_EVASION] ?? DEFAULT_STAT_STAGE) <= MIN_STAT_STAGE

  if ((subBlocks || evsAtMin) && !canDefogClear(state, battlerId)) {
    // BattleScript_DefogIfCanClearHazards -> defogclear FALSE BattleScript_ButItFailedAtkStringPpReduce
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. Accuracy check (BattleScript_DefogWorks -> accuracycheck BattleScript_PrintMoveMissed)
  if (checkAccuracy(ctx, targetId, moveId)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. Move hits and deducts PP
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 4. statbuffchange STAT_BUFF_ALLOW_PTR (:1571) -- no substitute gate here: a substitute only
  // routed the script through defogclear FALSE above, and ChangeStatBuffs never checks one.
  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(state, battlerId, targetId, -1, STAT_EVASION, STAT_BUFF_ALLOW_PTR, true, deps, unmodelled, moveId)
  if (res.delta !== 0) statChanges.push({ battlerId: targetId, stat: STAT_EVASION, change: res.delta })
  if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
    dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
  }

  // 5. Clear hazards, screens, and fog
  clearDefog(state, battlerId, deps, unmodelled)

  return outcome(ctx, {
    targetId,
    statChanges: statChanges.length > 0 ? statChanges : null,
  })
}

/**
 * BattleScript_EffectDragonCheer (data/battle_scripts_1.s:11903-11938),
 * VARIOUS_INCREASE_CRIT (src/battle_script_commands.c:8591-8601), and
 * VARIOUS_JUMP_IF_ABSENT (src/battle_script_commands.c:6769-6772).
 * Raises critical hit stage by 2 if Dragon type, or 1 otherwise (capped at 3).
 * If attacker is already at max critBoost (3), tries to boost partner; in singles
 * partner is absent, so it jumps to BattleScript_ButItFailed.
 */
function handleDragonCheer(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const isAttackerDragon = battler.mon.types.includes('DRAGON')
  const attackerAmount = isAttackerDragon ? 2 : 1
  const attackerIncrease = Math.min(Math.max(0, 3 - battler.volatiles.critBoost), attackerAmount)

  if (attackerIncrease > 0) {
    battler.volatiles.critBoost += attackerIncrease

    // Check partner in doubles
    const partnerId = battlerId ^ 2
    const partner = state.battlers[partnerId]
    if (partner && isBattlerAlive(state, partnerId)) {
      const isPartnerDragon = partner.mon.types.includes('DRAGON')
      const partnerAmount = isPartnerDragon ? 2 : 1
      const partnerIncrease = Math.min(Math.max(0, 3 - partner.volatiles.critBoost), partnerAmount)
      if (partnerIncrease > 0) {
        partner.volatiles.critBoost += partnerIncrease
      }
    }

    return outcome(ctx, {})
  }

  // Attacker already at max critBoost (3): branch to PartnerOnly
  const partnerId = battlerId ^ 2
  const partner = state.battlers[partnerId]
  if (!partner || !isBattlerAlive(state, partnerId)) {
    // Partner absent (singles or partner fainted): fails
    return outcome(ctx, { missed: true })
  }

  const isPartnerDragon = partner.mon.types.includes('DRAGON')
  const partnerAmount = isPartnerDragon ? 2 : 1
  const partnerIncrease = Math.min(Math.max(0, 3 - partner.volatiles.critBoost), partnerAmount)
  partner.volatiles.critBoost += partnerIncrease
  return outcome(ctx, {})
}

/**
 * BattleScript_EffectCurse (data/battle_scripts_1.s:4928-4987).
 * If user is Ghost-type or affected by Fog weather, executes BattleScript_GhostCurse:
 * - Target takes STATUS2_CURSED (fails if already cursed or semi-invulnerable).
 * - Attacker takes maxHp / 2 damage (floored, min 1) and may faint.
 * Otherwise, non-Ghost branch:
 * - Speed -1, Attack +1, Defense +1 (fails if Speed at min and Attack/Defense at max).
 */
function handleCurse(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp, applyDamage, turnOrderIndex, order } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  const isGhost = battler.mon.types.includes('GHOST')
  const isFog = isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps)

  if (isGhost || isFog) {
    // Ghost Curse
    // jumpifbytenotequal gBattlerAttacker, gBattlerTarget / getmovetarget BS_ATTACKER
    const actualTargetId = targetId === null || targetId === battlerId ? battlerId ^ 1 : targetId
    const target = state.battlers[actualTargetId]
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)

    if (!target || !isBattlerAlive(state, actualTargetId)) {
      return outcome(ctx, { targetId: actualTargetId, missed: true })
    }

    // Cmd_accuracycheck NO_ACC_CALC_CHECK_LOCK_ON (battle_script_commands.c:1403-1411); Commander is doubles-only
    const lockedOn = hasFlag(target.statuses3, STATUS3_ALWAYS_HITS) && target.volatiles.battlerWithSureHit === battlerId
    if (!lockedOn) {
      if (hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)) {
        return outcome(ctx, { targetId: actualTargetId, missed: true })
      }
      const targetIndex = order ? order.battlerByTurnOrder.indexOf(actualTargetId) : -1
      const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < turnOrderIndex
      const protectType = isBattlerProtected(state, battlerId, actualTargetId, 'MOVE_NONE', targetHasActedThisTurn, deps, unmodelled)
      if ((protectType & ProtectType.PROTECT_BLOCK) !== 0) {
        return outcome(ctx, { targetId: actualTargetId, missed: true })
      }
    }

    // Cmd_cursetarget (battle_script_commands.c:11103-11113)
    if (hasFlag(target.mon.status2, STATUS2_CURSED)) {
      return outcome(ctx, { targetId: actualTargetId, missed: true })
    }

    target.mon.status2 = setFlag(target.mon.status2, STATUS2_CURSED)
    const hpCost = Math.max(1, Math.floor(battler.mon.maxHp / 2))
    const fainted: number[] = []
    applyDamage(state, battlerId, hpCost, fainted)

    return outcome(ctx, {
      targetId: actualTargetId,
      attackerDamage: hpCost,
      fainted,
    })
  }

  // Non-Ghost Curse
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const defStage = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE

  if (speStage <= MIN_STAT_STAGE && atkStage >= MAX_STAT_STAGE && defStage >= MAX_STAT_STAGE) {
    return outcome(ctx, { missed: true, statChanges: [] })
  }

  const statChanges: StatChangeOutcome[] = []
  const rSpe = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    -1,
    STAT_SPEED,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (rSpe.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: rSpe.delta })

  const rAtk = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_ATK,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (rAtk.delta !== 0) statChanges.push({ battlerId, stat: STAT_ATK, change: rAtk.delta })

  const rDef = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_DEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (rDef.delta !== 0) statChanges.push({ battlerId, stat: STAT_DEF, change: rDef.delta })

  return outcome(ctx, { statChanges })
}

/**
 * BattleScript_EffectDestinyBond (data/battle_scripts_1.s:4785-4793) and
 * Cmd_setdestinybond (src/battle_script_commands.c:10943-10946).
 */
function handleDestinyBond(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  battler.mon.status2 = setFlag(battler.mon.status2, STATUS2_DESTINY_BOND)

  unmodelled.push(
    'Destiny Bond faint trigger on KO (battle_script_commands.c:3244-3251) is not modelled in faint path yet',
  )

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectKarma (data/battle_scripts_1.s:4989-5030).
 * Lowers user's Speed by 1 and raises Special Attack and Special Defense by 1.
 * Fails if Speed is already at minimum and both SpAtk and SpDef are at maximum.
 */
function handleKarma(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const spDefStage = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE

  if (speStage <= MIN_STAT_STAGE && spAtkStage >= MAX_STAT_STAGE && spDefStage >= MAX_STAT_STAGE) {
    return outcome(ctx, { missed: true, statChanges: [] })
  }

  const statChanges: StatChangeOutcome[] = []
  const rSpe = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    -1,
    STAT_SPEED,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (rSpe.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: rSpe.delta })

  const rSpAtk = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_SPATK,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (rSpAtk.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: rSpAtk.delta })

  const rSpDef = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_SPDEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    action.chosenMove!.id,
  )
  if (rSpDef.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: rSpDef.delta })

  return outcome(ctx, { statChanges })
}

/**
 * BattleScript_EffectRecycle (data/battle_scripts_1.s:6363-6371) and
 * Cmd_tryrecycleitem (src/battle_script_commands.c:12296-12311).
 * Restores the mon's last consumed held item if it is currently holding no item.
 * Fails if no item was consumed or if the mon already holds an item.
 */
function handleRecycle(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const usedItem = battler.usedHeldItem
  const currentItem = battler.mon.itemId

  if (usedItem && usedItem !== 'ITEM_NONE' && (!currentItem || currentItem === 'ITEM_NONE')) {
    battler.mon.itemId = usedItem
    battler.usedHeldItem = null
    return outcome(ctx, {})
  }

  return outcome(ctx, { missed: true })
}

/**
 * BattleScript_EffectHelpingHand (data/battle_scripts_1.s:6268-6276) and
 * Cmd_trysethelpinghand (src/battle_script_commands.c:11700-11710).
 * Doubles-only move that buffs partner's damage for the turn (round.helpingHand).
 * Fails in singles, or if partner is fainted/absent, or if user or partner already has helpingHand set.
 */
function handleHelpingHand(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const partnerId = battlerId ^ 2
  const partner = state.battlers[partnerId]

  if (
    (state.battleTypeFlags & BATTLE_TYPE_DOUBLE) !== 0 &&
    partner &&
    !(state.absentBattlerFlags & (1 << partnerId)) &&
    !battler.round.helpingHand &&
    !partner.round.helpingHand
  ) {
    partner.round.helpingHand = true
    return outcome(ctx, {})
  }

  return outcome(ctx, { missed: true })
}

/**
 * EFFECT_TAUNT handler (Taunt).
 * BattleScript_EffectTaunt, data/battle_scripts_1.s:6255-6266.
 * Cmd_settaunt, src/battle_script_commands.c:11678-11698.
 */
function handleTaunt(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. ppreduce (:6258)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. jumpifabilitystatusimmunity BS_TARGET, MOVE_TAUNT (:6259) -> CHECK_RESTRICTING
  if (isAbilityStatusProtected(state, targetId, CHECK_RESTRICTING, battlerId, deps) !== null) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:6260)
  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. settaunt BattleScript_ButItFailed (:6261, Cmd_settaunt:11678-11698)
  const attackerHasMB = attackerHasMoldBreakerActive(state.battlers[battlerId]!, deps)
  if (battlerHasSimAbility(state, target, 'ABILITY_OBLIVIOUS', true, battlerId, attackerHasMB, deps.dataContext)) {
    return outcome(ctx, { targetId, missed: true })
  }
  if (target.volatiles.tauntTimer !== 0) {
    return outcome(ctx, { targetId, missed: true })
  }

  // B_TAUNT_TURNS >= GEN_5: 4 turns, or 3 if target hasn't moved yet this turn (:11684-11686)
  const targetOrder = ctx.order ? ctx.order.battlerByTurnOrder.indexOf(targetId) : -1
  const attackerOrder = ctx.order ? ctx.order.battlerByTurnOrder.indexOf(battlerId) : -1
  const turns = targetOrder > attackerOrder && targetOrder !== -1 && attackerOrder !== -1 ? 3 : 4
  target.volatiles.tauntTimer = turns
  target.volatiles.tauntTimer2 = turns

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_DISABLE handler (Disable).
 * BattleScript_EffectDisable, data/battle_scripts_1.s:4622-4632.
 * Cmd_disablelastusedattack, src/battle_script_commands.c:10706-10737.
 */
function handleDisable(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. ppreduce (:4625)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. jumpifabilitystatusimmunity BS_TARGET, MOVE_DISABLE (:4626) -> CHECK_RESTRICTING
  if (isAbilityStatusProtected(state, targetId, CHECK_RESTRICTING, battlerId, deps) !== null) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:4627)
  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. disablelastusedattack BattleScript_ButItFailed (:4628, DisableLastUsedMove:10714-10737)
  const lastMove = target.lastMove
  const moveIdx = lastMove ? target.mon.moves.indexOf(lastMove) : -1
  if (
    !lastMove ||
    lastMove === 'MOVE_NONE' ||
    target.volatiles.disabledMove !== null ||
    moveIdx === -1 ||
    (target.mon.pp[moveIdx] ?? 0) === 0
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.volatiles.disabledMove = lastMove
  target.volatiles.disableTimer = 4 // B_DISABLE_TURNS == GEN_7
  target.volatiles.disableTimerStartValue = 4

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_ENCORE handler (Encore).
 * BattleScript_EffectEncore, data/battle_scripts_1.s:4678-4689.
 * Cmd_trysetencore / SetEncore, src/battle_script_commands.c:10739-10763.
 */
function handleEncore(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. accuracycheck BattleScript_PrintMoveMissed (:4680); ppreduce (:4682) -- PrintMoveMissed
  // runs its own ppreduce (battle_scripts_1.s:3092-3094), so a miss costs PP too.
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
  if (missed) return outcome(ctx, { targetId, missed: true })

  // 3. jumpifabilitystatusimmunity BS_TARGET, MOVE_ENCORE (:4683) -> CHECK_RESTRICTING
  if (isAbilityStatusProtected(state, targetId, CHECK_RESTRICTING, battlerId, deps) !== null) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. trysetencore BattleScript_ButItFailed (:4684, SetEncore:10739-10758)
  const lastMove = target.lastMove
  if (
    !lastMove ||
    lastMove === 'MOVE_NONE' ||
    lastMove === 'MOVE_STRUGGLE' ||
    lastMove === 'MOVE_ENCORE' ||
    lastMove === 'MOVE_MIRROR_MOVE'
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  const moveIdx = target.mon.moves.indexOf(lastMove)
  if (
    target.volatiles.encoredMove !== null ||
    target.volatiles.encoreTimer !== 0 ||
    moveIdx === -1 ||
    (target.mon.pp[moveIdx] ?? 0) === 0
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.volatiles.encoredMove = lastMove
  target.volatiles.encoredMovePos = moveIdx
  target.volatiles.encoreTimer = 3
  target.volatiles.encoreTimerStartValue = 3

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_TORMENT handler (Torment).
 * BattleScript_EffectTorment, data/battle_scripts_1.s:6056-6067.
 * Cmd_settorment, src/battle_script_commands.c:11662-11669.
 */
function handleTorment(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. ppreduce (:6059)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)

  // 2. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:6060)
  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. jumpifabilitystatusimmunity BS_TARGET, MOVE_TORMENT (:6061) -> CHECK_RESTRICTING
  if (isAbilityStatusProtected(state, targetId, CHECK_RESTRICTING, battlerId, deps) !== null) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. settorment BattleScript_ButItFailed (:6062, Cmd_settorment:11662-11669)
  if (hasFlag(target.mon.status2, STATUS2_TORMENT)) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.mon.status2 = setFlag(target.mon.status2, STATUS2_TORMENT)

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_HEAL_BLOCK handler (Heal Block).
 * BattleScript_EffectHealBlock, data/battle_scripts_1.s:2744-2755.
 * Cmd_sethealblock, src/battle_script_commands.c:4970-4978.
 */
function handleHealBlock(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. accuracycheck BattleScript_PrintMoveMissed (:2746); ppreduce (:2748) -- a miss costs PP too.
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
  if (missed) return outcome(ctx, { targetId, missed: true })

  // 3. jumpifabilitystatusimmunity BS_TARGET, MOVE_HEAL_BLOCK (:2749) -> CHECK_HEAL_BLOCK
  if (isAbilityStatusProtected(state, targetId, CHECK_HEAL_BLOCK, battlerId, deps) !== null) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. sethealblock BattleScript_ButItFailed (:2750, Cmd_sethealblock:4970-4978)
  if (hasFlag(target.statuses3, STATUS3_HEAL_BLOCK)) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.statuses3 = setFlag(target.statuses3, STATUS3_HEAL_BLOCK)
  target.volatiles.healBlockTimer = 5

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_EMBARGO handler (Embargo).
 * BattleScript_EffectEmbargo, data/battle_scripts_1.s:2681-2691.
 * Cmd_setembargo, src/battle_script_commands.c:11190-11198.
 */
function handleEmbargo(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const moveId = action.chosenMove!.id
  const target = state.battlers[targetId]!

  // 1. accuracycheck BattleScript_PrintMoveMissed (:2683); ppreduce (:2685) -- a miss costs PP too.
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, action.chosenMove!.effect, unmodelled)
  if (missed) return outcome(ctx, { targetId, missed: true })

  // 3. setembargo BattleScript_ButItFailed (:2686, Cmd_setembargo:11190-11198)
  if (hasFlag(target.statuses3, STATUS3_EMBARGO)) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.statuses3 = setFlag(target.statuses3, STATUS3_EMBARGO)
  target.volatiles.embargoTimer = 5

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_FOCUS_ENERGY handler (Focus Energy).
 * BattleScript_EffectFocusEnergy, data/battle_scripts_1.s:4190-4200.
 * VARIOUS_INCREASE_CRIT, src/battle_script_commands.c:8591-8601.
 */
function handleFocusEnergy(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:4193)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. increasecrit BS_ATTACKER, 2, BattleScript_ButItFailed (:4194)
  // VARIOUS_INCREASE_CRIT: increase = min(3 - critBoost, 2); if (!increase && ptr) fails.
  const increase = Math.min(Math.max(0, 3 - battler.volatiles.critBoost), 2)
  if (increase <= 0) {
    return outcome(ctx, { missed: true })
  }

  battler.volatiles.critBoost += increase

  return outcome(ctx, {})
}

/**
 * EFFECT_SUBSTITUTE handler.
 * BattleScript_EffectSubstitute, data/battle_scripts_1.s:4506-4530.
 * Cmd_setsubstitute, src/battle_script_commands.c:10535-10550.
 */
function handleSubstitute(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, applyDamage } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:4508)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifstatus2 BS_ATTACKER, STATUS2_SUBSTITUTE, BattleScript_AlreadyHasSubstitute (:4511)
  const battler = state.battlers[battlerId]!
  if (hasFlag(battler.mon.status2, STATUS2_SUBSTITUTE)) {
    return outcome(ctx, { missed: true })
  }

  // 3. setsubstitute (:4512, Cmd_setsubstitute:10535-10550)
  const hp = Math.max(1, Math.floor(battler.mon.maxHp / 4))
  const damage = Math.max(1, Math.floor(battler.mon.maxHp / (moveEffect === 'EFFECT_SHED_TAIL' ? 2 : 4)))

  if (battler.mon.hp <= damage) {
    return outcome(ctx, { missed: true })
  }

  battler.mon.status2 = setFlag(battler.mon.status2, STATUS2_SUBSTITUTE)
  battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_WRAPPED)
  battler.volatiles.substituteHp = hp

  const fainted: number[] = []
  applyDamage(state, battlerId, damage, fainted)

  return outcome(ctx, { attackerDamage: damage, fainted })
}

/**
 * EFFECT_AQUA_RING handler.
 * BattleScript_EffectAquaRing, data/battle_scripts_1.s:2670-2679.
 * Cmd_setuserstatus3, src/battle_script_commands.c:11991-12002.
 */
function handleAquaRing(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:2673)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setuserstatus3 STATUS3_AQUA_RING, BattleScript_ButItFailed (:2674)
  const battler = state.battlers[battlerId]!
  if (hasFlag(battler.statuses3, STATUS3_AQUA_RING)) {
    return outcome(ctx, { missed: true })
  }

  battler.statuses3 = setFlag(battler.statuses3, STATUS3_AQUA_RING)
  return outcome(ctx, {})
}

/**
 * EFFECT_INGRAIN handler.
 * BattleScript_EffectIngrain, data/battle_scripts_1.s:6326-6336.
 * Cmd_setuserstatus3, src/battle_script_commands.c:11991-12002.
 */
function handleIngrain(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:6329)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setuserstatus3 STATUS3_ROOTED, BattleScript_ButItFailed (:6330)
  const battler = state.battlers[battlerId]!
  if (hasFlag(battler.statuses3, STATUS3_ROOTED)) {
    return outcome(ctx, { missed: true })
  }

  battler.statuses3 = setFlag(battler.statuses3, STATUS3_ROOTED)
  return outcome(ctx, {})
}

/**
 * EFFECT_MAGNET_RISE handler.
 * BattleScript_EffectMagnetRise, data/battle_scripts_1.s:2627-2636.
 * Cmd_setuserstatus3, src/battle_script_commands.c:11991-12002.
 */
function handleMagnetRise(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:2630)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setuserstatus3 STATUS3_MAGNET_RISE, BattleScript_ButItFailed (:2631)
  const battler = state.battlers[battlerId]!
  if (hasFlag(battler.statuses3, STATUS3_MAGNET_RISE)) {
    return outcome(ctx, { missed: true })
  }

  battler.statuses3 = setFlag(battler.statuses3, STATUS3_MAGNET_RISE)
  battler.volatiles.magnetRiseTimer = 5
  return outcome(ctx, {})
}

/**
 * EFFECT_CHARGE handler.
 * BattleScript_EffectCharge, data/battle_scripts_1.s:6222-6240.
 * Cmd_setcharge, src/battle_script_commands.c:11620-11623.
 */
function handleCharge(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:6225)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setcharge (:6226)
  const battler = state.battlers[battlerId]!
  battler.statuses3 = setFlag(battler.statuses3, STATUS3_CHARGED_UP)

  // 3. SpDef +1 stat buff (:6229-6231)
  const statChanges: StatChangeOutcome[] = []
  const rSpDef = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_SPDEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (rSpDef.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: rSpDef.delta })

  return outcome(ctx, { statChanges })
}

/**
 * EFFECT_LOCK_ON handler (Lock-On, Mind Reader).
 * BattleScript_EffectLockOn, data/battle_scripts_1.s:4739-4751.
 * Cmd_setalwayshitflag, src/battle_script_commands.c:10827-10832.
 */
function handleLockOn(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:4742)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null) return outcome(ctx, { targetId: null, missed: true })
  const target = state.battlers[targetId]
  if (!target || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. jumpifsubstituteblocks BattleScript_ButItFailed (:4743)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:4744)
  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. setalwayshitflag (:4745, Cmd_setalwayshitflag:10827-10832)
  target.statuses3 = (target.statuses3 & ~STATUS3_ALWAYS_HITS) | STATUS3_ALWAYS_HITS_TURN(2)
  target.volatiles.battlerWithSureHit = battlerId

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_LASER_FOCUS handler.
 * BattleScript_EffectLaserFocus, data/battle_scripts_1.s:1037-1047.
 * Cmd_setuserstatus3, src/battle_script_commands.c:11991-12002.
 */
function handleLaserFocus(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:1040)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setuserstatus3 STATUS3_LASER_FOCUS, BattleScript_ButItFailed (:1041)
  const battler = state.battlers[battlerId]!
  if (hasFlag(battler.statuses3, STATUS3_LASER_FOCUS)) {
    return outcome(ctx, { missed: true })
  }

  battler.statuses3 = setFlag(battler.statuses3, STATUS3_LASER_FOCUS)
  battler.volatiles.laserFocusTimer = 2
  return outcome(ctx, {})
}

/**
 * EFFECT_MEAN_LOOK handler (Mean Look, Block, Spider Web).
 * BattleScript_EffectMeanLook, data/battle_scripts_1.s:4890-4907.
 * Cmd_accuracycheck NO_ACC_CALC_CHECK_LOCK_ON, battle_script_commands.c:1403-1411.
 * Cmd_seteffectprimary / MOVE_EFFECT_PREVENT_ESCAPE, battle_script_commands.c:2823-2826.
 */
function handleMeanLook(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp, deps, turnOrderIndex, order } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:4893)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null) return outcome(ctx, { targetId: null, missed: true })
  const target = state.battlers[targetId]
  if (!target || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. accuracycheck BattleScript_ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:4894)
  const lockedOn = hasFlag(target.statuses3, STATUS3_ALWAYS_HITS) && target.volatiles.battlerWithSureHit === battlerId
  if (!lockedOn) {
    if (hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)) {
      return outcome(ctx, { targetId, missed: true })
    }
    const targetIndex = order ? order.battlerByTurnOrder.indexOf(targetId) : -1
    const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < turnOrderIndex
    const protectType = isBattlerProtected(state, battlerId, targetId, 'MOVE_NONE', targetHasActedThisTurn, deps, unmodelled)
    if ((protectType & ProtectType.PROTECT_BLOCK) !== 0) {
      return outcome(ctx, { targetId, missed: true })
    }
  }

  // 3. jumpifstatus2 BS_TARGET, STATUS2_ESCAPE_PREVENTION (:4896)
  if (hasFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. jumpifsubstituteblocks (:4897)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 5. jumpiftype BS_TARGET, TYPE_GHOST (:4899)
  if (target.mon.types.includes('GHOST')) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 6. setmoveeffect MOVE_EFFECT_PREVENT_ESCAPE / seteffectprimary (:4903-4904)
  target.mon.status2 = setFlag(target.mon.status2, STATUS2_ESCAPE_PREVENTION)
  target.volatiles.battlerPreventingEscape = battlerId

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_FORESIGHT handler (Foresight, Odor Sleuth).
 * BattleScript_EffectForesight, data/battle_scripts_1.s:5069-5082.
 * Cmd_setforesight, src/battle_script_commands.c:11127-11130.
 */
function handleForesight(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp, deps, turnOrderIndex, order } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:5072)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null) return outcome(ctx, { targetId: null, missed: true })
  const target = state.battlers[targetId]
  if (!target || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. accuracycheck BattleScript_ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:5073)
  const lockedOn = hasFlag(target.statuses3, STATUS3_ALWAYS_HITS) && target.volatiles.battlerWithSureHit === battlerId
  if (!lockedOn) {
    if (hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)) {
      return outcome(ctx, { targetId, missed: true })
    }
    const targetIndex = order ? order.battlerByTurnOrder.indexOf(targetId) : -1
    const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < turnOrderIndex
    const protectType = isBattlerProtected(state, battlerId, targetId, 'MOVE_NONE', targetHasActedThisTurn, deps, unmodelled)
    if ((protectType & ProtectType.PROTECT_BLOCK) !== 0) {
      return outcome(ctx, { targetId, missed: true })
    }
  }

  // 3. jumpifstatus4 BS_TARGET, STATUS4_FORESIGHT (:5074)
  if (hasFlag(target.statuses4, STATUS4_FORESIGHT)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. setforesight (:5075)
  target.statuses4 = setFlag(target.statuses4, STATUS4_FORESIGHT)

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_MIRACLE_EYE handler (Miracle Eye).
 * BattleScript_EffectMiracleEye, data/battle_scripts_1.s:2705-2712.
 * Cmd_setmiracleeye, src/battle_script_commands.c:9448-9455.
 */
function handleMiracleEye(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  if (targetId === null) return outcome(ctx, { targetId: null, missed: true })
  const target = state.battlers[targetId]
  if (!target || !isBattlerAlive(state, targetId)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2707); ppreduce (:2709)
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. setmiracleeye BattleScript_ButItFailed (:2710)
  if (hasFlag(target.statuses3, STATUS3_MIRACLE_EYED)) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.statuses3 = setFlag(target.statuses3, STATUS3_MIRACLE_EYED)
  return outcome(ctx, { targetId })
}

/**
 * EFFECT_PERISH_SONG handler (Perish Song).
 * BattleScript_EffectPerishSong, data/battle_scripts_1.s:5083-5100.
 * Cmd_trysetperishsong, src/battle_script_commands.c:11132-11145.
 */
function handlePerishSong(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:5086)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. trysetperishsong BattleScript_ButItFailed (:5087, Cmd_trysetperishsong :11132-11145): every
  // battler, alive or not. IsSoundproof (battle_util.c:8864-8871) is the isSoundproof bitfield
  // (Soundproof, Noise Cancel) on the battler itself -- both leave onImmuneFor at APPLY_ON_SELF,
  // so the ally branch never fires -- with mold breaker checked.
  const attackerHasMB = attackerHasMoldBreakerActive(state.battlers[battlerId]!, deps)
  if (battlerHasSimAbility(state, state.battlers[battlerId]!, 'ABILITY_PRANKSTER', false, battlerId, false, deps.dataContext)) {
    unmodelled.push("Cmd_trysetperishsong's BlocksPrankster check (battle_script_commands.c:11138) is not applied")
  }
  let affectedCount = 0
  for (let i = 0; i < state.battlersCount; i++) {
    const b = state.battlers[i]
    if (!b) continue
    if (hasFlag(b.statuses3, STATUS3_PERISH_SONG)) continue
    const isSoundproof = ['ABILITY_SOUNDPROOF', 'ABILITY_NOISE_CANCEL'].some((ab) =>
      battlerHasSimAbility(state, b, ab, true, battlerId, attackerHasMB, deps.dataContext),
    )
    if (isSoundproof) continue

    affectedCount++
    b.statuses3 = setFlag(b.statuses3, STATUS3_PERISH_SONG)
    b.volatiles.perishSongTimer = 3
    b.volatiles.perishSongTimerStartValue = 3
  }

  if (affectedCount === 0) {
    return outcome(ctx, { missed: true })
  }

  return outcome(ctx, {})
}

/**
 * EFFECT_WISH handler (Wish).
 * BattleScript_EffectWish, data/battle_scripts_1.s:6306-6313.
 * Cmd_trywish case 0, src/battle_script_commands.c:11784-11793.
 */
function handleWish(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // 1. ppreduce (:6309)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. trywish 0, BattleScript_ButItFailed (:6310, Cmd_trywish case 0:11784-11793)
  if (state.field.wishCounter[battlerId] !== 0) {
    return outcome(ctx, { missed: true })
  }

  state.field.wishCounter[battlerId] = 2
  state.field.wishPartyId[battlerId] = battler.partyIndex
  return outcome(ctx, {})
}

/**
 * EFFECT_MINIMIZE handler (Minimize).
 * BattleScript_EffectMinimize, data/battle_scripts_1.s:4922-4927.
 * Cmd_setminimize, src/battle_script_commands.c:11573-11577.
 */
function handleMinimize(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. setminimize (:4924)
  const battler = state.battlers[battlerId]!
  battler.statuses3 = setFlag(battler.statuses3, STATUS3_MINIMIZED)

  // 2. ppreduce (:3616)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 3. Evasion +2 stat buff (:4925, :3617)
  const statChanges: StatChangeOutcome[] = []
  const rEvs = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    2,
    STAT_EVASION,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (rEvs.delta !== 0) statChanges.push({ battlerId, stat: STAT_EVASION, change: rEvs.delta })

  return outcome(ctx, { statChanges })
}

/** BATTLE_TYPE_DOUBLE, include/constants/battle.h. */
const BATTLE_TYPE_DOUBLE = 1 << 0

/** Abilities with bitfields.isSoundproof (abilityHooks.json). */
const SOUNDPROOF_IDS = ['ABILITY_SOUNDPROOF', 'ABILITY_NOISE_CANCEL']

/**
 * EFFECT_HEAL_BELL handler (Heal Bell, Aromatherapy).
 * BattleScript_EffectHealBell, data/battle_scripts_1.s:4842-4869.
 * Cmd_healpartystatus, src/battle_script_commands.c:11022-11101.
 * tryhealpercenthealth BS_ATTACKER, 30, src/battle_script_commands.c:7896-7907.
 */
function handleHealBell(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!
  const side = battlerId & 1

  // 1. ppreduce (:4845)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. healpartystatus (:4846, Cmd_healpartystatus :11022-11101). IsSoundproof (battle_util.c:
  // 8864-8871) is the battler's own Soundproof/Noise Cancel (both APPLY_ON_SELF), mold breaker
  // checked. Heal Bell's party loop calls IsSoundproof(i) with the PARTY index i as a battler id for
  // the active slots -- ported as written; reserves check their own ability and innates.
  // Aromatherapy heals everyone. The sim has no doubles partner here.
  const isHealBell = moveId === 'MOVE_HEAL_BELL'
  const attackerHasMB = attackerHasMoldBreakerActive(battler, deps)
  const isSoundproof = (id: number): boolean => {
    const b = state.battlers[id]
    return !!b && SOUNDPROOF_IDS.some((ab) => battlerHasSimAbility(state, b, ab, true, battlerId, attackerHasMB, deps.dataContext))
  }
  if (!isHealBell || !isSoundproof(battlerId)) {
    battler.mon.status1 = 0
    battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_NIGHTMARE)
  }
  const party = state.sides[side].party
  for (let i = 0; i < party.length; i++) {
    const pMon = party[i]
    if (!pMon || pMon.speciesId === null) continue
    let healMon = true
    if (isHealBell) {
      healMon =
        i === battler.partyIndex
          ? !isSoundproof(i)
          : !SOUNDPROOF_IDS.some((ab) => pMon.abilities.ability === ab || pMon.abilities.innates.includes(ab))
    }
    if (healMon) pMon.status1 = 0
  }

  // 3. tryhealpercenthealth BS_ATTACKER, 30, BattleScript_MoveEnd (:4862)
  if (battler.mon.hp < battler.mon.maxHp && canBattlerHeal(state, battlerId, battler, unmodelled)) {
    const healAmount = Math.max(1, Math.trunc((battler.mon.maxHp * 30) / 100))
    healBattler(state, battlerId, battler, healAmount)
  }

  return outcome(ctx, { targetId: battlerId })
}

/**
 * EFFECT_REFRESH handler (Refresh).
 * BattleScript_EffectRefresh, data/battle_scripts_1.s:6484-6508.
 * Cmd_cureifburnedparalysedorpoisoned, src/battle_script_commands.c:11648-11660.
 * tryhealpercenthealth BS_ATTACKER, 25, src/battle_script_commands.c:7896-7907.
 */
function handleRefresh(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // 1. ppreduce (:6487)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. cureifburnedparalysedorpoisoned (:6488, Cmd_cureifburnedparalysedorpoisoned:11648-11660)
  // STATUS1_POISON | STATUS1_BURN | STATUS1_PARALYSIS | STATUS1_TOXIC_POISON | STATUS1_FROSTBITE | STATUS1_BLEED
  const CURE_MASK =
    STATUS1_POISON | STATUS1_BURN | STATUS1_PARALYSIS | STATUS1_TOXIC_POISON | STATUS1_FROSTBITE | STATUS1_BLEED
  const hasCurableStatus = (battler.mon.status1 & CURE_MASK) !== 0

  if (hasCurableStatus) {
    battler.mon.status1 = 0
    if (state.sides[battlerId & 1].party[battler.partyIndex]) {
      state.sides[battlerId & 1].party[battler.partyIndex].status1 = 0
    }

    // tryhealpercenthealth BS_ATTACKER, 25, BattleScript_MoveEnd (:6494)
    if (battler.mon.hp < battler.mon.maxHp && canBattlerHeal(state, battlerId, battler, unmodelled)) {
      const healAmount = Math.max(1, Math.trunc((battler.mon.maxHp * 25) / 100))
      healBattler(state, battlerId, battler, healAmount)
    }
    return outcome(ctx, { targetId: battlerId })
  } else {
    // BattleScript_EffectRefresh_NoStatusHeal (:6500)
    // tryhealpercenthealth BS_ATTACKER, 25, BattleScript_ButItFailed (:6501)
    if (battler.mon.hp === battler.mon.maxHp || !canBattlerHeal(state, battlerId, battler, unmodelled)) {
      return outcome(ctx, { targetId: battlerId, missed: true })
    }
    const healAmount = Math.max(1, Math.trunc((battler.mon.maxHp * 25) / 100))
    healBattler(state, battlerId, battler, healAmount)
    return outcome(ctx, { targetId: battlerId })
  }
}

/**
 * EFFECT_PURIFY handler (Purify).
 * BattleScript_EffectPurify, data/battle_scripts_1.s:879-895.
 * Cmd_accuracycheck NO_ACC_CALC_CHECK_LOCK_ON, src/battle_script_commands.c:1403-1411.
 * Cmd_curestatus BS_TARGET, src/battle_script_commands.c:7685-7689.
 * Cmd_tryhealhalfhealth BS_ATTACKER, src/battle_script_commands.c:9255-9274.
 */
function handlePurify(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // 1. ppreduce (:882)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null) {
    return outcome(ctx, { missed: true })
  }
  const target = state.battlers[targetId]
  if (!target || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. accuracycheck BattleScript_ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:883)
  const lockedOn = hasFlag(target.statuses3, STATUS3_ALWAYS_HITS) && target.volatiles.battlerWithSureHit === battlerId
  if (!lockedOn && hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. jumpifstatus BS_TARGET, STATUS1_ANY, BattleScript_PurifyWorks (:884) -> goto BattleScript_ButItFailed (:885)
  if ((target.mon.status1 & STATUS1_ANY) === 0) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. curestatus BS_TARGET (:889; VARIOUS_CURE_STATUS :7685-7689 zeroes status1 only)
  target.mon.status1 = 0
  if (state.sides[targetId & 1].party[target.partyIndex]) {
    state.sides[targetId & 1].party[target.partyIndex].status1 = 0
  }

  // 5. tryhealhalfhealth BattleScript_AlreadyAtFullHp, BS_ATTACKER (:893, Cmd_tryhealhalfhealth
  // :9255-9274) -> BattleScript_RestoreHp (:3949-3955, no bleed branch): a user CanBattlerHeal
  // rejects (bleed included) gets a zero heal, a full-HP user goes to AlreadyAtFullHp.
  if (canBattlerHeal(state, battlerId, battler, unmodelled) && battler.mon.hp < battler.mon.maxHp) {
    healBattler(state, battlerId, battler, Math.max(1, Math.trunc(battler.mon.maxHp / 2)))
  }

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_TAKE_HEART handler (Take Heart).
 * BattleScript_EffectTakeHeart, data/battle_scripts_1.s:6695-6712.
 * BattleScript_CalmMindDoBoosts, data/battle_scripts_1.s:6748-6763.
 */
function handleTakeHeart(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // 1. ppreduce (:6698)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const hasStatus = (battler.mon.status1 & STATUS1_ANY) !== 0
  const spAtkStage = battler.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  const spDefStage = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE

  // :6699-6702: If no status and both SpAtk & SpDef are at MAX_STAT_STAGE, fails!
  if (!hasStatus && spAtkStage >= MAX_STAT_STAGE && spDefStage >= MAX_STAT_STAGE) {
    return outcome(ctx, { targetId: battlerId, missed: true })
  }

  // 2. curestatus BS_ATTACKER (:6706; status1 only)
  if (hasStatus) {
    battler.mon.status1 = 0
    if (state.sides[battlerId & 1].party[battler.partyIndex]) {
      state.sides[battlerId & 1].party[battler.partyIndex].status1 = 0
    }
  }

  // 3. Stat boosts: SpAtk +1 and SpDef +1 (:6751-6762)
  const statChanges: StatChangeOutcome[] = []
  const rSpAtk = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_SPATK,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    false,
    deps,
    unmodelled,
    moveId,
  )
  if (rSpAtk.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPATK, change: rSpAtk.delta })

  const rSpDef = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_SPDEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    false,
    deps,
    unmodelled,
    moveId,
  )
  if (rSpDef.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: rSpDef.delta })

  return outcome(ctx, { targetId: battlerId, statChanges })
}

/**
 * EFFECT_REST handler (Rest).
 * BattleScript_EffectRest, data/battle_scripts_1.s:4023-4036.
 * Cmd_trysetrest, src/battle_script_commands.c:9415-9437.
 */
function handleRest(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // 1. ppreduce (:4026)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifstatus BS_ATTACKER, STATUS1_SLEEP, BattleScript_RestIsAlreadyAsleep (:4027)
  if ((battler.mon.status1 & STATUS1_SLEEP) !== 0) {
    return outcome(ctx, { targetId: battlerId, missed: true })
  }

  // 3. jumpifabilityflag BS_ATTACKER, ABILITY_COMATOSE, BattleScript_RestIsAlreadyAsleep (:4028)
  if (battlerHasSimAbility(state, battler, 'ABILITY_COMATOSE', false, battlerId, false, deps.dataContext)) {
    return outcome(ctx, { targetId: battlerId, missed: true })
  }

  // 4. requirecandoeffect BS_ATTACKER, MOVE_EFFECT_SLEEP | MOVE_EFFECT_AFFECTS_USER (:4029)
  // IsAbilityStatusProtected(battlerId, CHECK_SLEEP)
  if (isAbilityStatusProtected(state, battlerId, CHECK_SLEEP, battlerId, deps) !== null) {
    return outcome(ctx, { targetId: battlerId, missed: true })
  }

  // 5. trysetrest BattleScript_AlreadyAtFullHp (:4030, Cmd_trysetrest:9415-9437)
  // - Full HP fails
  if (battler.mon.hp === battler.mon.maxHp) {
    return outcome(ctx, { targetId: battlerId, missed: true })
  }

  // - Electric Terrain prevents
  if (isBattlerTerrainAffected(state, battlerId, STATUS_FIELD_ELECTRIC_TERRAIN, deps)) {
    return outcome(ctx, { targetId: battlerId, missed: true })
  }

  // - Misty Terrain prevents
  if (isBattlerTerrainAffected(state, battlerId, STATUS_FIELD_MISTY_TERRAIN, deps)) {
    return outcome(ctx, { targetId: battlerId, missed: true })
  }

  // Sets sleep to 3 turns: STATUS1_SLEEP_TURN(3) = 3 (battle_script_commands.c:9432)
  battler.mon.status1 = 3
  syncPartyHp(state, battlerId)
  if (state.sides[battlerId & 1].party[battler.partyIndex]) {
    state.sides[battlerId & 1].party[battler.partyIndex].status1 = battler.mon.status1
  }

  // PresentHealTarget (:5915-5924)
  // Restores user to full HP
  healBattler(state, battlerId, battler, battler.mon.maxHp - battler.mon.hp)

  return outcome(ctx, { targetId: battlerId })
}

/** Abilities with bitfields.megaLauncherBoost (abilityHooks.json). */
const MEGA_LAUNCHER_BOOST_ABILITIES = [
  'ABILITY_GUNMAN', 'ABILITY_IRON_BARRAGE', 'ABILITY_MASTER_HAND', 'ABILITY_MEGA_LAUNCHER', 'ABILITY_NIHIL_BLASTER', 'ABILITY_SUPER_SCOPE',
]

/**
 * EFFECT_HEAL_PULSE handler (Heal Pulse, Floral Healing).
 * BattleScript_EffectHealPulse, data/battle_scripts_1.s:2252-2267.
 * Cmd_tryhealpulse BS_TARGET, src/battle_script_commands.c:7261-7280.
 */
function handleHealPulse(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:2255)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null) {
    return outcome(ctx, { missed: true })
  }
  const target = state.battlers[targetId]
  if (!target || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. accuracycheck BattleScript_ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:2256)
  const lockedOn = hasFlag(target.statuses3, STATUS3_ALWAYS_HITS) && target.volatiles.battlerWithSureHit === battlerId
  if (!lockedOn && hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. jumpifsubstituteblocks BattleScript_ButItFailed (:2257) - attacker first!
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. jumpifhealingblocked BS_TARGET, BattleScript_ButItFailed (:2258)
  if (isHealingBlocked(state, targetId, target, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 5. tryhealpulse BS_TARGET, BattleScript_AlreadyAtFullHp (:2259, :7261-7280)
  if (hasFlag(target.mon.status1, STATUS1_BLEED)) {
    // jumpifstatus BS_TARGET, STATUS1_BLEED, BattleScript_MoveUsedBleedHeal (:2262)
    target.mon.status1 = 0
    if (state.sides[targetId & 1].party[target.partyIndex]) {
      state.sides[targetId & 1].party[target.partyIndex].status1 = 0
    }
    return outcome(ctx, { targetId })
  }

  if (target.mon.hp === target.mon.maxHp) {
    // BattleScript_AlreadyAtFullHp (:5926-5930) - prints full HP message, succeeds with no heal
    return outcome(ctx, { targetId })
  }

  // Mega Launcher check (:7268-7271):
  // Checks if move has bulletBased flag and attacker or target has ABILITY_MEGA_LAUNCHER
  // IsMegaLauncherBoosted(attacker, move) (battle_util.c:9373: MOVE_FLAG_MEGA_LAUNCHER, moves.json's
  // bulletBased; ability-granted flags not applied) and then ON_ABILITY over the TARGET's abilities
  // with the megaLauncherBoost bitfield (abilityHooks.json), checkMoldBreaker FALSE.
  const isBulletBased = Boolean(deps.dataContext.move(moveId)?.flags.bulletBased)
  const megaLauncherBoosted =
    isBulletBased &&
    MEGA_LAUNCHER_BOOST_ABILITIES.some((id) => battlerHasSimAbility(state, target, id, false, targetId, false, deps.dataContext))

  const heal = megaLauncherBoosted
    ? Math.max(1, Math.trunc((target.mon.maxHp * 3) / 4))
    : Math.max(1, Math.trunc(target.mon.maxHp / 2))

  healBattler(state, targetId, target, heal)
  return outcome(ctx, { targetId })
}

/**
 * EFFECT_PSYCHO_SHIFT handler (Psycho Shift).
 * BattleScript_EffectPsychoShift, data/battle_scripts_1.s:1456-1478.
 * Cmd_trypsychoshift, src/battle_script_commands.c:7641-7684.
 */
function handlePsychoShift(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  if (targetId === null) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { missed: true })
  }
  const target = state.battlers[targetId]
  if (!target || !isBattlerAlive(state, targetId)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:1458)
  const missed = checkAccuracy(ctx, targetId, moveId)

  // 2. ppreduce (:1460)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { targetId, missed: true })

  // 3. jumpifstatus BS_ATTACKER, STATUS1_ANY (:1461)
  const userStatus = battler.mon.status1 & STATUS1_ANY
  if (userStatus === 0) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. jumpifstatus BS_TARGET, STATUS1_ANY (:1464)
  if ((target.mon.status1 & STATUS1_ANY) !== 0) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 5. jumpifsafeguard (:1465)
  if (hasFlag(state.sides[targetId & 1].statuses, SIDE_STATUS_SAFEGUARD)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 6. trypsychoshift (:1466, VARIOUS_PSYCHO_SHIFT :7641-7684). Only the paralysis, poison and
  // burn branches can fail, and the poison branch asks CanBeParalyzed (the C's own call). Sleep,
  // frostbite and bleed transfer even when the target cannot take them. The target has no status1
  // here (jumpifstatus above), so each branch's "target lacks it" test is always true.
  let fails = false
  if (hasFlag(userStatus, STATUS1_PARALYSIS)) fails = !canBeParalyzed(state, battlerId, targetId, deps)
  else if (hasFlag(userStatus, STATUS1_POISON) || hasFlag(userStatus, STATUS1_TOXIC_POISON)) fails = !canBeParalyzed(state, battlerId, targetId, deps)
  else if (hasFlag(userStatus, STATUS1_BURN)) fails = !canBeBurned(state, targetId, battlerId, deps)
  if (fails) return outcome(ctx, { targetId, missed: true })

  target.mon.status1 = userStatus

  // curestatus BS_ATTACKER (:1474)
  battler.mon.status1 = 0

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_STOCKPILE handler (Stockpile).
 * BattleScript_EffectStockpile, data/battle_scripts_1.s:5979-6007.
 * Cmd_stockpile, src/battle_script_commands.c:9494-9519.
 */
function handleStockpile(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, deps } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // 1. ppreduce (:5982)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. stockpile 0 (:5983, Cmd_stockpile case 0:9496-9507)
  if (battler.volatiles.stockpileCounter >= 3) {
    return outcome(ctx, { targetId: battlerId, missed: true })
  }

  battler.volatiles.stockpileCounter++
  battler.volatiles.stockpileBeforeDef = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  battler.volatiles.stockpileBeforeSpDef = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE

  // 3. Stat buffs: Def +1 and SpDef +1 (:5994-6004)
  const statChanges: StatChangeOutcome[] = []
  const rDef = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_DEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    false,
    deps,
    unmodelled,
    moveId,
  )
  if (rDef.delta !== 0) statChanges.push({ battlerId, stat: STAT_DEF, change: rDef.delta })

  const rSpDef = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    1,
    STAT_SPDEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    false,
    deps,
    unmodelled,
    moveId,
  )
  if (rSpDef.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPDEF, change: rSpDef.delta })

  // 4. stockpile 1 (:6006, Cmd_stockpile case 1:9508-9515)
  // Records the net stages gained from this stockpile use
  const currentDef = battler.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  const currentSpDef = battler.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE
  battler.volatiles.stockpileDef += currentDef - battler.volatiles.stockpileBeforeDef
  battler.volatiles.stockpileSpDef += currentSpDef - battler.volatiles.stockpileBeforeSpDef

  return outcome(ctx, { targetId: battlerId, statChanges })
}

const HANDLERS: Record<string, MoveEffectHandler> = {
  EFFECT_PROTECT: handleProtect,
  EFFECT_ENDURE: handleProtect,

  EFFECT_ATTACK_UP: (ctx) => handleSingleStatUp(ctx, STAT_ATK, 1),
  EFFECT_ATTACK_UP_2: (ctx) => handleSingleStatUp(ctx, STAT_ATK, 2),
  EFFECT_DEFENSE_UP: (ctx) => handleSingleStatUp(ctx, STAT_DEF, 1),
  EFFECT_DEFENSE_UP_2: (ctx) => handleSingleStatUp(ctx, STAT_DEF, 2),
  EFFECT_DEFENSE_UP_3: (ctx) => handleSingleStatUp(ctx, STAT_DEF, 3),
  EFFECT_SPECIAL_ATTACK_UP: (ctx) => handleSingleStatUp(ctx, STAT_SPATK, 1),
  EFFECT_SPECIAL_ATTACK_UP_2: (ctx) => handleSingleStatUp(ctx, STAT_SPATK, 2),
  EFFECT_SPECIAL_ATTACK_UP_3: (ctx) => handleSingleStatUp(ctx, STAT_SPATK, 3),
  EFFECT_SPECIAL_DEFENSE_UP: (ctx) => handleSingleStatUp(ctx, STAT_SPDEF, 1),
  EFFECT_SPECIAL_DEFENSE_UP_2: (ctx) => handleSingleStatUp(ctx, STAT_SPDEF, 2),
  EFFECT_SPEED_UP: (ctx) => handleSingleStatUp(ctx, STAT_SPEED, 1),
  EFFECT_SPEED_UP_2: (ctx) => handleSingleStatUp(ctx, STAT_SPEED, 2),
  EFFECT_ACCURACY_UP: (ctx) => handleSingleStatUp(ctx, STAT_ACC, 1),
  EFFECT_ACCURACY_UP_2: (ctx) => handleSingleStatUp(ctx, STAT_ACC, 2),
  EFFECT_EVASION_UP: (ctx) => handleSingleStatUp(ctx, STAT_EVASION, 1),
  EFFECT_EVASION_UP_2: (ctx) => handleSingleStatUp(ctx, STAT_EVASION, 2),

  EFFECT_ATTACK_DOWN: (ctx) => handleSingleStatDown(ctx, STAT_ATK, 1),
  EFFECT_ATTACK_DOWN_2: (ctx) => handleSingleStatDown(ctx, STAT_ATK, 2),
  EFFECT_DEFENSE_DOWN: (ctx) => handleSingleStatDown(ctx, STAT_DEF, 1),
  EFFECT_DEFENSE_DOWN_2: (ctx) => handleSingleStatDown(ctx, STAT_DEF, 2),
  EFFECT_SPEED_DOWN: (ctx) => handleSingleStatDown(ctx, STAT_SPEED, 1),
  EFFECT_SPEED_DOWN_2: (ctx) => handleSingleStatDown(ctx, STAT_SPEED, 2),
  EFFECT_SPECIAL_ATTACK_DOWN: (ctx) => handleSingleStatDown(ctx, STAT_SPATK, 1),
  EFFECT_SPECIAL_ATTACK_DOWN_2: (ctx) => handleSingleStatDown(ctx, STAT_SPATK, 2),
  EFFECT_SPECIAL_DEFENSE_DOWN: (ctx) => handleSingleStatDown(ctx, STAT_SPDEF, 1),
  EFFECT_SPECIAL_DEFENSE_DOWN_2: (ctx) => handleSingleStatDown(ctx, STAT_SPDEF, 2),
  EFFECT_ACCURACY_DOWN: (ctx) => handleSingleStatDown(ctx, STAT_ACC, 1),
  EFFECT_ACCURACY_DOWN_2: (ctx) => handleSingleStatDown(ctx, STAT_ACC, 2),
  EFFECT_EVASION_DOWN: (ctx) => handleSingleStatDown(ctx, STAT_EVASION, 1),
  EFFECT_EVASION_DOWN_2: (ctx) => handleSingleStatDown(ctx, STAT_EVASION, 2),
  EFFECT_SCARY_FACE: handleScaryFace,
  EFFECT_TICKLE: (ctx) => handleTwoStatDown(ctx, STAT_ATK, STAT_DEF),
  EFFECT_NOBLE_ROAR: (ctx) => handleTwoStatDown(ctx, STAT_ATK, STAT_SPATK),

  EFFECT_BULK_UP: handleBulkUp,
  EFFECT_CALM_MIND: handleCalmMind,
  EFFECT_DRAGON_DANCE: handleDragonDance,
  EFFECT_DRAGON_CHEER: handleDragonCheer,
  EFFECT_QUIVER_DANCE: handleQuiverDance,
  EFFECT_VICTORY_DANCE: handleVictoryDance,
  EFFECT_MYSTIC_DANCE: handleMysticDance,
  EFFECT_GROWTH: handleGrowth,
  EFFECT_SHARPEN: handleSharpen,
  EFFECT_SHELTER: handleShelter,
  EFFECT_GEAR_UP: handleGearUp,
  EFFECT_SHELL_SMASH: handleShellSmash,
  EFFECT_BELLY_DRUM: handleBellyDrum,
  EFFECT_COSMIC_POWER: handleCosmicPower,
  EFFECT_COIL: handleCoil,
  EFFECT_HOWL: handleHowl,
  EFFECT_MEDITATE: handleMeditate,
  EFFECT_DEFENSE_CURL: handleDefenseCurl,
  EFFECT_ATTACK_ACCURACY_UP: handleAttackAccuracyUp,
  EFFECT_ATTACK_SPATK_UP: handleAttackSpAtkUp,
  EFFECT_SHIFT_GEAR: handleShiftGear,

  EFFECT_SLEEP: handleSleep,
  EFFECT_POISON: handlePoison,
  EFFECT_TOXIC: handleToxic,
  EFFECT_WILL_O_WISP: handleWillOWisp,
  EFFECT_FROSTBITE: handleFrostbite,
  EFFECT_BLEED: handleBleed,
  EFFECT_PARALYZE: handleParalyze,
  EFFECT_PARALYZE_IGNORE_TYPE: handleParalyzeIgnoreType,
  EFFECT_YAWN: handleYawn,
  EFFECT_CONFUSE: handleConfuse,
  EFFECT_SWEET_KISS: handleSweetKiss,
  EFFECT_FLATTER: handleFlatter,
  EFFECT_TEETER_DANCE: handleTeeterDance,
  EFFECT_ATTRACT: handleAttract,
  EFFECT_SWAGGER: handleSwagger,
  EFFECT_CURSE: handleCurse,
  EFFECT_DESTINY_BOND: handleDestinyBond,
  EFFECT_KARMA: handleKarma,
  EFFECT_RECYCLE: handleRecycle,
  EFFECT_HELPING_HAND: handleHelpingHand,
  EFFECT_TAUNT: handleTaunt,
  EFFECT_DISABLE: handleDisable,
  EFFECT_ENCORE: handleEncore,
  EFFECT_TORMENT: handleTorment,
  EFFECT_HEAL_BLOCK: handleHealBlock,
  EFFECT_EMBARGO: handleEmbargo,
  EFFECT_FOCUS_ENERGY: handleFocusEnergy,

  EFFECT_RESTORE_HP: handleHealHalf,
  EFFECT_SOFTBOILED: handleHealHalf,
  EFFECT_MORNING_SUN: handleWeatherRecovery,
  EFFECT_SYNTHESIS: handleWeatherRecovery,
  EFFECT_MOONLIGHT: handleWeatherRecovery,
  EFFECT_SHORE_UP: handleWeatherRecovery,
  EFFECT_ROOST: handleHealHalf,
  EFFECT_JUNGLE_HEALING: handleJungleHealing,
  EFFECT_PAIN_SPLIT: handlePainSplit,
  EFFECT_STRENGTH_SAP: handleStrengthSap,
  EFFECT_LEECH_SEED: handleLeechSeed,

  EFFECT_REFLECT: handleReflect,
  EFFECT_LIGHT_SCREEN: handleLightScreen,
  EFFECT_AURORA_VEIL: handleAuroraVeil,
  EFFECT_BARRIER: handleBarrier,
  EFFECT_MIST: handleMist,
  EFFECT_SAFEGUARD: handleSafeguard,
  EFFECT_TAILWIND: handleTailwind,
  EFFECT_SPIKES: handleSpikes,
  EFFECT_STEALTH_ROCK: handleStealthRock,
  EFFECT_TOXIC_SPIKES: handleToxicSpikes,
  EFFECT_STICKY_WEB: handleStickyWeb,

  EFFECT_RAIN_DANCE: handleRainDance,
  EFFECT_SUNNY_DAY: handleSunnyDay,
  EFFECT_SANDSTORM: handleSandstorm,
  EFFECT_HAIL: handleHail,
  EFFECT_EERIE_FOG: handleEerieFog,

  EFFECT_ELECTRIC_TERRAIN: handleElectricTerrain,
  EFFECT_GRASSY_TERRAIN: handleGrassyTerrain,
  EFFECT_MISTY_TERRAIN: handleMistyTerrain,
  EFFECT_PSYCHIC_TERRAIN: handlePsychicTerrain,
  EFFECT_TOXIC_TERRAIN: handleToxicTerrain,

  EFFECT_TRICK_ROOM: handleTrickRoom,
  EFFECT_WONDER_ROOM: handleWonderRoom,
  EFFECT_MAGIC_ROOM: handleMagicRoom,
  EFFECT_INVERSE_ROOM: handleInverseRoom,

  EFFECT_GRAVITY: handleGravity,
  EFFECT_HAZE: handleHaze,
  EFFECT_CLEAR_SKIES: handleClearSkies,
  EFFECT_DEFOG: handleDefog,

  EFFECT_SUBSTITUTE: handleSubstitute,
  EFFECT_AQUA_RING: handleAquaRing,
  EFFECT_INGRAIN: handleIngrain,
  EFFECT_MAGNET_RISE: handleMagnetRise,
  EFFECT_CHARGE: handleCharge,
  EFFECT_LOCK_ON: handleLockOn,
  EFFECT_LASER_FOCUS: handleLaserFocus,
  EFFECT_MEAN_LOOK: handleMeanLook,
  EFFECT_FORESIGHT: handleForesight,
  EFFECT_MIRACLE_EYE: handleMiracleEye,
  EFFECT_PERISH_SONG: handlePerishSong,
  EFFECT_MINIMIZE: handleMinimize,
  EFFECT_WISH: handleWish,
  EFFECT_HEAL_BELL: handleHealBell,
  EFFECT_REFRESH: handleRefresh,
  EFFECT_PURIFY: handlePurify,
  EFFECT_TAKE_HEART: handleTakeHeart,
  EFFECT_REST: handleRest,
  EFFECT_HEAL_PULSE: handleHealPulse,
  EFFECT_PSYCHO_SHIFT: handlePsychoShift,
  EFFECT_STOCKPILE: handleStockpile,
  EFFECT_SWALLOW: handleHealHalf,
}

export function getMoveEffectHandler(effect: string | null): MoveEffectHandler | null {
  if (!effect) return null
  return HANDLERS[effect] ?? null
}

export function isHandledMoveEffect(effect: string | null): boolean {
  return getMoveEffectHandler(effect) !== null
}

// ---------------------------------------------------------------------------
// Secondary Move Effects (Post-Damage)
// ---------------------------------------------------------------------------

// pipeline/.upstream/er-config/MoveEffect.proto:12-22, 28-41, 47, 52-65
export const SECONDARY_MOVE_EFFECT_MAP: Record<string, number> = {
  MOVE_EFFECT_SLEEP: MOVE_EFFECT_SLEEP,
  MOVE_EFFECT_POISON: MOVE_EFFECT_POISON,
  MOVE_EFFECT_BURN: MOVE_EFFECT_BURN,
  MOVE_EFFECT_FREEZE: MOVE_EFFECT_FREEZE,
  MOVE_EFFECT_PARALYSIS: MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_TOXIC: MOVE_EFFECT_TOXIC,
  MOVE_EFFECT_FROSTBITE: MOVE_EFFECT_FROSTBITE,
  MOVE_EFFECT_BLEED: MOVE_EFFECT_BLEED,
  MOVE_EFFECT_CONFUSION: MOVE_EFFECT_CONFUSION,
  MOVE_EFFECT_FLINCH: MOVE_EFFECT_FLINCH,
  MOVE_EFFECT_TRI_ATTACK: MOVE_EFFECT_TRI_ATTACK,
  MOVE_EFFECT_ATK_PLUS_1: MOVE_EFFECT_ATK_PLUS_1,
  MOVE_EFFECT_DEF_PLUS_1: MOVE_EFFECT_DEF_PLUS_1,
  MOVE_EFFECT_SPD_PLUS_1: MOVE_EFFECT_SPD_PLUS_1,
  MOVE_EFFECT_SP_ATK_PLUS_1: MOVE_EFFECT_SP_ATK_PLUS_1,
  MOVE_EFFECT_SP_DEF_PLUS_1: MOVE_EFFECT_SP_DEF_PLUS_1,
  MOVE_EFFECT_ACC_PLUS_1: MOVE_EFFECT_ACC_PLUS_1,
  MOVE_EFFECT_EVS_PLUS_1: MOVE_EFFECT_EVS_PLUS_1,
  MOVE_EFFECT_ATK_MINUS_1: MOVE_EFFECT_ATK_MINUS_1,
  MOVE_EFFECT_DEF_MINUS_1: MOVE_EFFECT_DEF_MINUS_1,
  MOVE_EFFECT_SPD_MINUS_1: MOVE_EFFECT_SPD_MINUS_1,
  MOVE_EFFECT_SP_ATK_MINUS_1: MOVE_EFFECT_SP_ATK_MINUS_1,
  MOVE_EFFECT_SP_DEF_MINUS_1: MOVE_EFFECT_SP_DEF_MINUS_1,
  MOVE_EFFECT_ACC_MINUS_1: MOVE_EFFECT_ACC_MINUS_1,
  MOVE_EFFECT_EVS_MINUS_1: MOVE_EFFECT_EVS_MINUS_1,
  MOVE_EFFECT_ALL_STATS_UP: MOVE_EFFECT_ALL_STATS_UP,
  MOVE_EFFECT_ATK_PLUS_2: MOVE_EFFECT_ATK_PLUS_2,
  MOVE_EFFECT_DEF_PLUS_2: MOVE_EFFECT_DEF_PLUS_2,
  MOVE_EFFECT_SPD_PLUS_2: MOVE_EFFECT_SPD_PLUS_2,
  MOVE_EFFECT_SP_ATK_PLUS_2: MOVE_EFFECT_SP_ATK_PLUS_2,
  MOVE_EFFECT_SP_DEF_PLUS_2: MOVE_EFFECT_SP_DEF_PLUS_2,
  MOVE_EFFECT_ACC_PLUS_2: MOVE_EFFECT_ACC_PLUS_2,
  MOVE_EFFECT_EVS_PLUS_2: MOVE_EFFECT_EVS_PLUS_2,
  MOVE_EFFECT_ATK_MINUS_2: MOVE_EFFECT_ATK_MINUS_2,
  MOVE_EFFECT_DEF_MINUS_2: MOVE_EFFECT_DEF_MINUS_2,
  MOVE_EFFECT_SPD_MINUS_2: MOVE_EFFECT_SPD_MINUS_2,
  MOVE_EFFECT_SP_ATK_MINUS_2: MOVE_EFFECT_SP_ATK_MINUS_2,
  MOVE_EFFECT_SP_DEF_MINUS_2: MOVE_EFFECT_SP_DEF_MINUS_2,
  MOVE_EFFECT_ACC_MINUS_2: MOVE_EFFECT_ACC_MINUS_2,
  MOVE_EFFECT_EVS_MINUS_2: MOVE_EFFECT_EVS_MINUS_2,
}
export const SECONDARY_STATUS_EFFECT_MAP = SECONDARY_MOVE_EFFECT_MAP

// The numeric values of MOVE_EFFECT_KNOCK_OFF / STEAL_ITEM / BUG_BITE / SMACK_DOWN are generated and not in the tree.
// Downstream, getMoveEffectChance only compares against FLINCH / BURN / FROSTBITE, so any value outside the real enum
// range behaves identically.
const MOVE_EFFECT_STORED_FOR_MOVEEND = -1

// SetMoveEffect's first switch (battle_script_commands.c:2321-2334) stores these in gBattleStruct->moveEffect2 and
// returns; MOVEEND_MOVE_EFFECTS2_ON_EACH (moveEnd.ts) applies them.
const MOVE_EFFECTS_STORED_FOR_MOVEEND = new Set([
  'MOVE_EFFECT_KNOCK_OFF',
  'MOVE_EFFECT_STEAL_ITEM',
  'MOVE_EFFECT_BUG_BITE',
  'MOVE_EFFECT_SMACK_DOWN',
])

export interface SecondaryEffectsResult {
  statusApplied: StatusAppliedOutcome | null
  statChanges: StatChangeOutcome[]
  /** gBattleStruct->moveEffect2 (battle_script_commands.c:2332), consumed by MOVEEND_MOVE_EFFECTS2_ON_EACH. */
  moveEffect2: string | null
}

export interface SecondaryMoveEffectContext {
  state: BattleState
  attackerId: number
  targetId: number
  moveId: string
  targetDamage: number | null
  deps: StatusDeps & { moveBehaviors?: MoveBehaviors }
  unmodelled: string[]
}

/**
 * BattleScript_EffectRapidSpin, B_SPEED_BUFFING_RAPID_SPIN == GEN_8 branch
 * (data/battle_scripts_1.s:5402-5431), from the `jumpifhalfword ...
 * DOESNT_AFFECT_FOE` onwards: `setmoveeffect MOVE_EFFECT_RAPIDSPIN |
 * AFFECTS_USER | CERTAIN` + `seteffectwithchance` (a certain effect draws no RNG
 * and needs !MOVE_RESULT_NO_EFFECT, :3107) -> SetMoveEffect -> rapidspinfree
 * (:2837), then `setstatchanger STAT_SPEED, 1` + `statbuffchange
 * MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR`. A type-immune target skips all
 * of it. SetMoveEffect's gates ahead of the RAPIDSPIN case that can apply to the
 * attacker are TestSheerForceFlag (:2361) and the dead-effect-battler check (:2364).
 */
function applyRapidSpinEffects(ctx: SecondaryMoveEffectContext): SecondaryEffectsResult {
  const { state, attackerId, targetId, moveId, targetDamage, deps, unmodelled } = ctx
  const result: SecondaryEffectsResult = { statusApplied: null, statChanges: [], moveEffect2: null }
  if (targetDamage === null) {
    unmodelled.push(`seteffectwithchance: ${moveId} dealt unresolved damage, so MOVE_RESULT_NO_EFFECT is unknown; treated as no effect`)
    return result
  }
  if (targetDamage === 0) return result

  const attacker = state.battlers[attackerId]
  if (attacker && attacker.mon.hp > 0 && !testSheerForceFlag(state, attackerId, moveId, deps)) rapidSpinFree(state, attackerId)

  const res = changeStatBuffsImplicit(state, attackerId, targetId, 1, STAT_SPEED, MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR, true, deps, unmodelled, moveId)
  if (res.delta !== 0) result.statChanges.push({ battlerId: attackerId, stat: STAT_SPEED, change: res.delta })
  return result
}

/**
 * Port of post-damage secondary move effect resolution.
 * Sources:
 * - BattleScript_EffectHit: data/battle_scripts_1.s:2857-2885
 * - Cmd_seteffectwithchance: src/battle_script_commands.c:3092-3125
 * - AttackScriptGenerator: tools/codegen/src/er/move/MoveScriptGenerator.kt:51-109
 *
 * Resolves secondary status effects (sleep, poison, toxic, burn, freeze, paralysis,
 * frostbite, bleed, confusion, and Tri Attack pick).
 * C execution order:
 * 1. Chance is calculated via GetMoveEffectChance (capped at 100).
 * 2. If MOVE_EFFECT_CERTAIN, RNG draw is skipped.
 * 3. Otherwise, Random() % 100 < percentChance is drawn from state.rng.
 * 4. If chance passes and not immune (targetDamage !== 0), SetMoveEffect is called.
 * 5. SetMoveEffect checks Shield Dust / Covert Cloak, Safeguard, Sheer Force,
 *    dead battler, and Substitute before applying status.
 */
export function applySecondaryMoveEffects(
  ctx: SecondaryMoveEffectContext,
): SecondaryEffectsResult | null {
  const { state, attackerId, targetId, moveId, targetDamage, deps, unmodelled } = ctx
  const moveData = deps.dataContext.move(moveId)
  const moveEffect = moveData?.effect ?? null

  interface EffectSpec {
    effectName: string
    chance: number
    affectsUser: boolean
    certain: boolean
    /** Reached through Cmd_seteffectsecondary (SetMoveEffect(FALSE, 0) with no chance roll and no NO_EFFECT gate). */
    secondary?: boolean
  }
  const effectSpecs: EffectSpec[] = []

  const behavior = moveData?.customBehavior ?? (moveEffect && deps.moveBehaviors ? deps.moveBehaviors[moveEffect] : null)

  if (behavior?.attack) {
    const secondaryList = behavior.attack.secondaryEffects as Array<{
      effect?: string
      kind?: string
      argumentEffect?: boolean
      chance?: number
      affectsUser?: boolean
      certain?: boolean
    }> | undefined

    if (secondaryList) {
      // MoveScriptGenerator.kt:76-82 / :58: a single effect becomes `setmoveeffect X; goto BattleScript_EffectHit`
      // (or BattleScript_EffectArgumentHit) with no setmoveeffectchance, so the move's own effectChance is used and
      // the entry's chance is ignored. Only the generated multi-effect script emits setmoveeffectchance (:88-96).
      const singleEffect = secondaryList.length === 1
      const chanceFor = (itemChance: number | undefined) =>
        !singleEffect && itemChance !== undefined && itemChance !== 0 ? itemChance : (moveData?.effectChance ?? 0)
      for (const item of secondaryList) {
        if (item.kind === 'argumentEffect' || item.argumentEffect) {
          const arg = moveData?.argument
          if (arg && typeof arg === 'object' && arg.kind === 'effect' && typeof arg.effect === 'string') {
            const chance = chanceFor(item.chance)
            effectSpecs.push({
              effectName: arg.effect,
              chance,
              affectsUser: Boolean(arg.affectsUser),
              certain: Boolean(arg.certain),
            })
          }
        } else if (item.effect) {
          const chance = chanceFor(item.chance)
          effectSpecs.push({
            effectName: item.effect,
            chance,
            affectsUser: Boolean(item.affectsUser),
            certain: Boolean(item.certain),
          })
        }
      }
    }
  } else if (moveEffect === 'EFFECT_ARGUMENT_HIT') {
    // Legacy script: BattleScript_EffectArgumentHit (data/battle_scripts_1.s:11831)
    // argumenttomoveeffect; goto BattleScript_EffectHit
    const arg = moveData?.argument
    if (arg && typeof arg === 'object' && arg.kind === 'effect' && typeof arg.effect === 'string') {
      effectSpecs.push({
        effectName: arg.effect,
        chance: moveData?.effectChance ?? 0,
        affectsUser: Boolean(arg.affectsUser),
        certain: Boolean(arg.certain),
      })
    }
  } else if (moveEffect === 'EFFECT_FLINCH_STATUS') {
    // Legacy script: BattleScript_EffectFlinchWithStatus (data/battle_scripts_1.s:3870-3893)
    // 1. setmoveeffect MOVE_EFFECT_FLINCH
    // 2. seteffectwithchance (draw 1)
    // 3. argumenttomoveeffect
    // 4. seteffectwithchance (draw 2)
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_FLINCH',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
    const arg = moveData?.argument
    if (arg && typeof arg === 'object' && arg.kind === 'effect' && typeof arg.effect === 'string') {
      effectSpecs.push({
        effectName: arg.effect,
        chance: moveData?.effectChance ?? 0,
        affectsUser: Boolean(arg.affectsUser),
        certain: Boolean(arg.certain),
      })
    }
  } else if (moveEffect === 'EFFECT_SPEED_UP_HIT') {
    // Legacy script: BattleScript_EffectSpeedUpHit (data/battle_scripts_1.s:2127-2129)
    // setmoveeffect MOVE_EFFECT_SPD_PLUS_1 | MOVE_EFFECT_AFFECTS_USER
    // goto BattleScript_EffectHit
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_SPD_PLUS_1',
      chance: moveData?.effectChance ?? 0,
      affectsUser: true,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_PARALYZE_HIT') {
    // Legacy script: BattleScript_EffectParalyzeHit (src/battle_scripts_1.s:3365-3368)
    const attacker = state.battlers[attackerId]
    const hasColdPlasma = attacker
      ? battlerHasSimAbility(state, attacker, 'ABILITY_COLD_PLASMA', false, attackerId, false, deps.dataContext)
      : false
    effectSpecs.push({
      effectName: hasColdPlasma ? 'MOVE_EFFECT_BURN' : 'MOVE_EFFECT_PARALYSIS',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_THUNDER') {
    // Legacy script: BattleScript_EffectThunder (src/battle_scripts_1.s:5734-5736)
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_PARALYSIS',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_HURRICANE') {
    // Legacy script: BattleScript_EffectHurricane (src/battle_scripts_1.s:5738-5740)
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_CONFUSION',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_RAPID_SPIN') {
    return applyRapidSpinEffects(ctx)
  } else if (moveEffect === 'EFFECT_BUG_BITE') {
    // BattleScript_EffectBugBite (data/battle_scripts_1.s:992-995): `jumpifnotberry BS_TARGET,
    // BattleScript_EffectKnockOff` (VARIOUS_JUMP_IF_NOT_BERRY, battle_script_commands.c:6869-6875), otherwise
    // `setmoveeffect MOVE_EFFECT_BUG_BITE | MOVE_EFFECT_CERTAIN` (no chance roll). BattleScript_EffectKnockOff
    // (:6431-6433) is a plain `setmoveeffect MOVE_EFFECT_KNOCK_OFF` with the move's own effectChance.
    const targetBattler = state.battlers[targetId]
    const targetItem = targetBattler?.mon.itemId ?? null
    const itemNegated =
      !!targetBattler &&
      (hasFlag(targetBattler.statuses3, STATUS3_EMBARGO) ||
        battlerHasSimAbility(state, targetBattler, 'ABILITY_KLUTZ', false, targetId, false, deps.dataContext))
    const isBerry = !!targetItem && !itemNegated && deps.dataContext.item(targetItem)?.grouping === 'POCKET_BERRIES'
    effectSpecs.push({
      effectName: isBerry ? 'MOVE_EFFECT_BUG_BITE' : 'MOVE_EFFECT_KNOCK_OFF',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: isBerry,
    })
  } else if (moveEffect === 'EFFECT_SMACK_DOWN') {
    // BattleScript_EffectSmackDown (data/battle_scripts_1.s:1520-1542): `setmoveeffect MOVE_EFFECT_SMACK_DOWN;
    // seteffectsecondary` stores it in moveEffect2 (SetMoveEffect(FALSE, 0), :3132-3135) with no chance roll, then
    // `argumenttomoveeffect; seteffectwithchance` rolls the move's effectChance for its argument effect.
    effectSpecs.push({ effectName: 'MOVE_EFFECT_SMACK_DOWN', chance: 0, affectsUser: false, certain: false, secondary: true })
    const arg = moveData?.argument
    if (arg && typeof arg === 'object' && arg.kind === 'effect' && typeof arg.effect === 'string') {
      effectSpecs.push({
        effectName: arg.effect,
        chance: moveData?.effectChance ?? 0,
        affectsUser: Boolean(arg.affectsUser),
        certain: Boolean(arg.certain),
      })
    } else {
      // argumenttomoveeffect leaves moveEffect 0, but Cmd_seteffectwithchance still evaluates `Random() % 100`
      // before its `&& gBattleScripting.moveEffect` (battle_script_commands.c:3113).
      state.rng.random16()
    }
  } else if (moveEffect === 'EFFECT_HIT' || !moveEffect) {
    // Pure damaging move with no secondary effect
  } else {
    // Any other legacy script reached by a damaging move:
    unmodelled.push(`secondary effect of ${moveEffect} not modelled`)
    return null
  }

  if (effectSpecs.length === 0) {
    return null
  }

  let statusAppliedOutcome: StatusAppliedOutcome | null = null
  const statChanges: StatChangeOutcome[] = []
  let moveEffect2: string | null = null

  for (const spec of effectSpecs) {
    const storedForMoveEnd = MOVE_EFFECTS_STORED_FOR_MOVEEND.has(spec.effectName)
    const baseEffectNum = storedForMoveEnd ? MOVE_EFFECT_STORED_FOR_MOVEEND : SECONDARY_MOVE_EFFECT_MAP[spec.effectName]
    if (baseEffectNum === undefined) {
      unmodelled.push(`secondary effect of ${spec.effectName} not modelled`)
      continue
    }

    const effectNumWithFlags =
      baseEffectNum |
      (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) |
      (spec.certain ? MOVE_EFFECT_CERTAIN : 0)

    if (spec.secondary) {
      moveEffect2 = spec.effectName
      continue
    }

    const percentChance = getMoveEffectChance(
      state,
      attackerId,
      moveId,
      baseEffectNum,
      spec.chance,
      deps,
      unmodelled,
    )

    // C: !(gMoveResultFlags & MOVE_RESULT_NO_EFFECT). damageResolver.ts returns 0 exactly when the hit is
    // immune; null means the damage could not be computed, so whether the move had an effect is unknown.
    if (targetDamage === null) {
      unmodelled.push(`seteffectwithchance: ${moveId} dealt unresolved damage, so MOVE_RESULT_NO_EFFECT is unknown; treated as no effect`)
    }
    const isImmune = targetDamage === 0 || targetDamage === null

    let chancePasses = false
    if (spec.certain) {
      // MOVE_EFFECT_CERTAIN skips the RNG draw
      chancePasses = !isImmune
    } else {
      // Real RNG draw: Random() % 100 < percentChance
      const roll = state.rng.random16() % 100
      chancePasses = roll < percentChance && !isImmune
    }

    if (!chancePasses) {
      continue
    }

    // SetMoveEffect's first switch (battle_script_commands.c:2321-2334) stores the effect in moveEffect2 and
    // returns before the Shield Dust / Safeguard / Sheer Force / Substitute gates below; MOVEEND_MOVE_EFFECTS2_ON_EACH
    // (moveEnd.ts) applies it.
    if (storedForMoveEnd) {
      moveEffect2 = spec.effectName
      continue
    }

    const effectBattlerId = spec.affectsUser ? attackerId : targetId
    const effectBattler = state.battlers[effectBattlerId]
    if (!effectBattler || effectBattler.mon.hp === 0) {
      continue
    }

    // Top-of-SetMoveEffect gate conditions (src/battle_script_commands.c:2348-2388)
    // 1. Shield Dust / Covert Cloak (:2348-2350)
    if (!spec.affectsUser && isPreventableSecondaryEffect(baseEffectNum)) {
      const attackerBattler = state.battlers[attackerId]
      const attackerHasMoldBreaker = attackerBattler ? attackerHasMoldBreakerActive(attackerBattler, deps) : false
      const hasShieldDust = battlerHasSimAbility(
        state,
        effectBattler,
        'ABILITY_SHIELD_DUST',
        true,
        attackerId,
        attackerHasMoldBreaker,
        deps.dataContext,
      )
      const hasCovertCloak = deps.grounding ? deps.grounding.holdEffectOf(effectBattlerId) === 'HOLD_EFFECT_COVERT_CLOAK' : false
      if (hasShieldDust || hasCovertCloak) {
        continue
      }
    }

    // 2. Safeguard (:2352-2354)
    if (!spec.affectsUser && baseEffectNum <= MOVE_EFFECT_CONFUSION) {
      const effectSide = effectBattlerId & 1
      if (hasFlag(state.sides[effectSide].statuses, SIDE_STATUS_SAFEGUARD)) {
        continue
      }
    }

    // 3. TestSheerForceFlag (:2361)
    if (testSheerForceFlag(state, attackerId, moveId, deps)) {
      continue
    }

    // 4. DoesSubstituteBlockMove (:2388)
    if (!spec.affectsUser && doesSubstituteBlockMove(state, attackerId, effectBattlerId, moveId, deps)) {
      continue
    }

    // Flinch: MOVE_EFFECT_FLINCH (battle_script_commands.c:2665-2669)
    if (baseEffectNum === MOVE_EFFECT_FLINCH) {
      if (!isAbilityStatusProtected(state, effectBattlerId, CHECK_FLINCH, attackerId, deps)) {
        effectBattler.mon.status2 = setFlag(effectBattler.mon.status2, STATUS2_FLINCHED)
      }
      continue
    }

    // Stat changes: MOVE_EFFECT_ALL_STATS_UP (battle_script_commands.c:2832-2836, battle_scripts_1.s:7891-7925)
    if (baseEffectNum === MOVE_EFFECT_ALL_STATS_UP) {
      const statsToBoost = [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]
      const canBoost = statsToBoost.some(
        (s) => (effectBattler.mon.statStages[s] ?? DEFAULT_STAT_STAGE) < MAX_STAT_STAGE,
      )
      if (canBoost) {
        for (const statId of statsToBoost) {
          const res = changeStatBuffsImplicit(
            state,
            attackerId,
            targetId,
            1,
            statId,
            MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
            true,
            deps,
            unmodelled,
            moveId,
          )
          if (res.delta !== 0) {
            statChanges.push({
              battlerId: attackerId,
              stat: statId,
              change: res.delta,
            })
          }
        }
      }
      continue
    }

    // Stat changes: MOVE_EFFECT_*_PLUS_1 (battle_script_commands.c:2751-2764)
    if (baseEffectNum >= MOVE_EFFECT_ATK_PLUS_1 && baseEffectNum <= MOVE_EFFECT_EVS_PLUS_1) {
      const statId = baseEffectNum - MOVE_EFFECT_ATK_PLUS_1 + 1
      const flags = (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) | STAT_BUFF_UPDATE_MOVE_EFFECT
      const res = changeStatBuffsImplicit(
        state,
        attackerId,
        targetId,
        1,
        statId,
        flags,
        false,
        deps,
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        statChanges.push({
          battlerId: effectBattlerId,
          stat: statId,
          change: res.delta,
        })
      }
      continue
    }

    // Stat changes: MOVE_EFFECT_*_MINUS_1 (battle_script_commands.c:2765-2781)
    if (baseEffectNum >= MOVE_EFFECT_ATK_MINUS_1 && baseEffectNum <= MOVE_EFFECT_EVS_MINUS_1) {
      const statId = baseEffectNum - MOVE_EFFECT_ATK_MINUS_1 + 1
      const flags = (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) | STAT_BUFF_UPDATE_MOVE_EFFECT
      const res = changeStatBuffsImplicit(
        state,
        attackerId,
        targetId,
        -1,
        statId,
        flags,
        true,
        deps,
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        statChanges.push({
          battlerId: effectBattlerId,
          stat: statId,
          change: res.delta,
        })
      }
      if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (attackerId & 1) !== (targetId & 1)) {
        dispatchOnStatLowered(state, targetId, attackerId, deps, unmodelled, statChanges)
      }
      continue
    }

    // Stat changes: MOVE_EFFECT_*_PLUS_2 (battle_script_commands.c:2782-2795)
    if (baseEffectNum >= MOVE_EFFECT_ATK_PLUS_2 && baseEffectNum <= MOVE_EFFECT_EVS_PLUS_2) {
      const statId = baseEffectNum - MOVE_EFFECT_ATK_PLUS_2 + 1
      const flags = (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) | STAT_BUFF_UPDATE_MOVE_EFFECT
      const res = changeStatBuffsImplicit(
        state,
        attackerId,
        targetId,
        2,
        statId,
        flags,
        false,
        deps,
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        statChanges.push({
          battlerId: effectBattlerId,
          stat: statId,
          change: res.delta,
        })
      }
      continue
    }

    // Stat changes: MOVE_EFFECT_*_MINUS_2 (battle_script_commands.c:2796-2812)
    if (baseEffectNum >= MOVE_EFFECT_ATK_MINUS_2 && baseEffectNum <= MOVE_EFFECT_EVS_MINUS_2) {
      const statId = baseEffectNum - MOVE_EFFECT_ATK_MINUS_2 + 1
      const flags = (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) | STAT_BUFF_UPDATE_MOVE_EFFECT
      const res = changeStatBuffsImplicit(
        state,
        attackerId,
        targetId,
        -2,
        statId,
        flags,
        true,
        deps,
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        statChanges.push({
          battlerId: effectBattlerId,
          stat: statId,
          change: res.delta,
        })
      }
      if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (attackerId & 1) !== (targetId & 1)) {
        dispatchOnStatLowered(state, targetId, attackerId, deps, unmodelled, statChanges)
      }
      continue
    }

    // Primary status effects and confusion (battle_script_commands.c:2390-2580, 2655-2664)
    const certainForStatus = spec.certain || percentChance >= 100
    const res = applyPrimaryStatusEffect(
      state,
      attackerId,
      targetId,
      effectNumWithFlags,
      moveId,
      deps,
      unmodelled,
      false,
      certainForStatus,
    )
    if (res.applied && res.status) {
      statusAppliedOutcome = {
        battlerId: effectBattlerId,
        status: res.status,
      }
    }
  }

  return {
    statusApplied: statusAppliedOutcome,
    statChanges,
    moveEffect2,
  }
}
