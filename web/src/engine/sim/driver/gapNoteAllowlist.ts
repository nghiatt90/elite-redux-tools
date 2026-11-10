// Explicit, cited allowances for gap notes the audits cannot attribute.
//
// These entries record KNOWN OPEN GAPS. They do not make anything ported, and
// they never remove a note from the audit JSON: they only tell the audit test
// that this id-less note has been read and written down. The citation is the C
// location the note itself names; the reason points at the tracking doc.
//
// When a gap closes, its note stops being raised, findStaleAllowances reports
// the entry, and the test fails until it is deleted.

import type { GapAllowance } from './auditGate'

const DOC = 'open gap, tracked in docs/battle-sim/unattributed-gap-notes.md'
const C = 'pipeline/.upstream/eliteredux-source/src'

export const ABILITY_GAP_ALLOWLIST: GapAllowance[] = [
  {
    note: 'MulByTypeEffectiveness (battle_util.c:7843): Ring Target on battler 0 (HOLD_EFFECT_RING_TARGET) is not modelled',
    citation: `${C}/battle_util.c:7843`,
    reason: DOC,
  },
  {
    note: 'MulByTypeEffectiveness (battle_util.c:7843): STATUS4_FORESIGHT on battler 0 is not modelled',
    citation: `${C}/battle_util.c:7843`,
    reason: DOC,
  },
  {
    note: 'MulByTypeEffectiveness (battle_util.c:7843): the Monotype Champion type overrides (Fairy/Dragon/Rock) are not modelled',
    citation: `${C}/battle_util.c:7843`,
    reason: DOC,
  },
  {
    note: 'MulByTypeEffectiveness (battle_util.c:7843): the iceStatue volatile on battler 0 is not modelled',
    citation: `${C}/battle_util.c:7843`,
    reason: DOC,
  },
  {
    note: 'MulByTypeEffectiveness (battle_util.c:7843): the Ground-vs-Flying grounding override (IsBattlerGrounded(battlerDef)) is not modelled',
    citation: `${C}/battle_util.c:7843`,
    reason: DOC,
  },
  {
    note: 'MulByTypeEffectiveness (battle_util.c:7843): the tarShot volatile on battler 0 is not modelled',
    citation: `${C}/battle_util.c:7843`,
    reason: DOC,
  },
  {
    note: 'MulByTypeEffectiveness (battle_util.c:7843): WEATHER_STRONG_WINDS is not modelled',
    citation: `${C}/battle_util.c:7843`,
    reason: DOC,
  },
  {
    note: 'Minion Control: party-based hit count not modelled (caller supplied no minionControlCount)',
    citation: `${C}/battle_script_commands.c:1021`,
    reason: DOC,
  },
]

// Notes the move audit drops before per-effect attribution because more than 20
// effects raise them (end-of-turn / AI noise). A shared note is only acceptable
// if it is either here or covered by an effect allowance in auditAllowlist.ts.
export const SHARED_NOISE_ALLOWLIST: GapAllowance[] = []
