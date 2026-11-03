/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 142: unit tests for the opt-in FIELD terms in the expectimax leaf score
// -- Sandstorm/Hail chip, Grassy Terrain heal, Toxic Terrain chip, the
// rain/sun/terrain move-type boosts, and Trick Room. Every expected number is
// hand-derived from the cited C. The flat weights (TERRAIN_BOOST_VALUE,
// WEATHER_BOOST_VALUE, TRICK_ROOM_VALUE) are named MODEL CHOICES in
// expectimax.ts; the damage fractions, the immunity clauses, the countdowns and
// the speed-reversal are transcribed from battle_util.c /
// battle_script_commands.c / battle_main.c.
import { describe, expect, it } from 'vitest'

import {
  STATUS3_UNDERGROUND,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_PERMANENT,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
} from './constants'
import type { AbilitySlots } from '../abilities/dispatch'
import { DEFAULT_EXPECTIMAX, evaluateState, positionScore, statusScore } from './driver/expectimax'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { createRandomSource } from './rng'
import type { BattleSession } from './driver/session'
import type { BattleState } from './state'

const data = loadSimData()

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

const abilities = (ability: string): AbilitySlots => ({ ability, innates: [null, null, null] })

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

function setStatuses3(state: BattleState, side: 0 | 1, statuses3: number): void {
  state.battlers[side]!.statuses3 = statuses3
}

function setSpeed(state: BattleState, side: 0 | 1, spe: number): void {
  const battler = state.battlers[side]!
  battler.mon.rawStats = { ...battler.mon.rawStats, spe }
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

function setTrickRoom(state: BattleState, timer: number, started = false): void {
  state.field.statuses = STATUS_FIELD_TRICK_ROOM
  state.field.timers.trickRoomTimer = timer
  state.field.timers.started.trickRoom = started
}

const ROCK = ['ROCK', 'MYSTERY', 'MYSTERY'] as [string, string, string]
const ICE = ['ICE', 'MYSTERY', 'MYSTERY'] as [string, string, string]
const FLYING = ['NORMAL', 'FLYING', 'MYSTERY'] as [string, string, string]
const POISON = ['POISON', 'MYSTERY', 'MYSTERY'] as [string, string, string]
const STEEL = ['STEEL', 'MYSTERY', 'MYSTERY'] as [string, string, string]

const ONE_FOE = () => [mon('SPECIES_MACHAMP', ['MOVE_TACKLE'])]

describe('cycle 142 - sandstorm chip', () => {
  // Cmd_weatherdamage, battle_script_commands.c:10397-10416: alive,
  // WEATHER_HAS_EFFECT, not Magic Guard, then maxHP/16 (min 1) if not
  // IsSandImmune. ENDTURN_SANDSTORM, battle_util.c:1982-1996: a temporary
  // weather does `!started.weather && --weatherDuration == 0`; the tick that
  // reaches zero runs BattleScript_SandStormHailEnds (data/battle_scripts_1.s:
  // 7340-7344), which deals no damage. So duration 4 not started -> 3 damaging
  // ticks; started -> 4, capped by the model horizon 3.
  // 320 maxHP -> 320 / 16 = 20 -> 20 / 320 = 0.0625 per tick.
  it('temporary duration 4, not started -> 3 ticks -> 3 * 20/320 = 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK }) // player immune, so only the foe pays
    setWeather(s, WEATHER_SANDSTORM_TEMPORARY, 4, false)
    expect(statusScore(s)).toBeCloseTo(0.1875, 10)
  })

  it('started.weather true -> 4 ticks capped to 3 -> 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    setWeather(s, WEATHER_SANDSTORM_TEMPORARY, 4, true)
    expect(statusScore(s)).toBeCloseTo(0.1875, 10)
  })

  // duration 2: not started -> 1 tick (0.0625); started -> 2 ticks (0.125).
  it('duration 2 not started -> 1 tick -> 0.0625', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    setWeather(s, WEATHER_SANDSTORM_TEMPORARY, 2, false)
    expect(statusScore(s)).toBeCloseTo(0.0625, 10)
  })

  it('duration 2 started -> 2 ticks -> 0.125', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    setWeather(s, WEATHER_SANDSTORM_TEMPORARY, 2, true)
    expect(statusScore(s)).toBeCloseTo(0.125, 10)
  })

  it('duration 1 not started -> the ending tick deals no damage -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    setWeather(s, WEATHER_SANDSTORM_TEMPORARY, 1, false)
    expect(statusScore(s)).toBe(0)
  })

  it('permanent weather -> 3 ticks -> 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    expect(statusScore(s)).toBeCloseTo(0.1875, 10)
  })

  it('the foe chipped by the sandstorm scores positive for the player', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    expect(statusScore(s)).toBeGreaterThan(0)
  })

  it('the player chipped by the sandstorm scores negative', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 1, 0, { types: ROCK }) // foe immune, so only the player pays
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    expect(statusScore(s)).toBeCloseTo(-0.1875, 10)
  })

  // IsSandImmune's three type clauses (battle_script_commands.c:10376-10386).
  it('Rock / Ground / Steel active mons are immune -> 0', () => {
    for (const type of ['ROCK', 'GROUND', 'STEEL'] as const) {
      const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
      patchMon(s, 0, 0, { types: ROCK })
      patchMon(s, 1, 0, { types: [type, 'MYSTERY', 'MYSTERY'] })
      setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
      expect(statusScore(s)).toBe(0)
    }
  })

  it('Magic Guard is immune -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    patchMon(s, 1, 0, { abilities: abilities('ABILITY_MAGIC_GUARD') })
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    expect(statusScore(s)).toBe(0)
  })

  it('STATUS3_UNDERGROUND is immune -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    setStatuses3(s, 1, STATUS3_UNDERGROUND)
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    expect(statusScore(s)).toBe(0)
  })

  // WEATHER_HAS_EFFECT, include/battle_util.h:45-46.
  it('clearSkiesTimer > 0 turns the chip off -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    s.field.timers.clearSkiesTimer = 1
    expect(statusScore(s)).toBe(0)
  })

  it('Cloud Nine on the field turns the chip off -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    patchMon(s, 1, 0, { abilities: abilities('ABILITY_CLOUD_NINE') })
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    expect(statusScore(s)).toBe(0)
  })

  it('a weather bit that is clear ignores a stale duration -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK })
    s.field.weather = 0
    s.field.weatherDuration = 4
    s.field.timers.started.weather = false
    expect(statusScore(s)).toBe(0)
  })
})

describe('cycle 142 - hail chip', () => {
  // IsHailImmune, battle_script_commands.c:10388-10395: Ice plus underground/
  // underwater are the data-free clauses (Safety Goggles is a MODEL CHOICE
  // omission; no type list beyond Ice). Same maxHP/16.
  it('a non-Ice foe is chipped -> 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ICE })
    setWeather(s, WEATHER_HAIL_TEMPORARY, 4, true)
    expect(statusScore(s)).toBeCloseTo(0.1875, 10)
  })

  it('an Ice active mon is immune -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ICE })
    patchMon(s, 1, 0, { types: ICE })
    setWeather(s, WEATHER_HAIL_TEMPORARY, 4, true)
    expect(statusScore(s)).toBe(0)
  })
})

describe('cycle 142 - grassy terrain heal', () => {
  // ENDTURN_GRASSY_TERRAIN, battle_util.c:2102-2113 and
  // VARIOUS_CHECK_IF_GRASSY_TERRAIN_HEALS, battle_script_commands.c:6876-6886:
  // skip semi-invulnerable/full HP/fainted/non-grounded, else heal maxHP/16
  // (min 1). The clearing tick still heals. 320 maxHP -> 20 per tick.
  it('at 50% HP with 3 ticks -> 3 * 20/320 = 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { hp: 160 })
    setTerrain(s, STATUS_FIELD_GRASSY_TERRAIN, 5, false)
    expect(statusScore(s)).toBeCloseTo(0.1875, 10)
  })

  // The per-tick amount is the plain maxHP/16: one tick -> 20/320 = 0.0625.
  it('with a one-turn timer -> 20/320 = 0.0625', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { hp: 160 })
    setTerrain(s, STATUS_FIELD_GRASSY_TERRAIN, 1, false)
    expect(statusScore(s)).toBeCloseTo(0.0625, 10)
  })

  it('at full HP nothing heals -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    setTerrain(s, STATUS_FIELD_GRASSY_TERRAIN, 5, false)
    expect(statusScore(s)).toBe(0)
  })

  it('a Flying active mon is not grounded -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { hp: 160, types: FLYING })
    setTerrain(s, STATUS_FIELD_GRASSY_TERRAIN, 5, false)
    expect(statusScore(s)).toBe(0)
  })

  // The heal caps at the missing HP: missing 10 < 3 * 20.
  it('the heal caps at missing HP -> 10/320 = 0.03125', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { hp: 310 })
    setTerrain(s, STATUS_FIELD_GRASSY_TERRAIN, 5, false)
    expect(statusScore(s)).toBeCloseTo(0.03125, 10)
  })

  it('terrain bit clear with a timer set -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { hp: 160 })
    s.field.statuses = 0
    s.field.timers.terrainTimer = 5
    expect(statusScore(s)).toBe(0)
  })

  it('a healed foe scores negative for the player', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 1, 0, { hp: 160 })
    setTerrain(s, STATUS_FIELD_GRASSY_TERRAIN, 5, false)
    expect(statusScore(s)).toBeCloseTo(-0.1875, 10)
  })
})

describe('cycle 142 - toxic terrain chip', () => {
  // ENDTURN_TOXIC_TERRAIN, battle_util.c:2124-2146 +
  // BattleScript_ToxicTerrainDamages, data/battle_scripts_1.s:10167-10175
  // (`hpfractiontodamage BS_STACK_1, 16`). FILTER chain: alive, not Magic
  // Guard, IsBattlerTerrainAffected, not AbilityBlocksToxicTerrain, not
  // Poison, not Steel. maxHP/16, capped at the current HP.
  //
  // Unlike Grassy Terrain, the CLEARING tick does not chip: the countdown and
  // the `gFieldStatuses &= ~STATUS_FIELD_TOXIC_TERRAIN` clear (:2128-2133) run
  // first, and the damage loop's IsBattlerTerrainAffected filter (:2134-2139)
  // tests the field bit, which is already gone. So a non-permanent terrain
  // chips `terrainTimer - 1` times when not started (`terrainTimer` when the
  // just-set turn is included), capped at STATUS_HORIZON_TURNS = 3.
  const isolatePlayer = (s: BattleState) => patchMon(s, 1, 0, { types: POISON }) // foe immune

  it('timer 2 not started -> 1 chip * 20/320 = 0.0625', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    isolatePlayer(s)
    setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 2, false)
    expect(statusScore(s)).toBeCloseTo(-0.0625, 10)
  })

  it('timer 1 not started -> the clearing tick is the first tick -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    isolatePlayer(s)
    setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 1, false)
    expect(statusScore(s)).toBe(0)
  })

  it('timer 5 not started -> 4 chips capped to 3 -> 3 * 20/320 = 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    isolatePlayer(s)
    setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 5, false)
    expect(statusScore(s)).toBeCloseTo(-0.1875, 10)
  })

  it('timer 4 not started -> 3 chips -> 3 * 20/320 = 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    isolatePlayer(s)
    setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 4, false)
    expect(statusScore(s)).toBeCloseTo(-0.1875, 10)
  })

  it('timer 3 not started -> 2 chips -> 2 * 20/320 = 0.125', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    isolatePlayer(s)
    setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 3, false)
    expect(statusScore(s)).toBeCloseTo(-0.125, 10)
  })

  it('timer 3 with started.terrain -> 3 chips -> 3 * 20/320 = 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    isolatePlayer(s)
    setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 3, true)
    expect(statusScore(s)).toBeCloseTo(-0.1875, 10)
  })

  it('Poison / Steel / Flying active mons are immune -> 0', () => {
    for (const types of [POISON, STEEL, FLYING]) {
      const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
      patchMon(s, 0, 0, { types })
      isolatePlayer(s)
      setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 5, false)
      expect(statusScore(s)).toBe(0)
    }
  })

  it('Poison Heal is immune -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { abilities: abilities('ABILITY_POISON_HEAL') })
    isolatePlayer(s)
    setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 5, false)
    expect(statusScore(s)).toBe(0)
  })

  // ENDTURN_TOXIC_TERRAIN's `!IsAbilityOnField(ABILITY_STENCH)` gate on the
  // timer's DECREMENT (:2127): with Stench on the field the timer never ticks,
  // so the term uses the full model horizon. A one-turn timer not started would
  // otherwise chip 0 times (the first tick clears the terrain before the damage
  // loop); with the foe holding Stench it chips 3 times.
  it('Stench on the field freezes the countdown -> 3 ticks -> 0.1875', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 1, 0, { abilities: abilities('ABILITY_STENCH') })
    setTerrain(s, STATUS_FIELD_TOXIC_TERRAIN, 1, false)
    expect(statusScore(s)).toBeCloseTo(-0.1875, 10)
  })
})

describe('cycle 142 - trick room', () => {
  // battle_main.c:4325 reverses effectiveSpeed under Trick Room, so the slower
  // active mon moves first. TRICK_ROOM_VALUE = 0.1 per turn (MODEL CHOICE),
  // capped by STATUS_HORIZON_TURNS; ENDTURN_TRICK_ROOM, battle_util.c:2051-2056
  // is `!started.trickRoom && --trickRoomTimer == 0`, so a just-set room keeps
  // its full 5-turn timer.
  it('player slower -> +0.1 * min(5, 3) = +0.3', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    setSpeed(s, 0, 50)
    setSpeed(s, 1, 150)
    setTrickRoom(s, 5)
    expect(statusScore(s)).toBeCloseTo(0.3, 10)
  })

  it('player faster -> -0.3', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    setSpeed(s, 0, 150)
    setSpeed(s, 1, 50)
    setTrickRoom(s, 5)
    expect(statusScore(s)).toBeCloseTo(-0.3, 10)
  })

  it('equal speed -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    setSpeed(s, 0, 100)
    setSpeed(s, 1, 100)
    setTrickRoom(s, 5)
    expect(statusScore(s)).toBe(0)
  })

  it('timer 2 -> +0.2', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    setSpeed(s, 0, 50)
    setSpeed(s, 1, 150)
    setTrickRoom(s, 2)
    expect(statusScore(s)).toBeCloseTo(0.2, 10)
  })

  it('bit clear with a timer set -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    setSpeed(s, 0, 50)
    setSpeed(s, 1, 150)
    s.field.statuses = 0
    s.field.timers.trickRoomTimer = 5
    expect(statusScore(s)).toBe(0)
  })

  // IsTrickRoomActive, battle_util.c:8671-8680: Clueless anywhere -> false.
  it('Clueless on the field -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    setSpeed(s, 0, 50)
    setSpeed(s, 1, 150)
    patchMon(s, 1, 0, { abilities: abilities('ABILITY_CLUELESS') })
    setTrickRoom(s, 5)
    expect(statusScore(s)).toBe(0)
  })
})

describe('cycle 142 - terrain move-type boost', () => {
  // battle_util.c:7064-7090: IsBattlerTerrainAffected(attacker) and the terrain
  // bit's own move type -> MUL_MODIFIER(1.3). TERRAIN_BOOST_VALUE = 0.05 per
  // turn (MODEL CHOICE). The caller must pass the move lookup.
  const lookup = data.dataContext.move

  it('Electric Terrain + an Electric damaging move -> +3 * 0.05 = +0.15', () => {
    const s = fresh(session(['MOVE_THUNDERBOLT'], ONE_FOE()))
    setTerrain(s, STATUS_FIELD_ELECTRIC_TERRAIN, 5, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0.15, 10)
  })

  it('a status Electric move does not count -> 0', () => {
    const s = fresh(session(['MOVE_THUNDER_WAVE'], ONE_FOE()))
    setTerrain(s, STATUS_FIELD_ELECTRIC_TERRAIN, 5, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0, 10)
  })

  it('a non-matching damaging move does not count -> 0', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    setTerrain(s, STATUS_FIELD_ELECTRIC_TERRAIN, 5, false)
    expect(statusScore(s, lookup)).toBeCloseTo(0, 10)
  })

  it('the foe boost is negative for the player -> -0.15', () => {
    const s = fresh(session(['MOVE_TACKLE'], [mon('SPECIES_MACHAMP', ['MOVE_THUNDERBOLT'])]))
    setTerrain(s, STATUS_FIELD_ELECTRIC_TERRAIN, 5, false)
    expect(statusScore(s, lookup)).toBeCloseTo(-0.15, 10)
  })

  it('without the lookup the boost is 0', () => {
    const s = fresh(session(['MOVE_THUNDERBOLT'], ONE_FOE()))
    setTerrain(s, STATUS_FIELD_ELECTRIC_TERRAIN, 5, false)
    expect(statusScore(s)).toBe(0)
  })
})

describe('cycle 142 - rain/sun move-type boost', () => {
  // battle_util.c:7562-7598: rain boosts Water and halves Fire; sun the
  // reverse. The multipliers are the C's; WEATHER_BOOST_VALUE = 0.05 per turn
  // is a MODEL CHOICE. Only the active mon's known damaging moves count.
  const lookup = data.dataContext.move

  it('rain + a Water damaging move -> +0.15', () => {
    const s = fresh(session(['MOVE_SURF'], ONE_FOE()))
    setWeather(s, WEATHER_RAIN_TEMPORARY, 4, true)
    expect(statusScore(s, lookup)).toBeCloseTo(0.15, 10)
  })

  it('rain halves the player Fire move -> -0.15', () => {
    const s = fresh(session(['MOVE_FLAMETHROWER'], ONE_FOE()))
    setWeather(s, WEATHER_RAIN_TEMPORARY, 4, true)
    expect(statusScore(s, lookup)).toBeCloseTo(-0.15, 10)
  })

  it('sun boosts the player Fire move -> +0.15', () => {
    const s = fresh(session(['MOVE_FLAMETHROWER'], ONE_FOE()))
    setWeather(s, WEATHER_SUN_TEMPORARY, 4, true)
    expect(statusScore(s, lookup)).toBeCloseTo(0.15, 10)
  })

  it('sun halves the player Water move -> -0.15', () => {
    const s = fresh(session(['MOVE_SURF'], ONE_FOE()))
    setWeather(s, WEATHER_SUN_TEMPORARY, 4, true)
    expect(statusScore(s, lookup)).toBeCloseTo(-0.15, 10)
  })

  it('clearSkiesTimer > 0 turns the boost off -> 0', () => {
    const s = fresh(session(['MOVE_SURF'], ONE_FOE()))
    setWeather(s, WEATHER_RAIN_TEMPORARY, 4, true)
    s.field.timers.clearSkiesTimer = 1
    expect(statusScore(s, lookup)).toBe(0)
  })
})

describe('cycle 142 - evaluateState gating', () => {
  const withTerms = { ...DEFAULT_EXPECTIMAX, statusTerms: true }

  // Combined case, all hand-derived:
  //   player Rock (sand-immune) at 160/320; foe Machamp full HP
  //   sandstorm permanent          -> foe chip 3 * 20/320 = +0.1875
  //   grassy terrain timer 5       -> player heal 3 * 20/320 = -0.1875 (burden)
  //   trick room, player slower    -> +0.1 * 3 = +0.3
  //   sum = 0.1875 + 0.1875 + 0.3 = 0.675
  // (No move lookup is passed, so the move-type boosts are 0.)
  it('with terms on, the opt-in score is positionScore plus the hand number', () => {
    const s = fresh(session(['MOVE_TACKLE'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK, hp: 160 })
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    setTerrain(s, STATUS_FIELD_GRASSY_TERRAIN, 5, false)
    setSpeed(s, 0, 50)
    setSpeed(s, 1, 150)
    s.field.statuses |= STATUS_FIELD_TRICK_ROOM
    s.field.timers.trickRoomTimer = 5
    expect(evaluateState(s, withTerms) - positionScore(s)).toBeCloseTo(0.675, 10)
    expect(evaluateState(s, withTerms) - positionScore(s)).toBeCloseTo(statusScore(s), 10)
  })

  it('with the option off, none of the field terms change evaluateState', () => {
    const s = fresh(session(['MOVE_THUNDERBOLT'], ONE_FOE()))
    patchMon(s, 0, 0, { types: ROCK, hp: 160 })
    setWeather(s, WEATHER_SANDSTORM_PERMANENT, 0, false)
    setTerrain(s, STATUS_FIELD_ELECTRIC_TERRAIN, 5, false)
    setSpeed(s, 0, 50)
    setSpeed(s, 1, 150)
    s.field.statuses |= STATUS_FIELD_TRICK_ROOM
    s.field.timers.trickRoomTimer = 5
    expect(evaluateState(s)).toBe(positionScore(s))
  })

  it('DEFAULT_EXPECTIMAX leaves statusTerms unset', () => {
    expect(DEFAULT_EXPECTIMAX.statusTerms).toBeFalsy()
  })
})
