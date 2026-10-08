// Move effect dispatch and status move handlers.
//
// A handled effect's handler owns the execution of its script after attackcanceler.
// Status setup moves (e.g. Swords Dance, Belly Drum) do not roll accuracy in the C,
// deduct PP after attackcanceler, and apply stat changes/HP modifications directly.

import type { BattleState, BattlerState } from './state'
import type { ChosenAction, TurnOrder } from './turnOrder'
import type { ActionOutcome, StatChangeOutcome, StatusAppliedOutcome, TurnLoopDeps } from './turn'
import { buildAccuracyInputs, getTotalAccuracy } from './turn'
import { gapsToUnmodelled } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_SAFEGUARD,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_ANY,
  STATUS2_ENRAGED,
  STATUS3_YAWN,
  STATUS4_CUTTHROAT,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  WEATHER_SUN_ANY,
  hasFlag,
  setCounter,
  setFlag,
} from './constants'
import {
  MOVE_EFFECT_AFFECTS_USER,
  MOVE_EFFECT_CERTAIN,
  STAT_BUFF_ALLOW_PTR,
  battlerHasSimAbility,
  changeStatBuffs,
  changeStatBuffsImplicit,
  getHighestAttackingStatId,
  isBattlerWeatherAffected,
} from './statBuffs'
import type { SimDataContext } from './dataContext'
import {
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_SLEEP,
  MOVE_EFFECT_TOXIC,
  applyPrimaryStatusEffect,
  canBeBurned,
  canBePoisoned,
  canSleep,
  doesSubstituteBlockMove,
  findAbilitySlot,
  isBattlerTerrainAffected,
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

const HANDLERS: Record<string, MoveEffectHandler> = {
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
}

export function getMoveEffectHandler(effect: string | null): MoveEffectHandler | null {
  if (!effect) return null
  return HANDLERS[effect] ?? null
}

export function isHandledMoveEffect(effect: string | null): boolean {
  return getMoveEffectHandler(effect) !== null
}
