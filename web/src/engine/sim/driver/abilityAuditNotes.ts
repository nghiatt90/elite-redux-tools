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
  /hook was not run|is not modelled|are not modelled|not modelled|not applied|not dispatched|has no port|no port|not run|not supported|unmodelled/i

export const ABILITY_TOKEN = /ABILITY_[A-Z0-9_]+/

/**
 * Fixed prefixes of notes the AI raises about its own port, not about the
 * ability under test. `mulByTypeEffectiveness` used to add eight `missing`
 * strings on EVERY call against the old aiShouldSwitch.ts:216-223, whatever the
 * ability, so they reached the note stream only when the AI happened to evaluate
 * an opposing mon in that fight -- exactly how they escaped the ABILITY_NONE
 * control baseline and got counted as the ability's fault. That function is now
 * fully ported (battle_util.c:7843-7884, cycle 150fb) and raises no note; the
 * prefix stays because any note it might raise again would still be an AI
 * admission. `AI_CheckBadMove:` is the same shape: the prefix names the AI
 * routine that admits an approximation, not a game effect.
 *
 * A prefix list, deliberately not an ability list: the match is on note text,
 * and attributed rows (which contain the ability id) are checked first, so a
 * note that names an ability still lands in that ability's row. Game-effect-
 * keyed notes (`EFFECT_THIEF: ...`, `CanBePoisoned/IsStatusImmune: ...`) are NOT
 * listed: they can describe ability-reachable gaps (e.g. the missing
 * onCanStatusType ability-hook scan) and must keep counting.
 */
export const AI_ADMISSION_PREFIXES = [
  'MulByTypeEffectiveness (battle_util.c:7843):',
  'AI_CheckBadMove:',
  'CalcPartyMonTypeEffectivenessMultiplier (battle_util.c:7998)',
  'ShouldSwitchIfNaturalCure (battle_ai_switch_items.c:280):',
] as const

/** True for a note admitted by an AI code path rather than by the ability under test. */
export function isAiAdmissionNote(note: string): boolean {
  return AI_ADMISSION_PREFIXES.some((prefix) => note.startsWith(prefix))
}

/**
 * Splits `notes` for the ability audit's row of `abilityId`.
 *
 * - `attributed`: every note containing `abilityId`, gap phrase or not. This is
 *   the audit's historical output and must stay unchanged.
 * - `unattributed`: notes that are gap notes (`GAP_NOTE`), name no ability at
 *   all (`ABILITY_[A-Z0-9_]+`), and are not in `baseline` (the notes a
 *   hook-free control ability raises in the same fight) and are not
 *   `isAiAdmissionNote` (the notes an AI code path raises whatever the ability,
 *   which the control fight may have missed only because the AI branched
 *   differently). Both exclusions are noise, not the ability's fault.
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
    if (isAiAdmissionNote(note)) continue
    unattributed.push(note)
  }
  return { attributed, unattributed }
}
