/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import { BATTLE_TYPE_TRAINER, hasFlag } from './constants'
import { createBattleState } from './create'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData } from './driver/loadSimData'
import { createSession } from './driver/session'
import { createRandomSource } from './rng'

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

describe('cycle 153c environment units', () => {
  it('BATTLE_TYPE_TRAINER: createSession populates BATTLE_TYPE_TRAINER; createBattleState without it does not', () => {
    const session = createSession({
      data,
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentTrainer: data.trainersById.get('TRAINER_SAWYER_1')!,
      rng: createRandomSource(1),
    })

    expect(hasFlag(session.state.battleTypeFlags, BATTLE_TYPE_TRAINER)).toBe(true)

    const rawState = createBattleState({
      battlers: [],
      rng: createRandomSource(1),
    })
    expect(hasFlag(rawState.battleTypeFlags, BATTLE_TYPE_TRAINER)).toBe(false)
  })
})
