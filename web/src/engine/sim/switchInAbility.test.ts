// Unit tests for switch-in ability dispatch and weather setters (cycle 36).
//
// Hand-derived from upstream C sources at pinned SHA:
// - HandleSwitchInAbility (src/battle_util.c:9103-9204)
// - TryDoEventsBeforeFirstTurn (src/battle_main.c:3354-3382)
// - Cmd_switchineffects (src/battle_script_commands.c:5520-5525)
// - TryChangeBattleWeather (src/battle_util.c:3721-3743)
// - WEATHER_DURATION (8) & WEATHER_DURATION_EXTENDED (12) (include/battle_util.h:50-51)
// - Drizzle (src/abilities.cc:501-514), Drought (:1332-1345), Sand Stream (:1076-1089),
//   Snow Warning (:1798-1811) and aliases: Seaborne (:6467), Storm Cloud (:11903),
//   Orichalcum Pulse (:7437), Desert Spirit (:7666), Sand Bender (:9178),
//   Snowy Wrath (:8295), Sundae (:11283).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  ENUM_WEATHER_RAIN,
  STATUS1_NONE,
  STATUS3_GASTRO_ACID,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_NONE,
  WEATHER_RAIN_PERMANENT,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_PRIMAL,
  WEATHER_SUN_TEMPORARY,
} from './constants'
import {
  applyBattleStartPass,
  applySwitchInAbilities,
  tryChangeBattleWeather,
  type BattleStartDeps,
} from './switchInAbility'
import { switchIn } from './switchIn'
import type { HazardDeps } from './hazards'

// ---------------------------------------------------------------------------
// Verbatim Fixture Block from moveEnd.test.ts
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))

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

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
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
  species: () => undefined,
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
    hp?: number
    maxHp?: number
    itemId?: string | null
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
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
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          itemId: s.itemId ?? null,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
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

function makeTestDeps(holdEffects: Record<number, string> = {}): BattleStartDeps & HazardDeps {
  return {
    grounding: {
      ...GROUNDING,
      holdEffectOf: (battlerId: number) => holdEffects[battlerId] ?? null,
    },
    dataContext: DATA_CONTEXT,
    statStageRatios: RATIOS,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('switch-in ability dispatch and weather setters', () => {
  it('a Drizzle lead sets rain (8 turns, 12 with Damp Rock) at battle start', () => {
    // Standard Drizzle without Damp Rock -> 8 turns
    const stateNoRock = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    const unmodelledNoRock: string[] = []
    applyBattleStartPass(stateNoRock, makeTestDeps(), unmodelledNoRock)

    expect(stateNoRock.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(stateNoRock.field.weatherDuration).toBe(8)
    expect(stateNoRock.field.timers.started.weather).toBe(true)
    expect(unmodelledNoRock).toEqual([])

    // Drizzle with Damp Rock -> 12 turns
    const stateWithRock = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] },
          itemId: 'ITEM_DAMP_ROCK',
          spe: 100,
        },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    const unmodelledWithRock: string[] = []
    applyBattleStartPass(stateWithRock, makeTestDeps({ 0: 'HOLD_EFFECT_DAMP_ROCK' }), unmodelledWithRock)

    expect(stateWithRock.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(stateWithRock.field.weatherDuration).toBe(12)
    expect(stateWithRock.field.timers.started.weather).toBe(true)
    expect(unmodelledWithRock).toEqual([])
  })

  it('a Drought replacement sets sun on switch-in', () => {
    const state = battle(
      [
        { hp: 0, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    // Setup party with replacement mon fielding Drought
    state.sides[0].party[0] = {
      ...state.battlers[0]!.mon,
      hp: 0,
    }
    state.sides[0].party[1] = {
      ...mon({
        speciesId: 'SPECIES_GROUDON',
        abilities: { ability: requireAbility('ABILITY_DROUGHT'), innates: [null, null, null] },
        hp: 150,
        maxHp: 150,
        rawStats: { atk: 150, def: 140, spatk: 100, spdef: 90, spe: 90 },
      }),
    }

    const unmodelled: string[] = []
    switchIn(state, 0, 1, makeTestDeps(), unmodelled)

    expect(state.field.weather).toBe(WEATHER_SUN_TEMPORARY)
    expect(state.field.weatherDuration).toBe(8)
    expect(state.field.timers.started.weather).toBe(true)
    expect(unmodelled).toEqual([])
  })

  it('the same weather already up does not reset the timer', () => {
    // Rain already up at 5 turns remaining
    const stateRain = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    stateRain.field.weather = WEATHER_RAIN_TEMPORARY
    stateRain.field.weatherDuration = 5
    stateRain.field.timers.started.weather = false

    const unmodelledRain: string[] = []
    applyBattleStartPass(stateRain, makeTestDeps(), unmodelledRain)

    expect(stateRain.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(stateRain.field.weatherDuration).toBe(5) // Not reset to 8
    expect(stateRain.field.timers.started.weather).toBe(false)
    expect(unmodelledRain).toEqual([])

    // Also tests permanent rain bit: WEATHER_RAIN_PERMANENT already up
    const statePermRain = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    statePermRain.field.weather = WEATHER_RAIN_PERMANENT
    statePermRain.field.weatherDuration = 3

    applyBattleStartPass(statePermRain, makeTestDeps(), [])
    expect(statePermRain.field.weatherDuration).toBe(3)
  })

  it('primal weather blocks them', () => {
    const statePrimal = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    statePrimal.field.weather = WEATHER_SUN_PRIMAL
    statePrimal.field.weatherDuration = 255

    const unmodelled: string[] = []
    applyBattleStartPass(statePrimal, makeTestDeps(), unmodelled)

    // Blocked by primal weather: weather and timer remain unchanged
    expect(statePrimal.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(statePrimal.field.weatherDuration).toBe(255)
    expect(unmodelled).toEqual([])

    // Also on switch-in
    statePrimal.sides[0].party[1] = {
      ...mon({
        abilities: { ability: requireAbility('ABILITY_DROUGHT'), innates: [null, null, null] },
        hp: 100,
      }),
    }
    switchIn(statePrimal, 0, 1, makeTestDeps(), unmodelled)
    expect(statePrimal.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(statePrimal.field.weatherDuration).toBe(255)
  })

  it('a holder of a primal ability can still change primal weather (TryChangeBattleWeather, battle_util.c:3725-3727)', () => {
    const state = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [requireAbility('ABILITY_DESOLATE_LAND'), null, null] },
          spe: 100,
        },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SUN_PRIMAL
    applyBattleStartPass(state, makeTestDeps(), [])
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.field.weatherDuration).toBe(8)
  })

  it('both leads with weather setters resolve in the C\'s order (the later one wins)', () => {
    // Case 1: Battler 0 (faster, spe 100) has Drizzle; Battler 1 (slower, spe 50) has Drought.
    // Drizzle runs first -> sets rain.
    // Drought runs second -> sets sun. Sun wins.
    const stateFastDrizzle = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] }, spe: 100 },
        { abilities: { ability: requireAbility('ABILITY_DROUGHT'), innates: [null, null, null] }, spe: 50 },
      ],
      scriptedRng(),
    )
    const unmodelled1: string[] = []
    applyBattleStartPass(stateFastDrizzle, makeTestDeps(), unmodelled1)

    expect(stateFastDrizzle.field.weather).toBe(WEATHER_SUN_TEMPORARY)
    expect(stateFastDrizzle.field.weatherDuration).toBe(8)
    expect(unmodelled1).toEqual([])

    // Case 2: Battler 0 (slower, spe 50) has Drizzle; Battler 1 (faster, spe 100) has Drought.
    // Drought runs first -> sets sun.
    // Drizzle runs second -> sets rain. Rain wins.
    const stateSlowDrizzle = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] }, spe: 50 },
        { abilities: { ability: requireAbility('ABILITY_DROUGHT'), innates: [null, null, null] }, spe: 100 },
      ],
      scriptedRng(),
    )
    const unmodelled2: string[] = []
    applyBattleStartPass(stateSlowDrizzle, makeTestDeps(), unmodelled2)

    expect(stateSlowDrizzle.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(stateSlowDrizzle.field.weatherDuration).toBe(8)
    expect(unmodelled2).toEqual([])
  })

  it('an innate-slot Drizzle works', () => {
    // Drizzle in innate[0] (slot 1)
    const stateInnate0 = battle(
      [
        { abilities: { ability: null, innates: [requireAbility('ABILITY_DRIZZLE'), null, null] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    applyBattleStartPass(stateInnate0, makeTestDeps(), [])
    expect(stateInnate0.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(stateInnate0.field.weatherDuration).toBe(8)

    // Drizzle in innate[2] (slot 3)
    const stateInnate2 = battle(
      [
        { abilities: { ability: null, innates: [null, null, requireAbility('ABILITY_DRIZZLE')] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    applyBattleStartPass(stateInnate2, makeTestDeps(), [])
    expect(stateInnate2.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(stateInnate2.field.weatherDuration).toBe(8)
  })

  it('a non-ported onEntry ability still produces its gap line, for leads too', () => {
    // Lead with unported onEntry ability (Intimidate)
    const stateLead = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    const unmodelledLead: string[] = []
    applyBattleStartPass(stateLead, makeTestDeps(), unmodelledLead)

    expect(unmodelledLead).toContain(
      'battler 0: HandleSwitchInAbility (battle_util.c:9103-9204) is not applied -- ABILITY_INTIMIDATE\'s onEntry hook was not run',
    )

    // Replacement switch-in with unported onEntry ability (Download)
    const stateReplacement = battle(
      [
        { hp: 0, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    stateReplacement.sides[0].party[1] = {
      ...mon({
        abilities: { ability: requireAbility('ABILITY_DOWNLOAD'), innates: [null, null, null] },
        hp: 100,
      }),
    }
    const unmodelledRepl: string[] = []
    switchIn(stateReplacement, 0, 1, makeTestDeps(), unmodelledRepl)

    expect(unmodelledRepl).toContain(
      'battler 0: HandleSwitchInAbility (battle_util.c:9103-9204) is not applied -- ABILITY_DOWNLOAD\'s onEntry hook was not run',
    )
  })

  it('all ported weather setter aliases set their respective weather and hold rocks', () => {
    // Seaborne (Drizzle alias)
    const stateSeaborne = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SEABORNE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateSeaborne, makeTestDeps(), [])
    expect(stateSeaborne.field.weather).toBe(WEATHER_RAIN_TEMPORARY)

    // Storm Cloud (Drizzle alias)
    const stateStormCloud = battle(
      [{ abilities: { ability: requireAbility('ABILITY_STORM_CLOUD'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateStormCloud, makeTestDeps(), [])
    expect(stateStormCloud.field.weather).toBe(WEATHER_RAIN_TEMPORARY)

    // Orichalcum Pulse (Drought alias) with Heat Rock
    const stateOrichalcum = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ORICHALCUM_PULSE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateOrichalcum, makeTestDeps({ 0: 'HOLD_EFFECT_HEAT_ROCK' }), [])
    expect(stateOrichalcum.field.weather).toBe(WEATHER_SUN_TEMPORARY)
    expect(stateOrichalcum.field.weatherDuration).toBe(12)

    // Sand Stream with Smooth Rock
    const stateSandStream = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SAND_STREAM'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateSandStream, makeTestDeps({ 0: 'HOLD_EFFECT_SMOOTH_ROCK' }), [])
    expect(stateSandStream.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)
    expect(stateSandStream.field.weatherDuration).toBe(12)

    // Desert Spirit (Sand Stream alias)
    const stateDesertSpirit = battle(
      [{ abilities: { ability: requireAbility('ABILITY_DESERT_SPIRIT'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateDesertSpirit, makeTestDeps(), [])
    expect(stateDesertSpirit.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)
    expect(stateDesertSpirit.field.weatherDuration).toBe(8)

    // Sand Bender (Sand Stream alias)
    const stateSandBender = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SAND_BENDER'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateSandBender, makeTestDeps(), [])
    expect(stateSandBender.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)

    // Snow Warning with Icy Rock
    const stateSnowWarning = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SNOW_WARNING'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateSnowWarning, makeTestDeps({ 0: 'HOLD_EFFECT_ICY_ROCK' }), [])
    expect(stateSnowWarning.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    expect(stateSnowWarning.field.weatherDuration).toBe(12)

    // Snowy Wrath (Snow Warning alias)
    const stateSnowyWrath = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SNOWY_WRATH'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateSnowyWrath, makeTestDeps(), [])
    expect(stateSnowyWrath.field.weather).toBe(WEATHER_HAIL_TEMPORARY)

    // Sundae (Snow Warning alias)
    const stateSundae = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SUNDAE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applyBattleStartPass(stateSundae, makeTestDeps(), [])
    expect(stateSundae.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
  })

  it('suppression blocks weather setting and gap reporting', () => {
    // Neutralizing Gas on field
    const stateGas = battle(
      [{ abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    stateGas.field.timers.neutralizingGas = true
    const unmodelledGas: string[] = []
    applyBattleStartPass(stateGas, makeTestDeps(), unmodelledGas)

    expect(stateGas.field.weather).toBe(WEATHER_NONE)
    expect(unmodelledGas).toEqual([])

    // Gastro Acid on battler
    const stateGastro = battle(
      [{ abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    stateGastro.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    const unmodelledGastro: string[] = []
    applyBattleStartPass(stateGastro, makeTestDeps(), unmodelledGastro)

    expect(stateGastro.field.weather).toBe(WEATHER_NONE)
    expect(unmodelledGastro).toEqual([])
  })

  it('tryChangeBattleWeather sets weather and respects already-active flag', () => {
    const state = battle([{}, {}], scriptedRng())
    const changed1 = tryChangeBattleWeather(state, 0, ENUM_WEATHER_RAIN, true, makeTestDeps())
    expect(changed1).toBe(true)
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.field.weatherDuration).toBe(8)

    const changed2 = tryChangeBattleWeather(state, 0, ENUM_WEATHER_RAIN, true, makeTestDeps())
    expect(changed2).toBe(false)
  })

  it('applySwitchInAbilities dispatches directly for a single battler', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_DRIZZLE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, makeTestDeps(), unmodelled)
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(unmodelled).toEqual([])
  })
})
