// Classification for the ability audit's note stream.
//
// The audit runs one two-turn fight per ability and records every note the sim
// raises. Most notes name the ability they are about ("move-end defender ability
// ABILITY_X is not modelled yet"), but a substantial minority do not: item
// effects, hazards, AI stand-ins and generic move-end paths raise gap notes with
// no ABILITY_ token at all. The old filter (`n.includes(abilityId)`) silently
// dropped those, hiding them from the ability_gaps count. This module splits a
// note stream into the notes that name the ability under test and the gap notes
// that name no ability and are not part of the hook-free control baseline.
//
// Pure and headless: no React, no fs, no data access.

// The shared definition of a gap note, used by BOTH audits so they cannot
// disagree about what counts as a gap. It started as the validate.sh phrases
// plus the plural form several sites use ("... are not applied", "status
// effects are not modelled yet"), then absorbed the move audit's wider pattern
// (`not modelled`, `not run`, `no port`, `not supported`, `unmodelled`, and the
// case-insensitive forms). Widen, never narrow: every phrase either audit ever
// counted as a gap must keep counting.
export const GAP_NOTE =
  /hook was not run|is not modelled|are not modelled|not modelled|not applied|has no port|no port|not run|not supported|unmodelled/i

export const ABILITY_TOKEN = /ABILITY_[A-Z0-9_]+/

/**
 * Splits `notes` for the ability audit's row of `abilityId`.
 *
 * - `attributed`: every note containing `abilityId`, gap phrase or not. This is
 *   the audit's historical output and must stay unchanged.
 * - `unattributed`: notes that are gap notes (`GAP_NOTE`), name no ability at
 *   all (`ABILITY_[A-Z0-9_]+`), and are not in `baseline` (the notes a
 *   hook-free control ability raises in the same fight, i.e. AI and generic
 *   notes that are not the ability's fault).
 *
 * A note that names a DIFFERENT ability is neither: it will be counted in that
 * other ability's own row when the audit runs it.
 */
export function partitionAuditNotes(
  notes: string[],
  abilityId: string,
  baseline: ReadonlySet<string>,
): { attributed: string[]; unattributed: string[] } {
  const attributed: string[] = []
  const unattributed: string[] = []
  for (const note of notes) {
    if (note.includes(abilityId)) {
      attributed.push(note)
      continue
    }
    if (!GAP_NOTE.test(note)) continue
    if (ABILITY_TOKEN.test(note)) continue
    if (baseline.has(note)) continue
    unattributed.push(note)
  }
  return { attributed, unattributed }
}
