import { describe, expect, it } from 'vitest'
import { STATUS2_ABILITIES } from './35-status2'
import type { AbilityImpl, OffensiveMultiplierContext, DefensiveMultiplierContext, OnChooseDefensiveStatContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = STATUS2_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function offCtx(defenderIsConfused: boolean, defenderIsEnraged: boolean): OffensiveMultiplierContext {
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
    defenderIsConfused,
    defenderIsEnraged,
    defenderStatus1: new Set<string>(),
    defenderHasBloodStainEffect: false,
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
  }
}

function defCtx(defenderIsEnraged: boolean): DefensiveMultiplierContext {
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
    attackerGender: 'MALE',
    defenderGender: 'MALE',
    defenderIsEnraged,
  }
}

function chooseDefCtx(attackerIsConfused: boolean): OnChooseDefensiveStatContext {
  return {
    attackerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    noPositiveStatStages: false,
    isUnaware: false,
    isCrit: false,
    moveFlags: {},
    defenderHasAnyStatus: false,
    defenderDefComparison: 'equal',
    attackerIsConfused,
    statToUse: 'def',
    secondaryStat: {},
  }
}

describe('status2 batch AI', () => {
  it('Cosmic Daze doubles damage when the DEFENDER is confused or enraged', () => {
    const confused = offCtx(true, false)
    findAbility('ABILITY_COSMIC_DAZE').onOffensiveMultiplier!(confused)
    expect(confused.modifier).toBe(uq(2.0))

    const enraged = offCtx(false, true)
    findAbility('ABILITY_COSMIC_DAZE').onOffensiveMultiplier!(enraged)
    expect(enraged.modifier).toBe(uq(2.0))

    const neither = offCtx(false, false)
    findAbility('ABILITY_COSMIC_DAZE').onOffensiveMultiplier!(neither)
    expect(neither.modifier).toBe(uq(1.0))
  })

  it('Madness Enhancement reduces incoming damage 0.8x only while enraged', () => {
    const enraged = defCtx(true)
    findAbility('ABILITY_MADNESS_ENHANCEMENT').onDefensiveMultiplier!(enraged)
    expect(enraged.modifier).toBe(uq(0.8))

    const notEnraged = defCtx(false)
    findAbility('ABILITY_MADNESS_ENHANCEMENT').onDefensiveMultiplier!(notEnraged)
    expect(notEnraged.modifier).toBe(uq(1.0))
  })

  it('Tangled Feet swaps the defensive stat to Speed only while the ATTACKER is confused', () => {
    const confused = chooseDefCtx(true)
    findAbility('ABILITY_TANGLED_FEET').onChooseDefensiveStat!(confused)
    expect(confused.statToUse).toBe('spe')

    const notConfused = chooseDefCtx(false)
    findAbility('ABILITY_TANGLED_FEET').onChooseDefensiveStat!(notConfused)
    expect(notConfused.statToUse).toBe('def')
  })

  it('every entry cites a src line', () => {
    for (const ability of STATUS2_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
