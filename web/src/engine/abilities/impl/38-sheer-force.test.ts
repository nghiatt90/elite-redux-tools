import { describe, expect, it } from 'vitest'
import { SHEER_FORCE_ABILITIES } from './38-sheer-force'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = SHEER_FORCE_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function ctx(overrides: Partial<OffensiveMultiplierContext> = {}): OffensiveMultiplierContext {
  return {
    modifier: uq(1.0),
    resistance: uq(1.0),
    battlerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_ACID',
    moveType: 'POISON',
    moveSplit: 'SPECIAL',
    moveFlags: {},
    moveEffectChance: 30,
    basePower: 70,
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

describe('sheer force batch AM', () => {
  it('boosts 1.3x for a damaging move with a secondary effect chance', () => {
    const c = ctx({ moveEffectChance: 30 })
    findAbility('ABILITY_SHEER_FORCE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.3))
  })

  it('does not boost a move with no secondary effect', () => {
    const c = ctx({ moveEffectChance: 0 })
    findAbility('ABILITY_SHEER_FORCE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('does not boost a STATUS move even with an effect chance', () => {
    const c = ctx({ moveSplit: 'STATUS', moveEffectChance: 100 })
    findAbility('ABILITY_SHEER_FORCE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('does not boost a move flagged noSheerForce despite having a chance', () => {
    const c = ctx({ moveEffectChance: 10, moveFlags: { noSheerForce: true } })
    findAbility('ABILITY_SHEER_FORCE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of SHEER_FORCE_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
