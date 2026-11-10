// The pure gate both audit tests use: a raised gap note is either attributed
// (its text names an ABILITY_ id) or explicitly allowlisted with a C citation.
// Nothing here mutates the audit output — an allowance only stops the test from
// failing; the note still appears in the JSON and in the UNATTRIBUTED: rows.
//
// Pure and headless: no React, no fs, no data access.

import { ABILITY_TOKEN, GAP_NOTE } from './abilityAuditNotes'

export interface GapAllowance {
  // Exact note text, or a pattern for notes whose battler id varies.
  note: string | RegExp
  // C location, e.g. 'pipeline/.upstream/eliteredux-source/src/battle_util.c:7843'.
  citation: string
  // Why the gap is open (or why the note is noise). Optional, never validated.
  reason?: string
}

export function allowanceMatchesNote(note: string, allowance: GapAllowance): boolean {
  if (typeof allowance.note === 'string') return allowance.note === note
  allowance.note.lastIndex = 0
  return allowance.note.test(note)
}

/** A gap note that names no ability: what a row can hide. */
export function isUnattributedGapNote(note: string): boolean {
  return GAP_NOTE.test(note) && !ABILITY_TOKEN.test(note)
}

/**
 * Every note that matches `GAP_NOTE`, names no ability, and has no allowance.
 * An empty result means the audit may pass; each returned string is a note that
 * would otherwise vanish between the sim and the audit counts.
 */
export function findUncoveredGapNotes(
  notes: readonly string[],
  allowlist: readonly GapAllowance[],
): string[] {
  const uncovered: string[] = []
  const seen = new Set<string>()
  for (const note of notes) {
    if (!isUnattributedGapNote(note)) continue
    if (allowlist.some((a) => allowanceMatchesNote(note, a))) continue
    if (seen.has(note)) continue
    seen.add(note)
    uncovered.push(note)
  }
  return uncovered
}

/**
 * A note shared by many effects is covered only when *every* effect that raises
 * it carries an allowance for it. One allowed effect must not mask the twenty
 * others that raise the same note; an empty owner set counts as uncovered.
 */
export function sharedNoteCovered(
  owners: Iterable<string>,
  note: string,
  covers: (effect: string, note: string) => boolean,
): boolean {
  const list = [...owners]
  return list.length > 0 && list.every((effect) => covers(effect, note))
}

/**
 * Allowances that no longer match any note in `notes`: the gap was closed (or
 * the note was reworded), so the entry must leave the list rather than sit
 * there masking a future note that happens to reuse its text.
 */
export function findStaleAllowances(
  notes: readonly string[],
  allowlist: readonly GapAllowance[],
): GapAllowance[] {
  return allowlist.filter((a) => !notes.some((n) => allowanceMatchesNote(n, a)))
}

/** Same citation rule as validateAllowance in auditAllowlist.ts. */
export function validateGapAllowance(a: GapAllowance): string[] {
  const problems: string[] = []
  const label = typeof a.note === 'string' ? a.note : a.note.source
  if (!label.trim()) problems.push('empty note')
  if (!/\.(c|cc|h|s|pory|inc):\d+/.test(a.citation)) problems.push(`${label}: citation lacks file:line`)
  return problems
}
