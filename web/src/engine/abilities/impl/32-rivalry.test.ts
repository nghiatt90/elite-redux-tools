import { describe, expect, it } from 'vitest'
import { RIVALRY_ABILITIES } from './32-rivalry'
import type { AbilityImpl, OffensiveMultiplierContext, DefensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = RIVALRY_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function offCtx(attackerGender: 'MALE' | 'FEMALE' | 'GENDERLESS', defenderGender: 'MALE' | 'FEMALE' | 'GENDERLESS'): OffensiveMultiplierContext {
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
    attackerGender,
    defenderGender,
    defenderIsConfused: false,
    defenderIsEnraged: false,
    defenderStatus1: new Set<string>(),
    defenderHasBloodStainEffect: false,
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
  }
}

function defCtx(attackerGender: 'MALE' | 'FEMALE' | 'GENDERLESS', defenderGender: 'MALE' | 'FEMALE' | 'GENDERLESS'): DefensiveMultiplierContext {
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
    attackerGender,
    defenderGender,
    defenderIsEnraged: false,
  }
}

describe('rivalry batch AF', () => {
  it('offensive half: 1.25x when the ATTACKER matches the DEFENDER\'s gender', () => {
    const same = offCtx('MALE', 'MALE')
    findAbility('ABILITY_RIVALRY').onOffensiveMultiplier!(same)
    expect(same.modifier).toBe(uq(1.25))

    const different = offCtx('MALE', 'FEMALE')
    findAbility('ABILITY_RIVALRY').onOffensiveMultiplier!(different)
    expect(different.modifier).toBe(uq(1.0))
  })

  it('offensive half: Genderless never boosts, even against another Genderless', () => {
    const ctx = offCtx('GENDERLESS', 'GENDERLESS')
    findAbility('ABILITY_RIVALRY').onOffensiveMultiplier!(ctx)
    expect(ctx.modifier).toBe(uq(1.0))
  })

  it('defensive half: 0.75x when the ATTACKER is the OPPOSITE gender of the DEFENDER', () => {
    const opposite = defCtx('MALE', 'FEMALE')
    findAbility('ABILITY_RIVALRY').onDefensiveMultiplier!(opposite)
    expect(opposite.modifier).toBe(uq(0.75))

    const same = defCtx('MALE', 'MALE')
    findAbility('ABILITY_RIVALRY').onDefensiveMultiplier!(same)
    expect(same.modifier).toBe(uq(1.0))
  })

  it('defensive half: Genderless on either side never reduces', () => {
    const attackerGenderless = defCtx('GENDERLESS', 'FEMALE')
    findAbility('ABILITY_RIVALRY').onDefensiveMultiplier!(attackerGenderless)
    expect(attackerGenderless.modifier).toBe(uq(1.0))

    const defenderGenderless = defCtx('MALE', 'GENDERLESS')
    findAbility('ABILITY_RIVALRY').onDefensiveMultiplier!(defenderGenderless)
    expect(defenderGenderless.modifier).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of RIVALRY_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
