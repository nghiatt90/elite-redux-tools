import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, lookupAbility, _resetRegistryForTests } from '../registry'
import { DEFENSIVE_MULTIPLIER_BATCH_A } from './02-defensive-multiplier-a'
import { HUB_ABILITIES } from './09-hub-abilities'
import { DEFENSIVE_MULTIPLIER_BATCH_B } from './07-defensive-multiplier-b'
import { ALIAS_ABILITIES } from './10-aliases'
import { DEFENSIVE_MULTIPLIER_BATCH_C } from './13-defensive-multiplier-c'
import type { AbilityImpl, DefensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = lookupAbility(id)
  if (!entry || 'unmodelled' in entry) throw new Error(`${id} not a real port`)
  return entry
}

function defCtx(overrides: Partial<DefensiveMultiplierContext> = {}): DefensiveMultiplierContext {
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
    attackerGender: 'MALE' as const,
    defenderGender: 'MALE' as const,
    ...overrides,
  }
}

function runDef(id: string, overrides: Partial<DefensiveMultiplierContext> = {}): number {
  const c = defCtx(overrides)
  findAbility(id).onDefensiveMultiplier!(c)
  return c.modifier
}

describe('defensive multiplier batch C', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_A)
    registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_B)
    registerAbilities(HUB_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
    registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_C)
  })

  it('Bark Skin: 0.7x on a super-effective hit, 0.85x otherwise', () => {
    expect(runDef('ABILITY_BARK_SKIN', { typeEffectiveness: uq(2.0) })).toBe(uq(0.7))
    expect(runDef('ABILITY_BARK_SKIN', { typeEffectiveness: uq(1.0) })).toBe(uq(0.85))
    expect(findAbility('ABILITY_BARK_SKIN').addsType).toBe('GHOST')
  })

  it('Rock Armor: unconditional 0.9x, carries addsType ROCK', () => {
    expect(runDef('ABILITY_ROCK_ARMOR')).toBe(uq(0.9))
    expect(findAbility('ABILITY_ROCK_ARMOR').addsType).toBe('ROCK')
  })

  it('Dry Skin takes 1.25x from Fire moves', () => {
    expect(runDef('ABILITY_DRY_SKIN', { moveType: 'FIRE' })).toBe(uq(1.25))
  })

  it('Sun Basking halves physical damage while any sun variant is active', () => {
    expect(runDef('ABILITY_SUN_BASKING', { weather: 'SUN_PERMANENT', moveSplit: 'PHYSICAL' })).toBe(uq(0.5))
    expect(runDef('ABILITY_SUN_BASKING', { weather: 'SUN_PRIMAL', moveSplit: 'PHYSICAL' })).toBe(uq(0.5))
    expect(runDef('ABILITY_SUN_BASKING', { weather: 'NONE', moveSplit: 'PHYSICAL' })).toBe(uq(1.0))
    expect(runDef('ABILITY_SUN_BASKING', { weather: 'SUN_PERMANENT', moveSplit: 'SPECIAL' })).toBe(uq(1.0))
  })

  it('unconditional flat multipliers', () => {
    expect(runDef('ABILITY_MUCUS_MEMBRANE')).toBe(uq(0.7))
    expect(runDef('ABILITY_PARRY')).toBe(uq(0.8))
    expect(runDef('ABILITY_PRISMATIC_FUR')).toBe(uq(0.5))
    expect(runDef('ABILITY_TERASTAL_TREASURE')).toBe(uq(0.6))
  })

  it('single/dual moveType checks', () => {
    expect(runDef('ABILITY_PURIFYING_SALT', { moveType: 'GHOST' })).toBe(uq(0.5))
    expect(runDef('ABILITY_THICK_BLUBBER', { moveType: 'FIRE' })).toBe(uq(0.25))
    expect(runDef('ABILITY_THICK_BLUBBER', { moveType: 'ICE' })).toBe(uq(0.25))
    expect(runDef('ABILITY_WATER_COMPACTION', { moveType: 'WATER' })).toBe(uq(0.5))
    expect(runDef('ABILITY_HYPER_CLEANSE', { moveType: 'POISON' })).toBe(uq(0.5))
    expect(runDef('ABILITY_IMMUNITY', { moveType: 'POISON' })).toBe(uq(0.5))
    expect(runDef('ABILITY_MAGMA_ARMOR', { moveType: 'WATER' })).toBe(uq(0.7))
    expect(runDef('ABILITY_MAGMA_ARMOR', { moveType: 'ICE' })).toBe(uq(0.7))
  })

  it('Lead Coat: 0.6x vs physical, 0.9x Speed; Chrome Coat: 0.6x vs special, delegates the same onStat', () => {
    expect(runDef('ABILITY_LEAD_COAT', { moveSplit: 'PHYSICAL' })).toBe(uq(0.6))
    const statCtx = { battlerId: 'x', statId: 'spe' as const, moveId: 'MOVE_TACKLE', stat: 100, flags: { nonStackingRuin: false }, weather: 'NONE', terrain: null, hp: 100, maxHp: 100, hasAnyStatus: false, status1: new Set<string>(), isHighestAttackingStat: false, isHighestStat: false, abilityOn: false, boostedStat: null }
    findAbility('ABILITY_LEAD_COAT').onStat!(statCtx)
    expect(statCtx.stat).toBe(90)

    expect(runDef('ABILITY_CHROME_COAT', { moveSplit: 'SPECIAL' })).toBe(uq(0.6))
    const statCtx2 = { battlerId: 'x', statId: 'spe' as const, moveId: 'MOVE_TACKLE', stat: 100, flags: { nonStackingRuin: false }, weather: 'NONE', terrain: null, hp: 100, maxHp: 100, hasAnyStatus: false, status1: new Set<string>(), isHighestAttackingStat: false, isHighestStat: false, abilityOn: false, boostedStat: null }
    findAbility('ABILITY_CHROME_COAT').onStat!(statCtx2)
    expect(statCtx2.stat).toBe(90)
  })

  it('Droideka/Fortress/Petroleum Jelly compose two already-ported defensive hooks', () => {
    // Each is two SEQUENTIAL mulModifier calls (re-quantizing in between), not one
    // combined float multiply -- see module doc on why order/rounding matters.
    const mulModifier = (a: number, b: number) => Math.floor((a * b + 512) / 1024)

    // Droideka = Heatproof (0.5x Fire) then Shell Armor -> Battle Armor (0.8x)
    const droideka = mulModifier(mulModifier(uq(1.0), uq(0.5)), uq(0.8))
    expect(runDef('ABILITY_DROIDEKA', { moveType: 'FIRE' })).toBe(droideka)

    // Fortress = Filter (0.65x on super-effective) then Shell Armor (0.8x)
    const fortress = mulModifier(mulModifier(uq(1.0), uq(0.65)), uq(0.8))
    expect(runDef('ABILITY_FORTRESS', { typeEffectiveness: uq(2.0) })).toBe(fortress)

    // Petroleum Jelly = Hyper Cleanse (0.5x Poison) then Liquified (no match here, no-op)
    expect(runDef('ABILITY_PETROLEUM_JELLY', { moveType: 'POISON' })).toBe(mulModifier(uq(1.0), uq(0.5)))
  })

  it('every entry cites a src line', () => {
    for (const ability of DEFENSIVE_MULTIPLIER_BATCH_C) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
