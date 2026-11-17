/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle d3-4: `scoreChain`, chainStageEvents and the `--chain` plumbing.
// Numbers are derived from docs/battle-sim/chains-plan.md decisions 4, 6 and 7:
//   - stage k of game g uses seed `seedOffset + g * 1000 + k`
//   - a non-WON stage ends the game and every unplayed stage scores the clamp floor -1
//   - a played stage scores `finalScore / 6` clamped to [-1, 1] (the `scoreTeam` clamp)
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadBossTrainerIds } from './bossSet'
import { buildPlayerParty, type PlayerMonSpec } from './buildParty'
import { carryParty, firstLiveSlot } from './carryParty'
import { buildChains, type ChainSpec, type TagBattle, type TrainerChain } from './chains'
import { playExpectimaxBattle, type ExpectimaxBattleResult } from './expectimax'
import { FIGHTS } from './fights'
import { GENERIC_PLAYER_SPECS } from './genericTeam'
import { loadSimData, type EncounterBattleEvent } from './loadSimData'
import {
  chainStageEvents,
  createChainEvaluator,
  playChainOnce,
  scoreChain,
  scoreTeam,
  type Team,
} from './solver'

const data = loadSimData()

const WEAK_FIGHT = 'TRAINER_MAY_ROUTE_103_TORCHIC'
const STRONG_FIGHT = 'TRAINER_WATTSON_1'
const ROXANNE = 'TRAINER_ROXANNE_1'

const GARCHOMP: PlayerMonSpec = {
  species: 'SPECIES_GARCHOMP',
  level: 50,
  nature: 'NATURE_JOLLY',
  evs: { atk: 252, spe: 252, hp: 4 },
  moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
}

const BLISSEY: PlayerMonSpec = {
  species: 'SPECIES_BLISSEY',
  level: 50,
  nature: 'NATURE_BOLD',
  evs: { hp: 252, def: 252, spdef: 4 },
  moves: ['MOVE_SEISMIC_TOSS', 'MOVE_SOFT_BOILED', 'MOVE_TOXIC', 'MOVE_THUNDER_WAVE'],
}

const MAGIKARP: PlayerMonSpec = {
  species: 'SPECIES_MAGIKARP',
  level: 50,
  nature: 'NATURE_HARDY',
  moves: ['MOVE_TACKLE'],
}

const trainer = (id: string) => data.trainersById.get(id)!

const encounters = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../../data/v2.65beta/encounters.json'),
    'utf8',
  ),
) as { trainerChains: TrainerChain[]; tagBattles: TagBattle[] }

const bossIds = loadBossTrainerIds()
const deferredIds = new Set(FIGHTS.filter((row) => row.deferred).flatMap((row) => row.trainerIds))
const v1Ids = new Set(bossIds.filter((id) => !deferredIds.has(id)))
const v1Chains = buildChains(encounters.trainerChains, encounters.tagBattles, v1Ids)

const JUAN = 'SootopolisCity_Gym_1F_EventScript_Juan'
const SPACE_CENTER = 'MossdeepCity_SpaceCenter_2F_EventScript_BattleThreeMagmaGrunts'
const MUSEUM = 'SlateportCity_OceanicMuseum_2F_EventScript_CaptStern'

const clamp = (result: ExpectimaxBattleResult): number =>
  Math.max(-1, Math.min(1, result.finalScore / 6))

function chain(id: string, trainerIds: string[]): ChainSpec {
  return {
    id,
    stages: trainerIds.map((trainerId) => ({ trainerIds: [trainerId], format: 'single' })),
    evidence: 'script',
  }
}

/** Party stage 1 starts with, built exactly as `scoreChain` builds it. */
function startParty(team: Team) {
  return buildPlayerParty(team, Math.max(...team.map((m) => m.level ?? 50)), data)
}

describe('cycle d3-4: scoreChain', () => {
  it('uses the stage seed rule: stage k of game g is seeded seedOffset + g * 1000 + k', () => {
    const team: Team = [GARCHOMP, BLISSEY]
    const twoStage = chain('two-stage', [WEAK_FIGHT, WEAK_FIGHT])
    const start = startParty(team)

    // Hand-run of the two stages the way scoreChain must seed them, seedOffset 0, game 1.
    const t = 'elite' as const
    const first = playExpectimaxBattle({
      data,
      playerParty: start,
      opponentTrainer: trainer(WEAK_FIGHT),
      tier: t,
      seed: 0 + 1 * 1000 + 1,
    })
    let expectedWinRate = 0
    let expectedScore: number
    if (first.outcome === 'WON') {
      const carried = carryParty(start, first.finalParty, first.finalActive)
      const second = playExpectimaxBattle({
        data,
        playerParty: carried,
        opponentTrainer: trainer(WEAK_FIGHT),
        tier: t,
        seed: 0 + 1 * 1000 + 2,
        leadIndex: firstLiveSlot(carried),
      })
      if (second.outcome === 'WON') expectedWinRate = 1
      // Both stages are played, so no stage is marked -1.
      expectedScore = (clamp(first) + clamp(second)) / 2
    } else {
      // A loss on stage 1 leaves stage 2 unplayed and worth -1.
      expectedScore = (clamp(first) - 1) / 2
    }

    expect(scoreChain(data, twoStage, t, team, 1)).toEqual({
      winRate: expectedWinRate,
      meanScore: expectedScore,
      games: 1,
    })
  })

  it('ends the game on a loss and scores every unplayed stage -1', () => {
    const team: Team = [MAGIKARP]
    const threeStage = chain('three-stage', [STRONG_FIGHT, WEAK_FIGHT, WEAK_FIGHT])
    const start = startParty(team)
    const t = 'elite' as const
    // Seed rule: stage 1 of game 1 with seedOffset 0 is 1001.
    const first = playExpectimaxBattle({
      data,
      playerParty: start,
      opponentTrainer: trainer(STRONG_FIGHT),
      tier: t,
      seed: 1001,
    })
    expect(first.outcome).not.toBe('WON')

    expect(scoreChain(data, threeStage, t, team, 1)).toEqual({
      winRate: 0,
      meanScore: (clamp(first) - 1 - 1) / 3,
      games: 1,
    })
    // The two later stages are never played, so the diagnostic stops after one row.
    const once = playChainOnce(data, threeStage, t, team, 1)
    expect(once).toHaveLength(1)
    expect(once[0]!.trainerId).toBe(STRONG_FIGHT)
  })

  it('carries damage into the next stage: a fainted lead stays fainted and changes stage 2', () => {
    // Generic team vs Roxanne on the stage-1 seed: the team wins, but only after the
    // first four slots have fainted (slots 4-5 finish the fight), so the next lead is
    // slot 4 -- the carried party is exactly the damaged one.
    const team: Team = GENERIC_PLAYER_SPECS
    const twoStage = chain('carry-two-stage', [ROXANNE, STRONG_FIGHT])
    const start = startParty(team)
    const t = 'elite' as const

    const first = playExpectimaxBattle({
      data,
      playerParty: start,
      opponentTrainer: trainer(ROXANNE),
      tier: t,
      seed: 1001,
    })
    expect(first.outcome).toBe('WON')
    expect(first.finalParty.slice(0, 4).map((mon) => mon.hp)).toEqual([0, 0, 0, 0])
    const carried = carryParty(start, first.finalParty, first.finalActive)
    expect(firstLiveSlot(carried)).not.toBe(0)
    expect(firstLiveSlot(carried)).toBe(4)
    // The next lead enters stage 2 below full HP, which a heal-between chain would not.
    expect(carried[4]!.hp).toBeLessThan(carried[4]!.maxHp)

    // Same stage-2 seed, same lead: only the carried HP differs.
    const fromCarried = playExpectimaxBattle({
      data,
      playerParty: carried,
      opponentTrainer: trainer(STRONG_FIGHT),
      tier: t,
      seed: 1002,
      leadIndex: firstLiveSlot(carried),
    })
    const fromHealed = playExpectimaxBattle({
      data,
      playerParty: start,
      opponentTrainer: trainer(STRONG_FIGHT),
      tier: t,
      seed: 1002,
      leadIndex: firstLiveSlot(carried),
    })
    expect(
      fromCarried.finalScore !== fromHealed.finalScore || fromCarried.outcome !== fromHealed.outcome,
    ).toBe(true)

    // And the loop really does carry: stage 2's party starts with slot 0 at 0 HP.
    const once = playChainOnce(data, twoStage, t, team, 1)
    expect(once).toHaveLength(2)
    expect(once[1]!.partyHp[0]).toBe(0)
  })

  it('refuses a tag stage instead of faking it as singles', () => {
    const juan = v1Chains.find((c) => c.id === JUAN)!
    expect(() => scoreChain(data, juan, 'elite', [GARCHOMP], 1)).toThrow(
      'scoreChain: stage 1 of SootopolisCity_Gym_1F_EventScript_Juan is a tag battle; doubles is not built',
    )
  })

  it('createChainEvaluator returns one Fitness per team, with the requested game count', async () => {
    const evaluate = createChainEvaluator(data, chain('evaluator', [WEAK_FIGHT, WEAK_FIGHT]), 'elite')
    const results = await evaluate([[GARCHOMP]], 2)
    expect(results).toHaveLength(1)
    expect(results[0]!.games).toBe(2)
  })

  it('chainStageEvents accumulates defeated trainers the way the guards read them', () => {
    const rows: EncounterBattleEvent[] = [
      { event: 'ALWAYS', data0: null, data1: null, guard: null, map: 'M', script: 'S' },
      { event: 'GUARDED', data0: 1, data1: 2, guard: '!defeated(TRAINER_A)', map: 'M', script: 'S' },
      { event: 'ELSEWHERE', data0: null, data1: null, guard: null, map: 'OTHER', script: 'S' },
    ]
    const twoStage = chain('events', ['TRAINER_A', 'TRAINER_B'])
    const events = chainStageEvents(twoStage, 'M', rows)
    expect(events).toEqual([
      [
        { event: 'ALWAYS', data0: null, data1: null },
        { event: 'GUARDED', data0: 1, data1: 2 },
      ],
      [{ event: 'ALWAYS', data0: null, data1: null }],
    ])
  })

  it('playExpectimaxBattle exposes the live active battler as finalActive', () => {
    const start = startParty([GARCHOMP, BLISSEY])
    const result = playExpectimaxBattle({
      data,
      playerParty: start,
      opponentTrainer: trainer(WEAK_FIGHT),
      tier: 'elite',
      seed: 3,
    })
    expect(result.outcome).toBe('WON')
    expect(typeof result.finalActive.partyIndex).toBe('number')
    expect(result.finalActive.mon.hp).toBeGreaterThan(0)
    // The mon on the field keeps its live HP on the battler; finalParty mirrors it for
    // a mon that did not faint (carryParty reads the battler first).
    expect(result.finalActive.mon.hp).toBe(result.finalParty[result.finalActive.partyIndex]!.hp)
  })

  it('leaves scoreTeam unchanged: seeds 1..games with the same clamp', () => {
    const team: Team = [MAGIKARP, GARCHOMP]
    const start = startParty(team)
    const t = 'elite' as const
    const games = 2
    let wins = 0
    let scoreSum = 0
    for (let g = 1; g <= games; g++) {
      const result = playExpectimaxBattle({
        data,
        playerParty: start,
        opponentTrainer: trainer(WEAK_FIGHT),
        tier: t,
        seed: 0 + g,
      })
      if (result.outcome === 'WON') wins++
      scoreSum += clamp(result)
    }
    expect(scoreTeam(data, trainer(WEAK_FIGHT), t, team, games)).toEqual({
      winRate: wins / games,
      meanScore: scoreSum / games,
      games,
    })
  })

  it('smoke: both v1 derived chains run a no-heal sequence on a fixed seed', { timeout: 120_000 }, () => {
    for (const id of [SPACE_CENTER, MUSEUM]) {
      const spec = v1Chains.find((c) => c.id === id)!
      const fitness = scoreChain(data, spec, 'elite', GENERIC_PLAYER_SPECS, 1)
      expect(fitness.games).toBe(1)
      expect(fitness.winRate).toBeGreaterThanOrEqual(0)
      expect(fitness.winRate).toBeLessThanOrEqual(1)
      expect(fitness.meanScore).toBeGreaterThanOrEqual(-1)
      expect(fitness.meanScore).toBeLessThanOrEqual(1)
      const once = playChainOnce(data, spec, 'elite', GENERIC_PLAYER_SPECS, 1)
      const expectedIds = spec.stages.map((stage) => stage.trainerIds[0]!)
      expect(once.length).toBeGreaterThanOrEqual(1)
      expect(once.length).toBeLessThanOrEqual(3)
      expect(once.map((stage) => stage.trainerId)).toEqual(expectedIds.slice(0, once.length))
    }
  })
})
