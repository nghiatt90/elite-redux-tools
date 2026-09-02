import { describe, expect, it } from 'vitest'
import { evaluateAllConditions, evaluateCondition, type ScriptCondition } from './conditions'
import type { ConditionBattlerContext, DamageContext } from './types'

function battler(overrides: Partial<ConditionBattlerContext> = {}): ConditionBattlerContext {
  return {
    speciesId: 'SPECIES_PIKACHU',
    baseSpeciesId: 'SPECIES_PIKACHU',
    itemId: null,
    resolvedHoldEffect: null,
    itemNegated: false,
    status1: new Set(),
    hasComatose: false,
    hasBloodStainEffect: false,
    isInfatuated: false,
    wasDamagedThisTurnBy: 'none',
    recentlyFainted: false,
    hp: 100,
    maxHp: 100,
    weight: 60,
    speed: 100,
    positiveStatStageCount: 0,
    negativeStatStageCount: 0,
    usedMovePpRemaining: null,
    helpingHand: false,
    ghastlyEcho: false,
    chargedUp: false,
    meFirst: false,
    fear: false,
    safePassage: false,
    itemResolvedHoldEffectStrength: null,
    lastMoveFailed: false,
    ...overrides,
  }
}

function ctx(overrides: Partial<DamageContext> = {}): DamageContext {
  return {
    attacker: battler(),
    defender: battler(),
    field: { gravityActive: false, terrain: null, weather: 'NONE' },
    attackerActsFirst: true,
    sameMoveTurnsInARow: 0,
    ...overrides,
  }
}

describe('evalStatus', () => {
  it('STATUS1_ANY matches any active status', () => {
    const c: ScriptCondition = { kind: 'status', status: 'STATUS1_ANY', battler: 'BATTLER_TARGET' }
    expect(evaluateCondition(c, ctx())).toBe(false)
    expect(evaluateCondition(c, ctx({ defender: battler({ status1: new Set(['STATUS1_BURN']) }) }))).toBe(true)
  })

  it('STATUS2_INFATUATION reads isInfatuated, not status1', () => {
    const c: ScriptCondition = { kind: 'status', status: 'STATUS2_INFATUATION', battler: 'BATTLER_TARGET' }
    expect(evaluateCondition(c, ctx({ defender: battler({ isInfatuated: true }) }))).toBe(true)
  })

  it('Comatose counts as always-asleep', () => {
    const c: ScriptCondition = { kind: 'status', status: 'STATUS1_SLEEP', battler: 'BATTLER_ATTACKER' }
    expect(evaluateCondition(c, ctx({ attacker: battler({ hasComatose: true }) }))).toBe(true)
  })
})

describe('evalDamaged', () => {
  it('Damaged(target, ATTACKER) is true only when the target was hit by the attacker', () => {
    const c: ScriptCondition = { kind: 'damaged', battler: 'BATTLER_TARGET', by: 'BATTLER_ATTACKER' }
    expect(evaluateCondition(c, ctx({ defender: battler({ wasDamagedThisTurnBy: 'attacker' }) }))).toBe(true)
    expect(evaluateCondition(c, ctx({ defender: battler({ wasDamagedThisTurnBy: 'defender' }) }))).toBe(false)
  })

  it('by=BATTLER_NONE is always false -- a real upstream dead-code guard (src/script_conditions.cc:45)', () => {
    const c: ScriptCondition = { kind: 'damaged', battler: 'BATTLER_TARGET', by: 'BATTLER_NONE' }
    expect(evaluateCondition(c, ctx({ defender: battler({ wasDamagedThisTurnBy: 'attacker' }) }))).toBe(false)
  })
})

describe('evalActsAfter', () => {
  it('Payback-style: before=TARGET, after=ATTACKER -- true when attacker acts second', () => {
    const c: ScriptCondition = { kind: 'actsAfter', before: 'BATTLER_TARGET', after: 'BATTLER_ATTACKER', failIfSwitching: true }
    expect(evaluateCondition(c, ctx({ attackerActsFirst: false }))).toBe(true)
    expect(evaluateCondition(c, ctx({ attackerActsFirst: true }))).toBe(false)
  })

  it('Bolt Beak-style: before=ATTACKER, after=TARGET -- true when attacker acts first', () => {
    const c: ScriptCondition = { kind: 'actsAfter', before: 'BATTLER_ATTACKER', after: 'BATTLER_TARGET', failIfSwitching: false }
    expect(evaluateCondition(c, ctx({ attackerActsFirst: true }))).toBe(true)
    expect(evaluateCondition(c, ctx({ attackerActsFirst: false }))).toBe(false)
  })
})

describe('evalTerrain', () => {
  it('a specific terrain matches only itself', () => {
    const c: ScriptCondition = { kind: 'terrain', terrain: 'TERRAIN_ELECTRIC', battler: 'BATTLER_TARGET' }
    expect(evaluateCondition(c, ctx({ field: { gravityActive: false, terrain: 'TERRAIN_ELECTRIC', weather: 'NONE' } }))).toBe(true)
    expect(evaluateCondition(c, ctx({ field: { gravityActive: false, terrain: 'TERRAIN_PSYCHIC', weather: 'NONE' } }))).toBe(false)
  })

  it('TERRAIN_ANY matches whenever some terrain is active', () => {
    const c: ScriptCondition = { kind: 'terrain', terrain: 'TERRAIN_ANY', battler: 'BATTLER_ATTACKER' }
    expect(evaluateCondition(c, ctx({ field: { gravityActive: false, terrain: 'TERRAIN_GRASSY', weather: 'NONE' } }))).toBe(true)
    expect(evaluateCondition(c, ctx())).toBe(false)
  })
})

describe('evalFieldEffect', () => {
  it('gravity', () => {
    const c: ScriptCondition = { kind: 'fieldEffect', effect: 'FIELD_EFFECT_GRAVITY' }
    expect(evaluateCondition(c, ctx({ field: { gravityActive: true, terrain: null, weather: 'NONE' } }))).toBe(true)
    expect(evaluateCondition(c, ctx())).toBe(false)
  })
})

describe('evalSpecies', () => {
  it('exact match requires the specific form', () => {
    const c: ScriptCondition = { kind: 'species', species: ['SPECIES_MEOWTH_PARTNER_MEGA', 'SPECIES_MEOWTH_PARTNER'], battler: 'BATTLER_ATTACKER', exact: true }
    expect(evaluateCondition(c, ctx({ attacker: battler({ speciesId: 'SPECIES_MEOWTH_PARTNER' }) }))).toBe(true)
    expect(evaluateCondition(c, ctx({ attacker: battler({ speciesId: 'SPECIES_MEOWTH' }) }))).toBe(false)
  })

  it('non-exact match falls back to base species', () => {
    const c: ScriptCondition = { kind: 'species', species: ['SPECIES_PIKACHU'], battler: 'BATTLER_ATTACKER', exact: false }
    expect(evaluateCondition(c, ctx({ attacker: battler({ speciesId: 'SPECIES_PIKACHU_COSPLAY', baseSpeciesId: 'SPECIES_PIKACHU' }) }))).toBe(true)
  })
})

describe('evalItem', () => {
  it('matches by item id', () => {
    const c: ScriptCondition = { kind: 'item', item: ['ITEM_AMULET_COIN'], holdEffect: [], battler: 'BATTLER_ATTACKER', skipDisabling: false }
    expect(evaluateCondition(c, ctx({ attacker: battler({ itemId: 'ITEM_AMULET_COIN' }) }))).toBe(true)
    expect(evaluateCondition(c, ctx())).toBe(false)
  })

  it('matches by resolved hold effect, and honors skipDisabling', () => {
    const c: ScriptCondition = { kind: 'item', item: [], holdEffect: ['HOLD_EFFECT_LIFE_ORB'], battler: 'BATTLER_ATTACKER', skipDisabling: false }
    expect(evaluateCondition(c, ctx({ attacker: battler({ resolvedHoldEffect: 'HOLD_EFFECT_LIFE_ORB' }) }))).toBe(true)
    // item is negated (e.g. Embargo) and skipDisabling=false -> checkDisabling=true -> fails
    expect(evaluateCondition(c, ctx({ attacker: battler({ resolvedHoldEffect: 'HOLD_EFFECT_LIFE_ORB', itemNegated: true }) }))).toBe(false)
  })
})

describe('evaluateAllConditions', () => {
  it('AND-folds the list, matching REQUIRE break-on-first-failure', () => {
    const conditions: ScriptCondition[] = [
      { kind: 'fieldEffect', effect: 'FIELD_EFFECT_GRAVITY' },
      { kind: 'status', status: 'STATUS1_BURN', battler: 'BATTLER_TARGET' },
    ]
    expect(
      evaluateAllConditions(conditions, ctx({ field: { gravityActive: true, terrain: null, weather: 'NONE' }, defender: battler({ status1: new Set(['STATUS1_BURN']) }) })),
    ).toBe(true)
    expect(evaluateAllConditions(conditions, ctx({ field: { gravityActive: true, terrain: null, weather: 'NONE' } }))).toBe(false)
    expect(evaluateAllConditions([], ctx())).toBe(true)
  })
})
