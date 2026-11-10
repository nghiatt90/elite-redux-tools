// Audit: which move effects still raise an "unmodelled" note when a mon uses the move for one turn?
// Skipped unless SIM_AUDIT === '1'. Writes the report to $SIM_AUDIT_OUT (default .omc/solver/unmodelled_effects.json),
// one entry per move effect: the moves using it, how often elite-tier boss parties carry them, and the notes that
// are specific to that effect. Notes shared by more than 20 effects are written to <out>_shared.json instead of being
// dropped, and the test fails if a shared note is a gap note that is neither explicit noise (gapNoteAllowlist.ts)
// nor covered by an effect allowance (auditAllowlist.ts).

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { createRandomSource } from '../rng'
import { findAllowance, splitRows } from './auditAllowlist'
import { GAP_NOTE } from './abilityAuditNotes'
import { allowanceMatchesNote, findStaleAllowances } from './auditGate'
import { SHARED_NOISE_ALLOWLIST } from './gapNoteAllowlist'
import { buildMoveAction, createSession, stepTurn } from './session'

it.skipIf(process.env.SIM_AUDIT !== '1')('move effect audit', { timeout: 900_000 }, () => {
  const data = loadSimData()
  const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

  const bossUse = new Map<string, number>()
  for (const t of data.trainers) {
    for (const m of t.parties?.elite ?? []) for (const mv of m.moves ?? []) bossUse.set(mv, (bossUse.get(mv) ?? 0) + 1)
  }

  const byEffect = new Map<string, { moves: string[]; notes: Set<string> }>()
  let skipped = 0
  for (const m of data.movesById.values() as Iterable<{ id: string; power?: number; effect?: string | null }>) {
    if (m.id === 'MOVE_NONE') continue
    if (!((m.power ?? 0) > 1 || m.effect)) {
      skipped++
      continue
    }
    const key = m.effect ?? 'NONE'
    const entry = byEffect.get(key) ?? { moves: [], notes: new Set<string>() }
    entry.moves.push(m.id)
    byEffect.set(key, entry)
    for (const seed of [1, 2]) {
      const party = buildPlayerParty(
        [
          {
            species: 'SPECIES_TYRANITAR',
            level: 50,
            nature: 'NATURE_ADAMANT',
            evs: { hp: 252, atk: 252 },
            ability: 'ABILITY_SAND_STREAM',
            item: 'ITEM_LEFTOVERS',
            moves: [m.id, null, null, null],
          },
        ],
        50,
        data,
      )
      try {
        const session = createSession({ data, playerParty: party, opponentTrainer: trainer, rng: createRandomSource(seed) })
        const step = stepTurn(session, buildMoveAction(session.state, data, 0, m.id))
        for (const n of step.unmodelled) if (GAP_NOTE.test(n)) entry.notes.add(n)
      } catch (e) {
        entry.notes.add(`THROWS: ${(e as Error).message.slice(0, 160)}`)
      }
    }
  }

  const noteCount = new Map<string, number>()
  const effectsByNote = new Map<string, Set<string>>()
  for (const [effect, v] of byEffect) {
    for (const n of v.notes) {
      noteCount.set(n, (noteCount.get(n) ?? 0) + 1)
      const owners = effectsByNote.get(n) ?? new Set<string>()
      owners.add(effect)
      effectsByNote.set(n, owners)
    }
  }

  // Notes the per-effect row drops because more than 20 effects raise them.
  // They are written to <out>_shared.json rather than discarded, and the gate
  // below refuses to let a gap phrase disappear here unseen.
  const shared = new Map<string, number>()
  for (const [note, count] of noteCount) if (count > 20 && !note.startsWith('THROWS')) shared.set(note, count)

  const rows = [...byEffect.entries()]
    .map(([effect, v]) => ({
      effect,
      moves: v.moves,
      bossUses: v.moves.reduce((s, id) => s + (bossUse.get(id) ?? 0), 0),
      notes: [...v.notes].filter((n) => (noteCount.get(n) ?? 0) <= 20 || n.startsWith('THROWS')),
    }))
    .filter((r) => r.notes.length > 0)
    .sort((a, b) => b.bossUses - a.bossUses)

  const out = process.env.SIM_AUDIT_OUT ?? resolve(process.cwd(), '../.omc/solver/unmodelled_effects.json')
  const { counted, allowed } = splitRows(rows)
  writeFileSync(out, JSON.stringify(counted, null, 1))
  const allowedOut = out.endsWith('.json') ? out.replace(/\.json$/, '_allowed.json') : `${out}_allowed.json`
  writeFileSync(allowedOut, JSON.stringify(allowed, null, 1))
  const sharedOut = out.endsWith('.json') ? out.replace(/\.json$/, '_shared.json') : `${out}_shared.json`
  writeFileSync(sharedOut, JSON.stringify(Object.fromEntries(shared), null, 1))
  console.log(
    `AUDIT ${counted.length} effects with their own unmodelled notes -> ${out}; ${skipped} moves skipped (power <= 1 and no effect); ${shared.size} shared notes -> ${sharedOut}`,
  )

  // Gate: a shared note that is a gap phrase must be either explicit noise or
  // covered by the effect allowance for every effect that raises it. Files are
  // written first so the evidence exists when this fails.
  const effectCoversNote = (effect: string, note: string): boolean => {
    const allowance = findAllowance(effect)
    return allowance !== undefined && (!allowance.notes || allowance.notes.includes(note))
  }
  const sharedUncovered = [...shared.keys()].filter(
    (note) =>
      GAP_NOTE.test(note) &&
      !SHARED_NOISE_ALLOWLIST.some((a) => allowanceMatchesNote(note, a)) &&
      ![...(effectsByNote.get(note) ?? [])].some((effect) => effectCoversNote(effect, note)),
  )
  expect(sharedUncovered).toEqual([])
  expect(findStaleAllowances([...shared.keys()], SHARED_NOISE_ALLOWLIST)).toEqual([])
})
