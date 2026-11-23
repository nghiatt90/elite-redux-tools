/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 943 (Step 2.2 of docs/battle-sim/solver-v2-plan.md, decision 9c): the battle
// summary `playExpectimaxBattle` returns and the loss anatomy over many games.
//
// Loss-anatomy numbers (test 1) are hand-derived: 5 games, 2 WON and 3 LOST with
// firstFaintTurn 2, 2, null -> {2: 2, 0: 1}; endSlot 0, 0, 1 -> {0: 2, 1: 1};
// opponentRemaining 1, 2, 3 -> mean 2. A WON game's faint (turn 4) is counted by
// `games` only, never by the histogram.
//
// Battle numbers (tests 3-4) are the deterministic values the unmodified
// expectation produced on its first run for these seeds: Garchomp/Blissey vs
// TRAINER_MAY_ROUTE_103_TORCHIC seed 1 -> WON at turn 2 (finalScore 2.52);
// Magikarp vs TRAINER_WATTSON_1 seed 1001 -> LOST at turn 1, slot 0 down, the
// first faint on turn 1 (= turns). The summary code only reads state after
// `stepTurn`, so it cannot change these.
import { describe, expect, it } from 'vitest'

import { buildPlayerParty, type PlayerMonSpec } from './driver/buildParty'
import { playExpectimaxBattle } from './driver/expectimax'
import { loadSimData } from './driver/loadSimData'
import { lossAnatomy, type BattleSummary } from './driver/lossAnatomy'

const data = loadSimData()

const WEAK_FIGHT = 'TRAINER_MAY_ROUTE_103_TORCHIC'
const STRONG_FIGHT = 'TRAINER_WATTSON_1'

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

function summary(partial: Partial<BattleSummary> = {}): BattleSummary {
  return { firstFaintTurn: null, faintedSlots: [], endSlot: 0, opponentRemaining: 0, ...partial }
}

describe('cycle 943: loss anatomy', () => {
  it('aggregates the non-WON games only', () => {
    const results = [
      { outcome: 'WON', summary: summary({ firstFaintTurn: 4, endSlot: 1, opponentRemaining: 0 }) },
      { outcome: 'WON', summary: summary() },
      { outcome: 'LOST', summary: summary({ firstFaintTurn: 2, endSlot: 0, opponentRemaining: 1 }) },
      { outcome: 'LOST', summary: summary({ firstFaintTurn: 2, endSlot: 0, opponentRemaining: 2 }) },
      { outcome: 'LOST', summary: summary({ firstFaintTurn: null, endSlot: 1, opponentRemaining: 3 }) },
    ]

    expect(lossAnatomy(results)).toEqual({
      games: 5,
      losses: 3,
      firstFaintHistogram: { 2: 2, 0: 1 },
      endSlotCounts: { 0: 2, 1: 1 },
      meanOpponentRemainingInLosses: 2,
    })
  })

  it('returns empty aggregates when there are no losses', () => {
    expect(lossAnatomy([])).toEqual({
      games: 0,
      losses: 0,
      firstFaintHistogram: {},
      endSlotCounts: {},
      meanOpponentRemainingInLosses: null,
    })
    expect(lossAnatomy([{ outcome: 'WON', summary: summary({ firstFaintTurn: 3 }) }])).toEqual({
      games: 1,
      losses: 0,
      firstFaintHistogram: {},
      endSlotCounts: {},
      meanOpponentRemainingInLosses: null,
    })
  })

  it('reports a summary consistent with the battle state', { timeout: 30_000 }, () => {
    const playerParty = buildPlayerParty([GARCHOMP, BLISSEY], 50, data)
    const may = playExpectimaxBattle({
      data,
      playerParty,
      opponentTrainer: trainer(WEAK_FIGHT),
      tier: 'elite',
      seed: 1,
    })
    const wattson = playExpectimaxBattle({
      data,
      playerParty: buildPlayerParty([MAGIKARP], 50, data),
      opponentTrainer: trainer(STRONG_FIGHT),
      tier: 'elite',
      seed: 1001,
    })

    for (const result of [may, wattson]) {
      const s = result.summary
      // The first-faint turn is either absent or the 1-based turn it happened on.
      expect(
        s.firstFaintTurn === null ||
          (Number.isInteger(s.firstFaintTurn) &&
            s.firstFaintTurn >= 1 &&
            s.firstFaintTurn <= result.turns),
      ).toBe(true)
      // No faint turn means nothing was down at the end, and vice versa.
      if (s.firstFaintTurn === null) expect(s.faintedSlots).toEqual([])
      if (s.faintedSlots.length > 0) expect(s.firstFaintTurn).not.toBeNull()
      // The end slot is the live battler's party slot.
      expect(s.endSlot).toBe(result.finalActive.partyIndex)
    }

    // A win without a faint: no faint turn, no fainted slot.
    expect(may.outcome).toBe('WON')
    expect(may.summary.firstFaintTurn).toBeNull()
    expect(may.summary.faintedSlots).toEqual([])
  })

  it('leaves outcome, turns and finalScore unchanged and deterministic', { timeout: 30_000 }, () => {
    const options = {
      data,
      playerParty: buildPlayerParty([GARCHOMP, BLISSEY], 50, data),
      opponentTrainer: trainer(WEAK_FIGHT),
      tier: 'elite' as const,
      seed: 1,
    }
    const first = playExpectimaxBattle(options)
    const second = playExpectimaxBattle(options)

    expect(second.outcome).toBe(first.outcome)
    expect(second.turns).toBe(first.turns)
    expect(second.finalScore).toBe(first.finalScore)

    // Captured from the unmodified expectation on the first run (the summary is
    // read-only, so these are the same numbers).
    expect(first.outcome).toBe('WON')
    expect(first.turns).toBe(2)
    expect(first.finalScore).toBeCloseTo(2.52, 6)
  })

  it('reports the only mon down on a one-mon loss', { timeout: 30_000 }, () => {
    const result = playExpectimaxBattle({
      data,
      playerParty: buildPlayerParty([MAGIKARP], 50, data),
      opponentTrainer: trainer(STRONG_FIGHT),
      tier: 'elite',
      seed: 1001,
    })

    expect(result.outcome).toBe('LOST')
    expect(result.summary.faintedSlots).toContain(0)
    expect(result.summary.firstFaintTurn).toBe(result.turns)
  })
})
