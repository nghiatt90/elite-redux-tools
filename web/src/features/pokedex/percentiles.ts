import type { BaseStats, Species } from '../../lib/types'
import { bst } from './filters'

export type StatKey = keyof BaseStats | 'bst'

export type PercentileIndex = Record<StatKey, number[]> // sorted ascending

export function buildPercentileIndex(species: Species[]): PercentileIndex {
  const keys: StatKey[] = ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe', 'bst']
  const index = {} as PercentileIndex
  for (const key of keys) {
    const values = species.map((s) => (key === 'bst' ? bst(s.baseStats) : s.baseStats[key]))
    values.sort((a, b) => a - b)
    index[key] = values
  }
  return index
}

/** % of the population this value is greater than or equal to. */
export function percentileOf(index: PercentileIndex, key: StatKey, value: number): number {
  const values = index[key]
  // first index where values[i] > value -- everything before it is <= value
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return Math.round((lo / values.length) * 100)
}
