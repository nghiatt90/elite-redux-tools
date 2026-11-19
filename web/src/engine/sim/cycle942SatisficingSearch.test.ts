/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 942 (Step 2.1 of docs/battle-sim/solver-v2-plan.md): the satisficing unit search,
// its candidate records and the team diff. Numbers are hand-derived from
// driver/winProbability.ts at the corrected per-look level (z = 2.807):
//   40/40 wins  -> lower 0.8354, not `won`, so a won build needs a second look (80 games);
//   4/40 wins   -> upper 0.3042 (`lost`); 8/40 -> upper 0.4191 (`lost`);
//   12/40 wins  -> upper 0.5218 (`uncertain`); 24/80 -> upper 0.4563 (`lost`).
import { describe, expect, it } from 'vitest'

import type { PlayerMonSpec } from './driver/buildParty'
import type { SimDataBundle } from './driver/loadSimData'
import {
  FINALISTS,
  MAX_CONFIRMATIONS,
  RESCORE_CANDIDATES,
  SCREEN_GAMES,
  searchUnit,
  teamDiff,
  type UnitEvaluator,
} from './driver/satisficingSearch'
import { shuffled, type Team } from './driver/solver'
import { SEED_OFFSET, winProbability } from './driver/winProbability'

const START_ITEM = 'ITEM_LEFTOVERS'
const WINNING = 'ITEM_CHOICE_BAND'
const LIFE_ORB = 'ITEM_LIFE_ORB'
const SITRUS = 'ITEM_SITRUS_BERRY'
const ROCKY = 'ITEM_ROCKY_HELMET'

/** No real species data: neighbour generation is injected, so `data` is never read. */
const data = {} as SimDataBundle

function mon(item: string | null): PlayerMonSpec {
  return {
    species: 'SPECIES_GARCHOMP',
    level: 50,
    nature: 'NATURE_JOLLY',
    evs: { atk: 252, spe: 252, hp: 4 },
    ability: 'ABILITY_ROUGH_SKIN',
    item,
    moves: ['MOVE_EARTHQUAKE', 'MOVE_DRAGON_CLAW', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
  }
}

const start = (): Team => [mon(START_ITEM)]

interface Call {
  teams: number
  games: number
  seedOffset: number
  items: string[]
}

/** Deterministic fake keyed by the lead member's item; `report` overrides on report seeds. */
function fakeEvaluator(rates: Record<string, number>, trace: Call[], report?: Record<string, number>): UnitEvaluator {
  return async (teams, games, seedOffset) => {
    trace.push({ teams: teams.length, games, seedOffset, items: teams.map((t) => t[0]!.item ?? '') })
    return teams.map((team) => {
      const item = team[0]!.item ?? ''
      const table = seedOffset >= SEED_OFFSET.report && report ? report : rates
      return { winRate: table[item] ?? 0, meanScore: 0, games }
    })
  }
}

describe('cycle 942: satisficing unit search', () => {
  it('1. a start build that is reliably won returns immediately on report seeds', async () => {
    expect(winProbability(40, 40).lower).toBeLessThan(0.9)
    const trace: Call[] = []
    const result = await searchUnit({
      data,
      start: start(),
      evaluate: fakeEvaluator({ [START_ITEM]: 1 }, trace),
      allowedStones: new Set(),
    })
    expect(result.status).toBe('won')
    expect(result.team).toEqual(start())
    expect(result.tuningGames).toBe(0)
    expect(result.confirmations).toBe(0)
    expect(result.rounds).toEqual([])
    expect(result.whatToChange).toEqual([])
    expect(result.fragilityChecked).toBe(false)
    // The first look (40/40) is not `won`; the second takes the run to 80 games.
    expect(result.report.n).toBe(80)
    expect(result.report).toEqual(result.startReport)
    expect(result.reportGames).toBe(result.report.n)
    expect(trace.map((c) => [c.teams, c.games, c.seedOffset])).toEqual([
      [1, 40, SEED_OFFSET.report],
      [1, 40, SEED_OFFSET.report + 40_000],
    ])
    expect(trace.every((c) => c.seedOffset >= SEED_OFFSET.report)).toBe(true)
  })

  it('2. start lost: screens all neighbours, samples in screen order, confirms the winner once', async () => {
    const trace: Call[] = []
    const rates = { [START_ITEM]: 0.1, [WINNING]: 1, [LIFE_ORB]: 0.3, [SITRUS]: 0.1 }
    const candidates: Team[] = [[mon(WINNING)], [mon(LIFE_ORB)], [mon(SITRUS)]]
    const result = await searchUnit({
      data,
      start: start(),
      evaluate: fakeEvaluator(rates, trace),
      allowedStones: new Set(),
      generate: () => candidates,
    })
    // game counts: the start costs one report look (4/40 -> lost, 40 games); screening is
    // 3 candidates x 4 games at tuning offset 0; the winner's tuning run is 40 + 40 = 80
    // games (40/40 is not `won`); its confirmation is 40 + 40 = 80 report games.
    expect(trace[1]).toMatchObject({ teams: 3, games: SCREEN_GAMES, seedOffset: SEED_OFFSET.tuning })
    expect(result.status).toBe('won')
    expect(result.confirmations).toBe(1)
    expect(result.tuningGames).toBe(3 * SCREEN_GAMES + 80)
    expect(result.reportGames).toBe(40 + 80)
    expect(result.report.wins).toBe(80)
    expect(result.team).toEqual([mon(WINNING)])
    expect(teamDiff(start(), result.team)).toEqual([{ member: 0, field: 'item', from: START_ITEM, to: WINNING }])
    const winner = result.rounds[0]!.candidates.find((c) => c.team[0]!.item === WINNING)!
    expect(winner.tuneVerdict).toBe('won')
    expect(winner.tuneWins).toBe(80)
    expect(winner.tuneGames).toBe(80)
    expect(winner.reportVerdict).toBe('won')
    expect(winner.reportWins).toBe(80)
    expect(winner.change).toEqual([{ member: 0, field: 'item', from: START_ITEM, to: WINNING }])
    expect(result.rounds[0]!.candidates).toHaveLength(3)
    expect(result.whatToChange).toEqual([])
  })

  it('3. tuning-won but report-lost: the search moves on and exhausts its confirmations', async () => {
    const trace: Call[] = []
    const items = [WINNING, SITRUS, LIFE_ORB]
    const all = [START_ITEM, ...items]
    const tuning = Object.fromEntries(all.map((i) => [i, 1]))
    const report = Object.fromEntries(all.map((i) => [i, 0.1]))
    const result = await searchUnit({
      data,
      start: start(),
      evaluate: fakeEvaluator(tuning, trace, report),
      allowedStones: new Set(),
      generate: () => items.map((item) => [mon(item)]),
    })
    // round 0: screen 3*4 = 12; three tuning runs of 80 (each 40/40 then 80/80); three failed
    // report confirmations of 40 (4/40 -> lost). round 1: screen 12 + one tuning run of 80,
    // then the confirmations are gone.
    expect(result.status).toBe('confirmationsExhausted')
    expect(result.confirmations).toBe(MAX_CONFIRMATIONS)
    expect(result.rounds).toHaveLength(2)
    expect(result.tuningGames).toBe(3 * SCREEN_GAMES + 3 * 80 + 3 * SCREEN_GAMES + 80)
    expect(result.reportGames).toBe(40 + 3 * 40)
    expect(result.rounds[0]!.candidates.filter((c) => c.reportVerdict === 'lost')).toHaveLength(3)
    expect(result.rounds[0]!.candidates.every((c) => c.tuneVerdict === 'won')).toBe(true)
    expect(result.whatToChange).toHaveLength(RESCORE_CANDIDATES)
    expect(result.whatToChange.every((r) => r.reportVerdict === 'lost')).toBe(true)
  })

  it('4. no candidate ever wins: stops at the cap and re-scores the best three', async () => {
    const trace: Call[] = []
    const items = [WINNING, SITRUS, LIFE_ORB]
    const rates = Object.fromEntries([START_ITEM, ...items].map((i) => [i, 0.1]))
    const result = await searchUnit({
      data,
      start: start(),
      evaluate: fakeEvaluator(rates, trace),
      allowedStones: new Set(),
      generate: () => items.map((item) => [mon(item)]),
      unitCap: 400,
    })
    // per round: screen 12 + three lost samples of 40 = 132. Rounds 0-2 spend 396; round 3
    // screens to 408 and the pre-finalist cap check stops it (overshoot is one screen here).
    expect(result.status).toBe('cap')
    expect(result.tuningGames).toBe(408)
    expect(result.tuningGames).toBeGreaterThanOrEqual(400)
    expect(result.tuningGames).toBeLessThan(400 + 400)
    expect(result.whatToChange).toHaveLength(RESCORE_CANDIDATES)
    expect(result.whatToChange.every((r) => r.reportVerdict === 'lost')).toBe(true)
    // the start's look (40) plus three report-seed re-scores of 40 each
    expect(result.reportGames).toBe(40 + 3 * 40)
    expect(result.report.verdict).toBe('lost')
  })

  it('5. an empty neighbour set stops with noNeighbours and reports the start', async () => {
    const trace: Call[] = []
    const result = await searchUnit({
      data,
      start: start(),
      evaluate: fakeEvaluator({ [START_ITEM]: 0.1 }, trace),
      allowedStones: new Set(),
      generate: () => [],
    })
    expect(result.status).toBe('noNeighbours')
    expect(result.team).toEqual(start())
    expect(result.report).toEqual(result.startReport)
    expect(result.rounds).toEqual([])
    expect(result.tuningGames).toBe(0)
    expect(result.whatToChange).toEqual([])
  })

  it('6. candidates are sampled in descending screen fitness, only FINALISTS per round', async () => {
    const trace: Call[] = []
    const generationOrder = [SITRUS, WINNING, LIFE_ORB, ROCKY]
    const rates = { [START_ITEM]: 0.1, [SITRUS]: 0.1, [WINNING]: 1, [LIFE_ORB]: 0.3, [ROCKY]: 0.2 }
    const lostOnReport = Object.fromEntries([START_ITEM, ...generationOrder].map((i) => [i, 0.1]))
    const result = await searchUnit({
      data,
      start: start(),
      evaluate: fakeEvaluator(rates, trace, lostOnReport),
      allowedStones: new Set(),
      generate: (team) => (team[0]!.item === START_ITEM ? generationOrder.map((item) => [mon(item)]) : []),
    })
    // round 0 screen order: WINNING 1.0, LIFE_ORB 0.3, ROCKY 0.2, SITRUS 0.1 -> three finalists.
    const tuningItems: string[] = []
    for (const call of trace) {
      if (call.games === 40 && call.seedOffset < SEED_OFFSET.report && tuningItems.at(-1) !== call.items[0])
        tuningItems.push(call.items[0]!)
    }
    expect(tuningItems).toEqual([WINNING, LIFE_ORB, ROCKY])
    const screened = result.rounds[0]!.candidates
    expect(screened).toHaveLength(4)
    expect(screened.filter((c) => c.tuneVerdict !== undefined)).toHaveLength(FINALISTS)
    expect(screened.filter((c) => c.tuneVerdict === undefined).map((c) => c.team[0]!.item)).toEqual([SITRUS])
    // round 0: screen 16 + 80 (WINNING) + 80 (LIFE_ORB: uncertain at 40, lost at 80) + 40 (ROCKY)
    expect(result.tuningGames).toBe(4 * SCREEN_GAMES + 80 + 80 + 40)
    // start 40 + failed confirmation 40 + two re-scores 40 each
    expect(result.reportGames).toBe(40 + 40 + 2 * 40)
    expect(result.status).toBe('noNeighbours')
  })

  it("7. round 0's best tuning rate becomes round 1's incumbent", async () => {
    const trace: Call[] = []
    const items = [WINNING, LIFE_ORB, SITRUS]
    const rates = { [START_ITEM]: 0.1, [WINNING]: 0.2, [LIFE_ORB]: 0.3, [SITRUS]: 0.1 }
    const lostOnReport = Object.fromEntries([START_ITEM, ...items].map((i) => [i, 0.1]))
    const result = await searchUnit({
      data,
      start: start(),
      evaluate: fakeEvaluator(rates, trace, lostOnReport),
      allowedStones: new Set(),
      generate: () => items.map((item) => [mon(item)]),
      unitCap: 180,
    })
    // round 0: screen 12 + 40 (0.2, lost) + 80 (0.3, uncertain then lost) + 40 (0.1, lost) = 172;
    // round 1 screens to 184 and the pre-finalist cap check stops it.
    expect(result.status).toBe('cap')
    expect(result.tuningGames).toBe(3 * SCREEN_GAMES + 40 + 80 + 40 + 3 * SCREEN_GAMES)
    expect(result.rounds).toHaveLength(2)
    expect(result.rounds[0]!.incumbent[0]!.item).toBe(START_ITEM)
    expect(result.rounds[1]!.incumbent[0]!.item).toBe(LIFE_ORB)
  })

  it('8. teamDiff reports one entry per differing field', () => {
    const before = [mon(START_ITEM)]
    expect(teamDiff(before, [mon(START_ITEM)])).toEqual([])

    const moves: Team = [{ ...mon(START_ITEM), moves: [...mon(START_ITEM).moves] }]
    moves[0]!.moves[2] = 'MOVE_FIRE_BLAST'
    expect(teamDiff(before, moves)).toEqual([
      { member: 0, field: 'moves[2]', from: 'MOVE_POISON_JAB', to: 'MOVE_FIRE_BLAST' },
    ])

    const evs: Team = [{ ...mon(START_ITEM), evs: { atk: 252, spe: 252, def: 4 } }]
    expect(teamDiff(before, evs)).toEqual([
      { member: 0, field: 'evs', from: { atk: 252, spe: 252, hp: 4 }, to: { atk: 252, spe: 252, def: 4 } },
    ])

    const item: Team = [mon(WINNING)]
    expect(teamDiff(before, item)).toEqual([{ member: 0, field: 'item', from: START_ITEM, to: WINNING }])
  })

  it('9. shuffled is exported and deterministic for a seed', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8]
    expect(shuffled(items, 7)).toEqual(shuffled(items, 7))
    expect(shuffled(items, 7)).not.toEqual(shuffled(items, 8))
  })
})
