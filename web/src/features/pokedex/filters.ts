import type { Species } from '../../lib/types'
import { TYPE_COLORS } from '../../lib/typeColors'

export type TypeFilterState = 'include' | 'exclude'

export interface FilterState {
  types: Partial<Record<string, TypeFilterState>> // bare type name -> state
  statMin: Partial<Record<'hp' | 'atk' | 'def' | 'spatk' | 'spdef' | 'spe' | 'bst', number>>
  ability: string // display name, empty = no filter
  innate: string
}

export const EMPTY_FILTERS: FilterState = { types: {}, statMin: {}, ability: '', innate: '' }
export const ALL_TYPES = Object.keys(TYPE_COLORS)

export function filtersFromSearchParams(params: URLSearchParams): FilterState {
  const types: FilterState['types'] = {}
  for (const t of params.getAll('type+')) types[t] = 'include'
  for (const t of params.getAll('type-')) types[t] = 'exclude'

  const statMin: FilterState['statMin'] = {}
  for (const key of ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe', 'bst'] as const) {
    const raw = params.get(`min_${key}`)
    if (raw && !Number.isNaN(Number(raw))) statMin[key] = Number(raw)
  }

  return {
    types,
    statMin,
    ability: params.get('ability') ?? '',
    innate: params.get('innate') ?? '',
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
  for (const key of ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe', 'bst'] as const) {
    const v = filters.statMin[key]
    if (v) params.set(`min_${key}`, String(v))
    else params.delete(`min_${key}`)
  }
  if (filters.ability) params.set('ability', filters.ability)
  else params.delete('ability')
  if (filters.innate) params.set('innate', filters.innate)
  else params.delete('innate')
  return params
}

function bareType(t: string) {
  return t.startsWith('TYPE_') ? t.slice(5) : t
}

export function bst(stats: Species['baseStats']) {
  return stats.hp + stats.atk + stats.def + stats.spatk + stats.spdef + stats.spe
}

export function applyFilters(
  species: Species[],
  filters: FilterState,
  resolveAbilityName: (id: string) => string,
): Species[] {
  const includeTypes = Object.entries(filters.types).filter(([, s]) => s === 'include').map(([t]) => t)
  const excludeTypes = Object.entries(filters.types).filter(([, s]) => s === 'exclude').map(([t]) => t)
  const ability = filters.ability.toLowerCase()
  const innate = filters.innate.toLowerCase()

  return species.filter((s) => {
    const types = s.types.map(bareType)
    if (includeTypes.some((t) => !types.includes(t))) return false
    if (excludeTypes.some((t) => types.includes(t))) return false

    for (const key of ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe'] as const) {
      const min = filters.statMin[key]
      if (min && s.baseStats[key] < min) return false
    }
    if (filters.statMin.bst && bst(s.baseStats) < filters.statMin.bst) return false

    if (ability && !s.abilities.some((id) => resolveAbilityName(id).toLowerCase() === ability)) {
      return false
    }
    if (innate && !s.innates.some((id) => resolveAbilityName(id).toLowerCase() === innate)) {
      return false
    }

    return true
  })
}

export function isEmpty(filters: FilterState) {
  return (
    Object.keys(filters.types).length === 0 &&
    Object.keys(filters.statMin).length === 0 &&
    !filters.ability &&
    !filters.innate
  )
}
