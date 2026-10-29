/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { MoveData } from '../calculate'
import type { TypeChart } from '../typeEffectiveness'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { buildAccuracyInputs } from './accuracyBridge'
import { getTotalAccuracy } from './accuracy'
import { createBridgeDamageResolver } from './damageResolver'
import { STATUS2_WRAPPED } from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the same snapshot-backed shape cycle96Abilities.test.ts uses.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
/** natures.json is BattleConstants (natureStatTable, statStageRatios, criticalHitChance, ...). */
const battleConstants = snapshot<Record<string, unknown>>('natures.json') as never

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

/** The damage engine's own MoveData shape (calculate.ts), converted from the
 * snapshot the way damageResolver.test.ts does -- DamageResolver.moveData
 * takes this type, not SimMoveData. */
function toMoveData(id: string): MoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  const arg = m.argument as Record<string, unknown> | undefined
  return {
    id,
    power: m.power as number,
    type: String(m.type).replace('TYPE_', ''),
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
    split: m.split as MoveData['split'],
    effectChance: m.effectChance as number,
    splitFlag: m.splitFlag as string | undefined,
    effect: m.effect as string | null,
    customBehavior: m.customBehavior,
    crit: m.crit as MoveData['crit'],
    flags: (m.flags as Record<string, true>) ?? {},
    priority: m.priority as number,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null,
    multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
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

/** buildAccuracyInputs reads move accuracy from moves.json. The snapshot has no
 * damaging move with accuracy 70 other than MOVE_FEMUR_BREAKER (70) and no
 * status move at 70 at all, while the C arithmetic these cases pin is
 * `trunc(70 * <multiplier>)`. Patching one move's accuracy in the test's own
 * data context keeps every number going through the real bridge. */
function dataContextWithAccuracy(overrides: Record<string, number>): SimDataContext {
  return {
    ...DATA_CONTEXT,
    move: (id) => {
      const base = DATA_CONTEXT.move(id)
      if (!base || overrides[id] === undefined) return base
      return { ...base, accuracy: overrides[id] }
    },
  }
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

function battle(specs: BattlerSpec[], rng: RandomSource): BattleState {
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
  })
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

/** A TurnLoopDeps whose resolver is the REAL combat resolver, so the accuracy
 * check's type-effectiveness lookup exercises damageResolver.ts's own path and
 * shares the scripted RNG stream with the damage step. */
function realDeps(rng: RandomSource, dataContext: SimDataContext = DATA_CONTEXT): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const damage: DamageResolver = createBridgeDamageResolver({
    grounding: GROUNDING,
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    statStageRatios: RATIOS,
    dataContext,
    inverseBattle: false,
    moveData: (id) => (movesById.has(id) ? toMoveData(id) : undefined),
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants,
    random: rng,
  })
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})

const move = (id: string): SimMoveData => requireMove(id)
const accuracyOf = (state: BattleState, attackId: number, targetId: number, moveId: string, deps: TurnLoopDeps): number =>
  getTotalAccuracy(buildAccuracyInputs(state, attackId, targetId, moveId, false, deps).inputs).accuracy

/** MOVE_FEMUR_BREAKER is ELECTRIC, PHYSICAL, 120 power, accuracy 70
 * (moves.json) -- the only damaging move in the snapshot at exactly 70. */
const FEMUR = 'MOVE_FEMUR_BREAKER'
/** MOVE_HYPNOSIS is a plain STATUS/EFFECT_SLEEP move at accuracy 60; the cases
 * below patch it to 70 (see dataContextWithAccuracy). */
const HYPNOSIS = 'MOVE_HYPNOSIS'
const ACC_70 = dataContextWithAccuracy({ [HYPNOSIS]: 70 })

function accuracyWith(
  attacker: BattlerSpec,
  defender: BattlerSpec,
  moveId: string,
  deps: TurnLoopDeps = realDeps(scriptedRng([]), ACC_70),
): number {
  const state = battle([{ moves: slot(moveId), pp: pps, ...attacker }, defender], scriptedRng([]))
  return accuracyOf(state, 0, 1, moveId, deps)
}

// ---------------------------------------------------------------------------
// 1. Fatal Precision / Final Blow must fire inside the real battle loop
// ---------------------------------------------------------------------------

describe('cycle 101 - Fatal Precision and Final Blow through the turn loop (abilities.cc:4397-4407)', () => {
  // C: CHECK_NOT(IS_MOVE_STATUS(move)); CHECK(CalcTypeEffectivenessMultiplier(...) >=
  // GetSuperEffectiveMult()); return ACCURACY_HITS_IF_POSSIBLE. The accuracy roll is
  // `Random() % 100 >= accuracy` (battle_script_commands.c:1433), so a scripted 99 misses
  // at 70 and hits at 101.
  it('hits a super-effective target when the roll would miss at 70', () => {
    const rng = scriptedRng([99, 0, 0])
    const state = battle(
      [
        { moves: slot(FEMUR), pp: pps, abilities: ability('ABILITY_FATAL_PRECISION') },
        { types: ['WATER', 'MYSTERY', 'MYSTERY'] }, // Electric vs Water = 2x = UQ_4_12(2.0)
      ],
      rng,
    )
    const deps = realDeps(rng)
    expect(accuracyOf(state, 0, 1, FEMUR, deps)).toBe(101)
    // GetTotalAccuracy has no Random() call, and the type-effectiveness probe
    // (calculateMoveDamage, deterministic) draws none either.
    expect(rng.calls).toBe(0)

    const out = executeTurn(state, [useMove(1, move(FEMUR)), null], deps)
    const action = out.actions[0]!
    expect(action.missed).toBe(false)
    expect(action.targetDamage).not.toBeNull()
  })

  it('still misses a neutral target on the same roll: accuracy stays 70', () => {
    const rng = scriptedRng([99])
    const state = battle(
      [
        { moves: slot(FEMUR), pp: pps, abilities: ability('ABILITY_FATAL_PRECISION') },
        { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, // Electric vs Normal = 1x
      ],
      rng,
    )
    const deps = realDeps(rng)
    expect(accuracyOf(state, 0, 1, FEMUR, deps)).toBe(70)

    const out = executeTurn(state, [useMove(1, move(FEMUR)), null], deps)
    const action = out.actions[0]!
    expect(action.missed).toBe(true)
    expect(action.targetDamage).toBeNull()
    // Only the accuracy draw: the damage resolver never ran.
    expect(rng.calls).toBe(1)
  })

  it('Final Blow (alias) hits a super-effective target on roll 99', () => {
    const rng = scriptedRng([99, 0, 0])
    const state = battle(
      [
        { moves: slot(FEMUR), pp: pps, abilities: ability('ABILITY_FINAL_BLOW') },
        { types: ['WATER', 'MYSTERY', 'MYSTERY'] },
      ],
      rng,
    )
    const deps = realDeps(rng)
    expect(accuracyOf(state, 0, 1, FEMUR, deps)).toBe(101)
    const out = executeTurn(state, [useMove(1, move(FEMUR)), null], deps)
    expect(out.actions[0]!.missed).toBe(false)
    expect(out.actions[0]!.targetDamage).not.toBeNull()
  })

  it('a status move against a type it would be "super effective" against still misses: 70', () => {
    const rng = scriptedRng([99])
    const state = battle(
      [
        { moves: slot(HYPNOSIS), pp: pps, abilities: ability('ABILITY_FATAL_PRECISION') },
        { types: ['FIGHTING', 'MYSTERY', 'MYSTERY'] }, // Psychic vs Fighting would be 2x, but status moves are forced to 1x
      ],
      rng,
    )
    const deps = realDeps(rng, ACC_70)
    expect(accuracyOf(state, 0, 1, HYPNOSIS, deps)).toBe(70)
    const out = executeTurn(state, [useMove(1, move(HYPNOSIS)), null], deps)
    expect(out.actions[0]!.missed).toBe(true)
    expect(out.actions[0]!.targetDamage).toBeNull()
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 2. buildAccuracyInputs' isSuperEffective plumbing
// ---------------------------------------------------------------------------

describe('cycle 101 - buildAccuracyInputs.isSuperEffective (accuracy.ts:225, 471)', () => {
  const holder = ability('ABILITY_FATAL_PRECISION')

  function inputsFor(defenderTypes: [string, string, string], abilities = holder) {
    const rng = scriptedRng([])
    const state = battle([{ moves: slot(FEMUR), pp: pps, abilities }, { types: defenderTypes }], rng)
    const deps = realDeps(rng)
    const built = buildAccuracyInputs(state, 0, 1, FEMUR, false, deps)
    const raw = deps.damage!.typeEffectiveness!(state, 0, 1, FEMUR)
    return { built, rng, raw }
  }

  it('is true for 2x (UQ_4_12(2.0) = 2048 >= GetSuperEffectiveMult = 2048)', () => {
    const { built, raw } = inputsFor(['WATER', 'MYSTERY', 'MYSTERY'])
    // UQ_4_12 is 10-bit in this checkout (include/global.h:113), so 2.0 = 2048.
    expect(raw.effectiveness).toBe(2048)
    expect(built.inputs.isSuperEffective).toBe(true)
    expect(getTotalAccuracy(built.inputs).accuracy).toBe(101)
  })

  it('is false for neutral (1024) and resisted (512)', () => {
    const neutral = inputsFor(['NORMAL', 'MYSTERY', 'MYSTERY'])
    expect(neutral.raw.effectiveness).toBe(1024)
    expect(neutral.built.inputs.isSuperEffective).toBe(false)
    const resisted = inputsFor(['GRASS', 'MYSTERY', 'MYSTERY'])
    expect(resisted.raw.effectiveness).toBe(512)
    expect(resisted.built.inputs.isSuperEffective).toBe(false)
  })

  it('keeps the accuracy.ts gap when the resolver has no typeEffectiveness method', () => {
    const rng = scriptedRng([])
    const state = battle([{ moves: slot(FEMUR), pp: pps, abilities: holder }, { types: ['WATER', 'MYSTERY', 'MYSTERY'] }], rng)
    const damage: DamageResolver = {
      resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [], isSuperEffective: false }),
    }
    const built = buildAccuracyInputs(state, 0, 1, FEMUR, false, { grounding: GROUNDING, dataContext: DATA_CONTEXT, damage })
    expect(built.inputs.isSuperEffective).toBeUndefined()
    const result = getTotalAccuracy(built.inputs)
    expect(result.accuracy).toBe(70)
    expect(result.gaps.some((gap) => gap.detail.includes("needs the hit's type effectiveness"))).toBe(true)
  })

  it('is undefined for a holder-less attacker, and nothing is computed or drawn', () => {
    const { built, rng } = inputsFor(['WATER', 'MYSTERY', 'MYSTERY'], { ability: null, innates: [null, null, null] })
    expect(built.inputs.isSuperEffective).toBeUndefined()
    expect(rng.calls).toBe(0)
    // No type-effectiveness gap either: the gap at accuracy.ts:724 only fires for a holder.
    expect(built.gaps.filter((gap) => gap.field === 'isSuperEffective')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Gunman grants MOVE_FLAG_MEGA_LAUNCHER to status moves (abilities.cc:9533-9543)
// ---------------------------------------------------------------------------

describe('cycle 101 - Gunman through the Mega Launcher flag (battle_util.c:9373, abilities.cc:358-388)', () => {
  it('Artillery + Gunman makes a status move unmissable: 101', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ARTILLERY', 'ABILITY_GUNMAN') }, {}, HYPNOSIS)).toBe(101)
  })

  it('Gunman alone leaves the status move at 70 (Gunman has no onAccuracy hook)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_GUNMAN') }, {}, HYPNOSIS)).toBe(70)
  })

  it('Artillery alone leaves the status move at 70 (it is not bulletBased)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ARTILLERY') }, {}, HYPNOSIS)).toBe(70)
  })

  it('Artillery with a bulletBased move is unmissable: 101 (MOVE_DRAGON_PULSE)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ARTILLERY') }, {}, 'MOVE_DRAGON_PULSE')).toBe(101)
  })
})

// ---------------------------------------------------------------------------
// 4. The verified-equal hooks, re-checked end to end through the bridge
// ---------------------------------------------------------------------------

describe('cycle 101 - Compound Eyes / Illuminate / Keen Eye / Hustle / Gifted Mind / Grip Pincer / Inner Focus through the bridge', () => {
  it('Compound Eyes: trunc(70 * 1.3) = 91 (abilities.cc:662-667)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_COMPOUND_EYES') }, {}, FEMUR)).toBe(91)
  })

  it('Illuminate: trunc(70 * 1.2) = 84 (abilities.cc:912-948)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ILLUMINATE') }, {}, FEMUR)).toBe(84)
  })

  it('Keen Eye: trunc(70 * 1.2) = 84 (abilities.cc:1141-1153)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_KEEN_EYE') }, {}, FEMUR)).toBe(84)
  })

  it('Hustle: trunc(70 * 0.9) = 63 on a damaging move (abilities.cc:1199-1205)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_HUSTLE') }, {}, FEMUR)).toBe(63)
  })

  it('Hustle: status moves are exempt, 70', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_HUSTLE') }, {}, HYPNOSIS)).toBe(70)
  })

  it('Gifted Mind: a status move of accuracy 70 is unmissable (101), a damaging one is not (70)', () => {
    // abilities.cc:5354-5365 returns ACCURACY_HITS_IF_POSSIBLE for IS_MOVE_STATUS.
    expect(accuracyWith({ abilities: ability('ABILITY_GIFTED_MIND') }, {}, HYPNOSIS)).toBe(101)
    expect(accuracyWith({ abilities: ability('ABILITY_GIFTED_MIND') }, {}, FEMUR)).toBe(70)
  })

  it('Grip Pincer: ALWAYS_HITS only while the defender is wrapped (abilities.cc:4689-4711)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_GRIP_PINCER') }, { status2: STATUS2_WRAPPED }, FEMUR)).toBe(101)
    expect(accuracyWith({ abilities: ability('ABILITY_GRIP_PINCER') }, { status2: 0 }, FEMUR)).toBe(70)
  })

  it('Inner Focus: ALWAYS_HITS only for Focus Blast (abilities.cc:1002-1013)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_INNER_FOCUS') }, {}, 'MOVE_FOCUS_BLAST')).toBe(101)
    expect(accuracyWith({ abilities: ability('ABILITY_INNER_FOCUS') }, {}, FEMUR)).toBe(70)
  })
})

// ---------------------------------------------------------------------------
// 5. APPLY_ON_SELF is the default onAccuracyFor, so a DEFENDER's hook does not
//    touch the attacker's accuracy (abilities.cc:176-198)
// ---------------------------------------------------------------------------

describe('cycle 101 - a defender-side onAccuracy hook with the default onAccuracyFor never runs', () => {
  it('defender with Compound Eyes leaves the attacker at 70', () => {
    expect(accuracyWith({}, { abilities: ability('ABILITY_COMPOUND_EYES') }, FEMUR)).toBe(70)
  })
})