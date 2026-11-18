/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3n: attacker-half on-hit abilities Menacing Situation, Freezing Point / Cryo Proficiency,
// Spike Armor / Fragrant Daze / Hypnotic Touch, Magical Dust, Blood Stain, Daybreak and Woodland Curse
// gated on the bare `hpDealt > 0`; the C gates each on ShouldApplyOnHitEffect(opponent) = DidMoveHit() &&
// IsBattlerAlive(opponent), where DidMoveHit() = WasMoveSuccessful() && TARGET_TURN_DAMAGED.
//
// C lines checked:
//   src/battle_util.c:4056-4062
//       WasMoveSuccessful = !(MOVE_RESULT_NO_EFFECT) && attacker != target;
//       DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED;
//       ShouldApplyOnHitEffect(applyTo) = DidMoveHit && IsBattlerAlive(applyTo).
//   include/battle.h:750
//       TARGET_TURN_DAMAGED = gTurnStructs[gBattlerTarget].physicalDmg != 0 || ...specialDmg != 0.
//   src/abilities.cc (onAttacker hooks; ON_EITHER_ABILITY (:54) assigns the same lambda to both hooks,
//   so `opponent` is the hit target on this path):
//       1. Menacing Situation :7904-7919 -- contact, not already feared, `Random() % 100 < 30`, Fear.
//       2. Freezing Point     :6359-6371 -- CanGetFrostbite, contact 20% / non-contact 30% Frostbite;
//          Cryo Proficiency  :6387-6391 -- onAttacker = Impl<ABILITY_FREEZING_POINT>.onAttacker.
//       3. Spike Armor        :6798-6806 -- contact, 30% Bleed.
//          Fragrant Daze      :7792-7800 -- contact, 30% Confusion.
//          Hypnotic Touch     :11267-11275 -- contact, 20% Sleep.
//       4. Magical Dust       :3990-4003 -- contact, target not Psychic; type1/type2 = Psychic, type3 = Mystery.
//       5. Blood Stain        :8372-8386 -- contact, replaceable ability; replaces the target's ability.
//       6. Daybreak           :9193-9205 -- CanBeBurned, contact; Burn, no roll.
//       7. Woodland Curse     :9835-9846 -- contact, target not Grass; writes type3 = Grass only, no roll.
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
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
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

const BASE_TYPES: [string, string, string] = ['NORMAL', 'MYSTERY', 'MYSTERY']

// ---------------------------------------------------------------------------
// 1. Menacing Situation (src/abilities.cc:7904-7919). ShouldApplyOnHitEffect(opponent), contact,
// CHECK_NOT(fear), `Random() % 100 < 30`, then BattleScript_AbilitySetFear.
// ---------------------------------------------------------------------------
describe('cycle3d3n 1: Menacing Situation requires TARGET_TURN_DAMAGED (abilities.cc:7904-7919)', () => {
  const MENACING = 'ABILITY_MENACING_SITUATION'
  const feared = (state: BattleState) =>
    state.battlers[1]!.volatiles.fear || hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)

  it('hpDealt > 0: the 30% contact roll inflicts Fear, one draw', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', MENACING, 20, [5])
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('behind a Substitute: no Fear and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', MENACING, [5])
    expect(feared(state)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still inflicts Fear on the same one draw', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', MENACING, [5])
    expect(state.battlers[1]!.volatiles.fear).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('a non-contact move short-circuits before the roll: no Fear, no draw', () => {
    const { state, rng } = runAttackerHit('MOVE_SWIFT', MENACING, 20, [5])
    expect(feared(state)).toBe(false)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Freezing Point / Cryo Proficiency (src/abilities.cc:6359-6371; Cryo Proficiency's onAttacker is
// Impl<ABILITY_FREEZING_POINT>.onAttacker at :6387-6391). Contact rolls below 20, non-contact below 30.
// ---------------------------------------------------------------------------
describe('cycle3d3n 2: Freezing Point / Cryo Proficiency require TARGET_TURN_DAMAGED (abilities.cc:6359-6371, 6387-6391)', () => {
  const frostbitten = (state: BattleState) => hasFlag(state.battlers[1]!.mon.status1, STATUS1_FROSTBITE)

  for (const ability of ['ABILITY_FREEZING_POINT', 'ABILITY_CRYO_PROFICIENCY']) {
    it(`${ability}: a contact hit with roll 5 inflicts Frostbite, one draw`, () => {
      const { state, rng } = runAttackerHit('MOVE_TACKLE', ability, 20, [5])
      expect(frostbitten(state)).toBe(true)
      expect(rng.calls).toBe(1)
    })

    it(`${ability}: behind a Substitute no Frostbite and no roll drawn`, () => {
      const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', ability, [5])
      expect(frostbitten(state)).toBe(false)
      expect(rng.calls).toBe(0)
    })

    it(`${ability}: earlier hit damaged the target, hpDealt 0 still frostbites`, () => {
      const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', ability, [5])
      expect(frostbitten(state)).toBe(true)
      expect(rng.calls).toBe(1)
    })

    it(`${ability}: roll 25 fails the 20% contact chance but lands on the 30% non-contact chance`, () => {
      const contact = runAttackerHit('MOVE_TACKLE', ability, 20, [25])
      expect(frostbitten(contact.state)).toBe(false)
      expect(contact.rng.calls).toBe(1)

      const nonContact = runAttackerHit('MOVE_SWIFT', ability, 20, [25])
      expect(frostbitten(nonContact.state)).toBe(true)
      expect(nonContact.rng.calls).toBe(1)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. ON_EITHER_CONTACT_STATUS: Spike Armor / Fragrant Daze / Hypnotic Touch
//    (src/abilities.cc:6798-6806 / 7792-7800 / 11267-11275). Contact, CanX, then the per-ability chance.
// ---------------------------------------------------------------------------
describe('cycle3d3n 3: ON_EITHER_CONTACT_STATUS requires TARGET_TURN_DAMAGED (abilities.cc:6798-6806, 7792-7800, 11267-11275)', () => {
  // `draws` is the ability's own chance roll plus SetMoveEffect's duration draw where the C makes one:
  // Sleep draws `(Random() % 3) + 2` (battle_script_commands.c:2552-2557) and confusion draws
  // `(Random() % 2) + 3` (:2657-2661); Bleed has no duration draw.
  const CASES = [
    { ability: 'ABILITY_SPIKE_ARMOR', name: 'Bleed', draws: 1, landed: (m: SimBattleMon) => hasFlag(m.status1, STATUS1_BLEED) },
    { ability: 'ABILITY_FRAGRANT_DAZE', name: 'Confusion', draws: 2, landed: (m: SimBattleMon) => hasFlag(m.status2, STATUS2_CONFUSION) },
    { ability: 'ABILITY_HYPNOTIC_TOUCH', name: 'Sleep', draws: 2, landed: (m: SimBattleMon) => hasFlag(m.status1, STATUS1_SLEEP) },
  ]

  for (const c of CASES) {
    it(`${c.ability}: a contact hit with roll 5 lands ${c.name}, ${c.draws} draw(s)`, () => {
      const { state, rng } = runAttackerHit('MOVE_TACKLE', c.ability, 20, [5])
      expect(c.landed(state.battlers[1]!.mon)).toBe(true)
      expect(rng.calls).toBe(c.draws)
    })

    it(`${c.ability}: behind a Substitute nothing lands and no roll drawn`, () => {
      const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', c.ability, [5])
      expect(c.landed(state.battlers[1]!.mon)).toBe(false)
      expect(rng.calls).toBe(0)
    })

    it(`${c.ability}: earlier hit damaged the target, hpDealt 0 still lands ${c.name}`, () => {
      const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', c.ability, [5])
      expect(c.landed(state.battlers[1]!.mon)).toBe(true)
      expect(rng.calls).toBe(c.draws)
    })

    it(`${c.ability}: a non-contact move short-circuits before the roll`, () => {
      const { state, rng } = runAttackerHit('MOVE_SWIFT', c.ability, 20, [5])
      expect(c.landed(state.battlers[1]!.mon)).toBe(false)
      expect(rng.calls).toBe(0)
    })
  }
})

// ---------------------------------------------------------------------------
// 4. Magical Dust (src/abilities.cc:3990-4003). ShouldApplyOnHitEffect(opponent), contact, target not
// Psychic; writes type1/type2 = TYPE_PSYCHIC and type3 = TYPE_MYSTERY. No roll.
// ---------------------------------------------------------------------------
describe('cycle3d3n 4: Magical Dust requires TARGET_TURN_DAMAGED (abilities.cc:3990-4003)', () => {
  const MD = 'ABILITY_MAGICAL_DUST'
  const PSYCHIC: [string, string, string] = ['PSYCHIC', 'PSYCHIC', 'MYSTERY']

  it('hpDealt > 0: a contact hit rewrites the target to Psychic/Psychic/Mystery, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', MD, 20, [])
    expect(state.battlers[1]!.mon.types).toEqual(PSYCHIC)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: types unchanged and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', MD, [])
    expect(state.battlers[1]!.mon.types).toEqual(BASE_TYPES)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still rewrites the types', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', MD, [])
    expect(state.battlers[1]!.mon.types).toEqual(PSYCHIC)
    expect(rng.calls).toBe(0)
  })

  it('a non-contact move leaves the types alone', () => {
    const { state, rng } = runAttackerHit('MOVE_SWIFT', MD, 20, [])
    expect(state.battlers[1]!.mon.types).toEqual(BASE_TYPES)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Blood Stain (src/abilities.cc:8372-8386). ShouldApplyOnHitEffect(opponent), contact, the target's
// ability is replaceable (not in PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES), no ability shield; replaces it
// with Blood Stain. No roll.
// ---------------------------------------------------------------------------
describe('cycle3d3n 5: Blood Stain requires TARGET_TURN_DAMAGED (abilities.cc:8372-8386)', () => {
  const BS = 'ABILITY_BLOOD_STAIN'
  const RUN_AWAY = 'ABILITY_RUN_AWAY'
  // A fresh spec per test: the block writes target.mon.abilities.ability in place, and `battle()` reuses the
  // spec's abilities object by reference, so a shared literal would leak Blood Stain into later battles.
  const replaceableTarget = (): HelperExtra => ({ targetSpec: { abilities: hasAbility(RUN_AWAY) } })

  it('hpDealt > 0: a contact hit replaces the target ability with Blood Stain, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', BS, 20, [], replaceableTarget())
    expect(state.battlers[1]!.mon.abilities.ability).toBe(BS)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: the target ability is untouched and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', BS, [], 20, replaceableTarget())
    expect(state.battlers[1]!.mon.abilities.ability).toBe(RUN_AWAY)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still replaces the ability', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', BS, [], 20, replaceableTarget())
    expect(state.battlers[1]!.mon.abilities.ability).toBe(BS)
    expect(rng.calls).toBe(0)
  })

  it('a non-contact move leaves the ability alone', () => {
    const { state, rng } = runAttackerHit('MOVE_SWIFT', BS, 20, [], replaceableTarget())
    expect(state.battlers[1]!.mon.abilities.ability).toBe(RUN_AWAY)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Daybreak (src/abilities.cc:9193-9205). ShouldApplyOnHitEffect(opponent), CanBeBurned(opponent),
// contact, then Burn with no roll.
// ---------------------------------------------------------------------------
describe('cycle3d3n 6: Daybreak requires TARGET_TURN_DAMAGED (abilities.cc:9193-9205)', () => {
  const DB = 'ABILITY_DAYBREAK'
  const burned = (state: BattleState) => hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)

  it('hpDealt > 0: a contact hit burns the target with no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', DB, 20, [])
    expect(burned(state)).toBe(true)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: no burn and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', DB, [])
    expect(burned(state)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still burns', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', DB, [])
    expect(burned(state)).toBe(true)
    expect(rng.calls).toBe(0)
  })

  it('a non-contact move does not burn', () => {
    const { state, rng } = runAttackerHit('MOVE_SWIFT', DB, 20, [])
    expect(burned(state)).toBe(false)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Woodland Curse (src/abilities.cc:9835-9846). ShouldApplyOnHitEffect(opponent), contact, target not
// Grass (IS_BATTLER_OF_TYPE checks type1/type2/type3); writes only type3 = TYPE_GRASS. No roll.
// ---------------------------------------------------------------------------
describe('cycle3d3n 7: Woodland Curse requires TARGET_TURN_DAMAGED (abilities.cc:9835-9846)', () => {
  const WC = 'ABILITY_WOODLAND_CURSE'
  const WOODED: [string, string, string] = ['NORMAL', 'MYSTERY', 'GRASS']

  it('hpDealt > 0: a contact hit writes GRASS into type3 only, no roll', () => {
    const { state, rng } = runAttackerHit('MOVE_TACKLE', WC, 20, [])
    expect(state.battlers[1]!.mon.types).toEqual(WOODED)
    expect(rng.calls).toBe(0)
  })

  it('behind a Substitute: types unchanged and no roll drawn', () => {
    const { state, rng } = runAttackerSubstitute('MOVE_TACKLE', WC, [])
    expect(state.battlers[1]!.mon.types).toEqual(BASE_TYPES)
    expect(rng.calls).toBe(0)
  })

  it('earlier hit damaged the target: hpDealt 0 still writes GRASS into type3', () => {
    const { state, rng } = runAttackerEarlierHitDamaged('MOVE_TACKLE', WC, [])
    expect(state.battlers[1]!.mon.types).toEqual(WOODED)
    expect(rng.calls).toBe(0)
  })

  it('a non-contact move leaves the types alone', () => {
    const { state, rng } = runAttackerHit('MOVE_SWIFT', WC, 20, [])
    expect(state.battlers[1]!.mon.types).toEqual(BASE_TYPES)
    expect(rng.calls).toBe(0)
  })
})
