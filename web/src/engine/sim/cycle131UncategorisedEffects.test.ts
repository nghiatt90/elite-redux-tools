/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 131: twelve effects that had no category: Defog, Bleed, Low Kick, Sharpen, Scary Face,
// Dragon Cheer, Eerie Fog, Laser Focus, Level Damage (Night Shade), Frostbite, Venom Drench and
// Mystic Dance. Every expected number is derived by hand from the pinned C named on the test that
// asserts it: the script in data/battle_scripts_1.s, the command in src/battle_script_commands.c /
// src/battle_util.c, or the table the sim mirrors.
//
// Stat stages run 0..12 with neutral 6 (DEFAULT_STAT_STAGE), so "-2" is stage 4 and "+1" stage 7.
// Damage shortcut used throughout: at level 50 with Atk == Def == 100 (or SpAtk == SpDef == 100)
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2` with the divisions
// truncating, and a critical hit doubles that result. A damage-roll draw of 0 is the 100% entry of
// the 85..100% array.
//
// Draw order used here: an accuracy-checked move spends one draw (a 0-accuracy move still spends
// it), a damaging hit then spends one crit draw and one damage-roll draw, and abilities' stat or
// status gates draw nothing. Moves whose C scripts have no accuracycheck (Sharpen, Scary Face,
// Dragon Cheer, Eerie Fog, Laser Focus, Mystic Dance) spend no accuracy draw at all.
import { describe, expect, it } from 'vitest'

import type { DamageContext } from '../types'
import { applyMoveBehaviorDamage } from '../basePower'
import type { BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  STAT_ACC,
  STAT_ATK,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_FROSTBITE,
  STATUS1_POISON,
  STATUS1_TOXIC_POISON,
  STATUS2_SUBSTITUTE,
  STATUS3_LASER_FOCUS,
  STATUS3_SEMI_INVULNERABLE,
  STATUS4_CUTTHROAT,
  STATUS4_FEAR,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_DURATION,
  WEATHER_DURATION_EXTENDED,
  WEATHER_FOG_TEMPORARY,
  WEATHER_SUN_PRIMAL,
  hasFlag,
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

const THIS_FILE = 'web/src/engine/sim/cycle131UncategorisedEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const ppOf = (state: BattleState, battlerId = 0, slot = 0) => state.battlers[battlerId]!.mon.pp[slot]
const stageOf = (state: BattleState, battlerId: number, stat: number) => state.battlers[battlerId]!.mon.statStages[stat] ?? DEFAULT_STAT_STAGE

/** The user (battler 0, Mudkip, faster than the default foe) knows only `moveId`; `pp` is its PP. */
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
// EFFECT_DEFOG. BattleScript_EffectDefog (data/battle_scripts_1.s:1560-1592),
// ClearDefogHazards / VARIOUS_DEFOG (src/battle_script_commands.c:6506-6560, :7599-7610).
// The evasion drop is a plain statbuffchange after the accuracy check, so a Substitute that
// merely routed the script through defogclear FALSE does NOT block the drop (:1571 has no
// substitute gate, and ChangeStatBuffs never reads STATUS2_SUBSTITUTE).
// ---------------------------------------------------------------------------
describe('cycle 131 - Defog (EFFECT_DEFOG)', () => {
  it('lowers evasion by one and clears both sides\' hazards plus the foe\'s screens (:6508-6553)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DEFOG', 15), foe(), rng)
    state.sides[0].statuses |= SIDE_STATUS_SPIKES | SIDE_STATUS_REFLECT // own screen stays (:6508 guards i != attacker side)
    state.sides[1].statuses |= SIDE_STATUS_SPIKES | SIDE_STATUS_REFLECT
    state.sides[1].timers.reflectTimer = 5

    const out = runVs(state, 'MOVE_DEFOG')

    // :1567-1571 statbuffchange STAT_EVASION, 1, TRUE -- 6 -> 5.
    expect(stageOf(state, 1, STAT_EVASION)).toBe(5)
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 1, stat: STAT_EVASION, change: -1 }])
    // :6508-6544: hazards on BOTH sides, screens only on the side that is not the attacker's.
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_REFLECT)).toBe(true)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(state.sides[1].timers.reflectTimer).toBe(0)
    expect(ppOf(state)).toBe(14)
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(rng.calls).toBe(1) // Defog's accuracycheck (:1568) still draws even though its accuracy is 0.
  })

  it('fails with PP spent and no accuracy draw when evasion is at -6 and nothing is clearable (:1565-1566)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DEFOG', 15), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_EVASION] = MIN_STAT_STAGE

    const out = runVs(state, 'MOVE_DEFOG')

    // defogclear FALSE finds nothing -> BattleScript_ButItFailedAtkStringPpReduce (:1566).
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(14)
    expect(rng.calls).toBe(0)
  })

  it('still succeeds at -6 when a hazard exists: no stat change, hazard cleared (:1565-1566, :1571)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DEFOG', 15), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_EVASION] = MIN_STAT_STAGE
    state.sides[1].statuses |= SIDE_STATUS_SPIKES

    const out = runVs(state, 'MOVE_DEFOG')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(stageOf(state, 1, STAT_EVASION)).toBe(MIN_STAT_STAGE)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(ppOf(state)).toBe(14)
    expect(rng.calls).toBe(1) // accuracy 0 still spends its one roll (:1568).
  })

  it('behind a Substitute: hazards clear and the evasion drop still lands (the C has no substitute gate here)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DEFOG', 15), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    state.sides[1].statuses |= SIDE_STATUS_SPIKES

    const out = runVs(state, 'MOVE_DEFOG')

    // jumpifsubstituteblocks routes to DefogIfCanClearHazards (:1563); defogclear FALSE succeeds,
    // so the script works. statbuffchange (:1571) is not substitute-gated.
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(stageOf(state, 1, STAT_EVASION)).toBe(5)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(false)
  })

  it('a miss leaves hazards in place: accuracycheck jumps to BattleScript_PrintMoveMissed (:1568)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DEFOG', 15), foe(), rng)
    state.battlers[1]!.statuses3 |= STATUS3_SEMI_INVULNERABLE
    state.sides[1].statuses |= SIDE_STATUS_SPIKES

    const out = runVs(state, 'MOVE_DEFOG')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(ppOf(state)).toBe(14)
    expect(rng.calls).toBe(1) // BattleScript_PrintMoveMissed does run ppreduce (:3093-3094).
  })
})

// ---------------------------------------------------------------------------
// EFFECT_BLEED. BattleScript_EffectBleed (data/battle_scripts_1.s:3115-3125),
// VARIOUS_REQUIRE_CAN_DO_EFFECT (src/battle_script_commands.c:8522-8532) and CanBleed
// (src/battle_util.c:5106-5114). ENDTURN_BLEED is src/battle_util.c:2598-2607.
// ---------------------------------------------------------------------------
describe('cycle 131 - Bleed (EFFECT_BLEED)', () => {
  it('inflicts STATUS1_BLEED and spends one accuracy draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BLOOD_SHOT', 10), foe(), rng)

    const out = runVs(state, 'MOVE_BLOOD_SHOT')

    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
    expect(actionOf(out, 0)?.statusApplied).toEqual({ battlerId: 1, status: 'BLEED' })
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(1)
  })

  it('fails before the accuracy check if the target is already statused (:3119, CanBleed :5107)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_BLOOD_SHOT', 10), foe({ status1: STATUS1_BLEED }), rng)

    const out = runVs(state, 'MOVE_BLOOD_SHOT')

    expect(actionOf(out, 0)?.statusApplied).toBeNull()
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(0)
  })

  it('Rock and Ghost are immune before the accuracy check (:8522-8532, CanBleed :5112-5113)', () => {
    for (const type of ['ROCK', 'GHOST']) {
      const rng = countRng()
      const state = battle(user('MOVE_BLOOD_SHOT', 10), foe({ types: [type, 'MYSTERY', 'MYSTERY'] }), rng)
      const out = runVs(state, 'MOVE_BLOOD_SHOT')
      expect(actionOf(out, 0)?.statusApplied).toBeNull()
      expect(state.battlers[1]!.mon.status1).toBe(0)
      expect(ppOf(state)).toBe(9)
      expect(rng.calls).toBe(0)
    }
  })

  it('a miss leaves no status and spends the one accuracy draw (:3120)', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_BLOOD_SHOT', 10), foe(), rng))

    const out = runVs(state, 'MOVE_BLOOD_SHOT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(1)
  })

  it('ENDTURN_BLEED removes maxHP/16: 160 -> 150 (:2599-2604)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TACKLE', 20), foe({ hp: 160, maxHp: 160, status1: STATUS1_BLEED }), rng)

    executeTurn(state, [null, null], loopDeps(state, fixedDamage(0)))

    expect(state.battlers[1]!.mon.hp).toBe(150) // 160 / 16 = 10
  })
})

// ---------------------------------------------------------------------------
// EFFECT_LOW_KICK. CustomMoveDamage<EFFECT_LOW_KICK> (src/script_conditions.cc:163-172) reads
// GetBattlerWeight (src/battle_util.c:6705-6734); the table is first-threshold-greater-than-wins,
// else 120. Grass Knot shares the behaviour (moves.json), Heavy Slam/Heat Crash use a ratio table.
// ---------------------------------------------------------------------------
describe('cycle 131 - Low Kick (EFFECT_LOW_KICK)', () => {
  const ctxWithWeight = (weight: number) => ({ defender: { weight } } as unknown as DamageContext)

  it.each([
    [99, 20],
    [100, 40],
    [249, 40],
    [250, 60],
    [999, 80],
    [1999, 100],
    [2000, 120],
  ])('defender weight %i -> power %i (:163-172)', (weight, power) => {
    expect(applyMoveBehaviorDamage(0, 'EFFECT_LOW_KICK', SIM.moveBehaviors, ctxWithWeight(weight)).power).toBe(power)
  })

  it('does not touch a non-weight behaviour (Body Slam stays its declared 85)', () => {
    expect(applyMoveBehaviorDamage(85, 'EFFECT_PARALYZE_HIT', SIM.moveBehaviors, ctxWithWeight(500)).power).toBe(85)
  })

  it('the live damage path reads the defender species weight: 99 -> 20 power, 100 -> 40, 2000 -> 120', () => {
    // Fighting vs the overridden Water type is neutral, and the attacker is Mudkip (no STAB).
    // No crit: accuracy 0, crit draw 1 (1 % 24 != 0), roll 0 = 100%.
    const cases: [string, number][] = [
      ['SPECIES_METAPOD', 10], // weight 99 -> power 20: 22*20/50 + 2 = 8 + 2 = 10
      ['SPECIES_KAKUNA', 19], // weight 100 -> power 40: 22*40/50 + 2 = 17 + 2 = 19
      ['SPECIES_CRUSTLE', 54], // weight 2000 -> power 120: 22*120/50 + 2 = 52 + 2 = 54
    ]
    for (const [speciesId, damage] of cases) {
      const rng = scriptedRng([0, 1, 0])
      const state = battle(
        user('MOVE_LOW_KICK', 20),
        monFor(speciesId, { types: ['WATER', 'MYSTERY', 'MYSTERY'] }),
        rng,
      )
      const out = runVsReal(state, 'MOVE_LOW_KICK')
      expect(actionOf(out, 0)?.targetDamage).toBe(damage)
      expect(rng.calls).toBe(3) // accuracy, crit, damage roll
    }
  })
})

// ---------------------------------------------------------------------------
// EFFECT_SHARPEN. BattleScript_EffectSharpen (data/battle_scripts_1.s:12008-12046),
// VARIOUS_RAISE_HIGHEST_ATTACKING_STAT (src/battle_script_commands.c:8159-8170) and
// VARIOUS_INCREASE_CRIT (:8591-8601). CutthroatOnly is the terminal failure path.
// ---------------------------------------------------------------------------
describe('cycle 131 - Sharpen (EFFECT_SHARPEN)', () => {
  it('raises the highest attacking stat (Atk on a tie) and crit stage by one, no accuracy draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHARPEN', 20), foe(), rng)

    const out = runVs(state, 'MOVE_SHARPEN')

    expect(stageOf(state, 0, STAT_ATK)).toBe(7) // raw Atk == SpAtk, :8748-8767 tie -> STAT_ATK
    expect(stageOf(state, 0, STAT_SPATK)).toBe(6)
    expect(state.battlers[0]!.volatiles.critBoost).toBe(1) // :12019 increasecrit BS_ATTACKER, 1
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(0) // no accuracycheck in this script (:12008-12012)
  })

  it('picks Sp. Atk when it is strictly higher (:8761-8764)', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_SHARPEN', 20, { rawStats: { atk: 100, def: 100, spatk: 150, spdef: 100, spe: 200 } }),
      foe(),
      rng,
    )
    const out = runVs(state, 'MOVE_SHARPEN')
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7)
    expect(stageOf(state, 0, STAT_ATK)).toBe(6)
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPATK, change: 1 }])
  })

  it('a Cutthroat ability gets STATUS4_CUTTHROAT after the crit raise (:12025-12034)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHARPEN', 20, { abilities: only('ABILITY_CUTTHROAT') }), foe(), rng)
    runVs(state, 'MOVE_SHARPEN')
    expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(true)
  })

  it('with the chosen stat already maxed it only raises crit (:12012 -> Sharpen_CritOnly :12034-12038)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHARPEN', 20), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE

    const out = runVs(state, 'MOVE_SHARPEN')

    expect(stageOf(state, 0, STAT_ATK)).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
    expect(actionOf(out, 0)?.statChanges).toEqual([])
    expect(actionOf(out, 0)?.missed).toBe(false)
  })

  it('maxed stat + critBoost 3 + no Cutthroat fails with PP spent (:12039-12042)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHARPEN', 20), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.volatiles.critBoost = 3

    const out = runVs(state, 'MOVE_SHARPEN')

    // CutthroatOnly: no STATUS4_CUTTHROAT, no ability flag -> goto BattleScript_ButItFailed.
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(false)
    expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
    expect(ppOf(state)).toBe(19)
  })

  it('maxed stat + critBoost 3 WITH Cutthroat still sets the flag and succeeds (:12043-12046)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHARPEN', 20, { abilities: only('ABILITY_CUTTHROAT') }), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.volatiles.critBoost = 3

    const out = runVs(state, 'MOVE_SHARPEN')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// EFFECT_SCARY_FACE. BattleScript_EffectScaryFace (data/battle_scripts_1.s:12050-12062): the
// script has NO accuracycheck at all; Speed is a two-stage drop and the Fear volatile is set
// unconditionally afterwards (seteffectprimary, src/battle_script_commands.c:2996-2999).
// ---------------------------------------------------------------------------
describe('cycle 131 - Scary Face (EFFECT_SCARY_FACE)', () => {
  it('Speed -2 and Fear, and never draws accuracy', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SCARY_FACE', 10), foe(), rng)

    const out = runVs(state, 'MOVE_SCARY_FACE')

    expect(stageOf(state, 1, STAT_SPEED)).toBe(4) // 6 - 2
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: -2 }])
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('at Speed -6 the stat stays put but Fear is still applied (:12056-12062)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SCARY_FACE', 10), foe(), rng)
    state.battlers[1]!.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE

    const out = runVs(state, 'MOVE_SCARY_FACE')

    expect(stageOf(state, 1, STAT_SPEED)).toBe(MIN_STAT_STAGE)
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    // battle_script_commands.c:9942 tests `MULTISTRING_CHOOSER == B_MSG_STAT_WONT_INCREASE`, and
    // B_MSG_STAT_WONT_DECREASE is also 2 (battle_string_ids.h:1088,1096), so the floor case sets
    // MOVE_RESULT_MISSED too -- the sim's `missed` carries that flag (no accuracy roll happens).
    // The script's fail pointer (:12055) is the Fear label, so the move still reaches setmoveeffect.
    expect(actionOf(out, 0)?.missed).toBe(true)
  })

  it('an already-feared target still takes the Speed drop; SetFear is skipped, so Fear lapses at turn end', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SCARY_FACE', 10), foe(), rng)
    // A fear set on an earlier turn: `started` is ZEROed at the start of every turn
    // (battle_main.c:4589), so only the persistent flag/volatile survive into this one.
    state.battlers[1]!.statuses4 |= STATUS4_FEAR
    state.battlers[1]!.volatiles.fear = true

    runVs(state, 'MOVE_SCARY_FACE')

    expect(stageOf(state, 1, STAT_SPEED)).toBe(4) // res.missed does not stop the later branch
    // SetMoveEffect's MOVE_EFFECT_FEAR arm (:2996-2999) does nothing while `fear` is set, so
    // started.fear stays FALSE and ENDTURN_GENERIC_BATTLER_TIMERS (:2961-2964) clears both.
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(false)
    expect(state.battlers[1]!.volatiles.fear).toBe(false)
  })

  it('Clear Body blocks the Speed drop but not Fear', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SCARY_FACE', 10), foe({ abilities: only('ABILITY_CLEAR_BODY') }), rng)

    runVs(state, 'MOVE_SCARY_FACE')

    expect(stageOf(state, 1, STAT_SPEED)).toBe(6)
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// EFFECT_DRAGON_CHEER. BattleScript_EffectDragonCheer (data/battle_scripts_1.s:11903-11938) and
// VARIOUS_INCREASE_CRIT (src/battle_script_commands.c:8591-8601): min(3 - critBoost, amount),
// no accuracy check. PartnerOnly (jumpifabsent, :11929) is the doubles-only half.
// ---------------------------------------------------------------------------
describe('cycle 131 - Dragon Cheer (EFFECT_DRAGON_CHEER)', () => {
  it('a non-Dragon user gains one crit stage, no accuracy draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DRAGON_CHEER', 15), foe(), rng)

    const out = runVs(state, 'MOVE_DRAGON_CHEER')

    expect(state.battlers[0]!.volatiles.critBoost).toBe(1) // :11908 increasecrit BS_ATTACKER, 1
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(14)
    expect(rng.calls).toBe(0)
  })

  it('a Dragon user gains two crit stages (:11907, :11911)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DRAGON_CHEER', 15, { types: ['DRAGON', 'MYSTERY', 'MYSTERY'] }), foe(), rng)
    runVs(state, 'MOVE_DRAGON_CHEER')
    expect(state.battlers[0]!.volatiles.critBoost).toBe(2)
  })

  it('clamps at 3: critBoost 2 + 1 stays within the cap (:8594)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DRAGON_CHEER', 15), foe(), rng)
    state.battlers[0]!.volatiles.critBoost = 2
    runVs(state, 'MOVE_DRAGON_CHEER')
    expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
  })

  it('at critBoost 3 with no partner it fails with PP spent (:11929 jumpifabsent)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_DRAGON_CHEER', 15), foe(), rng)
    state.battlers[0]!.volatiles.critBoost = 3

    const out = runVs(state, 'MOVE_DRAGON_CHEER')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
    expect(ppOf(state)).toBe(14)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// EFFECT_EERIE_FOG. BattleScript_EffectEerieFog (data/battle_scripts_1.s:12406-12413),
// checkprimalweather then setbattleweather ENUM_WEATHER_FOG (:12410-12411), and
// TryChangeBattleWeather (src/battle_util.c:3721-3743). Weather duration is 8, or 12 with
// HOLD_EFFECT_SMOKE_BALL (include/battle_util.h:50-51).
// ---------------------------------------------------------------------------
describe('cycle 131 - Eerie Fog (EFFECT_EERIE_FOG)', () => {
  it('sets temporary fog for 8 turns (:12411, :3730-3737)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EERIE_FOG', 10), foe(), rng)

    const out = runVs(state, 'MOVE_EERIE_FOG')

    expect(state.field.weather).toBe(WEATHER_FOG_TEMPORARY)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(0)
  })

  it('Smoke Ball extends the duration to 12 (:3734-3736)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EERIE_FOG', 10, { itemId: 'ITEM_SMOKE_BALL' }), foe(), rng)
    runVs(state, 'MOVE_EERIE_FOG')
    expect(state.field.weather).toBe(WEATHER_FOG_TEMPORARY)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION_EXTENDED)
  })

  it('already foggy: fails with PP spent, the existing timer keeps ticking (:3731)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EERIE_FOG', 10), foe(), rng)
    state.field.weather = WEATHER_FOG_TEMPORARY
    state.field.weatherDuration = 3
    state.field.timers.started.weather = false

    const out = runVs(state, 'MOVE_EERIE_FOG')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.field.weather).toBe(WEATHER_FOG_TEMPORARY)
    expect(state.field.weatherDuration).toBe(2) // ENDTURN_FOG ticked it; the move did not reset it
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(0)
  })

  it('primal weather ends the script at MoveEnd: no change and no failure (:12410)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_EERIE_FOG', 10), foe(), rng)
    state.field.weather = WEATHER_SUN_PRIMAL
    state.field.weatherDuration = 255

    const out = runVs(state, 'MOVE_EERIE_FOG')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(state.field.weatherDuration).toBe(255)
    expect(ppOf(state)).toBe(9)
  })

  it('ENDTURN_FOG drops every above-neutral stat by one, except Ghost/Psychic (:8601-8623)', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_EERIE_FOG', 10, { types: ['GHOST', 'MYSTERY', 'MYSTERY'] }),
      foe({ types: ['WATER', 'MYSTERY', 'MYSTERY'] }),
      rng,
    )
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    state.battlers[1]!.mon.statStages[STAT_ATK] = 8

    runVs(state, 'MOVE_EERIE_FOG')

    expect(stageOf(state, 0, STAT_ATK)).toBe(8) // Ghost is exempt
    expect(stageOf(state, 1, STAT_ATK)).toBe(7) // 8 -> 7, exactly one stage
  })
})

// ---------------------------------------------------------------------------
// EFFECT_LASER_FOCUS. BattleScript_EffectLaserFocus (data/battle_scripts_1.s:1037-1047),
// Cmd_setuserstatus3 (src/battle_script_commands.c:11991-12002), CalcCritChanceStage's
// ALWAYS_CRIT (:1540-1544), Cmd_critcalc's no-draw arm (:1576-1577), ENDTURN_LASER_FOCUS
// (src/battle_util.c:2855-2861).
// ---------------------------------------------------------------------------
describe('cycle 131 - Laser Focus (EFFECT_LASER_FOCUS)', () => {
  it('sets STATUS3_LASER_FOCUS with timer 2 (:11999), and the end of the turn ticks it to 1', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LASER_FOCUS', 20), foe(), rng)

    const out = runVs(state, 'MOVE_LASER_FOCUS')

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_LASER_FOCUS)).toBe(true)
    expect(state.battlers[0]!.volatiles.laserFocusTimer).toBe(1) // 2 set at :11999, ENDTURN decrements once
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(0)
  })

  it('a second use fails with PP spent while the status is already up (:1041)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LASER_FOCUS', 20), foe(), rng)
    state.battlers[0]!.statuses3 |= STATUS3_LASER_FOCUS
    state.battlers[0]!.volatiles.laserFocusTimer = 2

    const out = runVs(state, 'MOVE_LASER_FOCUS')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_LASER_FOCUS)).toBe(true)
    expect(ppOf(state)).toBe(19)
  })

  it('the next move crits without drawing a crit roll and expires at the end of that turn', () => {
    // Turn 1: Laser Focus (no draws of its own).
    const rng = scriptedRng([0, 0])
    const state = battle(user('MOVE_LASER_FOCUS', 20), foe(), rng)
    runVs(state, 'MOVE_LASER_FOCUS')

    // Turn 2: Tackle. 22*40/50 + 2 = 17 + 2 = 19, then the forced crit's x1.5
    // (CalcFinalDmg #4, battle_util.c:7507-7514) rounds 28.5 up to 29.
    // Draws: accuracy 0 (hit); the crit roll is SKIPPED (ALWAYS_CRIT, :1576-1577); damage roll 0 = 100%.
    state.battlers[0]!.mon.moves[0] = 'MOVE_TACKLE'
    state.battlers[0]!.mon.pp[0] = 20
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, bridgeDamage(state, rng)))

    expect(actionOf(out, 0)?.targetDamage).toBe(29)
    expect(rng.calls).toBe(2)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_LASER_FOCUS)).toBe(false) // 1 -> 0 clears (:2856-2859)
  })

  it('without Laser Focus the same hit is not a crit and spends the crit draw too', () => {
    const state = battle(user('MOVE_TACKLE', 20), foe(), scriptedRng([0, 1, 0]))
    const rng = state.rng as ReturnType<typeof scriptedRng>
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, bridgeDamage(state, rng)))
    expect(actionOf(out, 0)?.targetDamage).toBe(19)
    expect(rng.calls).toBe(3) // accuracy, crit, damage roll
  })
})

// ---------------------------------------------------------------------------
// EFFECT_LEVEL_DAMAGE. BattleScript_EffectLevelDamage (data/battle_scripts_1.s:4639-4648):
// accuracycheck, ppreduce, typecalc, calculatesetdamage, adjustdamage. Cmd_calculatesetdamage
// (src/battle_script_commands.c:10626-10659) uses the attacker's level; adjustdamage cannot crit,
// and the script clears SUPER_EFFECTIVE/NOT_VERY_EFFECTIVE before the fixed amount.
// ---------------------------------------------------------------------------
describe('cycle 131 - Level Damage / Night Shade (EFFECT_LEVEL_DAMAGE)', () => {
  it('level 50 deals exactly 50 and a critical roll cannot alter it', () => {
    for (const values of [[0, 0, 0], [0, 1, 0]]) {
      const rng = scriptedRng(values)
      const state = battle(user('MOVE_NIGHT_SHADE', 15), foe(), rng)
      const out = runVsReal(state, 'MOVE_NIGHT_SHADE')
      expect(actionOf(out, 0)?.targetDamage).toBe(50)
      expect(state.battlers[1]!.mon.hp).toBe(50)
      expect(ppOf(state)).toBe(14)
      expect(rng.calls).toBe(3)
    }
  })

  it('a Normal-type target is immune: the fixed amount is not applied over the 0 (:4641-4647)', () => {
    const rng = scriptedRng([0, 0, 0])
    const state = battle(user('MOVE_NIGHT_SHADE', 15), foe({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }), rng)

    const out = runVsReal(state, 'MOVE_NIGHT_SHADE')

    expect(actionOf(out, 0)?.targetDamage).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(ppOf(state)).toBe(14)
  })

  it('a Ghost-type target is still exactly 50: typecalc runs but the multiplier is cleared (:4644-4645)', () => {
    const rng = scriptedRng([0, 0, 0])
    const state = battle(user('MOVE_NIGHT_SHADE', 15), foe({ types: ['GHOST', 'MYSTERY', 'MYSTERY'] }), rng)

    const out = runVsReal(state, 'MOVE_NIGHT_SHADE')

    expect(actionOf(out, 0)?.targetDamage).toBe(50)
  })

  it('level 1 deals 1 (the script\'s fail-safe floor)', () => {
    const rng = scriptedRng([0, 0, 0])
    const state = battle(user('MOVE_NIGHT_SHADE', 15, { level: 1 }), foe(), rng)
    const out = runVsReal(state, 'MOVE_NIGHT_SHADE')
    expect(actionOf(out, 0)?.targetDamage).toBe(1)
  })

  it('a miss deals nothing and still costs PP (:4641 -> BattleScript_PrintMoveMissed)', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_NIGHT_SHADE', 15), foe(), rng))

    const out = runVsReal(state, 'MOVE_NIGHT_SHADE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(ppOf(state)).toBe(14)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// EFFECT_FROSTBITE. BattleScript_EffectFrostbite (data/battle_scripts_1.s:3127-3138),
// VARIOUS_REQUIRE_CAN_DO_EFFECT / CanGetFrostbite (src/battle_util.c:5096-5104), ENDTURN_FROSTBITE
// (:2584-2596), and CalculateStat's SpAtk pre-modifier (src/battle_util.c:7145-7147, halve while
// frostbitten outside Facade).
// ---------------------------------------------------------------------------
describe('cycle 131 - Frostbite (EFFECT_FROSTBITE)', () => {
  it('inflicts STATUS1_FROSTBITE after one accuracy draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FLASH_FREEZE', 10), foe(), rng)

    const out = runVs(state, 'MOVE_FLASH_FREEZE')

    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
    expect(actionOf(out, 0)?.statusApplied).toEqual({ battlerId: 1, status: 'FROSTBITE' })
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(1)
  })

  it('already statused or Ice-type fails before the accuracy check (:3131, CanGetFrostbite :5100)', () => {
    const cases = [foe({ status1: STATUS1_FROSTBITE }), foe({ types: ['ICE', 'MYSTERY', 'MYSTERY'] })]
    for (const target of cases) {
      const rng = countRng()
      const state = battle(user('MOVE_FLASH_FREEZE', 10), target, rng)
      const out = runVs(state, 'MOVE_FLASH_FREEZE')
      expect(actionOf(out, 0)?.statusApplied).toBeNull()
      expect(ppOf(state)).toBe(9)
      expect(rng.calls).toBe(0)
    }
  })

  it('Safeguard blocks at requirecandoeffect, before the accuracy check (CanGetFrostbite -> IsStatusImmune :5028)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FLASH_FREEZE', 10), foe(), rng)
    state.sides[1].statuses |= SIDE_STATUS_SAFEGUARD

    const out = runVs(state, 'MOVE_FLASH_FREEZE')

    expect(actionOf(out, 0)?.statusApplied).toBeNull()
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(9)
    // requirecandoeffect (:3131) runs CanGetFrostbite, whose IsStatusImmune (battle_util.c:5024-5030)
    // already returns TRUE for SIDE_STATUS_SAFEGUARD, so the script fails before accuracycheck
    // (:3132) and no draw happens. The later jumpifsafeguard (:3133) is unreachable for a Safeguard
    // that was already up when the move started.
    expect(rng.calls).toBe(0)
  })

  it('a miss leaves no status (:3132)', () => {
    const rng = missRng() // Flash Freeze is 90% accurate, so 99 misses
    const state = battle(user('MOVE_FLASH_FREEZE', 10), foe(), rng)

    const out = runVs(state, 'MOVE_FLASH_FREEZE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(1)
  })

  it('ENDTURN_FROSTBITE removes maxHP/16: 160 -> 150 (:2585-2592)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TACKLE', 20), foe({ hp: 160, maxHp: 160, status1: STATUS1_FROSTBITE }), rng)
    executeTurn(state, [null, null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[1]!.mon.hp).toBe(150)
  })

  it('halves the attacker\'s Sp. Atk: Psychic 90 vs a neutral 100/100 target goes 62 -> 32 under a crit', () => {
    // The resolver's first draw is 0, which is a crit (0 % 24 == 0); the second is the 100% roll.
    // Healthy SpAtk 100: 22*90*100/100 = 1980 -> /50 = 39 -> +2 = 41; x1.5 (crit) = 61.5 -> 62.
    // Frostbitten SpAtk 100 -> 50: 22*90*50/100 = 990 -> /50 = 19 -> +2 = 21; x1.5 = 31.5 -> 32.
    const healthyAction = useMove(1, 'MOVE_PSYCHIC')
    const healthy = battle(user('MOVE_PSYCHIC', 15), foe({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }), scriptedRng([0, 0]))
    const healthyHit = bridgeDamage(healthy, healthy.rng).resolve(healthy, 0, 1, healthyAction, { targetHasActedThisTurn: false })

    const frostAction = useMove(1, 'MOVE_PSYCHIC')
    const frostbitten = battle(
      user('MOVE_PSYCHIC', 15, { status1: STATUS1_FROSTBITE }),
      foe({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }),
      scriptedRng([0, 0]),
    )
    const frostHit = bridgeDamage(frostbitten, frostbitten.rng).resolve(frostbitten, 0, 1, frostAction, { targetHasActedThisTurn: false })

    expect(healthyHit.targetDamage).toBe(62)
    expect(frostHit.targetDamage).toBe(32)
  })
})

// ---------------------------------------------------------------------------
// EFFECT_VENOM_DRENCH. BattleScript_EffectVenomDrench (data/battle_scripts_1.s:1732-1765): the
// poison/Toxic-Terrain gate and the all-stats-at-min gate run BEFORE accuracycheck; each of Atk,
// SpAtk and Speed then gets an independent statbuffchange.
// ---------------------------------------------------------------------------
describe('cycle 131 - Venom Drench (EFFECT_VENOM_DRENCH)', () => {
  const dropAll = (status1: number) => {
    const rng = countRng()
    const s = battle(user('MOVE_VENOM_DRENCH', 20), foe({ status1 }), rng)
    return { state: s, rng, out: runVs(s, 'MOVE_VENOM_DRENCH') }
  }

  it('poisoned: Atk, SpA and Speed each fall one stage (:1736, :1747-1766)', () => {
    const { state, rng, out } = dropAll(STATUS1_POISON)
    expect(stageOf(state, 1, STAT_ATK)).toBe(5)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(5)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(5)
    expect(actionOf(out, 0)?.statChanges).toEqual([
      { battlerId: 1, stat: STAT_ATK, change: -1 },
      { battlerId: 1, stat: STAT_SPATK, change: -1 },
      { battlerId: 1, stat: STAT_SPEED, change: -1 },
    ])
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(1) // only the accuracycheck
  })

  it('badly poisoned counts as poisoned (:1736 STATUS1_POISON_ANY)', () => {
    const { state } = dropAll(STATUS1_TOXIC_POISON)
    expect(stageOf(state, 1, STAT_ATK)).toBe(5)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(5)
  })

  it('an unpoisoned target off Toxic Terrain fails before the accuracy check (:1737-1738)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_VENOM_DRENCH', 20), foe(), rng)

    const out = runVs(state, 'MOVE_VENOM_DRENCH')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(0)
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
  })

  it('Toxic Terrain lets an unpoisoned grounded target be drenched (:1737)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_VENOM_DRENCH', 20), foe(), rng)
    state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN

    const out = runVs(state, 'MOVE_VENOM_DRENCH')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(stageOf(state, 1, STAT_ATK)).toBe(5)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(5)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(5)
    expect(rng.calls).toBe(1)
  })

  it('all three at -6 jumps to CantLowerMultipleStats before accuracy (:1740-1742)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_VENOM_DRENCH', 20), foe({ status1: STATUS1_POISON }), rng)
    for (const stat of [STAT_ATK, STAT_SPATK, STAT_SPEED]) state.battlers[1]!.mon.statStages[stat] = MIN_STAT_STAGE

    const out = runVs(state, 'MOVE_VENOM_DRENCH')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(0)
  })

  it('Atk/SpA at -6 but Speed above it: only Speed falls (:1740-1742)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_VENOM_DRENCH', 20), foe({ status1: STATUS1_POISON }), rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    state.battlers[1]!.mon.statStages[STAT_SPATK] = MIN_STAT_STAGE

    const out = runVs(state, 'MOVE_VENOM_DRENCH')

    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: -1 }])
    expect(stageOf(state, 1, STAT_SPEED)).toBe(5)
    expect(stageOf(state, 1, STAT_ATK)).toBe(MIN_STAT_STAGE)
  })

  it('a miss changes nothing (:1744 accuracycheck)', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_VENOM_DRENCH', 20), foe({ status1: STATUS1_POISON }), rng))

    const out = runVs(state, 'MOVE_VENOM_DRENCH')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(6)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(6)
    expect(rng.calls).toBe(1)
  })

  it('Clear Body blocks all three drops but the move still resolves', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_VENOM_DRENCH', 20),
      foe({ status1: STATUS1_POISON, abilities: only('ABILITY_CLEAR_BODY') }),
      rng,
    )

    const out = runVs(state, 'MOVE_VENOM_DRENCH')

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(stageOf(state, 1, STAT_ATK)).toBe(6)
    expect(stageOf(state, 1, STAT_SPATK)).toBe(6)
    expect(stageOf(state, 1, STAT_SPEED)).toBe(6)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// EFFECT_MYSTIC_DANCE. BattleScript_EffectMysticDance (data/battle_scripts_1.s:6773-6797):
// no accuracycheck; the CantRaiseMultipleStats branch fires only when SpAtk is already MAX and
// Speed is MAX, and each stat gets its own statbuffchange.
// ---------------------------------------------------------------------------
describe('cycle 131 - Mystic Dance (EFFECT_MYSTIC_DANCE)', () => {
  it('raises Sp. Atk and Speed by one with no accuracy draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MYSTIC_DANCE', 20), foe(), rng)

    const out = runVs(state, 'MOVE_MYSTIC_DANCE')

    expect(stageOf(state, 0, STAT_SPATK)).toBe(7)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(7)
    expect(actionOf(out, 0)?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
    ])
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(0)
  })

  it('SpA at +6 but Speed below it raises only Speed (:6777-6778)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MYSTIC_DANCE', 20), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE

    const out = runVs(state, 'MOVE_MYSTIC_DANCE')

    expect(stageOf(state, 0, STAT_SPATK)).toBe(MAX_STAT_STAGE)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(7)
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 1 }])
  })

  it('both at +6 jumps to CantRaiseMultipleStats: fail with PP spent (:6778)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MYSTIC_DANCE', 20), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE

    const out = runVs(state, 'MOVE_MYSTIC_DANCE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(19)
    expect(actionOf(out, 0)?.statChanges).toEqual([])
    expect(rng.calls).toBe(0)
  })

  it('SpA 5 -> 6 with Speed already +6: SpA still rises and the cap holds (:6777)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MYSTIC_DANCE', 20), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPATK] = 11
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE

    const out = runVs(state, 'MOVE_MYSTIC_DANCE')

    expect(stageOf(state, 0, STAT_SPATK)).toBe(MAX_STAT_STAGE)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(MAX_STAT_STAGE)
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPATK, change: 1 }])
  })

  it('Contrary flips both raises into drops', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MYSTIC_DANCE', 20, { abilities: only('ABILITY_CONTRARY') }), foe(), rng)

    const out = runVs(state, 'MOVE_MYSTIC_DANCE')

    expect(stageOf(state, 0, STAT_SPATK)).toBe(5)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(5)
    expect(actionOf(out, 0)?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPATK, change: -1 },
      { battlerId: 0, stat: STAT_SPEED, change: -1 },
    ])
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe('cycle 131 registry', () => {
  const SHIPPED_EFFECTS = [
    'EFFECT_DEFOG',
    'EFFECT_BLEED',
    'EFFECT_LOW_KICK',
    'EFFECT_SHARPEN',
    'EFFECT_SCARY_FACE',
    'EFFECT_DRAGON_CHEER',
    'EFFECT_EERIE_FOG',
    'EFFECT_LASER_FOCUS',
    'EFFECT_LEVEL_DAMAGE',
    'EFFECT_FROSTBITE',
    'EFFECT_VENOM_DRENCH',
    'EFFECT_MYSTIC_DANCE',
  ]

  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('none of these effects is allowlisted: all twelve have singles-observable behaviour', () => {
    for (const effect of SHIPPED_EFFECTS) expect(findAllowance(effect)).toBeUndefined()
  })

  it.each([
    ['MOVE_DEFOG', 'EFFECT_DEFOG'],
    ['MOVE_BLOOD_SHOT', 'EFFECT_BLEED'],
    ['MOVE_LOW_KICK', 'EFFECT_LOW_KICK'],
    ['MOVE_GRASS_KNOT', 'EFFECT_LOW_KICK'],
    ['MOVE_SHARPEN', 'EFFECT_SHARPEN'],
    ['MOVE_SCARY_FACE', 'EFFECT_SCARY_FACE'],
    ['MOVE_DRAGON_CHEER', 'EFFECT_DRAGON_CHEER'],
    ['MOVE_EERIE_FOG', 'EFFECT_EERIE_FOG'],
    ['MOVE_LASER_FOCUS', 'EFFECT_LASER_FOCUS'],
    ['MOVE_NIGHT_SHADE', 'EFFECT_LEVEL_DAMAGE'],
    ['MOVE_FLASH_FREEZE', 'EFFECT_FROSTBITE'],
    ['MOVE_VENOM_DRENCH', 'EFFECT_VENOM_DRENCH'],
    ['MOVE_MYSTIC_DANCE', 'EFFECT_MYSTIC_DANCE'],
  ])('%s has %s', (moveId, effect) => expect(effectOf(moveId)).toBe(effect))
})
