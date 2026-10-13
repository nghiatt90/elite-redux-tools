/**
 * Absorb abilities' side effects (heal / stat boost on an absorbed hit).
 * Ported from Elite Redux upstream C:
 * - ABILITYEFFECT_ABSORBING (src/battle_util.c:4422-4484)
 * - TestAbsorbingAbilities (src/battle_util.c:8935-8942)
 * - JumpIfMoveFailed (src/battle_script_commands.c:1212-1228)
 * - Cmd_accuracycheck (src/battle_script_commands.c:1398-1447)
 * - CanBattlerHeal (src/battle_util.c:8979-8986)
 * - CanRaiseStat (src/battle_util.c:9364)
 * - GetHighestAttackingStatId (src/battle_util.c:8748-8767)
 * - ChangeStatBuffs (src/battle_script_commands.c:9713-9946)
 */

import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_MIST,
  STAT_DEF,
  STAT_SPEED,
  setFlag,
} from './constants'
import type { SimDataContext } from './dataContext'
import { canBattlerHeal } from './endTurn'
import type { GroundingContext } from './grounding'
import { syncPartyHp } from './outcome'
import { battlerHasSimAbility, changeStatBuffs, getHighestAttackingStatId, MOVE_EFFECT_AFFECTS_USER } from './statBuffs'
import type { BattleState } from './state'
import type { StatChangeOutcome } from './turn'

/** Upstream C flags (include/battle_util.h:411-414). */
export const ABSORB_RESULT_HEAL = 1 << 0
export const ABSORB_RESULT_STAT = 1 << 1
export const ABSORB_RESULT_FLASH_FIRE = 1 << 2
export const ABSORB_RESULT_EVAPORATE = 1 << 3

/**
 * Abilities that heal 1/4 max HP on absorption (ABSORB_RESULT_HEAL, src/battle_util.c:4437-4444).
 * Verified against src/abilities.cc.
 */
export const HEAL_ABSORB_ABILITIES = new Set<string>([
  'ABILITY_VOLT_ABSORB', // src/abilities.cc:624-631
  'ABILITY_WATER_ABSORB', // src/abilities.cc:633-640
  'ABILITY_DRY_SKIN', // src/abilities.cc:1496-1510 (Impl<ABILITY_WATER_ABSORB>.onAbsorb)
  'ABILITY_POISON_ABSORB', // src/abilities.cc:4432-4437
  'ABILITY_EARTH_EATER', // src/abilities.cc:5816-5823
  'ABILITY_FIRE_ASPECT', // src/abilities.cc:10499-10504
  'ABILITY_RESERVOIR', // src/abilities.cc:9220-9229 (ABSORB_RESULT_STAT | ABSORB_RESULT_HEAL)
])

/**
 * Abilities that boost stat by +1 or +2 stages on absorption (ABSORB_RESULT_STAT, src/battle_util.c:4446-4452).
 * Verified against src/abilities.cc.
 */
export const STAT_ABSORB_ABILITIES = new Set<string>([
  'ABILITY_LIGHTNING_ROD', // src/abilities.cc:879-888 (highest attacking, +1)
  'ABILITY_MOTOR_DRIVE', // src/abilities.cc:1417-1425 (Speed, +1)
  'ABILITY_STORM_DRAIN', // src/abilities.cc:1766-1775 (highest attacking, +1)
  'ABILITY_JUSTIFIED', // src/abilities.cc:2203-2210 (highest attacking, +1)
  'ABILITY_SAP_SIPPER', // src/abilities.cc:2232-2241 (highest attacking, +1)
  'ABILITY_AERODYNAMICS', // src/abilities.cc:3776-3784 (Speed, +1)
  'ABILITY_ICE_DEW', // src/abilities.cc:4809-4818 (highest attacking, +1)
  'ABILITY_WELL_BAKED_BODY', // src/abilities.cc:5775-5784 (Defense, +2, absorbUp2)
  'ABILITY_WIND_RIDER', // src/abilities.cc:6266-6281 (highest attacking, +1)
  'ABILITY_RESERVOIR', // src/abilities.cc:9220-9229 (highest attacking, +1)
  'ABILITY_HEAT_SINK', // src/abilities.cc:10467-10476 (highest attacking, +1)
  'ABILITY_LIGHTNING_ASPECT', // src/abilities.cc:10489-10497 (highest attacking, +1)
  'ABILITY_MOLTEN_CORE', // src/abilities.cc:10644-10653 (Speed, +2, absorbUp2)
])

/** Stat absorb abilities that boost Speed. */
export const SPEED_ABSORB_ABILITIES = new Set<string>([
  'ABILITY_MOTOR_DRIVE',
  'ABILITY_AERODYNAMICS',
  'ABILITY_MOLTEN_CORE',
])

/** Stat absorb abilities that boost by 2 stages instead of 1 (absorbUp2, src/battle_util.c:4449-4450). */
export const ABSORB_UP2_ABILITIES = new Set<string>([
  'ABILITY_WELL_BAKED_BODY',
  'ABILITY_MOLTEN_CORE',
])

export interface ApplyAbsorbContext {
  state: BattleState
  attackerId: number
  targetId: number
  absorbingAbility: string
  moveId: string
  deps: {
    statStageRatios: [number, number][]
    dataContext: SimDataContext
    grounding?: GroundingContext
  }
  unmodelled: string[]
}

export interface AbsorbOutcome {
  healed: number
  statChanges: StatChangeOutcome[]
  flashFireActivated: boolean
  mistActivated: boolean
}

/**
 * Applies the absorb ability effect at the C's point (battle_util.c:4437-4475).
 * - Heals 1/4 max HP if ABSORB_RESULT_HEAL, target not at max HP, and CanBattlerHeal.
 * - Raises stat by 1 or 2 stages if ABSORB_RESULT_STAT and CanRaiseStat.
 * - Sets flashFire volatile flag if ABSORB_RESULT_FLASH_FIRE.
 * - Sets Mist on target's side if ABSORB_RESULT_EVAPORATE and mistTimer is 0.
 */
export function applyAbsorbEffect(ctx: ApplyAbsorbContext): AbsorbOutcome {
  const { state, attackerId, targetId, absorbingAbility, moveId, deps, unmodelled } = ctx
  const target = state.battlers[targetId]
  if (!target) {
    return { healed: 0, statChanges: [], flashFireActivated: false, mistActivated: false }
  }

  const statChanges: StatChangeOutcome[] = []
  let healed = 0
  let flashFireActivated = false
  let mistActivated = false

  // Determine which ABSORB_RESULT_* bits apply.
  let effectFlags = 0

  if (absorbingAbility === 'ABILITY_ELEMENTAL_VORTEX') {
    // src/abilities.cc:8289: Water Absorb (heal) or Flash Fire (boost flag)
    const moveData = deps.dataContext.move(moveId)
    const rawType = moveData?.type ?? 'NORMAL'
    const cleanType = rawType.startsWith('TYPE_') ? rawType.slice(5) : rawType
    if (cleanType === 'WATER') {
      effectFlags |= ABSORB_RESULT_HEAL
    } else if (cleanType === 'FIRE') {
      effectFlags |= ABSORB_RESULT_FLASH_FIRE
    }
  } else {
    if (HEAL_ABSORB_ABILITIES.has(absorbingAbility)) {
      effectFlags |= ABSORB_RESULT_HEAL
    }
    if (STAT_ABSORB_ABILITIES.has(absorbingAbility)) {
      effectFlags |= ABSORB_RESULT_STAT
    }
    if (absorbingAbility === 'ABILITY_FLASH_FIRE') {
      effectFlags |= ABSORB_RESULT_FLASH_FIRE
    }
    if (absorbingAbility === 'ABILITY_EVAPORATE') {
      effectFlags |= ABSORB_RESULT_EVAPORATE
    }
  }

  // 1. ABSORB_RESULT_HEAL (src/battle_util.c:4437-4444)
  // if (effect & ABSORB_RESULT_HEAL && !BATTLER_MAX_HP(battler) && CanBattlerHeal(battler))
  if ((effectFlags & ABSORB_RESULT_HEAL) !== 0) {
    if (target.mon.hp < target.mon.maxHp && canBattlerHeal(state, targetId, target, unmodelled)) {
      const healAmount = Math.max(1, Math.floor(target.mon.maxHp / 4))
      const oldHp = target.mon.hp
      target.mon.hp = Math.min(target.mon.maxHp, target.mon.hp + healAmount)
      healed = target.mon.hp - oldHp
      syncPartyHp(state, targetId)
    }
  }

  // 2. ABSORB_RESULT_STAT (src/battle_util.c:4446-4452)
  // if (effect & ABSORB_RESULT_STAT && CanRaiseStat(battler, statId))
  if ((effectFlags & ABSORB_RESULT_STAT) !== 0) {
    let statId: number
    if (SPEED_ABSORB_ABILITIES.has(absorbingAbility)) {
      statId = STAT_SPEED
    } else if (absorbingAbility === 'ABILITY_WELL_BAKED_BODY') {
      statId = STAT_DEF
    } else {
      // Lightning Rod, Storm Drain, Sap Sipper, Justified, Ice Dew, Wind Rider, Heat Sink, Lightning Aspect, Reservoir
      statId = getHighestAttackingStatId(state, targetId, deps.statStageRatios)
    }

    const currentStage = target.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
    // CanRaiseStat (src/battle_util.c:9364) -> CompareStat(battler, stat, MAX_STAT_STAGE, CMP_LESS_THAN), which
    // Contrary inverts to `stage > MIN_STAT_STAGE` (:8545-8561).
    const contrary = battlerHasSimAbility(state, target, 'ABILITY_CONTRARY', true, targetId, false, deps.dataContext)
    if (contrary ? currentStage > MIN_STAT_STAGE : currentStage < MAX_STAT_STAGE) {
      const stageIncrease = ABSORB_UP2_ABILITIES.has(absorbingAbility) ? 2 : 1
      const res = changeStatBuffs(
        state,
        targetId,
        attackerId,
        targetId,
        stageIncrease,
        statId,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        deps,
        unmodelled,
        moveId,
      )
      if (res.delta !== 0) {
        statChanges.push({ battlerId: targetId, stat: statId, change: res.delta })
      }
    }
  }

  // 3. ABSORB_RESULT_FLASH_FIRE (src/battle_util.c:4454-4464)
  // gBattleResources->flags->flags[battler] |= RESOURCE_FLAG_FLASH_FIRE;
  if ((effectFlags & ABSORB_RESULT_FLASH_FIRE) !== 0) {
    target.volatiles.flashFire = true
    flashFireActivated = true
  }

  // 4. ABSORB_RESULT_EVAPORATE (src/battle_util.c:4466-4474)
  // if (effect & ABSORB_RESULT_EVAPORATE && !gSideTimers[GetBattlerSide(battler)].mistTimer)
  if ((effectFlags & ABSORB_RESULT_EVAPORATE) !== 0) {
    const side = targetId & 1
    const sideState = state.sides[side]
    if (sideState && !sideState.timers.mistTimer) {
      sideState.statuses = setFlag(sideState.statuses, SIDE_STATUS_MIST)
      sideState.timers.mistTimer = 5
      sideState.timers.started.mist = true
      sideState.timers.mistBattlerId = targetId
      mistActivated = true
    }
  }

  return { healed, statChanges, flashFireActivated, mistActivated }
}
