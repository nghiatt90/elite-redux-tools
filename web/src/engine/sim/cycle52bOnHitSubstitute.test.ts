/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 52b: on-hit ability hooks require TARGET_TURN_DAMAGED, not "damage was computed".
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
//   src/abilities.cc (each hook's own CHECK): Damp :564, Static :610, Rough Skin :784,
//       Effect Spore :818, Poison Point :987, Flame Body :1126, Cute Charm :1207, Illusion :2145,
//       Soul Linker :4273, Talon Trap :4713, Strikeout :11143.
//
// The sim's `hpDealt` is the HP actually removed from the mon. Its damage pipeline does not yet
// route a blocked hit into `volatiles.substituteHp`, so `executeTurn` still removes mon HP behind a
// Substitute (a separate, upstream gap: turn.ts's applyDamage call at :4400). The C's post-substitute
// state is "turn structs zero, no HP removed", so the substitute cases below hand the move-end
// boundary that exact state (`hpDealt: 0`) through `runMoveEnd`. Positive controls go through
// `executeTurn`.
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
import { runMoveEnd, targetTurnDamaged } from './moveEnd'
import { getAbilityStateOf } from './endTurn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { STATUS1_PARALYSIS, STATUS1_POISON_ANY, STATUS2_SUBSTITUTE, STATUS2_WRAPPED } from './constants'

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

/** The C's post-substitute state: the Substitute absorbed the hit, so no HP was removed from the
 * mon and Cmd_datahpupdate's turn-struct writes (:1935-1959) never ran. `hpDealt: 0` is that state;
 * `targetDamage` stays the computed value, which is what the old `targetDamage > 0` gate read. */
function runSubstitute(ability: string, rolls: number[], targetDamage = 20): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility(ability) }], rng)
  state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
  state.battlers[1]!.volatiles.substituteHp = 75
  runMoveEnd({
    state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
    targetDamage, hpDealt: 0, deps: testDeps(fixedDamage(targetDamage)), unmodelled: [], fainted: [],
  })
  return { state, rng }
}

const paralysed = (state: BattleState) => (state.battlers[0]!.mon.status1 & STATUS1_PARALYSIS) !== 0

describe('cycle52b 1-2: Static requires TARGET_TURN_DAMAGED (abilities.cc:610-618)', () => {
  it('1. behind a Substitute: no paralysis and the Static roll is never drawn', () => {
    // ShouldApplyOnHitEffect(opponent) is false: TARGET_TURN_DAMAGED (battle.h:750) stays zero because
    // Cmd_datahpupdate never reached the physicalDmg write (:1937). The sentinel 7 proves the stream
    // was not shifted by a `Random() % 100 < 30` draw (:614).
    const { state, rng } = runSubstitute('ABILITY_STATIC', [7])
    expect(paralysed(state)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('2a. without a Substitute, contact roll 0 < 30 paralyses the attacker', () => {
    const { state } = runTurn('ABILITY_STATIC', [0, 0, 0])
    expect(paralysed(state)).toBe(true)
  })

  it('2b. without a Substitute, roll 99 fails the 30% contact check', () => {
    const { state } = runTurn('ABILITY_STATIC', [0, 99, 0])
    expect(paralysed(state)).toBe(false)
  })
})

describe('cycle52b 3: Rough Skin and Poison Point require TARGET_TURN_DAMAGED', () => {
  it('Rough Skin behind a Substitute: no recoil (abilities.cc:784-793)', () => {
    const { state } = runSubstitute('ABILITY_ROUGH_SKIN', [0])
    expect(state.battlers[0]!.mon.hp).toBe(300)
  })

  it('Rough Skin without a Substitute: maxHP / 8 = 37 recoil to the attacker', () => {
    const { state } = runTurn('ABILITY_ROUGH_SKIN', [0])
    expect(state.battlers[0]!.mon.hp).toBe(300 - 37)
    expect(state.battlers[1]!.mon.hp).toBe(280)
  })

  it('Poison Point behind a Substitute: no poison and no roll (abilities.cc:987-995)', () => {
    const { state, rng } = runSubstitute('ABILITY_POISON_POINT', [7])
    expect(state.battlers[0]!.mon.status1 & STATUS1_POISON_ANY).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('Poison Point without a Substitute: roll 0 < 30 poisons the attacker', () => {
    const { state } = runTurn('ABILITY_POISON_POINT', [0, 0, 0])
    expect(state.battlers[0]!.mon.status1 & STATUS1_POISON_ANY).not.toBe(0)
  })
})

describe('cycle52b 4: Strikeout, Illusion, Talon Trap require TARGET_TURN_DAMAGED', () => {
  it('Strikeout behind a Substitute: the damagedBy flag is not set (abilities.cc:11143-11155)', () => {
    const { state } = runSubstitute('ABILITY_STRIKEOUT', [0])
    expect(getAbilityStateOf(state.battlers[1]!, 'ABILITY_STRIKEOUT')).toBe(0)
  })

  it('Strikeout without a Substitute: the attacker is marked damaged', () => {
    const { state } = runTurn('ABILITY_STRIKEOUT', [0])
    expect(getAbilityStateOf(state.battlers[1]!, 'ABILITY_STRIKEOUT')).not.toBe(0)
  })

  it('Illusion behind a Substitute: the disguise stays unbroken (abilities.cc:2145-2150)', () => {
    const rng = scriptedRng([7])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_ILLUSION') }], rng)
    state.battlers[1]!.illusion.on = true
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[1]!.illusion.broken).toBe(false)
    expect(state.battlers[1]!.illusion.on).toBe(true)
  })

  it('Illusion without a Substitute: the disguise breaks', () => {
    const rng = scriptedRng([0])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_ILLUSION') }], rng)
    state.battlers[1]!.illusion.on = true
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[1]!.illusion.broken).toBe(true)
  })

  it('Talon Trap behind a Substitute: no wrap and no roll (abilities.cc:4713-4730)', () => {
    // isFirstTurn == 2 short-circuits the `Random() % 100 < 50` operand (:4720), so any draw at all
    // would be visible; with the gate false the hook returns before WrapDuration too.
    const rng = scriptedRng([7])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_TALON_TRAP') }], rng)
    state.battlers[1]!.volatiles.isFirstTurn = 2
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.battlers[0]!.mon.status2 & STATUS2_WRAPPED).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('Talon Trap without a Substitute: isFirstTurn == 2 wraps the attacker', () => {
    const rng = scriptedRng([0])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_TALON_TRAP') }], rng)
    state.battlers[1]!.volatiles.isFirstTurn = 2
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[0]!.mon.status2 & STATUS2_WRAPPED).not.toBe(0)
  })
})

describe('cycle52b 5: targetTurnDamaged reads the turn struct as well as hpDealt', () => {
  it('hpDealt = 0 but physicalDmg = 5 (set by hand) is still TARGET_TURN_DAMAGED', () => {
    const state = battle([{}, {}])
    state.battlers[1]!.turn.physicalDmg = 5
    expect(targetTurnDamaged(state, 1, 0)).toBe(true)
    // Both turn-struct fields zero and no HP removed: false.
    expect(targetTurnDamaged(battle([{}, {}]), 1, 0)).toBe(false)
    // The helper's hpDealt half on its own.
    expect(targetTurnDamaged(battle([{}, {}]), 1, 5)).toBe(true)
    // specialDmg is the other half of battle.h:750's `||`.
    const special = battle([{}, {}])
    special.battlers[1]!.turn.specialDmg = 5
    expect(targetTurnDamaged(special, 1, 0)).toBe(true)
  })
})

describe('cycle52b 6: doubles reads the per-target turn struct', () => {
  it('battler 0 hits battler 1 (Static, behind a Substitute); battler 3 turn-damaged does not trigger it', () => {
    // Distinct speeds so the 4-battler move-end pass draws nothing for speed ties; any draw is Static's.
    const rng = scriptedRng([7])
    const state = battle([
      { spe: 200, moves: ['MOVE_TACKLE', null, null, null] },
      { spe: 180, abilities: hasAbility('ABILITY_STATIC') },
      { spe: 160 },
      { spe: 140 },
    ], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
    state.battlers[3]!.turn.physicalDmg = 5 // unrelated foe's struct: a global read would fire
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 0, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(paralysed(state)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(state.battlersCount).toBe(4)
  })
})
