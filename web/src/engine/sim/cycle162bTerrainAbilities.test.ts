/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { getSingleUseAbilityCounter } from './switchInAbility'
import { setFieldTerrain } from './moveEffects'
import { getHighestAttackingStatId } from './statBuffs'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_TAILWIND,
  STAT_ATK,
  STAT_SPATK,
  STATUS3_CHARGED_UP,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  TAILWIND_DURATION_SHORT,
  hasFlag,
} from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle150dInventory.test.ts (first 130 lines) and its Air Lock
// describe block.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<Record<string, unknown>>('types.json')
const inverseTypeChart = snapshot<Record<string, unknown>>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors

/** Moves are stripped exactly as the production loader does (`loadSimData.ts:188`
 * `String(m.type).replace('TYPE_', '')`), so a `'TYPE_NORMAL'`-shaped fixture cannot hide a
 * dead `moveData.type === 'NORMAL'` branch. */
function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type ? String(m.type).replace('TYPE_', '') : null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id,
    resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as SimItemData['naturalGift']) ?? null,
    grouping: (it.grouping as string | null) ?? null,
  }
}

function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id,
    baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0,
    formOf: (s.formOf as string | null | undefined) ?? null,
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
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
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
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

type BattlerSpec = {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  level?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource = scriptedRng([0])): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 300,
          maxHp: s.maxHp ?? 300,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? 0
      idx++
      return val
    },
  }
  return r
}

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : 'NORMAL',
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(damage: DamageResolver = fixedDamage(20), grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const hasAbility = (
  ability: string | null,
  innates: [string | null, string | null, string | null] = [null, null, null],
): SimBattleMon['abilities'] => ({ ability, innates })

// `useMove`/`move` are part of the copied scaffolding; keep them referenced so tsc's
// noUnusedLocals is satisfied without inventing a fake move use in these ability tests.
void useMove
void move


// ---------------------------------------------------------------------------
// Cycle 162b: Harukaze / Generator / Energized onTerrain hooks
// ---------------------------------------------------------------------------

describe('Cycle 162b - Harukaze onTerrain sets short Tailwind', () => {
  it('Grassy Terrain set by the Harukaze holder: Tailwind up, partner Wind Rider gains Atk and loses switch-in', () => {
    // Impl<ABILITY_HARUKAZE>.onTerrain, src/abilities.cc:10101-10118: the terrainBattlerId check
    // is :10104, the Tailwind write :10107-10110, the two DisableSwitchInAbility calls :10112-10113.
    const state = battle([
      { abilities: hasAbility('ABILITY_HARUKAZE') },
      {},
      { abilities: hasAbility('ABILITY_WIND_RIDER'), atk: 100, spatk: 80 },
      {},
    ])
    const unmodelled: string[] = []
    expect(setFieldTerrain(state, 0, STATUS_FIELD_GRASSY_TERRAIN, testDeps(), unmodelled)).toBe(true)

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(TAILWIND_DURATION_SHORT)
    expect(state.sides[0]!.timers.tailwindBattlerId).toBe(0)

    // BattleScript_HarukazeTailwind (data/battle_scripts_1.s:9261-9265) calls
    // BattleScript_OnTailwindStart (:9267-9272) with BS_ATTACKER the walked battler and
    // BS_ATTACKER_PARTNER `battler ^ 2`; DoWindRider (:9273-9283) raises the highest attacking
    // stat by 1. Compute the stat from the real raw stats rather than assuming Atk.
    expect(getHighestAttackingStatId(state, 2, RATIOS)).toBe(STAT_ATK)
    expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[2]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)

    // DisableSwitchInAbility(BATTLE_PARTNER(battler), ABILITY_WIND_RIDER), :10113.
    expect(state.battlers[2]!.volatiles.switchInAbilityDone[0]).toBe(true)

    // Every onTerrain hook is modelled now, so the old note is gone.
    expect(unmodelled.filter((n) => n.includes('onTerrain'))).toEqual([])
  })

  it('Wind Rider in an innate slot of the holder itself also fires', () => {
    const state = battle([
      { abilities: hasAbility('ABILITY_HARUKAZE', ['ABILITY_WIND_RIDER', null, null]), atk: 100, spatk: 80 },
      {},
    ])
    setFieldTerrain(state, 0, STATUS_FIELD_GRASSY_TERRAIN, testDeps(), [])

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    // DisableSwitchInAbility(battler, ABILITY_WIND_RIDER), :10112: its index is the innate slot 1.
    expect(state.battlers[0]!.volatiles.switchInAbilityDone[1]).toBe(true)
  })

  it('negative: terrain set by the opponent (terrainBattlerId != holder) gives no Tailwind', () => {
    const state = battle([
      { abilities: hasAbility('ABILITY_HARUKAZE') },
      {},
      { abilities: hasAbility('ABILITY_WIND_RIDER') },
      {},
    ])
    // The opponent's move sets the terrain, so gFieldTimers.terrainBattlerId is 1, not 0 (:10104).
    setFieldTerrain(state, 1, STATUS_FIELD_GRASSY_TERRAIN, testDeps(), [])

    expect(state.field.timers.terrainBattlerId).toBe(1)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(false)
    expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('negative: Tailwind already on that side leaves timer and battlerId unchanged', () => {
    // CHECK_NOT(gSideStatuses[side] & SIDE_STATUS_TAILWIND), :10105.
    const state = battle([{ abilities: hasAbility('ABILITY_HARUKAZE') }, {}])
    state.sides[0]!.statuses |= SIDE_STATUS_TAILWIND
    state.sides[0]!.timers.tailwindTimer = 2
    state.sides[0]!.timers.tailwindBattlerId = 1

    setFieldTerrain(state, 0, STATUS_FIELD_GRASSY_TERRAIN, testDeps(), [])

    expect(state.sides[0]!.timers.tailwindTimer).toBe(2)
    expect(state.sides[0]!.timers.tailwindBattlerId).toBe(1)
  })

  it('negative: Electric Terrain instead of Grassy leaves Tailwind unset', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_HARUKAZE') }, {}])
    setFieldTerrain(state, 0, STATUS_FIELD_ELECTRIC_TERRAIN, testDeps(), [])

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(false)
  })
})

describe('Cycle 162b - Generator / Energized onTerrain sets STATUS3_CHARGED_UP', () => {
  it('Electric Terrain charges an uncharged Generator holder without touching the single-use counter', () => {
    // Impl<ABILITY_GENERATOR>.onTerrain, src/abilities.cc:6192-6199 -> BattleScript_GeneratorActivatesRet
    // (data/battle_scripts_1.s:6245-6253) -> setcharge (src/battle_script_commands.c:11620-11623).
    const state = battle([{ abilities: hasAbility('ABILITY_GENERATOR') }, {}])
    const deps = testDeps()
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_GENERATOR', deps.dataContext)).toBe(0)
    const unmodelled: string[] = []

    setFieldTerrain(state, 0, STATUS_FIELD_ELECTRIC_TERRAIN, deps, unmodelled)

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
    // Unlike onEntry (abilities.cc:6174-6190), the onTerrain hook never writes the counter.
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_GENERATOR', deps.dataContext)).toBe(0)
    expect(unmodelled.filter((n) => n.includes('onTerrain'))).toEqual([])
  })

  it('already charged: CHECK_NOT(STATUS3_CHARGED_UP) leaves it charged and the counter untouched', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_GENERATOR') }, {}])
    state.battlers[0]!.statuses3 |= STATUS3_CHARGED_UP
    const deps = testDeps()

    setFieldTerrain(state, 0, STATUS_FIELD_ELECTRIC_TERRAIN, deps, [])

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_GENERATOR', deps.dataContext)).toBe(0)
  })

  it('negative: Grassy Terrain does not charge Generator', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_GENERATOR') }, {}])
    setFieldTerrain(state, 0, STATUS_FIELD_GRASSY_TERRAIN, testDeps(), [])

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(false)
  })

  it('fires from an innate slot, not only the main ability', () => {
    const state = battle([{ abilities: hasAbility(null, ['ABILITY_GENERATOR', null, null]) }, {}])
    setFieldTerrain(state, 0, STATUS_FIELD_ELECTRIC_TERRAIN, testDeps(), [])

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
  })

  it('Energized aliases Generator onTerrain (:8723)', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_ENERGIZED') }, {}])
    const deps = testDeps()

    setFieldTerrain(state, 0, STATUS_FIELD_ELECTRIC_TERRAIN, deps, [])

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
    expect(getSingleUseAbilityCounter(state, 0, 'ABILITY_ENERGIZED', deps.dataContext)).toBe(0)
  })
})
