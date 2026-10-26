import { describe, it } from 'vitest'
import { loadSimData } from './loadSimData'
import { GENERIC_PLAYER_SPECS } from './genericTeam'
import { createLocalEvaluator, defaultSet, improveTeam } from './solver'

describe.skipIf(process.env.SIM_SOLVE !== '1')('solver on one fight', () => {
  it('improves a team', { timeout: 3_000_000 }, async () => {
    const data = loadSimData()
    const trainer = data.trainersById.get(process.env.SOLVE_TRAINER ?? 'TRAINER_SAWYER_1')!
    const team = GENERIC_PLAYER_SPECS.map((s) => defaultSet(data, s.species, 50, new Set()))
    const evaluate = createLocalEvaluator(data, trainer)
    const t0 = performance.now()
    const result = await improveTeam(data, team, evaluate, {
      screenGames: 2, confirmGames: 6, finalists: 2, passes: 1, epsilon: 0.01, maxNeighbours: 30, allowedStones: new Set<string>(),
      onProgress: (m) => console.log('SOLVE', m, Math.round((performance.now() - t0) / 1000) + 's'),
    })
    console.log('SOLVE final', JSON.stringify(result.fitness))
  })
})
