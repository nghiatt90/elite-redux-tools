/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 123: twelve stat boost/drop move effects. Every number below is derived by hand from the C:
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
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS2_SUBSTITUTE,
  STATUS3_CHARGED_UP,
  STATUS_FIELD_GRASSY_TERRAIN,
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

const THIS_FILE = 'web/src/engine/sim/cycle123StatEffects.test.ts'
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
const GRASS: [string, string, string] = ['GRASS', 'GRASS', 'GRASS']

// BattleScript_EffectRototiller data/battle_scripts_1.s:1322-1380: attackcanceler, attackstring,
// ppreduce (:1325), getrototillertargets BattleScript_ButItFailed (:1326,
// VARIOUS_GET_ROTOTILLER_TARGETS battle_script_commands.c:7998-8013), then the loop at :1332-1366:
// jumpifstat ATK < MAX (:1334) else jumpifstat SPATK == MAX -> CantRaiseMultipleStats (:1335);
// jumpifnotrototilleraffected -> NoEffect (:1337, VARIOUS_JUMP_IF_NOT_ROTOTILLER_AFFECTED :8014-8021);
// ATK +1 (:1342) or +2 (:1345) under Grassy Terrain ; SPATK +1 (:1353) or +2 (:1356).
// IsRototillerAffected (battle_script_commands.c:6640-6647): alive, grounded, Grass-type,
// not semi-invulnerable, not BlocksPrankster. The loop covers ALL battlers, the user included.
describe('cycle 123 - Rototiller (EFFECT_ROTOTILLER)', () => {
  it('raises a grounded Grass target Attack and Sp. Atk 6/6 -> 7/7; no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_ROTOTILLER'), foe({ types: GRASS }), rng)
    const out = runVs(state, 'MOVE_ROTOTILLER')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(7) // :1342 setstatchanger STAT_ATK, 1
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(7) // :1353 setstatchanger STAT_SPATK, 1
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 1, stat: STAT_ATK, change: 1 },
      { battlerId: 1, stat: STAT_SPATK, change: 1 },
    ])
    expect(rng.calls).toBe(0) // the script has no accuracycheck (:1322-1326)
    expect(ppOf(state)).toBe(9) // ppreduce :1325
  })

  it('in Grassy Terrain raises both by 2 (6/6 -> 8/8): jumpifword STATUS_FIELD_GRASSY_TERRAIN :1341-1346', () => {
    const rng = countRng()
    const state = battle(user('MOVE_ROTOTILLER'), foe({ types: GRASS }), rng)
    state.field.statuses = STATUS_FIELD_GRASSY_TERRAIN
    const out = runVs(state, 'MOVE_ROTOTILLER')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(8)
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(8)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 1, stat: STAT_ATK, change: 2 }, // BattleScript_RototillerAffected_Atk_Grassy :1345
      { battlerId: 1, stat: STAT_SPATK, change: 2 }, // :1356
    ])
    expect(ppOf(state)).toBe(9)
  })

  it('the Grass user itself is affected: the loop runs over every battler, non-Grass foe untouched', () => {
    const rng = countRng()
    const state = battle(user('MOVE_ROTOTILLER', { types: GRASS }), foe(), rng)
    const out = runVs(state, 'MOVE_ROTOTILLER')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE) // :1337 -> NoEffect
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
    ])
    expect(ppOf(state)).toBe(9)
  })

  it('with no affected battler (both non-Grass) it fails via getrototillertargets; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_ROTOTILLER'), foe(), rng)
    const out = runVs(state, 'MOVE_ROTOTILLER')
    // count == 0 at battle_script_commands.c:8011-8012 jumps to BattleScript_ButItFailed
    // (data/battle_scripts_1.s:1326), after ppreduce :1325.
    expect(out.actions[0]?.missed).toBe(true)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectDefenseDown2 data/battle_scripts_1.s:4296-4298 (`setstatchanger STAT_DEF, 2, TRUE`)
// -> BattleScript_EffectStatDown :3666-3687: attackcanceler, jumpifsubstituteblocks
// BattleScript_ButItFailedAtkStringPpReduce (:3668), accuracycheck ACC_CURR_MOVE (:3669),
// attackstring, ppreduce (:3672), statbuffchange STAT_BUFF_ALLOW_PTR (:3673).
// Screech is 85% accurate and a SOUND move (moves.json flags.sound), so DoesSubstituteBlockMove
// (battle_script_commands.c:12252-12259) returns FALSE for it -- a Substitute does NOT block it.
describe('cycle 123 - Screech (EFFECT_DEFENSE_DOWN_2)', () => {
  it('drops Defense 6 -> 4 with exactly one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SCREECH'), foe(), rng)
    const out = runVs(state, 'MOVE_SCREECH')
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(4) // stage 6 - 2
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: -2 }])
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :3669
    expect(ppOf(state)).toBe(9) // ppreduce :3672
  })

  it('at Defense stage 0 nothing changes (clamped); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SCREECH'), foe(), rng)
    foeOf(state).mon.statStages[STAT_DEF] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_SCREECH')
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(MIN_STAT_STAGE) // :9846 statValue = max(statValue, -stage)
    expect(out.actions[0]?.statChanges).toEqual([])
    // B_MSG_STAT_WONT_DECREASE and B_MSG_STAT_WONT_INCREASE are both 2
    // (include/constants/battle_string_ids.h:1088,1096), so :9942 still sets MOVE_RESULT_MISSED.
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute does NOT block Screech: IsSoundMove bypasses it (battle_script_commands.c:12254)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SCREECH'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_SCREECH')
    // DoesSubstituteBlockMove :12252-12259 checks STATUS2_SUBSTITUTE then IsSoundMove
    // (battle_util.c:9379, moves.json flags.sound) before returning TRUE. The drop still goes through.
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: -2 }])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('misses at accuracy stage 0 (85 * 1/3 = 28%) and changes nothing; PP 10 -> 9', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_SCREECH'), foe(), rng))
    const out = runVs(state, 'MOVE_SCREECH')
    expect(out.actions[0]?.missed).toBe(true) // accuracycheck :3669 -> BattleScript_PrintMoveMissed
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9) // PrintMoveMissed's ppreduce
  })

  it('Mist blocks the drop (ChangeStatBuffs :9770-9786) but PP is still spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SCREECH'), foe(), rng)
    state.sides[1].timers.mistTimer = 5
    const out = runVs(state, 'MOVE_SCREECH')
    expect(foeOf(state).mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1) // accuracy ran before statbuffchange
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectCosmicPower data/battle_scripts_1.s:6645-6668: attackcanceler, attackstring,
// ppreduce (:6648), then the guard at :6649-6650: jumpifstat DEF < MAX -> DoMoveAnim, else
// jumpifstat SPDEF == MAX -> BattleScript_CantRaiseMultipleStats; then DEF +1 (:6656) and
// SPDEF +1 (:6662). Both stats rise when either can.
describe('cycle 123 - Cosmic Power / Defend Order (EFFECT_COSMIC_POWER)', () => {
  it('raises Defense and Sp. Def 6/6 -> 7/7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COSMIC_POWER'), foe(), rng)
    const out = runVs(state, 'MOVE_COSMIC_POWER')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in the script
    expect(ppOf(state)).toBe(9) // ppreduce :6648
  })

  it('Defend Order carries its own effect key and raises both 6/6 -> 7/7; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DEFEND_ORDER'), foe(), rng)
    const out = runVs(state, 'MOVE_DEFEND_ORDER')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
    ])
    expect(ppOf(state)).toBe(9)
  })

  it('with Defense at 12 and Sp. Def at 6 only Sp. Def rises (6 -> 7); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COSMIC_POWER'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_COSMIC_POWER')
    // :6649 DEF < MAX is false, :6650 SPDEF == MAX is false -> DoMoveAnim runs both steps.
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPDEF, change: 1 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('with both at 12 the guard jumps to CantRaiseMultipleStats (:6650): nothing changes, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COSMIC_POWER'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_COSMIC_POWER')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectPainSplit data/battle_scripts_1.s:4691-4707: attackcanceler, attackstring,
// ppreduce (:4694), accuracycheck ... NO_ACC_CALC_CHECK_LOCK_ON (:4695, no RNG),
// painsplitdmgcalc (:4696, Cmd_painsplitdmgcalc battle_script_commands.c:10765-10786).
// hpDiff = (atkHp + tgtHp) / 2 with C integer division; both datahpupdate calls (:4701/:4704)
// carry HITMARKER_IGNORE_SUBSTITUTE (:4699), and Cmd_datahpupdate's heal path clamps to maxHP
// (battle_script_commands.c:1908-1911) -- a split above a mon's max HP stops at max HP.
describe('cycle 123 - Pain Split (EFFECT_PAIN_SPLIT)', () => {
  it('attacker 30, target 91 -> both 60 (121 / 2 floor); no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PAIN_SPLIT', { hp: 30 }), foe({ hp: 91 }), rng)
    const out = runVs(state, 'MOVE_PAIN_SPLIT')
    expect(state.battlers[0]!.mon.hp).toBe(60) // :10770 hpDiff = (30 + 91) / 2
    expect(foeOf(state).mon.hp).toBe(60)
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON draws nothing
    expect(ppOf(state)).toBe(9) // ppreduce :4694
  })

  it('an attacker above the target splits down: 95 / 20 -> 57 / 57 (115 / 2 floor)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PAIN_SPLIT', { hp: 95 }), foe({ hp: 20 }), rng)
    runVs(state, 'MOVE_PAIN_SPLIT')
    expect(state.battlers[0]!.mon.hp).toBe(57)
    expect(foeOf(state).mon.hp).toBe(57)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute blocks it inside painsplitdmgcalc (:10769-10771); HP unchanged, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PAIN_SPLIT', { hp: 30 }), foe({ hp: 91, status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_PAIN_SPLIT')
    // Cmd_painsplitdmgcalc's DoesSubstituteBlockMove branch jumps to BattleScript_ButItFailed (:4697),
    // which sets MOVE_RESULT_FAILED -- not the MOVE_RESULT_MISSED the sim's `missed` flag carries.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(30)
    expect(foeOf(state).mon.hp).toBe(91)
    expect(ppOf(state)).toBe(9)
  })

  it('a split above a mon\'s max HP is clamped by datahpupdate\'s heal path: 100/100 vs 40/40 -> 70 / 40', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PAIN_SPLIT', { hp: 100, maxHp: 100 }), foe({ hp: 40, maxHp: 40 }), rng)
    runVs(state, 'MOVE_PAIN_SPLIT')
    // hpDiff = 70. Attacker takes 100 - 70 = 30 damage -> 70. Target's gBattleMoveDamage is
    // 40 - 70 = -30 (a heal): hp 40 - (-30) = 70, then Cmd_datahpupdate clamps it to maxHP 40
    // (battle_script_commands.c:1908-1911), so it stays 40.
    expect(state.battlers[0]!.mon.hp).toBe(70)
    expect(foeOf(state).mon.hp).toBe(40)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectFocusEnergy data/battle_scripts_1.s:4190-4199: attackcanceler, attackstring,
// ppreduce (:4193), increasecrit BS_ATTACKER, 2, BattleScript_ButItFailed (:4194).
// VARIOUS_INCREASE_CRIT, battle_script_commands.c:8591-8601: increase = min(3 - critBoost, 2);
// if (!increase && ptr) jump to the fail script, else critBoost += increase.
describe('cycle 123 - Focus Energy (EFFECT_FOCUS_ENERGY)', () => {
  it('critBoost 0 -> 2 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FOCUS_ENERGY'), foe(), rng)
    const out = runVs(state, 'MOVE_FOCUS_ENERGY')
    expect(state.battlers[0]!.volatiles.critBoost).toBe(2) // min(3 - 0, 2) = 2 (:8594)
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :4193
  })

  it('critBoost 2 -> 3 (increase min(3 - 2, 2) = 1); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FOCUS_ENERGY'), foe(), rng)
    state.battlers[0]!.volatiles.critBoost = 2
    runVs(state, 'MOVE_FOCUS_ENERGY')
    expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
    expect(ppOf(state)).toBe(9)
  })

  it('critBoost 3 -> increase 0, BattleScript_ButItFailed (:4194); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FOCUS_ENERGY'), foe(), rng)
    state.battlers[0]!.volatiles.critBoost = 3
    const out = runVs(state, 'MOVE_FOCUS_ENERGY')
    expect(state.battlers[0]!.volatiles.critBoost).toBe(3) // :8599 only adds when increase != 0
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSpecialAttackDown2 data/battle_scripts_1.s:4308-4310
// (`setstatchanger STAT_SPATK, 2, TRUE`) -> BattleScript_EffectStatDown :3666-3687.
// Eerie Impulse is 100% accurate, not a sound move, so a Substitute blocks it.
describe('cycle 123 - Eerie Impulse (EFFECT_SPECIAL_ATTACK_DOWN_2)', () => {
  it('drops Sp. Atk 6 -> 4 with one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EERIE_IMPULSE'), foe(), rng)
    const out = runVs(state, 'MOVE_EERIE_IMPULSE')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: -2 }])
    expect(rng.calls).toBe(1) // accuracycheck :3669
    expect(ppOf(state)).toBe(9)
  })

  it('at Sp. Atk stage 0 nothing changes; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EERIE_IMPULSE'), foe(), rng)
    foeOf(state).mon.statStages[STAT_SPATK] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_EERIE_IMPULSE')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(out.actions[0]?.missed).toBe(true) // B_MSG_STAT_WONT_DECREASE is also 2, so :9942
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('against a Substitute it fails before any draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EERIE_IMPULSE'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_EERIE_IMPULSE')
    // :3668 -> ButItFailedAtkStringPpReduce sets MOVE_RESULT_FAILED, not MOVE_RESULT_MISSED.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSpecialDefenseUp2 data/battle_scripts_1.s:4264-4266
// (`setstatchanger STAT_SPDEF, 2, FALSE`) -> BattleScript_EffectStatUp :3612-3632:
// attackcanceler, attackstring, ppreduce (:3616), statbuffchange
// MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR (:3617). No accuracycheck.
describe('cycle 123 - Amnesia (EFFECT_SPECIAL_DEFENSE_UP_2)', () => {
  it('raises Sp. Def 6 -> 8 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AMNESIA'), foe(), rng)
    const out = runVs(state, 'MOVE_AMNESIA')
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(8) // stage 6 + 2
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPDEF, change: 2 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('at Sp. Def stage 11 it clamps to 12; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AMNESIA'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE - 1
    const out = runVs(state, 'MOVE_AMNESIA')
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(MAX_STAT_STAGE) // ChangeStatBuffs :9900 min()
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPDEF, change: 1 }])
    expect(ppOf(state)).toBe(9)
  })

  it('at Sp. Def stage 12 nothing changes (B_MSG_STAT_WONT_INCREASE, :3618); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AMNESIA'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_AMNESIA')
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    // STAT_BUFF_ALLOW_PTR makes ChangeStatBuffs set MOVE_RESULT_MISSED (:9942) even though the move hit.
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectEvasionDown2 data/battle_scripts_1.s:4316-4318
// (`setstatchanger STAT_EVASION, 2, TRUE`) -> BattleScript_EffectStatDown :3666-3687.
// Sweet Scent targets BOTH (moves.json); in singles getMoveTarget collapses BOTH onto the one foe,
// so the single-stat handler is called once with that foe as the target.
describe('cycle 123 - Sweet Scent (EFFECT_EVASION_DOWN_2)', () => {
  it('names the BOTH target but resolves to the one foe; drops its evasion 6 -> 4; PP 10 -> 9', () => {
    expect(DATA_CONTEXT.move('MOVE_SWEET_SCENT')?.target).toBe('BOTH')
    const rng = countRng()
    const state = battle(user('MOVE_SWEET_SCENT'), foe(), rng)
    const out = runVs(state, 'MOVE_SWEET_SCENT')
    expect(foeOf(state).mon.statStages[STAT_EVASION]).toBe(4)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_EVASION, change: -2 }])
    expect(rng.calls).toBe(1) // accuracycheck :3669
    expect(ppOf(state)).toBe(9)
  })

  it('at evasion stage 0 nothing changes; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SWEET_SCENT'), foe(), rng)
    foeOf(state).mon.statStages[STAT_EVASION] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_SWEET_SCENT')
    expect(foeOf(state).mon.statStages[STAT_EVASION]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('against a Substitute it fails before any draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SWEET_SCENT'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_SWEET_SCENT')
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.statStages[STAT_EVASION]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectStockpile data/battle_scripts_1.s:5979-6007: attackcanceler, attackstring,
// ppreduce (:5982), stockpile 0 (:5983, Cmd_stockpile case 0 battle_script_commands.c:9496-9507:
// counter >= 3 -> MOVE_RESULT_MISSED; else counter++, record stockpileBeforeDef/SpDef),
// then the guard at :5989-5990 and DEF +1 (:5994) / SPDEF +1 (:6000), then stockpile 1 (:6006,
// case 1 :9508-9515: record the net stages gained from this use).
describe('cycle 123 - Stockpile (EFFECT_STOCKPILE)', () => {
  it('first use: counter 0 -> 1, Def/SpDef 6/6 -> 7/7, recorded net 1/1; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STOCKPILE'), foe(), rng)
    const out = runVs(state, 'MOVE_STOCKPILE')
    expect(state.battlers[0]!.volatiles.stockpileCounter).toBe(1) // :9501
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(state.battlers[0]!.volatiles.stockpileDef).toBe(1) // :9509-9510
    expect(state.battlers[0]!.volatiles.stockpileSpDef).toBe(1)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :5982
  })

  it('a fourth use at counter 3 fails (case 0 :9497-9500): counter and stages unchanged, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STOCKPILE'), foe(), rng)
    state.battlers[0]!.volatiles.stockpileCounter = 3
    state.battlers[0]!.mon.statStages[STAT_DEF] = 9
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = 9
    const out = runVs(state, 'MOVE_STOCKPILE')
    expect(state.battlers[0]!.volatiles.stockpileCounter).toBe(3)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(9)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(9)
    expect(out.actions[0]?.missed).toBe(true) // MOVE_RESULT_MISSED at :9498
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(ppOf(state)).toBe(9)
  })

  it('Def already 12 with Sp. Def 6: only Sp. Def rises and stockpileDef stays 0 (:9509-9514)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STOCKPILE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_STOCKPILE')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(state.battlers[0]!.volatiles.stockpileDef).toBe(0) // 12 - 12
    expect(state.battlers[0]!.volatiles.stockpileSpDef).toBe(1) // 7 - 6
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPDEF, change: 1 }])
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectCharge data/battle_scripts_1.s:6222-6240: attackcanceler, attackstring,
// ppreduce (:6225), setcharge (:6226, Cmd_setcharge battle_script_commands.c:11620-11623 sets
// STATUS3_CHARGED_UP), then SPDEF +1 (:6229) through statbuffchange. The flag is set before the
// stat change, so it lands even when Sp. Def is already maxed.
describe('cycle 123 - Charge (EFFECT_CHARGE)', () => {
  it('sets STATUS3_CHARGED_UP and raises Sp. Def 6 -> 7 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CHARGE'), foe(), rng)
    const out = runVs(state, 'MOVE_CHARGE')
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true) // :11621
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPDEF, change: 1 }])
    expect(rng.calls).toBe(0) // Charge's 100% accuracy never rolls: no accuracycheck in the script
    expect(ppOf(state)).toBe(9) // ppreduce :6225
  })

  it('at Sp. Def stage 12 it still sets the flag while Sp. Def stays 12; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CHARGE'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_CHARGE')
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectBellyDrum data/battle_scripts_1.s:5592-5604: attackcanceler, attackstring,
// ppreduce (:5595), maxattackhalvehp BattleScript_ButItFailed (:5596,
// Cmd_maxattackhalvehp battle_script_commands.c:11338-11351): halfHp = maxHP / 2 (1 if 0);
// succeeds only if hp > halfHp AND ChangeStatBuffs(attacker, 12, STAT_ATK, MOVE_EFFECT_AFFECTS_USER, 0)
// is nonzero; damage = maxHP / 2 (1 if 0), Attack goes to 12.
describe('cycle 123 - Belly Drum (EFFECT_BELLY_DRUM)', () => {
  it('hp 100/100 -> hp 50 and Attack 12; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BELLY_DRUM'), foe(), rng)
    const out = runVs(state, 'MOVE_BELLY_DRUM')
    expect(state.battlers[0]!.mon.hp).toBe(50) // :11347 gBattleMoveDamage = maxHP / 2
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE) // +12 -> clamped 12
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_ATK, change: 6 }, // 6 -> 12
    ])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :5595
  })

  it('hp exactly half (50/100) fails: hp > halfHp is false; HP and Attack unchanged, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BELLY_DRUM', { hp: 50 }), foe(), rng)
    const out = runVs(state, 'MOVE_BELLY_DRUM')
    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    // maxattackhalvehp's else branch jumps to BattleScript_ButItFailed (MOVE_RESULT_FAILED,
    // not MOVE_RESULT_MISSED), so the sim records no stat change and no damage.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(ppOf(state)).toBe(9)
  })

  it('hp 51/100 succeeds -> hp 1 and Attack 12; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BELLY_DRUM', { hp: 51 }), foe(), rng)
    runVs(state, 'MOVE_BELLY_DRUM')
    expect(state.battlers[0]!.mon.hp).toBe(1)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })

  it('Attack already 12 fails via ChangeStatBuffs returning 0 (:11346): HP unchanged, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BELLY_DRUM'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_BELLY_DRUM')
    expect(state.battlers[0]!.mon.hp).toBe(100)
    // ChangeStatBuffs returns 0, so maxattackhalvehp takes BattleScript_ButItFailed and no HP is spent.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(ppOf(state)).toBe(9)
  })

  it('odd max HP 101: halfHp = floor(101 / 2) = 50, so hp 101 -> 51; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BELLY_DRUM', { hp: 101, maxHp: 101 }), foe(), rng)
    runVs(state, 'MOVE_BELLY_DRUM')
    expect(state.battlers[0]!.mon.hp).toBe(51) // 101 - 50
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectShellSmash data/battle_scripts_1.s:1800-1844: attackcanceler, attackstring,
// ppreduce (:1803), fail guard :1804-1808 (ATK/SPATK/SPEED all not < MAX and DEF not > MIN and
// SPDEF == MIN -> BattleScript_ButItFailed); then DEF -1 and SPDEF -1 with
// MOVE_EFFECT_CERTAIN (:1812-1819), then ATK +2 (:1825), SPATK +2 (:1832), SPEED +2 (:1839).
describe('cycle 123 - Shell Smash (EFFECT_SHELL_SMASH)', () => {
  it('6s -> Def 5, SpDef 5, Atk 8, SpAtk 8, Spe 8 with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHELL_SMASH'), foe(), rng)
    const out = runVs(state, 'MOVE_SHELL_SMASH')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(5)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(5)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: -1 },
      { battlerId: 0, stat: STAT_SPDEF, change: -1 },
      { battlerId: 0, stat: STAT_ATK, change: 2 },
      { battlerId: 0, stat: STAT_SPATK, change: 2 },
      { battlerId: 0, stat: STAT_SPEED, change: 2 },
    ])
    expect(rng.calls).toBe(0) // no accuracycheck in the script
    expect(ppOf(state)).toBe(9) // ppreduce :1803
  })

  it('Attack 11 clamps to 12 (delta +1) while the rest apply; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHELL_SMASH'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE - 1
    const out = runVs(state, 'MOVE_SHELL_SMASH')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: -1 },
      { battlerId: 0, stat: STAT_SPDEF, change: -1 },
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_SPATK, change: 2 },
      { battlerId: 0, stat: STAT_SPEED, change: 2 },
    ])
    expect(ppOf(state)).toBe(9)
  })

  it('guard fails only when all three offensive stats are 12 and Def/SpDef are 0 (:1804-1808); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHELL_SMASH'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_DEF] = MIN_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_SHELL_SMASH')
    // The guard's last jump (:1808) goes to BattleScript_ButItFailed (MOVE_RESULT_FAILED), so
    // no stat changes are recorded and none of the five stages move.
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(MIN_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(MIN_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })

  it('guard passes when only Def is off its cap: Atk/SpAtk/Spe 12, Def 3, SpDef 6 -> Def 2, SpDef 5', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHELL_SMASH'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_DEF] = 3
    const out = runVs(state, 'MOVE_SHELL_SMASH')
    // :1807 DEF > MIN is true, so the guard never reaches :1808 and the move runs.
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(2)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(5)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: -1 },
      { battlerId: 0, stat: STAT_SPDEF, change: -1 },
    ])
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_ROTOTILLER',
  'EFFECT_DEFENSE_DOWN_2',
  'EFFECT_COSMIC_POWER',
  'EFFECT_PAIN_SPLIT',
  'EFFECT_FOCUS_ENERGY',
  'EFFECT_SPECIAL_ATTACK_DOWN_2',
  'EFFECT_SPECIAL_DEFENSE_UP_2',
  'EFFECT_EVASION_DOWN_2',
  'EFFECT_STOCKPILE',
  'EFFECT_CHARGE',
  'EFFECT_BELLY_DRUM',
  'EFFECT_SHELL_SMASH',
]

describe('cycle 123 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})

describe('cycle 123 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_ROTOTILLER', 'EFFECT_ROTOTILLER'],
    ['MOVE_SCREECH', 'EFFECT_DEFENSE_DOWN_2'],
    ['MOVE_COSMIC_POWER', 'EFFECT_COSMIC_POWER'],
    ['MOVE_DEFEND_ORDER', 'EFFECT_COSMIC_POWER'],
    ['MOVE_PAIN_SPLIT', 'EFFECT_PAIN_SPLIT'],
    ['MOVE_FOCUS_ENERGY', 'EFFECT_FOCUS_ENERGY'],
    ['MOVE_EERIE_IMPULSE', 'EFFECT_SPECIAL_ATTACK_DOWN_2'],
    ['MOVE_AMNESIA', 'EFFECT_SPECIAL_DEFENSE_UP_2'],
    ['MOVE_SWEET_SCENT', 'EFFECT_EVASION_DOWN_2'],
    ['MOVE_STOCKPILE', 'EFFECT_STOCKPILE'],
    ['MOVE_CHARGE', 'EFFECT_CHARGE'],
    ['MOVE_BELLY_DRUM', 'EFFECT_BELLY_DRUM'],
    ['MOVE_SHELL_SMASH', 'EFFECT_SHELL_SMASH'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
