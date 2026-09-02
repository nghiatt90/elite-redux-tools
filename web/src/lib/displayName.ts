import type { Species } from './types'

/** Form categories treated as full standalone mons rather than a cosmetic/temporary
 * variant of a base species -- verified each carries its own independent evolution
 * line (Weedle Redux -> Kakuna Redux at Lv. 7, not shared with plain Weedle's chain;
 * Vulpix Alolan -> Ninetales Alolan; Meowth Galarian -> Perrserker, a different final
 * evolution than plain Meowth's line entirely), not just a different sprite/type on
 * the same mon.
 *
 * The game's own `region_prefix` field is meant to flag regional forms but is
 * inconsistently set (e.g. 57 of 166 Redux-suffixed species have it unset), so the
 * id's own suffix is the reliable signal, not that field.
 */
const STANDALONE_FORM_SUFFIXES = ['REDUX', 'ALOLAN', 'GALARIAN', 'HISUIAN', 'PALDEAN']

/** Requires the id's entire remainder after "<formOf>_" to be exactly one of the
 * suffixes above, not merely end with one. A plain `.endsWith()` check on the id
 * alone -- what this used to do -- incorrectly promoted compound forms like
 * SPECIES_BEEDRILL_MEGA_REDUX (remainder "MEGA_REDUX", still ends in "_REDUX") to a
 * standalone entry too, producing a second "Beedrill Redux" indistinguishable from
 * the real SPECIES_BEEDRILL_REDUX -- caught by checking for duplicate display names
 * across the whole dataset, not just spot-checking a few species by hand. Those
 * compound forms are still temporary battle transformations of the plain base (per
 * the data they point `formOf` straight at it, not at the standalone form), so they
 * correctly stay ordinary forms once the remainder is checked exactly.
 */
function standaloneFormSuffix(species: Species): string | null {
  if (!species.formOf || !species.id.startsWith(`${species.formOf}_`)) return null
  const remainder = species.id.slice(species.formOf.length + 1)
  return STANDALONE_FORM_SUFFIXES.includes(remainder) ? remainder : null
}

export function isStandaloneForm(species: Species): boolean {
  return standaloneFormSuffix(species) !== null
}

/** These forms inherit their base species' plain dex name (the game's own dex text
 * has no separate entry for them), so every one would otherwise display identically
 * to its base -- "Weedle" for both Weedle and Weedle Redux, "Vulpix" for both Vulpix
 * and Vulpix Alolan. Use this instead of `species.name` anywhere a standalone form
 * might appear as its own entry (list rows, detail headers, search, evolution
 * chains) so it reads as the distinct mon it actually is.
 */
export function displayName(species: Species): string {
  const suffix = standaloneFormSuffix(species)
  if (!suffix) return species.name
  const word = suffix.charAt(0) + suffix.slice(1).toLowerCase()
  return `${species.name} ${word}`
}
