import { describe, expect, it } from 'vitest'
import { DEFENSIVE_MULTIPLIER_BATCH_A } from './02-defensive-multiplier-a'
import type { AbilityImpl, DefensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = DEFENSIVE_MULTIPLIER_BATCH_A.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function ctx(overrides: Partial<DefensiveMultiplierContext> = {}): DefensiveMultiplierContext {
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
    ...overrides,
  }
}

function run(id: string, overrides: Partial<DefensiveMultiplierContext> = {}): number {
  const ability = findAbility(id)
  const c = ctx(overrides)
  ability.onDefensiveMultiplier!(c)
  return c.modifier
}

describe('defensive multiplier batch A', () => {
  it('Bad Omen halves crit damage further (x0.25)', () => {
    expect(run('ABILITY_BAD_OMEN', { isCrit: true })).toBe(uq(0.25))
    expect(run('ABILITY_BAD_OMEN', { isCrit: false })).toBe(uq(1.0))
  })

  it('Multiscale/Brain Mass require the defender at max HP', () => {
    expect(run('ABILITY_MULTISCALE', { defenderAtMaxHp: true })).toBe(uq(0.5))
    expect(run('ABILITY_MULTISCALE', { defenderAtMaxHp: false })).toBe(uq(1.0))
    expect(run('ABILITY_BRAIN_MASS', { defenderAtMaxHp: true })).toBe(uq(0.5))
  })

  it('Christmas Spirit requires hail', () => {
    expect(run('ABILITY_CHRISTMAS_SPIRIT', { weather: 'HAIL' })).toBe(uq(0.5))
    expect(run('ABILITY_CHRISTMAS_SPIRIT', { weather: 'SANDSTORM' })).toBe(uq(1.0))
  })

  it('Filter/Permafrost/Primal Armor require super-effective (>=2x)', () => {
    expect(run('ABILITY_FILTER', { typeEffectiveness: uq(2.0) })).toBe(uq(0.65))
    expect(run('ABILITY_FILTER', { typeEffectiveness: uq(1.0) })).toBe(uq(1.0))
    expect(run('ABILITY_PRIMAL_ARMOR', { typeEffectiveness: uq(4.0) })).toBe(uq(0.5))
    expect(findAbility('ABILITY_FILTER').flags?.breakable).toBe(true)
  })

  it('Fur Coat/Guardian Coat key off physical split', () => {
    expect(run('ABILITY_FUR_COAT', { moveSplit: 'PHYSICAL' })).toBe(uq(0.5))
    expect(run('ABILITY_FUR_COAT', { moveSplit: 'SPECIAL' })).toBe(uq(1.0))
    expect(run('ABILITY_GUARDIAN_COAT', { moveSplit: 'PHYSICAL' })).toBe(uq(0.8))
  })

  it('Ice Scales/Overcoat/Prism Scales key off special split', () => {
    expect(run('ABILITY_ICE_SCALES', { moveSplit: 'SPECIAL' })).toBe(uq(0.5))
    expect(run('ABILITY_OVERCOAT', { moveSplit: 'SPECIAL' })).toBe(uq(0.8))
    expect(run('ABILITY_PRISM_SCALES', { moveSplit: 'SPECIAL' })).toBe(uq(0.7))
  })

  it('Heatproof/Heavy Metal/Strong Foundation/Thick Fat key off move type', () => {
    expect(run('ABILITY_HEATPROOF', { moveType: 'FIRE' })).toBe(uq(0.5))
    expect(run('ABILITY_HEAVY_METAL', { moveType: 'GHOST' })).toBe(uq(0.5))
    expect(run('ABILITY_HEAVY_METAL', { moveType: 'DARK' })).toBe(uq(0.5))
    expect(run('ABILITY_HEAVY_METAL', { moveType: 'NORMAL' })).toBe(uq(1.0))
    expect(run('ABILITY_STRONG_FOUNDATION', { moveType: 'WATER' })).toBe(uq(0.5))
    expect(run('ABILITY_STRONG_FOUNDATION', { moveType: 'GROUND' })).toBe(uq(0.5))
    expect(run('ABILITY_THICK_FAT', { moveType: 'FIRE' })).toBe(uq(0.5))
    expect(run('ABILITY_THICK_FAT', { moveType: 'ICE' })).toBe(uq(0.5))
  })

  it('every entry in the batch cites a src line', () => {
    for (const ability of DEFENSIVE_MULTIPLIER_BATCH_A) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
