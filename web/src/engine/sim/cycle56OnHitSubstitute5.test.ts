/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 56: fifth slice of on-hit defender ability hooks requiring TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4058-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/battle_script_commands.c:1935-1959
//       the physicalDmg/specialDmg writes happen only when HP is actually removed; the substitute
//       branch just above (:1877-1893) only writes `dmg` and gHpDealt, so it leaves both at zero.
//   src/abilities.cc (each hook's own CHECK):
//       Deflect :12536-12544, Fog Machine :10979-10993, Malodor :9853-9864, Perish Body :3469-3487,
//       Wind Chimes :12513-12522, Wandering Spirit :3490-3515, Drakelp Head :12055-12079,
//       Chuckster :10441-10463, Restraining Order :8579-8597, Gulp Missile :3289-3301,
//       Arc Flash :8090-8098, CONTACT_COUNTERATTACKS (Cold Rebound :4850, Ice Downfall :7944,
//       Snap Trap :6734, Chilling Pellets :10700, Faraday Cage :9316, Parry :5031, Ultra Instinct :8226).
//
// The sim's `hpDealt` is the HP actually removed from the mon. executeTurn still removes mon HP
// behind a Substitute (a separate upstream gap: turn.ts's applyDamage call), so the substitute
// cases hand the move-end boundary the C's post-substitute state (`hpDealt: 0`, turn structs zero)
// through runMoveEnd, exactly as cycles 53-55 do. Positive controls go through executeTurn and runMoveEnd.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { runMoveEnd } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  BATTLE_TYPE_TRAINER,
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS2_SUBSTITUTE,
  STATUS3_GASTRO_ACID,
  STATUS3_PERISH_SONG,
  WEATHER_FOG_ANY,
  WEATHER_FOG_TEMPORARY,
  hasFlag,
} from './constants'
import { getSingleUseAbilityCounter } from './switchInAbility'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<Record<string, unknown>>('types.json')
const inverseTypeChart = snapshot<Record<string, unknown>>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id, power: m.power as number, type: m.type as string | null, split: m.split as SimMoveData['split'],
    effect: m.effect as string | null, flags: (m.flags as Record<string, true>) ?? {}, accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'], type2: m.type2 as string | null, target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'], argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined, priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined, pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}
function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id, resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as SimItemData['naturalGift']) ?? null, grouping: (it.grouping as string | null) ?? null,
  }
}
function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id, baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0, formOf: (s.formOf as string | null | undefined) ?? null,
  }
}
const RATIOS: [number, number][] = [[2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2]]
const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const DATA_CONTEXT: SimDataContext = {
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null,
    statStages: [], types: ['NORMAL', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}

function partyMon(speciesId: string | null = 'SPECIES_MUDKIP', hp = 100, overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId, hp, maxHp: 100, level: 50,
    moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY', hiddenPowerType: null, speedDown: false,
    gender: 'MALE', status1: 0, types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}
const liveParty = (): SimPartyMon[] => [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)]

type BattlerSpec = {
  spe?: number; atk?: number; def?: number; hp?: number; maxHp?: number; speciesId?: string
  abilities?: SimBattleMon['abilities']; moves?: SimBattleMon['moves']; pp?: SimBattleMon['pp']
  types?: [string, string, string]; itemId?: string | null; status1?: number; status2?: number
}
function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  extra?: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number },
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) => createBattlerState(i, mon({
      speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
      rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
      hp: s.hp ?? 300, maxHp: s.maxHp ?? 300,
      abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
      moves: s.moves ?? ['MOVE_TACKLE', null, null, null], pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
      types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'], itemId: s.itemId ?? null,
      status1: s.status1 ?? 0, status2: s.status2 ?? 0,
    }), 0)),
    rng,
    playerParty: extra?.playerParty,
    opponentParty: extra?.opponentParty,
    battleTypeFlags: extra?.battleTypeFlags,
  })
}
function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
  let idx = 0
  const r = { calls: 0, random16: () => { r.calls++; const val = values[idx] ?? 0; idx++; return val } }
  return r
}
function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id, priority: moveData.priority ?? 0, effect: moveData.effect, isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : 'NORMAL',
    power: moveData.power, flags: moveData.flags, split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0,
    isGrassyTerrainAffected: false, myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}
function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return { resolve: () => ({ targetDamage: amount, attackerDamage: null, unmodelled: [], isCriticalHit, berryReduced: false, isSuperEffective: false }) }
}
function testDeps(damage: DamageResolver = fixedDamage(20), grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest, grounding, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT, moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}
const move = (id: string): SimMoveData => requireMove(id)
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

/** Positive control through the whole action: the hit removes 20 HP, so DidMoveHit is true. */
function runTurn(ability: string, rolls: number[], damage = 20): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility(ability) }], rng)
  executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(damage)))
  return { state, rng }
}

/** Positive control with a chosen move and crit flag. */
function runTurnWith(
  moveId: string,
  ability: string,
  rolls: number[],
  damage = 20,
  isCriticalHit = false,
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: [moveId, null, null, null] }, { abilities: hasAbility(ability) }], rng)
  executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(damage, isCriticalHit)))
  return { state, rng }
}

/** Positive control at the moveEnd boundary: hpDealt equal to targetDamage (DidMoveHit is true). */
function runHit(
  moveId: string,
  ability: string,
  damage = 20,
  rolls: number[] = [0],
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: [moveId, null, null, null] }, { abilities: hasAbility(ability) }], rng)
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage: damage,
    hpDealt: damage,
    deps: testDeps(fixedDamage(damage)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

/** The C's post-substitute state: the Substitute absorbed the hit, so no HP was removed from the
 * mon and Cmd_datahpupdate's turn-struct writes (:1935-1959) never ran. `hpDealt: 0` is that state;
 * `targetDamage` stays the computed value, which is what the old `targetDamage > 0` gate read. */
function runSubstitute(ability: string, rolls: number[], targetDamage = 20): { state: BattleState; rng: RandomSource & { calls: number } } {
  return runSubstituteWith('MOVE_TACKLE', ability, rolls, targetDamage)
}

/** runSubstitute with an arbitrary move id. */
function runSubstituteWith(
  moveId: string,
  ability: string,
  rolls: number[],
  targetDamage = 20,
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: [moveId, null, null, null] }, { abilities: hasAbility(ability) }], rng)
  state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
  state.battlers[1]!.volatiles.substituteHp = 75
  runMoveEnd({
    state, attackerId: 0, targetId: 1, moveId,
    targetDamage, hpDealt: 0, deps: testDeps(fixedDamage(targetDamage)), unmodelled: [], fainted: [],
  })
  return { state, rng }
}

// ---------------------------------------------------------------------------
// 1. Deflect (src/abilities.cc:12536-12544)
// ---------------------------------------------------------------------------
describe('cycle56 1: Deflect requires TARGET_TURN_DAMAGED (abilities.cc:12536-12544)', () => {
  it('behind a Substitute: no out-of-turn attack queued and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_DEFLECT', [7])
    expect(state.queuedExtraAttacks).toEqual([])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit queues Vacuum Wave at power 20', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_DEFLECT', 20)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_DEFLECT', move: 'MOVE_VACUUM_WAVE', attacker: 1, target: 0, movePower: 20 },
    ])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(true)
  })

  it('without a Substitute: non-contact move also queues Vacuum Wave (no contact check)', () => {
    const { state } = runHit('MOVE_WATER_GUN', 'ABILITY_DEFLECT', 20)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_DEFLECT', move: 'MOVE_VACUUM_WAVE', attacker: 1, target: 0, movePower: 20 },
    ])
  })
})

// ---------------------------------------------------------------------------
// 2. Fog Machine (src/abilities.cc:10979-10993)
// ---------------------------------------------------------------------------
describe('cycle56 2: Fog Machine requires TARGET_TURN_DAMAGED (abilities.cc:10979-10993)', () => {
  it('behind a Substitute: weather stays clear and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_FOG_MACHINE', [7])
    expect(state.field.weather).toBe(0)
    expect(hasFlag(state.field.weather, WEATHER_FOG_ANY)).toBe(false)
    expect(state.field.weatherDuration).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit starts Fog for 8 turns', () => {
    const { state } = runTurn('ABILITY_FOG_MACHINE', [0])
    expect(hasFlag(state.field.weather, WEATHER_FOG_TEMPORARY)).toBe(true)
    expect(state.field.weatherDuration).toBe(8)
  })

  it('without a Substitute: non-contact move also starts Fog for 8 turns (no contact check)', () => {
    const { state } = runTurnWith('MOVE_WATER_GUN', 'ABILITY_FOG_MACHINE', [0])
    expect(hasFlag(state.field.weather, WEATHER_FOG_TEMPORARY)).toBe(true)
    expect(state.field.weatherDuration).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// 3. Malodor (src/abilities.cc:9853-9864)
// ---------------------------------------------------------------------------
describe('cycle56 3: Malodor requires TARGET_TURN_DAMAGED (abilities.cc:9853-9864)', () => {
  it('behind a Substitute: attacker has no Gastro Acid and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_MALODOR', [7])
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    expect(state.battlers[0]!.statuses3).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit inflicts Gastro Acid on the attacker', () => {
    const { state } = runTurn('ABILITY_MALODOR', [0])
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
  })

  it('without a Substitute: non-contact move leaves attacker without Gastro Acid', () => {
    const { state } = runTurnWith('MOVE_WATER_GUN', 'ABILITY_MALODOR', [0])
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 4. Perish Body (src/abilities.cc:3469-3487)
// ---------------------------------------------------------------------------
describe('cycle56 4: Perish Body requires TARGET_TURN_DAMAGED (abilities.cc:3469-3487)', () => {
  it('behind a Substitute: neither battler gets Perish Song and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_PERISH_BODY', [7])
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(false)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_PERISH_SONG)).toBe(false)
    expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(0)
    expect(state.battlers[1]!.volatiles.perishSongTimer).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: moveEnd boundary sets Perish Song timer to 3 on both battlers', () => {
    const rng = scriptedRng([0])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_PERISH_BODY') }], rng)
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
    expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(3)
    expect(state.battlers[1]!.volatiles.perishSongTimer).toBe(3)
  })

  it('without a Substitute: non-contact move does not set Perish Song', () => {
    const rng = scriptedRng([0])
    const state = battle([{ moves: ['MOVE_WATER_GUN', null, null, null] }, { abilities: hasAbility('ABILITY_PERISH_BODY') }], rng)
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_WATER_GUN',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(false)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_PERISH_SONG)).toBe(false)
    expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(0)
    expect(state.battlers[1]!.volatiles.perishSongTimer).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Wind Chimes (src/abilities.cc:12513-12522)
// ---------------------------------------------------------------------------
describe('cycle56 5: Wind Chimes requires TARGET_TURN_DAMAGED (abilities.cc:12513-12522)', () => {
  it('behind a Substitute: no out-of-turn attack queued and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_WIND_CHIMES', [7])
    expect(state.queuedExtraAttacks).toEqual([])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit queues Hyper Voice at power 30', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_WIND_CHIMES', 20)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_WIND_CHIMES', move: 'MOVE_HYPER_VOICE', attacker: 1, target: 0, movePower: 30 },
    ])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(true)
  })

  it('without a Substitute: non-contact move also queues Hyper Voice at power 30 (no contact check)', () => {
    const { state } = runHit('MOVE_WATER_GUN', 'ABILITY_WIND_CHIMES', 20)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_WIND_CHIMES', move: 'MOVE_HYPER_VOICE', attacker: 1, target: 0, movePower: 30 },
    ])
  })
})

// ---------------------------------------------------------------------------
// 6. Wandering Spirit (src/abilities.cc:3490-3515)
// ---------------------------------------------------------------------------
describe('cycle56 6: Wandering Spirit requires TARGET_TURN_DAMAGED (abilities.cc:3490-3515)', () => {
  it('behind a Substitute: abilities remain unchanged and no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], abilities: hasAbility('ABILITY_BLAZE') },
      { abilities: hasAbility('ABILITY_WANDERING_SPIRIT') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_BLAZE')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_WANDERING_SPIRIT')
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit swaps attacker and defender abilities', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], abilities: hasAbility('ABILITY_BLAZE') },
      { abilities: hasAbility('ABILITY_WANDERING_SPIRIT') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_WANDERING_SPIRIT')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })

  it('without a Substitute: non-contact move leaves abilities unchanged', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_WATER_GUN', null, null, null], abilities: hasAbility('ABILITY_BLAZE') },
      { abilities: hasAbility('ABILITY_WANDERING_SPIRIT') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_BLAZE')
    expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_WANDERING_SPIRIT')
  })
})

// ---------------------------------------------------------------------------
// 7. Drakelp Head (src/abilities.cc:12055-12079)
// ---------------------------------------------------------------------------
describe('cycle56 7: Drakelp Head requires TARGET_TURN_DAMAGED (abilities.cc:12055-12079)', () => {
  it('behind a Substitute: counter stays 0, attacker Attack stage unchanged, and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_DRAKELP_HEAD', [7])
    expect(getSingleUseAbilityCounter(state, 1, 'ABILITY_DRAKELP_HEAD', DATA_CONTEXT)).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit sets counter to 1 and drops attacker Attack by 1', () => {
    const { state } = runTurn('ABILITY_DRAKELP_HEAD', [0])
    expect(getSingleUseAbilityCounter(state, 1, 'ABILITY_DRAKELP_HEAD', DATA_CONTEXT)).toBe(1)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('without a Substitute: non-contact move also drops Attack and sets counter (no contact check)', () => {
    const { state } = runTurnWith('MOVE_WATER_GUN', 'ABILITY_DRAKELP_HEAD', [0])
    expect(getSingleUseAbilityCounter(state, 1, 'ABILITY_DRAKELP_HEAD', DATA_CONTEXT)).toBe(1)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('without a Substitute: subsequent hit with counter already 1 does not drop Attack again', () => {
    const rng = scriptedRng([0])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_DRAKELP_HEAD') }], rng)
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)

    // Second hit while counter is 1
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
  })
})

// ---------------------------------------------------------------------------
// 8. Chuckster (src/abilities.cc:10441-10463)
// ---------------------------------------------------------------------------
describe('cycle56 8: Chuckster requires TARGET_TURN_DAMAGED (abilities.cc:10441-10463)', () => {
  it('behind a Substitute: abilityState stays 0, no switch scheduled, and no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle(
      [{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_CHUCKSTER') }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expect(state.queuedSwitches).toEqual([])
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: moveEnd boundary sets abilityState to 1 and schedules switch', () => {
    const rng = scriptedRng([0])
    const state = battle(
      [{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_CHUCKSTER') }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1)
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_CHUCKSTER', setAbilityState: false, switchingBattler: 0, sourceBattler: 1 },
    ])
  })

  it('without a Substitute (through executeTurn): contact hit switches attacker to party mon 1', () => {
    // Pick 0 is rejected (current slot), pick 1 accepted.
    const rng = scriptedRng([0 /* accuracy */, 0 /* rejected pick */, 1 /* accepted pick */])
    const state = battle(
      [{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_CHUCKSTER') }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1)
    expect(state.queuedSwitches).toEqual([])
  })

  it('without a Substitute: non-contact move leaves abilityState at 0 and schedules no switch', () => {
    const rng = scriptedRng([0])
    const state = battle(
      [{ moves: ['MOVE_WATER_GUN', null, null, null] }, { abilities: hasAbility('ABILITY_CHUCKSTER') }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_WATER_GUN',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expect(state.queuedSwitches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 9. Restraining Order (src/abilities.cc:8579-8597)
// ---------------------------------------------------------------------------
describe('cycle56 9: Restraining Order requires TARGET_TURN_DAMAGED (abilities.cc:8579-8597)', () => {
  it('behind a Substitute: abilityState stays 0, no switch scheduled, and no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle(
      [{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_RESTRAINING_ORDER') }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expect(state.queuedSwitches).toEqual([])
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: moveEnd boundary schedules switch with setAbilityState true', () => {
    const rng = scriptedRng([0])
    const state = battle(
      [{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_RESTRAINING_ORDER') }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_RESTRAINING_ORDER', setAbilityState: true, switchingBattler: 0, sourceBattler: 1 },
    ])
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0) // DRAIN sets state, not the hook
  })

  it('without a Substitute: non-contact move also schedules switch (no contact check)', () => {
    const rng = scriptedRng([0])
    const state = battle(
      [{ moves: ['MOVE_WATER_GUN', null, null, null] }, { abilities: hasAbility('ABILITY_RESTRAINING_ORDER') }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_WATER_GUN',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_RESTRAINING_ORDER', setAbilityState: true, switchingBattler: 0, sourceBattler: 1 },
    ])
  })

  it('without a Substitute (through executeTurn): attacker switches to party mon 1 and drain sets abilityState', () => {
    const rng = scriptedRng([0 /* accuracy */, 0 /* rejected pick */, 1 /* accepted pick */])
    const state = battle(
      [{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_RESTRAINING_ORDER') }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1)
    expect(state.queuedSwitches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 10. Gulp Missile defender half (src/abilities.cc:3289-3301)
// ---------------------------------------------------------------------------
describe('cycle56 10: Gulp Missile defender half requires TARGET_TURN_DAMAGED (abilities.cc:3289-3301)', () => {
  it('behind a Substitute: Gulping form species and attacker HP/Def stage unchanged, no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { hp: 100, maxHp: 100, moves: ['MOVE_TACKLE', null, null, null] },
      { speciesId: 'SPECIES_CRAMORANT_GULPING', abilities: hasAbility('ABILITY_GULP_MISSILE') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GULPING')
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('behind a Substitute: Gorging form species and attacker HP/status unchanged, no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { hp: 100, maxHp: 100, moves: ['MOVE_TACKLE', null, null, null] },
      { speciesId: 'SPECIES_CRAMORANT_GORGING', abilities: hasAbility('ABILITY_GULP_MISSILE') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT_GORGING')
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Gulping hit deals floor(maxHp/4)=25 damage, reverts form, and drops attacker Def by 1', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { hp: 100, maxHp: 100, moves: ['MOVE_TACKLE', null, null, null] },
      { speciesId: 'SPECIES_CRAMORANT_GULPING', abilities: hasAbility('ABILITY_GULP_MISSILE') },
    ], rng)
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    // 100 - floor(100 / 4) = 75
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('without a Substitute: Gorging hit deals floor(maxHp/4)=25 damage, reverts form, and paralyzes attacker', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { hp: 100, maxHp: 100, moves: ['MOVE_TACKLE', null, null, null] },
      { speciesId: 'SPECIES_CRAMORANT_GORGING', abilities: hasAbility('ABILITY_GULP_MISSILE') },
    ], rng)
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_CRAMORANT')
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
  })

  it('without a Substitute: recoil damage floors at 1 when floor(maxHp/4) == 0', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { hp: 2, maxHp: 2, moves: ['MOVE_TACKLE', null, null, null] },
      { speciesId: 'SPECIES_CRAMORANT_GULPING', abilities: hasAbility('ABILITY_GULP_MISSILE') },
    ], rng)
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    // Math.max(1, Math.trunc(2 / 4)) == 1 -> hp drops from 2 to 1
    expect(state.battlers[0]!.mon.hp).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 11. Arc Flash defender half (src/abilities.cc:8090-8098)
// ---------------------------------------------------------------------------
describe('cycle56 11: Arc Flash defender half requires TARGET_TURN_DAMAGED (abilities.cc:8090-8098)', () => {
  it('behind a Substitute: attacker not burned and no roll drawn (even with odd scripted roll)', () => {
    const rng = scriptedRng([1])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null] },
      { abilities: hasAbility('ABILITY_ARC_FLASH') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(1)
  })

  it('without a Substitute: scripted roll 1 (odd) burns the attacker', () => {
    const rng = scriptedRng([1])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null] },
      { abilities: hasAbility('ABILITY_ARC_FLASH') },
    ], rng)
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: scripted roll 0 (even) does not burn the attacker', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null] },
      { abilities: hasAbility('ABILITY_ARC_FLASH') },
    ], rng)
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 12. CONTACT_COUNTERATTACKS table (Cold Rebound, Snap Trap, Ice Downfall)
// ---------------------------------------------------------------------------
describe('cycle56 12: CONTACT_COUNTERATTACKS requires TARGET_TURN_DAMAGED (abilities.cc:4850, 6734, 7944)', () => {
  it('behind a Substitute: Cold Rebound queues nothing and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_COLD_REBOUND', [7])
    expect(state.queuedExtraAttacks).toEqual([])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('behind a Substitute: Snap Trap queues nothing and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_SNAP_TRAP_WHEN_HIT', [7])
    expect(state.queuedExtraAttacks).toEqual([])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('behind a Substitute: Ice Downfall queues nothing and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_ICE_DOWNFALL', [7])
    expect(state.queuedExtraAttacks).toEqual([])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Cold Rebound on contact queues Icy Wind at power 0', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_COLD_REBOUND', 20)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_COLD_REBOUND', move: 'MOVE_ICY_WIND', attacker: 1, target: 0, movePower: 0 },
    ])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(true)
  })

  it('without a Substitute: Snap Trap on contact queues Snap Trap at power 50', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_SNAP_TRAP_WHEN_HIT', 20)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_SNAP_TRAP_WHEN_HIT', move: 'MOVE_SNAP_TRAP', attacker: 1, target: 0, movePower: 50 },
    ])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(true)
  })

  it('without a Substitute: Ice Downfall on contact queues Icicle Crash at power 60', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_ICE_DOWNFALL', 20)
    expect(state.queuedExtraAttacks).toEqual([
      { ability: 'ABILITY_ICE_DOWNFALL', move: 'MOVE_ICICLE_CRASH', attacker: 1, target: 0, movePower: 60 },
    ])
    expect(state.battlers[1]!.turn.dancerUsedMove).toBe(true)
  })

  it('without a Substitute: non-contact move (Water Gun) queues nothing for all three', () => {
    for (const abilityId of ['ABILITY_COLD_REBOUND', 'ABILITY_SNAP_TRAP_WHEN_HIT', 'ABILITY_ICE_DOWNFALL']) {
      const { state } = runHit('MOVE_WATER_GUN', abilityId, 20)
      expect(state.queuedExtraAttacks, abilityId).toEqual([])
      expect(state.battlers[1]!.turn.dancerUsedMove, abilityId).toBe(false)
    }
  })
})
