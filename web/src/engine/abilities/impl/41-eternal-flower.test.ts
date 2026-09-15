import { describe, expect, it } from 'vitest'
import { ETERNAL_FLOWER_ABILITIES } from './41-eternal-flower'
import type { AbilityImpl, OnStatContext } from '../types'

function findAbility(id: string): AbilityImpl {
  const entry = ETERNAL_FLOWER_ABILITIES.find((a) => a.id === id)
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
    isGrounded: true,
    ...overrides,
  }
}

describe('Eternal Flower batch AP', () => {
  it('reduces a Mega-evolved stat owner\'s stat by 20%', () => {
    const c = ctx({ isMegaEvolved: true })
    findAbility('ABILITY_ETERNAL_FLOWER').onStat!(c)
    expect(c.stat).toBe(80)
    expect(c.flags.nonStackingEternalFlower).toBe(true)
  })

  it('does not affect a non-Mega stat owner', () => {
    const c = ctx({ isMegaEvolved: false })
    findAbility('ABILITY_ETERNAL_FLOWER').onStat!(c)
    expect(c.stat).toBe(100)
  })

  it("does not affect a Mega stat owner that itself holds Eternal Flower", () => {
    const c = ctx({ isMegaEvolved: true, statOwnerHasEternalFlower: true })
    findAbility('ABILITY_ETERNAL_FLOWER').onStat!(c)
    expect(c.stat).toBe(100)
  })

  it('does not stack a second application once the shared flag is set', () => {
    const c = ctx({ isMegaEvolved: true, flags: { nonStackingRuin: false, nonStackingEternalFlower: true } })
    findAbility('ABILITY_ETERNAL_FLOWER').onStat!(c)
    expect(c.stat).toBe(100)
  })

  it("does not interfere with the SEPARATE nonStackingRuin bit", () => {
    const c = ctx({ isMegaEvolved: true, flags: { nonStackingRuin: true, nonStackingEternalFlower: false } })
    findAbility('ABILITY_ETERNAL_FLOWER').onStat!(c)
    expect(c.stat).toBe(80)
  })

  it('every entry cites a src line', () => {
    for (const ability of ETERNAL_FLOWER_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
