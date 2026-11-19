// Win probability and seed allocation for the satisficing solver
// (docs/battle-sim/solver-v2-plan.md decisions 4 and 5).
//
// One sampler run is a sequence of independent batches on purpose-scoped seeds.
// Each look uses a Bonferroni-corrected per-look level (0.005, z about 2.81) so the
// overall error over up to 10 looks stays at or below 5%.

import { wilsonInterval } from './wilson'

export const PER_LOOK_LEVEL = 0.005
export const BATCH_GAMES = 40
export const MAX_LOOKS = 10
export const WON_LOWER = 0.9
export const LOST_UPPER = 0.5

const A = [
  -3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.38357751867269e+02,
  -3.066479806614716e+01, 2.506628277459239e+00,
]
const B = [
  -5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01,
  -1.328068155288572e+01,
]
const C = [
  -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00,
  4.374664141464968e+00, 2.938163982698783e+00,
]
const D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
const P_LOW = 0.02425

/** Two-sided normal quantile: `z` with `P(|Z| > z) = level` (Acklam's approximation,
 * accurate to about 1e-9). */
export function zForLevel(level: number): number {
  if (!(level > 0 && level < 1)) throw new Error(`zForLevel requires 0 < level < 1, got ${level}`)
  const p = 1 - level / 2
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
      ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1)
    )
  }
  if (p <= 1 - P_LOW) {
    const q = p - 0.5
    const r = q * q
    return (
      ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) /
      (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1)
    )
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) /
    ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1)
  )
}

export interface WinProbability {
  p: number
  lower: number
  upper: number
  level: number
  n: number
  wins: number
}

/** Wilson interval for `wins` of `n` at the two-sided `level`. */
export function winProbability(wins: number, n: number, level: number = PER_LOOK_LEVEL): WinProbability {
  if (!Number.isInteger(wins) || !Number.isInteger(n)) throw new Error('winProbability requires integer wins and n')
  if (n <= 0) throw new Error('winProbability requires n > 0')
  if (wins < 0 || wins > n) throw new Error(`winProbability requires 0 <= wins <= ${n}, got ${wins}`)
  const { lower, upper } = wilsonInterval(wins, n, zForLevel(level))
  return { p: wins / n, lower, upper, level, n, wins }
}

export type Verdict = 'won' | 'lost' | 'uncertain'

/** Decision 4's stopping rule: `won` iff the corrected lower end is at least 0.90,
 * `lost` iff the corrected upper end is below 0.50, else undecided. */
export function verdictOf(interval: { lower: number; upper: number }): Verdict | undefined {
  if (interval.lower >= WON_LOWER) return 'won'
  if (interval.upper < LOST_UPPER) return 'lost'
  return undefined
}

export type SeedPurpose = 'tuning' | 'report'

/** Tuning and report ranges are disjoint by construction: tuning seeds are below
 * 10,000,000, report seeds at or above it (decision 5). */
export const SEED_OFFSET: Record<SeedPurpose, number> = { tuning: 0, report: 10_000_000 }

/** Battle seed for game `g` (`1..9999`) and chain stage `k` (`0..999`; singles use 0). */
export function battleSeed(purpose: SeedPurpose, g: number, k = 0): number {
  if (!Number.isInteger(g) || g < 1 || g >= 10_000) throw new Error(`battleSeed requires integer 1 <= g < 10000, got ${g}`)
  if (!Number.isInteger(k) || k < 0 || k >= 1000) throw new Error(`battleSeed requires integer 0 <= k < 1000, got ${k}`)
  return SEED_OFFSET[purpose] + g * 1000 + k
}

/** Offset a caller passes as `seedOffset` so that look `b` covers games `40b + 1 .. 40b + 40`. */
export function batchSeedOffset(purpose: SeedPurpose, look: number): number {
  if (!Number.isInteger(look) || look < 0 || look >= MAX_LOOKS)
    throw new Error(`batchSeedOffset requires integer 0 <= look < ${MAX_LOOKS}, got ${look}`)
  return SEED_OFFSET[purpose] + look * BATCH_GAMES * 1000
}

export type BatchRunner = (seedOffset: number, games: number) => Promise<number>

export interface SampledWinProbability extends WinProbability {
  verdict: Verdict
  looks: number
}

/** Sequential sampler: look after every batch, stop at the first decisive interval
 * (decision 4). A run that is never decisive returns `uncertain` after `maxLooks`. */
export async function sampleWinProbability(
  run: BatchRunner,
  purpose: SeedPurpose,
  options?: { level?: number; batch?: number; maxLooks?: number },
): Promise<SampledWinProbability> {
  const level = options?.level ?? PER_LOOK_LEVEL
  const batch = options?.batch ?? BATCH_GAMES
  const maxLooks = options?.maxLooks ?? MAX_LOOKS
  let wins = 0
  let n = 0
  let last: WinProbability | undefined
  for (let look = 0; look < maxLooks; look++) {
    wins += await run(batchSeedOffset(purpose, look), batch)
    n = batch * (look + 1)
    last = winProbability(wins, n, level)
    const verdict = verdictOf(last)
    if (verdict !== undefined) return { ...last, verdict, looks: look + 1 }
  }
  return { ...last!, verdict: 'uncertain', looks: maxLooks }
}

/** Wins a `Fitness` recorded, for feeding a sampler. */
export function winsOf(f: { winRate: number; games: number }): number {
  return Math.round(f.winRate * f.games)
}
