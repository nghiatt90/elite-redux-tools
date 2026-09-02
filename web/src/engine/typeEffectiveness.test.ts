import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { baseTypeEffectiveness, calcTypeEffectiveness, distinctDefendingTypes, type TypeChart } from './typeEffectiveness'
import { uq } from './fixed'

const TYPES_PATH = fileURLToPath(new URL('../../../data/v2.65beta/types.json', import.meta.url))
const chart: TypeChart = JSON.parse(readFileSync(TYPES_PATH, 'utf-8'))

describe('baseTypeEffectiveness', () => {
  it('reads the real chart', () => {
    expect(chart['FIRE']['GRASS']).toBe(2.0)
    expect(baseTypeEffectiveness('FIRE', 'GRASS', chart)).toBe(uq(2.0))
  })

  it('neutral is 1.0', () => {
    expect(baseTypeEffectiveness('NORMAL', 'NORMAL', chart)).toBe(uq(1.0))
  })

  it('immunity is 0', () => {
    expect(chart['NORMAL']['GHOST']).toBe(0)
    expect(baseTypeEffectiveness('NORMAL', 'GHOST', chart)).toBe(0)
  })
})

describe('distinctDefendingTypes', () => {
  it('single-type defender', () => {
    expect(distinctDefendingTypes(['FIRE'])).toEqual(['FIRE'])
  })

  it('dual-type defender', () => {
    expect(distinctDefendingTypes(['FIRE', 'FLYING'])).toEqual(['FIRE', 'FLYING'])
  })

  it('drops a duplicate second type', () => {
    expect(distinctDefendingTypes(['FIRE', 'FIRE'])).toEqual(['FIRE'])
  })

  it('a real third type is kept when distinct from the first two', () => {
    expect(distinctDefendingTypes(['FIRE', 'FLYING', 'DRAGON'])).toEqual(['FIRE', 'FLYING', 'DRAGON'])
  })

  it('MYSTERY (no third type) is dropped', () => {
    expect(distinctDefendingTypes(['FIRE', 'FLYING', 'MYSTERY'])).toEqual(['FIRE', 'FLYING'])
  })
})

describe('calcTypeEffectiveness', () => {
  it('single-type: matches the chart directly', () => {
    expect(calcTypeEffectiveness('WATER', ['FIRE'], chart)).toBe(uq(2.0))
  })

  it('dual-type: three separate rounding steps, not one product -- Ground vs Steel/Flying', () => {
    // Ground is 2x vs Steel, 0x vs Flying -- an immune combination regardless of order.
    expect(chart['GROUND']['STEEL']).toBe(2.0)
    expect(chart['GROUND']['FLYING']).toBe(0)
    expect(calcTypeEffectiveness('GROUND', ['STEEL', 'FLYING'], chart)).toBe(0)
  })

  it('dual-type 4x case folds through two mulModifier calls', () => {
    // Fire is 2x vs Grass and 2x vs Bug (e.g. vs a Grass/Bug defender) -> 4x overall.
    expect(chart['FIRE']['GRASS']).toBe(2.0)
    expect(chart['FIRE']['BUG']).toBe(2.0)
    expect(calcTypeEffectiveness('FIRE', ['GRASS', 'BUG'], chart)).toBe(uq(4.0))
  })

  it('a Ground move whiffs on a non-grounded defender even if the chart says otherwise', () => {
    // Ground vs pure Normal is neutral (1x) on the chart, but a non-grounded Normal
    // defender (hypothetically airborne/Levitate) is still immune to Ground moves --
    // src/battle_util.c:7973-7977, applied after the chart fold.
    expect(chart['GROUND']['NORMAL']).toBe(1.0)
    expect(calcTypeEffectiveness('GROUND', ['NORMAL'], chart, false)).toBe(0)
  })

  it('grounded defenders are unaffected by the levitation check', () => {
    expect(calcTypeEffectiveness('GROUND', ['NORMAL'], chart, true)).toBe(uq(1.0))
  })

  it('non-Ground moves ignore groundedness entirely', () => {
    expect(calcTypeEffectiveness('WATER', ['FIRE'], chart, false)).toBe(uq(2.0))
  })

  it('unspecified opposing pairs default to neutral, matching the chart lookup fallback', () => {
    // every real (attack, defense) pair is present in the emitted chart, but the
    // fallback exists for robustness against a malformed/partial chart at runtime.
    expect(baseTypeEffectiveness('NOT_A_TYPE', 'ALSO_NOT_A_TYPE', chart)).toBe(uq(1.0))
  })
})
