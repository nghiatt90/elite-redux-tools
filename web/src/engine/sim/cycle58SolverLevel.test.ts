/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import { loadSimData, type SimDataBundle } from './driver/loadSimData'
import { FIGHTS } from './driver/fights'
import { levelCapFor } from './innateGate'
import {
  evidenceLabel,
  evolutionWarnings,
  evolveLevel,
  resolveSolverLevel,
  unrunRows,
} from './driver/solverLevel'
import { defaultSet, scoreTeam } from './driver/solver'

describe('cycle 58 - solver and CLI level cap', () => {
  it('levelCapFor returns correct caps 0..9 (hand-derived from GetLevelCap)', () => {
    expect(levelCapFor(0)).toBe(16)
    expect(levelCapFor(1)).toBe(23)
    expect(levelCapFor(2)).toBe(36)
    expect(levelCapFor(3)).toBe(45)
    expect(levelCapFor(4)).toBe(50)
    expect(levelCapFor(5)).toBe(55)
    expect(levelCapFor(6)).toBe(60)
    expect(levelCapFor(7)).toBe(70)
    expect(levelCapFor(8)).toBe(80)
    expect(levelCapFor(9)).toBe(100)
  })

  it('resolves placed fight rows with correct badge, cap, and evidence label', () => {
    // Norman: requiredBefore [1..4] -> badge 4 -> cap 50
    const normanRow = FIGHTS.find((f) => f.fightId === 'TRAINER_NORMAN_1')
    expect(normanRow).toBeDefined()
    expect(normanRow!.requiredBefore).toEqual([1, 2, 3, 4])
    expect(normanRow!.evidence.includes('player-observed (Yoshi), not in the scripts at pin bdebcbbf')).toBe(false)
    expect(evidenceLabel(normanRow!.evidence)).toBe('script')

    const normanRes = resolveSolverLevel('TRAINER_NORMAN_1', undefined, false)
    expect(normanRes).toEqual({
      kind: 'capped',
      level: 50,
      cap: 50,
      badges: 4,
      label: 'script',
      ignoreCapUsed: false,
    })

    // Roxanne (Gym 1 leader): requiredBefore [] -> badge 0 -> cap 16
    const roxanneRow = FIGHTS.find((f) => f.fightId === 'TRAINER_ROXANNE_1')
    expect(roxanneRow).toBeDefined()
    expect(roxanneRow!.requiredBefore).toEqual([])
    expect(roxanneRow!.evidence.includes('player-observed (Yoshi), not in the scripts at pin bdebcbbf')).toBe(true)
    expect(evidenceLabel(roxanneRow!.evidence)).toBe('player-observed (Yoshi), not in the scripts at pin bdebcbbf')

    const roxanneRes = resolveSolverLevel('TRAINER_ROXANNE_1', undefined, false)
    expect(roxanneRes).toEqual({
      kind: 'capped',
      level: 16,
      cap: 16,
      badges: 0,
      label: 'player-observed (Yoshi), not in the scripts at pin bdebcbbf',
      ignoreCapUsed: false,
    })
  })

  it('handles levelArg on a placed row: lower, equal, over with and without ignoreCap', () => {
    // Norman row cap is 50
    const lower = resolveSolverLevel('TRAINER_NORMAN_1', 40, false)
    expect(lower).toEqual({
      kind: 'capped',
      level: 40,
      cap: 50,
      badges: 4,
      label: 'script',
      ignoreCapUsed: false,
    })

    const equal = resolveSolverLevel('TRAINER_NORMAN_1', 50, false)
    expect(equal).toEqual({
      kind: 'capped',
      level: 50,
      cap: 50,
      badges: 4,
      label: 'script',
      ignoreCapUsed: false,
    })

    expect(() => resolveSolverLevel('TRAINER_NORMAN_1', 60, false)).toThrow('--ignore-cap')

    const overIgnored = resolveSolverLevel('TRAINER_NORMAN_1', 60, true)
    expect(overIgnored).toEqual({
      kind: 'capped',
      level: 60,
      cap: 50,
      badges: 4,
      label: 'script',
      ignoreCapUsed: true,
    })
  })

  it('refuses excluded and deferred rows with exact message, and treats unknown as noRow', () => {
    const wallyRow = FIGHTS.find((f) => f.fightId === 'TRAINER_WALLY_VR_1')
    expect(wallyRow).toBeDefined()
    expect(wallyRow!.excluded).toBeDefined()

    const excludedRes = resolveSolverLevel('TRAINER_WALLY_VR_1', undefined, false)
    expect(excludedRes).toEqual({
      kind: 'refused',
      message: `refused: TRAINER_WALLY_VR_1 is in fights.ts row TRAINER_WALLY_VR_1 (${wallyRow!.excluded}); no level cap is trusted for it`,
    })

    const deferredRes = resolveSolverLevel('TRAINER_CRISSY', undefined, false)
    expect(deferredRes).toEqual({
      kind: 'refused',
      message: 'refused: TRAINER_CRISSY is in fights.ts row TRAINER_BRIDGET (deferred (v1 scope)); no level cap is trusted for it',
    })

    expect(resolveSolverLevel('TRAINER_NOT_A_REAL_TRAINER', undefined, false)).toEqual({
      kind: 'noRow',
      level: 50,
    })
    expect(resolveSolverLevel('TRAINER_NOT_A_REAL_TRAINER', 30, false)).toEqual({
      kind: 'noRow',
      level: 30,
    })
  })

  it('unrunRows lists excluded rows and deferred rows by trainer id', () => {
    const excludedRows = FIGHTS.filter((r) => r.excluded !== undefined)
    expect(excludedRows.length).toBe(2)
    const deferredRows = FIGHTS.filter((r) => r.deferred === true)
    expect(deferredRows.length).toBe(7)

    const lines = unrunRows()
    for (const row of excludedRows) {
      for (const trainerId of row.trainerIds) {
        expect(lines).toContain(`${trainerId}: ${row.excluded}`)
      }
    }
    for (const row of deferredRows) {
      for (const trainerId of row.trainerIds) {
        expect(lines).toContain(`${trainerId}: deferred (v1 scope)`)
      }
    }
    const expectedCount =
      excludedRows.reduce((sum, r) => sum + r.trainerIds.length, 0) +
      deferredRows.reduce((sum, r) => sum + r.trainerIds.length, 0)
    expect(lines.length).toBe(expectedCount)
  })

  it('computes evolveLevel and evolutionWarnings on hand-built and real species data', () => {
    const speciesA = { id: 'SPECIES_A', evolutions: [{ level: 16, to: 'SPECIES_B' }] }
    const speciesB = { id: 'SPECIES_B', evolutions: [{ level: 36, to: 'SPECIES_C' }] }
    const speciesC = { id: 'SPECIES_C', evolutions: [] }
    const speciesD = { id: 'SPECIES_D', evolutions: [] }

    const stubData = {
      speciesById: new Map([
        ['SPECIES_A', speciesA],
        ['SPECIES_B', speciesB],
        ['SPECIES_C', speciesC],
        ['SPECIES_D', speciesD],
      ]),
    } as unknown as SimDataBundle

    expect(evolveLevel(stubData, 'SPECIES_C')).toBe(36)
    expect(evolveLevel(stubData, 'SPECIES_B')).toBe(16)
    expect(evolveLevel(stubData, 'SPECIES_A')).toBe(0)
    expect(evolveLevel(stubData, 'SPECIES_D')).toBe(0)

    expect(evolutionWarnings(stubData, ['SPECIES_A', 'SPECIES_B', 'SPECIES_C'], 16)).toEqual([
      'SPECIES_C needs level 36, cap is 16',
    ])
    expect(evolutionWarnings(stubData, ['SPECIES_A', 'SPECIES_B', 'SPECIES_C'], 36)).toEqual([])
    expect(evolutionWarnings(stubData, ['SPECIES_D'], 16)).toEqual([])

    const data = loadSimData()
    expect(evolveLevel(data, 'SPECIES_VENUSAUR')).toBe(36)
    expect(evolveLevel(data, 'SPECIES_IVYSAUR')).toBe(16)
    expect(evolveLevel(data, 'SPECIES_BULBASAUR')).toBe(0)
  })

  it('wires levelCap option into scoreTeam and throws on over-cap spec unless ignored', () => {
    const data = loadSimData()
    const trainer = data.trainersById.get('TRAINER_SAWYER_1')
    expect(trainer).toBeDefined()

    const team = [defaultSet(data, 'SPECIES_BULBASAUR', 17, new Set())]

    // With levelCap: 16 and level 17, scoreTeam throws
    expect(() =>
      scoreTeam(data, trainer!, 'elite', team, 1, undefined, 0, undefined, { levelCap: 16 }),
    ).toThrow(/exceeds the level cap 16/)

    // With ignoreCap: true, scoreTeam does not throw
    expect(() =>
      scoreTeam(data, trainer!, 'elite', team, 1, undefined, 0, undefined, {
        levelCap: 16,
        ignoreCap: true,
      }),
    ).not.toThrow()

    // Without options (today's behavior), scoreTeam does not throw
    expect(() => scoreTeam(data, trainer!, 'elite', team, 1)).not.toThrow()
  })
})
