import type { Species } from '../../lib/types'

/** Precomputed search index: one entry per base species, carrying every name a query
 * could reasonably match against -- its own name plus any of its forms' longNames
 * (e.g. searching "Mega" or "Deoxys Attack" should surface the base species, since
 * that's the only entry shown in the primary list; see PokedexList's grouping note).
 * Forms almost always share their base's exact display name (form_of inherits dex
 * info), so the only place a form contributes a genuinely new search term is via its
 * own longName.
 */
export interface SearchEntry {
  species: Species
  names: string[] // lowercased
}

export function buildSearchIndex(baseSpecies: Species[], allSpecies: Species[]): SearchEntry[] {
  const formsByBase = new Map<string, Species[]>()
  for (const s of allSpecies) {
    if (!s.isForm || !s.formOf) continue
    const list = formsByBase.get(s.formOf)
    if (list) list.push(s)
    else formsByBase.set(s.formOf, [s])
  }

  return baseSpecies.map((species) => {
    const names = new Set<string>([species.name.toLowerCase()])
    for (const form of formsByBase.get(species.id) ?? []) {
      if (form.longName) names.add(form.longName.toLowerCase())
    }
    return { species, names: [...names] }
  })
}

/** Lower score = better match. Prefix match on the species' own name ranks above a
 * substring match on its own name, which ranks above a match found only via a form's
 * longName -- so typing "char" finds Charmander before "Mega Charizard" territory,
 * but "deoxys attack" still finds Deoxys.
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
