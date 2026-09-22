import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import type { BattleState, SimBattleMon } from './state'
import type { GroundingContext } from './grounding'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import { isBattlerGrounded } from './grounding'
import type { BridgeDeps, CalculationRoles } from './bridge'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'
import {
  GAP_REASONS,
  buildBattlerBattleState,
  buildFieldSides,
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
  STATUS2_TRANSFORMED,
  STATUS3_MIRACLE_EYED,
  STATUS4_FEAR,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRAVITY,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_LUCKY_CHANT,
  SIDE_STATUS_REFLECT,
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
  statusInfatuatedWith,
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

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const speciesData = snapshot<Array<Record<string, unknown>>>('species.json')
const itemData = snapshot<Array<Record<string, unknown>>>('items.json')
const speciesById = new Map(speciesData.map((entry) => [entry.id as string, entry]))
const itemsById = new Map(itemData.map((entry) => [entry.id as string, entry]))
const DATA_CONTEXT: SimDataContext = {
  species: (id) => {
    const entry = speciesById.get(id)
    return entry as unknown as SimSpeciesData | undefined
  },
  item: (id) => {
    const entry = itemsById.get(id)
    return entry as unknown as SimItemData | undefined
  },
  move: () => undefined,
}
const DEPS: BridgeDeps = { grounding: GROUNDING, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }

/** Battler 0 attacking battler 1, unless a test says otherwise. */
const ROLES: CalculationRoles = { attackerId: 0, defenderId: 1 }

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
    const { battler } = buildBattlerBattleState(state, 0, ROLES, DEPS)
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
    const { battler } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    expect(battler.moveSlotPp).toEqual({ MOVE_TACKLE: 35, MOVE_WATER_GUN: 25 })
  })

  it('derives Speed through the ported stat path rather than the raw stat', () => {
    // rawStats.spe is 70; a +2 Speed stage must change this, which it would not
    // if the bridge copied the raw value.
    const state = battle()
    state.battlers[0]!.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE + 2
    const { battler } = buildBattlerBattleState(state, 0, ROLES, DEPS)
    expect(battler.condition.speed).toBe(140)
    expect(battler.statStages.spe).toBe(2)
  })

  it('supplies the SPECIES-ONLY grounding baseline, not the full port', () => {
    const flying = battle({ types: ['FLYING', 'MYSTERY', 'MYSTERY'] })
    expect(buildBattlerBattleState(flying, 0, ROLES, DEPS).battler.isGrounded).toBe(false)
    expect(buildBattlerBattleState(battle(), 0, ROLES, DEPS).battler.isGrounded).toBe(true)
  })

  it('does not fold Levitate into isGrounded, because calculate.ts does that itself', () => {
    // The case that inverts. sim/grounding.ts's full port says a Levitate holder
    // is NOT grounded; calculate.ts:720-723 applies Levitate itself and does so
    // mould-breaker-aware, so this field must stay the species baseline. Feeding
    // the full answer here would make a Mold Breaker Earthquake read as immune
    // against a Levitate defender that it should hit.
    const state = battle()
    state.battlers[0]!.mon.abilities = { ability: 'ABILITY_LEVITATE', innates: [null, null, null] }

    // The simulator's own answer, for its own consumers: airborne.
    expect(isBattlerGrounded(state, 0, GROUNDING)).toBe(false)
    // ...and with a mould-breaking attacker, grounded again.
    expect(isBattlerGrounded(state, 0, { ...GROUNDING, attackerHasMoldBreaker: true })).toBe(true)

    // The scenario field is neither of those: it is the species baseline, and a
    // non-Flying Levitate holder is `true` regardless of Mold Breaker, because
    // this field does not know about abilities at all.
    expect(buildBattlerBattleState(state, 0, ROLES, DEPS).battler.isGrounded).toBe(true)
  })

  it('does not fold Gravity or Iron Ball into isGrounded either', () => {
    // Both are calculate.ts's forced-grounded branch, and its Iron Ball check
    // reads condition.resolvedHoldEffect -- which this batch gaps to null. The
    // full port applies Iron Ball from a hold effect the scenario does not yet
    // carry, so applying it here would put half of one mechanic on each side of
    // the boundary.
    const flying = battle({ types: ['FLYING', 'MYSTERY', 'MYSTERY'] })
    flying.field.statuses = setFlag(flying.field.statuses, STATUS_FIELD_GRAVITY)
    expect(isBattlerGrounded(flying, 0, GROUNDING)).toBe(true)
    expect(buildBattlerBattleState(flying, 0, ROLES, DEPS).battler.isGrounded).toBe(false)
  })

  it('derives alliesFainted from the count the turn loop maintains', () => {
    const state = battle()
    state.sides[0].faintedCount = 3
    expect(buildBattlerBattleState(state, 0, ROLES, DEPS).battler.alliesFainted).toBe(3)
  })

  it('counts raised and lowered stages separately', () => {
    const state = battle()
    state.battlers[0]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
    state.battlers[0]!.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE - 3
    const { battler } = buildBattlerBattleState(state, 0, ROLES, DEPS)
    expect(battler.condition.positiveStatStageCount).toBe(2)
    expect(battler.condition.negativeStatStageCount).toBe(3)
  })
})

describe('buildBattlerBattleState: what it reports as a gap', () => {
  /** Walks a dotted path and reports whether the KEY exists -- not whether it is
   * truthy, since a legitimate gap placeholder is often null. */
  function pathExists(root: unknown, path: string): boolean {
    let node: unknown = root
    for (const part of path.split('.')) {
      if (typeof node !== 'object' || node === null || !(part in node)) return false
      node = (node as Record<string, unknown>)[part]
    }
    return true
  }

  /** The gap list, asserted EXACTLY. The list is data specifically so batches 2
   * and 3 delete entries from it as they fill fields in; a membership check
   * would pass just as well if they deleted nothing, which is the drift the
   * list exists to prevent. Update this when a gap is genuinely closed. */
  const EXPECTED_GAP_FIELDS = [
    'abilityOn',
    'boostedStat',
    'condition.chargedUp',
    'condition.fear',
    'condition.ghastlyEcho',
    'condition.helpingHand',
    'condition.isConfused',
    'condition.isEnraged',
    'condition.isInfatuated',
    'condition.itemNegated',
    'condition.lastMoveFailed',
    'condition.meFirst',
    'condition.negativeStatStageCount',
    'condition.positiveStatStageCount',
    'condition.recentlyFainted',
    'condition.safePassage',
    'condition.speed',
    'condition.wasDamagedThisTurnBy',
    'extraStatLevel',
    'hasMiracleEye',
    'isInfatuatedWithOpponent',
    'isTransformed',
    'semiInvulnerable',
    'slowStartTimer',
    'statStages',
  ]

  it('reports EXACTLY the expected gap list, no more and no fewer', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    expect(gaps.map((g) => g.field).sort()).toEqual([...EXPECTED_GAP_FIELDS].sort())
  })

  it('every gap names a field that actually exists on the built scenario', () => {
    // Catches a gap left behind under a renamed or removed field, which a
    // membership check cannot see.
    const { battler, gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    for (const g of gaps) {
      expect(pathExists(battler, g.field), `${g.field} does not resolve on BattlerBattleState`).toBe(true)
    }
  })

  it('returns a gap for every field it did not derive', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
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
    const { battler, gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    const neverUpdated = gaps.filter((g) => g.reason === 'NEVER_UPDATED').map((g) => g.field)
    expect(neverUpdated).toContain('condition.wasDamagedThisTurnBy')
    expect(neverUpdated).toContain('condition.helpingHand')
    expect(neverUpdated).toContain('condition.safePassage')
    expect(neverUpdated).toContain('isTransformed')

    // The other half, which the comment claimed and nothing asserted: these
    // really are present and zeroed on a fresh battler. That is what makes them
    // dangerous -- a consumer reading the value alone sees a modelled answer.
    expect(battler.condition.wasDamagedThisTurnBy).toBe('none')
    expect(battler.condition.helpingHand).toBe(false)
    expect(battler.condition.safePassage).toBe(false)
    expect(battler.isTransformed).toBe(false)
  })

  it('gaps the four fields with no honest source anywhere', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    const noSource = gaps.filter((g) => g.reason === 'NO_SOURCE').map((g) => g.field)
    expect(noSource).toEqual(expect.arrayContaining(['abilityOn', 'boostedStat', 'condition.lastMoveFailed']))
  })

  it('derives everything available from the committed data context', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    const needsData = gaps.filter((g) => g.reason === 'NEEDS_DATA').map((g) => g.field)
    expect(needsData).toEqual([])
  })

  it('never reports the same field twice', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    expect(new Set(gaps.map((g) => g.field)).size).toBe(gaps.length)
  })

  it('does not gap anything it actually derived', () => {
    // The two lists must be disjoint, or a gap is noise and a derived value is
    // a lie.
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    const gapped = new Set(gaps.map((g) => g.field))
    // statStages, condition.speed and the two stage counts are NOT in this list
    // any more: they moved to the gap side, because no battle-start source can
    // set a stage and createBattlerState:364 overwrites one that is passed.
    for (const derived of ['level', 'nature', 'rawStats', 'gender', 'isGrounded', 'alliesFainted', 'moveSlotPp', 'abilitySlots', 'types']) {
      expect(gapped.has(derived)).toBe(false)
    }
    for (const derived of ['condition.hp', 'condition.maxHp', 'condition.speciesId', 'condition.status1']) {
      expect(gapped.has(derived)).toBe(false)
    }
  })

  it('gaps stat stages and everything computed from them', () => {
    // The discriminator: can a real battle-start source set this? encounters
    // and trainer parties set weather, terrain, status and full PP; NOTHING
    // sets a stat stage, and the constructor destroys one that is passed. So
    // this is not "right at battle start then stale" -- it is unsettable, and
    // the three fields computed from it inherit that.
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    const gapped = new Set(gaps.filter((g) => g.reason === 'NEVER_UPDATED').map((g) => g.field))
    expect(gapped.has('statStages')).toBe(true)
    expect(gapped.has('condition.speed')).toBe(true)
    expect(gapped.has('condition.positiveStatStageCount')).toBe(true)
    expect(gapped.has('condition.negativeStatStageCount')).toBe(true)
  })

  it('does NOT gap PP or status, which a trainer party really does set', () => {
    // The other side of the same discriminator. A Pokemon can enter battle
    // burned and with full PP, so these are derived; they carry a staleness
    // note instead, like weather.
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    const gapped = new Set(gaps.map((g) => g.field))
    expect(gapped.has('moveSlotPp')).toBe(false)
    expect(gapped.has('condition.status1')).toBe(false)
  })

  it('computes the unpacked value AND still reports the gap', () => {
    // The invariant that separates "wired" from "promoted". Batch 2 made the
    // bridge call the unpackers, so a caller-set status2 now produces a real
    // `true` instead of a hardcoded `false` -- and the gap is STILL there,
    // because nothing in the sim writes status2, so the value is right only for
    // as long as the caller's own setting is.
    const state = battle()
    state.battlers[0]!.mon.status2 = setFlag(0, STATUS2_TRANSFORMED)
    state.battlers[0]!.statuses3 = setFlag(0, STATUS3_MIRACLE_EYED)
    state.battlers[0]!.volatiles.fear = true
    state.battlers[0]!.round.helpingHand = true

    const { battler, gaps } = buildBattlerBattleState(state, 0, ROLES, DEPS)
    expect(battler.isTransformed).toBe(true)
    expect(battler.hasMiracleEye).toBe(true)
    expect(battler.condition.fear).toBe(true)
    expect(battler.condition.helpingHand).toBe(true)

    const gapped = new Set(gaps.map((g) => g.field))
    expect(gapped.has('isTransformed')).toBe(true)
    expect(gapped.has('hasMiracleEye')).toBe(true)
    expect(gapped.has('condition.fear')).toBe(true)
    expect(gapped.has('condition.helpingHand')).toBe(true)
  })

  it('takes fear from the volatile struct, not from STATUS4_FEAR', () => {
    // The two exist and are different; the damage path reads the struct field
    // (battle_util.c:7062). Setting only the status bit must NOT show up.
    const state = battle()
    state.battlers[0]!.statuses4 = setFlag(0, STATUS4_FEAR)
    expect(buildBattlerBattleState(state, 0, ROLES, DEPS).battler.condition.fear).toBe(false)
    state.battlers[0]!.volatiles.fear = true
    expect(buildBattlerBattleState(state, 0, ROLES, DEPS).battler.condition.fear).toBe(true)
  })

  it('reads infatuation against the OPPONENT specifically', () => {
    const state = battle()
    // Infatuated with itself is not infatuated with the opponent.
    state.battlers[0]!.mon.status2 = statusInfatuatedWith(0)
    expect(buildBattlerBattleState(state, 0, ROLES, DEPS).battler.isInfatuatedWithOpponent).toBe(false)
    state.battlers[0]!.mon.status2 = statusInfatuatedWith(1)
    expect(buildBattlerBattleState(state, 0, ROLES, DEPS).battler.isInfatuatedWithOpponent).toBe(true)
  })

  it('formats gaps for the damage engine own unmodelled channel', () => {
    const { gaps } = buildBattlerBattleState(battle(), 0, ROLES, DEPS)
    const lines = gapsToUnmodelled(gaps)
    expect(lines).toHaveLength(gaps.length)
    expect(lines[0]).toMatch(/^[\w.]+: .+ \((NEVER_UPDATED|NO_SOURCE|NEEDS_DATA|AMBIGUOUS)\)$/)
  })
})

describe('buildBattlerBattleState: data-backed fields', () => {
  it('derives species, item, and ability facts from the snapshot', () => {
    const mega = buildBattlerBattleState(battle({ speciesId: 'SPECIES_VENUSAUR_MEGA' }), 0, ROLES, DEPS).battler
    expect(mega.condition.baseSpeciesId).toBe('SPECIES_VENUSAUR')
    expect(mega.condition.isMegaEvolved).toBe(true)
    expect(mega.condition.weight).toBe(1000)
    expect(buildBattlerBattleState(battle({ speciesId: 'SPECIES_DUGTRIO' }), 0, ROLES, DEPS).battler.condition.heads).toBe(3)
    expect(buildBattlerBattleState(battle({ speciesId: 'SPECIES_BULBASAUR' }), 0, ROLES, DEPS).battler.canEvolveStrict).toBe(true)
    expect(buildBattlerBattleState(battle({ speciesId: 'SPECIES_VENUSAUR' }), 0, ROLES, DEPS).battler.canEvolveStrict).toBe(false)

    const item = buildBattlerBattleState(battle({ itemId: 'ITEM_MYSTIC_WATER' }), 0, ROLES, DEPS).battler
    expect(item.holdEffectStrength).toBe(30)
    expect(item.holdEffectType).toBe('WATER')
    const berry = buildBattlerBattleState(battle({ itemId: 'ITEM_AGUAV_BERRY' }), 0, ROLES, DEPS).battler
    expect(berry.naturalGift?.type).toBe('GROUND')
    expect(buildBattlerBattleState(battle({ itemId: 'ITEM_LEFTOVERS' }), 0, ROLES, DEPS).battler.condition.resolvedHoldEffect).toBe('HOLD_EFFECT_LEFTOVERS')
    const enigma = buildBattlerBattleState(battle({ itemId: 'ITEM_ENIGMA_BERRY' }), 0, ROLES, DEPS).battler
    // battle_main.c:721-735 zeroes e-Reader data in non-link battles.
    expect(enigma.condition.resolvedHoldEffect).toBe('HOLD_EFFECT_NONE')
    expect(enigma.holdEffectStrength).toBeNull()
    expect(enigma.condition.itemResolvedHoldEffectStrength).toBeNull()
  })

  it('derives Comatose, Dreamscape, and Blood Stain predicates', () => {
    expect(buildBattlerBattleState(battle({ speciesId: 'SPECIES_SNORLAX', abilities: { ability: 'ABILITY_COMATOSE', innates: [null, null, null] } }), 0, ROLES, DEPS).battler.condition.hasComatose).toBe(true)
    expect(buildBattlerBattleState(battle({ speciesId: 'SPECIES_MUSHARNA', abilities: { ability: 'ABILITY_DREAMSCAPE', innates: [null, null, null] } }), 0, ROLES, DEPS).battler.condition.hasComatose).toBe(true)
    const blood = buildBattlerBattleState(battle({ types: ['WATER', 'MYSTERY', 'MYSTERY'], abilities: { ability: 'ABILITY_BLOOD_STAIN', innates: [null, null, null] } }), 0, ROLES, DEPS).battler
    expect(blood.condition.hasBloodStainEffect).toBe(true)
    const ghost = buildBattlerBattleState(battle({ types: ['GHOST', 'MYSTERY', 'MYSTERY'], abilities: { ability: 'ABILITY_BLOOD_STAIN', innates: [null, null, null] } }), 0, ROLES, DEPS).battler
    expect(ghost.condition.hasBloodStainEffect).toBe(false)
  })

  it('reports exactly species and item lookup misses as NEEDS_DATA gaps', () => {
    const missing: BridgeDeps = { ...DEPS, dataContext: { species: () => undefined, item: () => undefined, move: () => undefined } }
    const { gaps } = buildBattlerBattleState(battle({ itemId: 'ITEM_MYSTIC_WATER' }), 0, ROLES, missing)
    const needs = gaps.filter((gap) => gap.reason === 'NEEDS_DATA')
    expect(needs.map((gap) => gap.field).sort()).toEqual([
      'canEvolveStrict', 'condition.baseSpeciesId', 'condition.heads', 'condition.isMegaEvolved', 'condition.resolvedHoldEffect',
      'condition.weight', 'condition.itemResolvedHoldEffectStrength', 'holdEffectStrength', 'holdEffectType', 'naturalGift',
    ].sort())
    expect(needs.every((gap) => gap.detail.includes('SPECIES_MUDKIP') || gap.detail.includes('ITEM_MYSTIC_WATER'))).toBe(true)
  })
})

describe('wasDamagedThisTurnBy is role-relative', () => {
  /** Battler 1 was damaged by battler 0 earlier this turn. */
  function damagedState(): BattleState {
    const state = battle()
    const round = state.battlers[1]!.round
    round.damaged = true
    round.physicalBattlerId = 0
    round.specialBattlerId = 0
    return state
  }

  it('labels the damager by its ROLE in the pending calculation, not by id', () => {
    // The enum names the damager as the attacker or defender OF THIS
    // CALCULATION (conditions.ts:58's evalDamaged). Battler 1 was hit by
    // battler 0; when battler 0 is the attacker, that reads 'attacker'.
    const state = damagedState()
    const built = buildBattlerBattleState(state, 1, { attackerId: 0, defenderId: 1 }, DEPS)
    expect(built.battler.condition.wasDamagedThisTurnBy).toBe('attacker')
  })

  it('INVERTS when the same battle state is read from the other side', () => {
    // Same state, same battler, roles swapped: battler 0 is now the defender of
    // the pending calculation, so the identical damage reads 'defender'. This
    // is why the roles parameter is required -- without it the function would
    // have to assume one, and would be silently wrong for the other.
    const state = damagedState()
    const built = buildBattlerBattleState(state, 1, { attackerId: 1, defenderId: 0 }, DEPS)
    expect(built.battler.condition.wasDamagedThisTurnBy).toBe('defender')
  })

  it('reports none when the damager is neither role', () => {
    // The C's own `by == BATTLER_NONE` guard, script_conditions.cc:45.
    const state = damagedState()
    state.battlers[1]!.round.physicalBattlerId = 3
    state.battlers[1]!.round.specialBattlerId = 3
    const built = buildBattlerBattleState(state, 1, { attackerId: 0, defenderId: 1 }, DEPS)
    expect(built.battler.condition.wasDamagedThisTurnBy).toBe('none')
  })

  it('resolves the infatuation opponent from the declared roles too', () => {
    const state = battle()
    state.battlers[0]!.mon.status2 = statusInfatuatedWith(1)
    expect(buildBattlerBattleState(state, 0, { attackerId: 0, defenderId: 1 }, DEPS).battler.isInfatuatedWithOpponent).toBe(true)
    // With battler 0 as the DEFENDER of a calculation against battler 1, the
    // opponent is still battler 1, so this holds either way here -- but the id
    // now comes from the declared roles rather than from `battlerId ^ 1`.
    expect(buildBattlerBattleState(state, 0, { attackerId: 1, defenderId: 0 }, DEPS).battler.isInfatuatedWithOpponent).toBe(true)
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

describe('buildFieldSides', () => {
  it('reads all side flags role-relatively when the attacker is on side 0', () => {
    const state = battle()
    state.sides[0].statuses = SIDE_STATUS_REFLECT | SIDE_STATUS_AURORA_VEIL
    state.sides[1].statuses = SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_LUCKY_CHANT

    expect(buildFieldSides(state, { attackerId: 0, defenderId: 1 })).toEqual({
      attacker: { reflect: true, lightScreen: false, auroraVeil: true, luckyChant: false },
      defender: { reflect: false, lightScreen: true, auroraVeil: false, luckyChant: true },
    })
  })

  it('reads all side flags role-relatively when the attacker is on side 1', () => {
    const state = battle()
    state.sides[0].statuses = SIDE_STATUS_REFLECT | SIDE_STATUS_AURORA_VEIL
    state.sides[1].statuses = SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_LUCKY_CHANT

    expect(buildFieldSides(state, { attackerId: 1, defenderId: 0 })).toEqual({
      attacker: { reflect: false, lightScreen: true, auroraVeil: false, luckyChant: true },
      defender: { reflect: true, lightScreen: false, auroraVeil: true, luckyChant: false },
    })
  })
})
