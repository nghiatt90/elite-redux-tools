import { describe, it } from 'vitest'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { createRandomSource } from './rng'
import { chooseExpectimaxJointAction } from './driver/expectimax'

const data = loadSimData()
const tateAndLiza = data.trainersById.get('TRAINER_TATE_AND_LIZA_1')!

describe('diag', () => {
  it('harden vs waterfall with jolly swampert and metagross harden', () => {
    const partyKO = buildPlayerParty(
      [
        { species: 'SPECIES_SWAMPERT', level: 50, nature: 'NATURE_JOLLY', evs: { spe: 252 }, moves: ['MOVE_HARDEN', 'MOVE_WATERFALL'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_HARDEN'] },
      ],
      50,
      data,
    )
    const session = createSession({
      data,
      playerParty: partyKO,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })

    if (session.state.battlers[1]) session.state.battlers[1].mon.hp = 1
    // Keep battler 3 at full HP so only battler 1 is a forced KO for Waterfall

    const joint = chooseExpectimaxJointAction(
      session,
      { depth: 1, samples: 1, innerSamples: 1, switchMargin: 0.05, statusTerms: false },
      42,
      4,
    )
    console.log('Joint with Harden/Waterfall:', joint[0]?.action.chosenMove?.id, joint[2]?.action.chosenMove?.id)

    // Negative case
    const partyNoKO = buildPlayerParty(
      [
        { species: 'SPECIES_SWAMPERT', level: 50, nature: 'NATURE_JOLLY', evs: { spe: 252 }, moves: ['MOVE_HARDEN'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_HARDEN'] },
      ],
      50,
      data,
    )
    const sessionNoKO = createSession({
      data,
      playerParty: partyNoKO,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })
    if (sessionNoKO.state.battlers[1]) sessionNoKO.state.battlers[1].mon.hp = 1

    const jointNoKO = chooseExpectimaxJointAction(
      sessionNoKO,
      { depth: 1, samples: 1, innerSamples: 1, switchMargin: 0.05, statusTerms: false },
      42,
      4,
    )
    console.log('Joint negative:', jointNoKO[0]?.action.chosenMove?.id, jointNoKO[2]?.action.chosenMove?.id)
  })
})
