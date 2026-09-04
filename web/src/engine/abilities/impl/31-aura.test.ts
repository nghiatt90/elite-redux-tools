import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, _resetRegistryForTests } from '../registry'
import { computeAbilityMultiplier, hasFlag } from '../dispatchCalc'
import { AURA_ABILITIES } from './31-aura'
import { ALIAS_ABILITIES } from './10-aliases'
import { DECLARATIVE_ABILITIES } from './00-flags'
import { uq } from '../../fixed'

function slots(ability: string | null): { ability: string | null; innates: [string | null, string | null, string | null] } {
  return { ability, innates: [null, null, null] }
}

function offCtx(overrides: Partial<{ moveType: string; isAuraBreakActive: boolean }> = {}) {
  return {
    battlerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    moveType: 'NORMAL',
    moveSplit: 'PHYSICAL' as const,
    moveFlags: {},
    basePower: 40,
    typeEffectiveness: uq(1.0),
    isCrit: false,
    attackerHasAnyStatus: false,
    attackerHp: 100,
    attackerMaxHp: 100,
    attackerActsFirst: true,
    weather: 'NONE',
    defenderTypes: [],
    attackerStatus1: new Set<string>(),
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

// computeAbilityMultiplier's shared ctx is `{ ...offensive, ...defensive, ... }` --
// defensive is spread LAST, so its own moveType must match the offensive one
// passed alongside it or it silently overwrites it.
function defCtx(moveType = 'NORMAL') {
  return {
    defenderId: 'defender',
    attackerId: 'attacker',
    moveId: 'MOVE_TACKLE',
    moveType,
    moveSplit: 'PHYSICAL' as const,
    moveFlags: {},
    typeEffectiveness: uq(1.0),
    isCrit: false,
    weather: 'NONE',
    defenderAtMaxHp: true,
    attackerActsFirst: true,
    defenderTypes: [] as string[],
    defenderAbilityOn: false,
    attackerGender: 'MALE' as const,
    defenderGender: 'MALE' as const,
    defenderIsEnraged: false,
    defenderStatus1: new Set<string>(),
    defenderHasBloodStainEffect: false,
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
  }
}

describe('aura batch AE', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(AURA_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
    registerAbilities(DECLARATIVE_ABILITIES)
  })

  it('Dark Aura boosts Dark moves 1.33x when held by the attacker, regardless of isAuraBreakActive default', () => {
    const attacker = slots('ABILITY_DARK_AURA')
    const result = computeAbilityMultiplier(attacker, slots(null), offCtx({ moveType: 'DARK' }), defCtx('DARK'))
    expect(result).toBe(uq(1.33))
  })

  it('Dark Aura on the DEFENDER still boosts the ATTACKER\'s Dark move (APPLY_ON_ANY)', () => {
    const defender = slots('ABILITY_DARK_AURA')
    const result = computeAbilityMultiplier(slots(null), defender, offCtx({ moveType: 'DARK' }), defCtx('DARK'))
    expect(result).toBe(uq(1.33))
  })

  it("Fairy Aura (and its alias Pixie Power) boost Fairy moves the same way", () => {
    for (const id of ['ABILITY_FAIRY_AURA', 'ABILITY_PIXIE_POWER']) {
      const result = computeAbilityMultiplier(slots(id), slots(null), offCtx({ moveType: 'FAIRY' }), defCtx('FAIRY'))
      expect(result).toBe(uq(1.33))
    }
  })

  it('isAuraBreakActive flips the boost to a 0.75x reduction', () => {
    const attacker = slots('ABILITY_DARK_AURA')
    const result = computeAbilityMultiplier(attacker, slots(null), offCtx({ moveType: 'DARK', isAuraBreakActive: true }), defCtx('DARK'))
    expect(result).toBe(uq(0.75))
  })

  it('neither aura fires for a non-matching move type', () => {
    const attacker = slots('ABILITY_DARK_AURA')
    const result = computeAbilityMultiplier(attacker, slots(null), offCtx({ moveType: 'NORMAL' }), defCtx('NORMAL'))
    expect(result).toBe(uq(1.0))
  })

  it('hasFlag detects auraBreak on Aura Break and Nihil Blaster', () => {
    expect(hasFlag(slots('ABILITY_AURA_BREAK'), 'auraBreak')).toBe(true)
    expect(hasFlag(slots('ABILITY_NIHIL_BLASTER'), 'auraBreak')).toBe(true)
    expect(hasFlag(slots('ABILITY_DARK_AURA'), 'auraBreak')).toBe(false)
  })

  it('every entry cites a src line', () => {
    for (const ability of AURA_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
