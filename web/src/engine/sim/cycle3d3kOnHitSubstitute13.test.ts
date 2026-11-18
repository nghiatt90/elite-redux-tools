/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3k: attacker-half on-hit abilities Sharp Talons, Shocking Jaws/Maw, Stun Shock, Light Saber,
// Hydro Circuit, Pinnacle Blade, Demolitionist and Hollow Ice Zone that gated on the bare `hpDealt > 0` require
// TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4056-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/abilities.cc (onAttacker hooks):
//       1. Sharp Talons    :11345-11353: ShouldApplyOnHitEffect(target), MOVE_FLAG_KICK, CanBleed(target), Random() % 2
//       2. Shocking Jaws   :5716-5724: ShouldApplyOnHitEffect(target), CanBeParalyzed, FLAG_STRONG_JAW_BOOST, Random() % 2;
//          Shocking Maw    :8822-8823: `Impl<ABILITY_SHOCKING_JAWS>.onAttacker`
//       3. Stun Shock      :8917-8933: ShouldApplyOnHitEffect(target), Random() % 100 < 60, then Random() % 2:
//          case 0 CanBePoisoned -> POISON, case 1 CanBeParalyzed -> PARALYSIS
//       4. Light Saber     :11021-11038: ShouldApplyOnHitEffect(target), MOVE_FLAG_KEEN_EDGE, Random() % 2, then
//          Random() % 4: case 0 CanBeBurned -> BURN, case 1 CanBeParalyzed -> PARALYSIS
//       5. Hydro Circuit   :5368-5380: ShouldApplyOnHitEffect(battler) -- the HOLDER -- not at max HP, CanBattlerHeal,
//          Water move, heal max(1, gHpDealt / 4)
//       6. Pinnacle Blade  :8687-8720: CHECK(DidMoveHit()) -- no liveness requirement -- then a Keen Edge move
//       7. Demolitionist   :7771-7785: CHECK(DidMoveHit()) -- no liveness requirement -- then holder readiedAction,
//          then the target side's screens
//       8. Hollow Ice Zone :12178-12198: Ice move, ShouldApplyOnHitEffect(target), not already iceStatue, target lacks
//          the ability, then iceStatue + SET_BATTLER_TYPE + TryScheduleSwitch(holder)
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
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS2_SUBSTITUTE,
  hasFlag,
  setFlag,
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
// 1-4. Status abilities. Moves and flags confirmed in data/v2.65beta/moves.json:
//   Sharp Talons: MOVE_DOUBLE_KICK (kickBased), Shocking Jaws/Maw: MOVE_BITE (biteBased),
//   Light Saber: MOVE_AERIAL_ACE (sliceBased = Keen Edge). Stun Shock uses MOVE_TACKLE.
// `Random() % 2` succeeds on a nonzero draw (roll 1); Stun Shock's 60% check succeeds on 0.
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
  { n: 1, name: 'Sharp Talons', abilities: ['ABILITY_SHARP_TALONS'], move: 'MOVE_DOUBLE_KICK', rolls: [1], status: STATUS1_BLEED, cite: 'abilities.cc:11345-11353' },
  { n: 2, name: 'Shocking Jaws / Maw', abilities: ['ABILITY_SHOCKING_JAWS', 'ABILITY_SHOCKING_MAW'], move: 'MOVE_BITE', rolls: [1], status: STATUS1_PARALYSIS, cite: 'abilities.cc:5716-5724, :8822-8823' },
  { n: 3, name: 'Stun Shock (case 0)', abilities: ['ABILITY_STUN_SHOCK'], move: 'MOVE_TACKLE', rolls: [0, 0], status: STATUS1_POISON, cite: 'abilities.cc:8917-8933' },
  { n: 3, name: 'Stun Shock (case 1)', abilities: ['ABILITY_STUN_SHOCK'], move: 'MOVE_TACKLE', rolls: [0, 1], status: STATUS1_PARALYSIS, cite: 'abilities.cc:8917-8933' },
  { n: 4, name: 'Light Saber (case 0)', abilities: ['ABILITY_LIGHT_SABER'], move: 'MOVE_AERIAL_ACE', rolls: [1, 0], status: STATUS1_BURN, cite: 'abilities.cc:11021-11038' },
  { n: 4, name: 'Light Saber (case 1)', abilities: ['ABILITY_LIGHT_SABER'], move: 'MOVE_AERIAL_ACE', rolls: [1, 1], status: STATUS1_PARALYSIS, cite: 'abilities.cc:11021-11038' },
]

for (const item of STATUS_ITEMS) {
  const expectedRolls = item.rolls.length
  describe(`cycle3d3k ${item.n}: ${item.name} requires TARGET_TURN_DAMAGED (${item.cite})`, () => {
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
// 5. Hydro Circuit (src/abilities.cc:5368-5380). ShouldApplyOnHitEffect(battler) is the HOLDER, so the liveness
// term stays on the attacker. Heal = max(1, floor(hpDealt / 4)): a real 20-damage hit heals 5, while the
// earlier-hit case has hpDealt 0, so -gHpDealt / 4 is 0 and the C bumps it to -1 (exactly +1 HP).
// ---------------------------------------------------------------------------
describe('cycle3d3k 5: Hydro Circuit requires TARGET_TURN_DAMAGED (abilities.cc:5368-5380)', () => {
  const hurtAttacker: HelperExtra = { attackerSpec: { hp: 100, maxHp: 300 } }

  it('hpDealt > 0: heals floor(hpDealt / 4) with no ability roll', () => {
    const { state, rng } = runAttackerHit('MOVE_WATER_GUN', 'ABILITY_HYDRO_CIRCUIT', 20, [], hurtAttacker)
    expect(state.battlers[0]!.mon.hp).toBe(105)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no heal and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_WATER_GUN', 'ABILITY_HYDRO_CIRCUIT', [], 20, hurtAttacker)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still heals the bumped minimum of 1', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_WATER_GUN', 'ABILITY_HYDRO_CIRCUIT', [], 20, hurtAttacker)
    expect(state.battlers[0]!.mon.hp).toBe(101)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Pinnacle Blade (src/abilities.cc:8687-8720). CHECK(DidMoveHit()) only, so the target need not be alive;
// a Keen Edge move (MOVE_AERIAL_ACE, sliceBased) is required. The block zeroes the target's substituteHp.
// ---------------------------------------------------------------------------
describe('cycle3d3k 6: Pinnacle Blade requires TARGET_TURN_DAMAGED (abilities.cc:8687-8720)', () => {
  const screensUp = (state: BattleState) => {
    state.sides[1].statuses = setFlag(0, SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL)
    state.sides[1].timers.reflectTimer = 5
    state.sides[1].timers.lightscreenTimer = 5
    state.sides[1].timers.auroraVeilTimer = 5
  }
  const subAndScreens = (state: BattleState) => {
    screensUp(state)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 75
  }

  it('hpDealt > 0: shatters the target side screens with no ability roll', () => {
    const { state, rng } = runAttackerHit('MOVE_AERIAL_ACE', 'ABILITY_PINNACLE_BLADE', 20, [], { setup: screensUp })
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(state.sides[1].timers.reflectTimer).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: substituteHp and the screens survive, no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_AERIAL_ACE', 'ABILITY_PINNACLE_BLADE', [], 20, { setup: screensUp })
    expect(state.battlers[1]!.volatiles.substituteHp).toBe(75)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(true)
    expect(state.sides[1].timers.reflectTimer).toBe(5)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still destroys the Substitute and shatters the screens', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_AERIAL_ACE', 'ABILITY_PINNACLE_BLADE', [], 20, { setup: subAndScreens })
    expect(state.battlers[1]!.volatiles.substituteHp).toBe(0)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(state.sides[1].timers.reflectTimer).toBe(0)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Demolitionist (src/abilities.cc:7771-7785). CHECK(DidMoveHit()) then the holder's readiedAction, then the
// target side's screens. readiedAction is set by hand exactly as cycle106bAbilities.test.ts:376 does.
// ---------------------------------------------------------------------------
describe('cycle3d3k 7: Demolitionist requires TARGET_TURN_DAMAGED (abilities.cc:7771-7785)', () => {
  const readiedWithScreens = (state: BattleState) => {
    state.battlers[0]!.volatiles.readiedAction = true
    state.sides[1].statuses = setFlag(0, SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL)
    state.sides[1].timers.reflectTimer = 5
    state.sides[1].timers.lightscreenTimer = 5
    state.sides[1].timers.auroraVeilTimer = 5
  }

  it('hpDealt > 0: shatters the target side screens with no ability roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', 'ABILITY_DEMOLITIONIST', 20, [], { setup: readiedWithScreens })
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_AURORA_VEIL)).toBe(false)
    expect(state.sides[1].timers.reflectTimer).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: the screens survive, no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', 'ABILITY_DEMOLITIONIST', [], 20, { setup: readiedWithScreens })
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(true)
    expect(state.sides[1].timers.reflectTimer).toBe(5)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still shatters the screens', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', 'ABILITY_DEMOLITIONIST', [], 20, { setup: readiedWithScreens })
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(state.sides[1].timers.reflectTimer).toBe(0)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Hollow Ice Zone (src/abilities.cc:12178-12198). An Ice move (MOVE_ICE_BEAM), ShouldApplyOnHitEffect(target),
// the target is not already a statue and does not have the ability. SET_BATTLER_TYPE writes all three slots and
// the scheduled switch is the HOLDER's (switchingBattler = battler, abilities.cc:12192-12197).
// ---------------------------------------------------------------------------
describe('cycle3d3k 8: Hollow Ice Zone requires TARGET_TURN_DAMAGED (abilities.cc:12178-12198)', () => {
  const scheduled = [
    { ability: 'ABILITY_HOLLOW_ICE_ZONE', setAbilityState: false, switchingBattler: 0, sourceBattler: 0, script: 'EMERGENCY_EXIT' },
  ]

  it('hpDealt > 0: freezes the target and schedules the holder switch with no ability roll', () => {
    const { state, rng } = runAttackerHit('MOVE_ICE_BEAM', 'ABILITY_HOLLOW_ICE_ZONE', 20, [])
    expect(state.battlers[1]!.volatiles.iceStatue).toBe(true)
    expect(state.battlers[1]!.mon.types).toEqual(['ICE', 'ICE', 'MYSTERY'])
    expect(state.queuedSwitches).toEqual(scheduled)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no statue and no scheduled switch, no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_ICE_BEAM', 'ABILITY_HOLLOW_ICE_ZONE', [], 20)
    expect(state.battlers[1]!.volatiles.iceStatue).toBe(false)
    expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
    expect(state.queuedSwitches).toEqual([])
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still freezes and schedules the switch', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_ICE_BEAM', 'ABILITY_HOLLOW_ICE_ZONE', [], 20)
    expect(state.battlers[1]!.volatiles.iceStatue).toBe(true)
    expect(state.battlers[1]!.mon.types).toEqual(['ICE', 'ICE', 'MYSTERY'])
    expect(state.queuedSwitches).toEqual(scheduled)
    expect(rng.calls).toBe(0)
  })
})
