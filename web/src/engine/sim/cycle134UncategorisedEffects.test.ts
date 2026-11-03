/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 134: seven uncategorised move effects: Spicy Extract, Take Heart, Clangorous Soul,
// Fillet Away, Tar Shot, Doodle, and Spectral Flame.
// Every expected number is hand-derived from the pinned C in data/battle_scripts_1.s,
// src/battle_script_commands.c, src/battle_util.c, or src/abilities.cc.
//
// Stat stages run 0..12 with neutral 6 (DEFAULT_STAT_STAGE), so "-1" is stage 5 and "+1" stage 7.
// Damage shortcut used throughout: at level 50 with Atk == Def == 100
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2` with divisions truncating.
//
// Draw order: an accuracy-checked move spends one accuracy draw (a 0-accuracy move still spends it).
// Moves without accuracycheck in their C scripts spend no accuracy draw.
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_SAFEGUARD,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS2_CONFUSION,
  STATUS2_SUBSTITUTE,
  STATUS3_GASTRO_ACID,
  STATUS3_ON_AIR,
  WEATHER_FOG_TEMPORARY,
  hasFlag,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import { findAllowance } from './driver/auditAllowlist'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ReplacementDeps } from './switchIn'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const freshAbilities = (): SimBattleMon['abilities'] => ({ ability: null, innates: [null, null, null] })

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
    abilities: freshAbilities(),
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function partyMon(speciesId: string, overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId,
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    itemId: null,
    abilities: freshAbilities(),
    rawStats: FAST_STATS,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
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

function battle(
  a: SimBattleMon,
  b: SimBattleMon,
  rng: RandomSource,
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[] } = {},
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
    ...(opts.playerParty ? { playerParty: opts.playerParty } : {}),
    ...(opts.opponentParty ? { opponentParty: opts.opponentParty } : {}),
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

function loopDeps(state: BattleState, damage: DamageResolver, replacement?: ReplacementDeps): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
    ...(replacement ? { replacement } : {}),
  }
}

const THIS_FILE = 'web/src/engine/sim/cycle134UncategorisedEffects.test.ts'
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
function runVs(state: BattleState, moveId: string, replacement?: ReplacementDeps): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedDamage(0), replacement))
}

/** Puts the user's accuracy at its floor, so a 100%-accuracy move becomes 33%. */
function atAccuracyFloor(state: BattleState): BattleState {
  state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE
  return state
}

// ---------------------------------------------------------------------------
// 1. EFFECT_SPICY_EXTRACT. BattleScript_EffectSpicyExtract (data/battle_scripts_1.s:5155-5186).
// jumpifsubstituteblocks BattleScript_MakeMoveMissed (:5157)
// accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:5158)
// attackstring (:5159)
// ppreduce (:5160)
// jumpifstat BS_TARGET, CMP_LESS_THAN, STAT_ATK, MAX_STAT_STAGE, Continue (:5161)
// jumpifstat BS_TARGET, CMP_GREATER_THAN, STAT_DEF, MIN_STAT_STAGE, Continue (:5162)
// requirecandoeffect BS_TARGET, MOVE_EFFECT_CONFUSION (:5163)
// Continue (:5164):
//   setstatchanger STAT_ATK, 2, FALSE; statbuffchange (:5167-5168)
//   setstatchanger STAT_DEF, 2, TRUE; statbuffchange (:5176-5177, prints gStatUpStringIds :5180 -> no Defiant)
//   setmoveeffect MOVE_EFFECT_CONFUSION; seteffectprimary (:5183-5184)
// ---------------------------------------------------------------------------
describe('EFFECT_SPICY_EXTRACT (MOVE_SPICY_EXTRACT)', () => {
  it('raises target Atk by 2, lowers Def by 2, and inflicts confusion (:5167-5184)', () => {
    // 1 accuracy draw (ACC 0 hits) + 1 confusion turn roll ((roll % 2) + 3)
    const rng = scriptedRng([0, 1])
    const state = battle(user('MOVE_SPICY_EXTRACT', 15), foe(), rng)
    const out = runVs(state, 'MOVE_SPICY_EXTRACT')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(14) // ppreduce :5160
    expect(stageOf(state, 1, STAT_ATK)).toBe(8) // 6 + 2 (:5167)
    expect(stageOf(state, 1, STAT_DEF)).toBe(4) // 6 - 2 (:5176)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true) // :5183
    expect(rng.calls).toBe(2)
  })

  it('target Def drops and confusion is applied even if target Atk is already at MAX (:5161, :5169)', () => {
    const rng = scriptedRng([0, 0])
    const state = battle(user('MOVE_SPICY_EXTRACT', 15), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE // 12
    const out = runVs(state, 'MOVE_SPICY_EXTRACT')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(14)
    expect(stageOf(state, 1, STAT_ATK)).toBe(12) // unchanged (:5169)
    expect(stageOf(state, 1, STAT_DEF)).toBe(4) // 6 - 2 (:5176)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('target gets confused even when Atk is at MAX and Def is at MIN if confusable (:5161-5164, :5183)', () => {
    const rng = scriptedRng([0, 0])
    const state = battle(user('MOVE_SPICY_EXTRACT', 15), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE // 12
    state.battlers[1]!.mon.statStages[STAT_DEF] = MIN_STAT_STAGE // 0
    const out = runVs(state, 'MOVE_SPICY_EXTRACT')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(14)
    expect(stageOf(state, 1, STAT_ATK)).toBe(12)
    expect(stageOf(state, 1, STAT_DEF)).toBe(0)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('negative case: fails when Atk is MAX, Def is MIN, and target is blocked by status1 (:5163)', () => {
    const rng = countRng()
    const target = foe({ status1: STATUS1_PARALYSIS, status2: STATUS2_CONFUSION })
    const state = battle(user('MOVE_SPICY_EXTRACT', 15), target, rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[1]!.mon.statStages[STAT_DEF] = MIN_STAT_STAGE
    const out = runVs(state, 'MOVE_SPICY_EXTRACT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(14) // ppreduce ran before requirecandoeffect
    expect(stageOf(state, 1, STAT_ATK)).toBe(12)
    expect(stageOf(state, 1, STAT_DEF)).toBe(0)
    expect(rng.calls).toBe(1) // 1 accuracy draw
  })

  it('negative case: semi-invulnerable target causes accuracy check to miss (:5158, battle_script_commands.c:1270)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SPICY_EXTRACT', 15), foe(), rng)
    state.battlers[1]!.statuses3 = STATUS3_ON_AIR // semi-invulnerable Fly state
    const out = runVs(state, 'MOVE_SPICY_EXTRACT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(14)
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
    expect(stageOf(state, 1, STAT_DEF)).toBe(6)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
    expect(rng.calls).toBe(1) // 1 accuracy draw spent
  })

  it('negative case: target behind Substitute blocks Spicy Extract before accuracy (:5157)', () => {
    const rng = countRng()
    const target = foe({ status2: STATUS2_SUBSTITUTE })
    const state = battle(user('MOVE_SPICY_EXTRACT', 15), target, rng)
    state.battlers[1]!.volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_SPICY_EXTRACT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(14)
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
    expect(stageOf(state, 1, STAT_DEF)).toBe(6)
    expect(rng.calls).toBe(0) // jumpifsubstituteblocks runs before accuracycheck
  })
})

// ---------------------------------------------------------------------------
// 2. EFFECT_TAKE_HEART. BattleScript_EffectTakeHeart (data/battle_scripts_1.s:6695-6712).
// ppreduce (:6698)
// jumpifstatus BS_ATTACKER, STATUS1_ANY, BattleScript_EffectTakeHeart_DoAnim (:6699)
// jumpifstat BS_ATTACKER, CMP_LESS_THAN, STAT_SPATK, MAX_STAT_STAGE, CalmMindDoMoveAnim (:6700)
// jumpifstat BS_ATTACKER, CMP_EQUAL, STAT_SPDEF, MAX_STAT_STAGE, CantRaiseMultipleStats (:6701)
// CalmMindDoBoosts (:6748-6763):
//   SpAtk +1 (:6751), SpDef +1 (:6757)
// DoAnim (:6703-6712):
//   curestatus BS_ATTACKER (:6706)
//   jumpifstat SPATK < MAX -> CalmMindDoBoosts (:6709)
//   jumpifstat SPDEF == MAX -> MoveEnd (:6710)
// ---------------------------------------------------------------------------
describe('EFFECT_TAKE_HEART (MOVE_TAKE_HEART)', () => {
  it('cures burn on user and raises SpAtk and SpDef by 1 each (:6706, :6751, :6757)', () => {
    const rng = countRng()
    const pMon = partyMon('SPECIES_MUDKIP', { status1: STATUS1_BURN })
    const state = battle(user('MOVE_TAKE_HEART', 5, { status1: STATUS1_BURN }), foe(), rng, {
      playerParty: [pMon],
    })
    const out = runVs(state, 'MOVE_TAKE_HEART')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(4) // ppreduce :6698
    expect(state.battlers[0]!.mon.status1).toBe(0) // curestatus :6706
    expect(state.sides[0].party[0]!.status1).toBe(0) // party copy cleared
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7) // 6 + 1 (:6751)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(7) // 6 + 1 (:6757)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('healthy user raises SpAtk and SpDef by 1 with no status change (:6700, :6751, :6757)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAKE_HEART', 5), foe(), rng)
    const out = runVs(state, 'MOVE_TAKE_HEART')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(4)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(7)
    expect(rng.calls).toBe(0)
  })

  it('healthy user with SpAtk at MAX still raises SpDef (:6700-6701, :6757)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAKE_HEART', 5), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE // 12
    const out = runVs(state, 'MOVE_TAKE_HEART')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(4)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(12) // unchanged
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(7) // 6 + 1
    expect(rng.calls).toBe(0)
  })

  it('burned user with both SpAtk and SpDef at MAX cures status without stat change (:6706, :6710)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAKE_HEART', 5, { status1: STATUS1_BURN }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_TAKE_HEART')

    expect(actionOf(out, 0)?.missed).toBe(false) // succeeds (:6710 jumps to MoveEnd)
    expect(ppOf(state, 0)).toBe(4)
    expect(state.battlers[0]!.mon.status1).toBe(0) // cured :6706
    expect(stageOf(state, 0, STAT_SPATK)).toBe(12)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(12)
    expect(rng.calls).toBe(0)
  })

  it('negative case: healthy user with both SpAtk and SpDef at MAX fails (:6701 -> CantRaiseMultipleStats)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAKE_HEART', 5), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_TAKE_HEART')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(4)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(12)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(12)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. EFFECT_CLANGOROUS_SOUL. BattleScript_EffectClangorousSoul (data/battle_scripts_1.s:245-257).
// ppreduce (:248)
// cutonethirdhpraisestats BattleScript_ButItFailed (:249)
// VARIOUS_CUT_1_3_HP_RAISE_STATS (src/battle_script_commands.c:8089-8106):
//   hpFraction = max(1, maxHP / 3);
//   requires atLeastOneStatBoosted (stats 1..5 < MAX) AND hp > hpFraction;
//   gBattleMoveDamage = hpFraction;
// BattleScript_AllStatsUp (:7891-7925):
//   Atk, Def, Speed, SpAtk, SpDef +1 each (:7899, :7905, :7911, :7917, :7923)
// ---------------------------------------------------------------------------
describe('EFFECT_CLANGOROUS_SOUL (MOVE_CLANGOROUS_SOUL)', () => {
  it('maxHP 90 hp 90 loses 30 HP and raises all five stats by 1 stage (:8092, :7899-7923)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CLANGOROUS_SOUL', 5, { hp: 90, maxHp: 90 }), foe(), rng)
    const out = runVs(state, 'MOVE_CLANGOROUS_SOUL')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(4) // ppreduce :248
    // hpFraction = 90 / 3 = 30; hp 90 - 30 = 60 (:8092, :8102)
    expect(state.battlers[0]!.mon.hp).toBe(60)
    expect(stageOf(state, 0, STAT_ATK)).toBe(7)
    expect(stageOf(state, 0, STAT_DEF)).toBe(7)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(7)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(7)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('maxHP 100 truncates hpFraction to 33 and applies 33 recoil (:8092)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CLANGOROUS_SOUL', 5, { hp: 100, maxHp: 100 }), foe(), rng)
    const out = runVs(state, 'MOVE_CLANGOROUS_SOUL')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(4)
    // hpFraction = trunc(100 / 3) = 33; hp 100 - 33 = 67
    expect(state.battlers[0]!.mon.hp).toBe(67)
    expect(stageOf(state, 0, STAT_ATK)).toBe(7)
    expect(rng.calls).toBe(0)
  })

  it('hp 34 of 100 satisfies hp > hpFraction (34 > 33) and leaves 1 HP (:8101)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CLANGOROUS_SOUL', 5, { hp: 34, maxHp: 100 }), foe(), rng)
    const out = runVs(state, 'MOVE_CLANGOROUS_SOUL')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(4)
    expect(state.battlers[0]!.mon.hp).toBe(1) // 34 - 33 = 1
    expect(stageOf(state, 0, STAT_SPEED)).toBe(7)
    expect(rng.calls).toBe(0)
  })

  it('boosts remaining stats when SpDef is already at MAX (:8098, :7899-7917)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CLANGOROUS_SOUL', 5, { hp: 100, maxHp: 100 }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE // 12
    const out = runVs(state, 'MOVE_CLANGOROUS_SOUL')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(4)
    expect(state.battlers[0]!.mon.hp).toBe(67)
    expect(stageOf(state, 0, STAT_ATK)).toBe(7)
    expect(stageOf(state, 0, STAT_DEF)).toBe(7)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(7)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7)
    expect(stageOf(state, 0, STAT_SPDEF)).toBe(12) // unchanged
    expect(rng.calls).toBe(0)
  })

  it('negative case: hp exactly 33 of 100 fails hp > hpFraction (33 > 33 is false) (:8101)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CLANGOROUS_SOUL', 5, { hp: 33, maxHp: 100 }), foe(), rng)
    const out = runVs(state, 'MOVE_CLANGOROUS_SOUL')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(4)
    expect(state.battlers[0]!.mon.hp).toBe(33) // no recoil
    expect(stageOf(state, 0, STAT_ATK)).toBe(6) // no boosts
    expect(rng.calls).toBe(0)
  })

  it('negative case: fails when all five stats are at MAX stage 12 (:8094-8104)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_CLANGOROUS_SOUL', 5, { hp: 100, maxHp: 100 }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_CLANGOROUS_SOUL')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(4)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. EFFECT_FILLET_AWAY. BattleScript_EffectFilletAway (data/battle_scripts_1.s:5606-5642).
// ppreduce (:5609)
// jumpifstat BS_ATTACKER, CMP_LESS_THAN, STAT_ATK, MAX_STAT_STAGE, TryLoseHp (:5610)
// jumpifstat BS_ATTACKER, CMP_LESS_THAN, STAT_SPATK, MAX_STAT_STAGE, TryLoseHp (:5611)
// jumpifstat BS_ATTACKER, CMP_EQUAL, STAT_SPEED, MAX_STAT_STAGE, CantRaiseMultipleStats (:5612)
// trylosepercenthp BS_ATTACKER, 50, BattleScript_ButItFailed (:5614)
// VARIOUS_TRY_LOSE_PERCENT_HP (src/battle_script_commands.c:8310-8324):
//   hpLost = hp * 50 / 100; if (hp <= 1) fail; if (!hpLost) hpLost = 1;
// Boosts: Atk +2 (:5624), SpAtk +2 (:5631), Speed +2 (:5638)
// ---------------------------------------------------------------------------
describe('EFFECT_FILLET_AWAY (MOVE_FILLET_AWAY)', () => {
  it('maxHP 100 hp 80 loses 40 HP and raises Atk, SpAtk, Speed by 2 stages (:8312, :5624-5638)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FILLET_AWAY', 10, { hp: 80, maxHp: 100 }), foe(), rng)
    const out = runVs(state, 'MOVE_FILLET_AWAY')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :5609
    // hpLost = 80 * 50 / 100 = 40; hp 80 - 40 = 40 (:8312)
    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(stageOf(state, 0, STAT_ATK)).toBe(8) // 6 + 2 (:5624)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(8) // 6 + 2 (:5631)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(8) // 6 + 2 (:5638)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('hp 3 loses 1 HP (!hpLost fallback) and boosts stats (:8319)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FILLET_AWAY', 10, { hp: 3, maxHp: 100 }), foe(), rng)
    const out = runVs(state, 'MOVE_FILLET_AWAY')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    // hpLost = 3 * 50 / 100 = 1; hp 3 - 1 = 2 (:8312, :8319)
    expect(state.battlers[0]!.mon.hp).toBe(2)
    expect(stageOf(state, 0, STAT_ATK)).toBe(8)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(8)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(8)
    expect(rng.calls).toBe(0)
  })

  it('Atk at stage 11 clamps to MAX 12 while other two reach stage 8 (:5624)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FILLET_AWAY', 10, { hp: 100, maxHp: 100 }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = 11
    const out = runVs(state, 'MOVE_FILLET_AWAY')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.hp).toBe(50) // 100 - 50 = 50
    expect(stageOf(state, 0, STAT_ATK)).toBe(12) // clamped to MAX_STAT_STAGE
    expect(stageOf(state, 0, STAT_SPATK)).toBe(8)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(8)
    expect(rng.calls).toBe(0)
  })

  it('negative case: hp exactly 1 fails via hp <= 1 check (:8315)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FILLET_AWAY', 10, { hp: 1, maxHp: 100 }), foe(), rng)
    const out = runVs(state, 'MOVE_FILLET_AWAY')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.hp).toBe(1)
    expect(stageOf(state, 0, STAT_ATK)).toBe(6)
    expect(rng.calls).toBe(0)
  })

  it('negative case: fails when Atk, SpAtk and Speed are all at MAX stage 12 (:5610-5612)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FILLET_AWAY', 10, { hp: 100, maxHp: 100 }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_FILLET_AWAY')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. EFFECT_TAR_SHOT. BattleScript_EffectTarShot (data/battle_scripts_1.s:317-337).
// jumpifsubstituteblocks BattleScript_ButItFailedAtkStringPpReduce (:318)
// accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:319)
// cantarshotwork BS_TARGET, BattleScript_ButItFailedAtkStringPpReduce (:320)
// VARIOUS_CAN_TAR_SHOT_WORK (src/battle_script_commands.c:8141-8146):
//   fails if volatiles.tarShot || !CompareStat(STAT_SPEED, MAX_STAT_STAGE, CMP_LESS_THAN)
// attackstring (:321)
// ppreduce (:322)
// setstatchanger STAT_SPEED, 1, TRUE; statbuffchange (:323-329)
// trytarshot BS_TARGET, BattleScript_MoveEnd (:332, VARIOUS_TRY_TAR_SHOT :8134-8140)
// ---------------------------------------------------------------------------
describe('EFFECT_TAR_SHOT (MOVE_TAR_SHOT)', () => {
  it('lowers target Speed by 1 stage and sets tarShot volatile (:323, :332, :8139)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAR_SHOT', 15), foe(), rng)
    const out = runVs(state, 'MOVE_TAR_SHOT')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(14) // ppreduce :322
    expect(stageOf(state, 1, STAT_SPEED)).toBe(5) // 6 - 1 (:323)
    expect(state.battlers[1]!.volatiles.tarShot).toBe(true) // :332
    expect(rng.calls).toBe(1) // 1 accuracy draw
  })

  it('lowers Speed to MIN stage 0 when target is at stage 1 (:323)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAR_SHOT', 15), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_SPEED] = 1
    const out = runVs(state, 'MOVE_TAR_SHOT')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(14)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(0) // MIN_STAT_STAGE
    expect(state.battlers[1]!.volatiles.tarShot).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('negative case: fails when tarShot is already active on the target (:320, :8144)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAR_SHOT', 15), foe(), rng)
    state.battlers[1]!.volatiles.tarShot = true
    const out = runVs(state, 'MOVE_TAR_SHOT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(14) // ppreduce still runs via ButItFailedAtkStringPpReduce
    expect(stageOf(state, 1, STAT_SPEED)).toBe(6) // Speed does not drop again
    expect(state.battlers[1]!.volatiles.tarShot).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('negative case: fails when target Speed is at MAX stage 12 (C quirk :8144)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TAR_SHOT', 15), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE // 12
    const out = runVs(state, 'MOVE_TAR_SHOT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(14)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(12)
    expect(state.battlers[1]!.volatiles.tarShot).toBe(false)
    expect(rng.calls).toBe(1)
  })

  it('negative case: accuracy miss at floor leaves Speed and tarShot untouched (:319)', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_TAR_SHOT', 15), foe(), rng))
    const out = runVs(state, 'MOVE_TAR_SHOT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(14)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(6)
    expect(state.battlers[1]!.volatiles.tarShot).toBe(false)
    expect(rng.calls).toBe(1)
  })

  it('negative case: target behind Substitute blocks Tar Shot (:318)', () => {
    const rng = countRng()
    const target = foe({ status2: STATUS2_SUBSTITUTE })
    const state = battle(user('MOVE_TAR_SHOT', 15), target, rng)
    state.battlers[1]!.volatiles.substituteHp = 25
    const out = runVs(state, 'MOVE_TAR_SHOT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(14)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(6)
    expect(state.battlers[1]!.volatiles.tarShot).toBe(false)
    expect(rng.calls).toBe(0) // jumpifsubstituteblocks runs before accuracycheck
  })
})

// ---------------------------------------------------------------------------
// 6. EFFECT_DOODLE. BattleScript_EffectDoodle (data/battle_scripts_1.s:2284-2319).
// accuracycheck BattleScript_PrintMoveMissed, ACC_CURR_MOVE (:2286)
// attackstring (:2287)
// ppreduce (:2288)
// trycopyabilitybetween BS_TARGET, BS_ATTACKER, Doodle_NoAttacker (:2290)
// VARIOUS_COPY_ABILITY (src/battle_script_commands.c:7245-7257):
//   IsEntrainmentBannedAbilityAttacker(targetAbility) -> fails (:7249)
//   IsEntrainmentTargetOrSimpleBeamBannedAbility(userAbility) -> fails (:7250)
//   HasAbilityIgnoringSuppression(user, targetAbility) -> fails (:7251)
//   DoesBattlerHaveAbilityShield(receiver) -> fails (:7252)
// switchinabilities BS_ATTACKER (:2296)
// ---------------------------------------------------------------------------
describe('EFFECT_DOODLE (MOVE_DOODLE)', () => {
  it('copies Intimidate and triggers its switch-in attack drop on the foe (:7254, :2296)', () => {
    const rng = countRng()
    const target = foe({ abilities: { ability: 'ABILITY_INTIMIDATE', innates: [null, null, null] } })
    const state = battle(user('MOVE_DOODLE', 10), target, rng)
    const out = runVs(state, 'MOVE_DOODLE')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :2288
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_INTIMIDATE') // copied :7254
    expect(stageOf(state, 1, STAT_ATK)).toBe(5) // Intimidate switch-in drop :2296
    expect(rng.calls).toBe(1) // 1 accuracy draw
  })

  it('copies an ordinary passive ability (Speed Boost) (:7254)', () => {
    const rng = countRng()
    const target = foe({ abilities: { ability: 'ABILITY_SPEED_BOOST', innates: [null, null, null] } })
    const state = battle(user('MOVE_DOODLE', 10), target, rng)
    const out = runVs(state, 'MOVE_DOODLE')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_SPEED_BOOST')
    expect(rng.calls).toBe(1)
  })

  it('target holding Ability Shield does not prevent Doodle: Ability Shield protects receiver (:7252)', () => {
    const rng = countRng()
    const target = foe({
      itemId: 'ITEM_ABILITY_SHIELD',
      abilities: { ability: 'ABILITY_SPEED_BOOST', innates: [null, null, null] },
    })
    const state = battle(user('MOVE_DOODLE', 10), target, rng)
    const out = runVs(state, 'MOVE_DOODLE')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_SPEED_BOOST')
    expect(rng.calls).toBe(1)
  })

  it('negative case: target with Wonder Guard (banned ability) cannot be copied (:7249, battle_util.c:86)', () => {
    const rng = countRng()
    const target = foe({ abilities: { ability: 'ABILITY_WONDER_GUARD', innates: [null, null, null] } })
    const state = battle(user('MOVE_DOODLE', 10), target, rng)
    const out = runVs(state, 'MOVE_DOODLE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.abilities.ability).toBeNull() // uncopied
    expect(rng.calls).toBe(1)
  })

  it('negative case: user with Truant (banned receiver ability) cannot receive ability (:7250, battle_util.c:98)', () => {
    const rng = countRng()
    const attacker = user('MOVE_DOODLE', 10, { abilities: { ability: 'ABILITY_TRUANT', innates: [null, null, null] } })
    const target = foe({ abilities: { ability: 'ABILITY_SPEED_BOOST', innates: [null, null, null] } })
    const state = battle(attacker, target, rng)
    const out = runVs(state, 'MOVE_DOODLE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_TRUANT') // unchanged
    expect(rng.calls).toBe(1)
  })

  it('negative case: user holding Ability Shield blocks ability change (:7252)', () => {
    const rng = countRng()
    const attacker = user('MOVE_DOODLE', 10, { itemId: 'ITEM_ABILITY_SHIELD' })
    const target = foe({ abilities: { ability: 'ABILITY_SPEED_BOOST', innates: [null, null, null] } })
    const state = battle(attacker, target, rng)
    const out = runVs(state, 'MOVE_DOODLE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.abilities.ability).toBeNull() // unchanged
    expect(rng.calls).toBe(1)
  })

  it('negative case: accuracy miss at floor leaves ability unchanged (:2286)', () => {
    const rng = missRng()
    const target = foe({ abilities: { ability: 'ABILITY_SPEED_BOOST', innates: [null, null, null] } })
    const state = atAccuracyFloor(battle(user('MOVE_DOODLE', 10), target, rng))
    const out = runVs(state, 'MOVE_DOODLE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.abilities.ability).toBeNull()
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 7. EFFECT_SPECTRAL_FLAME. BattleScript_EffectSpectralFlame (data/battle_scripts_1.s:2933-2956).
// Outside Fog: goto BattleScript_EffectWillOWisp (:2935).
// In Fog (Continue :2936):
//   accuracycheck (:2938)
//   ppreduce (:2940)
//   jumpifsubstituteblocks BattleScript_ButItFailed (:2941)
//   setgastroacid BattleScript_EffectSpectralFlame_NoSuppress (:2942, Cmd_setgastroacid :11831-11838)
//   setmoveeffect MOVE_EFFECT_BURN; seteffectprimary (:2944-2945)
// NoSuppress (:2949-2955):
//   requirecandoeffect BS_TARGET, MOVE_EFFECT_BURN (:2950)
//   jumpifsafeguard BattleScript_SafeguardProtected (:2951)
//   setmoveeffect MOVE_EFFECT_BURN; seteffectprimary (:2953-2954)
// ---------------------------------------------------------------------------
describe('EFFECT_SPECTRAL_FLAME (MOVE_SPECTRAL_FLAME)', () => {
  it('in Fog, suppresses ability via STATUS3_GASTRO_ACID and inflicts Burn (:2942, :2945)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SPECTRAL_FLAME', 10), foe(), rng)
    state.field.weather = WEATHER_FOG_TEMPORARY
    const out = runVs(state, 'MOVE_SPECTRAL_FLAME')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :2940
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true) // :2942, :11836
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN) // :2945
    expect(rng.calls).toBe(1) // 1 accuracy draw
  })

  it('in Fog, burns target even when target already has STATUS3_GASTRO_ACID (:2949-2954)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SPECTRAL_FLAME', 10), foe(), rng)
    state.battlers[1]!.statuses3 = STATUS3_GASTRO_ACID
    state.field.weather = WEATHER_FOG_TEMPORARY
    const out = runVs(state, 'MOVE_SPECTRAL_FLAME')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN) // :2954
    expect(rng.calls).toBe(1)
  })

  it('in Fog, suppresses ability of Fire-type target but does NOT inflict Burn (:2942, SetMoveEffect :2458)', () => {
    const rng = countRng()
    const target = monFor('SPECIES_TORCHIC', { types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    const state = battle(user('MOVE_SPECTRAL_FLAME', 10), target, rng)
    state.field.weather = WEATHER_FOG_TEMPORARY
    const out = runVs(state, 'MOVE_SPECTRAL_FLAME')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true) // Gastro Acid applied :2942
    expect(state.battlers[1]!.mon.status1).toBe(0) // Fire type cannot be burned :2458
    expect(rng.calls).toBe(1)
  })

  it('outside Fog, burns target via Will-O-Wisp delegation without Gastro Acid (:2935, :6090-6101)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SPECTRAL_FLAME', 10), foe(), rng)
    const out = runVs(state, 'MOVE_SPECTRAL_FLAME')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false) // no Gastro Acid outside fog
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN) // :6101
    expect(rng.calls).toBe(1)
  })

  it('negative case: outside Fog on Fire-type fails cleanly via requirecandoeffect (:6095)', () => {
    const rng = countRng()
    const target = monFor('SPECIES_TORCHIC', { types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    const state = battle(user('MOVE_SPECTRAL_FLAME', 10), target, rng)
    runVs(state, 'MOVE_SPECTRAL_FLAME')

    expect(ppOf(state, 0)).toBe(9)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0) // requirecandoeffect runs before accuracycheck in Will-O-Wisp script :6095-6096
  })

  it('negative case: in Fog, target behind Substitute blocks Spectral Flame (:2941)', () => {
    const rng = countRng()
    const target = foe({ status2: STATUS2_SUBSTITUTE })
    const state = battle(user('MOVE_SPECTRAL_FLAME', 10), target, rng)
    state.battlers[1]!.volatiles.substituteHp = 25
    state.field.weather = WEATHER_FOG_TEMPORARY
    const out = runVs(state, 'MOVE_SPECTRAL_FLAME')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(1) // accuracycheck runs before substitute check in Spectral Flame fog :2938-2941
  })

  it('negative case: in Fog, target with Gastro Acid is protected from burn by Safeguard (:2951)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SPECTRAL_FLAME', 10), foe(), rng)
    state.battlers[1]!.statuses3 = STATUS3_GASTRO_ACID
    state.sides[1].statuses = SIDE_STATUS_SAFEGUARD
    state.field.weather = WEATHER_FOG_TEMPORARY
    const out = runVs(state, 'MOVE_SPECTRAL_FLAME')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[1]!.mon.status1).toBe(0) // Safeguard protected :2951
    expect(rng.calls).toBe(1)
  })

  it('negative case: in Fog, accuracy miss leaves status and statuses3 untouched (:2938)', () => {
    // Spectral Flame accuracy 85: roll 90 >= 85 misses
    const rng = scriptedRng([90])
    const state = battle(user('MOVE_SPECTRAL_FLAME', 10), foe(), rng)
    state.field.weather = WEATHER_FOG_TEMPORARY
    const out = runVs(state, 'MOVE_SPECTRAL_FLAME')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe('cycle 134 registry', () => {
  const SHIPPED_EFFECTS = [
    'EFFECT_SPICY_EXTRACT',
    'EFFECT_TAKE_HEART',
    'EFFECT_CLANGOROUS_SOUL',
    'EFFECT_FILLET_AWAY',
    'EFFECT_TAR_SHOT',
    'EFFECT_DOODLE',
    'EFFECT_SPECTRAL_FLAME',
  ]

  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('none of these effects is allowlisted: all seven have singles-observable behaviour', () => {
    for (const effect of SHIPPED_EFFECTS) expect(findAllowance(effect)).toBeUndefined()
  })

  it.each([
    ['MOVE_SPICY_EXTRACT', 'EFFECT_SPICY_EXTRACT'],
    ['MOVE_TAKE_HEART', 'EFFECT_TAKE_HEART'],
    ['MOVE_CLANGOROUS_SOUL', 'EFFECT_CLANGOROUS_SOUL'],
    ['MOVE_FILLET_AWAY', 'EFFECT_FILLET_AWAY'],
    ['MOVE_TAR_SHOT', 'EFFECT_TAR_SHOT'],
    ['MOVE_DOODLE', 'EFFECT_DOODLE'],
    ['MOVE_SPECTRAL_FLAME', 'EFFECT_SPECTRAL_FLAME'],
  ])('%s has %s', (moveId, effect) => expect(effectOf(moveId)).toBe(effect))
})
