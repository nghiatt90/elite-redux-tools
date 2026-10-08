// Unit tests for status effect predicates, applyPrimaryStatusEffect, and status move handlers (cycle 24b).
//
// Every test case is hand-derived from the C source code at the pinned upstream SHA:
// - battle_script_commands.c:2240-2290, 2348-2665, 3025-3030, 6465-6479, 6579-6591, 11169-11174, 11840-11855, 12246-12260
// - battle_util.c:4908-4926, 5024-5088
// - abilities.cc:331-361, 713, 2241, 2680-2720
// - data/battle_scripts_1.s:3103-3113 (Hypnosis), 3957-3970 (Toxic), 5134-5154 (Swagger), 6090-6103 (Will-O-Wisp), 6411-6422 (Yawn)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  MAX_STAT_STAGE,
  SIDE_STATUS_SAFEGUARD,
  STAT_ATK,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS2_CONFUSION,
  STATUS2_ENRAGED,
  STATUS2_SUBSTITUTE,
  STATUS2_UPROAR,
  STATUS3_YAWN,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  getCounter,
  hasFlag,
} from './constants'
import {
  ALLOW_TERRAIN_IF_AIRBORNE_ABILITIES,
  CAN_STATUS_TYPE_ABILITIES,
  CHECK_BURN,
  CHECK_PARALYSIS,
  CHECK_POISON,
  CHECK_SLEEP,
  MOVE_EFFECT_BLEED,
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_CONFUSION,
  MOVE_EFFECT_ENRAGE,
  MOVE_EFFECT_FROSTBITE,
  MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_POISON,
  MOVE_EFFECT_SLEEP,
  MOVE_EFFECT_TOXIC,
  POLLINATE_IMMUNITIES_ABILITIES,
  POWDER_IMMUNE_ABILITIES,
  SET_STATE_ON_EFFECT_ABILITIES,
  STATUS_IMMUNE_ABILITIES,
  applyPrimaryStatusEffect,
  canBeBurned,
  canPoisonType,
  canSleep,
  isAbilityStatusProtected,
  isBattlerTerrainAffected,
  isStatusImmune,
} from './statusEffects'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const rawAbilityHooks = snapshot<Record<string, { hooks?: Record<string, unknown>; bitfields?: Record<string, string> }>>('abilityHooks.json')

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

// Fail loudly at module load if any ID is missing or renamed in data snapshots
const MOVE_HYPNOSIS = requireMove('MOVE_HYPNOSIS')
const MOVE_SLEEP_POWDER = requireMove('MOVE_SLEEP_POWDER')
const MOVE_TOXIC = requireMove('MOVE_TOXIC')
const MOVE_WILL_O_WISP = requireMove('MOVE_WILL_O_WISP')
const MOVE_YAWN = requireMove('MOVE_YAWN')
const MOVE_SWAGGER = requireMove('MOVE_SWAGGER')

const ABILITY_CORROSION = requireAbility('ABILITY_CORROSION')
const ABILITY_MISTY_SURGE = requireAbility('ABILITY_MISTY_SURGE')
const ABILITY_INSOMNIA = requireAbility('ABILITY_INSOMNIA')
const ABILITY_LIMBER = requireAbility('ABILITY_LIMBER')
const ABILITY_WATER_VEIL = requireAbility('ABILITY_WATER_VEIL')
const ABILITY_SHIELDS_DOWN = requireAbility('ABILITY_SHIELDS_DOWN')
const ABILITY_RUDE_AWAKENING = requireAbility('ABILITY_RUDE_AWAKENING')
const ABILITY_SOUNDPROOF = requireAbility('ABILITY_SOUNDPROOF')
const ABILITY_NOISE_CANCEL = requireAbility('ABILITY_NOISE_CANCEL')
const ABILITY_SHIELD_DUST = requireAbility('ABILITY_SHIELD_DUST')
const ABILITY_MOLD_BREAKER = requireAbility('ABILITY_MOLD_BREAKER')
const ABILITY_OVERCOAT = requireAbility('ABILITY_OVERCOAT')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: (id) => itemsById.get(id),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_SWORDS_DANCE', null, null, null],
    pp: [30, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(
  specs: {
    speciesId?: string
    types?: [string, string, string]
    spe?: number
    atk?: number
    spatk?: number
    hp?: number
    maxHp?: number
    status1?: number
    status2?: number
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: s.spatk ?? 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_SWORDS_DANCE', null, null, null],
          pp: s.pp ?? [30, 0, 0, 0],
        }),
        0,
      ),
    ),
    rng,
  })
}

function countingRng(): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return 0
    },
  }
  return r
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? 0
      idx++
      return val
    },
  }
  return r
}

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function dummyDamage(): DamageResolver & { calls: number } {
  const r = {
    calls: 0,
    resolve: () => {
      r.calls++
      return { targetDamage: null, attackerDamage: null, unmodelled: [] }
    },
  }
  return r
}

function testDeps(damage: DamageResolver = dummyDamage()): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('Status predicates (step 3, batch 2)', () => {
  it('Corrosion allows poisoning Steel type and Poison type; blocked otherwise', () => {
    // Derivation: CanPoisonType (src/battle_script_commands.c:6465-6470).
    // Steel and Poison types are immune unless attacker has ABILITY_CORROSION (or allies/variants).
    const deps = testDeps()

    // 1. Steel target without Corrosion: false
    const stateSteelNoCorr = battle([{}, { types: ['STEEL', 'MYSTERY', 'MYSTERY'] }], countingRng())
    expect(canPoisonType(stateSteelNoCorr, 0, 1, null, deps)).toBe(false)

    // 2. Steel target with Corrosion: true
    const stateSteelCorr = battle(
      [{ abilities: { ability: ABILITY_CORROSION, innates: [null, null, null] } }, { types: ['STEEL', 'MYSTERY', 'MYSTERY'] }],
      countingRng(),
    )
    expect(canPoisonType(stateSteelCorr, 0, 1, null, deps)).toBe(true)

    // 3. Poison target without Corrosion: false
    const statePoisonNoCorr = battle([{}, { types: ['POISON', 'MYSTERY', 'MYSTERY'] }], countingRng())
    expect(canPoisonType(statePoisonNoCorr, 0, 1, null, deps)).toBe(false)

    // 4. Poison target with Corrosion: true
    const statePoisonCorr = battle(
      [{ abilities: { ability: ABILITY_CORROSION, innates: [null, null, null] } }, { types: ['POISON', 'MYSTERY', 'MYSTERY'] }],
      countingRng(),
    )
    expect(canPoisonType(statePoisonCorr, 0, 1, null, deps)).toBe(true)
  })

  it('Misty Terrain: grounded target blocked, airborne target not blocked, airborne Misty Surge holder blocked', () => {
    // Derivation: IsBattlerTerrainAffected (src/battle_util.c:4908-4926).
    // Grounded battlers are affected by active field terrain.
    // Airborne battlers are not affected unless they hold an ability with allowTerrainIfAirborne (include/abilities.hh:158-166).
    // ABILITY_MISTY_SURGE has bitfields.allowTerrainIfAirborne for TERRAIN_MISTY.
    const deps = testDeps()

    // 1. Grounded battler under Misty Terrain: affected (and thus status immune)
    const stateGrounded = battle([{}, { types: ['WATER', 'MYSTERY', 'MYSTERY'] }], countingRng())
    stateGrounded.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
    expect(isBattlerTerrainAffected(stateGrounded, 1, STATUS_FIELD_MISTY_TERRAIN, deps)).toBe(true)
    expect(isStatusImmune(stateGrounded, 1, CHECK_POISON, 0, deps)).toBe(true)

    // 2. Airborne battler (Flying type) under Misty Terrain: NOT affected
    const stateAirborne = battle([{}, { types: ['FLYING', 'MYSTERY', 'MYSTERY'] }], countingRng())
    stateAirborne.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
    expect(isBattlerTerrainAffected(stateAirborne, 1, STATUS_FIELD_MISTY_TERRAIN, deps)).toBe(false)
    expect(isStatusImmune(stateAirborne, 1, CHECK_POISON, 0, deps)).toBe(false)

    // 3. Airborne battler holding ABILITY_MISTY_SURGE: affected via allowTerrainIfAirborne!
    const stateAirborneSurge = battle(
      [{}, { types: ['FLYING', 'MYSTERY', 'MYSTERY'], abilities: { ability: ABILITY_MISTY_SURGE, innates: [null, null, null] } }],
      countingRng(),
    )
    stateAirborneSurge.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
    expect(isBattlerTerrainAffected(stateAirborneSurge, 1, STATUS_FIELD_MISTY_TERRAIN, deps)).toBe(true)
    expect(isStatusImmune(stateAirborneSurge, 1, CHECK_POISON, 0, deps)).toBe(true)
  })

  it('Safeguard blocks status effects for protected side', () => {
    // Derivation: IsStatusImmune (src/battle_util.c:5024-5030).
    // Side status SIDE_STATUS_SAFEGUARD renders battlers on that side status-immune.
    const deps = testDeps()
    const state = battle([{}, {}], countingRng())

    // Without Safeguard: not immune
    expect(isStatusImmune(state, 1, CHECK_BURN, 0, deps)).toBe(false)

    // With Safeguard on defender side (battler 1 -> side 1):
    state.sides[1].statuses |= SIDE_STATUS_SAFEGUARD
    expect(isStatusImmune(state, 1, CHECK_BURN, 0, deps)).toBe(true)
  })

  it('Insomnia, Limber and Water Veil protect against sleep, paralysis and burn; pierced by Mold Breaker', () => {
    // Derivation: IsAbilityStatusProtected (src/battle_script_commands.c:6579-6591).
    // Insomnia protects from CHECK_SLEEP, Limber from CHECK_PARALYSIS, Water Veil from CHECK_BURN.
    // When attacker has Mold Breaker, breakable status abilities are bypassed.
    const deps = testDeps()

    // Insomnia
    const stateInsomnia = battle([{}, { abilities: { ability: ABILITY_INSOMNIA, innates: [null, null, null] } }], countingRng())
    expect(isAbilityStatusProtected(stateInsomnia, 1, CHECK_SLEEP, 0, deps)).toBe('ABILITY_INSOMNIA')
    expect(canSleep(stateInsomnia, 1, 0, deps)).toBe(false)

    // Limber
    const stateLimber = battle([{}, { abilities: { ability: ABILITY_LIMBER, innates: [null, null, null] } }], countingRng())
    expect(isAbilityStatusProtected(stateLimber, 1, CHECK_PARALYSIS, 0, deps)).toBe('ABILITY_LIMBER')

    // Water Veil
    const stateWaterVeil = battle([{}, { abilities: { ability: ABILITY_WATER_VEIL, innates: [null, null, null] } }], countingRng())
    expect(isAbilityStatusProtected(stateWaterVeil, 1, CHECK_BURN, 0, deps)).toBe('ABILITY_WATER_VEIL')
    expect(canBeBurned(stateWaterVeil, 1, 0, deps)).toBe(false)

    // Attacker has Mold Breaker: pierces Insomnia, Limber, Water Veil
    const stateMold = battle(
      [{ abilities: { ability: ABILITY_MOLD_BREAKER, innates: [null, null, null] } }, { abilities: { ability: ABILITY_INSOMNIA, innates: [null, null, null] } }],
      countingRng(),
    )
    expect(isAbilityStatusProtected(stateMold, 1, CHECK_SLEEP, 0, deps)).toBeNull()
    expect(canSleep(stateMold, 1, 0, deps)).toBe(true)
  })

  it('Shields Down protects Minior species, but does not protect non-Minior species', () => {
    // Derivation: IsAbilityStatusProtected (src/abilities.cc:2680-2720).
    // Shields Down only grants status immunity if the battler is one of the 7 Minior Meteor forms.
    const deps = testDeps()

    // Minior with Shields Down: protected
    const stateMinior = battle(
      [{}, { speciesId: 'SPECIES_MINIOR', abilities: { ability: ABILITY_SHIELDS_DOWN, innates: [null, null, null] } }],
      countingRng(),
    )
    expect(isAbilityStatusProtected(stateMinior, 1, CHECK_POISON, 0, deps)).toBe('ABILITY_SHIELDS_DOWN')

    // Mudkip with Shields Down (e.g. skill swap / innate / randomizer): NOT protected
    const stateMudkip = battle(
      [{}, { speciesId: 'SPECIES_MUDKIP', abilities: { ability: ABILITY_SHIELDS_DOWN, innates: [null, null, null] } }],
      countingRng(),
    )
    expect(isAbilityStatusProtected(stateMudkip, 1, CHECK_POISON, 0, deps)).toBeNull()
  })

  it('Rude Awakening protects against sleep only when its abilityState counter is active', () => {
    // Derivation: IsAbilityStatusProtected (src/abilities.cc:2241).
    // Rude Awakening checks GetAbilityState(battler, ability) > 0.
    const deps = testDeps()

    const state = battle([{}, { abilities: { ability: ABILITY_RUDE_AWAKENING, innates: [null, null, null] } }], countingRng())

    // When abilityState is 0 (inactive): not protected
    state.battlers[1]!.volatiles.abilityState[0] = 0
    expect(isAbilityStatusProtected(state, 1, CHECK_SLEEP, 0, deps)).toBeNull()

    // When abilityState is 1 (active): protected
    state.battlers[1]!.volatiles.abilityState[0] = 1
    expect(isAbilityStatusProtected(state, 1, CHECK_SLEEP, 0, deps)).toBe('ABILITY_RUDE_AWAKENING')
  })
})


describe('applyPrimaryStatusEffect (step 4, batch 2)', () => {
  it('sets exact status1 and status2 bit flags and counters', () => {
    // Derivation: SetMoveEffect (src/battle_script_commands.c:2348-2665, 3025-3030).
    const deps = testDeps()

    // 1. Poison
    {
      const state = battle([{}, {}], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_POISON, 'MOVE_POISON_STING', deps)
      expect(res.applied).toBe(true)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
    }

    // 2. Toxic: sets STATUS1_TOXIC_POISON and STATUS1_TOXIC_COUNTER is 0 (:2535-2536)
    {
      const state = battle([{}, {}], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_TOXIC, 'MOVE_TOXIC', deps)
      expect(res.applied).toBe(true)
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
      expect(getCounter(state.battlers[1]!.mon.status1, STATUS1_TOXIC_COUNTER)).toBe(0)
    }

    // 3. Burn
    {
      const state = battle([{}, {}], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_BURN, 'MOVE_WILL_O_WISP', deps)
      expect(res.applied).toBe(true)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    }

    // 4. Paralysis
    {
      const state = battle([{}, {}], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_PARALYSIS, 'MOVE_NONE', deps)
      expect(res.applied).toBe(true)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
    }

    // 5. Frostbite
    {
      const state = battle([{}, {}], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_FROSTBITE, 'MOVE_NONE', deps)
      expect(res.applied).toBe(true)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_FROSTBITE)
    }

    // 6. Bleed
    {
      const state = battle([{}, {}], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_BLEED, 'MOVE_NONE', deps)
      expect(res.applied).toBe(true)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
    }

    // 7. Enrage: sets STATUS2_ENRAGED in status2 (:3025-3030)
    {
      const state = battle([{}, {}], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_ENRAGE, 'MOVE_SWAGGER', deps)
      expect(res.applied).toBe(true)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ENRAGED)).toBe(true)
    }
  })

  it('draws sleep duration from scripted RNG: (Random() % 3) + 2', () => {
    // Derivation: src/battle_script_commands.c:2555:
    // sleepTurns = (Random() % 3) + 2.
    // - With RNG draw 5: 5 % 3 = 2, so 2 + 2 = 4 turns.
    // - With RNG draw 3: 3 % 3 = 0, so 0 + 2 = 2 turns.
    const deps = testDeps()

    // Test RNG = 5 -> 4 turns
    {
      const rng = scriptedRng([5])
      const state = battle([{}, {}], rng)
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_SLEEP, 'MOVE_HYPNOSIS', deps)
      expect(res.applied).toBe(true)
      expect(rng.calls).toBe(1)
      expect(getCounter(state.battlers[1]!.mon.status1, STATUS1_SLEEP)).toBe(4)
    }

    // Test RNG = 3 -> 2 turns
    {
      const rng = scriptedRng([3])
      const state = battle([{}, {}], rng)
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_SLEEP, 'MOVE_HYPNOSIS', deps)
      expect(res.applied).toBe(true)
      expect(rng.calls).toBe(1)
      expect(getCounter(state.battlers[1]!.mon.status1, STATUS1_SLEEP)).toBe(2)
    }
  })

  it('draws confusion duration from scripted RNG: (Random() % 2) + 3', () => {
    // Derivation: src/battle_script_commands.c:2660:
    // confusionTurns = (Random() % 2) + 3.
    // - With RNG draw 0: 0 % 2 = 0, so 0 + 3 = 3 turns.
    // - With RNG draw 1: 1 % 2 = 1, so 1 + 3 = 4 turns.
    const deps = testDeps()

    // Test RNG = 0 -> 3 turns
    {
      const rng = scriptedRng([0])
      const state = battle([{}, {}], rng)
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_CONFUSION, 'MOVE_CONFUSE_RAY', deps)
      expect(res.applied).toBe(true)
      expect(rng.calls).toBe(1)
      expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(3)
    }

    // Test RNG = 1 -> 4 turns
    {
      const rng = scriptedRng([1])
      const state = battle([{}, {}], rng)
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_CONFUSION, 'MOVE_CONFUSE_RAY', deps)
      expect(res.applied).toBe(true)
      expect(rng.calls).toBe(1)
      expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(4)
    }
  })

  it('Uproar blocks sleep, but Soundproof or Noise Cancel target ignores Uproar', () => {
    // Derivation: battle_script_commands.c:2395-2400.
    // If any battler has STATUS2_UPROAR, sleep fails unless target has Soundproof / Noise Cancel.
    const deps = testDeps()

    // 1. Uproar on attacker, normal defender: sleep fails
    {
      const state = battle([{}, {}], countingRng())
      state.battlers[0]!.mon.status2 |= STATUS2_UPROAR
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_SLEEP, 'MOVE_HYPNOSIS', deps)
      expect(res.applied).toBe(false)
      expect(state.battlers[1]!.mon.status1).toBe(0)
    }

    // 2. Defender with Soundproof: ignores Uproar, falls asleep
    {
      const state = battle([{}, { abilities: { ability: ABILITY_SOUNDPROOF, innates: [null, null, null] } }], countingRng())
      state.battlers[0]!.mon.status2 |= STATUS2_UPROAR
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_SLEEP, 'MOVE_HYPNOSIS', deps)
      expect(res.applied).toBe(true)
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_SLEEP)).toBe(true)
    }

    // 3. Defender with Noise Cancel: ignores Uproar, falls asleep
    {
      const state = battle([{}, { abilities: { ability: ABILITY_NOISE_CANCEL, innates: [null, null, null] } }], countingRng())
      state.battlers[0]!.mon.status2 |= STATUS2_UPROAR
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_SLEEP, 'MOVE_HYPNOSIS', deps)
      expect(res.applied).toBe(true)
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_SLEEP)).toBe(true)
    }
  })

  it('Shield Dust blocks non-primary effects; Mold Breaker breaks it; primary status bypasses Shield Dust', () => {
    // Derivation: battle_script_commands.c:2348-2350.
    // Shield Dust blocks secondary preventable status effects (!primary).
    // Mold Breaker ignores Shield Dust.
    // Primary status effects (primary === true) ignore Shield Dust.
    const deps = testDeps()

    // 1. Secondary status (primary: false) blocked by Shield Dust
    {
      const state = battle([{}, { abilities: { ability: ABILITY_SHIELD_DUST, innates: [null, null, null] } }], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_POISON, 'MOVE_POISON_STING', deps, undefined, false)
      expect(res.applied).toBe(false)
      expect(state.battlers[1]!.mon.status1).toBe(0)
    }

    // 2. Secondary status with Mold Breaker attacker breaks Shield Dust
    {
      const state = battle(
        [{ abilities: { ability: ABILITY_MOLD_BREAKER, innates: [null, null, null] } }, { abilities: { ability: ABILITY_SHIELD_DUST, innates: [null, null, null] } }],
        countingRng(),
      )
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_POISON, 'MOVE_POISON_STING', deps, undefined, false)
      expect(res.applied).toBe(true)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
    }

    // 3. Primary status (primary: true) ignores Shield Dust
    {
      const state = battle([{}, { abilities: { ability: ABILITY_SHIELD_DUST, innates: [null, null, null] } }], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_POISON, 'MOVE_POISON_STING', deps, undefined, true)
      expect(res.applied).toBe(true)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
    }
  })

  it('Substitute blocks status effects, but sound moves bypass Substitute', () => {
    // Derivation: battle_script_commands.c:2388, 12252-12260.
    // DoesSubstituteBlockMove blocks status moves unless the move is a sound move or has infiltrate.
    const deps = testDeps()

    // 1. Non-sound move blocked by Substitute
    {
      const state = battle([{}, { status2: STATUS2_SUBSTITUTE }], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_POISON, 'MOVE_POISON_STING', deps)
      expect(res.applied).toBe(false)
      expect(state.battlers[1]!.mon.status1).toBe(0)
    }

    // 2. Sound move (MOVE_HYPER_VOICE) bypasses Substitute
    {
      const state = battle([{}, { status2: STATUS2_SUBSTITUTE }], countingRng())
      const res = applyPrimaryStatusEffect(state, 0, 1, MOVE_EFFECT_POISON, 'MOVE_HYPER_VOICE', deps)
      expect(res.applied).toBe(true)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
    }
  })
})


describe('Status move handlers (step 2 & 5, batch 2)', () => {
  it('Hypnosis: exact RNG draw count and order (accuracy then sleep duration; miss draws only accuracy); PP deducted on miss', () => {
    // Derivation: BattleScript_EffectSleep (data/battle_scripts_1.s:3103-3113).
    // 1. ppreduce -> PP deducted from 30 to 29.
    // 2. requirecandoeffect -> canSleep check.
    // 3. accuracycheck (acc 60): draw 1. If roll >= 60, jumps to BattleScript_ButItFailed.
    // 4. setmoveeffect MOVE_EFFECT_SLEEP: draw 2 for sleep duration ((Random() % 3) + 2).
    const deps = testDeps()

    // Hit case: roll 0 (< 60), sleep duration roll 5 (5 % 3 + 2 = 4 turns)
    {
      const rng = scriptedRng([0, 5])
      const state = battle([{ moves: ['MOVE_HYPNOSIS', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      const out = executeTurn(state, [useMove(1, MOVE_HYPNOSIS), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(rng.calls).toBe(2)
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
      expect(getCounter(state.battlers[1]!.mon.status1, STATUS1_SLEEP)).toBe(4)
      expect(act.statusApplied).toEqual({ battlerId: 1, status: 'SLEEP' })
      expect(act.missed).toBe(false)
    }

    // Miss case: roll 80 (>= 60) -> misses after 1 draw, PP still deducted
    {
      const rng = scriptedRng([80])
      const state = battle([{ moves: ['MOVE_HYPNOSIS', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      const out = executeTurn(state, [useMove(1, MOVE_HYPNOSIS), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(rng.calls).toBe(1)
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
      expect(state.battlers[1]!.mon.status1).toBe(0)
      expect(act.statusApplied).toBeNull()
      expect(act.missed).toBe(true)
    }
  })

  it('Sleep Powder vs a powder-immune target: CANCELLER_POWDER_MOVE is gapped, so the script still runs', () => {
    // Powder immunity is CANCELLER_POWDER_MOVE (battle_util.c:3455-3466), before the script and before ppreduce.
    // attackCanceller.ts gaps it by name; the sleep script itself has no powder check.
    const deps = testDeps()
    const rng = countingRng()
    const state = battle(
      [{ moves: ['MOVE_SLEEP_POWDER', null, null, null], pp: [30, 0, 0, 0] }, { abilities: { ability: ABILITY_OVERCOAT, innates: [null, null, null] } }],
      rng,
    )
    const out = executeTurn(state, [useMove(1, MOVE_SLEEP_POWDER), null], deps)
    const act = out.actions.find((a) => a.battlerId === 0)!

    expect(act.unmodelled.some((u) => u.startsWith('CANCELLER_POWDER_MOVE'))).toBe(true)
    expect(state.battlers[0]!.mon.pp[0]).toBe(29)
  })

  it('Sleep vs a Substitute: requirecandoeffect passes, so accuracy is drawn, then SetMoveEffect blocks the status', () => {
    // VARIOUS_REQUIRE_CAN_DO_EFFECT (:8509-8520) only reaches JumpIfStandardStatusBlocking's Substitute check
    // once CanSleep has failed. CanSleep passes here, so accuracycheck draws (1), then DoesSubstituteBlockMove
    // inside SetMoveEffect (:2388) returns before the sleep-duration draw.
    const deps = testDeps()
    const rng = countingRng()
    const state = battle([{ moves: ['MOVE_HYPNOSIS', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    executeTurn(state, [useMove(1, MOVE_HYPNOSIS), null], deps)
    expect(rng.calls).toBe(1)
    expect(state.battlers[1]!.mon.status1).toBe(0)
  })

  it('Toxic: Poison and Steel immune by default, Corrosion bypasses both; Poison user never misses', () => {
    // Derivation: BattleScript_EffectToxic (data/battle_scripts_1.s:3957-3970) and B_TOXIC_NEVER_MISS.
    const deps = testDeps()

    // 1. Steel target immune without Corrosion: fails, PP deducted
    {
      const rng = countingRng()
      const state = battle(
        [{ moves: ['MOVE_TOXIC', null, null, null], pp: [30, 0, 0, 0] }, { types: ['STEEL', 'MYSTERY', 'MYSTERY'] }],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_TOXIC), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
      expect(state.battlers[1]!.mon.status1).toBe(0)
      expect(act.statusApplied).toBeNull()
    }

    // 2. Poison target immune without Corrosion: fails, PP deducted
    {
      const rng = countingRng()
      const state = battle(
        [{ moves: ['MOVE_TOXIC', null, null, null], pp: [30, 0, 0, 0] }, { types: ['POISON', 'MYSTERY', 'MYSTERY'] }],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_TOXIC), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
      expect(state.battlers[1]!.mon.status1).toBe(0)
      expect(act.statusApplied).toBeNull()
    }

    // 3. Corrosion attacker poisons Steel target
    {
      const rng = scriptedRng([0]) // accuracy roll hits
      const state = battle(
        [
          {
            moves: ['MOVE_TOXIC', null, null, null],
            pp: [30, 0, 0, 0],
            abilities: { ability: ABILITY_CORROSION, innates: [null, null, null] },
          },
          { types: ['STEEL', 'MYSTERY', 'MYSTERY'] },
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_TOXIC), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
      expect(act.statusApplied).toEqual({ battlerId: 1, status: 'TOXIC' })
    }

    // 4. Poison-type user never misses (B_TOXIC_NEVER_MISS): accuracy is 101, hits even on roll 95
    {
      const rng = scriptedRng([95])
      const state = battle(
        [
          {
            moves: ['MOVE_TOXIC', null, null, null],
            pp: [30, 0, 0, 0],
            types: ['POISON', 'MYSTERY', 'MYSTERY'],
          },
          {},
        ],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_TOXIC), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
      expect(act.statusApplied).toEqual({ battlerId: 1, status: 'TOXIC' })
      expect(act.missed).toBe(false)
    }
  })

  it('Will-O-Wisp: Fire type is immune, PP deducted on failure and miss', () => {
    // Derivation: BattleScript_EffectWillOWisp (data/battle_scripts_1.s:6090-6103).
    const deps = testDeps()

    // 1. Fire target is immune
    {
      const rng = countingRng()
      const state = battle(
        [{ moves: ['MOVE_WILL_O_WISP', null, null, null], pp: [30, 0, 0, 0] }, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] }],
        rng,
      )
      const out = executeTurn(state, [useMove(1, MOVE_WILL_O_WISP), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
      expect(state.battlers[1]!.mon.status1).toBe(0)
      expect(act.statusApplied).toBeNull()
    }

    // 2. Normal target hit: burn applied
    {
      const rng = scriptedRng([0]) // hits (acc 85)
      const state = battle([{ moves: ['MOVE_WILL_O_WISP', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      const out = executeTurn(state, [useMove(1, MOVE_WILL_O_WISP), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
      expect(act.statusApplied).toEqual({ battlerId: 1, status: 'BURN' })
    }

    // 3. Normal target miss: roll 90 (>= 85), PP deducted
    {
      const rng = scriptedRng([90])
      const state = battle([{ moves: ['MOVE_WILL_O_WISP', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      const out = executeTurn(state, [useMove(1, MOVE_WILL_O_WISP), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
      expect(state.battlers[1]!.mon.status1).toBe(0)
      expect(act.missed).toBe(true)
    }
  })

  it('Already-statused target causes status moves to fail', () => {
    // Derivation: requirecandoeffect checks existing status1.
    const deps = testDeps()

    for (const move of [MOVE_HYPNOSIS, MOVE_TOXIC, MOVE_WILL_O_WISP, MOVE_YAWN]) {
      const rng = countingRng()
      const state = battle(
        [{ moves: [move.id, null, null, null], pp: [30, 0, 0, 0] }, { status1: STATUS1_BURN }],
        rng,
      )
      const out = executeTurn(state, [useMove(1, move), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
      expect(act.statusApplied).toBeNull()
    }
  })

  it('Swagger raises target Attack +2 and enrages; maxed Attack target still gets enraged unless already enraged', () => {
    // Derivation: BattleScript_EffectSwagger (data/battle_scripts_1.s:5134-5154).
    // jumpifenragedandstatmaxed STAT_ATK, BattleScript_ButItFailed:
    // Only fails if BOTH target is enraged AND Attack is maxed (+6).
    // If not enraged, attempts +2 Atk; if Atk was already +6, Atk raise gives delta 0, but confusion/enrage still applies!
    const deps = testDeps()

    // 1. Standard Swagger hit: +2 Attack and enrage applied
    {
      const rng = scriptedRng([0])
      const state = battle([{ moves: ['MOVE_SWAGGER', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      const out = executeTurn(state, [useMove(1, MOVE_SWAGGER), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(act.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: 2 }])
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ENRAGED)).toBe(true)
      expect(act.statusApplied).toEqual({ battlerId: 1, status: 'ENRAGED' })
    }

    // 2. Maxed Attack (+6) but NOT enraged: stat change delta is 0, but still gets enraged!
    {
      const rng = scriptedRng([0])
      const state = battle([{ moves: ['MOVE_SWAGGER', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      state.battlers[1]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_SWAGGER), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(act.statChanges).toEqual([])
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ENRAGED)).toBe(true)
      expect(act.statusApplied).toEqual({ battlerId: 1, status: 'ENRAGED' })
    }

    // 3. Maxed Attack (+6) AND already enraged: jumps to BattleScript_ButItFailed!
    {
      const rng = scriptedRng([0])
      const state = battle([{ moves: ['MOVE_SWAGGER', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      state.battlers[1]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
      state.battlers[1]!.mon.status2 |= STATUS2_ENRAGED
      const out = executeTurn(state, [useMove(1, MOVE_SWAGGER), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(act.statChanges).toEqual([])
      expect(act.statusApplied).toBeNull()
    }
  })

  it('Yawn sets STATUS3_YAWN timer to 2; fails if already yawning or under Electric/Misty Terrain', () => {
    // Derivation: BattleScript_EffectYawn (data/battle_scripts_1.s:6411-6422), Cmd_setyawn (src/battle_script_commands.c:11840-11855).
    const deps = testDeps()

    // 1. Successful Yawn: sets STATUS3_YAWN timer to 2
    {
      const rng = countingRng()
      const state = battle([{ moves: ['MOVE_YAWN', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      const out = executeTurn(state, [useMove(1, MOVE_YAWN), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(getCounter(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(2)
      expect(act.statusApplied).toEqual({ battlerId: 1, status: 'YAWN' })
    }

    // 2. Already yawning: fails
    {
      const rng = countingRng()
      const state = battle([{ moves: ['MOVE_YAWN', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      state.battlers[1]!.statuses3 |= STATUS3_YAWN
      const out = executeTurn(state, [useMove(1, MOVE_YAWN), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(act.statusApplied).toBeNull()
    }

    // 3. Electric Terrain active: fails
    {
      const rng = countingRng()
      const state = battle([{ moves: ['MOVE_YAWN', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
      const out = executeTurn(state, [useMove(1, MOVE_YAWN), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(act.statusApplied).toBeNull()
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(false)
    }

    // 4. Misty Terrain active: fails
    {
      const rng = countingRng()
      const state = battle([{ moves: ['MOVE_YAWN', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
      state.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
      const out = executeTurn(state, [useMove(1, MOVE_YAWN), null], deps)
      const act = out.actions.find((a) => a.battlerId === 0)!

      expect(act.statusApplied).toBeNull()
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(false)
    }
  })
})


describe('Oracle tests: ability lists pinned against abilityHooks.json (step 6, batch 2)', () => {
  it('STATUS_IMMUNE_ABILITIES matches abilityHooks.json hooks.onStatusImmune', () => {
    const expected = Object.entries(rawAbilityHooks)
      .filter(([, entry]) => Boolean(entry.hooks?.onStatusImmune))
      .map(([id]) => id)
      .sort()

    expect([...STATUS_IMMUNE_ABILITIES].sort()).toEqual(expected)
    expect(STATUS_IMMUNE_ABILITIES).toHaveLength(40)
  })

  it('CAN_STATUS_TYPE_ABILITIES matches abilityHooks.json hooks.onCanStatusType', () => {
    const expected = Object.entries(rawAbilityHooks)
      .filter(([, entry]) => Boolean(entry.hooks?.onCanStatusType))
      .map(([id]) => id)
      .sort()

    expect([...CAN_STATUS_TYPE_ABILITIES].sort()).toEqual(expected)
    expect(CAN_STATUS_TYPE_ABILITIES).toHaveLength(8)
  })

  it('ALLOW_TERRAIN_IF_AIRBORNE_ABILITIES matches abilityHooks.json bitfields.allowTerrainIfAirborne', () => {
    const expected = Object.entries(rawAbilityHooks)
      .filter(([, entry]) => Boolean(entry.bitfields?.allowTerrainIfAirborne))
      .map(([id]) => id)
      .sort()

    expect([...ALLOW_TERRAIN_IF_AIRBORNE_ABILITIES].sort()).toEqual(expected)
    expect(ALLOW_TERRAIN_IF_AIRBORNE_ABILITIES).toHaveLength(12)
  })

  it('SET_STATE_ON_EFFECT_ABILITIES matches abilityHooks.json bitfields.setStateOnEffect', () => {
    const expected = Object.entries(rawAbilityHooks)
      .filter(([, entry]) => Boolean(entry.bitfields?.setStateOnEffect))
      .map(([id]) => id)
      .sort()

    expect([...SET_STATE_ON_EFFECT_ABILITIES].sort()).toEqual(expected)
    expect(SET_STATE_ON_EFFECT_ABILITIES).toHaveLength(9)
  })

  it('POWDER_IMMUNE_ABILITIES matches abilityHooks.json bitfields.powderImmune', () => {
    const expected = Object.entries(rawAbilityHooks)
      .filter(([, entry]) => entry.bitfields?.powderImmune === 'TRUE')
      .map(([id]) => id)
      .sort()

    expect([...POWDER_IMMUNE_ABILITIES].sort()).toEqual(expected)
    expect(POWDER_IMMUNE_ABILITIES).toHaveLength(4)
  })

  it('POLLINATE_IMMUNITIES_ABILITIES matches abilityHooks.json bitfields.pollinateImmunities', () => {
    const expected = Object.entries(rawAbilityHooks)
      .filter(([, entry]) => entry.bitfields?.pollinateImmunities === 'TRUE')
      .map(([id]) => id)
      .sort()

    expect([...POLLINATE_IMMUNITIES_ABILITIES].sort()).toEqual(expected)
    expect(POLLINATE_IMMUNITIES_ABILITIES).toHaveLength(2)
  })
})
