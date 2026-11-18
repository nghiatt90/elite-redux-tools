/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3j: attacker-half on-hit abilities Impaler, Molten Blades, Toxic Chain/Komodo, Arc Flash,
// Icicle Fist, Laser Drill, Piercing Solo and Radio Jam that gate on the bare `hpDealt > 0` require
// TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4056-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/abilities.cc (onAttacker hooks, every one starts CHECK(ShouldApplyOnHitEffect(target))):
//       1. Impaler       :10222-10232: CanBleed(target), gBattleMoves[move].hornBased, Random() % 100 < 30
//       2. Molten Blades :7510-7520: CanBeBurned(target), MOVE_FLAG_KEEN_EDGE, Random() % 100 < 20
//       3. Toxic Chain   :7698-7706: CanBePoisoned(battler, target, MOVE_NONE), Random() % 100 < 30;
//          Komodo's onAttacker is `Impl<ABILITY_TOXIC_CHAIN>.onAttacker` (:10262-10267)
//       4. Arc Flash     :8082-8090: CanBeParalyzed(battler, target), Random() % 2 (attacker half only)
//       5. Icicle Fist   :12500-12508: IsIronFistBoosted(battler, move), CanGetFrostbite(target), Random() % 100 < 30
//       6. Laser Drill   :11007-11015: CanBeBurned(target), gBattleMoves[move].hornBased, Random() % 2
//       7. Piercing Solo :8011-8019: CanBleed(target), IsSoundMove(battler, move), no roll
//       8. Radio Jam     :7544-7552: CanBeDisabled(target), IsSoundMove(battler, move), Random() % 100 < 20
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
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_TOXIC_POISON,
  STATUS2_SUBSTITUTE,
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

type HelperExtra = {
  attackerSpec?: BattlerSpec
  targetSpec?: BattlerSpec
  isCriticalHit?: boolean
  /** State precondition a runner cannot express through BattlerSpec (e.g. the target's lastMove for Radio Jam). */
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
    deps: testDeps(fixedDamage(targetDamage, extra?.isCriticalHit ?? false)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

// ---------------------------------------------------------------------------
// 1-7. One status bit each. Moves and flags confirmed in data/v2.65beta/moves.json:
//   Impaler/Laser Drill: MOVE_HYPER_DRILL (hornBased), Molten Blades: MOVE_AERIAL_ACE (sliceBased),
//   Icicle Fist: MOVE_BULLET_PUNCH (punchBased), Piercing Solo: MOVE_HYPER_VOICE (sound).
// Rolls: [1] for the two `Random() % 2` hooks (nonzero passes), [] for Piercing Solo (no roll).
// ---------------------------------------------------------------------------
type StatusItem = {
  n: number
  name: string
  abilities: string[]
  move: string
  rolls: number[]
  status: number
  cite: string
}
const STATUS_ITEMS: StatusItem[] = [
  { n: 1, name: 'Impaler', abilities: ['ABILITY_IMPALER'], move: 'MOVE_HYPER_DRILL', rolls: [0], status: STATUS1_BLEED, cite: 'abilities.cc:10222-10232' },
  { n: 2, name: 'Molten Blades', abilities: ['ABILITY_MOLTEN_BLADES'], move: 'MOVE_AERIAL_ACE', rolls: [0], status: STATUS1_BURN, cite: 'abilities.cc:7510-7520' },
  { n: 3, name: 'Toxic Chain / Komodo', abilities: ['ABILITY_TOXIC_CHAIN', 'ABILITY_KOMODO'], move: 'MOVE_TACKLE', rolls: [0], status: STATUS1_TOXIC_POISON, cite: 'abilities.cc:7698-7706, :10262-10267' },
  { n: 4, name: 'Arc Flash', abilities: ['ABILITY_ARC_FLASH'], move: 'MOVE_TACKLE', rolls: [1], status: STATUS1_PARALYSIS, cite: 'abilities.cc:8082-8090' },
  { n: 5, name: 'Icicle Fist', abilities: ['ABILITY_ICICLE_FIST'], move: 'MOVE_BULLET_PUNCH', rolls: [0], status: STATUS1_FROSTBITE, cite: 'abilities.cc:12500-12508' },
  { n: 6, name: 'Laser Drill', abilities: ['ABILITY_LASER_DRILL'], move: 'MOVE_HYPER_DRILL', rolls: [1], status: STATUS1_BURN, cite: 'abilities.cc:11007-11015' },
  { n: 7, name: 'Piercing Solo', abilities: ['ABILITY_PIERCING_SOLO'], move: 'MOVE_HYPER_VOICE', rolls: [], status: STATUS1_BLEED, cite: 'abilities.cc:8011-8019' },
]

for (const item of STATUS_ITEMS) {
  const expectedRolls = item.rolls.length
  describe(`cycle3d3j ${item.n}: ${item.name} requires TARGET_TURN_DAMAGED (${item.cite})`, () => {
    it('hpDealt > 0: the ability roll lands and sets the status', () => {
      for (const ability of item.abilities) {
        const { state, rng } = runAttackerHit(item.move, ability, 20, item.rolls)
        expect(state.battlers[1]!.mon.status1).toBe(item.status)
        expect(rng.calls).toBe(expectedRolls)
      }
    })

    it('behind a Substitute: no status and no roll drawn', () => {
      for (const ability of item.abilities) {
        const { state, rng } = runAttackerSubstitute(item.move, ability, item.rolls)
        expect(state.battlers[1]!.mon.status1).toBe(0)
        expect(rng.calls).toBe(0)
      }
    })

    it('earlier hit damaged the target: hpDealt 0 still sets the status', () => {
      for (const ability of item.abilities) {
        const { state, rng } = runAttackerEarlierHitDamaged(item.move, ability, item.rolls)
        expect(state.battlers[1]!.mon.status1).toBe(item.status)
        expect(rng.calls).toBe(expectedRolls)
      }
    })
  })
}

// ---------------------------------------------------------------------------
// 8. Radio Jam (src/abilities.cc:7544-7552) -- CanBeDisabled(target) + IsSoundMove, 20% roll,
// then AbilityStatusEffect(MOVE_EFFECT_DISABLE) writes the target's lastMove and a 4-turn timer
// (battle_script_commands.c:2955-2959, :10714-10737). The target must have used a move (lastMove).
// ---------------------------------------------------------------------------
describe('cycle3d3j 8: Radio Jam requires TARGET_TURN_DAMAGED (abilities.cc:7544-7552)', () => {
  const radioJamSetup = (state: BattleState) => {
    state.battlers[1]!.lastMove = 'MOVE_TACKLE'
  }

  it('hpDealt > 0: the 20% roll lands and disables the target last move', () => {
    const { state, rng } = runAttackerHit('MOVE_HYPER_VOICE', 'ABILITY_RADIO_JAM', 20, [0], { setup: radioJamSetup })
    expect(state.battlers[1]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
    expect(state.battlers[1]!.volatiles.disableTimer).toBe(4)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no disable and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_HYPER_VOICE', 'ABILITY_RADIO_JAM', [0], 20, { setup: radioJamSetup })
    expect(state.battlers[1]!.volatiles.disabledMove).toBeNull()
    expect(state.battlers[1]!.volatiles.disableTimer).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still disables, one roll', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_HYPER_VOICE', 'ABILITY_RADIO_JAM', [0], 20, { setup: radioJamSetup })
    expect(state.battlers[1]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
    expect(state.battlers[1]!.volatiles.disableTimer).toBe(4)
    expect(rng.calls).toBe(1)
  })
})
