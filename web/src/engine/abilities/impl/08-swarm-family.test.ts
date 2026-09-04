import { describe, expect, it } from 'vitest'
import { SWARM_FAMILY } from './08-swarm-family'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = SWARM_FAMILY.find((a) => a.id === id)
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

function run(id: string, overrides: Partial<OffensiveMultiplierContext> = {}): number {
  const ability = findAbility(id)
  const c = ctx(overrides)
  ability.onOffensiveMultiplier!(c)
  return c.modifier
}

describe('swarm family', () => {
  it('Overgrow/Blaze/Torrent/Swarm: 1.2x above 1/3 HP, 1.5x at/below', () => {
    expect(run('ABILITY_OVERGROW', { moveType: 'GRASS', attackerHp: 34, attackerMaxHp: 100 })).toBe(uq(1.2))
    expect(run('ABILITY_OVERGROW', { moveType: 'GRASS', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_BLAZE', { moveType: 'FIRE', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_TORRENT', { moveType: 'WATER', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_SWARM', { moveType: 'BUG', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_OVERGROW', { moveType: 'FIRE', attackerHp: 1, attackerMaxHp: 100 })).toBe(uq(1.0))
  })

  it('boosted variants: 1.3x above 1/3 HP, 1.8x at/below', () => {
    expect(run('ABILITY_HELLBLAZE', { moveType: 'FIRE', attackerHp: 34, attackerMaxHp: 100 })).toBe(uq(1.3))
    expect(run('ABILITY_HELLBLAZE', { moveType: 'FIRE', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.8))
    expect(run('ABILITY_RIPTIDE', { moveType: 'WATER', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.8))
    expect(run('ABILITY_FOREST_RAGE', { moveType: 'GRASS', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.8))
    expect(run('ABILITY_PURGATORY', { moveType: 'GHOST', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.8))
    expect(run('ABILITY_GLADIATOR', { moveType: 'FIGHTING', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.8))
    expect(run('ABILITY_ROCKHARD_SHAFT', { moveType: 'ROCK', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.8))
    expect(run('ABILITY_3_GT_1', { moveType: 'WATER', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.8))
    expect(run('ABILITY_OVERWHELMING_MIND', { moveType: 'PSYCHIC', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.8))
  })

  it('the remaining plain-variant abilities key off their own type', () => {
    expect(run('ABILITY_VENGEANCE', { moveType: 'GHOST', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_EARTHBOUND', { moveType: 'GROUND', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_SHORT_CIRCUIT', { moveType: 'ELECTRIC', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_PSYCHIC_MIND', { moveType: 'PSYCHIC', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_FLOCK', { moveType: 'FLYING', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_FIGHTER', { moveType: 'FIGHTING', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_ROCKHARD_WILL', { moveType: 'ROCK', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
    expect(run('ABILITY_FOUL_ENERGY', { moveType: 'DARK', attackerHp: 33, attackerMaxHp: 100 })).toBe(uq(1.5))
  })

  it('every entry cites a src line', () => {
    for (const ability of SWARM_FAMILY) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })

  it('covers all 20 SWARM_MULTIPLIER family abilities', () => {
    expect(SWARM_FAMILY.length).toBe(20)
  })
})
