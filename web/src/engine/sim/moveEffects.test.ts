// Unit tests for move effect dispatch and self stat-raise moves (step 5, batch 1).
//
// Every test case is hand-derived from the C source code at the pinned upstream SHA:
// - BattleScript_EffectStatUp (data/battle_scripts_1.s:3612-3631)
// - ChangeStatBuffs / ChangeStatBuffsImplicit (src/battle_script_commands.c:9709-9955)
// - BattleScript_EffectBellyDrum (data/battle_scripts_1.s:5592-5604, battle_script_commands.c:11338-11354)
// - BattleScript_EffectGrowth (data/battle_scripts_1.s:1912-1946)
// - BattleScript_EffectShellSmash (data/battle_scripts_1.s:1800-1846)
// - BattleScript_EffectSharpen (data/battle_scripts_1.s:12008-12046)
// - BattleScript_EffectShelter (data/battle_scripts_1.s:11940-11977)
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
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
  STATUS4_CUTTHROAT,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import {
  B_MSG_DEFENDER_STAT_FELL,
  B_MSG_STAT_WONT_DECREASE,
  B_MSG_STAT_WONT_INCREASE,
  MOVE_EFFECT_AFFECTS_USER,
  STAT_BUFF_ALLOW_PTR,
  STAT_DROP_BLOCK_ABILITIES,
  changeStatBuffs,
} from './statBuffs'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const rawAbilityHooks = snapshot<Record<string, { hooks?: Record<string, unknown> }>>('abilityHooks.json')

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

function requireItem(id: string): SimItemData {
  const item = itemsById.get(id)
  if (!item) throw new Error(`items.json has no ${id}`)
  return item
}

// Fail loudly at module load if any ID is missing or renamed in data snapshots
const MOVE_SWORDS_DANCE = requireMove('MOVE_SWORDS_DANCE')
const MOVE_TAIL_GLOW = requireMove('MOVE_TAIL_GLOW')
const MOVE_DRAGON_DANCE = requireMove('MOVE_DRAGON_DANCE')
const MOVE_QUIVER_DANCE = requireMove('MOVE_QUIVER_DANCE')
const MOVE_BULK_UP = requireMove('MOVE_BULK_UP')
const MOVE_SHELL_SMASH = requireMove('MOVE_SHELL_SMASH')
const MOVE_BELLY_DRUM = requireMove('MOVE_BELLY_DRUM')
const MOVE_GROWTH = requireMove('MOVE_GROWTH')
const MOVE_SHARPEN = requireMove('MOVE_SHARPEN')
const MOVE_SHELTER = requireMove('MOVE_SHELTER')
const MOVE_CONFUSE_RAY = requireMove('MOVE_CONFUSE_RAY')

const ABILITY_CONTRARY = requireAbility('ABILITY_CONTRARY')
const ABILITY_CLEAR_BODY = requireAbility('ABILITY_CLEAR_BODY')
const ABILITY_WHITE_SMOKE = requireAbility('ABILITY_WHITE_SMOKE')
const ABILITY_CHLOROPLAST = requireAbility('ABILITY_CHLOROPLAST')
const ABILITY_CUTTHROAT = requireAbility('ABILITY_CUTTHROAT')
const ABILITY_SIMPLE = requireAbility('ABILITY_SIMPLE')
const ABILITY_BIG_LEAVES = requireAbility('ABILITY_BIG_LEAVES')
const ABILITY_SOLAR_FLARE = requireAbility('ABILITY_SOLAR_FLARE')
const ABILITY_EDGELORD = requireAbility('ABILITY_EDGELORD')
const ABILITY_DESERT_CLOAK = requireAbility('ABILITY_DESERT_CLOAK')
const ABILITY_DUNE_VEIL = requireAbility('ABILITY_DUNE_VEIL')
const ABILITY_FLOWER_VEIL = requireAbility('ABILITY_FLOWER_VEIL')
const ABILITY_JUNGLES_GUARD = requireAbility('ABILITY_JUNGLES_GUARD')

const ITEM_UTILITY_UMBRELLA = requireItem('ITEM_UTILITY_UMBRELLA')

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
    spe?: number
    atk?: number
    spatk?: number
    hp?: number
    maxHp?: number
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
          // The foe defaults slower so turn order needs no speed-tie draw (GetWhoStrikesFirst, battle_main.c:4397).
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: s.spatk ?? 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
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

describe('Move effect dispatch: 18 self stat-raise moves', () => {
  it('Swords Dance draws NO RNG: RNG draw count is 0, PP deducted, Atk raised +2', () => {
    const rng = countingRng()
    const state = battle([{ moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [30, 0, 0, 0] }, {}], rng)
    const dmg = dummyDamage()

    const out = executeTurn(state, [useMove(1, MOVE_SWORDS_DANCE), null], testDeps(dmg))

    // In C (BattleScript_EffectStatUp): no accuracycheck command is called.
    // RNG draws must be 0 (unlike damaging/unhandled moves which draw accuracy).
    expect(rng.calls).toBe(0)
    expect(dmg.calls).toBe(0)

    const action = out.actions.find((a) => a.battlerId === 0)!
    expect(action.missed).toBe(false)
    expect(action.targetId).toBe(0) // Finding 5: gBattlerTarget is user for MOVE_TARGET_USER (src/battle_util.c:239-242, 6403-6405)
    expect(action.targetDamage).toBeNull()
    expect(action.attackerDamage).toBeNull()
    expect(action.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 2 }])

    // State mutations: PP reduced from 30 to 29, Atk stage raised from neutral (6) to 8.
    expect(state.battlers[0]!.mon.pp[0]).toBe(29)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
  })

  it('Stat-up amounts: +2 (Swords Dance), +3 (Tail Glow), multi-stat (Dragon Dance, Quiver Dance, Bulk Up)', () => {
    // Tail Glow: +3 SpAtk
    {
      const state = battle([{ moves: ['MOVE_TAIL_GLOW', null, null, null] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_TAIL_GLOW), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPATK, change: 3 }])
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(9)
    }

    // Dragon Dance: +1 Atk, +1 Speed
    {
      const state = battle([{ moves: ['MOVE_DRAGON_DANCE', null, null, null] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_DRAGON_DANCE), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 1 },
        { battlerId: 0, stat: STAT_SPEED, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
    }

    // Quiver Dance: +1 SpAtk, +1 SpDef, +1 Speed
    {
      const state = battle([{ moves: ['MOVE_QUIVER_DANCE', null, null, null] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_QUIVER_DANCE), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_SPATK, change: 1 },
        { battlerId: 0, stat: STAT_SPDEF, change: 1 },
        { battlerId: 0, stat: STAT_SPEED, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
    }

    // Bulk Up: +1 Atk, +1 Def
    {
      const state = battle([{ moves: ['MOVE_BULK_UP', null, null, null] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_BULK_UP), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 1 },
        { battlerId: 0, stat: STAT_DEF, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
    }
  })

  it('Clamping at 12 and failure branch when already maxed (PP still deducted)', () => {
    // Stage at 11 + Swords Dance (+2) clamps to 12 (+1 delta)
    {
      const state = battle([{ moves: ['MOVE_SWORDS_DANCE', null, null, null] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_ATK] = 11
      const out = executeTurn(state, [useMove(1, MOVE_SWORDS_DANCE), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
    }

    // Stage already at 12: ChangeStatBuffs returns 0, statChanges is empty, PP still deducted!
    {
      const state = battle([{ moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [30, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_SWORDS_DANCE), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
      // BattleScript_EffectStatUp runs ppreduce BEFORE statbuffchange, so PP is deducted even on fail
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
    }

    // Dragon Dance when both Atk and Speed are 12: fail branch, PP deducted
    {
      const state = battle([{ moves: ['MOVE_DRAGON_DANCE', null, null, null], pp: [20, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
      state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_DRAGON_DANCE), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([])
      expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    }
  })

  it('Contrary inverts stat changes: +2 becomes -2 and clamps at 0', () => {
    // Swords Dance with Contrary: 6 - 2 = 4
    {
      const state = battle(
        [
          {
            moves: ['MOVE_SWORDS_DANCE', null, null, null],
            abilities: { ability: ABILITY_CONTRARY, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_SWORDS_DANCE), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: -2 }])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(4)
    }

    // Clamping at MIN_STAT_STAGE (0) under Contrary
    {
      const state = battle(
        [
          {
            moves: ['MOVE_SWORDS_DANCE', null, null, null],
            abilities: { ability: ABILITY_CONTRARY, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      state.battlers[0]!.mon.statStages[STAT_ATK] = 1
      const out = executeTurn(state, [useMove(1, MOVE_SWORDS_DANCE), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: -1 }])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    }
  })

  it('Simple doubles stat changes', () => {
    const state = battle(
      [
        {
          moves: ['MOVE_SWORDS_DANCE', null, null, null],
          abilities: { ability: ABILITY_SIMPLE, innates: [null, null, null] },
        },
        {},
      ],
      countingRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_SWORDS_DANCE), null], testDeps())
    // Simple doubles 2 to 4: 6 + 4 = 10
    expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 4 }])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(10)
  })

  it('Shell Smash mixed drop/raise: Clear Body blocks self-drops, White Smoke does NOT in ER', () => {
    // Normal battler: Def -1, SpDef -1, Atk +2, SpAtk +2, Spe +2
    {
      const state = battle([{ moves: ['MOVE_SHELL_SMASH', null, null, null] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_SHELL_SMASH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_DEF, change: -1 },
        { battlerId: 0, stat: STAT_SPDEF, change: -1 },
        { battlerId: 0, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_SPATK, change: 2 },
        { battlerId: 0, stat: STAT_SPEED, change: 2 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(5)
      expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(5)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
    }

    // Clear Body battler: Clear Body returns STAT_DROP_BLOCK_ALL unconditionally in ER (src/abilities.cc:852).
    // Self drops are BLOCKED! Raises still apply.
    {
      const state = battle(
        [
          {
            moves: ['MOVE_SHELL_SMASH', null, null, null],
            abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_SHELL_SMASH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_SPATK, change: 2 },
        { battlerId: 0, stat: STAT_SPEED, change: 2 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
    }

    // White Smoke battler: in ER (src/abilities.cc:1367), White Smoke sets smokescreen on entry
    // and does NOT block stat drops. Self drops are NOT blocked!
    {
      const state = battle(
        [
          {
            moves: ['MOVE_SHELL_SMASH', null, null, null],
            abilities: { ability: ABILITY_WHITE_SMOKE, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_SHELL_SMASH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_DEF, change: -1 },
        { battlerId: 0, stat: STAT_SPDEF, change: -1 },
        { battlerId: 0, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_SPATK, change: 2 },
        { battlerId: 0, stat: STAT_SPEED, change: 2 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(5)
      expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(5)
    }

    // Shell Smash under Contrary: drops become raises, raises become drops
    {
      const state = battle(
        [
          {
            moves: ['MOVE_SHELL_SMASH', null, null, null],
            abilities: { ability: ABILITY_CONTRARY, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_SHELL_SMASH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_DEF, change: 1 },
        { battlerId: 0, stat: STAT_SPDEF, change: 1 },
        { battlerId: 0, stat: STAT_ATK, change: -2 },
        { battlerId: 0, stat: STAT_SPATK, change: -2 },
        { battlerId: 0, stat: STAT_SPEED, change: -2 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(4)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(4)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(4)
    }
  })

  it('Belly Drum: costs 50% HP and maxes Atk; fails at <= half HP or if Atk already maxed', () => {
    // Success: 100/100 HP, halfHp = 50. 100 > 50 -> succeeds, loses 50 HP, Atk -> 12
    {
      const state = battle([{ moves: ['MOVE_BELLY_DRUM', null, null, null], hp: 100, maxHp: 100 }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_BELLY_DRUM), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 6 }])
      expect(out.actions.find((a) => a.battlerId === 0)!.attackerDamage).toBe(50)
      expect(state.battlers[0]!.mon.hp).toBe(50)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
      expect(state.battlers[0]!.mon.pp[0]).toBe(29)
    }

    // Fail: 50/100 HP. In C (battle_script_commands.c:11346), `hp > halfHp` is strict.
    // 50 > 50 is false -> fails! No HP lost, Atk unchanged, PP deducted.
    {
      const state = battle([{ moves: ['MOVE_BELLY_DRUM', null, null, null], hp: 50, maxHp: 100, pp: [10, 0, 0, 0] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_BELLY_DRUM), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([])
      expect(out.actions.find((a) => a.battlerId === 0)!.attackerDamage).toBeNull()
      expect(state.battlers[0]!.mon.hp).toBe(50)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[0]!.mon.pp[0]).toBe(9)
    }

    // Fail: Atk already at 12 (100/100 HP). ChangeStatBuffs returns 0 -> fails, no HP lost, PP deducted.
    {
      const state = battle([{ moves: ['MOVE_BELLY_DRUM', null, null, null], hp: 100, maxHp: 100, pp: [10, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_BELLY_DRUM), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([])
      expect(out.actions.find((a) => a.battlerId === 0)!.attackerDamage).toBeNull()
      expect(state.battlers[0]!.mon.hp).toBe(100)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MAX_STAT_STAGE)
      expect(state.battlers[0]!.mon.pp[0]).toBe(9)
    }

    // Belly Drum with Contrary: inverts 12 to -12, reducing Atk to 0 (-6 delta), costs 50 HP!
    {
      const state = battle(
        [
          {
            moves: ['MOVE_BELLY_DRUM', null, null, null],
            hp: 100,
            maxHp: 100,
            abilities: { ability: ABILITY_CONTRARY, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_BELLY_DRUM), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: -6 }])
      expect(out.actions.find((a) => a.battlerId === 0)!.attackerDamage).toBe(50)
      expect(state.battlers[0]!.mon.hp).toBe(50)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    }
  })

  it('Growth: +1/+1 in neutral weather, +2/+2 in sun or with chloroplast abilities, negated by Utility Umbrella', () => {
    // Neutral weather: +1 Atk, +1 SpAtk
    {
      const state = battle([{ moves: ['MOVE_GROWTH', null, null, null] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_GROWTH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 1 },
        { battlerId: 0, stat: STAT_SPATK, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    }

    // In Sun (WEATHER_SUN_TEMPORARY): +2 Atk, +2 SpAtk
    {
      const state = battle([{ moves: ['MOVE_GROWTH', null, null, null] }, {}], countingRng())
      state.field.weather = WEATHER_SUN_TEMPORARY
      const out = executeTurn(state, [useMove(1, MOVE_GROWTH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_SPATK, change: 2 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
    }

    // In Sun with ITEM_UTILITY_UMBRELLA: Utility Umbrella negates Sun for the holder, raises +1/+1 (Finding 3)
    {
      const state = battle([{ moves: ['MOVE_GROWTH', null, null, null] }, {}], countingRng())
      state.field.weather = WEATHER_SUN_TEMPORARY
      state.battlers[0]!.mon.itemId = ITEM_UTILITY_UMBRELLA.id
      const out = executeTurn(state, [useMove(1, MOVE_GROWTH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 1 },
        { battlerId: 0, stat: STAT_SPATK, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    }

    // Neutral weather with ABILITY_CHLOROPLAST: +2 Atk, +2 SpAtk
    {
      const state = battle(
        [
          {
            moves: ['MOVE_GROWTH', null, null, null],
            abilities: { ability: ABILITY_CHLOROPLAST, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_GROWTH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_SPATK, change: 2 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
    }

    // Neutral weather with ABILITY_BIG_LEAVES (chloroplast bitfield): +2 Atk, +2 SpAtk (Finding 3)
    {
      const state = battle(
        [
          {
            moves: ['MOVE_GROWTH', null, null, null],
            abilities: { ability: ABILITY_BIG_LEAVES, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_GROWTH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_SPATK, change: 2 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
    }

    // Neutral weather with ABILITY_SOLAR_FLARE (chloroplast bitfield): +2 Atk, +2 SpAtk (Finding 3)
    {
      const state = battle(
        [
          {
            moves: ['MOVE_GROWTH', null, null, null],
            abilities: { ability: ABILITY_SOLAR_FLARE, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_GROWTH), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([
        { battlerId: 0, stat: STAT_ATK, change: 2 },
        { battlerId: 0, stat: STAT_SPATK, change: 2 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
    }
  })

  it('Sharpen: raises highest attacking stat, boosts critBoost, and triggers Cutthroat', () => {
    // Physical attacker (Atk 120 > SpAtk 80): raises Atk +1, critBoost becomes 1
    {
      const state = battle([{ moves: ['MOVE_SHARPEN', null, null, null], atk: 120, spatk: 80 }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_SHARPEN), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
      expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
      expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(false)
    }

    // Special attacker (SpAtk 120 > Atk 80): raises SpAtk +1
    {
      const state = battle([{ moves: ['MOVE_SHARPEN', null, null, null], atk: 80, spatk: 120 }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_SHARPEN), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPATK, change: 1 }])
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
      expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
    }

    // With ABILITY_CUTTHROAT: raises stat, boosts critBoost, and grants STATUS4_CUTTHROAT
    {
      const state = battle(
        [
          {
            moves: ['MOVE_SHARPEN', null, null, null],
            abilities: { ability: ABILITY_CUTTHROAT, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_SHARPEN), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
      expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
      expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(true)
    }

    // With ABILITY_EDGELORD (cutthroat bitfield): raises stat, boosts critBoost, and grants STATUS4_CUTTHROAT (Finding 4)
    {
      const state = battle(
        [
          {
            moves: ['MOVE_SHARPEN', null, null, null],
            abilities: { ability: ABILITY_EDGELORD, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      const out = executeTurn(state, [useMove(1, MOVE_SHARPEN), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
      expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
      expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(true)
    }

    // When stat rose and crit is already 3: VARIOUS_INCREASE_CRIT jumps to MoveEnd, NO Cutthroat (Finding 4)
    {
      const state = battle(
        [
          {
            moves: ['MOVE_SHARPEN', null, null, null],
            abilities: { ability: ABILITY_CUTTHROAT, innates: [null, null, null] },
          },
          {},
        ],
        countingRng(),
      )
      state.battlers[0]!.volatiles.critBoost = 3
      const out = executeTurn(state, [useMove(1, MOVE_SHARPEN), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
      expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
      expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(false)
    }

    // Capping critBoost with min(3 - critBoost, 1): critBoost 2 becomes 3 (Finding 4)
    {
      const state = battle([{ moves: ['MOVE_SHARPEN', null, null, null] }, {}], countingRng())
      state.battlers[0]!.volatiles.critBoost = 2
      const out = executeTurn(state, [useMove(1, MOVE_SHARPEN), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_ATK, change: 1 }])
      expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
    }
  })

  it('Shelter: raises Def +2, fails if Def is 12', () => {
    // Normal: Def +2
    {
      const state = battle([{ moves: ['MOVE_SHELTER', null, null, null] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_SHELTER), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 2 }])
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(8)
    }

    // Def already 12: fails, PP deducted
    {
      const state = battle([{ moves: ['MOVE_SHELTER', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_SHELTER), null], testDeps())
      expect(out.actions.find((a) => a.battlerId === 0)!.statChanges).toEqual([])
      expect(state.battlers[0]!.mon.pp[0]).toBe(9)
    }
  })

  it('Unhandled status move still behaves exactly as before: accuracy roll drawn, statChanges is null', () => {
    const rng = countingRng()
    const state = battle([{ moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [10, 0, 0, 0] }, {}], rng)
    const dmg = dummyDamage()

    const out = executeTurn(state, [useMove(1, MOVE_CONFUSE_RAY), null], testDeps(dmg))

    // Unhandled status moves keep today's path: one accuracy draw, then the damage resolver.
    expect(rng.calls).toBe(1)
    expect(dmg.calls).toBe(1)

    const action = out.actions.find((a) => a.battlerId === 0)!
    expect(action.missed).toBe(false)
    expect(action.targetDamage).toBeNull()
    expect(action.attackerDamage).toBeNull()
    expect(action.statChanges).toBeNull() // null, not empty array: not handled by move effect dispatch
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
  })
})

describe('Fix brief findings: Stat drop block abilities, Protect branch, line 9942, and partner scan', () => {
  it('oracle test: STAT_DROP_BLOCK_ABILITIES matches abilityHooks.json hooks.onBlockStatDrops', () => {
    const abilitiesWithOnBlockStatDrops = Object.entries(rawAbilityHooks)
      .filter(([, entry]) => Boolean(entry.hooks?.onBlockStatDrops))
      .map(([id]) => id)
      .sort()

    expect([...STAT_DROP_BLOCK_ABILITIES].sort()).toEqual(abilitiesWithOnBlockStatDrops)
  })

  it('Desert Cloak and Dune Veil: block stat drops in Sandstorm, not in neutral weather', () => {
    for (const ability of [ABILITY_DESERT_CLOAK, ABILITY_DUNE_VEIL]) {
      // Neutral weather: drop applies
      {
        const state = battle(
          [
            { abilities: { ability, innates: [null, null, null] } },
            {},
          ],
          countingRng(),
        )
        const unmodelled: string[] = []
        const res = changeStatBuffs(
          state,
          0, // battlerId
          1, // attackerId
          0, // targetId
          -1, // initialStatValue
          STAT_DEF,
          0, // flags (!affectsUser)
          false,
          testDeps(),
          unmodelled,
        )
        expect(res.delta).toBe(-1)
        expect(res.multistringChooser).toBe(B_MSG_DEFENDER_STAT_FELL)
        expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(5)
      }

      // Sandstorm: drop blocked
      {
        const state = battle(
          [
            { abilities: { ability, innates: [null, null, null] } },
            {},
          ],
          countingRng(),
        )
        state.field.weather = WEATHER_SANDSTORM_TEMPORARY
        const unmodelled: string[] = []
        const res = changeStatBuffs(
          state,
          0,
          1,
          0,
          -1,
          STAT_DEF,
          0,
          false,
          testDeps(),
          unmodelled,
        )
        expect(res.delta).toBe(0)
        expect(res.multistringChooser).toBe(B_MSG_STAT_WONT_DECREASE)
        expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(6)
      }
    }
  })

  it("Flower Veil and Jungle's Guard: block stat drops for Grass types, not non-Grass", () => {
    for (const ability of [ABILITY_FLOWER_VEIL, ABILITY_JUNGLES_GUARD]) {
      // Non-Grass (Normal type): drop applies
      {
        const state = battle(
          [
            { abilities: { ability, innates: [null, null, null] } },
            {},
          ],
          countingRng(),
        )
        state.battlers[0]!.mon.types = ['NORMAL', 'MYSTERY', 'MYSTERY']
        const unmodelled: string[] = []
        const res = changeStatBuffs(
          state,
          0,
          1,
          0,
          -1,
          STAT_ATK,
          0,
          false,
          testDeps(),
          unmodelled,
        )
        expect(res.delta).toBe(-1)
        expect(res.multistringChooser).toBe(B_MSG_DEFENDER_STAT_FELL)
        expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(5)
      }

      // Grass type: drop blocked
      {
        const state = battle(
          [
            { abilities: { ability, innates: [null, null, null] } },
            {},
          ],
          countingRng(),
        )
        state.battlers[0]!.mon.types = ['GRASS', 'POISON', 'MYSTERY']
        const unmodelled: string[] = []
        const res = changeStatBuffs(
          state,
          0,
          1,
          0,
          -1,
          STAT_ATK,
          0,
          false,
          testDeps(),
          unmodelled,
        )
        expect(res.delta).toBe(0)
        expect(res.multistringChooser).toBe(B_MSG_STAT_WONT_DECREASE)
        expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(6)
      }
    }
  })

  it('Partner scan: pushed to unmodelled in doubles when partner exists and is alive, not in singles or when fainted', () => {
    // Singles: no partner exists (battler.id ^ 2 = 2 >= battlersCount = 2)
    {
      const state = battle([{}, {}], countingRng())
      const unmodelled: string[] = []
      changeStatBuffs(
        state,
        0,
        1,
        0,
        -1,
        STAT_DEF,
        0,
        false,
        testDeps(),
        unmodelled,
      )
      expect(unmodelled).toEqual([])
    }

    // Doubles: 4 battlers, partner (id 2) is alive
    {
      const state = createBattleState({
        battlers: [
          createBattlerState(0, mon(), 0),
          createBattlerState(1, mon(), 0),
          createBattlerState(2, mon(), 0),
          createBattlerState(3, mon(), 0),
        ],
        rng: countingRng(),
      })
      const unmodelled: string[] = []
      changeStatBuffs(
        state,
        0,
        1,
        0,
        -1,
        STAT_DEF,
        0,
        false,
        testDeps(),
        unmodelled,
      )
      expect(unmodelled).toContain('GetStatDropBlock partner scan (abilities.cc:447-458) is not modelled')
    }

    // Doubles: partner (id 2) is fainted (HP 0)
    {
      const state = createBattleState({
        battlers: [
          createBattlerState(0, mon(), 0),
          createBattlerState(1, mon(), 0),
          createBattlerState(2, mon({ hp: 0 }), 0),
          createBattlerState(3, mon(), 0),
        ],
        rng: countingRng(),
      })
      const unmodelled: string[] = []
      changeStatBuffs(
        state,
        0,
        1,
        0,
        -1,
        STAT_DEF,
        0,
        false,
        testDeps(),
        unmodelled,
      )
      expect(unmodelled).toEqual([])
    }
  })

  it('ChangeStatBuffs :9789 JumpIfMoveAffectedByProtect(0): MOVE_NONE ignores Protect, so the drop still applies; Detect is gapped', () => {
    // IsBattlerProtected(target, MOVE_NONE) (battle_util.c:6571-6645): MOVE_NONE carries ignoresProtect, so
    // evadesProtect is TRUE and Protect never blocks. Only Detect/Merculight could, via GetTotalAccuracy.
    if (!movesById.get('MOVE_NONE')?.flags || !(movesById.get('MOVE_NONE')!.flags as Record<string, unknown>).ignoresProtect) throw new Error('MOVE_NONE no longer ignoresProtect')
    const drop = (protectMove: string) => {
      const state = battle([{}, {}], countingRng())
      state.battlers[0]!.round.protectMove = protectMove
      const unmodelled: string[] = []
      const res = changeStatBuffs(state, 0, 1, 0, -1, STAT_DEF, 0, false, testDeps(), unmodelled, 'MOVE_SCREECH')
      return { res, unmodelled }
    }
    const prot = drop('MOVE_PROTECT')
    expect(prot.res.delta).toBe(-1)
    expect(prot.res.missed).toBe(false)
    expect(prot.unmodelled.some((u) => u.includes('JumpIfMoveAffectedByProtect'))).toBe(false)
    const det = drop('MOVE_DETECT')
    expect(det.res.delta).toBe(-1)
    expect(det.unmodelled.some((u) => u.includes('JumpIfMoveAffectedByProtect'))).toBe(true)
  })

  it('ChangeStatBuffs line 9942: sets missed: true when stat cannot increase with STAT_BUFF_ALLOW_PTR', () => {
    // Stat maxed + STAT_BUFF_ALLOW_PTR + hasBsPtr: missed is true
    {
      const state = battle([{}, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
      const unmodelled: string[] = []
      const res = changeStatBuffs(
        state,
        0,
        0,
        0,
        1,
        STAT_ATK,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
        true,
        testDeps(),
        unmodelled,
        'MOVE_SWORDS_DANCE',
      )
      expect(res.delta).toBe(0)
      expect(res.multistringChooser).toBe(B_MSG_STAT_WONT_INCREASE)
      expect(res.missed).toBe(true)
    }

    // Stat maxed without STAT_BUFF_ALLOW_PTR: missed is false
    {
      const state = battle([{}, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
      const unmodelled: string[] = []
      const res = changeStatBuffs(
        state,
        0,
        0,
        0,
        1,
        STAT_ATK,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        testDeps(),
        unmodelled,
        'MOVE_SWORDS_DANCE',
      )
      expect(res.delta).toBe(0)
      expect(res.multistringChooser).toBe(B_MSG_STAT_WONT_INCREASE)
      expect(res.missed).toBe(false)
    }
  })
})
