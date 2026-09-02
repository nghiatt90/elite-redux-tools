import { describe, expect, it } from 'vitest'
import { OFFENSIVE_MULTIPLIER_BATCH_A } from './01-offensive-multiplier-a'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = OFFENSIVE_MULTIPLIER_BATCH_A.find((a) => a.id === id)
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
    ...overrides,
  }
}

function run(id: string, overrides: Partial<OffensiveMultiplierContext> = {}): number {
  const ability = findAbility(id)
  const c = ctx(overrides)
  ability.onOffensiveMultiplier!(c)
  return c.modifier
}

describe('offensive multiplier batch A', () => {
  it('Airborne boosts Flying moves', () => {
    expect(run('ABILITY_AIRBORNE', { moveType: 'FLYING' })).toBe(uq(1.3))
    expect(run('ABILITY_AIRBORNE', { moveType: 'NORMAL' })).toBe(uq(1.0))
  })

  it('Antarctic Bird boosts both Flying and Ice', () => {
    expect(run('ABILITY_ANTARCTIC_BIRD', { moveType: 'FLYING' })).toBe(uq(1.3))
    expect(run('ABILITY_ANTARCTIC_BIRD', { moveType: 'ICE' })).toBe(uq(1.3))
    expect(run('ABILITY_ANTARCTIC_BIRD', { moveType: 'WATER' })).toBe(uq(1.0))
  })

  it('Archer boosts arrow-based moves', () => {
    expect(run('ABILITY_ARCHER', { moveFlags: { arrowBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_ARCHER')).toBe(uq(1.0))
  })

  it('Battery boosts special moves only (split, not type)', () => {
    expect(run('ABILITY_BATTERY', { moveSplit: 'SPECIAL' })).toBe(uq(1.3))
    expect(run('ABILITY_BATTERY', { moveSplit: 'PHYSICAL' })).toBe(uq(1.0))
  })

  it('Big Pecks boosts contact moves', () => {
    expect(run('ABILITY_BIG_PECKS', { moveFlags: { contact: true } })).toBe(uq(1.3))
  })

  it('Levitate boosts Flying moves and carries the levitate flag', () => {
    const levitate = findAbility('ABILITY_LEVITATE')
    expect(levitate.flags?.levitate).toBe(true)
    expect(run('ABILITY_LEVITATE', { moveType: 'FLYING' })).toBe(uq(1.25))
  })

  it('Gorilla Tactics / Long Reach key off split, not a move-flag', () => {
    expect(run('ABILITY_GORILLA_TACTICS', { moveSplit: 'PHYSICAL' })).toBe(uq(1.5))
    expect(run('ABILITY_GORILLA_TACTICS', { moveSplit: 'SPECIAL' })).toBe(uq(1.0))
    expect(run('ABILITY_LONG_REACH', { moveSplit: 'PHYSICAL' })).toBe(uq(1.2))
  })

  it('Sniper boosts on crit', () => {
    expect(run('ABILITY_SNIPER', { isCrit: true })).toBe(uq(1.5))
    expect(run('ABILITY_SNIPER', { isCrit: false })).toBe(uq(1.0))
  })

  it('Power Spot is unconditional (its whole condition is the ally-only apply-on scope)', () => {
    expect(run('ABILITY_POWER_SPOT')).toBe(uq(1.3))
  })

  it('Hammer Fist boosts punch OR hammer-based moves', () => {
    expect(run('ABILITY_HAMMER_FIST', { moveFlags: { punchBased: true } })).toBe(uq(1.25))
    expect(run('ABILITY_HAMMER_FIST', { moveFlags: { hammerBased: true } })).toBe(uq(1.25))
    expect(run('ABILITY_HAMMER_FIST')).toBe(uq(1.0))
  })

  it('Rocky Payload boosts Rock type OR throwing-based moves', () => {
    expect(run('ABILITY_ROCKY_PAYLOAD', { moveType: 'ROCK' })).toBe(uq(1.5))
    expect(run('ABILITY_ROCKY_PAYLOAD', { moveFlags: { throwingBased: true } })).toBe(uq(1.5))
  })

  it('every entry in the batch cites a src line', () => {
    for (const ability of OFFENSIVE_MULTIPLIER_BATCH_A) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
