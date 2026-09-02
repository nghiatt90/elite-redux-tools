import { displayName } from '../../lib/displayName'
import type { Species } from '../../lib/types'

/** Precomputed search index: one entry per base species, carrying every name a query
 * could reasonably match against -- its own display name plus every one of its
 * (non-standalone) forms' derived display names, so "mega" or "beedrill mega" still
 * surfaces the base even though Mega Beedrill isn't a list entry of its own.
 */
export interface SearchEntry {
  species: Species
  names: string[] // lowercased
}

export function buildSearchIndex(baseSpecies: Species[], allSpecies: Species[]): SearchEntry[] {
  const speciesById = new Map(allSpecies.map((s) => [s.id, s]))
  const formsByBase = new Map<string, Species[]>()
  for (const s of allSpecies) {
    if (!s.isForm || !s.formOf) continue
    const list = formsByBase.get(s.formOf)
    if (list) list.push(s)
    else formsByBase.set(s.formOf, [s])
  }

  return baseSpecies.map((species) => {
    // Every form (standalone or not) inherits its base's raw .name -- "Weedle" for
    // both Weedle and Weedle Redux -- so index the disambiguated display name, not
    // the raw one, or "weedle redux" would only ever rank as a weak substring match.
    const names = new Set<string>([displayName(species, speciesById).toLowerCase()])
    for (const form of formsByBase.get(species.id) ?? []) {
      names.add(displayName(form, speciesById).toLowerCase())
      if (form.longName) names.add(form.longName.toLowerCase())
    }
    return { species, names: [...names] }
  })
}

/** Lower score = better match. Prefix match on the species' own name ranks above a
 * substring match on its own name, which ranks above a match found only via a form's
 * name -- so typing "char" finds Charmander before "Mega Charizard" territory, but
 * "beedrill mega" still finds Beedrill.
 */
export function searchSpecies(index: SearchEntry[], query: string): Species[] {
  const q = query.trim().toLowerCase()
  if (!q) return index.map((e) => e.species)

  const scored: { species: Species; score: number }[] = []
  for (const entry of index) {
    const ownName = entry.names[0]
    let score: number | null = null
    if (ownName.startsWith(q)) score = 0
    else if (ownName.includes(q)) score = 1
    else if (entry.names.some((n) => n.includes(q))) score = 2

    if (score !== null) scored.push({ species: entry.species, score })
  }

  scored.sort((a, b) => a.score - b.score || a.species.nationalDexNum - b.species.nationalDexNum)
  return scored.map((s) => s.species)
}
