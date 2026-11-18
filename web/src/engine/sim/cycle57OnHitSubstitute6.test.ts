/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 57: sixth slice of on-hit defender ability hooks requiring TARGET_TURN_DAMAGED.
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
//       Freezing Point :6359-6367, Cryo Proficiency :6373-6391, Spike Armor :6798-6806,
//       Fragrant Daze :7792-7800, Hypnotic Touch :11267-11275, Magical Dust :3990-4003,
//       Blood Stain :8372-8385, Daybreak :9193-9200, Menacing Situation :7904-7919,
//       Woodland Curse :9835-9846, Crispy Cream :10838-10842 (Flame Body :1126-1134).
//
// The sim's `hpDealt` is the HP actually removed from the mon. executeTurn still removes mon HP
// behind a Substitute (a separate upstream gap: turn.ts's applyDamage call), so the substitute
// cases hand the move-end boundary the C's post-substitute state (`hpDealt: 0`, turn structs zero)
// through runMoveEnd, exactly as cycles 53-56 do. Positive controls go through executeTurn and runMoveEnd.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
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
  WEATHER_HAIL_ANY,
  WEATHER_HAIL_TEMPORARY,
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

/** Positive control at the moveEnd boundary: hpDealt equal to targetDamage (DidMoveHit is true). */
function runHit(
  moveId: string,
  ability: string,
  damage = 20,
  rolls: number[] = [0],
  extra?: { attackerSpec?: BattlerSpec; targetSpec?: BattlerSpec },
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], ...(extra?.attackerSpec ?? {}) },
    { abilities: hasAbility(ability), ...(extra?.targetSpec ?? {}) },
  ], rng)
  runMoveEnd({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    targetDamage: damage,
    hpDealt: damage,
    deps: testDeps(fixedDamage(damage)),
    unmodelled: [],
    fainted: [],
  })
  return { state, rng }
}

/** The C's post-substitute state: the Substitute absorbed the hit, so no HP was removed from the
 * mon and Cmd_datahpupdate's turn-struct writes (:1935-1959) never ran. `hpDealt: 0` is that state;
 * `targetDamage` stays the computed value, which is what the old `targetDamage > 0` gate read. */
function runSubstitute(
  ability: string,
  rolls: number[],
  targetDamage = 20,
  extra?: { attackerSpec?: BattlerSpec; targetSpec?: BattlerSpec },
): { state: BattleState; rng: RandomSource & { calls: number } } {
  return runSubstituteWith('MOVE_TACKLE', ability, rolls, targetDamage, extra)
}

/** runSubstitute with an arbitrary move id. */
function runSubstituteWith(
  moveId: string,
  ability: string,
  rolls: number[],
  targetDamage = 20,
  extra?: { attackerSpec?: BattlerSpec; targetSpec?: BattlerSpec },
): { state: BattleState; rng: RandomSource & { calls: number } } {
  const rng = scriptedRng(rolls)
  const state = battle([
    { moves: [moveId, null, null, null], ...(extra?.attackerSpec ?? {}) },
    { abilities: hasAbility(ability), ...(extra?.targetSpec ?? {}) },
  ], rng)
  state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
  state.battlers[1]!.volatiles.substituteHp = 75
  runMoveEnd({
    state, attackerId: 0, targetId: 1, moveId,
    targetDamage, hpDealt: 0, deps: testDeps(fixedDamage(targetDamage)), unmodelled: [], fainted: [],
  })
  return { state, rng }
}

// ---------------------------------------------------------------------------
// 1. Freezing Point / Cryo Proficiency Frostbite half (src/abilities.cc:6359-6367, :6387-6389)
// ---------------------------------------------------------------------------
describe('cycle57 1: Freezing Point / Cryo Proficiency Frostbite requires TARGET_TURN_DAMAGED (abilities.cc:6359-6367)', () => {
  it('behind a Substitute: attacker not frostbitten and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_FREEZING_POINT', [15])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(false)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(15)
  })

  it('behind a Substitute (Cryo Proficiency): attacker not frostbitten, weather unchanged, and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_CRYO_PROFICIENCY', [15])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(false)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(hasFlag(state.field.weather, WEATHER_HAIL_ANY)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(15)
  })

  it('without a Substitute: contact hit with roll 19 < 20 inflicts Frostbite', () => {
    const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_FREEZING_POINT', 20, [19])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: non-contact hit with roll 29 < 30 inflicts Frostbite', () => {
    const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_FREEZING_POINT', 20, [29])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: Cryo Proficiency contact hit with roll 19 < 20 inflicts Frostbite', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_CRYO_PROFICIENCY', 20, [19])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
  })

  it('without a Substitute: contact roll 20 >= 20 does not inflict Frostbite', () => {
    const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_FREEZING_POINT', 20, [20])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(false)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: non-contact roll 30 >= 30 does not inflict Frostbite', () => {
    const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_FREEZING_POINT', 20, [30])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. Cryo Proficiency Hail (src/abilities.cc:6373-6385)
// ---------------------------------------------------------------------------
describe('cycle57 2: Cryo Proficiency Hail requires TARGET_TURN_DAMAGED (abilities.cc:6373-6385)', () => {
  it('behind a Substitute: weather stays clear and duration 0', () => {
    const { state, rng } = runSubstitute('ABILITY_CRYO_PROFICIENCY', [99])
    expect(hasFlag(state.field.weather, WEATHER_HAIL_ANY)).toBe(false)
    expect(state.field.weather).toBe(0)
    expect(state.field.weatherDuration).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: contact hit starts Hail for 8 turns', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_CRYO_PROFICIENCY', 20, [99])
    expect(hasFlag(state.field.weather, WEATHER_HAIL_TEMPORARY)).toBe(true)
    expect(state.field.weatherDuration).toBe(8)
  })

  it('without a Substitute: non-contact move also starts Hail for 8 turns (no contact check)', () => {
    const { state } = runHit('MOVE_WATER_GUN', 'ABILITY_CRYO_PROFICIENCY', 20, [99])
    expect(hasFlag(state.field.weather, WEATHER_HAIL_TEMPORARY)).toBe(true)
    expect(state.field.weatherDuration).toBe(8)
  })

  it('without a Substitute: already active Hail duration is not reset', () => {
    const rng = scriptedRng([99])
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null] }, { abilities: hasAbility('ABILITY_CRYO_PROFICIENCY') }], rng)
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.weatherDuration = 3
    runMoveEnd({
      state, attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE',
      targetDamage: 20, hpDealt: 20, deps: testDeps(fixedDamage(20)), unmodelled: [], fainted: [],
    })
    expect(state.field.weatherDuration).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 3. ON_EITHER_CONTACT_STATUS: Spike Armor / Fragrant Daze / Hypnotic Touch
//    (src/abilities.cc:6798-6806 / 7792-7800 / 11267-11275)
// ---------------------------------------------------------------------------
describe('cycle57 3: ON_EITHER_CONTACT_STATUS requires TARGET_TURN_DAMAGED (abilities.cc:6798-6806, 7792-7800, 11267-11275)', () => {
  describe('Spike Armor (Bleed, 30% chance)', () => {
    it('behind a Substitute: attacker not bleeding and no roll drawn', () => {
      const { state, rng } = runSubstitute('ABILITY_SPIKE_ARMOR', [15])
      expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BLEED)).toBe(false)
      expect(state.battlers[0]!.mon.status1).toBe(0)
      expect(rng.calls).toBe(0)
      expect(rng.random16()).toBe(15)
    })

    it('without a Substitute: contact hit with roll 29 < 30 inflicts Bleed', () => {
      const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_SPIKE_ARMOR', 20, [29])
      expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BLEED)).toBe(true)
      expect(rng.calls).toBe(1)
    })

    it('without a Substitute: non-contact move does not inflict Bleed and draws no roll', () => {
      const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_SPIKE_ARMOR', 20, [15])
      expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BLEED)).toBe(false)
      expect(rng.calls).toBe(0)
    })

    it('without a Substitute: roll 30 >= 30 does not inflict Bleed', () => {
      const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_SPIKE_ARMOR', 20, [30])
      expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BLEED)).toBe(false)
      expect(rng.calls).toBe(1)
    })
  })

  describe('Fragrant Daze (Confusion, 30% chance)', () => {
    it('behind a Substitute: attacker not confused and no roll drawn', () => {
      const { state, rng } = runSubstitute('ABILITY_FRAGRANT_DAZE', [15])
      expect((state.battlers[0]!.mon.status2 & STATUS2_CONFUSION)).toBe(0)
      expect(rng.calls).toBe(0)
      expect(rng.random16()).toBe(15)
    })

    it('without a Substitute: contact hit with roll 29 < 30 inflicts Confusion', () => {
      const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_FRAGRANT_DAZE', 20, [29, 0])
      expect((state.battlers[0]!.mon.status2 & STATUS2_CONFUSION)).not.toBe(0)
      expect(rng.calls).toBe(2)
    })

    it('without a Substitute: non-contact move does not confuse and draws no roll', () => {
      const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_FRAGRANT_DAZE', 20, [15])
      expect((state.battlers[0]!.mon.status2 & STATUS2_CONFUSION)).toBe(0)
      expect(rng.calls).toBe(0)
    })

    it('without a Substitute: roll 30 >= 30 does not confuse', () => {
      const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_FRAGRANT_DAZE', 20, [30])
      expect((state.battlers[0]!.mon.status2 & STATUS2_CONFUSION)).toBe(0)
      expect(rng.calls).toBe(1)
    })
  })

  describe('Hypnotic Touch (Sleep, 20% chance)', () => {
    it('behind a Substitute: attacker not asleep and no roll drawn', () => {
      const { state, rng } = runSubstitute('ABILITY_HYPNOTIC_TOUCH', [15])
      expect((state.battlers[0]!.mon.status1 & STATUS1_SLEEP)).toBe(0)
      expect(rng.calls).toBe(0)
      expect(rng.random16()).toBe(15)
    })

    it('without a Substitute: contact hit with roll 19 < 20 inflicts Sleep', () => {
      const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_HYPNOTIC_TOUCH', 20, [19, 0])
      expect((state.battlers[0]!.mon.status1 & STATUS1_SLEEP)).not.toBe(0)
      expect(rng.calls).toBe(2)
    })

    it('without a Substitute: non-contact move does not sleep and draws no roll', () => {
      const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_HYPNOTIC_TOUCH', 20, [15])
      expect((state.battlers[0]!.mon.status1 & STATUS1_SLEEP)).toBe(0)
      expect(rng.calls).toBe(0)
    })

    it('without a Substitute: roll 20 >= 20 does not sleep', () => {
      const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_HYPNOTIC_TOUCH', 20, [20])
      expect((state.battlers[0]!.mon.status1 & STATUS1_SLEEP)).toBe(0)
      expect(rng.calls).toBe(1)
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Magical Dust defender half (src/abilities.cc:3990-4003)
// ---------------------------------------------------------------------------
describe('cycle57 4: Magical Dust defender half requires TARGET_TURN_DAMAGED (abilities.cc:3990-4003)', () => {
  it('behind a Substitute: attacker types remain unchanged and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_MAGICAL_DUST', [7])
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit changes attacker types to PSYCHIC/PSYCHIC/MYSTERY', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_MAGICAL_DUST', 20)
    expect(state.battlers[0]!.mon.types).toEqual(['PSYCHIC', 'PSYCHIC', 'MYSTERY'])
  })

  it('without a Substitute: non-contact move leaves attacker types unchanged', () => {
    const { state } = runHit('MOVE_WATER_GUN', 'ABILITY_MAGICAL_DUST', 20)
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })

  it('without a Substitute: attacker already Psychic is not changed', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_MAGICAL_DUST', 20, [0], {
      attackerSpec: { types: ['PSYCHIC', 'FIRE', 'MYSTERY'] },
    })
    expect(state.battlers[0]!.mon.types).toEqual(['PSYCHIC', 'FIRE', 'MYSTERY'])
  })
})

// ---------------------------------------------------------------------------
// 5. Blood Stain defender half (src/abilities.cc:8372-8385)
// ---------------------------------------------------------------------------
describe('cycle57 5: Blood Stain defender half requires TARGET_TURN_DAMAGED (abilities.cc:8372-8385)', () => {
  it('behind a Substitute: attacker ability remains unchanged and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_BLOOD_STAIN', [7], 20, {
      attackerSpec: { abilities: hasAbility('ABILITY_TORRENT') },
    })
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_TORRENT')
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit replaces attacker ability with ABILITY_BLOOD_STAIN', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_BLOOD_STAIN', 20, [0], {
      attackerSpec: { abilities: hasAbility('ABILITY_TORRENT') },
    })
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_BLOOD_STAIN')
  })

  it('without a Substitute: non-contact move leaves attacker ability unchanged', () => {
    const { state } = runHit('MOVE_WATER_GUN', 'ABILITY_BLOOD_STAIN', 20, [0], {
      attackerSpec: { abilities: hasAbility('ABILITY_TORRENT') },
    })
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_TORRENT')
  })

  it('without a Substitute: unsuppressable ability (ABILITY_COMATOSE) is not replaced', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_BLOOD_STAIN', 20, [0], {
      attackerSpec: { abilities: hasAbility('ABILITY_COMATOSE') },
    })
    expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_COMATOSE')
  })
})

// ---------------------------------------------------------------------------
// 6. Daybreak defender half (src/abilities.cc:9193-9200)
// ---------------------------------------------------------------------------
describe('cycle57 6: Daybreak defender half requires TARGET_TURN_DAMAGED (abilities.cc:9193-9200)', () => {
  it('behind a Substitute: attacker not burned and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_DAYBREAK', [7])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit inflicts Burn on the attacker', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_DAYBREAK', 20)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
  })

  it('without a Substitute (through executeTurn): contact hit inflicts Burn on the attacker', () => {
    const { state } = runTurn('ABILITY_DAYBREAK', [0])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
  })

  it('without a Substitute: non-contact move leaves attacker unburned', () => {
    const { state } = runHit('MOVE_WATER_GUN', 'ABILITY_DAYBREAK', 20)
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)
  })

  it('without a Substitute (through executeTurn): non-contact move leaves attacker unburned', () => {
    const { state } = runTurnWith('MOVE_WATER_GUN', 'ABILITY_DAYBREAK', [0])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)
  })

  it('without a Substitute: Fire-type attacker cannot be burned', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_DAYBREAK', 20, [0], {
      attackerSpec: { types: ['FIRE', 'MYSTERY', 'MYSTERY'] },
    })
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. Menacing Situation defender half (src/abilities.cc:7904-7919)
// ---------------------------------------------------------------------------
describe('cycle57 7: Menacing Situation defender half requires TARGET_TURN_DAMAGED (abilities.cc:7904-7919)', () => {
  it('behind a Substitute: attacker not feared and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_MENACING_SITUATION', [10])
    expect(state.battlers[0]!.volatiles.fear).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FEAR)).toBe(false)
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(10)
  })

  it('without a Substitute: contact hit with roll 29 < 30 inflicts Fear', () => {
    const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_MENACING_SITUATION', 20, [29])
    expect(state.battlers[0]!.volatiles.fear).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FEAR)).toBe(true)
    expect(rng.calls).toBe(1)
  })

  it('without a Substitute: non-contact move does not inflict Fear and draws no roll', () => {
    const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_MENACING_SITUATION', 20, [10])
    expect(state.battlers[0]!.volatiles.fear).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FEAR)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('without a Substitute: roll 30 >= 30 does not inflict Fear', () => {
    const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_MENACING_SITUATION', 20, [30])
    expect(state.battlers[0]!.volatiles.fear).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FEAR)).toBe(false)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 8. Woodland Curse defender half (src/abilities.cc:9835-9846)
// ---------------------------------------------------------------------------
describe('cycle57 8: Woodland Curse defender half requires TARGET_TURN_DAMAGED (abilities.cc:9835-9846)', () => {
  it('behind a Substitute: attacker types remain unchanged and no roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_WOODLAND_CURSE', [7])
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
    expect(rng.calls).toBe(0)
    expect(rng.random16()).toBe(7)
  })

  it('without a Substitute: contact hit adds GRASS to type3', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_WOODLAND_CURSE', 20)
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'GRASS'])
  })

  it('without a Substitute: non-contact move leaves attacker types unchanged', () => {
    const { state } = runHit('MOVE_WATER_GUN', 'ABILITY_WOODLAND_CURSE', 20)
    expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })

  it('without a Substitute: attacker already Grass is not modified', () => {
    const { state } = runHit('MOVE_TACKLE', 'ABILITY_WOODLAND_CURSE', 20, [0], {
      attackerSpec: { types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
    })
    expect(state.battlers[0]!.mon.types).toEqual(['GRASS', 'MYSTERY', 'MYSTERY'])
  })
})

// ---------------------------------------------------------------------------
// 9. Crispy Cream (src/abilities.cc:10838-10842)
// ---------------------------------------------------------------------------
describe('cycle57 9: Crispy Cream requires TARGET_TURN_DAMAGED (abilities.cc:10838-10842)', () => {
  it('behind a Substitute (Flame Body coin 1): coin drawn, attacker not burned, exactly 1 roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_CRISPY_CREAM', [1, 5])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
    expect(rng.random16()).toBe(5)
  })

  it('behind a Substitute (Freezing Point coin 0): coin drawn, attacker not frostbitten, exactly 1 roll drawn', () => {
    const { state, rng } = runSubstitute('ABILITY_CRISPY_CREAM', [0, 5])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(false)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
    expect(rng.random16()).toBe(5)
  })

  it('without a Substitute: Flame Body branch on contact with roll 29 < 30 inflicts Burn', () => {
    const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_CRISPY_CREAM', 20, [1, 29])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: Flame Body branch on non-contact with roll 19 < 20 inflicts Burn', () => {
    const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_CRISPY_CREAM', 20, [1, 19])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: Freezing Point branch on contact with roll 19 < 20 inflicts Frostbite', () => {
    const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_CRISPY_CREAM', 20, [0, 19])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: Freezing Point branch on non-contact with roll 29 < 30 inflicts Frostbite', () => {
    const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_CRISPY_CREAM', 20, [0, 29])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: Flame Body contact roll 30 >= 30 does not inflict Burn', () => {
    const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_CRISPY_CREAM', 20, [1, 30])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: Flame Body non-contact roll 20 >= 20 does not inflict Burn', () => {
    const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_CRISPY_CREAM', 20, [1, 20])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(false)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: Freezing Point contact roll 20 >= 20 does not inflict Frostbite', () => {
    const { state, rng } = runHit('MOVE_TACKLE', 'ABILITY_CRISPY_CREAM', 20, [0, 20])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(false)
    expect(rng.calls).toBe(2)
  })

  it('without a Substitute: Freezing Point non-contact roll 30 >= 30 does not inflict Frostbite', () => {
    const { state, rng } = runHit('MOVE_WATER_GUN', 'ABILITY_CRISPY_CREAM', 20, [0, 30])
    expect(hasFlag(state.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(false)
    expect(rng.calls).toBe(2)
  })
})
