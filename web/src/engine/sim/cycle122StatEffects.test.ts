/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 122: twelve stat boost/drop move effects. Every number below is derived by hand from the C:
// the script line in data/battle_scripts_1.s and the command in src/battle_script_commands.c are
// cited on the test that asserts it. Stat stages run 0..12 (neutral 6), so the C's MIN_STAT_STAGE is
// stage 0 and MAX_STAT_STAGE stage 12.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS2_DEFENSE_CURL,
  STATUS2_SUBSTITUTE,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const RATIOS = simData.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }
const only = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

/** Every draw is 0 (accuracy always hits); `calls` counts draws. */
function countRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

/** The first draw is 99 (`99 % 100 >= accuracy` misses any accuracy at or below 99), the rest 0. */
function missRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => (rng.calls++ === 0 ? 99 : 0),
  }
  return rng
}

/** Draws the given values in order (0 for anything past the end); `calls` counts draws. */
function scriptRng(values: number[]): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      const value = values[rng.calls] ?? 0
      rng.calls++
      return value
    },
  }
  return rng
}

function battle(
  a: SimBattleMon,
  b: SimBattleMon,
  rng: RandomSource,
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[] } = {},
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    playerParty: opts.playerParty,
    opponentParty: opts.opponentParty,
    rng,
  })
}

function useMove(target: number, moveId: string): ChosenAction {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  const view: TurnOrderMoveView = {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(simData, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
  }
}

const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

const THIS_FILE = 'web/src/engine/sim/cycle122StatEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect

/** The user (battler 0, Mudkip, faster than the default foe) knows only `moveId` with 10 PP. */
const user = (moveId: string, overrides: Partial<SimBattleMon> = {}) =>
  monFor('SPECIES_MUDKIP', {
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 150 },
    moves: [moveId, null, null, null],
    pp: [10, 0, 0, 0],
    ...overrides,
  })
const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

/** Puts the user's accuracy stage at its floor, so a 100%-accuracy move becomes 33%.
 * createBattlerState starts every battler neutral, so stages are written after the battle exists. */
function atAccuracyFloor(state: BattleState): BattleState {
  state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE
  return state
}

/** One turn: the user (battler 0) uses `moveId` on battler 1, the foe does nothing. */
function runVs(state: BattleState, moveId: string): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedDamage(0)))
}

const ppOf = (state: BattleState) => state.battlers[0]!.mon.pp[0]
const foeOf = (state: BattleState) => state.battlers[1]!

// BattleScript_EffectAttackDown2 data/battle_scripts_1.s:4292-4294 (`setstatchanger STAT_ATK, 2, TRUE`)
// -> BattleScript_EffectStatDown :3666-3687: attackcanceler, jumpifsubstituteblocks, accuracycheck
// ACC_CURR_MOVE :3669, attackstring, ppreduce :3672, statbuffchange STAT_BUFF_ALLOW_PTR :3673.
// Both moves target SELECTED (moves.json: Charm 100 acc, Feather Dance 100 acc).
describe('cycle 122 - Charm / Feather Dance (EFFECT_ATTACK_DOWN_2)', () => {
  it('Charm drops the target Attack 6 -> 4 with exactly one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CHARM'), foe(), rng)
    const out = runVs(state, 'MOVE_CHARM')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(4) // stage 6 - 2
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: -2 }])
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :3669
    expect(ppOf(state)).toBe(9) // ppreduce :3672
  })

  it('Feather Dance carries its own effect key and drops Attack 6 -> 4; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FEATHER_DANCE'), foe(), rng)
    const out = runVs(state, 'MOVE_FEATHER_DANCE')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: -2 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('at Attack stage 1 the drop clamps to stage 0 (only one stage available); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CHARM'), foe(), rng)
    foeOf(state).mon.statStages[STAT_ATK] = 1
    const out = runVs(state, 'MOVE_CHARM')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE) // :9846 statValue = max(statValue, -stage)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('at Attack stage 0 it fails with no change (B_MSG_STAT_WONT_DECREASE); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CHARM'), foe(), rng)
    foeOf(state).mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_CHARM')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    // B_MSG_STAT_WONT_DECREASE and B_MSG_STAT_WONT_INCREASE are both 2
    // (include/constants/battle_string_ids.h:1088,1096), so :9942 still sets MOVE_RESULT_MISSED.
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1) // the accuracycheck already ran at :3669
    expect(ppOf(state)).toBe(9)
  })

  it('against a Substitute the drop is blocked before any accuracy roll; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CHARM'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_CHARM')
    // jumpifsubstituteblocks (:3668) -> BattleScript_ButItFailedAtkStringPpReduce (:5938-5946, MOVE_RESULT_FAILED at :5945) sets
    // MOVE_RESULT_FAILED, not MOVE_RESULT_MISSED; the drop never happens.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ButItFailedAtkStringPpReduce ppreduce :5938-5941
  })

  it('misses at accuracy stage 0 (33%) and changes nothing; PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_CHARM'), foe(), rng))
    const out = runVs(state, 'MOVE_CHARM')
    expect(out.actions[0]?.missed).toBe(true) // accuracycheck :3669 -> BattleScript_PrintMoveMissed :3092-3097
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9) // PrintMoveMissed's ppreduce :3095
  })

  it('Clear Body blocks the drop (onBlockStatDrops ALL, abilities.cc:851-857) but PP is still spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CHARM'), foe({ abilities: only('ABILITY_CLEAR_BODY') }), rng)
    const out = runVs(state, 'MOVE_CHARM')
    // ChangeStatBuffs' statBlockAbility branch (battle_script_commands.c:9776-9796) returns 0 without moving the stage.
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1) // accuracycheck runs before statbuffchange
    expect(ppOf(state)).toBe(9)
  })

  it('Defiant raises Attack +2 after the drop (abilities.cc:11764-11769), net 6 -> 4 -> 6', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CHARM'), foe({ abilities: only('ABILITY_DEFIANT') }), rng)
    const out = runVs(state, 'MOVE_CHARM')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE) // 6 - 2 + 2
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 1, stat: STAT_ATK, change: -2 },
      { battlerId: 1, stat: STAT_ATK, change: 2 },
    ])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectAttackSpAttackUp data/battle_scripts_1.s:2142-2165: guard `jumpifstat ATK < MAX`
// (:2146) else `jumpifstat SPATK == MAX -> CantRaiseMultipleStats` (:2147, :6765-6770); then ATK +1
// (:2152) and SPATK +1 (:2157) each through statbuffchange. Cmd_jumpifstat (:3370-3383) is CompareStat
// (battle_util.c:8545-8561), which flips CMP_LESS_THAN/MAX under Contrary, hence the canRaiseStat guard.
describe('cycle 122 - Work Up (EFFECT_ATTACK_SPATK_UP)', () => {
  it('raises Attack and Sp. Atk 6/6 -> 7/7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WORK_UP'), foe(), rng)
    const out = runVs(state, 'MOVE_WORK_UP')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
    ])
    expect(rng.calls).toBe(0) // the script has no accuracycheck (:2144-2146)
    expect(ppOf(state)).toBe(9) // ppreduce :2145
  })

  it('with Attack at 12 and Sp. Atk at 6 only Sp. Atk rises (7); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WORK_UP'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_WORK_UP')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPATK, change: 1 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('with both at 12 the guard jumps to CantRaiseMultipleStats (:2147): nothing changes, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WORK_UP'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_WORK_UP')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('Contrary flips the guard (CompareStat battle_util.c:8551-8560): both at 12 drop to 11/11', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WORK_UP', { abilities: only('ABILITY_CONTRARY') }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_WORK_UP')
    // CompareStat(ATK, MAX, CMP_LESS_THAN) becomes "ATK > MIN" (:8551-8558) -> the guard proceeds,
    // and ChangeStatBuffs :9749-9751 negates both +1 raises.
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE - 1)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: -1 },
      { battlerId: 0, stat: STAT_SPATK, change: -1 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectAttackDown data/battle_scripts_1.s:3640-3642 (`setstatchanger STAT_ATK, 1, TRUE`)
// -> BattleScript_EffectStatDown :3666-3687. Baby-Doll Eyes targets SELECTED and Play Nice BOTH
// (moves.json), both at accuracy 0, which GetTotalAccuracy turns into 101 but Cmd_accuracycheck
// still rolls one Random() (battle_script_commands.c:1420-1433).
describe('cycle 122 - Baby-Doll Eyes / Play Nice (EFFECT_ATTACK_DOWN)', () => {
  it('Baby-Doll Eyes drops Attack 6 -> 5 with one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BABY_DOLL_EYES'), foe(), rng)
    const out = runVs(state, 'MOVE_BABY_DOLL_EYES')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(5)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Play Nice carries its own effect key and drops Attack 6 -> 5; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PLAY_NICE'), foe(), rng)
    const out = runVs(state, 'MOVE_PLAY_NICE')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(5)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('at Attack stage 0 nothing changes; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BABY_DOLL_EYES'), foe(), rng)
    foeOf(state).mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_BABY_DOLL_EYES')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(out.actions[0]?.missed).toBe(true) // B_MSG_STAT_WONT_DECREASE is 2, so :9942 sets MISSED
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('against a Substitute it fails with no draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BABY_DOLL_EYES'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_BABY_DOLL_EYES')
    // jumpifsubstituteblocks -> BattleScript_ButItFailedAtkStringPpReduce (:5938-5946, MOVE_RESULT_FAILED at :5945) sets
    // MOVE_RESULT_FAILED, not MOVE_RESULT_MISSED; the drop never happens.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a 99 accuracy draw still hits at accuracy stage 0: accuracy 0 -> 101 (HITS_IF_POSSIBLE, :1287-1289)', () => {
    const rng = scriptRng([99])
    const state = atAccuracyFloor(battle(user('MOVE_BABY_DOLL_EYES'), foe(), rng))
    const out = runVs(state, 'MOVE_BABY_DOLL_EYES')
    expect(out.actions[0]?.missed).toBe(false)
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(5)
    expect(rng.calls).toBe(1) // Cmd_accuracycheck still calls Random() (:1433)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectHaze data/battle_scripts_1.s:3723-3733: attackcanceler, attackstring, ppreduce,
// attackanimation, normalisebuffs, printstring. Cmd_normalisebuffs
// (src/battle_script_commands.c:9988-9995) calls TryResetBattlerStatChanges(i, RESET_ALL_STATS)
// (:9957-9986) for every battler: stages back to DEFAULT, plus stockpileDef/SpDef and critBoost.
describe('cycle 122 - Haze (EFFECT_HAZE)', () => {
  it('resets both sides\' raised and lowered stages to 6 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HAZE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = 9
    state.battlers[0]!.mon.statStages[STAT_DEF] = 3
    state.battlers[0]!.mon.statStages[STAT_ACC] = 4
    foeOf(state).mon.statStages[STAT_SPATK] = 8
    foeOf(state).mon.statStages[STAT_SPDEF] = 2
    foeOf(state).mon.statStages[STAT_SPEED] = 10
    const out = runVs(state, 'MOVE_HAZE')
    for (const stat of [STAT_ATK, STAT_DEF, STAT_ACC, STAT_SPATK, STAT_SPDEF, STAT_SPEED]) {
      expect(state.battlers[0]!.mon.statStages[stat]).toBe(DEFAULT_STAT_STAGE)
      expect(foeOf(state).mon.statStages[stat]).toBe(DEFAULT_STAT_STAGE)
    }
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(0) // the script has no accuracycheck (:3723-3726)
    expect(ppOf(state)).toBe(9) // ppreduce :3726
  })

  it('also clears Stockpile counters and critBoost (TryResetBattlerStatChanges :9961-9984)', () => {
    const state = battle(user('MOVE_HAZE'), foe(), countRng())
    state.battlers[0]!.volatiles.stockpileDef = 2
    state.battlers[0]!.volatiles.stockpileSpDef = 3
    state.battlers[0]!.volatiles.critBoost = 1
    runVs(state, 'MOVE_HAZE')
    expect(state.battlers[0]!.volatiles.stockpileDef).toBe(0)
    expect(state.battlers[0]!.volatiles.stockpileSpDef).toBe(0)
    expect(state.battlers[0]!.volatiles.critBoost).toBe(0)
  })

  it('a reset is not a stat drop: Defiant does not fire (:9977 writes statStages directly)', () => {
    const state = battle(user('MOVE_HAZE'), foe({ abilities: only('ABILITY_DEFIANT') }), countRng())
    foeOf(state).mon.statStages[STAT_ATK] = 4
    runVs(state, 'MOVE_HAZE')
    // Back to neutral, not neutral + 2: normalisebuffs never calls ChangeStatBuffs, so the
    // STRINGID_DEFENDERSSTATFELL onStatLowered path (battle_util.c:1222-1255) never runs.
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('resets fainted battlers too: normalisebuffs has no IsBattlerAlive gate (:9988-9995)', () => {
    const state = battle(user('MOVE_HAZE'), foe({ hp: 0 }), countRng())
    foeOf(state).mon.statStages[STAT_DEF] = 9
    runVs(state, 'MOVE_HAZE')
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
  })
})

// BattleScript_EffectSpecialDefenseDown2 data/battle_scripts_1.s:4304-4306
// (`setstatchanger STAT_SPDEF, 2, TRUE`) -> BattleScript_EffectStatDown :3666-3687.
// Fake Tears is 100% accurate, Metal Sound 85% (moves.json); both SELECTED.
describe('cycle 122 - Fake Tears / Metal Sound (EFFECT_SPECIAL_DEFENSE_DOWN_2)', () => {
  it('Fake Tears drops Sp. Def 6 -> 4 with one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FAKE_TEARS'), foe(), rng)
    const out = runVs(state, 'MOVE_FAKE_TEARS')
    expect(foeOf(state).mon.statStages[STAT_SPDEF]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPDEF, change: -2 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Metal Sound carries its own effect key and drops Sp. Def 6 -> 4 (85% accuracy hits on a 0 draw)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_METAL_SOUND'), foe(), rng)
    const out = runVs(state, 'MOVE_METAL_SOUND')
    expect(foeOf(state).mon.statStages[STAT_SPDEF]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPDEF, change: -2 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('at Sp. Def stage 0 nothing changes; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FAKE_TEARS'), foe(), rng)
    foeOf(state).mon.statStages[STAT_SPDEF] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_FAKE_TEARS')
    expect(foeOf(state).mon.statStages[STAT_SPDEF]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(out.actions[0]?.missed).toBe(true) // B_MSG_STAT_WONT_DECREASE is 2, so :9942 sets MISSED
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('misses Metal Sound at accuracy stage 0 (85 * 1/3 = 28%); PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_METAL_SOUND'), foe(), rng))
    const out = runVs(state, 'MOVE_METAL_SOUND')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('against a Substitute it fails with no draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FAKE_TEARS'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_FAKE_TEARS')
    // :3668 -> ButItFailedAtkStringPpReduce sets MOVE_RESULT_FAILED, not MOVE_RESULT_MISSED.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectDefenseUp data/battle_scripts_1.s:3590-3592 (`setstatchanger STAT_DEF, 1, FALSE`)
// -> BattleScript_EffectStatUp :3612-3632: attackcanceler, attackstring, ppreduce, statbuffchange
// MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR (:3615). No accuracycheck.
describe('cycle 122 - Harden / Withdraw (EFFECT_DEFENSE_UP)', () => {
  it('Harden raises Defense 6 -> 7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HARDEN'), foe(), rng)
    const out = runVs(state, 'MOVE_HARDEN')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 1 }])
    expect(rng.calls).toBe(0) // no accuracycheck in BattleScript_EffectStatUp
    expect(ppOf(state)).toBe(9) // ppreduce :3615
  })

  it('Withdraw carries its own effect key and raises Defense 6 -> 7; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WITHDRAW'), foe(), rng)
    const out = runVs(state, 'MOVE_WITHDRAW')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 1 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('at Defense stage 12 the stat does not move (B_MSG_STAT_WONT_INCREASE); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HARDEN'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_HARDEN')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    // STAT_BUFF_ALLOW_PTR makes ChangeStatBuffs set MOVE_RESULT_MISSED (:9942) even though the move hit.
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectDefenseCurl data/battle_scripts_1.s:5896-5906: attackcanceler, attackstring,
// ppreduce (:5899), setdefensecurlbit (:5900, Cmd_setdefensecurlbit
// src/battle_script_commands.c:11428-11431), setstatchanger STAT_DEF, 1, FALSE, statbuffchange.
// The bit is written BEFORE the stat change, so it is set even when Defense is already maxed.
describe('cycle 122 - Defense Curl (EFFECT_DEFENSE_CURL)', () => {
  it('raises Defense 6 -> 7 and sets STATUS2_DEFENSE_CURL with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DEFENSE_CURL'), foe(), rng)
    const out = runVs(state, 'MOVE_DEFENSE_CURL')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_DEFENSE_CURL)).toBe(true) // :11430
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 1 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :5898
  })

  it('at Defense stage 12 it still sets the bit while Defense stays 12; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DEFENSE_CURL'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_DEFENSE_CURL')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_DEFENSE_CURL)).toBe(true)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectDefenseDown data/battle_scripts_1.s:3644-3646 (`setstatchanger STAT_DEF, 1, TRUE`)
// -> BattleScript_EffectStatDown :3666-3687. Both Leer and Tail Whip target BOTH at 100% accuracy.
describe('cycle 122 - Leer / Tail Whip (EFFECT_DEFENSE_DOWN)', () => {
  it('Leer drops the target Defense 6 -> 5 with one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LEER'), foe(), rng)
    const out = runVs(state, 'MOVE_LEER')
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(5)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Tail Whip carries its own effect key and drops Defense 6 -> 5; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAIL_WHIP'), foe(), rng)
    const out = runVs(state, 'MOVE_TAIL_WHIP')
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(5)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('at Defense stage 0 nothing changes; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LEER'), foe(), rng)
    foeOf(state).mon.statStages[STAT_DEF] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_LEER')
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('misses at accuracy stage 0 (33%) and changes nothing; PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_LEER'), foe(), rng))
    const out = runVs(state, 'MOVE_LEER')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('against a Substitute it fails with no draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LEER'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_LEER')
    // :3668 -> ButItFailedAtkStringPpReduce sets MOVE_RESULT_FAILED, not MOVE_RESULT_MISSED.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSpecialAttackDown data/battle_scripts_1.s:3656-3658
// (`setstatchanger STAT_SPATK, 1, TRUE`) -> BattleScript_EffectStatDown :3666-3687.
// Confide and Tearful Look are both accuracy 0 (HITS_IF_POSSIBLE) and target SELECTED.
describe('cycle 122 - Confide / Tearful Look (EFFECT_SPECIAL_ATTACK_DOWN)', () => {
  it('Confide drops Sp. Atk 6 -> 5 with one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CONFIDE'), foe(), rng)
    const out = runVs(state, 'MOVE_CONFIDE')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(5)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Tearful Look carries its own effect key and drops Sp. Atk 6 -> 5; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TEARFUL_LOOK'), foe(), rng)
    const out = runVs(state, 'MOVE_TEARFUL_LOOK')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(5)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('at Sp. Atk stage 0 nothing changes; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CONFIDE'), foe(), rng)
    foeOf(state).mon.statStages[STAT_SPATK] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_CONFIDE')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute does not block Confide: it is a sound move (DoesSubstituteBlockMove :12255); Sp. Atk still 6 -> 5', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CONFIDE'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_CONFIDE')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(5)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Tearful Look is not a sound move, so a Substitute blocks it with no draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TEARFUL_LOOK'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_TEARFUL_LOOK')
    // :3668 -> ButItFailedAtkStringPpReduce sets MOVE_RESULT_FAILED, not MOVE_RESULT_MISSED.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a 99 accuracy draw still hits at accuracy stage 0: accuracy 0 -> 101 (HITS_IF_POSSIBLE, :1287-1289)', () => {
    const rng = scriptRng([99])
    const state = atAccuracyFloor(battle(user('MOVE_CONFIDE'), foe(), rng))
    const out = runVs(state, 'MOVE_CONFIDE')
    expect(out.actions[0]?.missed).toBe(false)
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(5)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectGrowth data/battle_scripts_1.s:1912-1946. Guard at :1916-1917 (same two jumps as
// Work Up). Each of ATK (:1919-1924) and SPATK (:1931-1936) is raised by 2 when
// `jumpifweatheraffected BS_ATTACKER, WEATHER_SUN_ANY` (VARIOUS_JUMP_IF_WEATHER_AFFECTED,
// battle_script_commands.c:8055-8059 -> IsBattlerWeatherAffected battle_util.c:8644-8653, which honours
// WEATHER_HAS_EFFECT and Utility Umbrella) or `jumpifabilityflag BS_ATTACKER, ABILITY_CHLOROPLAST`;
// otherwise by 1. The check is re-run before the SPATK step.
describe('cycle 122 - Growth (EFFECT_GROWTH)', () => {
  it('in neutral weather raises Attack and Sp. Atk 6/6 -> 7/7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GROWTH'), foe(), rng)
    const out = runVs(state, 'MOVE_GROWTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in the script
    expect(ppOf(state)).toBe(9) // ppreduce :1915
  })

  it('in sun raises both by 2 (6/6 -> 8/8); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GROWTH'), foe(), rng)
    state.field.weather = WEATHER_SUN_TEMPORARY
    const out = runVs(state, 'MOVE_GROWTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 2 },
      { battlerId: 0, stat: STAT_SPATK, change: 2 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('with a Chloroplast-flag ability and no sun raises both by 2 (6/6 -> 8/8)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GROWTH', { abilities: only('ABILITY_CHLOROPLAST') }), foe(), rng)
    runVs(state, 'MOVE_GROWTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
    expect(rng.calls).toBe(0)
  })

  it('in sun holding Utility Umbrella raises both by 1: IsBattlerWeatherAffected returns FALSE (battle_util.c:8647-8649)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GROWTH', { itemId: 'ITEM_UTILITY_UMBRELLA' }), foe(), rng)
    state.field.weather = WEATHER_SUN_TEMPORARY
    const out = runVs(state, 'MOVE_GROWTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
    ])
    expect(rng.calls).toBe(0)
  })

  it('in sun with Cloud Nine on the field raises both by 1: WEATHER_HAS_EFFECT is FALSE (battle_util.h:45-46)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GROWTH'), foe({ abilities: only('ABILITY_CLOUD_NINE') }), rng)
    state.field.weather = WEATHER_SUN_TEMPORARY
    const out = runVs(state, 'MOVE_GROWTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
    ])
    expect(rng.calls).toBe(0)
  })

  it('with Attack at 12 and Sp. Atk at 6 in sun only Sp. Atk moves, 6 -> 8; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GROWTH'), foe(), rng)
    state.field.weather = WEATHER_SUN_TEMPORARY
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_GROWTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPATK, change: 2 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('with both at 12 the guard jumps to CantRaiseMultipleStats (:1917): nothing changes, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GROWTH'), foe(), rng)
    state.field.weather = WEATHER_SUN_TEMPORARY
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_GROWTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('Contrary flips the guard (CompareStat battle_util.c:8551-8560): both at 12 drop 2 stages each, 12 -> 10', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GROWTH', { abilities: only('ABILITY_CONTRARY') }), foe(), rng)
    state.field.weather = WEATHER_SUN_TEMPORARY
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_GROWTH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE - 2)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE - 2)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: -2 },
      { battlerId: 0, stat: STAT_SPATK, change: -2 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectAttackAccUp data/battle_scripts_1.s:2167-2190: guard `jumpifstat ATK < MAX`
// (:2171) else `jumpifstat ACC == MAX -> CantRaiseMultipleStats` (:2172); then ATK +1 (:2178) and
// ACC +1 (:2184), each through statbuffchange. The animation's SPATK/SPDEF bits at :2177 are cosmetic.
describe('cycle 122 - Hone Claws (EFFECT_ATTACK_ACCURACY_UP)', () => {
  it('raises Attack and accuracy 6/6 -> 7/7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HONE_CLAWS'), foe(), rng)
    const out = runVs(state, 'MOVE_HONE_CLAWS')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_ACC]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_ACC, change: 1 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in the script
    expect(ppOf(state)).toBe(9) // ppreduce :2170
  })

  it('with Attack at 12 and accuracy at 6 only accuracy rises (6 -> 7); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HONE_CLAWS'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_HONE_CLAWS')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_ACC]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_ACC, change: 1 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('with both at 12 the guard jumps to CantRaiseMultipleStats (:2172): nothing changes, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HONE_CLAWS'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_ACC] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_HONE_CLAWS')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_ACC]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('Contrary flips the guard (CompareStat battle_util.c:8551-8560): both at 12 drop to 11/11', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HONE_CLAWS', { abilities: only('ABILITY_CONTRARY') }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_ACC] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_HONE_CLAWS')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.statStages[STAT_ACC]).toBe(MAX_STAT_STAGE - 1)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: -1 },
      { battlerId: 0, stat: STAT_ACC, change: -1 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSpeedDown2 data/battle_scripts_1.s:4300-4302 (`setstatchanger STAT_SPEED, 2, TRUE`)
// -> BattleScript_EffectStatDown :3666-3687. Cotton Spore and String Shot both target BOTH at 100%.
describe('cycle 122 - Cotton Spore / String Shot (EFFECT_SPEED_DOWN_2)', () => {
  it('Cotton Spore drops Speed 6 -> 4 with one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COTTON_SPORE'), foe(), rng)
    const out = runVs(state, 'MOVE_COTTON_SPORE')
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: -2 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('String Shot carries its own effect key and drops Speed 6 -> 4; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STRING_SHOT'), foe(), rng)
    const out = runVs(state, 'MOVE_STRING_SHOT')
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: -2 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('at Speed stage 0 nothing changes; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COTTON_SPORE'), foe(), rng)
    foeOf(state).mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_COTTON_SPORE')
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('misses at accuracy stage 0 (33%) and changes nothing; PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_STRING_SHOT'), foe(), rng))
    const out = runVs(state, 'MOVE_STRING_SHOT')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('against a Substitute it fails with no draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COTTON_SPORE'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_COTTON_SPORE')
    // :3668 -> ButItFailedAtkStringPpReduce sets MOVE_RESULT_FAILED, not MOVE_RESULT_MISSED.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_ATTACK_DOWN_2',
  'EFFECT_ATTACK_SPATK_UP',
  'EFFECT_ATTACK_DOWN',
  'EFFECT_HAZE',
  'EFFECT_SPECIAL_DEFENSE_DOWN_2',
  'EFFECT_DEFENSE_UP',
  'EFFECT_DEFENSE_CURL',
  'EFFECT_DEFENSE_DOWN',
  'EFFECT_SPECIAL_ATTACK_DOWN',
  'EFFECT_GROWTH',
  'EFFECT_ATTACK_ACCURACY_UP',
  'EFFECT_SPEED_DOWN_2',
]

describe('cycle 122 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})

describe('cycle 122 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_CHARM', 'EFFECT_ATTACK_DOWN_2'],
    ['MOVE_FEATHER_DANCE', 'EFFECT_ATTACK_DOWN_2'],
    ['MOVE_WORK_UP', 'EFFECT_ATTACK_SPATK_UP'],
    ['MOVE_BABY_DOLL_EYES', 'EFFECT_ATTACK_DOWN'],
    ['MOVE_PLAY_NICE', 'EFFECT_ATTACK_DOWN'],
    ['MOVE_HAZE', 'EFFECT_HAZE'],
    ['MOVE_FAKE_TEARS', 'EFFECT_SPECIAL_DEFENSE_DOWN_2'],
    ['MOVE_METAL_SOUND', 'EFFECT_SPECIAL_DEFENSE_DOWN_2'],
    ['MOVE_HARDEN', 'EFFECT_DEFENSE_UP'],
    ['MOVE_WITHDRAW', 'EFFECT_DEFENSE_UP'],
    ['MOVE_DEFENSE_CURL', 'EFFECT_DEFENSE_CURL'],
    ['MOVE_LEER', 'EFFECT_DEFENSE_DOWN'],
    ['MOVE_TAIL_WHIP', 'EFFECT_DEFENSE_DOWN'],
    ['MOVE_CONFIDE', 'EFFECT_SPECIAL_ATTACK_DOWN'],
    ['MOVE_TEARFUL_LOOK', 'EFFECT_SPECIAL_ATTACK_DOWN'],
    ['MOVE_GROWTH', 'EFFECT_GROWTH'],
    ['MOVE_HONE_CLAWS', 'EFFECT_ATTACK_ACCURACY_UP'],
    ['MOVE_COTTON_SPORE', 'EFFECT_SPEED_DOWN_2'],
    ['MOVE_STRING_SHOT', 'EFFECT_SPEED_DOWN_2'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
