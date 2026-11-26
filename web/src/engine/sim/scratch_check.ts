import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadSimData } from './driver/loadSimData'
import {
  buildFightSetup,
  gameSeed,
  playComparisonGame,
  type PolicyComparisonFixture,
} from './driver/policyComparison'

const data = loadSimData()
const FIXTURE_PATH = resolve('docs/battle-sim/role-policy-test-fights.json')
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PolicyComparisonFixture
const fight = fixture.fights.find((entry) => entry.trainer === 'TRAINER_DRAKE')!
const setup = buildFightSetup(data, fight)

for (let game = 1; game <= 3; game++) {
  const seed = gameSeed(0, game)
  const record = playComparisonGame(setup, 'role', seed, { collectLog: true })
  const lines = (record.log ?? '').split('\n')
  console.log(`\n--- TRAINER_DRAKE Game ${game} Turn 1 Log ---`)
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    console.log(lines[i])
    if (lines[i].includes('Turn 2')) break
  }
}
