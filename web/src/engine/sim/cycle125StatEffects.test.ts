/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 125: twelve stat boost/drop move effects (Power Swap through Acupressure). Every number below
// is derived by hand from the C: the script line in data/battle_scripts_1.s and the command in
// src/battle_script_commands.c are cited on the test that asserts it. Stat stages run 0..12
// (neutral 6), so the C's MIN_STAT_STAGE is stage 0 and MAX_STAT_STAGE stage 12.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS2_SUBSTITUTE,
  STATUS3_MINIMIZED,
  STATUS3_SEMI_INVULNERABLE,
  hasFlag,
} from './constants'
import { createBridgeDamageResolver } from './damageResolver'
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

/** Draws the scripted values in order (0 once they run out); `calls` counts draws. */
function scriptedRng(values: number[]): RandomSource & { calls: number } {
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

/** The real damage engine, needed where the test has to observe type immunity rather than fixed damage. */
function bridgeDamage(state: BattleState): DamageResolver {
  return createBridgeDamageResolver({
    moveData: simData.moveData,
    typeChart: simData.typeChart,
    inverseTypeChart: simData.inverseTypeChart,
    moveBehaviors: simData.moveBehaviors,
    battleConstants: simData.battleConstants,
    random: state.rng,
    grounding: groundingFor(simData, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  })
}

const THIS_FILE = 'web/src/engine/sim/cycle125StatEffects.test.ts'
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
/** The outcome for a battler. Heart Swap's test lowers the user's Speed stage, so the foe's null
 * action is ordered first there and `actions[0]` is not the user. */
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const statsOf = (state: BattleState, battlerId: number) => state.battlers[battlerId]!.mon

// BattleScript_EffectPowerSwap data/battle_scripts_1.s:2504-2517: attackcanceler, attackstring,
// ppreduce (:2507), accuracycheck BattleScript_ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:2508 -- the
// lock-on branch of Cmd_accuracycheck, battle_script_commands.c:1398-1411, draws no random), then
// swapstatstages STAT_ATK / STAT_SPATK (:2509-2510, Cmd_swapstatstages :13039-13048 exchanges the
// two battlers' stat STAGES) and swapstat BS_TARGET, STAT_ATK / STAT_SPATK (:2511-2512,
// VARIOUS_SWAP_STAT :8879-8885 SWAPs gBattleMons[].stats[stat-1], i.e. the computed stat values).
describe('cycle 125 - Power Swap (EFFECT_POWER_SWAP)', () => {
  it('swaps Atk/Sp. Atk stages and computed stats; no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_POWER_SWAP', { rawStats: { atk: 150, def: 100, spatk: 80, spdef: 100, spe: 150 } }),
      foe({ rawStats: { atk: 61, def: 100, spatk: 120, spdef: 100, spe: 60 } }),
      rng,
    )
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    state.battlers[0]!.mon.statStages[STAT_SPATK] = 6
    foeOf(state).mon.statStages[STAT_ATK] = 4
    foeOf(state).mon.statStages[STAT_SPATK] = 9
    const out = runVs(state, 'MOVE_POWER_SWAP')
    // :13043-13044: atkStatStage 8 <-> 4, 6 <-> 9.
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(4)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(9)
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(8)
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(6)
    // :8883 SWAP(gBattleMons[].stats[]) -- 150 <-> 61 Attack, 80 <-> 120 Sp. Atk.
    expect(statsOf(state, 0).rawStats.atk).toBe(61)
    expect(statsOf(state, 0).rawStats.spatk).toBe(120)
    expect(statsOf(state, 1).rawStats.atk).toBe(150)
    expect(statsOf(state, 1).rawStats.spatk).toBe(80)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: -4 },
      { battlerId: 1, stat: STAT_ATK, change: 4 },
      { battlerId: 0, stat: STAT_SPATK, change: 3 },
      { battlerId: 1, stat: STAT_SPATK, change: -3 },
    ])
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON
    expect(ppOf(state)).toBe(9) // ppreduce :2507
  })

  it('a semi-invulnerable target fails the accuracycheck (:1406-1407): nothing swaps; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_POWER_SWAP', { rawStats: { atk: 150, def: 100, spatk: 80, spdef: 100, spe: 150 } }),
      foe({ rawStats: { atk: 61, def: 100, spatk: 120, spdef: 100, spe: 60 } }),
      rng,
    )
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    foeOf(state).mon.statStages[STAT_ATK] = 4
    foeOf(state).statuses3 = STATUS3_SEMI_INVULNERABLE
    const out = runVs(state, 'MOVE_POWER_SWAP')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(4)
    expect(statsOf(state, 0).rawStats.atk).toBe(150)
    expect(statsOf(state, 1).rawStats.atk).toBe(61)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectGuardSwap data/battle_scripts_1.s:2519-2532: same shape as Power Swap with
// swapstatstages STAT_DEF / STAT_SPDEF (:2524-2525) and swapstat BS_TARGET, STAT_DEF / STAT_SPDEF
// (:2526-2527) -- stages exchanged by Cmd_swapstatstages (:13039-13048), computed stats by
// VARIOUS_SWAP_STAT (:8879-8885).
describe('cycle 125 - Guard Swap (EFFECT_GUARD_SWAP)', () => {
  it('swaps Def/Sp. Def stages and computed stats; no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_GUARD_SWAP', { rawStats: { atk: 100, def: 150, spatk: 100, spdef: 80, spe: 150 } }),
      foe({ rawStats: { atk: 100, def: 61, spatk: 100, spdef: 120, spe: 60 } }),
      rng,
    )
    state.battlers[0]!.mon.statStages[STAT_DEF] = 6
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = 9
    foeOf(state).mon.statStages[STAT_DEF] = 5
    foeOf(state).mon.statStages[STAT_SPDEF] = 6
    const out = runVs(state, 'MOVE_GUARD_SWAP')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(5)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(6)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(6)
    expect(foeOf(state).mon.statStages[STAT_SPDEF]).toBe(9)
    expect(statsOf(state, 0).rawStats.def).toBe(61) // :8883 SWAP
    expect(statsOf(state, 0).rawStats.spdef).toBe(120)
    expect(statsOf(state, 1).rawStats.def).toBe(150)
    expect(statsOf(state, 1).rawStats.spdef).toBe(80)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: -1 },
      { battlerId: 1, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_SPDEF, change: -3 },
      { battlerId: 1, stat: STAT_SPDEF, change: 3 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :2522
  })

  it('a semi-invulnerable target fails the accuracycheck: nothing swaps; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_GUARD_SWAP', { rawStats: { atk: 100, def: 150, spatk: 100, spdef: 80, spe: 150 } }),
      foe({ rawStats: { atk: 100, def: 61, spatk: 100, spdef: 120, spe: 60 } }),
      rng,
    )
    state.battlers[0]!.mon.statStages[STAT_DEF] = 6
    foeOf(state).mon.statStages[STAT_DEF] = 5
    foeOf(state).statuses3 = STATUS3_SEMI_INVULNERABLE
    const out = runVs(state, 'MOVE_GUARD_SWAP')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(6)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(5)
    expect(statsOf(state, 0).rawStats.def).toBe(150)
    expect(statsOf(state, 1).rawStats.def).toBe(61)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectPowerSplit data/battle_scripts_1.s:2460-2471: attackcanceler, attackstring,
// ppreduce (:2463), accuracycheck ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:2464), averagestats
// STAT_ATK (:2465) and averagestats STAT_SPATK (:2466). Cmd_averagestats
// (src/battle_script_commands.c:13050-13060) writes (atkStat + defStat) / 2 into BOTH battlers'
// gBattleMons[].stats[statId-1]. No statbuffchange, so stages are untouched.
describe('cycle 125 - Power Split (EFFECT_POWER_SPLIT)', () => {
  it('averages Atk 150/61 -> 105 and Sp. Atk 100/51 -> 75, stages untouched; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_POWER_SPLIT', { rawStats: { atk: 150, def: 100, spatk: 100, spdef: 100, spe: 150 } }),
      foe({ rawStats: { atk: 61, def: 100, spatk: 51, spdef: 100, spe: 60 } }),
      rng,
    )
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    foeOf(state).mon.statStages[STAT_ATK] = 4
    runVs(state, 'MOVE_POWER_SPLIT')
    expect(statsOf(state, 0).rawStats.atk).toBe(105) // (150 + 61) / 2 = 105
    expect(statsOf(state, 1).rawStats.atk).toBe(105)
    expect(statsOf(state, 0).rawStats.spatk).toBe(75) // (100 + 51) / 2 = 75
    expect(statsOf(state, 1).rawStats.spatk).toBe(75)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8) // no statbuffchange in the script
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(4)
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON
    expect(ppOf(state)).toBe(9) // ppreduce :2463
  })

  it('a semi-invulnerable target fails the accuracycheck: nothing averaged; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_POWER_SPLIT', { rawStats: { atk: 150, def: 100, spatk: 100, spdef: 100, spe: 150 } }),
      foe({ rawStats: { atk: 61, def: 100, spatk: 51, spdef: 100, spe: 60 } }),
      rng,
    )
    foeOf(state).statuses3 = STATUS3_SEMI_INVULNERABLE
    const out = runVs(state, 'MOVE_POWER_SPLIT')
    expect(out.actions[0]?.missed).toBe(true)
    expect(statsOf(state, 0).rawStats.atk).toBe(150)
    expect(statsOf(state, 1).rawStats.atk).toBe(61)
    expect(statsOf(state, 0).rawStats.spatk).toBe(100)
    expect(statsOf(state, 1).rawStats.spatk).toBe(51)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectGuardSplit data/battle_scripts_1.s:2473-2484: averagestats STAT_DEF (:2478)
// and averagestats STAT_SPDEF (:2479); Cmd_averagestats (src/battle_script_commands.c:13050-13060).
describe('cycle 125 - Guard Split (EFFECT_GUARD_SPLIT)', () => {
  it('averages Def 150/61 -> 105 and Sp. Def 100/51 -> 75, stages untouched; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_GUARD_SPLIT', { rawStats: { atk: 100, def: 150, spatk: 100, spdef: 100, spe: 150 } }),
      foe({ rawStats: { atk: 100, def: 61, spatk: 100, spdef: 51, spe: 60 } }),
      rng,
    )
    state.battlers[0]!.mon.statStages[STAT_DEF] = 8
    foeOf(state).mon.statStages[STAT_DEF] = 4
    runVs(state, 'MOVE_GUARD_SPLIT')
    expect(statsOf(state, 0).rawStats.def).toBe(105) // (150 + 61) / 2
    expect(statsOf(state, 1).rawStats.def).toBe(105)
    expect(statsOf(state, 0).rawStats.spdef).toBe(75) // (100 + 51) / 2
    expect(statsOf(state, 1).rawStats.spdef).toBe(75)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(8)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(4)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :2476
  })

  it('a semi-invulnerable target fails the accuracycheck: nothing averaged; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_GUARD_SPLIT', { rawStats: { atk: 100, def: 150, spatk: 100, spdef: 100, spe: 150 } }),
      foe({ rawStats: { atk: 100, def: 61, spatk: 100, spdef: 51, spe: 60 } }),
      rng,
    )
    foeOf(state).statuses3 = STATUS3_SEMI_INVULNERABLE
    const out = runVs(state, 'MOVE_GUARD_SPLIT')
    expect(out.actions[0]?.missed).toBe(true)
    expect(statsOf(state, 0).rawStats.def).toBe(150)
    expect(statsOf(state, 1).rawStats.def).toBe(61)
    expect(statsOf(state, 0).rawStats.spdef).toBe(100)
    expect(statsOf(state, 1).rawStats.spdef).toBe(51)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectHeartSwap data/battle_scripts_1.s:2486-2502: attackcanceler, attackstring,
// ppreduce (:2489), accuracycheck ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:2490), then seven
// swapstatstages -- ATK, DEF, SPEED, SPATK, SPDEF, EVASION, ACC (:2491-2497), Cmd_swapstatstages
// :13039-13048. There is no swapstat here, so the computed stats are NOT exchanged.
describe('cycle 125 - Heart Swap (EFFECT_HEART_SWAP)', () => {
  it('exchanges all seven stages and leaves the computed stats alone; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HEART_SWAP'), foe(), rng)
    const mine = state.battlers[0]!.mon.statStages
    const theirs = foeOf(state).mon.statStages
    mine[STAT_ATK] = 8
    mine[STAT_DEF] = 6
    mine[STAT_SPEED] = 3
    mine[STAT_SPATK] = 6
    mine[STAT_SPDEF] = 9
    mine[STAT_EVASION] = 7
    mine[STAT_ACC] = 5
    theirs[STAT_ATK] = 4
    theirs[STAT_DEF] = 6
    theirs[STAT_SPEED] = 10
    theirs[STAT_SPATK] = 2
    theirs[STAT_SPDEF] = 6
    theirs[STAT_EVASION] = 6
    theirs[STAT_ACC] = 8
    const out = runVs(state, 'MOVE_HEART_SWAP')
    // :2491-2497 exchange each of the seven stages; Defense was already 6/6.
    expect(mine[STAT_ATK]).toBe(4)
    expect(mine[STAT_DEF]).toBe(6)
    expect(mine[STAT_SPEED]).toBe(10)
    expect(mine[STAT_SPATK]).toBe(2)
    expect(mine[STAT_SPDEF]).toBe(6)
    expect(mine[STAT_EVASION]).toBe(6)
    expect(mine[STAT_ACC]).toBe(8)
    expect(theirs[STAT_ATK]).toBe(8)
    expect(theirs[STAT_DEF]).toBe(6)
    expect(theirs[STAT_SPEED]).toBe(3)
    expect(theirs[STAT_SPATK]).toBe(6)
    expect(theirs[STAT_SPDEF]).toBe(9)
    expect(theirs[STAT_EVASION]).toBe(7)
    expect(theirs[STAT_ACC]).toBe(5)
    expect(statsOf(state, 0).rawStats.atk).toBe(100) // no swapstat in the Heart Swap script
    expect(statsOf(state, 1).rawStats.atk).toBe(100)
    expect(actionOf(out, 0)?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: -4 },
      { battlerId: 1, stat: STAT_ATK, change: 4 },
      { battlerId: 0, stat: STAT_SPEED, change: 7 },
      { battlerId: 1, stat: STAT_SPEED, change: -7 },
      { battlerId: 0, stat: STAT_SPATK, change: -4 },
      { battlerId: 1, stat: STAT_SPATK, change: 4 },
      { battlerId: 0, stat: STAT_SPDEF, change: -3 },
      { battlerId: 1, stat: STAT_SPDEF, change: 3 },
      { battlerId: 0, stat: STAT_EVASION, change: -1 },
      { battlerId: 1, stat: STAT_EVASION, change: 1 },
      { battlerId: 0, stat: STAT_ACC, change: 3 },
      { battlerId: 1, stat: STAT_ACC, change: -3 },
    ])
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON
    expect(ppOf(state)).toBe(9) // ppreduce :2489
  })

  it('a semi-invulnerable target fails the accuracycheck: no stage moves; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HEART_SWAP'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    foeOf(state).mon.statStages[STAT_ATK] = 4
    foeOf(state).statuses3 = STATUS3_SEMI_INVULNERABLE
    const out = runVs(state, 'MOVE_HEART_SWAP')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectShiftGear data/battle_scripts_1.s:1988-2016: attackcanceler, attackstring,
// ppreduce (:1991), no accuracycheck. :1992 jumpifstat SPEED < MAX -> DoMoveAnim, else :1993
// jumpifstat ATK == MAX -> CantRaiseMultipleStats -- so only Speed 12 AND Atk 12 fails. :1997
// jumpifstat SPEED > 10 -> SpeedBy1 (:2001-2003 setstatchanger STAT_SPEED, 1), else setstatchanger
// STAT_SPEED, 2 (:1999); Speed then Attack +1 (:2006 setstatchanger STAT_ATK, 1), each its own
// statbuffchange (:2004, :2007), so a maxed stat is skipped or clamped rather than failing.
describe('cycle 125 - Shift Gear (EFFECT_SHIFT_GEAR)', () => {
  it('raises Speed by 2 and Attack by 1 (6/6 -> 8/7); no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHIFT_GEAR'), foe(), rng)
    const out = runVs(state, 'MOVE_SHIFT_GEAR')
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8) // :1999 statValue 2
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7) // :2006
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPEED, change: 2 },
      { battlerId: 0, stat: STAT_ATK, change: 1 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :1991
  })

  it('at Speed 11 the Speed raise is +1 (:1998 > 10), clamped to 12; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHIFT_GEAR'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE - 1
    const out = runVs(state, 'MOVE_SHIFT_GEAR')
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE) // 11 + 1
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
      { battlerId: 0, stat: STAT_ATK, change: 1 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('at Speed 12 with Attack 6 it does not fail: only Attack rises; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHIFT_GEAR'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_SHIFT_GEAR')
    // :1992 Speed < MAX is false, :1993 Attack == MAX is false -> DoMoveAnim; the Speed buff is a no-op.
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('fails only when Speed and Attack are both 12 (:1993); nothing changes, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHIFT_GEAR'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_SHIFT_GEAR')
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9) // ppreduce :1991 runs before the failure jump
  })
})

// BattleScript_EffectEvasionUp data/battle_scripts_1.s:3610-3629: setstatchanger STAT_EVASION, 1,
// FALSE (:3611) then BattleScript_EffectStatUp (:3612): attackcanceler, attackstring, ppreduce
// (:3616), statbuffchange MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR (:3617). No accuracycheck.
describe('cycle 125 - Double Team (EFFECT_EVASION_UP)', () => {
  it('raises Evasion by 1 (6 -> 7) with zero draws; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DOUBLE_TEAM'), foe(), rng)
    const out = runVs(state, 'MOVE_DOUBLE_TEAM')
    expect(state.battlers[0]!.mon.statStages[STAT_EVASION]).toBe(7) // :3611 one stage
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_EVASION, change: 1 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :3616
  })

  it('at Evasion 12 nothing changes (B_MSG_STAT_WONT_INCREASE, :3618); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DOUBLE_TEAM'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_EVASION] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_DOUBLE_TEAM')
    expect(state.battlers[0]!.mon.statStages[STAT_EVASION]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    // STAT_BUFF_ALLOW_PTR makes ChangeStatBuffs set MOVE_RESULT_MISSED (:9942) even though it hit.
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSpecialAttackUp3 data/battle_scripts_1.s:4260-4261: setstatchanger STAT_SPATK,
// 3, FALSE -> BattleScript_EffectStatUp (:3612-3632), ppreduce (:3616), statbuffchange (:3617).
describe('cycle 125 - Tail Glow (EFFECT_SPECIAL_ATTACK_UP_3)', () => {
  it('raises Sp. Atk by 3 stages (6 -> 9) with zero draws; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAIL_GLOW'), foe(), rng)
    const out = runVs(state, 'MOVE_TAIL_GLOW')
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(9) // 6 + 3
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPATK, change: 3 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :3616
  })

  it('at Sp. Atk 11 it clamps to 12 (delta +1); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAIL_GLOW'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE - 1
    const out = runVs(state, 'MOVE_TAIL_GLOW')
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE) // min(3, 12 - 11)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPATK, change: 1 }])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('at Sp. Atk 12 nothing changes; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAIL_GLOW'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_TAIL_GLOW')
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectMinimize data/battle_scripts_1.s:4922-4927: attackcanceler, setminimize
// (:4924), setstatchanger STAT_EVASION, 2, FALSE (:4925), then BattleScript_EffectStatUpAfterAtkCanceler
// (attackstring, ppreduce :3616, statbuffchange :3617). Cmd_setminimize
// (src/battle_script_commands.c:11573-11577) sets STATUS3_MINIMIZED when HITMARKER_OBEYS, which the
// sim treats as always true once attackcanceler passed (moveEnd.ts's `obeys` simplification).
// setminimize runs BEFORE the stat change, so the flag is set even when Evasion is already 12.
describe('cycle 125 - Minimize (EFFECT_MINIMIZE)', () => {
  it('raises Evasion 6 -> 8 and sets STATUS3_MINIMIZED; no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MINIMIZE'), foe(), rng)
    const out = runVs(state, 'MOVE_MINIMIZE')
    expect(state.battlers[0]!.mon.statStages[STAT_EVASION]).toBe(8) // :4925 two stages
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MINIMIZED)).toBe(true) // :11575
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_EVASION, change: 2 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :3616
  })

  it('at Evasion 12 the stat does not rise but setminimize still ran (:4924 before :4925); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MINIMIZE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_EVASION] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_MINIMIZE')
    expect(state.battlers[0]!.mon.statStages[STAT_EVASION]).toBe(MAX_STAT_STAGE)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MINIMIZED)).toBe(true)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectAcupressure data/battle_scripts_1.s:1243-1259: attackcanceler; if target !=
// attacker and the target has a Substitute -> BattleScript_PrintMoveMissed (:1246-1247, whose label
// at :3092-3094 runs attackstring + ppreduce, so PP is spent); else attackstring (:1249), ppreduce (:1250),
// tryaccupressure (:1251 -> VARIOUS_ACUPRESSURE, src/battle_script_commands.c:6913-6928): bits =
// every stat ATK..NUM_BATTLE_STATS-1 whose target stage < 12; none -> ButItFailed; else
// do { statId = (Random() % (NUM_BATTLE_STATS - 1)) + 1 } while (!(bits & (1 << statId))), then +2.
describe('cycle 125 - Acupressure (EFFECT_ACUPRESSURE)', () => {
  it('with every stage at 6 a draw of 0 picks Attack (0 % 7 + 1) and raises it by 2; PP 10 -> 9', () => {
    const rng = scriptedRng([0])
    const state = battle(user('MOVE_ACUPRESSURE'), foe(), rng)
    const out = executeTurn(state, [useMove(0, 'MOVE_ACUPRESSURE'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8) // :6925 statId 1, +2 (:6924)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 2 }])
    expect(rng.calls).toBe(1) // one random16 in the do/while
    expect(ppOf(state)).toBe(9) // ppreduce :1250
  })

  it('skips a maxed stat: draw 0 picks the maxed Attack, the redraw 1 picks Defense; two draws; PP 10 -> 9', () => {
    const rng = scriptedRng([0, 1])
    const state = battle(user('MOVE_ACUPRESSURE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = executeTurn(state, [useMove(0, 'MOVE_ACUPRESSURE'), null], loopDeps(state, fixedDamage(0)))
    // :6920-6923 clears bit 1 from `bits`, so statId 1 fails `bits & gBitTable[statId]` and the
    // loop draws again: (1 % 7) + 1 = 2 -> Defense.
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(8)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 2 }])
    expect(rng.calls).toBe(2)
    expect(ppOf(state)).toBe(9)
  })

  it('fails with no draw when all seven stages are 12 (:6922 -> ButItFailed); PP 10 -> 9', () => {
    const rng = scriptedRng([0])
    const state = battle(user('MOVE_ACUPRESSURE'), foe(), rng)
    for (const stat of [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF, STAT_ACC, STAT_EVASION]) {
      state.battlers[0]!.mon.statStages[stat] = MAX_STAT_STAGE
    }
    const out = executeTurn(state, [useMove(0, 'MOVE_ACUPRESSURE'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0) // `bits` empty short-circuits before the do/while
    expect(ppOf(state)).toBe(9) // ppreduce still runs at :1250
  })

  it('a Substitute on the target jumps to PrintMoveMissed (:3092-3094), which runs ppreduce: PP 10 -> 9, no draw', () => {
    const rng = scriptedRng([0])
    const state = battle(user('MOVE_ACUPRESSURE'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = executeTurn(state, [useMove(1, 'MOVE_ACUPRESSURE'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.missed).toBe(true) // :1246 -> BattleScript_PrintMoveMissed
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce runs in BattleScript_PrintMoveMissed (:3092-3094)
  })
})

// BattleScript_EffectAccuracyDown data/battle_scripts_1.s:3652-3654 (setstatchanger STAT_ACC, 1,
// TRUE -> BattleScript_EffectStatDown) and BattleScript_EffectStatDown :3666-3686: attackcanceler,
// jumpifsubstituteblocks BattleScript_ButItFailedAtkStringPpReduce (:3668 -- that script runs
// attackstring + ppreduce but no accuracycheck), accuracycheck BattleScript_PrintMoveMissed,
// ACC_CURR_MOVE (:3669 -- draws one random16), attackstring (:3671), ppreduce (:3672),
// statbuffchange STAT_BUFF_ALLOW_PTR (:3673).
describe('cycle 125 - Sand Attack (EFFECT_ACCURACY_DOWN)', () => {
  it('drops the target accuracy stage 6 -> 5 after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SAND_ATTACK'), foe(), rng)
    const out = runVs(state, 'MOVE_SAND_ATTACK')
    expect(foeOf(state).mon.statStages[STAT_ACC]).toBe(5) // :3652 stage 6 - 1
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_ACC, change: -1 }])
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :3669
    expect(ppOf(state)).toBe(9) // ppreduce :3672
  })

  it('at accuracy stage 0 the drop fails but the accuracy check still drew; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SAND_ATTACK'), foe(), rng)
    foeOf(state).mon.statStages[STAT_ACC] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_SAND_ATTACK')
    expect(foeOf(state).mon.statStages[STAT_ACC]).toBe(MIN_STAT_STAGE) // no stage below MIN_STAT_STAGE
    expect(out.actions[0]?.statChanges).toEqual([])
    // B_MSG_STAT_WONT_DECREASE and B_MSG_STAT_WONT_INCREASE are both 2
    // (include/constants/battle_string_ids.h:1088,1096), so :9942 still sets MOVE_RESULT_MISSED.
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1) // accuracycheck runs before the statbuffchange
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute sends it to ButItFailedAtkStringPpReduce (:3668): no draw, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SAND_ATTACK'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_SAND_ATTACK')
    expect(foeOf(state).mon.statStages[STAT_ACC]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0) // the jump is before accuracycheck
    expect(ppOf(state)).toBe(9) // that script still ppreduces
  })

  it('a miss at accuracy stage 0 (100 * 3/9 = 33%) leaves the stage alone; PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_SAND_ATTACK'), foe(), rng))
    const out = runVs(state, 'MOVE_SAND_ATTACK')
    expect(out.actions[0]?.missed).toBe(true) // accuracycheck :3669 -> PrintMoveMissed
    expect(foeOf(state).mon.statStages[STAT_ACC]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSuperFangHaze data/battle_scripts_1.s:4105-4118: attackcanceler,
// accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:4107 -- PrintMoveMissed itself runs
// attackstring + ppreduce, :10046-10047), attackstring (:4108), ppreduce (:4109), typecalc (:4110),
// calculatesetdamage (:4112 -> Cmd_calculatesetdamage :10646-10651, baseDamage = target->hp / 2,
// AdjustFixedDamageForParentalBond at :10653, failsafe `if (!gBattleMoveDamage) gBattleMoveDamage = 1`
// at :10655-10656), call HitFromAtkAnimationReturn (:4113), then
// jumpifhalfword CMP_COMMON_BITS, gMoveResultFlags, MOVE_RESULT_DOESNT_AFFECT_FOE -> MoveEnd (:4114)
// and normalisebuffs (:4115 -> Cmd_normalisebuffs :9988-9995 -> TryResetBattlerStatChanges
// :9957-9986, RESET_ALL_STATS for every battler, also clearing stockpile and critBoost).
// Nature's Madness is FAIRY and Ruination is DARK (data/v2.65beta/moves.json); neither type has a
// 0x chart entry, so the immunity case uses ABILITY_GIFTED_MIND (abilities.cc:5354-5364 zeroes DARK)
// to reach MOVE_RESULT_DOESNT_AFFECT_FOE.
describe('cycle 125 - Nature\'s Madness / Ruination (EFFECT_SUPER_FANG_HAZE)', () => {
  it("deals target hp / 2 (100 -> 50) and resets every stat stage to 6; PP 10 -> 9", () => {
    const rng = countRng()
    const state = battle(user('MOVE_NATURES_MADNESS'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    foeOf(state).mon.statStages[STAT_DEF] = 4
    state.battlers[0]!.volatiles.critBoost = 2 // :9978-9982 clears critBoost under RESET_ALL_STATS
    state.battlers[0]!.volatiles.stockpileDef = 3 // :9961-9962 clears the stockpile counts
    const out = executeTurn(state, [useMove(1, 'MOVE_NATURES_MADNESS'), null], loopDeps(state, fixedDamage(1)))
    expect(out.actions[0]?.targetDamage).toBe(50) // :10649 hp / 2, no random and no crit
    expect(foeOf(state).mon.hp).toBe(50)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE) // :9969 reset
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.volatiles.critBoost).toBe(0)
    expect(state.battlers[0]!.volatiles.stockpileDef).toBe(0)
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :4107
    expect(ppOf(state)).toBe(9) // ppreduce :4109
  })

  it('at target hp 1 the failsafe turns hp / 2 = 0 into 1 (:10655-10656)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_RUINATION'), foe({ hp: 1 }), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_RUINATION'), null], loopDeps(state, fixedDamage(1)))
    expect(out.actions[0]?.targetDamage).toBe(1)
    expect(foeOf(state).mon.hp).toBe(0)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a type-immune target takes 0 and the Haze is skipped (:4114 -> MoveEnd); PP 10 -> 9', () => {
    const rng = countRng()
    const giftedMind: SimBattleMon['abilities'] = { ability: 'ABILITY_GIFTED_MIND', innates: [null, null, null] }
    const state = battle(user('MOVE_RUINATION'), foe({ abilities: giftedMind }), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    foeOf(state).mon.statStages[STAT_DEF] = 4
    const out = executeTurn(state, [useMove(1, 'MOVE_RUINATION'), null], loopDeps(state, bridgeDamage(state)))
    expect(out.actions[0]?.targetDamage).toBe(0) // DARK modifier 0 -> MOVE_RESULT_DOESNT_AFFECT_FOE
    expect(foeOf(state).mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8) // normalisebuffs never ran
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(4)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 resets nothing and still ppreduces via PrintMoveMissed; PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_NATURES_MADNESS'), foe(), rng))
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    foeOf(state).mon.statStages[STAT_DEF] = 4
    const out = executeTurn(state, [useMove(1, 'MOVE_NATURES_MADNESS'), null], loopDeps(state, fixedDamage(1)))
    expect(out.actions[0]?.missed).toBe(true) // accuracycheck :4107
    expect(foeOf(state).mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(4)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9) // BattleScript_PrintMoveMissed ppreduce :10047
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_POWER_SWAP',
  'EFFECT_GUARD_SWAP',
  'EFFECT_POWER_SPLIT',
  'EFFECT_GUARD_SPLIT',
  'EFFECT_HEART_SWAP',
  'EFFECT_SHIFT_GEAR',
  'EFFECT_EVASION_UP',
  'EFFECT_SPECIAL_ATTACK_UP_3',
  'EFFECT_MINIMIZE',
  'EFFECT_ACUPRESSURE',
  'EFFECT_ACCURACY_DOWN',
  'EFFECT_SUPER_FANG_HAZE',
]

describe('cycle 125 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})

describe('cycle 125 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_POWER_SWAP', 'EFFECT_POWER_SWAP'],
    ['MOVE_GUARD_SWAP', 'EFFECT_GUARD_SWAP'],
    ['MOVE_POWER_SPLIT', 'EFFECT_POWER_SPLIT'],
    ['MOVE_GUARD_SPLIT', 'EFFECT_GUARD_SPLIT'],
    ['MOVE_HEART_SWAP', 'EFFECT_HEART_SWAP'],
    ['MOVE_SHIFT_GEAR', 'EFFECT_SHIFT_GEAR'],
    ['MOVE_DOUBLE_TEAM', 'EFFECT_EVASION_UP'],
    ['MOVE_TAIL_GLOW', 'EFFECT_SPECIAL_ATTACK_UP_3'],
    ['MOVE_MINIMIZE', 'EFFECT_MINIMIZE'],
    ['MOVE_ACUPRESSURE', 'EFFECT_ACUPRESSURE'],
    ['MOVE_SAND_ATTACK', 'EFFECT_ACCURACY_DOWN'],
    ["MOVE_NATURES_MADNESS", 'EFFECT_SUPER_FANG_HAZE'],
    ['MOVE_RUINATION', 'EFFECT_SUPER_FANG_HAZE'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
