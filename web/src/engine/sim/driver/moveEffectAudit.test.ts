// Audit: which move effects still raise an "unmodelled" note when a mon uses the move for one turn?
// Skipped unless SIM_AUDIT === '1'. Writes the report to $SIM_AUDIT_OUT (default .omc/solver/unmodelled_effects.json),
// one entry per move effect: the moves using it, how often elite-tier boss parties carry them, and the notes that
// are specific to that effect (notes shared by more than 20 effects are the usual end-of-turn / AI noise and are dropped).

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { createRandomSource } from '../rng'
import { splitRows } from './auditAllowlist'
import { buildMoveAction, createSession, stepTurn } from './session'

const NOTE = /not modelled|not applied|not run|no port|not supported|unmodelled/i

it.skipIf(process.env.SIM_AUDIT !== '1')('move effect audit', { timeout: 900_000 }, () => {
  const data = loadSimData()
  const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

  const bossUse = new Map<string, number>()
  for (const t of data.trainers) {
    for (const m of t.parties?.elite ?? []) for (const mv of m.moves ?? []) bossUse.set(mv, (bossUse.get(mv) ?? 0) + 1)
  }

  const byEffect = new Map<string, { moves: string[]; notes: Set<string> }>()
  for (const m of data.movesById.values() as Iterable<{ id: string; power?: number; effect?: string | null }>) {
    if (m.id === 'MOVE_NONE' || !((m.power ?? 0) > 1 || m.effect)) continue
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
        for (const n of step.unmodelled) if (NOTE.test(n) && !/manifest/.test(n)) entry.notes.add(n)
      } catch (e) {
        entry.notes.add(`THROWS: ${(e as Error).message.slice(0, 160)}`)
      }
    }
  }

  const noteCount = new Map<string, number>()
  for (const v of byEffect.values()) for (const n of v.notes) noteCount.set(n, (noteCount.get(n) ?? 0) + 1)

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
  console.log(`AUDIT ${counted.length} effects with their own unmodelled notes -> ${out}`)
})
