/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3o: Angel's Wrath's String Shot / Harden / Iron Defense cases.
//
// C lines checked (pipeline/.upstream/eliteredux-source):
//   src/abilities.cc:5588-5641 -- the whole ABILITY_ANGELS_WRATH onAttacker block. `battler` is the holder (= the
//       attacker); `target` is the move's target.
//   src/battle_util.c:4058 -- WasMoveSuccessful() = !(gMoveResultFlags & MOVE_RESULT_NO_EFFECT) && gBattlerAttacker != gBattlerTarget.
//   include/constants/global.h:68 -- NUM_STATS = 6.
//   src/abilities.cc:5592-5615 -- String Shot: CHECK(WasMoveSuccessful()); `break` when all four hazards are already
//       on the target's side; otherwise set all four and bump spikes->3 / toxic spikes->2, every firing.
//   src/abilities.cc:5617-5632 -- Harden: CHECK_NOT(MOVE_RESULT_NO_EFFECT); for i = 1..5 skipping STAT_DEF,
//       ChangeStatBuffs(battler, 1, i, MOVE_EFFECT_AFFECTS_USER, NULL). Each stat is its own call.
//   src/abilities.cc:5635-5641 -- Iron Defense: CHECK_NOT(MOVE_RESULT_NO_EFFECT); gRoundStructs[battler].protectMove = MOVE_IRON_DEFENSE.
//
// The WasMoveSuccessful / NO_EFFECT gates are the move-end context's `noEffect` flag, exactly as Hypnotic Trance
// (moveEnd.ts, abilities.cc:12593-12601) and Shields Down (abilities.cc:2680-2720) read it. A successful status move
// passes noEffect = false even though it deals no damage, so these tests pass it explicitly.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { runMoveEnd } from './moveEnd'
import type { MoveEndOutcome } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { TYPE_ROCK_ID } from './hazards'
import {
  MAX_STAT_STAGE,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TOXIC_SPIKES,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  clearFlag,
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

function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
  let idx = 0
  const r = { calls: 0, random16: () => { r.calls++; const val = values[idx] ?? 0; idx++; return val } }
  return r
}
function fixedDamage(amount: number): DamageResolver {
  return { resolve: () => ({ targetDamage: amount, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }) }
}
function testDeps(damage: DamageResolver = fixedDamage(0)): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT, moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}
const hasAbility = (ability: string | null): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

/** Two battlers, both carrying `ability` so the attacker===target dispatch (attackerId 1, targetId 1) has it too. */
function battle(ability = 'ABILITY_ANGELS_WRATH'): BattleState {
  return createBattleState({
    battlers: [0, 1].map((i) => createBattlerState(i, mon({
      speciesId: 'SPECIES_MUDKIP',
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: i === 0 ? 100 : 50 },
      hp: 300, maxHp: 300, abilities: hasAbility(ability), moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0], types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    }), 0)),
    rng: scriptedRng([0]),
  })
}

type RunResult = { state: BattleState; unmodelled: string[]; outcome: MoveEndOutcome }

/** The real move-end dispatch (runMoveEnd -> handleAttackerMoveEndAbility, case 6 MOVEEND_ABILITIES_ATTACKER). */
function runMove(
  state: BattleState,
  moveId: string,
  opts: { attackerId?: number; targetId?: number; noEffect?: boolean } = {},
): RunResult {
  const unmodelled: string[] = []
  const outcome = runMoveEnd({
    state,
    attackerId: opts.attackerId ?? 0,
    targetId: opts.targetId ?? 1,
    moveId,
    targetDamage: 0,
    hpDealt: 0,
    isCriticalHit: false,
    noEffect: opts.noEffect,
    deps: testDeps(),
    unmodelled,
    fainted: [],
  })
  return { state, unmodelled, outcome }
}

const sideHazards = (state: BattleState, side: number) => {
  const s = state.sides[side]!
  return {
    stealthRock: hasFlag(s.statuses, SIDE_STATUS_STEALTH_ROCK),
    toxicSpikes: hasFlag(s.statuses, SIDE_STATUS_TOXIC_SPIKES),
    spikes: hasFlag(s.statuses, SIDE_STATUS_SPIKES),
    stickyWeb: hasFlag(s.statuses, SIDE_STATUS_STICKY_WEB),
    stealthRockType: s.timers.stealthRockType,
    spikesAmount: s.timers.spikesAmount,
    toxicSpikesAmount: s.timers.toxicSpikesAmount,
  }
}

describe("Angel's Wrath: String Shot (abilities.cc:5592-5615)", () => {
  it('sets all four hazards on the target side and starts both layer counters at 1', () => {
    const state = battle()
    runMove(state, 'MOVE_STRING_SHOT', { noEffect: false }) // CHECK(WasMoveSuccessful())
    expect(sideHazards(state, 1)).toEqual({
      stealthRock: true, toxicSpikes: true, spikes: true, stickyWeb: true,
      stealthRockType: TYPE_ROCK_ID, spikesAmount: 1, toxicSpikesAmount: 1,
    })
    // The attacker's own side is untouched.
    expect(sideHazards(state, 0)).toEqual({
      stealthRock: false, toxicSpikes: false, spikes: false, stickyWeb: false,
      stealthRockType: 0, spikesAmount: 0, toxicSpikesAmount: 0,
    })
  })

  it('increments both layers on every firing, capped at 3 spikes and 2 toxic spikes', () => {
    // The `break` at abilities.cc:5596-5599 fires once ALL FOUR bits are set, and the first firing sets all four,
    // so the layers only advance on a later firing after one of them has worn off -- Sticky Web does exactly that
    // at end of turn (battle_util.c:1848-1853, stickyWebTimer). clearFlag models the worn-off bit; the point of the
    // case is that the counters increment while ANY one of the four is missing.
    const state = battle()
    const side = state.sides[1]!
    runMove(state, 'MOVE_STRING_SHOT', { noEffect: false })
    side.statuses = clearFlag(side.statuses, SIDE_STATUS_STICKY_WEB)
    runMove(state, 'MOVE_STRING_SHOT', { noEffect: false })
    expect(sideHazards(state, 1)).toMatchObject({ spikesAmount: 2, toxicSpikesAmount: 2 })
    side.statuses = clearFlag(side.statuses, SIDE_STATUS_STICKY_WEB)
    runMove(state, 'MOVE_STRING_SHOT', { noEffect: false })
    expect(sideHazards(state, 1)).toMatchObject({ spikesAmount: 3, toxicSpikesAmount: 2 })
    side.statuses = clearFlag(side.statuses, SIDE_STATUS_STICKY_WEB)
    runMove(state, 'MOVE_STRING_SHOT', { noEffect: false })
    expect(sideHazards(state, 1)).toMatchObject({ spikesAmount: 3, toxicSpikesAmount: 2 })
  })

  it('does nothing at all once all four bits are already set (the `break`)', () => {
    const state = battle()
    const side = state.sides[1]!
    side.statuses = setFlag(side.statuses, SIDE_STATUS_STEALTH_ROCK)
    side.statuses = setFlag(side.statuses, SIDE_STATUS_TOXIC_SPIKES)
    side.statuses = setFlag(side.statuses, SIDE_STATUS_SPIKES)
    side.statuses = setFlag(side.statuses, SIDE_STATUS_STICKY_WEB)
    side.timers.stealthRockType = TYPE_ROCK_ID
    side.timers.spikesAmount = 3
    side.timers.toxicSpikesAmount = 2
    runMove(state, 'MOVE_STRING_SHOT', { noEffect: false })
    expect(sideHazards(state, 1)).toMatchObject({ spikesAmount: 3, toxicSpikesAmount: 2 })
  })

  it('is skipped when the move had no effect (MOVE_RESULT_NO_EFFECT)', () => {
    const state = battle()
    runMove(state, 'MOVE_STRING_SHOT', { noEffect: true })
    expect(sideHazards(state, 1)).toMatchObject({
      stealthRock: false, toxicSpikes: false, spikes: false, stickyWeb: false,
      spikesAmount: 0, toxicSpikesAmount: 0,
    })
  })

  it('is skipped when attacker === target (WasMoveSuccessful is false)', () => {
    const state = battle()
    runMove(state, 'MOVE_STRING_SHOT', { attackerId: 1, targetId: 1, noEffect: false })
    expect(sideHazards(state, 1)).toMatchObject({
      stealthRock: false, toxicSpikes: false, spikes: false, stickyWeb: false,
      spikesAmount: 0, toxicSpikesAmount: 0,
    })
  })
})

describe("Angel's Wrath: Harden (abilities.cc:5617-5632)", () => {
  it('raises Atk, Speed, SpAtk and SpDef by one and leaves Def, accuracy and evasion alone', () => {
    const state = battle()
    const { outcome } = runMove(state, 'MOVE_HARDEN', { noEffect: false }) // CHECK_NOT(MOVE_RESULT_NO_EFFECT)
    const stages = state.battlers[0]!.mon.statStages
    expect(stages[STAT_ATK]).toBe(7) // DEFAULT_STAT_STAGE 6 + 1
    expect(stages[STAT_SPEED]).toBe(7)
    expect(stages[STAT_SPATK]).toBe(7)
    expect(stages[STAT_SPDEF]).toBe(7)
    expect(stages[STAT_DEF]).toBe(6)
    expect(stages[STAT_ACC]).toBe(6)
    expect(stages[STAT_EVASION]).toBe(6)
    // One ChangeStatBuffs call per stat, so four reported changes.
    expect(outcome.statChanges).toHaveLength(4)
    expect(outcome.statChanges!.map((c) => c.stat).sort()).toEqual([STAT_ATK, STAT_SPEED, STAT_SPATK, STAT_SPDEF].sort())
    expect(outcome.statChanges!.every((c) => c.battlerId === 0 && c.change === 1)).toBe(true)
  })

  it('skips only the stat already at +6, and continues past it', () => {
    const state = battle()
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const { outcome } = runMove(state, 'MOVE_HARDEN', { noEffect: false })
    const stages = state.battlers[0]!.mon.statStages
    expect(stages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(stages[STAT_ATK]).toBe(7)
    expect(stages[STAT_SPEED]).toBe(7)
    expect(stages[STAT_SPDEF]).toBe(7)
    expect(outcome.statChanges).toHaveLength(3)
    expect(outcome.statChanges!.some((c) => c.stat === STAT_SPATK)).toBe(false)
  })

  it('reports nothing when all four stats are already at +6', () => {
    const state = battle()
    const stages = state.battlers[0]!.mon.statStages
    for (const stat of [STAT_ATK, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) stages[stat] = MAX_STAT_STAGE
    const { outcome } = runMove(state, 'MOVE_HARDEN', { noEffect: false })
    expect(outcome.statChanges).toBeNull()
    for (const stat of [STAT_ATK, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) expect(stages[stat]).toBe(MAX_STAT_STAGE)
  })

  it('is skipped when the move had no effect', () => {
    const state = battle()
    const { outcome } = runMove(state, 'MOVE_HARDEN', { noEffect: true })
    const stages = state.battlers[0]!.mon.statStages
    for (const stat of [STAT_ATK, STAT_SPEED, STAT_SPATK, STAT_SPDEF]) expect(stages[stat]).toBe(6)
    expect(outcome.statChanges).toBeNull()
  })
})

describe("Angel's Wrath: Iron Defense (abilities.cc:5635-5641)", () => {
  it("writes MOVE_IRON_DEFENSE into the holder's round protectMove", () => {
    const state = battle()
    expect(state.battlers[0]!.round.protectMove).toBeNull()
    runMove(state, 'MOVE_IRON_DEFENSE', { noEffect: false })
    expect(state.battlers[0]!.round.protectMove).toBe('MOVE_IRON_DEFENSE')
  })

  it('leaves protectMove null when the move had no effect', () => {
    const state = battle()
    runMove(state, 'MOVE_IRON_DEFENSE', { noEffect: true })
    expect(state.battlers[0]!.round.protectMove).toBeNull()
  })
})

describe("Angel's Wrath: negative controls", () => {
  it('a different holder ability leaves the String Shot side state alone', () => {
    const state = battle('ABILITY_OVERGROW')
    const { unmodelled } = runMove(state, 'MOVE_STRING_SHOT', { noEffect: false })
    expect(sideHazards(state, 1)).toMatchObject({
      stealthRock: false, toxicSpikes: false, spikes: false, stickyWeb: false,
      spikesAmount: 0, toxicSpikesAmount: 0,
    })
    expect(unmodelled.some((note) => note.includes("Angel's Wrath"))).toBe(false)
  })

  it('pushes no "is not modelled" note for any of the three moves', () => {
    for (const moveId of ['MOVE_STRING_SHOT', 'MOVE_HARDEN', 'MOVE_IRON_DEFENSE']) {
      const state = battle()
      const { unmodelled } = runMove(state, moveId, { noEffect: false })
      expect(unmodelled.some((note) => note.includes('is not modelled'))).toBe(false)
    }
  })
})
