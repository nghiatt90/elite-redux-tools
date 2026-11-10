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
import { applySwitchInAbilities } from './switchInAbility'
import { getHighestAttackingStatId } from './statBuffs'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_TAILWIND,
  STAT_ATK,
  STAT_SPATK,
  STATUS3_CHARGED_UP,
  WEATHER_RAIN_TEMPORARY,
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
// Cycle 162 (1) and (6): Air Blower / Air Lock entry order + Wind Rider / Wind Power
// ---------------------------------------------------------------------------

describe('Cycle 162 - Air Blower entry runs BattleScript_OnTailwindStart', () => {
  // Doubles: Air Blower at slot 0, its partner at slot 2. The C's
  // BattleScript_OnTailwindStart (data/battle_scripts_1.s:9266-9272) checks BS_ATTACKER
  // (the entering battler, battle_main.c:3362/:3375) and BS_ATTACKER_PARTNER (`battler ^ 2`,
  // include/constants/battle.h:37) for Wind Rider and Wind Power.
  it('raises the partner Wind Rider holder highest attacking stat by 1', () => {
    const state = battle([
      { abilities: hasAbility('ABILITY_AIR_BLOWER') },
      {},
      { abilities: hasAbility('ABILITY_WIND_RIDER'), atk: 100, spatk: 80 },
      {},
    ])
    applySwitchInAbilities(state, 0, testDeps(), [])

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(3)

    // Compute the stat from the partner's real raw stats rather than assuming Atk.
    const statId = getHighestAttackingStatId(state, 2, RATIOS)
    expect(statId).toBe(STAT_ATK)
    expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[2]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('sets STATUS3_CHARGED_UP on the partner Wind Power holder', () => {
    const state = battle([
      { abilities: hasAbility('ABILITY_AIR_BLOWER') },
      {},
      { abilities: hasAbility('ABILITY_WIND_POWER') },
      {},
    ])
    applySwitchInAbilities(state, 0, testDeps(), [])

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(hasFlag(state.battlers[2]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
  })

  it('negative: no Wind Rider anywhere leaves both attacking stages unchanged', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_AIR_BLOWER') }, {}, {}, {}])
    applySwitchInAbilities(state, 0, testDeps(), [])

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(hasFlag(state.battlers[2]!.statuses3, STATUS3_CHARGED_UP)).toBe(false)
  })

  it('Tailwind already up: CHECK_NOT returns before the script, so no stat raise', () => {
    // abilities.cc:1390 `CHECK_NOT(gSideStatuses[GetBattlerSide(battler)] & SIDE_STATUS_TAILWIND)`
    // returns before BattleScript_AirBlowerActivated is pushed.
    const state = battle([
      { abilities: hasAbility('ABILITY_AIR_BLOWER') },
      {},
      { abilities: hasAbility('ABILITY_WIND_RIDER') },
      {},
    ])
    state.sides[0]!.statuses |= SIDE_STATUS_TAILWIND
    state.sides[0]!.timers.tailwindTimer = 2
    applySwitchInAbilities(state, 0, testDeps(), [])

    expect(state.sides[0]!.timers.tailwindTimer).toBe(2)
    expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })
})

describe('Cycle 162 - Air Lock synchronous order: Tailwind, wind reactions, then weather clear', () => {
  it('partner Wind Rider raise happens and the rain is cleared (both effects present)', () => {
    // Air Lock = Cloud Nine.onEntry | Air Blower.onEntry (abilities.cc:1405-1407). Cloud Nine only
    // pushes BattleScript_AnnounceAirLockCloudNine (:652-657); the callback stack is LIFO
    // (battle_util.c:4871-4875, Cmd_end3 at battle_script_commands.c:4013-4018), so Air Blower's
    // script (Tailwind + Wind Rider / Wind Power) runs before the `removeweather` at
    // data/battle_scripts_1.s:11194-11205.
    const state = battle([
      { abilities: hasAbility('ABILITY_AIR_LOCK') },
      {},
      { abilities: hasAbility('ABILITY_WIND_RIDER') },
      {},
    ])
    state.field.weather = WEATHER_RAIN_TEMPORARY
    applySwitchInAbilities(state, 0, testDeps(), [])

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(3)
    expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.field.weather).toBe(0)
    expect(state.field.weatherDuration).toBe(0)
  })

  it('Tailwind already up still clears the weather (CHECK_NOT only guards the Tailwind half)', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_AIR_LOCK') }, {}])
    state.sides[0]!.statuses |= SIDE_STATUS_TAILWIND
    state.sides[0]!.timers.tailwindTimer = 2
    state.field.weather = WEATHER_RAIN_TEMPORARY
    applySwitchInAbilities(state, 0, testDeps(), [])

    expect(state.sides[0]!.timers.tailwindTimer).toBe(2)
    expect(state.field.weather).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cycle 162 (2): Air Lock's weather clear dispatches weather-change abilities
// ---------------------------------------------------------------------------

describe('Cycle 162 - Air Lock clears the weather and dispatches onWeather', () => {
  // Forecast's onWeather is `TryTransformAttacker(battler, ABILITY_BS_CALL)`
  // (data/v2.65beta/abilityHooks.json hooks.onWeather.source, abilities.cc:1249). With rain gone,
  // ShouldChangeFormHpBased (battle_util.c:3858-3883) picks base Castform, so the holder visibly
  // reverts from SPECIES_CASTFORM_RAINY.
  it('Air Lock re-runs Forecast: the rainy form reverts to base Castform', () => {
    const state = battle([
      { abilities: hasAbility('ABILITY_AIR_LOCK') },
      { speciesId: 'SPECIES_CASTFORM_RAINY', abilities: hasAbility('ABILITY_FORECAST') },
    ])
    state.field.weather = WEATHER_RAIN_TEMPORARY
    applySwitchInAbilities(state, 0, testDeps(), [])

    expect(state.field.weather).toBe(0)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CASTFORM')
  })

  it('negative: Air Blower leaves the rain and does not re-run Forecast', () => {
    const state = battle([
      { abilities: hasAbility('ABILITY_AIR_BLOWER') },
      { speciesId: 'SPECIES_CASTFORM_RAINY', abilities: hasAbility('ABILITY_FORECAST') },
    ])
    state.field.weather = WEATHER_RAIN_TEMPORARY
    applySwitchInAbilities(state, 0, testDeps(), [])

    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CASTFORM_RAINY')
  })
})
