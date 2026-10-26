// Command line entry for the set solver.
//
//   node solverCli.mjs --trainer TRAINER_X --team SPECIES_A,SPECIES_B,... [--level 50] [--tier elite]
//                      [--workers 8] [--passes 2]
//
// Built with `npm run solver:build`; scores candidates across a pool of worker threads.

import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadSimData } from './loadSimData'
import { availableStones } from './stoneAvailability'
import { eventsForFight } from './battleEventSetup'
import { DEFAULT_SEARCH, defaultSet, improveTeam, type Fitness, type FitnessEvaluator, type Team } from './solver'

/** The map a boss fight happens in, from the evidence column of docs/battle-sim/boss-fight-coverage.md. */
function mapForTrainer(trainerId: string): string {
  const doc = readFileSync(resolve(process.cwd(), 'docs/battle-sim/boss-fight-coverage.md'), 'utf8')
  for (const line of doc.split('\n')) {
    if (!line.includes('`' + trainerId + '`')) continue
    const m = /`(\w+):\d+/.exec(line.slice(line.indexOf(trainerId) + trainerId.length))
    if (m) return m[1]
  }
  return ''
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`missing --${name}`)
}

async function main(): Promise<void> {
  const trainerId = arg('trainer')
  const species = arg('team').split(',')
  const level = Number(arg('level', '50'))
  const tier = arg('tier', 'elite') as 'ace' | 'elite' | 'hell'
  const workerCount = Number(arg('workers', String(Math.max(1, cpus().length - 1))))
  const passes = Number(arg('passes', String(DEFAULT_SEARCH.passes)))
  const out = arg('out', '')
  const gym = Number(arg('gym', '0'))
  const mapName = arg('map', '') || mapForTrainer(trainerId)
  const defeatedArg = arg('defeated', 'none')
  const data0 = loadSimData({ dataDir: process.env.ER_DATA_DIR ?? resolve(process.cwd(), 'data/v2.65beta') })
  const stoneInfo = gym > 0 ? availableStones(data0, gym) : new Map()
  const allowedStones = new Set<string>([...stoneInfo.keys(), ...arg('stones', '').split(',').filter(Boolean)])
  const allEvents = eventsForFight(data0.battleEvents, mapName, new Set<string>()).events
  const defeatable = new Set<string>()
  for (const row of data0.battleEvents) {
    const m = /^!defeated\(([^)]+)\)$/.exec(row.guard ?? '')
    if (row.map === mapName && m) defeatable.add(m[1])
  }
  const defeated = defeatedArg === 'all' ? defeatable : defeatedArg === 'none' ? new Set<string>() : new Set(defeatedArg.split(','))
  const fight = eventsForFight(data0.battleEvents, mapName, defeated)
  const battleEvents = fight.events.map((e) => ({ event: e.event, data0: e.data0, data1: e.data1 }))
  console.log(`map ${mapName || '(none)'}: ${battleEvents.length}/${allEvents.length} gym events active (defeated: ${[...defeated].join(',') || 'none'})`)
  if (fight.skippedGuards.length) console.log('skipped guards:', fight.skippedGuards.join('; '))
  console.log(`gym ${gym || '(not set)'}: ${allowedStones.size} Mega stones available`)

  const data = loadSimData({ dataDir: process.env.ER_DATA_DIR ?? resolve(process.cwd(), 'data/v2.65beta') })
  const workerPath = new URL('./solverWorker.mjs', import.meta.url)
  const workers = Array.from({ length: workerCount }, () => new Worker(workerPath, { workerData: { trainerId, tier, battleEvents } }))
  const idle = [...workers]
  const waiting: Array<() => void> = []
  let nextId = 0

  const acquire = async (): Promise<Worker> => {
    while (idle.length === 0) await new Promise<void>((r) => waiting.push(r))
    return idle.pop()!
  }
  const release = (w: Worker): void => {
    idle.push(w)
    waiting.shift()?.()
  }

  const evaluateAt = (teams: Team[], games: number, seedOffset: number): Promise<Fitness[]> =>
    Promise.all(
      teams.map(async (team) => {
        const worker = await acquire()
        const id = nextId++
        return new Promise<Fitness>((resolve, reject) => {
          const onMessage = (msg: { id: number; fitness: Fitness }): void => {
            if (msg.id !== id) return
            worker.off('message', onMessage)
            worker.off('error', reject)
            release(worker)
            resolve(msg.fitness)
          }
          worker.on('message', onMessage)
          worker.on('error', reject)
          worker.postMessage({ id, team, games, seedOffset })
        })
      }),
    )

  const evaluate: FitnessEvaluator = (teams, games) => evaluateAt(teams, games, 0)
  const start: Team = species.map((s) => defaultSet(data, s, level, allowedStones))
  const result = await improveTeam(data, start, evaluate, {
    ...DEFAULT_SEARCH,
    passes,
    confirmGames: Number(arg('confirm', String(DEFAULT_SEARCH.confirmGames))),
    screenGames: Number(arg('screen', String(DEFAULT_SEARCH.screenGames))),
    allowedStones,
    onProgress: (m) => console.log(m),
  })
  for (const mon of result.team) {
    for (const m of (data.speciesById.get(mon.species)?.megas ?? []) as Array<{ item: string }>) {
      const info = stoneInfo.get(m.item)
      console.log(`Mega form ${mon.species} needs ${m.item}: ${info ? info.reason + (info.unverified ? ' [UNVERIFIED]' : '') : 'listed with --stones'}`)
    }
  }
  const [fresh] = await evaluateAt([result.team], 40, 1000)
  console.log(`fresh seeds (40 games): win ${fresh.winRate.toFixed(2)} score ${fresh.meanScore.toFixed(2)}`)
  console.log(JSON.stringify({ fitness: result.fitness, fresh, team: result.team }, null, 2))
  if (out) writeFileSync(out, JSON.stringify({ trainerId, tier, fitness: result.fitness, fresh, team: result.team }, null, 2))
  for (const w of workers) await w.terminate()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
