/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 121: seven status-infliction move effects, Telekinesis through Role Play. Every number below is
// derived by hand from the C: the script line in data/battle_scripts_1.s and the command in
// src/battle_script_commands.c / src/battle_util.c are cited on the test that asserts it. Stat stages
// run 0..12 here (neutral 6), so the C's MIN_STAT_STAGE is stage 0 and MAX_STAT_STAGE stage 12.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_MAT_BLOCK,
  STAT_ACC,
  STAT_SPEED,
  STATUS1_POISON,
  STATUS2_SUBSTITUTE,
  STATUS3_ALWAYS_HITS,
  STATUS3_ALWAYS_HITS_TURN,
  STATUS3_EMBARGO,
  STATUS3_ON_AIR,
  STATUS3_TELEKINESIS,
  STATUS_FIELD_GRAVITY,
  hasFlag,
  setFlag,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import { hasNonNegatedBerry } from './moveEffects'
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

const THIS_FILE = 'web/src/engine/sim/cycle121StatusEffects.test.ts'
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

// BattleScript_EffectTelekinesis data/battle_scripts_1.s:2547-2557; Cmd_settelekinesis
// src/battle_script_commands.c:13028-13037; sTelekinesisBanList :13007-13017;
// Cmd_accuracycheck NO_ACC_CALC_CHECK_LOCK_ON :1403-1411; ENDTURN_TELEKINESIS
// src/battle_util.c:2886-2894 (decrements the timer at the end of the turn).
describe('cycle 121 - Telekinesis', () => {
  it('sets STATUS3_TELEKINESIS and telekinesisTimer 3 (2 after the end-of-turn tick) with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TELEKINESIS'), foe(), rng)
    const out = runVs(state, 'MOVE_TELEKINESIS')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_TELEKINESIS)).toBe(true) // :13033
    // :13034 sets 3; ENDTURN_TELEKINESIS (battle_util.c:2888-2891) decrements it to 2.
    expect(foeOf(state).volatiles.telekinesisTimer).toBe(2)
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON draws nothing (:1403-1411)
    expect(ppOf(state)).toBe(9) // ppreduce :2551
  })

  it('fails when the target already has STATUS3_TELEKINESIS (:13029); the timer is not reset to 3', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TELEKINESIS'), foe(), rng)
    foeOf(state).statuses3 = setFlag(0, STATUS3_TELEKINESIS)
    foeOf(state).volatiles.telekinesisTimer = 2
    const out = runVs(state, 'MOVE_TELEKINESIS')
    expect(out.actions[0]?.missed).toBe(true)
    // The failed move leaves 2 alone; the end-of-turn tick takes it to 1 (a success would have reset 3 -> 2).
    expect(foeOf(state).volatiles.telekinesisTimer).toBe(1)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_TELEKINESIS)).toBe(true)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('fails under STATUS_FIELD_GRAVITY (:13029), leaving no flag; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TELEKINESIS'), foe(), rng)
    state.field.statuses = setFlag(0, STATUS_FIELD_GRAVITY)
    const out = runVs(state, 'MOVE_TELEKINESIS')
    // Under gravity the move never reaches settelekinesis: CANCELLER_GRAVITY (battle_util.c:3337-3344)
    // cancels it first via IsGravityPreventingMove (:1379-1398), straight to BattleScript_MoveEnd
    // (:8165-8168), so the move is cancelled rather than "missed" and ppreduce (:2552) never runs.
    expect(out.actions[0]?.cancelledBy).toBe('GRAVITY')
    expect(out.actions[0]?.missed).toBe(false)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_TELEKINESIS)).toBe(false)
    expect(foeOf(state).volatiles.telekinesisTimer).toBe(0)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(10)
  })

  it('fails on a banned species (SPECIES_DIGLETT, sTelekinesisBanList :13008-13015); PP spent', () => {
    const state = battle(user('MOVE_TELEKINESIS'), monFor('SPECIES_DIGLETT'), countRng())
    const out = runVs(state, 'MOVE_TELEKINESIS')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_TELEKINESIS)).toBe(false)
    expect(ppOf(state)).toBe(9)
  })

  it('misses a semi-invulnerable target (:1408) with no flag and no draw; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TELEKINESIS'), foe(), rng)
    foeOf(state).statuses3 = setFlag(0, STATUS3_ON_AIR)
    const out = runVs(state, 'MOVE_TELEKINESIS')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_TELEKINESIS)).toBe(false)
    expect(rng.calls).toBe(0) // Cmd_accuracycheck :1408 jumps without a Random()
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectMatBlock data/battle_scripts_1.s:5029-5032 -> BattleScript_ProtectLikeAtkString
// (:5037-5041); Cmd_jumpifnotfirstturn src/battle_script_commands.c:9439-9446; Cmd_setprotectlike
// :9161-9205; ProtectSucceeds :6649-6655. The one-turn side shield is cleared by TurnValuesCleanUp,
// src/battle_main.c:4505-4506 (roundStructsClear in turn.ts), so the success test proves the flag was
// set with the foe's blocked attack rather than by reading it after the turn.
describe('cycle 121 - Mat Block', () => {
  it('on the first turn, when the protect roll succeeds and it is not the last move: blocks the foe, leaves protectUses untouched (2); PP 10 -> 9', () => {
    const rng = countRng()
    const damage = recordingDamage()
    const state = battle(user('MOVE_MAT_BLOCK'), foe(), rng)
    expect(state.battlers[0]!.volatiles.isFirstTurn).toBe(1) // battle-start TurnValuesCleanUp, :4491
    // A prior use of a protection move keeps protectUses from being reset (ProtectSucceeds :6650), so
    // a value of 2 is preserved on success -- which proves Mat Block does not increment it.
    state.battlers[0]!.lastMove = 'MOVE_PROTECT'
    state.battlers[0]!.volatiles.protectUses = 2
    const out = executeTurn(state, [useMove(1, 'MOVE_MAT_BLOCK'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, damage))

    expect(out.actions.find((a) => a.battlerId === 0)?.missed).toBe(false) // setprotectlike succeeded (:9191-9194)
    // The foe's Tackle is stopped by SIDE_STATUS_MAT_BLOCK (battle_util.c:6634; turn.ts isBattlerProtected).
    expect(out.actions.find((a) => a.battlerId === 1)?.missed).toBe(true)
    expect(damage.moves).toEqual([])
    // Mat Block deliberately does not increment protectUses (:9191-9194, unlike Wide Guard/Crafty Shield).
    expect(state.battlers[0]!.volatiles.protectUses).toBe(2)
    // One draw: sProtectSuccessRates[2] = 16383 >= Random() (:6653-6654). The blocked Tackle never rolls accuracy.
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9) // ppreduce :5039
  })

  it('fails when it is not the user\'s first turn (:9439-9446), so the foe\'s attack lands; PP spent', () => {
    const rng = countRng()
    const damage = recordingDamage()
    const state = battle(user('MOVE_MAT_BLOCK'), foe(), rng)
    state.battlers[0]!.volatiles.isFirstTurn = 0
    const out = executeTurn(state, [useMove(1, 'MOVE_MAT_BLOCK'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, damage))

    expect(out.actions.find((a) => a.battlerId === 0)?.missed).toBe(true)
    expect(damage.moves).toEqual(['MOVE_TACKLE'])
    expect(ppOf(state)).toBe(9) // jumpifnotfirstturn -> ButItFailedAtkStringPpReduce does ppreduce (:5938-5941)
  })

  it('fails when its user is the last to act (:9165), even with a successful protect roll; PP spent', () => {
    const rng = countRng()
    // Mat Block's own priority is 1 (moves.json); Quick Attack's is 2, so the foe moves first and the
    // Mat Block user is the last slot in gBattlerByTurnOrder, whatever the speeds.
    const state = battle(user('MOVE_MAT_BLOCK'), foe({ moves: ['MOVE_QUICK_ATTACK', null, null, null], pp: [30, 0, 0, 0] }), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_MAT_BLOCK'), useMove(0, 'MOVE_QUICK_ATTACK')], loopDeps(state, fixedDamage(0)))
    const matBlock = out.actions.find((a) => a.battlerId === 0)!
    expect(matBlock.missed).toBe(true) // notLastTurn is FALSE -> fail (:9165, :9199-9202)
    expect(state.sides[0]!.statuses & SIDE_STATUS_MAT_BLOCK).toBe(0)
    expect(state.battlers[0]!.volatiles.protectUses).toBe(0)
    // Two draws: the foe's Quick Attack accuracy check, then Mat Block's ProtectSucceeds (:6654).
    expect(rng.calls).toBe(2)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectLockOn data/battle_scripts_1.s:4739-4751; Cmd_setalwayshitflag
// src/battle_script_commands.c:10827-10832; Cmd_accuracycheck ACC_CURR_MOVE :1418-1447;
// ENDTURN_LOCK_ON src/battle_util.c:2809-2812 (subtracts STATUS3_ALWAYS_HITS_TURN(1)).
describe('cycle 121 - Lock-On', () => {
  it('sets STATUS3_ALWAYS_HITS_TURN(2) with battlerWithSureHit = user after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LOCK_ON'), foe(), rng)
    runVs(state, 'MOVE_LOCK_ON')
    // :10829 writes TURN(2); ENDTURN_LOCK_ON (battle_util.c:2810) subtracts TURN(1), leaving TURN(1) = 0x08.
    expect(foeOf(state).statuses3 & STATUS3_ALWAYS_HITS).toBe(STATUS3_ALWAYS_HITS_TURN(1))
    expect(foeOf(state).volatiles.battlerWithSureHit).toBe(0) // :10830
    // The script uses ACC_CURR_MOVE (:4744). Lock-On's accuracy is 0, so GetTotalAccuracy returns 101
    // (HITS_IF_POSSIBLE, :1287-1289) but Cmd_accuracycheck still calls Random() (:1433).
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9) // ppreduce :4742
  })

  it('the next turn the user hits through an accuracy floor that would otherwise miss (GetTotalAccuracy :1262)', () => {
    const rng = scriptRng([99, 99])
    const state = battle(
      user('MOVE_LOCK_ON', { moves: ['MOVE_LOCK_ON', 'MOVE_TACKLE', null, null], pp: [10, 15, 0, 0] }),
      foe(),
      rng,
    )
    atAccuracyFloor(state) // stage 0 -> 33% for a 100-accuracy Tackle
    executeTurn(state, [useMove(1, 'MOVE_LOCK_ON'), null], loopDeps(state, fixedDamage(0)))
    expect(rng.calls).toBe(1) // the Lock-On accuracy draw, which cannot miss (accuracy 0 -> 101)

    // Prove the flag is what carries the hit: 101 with it, 33 without.
    const lockedInputs = buildAccuracyInputs(state, 0, 1, 'MOVE_TACKLE', false, loopDeps(state, fixedDamage(0)))
    expect(getTotalAccuracy(lockedInputs.inputs).accuracy).toBe(101) // :1262
    const saved = foeOf(state).statuses3
    foeOf(state).statuses3 = 0
    const bareInputs = buildAccuracyInputs(state, 0, 1, 'MOVE_TACKLE', false, loopDeps(state, fixedDamage(0)))
    expect(getTotalAccuracy(bareInputs.inputs).accuracy).toBe(33) // stage 0 ratio 1/3
    foeOf(state).statuses3 = saved

    // Turn 2: a 99 draw is a miss at 33% but a hit at 101, so the foe takes the Tackle.
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(50)))
    expect(foeOf(state).mon.hp).toBe(50)
    expect(state.battlers[0]!.mon.pp[1]).toBe(14)
    expect(rng.calls).toBe(2)
  })

  it('fails behind a Substitute (:4743, jumpifsubstituteblocks) with no flag and no draw; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LOCK_ON'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_LOCK_ON')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).statuses3 & STATUS3_ALWAYS_HITS).toBe(0)
    expect(foeOf(state).volatiles.battlerWithSureHit).toBe(0)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('misses a semi-invulnerable target (GetTotalAccuracy :1267 -> 0), leaving no flag; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LOCK_ON'), foe(), rng)
    foeOf(state).statuses3 = setFlag(0, STATUS3_ON_AIR)
    const out = runVs(state, 'MOVE_LOCK_ON')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).statuses3 & STATUS3_ALWAYS_HITS).toBe(0)
    expect(rng.calls).toBe(1) // the ACC_CURR_MOVE draw (:1433); accuracy 0 >= 0 always misses
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSimpleBeam data/battle_scripts_1.s:2321-2334; VARIOUS_SET_SIMPLE_BEAM
// src/battle_script_commands.c:7220-7229; IsEntrainmentTargetOrSimpleBeamBannedAbility
// src/battle_util.c:8457-8464 (sEntrainmentTargetSimpleBeamBannedAbilities :97-99 = Truant);
// DoesBattlerHaveAbilityShield :6539-6545.
describe('cycle 121 - Simple Beam', () => {
  it('replaces the target ability with ABILITY_SIMPLE after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SIMPLE_BEAM'), foe({ abilities: only('ABILITY_OVERGROW') }), rng)
    const out = runVs(state, 'MOVE_SIMPLE_BEAM')
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_SIMPLE') // :7227-7228
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :2323
    expect(ppOf(state)).toBe(9) // ppreduce :2325
  })

  it('fails when the target already has Simple, ignoring suppression (:7223); ability stays put; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SIMPLE_BEAM'), foe({ abilities: only('ABILITY_SIMPLE') }), rng)
    const out = runVs(state, 'MOVE_SIMPLE_BEAM')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_SIMPLE')
    expect(rng.calls).toBe(1) // accuracycheck runs first
    expect(ppOf(state)).toBe(9)
  })

  it('fails on a banned target ability (ABILITY_TRUANT, :7222); ability stays put; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SIMPLE_BEAM'), foe({ abilities: only('ABILITY_TRUANT') }), rng)
    const out = runVs(state, 'MOVE_SIMPLE_BEAM')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_TRUANT')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the target holds an Ability Shield (:7223, DoesBattlerHaveAbilityShield :6539-6545); PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SIMPLE_BEAM'), foe({ abilities: only('ABILITY_OVERGROW'), itemId: 'ITEM_ABILITY_SHIELD' }), rng)
    const out = runVs(state, 'MOVE_SIMPLE_BEAM')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_OVERGROW')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 (33%) leaves the ability alone; PP still spent', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_SIMPLE_BEAM'), foe({ abilities: only('ABILITY_OVERGROW') }), rng))
    const out = runVs(state, 'MOVE_SIMPLE_BEAM')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_OVERGROW')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectToxicThread data/battle_scripts_1.s:1704-1730; the failure branches jump to
// BattleScript_ButItFailedAtkStringPpReduce (:5938-5941); statbuffchange's fail target is
// BattleScript_ToxicThreadTryPsn (:1714, :1727-1729), so an already-minimal Speed still poisons.
describe('cycle 121 - Toxic Thread', () => {
  it('drops Speed 6 -> 3 and poisons a clean target after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TOXIC_THREAD'), foe(), rng)
    const out = runVs(state, 'MOVE_TOXIC_THREAD')
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(3) // setstatchanger STAT_SPEED, 3 (:1705)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: -3 }])
    expect(foeOf(state).mon.status1 & STATUS1_POISON).toBe(STATUS1_POISON) // :1728-1729
    expect(out.actions[0]?.statusApplied).toEqual({ battlerId: 1, status: 'POISON' })
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :1711
    expect(ppOf(state)).toBe(9) // ppreduce :1713
  })

  it('with Speed already at stage 0 but unpoisoned: the stat drop fails and control falls to TryPsn; only the poison lands', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TOXIC_THREAD'), foe(), rng)
    foeOf(state).mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_TOXIC_THREAD')
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(MIN_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(foeOf(state).mon.status1 & STATUS1_POISON).toBe(STATUS1_POISON) // :1727-1729
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('with Speed at 0 AND already poisoned it fails before the accuracy roll (:1708-1709); PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TOXIC_THREAD'), foe({ status1: STATUS1_POISON }), rng)
    foeOf(state).mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_TOXIC_THREAD')
    expect(out.actions[0]?.missed).toBe(true)
    expect(rng.calls).toBe(0)
    expect(foeOf(state).mon.status1).toBe(STATUS1_POISON)
    expect(ppOf(state)).toBe(9)
  })

  it('fails behind a Substitute (:1707) with no draw; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TOXIC_THREAD'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_TOXIC_THREAD')
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it.each(['POISON', 'STEEL'])('a %s-type target still loses 3 Speed but cannot be poisoned (CanPoisonType)', (type) => {
    const rng = countRng()
    const state = battle(user('MOVE_TOXIC_THREAD'), foe({ types: [type, 'MYSTERY', 'MYSTERY'] }), rng)
    const out = runVs(state, 'MOVE_TOXIC_THREAD')
    expect(foeOf(state).mon.statStages[STAT_SPEED]).toBe(3)
    expect(out.actions[0]?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: -3 }])
    expect(foeOf(state).mon.status1).toBe(0)
    expect(out.actions[0]?.statusApplied).toBeNull()
    // The poison step failing does not mark the move missed: seteffectprimary has no MOVE_RESULT_MISSED.
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectEmbargo data/battle_scripts_1.s:2681-2691; Cmd_setembargo
// src/battle_script_commands.c:11190-11198; ENDTURN_EMBARGO src/battle_util.c:2862-2874;
// STATUS3_EMBARGO negation of a berry item src/battle_util.c:6520-6524 (hasNonNegatedBerry).
describe('cycle 121 - Embargo', () => {
  it('sets STATUS3_EMBARGO and embargoTimer 5 (4 after the end-of-turn tick) after one accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EMBARGO'), foe(), rng)
    const out = runVs(state, 'MOVE_EMBARGO')
    expect(hasFlag(foeOf(state).statuses3, STATUS3_EMBARGO)).toBe(true) // :11195
    // :11196 sets 5; ENDTURN_EMBARGO (battle_util.c:2864-2866) decrements it to 4.
    expect(foeOf(state).volatiles.embargoTimer).toBe(4)
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE :2683
    expect(ppOf(state)).toBe(9) // ppreduce :2685
  })

  it('a second use fails (:11191) and does not reset the timer; PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EMBARGO'), foe(), rng)
    foeOf(state).statuses3 = setFlag(0, STATUS3_EMBARGO)
    foeOf(state).volatiles.embargoTimer = 3
    const out = runVs(state, 'MOVE_EMBARGO')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_EMBARGO)).toBe(true)
    expect(foeOf(state).volatiles.embargoTimer).toBe(2) // 3 -> 2; a success would have reset 5 -> 4
    expect(rng.calls).toBe(1) // the accuracycheck still runs before setembargo
    expect(ppOf(state)).toBe(9)
  })

  it('a miss at accuracy stage 0 (33%) sets no flag; PP still spent', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_EMBARGO'), foe(), rng))
    const out = runVs(state, 'MOVE_EMBARGO')
    expect(out.actions[0]?.missed).toBe(true)
    expect(hasFlag(foeOf(state).statuses3, STATUS3_EMBARGO)).toBe(false)
    expect(foeOf(state).volatiles.embargoTimer).toBe(0)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('negates the target\'s berry in IsItemNegated (battle_util.c:6520-6524 -> hasNonNegatedBerry)', () => {
    const state = battle(user('MOVE_EMBARGO'), foe({ itemId: 'ITEM_SITRUS_BERRY' }), countRng())
    const deps = loopDeps(state, fixedDamage(0))
    expect(hasNonNegatedBerry(state, 1, deps)).toBe(true) // no embargo yet: the Sitrus counts
    runVs(state, 'MOVE_EMBARGO')
    expect(hasNonNegatedBerry(state, 1, deps)).toBe(false) // STATUS3_EMBARGO short-circuits it (moveEffects.ts:8919-8922)
  })
})

// BattleScript_EffectRolePlay data/battle_scripts_1.s:6294-6304; Cmd_trycopyability
// src/battle_script_commands.c:11767-11781; IsRolePlayBannedAbilityAtk :8423-8426;
// IsRolePlayBannedAbility :8428-8436 (sRolePlayBannedAbilities :90-95).
describe('cycle 121 - Role Play', () => {
  it('copies the target ability with no accuracy draw; PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_ROLE_PLAY', { abilities: only('ABILITY_DRIZZLE') }), foe({ abilities: only('ABILITY_INTIMIDATE') }), rng)
    const out = runVs(state, 'MOVE_ROLE_PLAY')
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_INTIMIDATE') // ReplaceAbility :11777-11778
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON :6298 (:1403-1411 draws nothing)
    expect(ppOf(state)).toBe(9) // ppreduce :6297
  })

  it('fails when the target has ABILITY_NONE (:11771); the user keeps its ability; PP spent', () => {
    const state = battle(user('MOVE_ROLE_PLAY', { abilities: only('ABILITY_DRIZZLE') }), foe({ abilities: noAbility }), countRng())
    const out = runVs(state, 'MOVE_ROLE_PLAY')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_DRIZZLE')
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the user already has the target ability (HasAbilityIgnoringSuppression, :11771); PP spent', () => {
    const state = battle(user('MOVE_ROLE_PLAY', { abilities: only('ABILITY_INTIMIDATE') }), foe({ abilities: only('ABILITY_INTIMIDATE') }), countRng())
    const out = runVs(state, 'MOVE_ROLE_PLAY')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_INTIMIDATE')
    expect(ppOf(state)).toBe(9)
  })

  it('fails on a role-play-banned target ability (ABILITY_WONDER_GUARD, sRolePlayBannedAbilities :90-95, :11772); PP spent', () => {
    const state = battle(user('MOVE_ROLE_PLAY', { abilities: only('ABILITY_DRIZZLE') }), foe({ abilities: only('ABILITY_WONDER_GUARD') }), countRng())
    const out = runVs(state, 'MOVE_ROLE_PLAY')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_DRIZZLE')
    expect(foeOf(state).mon.abilities.ability).toBe('ABILITY_WONDER_GUARD')
    expect(ppOf(state)).toBe(9)
  })

  it('fails on a role-play-banned USER ability (IsRolePlayBannedAbilityAtk :8423-8426, persistent); PP spent', () => {
    const state = battle(user('MOVE_ROLE_PLAY', { abilities: only('ABILITY_MULTITYPE') }), foe({ abilities: only('ABILITY_INTIMIDATE') }), countRng())
    const out = runVs(state, 'MOVE_ROLE_PLAY')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_MULTITYPE')
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the user holds an Ability Shield (:11773, DoesBattlerHaveAbilityShield :6539-6545); PP spent', () => {
    const state = battle(
      user('MOVE_ROLE_PLAY', { abilities: only('ABILITY_DRIZZLE'), itemId: 'ITEM_ABILITY_SHIELD' }),
      foe({ abilities: only('ABILITY_INTIMIDATE') }),
      countRng(),
    )
    const out = runVs(state, 'MOVE_ROLE_PLAY')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_DRIZZLE')
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_TELEKINESIS',
  'EFFECT_MAT_BLOCK',
  'EFFECT_LOCK_ON',
  'EFFECT_SIMPLE_BEAM',
  'EFFECT_TOXIC_THREAD',
  'EFFECT_EMBARGO',
  'EFFECT_ROLE_PLAY',
]

describe('cycle 121 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})

describe('cycle 121 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_TELEKINESIS', 'EFFECT_TELEKINESIS'],
    ['MOVE_MAT_BLOCK', 'EFFECT_MAT_BLOCK'],
    ['MOVE_LOCK_ON', 'EFFECT_LOCK_ON'],
    ['MOVE_SIMPLE_BEAM', 'EFFECT_SIMPLE_BEAM'],
    ['MOVE_TOXIC_THREAD', 'EFFECT_TOXIC_THREAD'],
    ['MOVE_EMBARGO', 'EFFECT_EMBARGO'],
    ['MOVE_ROLE_PLAY', 'EFFECT_ROLE_PLAY'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
