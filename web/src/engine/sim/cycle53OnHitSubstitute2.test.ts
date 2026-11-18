/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 53: second slice of on-hit ability hooks requiring TARGET_TURN_DAMAGED.
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
//       Gooey :2482, Petal Shield :12438, Stamina :2592, Weak Armor :1950, Anger Point :1461,
//       Tipping Point :6219, Fortitude :6623, Rage Point :8784, Inflatable :3860, Toxic Debris
//       :5061, Scrapyard :5044, Loose Rocks :5105, Furnace :5798, Guilt Trip :7109, Haunted
//       Spirit :4321, Ill Will :7278, Itchy Defense :6154, Sand Spit :3317, Seed Sower :6859,
//       Wind Power :7032, Cotton Down :3242.
//
// The sim's `hpDealt` is the HP actually removed from the mon. executeTurn still removes mon HP
// behind a Substitute (a separate upstream gap: turn.ts's applyDamage call), so the substitute
// cases hand the move-end boundary the C's post-substitute state (`hpDealt: 0`, turn structs zero)
// through runMoveEnd, exactly as cycle 52b does. Positive controls go through executeTurn.
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
  STATUS_FIELD_GRASSY_TERRAIN,
  WEATHER_SANDSTORM_TEMPORARY,
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

/** Positive control with a chosen move and crit flag (for Rock / air-based hooks and Stamina's crit half). */
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

/** runSubstitute with an arbitrary move id (Rock Throw for Furnace, Gust for Wind Power). */
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

describe('cycle53 1: Gooey requires TARGET_TURN_DAMAGED (abilities.cc:2482-2492)', () => {
  it('behind a Substitute: the attacker Speed stays at 0 and no roll is drawn', () => {
    // BattleScript_GooeyActivates sets MOVE_EFFECT_SPD_MINUS_1 (battle_scripts_1.s:10583) under
    // CHECK(ShouldApplyOnHitEffect(attacker)) (:2482-2484). Behind a Substitute TARGET_TURN_DAMAGED
    // (battle.h:750) is zero, so no stat change and Gooey draws no Random() at all.
    const { state, rng } = runSubstitute('ABILITY_GOOEY', [7])
    expect(speedStage(state, 0)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: the contact move lowers the attacker Speed by 1', () => {
    // setstatchanger MOVE_EFFECT_SPD_MINUS_1 (battle_scripts_1.s:10583) = -1 stage.
    const { state } = runTurn('ABILITY_GOOEY', [0])
    expect(speedStage(state, 0)).toBe(DEFAULT_STAT_STAGE - 1)
  })
})

describe('cycle53 2: Stamina requires TARGET_TURN_DAMAGED (abilities.cc:2592-2604)', () => {
  it('behind a Substitute: Defense stays at 0', () => {
    // CHECK(ShouldApplyOnHitEffect(battler)) (:2592-2594), then SetStatChanger(STAT_DEF, 1) (:2598).
    const { state, rng } = runSubstitute('ABILITY_STAMINA', [7])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: Defense +1', () => {
    const { state } = runTurn('ABILITY_STAMINA', [0])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('without a Substitute and on a crit: SetStatChanger(STAT_DEF, 12) clamps to +6 (stage 12)', () => {
    // abilities.cc:2596-2597 -- the crit branch sets 12 stages; the stage cap (12) turns +12 from
    // stage 6 into the +6 the delta reports.
    const { state } = runTurnWith('MOVE_TACKLE', 'ABILITY_STAMINA', [0], 20, true)
    expect(defStage(state, 1)).toBe(12)
  })
})

describe('cycle53 3: Weak Armor requires TARGET_TURN_DAMAGED (abilities.cc:1950-1961)', () => {
  it('behind a Substitute: Defense and Speed stay unchanged', () => {
    const { state, rng } = runSubstitute('ABILITY_WEAK_ARMOR', [7])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(speedStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: Defense -1 and Speed +2', () => {
    // BattleScript_WeakArmorActivates: setstatchanger STAT_DEF, 1, TRUE (decrease, :10301) then
    // setstatchanger STAT_SPEED, 2, FALSE (increase, :10315).
    const { state } = runTurn('ABILITY_WEAK_ARMOR', [0])
    expect(defStage(state, 1)).toBe(DEFAULT_STAT_STAGE - 1)
    expect(speedStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 2)
  })
})

describe('cycle53 4: Furnace requires TARGET_TURN_DAMAGED (abilities.cc:5798-5805)', () => {
  it('behind a Substitute: a Rock move raises no Speed', () => {
    // CHECK(ShouldApplyOnHitEffect(battler)) (:5787-5789) + CHECK(moveType == TYPE_ROCK) (:5790).
    const { state, rng } = runSubstituteWith('MOVE_ROCK_THROW', 'ABILITY_FURNACE', [7])
    expect(speedStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: a Rock move raises Speed by 2 (SetStatChanger(STAT_SPEED, 2), :5799)', () => {
    const { state } = runTurnWith('MOVE_ROCK_THROW', 'ABILITY_FURNACE', [0])
    expect(speedStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 2)
  })
})

describe('cycle53 5: Anger Point requires TARGET_TURN_DAMAGED (abilities.cc:1461-1473)', () => {
  it('behind a Substitute: Attack stays at 0', () => {
    const { state, rng } = runSubstitute('ABILITY_ANGER_POINT', [7])
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: Attack +1 (SetStatChanger(STAT_ATK, 1), :1468)', () => {
    const { state } = runTurn('ABILITY_ANGER_POINT', [0])
    expect(attackStage(state, 1)).toBe(DEFAULT_STAT_STAGE + 1)
  })
})

describe('cycle53 6: Seed Sower requires TARGET_TURN_DAMAGED (abilities.cc:6859-6866)', () => {
  it('behind a Substitute: no Grassy Terrain', () => {
    const { state, rng } = runSubstitute('ABILITY_SEED_SOWER', [7])
    expect(state.field.statuses & STATUS_FIELD_GRASSY_TERRAIN).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: TryChangeBattleTerrain sets Grassy Terrain', () => {
    const { state } = runTurn('ABILITY_SEED_SOWER', [0])
    expect(state.field.statuses & STATUS_FIELD_GRASSY_TERRAIN).toBe(STATUS_FIELD_GRASSY_TERRAIN)
  })
})

describe('cycle53 7: Wind Power requires TARGET_TURN_DAMAGED (abilities.cc:7032-7041)', () => {
  it('behind a Substitute: an air-based move sets no charged flag', () => {
    // CHECK(gBattleMoves[move].airBased) (:7036); MOVE_GUST carries flags.airBased.
    const { state, rng } = runSubstituteWith('MOVE_GUST', 'ABILITY_WIND_POWER', [7])
    expect(state.battlers[1]!.statuses3 & STATUS3_CHARGED_UP).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: an air-based move sets STATUS3_CHARGED_UP (:7038)', () => {
    const { state } = runTurnWith('MOVE_GUST', 'ABILITY_WIND_POWER', [0])
    expect(state.battlers[1]!.statuses3 & STATUS3_CHARGED_UP).toBe(STATUS3_CHARGED_UP)
  })
})

describe('cycle53 8: Cotton Down requires TARGET_TURN_DAMAGED (abilities.cc:3242-3252)', () => {
  it('behind a Substitute: the opposing Speed stays at 0', () => {
    // CHECK(DidMoveHit()) (:3244); BattleScript_CottonDownActivates walks gBattlerTarget from
    // BATTLE_OPPOSITE(battler) in steps of 2 setting STAT_SPEED -1 (:8560).
    const { state, rng } = runSubstitute('ABILITY_COTTON_DOWN', [7])
    expect(speedStage(state, 0)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: the attacker Speed drops by 1', () => {
    const { state } = runTurn('ABILITY_COTTON_DOWN', [0])
    expect(speedStage(state, 0)).toBe(DEFAULT_STAT_STAGE - 1)
  })
})

describe('cycle53 9: Toxic Debris requires TARGET_TURN_DAMAGED (abilities.cc:5061-5068)', () => {
  it('behind a Substitute: no Toxic Spikes layer', () => {
    // CHECK(DidMoveHit()) (:5062) and CHECK(... toxicSpikesAmount < 2) (:5064).
    const { state, rng } = runSubstitute('ABILITY_TOXIC_DEBRIS', [7])
    expect(state.sides[0]!.timers.toxicSpikesAmount).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: a contact move adds one Toxic Spikes layer to the attacker side', () => {
    const { state } = runTurn('ABILITY_TOXIC_DEBRIS', [0])
    expect(state.sides[0]!.timers.toxicSpikesAmount).toBe(1)
  })
})

describe('cycle53 10: Sand Spit requires TARGET_TURN_DAMAGED (abilities.cc:3317-3337)', () => {
  it('behind a Substitute: no Sandstorm', () => {
    const { state, rng } = runSubstitute('ABILITY_SAND_SPIT', [7])
    expect(state.field.weather).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: TryChangeBattleWeather(battler, ENUM_WEATHER_SANDSTORM) sets sandstorm (:3329)', () => {
    const { state } = runTurn('ABILITY_SAND_SPIT', [0])
    expect(state.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)
  })
})

describe('cycle53 11: doubles reads the per-target turn struct, not another foe', () => {
  it('battler 0 hits battler 1 (Gooey, behind a Substitute); battler 3 turn-damaged does not trigger it', () => {
    // Distinct speeds so the 4-battler move-end pass draws nothing for speed ties; any draw is Gooey's
    // (it draws none, so rng.calls stays 0).
    const rng = scriptedRng([7])
    const state = battle([
      { spe: 200, moves: ['MOVE_TACKLE', null, null, null] },
      { spe: 180, abilities: hasAbility('ABILITY_GOOEY') },
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
    expect(speedStage(state, 0)).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
    expect(state.battlersCount).toBe(4)
  })
})
