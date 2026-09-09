import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyExtraStatLevels, applyStatStage, applyStatusHalving, calcHp, calcStat, natureDelta } from './stats'
import type { BattleConstants } from './types'

// Read the committed snapshot directly, not web/public/data/ (a sync-data copy that
// can be stale) -- same convention the pipeline's own tests use for the real data.
const NATURES_PATH = fileURLToPath(new URL('../../../data/v2.65beta/natures.json', import.meta.url))
const constants: BattleConstants = JSON.parse(readFileSync(NATURES_PATH, 'utf-8'))
const { natureStatTable, statStageRatios } = constants

describe('natureDelta', () => {
  it('Adamant: +Atk, -SpAtk, neutral otherwise', () => {
    expect(natureDelta('NATURE_ADAMANT', 'atk', natureStatTable)).toBe(1)
    expect(natureDelta('NATURE_ADAMANT', 'spatk', natureStatTable)).toBe(-1)
    expect(natureDelta('NATURE_ADAMANT', 'def', natureStatTable)).toBe(0)
    expect(natureDelta('NATURE_ADAMANT', 'spdef', natureStatTable)).toBe(0)
    expect(natureDelta('NATURE_ADAMANT', 'spe', natureStatTable)).toBe(0)
  })

  it('Hardy (neutral) touches nothing', () => {
    for (const stat of ['atk', 'def', 'spatk', 'spdef', 'spe'] as const) {
      expect(natureDelta('NATURE_HARDY', stat, natureStatTable)).toBe(0)
    }
  })
})

describe('calcStat', () => {
  it('Garchomp, L100, Adamant, 252 Atk EV, 31 IV', () => {
    // base Atk 130 (species.json) -- n = floor((2*130 + 31 + floor(252/4)) * 100 / 100) + 5
    //   = floor((260 + 31 + 63) * 100 / 100) + 5 = 354 + 5 = 359   [pokemon.c:958]
    // Adamant +Atk: floor(359 * 110 / 100) = floor(394.9) = 394    [pokemon.c:3494]
    expect(calcStat(130, 31, 252, 100, 'NATURE_ADAMANT', 'atk', natureStatTable)).toBe(394)
  })

  it('a negative nature truncates the same way', () => {
    // base 100, 0 IV, 0 EV, L50. Modest raises SpAtk and lowers Atk:
    // n = floor((200 + 0 + 0) * 50 / 100) + 5 = 100 + 5 = 105
    // floor(105 * 90 / 100) = floor(94.5) = 94
    expect(calcStat(100, 0, 0, 50, 'NATURE_MODEST', 'atk', natureStatTable)).toBe(94)
  })

  it('neutral nature leaves n untouched', () => {
    // base 100, 31 IV, 0 EV, L100, Hardy (neutral everywhere):
    // n = floor((200 + 31 + 0) * 100 / 100) + 5 = 231 + 5 = 236
    expect(calcStat(100, 31, 0, 100, 'NATURE_HARDY', 'atk', natureStatTable)).toBe(236)
  })

  it('EV is truncated to multiples of 4 before entering the formula', () => {
    // ev=255 and ev=252 must produce the same n, since floor(255/4) === floor(252/4) === 63
    const a = calcStat(100, 31, 255, 100, 'NATURE_HARDY', 'atk', natureStatTable)
    const b = calcStat(100, 31, 252, 100, 'NATURE_HARDY', 'atk', natureStatTable)
    expect(a).toBe(b)
  })
})

describe('calcHp', () => {
  it('Garchomp, L100, 31 IV, 0 EV', () => {
    // base HP 108: n = 2*108 + 31 = 247
    // maxHp = floor((247 + 0) * 100 / 100) + 100 + 10 = 247 + 110 = 357
    expect(calcHp(108, 31, 0, 100, false)).toBe(357)
  })

  it('Shedinja always has exactly 1 max HP, regardless of inputs', () => {
    expect(calcHp(1, 31, 252, 100, true)).toBe(1)
    expect(calcHp(999, 0, 0, 1, true)).toBe(1)
  })

  it('HP is always at least level + 10, even at 0 base/IV/EV', () => {
    expect(calcHp(0, 0, 0, 50, false)).toBe(60)
  })
})

describe('applyStatStage (gStatStageRatios, src/pokemon.c:172-186)', () => {
  it('stage 0 (index 6, DEFAULT_STAT_STAGE) is a no-op', () => {
    expect(applyStatStage(300, 6, statStageRatios)).toBe(300)
  })

  it('+6 (index 12) is x4, -6 (index 0) is x0.25 -- vanilla-shaped ratios', () => {
    expect(applyStatStage(100, 12, statStageRatios)).toBe(400) // 100*40/10
    expect(applyStatStage(100, 0, statStageRatios)).toBe(25) // 100*10/40
  })

  it('multiplies by the full numerator before the single truncating divide', () => {
    // -1 (index 5): ratio [10, 15]. floor(23*10/15) = floor(230/15) = floor(15.33) = 15
    expect(applyStatStage(23, 5, statStageRatios)).toBe(15)
  })
})

describe('applyExtraStatLevels', () => {
  it('adds 20% of the post-stage value per level, floored', () => {
    // 359 + floor(359/5)*1 = 359 + 71 = 430
    expect(applyExtraStatLevels(359, 1)).toBe(430)
    expect(applyExtraStatLevels(359, 0)).toBe(359)
  })
})

describe('applyStatusHalving', () => {
  it('halves and truncates, e.g. an odd stat under burn', () => {
    expect(applyStatusHalving(394)).toBe(197)
    expect(applyStatusHalving(105)).toBe(52) // floor(105/2)
  })
})
