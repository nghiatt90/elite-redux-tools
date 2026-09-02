import { describe, expect, it } from 'vitest'
import { ALWAYS_CRIT, calcCritStage, critChanceDenominator, isCriticalHit, NEVER_CRIT, type CritStageInputs } from './crit'

const GEN7_CHANCE = [24, 8, 2, 1, 1] // natures.json's criticalHitChance

function inputs(overrides: Partial<CritStageInputs> = {}): CritStageInputs {
  return {
    isBlocked: false,
    isGuaranteed: false,
    abilityCritBonus: 0,
    hasHighCritFlag: false,
    hasScopeLens: false,
    hasLuckyPunchOnChanseyLine: false,
    hasLeekOnFarfetchdLine: false,
    isViseGrip: false,
    ...overrides,
  }
}

describe('calcCritStage', () => {
  it('a normal move at base stage is 0', () => {
    expect(calcCritStage(inputs())).toBe(0)
  })

  it('Lucky Chant / cant-score-a-crit blocks outright', () => {
    expect(calcCritStage(inputs({ isBlocked: true, hasHighCritFlag: true }))).toBe(NEVER_CRIT)
  })

  it('a guaranteed crit (Laser Focus, Flail at low HP, ...) short-circuits to ALWAYS_CRIT', () => {
    expect(calcCritStage(inputs({ isGuaranteed: true }))).toBe(ALWAYS_CRIT)
  })

  it('FLAG_HIGH_CRIT + Scope Lens stack to stage 2', () => {
    expect(calcCritStage(inputs({ hasHighCritFlag: true, hasScopeLens: true }))).toBe(2)
  })

  it('Lucky Punch on the Chansey line is worth +2', () => {
    expect(calcCritStage(inputs({ hasLuckyPunchOnChanseyLine: true }))).toBe(2)
  })

  it('stage is clamped at ALWAYS_CRIT even if bonuses would exceed it', () => {
    expect(calcCritStage(inputs({ hasHighCritFlag: true, hasScopeLens: true, hasLuckyPunchOnChanseyLine: true, isViseGrip: true }))).toBe(ALWAYS_CRIT)
  })
})

describe('critChanceDenominator', () => {
  it('stage 0-3 map to the GEN_7 table directly', () => {
    expect(critChanceDenominator(0, GEN7_CHANCE)).toBe(24)
    expect(critChanceDenominator(1, GEN7_CHANCE)).toBe(8)
    expect(critChanceDenominator(2, GEN7_CHANCE)).toBe(2)
    expect(critChanceDenominator(3, GEN7_CHANCE)).toBe(1)
  })

  it('NEVER_CRIT has no denominator', () => {
    expect(critChanceDenominator(NEVER_CRIT, GEN7_CHANCE)).toBeNull()
  })
})

describe('isCriticalHit', () => {
  it('null denominator (never crit) is always false', () => {
    expect(isCriticalHit(0, null)).toBe(false)
  })

  it('roll is a hit exactly when critRoll % denominator === 0', () => {
    expect(isCriticalHit(0, 8)).toBe(true)
    expect(isCriticalHit(8, 8)).toBe(true)
    expect(isCriticalHit(1, 8)).toBe(false)
  })

  it('denominator 1 (ALWAYS_CRIT) always hits', () => {
    for (let roll = 0; roll < 24; roll++) expect(isCriticalHit(roll, 1)).toBe(true)
  })
})
