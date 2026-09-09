import { describe, expect, it } from 'vitest'
import { APE_SHIFT_COLOR_SPECTRUM_CRYSTALLIZE_ABILITIES } from './43-ape-shift-color-spectrum-crystallize'
import type { AbilityImpl, OffensiveMultiplierContext, OnCritContext, OnMoveTypeContext } from '../types'
import { uq } from '../../fixed'
import { ALWAYS_CRIT } from '../../crit'

function findAbility(id: string): AbilityImpl {
  const entry = APE_SHIFT_COLOR_SPECTRUM_CRYSTALLIZE_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function critCtx(overrides: Partial<OnCritContext> = {}): OnCritContext {
  return {
    battlerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    typeEffectiveness: uq(1.0),
    defenderStatus1: new Set(),
    defenderSpeedStageNegative: false,
    defenderResolvedHoldEffect: null,
    moveFlags: {},
    basePower: 40,
    attackerActsFirst: true,
    abilityOn: false,
    speciesId: 'SPECIES_SLAKING',
    ...overrides,
  }
}

function offCtx(overrides: Partial<OffensiveMultiplierContext> = {}): OffensiveMultiplierContext {
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
    defenderIsConfused: false,
    defenderIsEnraged: false,
    defenderStatus1: new Set(),
    defenderHasBloodStainEffect: false,
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
    ...overrides,
  }
}

function moveTypeCtx(overrides: Partial<OnMoveTypeContext> = {}): OnMoveTypeContext {
  return { battlerId: 'attacker', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', ateBoost: false, moveFlags: {}, ...overrides }
}

describe('Ape Shift batch AR', () => {
  it('always crits while in the exact Mega Ape Shift form', () => {
    const c = critCtx({ speciesId: 'SPECIES_SLAKING_MEGA_APE_SHIFT' })
    expect(findAbility('ABILITY_APE_SHIFT').onCrit!(c)).toBe(ALWAYS_CRIT)
  })

  it('does nothing outside that exact form', () => {
    const c = critCtx({ speciesId: 'SPECIES_SLAKING' })
    expect(findAbility('ABILITY_APE_SHIFT').onCrit!(c)).toBe(0)
  })
})

describe('Color Spectrum batch AR', () => {
  it('boosts 1.2x when the move currently gets STAB', () => {
    const c = offCtx({ attackerHasStab: true })
    findAbility('ABILITY_COLOR_SPECTRUM').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.2))
  })

  it('does not boost without STAB', () => {
    const c = offCtx({ attackerHasStab: false })
    findAbility('ABILITY_COLOR_SPECTRUM').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })
})

describe('Crystallize batch AR', () => {
  it('converts Rock moves to Ice and sets ateBoost', () => {
    const ctx = moveTypeCtx({ moveType: 'ROCK' })
    findAbility('ABILITY_CRYSTALLIZE').onMoveType!(ctx)
    expect(ctx.moveType).toBe('ICE')
    expect(ctx.ateBoost).toBe(true)
  })

  it('leaves non-Rock moves alone', () => {
    const ctx = moveTypeCtx({ moveType: 'WATER' })
    findAbility('ABILITY_CRYSTALLIZE').onMoveType!(ctx)
    expect(ctx.moveType).toBe('WATER')
  })

  it("boosts 1.1x on its OWN converted Ice move (unlike Superconductor's dead combo)", () => {
    const c = offCtx({ moveType: 'ICE', ateBoost: true })
    findAbility('ABILITY_CRYSTALLIZE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.1))
  })

  it('does not boost an Ice move without ateBoost', () => {
    const c = offCtx({ moveType: 'ICE', ateBoost: false })
    findAbility('ABILITY_CRYSTALLIZE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of APE_SHIFT_COLOR_SPECTRUM_CRYSTALLIZE_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
