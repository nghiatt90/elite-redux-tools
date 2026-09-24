// trainerAiFlags/battleAiSetupFlags, ported in aiFlags.ts. Checked against REAL
// data/v2.65beta/trainers.json rows (not hand-built fixtures) per the brief --
// Winona 2 (risky), Trent 1 (noSwitching), Roxanne 1 (preferStall +
// preferStatus), and an ordinary trainer with none of the four.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AI_FLAG_CHECK_BAD_MOVE,
  AI_FLAG_CHECK_FOE,
  AI_FLAG_CHECK_VIABILITY,
  AI_FLAG_DISABLE_SWITCHING,
  AI_FLAG_DOUBLE_BATTLE,
  AI_FLAG_HP_AWARE,
  AI_FLAG_PREFER_STATUS_MOVES,
  AI_FLAG_RISKY,
  AI_FLAG_SMART_SWITCHING,
  AI_FLAG_STALL,
  AI_FLAG_TRY_TO_FAINT,
  AI_FLAG_WILL_SUICIDE,
  battleAiSetupFlags,
  trainerAiFlags,
  type TrainerAiRow,
} from './aiFlags'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
const trainers = JSON.parse(readFileSync(join(DATA_DIR, 'trainers.json'), 'utf8')) as Array<Record<string, unknown>>
const trainerById = new Map(trainers.map((t) => [t.id as string, t]))

// Fail loudly if the snapshot's trainer roster shape ever changes -- per the
// brief's "verify every id against data/v2.65beta/*.json at module load" rule.
for (const id of ['TRAINER_WINONA_2', 'TRAINER_TRENT_1', 'TRAINER_ROXANNE_1', 'TRAINER_WINONA_1']) {
  if (!trainerById.has(id)) throw new Error(`trainers.json is missing ${id}`)
}
if (trainers.length !== 932) throw new Error(`trainers.json trainer count changed: expected 932, got ${trainers.length}`)

function row(id: string): TrainerAiRow {
  const t = trainerById.get(id)
  if (!t) throw new Error(`trainers.json is missing ${id}`)
  return {
    risky: t.risky as boolean,
    preferStall: t.preferStall as boolean,
    preferStatus: t.preferStatus as boolean,
    noSwitching: t.noSwitching as boolean,
    forcedDouble: t.forcedDouble as boolean,
  }
}

const BASE_ALWAYS = AI_FLAG_CHECK_BAD_MOVE | AI_FLAG_TRY_TO_FAINT | AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_FOE | AI_FLAG_SMART_SWITCHING | AI_FLAG_HP_AWARE | AI_FLAG_WILL_SUICIDE

describe('trainerAiFlags', () => {
  it('gives an ordinary trainer only the always-on base set', () => {
    // Winona 1 (no risky/preferStall/preferStatus/noSwitching set) -- verified
    // against trainers.json above the flags fixture is built from.
    expect(row('TRAINER_WINONA_1')).toEqual({ risky: false, preferStall: false, preferStatus: false, noSwitching: false, forcedDouble: false })
    expect(trainerAiFlags(row('TRAINER_WINONA_1'))).toBe(BASE_ALWAYS)
  })

  it('sets AI_FLAG_RISKY for Winona 2', () => {
    expect(row('TRAINER_WINONA_2').risky).toBe(true)
    expect(trainerAiFlags(row('TRAINER_WINONA_2'))).toBe(BASE_ALWAYS | AI_FLAG_RISKY)
  })

  it('sets AI_FLAG_DISABLE_SWITCHING for Trent 1', () => {
    expect(row('TRAINER_TRENT_1').noSwitching).toBe(true)
    expect(trainerAiFlags(row('TRAINER_TRENT_1'))).toBe(BASE_ALWAYS | AI_FLAG_DISABLE_SWITCHING)
  })

  it('sets AI_FLAG_STALL and AI_FLAG_PREFER_STATUS_MOVES for Roxanne 1', () => {
    const r = row('TRAINER_ROXANNE_1')
    expect(r.preferStall).toBe(true)
    expect(r.preferStatus).toBe(true)
    expect(trainerAiFlags(r)).toBe(BASE_ALWAYS | AI_FLAG_STALL | AI_FLAG_PREFER_STATUS_MOVES)
  })

  it('never sets AI_FLAG_DOUBLE_BATTLE -- that OR happens in battleAiSetupFlags, not here', () => {
    expect(trainerAiFlags(row('TRAINER_WINONA_2')) & AI_FLAG_DOUBLE_BATTLE).toBe(0)
  })
})

describe('battleAiSetupFlags', () => {
  it('adds AI_FLAG_DOUBLE_BATTLE when the trainer record is forcedDouble', () => {
    const forced: TrainerAiRow = { risky: false, preferStall: false, preferStatus: false, noSwitching: false, forcedDouble: true }
    expect(battleAiSetupFlags(forced, 0) & AI_FLAG_DOUBLE_BATTLE).not.toBe(0)
  })

  it('adds AI_FLAG_DOUBLE_BATTLE when battleTypeFlags carries BATTLE_TYPE_DOUBLE', () => {
    const notForced: TrainerAiRow = { risky: false, preferStall: false, preferStatus: false, noSwitching: false, forcedDouble: false }
    expect(battleAiSetupFlags(notForced, 1 << 0) & AI_FLAG_DOUBLE_BATTLE).not.toBe(0)
  })

  it('does not add AI_FLAG_DOUBLE_BATTLE for an ordinary singles trainer', () => {
    expect(battleAiSetupFlags(row('TRAINER_WINONA_1'), 0)).toBe(BASE_ALWAYS)
  })
})
