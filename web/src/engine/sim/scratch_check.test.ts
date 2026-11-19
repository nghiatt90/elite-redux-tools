import { describe, it } from 'vitest'
import { createRandomSource } from './rng'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { runBattle } from './driver/runBattle'

describe('check unmodified singles', () => {
  it('runs', () => {
    const data = loadSimData()
    const trainer = data.trainersById.get('TRAINER_MAY_ROUTE_103_TORCHIC')!
    const playerParty = buildPlayerParty(
      [
        {
          species: 'SPECIES_SWAMPERT',
          level: 50,
          nature: 'NATURE_ADAMANT',
          evs: { hp: 252, atk: 252, spe: 4 },
          moves: ['MOVE_WATERFALL', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH', 'MOVE_ROCK_SLIDE'],
        },
        {
          species: 'SPECIES_GARCHOMP',
          level: 50,
          nature: 'NATURE_JOLLY',
          evs: { atk: 252, spe: 252, hp: 4 },
          moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
        },
      ],
      50,
      data,
    )
    const rng = createRandomSource(42)
    const result = runBattle({
      data,
      playerParty,
      opponentTrainer: trainer,
      tier: 'elite',
      rng,
      maxTurns: 60,
    })
    console.log('UNMODIFIED SINGLES RESULT:', {
      outcome: result.outcome,
      turns: result.turns,
      error: result.error,
    })
  })
})
