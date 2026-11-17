/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import { loadBossTrainerIds } from './driver/bossSet'
import { FIGHTS, type FightRow } from './driver/fights'
import {
  distinctStageKeys,
  legalSubsets,
  stageKeyFor,
  stageKeyId,
} from './driver/progression'

function checkTrainerIdCoverage(
  rows: readonly FightRow[],
  expectedIds: readonly string[],
): { valid: boolean; error?: string } {
  const expectedSet = new Set(expectedIds)
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const tid of row.trainerIds) {
      if (!expectedSet.has(tid)) {
        return { valid: false, error: `Unexpected trainer id: ${tid}` }
      }
      counts.set(tid, (counts.get(tid) ?? 0) + 1)
    }
  }

  for (const id of expectedIds) {
    const count = counts.get(id) ?? 0
    if (count !== 1) {
      return {
        valid: false,
        error: `Expected exactly 1 occurrence of ${id}, got ${count}`,
      }
    }
  }

  return { valid: true }
}

describe('Cycle d5-1b boss fight progression table (fights.ts)', () => {
  const bossIds = loadBossTrainerIds()

  it('covers every boss trainer id exactly once with no excess ids', () => {
    expect(bossIds.length).toBe(55)
    const result = checkTrainerIdCoverage(FIGHTS, bossIds)
    expect(result.valid).toBe(true)

    // Detailed verification of counts
    const countMap = new Map<string, number>()
    for (const row of FIGHTS) {
      for (const tid of row.trainerIds) {
        expect(bossIds).toContain(tid)
        countMap.set(tid, (countMap.get(tid) ?? 0) + 1)
      }
    }
    for (const id of bossIds) {
      expect(countMap.get(id)).toBe(1)
    }
  })

  it('rejects a mutated table with one trainer id removed (negative case)', () => {
    // Drop the first trainer id from the first row
    const mutated: FightRow[] = FIGHTS.map((row, idx) => {
      if (idx === 0) {
        return {
          ...row,
          trainerIds: row.trainerIds.slice(1),
        }
      }
      return row
    })
    const checkMutated = checkTrainerIdCoverage(mutated, bossIds)
    expect(checkMutated.valid).toBe(false)
    expect(checkMutated.error).toContain(
      `Expected exactly 1 occurrence of ${bossIds[0]}, got 0`,
    )
  })

  it('verifies row count, fightId identity, and uniqueness', () => {
    // 42 total rows across all 55 boss trainer ids (Gym 8 Juan/Wallace collapsed into 1 row).
    expect(FIGHTS.length).toBe(42)

    const fightIds = new Set<string>()
    for (const row of FIGHTS) {
      expect(row.fightId).toBe(row.trainerIds[0])
      expect(fightIds.has(row.fightId)).toBe(false)
      fightIds.add(row.fightId)
    }
    expect(fightIds.size).toBe(42)
  })

  it('verifies non-empty evidence, non-empty mandatoryCitation, and inferred markings', () => {
    for (const row of FIGHTS) {
      expect(row.evidence.trim().length).toBeGreaterThan(0)
      expect(row.mandatoryCitation.trim().length).toBeGreaterThan(0)
      if (row.inferred === true) {
        expect(row.evidence.startsWith('INFERRED:')).toBe(true)
      }
    }
  })

  it('validates formats and chainId invariants across multi-battle chains', () => {
    const validFormats = new Set(['single', 'double', 'tag', 'multi_2_vs_2'])
    const chainRows = new Map<string, FightRow[]>()

    for (const row of FIGHTS) {
      expect(validFormats.has(row.format)).toBe(true)
      if (row.chainId) {
        const list = chainRows.get(row.chainId) ?? []
        list.push(row)
        chainRows.set(row.chainId, list)
      }
    }

    // Every chainId is shared by at least two rows or one row with at least two trainer ids
    for (const [, rows] of chainRows) {
      const totalTrainers = rows.reduce((sum, r) => sum + r.trainerIds.length, 0)
      const validChain = rows.length >= 2 || totalTrainers >= 2
      expect(validChain).toBe(true)
    }

    // Explicit checks for known chains
    expect(chainRows.has('oceanic-museum-2f')).toBe(true)
    expect(chainRows.get('oceanic-museum-2f')?.length).toBe(3)

    expect(chainRows.has('sootopolis-gym-juan-wallace')).toBe(true)
    expect(
      chainRows.get('sootopolis-gym-juan-wallace')?.[0].trainerIds.length,
    ).toBe(4)

    expect(chainRows.has('mossdeep-space-center-2f-grunts')).toBe(true)
    expect(
      chainRows.get('mossdeep-space-center-2f-grunts')?.[0].trainerIds.length,
    ).toBe(3)

    expect(chainRows.has('sootopolis-gym-bottom-group')).toBe(true)
    expect(chainRows.has('sootopolis-gym-middle-group')).toBe(true)
    expect(chainRows.has('sootopolis-gym-top-group')).toBe(true)
  })

  it('verifies gymNumber 1..8 each present exactly once on gym leader rows', () => {
    const gymLeaderRows = FIGHTS.filter((f) => f.gymNumber !== undefined)
    expect(gymLeaderRows.length).toBe(8)
    const numbers = gymLeaderRows.map((f) => f.gymNumber).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('derives distinct StageKeys over legal subsets with hand checks', () => {
    const mandatoryFightIds = new Set(
      FIGHTS.filter((f) => f.mandatory).map((f) => f.fightId),
    )
    const subsets = legalSubsets(FIGHTS, mandatoryFightIds)
    // Sidney/Phoebe/Glacia/Drake/Steven are mandatory and require all 8 gyms [1..8],
    // so the only legal subset containing all mandatory gyms is {1, 2, 3, 4, 5, 6, 7, 8}.
    expect(subsets.length).toBe(1)
    expect(Array.from(subsets[0]).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    const stageKeys = distinctStageKeys(FIGHTS, subsets)
    // Exactly 12 distinct StageKeys measured across all 42 fights
    expect(stageKeys.length).toBe(12)
    expect(stageKeys.map(stageKeyId)).toEqual([
      'h0-n0-b0',
      'h1-n1-b0',
      'h2-n2-b0',
      'h3-n3-b0',
      'h4-n3-b0',
      'h4-n4-b0',
      'h4-n4-b1',
      'h5-n5-b1',
      'h6-n6-b1',
      'h7-n7-b1',
      'h8-n7-b1',
      'h8-n8-b1',
    ])

    // Hand check 1: May Route 103 (requiredBefore: [], mayBefore: []) -> h0-n0-b0
    const may103 = FIGHTS.find((f) => f.fightId === 'TRAINER_MAY_ROUTE_103_TORCHIC')!
    expect(stageKeyFor(may103, subsets[0])).toEqual({
      highestBadge: 0,
      badgeCount: 0,
      braceletHeld: false,
    })

    // Hand check 2: Winona (requiredBefore: [1, 2, 3, 4, 5], mayBefore: [7, 8]) -> h8-n7-b1
    // (Notice badge 6 itself is missing from clearedBefore, so highestBadge is 8, count is 7, bracelet is held)
    const winona = FIGHTS.find((f) => f.fightId === 'TRAINER_WINONA_1')!
    expect(stageKeyFor(winona, subsets[0])).toEqual({
      highestBadge: 8,
      badgeCount: 7,
      braceletHeld: true,
    })

    // Hand check 3: Brawly (requiredBefore: [1], mayBefore: [3, 4]) -> h4-n3-b0
    // (Notice badge 2 is missing, highestBadge is 4, count is 3, bracelet is false)
    const brawly = FIGHTS.find((f) => f.fightId === 'TRAINER_BRAWLY_1')!
    expect(stageKeyFor(brawly, subsets[0])).toEqual({
      highestBadge: 4,
      badgeCount: 3,
      braceletHeld: false,
    })

    // Hand check 4: Norman (requiredBefore: [1, 2, 3, 4], mayBefore: [], holdsBracelet: true) -> h4-n4-b1
    const norman = FIGHTS.find((f) => f.fightId === 'TRAINER_NORMAN_1')!
    expect(stageKeyFor(norman, subsets[0])).toEqual({
      highestBadge: 4,
      badgeCount: 4,
      braceletHeld: true,
    })
    // Negative case: row with same requiredBefore [1, 2, 3, 4] but no holdsBracelet gives braceletHeld: false
    const normanWithoutBracelet: FightRow = {
      ...norman,
      holdsBracelet: undefined,
    }
    expect(stageKeyFor(normanWithoutBracelet, subsets[0])).toEqual({
      highestBadge: 4,
      badgeCount: 4,
      braceletHeld: false,
    })
  })
})
