/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 132: twelve uncategorised move effects: Sweet Kiss, Coaching, Barrier, Mud Sport,
// Karma, Water Sport, Gyro Ball, Electro Ball, Meditate, Caltrops, Howl, and Teeter Dance.
// Every expected number is hand-derived from the pinned C in data/battle_scripts_1.s,
// src/battle_script_commands.c, src/battle_util.c, or src/script_conditions.cc.
//
// Stat stages run 0..12 with neutral 6 (DEFAULT_STAT_STAGE), so "-1" is stage 5 and "+1" stage 7.
// Damage shortcut used throughout: at level 50 with Atk == Def == 100 (or SpAtk == SpDef == 100)
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2` with divisions truncating.
// A critical hit doubles that result. A damage-roll draw of 0 is the 100% entry of the 85..100% array.
//
// Draw order: an accuracy-checked move spends one accuracy draw (a 0-accuracy move still spends it).
// Damaging hits spend one crit draw and one damage-roll draw. Moves without accuracycheck in their
// C scripts spend no accuracy draw.
import { describe, expect, it } from 'vitest'

import type { DamageContext } from '../types'
import { applyMoveBehaviorDamage } from '../basePower'
import type { BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS2_CONFUSION,
  STATUS_FIELD_MUDSPORT,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_WATERSPORT,
  getCounter,
  hasFlag,
  setCounter,
  statusInfatuatedWith,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { findAllowance } from './driver/auditAllowlist'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }
const only = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

/** 200 Speed against the foe's default 100 keeps GetFastestBattler's speed-tie coin flip
 * (turnOrder.ts:583) out of the scripted draw arrays. */
const FAST_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = SIM.speciesById.get(speciesId) as { types: string[] } | undefined
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

/** Every draw is 0 (accuracy always hits, crit, full damage); `calls` counts draws. */
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

/** Draws the scripted values in order (0 once they run out); `calls` counts draws. */
function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      const value = values[idx] ?? 0
      idx++
      return value
    },
  }
  return rng
}

/** The first draw is 99, which misses any accuracy at or below 99; the rest 0. */
function missRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => (rng.calls++ === 0 ? 99 : 0),
  }
  return rng
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
  })
}

function viewOf(moveId: string): TurnOrderMoveView {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  return {
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
}

function useMove(target: number, moveId: string): ChosenAction {
  const view = viewOf(moveId)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }),
})

/** The real bridge resolver, needed wherever a number depends on the damage formula. */
function bridgeDamage(state: BattleState, random: RandomSource): DamageResolver {
  const bridge: BridgeDeps = {
    grounding: groundingFor(SIM, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  }
  const deps: BridgeDamageResolverDeps = {
    ...bridge,
    moveData: SIM.moveData,
    typeChart: SIM.typeChart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    random,
  }
  return createBridgeDamageResolver(deps)
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
  }
}

const THIS_FILE = 'web/src/engine/sim/cycle132UncategorisedEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const ppOf = (state: BattleState, battlerId = 0, slot = 0) => state.battlers[battlerId]!.mon.pp[slot]
const stageOf = (state: BattleState, battlerId: number, stat: number) => state.battlers[battlerId]!.mon.statStages[stat] ?? DEFAULT_STAT_STAGE

/** The user (battler 0, Mudkip, faster than default foe) knows only `moveId`; `pp` is its PP. */
const user = (moveId: string, pp: number, overrides: Partial<SimBattleMon> = {}) =>
  monFor('SPECIES_MUDKIP', {
    rawStats: { ...FAST_STATS },
    moves: [moveId, null, null, null],
    pp: [pp, 0, 0, 0],
    ...overrides,
  })
const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

/** One turn: the user (battler 0) uses `moveId` on battler 1, the foe does nothing. */
function runVs(state: BattleState, moveId: string): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedDamage(0)))
}

/** The same, but with the real damage engine. */
function runVsReal(state: BattleState, moveId: string): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, bridgeDamage(state, state.rng)))
}

/** Puts the user's accuracy at its floor, so a 100%-accuracy move becomes 33%. */
function atAccuracyFloor(state: BattleState): BattleState {
  state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE
  return state
}

// ---------------------------------------------------------------------------
// 1. EFFECT_SWEET_KISS. BattleScript_EffectSweetKiss (battle_scripts_1.s:4202-4217).
// requirecandoeffect BS_TARGET, MOVE_EFFECT_CONFUSION, BattleScript_Return, BattleScript_EffectAttract (:4203)
// accuracycheck BattleScript_ButItFailed, ACC_CURR_MOVE (:4204)
// ppreduce (:4207)
// setmoveeffect MOVE_EFFECT_CONFUSION; seteffectprimary (:4210-4211)
// setmoveeffect MOVE_EFFECT_ATTRACT; seteffectprimary (:4212-4213)
// ---------------------------------------------------------------------------
describe('cycle 132 - Sweet Kiss (EFFECT_SWEET_KISS)', () => {
  it('confuses and infatuates the target, deducting PP (4202-4217)', () => {
    // Sweet Kiss accuracy 75 (moves.json). Draw 0 = accuracy hit (< 75).
    // Draw 1 = confusion duration: (1 % 2) + 3 = 4 turns (battle_script_commands.c:2660).
    const rng = scriptedRng([0, 1])
    const state = battle(user('MOVE_SWEET_KISS', 10, { gender: 'MALE' }), foe({ gender: 'FEMALE' }), rng)
    const out = runVs(state, 'MOVE_SWEET_KISS')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :4207 decrements 10 -> 9
    expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(4) // :2660
    expect(hasFlag(state.battlers[1]!.mon.status2, statusInfatuatedWith(0))).toBe(true) // :2729
    expect(rng.calls).toBe(2) // 1 accuracy, 1 confusion duration
  })

  it('negative case 1: accuracy miss jumps to BattleScript_ButItFailed before ppreduce (:4204 vs :4207)', () => {
    const rng = missRng() // draw 0 is 99 >= 75 accuracy -> miss
    const state = battle(user('MOVE_SWEET_KISS', 10), foe({ gender: 'FEMALE' }), rng)
    const out = runVs(state, 'MOVE_SWEET_KISS')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(10) // PP NOT deducted (:4204 jumps before ppreduce at :4207)
    expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(0)
    expect(hasFlag(state.battlers[1]!.mon.status2, statusInfatuatedWith(0))).toBe(false)
  })

  it('negative case 2: confusion blocked by Own Tempo routes to BattleScript_EffectAttract (:4203 -> :5224)', () => {
    // When target has Own Tempo, requirecandoeffect (:4203) jumps to BattleScript_EffectAttract (:5224-5236).
    // Attract deducts PP (:5227), checks accuracy (:5228), and infatuates (:5230).
    const rng = countRng()
    const state = battle(user('MOVE_SWEET_KISS', 10, { gender: 'MALE' }), foe({ gender: 'FEMALE', abilities: only('ABILITY_OWN_TEMPO') }), rng)
    const out = runVs(state, 'MOVE_SWEET_KISS')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // PP deducted by BattleScript_EffectAttract :5227
    expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(0) // confusion blocked by Own Tempo
    expect(hasFlag(state.battlers[1]!.mon.status2, statusInfatuatedWith(0))).toBe(true) // infatuated via Attract
  })
})

// ---------------------------------------------------------------------------
// 2. EFFECT_COACHING. BattleScript_EffectCoaching (battle_scripts_1.s:746-771).
// ppreduce (:749)
// jumpifnoally BS_ATTACKER, BattleScript_ButItFailed (:750)
// In singles, there is no partner, so the move fails after deducting PP.
// ---------------------------------------------------------------------------
describe('cycle 132 - Coaching (EFFECT_COACHING)', () => {
  it('fails in singles after deducting PP, causing no stat change (:749-750)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COACHING', 10), foe(), rng)
    const out = runVs(state, 'MOVE_COACHING')

    expect(actionOf(out, 0)?.missed).toBe(true) // jumpifnoally -> BattleScript_ButItFailed (:750)
    expect(ppOf(state, 0)).toBe(9) // ppreduce (:749) decrements 10 -> 9 before the fail gate
    expect(stageOf(state, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE) // 6, unchanged
    expect(stageOf(state, 0, STAT_DEF)).toBe(DEFAULT_STAT_STAGE) // 6, unchanged
    expect(rng.calls).toBe(0) // target ALLY, no accuracycheck in script
  })

  it('negative case: user with 0 PP cannot execute Coaching', () => {
    const rng = countRng()
    const state = battle(user('MOVE_COACHING', 0), foe(), rng)
    runVs(state, 'MOVE_COACHING')

    expect(ppOf(state, 0)).toBe(0)
    expect(stageOf(state, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE)
    expect(stageOf(state, 0, STAT_DEF)).toBe(DEFAULT_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 3. EFFECT_BARRIER. BattleScript_EffectBarrier (battle_scripts_1.s:3992-4015).
// jumpifword CMP_NO_COMMON_BITS, gFieldStatuses, STATUS_FIELD_PSYCHIC_TERRAIN, BattleScript_ButItFailed (:3995)
// setlightscreen (:3996); setreflect (:4002, :4009)
// SCREEN_DURATION = 5 (Cmd_setlightscreen:10263, Cmd_setreflect:9330), 8 with Light Clay (:10261, :9328).
// Script has NO ppreduce, so PP does not decrease.
// ---------------------------------------------------------------------------
describe('cycle 132 - Barrier (EFFECT_BARRIER)', () => {
  it('sets both Light Screen and Reflect for 5 turns under Psychic Terrain (:3995, :10263, :9330)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BARRIER', 20), foe(), rng)
    state.field.statuses |= STATUS_FIELD_PSYCHIC_TERRAIN // gate :3995 requires Psychic Terrain
    const out = runVs(state, 'MOVE_BARRIER')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(true) // :10259
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_REFLECT)).toBe(true) // :9325
    expect(state.sides[0].timers.lightscreenTimer).toBe(5) // SCREEN_DURATION :10263
    expect(state.sides[0].timers.reflectTimer).toBe(5) // SCREEN_DURATION :9330
    expect(ppOf(state, 0)).toBe(20) // no ppreduce in BattleScript_EffectBarrier (:3992-4015)
  })

  it('Light Clay extends both screen timers to 8 turns (:10260-10261, :9327-9328)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BARRIER', 20, { itemId: 'ITEM_LIGHT_CLAY' }), foe(), rng)
    state.field.statuses |= STATUS_FIELD_PSYCHIC_TERRAIN
    runVs(state, 'MOVE_BARRIER')

    expect(state.sides[0].timers.lightscreenTimer).toBe(8) // SCREEN_DURATION_EXTENDED :10261
    expect(state.sides[0].timers.reflectTimer).toBe(8) // SCREEN_DURATION_EXTENDED :9328
  })

  it('negative case 1: fails when Psychic Terrain is not active (:3995)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BARRIER', 20), foe(), rng)
    // No STATUS_FIELD_PSYCHIC_TERRAIN on field
    const out = runVs(state, 'MOVE_BARRIER')

    expect(actionOf(out, 0)?.missed).toBe(true) // :3995 jumps to BattleScript_ButItFailed
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(false)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(ppOf(state, 0)).toBe(20)
  })

  it('negative case 2: fails if both screens are already up (:4002 -> :9321 MOVE_RESULT_MISSED)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BARRIER', 20), foe(), rng)
    state.field.statuses |= STATUS_FIELD_PSYCHIC_TERRAIN
    state.sides[0].statuses |= SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_REFLECT
    const out = runVs(state, 'MOVE_BARRIER')

    expect(actionOf(out, 0)?.missed).toBe(true) // :3997 jumps to NoLightScreen, :4009 sets missed :9321
  })
})

// ---------------------------------------------------------------------------
// 4. EFFECT_MUD_SPORT. BattleScript_EffectMudSport (battle_scripts_1.s:6598-6608),
// Cmd_settypebasedhalvers (src/battle_script_commands.c:12221-12228),
// ENDTURN_MUD_SPORT (src/battle_util.c:2155-2160, fieldEndTurn.ts:720-724).
// Duration = 5 (SPORT_DURATION, battle_util.h:69).
// In ER, the damage path has NO Mud Sport halver in battle_util.c:7050-7093.
// ---------------------------------------------------------------------------
describe('cycle 132 - Mud Sport (EFFECT_MUD_SPORT)', () => {
  it('sets STATUS_FIELD_MUDSPORT and timer to 5, deducting PP (:6602, :12223-12225)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MUD_SPORT', 15), foe(), rng)
    const out = runVs(state, 'MOVE_MUD_SPORT')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(14) // ppreduce :6602 decrements 15 -> 14
    expect(hasFlag(state.field.statuses, STATUS_FIELD_MUDSPORT)).toBe(true) // :12223
    expect(state.field.timers.mudSportTimer).toBe(5) // SPORT_DURATION :12225
  })

  it('negative case: fails when Mud Sport is already active on the field (:12222 -> :6603)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MUD_SPORT', 15), foe(), rng)
    state.field.statuses |= STATUS_FIELD_MUDSPORT
    const out = runVs(state, 'MOVE_MUD_SPORT')

    expect(actionOf(out, 0)?.missed).toBe(true) // branches to BattleScript_ButItFailed (:6603)
    expect(ppOf(state, 0)).toBe(14) // ppreduce (:6602) ran before settypebasedhalvers
  })

  it('Electric damage is NOT halved in ER because battle_util.c:7050-7093 has no Mud Sport check', () => {
    // Thunder Shock: power 80 in ER (moves.json), special Electric. Neutral vs Normal defender.
    // Damage = 22 * 80 / 50 + 2 = 35 + 2 = 37.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      user('MOVE_THUNDER_SHOCK', 30),
      foe({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }),
      rng,
    )
    state.field.statuses |= STATUS_FIELD_MUDSPORT
    const out = runVsReal(state, 'MOVE_THUNDER_SHOCK')

    expect(actionOf(out, 0)?.targetDamage).toBe(37) // unhalved: 22*80/50 + 2 = 37
  })

  it('expiry: timer decrements after turn of use and clears after 5 end-turns (:2156-2157)', () => {
    const state = battle(user('MOVE_MUD_SPORT', 15), foe(), countRng())
    runVs(state, 'MOVE_MUD_SPORT')
    // Turn 1 of use: started.mudSport gate in fieldEndTurn.ts:721 prevents decrement on turn 1
    expect(state.field.timers.mudSportTimer).toBe(5)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_MUDSPORT)).toBe(true)

    // Next 4 turns decrement: 5 -> 4 -> 3 -> 2 -> 1
    for (let t = 4; t >= 1; t--) {
      runVs(state, 'MOVE_TACKLE')
      expect(state.field.timers.mudSportTimer).toBe(t)
    }
    // Final 5th end-turn decrements 1 -> 0 and clears status (:2157)
    runVs(state, 'MOVE_TACKLE')
    expect(hasFlag(state.field.statuses, STATUS_FIELD_MUDSPORT)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. EFFECT_KARMA. BattleScript_EffectKarma (battle_scripts_1.s:4989-5020).
// ppreduce (:4992)
// jumpifstat BS_ATTACKER, CMP_GREATER_THAN, STAT_SPEED, MIN_STAT_STAGE, BattleScript_KarmaTrySpeed (:4993)
// jumpifstat BS_ATTACKER, CMP_NOT_EQUAL, STAT_SPATK, MAX_STAT_STAGE, BattleScript_KarmaTrySpeed (:4994)
// jumpifstat BS_ATTACKER, CMP_EQUAL, STAT_SPDEF, MAX_STAT_STAGE, BattleScript_ButItFailed (:4995)
// Speed -1 (:5001), SpAtk +1 (:5008), SpDef +1 (:5015).
// ---------------------------------------------------------------------------
describe('cycle 132 - Karma (EFFECT_KARMA)', () => {
  it('lowers user Speed by 1 and raises SpAtk and SpDef by 1 each (:4992-5019)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_KARMA', 10), foe(), rng)
    const out = runVs(state, 'MOVE_KARMA')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :4992 decrements 10 -> 9
    expect(stageOf(state, 0, STAT_SPEED)).toBe(5) // Speed -1 (6 -> 5, :5001)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7) // SpAtk +1 (6 -> 7, :5008)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(7) // SpDef +1 (6 -> 7, :5015)
  })

  it('succeeds even if Speed is already at minimum (0), boosting SpAtk and SpDef (:4994)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_KARMA', 10), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE // stage 0
    const out = runVs(state, 'MOVE_KARMA')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(MIN_STAT_STAGE) // clamped at 0
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7) // boosted 6 -> 7
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(7) // boosted 6 -> 7
  })

  it('negative case: fails when Speed is at min (0) AND both SpAtk and SpDef are at max (12) (:4993-4995)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_KARMA', 10), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE // 0
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE // 12
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE // 12
    const out = runVs(state, 'MOVE_KARMA')

    expect(actionOf(out, 0)?.missed).toBe(true) // jumps to BattleScript_ButItFailed (:4995)
    expect(ppOf(state, 0)).toBe(9) // ppreduce (:4992) ran before failure gate
    expect(stageOf(state, 0, STAT_SPEED)).toBe(MIN_STAT_STAGE)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(MAX_STAT_STAGE)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(MAX_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 6. EFFECT_WATER_SPORT. BattleScript_EffectWaterSport (battle_scripts_1.s:6598-6608),
// Cmd_settypebasedhalvers (src/battle_script_commands.c:12229-12238),
// ENDTURN_WATER_SPORT (src/battle_util.c:2147-2152, fieldEndTurn.ts:715-718).
// Duration = 5 (SPORT_DURATION, battle_util.h:69).
// In ER, the damage path has NO Water Sport halver in battle_util.c:7050-7093.
// ---------------------------------------------------------------------------
describe('cycle 132 - Water Sport (EFFECT_WATER_SPORT)', () => {
  it('sets STATUS_FIELD_WATERSPORT and timer to 5, deducting PP (:6602, :12232-12234)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WATER_SPORT', 15), foe(), rng)
    const out = runVs(state, 'MOVE_WATER_SPORT')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(14) // ppreduce :6602 decrements 15 -> 14
    expect(hasFlag(state.field.statuses, STATUS_FIELD_WATERSPORT)).toBe(true) // :12232
    // C bug in battle_util.c:2148 lacks !started.waterSport, so endTurn on turn 1 immediately decrements 5 -> 4
    expect(state.field.timers.waterSportTimer).toBe(4) // :2148
  })

  it('negative case: fails when Water Sport is already active on the field (:12231 -> :6603)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WATER_SPORT', 15), foe(), rng)
    state.field.statuses |= STATUS_FIELD_WATERSPORT
    const out = runVs(state, 'MOVE_WATER_SPORT')

    expect(actionOf(out, 0)?.missed).toBe(true) // branches to BattleScript_ButItFailed (:6603)
    expect(ppOf(state, 0)).toBe(14) // ppreduce (:6602) ran before settypebasedhalvers
  })

  it('Fire damage is NOT halved in ER because battle_util.c:7050-7093 has no Water Sport check', () => {
    // Ember: power 20 in ER (moves.json), special Fire. Neutral vs Normal defender.
    // Damage = 22 * 20 / 50 + 2 = 8 + 2 = 10.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      user('MOVE_EMBER', 25),
      foe({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }),
      rng,
    )
    state.field.statuses |= STATUS_FIELD_WATERSPORT
    const out = runVsReal(state, 'MOVE_EMBER')

    expect(actionOf(out, 0)?.targetDamage).toBe(10) // unhalved: 22*20/50 + 2 = 10
  })

  it('expiry: C bug in battle_util.c:2148 has no started gate, decrementing immediately on turn 1 (:2148)', () => {
    const state = battle(user('MOVE_WATER_SPORT', 15), foe(), countRng())
    runVs(state, 'MOVE_WATER_SPORT')
    // Turn 1 of use: C line 2148 lacks !started.waterSport, so waterSportTimer immediately decrements 5 -> 4
    expect(state.field.timers.waterSportTimer).toBe(4) // :2148
    expect(hasFlag(state.field.statuses, STATUS_FIELD_WATERSPORT)).toBe(true)

    // Next 3 turns decrement: 4 -> 3 -> 2 -> 1
    for (let t = 3; t >= 1; t--) {
      runVs(state, 'MOVE_TACKLE')
      expect(state.field.timers.waterSportTimer).toBe(t)
    }
    // Final end-turn decrements 1 -> 0 and clears status (:2149)
    runVs(state, 'MOVE_TACKLE')
    expect(hasFlag(state.field.statuses, STATUS_FIELD_WATERSPORT)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. EFFECT_GYRO_BALL. CustomMoveDamage<EFFECT_GYRO_BALL> (src/script_conditions.cc:208-212).
// int basePower = ((25 * targetSpeed) / userSpeed) + 1;
// if (basePower > 150) basePower = 150;
// ---------------------------------------------------------------------------
describe('cycle 132 - Gyro Ball (EFFECT_GYRO_BALL)', () => {
  const ctxWithSpeeds = (userSpeed: number, targetSpeed: number) =>
    ({ attacker: { speed: userSpeed }, defender: { speed: targetSpeed } } as unknown as DamageContext)

  it.each([
    [100, 100, 26], // 25 * 100 / 100 + 1 = 26
    [200, 100, 13], // 25 * 100 / 200 + 1 = 12 + 1 = 13
    [20, 100, 126], // 25 * 100 / 20 + 1 = 125 + 1 = 126
    [10, 100, 150], // 25 * 100 / 10 + 1 = 251 -> capped at 150 (:210)
    [100, 0, 1], // 25 * 0 / 100 + 1 = 1 (floor power)
  ])('speeds: user %i, target %i -> power %i (:208-212)', (userSpe, targetSpe, power) => {
    expect(applyMoveBehaviorDamage(0, 'EFFECT_GYRO_BALL', SIM.moveBehaviors, ctxWithSpeeds(userSpe, targetSpe)).power).toBe(power)
  })

  it('live damage path calculates power 13 for user Spe 200 vs foe Spe 100, dealing 7 damage (:208-212)', () => {
    // Gyro Ball: Steel physical, base power computed dynamically.
    // User Mudkip (Water/Ground, Atk 100, Spe 200). Foe Normal-type (Def 100, Spe 100).
    // Steel vs Normal is 1x neutral. No STAB.
    // Power = 25 * 100 / 200 + 1 = 13.
    // Damage = 22 * 13 / 50 + 2 = 286 / 50 + 2 = 5 + 2 = 7.
    // Scripted RNG: [0, 1, 0] (acc 0 hit, crit 1 no crit, roll 0 max 100%).
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      user('MOVE_GYRO_BALL', 5, { rawStats: { ...FAST_STATS, spe: 200 } }),
      foe({ rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 }, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }),
      rng,
    )
    const out = runVsReal(state, 'MOVE_GYRO_BALL')

    expect(actionOf(out, 0)?.targetDamage).toBe(7) // 22 * 13 / 50 + 2 = 7
    expect(ppOf(state, 0)).toBe(4) // 5 -> 4
  })

  it('negative case: extremely slow target (Spe 10) gives minimum power 2, dealing 2 damage', () => {
    // Target Spe 10, User Spe 200 -> Power = 25 * 10 / 200 + 1 = 1 + 1 = 2.
    // Damage = 22 * 2 / 50 + 2 = 44 / 50 + 2 = 0 + 2 = 2.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      user('MOVE_GYRO_BALL', 5, { rawStats: { ...FAST_STATS, spe: 200 } }),
      foe({ rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 10 }, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }),
      rng,
    )
    const out = runVsReal(state, 'MOVE_GYRO_BALL')

    expect(actionOf(out, 0)?.targetDamage).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 8. EFFECT_ELECTRO_BALL. CustomMoveDamage<EFFECT_ELECTRO_BALL> (src/script_conditions.cc:198-205).
// static const u8 sSpeedDiffPowerTable[] = {40, 60, 80, 120, 150};
// int speed = userSpeed / targetSpeed;
// if (speed >= ARRAY_COUNT) return ARRAY_COUNT - 1; // bug: returns 4 instead of 150
// return sSpeedDiffPowerTable[speed];
// ---------------------------------------------------------------------------
describe('cycle 132 - Electro Ball (EFFECT_ELECTRO_BALL)', () => {
  const ctxWithSpeeds = (userSpeed: number, targetSpeed: number) =>
    ({ attacker: { speed: userSpeed }, defender: { speed: targetSpeed } } as unknown as DamageContext)

  it.each([
    [99, 100, 40], // ratio 0 -> table[0] = 40 (:198, :204)
    [100, 100, 60], // ratio 1 -> table[1] = 60
    [200, 100, 80], // ratio 2 -> table[2] = 80
    [300, 100, 120], // ratio 3 -> table[3] = 120
    [400, 100, 150], // ratio 4 -> table[4] = 150
    [500, 100, 4], // ratio 5 -> upstream bug returns table.length - 1 = 4 (:203)
  ])('speeds: user %i, target %i -> power %i (:198-205)', (userSpe, targetSpe, power) => {
    expect(applyMoveBehaviorDamage(0, 'EFFECT_ELECTRO_BALL', SIM.moveBehaviors, ctxWithSpeeds(userSpe, targetSpe)).power).toBe(power)
  })

  it('live damage path calculates power 80 for ratio 2 (200/100), dealing 37 damage (:198-205)', () => {
    // Electro Ball: Electric special. User Mudkip (SpAtk 100, Spe 200). Foe Normal (SpDef 100, Spe 100).
    // Electric vs Normal is neutral 1x. No STAB.
    // Ratio 200/100 = 2 -> power 80.
    // Damage = 22 * 80 / 50 + 2 = 1760 / 50 + 2 = 35 + 2 = 37.
    // Scripted RNG: [0, 1, 0] (acc 0 hit, crit 1 no crit, roll 0 max 100%).
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      user('MOVE_ELECTRO_BALL', 10, { rawStats: { ...FAST_STATS, spe: 200 } }),
      foe({ rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 }, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }),
      rng,
    )
    const out = runVsReal(state, 'MOVE_ELECTRO_BALL')

    expect(actionOf(out, 0)?.targetDamage).toBe(37) // 22 * 80 / 50 + 2 = 37
    expect(ppOf(state, 0)).toBe(9) // 10 -> 9
  })

  it('negative case (upstream bug): ratio >= 5 deals only 3 damage due to base power 4 (:203)', () => {
    // User Spe 500, Foe Spe 100 -> Ratio 5 >= 5 -> power 4.
    // Damage = 22 * 4 / 50 + 2 = 88 / 50 + 2 = 1 + 2 = 3.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      user('MOVE_ELECTRO_BALL', 10, { rawStats: { ...FAST_STATS, spe: 500 } }),
      foe({ rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 }, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }),
      rng,
    )
    const out = runVsReal(state, 'MOVE_ELECTRO_BALL')

    expect(actionOf(out, 0)?.targetDamage).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 9. EFFECT_MEDITATE. BattleScript_EffectMeditate (battle_scripts_1.s:6714-6737).
// ppreduce (:6717)
// jumpifstat BS_ATTACKER, CMP_LESS_THAN, STAT_SPATK, MAX_STAT_STAGE, BattleScript_EffectMeditateDoMoveAnim (:6718)
// jumpifstat BS_ATTACKER, CMP_EQUAL, STAT_SPDEF, MAX_STAT_STAGE, BattleScript_CantRaiseMultipleStats (:6719)
// Atk +1 (:6726), SpDef +1 (:6732).
// Note upstream script bug preserved: line 6718 checks STAT_SPATK instead of STAT_ATK!
// ---------------------------------------------------------------------------
describe('cycle 132 - Meditate (EFFECT_MEDITATE)', () => {
  it('raises user Attack and SpDef by 1 stage each, deducting PP (:6717-6736)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MEDITATE', 40), foe(), rng)
    const out = runVs(state, 'MOVE_MEDITATE')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(39) // ppreduce :6717 decrements 40 -> 39
    expect(stageOf(state, 0, STAT_ATK)).toBe(7) // Atk +1 (6 -> 7, :6726)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(7) // SpDef +1 (6 -> 7, :6732)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(DEFAULT_STAT_STAGE) // 6, unchanged
  })

  it('asymmetry: when Atk is maxed (12) but SpAtk < 12, the move still boosts SpDef (:6718)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MEDITATE', 40), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE // 12
    const out = runVs(state, 'MOVE_MEDITATE')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(stageOf(state, 0, STAT_ATK)).toBe(MAX_STAT_STAGE) // clamped at 12
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(7) // boosted 6 -> 7 (:6732)
  })

  it('negative case: fails when SpAtk is maxed (12) AND SpDef is maxed (12), even if Atk < 12 (:6718-6719)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MEDITATE', 40), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE // 12
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE // 12
    const out = runVs(state, 'MOVE_MEDITATE')

    expect(actionOf(out, 0)?.missed).toBe(true) // jumps to BattleScript_CantRaiseMultipleStats (:6719)
    expect(ppOf(state, 0)).toBe(39) // ppreduce :6717 ran before failure gate
    expect(stageOf(state, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE) // 6, not boosted
  })
})

// ---------------------------------------------------------------------------
// 10. EFFECT_CALTROPS. BattleScript_EffectCaltrops (battle_scripts_1.s:5047-5056),
// trysetcaltrops BS_TARGET, BattleScript_ButItFailedAtkStringPpReduce (:5049),
// VARIOUS_SET_CALTROPS (src/battle_script_commands.c:8848-8854).
// Sets gSideTimers[side].caltrops = TRUE; does NOT set any gSideStatuses bit.
// ---------------------------------------------------------------------------
describe('cycle 132 - Caltrops (EFFECT_CALTROPS)', () => {
  it('sets caltrops on foe side timer without setting any side status bit (:5051, :8853)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CALTROPS', 20), foe(), rng)
    const out = runVs(state, 'MOVE_CALTROPS')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(19) // ppreduce :5051 decrements 20 -> 19
    expect(state.sides[1].timers.caltrops).toBe(true) // VARIOUS_SET_CALTROPS :8853
    expect(state.sides[1].statuses).toBe(0) // no bit set in gSideStatuses
  })

  it('negative case: fails when caltrops is already set on foe side, still deducting PP (:5049, :5938-5939)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CALTROPS', 20), foe(), rng)
    state.sides[1].timers.caltrops = true
    const out = runVs(state, 'MOVE_CALTROPS')

    expect(actionOf(out, 0)?.missed).toBe(true) // BattleScript_ButItFailedAtkStringPpReduce
    expect(ppOf(state, 0)).toBe(19) // ppreduce :5939 still runs
    expect(state.sides[1].timers.caltrops).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 11. EFFECT_HOWL. BattleScript_EffectAttackUpUserAlly (battle_scripts_1.s:34-70).
// In singles: jumpifnoally BS_ATTACKER, BattleScript_EffectAttackUp (:35)
// -> BattleScript_EffectStatUp (:3612-3622): ppreduce (:3616), Atk +1 (:3587).
// ---------------------------------------------------------------------------
describe('cycle 132 - Howl (EFFECT_HOWL)', () => {
  it('raises user Attack by 1 stage in singles, deducting PP (:35, :3587, :3616)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HOWL', 40), foe(), rng)
    const out = runVs(state, 'MOVE_HOWL')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(39) // ppreduce :3616 decrements 40 -> 39
    expect(stageOf(state, 0, STAT_ATK)).toBe(7) // Atk +1 (6 -> 7, :3587)
    expect(rng.calls).toBe(0) // target USER, no accuracycheck in script
  })

  it('negative case: user Attack already at MAX_STAT_STAGE (12) produces no stat change (:3617-3618)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HOWL', 40), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE // 12
    const out = runVs(state, 'MOVE_HOWL')

    expect(ppOf(state, 0)).toBe(39) // ppreduce :3616 still runs
    expect(stageOf(state, 0, STAT_ATK)).toBe(MAX_STAT_STAGE) // remains 12
    expect(actionOf(out, 0)?.statChanges?.length ?? 0).toBe(0) // no stat change applied
  })
})

// ---------------------------------------------------------------------------
// 12. EFFECT_TEETER_DANCE. BattleScript_EffectTeeterDance (battle_scripts_1.s:6544-6566).
// ppreduce (:6547)
// Loops all battlers except attacker (:6552):
// requirecandoeffect BS_TARGET, MOVE_EFFECT_CONFUSION (:6553)
// accuracycheck BattleScript_TeeterDanceMissed, ACC_CURR_MOVE (:6555)
// seteffectprimary MOVE_EFFECT_CONFUSION (:6558)
// ---------------------------------------------------------------------------
describe('cycle 132 - Teeter Dance (EFFECT_TEETER_DANCE)', () => {
  it('confuses the target on hit, deducting PP and drawing accuracy then duration (:6547, :6555, :6558)', () => {
    // Teeter Dance 100 accuracy (moves.json). Draw 0 = accuracy hit.
    // Draw 1 = confusion duration: (1 % 2) + 3 = 4 turns (battle_script_commands.c:2660).
    const rng = scriptedRng([0, 1])
    const state = battle(user('MOVE_TEETER_DANCE', 20), foe(), rng)
    const out = runVs(state, 'MOVE_TEETER_DANCE')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(19) // ppreduce :6547 decrements 20 -> 19
    expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(4) // :2660
    expect(rng.calls).toBe(2) // 1 accuracy, 1 confusion duration
  })

  it('negative case 1: accuracy miss at floor leaves target unconfused (:6555 -> :6593)', () => {
    const rng = missRng() // draw 0 is 99 > 33% accuracy floor
    const state = atAccuracyFloor(battle(user('MOVE_TEETER_DANCE', 20), foe(), rng))
    runVs(state, 'MOVE_TEETER_DANCE')

    expect(ppOf(state, 0)).toBe(19) // ppreduce (:6547) ran before loop
    expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(0) // not confused
  })

  it('negative case 2: target already confused is not re-confused (:6553, :2657)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TEETER_DANCE', 20), foe(), rng)
    // Preset confusion turns to 2 (:138, :177)
    state.battlers[1]!.mon.status2 = setCounter(0, STATUS2_CONFUSION, 2)
    runVs(state, 'MOVE_TEETER_DANCE')

    expect(ppOf(state, 0)).toBe(19) // ppreduce :6547 ran
    // Confusion counter remains 2 (not reset or incremented)
    expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe('cycle 132 registry', () => {
  const SHIPPED_EFFECTS = [
    'EFFECT_SWEET_KISS',
    'EFFECT_COACHING',
    'EFFECT_BARRIER',
    'EFFECT_MUD_SPORT',
    'EFFECT_KARMA',
    'EFFECT_WATER_SPORT',
    'EFFECT_GYRO_BALL',
    'EFFECT_ELECTRO_BALL',
    'EFFECT_MEDITATE',
    'EFFECT_CALTROPS',
    'EFFECT_HOWL',
    'EFFECT_TEETER_DANCE',
  ]

  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('none of these effects is allowlisted: all twelve have singles-observable behaviour', () => {
    for (const effect of SHIPPED_EFFECTS) expect(findAllowance(effect)).toBeUndefined()
  })

  it.each([
    ['MOVE_SWEET_KISS', 'EFFECT_SWEET_KISS'],
    ['MOVE_COACHING', 'EFFECT_COACHING'],
    ['MOVE_BARRIER', 'EFFECT_BARRIER'],
    ['MOVE_MUD_SPORT', 'EFFECT_MUD_SPORT'],
    ['MOVE_KARMA', 'EFFECT_KARMA'],
    ['MOVE_WATER_SPORT', 'EFFECT_WATER_SPORT'],
    ['MOVE_GYRO_BALL', 'EFFECT_GYRO_BALL'],
    ['MOVE_ELECTRO_BALL', 'EFFECT_ELECTRO_BALL'],
    ['MOVE_MEDITATE', 'EFFECT_MEDITATE'],
    ['MOVE_CALTROPS', 'EFFECT_CALTROPS'],
    ['MOVE_HOWL', 'EFFECT_HOWL'],
    ['MOVE_TEETER_DANCE', 'EFFECT_TEETER_DANCE'],
  ])('%s has %s', (moveId, effect) => expect(effectOf(moveId)).toBe(effect))
})
