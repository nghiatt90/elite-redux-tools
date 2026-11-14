/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 155d: notes the AI raises about its own port must not be counted as
// ability-reachable gaps. They are unconditional admissions (the same text is
// added whatever the ability under test), so they reached the audit's
// UNATTRIBUTED rows only because the AI branched differently from the
// ABILITY_NONE control fight. `isAiAdmissionNote` excludes them by note text.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { isAiAdmissionNote, partitionAuditNotes } from './driver/abilityAuditNotes'

const ABILITY_ID = 'ABILITY_IMPOSTER'
const EMPTY_BASELINE: ReadonlySet<string> = new Set<string>()

const RING_TARGET =
  'MulByTypeEffectiveness (battle_util.c:7843): Ring Target on battler 0 (HOLD_EFFECT_RING_TARGET) is not modelled'
const SHIELDS_DOWN =
  'AI_CheckBadMove: IsShieldsDownProtected(battlerAtk) is not modelled (Minior form-state is not tracked); treated as not protected'
const EFFECT_THIEF =
  'EFFECT_THIEF: ShouldPoisonSelf has no port anywhere in this codebase; treated as false'

describe('isAiAdmissionNote', () => {
  it('matches the mulByTypeEffectiveness and AI_CheckBadMove admissions', () => {
    expect(isAiAdmissionNote(RING_TARGET)).toBe(true)
    expect(isAiAdmissionNote(SHIELDS_DOWN)).toBe(true)
  })

  it('does not match a move-effect-keyed gap note', () => {
    expect(isAiAdmissionNote(EFFECT_THIEF)).toBe(false)
  })
})

describe('partitionAuditNotes with AI admissions', () => {
  it('drops mulByTypeEffectiveness notes even with an empty control baseline', () => {
    const { attributed, unattributed } = partitionAuditNotes([RING_TARGET], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([])
    expect(unattributed).toEqual([])
  })

  it('drops AI_CheckBadMove notes even with an empty control baseline', () => {
    const { attributed, unattributed } = partitionAuditNotes([SHIELDS_DOWN], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([])
    expect(unattributed).toEqual([])
  })

  it('still counts a non-AI id-less gap note as unattributed', () => {
    const { attributed, unattributed } = partitionAuditNotes([EFFECT_THIEF], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([])
    expect(unattributed).toEqual([EFFECT_THIEF])
  })

  it('still attributes a note that names the ability', () => {
    const note = 'move-end defender ability ABILITY_IMPOSTER is not modelled yet'
    const { attributed, unattributed } = partitionAuditNotes([note], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([note])
    expect(unattributed).toEqual([])
  })
})

describe('AI admission prefix coverage', () => {
  // Every fixed string aiShouldSwitch.ts adds to its `missing` set must satisfy
  // isAiAdmissionNote, so a new AI note cannot silently reappear as an
  // unattributed ability gap. Cycle 150fb finished the MulByTypeEffectiveness
  // port (battle_util.c:7843-7884), which removed every `missing.add` literal
  // from that file, so zero literals is the correct state; the invariant below
  // still guards any that return.
  it('every missing.add literal in aiShouldSwitch.ts is an AI admission note', () => {
    const source = readFileSync(new URL('./ai/aiShouldSwitch.ts', import.meta.url), 'utf8')
    const literals: string[] = []
    const re = /missing\.add\((['"])(.*?)\1\)/g
    for (let m = re.exec(source); m !== null; m = re.exec(source)) literals.push(m[2])
    const missed = literals.filter((literal) => !isAiAdmissionNote(literal))
    expect(missed).toEqual([])
  })
})
