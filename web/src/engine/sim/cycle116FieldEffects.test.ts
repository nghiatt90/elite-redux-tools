/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 116: field, screen and ability-swap status effects (12). Each effect is read against the
// C (data/battle_scripts_1.s, src/battle_script_commands.c, src/battle_util.c) and proven by a
// forced scenario whose numbers are derived by hand. Timers that the end-of-turn phase would tick
// are captured mid-turn (runSnap); the `started.*` flag a setter writes suppresses that decrement
// for the turn it is set, exactly as the C does.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  GRAVITY_DURATION,
  MAGIC_ROOM_DURATION,
  SCREEN_DURATION,
  SCREEN_DURATION_EXTENDED,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LUCKY_CHANT,
  SIDE_STATUS_SMOKESCREEN,
  STAT_EVASION,
  STATUS3_CHARGED_UP,
  STATUS3_MAGNET_RISE,
  STATUS3_ROOTED,
  STATUS3_TELEKINESIS,
  STATUS4_FEAR,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRAVITY,
  STATUS_FIELD_MAGIC_ROOM,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_WONDER_ROOM,
  TERRAIN_DURATION,
  TERRAIN_DURATION_EXTENDED,
  WEATHER_HAIL_TEMPORARY,
  WONDER_ROOM_DURATION,
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

/** Every draw returns `value`; `calls` counts draws. 50 misses a 33-accuracy check. */
function fixedRng(value: number): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return value
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

const THIS_FILE = 'web/src/engine/sim/cycle116FieldEffects.test.ts'
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

describe('cycle 116 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_PSYCHIC_TERRAIN', 'EFFECT_PSYCHIC_TERRAIN'],
    ['MOVE_MISTY_TERRAIN', 'EFFECT_MISTY_TERRAIN'],
    ['MOVE_WORRY_SEED', 'EFFECT_WORRY_SEED'],
    ['MOVE_WONDER_ROOM', 'EFFECT_WONDER_ROOM'],
    ['MOVE_MAGIC_ROOM', 'EFFECT_MAGIC_ROOM'],
    ['MOVE_LUCKY_CHANT', 'EFFECT_LUCKY_CHANT'],
    ['MOVE_MAGNET_RISE', 'EFFECT_MAGNET_RISE'],
    ['MOVE_INGRAIN', 'EFFECT_INGRAIN'],
    ['MOVE_GRAVITY', 'EFFECT_GRAVITY'],
    ['MOVE_AURORA_VEIL', 'EFFECT_AURORA_VEIL'],
    ['MOVE_SMOKESCREEN', 'EFFECT_SMOKESCREEN'],
    ['MOVE_ENTRAINMENT', 'EFFECT_ENTRAINMENT'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})

// BattleScript_Effect{Misty,Psychic}Terrain data/battle_scripts_1.s:2192-2203 share one body:
// attackcanceler, attackstring, ppreduce, setterrain BattleScript_ButItFailed.
// HandleTerrainMove (src/battle_script_commands.c:6404-6463) fails only when the same terrain
// bit is already set; otherwise every terrain bit is cleared, then the new one set, with
// started.terrain, terrainBattlerId = attacker and the timer (8, or 12 with Terrain Extender;
// include/battle_util.h:52-53).
describe.each([
  ['MOVE_PSYCHIC_TERRAIN', STATUS_FIELD_PSYCHIC_TERRAIN, STATUS_FIELD_ELECTRIC_TERRAIN],
  ['MOVE_MISTY_TERRAIN', STATUS_FIELD_MISTY_TERRAIN, STATUS_FIELD_PSYCHIC_TERRAIN],
] as const)('cycle 116 - %s', (moveId, terrainFlag, otherTerrain) => {
  const fieldNow = (state: BattleState) => ({
    flag: hasFlag(state.field.statuses, terrainFlag),
    other: hasFlag(state.field.statuses, otherTerrain),
    timer: state.field.timers.terrainTimer,
    by: state.field.timers.terrainBattlerId,
  })

  it('sets its own bit, timer 8 and attacker ownership, with no other terrain bit (:6455-6462)', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      other: false,
      timer: TERRAIN_DURATION,
      by: 0,
    })
    expect(state.field.timers.started.terrain).toBe(true)
    // The terrain script has no accuracycheck; the single draw is the foe's Tackle.
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('replaces a different running terrain: old bit cleared, owner/timer reset (:6455-6461)', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    state.field.statuses |= otherTerrain
    state.field.timers.terrainTimer = 3
    state.field.timers.terrainBattlerId = 1
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      other: false,
      timer: TERRAIN_DURATION,
      by: 0,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when that same terrain is already up (:6453-6454): flag/timer/owner unchanged, PP spent', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    state.field.statuses |= terrainFlag
    state.field.timers.terrainTimer = 3
    state.field.timers.terrainBattlerId = 1
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      other: false,
      timer: 3,
      by: 1,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Terrain Extender sets timer 12 (:6459-6461)', () => {
    const rng = countRng()
    const state = battle(user(moveId, { ...FAST, itemId: 'ITEM_TERRAIN_EXTENDER' }), foe(), rng)
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({
      flag: true,
      other: false,
      timer: TERRAIN_DURATION_EXTENDED,
      by: 0,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectWorrySeed data/battle_scripts_1.s:2416-2432: attackcanceler,
// accuracycheck BattleScript_PrintMoveMissed, attackstring, ppreduce, tryworryseed
// BattleScript_EffectWorrySeed_Fear. Cmd_tryworryseed (src/battle_script_commands.c:13091-13100)
// fails when the target ability is IsWorrySeedBannedAbility (battle_util.c:8438-8441, i.e.
// IsPersistentOrUnsuppressableAbility), already Insomnia, or ability-shielded; both paths then
// rejoin at the Fear label, which puts STATUS4_FEAR on the target (battle_script_commands.c:2996-2999).
describe('cycle 116 - Worry Seed', () => {
  it('replaces the target ability with Insomnia and sets fear (:13094-13097, :2429-2432)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WORRY_SEED'), foe({ abilities: only('ABILITY_RUN_AWAY') }), rng)
    runVs(state, 'MOVE_WORRY_SEED')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_INSOMNIA')
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(rng.calls).toBe(1) // the script's accuracycheck, and nothing else
    expect(ppOf(state)).toBe(9)
  })

  it('a target that already has Insomnia keeps it, but the Fear label still runs (:2429-2432)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WORRY_SEED'), foe({ abilities: only('ABILITY_INSOMNIA') }), rng)
    runVs(state, 'MOVE_WORRY_SEED')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_INSOMNIA')
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a missed accuracy roll changes nothing but still spends PP (:2418, :2420)', () => {
    // Accuracy 100 with +6 target evasion is 100/3 = 33 (accuracy.ts's stage ratio 1/3).
    const rng = fixedRng(50)
    const state = battle(user('MOVE_WORRY_SEED'), foe({ abilities: only('ABILITY_RUN_AWAY') }), rng)
    state.battlers[1]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 6
    const out = runVs(state, 'MOVE_WORRY_SEED')
    expect(out.actions[0]!.missed).toBe(true)
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_RUN_AWAY')
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(false)
    expect(state.battlers[1]!.volatiles.fear).toBe(false)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a persistent/unsuppressable target ability is untouched (:8438-8441)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WORRY_SEED'), foe({ abilities: only('ABILITY_DISGUISE') }), rng)
    runVs(state, 'MOVE_WORRY_SEED')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_DISGUISE')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectWonderRoom / BattleScript_EffectMagicRoom data/battle_scripts_1.s:2657-2667:
// attackcanceler, attackstring, ppreduce, setroom BattleScript_ButItFailed.
// Cmd_setroom / HandleRoomMove (src/battle_script_commands.c:11866-11925) fails when the room
// is active with timer > 10; otherwise the field bit TOGGLES (off -> timer 0, on -> duration)
// and the matching started flag is set. WONDER_ROOM_DURATION = MAGIC_ROOM_DURATION = 5
// (include/battle_util.h:58-59). Captured mid-turn because ENDTURN_WONDER_ROOM/MAGIC_ROOM tick.
describe.each([
  ['MOVE_WONDER_ROOM', STATUS_FIELD_WONDER_ROOM, WONDER_ROOM_DURATION, 'wonderRoom', 'wonderRoomTimer'],
  ['MOVE_MAGIC_ROOM', STATUS_FIELD_MAGIC_ROOM, MAGIC_ROOM_DURATION, 'magicRoom', 'magicRoomTimer'],
] as const)('cycle 116 - %s', (moveId, roomFlag, duration, startedKey, timerKey) => {
  const fieldNow = (state: BattleState) => ({
    flag: hasFlag(state.field.statuses, roomFlag),
    timer: state.field.timers[timerKey],
  })

  it('sets the field bit with timer 5 and its started flag (:11878-11884)', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({ flag: true, timer: duration })
    expect(state.field.timers.started[startedKey]).toBe(true)
    expect(rng.calls).toBe(1) // the room script has no accuracycheck; the draw is the foe's Tackle
    expect(ppOf(state)).toBe(9)
  })

  it('a second use while it runs toggles it OFF and zeroes the timer (:11868-11871)', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    state.field.statuses |= roomFlag
    state.field.timers[timerKey] = 4
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({ flag: false, timer: 0 })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a permanent room (timer > 10) fails instead of toggling off (:11881-11883)', () => {
    const rng = countRng()
    const state = battle(user(moveId, FAST), foe(), rng)
    state.field.statuses |= roomFlag
    state.field.timers[timerKey] = 11
    // The move failed; the room survives untouched mid-turn.
    expect(runSnap(state, moveId, () => fieldNow(state))).toEqual({ flag: true, timer: 11 })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectLuckyChant data/battle_scripts_1.s:2342-2351, VARIOUS_SET_LUCKY_CHANT
// src/battle_script_commands.c:7201-7212: fails only when the user's side already has
// SIDE_STATUS_LUCKY_CHANT; otherwise sets the flag, luckyChantBattlerId = user and
// luckyChantTimer = SCREEN_DURATION (5, include/battle_util.h:63).
describe('cycle 116 - Lucky Chant', () => {
  const sideNow = (state: BattleState) => ({
    flag: hasFlag(state.sides[0].statuses, SIDE_STATUS_LUCKY_CHANT),
    timer: state.sides[0].timers.luckyChantTimer,
    by: state.sides[0].timers.luckyChantBattlerId,
  })

  it('sets the user side flag, timer 5, setter 0 and started.luckyChant (:7204-7208)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LUCKY_CHANT', FAST), foe(), rng)
    expect(runSnap(state, 'MOVE_LUCKY_CHANT', () => sideNow(state))).toEqual({
      flag: true,
      timer: SCREEN_DURATION,
      by: 0,
    })
    expect(state.sides[0].timers.started.luckyChant).toBe(true)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_LUCKY_CHANT)).toBe(false)
    expect(rng.calls).toBe(1) // no accuracycheck in the script; the draw is the foe's Tackle
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails (:7204): timer/owner unchanged mid-turn, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_LUCKY_CHANT', FAST), foe(), rng)
    state.sides[0].statuses |= SIDE_STATUS_LUCKY_CHANT
    state.sides[0].timers.luckyChantTimer = 3
    state.sides[0].timers.luckyChantBattlerId = 1
    expect(runSnap(state, 'MOVE_LUCKY_CHANT', () => sideNow(state))).toEqual({
      flag: true,
      timer: 3,
      by: 1,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectMagnetRise data/battle_scripts_1.s:2627-2636, Cmd_setuserstatus3
// src/battle_script_commands.c:11991-12002: sets STATUS3_MAGNET_RISE and magnetRiseTimer = 5;
// fails when the bit is already set. ENDTURN_MAGNET_RISE (battle_util.c:2875-2884) has no
// started gate, so the timer is captured mid-turn.
describe('cycle 116 - Magnet Rise', () => {
  const selfNow = (state: BattleState) => ({
    flag: hasFlag(state.battlers[0]!.statuses3, STATUS3_MAGNET_RISE),
    timer: state.battlers[0]!.volatiles.magnetRiseTimer,
  })

  it('sets STATUS3_MAGNET_RISE and magnetRiseTimer 5 (:11995-11997)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MAGNET_RISE', FAST), foe(), rng)
    expect(runSnap(state, 'MOVE_MAGNET_RISE', () => selfNow(state))).toEqual({ flag: true, timer: 5 })
    expect(rng.calls).toBe(1) // no accuracycheck; the draw is the foe's Tackle
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails (:11993-11994): timer unchanged mid-turn, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_MAGNET_RISE', FAST), foe(), rng)
    state.battlers[0]!.statuses3 |= STATUS3_MAGNET_RISE
    state.battlers[0]!.volatiles.magnetRiseTimer = 3
    expect(runSnap(state, 'MOVE_MAGNET_RISE', () => selfNow(state))).toEqual({ flag: true, timer: 3 })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectIngrain data/battle_scripts_1.s:6326-6336, Cmd_setuserstatus3
// src/battle_script_commands.c:11991-12002: sets STATUS3_ROOTED (no timer); fails when set.
describe('cycle 116 - Ingrain', () => {
  it('sets STATUS3_ROOTED and changes nothing else (:6331)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_INGRAIN', FAST), foe(), rng)
    runVs(state, 'MOVE_INGRAIN')
    expect(state.battlers[0]!.statuses3).toBe(STATUS3_ROOTED)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0) // the script has no accuracycheck (:6326-6336)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails and leaves the existing bits alone (:11993-11994)', () => {
    const state = battle(user('MOVE_INGRAIN', FAST), foe(), countRng())
    state.battlers[0]!.statuses3 = STATUS3_ROOTED | STATUS3_CHARGED_UP
    runVs(state, 'MOVE_INGRAIN')
    expect(state.battlers[0]!.statuses3).toBe(STATUS3_ROOTED | STATUS3_CHARGED_UP)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectGravity data/battle_scripts_1.s:2713-2734: ppreduce, setgravity
// BattleScript_ButItFailed. Cmd_setgravity (src/battle_script_commands.c:6004-6013) fails when
// STATUS_FIELD_GRAVITY is set, else sets the bit, started.gravity and gravityTimer =
// GRAVITY_DURATION (5, include/battle_util.h:54). The script then walks every valid target with
// VARIOUS_GRAVITY_ON_AIRBORNE_MONS (:6887-6891): CancelMultiTurnMoves when ON_AIR, then clears
// ON_AIR | MAGNET_RISE | TELEKINESIS. In singles every non-fainted battler is that target.
describe('cycle 116 - Gravity', () => {
  const fieldNow = (state: BattleState) => ({
    flag: hasFlag(state.field.statuses, STATUS_FIELD_GRAVITY),
    timer: state.field.timers.gravityTimer,
  })

  it('sets STATUS_FIELD_GRAVITY, timer 5 and started.gravity (:6007-6009)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GRAVITY', FAST), foe(), rng)
    expect(runSnap(state, 'MOVE_GRAVITY', () => fieldNow(state))).toEqual({ flag: true, timer: GRAVITY_DURATION })
    expect(state.field.timers.started.gravity).toBe(true)
    expect(rng.calls).toBe(1) // no accuracycheck; the draw is the foe's Tackle
    expect(ppOf(state)).toBe(9)
  })

  it('drops a foe holding Magnet Rise (:6889-6890)', () => {
    // The timer is left at 5 so ENDTURN_MAGNET_RISE (battle_util.c:2875-2884) could not have
    // cleared the bit by itself; the snapshot also shows the loop does not touch the timer.
    const rng = countRng()
    const state = battle(user('MOVE_GRAVITY', FAST), foe(), rng)
    state.battlers[1]!.statuses3 |= STATUS3_MAGNET_RISE
    state.battlers[1]!.volatiles.magnetRiseTimer = 5
    const seen = runSnap(state, 'MOVE_GRAVITY', () => ({
      flag: hasFlag(state.battlers[1]!.statuses3, STATUS3_MAGNET_RISE),
      timer: state.battlers[1]!.volatiles.magnetRiseTimer,
    }))
    expect(seen).toEqual({ flag: false, timer: 5 })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('drops a foe holding Telekinesis (:6889-6890)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GRAVITY', FAST), foe(), rng)
    state.battlers[1]!.statuses3 |= STATUS3_TELEKINESIS
    state.battlers[1]!.volatiles.telekinesisTimer = 5
    const seen = runSnap(state, 'MOVE_GRAVITY', () => ({
      flag: hasFlag(state.battlers[1]!.statuses3, STATUS3_TELEKINESIS),
      timer: state.battlers[1]!.volatiles.telekinesisTimer,
    }))
    expect(seen).toEqual({ flag: false, timer: 5 })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('leaves the other status3 bits of a non-airborne battler alone (:6889)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GRAVITY', FAST), foe(), rng)
    state.battlers[1]!.statuses3 |= STATUS3_CHARGED_UP
    runVs(state, 'MOVE_GRAVITY')
    expect(state.battlers[1]!.statuses3 & STATUS3_CHARGED_UP).toBe(STATUS3_CHARGED_UP)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails (:6006-6007): timer unchanged mid-turn, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GRAVITY', FAST), foe(), rng)
    state.field.statuses |= STATUS_FIELD_GRAVITY
    state.field.timers.gravityTimer = 3
    expect(runSnap(state, 'MOVE_GRAVITY', () => fieldNow(state))).toEqual({ flag: true, timer: 3 })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectAuroraVeil data/battle_scripts_1.s:3985-3990, VARIOUS_SET_AURORA_VEIL
// src/battle_script_commands.c:7749-7767. Fails when the side already has the veil and the user
// lacks ABILITY_SCREEN_CLEANER, or when the user is neither hail-affected nor has
// ABILITY_AURORA_BOREALIS (HasAuroraBorealis battle_util.c:9345-9348). Else sets
// started.auroraVeil, the side bit, auroraVeilBattlerId = user and the timer -- 8 with Light
// Clay, else 5 (SCREEN_DURATION / SCREEN_DURATION_EXTENDED, include/battle_util.h:63-64).
describe('cycle 116 - Aurora Veil', () => {
  const sideNow = (state: BattleState) => ({
    flag: hasFlag(state.sides[0].statuses, SIDE_STATUS_AURORA_VEIL),
    timer: state.sides[0].timers.auroraVeilTimer,
    by: state.sides[0].timers.auroraVeilBattlerId,
  })

  it('under hail sets the veil, timer 5 and setter 0 (:7761-7767)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AURORA_VEIL', FAST), foe(), rng)
    state.field.weather = WEATHER_HAIL_TEMPORARY
    expect(runSnap(state, 'MOVE_AURORA_VEIL', () => sideNow(state))).toEqual({
      flag: true,
      timer: SCREEN_DURATION,
      by: 0,
    })
    expect(state.sides[0].timers.started.auroraVeil).toBe(true)
    expect(rng.calls).toBe(1) // no accuracycheck; the draw is the foe's Tackle
    expect(ppOf(state)).toBe(9)
  })

  it('Light Clay gives timer 8 (:7762-7765)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AURORA_VEIL', { ...FAST, itemId: 'ITEM_LIGHT_CLAY' }), foe(), rng)
    state.field.weather = WEATHER_HAIL_TEMPORARY
    expect(runSnap(state, 'MOVE_AURORA_VEIL', () => sideNow(state))).toEqual({
      flag: true,
      timer: SCREEN_DURATION_EXTENDED,
      by: 0,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('with no hail and no Aurora Borealis it fails and sets nothing (:7755-7758)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AURORA_VEIL', FAST), foe(), rng)
    expect(runSnap(state, 'MOVE_AURORA_VEIL', () => sideNow(state))).toEqual({ flag: false, timer: 0, by: 0 })
    expect(state.sides[0].timers.started.auroraVeil).toBe(false)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('Aurora Borealis satisfies the weather requirement (:7758, battle_util.c:9345-9348)', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_AURORA_VEIL', { ...FAST, abilities: only('ABILITY_AURORA_BOREALIS') }),
      foe(),
      rng,
    )
    expect(runSnap(state, 'MOVE_AURORA_VEIL', () => sideNow(state))).toEqual({
      flag: true,
      timer: SCREEN_DURATION,
      by: 0,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('an existing veil under hail fails, but a Screen Cleaner user may set it again (:7755-7758)', () => {
    const blockedRng = countRng()
    const blocked = battle(user('MOVE_AURORA_VEIL', FAST), foe(), blockedRng)
    blocked.field.weather = WEATHER_HAIL_TEMPORARY
    blocked.sides[0].statuses |= SIDE_STATUS_AURORA_VEIL
    blocked.sides[0].timers.auroraVeilTimer = 3
    blocked.sides[0].timers.auroraVeilBattlerId = 1
    expect(runSnap(blocked, 'MOVE_AURORA_VEIL', () => sideNow(blocked))).toEqual({
      flag: true,
      timer: 3,
      by: 1,
    })
    expect(blockedRng.calls).toBe(1)
    expect(ppOf(blocked)).toBe(9)

    const cleanerRng = countRng()
    const cleaner = battle(
      user('MOVE_AURORA_VEIL', { ...FAST, abilities: only('ABILITY_SCREEN_CLEANER') }),
      foe(),
      cleanerRng,
    )
    cleaner.field.weather = WEATHER_HAIL_TEMPORARY
    cleaner.sides[0].statuses |= SIDE_STATUS_AURORA_VEIL
    cleaner.sides[0].timers.auroraVeilTimer = 3
    cleaner.sides[0].timers.auroraVeilBattlerId = 1
    expect(runSnap(cleaner, 'MOVE_AURORA_VEIL', () => sideNow(cleaner))).toEqual({
      flag: true,
      timer: SCREEN_DURATION,
      by: 0,
    })
    expect(cleanerRng.calls).toBe(1)
    expect(ppOf(cleaner)).toBe(9)
  })
})

// BattleScript_EffectSmokescreen data/battle_scripts_1.s:12385-12399: ppreduce, then
// jumpifsideaffecting BS_ATTACKER SIDE_STATUS_SMOKESCREEN. With the bit up the move fails
// unless the attacker has ABILITY_SCREEN_CLEANER (:12395-12397). The move effect itself
// (SetMoveEffect:MOVE_EFFECT_SMOKESCREEN, src/battle_script_commands.c:2983-2995) writes only
// when smokescreenTimer == 0 and the attacker lacks Screen Cleaner: timer 8 with Light Clay
// else 5, started.smokescreen, smokescreenBattler = user, and the side bit.
describe('cycle 116 - Smokescreen', () => {
  const sideNow = (state: BattleState) => ({
    flag: hasFlag(state.sides[0].statuses, SIDE_STATUS_SMOKESCREEN),
    timer: state.sides[0].timers.smokescreenTimer,
    by: state.sides[0].timers.smokescreenBattler,
  })

  it('sets the side bit, timer 5 and setter 0 (:2987-2994)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SMOKESCREEN', FAST), foe(), rng)
    expect(runSnap(state, 'MOVE_SMOKESCREEN', () => sideNow(state))).toEqual({
      flag: true,
      timer: SCREEN_DURATION,
      by: 0,
    })
    expect(state.sides[0].timers.started.smokescreen).toBe(true)
    expect(rng.calls).toBe(1) // no accuracycheck; the draw is the foe's Tackle
    expect(ppOf(state)).toBe(9)
  })

  it('Light Clay gives timer 8 (:2989-2990)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SMOKESCREEN', { ...FAST, itemId: 'ITEM_LIGHT_CLAY' }), foe(), rng)
    expect(runSnap(state, 'MOVE_SMOKESCREEN', () => sideNow(state))).toEqual({
      flag: true,
      timer: SCREEN_DURATION_EXTENDED,
      by: 0,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails (:12389-12392): timer/owner unchanged mid-turn, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SMOKESCREEN', FAST), foe(), rng)
    state.sides[0].statuses |= SIDE_STATUS_SMOKESCREEN
    state.sides[0].timers.smokescreenTimer = 3
    state.sides[0].timers.smokescreenBattler = 1
    expect(runSnap(state, 'MOVE_SMOKESCREEN', () => sideNow(state))).toEqual({
      flag: true,
      timer: 3,
      by: 1,
    })
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a Screen Cleaner user with the bit up passes the check, sets nothing and is not missed (:12390-12392)', () => {
    // Kept quirk: the first check is bypassed by Screen Cleaner, the effect then refuses to
    // write (:2986-2987), and battle_script_commands.c:2983-2995 never fails the move.
    const rng = countRng()
    const state = battle(
      user('MOVE_SMOKESCREEN', { ...FAST, abilities: only('ABILITY_SCREEN_CLEANER') }),
      foe(),
      rng,
    )
    state.sides[0].statuses |= SIDE_STATUS_SMOKESCREEN
    state.sides[0].timers.smokescreenTimer = 0
    state.sides[0].timers.smokescreenBattler = 0
    const out = runVs(state, 'MOVE_SMOKESCREEN')
    expect(out.actions[0]!.missed).toBe(false)
    expect(sideNow(state)).toEqual({ flag: true, timer: 0, by: 0 })
    expect(state.sides[0].timers.started.smokescreen).toBe(false)
    expect(rng.calls).toBe(0) // no accuracycheck in the smokescreen script
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectEntrainment data/battle_scripts_1.s:2269-2282: accuracycheck
// BattleScript_PrintMoveMissed, ppreduce, tryentrainment BattleScript_ButItFailed.
// VARIOUS_TRY_ENTRAINMENT (src/battle_script_commands.c:7230-7244) fails when the user's
// ability is IsEntrainmentBannedAbilityAttacker (battle_util.c:8448-8455, which adds
// sSkillSwapBannedAbilities :85-88), when the target's is
// IsEntrainmentTargetOrSimpleBeamBannedAbility (:8457-8464, which adds Truant :97-99), when
// the target has an ability shield, or when the target already has the user's ability. On
// success the target's ability is replaced and switchinabilities BS_TARGET runs (:2281).
describe('cycle 116 - Entrainment', () => {
  it('gives the target the user ability (:7239-7242)', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_ENTRAINMENT', { ...FAST, abilities: only('ABILITY_INSOMNIA') }),
      foe({ abilities: only('ABILITY_RUN_AWAY') }),
      rng,
    )
    runVs(state, 'MOVE_ENTRAINMENT')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_INSOMNIA')
    expect(rng.calls).toBe(1) // the script's accuracycheck, and nothing else
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the user has a Skill Swap banned ability (:7232, battle_util.c:85-88)', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_ENTRAINMENT', { ...FAST, abilities: only('ABILITY_WONDER_GUARD') }),
      foe({ abilities: only('ABILITY_RUN_AWAY') }),
      rng,
    )
    runVs(state, 'MOVE_ENTRAINMENT')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_RUN_AWAY')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the target has Truant (:7234, battle_util.c:97-99)', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_ENTRAINMENT', { ...FAST, abilities: only('ABILITY_INSOMNIA') }),
      foe({ abilities: only('ABILITY_TRUANT') }),
      rng,
    )
    runVs(state, 'MOVE_ENTRAINMENT')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_TRUANT')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the target already has the user ability (:7237-7239)', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_ENTRAINMENT', { ...FAST, abilities: only('ABILITY_INSOMNIA') }),
      foe({ abilities: only('ABILITY_INSOMNIA') }),
      rng,
    )
    runVs(state, 'MOVE_ENTRAINMENT')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_INSOMNIA')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a missed accuracy roll changes nothing but still spends PP (:2271, :2273)', () => {
    const rng = fixedRng(50)
    const state = battle(
      user('MOVE_ENTRAINMENT', { ...FAST, abilities: only('ABILITY_INSOMNIA') }),
      foe({ abilities: only('ABILITY_RUN_AWAY') }),
      rng,
    )
    state.battlers[1]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 6
    const out = runVs(state, 'MOVE_ENTRAINMENT')
    expect(out.actions[0]!.missed).toBe(true)
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_RUN_AWAY')
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_PSYCHIC_TERRAIN',
  'EFFECT_MISTY_TERRAIN',
  'EFFECT_WORRY_SEED',
  'EFFECT_WONDER_ROOM',
  'EFFECT_MAGIC_ROOM',
  'EFFECT_LUCKY_CHANT',
  'EFFECT_MAGNET_RISE',
  'EFFECT_INGRAIN',
  'EFFECT_GRAVITY',
  'EFFECT_AURORA_VEIL',
  'EFFECT_SMOKESCREEN',
  'EFFECT_ENTRAINMENT',
]

describe('cycle 116 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})
