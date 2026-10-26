// Worker thread for the solver CLI: scores one team per message against a fixed fight.

import { parentPort, workerData } from 'node:worker_threads'
import { resolve } from 'node:path'
import { loadSimData } from './loadSimData'
import { scoreTeam, type Team } from './solver'

const { trainerId, tier } = workerData as { trainerId: string; tier: 'ace' | 'elite' | 'hell' }
const data = loadSimData({ dataDir: process.env.ER_DATA_DIR ?? resolve(process.cwd(), 'data/v2.65beta') })
const trainer = data.trainersById.get(trainerId)
if (!trainer) throw new Error(`unknown trainer ${trainerId}`)

parentPort!.on('message', (msg: { id: number; team: Team; games: number }) => {
  parentPort!.postMessage({ id: msg.id, fitness: scoreTeam(data, trainer, tier, msg.team, msg.games) })
})
