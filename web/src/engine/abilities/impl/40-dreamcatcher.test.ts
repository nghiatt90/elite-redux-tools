import { describe, expect, it } from 'vitest'
import { DREAMCATCHER_ABILITIES } from './40-dreamcatcher'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq, mulModifier } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = DREAMCATCHER_ABILITIES.find((a) => a.id === id)
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
    defenderHasComatose: false,
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
    ...overrides,
  }
}

describe('Dreamcatcher batch AO', () => {
  it('doubles damage against a sleeping defender', () => {
    const c = ctx({ defenderStatus1: new Set(['STATUS1_SLEEP']) })
    findAbility('ABILITY_DREAMCATCHER').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(2.0))
  })

  it('doubles damage against a Comatose defender too', () => {
    const c = ctx({ defenderHasComatose: true })
    findAbility('ABILITY_DREAMCATCHER').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(2.0))
  })

  it('does not boost against an awake defender', () => {
    const c = ctx()
    findAbility('ABILITY_DREAMCATCHER').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })
})

describe('Dreamscape batch AO', () => {
  it('always applies its own flat 1.2x, on top of the 2x vs a sleeping defender', () => {
    const c = ctx({ defenderStatus1: new Set(['STATUS1_SLEEP']) })
    findAbility('ABILITY_DREAMSCAPE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(mulModifier(uq(2.0), uq(1.2)))
  })

  it('applies the flat 1.2x even against an awake defender (unconditional)', () => {
    const c = ctx()
    findAbility('ABILITY_DREAMSCAPE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.2))
  })

  it('every entry cites a src line', () => {
    for (const ability of DREAMCATCHER_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
