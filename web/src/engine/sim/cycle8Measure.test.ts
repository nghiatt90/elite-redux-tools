/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import { FIGHTS, levelCapForTrainer } from './driver/fights'
import { supportedSingleUnits } from './driver/measureUnits'

describe('supportedSingleUnits', () => {
  const rows = supportedSingleUnits()
  const ids = rows.map((row) => row.fightId)

  it('includes a single gym leader', () => {
    expect(ids).toContain('TRAINER_ROXANNE_1')
  })

  it('skips doubles, tags, multi battles and every chained row', () => {
    expect(ids).not.toContain('TRAINER_TATE_AND_LIZA_1')
    expect(ids).not.toContain('TRAINER_JUAN_1')
    expect(ids).not.toContain('TRAINER_MAXIE_MOSSDEEP')
    expect(ids.filter((id) => id.startsWith('TRAINER_GRUNT_MUSEUM_'))).toEqual([])
    for (const row of rows) {
      expect(row.format).toBe('single')
      expect(row.chainId).toBeUndefined()
    }
  })

  it('skips deferred, excluded and awaitingRoute rows', () => {
    expect(ids).not.toContain('TRAINER_MAY_ROUTE_103_TORCHIC')
    for (const row of rows) {
      expect(row.deferred).not.toBe(true)
      expect(row.excluded).toBeUndefined()
      expect(row.awaitingRoute).toBeUndefined()
    }
    expect(FIGHTS.some((row) => row.format === 'single' && row.deferred === true)).toBe(true)
  })

  it('every returned row has a settled level cap', () => {
    for (const row of rows) {
      const resolved = levelCapForTrainer(row.fightId)
      expect(resolved).toBeDefined()
      expect(resolved && 'cap' in resolved).toBe(true)
    }
  })

  it('matches the same filter computed independently over FIGHTS', () => {
    const expected = FIGHTS.filter(
      (row) =>
        row.format === 'single' &&
        row.chainId === undefined &&
        row.excluded === undefined &&
        row.deferred !== true &&
        row.awaitingRoute !== true,
    )
    expect(rows.length).toBe(expected.length)
    expect(ids).toEqual(expected.map((row) => row.fightId))
  })
})
