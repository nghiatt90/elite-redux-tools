import type { Species } from './types'

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((x) => setB.has(x))
}

function learnsetMoves(species: Species): string[] {
  return [...species.learnset.levelUp.flatMap((e) => e.moves), ...species.learnset.tutor]
}

/** A form is "standalone" -- distinct enough to deserve its own list entry and
 * detail page, cross-linked from its base rather than buried as a mere variant of
 * it -- exactly when it differs from its base in abilities/innates OR learnset.
 * A form that's mechanically identical to its base (same moves, same abilities --
 * verified 83 of 777 forms in the current data are exactly this: a pure
 * appearance/palette variant with no gameplay difference) stays grouped under its
 * base, reachable via the Other Forms section instead of getting a redundant
 * separate row. This replaced an earlier id-suffix heuristic (only Redux/regional
 * forms) that both missed real differences (most megas change their ability
 * entirely -- 268 of 269) and one real false positive (a mega-of-Redux compound id
 * happens to end the same way a bare Redux id does).
 */
export function isStandaloneForm(species: Species, speciesById: Map<string, Species>): boolean {
  if (!species.isForm || !species.formOf) return false
  const base = speciesById.get(species.formOf)
  if (!base) return true // can't compare -- treat as standalone rather than silently hide it

  const abilitiesSame = sameSet(species.abilities, base.abilities) && sameSet(species.innates, base.innates)
  const learnsetSame = sameSet(learnsetMoves(species), learnsetMoves(base))
  return !(abilitiesSame && learnsetSame)
}

/** Derives a human label for a form by stripping its base's id prefix off its own id
 * and title-casing the remainder, e.g. SPECIES_CHARIZARD_MEGA_X minus
 * SPECIES_CHARIZARD -> "Mega X", SPECIES_WEEDLE_REDUX -> "Redux". Forms almost never
 * have their own longName (2 of 166 Redux forms do) or dex name (form_of inherits
 * the base's plain dex text), so there's no game-provided text to use instead.
 */
function labelFromId(formId: string, baseId: string, baseName: string): string {
  const suffix = formId.startsWith(`${baseId}_`) ? formId.slice(baseId.length + 1) : formId
  const words = suffix
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
  return `${baseName} ${words}`
}

/** Every form would otherwise display identically to its base -- "Weedle" for both
 * Weedle and Weedle Redux -- so any form (standalone or not) needs this instead of
 * `species.name` wherever it might appear as its own entry or chip: list rows,
 * detail headers, search, evolution chains, the Other Forms section.
 */
export function displayName(species: Species, speciesById: Map<string, Species>): string {
  if (!species.isForm || !species.formOf) return species.name
  const base = speciesById.get(species.formOf)
  if (!base) return species.name
  return labelFromId(species.id, species.formOf, base.name)
}
