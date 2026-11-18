/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 34: attacker-half on-hit abilities Molten Coat through Daredevil that gate on the bare `hpDealt > 0`
// require TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4056-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/abilities.cc (onAttacker hooks):
//       1. Molten Coat :10313-10324: CHECK(ShouldApplyOnHitEffect(target)), moveType == ROCK, CanBeBurned, Random() % 2
//       2. Deep Cuts :9088-9097: CHECK(ShouldApplyOnHitEffect(target)), CanBleed, Keen Edge, Random() % 2
//       3. Beautiful Music :7838-7846: CHECK(ShouldApplyOnHitEffect(target)), Random() % 2 (before IsSoundMove), IsSoundMove
//       4. Dead Power :7585-7598: CHECK(ShouldApplyOnHitEffect(target)), CHECK_NOT cursed, IsMoveMakingContact, Random() % 100 < 20
//       5. Assassin's Tools :8598-8621: CHECK(ShouldApplyOnHitEffect(target)), IsMoveMakingContact, Random() % 3 branch
//       6. Crushing Jaw :11597-11607: CHECK(ShouldApplyOnHitEffect(target)), STRONG_JAW_BOOST, Random() % 2, StatLowerableOrMirrorArmor(DEF)
//       7. Chainsaw :11236-11248 / Denting Blows :8045-8057: CHECK(ShouldApplyOnHitEffect(target)), Keen Edge / hammerBased,
//          StatLowerableOrMirrorArmor(DEF), once-per-turn-per-target bit
//       8. Daredevil :12382-12391: CHECK(ShouldApplyOnHitEffect(battler)) (holder = attacker), IsRecklessBoosted, CanRaiseStat(ATK)
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
import { getOncePerTurnAbilityCounter } from './switchInAbility'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS2_CURSED,
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
// 1. Molten Coat (src/abilities.cc:10313-10324)
// ---------------------------------------------------------------------------
describe('cycle34 1: Molten Coat requires TARGET_TURN_DAMAGED (abilities.cc:10313-10324)', () => {
  it('hpDealt > 0: roll 1 % 2 !== 0 burns the target', () => {
    const { state, rng } = runAttackerHit('MOVE_ROCK_SLIDE', 'ABILITY_MOLTEN_COAT', 20, [1])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no burn and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_ROCK_SLIDE', 'ABILITY_MOLTEN_COAT', [1])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still burns, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_ROCK_SLIDE', 'ABILITY_MOLTEN_COAT', [1])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Deep Cuts (src/abilities.cc:9088-9097)
// ---------------------------------------------------------------------------
describe('cycle34 2: Deep Cuts requires TARGET_TURN_DAMAGED (abilities.cc:9088-9097)', () => {
  it('hpDealt > 0: roll 1 % 2 !== 0 bleeds the target', () => {
    const { state, rng } = runAttackerHit('MOVE_AERIAL_ACE', 'ABILITY_DEEP_CUTS', 20, [1])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no bleed and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_AERIAL_ACE', 'ABILITY_DEEP_CUTS', [1])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still bleeds, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_AERIAL_ACE', 'ABILITY_DEEP_CUTS', [1])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. Beautiful Music (src/abilities.cc:7838-7846) -- the roll is drawn before IsSoundMove
// ---------------------------------------------------------------------------
describe('cycle34 3: Beautiful Music requires TARGET_TURN_DAMAGED (abilities.cc:7838-7846)', () => {
  it('hpDealt > 0: roll 1 % 2 !== 0 infatuates the target, one roll', () => {
    const { state, rng } = runAttackerHit('MOVE_HYPER_VOICE', 'ABILITY_BEAUTIFUL_MUSIC', 20, [1])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no infatuation and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_HYPER_VOICE', 'ABILITY_BEAUTIFUL_MUSIC', [1])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still infatuates, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_HYPER_VOICE', 'ABILITY_BEAUTIFUL_MUSIC', [1])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Dead Power (src/abilities.cc:7585-7598)
// ---------------------------------------------------------------------------
describe('cycle34 4: Dead Power requires TARGET_TURN_DAMAGED (abilities.cc:7585-7598)', () => {
  it('hpDealt > 0: roll 0 < 20 curses the target', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_DEAD_POWER', 20, [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no curse and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_DEAD_POWER', [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still curses, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_DEAD_POWER', [0])
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Assassin's Tools (src/abilities.cc:8598-8621)
// ---------------------------------------------------------------------------
describe('cycle34 5: Assassin\'s Tools requires TARGET_TURN_DAMAGED (abilities.cc:8598-8621)', () => {
  it('hpDealt > 0: roll 2 % 3 selects the bleed branch', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_ASSASSINS_TOOLS', 20, [2])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no status and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_ASSASSINS_TOOLS', [2])
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still bleeds, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_ASSASSINS_TOOLS', [2])
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 6. Crushing Jaw (src/abilities.cc:11597-11607)
// ---------------------------------------------------------------------------
describe('cycle34 6: Crushing Jaw requires TARGET_TURN_DAMAGED (abilities.cc:11597-11607)', () => {
  it('hpDealt > 0: bite move plus roll 1 % 2 !== 0 lowers Defense by 1', () => {
    const { state, rng } = runAttackerHit('MOVE_BITE', 'ABILITY_CRUSHING_JAW', 20, [1])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: Defense unchanged and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_BITE', 'ABILITY_CRUSHING_JAW', [1])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still lowers Defense, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_BITE', 'ABILITY_CRUSHING_JAW', [1])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 7a. Chainsaw (src/abilities.cc:11236-11248)
// ---------------------------------------------------------------------------
describe('cycle34 7a: Chainsaw requires TARGET_TURN_DAMAGED (abilities.cc:11236-11248)', () => {
  it('hpDealt > 0: Keen Edge move lowers Defense and records the once-per-turn bit, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_AERIAL_ACE', 'ABILITY_CHAINSAW', 20, [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_CHAINSAW', DATA_CONTEXT)).toBe(1 << 1)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: Defense unchanged, no bit recorded and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_AERIAL_ACE', 'ABILITY_CHAINSAW', [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_CHAINSAW', DATA_CONTEXT)).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still lowers Defense and records the bit', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_AERIAL_ACE', 'ABILITY_CHAINSAW', [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_CHAINSAW', DATA_CONTEXT)).toBe(1 << 1)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7b. Denting Blows (src/abilities.cc:8045-8057)
// ---------------------------------------------------------------------------
describe('cycle34 7b: Denting Blows requires TARGET_TURN_DAMAGED (abilities.cc:8045-8057)', () => {
  it('hpDealt > 0: hammer move lowers Defense and records the once-per-turn bit, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_CRABHAMMER', 'ABILITY_DENTING_BLOWS', 20, [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_DENTING_BLOWS', DATA_CONTEXT)).toBe(1 << 1)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: Defense unchanged, no bit recorded and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_CRABHAMMER', 'ABILITY_DENTING_BLOWS', [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_DENTING_BLOWS', DATA_CONTEXT)).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still lowers Defense and records the bit', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_CRABHAMMER', 'ABILITY_DENTING_BLOWS', [0])
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(getOncePerTurnAbilityCounter(state, 0, 'ABILITY_DENTING_BLOWS', DATA_CONTEXT)).toBe(1 << 1)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Daredevil (src/abilities.cc:12382-12391) -- ShouldApplyOnHitEffect(battler), the holder is the attacker
// ---------------------------------------------------------------------------
describe('cycle34 8: Daredevil requires TARGET_TURN_DAMAGED (abilities.cc:12382-12391)', () => {
  it('hpDealt > 0 and a reckless move: raises the attacker\'s Attack by 1, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_DOUBLE_EDGE', 'ABILITY_DAREDEVIL', 20, [0])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: Attack unchanged and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_DOUBLE_EDGE', 'ABILITY_DAREDEVIL', [0])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still raises Attack', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_DOUBLE_EDGE', 'ABILITY_DAREDEVIL', [0])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(rng.calls).toBe(0)
  })
})
