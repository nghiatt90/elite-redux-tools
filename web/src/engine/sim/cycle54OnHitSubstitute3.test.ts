/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 54: third slice of on-hit ability hooks requiring TARGET_TURN_DAMAGED (dbl-3d3 slice 1).
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
//       Cursed Body :1910-1924, Rattled :2213-2224, Water Compaction :2650-2659, Steam Engine
//       :3291-3300, Thermal Exchange :7339-7348 (and Thermal Entropy :12404-12405), Cryo Architect
//       :9602-9633, Electromorphosis :5299-5308 (and Atomic Burst :5311-5315), Innards Out
//       :2995-3005.
//
// The sim's `hpDealt` is the HP actually removed from the mon. executeTurn still removes mon HP
// behind a Substitute (a separate upstream gap: turn.ts's applyDamage call), so the substitute
// cases hand the move-end boundary the C's post-substitute state (`hpDealt: 0`, turn structs zero)
// through runMoveEnd, exactly as cycle 53 does. Positive controls go through executeTurn.
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
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STATUS2_SUBSTITUTE,
  STATUS3_CHARGED_UP,
} from './constants'

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

const attackStage = (state: BattleState, battler: number) => state.battlers[battler]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
const defStage = (state: BattleState, battler: number) => state.battlers[battler]!.mon.statStages[STAT_DEF] ?? DEFAULT_STAT_STAGE
const speedStage = (state: BattleState, battler: number) => state.battlers[battler]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE

describe('cycle54 1: Cursed Body requires TARGET_TURN_DAMAGED (abilities.cc:1910-1924)', () => {
  it('behind a Substitute: no move disabled and no roll drawn', () => {
    // CHECK(ShouldApplyOnHitEffect(attacker)) (:1912). Behind Substitute TARGET_TURN_DAMAGED is 0,
    // so no Random() % 100 < 30 is drawn and rng.calls is 0.
    const { state, rng } = runSubstitute('ABILITY_CURSED_BODY', [7])
    expect(state.battlers[0]!.volatiles.disabledMove).toBeFalsy()
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: scripted roll 0 (< 30) disables the attacker chosen move with disableTimer 4', () => {
    // Draw order: accuracy (0, hits), then Cursed Body Random() % 100 < 30 (roll 0 < 30 passes).
    // The hook sets disableTimer = 4 (abilities.cc:1920); executeTurn decrements to 3 at ENDTURN_DISABLE.
    const { state, rng } = runTurn('ABILITY_CURSED_BODY', [0, 0])
    expect(state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
    expect(state.battlers[0]!.volatiles.disableTimer).toBe(3)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: moveEnd boundary sets disableTimer to 4 directly', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      { abilities: hasAbility('ABILITY_CURSED_BODY') },
    ], rng)
    state.chosenMovePositions[0] = 0
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      chosenMoveId: 'MOVE_TACKLE',
      targetDamage: 20,
      hpDealt: 20,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(state.battlers[0]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
    expect(state.battlers[0]!.volatiles.disableTimer).toBe(4)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: scripted roll 30 (not < 30) does not disable the move', () => {
    const { state, rng } = runTurn('ABILITY_CURSED_BODY', [0, 30])
    expect(state.battlers[0]!.volatiles.disabledMove).toBeFalsy()
    expect(rng.calls).toBe(2)
  })
})

describe('cycle54 2: Rattled requires TARGET_TURN_DAMAGED (abilities.cc:2213-2224)', () => {
  it('behind a Substitute: Bite leaves Speed unchanged and no roll drawn', () => {
    // Bite is Dark. CHECK(ShouldApplyOnHitEffect(battler)) (:2213).
    const { state, rng } = runSubstituteWith('MOVE_BITE', 'ABILITY_RATTLED', [7])
    expect(speedStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Bite (Dark) raises Speed by 1', () => {
    const { state } = runTurnWith('MOVE_BITE', 'ABILITY_RATTLED', [0])
    expect(speedStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('without a Substitute: non-matching type Tackle does not raise Speed', () => {
    const { state } = runTurnWith('MOVE_TACKLE', 'ABILITY_RATTLED', [0])
    expect(speedStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
  })
})

describe('cycle54 3: Water Compaction requires TARGET_TURN_DAMAGED (abilities.cc:2650-2659)', () => {
  it('behind a Substitute: Defense stays at 0 and no roll drawn', () => {
    const { state, rng } = runSubstituteWith('MOVE_WATER_GUN', 'ABILITY_WATER_COMPACTION', [7])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Water Gun gives Def +2', () => {
    const { state } = runTurnWith('MOVE_WATER_GUN', 'ABILITY_WATER_COMPACTION', [0])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 2)
  })
})

describe('cycle54 4: Steam Engine requires TARGET_TURN_DAMAGED (abilities.cc:3291-3300)', () => {
  it('behind a Substitute: Speed stays at 0 and no roll drawn', () => {
    const { state, rng } = runSubstituteWith('MOVE_EMBER', 'ABILITY_STEAM_ENGINE', [7])
    expect(speedStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Ember gives Speed +6 clamp from stage 6 to 12', () => {
    const { state } = runTurnWith('MOVE_EMBER', 'ABILITY_STEAM_ENGINE', [0])
    expect(speedStage(state, 1)).toBe(12)
  })
})

describe('cycle54 5: Thermal Exchange and Thermal Entropy require TARGET_TURN_DAMAGED (abilities.cc:7339-7348, 12405)', () => {
  it('behind a Substitute: Thermal Exchange leaves Attack unchanged and no roll drawn', () => {
    const { state, rng } = runSubstituteWith('MOVE_EMBER', 'ABILITY_THERMAL_EXCHANGE', [7])
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('behind a Substitute: Thermal Entropy alias leaves Attack unchanged and no roll drawn', () => {
    const { state, rng } = runSubstituteWith('MOVE_EMBER', 'ABILITY_THERMAL_ENTROPY', [7])
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Fire move gives Atk +1', () => {
    const { state } = runTurnWith('MOVE_EMBER', 'ABILITY_THERMAL_EXCHANGE', [0])
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 1)
  })
})

describe('cycle54 6: Cryo Architect requires TARGET_TURN_DAMAGED (abilities.cc:9602-9633)', () => {
  it('behind a Substitute: neither stage nor abilityState bit changes and no roll drawn', () => {
    const { state, rng } = runSubstituteWith('MOVE_WATER_GUN', 'ABILITY_CRYO_ARCHITECT', [7])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    // slotIndex 0 for the primary ability slot
    expect((state.battlers[1]!.volatiles.abilityState[0] ?? 0) & (1 << 1)).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: Ice move gives Def +1 and Atk +1', () => {
    const { state } = runTurnWith('MOVE_ICE_BEAM', 'ABILITY_CRYO_ARCHITECT', [0])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('without a Substitute: Water move arms abilityState[slot] & 2 and raises Atk +1 but not Def', () => {
    // moveEnd boundary: Water hit arms bit 1 (value 2) and raises Atk immediately
    const rng = scriptedRng([0])
    const state = battle([
      { moves: ['MOVE_WATER_GUN', null, null, null] },
      { abilities: hasAbility('ABILITY_CRYO_ARCHITECT') },
    ], rng)
    runMoveEnd({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_WATER_GUN',
      targetDamage: 20,
      hpDealt: 20,
      deps: testDeps(fixedDamage(20)),
      unmodelled: [],
      fainted: [],
    })
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 1)
    expect((state.battlers[1]!.volatiles.abilityState[0] ?? 0) & 2).toBe(2)
  })

  it('without a Substitute (through executeTurn): Water move raises Atk +1 and endTurn shifts armed state to 1', () => {
    const { state } = runTurnWith('MOVE_WATER_GUN', 'ABILITY_CRYO_ARCHITECT', [0])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1)
  })
})

describe('cycle54 7: Electromorphosis and Atomic Burst require TARGET_TURN_DAMAGED (abilities.cc:5299-5308, 5313)', () => {
  it('behind a Substitute: STATUS3_CHARGED_UP not set and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_ELECTROMORPHOSIS', [7])
    expect(state.battlers[1]!.statuses3 & STATUS3_CHARGED_UP).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('behind a Substitute: Atomic Burst alias does not set STATUS3_CHARGED_UP', () => {
    const { state, rng } = runSubstitute('ABILITY_ATOMIC_BURST', [7])
    expect(state.battlers[1]!.statuses3 & STATUS3_CHARGED_UP).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: STATUS3_CHARGED_UP is set after a hit', () => {
    const { state } = runTurn('ABILITY_ELECTROMORPHOSIS', [0])
    expect(state.battlers[1]!.statuses3 & STATUS3_CHARGED_UP).toBe(STATUS3_CHARGED_UP)
  })
})

describe('cycle54 8: Innards Out requires TARGET_TURN_DAMAGED (abilities.cc:2995-3005)', () => {
  it('behind a Substitute: holder at 0 HP and hpDealt 0 loses nothing on attacker', () => {
    const rng = scriptedRng([7])
    const state = battle([
      { hp: 100 },
      { hp: 0, abilities: hasAbility('ABILITY_INNARDS_OUT') },
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
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: holder faints to the hit and attacker loses hpDealt HP', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { hp: 100, moves: ['MOVE_TACKLE', null, null, null] },
      { hp: 20, maxHp: 100, abilities: hasAbility('ABILITY_INNARDS_OUT') },
    ], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })
})
