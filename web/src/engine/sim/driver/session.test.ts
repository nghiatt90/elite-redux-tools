import { describe, expect, it } from 'vitest'
import { createRandomSource } from '../rng'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { defaultPlayerPolicy } from './runBattle'
import { cloneSession, createSession, stepTurn } from './session'

const data = loadSimData()

const SPECS = [
  {
    species: 'SPECIES_TYRANITAR',
    level: 50,
    nature: 'NATURE_ADAMANT',
    evs: { hp: 252, atk: 252, spdef: 4 },
    ability: 'ABILITY_SAND_STREAM',
    item: 'ITEM_SMOOTH_ROCK',
    moves: ['MOVE_STONE_EDGE', 'MOVE_CRUNCH', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH'],
  },
]

function freshSession(seed: number) {
  return createSession({
    data,
    playerParty: buildPlayerParty(SPECS, 50, data),
    opponentTrainer: data.trainersById.get('TRAINER_SAWYER_1')!,
    rng: createRandomSource(seed),
  })
}

const snapshot = (s: { state: object }) => JSON.stringify(s.state, (k, v) => (k === 'rng' ? undefined : v))

describe('battle session cloning', () => {
  it('a clone steps independently and does not disturb the original', () => {
    const session = freshSession(7)
    const before = snapshot(session)

    const clone = cloneSession(session, 99)
    expect(snapshot(clone)).toBe(before)
    stepTurn(clone, defaultPlayerPolicy(clone.state, data))
    stepTurn(clone, defaultPlayerPolicy(clone.state, data))

    expect(snapshot(session)).toBe(before)
    expect(snapshot(clone)).not.toBe(before)
  })

  it('two clones with the same seed play identically', () => {
    const session = freshSession(7)
    const a = cloneSession(session, 5)
    const b = cloneSession(session, 5)
    for (let i = 0; i < 4 && !a.state.battleOutcome; i++) {
      stepTurn(a, defaultPlayerPolicy(a.state, data))
      stepTurn(b, defaultPlayerPolicy(b.state, data))
    }
    expect(snapshot(a)).toBe(snapshot(b))
  })
})
