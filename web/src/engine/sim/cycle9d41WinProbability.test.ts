/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle d4-1 (Step 1.1 of docs/battle-sim/solver-v2-plan.md): the Wilson interval at the
// corrected per-look level, the sequential sampler and verdict rule (decision 4) and the
// seed allocator (decision 5). Numbers are hand-derived from the Wilson formula with
// z = 2.807 (z^2 = 7.8792):
//   centre = (p + z^2 / 2n) / (1 + z^2 / n)
//   margin = z * sqrt(p(1-p)/n + z^2 / 4n^2) / (1 + z^2 / n)
import { describe, expect, it, vi } from 'vitest'

import type { BattlerState, SimPartyMon } from './state'
import type { PlayerMonSpec } from './driver/buildParty'
import type { ChainSpec } from './driver/chains'
import type { ExpectimaxBattleResult } from './driver/expectimax'
import { loadSimData } from './driver/loadSimData'
import { scoreChain, scoreTeam, type Team } from './driver/solver'
import {
  BATCH_GAMES,
  SEED_OFFSET,
  battleSeed,
  batchSeedOffset,
  sampleWinProbability,
  verdictOf,
  winProbability,
  winsOf,
  zForLevel,
} from './driver/winProbability'

const data = loadSimData()
const trainer = (id: string) => data.trainersById.get(id)!

const WEAK_FIGHT = 'TRAINER_MAY_ROUTE_103_TORCHIC'

const GARCHOMP: PlayerMonSpec = {
  species: 'SPECIES_GARCHOMP',
  level: 50,
  nature: 'NATURE_JOLLY',
  evs: { atk: 252, spe: 252, hp: 4 },
  moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
}

const MAGIKARP: PlayerMonSpec = {
  species: 'SPECIES_MAGIKARP',
  level: 50,
  nature: 'NATURE_HARDY',
  moves: ['MOVE_TACKLE'],
}

/** Two-stage single chain, built the way `cycled3-4ScoreChain.test.ts` builds one. */
function chain(id: string, trainerIds: string[]): ChainSpec {
  return {
    id,
    stages: trainerIds.map((trainerId) => ({ trainerIds: [trainerId], format: 'single' })),
    evidence: 'script',
  }
}

/** A minimal canned battle result: `scoreTeam` reads `outcome`/`finalScore`, `scoreChain`
 * additionally reads `finalParty` and the final actives through `carryParty`. */
interface MockBattleOptions {
  seed: number
  playerParty: SimPartyMon[]
}

const record = vi.hoisted(() => ({ seeds: [] as number[] }))

vi.mock('./driver/expectimax', async (orig) => {
  const actual = await orig<typeof import('./driver/expectimax')>()
  return {
    ...actual,
    playExpectimaxBattle: (args: MockBattleOptions): ExpectimaxBattleResult => {
      record.seeds.push(args.seed)
      return {
        outcome: 'WON',
        turns: 1,
        finalScore: 0,
        finalParty: args.playerParty,
        finalActives: [] as BattlerState[],
        finalActive: undefined as unknown as BattlerState,
        summary: { firstFaintTurn: null, faintedSlots: [], endSlot: 0, opponentRemaining: 0 },
      }
    },
  }
})

const close = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThan(2e-3)
}

const overlap = (a: number[], b: number[]): number[] => {
  const inB = new Set(b)
  return a.filter((x) => inB.has(x))
}

const sorted = (xs: number[]): number[] => [...xs].sort((x, y) => x - y)

describe('cycle d4-1: winProbability', () => {
  it('1. zForLevel matches the two-sided quantiles and rejects levels outside (0, 1)', () => {
    expect(Math.abs(zForLevel(0.005) - 2.807034)).toBeLessThan(1e-5)
    expect(Math.abs(zForLevel(0.05) - 1.959964)).toBeLessThan(1e-5)
    expect(() => zForLevel(0)).toThrow()
    expect(() => zForLevel(1)).toThrow()
  })

  it('2. 40 straight wins is below 0.90: a won verdict needs more than one batch', () => {
    const w = winProbability(40, 40)
    // 1 + 7.8792/40 = 1.19698; centre (1 + 7.8792/80)/1.19698 = 0.91772;
    // margin 2.807 * sqrt(7.8792/6400)/1.19698 = 0.08228.
    close(w.lower, 0.8354)
    close(w.upper, 1)
    expect(w.p).toBe(1)
    expect(w.n).toBe(40)
    expect(w.wins).toBe(40)
    expect(verdictOf(w)).toBeUndefined()
  })

  it('3. 80 straight wins is won, and the threshold is exactly 71 straight wins', () => {
    const w = winProbability(80, 80)
    // 1 + 7.8792/80 = 1.0985; centre 0.95517; margin 0.04483.
    close(w.lower, 0.9103)
    expect(verdictOf(w)).toBe('won')
    // Decision 4: "won needs at least 71 straight wins". 70 is one short.
    expect(verdictOf(winProbability(71, 71))).toBe('won')
    expect(verdictOf(winProbability(70, 70))).toBeUndefined()
  })

  it('4. at 400 games 380 wins is won but 375 is not', () => {
    const w = winProbability(380, 400)
    // centre (0.95 + 7.8792/800)/(1 + 7.8792/400) = 0.94127; margin about 0.03151.
    close(w.lower, 0.9097)
    close((w.upper - w.lower) / 2, 0.0315)
    expect(verdictOf(w)).toBe('won')
    // 375/400 (p = 0.9375): centre 0.92905, margin 0.03469, lower 0.89436 < 0.90.
    const below = winProbability(375, 400)
    close(below.lower, 0.8944)
    expect(verdictOf(below)).toBeUndefined()
  })

  it('5. lost boundary and the verdict cut-offs', () => {
    const none = winProbability(0, 40)
    // centre = margin = (7.8792/80)/1.19698 = 0.08228, so upper = 0.16456.
    close(none.upper, 0.1646)
    expect(verdictOf(none)).toBe('lost')

    // The measured Roxanne first look: 15 of 40, plan interval [0.198, 0.593].
    const roxanne = winProbability(15, 40)
    close(roxanne.lower, 0.198)
    close(roxanne.upper, 0.593)
    expect(verdictOf(roxanne)).toBeUndefined()

    // lower >= 0.90 is won (inclusive); upper < 0.50 is lost (strict).
    expect(verdictOf({ lower: 0.9, upper: 1 })).toBe('won')
    expect(verdictOf({ lower: 0.1, upper: 0.5 })).toBeUndefined()
    expect(verdictOf({ lower: 0.1, upper: 0.4999 })).toBe('lost')
  })

  it('6. rejects impossible counts', () => {
    expect(() => winProbability(41, 40)).toThrow()
    expect(() => winProbability(1, 0)).toThrow()
    expect(() => winProbability(-1, 10)).toThrow()
    expect(() => winProbability(1.5, 10)).toThrow()
  })

  it('7. sampler stops at the first decisive look and walks the purpose offsets', async () => {
    const scripted = (winsPerBatch: number) => {
      const calls: Array<{ seedOffset: number; games: number }> = []
      const run = async (seedOffset: number, games: number): Promise<number> => {
        calls.push({ seedOffset, games })
        return winsPerBatch
      }
      return { run, calls }
    }

    const always = scripted(40)
    const won = await sampleWinProbability(always.run, 'tuning')
    expect(won.verdict).toBe('won')
    expect(won.looks).toBe(2)
    expect(won.n).toBe(80)
    expect(always.calls.map((c) => c.seedOffset)).toEqual([0, 40_000])
    expect(always.calls.map((c) => c.games)).toEqual([BATCH_GAMES, BATCH_GAMES])

    const never = scripted(0)
    const lost = await sampleWinProbability(never.run, 'tuning')
    expect(lost.verdict).toBe('lost')
    expect(lost.looks).toBe(1)
    // 0 of 40: upper = centre + margin = 0.08228 + 0.08228 = 0.16456 < 0.50.
    close(lost.upper, 0.1646)
    expect(never.calls.map((c) => c.seedOffset)).toEqual([0])

    const middling = scripted(24)
    const uncertain = await sampleWinProbability(middling.run, 'tuning')
    expect(uncertain.verdict).toBe('uncertain')
    expect(uncertain.looks).toBe(10)
    expect(uncertain.n).toBe(400)
    expect(middling.calls.map((c) => c.seedOffset)).toEqual([
      0, 40_000, 80_000, 120_000, 160_000, 200_000, 240_000, 280_000, 320_000, 360_000,
    ])
    expect(middling.calls.map((c) => c.games)).toEqual(Array(10).fill(BATCH_GAMES))

    const report = scripted(24)
    await sampleWinProbability(report.run, 'report')
    expect(report.calls[0]!.seedOffset).toBe(SEED_OFFSET.report)
    expect(report.calls.map((c) => c.seedOffset)).toEqual([
      10_000_000, 10_040_000, 10_080_000, 10_120_000, 10_160_000, 10_200_000, 10_240_000, 10_280_000,
      10_320_000, 10_360_000,
    ])
  })

  it('7b. winsOf adapts a Fitness', () => {
    expect(winsOf({ winRate: 0.525, games: 40 })).toBe(21)
  })

  it('8. seed allocator keeps the tuning and report ranges disjoint', () => {
    expect(battleSeed('tuning', 1)).toBe(1000)
    expect(battleSeed('tuning', 1, 1)).toBe(1001)
    expect(battleSeed('report', 1)).toBe(10_001_000)
    expect(battleSeed('tuning', 9999, 999)).toBe(9_999_999)
    expect(batchSeedOffset('tuning', 0)).toBe(0)
    expect(batchSeedOffset('report', 0)).toBe(10_000_000)
    expect(batchSeedOffset('tuning', 9)).toBe(360_000)
    expect(() => battleSeed('tuning', 0)).toThrow()
    expect(() => battleSeed('tuning', 10_000)).toThrow()
    expect(() => battleSeed('tuning', 1, 1000)).toThrow()
    expect(() => batchSeedOffset('tuning', 10)).toThrow()
  })

  it('9. the real evaluators produce exactly the allocated seeds, disjoint across purposes', async () => {
    const team: Team = [GARCHOMP, MAGIKARP]
    const twoStage = chain('two-stage', [WEAK_FIGHT, WEAK_FIGHT])
    const single = trainer(WEAK_FIGHT)
    const t = 'elite' as const

    const collect = async (run: () => unknown): Promise<number[]> => {
      record.seeds.length = 0
      await run()
      return [...record.seeds]
    }

    const teamSeeds: Record<string, number[]> = {}
    const chainSeeds: Record<string, number[]> = {}
    for (const purpose of ['tuning', 'report'] as const) {
      const teamRun: number[] = []
      const chainRun: number[] = []
      for (let look = 0; look < 10; look++) {
        teamRun.push(
          ...(await collect(() => scoreTeam(data, single, t, team, 40, undefined, batchSeedOffset(purpose, look)))),
        )
        chainRun.push(...(await collect(() => scoreChain(data, twoStage, t, team, 40, undefined, batchSeedOffset(purpose, look)))))
      }
      teamSeeds[purpose] = teamRun
      chainSeeds[purpose] = chainRun
    }

    const expectedTeam = (purpose: 'tuning' | 'report'): number[] =>
      Array.from({ length: 400 }, (_, i) => battleSeed(purpose, i + 1, 0))
    const expectedChain = (purpose: 'tuning' | 'report'): number[] =>
      Array.from({ length: 400 }, (_, i) => [1, 2].map((k) => battleSeed(purpose, i + 1, k))).flat()

    for (const purpose of ['tuning', 'report'] as const) {
      expect(sorted(teamSeeds[purpose]!)).toEqual(sorted(expectedTeam(purpose)))
      expect(sorted(chainSeeds[purpose]!)).toEqual(sorted(expectedChain(purpose)))
      // (c) neither evaluator repeats a seed within its purpose.
      expect(new Set(teamSeeds[purpose]!).size).toBe(teamSeeds[purpose]!.length)
      expect(new Set(chainSeeds[purpose]!).size).toBe(chainSeeds[purpose]!.length)
    }

    // (b) the same evaluator's tuning and report seeds never intersect.
    expect(overlap(teamSeeds.tuning!, teamSeeds.report!)).toEqual([])
    expect(overlap(chainSeeds.tuning!, chainSeeds.report!)).toEqual([])
    expect(Math.min(...teamSeeds.report!)).toBeGreaterThanOrEqual(10_000_000)
    expect(Math.min(...chainSeeds.report!)).toBeGreaterThanOrEqual(10_000_000)
    expect(Math.max(...teamSeeds.tuning!)).toBeLessThan(10_000_000)
    expect(Math.max(...chainSeeds.tuning!)).toBeLessThan(10_000_000)

    // The intersection check itself is not vacuous, and the old scheme collided here:
    // `seedOffset + g` reached 1001 at g = 1001, the chain's stage-1 seed for game 1.
    expect(overlap([1, 2], [2, 3])).toEqual([2])
    expect(overlap([1001], [1001])).toEqual([1001])
  })
})
