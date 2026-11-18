/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 55: fourth slice of on-hit defender ability hooks requiring TARGET_TURN_DAMAGED (dbl-3d3b slice 1).
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
//       Spiteful :6610-6620, Supersweet Syrup :8957-8972, Drop Blocks :10996-11004, Loose Thorns
//       :11042-11051, Voodoo Power :6813-6823, Mummy :2182-2195 (and Lingering Aroma :5826-5828),
//       Flammable Coat :8320-8344, Brain Overload :11645-11655, Power Leak :10916-10926.
//
// The sim's `hpDealt` is the HP actually removed from the mon. executeTurn still removes mon HP
// behind a Substitute (a separate upstream gap: turn.ts's applyDamage call), so the substitute
// cases hand the move-end boundary the C's post-substitute state (`hpDealt: 0`, turn structs zero)
// through runMoveEnd, exactly as cycles 53 and 54 do. Positive controls go through executeTurn.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { runMoveEnd } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  STATUS1_BLEED,
  STATUS2_SUBSTITUTE,
  STATUS3_EMBARGO,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  hasFlag,
} from './constants'
import { TYPE_NAME_BY_ID } from './hazards'

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
type BattlerSpec = {
  spe?: number; atk?: number; def?: number; hp?: number; maxHp?: number; speciesId?: string
  abilities?: SimBattleMon['abilities']; moves?: SimBattleMon['moves']; pp?: SimBattleMon['pp']
  types?: [string, string, string]; itemId?: string | null; status1?: number; status2?: number
}
function battle(specs: BattlerSpec[], rng: RandomSource = scriptedRng([0])): BattleState {
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

describe('cycle55 1: Spiteful requires TARGET_TURN_DAMAGED (abilities.cc:6610-6620)', () => {
  it('behind a Substitute: attacker previous move PP unchanged and no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { moves: ['MOVE_TACKLE', 'MOVE_SCRATCH', null, null], pp: [20, 10, 0, 0] },
      { abilities: hasAbility('ABILITY_SPITEFUL') },
    ], rng)
    state.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      targetDamage: 20,
      hpDealt: 0,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[0]!.mon.pp[1]).toBe(10)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: previous move loses 4 PP on a contact hit', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_TACKLE', 'MOVE_SCRATCH', null, null], pp: [20, 10, 0, 0] },
      { abilities: hasAbility('ABILITY_SPITEFUL') },
    ], rng)
    state.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(state.battlers[0]!.mon.pp[1]).toBe(6)
  })

  it('without a Substitute: previous move loses all remaining PP when 3 or fewer remain', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_TACKLE', 'MOVE_SCRATCH', null, null], pp: [20, 3, 0, 0] },
      { abilities: hasAbility('ABILITY_SPITEFUL') },
    ], rng)
    state.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(state.battlers[0]!.mon.pp[1]).toBe(0)
  })

  it('without a Substitute: non-contact move leaves previous move PP unchanged', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_WATER_GUN', 'MOVE_SCRATCH', null, null], pp: [20, 10, 0, 0] },
      { abilities: hasAbility('ABILITY_SPITEFUL') },
    ], rng)
    state.battlers[0]!.lastMove = 'MOVE_SCRATCH'
    executeTurn(state, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.pp[1]).toBe(10)
  })
})

describe('cycle55 2: Supersweet Syrup requires TARGET_TURN_DAMAGED (abilities.cc:8957-8972)', () => {
  it('behind a Substitute: attacker with item is not embargoed and no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { itemId: 'ITEM_EVIOLITE', moves: ['MOVE_TACKLE', null, null, null] },
      { abilities: hasAbility('ABILITY_SUPERSWEET_SYRUP') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      targetDamage: 20,
      hpDealt: 0,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(false)
    expect(state.battlers[0]!.volatiles.embargoTimer ?? 0).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: moveEnd boundary sets Embargo with embargoTimer 2', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { itemId: 'ITEM_EVIOLITE', moves: ['MOVE_TACKLE', null, null, null] },
      { abilities: hasAbility('ABILITY_SUPERSWEET_SYRUP') },
    ], rng)
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      targetDamage: 20,
      hpDealt: 20,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(true)
    expect(state.battlers[0]!.volatiles.embargoTimer).toBe(2)
  })

  it('without a Substitute (through executeTurn): contact hit sets Embargo (decremented to 1 at ENDTURN_EMBARGO)', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { itemId: 'ITEM_EVIOLITE', moves: ['MOVE_TACKLE', null, null, null] },
      { abilities: hasAbility('ABILITY_SUPERSWEET_SYRUP') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(true)
    expect(state.battlers[0]!.volatiles.embargoTimer).toBe(1)
  })

  it('without a Substitute: attacker with no item is untouched', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { itemId: null, moves: ['MOVE_TACKLE', null, null, null] },
      { abilities: hasAbility('ABILITY_SUPERSWEET_SYRUP') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(false)
  })
})

describe('cycle55 3: Drop Blocks requires TARGET_TURN_DAMAGED (abilities.cc:10996-11004)', () => {
  it('behind a Substitute: spikesAmount stays 0 and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_DROP_BLOCKS', [7])
    expect(state.sides[0]!.timers.spikesAmount).toBe(0)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit increments spikesAmount from 0 to 1 and sets SIDE_STATUS_SPIKES', () => {
    const { state } = runTurn('ABILITY_DROP_BLOCKS', [0])
    expect(state.sides[0]!.timers.spikesAmount).toBe(1)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(true)
  })

  it('without a Substitute: non-contact move also increments spikesAmount (no contact needed)', () => {
    const { state } = runTurnWith('MOVE_WATER_GUN', 'ABILITY_DROP_BLOCKS', [0])
    expect(state.sides[0]!.timers.spikesAmount).toBe(1)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(true)
  })
})

describe('cycle55 4: Loose Thorns requires TARGET_TURN_DAMAGED (abilities.cc:11042-11051)', () => {
  it('behind a Substitute: no Stealth Rock set and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_LOOSE_THORNS', [7])
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit sets Stealth Rock of type Grass on attacker side', () => {
    const { state } = runTurn('ABILITY_LOOSE_THORNS', [0])
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(state.sides[0]!.timers.stealthRockType).toBe(TYPE_NAME_BY_ID.indexOf('GRASS'))
  })

  it('without a Substitute: non-contact move does nothing', () => {
    const { state } = runTurnWith('MOVE_WATER_GUN', 'ABILITY_LOOSE_THORNS', [0])
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
  })
})

describe('cycle55 5: Voodoo Power requires TARGET_TURN_DAMAGED (abilities.cc:6813-6823)', () => {
  it('behind a Substitute: no bleed applied and no roll drawn', () => {
    const { state, rng } = runSubstituteWith('MOVE_SUNSTRIKE', 'ABILITY_VOODOO_POWER', [7])
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: special move with scripted roll 0 (< 30) bleeds the attacker', () => {
    // Draw order: accuracy (0, hits), then Voodoo Power Random() % 100 < 30 (roll 0 < 30 passes).
    const { state, rng } = runTurnWith('MOVE_SUNSTRIKE', 'ABILITY_VOODOO_POWER', [0, 0])
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: special move with scripted roll 30 (>= 30) does not bleed the attacker', () => {
    // Draw order: accuracy (0, hits), then Voodoo Power Random() % 100 < 30 (roll 30 < 30 fails).
    const { state, rng } = runTurnWith('MOVE_SUNSTRIKE', 'ABILITY_VOODOO_POWER', [0, 30])
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: physical move does not bleed and consumes no ability roll', () => {
    // Physical move (Tackle): accuracy rolled (0, hits), IS_MOVE_SPECIAL fails, so no ability roll drawn.
    const { state, rng } = runTurnWith('MOVE_TACKLE', 'ABILITY_VOODOO_POWER', [0, 0])
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
  })
})

describe('cycle55 6: Mummy and Lingering Aroma require TARGET_TURN_DAMAGED (abilities.cc:2182-2195, 5826-5828)', () => {
  it('behind a Substitute: Mummy leaves attacker ability unchanged and no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], abilities: hasAbility('ABILITY_BLAZE') },
      { abilities: hasAbility('ABILITY_MUMMY') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      targetDamage: 20,
      hpDealt: 0,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_BLAZE')
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('behind a Substitute: Lingering Aroma alias leaves attacker ability unchanged and no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], abilities: hasAbility('ABILITY_BLAZE') },
      { abilities: hasAbility('ABILITY_LINGERING_AROMA') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      targetDamage: 20,
      hpDealt: 0,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_BLAZE')
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit replaces attacker ability with Mummy', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], abilities: hasAbility('ABILITY_BLAZE') },
      { abilities: hasAbility('ABILITY_MUMMY') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_MUMMY')
  })
})

describe('cycle55 7: Flammable Coat requires TARGET_TURN_DAMAGED unless Flash Fire active (abilities.cc:8320-8344)', () => {
  it('behind a Substitute: Lumbering Sloth hit by Fire move stays in normal form and no roll drawn', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { moves: ['MOVE_EMBER', null, null, null] },
      { speciesId: 'SPECIES_LUMBERING_SLOTH', abilities: hasAbility('ABILITY_FLAMMABLE_COAT') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_EMBER',
      targetDamage: 20,
      hpDealt: 0,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH')
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Fire move transforms Lumbering Sloth into Engulfed form', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_EMBER', null, null, null] },
      { speciesId: 'SPECIES_LUMBERING_SLOTH', abilities: hasAbility('ABILITY_FLAMMABLE_COAT') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_EMBER')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH_ENGULFED')
  })

  it('behind a Substitute: with volatiles.flashFire set, transforms even behind Substitute (second disjunct)', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { moves: ['MOVE_EMBER', null, null, null] },
      { speciesId: 'SPECIES_LUMBERING_SLOTH', abilities: hasAbility('ABILITY_FLAMMABLE_COAT') },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    state.battlers[1]!.volatiles.flashFire = true
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_EMBER',
      targetDamage: 20,
      hpDealt: 0,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[1]!.mon.speciesId).toBe('SPECIES_LUMBERING_SLOTH_ENGULFED')
  })
})

describe('cycle55 8: Brain Overload and Power Leak require TARGET_TURN_DAMAGED (abilities.cc:11645-11655, 10916-10926)', () => {
  it('behind a Substitute: Brain Overload leaves Psychic Terrain flag clear and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_BRAIN_OVERLOAD', [7])
    expect(hasFlag(state.field.statuses, STATUS_FIELD_PSYCHIC_TERRAIN)).toBe(false)
    expect(state.field.timers.terrainTimer).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Brain Overload starts Psychic Terrain for 8 turns', () => {
    const { state } = runTurn('ABILITY_BRAIN_OVERLOAD', [0])
    expect(hasFlag(state.field.statuses, STATUS_FIELD_PSYCHIC_TERRAIN)).toBe(true)
    expect(state.field.timers.terrainTimer).toBe(8)
  })

  it('behind a Substitute: Power Leak leaves Electric Terrain flag clear and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_POWER_LEAK', [7])
    expect(hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(false)
    expect(state.field.timers.terrainTimer).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Power Leak starts Electric Terrain for 8 turns', () => {
    const { state } = runTurn('ABILITY_POWER_LEAK', [0])
    expect(hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(true)
    expect(state.field.timers.terrainTimer).toBe(8)
  })
})
