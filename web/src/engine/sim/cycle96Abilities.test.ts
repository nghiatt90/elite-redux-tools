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
import { executeTurn } from './turn'
import { dispatchMoveEndAttackerAbilities, dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { applySwitchInAbilities } from './switchInAbility'
import { dispatchOnWeatherChange } from './onWeather'
import { STATUS2_TRANSFORMED, WEATHER_NONE, WEATHER_RAIN_TEMPORARY, WEATHER_SUN_TEMPORARY } from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the same snapshot-backed shape cycle95Abilities.test.ts uses.
// Unlike that file, `species` resolves real records: Forecast / Flower Gift /
// Schooling all route through changeBattlerForm, which is a no-op for a species
// the dataContext does not know.
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

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 as string | null,
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
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
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
    resolvedType: moveData.type ?? 'NORMAL',
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
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })
const notModelled = (notes: string[], ability: string) => notes.filter((n) => n.includes(ability))

/** One turn: battler 0 uses `moveId` on battler 1 for a fixed amount of damage. */
function runMove(holder: BattlerSpec, target: BattlerSpec, moveId = 'MOVE_TACKLE', dmg = 20, rolls: number[] = [0, 0]) {
  const state = battle([{ moves: slot(moveId), pp: pps, ...holder }, target], scriptedRng(rolls))
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(dmg)))
  return { state, out, action: out.actions[0]! }
}

/** The move-end attacker dispatch alone, for states a real turn would not reach. */
function dispatchAttacker(state: BattleState, moveId: string, targetDamage = 20) {
  const unmodelled: string[] = []
  const res = dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

/** The move-end defender dispatch alone. */
function dispatchDefender(state: BattleState, moveId: string, targetDamage = 20) {
  const unmodelled: string[] = []
  const res = dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

/** No actions: the turn loop's end-of-turn phase alone. */
function runEndTurn(specs: BattlerSpec[], grounding: GroundingContext = GROUNDING) {
  const state = battle(specs, scriptedRng([0, 0, 0, 0]))
  const out = executeTurn(state, specs.map(() => null), testDeps(fixedDamage(0), grounding))
  return { state, out }
}

// maxHP at level 50 with 31 IVs / 0 EVs (src/pokemon.c's CalculateMonStatsMaster formula):
// Castform (base 75) -> 150, Cherrim (base 70) -> 145; Wishiwashi (base 45) at level 20 -> 54.
const CASTFORM_MAX_HP = 150
const CHERRIM_MAX_HP = 145
const WISHIWASHI_L20_MAX_HP = 54

describe('Cycle 96 - Forecast (battle_util.c:3812-3906; abilities.cc:1247-1250)', () => {
  const FORECAST = hasAbility('ABILITY_FORECAST')

  it('switch-in under rain becomes the Rainy form, and the scripted switch-in re-run terminates on the moved slot', () => {
    const state = battle([{ speciesId: 'SPECIES_CASTFORM', maxHp: CASTFORM_MAX_HP, hp: CASTFORM_MAX_HP, abilities: FORECAST }, {}], scriptedRng([0]))
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const unmodelled: string[] = []

    applySwitchInAbilities(state, 0, testDeps(), unmodelled)

    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_CASTFORM_RAINY')
    expect(state.battlers[0]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
    // changeBattlerForm repopulates abilities from the new species (RepopulateAbilities, battle_util.c:9281):
    // Forecast survives as innate 0, so the recursive `switchinabilities` pass finds it already done.
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_SWIFT_SWIM')
    expect(state.battlers[0]!.mon.abilities.innates[0]).toBe('ABILITY_FORECAST')
    expect(state.battlers[0]!.volatiles.switchInAbilityDone[1]).toBe(true)
    expect(notModelled(unmodelled, 'FORECAST')).toEqual([])
    expect(state.battlers[0]!.mon.maxHp).toBe(CASTFORM_MAX_HP)
    expect(state.battlers[0]!.mon.hp).toBe(CASTFORM_MAX_HP)
  })

  it('onWeather changes the form under rain, and leaves it alone under no weather', () => {
    const rainy = battle([{ speciesId: 'SPECIES_CASTFORM', maxHp: CASTFORM_MAX_HP, hp: CASTFORM_MAX_HP, abilities: FORECAST }, {}], scriptedRng([0]))
    rainy.field.weather = WEATHER_RAIN_TEMPORARY
    const notes: string[] = []
    dispatchOnWeatherChange(rainy, testDeps(), notes)
    expect(rainy.battlers[0]!.mon.speciesId).toBe('SPECIES_CASTFORM_RAINY')
    expect(notModelled(notes, 'FORECAST')).toEqual([])

    const clear = battle([{ speciesId: 'SPECIES_CASTFORM', maxHp: CASTFORM_MAX_HP, hp: CASTFORM_MAX_HP, abilities: FORECAST }, {}], scriptedRng([0]))
    const clearNotes: string[] = []
    dispatchOnWeatherChange(clear, testDeps(), clearNotes)
    expect(clear.battlers[0]!.mon.speciesId).toBe('SPECIES_CASTFORM')
    expect(clearNotes).toEqual([])
  })

  it('reverts a weather form to base Castform when the weather clears', () => {
    const state = battle(
      [
        {
          speciesId: 'SPECIES_CASTFORM_RAINY',
          maxHp: CASTFORM_MAX_HP,
          hp: CASTFORM_MAX_HP,
          types: ['WATER', 'MYSTERY', 'MYSTERY'],
          abilities: { ability: 'ABILITY_SWIFT_SWIM', innates: ['ABILITY_FORECAST', null, null] },
        },
        {},
      ],
      scriptedRng([0]),
    )
    expect(state.field.weather).toBe(WEATHER_NONE)

    dispatchOnWeatherChange(state, testDeps(), [])

    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_CASTFORM')
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })

  it('does nothing for a transformed or fainted Castform (the two guards at :3817-3818)', () => {
    const transformed = battle(
      [{ speciesId: 'SPECIES_CASTFORM', maxHp: CASTFORM_MAX_HP, hp: CASTFORM_MAX_HP, status2: STATUS2_TRANSFORMED, abilities: FORECAST }, {}],
      scriptedRng([0]),
    )
    transformed.field.weather = WEATHER_RAIN_TEMPORARY
    dispatchOnWeatherChange(transformed, testDeps(), [])
    expect(transformed.battlers[0]!.mon.speciesId).toBe('SPECIES_CASTFORM')

    const fainted = battle([{ speciesId: 'SPECIES_CASTFORM', maxHp: CASTFORM_MAX_HP, hp: 0, abilities: FORECAST }, {}], scriptedRng([0]))
    fainted.field.weather = WEATHER_RAIN_TEMPORARY
    dispatchOnWeatherChange(fainted, testDeps(), [])
    expect(fainted.battlers[0]!.mon.speciesId).toBe('SPECIES_CASTFORM')
  })
})

describe('Cycle 96 - Flower Gift (abilities.cc:1857-1860; battle_util.c:3885-3903)', () => {
  const FLOWER_GIFT = hasAbility('ABILITY_FLOWER_GIFT')

  it('turns Cherrim into Cherrim Sunshine in sun, on entry and on the weather change', () => {
    const entry = battle([{ speciesId: 'SPECIES_CHERRIM', maxHp: CHERRIM_MAX_HP, hp: CHERRIM_MAX_HP, abilities: FLOWER_GIFT }, {}], scriptedRng([0]))
    entry.field.weather = WEATHER_SUN_TEMPORARY
    applySwitchInAbilities(entry, 0, testDeps(), [])
    expect(entry.battlers[0]!.mon.speciesId).toBe('SPECIES_CHERRIM_SUNSHINE')
    expect(entry.battlers[0]!.mon.types).toEqual(['GRASS', 'FIRE', 'MYSTERY'])
    expect(entry.battlers[0]!.mon.abilities.innates[0]).toBe('ABILITY_FLOWER_GIFT')
    expect(entry.battlers[0]!.volatiles.switchInAbilityDone[1]).toBe(true)

    const weather = battle([{ speciesId: 'SPECIES_CHERRIM', maxHp: CHERRIM_MAX_HP, hp: CHERRIM_MAX_HP, abilities: FLOWER_GIFT }, {}], scriptedRng([0]))
    weather.field.weather = WEATHER_SUN_TEMPORARY
    dispatchOnWeatherChange(weather, testDeps(), [])
    expect(weather.battlers[0]!.mon.speciesId).toBe('SPECIES_CHERRIM_SUNSHINE')
  })

  it('reverts Sunshine to Cherrim when the sun ends', () => {
    const state = battle(
      [
        {
          speciesId: 'SPECIES_CHERRIM_SUNSHINE',
          maxHp: CHERRIM_MAX_HP,
          hp: CHERRIM_MAX_HP,
          types: ['GRASS', 'FIRE', 'MYSTERY'],
          abilities: { ability: 'ABILITY_SUN_BASKING', innates: ['ABILITY_FLOWER_GIFT', 'ABILITY_CHLOROPHYLL', 'ABILITY_LEAF_GUARD'] },
        },
        {},
      ],
      scriptedRng([0]),
    )
    dispatchOnWeatherChange(state, testDeps(), [])
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_CHERRIM')
    expect(state.battlers[0]!.mon.types).toEqual(['GRASS', 'MYSTERY', 'MYSTERY'])
  })

  it('does not change a non-Cherrim that happens to have Flower Gift', () => {
    const state = battle([{ speciesId: 'SPECIES_MUDKIP', maxHp: 100, hp: 100, abilities: FLOWER_GIFT }, {}], scriptedRng([0]))
    state.field.weather = WEATHER_SUN_TEMPORARY
    dispatchOnWeatherChange(state, testDeps(), [])
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
  })
})

describe('Cycle 96 - Schooling (abilities.cc:2834-2842; battle_util.c:3812-3825)', () => {
  const SCHOOLING = hasAbility('ABILITY_SCHOOLING')

  it('switch-in at level 20 above maxHp/4 becomes School form', () => {
    const state = battle(
      [{ speciesId: 'SPECIES_WISHIWASHI', level: 20, maxHp: WISHIWASHI_L20_MAX_HP, hp: WISHIWASHI_L20_MAX_HP, abilities: SCHOOLING }, {}],
      scriptedRng([0]),
    )
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, testDeps(), unmodelled)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISHIWASHI_SCHOOL')
    expect(state.battlers[0]!.mon.hp).toBe(WISHIWASHI_L20_MAX_HP)
    expect(state.battlers[0]!.mon.maxHp).toBe(WISHIWASHI_L20_MAX_HP)
    expect(state.battlers[0]!.volatiles.switchInAbilityDone[1]).toBe(true)
    expect(notModelled(unmodelled, 'SCHOOLING')).toEqual([])
  })

  it('switch-in at level 19 does nothing', () => {
    const state = battle(
      [{ speciesId: 'SPECIES_WISHIWASHI', level: 19, maxHp: WISHIWASHI_L20_MAX_HP, hp: WISHIWASHI_L20_MAX_HP, abilities: SCHOOLING }, {}],
      scriptedRng([0]),
    )
    applySwitchInAbilities(state, 0, testDeps(), [])
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISHIWASHI')
  })

  it('end of turn: above maxHp/4 becomes School, at or below maxHp/4 reverts', () => {
    // 54 / 4 = 13.5, and the C compares against the truncated integer quotient (13).
    const up = runEndTurn([
      { speciesId: 'SPECIES_WISHIWASHI', level: 20, maxHp: WISHIWASHI_L20_MAX_HP, hp: 14, abilities: SCHOOLING },
      {},
    ])
    expect(up.state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISHIWASHI_SCHOOL')
    expect(up.out.endTurn).toEqual([])

    const down = runEndTurn([
      { speciesId: 'SPECIES_WISHIWASHI_SCHOOL', level: 20, maxHp: WISHIWASHI_L20_MAX_HP, hp: 13, abilities: SCHOOLING },
      {},
    ])
    expect(down.state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISHIWASHI')
    expect(down.out.endTurn).toEqual([])
  })

  it('end of turn at level 19 does nothing', () => {
    const state = runEndTurn([
      { speciesId: 'SPECIES_WISHIWASHI', level: 19, maxHp: WISHIWASHI_L20_MAX_HP, hp: WISHIWASHI_L20_MAX_HP, abilities: SCHOOLING },
      {},
    ])
    expect(state.state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISHIWASHI')
  })
})

describe('Cycle 96 - Toxic Spill / Trash Heap (abilities.cc:5199-5250, :8975-8982)', () => {
  const SPILL = hasAbility('ABILITY_TOXIC_SPILL')
  const TRASH = hasAbility('ABILITY_TRASH_HEAP')

  it('damages every alive non-Poison battler on the field (the holder included) by maxHp/8', () => {
    const { state, out } = runEndTurn([{ maxHp: 80, hp: 80, abilities: SPILL }, { maxHp: 80, hp: 80 }])
    expect(out.endTurn).toEqual([
      { battlerId: 0, effect: 'ABILITY', hpChange: -10, fainted: false },
      { battlerId: 1, effect: 'ABILITY', hpChange: -10, fainted: false },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(70)
    expect(state.battlers[1]!.mon.hp).toBe(70)
  })

  it('skips Poison types and Magic Guard, and heals Poison Heal instead', () => {
    const poison = runEndTurn([{ maxHp: 80, hp: 80, abilities: SPILL }, { maxHp: 80, hp: 80, types: ['POISON', 'MYSTERY', 'MYSTERY'] }])
    expect(poison.out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: -10, fainted: false }])

    const guard = runEndTurn([{ maxHp: 80, hp: 80, abilities: SPILL }, { maxHp: 80, hp: 80, abilities: hasAbility('ABILITY_MAGIC_GUARD') }])
    expect(guard.out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: -10, fainted: false }])

    const heal = runEndTurn([{ maxHp: 80, hp: 80, abilities: SPILL }, { maxHp: 80, hp: 40, abilities: hasAbility('ABILITY_POISON_HEAL') }])
    expect(heal.out.endTurn).toEqual([
      { battlerId: 0, effect: 'ABILITY', hpChange: -10, fainted: false },
      { battlerId: 1, effect: 'ABILITY', hpChange: 10, fainted: false },
    ])
    expect(heal.state.battlers[1]!.mon.hp).toBe(50)
  })

  it('Toxic Boost on the HOLDER suppresses the damage to every target (the C tests it on `battler`, :5229)', () => {
    const { state, out } = runEndTurn([
      { maxHp: 80, hp: 80, abilities: { ability: 'ABILITY_TOXIC_SPILL', innates: ['ABILITY_TOXIC_BOOST', null, null] } },
      { maxHp: 80, hp: 80 },
    ])
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(80)
  })

  it('with two holders only the lowest-numbered one acts (IsAbilityOnField returns the first)', () => {
    const { state, out } = runEndTurn([{ maxHp: 80, hp: 80, abilities: SPILL }, { maxHp: 80, hp: 80, abilities: SPILL }])
    expect(out.endTurn).toHaveLength(2)
    expect(state.battlers[0]!.mon.hp).toBe(70)
    expect(state.battlers[1]!.mon.hp).toBe(70)
  })

  it('Trash Heap behaves identically', () => {
    const { state, out } = runEndTurn([{ maxHp: 80, hp: 80, abilities: TRASH }, { maxHp: 80, hp: 80 }])
    expect(out.endTurn).toEqual([
      { battlerId: 0, effect: 'ABILITY', hpChange: -10, fainted: false },
      { battlerId: 1, effect: 'ABILITY', hpChange: -10, fainted: false },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(70)
    expect(state.battlers[1]!.mon.hp).toBe(70)
  })

  it('scans TOXIC_SPILL before TRASH_HEAP when picking the acting holder', () => {
    // battler 0 holds Trash Heap, battler 1 holds Toxic Spill: the first sourceAbility with any
    // holder is Toxic Spill, so only battler 1's hook acts.
    const { state, out } = runEndTurn([{ maxHp: 80, hp: 80, abilities: TRASH }, { maxHp: 80, hp: 80, abilities: SPILL }])
    expect(out.endTurn).toHaveLength(2)
    expect(state.battlers[0]!.mon.hp).toBe(70)
    expect(state.battlers[1]!.mon.hp).toBe(70)
  })

  it('does nothing when the monotype champion type is Poison', () => {
    const { state, out } = runEndTurn([{ maxHp: 80, hp: 80, abilities: SPILL }, { maxHp: 80, hp: 80 }], {
      ...GROUNDING,
      monotypeChampType: 'POISON',
    })
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(80)
  })
})

describe('Cycle 96 - Soul Linker (abilities.cc:4273-4285; battle_scripts_1.s:11467-11472)', () => {
  const SOUL_LINKER = hasAbility('ABILITY_SOUL_LINKER')

  it("the defender holder deals the move's damage back to the move's attacker", () => {
    const { state, action } = runMove({}, { abilities: SOUL_LINKER })
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(80)
    expect(action.attackerDamage).toBe(20)
    expect(notModelled(action.unmodelled, 'SOUL_LINKER')).toEqual([])
  })

  it('the attacker holder takes the same damage it inflicts', () => {
    const { state, action } = runMove({ abilities: SOUL_LINKER }, {})
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(80)
    expect(action.attackerDamage).toBe(20)
  })

  it('does not trigger on Pain Split', () => {
    const state = battle([{ maxHp: 100, hp: 100 }, { maxHp: 100, hp: 100, abilities: SOUL_LINKER }], scriptedRng([0]))
    const { res } = dispatchDefender(state, 'MOVE_PAIN_SPLIT', 20)
    expect(res.attackerDamage).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('does not trigger when the opponent also has Soul Linker', () => {
    const { state, action } = runMove({ abilities: SOUL_LINKER }, { abilities: SOUL_LINKER })
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(80) // only the move's own damage
    expect(action.attackerDamage).toBeNull()
  })

  it('does not trigger when the holder is knocked out by the hit', () => {
    const { state } = runMove({}, { maxHp: 100, hp: 10, abilities: SOUL_LINKER })
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(0)
  })
})

describe('Cycle 96 - Temporal Rupture (abilities.cc:10043-10067)', () => {
  const RUPTURE = hasAbility('ABILITY_TEMPORAL_RUPTURE')

  it('Roar of Time replaces the target primary ability with Slow Start and sets slowStartTimer to 5', () => {
    const state = battle([{ maxHp: 100, hp: 100, abilities: RUPTURE }, { maxHp: 100, hp: 100, abilities: hasAbility('ABILITY_CLEAR_BODY') }], scriptedRng([0]))
    // UpdateAbilityStateIndicesForNewAbility (:8819-8862): the new primary shares no old slot, so its
    // switchInAbilityDone / abilityState entries are zeroed.
    state.battlers[1]!.volatiles.abilityState[0] = 3
    state.battlers[1]!.volatiles.switchInAbilityDone[0] = true

    const { res, unmodelled } = dispatchAttacker(state, 'MOVE_ROAR_OF_TIME', 20)

    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_SLOW_START')
    expect(state.battlers[1]!.mon.abilities.innates).toEqual([null, null, null])
    expect(state.battlers[1]!.volatiles.slowStartTimer).toBe(5)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expect(state.battlers[1]!.volatiles.switchInAbilityDone[0]).toBe(false)
    expect(res.attackerDamage).toBe(0)
    expect(notModelled(unmodelled, 'TEMPORAL_RUPTURE')).toEqual([])
  })

  it('does nothing for another move', () => {
    const state = battle([{ maxHp: 100, hp: 100, abilities: RUPTURE }, { maxHp: 100, hp: 100, abilities: hasAbility('ABILITY_CLEAR_BODY') }], scriptedRng([0]))
    dispatchAttacker(state, 'MOVE_TACKLE', 20)
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
    expect(state.battlers[1]!.volatiles.slowStartTimer).toBe(0)
  })

  it('does nothing when the target already has Slow Start in any slot', () => {
    const state = battle(
      [
        { maxHp: 100, hp: 100, abilities: RUPTURE },
        { maxHp: 100, hp: 100, abilities: { ability: 'ABILITY_CLEAR_BODY', innates: [null, 'ABILITY_SLOW_START', null] } },
      ],
      scriptedRng([0]),
    )
    dispatchAttacker(state, 'MOVE_ROAR_OF_TIME', 20)
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
    expect(state.battlers[1]!.volatiles.slowStartTimer).toBe(0)
  })

  it('does nothing when the target primary ability is persistent or unsuppressable', () => {
    const state = battle([{ maxHp: 100, hp: 100, abilities: RUPTURE }, { maxHp: 100, hp: 100, abilities: hasAbility('ABILITY_MULTITYPE') }], scriptedRng([0]))
    dispatchAttacker(state, 'MOVE_ROAR_OF_TIME', 20)
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_MULTITYPE')
  })

  it('does nothing when the target holds an Ability Shield', () => {
    const state = battle(
      [{ maxHp: 100, hp: 100, abilities: RUPTURE }, { maxHp: 100, hp: 100, itemId: 'ITEM_ABILITY_SHIELD', abilities: hasAbility('ABILITY_CLEAR_BODY') }],
      scriptedRng([0]),
    )
    dispatchAttacker(state, 'MOVE_ROAR_OF_TIME', 20)
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
  })

  it('does nothing when the hit dealt no damage or knocked the target out', () => {
    const noDamage = battle([{ maxHp: 100, hp: 100, abilities: RUPTURE }, { maxHp: 100, hp: 100, abilities: hasAbility('ABILITY_CLEAR_BODY') }], scriptedRng([0]))
    dispatchAttacker(noDamage, 'MOVE_ROAR_OF_TIME', 0)
    expect(noDamage.battlers[1]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')

    const fainted = battle([{ maxHp: 100, hp: 100, abilities: RUPTURE }, { maxHp: 100, hp: 0, abilities: hasAbility('ABILITY_CLEAR_BODY') }], scriptedRng([0]))
    dispatchAttacker(fainted, 'MOVE_ROAR_OF_TIME', 20)
    expect(fainted.battlers[1]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
  })
})
