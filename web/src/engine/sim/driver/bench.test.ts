import { describe, it } from 'vitest'
import { createRandomSource } from '../rng'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { defaultPlayerPolicy } from './runBattle'
import { chooseAiAction } from '../ai/chooseAiAction'
import { cloneSession, createSession, stepTurn } from './session'

describe.skipIf(process.env.SIM_BENCH !== '1')('bench', () => {
  it('times clone and step', () => {
    const data = loadSimData()
    const party = buildPlayerParty([{ species: 'SPECIES_TYRANITAR', level: 50, nature: 'NATURE_ADAMANT', evs: { hp: 252, atk: 252, spdef: 4 }, ability: 'ABILITY_SAND_STREAM', item: 'ITEM_SMOOTH_ROCK', moves: ['MOVE_STONE_EDGE', 'MOVE_CRUNCH', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH'] }], 50, data)
    const s = createSession({ data, playerParty: party, opponentTrainer: data.trainersById.get('TRAINER_SAWYER_1')!, rng: createRandomSource(1) })
    let t = performance.now()
    for (let i = 0; i < 200; i++) cloneSession(s, i)
    console.log('clone ms', (performance.now() - t) / 200)
    t = performance.now()
    for (let i = 0; i < 200; i++) { const c = cloneSession(s, i); stepTurn(c, defaultPlayerPolicy(c.state, data)) }
    console.log('clone+step ms', (performance.now() - t) / 200)
    t = performance.now()
    for (let i = 0; i < 200; i++) { const c = cloneSession(s, i); chooseAiAction(c.state, 1, c.chooseAiDeps) }
    console.log('clone+ai ms', (performance.now() - t) / 200)
  })
})
