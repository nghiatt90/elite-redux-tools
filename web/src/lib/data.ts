import type { Ability, Item, Meta, Move, Species, TypeChart } from './types'

// Matches sources.lock.json's game_version and web/package.json's sync-data script,
// which copies data/<version>/ to public/data/<version>/ before dev/build.
const DATA_VERSION = 'v2.65beta'
const BASE = `/data/${DATA_VERSION}`

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

export const loadSpecies = () => getJSON<Species[]>(`${BASE}/species.json`)
export const loadMoves = () => getJSON<Move[]>(`${BASE}/moves.json`)
export const loadAbilities = () => getJSON<Ability[]>(`${BASE}/abilities.json`)
export const loadTypeChart = () => getJSON<TypeChart>(`${BASE}/types.json`)
export const loadItems = () => getJSON<Item[]>(`${BASE}/items.json`)
export const loadMeta = () => getJSON<Meta>(`${BASE}/meta.json`)

export function spriteUrl(speciesId: string, variant: 'front' | 'front-shiny' | 'icon' | 'back') {
  return `${BASE}/sprites/${speciesId}/${variant}.png`
}
