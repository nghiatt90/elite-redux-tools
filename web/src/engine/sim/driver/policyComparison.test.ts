/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'vitest'

import { loadSimData } from './loadSimData'
import {
  battleLogFileName,
  buildFightSetup,
  classifyWinRates,
  fightKey,
  renderGateReport,
  runFightGames,
  summarizePolicy,
  type FightMeasurement,
  type PolicyComparisonFixture,
} from './policyComparison'

const GAMES = Number(process.env.SIM_POLICY_GAMES ?? 80)
const MAX_TURNS = 200
const SEED_OFFSET = Number(process.env.SIM_POLICY_SEED_OFFSET ?? 0)
const FIXTURE_PATH = resolve(
  import.meta.dirname,
  '../../../../../docs/battle-sim/role-policy-test-fights.json',
)
const REPORT_PATH = resolve(
  import.meta.dirname,
  '../../../../../docs/battle-sim/role-policy-gate-report.md',
)
const OUT_DIR =
  process.env.SIM_POLICY_OUT ??
  resolve(import.meta.dirname, '../../../../../docs/battle-sim/role-policy-logs')
const OUT_LABEL = process.env.SIM_POLICY_OUT ?? 'docs/battle-sim/role-policy-logs'

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PolicyComparisonFixture

function writeAtomic(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, contents)
  renameSync(temp, path)
}

/** Rebuilds the report from every per-fight JSON in OUT_DIR, in fixture order.
 * A fight only counts once both policies have finished all GAMES games, so
 * parallel per-fight processes can each call this as they finish. */
function writeReport(): void {
  const fights: FightMeasurement[] = []
  for (const fight of fixture.fights) {
    const path = resolve(OUT_DIR, `${fightKey(fight)}.json`)
    if (!existsSync(path)) continue
    const measurement = JSON.parse(readFileSync(path, 'utf8')) as FightMeasurement
    if (measurement.role.games !== GAMES || measurement.expectimax.games !== GAMES) continue
    fights.push(measurement)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeAtomic(
    REPORT_PATH,
    renderGateReport({
      games: GAMES,
      maxTurns: MAX_TURNS,
      seedOffset: SEED_OFFSET,
      logDir: OUT_LABEL,
      fights,
    }),
  )
  writeAtomic(
    resolve(OUT_DIR, 'report.json'),
    JSON.stringify(
      {
        source: fixture.source,
        games: GAMES,
        maxTurns: MAX_TURNS,
        seedOffset: SEED_OFFSET,
        z: 1.96,
        fights,
      },
      null,
      2,
    ),
  )
}

describe.skipIf(process.env.SIM_POLICY !== '1')('policy comparison gate', () => {
  for (const fight of fixture.fights) {
    it(fightKey(fight), { timeout: 36_000_000 }, () => {
      const data = loadSimData()
      const setup = buildFightSetup(data, fight)
      const key = fightKey(fight)
      mkdirSync(OUT_DIR, { recursive: true })

      const logChunks: string[] = []
      const records = runFightGames(setup, {
        games: GAMES,
        seedOffset: SEED_OFFSET,
        maxTurns: MAX_TURNS,
        onGame: (policy, game, record) => {
          if (policy === 'role' && game <= 2 && record.log) {
            logChunks.push(
              `== ${key} ${policy} game ${game} seed ${record.seed} ==\n${record.log}`,
            )
          }
          console.log(
            `POLICY ${key} ${policy} game=${game} seed=${record.seed} outcome=${record.outcome} turns=${record.turns} capped=${record.capped} ms=${Math.round(record.ms)}`,
          )
        },
      })
      for (const policy of ['role', 'expectimax'] as const) {
        const summary = summarizePolicy(policy, records[policy])
        console.log(
          `POLICY ${key} ${policy} summary wins=${summary.wins}/${summary.games} rate=${summary.rate.toFixed(3)} wilson=[${summary.lower.toFixed(3)},${summary.upper.toFixed(3)}] msPerGame=${summary.msPerGame.toFixed(1)} capped=${summary.capped}`,
        )
      }

      const logFile = battleLogFileName(key)
      writeFileSync(resolve(OUT_DIR, logFile), logChunks.join('\n\n'))

      const role = summarizePolicy('role', records.role)
      const expectimax = summarizePolicy('expectimax', records.expectimax)
      const measurement: FightMeasurement = {
        key,
        trainer: fight.trainer,
        kind: fight.kind,
        role,
        expectimax,
        classification: classifyWinRates(role.rate, expectimax.rate),
        logFiles: [logFile],
      }
      writeAtomic(resolve(OUT_DIR, `${key}.json`), JSON.stringify(measurement, null, 2))
      writeReport()
    })
  }
})

describe.skipIf(process.env.SIM_POLICY !== 'render')('policy comparison gate report', () => {
  it('rebuilds the report from the measured fights', () => {
    writeReport()
  })
})
