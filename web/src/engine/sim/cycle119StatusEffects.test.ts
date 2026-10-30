/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 119: status-infliction move effects. Every number below is derived by hand from the C: the
// script line in data/battle_scripts_1.s and the command in src/battle_script_commands.c /
// src/battle_util.c are cited on the test that asserts it. Stat stages run 0..12 here (neutral 6),
// so the C's MIN_STAT_STAGE is stage 0 and MAX_STAT_STAGE stage 12.
import { describe, expect, it } from 'vitest'

import { computeMoveLimitations } from './ai/aiMoveLimitations'
import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS2_CURSED,
  STATUS2_ENRAGED,
  STATUS2_INFATUATION,
  STATUS2_SUBSTITUTE,
  STATUS2_TORMENT,
  STATUS3_AQUA_RING,
  STATUS3_HEAL_BLOCK,
  STATUS3_YAWN,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  getCounter,
  hasFlag,
  setCounter,
  setFlag,
  statusInfatuatedWith,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { aiDamageDepsFor, groundingFor } from './driver/session'
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

/** Scripted draws, in order, so a caller can name exactly what the C rolls. */
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

const THIS_FILE = 'web/src/engine/sim/cycle119StatusEffects.test.ts'
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

/**
 * The user acts first (faster), then the foe Tackles; `snap` runs when the foe's Tackle resolves,
 * i.e. after the user's move and before any end-of-turn timer ticks.
 */
function runSnap<T>(state: BattleState, moveId: string, snap: () => T): T {
  let seen: T | undefined
  const damage: DamageResolver = {
    resolve: () => {
      seen = snap()
      return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
    },
  }
  executeTurn(state, [useMove(1, moveId), useMove(0, 'MOVE_TACKLE')], loopDeps(state, damage))
  return seen as T
}

const ppOf = (state: BattleState) => state.battlers[0]!.mon.pp[0]
const foeOf = (state: BattleState) => state.battlers[1]!

// BattleScript_EffectSleep :3103-3113; SetMoveEffect MOVE_EFFECT_SLEEP :2555.
describe('cycle 119 - Sleep', () => {
  it('Hypnosis puts the target to sleep for 2 turns ((Random() % 3) + 2, :2555) after the accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HYPNOSIS'), foe(), rng)
    const out = runVs(state, 'MOVE_HYPNOSIS')
    expect(hasFlag(foeOf(state).mon.status1, STATUS1_SLEEP)).toBe(true)
    expect(getCounter(foeOf(state).mon.status1, STATUS1_SLEEP)).toBe(2)
    expect(rng.calls).toBe(2) // accuracycheck :3108, then the duration draw
    expect(ppOf(state)).toBe(9) // ppreduce :3106
    expect(out.actions[0]?.statusApplied).toEqual({ battlerId: 1, status: 'SLEEP' })
  })

  it('fails in requirecandoeffect (:3107) on an already-statused target BEFORE the accuracy roll: no draw, status stays BURN, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HYPNOSIS'), foe({ status1: STATUS1_BURN }), rng)
    runVs(state, 'MOVE_HYPNOSIS')
    expect(foeOf(state).mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('Electric Terrain makes CanSleep fail (:8517): no accuracy draw either, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HYPNOSIS'), foe(), rng)
    state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    runVs(state, 'MOVE_HYPNOSIS')
    expect(hasFlag(foeOf(state).mon.status1, STATUS1_SLEEP)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss (99 >= 60, :3108 -> BattleScript_ButItFailed) leaves status 0 and still spends PP', () => {
    const rng = missRng()
    const state = battle(user('MOVE_HYPNOSIS'), foe(), rng)
    const out = runVs(state, 'MOVE_HYPNOSIS')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
    expect(out.actions[0]?.missed).toBe(true)
  })

  it.each([
    'MOVE_HYPNOSIS',
    'MOVE_GRASS_WHISTLE',
    'MOVE_SING',
    'MOVE_SLEEP_POWDER',
    'MOVE_SPORE',
    'MOVE_DARK_VOID',
    'MOVE_LOVELY_KISS',
  ])('%s sleeps the target for 2 turns', (moveId) => {
    const rng = countRng()
    const state = battle(user(moveId), foe(), rng)
    runVs(state, moveId)
    expect(getCounter(foeOf(state).mon.status1, STATUS1_SLEEP)).toBe(2)
    expect(rng.calls).toBe(2)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectYawn :6411-6422; Cmd_setyawn :11840-11855; ENDTURN_YAWN battle_util.c:2839-2854.
describe('cycle 119 - Yawn', () => {
  it('sets a 2-turn drowsy counter (:11852) after the accuracy draw; end of turn ticks it to 1; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_YAWN'), foe(), rng)
    const midTurn = runSnap(state, 'MOVE_YAWN', () => getCounter(foeOf(state).statuses3, STATUS3_YAWN))
    expect(midTurn).toBe(2) // setyawn :11852 writes STATUS3_YAWN_TURN(2)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_YAWN)).toBe(true)
    expect(getCounter(foeOf(state).statuses3, STATUS3_YAWN)).toBe(1) // ENDTURN_YAWN :2841
    expect(ppOf(state)).toBe(9) // ppreduce :6414
  })

  it('draws exactly once for accuracycheck (:6416, a 0-accuracy move still rolls) and nothing at end of turn', () => {
    const rng = countRng()
    const state = battle(user('MOVE_YAWN'), foe(), rng)
    runVs(state, 'MOVE_YAWN')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_YAWN)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('the drowsy target falls asleep at the end of the next turn ((Random() & 3) + 2 = 2, :2850)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_YAWN'), foe(), rng)
    foeOf(state).statuses3 = setCounter(0, STATUS3_YAWN, 1)
    executeTurn(state, [null, null], loopDeps(state, fixedDamage(0)))
    expect(hasFlag(foeOf(state).statuses3, STATUS3_YAWN)).toBe(false)
    expect(getCounter(foeOf(state).mon.status1, STATUS1_SLEEP)).toBe(2)
    expect(rng.calls).toBe(1) // only the sleep-duration draw
  })

  it('a second Yawn fails in setyawn (:11841) and leaves a pre-set counter at 3 (a re-set would show 2); one accuracy draw, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_YAWN'), foe(), rng)
    foeOf(state).statuses3 = setCounter(0, STATUS3_YAWN, 3)
    runVs(state, 'MOVE_YAWN')
    expect(getCounter(foeOf(state).statuses3, STATUS3_YAWN)).toBe(2) // 3 -> end-of-turn tick, not re-set to 2
    expect(rng.calls).toBe(1) // the accuracy check still draws before setyawn fails
    expect(ppOf(state)).toBe(9)
  })

  it('fails in requirecandoeffect (:6415) on a target that already has a status1: no draw, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_YAWN'), foe({ status1: STATUS1_BURN }), rng)
    runVs(state, 'MOVE_YAWN')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_YAWN)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('Misty Terrain fails in requirecandoeffect (:6415, CanSleep -> IsStatusImmune battle_util.c:5024-5030): no draw, no drowsy flag, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_YAWN'), foe(), rng)
    state.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
    runVs(state, 'MOVE_YAWN')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_YAWN)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSwagger :5134-5154; Cmd_jumpifenragedandstatmaxed :11169-11174; MOVE_EFFECT_ENRAGE :3025-3029.
describe('cycle 119 - Swagger', () => {
  it('raises Attack by 2 (stage 6 -> 8) and enrages after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SWAGGER'), foe(), rng)
    const out = runVs(state, 'MOVE_SWAGGER')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(8)
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ENRAGED)).toBe(true)
    expect(rng.calls).toBe(1) // accuracycheck :5137
    expect(ppOf(state)).toBe(9) // ppreduce :5139
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: 2 }])
    expect(out.actions[0]?.statusApplied).toEqual({ battlerId: 1, status: 'ENRAGED' })
  })

  it('fails when already enraged AND Attack is maxed (:5140): Attack stays 12, one draw, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SWAGGER'), foe({ status2: STATUS2_ENRAGED }), rng)
    foeOf(state).mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_SWAGGER')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('already enraged but Attack not maxed still raises Attack by 2 and does not re-enrage:', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SWAGGER'), foe({ status2: STATUS2_ENRAGED }), rng)
    const out = runVs(state, 'MOVE_SWAGGER')
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(8)
    expect(out.actions[0]?.statusApplied).toBeNull() // REQUIRE_NOT already-enraged (:3026)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute absorbs it (:5136 -> BattleScript_MakeMoveMissed :3090-3094): no draw, missed, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SWAGGER'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_SWAGGER')
    expect(foeOf(state).mon.status2).toBe(STATUS2_SUBSTITUTE)
    expect(foeOf(state).mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss (99 >= 85, :5137) leaves Attack and status alone, PP still spent', () => {
    const rng = missRng()
    const state = battle(user('MOVE_SWAGGER'), foe(), rng)
    const out = runVs(state, 'MOVE_SWAGGER')
    expect(foeOf(state).mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_ENRAGED)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectConfuse :4219-4231; SetMoveEffect MOVE_EFFECT_CONFUSION :2657-2663.
describe('cycle 119 - Confusion', () => {
  it('Confuse Ray confuses for 3 turns ((Random() % 2) + 3, :2660) after the accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CONFUSE_RAY'), foe(), rng)
    const out = runVs(state, 'MOVE_CONFUSE_RAY')
    expect(getCounter(foeOf(state).mon.status2, STATUS2_CONFUSION)).toBe(3)
    expect(rng.calls).toBe(2) // accuracycheck :4224, then the duration draw
    expect(ppOf(state)).toBe(9) // ppreduce :4222
    expect(out.actions[0]?.statusApplied).toEqual({ battlerId: 1, status: 'CONFUSION' })
  })

  it('an already-confused target still draws accuracy once (requirecandoeffect :8583 falls through) and keeps its counter', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CONFUSE_RAY'), foe({ status2: setCounter(0, STATUS2_CONFUSION, 2) }), rng)
    runVs(state, 'MOVE_CONFUSE_RAY')
    expect(getCounter(foeOf(state).mon.status2, STATUS2_CONFUSION)).toBe(2)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Own Tempo blocks in CanBeConfused BEFORE the accuracy roll (requirecandoeffect :4223): no draw, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CONFUSE_RAY'), foe({ abilities: only('ABILITY_OWN_TEMPO') }), rng)
    runVs(state, 'MOVE_CONFUSE_RAY')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_CONFUSION)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('Supersonic can miss (99 >= 85): one draw, no confusion, PP still spent', () => {
    const rng = missRng()
    const state = battle(user('MOVE_SUPERSONIC'), foe(), rng)
    const out = runVs(state, 'MOVE_SUPERSONIC')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_CONFUSION)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectAttract :5224-5236; Cmd_tryinfatuating :10419-10429; CanInfatuate battle_util.c:5135-5143.
describe('cycle 119 - Attract', () => {
  it('infatuates an opposite-gender target (:5229-5232): STATUS2_INFATUATED_WITH(0), one draw, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_ATTRACT'), foe({ gender: 'FEMALE' }), rng)
    const out = runVs(state, 'MOVE_ATTRACT')
    expect(foeOf(state).mon.status2).toBe(statusInfatuatedWith(0))
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_INFATUATION)).toBe(true)
    expect(rng.calls).toBe(1) // accuracycheck :5228 (before the ability check :5229)
    expect(ppOf(state)).toBe(9) // ppreduce :5227
    expect(out.actions[0]?.statusApplied).toEqual({ battlerId: 1, status: 'INFATUATION' })
  })

  it("ER's CanInfatuate (:5135-5143) has no gender clause: a SAME-gender target is infatuated too", () => {
    const state = battle(user('MOVE_ATTRACT'), foe({ gender: 'MALE' }), countRng())
    runVs(state, 'MOVE_ATTRACT')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_INFATUATION)).toBe(true)
  })

  it('a genderless target is infatuated too (still no gender clause in the C)', () => {
    const state = battle(user('MOVE_ATTRACT'), foe({ gender: 'GENDERLESS' }), countRng())
    runVs(state, 'MOVE_ATTRACT')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_INFATUATION)).toBe(true)
  })

  it('Oblivious stops it at :10424 (after the accuracy draw): no infatuation, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_ATTRACT'), foe({ abilities: only('ABILITY_OBLIVIOUS') }), rng)
    runVs(state, 'MOVE_ATTRACT')
    expect(foeOf(state).mon.status2).toBe(0)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('an already-infatuated target is left alone (CanInfatuate :5139); one accuracy draw, PP spent', () => {
    const rng = countRng()
    const already = statusInfatuatedWith(0)
    const state = battle(user('MOVE_ATTRACT'), foe({ status2: already }), rng)
    runVs(state, 'MOVE_ATTRACT')
    expect(foeOf(state).mon.status2).toBe(already)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss (99 >= 90) leaves the target alone, PP still spent', () => {
    const rng = missRng()
    const state = battle(user('MOVE_ATTRACT'), foe(), rng)
    const out = runVs(state, 'MOVE_ATTRACT')
    expect(foeOf(state).mon.status2).toBe(0)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectCurse :4928-4987; Cmd_cursetarget :11103-11113.
describe('cycle 119 - Curse', () => {
  // Speed 200 -> 133 after the -1, which cannot tie the default foe's 100, so
  // sortBattlersBySpeed -> getFastestBattler (turnOrder.ts:566-589) draws no tie-break at end of turn.
  const curseUser = (overrides: Partial<SimBattleMon> = {}) =>
    user('MOVE_CURSE', { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }, ...overrides })

  it('non-Ghost: Speed -1, Attack +1, Defense +1 with NO accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(curseUser(), foe(), rng)
    const out = runVs(state, 'MOVE_CURSE')
    const stages = state.battlers[0]!.mon.statStages
    expect(stages[STAT_SPEED]).toBe(5)
    expect(stages[STAT_ATK]).toBe(7)
    expect(stages[STAT_DEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPEED, change: -1 },
      { battlerId: 0, stat: STAT_ATK, change: 1 },
      { battlerId: 0, stat: STAT_DEF, change: 1 },
    ])
    expect(rng.calls).toBe(0) // the script has no accuracycheck here (:4931-4935)
    expect(ppOf(state)).toBe(9) // ppreduce :4933
  })

  it('fails when Speed is at min and Attack and Defense are at max (:4935-4938): no change, PP spent', () => {
    const state = battle(curseUser(), foe(), countRng())
    const stages = state.battlers[0]!.mon.statStages
    stages[STAT_SPEED] = MIN_STAT_STAGE
    stages[STAT_ATK] = MAX_STAT_STAGE
    stages[STAT_DEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_CURSE')
    expect(stages[STAT_SPEED]).toBe(MIN_STAT_STAGE)
    expect(stages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(stages[STAT_DEF]).toBe(MAX_STAT_STAGE)
    // Speed stage 0 leaves the user slower than the foe, so its slot is the second action.
    const curseAction = out.actions.find((a) => a.battlerId === 0)
    expect(curseAction?.missed).toBe(true)
    expect(curseAction?.statChanges).toEqual([])
    expect(ppOf(state)).toBe(9)
  })

  it('Attack already at max does not stop the Speed drop or the Defense raise (:4936): only two changes', () => {
    const state = battle(curseUser(), foe(), countRng())
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_CURSE')
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(5)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPEED, change: -1 },
      { battlerId: 0, stat: STAT_DEF, change: 1 },
    ])
  })

  it('Ghost Curse (:4970-4987): curses the target and costs the user maxHp / 2 = 50 HP, no draw, PP spent', () => {
    const rng = countRng()
    const state = battle(curseUser({ types: ['GHOST', 'MYSTERY', 'MYSTERY'] }), foe(), rng)
    const out = runVs(state, 'MOVE_CURSE')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_CURSED)).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(out.actions[0]?.attackerDamage).toBe(50)
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON (:4976) draws nothing
    expect(ppOf(state)).toBe(9) // ppreduce :4975
  })

  it('Ghost Curse on an already-cursed target fails in cursetarget (:11104) and costs no HP; PP spent', () => {
    const rng = countRng()
    const state = battle(curseUser({ types: ['GHOST', 'MYSTERY', 'MYSTERY'] }), foe({ status2: STATUS2_CURSED }), rng)
    const out = runVs(state, 'MOVE_CURSE')
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectTorment :6056-6067; Cmd_settorment :11662-11669.
describe('cycle 119 - Torment', () => {
  it('sets STATUS2_TORMENT after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TORMENT'), foe(), rng)
    runVs(state, 'MOVE_TORMENT')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_TORMENT)).toBe(true)
    expect(rng.calls).toBe(1) // accuracycheck :6060
    expect(ppOf(state)).toBe(9) // ppreduce :6059
  })

  it('a second Torment fails (:11664) after one accuracy draw, PP still spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TORMENT'), foe({ status2: STATUS2_TORMENT }), rng)
    const out = runVs(state, 'MOVE_TORMENT')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_TORMENT)).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 (33%) leaves the target un-tormented, PP still spent', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_TORMENT'), foe(), rng))
    const out = runVs(state, 'MOVE_TORMENT')
    expect(hasFlag(foeOf(state).mon.status2, STATUS2_TORMENT)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('behavioural: CheckMoveLimitations marks the last-used slot unusable (:1641-1642)', () => {
    const state = battle(user('MOVE_TORMENT'), foe({ moves: ['MOVE_TACKLE', 'MOVE_SCRATCH', null, null], pp: [15, 10, 0, 0] }), countRng())
    foeOf(state).lastMove = 'MOVE_TACKLE'
    runVs(state, 'MOVE_TORMENT')
    const { mask } = computeMoveLimitations(state, 1, aiDamageDepsFor(simData, state))
    expect(mask & 0b0001).toBe(0b0001)
    expect(mask & 0b0010).toBe(0)
  })
})

// BattleScript_EffectAquaRing :2670-2679; Cmd_setuserstatus3 :11991-12002; ENDTURN_AQUA_RING battle_util.c:2435-2443.
describe('cycle 119 - Aqua Ring', () => {
  it('sets STATUS3_AQUA_RING on the user with no accuracy draw and heals maxHp / 16 = 6 at end of turn; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AQUA_RING', { hp: 50 }), foe(), rng)
    runVs(state, 'MOVE_AQUA_RING')
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_AQUA_RING)).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(56) // 50 + floor(100 / 16)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9) // ppreduce :2673
  })

  it('a second use fails in setuserstatus3 (:2674); PP still spent and only one end-of-turn heal happens', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AQUA_RING', { hp: 50 }), foe(), rng)
    state.battlers[0]!.statuses3 = setFlag(0, STATUS3_AQUA_RING)
    const out = runVs(state, 'MOVE_AQUA_RING')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(56)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectHealBlock :2744-2755; Cmd_sethealblock :4970-4978; ENDTURN_HEALBLOCK battle_util.c:2896-2906.
describe('cycle 119 - Heal Block', () => {
  it('blocks healing with healBlockTimer 5 (:4974-4975) after one accuracy draw, PP 10 -> 9; end of turn ticks it to 4', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HEAL_BLOCK'), foe(), rng)
    const midTurn = runSnap(state, 'MOVE_HEAL_BLOCK', () => ({
      flag: hasFlag(foeOf(state).statuses3, STATUS3_HEAL_BLOCK),
      timer: foeOf(state).volatiles.healBlockTimer,
    }))
    expect(midTurn).toEqual({ flag: true, timer: 5 })
    expect(foeOf(state).volatiles.healBlockTimer).toBe(4) // ENDTURN_HEALBLOCK
    expect(hasFlag(foeOf(state).statuses3, STATUS3_HEAL_BLOCK)).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('draws exactly once for accuracycheck (:2746, before ppreduce :2748) and nothing at end of turn', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HEAL_BLOCK'), foe(), rng)
    runVs(state, 'MOVE_HEAL_BLOCK')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_HEAL_BLOCK)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('a second Heal Block fails (:4971) after one accuracy draw, PP still spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HEAL_BLOCK'), foe(), rng)
    foeOf(state).statuses3 = setFlag(0, STATUS3_HEAL_BLOCK)
    foeOf(state).volatiles.healBlockTimer = 5
    const out = runVs(state, 'MOVE_HEAL_BLOCK')
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 (33%) leaves the target unblocked, PP still spent', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_HEAL_BLOCK'), foe(), rng))
    const out = runVs(state, 'MOVE_HEAL_BLOCK')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_HEAL_BLOCK)).toBe(false)
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('behavioural: a heal-blocked Recover is cancelled before ppreduce (CANCELLER_HEAL_BLOCKED battle_util.c:3326-3336) so it heals nothing and costs no PP', () => {
    const state = battle(user('MOVE_HEAL_BLOCK'), foe({ hp: 40, moves: ['MOVE_RECOVER', null, null, null], pp: [10, 0, 0, 0] }), countRng())
    foeOf(state).statuses3 = setFlag(0, STATUS3_HEAL_BLOCK)
    foeOf(state).volatiles.healBlockTimer = 5
    const out = executeTurn(state, [null, useMove(0, 'MOVE_RECOVER')], loopDeps(state, fixedDamage(0)))
    expect(foeOf(state).mon.hp).toBe(40)
    expect(foeOf(state).mon.pp[0]).toBe(10)
    expect(out.actions.find((a) => a.battlerId === 1)?.cancelledBy).toBe('HEAL_BLOCK')
  })

  it('control: the same Recover heals 50 (40 -> 90) without Heal Block', () => {
    const state = battle(user('MOVE_HEAL_BLOCK'), foe({ hp: 40, moves: ['MOVE_RECOVER', null, null, null], pp: [10, 0, 0, 0] }), countRng())
    executeTurn(state, [null, useMove(0, 'MOVE_RECOVER')], loopDeps(state, fixedDamage(0)))
    expect(foeOf(state).mon.hp).toBe(90)
    expect(foeOf(state).mon.pp[0]).toBe(9)
  })
})

// BattleScript_EffectSoak :1949-1962; VARIOUS_TRY_SOAK :7365-7373; SET_BATTLER_TYPE include/battle.h:755-760.
describe('cycle 119 - Soak / Magic Powder', () => {
  it('Soak turns a Fire/Flying target into pure Water after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SOAK'), foe({ types: ['FIRE', 'FLYING', 'MYSTERY'] }), rng)
    runVs(state, 'MOVE_SOAK')
    expect(foeOf(state).mon.types).toEqual(['WATER', 'WATER', 'MYSTERY'])
    expect(rng.calls).toBe(1) // accuracycheck :1951
    expect(ppOf(state)).toBe(9) // ppreduce :1953
  })

  it('Magic Powder uses its own type (Psychic) for the rewrite (:7367)', () => {
    const state = battle(user('MOVE_MAGIC_POWDER'), foe({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }), countRng())
    runVs(state, 'MOVE_MAGIC_POWDER')
    expect(foeOf(state).mon.types).toEqual(['PSYCHIC', 'PSYCHIC', 'MYSTERY'])
    expect(ppOf(state)).toBe(9)
  })

  it('a pure-Water target is unchanged (:7368-7371): one accuracy draw, missed, PP spent', () => {
    const state = battle(user('MOVE_SOAK'), foe(), countRng())
    const out = runVs(state, 'MOVE_SOAK')
    expect(foeOf(state).mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('Multitype fails the type rewrite (:1954) after the accuracy draw, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SOAK'), foe({ types: ['FIRE', 'MYSTERY', 'MYSTERY'], abilities: only('ABILITY_MULTITYPE') }), rng)
    const out = runVs(state, 'MOVE_SOAK')
    expect(foeOf(state).mon.types).toEqual(['FIRE', 'MYSTERY', 'MYSTERY'])
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute fails (:1956) after the accuracy draw, PP spent', () => {
    const state = battle(user('MOVE_SOAK'), foe({ types: ['FIRE', 'MYSTERY', 'MYSTERY'], status2: STATUS2_SUBSTITUTE }), countRng())
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_SOAK')
    expect(foeOf(state).mon.types).toEqual(['FIRE', 'MYSTERY', 'MYSTERY'])
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 (33%) leaves the types alone, PP still spent', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_SOAK'), foe({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }), rng))
    const out = runVs(state, 'MOVE_SOAK')
    expect(foeOf(state).mon.types).toEqual(['FIRE', 'MYSTERY', 'MYSTERY'])
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectDisable :4622-4632; Cmd_disablelastusedattack :10706-10737.
describe('cycle 119 - Disable', () => {
  const lastMovedFoe = (overrides: Partial<SimBattleMon> = {}) =>
    foe({ moves: ['MOVE_SCRATCH', 'MOVE_TACKLE', null, null], pp: [10, 15, 0, 0], ...overrides })

  it('disables the last-used move with a 4-turn timer (:10723-10729) after one accuracy draw, PP 10 -> 9; end of turn ticks it to 3', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DISABLE'), lastMovedFoe(), rng)
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    const midTurn = runSnap(state, 'MOVE_DISABLE', () => ({
      move: foeOf(state).volatiles.disabledMove,
      timer: foeOf(state).volatiles.disableTimer,
      start: foeOf(state).volatiles.disableTimerStartValue,
    }))
    expect(midTurn).toEqual({ move: 'MOVE_SCRATCH', timer: 4, start: 4 })
    expect(foeOf(state).volatiles.disableTimer).toBe(3) // ENDTURN_DISABLE :2774
    expect(ppOf(state)).toBe(9) // ppreduce :4625
  })

  it('draws exactly once for accuracycheck (:4627) and nothing at end of turn', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DISABLE'), lastMovedFoe(), rng)
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    runVs(state, 'MOVE_DISABLE')
    expect(foeOf(state).volatiles.disabledMove).toBe('MOVE_SCRATCH')
    expect(rng.calls).toBe(1)
  })

  it('fails when the target has not moved yet (:10718): one accuracy draw, missed, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DISABLE'), lastMovedFoe(), rng)
    const out = runVs(state, 'MOVE_DISABLE')
    expect(foeOf(state).volatiles.disabledMove).toBeNull()
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when that move is already disabled (:10718), leaving the original timer alone', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DISABLE'), lastMovedFoe(), rng)
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    foeOf(state).volatiles.disabledMove = 'MOVE_TACKLE'
    foeOf(state).volatiles.disableTimer = 2
    const out = runVs(state, 'MOVE_DISABLE')
    expect(foeOf(state).volatiles.disabledMove).toBe('MOVE_TACKLE')
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the last-used move is out of PP (:10718): one accuracy draw, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DISABLE'), lastMovedFoe({ pp: [0, 15, 0, 0] }), rng)
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    const out = runVs(state, 'MOVE_DISABLE')
    expect(foeOf(state).volatiles.disabledMove).toBeNull()
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 (33%) disables nothing, PP still spent', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_DISABLE'), lastMovedFoe(), rng))
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    const out = runVs(state, 'MOVE_DISABLE')
    expect(foeOf(state).volatiles.disabledMove).toBeNull()
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('behavioural: CheckMoveLimitations marks the disabled slot unusable (:1640)', () => {
    const state = battle(user('MOVE_DISABLE'), lastMovedFoe(), countRng())
    foeOf(state).lastMove = 'MOVE_SCRATCH'
    runVs(state, 'MOVE_DISABLE')
    const { mask } = computeMoveLimitations(state, 1, aiDamageDepsFor(simData, state))
    expect(mask & 0b0001).toBe(0b0001)
    expect(mask & 0b0010).toBe(0)
  })
})

// BattleScript_EffectSleepTalk :4763-4784; Cmd_trychoosesleeptalkmove :10898-10941.
describe('cycle 119 - Sleep Talk', () => {
  const sleeper = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 150 },
      moves: ['MOVE_SLEEP_TALK', 'MOVE_TACKLE', 'MOVE_REST', 'MOVE_EMBER'],
      pp: [10, 15, 10, 15],
      status1: setCounter(0, STATUS1_SLEEP, 3),
      ...overrides,
    })

  function runRecorded(state: BattleState, moveId: string): { out: TurnOutcome; moves: string[] } {
    const damage = recordingDamage()
    const out = executeTurn(state, [useMove(1, moveId), null], loopDeps(state, damage))
    return { out, moves: damage.moves }
  }

  it('an awake user fails (:4768) but still spends PP, with no draw at all', () => {
    const rng = countRng()
    const state = battle(sleeper({ status1: 0 }), foe(), rng)
    const { out, moves } = runRecorded(state, 'MOVE_SLEEP_TALK')
    expect(out.actions[0]?.missed).toBe(true)
    expect(moves).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a sleeping user calls a usable move: pick 0 (Sleep Talk slot, banned) then 1 (Tackle); Tackle costs no PP (:10931-10936)', () => {
    const rng = scriptRng([0, 1, 0])
    const state = battle(sleeper(), foe(), rng)
    const { moves } = runRecorded(state, 'MOVE_SLEEP_TALK')
    expect(moves).toEqual(['MOVE_TACKLE'])
    expect(rng.calls).toBe(3) // two selection rolls, then the called move's accuracycheck
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // Sleep Talk's own ppreduce :4775
    expect(state.battlers[0]!.mon.pp[1]).toBe(15) // HITMARKER_NO_PPDEDUCT :4777
  })

  it('a Rest pick is rerolled exactly once (:10924-10929): rolls 2 then 3 call Ember', () => {
    const rng = scriptRng([2, 3, 0])
    const state = battle(sleeper(), foe(), rng)
    const { moves } = runRecorded(state, 'MOVE_SLEEP_TALK')
    expect(moves).toEqual(['MOVE_EMBER'])
    expect(rng.calls).toBe(3)
    expect(state.battlers[0]!.mon.pp[3]).toBe(15)
  })

  it('a second Rest pick after the reroll is accepted (rolls 2, 2): two selection draws, Rest costs no PP', () => {
    const rng = scriptRng([2, 2])
    const state = battle(sleeper({ hp: 40 }), foe(), rng)
    const { moves } = runRecorded(state, 'MOVE_SLEEP_TALK')
    expect(moves).toEqual([]) // Rest is a status move: nothing reaches the damage engine
    expect(rng.calls).toBe(2) // two selection rolls, every slot otherwise unusable
    expect(state.battlers[0]!.mon.pp[2]).toBe(10)
  })

  it('fails when every slot is unusable (:10920, 0xf): no draws, PP spent', () => {
    const rng = countRng()
    const state = battle(
      sleeper({ moves: ['MOVE_SLEEP_TALK', 'MOVE_SLEEP_TALK', 'MOVE_SLEEP_TALK', 'MOVE_SLEEP_TALK'], pp: [10, 10, 10, 10] }),
      foe(),
      rng,
    )
    const { out, moves } = runRecorded(state, 'MOVE_SLEEP_TALK')
    expect(out.actions[0]?.missed).toBe(true)
    expect(moves).toEqual([])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('Comatose counts as asleep (:4765) even without status1 sleep: Tackle is called', () => {
    const rng = scriptRng([1, 0])
    const state = battle(sleeper({ status1: 0, abilities: only('ABILITY_COMATOSE') }), foe(), rng)
    const { moves } = runRecorded(state, 'MOVE_SLEEP_TALK')
    expect(moves).toEqual(['MOVE_TACKLE'])
    expect(rng.calls).toBe(2)
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_SLEEP',
  'EFFECT_YAWN',
  'EFFECT_SWAGGER',
  'EFFECT_CONFUSE',
  'EFFECT_ATTRACT',
  'EFFECT_CURSE',
  'EFFECT_TORMENT',
  'EFFECT_AQUA_RING',
  'EFFECT_HEAL_BLOCK',
  'EFFECT_SOAK',
  'EFFECT_DISABLE',
  'EFFECT_SLEEP_TALK',
]

describe('cycle 119 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})

describe('cycle 119 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_SLEEP_TALK', 'EFFECT_SLEEP_TALK'],
    ['MOVE_ATTRACT', 'EFFECT_ATTRACT'],
    ['MOVE_CONFUSE_RAY', 'EFFECT_CONFUSE'],
    ['MOVE_SUPERSONIC', 'EFFECT_CONFUSE'],
    ['MOVE_CURSE', 'EFFECT_CURSE'],
    ['MOVE_DARK_VOID', 'EFFECT_SLEEP'],
    ['MOVE_GRASS_WHISTLE', 'EFFECT_SLEEP'],
    ['MOVE_HYPNOSIS', 'EFFECT_SLEEP'],
    ['MOVE_LOVELY_KISS', 'EFFECT_SLEEP'],
    ['MOVE_SING', 'EFFECT_SLEEP'],
    ['MOVE_SLEEP_POWDER', 'EFFECT_SLEEP'],
    ['MOVE_SPORE', 'EFFECT_SLEEP'],
    ['MOVE_TORMENT', 'EFFECT_TORMENT'],
    ['MOVE_SWAGGER', 'EFFECT_SWAGGER'],
    ['MOVE_AQUA_RING', 'EFFECT_AQUA_RING'],
    ['MOVE_YAWN', 'EFFECT_YAWN'],
    ['MOVE_HEAL_BLOCK', 'EFFECT_HEAL_BLOCK'],
    ['MOVE_MAGIC_POWDER', 'EFFECT_SOAK'],
    ['MOVE_SOAK', 'EFFECT_SOAK'],
    ['MOVE_DISABLE', 'EFFECT_DISABLE'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
