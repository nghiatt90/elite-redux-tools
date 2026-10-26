// Audit: which abilities still raise a "not modelled / hook was not run" note when a mon holding them fights two turns?
// Skipped unless SIM_AUDIT === '1'. Writes {ability: notes[]} to $SIM_AUDIT_OUT (default .omc/solver/ability_audit.json), listing only
// abilities with at least one note that names them. Covers the hooks the sim reports by name: on-entry, end-turn, move-end attacker and
// defender, on-faint. A hook that fails silently (no note) is invisible here; read traces for those.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { createRandomSource } from '../rng'
import { buildMoveAction, createSession, stepTurn } from './session'

it.skipIf(process.env.SIM_AUDIT !== '1')('ability audit', { timeout: 900_000 }, () => {
  const data = loadSimData()
  const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
  const abilityIds = Object.keys(JSON.parse(readFileSync(resolve(process.cwd(), '../data/v2.65beta/abilityHooks.json'), 'utf8')) as Record<string, unknown>)
  const rows: Record<string, string[]> = {}
  for (const id of abilityIds) {
    const notes = new Set<string>()
    for (const seed of [1, 2]) {
      const party = buildPlayerParty(
        [{ species: 'SPECIES_TYRANITAR', level: 50, nature: 'NATURE_ADAMANT', evs: { hp: 252, atk: 252 }, ability: id, item: null, moves: ['MOVE_TACKLE', null, null, null] }],
        50,
        data,
      )
      party[0].abilities = { ability: id, innates: [null, null, null] }
      try {
        const session = createSession({ data, playerParty: party, opponentTrainer: trainer, rng: createRandomSource(seed) })
        for (const n of session.startUnmodelled) if (n.includes(id)) notes.add(n)
        for (let turn = 0; turn < 2; turn++) {
          const step = stepTurn(session, buildMoveAction(session.state, data, 0, 'MOVE_TACKLE'))
          for (const n of step.unmodelled) if (n.includes(id)) notes.add(n)
        }
      } catch (e) {
        notes.add(`THROWS: ${(e as Error).message.slice(0, 160)}`)
      }
    }
    if (notes.size > 0) rows[id] = [...notes]
  }
  const out = process.env.SIM_AUDIT_OUT ?? resolve(process.cwd(), '../.omc/solver/ability_audit.json')
  writeFileSync(out, JSON.stringify(rows, null, 1))
  console.log(`ABILITY AUDIT ${Object.keys(rows).length} of ${abilityIds.length} abilities with notes -> ${out}`)
})
