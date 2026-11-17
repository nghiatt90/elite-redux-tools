/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import { loadBossTrainerIds } from './driver/bossSet'
import { FIGHTS, type FightRow } from './driver/fights'
import { distinctStageKeys, stageKeyFor, stageKeyId } from './driver/progression'

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

// Route-only row: Wally at Mauville is on Yoshi's route but is not in the boss id list.
const ROUTE_ONLY_ROW_IDS = new Set<string>(['TRAINER_WALLY_MAUVILLE'])

const DEFERRED_ROWS = new Set<string>([
  'TRAINER_MAY_ROUTE_103_TORCHIC',
  'TRAINER_GRUNT_SUNHOLLOW_1',
  'TRAINER_GRUNT_SPACE_CENTER_2',
  'TRAINER_TIFFANY',
  'TRAINER_BRIDGET',
  'TRAINER_DAPHNE',
  'TRAINER_OLIVIA',
])

const EXCLUDED_ROWS = new Set<string>(['TRAINER_WALLY_VR_1', 'TRAINER_WALLY_VR_2'])

const EXPECTED_REQUIRED_BEFORE: Record<string, number[]> = {
  TRAINER_MAY_ROUTE_103_TORCHIC: [],
  TRAINER_MAY_RUSTBORO_TORCHIC: [1],
  TRAINER_MAY_ROUTE_110_TORCHIC: [1, 2],
  TRAINER_MAY_ROUTE_119_TORCHIC: [1, 2, 3, 4, 5],
  TRAINER_ROXANNE_1: [],
  TRAINER_BRAWLY_1: [1],
  TRAINER_WATTSON_1: [1, 2],
  TRAINER_FLANNERY_1: [1, 2, 3],
  TRAINER_NORMAN_1: [1, 2, 3, 4],
  TRAINER_WINONA_1: [1, 2, 3, 4, 5],
  TRAINER_TATE_AND_LIZA_1: [1, 2, 3, 4, 5, 6],
  TRAINER_JUAN_1: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_GRUNT_PETALBURG_WOODS: [],
  TRAINER_GRUNT_RUSTURF_TUNNEL: [1],
  TRAINER_SHELLY_WEATHER_INSTITUTE: [1, 2, 3, 4, 5],
  TRAINER_MATT: [1, 2, 3, 4, 5, 6],
  TRAINER_GRUNT_MUSEUM_1: [1, 2],
  TRAINER_GRUNT_MUSEUM_2: [1, 2],
  TRAINER_ARCHIE_SLATEPORT: [1, 2],
  TRAINER_ARCHIE_MT_PYRE: [1, 2, 3, 4, 5, 6],
  TRAINER_ARCHIE: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_COURTNEY_METEOR_FALLS: [1, 2, 3],
  TRAINER_GRUNT_SUNHOLLOW_1: [1, 2, 3, 4],
  TRAINER_COURTNEY_SUNHOLLOW: [1, 2, 3, 4],
  TRAINER_GRUNT_SPACE_CENTER_2: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_GRUNT_SPACE_CENTER_5: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_MAXIE_MT_CHIMNEY: [1, 2, 3],
  TRAINER_MAXIE_MAGMA_HIDEOUT: [1, 2, 3, 4, 5, 6],
  TRAINER_MAXIE_MOSSDEEP: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_STEVEN_GRANITE_CAVE: [1],
  TRAINER_STEVEN_ROUTE118: [1, 2, 3, 4, 5],
  TRAINER_STEVEN: [1, 2, 3, 4, 5, 6, 7, 8],
  TRAINER_WALLY_VR_1: [1, 2, 3, 4, 5, 6, 7, 8],
  TRAINER_WALLY_VR_2: [1, 2, 3, 4, 5, 6, 7, 8],
  TRAINER_WALLY_MAUVILLE: [1, 2],
  TRAINER_TIFFANY: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_BRIDGET: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_DAPHNE: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_OLIVIA: [1, 2, 3, 4, 5, 6, 7],
  TRAINER_SIDNEY: [1, 2, 3, 4, 5, 6, 7, 8],
  TRAINER_PHOEBE: [1, 2, 3, 4, 5, 6, 7, 8],
  TRAINER_GLACIA: [1, 2, 3, 4, 5, 6, 7, 8],
  TRAINER_DRAKE: [1, 2, 3, 4, 5, 6, 7, 8],
}

const FORBIDDEN_EVIDENCE = ['can be skipped', 'PokemonLeague_1F:40']

function forbiddenStrings(row: FightRow): string[] {
  return FORBIDDEN_EVIDENCE.filter(
    (needle) => row.evidence.includes(needle) || row.mandatoryCitation.includes(needle),
  )
}

const PLAYER_OBSERVED = 'player-observed (Yoshi), not in the scripts at pin bdebcbbf'

describe('Cycle d5-1b boss fight progression table (fights.ts)', () => {
  const bossIds = loadBossTrainerIds()
  const bossRows = FIGHTS.filter((row) => !ROUTE_ONLY_ROW_IDS.has(row.fightId))

  it('covers every boss trainer id exactly once with no excess ids', () => {
    expect(bossIds.length).toBe(55)
    const result = checkTrainerIdCoverage(bossRows, bossIds)
    expect(result.valid).toBe(true)

    const countMap = new Map<string, number>()
    for (const row of bossRows) {
      for (const tid of row.trainerIds) {
        expect(bossIds).toContain(tid)
        countMap.set(tid, (countMap.get(tid) ?? 0) + 1)
      }
    }
    for (const id of bossIds) {
      expect(countMap.get(id)).toBe(1)
    }
  })

  it('has Wally at Mauville as the only row outside the boss id list', () => {
    const outside = FIGHTS.filter((row) =>
      row.trainerIds.some((tid) => !bossIds.includes(tid)),
    )
    expect(outside.map((row) => row.fightId)).toEqual(['TRAINER_WALLY_MAUVILLE'])
  })

  it('rejects a mutated table with one trainer id removed (negative case)', () => {
    // Drop the first trainer id from the first boss row.
    const mutated: FightRow[] = bossRows.map((row, idx) => {
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
    // 43 total rows: 42 boss rows + Wally at Mauville; 43 ids.
    expect(FIGHTS.length).toBe(43)

    const fightIds = new Set<string>()
    for (const row of FIGHTS) {
      expect(row.fightId).toBe(row.trainerIds[0])
      expect(fightIds.has(row.fightId)).toBe(false)
      fightIds.add(row.fightId)
    }
    expect(fightIds.size).toBe(43)
  })

  it('leaves mayBefore empty on every row', () => {
    for (const row of FIGHTS) {
      expect(row.mayBefore).toEqual([])
    }
  })

  it('gives each gym leader row requiredBefore 1..N-1', () => {
    const gymLeaderRows = FIGHTS.filter((f) => f.gymNumber !== undefined)
    expect(gymLeaderRows.length).toBe(8)
    const numbers = gymLeaderRows.map((f) => f.gymNumber).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    for (const row of gymLeaderRows) {
      const n = row.gymNumber as number
      expect(row.requiredBefore).toEqual(Array.from({ length: n - 1 }, (_, i) => i + 1))
    }
  })

  it('marks no row awaiting the route and flags the excluded and deferred rows exactly', () => {
    for (const row of FIGHTS) {
      expect(row.awaitingRoute).toBeUndefined()
    }

    expect(FIGHTS.filter((row) => row.excluded !== undefined).map((row) => row.fightId).sort()).toEqual(
      [...EXCLUDED_ROWS].sort(),
    )
    for (const row of FIGHTS) {
      if (EXCLUDED_ROWS.has(row.fightId)) {
        expect(row.excluded).toBe('buggy in pinned version (player-observed)')
      }
    }

    expect(FIGHTS.filter((row) => row.deferred === true).map((row) => row.fightId).sort()).toEqual(
      [...DEFERRED_ROWS].sort(),
    )
    for (const row of FIGHTS) {
      if (DEFERRED_ROWS.has(row.fightId)) {
        expect(row.deferred).toBe(true)
        expect(row.deferredReason).toBe(
          'v1 scope (Yoshi 2026-11-17): easy battle, add back later',
        )
      }
    }

    const running = FIGHTS.filter((row) => row.deferred !== true && row.excluded === undefined)
    expect(running.length).toBe(34)
  })

  it('has no skippable-gym claims in evidence or mandatoryCitation', () => {
    for (const row of FIGHTS) {
      expect(forbiddenStrings(row)).toEqual([])
    }
    // Negative case: the helper detects each forbidden string on a mutated copy.
    const row = FIGHTS[0]!
    expect(forbiddenStrings({ ...row, evidence: `${row.evidence} can be skipped` })).toEqual([
      'can be skipped',
    ])
    expect(
      forbiddenStrings({
        ...row,
        mandatoryCitation: `${row.mandatoryCitation} PokemonLeague_1F:40`,
      }),
    ).toEqual(['PokemonLeague_1F:40'])
  })

  it('matches the hand-written requiredBefore table row by row', () => {
    expect(Object.keys(EXPECTED_REQUIRED_BEFORE).length).toBe(43)
    for (const row of FIGHTS) {
      expect(row.requiredBefore).toEqual(EXPECTED_REQUIRED_BEFORE[row.fightId])
    }
  })

  it('keeps the script-based and route-only special rows right', () => {
    const norman = FIGHTS.find((f) => f.fightId === 'TRAINER_NORMAN_1')!
    expect(norman.holdsBracelet).toBe(true)
    expect(norman.evidence).not.toContain(PLAYER_OBSERVED)

    const wally = FIGHTS.find((f) => f.fightId === 'TRAINER_WALLY_MAUVILLE')!
    expect(wally.mandatory).toBe(true)
    expect(wally.requiredBefore).toEqual([1, 2])
    expect(wally.mandatoryCitation).toContain('MauvilleCity/scripts.pory:122-130, 241-251')

    for (const row of FIGHTS) {
      for (const tid of row.trainerIds) {
        expect(tid.startsWith('TRAINER_GRUNT_WEATHER_INST_')).toBe(false)
      }
    }
  })

  it('labels every position the scripts do not show', () => {
    const scriptPositionRows = new Set<string>([
      'TRAINER_NORMAN_1',
      'TRAINER_ROXANNE_1',
      'TRAINER_BRAWLY_1',
      'TRAINER_WATTSON_1',
      'TRAINER_FLANNERY_1',
    ])
    for (const row of FIGHTS) {
      if (scriptPositionRows.has(row.fightId)) continue
      expect(row.evidence).toContain(PLAYER_OBSERVED)
      expect(row.evidence).toContain('story-route.md step')
    }
  })

  it('verifies non-empty evidence and mandatoryCitation', () => {
    for (const row of FIGHTS) {
      expect(row.evidence.trim().length).toBeGreaterThan(0)
      expect(row.mandatoryCitation.trim().length).toBeGreaterThan(0)
      expect(row.inferred).not.toBe(true)
    }
  })

  it('verifies chainId invariants across multi-battle chains', () => {
    const chainRows = new Map<string, FightRow[]>()

    for (const row of FIGHTS) {
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

    expect(chainRows.has('oceanic-museum-2f')).toBe(true)
    expect(chainRows.get('oceanic-museum-2f')?.length).toBe(3)

    expect(chainRows.has('sootopolis-gym-juan-wallace')).toBe(true)
    expect(chainRows.get('sootopolis-gym-juan-wallace')?.[0].trainerIds.length).toBe(4)

    expect(chainRows.has('mossdeep-space-center-2f-grunts')).toBe(true)
    expect(chainRows.get('mossdeep-space-center-2f-grunts')?.[0].trainerIds.length).toBe(3)

    expect(chainRows.has('sootopolis-gym-bottom-group')).toBe(true)
    expect(chainRows.has('sootopolis-gym-middle-group')).toBe(true)
    expect(chainRows.has('sootopolis-gym-top-group')).toBe(true)
  })

  it('derives the ten StageKeys of the fixed route with hand checks', () => {
    const expectedIds = [
      'h0-n0-b0',
      'h1-n1-b0',
      'h2-n2-b0',
      'h3-n3-b0',
      'h4-n4-b0',
      'h4-n4-b1',
      'h5-n5-b1',
      'h6-n6-b1',
      'h7-n7-b1',
      'h8-n8-b1',
    ]
    const v1Rows = FIGHTS.filter((row) => row.deferred !== true && row.excluded === undefined)

    expect(distinctStageKeys(v1Rows).map(stageKeyId)).toEqual(expectedIds)
    expect(distinctStageKeys(FIGHTS).map(stageKeyId)).toEqual(expectedIds)

    const keyOf = (fightId: string) => stageKeyFor(FIGHTS.find((f) => f.fightId === fightId)!)

    expect(keyOf('TRAINER_MAY_ROUTE_103_TORCHIC')).toEqual({
      highestBadge: 0,
      badgeCount: 0,
      braceletHeld: false,
    })
    expect(keyOf('TRAINER_WINONA_1')).toEqual({
      highestBadge: 5,
      badgeCount: 5,
      braceletHeld: true,
    })
    expect(keyOf('TRAINER_BRAWLY_1')).toEqual({
      highestBadge: 1,
      badgeCount: 1,
      braceletHeld: false,
    })
    expect(keyOf('TRAINER_NORMAN_1')).toEqual({
      highestBadge: 4,
      badgeCount: 4,
      braceletHeld: true,
    })
    const norman = FIGHTS.find((f) => f.fightId === 'TRAINER_NORMAN_1')!
    expect(stageKeyFor({ ...norman, holdsBracelet: undefined })).toEqual({
      highestBadge: 4,
      badgeCount: 4,
      braceletHeld: false,
    })
    expect(keyOf('TRAINER_JUAN_1')).toEqual({
      highestBadge: 7,
      badgeCount: 7,
      braceletHeld: true,
    })
  })
})
