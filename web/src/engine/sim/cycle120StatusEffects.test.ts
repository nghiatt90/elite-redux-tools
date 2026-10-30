/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 120: status-infliction move effects, Spite through Poison Powder. Every number below is derived
// by hand from the C: the script line in data/battle_scripts_1.s and the command in
// src/battle_script_commands.c / src/battle_util.c are cited on the test that asserts it. Stat stages
// run 0..12 here (neutral 6), so the C's MIN_STAT_STAGE is stage 0 and MAX_STAT_STAGE stage 12.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  MOVE_UNSET,
  SIDE_STATUS_SAFEGUARD,
  STAT_ACC,
  STAT_ATK,
  STAT_EVASION,
  STAT_SPATK,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS2_DESTINY_BOND,
  STATUS2_ENRAGED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_MULTIPLETURNS,
  STATUS2_SUBSTITUTE,
  STATUS3_GASTRO_ACID,
  STATUS3_IMPRISONED_OTHERS,
  STATUS3_MIRACLE_EYED,
  STATUS3_ON_AIR,
  STATUS3_PERISH_SONG,
  STATUS4_COMMANDED,
  STATUS4_FORESIGHT,
  WEATHER_RAIN_ANY,
  hasFlag,
  setFlag,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { buildAccuracyInputs, executeTurn, getTotalAccuracy } from './turn'

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

/** Records the id of every move that reached the damage engine (i.e. was actually executed). */
function recordingDamage(): DamageResolver & { moves: string[] } {
  const moves: string[] = []
  return {
    moves,
    resolve: (_state: BattleState, _attackerId: number, _targetId: number, action: ChosenAction) => {
      moves.push(action.chosenMove!.id)
      return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
    },
  }
}

const THIS_FILE = 'web/src/engine/sim/cycle120StatusEffects.test.ts'
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

// BattleScript_EffectSpite data/battle_scripts_1.s:4821-4831; Cmd_tryspiteppreduce
// src/battle_script_commands.c:10975-11020. B_CAN_SPITE_FAIL = GEN_7, so the #else branch (pp[i] == 0
// fails) is compiled; B_PP_REDUCED_BY_SPITE = GEN_7, so it is a flat 4 with no Random() draw.
describe('cycle 120 - Spite', () => {
  const spiteTarget = (overrides: Partial<SimBattleMon> = {}) =>
    foe({ moves: ['MOVE_SCRATCH', null, null, null], pp: [10, 0, 0, 0], ...overrides })

  it('reduces the last move PP by 4 (10 -> 6) after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SPITE'), spiteTarget(), rng)
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    const out = runVs(state, 'MOVE_SPITE')
    expect(foeOf(state).mon.pp[0]).toBe(6) // :10994-11000
    expect(rng.calls).toBe(1) // accuracycheck :4825 (ppreduce :4824 runs first)
    expect(ppOf(state)).toBe(9) // ppreduce :4824
    expect(out.actions[0]?.missed).toBe(false)
  })

  it('clamps 3 PP to 0 and cancels the target\'s multi-turn move (CancelMultiTurnMoves, :11014)', () => {
    const state = battle(user('MOVE_SPITE'), spiteTarget({ pp: [3, 0, 0, 0], status2: STATUS2_MULTIPLETURNS }), countRng())
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    runVs(state, 'MOVE_SPITE')
    expect(foeOf(state).mon.pp[0]).toBe(0)
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
  })

  it('fails when the last move still has 0 PP (:10984 #else branch), leaving it at 0; PP spent', () => {
    const state = battle(user('MOVE_SPITE'), spiteTarget({ pp: [0, 0, 0, 0] }), countRng())
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    const out = runVs(state, 'MOVE_SPITE')
    expect(foeOf(state).mon.pp[0]).toBe(0)
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when there is no last move (0 / 0xFFFF, :10976), leaving the target alone; PP spent', () => {
    for (const lastMove of [null, MOVE_UNSET]) {
      const state = battle(user('MOVE_SPITE'), spiteTarget(), countRng())
      foeOf(state).lastMove = lastMove
      const out = runVs(state, 'MOVE_SPITE')
      expect(out.actions[0]?.missed).toBe(true)
      expect(foeOf(state).mon.pp[0]).toBe(10)
      expect(ppOf(state)).toBe(9)
    }
  })

  it('fails when the last move is not in the target\'s moveset (:10980-10984)', () => {
    const state = battle(user('MOVE_SPITE'), spiteTarget(), countRng())
    foeOf(state).lastMove = 'MOVE_EMBER'
    const out = runVs(state, 'MOVE_SPITE')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.pp[0]).toBe(10)
  })

  it('a miss at accuracy stage 0 (33%) leaves PP alone; PP still spent', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_SPITE'), spiteTarget(), rng))
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    const out = runVs(state, 'MOVE_SPITE')
    expect(foeOf(state).mon.pp[0]).toBe(10)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectMeanLook data/battle_scripts_1.s:4890-4907; accuracycheck uses
// NO_ACC_CALC_CHECK_LOCK_ON (:4894, battle_script_commands.c:1403-1411), B_GHOSTS_ESCAPE = GEN_7.
describe('cycle 120 - Mean Look / Block / Spider Web', () => {
  it.each(['MOVE_MEAN_LOOK', 'MOVE_BLOCK', 'MOVE_SPIDER_WEB'])('%s sets STATUS2_ESCAPE_PREVENTION with no accuracy draw; PP 10 -> 9', (moveId) => {
    const rng = countRng()
    const state = battle(user(moveId), foe(), rng)
    foeOf(state).volatiles.battlerPreventingEscape = 5 // prove the handler overwrites it
    runVs(state, moveId)
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(foeOf(state).volatiles.battlerPreventingEscape).toBe(0) // attacker id, seteffectprimary :4903-4904
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON draws nothing
    expect(ppOf(state)).toBe(9) // ppreduce :4893
  })

  it('fails when the target is already trapped (:4896)', () => {
    const state = battle(user('MOVE_MEAN_LOOK'), foe({ status2: STATUS2_ESCAPE_PREVENTION }), countRng())
    const out = runVs(state, 'MOVE_MEAN_LOOK')
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('fails against a Ghost-type target (:4898-4900, B_GHOSTS_ESCAPE >= GEN_6)', () => {
    const state = battle(user('MOVE_MEAN_LOOK'), foe({ types: ['GHOST', 'MYSTERY', 'MYSTERY'] }), countRng())
    const out = runVs(state, 'MOVE_MEAN_LOOK')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
  })

  it('fails behind a Substitute (:4897)', () => {
    const state = battle(user('MOVE_MEAN_LOOK'), foe({ status2: STATUS2_SUBSTITUTE }), countRng())
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_MEAN_LOOK')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
  })

  it('fails against a COMMANDED target (:4895)', () => {
    const state = battle(user('MOVE_MEAN_LOOK'), foe(), countRng())
    foeOf(state).statuses4 = setFlag(0, STATUS4_COMMANDED)
    const out = runVs(state, 'MOVE_MEAN_LOOK')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectForesight data/battle_scripts_1.s:5069-5082; Cmd_setforesight
// src/battle_script_commands.c:11127-11130.
describe('cycle 120 - Foresight / Odor Sleuth', () => {
  it.each(['MOVE_FORESIGHT', 'MOVE_ODOR_SLEUTH'])('%s sets STATUS4_FORESIGHT with no accuracy draw; PP 10 -> 9', (moveId) => {
    const rng = countRng()
    const state = battle(user(moveId), foe(), rng)
    runVs(state, moveId)
    expect(hasFlag(foeOf(state).statuses4, STATUS4_FORESIGHT)).toBe(true) // Cmd_setforesight :11127
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON (:5073)
    expect(ppOf(state)).toBe(9) // ppreduce :5072
  })

  it('a second use fails (:5074) and leaves the flag set; PP spent', () => {
    const state = battle(user('MOVE_FORESIGHT'), foe(), countRng())
    foeOf(state).statuses4 = setFlag(0, STATUS4_FORESIGHT)
    const out = runVs(state, 'MOVE_FORESIGHT')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(foeOf(state).statuses4, STATUS4_FORESIGHT)).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('the flag reaches the accuracy bridge: it ignores the defender\'s evasion stage (:1336-1337)', () => {
    const state = battle(user('MOVE_FORESIGHT'), foe(), countRng())
    foeOf(state).mon.statStages[STAT_EVASION] = MAX_STAT_STAGE // +6 evasion
    runVs(state, 'MOVE_FORESIGHT')

    const withForesight = buildAccuracyInputs(state, 0, 1, 'MOVE_TACKLE', false, loopDeps(state, fixedDamage(0)))
    expect(withForesight.inputs.defenderHasForesight).toBe(true) // accuracyBridge.ts:292
    expect(getTotalAccuracy(withForesight.inputs).accuracy).toBe(100) // acc stage 6 -> 1/1

    foeOf(state).statuses4 = 0
    const without = buildAccuracyInputs(state, 0, 1, 'MOVE_TACKLE', false, loopDeps(state, fixedDamage(0)))
    expect(without.inputs.defenderHasForesight).toBe(false)
    expect(getTotalAccuracy(without.inputs).accuracy).toBe(33) // stage 0 ratio 1/3
  })
})

// BattleScript_EffectMiracleEye data/battle_scripts_1.s:2705-2712; Cmd_setmiracleeye
// src/battle_script_commands.c:9448-9455.
describe('cycle 120 - Miracle Eye', () => {
  it('sets STATUS3_MIRACLE_EYED after the accuracy check (accuracy 0 -> 101, but Cmd_accuracycheck still calls Random()); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MIRACLE_EYE'), foe(), rng)
    runVs(state, 'MOVE_MIRACLE_EYE')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_MIRACLE_EYED)).toBe(true)
    // Miracle Eye's script uses ACC_CURR_MOVE (:2707), not NO_ACC_CALC_CHECK_LOCK_ON.
    // battle_script_commands.c:1433 calls Random() before comparing, so the 101 sentinel
    // still consumes one draw (it just can never miss: Random() % 100 <= 99).
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9) // ppreduce :2709
  })

  it('a second use fails (:9451) and leaves the flag set; PP spent', () => {
    const state = battle(user('MOVE_MIRACLE_EYE'), foe(), countRng())
    foeOf(state).statuses3 = setFlag(0, STATUS3_MIRACLE_EYED)
    const out = runVs(state, 'MOVE_MIRACLE_EYE')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_MIRACLE_EYED)).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('a semi-invulnerable target makes the accuracy check miss (:1406-1407), so nothing is set; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MIRACLE_EYE'), foe(), rng)
    foeOf(state).statuses3 = setFlag(0, STATUS3_ON_AIR)
    const out = runVs(state, 'MOVE_MIRACLE_EYE')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_MIRACLE_EYED)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectParalyzeIgnoreType data/battle_scripts_1.s:4346-4360: attackcanceler,
// attackstring, ppreduce, requirecandoeffect (CanBeParalyzedIgnoreType, battle_util.c:5082-5088),
// accuracycheck, then MOVE_EFFECT_PARALYSIS | MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES.
describe('cycle 120 - Glare / Stun Spore (EFFECT_PARALYZE_IGNORE_TYPE)', () => {
  it.each(['MOVE_GLARE', 'MOVE_STUN_SPORE'])('%s paralyses an Electric-type target, ignoring the Electric immunity (:4350, :4356-4357)', (moveId) => {
    const rng = countRng()
    const state = battle(user(moveId), foe({ types: ['ELECTRIC', 'MYSTERY', 'MYSTERY'] }), rng)
    runVs(state, moveId)
    expect(foeOf(state).mon.status1).toBe(STATUS1_PARALYSIS)
    expect(rng.calls).toBe(1) // accuracycheck :4352
    expect(ppOf(state)).toBe(9) // ppreduce :4349
  })

  it('paralyses a Ground-type target too: the script has no typecalc (:4346-4360)', () => {
    const state = battle(user('MOVE_GLARE'), foe({ types: ['GROUND', 'MYSTERY', 'MYSTERY'] }), countRng())
    runVs(state, 'MOVE_GLARE')
    expect(foeOf(state).mon.status1).toBe(STATUS1_PARALYSIS)
  })

  it('an already-statused target fails in requirecandoeffect BEFORE the accuracy roll; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GLARE'), foe({ status1: STATUS1_BURN }), rng)
    runVs(state, 'MOVE_GLARE')
    expect(foeOf(state).mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 (33%) leaves the target unparalysed; PP still spent', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_GLARE'), foe(), rng))
    const out = runVs(state, 'MOVE_GLARE')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSkillSwap data/battle_scripts_1.s:6449-6472; Cmd_tryswapabilities
// src/battle_script_commands.c:11923-11946; B_SKILL_SWAP = GEN_7, so switchinabilities runs for
// attacker then target (:6466-6470).
describe('cycle 120 - Skill Swap', () => {
  it('swaps both abilities and fires both new owners\' switch-in abilities; no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SKILL_SWAP', { abilities: only('ABILITY_DRIZZLE') }), foe({ abilities: only('ABILITY_INTIMIDATE') }), rng)
    const out = runVs(state, 'MOVE_SKILL_SWAP')
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_INTIMIDATE')
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_DRIZZLE')
    // Attacker-first (:6469): its new Intimidate drops the target's Attack by 1.
    expect(foeOf(state).mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(5)
    // Then the target's new Drizzle sets rain.
    expect((state.field.weather & WEATHER_RAIN_ANY) !== 0).toBe(true)
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON (:6453)
    expect(ppOf(state)).toBe(9) // ppreduce :6452
  })

  it('fails when either ability is role-play banned (:11925), leaving both alone; PP spent', () => {
    const state = battle(user('MOVE_SKILL_SWAP', { abilities: only('ABILITY_INTIMIDATE') }), foe({ abilities: only('ABILITY_WONDER_GUARD') }), countRng())
    const out = runVs(state, 'MOVE_SKILL_SWAP')
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_INTIMIDATE')
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_WONDER_GUARD')
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when either side holds an Ability Shield (:11926), leaving both abilities alone', () => {
    const state = battle(
      user('MOVE_SKILL_SWAP', { abilities: only('ABILITY_DRIZZLE'), itemId: 'ITEM_ABILITY_SHIELD' }),
      foe({ abilities: only('ABILITY_INTIMIDATE') }),
      countRng(),
    )
    const out = runVs(state, 'MOVE_SKILL_SWAP')
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_DRIZZLE')
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_INTIMIDATE')
    expect(out.actions[0]?.missed).toBe(true)
  })
})

// BattleScript_EffectGastroAcid data/battle_scripts_1.s:2581-2596; Cmd_setgastroacid
// src/battle_script_commands.c:11831-11838; the failure branch jumps to BattleScript_EffectPoison
// (:4332-4344), so the move then tries to poison the target.
describe('cycle 120 - Gastro Acid', () => {
  it('success: suppresses the target ability and then poisons it; one accuracy draw, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GASTRO_ACID'), foe({ abilities: only('ABILITY_OVERGROW') }), rng)
    runVs(state, 'MOVE_GASTRO_ACID')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_GASTRO_ACID)).toBe(true) // :11837
    expect(foeOf(state).mon.status1 & STATUS1_POISON).toBe(STATUS1_POISON) // setmoveeffect :2594-2595
    expect(rng.calls).toBe(1) // accuracycheck :2583
    expect(ppOf(state)).toBe(9) // ppreduce :2585
  })

  it('failure branch (already suppressed): runs BattleScript_EffectPoison, so two accuracy draws and two PP; poison still applies', () => {
    // Both accuracy checks use ACC_CURR_MOVE (Gastro Acid, accuracy 100), so both draws are 0.
    const rng = scriptRng([0, 0])
    const state = battle(user('MOVE_GASTRO_ACID'), foe({ abilities: only('ABILITY_OVERGROW') }), rng)
    foeOf(state).statuses3 = setFlag(0, STATUS3_GASTRO_ACID)
    runVs(state, 'MOVE_GASTRO_ACID')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    expect(foeOf(state).mon.status1 & STATUS1_POISON).toBe(STATUS1_POISON) // :4340-4341
    expect(rng.calls).toBe(2) // :2583, then the poison script's :4337
    expect(ppOf(state)).toBe(8) // ppreduce :2585, then BattleScript_EffectPoison's :4335
  })

  it('a miss on the first accuracy check suppresses nothing and poisons nothing; PP spent once', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_GASTRO_ACID'), foe(), rng))
    const out = runVs(state, 'MOVE_GASTRO_ACID')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    expect(foeOf(state).mon.status1).toBe(0)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectFlatter data/battle_scripts_1.s:6069-6088; Cmd_jumpifenragedandstatmaxed
// src/battle_script_commands.c:11169-11174; MOVE_EFFECT_ENRAGE :3025-3029.
describe('cycle 120 - Flatter', () => {
  it('raises SpAtk by 1 (6 -> 7) and enrages after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FLATTER'), foe(), rng)
    const out = runVs(state, 'MOVE_FLATTER')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(7)
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ENRAGED)).toBe(true)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: 1 }])
    expect(out.actions[0]?.statusApplied).toEqual({ battlerId: 1, status: 'ENRAGED' })
    expect(rng.calls).toBe(1) // accuracycheck :6072
    expect(ppOf(state)).toBe(9) // ppreduce :6074
  })

  it('already enraged with SpAtk at +5 (stage 11) still raises to +6 and does not re-enrage', () => {
    const state = battle(user('MOVE_FLATTER'), foe({ status2: STATUS2_ENRAGED }), countRng())
    foeOf(state).mon.statStages[STAT_SPATK] = MAX_STAT_STAGE - 1
    const out = runVs(state, 'MOVE_FLATTER')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: 1 }])
    expect(out.actions[0]?.statusApplied).toBeNull() // REQUIRE_NOT already-enraged (:3026)
  })

  it('already enraged with SpAtk at +6 fails (:6075): no stat change, status stays enraged; PP spent', () => {
    const state = battle(user('MOVE_FLATTER'), foe({ status2: STATUS2_ENRAGED }), countRng())
    foeOf(state).mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_FLATTER')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ENRAGED)).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute absorbs it (:6071 -> MakeMoveMissed): no draw, no stat change, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FLATTER'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_FLATTER')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ENRAGED)).toBe(false)
    expect(foeOf(state).mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a raise that cannot happen (SpAtk already +6, not enraged) still falls through to the enrage step (:6079 -> FlatterTryConfuse)', () => {
    // jumpifenragedandstatmaxed (:6074) only fails when BOTH conditions hold; with the stage maxed but
    // the target not enraged, statbuffchange reports B_MSG_STAT_WONT_INCREASE and :6078 jumps to the
    // enrage step anyway.
    const state = battle(user('MOVE_FLATTER'), foe(), countRng())
    foeOf(state).mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_FLATTER')
    expect(foeOf(state).mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ENRAGED)).toBe(true)
    expect(out.actions[0]?.statusApplied).toEqual({ battlerId: 1, status: 'ENRAGED' })
  })
})

// BattleScript_EffectImprison data/battle_scripts_1.s:6473-6482; Cmd_tryimprison
// src/battle_script_commands.c:11948-11977; CANCELLER_IMPRISONED battle_util.c:3358-3367.
describe('cycle 120 - Imprison', () => {
  const imprisonUser = (overrides: Partial<SimBattleMon> = {}) =>
    user('MOVE_IMPRISON', { moves: ['MOVE_IMPRISON', 'MOVE_TACKLE', null, null], pp: [10, 15, 0, 0], ...overrides })

  it('sets STATUS3_IMPRISONED_OTHERS on the user when a foe shares a move; no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(imprisonUser(), foe(), rng) // the default foe knows Tackle
    runVs(state, 'MOVE_IMPRISON')
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_IMPRISONED_OTHERS)).toBe(true) // :11969
    expect(rng.calls).toBe(0) // the script has no accuracycheck (:6473-6482)
    expect(ppOf(state)).toBe(9) // ppreduce :6476
  })

  it('fails when no foe shares a move (:11974-11975); PP spent', () => {
    const state = battle(user('MOVE_IMPRISON'), foe(), countRng()) // user knows only Imprison
    const out = runVs(state, 'MOVE_IMPRISON')
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_IMPRISONED_OTHERS)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails (:11949) and leaves the flag set; PP spent', () => {
    const state = battle(imprisonUser(), foe(), countRng())
    state.battlers[0]!.statuses3 = setFlag(0, STATUS3_IMPRISONED_OTHERS)
    const out = runVs(state, 'MOVE_IMPRISON')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_IMPRISONED_OTHERS)).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('behavioural: the imprisoned foe\'s shared Tackle is cancelled by CANCELLER_IMPRISONED before PP and accuracy', () => {
    const damage = recordingDamage()
    const state = battle(imprisonUser(), foe(), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_IMPRISON'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, damage))
    const foeAction = out.actions.find((a) => a.battlerId === 1)!
    expect(foeAction.cancelledBy).toBe('IMPRISON')
    expect(damage.moves).toEqual([]) // never reached the damage engine
    expect(foeOf(state).mon.pp[0]).toBe(20) // cancelled before ppreduce
  })
})

// BattleScript_EffectDestinyBond data/battle_scripts_1.s:4785-4794; Cmd_setdestinybond
// src/battle_script_commands.c:10943-10946; TrySetDestinyBondToHappen :10948-10954.
describe('cycle 120 - Destiny Bond', () => {
  it('sets STATUS2_DESTINY_BOND on the user with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DESTINY_BOND'), foe(), rng)
    runVs(state, 'MOVE_DESTINY_BOND')
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_DESTINY_BOND)).toBe(true) // :10944
    expect(rng.calls).toBe(0) // the script has no accuracycheck (:4785-4794)
    expect(ppOf(state)).toBe(9) // ppreduce :4788
  })

  it('a bonded user KO\'d by the foe takes the foe down (Cmd_tryfaintmon :3244-3248)', () => {
    const state = battle(user('MOVE_DESTINY_BOND'), foe(), countRng())
    executeTurn(state, [useMove(1, 'MOVE_DESTINY_BOND'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(100)))
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(foeOf(state).mon.hp).toBe(0) // takes the attacker's current HP (:3250)
  })

  it('same-side damage does not trigger it: the guard requires opposite sides (:10950)', () => {
    // Four battlers: 0 and 2 are allies. Both foes of battler 2 are fainted, so its FOES_AND_ALLY
    // Earthquake falls back to its ally (getMoveTarget's partner fallback), letting the ally land a
    // hit without executeTurn's SELECTED targeting rewriting the destination.
    const four = createBattleState({
      battlers: [
        createBattlerState(0, monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] }), 0),
        createBattlerState(1, monFor('SPECIES_MUDKIP', { hp: 0 }), 0),
        createBattlerState(2, monFor('SPECIES_MUDKIP', { moves: ['MOVE_EARTHQUAKE', null, null, null], pp: [10, 0, 0, 0] }), 0),
        createBattlerState(3, monFor('SPECIES_MUDKIP', { hp: 0 }), 0),
      ],
      rng: countRng(),
    })
    four.battlers[0]!.mon.status2 = setFlag(0, STATUS2_DESTINY_BOND)
    executeTurn(four, [null, null, useMove(0, 'MOVE_EARTHQUAKE'), null], loopDeps(four, fixedDamage(100)))
    expect(four.battlers[0]!.mon.hp).toBe(0)
    expect(four.battlers[2]!.mon.hp).toBe(100) // the ally is unharmed
    expect(four.battlers[2]!.mon.pp[0]).toBe(9) // the Earthquake did execute (not skipped)
  })

  it('CANCELLER_FLAGS clears the user\'s flag on its next move (battle_util.c:3204-3208)', () => {
    const state = battle(user('MOVE_DESTINY_BOND', { moves: ['MOVE_DESTINY_BOND', 'MOVE_TACKLE', null, null], pp: [10, 15, 0, 0] }), foe(), countRng())
    state.battlers[0]!.mon.status2 = setFlag(0, STATUS2_DESTINY_BOND)
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(0)))
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_DESTINY_BOND)).toBe(false)
    expect(state.battlers[0]!.mon.pp[1]).toBe(14) // the move itself ran
  })
})

// BattleScript_EffectPerishSong data/battle_scripts_1.s:5083-5100; Cmd_trysetperishsong
// src/battle_script_commands.c:11132-11145; IsSoundproof battle_util.c:8864-8871;
// BlocksPrankster battle_util.c:8622-8635.
describe('cycle 120 - Perish Song', () => {
  it('sets STATUS3_PERISH_SONG and timer 3 on both battlers (2 after the end-of-turn tick) with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PERISH_SONG'), foe(), rng)
    runVs(state, 'MOVE_PERISH_SONG')
    // :11140-11142 sets 3; HandleWishPerishSongOnTurnEnd (battle_util.c:3032-3053) ticks it to 2.
    expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(2)
    expect(foeOf(state).volatiles.perishSongTimer).toBe(2)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_PERISH_SONG)).toBe(true)
    expect(rng.calls).toBe(0) // the script has no accuracycheck (:5083-5100)
    expect(ppOf(state)).toBe(9) // ppreduce :5086
  })

  it('skips a Soundproof foe but still sets the user (:11137); the foe\'s timer stays 0', () => {
    const state = battle(user('MOVE_PERISH_SONG'), foe({ abilities: only('ABILITY_SOUNDPROOF') }), countRng())
    runVs(state, 'MOVE_PERISH_SONG')
    expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(2) // 3, then the end-of-turn tick
    expect(foeOf(state).volatiles.perishSongTimer).toBe(0)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_PERISH_SONG)).toBe(false)
  })

  it('skips a Prankster-blocked Dark foe (BlocksPrankster :11137) but still sets the user', () => {
    const state = battle(
      user('MOVE_PERISH_SONG', { abilities: only('ABILITY_PRANKSTER') }),
      foe({ types: ['DARK', 'MYSTERY', 'MYSTERY'] }),
      countRng(),
    )
    runVs(state, 'MOVE_PERISH_SONG')
    expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(2) // 3, then the end-of-turn tick
    expect(foeOf(state).volatiles.perishSongTimer).toBe(0)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_PERISH_SONG)).toBe(false)
  })

  it('fails when every battler already has the flag (:11143-11144), leaving the timers alone; PP spent', () => {
    const state = battle(user('MOVE_PERISH_SONG'), foe(), countRng())
    for (const b of [state.battlers[0]!, state.battlers[1]!]) {
      b.statuses3 = setFlag(0, STATUS3_PERISH_SONG)
      b.volatiles.perishSongTimer = 1
    }
    const out = runVs(state, 'MOVE_PERISH_SONG')
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
    // Not reset to 3: the end-of-turn tick takes both 1 -> 0 instead of 3 -> 2.
    expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(0)
    expect(foeOf(state).volatiles.perishSongTimer).toBe(0)
  })
})

// BattleScript_EffectPoison data/battle_scripts_1.s:4332-4344; requirecandoeffect BS_TARGET,
// MOVE_EFFECT_POISON (:4336, battle_script_commands.c:8544-8552); CanBePoisoned battle_util.c:5042-5050;
// powder immunity is CANCELLER_POWDER_MOVE battle_util.c:3455-3466 with IsPowderImmune :3190-3197.
describe('cycle 120 - Poison Powder (EFFECT_POISON)', () => {
  it('poisons a Water target after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_POISON_POWDER'), foe(), rng)
    const out = runVs(state, 'MOVE_POISON_POWDER')
    expect(foeOf(state).mon.status1 & STATUS1_POISON).toBe(STATUS1_POISON) // :4340-4341
    expect(out.actions[0]?.statusApplied).toEqual({ battlerId: 1, status: 'POISON' })
    expect(rng.calls).toBe(1) // accuracycheck :4337
    expect(ppOf(state)).toBe(9) // ppreduce :4335
  })

  it.each(['POISON', 'STEEL'])('a %s-type target is immune in CanPoisonType (:6465-6470): no draw, PP spent', (type) => {
    const rng = countRng()
    const state = battle(user('MOVE_POISON_POWDER'), foe({ types: [type, 'MYSTERY', 'MYSTERY'] }), rng)
    runVs(state, 'MOVE_POISON_POWDER')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('an already-statused target fails in requirecandoeffect before the accuracy roll; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_POISON_POWDER'), foe({ status1: STATUS1_BURN }), rng)
    runVs(state, 'MOVE_POISON_POWDER')
    expect(foeOf(state).mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('Safeguard blocks in CanBePoisoned -> IsStatusImmune (battle_util.c:5024-5030) before the accuracy roll', () => {
    const rng = countRng()
    const state = battle(user('MOVE_POISON_POWDER'), foe(), rng)
    state.sides[1].statuses |= SIDE_STATUS_SAFEGUARD
    runVs(state, 'MOVE_POISON_POWDER')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a Grass target is powder-immune: CANCELLER_POWDER_MOVE cancels it, but BattleScript_PowderMoveNoEffect still ppreduce', () => {
    const rng = countRng()
    const state = battle(user('MOVE_POISON_POWDER'), foe({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] }), rng)
    const out = runVs(state, 'MOVE_POISON_POWDER')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(out.actions[0]?.cancelledBy).toBe('POWDER') // :3455-3466
    expect(rng.calls).toBe(0) // no accuracycheck on this path
    expect(ppOf(state)).toBe(9) // BattleScript_PowderMoveNoEffect still runs ppreduce (:8708-8709)
  })

  it('an accuracy miss (99 >= 75) leaves the target unpoisoned; PP still spent', () => {
    const rng = missRng()
    const state = battle(user('MOVE_POISON_POWDER'), foe(), rng)
    const out = runVs(state, 'MOVE_POISON_POWDER')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_SPITE',
  'EFFECT_MEAN_LOOK',
  'EFFECT_FORESIGHT',
  'EFFECT_PARALYZE_IGNORE_TYPE',
  'EFFECT_MIRACLE_EYE',
  'EFFECT_SKILL_SWAP',
  'EFFECT_GASTRO_ACID',
  'EFFECT_FLATTER',
  'EFFECT_IMPRISON',
  'EFFECT_DESTINY_BOND',
  'EFFECT_PERISH_SONG',
  'EFFECT_POISON',
]

describe('cycle 120 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})

describe('cycle 120 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_SPITE', 'EFFECT_SPITE'],
    ['MOVE_MEAN_LOOK', 'EFFECT_MEAN_LOOK'],
    ['MOVE_BLOCK', 'EFFECT_MEAN_LOOK'],
    ['MOVE_SPIDER_WEB', 'EFFECT_MEAN_LOOK'],
    ['MOVE_FORESIGHT', 'EFFECT_FORESIGHT'],
    ['MOVE_ODOR_SLEUTH', 'EFFECT_FORESIGHT'],
    ['MOVE_GLARE', 'EFFECT_PARALYZE_IGNORE_TYPE'],
    ['MOVE_STUN_SPORE', 'EFFECT_PARALYZE_IGNORE_TYPE'],
    ['MOVE_MIRACLE_EYE', 'EFFECT_MIRACLE_EYE'],
    ['MOVE_SKILL_SWAP', 'EFFECT_SKILL_SWAP'],
    ['MOVE_GASTRO_ACID', 'EFFECT_GASTRO_ACID'],
    ['MOVE_FLATTER', 'EFFECT_FLATTER'],
    ['MOVE_IMPRISON', 'EFFECT_IMPRISON'],
    ['MOVE_DESTINY_BOND', 'EFFECT_DESTINY_BOND'],
    ['MOVE_PERISH_SONG', 'EFFECT_PERISH_SONG'],
    ['MOVE_POISON_POWDER', 'EFFECT_POISON'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
