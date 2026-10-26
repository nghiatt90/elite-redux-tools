// Secondary move effect ports checked against the C SetMoveEffect cases
// (battle_script_commands.c:2721-2750, 2823-2826, 3001-3063):
// Curse, Attract, Wrap, Prevent Escape, Yawn, Drench, Stealth Rock,
// Creeping Thorns, Spikes, Leech Seed, Sticky Web.

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
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'
import {
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  STAT_ACC,
  STATUS1_PARALYSIS,
  STATUS2_CURSED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_INFATUATION,
  STATUS2_WRAPPED,
  STATUS3_LEECHSEED,
  STATUS3_LEECHSEED_BATTLER,
  STATUS3_YAWN,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  hasFlag,
  statusInfatuatedWith,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const rawBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json')
const moveBehaviors = rawBehaviors.behaviors

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
    pp: m.pp as number,
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
  species: () => undefined,
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

function battle(
  specs: {
    spe?: number
    atk?: number
    def?: number
    spatk?: number
    spdef?: number
    hp?: number
    maxHp?: number
    speciesId?: string
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    types?: [string, string, string]
    itemId?: string | null
    gender?: SimBattleMon['gender']
    status1?: number
    status2?: number
  }[],
  rng: RandomSource,
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
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ?? [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
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

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  replacement?: ReplacementDeps,
  grounding: GroundingContext = GROUNDING,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
    moveBehaviors,
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

describe('MOVE_EFFECT_WRAP (Wrap, battle_script_commands.c:2733-2750, :2300-2309)', () => {
  it('Wrap inflicts STATUS2_WRAPPED and sets wrapTurns to 4 on roll 0 (3 left once ENDTURN_WRAP has run)', () => {
    // rolls: 0 (acc check hits), 0 (chance passes), 0 (WrapDuration: 4 + (0 % 2) = 4)
    const state = battle([{ moves: slot('MOVE_WRAP'), pp: pps }, {}], scriptedRng([0, 0, 0]))
    const res = executeTurn(state, [useMove(1, move('MOVE_WRAP')), null], testDeps(fixedDamage(25)))
    expect(res.actions[0]?.statusApplied?.status).toBe('WRAP')
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    // WrapDuration 4, then ENDTURN_WRAP's --wrapTurns (battle_util.c:2663) in the same turn.
    expect(state.battlers[1]!.volatiles.wrapTurns).toBe(3)
    expect(state.wrappedBy[1]).toBe(0)
    expect(state.wrappedMove[1]).toBe('MOVE_WRAP')
  })

  it('Grip Claw extends Wrap duration to 7 turns (5 + 2)', () => {
    const clawGrounding: GroundingContext = {
      ...GROUNDING,
      holdEffectOf: (id) => (id === 0 ? 'HOLD_EFFECT_GRIP_CLAW' : null),
    }
    const state = battle([{ moves: slot('MOVE_WRAP'), pp: pps }, {}], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, move('MOVE_WRAP')), null], testDeps(fixedDamage(25), undefined, clawGrounding))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(true)
    // 5 + 2 for Grip Claw, minus ENDTURN_WRAP's decrement.
    expect(state.battlers[1]!.volatiles.wrapTurns).toBe(6)
  })

  it('is blocked by C gate: already wrapped target does not overwrite wrapTurns', () => {
    const state = battle([{ moves: slot('MOVE_WRAP'), pp: pps }, { status2: STATUS2_WRAPPED }], scriptedRng([0, 0]))
    state.battlers[1]!.volatiles.wrapTurns = 3
    executeTurn(state, [useMove(1, move('MOVE_WRAP')), null], testDeps(fixedDamage(25)))
    // Untouched by the move; only ENDTURN_WRAP's decrement applies.
    expect(state.battlers[1]!.volatiles.wrapTurns).toBe(2)
  })

  it('negative case: accuracy miss does not wrap target', () => {
    const state = battle([{ moves: slot('MOVE_WRAP'), pp: pps }, {}], scriptedRng([99]))
    state.battlers[0]!.mon.statStages[STAT_ACC] = 0
    const res = executeTurn(state, [useMove(1, move('MOVE_WRAP')), null], testDeps(fixedDamage(25)))
    expect(res.actions[0]?.missed).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_WRAPPED)).toBe(false)
    expect(state.battlers[1]!.volatiles.wrapTurns).toBe(0)
  })
})

describe('MOVE_EFFECT_PREVENT_ESCAPE (Anchor Shot / Pitfall, battle_script_commands.c:2823-2826)', () => {
  it('Anchor Shot (100% chance) applies STATUS2_ESCAPE_PREVENTION and sets battlerPreventingEscape', () => {
    const state = battle([{ moves: slot('MOVE_ANCHOR_SHOT'), pp: pps }, {}], countingRng())
    const res = executeTurn(state, [useMove(1, move('MOVE_ANCHOR_SHOT')), null], testDeps(fixedDamage(30)))
    expect(res.actions[0]?.statusApplied?.status).toBe('ESCAPE_PREVENTION')
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
    expect(state.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)
  })

  it('is blocked by C gate: Shield Dust on target blocks the secondary effect', () => {
    const state = battle([{ moves: slot('MOVE_ANCHOR_SHOT'), pp: pps }, { abilities: hasAbility('ABILITY_SHIELD_DUST') }], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_ANCHOR_SHOT')), null], testDeps(fixedDamage(30)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
  })

  it('negative case: Pitfall (30% chance) fails when chance roll >= 30', () => {
    // roll: 0 (accuracy check hits), 50 (50 % 100 = 50 >= 30, chance fails)
    const state = battle([{ moves: slot('MOVE_PITFALL'), pp: pps }, {}], scriptedRng([0, 50]))
    executeTurn(state, [useMove(1, move('MOVE_PITFALL')), null], testDeps(fixedDamage(30)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
  })
})

describe('MOVE_EFFECT_ATTRACT (Cupid Shot, battle_script_commands.c:2727-2732, battle_util.c:5135-5143)', () => {
  it('Cupid Shot (20% chance) applies infatuation when roll < 20', () => {
    // roll: 0 (acc hits), 0 (0 < 20, chance passes)
    const state = battle([{ moves: slot('MOVE_CUPID_SHOT'), pp: pps }, {}], scriptedRng([0, 0]))
    const res = executeTurn(state, [useMove(1, move('MOVE_CUPID_SHOT')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied?.status).toBe('INFATUATION')
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status2, statusInfatuatedWith(0))).toBe(true)
  })

  it('is blocked by C gate: target with Oblivious is immune to infatuation', () => {
    const state = battle([{ moves: slot('MOVE_CUPID_SHOT'), pp: pps }, { abilities: hasAbility('ABILITY_OBLIVIOUS') }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, move('MOVE_CUPID_SHOT')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(false)
  })

  it('negative case: chance roll >= 20 does not infatuate', () => {
    const state = battle([{ moves: slot('MOVE_CUPID_SHOT'), pp: pps }, {}], scriptedRng([0, 50]))
    executeTurn(state, [useMove(1, move('MOVE_CUPID_SHOT')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(false)
  })
})

describe('MOVE_EFFECT_CURSE (Requiem, battle_script_commands.c:2721-2726)', () => {
  it('Requiem (10% chance) applies STATUS2_CURSED when roll < 10', () => {
    // roll: 0 (acc hits), 0 (0 < 10, chance passes)
    const state = battle([{ moves: slot('MOVE_REQUIEM'), pp: pps }, {}], scriptedRng([0, 0]))
    const res = executeTurn(state, [useMove(1, move('MOVE_REQUIEM')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied?.status).toBe('CURSE')
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
  })

  it('is blocked by C gate: target already cursed does not re-curse', () => {
    const state = battle([{ moves: slot('MOVE_REQUIEM'), pp: pps }, { status2: STATUS2_CURSED }], scriptedRng([0, 0]))
    const res = executeTurn(state, [useMove(1, move('MOVE_REQUIEM')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied).toBeNull()
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
  })

  it('negative case: chance roll >= 10 does not curse', () => {
    const state = battle([{ moves: slot('MOVE_REQUIEM'), pp: pps }, {}], scriptedRng([0, 50]))
    executeTurn(state, [useMove(1, move('MOVE_REQUIEM')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
  })
})

describe('MOVE_EFFECT_YAWN (Bonk, battle_script_commands.c:3001-3005, :11840-11855)', () => {
  it('Bonk (50% chance) applies STATUS3_YAWN with counter 2 when roll < 50', () => {
    // roll: 0 (acc hits), 0 (0 < 50, chance passes)
    const state = battle([{ moves: slot('MOVE_BONK'), pp: pps }, {}], scriptedRng([0, 0]))
    const res = executeTurn(state, [useMove(1, move('MOVE_BONK')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied?.status).toBe('YAWN')
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(true)
  })

  it('is blocked by C gate: Electric Terrain prevents drowsiness from Yawn', () => {
    const state = battle([{ moves: slot('MOVE_BONK'), pp: pps }, {}], scriptedRng([0, 0]))
    state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    executeTurn(state, [useMove(1, move('MOVE_BONK')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(false)
  })

  it('is blocked by C gate: Insomnia prevents sleep / drowsiness', () => {
    const state = battle([{ moves: slot('MOVE_BONK'), pp: pps }, { abilities: hasAbility('ABILITY_INSOMNIA') }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, move('MOVE_BONK')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(false)
  })

  it('is blocked by C gate: target with primary status (paralysis) cannot be made drowsy', () => {
    const state = battle([{ moves: slot('MOVE_BONK'), pp: pps }, { status1: STATUS1_PARALYSIS }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, move('MOVE_BONK')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(false)
  })

  it('negative case: chance roll >= 50 does not apply drowsiness', () => {
    const state = battle([{ moves: slot('MOVE_BONK'), pp: pps }, {}], scriptedRng([0, 80]))
    executeTurn(state, [useMove(1, move('MOVE_BONK')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_YAWN)).toBe(false)
  })
})

describe('MOVE_EFFECT_DRENCH (Hydro Pump, battle_script_commands.c:3031-3036)', () => {
  it('Hydro Pump (30% chance) applies Drench (2 turns on duration roll 0)', () => {
    // rolls: 0 (acc hits), 0 (0 < 30, chance passes), 0 (duration: 2 + (0 % 2) = 2)
    const state = battle([{ moves: slot('MOVE_HYDRO_PUMP'), pp: pps }, {}], scriptedRng([0, 0, 0]))
    const res = executeTurn(state, [useMove(1, move('MOVE_HYDRO_PUMP')), null], testDeps(fixedDamage(40)))
    expect(res.actions[0]?.statusApplied?.status).toBe('DRENCH')
    expect(state.battlers[1]!.volatiles.drenched).toBe(2)
    expect(state.battlers[1]!.volatiles.started.drenched).toBe(true)
  })

  it('is blocked by C gate: a Water-type target cannot be drenched', () => {
    const state = battle([{ moves: slot('MOVE_HYDRO_PUMP'), pp: pps }, { types: ['WATER', 'MYSTERY', 'MYSTERY'] }], scriptedRng([0, 0, 0]))
    executeTurn(state, [useMove(1, move('MOVE_HYDRO_PUMP')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[1]!.volatiles.drenched).toBe(0)
  })

  it('negative case: chance roll >= 30 does not apply Drench', () => {
    const state = battle([{ moves: slot('MOVE_HYDRO_PUMP'), pp: pps }, {}], scriptedRng([0, 50]))
    executeTurn(state, [useMove(1, move('MOVE_HYDRO_PUMP')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[1]!.volatiles.drenched).toBe(0)
  })
})

describe('MOVE_EFFECT_STEALTH_ROCK (Stone Axe, battle_script_commands.c:3037-3044)', () => {
  it('Stone Axe (100% chance) sets Stealth Rock on target side with type Rock (5)', () => {
    const state = battle([{ moves: slot('MOVE_STONE_AXE'), pp: pps }, {}], countingRng())
    const res = executeTurn(state, [useMove(1, move('MOVE_STONE_AXE')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied?.status).toBe('STEALTH_ROCK')
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(state.sides[1].timers.stealthRockType).toBe(5)
  })

  it('is blocked by C gate: side already has Stealth Rock', () => {
    const state = battle([{ moves: slot('MOVE_STONE_AXE'), pp: pps }, {}], countingRng())
    state.sides[1].statuses |= SIDE_STATUS_STEALTH_ROCK
    state.sides[1].timers.stealthRockType = 12 // Pre-existing Grass hazard
    executeTurn(state, [useMove(1, move('MOVE_STONE_AXE')), null], testDeps(fixedDamage(20)))
    expect(state.sides[1].timers.stealthRockType).toBe(12) // Unchanged
  })

  it('negative case: 0 damage (immunity) does not set Stealth Rock', () => {
    const state = battle([{ moves: slot('MOVE_STONE_AXE'), pp: pps }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_STONE_AXE')), null], testDeps(fixedDamage(0)))
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
  })
})

describe('MOVE_EFFECT_CREEPING_THORNS (Needle Arm, battle_script_commands.c:3037-3044)', () => {
  it('Needle Arm (100% chance) sets Stealth Rock on target side with type Grass (12)', () => {
    const state = battle([{ moves: slot('MOVE_NEEDLE_ARM'), pp: pps }, {}], countingRng())
    const res = executeTurn(state, [useMove(1, move('MOVE_NEEDLE_ARM')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied?.status).toBe('CREEPING_THORNS')
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(state.sides[1].timers.stealthRockType).toBe(12)
  })

  it('is blocked by C gate: side already has Stealth Rock', () => {
    const state = battle([{ moves: slot('MOVE_NEEDLE_ARM'), pp: pps }, {}], countingRng())
    state.sides[1].statuses |= SIDE_STATUS_STEALTH_ROCK
    state.sides[1].timers.stealthRockType = 5
    executeTurn(state, [useMove(1, move('MOVE_NEEDLE_ARM')), null], testDeps(fixedDamage(20)))
    expect(state.sides[1].timers.stealthRockType).toBe(5)
  })

  it('negative case: 0 damage (immunity) does not set Creeping Thorns', () => {
    const state = battle([{ moves: slot('MOVE_NEEDLE_ARM'), pp: pps }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_NEEDLE_ARM')), null], testDeps(fixedDamage(0)))
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
  })
})

describe('MOVE_EFFECT_SPIKES (Ceaseless Edge, battle_script_commands.c:3045-3050)', () => {
  it('Ceaseless Edge (100% chance) sets Spikes layer 1 on target side', () => {
    const state = battle([{ moves: slot('MOVE_CEASELESS_EDGE'), pp: pps }, {}], countingRng())
    const res = executeTurn(state, [useMove(1, move('MOVE_CEASELESS_EDGE')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied?.status).toBe('SPIKES')
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(state.sides[1].timers.spikesAmount).toBe(1)
  })

  it('increments Spikes depth on subsequent hits up to 3', () => {
    const state = battle([{ moves: slot('MOVE_CEASELESS_EDGE'), pp: pps }, {}], countingRng())
    state.sides[1].statuses |= SIDE_STATUS_SPIKES
    state.sides[1].timers.spikesAmount = 2
    executeTurn(state, [useMove(1, move('MOVE_CEASELESS_EDGE')), null], testDeps(fixedDamage(20)))
    expect(state.sides[1].timers.spikesAmount).toBe(3)
  })

  it('is blocked by C gate: does not increment beyond 3 layers', () => {
    const state = battle([{ moves: slot('MOVE_CEASELESS_EDGE'), pp: pps }, {}], countingRng())
    state.sides[1].statuses |= SIDE_STATUS_SPIKES
    state.sides[1].timers.spikesAmount = 3
    executeTurn(state, [useMove(1, move('MOVE_CEASELESS_EDGE')), null], testDeps(fixedDamage(20)))
    expect(state.sides[1].timers.spikesAmount).toBe(3)
  })

  it('negative case: 0 damage (immunity) does not set Spikes', () => {
    const state = battle([{ moves: slot('MOVE_CEASELESS_EDGE'), pp: pps }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_CEASELESS_EDGE')), null], testDeps(fixedDamage(0)))
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(state.sides[1].timers.spikesAmount).toBe(0)
  })
})

describe('MOVE_EFFECT_LEECH_SEED (Bramble Blast, battle_script_commands.c:3051-3057)', () => {
  it('Bramble Blast (30% chance) seeds a Grass-type target (C quirk: target must be Grass or attacker has Mycelium Might)', () => {
    // Grass target:
    const state = battle([{ moves: slot('MOVE_BRAMBLE_BLAST'), pp: pps }, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] }], scriptedRng([0, 0]))
    const res = executeTurn(state, [useMove(1, move('MOVE_BRAMBLE_BLAST')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied?.status).toBe('LEECH_SEED')
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
    expect(state.battlers[1]!.statuses3 & STATUS3_LEECHSEED_BATTLER).toBe(0)
  })

  it('seeds a non-Grass target when attacker has Mycelium Might', () => {
    const state = battle(
      [{ moves: slot('MOVE_BRAMBLE_BLAST'), pp: pps, abilities: hasAbility('ABILITY_MYCELIUM_MIGHT') }, { types: ['WATER', 'MYSTERY', 'MYSTERY'] }],
      scriptedRng([0, 0]),
    )
    executeTurn(state, [useMove(1, move('MOVE_BRAMBLE_BLAST')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
  })

  it('is blocked by C gate: non-Grass target when attacker lacks Mycelium Might is not seeded', () => {
    const state = battle([{ moves: slot('MOVE_BRAMBLE_BLAST'), pp: pps }, { types: ['WATER', 'MYSTERY', 'MYSTERY'] }], scriptedRng([0, 0]))
    executeTurn(state, [useMove(1, move('MOVE_BRAMBLE_BLAST')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
  })

  it('negative case: chance roll >= 30 does not apply Leech Seed', () => {
    const state = battle([{ moves: slot('MOVE_BRAMBLE_BLAST'), pp: pps }, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] }], scriptedRng([0, 50]))
    executeTurn(state, [useMove(1, move('MOVE_BRAMBLE_BLAST')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
  })
})

describe('MOVE_EFFECT_STICKY_WEB (Web Shot, battle_script_commands.c:3058-3063)', () => {
  it('Web Shot (100% chance) sets Sticky Web on target side', () => {
    const state = battle([{ moves: slot('MOVE_WEB_SHOT'), pp: pps }, {}], countingRng())
    const res = executeTurn(state, [useMove(1, move('MOVE_WEB_SHOT')), null], testDeps(fixedDamage(20)))
    expect(res.actions[0]?.statusApplied?.status).toBe('STICKY_WEB')
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
  })

  it('is blocked by C gate: side already has Sticky Web', () => {
    const state = battle([{ moves: slot('MOVE_WEB_SHOT'), pp: pps }, {}], countingRng())
    state.sides[1].statuses |= SIDE_STATUS_STICKY_WEB
    executeTurn(state, [useMove(1, move('MOVE_WEB_SHOT')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
  })

  it('negative case: 0 damage (immunity) does not set Sticky Web', () => {
    const state = battle([{ moves: slot('MOVE_WEB_SHOT'), pp: pps }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_WEB_SHOT')), null], testDeps(fixedDamage(0)))
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STICKY_WEB)).toBe(false)
  })
})
