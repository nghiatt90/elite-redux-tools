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
  DEFAULT_STAT_STAGE,
  ENUM_WEATHER_RAIN,
  GRAVITY_DURATION,
  GRAVITY_DURATION_EXTENDED,
  INVERSE_ROOM_DURATION_SHORT,
  PLEDGE_DURATION,
  SCREEN_DURATION,
  SCREEN_DURATION_SHORT,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SMOKESCREEN,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TAILWIND,
  SIDE_STATUS_TOXIC_SPIKES,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
  STATUS1_NONE,
  STATUS2_DEFENSE_CURL,
  STATUS2_ENRAGED,
  STATUS2_SUBSTITUTE,
  STATUS3_GASTRO_ACID,
  STATUS4_COILED,
  STATUS4_CUTTHROAT,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_GRAVITY,
  STATUS_FIELD_INVERSE_ROOM,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TERRAIN_PERMANENT,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  TAILWIND_DURATION_SHORT,
  TERRAIN_DURATION,
  TERRAIN_DURATION_EXTENDED,
  TRICK_ROOM_DURATION_SHORT,
  WEATHER_FOG_TEMPORARY,
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
  disableSwitchInAbility,
  tryChangeBattleTerrain,
  tryChangeBattleWeather,
  tryRemoveScreens,
  trySetAuroraVeil,
  trySetGravity,
  trySetInverseRoom,
  trySetSmokescreen,
  trySetSpikes,
  trySetStickyWeb,
  trySetSwamp,
  trySetTailwind,
  trySetToxicSpikes,
  trySetTrickRoom,
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
    def?: number
    spatk?: number
    spdef?: number
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
          rawStats: {
            atk: s.atk ?? 100,
            def: s.def ?? 90,
            spatk: s.spatk ?? 80,
            spdef: s.spdef ?? 85,
            spe: s.spe ?? (i === 0 ? 100 : 50),
          },
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
    // Lead with unported onEntry ability (Anticipation)
    const stateLead = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_ANTICIPATION'), innates: [null, null, null] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    const unmodelledLead: string[] = []
    applyBattleStartPass(stateLead, makeTestDeps(), unmodelledLead)

    expect(unmodelledLead).toContain(
      'battler 0: HandleSwitchInAbility (battle_util.c:9103-9204) is not applied -- ABILITY_ANTICIPATION\'s onEntry hook was not run',
    )

    // Replacement switch-in with unported onEntry ability (Frisk)
    const stateReplacement = battle(
      [
        { hp: 0, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    stateReplacement.sides[0].party[1] = {
      ...mon({
        abilities: { ability: requireAbility('ABILITY_FRISK'), innates: [null, null, null] },
        hp: 100,
      }),
    }
    const unmodelledRepl: string[] = []
    switchIn(stateReplacement, 0, 1, makeTestDeps(), unmodelledRepl)

    expect(unmodelledRepl).toContain(
      'battler 0: HandleSwitchInAbility (battle_util.c:9103-9204) is not applied -- ABILITY_FRISK\'s onEntry hook was not run',
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

describe('cycle 41: switch-in stat changes and flag setters', () => {
  it('Intimidate at battle start lowers opposing Attack by 1 in lead pass', () => {
    const state = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
        { spe: 50 },
      ],
      scriptedRng(),
    )
    const unmodelled: string[] = []
    applyBattleStartPass(state, makeTestDeps(), unmodelled)

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(unmodelled).toEqual([])
  })

  it('blocked Intimidate: foe with tauntImmune ability (Inner Focus, Oblivious, Scrappy) has Attack untouched', () => {
    for (const immuneAbility of ['ABILITY_INNER_FOCUS', 'ABILITY_OBLIVIOUS', 'ABILITY_SCRAPPY']) {
      const state = battle(
        [
          { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
          { abilities: { ability: requireAbility(immuneAbility), innates: [null, null, null] }, spe: 50 },
        ],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applyBattleStartPass(state, makeTestDeps(), unmodelled)

      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
      expect(unmodelled).toEqual([])
    }
  })

  it('Substitute blocks Intimidate unless the attacker has Infiltrator', () => {
    // Normal Intimidate blocked by Substitute
    const stateNormal = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] } },
        {},
      ],
      scriptedRng(),
    )
    stateNormal.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    const unmodelledNormal: string[] = []
    applySwitchInAbilities(stateNormal, 0, makeTestDeps(), unmodelledNormal)
    expect(stateNormal.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(unmodelledNormal).toEqual([])

    // Intimidate + Infiltrator bypasses Substitute
    const stateInfiltrator = battle(
      [
        {
          abilities: {
            ability: requireAbility('ABILITY_INTIMIDATE'),
            innates: [requireAbility('ABILITY_INFILTRATOR'), null, null],
          },
        },
        {},
      ],
      scriptedRng(),
    )
    stateInfiltrator.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    const unmodelledInfil: string[] = []
    applySwitchInAbilities(stateInfiltrator, 0, makeTestDeps(), unmodelledInfil)
    expect(stateInfiltrator.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(unmodelledInfil).toEqual([])
  })

  it('Guard Dog inverts Intimidate from -1 Attack to +1 Attack', () => {
    const state = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] } },
        { abilities: { ability: requireAbility('ABILITY_GUARD_DOG'), innates: [null, null, null] } },
      ],
      scriptedRng(),
    )
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, makeTestDeps(), unmodelled)

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(unmodelled).toEqual([])
  })

  it('Clear Body and Hyper Cutter block Intimidate Attack drop via changeStatBuffs', () => {
    for (const blockerAbility of ['ABILITY_CLEAR_BODY', 'ABILITY_HYPER_CUTTER']) {
      const state = battle(
        [
          { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] } },
          { abilities: { ability: requireAbility(blockerAbility), innates: [null, null, null] } },
        ],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, makeTestDeps(), unmodelled)

      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
      expect(unmodelled).toEqual([])
    }
  })

  it('innate-slot Intimidate activates properly', () => {
    const state = battle(
      [
        { abilities: { ability: null, innates: [requireAbility('ABILITY_INTIMIDATE'), null, null] } },
        {},
      ],
      scriptedRng(),
    )
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, makeTestDeps(), unmodelled)

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(unmodelled).toEqual([])
  })

  it('Intimidate variants apply their specific stat drops and side effects', () => {
    // Scare: -1 SpAtk
    const stateScare = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SCARE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateScare, 0, makeTestDeps(), [])
    expect(stateScare.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stateScare.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)

    // Fearmonger: -1 SpAtk, -1 Atk
    const stateFearmonger = battle(
      [{ abilities: { ability: requireAbility('ABILITY_FEARMONGER'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateFearmonger, 0, makeTestDeps(), [])
    expect(stateFearmonger.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stateFearmonger.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)

    // Terrify: -2 SpAtk
    const stateTerrify = battle(
      [{ abilities: { ability: requireAbility('ABILITY_TERRIFY'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateTerrify, 0, makeTestDeps(), [])
    expect(stateTerrify.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 2)

    // Malicious: -1 highest defending, then -1 highest attacking
    // Foe has Def 100 > SpDef 85 (defending: Def), Atk 110 > SpAtk 80 (attacking: Atk)
    const stateMalicious = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_MALICIOUS'), innates: [null, null, null] } },
        { atk: 110, def: 100, spatk: 80, spdef: 85 },
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateMalicious, 0, makeTestDeps(), [])
    expect(stateMalicious.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stateMalicious.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stateMalicious.battlers[1]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
    expect(stateMalicious.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)

    // Petrify: -1 Speed and resets opposing buffed stages (> 6 to 6), drops preserved
    const statePetrify = battle(
      [{ abilities: { ability: requireAbility('ABILITY_PETRIFY'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    statePetrify.battlers[1]!.mon.statStages[STAT_ATK] = 8
    statePetrify.battlers[1]!.mon.statStages[STAT_SPATK] = 10
    statePetrify.battlers[1]!.mon.statStages[STAT_DEF] = 4
    applySwitchInAbilities(statePetrify, 0, makeTestDeps(), [])
    expect(statePetrify.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(statePetrify.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(statePetrify.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(statePetrify.battlers[1]!.mon.statStages[STAT_DEF]).toBe(4)

    // Champions Entrance: -1 Atk + violentRush flag
    const stateChampions = battle(
      [{ abilities: { ability: requireAbility('ABILITY_CHAMPIONS_ENTRANCE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateChampions, 0, makeTestDeps(), [])
    expect(stateChampions.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(stateChampions.battlers[0]!.volatiles.violentRush).toBe(true)
    expect(stateChampions.battlers[0]!.volatiles.started.violentRush).toBe(true)
  })

  it('Download raises SpAtk when foe Def >= SpDef, and raises Atk when foe SpDef > Def', () => {
    // Foe Def (100) > SpDef (80) -> raises SpAtk
    const stateHigherDef = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DOWNLOAD'), innates: [null, null, null] } },
        { def: 100, spdef: 80 },
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateHigherDef, 0, makeTestDeps(), [])
    expect(stateHigherDef.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stateHigherDef.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)

    // Foe SpDef (100) > Def (80) -> raises Atk
    const stateHigherSpDef = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DOWNLOAD'), innates: [null, null, null] } },
        { def: 80, spdef: 100 },
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateHigherSpDef, 0, makeTestDeps(), [])
    expect(stateHigherSpDef.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stateHigherSpDef.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)

    // Tie: foe Def (90) == SpDef (90) -> C loops Def then SpDef with strictly greater (>), so Def wins -> raises SpAtk
    const stateEqual = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DOWNLOAD'), innates: [null, null, null] } },
        { def: 90, spdef: 90 },
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateEqual, 0, makeTestDeps(), [])
    expect(stateEqual.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stateEqual.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('plain stat raisers boost their respective stats by 1 stage', () => {
    // Intrepid Sword (+1 Atk) and alias Crowned Sword
    const stateSword = battle(
      [{ abilities: { ability: requireAbility('ABILITY_INTREPID_SWORD'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateSword, 0, makeTestDeps(), [])
    expect(stateSword.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

    const stateCrownedSword = battle(
      [{ abilities: { ability: requireAbility('ABILITY_CROWNED_SWORD'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateCrownedSword, 0, makeTestDeps(), [])
    expect(stateCrownedSword.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

    // Dauntless Shield (+1 Def) and alias Crowned Shield
    const stateShield = battle(
      [{ abilities: { ability: requireAbility('ABILITY_DAUNTLESS_SHIELD'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateShield, 0, makeTestDeps(), [])
    expect(stateShield.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)

    const stateCrownedShield = battle(
      [{ abilities: { ability: requireAbility('ABILITY_CROWNED_SHIELD'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateCrownedShield, 0, makeTestDeps(), [])
    expect(stateCrownedShield.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)

    // Embody Aspect (+1 Speed)
    const stateAspectSpe = battle(
      [{ abilities: { ability: requireAbility('ABILITY_EMBODY_ASPECT'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateAspectSpe, 0, makeTestDeps(), [])
    expect(stateAspectSpe.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)

    // Embody Aspect Wellspring (+1 SpDef)
    const stateAspectSpDef = battle(
      [{ abilities: { ability: requireAbility('ABILITY_EMBODY_ASPECT_WELLSPRING'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateAspectSpDef, 0, makeTestDeps(), [])
    expect(stateAspectSpDef.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it("Let's Roll boosts Def and sets Defense Curl, Curlipede also sets Coiled", () => {
    // Let's Roll
    const stateLetsRoll = battle(
      [{ abilities: { ability: requireAbility('ABILITY_LETS_ROLL'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateLetsRoll, 0, makeTestDeps(), [])
    expect(stateLetsRoll.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect((stateLetsRoll.battlers[0]!.mon.status2 & STATUS2_DEFENSE_CURL) !== 0).toBe(true)

    // Curlipede (Let's Roll + Coil Up)
    const stateCurlipede = battle(
      [{ abilities: { ability: requireAbility('ABILITY_CURLIPEDE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateCurlipede, 0, makeTestDeps(), [])
    expect(stateCurlipede.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect((stateCurlipede.battlers[0]!.mon.status2 & STATUS2_DEFENSE_CURL) !== 0).toBe(true)
    expect((stateCurlipede.battlers[0]!.statuses4 & STATUS4_COILED) !== 0).toBe(true)
  })

  it('Majestic Moth raises the highest stat by 1 stage', () => {
    // SpAtk 120 is highest
    const stateMoth = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_MAJESTIC_MOTH'), innates: [null, null, null] },
          atk: 80,
          def: 80,
          spatk: 120,
          spdef: 80,
          spe: 80,
        },
        {},
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateMoth, 0, makeTestDeps(), [])
    expect(stateMoth.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stateMoth.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('weather-gated stat raisers activate only under their corresponding weather', () => {
    // Sea Guardian: highest stat in Rain
    const stateSeaRain = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_SEA_GUARDIAN'), innates: [null, null, null] },
          atk: 130,
          def: 90,
          spatk: 80,
          spdef: 80,
          spe: 80,
        },
        {},
      ],
      scriptedRng(),
    )
    stateSeaRain.field.weather = WEATHER_RAIN_TEMPORARY
    applySwitchInAbilities(stateSeaRain, 0, makeTestDeps(), [])
    expect(stateSeaRain.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)

    // Sea Guardian: no Rain -> no boost
    const stateSeaNoRain = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_SEA_GUARDIAN'), innates: [null, null, null] },
          atk: 130,
        },
        {},
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateSeaNoRain, 0, makeTestDeps(), [])
    expect(stateSeaNoRain.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)

    // Sun Worship: in Sun
    const stateSun = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_SUN_WORSHIP'), innates: [null, null, null] },
          spatk: 130,
          atk: 80,
          def: 80,
          spdef: 80,
          spe: 80,
        },
        {},
      ],
      scriptedRng(),
    )
    stateSun.field.weather = WEATHER_SUN_TEMPORARY
    applySwitchInAbilities(stateSun, 0, makeTestDeps(), [])
    expect(stateSun.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)

    const stateSunNoSun = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_SUN_WORSHIP'), innates: [null, null, null] },
          spatk: 130,
        },
        {},
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateSunNoSun, 0, makeTestDeps(), [])
    expect(stateSunNoSun.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)

    // Greater Spirit: in Fog
    const stateFog = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_GREATER_SPIRIT'), innates: [null, null, null] },
          spe: 130,
          atk: 80,
          def: 80,
          spatk: 80,
          spdef: 80,
        },
        {},
      ],
      scriptedRng(),
    )
    stateFog.field.weather = WEATHER_FOG_TEMPORARY
    applySwitchInAbilities(stateFog, 0, makeTestDeps(), [])
    expect(stateFog.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)

    const stateFogNoFog = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_GREATER_SPIRIT'), innates: [null, null, null] },
          spe: 130,
        },
        {},
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateFogNoFog, 0, makeTestDeps(), [])
    expect(stateFogNoFog.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Furnace boosts Speed by 2 only if the side has Stealth Rock of type 5 (ROCK)', () => {
    // Valid Stealth Rock (type 5)
    const stateFurnaceValid = battle(
      [{ abilities: { ability: requireAbility('ABILITY_FURNACE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    stateFurnaceValid.sides[0]!.statuses |= SIDE_STATUS_STEALTH_ROCK
    stateFurnaceValid.sides[0]!.timers.stealthRockType = 5
    applySwitchInAbilities(stateFurnaceValid, 0, makeTestDeps(), [])
    expect(stateFurnaceValid.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)

    // No Stealth Rock
    const stateFurnaceNoRocks = battle(
      [{ abilities: { ability: requireAbility('ABILITY_FURNACE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateFurnaceNoRocks, 0, makeTestDeps(), [])
    expect(stateFurnaceNoRocks.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)

    // Stealth Rock of wrong type (e.g. Steel type 8)
    const stateFurnaceWrongType = battle(
      [{ abilities: { ability: requireAbility('ABILITY_FURNACE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    stateFurnaceWrongType.sides[0]!.statuses |= SIDE_STATUS_STEALTH_ROCK
    stateFurnaceWrongType.sides[0]!.timers.stealthRockType = 8
    applySwitchInAbilities(stateFurnaceWrongType, 0, makeTestDeps(), [])
    expect(stateFurnaceWrongType.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Berserk DNA raises highest attacking stat by 2 and sets STATUS2_ENRAGED', () => {
    const stateBerserk = battle(
      [
        {
          abilities: { ability: requireAbility('ABILITY_BERSERK_DNA'), innates: [null, null, null] },
          atk: 130,
          spatk: 80,
        },
        {},
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(stateBerserk, 0, makeTestDeps(), [])
    expect(stateBerserk.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect((stateBerserk.battlers[0]!.mon.status2 & STATUS2_ENRAGED) !== 0).toBe(true)
  })

  it('flag setter abilities set volatile and status4 flags with their started twins', () => {
    // Violent Rush
    const stateViolent = battle(
      [{ abilities: { ability: requireAbility('ABILITY_VIOLENT_RUSH'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateViolent, 0, makeTestDeps(), [])
    expect(stateViolent.battlers[0]!.volatiles.violentRush).toBe(true)
    expect(stateViolent.battlers[0]!.volatiles.started.violentRush).toBe(true)

    // Showdown Mode
    const stateShowdown = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SHOWDOWN_MODE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateShowdown, 0, makeTestDeps(), [])
    expect(stateShowdown.battlers[0]!.volatiles.showdownMode).toBe(true)
    expect(stateShowdown.battlers[0]!.volatiles.started.showdownMode).toBe(true)

    // Rapid Response
    const stateRapid = battle(
      [{ abilities: { ability: requireAbility('ABILITY_RAPID_RESPONSE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateRapid, 0, makeTestDeps(), [])
    expect(stateRapid.battlers[0]!.volatiles.rapidResponse).toBe(true)
    expect(stateRapid.battlers[0]!.volatiles.started.rapidResponse).toBe(true)

    // On the Prowl (and Overwatch alias)
    const stateProwl = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ON_THE_PROWL'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateProwl, 0, makeTestDeps(), [])
    expect(stateProwl.battlers[0]!.volatiles.onTheProwl).toBe(true)
    expect(stateProwl.battlers[0]!.volatiles.started.onTheProwl).toBe(true)

    const stateOverwatch = battle(
      [{ abilities: { ability: requireAbility('ABILITY_OVERWATCH'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateOverwatch, 0, makeTestDeps(), [])
    expect(stateOverwatch.battlers[0]!.volatiles.onTheProwl).toBe(true)
    expect(stateOverwatch.battlers[0]!.volatiles.started.onTheProwl).toBe(true)

    // Coil Up (and Sidewinder alias)
    const stateCoil = battle(
      [{ abilities: { ability: requireAbility('ABILITY_COIL_UP'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateCoil, 0, makeTestDeps(), [])
    expect((stateCoil.battlers[0]!.statuses4 & STATUS4_COILED) !== 0).toBe(true)

    const stateSidewinder = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SIDEWINDER'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateSidewinder, 0, makeTestDeps(), [])
    expect((stateSidewinder.battlers[0]!.statuses4 & STATUS4_COILED) !== 0).toBe(true)

    // Cutthroat (and Edgelord alias)
    const stateCutthroat = battle(
      [{ abilities: { ability: requireAbility('ABILITY_CUTTHROAT'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateCutthroat, 0, makeTestDeps(), [])
    expect((stateCutthroat.battlers[0]!.statuses4 & STATUS4_CUTTHROAT) !== 0).toBe(true)

    const stateEdgelord = battle(
      [{ abilities: { ability: requireAbility('ABILITY_EDGELORD'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateEdgelord, 0, makeTestDeps(), [])
    expect((stateEdgelord.battlers[0]!.statuses4 & STATUS4_CUTTHROAT) !== 0).toBe(true)
  })

  it('Pressure resets self stat drops (<= 5 to 6) and resets opponent stat buffs (>= 7 to 6)', () => {
    const statePressure = battle(
      [{ abilities: { ability: requireAbility('ABILITY_PRESSURE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    // Caster has drops (< 6) and a buff (> 6)
    statePressure.battlers[0]!.mon.statStages[STAT_ATK] = 4
    statePressure.battlers[0]!.mon.statStages[STAT_DEF] = 5
    statePressure.battlers[0]!.mon.statStages[STAT_SPATK] = 8

    // Opponent has buffs (> 6) and a drop (< 6)
    statePressure.battlers[1]!.mon.statStages[STAT_ATK] = 9
    statePressure.battlers[1]!.mon.statStages[STAT_SPEED] = 8
    statePressure.battlers[1]!.mon.statStages[STAT_DEF] = 3

    applySwitchInAbilities(statePressure, 0, makeTestDeps(), [])

    // Caster drops reset to 6, caster buff preserved
    expect(statePressure.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(statePressure.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(statePressure.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)

    // Opponent buffs reset to 6, opponent drop preserved
    expect(statePressure.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(statePressure.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(statePressure.battlers[1]!.mon.statStages[STAT_DEF]).toBe(3)
  })

  it('Intimidate in doubles: an immune first target stops the partner from being hit (abilityPopupOverwrite)', () => {
    const intimidator = { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] } as SimBattleMon['abilities'] }
    const immune = { abilities: { ability: requireAbility('ABILITY_INNER_FOCUS'), innates: [null, null, null] } as SimBattleMon['abilities'] }
    const blocked = battle([intimidator, immune, {}, {}], scriptedRng())
    applySwitchInAbilities(blocked, 0, makeTestDeps(), [])
    expect(blocked.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(blocked.battlers[3]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)

    const both = battle([intimidator, {}, {}, {}], scriptedRng())
    applySwitchInAbilities(both, 0, makeTestDeps(), [])
    expect(both.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(both.battlers[3]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(both.battlers[2]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
  })

  it('Download still reads a fainted opposite battler', () => {
    const state = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_DOWNLOAD'), innates: [null, null, null] } },
        { hp: 0, def: 80, spdef: 100 },
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    // SpDef 100 > Def 80 -> GetHighestDefendingStatId = STAT_SPDEF -> +1 Atk
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it("Let's Roll assigns status2, clearing confusion", () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_LETS_ROLL'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    state.battlers[0]!.mon.status2 = 2
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.battlers[0]!.mon.status2).toBe(STATUS2_DEFENSE_CURL)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('Intrepid Sword at +6 still fires under Contrary (CompareStat flips), lowering Attack', () => {
    const state = battle(
      [
        {
          abilities: {
            ability: requireAbility('ABILITY_INTREPID_SWORD'),
            innates: [requireAbility('ABILITY_CONTRARY'), null, null],
          },
        },
        {},
      ],
      scriptedRng(),
    )
    state.battlers[0]!.mon.statStages[STAT_ATK] = 12
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(11)
  })
})

describe('cycle 45: switch-in terrain, side/field setters and entry moves', () => {
  // -------------------------------------------------------------------------
  // 1. Terrain setters
  // -------------------------------------------------------------------------

  it('Electric Surge sets Electric Terrain for TERRAIN_DURATION (8 turns) without Terrain Extender', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ELECTRIC_SURGE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.statuses & STATUS_FIELD_ELECTRIC_TERRAIN).toBeTruthy()
    expect(state.field.timers.terrainTimer).toBe(TERRAIN_DURATION)
    expect(state.field.timers.started.terrain).toBe(true)
    expect(state.field.timers.terrainBattlerId).toBe(0)
  })

  it('Electric Surge with Terrain Extender sets Electric Terrain for TERRAIN_DURATION_EXTENDED (12 turns)', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ELECTRIC_SURGE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps({ 0: 'HOLD_EFFECT_TERRAIN_EXTENDER' }), [])
    expect(state.field.statuses & STATUS_FIELD_ELECTRIC_TERRAIN).toBeTruthy()
    expect(state.field.timers.terrainTimer).toBe(TERRAIN_DURATION_EXTENDED)
    expect(state.field.timers.started.terrain).toBe(true)
  })

  it('Electric Surge disables ABILITY_GENERATOR and ABILITY_ENERGIZED on all battlers', () => {
    const state = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_ELECTRIC_SURGE'), innates: [null, null, null] } },
        { abilities: { ability: requireAbility('ABILITY_GENERATOR'), innates: [null, null, null] } },
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    // Generator on battler 1 should be disabled in its switchInAbilityDone slot
    expect(state.battlers[1]!.volatiles.switchInAbilityDone[0]).toBe(true)
  })

  it('Electric Surge fails when STATUS_FIELD_TERRAIN_PERMANENT is active', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ELECTRIC_SURGE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    state.field.statuses |= STATUS_FIELD_TERRAIN_PERMANENT
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.statuses & STATUS_FIELD_ELECTRIC_TERRAIN).toBeFalsy()
    expect(state.field.timers.terrainTimer).toBe(0)
  })

  it('Electric Surge does not reset terrain timer when Electric Terrain is already active', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ELECTRIC_SURGE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    state.field.timers.terrainTimer = 3
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.timers.terrainTimer).toBe(3)
  })

  it('Grassy Surge overwrites existing Electric Terrain and resets timer to 8', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_GRASSY_SURGE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    state.field.timers.terrainTimer = 2
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.statuses & STATUS_FIELD_ELECTRIC_TERRAIN).toBeFalsy()
    expect(state.field.statuses & STATUS_FIELD_GRASSY_TERRAIN).toBeTruthy()
    expect(state.field.timers.terrainTimer).toBe(TERRAIN_DURATION)
  })

  it('Terrain aliases: Hadron Engine, King of the Jungle, Misty Surge, Toxic Surge', () => {
    const stateHadron = battle(
      [{ abilities: { ability: requireAbility('ABILITY_HADRON_ENGINE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateHadron, 0, makeTestDeps(), [])
    expect(stateHadron.field.statuses & STATUS_FIELD_ELECTRIC_TERRAIN).toBeTruthy()

    const stateKing = battle(
      [{ abilities: { ability: requireAbility('ABILITY_KING_OF_THE_JUNGLE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateKing, 0, makeTestDeps(), [])
    expect(stateKing.field.statuses & STATUS_FIELD_GRASSY_TERRAIN).toBeTruthy()

    const stateMisty = battle(
      [{ abilities: { ability: requireAbility('ABILITY_MISTY_SURGE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateMisty, 0, makeTestDeps(), [])
    expect(stateMisty.field.statuses & STATUS_FIELD_MISTY_TERRAIN).toBeTruthy()

    const stateToxic = battle(
      [{ abilities: { ability: requireAbility('ABILITY_TOXIC_SURGE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateToxic, 0, makeTestDeps(), [])
    expect(stateToxic.field.statuses & STATUS_FIELD_TOXIC_TERRAIN).toBeTruthy()
  })

  it('Supercell sets both Electric Terrain and Rain', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SUPERCELL'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.statuses & STATUS_FIELD_ELECTRIC_TERRAIN).toBeTruthy()
    expect(state.field.weather & WEATHER_RAIN_TEMPORARY).toBeTruthy()
  })

  it('Zen Garden sets Grassy Terrain with Grassy Seed, Psychic with Psychic Seed, and 50/50 RNG otherwise', () => {
    const stateGrassySeed = battle(
      [{ itemId: 'ITEM_GRASSY_SEED', abilities: { ability: requireAbility('ABILITY_ZEN_GARDEN'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateGrassySeed, 0, makeTestDeps({ 0: 'HOLD_EFFECT_SEEDS' }), [])
    expect(stateGrassySeed.field.statuses & STATUS_FIELD_GRASSY_TERRAIN).toBeTruthy()

    const statePsychicSeed = battle(
      [{ itemId: 'ITEM_PSYCHIC_SEED', abilities: { ability: requireAbility('ABILITY_ZEN_GARDEN'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(statePsychicSeed, 0, makeTestDeps({ 0: 'HOLD_EFFECT_SEEDS' }), [])
    expect(statePsychicSeed.field.statuses & STATUS_FIELD_PSYCHIC_TERRAIN).toBeTruthy()

    const stateRngEven = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ZEN_GARDEN'), innates: [null, null, null] } }, {}],
      scriptedRng([0]),
    )
    applySwitchInAbilities(stateRngEven, 0, makeTestDeps(), [])
    expect(stateRngEven.field.statuses & STATUS_FIELD_GRASSY_TERRAIN).toBeTruthy()

    const stateRngOdd = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ZEN_GARDEN'), innates: [null, null, null] } }, {}],
      scriptedRng([1]),
    )
    applySwitchInAbilities(stateRngOdd, 0, makeTestDeps(), [])
    expect(stateRngOdd.field.statuses & STATUS_FIELD_PSYCHIC_TERRAIN).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // 2. Side and screen setters
  // -------------------------------------------------------------------------

  it('Air Blower sets Tailwind (3 turns) and disables Wind Rider on user and partner', () => {
    const state = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_AIR_BLOWER'), innates: [null, null, null] } },
        {},
        { abilities: { ability: requireAbility('ABILITY_WIND_RIDER'), innates: [null, null, null] } },
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[0]!.statuses & SIDE_STATUS_TAILWIND).toBeTruthy()
    expect(state.sides[0]!.timers.tailwindTimer).toBe(TAILWIND_DURATION_SHORT)
    expect(state.sides[0]!.timers.started.tailwind).toBe(true)
    expect(state.sides[0]!.timers.tailwindBattlerId).toBe(0)
    // Wind Rider on partner (battler 2) disabled
    expect(state.battlers[2]!.volatiles.switchInAbilityDone[0]).toBe(true)
  })

  it('Air Blower does not re-set Tailwind when already active', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_AIR_BLOWER'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    state.sides[0]!.statuses |= SIDE_STATUS_TAILWIND
    state.sides[0]!.timers.tailwindTimer = 2
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[0]!.timers.tailwindTimer).toBe(2)
  })

  it('Air Lock sets Tailwind, and Blistering Sun sets Tailwind plus Primal Sun', () => {
    const stateAirLock = battle(
      [{ abilities: { ability: requireAbility('ABILITY_AIR_LOCK'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateAirLock, 0, makeTestDeps(), [])
    expect(stateAirLock.sides[0]!.statuses & SIDE_STATUS_TAILWIND).toBeTruthy()

    const stateSun = battle(
      [{ abilities: { ability: requireAbility('ABILITY_BLISTERING_SUN'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateSun, 0, makeTestDeps(), [])
    expect(stateSun.sides[0]!.statuses & SIDE_STATUS_TAILWIND).toBeTruthy()
    expect(stateSun.field.weather & WEATHER_SUN_PRIMAL).toBeTruthy()
  })

  it('Spider Lair and Spider Lair Upgrade set Sticky Web on foe side (5 and 7 turns)', () => {
    const stateLair = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SPIDER_LAIR'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateLair, 0, makeTestDeps(), [])
    expect(stateLair.sides[1]!.statuses & SIDE_STATUS_STICKY_WEB).toBeTruthy()
    expect(stateLair.sides[1]!.timers.stickyWebTimer).toBe(5)
    expect(stateLair.sides[1]!.timers.started.spiderWeb).toBe(true)

    const stateUpgrade = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SPIDER_LAIR_UPGRADE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateUpgrade, 0, makeTestDeps(), [])
    expect(stateUpgrade.sides[1]!.statuses & SIDE_STATUS_STICKY_WEB).toBeTruthy()
    expect(stateUpgrade.sides[1]!.timers.stickyWebTimer).toBe(7)
  })

  it('Foamy Web sets Sticky Web (5 turns) on foe and foamyWeb flag on user side; does not set flag if already active', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_FOAMY_WEB'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[1]!.statuses & SIDE_STATUS_STICKY_WEB).toBeTruthy()
    expect(state.sides[1]!.timers.stickyWebTimer).toBe(5)
    expect(state.sides[0]!.timers.foamyWeb).toBe(true)

    const stateBlocked = battle(
      [{ abilities: { ability: requireAbility('ABILITY_FOAMY_WEB'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    stateBlocked.sides[1]!.statuses |= SIDE_STATUS_STICKY_WEB
    applySwitchInAbilities(stateBlocked, 0, makeTestDeps(), [])
    expect(stateBlocked.sides[0]!.timers.foamyWeb).toBe(false)
  })

  it('North Wind / Aurora Gale sets Aurora Veil (3 turns, 5 turns with Light Clay); fails if already active', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_NORTH_WIND'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[0]!.statuses & SIDE_STATUS_AURORA_VEIL).toBeTruthy()
    expect(state.sides[0]!.timers.auroraVeilTimer).toBe(SCREEN_DURATION_SHORT)
    expect(state.sides[0]!.timers.started.auroraVeil).toBe(true)

    const stateClay = battle(
      [{ abilities: { ability: requireAbility('ABILITY_AURORAS_GALE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateClay, 0, makeTestDeps({ 0: 'HOLD_EFFECT_LIGHT_CLAY' }), [])
    expect(stateClay.sides[0]!.timers.auroraVeilTimer).toBe(SCREEN_DURATION)

    // Fails to overwrite if already active
    const stateActive = battle(
      [{ abilities: { ability: requireAbility('ABILITY_NORTH_WIND'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    stateActive.sides[0]!.statuses |= SIDE_STATUS_AURORA_VEIL
    stateActive.sides[0]!.timers.auroraVeilTimer = 1
    applySwitchInAbilities(stateActive, 0, makeTestDeps(), [])
    expect(stateActive.sides[0]!.timers.auroraVeilTimer).toBe(1)
  })

  it('White Smoke sets the Smokescreen timer only (3 turns, Light Clay or not); fails if timer > 0', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_WHITE_SMOKE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    // abilities.cc:1367-1376 never sets SIDE_STATUS_SMOKESCREEN
    expect(state.sides[0]!.statuses & SIDE_STATUS_SMOKESCREEN).toBeFalsy()
    expect(state.sides[0]!.timers.smokescreenTimer).toBe(SCREEN_DURATION_SHORT)
    expect(state.sides[0]!.timers.started.smokescreen).toBe(true)
    expect(state.sides[0]!.timers.smokescreenBattler).toBe(0)

    const stateClay = battle(
      [{ abilities: { ability: requireAbility('ABILITY_WHITE_SMOKE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    // GetBattlerHoldEffect() == ITEM_LIGHT_CLAY compares a hold effect to an item id
    applySwitchInAbilities(stateClay, 0, makeTestDeps({ 0: 'HOLD_EFFECT_LIGHT_CLAY' }), [])
    expect(stateClay.sides[0]!.timers.smokescreenTimer).toBe(SCREEN_DURATION_SHORT)

    const stateActive = battle(
      [{ abilities: { ability: requireAbility('ABILITY_WHITE_SMOKE'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    stateActive.sides[0]!.timers.smokescreenTimer = 2
    applySwitchInAbilities(stateActive, 0, makeTestDeps(), [])
    expect(stateActive.sides[0]!.timers.smokescreenTimer).toBe(2)
  })

  it('Screen Cleaner clears Reflect, Light Screen, Aurora Veil, Smokescreen from both sides', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SCREEN_CLEANER'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    for (const side of [0, 1]) {
      state.sides[side]!.statuses |=
        SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL | SIDE_STATUS_SMOKESCREEN
      state.sides[side]!.timers.reflectTimer = 5
      state.sides[side]!.timers.lightscreenTimer = 5
      state.sides[side]!.timers.auroraVeilTimer = 5
      state.sides[side]!.timers.smokescreenTimer = 3
    }
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    for (const side of [0, 1]) {
      expect(state.sides[side]!.statuses & SIDE_STATUS_REFLECT).toBeFalsy()
      expect(state.sides[side]!.statuses & SIDE_STATUS_LIGHTSCREEN).toBeFalsy()
      expect(state.sides[side]!.statuses & SIDE_STATUS_AURORA_VEIL).toBeFalsy()
      expect(state.sides[side]!.statuses & SIDE_STATUS_SMOKESCREEN).toBeFalsy()
      expect(state.sides[side]!.timers.reflectTimer).toBe(0)
      expect(state.sides[side]!.timers.lightscreenTimer).toBe(0)
      expect(state.sides[side]!.timers.auroraVeilTimer).toBe(0)
      expect(state.sides[side]!.timers.smokescreenTimer).toBe(0)
    }
  })

  // -------------------------------------------------------------------------
  // 3. Field setters
  // -------------------------------------------------------------------------

  it('Atlas sets Gravity for 8 turns, and Gravity Well sets Gravity for 5 turns', () => {
    const stateAtlas = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ATLAS'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateAtlas, 0, makeTestDeps(), [])
    expect(stateAtlas.field.statuses & STATUS_FIELD_GRAVITY).toBeTruthy()
    expect(stateAtlas.field.timers.gravityTimer).toBe(GRAVITY_DURATION_EXTENDED)
    expect(stateAtlas.field.timers.started.gravity).toBe(true)

    const stateWell = battle(
      [{ abilities: { ability: requireAbility('ABILITY_GRAVITY_WELL'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateWell, 0, makeTestDeps(), [])
    expect(stateWell.field.statuses & STATUS_FIELD_GRAVITY).toBeTruthy()
    expect(stateWell.field.timers.gravityTimer).toBe(GRAVITY_DURATION)
  })

  it('Twisted Dimension sets Trick Room (3 turns), failing if already active', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_TWISTED_DIMENSION'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.statuses & STATUS_FIELD_TRICK_ROOM).toBeTruthy()
    expect(state.field.timers.trickRoomTimer).toBe(TRICK_ROOM_DURATION_SHORT)
    expect(state.field.timers.started.trickRoom).toBe(true)

    state.field.timers.trickRoomTimer = 1
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.timers.trickRoomTimer).toBe(1)
  })

  it('Inverse Room sets Inverse Room (3 turns), failing if already active', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_INVERSE_ROOM'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.statuses & STATUS_FIELD_INVERSE_ROOM).toBeTruthy()
    expect(state.field.timers.inverseRoomTimer).toBe(INVERSE_ROOM_DURATION_SHORT)
    expect(state.field.timers.started.inverseRoom).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 4. Hazard setters
  // -------------------------------------------------------------------------

  it('Rose Garden sets 2 layers of Toxic Spikes on opposing side', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_ROSE_GARDEN'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[1]!.statuses & SIDE_STATUS_TOXIC_SPIKES).toBeTruthy()
    expect(state.sides[1]!.timers.toxicSpikesAmount).toBe(2)
  })

  it('Watch Your Step adds 2 layers of Spikes (capped at 3) on opposing side', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_WATCH_YOUR_STEP'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[1]!.statuses & SIDE_STATUS_SPIKES).toBeTruthy()
    expect(state.sides[1]!.timers.spikesAmount).toBe(2)

    // Second activation adds 2 but caps at 3
    state.battlers[0]!.volatiles.switchInAbilityDone = [false, false, false, false]
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[1]!.timers.spikesAmount).toBe(3)
  })

  it('Swamp Thing sets Swamp for PLEDGE_DURATION (3 turns) on opposing side', () => {
    const state = battle(
      [{ abilities: { ability: requireAbility('ABILITY_SWAMP_THING'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[1]!.timers.swampTimer).toBe(PLEDGE_DURATION)
    expect(state.sides[1]!.timers.started.swamp).toBe(true)
  })

  // -------------------------------------------------------------------------
  // 5. Entry move abilities (UseEntryMove)
  // -------------------------------------------------------------------------

  it('Entry move abilities queue unmodelled gap messages when opponent is alive', () => {
    const unmodelled: string[] = []
    const stateTactics = battle(
      [{ abilities: { ability: requireAbility('ABILITY_CHEAP_TACTICS'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateTactics, 0, makeTestDeps(), unmodelled)
    expect(unmodelled).toContain(
      'battler 0: UseEntryMove (battle_util.c:3994-4019) is not modelled -- ABILITY_CHEAP_TACTICS queued MOVE_SCRATCH',
    )

    unmodelled.length = 0
    const stateThief = battle(
      [{ abilities: { ability: requireAbility('ABILITY_PHANTOM_THIEF'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateThief, 0, makeTestDeps(), unmodelled)
    expect(unmodelled).toContain(
      'battler 0: UseEntryMove (battle_util.c:3994-4019) is not modelled -- ABILITY_PHANTOM_THIEF queued MOVE_SPECTRAL_THIEF',
    )

    unmodelled.length = 0
    const stateHeart = battle(
      [{ abilities: { ability: requireAbility('ABILITY_CHANGE_OF_HEART'), innates: [null, null, null] } }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateHeart, 0, makeTestDeps(), unmodelled)
    expect(unmodelled).toContain(
      'battler 0: UseEntryMove (battle_util.c:3994-4019) is not modelled -- ABILITY_CHANGE_OF_HEART queued MOVE_HEART_SWAP',
    )
  })

  it('Entry move abilities do NOT queue unmodelled gap when opposing battler is fainted', () => {
    const unmodelled: string[] = []
    const state = battle(
      [
        { abilities: { ability: requireAbility('ABILITY_CHEAP_TACTICS'), innates: [null, null, null] } },
        { hp: 0 },
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), unmodelled)
    expect(unmodelled).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // 6. Innate-slot setters
  // -------------------------------------------------------------------------

  it('Innate ABILITY_GRASSY_SURGE in innates[0] sets Grassy Terrain', () => {
    const state = battle(
      [
        {
          abilities: {
            ability: null,
            innates: [requireAbility('ABILITY_GRASSY_SURGE'), null, null],
          },
        },
        {},
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.field.statuses & STATUS_FIELD_GRASSY_TERRAIN).toBeTruthy()
    expect(state.field.timers.terrainTimer).toBe(TERRAIN_DURATION)
  })

  it('Innate ABILITY_AIR_BLOWER in innates[1] sets Tailwind', () => {
    const state = battle(
      [
        {
          abilities: {
            ability: null,
            innates: [null, requireAbility('ABILITY_AIR_BLOWER'), null],
          },
        },
        {},
      ],
      scriptedRng(),
    )
    applySwitchInAbilities(state, 0, makeTestDeps(), [])
    expect(state.sides[0]!.statuses & SIDE_STATUS_TAILWIND).toBeTruthy()
    expect(state.sides[0]!.timers.tailwindTimer).toBe(TAILWIND_DURATION_SHORT)
  })

  // -------------------------------------------------------------------------
  // 7. Direct helper function tests
  // -------------------------------------------------------------------------

  it('tryChangeBattleTerrain helper correctly enforces terrain flags', () => {
    const state = battle([{}, {}], scriptedRng())
    const deps = makeTestDeps()

    expect(tryChangeBattleTerrain(state, 0, STATUS_FIELD_ELECTRIC_TERRAIN, deps)).toBe(true)
    expect(state.field.statuses & STATUS_FIELD_ELECTRIC_TERRAIN).toBeTruthy()

    // Same terrain fails
    expect(tryChangeBattleTerrain(state, 0, STATUS_FIELD_ELECTRIC_TERRAIN, deps)).toBe(false)

    // Permanent terrain blocks changes
    state.field.statuses |= STATUS_FIELD_TERRAIN_PERMANENT
    expect(tryChangeBattleTerrain(state, 0, STATUS_FIELD_GRASSY_TERRAIN, deps)).toBe(false)
  })

  it('trySetTailwind, trySetStickyWeb, trySetAuroraVeil, trySetSmokescreen helpers', () => {
    const state = battle([{}, {}], scriptedRng())
    const deps = makeTestDeps()

    expect(trySetTailwind(state, 0, 0, 3)).toBe(true)
    expect(trySetTailwind(state, 0, 0, 3)).toBe(false)

    expect(trySetStickyWeb(state, 1, 5, true)).toBe(true)
    expect(trySetStickyWeb(state, 1, 5, true)).toBe(false)

    expect(trySetAuroraVeil(state, 0, 0, deps)).toBe(true)
    expect(trySetAuroraVeil(state, 0, 0, deps)).toBe(false)

    expect(trySetSmokescreen(state, 0, 0)).toBe(true)
    expect(trySetSmokescreen(state, 0, 0)).toBe(false)
  })

  it('trySetGravity, trySetTrickRoom, trySetInverseRoom, trySetToxicSpikes, trySetSpikes, trySetSwamp helpers', () => {
    const state = battle([{}, {}], scriptedRng())

    expect(trySetGravity(state, 5)).toBe(true)
    expect(trySetGravity(state, 5)).toBe(false)

    expect(trySetTrickRoom(state, 3)).toBe(true)
    expect(trySetTrickRoom(state, 3)).toBe(false)

    expect(trySetInverseRoom(state, 3)).toBe(true)
    expect(trySetInverseRoom(state, 3)).toBe(false)

    expect(trySetToxicSpikes(state, 1, 2)).toBe(true)
    expect(trySetToxicSpikes(state, 1, 2)).toBe(false)

    expect(trySetSpikes(state, 1, 2)).toBe(true)
    expect(state.sides[1]!.timers.spikesAmount).toBe(2)
    expect(trySetSpikes(state, 1, 2)).toBe(true)
    expect(state.sides[1]!.timers.spikesAmount).toBe(3)
    expect(trySetSpikes(state, 1, 1)).toBe(false)

    expect(trySetSwamp(state, 1, 3)).toBe(true)
    expect(trySetSwamp(state, 1, 3)).toBe(false)
  })

  it('tryRemoveScreens helper returns true if screens removed, false otherwise', () => {
    const state = battle([{}, {}], scriptedRng())
    expect(tryRemoveScreens(state)).toBe(false)

    state.sides[0]!.statuses |= SIDE_STATUS_REFLECT
    state.sides[0]!.timers.reflectTimer = 5
    expect(tryRemoveScreens(state)).toBe(true)
    expect(state.sides[0]!.statuses & SIDE_STATUS_REFLECT).toBeFalsy()
    expect(state.sides[0]!.timers.reflectTimer).toBe(0)
    expect(tryRemoveScreens(state)).toBe(false)
  })

  it('disableSwitchInAbility marks switchInAbilityDone for the matching slot', () => {
    const state = battle(
      [
        {
          abilities: {
            ability: requireAbility('ABILITY_INTREPID_SWORD'),
            innates: [requireAbility('ABILITY_WIND_RIDER'), null, null],
          },
        },
        {},
      ],
      scriptedRng(),
    )
    disableSwitchInAbility(state, 0, 'ABILITY_WIND_RIDER', DATA_CONTEXT)
    expect(state.battlers[0]!.volatiles.switchInAbilityDone[1]).toBe(true)
    expect(state.battlers[0]!.volatiles.switchInAbilityDone[0]).toBe(false)
  })
})

