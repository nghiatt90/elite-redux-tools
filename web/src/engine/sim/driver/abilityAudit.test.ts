// Audit: which abilities still raise a "not modelled / hook was not run" note when a mon holding them fights two turns?
// Skipped unless SIM_AUDIT === '1'. Writes {ability: notes[]} to $SIM_AUDIT_OUT (default .omc/solver/ability_audit.json), listing only
// abilities with at least one note. Notes that name the ability under test are listed as-is; gap notes that name no ability at all
// (and are not raised by a hook-free control ability in the same fight) are listed with an "UNATTRIBUTED: " prefix, and also written
// as {note: abilityIds[]} to $SIM_AUDIT_UNATTRIBUTED_OUT for docs/battle-sim/unattributed-gap-notes.md. Covers the hooks the sim
// reports by name: on-entry, end-turn, move-end attacker and defender, on-faint. A hook that fails silently (no note) is invisible
// here; read traces for those.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { it, expect } from 'vitest'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { createRandomSource } from '../rng'
import { buildMoveAction, createSession, stepTurn } from './session'
import { partitionAuditNotes } from './abilityAuditNotes'
import { findStaleAllowances, findUncoveredGapNotes } from './auditGate'
import { ABILITY_GAP_ALLOWLIST } from './gapNoteAllowlist'

it.skipIf(process.env.SIM_AUDIT !== '1')('ability audit', { timeout: 900_000 }, () => {
  const data = loadSimData()
  const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
  const abilityHooks = JSON.parse(
    readFileSync(resolve(process.cwd(), '../data/v2.65beta/abilityHooks.json'), 'utf8'),
  ) as Record<string, { hooks?: Record<string, unknown> }>
  const abilityIds = Object.keys(abilityHooks)

  const collectNotes = (abilityId: string, seed: number): Set<string> => {
    const notes = new Set<string>()
    const party = buildPlayerParty(
      [{ species: 'SPECIES_TYRANITAR', level: 50, nature: 'NATURE_ADAMANT', evs: { hp: 252, atk: 252 }, ability: abilityId, item: null, moves: ['MOVE_TACKLE', null, null, null] }],
      50,
      data,
    )
    party[0].abilities = { ability: abilityId, innates: [null, null, null] }
    try {
      const session = createSession({ data, playerParty: party, opponentTrainer: trainer, rng: createRandomSource(seed) })
      for (const n of session.startUnmodelled) notes.add(n)
      for (let turn = 0; turn < 2; turn++) {
        const step = stepTurn(session, buildMoveAction(session.state, data, 0, 'MOVE_TACKLE'))
        for (const n of step.unmodelled) notes.add(n)
      }
    } catch (e) {
      notes.add(`THROWS: ${(e as Error).message.slice(0, 160)}`)
    }
    return notes
  }

  // Baseline: every note the same fight raises with a hook-free control ability. These are the AI and generic
  // notes that appear in any fight (see docs/battle-sim/unattributed-gap-notes.md's AI section). ABILITY_NONE is
  // in abilityHooks.json with an empty `hooks` object and is a real species ability slot in species.json.
  const isHookFree = (id: string): boolean => Object.keys(abilityHooks[id]?.hooks ?? {}).length === 0
  const speciesAbilityIds = new Set<string>()
  for (const species of data.speciesById.values()) {
    for (const a of (species.abilities ?? []) as (string | null)[]) if (a) speciesAbilityIds.add(a)
  }
  const hookFreeIds = abilityIds.filter(isHookFree)
  const controlAbility =
    speciesAbilityIds.has('ABILITY_NONE') && isHookFree('ABILITY_NONE')
      ? 'ABILITY_NONE'
      : hookFreeIds.find((id) => speciesAbilityIds.has(id)) ?? hookFreeIds[0]
  if (!controlAbility) throw new Error('ability audit: no hook-free control ability found')
  const baseline = new Set<string>([...collectNotes(controlAbility, 1), ...collectNotes(controlAbility, 2)])

  const rows: Record<string, string[]> = {}
  const unattributedNotes: Record<string, string[]> = {}
  for (const id of abilityIds) {
    const notes = new Set<string>([...collectNotes(id, 1), ...collectNotes(id, 2)])
    const { attributed, unattributed } = partitionAuditNotes([...notes], id, baseline)
    const row = new Set<string>(attributed)
    for (const n of notes) if (n.startsWith('THROWS:')) row.add(n)
    for (const n of unattributed) {
      row.add(`UNATTRIBUTED: ${n}`)
      const owners = unattributedNotes[n] ?? (unattributedNotes[n] = [])
      if (!owners.includes(id)) owners.push(id)
    }
    if (row.size > 0) rows[id] = [...row]
  }
  const out = process.env.SIM_AUDIT_OUT ?? resolve(process.cwd(), '../.omc/solver/ability_audit.json')
  const unattributedOut =
    process.env.SIM_AUDIT_UNATTRIBUTED_OUT ?? resolve(process.cwd(), '../.omc/solver/ability_audit_unattributed.json')
  mkdirSync(dirname(out), { recursive: true })
  mkdirSync(dirname(unattributedOut), { recursive: true })
  writeFileSync(out, JSON.stringify(rows, null, 1))
  writeFileSync(unattributedOut, JSON.stringify(unattributedNotes, null, 1))
  console.log(
    `ABILITY AUDIT ${Object.keys(rows).length} of ${abilityIds.length} abilities with notes -> ${out}, ${Object.keys(unattributedNotes).length} unattributed notes`,
  )

  // Gate: write the files first (above), then fail if an id-less gap note was
  // neither attributed nor explicitly allowlisted with a C citation. A stale
  // entry fails too, so closing a gap forces its allowance out of the list.
  const unattributedList = Object.keys(unattributedNotes)
  expect(findUncoveredGapNotes(unattributedList, ABILITY_GAP_ALLOWLIST)).toEqual([])
  expect(findStaleAllowances(unattributedList, ABILITY_GAP_ALLOWLIST)).toEqual([])
})
