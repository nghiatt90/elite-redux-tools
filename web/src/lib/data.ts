import type { Ability, Item, Meta, Move, Species, TypeChart } from './types'

export const DATA_VERSIONS = [
  { id: 'v2.65.5', label: 'v2.65.5' },
  { id: 'v2.65.4.1b', label: 'v2.65.4.1b' },
  { id: 'v2.65beta', label: 'v2.65.3b' },
] as const

export type DataVersion = (typeof DATA_VERSIONS)[number]['id']
export const DEFAULT_DATA_VERSION: DataVersion = 'v2.65.5'

function parseVersion(val: string | null | undefined): DataVersion | null {
  if (!val) return null
  if (val === 'v2.65.3b') return 'v2.65beta'
  if (DATA_VERSIONS.some((v) => v.id === val)) return val as DataVersion
  return null
}

export function resolveInitialVersion(): DataVersion {
  if (typeof window !== 'undefined' && window.location?.search) {
    try {
      const v = new URLSearchParams(window.location.search).get('v')
      const parsed = parseVersion(v)
      if (parsed) return parsed
    } catch {
      // ignore search params error
    }
  }

  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage?.getItem('er-data-version')
      const parsed = parseVersion(stored)
      if (parsed) return parsed
    } catch {
      // ignore localStorage error
    }
  }

  return DEFAULT_DATA_VERSION
}

let currentVersion: DataVersion = resolveInitialVersion()

export function getDataVersion(): DataVersion {
  return currentVersion
}

export function setDataVersion(v: DataVersion): void {
  currentVersion = v
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem('er-data-version', v)
    } catch {
      // ignore localStorage error
    }
  }
}

const spriteOverrides = new Map<DataVersion, Set<string>>()

export function setSpriteOverrides(version: DataVersion, overrides: Iterable<string>): void {
  spriteOverrides.set(version, new Set(overrides))
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

export const loadSpecies = (version: DataVersion = currentVersion) =>
  getJSON<Species[]>(`/data/${version}/species.json`)
export const loadMoves = (version: DataVersion = currentVersion) =>
  getJSON<Move[]>(`/data/${version}/moves.json`)
export const loadAbilities = (version: DataVersion = currentVersion) =>
  getJSON<Ability[]>(`/data/${version}/abilities.json`)
export const loadTypeChart = (version: DataVersion = currentVersion) =>
  getJSON<TypeChart>(`/data/${version}/types.json`)
export const loadItems = (version: DataVersion = currentVersion) =>
  getJSON<Item[]>(`/data/${version}/items.json`)
export const loadMeta = (version: DataVersion = currentVersion) =>
  getJSON<Meta>(`/data/${version}/meta.json`)

export const loadMoveBehaviors = (version: DataVersion = currentVersion) =>
  getJSON<import('./types').MoveBehaviorsFile>(`/data/${version}/moveBehaviors.json`)
export const loadNatures = (version: DataVersion = currentVersion) =>
  getJSON<import('./types').BattleConstants>(`/data/${version}/natures.json`)
export const loadAbilityHooks = (version: DataVersion = currentVersion) =>
  getJSON<import('./types').AbilityHooks>(`/data/${version}/abilityHooks.json`)

export async function loadSpriteOverrides(version: DataVersion = currentVersion): Promise<string[]> {
  try {
    const res = await fetch(`/data/${version}/spriteOverrides.json`)
    if (!res.ok) return []
    return (await res.json()) as string[]
  } catch {
    return []
  }
}

export function spriteUrl(
  speciesId: string,
  variant: 'front' | 'front-shiny' | 'icon' | 'back',
  version: DataVersion = currentVersion,
): string {
  if (version !== 'v2.65.5') {
    const overrides = spriteOverrides.get(version)
    if (overrides?.has(`${speciesId}/${variant}`)) {
      return `/data/${version}/sprites/${speciesId}/${variant}.png`
    }
  }
  return `/data/v2.65.5/sprites/${speciesId}/${variant}.png`
}
