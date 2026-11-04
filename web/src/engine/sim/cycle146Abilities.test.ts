/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import { applySwitchInAbilities } from './switchInAbility'
import { getAbilityStateOf, runEndTurnEffects, setAbilityStateOf } from './endTurn'
import { STATUS2_TRANSFORMED, WEATHER_HAIL_ANY } from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle96Abilities.test.ts.
// ---------------------------------------------------------------------------

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
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 as string | null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id,
    resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as SimItemData['naturalGift']) ?? null,
    grouping: (it.grouping as string | null) ?? null,
  }
}

function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id,
    baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0,
    formOf: (s.formOf as string | null | undefined) ?? null,
  }
}

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
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
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

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

type BattlerSpec = {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  level?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  playerParty?: SimPartyMon[],
  opponentParty?: SimPartyMon[],
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    playerParty,
    opponentParty,
  })
}

function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
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

function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  grounding: GroundingContext = GROUNDING,
  replacement?: ReplacementDeps,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
    replacement,
  }
}

const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })
const notModelled = (notes: string[], ability: string) => notes.filter((n) => n.includes(ability))

/** No actions: the turn loop's end-of-turn phase alone. */
function runEndTurn(specs: BattlerSpec[], grounding: GroundingContext = GROUNDING) {
  const state = battle(specs, scriptedRng([0, 0, 0, 0]))
  const out = executeTurn(state, specs.map(() => null), testDeps(fixedDamage(0), grounding))
  return { state, out }
}

/** Per-battler end-turn ladder alone. */
function endTurn(state: BattleState) {
  return runEndTurnEffects(state, state.battlers.map((_, i) => i), DATA_CONTEXT, { grounding: GROUNDING, statStageRatios: RATIOS })
}

// ---------------------------------------------------------------------------
// 1. Revelation (Unown <-> Unown Revelation, fraction 4)
// abilities.cc:10778-10783, battle_util.c:3807, :3812-3838
// At level 50, Unown (base HP 58) has maxHp 133.
// 133 / 4 = 33.25 -> trunc(133 / 4) = 33.
// ---------------------------------------------------------------------------

describe('Cycle 146 - Revelation (abilities.cc:10778-10783; battle_util.c:3807, :3812-3838)', () => {
  const REVELATION = hasAbility('ABILITY_REVELATION')
  const UNOWN_L50_MAX_HP = 133

  describe('onEntry', () => {
    it('low-form species above maxHp/4 becomes high form on entry', () => {
      const state = battle(
        [{ speciesId: 'SPECIES_UNOWN', maxHp: UNOWN_L50_MAX_HP, hp: 34, abilities: REVELATION }, {}],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN_REVELATION')
      expect(state.battlers[0]!.mon.hp).toBe(34)
      expect(state.battlers[0]!.volatiles.switchInAbilityDone[1]).toBe(true)
      expect(notModelled(unmodelled, 'REVELATION')).toEqual([])
    })

    it('high-form species at or below maxHp/4 becomes low form on entry', () => {
      const state = battle(
        [{ speciesId: 'SPECIES_UNOWN_REVELATION', maxHp: UNOWN_L50_MAX_HP, hp: 33, abilities: REVELATION }, {}],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')
      expect(state.battlers[0]!.mon.hp).toBe(33)
      expect(notModelled(unmodelled, 'REVELATION')).toEqual([])
    })

    it('exact boundary: high form at trunc(maxHp/4) reverts to low form, low form at trunc(maxHp/4) stays low', () => {
      // High form at exactly 33 <= 33 -> reverts to SPECIES_UNOWN
      const highAtBoundary = battle(
        [{ speciesId: 'SPECIES_UNOWN_REVELATION', maxHp: UNOWN_L50_MAX_HP, hp: 33, abilities: REVELATION }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(highAtBoundary, 0, testDeps(), [])
      expect(highAtBoundary.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')

      // Low form at exactly 33 (not > 33) -> stays SPECIES_UNOWN
      const lowAtBoundary = battle(
        [{ speciesId: 'SPECIES_UNOWN', maxHp: UNOWN_L50_MAX_HP, hp: 33, abilities: REVELATION }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(lowAtBoundary, 0, testDeps(), [])
      expect(lowAtBoundary.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')
    })

    it('negative: non-holder does not transform; transformed mon does not transform; no unrun hook gap line', () => {
      const nonHolder = battle(
        [{ speciesId: 'SPECIES_UNOWN', maxHp: UNOWN_L50_MAX_HP, hp: 34, abilities: hasAbility('ABILITY_RUN_AWAY') }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(nonHolder, 0, testDeps(), [])
      expect(nonHolder.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')

      const transformed = battle(
        [{ speciesId: 'SPECIES_UNOWN', maxHp: UNOWN_L50_MAX_HP, hp: 34, abilities: REVELATION, status2: STATUS2_TRANSFORMED }, {}],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(transformed, 0, testDeps(), unmodelled)
      expect(transformed.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')
      expect(notModelled(unmodelled, 'REVELATION')).toEqual([])
    })
  })

  describe('onEndTurn', () => {
    it('end of turn: low form above maxHp/4 becomes high form, high form at or below maxHp/4 reverts', () => {
      const up = runEndTurn([
        { speciesId: 'SPECIES_UNOWN', maxHp: UNOWN_L50_MAX_HP, hp: 34, abilities: REVELATION },
        {},
      ])
      expect(up.state.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN_REVELATION')
      expect(up.out.endTurn).toEqual([])

      const down = runEndTurn([
        { speciesId: 'SPECIES_UNOWN_REVELATION', maxHp: UNOWN_L50_MAX_HP, hp: 33, abilities: REVELATION },
        {},
      ])
      expect(down.state.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')
      expect(down.out.endTurn).toEqual([])
    })

    it('negative: non-holder and transformed do not transform on end turn; no unrun hook note', () => {
      const nonHolder = runEndTurn([
        { speciesId: 'SPECIES_UNOWN', maxHp: UNOWN_L50_MAX_HP, hp: 34, abilities: hasAbility('ABILITY_RUN_AWAY') },
        {},
      ])
      expect(nonHolder.state.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')

      const transformed = runEndTurn([
        { speciesId: 'SPECIES_UNOWN', maxHp: UNOWN_L50_MAX_HP, hp: 34, abilities: REVELATION, status2: STATUS2_TRANSFORMED },
        {},
      ])
      expect(transformed.state.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')

      const s = battle([{ abilities: REVELATION }, {}], scriptedRng())
      const { unmodelled } = endTurn(s)
      expect(notModelled(unmodelled, 'REVELATION')).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Locust Swarm (Wispy Waspy <-> Wispy Waspy Hivemind, fraction 4)
// abilities.cc:10770-10775, battle_util.c:3808, :3812-3838
// At level 50, Wispy Waspy (base HP 50) has maxHp 125.
// 125 / 4 = 31.25 -> trunc(125 / 4) = 31.
// ---------------------------------------------------------------------------

describe('Cycle 146 - Locust Swarm (abilities.cc:10770-10775; battle_util.c:3808, :3812-3838)', () => {
  const LOCUST_SWARM = hasAbility('ABILITY_LOCUST_SWARM')
  const WISPYWASPY_L50_MAX_HP = 125

  describe('onEntry', () => {
    it('low-form species above maxHp/4 becomes high form on entry', () => {
      const state = battle(
        [{ speciesId: 'SPECIES_WISPYWASPY', maxHp: WISPYWASPY_L50_MAX_HP, hp: 32, abilities: LOCUST_SWARM }, {}],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY_HIVEMIND')
      expect(state.battlers[0]!.mon.hp).toBe(32)
      expect(state.battlers[0]!.volatiles.switchInAbilityDone[1]).toBe(true)
      expect(notModelled(unmodelled, 'LOCUST_SWARM')).toEqual([])
    })

    it('high-form species at or below maxHp/4 becomes low form on entry', () => {
      const state = battle(
        [{ speciesId: 'SPECIES_WISPYWASPY_HIVEMIND', maxHp: WISPYWASPY_L50_MAX_HP, hp: 31, abilities: LOCUST_SWARM }, {}],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY')
      expect(state.battlers[0]!.mon.hp).toBe(31)
      expect(notModelled(unmodelled, 'LOCUST_SWARM')).toEqual([])
    })

    it('exact boundary: high form at trunc(maxHp/4) reverts to low form, low form at trunc(maxHp/4) stays low', () => {
      const highAtBoundary = battle(
        [{ speciesId: 'SPECIES_WISPYWASPY_HIVEMIND', maxHp: WISPYWASPY_L50_MAX_HP, hp: 31, abilities: LOCUST_SWARM }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(highAtBoundary, 0, testDeps(), [])
      expect(highAtBoundary.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY')

      const lowAtBoundary = battle(
        [{ speciesId: 'SPECIES_WISPYWASPY', maxHp: WISPYWASPY_L50_MAX_HP, hp: 31, abilities: LOCUST_SWARM }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(lowAtBoundary, 0, testDeps(), [])
      expect(lowAtBoundary.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY')
    })

    it('negative: non-holder does not transform; transformed mon does not transform; no unrun hook gap line', () => {
      const nonHolder = battle(
        [{ speciesId: 'SPECIES_WISPYWASPY', maxHp: WISPYWASPY_L50_MAX_HP, hp: 32, abilities: hasAbility('ABILITY_SHIELD_DUST') }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(nonHolder, 0, testDeps(), [])
      expect(nonHolder.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY')

      const transformed = battle(
        [{ speciesId: 'SPECIES_WISPYWASPY', maxHp: WISPYWASPY_L50_MAX_HP, hp: 32, abilities: LOCUST_SWARM, status2: STATUS2_TRANSFORMED }, {}],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(transformed, 0, testDeps(), unmodelled)
      expect(transformed.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY')
      expect(notModelled(unmodelled, 'LOCUST_SWARM')).toEqual([])
    })
  })

  describe('onEndTurn', () => {
    it('end of turn: low form above maxHp/4 becomes high form, high form at or below maxHp/4 reverts', () => {
      const up = runEndTurn([
        { speciesId: 'SPECIES_WISPYWASPY', maxHp: WISPYWASPY_L50_MAX_HP, hp: 32, abilities: LOCUST_SWARM },
        {},
      ])
      expect(up.state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY_HIVEMIND')
      expect(up.out.endTurn).toEqual([])

      const down = runEndTurn([
        { speciesId: 'SPECIES_WISPYWASPY_HIVEMIND', maxHp: WISPYWASPY_L50_MAX_HP, hp: 31, abilities: LOCUST_SWARM },
        {},
      ])
      expect(down.state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY')
      expect(down.out.endTurn).toEqual([])
    })

    it('negative: non-holder and transformed do not transform on end turn; no unrun hook note', () => {
      const nonHolder = runEndTurn([
        { speciesId: 'SPECIES_WISPYWASPY', maxHp: WISPYWASPY_L50_MAX_HP, hp: 32, abilities: hasAbility('ABILITY_SHIELD_DUST') },
        {},
      ])
      expect(nonHolder.state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY')

      const transformed = runEndTurn([
        { speciesId: 'SPECIES_WISPYWASPY', maxHp: WISPYWASPY_L50_MAX_HP, hp: 32, abilities: LOCUST_SWARM, status2: STATUS2_TRANSFORMED },
        {},
      ])
      expect(transformed.state.battlers[0]!.mon.speciesId).toBe('SPECIES_WISPYWASPY')

      const s = battle([{ abilities: LOCUST_SWARM }, {}], scriptedRng())
      const { unmodelled } = endTurn(s)
      expect(notModelled(unmodelled, 'LOCUST_SWARM')).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Shields Down (Minior Meteor <-> Minior Core, fraction 2)
// abilities.cc:2680-2682, battle_util.c:3798-3805, :3812-3838
// At level 50, Minior (base HP 60) has maxHp 135.
// 135 / 2 = 67.5 -> trunc(135 / 2) = 67.
// ---------------------------------------------------------------------------

describe('Cycle 146 - Shields Down (abilities.cc:2680-2682; battle_util.c:3798-3805, :3812-3838)', () => {
  const SHIELDS_DOWN = hasAbility('ABILITY_SHIELDS_DOWN')
  const MINIOR_L50_MAX_HP = 135

  describe('onEntry and onEndTurn with Minior Meteor Blue', () => {
    it('Meteor form at or below maxHp/2 transforms to Core form on entry', () => {
      const state = battle(
        [{ speciesId: 'SPECIES_MINIOR_METEOR_BLUE', maxHp: MINIOR_L50_MAX_HP, hp: 67, abilities: SHIELDS_DOWN }, {}],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(state, 0, testDeps(), unmodelled)
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_BLUE')
      expect(notModelled(unmodelled, 'SHIELDS_DOWN')).toEqual([])
    })

    it('Meteor form at or below maxHp/2 transforms to Core form on end turn', () => {
      const res = runEndTurn([
        { speciesId: 'SPECIES_MINIOR_METEOR_BLUE', maxHp: MINIOR_L50_MAX_HP, hp: 67, abilities: SHIELDS_DOWN },
        {},
      ])
      expect(res.state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_BLUE')
      expect(res.out.endTurn).toEqual([])
    })

    it('Core form above maxHp/2 reverts to Meteor form when ability state is 0, on entry and end turn', () => {
      const stateEntry = battle(
        [{ speciesId: 'SPECIES_MINIOR_CORE_BLUE', maxHp: MINIOR_L50_MAX_HP, hp: 68, abilities: SHIELDS_DOWN }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(stateEntry, 0, testDeps(), [])
      expect(stateEntry.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_METEOR_BLUE')

      const resEndTurn = runEndTurn([
        { speciesId: 'SPECIES_MINIOR_CORE_BLUE', maxHp: MINIOR_L50_MAX_HP, hp: 68, abilities: SHIELDS_DOWN },
        {},
      ])
      expect(resEndTurn.state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_METEOR_BLUE')
      expect(resEndTurn.out.endTurn).toEqual([])
    })

    it('Core form above maxHp/2 does NOT revert when abilityState is 1 (battle_util.c:3823-3825)', () => {
      // Entry: abilityState is 1 -> remains Core form
      const stateEntry = battle(
        [{ speciesId: 'SPECIES_MINIOR_CORE_BLUE', maxHp: MINIOR_L50_MAX_HP, hp: 68, abilities: SHIELDS_DOWN }, {}],
        scriptedRng(),
      )
      setAbilityStateOf(stateEntry.battlers[0]!, 'ABILITY_SHIELDS_DOWN', 1)
      expect(getAbilityStateOf(stateEntry.battlers[0]!, 'ABILITY_SHIELDS_DOWN')).toBe(1)
      applySwitchInAbilities(stateEntry, 0, testDeps(), [])
      expect(stateEntry.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_BLUE')

      // End turn: abilityState is 1 -> remains Core form
      const s = battle(
        [{ speciesId: 'SPECIES_MINIOR_CORE_BLUE', maxHp: MINIOR_L50_MAX_HP, hp: 68, abilities: SHIELDS_DOWN }, {}],
        scriptedRng(),
      )
      setAbilityStateOf(s.battlers[0]!, 'ABILITY_SHIELDS_DOWN', 1)
      endTurn(s)
      expect(s.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_BLUE')
    })
  })

  describe('base SPECIES_MINIOR row (SPECIES_MINIOR <-> SPECIES_MINIOR_CORE_RED)', () => {
    it('SPECIES_MINIOR at hp <= maxHp/2 transforms to SPECIES_MINIOR_CORE_RED', () => {
      const entry = battle(
        [{ speciesId: 'SPECIES_MINIOR', maxHp: MINIOR_L50_MAX_HP, hp: 67, abilities: SHIELDS_DOWN }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(entry, 0, testDeps(), [])
      expect(entry.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_RED')

      const et = runEndTurn([
        { speciesId: 'SPECIES_MINIOR', maxHp: MINIOR_L50_MAX_HP, hp: 67, abilities: SHIELDS_DOWN },
        {},
      ])
      expect(et.state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR_CORE_RED')
    })

    it('SPECIES_MINIOR_CORE_RED at hp > maxHp/2 reverts to SPECIES_MINIOR with ability state 0', () => {
      const entry = battle(
        [{ speciesId: 'SPECIES_MINIOR_CORE_RED', maxHp: MINIOR_L50_MAX_HP, hp: 68, abilities: SHIELDS_DOWN }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(entry, 0, testDeps(), [])
      expect(entry.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR')

      const et = runEndTurn([
        { speciesId: 'SPECIES_MINIOR_CORE_RED', maxHp: MINIOR_L50_MAX_HP, hp: 68, abilities: SHIELDS_DOWN },
        {},
      ])
      expect(et.state.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR')
    })

    it('negative: non-holder does not transform; transformed mon does not transform; no unrun hook gap line', () => {
      const nonHolder = battle(
        [{ speciesId: 'SPECIES_MINIOR', maxHp: MINIOR_L50_MAX_HP, hp: 67, abilities: hasAbility('ABILITY_REGENERATOR') }, {}],
        scriptedRng(),
      )
      applySwitchInAbilities(nonHolder, 0, testDeps(), [])
      expect(nonHolder.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR')

      const transformed = battle(
        [{ speciesId: 'SPECIES_MINIOR', maxHp: MINIOR_L50_MAX_HP, hp: 67, abilities: SHIELDS_DOWN, status2: STATUS2_TRANSFORMED }, {}],
        scriptedRng(),
      )
      const unmodelled: string[] = []
      applySwitchInAbilities(transformed, 0, testDeps(), unmodelled)
      expect(transformed.battlers[0]!.mon.speciesId).toBe('SPECIES_MINIOR')
      expect(notModelled(unmodelled, 'SHIELDS_DOWN')).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Zen Mode (Darmanitan -> Darmanitan Zen Mode, no revert in C)
// abilities.cc:2267-2272, battle_util.c:3840-3856
// ---------------------------------------------------------------------------

describe('Cycle 146 - Zen Mode (abilities.cc:2267-2272; battle_util.c:3840-3856)', () => {
  const ZEN_MODE = hasAbility('ABILITY_ZEN_MODE')

  it('SPECIES_DARMANITAN with Zen Mode becomes SPECIES_DARMANITAN_ZEN_MODE on entry and on end turn regardless of HP', () => {
    // On entry: hp 100
    const stateHigh = battle(
      [{ speciesId: 'SPECIES_DARMANITAN', maxHp: 100, hp: 100, abilities: ZEN_MODE }, {}],
      scriptedRng(),
    )
    const unmodelled: string[] = []
    applySwitchInAbilities(stateHigh, 0, testDeps(), unmodelled)
    expect(stateHigh.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN_ZEN_MODE')
    expect(notModelled(unmodelled, 'ZEN_MODE')).toEqual([])

    // On entry: low hp (1 HP)
    const stateLow = battle(
      [{ speciesId: 'SPECIES_DARMANITAN', maxHp: 100, hp: 1, abilities: ZEN_MODE }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(stateLow, 0, testDeps(), [])
    expect(stateLow.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN_ZEN_MODE')

    // On end turn:
    const et = runEndTurn([
      { speciesId: 'SPECIES_DARMANITAN', maxHp: 100, hp: 50, abilities: ZEN_MODE },
      {},
    ])
    expect(et.state.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN_ZEN_MODE')
    expect(et.out.endTurn).toEqual([])
  })

  it('SPECIES_DARMANITAN_GALARIAN becomes SPECIES_DARMANITAN_ZEN_MODE_GALARIAN on entry and end turn', () => {
    const entry = battle(
      [{ speciesId: 'SPECIES_DARMANITAN_GALARIAN', maxHp: 100, hp: 80, abilities: ZEN_MODE }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(entry, 0, testDeps(), [])
    expect(entry.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN_ZEN_MODE_GALARIAN')

    const et = runEndTurn([
      { speciesId: 'SPECIES_DARMANITAN_GALARIAN', maxHp: 100, hp: 80, abilities: ZEN_MODE },
      {},
    ])
    expect(et.state.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN_ZEN_MODE_GALARIAN')
    expect(et.out.endTurn).toEqual([])
  })

  it('Darmanitan at hp 0 does not change', () => {
    const dead = battle(
      [{ speciesId: 'SPECIES_DARMANITAN', maxHp: 100, hp: 0, abilities: ZEN_MODE }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(dead, 0, testDeps(), [])
    expect(dead.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN')
  })

  it('non-Darmanitan holder does not change', () => {
    const mudkip = battle(
      [{ speciesId: 'SPECIES_MUDKIP', maxHp: 100, hp: 100, abilities: ZEN_MODE }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(mudkip, 0, testDeps(), [])
    expect(mudkip.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
  })

  it('Zen Mode form does not revert (no branch in C)', () => {
    const zen = battle(
      [{ speciesId: 'SPECIES_DARMANITAN_ZEN_MODE', maxHp: 100, hp: 100, abilities: ZEN_MODE }, {}],
      scriptedRng(),
    )
    applySwitchInAbilities(zen, 0, testDeps(), [])
    expect(zen.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN_ZEN_MODE')

    const et = runEndTurn([
      { speciesId: 'SPECIES_DARMANITAN_ZEN_MODE', maxHp: 100, hp: 100, abilities: ZEN_MODE },
      {},
    ])
    expect(et.state.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN_ZEN_MODE')
  })

  it('negative: transformed mon does not change; no unrun hook gap note', () => {
    const transformed = battle(
      [{ speciesId: 'SPECIES_DARMANITAN', maxHp: 100, hp: 100, abilities: ZEN_MODE, status2: STATUS2_TRANSFORMED }, {}],
      scriptedRng(),
    )
    const unmodelled: string[] = []
    applySwitchInAbilities(transformed, 0, testDeps(), unmodelled)
    expect(transformed.battlers[0]!.mon.speciesId).toBe('SPECIES_DARMANITAN')
    expect(notModelled(unmodelled, 'ZEN_MODE')).toEqual([])

    const s = battle([{ abilities: ZEN_MODE }, {}], scriptedRng())
    const etOut = endTurn(s)
    expect(notModelled(etOut.unmodelled, 'ZEN_MODE')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Cool Exit (end-turn, state machine; abilities.cc:526-549)
// ---------------------------------------------------------------------------

describe('Cycle 146 - Cool Exit (src/abilities.cc:526-549)', () => {
  const COOL_EXIT = hasAbility('ABILITY_COOL_EXIT')

  it('state progression across three end turns: 0 -> 1 (no queue), 1 -> 2 (queues Chilly Reception), 2 -> 2 (no queue)', () => {
    const s = battle([{ abilities: COOL_EXIT }, {}], scriptedRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0

    // First end turn: state 0 -> 1, queuedExtraAttacks empty
    endTurn(s)
    expect(getAbilityStateOf(s.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(1)
    expect(s.queuedExtraAttacks).toEqual([])

    // Second end turn: state 1 -> 2, queuedExtraAttacks has Chilly Reception (no movePower key)
    endTurn(s)
    expect(getAbilityStateOf(s.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(2)
    expect(s.queuedExtraAttacks).toEqual([
      {
        ability: 'ABILITY_COOL_EXIT',
        move: 'MOVE_CHILLY_RECEPTION',
        attacker: 0,
        target: 0,
      },
    ])

    // Drain the queue manually for testing the third turn
    s.queuedExtraAttacks = []

    // Third end turn: state 2 stays 2, nothing queued
    endTurn(s)
    expect(getAbilityStateOf(s.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(2)
    expect(s.queuedExtraAttacks).toEqual([])
  })

  it('isFirstTurn === 2 holder: state and queue unchanged', () => {
    const s = battle([{ abilities: COOL_EXIT }, {}], scriptedRng())
    s.battlers[0]!.volatiles.isFirstTurn = 2
    setAbilityStateOf(s.battlers[0]!, 'ABILITY_COOL_EXIT', 1)

    endTurn(s)
    expect(getAbilityStateOf(s.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(1)
    expect(s.queuedExtraAttacks).toEqual([])
  })

  it('Cool Exit as an innate (slot 1) takes the same path', () => {
    const s = battle(
      [
        {
          abilities: { ability: 'ABILITY_RUN_AWAY', innates: ['ABILITY_COOL_EXIT', null, null] },
        },
        {},
      ],
      scriptedRng(),
    )
    s.battlers[0]!.volatiles.isFirstTurn = 0

    endTurn(s)
    expect(getAbilityStateOf(s.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(1)
    expect(s.queuedExtraAttacks).toEqual([])

    endTurn(s)
    expect(getAbilityStateOf(s.battlers[0]!, 'ABILITY_COOL_EXIT')).toBe(2)
    expect(s.queuedExtraAttacks).toEqual([
      {
        ability: 'ABILITY_COOL_EXIT',
        move: 'MOVE_CHILLY_RECEPTION',
        attacker: 0,
        target: 0,
      },
    ])
  })

  it('integration: after queued extra attack drains in executeTurn, Chilly Reception sets hail and switches user out', () => {
    const leadPartyMon = partyMon({
      speciesId: 'SPECIES_MUDKIP',
      hp: 100,
      maxHp: 100,
      abilities: COOL_EXIT,
    })
    const reservePartyMon = partyMon({
      speciesId: 'SPECIES_UNOWN',
      hp: 100,
      maxHp: 100,
    })
    const oppPartyMon = partyMon({ hp: 100, maxHp: 100 })

    const state = battle(
      [
        {
          speciesId: 'SPECIES_MUDKIP',
          abilities: COOL_EXIT,
          hp: 100,
          maxHp: 100,
        },
        {
          speciesId: 'SPECIES_MUDKIP',
          hp: 100,
          maxHp: 100,
        },
      ],
      scriptedRng(),
      [leadPartyMon, reservePartyMon],
      [oppPartyMon],
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    setAbilityStateOf(state.battlers[0]!, 'ABILITY_COOL_EXIT', 1)

    const replacement: ReplacementDeps = { chooseReplacement: () => 1 }

    // Execute a quiet turn (both battlers do null actions)
    executeTurn(state, [null, null], testDeps(fixedDamage(0), GROUNDING, replacement))

    // 1. Weather is now hail (WEATHER_HAIL_ANY)
    expect((state.field.weather & WEATHER_HAIL_ANY) !== 0).toBe(true)

    // 2. Battler 0 switched out to party mon 1 (SPECIES_UNOWN)
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_UNOWN')
  })

  it('no ABILITY_COOL_EXIT onEndTurn hook was not run line in unmodelled', () => {
    const s = battle([{ abilities: COOL_EXIT }, {}], scriptedRng())
    const { unmodelled } = endTurn(s)
    expect(notModelled(unmodelled, 'COOL_EXIT')).toEqual([])
  })
})
