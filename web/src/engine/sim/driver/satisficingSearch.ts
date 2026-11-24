// Satisficing search for one tuning unit (docs/battle-sim/solver-v2-plan.md decisions 6 and 7).
// Fitness is only a screening signal: the search stops at the first build whose tuning verdict
// is `won` and confirms it once on report seeds, never ranking two winning builds. Fragility
// (decision 10, Step 2.3) is not modelled yet, so a `won` verdict is taken as reliable.

import type { SimDataBundle } from './loadSimData'
import { DEFAULT_SEARCH, fitnessValue, neighbours, shuffled, type Fitness, type Team } from './solver'
import {
  SEED_OFFSET,
  sampleWinProbability,
  winsOf,
  type SampledWinProbability,
  type Verdict,
} from './winProbability'

/** Placeholder tuning-game budget per unit (plan decision 7(d); Step 0 sets the real value). */
export const UNIT_CAP = 6000
export const MAX_CONFIRMATIONS = 3
export const SCREEN_GAMES = DEFAULT_SEARCH.screenGames
export const FINALISTS = DEFAULT_SEARCH.finalists
export const MAX_NEIGHBOURS_PER_MEMBER = DEFAULT_SEARCH.maxNeighbours
export const RESCORE_CANDIDATES = 3

/** One unit per evaluator (a fight, or a chain through `scoreChain`); game `g` of a call uses
 * seed `seedOffset + g * 1000`. */
export type UnitEvaluator = (teams: Team[], games: number, seedOffset: number) => Promise<Fitness[]>

export interface TeamDiffEntry {
  member: number
  field: string
  from: unknown
  to: unknown
}

export interface CandidateRecord {
  round: number
  change: TeamDiffEntry[]
  team: Team
  /** `fitnessValue` of the screen: a screening signal only, never an objective. */
  screenFitness: number
  screenGames: number
  tuneVerdict?: Verdict
  tuneWins?: number
  tuneGames?: number
  reportVerdict?: Verdict
  reportWins?: number
  reportGames?: number
}

export interface RoundRecord {
  round: number
  incumbent: Team
  /** Every screened neighbour of the round, in generation order. */
  candidates: CandidateRecord[]
}

export interface UnitSearchResult {
  status: 'won' | 'cap' | 'confirmationsExhausted' | 'noNeighbours'
  /** The reliably-won build, else the best candidate (highest tuning win rate). */
  team: Team
  /** Report-seed result of `team`. */
  report: SampledWinProbability
  startReport: SampledWinProbability
  /** Screening games plus tuning sampler games; report-seed games excluded. */
  tuningGames: number
  /** All report-seed games spent (start, confirmations, re-scoring). */
  reportGames: number
  confirmations: number
  fragilityChecked: false
  rounds: RoundRecord[]
  /** Empty when `status` is `won`. */
  whatToChange: CandidateRecord[]
}

export interface SearchUnitArgs {
  data: SimDataBundle
  start: Team
  evaluate: UnitEvaluator
  allowedStones: ReadonlySet<string>
  wide?: boolean
  /** Injected neighbour generation, so tests need no species data. */
  generate?: (team: Team) => Team[]
  unitCap?: number
  /** Passed through to `sampleWinProbability`. */
  sampler?: { level?: number; batch?: number; maxLooks?: number }
  onProgress?: (message: string) => void
}

const DIFF_FIELDS = ['species', 'ability', 'item', 'nature'] as const

/** Plan decision 9a "team diff": every differing field of a candidate against its incumbent. */
export function teamDiff(before: Team, after: Team): TeamDiffEntry[] {
  const entries: TeamDiffEntry[] = []
  for (let member = 0; member < before.length; member++) {
    const a = before[member]!
    const b = after[member]!
    for (const field of DIFF_FIELDS) {
      if (a[field] !== b[field]) entries.push({ member, field, from: a[field], to: b[field] })
    }
    if (JSON.stringify(a.evs) !== JSON.stringify(b.evs)) entries.push({ member, field: 'evs', from: a.evs, to: b.evs })
    const slots = Math.max(a.moves.length, b.moves.length)
    for (let slot = 0; slot < slots; slot++) {
      const from = a.moves[slot] ?? null
      const to = b.moves[slot] ?? null
      if (from !== to) entries.push({ member, field: `moves[${slot}]`, from, to })
    }
  }
  return entries
}

function tuningRate(record: CandidateRecord): number {
  return record.tuneGames ? (record.tuneWins ?? 0) / record.tuneGames : 0
}

/** The `improveTeam` cap rule (`solver.ts:367-371`) with the round in place of the pass. */
function defaultNeighbours(args: SearchUnitArgs, team: Team, round: number): Team[] {
  const out: Team[] = []
  for (let index = 0; index < team.length; index++) {
    const all = neighbours(args.data, team, index, args.allowedStones, args.wide ?? false)
    out.push(
      ...(all.length > MAX_NEIGHBOURS_PER_MEMBER
        ? shuffled(all, round * 131 + index).slice(0, MAX_NEIGHBOURS_PER_MEMBER)
        : all),
    )
  }
  return out
}

export async function searchUnit(args: SearchUnitArgs): Promise<UnitSearchResult> {
  const cap = args.unitCap ?? UNIT_CAP
  const log = args.onProgress ?? (() => {})
  const runner = (team: Team) => async (seedOffset: number, games: number): Promise<number> =>
    winsOf((await args.evaluate([team], games, seedOffset))[0]!)

  let tuningGames = 0
  let reportGames = 0
  let confirmations = 0
  const rounds: RoundRecord[] = []
  const sampled: Array<{ record: CandidateRecord; report?: SampledWinProbability }> = []

  // (b) The starting build is fixed before any game of this unit, so it is sampled directly on
  // report seeds (decision 5's starting-build exception).
  const startReport = await sampleWinProbability(runner(args.start), 'report', args.sampler)
  reportGames += startReport.n
  if (startReport.verdict === 'won') {
    return {
      status: 'won',
      team: args.start,
      report: startReport,
      startReport,
      tuningGames: 0,
      reportGames,
      confirmations: 0,
      fragilityChecked: false,
      rounds: [],
      whatToChange: [],
    }
  }
  log(`start: report ${startReport.verdict} (${startReport.wins}/${startReport.n})`)

  const finish = async (status: UnitSearchResult['status']): Promise<UnitSearchResult> => {
    const ranked = [...sampled].sort((a, b) => tuningRate(b.record) - tuningRate(a.record))
    const rescored = ranked.slice(0, RESCORE_CANDIDATES)
    for (const entry of rescored) {
      if (entry.report) continue
      const report = await sampleWinProbability(runner(entry.record.team), 'report', args.sampler)
      reportGames += report.n
      entry.report = report
      entry.record.reportVerdict = report.verdict
      entry.record.reportWins = report.wins
      entry.record.reportGames = report.n
    }
    const best = rescored[0]
    return {
      status,
      team: best?.record.team ?? args.start,
      report: best?.report ?? startReport,
      startReport,
      tuningGames,
      reportGames,
      confirmations,
      fragilityChecked: false,
      rounds,
      whatToChange: rescored.map((entry) => entry.record),
    }
  }

  let incumbent = args.start
  for (let round = 0; ; round++) {
    // The screen is checked against the cap below, so it never overshoots; only a single finalist
    // sampler run (at most 400 games) can (plan decision 7(d)).
    if (tuningGames >= cap) return finish('cap')
    const generated = args.generate ? args.generate(incumbent) : defaultNeighbours(args, incumbent, round)
    if (generated.length === 0) return finish('noNeighbours')
    if (tuningGames + generated.length * SCREEN_GAMES > cap) return finish('cap')

    const fits = await args.evaluate(generated, SCREEN_GAMES, SEED_OFFSET.tuning)
    tuningGames += generated.length * SCREEN_GAMES
    const records: CandidateRecord[] = generated.map((team, i) => ({
      round,
      change: teamDiff(incumbent, team),
      team,
      screenFitness: fitnessValue(fits[i]!),
      screenGames: SCREEN_GAMES,
    }))
    rounds.push({ round, incumbent, candidates: records })

    // Decision 7(c): order by screen fitness only (no incumbent-screen filter); ties keep
    // generation order.
    const finalists = records
      .map((record, i) => ({ record, i }))
      .sort((a, b) => b.record.screenFitness - a.record.screenFitness || a.i - b.i)
      .slice(0, FINALISTS)
    log(`round ${round}: ${generated.length} screened, ${finalists.length} finalists`)

    for (const { record } of finalists) {
      if (tuningGames >= cap) return finish('cap')
      const tune = await sampleWinProbability(runner(record.team), 'tuning', args.sampler)
      tuningGames += tune.n
      record.tuneVerdict = tune.verdict
      record.tuneWins = tune.wins
      record.tuneGames = tune.n
      const entry: { record: CandidateRecord; report?: SampledWinProbability } = { record }
      sampled.push(entry)
      if (tune.verdict !== 'won') continue
      confirmations++
      const report = await sampleWinProbability(runner(record.team), 'report', args.sampler)
      reportGames += report.n
      entry.report = report
      record.reportVerdict = report.verdict
      record.reportWins = report.wins
      record.reportGames = report.n
      if (report.verdict === 'won') {
        return {
          status: 'won',
          team: record.team,
          report,
          startReport,
          tuningGames,
          reportGames,
          confirmations,
          fragilityChecked: false,
          rounds,
          whatToChange: [],
        }
      }
      // Decision 7(c): at most MAX_CONFIRMATIONS report-seed confirmations per unit; the third
      // failure ends the search rather than spending more screening and tuning rounds.
      if (confirmations >= MAX_CONFIRMATIONS) return finish('confirmationsExhausted')
    }

    let next = finalists[0]!.record
    for (const { record } of finalists) if (tuningRate(record) > tuningRate(next)) next = record
    incumbent = next.team
  }
}
