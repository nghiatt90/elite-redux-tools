// Port of src/battle_events.c (543 lines) and associated battle scripts.
// Gym battle events / boss skills registered before and during battle.

import type { BattleEventEntry, BattleState } from './state'
import {
  BATTLE_EVENTS_MAX_REGISTERABLE,
  DEFAULT_STAT_STAGE,
  EXEC_BATTLE_EVENTS_ALL_CLEAR,
  EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL,
  MAX_STAT_STAGE,
  NUM_BATTLE_STATS,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_LUCKY_CHANT,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TOXIC_SPIKES,
  SIDE_STATUS_WIDE_GUARD,
  BATTLE_TYPE_DOUBLE,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_NONE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_POISON,
  STATUS2_NIGHTMARE,
  STATUS2_SUBSTITUTE,
  STATUS2_WRAPPED,
  STATUS3_EMBARGO,
  STATUS3_HEAL_BLOCK,
  STATUS3_LEECHSEED,
  STATUS3_MAGNET_RISE,
  STATUS4_FORESIGHT,
  clearFlag,
  hasFlag,
  setFlag,
} from './constants'
import { TYPE_ROCK_ID } from './hazards'
import { MOVE_EFFECT_AFFECTS_USER, STAT_BUFF_ALLOW_PTR, changeStatBuffs } from './statBuffs'
import type { SimDataContext } from './dataContext'
import type { GroundingContext } from './grounding'

export interface BattleEventDeps {
  dataContext?: SimDataContext
  grounding?: GroundingContext
}

/**
 * RegisterBattleEvent (src/battle_events.c:27-40).
 * Appends a battle event if under BATTLE_EVENTS_MAX_REGISTERABLE limit.
 * Bitmasks data0 and data1 with 0xF.
 */
export function registerBattleEvent(
  state: BattleState,
  battleEventId: string,
  battleEventData0: number = 0,
  battleEventData1: number = 0,
): void {
  if (state.battleEvents.length >= BATTLE_EVENTS_MAX_REGISTERABLE) {
    return
  }
  state.battleEvents.push({
    id: battleEventId,
    data0: (battleEventData0 ?? 0) & 0xf,
    data1: (battleEventData1 ?? 0) & 0xf,
  })
}

/**
 * UnregisterBattlesEvents (src/battle_events.c:43-46).
 * Clears all battle events and resets cursor.
 */
export function unregisterBattlesEvents(state: BattleState): void {
  state.battleEvents = []
  state.currentBattleEvent = 0
}

/**
 * UnregisterCurrentBattleEvent (src/battle_events.c:54-58).
 * Swap-removes current event with last element and steps cursor back.
 * gBattleEvents[gCurrBattleEvent--] = gBattleEvents[--gNbBattleEvents];
 */
export function unregisterCurrentBattleEvent(state: BattleState): void {
  const lastIndex = state.battleEvents.length - 1
  if (lastIndex < 0) return
  const last = state.battleEvents.pop()!
  if (state.currentBattleEvent < lastIndex) {
    state.battleEvents[state.currentBattleEvent] = last
  }
  state.currentBattleEvent--
}

/**
 * sOnSwitchInForbiddenBattleEvent (src/battle_events.c:116-124).
 * Battle events that cannot trigger on switch-in turn (isFirstTurn == 1).
 */
export const ON_SWITCH_IN_FORBIDDEN_BATTLE_EVENTS = new Set([
  'BATTLE_EVENT_STEADY_OFFENSE',
  'BATTLE_EVENT_STEADY_DEFENSE',
  'BATTLE_EVENT_STEADY_SPECIAL',
  'BATTLE_EVENT_STEADY_SPDEF',
  'BATTLE_EVENT_STEADY_SPEED',
  'BATTLE_EVENT_STEADY_ACCURACY',
  'BATTLE_EVENT_STEADY_CRIT',
])

/**
 * IsBattleEventForbiddenOnSwitchIn (src/battle_events.c:126-132).
 */
export function isBattleEventForbiddenOnSwitchIn(battleEventId: string): boolean {
  return ON_SWITCH_IN_FORBIDDEN_BATTLE_EVENTS.has(battleEventId)
}

/**
 * AffectNStatusOnTeamFromLastToFirst (src/battle_events.c:134-145).
 * Iterates player party from last slot down to slot 1 (excluding active lead at 0).
 * Sets status on slots with STATUS1_NONE until n slots are affected.
 */
export function affectNStatusOnTeamFromLastToFirst(
  state: BattleState,
  status: number,
  n: number,
): boolean {
  if (n === 0) n = 1
  for (let i = state.sides[0].party.length - 1; i > 0; i--) {
    const mon = state.sides[0].party[i]
    if (mon && mon.status1 === STATUS1_NONE) {
      mon.status1 = status
      if (--n === 0) return true
    }
  }
  return false
}

/**
 * HasNumberOfTurnsStayedReached (src/battle_events.c:148-155).
 * If battler's isFirstTurn is active, resets data1 to 0; else increments data1.
 * Returns true if data1 >= data0.
 */
export function hasNumberOfTurnsStayedReached(
  state: BattleState,
  battleEvent: BattleEventEntry,
  pos: number,
): boolean {
  const battler = state.battlers[pos]
  if (battler && battler.volatiles.isFirstTurn !== 0) {
    battleEvent.data1 = 0
  } else {
    battleEvent.data1 = (battleEvent.data1 + 1) & 0xf
  }
  return battleEvent.data1 >= battleEvent.data0
}

/**
 * SetSubstituteBattleEvent (src/battle_events.c:157-165).
 * Sets Substitute with max(1, floor(maxHp / 4)) on attacker battler (default opponent left = 1).
 */
export function setSubstituteBattleEvent(state: BattleState, battlerId: number = 1): void {
  const battler = state.battlers[battlerId]
  if (!battler) return
  const hp = Math.max(1, Math.floor(battler.mon.maxHp / 4))
  battler.mon.status2 = setFlag(battler.mon.status2, STATUS2_SUBSTITUTE)
  battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_WRAPPED)
  battler.volatiles.substituteHp = hp
}

/**
 * DepleteTeamPowerPointOfMove (src/battle_events.c:167-185).
 * Depletes PP of the specified move across all player party mons and active battlers.
 */
export function depleteTeamPowerPointOfMove(state: BattleState, moveId: string): boolean {
  let hasBeenModified = false
  for (let i = 0; i < state.sides[0].party.length; i++) {
    const partyMon = state.sides[0].party[i]
    if (!partyMon) continue
    for (let j = 0; j < partyMon.moves.length; j++) {
      if (partyMon.moves[j] === moveId) {
        partyMon.pp[j] = 0
        if (i === 0 && state.battlers[0]) {
          state.battlers[0].mon.pp[j] = 0
        }
        if (i === 1 && state.battlers[2]) {
          state.battlers[2].mon.pp[j] = 0
        }
        hasBeenModified = true
      }
    }
  }
  return hasBeenModified
}

type ExtraStatField =
  | 'extraAttackLevel'
  | 'extraDefenseLevel'
  | 'extraSpAttackLevel'
  | 'extraSpDefenseLevel'
  | 'extraSpeedLevel'

/**
 * SET_EXTRA_STATS_LEVEL macro (src/battle_events.c:188-191).
 * Adds level to opponent left (battler 1), and right (battler 3) if double battle & alive.
 */
function setExtraStatsLevel(state: BattleState, stat: ExtraStatField, level: number): void {
  const left = state.battlers[1]
  if (left) {
    left.volatiles[stat] += level
  }
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_DOUBLE)) {
    const right = state.battlers[3]
    if (right && right.mon.hp > 0) {
      right.volatiles[stat] += level
    }
  }
}

/**
 * SET_STATS_STAGE_LEVEL macro (src/battle_events.c:192-195).
 * Sets statStages to DEFAULT_STAT_STAGE + level for opponent left (1), and right (3) if double.
 */
function setStatsStageLevel(state: BattleState, statId: number, level: number): void {
  const left = state.battlers[1]
  if (left) {
    left.mon.statStages[statId] = DEFAULT_STAT_STAGE + level
  }
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_DOUBLE)) {
    const right = state.battlers[3]
    if (right && right.mon.hp > 0) {
      right.mon.statStages[statId] = DEFAULT_STAT_STAGE + level
    }
  }
}

/**
 * Applies Steady stat change to opponent lead (battler 1).
 * Mirrors BattleScript_ExtraSkillSteady<Stat> (data/battle_scripts_1.s:12116-12146).
 */
function applySteadyStatChange(
  state: BattleState,
  statId: number,
  deps?: BattleEventDeps,
  unmodelled: string[] = [],
): void {
  const opp = state.battlers[1]
  if (!opp || opp.mon.hp === 0) return
  if (deps?.dataContext) {
    changeStatBuffs(
      state,
      1,
      1,
      0,
      1,
      statId,
      MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
      true,
      { dataContext: deps.dataContext, grounding: deps.grounding },
      unmodelled,
    )
  } else {
    opp.mon.statStages[statId] = Math.min(MAX_STAT_STAGE, (opp.mon.statStages[statId] ?? DEFAULT_STAT_STAGE) + 1)
  }
}

/**
 * BattleEventBeforeFirstTurnExec (src/battle_events.c:197-363).
 * Executed when battleTurnCounter == 0.
 */
export function battleEventBeforeFirstTurnExec(
  state: BattleState,
  event: BattleEventEntry,
  _deps?: BattleEventDeps,
  _unmodelled: string[] = [],
): number {
  switch (event.id) {
    case 'BATTLE_EVENT_NONE':
      break

    case 'BATTLE_EVENT_POSTURE_OFFENSE':
      if (event.data0 === 0) event.data0 = 4
      setExtraStatsLevel(state, 'extraAttackLevel', event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_POSTURE_DEFENSE':
      if (event.data0 === 0) event.data0 = 4
      setExtraStatsLevel(state, 'extraDefenseLevel', event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_POSTURE_SPECIAL':
      if (event.data0 === 0) event.data0 = 4
      setExtraStatsLevel(state, 'extraSpAttackLevel', event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_POSTURE_SPDEF':
      if (event.data0 === 0) event.data0 = 4
      setExtraStatsLevel(state, 'extraSpDefenseLevel', event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_POSTURE_SPEED':
      if (event.data0 === 0) event.data0 = 4
      setExtraStatsLevel(state, 'extraSpeedLevel', event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_POSTURE_ACCURACY':
      // src/battle_events.c:242: NOT IMPLEMENTED BECAUSE OF RAW STATS
      break

    case 'BATTLE_EVENT_POSTURE_CRIT':
      // src/battle_events.c:250: not implemented fully (BattleScript_ExtraSkillPostureCrit: end2)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LAST_PARALYZED':
      affectNStatusOnTeamFromLastToFirst(state, STATUS1_PARALYSIS, event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LAST_BURNED':
      affectNStatusOnTeamFromLastToFirst(state, STATUS1_BURN, event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LAST_SLEEP':
      affectNStatusOnTeamFromLastToFirst(state, STATUS1_SLEEP, event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LAST_FROSTBITE':
      affectNStatusOnTeamFromLastToFirst(state, STATUS1_FROSTBITE, event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LAST_BLEED':
      affectNStatusOnTeamFromLastToFirst(state, STATUS1_BLEED, event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LAST_POISONED':
      affectNStatusOnTeamFromLastToFirst(state, STATUS1_POISON, event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LAST_TOXIC':
      affectNStatusOnTeamFromLastToFirst(state, STATUS1_TOXIC_POISON, event.data0)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_STEALTH_ROCK':
      state.sides[0].statuses = setFlag(state.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)
      state.sides[0].timers.stealthRockType = TYPE_ROCK_ID
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_TOXIC_SPIKES':
      state.sides[0].statuses = setFlag(state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)
      state.sides[0].timers.toxicSpikesAmount = 2
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_SPIKES':
      state.sides[0].statuses = setFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)
      state.sides[0].timers.spikesAmount = event.data0 ? (event.data0 & 0x03) : 1
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_EMBARGO':
      if (state.battlers[0]) {
        state.battlers[0].statuses3 = setFlag(state.battlers[0].statuses3, STATUS3_EMBARGO)
        state.battlers[0].volatiles.embargoTimer = event.data0
      }
      if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_DOUBLE) && state.sides[0].party.length >= 2) {
        if (state.battlers[2]) {
          state.battlers[2].statuses3 = setFlag(state.battlers[2].statuses3, STATUS3_EMBARGO)
          state.battlers[2].volatiles.embargoTimer = event.data0
        }
      }
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_REFLECT':
      state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)
      state.sides[1].timers.reflectTimer = event.data0
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LIGHTSCREEN':
      state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_LIGHTSCREEN)
      state.sides[1].timers.lightscreenTimer = event.data0
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LUCKY_CHANT':
      state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_LUCKY_CHANT)
      state.sides[1].timers.luckyChantTimer = event.data0
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_PERMA_WIDE_GUARD':
      if (hasFlag(state.sides[1].statuses, SIDE_STATUS_WIDE_GUARD)) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_WIDE_GUARD)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_PERMA_STICKY_WEB':
      if (hasFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      state.sides[0].statuses = setFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_NO_PROTECT':
      if (!depleteTeamPowerPointOfMove(state, 'MOVE_PROTECT')) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_TENSE_BATTLE':
      // Turn 0: CalculateEnemyPartyCount(); in C does not modify state or unregister
      return EXEC_BATTLE_EVENTS_ALL_CLEAR
  }

  return EXEC_BATTLE_EVENTS_ALL_CLEAR
}

/**
 * BattleEventStartTurnExec (src/battle_events.c:367-500).
 * Executed when battleTurnCounter > 0.
 */
export function battleEventStartTurnExec(
  state: BattleState,
  event: BattleEventEntry,
  deps?: BattleEventDeps,
  unmodelled: string[] = [],
): number {
  const opponentLeft = state.battlers[1]
  if (opponentLeft?.volatiles.isFirstTurn === 1 && isBattleEventForbiddenOnSwitchIn(event.id)) {
    return EXEC_BATTLE_EVENTS_ALL_CLEAR
  }

  switch (event.id) {
    case 'BATTLE_EVENT_NONE':
      break

    case 'BATTLE_EVENT_STEADY_OFFENSE':
      applySteadyStatChange(state, STAT_ATK, deps, unmodelled)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_STEADY_DEFENSE':
      applySteadyStatChange(state, STAT_DEF, deps, unmodelled)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_STEADY_SPECIAL':
      applySteadyStatChange(state, STAT_SPATK, deps, unmodelled)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_STEADY_SPDEF':
      applySteadyStatChange(state, STAT_SPDEF, deps, unmodelled)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_STEADY_SPEED':
      applySteadyStatChange(state, STAT_SPEED, deps, unmodelled)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_STEADY_ACCURACY':
      applySteadyStatChange(state, STAT_ACC, deps, unmodelled)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_STEADY_CRIT':
      // src/battle_scripts_1.s:12146: BattleScript_ExtraSkillSteadyCrit: end2 (not implemented yet)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_ONSWITCH_MAT_BLOCK':
      if (opponentLeft?.volatiles.isFirstTurn !== 1) {
        event.data1 = 0
        return EXEC_BATTLE_EVENTS_ALL_CLEAR
      }
      state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_MAT_BLOCK)
      if (!event.data1 && event.data0 > 1) {
        event.data1 = 1
        event.data0--
        return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
      }
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_ONSTAY_FORESIGHT': {
      const target = state.battlers[0]
      if (
        !hasNumberOfTurnsStayedReached(state, event, 0) ||
        (target && hasFlag(target.statuses4, STATUS4_FORESIGHT))
      ) {
        return EXEC_BATTLE_EVENTS_ALL_CLEAR
      }
      if (target) {
        target.statuses4 = setFlag(target.statuses4, STATUS4_FORESIGHT)
      }
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
    }

    case 'BATTLE_EVENT_ONSTAY_LEECH_SEED': {
      const target = state.battlers[0]
      if (
        !hasNumberOfTurnsStayedReached(state, event, 0) ||
        (target && hasFlag(target.statuses3, STATUS3_LEECHSEED))
      ) {
        return EXEC_BATTLE_EVENTS_ALL_CLEAR
      }
      if (target) {
        // B_SIDE_OPPONENT = 1
        target.statuses3 = setFlag(target.statuses3, STATUS3_LEECHSEED | 1)
      }
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
    }

    case 'BATTLE_EVENT_ONSTAY_MAGNET_RISE': {
      const target = state.battlers[1]
      if (
        !hasNumberOfTurnsStayedReached(state, event, 1) ||
        (target && hasFlag(target.statuses3, STATUS3_MAGNET_RISE))
      ) {
        return EXEC_BATTLE_EVENTS_ALL_CLEAR
      }
      if (target) {
        target.statuses3 = setFlag(target.statuses3, STATUS3_MAGNET_RISE)
      }
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
    }

    case 'BATTLE_EVENT_LAST_STAND':
      if (state.sides[1].faintedCount !== event.data0) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      setExtraStatsLevel(state, 'extraAttackLevel', event.data1)
      setExtraStatsLevel(state, 'extraDefenseLevel', event.data1)
      setExtraStatsLevel(state, 'extraSpAttackLevel', event.data1)
      setExtraStatsLevel(state, 'extraSpDefenseLevel', event.data1)
      setExtraStatsLevel(state, 'extraSpeedLevel', event.data1)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_LAST_STAND_STAGES': {
      if (state.sides[1].faintedCount !== event.data0) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      let level = event.data1
      if (level + DEFAULT_STAT_STAGE > MAX_STAT_STAGE) {
        level = MAX_STAT_STAGE - DEFAULT_STAT_STAGE
      } else if (level === 0) {
        level = 1
      }
      setStatsStageLevel(state, STAT_ATK, level)
      setStatsStageLevel(state, STAT_DEF, level)
      setStatsStageLevel(state, STAT_SPATK, level)
      setStatsStageLevel(state, STAT_SPDEF, level)
      setStatsStageLevel(state, STAT_SPEED, level)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
    }

    case 'BATTLE_EVENT_SUBSTITUTE':
      if (state.sides[1].faintedCount !== event.data0) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      setSubstituteBattleEvent(state, 1)
      unregisterCurrentBattleEvent(state)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_PERMA_HEAL_BLOCK': {
      const target = state.battlers[0]
      if (target && hasFlag(target.statuses3, STATUS3_HEAL_BLOCK)) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      if (target) {
        target.statuses3 = setFlag(target.statuses3, STATUS3_HEAL_BLOCK)
        target.volatiles.healBlockTimer = 5
      }
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
    }

    case 'BATTLE_EVENT_PERMA_NIGHTMARE': {
      const target = state.battlers[0]
      if (!target) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      if (hasFlag(target.mon.status2, STATUS2_NIGHTMARE)) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      if (!hasFlag(target.mon.status1, STATUS1_SLEEP)) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      target.mon.status2 = setFlag(target.mon.status2, STATUS2_NIGHTMARE)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
    }

    case 'BATTLE_EVENT_PERMA_WIDE_GUARD':
      if (hasFlag(state.sides[1].statuses, SIDE_STATUS_WIDE_GUARD)) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_WIDE_GUARD)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_PERMA_STICKY_WEB':
      if (hasFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)) return EXEC_BATTLE_EVENTS_ALL_CLEAR
      state.sides[0].statuses = setFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL

    case 'BATTLE_EVENT_ONDS_COPY_STATS': {
      if (
        !opponentLeft ||
        opponentLeft.volatiles.isFirstTurn === 0 ||
        state.sides[1].timers.retaliateTimer !== 1
      ) {
        return EXEC_BATTLE_EVENTS_ALL_CLEAR
      }
      const playerLead = state.battlers[0]
      if (playerLead && opponentLeft) {
        for (let i = 0; i < NUM_BATTLE_STATS; i++) {
          opponentLeft.mon.statStages[i] = playerLead.mon.statStages[i] ?? DEFAULT_STAT_STAGE
        }
      }
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
    }

    case 'BATTLE_EVENT_TENSE_BATTLE': {
      const playerFainted = state.sides[0].faintedCount
      const opponentFainted = state.sides[1].faintedCount
      const playerPartyCount = state.sides[0].party.length
      const enemyPartyCount = state.sides[1].party.length
      if (
        opponentFainted >= Math.floor(enemyPartyCount / 2) &&
        playerFainted >= Math.floor(playerPartyCount / 2)
      ) {
        unregisterCurrentBattleEvent(state)
      } else if (playerPartyCount - playerFainted <= enemyPartyCount - opponentFainted - 3) {
        unregisterCurrentBattleEvent(state)
      }
      return EXEC_BATTLE_EVENTS_ALL_CLEAR
    }
  }

  return EXEC_BATTLE_EVENTS_ALL_CLEAR
}

/**
 * BattleEventExec (src/battle_events.c:76-90).
 * Dispatches to BeforeFirstTurn when turnCount == 0, else StartTurn.
 */
export function battleEventExec(
  state: BattleState,
  event: BattleEventEntry,
  deps?: BattleEventDeps,
  unmodelled: string[] = [],
): number {
  if (!event.id || event.id === 'BATTLE_EVENT_NONE') {
    return EXEC_BATTLE_EVENTS_ALL_CLEAR
  }

  state.lastBattleEvent = event.id

  switch (state.turnCount) {
    case 0:
      if (battleEventBeforeFirstTurnExec(state, event, deps, unmodelled) === EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL) {
        return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
      }
      break
    default:
      if (battleEventStartTurnExec(state, event, deps, unmodelled) === EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL) {
        return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
      }
      break
  }
  return EXEC_BATTLE_EVENTS_ALL_CLEAR
}

/**
 * ExecBattleEvents (src/battle_events.c:61-73).
 * Iterates through registered events using currentBattleEvent cursor.
 */
export function execBattleEvents(
  state: BattleState,
  deps?: BattleEventDeps,
  unmodelled: string[] = [],
): number {
  while (state.currentBattleEvent < state.battleEvents.length) {
    const event = state.battleEvents[state.currentBattleEvent]
    if (battleEventExec(state, event, deps, unmodelled) === EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL) {
      state.currentBattleEvent++
      return EXEC_BATTLE_EVENTS_NEEDS_SCRIPT_CALL
    }
    state.currentBattleEvent++
  }
  state.currentBattleEvent = 0
  return EXEC_BATTLE_EVENTS_ALL_CLEAR
}

/**
 * HandleBattleEvents runner (src/battle_main.c:5888-5899).
 * Runs execBattleEvents in a loop until EXEC_BATTLE_EVENTS_ALL_CLEAR.
 * Sets state.battleEventsDone = true to prevent re-execution in the same turn.
 */
export function runBattleEvents(
  state: BattleState,
  deps?: BattleEventDeps,
  unmodelled: string[] = [],
): void {
  if (state.battleEventsDone) return
  while (execBattleEvents(state, deps, unmodelled) !== EXEC_BATTLE_EVENTS_ALL_CLEAR) {
    // Loop until all clear, mirroring HandleBattleEvents / ExecBattleEvents loop
  }
  state.battleEventsDone = true
}
