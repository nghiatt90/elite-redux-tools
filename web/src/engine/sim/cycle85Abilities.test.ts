// Switch-in ability ports checked against the C: cycle 85.
// Group 1: Water Veil, Purifying Waters, Pastel Veil, Coward, Hot Coals, Pickup,
//          Parasitic Spores, Readied Action, Demolitionist, Salt Circle, Headstrong,
//          Wind Rider, Lawnmower, Turf War, Curse of Famine, Rejection, Gallantry.
// Group 2: Low Visibility, Generator, Energized, Toxic Boost, Flare Boost, Toxic Spill, Trash Heap.

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { applySwitchInAbilities } from './switchInAbility'
import type { GroundingContext } from './grounding'
import type { SimDataContext } from './dataContext'
import { runEndTurnEffects } from './endTurn'
import {
  DEFAULT_STAT_STAGE,
  QUASH_DURATION,
  SCREEN_DURATION,
  SIDE_STATUS_HAZARDS_ANY,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TAILWIND,
  STAT_ATK,
  STAT_DEF,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_POISON,
  STATUS2_ESCAPE_PREVENTION,
  STATUS3_AQUA_RING,
  STATUS3_CHARGED_UP,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_DURATION,
  WEATHER_DURATION_EXTENDED,
  WEATHER_FOG_TEMPORARY,
  WEATHER_SUN_PRIMAL,
  hasFlag,
  setFlag,
} from './constants'

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: () => undefined,
  move: () => undefined,
}

const entryDeps = {
  grounding: GROUNDING,
  dataContext: DATA_CONTEXT,
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

function battle(
  specs: {
    spe?: number
    atk?: number
    def?: number
    spatk?: number
    spdef?: number
    hp?: number
    maxHp?: number
    speciesId?: string
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    types?: [string, string, string]
    itemId?: string | null
    gender?: SimBattleMon['gender']
    status1?: number
    status2?: number
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: {
            atk: s.atk ?? 100,
            def: s.def ?? 90,
            spatk: s.spatk ?? 80,
            spdef: s.spdef ?? 85,
            spe: s.spe ?? (i === 0 ? 100 : 50),
          },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

function countingRng(): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return 0
    },
  }
  return r
}

describe('Cycle 85 Group 1: side and status setters', () => {
  it('Water Veil and Purifying Waters set STATUS3_AQUA_RING on user', () => {
    for (const ability of ['ABILITY_WATER_VEIL', 'ABILITY_PURIFYING_WATERS']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], countingRng())
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, entryDeps, unmodelled)
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_AQUA_RING)).toBe(true)
      expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

      // Idempotent: already set
      applySwitchInAbilities(state, 0, entryDeps, unmodelled)
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_AQUA_RING)).toBe(true)
    }
  })

  it('Pastel Veil sets SIDE_STATUS_SAFEGUARD and 5-turn timer on user side', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_PASTEL_VEIL') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SAFEGUARD)).toBe(true)
    expect(state.sides[0].timers.safeguardTimer).toBe(SCREEN_DURATION) // 5
    expect(state.sides[0].timers.safeguardBattlerId).toBe(0)
    expect(state.sides[0].timers.started.safeguard).toBe(true)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Gate: does not overwrite if already set
    state.sides[0].timers.safeguardTimer = 3
    const state2 = battle([{ abilities: hasAbility('ABILITY_PASTEL_VEIL') }, {}], countingRng())
    state2.sides[0].statuses = setFlag(0, SIDE_STATUS_SAFEGUARD)
    state2.sides[0].timers.safeguardTimer = 2
    applySwitchInAbilities(state2, 0, entryDeps, [])
    expect(state2.sides[0].timers.safeguardTimer).toBe(2)
  })

  it('Coward sets protectMove on round and uses once-per-battle counter', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_COWARD') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(state.battlers[0]!.round.protectMove).toBe('MOVE_PROTECT')
    expect(state.singleUseAbility[0][0][0]).toBe(1)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Second switch-in: counter prevents re-activation
    state.battlers[0]!.round.protectMove = null
    state.battlers[0]!.volatiles.switchInAbilityDone[0] = false
    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(state.battlers[0]!.round.protectMove).toBeNull()
  })

  it('Hot Coals sets hotCoals on opposing side', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_HOT_COALS') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(state.sides[1].timers.hotCoals).toBe(true)
    expect(state.sides[0].timers.hotCoals).toBe(false)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])
  })

  it('Pickup clears all clearable hazards and coals/caltrops on user side', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_PICKUP') }, {}], countingRng())
    state.sides[0].statuses = setFlag(0, SIDE_STATUS_HAZARDS_ANY)
    state.sides[0].timers.spikesAmount = 3
    state.sides[0].timers.toxicSpikesAmount = 2
    state.sides[0].timers.hotCoals = true
    state.sides[0].timers.caltrops = true

    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_HAZARDS_ANY)).toBe(false)
    expect(state.sides[0].timers.spikesAmount).toBe(0)
    expect(state.sides[0].timers.toxicSpikesAmount).toBe(0)
    expect(state.sides[0].timers.hotCoals).toBe(false)
    expect(state.sides[0].timers.caltrops).toBe(false)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])
  })

  it('Pickup respects foamyWeb gate, preserving Sticky Web', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_PICKUP') }, {}], countingRng())
    state.sides[0].statuses = setFlag(0, SIDE_STATUS_SPIKES | SIDE_STATUS_STICKY_WEB)
    state.sides[0].timers.foamyWeb = true

    applySwitchInAbilities(state, 0, entryDeps, [])
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
  })

  it('Parasitic Spores sets volatile flag on switch-in and damages end-turn', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_PARASITIC_SPORES') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(state.battlers[0]!.volatiles.parasiticSpores).toBe(true)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // End-turn damage: maxHP / 8 = 100 / 8 = 12 dmg
    const { results } = runEndTurnEffects(state, [0, 1], DATA_CONTEXT, { grounding: GROUNDING })
    const sporeResult = results.find((r) => r.effect === 'PARASITIC_SPORES')
    expect(sporeResult).toBeDefined()
    expect(sporeResult?.hpChange).toBe(-12)
    expect(state.battlers[0]!.mon.hp).toBe(88)

    // Ghost type is immune
    const ghostState = battle([{ abilities: hasAbility('ABILITY_PARASITIC_SPORES'), types: ['GHOST', 'MYSTERY', 'MYSTERY'] }, {}], countingRng())
    applySwitchInAbilities(ghostState, 0, entryDeps, [])
    const ghostRes = runEndTurnEffects(ghostState, [0, 1], DATA_CONTEXT, { grounding: GROUNDING })
    expect(ghostRes.results.find((r) => r.effect === 'PARASITIC_SPORES')).toBeUndefined()
    expect(ghostState.battlers[0]!.mon.hp).toBe(100)
  })

  it('Readied Action and Demolitionist set readiedAction volatiles', () => {
    for (const ability of ['ABILITY_READIED_ACTION', 'ABILITY_DEMOLITIONIST']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], countingRng())
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, entryDeps, unmodelled)
      expect(state.battlers[0]!.volatiles.readiedAction).toBe(true)
      expect(state.battlers[0]!.volatiles.started.readiedAction).toBe(true)
      expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])
    }
  })

  it('Salt Circle traps opposing battlers with STATUS2_ESCAPE_PREVENTION', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_SALT_CIRCLE') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(state.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])
  })

  it('Headstrong raises SpDef by 1 stage', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_HEADSTRONG') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Gate: does not raise beyond stage 12
    const capped = battle([{ abilities: hasAbility('ABILITY_HEADSTRONG') }, {}], countingRng())
    capped.battlers[0]!.mon.statStages[STAT_SPDEF] = 12
    applySwitchInAbilities(capped, 0, entryDeps, [])
    expect(capped.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(12)
  })

  it('Wind Rider raises highest attacking stat by 1 stage when Tailwind is active', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_WIND_RIDER'), atk: 120, spatk: 80 }, {}], countingRng())
    state.sides[0].statuses = setFlag(0, SIDE_STATUS_TAILWIND)
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Negative: without Tailwind, does not raise
    const noTailwind = battle([{ abilities: hasAbility('ABILITY_WIND_RIDER') }, {}], countingRng())
    applySwitchInAbilities(noTailwind, 0, entryDeps, [])
    expect(noTailwind.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Lawnmower removes terrain and raises Def (Grassy) or SpDef (Psychic)', () => {
    // Grassy -> Def
    const grassyState = battle([{ abilities: hasAbility('ABILITY_LAWNMOWER') }, {}], countingRng())
    grassyState.field.statuses = setFlag(0, STATUS_FIELD_GRASSY_TERRAIN)
    applySwitchInAbilities(grassyState, 0, entryDeps, [])
    expect(hasFlag(grassyState.field.statuses, STATUS_FIELD_TERRAIN_ANY)).toBe(false)
    expect(grassyState.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)

    // Psychic -> SpDef
    const psychState = battle([{ abilities: hasAbility('ABILITY_LAWNMOWER') }, {}], countingRng())
    psychState.field.statuses = setFlag(0, STATUS_FIELD_PSYCHIC_TERRAIN)
    applySwitchInAbilities(psychState, 0, entryDeps, [])
    expect(hasFlag(psychState.field.statuses, STATUS_FIELD_TERRAIN_ANY)).toBe(false)
    expect(psychState.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)

    // Negative: no terrain
    const noTerrain = battle([{ abilities: hasAbility('ABILITY_LAWNMOWER') }, {}], countingRng())
    applySwitchInAbilities(noTerrain, 0, entryDeps, [])
    expect(noTerrain.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Turf War removes terrain and raises highest stat by 1', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_TURF_WAR'), spe: 130 }, {}], countingRng())
    state.field.statuses = setFlag(0, STATUS_FIELD_GRASSY_TERRAIN)
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_ANY)).toBe(false)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])
  })

  it('Curse of Famine removes terrain, boosts Def/SpDef, and heals 1/4 max HP', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_CURSE_OF_FAMINE'), hp: 50, maxHp: 100 }, {}], countingRng())
    state.field.statuses = setFlag(0, STATUS_FIELD_GRASSY_TERRAIN)
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_ANY)).toBe(false)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.hp).toBe(75) // 50 + 25 = 75
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Gate: Bleed blocks heal
    const bleedState = battle([{ abilities: hasAbility('ABILITY_CURSE_OF_FAMINE'), hp: 50, maxHp: 100, status1: STATUS1_BLEED }, {}], countingRng())
    bleedState.field.statuses = setFlag(0, STATUS_FIELD_GRASSY_TERRAIN)
    applySwitchInAbilities(bleedState, 0, entryDeps, [])
    expect(bleedState.battlers[0]!.mon.hp).toBe(50) // Heal blocked
  })

  it('Rejection sets quashTimer to 5', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_REJECTION') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(state.field.timers.quashTimer).toBe(QUASH_DURATION) // 5
    expect(state.field.timers.started.quash).toBe(true)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Gate: does not overwrite active timer
    state.field.timers.quashTimer = 2
    const state2 = battle([{ abilities: hasAbility('ABILITY_REJECTION') }, {}], countingRng())
    state2.field.timers.quashTimer = 2
    applySwitchInAbilities(state2, 0, entryDeps, [])
    expect(state2.field.timers.quashTimer).toBe(2)
  })

  it('Gallantry produces no state changes and clears onEntry gap note', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_GALLANTRY') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])
  })
})

describe('Cycle 85 Group 2: weather, terrain, and charge', () => {
  it('Low Visibility sets Fog weather for 8 turns (12 with Smoke Ball)', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_LOW_VISIBILITY') }, {}], countingRng())
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(hasFlag(state.field.weather, WEATHER_FOG_TEMPORARY)).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION) // 8
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Extended with Smoke Ball
    const smokeBallDeps = {
      grounding: { ...GROUNDING, holdEffectOf: () => 'HOLD_EFFECT_SMOKE_BALL' },
      dataContext: DATA_CONTEXT,
    }
    const smokeState = battle([{ abilities: hasAbility('ABILITY_LOW_VISIBILITY') }, {}], countingRng())
    applySwitchInAbilities(smokeState, 0, smokeBallDeps, [])
    expect(smokeState.field.weatherDuration).toBe(WEATHER_DURATION_EXTENDED) // 12

    // Gate: blocked by primal weather
    const primalState = battle([{ abilities: hasAbility('ABILITY_LOW_VISIBILITY') }, {}], countingRng())
    primalState.field.weather = WEATHER_SUN_PRIMAL
    applySwitchInAbilities(primalState, 0, entryDeps, [])
    expect(primalState.field.weather).toBe(WEATHER_SUN_PRIMAL)
  })

  it('Generator and Energized charge up in Electric Terrain without consuming counter', () => {
    for (const ability of ['ABILITY_GENERATOR', 'ABILITY_ENERGIZED']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], countingRng())
      state.field.statuses = setFlag(0, STATUS_FIELD_ELECTRIC_TERRAIN)
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, entryDeps, unmodelled)
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
      expect(state.singleUseAbility[0][0][0]).toBe(0) // Counter NOT consumed
      expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])
    }
  })

  it('Generator and Energized charge up once per battle without Electric Terrain', () => {
    for (const ability of ['ABILITY_GENERATOR', 'ABILITY_ENERGIZED']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], countingRng())
      applySwitchInAbilities(state, 0, entryDeps, [])
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
      expect(state.singleUseAbility[0][0][0]).toBe(1) // Counter consumed

      // Subsequent switch-in without terrain cannot activate
      state.battlers[0]!.statuses3 = 0
      state.battlers[0]!.volatiles.switchInAbilityDone[0] = false
      applySwitchInAbilities(state, 0, entryDeps, [])
      expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(false)
    }
  })

  it('Toxic Boost poisons grounded bearer in Toxic Terrain', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_TOXIC_BOOST') }, {}], countingRng())
    state.field.statuses = setFlag(0, STATUS_FIELD_TOXIC_TERRAIN)
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_POISON)).toBe(true)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Negative: without terrain, no poison
    const noTerrain = battle([{ abilities: hasAbility('ABILITY_TOXIC_BOOST') }, {}], countingRng())
    applySwitchInAbilities(noTerrain, 0, entryDeps, [])
    expect(hasFlag(noTerrain.battlers[0]!.mon.status1, STATUS1_POISON)).toBe(false)

    // Negative: Steel type immune
    const steelState = battle([{ abilities: hasAbility('ABILITY_TOXIC_BOOST'), types: ['STEEL', 'MYSTERY', 'MYSTERY'] }, {}], countingRng())
    steelState.field.statuses = setFlag(0, STATUS_FIELD_TOXIC_TERRAIN)
    applySwitchInAbilities(steelState, 0, entryDeps, [])
    expect(hasFlag(steelState.battlers[0]!.mon.status1, STATUS1_POISON)).toBe(false)
  })

  it('Flare Boost burns bearer in Fog', () => {
    const state = battle([{ abilities: hasAbility('ABILITY_FLARE_BOOST') }, {}], countingRng())
    state.field.weather = WEATHER_FOG_TEMPORARY
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, entryDeps, unmodelled)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])

    // Negative: without Fog, no burn
    const noFog = battle([{ abilities: hasAbility('ABILITY_FLARE_BOOST') }, {}], countingRng())
    applySwitchInAbilities(noFog, 0, entryDeps, [])
    expect(hasFlag(noFog.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)

    // Negative: Fire type immune
    const fireState = battle([{ abilities: hasAbility('ABILITY_FLARE_BOOST'), types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, {}], countingRng())
    fireState.field.weather = WEATHER_FOG_TEMPORARY
    applySwitchInAbilities(fireState, 0, entryDeps, [])
    expect(hasFlag(fireState.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)
  })

  it('Toxic Spill and Trash Heap clear onEntry gap note', () => {
    for (const ability of ['ABILITY_TOXIC_SPILL', 'ABILITY_TRASH_HEAP']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], countingRng())
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, entryDeps, unmodelled)
      expect(unmodelled.filter((n) => n.includes('onEntry hook was not run'))).toEqual([])
    }
  })
})
