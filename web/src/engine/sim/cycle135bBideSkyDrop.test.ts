/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 135b: verify and port EFFECT_BIDE and EFFECT_SKY_DROP.
// Every expected number is hand-derived from the pinned C in data/battle_scripts_1.s,
// src/battle_script_commands.c, src/battle_util.c, and src/battle_main.c.
//
// Damage shortcut used throughout: at level 50 with Atk == Def == 100
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2` with divisions truncating.
//
// Draw order: accuracy roll first, then the move's secondary roll, then the ability's roll.
// Crit roll (1 = no crit), damage roll (0 = full damage / max roll).
import { describe, expect, it } from 'vitest'

import type { BridgeDeps } from './bridge'
import {
  STATUS1_PARALYSIS,
  STATUS2_BIDE,
  STATUS2_BIDE_TURN,
  STATUS2_MULTIPLETURNS,
  STATUS3_ON_AIR,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { isEligibleMove, VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ReplacementDeps } from './switchIn'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { applyDamage, executeTurn, performSwitchAction } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT
const THIS_FILE = 'web/src/engine/sim/cycle135bBideSkyDrop.test.ts'

const freshAbilities = (): SimBattleMon['abilities'] => ({ ability: null, innates: [null, null, null] })

const FAST_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }
const SLOW_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 }

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

describe('Cycle 135b Verified Move Effects list registration', () => {
  it('registers EFFECT_BIDE and EFFECT_SKY_DROP as verified in this test file', () => {
    expect(VERIFIED_MOVE_EFFECTS.get('EFFECT_BIDE')).toBe(THIS_FILE)
    expect(VERIFIED_MOVE_EFFECTS.get('EFFECT_SKY_DROP')).toBe(THIS_FILE)
    expect(isEligibleMove({ power: 0, effect: 'EFFECT_BIDE' })).toBe(true)
    expect(isEligibleMove({ power: 0, effect: 'EFFECT_SKY_DROP' })).toBe(true)
  })
})

describe('EFFECT_BIDE (move Bide)', () => {
  // Hand derivation:
  // Tackle: power 40, normal type. User Mudkip is Water/Ground, opponent Mudkip is Water/Ground (no STAB).
  // At level 50 with Atk 100, Def 100:
  // baseDamage = floor(floor(22 * 40 * 100 / 100) / 50) + 2 = floor(880 / 50) + 2 = 17 + 2 = 19.
  // Max roll (0), no crit (1): deals exactly 19 damage.
  // Turn 1: Bide set (counter 2, takenDmg = 0), opponent Tackle deals 19 damage -> user takenDmg = 19.
  // Turn 2: Bide storing energy (counter 1), opponent Tackle deals 19 damage -> user takenDmg = 38.
  // Turn 3: Bide unleashes 2 * takenDmg = 2 * 38 = 76 damage.
  it('positive: stores energy across 2 turns and unleashes 2 * takenDmg on turn 3', () => {
    const userMon = monFor('SPECIES_MUDKIP', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_BIDE', null, null, null],
      pp: [10, 0, 0, 0],
      hp: 100,
      maxHp: 100,
    })
    const foeMon = monFor('SPECIES_MUDKIP', {
      rawStats: { ...SLOW_STATS },
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
      hp: 100,
      maxHp: 100,
    })
    // Draws per Tackle: accuracy (0, hits), crit (1, no crit), roll (0, max roll)
    const rng = scriptedRng([0, 1, 0, 0, 1, 0])
    const state = battle(userMon, foeMon, rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    // Turn 1: user uses Bide (priority 1), opponent uses Tackle
    const out1 = executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    expect(out1.actions[0].targetDamage).toBeNull() // Turn 1 deals no damage
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // exactly 1 PP spent
    expect(out1.actions[1].targetDamage).toBe(19) // Tackle deals 19 damage
    expect(state.battlers[0]!.mon.hp).toBe(81)
    expect(state.battlers[0]!.takenDmg).toBe(19)
    expect(state.battlers[0]!.takenDmgBy).toBe(1)
    expect(state.battlers[0]!.mon.status2 & STATUS2_MULTIPLETURNS).toBeTruthy()
    expect(state.battlers[0]!.mon.status2 & STATUS2_BIDE).toBe(STATUS2_BIDE_TURN(2))

    // Turn 2: user locked into Bide (storing energy), opponent uses Tackle
    const out2 = executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    expect(out2.actions[0].cancelledBy).toBe('BIDE') // CANCELLER_BIDE storing energy
    expect(out2.actions[0].targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // no extra PP spent on turn 2
    expect(out2.actions[1].targetDamage).toBe(19)
    expect(state.battlers[0]!.mon.hp).toBe(62)
    expect(state.battlers[0]!.takenDmg).toBe(38) // 19 + 19 = 38
    expect(state.battlers[0]!.mon.status2 & STATUS2_BIDE).toBe(STATUS2_BIDE_TURN(1))

    // Turn 3: user unleashes 2 * 38 = 76 damage
    const out3 = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(out3.actions[0].cancelledBy).toBeNull()
    expect(out3.actions[0].targetDamage).toBe(76) // exactly 2 * 38
    expect(state.battlers[1]!.mon.hp).toBe(24) // 100 - 76 = 24
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // no PP spent on turn 3
    expect(state.battlers[0]!.mon.status2 & STATUS2_MULTIPLETURNS).toBe(0) // MULTIPLETURNS cleared
    expect(state.battlers[0]!.mon.status2 & STATUS2_BIDE).toBe(0) // BIDE counter cleared
  })

  it('negative: no damage taken causes turn 3 to fail and deal nothing', () => {
    const userMon = monFor('SPECIES_MUDKIP', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_BIDE', null, null, null],
      pp: [10, 0, 0, 0],
    })
    const foeMon = monFor('SPECIES_MUDKIP', { rawStats: { ...SLOW_STATS } })
    const rng = countRng()
    const state = battle(userMon, foeMon, rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    // Turn 1: user sets Bide, opponent does nothing
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(state.battlers[0]!.takenDmg).toBe(0)

    // Turn 2: storing energy, opponent does nothing
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(state.battlers[0]!.takenDmg).toBe(0)

    // Turn 3: unleashes with 0 damage taken -> BattleScript_BideNoEnergyToAttack fails
    const out3 = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(out3.actions[0].cancelledBy).toBe('BIDE')
    expect(out3.actions[0].targetDamage).toBeNull()
    expect(state.battlers[1]!.mon.hp).toBe(100) // foe took no damage
    expect(state.battlers[0]!.mon.status2 & STATUS2_MULTIPLETURNS).toBe(0)
    expect(state.battlers[0]!.mon.status2 & STATUS2_BIDE).toBe(0)
  })

  it('negative: damage taken before Bide is set does not count', () => {
    const userMon = monFor('SPECIES_MUDKIP', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_BIDE', null, null, null],
      pp: [10, 0, 0, 0],
    })
    const foeMon = monFor('SPECIES_MUDKIP', { rawStats: { ...SLOW_STATS } })
    const rng = countRng()
    const state = battle(userMon, foeMon, rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    // Damage before Bide setup
    applyDamage(state, 0, 40, [])
    expect(state.battlers[0]!.takenDmg).toBe(40)

    // Turn 1: Bide setup resets takenDmg to 0 (Cmd_setbide, battle_script_commands.c:10001)
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(state.battlers[0]!.takenDmg).toBe(0)

    // Turn 2: storing energy
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)

    // Turn 3: 0 damage taken since setup -> fails
    const out3 = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(out3.actions[0].cancelledBy).toBe('BIDE')
    expect(out3.actions[0].targetDamage).toBeNull()
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })

  it('negative: bide counter does not decrement on a turn where user is fully paralysed', () => {
    const userMon = monFor('SPECIES_MUDKIP', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_BIDE', null, null, null],
      pp: [10, 0, 0, 0],
      status1: STATUS1_PARALYSIS,
    })
    const foeMon = monFor('SPECIES_MUDKIP', { rawStats: { ...SLOW_STATS } })
    // Paralysis roll: Random() % 4 === 0 is full paralysis.
    // Turn 1: roll 1 (1 % 4 !== 0, can act, sets Bide)
    // Turn 2: roll 0 (0 % 4 === 0, fully paralysed, CANCELLER_PARALYSED fires before CANCELLER_BIDE)
    const rng = scriptedRng([1, 0])
    const state = battle(userMon, foeMon, rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    // Turn 1: sets Bide
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(state.battlers[0]!.mon.status2 & STATUS2_BIDE).toBe(STATUS2_BIDE_TURN(2))

    // Turn 2: fully paralysed
    const out2 = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(out2.actions[0].cancelledBy).toBe('PARALYSIS')
    // Counter must NOT decrement because paralysis cancelled before CANCELLER_BIDE
    expect(state.battlers[0]!.mon.status2 & STATUS2_BIDE).toBe(STATUS2_BIDE_TURN(2))
  })
})

describe('EFFECT_SKY_DROP (moves Sky Drop and Seismic Toss)', () => {
  // Hand derivation for Sky Drop:
  // User Pidgeot: Level 50, Flying type (STAB 1.5), Atk 100.
  // Target Mudkip: Def 100, neutral to Flying.
  // Power 60:
  // baseDamage = floor(floor(22 * 60 * 100 / 100) / 50) + 2 = floor(1320 / 50) + 2 = 26 + 2 = 28.
  // STAB: floor(28 * 1.5) = 42. Max roll (0), no crit (1) -> 42 damage.
  it('positive: turn 1 user gains ON_AIR, target is skyDropped and cannot act; turn 2 deals Flying damage', () => {
    const userMon = monFor('SPECIES_PIDGEOT', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_SKY_DROP', null, null, null],
      pp: [10, 0, 0, 0],
    })
    const foeMon = monFor('SPECIES_MUDKIP', {
      rawStats: { ...SLOW_STATS },
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
      hp: 100,
      maxHp: 100,
    })
    // Turn 1: user accuracy (0, hits)
    // Turn 2: crit (1, no crit), roll (0, max roll)
    const rng = scriptedRng([0, 1, 0])
    const state = battle(userMon, foeMon, rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    // Turn 1: user uses Sky Drop on 1, foe tries to use Tackle on 0
    const out1 = executeTurn(state, [useMove(1, 'MOVE_SKY_DROP'), useMove(0, 'MOVE_TACKLE')], deps)
    expect(out1.actions[0].targetDamage).toBeNull() // charging turn deals no damage
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // 1 PP spent
    expect(state.battlers[0]!.statuses3 & STATUS3_ON_AIR).toBeTruthy()
    expect(state.battlers[0]!.mon.status2 & STATUS2_MULTIPLETURNS).toBeTruthy()
    expect(state.battlers[1]!.volatiles.skyDropped).toBe(true)
    expect(state.battlers[1]!.volatiles.skyDroppedBy).toBe(0)
    expect(state.battlers[1]!.statuses3 & STATUS3_ON_AIR).toBeTruthy()
    // Foe's Tackle cancelled by CANCELLER_SKY_DROP without spending PP
    expect(out1.actions[1].cancelledBy).toBe('SKY_DROP')
    expect(state.battlers[1]!.mon.pp[0]).toBe(35)

    // Turn 2: user drops the target, deals 42 damage
    const out2 = executeTurn(state, [useMove(1, 'MOVE_SKY_DROP'), null], deps)
    expect(out2.actions[0].cancelledBy).toBeNull()
    expect(out2.actions[0].targetDamage).toBe(42) // 42 Flying damage
    expect(state.battlers[1]!.mon.hp).toBe(58) // 100 - 42 = 58
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // no extra PP spent on turn 2
    expect(state.battlers[0]!.statuses3 & STATUS3_ON_AIR).toBe(0) // user no longer on air
    expect(state.battlers[1]!.statuses3 & STATUS3_ON_AIR).toBe(0) // target no longer on air
    expect(state.battlers[1]!.volatiles.skyDropped).toBe(false)
  })

  it('negative: target already skyDropped causes turn 1 to fail', () => {
    const userMon = monFor('SPECIES_PIDGEOT', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_SKY_DROP', null, null, null],
      pp: [10, 0, 0, 0],
    })
    const foeMon = monFor('SPECIES_MUDKIP', { rawStats: { ...SLOW_STATS } })
    const rng = scriptedRng([0])
    const state = battle(userMon, foeMon, rng)
    state.battlers[1]!.volatiles.skyDropped = true // already skyDropped
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    const out = executeTurn(state, [useMove(1, 'MOVE_SKY_DROP'), null], deps)
    expect(out.actions[0].targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.status2 & STATUS2_MULTIPLETURNS).toBe(0) // did not charge
    expect(state.battlers[0]!.statuses3 & STATUS3_ON_AIR).toBe(0)
  })

  it('negative: user faints or switches out before turn 2 -> shouldClearSkyDrop set and ENDTURN_SKY_DROP clears skyDropped', () => {
    const userMon = monFor('SPECIES_PIDGEOT', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_SKY_DROP', null, null, null],
      pp: [10, 0, 0, 0],
    })
    const foeMon = monFor('SPECIES_MUDKIP', { rawStats: { ...SLOW_STATS } })
    const rng = scriptedRng([0])
    const state = battle(userMon, foeMon, rng, {
      playerParty: [
        {
          speciesId: 'SPECIES_PIDGEOT',
          hp: 100,
          maxHp: 100,
          level: 50,
          moves: ['MOVE_SKY_DROP', null, null, null],
          pp: [10, 0, 0, 0],
          itemId: null,
          abilities: freshAbilities(),
          rawStats: { ...FAST_STATS },
          nature: 'NATURE_HARDY',
          hiddenPowerType: null,
          speedDown: false,
          gender: 'MALE',
          status1: 0,
          types: ['NORMAL', 'FLYING', 'MYSTERY'],
        },
        {
          speciesId: 'SPECIES_PIKACHU',
          hp: 100,
          maxHp: 100,
          level: 50,
          moves: ['MOVE_THUNDERBOLT', null, null, null],
          pp: [15, 0, 0, 0],
          itemId: null,
          abilities: freshAbilities(),
          rawStats: { ...FAST_STATS },
          nature: 'NATURE_HARDY',
          hiddenPowerType: null,
          speedDown: false,
          gender: 'MALE',
          status1: 0,
          types: ['ELECTRIC', 'MYSTERY', 'MYSTERY'],
        },
      ],
    })
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    // Turn 1: user lifts target
    executeTurn(state, [useMove(1, 'MOVE_SKY_DROP'), null], deps)
    expect(state.battlers[1]!.volatiles.skyDropped).toBe(true)

    // User switches out -> cancelMultiTurnMoves sets shouldClearSkyDrop
    performSwitchAction(state, 0, deps, { forcedPartyIndex: 1, ignoreEscapePrevention: true })
    expect(state.battlers[1]!.volatiles.shouldClearSkyDrop).toBe(true)

    // End-of-turn runs ENDTURN_SKY_DROP, clearing skyDropped and shouldClearSkyDrop
    // We execute a blank turn to let end-turn run
    executeTurn(state, [null, null], deps)
    expect(state.battlers[1]!.volatiles.skyDropped).toBe(false)
    expect(state.battlers[1]!.volatiles.shouldClearSkyDrop).toBe(false)
  })

  it('negative: target no longer skyDropped causes turn 2 clear step to deal no damage', () => {
    const userMon = monFor('SPECIES_PIDGEOT', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_SKY_DROP', null, null, null],
      pp: [10, 0, 0, 0],
    })
    const foeMon = monFor('SPECIES_MUDKIP', { rawStats: { ...SLOW_STATS } })
    const rng = scriptedRng([0])
    const state = battle(userMon, foeMon, rng)
    const deps = loopDeps(state, bridgeDamage(state, state.rng))

    // Turn 1: user lifts target
    executeTurn(state, [useMove(1, 'MOVE_SKY_DROP'), null], deps)
    expect(state.battlers[1]!.volatiles.skyDropped).toBe(true)

    // Target is freed before turn 2 (e.g. by Roar, switch, or external trigger)
    state.battlers[1]!.volatiles.skyDropped = false

    // Turn 2: user attempts to drop target, but clearskydrop fails -> no damage
    const out2 = executeTurn(state, [useMove(1, 'MOVE_SKY_DROP'), null], deps)
    expect(out2.actions[0].targetDamage).toBeNull()
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })

  it('Seismic Toss: deals exactly the user level (50) to neutral and resisting targets', () => {
    // Level 50 user Seismic Toss (effect EFFECT_SKY_DROP, fixed damage = level 50)
    const userMon = monFor('SPECIES_PIDGEOT', {
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_SEISMIC_TOSS', null, null, null],
      pp: [10, 0, 0, 0],
      level: 50,
    })
    // Mudkip is neutral to Fighting (Water/Ground).
    const neutralFoe = monFor('SPECIES_MUDKIP', { rawStats: { ...SLOW_STATS }, hp: 100, maxHp: 100 })
    // Ekans resists Fighting (Poison).
    const resistFoe = monFor('SPECIES_EKANS', { rawStats: { ...SLOW_STATS }, hp: 100, maxHp: 100 })

    // Test 1: neutral foe
    const rng1 = scriptedRng([0])
    const state1 = battle(userMon, neutralFoe, rng1)
    const deps1 = loopDeps(state1, bridgeDamage(state1, state1.rng))
    executeTurn(state1, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps1)
    const outNeutral = executeTurn(state1, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps1)
    expect(outNeutral.actions[0].targetDamage).toBe(50) // exactly level 50
    expect(state1.battlers[1]!.mon.hp).toBe(50)

    // Test 2: resisting foe (Poison resists Fighting)
    const rng2 = scriptedRng([0])
    const state2 = battle(userMon, resistFoe, rng2)
    const deps2 = loopDeps(state2, bridgeDamage(state2, state2.rng))
    executeTurn(state2, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps2)
    const outResist = executeTurn(state2, [useMove(1, 'MOVE_SEISMIC_TOSS'), null], deps2)
    expect(outResist.actions[0].targetDamage).toBe(50) // exactly level 50, resistance ignored
    expect(state2.battlers[1]!.mon.hp).toBe(50)
  })
})
