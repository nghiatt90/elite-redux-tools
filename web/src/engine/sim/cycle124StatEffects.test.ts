/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 124: twelve stat boost/drop move effects (Tickle through Speed Swap). Every number below is
// derived by hand from the C: the script line in data/battle_scripts_1.s and the command in
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
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_SUBSTITUTE,
  STATUS3_POWER_TRICK,
  STATUS3_SEMI_INVULNERABLE,
  STATUS4_COILED,
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

const THIS_FILE = 'web/src/engine/sim/cycle124StatEffects.test.ts'
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

// BattleScript_EffectTickle data/battle_scripts_1.s:6610-6636: attackcanceler, attackstring,
// ppreduce (:6613), jumpifstat TARGET > ATK MIN -> DoMoveAnim (:6614), else jumpifstat TARGET ==
// DEF MIN -> BattleScript_CantLowerMultipleStats (:6615, :6638-6644 sets MOVE_RESULT_FAILED); then
// accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:6617) -- so no draw when both are at 0 --
// then ATK -1 (:6623 setstatchanger STAT_ATK, 1, TRUE -> statbuffchange STAT_BUFF_ALLOW_PTR :6624)
// and DEF -1 (:6630-6631).
describe('cycle 124 - Tickle (EFFECT_TICKLE)', () => {
  it('drops Attack and Defense 6/6 -> 5/5 after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TICKLE'), foe(), rng)
    const out = runVs(state, 'MOVE_TICKLE')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(5) // :6623 stage 6 - 1
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(5) // :6630 stage 6 - 1
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 1, stat: STAT_ATK, change: -1 },
      { battlerId: 1, stat: STAT_DEF, change: -1 },
    ])
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :6617
    expect(ppOf(state)).toBe(9) // ppreduce :6613
  })

  it('with Attack already at stage 0 only Defense drops (6 -> 5); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TICKLE'), foe(), rng)
    foeOf(state).mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_TICKLE')
    // :6614 ATK > MIN is false, :6615 DEF == MIN is false -> fall through to the accuracy check.
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(5)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: -1 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('with both stats at stage 0 it fails before the accuracy check: zero rng draws; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TICKLE'), foe(), rng)
    foeOf(state).mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    foeOf(state).mon.statStages[STAT_DEF] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_TICKLE')
    // :6615 -> BattleScript_CantLowerMultipleStats (:6638), which is past ppreduce and before
    // accuracycheck (:6617), so no random16 is consumed.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(MIN_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :6613 still runs
  })

  it('a miss at accuracy stage 0 (100 * 3/9 = 33%) leaves both stages alone; PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_TICKLE'), foe(), rng))
    const out = runVs(state, 'MOVE_TICKLE')
    expect(out.actions[0]?.missed).toBe(true) // accuracycheck :6617 -> BattleScript_ButItFailed
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectTopsyTurvy data/battle_scripts_1.s:2208-2227: attackcanceler, attackstring,
// ppreduce (:2211), accuracycheck ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:2212 -- the lock-on
// branch of Cmd_accuracycheck, battle_script_commands.c:1403-1411, draws no random), then seven
// jumpifstat CMP_NOT_EQUAL ..., 6 lines (:2213-2219) ending in jumpifstat EVASION CMP_EQUAL 6 ->
// ButItFailed (:2219); the inversion is VARIOUS_INVERT_STAT_STAGES (battle_script_commands.c:7290-7297).
describe('cycle 124 - Topsy-Turvy (EFFECT_TOPSY_TURVY)', () => {
  it('inverts the target stages: Attack 8 -> 4, Defense 3 -> 9, Evasion 6 stays 6; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TOPSY_TURVY'), foe(), rng)
    foeOf(state).mon.statStages[STAT_ATK] = 8
    foeOf(state).mon.statStages[STAT_DEF] = 3
    const out = runVs(state, 'MOVE_TOPSY_TURVY')
    // :7293-7296: stage > 6 -> 6 - (stage - 6); stage < 6 -> 6 + (6 - stage).
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(4) // 6 - (8 - 6)
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(9) // 6 + (6 - 3)
    expect(foeOf(state).mon.statStages[STAT_EVASION]).toBe(DEFAULT_STAT_STAGE) // already 6
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 1, stat: STAT_ATK, change: -4 },
      { battlerId: 1, stat: STAT_DEF, change: 6 },
    ])
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON draws nothing
    expect(ppOf(state)).toBe(9) // ppreduce :2211
  })

  it('fails when all seven stages are neutral (:2213-2219); nothing changes, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TOPSY_TURVY'), foe(), rng)
    const out = runVs(state, 'MOVE_TOPSY_TURVY')
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(foeOf(state).mon.statStages[STAT_EVASION]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectQuiverDance data/battle_scripts_1.s:2063-2093: attackcanceler, attackstring,
// ppreduce (:2066), then the guard at :2067-2069 -- jumpifstat SPATK < MAX -> DoMoveAnim, else
// jumpifstat SPDEF < MAX -> DoMoveAnim, else jumpifstat SPEED == MAX -> CantRaiseMultipleStats
// (:6765) -- then SPATK +1 (:2075), SPDEF +1 (:2081) and SPEED +1 (:2087), each its own
// statbuffchange, so a maxed stat is simply skipped.
describe('cycle 124 - Quiver Dance (EFFECT_QUIVER_DANCE)', () => {
  it('raises Sp. Atk / Sp. Def / Speed 6/6/6 -> 7/7/7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_QUIVER_DANCE'), foe(), rng)
    const out = runVs(state, 'MOVE_QUIVER_DANCE')
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :2066
  })

  it('with Sp. Atk at 12 the other two still rise 6/6 -> 7/7; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_QUIVER_DANCE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_QUIVER_DANCE')
    // :2067 SPATK < MAX is false, :2068 SPDEF < MAX is true -> DoMoveAnim runs all three steps.
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('fails only when all three are at 12 (:2069): nothing changes, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_QUIVER_DANCE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_QUIVER_DANCE')
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectPsychUp data/battle_scripts_1.s:5644-5653: attackcanceler, attackstring,
// ppreduce (:5647), copyfoestats BattleScript_ButItFailed (:5648). Cmd_copyfoestats
// (battle_script_commands.c:11356-11365) copies all NUM_BATTLE_STATS stages of the target onto the
// attacker and advances past the unused jump pointer, so it never fails. No accuracycheck.
describe('cycle 124 - Psych Up (EFFECT_PSYCH_UP)', () => {
  it('overwrites the user stages with the target ones: Atk 3 -> 8, Def 6 -> 5; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PSYCH_UP'), foe(), rng)
    foeOf(state).mon.statStages[STAT_ATK] = 8 // +2
    foeOf(state).mon.statStages[STAT_DEF] = 5 // -1
    state.battlers[0]!.mon.statStages[STAT_ATK] = 3
    const out = runVs(state, 'MOVE_PSYCH_UP')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8) // :11360 copy
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(5)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 5 },
      { battlerId: 0, stat: STAT_DEF, change: -1 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :5647
  })

  it('a neutral target resets the user\'s own boosts (Atk 10 -> 6, Def 2 -> 6); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PSYCH_UP'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = 10
    state.battlers[0]!.mon.statStages[STAT_DEF] = 2
    const out = runVs(state, 'MOVE_PSYCH_UP')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: -4 },
      { battlerId: 0, stat: STAT_DEF, change: 4 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectKinesis data/battle_scripts_1.s:12525-12536: attackcanceler, accuracycheck
// PrintMoveMissed, ACC_CURR_MOVE (:12527), attackstring, ppreduce (:12529), trydestroyitem
// BattleScript_ButItFailed (:12530). VARIOUS_TRY_DESTROY_ITEM (battle_script_commands.c:8839-8847)
// fails on no item / !CanBattlerGetOrLoseItem / IsStickyHold / DoesSubstituteBlockMove, else
// RemoveItem. Then setmoveeffect MOVE_EFFECT_FLINCH; seteffectprimary (:12534-12535), which goes
// through Cmd_seteffectprimary -> SetMoveEffect(TRUE, 0) with no random. Kinesis is 100% accurate
// and +1 priority (data/v2.65beta/moves.json MOVE_KINESIS), so it resolves before the foe's move.
// STATUS2_FLINCHED is observed through the foe's own action: CANCELLER_FLINCH (attackCanceller.ts,
// battle_util.c:3305-3314) cancels it before its accuracy roll, because ENDTURN_FLINCH
// (endTurn.ts:2066-2068, battle_util.c:2770-2772) clears the flag by the time the turn returns.
describe('cycle 124 - Kinesis (EFFECT_KINESIS)', () => {
  /** One turn where the foe also acts (Tackle on the user), so the flinch has a visible effect. */
  const runPair = (state: BattleState): TurnOutcome =>
    executeTurn(state, [useMove(1, 'MOVE_KINESIS'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(0)))

  it('destroys a removable held item and flinches the foe out of its move; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_KINESIS'), foe({ itemId: 'ITEM_SILK_SCARF' }), rng)
    const out = runPair(state)
    expect(foeOf(state).mon.itemId).toBeNull() // RemoveItem :8845
    expect(out.actions[1]?.cancelledBy).toBe('FLINCH') // :12535 seteffectprimary -> CANCELLER_FLINCH
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(1) // accuracycheck :12527 only; no secondary roll, the foe never rolls
    expect(ppOf(state)).toBe(9) // ppreduce :12529
  })

  it('a target with no item fails trydestroyitem: no item, no flinch; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_KINESIS'), foe(), rng)
    const out = runPair(state)
    expect(foeOf(state).mon.itemId).toBeNull()
    expect(out.actions[1]?.cancelledBy).toBe(null) // :8840 !item -> ButItFailed, no flinch
    expect(rng.calls).toBe(2) // Kinesis accuracy + the foe's own Tackle accuracy
    expect(ppOf(state)).toBe(9)
  })

  it('a Sticky Hold target keeps its item and does not flinch; PP 10 -> 9', () => {
    const rng = countRng()
    const sticky: SimBattleMon['abilities'] = { ability: 'ABILITY_STICKY_HOLD', innates: [null, null, null] }
    const state = battle(user('MOVE_KINESIS'), foe({ itemId: 'ITEM_SILK_SCARF', abilities: sticky }), rng)
    const out = runPair(state)
    // IsStickyHold (battle_util.c:9329-9333) also covers Supersweet Syrup; :8841 jumps to ButItFailed.
    expect(foeOf(state).mon.itemId).toBe('ITEM_SILK_SCARF')
    expect(out.actions[1]?.cancelledBy).toBe(null)
    expect(rng.calls).toBe(2)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute blocks the item destruction (DoesSubstituteBlockMove :8842); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_KINESIS'), foe({ itemId: 'ITEM_SILK_SCARF', status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runPair(state)
    expect(foeOf(state).mon.itemId).toBe('ITEM_SILK_SCARF')
    expect(out.actions[1]?.cancelledBy).toBe(null)
    expect(rng.calls).toBe(2)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 (100 * 3/9 = 33%) keeps the item and skips the flinch; PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_KINESIS'), foe({ itemId: 'ITEM_SILK_SCARF' }), rng))
    const out = runPair(state)
    expect(out.actions[0]?.missed).toBe(true) // accuracycheck :12527 -> BattleScript_PrintMoveMissed
    expect(foeOf(state).mon.itemId).toBe('ITEM_SILK_SCARF')
    expect(out.actions[1]?.cancelledBy).toBe(null)
    expect(rng.calls).toBe(2)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectVictoryDance data/battle_scripts_1.s:2095-2125: same shape as Quiver Dance
// with ATK/DEF/SPEED -- guard :2099-2101 (ATK < MAX, else DEF < MAX, else SPEED == MAX ->
// CantRaiseMultipleStats :6765), then ATK +1 (:2107), DEF +1 (:2113), SPEED +1 (:2119).
describe('cycle 124 - Victory Dance (EFFECT_VICTORY_DANCE)', () => {
  it('raises Attack / Defense / Speed 6/6/6 -> 7/7/7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_VICTORY_DANCE'), foe(), rng)
    const out = runVs(state, 'MOVE_VICTORY_DANCE')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :2098
  })

  it('with Attack at 12 only Defense and Speed rise; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_VICTORY_DANCE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_VICTORY_DANCE')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('fails only when all three are at 12 (:2100); nothing changes, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_VICTORY_DANCE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_VICTORY_DANCE')
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectPowerTrick data/battle_scripts_1.s:1444-1454: attackcanceler, accuracycheck
// PrintMoveMissed, ACC_CURR_MOVE (:1446 -- MOVE_POWER_TRICK's accuracy is 0, which
// GetTotalAccuracy maps to "hits if possible", but Cmd_accuracycheck's else-branch still draws
// Random()), attackstring, ppreduce (:1448), powertrick BS_ATTACKER (:1449). VARIOUS_POWER_TRICK
// (battle_script_commands.c:7690-7694) XORs STATUS3_POWER_TRICK and SWAPs attack/defense and
// statStages[STAT_ATK]/[STAT_DEF]. Never fails.
describe('cycle 124 - Power Trick (EFFECT_POWER_TRICK)', () => {
  it('swaps raw Attack/Defense (150/60) and their stages (8/6 -> 6/8); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_POWER_TRICK', { rawStats: { atk: 150, def: 60, spatk: 100, spdef: 100, spe: 150 } }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    const out = runVs(state, 'MOVE_POWER_TRICK')
    expect(state.battlers[0]!.mon.rawStats.atk).toBe(60) // :7692 SWAP(attack, defense)
    expect(state.battlers[0]!.mon.rawStats.def).toBe(150)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(6) // :7693 SWAP of the stages
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(8)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_POWER_TRICK)).toBe(true) // :7691 XOR
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :1446
    expect(ppOf(state)).toBe(9) // ppreduce :1448
  })

  it('a second use swaps back and clears the status3 bit (stage 6/8 -> 8/6); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_POWER_TRICK', { rawStats: { atk: 60, def: 150, spatk: 100, spdef: 100, spe: 150 } }), foe(), rng)
    // The state after one use: bit set, stats and stages swapped.
    state.battlers[0]!.statuses3 = STATUS3_POWER_TRICK
    state.battlers[0]!.mon.statStages[STAT_ATK] = 6
    state.battlers[0]!.mon.statStages[STAT_DEF] = 8
    runVs(state, 'MOVE_POWER_TRICK')
    expect(state.battlers[0]!.mon.rawStats.atk).toBe(150)
    expect(state.battlers[0]!.mon.rawStats.def).toBe(60)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(6)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_POWER_TRICK)).toBe(false)
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectCoil data/battle_scripts_1.s:2019-2061: attackcanceler, attackstring,
// ppreduce (:2022), guard :2023-2026 (ATK < MAX -> DoMoveAnim, DEF < MAX -> DoMoveAnim, ACC < MAX
// -> DoMoveAnim, else jumpifabilityflag ABILITY_COIL_UP -> TryCoil, else ButItFailed);
// TryCoil: jumpifstatus4 STATUS4_COILED -> ButItFailed (:2029). CoilDoMoveAnim then runs ATK +1
// (:2035-2036), DEF +1 (:2041-2042) and ACC +1 (:2047-2048) as three independent statbuffchanges
// (a maxed stat is skipped, not a failure), and finally :2052-2058 re-checks the coilUp flag and
// COILED before setstatus4 STATUS4_COILED (:2058). The coilUp flag covers Coil Up / Curlipede /
// Sidewinder (abilityHooks.json).
describe('cycle 124 - Coil (EFFECT_COIL)', () => {
  it('raises Attack / Defense / Accuracy 6/6/6 -> 7/7/7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COIL'), foe(), rng)
    const out = runVs(state, 'MOVE_COIL')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_ACC]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_ACC, change: 1 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :2022
  })

  it('with Attack at 12 only Defense and Accuracy rise; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COIL'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_COIL')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_ACC]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_ACC, change: 1 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('fails when all three are at 12 and no coilUp ability is present (:2023-2026); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COIL'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_ACC] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_COIL')
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('with the Coil Up flag it also sets STATUS4_COILED (:2058); PP 10 -> 9', () => {
    const rng = countRng()
    const coilUp: SimBattleMon['abilities'] = { ability: 'ABILITY_COIL_UP', innates: [null, null, null] }
    const state = battle(user('MOVE_COIL', { abilities: coilUp }), foe(), rng)
    const out = runVs(state, 'MOVE_COIL')
    // The ability's switch-in hook sets COILED (abilities.cc:3966-3974), but the test harness builds
    // the battle state directly, so no switch-in hook ran and COILED starts clear (the C only clears
    // it after a Strong Jaw move, battle_util.c:2819-2821). The stat guard at :2023-2026 runs first:
    // ACC < MAX jumps to CoilDoMoveAnim before the ability check, so the stats rise either way.
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_COILED)).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(out.actions[0]?.statChanges).toHaveLength(3)
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('with all three stats at 12 and STATUS4_COILED clear it still sets COILED (:2053-2058); PP 10 -> 9', () => {
    const rng = countRng()
    const coilUp: SimBattleMon['abilities'] = { ability: 'ABILITY_COIL_UP', innates: [null, null, null] }
    const state = battle(user('MOVE_COIL', { abilities: coilUp }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_ACC] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_COIL')
    // :2023-2026 all fall through to jumpifabilityflag -> TryCoil, :2029 COILED is clear so it
    // falls into CoilDoMoveAnim: every statbuffchange is a no-op but :2058 still sets COILED.
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_COILED)).toBe(true)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('with the Coil Up flag already coiled and all three stats at 12 it fails (:2029); PP 10 -> 9', () => {
    const rng = countRng()
    const coilUp: SimBattleMon['abilities'] = { ability: 'ABILITY_COIL_UP', innates: [null, null, null] }
    const state = battle(user('MOVE_COIL', { abilities: coilUp }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_ACC] = MAX_STAT_STAGE
    state.battlers[0]!.statuses4 = STATUS4_COILED
    const out = runVs(state, 'MOVE_COIL')
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectNoRetreat data/battle_scripts_1.s:338-354: attackcanceler, accuracycheck
// PrintMoveMissed, ACC_CURR_MOVE (:340), attackstring, ppreduce (:342), trynoretreat BS_TARGET
// ButItFailed (:343, VARIOUS_TRY_NO_RETREAT battle_script_commands.c:8126-8133: fails when
// noRetreat or STATUS2_ESCAPE_PREVENTION is already set), call BattleScript_AllStatsUp (:346,
// :7891-7925: the block is skipped only when ATK, DEF, SPEED, SPATK and SPDEF are all at MAX --
// :7892-7896), then unless STATUS4_COMMANDED (:347) or STATUS2_ESCAPE_PREVENTION (:348),
// MOVE_EFFECT_PREVENT_ESCAPE sets STATUS2_ESCAPE_PREVENTION (:349-350).
describe('cycle 124 - No Retreat (EFFECT_NO_RETREAT)', () => {
  it('raises all five stats 6 -> 7, sets noRetreat and escape prevention; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_NO_RETREAT'), foe(), rng)
    const out = runVs(state, 'MOVE_NO_RETREAT')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
    ])
    expect(state.battlers[0]!.volatiles.noRetreat).toBe(true) // :8131
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true) // :349-350
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :340 (accuracy 0 -> one draw)
    expect(ppOf(state)).toBe(9) // ppreduce :342
  })

  it('a second use fails via trynoretreat (:8128) with the stages unchanged; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_NO_RETREAT'), foe(), rng)
    // The state after one use: noRetreat set, every stat one stage up.
    state.battlers[0]!.volatiles.noRetreat = true
    for (const stat of [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) {
      state.battlers[0]!.mon.statStages[stat] = 7
    }
    const out = runVs(state, 'MOVE_NO_RETREAT')
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectAutotomize data/battle_scripts_1.s:1617-1640: setstatchanger STAT_SPEED, 2
// (:1618), attackcanceler, attackstring, ppreduce (:1621), statbuffchange ... (:1622), then
// jumpifmovehadnoeffect BattleScript_MoveEnd (:1636 -- MOVE_RESULT_NO_EFFECT is
// MISSED|DOESNT_AFFECT_FOE|FAILED, include/constants/battle.h:389, and a maxed stat sets
// MOVE_RESULT_MISSED, battle_script_commands.c:9942), tryautotomize (:1637) ->
// VARIOUS_TRY_AUTOTOMIZE (battle_script_commands.c:7533-7540): autotomizeCount++ only when
// GetBattlerWeight > 1 (battle_util.c:6705-6734).
describe('cycle 124 - Autotomize (EFFECT_AUTOTOMIZE)', () => {
  it('Speed 6 -> 8 and the weight count 0 -> 1 (Mudkip weighs 76); no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AUTOTOMIZE'), foe(), rng)
    const out = runVs(state, 'MOVE_AUTOTOMIZE')
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8) // :1618 two stages
    expect(state.battlers[0]!.volatiles.autotomizeCount).toBe(1) // :7536
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 2 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :1621
  })

  it('at Speed 12 the stat change fails and jumpifmovehadnoeffect skips the count; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AUTOTOMIZE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_AUTOTOMIZE')
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.volatiles.autotomizeCount).toBe(0) // :1636 -> MoveEnd
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('a second use on a heavy mon stacks the count 1 -> 2 and clamps Speed 10 -> 12; PP 10 -> 9', () => {
    const rng = countRng()
    // Guzzlord weighs 8880, so after one use it is still 7880 (> 1) and the count can grow again.
    const state = battle(user('MOVE_AUTOTOMIZE', { speciesId: 'SPECIES_GUZZLORD' }), foe(), rng)
    state.battlers[0]!.volatiles.autotomizeCount = 1
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE - 2
    const out = runVs(state, 'MOVE_AUTOTOMIZE')
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE) // 10 + 2 clamped
    expect(state.battlers[0]!.volatiles.autotomizeCount).toBe(2)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 2 }])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('a weight-1 mon (Bariong has weight 0 -> clamped to 1) raises Speed but not the count', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AUTOTOMIZE', { speciesId: 'SPECIES_BARIONG' }), foe(), rng)
    runVs(state, 'MOVE_AUTOTOMIZE')
    // GetBattlerWeight returns 1 for a zero-weight species (:6731), and :7535 needs > 1.
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
    expect(state.battlers[0]!.volatiles.autotomizeCount).toBe(0)
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectDefenseUp3 data/battle_scripts_1.s:4248-4250: setstatchanger STAT_DEF, 3,
// FALSE -> BattleScript_EffectStatUp :3612-3632: attackcanceler, attackstring, ppreduce (:3616),
// statbuffchange MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR (:3617). No accuracycheck.
describe('cycle 124 - Cotton Guard (EFFECT_DEFENSE_UP_3)', () => {
  it('raises Defense by 3 stages 6 -> 9 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COTTON_GUARD'), foe(), rng)
    const out = runVs(state, 'MOVE_COTTON_GUARD')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(9) // 6 + 3
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 3 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :3616
  })

  it('at Defense 11 it clamps to 12 (delta +1); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COTTON_GUARD'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE - 1
    const out = runVs(state, 'MOVE_COTTON_GUARD')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE) // min(3, 12 - 11)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 1 }])
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })

  it('at Defense 12 nothing changes (B_MSG_STAT_WONT_INCREASE, :3618); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COTTON_GUARD'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_COTTON_GUARD')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    // STAT_BUFF_ALLOW_PTR makes ChangeStatBuffs set MOVE_RESULT_MISSED (:9942) even though it hit.
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(0) // no accuracycheck in this script
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSpeedSwap data/battle_scripts_1.s:2534-2545: attackcanceler, attackstring,
// ppreduce (:2537), accuracycheck ButItFailed, NO_ACC_CALC_CHECK_LOCK_ON (:2538 -- the lock-on
// branch of Cmd_accuracycheck, battle_script_commands.c:1403-1411, draws no random and fails on
// STATUS3_SEMI_INVULNERABLE / Protect), swapstatstages STAT_SPEED (:2539, Cmd_swapstatstages
// :13039-13048), swapstat BS_TARGET, STAT_SPEED (:2540, VARIOUS_SWAP_STAT :8879-8885).
describe('cycle 124 - Speed Swap (EFFECT_SPEED_SWAP)', () => {
  it('swaps the Speed stage (8/4) and the raw Speed stat (150/60); no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SPEED_SWAP'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = 8
    foeOf(state).mon.statStages[STAT_SPEED] = 4
    foeOf(state).mon.rawStats.spe = 60
    const out = runVs(state, 'MOVE_SPEED_SWAP')
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(4) // :13043-13044
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(8)
    expect(state.battlers[0]!.mon.rawStats.spe).toBe(60) // :8883 SWAP(stats[SPEED])
    expect(foeOf(state).mon.rawStats.spe).toBe(150)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPEED, change: -4 },
      { battlerId: 1, stat: STAT_SPEED, change: 4 },
    ])
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON
    expect(ppOf(state)).toBe(9) // ppreduce :2537
  })

  it('a semi-invulnerable target fails the accuracycheck (:1406-1407): nothing swaps; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SPEED_SWAP'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = 8
    foeOf(state).mon.statStages[STAT_SPEED] = 4
    foeOf(state).mon.rawStats.spe = 60
    foeOf(state).statuses3 = STATUS3_SEMI_INVULNERABLE
    const out = runVs(state, 'MOVE_SPEED_SWAP')
    expect(out.actions[0]?.missed).toBe(true) // ButItFailed -> MOVE_RESULT_FAILED
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(4)
    expect(state.battlers[0]!.mon.rawStats.spe).toBe(150)
    expect(foeOf(state).mon.rawStats.spe).toBe(60)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_TICKLE',
  'EFFECT_TOPSY_TURVY',
  'EFFECT_QUIVER_DANCE',
  'EFFECT_PSYCH_UP',
  'EFFECT_KINESIS',
  'EFFECT_VICTORY_DANCE',
  'EFFECT_POWER_TRICK',
  'EFFECT_COIL',
  'EFFECT_NO_RETREAT',
  'EFFECT_AUTOTOMIZE',
  'EFFECT_DEFENSE_UP_3',
  'EFFECT_SPEED_SWAP',
]

describe('cycle 124 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})

describe('cycle 124 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_TICKLE', 'EFFECT_TICKLE'],
    ['MOVE_TOPSY_TURVY', 'EFFECT_TOPSY_TURVY'],
    ['MOVE_QUIVER_DANCE', 'EFFECT_QUIVER_DANCE'],
    ['MOVE_PSYCH_UP', 'EFFECT_PSYCH_UP'],
    ['MOVE_KINESIS', 'EFFECT_KINESIS'],
    ['MOVE_VICTORY_DANCE', 'EFFECT_VICTORY_DANCE'],
    ['MOVE_POWER_TRICK', 'EFFECT_POWER_TRICK'],
    ['MOVE_COIL', 'EFFECT_COIL'],
    ['MOVE_NO_RETREAT', 'EFFECT_NO_RETREAT'],
    ['MOVE_AUTOTOMIZE', 'EFFECT_AUTOTOMIZE'],
    ['MOVE_COTTON_GUARD', 'EFFECT_DEFENSE_UP_3'],
    ['MOVE_SPEED_SWAP', 'EFFECT_SPEED_SWAP'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
