// Unit and integration tests for absorb abilities' side effects (cycle 39).
//
// Hand-derived from upstream C source code at pinned SHA:
// - ABILITYEFFECT_ABSORBING (src/battle_util.c:4422-4484)
// - TestAbsorbingAbilities (src/battle_util.c:8935-8942)
// - JumpIfMoveFailed (src/battle_script_commands.c:1212-1228)
// - Cmd_accuracycheck (src/battle_script_commands.c:1398-1447)
// - CanBattlerHeal (src/battle_util.c:8979-8986)
// - CanRaiseStat (src/battle_util.c:9364)
// - GetHighestAttackingStatId (src/battle_util.c:8748-8767)
// - ChangeStatBuffs (src/battle_script_commands.c:9713-9946)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  SIDE_STATUS_MIST,
  STATUS1_NONE,
  STATUS3_HEAL_BLOCK,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPEED,
  hasFlag,
} from './constants'
import { applyAbsorbEffect } from './absorb'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'

// ---------------------------------------------------------------------------
// Verbatim Fixture Block from moveEnd.test.ts / damageResolver.test.ts
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const movesById = new Map(snapshot<Array<Record<string, unknown>>>('moves.json').map((m) => [m.id as string, m]))
const itemsById = new Map(snapshot<Array<SimItemData>>('items.json').map((item) => [item.id, item]))
const speciesById = new Map(snapshot<Array<Record<string, unknown>>>('species.json').map((s) => [s.id as string, s]))
const natures = snapshot<any>('natures.json')
const moveBehaviors = snapshot<any>('moveBehaviors.json').behaviors
const chart = Object.fromEntries(Object.entries(snapshot<Record<string, Record<string, number>>>('types.json')).map(([k, v]) => [k, v]))
const inverseChart = Object.fromEntries(Object.entries(snapshot<Record<string, Record<string, number>>>('typesInverse.json')).map(([k, v]) => [k, v]))

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    sheerForceBoost: m.sheerForceBoost as true | undefined,
  }
}

function toMoveData(id: string): any {
  const move = movesById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id,
    power: move.power,
    type: String(move.type).replace('TYPE_', ''),
    type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split,
    effectChance: move.effectChance,
    splitFlag: move.splitFlag,
    effect: move.effect,
    customBehavior: move.customBehavior,
    crit: move.crit,
    flags: (move.flags as Record<string, true>) ?? {},
    priority: move.priority,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: arg?.kind === 'misc' ? arg.value : null,
    multiHitArgument: arg?.kind === 'int' ? arg.value : null,
  }
}

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: (id) => speciesById.get(id) as any,
  item: (id) => itemsById.get(id),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: STATUS1_NONE,
    status2: 0,
    ...overrides,
  }
}

function battle(
  specs: {
    spe?: number
    atk?: number
    spatk?: number
    hp?: number
    maxHp?: number
    itemId?: string | null
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: [number, number, number, number]
    types?: SimBattleMon['types']
    statStages?: number[]
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: s.spatk ?? 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          itemId: s.itemId ?? null,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ?? [35, 0, 0, 0],
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
          statStages: s.statStages ?? [],
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(rolls: number[] = []): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      if (idx < rolls.length) {
        return rolls[idx++]!
      }
      return 0
    },
  }
  return r
}

function makeMoveAction(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: move.priority ?? 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ? String(move.type).replace('TYPE_', '') : 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function buildTestTurnDeps(rng: RandomSource): TurnLoopDeps {
  const bridgeResolverDeps: BridgeDamageResolverDeps = {
    grounding: GROUNDING,
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
    moveData: (id) => toMoveData(id),
    typeChart: chart,
    inverseTypeChart: inverseChart,
    moveBehaviors,
    battleConstants: natures,
    random: rng,
  }
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage: createBridgeDamageResolver(bridgeResolverDeps),
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
  }
}

// ---------------------------------------------------------------------------
// Unit tests: applyAbsorbEffect
// ---------------------------------------------------------------------------

describe('applyAbsorbEffect: heal absorb abilities', () => {
  it('Water Absorb heals 1/4 max HP (25 HP on 100 max HP) when damaged', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 50, maxHp: 100 }], rng)
    const unmodelled: string[] = []

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_WATER_ABSORB',
      moveId: 'MOVE_WATER_GUN',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled,
    })

    // Math.floor(100 / 4) = 25. 50 + 25 = 75.
    expect(outcome.healed).toBe(25)
    expect(state.battlers[1]!.mon.hp).toBe(75)
  })

  it('Water Absorb heals at least 1 HP if maxHP < 4', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 1, maxHp: 3 }], rng)
    const unmodelled: string[] = []

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_WATER_ABSORB',
      moveId: 'MOVE_WATER_GUN',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled,
    })

    // Math.max(1, Math.floor(3 / 4)) = 1. 1 + 1 = 2.
    expect(outcome.healed).toBe(1)
    expect(state.battlers[1]!.mon.hp).toBe(2)
  })

  it('Water Absorb does not heal when already at full HP (!BATTLER_MAX_HP)', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100, maxHp: 100 }], rng)
    const unmodelled: string[] = []

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_WATER_ABSORB',
      moveId: 'MOVE_WATER_GUN',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled,
    })

    expect(outcome.healed).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })

  it('Water Absorb does not heal under Heal Block (CanBattlerHeal)', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 50, maxHp: 100 }], rng)
    state.battlers[1]!.statuses3 |= STATUS3_HEAL_BLOCK
    const unmodelled: string[] = []

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_WATER_ABSORB',
      moveId: 'MOVE_WATER_GUN',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled,
    })

    expect(outcome.healed).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(50)
  })

  it('Volt Absorb, Dry Skin, Poison Absorb, Earth Eater, Fire Aspect heal 1/4 max HP', () => {
    const healAbilities = [
      { ability: 'ABILITY_VOLT_ABSORB', move: 'MOVE_THUNDERBOLT' },
      { ability: 'ABILITY_DRY_SKIN', move: 'MOVE_WATER_GUN' },
      { ability: 'ABILITY_POISON_ABSORB', move: 'MOVE_SLUDGE_BOMB' },
      { ability: 'ABILITY_EARTH_EATER', move: 'MOVE_EARTHQUAKE' },
      { ability: 'ABILITY_FIRE_ASPECT', move: 'MOVE_FLAMETHROWER' },
    ]

    for (const { ability, move } of healAbilities) {
      const rng = scriptedRng([])
      const state = battle([{ hp: 100 }, { hp: 60, maxHp: 100 }], rng)
      const outcome = applyAbsorbEffect({
        state,
        attackerId: 0,
        targetId: 1,
        absorbingAbility: ability,
        moveId: move,
        deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
        unmodelled: [],
      })
      expect(outcome.healed).toBe(25)
      expect(state.battlers[1]!.mon.hp).toBe(85)
    }
  })
})

describe('applyAbsorbEffect: stat absorb abilities', () => {
  it('Sap Sipper raises Attack by +1 stage when Attack > SpAtk', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100, atk: 120, spatk: 80 }], rng)
    const unmodelled: string[] = []

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_SAP_SIPPER',
      moveId: 'MOVE_ENERGY_BALL',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled,
    })

    expect(outcome.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: 1 }])
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('Sap Sipper raises SpAtk by +1 stage when SpAtk > Attack', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100, atk: 80, spatk: 120 }], rng)
    const unmodelled: string[] = []

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_SAP_SIPPER',
      moveId: 'MOVE_ENERGY_BALL',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled,
    })

    expect(outcome.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: 1 }])
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('Sap Sipper does not raise stat if already at MAX_STAT_STAGE (12)', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100, atk: 120, spatk: 80 }], rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    const unmodelled: string[] = []

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_SAP_SIPPER',
      moveId: 'MOVE_ENERGY_BALL',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled,
    })

    expect(outcome.statChanges).toEqual([])
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
  })

  it('Lightning Rod, Storm Drain, Justified, Ice Dew, Wind Rider, Heat Sink, Lightning Aspect raise highest attacking stat by +1', () => {
    const abilities = [
      { ability: 'ABILITY_LIGHTNING_ROD', move: 'MOVE_THUNDERBOLT' },
      { ability: 'ABILITY_STORM_DRAIN', move: 'MOVE_WATER_GUN' },
      { ability: 'ABILITY_JUSTIFIED', move: 'MOVE_BITE' },
      { ability: 'ABILITY_ICE_DEW', move: 'MOVE_ICE_BEAM' },
      { ability: 'ABILITY_WIND_RIDER', move: 'MOVE_AIR_SLASH' },
      { ability: 'ABILITY_HEAT_SINK', move: 'MOVE_FLAMETHROWER' },
      { ability: 'ABILITY_LIGHTNING_ASPECT', move: 'MOVE_THUNDERBOLT' },
    ]

    for (const { ability, move } of abilities) {
      const rng = scriptedRng([])
      const state = battle([{ hp: 100 }, { hp: 100, atk: 70, spatk: 110 }], rng)
      const outcome = applyAbsorbEffect({
        state,
        attackerId: 0,
        targetId: 1,
        absorbingAbility: ability,
        moveId: move,
        deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
        unmodelled: [],
      })
      expect(outcome.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: 1 }])
      expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    }
  })

  it('Motor Drive and Aerodynamics raise Speed by +1 stage', () => {
    const abilities = [
      { ability: 'ABILITY_MOTOR_DRIVE', move: 'MOVE_THUNDERBOLT' },
      { ability: 'ABILITY_AERODYNAMICS', move: 'MOVE_AIR_SLASH' },
    ]

    for (const { ability, move } of abilities) {
      const rng = scriptedRng([])
      const state = battle([{ hp: 100 }, { hp: 100 }], rng)
      const outcome = applyAbsorbEffect({
        state,
        attackerId: 0,
        targetId: 1,
        absorbingAbility: ability,
        moveId: move,
        deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
        unmodelled: [],
      })
      expect(outcome.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: 1 }])
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    }
  })

  it('Well-Baked Body raises Defense by +2 stages (absorbUp2)', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100 }], rng)
    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_WELL_BAKED_BODY',
      moveId: 'MOVE_FLAMETHROWER',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled: [],
    })
    expect(outcome.statChanges).toEqual([{ battlerId: 1, stat: STAT_DEF, change: 2 }])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('Molten Core raises Speed by +2 stages (absorbUp2)', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100 }], rng)
    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_MOLTEN_CORE',
      moveId: 'MOVE_ROCK_SLIDE',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled: [],
    })
    expect(outcome.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPEED, change: 2 }])
    expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
  })
})

describe('applyAbsorbEffect: Flash Fire, Evaporate, and dual abilities', () => {
  it('Flash Fire activates volatiles.flashFire flag', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100 }], rng)
    expect(state.battlers[1]!.volatiles.flashFire).toBe(false)

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_FLASH_FIRE',
      moveId: 'MOVE_FLAMETHROWER',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled: [],
    })

    expect(outcome.flashFireActivated).toBe(true)
    expect(state.battlers[1]!.volatiles.flashFire).toBe(true)
  })

  it('Evaporate activates Mist on target side with mistTimer = 5', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100 }], rng)
    const side = 1 & 1 // side 1
    expect(hasFlag(state.sides[side].statuses, SIDE_STATUS_MIST)).toBe(false)
    expect(state.sides[side].timers.mistTimer).toBe(0)

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_EVAPORATE',
      moveId: 'MOVE_WATER_GUN',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled: [],
    })

    expect(outcome.mistActivated).toBe(true)
    expect(hasFlag(state.sides[side].statuses, SIDE_STATUS_MIST)).toBe(true)
    expect(state.sides[side].timers.mistTimer).toBe(5)
    expect(state.sides[side].timers.started.mist).toBe(true)
  })

  it('Evaporate does not re-apply Mist if mistTimer is already nonzero', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 100 }], rng)
    const side = 1 & 1
    state.sides[side].timers.mistTimer = 3

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_EVAPORATE',
      moveId: 'MOVE_WATER_GUN',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled: [],
    })

    expect(outcome.mistActivated).toBe(false)
    expect(state.sides[side].timers.mistTimer).toBe(3)
  })

  it('Reservoir heals 1/4 max HP AND boosts highest attacking stat', () => {
    const rng = scriptedRng([])
    const state = battle([{ hp: 100 }, { hp: 50, maxHp: 100, atk: 120, spatk: 80 }], rng)

    const outcome = applyAbsorbEffect({
      state,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_RESERVOIR',
      moveId: 'MOVE_WATER_GUN',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled: [],
    })

    expect(outcome.healed).toBe(25)
    expect(state.battlers[1]!.mon.hp).toBe(75)
    expect(outcome.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: 1 }])
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('Elemental Vortex heals on Water move and sets Flash Fire on Fire move', () => {
    // Water move: heal
    const rng1 = scriptedRng([])
    const state1 = battle([{ hp: 100 }, { hp: 50, maxHp: 100 }], rng1)
    const outcomeWater = applyAbsorbEffect({
      state: state1,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_ELEMENTAL_VORTEX',
      moveId: 'MOVE_WATER_GUN',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled: [],
    })
    expect(outcomeWater.healed).toBe(25)
    expect(state1.battlers[1]!.mon.hp).toBe(75)
    expect(outcomeWater.flashFireActivated).toBe(false)
    expect(state1.battlers[1]!.volatiles.flashFire).toBe(false)

    // Fire move: Flash Fire flag
    const rng2 = scriptedRng([])
    const state2 = battle([{ hp: 100 }, { hp: 50, maxHp: 100 }], rng2)
    const outcomeFire = applyAbsorbEffect({
      state: state2,
      attackerId: 0,
      targetId: 1,
      absorbingAbility: 'ABILITY_ELEMENTAL_VORTEX',
      moveId: 'MOVE_FLAMETHROWER',
      deps: { statStageRatios: RATIOS, dataContext: DATA_CONTEXT },
      unmodelled: [],
    })
    expect(outcomeFire.healed).toBe(0)
    expect(state2.battlers[1]!.mon.hp).toBe(50)
    expect(outcomeFire.flashFireActivated).toBe(true)
    expect(state2.battlers[1]!.volatiles.flashFire).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Integration tests: executeTurn with full damage resolver pipeline
// ---------------------------------------------------------------------------

describe('executeTurn integration: absorbed hit mechanics', () => {
  it('damaging move against Water Absorb deals 0 damage, deducts PP, and heals target', () => {
    const moveWaterGun = requireMove('MOVE_WATER_GUN')
    const rng = scriptedRng([0, 0, 0]) // accuracy roll hits
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_WATER_GUN', null, null, null], pp: [35, 0, 0, 0] },
        { spe: 50, hp: 50, maxHp: 100, abilities: { ability: 'ABILITY_WATER_ABSORB', innates: [null, null, null] } },
      ],
      rng,
    )
    const deps = buildTestTurnDeps(rng)

    const turnOutcome = executeTurn(state, [makeMoveAction(1, moveWaterGun), null], deps)

    const action = turnOutcome.actions.find((a) => a.battlerId === 0)!
    expect(action.battlerId).toBe(0)
    expect(action.targetDamage).toBe(0)
    expect(action.missed).toBe(false)

    // Target healed from 50 to 75
    expect(state.battlers[1]!.mon.hp).toBe(75)
    // Attacker lost 1 PP
    expect(state.battlers[0]!.mon.pp[0]).toBe(34)
    // Attacker lastMove is updated
    expect(state.battlers[0]!.lastMove).toBe('MOVE_WATER_GUN')
  })

  it('Water Absorb at full HP deals 0 damage and target HP remains full', () => {
    const moveWaterGun = requireMove('MOVE_WATER_GUN')
    const rng = scriptedRng([0, 0, 0])
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_WATER_GUN', null, null, null], pp: [35, 0, 0, 0] },
        { spe: 50, hp: 100, maxHp: 100, abilities: { ability: 'ABILITY_WATER_ABSORB', innates: [null, null, null] } },
      ],
      rng,
    )
    const deps = buildTestTurnDeps(rng)

    const turnOutcome = executeTurn(state, [makeMoveAction(1, moveWaterGun), null], deps)

    expect(turnOutcome.actions[0]!.targetDamage).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.pp[0]).toBe(34)
  })

  it('absorbed hit applies NO secondary status effects (Flamethrower vs Flash Fire)', () => {
    // MOVE_FLAMETHROWER has secondary burn chance.
    // Absorbed hit jumps to BattleScript_MoveEnd, skipping seteffectwithchance completely.
    const moveFlamethrower = requireMove('MOVE_FLAMETHROWER')
    const rng = scriptedRng([0, 0, 0, 0]) // accuracy roll hits
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_FLAMETHROWER', null, null, null], pp: [15, 0, 0, 0] },
        { spe: 50, hp: 100, maxHp: 100, abilities: { ability: 'ABILITY_FLASH_FIRE', innates: [null, null, null] } },
      ],
      rng,
    )
    const deps = buildTestTurnDeps(rng)

    const turnOutcome = executeTurn(state, [makeMoveAction(1, moveFlamethrower), null], deps)

    const action = turnOutcome.actions[0]!
    expect(action.targetDamage).toBe(0)
    expect(action.statusApplied).toBeNull()
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_NONE)
    expect(state.battlers[1]!.volatiles.flashFire).toBe(true)
  })

  it('Flash Fire flag activates 1.5x damage boost for subsequent Fire moves', () => {
    const moveFlamethrower = requireMove('MOVE_FLAMETHROWER')

    // Scenario A: Battler 0 uses Flamethrower WITHOUT Flash Fire boost
    const rngA = scriptedRng([0, 0, 0, 0, 0])
    const stateA = battle(
      [
        { spe: 100, atk: 100, spatk: 100, types: ['FIRE', 'MYSTERY', 'MYSTERY'], abilities: { ability: 'ABILITY_FLASH_FIRE', innates: [null, null, null] }, moves: ['MOVE_FLAMETHROWER', null, null, null] },
        { spe: 50, hp: 200, maxHp: 200, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
      ],
      rngA,
    )
    const depsA = buildTestTurnDeps(rngA)
    const outcomeA = executeTurn(stateA, [makeMoveAction(1, moveFlamethrower), null], depsA)
    const unboostedDamage = outcomeA.actions[0]!.targetDamage!
    expect(unboostedDamage).toBeGreaterThan(0)

    // Scenario B: Battler 0 WITH Flash Fire volatile set uses Flamethrower
    const rngB = scriptedRng([0, 0, 0, 0, 0])
    const stateB = battle(
      [
        { spe: 100, atk: 100, spatk: 100, types: ['FIRE', 'MYSTERY', 'MYSTERY'], abilities: { ability: 'ABILITY_FLASH_FIRE', innates: [null, null, null] }, moves: ['MOVE_FLAMETHROWER', null, null, null] },
        { spe: 50, hp: 200, maxHp: 200, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
      ],
      rngB,
    )
    stateB.battlers[0]!.volatiles.flashFire = true
    const depsB = buildTestTurnDeps(rngB)
    const outcomeB = executeTurn(stateB, [makeMoveAction(1, moveFlamethrower), null], depsB)
    const boostedDamage = outcomeB.actions[0]!.targetDamage!

    // In Elite Redux / gen3, Flash Fire boost is 1.5x (UQ4.12 6144 / 4096 = 1.5x)
    const ratio = boostedDamage / unboostedDamage
    expect(ratio).toBeCloseTo(1.5, 1)
  })

  it('Mold Breaker ignores breakable Water Absorb and deals full damage', () => {
    const moveWaterGun = requireMove('MOVE_WATER_GUN')
    const rng = scriptedRng([0, 0, 0, 0, 0])
    const state = battle(
      [
        { spe: 100, abilities: { ability: 'ABILITY_MOLD_BREAKER', innates: [null, null, null] }, moves: ['MOVE_WATER_GUN', null, null, null] },
        { spe: 50, hp: 100, maxHp: 100, abilities: { ability: 'ABILITY_WATER_ABSORB', innates: [null, null, null] } },
      ],
      rng,
    )
    const deps = buildTestTurnDeps(rng)

    const turnOutcome = executeTurn(state, [makeMoveAction(1, moveWaterGun), null], deps)

    const action = turnOutcome.actions[0]!
    // Mold Breaker pierces Water Absorb: damage is dealt, target does not heal!
    expect(action.targetDamage).toBeGreaterThan(0)
    expect(state.battlers[1]!.mon.hp).toBeLessThan(100)
  })

  it('Mold Breaker CANNOT ignore unbreakable Justified, which still absorbs Dark move', () => {
    const moveBite = requireMove('MOVE_BITE')
    const rng = scriptedRng([0, 0, 0, 0, 0])
    const state = battle(
      [
        { spe: 100, abilities: { ability: 'ABILITY_MOLD_BREAKER', innates: [null, null, null] }, moves: ['MOVE_BITE', null, null, null] },
        { spe: 50, hp: 100, maxHp: 100, atk: 120, spatk: 80, abilities: { ability: 'ABILITY_JUSTIFIED', innates: [null, null, null] } },
      ],
      rng,
    )
    const deps = buildTestTurnDeps(rng)

    const turnOutcome = executeTurn(state, [makeMoveAction(1, moveBite), null], deps)

    const action = turnOutcome.actions[0]!
    // Justified is unbreakable: 0 damage dealt, highest attacking stat raised!
    expect(action.targetDamage).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(action.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: 1 }])
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
  })
})
