// Move-effect ports checked against the C: recharge (battle_script_commands.c:2813-2819, battle_util.c:3294-3304,
// battle_main.c:4494-4497), Close Combat / Superpower, Fake Out, Sucker Punch, drain, Brick Break, Explosion,
// Mind Blown, Steel Beam and the crash-on-miss moves.

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
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPDEF,
  STATUS1_SLEEP,
  STATUS2_RECHARGE,
  STATUS3_HEAL_BLOCK,
  hasFlag,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')

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

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: move.priority ?? 0,
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

function testDeps(damage: DamageResolver = fixedDamage(20), replacement?: ReplacementDeps, grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

describe('Close Combat / Superpower (MOVE_EFFECT_DEF_SPDEF_DOWN / MOVE_EFFECT_ATK_DEF_DOWN)', () => {
  it('Close Combat drops the user Def and SpDef by 1', () => {
    const state = battle([{ moves: slot('MOVE_CLOSE_COMBAT'), pp: pps }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_CLOSE_COMBAT')), null], testDeps(fixedDamage(30)))
    expect(state.battlers[1]?.mon.hp).toBe(70)
    expect(state.battlers[0]?.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]?.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('Bad Company blocks the Close Combat drops (battle_script_commands.c:2844)', () => {
    const state = battle([{ moves: slot('MOVE_CLOSE_COMBAT'), pp: pps, abilities: hasAbility('ABILITY_BAD_COMPANY') }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_CLOSE_COMBAT')), null], testDeps(fixedDamage(30)))
    expect(state.battlers[0]?.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]?.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('Superpower drops Atk and Def by 1, and Bad Company does not gate it (:2840-2842)', () => {
    const state = battle([{ moves: slot('MOVE_SUPERPOWER'), pp: pps, abilities: hasAbility('ABILITY_BAD_COMPANY') }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_SUPERPOWER')), null], testDeps(fixedDamage(30)))
    expect(state.battlers[0]?.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]?.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
  })
})

describe('Recharge (Hyper Beam)', () => {
  it('forces one cancelled turn, then the user acts again', () => {
    const state = battle([{ moves: slot('MOVE_HYPER_BEAM', 'MOVE_TACKLE'), pp: pps }, {}], countingRng())
    const deps = testDeps(fixedDamage(10))
    executeTurn(state, [useMove(1, move('MOVE_HYPER_BEAM')), null], deps)
    expect(state.battlers[1]?.mon.hp).toBe(90)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_RECHARGE)).toBe(true)
    expect(state.battlers[0]?.volatiles.rechargeTimer).toBe(1)

    const turn2 = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], deps)
    expect(turn2.actions[0]?.cancelledBy).toBe('RECHARGE')
    expect(state.battlers[1]?.mon.hp).toBe(90)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_RECHARGE)).toBe(false)

    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], deps)
    expect(state.battlers[1]?.mon.hp).toBe(80)
  })

  it('a miss does not set the recharge', () => {
    const state = battle([{ moves: slot('MOVE_HYPER_BEAM'), pp: pps }, {}], scriptedRng(Array<number>(64).fill(99)))
    state.battlers[0]!.mon.statStages[STAT_ACC] = 0
    executeTurn(state, [useMove(1, move('MOVE_HYPER_BEAM')), null], testDeps(fixedDamage(10)))
    expect(state.battlers[1]?.mon.hp).toBe(100)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_RECHARGE)).toBe(false)
  })
})

describe('Fake Out', () => {
  it('flinches a slower target on the first turn, then fails', () => {
    const state = battle([{ moves: slot('MOVE_FAKE_OUT'), pp: pps }, { moves: slot('MOVE_TACKLE'), pp: pps }], countingRng())
    const deps = testDeps(fixedDamage(10))
    const turn1 = executeTurn(state, [useMove(1, move('MOVE_FAKE_OUT')), useMove(0, move('MOVE_TACKLE'))], deps)
    expect(state.battlers[1]?.mon.hp).toBe(90)
    expect(turn1.actions[1]?.cancelledBy).toBe('FLINCH')
    expect(state.battlers[0]?.mon.hp).toBe(100)

    const turn2 = executeTurn(state, [useMove(1, move('MOVE_FAKE_OUT')), useMove(0, move('MOVE_TACKLE'))], deps)
    expect(turn2.actions[0]?.missed).toBe(true)
    expect(state.battlers[1]?.mon.hp).toBe(90)
    expect(turn2.actions[1]?.cancelledBy).toBeNull()
    expect(state.battlers[0]?.mon.hp).toBe(90)
  })
})

describe('Sucker Punch', () => {
  it('hits a target that chose an attack and has not moved', () => {
    const state = battle([{ moves: slot('MOVE_SUCKER_PUNCH'), pp: pps }, { moves: slot('MOVE_TACKLE'), pp: pps }], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_SUCKER_PUNCH')), useMove(0, move('MOVE_TACKLE'))], testDeps(fixedDamage(10)))
    expect(state.battlers[1]?.mon.hp).toBe(90)
  })

  it('fails against a target that chose a status move (battle_script_commands.c:7217)', () => {
    const state = battle([{ moves: slot('MOVE_SUCKER_PUNCH'), pp: pps }, { moves: slot('MOVE_SWORDS_DANCE'), pp: pps }], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_SUCKER_PUNCH')), useMove(0, move('MOVE_SWORDS_DANCE'))], testDeps(fixedDamage(10)))
    expect(state.battlers[1]?.mon.hp).toBe(100)
  })
})

describe('Drain (EFFECT_ABSORB, DMG_TO_HP_FROM_MOVE)', () => {
  const bigRoot: GroundingContext = { ...GROUNDING, holdEffectOf: (id: number) => (id === 0 ? 'HOLD_EFFECT_BIG_ROOT' : null) }

  it('heals half the damage dealt', () => {
    const state = battle([{ hp: 50, moves: slot('MOVE_GIGA_DRAIN'), pp: pps }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_GIGA_DRAIN')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[0]?.mon.hp).toBe(70)
  })

  it('Big Root raises the heal by 3/2 (GetDrainedBigRootHp)', () => {
    const state = battle([{ hp: 50, moves: slot('MOVE_GIGA_DRAIN'), pp: pps }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_GIGA_DRAIN')), null], testDeps(fixedDamage(40), undefined, bigRoot))
    expect(state.battlers[0]?.mon.hp).toBe(80)
  })

  it('Liquid Ooze turns the heal into damage to the user', () => {
    const state = battle([{ hp: 50, moves: slot('MOVE_GIGA_DRAIN'), pp: pps }, { abilities: hasAbility('ABILITY_LIQUID_OOZE') }], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_GIGA_DRAIN')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[0]?.mon.hp).toBe(30)
  })

  it('does nothing while healing is blocked (CanBattlerHeal)', () => {
    const state = battle([{ hp: 50, moves: slot('MOVE_GIGA_DRAIN'), pp: pps }, {}], countingRng())
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    executeTurn(state, [useMove(1, move('MOVE_GIGA_DRAIN')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[0]?.mon.hp).toBe(50)
  })

  it('Dream Eater fails on an awake target and drains a sleeping one', () => {
    const awake = battle([{ hp: 50, moves: slot('MOVE_DREAM_EATER'), pp: pps }, {}], countingRng())
    executeTurn(awake, [useMove(1, move('MOVE_DREAM_EATER')), null], testDeps(fixedDamage(40)))
    expect(awake.battlers[1]?.mon.hp).toBe(100)
    expect(awake.battlers[0]?.mon.hp).toBe(50)

    const asleep = battle([{ hp: 50, moves: slot('MOVE_DREAM_EATER'), pp: pps }, { status1: STATUS1_SLEEP }], countingRng())
    executeTurn(asleep, [useMove(1, move('MOVE_DREAM_EATER')), null], testDeps(fixedDamage(40)))
    expect(asleep.battlers[1]?.mon.hp).toBe(60)
    expect(asleep.battlers[0]?.mon.hp).toBe(70)
  })
})

describe('Brick Break (Cmd_removelightscreenreflect)', () => {
  it('removes Reflect and Light Screen and their timers from the target side', () => {
    const state = battle([{ moves: slot('MOVE_BRICK_BREAK'), pp: pps }, {}], countingRng())
    const side = state.sides[1]
    side.statuses |= SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN
    side.timers.reflectTimer = 5
    side.timers.lightscreenTimer = 5
    executeTurn(state, [useMove(1, move('MOVE_BRICK_BREAK')), null], testDeps(fixedDamage(10)))
    expect(side.statuses & (SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN)).toBe(0)
    expect(side.timers.reflectTimer).toBe(0)
    expect(side.timers.lightscreenTimer).toBe(0)
  })
})

describe('Explosion (BattleScript_EffectExplosion)', () => {
  it('the user faints on a hit', () => {
    const state = battle([{ moves: slot('MOVE_EXPLOSION'), pp: pps }, {}], countingRng())
    const turn = executeTurn(state, [useMove(1, move('MOVE_EXPLOSION')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[1]?.mon.hp).toBe(60)
    expect(state.battlers[0]?.mon.hp).toBe(0)
    expect(turn.actions[0]?.fainted).toContain(0)
  })

  it('the user still faints on a miss, because the faint precedes the accuracy check', () => {
    const state = battle([{ moves: slot('MOVE_EXPLOSION'), pp: pps }, {}], scriptedRng(Array<number>(64).fill(99)))
    state.battlers[0]!.mon.statStages[STAT_ACC] = 0
    executeTurn(state, [useMove(1, move('MOVE_EXPLOSION')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[1]?.mon.hp).toBe(100)
    expect(state.battlers[0]?.mon.hp).toBe(0)
  })

  it('Damp on the field stops it (Cmd_faintifabilitynotdamp)', () => {
    const state = battle([{ moves: slot('MOVE_EXPLOSION'), pp: pps }, { abilities: hasAbility('ABILITY_DAMP') }], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_EXPLOSION')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[1]?.mon.hp).toBe(100)
    expect(state.battlers[0]?.mon.hp).toBe(100)
  })
})

describe('Steel Beam and Mind Blown', () => {
  it('Steel Beam costs half the user max HP after hitting', () => {
    const state = battle([{ moves: slot('MOVE_STEEL_BEAM'), pp: pps }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_STEEL_BEAM')), null], testDeps(fixedDamage(30)))
    expect(state.battlers[1]?.mon.hp).toBe(70)
    expect(state.battlers[0]?.mon.hp).toBe(50)
  })

  it('Steel Beam costs the HP on a miss too, but not with Magic Guard', () => {
    const missed = battle([{ moves: slot('MOVE_STEEL_BEAM'), pp: pps }, {}], scriptedRng(Array<number>(64).fill(99)))
    missed.battlers[0]!.mon.statStages[STAT_ACC] = 0
    executeTurn(missed, [useMove(1, move('MOVE_STEEL_BEAM')), null], testDeps(fixedDamage(30)))
    expect(missed.battlers[1]?.mon.hp).toBe(100)
    expect(missed.battlers[0]?.mon.hp).toBe(50)

    const guarded = battle([{ moves: slot('MOVE_STEEL_BEAM'), pp: pps, abilities: hasAbility('ABILITY_MAGIC_GUARD') }, {}], scriptedRng(Array<number>(64).fill(99)))
    guarded.battlers[0]!.mon.statStages[STAT_ACC] = 0
    executeTurn(guarded, [useMove(1, move('MOVE_STEEL_BEAM')), null], testDeps(fixedDamage(30)))
    expect(guarded.battlers[0]?.mon.hp).toBe(100)
  })

  it('Mind Blown costs half the max HP up front, even when it misses', () => {
    const state = battle([{ moves: slot('MOVE_MIND_BLOWN'), pp: pps }, {}], scriptedRng(Array<number>(64).fill(99)))
    state.battlers[0]!.mon.statStages[STAT_ACC] = 0
    executeTurn(state, [useMove(1, move('MOVE_MIND_BLOWN')), null], testDeps(fixedDamage(30)))
    expect(state.battlers[1]?.mon.hp).toBe(100)
    expect(state.battlers[0]?.mon.hp).toBe(50)
  })

  it('Mind Blown fails with Damp on the field', () => {
    const state = battle([{ moves: slot('MOVE_MIND_BLOWN'), pp: pps }, { abilities: hasAbility('ABILITY_DAMP') }], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_MIND_BLOWN')), null], testDeps(fixedDamage(30)))
    expect(state.battlers[1]?.mon.hp).toBe(100)
    expect(state.battlers[0]?.mon.hp).toBe(100)
  })
})

describe('High Jump Kick (EFFECT_RECOIL_IF_MISS)', () => {
  it('crashes for half the user max HP on a miss, and Magic Guard prevents it', () => {
    const missed = battle([{ moves: slot('MOVE_HIGH_JUMP_KICK'), pp: pps }, {}], scriptedRng(Array<number>(64).fill(99)))
    missed.battlers[0]!.mon.statStages[STAT_ACC] = 0
    executeTurn(missed, [useMove(1, move('MOVE_HIGH_JUMP_KICK')), null], testDeps(fixedDamage(30)))
    expect(missed.battlers[0]?.mon.hp).toBe(50)

    const guarded = battle([{ moves: slot('MOVE_HIGH_JUMP_KICK'), pp: pps, abilities: hasAbility('ABILITY_MAGIC_GUARD') }, {}], scriptedRng(Array<number>(64).fill(99)))
    guarded.battlers[0]!.mon.statStages[STAT_ACC] = 0
    executeTurn(guarded, [useMove(1, move('MOVE_HIGH_JUMP_KICK')), null], testDeps(fixedDamage(30)))
    expect(guarded.battlers[0]?.mon.hp).toBe(100)
  })
})

describe('Confusion self-hit (CANCELLER_CONFUSED, battle_util.c:3368-3399)', () => {
  const selfHit = (damage: number): DamageResolver => ({
    ...fixedDamage(30),
    confusionSelfHit: () => ({ damage, unmodelled: [] }),
  })

  it('removes the damage from the confused user and cancels its move when the 1-in-3 roll hits', () => {
    const state = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, {}], scriptedRng([0, 0, 0, 0]))
    state.battlers[0]!.mon.status2 |= 3 << 0 // STATUS2_CONFUSION counter 3 -> 2 on this move
    const turn = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(selfHit(21)))
    expect(turn.actions[0]?.cancelledBy).toBe('CONFUSION')
    expect(state.battlers[0]?.mon.hp).toBe(79)
    expect(state.battlers[1]?.mon.hp).toBe(100)
  })

  it('the user faints when the self-hit is lethal', () => {
    const state = battle([{ hp: 10, moves: slot('MOVE_TACKLE'), pp: pps }, {}], scriptedRng([0, 0, 0, 0]))
    state.battlers[0]!.mon.status2 |= 3 << 0
    const turn = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(selfHit(21)))
    expect(state.battlers[0]?.mon.hp).toBe(0)
    expect(turn.actions[0]?.fainted).toContain(0)
  })

  it('does nothing and acts normally on a failed roll', () => {
    const state = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, {}], scriptedRng([1, 0, 0, 0]))
    state.battlers[0]!.mon.status2 |= 3 << 0
    const turn = executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(selfHit(21)))
    expect(turn.actions[0]?.cancelledBy).toBeNull()
    expect(state.battlers[0]?.mon.hp).toBe(100)
  })
})
