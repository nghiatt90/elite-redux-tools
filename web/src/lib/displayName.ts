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
 *
 * Checking a bare `_SUFFIX` ending (not "contains") deliberately excludes compound
 * forms like "_HISUIAN_MEGA" or "_REDUX_MEGA" -- those are still temporary battle
 * transformations of the standalone form, and per the data don't even nest under it
 * (they point `formOf` at the plain base), so they stay ordinary forms.
 */
const STANDALONE_FORM_SUFFIXES = ['REDUX', 'ALOLAN', 'GALARIAN', 'HISUIAN', 'PALDEAN']

function standaloneFormSuffix(speciesId: string): string | null {
  for (const suffix of STANDALONE_FORM_SUFFIXES) {
    if (speciesId.endsWith(`_${suffix}`)) return suffix
  }
  return null
}

export function isStandaloneForm(speciesId: string): boolean {
  return standaloneFormSuffix(speciesId) !== null
}

/** These forms inherit their base species' plain dex name (the game's own dex text
 * has no separate entry for them), so every one would otherwise display identically
 * to its base -- "Weedle" for both Weedle and Weedle Redux, "Vulpix" for both Vulpix
 * and Vulpix Alolan. Use this instead of `species.name` anywhere a standalone form
 * might appear as its own entry (list rows, detail headers, search, evolution
 * chains) so it reads as the distinct mon it actually is.
 */
export function displayName(species: Species): string {
  const suffix = standaloneFormSuffix(species.id)
  if (!suffix) return species.name
  const word = suffix.charAt(0) + suffix.slice(1).toLowerCase()
  return `${species.name} ${word}`
}
