/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 117: field, hazard, recovery and stat effect verification (9). Each effect is read against
// the C (data/battle_scripts_1.s, src/battle_script_commands.c, src/battle_util.c) and proven by a
// forced scenario whose numbers are derived by hand. Timers that the end-of-turn phase would tick
// are captured mid-turn (runSnap); the `started.*` flag a setter writes suppresses that decrement
// for the turn it is set, exactly as the C does.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  INVERSE_ROOM_DURATION,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_STICKY_WEB,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPDEF,
  STATUS1_BLEED,
  STATUS2_SUBSTITUTE,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_INVERSE_ROOM,
  STATUS_FIELD_TOXIC_TERRAIN,
  TERRAIN_DURATION,
  TERRAIN_DURATION_EXTENDED,
  WEATHER_RAIN_ANY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import { weatherHasEffect } from './fieldEndTurn'
import { PARADOX_BOOSTER_ENERGY } from './onWeather'
import { groundingFor } from './driver/session'
import { isBattlerWeatherAffected } from './statBuffs'
import type { BattleState, RandomSource, SimBattleMon } from './state'
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

/** Every draw returns `value`; `calls` counts draws. 50 misses a 33-accuracy check. */
function fixedRng(value: number): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return value
    },
  }
  return rng
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
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
  }
}

const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

/** The real damage engine, reading hold effects and field effects from the state (driver/session.ts). */
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

const THIS_FILE = 'web/src/engine/sim/cycle117FieldEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect

/** The user (battler 0, Mudkip) knows only `moveId` with 10 PP. */
const user = (moveId: string, overrides: Partial<SimBattleMon> = {}) =>
  monFor('SPECIES_MUDKIP', {
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 150 },
    moves: [moveId, null, null, null],
    pp: [10, 0, 0, 0],
    ...overrides,
  })
const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

/** One turn: the user (battler 0) uses `moveId` on battler 1, the foe does nothing. */
function runVs(state: BattleState, moveId: string): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedDamage(0)))
}
/**
 * The user acts first, then the foe Tackles; `snap` runs when the foe's Tackle resolves, i.e.
 * after the user's move and before any end-of-turn timer ticks.
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
const FAST = { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 } }

const ppOf = (state: BattleState) => state.battlers[0]!.mon.pp[0]
const userAction = (out: TurnOutcome) => out.actions.find((a) => a.battlerId === 0)!

describe('cycle 117 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_STICKY_WEB', 'EFFECT_STICKY_WEB'],
    ['MOVE_MAGNETIC_FLUX', 'EFFECT_MAGNETIC_FLUX'],
    ['MOVE_AROMATIC_MIST', 'EFFECT_AROMATIC_MIST'],
    ['MOVE_REFLECT_TYPE', 'EFFECT_REFLECT_TYPE'],
    ['MOVE_DRAIN_BRAIN', 'EFFECT_DRAIN_BRAIN'],
    ['MOVE_MORNING_SUN', 'EFFECT_MORNING_SUN'],
    ['MOVE_INVERSE_ROOM', 'EFFECT_INVERSE_ROOM'],
    ['MOVE_TOXIC_TERRAIN', 'EFFECT_TOXIC_TERRAIN'],
    ['MOVE_CLEAR_SKIES', 'EFFECT_CLEAR_SKIES'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})

// BattleScript_EffectStickyWeb data/battle_scripts_1.s:2570-2578: attackcanceler, attackstring,
// ppreduce, setstickyweb BattleScript_ButItFailed (no accuracycheck). Cmd_setstickyweb
// src/battle_script_commands.c:11462-11472: fails when the TARGET side already has
// SIDE_STATUS_STICKY_WEB; otherwise sets that side's bit, zeroes stickyWebTimer and records
// stickyWebUser = gBattlerAttacker (:11469, "For Mirror Armor").
describe('cycle 117 - Sticky Web', () => {
  const sideNow = (state: BattleState, side: number) => ({
    flag: hasFlag(state.sides[side].statuses, SIDE_STATUS_STICKY_WEB),
    timer: state.sides[side].timers.stickyWebTimer,
  })

  it('sets the foe side bit, timer 0 and stickyWebUser 0 (:11467-11469)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STICKY_WEB'), foe(), rng)
    runVs(state, 'MOVE_STICKY_WEB')
    expect(sideNow(state, 1)).toEqual({ flag: true, timer: 0 })
    expect(sideNow(state, 0)).toEqual({ flag: false, timer: 0 })
    expect(state.stickyWebUser).toBe(0)
    expect(rng.calls).toBe(0) // the script has no accuracycheck
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails (:11464-11465): the web and its setter are unchanged, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STICKY_WEB'), foe(), rng)
    state.sides[1].statuses |= SIDE_STATUS_STICKY_WEB
    state.sides[1].timers.stickyWebTimer = 4
    state.stickyWebUser = 1
    expect(runSnap(state, 'MOVE_STICKY_WEB', () => sideNow(state, 1))).toEqual({ flag: true, timer: 4 })
    expect(state.stickyWebUser).toBe(1)
    expect(rng.calls).toBe(1) // the foe's Tackle; the Sticky Web script draws nothing
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectMagneticFlux data/battle_scripts_1.s:1173-1211: attackcanceler, attackstring,
// ppreduce, gBattleCommunication = 0, then per target with ABILITY_MINUS/PLUS (:1179-1180): raise
// Defense by 1 (:1192-1197, a blocked raise at +6 does not count) then Sp. Def by 1 (:1199-1204),
// each applied raise adding 1 to gBattleCommunication; communication 0 -> ButItFailed (:1209-1210).
// In singles only the user (BS_TARGET == BS_ATTACKER) is checked (:1206).
describe('cycle 117 - Magnetic Flux', () => {
  const stages = (state: BattleState) => ({
    def: state.battlers[0]!.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE,
    spdef: state.battlers[0]!.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE,
  })

  it.each([
    ['ABILITY_PLUS'],
    ['ABILITY_MINUS'],
  ])('%s raises Def and Sp. Def by 1 (:1192-1204)', (ability) => {
    const rng = countRng()
    const state = battle(user('MOVE_MAGNETIC_FLUX', { abilities: only(ability) }), foe(), rng)
    runVs(state, 'MOVE_MAGNETIC_FLUX')
    expect(stages(state)).toEqual({ def: DEFAULT_STAT_STAGE + 1, spdef: DEFAULT_STAT_STAGE + 1 })
    expect(rng.calls).toBe(0) // no accuracycheck
    expect(ppOf(state)).toBe(9)
  })

  it('fails with neither Plus nor Minus (:1179-1181, :1209-1210): no stat change, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MAGNETIC_FLUX'), foe(), rng)
    const out = runVs(state, 'MOVE_MAGNETIC_FLUX')
    expect(stages(state)).toEqual({ def: DEFAULT_STAT_STAGE, spdef: DEFAULT_STAT_STAGE })
    expect(userAction(out).missed).toBe(true)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('with Def at +6 only Sp. Def is raised (:1183-1184, blocked Def raise adds nothing)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MAGNETIC_FLUX', { abilities: only('ABILITY_PLUS') }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    runVs(state, 'MOVE_MAGNETIC_FLUX')
    expect(stages(state)).toEqual({ def: MAX_STAT_STAGE, spdef: DEFAULT_STAT_STAGE + 1 })
    expect(ppOf(state)).toBe(9)
  })

  it('with both at +6 it fails (:1183-1184, :1209-1210): stages unchanged, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MAGNETIC_FLUX', { abilities: only('ABILITY_PLUS') }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_MAGNETIC_FLUX')
    expect(stages(state)).toEqual({ def: MAX_STAT_STAGE, spdef: MAX_STAT_STAGE })
    expect(userAction(out).missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectAromaticMist data/battle_scripts_1.s:1134-1152: ppreduce; if the user's Sp. Def
// is at +6 (:1138) jump to the partner check, which in singles fails because BS_ATTACKER_PARTNER is
// absent (:1139). Otherwise setstatchanger STAT_SPDEF, 2 (:1144) and statbuffchange
// MOVE_EFFECT_AFFECTS_USER (:1145). The double's partner half (:1155-1171) is not tested here.
describe('cycle 117 - Aromatic Mist (singles)', () => {
  const spdefOf = (state: BattleState) => state.battlers[0]!.mon.statStages[STAT_SPDEF] ?? DEFAULT_STAT_STAGE

  it('raises the user Sp. Def by 2 (:1144-1145)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AROMATIC_MIST'), foe(), rng)
    runVs(state, 'MOVE_AROMATIC_MIST')
    expect(spdefOf(state)).toBe(DEFAULT_STAT_STAGE + 2)
    expect(rng.calls).toBe(0) // no accuracycheck
    expect(ppOf(state)).toBe(9)
  })

  it('at +5 it clamps to +6, gaining one stage (:1144)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AROMATIC_MIST'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE - 1
    runVs(state, 'MOVE_AROMATIC_MIST')
    expect(spdefOf(state)).toBe(MAX_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })

  it('at +6 with no partner it fails (:1138-1139): stage unchanged, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AROMATIC_MIST'), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_AROMATIC_MIST')
    expect(spdefOf(state)).toBe(MAX_STAT_STAGE)
    expect(userAction(out).missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectReflectType data/battle_scripts_1.s:1964-1975: attackcanceler, accuracycheck
// BattleScript_PrintMoveMissed ACC_CURR_MOVE, attackstring, ppreduce, tryreflecttype
// BattleScript_ButItFailed. VARIOUS_TRY_REFLECT_TYPE src/battle_script_commands.c:7348-7364 fails
// on an Arceus/Silvally target or when both attacker types are MYSTERY; otherwise it writes the
// ATTACKER's types onto the TARGET (ER reverses vanilla). type3 is never touched.
describe('cycle 117 - Reflect Type', () => {
  const targetTypes = (state: BattleState) => state.battlers[1]!.mon.types

  it('copies a dual-type user onto the target type1/type2 (:7360-7363)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_REFLECT_TYPE', { types: ['FIRE', 'FLYING', 'MYSTERY'] }), foe(), rng)
    runVs(state, 'MOVE_REFLECT_TYPE')
    expect(targetTypes(state)).toEqual(['FIRE', 'FLYING', 'MYSTERY'])
    expect(rng.calls).toBe(1) // the accuracycheck draws even at accuracy 0 (:1424, :1433)
    expect(ppOf(state)).toBe(9)
  })

  it('a real single-type user (type2 = MYSTERY) copies type1 into both slots (:7355-7357)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_REFLECT_TYPE'), foe(), rng)
    // monFor(SPECIES_MUDKIP) is WATER/MYSTERY/MYSTERY; the second branch fires.
    runVs(state, 'MOVE_REFLECT_TYPE')
    expect(targetTypes(state)).toEqual(['WATER', 'WATER', 'MYSTERY'])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('an Arceus target fails (:7350-7351): types unchanged, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_REFLECT_TYPE'), monFor('SPECIES_ARCEUS'), rng)
    const out = runVs(state, 'MOVE_REFLECT_TYPE')
    expect(targetTypes(state)).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
    expect(userAction(out).missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a both-MYSTERY user fails (:7358-7359): types unchanged, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_REFLECT_TYPE', { types: ['MYSTERY', 'MYSTERY', 'MYSTERY'] }), foe(), rng)
    const out = runVs(state, 'MOVE_REFLECT_TYPE')
    expect(targetTypes(state)).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
    expect(userAction(out).missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('accuracy 0 means "always hits" (:1287-1288): +6 evasion cannot miss', () => {
    // moves.json MOVE_REFLECT_TYPE accuracy = 0 -> GetTotalAccuracy returns the 101 sentinel
    // (:1286-1288, :1364-1367), so the Cmd_accuracycheck draw (:1433) can never fail. The draw still happens.
    const rng = fixedRng(99)
    const state = battle(user('MOVE_REFLECT_TYPE', { types: ['FIRE', 'FLYING', 'MYSTERY'] }), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 6
    const out = runVs(state, 'MOVE_REFLECT_TYPE')
    expect(userAction(out).missed).toBe(false)
    expect(targetTypes(state)).toEqual(['FIRE', 'FLYING', 'MYSTERY'])
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectDrainBrain data/battle_scripts_1.s:944-990. setstatchanger STAT_SPATK, 1, TRUE;
// attackcanceler; jumpifsubstituteblocks ButItFailedAtkStringPpReduce (:947) BEFORE the accuracy
// check (:948) and ppreduce (:950). At MIN Sp. Atk it falls through :951 to a doomed statbuffchange
// (:953, BattleScript_DrainBrainTryHp at :973 is unreferenced in this script). Otherwise
// getstatvalue BS_TARGET STAT_SPATK (:958) reads the PRE-drop stat, then the user at full HP /
// heal-blocked / bleeding still lowers (:959-961, :985-990) but the heal's own jumpiffullhp (:978)
// ends it; the ordinary path lowers (:964) and heals by that value (:979 DMG_BIG_ROOT ->
// GetDrainedBigRootHp, battle_util.c:2369-2376, only doubles the amount with Big Root, which is not
// assumed here).
describe('cycle 117 - Drain Brain', () => {
  const targetSpAtk = (state: BattleState) => state.battlers[1]!.mon.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE

  it('drops the target Sp. Atk by 1 and heals the user by the pre-drop stat (:958, :964, :979)', () => {
    // Target raw Sp. Atk 100 at a neutral stage -> CalculateStat's stage ratio is 1:1 -> heal 100.
    const rng = countRng()
    const state = battle(user('MOVE_DRAIN_BRAIN', { hp: 50, maxHp: 200 }), foe(), rng)
    runVs(state, 'MOVE_DRAIN_BRAIN')
    expect(targetSpAtk(state)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.hp).toBe(150)
    expect(rng.calls).toBe(1) // the script's accuracycheck
    expect(ppOf(state)).toBe(9)
  })

  it('a full-HP user still lowers the stat but does not heal (:959, :985-990, :978)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DRAIN_BRAIN'), foe(), rng)
    const out = runVs(state, 'MOVE_DRAIN_BRAIN')
    expect(targetSpAtk(state)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(userAction(out).missed).toBe(false)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a target already at MIN Sp. Atk cannot be lowered and nothing is drained (:951-956)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DRAIN_BRAIN', { hp: 50, maxHp: 200 }), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_SPATK] = MIN_STAT_STAGE
    runVs(state, 'MOVE_DRAIN_BRAIN')
    expect(targetSpAtk(state)).toBe(MIN_STAT_STAGE)
    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute blocks it before the accuracy check (:947): no stage change, PP spent, no draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DRAIN_BRAIN', { hp: 50, maxHp: 200 }), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    const out = runVs(state, 'MOVE_DRAIN_BRAIN')
    expect(targetSpAtk(state)).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(userAction(out).missed).toBe(true)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a missed accuracy roll changes nothing but still spends PP (:948, :950)', () => {
    // 100 accuracy with +6 evasion is 100/3 = 33 (accuracy.ts's stage ratio 1/3).
    const rng = fixedRng(50)
    const state = battle(user('MOVE_DRAIN_BRAIN', { hp: 50, maxHp: 200 }), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 6
    const out = runVs(state, 'MOVE_DRAIN_BRAIN')
    expect(userAction(out).missed).toBe(true)
    expect(targetSpAtk(state)).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectMorningSun data/battle_scripts_1.s:5495-5503 (shared body):
// attackcanceler, attackstring, ppreduce, recoverbasedonsunlight BattleScript_AlreadyAtFullHp,
// goto BattleScript_PresentHealTarget. Cmd_recoverbasedonsunlight
// src/battle_script_commands.c:11433-11460: bleed -> damage 0 (PresentHealTarget cures it,
// :5919, :156-165); otherwise sun (IsBattlerWeatherAffected WEATHER_SUN_ANY or HasChloroplast)
// 2/3 maxHP, rain/sand/fog/hail 1/4, else 1/2, minimum 1; full HP -> no heal. maxHp 301 makes the
// integer division visible: 150 clear, 200 sun, 75 rain.
describe('cycle 117 - Morning Sun', () => {
  const hpOf = (state: BattleState) => state.battlers[0]!.mon.hp

  it('clear weather heals maxHp/2 (:11450-11451)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MORNING_SUN', { hp: 1, maxHp: 301 }), foe(), rng)
    runVs(state, 'MOVE_MORNING_SUN')
    expect(hpOf(state)).toBe(151)
    expect(rng.calls).toBe(0) // no accuracycheck
    expect(ppOf(state)).toBe(9)
  })

  it('sun heals 2/3 maxHP (:11446-11447)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MORNING_SUN', { hp: 1, maxHp: 301 }), foe(), rng)
    state.field.weather = WEATHER_SUN_TEMPORARY
    runVs(state, 'MOVE_MORNING_SUN')
    expect(hpOf(state)).toBe(201)
    expect(ppOf(state)).toBe(9)
  })

  it('rain heals 1/4 maxHP (:11448-11449)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MORNING_SUN', { hp: 1, maxHp: 301 }), foe(), rng)
    state.field.weather = WEATHER_RAIN_TEMPORARY
    runVs(state, 'MOVE_MORNING_SUN')
    expect(hpOf(state)).toBe(76)
    expect(ppOf(state)).toBe(9)
  })

  it('the heal is capped at max HP (:1911)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MORNING_SUN', { hp: 280, maxHp: 301 }), foe(), rng)
    state.field.weather = WEATHER_SUN_TEMPORARY // 200 requested, only 21 land
    runVs(state, 'MOVE_MORNING_SUN')
    expect(hpOf(state)).toBe(301)
    expect(ppOf(state)).toBe(9)
  })

  it('at full HP it heals nothing (:11457-11458) but spends PP', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MORNING_SUN', { hp: 301, maxHp: 301 }), foe(), rng)
    const out = runVs(state, 'MOVE_MORNING_SUN')
    expect(hpOf(state)).toBe(301)
    expect(userAction(out).missed).toBe(false)
    expect(ppOf(state)).toBe(9)
  })

  it('a bleeding user is cured instead of healed (:11435-11437, :5919)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MORNING_SUN', { hp: 100, maxHp: 301, status1: STATUS1_BLEED }), foe(), rng)
    runVs(state, 'MOVE_MORNING_SUN')
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(hpOf(state)).toBe(100) // no healing, and the cleared bleed deals no end-turn damage
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectInverseRoom data/battle_scripts_1.s:2657-2667 (shared with Wonder/Magic Room):
// attackcanceler, attackstring, ppreduce, setroom BattleScript_ButItFailed. Cmd_setroom /
// HandleRoomMove src/battle_script_commands.c:11866-11875, 11908-11916: fails when the room is
// active with timer > 10; otherwise the bit TOGGLES (on -> off, timer 0; off -> on, timer
// INVERSE_ROOM_DURATION = 5, include/battle_util.h:60) and started.inverseRoom is set. The room's
// damage half is GetTypeModifier's inverse chart (battle_util.c:8021-8038).
describe('cycle 117 - Inverse Room', () => {
  const fieldNow = (state: BattleState) => ({
    flag: hasFlag(state.field.statuses, STATUS_FIELD_INVERSE_ROOM),
    timer: state.field.timers.inverseRoomTimer,
  })

  it('sets STATUS_FIELD_INVERSE_ROOM with timer 5 and started.inverseRoom (:11908-11914)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_INVERSE_ROOM', FAST), foe(), rng)
    expect(runSnap(state, 'MOVE_INVERSE_ROOM', () => fieldNow(state))).toEqual({
      flag: true,
      timer: INVERSE_ROOM_DURATION,
    })
    expect(state.field.timers.started.inverseRoom).toBe(true)
    expect(rng.calls).toBe(1) // no accuracycheck; the draw is the foe's Tackle
    expect(ppOf(state)).toBe(9)
  })

  it('a second use while it runs toggles it OFF and zeroes the timer (:11868-11871)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_INVERSE_ROOM', FAST), foe(), rng)
    state.field.statuses |= STATUS_FIELD_INVERSE_ROOM
    state.field.timers.inverseRoomTimer = 4
    expect(runSnap(state, 'MOVE_INVERSE_ROOM', () => fieldNow(state))).toEqual({ flag: false, timer: 0 })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a permanent room (timer > 10) fails instead of toggling off (:11910-11911)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_INVERSE_ROOM', FAST), foe(), rng)
    state.field.statuses |= STATUS_FIELD_INVERSE_ROOM
    state.field.timers.inverseRoomTimer = 11
    // Mid-turn the failed move left the room untouched (ENDTURN_INVERSE_ROOM ticks it afterwards).
    expect(runSnap(state, 'MOVE_INVERSE_ROOM', () => fieldNow(state))).toEqual({ flag: true, timer: 11 })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('inverts the type chart: Fire into Water is 2x with the room, 0.5x without (battle_util.c:8021-8038)', () => {
    const without = battle(user('MOVE_INVERSE_ROOM'), foe(), countRng())
    const withRoom = battle(user('MOVE_INVERSE_ROOM'), foe(), countRng())
    withRoom.field.statuses |= STATUS_FIELD_INVERSE_ROOM
    // UQ_4_12 (10-bit): 0.5 -> 512, 2.0 -> 2048 (typeEffectiveness.ts:109-120, fixed.ts).
    expect(bridgeDamage(without).typeEffectiveness!(without, 0, 1, 'MOVE_EMBER').effectiveness).toBe(512)
    expect(bridgeDamage(withRoom).typeEffectiveness!(withRoom, 0, 1, 'MOVE_EMBER').effectiveness).toBe(2048)
  })
})

// The shared terrain script data/battle_scripts_1.s:2192-2206 (Misty/Grassy/Electric/Psychic) is
// attackcanceler, attackstring, ppreduce, setterrain BattleScript_ButItFailed. The vendored tree has
// no BattleScript_EffectToxicTerrain label and no upstream move carrying the effect, so the setter
// is read from HandleTerrainMove's own EFFECT_TOXIC_TERRAIN case
// (src/battle_script_commands.c:6445-6448) plus the common body at :6451-6462: fail only when that
// same terrain bit is set; otherwise clear every terrain bit, set the new one with started.terrain,
// terrainBattlerId = attacker and the timer (8, or 12 with Terrain Extender;
// include/battle_util.h:52-53).
describe.each([
  ['MOVE_TOXIC_TERRAIN', STATUS_FIELD_TOXIC_TERRAIN, STATUS_FIELD_ELECTRIC_TERRAIN],
] as const)('cycle 117 - %s', (moveId, terrainFlag, otherTerrain) => {
  const fieldNow = (state: BattleState) => ({
    flag: hasFlag(state.field.statuses, terrainFlag),
    other: hasFlag(state.field.statuses, otherTerrain),
    timer: state.field.timers.terrainTimer,
    by: state.field.timers.terrainBattlerId,
  })

  it('sets its own bit, timer 8 and attacker ownership (:6451-6462)', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      other: false,
      timer: TERRAIN_DURATION,
      by: 0,
    })
    expect(state.field.timers.started.terrain).toBe(true)
    // The terrain script has no accuracycheck; the single draw is the foe's Tackle.
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('replaces a different running terrain: old bit cleared, owner/timer reset (:6454-6461)', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    state.field.statuses |= otherTerrain
    state.field.timers.terrainTimer = 3
    state.field.timers.terrainBattlerId = 1
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      other: false,
      timer: TERRAIN_DURATION,
      by: 0,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when that same terrain is already up (:6451-6452): flag/timer/owner unchanged, PP spent', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    state.field.statuses |= terrainFlag
    state.field.timers.terrainTimer = 3
    state.field.timers.terrainBattlerId = 1
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      other: false,
      timer: 3,
      by: 1,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Terrain Extender sets timer 12 (:6458-6461)', () => {
    const rng = countRng()
    const state = battle(user(moveId, { ...FAST, itemId: 'ITEM_TERRAIN_EXTENDER' }), foe(), rng)
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      other: false,
      timer: TERRAIN_DURATION_EXTENDED,
      by: 0,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectClearSkies data/battle_scripts_1.s:12453-12463: attackcanceler, attackstring,
// ppreduce, trysetclearskies BattleScript_ButItFailed, then `call BattleScript_OnWeatherChange`
// (:9833-9841). VARIOUS_SET_CLEAR_SKIES src/battle_script_commands.c:8683-8691: fails when
// clearSkiesTimer != 0; else sets it to 5 and started.clearSkiesTimer. The timer never touches
// gBattleWeather; WEATHER_HAS_EFFECT (include/battle_util.h:45-46) is the whole suppression
// mechanism, and ENDTURN_CLEARSKIES (battle_util.c:2278-2280) is gated by !started.clearSkiesTimer.
describe('cycle 117 - Clear Skies', () => {
  it('sets clearSkiesTimer 5 and started.clearSkiesTimer (:8688-8689)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CLEAR_SKIES'), foe(), rng)
    runVs(state, 'MOVE_CLEAR_SKIES')
    expect(state.field.timers.clearSkiesTimer).toBe(5)
    expect(state.field.timers.started.clearSkiesTimer).toBe(true)
    expect(rng.calls).toBe(0) // no accuracycheck
    expect(ppOf(state)).toBe(9)
  })

  it('a second use while the timer runs fails (:8685-8686): timer unchanged mid-turn, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CLEAR_SKIES', FAST), foe(), rng)
    state.field.timers.clearSkiesTimer = 3
    // Captured before ENDTURN_CLEARSKIES could tick 3 -> 2 (started is cleared at turn start).
    expect(runSnap(state, 'MOVE_CLEAR_SKIES', () => state.field.timers.clearSkiesTimer)).toBe(3)
    expect(rng.calls).toBe(1) // the foe's Tackle
    expect(ppOf(state)).toBe(9)
  })

  it('runs BattleScript_OnWeatherChange once on success even without a weather change (:12462)', () => {
    // Protosynthesis with Booster Energy activates on ANY onWeather dispatch regardless of weather
    // (ProtosynthesisHandler, src/abilities.cc:6927-6967), so it observes the dispatch that Clear
    // Skies calls directly.
    const rng = countRng()
    const state = battle(
      user('MOVE_CLEAR_SKIES'),
      foe({ abilities: only('ABILITY_PROTOSYNTHESIS'), itemId: 'ITEM_BOOSTER_ENERGY' }),
      rng,
    )
    state.field.weather = WEATHER_RAIN_TEMPORARY
    runVs(state, 'MOVE_CLEAR_SKIES')
    expect(state.battlers[1]!.volatiles.abilityState[0]! & 3).toBe(PARADOX_BOOSTER_ENERGY)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(ppOf(state)).toBe(9)
  })

  it('suppresses weather while the timer runs (WEATHER_HAS_EFFECT, include/battle_util.h:45-46)', () => {
    const state = battle(user('MOVE_CLEAR_SKIES'), foe(), countRng())
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const deps = loopDeps(state, fixedDamage(0))
    expect(weatherHasEffect(state, deps.grounding)).toBe(true)
    expect(isBattlerWeatherAffected(state, 0, WEATHER_RAIN_ANY, deps)).toBe(true)
    state.field.timers.clearSkiesTimer = 3
    expect(weatherHasEffect(state, deps.grounding)).toBe(false)
    expect(isBattlerWeatherAffected(state, 0, WEATHER_RAIN_ANY, deps)).toBe(false)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_STICKY_WEB',
  'EFFECT_MAGNETIC_FLUX',
  'EFFECT_AROMATIC_MIST',
  'EFFECT_REFLECT_TYPE',
  'EFFECT_DRAIN_BRAIN',
  'EFFECT_MORNING_SUN',
  'EFFECT_INVERSE_ROOM',
  'EFFECT_TOXIC_TERRAIN',
  'EFFECT_CLEAR_SKIES',
]

describe('cycle 117 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})
