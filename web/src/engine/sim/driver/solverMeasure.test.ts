/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, it } from 'vitest'
import { GENERIC_PLAYER_SPECS } from './genericTeam'
import { loadSimData } from './loadSimData'
import { defaultSet, scoreTeam } from './solver'
import { wilsonInterval } from './wilson'

const Z = 2.807
const BATCH = 40
const MAX_LOOKS = 10
const FIGHTS = ['TRAINER_ROXANNE_1', 'TRAINER_WATTSON_1', 'TRAINER_NORMAN_1']

describe.skipIf(process.env.SIM_MEASURE !== '1')('solver measurement', () => {
  it('Step 0.1: 40 games on TRAINER_ROXANNE_1 elite', { timeout: 3_000_000 }, () => {
    const data = loadSimData()
    const trainer = data.trainersById.get('TRAINER_ROXANNE_1')!
    const team = GENERIC_PLAYER_SPECS.map((s) => defaultSet(data, s.species, 50, new Set()))
    const t0 = performance.now()
    const fitness = scoreTeam(data, trainer, 'elite', team, BATCH)
    const ms = performance.now() - t0
    console.log(
      `MEASURE 0.1 trainer=TRAINER_ROXANNE_1 tier=elite games=${BATCH} wins=${Math.round(fitness.winRate * BATCH)} ms=${Math.round(ms)} msPerGame=${(ms / BATCH).toFixed(1)}`,
    )
  })

  for (const trainerId of FIGHTS) {
    it(`Step 0.2: ${trainerId}`, { timeout: 3_000_000 }, () => {
      const data = loadSimData()
      const trainer = data.trainersById.get(trainerId)!
      const team = GENERIC_PLAYER_SPECS.map((s) => defaultSet(data, s.species, 50, new Set()))
      let wins = 0
      let verdict = 'no verdict at 400'
      for (let k = 0; k < MAX_LOOKS; k++) {
        const fitness = scoreTeam(data, trainer, 'elite', team, BATCH, undefined, BATCH * k)
        wins += Math.round(fitness.winRate * BATCH)
        const n = BATCH * (k + 1)
        const { lower, upper } = wilsonInterval(wins, n, Z)
        console.log(
          `MEASURE 0.2 ${trainerId} look=${k + 1} wins=${wins}/${n} p=${(wins / n).toFixed(3)} lower=${lower.toFixed(3)} upper=${upper.toFixed(3)}`,
        )
        if (lower >= 0.9) {
          verdict = `won at look ${k + 1}`
          break
        }
        if (upper < 0.5) {
          verdict = `lost at look ${k + 1}`
          break
        }
      }
      console.log(`MEASURE 0.2 ${trainerId} verdict=${verdict}`)
    })
  }
})
