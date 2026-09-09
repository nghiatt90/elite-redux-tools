import type { Species } from '../../lib/types'
import { TYPE_COLORS } from '../../lib/typeColors'

export type TypeFilterState = 'include' | 'exclude'

export type StatKey = 'hp' | 'atk' | 'def' | 'spatk' | 'spdef' | 'spe' | 'bst'
export const STAT_KEYS: StatKey[] = ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe', 'bst']
export const STAT_LABELS: Record<StatKey, string> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spatk: 'SpA',
  spdef: 'SpD',
  spe: 'Spe',
  bst: 'BST',
}

export interface FilterState {
  types: Partial<Record<string, TypeFilterState>> // bare type name -> state
  statMin: Partial<Record<StatKey, number>> // present = "at least" bound enabled
  statMax: Partial<Record<StatKey, number>> // present = "at most" bound enabled
  abilityOrInnate: string[] // AbilityEnum ids; AND across selections (see applyFilters)
  moves: string[] // MoveEnum ids; AND across selections
}

export const EMPTY_FILTERS: FilterState = { types: {}, statMin: {}, statMax: {}, abilityOrInnate: [], moves: [] }

// Mystery and Stellar exist in the raw data (Terapagos/Stellar, the move
// Present/Mystery) but aren't real gameplay types the user wants surfaced as filter
// options right now -- picker-only exclusion, TypeChip/typeColors are untouched so
// those two still render correctly wherever they actually show up.
export const ALL_TYPES = Object.keys(TYPE_COLORS).filter((t) => t !== 'MYSTERY' && t !== 'STELLAR')

export function filtersFromSearchParams(params: URLSearchParams): FilterState {
  const types: FilterState['types'] = {}
  for (const t of params.getAll('type+')) types[t] = 'include'
  for (const t of params.getAll('type-')) types[t] = 'exclude'

  const statMin: FilterState['statMin'] = {}
  const statMax: FilterState['statMax'] = {}
  for (const key of STAT_KEYS) {
    const rawMin = params.get(`min_${key}`)
    if (rawMin && !Number.isNaN(Number(rawMin))) statMin[key] = Number(rawMin)
    const rawMax = params.get(`max_${key}`)
    if (rawMax && !Number.isNaN(Number(rawMax))) statMax[key] = Number(rawMax)
  }

  return {
    types,
    statMin,
    statMax,
    abilityOrInnate: params.getAll('ability'),
    moves: params.getAll('move'),
  }
}

export function filtersToSearchParams(filters: FilterState, existing: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(existing)
  params.delete('type+')
  params.delete('type-')
  for (const [type, state] of Object.entries(filters.types)) {
    if (state === 'include') params.append('type+', type)
    if (state === 'exclude') params.append('type-', type)
  }
  for (const key of STAT_KEYS) {
    const min = filters.statMin[key]
    if (min !== undefined) params.set(`min_${key}`, String(min))
    else params.delete(`min_${key}`)
    const max = filters.statMax[key]
    if (max !== undefined) params.set(`max_${key}`, String(max))
    else params.delete(`max_${key}`)
  }
  params.delete('ability')
  for (const id of filters.abilityOrInnate) params.append('ability', id)
  params.delete('move')
  for (const id of filters.moves) params.append('move', id)
  return params
}

function bareType(t: string) {
  return t.startsWith('TYPE_') ? t.slice(5) : t
}

export function bst(stats: Species['baseStats']) {
  return stats.hp + stats.atk + stats.def + stats.spatk + stats.spdef + stats.spe
}

export function applyFilters(species: Species[], filters: FilterState): Species[] {
  const includeTypes = Object.entries(filters.types).filter(([, s]) => s === 'include').map(([t]) => t)
  const excludeTypes = Object.entries(filters.types).filter(([, s]) => s === 'exclude').map(([t]) => t)

  return species.filter((s) => {
    const types = s.types.map(bareType)
    if (includeTypes.some((t) => !types.includes(t))) return false
    if (excludeTypes.some((t) => types.includes(t))) return false

    const totalBst = bst(s.baseStats)
    for (const key of ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe'] as const) {
      const min = filters.statMin[key]
      if (min !== undefined && s.baseStats[key] < min) return false
      const max = filters.statMax[key]
      if (max !== undefined && s.baseStats[key] > max) return false
    }
    if (filters.statMin.bst !== undefined && totalBst < filters.statMin.bst) return false
    if (filters.statMax.bst !== undefined && totalBst > filters.statMax.bst) return false

    // Ability and innate are the same kind of thing to a player filtering by name --
    // one combined pool, AND across every selected id (must carry all of them,
    // somewhere across its up-to-3 abilities + up-to-3 innates).
    if (filters.abilityOrInnate.length > 0) {
      const pool = new Set([...s.abilities, ...s.innates])
      if (!filters.abilityOrInnate.every((id) => pool.has(id))) return false
    }

    // "Learns" covers both level-up and tutor moves; AND across every selected move.
    if (filters.moves.length > 0) {
      const learned = new Set([
        ...s.learnset.levelUp.flatMap((entry) => entry.moves),
        ...s.learnset.tutor,
      ])
      if (!filters.moves.every((id) => learned.has(id))) return false
    }

    return true
  })
}

export function isEmpty(filters: FilterState) {
  return (
    Object.keys(filters.types).length === 0 &&
    Object.keys(filters.statMin).length === 0 &&
    Object.keys(filters.statMax).length === 0 &&
    filters.abilityOrInnate.length === 0 &&
    filters.moves.length === 0
  )
}
