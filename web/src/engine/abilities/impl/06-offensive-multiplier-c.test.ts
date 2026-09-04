import { describe, expect, it } from 'vitest'
import { OFFENSIVE_MULTIPLIER_BATCH_C } from './06-offensive-multiplier-c'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = OFFENSIVE_MULTIPLIER_BATCH_C.find((a) => a.id === id)
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
    attackerGender: 'MALE' as const,
    defenderGender: 'MALE' as const,
    ...overrides,
  }
}

function run(id: string, overrides: Partial<OffensiveMultiplierContext> = {}): number {
  const ability = findAbility(id)
  const c = ctx(overrides)
  ability.onOffensiveMultiplier!(c)
  return c.modifier
}

describe('offensive multiplier batch C', () => {
  it('Sage Power boosts special moves', () => {
    expect(run('ABILITY_SAGE_POWER', { moveSplit: 'SPECIAL' })).toBe(uq(1.5))
    expect(run('ABILITY_SAGE_POWER', { moveSplit: 'PHYSICAL' })).toBe(uq(1.0))
  })

  it('Strong Jaw / Super Slammer key off their move flags', () => {
    expect(run('ABILITY_STRONG_JAW', { moveFlags: { biteBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_SUPER_SLAMMER', { moveFlags: { hammerBased: true } })).toBe(uq(1.3))
  })

  it('Technician boosts base power <= 60, using the PRE-modifier value', () => {
    expect(run('ABILITY_TECHNICIAN', { basePower: 60 })).toBe(uq(1.5))
    expect(run('ABILITY_TECHNICIAN', { basePower: 61 })).toBe(uq(1.0))
  })

  it('Tinted Lens doubles damage on a resisted hit (<=0.5x)', () => {
    expect(run('ABILITY_TINTED_LENS', { typeEffectiveness: uq(0.5) })).toBe(uq(2.0))
    expect(run('ABILITY_TINTED_LENS', { typeEffectiveness: uq(1.0) })).toBe(uq(1.0))
  })

  it('Transistor/Warmonger key off move type', () => {
    expect(run('ABILITY_TRANSISTOR', { moveType: 'ELECTRIC' })).toBe(uq(1.5))
    expect(run('ABILITY_WARMONGER', { moveType: 'ROCK' })).toBe(uq(1.3))
    expect(run('ABILITY_WARMONGER', { moveType: 'STEEL' })).toBe(uq(1.3))
    expect(run('ABILITY_WARMONGER', { moveType: 'FIGHTING' })).toBe(uq(1.3))
    expect(run('ABILITY_WARMONGER', { moveType: 'WATER' })).toBe(uq(1.0))
  })

  it('Winged King requires super-effective (>=2x)', () => {
    expect(run('ABILITY_WINGED_KING', { typeEffectiveness: uq(2.0) })).toBe(uq(1.33))
  })

  it('Atomic Punch combines Iron Fist + Steely Spirit', () => {
    expect(run('ABILITY_ATOMIC_PUNCH', { moveFlags: { punchBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_ATOMIC_PUNCH', { moveType: 'STEEL' })).toBe(uq(1.3))
    // both conditions at once stack multiplicatively via the shared modifier
    const both = ctx({ moveFlags: { punchBased: true }, moveType: 'STEEL' })
    findAbility('ABILITY_ATOMIC_PUNCH').onOffensiveMultiplier!(both)
    expect(both.modifier).toBeGreaterThan(uq(1.3))
  })

  it('Combat Specialist combines Iron Fist + Striker', () => {
    expect(run('ABILITY_COMBAT_SPECIALIST', { moveFlags: { punchBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_COMBAT_SPECIALIST', { moveFlags: { kickBased: true } })).toBe(uq(1.3))
  })

  it('Huge Wings combines Giant Wings + Levitate', () => {
    expect(run('ABILITY_HUGE_WINGS', { moveFlags: { airBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_HUGE_WINGS', { moveType: 'FLYING' })).toBe(uq(1.25))
  })

  it('Mega Drill combines Mighty Horn + a direct drill-flag check', () => {
    expect(run('ABILITY_MEGA_DRILL', { moveFlags: { hornBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_MEGA_DRILL', { moveFlags: { drillBased: true } })).toBe(uq(1.3))
  })

  it('every entry cites a src line', () => {
    for (const ability of OFFENSIVE_MULTIPLIER_BATCH_C) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
