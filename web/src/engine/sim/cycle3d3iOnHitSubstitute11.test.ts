/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3i: attacker-half on-hit abilities Archmage, Angel's Wrath, Energy Siphon and From the Shadows
// that gate on the bare `hpDealt > 0` require TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4056-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/abilities.cc (onAttacker hooks):
//       1. Archmage     :5851-5988: CHECK(DidMoveHit()) -- no IsBattlerAlive term, the per-case checks carry it;
//                                    CHECK_NOT(IS_MOVE_STATUS), Random() % 100 < 30, then a switch on moveType
//       2. Angel's Wrath Tackle    :5573-5584: CHECK(ShouldApplyOnHitEffect(target)), restrictions, encore/disable
//       3. Angel's Wrath Electroweb :5643-5652: CHECK(ShouldApplyOnHitEffect(target)), Speed not already -6
//       4. Angel's Wrath Bug Bite   :5654-5661: CHECK(ShouldApplyOnHitEffect(battler)) (holder = attacker),
//                                    gBattleMoveDamage = -gHpDealt; if (!gBattleMoveDamage) gBattleMoveDamage = -1
//       5. Energy Siphon :9207-9216: CHECK(ShouldApplyOnHitEffect(battler)), gBattleMoveDamage = -gHpDealt / 4, floor -1
//       6. From the Shadows :8766-8781: CHECK(ShouldApplyOnHitEffect(target)), turn-order check, 20% flinch, trap
//
// Behind a Substitute, hpDealt is 0 and physicalDmg/specialDmg are 0, so targetTurnDamaged is false. When an
// earlier hit of the same turn already removed HP, physicalDmg is nonzero and the effect still applies.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { runMoveEnd } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_SPEED,
  STATUS1_TOXIC_POISON,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_FLINCHED,
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

type HelperExtra = { attackerSpec?: BattlerSpec; targetSpec?: BattlerSpec; isCriticalHit?: boolean; targetHasActedThisTurn?: boolean }

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
// 1. Archmage (src/abilities.cc:5851-5988) -- DidMoveHit, then 30% roll before the type switch
// ---------------------------------------------------------------------------
describe('cycle3d3i 1: Archmage requires TARGET_TURN_DAMAGED (abilities.cc:5851-5988)', () => {
  it('hpDealt > 0: a Poison move plus roll 0 < 30 toxics the target', () => {
    const { state, rng } = runAttackerHit('MOVE_POISON_STING', 'ABILITY_ARCHMAGE', 20, [0])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no status and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_POISON_STING', 'ABILITY_ARCHMAGE', [0])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still toxics, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_POISON_STING', 'ABILITY_ARCHMAGE', [0])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Angel's Wrath / MOVE_TACKLE (src/abilities.cc:5573-5584) -- encore + disable, no roll
// ---------------------------------------------------------------------------
describe("cycle3d3i 2: Angel's Wrath Tackle requires TARGET_TURN_DAMAGED (abilities.cc:5573-5584)", () => {
  it('hpDealt > 0: sets Encore and Disable from the target slot-0 move, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_ANGELS_WRATH', 20, [0])
    expect(state.battlers[1]!.volatiles.encoreTimer).toBe(2)
    expect(state.battlers[1]!.volatiles.encoredMove).toBe('MOVE_TACKLE')
    expect(state.battlers[1]!.volatiles.disableTimer).toBe(2)
    expect(state.battlers[1]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no Encore/Disable and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_ANGELS_WRATH', [0])
    expect(state.battlers[1]!.volatiles.encoreTimer).toBe(0)
    expect(state.battlers[1]!.volatiles.disableTimer).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still sets Encore/Disable', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_ANGELS_WRATH', [0])
    expect(state.battlers[1]!.volatiles.encoreTimer).toBe(2)
    expect(state.battlers[1]!.volatiles.disableTimer).toBe(2)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Angel's Wrath / MOVE_ELECTROWEB (src/abilities.cc:5643-5652) -- Speed to -6 + trap, no roll
// ---------------------------------------------------------------------------
describe("cycle3d3i 3: Angel's Wrath Electroweb requires TARGET_TURN_DAMAGED (abilities.cc:5643-5652)", () => {
  it('hpDealt > 0: Speed to MIN_STAT_STAGE and ESCAPE_PREVENTION, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_ELECTROWEB', 'ABILITY_ANGELS_WRATH', 20, [0])
    expect(state.battlers[1]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE).toBe(MIN_STAT_STAGE)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: Speed unchanged, no trap and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_ELECTROWEB', 'ABILITY_ANGELS_WRATH', [0])
    expect(state.battlers[1]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still drops Speed and traps', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_ELECTROWEB', 'ABILITY_ANGELS_WRATH', [0])
    expect(state.battlers[1]!.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE).toBe(MIN_STAT_STAGE)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Angel's Wrath / MOVE_BUG_BITE (src/abilities.cc:5654-5661) -- heals the holder by gHpDealt, floor 1, no roll
// ---------------------------------------------------------------------------
describe("cycle3d3i 4: Angel's Wrath Bug Bite requires TARGET_TURN_DAMAGED (abilities.cc:5654-5661)", () => {
  it('hpDealt > 0: heals the attacker by hpDealt (no Big Root), no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_BUG_BITE', 'ABILITY_ANGELS_WRATH', 20, [0], { attackerSpec: { hp: 50, maxHp: 100 } })
    expect(state.battlers[0]!.mon.hp).toBe(70)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no heal and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_BUG_BITE', 'ABILITY_ANGELS_WRATH', [0], 20, { attackerSpec: { hp: 50, maxHp: 100 } })
    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 heals 1 (the C floor)', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_BUG_BITE', 'ABILITY_ANGELS_WRATH', [0], 20, { attackerSpec: { hp: 50, maxHp: 100 } })
    expect(state.battlers[0]!.mon.hp).toBe(51)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Energy Siphon (src/abilities.cc:9207-9216) -- heals hpDealt / 4, floor 1, no roll
// ---------------------------------------------------------------------------
describe('cycle3d3i 5: Energy Siphon requires TARGET_TURN_DAMAGED (abilities.cc:9207-9216)', () => {
  it('hpDealt > 0: heals floor(hpDealt / 4), no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_ENERGY_SIPHON', 20, [0], { attackerSpec: { hp: 50, maxHp: 100 } })
    expect(state.battlers[0]!.mon.hp).toBe(55)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no heal and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_ENERGY_SIPHON', [0], 20, { attackerSpec: { hp: 50, maxHp: 100 } })
    expect(state.battlers[0]!.mon.hp).toBe(50)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 heals 1 (the C floor)', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_ENERGY_SIPHON', [0], 20, { attackerSpec: { hp: 50, maxHp: 100 } })
    expect(state.battlers[0]!.mon.hp).toBe(51)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. From the Shadows (src/abilities.cc:8766-8781) -- 20% flinch on a King's Rock move, then the trap
// ---------------------------------------------------------------------------
describe('cycle3d3i 6: From the Shadows requires TARGET_TURN_DAMAGED (abilities.cc:8766-8781)', () => {
  it('hpDealt > 0 before the target acts: roll 0 < 20 flinches and traps, one roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_FROM_THE_SHADOWS', 20, [0], { targetHasActedThisTurn: false })
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(state.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no flinch, no trap and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_FROM_THE_SHADOWS', [0], 20, { targetHasActedThisTurn: false })
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still flinches and traps, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_FROM_THE_SHADOWS', [0], 20, { targetHasActedThisTurn: false })
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(rng.calls).toBe(1)
  })
})
