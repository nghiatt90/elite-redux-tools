import { describe, expect, it } from 'vitest'
import { calcKoChances, guaranteedKoHits, minimumPossibleKoHits } from './kochance'

describe('calcKoChances', () => {
  it('a guaranteed one-hit KO: every roll exceeds maxHp', () => {
    const entries = calcKoChances([120, 121, 122], 100)
    expect(entries[0]).toEqual({ hits: 1, probability: 1 })
    expect(entries).toHaveLength(1) // stops once guaranteed
  })

  it('a guaranteed two-hit KO with a fixed roll (50 dmg, 100 maxHp)', () => {
    const entries = calcKoChances([50], 100)
    expect(entries[0].probability).toBe(0) // 1 hit: 50 < 100
    expect(entries[1].probability).toBe(1) // 2 hits: 50+50 = 100
  })

  it('a two-value roll set: hand-computed probabilities', () => {
    // rolls [40, 60], maxHp 100.
    // after hit 1: {40: .5, 60: .5} -- KO prob 0 (neither reaches 100)
    // after hit 2: 40+40=80(.25), 40+60=100(.25), 60+40=100(.25), 60+60=120->100(.25)
    //   -> {80: .25, 100: .75} -- KO prob .75
    const entries = calcKoChances([40, 60], 100)
    expect(entries[0].probability).toBe(0)
    expect(entries[1].probability).toBeCloseTo(0.75, 10)
  })

  it('never reaches maxHp within MAX_HITS: entries has 9 rows, last still < 1', () => {
    const entries = calcKoChances([1], 1000)
    expect(entries).toHaveLength(9)
    expect(entries[8].probability).toBeLessThan(1)
  })

  it('empty rolls or non-positive maxHp return no entries', () => {
    expect(calcKoChances([], 100)).toEqual([])
    expect(calcKoChances([50], 0)).toEqual([])
  })
})

describe('guaranteedKoHits', () => {
  it('returns the first guaranteed hit count', () => {
    const entries = calcKoChances([50], 100)
    expect(guaranteedKoHits(entries)).toBe(2)
  })

  it('returns null when nothing is guaranteed within MAX_HITS', () => {
    const entries = calcKoChances([1], 1000)
    expect(guaranteedKoHits(entries)).toBeNull()
  })
})

describe('minimumPossibleKoHits', () => {
  it('returns the first hit count with any KO chance at all', () => {
    const entries = calcKoChances([40, 60], 100)
    expect(minimumPossibleKoHits(entries)).toBe(2)
  })

  it('a move that can 1HKO sometimes reports 1', () => {
    const entries = calcKoChances([90, 110], 100)
    expect(minimumPossibleKoHits(entries)).toBe(1)
  })
})
