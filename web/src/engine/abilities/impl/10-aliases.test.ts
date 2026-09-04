import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, lookupAbility, _resetRegistryForTests } from '../registry'
import { DECLARATIVE_ABILITIES } from './00-flags'
import { OFFENSIVE_MULTIPLIER_BATCH_A } from './01-offensive-multiplier-a'
import { DEFENSIVE_MULTIPLIER_BATCH_A } from './02-defensive-multiplier-a'
import { OFFENSIVE_MULTIPLIER_BATCH_B } from './03-offensive-multiplier-b'
import { HUB_ABILITIES } from './09-hub-abilities'
import { ALIAS_ABILITIES } from './10-aliases'
import type { AbilityImpl, OffensiveMultiplierContext, DefensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function offCtx(overrides: Partial<OffensiveMultiplierContext> = {}): OffensiveMultiplierContext {
  return {
    modifier: uq(1.0),
    resistance: uq(1.0),
    battlerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    moveType: 'NORMAL',
    moveSplit: 'PHYSICAL',
    moveFlags: {},
    moveEffectChance: 0,
    ateBoost: false,
    defenderHasComatose: false,
    basePower: 40,
    typeEffectiveness: uq(1.0),
    isCrit: false,
    attackerHasAnyStatus: false,
    attackerHp: 100,
    attackerMaxHp: 100,
    attackerActsFirst: true,
    weather: 'NONE',
    defenderTypes: [],
    attackerStatus1: new Set(),
    sameMoveTurnsInARow: 0,
    terrain: null,
    movePriority: 0,
    attackerAbilityOn: false,
    isAuraBreakActive: false,
    attackerGender: 'MALE' as const,
    defenderGender: 'MALE' as const,
    defenderIsConfused: false,
    defenderIsEnraged: false,
    defenderStatus1: new Set<string>(),
    defenderHasBloodStainEffect: false,
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
    ...overrides,
  }
}

function defCtx(overrides: Partial<DefensiveMultiplierContext> = {}): DefensiveMultiplierContext {
  return {
    modifier: uq(1.0),
    resistance: uq(1.0),
    defenderId: 'defender',
    attackerId: 'attacker',
    moveId: 'MOVE_TACKLE',
    moveType: 'NORMAL',
    moveSplit: 'PHYSICAL',
    moveFlags: {},
    typeEffectiveness: uq(1.0),
    isCrit: false,
    weather: 'NONE',
    defenderAtMaxHp: true,
    attackerActsFirst: true,
    defenderTypes: [],
    defenderAbilityOn: false,
    attackerGender: 'MALE' as const,
    defenderGender: 'MALE' as const,
    defenderIsEnraged: false,
    ...overrides,
  }
}

function findAbility(id: string): AbilityImpl {
  const entry = lookupAbility(id)
  if (!entry || 'unmodelled' in entry) throw new Error(`${id} not a real port`)
  return entry
}

describe('alias abilities (lazy delegation)', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(DECLARATIVE_ABILITIES)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_A)
    registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_A)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_B)
    registerAbilities(HUB_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
  })

  it('Tough Claws delegates straight to Big Pecks (contact-move check)', () => {
    const c = offCtx({ moveFlags: { contact: true } })
    findAbility('ABILITY_TOUGH_CLAWS').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.3))
  })

  it('Apex Predator delegates two levels deep: Apex Predator -> Tough Claws -> Big Pecks', () => {
    const c = offCtx({ moveFlags: { contact: true } })
    findAbility('ABILITY_APEX_PREDATOR').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.3))
  })

  it('Crust Coat delegates both onCrit and onDefensiveMultiplier to Battle Armor', () => {
    const def = defCtx()
    findAbility('ABILITY_CRUST_COAT').onDefensiveMultiplier!(def)
    expect(def.modifier).toBe(uq(0.8))
    expect(findAbility('ABILITY_CRUST_COAT').onCrit!({} as never)).toBe(-2) // NEVER_CRIT
  })

  it('an alias to a still-unmodelled target is a harmless no-op, not a throw', () => {
    // ABILITY_AMPLIFIER -> ABILITY_PUNK_ROCK, which has no real port yet.
    const c = offCtx()
    expect(() => findAbility('ABILITY_AMPLIFIER').onOffensiveMultiplier!(c)).not.toThrow()
    expect(c.modifier).toBe(uq(1.0))
  })

  it('every entry cites its own declaration line', () => {
    for (const ability of ALIAS_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })

  it('covers all 122 pure-alias abilities identified from abilityHooks.json', () => {
    expect(ALIAS_ABILITIES.length).toBe(122)
  })
})
