import { describe, it } from 'vitest'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { GENERIC_PLAYER_SPECS } from './genericTeam'
import { createRandomSource } from '../rng'
import { runBattle } from './runBattle'
import { DEFAULT_EXPECTIMAX, playExpectimaxBattle } from './expectimax'

describe.skipIf(process.env.SIM_BENCH !== '1')('expectimax vs default policy', () => {
  it('compares win counts and time', { timeout: 900_000 }, () => {
    const data = loadSimData()
    const party = buildPlayerParty(GENERIC_PLAYER_SPECS, 50, data)
    const ids = [...data.trainersById.keys()].filter((id) => id.startsWith('TRAINER_')).slice(0, 12)
    let defWins = 0
    let exWins = 0
    let games = 0
    const t0 = performance.now()
    let exMs = 0
    for (const id of ids) {
      const trainer = data.trainersById.get(id)!
      for (const seed of [1, 2]) {
        games++
        const d = runBattle({ data, playerParty: party, opponentTrainer: trainer, tier: 'elite', rng: createRandomSource(seed), maxTurns: 60 })
        if (d.outcome === 'WON') defWins++
        const t = performance.now()
        const e = playExpectimaxBattle({ data, playerParty: party, opponentTrainer: trainer, tier: 'elite', seed, expectimax: { ...DEFAULT_EXPECTIMAX, depth: Number(process.env.EX_DEPTH ?? 2), samples: Number(process.env.EX_SAMPLES ?? 6), innerSamples: Number(process.env.EX_INNER ?? 2) } })
        exMs += performance.now() - t
        if (e.outcome === 'WON') exWins++
      }
    }
    console.log('RESULT games', games, 'default wins', defWins, 'expectimax wins', exWins, 'expectimax ms/game', Math.round(exMs / games), 'total s', Math.round((performance.now() - t0) / 1000))
  })
})
