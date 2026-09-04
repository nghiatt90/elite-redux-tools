import { describe, expect, it } from 'vitest'
import { CRIT_BATTLE_A } from './04-crit-a'
import { ALWAYS_CRIT } from '../../crit'
import type { AbilityImpl, OnCritContext } from '../types'

function findAbility(id: string): AbilityImpl {
  const entry = CRIT_BATTLE_A.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function ctx(overrides: Partial<OnCritContext> = {}): OnCritContext {
  return {
    battlerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    typeEffectiveness: 1024,
    defenderStatus1: new Set<string>(),
    defenderSpeedStageNegative: false,
    defenderResolvedHoldEffect: null,
    moveFlags: {},
    basePower: 40,
    attackerActsFirst: true,
    abilityOn: false,
    ...overrides,
  }
}

function run(id: string, overrides: Partial<OnCritContext> = {}): number {
  return findAbility(id).onCrit!(ctx(overrides))
}

describe('crit batch A', () => {
  it('Battle Aura and Super Luck grant a flat stage bonus', () => {
    expect(run('ABILITY_BATTLE_AURA')).toBe(2)
    expect(run('ABILITY_SUPER_LUCK')).toBe(1)
  })

  it('Giant Shuriken only boosts Water Shuriken specifically', () => {
    expect(run('ABILITY_GIANT_SHURIKEN', { moveId: 'MOVE_WATER_SHURIKEN' })).toBe(1)
    expect(run('ABILITY_GIANT_SHURIKEN', { moveId: 'MOVE_TACKLE' })).toBe(0)
  })

  it('Heaven Asunder guarantees a crit for Spacial Rend, +1 stage otherwise', () => {
    expect(run('ABILITY_HEAVEN_ASUNDER', { moveId: 'MOVE_SPACIAL_REND' })).toBe(ALWAYS_CRIT)
    expect(run('ABILITY_HEAVEN_ASUNDER', { moveId: 'MOVE_TACKLE' })).toBe(1)
  })

  it('Merciless guarantees a crit against poison/paralysis/bleed/lowered Speed/Iron Ball', () => {
    expect(run('ABILITY_MERCILESS', { defenderStatus1: new Set(['STATUS1_POISON']) })).toBe(ALWAYS_CRIT)
    expect(run('ABILITY_MERCILESS', { defenderStatus1: new Set(['STATUS1_TOXIC_POISON']) })).toBe(ALWAYS_CRIT)
    expect(run('ABILITY_MERCILESS', { defenderStatus1: new Set(['STATUS1_PARALYSIS']) })).toBe(ALWAYS_CRIT)
    expect(run('ABILITY_MERCILESS', { defenderStatus1: new Set(['STATUS1_BLEED']) })).toBe(ALWAYS_CRIT)
    expect(run('ABILITY_MERCILESS', { defenderSpeedStageNegative: true })).toBe(ALWAYS_CRIT)
    expect(run('ABILITY_MERCILESS', { defenderResolvedHoldEffect: 'HOLD_EFFECT_IRON_BALL' })).toBe(ALWAYS_CRIT)
    expect(run('ABILITY_MERCILESS')).toBe(0)
  })

  it('every entry in the batch cites a src line', () => {
    for (const ability of CRIT_BATTLE_A) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
