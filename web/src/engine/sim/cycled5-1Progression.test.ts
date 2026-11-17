/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import {
  clearedBefore,
  distinctStageKeys,
  highestBadgeRange,
  legalSubsets,
  stageKeyFor,
  stageKeyId,
  type GymNumber,
  type ProgressionRow,
} from './driver/progression'

describe('Progression model (StageKey and progression rules)', () => {
  const rowA: ProgressionRow = {
    fightId: 'TRAINER_A',
    requiredBefore: [],
    mayBefore: [1, 2],
    evidence: 'test A',
  }
  const rowB: ProgressionRow = {
    fightId: 'TRAINER_B',
    requiredBefore: [1],
    mayBefore: [2, 5],
    evidence: 'test B',
  }
  const rowC: ProgressionRow = {
    fightId: 'TRAINER_C',
    requiredBefore: [1, 2],
    mayBefore: [5],
    evidence: 'test C',
  }
  const rowD: ProgressionRow = {
    fightId: 'TRAINER_D',
    requiredBefore: [1, 2, 5],
    mayBefore: [],
    evidence: 'test D',
  }
  const handTable: ProgressionRow[] = [rowA, rowB, rowC, rowD]

  it('evaluates clearedBefore and stageKeyFor for hand-derived (row, subset) pairs', () => {
    // Pair 1: empty subset on rowA (required [], may [1,2])
    const c1 = clearedBefore(rowA, new Set<GymNumber>())
    expect(Array.from(c1).sort()).toEqual([])
    expect(stageKeyFor(rowA, new Set<GymNumber>())).toEqual({
      highestBadge: 0,
      badgeCount: 0,
      braceletHeld: false,
    })

    // Pair 2: subset containing gyms strictly outside mayBefore (must be ignored)
    const c2 = clearedBefore(rowA, new Set<GymNumber>([7, 8]))
    expect(Array.from(c2).sort()).toEqual([])
    expect(stageKeyFor(rowA, new Set<GymNumber>([7, 8]))).toEqual({
      highestBadge: 0,
      badgeCount: 0,
      braceletHeld: false,
    })

    // Pair 3: gym 5 in mayBefore and in subset -> braceletHeld true
    const c3 = clearedBefore(rowB, new Set<GymNumber>([5]))
    expect(Array.from(c3).sort()).toEqual([1, 5])
    expect(stageKeyFor(rowB, new Set<GymNumber>([5]))).toEqual({
      highestBadge: 5,
      badgeCount: 2,
      braceletHeld: true,
    })

    // Pair 4: gym 5 in mayBefore but NOT in subset -> braceletHeld false
    const c4 = clearedBefore(rowB, new Set<GymNumber>([2]))
    expect(Array.from(c4).sort()).toEqual([1, 2])
    expect(stageKeyFor(rowB, new Set<GymNumber>([2]))).toEqual({
      highestBadge: 2,
      badgeCount: 2,
      braceletHeld: false,
    })

    // Pair 5: a skipped gym between two held ones (cleared {1,3} -> highestBadge 3, badgeCount 2)
    // Proves highestBadge is the highest badge index, not a count.
    const rowSkipped: ProgressionRow = {
      fightId: 'TRAINER_SKIPPED',
      requiredBefore: [1],
      mayBefore: [3],
      evidence: 'test skipped gym 2',
    }
    const c5 = clearedBefore(rowSkipped, new Set<GymNumber>([3]))
    expect(Array.from(c5).sort()).toEqual([1, 3])
    expect(stageKeyFor(rowSkipped, new Set<GymNumber>([3]))).toEqual({
      highestBadge: 3,
      badgeCount: 2,
      braceletHeld: false,
    })

    // Pair 6: gym outside mayBefore ignored and gym 5 included on rowC (req [1,2], may [5])
    const c6 = clearedBefore(rowC, new Set<GymNumber>([5, 6]))
    expect(Array.from(c6).sort()).toEqual([1, 2, 5])
    expect(stageKeyFor(rowC, new Set<GymNumber>([5, 6]))).toEqual({
      highestBadge: 5,
      badgeCount: 3,
      braceletHeld: true,
    })

    // Pair 7: rowD (req [1,2,5], may []) with all gyms -> mayBefore empty, subset adds nothing
    const c7 = clearedBefore(rowD, new Set<GymNumber>([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(Array.from(c7).sort()).toEqual([1, 2, 5])
    expect(stageKeyFor(rowD, new Set<GymNumber>([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
      highestBadge: 5,
      badgeCount: 3,
      braceletHeld: true,
    })
  })

  it('formats stable stageKeyId matching the canonical format', () => {
    expect(stageKeyId({ highestBadge: 3, badgeCount: 3, braceletHeld: false })).toBe('h3-n3-b0')
    expect(stageKeyId({ highestBadge: 5, badgeCount: 2, braceletHeld: true })).toBe('h5-n2-b1')
    expect(stageKeyId({ highestBadge: 0, badgeCount: 0, braceletHeld: false })).toBe('h0-n0-b0')
  })

  it('derives highestBadgeRange for each of the 4 hand rows', () => {
    // Row A: required [], may [1,2] -> min 0, max 2
    expect(highestBadgeRange(rowA)).toEqual({ min: 0, max: 2 })
    // Row B: required [1], may [2,5] -> min 1, max 5
    expect(highestBadgeRange(rowB)).toEqual({ min: 1, max: 5 })
    // Row C: required [1,2], may [5] -> min 2, max 5
    expect(highestBadgeRange(rowC)).toEqual({ min: 2, max: 5 })
    // Row D: required [1,2,5], may [] -> min 5, max 5
    expect(highestBadgeRange(rowD)).toEqual({ min: 5, max: 5 })
  })

  it('generates legalSubsets with mandatory constraints and ordering', () => {
    // 1. Empty mandatory set -> all 2^8 = 256 subsets
    const all256 = legalSubsets(handTable, new Set<string>())
    expect(all256.length).toBe(256)
    expect(all256[0]).toEqual(new Set<GymNumber>())
    expect(all256[255]).toEqual(new Set<GymNumber>([1, 2, 3, 4, 5, 6, 7, 8]))

    // 2. Mandatory {C}: requires gyms [1, 2] -> 2^(8-2) = 64 subsets
    const subsetsC = legalSubsets(handTable, new Set<string>(['TRAINER_C']))
    expect(subsetsC.length).toBe(64)
    // Smallest size subset containing 1 and 2 is {1, 2}
    expect(subsetsC[0]).toEqual(new Set<GymNumber>([1, 2]))
    // Negative assertion: no returned subset omits a required gym
    for (const subset of subsetsC) {
      expect(subset.has(1)).toBe(true)
      expect(subset.has(2)).toBe(true)
    }

    // 3. Mandatory {D}: requires gyms [1, 2, 5] -> 2^(8-3) = 32 subsets
    const subsetsD = legalSubsets(handTable, new Set<string>(['TRAINER_D']))
    expect(subsetsD.length).toBe(32)
    expect(subsetsD[0]).toEqual(new Set<GymNumber>([1, 2, 5]))
    // Negative assertion: no returned subset omits a required gym
    for (const subset of subsetsD) {
      expect(subset.has(1)).toBe(true)
      expect(subset.has(2)).toBe(true)
      expect(subset.has(5)).toBe(true)
    }

    // Ordering verification: size ascending, then lexicographically
    for (let i = 1; i < subsetsC.length; i++) {
      const prev = subsetsC[i - 1]
      const curr = subsetsC[i]
      if (prev.size === curr.size) {
        const prevArr = Array.from(prev).sort((a, b) => a - b)
        const currArr = Array.from(curr).sort((a, b) => a - b)
        let diffFound = false
        for (let j = 0; j < prevArr.length; j++) {
          if (prevArr[j] !== currArr[j]) {
            expect(prevArr[j]).toBeLessThan(currArr[j])
            diffFound = true
            break
          }
        }
        expect(diffFound).toBe(true)
      } else {
        expect(prev.size).toBeLessThan(curr.size)
      }
    }
  })

  it('de-duplicates distinctStageKeys across rows and subsets', () => {
    // Hand derivation over all 256 subsets:
    // Row A (req [], may [1,2]):
    //   - subset ∩ {1,2} = {}      -> cleared {}      -> h0-n0-b0
    //   - subset ∩ {1,2} = {1}     -> cleared {1}     -> h1-n1-b0
    //   - subset ∩ {1,2} = {2}     -> cleared {2}     -> h2-n1-b0
    //   - subset ∩ {1,2} = {1,2}   -> cleared {1,2}   -> h2-n2-b0
    // Row B (req [1], may [2,5]):
    //   - subset ∩ {2,5} = {}      -> cleared {1}     -> h1-n1-b0 (collapses with A)
    //   - subset ∩ {2,5} = {2}     -> cleared {1,2}   -> h2-n2-b0 (collapses with A)
    //   - subset ∩ {2,5} = {5}     -> cleared {1,5}   -> h5-n2-b1
    //   - subset ∩ {2,5} = {2,5}   -> cleared {1,2,5} -> h5-n3-b1
    // Row C (req [1,2], may [5]):
    //   - subset ∩ {5} = {}        -> cleared {1,2}   -> h2-n2-b0 (collapses with A, B)
    //   - subset ∩ {5} = {5}       -> cleared {1,2,5} -> h5-n3-b1 (collapses with B)
    // Row D (req [1,2,5], may []):
    //   - subset ∩ {} = {}         -> cleared {1,2,5} -> h5-n3-b1 (collapses with B, C)
    //
    // Union of unique StageKeys across all 4 rows and all 256 subsets is exactly 6 keys:
    // 1. h0-n0-b0
    // 2. h1-n1-b0
    // 3. h2-n1-b0
    // 4. h2-n2-b0
    // 5. h5-n2-b1
    // 6. h5-n3-b1
    const all256 = legalSubsets(handTable, new Set<string>())
    const distinct = distinctStageKeys(handTable, all256)
    expect(distinct.length).toBe(6)
    expect(distinct.map(stageKeyId)).toEqual([
      'h0-n0-b0',
      'h1-n1-b0',
      'h2-n1-b0',
      'h2-n2-b0',
      'h5-n2-b1',
      'h5-n3-b1',
    ])

    // Prove collapse: two different subsets yielding the same StageKey collapse to one entry
    // E.g. For row A: subset {} and subset {3, 4, 6, 7, 8} both yield h0-n0-b0
    const subsetEmpty = new Set<GymNumber>()
    const subsetHighGyms = new Set<GymNumber>([3, 4, 6, 7, 8])
    expect(stageKeyFor(rowA, subsetEmpty)).toEqual(stageKeyFor(rowA, subsetHighGyms))
    const collapsed = distinctStageKeys([rowA], [subsetEmpty, subsetHighGyms])
    expect(collapsed.length).toBe(1)
    expect(stageKeyId(collapsed[0])).toBe('h0-n0-b0')
  })

  it('brackets highestBadge within highestBadgeRange for all rows and subsets', () => {
    const all256 = legalSubsets(handTable, new Set<string>())

    // 1. Concrete widening demonstration on Row B (required [1], may [2, 5], range min 1, max 5):
    const rangeB = highestBadgeRange(rowB)
    expect(rangeB).toEqual({ min: 1, max: 5 })

    // Subset {} produces min
    const keyBMin = stageKeyFor(rowB, new Set<GymNumber>())
    expect(keyBMin.highestBadge).toBe(rangeB.min) // 1

    // Subset {2} produces intermediate value between min and max
    const keyBMid = stageKeyFor(rowB, new Set<GymNumber>([2]))
    expect(keyBMid.highestBadge).toBe(2)
    expect(keyBMid.highestBadge).toBeGreaterThan(rangeB.min)
    expect(keyBMid.highestBadge).toBeLessThan(rangeB.max)

    // Subset {5} produces max
    const keyBMax = stageKeyFor(rowB, new Set<GymNumber>([5]))
    expect(keyBMax.highestBadge).toBe(rangeB.max) // 5

    // 2. Comprehensive bracket invariant: min <= highestBadge <= max
    for (const row of handTable) {
      const { min, max } = highestBadgeRange(row)
      for (const subset of all256) {
        const key = stageKeyFor(row, subset)
        expect(key.highestBadge).toBeGreaterThanOrEqual(min)
        expect(key.highestBadge).toBeLessThanOrEqual(max)
      }
    }
  })
})
