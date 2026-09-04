import type { AcceptSetOptions, SearchModes } from '../../lib/randomizer'

// All the toggles default to "on"/true, so the URL only needs to carry the
// exceptions -- omitted means true, "0" means false. Matches the compact style of
// features/pokedex/filters.ts.
function boolParam(params: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = params.get(key)
  return raw === null ? fallback : raw !== '0'
}

function setBoolParam(params: URLSearchParams, key: string, value: boolean, fallback: boolean): void {
  if (value === fallback) params.delete(key)
  else params.set(key, value ? '1' : '0')
}

export function acceptOptionsFromParams(params: URLSearchParams): AcceptSetOptions {
  return {
    compounds: boolParam(params, 'compounds', true),
    exactGroups: boolParam(params, 'exact', true),
    curatedGroups: boolParam(params, 'curated', true),
  }
}

export function acceptOptionsToParams(options: AcceptSetOptions, existing: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(existing)
  setBoolParam(params, 'compounds', options.compounds, true)
  setBoolParam(params, 'exact', options.exactGroups, true)
  setBoolParam(params, 'curated', options.curatedGroups, true)
  return params
}

export function modesFromParams(params: URLSearchParams): SearchModes {
  return {
    abilityRandomized: boolParam(params, 'abilityMode', true),
    innateRandomized: boolParam(params, 'innateMode', true),
  }
}

export function modesToParams(modes: SearchModes, existing: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(existing)
  setBoolParam(params, 'abilityMode', modes.abilityRandomized, true)
  setBoolParam(params, 'innateMode', modes.innateRandomized, true)
  return params
}

export function lockedAbilitiesFromParams(params: URLSearchParams): string[] {
  return params.getAll('ability').slice(0, 4)
}

export function lockedAbilitiesToParams(ids: string[], existing: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(existing)
  params.delete('ability')
  for (const id of ids) params.append('ability', id)
  return params
}
