/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 6a2: Juan chain through scoreChain and the solver CLI

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadBossTrainerIds } from './driver/bossSet'
import { buildChains, type TagBattle, type TrainerChain } from './driver/chains'
import type { ExpectimaxOptions } from './driver/expectimax'
import { FIGHTS } from './driver/fights'
import { loadSimData } from './driver/loadSimData'
import {
  chainCaveats,
  defaultSet,
  playChainOnce,
  scoreChain,
  type Team,
} from './driver/solver'

const data = loadSimData()

const fastExpectimax: ExpectimaxOptions = {
  depth: 1,
  samples: 2,
  innerSamples: 1,
  switchMargin: 0.05,
  statusTerms: true,
}

const team: Team = [
  defaultSet(data, 'SPECIES_SWAMPERT', 50, new Set()),
  defaultSet(data, 'SPECIES_TYRANITAR', 50, new Set()),
  defaultSet(data, 'SPECIES_METAGROSS', 50, new Set()),
  defaultSet(data, 'SPECIES_SALAMENCE', 50, new Set()),
]

const encounters = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../data/v2.65beta/encounters.json'),
    'utf8',
  ),
) as { trainerChains: TrainerChain[]; tagBattles: TagBattle[] }

const bossIds = loadBossTrainerIds()
const deferredIds = new Set(FIGHTS.filter((row) => row.deferred).flatMap((row) => row.trainerIds))
const v1Ids = new Set(bossIds.filter((id) => !deferredIds.has(id)))
const v1Chains = buildChains(encounters.trainerChains, encounters.tagBattles, v1Ids)

describe('cycle 6a2: Juan chain through scoreChain and the solver CLI', () => {
  it(
    '1. v1Chains contains Juan tag chain with 2 stages and caveats do not throw',
    { timeout: 60_000 },
    () => {
      const juan = v1Chains.find((c) => c.id === 'SootopolisCity_Gym_1F_EventScript_Juan')
      expect(juan).toBeDefined()
      expect(juan!.stages).toHaveLength(2)
      expect(juan!.stages[0]!.trainerIds[0]).toBe('TRAINER_JUAN_1')
      expect(juan!.stages[0]!.format).toBe('tag')
      expect(juan!.stages[1]!.trainerIds[0]).toBe('TRAINER_JUAN_5')
      expect(juan!.stages[1]!.format).toBe('tag')
      expect(() => chainCaveats(data, juan!)).not.toThrow()
      expect(deferredIds.has('TRAINER_JUAN_1')).toBe(false)
    },
  )

  it(
    '2. scoreChain runs for Juan chain deterministically',
    { timeout: 60_000 },
    () => {
      const juan = v1Chains.find((c) => c.id === 'SootopolisCity_Gym_1F_EventScript_Juan')!
      const fitness1 = scoreChain(data, juan, 'elite', team, 1, fastExpectimax, 0)
      expect(fitness1.games).toBe(1)
      expect([0, 1]).toContain(fitness1.winRate)
      expect(fitness1.winRate).toBe(0)
      expect(Number.isFinite(fitness1.meanScore)).toBe(true)

      const fitness2 = scoreChain(data, juan, 'elite', team, 1, fastExpectimax, 0)
      expect(fitness2).toEqual(fitness1)
    },
  )

  it(
    '3. both stages run to an outcome or stop on loss, cross-checking scoreChain',
    { timeout: 60_000 },
    () => {
      const juan = v1Chains.find((c) => c.id === 'SootopolisCity_Gym_1F_EventScript_Juan')!
      const fitness = scoreChain(data, juan, 'elite', team, 1, fastExpectimax, 0)
      const run = playChainOnce(data, juan, 'elite', team, 1)

      expect([1, 2]).toContain(run.length)
      expect(run[0]!.trainerId).toBe('TRAINER_JUAN_1')

      if (run[0]!.outcome === 'WON') {
        expect(run).toHaveLength(2)
        expect(run[1]!.trainerId).toBe('TRAINER_JUAN_5')
      } else {
        expect(run).toHaveLength(1)
        expect(run[0]!.outcome).toBe('LOST')
        expect(run[0]!.turns).toBe(5)
        expect(run[0]!.partyHp).toEqual([0, 0, 0, 0])
      }

      // Cross-check against test 2: winRate === 1 iff the run has length 2 and every outcome is 'WON'
      const allWon = run.length === 2 && run.every((s) => s.outcome === 'WON')
      expect(fitness.winRate === 1).toBe(allWon)
    },
  )
})
