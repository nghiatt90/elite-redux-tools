/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'vitest'

import { loadSimData } from './loadSimData'
import {
  battleLogFileName,
  buildFightSetup,
  classifyWinRates,
  fightKey,
  gameSeed,
  playComparisonGame,
  renderGateReport,
  summarizePolicy,
  type ComparisonGameRecord,
  type FightMeasurement,
  type PolicyComparisonFixture,
  type PolicyKind,
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
const OUT_DIR = process.env.SIM_POLICY_OUT ?? resolve(import.meta.dirname, '../../../../test-results/role-policy')
const OUT_LABEL = process.env.SIM_POLICY_OUT ?? 'web/test-results/role-policy'

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as PolicyComparisonFixture

describe.skipIf(process.env.SIM_POLICY !== '1')('policy comparison gate', () => {
  const done: FightMeasurement[] = []

  for (const fight of fixture.fights) {
    it(fightKey(fight), { timeout: 36_000_000 }, () => {
      const data = loadSimData()
      const setup = buildFightSetup(data, fight)
      const key = fightKey(fight)
      mkdirSync(OUT_DIR, { recursive: true })

      const records: Record<PolicyKind, ComparisonGameRecord[]> = { role: [], expectimax: [] }
      const logChunks: string[] = []

      for (const policy of ['role', 'expectimax'] as const) {
        for (let game = 1; game <= GAMES; game++) {
          const seed = gameSeed(SEED_OFFSET, game)
          const collectLog = policy === 'role' && game <= 2
          const record = playComparisonGame(setup, policy, seed, { maxTurns: MAX_TURNS, collectLog })
          records[policy].push(record)
          if (collectLog && record.log) {
            logChunks.push(`== ${key} ${policy} game ${game} seed ${seed} ==\n${record.log}`)
          }
          console.log(
            `POLICY ${key} ${policy} game=${game} seed=${seed} outcome=${record.outcome} turns=${record.turns} capped=${record.capped} ms=${Math.round(record.ms)}`,
          )
        }
        const summary = summarizePolicy(policy, records[policy])
        console.log(
          `POLICY ${key} ${policy} summary wins=${summary.wins}/${summary.games} rate=${summary.rate.toFixed(3)} wilson=[${summary.lower.toFixed(3)},${summary.upper.toFixed(3)}] msPerGame=${summary.msPerGame.toFixed(1)} capped=${summary.capped}`,
        )
      }

      const logFile = battleLogFileName(key)
      writeFileSync(resolve(OUT_DIR, logFile), logChunks.join('\n\n'))

      const role = summarizePolicy('role', records.role)
      const expectimax = summarizePolicy('expectimax', records.expectimax)
      done.push({
        key,
        trainer: fight.trainer,
        kind: fight.kind,
        role,
        expectimax,
        classification: classifyWinRates(role.rate, expectimax.rate),
        logFiles: [logFile],
      })

      writeFileSync(
        REPORT_PATH,
        renderGateReport({
          games: GAMES,
          maxTurns: MAX_TURNS,
          seedOffset: SEED_OFFSET,
          logDir: OUT_LABEL,
          fights: done,
        }),
      )
      writeFileSync(
        resolve(OUT_DIR, 'report.json'),
        JSON.stringify(
          {
            source: fixture.source,
            games: GAMES,
            maxTurns: MAX_TURNS,
            seedOffset: SEED_OFFSET,
            z: 1.96,
            fights: done,
          },
          null,
          2,
        ),
      )
    })
  }
})
