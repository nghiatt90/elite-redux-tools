import { describe, expect, it } from 'vitest'
import { HIGHER_RANK_ABILITIES } from './22-higher-rank'
import type { OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function ctx(overrides: Partial<OffensiveMultiplierContext> = {}): OffensiveMultiplierContext {
  return {
    modifier: uq(1.0),
    resistance: uq(1.0),
    battlerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_QUICK_ATTACK',
    moveType: 'NORMAL',
    moveSplit: 'PHYSICAL',
    moveFlags: {},
    moveEffectChance: 0,
    ateBoost: false,
    defenderHasComatose: false,
    attackerSlowStartTimer: 5,
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
    movePriority: 1,
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

describe('Higher Rank', () => {
  it('boosts moves with positive priority', () => {
    const c = ctx({ movePriority: 1 })
    HIGHER_RANK_ABILITIES[0].onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.2))
  })

  it('does not boost priority-0 or negative-priority moves', () => {
    const c1 = ctx({ movePriority: 0 })
    HIGHER_RANK_ABILITIES[0].onOffensiveMultiplier!(c1)
    expect(c1.modifier).toBe(uq(1.0))
    const c2 = ctx({ movePriority: -1 })
    HIGHER_RANK_ABILITIES[0].onOffensiveMultiplier!(c2)
    expect(c2.modifier).toBe(uq(1.0))
  })

  it('cites a src line', () => {
    expect(HIGHER_RANK_ABILITIES[0].src).toMatch(/^src\/abilities\.cc:\d+$/)
  })
})
