// Cycle 155: the ability audit's note partitioner. Gap notes that name no ability
// are counted, not dropped; notes that name a different ability stay out of the row.
import { describe, expect, it } from 'vitest'

import { GAP_NOTE, partitionAuditNotes } from './driver/abilityAuditNotes'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createRandomSource } from './rng'
import { buildMoveAction, createSession, stepTurn } from './driver/session'

const ABILITY_ID = 'ABILITY_TEST_SUBJECT'
const EMPTY_BASELINE: ReadonlySet<string> = new Set<string>()

describe('partitionAuditNotes', () => {
  it('attributes a note that contains the ability id', () => {
    const note = 'move-end defender ability ABILITY_TEST_SUBJECT is not modelled yet'
    const { attributed, unattributed } = partitionAuditNotes([note], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([note])
    expect(unattributed).toEqual([])
  })

  it('keeps an id-less gap note as unattributed', () => {
    const note = 'move-end target hold effect HOLD_EFFECT_X is not modelled yet'
    const { attributed, unattributed } = partitionAuditNotes([note], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([])
    expect(unattributed).toEqual([note])
  })

  it('drops an id-less gap note that is in the control baseline', () => {
    const note = 'move-end target hold effect HOLD_EFFECT_X is not modelled yet'
    const { attributed, unattributed } = partitionAuditNotes([note], ABILITY_ID, new Set([note]))
    expect(attributed).toEqual([])
    expect(unattributed).toEqual([])
  })

  it('leaves a note naming another ability to that ability', () => {
    const note = 'move-end defender ability ABILITY_OTHER is not modelled yet'
    const { attributed, unattributed } = partitionAuditNotes([note], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([])
    expect(unattributed).toEqual([])
  })

  it('ignores a note with no ability id and no gap phrase', () => {
    const note = 'Stealth Rock damage dealt'
    const { attributed, unattributed } = partitionAuditNotes([note], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([])
    expect(unattributed).toEqual([])
  })

  it('treats the plural "are not modelled" as a gap phrase', () => {
    const note = 'the Monotype Champion type overrides (Fairy/Dragon/Rock) are not modelled'
    expect(GAP_NOTE.test(note)).toBe(true)
    const { attributed, unattributed } = partitionAuditNotes([note], ABILITY_ID, EMPTY_BASELINE)
    expect(attributed).toEqual([])
    expect(unattributed).toEqual([note])
  })
})

describe('pressure note integration', () => {
  it('keeps the Pressure note attributed, with no baseline needed', () => {
    const data = loadSimData()
    const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
    const party = buildPlayerParty(
      [{ species: 'SPECIES_TYRANITAR', level: 50, nature: 'NATURE_ADAMANT', evs: { hp: 252, atk: 252 }, ability: 'ABILITY_PRESSURE', item: null, moves: ['MOVE_TACKLE', null, null, null] }],
      50,
      data,
    )
    party[0].abilities = { ability: 'ABILITY_PRESSURE', innates: [null, null, null] }
    const notes = new Set<string>()
    const session = createSession({ data, playerParty: party, opponentTrainer: trainer, rng: createRandomSource(1) })
    for (const n of session.startUnmodelled) notes.add(n)
    for (let turn = 0; turn < 2; turn++) {
      const step = stepTurn(session, buildMoveAction(session.state, data, 0, 'MOVE_TACKLE'))
      for (const n of step.unmodelled) notes.add(n)
    }
    const { attributed, unattributed } = partitionAuditNotes([...notes], 'ABILITY_PRESSURE', EMPTY_BASELINE)
    const pressureNote = attributed.find((n) => n.includes("Pressure's mold-breaker suppression"))
    expect(pressureNote).toBeDefined()
    expect(pressureNote).toContain('ABILITY_PRESSURE')
    expect(unattributed.some((n) => n.includes("Pressure's mold-breaker suppression"))).toBe(false)
  })
})
