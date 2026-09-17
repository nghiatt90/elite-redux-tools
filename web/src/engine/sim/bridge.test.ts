import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import type { BattleState, SimBattleMon } from './state'
import type { GroundingContext } from './grounding'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { BridgeDeps } from './bridge'
import {
  GAP_REASONS,
  buildBattlerBattleState,
  buildFieldFacts,
  gapsToUnmodelled,
  statStageToExternal,
  statStagesToExternal,
  status1ToSet,
  terrainFromFieldStatuses,
  weatherFromBitfield,
} from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  NUM_BATTLE_STATS,
  STAT_ATK,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  WEATHER_HAIL_PERMANENT,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_NONE,
  WEATHER_RAIN_DOWNPOUR,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_PERMANENT,
  WEATHER_SUN_PRIMAL,
  WEATHER_SUN_TEMPORARY,
  setCounter,
  setFlag,
} from './constants'

const RATIOS: [number, number][] = [
  [2, 8],
  [2, 7],
  [2, 6],
  [2, 5],
  [2, 4],
  [2, 3],
  [1, 1],
  [3, 2],
  [4, 2],
  [5, 2],
  [6, 2],
  [7, 2],
  [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DEPS: BridgeDeps = { grounding: GROUNDING, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: RATIOS }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 70 },
    moves: ['MOVE_TACKLE', 'MOVE_WATER_GUN', null, null],
    pp: [35, 25, 0, 0],
    hp: 80,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: 'ABILITY_TORRENT', innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(overrides: Partial<SimBattleMon> = {}): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, mon(overrides), 0), createBattlerState(1, mon(), 0)],
    rng: createRandomSource(1),
  })
}

describe('stat stage conversion', () => {
  // A conversion tested only at its centre is tested nowhere: 6 -> 0 holds for
  // any offset that happens to be 6, and for a negated conversion too. Both
  // ends pin the direction AND the offset.
  it('maps the minimum, the neutral point and the maximum', () => {
    expect(statStageToExternal(MIN_STAT_STAGE)).toBe(-6)
    expect(statStageToExternal(DEFAULT_STAT_STAGE)).toBe(0)
    expect(statStageToExternal(MAX_STAT_STAGE)).toBe(6)
  })

  it('fails if the offset moves in EITHER direction', () => {
    // An offset of 5 would give -5/+1/+7; an offset of 7 would give -7/-1/+5.
    // Asserting the full span rules out both, and a negated conversion, which
    // a single mid-range value would not.
    const span = [MIN_STAT_STAGE, DEFAULT_STAT_STAGE, MAX_STAT_STAGE].map(statStageToExternal)
    expect(span).toEqual([-6, 0, 6])
  })

  it('is monotonic across the whole internal range', () => {
    const all = Array.from({ length: MAX_STAT_STAGE - MIN_STAT_STAGE + 1 }, (_, i) => statStageToExternal(MIN_STAT_STAGE + i))
    expect(all).toEqual([-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6])
  })

  it('reads each stat from its own index, not by position', () => {
    // The internal array is indexed by the STAT_* constants, where index 0 is
    // HP and 6/7 are accuracy/evasion. Reading it positionally into a 5-key
    // record would shift every stat by one.
    const internal = new Array<number>(NUM_BATTLE_STATS).fill(DEFAULT_STAT_STAGE)
    internal[STAT_ATK] = MAX_STAT_STAGE
    internal[STAT_SPEED] = MIN_STAT_STAGE
    const external = statStagesToExternal(internal)
    expect(external.atk).toBe(6)
    expect(external.spe).toBe(-6)
    expect(external.def).toBe(0)
    expect(external.spatk).toBe(0)
    expect(external.spdef).toBe(0)
  })

  it('drops accuracy and evasion, which have no BattleStatKey', () => {
    const internal = new Array<number>(NUM_BATTLE_STATS).fill(DEFAULT_STAT_STAGE)
    internal[6] = MAX_STAT_STAGE
    internal[7] = MAX_STAT_STAGE
    expect(Object.values(statStagesToExternal(internal)).every((v) => v === 0)).toBe(true)
  })
})

describe('weather collapse', () => {
  it('maps a single bit to its kind', () => {
    expect(weatherFromBitfield(WEATHER_SUN_TEMPORARY).weather).toBe('SUN_TEMPORARY')
    expect(weatherFromBitfield(WEATHER_SUN_PRIMAL).weather).toBe('SUN_PRIMAL')
    expect(weatherFromBitfield(WEATHER_NONE).weather).toBe('NONE')
  })

  it('collapses the two intensity bits of sandstorm, hail and fog onto one kind', () => {
    // WEATHER_KINDS has no separate tiers for these three.
    expect(weatherFromBitfield(WEATHER_SANDSTORM_PERMANENT).weather).toBe('SANDSTORM')
    expect(weatherFromBitfield(WEATHER_HAIL_TEMPORARY).weather).toBe('HAIL')
    expect(weatherFromBitfield(WEATHER_HAIL_PERMANENT).weather).toBe('HAIL')
    // Both hail bits at once is still one KIND, so not ambiguous.
    const both = weatherFromBitfield(setFlag(WEATHER_HAIL_TEMPORARY, WEATHER_HAIL_PERMANENT))
    expect(both.weather).toBe('HAIL')
    expect(both.gap).toBeNull()
  })

  it('gaps rather than picks when two KINDS are set', () => {
    // TryChangeBattleWeather assigns (battle_util.c:3731), so the game cannot
    // produce this and defines no precedence. Inventing one would be a guess.
    const r = weatherFromBitfield(setFlag(WEATHER_SUN_TEMPORARY, WEATHER_RAIN_TEMPORARY))
    expect(r.gap?.reason).toBe('AMBIGUOUS')
    expect(r.gap?.detail).toMatch(/precedence/)
  })

  it('gaps the unused downpour bit rather than folding it into rain', () => {
    const r = weatherFromBitfield(WEATHER_RAIN_DOWNPOUR)
    expect(r.gap?.reason).toBe('NO_SOURCE')
    expect(r.weather).toBe('NONE')
  })
})

describe('status1 unpacking', () => {
  it('reports a status that is present', () => {
    expect(status1ToSet(setFlag(0, STATUS1_BURN))).toEqual(new Set(['STATUS1_BURN']))
  })

  it('treats nonzero sleep turns as asleep and discards the count', () => {
    const asleep = setCounter(0, 0x7, 3)
    expect(status1ToSet(asleep)).toEqual(new Set(['STATUS1_SLEEP']))
  })

  it('discards the toxic counter but keeps the toxic flag', () => {
    const toxic = setCounter(setFlag(0, STATUS1_TOXIC_POISON), STATUS1_TOXIC_COUNTER, 5)
    expect(status1ToSet(toxic)).toEqual(new Set(['STATUS1_TOXIC_POISON']))
  })

  it('carries ER-specific statuses the calculator knows about', () => {
    expect(status1ToSet(setFlag(0, STATUS1_BLEED)).has('STATUS1_BLEED')).toBe(true)
  })
})

describe('terrain', () => {
  it('maps a terrain bit and returns null for none', () => {
    expect(terrainFromFieldStatuses(0)).toBeNull()
    expect(terrainFromFieldStatuses(STATUS_FIELD_ELECTRIC_TERRAIN)).toBe('TERRAIN_ELECTRIC')
  })
})

describe('buildBattlerBattleState: what it derives', () => {
  it('carries the fields that come straight from the sim mon', () => {
    const state = battle()
    const { battler } = buildBattlerBattleState(state, 0, DEPS)
    expect(battler.level).toBe(50)
    expect(battler.nature).toBe('NATURE_HARDY')
    expect(battler.rawStats.atk).toBe(100)
    expect(battler.gender).toBe('MALE')
    expect(battler.abilitySlots.ability).toBe('ABILITY_TORRENT')
    expect(battler.condition.hp).toBe(80)
    expect(battler.condition.maxHp).toBe(100)
    expect(battler.condition.speciesId).toBe('SPECIES_MUDKIP')
  })

  it('builds moveSlotPp from the parallel move and pp arrays', () => {
    const { battler } = buildBattlerBattleState(battle(), 0, DEPS)
    expect(battler.moveSlotPp).toEqual({ MOVE_TACKLE: 35, MOVE_WATER_GUN: 25 })
  })

  it('derives Speed through the ported stat path rather than the raw stat', () => {
    // rawStats.spe is 70; a +2 Speed stage must change this, which it would not
    // if the bridge copied the raw value.
    const state = battle()
    state.battlers[0]!.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE + 2
    const { battler } = buildBattlerBattleState(state, 0, DEPS)
    expect(battler.condition.speed).toBe(140)
    expect(battler.statStages.spe).toBe(2)
  })

  it('derives grounding through the real port', () => {
    const flying = battle({ types: ['FLYING', 'MYSTERY', 'MYSTERY'] })
    expect(buildBattlerBattleState(flying, 0, DEPS).battler.isGrounded).toBe(false)
    expect(buildBattlerBattleState(battle(), 0, DEPS).battler.isGrounded).toBe(true)
  })

  it('derives alliesFainted from the count the turn loop maintains', () => {
    const state = battle()
    state.sides[0].faintedCount = 3
    expect(buildBattlerBattleState(state, 0, DEPS).battler.alliesFainted).toBe(3)
  })

  it('counts raised and lowered stages separately', () => {
    const state = battle()
    state.battlers[0]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
    state.battlers[0]!.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE - 3
    const { battler } = buildBattlerBattleState(state, 0, DEPS)
    expect(battler.condition.positiveStatStageCount).toBe(2)
    expect(battler.condition.negativeStatStageCount).toBe(3)
  })
})

describe('buildBattlerBattleState: what it reports as a gap', () => {
  it('returns a gap for every field it did not derive', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, DEPS)
    expect(gaps.length).toBeGreaterThan(0)
    for (const g of gaps) {
      expect(GAP_REASONS).toContain(g.reason)
      expect(g.detail.length).toBeGreaterThan(0)
    }
  })

  it('gaps state the sim has but never updates, rather than passing its zero off as an answer', () => {
    // The rule this module exists for. These fields are PRESENT in the state
    // model and correctly zeroed; they are still gaps, because nothing in the
    // sim ever writes them and a mapped `false` would be indistinguishable from
    // a modelled one.
    const { gaps } = buildBattlerBattleState(battle(), 0, DEPS)
    const neverUpdated = gaps.filter((g) => g.reason === 'NEVER_UPDATED').map((g) => g.field)
    expect(neverUpdated).toContain('condition.wasDamagedThisTurnBy')
    expect(neverUpdated).toContain('condition.helpingHand')
    expect(neverUpdated).toContain('condition.safePassage')
    expect(neverUpdated).toContain('isTransformed')
  })

  it('gaps the four fields with no honest source anywhere', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, DEPS)
    const noSource = gaps.filter((g) => g.reason === 'NO_SOURCE').map((g) => g.field)
    expect(noSource).toEqual(expect.arrayContaining(['abilityOn', 'boostedStat', 'condition.lastMoveFailed']))
  })

  it('gaps everything that needs the data context, which batch 1 does not take', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, DEPS)
    const needsData = gaps.filter((g) => g.reason === 'NEEDS_DATA').map((g) => g.field)
    expect(needsData).toEqual(expect.arrayContaining(['condition.weight', 'condition.resolvedHoldEffect', 'holdEffectStrength', 'canEvolveStrict']))
  })

  it('never reports the same field twice', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, DEPS)
    expect(new Set(gaps.map((g) => g.field)).size).toBe(gaps.length)
  })

  it('does not gap anything it actually derived', () => {
    // The two lists must be disjoint, or a gap is noise and a derived value is
    // a lie.
    const { gaps } = buildBattlerBattleState(battle(), 0, DEPS)
    const gapped = new Set(gaps.map((g) => g.field))
    for (const derived of ['level', 'nature', 'rawStats', 'statStages', 'gender', 'isGrounded', 'alliesFainted', 'moveSlotPp', 'abilitySlots', 'types']) {
      expect(gapped.has(derived)).toBe(false)
    }
    for (const derived of ['condition.hp', 'condition.maxHp', 'condition.speed', 'condition.speciesId', 'condition.status1']) {
      expect(gapped.has(derived)).toBe(false)
    }
  })

  it('formats gaps for the damage engine own unmodelled channel', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, DEPS)
    const lines = gapsToUnmodelled(gaps)
    expect(lines).toHaveLength(gaps.length)
    expect(lines[0]).toMatch(/^[\w.]+: .+ \((NEVER_UPDATED|NO_SOURCE|NEEDS_DATA|AMBIGUOUS)\)$/)
  })
})

describe('buildFieldFacts', () => {
  it('derives weather, terrain and gravity, and passes a weather gap through', () => {
    const state = battle()
    state.field.weather = WEATHER_SUN_PRIMAL
    state.field.statuses = STATUS_FIELD_ELECTRIC_TERRAIN
    const facts = buildFieldFacts(state, DEPS)
    expect(facts.weather).toBe('SUN_PRIMAL')
    expect(facts.terrain).toBe('TERRAIN_ELECTRIC')
    expect(facts.gravityActive).toBe(false)
    expect(facts.gaps).toEqual([])

    state.field.weather = setFlag(WEATHER_SUN_TEMPORARY, WEATHER_RAIN_TEMPORARY)
    expect(buildFieldFacts(state, DEPS).gaps).toHaveLength(1)
  })
})
