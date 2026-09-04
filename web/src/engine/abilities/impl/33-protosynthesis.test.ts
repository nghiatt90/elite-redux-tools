import { describe, expect, it } from 'vitest'
import { PROTOSYNTHESIS_ABILITIES } from './33-protosynthesis'
import type { AbilityImpl, OnStatContext } from '../types'

function findAbility(id: string): AbilityImpl {
  const entry = PROTOSYNTHESIS_ABILITIES.find((a) => a.id === id)
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

describe('protosynthesis batch AG', () => {
  it('boosts Speed 1.5x when boostedStat matches', () => {
    const c = ctx({ statId: 'spe', stat: 100, boostedStat: 'spe' })
    findAbility('ABILITY_PROTOSYNTHESIS').onStat!(c)
    expect(c.stat).toBe(150)
  })

  it('boosts any other matching stat 1.3x (integer truncation, not float)', () => {
    const c = ctx({ statId: 'atk', stat: 301, boostedStat: 'atk' })
    findAbility('ABILITY_PROTOSYNTHESIS').onStat!(c)
    expect(c.stat).toBe(391) // trunc(301*1.3) = trunc(391.3) = 391
  })

  it('does nothing when boostedStat is null or a different stat', () => {
    const off = ctx({ statId: 'atk', stat: 100, boostedStat: null })
    findAbility('ABILITY_PROTOSYNTHESIS').onStat!(off)
    expect(off.stat).toBe(100)

    const mismatched = ctx({ statId: 'atk', stat: 100, boostedStat: 'spatk' })
    findAbility('ABILITY_PROTOSYNTHESIS').onStat!(mismatched)
    expect(mismatched.stat).toBe(100)
  })

  it('every entry cites a src line', () => {
    for (const ability of PROTOSYNTHESIS_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
