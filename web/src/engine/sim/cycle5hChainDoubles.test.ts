/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 5h: chain doubles passthrough, second battler carryParty, and top-K caveats.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadBossTrainerIds } from './driver/bossSet'
import { buildPlayerParty } from './driver/buildParty'
import { carryParty, firstLiveSlot } from './driver/carryParty'
import { buildChains, type ChainSpec, type TagBattle, type TrainerChain } from './driver/chains'
import { playExpectimaxBattle, type ExpectimaxOptions } from './driver/expectimax'
import { fightSpecFor } from './driver/fightSpec'
import { FIGHTS } from './driver/fights'
import { loadSimData } from './driver/loadSimData'
import {
  chainCaveats,
  defaultSet,
  playChainOnce,
  scoreChain,
  TOP_K_CAVEAT,
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

function chain(id: string, trainerIds: string[]): ChainSpec {
  return {
    id,
    stages: trainerIds.map((trainerId) => ({ trainerIds: [trainerId], format: 'single' })),
    evidence: 'script',
  }
}

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

describe('cycle 5h: chain doubles passthrough and second battler carry', () => {
  it(
    '1. hand-built one-stage double chain runs, reproduces direct fightSpec call and differs from format-less',
    { timeout: 30_000 },
    () => {
    const tateChain: ChainSpec = {
      id: 'tate-tag-chain',
      stages: [{ trainerIds: ['TRAINER_TATE_AND_LIZA_1'], format: 'tag' }],
      evidence: 'script',
    }
    const fitness = scoreChain(data, tateChain, 'elite', team, 1, fastExpectimax, 0)
    expect(fitness.games).toBe(1)

    const tateSpec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    const level = Math.max(...team.map((m) => m.level ?? 50))
    const party = buildPlayerParty(team, level, data)

    // Stage 1 of game 1 uses seed: seedOffset (0) + g (1) * 1000 + 1 = 1001.
    const direct = playExpectimaxBattle({
      data,
      playerParty: party,
      opponentTrainer: tateSpec.opponentTrainer,
      tier: 'elite',
      seed: 1001,
      expectimax: fastExpectimax,
      battleEvents: tateSpec.battleEvents,
      format: tateSpec.format,
      inverseBattle: tateSpec.inverseBattle,
      startFieldEffects: tateSpec.startFieldEffects,
    })

    const once = playChainOnce(data, tateChain, 'elite', team, 1)
    expect(once).toHaveLength(1)
    expect(once[0]!.trainerId).toBe('TRAINER_TATE_AND_LIZA_1')
    expect(once[0]!.outcome).toBe(direct.outcome)
    expect(once[0]!.turns).toBe(direct.turns)
    expect(fitness.meanScore).toBe(Math.max(-1, Math.min(1, direct.finalScore / 6)))

    // Assert that the direct run without format differs in turns, outcome, or finalScore
    let differs = false
    for (let s = 1; s <= 5; s++) {
      const specResult = playExpectimaxBattle({
        data,
        playerParty: party,
        opponentTrainer: tateSpec.opponentTrainer,
        tier: 'elite',
        seed: 1000 + s,
        expectimax: fastExpectimax,
        battleEvents: tateSpec.battleEvents,
        format: tateSpec.format,
        inverseBattle: tateSpec.inverseBattle,
        startFieldEffects: tateSpec.startFieldEffects,
      })
      const singlesResult = playExpectimaxBattle({
        data,
        playerParty: party,
        opponentTrainer: tateSpec.opponentTrainer,
        tier: 'elite',
        seed: 1000 + s,
        expectimax: fastExpectimax,
      })
      if (
        specResult.turns !== singlesResult.turns ||
        specResult.finalScore !== singlesResult.finalScore ||
        specResult.outcome !== singlesResult.outcome
      ) {
        differs = true
        break
      }
    }
    expect(differs).toBe(true)
  })

  it('2. Juan chain resolves tag stages without throwing and routes to stage 2 on win', { timeout: 30_000 }, () => {
    const juan = v1Chains.find((c) => c.id === 'SootopolisCity_Gym_1F_EventScript_Juan')!
    expect(juan).toBeDefined()
    expect(juan.stages.length).toBe(2)

    const once = playChainOnce(data, juan, 'elite', team, 1)
    expect(once.length).toBeGreaterThanOrEqual(1)
    expect(once.length).toBeLessThanOrEqual(2)
    expect(once[0]!.trainerId).toBe('TRAINER_JUAN_1')
    if (once[0]!.outcome === 'WON') {
      expect(once).toHaveLength(2)
      expect(once[1]!.trainerId).toBe('TRAINER_JUAN_5')
    }
  })

  it('3. carry of the second battler: damaged but alive battler 2 carries live HP with finalActives', () => {
    const tateSpec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    const bulkyTeam: Team = [
      defaultSet(data, 'SPECIES_SWAMPERT', 100, new Set()),
      defaultSet(data, 'SPECIES_BLISSEY', 100, new Set()),
      defaultSet(data, 'SPECIES_METAGROSS', 100, new Set()),
      defaultSet(data, 'SPECIES_SALAMENCE', 100, new Set()),
    ]
    const party = buildPlayerParty(bulkyTeam, 100, data)

    // Seed 3 at maxTurns 1 leaves Blissey (battler 2, slot 1) damaged but alive (180/652 HP).
    const res = playExpectimaxBattle({
      data,
      playerParty: party,
      opponentTrainer: tateSpec.opponentTrainer,
      tier: 'elite',
      seed: 3,
      maxTurns: 1,
      expectimax: fastExpectimax,
      battleEvents: tateSpec.battleEvents,
      format: tateSpec.format,
      inverseBattle: tateSpec.inverseBattle,
      startFieldEffects: tateSpec.startFieldEffects,
    })

    const b2 = res.finalActives?.[1]
    expect(b2).toBeDefined()
    expect(b2!.partyIndex).toBe(1)
    expect(b2!.mon.hp).toBeGreaterThan(0)
    expect(b2!.mon.hp).toBeLessThan(b2!.mon.maxHp)

    // With finalActives holding [battler 0, battler 2], carryParty reads battler 2's live HP
    const carried = carryParty(party, res.finalParty, res.finalActives)
    expect(carried[b2!.partyIndex]!.hp).toBe(b2!.mon.hp)

    // If only finalActive (battler 0) were provided and endParty retained pre-battle HP (party slot
    // only written on switch-out), carryParty would fall back to endParty and fail to carry live HP.
    const unswitchedEndParty = res.finalParty.map((m, idx) =>
      idx === b2!.partyIndex ? { ...m, hp: party[idx]!.hp } : m,
    )
    const carriedWithBoth = carryParty(party, unswitchedEndParty, res.finalActives)
    const carriedWithActive0Only = carryParty(party, unswitchedEndParty, res.finalActive)
    expect(carriedWithBoth[b2!.partyIndex]!.hp).toBe(b2!.mon.hp)
    expect(carriedWithActive0Only[b2!.partyIndex]!.hp).not.toBe(b2!.mon.hp)
    expect(carriedWithActive0Only[b2!.partyIndex]!.hp).toBe(party[b2!.partyIndex]!.hp)
  })

  it('4. negative: chain of two single stages gives exactly the same Fitness as direct hand loop', () => {
    const twoStage = chain('two-stage', ['TRAINER_MAY_ROUTE_103_TORCHIC', 'TRAINER_MAY_ROUTE_103_TORCHIC'])
    const fitness = scoreChain(data, twoStage, 'elite', team, 1, fastExpectimax, 0)

    const level = Math.max(...team.map((m) => m.level ?? 50))
    const start = buildPlayerParty(team, level, data)
    const mayTrainer = data.trainersById.get('TRAINER_MAY_ROUTE_103_TORCHIC')!

    const first = playExpectimaxBattle({
      data,
      playerParty: start,
      opponentTrainer: mayTrainer,
      tier: 'elite',
      seed: 1001,
      expectimax: fastExpectimax,
    })
    const carried = carryParty(start, first.finalParty, first.finalActives ?? first.finalActive)
    let totalScore = Math.max(-1, Math.min(1, first.finalScore / 6))
    let won = first.outcome === 'WON'
    if (won) {
      const second = playExpectimaxBattle({
        data,
        playerParty: carried,
        opponentTrainer: mayTrainer,
        tier: 'elite',
        seed: 1002,
        expectimax: fastExpectimax,
        leadIndex: firstLiveSlot(carried),
      })
      totalScore += Math.max(-1, Math.min(1, second.finalScore / 6))
      won = second.outcome === 'WON'
    } else {
      totalScore -= 1
    }

    expect(fitness.winRate).toBe(won ? 1 : 0)
    expect(fitness.meanScore).toBe(totalScore / 2)
  })

  it('5. chainCaveats returns [TOP_K_CAVEAT] for Juan chain and [] for a singles chain', () => {
    const juan = v1Chains.find((c) => c.id === 'SootopolisCity_Gym_1F_EventScript_Juan')!
    const singles = chain('singles', ['TRAINER_MAY_ROUTE_103_TORCHIC', 'TRAINER_WATTSON_1'])

    expect(chainCaveats(data, juan)).toEqual([TOP_K_CAVEAT])
    expect(chainCaveats(data, singles)).toEqual([])
  })
})
