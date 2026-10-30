/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 115b: field, weather and hazard status effects (12). Each effect is read against the C
// (data/battle_scripts_1.s, src/battle_script_commands.c, src/battle_util.c and the asm macros)
// and proven by a forced scenario whose numbers are derived by hand. Turn timers are captured
// mid-turn (runSnap) where the end-turn phase would otherwise decrement them; the `started.*`
// flag the setter writes suppresses that decrement for the turn it is set, exactly as the C does.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  SCREEN_DURATION,
  SIDE_STATUS_MIST,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_TAILWIND,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS1_TOXIC_POISON,
  STATUS2_SUBSTITUTE,
  STATUS3_LEECHSEED,
  STATUS3_LEECHSEED_BATTLER,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  TAILWIND_DURATION,
  TERRAIN_DURATION,
  TERRAIN_DURATION_EXTENDED,
  TRICK_ROOM_DURATION,
  WEATHER_DURATION,
  WEATHER_DURATION_EXTENDED,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_RAIN_PRIMAL,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_PRIMAL,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import { groundingFor } from './driver/session'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const RATIOS = simData.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }
const only = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

/** Every draw is 0 (accuracy always hits); `calls` counts draws. */
function countRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
  })
}

function useMove(target: number, moveId: string): ChosenAction {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  const view: TurnOrderMoveView = {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(simData, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
  }
}

const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

const THIS_FILE = 'web/src/engine/sim/cycle115bFieldEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect

/** The user (battler 0, Mudkip) knows only `moveId` with 10 PP. */
const user = (moveId: string, overrides: Partial<SimBattleMon> = {}) =>
  monFor('SPECIES_MUDKIP', {
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 150 },
    moves: [moveId, null, null, null],
    pp: [10, 0, 0, 0],
    ...overrides,
  })
const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

/** One turn: the user (battler 0) uses `moveId` on battler 1, the foe does nothing. */
function runVs(state: BattleState, moveId: string): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedDamage(0)))
}
/**
 * The user acts first, then the foe Tackles; `snap` runs when the foe's Tackle resolves, i.e.
 * after the user's move and before any end-of-turn timer ticks.
 */
function runSnap<T>(state: BattleState, moveId: string, snap: () => T): T {
  let seen: T | undefined
  const damage: DamageResolver = {
    resolve: () => {
      seen = snap()
      return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
    },
  }
  executeTurn(state, [useMove(1, moveId), useMove(0, 'MOVE_TACKLE')], loopDeps(state, damage))
  return seen as T
}
const FAST = { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 } }

const ppOf = (state: BattleState) => state.battlers[0]!.mon.pp[0]

describe('cycle 115b - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_TAILWIND', 'EFFECT_TAILWIND'],
    ['MOVE_TRICK_ROOM', 'EFFECT_TRICK_ROOM'],
    ['MOVE_RAIN_DANCE', 'EFFECT_RAIN_DANCE'],
    ['MOVE_SUNNY_DAY', 'EFFECT_SUNNY_DAY'],
    ['MOVE_SANDSTORM', 'EFFECT_SANDSTORM'],
    ['MOVE_HAIL', 'EFFECT_HAIL'],
    ['MOVE_SAFEGUARD', 'EFFECT_SAFEGUARD'],
    ['MOVE_MIST', 'EFFECT_MIST'],
    ['MOVE_LEECH_SEED', 'EFFECT_LEECH_SEED'],
    ['MOVE_TOXIC_SPIKES', 'EFFECT_TOXIC_SPIKES'],
    ['MOVE_ELECTRIC_TERRAIN', 'EFFECT_ELECTRIC_TERRAIN'],
    ['MOVE_GRASSY_TERRAIN', 'EFFECT_GRASSY_TERRAIN'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})

// BattleScript_EffectTailwind data/battle_scripts_1.s:2693-2704, Cmd_settailwind
// src/battle_script_commands.c:10961-10973. TAILWIND_DURATION = 3 (include/battle_util.h:66).
describe('cycle 115b - Tailwind', () => {
  const sideNow = (state: BattleState) => ({
    flag: hasFlag(state.sides[0].statuses, SIDE_STATUS_TAILWIND),
    timer: state.sides[0].timers.tailwindTimer,
    by: state.sides[0].timers.tailwindBattlerId,
  })

  it('sets the user side flag, timer 3 and setter = battler 0; the foe side is untouched', () => {
    const state = battle(user('MOVE_TAILWIND', FAST), foe(), countRng())
    const seen = runSnap(state, 'MOVE_TAILWIND', () => sideNow(state))
    expect(seen).toEqual({ flag: true, timer: TAILWIND_DURATION, by: 0 })
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_TAILWIND)).toBe(false)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails (settailwind -> BattleScript_ButItFailed): timer/owner unchanged, PP still spent', () => {
    const state = battle(user('MOVE_TAILWIND', FAST), foe(), countRng())
    state.sides[0].statuses |= SIDE_STATUS_TAILWIND
    state.sides[0].timers.tailwindTimer = 2
    state.sides[0].timers.tailwindBattlerId = 1
    const seen = runSnap(state, 'MOVE_TAILWIND', () => sideNow(state))
    expect(seen).toEqual({ flag: true, timer: 2, by: 1 })
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectTrickRoom data/battle_scripts_1.s:2638-2655, HandleRoomMove / Cmd_setroom
// src/battle_script_commands.c:11866-11900. TRICK_ROOM_DURATION = 5 (include/battle_util.h:56).
describe('cycle 115b - Trick Room', () => {
  const fieldNow = (state: BattleState) => ({
    flag: hasFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM),
    timer: state.field.timers.trickRoomTimer,
  })

  it('sets STATUS_FIELD_TRICK_ROOM with timer 5 and started.trickRoom (:11883)', () => {
    // Trick Room has priority -7, so it moves last; a one-sided turn keeps the assertion direct.
    // started.trickRoom suppresses ENDTURN_TRICK_ROOM's decrement on the turn it is set.
    const state = battle(user('MOVE_TRICK_ROOM'), foe(), countRng())
    runVs(state, 'MOVE_TRICK_ROOM')
    expect(fieldNow(state)).toEqual({ flag: true, timer: TRICK_ROOM_DURATION })
    expect(state.field.timers.started.trickRoom).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use while it runs toggles it OFF and zeroes the timer (:11868-11871)', () => {
    const state = battle(user('MOVE_TRICK_ROOM'), foe(), countRng())
    state.field.statuses |= STATUS_FIELD_TRICK_ROOM
    state.field.timers.trickRoomTimer = 4
    runVs(state, 'MOVE_TRICK_ROOM')
    expect(fieldNow(state)).toEqual({ flag: false, timer: 0 })
    expect(ppOf(state)).toBe(9)
  })

  it('a permanent room (timer > 10) fails instead of toggling off (:11881-11883)', () => {
    const state = battle(user('MOVE_TRICK_ROOM'), foe(), countRng())
    state.field.statuses |= STATUS_FIELD_TRICK_ROOM
    state.field.timers.trickRoomTimer = 11
    runVs(state, 'MOVE_TRICK_ROOM')
    // The move failed; the room survives. ENDTURN_TRICK_ROOM then ticks 11 -> 10.
    expect(fieldNow(state)).toEqual({ flag: true, timer: 10 })
    expect(ppOf(state)).toBe(9)
  })
})

// Weather scripts: BattleScript_EffectRainDance :5505-5511, SunnyDay :5520-5527, Sandstorm
// :5117-5123, Hail :6048-6055. Each is `checkprimalweather BattleScript_MoveEnd` then
// `setbattleweather ENUM_WEATHER_X, BattleScript_ButItFailed, TRUE`
// (asm/macros/battle_script.inc:2297-2306 -> VARIOUS_SET_WEATHER,
// src/battle_script_commands.c:8634-8644 -> TryChangeBattleWeather, src/battle_util.c:3721-3743).
// WEATHER_DURATION = 8, WEATHER_DURATION_EXTENDED = 12 (include/battle_util.h:50-51).
describe.each([
  ['MOVE_RAIN_DANCE', WEATHER_RAIN_TEMPORARY, 'ITEM_DAMP_ROCK'],
  ['MOVE_SUNNY_DAY', WEATHER_SUN_TEMPORARY, 'ITEM_HEAT_ROCK'],
  ['MOVE_SANDSTORM', WEATHER_SANDSTORM_TEMPORARY, 'ITEM_SMOOTH_ROCK'],
  ['MOVE_HAIL', WEATHER_HAIL_TEMPORARY, 'ITEM_ICY_ROCK'],
] as const)('cycle 115b - %s', (moveId, weather, rock) => {
  it('sets its weather flag, started.weather and duration 8 (:3731-3737)', () => {
    const state = battle(user(moveId), foe(), countRng())
    runVs(state, moveId)
    expect(state.field.weather).toBe(weather)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
    expect(ppOf(state)).toBe(9)
  })

  it(`the matching ${rock} extends the duration to 12 (:3734-3736)`, () => {
    const state = battle(user(moveId, { itemId: rock }), foe(), countRng())
    runVs(state, moveId)
    expect(state.field.weather).toBe(weather)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION_EXTENDED)
  })

  it('fails when that weather is already up (:3731): flag survives, timer only end-turn ticks 3 -> 2', () => {
    const state = battle(user(moveId), foe(), countRng())
    state.field.weather = weather
    state.field.weatherDuration = 3
    runVs(state, moveId)
    expect(state.field.weather).toBe(weather)
    expect(state.field.weatherDuration).toBe(2) // the move did not reset it; ENDTURN_<weather> ticked it
    expect(ppOf(state)).toBe(9)
  })
})

describe('cycle 115b - weather moves under primal weather (checkprimalweather)', () => {
  it('Rain Dance under primal sun ends with no change even for a Desolate Land user (macro is unconditional)', () => {
    // asm/macros/battle_script.inc:2512-2513 jumps to onFail on WEATHER_SUN_PRIMAL before
    // setbattleweather runs; it never consults BATTLER_HAS_ABILITY, unlike battle_util.c:3725-3727.
    const state = battle(user('MOVE_RAIN_DANCE', { abilities: only('ABILITY_DESOLATE_LAND') }), foe(), countRng())
    state.field.weather = WEATHER_SUN_PRIMAL
    state.field.weatherDuration = 255
    runVs(state, 'MOVE_RAIN_DANCE')
    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(state.field.weatherDuration).toBe(255)
    expect(ppOf(state)).toBe(9)
  })

  it('Sunny Day under primal rain is blocked for an ordinary user too', () => {
    const state = battle(user('MOVE_SUNNY_DAY'), foe(), countRng())
    state.field.weather = WEATHER_RAIN_PRIMAL
    runVs(state, 'MOVE_SUNNY_DAY')
    expect(state.field.weather).toBe(WEATHER_RAIN_PRIMAL)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSafeguard data/battle_scripts_1.s:5246-5252, Cmd_setsafeguard
// src/battle_script_commands.c:11234-11248. Timer is the literal 5 in the C (:11242).
describe('cycle 115b - Safeguard', () => {
  const sideNow = (state: BattleState) => ({
    flag: hasFlag(state.sides[0].statuses, SIDE_STATUS_SAFEGUARD),
    timer: state.sides[0].timers.safeguardTimer,
    by: state.sides[0].timers.safeguardBattlerId,
  })

  it('sets the side flag, safeguardTimer 5, setter 0 and started.safeguard (:11240-11243)', () => {
    const state = battle(user('MOVE_SAFEGUARD', FAST), foe(), countRng())
    const seen = runSnap(state, 'MOVE_SAFEGUARD', () => sideNow(state))
    expect(seen).toEqual({ flag: true, timer: SCREEN_DURATION, by: 0 })
    expect(state.sides[0].timers.started.safeguard).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails with MOVE_RESULT_MISSED (:11235-11238): timer/owner unchanged, PP spent', () => {
    const state = battle(user('MOVE_SAFEGUARD', FAST), foe(), countRng())
    state.sides[0].statuses |= SIDE_STATUS_SAFEGUARD
    state.sides[0].timers.safeguardTimer = 3
    state.sides[0].timers.safeguardBattlerId = 1
    expect(runSnap(state, 'MOVE_SAFEGUARD', () => sideNow(state))).toEqual({ flag: true, timer: 3, by: 1 })
    expect(ppOf(state)).toBe(9)
  })

  it('a status move into a Safeguarded side is blocked (IsStatusImmune, battle_util.c:5027)', () => {
    const state = battle(user('MOVE_SAFEGUARD'), foe({ moves: ['MOVE_TOXIC', null, null, null], pp: [10, 0, 0, 0] }), countRng())
    executeTurn(state, [useMove(0, 'MOVE_SAFEGUARD'), useMove(0, 'MOVE_TOXIC')], loopDeps(state, fixedDamage(0)))
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SAFEGUARD)).toBe(true)
    expect(state.battlers[0]!.mon.status1 & STATUS1_TOXIC_POISON).toBe(0)
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })
})

// BattleScript_EffectMist data/battle_scripts_1.s:4179-4187, Cmd_setmist
// src/battle_script_commands.c:10456-10468. Fails on mistTimer != 0, sets SCREEN_DURATION (5).
describe('cycle 115b - Mist', () => {
  const sideNow = (state: BattleState) => ({
    flag: hasFlag(state.sides[0].statuses, SIDE_STATUS_MIST),
    timer: state.sides[0].timers.mistTimer,
    by: state.sides[0].timers.mistBattlerId,
  })

  it('sets the side flag, mistTimer 5, setter 0 and started.mist (:10461-10465)', () => {
    const state = battle(user('MOVE_MIST', FAST), foe(), countRng())
    expect(runSnap(state, 'MOVE_MIST', () => sideNow(state))).toEqual({ flag: true, timer: SCREEN_DURATION, by: 0 })
    expect(state.sides[0].timers.started.mist).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails while mistTimer is nonzero (:10457-10459): timer/owner unchanged, PP spent', () => {
    const state = battle(user('MOVE_MIST', FAST), foe(), countRng())
    state.sides[0].statuses |= SIDE_STATUS_MIST
    state.sides[0].timers.mistTimer = 2
    state.sides[0].timers.mistBattlerId = 1
    expect(runSnap(state, 'MOVE_MIST', () => sideNow(state))).toEqual({ flag: true, timer: 2, by: 1 })
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectLeechSeed data/battle_scripts_1.s:4579-4590, Cmd_setseeded
// src/battle_script_commands.c:9341-9355. Accuracy is 90 (moves.json), countRng draws 0 (hit).
describe('cycle 115b - Leech Seed', () => {
  it('seeds a non-Grass target, storing the seeder in the low two bits (:9351-9353)', () => {
    const state = battle(user('MOVE_LEECH_SEED'), foe(), countRng())
    runVs(state, 'MOVE_LEECH_SEED')
    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(STATUS3_LEECHSEED)
    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED_BATTLER).toBe(0) // battler 0 seeded it
    expect(ppOf(state)).toBe(9)
  })

  it('fails on a Grass-type target (:9346-9349), PP still spent', () => {
    const state = battle(user('MOVE_LEECH_SEED'), foe({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] }), countRng())
    runVs(state, 'MOVE_LEECH_SEED')
    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the target is already seeded (:9342-9345): the original seeder stays', () => {
    const state = battle(user('MOVE_LEECH_SEED'), foe(), countRng())
    state.battlers[1]!.statuses3 |= STATUS3_LEECHSEED | 1 // seeded by battler 1
    runVs(state, 'MOVE_LEECH_SEED')
    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(STATUS3_LEECHSEED)
    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED_BATTLER).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute blocks it before the accuracy check (jumpifsubstituteblocks :4583)', () => {
    const state = battle(user('MOVE_LEECH_SEED'), foe({ status2: STATUS2_SUBSTITUTE }), countRng())
    runVs(state, 'MOVE_LEECH_SEED')
    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  // The per-turn drain/heal is already proven in moveEffectsRecovery.test.ts:469-505
  // (ENDTURN_LEECH_SEED, battle_util.c:2472-2486); not re-derived here.
})

// BattleScript_EffectToxicSpikes data/battle_scripts_1.s:2616-2624, Cmd_settoxicspikes
// src/battle_script_commands.c:11820-11829. Applies to the TARGET side, max 2 layers.
describe('cycle 115b - Toxic Spikes', () => {
  it('lays 1 then 2 layers on the target side; a third fails; PP is spent every time (:11822-11826)', () => {
    const state = battle(user('MOVE_TOXIC_SPIKES'), foe(), countRng())
    const layers: number[] = []
    for (let i = 0; i < 3; i++) {
      runVs(state, 'MOVE_TOXIC_SPIKES')
      layers.push(state.sides[1].timers.toxicSpikesAmount)
      expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(true)
      expect(ppOf(state)).toBe(9 - i)
    }
    expect(layers).toEqual([1, 2, 2])
    expect(state.sides[0].timers.toxicSpikesAmount).toBe(0)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(false)
  })

  // The switch-in half (1 layer -> STATUS1_POISON, 2 layers -> STATUS1_TOXIC_POISON, grounded
  // Poison types absorb them) is already proven in hazards.test.ts:366-409; not re-derived here.
})

// BattleScript_Effect{Misty,Grassy,Electric,Psychic}Terrain data/battle_scripts_1.s:2192-2206,
// setterrain -> VARIOUS_SET_TERRAIN (src/battle_script_commands.c:7298-7300) -> HandleTerrainMove
// (src/battle_script_commands.c:6404-6463). Fails only when the same terrain is already up;
// otherwise all terrain bits are cleared, then the new one set (:6453-6462).
// TERRAIN_DURATION = 8, TERRAIN_DURATION_EXTENDED = 12 (include/battle_util.h:52-53).
describe.each([
  ['MOVE_ELECTRIC_TERRAIN', STATUS_FIELD_ELECTRIC_TERRAIN],
  ['MOVE_GRASSY_TERRAIN', STATUS_FIELD_GRASSY_TERRAIN],
] as const)('cycle 115b - %s', (moveId, terrainFlag) => {
  const fieldNow = (state: BattleState) => ({
    flag: hasFlag(state.field.statuses, terrainFlag),
    timer: state.field.timers.terrainTimer,
    by: state.field.timers.terrainBattlerId,
    misty: hasFlag(state.field.statuses, STATUS_FIELD_MISTY_TERRAIN),
  })

  it('sets its terrain bit, timer 8 and attacker ownership, with no Misty bit (:6457-6462)', () => {
    const state = battle(user(moveId, FAST), foe(), countRng())
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({ flag: true, timer: TERRAIN_DURATION, by: 0, misty: false })
    expect(state.field.timers.started.terrain).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('replaces a running Misty Terrain: misty bit cleared, own bit set, owner/timer reset (:6455-6461)', () => {
    const state = battle(user(moveId, FAST), foe(), countRng())
    state.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
    state.field.timers.terrainTimer = 3
    state.field.timers.terrainBattlerId = 1
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({ flag: true, timer: TERRAIN_DURATION, by: 0, misty: false })
    expect(ppOf(state)).toBe(9)
  })

  it('fails when that same terrain is already up (:6453-6454): flag/timer/owner unchanged, PP spent', () => {
    const state = battle(user(moveId, FAST), foe(), countRng())
    state.field.statuses |= terrainFlag
    state.field.timers.terrainTimer = 3
    state.field.timers.terrainBattlerId = 1
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({ flag: true, timer: 3, by: 1, misty: false })
    expect(ppOf(state)).toBe(9)
  })

  it('Terrain Extender sets timer 12 (:6459-6461)', () => {
    const state = battle(user(moveId, { ...FAST, itemId: 'ITEM_TERRAIN_EXTENDER' }), foe(), countRng())
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      timer: TERRAIN_DURATION_EXTENDED,
      by: 0,
      misty: false,
    })
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_TAILWIND',
  'EFFECT_TRICK_ROOM',
  'EFFECT_RAIN_DANCE',
  'EFFECT_SUNNY_DAY',
  'EFFECT_SANDSTORM',
  'EFFECT_HAIL',
  'EFFECT_SAFEGUARD',
  'EFFECT_MIST',
  'EFFECT_LEECH_SEED',
  'EFFECT_TOXIC_SPIKES',
  'EFFECT_ELECTRIC_TERRAIN',
  'EFFECT_GRASSY_TERRAIN',
]

describe('cycle 115b - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})
