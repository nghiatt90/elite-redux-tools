// Command line entry for the set solver.
//
//   node solverCli.mjs --trainer TRAINER_X --team SPECIES_A,SPECIES_B,... [--level 50] [--tier elite]
//                      [--workers 8] [--passes 2]
//
// Built with `npm run solver:build`; scores candidates across a pool of worker threads.

import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadSimData } from './loadSimData'
import { DEFAULT_SEARCH, defaultSet, improveTeam, type Fitness, type FitnessEvaluator, type Team } from './solver'

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
  const allowedStones = new Set(arg('stones', '').split(',').filter(Boolean))

  const data = loadSimData({ dataDir: process.env.ER_DATA_DIR ?? resolve(process.cwd(), 'data/v2.65beta') })
  const workerPath = new URL('./solverWorker.mjs', import.meta.url)
  const workers = Array.from({ length: workerCount }, () => new Worker(workerPath, { workerData: { trainerId, tier } }))
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
    allowedStones,
    onProgress: (m) => console.log(m),
  })
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
