/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 142b: the corrected weather/terrain turn counts in the opt-in expectimax
// field terms. Every expected number is hand-derived from the cited C:
//
// - The rain/sun move-type multiplier (battle_util.c:7562-7607) is applied in
//   damage calculation for every move while the weather bit is set, and the bit
//   is cleared only by the end-of-turn decrement that reaches 0 (ENDTURN_RAIN
//   :1960-1976, ENDTURN_SUN :1997-2007), so a temporary weather boosts for
//   `weatherDuration` more turns. WEATHER_BOOST_VALUE = 0.05 per turn is a
//   MODEL CHOICE, and STATUS_HORIZON_TURNS caps the count at 3.
// - `started.weather` / `started.terrain` are zeroed at the start of every turn
//   (battle_main.c:4589-4595 `ZERO(gFieldTimers.started)`, sim turn.ts:4495
//   `clearStartedFlags`), so a leaf scored after `stepTurn` never has them hold
//   back a future decrement: they must not change any count here.
import { describe, expect, it } from 'vitest'

import {
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
} from './constants'
import type { AbilitySlots } from '../abilities/dispatch'
import { statusScore } from './driver/expectimax'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { createRandomSource } from './rng'
import type { BattleSession } from './driver/session'
import type { BattleState } from './state'

const data = loadSimData()
const lookup = data.dataContext.move

const mon = (species: string, moves: string[]): TrainerMonData => ({
  species,
  item: 'ITEM_NONE',
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves,
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
})

const parties = (mons: TrainerMonData[]) => ({ ace: mons, elite: mons, hell: mons })

const opponent = (mons: TrainerMonData[]): TrainerData => ({
  ...data.trainersById.get('TRAINER_SAWYER_1')!,
  // The scenarios never want an AI switch to move the bench around.
  noSwitching: true,
  parties: parties(mons),
})

/** The species is irrelevant to the field terms: types/abilities/speeds are
 * patched per-test. Snorlax is a plain grounded Normal type; Machamp a plain
 * grounded Fighting type, both non-immune to every weather. */
function session(playerMoves: string[], foeMons: TrainerMonData[]): BattleSession {
  return createSession({
    data,
    playerParty: buildPlayerParty([{ species: 'SPECIES_SNORLAX', level: 50, moves: playerMoves }], 50, data),
    opponentTrainer: opponent(foeMons),
    rng: createRandomSource(1),
  })
}

/** Writes a patch on BOTH copies of a party slot (active battler mon and the
 * party mon). `statuses3` lives only on the active battler, so it is separate. */
function patchMon(
  state: BattleState,
  side: 0 | 1,
  partyIndex: number,
  patch: {
    status1?: number
    hp?: number
    maxHp?: number
    types?: [string, string, string]
    abilities?: AbilitySlots
    rawStats?: { hp: number; atk: number; def: number; spatk: number; spdef: number; spe: number }
  },
): void {
  Object.assign(state.sides[side].party[partyIndex]!, patch)
  const active = state.battlers[side]
  if (active && active.partyIndex === partyIndex) Object.assign(active.mon, patch)
}

/** A foe (and player) at maxHp 320 so every fraction below is a round number. */
function fresh(s: BattleSession): BattleState {
  patchMon(s.state, 0, 0, { hp: 320, maxHp: 320 })
  patchMon(s.state, 1, 0, { hp: 320, maxHp: 320 })
  return s.state
}

/** Sets the field weather and its countdown. */
function setWeather(state: BattleState, weather: number, duration: number, started: boolean): void {
  state.field.weather = weather
  state.field.weatherDuration = duration
  state.field.timers.started.weather = started
}

/** Sets one terrain bit and its timer. */
function setTerrain(state: BattleState, terrain: number, timer: number, started: boolean, permanent = false): void {
  state.field.statuses = terrain | (permanent ? 1 << 12 : 0) // STATUS_FIELD_TERRAIN_PERMANENT == 1 << 12
  state.field.timers.terrainTimer = timer
  state.field.timers.started.terrain = started
}

const ONE_FOE = () => [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]

describe('cycle 142b - rain/sun boost lasts weatherDuration turns', () => {
  // 320 maxHP everywhere; the move-type boosts are the only live term (the
  // player Snorlax is Normal, the foe Machamp Fighting, and there is no chip
  // under rain/sun). A Water move under rain is `-(0.05 * turns)` of player
  // burden, so statusScore is positive.

  it('rain + Surf, duration 3 -> 3 turns -> +0.15', () => {
    const s = fresh(session(['MOVE_SURF'], ONE_FOE()))
    setWeather(s, WEATHER_RAIN_TEMPORARY, 3, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0.15, 10)
  })

  it('rain + Surf, duration 2 -> 2 turns -> +0.10', () => {
    const s = fresh(session(['MOVE_SURF'], ONE_FOE()))
    setWeather(s, WEATHER_RAIN_TEMPORARY, 2, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0.1, 10)
  })

  // The clearing turn still counts: the decrement runs at the END of it, so
  // that turn's moves are already boosted.
  it('rain + Surf, duration 1 -> 1 turn -> +0.05', () => {
    const s = fresh(session(['MOVE_SURF'], ONE_FOE()))
    setWeather(s, WEATHER_RAIN_TEMPORARY, 1, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0.05, 10)
  })

  it('sun + Flamethrower, duration 3 -> 3 turns -> +0.15', () => {
    const s = fresh(session(['MOVE_FLAMETHROWER'], ONE_FOE()))
    setWeather(s, WEATHER_SUN_TEMPORARY, 3, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0.15, 10)
  })

  it('sun + Flamethrower, duration 2 -> 2 turns -> +0.10', () => {
    const s = fresh(session(['MOVE_FLAMETHROWER'], ONE_FOE()))
    setWeather(s, WEATHER_SUN_TEMPORARY, 2, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0.1, 10)
  })

  it('sun + Flamethrower, duration 1 -> 1 turn -> +0.05', () => {
    const s = fresh(session(['MOVE_FLAMETHROWER'], ONE_FOE()))
    setWeather(s, WEATHER_SUN_TEMPORARY, 1, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0.05, 10)
  })

  // The multiplier is gated on the weather bit, not the stale timer.
  it('a weather bit that is clear ignores a stale duration -> 0', () => {
    const s = fresh(session(['MOVE_SURF'], ONE_FOE()))
    setWeather(s, 0, 3, false)
    expect(statusScore(s, lookup)).toBe(0)
  })
})

describe('cycle 142b - started changes no count', () => {
  // Grassy heals `terrainTimer` times: ENDTURN_GRASSY_TERRAIN, battle_util.c:
  // 2102-2113, still runs BattleScript_GrassyTerrainHeals on the clearing tick,
  // and VARIOUS_CHECK_IF_GRASSY_TERRAIN_HEALS (battle_script_commands.c:
  // 6876-6886) never tests the field bit. 320 maxHP -> 20 per tick, and the
  // player at 160/320 has room for all three.
  it('Grassy heal, timer 3, 50% HP: 3 * 20/320 = 0.1875 with started true and false', () => {
    const off = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(off, 0, 0, { hp: 160 })
    setTerrain(off, STATUS_FIELD_GRASSY_TERRAIN, 3, false)

    const on = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(on, 0, 0, { hp: 160 })
    setTerrain(on, STATUS_FIELD_GRASSY_TERRAIN, 3, true)

    expect(statusScore(off)).toBeCloseTo(0.1875, 10)
    expect(statusScore(on)).toBeCloseTo(0.1875, 10)
  })

  // The terrain boost applies during the moves of every turn the bit is set
  // (IsBattlerTerrainAffected, battle_util.c:7064-7090), so a timer 2 leaves
  // 2 boosted turns: 2 * TERRAIN_BOOST_VALUE 0.05 = 0.10.
  it('Electric Terrain + Thunderbolt, timer 2 -> 2 turns -> +0.10', () => {
    const s = fresh(session(['MOVE_THUNDERBOLT'], ONE_FOE()))
    setTerrain(s, STATUS_FIELD_ELECTRIC_TERRAIN, 2, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0.1, 10)
  })
})
