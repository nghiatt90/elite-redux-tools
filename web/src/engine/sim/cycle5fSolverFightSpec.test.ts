/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 5f: solver passes the fight spec to the expectimax battle and states the top-K caveat.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { playExpectimaxBattle, type ExpectimaxOptions } from './driver/expectimax'
import { fightSpecFor } from './driver/fightSpec'
import {
  defaultSet,
  fightCaveats,
  isDoubleFight,
  scoreTeam,
  TOP_K_CAVEAT,
  type Team,
} from './driver/solver'

const data = loadSimData()
const tateAndLiza = data.trainersById.get('TRAINER_TATE_AND_LIZA_1')!
const may = data.trainersById.get('TRAINER_MAY_ROUTE_103_TORCHIC')!

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

describe('cycle 5f: solver fight spec passthrough and top-K caveat', () => {
  it('1. isDoubleFight and fightCaveats identify double vs single fights', () => {
    const tateSpec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    const maySpec = fightSpecFor(data, 'TRAINER_MAY_ROUTE_103_TORCHIC')

    expect(isDoubleFight(tateSpec.format)).toBe(true)
    expect(isDoubleFight(maySpec.format)).toBe(false)

    expect(fightCaveats(tateSpec)).toEqual([TOP_K_CAVEAT])
    expect(fightCaveats(maySpec)).toEqual([])

    expect(TOP_K_CAVEAT).toContain('4')
    expect(TOP_K_CAVEAT).toContain('pruned')
  })

  it('2. passthrough is live for double fights', () => {
    const tateSpec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    expect(tateSpec.startFieldEffects.length).toBeGreaterThan(0)
    expect(tateSpec.inverseBattle).toBe(true)

    const fitness = scoreTeam(data, tateAndLiza, 'elite', team, 1, fastExpectimax, 0, undefined, {
      fightSpec: tateSpec,
    })

    const level = Math.max(...team.map((m) => m.level ?? 50))
    const party = buildPlayerParty(team, level, data, undefined)
    const direct = playExpectimaxBattle({
      data,
      playerParty: party,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      seed: 1,
      expectimax: fastExpectimax,
      battleEvents: tateSpec.battleEvents,
      format: tateSpec.format,
      inverseBattle: tateSpec.inverseBattle,
      startFieldEffects: tateSpec.startFieldEffects,
    })

    expect(fitness.winRate).toBe(direct.outcome === 'WON' ? 1 : 0)
    expect(fitness.meanScore).toBe(Math.max(-1, Math.min(1, direct.finalScore / 6)))

    // Assert that the direct run without format (the old singles-path call) is a different battle:
    // with the format the opponent fields two battlers, so turn count or final score diverges.
    let differs = false
    for (let s = 1; s <= 5; s++) {
      const specResult = playExpectimaxBattle({
        data,
        playerParty: party,
        opponentTrainer: tateAndLiza,
        tier: 'elite',
        seed: s,
        expectimax: fastExpectimax,
        battleEvents: tateSpec.battleEvents,
        format: tateSpec.format,
        inverseBattle: tateSpec.inverseBattle,
        startFieldEffects: tateSpec.startFieldEffects,
      })
      const singlesResult = playExpectimaxBattle({
        data,
        playerParty: party,
        opponentTrainer: tateAndLiza,
        tier: 'elite',
        seed: s,
        expectimax: fastExpectimax,
      })
      if (specResult.turns !== singlesResult.turns || specResult.finalScore !== singlesResult.finalScore) {
        differs = true
        break
      }
    }
    expect(differs).toBe(true)
  })

  it('3. singles unchanged: scoreTeam with fightSpec deep-equals call without fightSpec', () => {
    const maySpec = fightSpecFor(data, 'TRAINER_MAY_ROUTE_103_TORCHIC')
    const withSpec = scoreTeam(data, may, 'elite', team, 2, fastExpectimax, 0, undefined, {
      fightSpec: maySpec,
    })
    const withoutSpec = scoreTeam(data, may, 'elite', team, 2, fastExpectimax, 0, undefined)
    expect(withSpec).toEqual(withoutSpec)
  })
})
