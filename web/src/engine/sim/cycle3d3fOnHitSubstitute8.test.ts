/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3f: attacker-half on-hit abilities that gate on the bare `hpDealt > 0` require TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4056-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/abilities.cc (onAttacker hooks):
//       1. Resonance :7871-7880: CHECK(ShouldApplyOnHitEffect(target)), CanBleed, IsSoundMove, Random() % 100 < 50
//       2. Solenoglyphs :4371-4380: CHECK(ShouldApplyOnHitEffect(target)), CanBePoisoned, STRONG_JAW_BOOST, Random() % 2
//       3. Razor Sharp / To The Bone :9021-9029, :9032: CHECK(ShouldApplyOnHitEffect(target)), CanBleed, gIsCriticalHit
//       4. Fearmonger :5170-5180: CHECK(ShouldApplyOnHitEffect(target)), CHECK_NOT fear, IsMoveMakingContact, Random() % 100 < 10
//       5. Whiplash :8942-8954: CHECK(ShouldApplyOnHitEffect(target)), IS_MOVE_PHYSICAL, StatLowerableOrMirrorArmor(target, STAT_DEF), once-per-turn
//       6. Aftermath :1655-1662: CHECK(effect == EFFECT_EXPLOSION), CHECK(ShouldApplyOnHitEffect(target))
//       7. Energy Tap :10623-10634: CHECK(ShouldApplyOnHitEffect(battler)), not max HP, CanBattlerHeal; -gHpDealt / 8, min 1
//       8. Fertilize :6506-6520: Grass holder, moveType == GRASS, CHECK(ShouldApplyOnHitEffect(battler)), not max HP, CanBattlerHeal; -gHpDealt / 10, min 1
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
  STAT_DEF,
  STATUS1_BLEED,
  STATUS1_TOXIC_POISON,
  STATUS2_FLINCHED,
  STATUS2_SUBSTITUTE,
  STATUS4_FEAR,
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
// 1. Resonance (src/abilities.cc:7871-7880)
// ---------------------------------------------------------------------------
describe('cycle3d3f 1: Resonance requires TARGET_TURN_DAMAGED (abilities.cc:7871-7880)', () => {
  it('hpDealt > 0: roll 0 < 50 bleeds the target', () => {
    const { state, rng } = runAttackerHit('MOVE_HYPER_VOICE', 'ABILITY_RESONANCE', 20, [0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no bleed and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_HYPER_VOICE', 'ABILITY_RESONANCE', [0])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still bleeds, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_HYPER_VOICE', 'ABILITY_RESONANCE', [0])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Solenoglyphs (src/abilities.cc:4371-4380)
// ---------------------------------------------------------------------------
describe('cycle3d3f 2: Solenoglyphs requires TARGET_TURN_DAMAGED (abilities.cc:4371-4380)', () => {
  it('hpDealt > 0: roll 1 % 2 !== 0 toxic-poisons the target', () => {
    const { state, rng } = runAttackerHit('MOVE_BITE', 'ABILITY_SOLENOGLYPHS', 20, [1])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no poison and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_BITE', 'ABILITY_SOLENOGLYPHS', [1])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still toxic-poisons, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_BITE', 'ABILITY_SOLENOGLYPHS', [1])
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Razor Sharp (src/abilities.cc:9021-9029; To The Bone aliases it at :9032)
// ---------------------------------------------------------------------------
describe('cycle3d3f 3: Razor Sharp requires TARGET_TURN_DAMAGED (abilities.cc:9021-9029)', () => {
  it('hpDealt > 0 and a critical hit: target bleeds, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_RAZOR_SHARP', 20, [0], { isCriticalHit: true })
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(0)
  })

  it('hpDealt > 0 but not a critical hit: no bleed', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_RAZOR_SHARP', 20, [0], { isCriticalHit: false })
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no bleed even on a critical hit', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_RAZOR_SHARP', [0], 20, { isCriticalHit: true })
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still bleeds on a critical hit', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_RAZOR_SHARP', [0], 20, { isCriticalHit: true })
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Fearmonger (src/abilities.cc:5170-5180)
// ---------------------------------------------------------------------------
describe('cycle3d3f 4: Fearmonger requires TARGET_TURN_DAMAGED (abilities.cc:5170-5180)', () => {
  it('hpDealt > 0: roll 0 < 10 inflicts Fear', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_FEARMONGER', 20, [0])
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no Fear and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_FEARMONGER', [0])
    expect(state.battlers[1]!.volatiles.fear).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still inflicts Fear, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_FEARMONGER', [0])
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Whiplash (src/abilities.cc:8942-8954)
// ---------------------------------------------------------------------------
describe('cycle3d3f 5: Whiplash requires TARGET_TURN_DAMAGED (abilities.cc:8942-8954)', () => {
  it('hpDealt > 0: physical move lowers target Defense by 1, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_WHIPLASH', 20, [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: Defense unchanged and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_WHIPLASH', [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still lowers Defense', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_WHIPLASH', [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Aftermath, attacker half (src/abilities.cc:1655-1662)
// ---------------------------------------------------------------------------
describe('cycle3d3f 6: Aftermath attacker half requires TARGET_TURN_DAMAGED (abilities.cc:1655-1662)', () => {
  it('hpDealt > 0: Explosion flinches the target, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_EXPLOSION', 'ABILITY_AFTERMATH', 20, [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(true)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: target not flinched and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_EXPLOSION', 'ABILITY_AFTERMATH', [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still flinches, no roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_EXPLOSION', 'ABILITY_AFTERMATH', [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(true)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Energy Tap (src/abilities.cc:10623-10634)
// ---------------------------------------------------------------------------
describe('cycle3d3f 7: Energy Tap requires TARGET_TURN_DAMAGED (abilities.cc:10623-10634)', () => {
  it('hpDealt 20: heals max(1, floor(20 / 8)) = 2 HP', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_ENERGY_TAP', 20, [0], {
      attackerSpec: { hp: 100, maxHp: 300 },
    })
    expect(state.battlers[0]!.mon.hp).toBe(102)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no healing and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_ENERGY_TAP', [0], 20, {
      attackerSpec: { hp: 100, maxHp: 300 },
    })
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 heals the floor-to-1 minimum', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_ENERGY_TAP', [0], 20, {
      attackerSpec: { hp: 100, maxHp: 300 },
    })
    expect(state.battlers[0]!.mon.hp).toBe(101)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Fertilize (src/abilities.cc:6506-6520)
// ---------------------------------------------------------------------------
describe('cycle3d3f 8: Fertilize requires TARGET_TURN_DAMAGED (abilities.cc:6506-6520)', () => {
  it('hpDealt 20: heals floor(20 / 10) = 2 HP', () => {
    const { state, rng } = runAttackerHit('MOVE_VINE_WHIP', 'ABILITY_FERTILIZE', 20, [0], {
      attackerSpec: { hp: 100, maxHp: 300, types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
    })
    expect(state.battlers[0]!.mon.hp).toBe(102)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no healing and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_VINE_WHIP', 'ABILITY_FERTILIZE', [0], 20, {
      attackerSpec: { hp: 100, maxHp: 300, types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
    })
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 heals the floor-to-1 minimum', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_VINE_WHIP', 'ABILITY_FERTILIZE', [0], 20, {
      attackerSpec: { hp: 100, maxHp: 300, types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
    })
    expect(state.battlers[0]!.mon.hp).toBe(101)
    expect(rng.calls).toBe(0)
  })
})
