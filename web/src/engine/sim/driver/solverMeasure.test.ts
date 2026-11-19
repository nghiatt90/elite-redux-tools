/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'vitest'
import { eventsForFight } from './battleEventSetup'
import { levelCapForTrainer, type FightRow } from './fights'
import { GENERIC_PLAYER_SPECS } from './genericTeam'
import { loadSimData, type SimDataBundle, type TrainerData } from './loadSimData'
import { supportedSingleUnits } from './measureUnits'
import { highestBadgeRange } from './progression'
import { defaultSet, scoreTeam, type Team } from './solver'
import { availableStones } from './stoneAvailability'
import { wilsonInterval } from './wilson'
import { batchSeedOffset } from './winProbability'

const Z = 2.807
const BATCH = 40
const MAX_LOOKS = 10
const FIGHTS = ['TRAINER_ROXANNE_1', 'TRAINER_WATTSON_1', 'TRAINER_NORMAN_1']
// Step 0.4 budget: a singles game costs about 3 s, so 80 games is the per-unit ceiling.
const STEP_04_LOOKS = 2

type SampleVerdict = 'won' | 'lost' | 'open at 80'

function shardOf(spec: string): { index: number; count: number } {
  const m = /^(\d+)\/(\d+)$/.exec(spec)
  if (!m) return { index: 0, count: 1 }
  return { index: Number(m[1]), count: Number(m[2]) }
}

const SHARD = shardOf(process.env.SIM_SHARD ?? '')

let coverageDoc: string | undefined

/** Copy of `mapForTrainer` (solverCli.ts:42-50), which is not exported; the doc path is module-relative here because the CLI is bundled. */
function mapForTrainer(trainerId: string): string {
  coverageDoc ??= readFileSync(
    resolve(import.meta.dirname, '../../../../../docs/battle-sim/boss-fight-coverage.md'),
    'utf8',
  )
  for (const line of coverageDoc.split('\n')) {
    if (!line.includes('`' + trainerId + '`')) continue
    const m = /`(\w+):\d+/.exec(line.slice(line.indexOf(trainerId) + trainerId.length))
    if (m) return m[1]!
  }
  return ''
}

type BattleEventRow = { event: string; data0: number | null; data1: number | null }

function eventsForUnit(
  data: SimDataBundle,
  mapName: string,
  defeated: ReadonlySet<string>,
): BattleEventRow[] {
  return eventsForFight(data.battleEvents, mapName, defeated).events.map((e) => ({
    event: e.event,
    data0: e.data0,
    data1: e.data1,
  }))
}

interface UnitSetup {
  trainer: TrainerData
  cap: number
  badges: number
  mapName: string
  team: Team
  events: BattleEventRow[]
  allEvents: number
  guarded: number
  activeGuarded: number
}

function setupFor(
  data: SimDataBundle,
  row: FightRow,
  defeated: ReadonlySet<string>,
): UnitSetup | { skip: string } {
  const resolved = levelCapForTrainer(row.fightId)
  if (!resolved || !('cap' in resolved)) return { skip: 'no cap' }
  const trainer = data.trainersById.get(row.fightId)
  if (!trainer) return { skip: 'no trainer' }
  const cap = resolved.cap
  const badges = highestBadgeRange(row).min
  const allowedStones = new Set(availableStones(data, badges).keys())
  const team = GENERIC_PLAYER_SPECS.map((s) => defaultSet(data, s.species, cap, allowedStones))
  const mapName = mapForTrainer(row.fightId)
  const guardedIds = data.battleEvents
    .filter((e) => e.map === mapName)
    .map((e) => /^!defeated\(([^)]+)\)$/.exec(e.guard ?? '')?.[1])
    .filter((id): id is string => id !== undefined)
  return {
    trainer,
    cap,
    badges,
    mapName,
    team,
    events: eventsForUnit(data, mapName, defeated),
    allEvents: eventsForFight(data.battleEvents, mapName, new Set<string>()).events.length,
    guarded: guardedIds.length,
    activeGuarded: guardedIds.filter((id) => !defeated.has(id)).length,
  }
}

interface SampleResult {
  wins: number
  n: number
  lower: number
  upper: number
  verdict: SampleVerdict
  ms: number
}

function sampleTeam(
  data: SimDataBundle,
  trainer: TrainerData,
  team: Team,
  cap: number,
  battleEvents: BattleEventRow[],
  seedOffset: number,
  label: string,
): SampleResult {
  const t0 = performance.now()
  let wins = 0
  let n = 0
  let verdict: SampleVerdict = 'open at 80'
  for (let k = 0; k < STEP_04_LOOKS; k++) {
    const fitness = scoreTeam(data, trainer, 'elite', team, BATCH, undefined, seedOffset + k * BATCH * 1000, battleEvents, {
      levelCap: cap,
    })
    wins += Math.round(fitness.winRate * BATCH)
    n = BATCH * (k + 1)
    const look = wilsonInterval(wins, n, Z)
    console.log(
      `MEASURE 0.4 ${label} look=${k + 1} wins=${wins}/${n} lower=${look.lower.toFixed(3)} upper=${look.upper.toFixed(3)}`,
    )
    if (look.lower >= 0.9) {
      verdict = 'won'
      break
    }
    if (look.upper < 0.5) {
      verdict = 'lost'
      break
    }
  }
  const final = wilsonInterval(wins, n, Z)
  return { wins, n, lower: final.lower, upper: final.upper, verdict, ms: performance.now() - t0 }
}

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
        const fitness = scoreTeam(data, trainer, 'elite', team, BATCH, undefined, batchSeedOffset('tuning', k))
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

  it('Step 0.4 a: starting-build wins per supported single unit', { timeout: 3_000_000 }, () => {
    const data = loadSimData()
    const units = supportedSingleUnits().filter((_, i) => i % SHARD.count === SHARD.index)
    let won = 0
    let lost = 0
    let open = 0
    for (const row of units) {
      const setup = setupFor(data, row, new Set<string>())
      if ('skip' in setup) {
        console.log(`MEASURE 0.4 a ${row.fightId} skipped=${setup.skip}`)
        continue
      }
      const result = sampleTeam(data, setup.trainer, setup.team, setup.cap, setup.events, 0, `a ${row.fightId}`)
      if (result.verdict === 'won') won++
      else if (result.verdict === 'lost') lost++
      else open++
      console.log(
        `MEASURE 0.4 a ${row.fightId} cap=${setup.cap} badges=${setup.badges} map=${setup.mapName || '(none)'} events=${setup.events.length}/${setup.allEvents} wins=${result.wins}/${result.n} lower=${result.lower.toFixed(3)} upper=${result.upper.toFixed(3)} verdict=${result.verdict} games=${result.n} ms=${Math.round(result.ms)} msPerGame=${(result.ms / result.n).toFixed(1)}`,
      )
    }
    console.log(
      `MEASURE 0.4 a shard=${SHARD.index}/${SHARD.count} units=${units.length} won=${won} lost=${lost} open=${open}`,
    )
  })

  it('Step 0.4 c: candidate-set cost on TRAINER_ROXANNE_1', { timeout: 3_000_000 }, () => {
    const data = loadSimData()
    const row = supportedSingleUnits().find((fight) => fight.fightId === 'TRAINER_ROXANNE_1')!
    const mapName = mapForTrainer(row.fightId)
    const defeatable = new Set<string>()
    for (const event of data.battleEvents) {
      const m = /^!defeated\(([^)]+)\)$/.exec(event.guard ?? '')
      if (event.map === mapName && m) defeatable.add(m[1]!)
    }
    const candidates = [
      { label: 'empty', defeated: new Set<string>() },
      { label: 'all-guarded', defeated: defeatable },
    ]
    for (const candidate of candidates) {
      const setup = setupFor(data, row, candidate.defeated)
      if ('skip' in setup) throw new Error(`Step 0.4 c: ${setup.skip}`)
      for (const seeds of [
        { label: 'tuning', offset: 0 },
        { label: 'report', offset: 10_000_000 },
      ]) {
        const stamp = `c set=${candidate.label} seeds=${seeds.label}`
        const result = sampleTeam(data, setup.trainer, setup.team, setup.cap, setup.events, seeds.offset, stamp)
        console.log(
          `MEASURE 0.4 ${stamp} events=${setup.events.length}/${setup.allEvents} activeGuarded=${setup.activeGuarded}/${setup.guarded} wins=${result.wins}/${result.n} lower=${result.lower.toFixed(3)} upper=${result.upper.toFixed(3)} verdict=${result.verdict} games=${result.n} ms=${Math.round(result.ms)} msPerGame=${(result.ms / result.n).toFixed(1)}`,
        )
      }
    }
  })
})
