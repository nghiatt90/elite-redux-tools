import { describe, expect, it } from 'vitest'
import { FAINTED_COUNT_ABILITIES } from './34-fainted-count'
import type { AbilityImpl, OnStatContext } from '../types'

function findAbility(id: string): AbilityImpl {
  const entry = FAINTED_COUNT_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function ctx(overrides: Partial<OnStatContext> = {}): OnStatContext {
  return {
    battlerId: 'self',
    statId: 'atk',
    moveId: 'MOVE_TACKLE',
    stat: 100,
    flags: { nonStackingRuin: false, nonStackingEternalFlower: false },
    weather: 'NONE',
    terrain: null,
    hp: 100,
    maxHp: 100,
    hasAnyStatus: false,
    status1: new Set(),
    isHighestAttackingStat: false,
    isHighestStat: false,
    abilityOn: false,
    boostedStat: null,
    alliesFainted: 0,
    isMegaEvolved: false,
    statOwnerHasEternalFlower: false,
    ...overrides,
  }
}

describe('fainted count batch AH', () => {
  it('Soul Harvest scales every stat except Speed by (20+min(5,fainted))/20', () => {
    expect(run('ABILITY_SOUL_HARVEST', { statId: 'atk', stat: 100, alliesFainted: 3 })).toBe(115) // 100*23/20
    expect(run('ABILITY_SOUL_HARVEST', { statId: 'def', stat: 100, alliesFainted: 0 })).toBe(100)
    expect(run('ABILITY_SOUL_HARVEST', { statId: 'spe', stat: 100, alliesFainted: 5 })).toBe(100) // Speed exempt
  })

  it('Soul Harvest clamps at 5 fainted (min(5, ...))', () => {
    expect(run('ABILITY_SOUL_HARVEST', { statId: 'atk', stat: 100, alliesFainted: 5 })).toBe(125) // 100*25/20
    expect(run('ABILITY_SOUL_HARVEST', { statId: 'atk', stat: 100, alliesFainted: 10 })).toBe(125) // same as 5
  })

  it('Supreme Overlord scales ONLY Atk/SpAtk by (10+min(5,fainted))/10', () => {
    expect(run('ABILITY_SUPREME_OVERLORD', { statId: 'atk', stat: 100, alliesFainted: 3 })).toBe(130) // 100*13/10
    expect(run('ABILITY_SUPREME_OVERLORD', { statId: 'spatk', stat: 100, alliesFainted: 2 })).toBe(120)
    expect(run('ABILITY_SUPREME_OVERLORD', { statId: 'def', stat: 100, alliesFainted: 5 })).toBe(100)
    expect(run('ABILITY_SUPREME_OVERLORD', { statId: 'spe', stat: 100, alliesFainted: 5 })).toBe(100)
  })

  it('Supreme Overlord clamps at 5 fainted', () => {
    expect(run('ABILITY_SUPREME_OVERLORD', { statId: 'atk', stat: 100, alliesFainted: 5 })).toBe(150)
    expect(run('ABILITY_SUPREME_OVERLORD', { statId: 'atk', stat: 100, alliesFainted: 20 })).toBe(150)
  })

  it('every entry cites a src line', () => {
    for (const ability of FAINTED_COUNT_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})

function run(id: string, overrides: Partial<OnStatContext> = {}): number {
  const c = ctx(overrides)
  findAbility(id).onStat!(c)
  return c.stat
}
