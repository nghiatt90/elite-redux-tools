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
import { getMoveEffectHandler } from './moveEffects'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  RESOURCE_FLAG_ROOST,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
  STATUS1_BLEED,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS2_CONFUSION,
  STATUS2_CURSED,
  STATUS2_DESTINY_BOND,
  STATUS2_ENRAGED,
  STATUS2_INFATUATION,
  STATUS3_CHARGED_UP,
  STATUS4_CUTTHROAT,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_ANY,
  WEATHER_SUN_TEMPORARY,
  getCounter,
  hasFlag,
  statusInfatuatedWith,
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
const MOVE_TAUNT = requireMove('MOVE_TAUNT')
const MOVE_BARRIER = requireMove('MOVE_BARRIER')
const MOVE_DRAGON_CHEER = requireMove('MOVE_DRAGON_CHEER')
const MOVE_GEAR_UP = requireMove('MOVE_GEAR_UP')
const MOVE_CURSE = requireMove('MOVE_CURSE')
const MOVE_DESTINY_BOND = requireMove('MOVE_DESTINY_BOND')
const MOVE_KARMA = requireMove('MOVE_KARMA')
const MOVE_RECYCLE = requireMove('MOVE_RECYCLE')
const MOVE_HELPING_HAND = requireMove('MOVE_HELPING_HAND')
const MOVE_ROOST = requireMove('MOVE_ROOST')
const MOVE_TACKLE = requireMove('MOVE_TACKLE')
const MOVE_TAILWIND = requireMove('MOVE_TAILWIND')
const MOVE_SUNNY_DAY = requireMove('MOVE_SUNNY_DAY')
// ER's Growl is EFFECT_ATTACK_DOWN_HIT; Baby-Doll Eyes is the EFFECT_ATTACK_DOWN move.
const MOVE_BABY_DOLL_EYES = requireMove('MOVE_BABY_DOLL_EYES')
const MOVE_SCREECH = requireMove('MOVE_SCREECH')
const MOVE_SCARY_FACE = requireMove('MOVE_SCARY_FACE')
const MOVE_LEER = requireMove('MOVE_LEER')
const MOVE_COSMIC_POWER = requireMove('MOVE_COSMIC_POWER')
const MOVE_COIL = requireMove('MOVE_COIL')
const MOVE_TICKLE = requireMove('MOVE_TICKLE')
const MOVE_NOBLE_ROAR = requireMove('MOVE_NOBLE_ROAR')
const MOVE_THUNDER_WAVE = requireMove('MOVE_THUNDER_WAVE')
const MOVE_GLARE = requireMove('MOVE_GLARE')
const MOVE_POISON_POWDER = requireMove('MOVE_POISON_POWDER')
const MOVE_FLASH_FREEZE = requireMove('MOVE_FLASH_FREEZE')
const MOVE_BLOOD_SHOT = requireMove('MOVE_BLOOD_SHOT')
const MOVE_SWEET_KISS = requireMove('MOVE_SWEET_KISS')
const MOVE_FLATTER = requireMove('MOVE_FLATTER')
const MOVE_TEETER_DANCE = requireMove('MOVE_TEETER_DANCE')
const MOVE_ATTRACT = requireMove('MOVE_ATTRACT')

const ABILITY_CONTRARY = requireAbility('ABILITY_CONTRARY')
const ABILITY_CLEAR_BODY = requireAbility('ABILITY_CLEAR_BODY')
const ABILITY_DEFIANT = requireAbility('ABILITY_DEFIANT')
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
const ABILITY_WIND_RIDER = requireAbility('ABILITY_WIND_RIDER')
const ABILITY_WIND_POWER = requireAbility('ABILITY_WIND_POWER')
const ABILITY_PROTOSYNTHESIS = requireAbility('ABILITY_PROTOSYNTHESIS')

const ITEM_UTILITY_UMBRELLA = requireItem('ITEM_UTILITY_UMBRELLA')
const ITEM_BOOSTER_ENERGY = requireItem('ITEM_BOOSTER_ENERGY')

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
    def?: number
    spatk?: number
    spdef?: number
    hp?: number
    maxHp?: number
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
          // The foe defaults slower so turn order needs no speed-tie draw (GetWhoStrikesFirst, battle_main.c:4397).
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_SWORDS_DANCE', null, null, null],
          pp: s.pp ?? [30, 0, 0, 0],
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
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
    const state = battle([{ moves: ['MOVE_TAUNT', null, null, null], pp: [10, 0, 0, 0] }, {}], rng)
    const dmg = dummyDamage()

    const out = executeTurn(state, [useMove(1, MOVE_TAUNT), null], testDeps(dmg))

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

  it('BattleScript_EffectBarrier: fails without Psychic Terrain; with Psychic Terrain sets Reflect and Light Screen without modifying stat stages', () => {
    // Without Psychic Terrain: fails (missed: true)
    {
      const state = battle([{ moves: ['MOVE_BARRIER', null, null, null], pp: [20, 0, 0, 0] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_BARRIER), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(actionOutcome.statChanges).toEqual([])
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(false)
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_REFLECT)).toBe(false)
    }

    // With Psychic Terrain: sets both screens for 5 turns; stat stages untouched
    {
      const state = battle([{ moves: ['MOVE_BARRIER', null, null, null], pp: [20, 0, 0, 0] }, {}], countingRng())
      state.field.statuses |= STATUS_FIELD_PSYCHIC_TERRAIN
      const out = executeTurn(state, [useMove(1, MOVE_BARRIER), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.statChanges).toEqual([])
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(true)
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_REFLECT)).toBe(true)
      expect(state.sides[0]!.timers.lightscreenTimer).toBe(5)
      expect(state.sides[0]!.timers.reflectTimer).toBe(5)
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
      // the script has no ppreduce
      expect(state.battlers[0]!.mon.pp[0]).toBe(20)
    }

    // Reflect already up: Light Screen still set, but the failed setreflect marks the move missed
    {
      const state = battle([{ moves: ['MOVE_BARRIER', null, null, null], pp: [20, 0, 0, 0] }, {}], countingRng())
      state.field.statuses |= STATUS_FIELD_PSYCHIC_TERRAIN
      state.sides[0]!.statuses |= SIDE_STATUS_REFLECT
      const out = executeTurn(state, [useMove(1, MOVE_BARRIER), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(true)
      expect(state.sides[0]!.timers.lightscreenTimer).toBe(5)
    }
  })

  it('BattleScript_EffectDragonCheer: raises crit stage by 1 for non-Dragon, 2 for Dragon; fails in singles if crit maxed at 3; stat stages unaffected', () => {
    // Non-Dragon user: +1 critBoost, stat stages untouched
    {
      const state = battle([{ moves: ['MOVE_DRAGON_CHEER', null, null, null], pp: [15, 0, 0, 0] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_DRAGON_CHEER), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.statChanges).toEqual([])
      expect(state.battlers[0]!.volatiles.critBoost).toBe(1)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    }

    // Dragon user: +2 critBoost, stat stages untouched
    {
      const state = createBattleState({
        battlers: [
          createBattlerState(0, mon({ types: ['DRAGON', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_DRAGON_CHEER', null, null, null], pp: [15, 0, 0, 0] }), 0),
          createBattlerState(1, mon(), 0),
        ],
        rng: countingRng(),
      })
      const out = executeTurn(state, [useMove(1, MOVE_DRAGON_CHEER), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.statChanges).toEqual([])
      expect(state.battlers[0]!.volatiles.critBoost).toBe(2)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    }

    // Max crit (3) in singles: partner absent -> fails with missed: true
    {
      const state = battle([{ moves: ['MOVE_DRAGON_CHEER', null, null, null], pp: [15, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.volatiles.critBoost = 3
      const out = executeTurn(state, [useMove(1, MOVE_DRAGON_CHEER), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(actionOutcome.statChanges).toEqual([])
      expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
    }
  })

  it('BattleScript_EffectGearUp: raises Speed by 2 (or 1 if Speed > 10) and SpAtk by 1; fails if both maxed', () => {
    // Neutral stages (6): Speed +2 -> 8, SpAtk +1 -> 7
    {
      const state = battle([{ moves: ['MOVE_GEAR_UP', null, null, null], pp: [20, 0, 0, 0] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_GEAR_UP), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.statChanges).toEqual([
        { battlerId: 0, stat: STAT_SPEED, change: 2 },
        { battlerId: 0, stat: STAT_SPATK, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    }

    // Speed > 10 (stage 11): Speed +1 -> 12, SpAtk +1 -> 7
    {
      const state = battle([{ moves: ['MOVE_GEAR_UP', null, null, null], pp: [20, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_SPEED] = 11
      const out = executeTurn(state, [useMove(1, MOVE_GEAR_UP), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.statChanges).toEqual([
        { battlerId: 0, stat: STAT_SPEED, change: 1 },
        { battlerId: 0, stat: STAT_SPATK, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
    }

    // Both Speed and SpAtk at MAX_STAT_STAGE (12): fails (missed: true, statChanges: [])
    {
      const state = battle([{ moves: ['MOVE_GEAR_UP', null, null, null], pp: [20, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
      state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_GEAR_UP), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(actionOutcome.statChanges).toEqual([])
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    }
  })

  it('BattleScript_EffectCurse: non-Ghost lowers Speed and raises Atk/Def; Ghost cuts 50% max HP and curses target', () => {
    // Non-Ghost user: Speed -1, Atk +1, Def +1
    {
      const state = battle([{ moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_CURSE), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.statChanges).toEqual([
        { battlerId: 0, stat: STAT_SPEED, change: -1 },
        { battlerId: 0, stat: STAT_ATK, change: 1 },
        { battlerId: 0, stat: STAT_DEF, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(5)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
      expect(state.battlers[0]!.mon.hp).toBe(100)
    }

    // Non-Ghost user at min Speed (0) and max Atk/Def (12): fails
    {
      const state = battle([{ moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
      state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
      state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_CURSE), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(actionOutcome.statChanges).toEqual([])
    }

    // Ghost user: loses 50% max HP (50 HP) and lays curse on target
    {
      const state = createBattleState({
        battlers: [
          createBattlerState(0, mon({ types: ['GHOST', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0], hp: 100, maxHp: 100 }), 0),
          createBattlerState(1, mon(), 0),
        ],
        rng: countingRng(),
      })
      const out = executeTurn(state, [useMove(1, MOVE_CURSE), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.targetId).toBe(1)
      expect(actionOutcome.attackerDamage).toBe(50)
      expect(state.battlers[0]!.mon.hp).toBe(50)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    }

    // Ghost user targeting an already-cursed target: fails, no self-damage
    {
      const state = createBattleState({
        battlers: [
          createBattlerState(0, mon({ types: ['GHOST', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0], hp: 100, maxHp: 100 }), 0),
          createBattlerState(1, mon({ status2: STATUS2_CURSED }), 0),
        ],
        rng: countingRng(),
      })
      const out = executeTurn(state, [useMove(1, MOVE_CURSE), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(state.battlers[0]!.mon.hp).toBe(100)
    }
  })

  it('EFFECT_DESTINY_BOND: sets STATUS2_DESTINY_BOND on user and logs unmodelled KO trigger gap', () => {
    const state = battle([{ moves: ['MOVE_DESTINY_BOND', null, null, null], pp: [5, 0, 0, 0] }, {}], countingRng())
    const out = executeTurn(state, [useMove(1, MOVE_DESTINY_BOND), null], testDeps())
    const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
    expect(actionOutcome.missed).toBe(false)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_DESTINY_BOND)).toBe(true)
    expect(out.actions.find((a) => a.battlerId === 0)!.unmodelled.some((m) => m.includes('Destiny Bond faint trigger on KO'))).toBe(true)
  })

  describe('EFFECT_KARMA', () => {
    it('lowers user Speed by 1 and raises SpAtk and SpDef by 1', () => {
      const state = battle([{ moves: ['MOVE_KARMA', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_KARMA), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.statChanges).toEqual([
        { battlerId: 0, stat: STAT_SPEED, change: -1 },
        { battlerId: 0, stat: STAT_SPATK, change: 1 },
        { battlerId: 0, stat: STAT_SPDEF, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(5)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    })

    it('fails when user is at min Speed (0) and max SpAtk/SpDef (12)', () => {
      const state = battle([{ moves: ['MOVE_KARMA', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
      state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
      state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_KARMA), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(actionOutcome.statChanges).toEqual([])
    })

    it('raises SpAtk and SpDef even when Speed is already min stage 0', () => {
      const state = battle([{ moves: ['MOVE_KARMA', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
      const out = executeTurn(state, [useMove(1, MOVE_KARMA), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(actionOutcome.statChanges).toEqual([
        { battlerId: 0, stat: STAT_SPATK, change: 1 },
        { battlerId: 0, stat: STAT_SPDEF, change: 1 },
      ])
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(0)
      expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
      expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
    })
  })

  describe('EFFECT_RECYCLE', () => {
    it('restores consumed held item when user has no held item', () => {
      const state = battle([{ moves: ['MOVE_RECYCLE', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
      state.battlers[0]!.mon.itemId = null
      const out = executeTurn(state, [useMove(1, MOVE_RECYCLE), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(false)
      expect(state.battlers[0]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
      expect(state.battlers[0]!.usedHeldItem).toBe(null)
    })

    it('fails when user has no previously consumed item', () => {
      const state = battle([{ moves: ['MOVE_RECYCLE', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.usedHeldItem = null
      state.battlers[0]!.mon.itemId = null
      const out = executeTurn(state, [useMove(1, MOVE_RECYCLE), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(state.battlers[0]!.mon.itemId).toBe(null)
    })

    it('fails when user already holds an item', () => {
      const state = battle([{ moves: ['MOVE_RECYCLE', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng())
      state.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
      state.battlers[0]!.mon.itemId = 'ITEM_LEFTOVERS'
      const out = executeTurn(state, [useMove(1, MOVE_RECYCLE), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
      expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
      expect(state.battlers[0]!.usedHeldItem).toBe('ITEM_SITRUS_BERRY')
    })
  })

  describe('EFFECT_HELPING_HAND', () => {
    // executeTurn is singles-only; call the handler directly for the doubles cases
    function runHelpingHand(state: ReturnType<typeof createBattleState>, action: ChosenAction) {
      return getMoveEffectHandler('EFFECT_HELPING_HAND')!({
        state,
        battlerId: 0,
        targetId: null,
        action,
        turnOrderIndex: 0,
        deps: testDeps(),
        unmodelled: [],
        deductPp: () => {},
        applyDamage: () => {},
      })
    }

    it('fails in singles because there is no partner', () => {
      const state = battle([{ moves: ['MOVE_HELPING_HAND', null, null, null], pp: [20, 0, 0, 0] }, {}], countingRng())
      const out = executeTurn(state, [useMove(1, MOVE_HELPING_HAND), null], testDeps())
      const actionOutcome = out.actions.find((a) => a.battlerId === 0)!
      expect(actionOutcome.missed).toBe(true)
    })

    it('sets partner round.helpingHand in doubles', () => {
      const state = createBattleState({
        battlers: [
          createBattlerState(0, mon({ moves: ['MOVE_HELPING_HAND', null, null, null], pp: [20, 0, 0, 0] }), 0),
          createBattlerState(1, mon(), 0),
          createBattlerState(2, mon(), 0),
          createBattlerState(3, mon(), 0),
        ],
        battleTypeFlags: 1,
        rng: countingRng(),
      })
      expect(runHelpingHand(state, useMove(1, MOVE_HELPING_HAND)).missed).toBe(false)
      expect(state.battlers[2]!.round.helpingHand).toBe(true)
    })

    it('fails in doubles if partner is fainted', () => {
      const state = createBattleState({
        battlers: [
          createBattlerState(0, mon({ moves: ['MOVE_HELPING_HAND', null, null, null], pp: [20, 0, 0, 0] }), 0),
          createBattlerState(1, mon(), 0),
          createBattlerState(2, mon({ hp: 0 }), 0),
          createBattlerState(3, mon(), 0),
        ],
        battleTypeFlags: 1,
        rng: countingRng(),
      })
      // Cmd_trysethelpinghand reads gAbsentBattlerFlags, not HP
      state.absentBattlerFlags |= 1 << 2
      expect(runHelpingHand(state, useMove(1, MOVE_HELPING_HAND)).missed).toBe(true)
      expect(state.battlers[2]!.round.helpingHand).toBe(false)
    })

    it('fails if partner already has helpingHand set', () => {
      const state = createBattleState({
        battlers: [
          createBattlerState(0, mon({ moves: ['MOVE_HELPING_HAND', null, null, null], pp: [20, 0, 0, 0] }), 0),
          createBattlerState(1, mon(), 0),
          createBattlerState(2, mon(), 0),
          createBattlerState(3, mon(), 0),
        ],
        battleTypeFlags: 1,
        rng: countingRng(),
      })
      state.battlers[2]!.round.helpingHand = true
      expect(runHelpingHand(state, useMove(1, MOVE_HELPING_HAND)).missed).toBe(true)
    })
  })

  describe('Cycle 50 status-move partials (Roost, Tailwind, onWeather)', () => {
    describe('Roost (Cmd_setroost: battle_script_commands.c:4022-4047, ENDTURN_ROOST: battle_util.c:2907-2914)', () => {
      it('Roost on a Flying/Fire dual type removes Flying during the turn and restores Flying at end of turn', () => {
        const rng = countingRng()
        const state = battle(
          [
            { hp: 50, maxHp: 100, spe: 100, types: ['FLYING', 'FIRE', 'MYSTERY'], moves: ['MOVE_ROOST', null, null, null], pp: [10, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )

        let defenderTypesDuringAttack: [string, string, string] | null = null
        let wasGroundedDuringAttack = false
        const damage: DamageResolver = {
          resolve: (st, _atk, tgt) => {
            defenderTypesDuringAttack = [...st.battlers[tgt]!.mon.types]
            wasGroundedDuringAttack = !st.battlers[tgt]!.mon.types.includes('FLYING')
            return { targetDamage: 20, attackerDamage: null, unmodelled: [] }
          },
        }

        executeTurn(state, [useMove(1, MOVE_ROOST), useMove(0, MOVE_TACKLE)], testDeps(damage))

        expect(defenderTypesDuringAttack).toEqual(['MYSTERY', 'FIRE', 'MYSTERY'])
        expect(wasGroundedDuringAttack).toBe(true)

        expect(state.battlers[0]!.mon.types).toEqual(['FLYING', 'FIRE', 'MYSTERY'])
        expect(state.battlers[0]!.roostTypes).toEqual(['FLYING', 'FIRE'])
        expect(hasFlag(state.battlers[0]!.resourceFlags ?? 0, RESOURCE_FLAG_ROOST)).toBe(false)
        expect(state.battlers[0]!.mon.hp).toBe(80)
      })

      it('Roost on a pure Flying type sets types to NORMAL/NORMAL/MYSTERY during turn and restores pure Flying at end of turn', () => {
        const rng = countingRng()
        const state = battle(
          [
            { hp: 50, maxHp: 100, spe: 100, types: ['FLYING', 'FLYING', 'MYSTERY'], moves: ['MOVE_ROOST', null, null, null], pp: [10, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )

        let defenderTypesDuringAttack: [string, string, string] | null = null
        const damage: DamageResolver = {
          resolve: (st, _atk, tgt) => {
            defenderTypesDuringAttack = [...st.battlers[tgt]!.mon.types]
            return { targetDamage: null, attackerDamage: null, unmodelled: [] }
          },
        }

        executeTurn(state, [useMove(1, MOVE_ROOST), useMove(0, MOVE_TACKLE)], testDeps(damage))

        expect(defenderTypesDuringAttack).toEqual(['NORMAL', 'NORMAL', 'MYSTERY'])
        expect(state.battlers[0]!.mon.types).toEqual(['FLYING', 'FLYING', 'MYSTERY'])
        expect(state.battlers[0]!.roostTypes).toEqual(['FLYING', 'FLYING'])
        expect(hasFlag(state.battlers[0]!.resourceFlags ?? 0, RESOURCE_FLAG_ROOST)).toBe(false)
      })

      it('Roost at full HP does not strip Flying type (tryhealhalfhealth branches to AlreadyAtFullHp)', () => {
        const rng = countingRng()
        const state = battle(
          [
            { hp: 100, maxHp: 100, spe: 100, types: ['FLYING', 'FIRE', 'MYSTERY'], moves: ['MOVE_ROOST', null, null, null], pp: [10, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )

        let defenderTypesDuringAttack: [string, string, string] | null = null
        const damage: DamageResolver = {
          resolve: (st, _atk, tgt) => {
            defenderTypesDuringAttack = [...st.battlers[tgt]!.mon.types]
            return { targetDamage: null, attackerDamage: null, unmodelled: [] }
          },
        }

        executeTurn(state, [useMove(1, MOVE_ROOST), useMove(0, MOVE_TACKLE)], testDeps(damage))

        expect(defenderTypesDuringAttack).toEqual(['FLYING', 'FIRE', 'MYSTERY'])
        expect(hasFlag(state.battlers[0]!.resourceFlags ?? 0, RESOURCE_FLAG_ROOST)).toBe(false)
      })
    })

    describe('Tailwind reactions (BattleScript_OnTailwindStart: data/battle_scripts_1.s:9267-9296)', () => {
      it('Tailwind raises Atk +1 for a user with Wind Rider in singles', () => {
        const rng = countingRng()
        const state = battle(
          [
            {
              atk: 100,
              spatk: 80,
              abilities: { ability: ABILITY_WIND_RIDER, innates: [null, null, null] },
              moves: ['MOVE_TAILWIND', null, null, null],
              pp: [15, 0, 0, 0],
            },
            {},
          ],
          rng,
        )

        expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
        executeTurn(state, [useMove(0, MOVE_TAILWIND), null], testDeps())

        expect(state.sides[0]!.timers.tailwindTimer).toBe(3)
        expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
      })

      it('Tailwind sets STATUS3_CHARGED_UP on a user with Wind Power', () => {
        const rng = countingRng()
        const state = battle(
          [
            {
              abilities: { ability: ABILITY_WIND_POWER, innates: [null, null, null] },
              moves: ['MOVE_TAILWIND', null, null, null],
              pp: [15, 0, 0, 0],
            },
            {},
          ],
          rng,
        )

        expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(false)
        executeTurn(state, [useMove(0, MOVE_TAILWIND), null], testDeps())

        expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
      })
    })

    describe('onWeather reactions (BattleScript_OnWeatherChange, Protosynthesis)', () => {
      it('Sunny Day activates Protosynthesis on its highest stat', () => {
        const rng = countingRng()
        const state = battle(
          [
            {
              atk: 110,
              def: 80,
              spatk: 70,
              spdef: 75,
              spe: 90,
              abilities: { ability: ABILITY_PROTOSYNTHESIS, innates: [null, null, null] },
              moves: ['MOVE_SUNNY_DAY', null, null, null],
              pp: [5, 0, 0, 0],
            },
            {},
          ],
          rng,
        )

        expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)

        executeTurn(state, [useMove(0, MOVE_SUNNY_DAY), null], testDeps())

        expect(hasFlag(state.field.weather, WEATHER_SUN_ANY)).toBe(true)
        expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(2 | (STAT_ATK << 2))
      })

      it('Weather ending deactivates Protosynthesis when no Booster Energy is held', () => {
        const rng = countingRng()
        const state = battle(
          [
            {
              atk: 110,
              abilities: { ability: ABILITY_PROTOSYNTHESIS, innates: [null, null, null] },
            },
            {},
          ],
          rng,
        )

        state.field.weather = WEATHER_SUN_TEMPORARY
        state.field.weatherDuration = 1
        state.battlers[0]!.volatiles.abilityState[0] = 2 | (STAT_ATK << 2)

        executeTurn(state, [null, null], testDeps())

        expect(hasFlag(state.field.weather, WEATHER_SUN_ANY)).toBe(false)
        expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
      })

      it('Weather ending consumes Booster Energy and preserves Protosynthesis boost', () => {
        const rng = countingRng()
        const state = battle(
          [
            {
              atk: 110,
              itemId: ITEM_BOOSTER_ENERGY.id,
              abilities: { ability: ABILITY_PROTOSYNTHESIS, innates: [null, null, null] },
            },
            {},
          ],
          rng,
        )

        state.field.weather = WEATHER_SUN_TEMPORARY
        state.field.weatherDuration = 1
        state.battlers[0]!.volatiles.abilityState[0] = 2 | (STAT_ATK << 2)

        // GetBattlerHoldEffect(battler, TRUE) goes through grounding.holdEffectOf.
        const deps = { ...testDeps(), grounding: { ...GROUNDING, holdEffectOf: (id: number) => (id === 0 ? 'HOLD_EFFECT_BOOSTER_ENERGY' : null) } }
        executeTurn(state, [null, null], deps)

        expect(hasFlag(state.field.weather, WEATHER_SUN_ANY)).toBe(false)
        expect(state.battlers[0]!.mon.itemId).toBeNull()
        // RemoveItem (battle_script_commands.c:2231) never writes usedHeldItems.
        expect(state.battlers[0]!.usedHeldItem ?? null).toBeNull()
        expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(1 | (STAT_ATK << 2))
      })
    })

    describe('Single-stat target drops (BattleScript_EffectStatDown)', () => {
      it("Baby-Doll Eyes lowers the foe's Atk by 1", () => {
        const rng = countingRng()
        const state = battle([{}, {}], rng)
        const deps = testDeps()
        executeTurn(state, [useMove(1, MOVE_BABY_DOLL_EYES), null], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
      })

      it("Screech lowers the foe's Def by 2", () => {
        const rng = countingRng()
        const state = battle([{}, {}], rng)
        const deps = testDeps()
        executeTurn(state, [useMove(1, MOVE_SCREECH), null], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 2)
      })

      it('a stat-drop blocked by Clear Body leaves the stage unchanged', () => {
        const rng = countingRng()
        const state = battle(
          [
            {},
            { abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] } },
          ],
          rng,
        )
        const deps = testDeps()
        executeTurn(state, [useMove(1, MOVE_BABY_DOLL_EYES), null], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
      })

      it('a stat-drop that misses (scripted RNG on the accuracy draw) changes nothing', () => {
        const roll = 90
        const rng = {
          calls: 0,
          random16: () => {
            rng.calls++
            return roll
          },
        }
        const state = battle([{}, {}], rng)
        const deps = testDeps()
        executeTurn(state, [useMove(1, MOVE_SCREECH), null], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
      })

      it('Defiant on the target raises Atk by 2 after Leer', () => {
        const rng = countingRng()
        const state = battle(
          [
            {},
            { abilities: { ability: ABILITY_DEFIANT, innates: [null, null, null] } },
          ],
          rng,
        )
        const deps = testDeps()
        executeTurn(state, [useMove(1, MOVE_LEER), null], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
      })
    })

    describe('Scary Face (BattleScript_EffectScaryFace, battle_scripts_1.s:12050-12065)', () => {
      it('lowers Speed by 2 with no accuracy draw and sets fear', () => {
        const rng = countingRng()
        const state = battle([{}, {}], rng)
        executeTurn(state, [useMove(1, MOVE_SCARY_FACE), null], testDeps())
        expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 2)
        expect(state.battlers[1]!.volatiles.fear).toBe(true)
        expect(rng.calls).toBe(0)
      })
    })

    describe('Remaining self stat-ups', () => {
      it('Cosmic Power raises Def and SpDef by 1', () => {
        const rng = countingRng()
        const state = battle([{}, {}], rng)
        const deps = testDeps()
        executeTurn(state, [useMove(0, MOVE_COSMIC_POWER), null], deps)
        expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
        expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
      })

      it('Coil raises Atk, Def and Accuracy', () => {
        const rng = countingRng()
        const state = battle([{}, {}], rng)
        const deps = testDeps()
        executeTurn(state, [useMove(0, MOVE_COIL), null], deps)
        expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
        expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
        expect(state.battlers[0]!.mon.statStages[STAT_ACC]).toBe(DEFAULT_STAT_STAGE + 1)
      })
    })

    describe('Two-stat target drops', () => {
      it('Tickle lowers Atk and Def', () => {
        const rng = countingRng()
        const state = battle([{}, {}], rng)
        const deps = testDeps()
        executeTurn(state, [useMove(1, MOVE_TICKLE), null], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
        expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
      })

      it('Noble Roar lowers Atk and SpAtk', () => {
        const rng = countingRng()
        const state = battle([{}, {}], rng)
        const deps = testDeps()
        executeTurn(state, [useMove(1, MOVE_NOBLE_ROAR), null], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
        expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 1)
      })
    })
  })

  describe('Cycle 52 status-condition moves', () => {
    describe('EFFECT_PARALYZE & EFFECT_PARALYZE_IGNORE_TYPE', () => {
      it('Thunder Wave paralyzes a neutral target', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [{ moves: ['MOVE_THUNDER_WAVE', null, null, null], pp: [10, 0, 0, 0] }, {}],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_THUNDER_WAVE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(9)
        expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'PARALYSIS' })
        expect(act.missed).toBe(false)
        expect(rng.calls).toBe(1)
      })

      it('Thunder Wave fails on a Ground type without drawing accuracy', () => {
        // BattleScript_EffectParalyze: typecalc (:4366) sets MOVE_RESULT_DOESNT_AFFECT_FOE,
        // causing accuracycheck (:4369) to jump to BattleScript_ButItFailed without rolling accuracy.
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { moves: ['MOVE_THUNDER_WAVE', null, null, null], pp: [10, 0, 0, 0] },
            { types: ['GROUND', 'MYSTERY', 'MYSTERY'] },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_THUNDER_WAVE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(rng.calls).toBe(0)
        expect(state.battlers[0]!.mon.pp[0]).toBe(9)
        expect(state.battlers[1]!.mon.status1).toBe(0)
        expect(act.statusApplied).toBeNull()
        expect(act.missed).toBe(false)
      })

      it('Glare paralyzes a Ground type', () => {
        // BattleScript_EffectParalyzeIgnoreType: no typecalc, so Ground typing does not block it.
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { moves: ['MOVE_GLARE', null, null, null], pp: [20, 0, 0, 0] },
            { types: ['GROUND', 'MYSTERY', 'MYSTERY'] },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_GLARE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'PARALYSIS' })
        expect(act.missed).toBe(false)
      })

      it('Thunder Wave fails on an already-statused target', () => {
        // requirecandoeffect BS_TARGET (:4367) calls CanBeParalyzedIgnoreType,
        // which returns false because status1 !== 0; JumpIfStandardStatusBlocking jumps to fail.
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { moves: ['MOVE_THUNDER_WAVE', null, null, null], pp: [10, 0, 0, 0] },
            { status1: STATUS1_PARALYSIS },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_THUNDER_WAVE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(rng.calls).toBe(0)
        expect(state.battlers[0]!.mon.pp[0]).toBe(9)
        expect(act.statusApplied).toBeNull()
      })
    })

    describe('EFFECT_POISON, EFFECT_FROSTBITE & EFFECT_BLEED', () => {
      it('Poison Powder poisons a neutral target', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [{ moves: ['MOVE_POISON_POWDER', null, null, null], pp: [20, 0, 0, 0] }, {}],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_POISON_POWDER), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'POISON' })
        expect(act.missed).toBe(false)
        expect(rng.calls).toBe(1)
      })

      it('Poison Powder: CANCELLER_POWDER_MOVE is gapped on pure Grass, but Poison-type fails in script', () => {
        // C check: BattleScript_EffectPoison has no Grass check; powder immunity is in
        // CANCELLER_POWDER_MOVE (battle_util.c:3455) which attackCanceller.ts gaps by name.
        // CanBePoisoned checks Poison/Steel types via CanPoisonType (src/battle_script_commands.c:6465).
        const deps = testDeps()

        // 1. Pure Grass: CANCELLER_POWDER_MOVE gap recorded, script runs
        {
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_POISON_POWDER', null, null, null], pp: [20, 0, 0, 0] },
              { types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_POISON_POWDER), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(act.unmodelled.some((u) => u.startsWith('CANCELLER_POWDER_MOVE'))).toBe(true)
          expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
        }

        // 2. Poison type: CanBePoisoned fails before accuracy
        {
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_POISON_POWDER', null, null, null], pp: [20, 0, 0, 0] },
              { types: ['POISON', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_POISON_POWDER), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(rng.calls).toBe(0)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          expect(state.battlers[1]!.mon.status1).toBe(0)
          expect(act.statusApplied).toBeNull()
        }
      })

      it('Flash Freeze inflicts Frostbite, fails on Ice types and already-statused', () => {
        const deps = testDeps()

        // 1. Neutral target gets Frostbite
        {
          const rng = countingRng()
          const state = battle(
            [{ moves: ['MOVE_FLASH_FREEZE', null, null, null], pp: [10, 0, 0, 0] }, {}],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_FLASH_FREEZE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
          expect(act.statusApplied).toEqual({ battlerId: 1, status: 'FROSTBITE' })
        }

        // 2. Ice type fails without drawing accuracy
        {
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FLASH_FREEZE', null, null, null], pp: [10, 0, 0, 0] },
              { types: ['ICE', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_FLASH_FREEZE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(rng.calls).toBe(0)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(state.battlers[1]!.mon.status1).toBe(0)
          expect(act.statusApplied).toBeNull()
        }

        // 3. Already-statused target fails
        {
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FLASH_FREEZE', null, null, null], pp: [10, 0, 0, 0] },
              { status1: STATUS1_FROSTBITE },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_FLASH_FREEZE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(rng.calls).toBe(0)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(act.statusApplied).toBeNull()
        }
      })

      it('Blood Shot inflicts Bleed, fails on Rock and Ghost types and already-statused', () => {
        const deps = testDeps()

        // 1. Neutral target gets Bleed
        {
          const rng = countingRng()
          const state = battle(
            [{ moves: ['MOVE_BLOOD_SHOT', null, null, null], pp: [10, 0, 0, 0] }, {}],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_BLOOD_SHOT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
          expect(act.statusApplied).toEqual({ battlerId: 1, status: 'BLEED' })
        }

        // 2. Rock type fails
        {
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_BLOOD_SHOT', null, null, null], pp: [10, 0, 0, 0] },
              { types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_BLOOD_SHOT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(rng.calls).toBe(0)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(state.battlers[1]!.mon.status1).toBe(0)
          expect(act.statusApplied).toBeNull()
        }

        // 3. Ghost type fails
        {
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_BLOOD_SHOT', null, null, null], pp: [10, 0, 0, 0] },
              { types: ['GHOST', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_BLOOD_SHOT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(rng.calls).toBe(0)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(state.battlers[1]!.mon.status1).toBe(0)
          expect(act.statusApplied).toBeNull()
        }

        // 4. Already-statused fails
        {
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_BLOOD_SHOT', null, null, null], pp: [10, 0, 0, 0] },
              { status1: STATUS1_BLEED },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_BLOOD_SHOT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!

          expect(rng.calls).toBe(0)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(act.statusApplied).toBeNull()
        }
      })
    })

    describe('EFFECT_CONFUSE, EFFECT_SWEET_KISS, EFFECT_FLATTER & EFFECT_TEETER_DANCE', () => {
      it('Confuse Ray confuses with the turn count from the scripted RNG and fails if already confused', () => {
        const deps = testDeps()
        // Confuse Ray:
        // 1. checkAccuracy: roll 0 (% 100 < 100, hits)
        // 2. applyPrimaryStatusEffect: confusion turn count (Random() % 2) + 3
        // With scripted roll 1: (1 % 2) + 3 = 4 turns.
        const rng = scriptedRng([0, 1])
        const state = battle(
          [{ moves: ['MOVE_CONFUSE_RAY', null, null, null], pp: [10, 0, 0, 0] }, {}],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_CONFUSE_RAY), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(9)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
        expect(getCounter(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(4)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'CONFUSION' })
        expect(act.missed).toBe(false)
        expect(rng.calls).toBe(2)

        // Already confused, no status1: requirecandoeffect only jumps on a JumpIfStandardStatusBlocking
        // branch (battle_script_commands.c:6593-6616, 8583-8588), so the accuracy draw still happens
        // and SetMoveEffect then changes nothing.
        const rng2 = countingRng()
        state.rng = rng2
        const out2 = executeTurn(state, [useMove(1, MOVE_CONFUSE_RAY), null], deps)
        const act2 = out2.actions.find((a) => a.battlerId === 0)!
        expect(rng2.calls).toBe(1)
        expect(act2.statusApplied).toBeNull()

        // With a status1 the standard branch fails it before accuracy.
        const rng3 = countingRng()
        state.rng = rng3
        state.battlers[1]!.mon.status1 = STATUS1_PARALYSIS
        executeTurn(state, [useMove(1, MOVE_CONFUSE_RAY), null], deps)
        expect(rng3.calls).toBe(0)
      })

      it('Flatter raises SpAtk by 1 and enrages the target', () => {
        // BattleScript_EffectFlatter (data/battle_scripts_1.s:6069-6088):
        // In Elite Redux, Flatter sets MOVE_EFFECT_ENRAGE (STATUS2_ENRAGED) and raises STAT_SPATK by 1.
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [{ moves: ['MOVE_FLATTER', null, null, null], pp: [15, 0, 0, 0] }, {}],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_FLATTER), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(14)
        expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ENRAGED)).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'ENRAGED' })
      })

      it('Sweet Kiss confuses and infatuates opposite-gender target', () => {
        // BattleScript_EffectSweetKiss (data/battle_scripts_1.s:4202-4216):
        // Sets both MOVE_EFFECT_CONFUSION and MOVE_EFFECT_ATTRACT.
        const deps = testDeps()
        const rng = scriptedRng([0, 0])
        const state = battle(
          [
            { gender: 'MALE', moves: ['MOVE_SWEET_KISS', null, null, null], pp: [10, 0, 0, 0] },
            { gender: 'FEMALE' },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_SWEET_KISS), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(9)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'CONFUSION' })
      })

      it('Teeter Dance confuses other battlers and skips the attacker', () => {
        // BattleScript_EffectTeeterDance (data/battle_scripts_1.s:6544-6566):
        // Loops all battlers, skipping the user and faint battlers.
        const deps = testDeps()
        const rng = scriptedRng([0, 0])
        const state = battle(
          [
            { moves: ['MOVE_TEETER_DANCE', null, null, null], pp: [20, 0, 0, 0] },
            {},
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_TEETER_DANCE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'CONFUSION' })
      })
    })

    describe('EFFECT_ATTRACT', () => {
      it('Attract infatuates opposite-gender target and triggers Destiny Knot', () => {
        // BattleScript_EffectAttract (data/battle_scripts_1.s:5224-5236):
        // Infatuates opposite gender target, and Destiny Knot reflects infatuation back to user.
        const deps = {
          ...testDeps(),
          grounding: { ...GROUNDING, holdEffectOf: (id: number) => (id === 1 ? 'HOLD_EFFECT_DESTINY_KNOT' : null) },
        }
        const rng = countingRng()
        const state = battle(
          [
            { gender: 'MALE', moves: ['MOVE_ATTRACT', null, null, null], pp: [15, 0, 0, 0] },
            { gender: 'FEMALE' },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_ATTRACT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(14)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
        expect(hasFlag(state.battlers[1]!.mon.status2, statusInfatuatedWith(0))).toBe(true)
        // Destiny Knot reflects infatuation back to user (battler 0 infatuated with battler 1)
        expect(hasFlag(state.battlers[0]!.mon.status2, statusInfatuatedWith(1))).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'INFATUATION' })
        expect(act.missed).toBe(false)
      })

      it('Attract infatuates a same-gender target (ER has no gender check)', () => {
        // tryinfatuating (battle_script_commands.c:10419-10429) only asks CanInfatuate (battle_util.c:5135-5143).
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { gender: 'MALE', moves: ['MOVE_ATTRACT', null, null, null], pp: [15, 0, 0, 0] },
            { gender: 'MALE' },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_ATTRACT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(14)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'INFATUATION' })
      })

      it('Attract infatuates a genderless target', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { gender: 'MALE', moves: ['MOVE_ATTRACT', null, null, null], pp: [15, 0, 0, 0] },
            { gender: 'GENDERLESS' },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_ATTRACT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(14)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
        expect(act.statusApplied).toEqual({ battlerId: 1, status: 'INFATUATION' })
      })

      it('Attract fails on an already-infatuated target', () => {
        // CanInfatuate (src/battle_util.c:5136): if (status2 & STATUS2_INFATUATION) return FALSE.
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { gender: 'MALE', moves: ['MOVE_ATTRACT', null, null, null], pp: [15, 0, 0, 0] },
            { gender: 'FEMALE', status2: statusInfatuatedWith(0) },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_ATTRACT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!

        expect(state.battlers[0]!.mon.pp[0]).toBe(14)
        expect(act.statusApplied).toBeNull()
      })
    })
  })
})
