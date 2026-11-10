/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150f: the audit gate. A gap note with no ability id may not vanish
// between the sim and the audit counts: it is reported by findUncoveredGapNotes
// unless an explicit, cited allowance covers it, and an allowance whose note no
// longer occurs is reported as stale.
import { describe, expect, it } from 'vitest'

import { partitionAuditNotes } from './driver/abilityAuditNotes'
import { findStaleAllowances, findUncoveredGapNotes, sharedNoteCovered, validateGapAllowance } from './driver/auditGate'
import type { GapAllowance } from './driver/auditGate'
import { ABILITY_GAP_ALLOWLIST, SHARED_NOISE_ALLOWLIST } from './driver/gapNoteAllowlist'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createRandomSource } from './rng'
import { buildMoveAction, createSession, stepTurn } from './driver/session'

const SYNTHETIC = 'Synthetic site (battle_util.c:1): the widget is not modelled'
const C = 'pipeline/.upstream/eliteredux-source/src'
const CITATION = `${C}/battle_util.c:1`

describe('findUncoveredGapNotes', () => {
  it('reports an id-less gap note that has no allowance', () => {
    expect(findUncoveredGapNotes([SYNTHETIC], [])).toEqual([SYNTHETIC])
  })

  it('accepts the same note once an allowance covers it', () => {
    const allowance: GapAllowance = { note: SYNTHETIC, citation: CITATION }
    expect(findUncoveredGapNotes([SYNTHETIC], [allowance])).toEqual([])
  })

  it('accepts a pattern allowance for a note whose battler id varies', () => {
    const allowance: GapAllowance = { note: /Synthetic site \(battle_util\.c:1\).*not modelled/, citation: CITATION }
    expect(findUncoveredGapNotes([SYNTHETIC], [allowance])).toEqual([])
  })

  it('reports an allowance whose note no longer occurs as stale', () => {
    const allowance: GapAllowance = { note: SYNTHETIC, citation: CITATION }
    expect(findStaleAllowances([], [allowance])).toEqual([allowance])
    expect(findStaleAllowances([SYNTHETIC], [allowance])).toEqual([])
  })

  it('does not report a note that names an ability', () => {
    expect(findUncoveredGapNotes(['move-end defender ability ABILITY_X is not modelled yet'], [])).toEqual([])
  })

  it('does not report a note with no gap phrase', () => {
    expect(findUncoveredGapNotes(['Stealth Rock damage dealt'], [])).toEqual([])
  })

  it('treats the plural "are not modelled" as an uncovered gap', () => {
    const note = 'the Monotype Champion type overrides (Fairy/Dragon/Rock) are not modelled'
    expect(findUncoveredGapNotes([note], [])).toEqual([note])
  })
})

describe('validateGapAllowance', () => {
  it('rejects a citation without file:line', () => {
    const problems = validateGapAllowance({ note: SYNTHETIC, citation: 'battle_util.c' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/citation lacks file:line/)
  })

  it('accepts a citation with file:line', () => {
    expect(validateGapAllowance({ note: SYNTHETIC, citation: CITATION })).toEqual([])
  })
})

describe('sharedNoteCovered', () => {
  it('needs every owner allowed, and treats no owners as uncovered', () => {
    const note = 'Synthetic shared gap (battle_util.c:1): the widget is not modelled'
    const covers = (...effects: string[]) => (effect: string) => effects.includes(effect)
    expect(sharedNoteCovered(['A', 'B', 'C'], note, covers('A'))).toBe(false)
    expect(sharedNoteCovered(['A', 'B'], note, covers('A', 'B'))).toBe(true)
    expect(sharedNoteCovered([], note, covers('A'))).toBe(false)
  })
})

describe('seeded gap allowlists', () => {
  it('validate and contain no duplicate note', () => {
    for (const list of [ABILITY_GAP_ALLOWLIST, SHARED_NOISE_ALLOWLIST]) {
      const seen = new Set<string>()
      for (const allowance of list) {
        expect(validateGapAllowance(allowance)).toEqual([])
        const key = typeof allowance.note === 'string' ? allowance.note : allowance.note.source
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
    }
  })
})

describe('real session', () => {
  // Cycle 155d: the subject moved from ABILITY_IMPOSTER to ABILITY_MINION_CONTROL.
  // IMPOSTER's id-less notes were the seven `MulByTypeEffectiveness` admissions;
  // `isAiAdmissionNote` now excludes those as AI noise, so IMPOSTER no longer
  // raises a surviving unattributed note. MINION_CONTROL's note is not an AI
  // admission, so it keeps this gate test's coverage intact.
  it('MINION_CONTROL raises an id-less gap note: unattributed, uncovered without an allowance, covered by the seeded list', () => {
    const data = loadSimData()
    const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
    const collect = (abilityId: string, seed: number): Set<string> => {
      const notes = new Set<string>()
      const party = buildPlayerParty(
        [{ species: 'SPECIES_TYRANITAR', level: 50, nature: 'NATURE_ADAMANT', evs: { hp: 252, atk: 252 }, ability: abilityId, item: null, moves: ['MOVE_TACKLE', null, null, null] }],
        50,
        data,
      )
      party[0].abilities = { ability: abilityId, innates: [null, null, null] }
      const session = createSession({ data, playerParty: party, opponentTrainer: trainer, rng: createRandomSource(seed) })
      for (const n of session.startUnmodelled) notes.add(n)
      for (let turn = 0; turn < 2; turn++) {
        const step = stepTurn(session, buildMoveAction(session.state, data, 0, 'MOVE_TACKLE'))
        for (const n of step.unmodelled) notes.add(n)
      }
      return notes
    }

    // Same control baseline as abilityAudit.test.ts: ABILITY_NONE is a hook-free
    // real species ability slot, so this removes AI/generic notes.
    const baseline = new Set<string>([...collect('ABILITY_NONE', 1), ...collect('ABILITY_NONE', 2)])
    // De-duplicated: both seeds can raise the same note, and the audit itself
    // partitions a Set, while findUncoveredGapNotes de-duplicates internally.
    const subjectNotes = [...new Set([...collect('ABILITY_MINION_CONTROL', 1), ...collect('ABILITY_MINION_CONTROL', 2)])]
    const { unattributed } = partitionAuditNotes(subjectNotes, 'ABILITY_MINION_CONTROL', baseline)

    expect(unattributed.length).toBeGreaterThan(0)
    // Cycle 155d pinned expectation changed: AI admissions used to land here,
    // and the surviving id-less note is now the Minion Control hit-count gap.
    expect(unattributed.some((n) => n.startsWith('Minion Control: party-based hit count not modelled'))).toBe(true)
    expect(unattributed.some((n) => n.startsWith('MulByTypeEffectiveness (battle_util.c:7843):'))).toBe(false)
    // Without the allowlist the gate goes red on exactly these notes; the seeded
    // list records them as known open gaps, so the audit's own check is green.
    expect(findUncoveredGapNotes(unattributed, [])).toEqual(unattributed)
    expect(findUncoveredGapNotes(unattributed, ABILITY_GAP_ALLOWLIST)).toEqual([])
  }, 60_000)
})
