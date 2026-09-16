// Battle-sim plan, step 2 (docs/battle-sim/plan.md) -- Mega Evolution and Primal/
// Origin/Crowned form resolution: given a species and the item it holds, what form
// does it become mid-battle? Nothing consumes this yet (that's deliberate -- see the
// plan); it's the lookup the turn loop (step 3) and the AI policy (step 4) will need
// once a battle runs past turn one. The damage calculator and the matchup report are
// both unaffected: the former is species-driven (the user picks the mega species
// directly), the latter is turn-one-only and the AI hasn't transformed yet
// (matchupReport.ts's own MATCHUP_REPORT_CAVEATS).
//
// The resolution rule, read from the schema rather than assumed: it's the FORM's own
// species.json entry that carries the (base species, trigger) pairs that produce it,
// not the other way around.
//
//   - `Species.mega` (er-config/SpeciesList.proto:175, `MegaEvolution` message at
//     :50-67) is a `from` species plus a `oneof evo_using { item | move }`. Almost
//     every mega triggers on a held item, but the schema allows a move trigger too --
//     the one example in the whole species list is SPECIES_RAYQUAZA_MEGA, whose sole
//     `megas[]` entry has `move: "MOVE_DRAGON_ASCENT"` and no `item` key at all. It
//     does not appear in any of the battle-sim's 40 target fights (see
//     docs/battle-sim/boss-fight-coverage.md), so this module resolves the item-
//     triggered edge only and leaves the move-triggered one unreachable (see
//     `buildFormIndex`'s own doc).
//   - `Species.primal` (SpeciesList.proto:176, `PrimalEvolution` message at :69-80)
//     has no `oneof` at all -- `item` is a plain field, so every Primal/Origin/Crowned
//     form (`primalType` one of PRIMAL/ORIGIN/CROWNED/ULTRA, :70-75) is item-triggered
//     by construction, not just in this snapshot.
//
// `pipeline/src/erdata/emit.py`'s `_megas`/`_primals` (:150-167) carry both straight
// into species.json's `megas`/`primals` arrays with this same shape (`Mega`/`Primal`
// in lib/types.ts).

import type { Species } from './types'

export interface FormChange {
  /** The SPECIES_* id of the form this (species, item) pair produces. */
  formId: string
  kind: 'mega' | 'primal'
}

/** Reverse index from `"<held species>|<held item>"` to the form it becomes. Built
 * once over the full species list and reused -- the forward data is organised the
 * other way round, so answering "what does THIS species become" means scanning every
 * entry's `megas`/`primals` list for one that names it, not reading a field on the
 * held species itself. */
export type FormIndex = Map<string, FormChange>

function indexKey(speciesId: string, itemId: string): string {
  return `${speciesId}|${itemId}`
}

/**
 * Builds the (species, item) -> form index from every species.json entry.
 *
 * Move-triggered `megas[]` entries are skipped: this index only answers "what does
 * HOLDING this item do", and an entry with `move` set instead of `item` has nothing to
 * key on. `SPECIES_RAYQUAZA_MEGA` (see this module's header doc) is therefore never a
 * value in this index, by construction rather than by exclusion list -- `resolveForm`
 * returns null for Rayquaza regardless of held item, which is correct: Dragon Ascent
 * isn't a held item.
 *
 * `ITEM_URSHIFITE` is the one item in the current data that resolves to two different
 * forms depending on the base species (SPECIES_URSHIFU -> Urshifu Mega, but
 * SPECIES_URSHIFU_RAPID_STRIKE_STYLE -> Urshifu Rapid Strike Style Mega) -- exactly
 * why this index is keyed on the (species, item) PAIR and never on the item alone.
 */
export function buildFormIndex(speciesList: Species[]): FormIndex {
  const index: FormIndex = new Map()
  for (const entry of speciesList) {
    for (const mega of entry.megas) {
      if (!mega.item) continue // move-triggered -- see header doc (Rayquaza/Dragon Ascent)
      index.set(indexKey(mega.from, mega.item), { formId: entry.id, kind: 'mega' })
    }
    for (const primal of entry.primals) {
      index.set(indexKey(primal.from, primal.item), { formId: entry.id, kind: 'primal' })
    }
  }
  return index
}

/** What `speciesId` becomes if it enters battle holding `itemId`, or null if nothing
 * does -- covers both "not a Mega Stone/Primal Orb" and "this species' mega triggers
 * on a move, not a held item" (Rayquaza/Dragon Ascent) with the same null. */
export function resolveForm(index: FormIndex, speciesId: string, itemId: string | null): FormChange | null {
  if (itemId === null) return null
  return index.get(indexKey(speciesId, itemId)) ?? null
}
