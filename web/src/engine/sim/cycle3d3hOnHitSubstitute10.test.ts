/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3h: attacker-half on-hit abilities Fire Aspect through Hardened Sheath that gate on the bare
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
//       1. Fire Aspect :10500-10514: CHECK(ShouldApplyOnHitEffect(target)), moveType == FIRE, CanBeBurned
//       2. Fire's Wrath :5186-5196: CHECK(ShouldApplyOnHitEffect(target)), CanBeBurned, CHECK_NOT(IsMoveMakingContact), Random() % 100 < 10
//       3. Frostmaw :8624-8633: CHECK(ShouldApplyOnHitEffect(target)), CanGetFrostbite, STRONG_JAW_BOOST, Random() % 2
//       4. Ghost Pepper :12459-12468: CHECK(ShouldApplyOnHitEffect(target)), moveType == GRASS, CanBeBurned, Random() % 100 < 30
//       5. Grass Flute :10070-10078: CHECK(ShouldApplyOnHitEffect(target)), IsSoundMove, CHECK_NOT(fear)
//       6. Haunting Frenzy :7523-7533: CHECK(ShouldApplyOnHitEffect(target)), CanMoveHaveExtraFlinchChance, Random() % 100 < 20
//       7. Fungal Infection :5016-5028: CHECK(ShouldApplyOnHitEffect(target)), CHECK_NOT Grass, CHECK_NOT seeded, IsMoveMakingContact
//       8. Hardened Sheath :4942-4952: CHECK(ShouldApplyOnHitEffect(battler)) (holder = attacker), hornBased, ChangeStatBuffs(ATK +1)
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
  STAT_ATK,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS2_FLINCHED,
  STATUS2_SUBSTITUTE,
  STATUS3_LEECHSEED,
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

type HelperExtra = { attackerSpec?: BattlerSpec; targetSpec?: BattlerSpec; isCriticalHit?: boolean }

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
    deps: testDeps(fixedDamage(targetDamage, extra?.isCriticalHit ?? false)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

// ---------------------------------------------------------------------------
// 1. Fire Aspect (src/abilities.cc:10500-10514) -- no roll
// ---------------------------------------------------------------------------
describe('cycle3d3h 1: Fire Aspect requires TARGET_TURN_DAMAGED (abilities.cc:10500-10514)', () => {
  it('hpDealt > 0: a Fire move burns the target, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_EMBER', 'ABILITY_FIRE_ASPECT', 20, [0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no burn and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_EMBER', 'ABILITY_FIRE_ASPECT', [0])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still burns', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_EMBER', 'ABILITY_FIRE_ASPECT', [0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Fire's Wrath (src/abilities.cc:5186-5196) -- non-contact, then 10% roll
// ---------------------------------------------------------------------------
describe("cycle3d3h 2: Fire's Wrath requires TARGET_TURN_DAMAGED (abilities.cc:5186-5196)", () => {
  it('hpDealt > 0: roll 0 < 10 burns the target', () => {
    const { state, rng } = runAttackerHit('MOVE_SWIFT', 'ABILITY_FIRES_WRATH', 20, [0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no burn and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_SWIFT', 'ABILITY_FIRES_WRATH', [0])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still burns, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_SWIFT', 'ABILITY_FIRES_WRATH', [0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Frostmaw (src/abilities.cc:8624-8633) -- bite move, then 50% roll
// ---------------------------------------------------------------------------
describe('cycle3d3h 3: Frostmaw requires TARGET_TURN_DAMAGED (abilities.cc:8624-8633)', () => {
  it('hpDealt > 0: bite move plus roll 1 % 2 !== 0 frostbites the target', () => {
    const { state, rng } = runAttackerHit('MOVE_BITE', 'ABILITY_FROSTMAW', 20, [1])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_FROSTBITE)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no frostbite and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_BITE', 'ABILITY_FROSTMAW', [1])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still frostbites, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_BITE', 'ABILITY_FROSTMAW', [1])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_FROSTBITE)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Ghost Pepper (src/abilities.cc:12459-12468) -- Grass move, then 30% roll
// ---------------------------------------------------------------------------
describe('cycle3d3h 4: Ghost Pepper requires TARGET_TURN_DAMAGED (abilities.cc:12459-12468)', () => {
  it('hpDealt > 0: Grass move plus roll 0 < 30 burns the target', () => {
    const { state, rng } = runAttackerHit('MOVE_LEAFAGE', 'ABILITY_GHOST_PEPPER', 20, [0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no burn and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_LEAFAGE', 'ABILITY_GHOST_PEPPER', [0])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still burns, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_LEAFAGE', 'ABILITY_GHOST_PEPPER', [0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Grass Flute (src/abilities.cc:10070-10078) -- sound move, no roll
// ---------------------------------------------------------------------------
describe('cycle3d3h 5: Grass Flute requires TARGET_TURN_DAMAGED (abilities.cc:10070-10078)', () => {
  it('hpDealt > 0: a sound move inflicts Fear, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_HYPER_VOICE', 'ABILITY_GRASS_FLUTE', 20, [0])
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no Fear and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_HYPER_VOICE', 'ABILITY_GRASS_FLUTE', [0])
    expect(state.battlers[1]!.volatiles.fear).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still inflicts Fear', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_HYPER_VOICE', 'ABILITY_GRASS_FLUTE', [0])
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Haunting Frenzy (src/abilities.cc:7523-7533) -- Kings Rock affected move, then 20% roll
// ---------------------------------------------------------------------------
describe('cycle3d3h 6: Haunting Frenzy requires TARGET_TURN_DAMAGED (abilities.cc:7523-7533)', () => {
  it('hpDealt > 0: roll 0 < 20 flinches the target', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_HAUNTING_FRENZY', 20, [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no flinch and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_HAUNTING_FRENZY', [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still flinches, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_HAUNTING_FRENZY', [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(true)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 7. Fungal Infection (src/abilities.cc:5016-5028) -- contact move, no roll
// ---------------------------------------------------------------------------
describe('cycle3d3h 7: Fungal Infection requires TARGET_TURN_DAMAGED (abilities.cc:5016-5028)', () => {
  it('hpDealt > 0: a contact move seeds a non-Grass target, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_FUNGAL_INFECTION', 20, [0])
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no leech seed and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_FUNGAL_INFECTION', [0])
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still seeds the target', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_FUNGAL_INFECTION', [0])
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Hardened Sheath (src/abilities.cc:4942-4952) -- ShouldApplyOnHitEffect(battler), the holder is the attacker
// ---------------------------------------------------------------------------
describe('cycle3d3h 8: Hardened Sheath requires TARGET_TURN_DAMAGED (abilities.cc:4942-4952)', () => {
  it('hpDealt > 0: a horn move raises the attacker\'s Attack by 1, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_HORN_ATTACK', 'ABILITY_HARDENED_SHEATH', 20, [0])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: Attack unchanged and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_HORN_ATTACK', 'ABILITY_HARDENED_SHEATH', [0])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still raises Attack', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_HORN_ATTACK', 'ABILITY_HARDENED_SHEATH', [0])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(rng.calls).toBe(0)
  })
})
