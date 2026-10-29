/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 105a -- verification pins for the onPriority family (11 abilities), the
// priority dispatch's suppression predicate, and the three onModifyTargetFlag
// abilities (plus every alias).
//
// C references (repo-relative, pinned upstream):
// - GetMovePriority, pipeline/.upstream/eliteredux-source/src/battle_main.c:4257-4292.
// - ON_ABILITY, pipeline/.upstream/eliteredux-source/include/battle_util.h:269-275:
//   slots iterate HIGHEST index first, and checkMoldBreaker=FALSE disables ONLY the
//   Mold Breaker branch of IsSuppressed (battle_util.c:9254-9261) -- Gastro Acid /
//   Neutralizing Gas still suppress. DoesBattlerHaveAbilityShield (:6539) is the
//   Ability Shield item + STATUS3_EMBARGO; no snapshot ability has
//   `blocksAbilitySuppression`, so the item check is the whole thing.
// - GALE_WINGS_CLONE, src/abilities.cc:126-131; Prankster :2244; Opportunist :4665;
//   Perfectionist :3833; Blitz Boxer :3725; Temporal Rupture :10043; Triage :2803.
// - IsHealingMoveEffect, src/battle_util.c:8880-8903.
// - GetBattlerBattleMoveTargetFlags, src/battle_util.c:128-149. ON_ABILITY is the
//   same macro; all three onModifyTargetFlag hooks return MOVE_TARGET_BOTH and all
//   three gate on `gBattleMoves[move].target == SELECTED || RANDOM`.
// - IsMegaLauncherBoosted / IsIronFistBoosted / IsSoundMove / IsKeenEdge,
//   src/battle_util.c:9373-9381 -> DoesMoveMatchFlag, src/abilities.cc:358-388
//   (static flag first, then ability-granted flags via onModifyMoveFlags).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { MoveData } from '../calculate'
import type { TypeChart } from '../typeEffectiveness'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import {
  NEUTRAL_TURN_ORDER_CONTEXT,
  getMovePriority,
} from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { buildAccuracyInputs } from './accuracyBridge'
import { getTotalAccuracy } from './accuracy'
import { createBridgeDamageResolver } from './damageResolver'
import { computeAbilityPriorityBonus } from '../abilities/dispatchPriority'
import { resolveEffectiveMoveType } from '../abilities/dispatchCalc'
import { getBattlerBattleMoveTargetFlags } from './moveTargetFlags'
import { STAT_ATK, STATUS3_EMBARGO, STATUS3_GASTRO_ACID } from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- snapshot-backed, the same shape cycle102Accuracy.test.ts uses.
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

/** The damage engine's own MoveData shape, converted the way damageResolver.test.ts does. */
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

const STATUS_DEPS = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

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
  hp?: number
  maxHp?: number
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  itemId?: string | null
}

function battle(specs: BattlerSpec[], rng: RandomSource = scriptedRng([])): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          itemId: s.itemId ?? null,
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

function view(moveData: SimMoveData, overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
  return {
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
    ...overrides,
  }
}

function useMove(target: number, moveData: SimMoveData, overrides: Partial<TurnOrderMoveView> = {}): ChosenAction {
  const v = view(moveData, overrides)
  return { action: 'USE_MOVE', moveToBeUsed: v, chosenMove: v, target }
}

function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

/** A TurnLoopDeps whose resolver is the real combat resolver (needed by the
 * accuracy bridge's type-effectiveness lookup). */
function realDeps(rng: RandomSource = scriptedRng([])): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const damage: DamageResolver = createBridgeDamageResolver({
    grounding: GROUNDING,
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
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
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

function simpleDeps(): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage: fixedDamage(1),
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string | null, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})

// ---------------------------------------------------------------------------
// 1. GetMovePriority ordering (battle_main.c:4257-4292)
// ---------------------------------------------------------------------------

describe('cycle 105a - GetMovePriority order', () => {
  it('Quash short-circuits the ON_ABILITY sum: Prankster cannot rescue a quashed status move', () => {
    // :4262 `if (gFieldTimers.quashTimer) return min(-4, priority);` runs BEFORE
    // the ability sum at :4264. Swords Dance is declared 0, so the answer is -4.
    const state = battle([{ abilities: ability('ABILITY_PRANKSTER') }, {}])
    state.field.timers.quashTimer = 1
    expect(getMovePriority(state, 0, view(move('MOVE_SWORDS_DANCE')), 0)).toBe(-4)
  })

  it('On The Prowl applies AFTER the ability sum and reads the declared priority', () => {
    // :4284-4289 tests `gBattleMoves[move].priority`, not the running total.
    // Roar of Time is declared -6: Temporal Rupture cancels it to 0 (:4264), then
    // On The Prowl sees the DECLARED -6 and does `priority -= -6` -> 6. A port
    // that re-read the running total would produce 1 instead.
    const state = battle([{ abilities: ability('ABILITY_TEMPORAL_RUPTURE') }, {}])
    const roar = view(move('MOVE_ROAR_OF_TIME'))
    expect(getMovePriority(state, 0, roar, 1)).toBe(0)
    state.battlers[0]!.volatiles.onTheProwl = true
    expect(getMovePriority(state, 0, roar, 1)).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// 2. The 11 ported onPriority abilities, through getMovePriority
// ---------------------------------------------------------------------------

describe('cycle 105a - the Gale Wings family (GALE_WINGS_CLONE, abilities.cc:126-131)', () => {
  const family: [string, string][] = [
    ['ABILITY_GALE_WINGS', 'FLYING'],
    ['ABILITY_WATER_GALE_WINGS', 'WATER'],
    ['ABILITY_FLAMING_SOUL', 'FIRE'],
    ['ABILITY_VOLT_RUSH', 'ELECTRIC'],
    ['ABILITY_EARLY_GRAVE', 'GHOST'],
  ]

  it.each(family)('%s: +1 on its own resolved type at full HP, 0 otherwise', (id, type) => {
    const state = battle([{ abilities: ability(id) }, {}])
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE'), { resolvedType: type }), 1)).toBe(1)
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE'), { resolvedType: 'GROUND' }), 1)).toBe(0)

    // BATTLER_MAX_HP is hp == maxHP exactly (include/battle.h:749): 99/100 fails.
    state.battlers[0]!.mon.hp = 99
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE'), { resolvedType: type }), 1)).toBe(0)
  })

  it('reads the RESOLVED type: Aerilate turns Normal Tackle into Flying', () => {
    // GetTypeBeforeUsingMove(move, battler) includes onMoveType abilities. Tackle
    // is declared NORMAL; Aerilate resolves it to FLYING, so Gale Wings fires.
    const state = battle([{ abilities: ability('ABILITY_GALE_WINGS', 'ABILITY_AERILATE') }, {}])
    const tacke = move('MOVE_TACKLE')
    const resolved = resolveEffectiveMoveType(state.battlers[0]!.mon.abilities, 'MOVE_TACKLE', 'NORMAL', tacke.flags).moveType
    expect(resolved).toBe('FLYING')
    expect(getMovePriority(state, 0, view(tacke, { resolvedType: resolved }), 1)).toBe(1)
    // Aerilate only rewrites Normal moves; Ember stays Fire and misses the gate.
    expect(
      getMovePriority(state, 0, view(move('MOVE_EMBER'), { resolvedType: 'FIRE' }), 1),
    ).toBe(0)
  })
})

describe('cycle 105a - Prankster (abilities.cc:2244)', () => {
  it('+1 for a status move; 0 for a damaging move; no HP gate', () => {
    const state = battle([{ abilities: ability('ABILITY_PRANKSTER') }, {}])
    expect(getMovePriority(state, 0, view(move('MOVE_SWORDS_DANCE')), 0)).toBe(1)
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), 1)).toBe(0)
    state.battlers[0]!.mon.hp = 1
    expect(getMovePriority(state, 0, view(move('MOVE_SWORDS_DANCE')), 0)).toBe(1)
  })
})

describe('cycle 105a - Opportunist (abilities.cc:4665)', () => {
  it('fires at exactly floor(maxHP/2) and not one point above', () => {
    const state = battle([{ abilities: ability('ABILITY_OPPORTUNIST') }, {}])
    state.battlers[1]!.mon.maxHp = 100
    state.battlers[1]!.mon.hp = 50
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), 1)).toBe(1)
    state.battlers[1]!.mon.hp = 51
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), 1)).toBe(0)
  })

  it('rounds the threshold DOWN on an odd max HP (C integer division)', () => {
    const state = battle([{ abilities: ability('ABILITY_OPPORTUNIST') }, {}])
    state.battlers[1]!.mon.maxHp = 101
    state.battlers[1]!.mon.hp = 50
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), 1)).toBe(1)
    state.battlers[1]!.mon.hp = 51
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), 1)).toBe(0)
  })

  it('reads GetFullChosenTarget verbatim -- the action target, not the move data target', () => {
    // GetFullChosenTarget's ordinary case returns gBattleStruct->moveTarget[battler]
    // (battle_util.c:173), i.e. the controller-stored target; GetMoveTarget's
    // self/spread re-resolution only happens later, in HandleAction_UseMove
    // (:216-242). The sim's `action.target` is that stored value. So a
    // self-targeting move is NOT automatically read against its holder: here
    // Swords Dance with target 1 reads battler 1's half HP, and with target 0
    // reads the full-HP holder for 0.
    const state = battle([
      { abilities: ability('ABILITY_OPPORTUNIST') },
      { hp: 50, maxHp: 100 },
    ])
    expect(getMovePriority(state, 0, view(move('MOVE_SWORDS_DANCE')), 1)).toBe(1)
    expect(getMovePriority(state, 0, view(move('MOVE_SWORDS_DANCE')), 0)).toBe(0)
    // No resolved target (sim-only null): the C always has a u8 battler id, so 0
    // is the safe non-invention rather than silently reading battler 0.
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), null)).toBe(0)
  })
})

describe('cycle 105a - Perfectionist onPriority (abilities.cc:3833)', () => {
  it('+1 for 0 < power <= 25, 0 at 26, 0 for a 0-power status move', () => {
    const state = battle([{ abilities: ability('ABILITY_PERFECTIONIST') }, {}])
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE'), { power: 25 }), 1)).toBe(1)
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE'), { power: 26 }), 1)).toBe(0)
    expect(getMovePriority(state, 0, view(move('MOVE_SWORDS_DANCE')), 0)).toBe(0)
  })
})

describe('cycle 105a - Blitz Boxer (abilities.cc:3725)', () => {
  it('+1 only for an Iron Fist (punch) move at full HP', () => {
    const state = battle([{ abilities: ability('ABILITY_BLITZ_BOXER') }, {}])
    expect(getMovePriority(state, 0, view(move('MOVE_THUNDER_PUNCH')), 1)).toBe(1)
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), 1)).toBe(0)
    state.battlers[0]!.mon.hp = 99
    expect(getMovePriority(state, 0, view(move('MOVE_THUNDER_PUNCH')), 1)).toBe(0)
  })

  it('a non-punch move stays 0 even when it is a contact slice move', () => {
    // IsIronFistBoosted is DoesMoveMatchFlag(..., MOVE_FLAG_PUNCH): the static
    // `punchBased` flag is what a slab of moves has; Dragon Claw is contact +
    // sliceBased, neither of which is FLAG_IRON_FIST_BOOST.
    const state = battle([{ abilities: ability('ABILITY_BLITZ_BOXER') }, {}])
    expect(getMovePriority(state, 0, view(move('MOVE_DRAGON_CLAW')), 1)).toBe(0)
  })
})

describe('cycle 105a - Temporal Rupture (abilities.cc:10043)', () => {
  it('cancels Roar of Time own -6 to 0; other moves unaffected', () => {
    const state = battle([{ abilities: ability('ABILITY_TEMPORAL_RUPTURE') }, {}])
    expect(getMovePriority(state, 0, view(move('MOVE_ROAR_OF_TIME')), 1)).toBe(0)
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), 1)).toBe(0)
  })
})

describe('cycle 105a - Triage (abilities.cc:2803 -> IsHealingMoveEffect)', () => {
  // The full effect list, entry by entry, from battle_util.c:8880-8903.
  const HEALING_EFFECTS = [
    'EFFECT_ABSORB',
    'EFFECT_MORNING_SUN',
    'EFFECT_MOONLIGHT',
    'EFFECT_RESTORE_HP',
    'EFFECT_REST',
    'EFFECT_ROOST',
    'EFFECT_WISH',
    'EFFECT_HEALING_WISH',
    'EFFECT_REVIVAL_BLESSING',
    'EFFECT_SOFTBOILED',
    'EFFECT_SYNTHESIS',
    'EFFECT_SHORE_UP',
    'EFFECT_JUNGLE_HEALING',
    'EFFECT_HEAL_PULSE',
    'EFFECT_MATCHA_GOTCHA',
    'EFFECT_STRENGTH_SAP',
    'EFFECT_DRAIN_BRAIN',
    'EFFECT_PARTY_FAVORS',
  ]

  it.each(HEALING_EFFECTS)('%s gets +3', (effect) => {
    const state = battle([{ abilities: ability('ABILITY_TRIAGE') }, {}])
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE'), { effect, power: 0, split: 'STATUS' }), 0)).toBe(3)
  })

  it('+3 on a real healing move regardless of split; 0 on a non-healing move', () => {
    const state = battle([{ abilities: ability('ABILITY_TRIAGE') }, {}])
    // Recover (EFFECT_RESTORE_HP, STATUS) and Giga Drain (EFFECT_ABSORB, SPECIAL).
    expect(getMovePriority(state, 0, view(move('MOVE_RECOVER')), 0)).toBe(3)
    expect(getMovePriority(state, 0, view(move('MOVE_GIGA_DRAIN')), 1)).toBe(3)
    expect(getMovePriority(state, 0, view(move('MOVE_SWORDS_DANCE')), 0)).toBe(0)
    expect(getMovePriority(state, 0, view(move('MOVE_TACKLE')), 1)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The dispatch's suppression predicate (battle_util.c:9254-9261)
// ---------------------------------------------------------------------------

describe('cycle 105a - computeAbilityPriorityBonus honours isSuppressed', () => {
  const base = {
    battlerId: '0',
    holderSlots: { ability: 'ABILITY_PRANKSTER', innates: [null, null, null] as [null, null, null] },
    moveId: 'MOVE_SWORDS_DANCE',
    moveEffect: 'EFFECT_ATTACK_UP_2',
    moveType: 'NORMAL',
    movePower: 0,
    movePriority: 0,
    moveSplit: 'STATUS' as const,
    moveFlags: {},
    holderHp: 100,
    holderMaxHp: 100,
    targetHp: 100,
    targetMaxHp: 100,
  }

  it('sums the hook when the holder is not suppressed', () => {
    expect(computeAbilityPriorityBonus({ ...base, isSuppressed: () => false })).toBe(1)
  })

  it('drops the hook when IsSuppressed is true -- FALSE only means "no Mold Breaker"', () => {
    expect(computeAbilityPriorityBonus({ ...base, isSuppressed: () => true })).toBe(0)
  })
})

describe('cycle 105a - priority suppression through getMovePriority', () => {
  it('Gastro Acid suppresses Prankster', () => {
    const state = battle([{ abilities: ability('ABILITY_PRANKSTER') }, {}])
    const swords = view(move('MOVE_SWORDS_DANCE'))
    expect(getMovePriority(state, 0, swords, 0)).toBe(1)
    state.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(getMovePriority(state, 0, swords, 0)).toBe(0)
  })

  it('Ability Shield restores the suppressed ability, unless STATUS3_EMBARGO is set', () => {
    // DoesBattlerHaveAbilityShield (battle_util.c:6539-6544): item check plus
    // `!(gStatuses3[battler] & STATUS3_EMBARGO)`.
    const state = battle([{ abilities: ability('ABILITY_PRANKSTER'), itemId: 'ITEM_ABILITY_SHIELD' }, {}])
    const swords = view(move('MOVE_SWORDS_DANCE'))
    state.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(getMovePriority(state, 0, swords, 0)).toBe(1)
    state.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    expect(getMovePriority(state, 0, swords, 0)).toBe(0)
  })

  it('Neutralizing Gas suppresses every priority ability on the field', () => {
    const state = battle([{ abilities: ability('ABILITY_PRANKSTER') }, {}])
    const swords = view(move('MOVE_SWORDS_DANCE'))
    state.field.timers.neutralizingGas = true
    expect(getMovePriority(state, 0, swords, 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. End-to-end turn order (executeTurn)
// ---------------------------------------------------------------------------

describe('cycle 105a - a priority bonus actually reorders the turn', () => {
  it('a slower Prankster user moves before a faster attacker', () => {
    // Battler 0: speed 50, Prankster, Swords Dance (declared 0 -> 1).
    // Battler 1: speed 200, Tackle (declared 0). Priority beats speed.
    const state = battle(
      [
        { spe: 50, abilities: ability('ABILITY_PRANKSTER'), moves: slot('MOVE_SWORDS_DANCE'), pp: pps },
        { spe: 200, moves: slot('MOVE_TACKLE') },
      ],
      scriptedRng([]),
    )
    const out = executeTurn(
      state,
      [useMove(0, move('MOVE_SWORDS_DANCE')), useMove(0, move('MOVE_TACKLE'))],
      simpleDeps(),
    )
    expect(out.order.battlerByTurnOrder).toEqual([0, 1])
    expect(out.actions.map((a) => a.battlerId)).toEqual([0, 1])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8) // one Swords Dance: +2 stages from 6
  })

  it('negative: when the Gale Wings HP gate fails, the faster battler moves first', () => {
    // Same speeds, but the holder is at 99/100 so BATTLER_MAX_HP fails and
    // Aerial Ace (declared FLYING, the view's resolvedType) gets no bonus.
    const state = battle(
      [
        { spe: 50, hp: 99, maxHp: 100, abilities: ability('ABILITY_GALE_WINGS'), moves: slot('MOVE_AERIAL_ACE'), pp: pps },
        { spe: 200, moves: slot('MOVE_TACKLE') },
      ],
      scriptedRng([]),
    )
    const out = executeTurn(
      state,
      [useMove(1, move('MOVE_AERIAL_ACE')), useMove(0, move('MOVE_TACKLE'))],
      simpleDeps(),
    )
    expect(out.order.battlerByTurnOrder).toEqual([1, 0])
    expect(out.actions.map((a) => a.battlerId)).toEqual([1, 0])
  })
})

// ---------------------------------------------------------------------------
// 5. GetBattlerBattleMoveTargetFlags (battle_util.c:128-149)
// ---------------------------------------------------------------------------

function targetFlags(state: BattleState, moveId: string): string {
  return getBattlerBattleMoveTargetFlags(state, 0, moveId, DATA_CONTEXT.move(moveId), STATUS_DEPS, STATUS_DEPS)
}

describe('cycle 105a - Amplifier family (abilities.cc:4792-4799; aliases Bass Boosted, Wind Chimes)', () => {
  it.each(['ABILITY_AMPLIFIER', 'ABILITY_BASS_BOOSTED', 'ABILITY_WIND_CHIMES'])('%s widens a sound move to BOTH', (id) => {
    const state = battle([{ abilities: ability(id) }, {}])
    // Bug Buzz is MOVE_TARGET_SELECTED with the static sound flag.
    expect(targetFlags(state, 'MOVE_BUG_BUZZ')).toBe('BOTH')
    // Tackle has neither the sound flag nor any ability that grants it.
    expect(targetFlags(state, 'MOVE_TACKLE')).toBe('SELECTED')
  })

  it('does not touch a move whose data target is already BOTH or USER', () => {
    const state = battle([{ abilities: ability('ABILITY_AMPLIFIER') }, {}])
    // Hyper Voice is already BOTH; Swords Dance is USER. The hook's own
    // SELECTED||RANDOM guard leaves both alone, and so does the final target read.
    expect(targetFlags(state, 'MOVE_HYPER_VOICE')).toBe('BOTH')
    expect(targetFlags(state, 'MOVE_SWORDS_DANCE')).toBe('USER')
  })

  it('the guard also accepts MOVE_TARGET_RANDOM (Uproar)', () => {
    const state = battle([{ abilities: ability('ABILITY_AMPLIFIER') }, {}])
    expect(targetFlags(state, 'MOVE_UPROAR')).toBe('BOTH')
  })

  it('a mon without the ability leaves the move SELECTED', () => {
    const state = battle([{}, {}])
    expect(targetFlags(state, 'MOVE_BUG_BUZZ')).toBe('SELECTED')
  })

  it('two of the hooks on one mon still answer BOTH (ON_ABILITY first-nonzero cannot differ)', () => {
    // Parting Shot is SELECTED with BOTH the sound and bulletBased flags, so
    // Artillery and Amplifier each fire. ON_ABILITY walks the slots in reverse
    // (battle_util.h:269-275) and returns the first nonzero; every one of the
    // three hooks returns MOVE_TARGET_BOTH, so slot order is unobservable.
    const state = battle([{ abilities: ability('ABILITY_ARTILLERY', 'ABILITY_AMPLIFIER') }, {}])
    expect(targetFlags(state, 'MOVE_PARTING_SHOT')).toBe('BOTH')
    const control = battle([{}, {}])
    expect(targetFlags(control, 'MOVE_PARTING_SHOT')).toBe('SELECTED')
  })
})

describe('cycle 105a - Artillery family (abilities.cc:4802-4809; alias Super Scope)', () => {
  it.each(['ABILITY_ARTILLERY', 'ABILITY_SUPER_SCOPE'])('%s widens a bullet move to BOTH', (id) => {
    const state = battle([{ abilities: ability(id) }, {}])
    // Rock Blast has FLAG_MEGA_LAUNCHER_BOOST (bulletBased).
    expect(targetFlags(state, 'MOVE_ROCK_BLAST')).toBe('BOTH')
    expect(targetFlags(state, 'MOVE_BUG_BUZZ')).toBe('SELECTED')
  })

  it('sees Gunman granting MOVE_FLAG_MEGA_LAUNCHER to a status move (abilities.cc:9535-9540)', () => {
    // DoesMoveMatchFlag falls back to onModifyMoveFlags. Gunman returns TRUE for
    // every status move, so Artillery + Gunman widens Sing (SELECTED, no bullet
    // or sound flag).
    const state = battle([{ abilities: ability('ABILITY_ARTILLERY', 'ABILITY_GUNMAN') }, {}])
    expect(targetFlags(state, 'MOVE_SING')).toBe('BOTH')
    // Without Gunman, Sing stays SELECTED.
    const control = battle([{ abilities: ability('ABILITY_ARTILLERY') }, {}])
    expect(targetFlags(control, 'MOVE_SING')).toBe('SELECTED')
  })
})

describe('cycle 105a - Sweeping Edge family (abilities.cc:5341-5351; alias Sweeping Edge Plus)', () => {
  it.each(['ABILITY_SWEEPING_EDGE', 'ABILITY_SWEEPING_EDGE_PLUS'])('%s widens a keen-edge move to BOTH', (id) => {
    const state = battle([{ abilities: ability(id) }, {}])
    // Leaf Blade has the static sliceBased flag.
    expect(targetFlags(state, 'MOVE_LEAF_BLADE')).toBe('BOTH')
    expect(targetFlags(state, 'MOVE_TACKLE')).toBe('SELECTED')
  })

  it('sees Chestnut Axe granting KEEN_EDGE to a declared Grass move', () => {
    const state = battle([{ abilities: ability('ABILITY_SWEEPING_EDGE', 'ABILITY_CHESTNUT_AXE') }, {}])
    // Absorb is a declared Grass move without the static slice flag.
    expect(targetFlags(state, 'MOVE_ABSORB')).toBe('BOTH')
  })

  it('tests Chestnut Axe against the RESOLVED type (GetTypeBeforeUsingMove)', () => {
    // Tackle is declared NORMAL; Fertilize resolves it to GRASS, so
    // IsKeenEdge(battler, move, GetTypeBeforeUsingMove(...)) is true and
    // Sweeping Edge widens it. A declared-type check would answer SELECTED.
    const state = battle([{ abilities: ability('ABILITY_SWEEPING_EDGE', 'ABILITY_CHESTNUT_AXE', 'ABILITY_FERTILIZE') }, {}])
    const tackle = move('MOVE_TACKLE')
    const resolved = resolveEffectiveMoveType(state.battlers[0]!.mon.abilities, 'MOVE_TACKLE', 'NORMAL', tackle.flags).moveType
    expect(resolved).toBe('GRASS')
    expect(targetFlags(state, 'MOVE_TACKLE')).toBe('BOTH')
    // Control: without the type-changer it stays a Normal move.
    const control = battle([{ abilities: ability('ABILITY_SWEEPING_EDGE', 'ABILITY_CHESTNUT_AXE') }, {}])
    expect(targetFlags(control, 'MOVE_TACKLE')).toBe('SELECTED')
  })
})

describe('cycle 105a - target-flag suppression and Ole consequence', () => {
  it('Gastro Acid suppresses the onModifyTargetFlag ability (ON_ABILITY FALSE)', () => {
    const state = battle([{ abilities: ability('ABILITY_AMPLIFIER') }, {}])
    expect(targetFlags(state, 'MOVE_BUG_BUZZ')).toBe('BOTH')
    state.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(targetFlags(state, 'MOVE_BUG_BUZZ')).toBe('SELECTED')
  })

  it('a SELECTED->BOTH widening makes Ole skip its 0.8x cut: 100 vs 80', () => {
    // Ole (abilities.cc:7556-7570) multiplies accuracy by .8 only for
    // SELECTED/USER_OR_SELECTED/RANDOM. Without Sweeping Edge, Leaf Blade (100)
    // becomes trunc(100 * .8) = 80; with it, the target flag is BOTH and Ole
    // returns ACCURACY_NO_RESULT, leaving the final 100 reported as 101 (the
    // engine's "cannot miss" sentinel, as in cycle102's No Guard cases).
    const plain = battle([{}, { abilities: ability('ABILITY_OLE') }])
    const plainBuilt = buildAccuracyInputs(plain, 0, 1, 'MOVE_LEAF_BLADE', false, realDeps())
    expect(plainBuilt.inputs.moveTarget).toBe('SELECTED')
    expect(getTotalAccuracy(plainBuilt.inputs).accuracy).toBe(80)

    const widened = battle([{ abilities: ability('ABILITY_SWEEPING_EDGE') }, { abilities: ability('ABILITY_OLE') }])
    const widenedBuilt = buildAccuracyInputs(widened, 0, 1, 'MOVE_LEAF_BLADE', false, realDeps())
    expect(widenedBuilt.inputs.moveTarget).toBe('BOTH')
    expect(getTotalAccuracy(widenedBuilt.inputs).accuracy).toBe(101)
  })
})
