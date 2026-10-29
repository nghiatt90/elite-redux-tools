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
import { isStrikerMove } from './statusEffects'
import { WEATHER_FOG_TEMPORARY, WEATHER_RAIN_TEMPORARY, WEATHER_SANDSTORM_TEMPORARY } from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the same snapshot-backed shape cycle101Accuracy.test.ts uses.
//
// requireMove strips the TYPE_ prefix from `type`, exactly as the production
// loader does (driver/loadSimData.ts:181). SimMoveData therefore carries the
// bare form ('NORMAL', 'GRASS') everywhere the engine reads it, which is what
// statusEffects.ts's isKeenEdgeMove ('GRASS') and the new isStrikerMove
// ('NORMAL') compare against.
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
    type: m.type ? String(m.type).replace('TYPE_', '') : null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 ? String(m.type2).replace('TYPE_', '') : null,
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
 * snapshot the way damageResolver.test.ts does. */
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

/** Several required cases need `trunc(70 * <multiplier>)`, and the snapshot's
 * move of that shape is neither a kick, a punch, a dance, a slice, a sound
 * move nor a Grass move. Patching `accuracy` in the test's own data context
 * keeps every number going through the real bridge and the real move data. */
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
 * check's type-effectiveness lookup exercises damageResolver.ts's own path. */
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

/** Every move used in a `trunc(70 * x)` case, patched to accuracy 70. Moves
 * whose accuracy the case reads from the data (Sing 60, Hypnosis 60, Focus
 * Blast 75) are deliberately absent from this map. */
const ACC_70 = dataContextWithAccuracy({
  MOVE_LOW_KICK: 70,
  MOVE_MEGA_PUNCH: 70,
  MOVE_TACKLE: 70,
  MOVE_EMBER: 70,
  MOVE_AERIAL_ACE: 70,
  MOVE_ABSORB: 70,
  MOVE_AQUA_STEP: 70,
  MOVE_BUG_BUZZ: 70,
  MOVE_HYPER_VOICE: 70,
})

const FEMUR = 'MOVE_FEMUR_BREAKER'

function accuracyOf(state: BattleState, attackId: number, targetId: number, moveId: string, deps: TurnLoopDeps): number {
  return getTotalAccuracy(buildAccuracyInputs(state, attackId, targetId, moveId, false, deps).inputs).accuracy
}

function accuracyWith(attacker: BattlerSpec, defender: BattlerSpec, moveId: string, deps: TurnLoopDeps = realDeps(scriptedRng([]), ACC_70)): number {
  const state = battle([{ moves: slot(moveId), pp: pps, ...attacker }, defender], scriptedRng([]))
  return accuracyOf(state, 0, 1, moveId, deps)
}

// ---------------------------------------------------------------------------
// 1. Lullaby / Lunar Eclipse (abilities.cc:9582-9588, :4631)
// ---------------------------------------------------------------------------

describe('cycle 102 - Lullaby and Lunar Eclipse (abilities.cc:9582-9588, :4631)', () => {
  it('Lullaby on MOVE_SING: trunc(60 * 1.5) = 90', () => {
    // moves.json MOVE_SING accuracy is 60, not 55. C: CHECK(move == MOVE_SING);
    // *accuracy *= 1.5; MULTIPLICATIVE -- an int times a double truncates.
    expect(accuracyWith({ abilities: ability('ABILITY_LULLABY') }, {}, 'MOVE_SING')).toBe(90)
  })

  it('Lullaby on another status move leaves it alone: 60', () => {
    // MOVE_HYPNOSIS is accuracy 60 (moves.json); Lullaby's hook checks move == MOVE_SING.
    expect(accuracyWith({ abilities: ability('ABILITY_LULLABY') }, {}, 'MOVE_HYPNOSIS')).toBe(60)
  })

  it('Lunar Eclipse aliases Hypnotist onAccuracy: Hypnosis trunc(60 * 1.5) = 90', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_LUNAR_ECLIPSE') }, {}, 'MOVE_HYPNOSIS')).toBe(90)
  })
})

// ---------------------------------------------------------------------------
// 2. No Guard / Qigong / Way of Precision (abilities.cc:1611-1614, :9352-9359,
//    :8472) -- onAccuracyFor is the only thing that decides which side runs
// ---------------------------------------------------------------------------

describe('cycle 102 - No Guard, Qigong and Way of Precision side selection', () => {
  it('No Guard on the attacker (APPLY_ON_ATTACKER_OR_TARGET): 101', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_NO_GUARD') }, {}, FEMUR)).toBe(101)
  })

  it('No Guard on the DEFENDER: 101', () => {
    expect(accuracyWith({}, { abilities: ability('ABILITY_NO_GUARD') }, FEMUR)).toBe(101)
  })

  it('Qigong on the attacker (default APPLY_ON_SELF): 101', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_QIGONG') }, {}, FEMUR)).toBe(101)
  })

  it('Qigong on the defender does nothing: accuracy stays 70', () => {
    expect(accuracyWith({}, { abilities: ability('ABILITY_QIGONG') }, FEMUR)).toBe(70)
  })

  it('Way of Precision is Inner Focus: Focus Blast 101, anything else 70 (abilities.cc:8472)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_WAY_OF_PRECISION') }, {}, 'MOVE_FOCUS_BLAST')).toBe(101)
    expect(accuracyWith({ abilities: ability('ABILITY_WAY_OF_PRECISION') }, {}, FEMUR)).toBe(70)
  })
})

// ---------------------------------------------------------------------------
// 3. Weather hooks must see IsBattlerWeatherAffected, i.e. WEATHER_HAS_EFFECT
//    and the Utility Umbrella clause (battle_util.c:8644-8653,
//    include/battle_util.h:45-46)
// ---------------------------------------------------------------------------

describe('cycle 102 - Sand Veil / Rain Shroud / Smokey Maneuvers weather gating', () => {
  function inWeather(specs: { attacker: BattlerSpec; defender: BattlerSpec; moveId: string; weather: number; clearSkies?: number }): number {
    const state = battle([{ moves: slot(specs.moveId), pp: pps, ...specs.attacker }, specs.defender], scriptedRng([]))
    state.field.weather = specs.weather
    if (specs.clearSkies !== undefined) state.field.timers.clearSkiesTimer = specs.clearSkies
    return accuracyOf(state, 0, 1, specs.moveId, realDeps(scriptedRng([]), ACC_70))
  }

  it('Sand Veil in sandstorm: trunc(70 / 1.25) = 56', () => {
    expect(inWeather({ attacker: {}, defender: { abilities: ability('ABILITY_SAND_VEIL') }, moveId: FEMUR, weather: WEATHER_SANDSTORM_TEMPORARY })).toBe(56)
  })

  it('Sand Veil in sandstorm with Cloud Nine on the field: 70', () => {
    // WEATHER_HAS_EFFECT is false, so IsBattlerWeatherAffected is FALSE and the
    // hook is skipped. Cloud Nine sits on the attacker's side, still on the field.
    expect(
      inWeather({
        attacker: { abilities: ability('ABILITY_CLOUD_NINE') },
        defender: { abilities: ability('ABILITY_SAND_VEIL') },
        moveId: FEMUR,
        weather: WEATHER_SANDSTORM_TEMPORARY,
      }),
    ).toBe(70)
  })

  it('Sand Veil in sandstorm with clearSkiesTimer set: 70', () => {
    expect(
      inWeather({ attacker: {}, defender: { abilities: ability('ABILITY_SAND_VEIL') }, moveId: FEMUR, weather: WEATHER_SANDSTORM_TEMPORARY, clearSkies: 3 }),
    ).toBe(70)
  })

  it('Sand Veil with no weather: 70', () => {
    expect(inWeather({ attacker: {}, defender: { abilities: ability('ABILITY_SAND_VEIL') }, moveId: FEMUR, weather: 0 })).toBe(70)
  })

  it('Rain Shroud in rain: trunc(70 / 1.25) = 56', () => {
    expect(inWeather({ attacker: {}, defender: { abilities: ability('ABILITY_RAIN_SHROUD') }, moveId: FEMUR, weather: WEATHER_RAIN_TEMPORARY })).toBe(56)
  })

  it('Rain Shroud in rain with a Utility Umbrella on the defender: 70', () => {
    // IsBattlerWeatherAffected's umbrella clause (battle_util.c:8647-8650)
    // applies to WEATHER_RAIN_ANY; the holder is the TARGET (battlerDef).
    expect(
      inWeather({
        attacker: {},
        defender: { abilities: ability('ABILITY_RAIN_SHROUD'), itemId: 'ITEM_UTILITY_UMBRELLA' },
        moveId: FEMUR,
        weather: WEATHER_RAIN_TEMPORARY,
      }),
    ).toBe(70)
  })

  it('Rain Shroud in rain with Air Lock on the field: 70', () => {
    expect(
      inWeather({
        attacker: { abilities: ability('ABILITY_AIR_LOCK') },
        defender: { abilities: ability('ABILITY_RAIN_SHROUD') },
        moveId: FEMUR,
        weather: WEATHER_RAIN_TEMPORARY,
      }),
    ).toBe(70)
  })

  it('Smokey Maneuvers in fog: 56; with Cloud Nine on the field: 70', () => {
    expect(inWeather({ attacker: {}, defender: { abilities: ability('ABILITY_SMOKEY_MANEUVERS') }, moveId: FEMUR, weather: WEATHER_FOG_TEMPORARY })).toBe(56)
    expect(
      inWeather({
        attacker: { abilities: ability('ABILITY_CLOUD_NINE') },
        defender: { abilities: ability('ABILITY_SMOKEY_MANEUVERS') },
        moveId: FEMUR,
        weather: WEATHER_FOG_TEMPORARY,
      }),
    ).toBe(70)
  })

  it('Sand Veil defender vs a Mold Breaker attacker is still 70 (breakable) -- regression pin', () => {
    expect(
      inWeather({
        attacker: { abilities: ability('ABILITY_MOLD_BREAKER') },
        defender: { abilities: ability('ABILITY_SAND_VEIL') },
        moveId: FEMUR,
        weather: WEATHER_SANDSTORM_TEMPORARY,
      }),
    ).toBe(70)
  })

  it('the gated weather reaches the real accuracy roll', () => {
    // The C's roll is `Random() % 100 >= accuracy` -> a miss
    // (battle_script_commands.c:1433). 60 misses at 56, hits at 70.
    const rng = scriptedRng([60, 0, 0])
    const state = battle([{ moves: slot(FEMUR), pp: pps }, { abilities: ability('ABILITY_SAND_VEIL') }], rng)
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    const deps = realDeps(rng, ACC_70)
    expect(accuracyOf(state, 0, 1, FEMUR, deps)).toBe(56)
    const out = executeTurn(state, [useMove(1, move(FEMUR)), null], deps)
    expect(out.actions[0]!.missed).toBe(true)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Ole switches on GetBattlerBattleMoveTargetFlags(move, ATTACKER)
//    (abilities.cc:7556-7570, battle_util.c:128-149)
// ---------------------------------------------------------------------------

describe('cycle 102 - Ole reads the ability-adjusted target flags', () => {
  it('Ole defender vs a SELECTED move: trunc(70 * 0.8) = 56', () => {
    expect(accuracyWith({}, { abilities: ability('ABILITY_OLE') }, FEMUR)).toBe(56)
  })

  it('Amplifier widens its sound move to BOTH, so Ole does not cut: 70', () => {
    // IsSoundMove(MOVE_BUG_BUZZ) is TRUE via its static sound flag, so
    // GetBattlerBattleMoveTargetFlags returns MOVE_TARGET_BOTH and Ole's
    // switch falls to default -> ACCURACY_NO_RESULT. Amplifier has no
    // onAccuracy hook, so nothing else moves the number.
    const state = battle([{ moves: slot('MOVE_BUG_BUZZ'), pp: pps, abilities: ability('ABILITY_AMPLIFIER') }, { abilities: ability('ABILITY_OLE') }], scriptedRng([]))
    const deps = realDeps(scriptedRng([]), ACC_70)
    const built = buildAccuracyInputs(state, 0, 1, 'MOVE_BUG_BUZZ', false, deps)
    expect(built.inputs.moveTarget).toBe('BOTH')
    expect(getTotalAccuracy(built.inputs).accuracy).toBe(70)
  })

  it('Ole defender vs a move whose data target is already BOTH: 70', () => {
    expect(accuracyWith({}, { abilities: ability('ABILITY_OLE') }, 'MOVE_HYPER_VOICE')).toBe(70)
  })
})

// ---------------------------------------------------------------------------
// 5. Roundhouse + IsStrikerBoosted (abilities.cc:5072-5087, battle_util.c:9377)
// ---------------------------------------------------------------------------

describe('cycle 102 - Roundhouse sees ability-granted MOVE_FLAG_KICK', () => {
  it('static kickBased move: 101', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ROUNDHOUSE') }, {}, 'MOVE_LOW_KICK')).toBe(101)
  })

  it('non-kick move: 70', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ROUNDHOUSE') }, {}, FEMUR)).toBe(70)
  })

  it('Junshi Sanda grants KICK to a punchBased move: 101 (abilities.cc:7613-7622)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ROUNDHOUSE', 'ABILITY_JUNSHI_SANDA') }, {}, 'MOVE_MEGA_PUNCH')).toBe(101)
  })

  it('Mixed Martial Arts grants KICK to a Normal-type non-kick move: 101; Fire: 70 (abilities.cc:9898-9905)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ROUNDHOUSE', 'ABILITY_MIXED_MARTIAL_ARTS') }, {}, 'MOVE_TACKLE')).toBe(101)
    expect(accuracyWith({ abilities: ability('ABILITY_ROUNDHOUSE', 'ABILITY_MIXED_MARTIAL_ARTS') }, {}, 'MOVE_EMBER')).toBe(70)
  })

  it('Backstreet Boy grants KICK to a dance move: 101 (abilities.cc:11570-11583)', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_ROUNDHOUSE', 'ABILITY_BACKSTREET_BOY') }, {}, 'MOVE_AQUA_STEP')).toBe(101)
  })

  it('Junshi Sanda without Roundhouse has no onAccuracy hook: 70', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_JUNSHI_SANDA') }, {}, 'MOVE_MEGA_PUNCH')).toBe(70)
  })
})

// ---------------------------------------------------------------------------
// 6. Sweeping Edge Plus + IsKeenEdge (abilities.cc:7482-7486, :5343-5344)
// ---------------------------------------------------------------------------

describe('cycle 102 - Sweeping Edge Plus sees ability-granted MOVE_FLAG_KEEN_EDGE', () => {
  it('static sliceBased move: 101', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_SWEEPING_EDGE_PLUS') }, {}, 'MOVE_AERIAL_ACE')).toBe(101)
  })

  it('a non-slice, non-Grass move: 70', () => {
    expect(accuracyWith({ abilities: ability('ABILITY_SWEEPING_EDGE_PLUS') }, {}, FEMUR)).toBe(70)
  })

  it('Chestnut Axe grants KEEN_EDGE to any Grass move: 101 (abilities.cc:11988-11995)', () => {
    // MOVE_ABSORB is Grass and non-slice; the effective move type is Grass.
    expect(accuracyWith({ abilities: ability('ABILITY_SWEEPING_EDGE_PLUS', 'ABILITY_CHESTNUT_AXE') }, {}, 'MOVE_ABSORB')).toBe(101)
  })
})

// ---------------------------------------------------------------------------
// 7. isStrikerMove directly (battle_util.c:9377, abilities.cc:358-388)
// ---------------------------------------------------------------------------

describe('cycle 102 - isStrikerMove', () => {
  const deps = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

  it('static kickBased flag', () => {
    const state = battle([{}, {}], scriptedRng([]))
    expect(isStrikerMove(state, 0, 'MOVE_LOW_KICK', deps)).toBe(true)
    expect(isStrikerMove(state, 0, 'MOVE_TACKLE', deps)).toBe(false)
  })

  it('Junshi Sanda: punchBased moves only', () => {
    const state = battle([{ abilities: ability('ABILITY_JUNSHI_SANDA') }, {}], scriptedRng([]))
    expect(isStrikerMove(state, 0, 'MOVE_MEGA_PUNCH', deps)).toBe(true)
    expect(isStrikerMove(state, 0, 'MOVE_TACKLE', deps)).toBe(false)
  })

  it('Mixed Martial Arts: Normal-type moves only', () => {
    const state = battle([{ abilities: ability('ABILITY_MIXED_MARTIAL_ARTS') }, {}], scriptedRng([]))
    expect(isStrikerMove(state, 0, 'MOVE_TACKLE', deps)).toBe(true)
    expect(isStrikerMove(state, 0, 'MOVE_EMBER', deps)).toBe(false)
  })

  it('Backstreet Boy: dance moves only', () => {
    const state = battle([{ abilities: ability('ABILITY_BACKSTREET_BOY') }, {}], scriptedRng([]))
    expect(isStrikerMove(state, 0, 'MOVE_AQUA_STEP', deps)).toBe(true)
    expect(isStrikerMove(state, 0, 'MOVE_TACKLE', deps)).toBe(false)
  })

  it('an unknown move id is not a striker move', () => {
    const state = battle([{}, {}], scriptedRng([]))
    expect(isStrikerMove(state, 0, 'MOVE_DOES_NOT_EXIST', deps)).toBe(false)
  })
})
