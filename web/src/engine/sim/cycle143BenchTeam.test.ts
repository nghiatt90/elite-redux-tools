// Cycle 143: the status-move bench team (`STATUS_PLAYER_SPECS`) and the
// `statusTerms` default. No behaviour is derived here: the test checks that the
// bench team's ids resolve through `buildPlayerParty`, that each mon carries at
// least two status moves, that `GENERIC_PLAYER_SPECS` is untouched, and (before
// the bench gate can flip it) that the status term stays off by default.
import { describe, expect, it } from 'vitest'

import { DEFAULT_EXPECTIMAX } from './driver/expectimax'
import { buildPlayerParty } from './driver/buildParty'
import { GENERIC_PLAYER_SPECS, STATUS_PLAYER_SPECS } from './driver/genericTeam'
import { loadSimData } from './driver/loadSimData'

const data = loadSimData()

/** The status moves the cycle-143 brief allows in `STATUS_PLAYER_SPECS`. */
const STATUS_MOVES = new Set([
  'MOVE_WILL_O_WISP',
  'MOVE_TOXIC',
  'MOVE_THUNDER_WAVE',
  'MOVE_SLEEP_POWDER',
  'MOVE_SPORE',
  'MOVE_HYPNOSIS',
  'MOVE_CONFUSE_RAY',
  'MOVE_LEECH_SEED',
  'MOVE_SUBSTITUTE',
  'MOVE_SPIKES',
  'MOVE_STEALTH_ROCK',
  'MOVE_TOXIC_SPIKES',
  'MOVE_REFLECT',
  'MOVE_LIGHT_SCREEN',
  'MOVE_TAILWIND',
  'MOVE_TRICK_ROOM',
  'MOVE_SUNNY_DAY',
  'MOVE_RAIN_DANCE',
  'MOVE_SANDSTORM',
  'MOVE_RECOVER',
  'MOVE_SOFT_BOILED',
  'MOVE_ROOST',
  'MOVE_SWORDS_DANCE',
])

describe('cycle 143 - status-move bench team', () => {
  it('builds six mons and every spec move resolves', () => {
    const party = buildPlayerParty(STATUS_PLAYER_SPECS, 50, data)
    expect(party).toHaveLength(6)
    expect(party).toHaveLength(STATUS_PLAYER_SPECS.length)
    party.forEach((mon, i) => {
      const spec = STATUS_PLAYER_SPECS[i]!
      expect(mon.speciesId).toBe(spec.species)
      expect(mon.level).toBe(50)
      expect(mon.moves).toEqual(spec.moves)
      // `buildPlayerParty` stores null for a missing slot and copies the move's
      // PP; a non-null slot with 0 PP would mean the id did not resolve.
      mon.moves.forEach((moveId, slot) => {
        if (moveId === null) return
        expect(data.dataContext.move(moveId)).toBeDefined()
        expect(mon.pp[slot]).toBeGreaterThan(0)
      })
    })
  })

  it('every mon has at least two status moves (no mon is four attacks)', () => {
    for (const spec of STATUS_PLAYER_SPECS) {
      const statusCount = spec.moves.filter((moveId) => moveId !== null && STATUS_MOVES.has(moveId)).length
      expect(statusCount).toBeGreaterThanOrEqual(2)
      expect(spec.moves.length - statusCount).toBeLessThanOrEqual(2)
    }
  })

  it('leaves GENERIC_PLAYER_SPECS unchanged', () => {
    expect(GENERIC_PLAYER_SPECS).toHaveLength(6)
    expect(GENERIC_PLAYER_SPECS[1]!.species).toBe('SPECIES_GARCHOMP')
    expect(GENERIC_PLAYER_SPECS[1]!.moves).toContain('MOVE_SWORDS_DANCE')
  })

  it('anti-regression: the status term is off by default', () => {
    expect(DEFAULT_EXPECTIMAX.statusTerms).toBeFalsy()
  })
})
