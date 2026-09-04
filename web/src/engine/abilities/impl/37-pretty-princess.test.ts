import { describe, expect, it } from 'vitest'
import { PRETTY_PRINCESS_ABILITIES } from './37-pretty-princess'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = PRETTY_PRINCESS_ABILITIES.find((a) => a.id === id)
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
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
    ...overrides,
  }
}

describe('pretty princess batch AL', () => {
  it('boosts 1.5x when the defender has any lowered stat and the attacker is not Unaware', () => {
    const c = ctx({ defenderHasAnyLoweredStat: true })
    findAbility('ABILITY_PRETTY_PRINCESS').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.5))
  })

  it('does not boost when the defender has no lowered stat', () => {
    const c = ctx({ defenderHasAnyLoweredStat: false })
    findAbility('ABILITY_PRETTY_PRINCESS').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it("the ATTACKER's own Unaware suppresses the boost even if the defender has a lowered stat", () => {
    const c = ctx({ defenderHasAnyLoweredStat: true, attackerIsUnaware: true })
    findAbility('ABILITY_PRETTY_PRINCESS').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of PRETTY_PRINCESS_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
