import { displayName } from '../../lib/displayName'
import type { Species } from '../../lib/types'
import { bst, STAT_LABELS, type StatKey } from './filters'

export type SortKey = 'dexNo' | 'internalId' | 'name' | StatKey
export type SortDirection = 'asc' | 'desc'

export interface SortState {
  key: SortKey
  direction: SortDirection
}

// Dex No ascending is the baseline -- it's also what the list already shows with no
// sort applied (species come in dex order), so this is a no-op until you pick
// something else or flip the direction.
export const DEFAULT_SORT: SortState = { key: 'dexNo', direction: 'asc' }

export const SORT_KEYS: SortKey[] = ['dexNo', 'internalId', 'name', 'bst', 'hp', 'atk', 'def', 'spatk', 'spdef', 'spe']

export const SORT_LABELS: Record<SortKey, string> = {
  dexNo: 'Dex No',
  internalId: 'Internal ID',
  name: 'Name',
  ...STAT_LABELS,
}

export function sortFromSearchParams(params: URLSearchParams): SortState {
  const key = params.get('sort')
  if (!key || !SORT_KEYS.includes(key as SortKey)) return DEFAULT_SORT
  const direction = params.get('dir') === 'desc' ? 'desc' : 'asc'
  return { key: key as SortKey, direction }
}

export function sortToSearchParams(sort: SortState, existing: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(existing)
  if (sort.key === DEFAULT_SORT.key && sort.direction === DEFAULT_SORT.direction) {
    params.delete('sort')
    params.delete('dir')
  } else {
    params.set('sort', sort.key)
    params.set('dir', sort.direction)
  }
  return params
}

function sortValue(species: Species, key: SortKey, speciesById: Map<string, Species>): number | string {
  switch (key) {
    case 'dexNo':
      return species.nationalDexNum
    case 'internalId':
      return species.speciesNum
    case 'name':
      // Compare the name actually shown in the list, not the raw (possibly
      // shared-with-base) species.name -- see displayName()/search.ts.
      return displayName(species, speciesById).toLowerCase()
    case 'bst':
      return bst(species.baseStats)
    default:
      return species.baseStats[key]
  }
}

/** Applies the active sort on top of whatever order `species` already came in
 * (search relevance, then dex number -- see search.ts). A stable sort so ties
 * (e.g. two species with the same stat value) keep that prior relative order
 * instead of shuffling on every recompute -- notably, the default dexNo/asc sort
 * is then a genuine no-op against an unsearched list, since it's already in that
 * order. */
export function applySort(species: Species[], sort: SortState, speciesById: Map<string, Species>): Species[] {
  const dir = sort.direction === 'desc' ? -1 : 1

  return species
    .map((s, index) => ({ s, index }))
    .sort((a, b) => {
      const av = sortValue(a.s, sort.key, speciesById)
      const bv = sortValue(b.s, sort.key, speciesById)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return a.index - b.index // stable tiebreak
    })
    .map(({ s }) => s)
}
