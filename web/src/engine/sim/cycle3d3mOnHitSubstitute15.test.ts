/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3m: attacker-half on-hit abilities Home Run, Wrestle Showman and Yuki Onna that gated on the bare
// `hpDealt > 0` require TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4056-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/abilities.cc (onAttacker hooks):
//       1. Home Run          :11926-11985: gIsCriticalHit, ShouldApplyOnHitEffect(battler) -- the HOLDER = attacker --
//          CHECK_NOT(GetAbilityState), partial bubble sort of CalculateStat values (tie draws Random() % 2), top
//          three boosted LIFO over STAT_SPEED..STAT_ATK via CanRaiseStat, then SetAbilityState(..., 1)
//       2. Wrestle Showman   :11716-11725: MOVE_FLYING_PRESS, ShouldApplyOnHitEffect(target), target alive,
//          !IsAbilityStatusProtected(CHECK_RESTRICTING), no taunt; Cmd_settaunt
//          (battle_script_commands.c:11678-11698) sets tauntTimer = tauntTimer2 = 3/4
//       3. Yuki Onna         :6425-6433: ShouldApplyOnHitEffect(target), CanInfatuate(battler, target),
//          Random() % 100 < 30, then AbilityStatusEffect(MOVE_EFFECT_ATTRACT)
//
// Behind a Substitute, hpDealt is 0 and physicalDmg/specialDmg are 0, so targetTurnDamaged is false. When an
// earlier hit of the same turn already removed HP, physicalDmg is nonzero and the effect still applies.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { runMoveEnd } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS2_INFATUATION,
  STATUS2_SUBSTITUTE,
  hasFlag,
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
  spe?: number; atk?: number; def?: number; spatk?: number; spdef?: number; hp?: number; maxHp?: number
  speciesId?: string; abilities?: SimBattleMon['abilities']; moves?: SimBattleMon['moves']; pp?: SimBattleMon['pp']
  types?: [string, string, string]; itemId?: string | null; status1?: number; status2?: number
}
function battle(specs: BattlerSpec[], rng: RandomSource = scriptedRng([0])): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) => createBattlerState(i, mon({
      speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
      rawStats: {
        atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85,
        spe: s.spe ?? (i === 0 ? 100 : 50),
      },
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
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

type HelperExtra = {
  attackerSpec?: BattlerSpec
  targetSpec?: BattlerSpec
  isCriticalHit?: boolean
  /** Passed straight through to runMoveEnd; Wrestle Showman reads it for Cmd_settaunt's 3-vs-4 turn choice. */
  targetHasActedThisTurn?: boolean
  /** State precondition a runner cannot express through BattlerSpec. */
  setup?: (state: BattleState) => void
}

/** Positive control at the moveEnd boundary: hpDealt equal to targetDamage (DidMoveHit is true). Attacker has the ability. */
function runAttackerHit(
  moveId: string,
  ability: string,
  damage = 20,
  rolls: number[] = [0],
  extra?: HelperExtra,
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], abilities: hasAbility(ability), ...(extra?.attackerSpec ?? {}) },
    { ...(extra?.targetSpec ?? {}) },
  ], rng)
  extra?.setup?.(state)
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage: damage,
    hpDealt: damage,
    isCriticalHit: extra?.isCriticalHit ?? false,
    targetHasActedThisTurn: extra?.targetHasActedThisTurn,
    deps: testDeps(fixedDamage(damage, extra?.isCriticalHit ?? false)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

/** Substitute control at the moveEnd boundary: target absorbed the hit, hpDealt = 0. Attacker has the ability. */
function runAttackerSubstitute(
  moveId: string,
  ability: string,
  rolls: number[] = [0],
  targetDamage = 20,
  extra?: HelperExtra,
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], abilities: hasAbility(ability), ...(extra?.attackerSpec ?? {}) },
    { ...(extra?.targetSpec ?? {}) },
  ], rng)
  extra?.setup?.(state)
  state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
  state.battlers[1]!.volatiles.substituteHp = 75
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage,
    hpDealt: 0,
    isCriticalHit: extra?.isCriticalHit ?? false,
    targetHasActedThisTurn: extra?.targetHasActedThisTurn,
    deps: testDeps(fixedDamage(targetDamage, extra?.isCriticalHit ?? false)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

/**
 * Earlier-hit control: this hit dealt 0, but an earlier hit of the same turn recorded 20 in the target's
 * turn struct (battle.h:750), so TARGET_TURN_DAMAGED is true. No Substitute -- the effect must really apply.
 */
function runAttackerEarlierHitDamaged(
  moveId: string,
  ability: string,
  rolls: number[] = [0],
  targetDamage = 20,
  extra?: HelperExtra,
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], abilities: hasAbility(ability), ...(extra?.attackerSpec ?? {}) },
    { ...(extra?.targetSpec ?? {}) },
  ], rng)
  extra?.setup?.(state)
  state.battlers[1]!.turn.physicalDmg = 20
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage,
    hpDealt: 0,
    isCriticalHit: extra?.isCriticalHit ?? false,
    targetHasActedThisTurn: extra?.targetHasActedThisTurn,
    deps: testDeps(fixedDamage(targetDamage, extra?.isCriticalHit ?? false)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

// ---------------------------------------------------------------------------
// 1. Home Run (src/abilities.cc:11926-11985). gIsCriticalHit, ShouldApplyOnHitEffect(battler) -- the HOLDER, i.e.
// the attacker -- then CHECK_NOT(GetAbilityState). ATK 150 / DEF 60 / SPATK 110 / SPDEF 70 / SPE 200 has no ties,
// so the partial bubble sort draws nothing and leaves SPDEF, DEF, SPATK in the top three; the LIFO boost loop
// reads STAT_SPEED..STAT_ATK, so SPDEF, DEF, SPATK rise by one stage each, in that order.
// ---------------------------------------------------------------------------
describe('cycle3d3m 1: Home Run requires TARGET_TURN_DAMAGED (abilities.cc:11926-11985)', () => {
  const stats = { atk: 150, def: 60, spatk: 110, spdef: 70, spe: 200 }
  const holder: HelperExtra = { attackerSpec: stats, isCriticalHit: true }
  const stages = (state: BattleState) => [
    state.battlers[0]!.mon.statStages[STAT_SPDEF],
    state.battlers[0]!.mon.statStages[STAT_DEF],
    state.battlers[0]!.mon.statStages[STAT_SPATK],
  ]

  it('hpDealt > 0: a critical hit raises SPDEF, DEF, SPATK one stage and sets the ability state, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_HOME_RUN', 20, [], holder)
    expect(stages(state)).toEqual([DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no stage changes, ability state stays 0 and no roll is drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_HOME_RUN', [], 20, holder)
    expect(stages(state)).toEqual([DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still raises the same three stats', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_HOME_RUN', [], 20, holder)
    expect(stages(state)).toEqual([DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1])
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    expect(rng.calls).toBe(0)
  })

  it('a non-critical real hit changes nothing (the crit gate is unchanged)', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_HOME_RUN', 20, [], { attackerSpec: stats })
    expect(stages(state)).toEqual([DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE])
    expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Wrestle Showman (src/abilities.cc:11716-11725). MOVE_FLYING_PRESS, ShouldApplyOnHitEffect(target), then
// Cmd_settaunt (battle_script_commands.c:11678-11698): turns = 4, minus one when the target's turn-order slot is
// after the attacker's -- `targetHasActedThisTurn: false`, so tauntTimer = tauntTimer2 = 3. No roll.
// ---------------------------------------------------------------------------
describe('cycle3d3m 2: Wrestle Showman requires TARGET_TURN_DAMAGED (abilities.cc:11716-11725)', () => {
  const notActed: HelperExtra = { targetHasActedThisTurn: false }

  it('hpDealt > 0: sets a 3-turn taunt on both timers, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_FLYING_PRESS', 'ABILITY_WRESTLE_SHOWMAN', 20, [], notActed)
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(3)
    expect(state.battlers[1]!.volatiles.tauntTimer2).toBe(3)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: both taunt timers stay 0 and no roll is drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_FLYING_PRESS', 'ABILITY_WRESTLE_SHOWMAN', [], 20, notActed)
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(0)
    expect(state.battlers[1]!.volatiles.tauntTimer2).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still sets both timers to 3', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_FLYING_PRESS', 'ABILITY_WRESTLE_SHOWMAN', [], 20, notActed)
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(3)
    expect(state.battlers[1]!.volatiles.tauntTimer2).toBe(3)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Yuki Onna (src/abilities.cc:6425-6433). ShouldApplyOnHitEffect(target), CanInfatuate(battler, target) BEFORE
// the 30% roll, then AbilityStatusEffect(MOVE_EFFECT_ATTRACT). statusInfatuatedWith(0) = 1 << 16.
// ---------------------------------------------------------------------------
describe('cycle3d3m 3: Yuki Onna requires TARGET_TURN_DAMAGED (abilities.cc:6425-6433)', () => {
  it('hpDealt > 0: the 30% roll lands and infatuates with battler 0, one draw', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_YUKI_ONNA', 20, [5])
    expect(state.battlers[1]!.mon.status2).toBe(1 << 16)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no infatuation and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_YUKI_ONNA', [5])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still infatuates on the same one draw', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_YUKI_ONNA', [5])
    expect(state.battlers[1]!.mon.status2).toBe(1 << 16)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
    expect(rng.calls).toBe(1)
  })
})
