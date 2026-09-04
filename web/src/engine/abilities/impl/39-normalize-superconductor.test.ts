import { describe, expect, it } from 'vitest'
import { NORMALIZE_SUPERCONDUCTOR_ABILITIES } from './39-normalize-superconductor'
import type { AbilityImpl, OffensiveMultiplierContext, OnMoveTypeContext, OnTypeEffectivenessContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = NORMALIZE_SUPERCONDUCTOR_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function moveTypeCtx(overrides: Partial<OnMoveTypeContext> = {}): OnMoveTypeContext {
  return { battlerId: 'attacker', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', ateBoost: false, moveFlags: {}, ...overrides }
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

describe('Normalize batch AN', () => {
  it('unconditionally converts every move to Normal', () => {
    const ctx = moveTypeCtx({ moveType: 'FIRE' })
    findAbility('ABILITY_NORMALIZE').onMoveType!(ctx)
    expect(ctx.moveType).toBe('NORMAL')
  })

  it('does NOT set ateBoost itself', () => {
    const ctx = moveTypeCtx({ moveType: 'FIRE' })
    findAbility('ABILITY_NORMALIZE').onMoveType!(ctx)
    expect(ctx.ateBoost).toBe(false)
  })

  it('boosts 1.1x on a Normal move only when ateBoost was set by something else this turn', () => {
    const c = offCtx({ moveType: 'NORMAL', ateBoost: true })
    findAbility('ABILITY_NORMALIZE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.1))
  })

  it('does not boost without ateBoost', () => {
    const c = offCtx({ moveType: 'NORMAL', ateBoost: false })
    findAbility('ABILITY_NORMALIZE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('boosts a resisted (but not immune) Normal-type hit up to neutral', () => {
    const c: OnTypeEffectivenessContext = { attackerId: 'a', defenderId: 'd', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', modifier: uq(0.5), defType: 'ROCK' }
    findAbility('ABILITY_NORMALIZE').onTypeEffectiveness!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('does not rescue an outright immunity (mod === 0)', () => {
    const c: OnTypeEffectivenessContext = { attackerId: 'a', defenderId: 'd', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', modifier: 0, defType: 'GHOST' }
    findAbility('ABILITY_NORMALIZE').onTypeEffectiveness!(c)
    expect(c.modifier).toBe(0)
  })

  it('does not touch a non-Normal move (moveType only ever Normal post-conversion, but guard anyway)', () => {
    const c: OnTypeEffectivenessContext = { attackerId: 'a', defenderId: 'd', moveId: 'MOVE_TACKLE', moveType: 'FIRE', modifier: uq(0.5), defType: 'WATER' }
    findAbility('ABILITY_NORMALIZE').onTypeEffectiveness!(c)
    expect(c.modifier).toBe(uq(0.5))
  })
})

describe('Superconductor batch AN', () => {
  it('converts Steel-type moves to Electric and sets ateBoost', () => {
    const ctx = moveTypeCtx({ moveType: 'STEEL' })
    findAbility('ABILITY_SUPERCONDUCTOR').onMoveType!(ctx)
    expect(ctx.moveType).toBe('ELECTRIC')
    expect(ctx.ateBoost).toBe(true)
  })

  it('leaves non-Steel moves alone', () => {
    const ctx = moveTypeCtx({ moveType: 'WATER' })
    findAbility('ABILITY_SUPERCONDUCTOR').onMoveType!(ctx)
    expect(ctx.moveType).toBe('WATER')
    expect(ctx.ateBoost).toBe(false)
  })

  it("its own Steel->Electric conversion never satisfies its own bonus (final type is Electric, not Normal)", () => {
    // Matches the C exactly: the offensive-multiplier check is moveType==NORMAL,
    // but this ability's own onMoveType never leaves the type as Normal.
    const c = offCtx({ moveType: 'ELECTRIC', ateBoost: true })
    findAbility('ABILITY_SUPERCONDUCTOR').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it('boosts 1.1x when ANOTHER ability left the move as Normal with ateBoost set (multi-ability combo)', () => {
    const c = offCtx({ moveType: 'NORMAL', ateBoost: true })
    findAbility('ABILITY_SUPERCONDUCTOR').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.1))
  })

  it('every entry cites a src line', () => {
    for (const ability of NORMALIZE_SUPERCONDUCTOR_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
