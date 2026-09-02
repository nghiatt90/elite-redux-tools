import type { Species } from './types'

/** Redux forms are Elite Redux's marquee feature -- full standalone mons with their
 * own evolution lines (verified: SPECIES_WEEDLE_REDUX -> SPECIES_KAKUNA_REDUX at Lv.
 * 7, not just a cosmetic reskin), not a temporary/cosmetic variant like a mega or a
 * regional form. The game's own `region_prefix` field is meant to flag this but is
 * inconsistently set (57 of 166 verified Redux-suffixed species have it unset), so
 * the id's own "_REDUX" suffix is the reliable signal, not that field.
 *
 * Deliberately only the bare "_REDUX" suffix, not every id containing REDUX --
 * compound forms like "_MEGA_REDUX"/"_REDUX_MEGA" are still temporary battle
 * transformations of some base mon (per the data, of the plain base, not of the
 * Redux mon -- they don't nest under it), so they stay treated as ordinary forms.
 */
export function isReduxForm(speciesId: string): boolean {
  return speciesId.endsWith('_REDUX')
}

/** Redux forms inherit their base species' plain dex name (the game's own dex text
 * has no separate entry for them), so every Redux form would otherwise display
 * identically to its base -- "Weedle" for both Weedle and Weedle Redux. Use this
 * instead of `species.name` anywhere a Redux form might appear as its own entry
 * (list rows, detail headers, search, evolution chains) so it reads as the distinct
 * mon it actually is.
 */
export function displayName(species: Species): string {
  return isReduxForm(species.id) ? `${species.name} Redux` : species.name
}
