// Move effect dispatch and status move handlers.
//
// A handled effect's handler owns the execution of its script after attackcanceler.
// Status setup moves (e.g. Swords Dance, Belly Drum) do not roll accuracy in the C,
// deduct PP after attackcanceler, and apply stat changes/HP modifications directly.

import type { BattleState, BattlerState, QueuedSwitchAction } from './state'
import type { ChosenAction, TurnOrder } from './turnOrder'
import type { ActionOutcome, StatChangeOutcome, StatusAppliedOutcome, TurnLoopDeps } from './turn'
import { buildAccuracyInputs, getMoveTarget, getTotalAccuracy, isBattlerAlive, isBattlerProtected, performSwitchAction, ProtectType } from './turn'
import { gapsToUnmodelled } from './bridge'
import { hasLiveReserve } from './switchIn'
import {
  BATTLER_NONE,
  BATTLE_TYPE_ARENA,
  B_SIDE_PLAYER,
  DEFAULT_STAT_STAGE,
  ENUM_WEATHER_FOG,
  ENUM_WEATHER_HAIL,
  ENUM_WEATHER_RAIN,
  ENUM_WEATHER_SANDSTORM,
  ENUM_WEATHER_SUN,
  MAX_MON_MOVES,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  MOVE_UNSET,
  NUM_BATTLE_STATS,
  PARTY_SIZE,
  RESOURCE_FLAG_ROOST,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_CRAFTY_SHIELD,
  SIDE_STATUS_FUTUREATTACK,
  SIDE_STATUS_HAZARDS_ANY,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_LUCKY_CHANT,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_MIST,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SCREEN_ANY,
  SIDE_STATUS_SMOKESCREEN,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_TAILWIND,
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
  STATUS1_POISON_ANY,
  STATUS1_SLEEP,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS2_CONFUSION,
  STATUS2_CURSED,
  STATUS2_DEFENSE_CURL,
  STATUS2_DESTINY_BOND,
  STATUS2_ENRAGED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_FLINCHED,
  STATUS2_MULTIPLETURNS,
  STATUS2_NIGHTMARE,
  STATUS2_POWDER,
  STATUS2_SUBSTITUTE,
  STATUS2_TORMENT,
  STATUS2_TRANSFORMED,
  STATUS2_WRAPPED,
  STATUS3_ALWAYS_HITS,
  STATUS3_ALWAYS_HITS_TURN,
  STATUS3_AQUA_RING,
  STATUS3_CHARGED_UP,
  STATUS3_GASTRO_ACID,
  STATUS3_GRUDGE,
  STATUS3_EMBARGO,
  STATUS3_HEAL_BLOCK,
  STATUS3_IMPRISONED_OTHERS,
  STATUS3_LASER_FOCUS,
  STATUS3_LEECHSEED,
  STATUS3_MAGNET_RISE,
  STATUS3_ME_FIRST,
  STATUS3_MIRACLE_EYED,
  STATUS3_MINIMIZED,
  STATUS3_ON_AIR,
  STATUS3_PERISH_SONG,
  STATUS3_POWER_TRICK,
  STATUS3_ROOTED,
  STATUS3_SEMI_INVULNERABLE,
  STATUS3_SMACKED_DOWN,
  STATUS3_TELEKINESIS,
  STATUS3_YAWN,
  STATUS4_COMMANDED,
  STATUS4_COILED,
  STATUS4_CUTTHROAT,
  STATUS4_ELECTRIFIED,
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
  STATUS_FIELD_FAIRY_LOCK,
  STATUS_FIELD_ION_DELUGE,
  STATUS_FIELD_MUDSPORT,
  STATUS_FIELD_WATERSPORT,
  SIDE_STATUS_STICKY_WEB,
  STATUS_FIELD_TERRAIN_ANY,
  TERRAIN_DURATION,
  TERRAIN_DURATION_EXTENDED,
  SCREEN_DURATION,
  SCREEN_DURATION_EXTENDED,
  SPORT_DURATION,
  QUASH_DURATION,
  GRAVITY_DURATION,
  INVERSE_ROOM_DURATION,
  MAGIC_ROOM_DURATION,
  TRICK_ROOM_DURATION,
  WONDER_ROOM_DURATION,
  WEATHER_FOG_ANY,
  WEATHER_FOG_PERMANENT,
  WEATHER_HAIL_ANY,
  WEATHER_PRIMAL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_ANY,
  clearFlag,
  hasFlag,
  setCounter,
  setFlag,
  STATUS2_RECHARGE,
  statusInfatuatedWith,
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
  STATUS3_LEECHSEED_BATTLER,
  MOVE_EFFECT_WRAP,
  MOVE_EFFECT_PREVENT_ESCAPE,
  MOVE_EFFECT_ATTRACT,
  MOVE_EFFECT_CURSE,
  MOVE_EFFECT_YAWN,
  MOVE_EFFECT_DRENCH,
  MOVE_EFFECT_STEALTH_ROCK,
  MOVE_EFFECT_CREEPING_THORNS,
  MOVE_EFFECT_SPIKES,
  MOVE_EFFECT_LEECH_SEED,
  MOVE_EFFECT_STICKY_WEB,
  MOVE_EFFECT_THRASH,
  STATUS2_LOCK_CONFUSE,
  MOVE_EFFECT_PAYDAY,
  MOVE_EFFECT_INCINERATE,
  MOVE_EFFECT_REMOVE_STATUS,
  MOVE_EFFECT_BURN_UP,
  MOVE_EFFECT_CLEAR_SMOG,
  MOVE_EFFECT_FLAME_BURST,
  MOVE_EFFECT_FEINT,
  MOVE_EFFECT_SPECTRAL_THIEF,
  MOVE_EFFECT_V_CREATE,
  MOVE_EFFECT_CORE_ENFORCER,
  MOVE_EFFECT_THROAT_CHOP,
  MOVE_EFFECT_TRAP_BOTH,
  MOVE_EFFECT_GLAIVE_RUSH,
  MOVE_EFFECT_SALT_CURE,
  MOVE_EFFECT_ORDER_UP,
  MOVE_EFFECT_WATER_PLEDGE,
  MOVE_EFFECT_FIRE_PLEDGE,
  MOVE_EFFECT_GRASS_PLEDGE,
  MOVE_EFFECT_RAINBOW,
  MOVE_EFFECT_FIRE_SEA,
  MOVE_EFFECT_SWAMP,
  MOVE_EFFECT_SYRUP,
  MOVE_EFFECT_DIRE_CLAW,
  MOVE_EFFECT_FEAR,
  MOVE_EFFECT_PSYCHIC_NOISE,
  PLEDGE_DURATION,
  STATUS4_SALT_CURE,
} from './constants'
import {
  MOVE_EFFECT_AFFECTS_USER,
  MOVE_EFFECT_CERTAIN,
  STAT_BUFF_ALLOW_PTR,
  STAT_BUFF_NOT_PROTECT_AFFECTED,
  STAT_BUFF_UPDATE_MOVE_EFFECT,
  attackerHasMoldBreakerActive,
  B_MSG_DEFENDER_STAT_FELL,
  battlerHasSimAbility,
  benefitsFromStatBuffs,
  canRaiseStat,
  changeStatBuffs,
  changeStatBuffsImplicit,
  consumeHeldItem,
  dispatchOnStatLowered,
  getHighestAttackingStatId,
  getHighestStatIdExcept,
  isBattlerWeatherAffected,
  isUnnerveAbilityOnOpposingSide,
  RESET_ALL_STATS,
  tryResetBattlerStatChanges,
} from './statBuffs'
import {
  canBattlerHeal,
  CUD_CHEW_ACTIVATING,
  CUD_CHEW_SET_THIS_TURN,
  getAbilityStateOf,
  isHealingBlocked,
  isMagicGuardProtected,
  setAbilityStateOf,
} from './endTurn'
import { isBattlerGrounded } from './grounding'
import { tryChangeBattleWeather, trySetStickyWeb, trySetTailwind } from './switchInAbility'
import { dispatchOnTerrainChange, dispatchOnWeatherChange } from './onWeather'
import { syncPartyHp } from './outcome'
import { rapidSpinFree } from './hazards'
import { attackPreModify, calculateBattleStat, spAttackPreModify } from '../battleStat'
import type { SimDataContext } from './dataContext'
import type { MoveBehaviors } from '../basePower'
import type { StatusCheck } from './statusEffects'
import {
  CHECK_CONFUSION,
  CHECK_FLINCH,
  MOVE_EFFECT_BLEED,
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_CONFUSION,
  MOVE_EFFECT_ENRAGE,
  MOVE_EFFECT_FLINCH,
  MOVE_EFFECT_FREEZE,
  MOVE_EFFECT_FROSTBITE,
  MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES,
  MOVE_EFFECT_NIGHTMARE,
  MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_POISON,
  MOVE_EFFECT_SLEEP,
  MOVE_EFFECT_TOXIC,
  MOVE_EFFECT_TRI_ATTACK,
  applyAttractEffect,
  applyDrenchEffect,
  applyFearEffect,
  applyPrimaryStatusEffect,
  canBeBurned,
  canBeConfused,
  canBeDrenched,
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
  isMyceliumMightActive,
  isPreventableSecondaryEffect,
  setOnMoveEffectReactionFlags,
  testSheerForceFlag,
  type StatusDeps,
} from './statusEffects'
import { applySwitchInAbilities, getIllusionMonPtr } from './switchInAbility'
import {
  isEntrainmentBannedAbilityAttacker,
  isEntrainmentTargetOrSimpleBeamBannedAbility,
  isRolePlayBannedAbility,
  isRolePlayBannedAbilityAtk,
  isWorrySeedBannedAbility,
} from './ai/aiAbilityHelpers'
import { uq } from '../fixed'
import { getTypeModifier, type TypeModifierInputs } from '../typeEffectiveness'
import { TYPE_NAME_BY_ID } from './hazards'
import { METRONOME_MOVES, MOVES_COUNT } from './metronomeMoves'

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
  /** turn.ts's applyDamage, including its optional 5th argument: Cmd_tryfaintmon's onRevive
   * scan (battle_script_commands.c:3184-3197) needs a data context / grounding for
   * IsSuppressed and IsBattlerWeatherAffected. */
  applyDamage: (
    state: BattleState,
    battlerId: number,
    damage: number | null,
    fainted: number[],
    deps?: TurnLoopDeps,
  ) => void
  /**
   * Sets gChosenMove (src/battle_script_commands.c:10483, 10836) for the current action.
   * Transform and Sketch set gChosenMove = 0xFFFF (MOVE_UNSET).
   */
  setChosenMove?: (moveId: string) => void
  /**
   * Cmd_jumptocalledmove (battle_script_commands.c:5906-5914):
   * Re-enters move pipeline for calledMoveId within the same action.
   * keepChosenMove is true when operand is TRUE (gCurrentMove = gCalledMove, preserving gChosenMove).
   */
  jumpToCalledMove?: (calledMoveId: string, keepChosenMove?: boolean, targetId?: number | null) => ActionOutcome
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
      applyDamage(state, battlerId, halfHp, fainted, deps)
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
  // or BattleScript_ButItFailedAtkStringPpReduce (data/battle_scripts_1.s:5938-5939)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // BattleScript_EffectMatBlock (data/battle_scripts_1.s:5029-5032): jumpifnotfirstturn BattleScript_ButItFailedAtkStringPpReduce
  // (Cmd_jumpifnotfirstturn, src/battle_script_commands.c:9439-9446)
  // isFirstTurn is decremented at end of turn (TurnValuesCleanUp, src/battle_main.c:4491).
  if (moveEffect === 'EFFECT_MAT_BLOCK' && !battler.volatiles.isFirstTurn) {
    return outcome(ctx, { missed: true })
  }

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

  startTailwind(state, battlerId, moveId, deps, unmodelled)
  return outcome(ctx, {})
}

/** Cmd_settailwind + BattleScript_OnTailwindStart, shared by Tailwind itself and by Bleakwind Storm's EFFECT_TAILWIND_HIT. False when it was already up. */
export function startTailwind(state: BattleState, battlerId: number, moveId: string, deps: TurnLoopDeps, unmodelled: string[]): boolean {
  const side = battlerId & 1
  if (!trySetTailwind(state, side, battlerId, 3)) {
    return false
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

  return true
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

  state.stickyWebUser = battlerId // Cmd_setstickyweb, battle_script_commands.c:11469 ("For Mirror Armor")

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
 * (data/battle_scripts_1.s:9947-9955, VARIOUS_ON_TERRAIN_CHANGE) -- Quark Drive is ported; others unmodelled. */
const ON_TERRAIN_UNMODELLED_ABILITIES = [
  'ABILITY_DRAKELP_HEAD', 'ABILITY_ENERGIZED', 'ABILITY_GENERATOR', 'ABILITY_HARUKAZE',
  'ABILITY_MIMICRY', 'ABILITY_TOXIC_BOOST',
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
  if (!setFieldTerrain(state, battlerId, terrainFlag, deps, unmodelled)) return outcome(ctx, { missed: true })
  return outcome(ctx, {})
}

/** HandleTerrainMove's setting half (src/battle_script_commands.c:6451-6462) plus BattleScript_OnTerrainChanged. False when that terrain is already up. */
export function setFieldTerrain(state: BattleState, battlerId: number, terrainFlag: number, deps: TurnLoopDeps, unmodelled: string[]): boolean {
  if (hasFlag(state.field.statuses, terrainFlag)) return false

  state.field.statuses = setFlag(clearFlag(state.field.statuses, STATUS_FIELD_TERRAIN_ANY), terrainFlag)
  state.field.timers.started.terrain = true
  state.field.timers.terrainBattlerId = battlerId
  state.field.timers.terrainTimer =
    deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_TERRAIN_EXTENDER' ? TERRAIN_DURATION_EXTENDED : TERRAIN_DURATION

  dispatchOnTerrainChange(state, deps, unmodelled)

  for (let i = 0; i < state.battlersCount; i++) {
    const b = state.battlers[i]
    const held = b && ON_TERRAIN_UNMODELLED_ABILITIES.find((id) => battlerHasSimAbility(state, b, id, false, i, false, deps.dataContext))
    if (held) unmodelled.push(`battler ${i}: ${held}'s onTerrain reaction (BattleScript_OnTerrainChanged, battle_scripts_1.s:9947-9955) is not applied`)
  }
  return true
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
    applyDamage(state, battlerId, hpCost, fainted, deps)

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

  // The KO trigger lives in turn.ts (Cmd_tryfaintmon, battle_script_commands.c:3244-3248).
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
    const slotU = findAbilitySlot(battler.mon.abilities, 'ABILITY_UNBURDEN')
    if (slotU !== -1) battler.volatiles.abilityState[slotU] = 0
    const slotS = findAbilitySlot(battler.mon.abilities, 'ABILITY_SUGAR_RUSH')
    if (slotS !== -1) battler.volatiles.abilityState[slotS] = 0
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
  // SetEncore (:10749) tests only encoredMove == 0, never encoreTimer.
  if (
    target.volatiles.encoredMove !== null ||
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
  applyDamage(state, battlerId, damage, fainted, ctx.deps)

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
 * EFFECT_FUTURE_SIGHT handler (Future Sight, Doom Desire).
 * BattleScript_EffectFutureSight, data/battle_scripts_1.s:5692-5701:
 * attackcanceler, attackstring, ppreduce (:5696), trysetfutureattack
 * BattleScript_ButItFailed (:5697), animation, message, goto BattleScript_MoveEnd.
 * There is no accuracy check and no damage on the use turn.
 * Cmd_trysetfutureattack, src/battle_script_commands.c:11483-11500.
 */
function handleFutureSight(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const chosenMove = action.chosenMove!
  // gCurrentMove, which Cmd_trysetfutureattack records -- not gChosenMove (they differ
  // when this effect is reached through Metronome / Mirror Move).
  const currentMove = action.moveToBeUsed ?? chosenMove

  // 1. ppreduce (:5696) -- before trysetfutureattack, so a failed re-use still costs PP.
  deductPp(state, battlerId, chosenMove.id, chosenMove.effect, unmodelled)

  // 2. trysetfutureattack BattleScript_ButItFailed (:5697, Cmd_trysetfutureattack:11483-11486).
  //    The counter is per TARGET battler (:11484), not per side.
  if (targetId === null || !state.battlers[targetId] || state.field.futureSightCounter[targetId] !== 0) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. gSideStatuses[GET_BATTLER_SIDE(gBattlerTarget)] |= SIDE_STATUS_FUTUREATTACK; then
  //    futureSightMove/Power/Attacker/Counter (:11487-11491). The power is
  //    gBattleMoves[gCurrentMove].power -- the move table, recorded now and not re-read later.
  const side = targetId & 1
  state.sides[side].statuses = setFlag(state.sides[side].statuses, SIDE_STATUS_FUTUREATTACK)
  state.field.futureSightMove[targetId] = currentMove.id
  state.field.futureSightPower[targetId] = deps.dataContext.move(currentMove.id)?.power ?? currentMove.power ?? 0
  state.field.futureSightAttacker[targetId] = battlerId
  state.field.futureSightCounter[targetId] = 3

  return outcome(ctx, { targetId })
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

/**
 * Accuracy check helper for NO_ACC_CALC_CHECK_LOCK_ON (Cmd_accuracycheck, battle_script_commands.c:1403-1411).
 * Used by Pain Split, Power/Guard/Speed/Heart Swap, Power/Guard Split, Topsy-Turvy.
 */
function checkNoAccCalcLockOn(ctx: MoveEffectContext, targetId: number): { failed: boolean; missed: boolean } {
  const { state, battlerId, deps, unmodelled, turnOrderIndex, order } = ctx
  const target = state.battlers[targetId]!
  const lockedOn = hasFlag(target.statuses3, STATUS3_ALWAYS_HITS) && target.volatiles.battlerWithSureHit === battlerId
  if (lockedOn) return { failed: false, missed: false }
  if (hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)) return { failed: true, missed: true }
  const targetIndex = order ? order.battlerByTurnOrder.indexOf(targetId) : -1
  const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < turnOrderIndex
  const protectType = isBattlerProtected(state, battlerId, targetId, 'MOVE_NONE', targetHasActedThisTurn, deps, unmodelled)
  if ((protectType & ProtectType.PROTECT_BLOCK) !== 0) return { failed: true, missed: true }
  return { failed: false, missed: false }
}

/**
 * EFFECT_PSYCH_UP handler (Psych Up).
 * BattleScript_EffectPsychUp (data/battle_scripts_1.s:5644-5653),
 * Cmd_copyfoestats (src/battle_script_commands.c:11356-11365).
 */
function handlePsychUp(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // Cmd_copyfoestats:11360-11362 copies statStages[0..NUM_BATTLE_STATS-1].
  const statChanges: StatChangeOutcome[] = []
  for (let i = 0; i < NUM_BATTLE_STATS; i++) {
    const targetStage = target.mon.statStages[i] ?? DEFAULT_STAT_STAGE
    const currentStage = battler.mon.statStages[i] ?? DEFAULT_STAT_STAGE
    battler.mon.statStages[i] = targetStage
    const delta = targetStage - currentStage
    if (i >= STAT_ATK && i <= STAT_EVASION && delta !== 0) {
      statChanges.push({ battlerId, stat: i, change: delta })
    }
  }

  return outcome(ctx, { targetId, statChanges })
}

/**
 * EFFECT_POWER_SWAP handler (Power Swap).
 * BattleScript_EffectPowerSwap (data/battle_scripts_1.s:2504-2518),
 * Cmd_swapstatstages (src/battle_script_commands.c:13039-13048),
 * VARIOUS_SWAP_STAT (:8879-8885).
 */
function handlePowerSwap(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) return outcome(ctx, { targetId, missed: acc.missed })

  // swapstatstages STAT_ATK, STAT_SPATK
  const statChanges: StatChangeOutcome[] = []
  for (const stat of [STAT_ATK, STAT_SPATK]) {
    const atkStage = battler.mon.statStages[stat] ?? DEFAULT_STAT_STAGE
    const defStage = target.mon.statStages[stat] ?? DEFAULT_STAT_STAGE
    battler.mon.statStages[stat] = defStage
    target.mon.statStages[stat] = atkStage
    if (defStage - atkStage !== 0) {
      statChanges.push({ battlerId, stat, change: defStage - atkStage })
    }
    if (atkStage - defStage !== 0) {
      statChanges.push({ battlerId: targetId, stat, change: atkStage - defStage })
    }
  }

  // swapstat BS_TARGET, STAT_ATK, STAT_SPATK: swaps rawStats.atk and rawStats.spatk
  const tempAtk = battler.mon.rawStats.atk
  battler.mon.rawStats.atk = target.mon.rawStats.atk
  target.mon.rawStats.atk = tempAtk

  const tempSpAtk = battler.mon.rawStats.spatk
  battler.mon.rawStats.spatk = target.mon.rawStats.spatk
  target.mon.rawStats.spatk = tempSpAtk

  return outcome(ctx, { targetId, statChanges })
}

/**
 * EFFECT_GUARD_SWAP handler (Guard Swap).
 * BattleScript_EffectGuardSwap (data/battle_scripts_1.s:2519-2533),
 * Cmd_swapstatstages (src/battle_script_commands.c:13039-13048),
 * VARIOUS_SWAP_STAT (:8879-8885).
 */
function handleGuardSwap(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) return outcome(ctx, { targetId, missed: acc.missed })

  // swapstatstages STAT_DEF, STAT_SPDEF
  const statChanges: StatChangeOutcome[] = []
  for (const stat of [STAT_DEF, STAT_SPDEF]) {
    const atkStage = battler.mon.statStages[stat] ?? DEFAULT_STAT_STAGE
    const defStage = target.mon.statStages[stat] ?? DEFAULT_STAT_STAGE
    battler.mon.statStages[stat] = defStage
    target.mon.statStages[stat] = atkStage
    if (defStage - atkStage !== 0) {
      statChanges.push({ battlerId, stat, change: defStage - atkStage })
    }
    if (atkStage - defStage !== 0) {
      statChanges.push({ battlerId: targetId, stat, change: atkStage - defStage })
    }
  }

  // swapstat BS_TARGET, STAT_DEF, STAT_SPDEF: swaps rawStats.def and rawStats.spdef
  const tempDef = battler.mon.rawStats.def
  battler.mon.rawStats.def = target.mon.rawStats.def
  target.mon.rawStats.def = tempDef

  const tempSpDef = battler.mon.rawStats.spdef
  battler.mon.rawStats.spdef = target.mon.rawStats.spdef
  target.mon.rawStats.spdef = tempSpDef

  return outcome(ctx, { targetId, statChanges })
}

/**
 * EFFECT_SPEED_SWAP handler (Speed Swap).
 * BattleScript_EffectSpeedSwap (data/battle_scripts_1.s:2534-2545),
 * Cmd_swapstatstages (src/battle_script_commands.c:13039-13048),
 * VARIOUS_SWAP_STAT (:8879-8885).
 */
function handleSpeedSwap(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) return outcome(ctx, { targetId, missed: acc.missed })

  // swapstatstages STAT_SPEED
  const statChanges: StatChangeOutcome[] = []
  const atkStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
  const defStage = target.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
  battler.mon.statStages[STAT_SPEED] = defStage
  target.mon.statStages[STAT_SPEED] = atkStage
  if (defStage - atkStage !== 0) {
    statChanges.push({ battlerId, stat: STAT_SPEED, change: defStage - atkStage })
  }
  if (atkStage - defStage !== 0) {
    statChanges.push({ battlerId: targetId, stat: STAT_SPEED, change: atkStage - defStage })
  }

  // swapstat BS_TARGET, STAT_SPEED: swaps rawStats.spe
  const tempSpe = battler.mon.rawStats.spe
  battler.mon.rawStats.spe = target.mon.rawStats.spe
  target.mon.rawStats.spe = tempSpe

  return outcome(ctx, { targetId, statChanges })
}

/**
 * EFFECT_HEART_SWAP handler (Heart Swap).
 * BattleScript_EffectHeartSwap (data/battle_scripts_1.s:2486-2503),
 * Cmd_swapstatstages (src/battle_script_commands.c:13039-13048).
 */
function handleHeartSwap(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) return outcome(ctx, { targetId, missed: acc.missed })

  // swapstatstages: STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF, STAT_EVASION, STAT_ACC
  const statsToSwap = [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF, STAT_EVASION, STAT_ACC]
  const statChanges: StatChangeOutcome[] = []
  for (const stat of statsToSwap) {
    const atkStage = battler.mon.statStages[stat] ?? DEFAULT_STAT_STAGE
    const defStage = target.mon.statStages[stat] ?? DEFAULT_STAT_STAGE
    battler.mon.statStages[stat] = defStage
    target.mon.statStages[stat] = atkStage
    if (defStage - atkStage !== 0) {
      statChanges.push({ battlerId, stat, change: defStage - atkStage })
    }
    if (atkStage - defStage !== 0) {
      statChanges.push({ battlerId: targetId, stat, change: atkStage - defStage })
    }
  }

  return outcome(ctx, { targetId, statChanges })
}

/**
 * EFFECT_POWER_SPLIT handler (Power Split).
 * BattleScript_EffectPowerSplit (data/battle_scripts_1.s:2460-2472),
 * Cmd_averagestats (src/battle_script_commands.c:13050-13060).
 */
function handlePowerSplit(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) return outcome(ctx, { targetId, missed: acc.missed })

  // averagestats STAT_ATK, STAT_SPATK (rawStats)
  const avgAtk = Math.trunc((battler.mon.rawStats.atk + target.mon.rawStats.atk) / 2)
  battler.mon.rawStats.atk = avgAtk
  target.mon.rawStats.atk = avgAtk

  const avgSpAtk = Math.trunc((battler.mon.rawStats.spatk + target.mon.rawStats.spatk) / 2)
  battler.mon.rawStats.spatk = avgSpAtk
  target.mon.rawStats.spatk = avgSpAtk

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_GUARD_SPLIT handler (Guard Split).
 * BattleScript_EffectGuardSplit (data/battle_scripts_1.s:2473-2485),
 * Cmd_averagestats (src/battle_script_commands.c:13050-13060).
 */
function handleGuardSplit(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) return outcome(ctx, { targetId, missed: acc.missed })

  // averagestats STAT_DEF, STAT_SPDEF (rawStats)
  const avgDef = Math.trunc((battler.mon.rawStats.def + target.mon.rawStats.def) / 2)
  battler.mon.rawStats.def = avgDef
  target.mon.rawStats.def = avgDef

  const avgSpDef = Math.trunc((battler.mon.rawStats.spdef + target.mon.rawStats.spdef) / 2)
  battler.mon.rawStats.spdef = avgSpDef
  target.mon.rawStats.spdef = avgSpDef

  return outcome(ctx, { targetId })
}

/**
 * EFFECT_TOPSY_TURVY handler (Topsy-Turvy).
 * BattleScript_EffectTopsyTurvy (data/battle_scripts_1.s:2208-2227),
 * VARIOUS_INVERT_STAT_STAGES (src/battle_script_commands.c:7290-7297).
 */
function handleTopsyTurvy(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) return outcome(ctx, { targetId, missed: acc.missed })

  // jumpifstat checks: fails if ALL 7 stat stages == 6 (DEFAULT_STAT_STAGE)
  const statsToCheck = [STAT_ATK, STAT_DEF, STAT_SPATK, STAT_SPDEF, STAT_SPEED, STAT_ACC, STAT_EVASION]
  const anyNonNeutral = statsToCheck.some((s) => (target.mon.statStages[s] ?? DEFAULT_STAT_STAGE) !== DEFAULT_STAT_STAGE)
  if (!anyNonNeutral) {
    return outcome(ctx, { targetId, missed: true })
  }

  // invertstatstages BS_TARGET: 0..NUM_BATTLE_STATS-1
  const statChanges: StatChangeOutcome[] = []
  for (let i = 0; i < NUM_BATTLE_STATS; i++) {
    const cur = target.mon.statStages[i] ?? DEFAULT_STAT_STAGE
    let next = cur
    if (cur < DEFAULT_STAT_STAGE) {
      next = DEFAULT_STAT_STAGE + (DEFAULT_STAT_STAGE - cur)
    } else if (cur > DEFAULT_STAT_STAGE) {
      next = DEFAULT_STAT_STAGE - (cur - DEFAULT_STAT_STAGE)
    }
    target.mon.statStages[i] = next
    if (i >= STAT_ATK && i <= STAT_EVASION && next - cur !== 0) {
      statChanges.push({ battlerId: targetId, stat: i, change: next - cur })
    }
  }

  return outcome(ctx, { targetId, statChanges })
}

/**
 * EFFECT_ACUPRESSURE handler (Acupressure).
 * BattleScript_EffectAcupressure (data/battle_scripts_1.s:1243-1259),
 * VARIOUS_ACUPRESSURE (src/battle_script_commands.c:6913-6928).
 */
function handleAcupressure(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const actualTargetId = targetId !== null ? targetId : battlerId
  const target = state.battlers[actualTargetId]
  if (!target || target.mon.hp === 0) {
    return outcome(ctx, { targetId: actualTargetId })
  }

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // jumpifstatus2 BS_TARGET, STATUS2_SUBSTITUTE, BattleScript_PrintMoveMissed (only if target != attacker)
  if (actualTargetId !== battlerId && hasFlag(target.mon.status2, STATUS2_SUBSTITUTE)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId: actualTargetId, missed: true })
  }

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // VARIOUS_ACUPRESSURE: bits = 0; for (i = STAT_ATK; i < NUM_BATTLE_STATS; i++) if (stage < MAX_STAT_STAGE) bits |= (1 << i);
  let bits = 0
  for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
    const stage = target.mon.statStages[i] ?? DEFAULT_STAT_STAGE
    if (stage < MAX_STAT_STAGE) {
      bits |= (1 << i)
    }
  }

  if (bits === 0) {
    return outcome(ctx, { targetId: actualTargetId, missed: true })
  }

  // do { statId = (Random() % (NUM_BATTLE_STATS - 1)) + 1; } while (!(bits & (1 << statId)));
  let statId: number
  do {
    statId = (state.rng.random16() % (NUM_BATTLE_STATS - 1)) + 1
  } while ((bits & (1 << statId)) === 0)

  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    actualTargetId,
    2,
    statId,
    MOVE_EFFECT_CERTAIN,
    false,
    deps,
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId: actualTargetId, stat: statId, change: res.delta })
  }

  return outcome(ctx, { targetId: actualTargetId, statChanges })
}

/**
 * EFFECT_CLANGOROUS_SOUL handler (Clangorous Soul).
 * BattleScript_EffectClangorousSoul (data/battle_scripts_1.s:245-257),
 * VARIOUS_CUT_1_3_HP_RAISE_STATS (src/battle_script_commands.c:8089-8106),
 * BattleScript_AllStatsUp (data/battle_scripts_1.s:7891-7925).
 */
function handleClangorousSoul(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp, applyDamage } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const hpFraction = Math.max(1, Math.trunc(battler.mon.maxHp / 3))
  const statsToBoost = [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]
  const atLeastOneStatBoosted = statsToBoost.some(
    (s) => (battler.mon.statStages[s] ?? DEFAULT_STAT_STAGE) < MAX_STAT_STAGE,
  )

  if (!atLeastOneStatBoosted || battler.mon.hp <= hpFraction) {
    return outcome(ctx, { missed: true })
  }

  const fainted: number[] = []
  applyDamage(state, battlerId, hpFraction, fainted, deps)

  const statChanges: StatChangeOutcome[] = []
  for (const statId of statsToBoost) {
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      statId,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (res.delta !== 0) {
      statChanges.push({ battlerId, stat: statId, change: res.delta })
    }
  }

  return outcome(ctx, { attackerDamage: hpFraction, statChanges, fainted })
}

/**
 * EFFECT_FILLET_AWAY handler (Fillet Away).
 * BattleScript_EffectFilletAway (data/battle_scripts_1.s:5606-5642),
 * VARIOUS_TRY_LOSE_PERCENT_HP (src/battle_script_commands.c:8310-8324).
 */
function handleFilletAway(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp, applyDamage } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const statsToBoost = [STAT_ATK, STAT_SPATK, STAT_SPEED]
  const atLeastOneStatBoosted = statsToBoost.some(
    (s) => (battler.mon.statStages[s] ?? DEFAULT_STAT_STAGE) < MAX_STAT_STAGE,
  )
  if (!atLeastOneStatBoosted) {
    return outcome(ctx, { missed: true })
  }

  // VARIOUS_TRY_LOSE_PERCENT_HP 50: checks current hp <= 1
  if (battler.mon.hp <= 1) {
    return outcome(ctx, { missed: true })
  }

  let hpLost = Math.trunc((battler.mon.hp * 50) / 100)
  if (hpLost === 0) hpLost = 1

  const fainted: number[] = []
  applyDamage(state, battlerId, hpLost, fainted, deps)

  const statChanges: StatChangeOutcome[] = []
  for (const statId of statsToBoost) {
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      2,
      statId,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (res.delta !== 0) {
      statChanges.push({ battlerId, stat: statId, change: res.delta })
    }
  }

  return outcome(ctx, { attackerDamage: hpLost, statChanges, fainted })
}

/**
 * EFFECT_NO_RETREAT handler (No Retreat).
 * BattleScript_EffectNoRetreat (data/battle_scripts_1.s:338-354),
 * VARIOUS_TRY_NO_RETREAT (src/battle_script_commands.c:8126-8133),
 * BattleScript_AllStatsUp (:7891-7925).
 */
function handleNoRetreat(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:340); PrintMoveMissed runs ppreduce too.
  const missed = checkAccuracy(ctx, ctx.targetId ?? battlerId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { missed: true })

  // VARIOUS_TRY_NO_RETREAT: fails if already noRetreat or STATUS2_ESCAPE_PREVENTION
  if (battler.volatiles.noRetreat || hasFlag(battler.mon.status2, STATUS2_ESCAPE_PREVENTION)) {
    return outcome(ctx, { missed: true })
  }
  battler.volatiles.noRetreat = true

  // BattleScript_AllStatsUp
  const statsToBoost = [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]
  const statChanges: StatChangeOutcome[] = []
  for (const statId of statsToBoost) {
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      statId,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (res.delta !== 0) {
      statChanges.push({ battlerId, stat: statId, change: res.delta })
    }
  }

  // jumpifstatus4 BS_TARGET, STATUS4_COMMANDED, BattleScript_MoveEnd
  // jumpifstatus2 BS_TARGET, STATUS2_ESCAPE_PREVENTION, BattleScript_MoveEnd
  // setmoveeffect MOVE_EFFECT_PREVENT_ESCAPE -> STATUS2_ESCAPE_PREVENTION
  if (!hasFlag(battler.statuses4, STATUS4_COMMANDED) && !hasFlag(battler.mon.status2, STATUS2_ESCAPE_PREVENTION)) {
    battler.mon.status2 = setFlag(battler.mon.status2, STATUS2_ESCAPE_PREVENTION)
    battler.volatiles.battlerPreventingEscape = battlerId
  }

  return outcome(ctx, { statChanges })
}

/**
 * EFFECT_TIDY_UP handler (Tidy Up).
 * BattleScript_EffectTidyUp (data/battle_scripts_1.s:5440-5465).
 */
function handleTidyUp(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // setmoveeffect MOVE_EFFECT_RAPIDSPIN | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN
  // seteffectprimary -> BattleScriptCall(BattleScript_RapidSpinAway) -> rapidspinfree
  // C quirk: Upstream ER implements Tidy Up via MOVE_EFFECT_RAPIDSPIN, which only clears hazards/trapping
  // on the user's side; it does NOT clear substitutes (unlike vanilla Gen 9 Tidy Up).
  rapidSpinFree(state, battlerId)

  const statsToBoost = [STAT_ATK, STAT_SPEED]
  const canBoost = statsToBoost.some(
    (s) => (battler.mon.statStages[s] ?? DEFAULT_STAT_STAGE) < MAX_STAT_STAGE,
  )

  if (!canBoost) {
    return outcome(ctx, { missed: true })
  }

  const statChanges: StatChangeOutcome[] = []
  for (const statId of statsToBoost) {
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      1,
      statId,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (res.delta !== 0) {
      statChanges.push({ battlerId, stat: statId, change: res.delta })
    }
  }

  return outcome(ctx, { statChanges })
}

/**
 * EFFECT_VENOM_DRENCH handler (Venom Drench).
 * BattleScript_EffectVenomDrench (data/battle_scripts_1.s:1732-1765).
 */
function handleVenomDrench(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // jumpifstatus BS_TARGET, STATUS1_POISON_ANY
  // jumpifterrainaffected BS_TARGET, STATUS_FIELD_TOXIC_TERRAIN
  const isPoisoned = hasFlag(target.mon.status1, STATUS1_POISON | STATUS1_TOXIC_POISON)
  const isToxicTerrain = isBattlerTerrainAffected(state, targetId, STATUS_FIELD_TOXIC_TERRAIN, deps)
  if (!isPoisoned && !isToxicTerrain) {
    return outcome(ctx, { targetId, missed: true })
  }

  // jumpifstat checks: fails if Atk, SpAtk, Speed are ALL at MIN_STAT_STAGE
  const statsToDrop = [STAT_ATK, STAT_SPATK, STAT_SPEED]
  const canDrop = statsToDrop.some(
    (s) => (target.mon.statStages[s] ?? DEFAULT_STAT_STAGE) > MIN_STAT_STAGE,
  )
  if (!canDrop) {
    return outcome(ctx, { targetId, missed: true })
  }

  // accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE
  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  const statChanges: StatChangeOutcome[] = []
  for (const statId of statsToDrop) {
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      targetId,
      -1,
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
  }

  return outcome(ctx, { targetId, statChanges })
}

/**
 * EFFECT_TOXIC_THREAD handler (Toxic Thread).
 * BattleScript_EffectToxicThread (data/battle_scripts_1.s:1704-1730).
 */
function handleToxicThread(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // jumpifsubstituteblocks BattleScript_ButItFailedAtkStringPpReduce
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // jumpifstat BS_TARGET, CMP_NOT_EQUAL, STAT_SPEED, MIN_STAT_STAGE, BattleScript_ToxicThreadWorks
  // jumpifstatus BS_TARGET, STATUS1_POISON_ANY, BattleScript_ButItFailedAtkStringPpReduce
  const speedAtMin = (target.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE) === MIN_STAT_STAGE
  const isPoisoned = hasFlag(target.mon.status1, STATUS1_POISON | STATUS1_TOXIC_POISON)
  if (speedAtMin && isPoisoned) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE
  if (checkAccuracy(ctx, targetId, moveId)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // setstatchanger STAT_SPEED, 3, TRUE (ER drops Speed by 3)
  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -3,
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

  // setmoveeffect MOVE_EFFECT_POISON
  // seteffectprimary
  let statusApplied: StatusAppliedOutcome | null = null
  const psnRes = applyPrimaryStatusEffect(state, battlerId, targetId, MOVE_EFFECT_POISON, moveId, deps, unmodelled, true, false)
  if (psnRes.applied && psnRes.status) {
    statusApplied = { battlerId: targetId, status: psnRes.status }
  }

  return outcome(ctx, { targetId, statChanges, statusApplied })
}

/**
 * EFFECT_TAR_SHOT handler (Tar Shot).
 * BattleScript_EffectTarShot (data/battle_scripts_1.s:317-337),
 * VARIOUS_CAN_TAR_SHOT_WORK (src/battle_script_commands.c:8141-8146),
 * VARIOUS_TRY_TAR_SHOT (:8134-8140).
 */
function handleTarShot(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // jumpifsubstituteblocks BattleScript_ButItFailedAtkStringPpReduce
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE
  if (checkAccuracy(ctx, targetId, moveId)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // cantarshotwork -> VARIOUS_CAN_TAR_SHOT_WORK (battle_script_commands.c:8141-8146):
  // C bug: Upstream checks `tarShot || !CompareStat(STAT_SPEED, MAX_STAT_STAGE, CMP_LESS_THAN)`,
  // using MAX_STAT_STAGE instead of MIN_STAT_STAGE despite the comment stating it fails if speed
  // cannot be lowered further. Preserving C behavior as written.
  const speedStage = target.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE
  if (target.volatiles.tarShot || speedStage >= MAX_STAT_STAGE) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // setstatchanger STAT_SPEED, 1, TRUE
  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -1,
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

  // trytarshot BS_TARGET -> VARIOUS_TRY_TAR_SHOT (:8134-8140)
  target.volatiles.tarShot = true

  return outcome(ctx, { targetId, statChanges })
}

/**
 * EFFECT_SPICY_EXTRACT handler (Spicy Extract).
 * BattleScript_EffectSpicyExtract (data/battle_scripts_1.s:5155-5186).
 */
function handleSpicyExtract(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // jumpifsubstituteblocks BattleScript_MakeMoveMissed
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE
  if (checkAccuracy(ctx, targetId, moveId)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // jumpifstat BS_TARGET, CMP_LESS_THAN, STAT_ATK, MAX_STAT_STAGE
  // jumpifstat BS_TARGET, CMP_GREATER_THAN, STAT_DEF, MIN_STAT_STAGE
  // requirecandoeffect BS_TARGET, MOVE_EFFECT_CONFUSION
  const atkStage = target.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const defStage = target.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  if (atkStage >= MAX_STAT_STAGE && defStage <= MIN_STAT_STAGE && confusionBlocked(ctx, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  const statChanges: StatChangeOutcome[] = []
  // setstatchanger STAT_ATK, 2, FALSE
  const atkRes = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    2,
    STAT_ATK,
    STAT_BUFF_ALLOW_PTR,
    false,
    deps,
    unmodelled,
    moveId,
  )
  if (atkRes.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: atkRes.delta })
  }

  // setstatchanger STAT_DEF, 2, TRUE
  const defRes = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -2,
    STAT_DEF,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (defRes.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: STAT_DEF, change: defRes.delta })
  }
  // The script prints this drop from gStatUpStringIds (:5180) -- STRINGID_DEFENDERSSTATROSE, never the
  // STRINGID_DEFENDERSSTATFELL that runs onStatLowered (battle_util.c:1222), so no Defiant here.

  // setmoveeffect MOVE_EFFECT_CONFUSION
  // seteffectprimary
  let statusApplied: StatusAppliedOutcome | null = null
  const confRes = applyPrimaryStatusEffect(state, battlerId, targetId, MOVE_EFFECT_CONFUSION, moveId, deps, unmodelled, true, false)
  if (confRes.applied && confRes.status) {
    statusApplied = { battlerId: targetId, status: confRes.status }
  }

  return outcome(ctx, { targetId, statChanges, statusApplied })
}

/**
 * EFFECT_MEMENTO handler (Memento).
 * BattleScript_EffectMemento (data/battle_scripts_1.s:6111-6150),
 * Cmd_jumpifattackandspecialattackcannotfall (src/battle_script_commands.c:11590-11610),
 * Cmd_setatkhptozero (:9229-9238).
 */
function handleMemento(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp, applyDamage } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // Cmd_jumpifattackandspecialattackcannotfall (B_MEMENTO_FAIL == GEN_7):
  // Fails if target is protected, semi-invulnerable, or behind substitute. User does NOT faint.
  const targetIndex = ctx.order ? ctx.order.battlerByTurnOrder.indexOf(targetId) : -1
  const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < ctx.turnOrderIndex
  const protectType = isBattlerProtected(state, battlerId, targetId, moveId, targetHasActedThisTurn, deps, unmodelled)
  if ((protectType & ProtectType.PROTECT_BLOCK) !== 0) {
    // BattleScript_MementoFailProtect (:6145-6156): setatkhptozero and tryfaintmon still run.
    const userHp = battler.mon.hp
    const faintedOnProtect: number[] = []
    applyDamage(state, battlerId, userHp, faintedOnProtect, deps)
    return outcome(ctx, { targetId, missed: true, attackerDamage: userHp, fainted: faintedOnProtect })
  }
  if (hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)) {
    return outcome(ctx, { targetId, missed: true })
  }
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // User faints first via setatkhptozero (:9229-9238) / tryfaintmon (:6139)
  const userHp = battler.mon.hp
  const fainted: number[] = []
  applyDamage(state, battlerId, userHp, fainted, deps)

  // Target Atk -2, SpAtk -2
  const statChanges: StatChangeOutcome[] = []
  for (const statId of [STAT_ATK, STAT_SPATK]) {
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      targetId,
      -2,
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
  }

  return outcome(ctx, { targetId, attackerDamage: userHp, statChanges, fainted })
}

/**
 * EFFECT_SOAK (Soak, Magic Powder)
 * BattleScript_EffectSoak (data/battle_scripts_1.s:1949-1962),
 * VARIOUS_TRY_SOAK (src/battle_script_commands.c:7365-7373),
 * SET_BATTLER_TYPE (include/battle.h:755-760).
 */
export function handleSoak(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null) return outcome(ctx, { missed: true })

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const target = state.battlers[targetId]!

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:1951)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 2. ppreduce (:1953) -- PrintMoveMissed also calls ppreduce (:3094)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { targetId, missed: true })

  // 3. jumpifability BS_TARGET, ABILITY_MULTITYPE / ABILITY_RKS_SYSTEM, BattleScript_ButItFailed (:1954-1955)
  const moldBreaker = attackerHasMoldBreakerActive(state.battlers[battlerId]!, deps)
  if (
    battlerHasSimAbility(state, target, 'ABILITY_MULTITYPE', true, battlerId, moldBreaker, deps.dataContext) ||
    battlerHasSimAbility(state, target, 'ABILITY_RKS_SYSTEM', true, battlerId, moldBreaker, deps.dataContext)
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. jumpifsubstituteblocks BattleScript_ButItFailed (:1956)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 5. trysoak BattleScript_ButItFailed (VARIOUS_TRY_SOAK, src/battle_script_commands.c:7365-7373)
  // gBattleMoves[gCurrentMove].type: Soak -> Water, Magic Powder -> Psychic. Only type1/type2 are
  // compared; the sim's mono [X, 'MYSTERY'] is the C's type2 == type1.
  const moveType = (deps.dataContext.move(moveId)?.type ?? 'TYPE_MYSTERY').replace(/^TYPE_/, '')
  const [t1, t2] = target.mon.types
  if (t1 === moveType && (t2 === moveType || t2 === 'MYSTERY')) {
    return outcome(ctx, { targetId, missed: true })
  }

  // SET_BATTLER_TYPE (battle.h:755-760)
  target.mon.types = [moveType, moveType, 'MYSTERY']
  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_THIRD_TYPE (Forest's Curse, Trick-or-Treat, Incite)
 * BattleScript_EffectThirdType (data/battle_scripts_1.s:1269-1281),
 * VARIOUS_TRY_THIRD_TYPE (src/battle_script_commands.c:7768-7781),
 * VARIOUS_ARGUMENT_TO_MOVE_EFFECT (:7713-7715),
 * SetMoveEffect (:3025-3030).
 */
export function handleThirdType(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null) return outcome(ctx, { missed: true })

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const target = state.battlers[targetId]!

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:1271)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 2. ppreduce (:1273)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { targetId, missed: true })

  // 3. trysetthirdtype BS_TARGET, BattleScript_ButItFailed (:1274, VARIOUS_TRY_THIRD_TYPE:7768-7781)
  const moveData = deps.dataContext.move(moveId)
  const moveType = (moveData?.type ?? 'TYPE_MYSTERY').replace(/^TYPE_/, '')

  // IS_BATTLER_OF_TYPE: an already-typed target fails, except Trick-or-Treat's Ghost, which
  // still sets trickOrTreat and type3.
  if (target.mon.types.includes(moveType)) {
    if (moveType !== 'GHOST') return outcome(ctx, { targetId, missed: true })
    target.volatiles.trickOrTreat = true
  }
  target.mon.types[2] = moveType

  // 4. argumenttomoveeffect + seteffectprimary (:1279-1280). Incite is the only EFFECT_THIRD_TYPE
  // move with an argument (MOVE_EFFECT_ENRAGE); the others leave moveEffect 0.
  let statusApplied: StatusAppliedOutcome | null = null
  const arg = moveData?.argument
  if (arg?.kind === 'effect' && arg.effect === 'MOVE_EFFECT_ENRAGE') {
    const res = applyPrimaryStatusEffect(state, battlerId, targetId, MOVE_EFFECT_ENRAGE, moveId, deps, unmodelled, true, false)
    if (res.applied && res.status) {
      statusApplied = { battlerId: targetId, status: res.status }
    }
  }

  return outcome(ctx, { targetId, statusApplied, missed: false })
}

/**
 * EFFECT_CONVERSION (Conversion)
 * BattleScript_EffectConversion (data/battle_scripts_1.s:3831-3868),
 * Cmd_tryconversiontypechange (src/battle_script_commands.c:10205-10236).
 */
export function handleConversion(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // 1. ppreduce (:3834)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. tryconversiontypechange BattleScript_EffectConversionFailed (:10205-10236)
  // Inspects battler's moves 0..3 in order. On the FIRST non-empty move whose type is not MYSTERY:
  // if battler's types already match that move's types, it breaks out and fails type change!
  let typeChanged = false
  const moves = battler.mon.moves ?? []
  for (let i = 0; i < moves.length; i++) {
    const mId = moves[i]
    if (!mId) continue
    const mData = deps.dataContext.move(mId)
    const mType = (mData?.type ?? 'TYPE_MYSTERY').replace(/^TYPE_/, '')
    if (mType === 'MYSTERY') continue
    const mType2Raw = mData?.type2 ? mData.type2.replace(/^TYPE_/, '') : 'MYSTERY'
    const mType2 = mType2Raw === 'MYSTERY' ? mType : mType2Raw

    const [t1, t2, t3] = battler.mon.types
    const currentT2 = (t2 === 'MYSTERY' || !t2) ? t1 : t2
    if (t1 === mType && currentT2 === mType2 && t3 === 'MYSTERY') {
      // Mon is already of this move's exact types; C breaks out and fails type change (:10224)
      break
    }

    battler.mon.types = [mType, mType2, 'MYSTERY']
    typeChanged = true
    break
  }

  // 3. Both paths reach the same jumpifstat pair (:3845-3846, :3851-3852). Kept quirk: it tests
  // STAT_ATK, not STAT_SPATK, before raising SpAtk and Speed. CompareStat's Contrary inversion
  // is not applied, as in the other stat handlers.
  const statChanges: StatChangeOutcome[] = []
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE

  let statBoostFailed = false
  if (atkStage < MAX_STAT_STAGE || speStage < MAX_STAT_STAGE) {
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
      moveId,
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
      moveId,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: r2.delta })
  } else {
    // Both STAT_ATK and STAT_SPEED are at max stage -> jumps to BattleScript_CantRaiseMultipleStats (:3852)
    statBoostFailed = true
  }

  if (!typeChanged && statBoostFailed) {
    return outcome(ctx, { missed: true })
  }

  return outcome(ctx, { statChanges, missed: false })
}

/**
 * EFFECT_REFLECT_TYPE (Reflect Type)
 * BattleScript_EffectReflectType (data/battle_scripts_1.s:1964-1975),
 * VARIOUS_TRY_REFLECT_TYPE (src/battle_script_commands.c:7348-7364).
 * ER reverses vanilla: the attacker's types are written onto the target.
 */
export function handleReflectType(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null) return outcome(ctx, { missed: true })

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const user = state.battlers[battlerId]!
  const target = state.battlers[targetId]!

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:1966)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 2. ppreduce (:1968)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { targetId, missed: true })

  // 3. tryreflecttype BattleScript_ButItFailed (VARIOUS_TRY_REFLECT_TYPE, src/battle_script_commands.c:7348-7364)
  // Exact species match only, so other Arceus/Silvally forms are not exempt.
  if (target.mon.speciesId === 'SPECIES_ARCEUS' || target.mon.speciesId === 'SPECIES_SILVALLY') {
    return outcome(ctx, { targetId, missed: true })
  }
  // The four branches in C order; type3 is never touched.
  const [u1, u2] = user.mon.types
  const t3 = target.mon.types[2]
  if (u1 === 'MYSTERY' && u2 !== 'MYSTERY') {
    target.mon.types = [u2, u2, t3]
  } else if (u1 !== 'MYSTERY' && u2 === 'MYSTERY') {
    target.mon.types = [u1, u1, t3]
  } else if (u1 === 'MYSTERY' && u2 === 'MYSTERY') {
    return outcome(ctx, { targetId, missed: true })
  } else {
    target.mon.types = [u1, u2, t3]
  }
  return outcome(ctx, { targetId, missed: false })
}

function isTwoTurnsMoveEffect(effect: string | null | undefined): boolean {
  return (
    effect === 'EFFECT_SKULL_BASH' ||
    effect === 'EFFECT_TWO_TURNS_ATTACK' ||
    effect === 'EFFECT_SOLARBEAM' ||
    effect === 'EFFECT_SEMI_INVULNERABLE' ||
    effect === 'EFFECT_BIDE'
  )
}


/**
 * EFFECT_CONVERSION_2 (Conversion 2)
 * BattleScript_EffectConversion2 (data/battle_scripts_1.s:4728-4737),
 * Cmd_settypetorandomresistance (src/battle_script_commands.c:10788-10825).
 */
export function handleConversion2(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!

  // 1. ppreduce (:4731)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. settypetorandomresistance BattleScript_EffectConversionFailed (:10788-10825)
  let typeChanged = false
  const lastLanded = battler.lastLandedMove
  const hitByBattler = battler.lastHitBy !== BATTLER_NONE && battler.lastHitBy !== null ? state.battlers[battler.lastHitBy] : null
  const isTwoTurns = lastLanded && isTwoTurnsMoveEffect(deps.dataContext.move(lastLanded)?.effect)
  const isCharging = hitByBattler && hasFlag(hitByBattler.mon.status2, STATUS2_MULTIPLETURNS)

  if (lastLanded && lastLanded !== MOVE_UNSET && !(isTwoTurns && isCharging)) {
    if (!deps.hazardTypes) {
      unmodelled.push(
        `battler ${battlerId}: Conversion 2 (battle_script_commands.c:10798-10806) is not applied -- no hazardTypes (type chart) was supplied in deps`,
      )
    } else {
      const hitByType = battler.lastHitByType ?? 'NORMAL'
      const inputs: TypeModifierInputs = {
        isInverseRoomActive: !deps.grounding.isCluelessOnField && hasFlag(state.field.statuses, STATUS_FIELD_INVERSE_ROOM),
        isInverseBattleFlagSet: deps.hazardTypes.inverseBattle,
        attackerHasMiracleEye: hasFlag(battler.statuses3, STATUS3_MIRACLE_EYED),
        defenderHasMiracleEye: false,
      }

      let resistTypes = 0
      for (let i = 0; i < TYPE_NAME_BY_ID.length; i++) {
        const defType = TYPE_NAME_BY_ID[i]
        const mod = getTypeModifier(hitByType, defType, deps.hazardTypes.typeChart, deps.hazardTypes.inverseTypeChart, inputs)
        if (mod === 0 || mod === uq(0.5)) {
          resistTypes |= (1 << i)
        }
      }

      while (resistTypes !== 0) {
        const i = state.rng.random16() % TYPE_NAME_BY_ID.length
        if ((resistTypes & (1 << i)) !== 0) {
          const typeName = TYPE_NAME_BY_ID[i]
          if (battler.mon.types.includes(typeName)) {
            resistTypes &= ~(1 << i)
          } else {
            battler.mon.types = [typeName, typeName, 'MYSTERY']
            typeChanged = true
            break
          }
        }
      }
    }
  }

  // 3. Both paths reach BattleScript_EffectConversionBoost (:4737 -> :3850-3868).
  // Kept quirk: tests STAT_ATK, not STAT_SPATK, before raising SpAtk and Speed.
  const statChanges: StatChangeOutcome[] = []
  const atkStage = battler.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const speStage = battler.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE

  let statBoostFailed = false
  if (atkStage < MAX_STAT_STAGE || speStage < MAX_STAT_STAGE) {
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
      moveId,
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
      moveId,
    )
    if (r2.delta !== 0) statChanges.push({ battlerId, stat: STAT_SPEED, change: r2.delta })
  } else {
    statBoostFailed = true
  }

  if (!typeChanged && statBoostFailed) {
    return outcome(ctx, { missed: true })
  }

  return outcome(ctx, { statChanges, missed: false })
}

const COPYCAT_BANNED_EFFECTS = new Set([
  'EFFECT_PLACEHOLDER',
  'EFFECT_PROTECT',
  'EFFECT_DO_NOTHING',
  'EFFECT_HIT_SWITCH_TARGET',
  'EFFECT_ROAR',
  'EFFECT_FOLLOW_ME',
  'EFFECT_TRICK',
])

/**
 * EFFECT_COPYCAT (Copycat)
 * BattleScript_EffectCopycat (data/battle_scripts_1.s:1594-1605),
 * VARIOUS_TRY_COPYCAT (src/battle_script_commands.c:7541-7562).
 */
export function handleCopycat(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  const calledMove = state.lastUsedMove
  const calledData = calledMove && calledMove !== MOVE_UNSET ? deps.dataContext.move(calledMove) : null
  const isBannedEffect = calledData?.effect ? COPYCAT_BANNED_EFFECTS.has(calledData.effect) : false
  const isBannedFlag = calledData?.flags?.copycatBanned === true

  if (!calledMove || calledMove === MOVE_UNSET || isBannedEffect || isBannedFlag) {
    // Failing trycopycat still reduces PP in C (:1603)
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // BattleScript_EffectCopycat has no ppreduce on the success path (data/battle_scripts_1.s:1594-1601):
  // the called move's own script deducts PP once (jumptocalledmove).

  // Target in C: gBattlerTarget = GetMoveTarget(gBattlerAttacker, gCalledMove, 0); (:7560)
  const calledTargetId = getMoveTarget(state, battlerId, calledMove, deps)

  // jumptocalledmove TRUE (data/battle_scripts_1.s:1601, battle_script_commands.c:5906-5914)
  if (ctx.jumpToCalledMove) {
    return ctx.jumpToCalledMove(calledMove, true, calledTargetId)
  }

  return outcome(ctx, { targetId: calledTargetId, missed: false })
}

const INSTRUCT_FORBIDDEN_EFFECTS = new Set([
  'EFFECT_ASSIST',
  'EFFECT_BELCH',
  'EFFECT_BIDE',
  'EFFECT_COPYCAT',
  'EFFECT_FOCUS_PUNCH',
  'EFFECT_GEOMANCY',
  'EFFECT_INSTRUCT',
  'EFFECT_ME_FIRST',
  'EFFECT_METRONOME',
  'EFFECT_MIMIC',
  'EFFECT_MIRROR_MOVE',
  'EFFECT_NATURE_POWER',
  'EFFECT_RAMPAGE',
  'EFFECT_RECHARGE',
  'EFFECT_RECOIL_25',
  'EFFECT_ROLLOUT',
  'EFFECT_SEMI_INVULNERABLE',
  'EFFECT_SKETCH',
  'EFFECT_SKULL_BASH',
  'EFFECT_SLEEP_TALK',
  'EFFECT_SOLARBEAM',
  'EFFECT_TRANSFORM',
  'EFFECT_TWO_TURNS_ATTACK',
  'EFFECT_UPROAR',
])

/**
 * EFFECT_INSTRUCT (Instruct)
 * BattleScript_EffectInstruct (data/battle_scripts_1.s:1606-1615),
 * VARIOUS_TRY_INSTRUCT (src/battle_script_commands.c:7563-7589).
 */
export function handleInstruct(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // ppreduce runs before tryinstruct in C (:1609)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null || !state.battlers[targetId] || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  const target = state.battlers[targetId]!
  const instructedMove = target.lastMove
  if (!instructedMove || instructedMove === MOVE_UNSET) {
    return outcome(ctx, { targetId, missed: true })
  }

  const instructedData = deps.dataContext.move(instructedMove)
  if (
    (instructedData?.effect && INSTRUCT_FORBIDDEN_EFFECTS.has(instructedData.effect)) ||
    instructedMove === 'MOVE_STRUGGLE' ||
    instructedMove === 'MOVE_KINGS_SHIELD'
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  // Must still be in target's moves with PP > 0 (:7578)
  const moveSlot = target.mon.moves.indexOf(instructedMove)
  if (moveSlot === -1 || (target.mon.pp[moveSlot] ?? 0) <= 0) {
    return outcome(ctx, { targetId, missed: true })
  }

  // Target executes instructedMove via extra attack queue (VARIOUS_TRY_INSTRUCT, battle_script_commands.c:7581-7586)
  const targetForInstructedMove = getMoveTarget(state, targetId, instructedMove, deps)
  state.queuedExtraAttacks.push({
    attacker: targetId,
    target: targetForInstructedMove,
    move: instructedMove,
    movePos: moveSlot + 1,
  })

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_MIMIC (Mimic)
 * BattleScript_EffectMimic (data/battle_scripts_1.s:4555-4566),
 * Cmd_mimicattackcopy (src/battle_script_commands.c:10557-10584).
 */
export function handleMimic(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const attacker = state.battlers[battlerId]!

  // 1. ppreduce (:4558)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null || !state.battlers[targetId] || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  const target = state.battlers[targetId]!

  // 2. jumpifsubstituteblocks BattleScript_ButItFailed (:4559)
  if (hasFlag(target.mon.status2, STATUS2_SUBSTITUTE)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. accuracycheck BattleScript_ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:4560)
  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. mimicattackcopy BattleScript_ButItFailed (:10557-10584)
  const targetLastMove = target.lastMove
  if (!targetLastMove || targetLastMove === MOVE_UNSET) {
    return outcome(ctx, { targetId, missed: true })
  }

  const targetMoveData = deps.dataContext.move(targetLastMove)
  if (targetMoveData?.flags?.mimicBanned === true) {
    return outcome(ctx, { targetId, missed: true })
  }

  if (hasFlag(attacker.mon.status2, STATUS2_TRANSFORMED)) {
    return outcome(ctx, { targetId, missed: true })
  }

  if (attacker.mon.moves.includes(targetLastMove)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // Slot of MOVE_MIMIC in attacker's moves
  const slot = attacker.mon.moves.indexOf('MOVE_MIMIC')
  if (slot === -1 || slot >= 4) {
    return outcome(ctx, { targetId, missed: true })
  }

  // Rewrite slot
  attacker.mon.moves[slot] = targetLastMove

  // PP rule: if (gBattleMoves[gLastMoves[target]].pp < 5) pp = maxPP; else pp = 5;
  const maxPp = targetMoveData?.pp ?? 5
  attacker.mon.pp[slot] = Math.min(5, maxPp)

  attacker.volatiles.mimickedMoves |= (1 << slot)

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_MIRROR_MOVE (Mirror Move)
 * BattleScript_EffectMirrorMove (data/battle_scripts_1.s:3575-3585),
 * Cmd_trymirrormove (src/battle_script_commands.c:9276-9307).
 */
export function handleMirrorMove(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // ppreduce only on the failure path (data/battle_scripts_1.s:3580); on success the called
  // move's own script deducts PP.

  // Cmd_trymirrormove (:9276-9307):
  const movesArray: string[] = []
  for (let i = 0; i < state.battlersCount; i++) {
    if (i !== battlerId) {
      const m = state.lastTakenMoveFrom[battlerId]?.[i]
      if (m && m !== MOVE_UNSET) {
        movesArray.push(m)
      }
    }
  }

  let chosenMove: string | null = null
  const direct = state.lastTakenMove[battlerId]
  if (direct && direct !== MOVE_UNSET) {
    chosenMove = direct
  } else if (movesArray.length > 0) {
    const idx = state.rng.random16() % movesArray.length
    chosenMove = movesArray[idx]
  }

  if (!chosenMove) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // gBattlerTarget = GetMoveTarget(gBattlerAttacker, gCurrentMove, 0); (:9296, :9302)
  const calledTargetId = getMoveTarget(state, battlerId, chosenMove, deps)

  // Cmd_trymirrormove jumps to called move's effect script with gChosenMove untouched (:9295-9297)
  if (ctx.jumpToCalledMove) {
    return ctx.jumpToCalledMove(chosenMove, true, calledTargetId)
  }

  return outcome(ctx, { targetId: calledTargetId, missed: false })
}

/**
 * EFFECT_SKETCH (Sketch)
 * BattleScript_EffectSketch (data/battle_scripts_1.s:4752-4761),
 * Cmd_copymovepermanently (src/battle_script_commands.c:10834-10873),
 * REQUEST_MOVES_PP_BATTLE (src/battle_controller_player.c:3839-3845).
 */
export function handleSketch(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp, setChosenMove } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const attacker = state.battlers[battlerId]!

  // Cmd_copymovepermanently (src/battle_script_commands.c:10836): gChosenMove = 0xFFFF;
  setChosenMove?.(MOVE_UNSET)

  // 1. ppreduce (:4755)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null || !state.battlers[targetId] || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true, chosenMoveId: MOVE_UNSET })
  }

  const target = state.battlers[targetId]!
  const targetMove = target.lastPrintedMove

  // Cmd_copymovepermanently (:10834-10873):
  // if (!(gBattleMons[gBattlerAttacker].status2 & STATUS2_TRANSFORMED) && gLastPrintedMoves[gBattlerTarget] != MOVE_STRUGGLE &&
  //     gLastPrintedMoves[gBattlerTarget] != 0 && gLastPrintedMoves[gBattlerTarget] != 0xFFFF && gLastPrintedMoves[gBattlerTarget] != MOVE_SKETCH)
  if (
    hasFlag(attacker.mon.status2, STATUS2_TRANSFORMED) ||
    !targetMove ||
    targetMove === MOVE_UNSET ||
    targetMove === 'MOVE_STRUGGLE' ||
    targetMove === 'MOVE_SKETCH'
  ) {
    return outcome(ctx, { targetId, missed: true, chosenMoveId: MOVE_UNSET })
  }

  // Already knows move (skipping slot holding Sketch itself)
  for (let i = 0; i < attacker.mon.moves.length; i++) {
    if (attacker.mon.moves[i] === 'MOVE_SKETCH') continue
    if (attacker.mon.moves[i] === targetMove) {
      return outcome(ctx, { targetId, missed: true, chosenMoveId: MOVE_UNSET })
    }
  }

  const slot = attacker.mon.moves.indexOf('MOVE_SKETCH')
  if (slot === -1 || slot >= 4) {
    return outcome(ctx, { targetId, missed: true, chosenMoveId: MOVE_UNSET })
  }

  const targetMoveData = deps.dataContext.move(targetMove)
  const maxPp = targetMoveData?.pp ?? 0

  // Replace active battler move & PP
  attacker.mon.moves[slot] = targetMove
  attacker.mon.pp[slot] = maxPp

  // Persist to party mon (REQUEST_MOVES_PP_BATTLE, battle_controller_player.c:3839-3845)
  const party = state.sides[battlerId & 1].party
  const partyMon = party[attacker.partyIndex]
  if (partyMon) {
    partyMon.moves[slot] = targetMove
    partyMon.pp[slot] = maxPp
  }

  return outcome(ctx, { targetId, missed: false, chosenMoveId: MOVE_UNSET })
}

/**
 * EFFECT_DOODLE (Doodle)
 * BattleScript_EffectDoodle (data/battle_scripts_1.s:2284-2319),
 * VARIOUS_COPY_ABILITY (src/battle_script_commands.c:7245-7257),
 * IsEntrainmentBannedAbilityAttacker / IsEntrainmentTargetOrSimpleBeamBannedAbility (battle_util.c:8448-8464),
 * HasAbilityIgnoringSuppression / ReplaceAbility (battle_util.c:9315-9325).
 */
export function handleDoodle(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2286)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 2. ppreduce (:2288)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. trycopyabilitybetween BS_TARGET, BS_ATTACKER, BattleScript_EffectDoodle_NoAttacker
  // (VARIOUS_COPY_ABILITY:7245-7257)
  const targetAbility = target.mon.abilities.ability ?? 'ABILITY_NONE'
  const userAbility = battler.mon.abilities.ability ?? 'ABILITY_NONE'

  const failsAttacker =
    isEntrainmentBannedAbilityAttacker(targetAbility) ||
    isEntrainmentTargetOrSimpleBeamBannedAbility(userAbility) ||
    hasAbilityIgnoringSuppression(battler, targetAbility) ||
    doesBattlerHaveAbilityShield(battler, deps)

  // In singles: partner does not exist, so failing attacker means Doodle fails entirely.
  // In doubles: try partner if attacker fails or succeeds.
  const partnerId = battlerId ^ 2
  const partner = state.battlers[partnerId]
  const hasPartner = Boolean(partner && isBattlerAlive(state, partnerId))

  if (failsAttacker && !hasPartner) {
    return outcome(ctx, { targetId, missed: true })
  }

  let anyCopied = false
  if (!failsAttacker) {
    updateAbilityStateForNewAbility(battler, targetAbility)
    battler.mon.abilities.ability = targetAbility
    applySwitchInAbilities(state, battlerId, deps, unmodelled)
    anyCopied = true
  }

  if (hasPartner) {
    const partnerAbility = partner!.mon.abilities.ability ?? 'ABILITY_NONE'
    // VARIOUS_COPY_ABILITY applies the same four checks to every call; two of them read the
    // attacker / target, not the battler receiving the ability (battle_script_commands.c:7249-7252).
    const failsPartner =
      isEntrainmentBannedAbilityAttacker(targetAbility) ||
      isEntrainmentTargetOrSimpleBeamBannedAbility(partnerAbility) ||
      hasAbilityIgnoringSuppression(battler, targetAbility) ||
      doesBattlerHaveAbilityShield(partner!, deps)
    if (!failsPartner) {
      updateAbilityStateForNewAbility(partner!, targetAbility)
      partner!.mon.abilities.ability = targetAbility
      applySwitchInAbilities(state, partnerId, deps, unmodelled)
      anyCopied = true
    }
  }

  if (!anyCopied) {
    return outcome(ctx, { targetId, missed: true })
  }

  return outcome(ctx, { targetId, missed: false })
}

/**
 * The state half of Cmd_transformdataexecution (src/battle_script_commands.c:10492-10532): the
 * transformed flag, the cleared volatiles, and the full copy of species/stats/types/abilities/
 * moves/statStages/PP. Callers have already run the C's own failure checks (:10485-10488).
 *
 * Shared by the Transform move (BattleScript_EffectTransform, data/battle_scripts_1.s:4276-4290)
 * and Imposter's onEntry (src/abilities.cc:2161-2175, whose BattleScript_ImposterActivates,
 * data/battle_scripts_1.s:10469-10477, runs transformdataexecution directly). The move-only
 * pieces -- gChosenMove = 0xFFFF (:10484), ppreduce (:4279), trytoclearprimalweather (:4280),
 * the animation/text, and the trailing `switchinabilities` -- stay with the callers.
 */
export function applyTransformCopy(
  state: BattleState,
  battlerId: number,
  targetId: number,
  deps: { dataContext: SimDataContext },
): void {
  const attacker = state.battlers[battlerId]!
  const target = state.battlers[targetId]!

  // Set transformed status2 & clear volatile states
  attacker.mon.status2 = setFlag(attacker.mon.status2, STATUS2_TRANSFORMED)
  attacker.volatiles.disabledMove = null
  attacker.volatiles.disableTimer = 0
  attacker.volatiles.transformedMonPersonality = target.volatiles.transformedMonPersonality ?? 0
  attacker.volatiles.mimickedMoves = 0
  attacker.volatiles.usedMoves = 0

  // Update ability state indices for target's abilities (UpdateAbilityStateIndices:8833-8862)
  updateAbilityStateForNewAbilities(attacker, abilitySlotIds(target))

  // Copy species, stats (excluding HP/maxHP), types, speedDown, abilities, moves, statStages
  attacker.mon.speciesId = target.mon.speciesId
  attacker.mon.rawStats = {
    atk: target.mon.rawStats.atk,
    def: target.mon.rawStats.def,
    spatk: target.mon.rawStats.spatk,
    spdef: target.mon.rawStats.spdef,
    spe: target.mon.rawStats.spe,
  }
  attacker.mon.types = [...target.mon.types]
  attacker.mon.speedDown = target.mon.speedDown
  attacker.mon.abilities = {
    ability: target.mon.abilities.ability,
    innates: [...target.mon.abilities.innates],
  }
  attacker.mon.moves = [...target.mon.moves]
  attacker.mon.statStages = [...target.mon.statStages]

  // Copy PP: min(5, maxPp)
  for (let i = 0; i < 4; i++) {
    const m = attacker.mon.moves[i]
    if (m) {
      const mData = deps.dataContext.move(m)
      const maxPp = mData?.pp ?? 5
      attacker.mon.pp[i] = Math.min(5, maxPp)
    } else {
      attacker.mon.pp[i] = 0
    }
  }
}

/**
 * EFFECT_TRANSFORM (Transform)
 * BattleScript_EffectTransform (data/battle_scripts_1.s:4276-4290),
 * Cmd_transformdataexecution (src/battle_script_commands.c:10482-10533).
 */
export function handleTransform(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp, setChosenMove } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // Cmd_transformdataexecution (src/battle_script_commands.c:10483): gChosenMove = 0xFFFF;
  setChosenMove?.(MOVE_UNSET)

  // 1. ppreduce (:4279)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (targetId === null || !state.battlers[targetId] || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true, chosenMoveId: MOVE_UNSET })
  }

  const target = state.battlers[targetId]!

  // 2. trytoclearprimalweather (:4280)
  if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
    unmodelled.push('trytoclearprimalweather not modelled')
  }

  // 3. transformdataexecution (:10482-10533):
  // if (gBattleMons[gBattlerTarget].status2 & STATUS2_TRANSFORMED || gBattleStruct->illusion[gBattlerTarget].on ||
  //     gStatuses3[gBattlerTarget] & STATUS3_SEMI_INVULNERABLE) -> fail
  // The C's other readers (display/message code) have already set illusion[] by the time
  // the move runs; GetIllusionMonPtr is the sim's lazy set, mirroring battle_util.c:8281-8292.
  getIllusionMonPtr(state, targetId)
  if (
    hasFlag(target.mon.status2, STATUS2_TRANSFORMED) ||
    target.illusion.on ||
    hasFlag(target.statuses3, STATUS3_SEMI_INVULNERABLE)
  ) {
    return outcome(ctx, { targetId, missed: true, chosenMoveId: MOVE_UNSET })
  }

  // Set transformed status2, clear volatile states and copy the target's battle state
  // (:10492-10532). Shared with Imposter's onEntry.
  applyTransformCopy(state, battlerId, targetId, deps)

  // 4. switchinabilities BS_ATTACKER (:4289)
  applySwitchInAbilities(state, battlerId, deps, unmodelled)

  return outcome(ctx, { targetId, missed: false, chosenMoveId: MOVE_UNSET })
}

const METRONOME_FORBIDDEN_EFFECTS = new Set([
  'EFFECT_PROTECT',
  'EFFECT_PLACEHOLDER',
  'EFFECT_DO_NOTHING',
  'EFFECT_FOLLOW_ME',
  'EFFECT_TRICK',
])

/**
 * EFFECT_METRONOME (Metronome)
 * BattleScript_EffectMetronome (data/battle_scripts_1.s:4568-4577),
 * Cmd_metronome (src/battle_script_commands.c:10586-10613).
 */
export function handleMetronome(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce runs before metronome in C (:4571)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. Cmd_metronome (:10586-10613):
  // do {
  //     move = (Random() % (MOVES_COUNT - 1)) + 1;
  //     switch (gBattleMoves[move].effect) {
  //         case EFFECT_PROTECT:
  //         case EFFECT_PLACEHOLDER:
  //         case EFFECT_DO_NOTHING:
  //         case EFFECT_FOLLOW_ME:
  //         case EFFECT_TRICK:
  //             allowed = FALSE;
  //             break;
  //         default:
  //             allowed = TRUE;
  //     }
  // } while (!allowed && !gBattleMoves[move].metronomeBanned && !gBattleMoves[move].twoTurnMove);
  let chosenMove: string
  let allowed: boolean
  do {
    const roll = state.rng.random16()
    const moveIndex = (roll % (MOVES_COUNT - 1)) + 1
    chosenMove = METRONOME_MOVES[moveIndex] ?? 'MOVE_POUND'
    const moveData = deps.dataContext.move(chosenMove)
    allowed = !moveData?.effect || !METRONOME_FORBIDDEN_EFFECTS.has(moveData.effect)
    // C bug kept (src/battle_script_commands.c:10603): while condition uses '&&' instead of '||'.
    // If allowed is true (not one of the 5 forbidden effects), the loop immediately terminates regardless of metronomeBanned/twoTurnMove.
  } while (
    !allowed &&
    !deps.dataContext.move(chosenMove)?.flags?.metronomeBanned &&
    !deps.dataContext.move(chosenMove)?.flags?.twoTurn &&
    !deps.dataContext.move(chosenMove)?.flags?.twoTurnMove
  )

  // Cmd_metronome (src/battle_script_commands.c:10605-10610): queue extra attack
  const target = getMoveTarget(state, battlerId, chosenMove, deps)
  const prankster = battlerHasSimAbility(state, state.battlers[battlerId]!, 'ABILITY_PRANKSTER', false, battlerId, false, deps.dataContext)
  state.queuedExtraAttacks.push({
    attacker: battlerId,
    move: chosenMove,
    target,
    prankster,
    movePos: 0,
  })

  return outcome(ctx, { targetId: target, missed: false })
}

function isTwoTurnsMove(effect: string | null): boolean {
  return (
    effect === 'EFFECT_SKULL_BASH' ||
    effect === 'EFFECT_TWO_TURNS_ATTACK' ||
    effect === 'EFFECT_SOLARBEAM' ||
    effect === 'EFFECT_SEMI_INVULNERABLE' ||
    effect === 'EFFECT_BIDE'
  )
}

const ASSIST_FORBIDDEN_EFFECTS = new Set([
  'EFFECT_PLACEHOLDER',
  'EFFECT_PROTECT',
  'EFFECT_DO_NOTHING',
  'EFFECT_HIT_SWITCH_TARGET',
  'EFFECT_ROAR',
  'EFFECT_FOLLOW_ME',
  'EFFECT_TRICK',
])

/**
 * EFFECT_ASSIST (Assist)
 * BattleScript_EffectAssist (data/battle_scripts_1.s:6315-6325),
 * Cmd_assistattackselect (src/battle_script_commands.c:12004-12050).
 */
export function handleAssist(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce runs before assistattackselect in C (:6318)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. Cmd_assistattackselect (:12004-12050):
  const side = battlerId & 1
  const party = state.sides[side]?.party ?? []
  const attackerBattler = state.battlers[battlerId]
  const userPartyIndex = attackerBattler?.partyIndex ?? 0

  const movesArray: string[] = []
  for (let monId = 0; monId < party.length; monId++) {
    if (monId === userPartyIndex) continue
    const pMon = party[monId]
    if (!pMon || pMon.speciesId === null) continue

    for (let i = 0; i < pMon.moves.length; i++) {
      const m = pMon.moves[i]
      if (!m || m === MOVE_UNSET) continue

      const mData = deps.dataContext.move(m)
      if (mData?.effect && ASSIST_FORBIDDEN_EFFECTS.has(mData.effect)) continue
      if (mData?.flags?.copycatBanned === true) continue
      if (isTwoTurnsMove(mData?.effect ?? null)) continue

      movesArray.push(m)
    }
  }

  if (movesArray.length === 0) {
    // assistattackselect BattleScript_ButItFailed (:6319)
    return outcome(ctx, { targetId, missed: true })
  }

  // gCalledMove = movesArray[((Random() & 0xFF) * chooseableMovesNo) >> 8]; (:12044)
  const roll = state.rng.random16()
  const idx = ((roll & 0xff) * movesArray.length) >> 8
  const chosenMove = movesArray[idx]!

  // gBattlerTarget = GetMoveTarget(gBattlerAttacker, gCalledMove, 0); (:12045)
  const calledTargetId = getMoveTarget(state, battlerId, chosenMove, deps)

  // jumptocalledmove TRUE (data/battle_scripts_1.s:6324, battle_script_commands.c:5906-5914)
  if (ctx.jumpToCalledMove) {
    return ctx.jumpToCalledMove(chosenMove, true, calledTargetId)
  }

  return outcome(ctx, { targetId: calledTargetId, missed: false })
}

const SLEEP_TALK_FORBIDDEN_EFFECTS = new Set([
  'EFFECT_PLACEHOLDER',
  'EFFECT_DO_NOTHING',
  'EFFECT_HIT_SWITCH_TARGET',
  'EFFECT_ROAR',
])

/**
 * EFFECT_SLEEP_TALK (Sleep Talk)
 * BattleScript_EffectSleepTalk (data/battle_scripts_1.s:4763-4784),
 * Cmd_trychoosesleeptalkmove (src/battle_script_commands.c:10898-10941).
 */
export function handleSleepTalk(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const attacker = state.battlers[battlerId]!

  // Check sleep / Comatose (:4765-4766)
  const isAsleep =
    (attacker.mon.status1 & STATUS1_SLEEP) !== 0 ||
    battlerHasSimAbility(state, attacker, 'ABILITY_COMATOSE', false, battlerId, false, deps.dataContext)

  // Failing sleep check still deducts PP in C (:4768)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (!isAsleep) {
    return outcome(ctx, { targetId, missed: true })
  }

  // Cmd_trychoosesleeptalkmove (:10898-10941):
  let unusableMovesBits = 0
  for (let i = 0; i < MAX_MON_MOVES; i++) {
    const m = attacker.mon.moves[i]
    if (!m || m === MOVE_UNSET) {
      unusableMovesBits |= 1 << i
      continue
    }

    const mData = deps.dataContext.move(m)
    if (mData?.flags?.sleepTalkBanned === true || isTwoTurnsMove(mData?.effect ?? null)) {
      unusableMovesBits |= 1 << i
    } else if (mData?.effect && SLEEP_TALK_FORBIDDEN_EFFECTS.has(mData.effect)) {
      unusableMovesBits |= 1 << i
    } else if (attacker.volatiles.disabledMove === m) {
      unusableMovesBits |= 1 << i
    } else if (attacker.volatiles.tauntTimer > 0 && (mData?.power ?? 0) === 0 && mData?.split === 'STATUS') {
      unusableMovesBits |= 1 << i
    } else if (attacker.volatiles.encoreTimer > 0 && attacker.volatiles.encoredMove !== m) {
      unusableMovesBits |= 1 << i
    } else if ((attacker.mon.status2 & STATUS2_TORMENT) !== 0 && attacker.lastMove === m) {
      unusableMovesBits |= 1 << i
    } else if (attacker.volatiles.throatChopTimer > 0 && mData?.flags?.sound === true) {
      unusableMovesBits |= 1 << i
    }
  }

  if (unusableMovesBits === 0xf) {
    // trychoosesleeptalkmove failed (:4779 goto BattleScript_ButItFailed)
    return outcome(ctx, { targetId, missed: true })
  }

  let reroll = true
  let movePosition: number
  do {
    movePosition = state.rng.random16() & (MAX_MON_MOVES - 1)
    if (reroll && attacker.mon.moves[movePosition] === 'MOVE_REST') {
      reroll = false
      movePosition = state.rng.random16() & (MAX_MON_MOVES - 1)
    }
  } while ((unusableMovesBits & (1 << movePosition)) !== 0)

  attacker.turn.sleepTalk = true

  const chosenMove = attacker.mon.moves[movePosition]!
  // Cmd_trychoosesleeptalkmove (src/battle_script_commands.c:10931-10937, data/battle_scripts_1.s:4776): queue extra attack
  const target = getMoveTarget(state, battlerId, chosenMove, deps)
  state.queuedExtraAttacks.push({
    attacker: battlerId,
    target,
    move: chosenMove,
    movePos: movePosition + 1,
    noPpDeduct: true,
  })

  return outcome(ctx, { targetId: target, missed: false })
}

const ME_FIRST_BANNED_MOVES = new Set([
  'MOVE_STRUGGLE',
  'MOVE_CHATTER',
  'MOVE_FOCUS_PUNCH',
  'MOVE_THIEF',
  'MOVE_COVET',
  'MOVE_COUNTER',
  'MOVE_MIRROR_COAT',
  'MOVE_METAL_BURST',
  'MOVE_ME_FIRST',
  'MOVE_BEAK_BLAST',
])

/**
 * EFFECT_ME_FIRST (Me First)
 * BattleScript_EffectMeFirst (data/battle_scripts_1.s:2131-2140),
 * VARIOUS_TRY_ME_FIRST (src/battle_script_commands.c:7301-7333).
 */
export function handleMeFirst(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const attacker = state.battlers[battlerId]!

  // 1. ppreduce runs before trymefirst in C (:2134)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. Target must exist and be alive
  if (targetId === null || !state.battlers[targetId] || !isBattlerAlive(state, targetId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. VARIOUS_TRY_ME_FIRST (:7301-7333):
  // if (GetBattlerTurnOrderNum(gBattlerAttacker) > GetBattlerTurnOrderNum(gBattlerTarget))
  const attackerTurnOrder = ctx.order ? ctx.order.battlerByTurnOrder.indexOf(battlerId) : ctx.turnOrderIndex
  const targetTurnOrder = ctx.order ? ctx.order.battlerByTurnOrder.indexOf(targetId) : -1
  if (targetTurnOrder === -1 || attackerTurnOrder > targetTurnOrder) {
    return outcome(ctx, { targetId, missed: true })
  }

  // Target's chosen move:
  // MoveEnum move = gBattleMons[gBattlerTarget].moves[gBattleStruct->chosenMovePositions[gBattlerTarget]];
  const target = state.battlers[targetId]!
  const chosenPos = state.chosenMovePositions?.[targetId] ?? 0
  const targetChosenMove = target.mon.moves[chosenPos]
  if (!targetChosenMove || targetChosenMove === MOVE_UNSET) {
    return outcome(ctx, { targetId, missed: true })
  }

  // else if (gBattleMoves[...].power == 0)
  const targetMoveData = deps.dataContext.move(targetChosenMove)
  if (!targetMoveData || (targetMoveData.power ?? 0) === 0) {
    return outcome(ctx, { targetId, missed: true })
  }

  // Banned moves switch (:7309-7321)
  if (ME_FIRST_BANNED_MOVES.has(targetChosenMove)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // Success (:7323-7330):
  // Target: GetMoveTarget(gBattlerAttacker, gCalledMove, 0) (:7326)
  const targetForExtraAttack = getMoveTarget(state, battlerId, targetChosenMove, deps)
  const prankster = battlerHasSimAbility(state, attacker, 'ABILITY_PRANKSTER', false, battlerId, false, deps.dataContext)

  state.queuedExtraAttacks.push({
    attacker: battlerId,
    move: targetChosenMove,
    target: targetForExtraAttack,
    prankster,
  })

  // gStatuses3[gBattlerAttacker] |= STATUS3_ME_FIRST; (:7329)
  // Power boost 1.5x in battle_util.c:7061, cleared at MOVEEND_CLEAR_BITS (:4948).
  attacker.statuses3 = setFlag(attacker.statuses3, STATUS3_ME_FIRST)

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_LUCKY_CHANT (Lucky Chant)
 * BattleScript_EffectLuckyChant (data/battle_scripts_1.s:2342-2351),
 * VARIOUS_SET_LUCKY_CHANT (src/battle_script_commands.c:7201-7212).
 */
export function handleLuckyChant(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const side = battlerId & 1

  // 1. ppreduce (:2345)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setluckychant BS_ATTACKER, BattleScript_ButItFailed (:2346, VARIOUS_SET_LUCKY_CHANT:7201-7212)
  if (state.sides[side].statuses & SIDE_STATUS_LUCKY_CHANT) {
    return outcome(ctx, { missed: true })
  }

  state.sides[side].timers.started.luckyChant = true
  state.sides[side].statuses |= SIDE_STATUS_LUCKY_CHANT
  state.sides[side].timers.luckyChantBattlerId = battlerId
  state.sides[side].timers.luckyChantTimer = SCREEN_DURATION

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_QUICK_GUARD (Quick Guard)
 * BattleScript_EffectQuickGuard (data/battle_scripts_1.s:12549-12558),
 * VARIOUS_SET_QUICK_GUARD (src/battle_script_commands.c:8886-8894).
 */
export function handleQuickGuard(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const side = battlerId & 1

  // 1. ppreduce (:12552)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setquickguard BattleScript_ButItFailed (:12553, VARIOUS_SET_QUICK_GUARD:8886-8894)
  if (state.sides[side].timers.quickGuardTimer) {
    return outcome(ctx, { missed: true })
  }

  state.sides[side].timers.quickGuardTimer = 3
  state.sides[side].timers.started.quickGuard = true

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_SMOKESCREEN (Smokescreen)
 * BattleScript_EffectSmokescreen (data/battle_scripts_1.s:12385-12399),
 * SetMoveEffect:MOVE_EFFECT_SMOKESCREEN (src/battle_script_commands.c:2983-2995).
 */
export function handleSmokescreen(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const battler = state.battlers[battlerId]!
  const side = battlerId & 1

  // 1. ppreduce (:12388)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // The attacker checks its own ability, so Mold Breaker never applies.
  const hasScreenCleaner = battlerHasSimAbility(state, battler, 'ABILITY_SCREEN_CLEANER', false, battlerId, false, deps.dataContext)

  // 2. jumpifsideaffecting BS_ATTACKER, SIDE_STATUS_SMOKESCREEN (:12389) reads the bit only, so
  // White Smoke's timer-only smokescreen does not fail the move.
  if (hasFlag(state.sides[side].statuses, SIDE_STATUS_SMOKESCREEN) && !hasScreenCleaner) {
    return outcome(ctx, { missed: true })
  }

  // 3. SetMoveEffect(MOVE_EFFECT_SMOKESCREEN) (:2983-2995). Kept quirk: a Screen Cleaner user
  // passes the check above, then sets nothing, but the move still counts as a success.
  if (!state.sides[side].timers.smokescreenTimer && !hasScreenCleaner) {
    const isExtended = getHoldEffect(ctx, battlerId) === 'HOLD_EFFECT_LIGHT_CLAY'
    const duration = isExtended ? SCREEN_DURATION_EXTENDED : SCREEN_DURATION

    state.sides[side].timers.smokescreenTimer = duration
    state.sides[side].timers.started.smokescreen = true
    state.sides[side].timers.smokescreenBattler = battlerId
    state.sides[side].statuses |= SIDE_STATUS_SMOKESCREEN
  }

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_MUD_SPORT and EFFECT_WATER_SPORT (Mud Sport, Water Sport)
 * BattleScript_EffectMudSport / BattleScript_EffectWaterSport (data/battle_scripts_1.s:6598-6609),
 * Cmd_settypebasedhalvers (src/battle_script_commands.c:12217-12245). ER's damage path never
 * reads STATUS_FIELD_MUDSPORT or STATUS_FIELD_WATERSPORT; only the end-of-turn countdown and the AI do.
 */
export function handleTypeBasedHalvers(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:6602)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. settypebasedhalvers BattleScript_ButItFailed (Cmd_settypebasedhalvers:12217-12245)
  if (moveEffect === 'EFFECT_MUD_SPORT') {
    if (state.field.statuses & STATUS_FIELD_MUDSPORT) {
      return outcome(ctx, { missed: true })
    }
    state.field.statuses |= STATUS_FIELD_MUDSPORT
    state.field.timers.started.mudSport = true
    state.field.timers.mudSportTimer = SPORT_DURATION
  } else {
    if (state.field.statuses & STATUS_FIELD_WATERSPORT) {
      return outcome(ctx, { missed: true })
    }
    state.field.statuses |= STATUS_FIELD_WATERSPORT
    state.field.timers.started.waterSport = true
    state.field.timers.waterSportTimer = SPORT_DURATION
  }

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_FAIRY_LOCK (Fairy Lock)
 * BattleScript_EffectFairyLock (data/battle_scripts_1.s:835-845),
 * VARIOUS_TRY_FAIRY_LOCK (src/battle_script_commands.c:6799-6808).
 */
export function handleFairyLock(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:837)
  const missed = checkAccuracy(ctx, targetId ?? battlerId, moveId)
  // 2. ppreduce (:839)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { missed: true })

  // 3. trysetfairylock BattleScript_ButItFailed (VARIOUS_TRY_FAIRY_LOCK:6799-6808)
  if (state.field.statuses & STATUS_FIELD_FAIRY_LOCK) {
    return outcome(ctx, { missed: true })
  }

  state.field.statuses |= STATUS_FIELD_FAIRY_LOCK
  state.field.timers.started.fairyLock = true
  state.field.timers.fairyLockTimer = 1

  return outcome(ctx, { missed: false })
}

// ---------------------------------------------------------------------------
// Ability-change moves (Cycle 59) helpers
// ---------------------------------------------------------------------------

/**
 * DoesBattlerHaveAbilityShield, battle_util.c:6539-6545. No ability sets blocksAbilitySuppression in
 * abilityHooks.json, so only the held Ability Shield (unless Embargoed) can return true.
 */
export function doesBattlerHaveAbilityShield(battler: BattlerState, deps: { dataContext: SimDataContext }): boolean {
  if (battler.mon.itemId) {
    const item = deps.dataContext.item(battler.mon.itemId)
    if (item?.resolvedHoldEffect === 'HOLD_EFFECT_ABILITY_SHIELD' && !hasFlag(battler.statuses3, STATUS3_EMBARGO)) {
      return true
    }
  }
  return false
}

/** The four ability slots in C order, with an empty slot spelled ABILITY_NONE as in gBattleMons. */
function abilitySlotIds(battler: BattlerState): string[] {
  return [battler.mon.abilities.ability, ...battler.mon.abilities.innates].map((a) => a ?? 'ABILITY_NONE')
}

/**
 * HasAbilityIgnoringSuppression, battle_util.c:9315-9323 -- every slot, suppressed or not. An empty
 * slot is ABILITY_NONE, so asking about ABILITY_NONE matches a battler with an empty innate slot.
 */
export function hasAbilityIgnoringSuppression(battler: BattlerState, abilityId: string): boolean {
  return abilitySlotIds(battler).includes(abilityId)
}

/**
 * UpdateAbilityStateIndicesForNewAbility / UpdateAbilityStateIndices (battle_util.c:8819-8862): each
 * new slot takes switchInAbilityDone, turnAbilityTriggers and abilityState from the first old slot
 * holding the same ability, else zero. Called before ReplaceAbility, so the old slot 0 is still in place.
 */
function updateAbilityStateForNewAbilities(battler: BattlerState, newAbilities: string[]): void {
  const oldAbilities = abilitySlotIds(battler)
  const switchInAbilityDone = newAbilities.map(() => false)
  const turnAbilityTriggers = newAbilities.map(() => 0)
  const abilityState = newAbilities.map(() => 0)
  for (let i = 0; i < newAbilities.length; i++) {
    const j = oldAbilities.indexOf(newAbilities[i]!)
    if (j < 0) continue
    switchInAbilityDone[i] = battler.volatiles.switchInAbilityDone[j] ?? false
    turnAbilityTriggers[i] = battler.turn.turnAbilityTriggers[j] ?? 0
    abilityState[i] = battler.volatiles.abilityState[j] ?? 0
  }
  battler.volatiles.switchInAbilityDone = switchInAbilityDone
  battler.turn.turnAbilityTriggers = turnAbilityTriggers
  battler.volatiles.abilityState = abilityState
}

export function updateAbilityStateForNewAbility(battler: BattlerState, newAbility: string): void {
  const oldAbilities = abilitySlotIds(battler)
  updateAbilityStateForNewAbilities(battler, [newAbility, ...oldAbilities.slice(1)])
}

/**
 * EFFECT_GASTRO_ACID (Gastro Acid)
 * BattleScript_EffectGastroAcid (data/battle_scripts_1.s:2581-2596),
 * Cmd_setgastroacid (src/battle_script_commands.c:11831-11838),
 * BattleScript_EffectPoison (data/battle_scripts_1.s:4332-4344).
 */
export function handleGastroAcid(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2583)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 2. ppreduce (:2585; also inside BattleScript_PrintMoveMissed on miss)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. setgastroacid BattleScript_EffectPoison (Cmd_setgastroacid, src/battle_script_commands.c:11831-11838)
  const failsGastroAcid =
    hasFlag(target.statuses3, STATUS3_GASTRO_ACID) || doesBattlerHaveAbilityShield(target, deps)

  if (failsGastroAcid) {
    // Branch to BattleScript_EffectPoison (data/battle_scripts_1.s:4332-4344), which starts over:
    // - attackcanceler (:4333): its canceller ladder already ran to CANCELLER_END this action, so
    //   nothing in it is re-run here
    // - attackstring (:4334)
    // - ppreduce (:4335): Cmd_ppreduce has no once-per-move guard (:1460-1495), so a second PP goes
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)

    // - requirecandoeffect BS_TARGET, MOVE_EFFECT_POISON (:4336, battle_script_commands.c:8544-8552)
    if (!canBePoisoned(state, battlerId, targetId, moveId, deps)) {
      return outcome(ctx, { targetId, missed: true })
    }

    // - accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:4337) -> second accuracy check
    const poisonMissed = checkAccuracy(ctx, targetId, moveId)
    if (poisonMissed) {
      return outcome(ctx, { targetId, missed: true })
    }

    // - setmoveeffect MOVE_EFFECT_POISON, seteffectprimary (:4340-4341)
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

  // Success branch of setgastroacid:
  target.statuses3 = setFlag(target.statuses3, STATUS3_GASTRO_ACID)

  // trytoclearprimalweather (VARIOUS_TRY_TO_CLEAR_PRIMAL_WEATHER, battle_script_commands.c:7964-7981)
  if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
    unmodelled.push('trytoclearprimalweather not modelled')
  }

  // setmoveeffect MOVE_EFFECT_POISON, seteffectprimary (:2594-2595)
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
 * EFFECT_SIMPLE_BEAM (Simple Beam)
 * BattleScript_EffectSimpleBeam (data/battle_scripts_1.s:2321-2334),
 * VARIOUS_SET_SIMPLE_BEAM (src/battle_script_commands.c:7220-7229).
 */
export function handleSimpleBeam(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2323)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 2. ppreduce (:2325)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. setabilitysimple BS_TARGET, BattleScript_ButItFailed (VARIOUS_SET_SIMPLE_BEAM:7220-7229)
  const targetAbility = target.mon.abilities.ability ?? 'ABILITY_NONE'
  if (
    isEntrainmentTargetOrSimpleBeamBannedAbility(targetAbility) ||
    hasAbilityIgnoringSuppression(target, 'ABILITY_SIMPLE') ||
    doesBattlerHaveAbilityShield(target, deps)
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  updateAbilityStateForNewAbility(target, 'ABILITY_SIMPLE')
  target.mon.abilities.ability = 'ABILITY_SIMPLE'

  // trytoclearprimalweather (VARIOUS_TRY_TO_CLEAR_PRIMAL_WEATHER:7964-7981)
  if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
    unmodelled.push('trytoclearprimalweather not modelled')
  }

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_WORRY_SEED (Worry Seed)
 * BattleScript_EffectWorrySeed (data/battle_scripts_1.s:2416-2432),
 * Cmd_tryworryseed (src/battle_script_commands.c:13091-13100).
 * MOVE_EFFECT_FEAR applied on both success and fail paths of tryworryseed (:2429-2432;
 * battle_script_commands.c:2364-2387, 2996-2999; battle_scripts_1.s:2444-2455; VARIOUS_SET_FEAR :8178-8181).
 */
export function handleWorrySeed(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2418)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 2. ppreduce (:2420)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. tryworryseed BattleScript_EffectWorrySeed_Fear (Cmd_tryworryseed:13091-13100)
  const targetAbility = target.mon.abilities.ability ?? 'ABILITY_NONE'
  const failsWorrySeed =
    isWorrySeedBannedAbility(targetAbility) ||
    hasAbilityIgnoringSuppression(target, 'ABILITY_INSOMNIA') ||
    doesBattlerHaveAbilityShield(target, deps)

  if (!failsWorrySeed) {
    updateAbilityStateForNewAbility(target, 'ABILITY_INSOMNIA')
    target.mon.abilities.ability = 'ABILITY_INSOMNIA'

    // trytoclearprimalweather (VARIOUS_TRY_TO_CLEAR_PRIMAL_WEATHER:7964-7981)
    if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
      unmodelled.push('trytoclearprimalweather not modelled')
    }
  }

  // 4. BattleScript_EffectWorrySeed_Fear (:2429-2432):
  // setmoveeffect MOVE_EFFECT_FEAR, seteffectprimary
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

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_ENTRAINMENT (Entrainment)
 * BattleScript_EffectEntrainment (data/battle_scripts_1.s:2269-2282),
 * VARIOUS_TRY_ENTRAINMENT (src/battle_script_commands.c:7230-7244),
 * VARIOUS_SET_LAST_USED_ABILITY (:7258-7260),
 * switchinabilities BS_TARGET (VARIOUS_SWITCHIN_ABILITIES:7087-7098).
 */
export function handleEntrainment(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2271)
  const missed = checkAccuracy(ctx, targetId, moveId)
  // 2. ppreduce (:2273)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. tryentrainment BattleScript_ButItFailed (VARIOUS_TRY_ENTRAINMENT:7230-7244)
  const userAbility = battler.mon.abilities.ability ?? 'ABILITY_NONE'
  const targetAbility = target.mon.abilities.ability ?? 'ABILITY_NONE'

  if (
    isEntrainmentBannedAbilityAttacker(userAbility) ||
    isEntrainmentTargetOrSimpleBeamBannedAbility(targetAbility) ||
    doesBattlerHaveAbilityShield(target, deps) ||
    hasAbilityIgnoringSuppression(target, userAbility)
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  updateAbilityStateForNewAbility(target, userAbility)
  target.mon.abilities.ability = userAbility

  // 4. switchinabilities BS_TARGET (:2281, VARIOUS_SWITCHIN_ABILITIES:7087-7098)
  applySwitchInAbilities(state, targetId, deps, unmodelled)

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_ROLE_PLAY (Role Play)
 * BattleScript_EffectRolePlay (data/battle_scripts_1.s:6294-6304),
 * Cmd_trycopyability (src/battle_script_commands.c:11767-11781).
 * Accuracy check uses NO_ACC_CALC_CHECK_LOCK_ON (:6298; Cmd_accuracycheck :1403-1411)
 * and comes after ppreduce (:6297).
 */
export function handleRolePlay(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:6297)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. accuracycheck BattleScript_ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:6298)
  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. trycopyability BattleScript_ButItFailed (Cmd_trycopyability:11767-11781)
  const defAbility = target.mon.abilities.ability ?? 'ABILITY_NONE'
  const atkAbility = battler.mon.abilities.ability ?? 'ABILITY_NONE'

  if (
    hasAbilityIgnoringSuppression(battler, defAbility) ||
    defAbility === 'ABILITY_NONE' ||
    isRolePlayBannedAbilityAtk(atkAbility) ||
    isRolePlayBannedAbility(defAbility) ||
    doesBattlerHaveAbilityShield(battler, deps)
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  updateAbilityStateForNewAbility(battler, defAbility)
  battler.mon.abilities.ability = defAbility

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_SKILL_SWAP (Skill Swap)
 * BattleScript_EffectSkillSwap (data/battle_scripts_1.s:6449-6472),
 * Cmd_tryswapabilities (src/battle_script_commands.c:11923-11946).
 * Accuracy check uses NO_ACC_CALC_CHECK_LOCK_ON (:6453; Cmd_accuracycheck :1403-1411)
 * and comes after ppreduce (:6452).
 * Switch-in abilities triggered for attacker then target (B_SKILL_SWAP >= GEN_4, :6466-6470;
 * VARIOUS_SWITCHIN_ABILITIES :7087-7098).
 */
export function handleSkillSwap(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:6452)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. accuracycheck BattleScript_ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:6453)
  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. tryswapabilities BattleScript_ButItFailed (Cmd_tryswapabilities:11923-11946)
  const atkAbility = battler.mon.abilities.ability ?? 'ABILITY_NONE'
  const defAbility = target.mon.abilities.ability ?? 'ABILITY_NONE'

  if (
    isRolePlayBannedAbility(atkAbility) ||
    isRolePlayBannedAbility(defAbility) ||
    hasAbilityIgnoringSuppression(battler, defAbility) ||
    hasAbilityIgnoringSuppression(target, atkAbility) ||
    doesBattlerHaveAbilityShield(battler, deps) ||
    doesBattlerHaveAbilityShield(target, deps)
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  updateAbilityStateForNewAbility(battler, defAbility)
  updateAbilityStateForNewAbility(target, atkAbility)

  battler.mon.abilities.ability = defAbility
  target.mon.abilities.ability = atkAbility

  // 4. switchinabilities BS_ATTACKER, switchinabilities BS_TARGET (B_SKILL_SWAP >= GEN_4, :6466-6470)
  applySwitchInAbilities(state, battlerId, deps, unmodelled)
  applySwitchInAbilities(state, targetId, deps, unmodelled)

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_SPITE (Spite)
 * BattleScript_EffectSpite (data/battle_scripts_1.s:4821-4831),
 * Cmd_tryspiteppreduce (src/battle_script_commands.c:10975-11020).
 * ppreduce runs before accuracycheck (:4824-4825).
 * Spite reduces the PP of the target's last move by 4 (B_PP_REDUCED_BY_SPITE >= GEN_4).
 * Fails if target has no last move, last move is MOVE_NONE, last move is not known by target,
 * or target's PP for that move is 0 (B_CAN_SPITE_FAIL >= GEN_4).
 * When PP reaches 0, multi-turn moves are cancelled (CancelMultiTurnMoves: battle_util.c:1164-1179).
 */
export function handleSpite(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const target = state.battlers[targetId]!

  // 1. ppreduce (:4824)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:4825)
  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. tryspiteppreduce BattleScript_ButItFailed (Cmd_tryspiteppreduce:10975-11020)
  const lastMove = target.lastMove
  if (!lastMove || lastMove === 'MOVE_NONE') {
    return outcome(ctx, { targetId, missed: true })
  }

  const moveIdx = target.mon.moves.indexOf(lastMove)
  if (moveIdx === -1 || (target.mon.pp[moveIdx] ?? 0) === 0) {
    return outcome(ctx, { targetId, missed: true })
  }

  const currentPp = target.mon.pp[moveIdx] ?? 0
  const ppToDeduct = Math.min(4, currentPp)
  target.mon.pp[moveIdx] = currentPp - ppToDeduct

  if (target.mon.pp[moveIdx] === 0) {
    cancelMultiTurnMoves(target)
  }

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_GRUDGE (Grudge)
 * BattleScript_EffectGrudge (data/battle_scripts_1.s:6511-6520),
 * Cmd_setuserstatus3 (src/battle_script_commands.c:11991-12002).
 * ppreduce runs before setuserstatus3 (:6514-6515).
 * Sets STATUS3_GRUDGE on user. Fails if user already has STATUS3_GRUDGE.
 * CANCELLER_FLAGS (battle_util.c:3204-3208; attackCanceller.ts:340) clears STATUS3_GRUDGE on user's next action.
 * When the user faints from an opponent's damaging move (Cmd_tryfaintmon: battle_script_commands.c:3252-3263),
 * the opponent's move loses all its PP.
 */
export function handleGrudge(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) {
    return outcome(ctx, {})
  }

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:6514)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setuserstatus3 STATUS3_GRUDGE, BattleScript_ButItFailed (Cmd_setuserstatus3:11991-12002)
  if (hasFlag(battler.statuses3, STATUS3_GRUDGE)) {
    return outcome(ctx, { missed: true })
  }

  battler.statuses3 = setFlag(battler.statuses3, STATUS3_GRUDGE)
  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_IMPRISON (Imprison)
 * BattleScript_EffectImprison (data/battle_scripts_1.s:6473-6482),
 * Cmd_tryimprison (src/battle_script_commands.c:11948-11977).
 * ppreduce runs before tryimprison (:6476-6477).
 * Fails if user already has STATUS3_IMPRISONED_OTHERS (:11949-11950).
 * Checks opposing battlers: if at least one foe shares a non-MOVE_NONE move with user,
 * sets STATUS3_IMPRISONED_OTHERS on user (:11954-11971).
 * Otherwise fails if no foe shares any move with user (:11974-11975).
 * CANCELLER_IMPRISONED (battle_util.c:3358-3367; attackCanceller.ts) cancels moves known by opposing
 * battler with STATUS3_IMPRISONED_OTHERS.
 */
export function handleImprison(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) {
    return outcome(ctx, {})
  }

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:6476)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. tryimprison BattleScript_ButItFailed (Cmd_tryimprison:11948-11977)
  if (hasFlag(battler.statuses3, STATUS3_IMPRISONED_OTHERS)) {
    return outcome(ctx, { missed: true })
  }

  const battlerSide = battlerId & 1
  let sharesMoveWithAnyFoe = false

  for (let i = 0; i < state.battlers.length; i++) {
    const foe = state.battlers[i]
    if (!foe || (i & 1) === battlerSide) continue

    for (const userMove of battler.mon.moves) {
      if (userMove && userMove !== 'MOVE_NONE' && foe.mon.moves.includes(userMove)) {
        sharesMoveWithAnyFoe = true
        break
      }
    }
    if (sharesMoveWithAnyFoe) break
  }

  if (!sharesMoveWithAnyFoe) {
    return outcome(ctx, { missed: true })
  }

  battler.statuses3 = setFlag(battler.statuses3, STATUS3_IMPRISONED_OTHERS)
  return outcome(ctx, { missed: false })
}

/**
 * sTelekinesisBanList (src/battle_script_commands.c:13007-13017).
 */
const TELEKINESIS_BANNED_SPECIES: ReadonlySet<string> = new Set([
  'SPECIES_DIGLETT',
  'SPECIES_DUGTRIO',
  'SPECIES_DIGLETT_ALOLAN',
  'SPECIES_DUGTRIO_ALOLAN',
  'SPECIES_SANDYGAST',
  'SPECIES_PALOSSAND',
  'SPECIES_GENGAR_MEGA',
])

/**
 * EFFECT_TELEKINESIS (Telekinesis)
 * BattleScript_EffectTelekinesis (data/battle_scripts_1.s:2547-2557),
 * Cmd_settelekinesis (src/battle_script_commands.c:13028-13037).
 * accuracycheck NO_ACC_CALC_CHECK_LOCK_ON runs before ppreduce (:2549-2551).
 * In C, missing branches to BattleScript_PrintMoveMissed which also runs ppreduce.
 * Fails if:
 * 1. Target already has STATUS3_TELEKINESIS, STATUS3_ROOTED, or STATUS3_SMACKED_DOWN (:13029).
 * 2. Field has STATUS_FIELD_GRAVITY (:13029).
 * 3. Target species is in sTelekinesisBanList (:13007-13026): Diglett, Dugtrio,
 *    Alolan Diglett, Alolan Dugtrio, Sandygast, Palossand, Mega Gengar.
 * On success, sets STATUS3_TELEKINESIS and telekinesisTimer = 3 (:13033-13034).
 * ENDTURN_TELEKINESIS (battle_util.c:2886-2894; endTurn.ts) decrements timer and clears status at 0.
 */
export function handleTelekinesis(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const target = state.battlers[targetId]!

  // 1. accuracycheck BattleScript_PrintMoveMissed, NO_ACC_CALC_CHECK_LOCK_ON (:2549)
  // Both hit and miss paths deduct PP (ppreduce at :2551 and inside BattleScript_PrintMoveMissed).
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. settelekinesis BattleScript_ButItFailed (Cmd_settelekinesis:13028-13037)
  if (
    hasFlag(target.statuses3, STATUS3_TELEKINESIS | STATUS3_ROOTED | STATUS3_SMACKED_DOWN) ||
    hasFlag(state.field.statuses, STATUS_FIELD_GRAVITY) ||
    TELEKINESIS_BANNED_SPECIES.has(target.mon.speciesId)
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.statuses3 = setFlag(target.statuses3, STATUS3_TELEKINESIS)
  target.volatiles.telekinesisTimer = 3

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_ELECTRIFY (Electrify)
 * BattleScript_EffectElectrify (data/battle_scripts_1.s:1976-1987),
 * VARIOUS_TRY_ELECTRIFY (src/battle_script_commands.c:7338-7347).
 * accuracycheck ACC_CURR_MOVE runs before ppreduce (:1978-1980);
 * missing branches to BattleScript_PrintMoveMissed which also reduces PP.
 * tryelectrify:
 * 1. Checks ProtectSucceeds(attacker): shares protectUses with protect-like moves.
 *    If last move was not protection move, resets protectUses to 0.
 *    Rolls Random() <= PROTECT_SUCCESS_RATES[protectUses] (:6649-6655).
 * 2. Checks gCurrentTurnActionNumber >= GetBattlerTurnOrderNum(target):
 *    fails if user acts at or after target's turn (target already acted).
 * If either fails, resets protectUses to 0 and fails (costs PP since ppreduce already ran).
 * If both succeed, increments protectUses and sets STATUS4_ELECTRIFIED on target.
 * Cleared at end of turn by ENDTURN_ELECTRIFY (battle_util.c:2915-2918; endTurn.ts).
 */
export function handleElectrify(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp, turnOrderIndex, order } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:1978)
  // Both hit and miss paths deduct PP (ppreduce at :1980 and inside BattleScript_PrintMoveMissed).
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. tryelectrify BattleScript_ButItFailed (VARIOUS_TRY_ELECTRIFY: battle_script_commands.c:7338-7347)
  // ProtectSucceeds, battle_script_commands.c:6649-6655
  const lastMoveId = battler.lastMove
  const lastMoveData = lastMoveId ? deps.dataContext.move(lastMoveId) : undefined
  if (!lastMoveData?.flags?.isProtection) {
    battler.volatiles.protectUses = 0
  }

  let protectSucceeds = false
  if (battler.volatiles.protectUses <= 3) {
    const threshold = PROTECT_SUCCESS_RATES[battler.volatiles.protectUses]!
    const roll = state.rng.random16()
    if (threshold >= roll) {
      protectSucceeds = true
    }
  }

  // gCurrentTurnActionNumber >= GetBattlerTurnOrderNum(gBattlerTarget)
  const targetTurnOrderNum = order ? order.battlerByTurnOrder.indexOf(targetId) : -1
  const targetAlreadyActed = targetTurnOrderNum !== -1 && turnOrderIndex >= targetTurnOrderNum

  if (!protectSucceeds || targetAlreadyActed) {
    battler.volatiles.protectUses = 0
    return outcome(ctx, { targetId, missed: true })
  }

  battler.volatiles.protectUses++
  // Its reader, GetMoveTypeInternal (battle_main.c:5196), is calculate.ts's `attackerElectrified`, fed by damageResolver.ts.
  target.statuses4 = setFlag(target.statuses4, STATUS4_ELECTRIFIED)

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_POWER_TRICK (Power Trick)
 * BattleScript_EffectPowerTrick (data/battle_scripts_1.s:1444-1454),
 * VARIOUS_POWER_TRICK (src/battle_script_commands.c:7690-7694).
 * Toggles STATUS3_POWER_TRICK (XOR, so a second use clears it and swaps back) and swaps the
 * user's Attack and Defense stats and their stat stages. Never fails.
 * Readers not ported: the Baton Pass re-swap (battle_main.c:2833) and the exp-gain stat
 * reload (battle_script_commands.c:3655).
 */
export function handlePowerTrick(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:1446) -- PrintMoveMissed runs ppreduce too.
  const missed = checkAccuracy(ctx, targetId ?? battlerId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { missed: true })

  battler.statuses3 ^= STATUS3_POWER_TRICK
  const mon = battler.mon
  const atk = mon.rawStats.atk
  mon.rawStats.atk = mon.rawStats.def
  mon.rawStats.def = atk
  const atkStage = mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  mon.statStages[STAT_ATK] = mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
  mon.statStages[STAT_DEF] = atkStage

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_ION_DELUGE (Ion Deluge)
 * BattleScript_EffectIonDeluge (data/battle_scripts_1.s:2228-2238).
 * Sets STATUS_FIELD_ION_DELUGE with no fail check. ENDTURN_ION_DELUGE (battle_util.c:2171-2174;
 * fieldEndTurn.ts) clears it every end of turn.
 */
export function handleIonDeluge(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2230) -- PrintMoveMissed runs ppreduce too.
  const missed = checkAccuracy(ctx, targetId ?? battlerId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) return outcome(ctx, { missed: true })

  // Its reader, GetMoveTypeInternal (battle_main.c:5196), is calculate.ts's `ionDelugeActive`, fed by damageResolver.ts.
  state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_ION_DELUGE)

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_POWDER (Powder)
 * BattleScript_EffectPowder (data/battle_scripts_1.s:1121-1132),
 * VARIOUS_SET_POWDER (src/battle_script_commands.c:6910-6912).
 * Fails if the target already has STATUS2_POWDER. ENDTURN_POWDER (battle_util.c:2919-2921;
 * endTurn.ts) clears it every end of turn; CANCELLER_POWDER_STATUS is in attackCanceller.ts.
 */
export function handlePowder(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // accuracycheck BattleScript_PrintMoveMissed, NO_ACC_CALC_CHECK_LOCK_ON (:1123) -- PrintMoveMissed runs ppreduce too.
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) return outcome(ctx, { targetId, missed: true })

  // jumpifstatus2 BS_TARGET, STATUS2_POWDER, BattleScript_ButItFailed (:1126)
  if (hasFlag(target.mon.status2, STATUS2_POWDER)) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.mon.status2 = setFlag(target.mon.status2, STATUS2_POWDER)
  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_DO_NOTHING (Celebrate, Happy Hour, Hold Hands; vanilla Splash).
 * BattleScript_EffectDoNothing (data/battle_scripts_1.s:4594-4620).
 * Note: In Elite Redux v2.65beta moves.json, MOVE_SPLASH was reworked to EFFECT_HEAT_CRASH;
 * MOVE_CELEBRATE, MOVE_HAPPY_HOUR, and MOVE_HOLD_HANDS use EFFECT_DO_NOTHING.
 * - Deducts PP unconditionally after attackcanceler (:4597).
 * - MOVE_HOLD_HANDS (:4598, :4607-4612): fails if target's side has SIDE_STATUS_CRAFTY_SHIELD
 *   or if gBattlerTarget == gBattlerAttacker (no alive ally, SetAttackingStructValues,
 *   src/battle_util.c:283-287).
 * - MOVE_CELEBRATE (:4601, :4613-4616): prints STRINGID_CELEBRATEMESSAGE and ends.
 * - MOVE_HAPPY_HOUR (:4602, :4617-4620): MOVE_EFFECT_HAPPY_HOUR (src/battle_script_commands.c:2692-2697)
 *   doubles gBattleStruct->moneyMultiplier when used by B_SIDE_PLAYER (gapped when player-side).
 * - Default (:4603-4606): increments GAME_STAT_USED_SPLASH, prints STRINGID_BUTNOTHINGHAPPENED, ends.
 */
export function handleDoNothing(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  if (moveId === 'MOVE_HOLD_HANDS') {
    const partnerId = battlerId ^ 2
    const partner = state.battlers[partnerId]
    const partnerSlot = partner ? findAbilitySlot(partner.mon.abilities, 'ABILITY_COMMANDER') : -1
    const partnerCommanderActive = partnerSlot !== -1 && (partner!.volatiles.abilityState[partnerSlot] ?? 0) >= 1
    const resolvedTarget =
      isBattlerAlive(state, partnerId) && !partnerCommanderActive && targetId !== battlerId
        ? partnerId
        : battlerId
    if (
      hasFlag(state.sides[resolvedTarget & 1].statuses, SIDE_STATUS_CRAFTY_SHIELD) ||
      resolvedTarget === battlerId
    ) {
      return outcome(ctx, { targetId: resolvedTarget, missed: true })
    }
    return outcome(ctx, { targetId: resolvedTarget, missed: false })
  }

  if (moveId === 'MOVE_HAPPY_HOUR' && (battlerId & 1) === B_SIDE_PLAYER) {
    unmodelled.push(
      'MOVE_EFFECT_HAPPY_HOUR (battle_script_commands.c:2692-2697): gBattleStruct->moneyMultiplier / moneyMultiplierMove not modelled',
    )
  }

  return outcome(ctx, { missed: false })
}

/**
 * GetBattlerWeight, src/battle_util.c:6705-6734.
 * Returns null if species data is unavailable in dataContext.
 */
function getBattlerWeight(
  state: BattleState,
  battlerId: number,
  attackerId: number,
  deps: TurnLoopDeps,
): number | null {
  const battler = state.battlers[battlerId]
  if (!battler) return null
  const species = deps.dataContext.species(battler.mon.speciesId)
  if (!species) return null

  let weight = species.weight
  const holdEffect = deps.grounding.holdEffectOf(battlerId)
  const attacker = state.battlers[attackerId]
  const attackerHasMB = attacker ? attackerHasMoldBreakerActive(attacker, deps) : false

  if (battlerHasSimAbility(state, battler, 'ABILITY_HEAVY_METAL', true, attackerId, attackerHasMB, deps.dataContext)) {
    weight *= 2
  }
  if (battlerHasSimAbility(state, battler, 'ABILITY_LIGHT_METAL', true, attackerId, attackerHasMB, deps.dataContext)) {
    weight = Math.trunc(weight / 2)
  }
  if (battlerHasSimAbility(state, battler, 'ABILITY_LEAD_COAT', true, attackerId, attackerHasMB, deps.dataContext)) {
    weight *= 3
  }
  if (battlerHasSimAbility(state, battler, 'ABILITY_TERASTAL_TREASURE', true, attackerId, attackerHasMB, deps.dataContext)) {
    weight *= 3
  }
  if (battlerHasSimAbility(state, battler, 'ABILITY_CHROME_COAT', true, attackerId, attackerHasMB, deps.dataContext)) {
    weight *= 3
  }
  if (holdEffect === 'HOLD_EFFECT_FLOAT_STONE') {
    weight = Math.trunc(weight / 2)
  }

  for (let i = 0; i < battler.volatiles.autotomizeCount; i++) {
    if (weight > 1000) {
      weight -= 1000
    } else {
      weight = 1
      break
    }
  }

  if (weight === 0) weight = 1
  return weight
}

/**
 * EFFECT_AUTOTOMIZE (Autotomize).
 * BattleScript_EffectAutotomize (data/battle_scripts_1.s:1617-1640),
 * VARIOUS_TRY_AUTOTOMIZE (src/battle_script_commands.c:7533-7540).
 * Raises user's Speed by 2 stages, then if the stat raise succeeded (!MOVE_RESULT_NO_EFFECT),
 * increments volatiles.autotomizeCount when GetBattlerWeight > 1.
 */
export function handleAutotomize(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const statChanges: StatChangeOutcome[] = []
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    2,
    STAT_SPEED,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId, stat: STAT_SPEED, change: res.delta })
  }

  // BattleScript_AutotomizeWeightLoss (:1635-1640): jumpifmovehadnoeffect BattleScript_MoveEnd
  if (!res.missed) {
    const currentWeight = getBattlerWeight(state, battlerId, battlerId, deps)
    if (currentWeight === null || currentWeight > 1) {
      battler.volatiles.autotomizeCount++
    }
    unmodelled.push(
      "VARIOUS_TRY_AUTOTOMIZE (battle_script_commands.c:7533-7540, battle_util.c:6705-6734): volatiles.autotomizeCount is not read by bridge.ts's condition.weight (Heavy Slam / Low Kick)",
    )
  }

  return outcome(ctx, { statChanges, missed: res.missed ?? false })
}

/**
 * EFFECT_FLOWER_SHIELD (Flower Shield).
 * BattleScript_EffectFlowerShield (data/battle_scripts_1.s:1287-1320),
 * Cmd_selectfirstvalidtarget (src/battle_script_commands.c:11474-11481),
 * Cmd_jumpifnexttargetvalid (src/battle_script_commands.c:9240-9253),
 * Cmd_jumpbasedontype (src/battle_script_commands.c:3403-3427).
 * Raises Defense by 1 stage for all valid Grass-type battlers on the field (grounded or not).
 * Fails via BattleScript_ButItFailed if no valid target is Grass-type.
 */
export function handleFlowerShield(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const moveTarget = deps.dataContext.move(moveId)?.target ?? 'ALL_BATTLERS'
  const includesUser =
    moveTarget === 'ALL_BATTLERS' || moveTarget === 'USER' || moveTarget === 'USER_OR_ALLY'

  const validTargets: number[] = []
  for (let i = 0; i < state.battlersCount; i++) {
    if (i === battlerId && !includesUser) continue
    const b = state.battlers[i]
    if (!b) continue
    const cmdSlot = findAbilitySlot(b.mon.abilities, 'ABILITY_COMMANDER')
    if (cmdSlot !== -1 && (b.volatiles.abilityState[cmdSlot] ?? 0) >= 1) continue
    if (!isBattlerAlive(state, i)) continue
    validTargets.push(i)
  }

  // BattleScript_FlowerShieldIsAnyGrass (:1291-1295)
  const hasAnyGrass = validTargets.some((i) => state.battlers[i]!.mon.types.includes('GRASS'))
  if (!hasAnyGrass) {
    return outcome(ctx, { missed: true })
  }

  // BattleScript_FlowerShieldLoop (:1297-1320)
  const statChanges: StatChangeOutcome[] = []
  for (const i of validTargets) {
    const b = state.battlers[i]!
    if (!b.mon.types.includes('GRASS')) continue
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      i,
      1,
      STAT_DEF,
      STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (res.delta !== 0) {
      statChanges.push({ battlerId: i, stat: STAT_DEF, change: res.delta })
    }
  }

  return outcome(ctx, { statChanges })
}

/**
 * CompareStat(battlerId, statId, MAX_STAT_STAGE, cmpKind), src/battle_util.c:8545-8585.
 * Flips CMP_LESS_THAN <-> CMP_GREATER_THAN and MAX_STAT_STAGE <-> MIN_STAT_STAGE when
 * BattlerHasAbility(battlerId, ABILITY_CONTRARY, TRUE).
 */
function compareStatToMax(
  state: BattleState,
  battler: BattlerState,
  statId: number,
  cmpKind: 'LESS_THAN' | 'EQUAL',
  attackerId: number,
  deps: TurnLoopDeps,
): boolean {
  const stage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
  const attacker = state.battlers[attackerId]
  const attackerHasMB = attacker ? attackerHasMoldBreakerActive(attacker, deps) : false
  const hasContrary = battlerHasSimAbility(
    state,
    battler,
    'ABILITY_CONTRARY',
    true,
    attackerId,
    attackerHasMB,
    deps.dataContext,
  )
  if (cmpKind === 'LESS_THAN') {
    return hasContrary ? stage > MIN_STAT_STAGE : stage < MAX_STAT_STAGE
  }
  return hasContrary ? stage === MIN_STAT_STAGE : stage === MAX_STAT_STAGE
}

/**
 * IsRototillerAffected, src/battle_script_commands.c:6640-6647,
 * BlocksPrankster, src/battle_util.c:8622-8635.
 */
function isRototillerAffected(
  state: BattleState,
  attackerId: number,
  battlerId: number,
  deps: TurnLoopDeps,
): boolean {
  if (!isBattlerAlive(state, battlerId)) return false
  if (!isBattlerGrounded(state, battlerId, deps.grounding)) return false
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (!battler.mon.types.includes('GRASS')) return false
  if (hasFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE)) return false

  // BlocksPrankster(MOVE_ROTOTILLER, gBattlerAttacker, battlerId, FALSE) (:6645, battle_util.c:8622-8635)
  const attacker = state.battlers[attackerId]
  if (
    attacker &&
    battlerHasSimAbility(state, attacker, 'ABILITY_PRANKSTER', false, attackerId, false, deps.dataContext) &&
    (attackerId & 1) !== (battlerId & 1) &&
    battler.mon.types.includes('DARK')
  ) {
    return false
  }
  return true
}

/**
 * EFFECT_ROTOTILLER (Rototiller).
 * BattleScript_EffectRototiller (data/battle_scripts_1.s:1322-1380),
 * VARIOUS_GET_ROTOTILLER_TARGETS (src/battle_script_commands.c:7998-8013),
 * VARIOUS_JUMP_IF_NOT_ROTOTILLER_AFFECTED (src/battle_script_commands.c:8014-8021),
 * IsRototillerAffected (src/battle_script_commands.c:6640-6647).
 * Raises Attack and Sp. Atk by 1 stage (or 2 stages in Grassy Terrain, ER change at :1341-1346,
 * :1352-1357) for all grounded, non-semi-invulnerable Grass-type battlers not blocked by Prankster.
 * Fails via BattleScript_ButItFailed if no battler qualifies.
 */
export function handleRototiller(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // VARIOUS_GET_ROTOTILLER_TARGETS (:7998-8013)
  let count = 0
  for (let i = 0; i < state.battlersCount; i++) {
    const b = state.battlers[i]
    if (!b) continue
    b.turn.rototillerAffected = false
    if (isRototillerAffected(state, battlerId, i, deps)) {
      b.turn.rototillerAffected = true
      count++
    }
  }

  if (count === 0) {
    return outcome(ctx, { missed: true })
  }

  // BattleScript_RototillerLoop (:1332-1379)
  const statChanges: StatChangeOutcome[] = []
  let currentAttackerId = battlerId

  for (let i = 0; i < state.battlersCount; i++) {
    const b = state.battlers[i]
    if (!b) continue

    // C quirk (:1334-1335, :1369-1373): jumpifstat checks STAT_ATK and STAT_SPATK BEFORE
    // jumpifnotrototilleraffected, and BattleScript_RototillerCantRaiseMultipleStats executes
    // `copybyte gBattlerAttacker, gBattlerTarget` without restoring gBattlerAttacker.
    if (
      !compareStatToMax(state, b, STAT_ATK, 'LESS_THAN', currentAttackerId, deps) &&
      compareStatToMax(state, b, STAT_SPATK, 'EQUAL', currentAttackerId, deps)
    ) {
      currentAttackerId = i
      continue
    }

    // VARIOUS_JUMP_IF_NOT_ROTOTILLER_AFFECTED (:8014-8021)
    if (b.turn.rototillerAffected) {
      b.turn.rototillerAffected = false
    } else {
      continue
    }

    const stages = hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN) ? 2 : 1
    const rAtk = changeStatBuffsImplicit(
      state,
      currentAttackerId,
      i,
      stages,
      STAT_ATK,
      STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (rAtk.delta !== 0) {
      statChanges.push({ battlerId: i, stat: STAT_ATK, change: rAtk.delta })
    }

    const rSpAtk = changeStatBuffsImplicit(
      state,
      currentAttackerId,
      i,
      stages,
      STAT_SPATK,
      STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (rSpAtk.delta !== 0) {
      statChanges.push({ battlerId: i, stat: STAT_SPATK, change: rSpAtk.delta })
    }
  }

  return outcome(ctx, { statChanges })
}

/**
 * EFFECT_MAGNETIC_FLUX (Magnetic Flux).
 * BattleScript_EffectMagneticFlux (data/battle_scripts_1.s:1173-1211),
 * Cmd_jumpifability (src/battle_script_commands.c:3316-3349),
 * setallytonexttarget (.omc/team-pilot/battle_script.inc:2129-2136).
 * Checks user (battlerId) then partner (battlerId ^ 2); raises Defense and Sp. Def by 1 stage
 * for each that has ABILITY_MINUS or ABILITY_PLUS (checked with checkMoldBreaker = true).
 * Fails via BattleScript_ButItFailed if gBattleCommunication == 0 (no stat stage changed).
 */
export function handleMagneticFlux(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const attacker = state.battlers[battlerId]!
  const attackerHasMB = attackerHasMoldBreakerActive(attacker, deps)
  const statChanges: StatChangeOutcome[] = []
  let battleCommunication = 0

  for (const tId of [battlerId, battlerId ^ 2]) {
    const target = state.battlers[tId]
    if (!target || target.mon.hp === 0) continue

    const hasMinusOrPlus =
      battlerHasSimAbility(state, target, 'ABILITY_MINUS', true, battlerId, attackerHasMB, deps.dataContext) ||
      battlerHasSimAbility(state, target, 'ABILITY_PLUS', true, battlerId, attackerHasMB, deps.dataContext)
    if (!hasMinusOrPlus) continue

    if (
      !compareStatToMax(state, target, STAT_DEF, 'LESS_THAN', battlerId, deps) &&
      compareStatToMax(state, target, STAT_SPDEF, 'EQUAL', battlerId, deps)
    ) {
      continue
    }

    const rDef = changeStatBuffsImplicit(
      state,
      battlerId,
      tId,
      1,
      STAT_DEF,
      STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (rDef.delta !== 0) {
      statChanges.push({ battlerId: tId, stat: STAT_DEF, change: rDef.delta })
      battleCommunication++
    }

    const rSpDef = changeStatBuffsImplicit(
      state,
      battlerId,
      tId,
      1,
      STAT_SPDEF,
      STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (rSpDef.delta !== 0) {
      statChanges.push({ battlerId: tId, stat: STAT_SPDEF, change: rSpDef.delta })
      battleCommunication++
    }
  }

  if (battleCommunication === 0) {
    return outcome(ctx, { missed: true })
  }

  return outcome(ctx, { statChanges })
}

/**
 * SIDE_STATUS_SWAPPABLE, include/constants/battle.h:356-357.
 * C quirk: excludes SIDE_STATUS_LUCKY_CHANT even though VARIOUS_SWAP_SIDE_EFFECTS swaps
 * luckyChantTimer, started.luckyChant, and luckyChantBattlerId; includes SIDE_STATUS_STICKY_WEB
 * even when foamyWeb prevents swapping stickyWebTimer.
 */
const SIDE_STATUS_SWAPPABLE =
  SIDE_STATUS_HAZARDS_ANY |
  SIDE_STATUS_SCREEN_ANY |
  SIDE_STATUS_SAFEGUARD |
  SIDE_STATUS_MIST |
  SIDE_STATUS_TAILWIND |
  SIDE_STATUS_SMOKESCREEN

/**
 * EFFECT_COURT_CHANGE (Court Change).
 * BattleScript_EffectCourtChange (data/battle_scripts_1.s:24-32),
 * VARIOUS_SWAP_SIDE_EFFECTS (src/battle_script_commands.c:8325-8378).
 * Swaps SIDE_STATUS_SWAPPABLE bits and side timers between sides[0] and sides[1],
 * and flips *BattlerId fields with BATTLE_OPPOSITE (id ^ 1). Never fails.
 */
export function handleCourtChange(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const side0 = state.sides[0]
  const side1 = state.sides[1]
  const t0 = side0.timers
  const t1 = side1.timers

  // :8328-8332 -- swap SIDE_STATUS_SWAPPABLE bits
  const tempFlags = (side0.statuses & SIDE_STATUS_SWAPPABLE) >>> 0
  side0.statuses = ((side0.statuses & ~SIDE_STATUS_SWAPPABLE) | (side1.statuses & SIDE_STATUS_SWAPPABLE)) >>> 0
  side1.statuses = ((side1.statuses & ~SIDE_STATUS_SWAPPABLE) | tempFlags) >>> 0

  // :8334-8350 -- swap side timers and hazard amounts/types
  ;[t0.reflectTimer, t1.reflectTimer] = [t1.reflectTimer, t0.reflectTimer]
  ;[t0.lightscreenTimer, t1.lightscreenTimer] = [t1.lightscreenTimer, t0.lightscreenTimer]
  ;[t0.mistTimer, t1.mistTimer] = [t1.mistTimer, t0.mistTimer]
  ;[t0.safeguardTimer, t1.safeguardTimer] = [t1.safeguardTimer, t0.safeguardTimer]
  ;[t0.spikesAmount, t1.spikesAmount] = [t1.spikesAmount, t0.spikesAmount]
  ;[t0.toxicSpikesAmount, t1.toxicSpikesAmount] = [t1.toxicSpikesAmount, t0.toxicSpikesAmount]
  ;[t0.stealthRockType, t1.stealthRockType] = [t1.stealthRockType, t0.stealthRockType]
  ;[t0.auroraVeilTimer, t1.auroraVeilTimer] = [t1.auroraVeilTimer, t0.auroraVeilTimer]
  ;[t0.tailwindTimer, t1.tailwindTimer] = [t1.tailwindTimer, t0.tailwindTimer]
  ;[t0.luckyChantTimer, t1.luckyChantTimer] = [t1.luckyChantTimer, t0.luckyChantTimer]

  if (deps.grounding.monotypeChampType !== 'WATER') {
    ;[t0.swampTimer, t1.swampTimer] = [t1.swampTimer, t0.swampTimer]
  }

  ;[t0.fireSeaTimer, t1.fireSeaTimer] = [t1.fireSeaTimer, t0.fireSeaTimer]
  ;[t0.rainbowTimer, t1.rainbowTimer] = [t1.rainbowTimer, t0.rainbowTimer]
  ;[t0.smokescreenTimer, t1.smokescreenTimer] = [t1.smokescreenTimer, t0.smokescreenTimer]
  ;[t0.hotCoals, t1.hotCoals] = [t1.hotCoals, t0.hotCoals]
  ;[t0.caltrops, t1.caltrops] = [t1.caltrops, t0.caltrops]

  const tempStarted = { ...t0.started }
  t0.started = { ...t1.started }
  t1.started = tempStarted

  // :8352-8357 -- stickyWebTimer swapped only when neither side has foamyWeb;
  // otherwise started.spiderWeb is swapped back to its initial state.
  if (!t0.foamyWeb && !t1.foamyWeb) {
    ;[t0.stickyWebTimer, t1.stickyWebTimer] = [t1.stickyWebTimer, t0.stickyWebTimer]
  } else {
    ;[t0.started.spiderWeb, t1.started.spiderWeb] = [t1.started.spiderWeb, t0.started.spiderWeb]
  }

  // :8359-8374 -- UPDATE_COURTCHANGED_BATTLER: BATTLE_OPPOSITE(id) = id ^ 1
  ;[t0.reflectBattlerId, t1.reflectBattlerId] = [t1.reflectBattlerId ^ 1, t0.reflectBattlerId ^ 1]
  ;[t0.lightscreenBattlerId, t1.lightscreenBattlerId] = [t1.lightscreenBattlerId ^ 1, t0.lightscreenBattlerId ^ 1]
  ;[t0.mistBattlerId, t1.mistBattlerId] = [t1.mistBattlerId ^ 1, t0.mistBattlerId ^ 1]
  ;[t0.safeguardBattlerId, t1.safeguardBattlerId] = [t1.safeguardBattlerId ^ 1, t0.safeguardBattlerId ^ 1]
  ;[t0.auroraVeilBattlerId, t1.auroraVeilBattlerId] = [t1.auroraVeilBattlerId ^ 1, t0.auroraVeilBattlerId ^ 1]
  ;[t0.tailwindBattlerId, t1.tailwindBattlerId] = [t1.tailwindBattlerId ^ 1, t0.tailwindBattlerId ^ 1]
  ;[t0.luckyChantBattlerId, t1.luckyChantBattlerId] = [t1.luckyChantBattlerId ^ 1, t0.luckyChantBattlerId ^ 1]
  ;[t0.smokescreenBattler, t1.smokescreenBattler] = [t1.smokescreenBattler ^ 1, t0.smokescreenBattler ^ 1]

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_AFTER_YOU (After You).
 * BattleScript_EffectAfterYou (data/battle_scripts_1.s:1418-1428),
 * tryafteryou (.omc/team-pilot/battle_script.inc:1547-1550),
 * VARIOUS_AFTER_YOU (src/battle_script_commands.c:7695-7702),
 * GetBattlerTurnOrderNum (src/battle_script_commands.c:2169-2175).
 * Sets target.round.afterYou = true (read by getMoveSpeed, turnOrder.ts:458-459 /
 * src/battle_main.c:4302-4303, to reorder the target ahead of remaining battlers via
 * recalculateMoveOrder) unless gCurrentTurnActionNumber >= GetBattlerTurnOrderNum(target),
 * in which case it jumps to BattleScript_ButItFailed.
 */
export function handleAfterYou(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp, turnOrderIndex, order } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:1420), then ppreduce (:1422).
  // BattleScript_PrintMoveMissed also runs ppreduce, so PP is deducted on both paths.
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. tryafteryou BS_TARGET, BattleScript_ButItFailed (VARIOUS_AFTER_YOU, :7695-7702)
  const idx = order ? order.battlerByTurnOrder.indexOf(targetId) : -1
  const targetTurnOrderNum = idx === -1 ? state.battlersCount : idx
  if (turnOrderIndex >= targetTurnOrderNum) {
    return outcome(ctx, { targetId, missed: true })
  }

  target.round.afterYou = true
  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_QUASH (Quash).
 * BattleScript_EffectQuash (data/battle_scripts_1.s:2240-2250),
 * tryquash (.omc/team-pilot/battle_script.inc:1542-1545),
 * VARIOUS_TRY_QUASH (src/battle_script_commands.c:7281-7289).
 * In Elite Redux, Quash is a field-wide 5-turn effect (QUASH_DURATION = 5,
 * include/battle_util.h:70) that sets gFieldTimers.quashTimer and
 * gFieldTimers.started.quash (read by getMovePriority / getMoveSpeed /
 * getBattlerTotalSpeedStat in turnOrder.ts and decremented by ENDTURN_QUASH
 * in fieldEndTurn.ts). Fails if quashTimer != 0.
 */
export function handleQuash(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2242), then ppreduce (:2244).
  const missed = checkAccuracy(ctx, targetId ?? battlerId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed || state.field.timers.quashTimer !== 0) {
    return outcome(ctx, { missed: true })
  }

  // 2. tryquash BattleScript_ButItFailed (VARIOUS_TRY_QUASH, :7281-7289)
  state.field.timers.quashTimer = QUASH_DURATION
  state.field.timers.started.quash = true
  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_COACHING (Coaching).
 * BattleScript_EffectCoaching (data/battle_scripts_1.s:746-771),
 * jumpifnoally (.omc/team-pilot/battle_script.inc:1817-1820, VARIOUS_JUMP_IF_NO_ALLY,
 * src/battle_script_commands.c:6786-6789),
 * Cmd_jumpifstat / CompareStat (src/battle_script_commands.c:3370-3383, src/battle_util.c:8545-8585),
 * SetAttackingStructValues MOVE_TARGET_ALLY (src/battle_util.c:283-287).
 * Raises ally's Attack and Defense by 1 stage each (STAT_BUFF_ALLOW_PTR | STAT_BUFF_NOT_PROTECT_AFFECTED).
 * Fails if user has no alive partner or if target is already at max Attack and Defense.
 */
export function handleCoaching(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:749)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifnoally BS_ATTACKER, BattleScript_ButItFailed (VARIOUS_JUMP_IF_NO_ALLY, :6786-6789)
  const partnerId = battlerId ^ 2
  if (!isBattlerAlive(state, partnerId)) {
    return outcome(ctx, { missed: true })
  }

  // SetAttackingStructValues (:283-287): MOVE_TARGET_ALLY resolves gBattlerTarget to
  // BATTLE_PARTNER(gBattlerAttacker) unless gBattlerTarget has Commander active, in which
  // case it falls back to gBattlerAttacker.
  const partner = state.battlers[partnerId]!
  const initialTarget = targetId !== null ? state.battlers[targetId] : partner
  const cmdSlot = initialTarget ? findAbilitySlot(initialTarget.mon.abilities, 'ABILITY_COMMANDER') : -1
  const commanderActive = cmdSlot !== -1 && (initialTarget!.volatiles.abilityState[cmdSlot] ?? 0) >= 1
  const resolvedTargetId = !commanderActive ? partnerId : battlerId
  const target = state.battlers[resolvedTargetId]!

  // 3. EffectCoaching_CheckAllyStats (:751-754):
  // jumpifstat BS_TARGET, CMP_NOT_EQUAL, STAT_ATK/STAT_DEF, MAX_STAT_STAGE, BattleScript_CoachingWorks
  const canBoostAtk = !compareStatToMax(state, target, STAT_ATK, 'EQUAL', battlerId, deps)
  const canBoostDef = !compareStatToMax(state, target, STAT_DEF, 'EQUAL', battlerId, deps)
  if (!canBoostAtk && !canBoostDef) {
    return outcome(ctx, { targetId: resolvedTargetId, missed: true })
  }

  // 4. BattleScript_CoachingWorks (:755-771)
  const statChanges: StatChangeOutcome[] = []
  const rAtk = changeStatBuffsImplicit(
    state,
    battlerId,
    resolvedTargetId,
    1,
    STAT_ATK,
    STAT_BUFF_ALLOW_PTR | STAT_BUFF_NOT_PROTECT_AFFECTED,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (rAtk.delta !== 0) {
    statChanges.push({ battlerId: resolvedTargetId, stat: STAT_ATK, change: rAtk.delta })
  }

  const rDef = changeStatBuffsImplicit(
    state,
    battlerId,
    resolvedTargetId,
    1,
    STAT_DEF,
    STAT_BUFF_ALLOW_PTR | STAT_BUFF_NOT_PROTECT_AFFECTED,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (rDef.delta !== 0) {
    statChanges.push({ battlerId: resolvedTargetId, stat: STAT_DEF, change: rDef.delta })
  }

  return outcome(ctx, { targetId: resolvedTargetId, statChanges, missed: false })
}

/**
 * EFFECT_AROMATIC_MIST (Aromatic Mist).
 * BattleScript_EffectAromaticMist (data/battle_scripts_1.s:1134-1171),
 * Cmd_jumpifstat / CompareStat (src/battle_script_commands.c:3370-3383, src/battle_util.c:8545-8585),
 * VARIOUS_JUMP_IF_ABSENT (src/battle_script_commands.c:6769-6772).
 * Elite Redux reworks Aromatic Mist to target USER and raise Sp. Def by 2 stages for both
 * BS_ATTACKER and (if alive) BS_ATTACKER_PARTNER. Fails via BattleScript_ButItFailed only if
 * BS_ATTACKER is at max Sp. Def and BS_ATTACKER_PARTNER is absent or also at max Sp. Def.
 * Note: data/battle_scripts_1.s:1161,1163 mistakenly jump to BattleScript_AromaticMistPrintString
 * (:1153) instead of BattleScript_AromaticMistPrintStringParnter (:1168), which in C loops
 * BattleScript_AromaticMistPartner indefinitely when an alive partner is present; we execute the
 * partner statbuffchange once and proceed to BattleScript_MoveEnd.
 */
export function handleAromaticMist(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:1137)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. Pre-check (:1138-1140):
  // jumpifstat BS_ATTACKER, CMP_NOT_EQUAL, STAT_SPDEF, MAX_STAT_STAGE, BattleScript_EffectAromaticMist_Works
  // jumpifabsent BS_ATTACKER_PARTNER, BattleScript_ButItFailed
  // jumpifstat BS_ATTACKER_PARTNER, CMP_EQUAL, STAT_SPDEF, MAX_STAT_STAGE, BattleScript_ButItFailed
  const partnerId = battlerId ^ 2
  const partnerAlive = isBattlerAlive(state, partnerId)
  const partner = partnerAlive ? state.battlers[partnerId]! : null
  const attackerAtMax = compareStatToMax(state, battler, STAT_SPDEF, 'EQUAL', battlerId, deps)
  if (attackerAtMax) {
    if (!partner || compareStatToMax(state, partner, STAT_SPDEF, 'EQUAL', battlerId, deps)) {
      return outcome(ctx, { missed: true })
    }
  }

  // 3. BattleScript_EffectAromaticMist_Works (:1141-1152):
  // setstatchanger STAT_SPDEF, 2, FALSE
  // statbuffchange MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR, BattleScript_AromaticMistPrintString
  const statChanges: StatChangeOutcome[] = []
  const rUser = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId ?? battlerId,
    2,
    STAT_SPDEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (rUser.delta !== 0) {
    statChanges.push({ battlerId, stat: STAT_SPDEF, change: rUser.delta })
  }

  // 4. BattleScript_AromaticMistPartner (:1155-1171):
  // jumpifabsent BS_ATTACKER_PARTNER, BattleScript_MoveEnd
  // copybyte gBattlerTarget, sBATTLER
  // statbuffchange STAT_BUFF_ALLOW_PTR, BattleScript_AromaticMistPrintStringParnter
  if (partnerAlive) {
    const rPartner = changeStatBuffsImplicit(
      state,
      battlerId,
      partnerId,
      2,
      STAT_SPDEF,
      STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (rPartner.delta !== 0) {
      statChanges.push({ battlerId: partnerId, stat: STAT_SPDEF, change: rPartner.delta })
    }
  }

  return outcome(ctx, { statChanges, missed: false })
}

/**
 * Abilities with .ripen = TRUE in src/abilities.cc:8163, 8879, 12280
 * (HasRipenEffect, src/battle_util.c:5162-5165).
 */
const RIPEN_ABILITIES = ['ABILITY_RIPEN', 'ABILITY_SUGAR_RUSH', 'ABILITY_APPLE_PIE'] as const

function hasRipenEffect(
  state: BattleState,
  battlerId: number,
  deps: { dataContext: SimDataContext },
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  for (const ab of RIPEN_ABILITIES) {
    if (battlerHasSimAbility(state, battler, ab, false, battlerId, false, deps.dataContext)) {
      return true
    }
  }
  return false
}

/**
 * VARIOUS_JUMP_IF_NOT_BERRY (src/battle_script_commands.c:6869-6875) and
 * IsItemNegated (src/battle_util.c:6520-6524).
 * Checks that the battler's item is not negated by STATUS3_EMBARGO or ABILITY_KLUTZ
 * and belongs to POCKET_BERRIES.
 */
export function hasNonNegatedBerry(
  state: BattleState,
  battlerId: number,
  deps: TurnLoopDeps,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  const itemId = battler.mon.itemId
  if (!itemId) return false
  if (
    hasFlag(battler.statuses3, STATUS3_EMBARGO) ||
    battlerHasSimAbility(state, battler, 'ABILITY_KLUTZ', false, battlerId, false, deps.dataContext)
  ) {
    return false
  }
  return deps.dataContext.item(itemId)?.grouping === 'POCKET_BERRIES'
}

/**
 * SetCudChew (src/battle_script_commands.c:6028-6038), called from ItemBattleEffects at
 * src/battle_util.c:6300-6301 right after `ateBerry[side] |= bit(partyIndex)`.
 * Requires a berry-pocket item, ABILITY_CUD_CHEW, and the ateBerry bit; then:
 *   activating -> clear the whole state; else if !itemId -> {itemId, setThisTurn}.
 * (Else nothing: an already-armed state survives until its own end-turn pass.) */
export function setCudChew(state: BattleState, battlerId: number, itemId: string, attackerId: number, deps: TurnLoopDeps): void {
  const battler = state.battlers[battlerId]
  if (!battler) return
  if (deps.dataContext.item(itemId)?.grouping !== 'POCKET_BERRIES') return
  if (!battler.ateBerry) return
  const attacker = state.battlers[attackerId]
  const attackerHasMB = attacker ? attackerHasMoldBreakerActive(attacker, deps) : false
  if (!battlerHasSimAbility(state, battler, 'ABILITY_CUD_CHEW', true, attackerId, attackerHasMB, deps.dataContext)) return
  if (getAbilityStateOf(battler, 'ABILITY_CUD_CHEW') & CUD_CHEW_ACTIVATING) {
    // SetAbilityStateAs({.cudChewState = {0}}): this is why a temporary berry consumed BY
    // Cud Chew never arms another one -- SetCudChew runs again inside that consume.
    battler.cudChewItem = null
    setAbilityStateOf(battler, 'ABILITY_CUD_CHEW', 0)
  } else if (!battler.cudChewItem) {
    battler.cudChewItem = itemId
    setAbilityStateOf(battler, 'ABILITY_CUD_CHEW', CUD_CHEW_SET_THIS_TURN)
  }
}

/**
 * Cmd_removeitem (src/battle_script_commands.c:6040-6053), SetCudChew (:6028-6038,
 * called at src/battle_util.c:6301), and TryCheekPouch (:6015-6026).
 * Returns true when the berry effect consumed the item (the "effect fired" answer
 * VARIOUS_CONSUME_BERRY needs at :8035). */
function finishBerryRemoval(
  state: BattleState,
  attackerId: number,
  battlerId: number,
  deps: TurnLoopDeps,
  unmodelled: string[],
): boolean {
  const battler = state.battlers[battlerId]!

  // battle_util.c:6299-6301: only a berry in the berry item-id range sets ateBerry (bit for
  // this battler's party index) and then reaches SetCudChew. `grouping` is the sim's
  // equivalent of ItemId_GetPocket(item) == POCKET_BERRIES, as hasNonNegatedBerry uses.
  const eatenItem = battler.mon.itemId
  if (eatenItem && deps.dataContext.item(eatenItem)?.grouping === 'POCKET_BERRIES') {
    battler.ateBerry = true
    // SetCudChew is called with gLastUsedItem, i.e. the berry still held at this point.
    setCudChew(state, battlerId, eatenItem, attackerId, deps)
  }

  // Cmd_removeitem (:6040-6051): records usedHeldItem and clears itemId via UpdateBattlerItem
  consumeHeldItem(state, battler, unmodelled)

  // TryCheekPouch (:6015-6026): in ER, Cheek Pouch is merged into ABILITY_GLUTTONY.
  // The C also requires the ateBerry bit (:6018), which is now set above.
  if (
    battlerHasSimAbility(state, battler, 'ABILITY_GLUTTONY', false, battlerId, false, deps.dataContext) &&
    canBattlerHeal(state, battlerId, battler, unmodelled) &&
    battler.ateBerry === true &&
    battler.mon.hp < battler.mon.maxHp
  ) {
    let heal = Math.trunc(battler.mon.maxHp / 3)
    if (heal === 0) heal = 1
    healBattler(state, battlerId, battler, heal)
  }
  return true
}

/**
 * VARIOUS_CONSUME_BERRY (src/battle_script_commands.c:8024-8041) with
 * sBERRY_OVERRIDE = TRUE (gBattleScripting.overrideBerryRequirements = TRUE),
 * dispatching ItemBattleEffects(ITEMEFFECT_BATTLER_MOVE_END, battlerId, FALSE)
 * (src/battle_util.c:5872-6033). `restoreItem` is the command's own operand: when FALSE
 * (every move-effect caller) nothing is restored; when TRUE (BattleScript_CudChew, :1016-1021)
 * the item parked in `changedItems` is handed back only if the berry effect did not fire
 * (:8035-8040). The early returns below mirror the C's own `return` before the restore block
 * (`HOLD_EFFECT_NONE` check at :8026-8028, and the fired-effect return at :8035).
 */
export function consumeBerryWithOverride(
  state: BattleState,
  attackerId: number,
  battlerId: number,
  moveId: string,
  deps: TurnLoopDeps,
  unmodelled: string[],
  statChanges: StatChangeOutcome[],
  restoreItem = false,
): void {
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) return
  const itemId = battler.mon.itemId
  if (!itemId) return

  if (itemId === 'ITEM_ENIGMA_BERRY') {
    unmodelled.push('Enigma Berry holdEffect (battle_util.c:6533-6534) is not modelled')
    return
  }

  const itemData = deps.dataContext.item(itemId)
  const holdEffect = itemData?.resolvedHoldEffect ?? null
  if (!holdEffect || holdEffect === 'HOLD_EFFECT_NONE') return
  const param = itemData?.holdEffectStrength ?? 0

  // Whether ItemBattleEffects returned nonzero: only finishBerryRemoval (Cmd_removeitem) paths
  // consume the item, and those are exactly the "effect fired" cases.
  let fired = false

  switch (holdEffect) {
    case 'HOLD_EFFECT_MICLE_BERRY': {
      // TrySetMicleBerry (battle_util.c:5257-5269), BattleScript_MicleBerryActivateRet (data/battle_scripts_1.s:11255-11265)
      battler.round.usedMicleBerry = true
      fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      break
    }
    case 'HOLD_EFFECT_RESTORE_HP':
    case 'HOLD_EFFECT_RESTORE_PCT_HP': {
      // ItemHealHp (battle_util.c:5311-5333), BattleScript_ItemHealHP_RemoveItemRet (data/battle_scripts_1.s:10859-10873)
      if (!canBattlerHeal(state, battlerId, battler, unmodelled)) break
      // :5315 -- !(gBattleScripting.overrideBerryRequirements && gBattleMons[battlerId].hp == gBattleMons[battlerId].maxHP)
      if (battler.mon.hp === battler.mon.maxHp) break
      // :10860 -- jumpifconsumableblocked BS_SCRIPTING, BattleScript_Return (VARIOUS_JUMP_IF_CONSUMABLE_BLOCKED, :9024-9032)
      if (isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) break

      let heal =
        holdEffect === 'HOLD_EFFECT_RESTORE_PCT_HP'
          ? Math.trunc((battler.mon.maxHp * param) / 100)
          : param
      if (hasRipenEffect(state, battlerId, deps)) heal *= 2
      healBattler(state, battlerId, battler, heal)
      fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      break
    }
    case 'HOLD_EFFECT_CONFUSE_SPICY':
    case 'HOLD_EFFECT_CONFUSE_DRY':
    case 'HOLD_EFFECT_CONFUSE_SWEET':
    case 'HOLD_EFFECT_CONFUSE_BITTER':
    case 'HOLD_EFFECT_CONFUSE_SOUR': {
      // HealConfuseBerry (battle_util.c:5167-5193): HasEnoughHpToEatBerry returns TRUE under sBERRY_OVERRIDE even at full HP
      unmodelled.push(
        'HealConfuseBerry nature-flavor confusion check (battle_util.c:5181-5188) is not modelled (gPokeblockFlavorCompatibilityTable not in SimDataContext); treated as neutral flavor',
      )
      if (isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) break
      let heal = param > 0 ? Math.trunc(battler.mon.maxHp / param) : 1
      if (heal === 0) heal = 1
      if (hasRipenEffect(state, battlerId, deps)) heal *= 2
      healBattler(state, battlerId, battler, heal)
      fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      break
    }
    case 'HOLD_EFFECT_ATTACK_UP':
    case 'HOLD_EFFECT_DEFENSE_UP':
    case 'HOLD_EFFECT_SPEED_UP':
    case 'HOLD_EFFECT_SP_ATTACK_UP':
    case 'HOLD_EFFECT_SP_DEFENSE_UP': {
      // StatRaiseBerry (battle_util.c:5195-5215), BattleScript_BerryStatRaiseRet (data/battle_scripts_1.s:11009-11029)
      const statId =
        holdEffect === 'HOLD_EFFECT_ATTACK_UP'
          ? STAT_ATK
          : holdEffect === 'HOLD_EFFECT_DEFENSE_UP'
            ? STAT_DEF
            : holdEffect === 'HOLD_EFFECT_SPEED_UP'
              ? STAT_SPEED
              : holdEffect === 'HOLD_EFFECT_SP_ATTACK_UP'
                ? STAT_SPATK
                : STAT_SPDEF
      if (!canRaiseStat(state, battlerId, statId, deps.dataContext)) break
      const amount = hasRipenEffect(state, battlerId, deps) ? 2 : 1
      const res = changeStatBuffsImplicit(
        state,
        attackerId,
        battlerId,
        amount,
        statId,
        STAT_BUFF_ALLOW_PTR,
        true,
        deps,
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        statChanges.push({ battlerId, stat: statId, change: res.delta })
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
    case 'HOLD_EFFECT_RANDOM_STAT_UP': {
      // RandomStatRaiseBerry (battle_util.c:5217-5255)
      let anyCanRaise = false
      for (let i = 0; i < 5; i++) {
        if (canRaiseStat(state, battlerId, STAT_ATK + i, deps.dataContext)) {
          anyCanRaise = true
          break
        }
      }
      if (!anyCanRaise) break
      let i = 0
      do {
        i = state.rng.random16() % 5
      } while (!canRaiseStat(state, battlerId, STAT_ATK + i, deps.dataContext))
      const statId = STAT_ATK + i
      const amount = hasRipenEffect(state, battlerId, deps) ? 4 : 2
      const res = changeStatBuffsImplicit(
        state,
        attackerId,
        battlerId,
        amount,
        statId,
        STAT_BUFF_ALLOW_PTR,
        true,
        deps,
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        statChanges.push({ battlerId, stat: statId, change: res.delta })
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
    case 'HOLD_EFFECT_CURE_PAR': {
      // battle_util.c:5925-5931
      if (hasFlag(battler.mon.status1, STATUS1_PARALYSIS) && !isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) {
        battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_PARALYSIS)
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
    case 'HOLD_EFFECT_CURE_PSN': {
      // battle_util.c:5932-5938
      if (hasFlag(battler.mon.status1, STATUS1_POISON_ANY) && !isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) {
        battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_POISON_ANY | STATUS1_TOXIC_COUNTER)
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
    case 'HOLD_EFFECT_CURE_BRN': {
      // battle_util.c:5939-5945
      if (hasFlag(battler.mon.status1, STATUS1_BURN) && !isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) {
        battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_BURN)
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
    case 'HOLD_EFFECT_CURE_FRZ': {
      // battle_util.c:5946-5952 (C checks STATUS1_FROSTBITE, not STATUS1_FREEZE)
      if (hasFlag(battler.mon.status1, STATUS1_FROSTBITE) && !isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) {
        battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_FROSTBITE)
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
    case 'HOLD_EFFECT_CURE_SLP': {
      // battle_util.c:5953-5960
      if (hasFlag(battler.mon.status1, STATUS1_SLEEP) && !isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) {
        battler.mon.status1 = clearFlag(battler.mon.status1, STATUS1_SLEEP)
        battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_NIGHTMARE)
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
    case 'HOLD_EFFECT_CURE_CONFUSION': {
      // battle_util.c:5961-5967
      if (hasFlag(battler.mon.status2, STATUS2_CONFUSION) && !isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) {
        battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_CONFUSION)
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
    case 'HOLD_EFFECT_CURE_STATUS': {
      // battle_util.c:5975-6006 (overrideBerryRequirements bypasses IsUnnerveAbilityOnOpposingSide at :5977)
      if (hasFlag(battler.mon.status1, STATUS1_ANY) || hasFlag(battler.mon.status2, STATUS2_CONFUSION)) {
        if (hasFlag(battler.mon.status1, STATUS1_SLEEP)) {
          battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_NIGHTMARE)
        }
        battler.mon.status1 = 0
        battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_CONFUSION)
        fired = finishBerryRemoval(state, attackerId, battlerId, deps, unmodelled) || fired
      }
      break
    }
  }

  // VARIOUS_CONSUME_BERRY (:8037-8040): restoreItem && !ItemBattleEffects(...) ->
  // UpdateBattlerItem(battler, changedItems[battler]); changedItems[battler] = ITEM_NONE.
  // On a fired effect the C returns at :8035 and leaves changedItems for MOVEEND_CHANGED_ITEMS.
  if (restoreItem && !fired) {
    battler.mon.itemId = battler.changedItem ?? null
    battler.changedItem = null
  }
}

/**
 * EFFECT_TEATIME (Teatime).
 * BattleScript_EffectTeatime (data/battle_scripts_1.s:12622-12650),
 * VARIOUS_JUMP_IF_ABSENT (src/battle_script_commands.c:6769-6772),
 * VARIOUS_JUMP_IF_NOT_BERRY (src/battle_script_commands.c:6869-6875),
 * VARIOUS_CONSUME_BERRY (src/battle_script_commands.c:8024-8041),
 * ItemBattleEffects(ITEMEFFECT_BATTLER_MOVE_END) (src/battle_util.c:5872-6033).
 * Checks all battlers 0..gBattlersCount-1; fails via BattleScript_ButItFailed if no alive
 * battler holds a non-negated berry (neither STATUS3_EMBARGO nor ABILITY_KLUTZ). Otherwise
 * sets sBERRY_OVERRIDE = TRUE and runs consumeberry for each alive battler holding a
 * non-negated berry in 0..gBattlersCount-1 order.
 */
export function handleTeatime(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:12625)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. BattleScript_Teatime_AnyBerriesLoop (:12626-12634)
  let anyBerry = false
  for (let i = 0; i < state.battlersCount; i++) {
    if (!isBattlerAlive(state, i)) continue
    if (!hasNonNegatedBerry(state, i, deps)) continue
    anyBerry = true
    break
  }

  if (!anyBerry) {
    return outcome(ctx, { missed: true })
  }

  // 3. BattleScript_Teatime_EatBerriesLoop (:12635-12650) with sBERRY_OVERRIDE = TRUE
  const statChanges: StatChangeOutcome[] = []
  for (let i = 0; i < state.battlersCount; i++) {
    if (!isBattlerAlive(state, i)) continue
    if (!hasNonNegatedBerry(state, i, deps)) continue
    consumeBerryWithOverride(state, battlerId, i, moveId, deps, unmodelled, statChanges)
  }

  return outcome(ctx, { statChanges, missed: false })
}

/**
 * EFFECT_STUFF_CHEEKS (Stuff Cheeks).
 * BattleScript_EffectStuffCheeks (data/battle_scripts_1.s:559-580),
 * VARIOUS_JUMP_IF_NOT_BERRY (src/battle_script_commands.c:6869-6875),
 * VARIOUS_CONSUME_BERRY (src/battle_script_commands.c:8024-8041).
 * Fails via BattleScript_ButItFailed if user does not hold a non-negated berry.
 * Otherwise sets sBERRY_OVERRIDE = TRUE, runs consumeberry BS_ATTACKER, then raises
 * user's Defense by 2 stages (MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR).
 */
export function handleStuffCheeks(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:562)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifnotberry BS_ATTACKER, BattleScript_ButItFailed (:563)
  if (!hasNonNegatedBerry(state, battlerId, deps)) {
    return outcome(ctx, { missed: true })
  }

  // 3. consumeberry BS_ATTACKER with sBERRY_OVERRIDE = TRUE (:566-570)
  const statChanges: StatChangeOutcome[] = []
  consumeBerryWithOverride(state, battlerId, battlerId, moveId, deps, unmodelled, statChanges)

  // 4. setstatchanger STAT_DEF, 2, FALSE; statbuffchange MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR (:573-574)
  // Note: VARIOUS_CONSUME_BERRY (:8032) sets gBattlerTarget = gActiveBattler (battlerId).
  const res = changeStatBuffsImplicit(
    state,
    battlerId,
    battlerId,
    2,
    STAT_DEF,
    MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (res.delta !== 0) {
    statChanges.push({ battlerId, stat: STAT_DEF, change: res.delta })
  }

  return outcome(ctx, { statChanges, missed: res.missed ?? false })
}

/**
 * CanBattlerGetOrLoseItem (src/battle_util.c:8250-8273).
 * Returns true when itemId is null (ITEM_NONE in C has HOLD_EFFECT_NONE and is not ITEM_ENIGMA_BERRY).
 */
export function canBattlerGetOrLoseItem(battler: BattlerState, itemId: string | null, deps: TurnLoopDeps): boolean {
  if (!itemId) return true
  if (itemId === 'ITEM_ENIGMA_BERRY') return false
  const holdEffect = deps.dataContext.item(itemId)?.resolvedHoldEffect ?? null
  if (holdEffect === 'HOLD_EFFECT_PRIMAL_ORB' || holdEffect === 'HOLD_EFFECT_MEGA_STONE') return false
  const species = battler.mon.speciesId
  if (species.startsWith('SPECIES_GENESECT') && holdEffect === 'HOLD_EFFECT_DRIVE') return false
  if (species.startsWith('SPECIES_SILVALLY') && holdEffect === 'HOLD_EFFECT_MEMORY') return false
  if (species.startsWith('SPECIES_ARCEUS') && holdEffect === 'HOLD_EFFECT_PLATE') return false
  return true
}

/**
 * UpdateBattlerItem(battler, ITEM_NONE) / RemoveItem(battler) (src/battle_script_commands.c:2194-2221, 2231).
 */
export function clearBattlerItem(state: BattleState, battler: BattlerState, unmodelled: string[]): void {
  const itemId = battler.mon.itemId
  if (!itemId) return
  // UpdateBattlerItem's `if (newItem == ITEM_NONE) gBattleStruct->choicedMove[battler] = 0;` (:2214). The
  // early return above mirrors UpdateBattlerItem's own `oldItem == newItem` return (NONE -> NONE).
  battler.choicedMove = null
  const slotU = findAbilitySlot(battler.mon.abilities, 'ABILITY_UNBURDEN')
  if (slotU !== -1) battler.volatiles.abilityState[slotU] = 1
  const slotS = findAbilitySlot(battler.mon.abilities, 'ABILITY_SUGAR_RUSH')
  if (slotS !== -1) battler.volatiles.abilityState[slotS] = 1

  const hasAbility = (b: BattlerState, id: string) => findAbilitySlot(b.mon.abilities, id) !== -1
  if (hasAbility(battler, 'ABILITY_GREEDY')) {
    unmodelled.push("UpdateBattlerItem's Greedy ability state (battle_script_commands.c:2209-2212) is not modelled")
  }
  if (itemId !== 'ITEM_BIG_NUGGET' && state.battlers.some((b) => b && hasAbility(b, 'ABILITY_POWER_OF_ALCHEMY'))) {
    unmodelled.push("UpdateBattlerItem's Power of Alchemy item memory (battle_script_commands.c:2206-2207) is not modelled")
  }
  battler.mon.itemId = null
}

/**
 * EFFECT_BESTOW (Bestow).
 * BattleScript_EffectBestow (data/battle_scripts_1.s:1381-1416),
 * trybestow (.omc/team-pilot/battle_script.inc:1552-1555, VARIOUS_BESTOW, src/battle_script_commands.c:7703-7712),
 * trypsychoshift (.omc/team-pilot/battle_script.inc:1678-1681, VARIOUS_PSYCHO_SHIFT, src/battle_script_commands.c:7641-7684).
 *
 * C quirks preserved:
 * 1. VARIOUS_BESTOW (:7705-7706) does not check `gBattleMons[gBattlerTarget].item != ITEM_NONE` (so Bestow can
 *    overwrite an existing item on the target) and passes `gBattleMons[gBattlerTarget].item` (not the attacker's
 *    item) to `CanBattlerGetOrLoseItem(gBattlerTarget, ...)`.
 * 2. BattleScript_EffectBestow (:1392, :1404) checks `jumpifstatus BS_TARGET, STATUS1_ANY` instead of `BS_ATTACKER`,
 *    so the status-transfer branch only runs when the target already has a status1, never runs `curestatus BS_ATTACKER`,
 *    and in VARIOUS_PSYCHO_SHIFT (:7641-7684) sets `target.status1 = attacker.status1 & STATUS1_ANY` whenever `i`
 *    remains TRUE (including when the attacker has no status, Sleep, Frostbite, or Bleed).
 */
export function handleBestow(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, NO_ACC_CALC_CHECK_LOCK_ON (:1383), then ppreduce (:1385).
  // BattleScript_PrintMoveMissed also runs ppreduce, so PP is deducted on both paths.
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  const acc = checkNoAccCalcLockOn(ctx, targetId)
  if (acc.failed) {
    return outcome(ctx, { targetId, missed: acc.missed })
  }

  // 2. jumpifsubstituteblocks BattleScript_ButItFailed (:1386)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. trybestow BattleScript_EffectBestow_NoGiveItem (VARIOUS_BESTOW, :7703-7712)
  const attackerItem = battler.mon.itemId
  const targetItem = target.mon.itemId
  const gaveItem =
    attackerItem !== null &&
    canBattlerGetOrLoseItem(battler, attackerItem, deps) &&
    canBattlerGetOrLoseItem(target, targetItem, deps)

  if (gaveItem) {
    // UpdateBattlerItem(gBattlerAttacker, ITEM_NONE), then UpdateBattlerItem(gBattlerTarget, gLastUsedItem) (:7709-7710)
    clearBattlerItem(state, battler, unmodelled)
    if (targetItem !== attackerItem) {
      if (targetItem === null) {
        const slotU = findAbilitySlot(target.mon.abilities, 'ABILITY_UNBURDEN')
        if (slotU !== -1) target.volatiles.abilityState[slotU] = 0
        const slotS = findAbilitySlot(target.mon.abilities, 'ABILITY_SUGAR_RUSH')
        if (slotS !== -1) target.volatiles.abilityState[slotS] = 0
      }
      target.mon.itemId = attackerItem
    }
  }

  // Helper for VARIOUS_PSYCHO_SHIFT (:7641-7684)
  const runTryPsychoShift = (): boolean => {
    const userStatus = battler.mon.status1
    const curTargetStatus = target.mon.status1
    let i = true
    if (hasFlag(userStatus, STATUS1_PARALYSIS) && !hasFlag(curTargetStatus, STATUS1_PARALYSIS)) {
      if (!canBeParalyzed(state, battlerId, targetId, deps)) i = false
    } else if (hasFlag(userStatus, STATUS1_POISON_ANY) && !hasFlag(curTargetStatus, STATUS1_POISON_ANY)) {
      // C quirk (:7653): calls CanBeParalyzed instead of CanBePoisoned
      if (!canBeParalyzed(state, battlerId, targetId, deps)) i = false
    } else if (hasFlag(userStatus, STATUS1_BURN) && !hasFlag(curTargetStatus, STATUS1_BURN)) {
      if (!canBeBurned(state, targetId, battlerId, deps)) i = false
    }
    if (i) {
      target.mon.status1 = userStatus & STATUS1_ANY
    }
    return i
  }

  if (gaveItem) {
    // 4a. jumpifstatus BS_TARGET, STATUS1_ANY, BattleScript_EffectBestow_HasStatus (:1392)
    // C bug kept: tests BS_TARGET instead of BS_ATTACKER
    if (hasFlag(target.mon.status1, STATUS1_ANY)) {
      // :1395 -- jumpifsafeguard BattleScript_SafeguardProtected
      if (!hasFlag(state.sides[targetId & 1].statuses, SIDE_STATUS_SAFEGUARD)) {
        // :1396 -- trypsychoshift BattleScript_MoveEnd
        runTryPsychoShift()
      }
    }
    return outcome(ctx, { targetId, missed: false })
  }

  // 4b. BattleScript_EffectBestow_NoGiveItem (:1403-1416)
  // C bug kept: tests BS_TARGET instead of BS_ATTACKER (:1404)
  if (!hasFlag(target.mon.status1, STATUS1_ANY)) {
    return outcome(ctx, { targetId, missed: true })
  }
  // :1407 -- jumpifsafeguard BattleScript_SafeguardProtected
  if (hasFlag(state.sides[targetId & 1].statuses, SIDE_STATUS_SAFEGUARD)) {
    return outcome(ctx, { targetId, missed: true })
  }
  // :1408 -- trypsychoshift BattleScript_ButItFailed
  if (!runTryPsychoShift()) {
    return outcome(ctx, { targetId, missed: true })
  }
  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_CALTROPS (Caltrops).
 * BattleScript_EffectCaltrops (data/battle_scripts_1.s:5047-5056),
 * trysetcaltrops (.omc/team-pilot/battle_script.inc:2355-2358),
 * VARIOUS_SET_CALTROPS (src/battle_script_commands.c:8848-8854).
 * Sets `gSideTimers[GetBattlerSide(gActiveBattler)].caltrops = TRUE` on the target side
 * (note: unlike Spikes/Stealth Rock/Toxic Spikes, VARIOUS_SET_CALTROPS does not set any
 * bit in `gSideStatuses`). Fails via BattleScript_ButItFailedAtkStringPpReduce if
 * `caltrops` is already set on that side. Switch-in consumption is handled in hazards.ts:220-224.
 */
export function handleCaltrops(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // Both success (:5051) and BattleScript_ButItFailedAtkStringPpReduce (:5939) run ppreduce.
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const targetSide = (battlerId & 1) ^ 1
  const sideState = state.sides[targetSide]!

  // trysetcaltrops BS_TARGET, BattleScript_ButItFailedAtkStringPpReduce (:5049, :8848-8854)
  if (sideState.timers.caltrops) {
    return outcome(ctx, { missed: true })
  }

  sideState.timers.caltrops = true
  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_GEOMANCY (Geomancy).
 * BattleScript_EffectGeomancy (data/battle_scripts_1.s:4455-4494),
 * BattleScriptFirstChargingTurn (:4079-4093),
 * twoturnmoveacceleratecheck (.omc/team-pilot/battle_script.inc:2468-2475),
 * BattleScript_PowerHerbActivation (:4391-4397),
 * SetMoveEffect(MOVE_EFFECT_CHARGING) (src/battle_script_commands.c:2714-2720),
 * Cmd_clearstatusfromeffect (:3140-3157).
 *
 * Turn 1 (when STATUS2_MULTIPLETURNS is not set): deducts PP, sets STATUS2_MULTIPLETURNS and
 * round.chargingTurn = true. Unless the user has ABILITY_ACCELERATE or an unblocked
 * HOLD_EFFECT_POWER_HERB (which is consumed via removeitem), the script ends after turn 1.
 * Turn 2 (or accelerated turn 1): clears STATUS2_MULTIPLETURNS (and clears round.chargingTurn if
 * ABILITY_ACCELERATE), does not deduct PP (HITMARKER_NO_PPDEDUCT), fails via
 * BattleScript_CantRaiseMultipleStats if SpAtk, SpDef, and Speed are all already at max stage,
 * and otherwise raises SpAtk, SpDef, and Speed by +2 stages each.
 */
export function handleGeomancy(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. jumpifstatus2 BS_ATTACKER, STATUS2_MULTIPLETURNS, BattleScript_GeomancySecondTurn (:4456)
  if (!hasFlag(battler.mon.status2, STATUS2_MULTIPLETURNS)) {
    // BattleScriptFirstChargingTurn (:4079-4093)
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    battler.mon.status2 = setFlag(battler.mon.status2, STATUS2_MULTIPLETURNS)
    battler.round.chargingTurn = true

    // twoturnmoveacceleratecheck (:4460, .omc/team-pilot/battle_script.inc:2468-2475)
    const hasAccelerate = battlerHasSimAbility(
      state,
      battler,
      'ABILITY_ACCELERATE',
      false,
      battlerId,
      false,
      deps.dataContext,
    )
    if (!hasAccelerate) {
      const itemId = battler.mon.itemId
      const itemNegated =
        hasFlag(battler.statuses3, STATUS3_EMBARGO) ||
        battlerHasSimAbility(state, battler, 'ABILITY_KLUTZ', false, battlerId, false, deps.dataContext)
      if (!itemNegated && itemId === 'ITEM_ENIGMA_BERRY') {
        unmodelled.push('Enigma Berry holdEffect (battle_util.c:6533-6534) is not modelled')
      }
      const holdEffect = !itemNegated && itemId ? (deps.dataContext.item(itemId)?.resolvedHoldEffect ?? null) : null
      if (holdEffect !== 'HOLD_EFFECT_POWER_HERB') {
        return outcome(ctx, { missed: false })
      }
      // jumpifconsumableblocked BS_ATTACKER, BattleScript_MoveEnd (:2471, VARIOUS_JUMP_IF_CONSUMABLE_BLOCKED :9024-9032)
      if (isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) {
        return outcome(ctx, { missed: false })
      }
      // BattleScript_PowerHerbActivation (:4391-4397): removeitem BS_ATTACKER
      consumeHeldItem(state, battler, unmodelled)
    }
  }

  // 2. BattleScript_GeomancySecondTurn (:4461-4494)
  // clearstatusfromeffect BS_ATTACKER (:4465, Cmd_clearstatusfromeffect :3140-3157)
  battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_MULTIPLETURNS)
  if (battlerHasSimAbility(state, battler, 'ABILITY_ACCELERATE', false, battlerId, false, deps.dataContext)) {
    battler.round.chargingTurn = false
  }

  // Pre-check (:4468-4470):
  // jumpifstat BS_ATTACKER, CMP_LESS_THAN, STAT_SPATK, MAX_STAT_STAGE, BattleScript_GeomancyDoMoveAnim
  // jumpifstat BS_ATTACKER, CMP_LESS_THAN, STAT_SPDEF, MAX_STAT_STAGE, BattleScript_GeomancyDoMoveAnim
  // jumpifstat BS_ATTACKER, CMP_EQUAL, STAT_SPEED, MAX_STAT_STAGE, BattleScript_CantRaiseMultipleStats
  if (
    !compareStatToMax(state, battler, STAT_SPATK, 'LESS_THAN', battlerId, deps) &&
    !compareStatToMax(state, battler, STAT_SPDEF, 'LESS_THAN', battlerId, deps) &&
    compareStatToMax(state, battler, STAT_SPEED, 'EQUAL', battlerId, deps)
  ) {
    return outcome(ctx, { missed: true })
  }

  // BattleScript_GeomancyDoMoveAnim (:4471-4494): SpAtk +2, SpDef +2, Speed +2
  const statChanges: StatChangeOutcome[] = []
  for (const statId of [STAT_SPATK, STAT_SPDEF, STAT_SPEED]) {
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      battlerId,
      2,
      statId,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (res.delta !== 0) {
      statChanges.push({ battlerId, stat: statId, change: res.delta })
    }
  }

  return outcome(ctx, { statChanges, missed: false })
}

/**
 * EFFECT_KINESIS (Kinesis).
 * BattleScript_EffectKinesis (data/battle_scripts_1.s:12525-12536),
 * trydestroyitem (.omc/team-pilot/battle_script.inc:2350-2353),
 * VARIOUS_TRY_DESTROY_ITEM (src/battle_script_commands.c:8839-8847),
 * IsStickyHold (src/battle_util.c:9329-9333),
 * SetMoveEffect(MOVE_EFFECT_FLINCH) (src/battle_script_commands.c:2348-2388, 2665-2669).
 *
 * In Elite Redux, Kinesis has +1 priority, rolls accuracy, deducts PP, destroys the target's
 * held item via RemoveItem (failing via BattleScript_ButItFailed if the target holds no item,
 * holds an unremovable item, has Sticky Hold / Supersweet Syrup, or is behind a Substitute),
 * and then inflicts flinch via seteffectprimary MOVE_EFFECT_FLINCH (blocked by Inner Focus
 * family via IsAbilityStatusProtected(..., CHECK_FLINCH)).
 */
export function handleKinesis(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:12527), then ppreduce (:12529).
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. trydestroyitem BS_TARGET, BattleScript_ButItFailed (VARIOUS_TRY_DESTROY_ITEM, :8839-8847)
  const itemId = target.mon.itemId
  const attackerHasMB = attackerHasMoldBreakerActive(battler, deps)
  const isStickyHold =
    battlerHasSimAbility(state, target, 'ABILITY_STICKY_HOLD', true, battlerId, attackerHasMB, deps.dataContext) ||
    battlerHasSimAbility(state, target, 'ABILITY_SUPERSWEET_SYRUP', true, battlerId, attackerHasMB, deps.dataContext)

  if (
    !itemId ||
    !canBattlerGetOrLoseItem(target, itemId, deps) ||
    isStickyHold ||
    doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  // RemoveItem(gActiveBattler) (:8845, :2231)
  clearBattlerItem(state, target, unmodelled)

  // 3. setmoveeffect MOVE_EFFECT_FLINCH; seteffectprimary (:12534-12535, :2665-2669)
  if (
    target.mon.hp > 0 &&
    !testSheerForceFlag(state, battlerId, moveId, deps) &&
    !isAbilityStatusProtected(state, targetId, CHECK_FLINCH, battlerId, deps)
  ) {
    target.mon.status2 = setFlag(target.mon.status2, STATUS2_FLINCHED)
  }

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_DRAIN_BRAIN (Drain Brain).
 * BattleScript_EffectDrainBrain (data/battle_scripts_1.s:944-990),
 * VARIOUS_GET_STAT_VALUE (src/battle_script_commands.c:6809-6812),
 * CalculateStat (src/battle_util.c:7105-7217),
 * GetDrainedBigRootHp (src/battle_util.c:2369-2376).
 *
 * The Special Attack counterpart to Strength Sap: lowers the target's Sp. Atk by 1 stage
 * and heals the user by the target's effective Sp. Atk stat calculated before the drop.
 * Preserves the C script quirks:
 * - When the user is at full HP (:959), heal-blocked (:960), or bleeding (:961), the script
 *   jumps to BattleScript_DrainBrainMustLower (:985) / BattleScript_StrengthSapMustLower (:937);
 *   if the drop succeeds, it still reaches BattleScript_DrainBrainHp / BattleScript_StrengthSapHp
 *   and heals (datahpupdate, :1908-1911, has no heal-block or bleed check).
 * - On the ordinary path (!mustLower), if the stat drop is blocked (e.g. Clear Body while
 *   Sp. Atk stage > MIN_STAT_STAGE), statbuffchange jumps to BattleScript_DrainBrainHp (:964)
 *   and heals the user anyway.
 */
export function handleDrainBrain(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. jumpifsubstituteblocks BattleScript_ButItFailedAtkStringPpReduce (:947)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:948), then ppreduce (:950)
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  const statChanges: StatChangeOutcome[] = []
  const lowerSpAttack = (): { delta: number; missed: boolean } => {
    const res = changeStatBuffsImplicit(
      state,
      battlerId,
      targetId,
      -1,
      STAT_SPATK,
      STAT_BUFF_ALLOW_PTR,
      true,
      deps,
      unmodelled,
      moveId,
    )
    if (res.delta !== 0) statChanges.push({ battlerId: targetId, stat: STAT_SPATK, change: res.delta })
    if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
      dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
    }
    return { delta: res.delta, missed: res.missed ?? false }
  }

  // 3. jumpifstat BS_TARGET, CMP_NOT_EQUAL, STAT_SPATK, MIN_STAT_STAGE, BattleScript_DrainBrainTryLower (:951-956)
  if ((target.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE) === MIN_STAT_STAGE) {
    const { missed: lowerMissed } = lowerSpAttack()
    return outcome(ctx, { targetId, statChanges, missed: lowerMissed })
  }

  // 4. getstatvalue BS_TARGET, STAT_SPATK (:958, VARIOUS_GET_STAT_VALUE, battle_script_commands.c:6809-6812)
  unmodelled.push("Drain Brain's CalculateStat (battle_util.c:7171-7178) applies no onStat ability hooks")
  const userIsUnaware = UNAWARE_ABILITIES.some((ab) =>
    battlerHasSimAbility(state, battler, ab, false, battlerId, false, deps.dataContext),
  )
  const wonderRoomActive =
    hasFlag(state.field.statuses, STATUS_FIELD_WONDER_ROOM) &&
    !state.battlers.some(
      (b, idx) => !!b && b.mon.hp > 0 && battlerHasSimAbility(state, b, 'ABILITY_CLUELESS', false, idx, false, deps.dataContext),
    )
  const isFrostbitten =
    hasFlag(target.mon.status1, STATUS1_FROSTBITE) &&
    !battlerHasSimAbility(state, target, 'ABILITY_OVERCLOCK', false, targetId, false, deps.dataContext)
  let statValue = calculateBattleStat({
    rawStat: target.mon.rawStats.spatk,
    extraStatLevel: target.volatiles.extraSpAttackLevel ?? 0,
    statStage: target.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE,
    isUnaware: userIsUnaware,
    isWonderRoomActive: wonderRoomActive,
    isOffensiveStatForWonderRoom: true,
    isCrit: false,
    isAttackRole: true,
    benefitsFromStatBuffs: benefitsFromStatBuffs(state, targetId),
    preModify: spAttackPreModify({
      rapidResponse: !!target.volatiles.rapidResponse,
      isFrostbitten,
    }),
    applyOnStatHooks: (s) => s,
    secondaryStatPercent: 0,
    statStageRatios: deps.statStageRatios,
  })

  // 5. jumpiffullhp / jumpifhealingblocked / jumpifstatus STATUS1_BLEED (:959-961)
  const mustLower =
    battler.mon.hp === battler.mon.maxHp ||
    isHealingBlocked(state, battlerId, battler, unmodelled) ||
    hasFlag(battler.mon.status1, STATUS1_BLEED)
  const { delta, missed: lowerMissed } = lowerSpAttack()
  const lowered = delta !== 0
  if (mustLower && !lowered) {
    return outcome(ctx, { targetId, statChanges, missed: lowerMissed })
  }

  // 6. BattleScript_DrainBrainHp (:977-984) -- manipulatedamage DMG_BIG_ROOT (GetDrainedBigRootHp, battle_util.c:2369-2376)
  if (battler.mon.hp === battler.mon.maxHp) {
    return outcome(ctx, { targetId, statChanges, missed: false })
  }
  if (statValue === 0) statValue = 1
  const itemNegated =
    hasFlag(battler.statuses3, STATUS3_EMBARGO) ||
    battlerHasSimAbility(state, battler, 'ABILITY_KLUTZ', false, battlerId, false, deps.dataContext)
  const holdEffect = !itemNegated && battler.mon.itemId ? deps.dataContext.item(battler.mon.itemId)?.resolvedHoldEffect : null
  if (holdEffect === 'HOLD_EFFECT_BIG_ROOT') statValue = Math.trunc((statValue * 3) / 2)
  if (battlerHasSimAbility(state, battler, 'ABILITY_ABSORBANT', false, battlerId, false, deps.dataContext)) {
    statValue = Math.trunc((statValue * 3) / 2)
  }
  healBattler(state, battlerId, battler, statValue)

  return outcome(ctx, { targetId, statChanges, missed: false })
}

/**
 * EFFECT_WATERLOG (Waterlog).
 * BattleScript_EffectWaterlog (data/battle_scripts_1.s:2993-3008),
 * setwaterlogged (.omc/team-pilot/battle_script.inc:2456-2459),
 * VARIOUS_WATERLOG (src/battle_script_commands.c:8916-8918),
 * VARIOUS_JUMP_IF_WEATHER_AFFECTED (src/battle_script_commands.c:8056-8061),
 * Cmd_seteffectwithchance (src/battle_script_commands.c:3092-3125),
 * SetMoveEffect(MOVE_EFFECT_DRENCH) (src/battle_script_commands.c:2348-2388, 3031-3036),
 * CanBeDrenched (src/battle_util.c:5125-5133).
 *
 * Sets gRoundStructs[target].waterlog = TRUE (halving the target's speed twice -> floor(speed / 4)
 * for the rest of the round via GetBattlerTotalSpeedStat, battle_main.c:4465), then attempts to
 * inflict Drench (MOVE_EFFECT_DRENCH) via seteffectwithchance with a 20% base chance, boosted to
 * 50% when the target is affected by rain (WEATHER_RAIN_ANY). Because Waterlog is a STATUS move,
 * Cmd_seteffectwithchance passes isStatus = TRUE (primary = TRUE) to SetMoveEffect, so Shield Dust
 * and Covert Cloak do not block the Drench effect.
 */
export function handleWaterlog(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2995), then ppreduce (:2997)
  const missed = checkAccuracy(ctx, targetId, moveId)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 2. setwaterlogged BS_TARGET (:2998, VARIOUS_WATERLOG, battle_script_commands.c:8916-8918)
  target.round.waterlog = true

  // 3. setmoveeffect MOVE_EFFECT_DRENCH; jumpifweatheraffected BS_TARGET, WEATHER_RAIN_ANY -> setmoveeffectchance 50 (:3001-3005)
  const baseChance = isBattlerWeatherAffected(state, targetId, WEATHER_RAIN_ANY, deps)
    ? 50
    : (deps.dataContext.move(moveId)?.effectChance ?? 20)

  // 4. seteffectwithchance (:3007, Cmd_seteffectwithchance, battle_script_commands.c:3092-3125)
  const percentChance = getMoveEffectChance(
    state,
    battlerId,
    moveId,
    MOVE_EFFECT_DRENCH,
    baseChance,
    deps,
    unmodelled,
  )
  // Cmd_seteffectwithchance's Minion Control no-op, battle_script_commands.c:3110-3112:
  //   } else if (gTurnStructs[attacker].parentalBondTrigger == ABILITY_MINION_CONTROL &&
  //              gTurnStructs[attacker].parentalBondOn < gTurnStructs[attacker].parentalBondInitialCount) {
  //       // No-op
  // i.e. on a BONUS hit of a Minion Control sequence neither the `Random() % 100`
  // draw (:3113) nor the effect happens. The sim stores the trigger as
  // 'ABILITY_' + the ability id, which is why the comparison adds the prefix.
  const minionControlBonusHit =
    battler.turn.parentalBondTrigger === 'ABILITY_MINION_CONTROL' &&
    battler.turn.parentalBondOn < battler.turn.parentalBondInitialCount

  if (!minionControlBonusHit && state.rng.random16() % 100 < percentChance) {
    // SetMoveEffect(isStatus = TRUE, 0) (:2361, 2364, 2388, 3031-3036)
    if (
      !testSheerForceFlag(state, battlerId, moveId, deps) &&
      target.mon.hp > 0 &&
      !doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled) &&
      canBeDrenched(state, targetId, battlerId, deps)
    ) {
      target.volatiles.drenched = 2 + (state.rng.random16() % 2)
      target.volatiles.started.drenched = true
    }
  }

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_TRICK (Trick, Switcheroo).
 * BattleScript_EffectTrick (data/battle_scripts_1.s:6279-6292),
 * tryswapitems (.omc/team-pilot/battle_script.inc:1126-1129, Cmd_tryswapitems, src/battle_script_commands.c:11712-11765),
 * IsStickyHold (src/battle_util.c:9329-9333),
 * UpdateBattlerItem (src/battle_script_commands.c:2194-2221).
 *
 * C details and quirks preserved:
 * 1. Script order: attackcanceler -> attackstring -> ppreduce (:6282) -> jumpifsubstituteblocks (:6283) ->
 *    accuracycheck ACC_CURR_MOVE (:6284) -> tryswapitems (:6285).
 * 2. Cmd_tryswapitems (:11729-11734) fails when `attacker.item == target.item` (which rejects both when neither
 *    battler holds an item and when both hold the exact same item ID) or when any of the 4 CanBattlerGetOrLoseItem
 *    checks `(attacker, attacker.item)`, `(attacker, target.item)`, `(target, target.item)`, `(target, attacker.item)`
 *    is false.
 * 3. `IsStickyHold(gBattlerTarget)` (:11737) checks only `gBattlerTarget` (with checkMoldBreaker = TRUE, so an
 *    attacker with Sticky Hold can swap away its own item) and does not check `gBattleMons[gBattlerTarget].item != ITEM_NONE`
 *    (so a target with Sticky Hold / Supersweet Syrup holding no item still blocks Trick/Switcheroo).
 */
export function handleTrick(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. attackstring + ppreduce (:6281-6282)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifsubstituteblocks BattleScript_ButItFailed (:6283)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:6284)
  if (checkAccuracy(ctx, targetId, moveId)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 4. tryswapitems BattleScript_ButItFailed (Cmd_tryswapitems, :11712-11765).
  // All 40 solver fights are trainer battles (BATTLE_TYPE_TRAINER set) and B_TRAINERS_KNOCK_OFF_ITEMS is TRUE
  // (include/constants/battle_config.h:103).
  const attackerItem = battler.mon.itemId
  const targetItem = target.mon.itemId
  if (
    attackerItem === targetItem ||
    !canBattlerGetOrLoseItem(battler, attackerItem, deps) ||
    !canBattlerGetOrLoseItem(battler, targetItem, deps) ||
    !canBattlerGetOrLoseItem(target, targetItem, deps) ||
    !canBattlerGetOrLoseItem(target, attackerItem, deps)
  ) {
    return outcome(ctx, { targetId, missed: true })
  }

  // IsStickyHold(gBattlerTarget) (:11737, src/battle_util.c:9329-9333)
  const attackerHasMB = attackerHasMoldBreakerActive(battler, deps)
  const isStickyHold =
    battlerHasSimAbility(state, target, 'ABILITY_STICKY_HOLD', true, battlerId, attackerHasMB, deps.dataContext) ||
    battlerHasSimAbility(state, target, 'ABILITY_SUPERSWEET_SYRUP', true, battlerId, attackerHasMB, deps.dataContext)
  if (isStickyHold) {
    // :11738-11739 -- jumps to BattleScript_MoveEnd (not ButItFailed), so the move is not marked failed
    return outcome(ctx, { targetId, missed: false })
  }

  // :11743-11744:
  // gLastUsedItem = UpdateBattlerItem(gBattlerAttacker, gBattleMons[gBattlerTarget].item);
  // gBattleStruct->changedItems[gBattlerAttacker] = UpdateBattlerItem(gBattlerTarget, gLastUsedItem);
  const applyUpdateBattlerItem = (holder: BattlerState, oldItem: string | null, newItem: string | null): void => {
    if (oldItem === newItem) return
    if (oldItem === null) {
      const slotU = findAbilitySlot(holder.mon.abilities, 'ABILITY_UNBURDEN')
      if (slotU !== -1) holder.volatiles.abilityState[slotU] = 0
      const slotS = findAbilitySlot(holder.mon.abilities, 'ABILITY_SUGAR_RUSH')
      if (slotS !== -1) holder.volatiles.abilityState[slotS] = 0
      holder.mon.itemId = newItem
    } else if (newItem === null) {
      clearBattlerItem(state, holder, unmodelled)
    } else {
      holder.mon.itemId = newItem
    }
  }

  applyUpdateBattlerItem(battler, attackerItem, targetItem)
  applyUpdateBattlerItem(target, targetItem, attackerItem)
  // MOVEEND_CHANGED_ITEMS (:4658-4661): when changedItems[attacker] != 0 (i.e. targetItem !== null),
  // sets gTurnStructs[attacker].shouldTriggerSwitchItem = FALSE.
  if (targetItem !== null) {
    battler.turn.shouldTriggerSwitchItem = false
  }

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_SNATCH (Snatch).
 * BattleScript_EffectSnatch (data/battle_scripts_1.s:6522-6533),
 * trysetsnatch (.omc/team-pilot/battle_script.inc:1185-1188, Cmd_trysetsnatch, src/battle_script_commands.c:12063-12072).
 *
 * C details:
 * 1. Both success (:6525-6526) and failure (`BattleScript_ButItFailedAtkStringPpReduce`, :6524) run `attackstring` + `ppreduce`.
 * 2. Fails when `gCurrentTurnActionNumber == gBattlersCount - 1` (user acts last in the turn order).
 * 3. Otherwise sets `gRoundStructs[gBattlerAttacker].stealMove = TRUE`.
 * 4. Consumer in Cmd_attackcanceler (src/battle_script_commands.c:1175-1182, BattleScript_SnatchedMove at
 *    data/battle_scripts_1.s:8346-8355) is ported in turn.ts (cycle 65).
 */
export function handleSnatch(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, turnOrderIndex, order } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const battlerCount = order ? order.battlerByTurnOrder.length : state.battlers.length
  if (turnOrderIndex === battlerCount - 1) {
    return outcome(ctx, { missed: true })
  }

  battler.round.stealMove = true

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_MAGIC_COAT (Magic Coat).
 * BattleScript_EffectMagicCoat (data/battle_scripts_1.s:6345-6355),
 * trysetmagiccoat (.omc/team-pilot/battle_script.inc:1180-1183, Cmd_trysetmagiccoat, src/battle_script_commands.c:12052-12061).
 *
 * C details:
 * 1. Cmd_trysetmagiccoat (:12053) sets `gBattlerTarget = gBattlerAttacker`.
 * 2. Both success (:6348-6349) and failure (`BattleScript_ButItFailedAtkStringPpReduce`, :6347) run `attackstring` + `ppreduce`.
 * 3. Fails when `gCurrentTurnActionNumber == gBattlersCount - 1` (user acts last in the turn order).
 * 4. Otherwise sets `gRoundStructs[gBattlerAttacker].bounceMove = TRUE`.
 * 5. Consumer in Cmd_attackcanceler (src/battle_script_commands.c:1153-1166, BattleScript_MagicCoatBounce /
 *    BattleScript_MagicCoatBouncePrankster at data/battle_scripts_1.s:8325-8344) is ported in turn.ts (cycle 65).
 */
export function handleMagicCoat(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, unmodelled, deductPp, turnOrderIndex, order } = ctx
  const battler = state.battlers[battlerId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const battlerCount = order ? order.battlerByTurnOrder.length : state.battlers.length
  if (turnOrderIndex === battlerCount - 1) {
    return outcome(ctx, { missed: true })
  }

  battler.round.bounceMove = true

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_ALLY_SWITCH (Ally Switch).
 * BattleScript_EffectAllySwitch (data/battle_scripts_1.s:12538-12548),
 * swapwith BS_ATTACKER_PARTNER (.omc/team-pilot/battle_script.inc:1794-1797, VARIOUS_SWAP_WITH,
 * src/battle_script_commands.c:6754, 8855-8878),
 * SetAttackingStructValues MOVE_TARGET_ALLY (src/battle_util.c:283-287).
 *
 * C details and quirks preserved:
 * 1. BattleScript_EffectAllySwitch (:12538-12548) has no failure check (no jumpifnotdoublebattle, no jumpifabsent,
 *    no ProtectSucceeds; NoTargetPresent at src/battle_script_commands.c:948-961 has no MOVE_TARGET_ALLY case),
 *    so Ally Switch never fails in C, even in singles or when the partner is absent.
 * 2. VARIOUS_SWAP_WITH (:8855-8878) does not swap the battlers' positions/structs; it only swaps other battlers'
 *    `gBattleStruct->moveTarget[i]` between `gBattlerAttacker` and `BATTLE_PARTNER(gBattlerAttacker)` and swaps
 *    `gWishFutureKnock.futureSightMove/Power/Attacker/Counter` between the two slots. Neither `gBattleStruct->moveTarget`
 *    (other battlers' pending `ChosenAction.target` in turn.ts) nor `gWishFutureKnock.futureSight*` is modelled here.
 */
export function handleAllySwitch(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. attackstring + ppreduce (:12540-12541)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // SetAttackingStructValues (:283-287): MOVE_TARGET_ALLY resolves gBattlerTarget to BATTLE_PARTNER(gBattlerAttacker)
  // if alive and initial gBattlerTarget does not have Commander active, else gBattlerAttacker.
  const partnerId = battlerId ^ 2
  const partnerAlive = isBattlerAlive(state, partnerId)
  const initialTarget = targetId !== null ? state.battlers[targetId] : state.battlers[partnerId]
  const cmdSlot = initialTarget ? findAbilitySlot(initialTarget.mon.abilities, 'ABILITY_COMMANDER') : -1
  const commanderActive = cmdSlot !== -1 && (initialTarget!.volatiles.abilityState[cmdSlot] ?? 0) >= 1
  const resolvedTargetId = partnerAlive && !commanderActive ? partnerId : battlerId

  // 2. swapwith BS_ATTACKER_PARTNER (VARIOUS_SWAP_WITH, :8855-8878)
  unmodelled.push(
    "VARIOUS_SWAP_WITH (battle_script_commands.c:8855-8878): swapping other battlers' gBattleStruct->moveTarget[i] between the user and BATTLE_PARTNER(user) and swapping gWishFutureKnock.futureSight* slots are not modelled",
  )

  return outcome(ctx, { targetId: resolvedTargetId, missed: false })
}

/**
 * EFFECT_FOLLOW_ME (Follow Me, Rage Powder, Spotlight).
 * BattleScript_EffectFollowMe (data/battle_scripts_1.s:6202-6212),
 * setforcedtarget (.omc/team-pilot/battle_script.inc:1110-1112, Cmd_setforcedtarget, src/battle_script_commands.c:11612-11618),
 * IsAffectedByFollowMe (src/battle_util.c:118-126).
 *
 * C details and quirks preserved:
 * 1. BattleScript_EffectFollowMe (:6202-6212) has no singles failure check, no accuracy check, and no substitute check.
 * 2. Cmd_setforcedtarget (:11614-11616) always sets `followmeTimer = 1`, `followmeTarget = gBattlerAttacker`, and
 *    `followmePowder = TestMoveFlags(gCurrentMove, FLAG_POWDER)` on `gSideTimers[GetBattlerSide(gBattlerAttacker)]`,
 *    even for MOVE_SPOTLIGHT (which has target MOVE_TARGET_SELECTED in moves.json but shares EFFECT_FOLLOW_ME).
 * 3. Target-redirection consumer IsAffectedByFollowMe (src/battle_util.c:118-126, 263-265, 6365-6366,
 *    6395-6396) and end-of-turn clear of followmeTimer in TurnValuesCleanUp (src/battle_main.c:4507-4508) are
 *    ported in turn.ts (cycle 65).
 */
export function handleFollowMe(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  const moveData = deps.dataContext.move(moveId)
  const isSelectedTarget = moveData?.target === 'SELECTED'

  if (isSelectedTarget && (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0)) {
    return outcome(ctx, { targetId })
  }

  // 1. attackstring + ppreduce (:6204-6205)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. setforcedtarget (Cmd_setforcedtarget, :11612-11618)
  const sideTimers = state.sides[battlerId & 1].timers
  sideTimers.followmeTimer = 1
  sideTimers.followmeTarget = battlerId
  sideTimers.followmePowder = Boolean(moveData?.flags?.powderAffected)

  return outcome(ctx, { targetId: isSelectedTarget ? targetId : battlerId, missed: false })
}

/**
 * CanBattlerSwitch (src/battle_script_commands.c:5061-5172).
 * Returns true if the battler is not commanded and has at least one alive, non-egg reserve in party.
 */
export function canBattlerSwitch(state: BattleState, battlerId: number): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.statuses4, STATUS4_COMMANDED)) return false
  return hasLiveReserve(state, battlerId)
}

/**
 * EFFECT_SWITCH_ARGUMENT (Teleport, Safe Passage).
 * Mapping: EFFECT_SWITCH_ARGUMENT -> BattleScript_EffectBatonPass (pipeline/.upstream/er-config/MoveBehaviorConfigList.textproto:742-744).
 * BattleScript_EffectBatonPass (data/battle_scripts_1.s:5266-5275):
 *   attackcanceler
 *   attackstring
 *   ppreduce
 *   jumpifbattletype BATTLE_TYPE_ARENA, BattleScript_ButItFailed
 *   jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER, BattleScript_ButItFailed
 *   attackanimation
 *   waitanimation
 *   scheduleswitch BS_ATTACKER, BattleScript_BatonPassSwitch
 *   goto BattleScript_MoveEnd
 *
 * C details and quirks preserved:
 * 1. ppreduce (:5269) runs before jumpifbattletype (:5270) and jumpifcantswitch (:5271),
 *    so PP is consumed even when the move fails due to arena or having no valid reserve.
 * 2. jumpifcantswitch passes SWITCH_IGNORE_ESCAPE_PREVENTION, so CanBattlerEscape is bypassed;
 *    it only checks CanBattlerSwitch(gActiveBattler) (battle_script_commands.c:5177-5184, 5061-5172).
 * 3. On success, scheduleswitch switches out the user (BS_ATTACKER) mid-turn.
 */
export function handleSwitchArgument(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]
  if (!battler) return outcome(ctx)

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:5269) - costs PP on both success and failure paths
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifbattletype BATTLE_TYPE_ARENA, BattleScript_ButItFailed (:5270)
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA)) {
    return outcome(ctx, { missed: true })
  }

  // 3. jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER, BattleScript_ButItFailed (:5271)
  if (!canBattlerSwitch(state, battlerId)) {
    return outcome(ctx, { missed: true })
  }

  // 4. scheduleswitch BS_ATTACKER (:5274) -> mid-turn switch of user
  const switchUnmodelled = performSwitchAction(state, battlerId, deps, { ignoreEscapePrevention: true })
  unmodelled.push(...switchUnmodelled)

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_BATON_PASS (Baton Pass).
 * Mapping: EFFECT_BATON_PASS -> BattleScript_EffectBatonPass (pipeline/.upstream/er-config/MoveBehaviorConfigList.textproto:611-613).
 * BattleScript_EffectBatonPass (data/battle_scripts_1.s:5266-5275):
 *   attackcanceler
 *   attackstring
 *   ppreduce
 *   jumpifbattletype BATTLE_TYPE_ARENA, BattleScript_ButItFailed
 *   jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER, BattleScript_ButItFailed
 *   attackanimation
 *   waitanimation
 *   scheduleswitch BS_ATTACKER, BattleScript_BatonPassSwitch
 *   goto BattleScript_MoveEnd
 *
 * C details and carry-over state preserved:
 * 1. ppreduce (:5269) runs before jumpifbattletype (:5270) and jumpifcantswitch (:5271),
 *    so PP is consumed even when the move fails due to arena or having no valid reserve.
 * 2. jumpifcantswitch passes SWITCH_IGNORE_ESCAPE_PREVENTION, so CanBattlerEscape is bypassed;
 *    it only checks CanBattlerSwitch(gActiveBattler) (battle_script_commands.c:5061-5172).
 * 3. On success, scheduleswitch switches out the user mid-turn.
 * 4. State carry-over (SwitchInClearSetData, battle_main.c:2808-2833; ZERO(gVolatileStructs):2876-2890;
 *    Cmd_switchindataupdate, battle_script_commands.c:5023-5026):
 *    - statStages are NOT reset to neutral (DEFAULT_STAT_STAGE).
 *    - status2 keeps (STATUS2_CONFUSION | STATUS2_SUBSTITUTE | STATUS2_ESCAPE_PREVENTION | STATUS2_CURSED | STATUS2_POWDER | STATUS2_ENRAGED).
 *    - statuses3 keeps (STATUS3_LEECHSEED_BATTLER | STATUS3_LEECHSEED | STATUS3_ALWAYS_HITS | STATUS3_PERISH_SONG | STATUS3_ROOTED |
 *      STATUS3_GASTRO_ACID | STATUS3_EMBARGO | STATUS3_TELEKINESIS | STATUS3_MAGNET_RISE | STATUS3_HEAL_BLOCK | STATUS3_AQUA_RING | STATUS3_POWER_TRICK).
 *    - statuses4 keeps STATUS4_SALT_CURE.
 *    - Opposing battler sure-hit update (battle_main.c:2826-2832): sure-hit on this battler is reset to STATUS3_ALWAYS_HITS_TURN(2).
 *    - Power Trick (battle_main.c:2833): if STATUS3_POWER_TRICK is set, incoming mon's attack and defense are swapped.
 *    - Volatiles kept: started, substituteHp, battlerWithSureHit, perishSongTimer, perishSongTimerStartValue,
 *      battlerPreventingEscape, critBoost, parasiticSpores, dazed, trepidation, drenched.
 */
export function handleBatonPass(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]
  if (!battler) return outcome(ctx)

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:5269)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifbattletype BATTLE_TYPE_ARENA, BattleScript_ButItFailed (:5270)
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA)) {
    return outcome(ctx, { missed: true })
  }

  // 3. jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER, BattleScript_ButItFailed (:5271)
  if (!canBattlerSwitch(state, battlerId)) {
    return outcome(ctx, { missed: true })
  }

  // 4. scheduleswitch BS_ATTACKER, BattleScript_BatonPassSwitch (:5274)
  const switchUnmodelled = performSwitchAction(state, battlerId, deps, {
    ignoreEscapePrevention: true,
    batonPass: true,
  })
  unmodelled.push(...switchUnmodelled)

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_SHED_TAIL handler (MOVE_SHED_TAIL).
 * BattleScript_EffectShedTail, data/battle_scripts_1.s:5351-5370.
 * Cmd_setsubstitute, src/battle_script_commands.c:10535-10555.
 * SwitchInClearSetData, src/battle_main.c:2834-2837, 2890-2892.
 *
 * Flow:
 * 1. ppreduce (:5354)
 * 2. jumpifstatus2 BS_ATTACKER, STATUS2_SUBSTITUTE, BattleScript_AlreadyHasSubstitute (:5356)
 * 3. jumpifbattletype BATTLE_TYPE_ARENA, BattleScript_ButItFailed (:5357)
 * 4. jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER, BattleScript_ButItFailed (:5358)
 * 5. setsubstitute (:5359, Cmd_setsubstitute):
 *    hp = max(1, maxHP / 4)
 *    damage = max(1, maxHP / 2)
 *    if (battler.hp <= damage) fails without damage or substitute
 *    else: takes damage, status2 |= STATUS2_SUBSTITUTE, clears STATUS2_WRAPPED, substituteHp = hp
 * 6. goto BattleScript_MoveSwitchOpenPartyScreen (:5369): switches user out passing ONLY substitute
 */
export function handleShedTail(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp, applyDamage } = ctx
  const battler = state.battlers[battlerId]
  if (!battler) return outcome(ctx)

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:5354)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifstatus2 BS_ATTACKER, STATUS2_SUBSTITUTE, BattleScript_AlreadyHasSubstitute (:5356)
  if (hasFlag(battler.mon.status2, STATUS2_SUBSTITUTE)) {
    return outcome(ctx, { missed: true })
  }

  // 3. jumpifbattletype BATTLE_TYPE_ARENA, BattleScript_ButItFailed (:5357)
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA)) {
    return outcome(ctx, { missed: true })
  }

  // 4. jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER, BattleScript_ButItFailed (:5358)
  if (!canBattlerSwitch(state, battlerId)) {
    return outcome(ctx, { missed: true })
  }

  // 5. setsubstitute (:5359, Cmd_setsubstitute:10535-10555)
  const hp = Math.max(1, Math.floor(battler.mon.maxHp / 4))
  const damage = Math.max(1, Math.floor(battler.mon.maxHp / 2))

  if (battler.mon.hp <= damage) {
    return outcome(ctx, { missed: true })
  }

  battler.mon.status2 = setFlag(battler.mon.status2, STATUS2_SUBSTITUTE)
  battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_WRAPPED)
  battler.volatiles.substituteHp = hp

  const fainted: number[] = []
  applyDamage(state, battlerId, damage, fainted, deps)

  // 6. goto BattleScript_MoveSwitchOpenPartyScreen (:5369)
  const switchUnmodelled = performSwitchAction(state, battlerId, deps, {
    ignoreEscapePrevention: true,
    shedTail: true,
  })
  unmodelled.push(...switchUnmodelled)

  return outcome(ctx, { missed: false, attackerDamage: damage, fainted })
}

/**
 * EFFECT_CHILLY_RECEPTION handler (MOVE_CHILLY_RECEPTION).
 * BattleScript_EffectChillyReception, data/battle_scripts_1.s:5298-5315.
 * checkprimalweather, battle_script.inc:2511-2526.
 * setbattleweather ENUM_WEATHER_HAIL (VARIOUS_SET_WEATHER, src/battle_script_commands.c:8634-8644).
 * TryChangeBattleWeather, src/battle_util.c:3721-3743.
 * BattleScript_MoveSwitch, data/battle_scripts_1.s:5371-5390.
 */
export function handleChillyReception(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]
  if (!battler) return outcome(ctx)

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:5302)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const canSwitch = !hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA) && canBattlerSwitch(state, battlerId)

  if (canSwitch) {
    // BattleScript_EffectChillyReception_NoFail (:5310-5314):
    // If primal weather is active, checkprimalweather skips directly to BattleScript_MoveSwitch (:5312).
    // Otherwise, attempts to set hail; on failure, also branches to BattleScript_MoveSwitch (:5313).
    if (!hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
      const changed = tryChangeBattleWeather(state, battlerId, ENUM_WEATHER_HAIL, false, deps)
      if (changed) {
        dispatchOnWeatherChange(state, deps, unmodelled)
      }
    }

    // Switches user out via BattleScript_MoveSwitch (:5314)
    const switchUnmodelled = performSwitchAction(state, battlerId, deps, {
      ignoreEscapePrevention: true,
    })
    unmodelled.push(...switchUnmodelled)

    return outcome(ctx, { missed: false })
  }

  // BattleScript_EffectChillyReception_FailIfPrimal (:5306-5309):
  // 1. checkprimalweather BattleScript_ButItFailed (:5307)
  if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
    return outcome(ctx, { missed: true })
  }

  // 2. setbattleweather ENUM_WEATHER_HAIL, BattleScript_ButItFailed, TRUE (:5308)
  const changed = tryChangeBattleWeather(state, battlerId, ENUM_WEATHER_HAIL, false, deps)
  if (!changed) {
    return outcome(ctx, { missed: true })
  }
  dispatchOnWeatherChange(state, deps, unmodelled)

  // 3. goto BattleScript_MoveSwitch (:5309) -> jumpifcantswitch / jumpifbattletype ends cleanly (:5378-5379)
  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_SEPTIC_SWITCH handler (MOVE_SEPTIC_SWITCH).
 * BattleScript_SepticSwitch, data/battle_scripts_1.s:12602-12620.
 * Cmd_setgastroacid, src/battle_script_commands.c:11831-11838.
 * BattleScript_MoveSwitch, data/battle_scripts_1.s:5371-5390.
 */
export function handleSepticSwitch(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:12604)
  const missed = checkAccuracy(ctx, targetId, moveId)

  // 2. ppreduce (:12606)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3. setgastroacid BattleScript_SepticSwitch_FailIfNoSwitch (:12607, Cmd_setgastroacid:11831-11838)
  const failsGastroAcid = hasFlag(target.statuses3, STATUS3_GASTRO_ACID) || doesBattlerHaveAbilityShield(target, deps)
  const canSwitch = !hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA) && canBattlerSwitch(state, battlerId)

  if (failsGastroAcid) {
    // BattleScript_SepticSwitch_FailIfNoSwitch (:12616-12620):
    // jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER, BattleScript_ButItFailed (:12617)
    if (!canSwitch) {
      return outcome(ctx, { targetId, missed: true })
    }

    // Switched out via BattleScript_MoveSwitch (:12620)
    const switchUnmodelled = performSwitchAction(state, battlerId, deps, {
      ignoreEscapePrevention: true,
    })
    unmodelled.push(...switchUnmodelled)

    return outcome(ctx, { targetId, missed: false })
  }

  // Success branch of setgastroacid:
  target.statuses3 = setFlag(target.statuses3, STATUS3_GASTRO_ACID)

  // trytoclearprimalweather (:12612)
  if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
    unmodelled.push('trytoclearprimalweather not modelled')
  }

  // goto BattleScript_MoveSwitch (:12615)
  if (canSwitch) {
    const switchUnmodelled = performSwitchAction(state, battlerId, deps, {
      ignoreEscapePrevention: true,
    })
    unmodelled.push(...switchUnmodelled)
  }

  return outcome(ctx, { targetId, missed: false })
}

/**
 * EFFECT_SHOWTIME handler (MOVE_SHOWTIME).
 * BattleScript_EffectShowtime, data/battle_scripts_1.s:12479-12500.
 * VARIOUS_SHOWTIME, src/battle_script_commands.c:8692-8712.
 * BattleScript_MoveSwitch, data/battle_scripts_1.s:5371-5390.
 *
 * Flow:
 * 1. ppreduce (:12481)
 * 2. showtime 0 (:12482): clears Trick Room, Wonder Room, Inverse Room timers and status flags.
 * 3. showtime 1 (:12486 / :12492): sets Magic Room timer to MAGIC_ROOM_DURATION (5) and status flag if not active.
 * 4. BattleScript_MoveSwitch (:12490 / :12486): switches user out if canSwitch (not arena, has live reserve).
 *    Never fails in C (no failure branch exists).
 */
export function handleShowtime(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]
  if (!battler) return outcome(ctx)

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:12481)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. showtime 0 (:12482, VARIOUS_SHOWTIME mode 0)
  // C quirk kept (battle_script_commands.c:8697-8699): only the timers are zeroed, the STATUS_FIELD_*_ROOM
  // flags in gFieldStatuses are left set.
  if (state.field.timers.trickRoomTimer || state.field.timers.wonderRoomTimer || state.field.timers.inverseRoomTimer) {
    state.field.timers.trickRoomTimer = 0
    state.field.timers.wonderRoomTimer = 0
    state.field.timers.inverseRoomTimer = 0
  }

  // 3. showtime 1 (:12486 / :12492, VARIOUS_SHOWTIME mode 1; battle_script_commands.c:8704-8711)
  // C quirk kept: only magicRoomTimer and started.magicRoom are written, STATUS_FIELD_MAGIC_ROOM is never set.
  if (!state.field.timers.magicRoomTimer) {
    state.field.timers.magicRoomTimer = MAGIC_ROOM_DURATION
    state.field.timers.started.magicRoom = true
  }

  // 4. goto BattleScript_MoveSwitch (:12490)
  const canSwitch = !hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA) && canBattlerSwitch(state, battlerId)
  if (canSwitch) {
    const switchUnmodelled = performSwitchAction(state, battlerId, deps, {
      ignoreEscapePrevention: true,
    })
    unmodelled.push(...switchUnmodelled)
  }

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_SPECTRAL_FLAME handler (MOVE_SPECTRAL_FLAME).
 * BattleScript_EffectSpectralFlame, data/battle_scripts_1.s:2933-2956.
 * BattleScript_EffectWillOWisp, data/battle_scripts_1.s:6090-6103.
 * Cmd_setgastroacid, src/battle_script_commands.c:11831-11838.
 *
 * Flow:
 * 1. jumpifweatheraffected BS_ATTACKER, WEATHER_FOG_ANY (:2934):
 *    - If NOT in Fog: jumps to BattleScript_EffectWillOWisp (:2935).
 *      Note C quirk: despite move description, Will-O-Wisp uses standard requirecandoeffect
 *      MOVE_EFFECT_BURN which checks CanBeBurned, blocking Fire types outside Fog.
 *    - If in Fog: continues to BattleScript_EffectSpectralFlame_Continue (:2936).
 * 2. In Fog:
 *    - accuracycheck (:2938)
 *    - ppreduce (:2940)
 *    - jumpifsubstituteblocks (:2941)
 *    - setgastroacid (:2942):
 *      - If successful: suppresses target ability with STATUS3_GASTRO_ACID and applies Burn
 *        via seteffectprimary (:2945).
 *      - If target has STATUS3_GASTRO_ACID or Ability Shield: branches to
 *        BattleScript_EffectSpectralFlame_NoSuppress (:2949), checks canBeBurned and Safeguard,
 *        then applies Burn.
 */
export function handleSpectralFlame(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx

  // 1. jumpifweatheraffected BS_ATTACKER, WEATHER_FOG_ANY (:2934)
  if (!isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps)) {
    return handleWillOWisp(ctx)
  }

  // 2. In Fog: BattleScript_EffectSpectralFlame_Continue (:2936)
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2938)
  const missed = checkAccuracy(ctx, targetId, moveId)

  // ppreduce (:2940)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // jumpifsubstituteblocks BattleScript_ButItFailed (:2941)
  if (doesSubstituteBlockMove(state, battlerId, targetId, moveId, deps, unmodelled)) {
    return outcome(ctx, { targetId, missed: true })
  }

  // setgastroacid BattleScript_EffectSpectralFlame_NoSuppress (:2942)
  const failsGastroAcid = hasFlag(target.statuses3, STATUS3_GASTRO_ACID) || doesBattlerHaveAbilityShield(target, deps)

  if (failsGastroAcid) {
    // BattleScript_EffectSpectralFlame_NoSuppress (:2949-2955):
    // requirecandoeffect BS_TARGET, MOVE_EFFECT_BURN (:2950)
    if (!canBeBurned(state, targetId, battlerId, deps)) {
      return outcome(ctx, { targetId })
    }

    // jumpifsafeguard BattleScript_SafeguardProtected (:2951)
    if (hasFlag(state.sides[targetId & 1].statuses, SIDE_STATUS_SAFEGUARD)) {
      return outcome(ctx, { targetId })
    }

    // setmoveeffect MOVE_EFFECT_BURN, seteffectprimary (:2953-2954)
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

  // Success branch of setgastroacid:
  target.statuses3 = setFlag(target.statuses3, STATUS3_GASTRO_ACID)

  // setmoveeffect MOVE_EFFECT_BURN, seteffectprimary (:2944-2945)
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
 * EFFECT_PARTING_SHOT (Parting Shot).
 * BattleScript_EffectPartingShot (data/battle_scripts_1.s:1091-1115),
 * BattleScript_MoveSwitch / BattleScript_DoMoveSwitch (data/battle_scripts_1.s:5371-5401).
 *
 * C details and quirks preserved:
 * 1. ppreduce (:1094) runs before stat checks and accuracy check; PP is always spent.
 * 2. Jump to BattleScript_CantLowerMultipleStats (:1096) if both Atk and SpAtk are already at MIN_STAT_STAGE;
 *    in that case the move fails and the switch is skipped.
 * 3. accuracycheck (:1098) follows; if missed, the move fails and the switch is skipped.
 * 4. Atk is lowered by 1 stage, then SpAtk by 1 stage (with onStatLowered reactions dispatched).
 * 5. C quirk: Even if both stat drops fail (e.g. blocked by Clear Body), the script jumps from
 *    statbuffchange to BattleScript_EffectPartingShotSwitch -> BattleScript_MoveSwitch, attempting the switch.
 * 6. In BattleScript_DoMoveSwitch (:5376-5379), the switch is skipped if the battle has ended, in arena battles,
 *    or if the user cannot switch (SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER: commanded or no valid reserves).
 */
export function handlePartingShot(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const target = state.battlers[targetId]!
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:1094)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. BattleScript_CantLowerMultipleStats check (:1095-1096)
  const atkStage = target.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
  const spAtkStage = target.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
  if (atkStage === MIN_STAT_STAGE && spAtkStage === MIN_STAT_STAGE) {
    return outcome(ctx, { targetId })
  }

  // 3. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:1098)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  const statChanges: StatChangeOutcome[] = []

  // 4. TryAtk: setstatchanger STAT_ATK, 1, TRUE + statbuffchange (:1104-1105)
  const r1 = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -1,
    STAT_ATK,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (r1.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: STAT_ATK, change: r1.delta })
  }
  if (r1.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
    dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
  }

  // 5. TrySpAtk: setstatchanger STAT_SPATK, 1, TRUE + statbuffchange (:1110-1111)
  const r2 = changeStatBuffsImplicit(
    state,
    battlerId,
    targetId,
    -1,
    STAT_SPATK,
    STAT_BUFF_ALLOW_PTR,
    true,
    deps,
    unmodelled,
    moveId,
  )
  if (r2.delta !== 0) {
    statChanges.push({ battlerId: targetId, stat: STAT_SPATK, change: r2.delta })
  }
  if (r2.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (battlerId & 1) !== (targetId & 1)) {
    dispatchOnStatLowered(state, targetId, battlerId, deps, unmodelled, statChanges)
  }

  // 6. BattleScript_DoMoveSwitch (:5375-5379)
  // Switch skipped if battle outcome set, arena battle, or user cannot switch (commanded / no valid reserve).
  if (!state.battleOutcome && !hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA) && canBattlerSwitch(state, battlerId)) {
    const switchUnmodelled = performSwitchAction(state, battlerId, deps, { ignoreEscapePrevention: true })
    unmodelled.push(...switchUnmodelled)
  }

  return outcome(ctx, { targetId, statChanges, missed: false })
}

/**
 * EFFECT_ROAR (Roar, Whirlwind).
 * BattleScript_EffectRoar (data/battle_scripts_1.s:3755-3774),
 * Cmd_forcerandomswitch (src/battle_script_commands.c:10047-10196),
 * BattleScript_RoarSuccessSwitch (data/battle_scripts_1.s:7548-7561).
 *
 * C details and quirks preserved:
 * 1. accuracycheck (:3757) + ppreduce (:3759); BattleScript_PrintMoveMissed (:3092-3101) also calls ppreduce,
 *    so PP is always spent.
 * 2. jumpifabilityflag BS_TARGET, ABILITY_SUCTION_CUPS (:3761) checks suctionCups bitfield
 *    (Suction Cups, Guard Dog, Strong Foundation, Superheavy in abilities.cc) with mold breaker check
 *    (checkbreakable=TRUE). If present, phasing is prevented (BattleScript_AbilityPreventsPhasingOut).
 * 3. jumpifstatus3 BS_TARGET, STATUS3_ROOTED (:3762) prevents phasing if target is rooted by Ingrain.
 * 4. jumpifstatus4 BS_TARGET, STATUS4_COMMANDED (:3763) prevents phasing if target is commanded.
 * 5. jumpifbattletype BATTLE_TYPE_ARENA (:3764) fails in arena battles via BattleScript_ButItFailed.
 * 6. Cmd_forcerandomswitch (:10156-10182) in singles counts valid alive reserves; if validMons <= 1,
 *    phasing fails (jumps to BattleScript_End).
 * 7. RNG draw: do { i = Random() % 6; } while (i == targetPartyIndex || party[i] empty/fainted).
 *    Drawn via state.rng.random16() in exact C order.
 * 8. On success, BattleScript_RoarSuccessSwitch switches out the target to party slot i.
 */
export function handleRoar(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, targetId, action, deps, unmodelled, deductPp } = ctx
  if (targetId === null || !state.battlers[targetId] || state.battlers[targetId]!.mon.hp === 0) {
    return outcome(ctx, { targetId })
  }

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:3759) - spent on both hit and miss (BattleScript_PrintMoveMissed has ppreduce)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:3757)
  const missed = checkAccuracy(ctx, targetId, moveId)
  if (missed) {
    return outcome(ctx, { targetId, missed: true })
  }

  // 3-8. The phasing checks, the random pick and the switch.
  const phased = forceRandomSwitch(state, battlerId, targetId, deps, unmodelled)
  return outcome(ctx, { targetId, missed: phased === 'ARENA' })
}

/**
 * TryScheduleSwitch (src/battle_util.c:369-376): append an entry to `gQueuedSwitchData`,
 * refusing when an entry for the same `switchingBattler` is already queued. The drain is
 * turn.ts's drainQueuedSwitches; live here rather than in turn.ts so moveEnd.ts, which
 * turn.ts already imports, can schedule without adding a cycle.
 */
export function tryScheduleSwitch(state: BattleState, entry: QueuedSwitchAction): boolean {
  if (state.queuedSwitches.some((queued) => queued.switchingBattler === entry.switchingBattler)) return false
  state.queuedSwitches.push(entry)
  return true
}

/**
 * The part of BattleScript_EffectRoar after the accuracy check (data/battle_scripts_1.s:3761-3774) and Cmd_forcerandomswitch
 * (battle_script_commands.c:10047-10196), shared by Roar / Whirlwind and by EFFECT_HIT_SWITCH_TARGET's tryhitswitchtarget.
 * Returns 'ARENA' when the arena check sends it to BattleScript_ButItFailed, 'BLOCKED' when an ability, Ingrain, Commander or a lack of
 * reserves stops it, 'SWITCHED' otherwise.
 */
export function forceRandomSwitch(
  state: BattleState,
  battlerId: number,
  targetId: number,
  deps: MoveEffectContext['deps'],
  unmodelled: string[],
): 'ARENA' | 'BLOCKED' | 'SWITCHED' {
  const battler = state.battlers[battlerId]!
  const target = state.battlers[targetId]!

  // 3. jumpifabilityflag BS_TARGET, ABILITY_SUCTION_CUPS (:3761)
  // CheckAbilityFlag (battle_script_commands.c:6685-6686): checks suctionCups bitfield with mold breaker.
  const attackerHasMB = attackerHasMoldBreakerActive(battler, deps)
  const isSuctionCups =
    battlerHasSimAbility(state, target, 'ABILITY_SUCTION_CUPS', true, battlerId, attackerHasMB, deps.dataContext) ||
    battlerHasSimAbility(state, target, 'ABILITY_GUARD_DOG', true, battlerId, attackerHasMB, deps.dataContext) ||
    battlerHasSimAbility(state, target, 'ABILITY_STRONG_FOUNDATION', true, battlerId, attackerHasMB, deps.dataContext) ||
    battlerHasSimAbility(state, target, 'ABILITY_SUPERHEAVY', true, battlerId, attackerHasMB, deps.dataContext)
  if (isSuctionCups) {
    return 'BLOCKED'
  }

  // 4. jumpifstatus3 BS_TARGET, STATUS3_ROOTED (:3762)
  if (hasFlag(target.statuses3, STATUS3_ROOTED)) {
    return 'BLOCKED'
  }

  // 5. jumpifstatus4 BS_TARGET, STATUS4_COMMANDED (:3763)
  if (hasFlag(target.statuses4, STATUS4_COMMANDED)) {
    return 'BLOCKED'
  }

  // 6. jumpifbattletype BATTLE_TYPE_ARENA, BattleScript_ButItFailed (:3764)
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA)) {
    return 'ARENA'
  }

  // 7. Cmd_forcerandomswitch (:10156-10182)
  const targetParty = state.sides[targetId & 1].party
  let validMons = 0
  for (let i = 0; i < PARTY_SIZE; i++) {
    const slot = targetParty[i]
    if (slot && slot.speciesId !== null && slot.hp > 0) {
      validMons++
    }
  }

  if (validMons <= 1) {
    // No reserve pokemon to switch into; phasing fails
    return 'BLOCKED'
  }

  // 8. Random selection loop (:10176-10180)
  let chosenIndex: number
  do {
    const roll = state.rng.random16()
    chosenIndex = roll % PARTY_SIZE
  } while (
    chosenIndex === target.partyIndex ||
    !targetParty[chosenIndex] ||
    targetParty[chosenIndex]!.speciesId === null ||
    targetParty[chosenIndex]!.hp <= 0
  )

  const switchUnmodelled = performSwitchAction(state, targetId, deps, {
    ignoreEscapePrevention: true,
    forcedPartyIndex: chosenIndex,
  })
  unmodelled.push(...switchUnmodelled)
  return 'SWITCHED'
}

/**
 * EFFECT_REVIVAL_BLESSING (Revival Blessing).
 * BattleScript_EffectRevivalBlessing (data/battle_scripts_1.s:11835-11856),
 * Cmd_openpartyscreen (src/battle_script_commands.c:5359-5374),
 * VARIOUS_TRY_REVIVAL_BLESSING (src/battle_script_commands.c:8434-8461),
 * GetFirstFaintedPartyIndex (src/battle_script_commands.c:9133-9159),
 * battle_controller_opponent.c:1648-1651.
 *
 * C details and quirks preserved:
 * 1. ppreduce (:11838) runs before fog check and party checks; PP is spent on both success and failure.
 * 2. jumpifweatheraffected BS_ATTACKER, WEATHER_FOG_ANY (:11839): fails in fog via BattleScript_ButItFailed.
 * 3. openpartyscreen BS_CHOOSE_FAINTED_MON (:11840, :5371-5374) / VARIOUS_TRY_REVIVAL_BLESSING (:8437-8440):
 *    fails if no party mon is fainted (GetFirstFaintedPartyIndex returns PARTY_SIZE).
 * 4. Revives the first fainted mon in party order to Math.trunc(maxHp / 2) (:8445).
 * 5. In singles, the revived mon remains in the party (not sent out).
 */
export function handleRevivalBlessing(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const battler = state.battlers[battlerId]
  if (!battler) return outcome(ctx)

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. ppreduce (:11838)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 2. jumpifweatheraffected BS_ATTACKER, WEATHER_FOG_ANY (:11839)
  if (isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps)) {
    return outcome(ctx, { missed: true })
  }

  // 3. Find first fainted mon in party (GetFirstFaintedPartyIndex, :9133-9159)
  const party = state.sides[battlerId & 1].party
  const faintedIndex = party.findIndex(
    (slot, idx) => idx < PARTY_SIZE && slot.speciesId !== null && slot.hp === 0,
  )

  if (faintedIndex === -1) {
    return outcome(ctx, { missed: true })
  }

  // 4. Revive to half max HP (VARIOUS_TRY_REVIVAL_BLESSING, :8445)
  const revivedMon = party[faintedIndex]!
  revivedMon.hp = Math.trunc(revivedMon.maxHp / 2)

  return outcome(ctx, { missed: false })
}

/**
 * EFFECT_HEALING_WISH (Healing Wish, Lunar Dance).
 * BattleScript_EffectHealingWish (data/battle_scripts_1.s:2364-2414).
 *
 * C details and quirks preserved:
 * 1. jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER (:2366) runs before attackstring/ppreduce.
 *    If user cannot switch (commanded or no valid live reserve in party), branches to
 *    BattleScript_ButItFailedAtkStringPpReduce, spending PP and failing without user fainting.
 * 2. If valid reserve exists, user spends PP, then faints via instanthpdrop/setatkhptozero/tryfaintmon (:2371-2373).
 * 3. scheduleswitch BS_ATTACKER, BattleScript_HealingWishSwitch (:2374) immediately performs the mid-turn switch.
 * 4. In BattleScript_HealingWishSwitch (:2377-2413), the incoming replacement:
 *    - if MOVE_LUNAR_DANCE (:2394-2396): restores PP of all moves to max (VARIOUS_RESTORE_PP).
 *    - dmgtomaxattackerhp + datahpupdate (:2402-2405): heals to full max HP.
 *    - clearstatus (:2406): clears status1.
 *    - switchineffects (:2412): runs entry hazards and switch-in abilities.
 * 5. In ER's C engine, there is no side wish flag; the replacement is switched in and healed immediately.
 */
export function handleHealingWish(ctx: MoveEffectContext): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp, applyDamage } = ctx
  const battler = state.battlers[battlerId]
  if (!battler) return outcome(ctx)

  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect

  // 1. jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION | BS_ATTACKER (:2366)
  if (!canBattlerSwitch(state, battlerId)) {
    // BattleScript_ButItFailedAtkStringPpReduce (:2366)
    deductPp(state, battlerId, moveId, moveEffect, unmodelled)
    return outcome(ctx, { missed: true })
  }

  // 2. attackstring + ppreduce (:2367-2368)
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // 3. User faints: instanthpdrop + setatkhptozero + tryfaintmon (:2371-2373)
  const userHp = battler.mon.hp
  const fainted: number[] = []
  applyDamage(state, battlerId, userHp, fainted, deps)

  // 4. scheduleswitch BS_ATTACKER, BattleScript_HealingWishSwitch (:2374)
  const isLunarDance = moveId === 'MOVE_LUNAR_DANCE'
  const switchUnmodelled = performSwitchAction(state, battlerId, deps, {
    ignoreEscapePrevention: true,
    healingWish: true,
    lunarDance: isLunarDance,
  })
  unmodelled.push(...switchUnmodelled)

  return outcome(ctx, { fainted, attackerDamage: userHp, missed: false })
}

const HANDLERS: Record<string, MoveEffectHandler> = {
  EFFECT_BATON_PASS: handleBatonPass,
  EFFECT_SHED_TAIL: handleShedTail,
  EFFECT_CHILLY_RECEPTION: handleChillyReception,
  EFFECT_SEPTIC_SWITCH: handleSepticSwitch,
  EFFECT_SHOWTIME: handleShowtime,
  EFFECT_SPECTRAL_FLAME: handleSpectralFlame,
  EFFECT_SWITCH_ARGUMENT: handleSwitchArgument,
  EFFECT_PARTING_SHOT: handlePartingShot,
  EFFECT_ROAR: handleRoar,
  EFFECT_REVIVAL_BLESSING: handleRevivalBlessing,
  EFFECT_HEALING_WISH: handleHealingWish,
  EFFECT_SPITE: handleSpite,
  EFFECT_GRUDGE: handleGrudge,
  EFFECT_IMPRISON: handleImprison,
  EFFECT_TELEKINESIS: handleTelekinesis,
  EFFECT_ELECTRIFY: handleElectrify,
  EFFECT_POWER_TRICK: handlePowerTrick,
  EFFECT_ION_DELUGE: handleIonDeluge,
  EFFECT_POWDER: handlePowder,
  EFFECT_GASTRO_ACID: handleGastroAcid,
  EFFECT_SIMPLE_BEAM: handleSimpleBeam,
  EFFECT_WORRY_SEED: handleWorrySeed,
  EFFECT_ENTRAINMENT: handleEntrainment,
  EFFECT_ROLE_PLAY: handleRolePlay,
  EFFECT_SKILL_SWAP: handleSkillSwap,
  EFFECT_PROTECT: handleProtect,
  EFFECT_ENDURE: handleProtect,
  EFFECT_MAT_BLOCK: handleProtect,

  EFFECT_SOAK: handleSoak,
  EFFECT_THIRD_TYPE: handleThirdType,
  EFFECT_CONVERSION: handleConversion,
  EFFECT_CONVERSION_2: handleConversion2,
  EFFECT_REFLECT_TYPE: handleReflectType,
  EFFECT_COPYCAT: handleCopycat,
  EFFECT_INSTRUCT: handleInstruct,
  EFFECT_MIMIC: handleMimic,
  EFFECT_MIRROR_MOVE: handleMirrorMove,
  EFFECT_SKETCH: handleSketch,
  EFFECT_DOODLE: handleDoodle,
  EFFECT_TRANSFORM: handleTransform,
  EFFECT_METRONOME: handleMetronome,
  EFFECT_ASSIST: handleAssist,
  EFFECT_SLEEP_TALK: handleSleepTalk,
  EFFECT_ME_FIRST: handleMeFirst,

  EFFECT_LUCKY_CHANT: handleLuckyChant,
  EFFECT_QUICK_GUARD: handleQuickGuard,
  EFFECT_SMOKESCREEN: handleSmokescreen,

  EFFECT_MUD_SPORT: handleTypeBasedHalvers,
  EFFECT_WATER_SPORT: handleTypeBasedHalvers,
  EFFECT_FAIRY_LOCK: handleFairyLock,

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
  EFFECT_FUTURE_SIGHT: handleFutureSight,
  EFFECT_HEAL_BELL: handleHealBell,
  EFFECT_REFRESH: handleRefresh,
  EFFECT_PURIFY: handlePurify,
  EFFECT_TAKE_HEART: handleTakeHeart,
  EFFECT_REST: handleRest,
  EFFECT_HEAL_PULSE: handleHealPulse,
  EFFECT_PSYCHO_SHIFT: handlePsychoShift,
  EFFECT_STOCKPILE: handleStockpile,
  EFFECT_SWALLOW: handleHealHalf,

  EFFECT_PSYCH_UP: handlePsychUp,
  EFFECT_POWER_SWAP: handlePowerSwap,
  EFFECT_GUARD_SWAP: handleGuardSwap,
  EFFECT_SPEED_SWAP: handleSpeedSwap,
  EFFECT_HEART_SWAP: handleHeartSwap,
  EFFECT_POWER_SPLIT: handlePowerSplit,
  EFFECT_GUARD_SPLIT: handleGuardSplit,
  EFFECT_TOPSY_TURVY: handleTopsyTurvy,

  EFFECT_ACUPRESSURE: handleAcupressure,
  EFFECT_CLANGOROUS_SOUL: handleClangorousSoul,
  EFFECT_FILLET_AWAY: handleFilletAway,
  EFFECT_NO_RETREAT: handleNoRetreat,
  EFFECT_TIDY_UP: handleTidyUp,

  EFFECT_VENOM_DRENCH: handleVenomDrench,
  EFFECT_TOXIC_THREAD: handleToxicThread,
  EFFECT_TAR_SHOT: handleTarShot,
  EFFECT_SPICY_EXTRACT: handleSpicyExtract,
  EFFECT_MEMENTO: handleMemento,

  EFFECT_DO_NOTHING: handleDoNothing,
  EFFECT_AUTOTOMIZE: handleAutotomize,
  EFFECT_FLOWER_SHIELD: handleFlowerShield,
  EFFECT_ROTOTILLER: handleRototiller,
  EFFECT_MAGNETIC_FLUX: handleMagneticFlux,
  EFFECT_COURT_CHANGE: handleCourtChange,

  EFFECT_AFTER_YOU: handleAfterYou,
  EFFECT_QUASH: handleQuash,
  EFFECT_COACHING: handleCoaching,
  EFFECT_AROMATIC_MIST: handleAromaticMist,
  EFFECT_TEATIME: handleTeatime,
  EFFECT_STUFF_CHEEKS: handleStuffCheeks,

  EFFECT_BESTOW: handleBestow,
  EFFECT_CALTROPS: handleCaltrops,
  EFFECT_GEOMANCY: handleGeomancy,
  EFFECT_KINESIS: handleKinesis,
  EFFECT_DRAIN_BRAIN: handleDrainBrain,
  EFFECT_WATERLOG: handleWaterlog,

  EFFECT_TRICK: handleTrick,
  EFFECT_SNATCH: handleSnatch,
  EFFECT_MAGIC_COAT: handleMagicCoat,
  EFFECT_ALLY_SWITCH: handleAllySwitch,
  EFFECT_FOLLOW_ME: handleFollowMe,
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

// pipeline/.upstream/er-config/MoveEffect.proto:12-22, 26, 28-41, 45, 47, 52-65, 83, 84, 99, 109-114
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
  MOVE_EFFECT_NIGHTMARE: MOVE_EFFECT_NIGHTMARE,
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
  MOVE_EFFECT_DEF_SPDEF_DOWN: MOVE_EFFECT_DEF_SPDEF_DOWN,
  MOVE_EFFECT_ATK_DEF_DOWN: MOVE_EFFECT_ATK_DEF_DOWN,
  MOVE_EFFECT_HIGHEST_STAT_EXCEPT_SPEED_PLUS_1: MOVE_EFFECT_HIGHEST_STAT_EXCEPT_SPEED_PLUS_1,
  MOVE_EFFECT_RECHARGE: MOVE_EFFECT_RECHARGE,
  MOVE_EFFECT_WRAP: MOVE_EFFECT_WRAP,
  MOVE_EFFECT_PREVENT_ESCAPE: MOVE_EFFECT_PREVENT_ESCAPE,
  MOVE_EFFECT_ATTRACT: MOVE_EFFECT_ATTRACT,
  MOVE_EFFECT_CURSE: MOVE_EFFECT_CURSE,
  MOVE_EFFECT_YAWN: MOVE_EFFECT_YAWN,
  MOVE_EFFECT_DRENCH: MOVE_EFFECT_DRENCH,
  MOVE_EFFECT_STEALTH_ROCK: MOVE_EFFECT_STEALTH_ROCK,
  MOVE_EFFECT_CREEPING_THORNS: MOVE_EFFECT_CREEPING_THORNS,
  MOVE_EFFECT_SPIKES: MOVE_EFFECT_SPIKES,
  MOVE_EFFECT_LEECH_SEED: MOVE_EFFECT_LEECH_SEED,
  MOVE_EFFECT_STICKY_WEB: MOVE_EFFECT_STICKY_WEB,
  MOVE_EFFECT_THRASH: MOVE_EFFECT_THRASH,
  MOVE_EFFECT_PAYDAY: MOVE_EFFECT_PAYDAY,
  MOVE_EFFECT_INCINERATE: MOVE_EFFECT_INCINERATE,
  MOVE_EFFECT_REMOVE_STATUS: MOVE_EFFECT_REMOVE_STATUS,
  MOVE_EFFECT_BURN_UP: MOVE_EFFECT_BURN_UP,
  MOVE_EFFECT_CLEAR_SMOG: MOVE_EFFECT_CLEAR_SMOG,
  MOVE_EFFECT_FLAME_BURST: MOVE_EFFECT_FLAME_BURST,
  MOVE_EFFECT_FEINT: MOVE_EFFECT_FEINT,
  MOVE_EFFECT_SPECTRAL_THIEF: MOVE_EFFECT_SPECTRAL_THIEF,
  MOVE_EFFECT_V_CREATE: MOVE_EFFECT_V_CREATE,
  MOVE_EFFECT_CORE_ENFORCER: MOVE_EFFECT_CORE_ENFORCER,
  MOVE_EFFECT_THROAT_CHOP: MOVE_EFFECT_THROAT_CHOP,
  MOVE_EFFECT_TRAP_BOTH: MOVE_EFFECT_TRAP_BOTH,
  MOVE_EFFECT_GLAIVE_RUSH: MOVE_EFFECT_GLAIVE_RUSH,
  MOVE_EFFECT_SALT_CURE: MOVE_EFFECT_SALT_CURE,
  MOVE_EFFECT_ORDER_UP: MOVE_EFFECT_ORDER_UP,
  MOVE_EFFECT_WATER_PLEDGE: MOVE_EFFECT_WATER_PLEDGE,
  MOVE_EFFECT_FIRE_PLEDGE: MOVE_EFFECT_FIRE_PLEDGE,
  MOVE_EFFECT_GRASS_PLEDGE: MOVE_EFFECT_GRASS_PLEDGE,
  MOVE_EFFECT_RAINBOW: MOVE_EFFECT_RAINBOW,
  MOVE_EFFECT_FIRE_SEA: MOVE_EFFECT_FIRE_SEA,
  MOVE_EFFECT_SWAMP: MOVE_EFFECT_SWAMP,
  MOVE_EFFECT_SYRUP: MOVE_EFFECT_SYRUP,
  MOVE_EFFECT_DIRE_CLAW: MOVE_EFFECT_DIRE_CLAW,
  MOVE_EFFECT_FEAR: MOVE_EFFECT_FEAR,
  MOVE_EFFECT_PSYCHIC_NOISE: MOVE_EFFECT_PSYCHIC_NOISE,
}
export const SECONDARY_STATUS_EFFECT_MAP = SECONDARY_MOVE_EFFECT_MAP

// The numeric values of MOVE_EFFECT_KNOCK_OFF / STEAL_ITEM / BUG_BITE / SMACK_DOWN are generated and not in the tree.
// Downstream, getMoveEffectChance only compares against FLINCH / BURN / FROSTBITE, so any value outside the real enum
// range behaves identically.
const MOVE_EFFECT_STORED_FOR_MOVEEND = -1
// MOVE_EFFECT_DOUBLESLAP is generated too; same reasoning as above (it is re-dispatched as MOVE_EFFECT_CONFUSION before any
// comparison that depends on its value).
const MOVE_EFFECT_DOUBLESLAP = -2
// MOVE_EFFECT_RECOIL_HP_25 (Struggle, BattleScript_EffectRecoilHP25 data/battle_scripts_1.s:6538-6542), generated like the two above.
const MOVE_EFFECT_RECOIL_HP_25 = -3
const GENERATED_MOVE_EFFECT_NUMBERS: Record<string, number> = {
  MOVE_EFFECT_DOUBLESLAP,
  MOVE_EFFECT_RECOIL_HP_25,
}

// SetMoveEffect's first switch (battle_script_commands.c:2321-2334) stores these in gBattleStruct->moveEffect2 and
// returns; MOVEEND_MOVE_EFFECTS2_ON_EACH / MOVEEND_MOVE_EFFECTS2 (moveEnd.ts) apply them. MAKE_IT_RAIN is in the C switch too,
// but no move in moves.json carries it (Make It Rain's argument is MOVE_EFFECT_SP_ATK_MINUS_1), so it is not listed.
const MOVE_EFFECTS_STORED_FOR_MOVEEND = new Set([
  'MOVE_EFFECT_KNOCK_OFF',
  'MOVE_EFFECT_STEAL_ITEM',
  'MOVE_EFFECT_BUG_BITE',
  'MOVE_EFFECT_SMACK_DOWN',
  'MOVE_EFFECT_REMOVE_STATUS',
  'MOVE_EFFECT_BURN_UP',
  'MOVE_EFFECT_SCALE_SHOT',
  'MOVE_EFFECT_WYRM_WIND',
])

/** VARIOUS_TRY_FLING's item -> gBattleScripting.moveEffect switch (battle_script_commands.c:8405-8426). */
const FLING_ITEM_EFFECTS: Record<string, string> = {
  ITEM_FLAME_ORB: 'MOVE_EFFECT_BURN',
  ITEM_RAZOR_FANG: 'MOVE_EFFECT_FLINCH',
  ITEM_KINGS_ROCK: 'MOVE_EFFECT_FLINCH',
  ITEM_TOXIC_ORB: 'MOVE_EFFECT_TOXIC',
  ITEM_FROST_ORB: 'MOVE_EFFECT_FROSTBITE',
  ITEM_LIGHT_BALL: 'MOVE_EFFECT_PARALYSIS',
  ITEM_BLACK_SLUDGE: 'MOVE_EFFECT_POISON',
  ITEM_POISON_BARB: 'MOVE_EFFECT_POISON',
}

export interface SecondaryEffectsResult {
  /** HP the effects took from the ATTACKER (Struggle's recoil); the caller applies it so a faint is recorded. */
  attackerDamage?: number
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
  targetHasActedThisTurn?: boolean
  deps: StatusDeps & { moveBehaviors?: MoveBehaviors }
  unmodelled: string[]
  snapJawRaiseSpeed?: boolean | null
  order?: readonly number[]
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

  let statusAppliedOutcome: StatusAppliedOutcome | null = null
  let attackerSelfDamage = 0

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
  } else if (
    moveEffect === 'EFFECT_ARGUMENT_HIT' ||
    moveEffect === 'EFFECT_RECOIL_IF_MISS' ||
    moveEffect === 'EFFECT_EXPLOSION' ||
    moveEffect === 'EFFECT_MIND_BLOWN' ||
    moveEffect === 'EFFECT_TWO_TURN_RETALIATION' ||
    moveEffect === 'EFFECT_HIT_SWITCH_TARGET' ||
    moveEffect === 'EFFECT_HEAT_CRASH' ||
    moveEffect === 'EFFECT_FALSE_SWIPE' ||
    // BattleScript_EffectRemoveTerrainNoFail (s:717-744): argumenttomoveeffect, seteffectwithchance, then removeterrain (hitScripts.ts)
    moveEffect === 'EFFECT_REMOVE_TERRAIN_NO_FAIL' ||
    // er-config MoveBehaviorConfigList.textproto:128-131 maps EFFECT_MULTI_HIT to BattleScript_EffectArgumentHit, so every hit
    // of Double Slap / Scale Shot / Toxic Needles / ... re-runs the same argumenttomoveeffect + seteffectwithchance.
    moveEffect === 'EFFECT_MULTI_HIT'
  ) {
    // Legacy script: BattleScript_EffectArgumentHit (data/battle_scripts_1.s:11831)
    // argumenttomoveeffect; goto BattleScript_EffectHit. Recoil-if-miss (:4146-4147), Explosion (:3517-3518) and
    // Mind Blown (reaches ExplosionLoop) run the same argumenttomoveeffect; seteffectwithchance on a hit.
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
  } else if (moveEffect === 'EFFECT_RAMPAGE') {
    // BattleScript_EffectRampage (data/battle_scripts_1.s:3744-3753): Discipline jumps to BattleScript_EffectHit (a plain hit);
    // otherwise Cmd_confuseifrepeatingattackends (battle_script_commands.c:10008-10011) sets MOVE_EFFECT_THRASH | MOVE_EFFECT_AFFECTS_USER
    // unless the user is already locked or a Dancer copy is running, then BattleScript_HitFromCritCalc reaches seteffectwithchance.
    const rampager = state.battlers[attackerId]
    const hasDiscipline = rampager ? battlerHasSimAbility(state, rampager, 'ABILITY_DISCIPLINE', false, attackerId, false, deps.dataContext) : false
    if (rampager && !hasDiscipline && !hasFlag(rampager.mon.status2, STATUS2_LOCK_CONFUSE) && !rampager.turn.dancerUsedMove) {
      effectSpecs.push({
        effectName: 'MOVE_EFFECT_THRASH',
        chance: moveData?.effectChance ?? 0,
        affectsUser: true,
        certain: false,
      })
    }
  } else if (moveEffect === 'EFFECT_HIT_PREVENT_ESCAPE') {
    // Legacy script: BattleScript_EffectHitPreventEscape (data/battle_scripts_1.s:4886-4888)
    // setmoveeffect MOVE_EFFECT_PREVENT_ESCAPE
    // goto BattleScript_EffectHit
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_PREVENT_ESCAPE',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
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
  } else if (moveEffect === 'EFFECT_TREPIDATION') {
    // BattleScript_EffectTrepidation (data/battle_scripts_1.s:12502-12523, VARIOUS_TREPIDATION battle_script_commands.c:8715-8723)
    const targetBattler = state.battlers[targetId]
    if (targetBattler && targetBattler.volatiles.trepidation === 0) {
      targetBattler.volatiles.trepidation = 3
      targetBattler.volatiles.started.trepidation = true
    }
  } else if (moveEffect === 'EFFECT_CLOSE_COMBAT') {
    // BattleScript_EffectCloseCombat
    // data/battle_scripts_1.s:6341: setmoveeffect MOVE_EFFECT_DEF_SPDEF_DOWN | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_DEF_SPDEF_DOWN',
      chance: 100,
      affectsUser: true,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_SUPERPOWER') {
    // BattleScript_EffectSuperpower (data/battle_scripts_1.s:6337):
    // setmoveeffect MOVE_EFFECT_ATK_DEF_DOWN | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_ATK_DEF_DOWN',
      chance: 100,
      affectsUser: true,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_RECHARGE') {
    // BattleScript_EffectRecharge (data/battle_scripts_1.s:4532-4536):
    // setmoveeffect MOVE_EFFECT_RECHARGE | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_RECHARGE',
      chance: 100,
      affectsUser: true,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_FAKE_OUT') {
    // BattleScript_EffectFakeOut (data/battle_scripts_1.s:5932-5936):
    // setmoveeffect MOVE_EFFECT_FLINCH, then BattleScript_EffectHit: no CERTAIN bit, chance = the move's effectChance
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_FLINCH',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_DEFENSE_UP2_HIT') {
    // BattleScript_EffectDefenseUp2Hit (data/battle_scripts_1.s:427-429)
    // setmoveeffect MOVE_EFFECT_DEF_PLUS_2 | MOVE_EFFECT_AFFECTS_USER
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_DEF_PLUS_2',
      chance: moveData?.effectChance ?? 0,
      affectsUser: true,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_ATTACKER_DEFENSE_DOWN_HIT') {
    // BattleScript_EffectAttackerDefenseDownHit (data/battle_scripts_1.s:450-452)
    // setmoveeffect MOVE_EFFECT_DEF_MINUS_1 | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_DEF_MINUS_1',
      chance: 100,
      affectsUser: true,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_HYPERSPACE_FURY') {
    // BattleScript_EffectHyperspaceFury (data/battle_scripts_1.s:365-380):
    // Hoopa Unbound applies MOVE_EFFECT_FEINT and MOVE_EFFECT_DEF_MINUS_1 | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN
    const attacker = state.battlers[attackerId]
    if (attacker?.mon.speciesId === 'SPECIES_HOOPA_UNBOUND') {
      effectSpecs.push({
        effectName: 'MOVE_EFFECT_FEINT',
        chance: 100,
        affectsUser: false,
        certain: true,
      })
      effectSpecs.push({
        effectName: 'MOVE_EFFECT_DEF_MINUS_1',
        chance: 100,
        affectsUser: true,
        certain: true,
      })
    }
  } else if (moveEffect === 'EFFECT_V_CREATE') {
    // BattleScript_EffectVCreate (data/battle_scripts_1.s:414-416)
    // setmoveeffect MOVE_EFFECT_V_CREATE | MOVE_EFFECT_AFFECTS_USER
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_V_CREATE',
      chance: 100,
      affectsUser: true,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_RIP_AND_TEAR') {
    // BattleScript_EffectRipAndTear (data/battle_scripts_1.s:458-480)
    // 1. setmoveeffect MOVE_EFFECT_SPD_MINUS_1; seteffectsecondary
    // 2. setmoveeffect MOVE_EFFECT_BLEED; seteffectwithchance
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_SPD_MINUS_1',
      chance: 100,
      affectsUser: false,
      certain: true,
    })
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_BLEED',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_SNAP_JAW') {
    // BattleScript_EffectSnapJaw (data/battle_scripts_1.s:12415-12422)
    // setrandom 2 runs BEFORE accuracycheck in the script; ctx.snapJawRaiseSpeed carries that result.
    const raiseSpeed = ctx.snapJawRaiseSpeed ?? (state.rng.random16() % 2 === 0)
    if (raiseSpeed) {
      effectSpecs.push({
        effectName: 'MOVE_EFFECT_SPD_PLUS_1',
        chance: moveData?.effectChance ?? 0,
        affectsUser: true,
        certain: false,
      })
    } else {
      effectSpecs.push({
        effectName: 'MOVE_EFFECT_SPD_MINUS_1',
        chance: moveData?.effectChance ?? 0,
        affectsUser: false,
        certain: false,
      })
    }
  } else if (moveEffect === 'EFFECT_BULLDOZE') {
    // BattleScript_EffectBulldoze (data/battle_scripts_1.s:925-928)
    // setmoveeffect MOVE_EFFECT_SPD_MINUS_1
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_SPD_MINUS_1',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_ARGUMENT_HIT_IF_STAT_UP') {
    // BattleScript_EffectArgumentHitIfStatUp (data/battle_scripts_1.s:11979-11985)
    // VARIOUS_GOTO_IF_STAT_UP (src/battle_script_commands.c:8475-8484)
    const attacker = state.battlers[attackerId]
    const target = state.battlers[targetId]
    const attackerHasUnaware = attacker
      ? battlerHasSimAbility(state, attacker, 'ABILITY_UNAWARE', false, attackerId, false, deps.dataContext)
      : false
    const targetBleeding = target ? hasFlag(target.mon.status1, STATUS1_BLEED) : false
    const targetHasStatBoost = target
      ? [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF, STAT_ACC, STAT_EVASION].some(
          (s) => (target.mon.statStages[s] ?? DEFAULT_STAT_STAGE) > DEFAULT_STAT_STAGE,
        )
      : false
    if (!attackerHasUnaware && !targetBleeding && targetHasStatBoost) {
      const arg = moveData?.argument
      if (arg && typeof arg === 'object' && arg.kind === 'effect' && typeof arg.effect === 'string') {
        effectSpecs.push({
          effectName: arg.effect,
          chance: moveData?.effectChance ?? 0,
          affectsUser: Boolean(arg.affectsUser),
          certain: Boolean(arg.certain),
        })
      }
    }
  } else if (moveEffect === 'EFFECT_JAW_LOCK') {
    // BattleScript_EffectJawLock (data/battle_scripts_1.s:139-141)
    // setmoveeffect MOVE_EFFECT_TRAP_BOTH | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_TRAP_BOTH',
      chance: 100,
      affectsUser: false,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_FLAME_BURST') {
    // BattleScript_EffectFlameBurst (data/battle_scripts_1.s:143-145)
    // setmoveeffect MOVE_EFFECT_FLAME_BURST | MOVE_EFFECT_AFFECTS_USER
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_FLAME_BURST',
      chance: moveData?.effectChance ?? 0,
      affectsUser: true,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_THROAT_CHOP') {
    // BattleScript_EffectThroatChop (data/battle_scripts_1.s:178-181)
    // setmoveeffect MOVE_EFFECT_THROAT_CHOP | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_THROAT_CHOP',
      chance: 100,
      affectsUser: false,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_CORE_ENFORCER') {
    // BattleScript_EffectCoreEnforcer (data/battle_scripts_1.s:423-425)
    // setmoveeffect MOVE_EFFECT_CORE_ENFORCER | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_CORE_ENFORCER',
      chance: 100,
      affectsUser: false,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_CLEAR_SMOG') {
    // BattleScript_EffectClearSmog (data/battle_scripts_1.s:394-396)
    // setmoveeffect MOVE_EFFECT_CLEAR_SMOG
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_CLEAR_SMOG',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_SPECTRAL_THIEF') {
    // BattleScript_EffectSpectralThief (data/battle_scripts_1.s:608-610)
    // setmoveeffect MOVE_EFFECT_SPECTRAL_THIEF
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_SPECTRAL_THIEF',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_FEINT') {
    // BattleScript_EffectFeint (data/battle_scripts_1.s:755-757)
    // setmoveeffect MOVE_EFFECT_FEINT
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_FEINT',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (moveEffect === 'EFFECT_INCINERATE') {
    // BattleScript_EffectIncinerate (data/battle_scripts_1.s:1247-1249)
    // setmoveeffect MOVE_EFFECT_INCINERATE | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_INCINERATE',
      chance: 100,
      affectsUser: false,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_SPARKLING_ARIA' || moveEffect === 'EFFECT_WAKE_UP_SLAP') {
    // BattleScript_EffectSparklingAria / WakeUpSlap (data/battle_scripts_1.s:859-864)
    // setmoveeffect MOVE_EFFECT_REMOVE_STATUS | MOVE_EFFECT_CERTAIN
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_REMOVE_STATUS',
      chance: 100,
      affectsUser: false,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_UPPER_HAND') {
    // BattleScript_EffectUpperHand (data/battle_scripts_1.s:11986-11990)
    // setmoveeffect MOVE_EFFECT_FLINCH
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_FLINCH',
      chance: 100,
      affectsUser: false,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_OCTOLOCK') {
    // BattleScript_EffectOctolock (data/battle_scripts_1.s:968-990, VARIOUS_SET_OCTOLOCK battle_script_commands.c:8107-8115)
    const targetBattler = state.battlers[targetId]
    if (targetBattler && !targetBattler.volatiles.octolock && targetBattler.mon.hp > 0) {
      targetBattler.volatiles.octolock = true
      targetBattler.mon.status2 = setFlag(targetBattler.mon.status2, STATUS2_ESCAPE_PREVENTION)
      targetBattler.volatiles.battlerPreventingEscape = attackerId
      statusAppliedOutcome = { battlerId: targetId, status: 'OCTOLOCK' }
    }
  } else if (moveEffect === 'EFFECT_SAPPY_SEED') {
    // BattleScript_EffectSappySeed (data/battle_scripts_1.s:471-495, Cmd_setseeded battle_script_commands.c:9341-9355)
    // Cmd_setseeded has no Mycelium Might gate; Grass types are immune.
    const targetBattler = state.battlers[targetId]
    if (
      targetBattler &&
      targetBattler.mon.hp > 0 &&
      (targetDamage ?? 0) > 0 &&
      !hasFlag(targetBattler.statuses3, STATUS3_LEECHSEED) &&
      !targetBattler.mon.types.includes('GRASS')
    ) {
      targetBattler.statuses3 = setFlag(
        targetBattler.statuses3,
        STATUS3_LEECHSEED | (attackerId & STATUS3_LEECHSEED_BATTLER),
      )
      statusAppliedOutcome = { battlerId: targetId, status: 'LEECH_SEED' }
    }
  } else if (moveEffect === 'EFFECT_BURN_UP') {
    // BattleScript_EffectBurnUp (data/battle_scripts_1.s:729-738)
    // setmoveeffect MOVE_EFFECT_BURN_UP
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_BURN_UP',
      chance: 100,
      affectsUser: true,
      certain: true,
    })
  } else if (moveEffect === 'EFFECT_MORTAL_SPIN') {
    // BattleScript_EffectMortalSpin (data/battle_scripts_1.s:1013-1035)
    // 1. setmoveeffect MOVE_EFFECT_RAPIDSPIN | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN
    // 2. argumenttomoveeffect; seteffectwithchance
    const attacker = state.battlers[attackerId]
    if (attacker && attacker.mon.hp > 0 && !testSheerForceFlag(state, attackerId, moveId, deps)) {
      rapidSpinFree(state, attackerId)
    }
    const arg = moveData?.argument
    if (arg && typeof arg === 'object' && arg.kind === 'effect' && typeof arg.effect === 'string') {
      effectSpecs.push({
        effectName: arg.effect,
        chance: moveData?.effectChance ?? 0,
        affectsUser: Boolean(arg.affectsUser),
        certain: Boolean(arg.certain),
      })
    }
  } else if (moveEffect === 'EFFECT_NIGHTMARE') {
    // BattleScript_EffectNightmare (data/battle_scripts_1.s:4909-4916): after the sleep check hitScripts.ts ran,
    // `setmoveeffect MOVE_EFFECT_NIGHTMARE; goto BattleScript_EffectHit` -- the move's own effectChance rolls in seteffectwithchance.
    effectSpecs.push({ effectName: 'MOVE_EFFECT_NIGHTMARE', chance: moveData?.effectChance ?? 0, affectsUser: false, certain: false })
  } else if (moveEffect === 'EFFECT_SNORE') {
    // BattleScript_EffectSnore (data/battle_scripts_1.s:4709-4726): `setmoveeffect MOVE_EFFECT_FLINCH; goto BattleScript_HitFromCritCalc`
    // -- the move's own 30% flinch chance rolls in seteffectwithchance.
    effectSpecs.push({ effectName: 'MOVE_EFFECT_FLINCH', chance: moveData?.effectChance ?? 0, affectsUser: false, certain: false })
  } else if (moveEffect === 'EFFECT_FLING') {
    // BattleScript_EffectFling (data/battle_scripts_1.s:3036-3044): VARIOUS_TRY_FLING (battle_script_commands.c:8402-8433) set
    // gBattleScripting.moveEffect from the item it flung; HitFromCritCalc then runs seteffectwithchance with that effect. Any other
    // item flings for damage only.
    const flungItem = state.battlers[attackerId]?.turn.flungItem
    const flungEffect = flungItem ? FLING_ITEM_EFFECTS[flungItem] : undefined
    if (flungEffect) {
      effectSpecs.push({ effectName: flungEffect, chance: moveData?.effectChance ?? 0, affectsUser: false, certain: false })
    }
  } else if (moveEffect === 'EFFECT_NATURAL_GIFT') {
    // BattleScript_EffectNaturalGift (data/battle_scripts_1.s:3046-3071): after the hit, `setmoveeffect MOVE_EFFECT_NATURAL_GIFT;
    // seteffectsecondary`, and SetMoveEffect's NATURAL_GIFT case (battle_script_commands.c:3020-3024) re-dispatches the berry's
    // gNaturalGiftTable[].effect -- here items.json's naturalGift.effect -- with no chance draw. turn.ts removes the berry afterwards.
    const berryId = state.battlers[attackerId]?.mon.itemId ?? null
    const berryGift = berryId ? deps.dataContext.item(berryId)?.naturalGift : null
    if (berryGift?.effect) {
      effectSpecs.push({ effectName: berryGift.effect, chance: 0, affectsUser: Boolean(berryGift.affectsUser), certain: Boolean(berryGift.certain), secondary: true })
    }
  } else if (moveEffect === 'EFFECT_RECOIL_HP_25') {
    // BattleScript_EffectRecoilHP25 (data/battle_scripts_1.s:6538-6542): setmoveeffect MOVE_EFFECT_RECOIL_HP_25 | AFFECTS_USER |
    // CERTAIN, then BattleScript_EffectHit. Struggle is the only user.
    effectSpecs.push({ effectName: 'MOVE_EFFECT_RECOIL_HP_25', chance: moveData?.effectChance ?? 0, affectsUser: true, certain: true })
  } else if (moveEffect === 'EFFECT_MATCHA_GOTCHA') {
    // BattleScript_EffectMatchaGotcha (data/battle_scripts_1.s:946-966)
    // setmoveeffect MOVE_EFFECT_BURN; seteffectwithchance (drain handled in turn.ts)
    effectSpecs.push({
      effectName: 'MOVE_EFFECT_BURN',
      chance: moveData?.effectChance ?? 0,
      affectsUser: false,
      certain: false,
    })
  } else if (
    moveEffect === 'EFFECT_HIT' ||
    !moveEffect ||
    // Scripts with no setmoveeffect / argumenttomoveeffect before their hit; the rest of each effect lives in turn.ts.
    moveEffect === 'EFFECT_ABSORB' ||
    moveEffect === 'EFFECT_DREAM_EATER' ||
    moveEffect === 'EFFECT_HIT_ESCAPE' ||
    moveEffect === 'EFFECT_SUCKER_PUNCH' ||
    moveEffect === 'EFFECT_STEEL_BEAM' ||
    moveEffect === 'EFFECT_BRICK_BREAK' ||
    // Second-turn hit with moveEffect cleared (BattleScript_EffectTwoTurnSecondarySecondTurn, :4410-4416); turn.ts applies the
    // charge-turn effect and the Solar Beam charge logic.
    moveEffect === 'EFFECT_SOLARBEAM' ||
    moveEffect === 'EFFECT_TWO_TURN_SECONDARY' ||
    // Electro Shot (s:5723-5732) ends in BattleScript_EffectTwoTurnSecondarySecondTurn as well; its Sp. Atk raise is turn.ts's charge turn.
    moveEffect === 'EFFECT_ELECTRO_SHOT' ||
    // Fixed-damage and Haze scripts (turn.ts fixedDamageFor): no setmoveeffect before their hit.
    moveEffect === 'EFFECT_COUNTER' ||
    moveEffect === 'EFFECT_MIRROR_COAT' ||
    moveEffect === 'EFFECT_METAL_BURST' ||
    moveEffect === 'EFFECT_ENDEAVOR' ||
    moveEffect === 'EFFECT_SUPER_FANG' ||
    moveEffect === 'EFFECT_SUPER_FANG_HAZE' ||
    moveEffect === 'EFFECT_LEVEL_DAMAGE' ||
    moveEffect === 'EFFECT_FINAL_GAMBIT' ||
    moveEffect === 'EFFECT_FREEZY_FROST' ||
    // Multi-hit scripts that are a plain hit (MoveBehaviorConfigList.textproto: EFFECT_DOUBLE_HIT :237, EFFECT_TRIPLE_KICK :529,
    // EFFECT_TEN_HITS :2053 -> BattleScript_EffectHit; EFFECT_BEAT_UP :746 -> BattleScript_EffectBeatUp, whose Gen 5+ branch
    // data/battle_scripts_1.s:5775-5779 is addbyte + goto BattleScript_HitFromAtkString). The hits themselves are turn.ts's hit loop.
    moveEffect === 'EFFECT_DOUBLE_HIT' ||
    moveEffect === 'EFFECT_TRIPLE_KICK' ||
    moveEffect === 'EFFECT_TEN_HITS' ||
    moveEffect === 'EFFECT_BEAT_UP' ||
    // Damage-rule effects whose script is a plain hit (BattleScript_EffectHit, MoveBehaviorConfigList.textproto) or a hit behind
    // a check hitScripts.ts runs first, with no setmoveeffect of its own; the engine carries the damage rule (cycle87Effects.test.ts
    // has a numeric case for each): Hidden Power :649, Body Press :1670, Facade :806, Weather Ball :977, Flail :509,
    // Stomping Tantrum :1594, Fell Stinger :694 (its Attack raise is the faint hook, moveEnd.ts), Synchronoise :1487, Foul Play
    // :1200, Double-Damage-If-Status :1931, Spit Up :774, and the BattleScript_EffectPoltergeist / EffectLastResort /
    // EffectMagnitude / EffectRollout / EffectBerrySmash scripts (hit via BattleScript_HitFromCritCalc / HitFromAccCheck).
    moveEffect === 'EFFECT_HIDDEN_POWER' ||
    moveEffect === 'EFFECT_BODY_PRESS' ||
    moveEffect === 'EFFECT_FACADE' ||
    moveEffect === 'EFFECT_WEATHER_BALL' ||
    moveEffect === 'EFFECT_FLAIL' ||
    moveEffect === 'EFFECT_STOMPING_TANTRUM' ||
    moveEffect === 'EFFECT_FELL_STINGER' ||
    moveEffect === 'EFFECT_SYNCHRONOISE' ||
    moveEffect === 'EFFECT_FOUL_PLAY' ||
    moveEffect === 'EFFECT_DOUBLE_DMG_IF_STATUS1' ||
    moveEffect === 'EFFECT_SPIT_UP' ||
    moveEffect === 'EFFECT_POLTERGEIST' ||
    moveEffect === 'EFFECT_LAST_RESORT' ||
    moveEffect === 'EFFECT_MAGNITUDE' ||
    moveEffect === 'EFFECT_ROLLOUT' ||
    moveEffect === 'EFFECT_BELCH' ||
    moveEffect === 'EFFECT_BERRY_SMASH' ||
    // Plain BattleScript_EffectHit (MoveBehaviorConfigList.textproto: CHANGE_TYPE_ON_ITEM :1463, SNIPE_SHOT :1706, MISC_HIT :2080,
    // GUST data/battle_scripts_1.s:5703 -> EffectHit). Their rules live in the damage path: type from the held Plate/Memory
    // (battle_main.c:5036/5137), redirection ignored (turn.ts, battle_util.c:119/9353), MISC_HIT's argument cases
    // (battle_util.c:6861-6885, 7509, 7684) and the Transmute faint hook (moveEnd.ts). Focus Punch (s:6177-6181) only prints
    // the lost-focus line before the same hit; its 40-power rule is battle_util.c:6851-6853.
    moveEffect === 'EFFECT_CHANGE_TYPE_ON_ITEM' ||
    moveEffect === 'EFFECT_SNIPE_SHOT' ||
    moveEffect === 'EFFECT_MISC_HIT' ||
    moveEffect === 'EFFECT_GUST' ||
    moveEffect === 'EFFECT_FOCUS_PUNCH' ||
    // Shell Trap (s:4672-4676): the gate and retarget are hitScripts.ts's runLegacyPreHit, then a plain BattleScript_HitFromAtkString hit.
    moveEffect === 'EFFECT_SHELL_TRAP' ||
    // Pursuit, Grassy Glide and Revelation Dance are legacy_config "BattleScript_EffectHit" in er-config MoveBehaviorConfigList.textproto
    // (:614-617, :1694-1696, :1531-1533): a plain hit. Their rules live elsewhere (basePower.ts, turnOrder.ts:396, calculate.ts);
    // Pursuit's switch interception keeps its own note (damageResolver.ts, battle_script_commands.c:11294-11325, s:7197-7209).
    moveEffect === 'EFFECT_PURSUIT' ||
    moveEffect === 'EFFECT_GRASSY_GLIDE' ||
    moveEffect === 'EFFECT_REVELATION_DANCE' ||
    // Decorate (s:582-584) and Hit Enemy Heal Ally (s:1556-1558) hit a foe through BattleScript_EffectHit; an ALLY target takes
    // the status-move branch, which is not ported (so it keeps the note).
    ((moveEffect === 'EFFECT_DECORATE' || moveEffect === 'EFFECT_HIT_ENEMY_HEAL_ALLY') && (targetId & 1) !== (attackerId & 1)) ||
    // Hit-plus-field/side scripts: the hit goes through `call BattleScript_EffectHit_Return` (s:3465-3490, which carries
    // seteffectwithchance), then the step runLegacyPostHit (hitScripts.ts) performs.
    moveEffect === 'EFFECT_RAIN_HIT' ||
    moveEffect === 'EFFECT_SANDSTORM_HIT' ||
    moveEffect === 'EFFECT_GRASSY_TERRAIN_HIT' ||
    moveEffect === 'EFFECT_FAIRY_TERRAIN_HIT' ||
    moveEffect === 'EFFECT_TAILWIND_HIT' ||
    moveEffect === 'EFFECT_CLEAR_WEATHER_AND_TERRAIN_HIT' ||
    moveEffect === 'EFFECT_SPARKLY_SWIRL' ||
    moveEffect === 'EFFECT_GLITZY_GLOW' ||
    moveEffect === 'EFFECT_BADDY_BAD' ||
    moveEffect === 'EFFECT_SMELLINGSALT' ||
    moveEffect === 'EFFECT_PLASMA_FISTS' ||
    moveEffect === 'EFFECT_EERIE_SPELL' ||
    moveEffect === 'EFFECT_GHASTLY_ECHO'
  ) {
    // Pure damaging move or handled elsewhere with no secondary effect
  } else {
    // Any other legacy script reached by a damaging move:
    unmodelled.push(`secondary effect of ${moveEffect} not modelled`)
    return null
  }

  if (effectSpecs.length === 0) {
    return statusAppliedOutcome
      ? { statusApplied: statusAppliedOutcome, statChanges: [], moveEffect2: null }
      : null
  }

  const statChanges: StatChangeOutcome[] = []
  let moveEffect2: string | null = null

  for (const spec of effectSpecs) {
    const storedForMoveEnd = MOVE_EFFECTS_STORED_FOR_MOVEEND.has(spec.effectName)
    const isDoubleSlap = spec.effectName === 'MOVE_EFFECT_DOUBLESLAP'
    let baseEffectNum = storedForMoveEnd
      ? MOVE_EFFECT_STORED_FOR_MOVEEND
      : (SECONDARY_MOVE_EFFECT_MAP[spec.effectName] ?? GENERATED_MOVE_EFFECT_NUMBERS[spec.effectName])
    if (baseEffectNum === undefined) {
      unmodelled.push(`secondary effect of ${spec.effectName} not modelled`)
      continue
    }

    let effectNumWithFlags =
      baseEffectNum |
      (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) |
      (spec.certain ? MOVE_EFFECT_CERTAIN : 0)

    if (spec.secondary && storedForMoveEnd) {
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
    if (spec.secondary) {
      // Cmd_seteffectsecondary (:3132-3135): SetMoveEffect(FALSE, 0) -- no chance draw and no NO_EFFECT test.
      chancePasses = true
    } else if (spec.certain) {
      // MOVE_EFFECT_CERTAIN skips the RNG draw. The C tests it BEFORE the
      // Minion Control no-op below (:3107-3109 vs :3110-3112), so a certain
      // effect still applies on a bonus hit.
      chancePasses = !isImmune
    } else if (
      // Cmd_seteffectwithchance, battle_script_commands.c:3110-3112: on a Minion
      // Control bonus hit (`parentalBondOn < parentalBondInitialCount` and the
      // trigger is MINION_CONTROL) the command is a no-op -- neither the
      // `Random() % 100` draw nor the effect happens. The guard sits after
      // GetMoveEffectChance (:3106), which draws nothing.
      state.battlers[attackerId]?.turn.parentalBondTrigger === 'ABILITY_MINION_CONTROL' &&
      (state.battlers[attackerId]?.turn.parentalBondOn ?? 0) < (state.battlers[attackerId]?.turn.parentalBondInitialCount ?? 0)
    ) {
      chancePasses = false
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

    // MOVE_EFFECT_DOUBLESLAP (battle_script_commands.c:3016-3019): `REQUIRE(multiHitsUsed >= 2)` then SET_MOVE_EFFECT_AS
    // (MOVE_EFFECT_CONFUSION | affectsUser) -- SetMoveEffect again, with the confusion gates. The chance draw above happens on
    // every hit; only the third and later hits can confuse. multiHitsUsed is the count of EXTRA hits (:4906), 0 on the first.
    if (isDoubleSlap) {
      if ((state.battlers[attackerId]?.turn.multiHitsUsed ?? 0) < 2) continue
      baseEffectNum = MOVE_EFFECT_CONFUSION
      effectNumWithFlags = MOVE_EFFECT_CONFUSION | (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) | (spec.certain ? MOVE_EFFECT_CERTAIN : 0)
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

    // Stat changes: MOVE_EFFECT_DEF_SPDEF_DOWN (battle_script_commands.c:2843-2847) calls BattleScript_DefSpDefDown
    // (data/battle_scripts_1.s:8264+), gated on the attacker lacking Bad Company; MOVE_EFFECT_ATK_DEF_DOWN
    // (:2840-2842) calls BattleScript_AtkDefDown (:8245-8262) with no gate. Both drop two stats by 1 with
    // statbuffchange MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN | STAT_BUFF_ALLOW_PTR.
    if (baseEffectNum === MOVE_EFFECT_DEF_SPDEF_DOWN || baseEffectNum === MOVE_EFFECT_ATK_DEF_DOWN) {
      const attacker = state.battlers[attackerId]
      if (
        baseEffectNum === MOVE_EFFECT_DEF_SPDEF_DOWN &&
        attacker &&
        battlerHasSimAbility(state, attacker, 'ABILITY_BAD_COMPANY', false, attackerId, false, deps.dataContext)
      ) {
        continue
      }
      const dropped = baseEffectNum === MOVE_EFFECT_DEF_SPDEF_DOWN ? [STAT_DEF, STAT_SPDEF] : [STAT_ATK, STAT_DEF]
      for (const statId of dropped) {
        const res = changeStatBuffsImplicit(
          state,
          attackerId,
          targetId,
          -1,
          statId,
          MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN | STAT_BUFF_ALLOW_PTR,
          true,
          deps,
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) {
          statChanges.push({ battlerId: attackerId, stat: statId, change: res.delta })
        }
      }
      continue
    }

    // MOVE_EFFECT_HIGHEST_STAT_EXCEPT_SPEED_PLUS_1 (battle_script_commands.c:3013-3015): re-dispatched as
    // MOVE_EFFECT_ATK_PLUS_1 - STAT_ATK + GetHighestStatIdExcept(effectBattler, FALSE, STAT_SPEED), keeping affectsUser.
    if (baseEffectNum === MOVE_EFFECT_HIGHEST_STAT_EXCEPT_SPEED_PLUS_1) {
      const statId = getHighestStatIdExcept(effectBattler, STAT_SPEED)
      const flags = (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) | STAT_BUFF_UPDATE_MOVE_EFFECT
      const res = changeStatBuffsImplicit(state, attackerId, targetId, 1, statId, flags, false, deps, unmodelled, moveId)
      if (res.delta !== 0) {
        statChanges.push({ battlerId: effectBattlerId, stat: statId, change: res.delta })
      }
      continue
    }

    // MOVE_EFFECT_RECHARGE (battle_script_commands.c:2813-2819)
    if (baseEffectNum === MOVE_EFFECT_RECHARGE) {
      if (!state.processingExtraAttacks) {
        effectBattler.mon.status2 = setFlag(effectBattler.mon.status2, STATUS2_RECHARGE)
        effectBattler.volatiles.rechargeTimer = 2
        state.lockedMoves[effectBattlerId] = moveId
      }
      continue
    }

    // MOVE_EFFECT_THRASH (battle_script_commands.c:2854-2862): locks the user in for 2-3 turns.
    if (baseEffectNum === MOVE_EFFECT_THRASH) {
      if (!hasFlag(effectBattler.mon.status2, STATUS2_LOCK_CONFUSE) && !state.processingExtraAttacks) {
        effectBattler.mon.status2 = setFlag(effectBattler.mon.status2, STATUS2_MULTIPLETURNS)
        state.lockedMoves[effectBattlerId] = moveId
        effectBattler.mon.status2 = setCounter(effectBattler.mon.status2, STATUS2_LOCK_CONFUSE, (state.rng.random16() & 1) + 2)
      }
      continue
    }

    // MOVE_EFFECT_CURSE (battle_script_commands.c:2721-2726)
    if (baseEffectNum === MOVE_EFFECT_CURSE) {
      if (!hasFlag(effectBattler.mon.status2, STATUS2_CURSED)) {
        effectBattler.mon.status2 = setFlag(effectBattler.mon.status2, STATUS2_CURSED)
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'CURSE' }
      }
      continue
    }

    // MOVE_EFFECT_ATTRACT (battle_script_commands.c:2727-2732, battle_util.c:5135-5143)
    if (baseEffectNum === MOVE_EFFECT_ATTRACT) {
      if (applyAttractEffect(state, attackerId, effectBattlerId, deps)) {
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'INFATUATION' }
      }
      continue
    }

    // MOVE_EFFECT_WRAP (battle_script_commands.c:2733-2750, WrapDuration :2300-2309)
    if (baseEffectNum === MOVE_EFFECT_WRAP) {
      if (!hasFlag(effectBattler.mon.status2, STATUS2_WRAPPED)) {
        // SetOnMoveEffectReactionFlags(gBattleScripting.battler, gEffectBattler, MOVE_EFFECT_WRAP)
        // (src/battle_script_commands.c:2735), inside the not-already-wrapped branch.
        setOnMoveEffectReactionFlags(state, attackerId, effectBattlerId, MOVE_EFFECT_WRAP, deps)
        const attackerBattler = state.battlers[attackerId]
        const hasGrappler = ['ABILITY_GRAPPLER', 'ABILITY_TANGLED_TAILS', 'ABILITY_TENTALOCK'].some((ab) =>
          attackerBattler ? battlerHasSimAbility(state, attackerBattler, ab, false, attackerId, false, deps.dataContext) : false,
        )
        const hasGripClaw = deps.grounding ? deps.grounding.holdEffectOf(attackerId) === 'HOLD_EFFECT_GRIP_CLAW' : false
        effectBattler.volatiles.wrapTurns =
          hasGrappler || hasGripClaw ? 5 + (hasGrappler ? 1 : 0) + (hasGripClaw ? 2 : 0) : (state.rng.random16() % 2) + 4
        effectBattler.mon.status2 = setFlag(effectBattler.mon.status2, STATUS2_WRAPPED)
        state.wrappedMove[effectBattlerId] = moveId
        state.wrappedBy[effectBattlerId] = attackerId
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'WRAP' }
      }
      continue
    }

    // MOVE_EFFECT_PREVENT_ESCAPE (battle_script_commands.c:2823-2826)
    if (baseEffectNum === MOVE_EFFECT_PREVENT_ESCAPE) {
      effectBattler.mon.status2 = setFlag(effectBattler.mon.status2, STATUS2_ESCAPE_PREVENTION)
      effectBattler.volatiles.battlerPreventingEscape = attackerId
      statusAppliedOutcome = { battlerId: effectBattlerId, status: 'ESCAPE_PREVENTION' }
      continue
    }

    // MOVE_EFFECT_YAWN (battle_script_commands.c:3001-3005, BattleScript_SetYawnMoveEffect data/battle_scripts_1.s:2434-2442, Cmd_setyawn battle_script_commands.c:11840-11855)
    if (baseEffectNum === MOVE_EFFECT_YAWN) {
      if (
        canSleep(state, effectBattlerId, attackerId, deps) &&
        !hasFlag(effectBattler.statuses3, STATUS3_YAWN) &&
        !hasFlag(effectBattler.mon.status1, STATUS1_ANY) &&
        !isBattlerTerrainAffected(state, effectBattlerId, STATUS_FIELD_ELECTRIC_TERRAIN, deps) &&
        !isBattlerTerrainAffected(state, effectBattlerId, STATUS_FIELD_MISTY_TERRAIN, deps)
      ) {
        effectBattler.statuses3 = setCounter(effectBattler.statuses3, STATUS3_YAWN, 2)
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'YAWN' }
      }
      continue
    }

    // MOVE_EFFECT_DRENCH (battle_script_commands.c:3031-3036)
    if (baseEffectNum === MOVE_EFFECT_DRENCH) {
      if (applyDrenchEffect(state, effectBattlerId, attackerId, deps)) {
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'DRENCH' }
      }
      continue
    }

    // MOVE_EFFECT_CREEPING_THORNS / MOVE_EFFECT_STEALTH_ROCK (battle_script_commands.c:3037-3044)
    if (baseEffectNum === MOVE_EFFECT_CREEPING_THORNS || baseEffectNum === MOVE_EFFECT_STEALTH_ROCK) {
      const targetSide = targetId & 1
      const sideState = state.sides[targetSide]
      if (sideState && !hasFlag(sideState.statuses, SIDE_STATUS_STEALTH_ROCK)) {
        sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_STEALTH_ROCK)
        sideState.timers.stealthRockType = baseEffectNum === MOVE_EFFECT_CREEPING_THORNS ? 12 : 5
        statusAppliedOutcome = {
          battlerId: targetId,
          status: baseEffectNum === MOVE_EFFECT_CREEPING_THORNS ? 'CREEPING_THORNS' : 'STEALTH_ROCK',
        }
      }
      continue
    }

    // MOVE_EFFECT_SPIKES (battle_script_commands.c:3045-3050)
    if (baseEffectNum === MOVE_EFFECT_SPIKES) {
      const targetSide = targetId & 1
      const sideState = state.sides[targetSide]
      if (sideState && sideState.timers.spikesAmount < 3) {
        sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_SPIKES)
        sideState.timers.spikesAmount++
        statusAppliedOutcome = { battlerId: targetId, status: 'SPIKES' }
      }
      continue
    }

    // MOVE_EFFECT_LEECH_SEED (battle_script_commands.c:3051-3057)
    // C quirk: REQUIRE(IsMyceliumMightActive(gBattlerAttacker) || IS_BATTLER_OF_TYPE(gBattlerTarget, TYPE_GRASS))
    if (baseEffectNum === MOVE_EFFECT_LEECH_SEED) {
      if (
        !hasFlag(effectBattler.statuses3, STATUS3_LEECHSEED) &&
        (isMyceliumMightActive(state, attackerId, deps) || effectBattler.mon.types.includes('GRASS'))
      ) {
        effectBattler.statuses3 = setFlag(
          effectBattler.statuses3,
          STATUS3_LEECHSEED | (attackerId & STATUS3_LEECHSEED_BATTLER),
        )
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'LEECH_SEED' }
      }
      continue
    }

    // MOVE_EFFECT_STICKY_WEB (battle_script_commands.c:3058-3063)
    if (baseEffectNum === MOVE_EFFECT_STICKY_WEB) {
      const targetSide = targetId & 1
      const sideState = state.sides[targetSide]
      if (sideState && !hasFlag(sideState.statuses, SIDE_STATUS_STICKY_WEB)) {
        trySetStickyWeb(state, targetSide, 0, false)
        statusAppliedOutcome = { battlerId: targetId, status: 'STICKY_WEB' }
      }
      continue
    }

    const certainForStatus = spec.certain || percentChance >= 100

    // MOVE_EFFECT_DIRE_CLAW (battle_script_commands.c:2708-2713)
    if (baseEffectNum === MOVE_EFFECT_DIRE_CLAW) {
      if (effectBattler.mon.status1 === 0) {
        const direClawEffects = [MOVE_EFFECT_POISON, MOVE_EFFECT_BLEED, MOVE_EFFECT_PARALYSIS]
        const roll = state.rng.random16() % 3
        const pickedEffect = direClawEffects[roll]
        const res = applyPrimaryStatusEffect(
          state,
          attackerId,
          targetId,
          pickedEffect | (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0),
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
      continue
    }

    // MOVE_EFFECT_FEAR (battle_script_commands.c:2996-3000, battle_scripts_1.s:2444-2458)
    if (baseEffectNum === MOVE_EFFECT_FEAR) {
      if (applyFearEffect(state, effectBattlerId)) {
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'FEAR' }
      }
      continue
    }

    // MOVE_EFFECT_WATER/FIRE/GRASS_PLEDGE (battle_script_commands.c:2612-2635)
    if (
      baseEffectNum === MOVE_EFFECT_WATER_PLEDGE ||
      baseEffectNum === MOVE_EFFECT_FIRE_PLEDGE ||
      baseEffectNum === MOVE_EFFECT_GRASS_PLEDGE
    ) {
      const attackerBattler = state.battlers[attackerId]
      const attackerSide = attackerId & 1
      const targetSide = targetId & 1
      const inSun =
        isBattlerWeatherAffected(state, attackerId, WEATHER_SUN_ANY, deps) ||
        (attackerBattler ? hasChloroplast(state, attackerBattler, deps) : false)
      const inRain = isBattlerWeatherAffected(state, attackerId, WEATHER_RAIN_ANY, deps)
      const inGrassy = hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)

      if (baseEffectNum === MOVE_EFFECT_WATER_PLEDGE) {
        if (inSun && !state.sides[attackerSide].timers.rainbowTimer) {
          state.sides[attackerSide].timers.started.rainbow = true
          state.sides[attackerSide].timers.rainbowTimer = PLEDGE_DURATION
          statusAppliedOutcome = { battlerId: attackerId, status: 'RAINBOW' }
        }
        if (inGrassy && !state.sides[targetSide].timers.swampTimer) {
          state.sides[targetSide].timers.started.swamp = true
          state.sides[targetSide].timers.swampTimer = PLEDGE_DURATION
          statusAppliedOutcome = { battlerId: targetId, status: 'SWAMP' }
        }
      } else if (baseEffectNum === MOVE_EFFECT_FIRE_PLEDGE) {
        if (inRain && !state.sides[attackerSide].timers.rainbowTimer) {
          state.sides[attackerSide].timers.started.rainbow = true
          state.sides[attackerSide].timers.rainbowTimer = PLEDGE_DURATION
          statusAppliedOutcome = { battlerId: attackerId, status: 'RAINBOW' }
        }
        if (inGrassy && !state.sides[targetSide].timers.fireSeaTimer) {
          state.sides[targetSide].timers.started.fireSea = true
          state.sides[targetSide].timers.fireSeaTimer = PLEDGE_DURATION
          statusAppliedOutcome = { battlerId: targetId, status: 'FIRE_SEA' }
        }
      } else if (baseEffectNum === MOVE_EFFECT_GRASS_PLEDGE) {
        if (inSun && !state.sides[targetSide].timers.fireSeaTimer) {
          state.sides[targetSide].timers.started.fireSea = true
          state.sides[targetSide].timers.fireSeaTimer = PLEDGE_DURATION
          statusAppliedOutcome = { battlerId: targetId, status: 'FIRE_SEA' }
        }
        if (inRain && !state.sides[targetSide].timers.swampTimer) {
          state.sides[targetSide].timers.started.swamp = true
          state.sides[targetSide].timers.swampTimer = PLEDGE_DURATION
          statusAppliedOutcome = { battlerId: targetId, status: 'SWAMP' }
        }
      }
      continue
    }

    // MOVE_EFFECT_RAINBOW / SWAMP / FIRE_SEA (battle_script_commands.c:2636-2656)
    if (
      baseEffectNum === MOVE_EFFECT_RAINBOW ||
      baseEffectNum === MOVE_EFFECT_SWAMP ||
      baseEffectNum === MOVE_EFFECT_FIRE_SEA
    ) {
      const side = effectBattlerId & 1
      if (baseEffectNum === MOVE_EFFECT_RAINBOW && !state.sides[side].timers.rainbowTimer) {
        state.sides[side].timers.started.rainbow = true
        state.sides[side].timers.rainbowTimer = PLEDGE_DURATION
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'RAINBOW' }
      } else if (baseEffectNum === MOVE_EFFECT_SWAMP && !state.sides[side].timers.swampTimer) {
        state.sides[side].timers.started.swamp = true
        state.sides[side].timers.swampTimer = PLEDGE_DURATION
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'SWAMP' }
      } else if (baseEffectNum === MOVE_EFFECT_FIRE_SEA && !state.sides[side].timers.fireSeaTimer) {
        state.sides[side].timers.started.fireSea = true
        state.sides[side].timers.fireSeaTimer = PLEDGE_DURATION
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'FIRE_SEA' }
      }
      continue
    }

    // MOVE_EFFECT_GLAIVE_RUSH (battle_script_commands.c:2961-2963)
    if (baseEffectNum === MOVE_EFFECT_GLAIVE_RUSH) {
      const attacker = state.battlers[attackerId]
      if (attacker) attacker.round.glaiveRush = true
      continue
    }

    // MOVE_EFFECT_ORDER_UP (battle_script_commands.c:2595-2611)
    if (baseEffectNum === MOVE_EFFECT_ORDER_UP) {
      const partnerId = attackerId ^ 2
      const partner = state.battlers[partnerId]
      const attacker = state.battlers[attackerId]
      if (
        attacker?.mon.speciesId === 'SPECIES_DONDOZO' &&
        partner &&
        partner.mon.hp > 0 &&
        battlerHasSimAbility(state, partner, 'ABILITY_COMMANDER', false, partnerId, false, deps.dataContext)
      ) {
        let statId = STAT_ATK
        if (partner.mon.speciesId === 'SPECIES_TATSUGIRI_DROOPY') statId = STAT_DEF
        else if (partner.mon.speciesId === 'SPECIES_TATSUGIRI_STRETCHY') statId = STAT_SPEED
        const res = changeStatBuffsImplicit(
          state,
          attackerId,
          targetId,
          1,
          statId,
          MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_UPDATE_MOVE_EFFECT,
          false,
          deps,
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) statChanges.push({ battlerId: attackerId, stat: statId, change: res.delta })
      }
      continue
    }

    // MOVE_EFFECT_PSYCHIC_NOISE (battle_script_commands.c:3006-3012)
    if (baseEffectNum === MOVE_EFFECT_PSYCHIC_NOISE) {
      if (!hasFlag(effectBattler.statuses3, STATUS3_HEAL_BLOCK)) {
        effectBattler.statuses3 = setFlag(effectBattler.statuses3, STATUS3_HEAL_BLOCK)
        effectBattler.volatiles.healBlockTimer = 2
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'HEAL_BLOCK' }
      }
      continue
    }

    // MOVE_EFFECT_SALT_CURE (battle_script_commands.c:2964-2970)
    if (baseEffectNum === MOVE_EFFECT_SALT_CURE) {
      if (!hasFlag(effectBattler.statuses4, STATUS4_SALT_CURE)) {
        effectBattler.statuses4 = setFlag(effectBattler.statuses4, STATUS4_SALT_CURE)
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'SALT_CURE' }
      }
      continue
    }

    // MOVE_EFFECT_SYRUP (battle_script_commands.c:2971-2982)
    if (baseEffectNum === MOVE_EFFECT_SYRUP) {
      if (!effectBattler.volatiles.syrupTimer) {
        effectBattler.volatiles.syrupTimer = 3
        effectBattler.volatiles.syrupBombIsShiny = false
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'SYRUP' }
      }
      continue
    }

    // MOVE_EFFECT_NIGHTMARE (battle_script_commands.c:2827-2831), ported with its typo: the guard is `status2 && STATUS2_NIGHTMARE` (a
    // logical AND), so ANY nonzero status2 on the target -- confusion, a Substitute, the flinch flag -- stops the nightmare, and
    // a clean status2 is the only case that sets it.
    if (baseEffectNum === MOVE_EFFECT_NIGHTMARE) {
      if (effectBattler.mon.status2 === 0) {
        effectBattler.mon.status2 = setFlag(effectBattler.mon.status2, STATUS2_NIGHTMARE)
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'NIGHTMARE' }
      }
      continue
    }

    // MOVE_EFFECT_RECOIL_HP_25 (battle_script_commands.c:2848-2853): gBattleMoveDamage = maxHP / 4 (at least 1), applied by
    // BattleScript_MoveEffectRecoil (data/battle_scripts_1.s:9001-9009) as passive damage -- no Magic Guard / Rock Head test.
    if (baseEffectNum === MOVE_EFFECT_RECOIL_HP_25) {
      attackerSelfDamage += Math.max(1, Math.trunc(effectBattler.mon.maxHp / 4))
      continue
    }

    // MOVE_EFFECT_PAYDAY (battle_script_commands.c:2679-2691): outside player prize money (unmodelled),
    // has no effect on battle state.
    if (baseEffectNum === MOVE_EFFECT_PAYDAY) {
      continue
    }

    // MOVE_EFFECT_V_CREATE (battle_script_commands.c:2923-2925, battle_scripts_1.s:1052-1077)
    if (baseEffectNum === MOVE_EFFECT_V_CREATE) {
      const statsToDrop = [STAT_DEF, STAT_SPDEF, STAT_SPEED]
      for (const statId of statsToDrop) {
        const res = changeStatBuffsImplicit(
          state,
          attackerId,
          targetId,
          -1,
          statId,
          MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN | STAT_BUFF_NOT_PROTECT_AFFECTED,
          true,
          deps,
          unmodelled,
          moveId,
        )
        if (res.delta !== 0) {
          statChanges.push({ battlerId: attackerId, stat: statId, change: res.delta })
        }
      }
      continue
    }

    // MOVE_EFFECT_TRAP_BOTH (battle_script_commands.c:2941-2954)
    if (baseEffectNum === MOVE_EFFECT_TRAP_BOTH) {
      const targetBattler = state.battlers[targetId]
      const attackerBattler = state.battlers[attackerId]
      if (targetBattler && !hasFlag(targetBattler.mon.status2, STATUS2_ESCAPE_PREVENTION)) {
        targetBattler.volatiles.battlerPreventingEscape = attackerId
        targetBattler.mon.status2 = setFlag(targetBattler.mon.status2, STATUS2_ESCAPE_PREVENTION)
      }
      if (attackerBattler && !hasFlag(attackerBattler.mon.status2, STATUS2_ESCAPE_PREVENTION)) {
        attackerBattler.volatiles.battlerPreventingEscape = targetId
        attackerBattler.mon.status2 = setFlag(attackerBattler.mon.status2, STATUS2_ESCAPE_PREVENTION)
      }
      statusAppliedOutcome = { battlerId: targetId, status: 'ESCAPE_PREVENTION' }
      continue
    }

    // MOVE_EFFECT_FLAME_BURST (battle_script_commands.c:2872-2878)
    if (baseEffectNum === MOVE_EFFECT_FLAME_BURST) {
      // In singles battles (or when partner is absent/fainted), partner is not alive, so splash damage does not trigger.
      const partnerId = targetId ^ 2
      if (partnerId < state.battlersCount && !hasFlag(state.absentBattlerFlags, 1 << partnerId)) {
        const partner = state.battlers[partnerId]
        if (
          partner &&
          partner.mon.hp > 0 &&
          !isMagicGuardProtected(state, partner)
        ) {
          const dmg = Math.max(1, Math.floor(partner.mon.hp / 4))
          partner.mon.hp = Math.max(0, partner.mon.hp - dmg)
          syncPartyHp(state, partnerId)
          if (partner.mon.hp === 0) {
            state.sides[partnerId & 1].faintedCount++
          }
        }
      }
      continue
    }

    // MOVE_EFFECT_THROAT_CHOP (battle_script_commands.c:2931-2933)
    if (baseEffectNum === MOVE_EFFECT_THROAT_CHOP) {
      effectBattler.volatiles.throatChopTimer = 2
      statusAppliedOutcome = { battlerId: effectBattlerId, status: 'THROAT_CHOP' }
      continue
    }

    // MOVE_EFFECT_CORE_ENFORCER (battle_script_commands.c:2926-2930, battle_scripts_1.s:1027-1035, Cmd_setgastroacid :11831-11838)
    if (baseEffectNum === MOVE_EFFECT_CORE_ENFORCER) {
      const targetOrderedFirst = ctx.order
        ? ctx.order.indexOf(attackerId) > ctx.order.indexOf(targetId)
        : Boolean(ctx.targetHasActedThisTurn)
      if (
        targetOrderedFirst &&
        effectBattler.mon.hp > 0 &&
        !hasFlag(effectBattler.statuses3, STATUS3_GASTRO_ACID) &&
        !doesBattlerHaveAbilityShield(effectBattler, deps)
      ) {
        effectBattler.statuses3 = setFlag(effectBattler.statuses3, STATUS3_GASTRO_ACID)
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'GASTRO_ACID' }
      }
      continue
    }

    // MOVE_EFFECT_CLEAR_SMOG (battle_script_commands.c:2863-2871)
    if (baseEffectNum === MOVE_EFFECT_CLEAR_SMOG) {
      if ((targetDamage ?? 0) > 0) {
        for (let i = 0; i < NUM_BATTLE_STATS; i++) {
          const currentStage = effectBattler.mon.statStages[i] ?? DEFAULT_STAT_STAGE
          if (currentStage !== DEFAULT_STAT_STAGE) {
            effectBattler.mon.statStages[i] = DEFAULT_STAT_STAGE
            statChanges.push({ battlerId: effectBattlerId, stat: i, change: DEFAULT_STAT_STAGE - currentStage })
          }
        }
      }
      continue
    }

    // MOVE_EFFECT_SPECTRAL_THIEF (battle_script_commands.c:2892-2922, 6892-6909)
    if (baseEffectNum === MOVE_EFFECT_SPECTRAL_THIEF) {
      const attackerBattler = state.battlers[attackerId]
      if (attackerBattler) {
        for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
          const targetStage = effectBattler.mon.statStages[i] ?? DEFAULT_STAT_STAGE
          const attackerStage = attackerBattler.mon.statStages[i] ?? DEFAULT_STAT_STAGE
          if (targetStage > DEFAULT_STAT_STAGE && attackerStage < MAX_STAT_STAGE) {
            let stealAmount = targetStage - DEFAULT_STAT_STAGE
            if (attackerStage + stealAmount > MAX_STAT_STAGE) {
              stealAmount = MAX_STAT_STAGE - attackerStage
            }
            effectBattler.mon.statStages[i] = DEFAULT_STAT_STAGE
            statChanges.push({ battlerId: effectBattlerId, stat: i, change: DEFAULT_STAT_STAGE - targetStage })
            attackerBattler.mon.statStages[i] = attackerStage + stealAmount
            statChanges.push({ battlerId: attackerId, stat: i, change: stealAmount })
          }
        }
      }
      continue
    }

    // MOVE_EFFECT_FEINT (battle_script_commands.c:2879-2891, IS_BATTLER_PROTECTED include/battle.h:762-764)
    if (baseEffectNum === MOVE_EFFECT_FEINT) {
      const targetSide = effectBattlerId & 1
      const isProtected =
        Boolean(effectBattler.round.protectMove) ||
        Boolean(
          state.sides[targetSide].statuses &
            (SIDE_STATUS_WIDE_GUARD | SIDE_STATUS_CRAFTY_SHIELD | SIDE_STATUS_MAT_BLOCK),
        )
      if (isProtected) {
        effectBattler.round.protectMove = null
        state.sides[targetSide].statuses = clearFlag(
          state.sides[targetSide].statuses,
          SIDE_STATUS_WIDE_GUARD | SIDE_STATUS_CRAFTY_SHIELD | SIDE_STATUS_MAT_BLOCK,
        )
      }
      continue
    }

    // MOVE_EFFECT_INCINERATE (battle_script_commands.c:2934-2940)
    if (baseEffectNum === MOVE_EFFECT_INCINERATE) {
      const targetItem = effectBattler.mon.itemId
      const isBerry = !!targetItem && deps.dataContext.item(targetItem)?.grouping === 'POCKET_BERRIES'
      const isGem = !!targetItem && (deps.grounding ? deps.grounding.holdEffectOf(effectBattlerId) === 'HOLD_EFFECT_GEMS' : false)
      if (isBerry || isGem) {
        effectBattler.mon.itemId = null
        statusAppliedOutcome = { battlerId: effectBattlerId, status: 'INCINERATE' }
      }
      continue
    }

    // Primary status effects and confusion (battle_script_commands.c:2390-2580, 2655-2664)
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
    ...(attackerSelfDamage > 0 ? { attackerDamage: attackerSelfDamage } : {}),
  }
}
