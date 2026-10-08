// Move effect dispatch and status move handlers.
//
// A handled effect's handler owns the execution of its script after attackcanceler.
// Status setup moves (e.g. Swords Dance, Belly Drum) do not roll accuracy in the C,
// deduct PP after attackcanceler, and apply stat changes/HP modifications directly.

import type { BattleState, BattlerState } from './state'
import type { ChosenAction, TurnOrder } from './turnOrder'
import type { ActionOutcome, StatChangeOutcome, StatusAppliedOutcome, TurnLoopDeps } from './turn'
import { buildAccuracyInputs, getTotalAccuracy, isBattlerProtected, ProtectType } from './turn'
import { gapsToUnmodelled } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_CRAFTY_SHIELD,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_MIST,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
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
  STATUS2_ENRAGED,
  STATUS2_FLINCHED,
  STATUS3_ALWAYS_HITS,
  STATUS3_LEECHSEED,
  STATUS3_SEMI_INVULNERABLE,
  STATUS3_YAWN,
  STATUS4_CUTTHROAT,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  WEATHER_FOG_ANY,
  WEATHER_FOG_TEMPORARY,
  WEATHER_HAIL_ANY,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_PRIMAL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_RAIN_PERMANENT,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_ANY,
  WEATHER_SUN_PERMANENT,
  WEATHER_SUN_TEMPORARY,
  clearFlag,
  hasFlag,
  setCounter,
  setFlag,
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
  battlerHasSimAbility,
  benefitsFromStatBuffs,
  changeStatBuffs,
  changeStatBuffsImplicit,
  getHighestAttackingStatId,
  isBattlerWeatherAffected,
} from './statBuffs'
import { canBattlerHeal } from './endTurn'
import { weatherHasEffect } from './fieldEndTurn'
import { syncPartyHp } from './outcome'
import { attackPreModify, calculateBattleStat } from '../battleStat'
import type { SimDataContext } from './dataContext'
import type { MoveBehaviors } from '../basePower'
import {
  CHECK_FLINCH,
  MOVE_EFFECT_BLEED,
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_CONFUSION,
  MOVE_EFFECT_FLINCH,
  MOVE_EFFECT_FREEZE,
  MOVE_EFFECT_FROSTBITE,
  MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_POISON,
  MOVE_EFFECT_SLEEP,
  MOVE_EFFECT_TOXIC,
  MOVE_EFFECT_TRI_ATTACK,
  applyPrimaryStatusEffect,
  canBeBurned,
  canBePoisoned,
  canSleep,
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

/** The `jumpifhealingblocked` macro (asm/macros/battle_script.inc:2493-2510):
 * CanBattlerHeal (battle_util.c:8979-8986) minus its STATUS1_BLEED clause. */
function isHealingBlocked(state: BattleState, battlerId: number, battler: BattlerState, unmodelled: string[]): boolean {
  const status1 = battler.mon.status1
  battler.mon.status1 = clearFlag(status1, STATUS1_BLEED)
  const blocked = !canBattlerHeal(state, battlerId, battler, unmodelled)
  battler.mon.status1 = status1
  return blocked
}

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
    unmodelled.push(
      "Cmd_setroost (battle_script_commands.c:4022-4047): Roost's temporary Flying-type removal and RESOURCE_FLAG_ROOST are not modelled",
    )
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
  const { state, battlerId, action, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  const side = battlerId & 1
  const sideState = state.sides[side]!

  if (hasFlag(sideState.statuses, SIDE_STATUS_TAILWIND)) {
    return outcome(ctx, {})
  }

  sideState.timers.started.tailwind = true
  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_TAILWIND)
  sideState.timers.tailwindBattlerId = battlerId
  sideState.timers.tailwindTimer = 3

  unmodelled.push(
    'BattleScript_OnTailwindStart (data/battle_scripts_1.s:9267-9296): Wind Rider and Wind Power reactions are not modelled',
  )

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
  const sideState = state.sides[targetSide]!

  if (hasFlag(sideState.statuses, SIDE_STATUS_STICKY_WEB)) {
    return outcome(ctx, {})
  }

  sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_STICKY_WEB)
  sideState.timers.stickyWebTimer = 0

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
export const WEATHER_DURATION = 8
export const WEATHER_DURATION_EXTENDED = 12

/**
 * Common implementation for weather moves:
 * - Macro checkprimalweather (battle_script.inc:2511-2526): fails if gBattleWeather has WEATHER_PRIMAL_ANY.
 * - Cmd_various VARIOUS_SET_WEATHER (src/battle_script_commands.c:8634-8644).
 * - TryChangeBattleWeather (src/battle_util.c:3721-3743):
 *   - Fails if WEATHER_PRIMAL_ANY is active (:3725-3727).
 *   - Fails if !WEATHER_HAS_EFFECT (:3728-3730, include/battle_util.h:45-46, fieldEndTurn.ts:390-396).
 *   - Fails if already active (gBattleWeather & (sWeatherFlagsInfo[weather][0] | sWeatherFlagsInfo[weather][1])) (:3731).
 *   - Sets gBattleWeather = sWeatherFlagsInfo[weather][0] (:3732).
 *   - Sets gFieldTimers.started.weather = TRUE (:3733).
 *   - Sets gWishFutureKnock.weatherDuration to WEATHER_DURATION_EXTENDED (12) if GetBattlerHoldEffect matches,
 *     else WEATHER_DURATION (8) (:3734-3737, include/battle_util.h:50-51).
 * - VARIOUS_ON_WEATHER_CHANGE (src/battle_script_commands.c:8183-8190) / BattleScript_OnWeatherChange
 *   (data/battle_scripts_1.s:9833-9841): gaps onWeather ability hook.
 */
function applyWeatherMove(
  ctx: MoveEffectContext,
  weatherFlag: number,
  existingWeatherMask: number,
  extendingHoldEffect: string,
  scriptCitation: string,
): ActionOutcome {
  const { state, battlerId, action, deps, unmodelled, deductPp } = ctx
  const moveId = action.chosenMove!.id
  const moveEffect = action.chosenMove!.effect
  deductPp(state, battlerId, moveId, moveEffect, unmodelled)

  // checkprimalweather (battle_script.inc:2511-2526) & TryChangeBattleWeather (src/battle_util.c:3725-3727)
  if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
    return outcome(ctx, {})
  }

  // TryChangeBattleWeather: !WEATHER_HAS_EFFECT check (src/battle_util.c:3728-3730)
  if (!weatherHasEffect(state, deps.grounding)) {
    return outcome(ctx, {})
  }

  // TryChangeBattleWeather: already-active check (src/battle_util.c:3731)
  if (hasFlag(state.field.weather, existingWeatherMask)) {
    return outcome(ctx, {})
  }

  // Set weather & started flag (src/battle_util.c:3732-3733)
  state.field.weather = weatherFlag
  state.field.timers.started.weather = true

  // Set weather duration with extending hold effect (src/battle_util.c:3734-3737)
  const isExtended = getHoldEffect(ctx, battlerId) === extendingHoldEffect
  state.field.weatherDuration = isExtended ? WEATHER_DURATION_EXTENDED : WEATHER_DURATION

  unmodelled.push(
    `BattleScript_OnWeatherChange (data/battle_scripts_1.s:9833-9841) / VARIOUS_ON_WEATHER_CHANGE (src/battle_script_commands.c:8183-8190): onWeather ability reactions are not modelled (${scriptCitation})`,
  )

  return outcome(ctx, {})
}

/**
 * BattleScript_EffectRainDance (data/battle_scripts_1.s:5505-5511),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_RAIN (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleRainDance(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(
    ctx,
    WEATHER_RAIN_TEMPORARY,
    WEATHER_RAIN_TEMPORARY | WEATHER_RAIN_PERMANENT,
    'HOLD_EFFECT_DAMP_ROCK',
    'BattleScript_EffectRainDance',
  )
}

/**
 * BattleScript_EffectSunnyDay (data/battle_scripts_1.s:5520-5527),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_SUN (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleSunnyDay(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(
    ctx,
    WEATHER_SUN_TEMPORARY,
    WEATHER_SUN_TEMPORARY | WEATHER_SUN_PERMANENT,
    'HOLD_EFFECT_HEAT_ROCK',
    'BattleScript_EffectSunnyDay',
  )
}

/**
 * BattleScript_EffectSandstorm (data/battle_scripts_1.s:5117-5123),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_SANDSTORM (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleSandstorm(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(
    ctx,
    WEATHER_SANDSTORM_TEMPORARY,
    WEATHER_SANDSTORM_ANY,
    'HOLD_EFFECT_SMOOTH_ROCK',
    'BattleScript_EffectSandstorm',
  )
}

/**
 * BattleScript_EffectHail (data/battle_scripts_1.s:6048-6055),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_HAIL (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleHail(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(
    ctx,
    WEATHER_HAIL_TEMPORARY,
    WEATHER_HAIL_ANY,
    'HOLD_EFFECT_ICY_ROCK',
    'BattleScript_EffectHail',
  )
}

/**
 * BattleScript_EffectEerieFog (data/battle_scripts_1.s:12406-12413),
 * checkprimalweather (battle_script.inc:2511-2526),
 * setbattleweather ENUM_WEATHER_FOG (battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER: src/battle_script_commands.c:8634-8644),
 * and TryChangeBattleWeather (src/battle_util.c:3721-3743).
 */
function handleEerieFog(ctx: MoveEffectContext): ActionOutcome {
  return applyWeatherMove(
    ctx,
    WEATHER_FOG_TEMPORARY,
    WEATHER_FOG_ANY,
    'HOLD_EFFECT_SMOKE_BALL',
    'BattleScript_EffectEerieFog',
  )
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

  EFFECT_BULK_UP: handleBulkUp,
  EFFECT_CALM_MIND: handleCalmMind,
  EFFECT_DRAGON_DANCE: handleDragonDance,
  EFFECT_QUIVER_DANCE: handleQuiverDance,
  EFFECT_VICTORY_DANCE: handleVictoryDance,
  EFFECT_MYSTIC_DANCE: handleMysticDance,
  EFFECT_GROWTH: handleGrowth,
  EFFECT_SHARPEN: handleSharpen,
  EFFECT_SHELTER: handleShelter,
  EFFECT_SHELL_SMASH: handleShellSmash,
  EFFECT_BELLY_DRUM: handleBellyDrum,

  EFFECT_SLEEP: handleSleep,
  EFFECT_TOXIC: handleToxic,
  EFFECT_WILL_O_WISP: handleWillOWisp,
  EFFECT_YAWN: handleYawn,
  EFFECT_SWAGGER: handleSwagger,

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

export interface SecondaryEffectsResult {
  statusApplied: StatusAppliedOutcome | null
  statChanges: StatChangeOutcome[]
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

  for (const spec of effectSpecs) {
    const baseEffectNum = SECONDARY_MOVE_EFFECT_MAP[spec.effectName]
    if (baseEffectNum === undefined) {
      unmodelled.push(`secondary effect of ${spec.effectName} not modelled`)
      continue
    }

    const effectNumWithFlags =
      baseEffectNum |
      (spec.affectsUser ? MOVE_EFFECT_AFFECTS_USER : 0) |
      (spec.certain ? MOVE_EFFECT_CERTAIN : 0)

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
  }
}
