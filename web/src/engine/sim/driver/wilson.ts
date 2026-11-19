export interface WilsonInterval {
  lower: number
  upper: number
}

/** Wilson score interval for `wins` of `n`; `z` is the normal quantile for the per-look level. */
export function wilsonInterval(wins: number, n: number, z: number): WilsonInterval {
  if (n <= 0) throw new Error('wilsonInterval requires n > 0')
  const p = wins / n
  const z2 = z * z
  const denominator = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator
  return { lower: centre - margin, upper: centre + margin }
}
