// Worker thread for the solver CLI: scores one team per message against a fixed fight,
// or against a fixed no-heal chain when `workerData.chain` is set.

import { parentPort, workerData } from 'node:worker_threads'
import { resolve } from 'node:path'
import type { ChainSpec } from './chains'
import { loadSimData } from './loadSimData'
import { scoreChain, scoreTeam, type StageEvents, type Team } from './solver'

const { trainerId, tier, battleEvents, chain, stageEvents, levelCap, ignoreCap } = workerData as {
  trainerId?: string
  tier: 'ace' | 'elite' | 'hell'
  battleEvents?: Array<{ event: string; data0: number | null; data1: number | null }>
  chain?: ChainSpec
  stageEvents?: StageEvents
  levelCap?: number
  ignoreCap?: boolean
}
const data = loadSimData({ dataDir: process.env.ER_DATA_DIR ?? resolve(process.cwd(), 'data/v2.65beta') })
const trainer = chain ? undefined : data.trainersById.get(trainerId!)
if (!chain && !trainer) throw new Error(`unknown trainer ${trainerId}`)

parentPort!.on('message', (msg: { id: number; team: Team; games: number; seedOffset?: number }) => {
  const fitness = chain
    ? scoreChain(data, chain, tier, msg.team, msg.games, undefined, msg.seedOffset ?? 0, stageEvents)
    : scoreTeam(data, trainer!, tier, msg.team, msg.games, undefined, msg.seedOffset ?? 0, battleEvents, {
        levelCap,
        ignoreCap,
      })
  parentPort!.postMessage({ id: msg.id, fitness })
})
