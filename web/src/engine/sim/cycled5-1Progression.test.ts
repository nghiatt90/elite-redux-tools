/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import * as progression from './driver/progression'
import {
  clearedBefore,
  distinctStageKeys,
  highestBadgeRange,
  stageKeyFor,
  stageKeyId,
  type GymNumber,
  type ProgressionRow,
} from './driver/progression'

function row(
  fightId: string,
  requiredBefore: GymNumber[],
  extra: Partial<ProgressionRow> = {},
): ProgressionRow {
  return { fightId, requiredBefore, mayBefore: [], evidence: `test ${fightId}`, ...extra }
}

describe('Progression model (StageKey and progression rules)', () => {
  it('derives the StageKey from requiredBefore alone', () => {
    expect(stageKeyFor(row('EMPTY', []))).toEqual({
      highestBadge: 0,
      badgeCount: 0,
      braceletHeld: false,
    })
    expect(stageKeyFor(row('THREE', [1, 2, 3]))).toEqual({
      highestBadge: 3,
      badgeCount: 3,
      braceletHeld: false,
    })
    // Gym 5 cleared means the bracelet is held, no holdsBracelet needed.
    expect(stageKeyFor(row('FIVE', [1, 2, 3, 4, 5]))).toEqual({
      highestBadge: 5,
      badgeCount: 5,
      braceletHeld: true,
    })
    // Negative case: badge 4 only, bracelet comes from the row flag, not badge 5.
    expect(stageKeyFor(row('BRACELET', [1, 2, 3, 4], { holdsBracelet: true }))).toEqual({
      highestBadge: 4,
      badgeCount: 4,
      braceletHeld: true,
    })
    expect(stageKeyFor(row('NO_BRACELET', [1, 2, 3, 4], { holdsBracelet: false }))).toEqual({
      highestBadge: 4,
      badgeCount: 4,
      braceletHeld: false,
    })
  })

  it('clears exactly requiredBefore', () => {
    expect(clearedBefore(row('REQ', [1, 2, 3]))).toEqual(new Set<GymNumber>([1, 2, 3]))
    expect(clearedBefore(row('EMPTY', []))).toEqual(new Set<GymNumber>())
  })

  it('formats stable stageKeyId matching the canonical format', () => {
    expect(stageKeyId({ highestBadge: 3, badgeCount: 3, braceletHeld: false })).toBe('h3-n3-b0')
    expect(stageKeyId({ highestBadge: 5, badgeCount: 2, braceletHeld: true })).toBe('h5-n2-b1')
    expect(stageKeyId({ highestBadge: 0, badgeCount: 0, braceletHeld: false })).toBe('h0-n0-b0')
  })

  it('de-duplicates distinctStageKeys by stageKeyId, sorted', () => {
    const table = [
      row('A', []),
      row('B', [1]),
      row('C', [1]),
      row('D', [1, 2]),
      row('E', [1, 2, 3, 4], { holdsBracelet: true }),
      row('F', [1, 2, 3, 4, 5]),
    ]
    const keys = distinctStageKeys(table)
    expect(keys.map(stageKeyId)).toEqual([
      'h0-n0-b0',
      'h1-n1-b0',
      'h2-n2-b0',
      'h4-n4-b1',
      'h5-n5-b1',
    ])
    // Six rows, two of them [1]; the duplicate collapses.
    expect(keys.length).toBe(5)
    expect(keys.length).not.toBe(table.length)
  })

  it('derives highestBadgeRange on rows with empty mayBefore', () => {
    expect(highestBadgeRange(row('A', []))).toEqual({ min: 0, max: 0 })
    expect(highestBadgeRange(row('B', [1, 2]))).toEqual({ min: 2, max: 2 })
    expect(highestBadgeRange(row('C', [1, 2, 5]))).toEqual({ min: 5, max: 5 })
  })

  it('no longer exports legalSubsets (fixed route)', () => {
    expect('legalSubsets' in progression).toBe(false)
  })
})
