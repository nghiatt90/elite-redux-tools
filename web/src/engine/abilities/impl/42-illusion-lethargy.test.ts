import { describe, expect, it } from 'vitest'
import { ILLUSION_LETHARGY_ABILITIES } from './42-illusion-lethargy'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = ILLUSION_LETHARGY_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function ctx(overrides: Partial<OffensiveMultiplierContext> = {}): OffensiveMultiplierContext {
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
    attackerSlowStartTimer: 5,
    attackerHasStab: false,
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
    attackerGender: 'MALE',
    defenderGender: 'MALE',
    defenderIsConfused: false,
    defenderIsEnraged: false,
    defenderStatus1: new Set(),
    defenderHasBloodStainEffect: false,
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
    ...overrides,
  }
}

describe('Illusion batch AQ', () => {
  it('boosts 1.3x while the disguise is on and unbroken (abilityOn toggle)', () => {
    const c = ctx({ attackerAbilityOn: true })
    findAbility('ABILITY_ILLUSION').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.3))
  })

  it('does not boost once the toggle is off', () => {
    const c = ctx({ attackerAbilityOn: false })
    findAbility('ABILITY_ILLUSION').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })
})

describe('Lethargy batch AQ', () => {
  it.each([
    [0, 0.2],
    [1, 0.2],
    [2, 0.4],
    [3, 0.6],
    [4, 0.8],
  ])('applies the %i-tier multiplier %f', (timer, expected) => {
    const c = ctx({ attackerSlowStartTimer: timer })
    findAbility('ABILITY_LETHARGY').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(expected))
  })

  it('applies no multiplier once the timer has expired (5+)', () => {
    const c = ctx({ attackerSlowStartTimer: 5 })
    findAbility('ABILITY_LETHARGY').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of ILLUSION_LETHARGY_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
