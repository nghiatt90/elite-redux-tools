/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle d5-2b: levelCapForTrainer returns the tagged { awaiting, row } result for
// awaiting / excluded / deferred rows instead of a level cap.
//
// Expected values are hand-derived from the rows in ./driver/fights.ts and the cap
// table in GetLevelCap (pipeline/.upstream/eliteredux-source/src/pokemon.c:4661:
// levelCapsStrict = {16, 23, 36, 45, 50, 55, 60, 70, 80, 100}), never from running
// the function.
import { describe, expect, it } from 'vitest'

import { FIGHTS, levelCapForTrainer, type FightRow } from './driver/fights'

const rowByFightId = (fightId: string): FightRow => {
  const row = FIGHTS.find((fight) => fight.fightId === fightId)
  if (!row) {
    throw new Error(`no FIGHTS row with fightId ${fightId}`)
  }
  return row
}

/** Narrows a lookup result to the tagged outcome, failing on a cap or absence. */
function tagged(trainerId: string): { awaiting: string; row: FightRow } {
  const found = levelCapForTrainer(trainerId)
  if (!found) {
    throw new Error(`expected a row for ${trainerId}, got undefined`)
  }
  if (!('awaiting' in found)) {
    throw new Error(`expected a tagged result for ${trainerId}, got cap ${found.cap}`)
  }
  return found
}

describe('cycle d5-2b - levelCapForTrainer tagged outcomes', () => {
  it('returns the exclusion reason for the excluded Wally Victory Road rows', () => {
    // fights.ts: both rows carry requiredBefore [1..8]; a wrong (cap) result would
    // be levelCapsStrict[8] = 80, so the absence of a cap is a real assertion.
    for (const fightId of ['TRAINER_WALLY_VR_1', 'TRAINER_WALLY_VR_2']) {
      const row = rowByFightId(fightId)
      expect(row.excluded).toBe('buggy in pinned version (player-observed)')

      const result = levelCapForTrainer(fightId)
      expect(result).toBeDefined()
      expect(result).toEqual({ awaiting: 'buggy in pinned version (player-observed)', row })
      expect('cap' in result!).toBe(false)
    }
  })

  it('returns "deferred (v1 scope)" for a non-first member of a deferred row', () => {
    // TRAINER_CRISSY is the second id of the Bridget row; the deferred literal is
    // fixed, not row.deferredReason.
    const row = rowByFightId('TRAINER_BRIDGET')
    expect(row.deferred).toBe(true)
    expect(row.trainerIds).toEqual(['TRAINER_BRIDGET', 'TRAINER_CRISSY', 'TRAINER_BETHANY'])

    const result = tagged('TRAINER_CRISSY')
    expect(result).toEqual({ awaiting: 'deferred (v1 scope)', row })
    expect(result.row.fightId).toBe('TRAINER_BRIDGET')
    expect(result.awaiting).not.toBe(row.deferredReason)
  })

  it('returns "deferred (v1 scope)" for the first row of FIGHTS', () => {
    // TRAINER_MAY_ROUTE_103_TORCHIC is FIGHTS[0] and is deferred.
    const row = FIGHTS[0]!
    expect(row.fightId).toBe('TRAINER_MAY_ROUTE_103_TORCHIC')
    expect(row.deferred).toBe(true)

    const result = tagged('TRAINER_MAY_ROUTE_103_TORCHIC')
    expect(result).toEqual({ awaiting: 'deferred (v1 scope)', row })
  })

  it('leaves a placed row on the cap path and an unknown id undefined', () => {
    // TRAINER_GRUNT_PETALBURG_WOODS: requiredBefore [] -> badge 0 -> 16.
    const found = levelCapForTrainer('TRAINER_GRUNT_PETALBURG_WOODS')
    expect(found).toBeDefined()
    expect('awaiting' in found!).toBe(false)
    expect(found).toEqual({
      cap: 16,
      row: rowByFightId('TRAINER_GRUNT_PETALBURG_WOODS'),
      evidence: rowByFightId('TRAINER_GRUNT_PETALBURG_WOODS').evidence,
    })

    expect(levelCapForTrainer('TRAINER_NOT_A_FIGHT')).toBeUndefined()
  })

  it('keeps a placed row matched by a non-first trainer id unchanged', () => {
    // TRAINER_WALLACE also appears in Juan's row, requiredBefore [1..7]
    // -> levelCapsStrict[7] = 70.
    const found = levelCapForTrainer('TRAINER_WALLACE')
    expect(found).toBeDefined()
    expect('awaiting' in found!).toBe(false)
    if (!found || 'awaiting' in found) throw new Error('expected a placed row')
    expect(found.cap).toBe(70)
    expect(found.row.fightId).toBe('TRAINER_JUAN_1')
  })

  it('tags exactly the excluded and deferred rows, and no others', () => {
    // Counts are derived from FIGHTS itself (cycled5-1bFights.test.ts pins them).
    let taggedIds = 0
    let capIds = 0
    for (const row of FIGHTS) {
      const shouldBeTagged =
        row.excluded !== undefined || row.deferred === true || row.awaitingRoute === true
      for (const trainerId of row.trainerIds) {
        const result = levelCapForTrainer(trainerId)
        expect(result, trainerId).toBeDefined()
        if (!result) continue
        expect('awaiting' in result, trainerId).toBe(shouldBeTagged)
        if ('awaiting' in result) {
          expect(result.row, trainerId).toBe(row)
          taggedIds += 1
        } else {
          expect(typeof result.cap, trainerId).toBe('number')
          expect(result.row, trainerId).toBe(row)
          capIds += 1
        }
      }
    }

    const excludedIds = FIGHTS.filter((row) => row.excluded !== undefined).reduce(
      (sum, row) => sum + row.trainerIds.length,
      0,
    )
    const deferredIds = FIGHTS.filter((row) => row.deferred === true).reduce(
      (sum, row) => sum + row.trainerIds.length,
      0,
    )
    // No row sets awaitingRoute (verified by grep); should one gain it, this
    // equality fails and the count must be extended deliberately.
    expect(taggedIds).toBe(excludedIds + deferredIds)
    expect(capIds).toBe(
      FIGHTS.reduce((sum, row) => sum + row.trainerIds.length, 0) - excludedIds - deferredIds,
    )
  })
})
