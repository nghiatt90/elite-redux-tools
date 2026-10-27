/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 87: the multi-hit hit loop (MOVEEND_MULTIHIT_MOVE, battle_script_commands.c:4880-4921) and the damage-formula /
// weather / terrain effects the move-effect audit still flagged. Every expected number is hand-derived from the C cited on the
// test; the bridge resolver is used where a number depends on the damage formula, a fake resolver where only the loop matters.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolveContext, DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  STAT_DEF,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_TOXIC_POISON,
  STATUS2_CONFUSION,
  STATUS2_DEFENSE_CURL,
  STATUS2_FLINCHED,
  STATUS2_NIGHTMARE,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_RAIN_PERMANENT,
  WEATHER_RAIN_PRIMAL,
  WEATHER_RAIN_TEMPORARY,
  STATUS4_ELECTRIFIED,
  STATUS4_GHASTLY_ECHO,
  STATUS4_PLASMA_FISTS,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_TAILWIND,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_ION_DELUGE,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  STATUS_FIELD_TERRAIN_PERMANENT,
  STAT_ATK,
  hasFlag,
  setCounter,
} from './constants'
import { applySecondaryMoveEffects } from './moveEffects'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, any>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const speciesById = new Map(snapshot<Array<SimSpeciesData>>('species.json').map((s) => [s.id, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const natures = snapshot<any>('natures.json')
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
    argumentInt: m.argument?.kind === 'int' ? (m.argument.value as number) : null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

/** The engine's MoveData shape (calculate.ts), as damageResolver.test.ts builds it. */
function engineMove(id: string): any {
  const move = movesById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: move.effect === 'EFFECT_MISC_HIT' && arg?.kind === 'misc' ? arg.misc : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
    argumentStatus: move.effect === 'EFFECT_DOUBLE_DMG_IF_STATUS1' && arg?.kind === 'status' ? arg.status : null,
  }
}

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

function groundingWith(holdEffects: Record<number, string> = {}): GroundingContext {
  return { holdEffectOf: (id: number) => holdEffects[id] ?? null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
}
const GROUNDING = groundingWith()

const DATA_CONTEXT: SimDataContext = {
  species: (id) => speciesById.get(id),
  item: (id) => itemsById.get(id),
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

interface BattlerSpec {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hiddenPowerType?: string | null
  hp?: number
  maxHp?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
  level?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource, playerParty?: SimPartyMon[], opponentParty?: SimPartyMon[]): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          hiddenPowerType: s.hiddenPowerType ?? null,
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
          level: s.level ?? 50,
        }),
        0,
      ),
    ),
    rng,
    playerParty,
    opponentParty,
  })
}

function countingRng(): RandomSource & { calls: number } {
  const r = { calls: 0, random16: () => { r.calls++; return 0 } }
  return r
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[idx++] ?? 0
    },
  }
  return r
}

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ?? 'NORMAL',
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

/** A resolver that records the context of every call and returns a fixed amount. */
function recordingDamage(amount: number): DamageResolver & { contexts: Array<DamageResolveContext | undefined>; counters: number[] } {
  const r = {
    contexts: [] as Array<DamageResolveContext | undefined>,
    counters: [] as number[],
    resolve: (state: BattleState, attackerId: number, _t: number, _a: ChosenAction, context?: DamageResolveContext) => {
      r.contexts.push(context)
      r.counters.push(state.battlers[attackerId]!.turn.multiHitCounter)
      return { targetDamage: amount, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
    },
  }
  return r
}

function bridgeDamage(random: RandomSource): DamageResolver {
  const bridge: BridgeDeps = { grounding: GROUNDING, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext: DATA_CONTEXT, inverseBattle: false }
  const deps: BridgeDamageResolverDeps = {
    ...bridge,
    moveData: (id) => (movesById.has(id) ? engineMove(id) : undefined),
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants: natures,
    random,
  }
  return createBridgeDamageResolver(deps)
}

function testDeps(damage: DamageResolver, grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
    moveBehaviors,
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string) => ({ ability: id, innates: [null, null, null] as [null, null, null] })

// -----------------------------------------------------------------------------
// Group 1: the multi-hit loop
// -----------------------------------------------------------------------------

describe('multi-hit loop: MOVEEND_MULTIHIT_MOVE (battle_script_commands.c:4880-4921)', () => {
  it('draws gCritRoll = Random() % 24 after EVERY counted hit, the last included, and hands it to the next hit (:4885)', () => {
    // Skill Link: 5 hits, no hit-count draw. Draws: accuracy (50), then one crit roll per hit (1,2,3,4,5).
    const rng = scriptedRng([50, 1, 2, 3, 4, 5])
    const dmg = recordingDamage(10)
    const state = battle([{ moves: slot('MOVE_ARM_THRUST'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_ARM_THRUST')), null], testDeps(dmg))
    expect(rng.calls).toBe(6)
    // Hit 1 draws its own crit inside the resolver (no critRoll); hits 2-5 receive the roll drawn after the previous hit.
    expect(dmg.contexts.map((c) => c?.critRoll)).toEqual([undefined, 1, 2, 3, 4])
    expect(dmg.contexts.map((c) => c?.hitIndex)).toEqual([0, 1, 2, 3, 4])
    expect(dmg.counters).toEqual([5, 4, 3, 2, 1])
    expect(out.actions[0].targetDamage).toBe(50)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19) // PP is deducted once, not per hit (HITMARKER_NO_PPDEDUCT, :1467-1470)
    expect(out.actions[0].unmodelled).not.toContain('secondary effect of EFFECT_MULTI_HIT not modelled')
  })

  it('a single-hit move takes one pass: no hitIndex, no crit-roll draw', () => {
    const rng = scriptedRng([50])
    const dmg = recordingDamage(10)
    const state = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, {}], rng)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(dmg))
    expect(rng.calls).toBe(1)
    expect(dmg.contexts).toEqual([{ targetHasActedThisTurn: false }])
  })

  it('stops when the target is already immune on the first hit (JumpIfMoveFailed zeroes the counter, :1213-1215)', () => {
    const dmg = recordingDamage(0)
    const state = battle([{ moves: slot('MOVE_ARM_THRUST'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], scriptedRng([50]))
    const out = executeTurn(state, [useMove(1, move('MOVE_ARM_THRUST')), null], testDeps(dmg))
    expect(dmg.contexts).toHaveLength(1)
    expect(out.actions[0].targetDamage).toBe(0)
  })

  it('stops as soon as the target faints', () => {
    const dmg = recordingDamage(10)
    const state = battle([{ moves: slot('MOVE_ARM_THRUST'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, { hp: 15, maxHp: 100 }], scriptedRng([50]))
    const out = executeTurn(state, [useMove(1, move('MOVE_ARM_THRUST')), null], testDeps(dmg))
    expect(dmg.contexts).toHaveLength(2) // 10 then the 5 HP that were left; the third hit never runs (:4898)
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(out.actions[0].fainted).toContain(1)
  })

  it('stops when the attacker faints mid-sequence (Rocky Helmet, MOVEEND_ITEM_EFFECTS_TARGET runs after every hit)', () => {
    const dmg = recordingDamage(10)
    const grounding = groundingWith({ 1: 'HOLD_EFFECT_ROCKY_HELMET' })
    // maxHp 100 / 6 = 16 per contact hit: an attacker on 10 HP faints on hit 1.
    const state = battle([{ moves: slot('MOVE_FURY_SWIPES'), pp: pps, hp: 10, abilities: ability('ABILITY_SKILL_LINK') }, { itemId: 'ITEM_ROCKY_HELMET' }], scriptedRng([50]))
    const out = executeTurn(state, [useMove(1, move('MOVE_FURY_SWIPES')), null], testDeps(dmg, grounding))
    expect(dmg.contexts).toHaveLength(1)
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(out.actions[0].fainted).toContain(0)
  })

  it('contact items and abilities run after EVERY hit (cases 0-18), recoil-class items once after the last (cases 20-30)', () => {
    // Double Kick: 2 contact hits, Rocky Helmet on the target: floor(100 / 6) = 16 each.
    const grounding = groundingWith({ 1: 'HOLD_EFFECT_ROCKY_HELMET' })
    const helmet = battle([{ moves: slot('MOVE_DOUBLE_KICK'), pp: pps }, { itemId: 'ITEM_ROCKY_HELMET' }], scriptedRng([50]))
    executeTurn(helmet, [useMove(1, move('MOVE_DOUBLE_KICK')), null], testDeps(recordingDamage(10), grounding))
    expect(helmet.battlers[0]!.mon.hp).toBe(100 - 16 * 2)

    // Life Orb on the attacker: floor(100 / 10) = 10, ONCE for five hits (MOVEEND_LIFEORB_SHELLBELL, :4823-4827).
    const lifeOrb = battle([{ moves: slot('MOVE_ARM_THRUST'), pp: pps, itemId: 'ITEM_LIFE_ORB', abilities: ability('ABILITY_SKILL_LINK') }, {}], scriptedRng([50]))
    executeTurn(lifeOrb, [useMove(1, move('MOVE_ARM_THRUST')), null], testDeps(recordingDamage(10), groundingWith({ 0: 'HOLD_EFFECT_LIFE_ORB' })))
    expect(lifeOrb.battlers[0]!.mon.hp).toBe(90)

    // Shell Bell: savedDmg sums the hits (5 x 10 = 50), heal = 50 / 4 = 12, once.
    const bell = battle([{ moves: slot('MOVE_ARM_THRUST'), pp: pps, hp: 70, itemId: 'ITEM_SHELL_BELL', abilities: ability('ABILITY_SKILL_LINK') }, {}], scriptedRng([50]))
    executeTurn(bell, [useMove(1, move('MOVE_ARM_THRUST')), null], testDeps(recordingDamage(10), groundingWith({ 0: 'HOLD_EFFECT_SHELL_BELL' })))
    expect(bell.battlers[0]!.mon.hp).toBe(82)
  })
})

describe('Triple Kick / Population Bomb accuracy (Cmd_accuracycheck :1412-1416) and power scaling (battle_util.c:6850-6852)', () => {
  // Triple Axel: Ice 20 power, accuracy 90, vs a Normal target (neutral), Normal attacker (no STAB). Level 50, Atk 100 vs Def 90.
  // dmg = floor(floor(22 * P * 100 / 90) / 50) + 2 at the maximum roll: P=20 -> 488 -> 9 -> 11; P=40 -> 977 -> 19 -> 21; P=60 -> 1466 -> 29 -> 31.
  it('three hits at 20 / 40 / 60 power, each with its own accuracy draw: 11 + 21 + 31 = 63', () => {
    // acc(10), crit(1), roll(0) | critRoll(1), acc(10), roll(0) | critRoll(1), acc(10), roll(0) | critRoll(1)
    const rng = scriptedRng([10, 1, 0, 1, 10, 0, 1, 10, 0, 1])
    const state = battle([{ moves: slot('MOVE_TRIPLE_AXEL'), pp: pps }, {}], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_TRIPLE_AXEL')), null], testDeps(bridgeDamage(rng)))
    expect(out.actions[0].targetDamage).toBe(63)
    expect(state.battlers[1]!.mon.hp).toBe(37)
    expect(rng.calls).toBe(10)
    expect(out.actions[0].unmodelled).not.toContain('secondary effect of EFFECT_TRIPLE_KICK not modelled')
  })

  it('a miss on the second hit ends the sequence with only the first hit landed', () => {
    const rng = scriptedRng([10, 1, 0, 1, 95])
    const state = battle([{ moves: slot('MOVE_TRIPLE_AXEL'), pp: pps }, {}], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_TRIPLE_AXEL')), null], testDeps(bridgeDamage(rng)))
    expect(out.actions[0].targetDamage).toBe(11)
    expect(out.actions[0].missed).toBe(false)
    expect(rng.calls).toBe(5)
  })

  it('Skill Link skips the later accuracy checks (and Triple Kick stays 3 hits): one accuracy draw in total', () => {
    // acc(10), crit(1), roll(0) | critRoll(1), roll(0) | critRoll(1), roll(0) | critRoll(1)
    const rng = scriptedRng([10, 1, 0, 1, 0, 1, 0, 1])
    const state = battle([{ moves: slot('MOVE_TRIPLE_AXEL'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_TRIPLE_AXEL')), null], testDeps(bridgeDamage(rng)))
    expect(out.actions[0].targetDamage).toBe(63)
    expect(rng.calls).toBe(8)
  })

  it('Loaded Dice skips the later accuracy checks as well (:1416)', () => {
    const rng = scriptedRng([10, 1, 0, 1, 0, 1, 0, 1])
    const state = battle([{ moves: slot('MOVE_TRIPLE_AXEL'), pp: pps, itemId: 'ITEM_LOADED_DICE' }, {}], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_TRIPLE_AXEL')), null], testDeps(bridgeDamage(rng), groundingWith({ 0: 'HOLD_EFFECT_LOADED_DICE' })))
    expect(out.actions[0].targetDamage).toBe(63)
    expect(rng.calls).toBe(8)
  })

  it('Population Bomb without Skill Link checks accuracy on all ten hits; a miss on hit 4 leaves three', () => {
    const dmg = recordingDamage(7)
    // acc1, crit | critRoll acc2 | critRoll acc3 | critRoll acc4(miss)
    const rng = scriptedRng([10, 1, 10, 1, 10, 1, 95])
    const state = battle([{ moves: slot('MOVE_POPULATION_BOMB'), pp: pps }, {}], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_POPULATION_BOMB')), null], testDeps(dmg))
    expect(out.actions[0].targetDamage).toBe(21)
    expect(dmg.contexts).toHaveLength(3)
  })

  it('an ordinary multi-hit move (Arm Thrust) never rechecks accuracy', () => {
    const rng = scriptedRng([50, 1, 1, 1, 1, 1])
    const state = battle([{ moves: slot('MOVE_ARM_THRUST'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], rng)
    executeTurn(state, [useMove(1, move('MOVE_ARM_THRUST')), null], testDeps(recordingDamage(10)))
    expect(rng.calls).toBe(6) // 1 accuracy + 5 crit rolls
  })
})

describe('Beat Up (CalcBeatUpPower battle_util.c:101-116, BattleScript_EffectBeatUp data/battle_scripts_1.s:5775-5779)', () => {
  // Power of hit k = base Attack of party slot k / 10 + 5 (Mudkip 75 -> 12, Bulbasaur 49 -> 9). With Atk 100 vs Def 90 at level 50
  // and the maximum roll: P=12 -> 293 -> 5 -> 7; P=9 -> 220 -> 4 -> 6.
  it('each hit is powered by its own party slot: 7 + 6 = 13 for a Mudkip / Bulbasaur party', () => {
    const party = [partyMon({ speciesId: 'SPECIES_MUDKIP' }), partyMon({ speciesId: 'SPECIES_BULBASAUR' })]
    // acc(50), crit(1), roll(0) | critRoll(1), roll(0) | critRoll(1)
    const rng = scriptedRng([50, 1, 0, 1, 0, 1])
    const state = battle([{ moves: slot('MOVE_BEAT_UP'), pp: pps }, {}], rng, party)
    const out = executeTurn(state, [useMove(1, move('MOVE_BEAT_UP')), null], testDeps(bridgeDamage(rng)))
    expect(out.actions[0].targetDamage).toBe(13)
    expect(out.actions[0].unmodelled).not.toContain('secondary effect of EFFECT_BEAT_UP not modelled')
    expect(out.actions[0].unmodelled).not.toContain('beatUpBaseAttack and beatUpHitCount are not tracked by the simulator')
  })

  it('the power slot ignores eligibility: [live, fainted, live] makes 2 hits powered by slots 0 and 1 (the fainted Bulbasaur)', () => {
    const party = [partyMon({ speciesId: 'SPECIES_MUDKIP' }), partyMon({ speciesId: 'SPECIES_BULBASAUR', hp: 0 }), partyMon({ speciesId: 'SPECIES_MACHOP' })]
    const rng = scriptedRng([50, 1, 0, 1, 0, 1])
    const state = battle([{ moves: slot('MOVE_BEAT_UP'), pp: pps }, {}], rng, party)
    const out = executeTurn(state, [useMove(1, move('MOVE_BEAT_UP')), null], testDeps(bridgeDamage(rng)))
    expect(out.actions[0].targetDamage).toBe(7 + 6) // Machop (P=13 -> 8) is slot 2 and never used
  })
})

describe('MOVE_EFFECT_DOUBLESLAP (battle_script_commands.c:3016-3019) and Scale Shot / Wyrm Wind (MOVEEND_MOVE_EFFECTS2 :4644-4651)', () => {
  it('Double Slap confuses only from the third hit (multiHitsUsed >= 2); each hit draws the 10% chance', () => {
    // Skill Link: 5 hits. acc(50); hit1: chance(0) critRoll(1); hit2: chance(0) critRoll(1); hit3: chance(0) -> confusion
    const rng = scriptedRng([50, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
    const state = battle([{ moves: slot('MOVE_DOUBLE_SLAP'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], rng)
    executeTurn(state, [useMove(1, move('MOVE_DOUBLE_SLAP')), null], testDeps(recordingDamage(5)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
  })

  it('a two-hit Double Slap (counter 2) cannot confuse even when every chance draw succeeds', () => {
    // hit-count draws (0, 1) -> 2 hits; then acc(50); chance draws all 0
    const rng = scriptedRng([0, 1, 50, 0, 1, 0, 1])
    const state = battle([{ moves: slot('MOVE_DOUBLE_SLAP'), pp: pps }, {}], rng)
    executeTurn(state, [useMove(1, move('MOVE_DOUBLE_SLAP')), null], testDeps(recordingDamage(5)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
  })

  it('Scale Shot: Defense -1 and Speed +1 on the USER, once, after the last hit', () => {
    const state = battle([{ moves: slot('MOVE_SCALE_SHOT'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_SCALE_SHOT')), null], testDeps(recordingDamage(5)))
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('Wyrm Wind: Sp. Def -1 and Speed +1 on the user, and an ordinary multi-hit move changes nothing', () => {
    const state = battle([{ moves: slot('MOVE_WYRM_WIND'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_WYRM_WIND')), null], testDeps(recordingDamage(5)))
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)

    const plain = battle([{ moves: slot('MOVE_ARM_THRUST'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], countingRng())
    executeTurn(plain, [useMove(1, move('MOVE_ARM_THRUST')), null], testDeps(recordingDamage(5)))
    expect(plain.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Toxic Needles is an argument-hit multi-hit move: a 10% poison chance is drawn per hit', () => {
    // Skill Link: acc(50); hit1 chance(5 < 10) -> poison
    const state = battle([{ moves: slot('MOVE_TOXIC_NEEDLES'), pp: pps, abilities: ability('ABILITY_SKILL_LINK') }, {}], scriptedRng([50, 5]))
    const out = executeTurn(state, [useMove(1, move('MOVE_TOXIC_NEEDLES')), null], testDeps(recordingDamage(5)))
    expect(out.actions[0].statusApplied?.status).toBe('POISON')
  })
})

// -----------------------------------------------------------------------------
// Group 2: damage-rule effects. The C damage formula (battle_util.c:7707-7711) at level 50, maximum roll, no crit:
//   floor(floor(22 * power * A / D) / 50) + 2     (then STAB 1.5, type effectiveness, ... where a case has them)
// A neutral Water-typed attacker (no STAB on Normal / Dark / Fighting / Ground / Rock / Poison / Psychic... moves aimed at a Normal
// or Water target) keeps every expected number a plain integer.
// -----------------------------------------------------------------------------

const baseDamage = (power: number, a = 100, d = 90) => Math.floor(Math.floor((22 * power * a) / d) / 50) + 2
const MAX_ROLL = [50, 1, 0] // accuracy hit, crit check fails (1 % 24 != 0), maximum damage roll
const WATER: [string, string, string] = ['WATER', 'MYSTERY', 'MYSTERY']

function fire(moveId: string, attacker: BattlerSpec, defender: BattlerSpec = {}, values: number[] = MAX_ROLL, prep?: (s: BattleState) => void) {
  const rng = scriptedRng(values)
  const state = battle([{ types: WATER, ...attacker, moves: slot(moveId), pp: attacker.pp ?? pps }, defender], rng)
  prep?.(state)
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(bridgeDamage(rng)))
  // A negative-priority user (Focus Punch, Smashin' Realities) acts after the idle target, whose null action is also recorded.
  return { state, out, rng, action: out.actions.find((a) => a.battlerId === 0) ?? out.actions[0] }
}

describe('plain-hit damage rules reached through the full turn (the audit flagged them via the generic secondary-effect gate)', () => {
  it('Facade doubles its power for a statused user and ignores the burn Attack drop (battle_util.c:7021-7025, :7135)', () => {
    expect(fire('MOVE_FACADE', {}).action.targetDamage).toBe(baseDamage(70))
    expect(baseDamage(70)).toBe(36)
    const burned = fire('MOVE_FACADE', { status1: STATUS1_BURN })
    expect(burned.action.targetDamage).toBe(baseDamage(140)) // 70, and not halved by the burn
    expect(burned.action.targetDamage).toBe(70)
    expect(burned.action.unmodelled).not.toContain('secondary effect of EFFECT_FACADE not modelled')
  })

  it('Hidden Power takes the attacker\'s hpType: Fire against a Grass target is 2x (battle_main.c:5130-5131)', () => {
    const neutral = fire('MOVE_HIDDEN_POWER', { hiddenPowerType: 'FIRE' }, { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    expect(neutral.action.targetDamage).toBe(baseDamage(80, 80, 85)) // special: Sp. Atk 80 vs Sp. Def 85 = 35
    const grass = fire('MOVE_HIDDEN_POWER', { hiddenPowerType: 'FIRE' }, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] })
    expect(grass.action.targetDamage).toBe(baseDamage(80, 80, 85) * 2)
    expect(grass.action.unmodelled).not.toContain('secondary effect of EFFECT_HIDDEN_POWER not modelled')
  })

  it('Body Press attacks with the user\'s Defense, Foul Play with the TARGET\'s Attack (battle_util.c:7254-7256)', () => {
    // Attack 100, Defense 90 on the user; the Fighting move meets a Water target (neutral).
    expect(fire('MOVE_BODY_PRESS', {}, { types: ['WATER', 'MYSTERY', 'MYSTERY'] }).action.targetDamage).toBe(baseDamage(80, 90, 90))
    expect(baseDamage(80, 90, 90)).toBe(37)
    // Target Attack 150, user Attack 100: Foul Play (Dark vs Normal is neutral) reads 150.
    const foul = fire('MOVE_FOUL_PLAY', { atk: 100 }, { atk: 150, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    expect(foul.action.targetDamage).toBe(baseDamage(95, 150, 90))
    expect(baseDamage(95, 150, 90)).toBe(71)
    expect(foul.action.unmodelled).not.toContain('secondary effect of EFFECT_FOUL_PLAY not modelled')
  })

  it('Weather Ball: Normal 50 power in clear weather, Rock 100 power in a sandstorm (CalcMoveBasePower :6829-6834, GetMoveTypeInternal :5113-5122)', () => {
    const clear = fire('MOVE_WEATHER_BALL', {})
    expect(clear.action.targetDamage).toBe(baseDamage(50, 80, 85))
    const sand = fire('MOVE_WEATHER_BALL', {}, {}, MAX_ROLL, (s) => {
      s.field.weather = WEATHER_SANDSTORM_TEMPORARY
    })
    expect(sand.action.targetDamage).toBe(baseDamage(100, 80, 85)) // 43
    expect(sand.action.unmodelled).not.toContain('secondary effect of EFFECT_WEATHER_BALL not modelled')
  })

  it('Flail: flat power, but a guaranteed critical hit at half HP or less (battle_script_commands.c:1540-1544)', () => {
    // Attack 100 vs Defense 80: 22*85*100/80 = 2337 -> 46 -> 48; a critical hit is x1.5 = 72.
    const healthy = fire('MOVE_FLAIL', { hp: 51 }, { def: 80 }, [50, 1, 0]) // accuracy, crit check, roll
    expect(healthy.action.targetDamage).toBe(baseDamage(85, 100, 80))
    expect(healthy.rng.calls).toBe(3)
    const low = fire('MOVE_FLAIL', { hp: 50 }, { def: 80 }, [50, 0]) // accuracy, roll -- no crit draw, the crit is certain
    expect(low.action.targetDamage).toBe(Math.trunc(baseDamage(85, 100, 80) * 1.5))
    expect(low.action.targetDamage).toBe(72)
    expect(low.rng.calls).toBe(2)
    expect(low.action.unmodelled).not.toContain('secondary effect of EFFECT_FLAIL not modelled')
  })

  it('Stomping Tantrum doubles after a failed move (lastMoveFailed, battle_util.c:7040-7042)', () => {
    expect(fire('MOVE_STOMPING_TANTRUM', {}).action.targetDamage).toBe(baseDamage(75))
    const after = fire('MOVE_STOMPING_TANTRUM', {}, {}, MAX_ROLL, (s) => {
      s.lastMoveFailed = 1 // battler 0
    })
    expect(after.action.targetDamage).toBe(baseDamage(150))
    expect(after.action.unmodelled).not.toContain('secondary effect of EFFECT_STOMPING_TANTRUM not modelled')
  })

  it('Venoshock / Volt Bolt double against the status their argument names (battle_util.c:7015-7019)', () => {
    // Venoshock: special, Sp. Atk 80 vs Sp. Def 85. Poison (and Toxic) both count as STATUS1_POISON_ANY.
    expect(fire('MOVE_VENOSHOCK', {}).action.targetDamage).toBe(baseDamage(65, 80, 85))
    expect(fire('MOVE_VENOSHOCK', {}, { status1: STATUS1_POISON }).action.targetDamage).toBe(baseDamage(130, 80, 85))
    expect(fire('MOVE_VENOSHOCK', {}, { status1: STATUS1_TOXIC_POISON }).action.targetDamage).toBe(baseDamage(130, 80, 85))
    // Volt Bolt: paralysis only; a poisoned target does not double it.
    expect(fire('MOVE_VOLT_BOLT', {}, { status1: STATUS1_PARALYSIS }).action.targetDamage).toBe(baseDamage(140))
    expect(fire('MOVE_VOLT_BOLT', {}, { status1: STATUS1_POISON }).action.targetDamage).toBe(baseDamage(70))
    expect(fire('MOVE_VOLT_BOLT', {}, { status1: STATUS1_PARALYSIS }).action.unmodelled).not.toContain('secondary effect of EFFECT_DOUBLE_DMG_IF_STATUS1 not modelled')
  })

  it('Synchronoise takes the user\'s second type (else first): Fire STAB x1.5 and 2x against Grass (battle_main.c:5150-5167)', () => {
    // Special, Sp. Atk 100 vs Sp. Def 90: 22*95*100/90 = 2322 -> 46 -> 48; x1.5 STAB x2 = 144. Declared Psychic would be 48 (no STAB, neutral).
    const sync = fire('MOVE_SYNCHRONOISE', { types: ['WATER', 'FIRE', 'MYSTERY'], spatk: 100 }, { types: ['GRASS', 'MYSTERY', 'MYSTERY'], spdef: 90 })
    expect(sync.action.targetDamage).toBe(144)
    // A mono-type user falls back to its first type.
    const mono = fire('MOVE_SYNCHRONOISE', { types: ['FIRE', 'MYSTERY', 'MYSTERY'], spatk: 100 }, { types: ['GRASS', 'MYSTERY', 'MYSTERY'], spdef: 90 })
    expect(mono.action.targetDamage).toBe(144)
    expect(sync.action.unmodelled).not.toContain('secondary effect of EFFECT_SYNCHRONOISE not modelled')
  })

  it('Ivy Cudgel takes the Ogerpon mask\'s type (battle_main.c:5151-5159): a Wellspring Mask hits as Water', () => {
    // Physical 100 power, Atk 100 vs Def 90: 22*100*100/90 = 2444 -> 48 -> 50; Water STAB x1.5 = 75, 2x against Fire = 150.
    const ivy = fire('MOVE_IVY_CUDGEL', { speciesId: 'SPECIES_OGERPON_WELLSPRING_MASK', types: ['GRASS', 'WATER', 'MYSTERY'] }, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    expect(ivy.action.targetDamage).toBe(150)
  })

  it('Spit Up uses the user\'s first type (battle_main.c:5141-5148)', () => {
    // Fire user, Spit Up (special 120): Fire STAB x1.5 against a Grass target x2. Sp. Atk 80 vs Sp. Def 85: 22*120*80/85 = 2484 -> 49 -> 51 -> 76.5? use Sp. Atk 100/Sp. Def 90.
    const spit = fire('MOVE_SPIT_UP', { types: ['FIRE', 'WATER', 'MYSTERY'], spatk: 100 }, { types: ['GRASS', 'MYSTERY', 'MYSTERY'], spdef: 90 })
    // 22*120*100/90 = 2933 -> 58 -> 60; STAB x1.5 = 90; x2 = 180
    expect(spit.action.targetDamage).toBe(180)
  })
})

describe('scripts that check something between ppreduce and the hit (hitScripts.ts)', () => {
  const noPp = (state: BattleState) => state.battlers[0]!.mon.pp[0]

  it('Poltergeist needs a target item, a target that is not semi-invulnerable and no Klutz (VARIOUS_CHECK_POLTERGEIST :8117-8125)', () => {
    // Ghost against a Water target is neutral; Atk 100 vs Def 90, 110 power: 22*110*100/90 = 2688 -> 53 -> 55.
    const ok = fire('MOVE_POLTERGEIST', {}, { itemId: 'ITEM_LEFTOVERS', types: WATER })
    expect(ok.action.targetDamage).toBe(baseDamage(110))
    expect(ok.action.unmodelled).not.toContain('secondary effect of EFFECT_POLTERGEIST not modelled')
    const none = fire('MOVE_POLTERGEIST', {}, {}, [])
    expect(none.action.targetDamage).toBeNull()
    expect(none.action.missed).toBe(true) // BattleScript_ButItFailed
    expect(noPp(none.state)).toBe(19) // `ppreduce` ran first
    expect(none.rng.calls).toBe(0) // and it failed before the accuracy draw
    const klutz = fire('MOVE_POLTERGEIST', {}, { itemId: 'ITEM_LEFTOVERS', abilities: ability('ABILITY_KLUTZ') }, [])
    expect(klutz.action.targetDamage).toBeNull()
  })

  it('Last Resort works once; CanUseLastResort refuses it as soon as a Last Resort slot is in usedMoves (:6481-6491, as written)', () => {
    const rng = scriptedRng([50, 1, 0, 50, 1, 0])
    const state = battle([{ types: WATER, moves: slot('MOVE_LAST_RESORT', 'MOVE_TACKLE'), pp: pps }, {}], rng)
    const deps = testDeps(bridgeDamage(rng))
    const first = executeTurn(state, [useMove(1, move('MOVE_LAST_RESORT')), null], deps)
    expect(first.actions[0].targetDamage).toBe(baseDamage(140)) // 70, even though MOVE_TACKLE was never used: the C does not look at it
    expect(state.battlers[0]!.volatiles.usedMoves & 1).toBe(1)
    const second = executeTurn(state, [useMove(1, move('MOVE_LAST_RESORT')), null], deps)
    expect(second.actions[0].targetDamage).toBeNull()
    expect(second.actions[0].missed).toBe(true)
    expect(state.battlers[0]!.mon.pp[0]).toBe(18)
  })

  it('Snore fails awake (after ppreduce) and hits while asleep, with its own 30% flinch (BattleScript_EffectSnore :4709-4726)', () => {
    const awake = fire('MOVE_SNORE', {}, {}, [])
    expect(awake.action.targetDamage).toBeNull()
    expect(awake.action.missed).toBe(true)
    expect(noPp(awake.state)).toBe(19)
    // Asleep for 3 more turns (the counter is decremented to 2 by the canceller; Snore is allowed through). Special: Sp. Atk 80 vs Sp. Def 85.
    const asleep = fire('MOVE_SNORE', { status1: 3 }, {})
    expect(asleep.action.targetDamage).toBe(baseDamage(85, 80, 85))
    expect(asleep.action.unmodelled).not.toContain('secondary effect of EFFECT_SNORE not modelled')
    // The flinch chance: draw 10 < 30 flinches, 40 does not.
    const flinchState = (roll: number) => {
      const s = battle([{ moves: slot('MOVE_SNORE'), pp: pps }, {}], scriptedRng([roll]))
      applySecondaryMoveEffects({ state: s, attackerId: 0, targetId: 1, moveId: 'MOVE_SNORE', targetDamage: 10, deps: testDeps(recordingDamage(1)), unmodelled: [] })
      return hasFlag(s.battlers[1]!.mon.status2, STATUS2_FLINCHED)
    }
    expect(flinchState(10)).toBe(true)
    expect(flinchState(40)).toBe(false)
  })

  it('Natural Gift: needs a usable berry, takes its power / type / effect, then spends it (:3046-3071, VARIOUS_JUMP_IF_NOT_BERRY :6869-6875)', () => {
    // Cheri Berry: 80 power Electric, effect paralysis. Physical Atk 100 vs Def 90 into a Normal target: 22*80*100/90 = 1955 -> 39 -> 41.
    const berry = fire('MOVE_NATURAL_GIFT', { itemId: 'ITEM_CHERI_BERRY' }, { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
    expect(berry.action.targetDamage).toBe(baseDamage(80))
    expect(berry.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(STATUS1_PARALYSIS)
    expect(berry.state.battlers[0]!.mon.itemId).toBeNull()
    expect(berry.rng.calls).toBe(3) // accuracy, crit, roll: seteffectsecondary draws nothing
    expect(berry.action.unmodelled).not.toContain('secondary effect of EFFECT_NATURAL_GIFT not modelled')
    // No berry: ButItFailed after ppreduce. A non-berry item does not count either.
    expect(fire('MOVE_NATURAL_GIFT', {}, {}, []).action.missed).toBe(true)
    expect(fire('MOVE_NATURAL_GIFT', { itemId: 'ITEM_LEFTOVERS' }, {}, []).action.missed).toBe(true)
    // A berry blocked by Klutz is not usable either.
    expect(fire('MOVE_NATURAL_GIFT', { itemId: 'ITEM_CHERI_BERRY', abilities: ability('ABILITY_KLUTZ') }, {}, []).action.missed).toBe(true)
  })

  it('Fling: the item leaves first, Iron Ball hits for 130 and a Light Ball paralyses (VARIOUS_TRY_FLING :8402-8433, CalcMoveBasePower :6804-6812)', () => {
    // Dark vs Normal is neutral, physical Atk 100 vs Def 90. Iron Ball: 22*130*100/90 = 3177 -> 63 -> 65.
    const ball = fire('MOVE_FLING', { itemId: 'ITEM_IRON_BALL' }, { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, [50, 1, 0, 0])
    expect(ball.action.targetDamage).toBe(baseDamage(130))
    expect(baseDamage(130)).toBe(65)
    expect(ball.state.battlers[0]!.mon.itemId).toBeNull()
    // Light Ball keeps the declared 90 power -- 22*90*100/90 = 2200 -> 44 -> 46 -- and its item effect (the 100% chance still draws once).
    const light = fire('MOVE_FLING', { itemId: 'ITEM_LIGHT_BALL' }, { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, [50, 1, 0, 0])
    expect(light.action.targetDamage).toBe(baseDamage(90))
    expect(light.state.battlers[1]!.mon.status1 & STATUS1_PARALYSIS).toBe(STATUS1_PARALYSIS)
    expect(light.rng.calls).toBe(4)
    // A Gem sets the type: Fire Gem against Grass is 2x (the gem is gone, so no gem boost).
    const gem = fire('MOVE_FLING', { itemId: 'ITEM_FIRE_GEM' }, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] }, [50, 1, 0, 0])
    expect(gem.action.targetDamage).toBe(baseDamage(90) * 2)
    // Nothing to fling: fails after ppreduce.
    const none = fire('MOVE_FLING', {}, {}, [])
    expect(none.action.missed).toBe(true)
    expect(noPp(none.state)).toBe(19)
    expect(none.action.unmodelled).not.toContain('secondary effect of EFFECT_FLING not modelled')
  })

  it('Belch eats the berry first and spends PP twice; a berry that is still held afterwards makes it fail (:3073-3088)', () => {
    // Oran Berry restores 10 HP: the user is at 50/100 so the berry is eaten. Special Sp. Atk 80 vs Sp. Def 85: 22*120*80/85 = 2484 -> 49 -> 51.
    const eat = fire('MOVE_BELCH', { itemId: 'ITEM_ORAN_BERRY', hp: 50 }, {}, MAX_ROLL)
    expect(eat.action.targetDamage).toBe(baseDamage(120, 80, 85))
    expect(eat.state.battlers[0]!.mon.itemId).toBeNull()
    expect(eat.state.battlers[0]!.mon.hp).toBe(60)
    expect(noPp(eat.state)).toBe(18) // ppreduce, consumeberry, then HitFromAccCheck's own ppreduce
    // At full HP the Oran Berry is not eaten, is still held, and Belch fails with a single PP spent.
    const full = fire('MOVE_BELCH', { itemId: 'ITEM_ORAN_BERRY' }, {}, [])
    expect(full.action.missed).toBe(true)
    expect(noPp(full.state)).toBe(19)
    expect(full.state.battlers[0]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    // No berry at all: BattleScript_EffectBerrySmashNoBerry is a plain hit.
    const bare = fire('MOVE_BELCH', {})
    expect(bare.action.targetDamage).toBe(baseDamage(120, 80, 85))
    expect(noPp(bare.state)).toBe(19)
    // Berry Smash (same script) does not fail on a leftover berry: it just hits, having spent two PP.
    const smash = fire('MOVE_BERRY_SMASH', { itemId: 'ITEM_ORAN_BERRY' })
    expect(smash.action.targetDamage).toBe(baseDamage(70))
    expect(noPp(smash.state)).toBe(18)
    expect(smash.action.unmodelled).not.toContain('secondary effect of EFFECT_BERRY_SMASH not modelled')
  })

  it('Nightmare fails (and spends no PP) unless the target sleeps, then hits and gives the nightmare (:4909-4916, SetMoveEffect :2827-2831)', () => {
    const awake = fire('MOVE_NIGHTMARE', {}, {}, [])
    expect(awake.action.missed).toBe(true)
    expect(noPp(awake.state)).toBe(20)
    // Asleep target (status1 3 = three turns of sleep): Ghost vs Water is neutral; special Sp. Atk 80 vs Sp. Def 85, 120 power. The 100% chance still draws.
    const asleep = fire('MOVE_NIGHTMARE', {}, { status1: 3, types: ['WATER', 'MYSTERY', 'MYSTERY'] }, [50, 1, 0, 0])
    expect(asleep.action.targetDamage).toBe(baseDamage(120, 80, 85))
    expect(hasFlag(asleep.state.battlers[1]!.mon.status2, STATUS2_NIGHTMARE)).toBe(true)
    expect(asleep.action.unmodelled).not.toContain('secondary effect of EFFECT_NIGHTMARE not modelled')
    // The `&&` typo: any other status2 bit (here Confusion's counter) blocks it.
    const confused = fire('MOVE_NIGHTMARE', {}, { status1: 3, status2: setCounter(0, STATUS2_CONFUSION, 2), types: ['WATER', 'MYSTERY', 'MYSTERY'] }, [50, 1, 0, 0])
    expect(hasFlag(confused.state.battlers[1]!.mon.status2, STATUS2_NIGHTMARE)).toBe(false)
  })
})

describe('Rollout / Magnitude / Struggle / Fell Stinger / Spit Up and Swallow', () => {
  it('Rollout builds 40 -> 80 -> 160 over three uses (Cmd_handlerollout :11151-11167, CalcMoveBasePower :6813-6821)', () => {
    // Rock vs a Normal target is neutral, physical Atk 100 vs Def 90: 40 -> 21, 80 -> 41, 160 -> 80.
    const rng = scriptedRng([50, 1, 0, 50, 1, 0, 50, 1, 0, 50, 1, 0])
    const state = battle([{ types: WATER, moves: slot('MOVE_ROLLOUT'), pp: pps }, { hp: 1000, maxHp: 1000 }], rng)
    const deps = testDeps(bridgeDamage(rng))
    const dealt: number[] = []
    for (let i = 0; i < 4; i++) {
      const out = executeTurn(state, [useMove(1, move('MOVE_ROLLOUT')), null], deps)
      dealt.push(out.actions[0].targetDamage!)
    }
    expect(dealt).toEqual([baseDamage(40), baseDamage(80), baseDamage(160), baseDamage(160)])
    expect(dealt.slice(0, 3)).toEqual([21, 41, 80])
    expect(state.battlers[0]!.volatiles.rolloutCounter).toBe(3) // the ceiling
  })

  it('Defense Curl makes the first Rollout use count as two (the counter starts at 2)', () => {
    const curled = fire('MOVE_ROLLOUT', { status2: STATUS2_DEFENSE_CURL })
    expect(curled.action.targetDamage).toBe(baseDamage(80))
    expect(curled.state.battlers[0]!.volatiles.rolloutCounter).toBe(2)
    expect(curled.action.unmodelled.some((u) => u.includes('attackerRolloutCounter'))).toBe(false)
    expect(curled.action.unmodelled).not.toContain('secondary effect of EFFECT_ROLLOUT not modelled')
  })

  it('using another move clears the Rollout counter (MOVEEND_CLEAR_BITS :4943)', () => {
    const rng = scriptedRng([50, 1, 0, 50, 1, 0])
    const state = battle([{ types: WATER, moves: slot('MOVE_ROLLOUT', 'MOVE_TACKLE'), pp: pps }, { hp: 1000, maxHp: 1000 }], rng)
    const deps = testDeps(bridgeDamage(rng))
    executeTurn(state, [useMove(1, move('MOVE_ROLLOUT')), null], deps)
    expect(state.battlers[0]!.volatiles.rolloutCounter).toBe(1)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], deps)
    expect(state.battlers[0]!.volatiles.rolloutCounter).toBe(0)
  })

  it('Magnitude draws its tier (Random() % 100, :11259-11282) and the tier sets the power: 4 -> 10, 9 -> 110', () => {
    // Ground vs Normal is neutral; accuracy, then the tier draw, then crit and roll. 10 power: 22*10*100/90 = 244 -> 4 -> 6.
    const weak = fire('MOVE_MAGNITUDE', {}, {}, [50, 4, 1, 0])
    expect(weak.action.targetDamage).toBe(baseDamage(10))
    expect(baseDamage(10)).toBe(6)
    const strong = fire('MOVE_MAGNITUDE', {}, {}, [50, 94, 1, 0])
    expect(strong.action.targetDamage).toBe(baseDamage(110))
    expect(strong.rng.calls).toBe(4)
    expect(strong.action.unmodelled).not.toContain('secondary effect of EFFECT_MAGNITUDE not modelled')
  })

  it('Struggle takes a quarter of the user\'s max HP, Magic Guard or not (MOVE_EFFECT_RECOIL_HP_25 :2848-2853)', () => {
    const plain = battle([{ moves: slot('MOVE_STRUGGLE'), pp: pps }, {}], scriptedRng([50]))
    const out = executeTurn(plain, [useMove(1, move('MOVE_STRUGGLE')), null], testDeps(recordingDamage(20)))
    expect(plain.battlers[0]!.mon.hp).toBe(75)
    expect(out.actions[0].attackerDamage).toBe(25)
    expect(out.actions[0].unmodelled).not.toContain('secondary effect of EFFECT_RECOIL_HP_25 not modelled')
    const guarded = battle([{ moves: slot('MOVE_STRUGGLE'), pp: pps, abilities: ability('ABILITY_MAGIC_GUARD'), maxHp: 90, hp: 90 }, {}], scriptedRng([50]))
    executeTurn(guarded, [useMove(1, move('MOVE_STRUGGLE')), null], testDeps(recordingDamage(20)))
    expect(guarded.battlers[0]!.mon.hp).toBe(90 - 22) // floor(90 / 4)
    // It can KO the user.
    const frail = battle([{ moves: slot('MOVE_STRUGGLE'), pp: pps, hp: 10, maxHp: 100 }, {}], scriptedRng([50]))
    const koOut = executeTurn(frail, [useMove(1, move('MOVE_STRUGGLE')), null], testDeps(recordingDamage(20)))
    expect(frail.battlers[0]!.mon.hp).toBe(0)
    expect(koOut.actions[0].fainted).toContain(0)
  })

  it('Fell Stinger raises Attack by 3 when it KOs, and only then (VARIOUS_TRY_ACTIVATE_FELL_STINGER :7176-7189)', () => {
    const parties = (): [SimPartyMon[], SimPartyMon[]] => [[partyMon(), partyMon()], [partyMon(), partyMon()]]
    const run = (damage: number, atkStage?: number) => {
      const [mine, theirs] = parties()
      const state = battle([{ moves: slot('MOVE_FELL_STINGER'), pp: pps }, { hp: 40 }], scriptedRng([50]), mine, theirs)
      if (atkStage !== undefined) state.battlers[0]!.mon.statStages[STAT_ATK] = atkStage
      const out = executeTurn(state, [useMove(1, move('MOVE_FELL_STINGER')), null], testDeps(recordingDamage(damage)))
      return { state, out }
    }
    expect(run(100).state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 3)
    expect(run(10).state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE) // no KO
    expect(run(100, 12).state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(12) // already maxed
    expect(run(100).out.actions[0].unmodelled).not.toContain('secondary effect of EFFECT_FELL_STINGER not modelled')
  })

  it('Spit Up spends a Stockpile charge instead of PP and takes one stage back off Defense / Sp. Def (TryUseStockpile :9521-9535, ppreduce :1476-1483)', () => {
    const charged = battle([{ moves: slot('MOVE_SPIT_UP'), pp: pps }, {}], scriptedRng([50]))
    const v = charged.battlers[0]!.volatiles
    v.stockpileCounter = 2
    v.stockpileDef = 2
    v.stockpileSpDef = 2
    charged.battlers[0]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 2
    charged.battlers[0]!.mon.statStages[STAT_SPDEF] = DEFAULT_STAT_STAGE + 2
    executeTurn(charged, [useMove(1, move('MOVE_SPIT_UP')), null], testDeps(recordingDamage(10)))
    expect(charged.battlers[0]!.mon.pp[0]).toBe(20)
    expect(v.stockpileCounter).toBe(1)
    expect(v.stockpileDef).toBe(1)
    expect(charged.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(charged.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
    // With no charge the PP goes down as for any move.
    const empty = battle([{ moves: slot('MOVE_SPIT_UP'), pp: pps }, {}], scriptedRng([50]))
    executeTurn(empty, [useMove(1, move('MOVE_SPIT_UP')), null], testDeps(recordingDamage(10)))
    expect(empty.battlers[0]!.mon.pp[0]).toBe(19)
  })

  it('Swallow does the same (and heals half: it is BattleScript_EffectRestoreHp in this build)', () => {
    const state = battle([{ moves: slot('MOVE_SWALLOW'), pp: pps, hp: 40 }, {}], countingRng())
    state.battlers[0]!.volatiles.stockpileCounter = 1
    executeTurn(state, [useMove(0, move('MOVE_SWALLOW')), null], testDeps(recordingDamage(10)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(20)
    expect(state.battlers[0]!.volatiles.stockpileCounter).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(90) // 40 + 100 / 2
  })
})

// -----------------------------------------------------------------------------
// Group 3: hit-plus-field / side scripts (BattleScript_EffectHit_Return, data/battle_scripts_1.s:3465-3490, then the step each
// script adds -- hitScripts.ts runLegacyPostHit) and the remaining plain-hit damage rules.
// Special moves below: Sp. Atk 80 vs Sp. Def 85 into a Normal target, so power P deals floor(floor(22 * P * 80 / 85) / 50) + 2.
// The four "Storm" moves carry splitFlag USE_HIGHEST_OFFENSE (SetSwapDamageCategory, battle_util.c:7325-7335): the user's Attack (100)
// beats its Sp. Atk (80), so they hit as physical moves (Atk 100 vs Def 90) and P = 100 deals floor(floor(22*100*100/90)/50)+2 = 50.
// A field timer does not tick on the turn it starts (`!started.weather` / `!started.terrain` / `!started.reflect`, battle_util.c:1798,
// 1964, 2084), so a fresh weather / terrain / screen still shows its full duration after the turn.
// -----------------------------------------------------------------------------

describe('hit-plus-field scripts', () => {
  it('Wildbolt Storm / Sandsear Storm hit, then set rain / sandstorm (s:3431-3434; VARIOUS_SET_WEATHER :8634-8644)', () => {
    const rain = fire('MOVE_WILDBOLT_STORM', {})
    expect(rain.action.targetDamage).toBe(baseDamage(100))
    expect(baseDamage(100)).toBe(50)
    expect(rain.state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(rain.state.field.weatherDuration).toBe(8)
    expect(rain.action.unmodelled).not.toContain('secondary effect of EFFECT_RAIN_HIT not modelled')

    const sand = fire('MOVE_SANDSEAR_STORM', {})
    expect(sand.action.targetDamage).toBe(50)
    expect(sand.state.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)

    // Accuracy 90: a draw of 95 misses and the script never reaches setbattleweather.
    const missed = fire('MOVE_WILDBOLT_STORM', {}, {}, [95])
    expect(missed.action.missed).toBe(true)
    expect(missed.state.field.weather).toBe(0)

    // Weather that is already up (here permanent rain) is left alone: TryChangeBattleWeather fails.
    const already = fire('MOVE_WILDBOLT_STORM', {}, {}, MAX_ROLL, (s) => {
      s.field.weather = WEATHER_RAIN_PERMANENT
    })
    expect(already.state.field.weather).toBe(WEATHER_RAIN_PERMANENT)
    expect(already.action.targetDamage).toBe(50)
  })

  it('Smashing Pumpkins / Springtide Storm hit, then set Grassy / Misty Terrain (s:3444-3464)', () => {
    // Smashing Pumpkins: Grass physical 60 into a Normal target, no STAB for the Water-typed user: 22*60*100/90 = 1466 -> 29 -> 31.
    const grassy = fire('MOVE_SMASHING_PUMPKINS', {})
    expect(grassy.action.targetDamage).toBe(baseDamage(60))
    expect(baseDamage(60)).toBe(31)
    expect(grassy.state.field.statuses & STATUS_FIELD_TERRAIN_ANY).toBe(STATUS_FIELD_GRASSY_TERRAIN)
    expect(grassy.state.field.timers.terrainTimer).toBe(8) // TERRAIN_DURATION, battle_util.h:52
    expect(grassy.action.unmodelled).not.toContain('secondary effect of EFFECT_GRASSY_TERRAIN_HIT not modelled')

    const misty = fire('MOVE_SPRINGTIDE_STORM', {})
    expect(misty.action.targetDamage).toBe(50)
    expect(misty.state.field.statuses & STATUS_FIELD_TERRAIN_ANY).toBe(STATUS_FIELD_MISTY_TERRAIN)

    // It replaces a different terrain, as the terrain moves do (setFieldTerrain clears TERRAIN_ANY first).
    const replaced = fire('MOVE_SPRINGTIDE_STORM', {}, {}, MAX_ROLL, (s) => {
      s.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    })
    expect(replaced.state.field.statuses & STATUS_FIELD_TERRAIN_ANY).toBe(STATUS_FIELD_MISTY_TERRAIN)
  })

  it('Bleakwind Storm hits, then starts Tailwind for the user\'s side (s:3436-3442)', () => {
    const wind = fire('MOVE_BLEAKWIND_STORM', {})
    expect(wind.action.targetDamage).toBe(50) // Flying, P = 100, highest-offense (physical)
    expect(hasFlag(wind.state.sides[0].statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(hasFlag(wind.state.sides[1].statuses, SIDE_STATUS_TAILWIND)).toBe(false)
    expect(wind.action.unmodelled).not.toContain('secondary effect of EFFECT_TAILWIND_HIT not modelled')
    expect(hasFlag(fire('MOVE_BLEAKWIND_STORM', {}, {}, [95]).state.sides[0].statuses, SIDE_STATUS_TAILWIND)).toBe(false)
  })

  it('Smashin\' Realities has no accuracycheck, hits, then removes weather and terrain (s:685-715; VARIOUS_REMOVE_WEATHER :7938-7959, _TERRAIN :7908-7937)', () => {
    // Dark physical 90 into a Normal target: 22*90*100/90 = 2200 -> 44 -> 46. Draws: crit check and damage roll only.
    const sweep = fire('MOVE_SMASHIN_REALITIES', {}, {}, [1, 0], (s) => {
      s.field.weather = WEATHER_SANDSTORM_TEMPORARY
      s.field.weatherDuration = 5
      s.field.statuses |= STATUS_FIELD_GRASSY_TERRAIN
      s.field.timers.terrainTimer = 5
    })
    expect(sweep.action.targetDamage).toBe(baseDamage(90))
    expect(baseDamage(90)).toBe(46)
    expect(sweep.rng.calls).toBe(2)
    expect(sweep.action.missed).toBe(false)
    expect(sweep.state.field.weather).toBe(0)
    expect(sweep.state.field.weatherDuration).toBe(0)
    expect(sweep.state.field.statuses & STATUS_FIELD_TERRAIN_ANY).toBe(0)
    expect(sweep.state.field.timers.terrainTimer).toBe(0)
    expect(sweep.action.unmodelled).not.toContain('secondary effect of EFFECT_CLEAR_WEATHER_AND_TERRAIN_HIT not modelled')

    // Primal weather survives (VARIOUS_REMOVE_WEATHER returns early), the terrain does not.
    const primal = fire('MOVE_SMASHIN_REALITIES', {}, {}, [1, 0], (s) => {
      s.field.weather = WEATHER_RAIN_PRIMAL
      s.field.statuses |= STATUS_FIELD_GRASSY_TERRAIN
    })
    expect(primal.state.field.weather).toBe(WEATHER_RAIN_PRIMAL)
    expect(primal.state.field.statuses & STATUS_FIELD_TERRAIN_ANY).toBe(0)

    // A permanent terrain (STATUS_FIELD_TERRAIN_PERMANENT) is left alone as well.
    const permanent = fire('MOVE_SMASHIN_REALITIES', {}, {}, [1, 0], (s) => {
      s.field.statuses |= STATUS_FIELD_GRASSY_TERRAIN | STATUS_FIELD_TERRAIN_PERMANENT
    })
    expect(permanent.state.field.statuses & STATUS_FIELD_GRASSY_TERRAIN).toBe(STATUS_FIELD_GRASSY_TERRAIN)
  })

  it('Steel Roller / Ice Spinner (EFFECT_REMOVE_TERRAIN_NO_FAIL) have no accuracycheck either, roll argumenttomoveeffect, then remove the terrain (s:717-744)', () => {
    // Steel physical 80 into a Normal target: 22*80*100/90 = 1955 -> 39 -> 41, no argument effect, so only crit and roll are drawn.
    const roller = fire('MOVE_STEEL_ROLLER', {}, {}, [1, 0], (s) => {
      s.field.statuses |= STATUS_FIELD_GRASSY_TERRAIN
    })
    expect(roller.action.targetDamage).toBe(baseDamage(80))
    expect(baseDamage(80)).toBe(41)
    expect(roller.rng.calls).toBe(2)
    expect(roller.state.field.statuses & STATUS_FIELD_TERRAIN_ANY).toBe(0)
    expect(roller.action.unmodelled).not.toContain('secondary effect of EFFECT_REMOVE_TERRAIN_NO_FAIL not modelled')

    // Stomp names MOVE_EFFECT_FLINCH at 30 % as its argument: one more draw (the chance roll) happens before the terrain goes.
    const stomp = fire('MOVE_STOMP', {}, {}, [1, 0, 99], (s) => {
      s.field.statuses |= STATUS_FIELD_GRASSY_TERRAIN
    })
    expect(stomp.rng.calls).toBe(3)
    expect(stomp.state.field.statuses & STATUS_FIELD_TERRAIN_ANY).toBe(0)
  })
})

describe('Sparkly Swirl, the screens-on-hit moves and Smelling Salts', () => {
  it('Sparkly Swirl hits, then heals the whole party\'s status (Aromatherapy branch of Cmd_healpartystatus :11079-11092)', () => {
    // Fairy special 120 into a Normal target: 22*120*80/85 = 2484 -> 49 -> 51.
    const mine = [partyMon({ status1: STATUS1_BURN }), partyMon({ status1: STATUS1_POISON }), partyMon({ status1: STATUS1_PARALYSIS })]
    const rng = scriptedRng(MAX_ROLL)
    const state = battle([{ moves: slot('MOVE_SPARKLY_SWIRL'), pp: pps, status1: STATUS1_BURN, status2: STATUS2_NIGHTMARE }, {}], rng, mine)
    const out = executeTurn(state, [useMove(1, move('MOVE_SPARKLY_SWIRL')), null], testDeps(bridgeDamage(rng)))
    expect(baseDamage(120, 80, 85)).toBe(51)
    expect(out.actions[0].targetDamage).toBe(51)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_NIGHTMARE)).toBe(false)
    expect(state.sides[0].party.map((p) => p.status1)).toEqual([0, 0, 0])
    expect(out.actions[0].unmodelled).not.toContain('secondary effect of EFFECT_SPARKLY_SWIRL not modelled')
  })

  it('Baddy Bad sets Reflect and Glitzy Glow sets Light Screen after the hit; an existing screen makes the move a plain hit unless the user has Screen Cleaner (s:497-553; Cmd_setreflect :9319-9339)', () => {
    // Special 80 into a Normal target: 22*80*80/85 = 1656 -> 33 -> 35.
    const baddy = fire('MOVE_BADDY_BAD', {})
    expect(baddy.action.targetDamage).toBe(baseDamage(80, 80, 85))
    expect(baseDamage(80, 80, 85)).toBe(35)
    expect(hasFlag(baddy.state.sides[0].statuses, SIDE_STATUS_REFLECT)).toBe(true)
    expect(baddy.state.sides[0].timers.reflectTimer).toBe(5) // SCREEN_DURATION, battle_util.h:63
    expect(hasFlag(baddy.state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(baddy.action.unmodelled).not.toContain('secondary effect of EFFECT_BADDY_BAD not modelled')

    const glow = fire('MOVE_GLITZY_GLOW', {})
    expect(glow.action.targetDamage).toBe(35)
    expect(hasFlag(glow.state.sides[0].statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(true)
    expect(glow.state.sides[0].timers.lightscreenTimer).toBe(5)

    // Light Clay: SCREEN_DURATION_EXTENDED (8), battle_util.h:64.
    const clayRng = scriptedRng(MAX_ROLL)
    const clay = battle([{ moves: slot('MOVE_BADDY_BAD'), pp: pps, types: WATER, itemId: 'ITEM_LIGHT_CLAY' }, {}], clayRng)
    executeTurn(clay, [useMove(1, move('MOVE_BADDY_BAD')), null], testDeps(bridgeDamage(clayRng), groundingWith({ 0: 'HOLD_EFFECT_LIGHT_CLAY' })))
    expect(clay.sides[0].timers.reflectTimer).toBe(8)

    // Reflect already up: the timer is not reset (this end of turn takes it 2 -> 1). With Screen Cleaner it is reset to 5.
    const up = (abilities?: SimBattleMon['abilities']) =>
      fire('MOVE_BADDY_BAD', { abilities }, {}, MAX_ROLL, (s) => {
        s.sides[0].statuses |= SIDE_STATUS_REFLECT
        s.sides[0].timers.reflectTimer = 2
      })
    expect(up().state.sides[0].timers.reflectTimer).toBe(1)
    expect(up().action.targetDamage).toBe(35)
    expect(up(ability('ABILITY_SCREEN_CLEANER')).state.sides[0].timers.reflectTimer).toBe(5)
  })

  it('Smelling Salts cures the USER\'s status, as the script is written (s:3384-3393), and doubles on a paralysed target (battle_util.c:6848-6850)', () => {
    // Fighting physical 75 into a Water target: 22*75*100/90 = 1833 -> 36 -> 38; doubled power 150: 3666 -> 73 -> 75.
    const target = { types: WATER, status1: STATUS1_PARALYSIS }
    const salted = fire('MOVE_SMELLING_SALTS', { status1: STATUS1_POISON }, target)
    expect(salted.action.targetDamage).toBe(baseDamage(150))
    expect(baseDamage(150)).toBe(75)
    expect(salted.state.battlers[0]!.mon.status1).toBe(0)
    // The paralysis it just doubled on is NOT cured: the script targets BS_ATTACKER.
    expect(salted.state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
    expect(salted.action.unmodelled).not.toContain('secondary effect of EFFECT_SMELLINGSALT not modelled')

    // A user without a status takes the `goto BattleScript_MoveEnd` branch; the unparalysed target is a plain 75-power hit.
    const clean = fire('MOVE_SMELLING_SALTS', {}, { types: WATER })
    expect(clean.action.targetDamage).toBe(baseDamage(75))
    expect(baseDamage(75)).toBe(38)
    expect(clean.state.battlers[0]!.mon.status1).toBe(0)
  })
})

describe('Plasma Fists, Ion Deluge and Electrify: GetMoveTypeInternal\'s Normal-to-Electric override (battle_main.c:5196-5197)', () => {
  // Tackle (Normal physical 40) by a Fighting-typed user (no STAB either way) into a Water target: Atk 100 vs Def 90 -> 22*40*100/90 = 977 -> 19 -> 21.
  // Electric into Water is super effective: 42. Water Gun (special 40): 22*40*80/85 = 828 -> 16 -> 18; Water into Water halves it to 9.
  const FIGHTING: [string, string, string] = ['FIGHTING', 'MYSTERY', 'MYSTERY']
  const tackle = (prep?: (s: BattleState) => void) =>
    fire('MOVE_TACKLE', { types: FIGHTING }, { types: WATER }, MAX_ROLL, prep).action.targetDamage
  const waterGun = (prep?: (s: BattleState) => void) =>
    fire('MOVE_WATER_GUN', { types: FIGHTING }, { types: WATER }, MAX_ROLL, prep).action.targetDamage

  it('Ion Deluge turns Normal moves Electric and leaves every other type alone', () => {
    expect(tackle()).toBe(21)
    expect(tackle((s) => { s.field.statuses |= STATUS_FIELD_ION_DELUGE })).toBe(42)
    expect(waterGun()).toBe(9)
    expect(waterGun((s) => { s.field.statuses |= STATUS_FIELD_ION_DELUGE })).toBe(9)
  })

  it('Electrify turns every move of its victim Electric (STATUS4_ELECTRIFIED on the attacker)', () => {
    const electrify = (s: BattleState) => { s.battlers[0]!.statuses4 |= STATUS4_ELECTRIFIED }
    expect(tackle(electrify)).toBe(42)
    expect(waterGun(electrify)).toBe(36) // Electric into Water: 18 * 2
  })

  it('Plasma Fists hits, then Normal moves used later this turn are Electric; the status ends with the turn (s:397-420; ENDTURN_PLASMA_FISTS :2956-2959)', () => {
    // Plasma Fists: Electric physical 100 into a Fighting-typed target (neutral), no STAB for the Water user: 22*100*100/90 = 2444 -> 48 -> 50.
    // The target is slower, so its Tackle (a Normal move from a Fighting-type: no STAB either way) lands after the status is applied.
    const rng = scriptedRng([50, 1, 0, 50, 1, 0])
    const state = battle([{ types: WATER, moves: slot('MOVE_PLASMA_FISTS'), pp: pps }, { types: FIGHTING, moves: slot('MOVE_TACKLE'), pp: pps }], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_PLASMA_FISTS')), useMove(0, move('MOVE_TACKLE'))], testDeps(bridgeDamage(rng)))
    expect(out.actions[0].targetDamage).toBe(baseDamage(100))
    expect(baseDamage(100)).toBe(50)
    // Tackle into the Water-typed user: Electric is super effective, 21 * 2.
    expect(out.actions[1].targetDamage).toBe(42)
    expect(out.actions[0].unmodelled).not.toContain('secondary effect of EFFECT_PLASMA_FISTS not modelled')
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_PLASMA_FISTS)).toBe(false)
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_PLASMA_FISTS)).toBe(false)
  })
})

describe('Eerie Spell / Depletion Beam: VARIOUS_EERIE_SPELL_PP_REDUCE (battle_script_commands.c:7852-7882)', () => {
  // Eerie Spell: Psychic special 110 into a Normal target, 22*110*80/85 = 2277 -> 45 -> 47. Its argument is 6 PP; Depletion Beam's is 3.
  const cut = (moveId: string, targetPp: number, last: string | null = 'MOVE_TACKLE', moves: SimBattleMon['moves'] = slot('MOVE_TACKLE')) =>
    fire(moveId, {}, { moves, pp: [targetPp, 0, 0, 0] }, MAX_ROLL, (s) => {
      s.battlers[1]!.lastMove = last
    })

  it('takes the argument off the target\'s last used move, capped at what it has', () => {
    const six = cut('MOVE_EERIE_SPELL', 10)
    expect(six.action.targetDamage).toBe(baseDamage(110, 80, 85))
    expect(baseDamage(110, 80, 85)).toBe(47)
    expect(six.state.battlers[1]!.mon.pp[0]).toBe(4)
    expect(six.action.unmodelled).not.toContain('secondary effect of EFFECT_EERIE_SPELL not modelled')
    expect(cut('MOVE_DEPLETION_BEAM', 10).state.battlers[1]!.mon.pp[0]).toBe(7)
    expect(cut('MOVE_EERIE_SPELL', 4).state.battlers[1]!.mon.pp[0]).toBe(0)
  })

  it('does nothing when the target has no last move, the move is not in its set, or its PP is already 0', () => {
    expect(cut('MOVE_EERIE_SPELL', 10, null).state.battlers[1]!.mon.pp[0]).toBe(10)
    expect(cut('MOVE_EERIE_SPELL', 10, 'MOVE_SPLASH').state.battlers[1]!.mon.pp[0]).toBe(10)
    expect(cut('MOVE_EERIE_SPELL', 0).state.battlers[1]!.mon.pp[0]).toBe(0)
  })
})

describe('Ghastly Echo: hit, then the user switches out and the incoming mon gets STATUS4_GHASTLY_ECHO for two turns (s:2793-2840; VARIOUS_GHASTLY_ECHO :8379-8384)', () => {
  // Ghost special 20 into a Water target (Ghost is immune against Normal): 22*20*80/85 = 414 -> 8 -> 10.
  const echo = (incoming: Partial<SimPartyMon> = {}) => {
    const rng = scriptedRng(MAX_ROLL)
    const state = battle([{ types: WATER, moves: slot('MOVE_GHASTLY_ECHO'), pp: pps }, { types: WATER }], rng, [partyMon(), partyMon(incoming)], [partyMon()])
    const deps = { ...testDeps(bridgeDamage(rng)), replacement: { chooseReplacement: () => 1 } }
    const out = executeTurn(state, [useMove(1, move('MOVE_GHASTLY_ECHO')), null], deps)
    return { state, out, deps }
  }

  it('switches the user out and marks the new battler', () => {
    const { state, out, deps } = echo()
    expect(out.actions[0].targetDamage).toBe(baseDamage(20, 80, 85))
    expect(baseDamage(20, 80, 85)).toBe(10)
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_GHASTLY_ECHO)).toBe(true)
    expect(state.battlers[0]!.volatiles.ghastlyEchoTimer).toBe(1) // set to 2, ticked by this turn's ENDTURN_GHASTLY_ECHO
    expect(out.actions[0].unmodelled).not.toContain('secondary effect of EFFECT_GHASTLY_ECHO not modelled')
    // The next end of turn takes the timer to 0 and clears the status (battle_util.c:2813-2816).
    executeTurn(state, [null, null], deps)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_GHASTLY_ECHO)).toBe(false)
  })

  it('does not mark a Soundproof incoming mon', () => {
    const { state } = echo({ abilities: ability('ABILITY_SOUNDPROOF') })
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_GHASTLY_ECHO)).toBe(false)
  })

  it('a miss does not switch', () => {
    const rng = scriptedRng([101])
    const state = battle([{ types: WATER, moves: slot('MOVE_GHASTLY_ECHO'), pp: pps }, {}], rng, [partyMon(), partyMon()], [partyMon()])
    executeTurn(state, [useMove(1, move('MOVE_GHASTLY_ECHO')), null], { ...testDeps(bridgeDamage(rng)), replacement: { chooseReplacement: () => 1 } })
    expect(state.battlers[0]!.partyIndex).toBe(0)
  })
})

describe('EFFECT_MISC_HIT sub-cases and the remaining plain hits', () => {
  it('Rage Fist adds 20 power per time the user took direct damage, up to 6 times (battle_util.c:6869-6871; IncrementTimesTookDamage :1859-1862)', () => {
    // Ghost physical 80 into a Water target: 22*P*100/90 -> P=80: 1955 -> 39 -> 41; P=140: 3422 -> 68 -> 70; P=200: 4888 -> 97 -> 99.
    const rage = (times: number) =>
      fire('MOVE_RAGE_FIST', {}, { types: WATER }, MAX_ROLL, (s) => {
        s.sides[0].timesDamaged[0] = times
      })
    expect(rage(0).action.targetDamage).toBe(41)
    expect(rage(3).action.targetDamage).toBe(70)
    expect(rage(9).action.targetDamage).toBe(99)
    expect(rage(3).action.unmodelled.some((u) => u.includes('MISC_EFFECT_TOOK_DAMAGE_BOOST'))).toBe(false)
  })

  it('every hit that damages the user (physical or special, not Pain Split) counts for Rage Fist; passive damage does not', () => {
    // A faster foe uses Tackle then Water Gun on separate turns: two counts. Poison on the user adds none.
    const rng = scriptedRng([50, 1, 0, 50, 1, 0])
    const state = battle([{ moves: slot('MOVE_RAGE_FIST'), pp: pps, status1: STATUS1_POISON, spe: 50 }, { moves: slot('MOVE_TACKLE', 'MOVE_WATER_GUN'), pp: pps, spe: 100 }], rng)
    const deps = testDeps(bridgeDamage(rng))
    executeTurn(state, [null, useMove(0, move('MOVE_TACKLE'))], deps)
    expect(state.sides[0].timesDamaged[0]).toBe(1)
    executeTurn(state, [null, useMove(0, move('MOVE_WATER_GUN'))], deps)
    expect(state.sides[0].timesDamaged[0]).toBe(2)
    expect(state.sides[1].timesDamaged[0]).toBe(0)
  })

  it('Fickle Beam draws Random() % 100 < 30 for doubled power, before the damage roll (battle_util.c:6872-6874)', () => {
    // Dragon special 80 into a Normal target: P=80 -> 35 (see above); P=160: 22*160*80/85 = 3312 -> 66 -> 68. Draws: accuracy, coin, crit, roll.
    const doubled = fire('MOVE_FICKLE_BEAM', {}, {}, [50, 29, 1, 0])
    expect(doubled.action.targetDamage).toBe(baseDamage(160, 80, 85))
    expect(baseDamage(160, 80, 85)).toBe(68)
    expect(doubled.rng.calls).toBe(4)
    const plain = fire('MOVE_FICKLE_BEAM', {}, {}, [50, 30, 1, 0])
    expect(plain.action.targetDamage).toBe(baseDamage(80, 80, 85))
    expect(doubled.action.unmodelled.some((u) => u.includes('MISC_EFFECT_DOUBLE_DAMAGE'))).toBe(false)
  })

  it('Transmute\'s only extra is BattleScript_TryRecycle on a KO (VARIOUS_TRY_ACTIVATE_FELL_STINGER :7185-7187, Cmd_tryrecycleitem :12296-12311)', () => {
    const run = (damage: number, held: string | null) => {
      const state = battle([{ moves: slot('MOVE_TRANSMUTE'), pp: pps, itemId: held }, { hp: 40 }], scriptedRng([50]), [partyMon(), partyMon()], [partyMon(), partyMon()])
      state.battlers[0]!.usedHeldItem = 'ITEM_ORAN_BERRY'
      executeTurn(state, [useMove(1, move('MOVE_TRANSMUTE')), null], testDeps(recordingDamage(damage)))
      return state.battlers[0]!
    }
    expect(run(100, null).mon.itemId).toBe('ITEM_ORAN_BERRY') // KO: the used berry comes back
    expect(run(100, null).usedHeldItem).toBeNull()
    expect(run(10, null).mon.itemId).toBeNull() // no KO
    expect(run(100, 'ITEM_LEFTOVERS').mon.itemId).toBe('ITEM_LEFTOVERS') // already holding something
  })

  it('Last Respects adds 10 power per fainted party member (battle_util.c:6863-6865)', () => {
    // Ghost physical 90 + 2 * 10 = 110 into a Water target: 22*110*100/90 = 2688 -> 53 -> 55.
    const respects = fire('MOVE_LAST_RESPECTS', {}, { types: WATER }, MAX_ROLL, (s) => {
      s.sides[0].faintedCount = 2
    })
    expect(respects.action.targetDamage).toBe(baseDamage(110))
    expect(baseDamage(110)).toBe(55)
    expect(respects.action.unmodelled).not.toContain('secondary effect of EFFECT_MISC_HIT not modelled')
  })

  it('Gust, Decorate and Pollen Puff against a foe, Snipe Shot and Focus Punch are plain hits (s:5703, 582-584, 1556-1558; config :1706)', () => {
    // Special P=40 -> 18, 80 -> 35, 90 -> 39 (22*90*80/85 = 1863 -> 37 -> 39).
    expect(baseDamage(40, 80, 85)).toBe(18)
    const gust = fire('MOVE_GUST', {})
    expect(gust.action.targetDamage).toBe(18)
    expect(gust.action.unmodelled).not.toContain('secondary effect of EFFECT_GUST not modelled')
    const decorate = fire('MOVE_DECORATE', {})
    expect(decorate.action.targetDamage).toBe(35)
    expect(decorate.action.unmodelled).not.toContain('secondary effect of EFFECT_DECORATE not modelled')
    const puff = fire('MOVE_POLLEN_PUFF', {})
    expect(puff.action.targetDamage).toBe(39)
    expect(puff.action.unmodelled).not.toContain('secondary effect of EFFECT_HIT_ENEMY_HEAL_ALLY not modelled')
    const snipe = fire('MOVE_SNIPE_SHOT', { types: ['FIGHTING', 'MYSTERY', 'MYSTERY'] }) // no STAB on this Water move
    expect(snipe.action.targetDamage).toBe(39)
    expect(snipe.action.unmodelled).not.toContain('secondary effect of EFFECT_SNIPE_SHOT not modelled')
  })

  it('an ALLY target of Decorate / Pollen Puff takes the status-move branch, which is not ported, so the note stays', () => {
    const state = battle([{}, {}, {}, {}], scriptedRng([]))
    for (const id of ['MOVE_DECORATE', 'MOVE_POLLEN_PUFF']) {
      const unmodelled: string[] = []
      applySecondaryMoveEffects({ state, attackerId: 0, targetId: 2, moveId: id, targetDamage: 10, deps: testDeps(recordingDamage(1)), unmodelled })
      expect(unmodelled).toContain(`secondary effect of ${move(id).effect} not modelled`)
    }
  })

  it('Focus Punch is 150 power, or 40 once the user was hit earlier in the turn (battle_util.c:6851-6853); s:6177-6181 only adds the lost-focus line', () => {
    // Fighting physical into a Water target: 150 -> 75; 40 -> 21 (22*40*100/90 = 977 -> 19 -> 21).
    const hit = fire('MOVE_FOCUS_PUNCH', {}, { types: WATER })
    expect(hit.action.targetDamage).toBe(75)
    expect(hit.action.unmodelled).not.toContain('secondary effect of EFFECT_FOCUS_PUNCH not modelled')
    // The foe is faster and its Tackle damages the user first.
    const rng = scriptedRng([50, 1, 0, 50, 1, 0])
    const state = battle([{ types: WATER, moves: slot('MOVE_FOCUS_PUNCH'), pp: pps, spe: 50 }, { types: WATER, moves: slot('MOVE_TACKLE'), pp: pps, spe: 100 }], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_FOCUS_PUNCH')), useMove(0, move('MOVE_TACKLE'))], testDeps(bridgeDamage(rng)))
    const punch = out.actions.find((a) => a.battlerId === 0)!
    expect(punch.targetDamage).toBe(21)
  })
})
