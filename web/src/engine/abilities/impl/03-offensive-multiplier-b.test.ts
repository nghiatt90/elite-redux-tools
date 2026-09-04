import { describe, expect, it } from 'vitest'
import { OFFENSIVE_MULTIPLIER_BATCH_B } from './03-offensive-multiplier-b'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = OFFENSIVE_MULTIPLIER_BATCH_B.find((a) => a.id === id)
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
    ...overrides,
  }
}

function run(id: string, overrides: Partial<OffensiveMultiplierContext> = {}): number {
  const ability = findAbility(id)
  const c = ctx(overrides)
  ability.onOffensiveMultiplier!(c)
  return c.modifier
}

describe('offensive multiplier batch B', () => {
  it('Iron Fist / Keen Edge / Mega Launcher / Striker key off their own move flags', () => {
    expect(run('ABILITY_IRON_FIST', { moveFlags: { punchBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_IRON_FIST')).toBe(uq(1.0))
    expect(run('ABILITY_KEEN_EDGE', { moveFlags: { sliceBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_MEGA_LAUNCHER', { moveFlags: { bulletBased: true } })).toBe(uq(1.3))
    expect(run('ABILITY_STRIKER', { moveFlags: { kickBased: true } })).toBe(uq(1.3))
  })

  it('Neuroforce requires super-effective (>=2x)', () => {
    expect(run('ABILITY_NEUROFORCE', { typeEffectiveness: uq(2.0) })).toBe(uq(1.35))
    expect(run('ABILITY_NEUROFORCE', { typeEffectiveness: uq(1.0) })).toBe(uq(1.0))
  })

  it('Reckless keys off the move\'s own reckless flag', () => {
    expect(run('ABILITY_RECKLESS', { moveFlags: { reckless: true } })).toBe(uq(1.2))
  })

  it('Guts boosts physical moves when statused; Determination boosts special', () => {
    expect(run('ABILITY_GUTS', { attackerHasAnyStatus: true, moveSplit: 'PHYSICAL' })).toBe(uq(1.5))
    expect(run('ABILITY_GUTS', { attackerHasAnyStatus: false, moveSplit: 'PHYSICAL' })).toBe(uq(1.0))
    expect(run('ABILITY_GUTS', { attackerHasAnyStatus: true, moveSplit: 'SPECIAL' })).toBe(uq(1.0))
    expect(run('ABILITY_DETERMINATION', { attackerHasAnyStatus: true, moveSplit: 'SPECIAL' })).toBe(uq(1.5))
  })

  it('every entry in the batch cites a src line', () => {
    for (const ability of OFFENSIVE_MULTIPLIER_BATCH_B) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
