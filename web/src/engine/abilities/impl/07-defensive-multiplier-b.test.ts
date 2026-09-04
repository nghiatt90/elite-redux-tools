import { describe, expect, it } from 'vitest'
import { DEFENSIVE_MULTIPLIER_BATCH_B } from './07-defensive-multiplier-b'
import type { AbilityImpl, DefensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = DEFENSIVE_MULTIPLIER_BATCH_B.find((a) => a.id === id)
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
    attackerActsFirst: true,
    defenderTypes: [],
    defenderAbilityOn: false,
    attackerGender: 'MALE' as const,
    defenderGender: 'MALE' as const,
    ...overrides,
  }
}

function run(id: string, overrides: Partial<DefensiveMultiplierContext> = {}): number {
  const ability = findAbility(id)
  const c = ctx(overrides)
  ability.onDefensiveMultiplier!(c)
  return c.modifier
}

describe('defensive multiplier batch B', () => {
  it('Fluffy: x2 weak to Fire, x0.5 vs contact -- both can stack', () => {
    expect(run('ABILITY_FLUFFY', { moveType: 'FIRE' })).toBe(uq(2.0))
    expect(run('ABILITY_FLUFFY', { moveFlags: { contact: true } })).toBe(uq(0.5))
    // Fire AND contact: x2 then x0.5 nets back to x1.0 (matches the C's own two
    // sequential MUL/RESISTANCE calls on one accumulator)
    expect(run('ABILITY_FLUFFY', { moveType: 'FIRE', moveFlags: { contact: true } })).toBe(uq(1.0))
  })

  it('Fluffiest and Liquified follow the same pattern for their own type', () => {
    expect(run('ABILITY_FLUFFIEST', { moveType: 'FIRE' })).toBe(uq(2.0))
    expect(run('ABILITY_LIQUIFIED', { moveType: 'WATER' })).toBe(uq(2.0))
    expect(run('ABILITY_LIQUIFIED', { moveFlags: { contact: true } })).toBe(uq(0.5))
  })

  it('Feathercoat: x0.7 when resisted (<1x), x0.85 otherwise (neutral or worse)', () => {
    expect(run('ABILITY_FEATHERCOAT', { typeEffectiveness: uq(0.5) })).toBe(uq(0.7))
    expect(run('ABILITY_FEATHERCOAT', { typeEffectiveness: uq(1.0) })).toBe(uq(0.85))
    expect(run('ABILITY_FEATHERCOAT', { typeEffectiveness: uq(2.0) })).toBe(uq(0.85))
  })

  it('Aegis Ward resists Ghost/Dark/Psychic; Elemental Aegis resists Fire/Water/Electric', () => {
    expect(run('ABILITY_AEGIS_WARD', { moveType: 'GHOST' })).toBe(uq(0.5))
    expect(run('ABILITY_AEGIS_WARD', { moveType: 'DARK' })).toBe(uq(0.5))
    expect(run('ABILITY_AEGIS_WARD', { moveType: 'PSYCHIC' })).toBe(uq(0.5))
    expect(run('ABILITY_AEGIS_WARD', { moveType: 'NORMAL' })).toBe(uq(1.0))
    expect(run('ABILITY_ELEMENTAL_AEGIS', { moveType: 'FIRE' })).toBe(uq(0.5))
    expect(run('ABILITY_ELEMENTAL_AEGIS', { moveType: 'WATER' })).toBe(uq(0.5))
    expect(run('ABILITY_ELEMENTAL_AEGIS', { moveType: 'ELECTRIC' })).toBe(uq(0.5))
  })

  it('every entry cites a src line', () => {
    for (const ability of DEFENSIVE_MULTIPLIER_BATCH_B) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
