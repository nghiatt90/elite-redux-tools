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
import { isBattlerGrounded } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  RESOURCE_FLAG_ROOST,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TOXIC_SPIKES,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_EVASION,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
  STATUS1_BLEED,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  SIDE_STATUS_SMOKESCREEN,
  STATUS2_CONFUSION,
  STATUS2_CURSED,
  STATUS2_DESTINY_BOND,
  STATUS2_ENRAGED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_INFATUATION,
  STATUS2_SUBSTITUTE,
  STATUS2_TORMENT,
  STATUS3_ALWAYS_HITS,
  STATUS3_AQUA_RING,
  STATUS3_CHARGED_UP,
  STATUS3_EMBARGO,
  STATUS3_HEAL_BLOCK,
  STATUS3_LASER_FOCUS,
  STATUS3_MAGNET_RISE,
  STATUS3_MINIMIZED,
  STATUS3_MIRACLE_EYED,
  STATUS3_PERISH_SONG,
  STATUS3_ROOTED,
  STATUS4_CUTTHROAT,
  STATUS4_FORESIGHT,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRAVITY,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_FOG_TEMPORARY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_ANY,
  WEATHER_SUN_TEMPORARY,
  getCounter,
  setFlag,
  hasFlag,
  statusInfatuatedWith,
} from './constants'
import { canBattlerEscape } from './escape'
import {
  B_MSG_DEFENDER_STAT_FELL,
  B_MSG_STAT_WONT_DECREASE,
  B_MSG_STAT_WONT_INCREASE,
  MOVE_EFFECT_AFFECTS_USER,
  STAT_BUFF_ALLOW_PTR,
  STAT_DROP_BLOCK_ABILITIES,
  changeStatBuffs,
  isBattlerWeatherAffected,
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
const MOVE_FOLLOW_ME = requireMove('MOVE_FOLLOW_ME')
const MOVE_HAZE = requireMove('MOVE_HAZE')
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
const MOVE_DISABLE = requireMove('MOVE_DISABLE')
const MOVE_ENCORE = requireMove('MOVE_ENCORE')
const MOVE_TORMENT = requireMove('MOVE_TORMENT')
const MOVE_HEAL_BLOCK = requireMove('MOVE_HEAL_BLOCK')
const MOVE_EMBARGO = requireMove('MOVE_EMBARGO')
const MOVE_FOCUS_ENERGY = requireMove('MOVE_FOCUS_ENERGY')
const MOVE_RECOVER = requireMove('MOVE_RECOVER')
const MOVE_ELECTRIC_TERRAIN = requireMove('MOVE_ELECTRIC_TERRAIN')
const MOVE_GRASSY_TERRAIN = requireMove('MOVE_GRASSY_TERRAIN')
const MOVE_TRICK_ROOM = requireMove('MOVE_TRICK_ROOM')
const MOVE_GRAVITY = requireMove('MOVE_GRAVITY')
const MOVE_FLY = requireMove('MOVE_FLY')
const MOVE_CLEAR_SKIES = requireMove('MOVE_CLEAR_SKIES')
const MOVE_DEFOG = requireMove('MOVE_DEFOG')
const MOVE_SUBSTITUTE = requireMove('MOVE_SUBSTITUTE')
const MOVE_AQUA_RING = requireMove('MOVE_AQUA_RING')
const MOVE_INGRAIN = requireMove('MOVE_INGRAIN')
const MOVE_MAGNET_RISE = requireMove('MOVE_MAGNET_RISE')
const MOVE_CHARGE = requireMove('MOVE_CHARGE')
const MOVE_LOCK_ON = requireMove('MOVE_LOCK_ON')
const MOVE_LASER_FOCUS = requireMove('MOVE_LASER_FOCUS')
const MOVE_ZAP_CANNON = requireMove('MOVE_ZAP_CANNON')
const MOVE_MEAN_LOOK = requireMove('MOVE_MEAN_LOOK')
const MOVE_FORESIGHT = requireMove('MOVE_FORESIGHT')
const MOVE_MIRACLE_EYE = requireMove('MOVE_MIRACLE_EYE')
const MOVE_PERISH_SONG = requireMove('MOVE_PERISH_SONG')
const MOVE_MINIMIZE = requireMove('MOVE_MINIMIZE')

const ABILITY_OBLIVIOUS = requireAbility('ABILITY_OBLIVIOUS')
const ABILITY_AROMA_VEIL = requireAbility('ABILITY_AROMA_VEIL')
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
const ABILITY_SOUNDPROOF = requireAbility('ABILITY_SOUNDPROOF')

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
    const state = battle([{ moves: ['MOVE_FOLLOW_ME', null, null, null], pp: [10, 0, 0, 0] }, {}], rng)
    const dmg = dummyDamage()

    const out = executeTurn(state, [useMove(1, MOVE_FOLLOW_ME), null], testDeps(dmg))

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

    describe('Cycle 53: EFFECT_TAUNT (BattleScript_EffectTaunt, Cmd_settaunt, CANCELLER_TAUNTED, ENDTURN_TAUNT)', () => {
      it('Taunt blocks a status move the next turn and wears off after 3 turns when user acts first', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_TAUNT', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [30, 0, 0, 0] },
          ],
          rng,
        )

        // Turn 1: Battler 0 uses Taunt. Battler 1 moves after Battler 0, so turns = 3.
        const out1 = executeTurn(state, [useMove(1, MOVE_TAUNT), null], deps)
        const act1 = out1.actions.find((a) => a.battlerId === 0)!
        expect(act1.missed).toBe(false)
        expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        // Set to 3 during turn, decremented by ENDTURN_TAUNT to 2 at end of turn
        expect(state.battlers[1]!.volatiles.tauntTimer).toBe(2)

        // Turn 2: Battler 1 tries to use Swords Dance, blocked by CANCELLER_TAUNTED
        const out2 = executeTurn(state, [null, useMove(1, MOVE_SWORDS_DANCE)], deps)
        const act2 = out2.actions.find((a) => a.battlerId === 1)!
        expect(act2.cancelledBy).toBe('TAUNT')
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
        // Decremented by ENDTURN_TAUNT to 1
        expect(state.battlers[1]!.volatiles.tauntTimer).toBe(1)

        // Turn 3: Battler 1 tries Swords Dance again, still taunted
        const out3 = executeTurn(state, [null, useMove(1, MOVE_SWORDS_DANCE)], deps)
        const act3 = out3.actions.find((a) => a.battlerId === 1)!
        expect(act3.cancelledBy).toBe('TAUNT')
        // Decremented by ENDTURN_TAUNT to 0 (wears off)
        expect(state.battlers[1]!.volatiles.tauntTimer).toBe(0)

        // Turn 4: Taunt has worn off, Swords Dance succeeds
        const out4 = executeTurn(state, [null, useMove(1, MOVE_SWORDS_DANCE)], deps)
        const act4 = out4.actions.find((a) => a.battlerId === 1)!
        expect(act4.cancelledBy).toBeNull()
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
      })

      it('Taunt fails on an already-taunted target (Cmd_settaunt:11682)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_TAUNT', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50 },
          ],
          rng,
        )
        state.battlers[1]!.volatiles.tauntTimer = 2
        const out = executeTurn(state, [useMove(1, MOVE_TAUNT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(state.battlers[0]!.mon.pp[0]).toBe(19)
      })

      it('Taunt fails against an Oblivious target (Cmd_settaunt:11679, jumpifabilitystatusimmunity)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_TAUNT', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, abilities: { ability: ABILITY_OBLIVIOUS, innates: [null, null, null] } },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_TAUNT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(state.battlers[1]!.volatiles.tauntTimer).toBe(0)
      })

      it('Taunt fails against an Aroma Veil target (jumpifabilitystatusimmunity)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_TAUNT', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, abilities: { ability: ABILITY_AROMA_VEIL, innates: [null, null, null] } },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_TAUNT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(state.battlers[1]!.volatiles.tauntTimer).toBe(0)
      })
    })

    describe('Cycle 53: EFFECT_DISABLE (BattleScript_EffectDisable, DisableLastUsedMove, CANCELLER_DISABLED, ENDTURN_DISABLE)', () => {
      it("Disable blocks the target's last move until the timer ends (4 turns)", () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_DISABLE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )

        // Turn 1: Battler 1 uses Tackle, setting lastMove = 'MOVE_TACKLE'
        executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        expect(state.battlers[1]!.lastMove).toBe('MOVE_TACKLE')

        // Turn 2: Battler 0 uses Disable on Battler 1
        const out2 = executeTurn(state, [useMove(1, MOVE_DISABLE), null], deps)
        const act2 = out2.actions.find((a) => a.battlerId === 0)!
        expect(act2.missed).toBe(false)
        expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        expect(state.battlers[1]!.volatiles.disabledMove).toBe('MOVE_TACKLE')
        // Starts at 4, decremented by ENDTURN_DISABLE at end of turn to 3
        expect(state.battlers[1]!.volatiles.disableTimer).toBe(3)

        // Turn 3: Battler 1 tries to use Tackle, cancelled by CANCELLER_DISABLED
        const out3 = executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        const act3 = out3.actions.find((a) => a.battlerId === 1)!
        expect(act3.cancelledBy).toBe('DISABLE')
        // Decremented by ENDTURN_DISABLE to 2
        expect(state.battlers[1]!.volatiles.disableTimer).toBe(2)

        // Turn 4: Battler 1 tries Tackle again, still disabled
        const out4 = executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        const act4 = out4.actions.find((a) => a.battlerId === 1)!
        expect(act4.cancelledBy).toBe('DISABLE')
        // Decremented to 1
        expect(state.battlers[1]!.volatiles.disableTimer).toBe(1)

        // Turn 5: Battler 1 tries Tackle again, still disabled
        const out5 = executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        const act5 = out5.actions.find((a) => a.battlerId === 1)!
        expect(act5.cancelledBy).toBe('DISABLE')
        // Decremented to 0, disabledMove cleared
        expect(state.battlers[1]!.volatiles.disableTimer).toBe(0)
        expect(state.battlers[1]!.volatiles.disabledMove).toBeNull()

        // Turn 6: Disable has worn off, Tackle succeeds
        const out6 = executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        const act6 = out6.actions.find((a) => a.battlerId === 1)!
        expect(act6.cancelledBy).toBeNull()
      })

      it('Disable fails if target has no last move (DisableLastUsedMove:10720)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_DISABLE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )
        // No move used yet by battler 1
        const out = executeTurn(state, [useMove(1, MOVE_DISABLE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(state.battlers[1]!.volatiles.disabledMove).toBeNull()
      })

      it('Disable fails if target already has a disabled move', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_DISABLE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )
        state.battlers[1]!.lastMove = 'MOVE_TACKLE'
        state.battlers[1]!.volatiles.disabledMove = 'MOVE_TACKLE'
        state.battlers[1]!.volatiles.disableTimer = 3
        const out = executeTurn(state, [useMove(1, MOVE_DISABLE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
      })

      it('Disable fails against an Oblivious target (jumpifabilitystatusimmunity)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_DISABLE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], abilities: { ability: ABILITY_OBLIVIOUS, innates: [null, null, null] } },
          ],
          rng,
        )
        state.battlers[1]!.lastMove = 'MOVE_TACKLE'
        const out = executeTurn(state, [useMove(1, MOVE_DISABLE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(state.battlers[1]!.volatiles.disabledMove).toBeNull()
      })
    })

    describe('Cycle 53: EFFECT_ENCORE (BattleScript_EffectEncore, SetEncore, turn.ts encore forcing, ENDTURN_ENCORE)', () => {
      it('Encore locks the target into its last move for 3 turns', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_ENCORE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', 'MOVE_SWORDS_DANCE', null, null], pp: [35, 30, 0, 0] },
          ],
          rng,
        )

        // Turn 1: Battler 1 uses Tackle
        executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        expect(state.battlers[1]!.lastMove).toBe('MOVE_TACKLE')

        // Turn 2: Battler 0 uses Encore on Battler 1
        const out2 = executeTurn(state, [useMove(1, MOVE_ENCORE), null], deps)
        const act2 = out2.actions.find((a) => a.battlerId === 0)!
        expect(act2.missed).toBe(false)
        expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        expect(state.battlers[1]!.volatiles.encoredMove).toBe('MOVE_TACKLE')
        expect(state.battlers[1]!.volatiles.encoredMovePos).toBe(0)
        // Starts at 3, decremented by ENDTURN_ENCORE at end of turn to 2
        expect(state.battlers[1]!.volatiles.encoreTimer).toBe(2)

        // Turn 3: Battler 1 chooses Swords Dance (slot 2), but Encore forces Tackle (slot 1)
        const out3 = executeTurn(state, [null, useMove(2, MOVE_SWORDS_DANCE)], deps)
        const act3 = out3.actions.find((a) => a.battlerId === 1)!
        // Stat stages unchanged because Tackle ran instead of Swords Dance
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
        expect(act3.cancelledBy).toBeNull()
        // Decremented by ENDTURN_ENCORE to 1
        expect(state.battlers[1]!.volatiles.encoreTimer).toBe(1)

        // Turn 4: Battler 1 chooses Swords Dance again, Encore still forces Tackle
        executeTurn(state, [null, useMove(2, MOVE_SWORDS_DANCE)], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
        // Decremented to 0, encoredMove cleared
        expect(state.battlers[1]!.volatiles.encoreTimer).toBe(0)
        expect(state.battlers[1]!.volatiles.encoredMove).toBeNull()

        // Turn 5: Encore ended, Swords Dance succeeds
        executeTurn(state, [null, useMove(2, MOVE_SWORDS_DANCE)], deps)
        expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
      })

      it('Encore fails if target has no last move (SetEncore:10749)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_ENCORE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_ENCORE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(state.battlers[1]!.volatiles.encoredMove).toBeNull()
      })

      it('Encore fails if target last move was MOVE_ENCORE (SetEncore:10745)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_ENCORE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_ENCORE', null, null, null], pp: [20, 0, 0, 0] },
          ],
          rng,
        )
        state.battlers[1]!.lastMove = 'MOVE_ENCORE'
        const out = executeTurn(state, [useMove(1, MOVE_ENCORE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
      })

      it('Encore fails if target is already encored (SetEncore:10749)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_ENCORE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )
        state.battlers[1]!.lastMove = 'MOVE_TACKLE'
        state.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
        state.battlers[1]!.volatiles.encoreTimer = 2
        const out = executeTurn(state, [useMove(1, MOVE_ENCORE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
      })

      it('Encore fails against an Oblivious target (jumpifabilitystatusimmunity)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_ENCORE', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], abilities: { ability: ABILITY_OBLIVIOUS, innates: [null, null, null] } },
          ],
          rng,
        )
        state.battlers[1]!.lastMove = 'MOVE_TACKLE'
        const out = executeTurn(state, [useMove(1, MOVE_ENCORE), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(state.battlers[1]!.volatiles.encoredMove).toBeNull()
      })
    })

    describe('Cycle 53: EFFECT_TORMENT (BattleScript_EffectTorment, Cmd_settorment, turn.ts Torment gap)', () => {
      it('Torment applies STATUS2_TORMENT and gaps consecutive lastMove at execution', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_TORMENT', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )

        // Turn 1: Battler 0 uses Torment
        const out1 = executeTurn(state, [useMove(1, MOVE_TORMENT), null], deps)
        const act1 = out1.actions.find((a) => a.battlerId === 0)!
        expect(act1.missed).toBe(false)
        expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_TORMENT)).toBe(true)

        // Turn 2: Battler 1 uses Tackle
        executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        expect(state.battlers[1]!.lastMove).toBe('MOVE_TACKLE')

        // Turn 3: Battler 1 uses Tackle again while tormented -> unmodelled gap recorded
        const out3 = executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        const act3 = out3.actions.find((a) => a.battlerId === 1)!
        expect(act3.unmodelled.some((m) => m.includes('Torment move restriction'))).toBe(true)
      })

      it('Torment fails if target is already tormented (Cmd_settorment:11663)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_TORMENT', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, status2: STATUS2_TORMENT },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_TORMENT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
      })

      it('Torment fails against an Oblivious target (jumpifabilitystatusimmunity)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_TORMENT', null, null, null], pp: [20, 0, 0, 0] },
            { spe: 50, abilities: { ability: ABILITY_OBLIVIOUS, innates: [null, null, null] } },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_TORMENT), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_TORMENT)).toBe(false)
      })
    })

    describe('Cycle 53: EFFECT_HEAL_BLOCK (BattleScript_EffectHealBlock, Cmd_sethealblock, CANCELLER_HEAL_BLOCKED, ENDTURN_HEALBLOCK)', () => {
      it('Heal Block prevents Recover and wears off after 5 turns', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_HEAL_BLOCK', null, null, null], pp: [15, 0, 0, 0] },
            { spe: 50, hp: 50, maxHp: 100, moves: ['MOVE_RECOVER', null, null, null], pp: [10, 0, 0, 0] },
          ],
          rng,
        )

        // Turn 1: Battler 0 uses Heal Block
        const out1 = executeTurn(state, [useMove(1, MOVE_HEAL_BLOCK), null], deps)
        const act1 = out1.actions.find((a) => a.battlerId === 0)!
        expect(act1.missed).toBe(false)
        expect(state.battlers[0]!.mon.pp[0]).toBe(14)
        expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_HEAL_BLOCK)).toBe(true)
        // Starts at 5, decremented by ENDTURN_HEALBLOCK to 4
        expect(state.battlers[1]!.volatiles.healBlockTimer).toBe(4)

        // Turn 2: Battler 1 tries Recover, blocked by CANCELLER_HEAL_BLOCKED
        const out2 = executeTurn(state, [null, useMove(1, MOVE_RECOVER)], deps)
        const act2 = out2.actions.find((a) => a.battlerId === 1)!
        expect(act2.cancelledBy).toBe('HEAL_BLOCK')
        expect(state.battlers[1]!.mon.hp).toBe(50)
        // Timer decrements to 3
        expect(state.battlers[1]!.volatiles.healBlockTimer).toBe(3)

        // Turn 3: Recover blocked, timer decrements to 2
        const out3 = executeTurn(state, [null, useMove(1, MOVE_RECOVER)], deps)
        expect(out3.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBe('HEAL_BLOCK')
        expect(state.battlers[1]!.volatiles.healBlockTimer).toBe(2)

        // Turn 4: Recover blocked, timer decrements to 1
        const out4 = executeTurn(state, [null, useMove(1, MOVE_RECOVER)], deps)
        expect(out4.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBe('HEAL_BLOCK')
        expect(state.battlers[1]!.volatiles.healBlockTimer).toBe(1)

        // Turn 5: Recover blocked, timer decrements to 0 and clears STATUS3_HEAL_BLOCK
        const out5 = executeTurn(state, [null, useMove(1, MOVE_RECOVER)], deps)
        expect(out5.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBe('HEAL_BLOCK')
        expect(state.battlers[1]!.volatiles.healBlockTimer).toBe(0)
        expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_HEAL_BLOCK)).toBe(false)

        // Turn 6: Heal Block ended, Recover succeeds (restores 50% max HP = 50 -> 100)
        const out6 = executeTurn(state, [null, useMove(1, MOVE_RECOVER)], deps)
        const act6 = out6.actions.find((a) => a.battlerId === 1)!
        expect(act6.cancelledBy).toBeNull()
        expect(state.battlers[1]!.mon.hp).toBe(100)
      })

      it('Heal Block fails if target already has Heal Block (Cmd_sethealblock:4971)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_HEAL_BLOCK', null, null, null], pp: [15, 0, 0, 0] },
            { spe: 50 },
          ],
          rng,
        )
        state.battlers[1]!.statuses3 |= STATUS3_HEAL_BLOCK
        const out = executeTurn(state, [useMove(1, MOVE_HEAL_BLOCK), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
      })

      it('Heal Block fails against an Aroma Veil target (jumpifabilitystatusimmunity)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_HEAL_BLOCK', null, null, null], pp: [15, 0, 0, 0] },
            { spe: 50, abilities: { ability: ABILITY_AROMA_VEIL, innates: [null, null, null] } },
          ],
          rng,
        )
        const out = executeTurn(state, [useMove(1, MOVE_HEAL_BLOCK), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_HEAL_BLOCK)).toBe(false)
      })
    })

    describe('Cycle 53: EFFECT_EMBARGO (BattleScript_EffectEmbargo, Cmd_setembargo, ENDTURN_EMBARGO)', () => {
      it('Embargo sets STATUS3_EMBARGO and wears off after 5 turns', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_EMBARGO', null, null, null], pp: [15, 0, 0, 0] },
            { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
          ],
          rng,
        )

        // Turn 1: Battler 0 uses Embargo
        const out1 = executeTurn(state, [useMove(1, MOVE_EMBARGO), null], deps)
        const act1 = out1.actions.find((a) => a.battlerId === 0)!
        expect(act1.missed).toBe(false)
        expect(state.battlers[0]!.mon.pp[0]).toBe(14)
        expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_EMBARGO)).toBe(true)
        // Starts at 5, decremented by ENDTURN_EMBARGO to 4
        expect(state.battlers[1]!.volatiles.embargoTimer).toBe(4)

        // Turns 2-4: timer decrements each turn
        executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        expect(state.battlers[1]!.volatiles.embargoTimer).toBe(3)

        executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        expect(state.battlers[1]!.volatiles.embargoTimer).toBe(2)

        executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        expect(state.battlers[1]!.volatiles.embargoTimer).toBe(1)

        // Turn 5: decrements to 0, clears STATUS3_EMBARGO
        executeTurn(state, [null, useMove(1, MOVE_TACKLE)], deps)
        expect(state.battlers[1]!.volatiles.embargoTimer).toBe(0)
        expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_EMBARGO)).toBe(false)
      })

      it('Embargo fails if target already has Embargo (Cmd_setembargo:11191)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_EMBARGO', null, null, null], pp: [15, 0, 0, 0] },
            { spe: 50 },
          ],
          rng,
        )
        state.battlers[1]!.statuses3 |= STATUS3_EMBARGO
        const out = executeTurn(state, [useMove(1, MOVE_EMBARGO), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
      })
    })

    describe('Cycle 53: EFFECT_FOCUS_ENERGY (BattleScript_EffectFocusEnergy, VARIOUS_INCREASE_CRIT)', () => {
      it('Focus Energy raises crit stage by 2 (capped at 3)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_FOCUS_ENERGY', null, null, null], pp: [30, 0, 0, 0] },
            { spe: 50 },
          ],
          rng,
        )

        // Turn 1: Focus Energy raises critBoost by 2 (0 -> 2)
        const out1 = executeTurn(state, [useMove(1, MOVE_FOCUS_ENERGY), null], deps)
        const act1 = out1.actions.find((a) => a.battlerId === 0)!
        expect(act1.missed).toBe(false)
        expect(state.battlers[0]!.mon.pp[0]).toBe(29)
        expect(state.battlers[0]!.volatiles.critBoost).toBe(2)

        // Turn 2: Second Focus Energy raises critBoost from 2 to 3 (capped at 3)
        const out2 = executeTurn(state, [useMove(1, MOVE_FOCUS_ENERGY), null], deps)
        const act2 = out2.actions.find((a) => a.battlerId === 0)!
        expect(act2.missed).toBe(false)
        expect(state.battlers[0]!.mon.pp[0]).toBe(28)
        expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
      })

      it('Focus Energy fails when already at maximum critBoost (3)', () => {
        const deps = testDeps()
        const rng = countingRng()
        const state = battle(
          [
            { spe: 100, moves: ['MOVE_FOCUS_ENERGY', null, null, null], pp: [30, 0, 0, 0] },
            { spe: 50 },
          ],
          rng,
        )
        state.battlers[0]!.volatiles.critBoost = 3
        const out = executeTurn(state, [useMove(1, MOVE_FOCUS_ENERGY), null], deps)
        const act = out.actions.find((a) => a.battlerId === 0)!
        expect(act.missed).toBe(true)
        expect(state.battlers[0]!.mon.pp[0]).toBe(29)
        expect(state.battlers[0]!.volatiles.critBoost).toBe(3)
      })
    })

    describe('Field-effect moves (cycle 54)', () => {
      describe('Terrain moves', () => {
        it('Electric Terrain sets the terrain, started flag, and timer (8 turns default, 12 with Terrain Extender)', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_ELECTRIC_TERRAIN', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_ELECTRIC_TERRAIN), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(true)
          expect(state.field.timers.terrainTimer).toBe(8)
          expect(state.field.timers.started.terrain).toBe(true)

          // With Terrain Extender
          const extDeps = {
            ...testDeps(),
            grounding: {
              ...GROUNDING,
              holdEffectOf: (id: number) => (id === 0 ? 'HOLD_EFFECT_TERRAIN_EXTENDER' : null),
            },
          }
          const extState = battle(
            [
              { moves: ['MOVE_ELECTRIC_TERRAIN', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          executeTurn(extState, [useMove(1, MOVE_ELECTRIC_TERRAIN), null], extDeps)
          expect(hasFlag(extState.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(true)
          expect(extState.field.timers.terrainTimer).toBe(12)
        })

        it('A second terrain move replaces the first, and casting the same terrain fails', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_ELECTRIC_TERRAIN', 'MOVE_GRASSY_TERRAIN', null, null], pp: [10, 10, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Turn 1: Electric Terrain sets electric
          executeTurn(state, [useMove(1, MOVE_ELECTRIC_TERRAIN), null], deps)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(true)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)).toBe(false)

          // Turn 2: Grassy Terrain replaces electric
          executeTurn(state, [useMove(2, MOVE_GRASSY_TERRAIN), null], deps)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)).toBe(false)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)).toBe(true)
          expect(state.field.timers.terrainTimer).toBe(8)

          // Turn 3: Casting Grassy Terrain while already active fails (missed: true, costs PP)
          const out3 = executeTurn(state, [useMove(2, MOVE_GRASSY_TERRAIN), null], deps)
          const act3 = out3.actions.find((a) => a.battlerId === 0)!
          expect(act3.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[1]).toBe(8)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)).toBe(true)
        })
      })

      describe('Rooms', () => {
        it('Trick Room is set for 5 turns, then toggled off by a second use', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TRICK_ROOM', null, null, null], pp: [5, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Turn 1: Sets Trick Room
          const out1 = executeTurn(state, [useMove(1, MOVE_TRICK_ROOM), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM)).toBe(true)
          expect(state.field.timers.trickRoomTimer).toBe(5)
          expect(state.field.timers.started.trickRoom).toBe(true)

          // Turn 2: Second use toggles Trick Room off
          const out2 = executeTurn(state, [useMove(1, MOVE_TRICK_ROOM), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(3)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM)).toBe(false)
          expect(state.field.timers.trickRoomTimer).toBe(0)
        })

        it('Trick Room flips turn order: slower battler moves before faster battler', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Battler 0 is slower (spe: 40), Battler 1 is faster (spe: 100)
          const state = battle(
            [
              { spe: 40, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
              { spe: 100, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
            ],
            rng,
          )

          // Without Trick Room: faster battler 1 moves first
          const outNormal = executeTurn(state, [useMove(1, MOVE_TACKLE), useMove(1, MOVE_TACKLE)], deps)
          expect(outNormal.actions[0]!.battlerId).toBe(1)
          expect(outNormal.actions[1]!.battlerId).toBe(0)

          // Under Trick Room: slower battler 0 moves first
          state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM)
          state.field.timers.trickRoomTimer = 5

          const outTR = executeTurn(state, [useMove(1, MOVE_TACKLE), useMove(1, MOVE_TACKLE)], deps)
          expect(outTR.actions[0]!.battlerId).toBe(0)
          expect(outTR.actions[1]!.battlerId).toBe(1)
        })
      })

      describe('Gravity', () => {
        it('Gravity grounds a Flying type and cancels moves named by IsGravityPreventingMove', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Battler 0 uses Gravity (spe: 50)
          // Battler 1 is Flying-type with MOVE_FLY (spe: 100)
          const state = battle(
            [
              { spe: 50, moves: ['MOVE_GRAVITY', null, null, null], pp: [5, 0, 0, 0] },
              { spe: 100, types: ['FLYING', 'MYSTERY', 'MYSTERY'], moves: ['MOVE_FLY', null, null, null], pp: [15, 0, 0, 0] },
            ],
            rng,
          )

          // Before Gravity: Flying type is not grounded
          expect(isBattlerGrounded(state, 1, deps.grounding)).toBe(false)

          // Turn 1: Battler 0 activates Gravity
          const out1 = executeTurn(state, [useMove(1, MOVE_GRAVITY), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_GRAVITY)).toBe(true)
          expect(state.field.timers.gravityTimer).toBe(5)

          // Flying type is now grounded under Gravity
          expect(isBattlerGrounded(state, 1, deps.grounding)).toBe(true)

          // Turn 2: Battler 1 tries to use MOVE_FLY -> cancelled by CANCELLER_GRAVITY
          const out2 = executeTurn(state, [null, useMove(1, MOVE_FLY)], deps)
          const actFly = out2.actions.find((a) => a.battlerId === 1)!
          expect(actFly.cancelledBy).toBe('GRAVITY')
          expect(actFly.targetDamage).toBeNull()

          // Second Gravity use fails (missed: true, costs PP)
          const out3 = executeTurn(state, [useMove(1, MOVE_GRAVITY), null], deps)
          const act3 = out3.actions.find((a) => a.battlerId === 0)!
          expect(act3.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(3)
        })
      })

      describe('Haze', () => {
        it('Haze resets all stat stages across all battlers to default stage 6', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_HAZE', null, null, null], pp: [30, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Battler 0 has +2 Atk and -1 Def; Battler 1 has +3 SpAtk and -2 Spe
          state.battlers[0]!.mon.statStages[STAT_ATK] = 8
          state.battlers[0]!.mon.statStages[STAT_DEF] = 5
          state.battlers[1]!.mon.statStages[STAT_SPATK] = 9
          state.battlers[1]!.mon.statStages[STAT_SPEED] = 4

          const out = executeTurn(state, [useMove(1, MOVE_HAZE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(29)

          // All stats normalised back to DEFAULT_STAT_STAGE (6)
          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
          expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
        })
      })

      describe('Defog', () => {
        it('Defog lowers target evasion, clears target screens, and clears hazards on both sides', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_DEFOG', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Set screens on target side (side 1)
          state.sides[1]!.statuses = setFlag(state.sides[1]!.statuses, SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN)
          state.sides[1]!.timers.reflectTimer = 5
          state.sides[1]!.timers.lightscreenTimer = 5

          // Set hazards on side 0 and side 1
          state.sides[0]!.statuses = setFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES | SIDE_STATUS_TOXIC_SPIKES)
          state.sides[0]!.timers.spikesAmount = 1
          state.sides[0]!.timers.toxicSpikesAmount = 1
          state.sides[1]!.statuses = setFlag(state.sides[1]!.statuses, SIDE_STATUS_STEALTH_ROCK | SIDE_STATUS_STICKY_WEB)
          state.sides[1]!.timers.stealthRockType = 1
          state.sides[1]!.timers.stickyWebTimer = 1

          const out = executeTurn(state, [useMove(1, MOVE_DEFOG), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(14)

          // Evasion lowered by 1 stage (from 6 to 5)
          expect(state.battlers[1]!.mon.statStages[STAT_EVASION]).toBe(5)
          expect(act.statChanges).toEqual([{ battlerId: 1, stat: STAT_EVASION, change: -1 }])

          // Target screens cleared
          expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_REFLECT)).toBe(false)
          expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(false)
          expect(state.sides[1]!.timers.reflectTimer).toBe(0)
          expect(state.sides[1]!.timers.lightscreenTimer).toBe(0)

          // Hazards cleared on both sides
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(false)
          expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
          expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_STICKY_WEB)).toBe(false)
        })

        it('Defog blows the fog away, and ENDTURN_FOG brings it back that same end of turn', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_DEFOG', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          state.field.weather = WEATHER_FOG_TEMPORARY
          state.field.weatherDuration = 5

          const out = executeTurn(state, [useMove(1, MOVE_DEFOG), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          // ClearDefogHazards sets fogReturnTimer = weatherDuration - 1 = 4 (battle_script_commands.c:6554);
          // ENDTURN_FOG's `!gBattleWeather && fogReturnTimer` branch (battle_util.c:2037-2046) then
          // restores temporary fog for those 4 turns and zeroes the return timer.
          expect(state.field.weather).toBe(WEATHER_FOG_TEMPORARY)
          expect(state.field.weatherDuration).toBe(4)
          expect(state.field.timers.fogReturnTimer).toBe(0)
        })

        it('Defog leaves Smokescreen up (DEFOG_CLEAR tests SIDE_STATUS_LIGHTSCREEN for it, battle_script_commands.c:6519)', () => {
          const state = battle([{ moves: ['MOVE_DEFOG', null, null, null], pp: [15, 0, 0, 0] }, { spe: 50 }], countingRng())
          state.sides[1]!.statuses = setFlag(setFlag(state.sides[1]!.statuses, SIDE_STATUS_REFLECT), SIDE_STATUS_SMOKESCREEN)
          state.sides[1]!.timers.reflectTimer = 5
          state.sides[1]!.timers.smokescreenTimer = 5
          executeTurn(state, [useMove(1, MOVE_DEFOG), null], testDeps())
          expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_REFLECT)).toBe(false)
          expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_SMOKESCREEN)).toBe(true)
        })

        it('Defog fails when target evasion is at min and no hazards/screens/fog exist', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_DEFOG', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          state.battlers[1]!.mon.statStages[STAT_EVASION] = MIN_STAT_STAGE

          const out = executeTurn(state, [useMove(1, MOVE_DEFOG), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(14) // PP still deducted
        })
      })

      describe('Clear Skies', () => {
        it('Clear Skies sets clearSkiesTimer to 5, suppresses weather, and second use fails', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_CLEAR_SKIES', null, null, null], pp: [5, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          state.field.weather = WEATHER_RAIN_TEMPORARY
          state.field.weatherDuration = 5

          // Turn 1: Sets Clear Skies
          const out1 = executeTurn(state, [useMove(1, MOVE_CLEAR_SKIES), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          expect(state.field.timers.clearSkiesTimer).toBe(5)
          expect(state.field.timers.started.clearSkiesTimer).toBe(true)

          // Weather is suppressed while clearSkiesTimer is active
          expect(isBattlerWeatherAffected(state, 0, state.field.weather, deps)).toBe(false)

          // Turn 2: Second use fails while timer is active
          const out2 = executeTurn(state, [useMove(1, MOVE_CLEAR_SKIES), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(3)
        })
      })

      describe('EFFECT_SUBSTITUTE', () => {
        it('Substitute costs 1/4 max HP and fails at or below that HP; a second Substitute fails', () => {
          // BattleScript_EffectSubstitute (data/battle_scripts_1.s:4506-4530)
          // Cmd_setsubstitute (src/battle_script_commands.c:10535-10550)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { hp: 100, maxHp: 100, moves: ['MOVE_SUBSTITUTE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // 1. Success: costs 1/4 max HP (25), sets STATUS2_SUBSTITUTE and substituteHp = 25
          const out1 = executeTurn(state, [useMove(1, MOVE_SUBSTITUTE), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(act1.attackerDamage).toBe(25)
          expect(state.battlers[0]!.mon.hp).toBe(75)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)
          expect(state.battlers[0]!.volatiles.substituteHp).toBe(25)

          // 2. Already has substitute: second use fails, PP is deducted, HP is not deducted
          const out2 = executeTurn(state, [useMove(1, MOVE_SUBSTITUTE), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(true)
          expect(state.battlers[0]!.mon.hp).toBe(75)
          expect(state.battlers[0]!.mon.pp[0]).toBe(8)
          expect(state.battlers[0]!.volatiles.substituteHp).toBe(25)

          // 3. Fails at or below 1/4 max HP (<= 25 HP)
          const stateLow = battle(
            [
              { hp: 25, maxHp: 100, moves: ['MOVE_SUBSTITUTE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            countingRng(),
          )
          const outLow = executeTurn(stateLow, [useMove(1, MOVE_SUBSTITUTE), null], deps)
          const actLow = outLow.actions.find((a) => a.battlerId === 0)!
          expect(actLow.missed).toBe(true)
          expect(stateLow.battlers[0]!.mon.hp).toBe(25)
          expect(stateLow.battlers[0]!.mon.pp[0]).toBe(9)
          expect(hasFlag(stateLow.battlers[0]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(false)
          expect(stateLow.battlers[0]!.volatiles.substituteHp).toBe(0)

          // 4. Succeeds at 26 HP (> 25 HP)
          const stateCanAfford = battle(
            [
              { hp: 26, maxHp: 100, moves: ['MOVE_SUBSTITUTE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            countingRng(),
          )
          const outCanAfford = executeTurn(stateCanAfford, [useMove(1, MOVE_SUBSTITUTE), null], deps)
          const actCanAfford = outCanAfford.actions.find((a) => a.battlerId === 0)!
          expect(actCanAfford.missed).toBe(false)
          expect(stateCanAfford.battlers[0]!.mon.hp).toBe(1)
          expect(hasFlag(stateCanAfford.battlers[0]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)
          expect(stateCanAfford.battlers[0]!.volatiles.substituteHp).toBe(25)
        })
      })

      describe('EFFECT_AQUA_RING', () => {
        it('Aqua Ring sets STATUS3_AQUA_RING, heals 1/16 max HP at end of turn, and second use fails', () => {
          // BattleScript_EffectAquaRing (data/battle_scripts_1.s:2670-2679)
          // ENDTURN_AQUA_RING (battle_util.c:2435-2443)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { hp: 50, maxHp: 100, moves: ['MOVE_AQUA_RING', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Turn 1: Uses Aqua Ring. End-turn heals 1/16 max HP (100 / 16 = 6 HP) -> 56 HP
          const out1 = executeTurn(state, [useMove(1, MOVE_AQUA_RING), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_AQUA_RING)).toBe(true)
          expect(state.battlers[0]!.mon.hp).toBe(56)

          // Turn 2: Second use fails, still heals at end of turn (56 + 6 = 62 HP)
          const out2 = executeTurn(state, [useMove(1, MOVE_AQUA_RING), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(18)
          expect(state.battlers[0]!.mon.hp).toBe(62)
        })
      })

      describe('EFFECT_INGRAIN', () => {
        it('Ingrain sets STATUS3_ROOTED, heals 1/8 max HP at end of turn, and second use fails', () => {
          // BattleScript_EffectIngrain (data/battle_scripts_1.s:6326-6336)
          // ENDTURN_INGRAIN (battle_util.c:2426-2434)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { hp: 50, maxHp: 100, moves: ['MOVE_INGRAIN', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Turn 1: Uses Ingrain. End-turn heals 1/8 max HP (100 / 8 = 12 HP) -> 62 HP
          const out1 = executeTurn(state, [useMove(1, MOVE_INGRAIN), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ROOTED)).toBe(true)
          expect(state.battlers[0]!.mon.hp).toBe(62)

          // Turn 2: Second use fails, still heals at end of turn (62 + 12 = 74 HP)
          const out2 = executeTurn(state, [useMove(1, MOVE_INGRAIN), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(18)
          expect(state.battlers[0]!.mon.hp).toBe(74)
        })
      })

      describe('EFFECT_MAGNET_RISE', () => {
        it('Magnet Rise sets STATUS3_MAGNET_RISE, sets timer to 5, and wears off after duration', () => {
          // BattleScript_EffectMagnetRise (data/battle_scripts_1.s:2627-2636)
          // ENDTURN_MAGNET_RISE (battle_util.c:2875-2884)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MAGNET_RISE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Turn 1: Uses Magnet Rise (timer 5 -> decrements to 4 at end of turn)
          const out1 = executeTurn(state, [useMove(1, MOVE_MAGNET_RISE), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MAGNET_RISE)).toBe(true)
          expect(state.battlers[0]!.volatiles.magnetRiseTimer).toBe(4)

          // Turn 2: timer 4 -> 3
          executeTurn(state, [null, null], deps)
          expect(state.battlers[0]!.volatiles.magnetRiseTimer).toBe(3)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MAGNET_RISE)).toBe(true)

          // Turn 3: timer 3 -> 2
          executeTurn(state, [null, null], deps)
          expect(state.battlers[0]!.volatiles.magnetRiseTimer).toBe(2)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MAGNET_RISE)).toBe(true)

          // Turn 4: timer 2 -> 1
          executeTurn(state, [null, null], deps)
          expect(state.battlers[0]!.volatiles.magnetRiseTimer).toBe(1)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MAGNET_RISE)).toBe(true)

          // Turn 5: timer 1 -> 0, STATUS3_MAGNET_RISE clears!
          executeTurn(state, [null, null], deps)
          expect(state.battlers[0]!.volatiles.magnetRiseTimer).toBe(0)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MAGNET_RISE)).toBe(false)
        })
      })

      describe('EFFECT_CHARGE', () => {
        it('Charge sets STATUS3_CHARGED_UP and raises SpDef by 1 stage', () => {
          // BattleScript_EffectCharge (data/battle_scripts_1.s:6222-6240)
          // Cmd_setcharge (src/battle_script_commands.c:11620-11623)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_CHARGE', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_CHARGE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
        })
      })

      describe('EFFECT_LOCK_ON', () => {
        it('Lock-On makes the next move skip the accuracy draw and lands 50% accurate Zap Cannon', () => {
          // BattleScript_EffectLockOn (data/battle_scripts_1.s:4739-4751)
          // Cmd_setalwayshitflag (src/battle_script_commands.c:10827-10832)
          // ENDTURN_LOCK_ON (battle_util.c:2809-2812)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_LOCK_ON', 'MOVE_ZAP_CANNON', null, null], pp: [5, 5, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Turn 1: Uses Lock-On on target.
          const out1 = executeTurn(state, [useMove(1, MOVE_LOCK_ON), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          // End of turn 1: counter decremented by 1 turn, still non-zero
          expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_ALWAYS_HITS)).toBe(true)
          expect(state.battlers[1]!.volatiles.battlerWithSureHit).toBe(0)

          // Turn 2: Zap Cannon (50% accuracy) under an rng that always rolls 99 -- a miss if the
          // accuracy roll were drawn. Lock-On makes it a sure hit (STATUS3_ALWAYS_HITS).
          state.rng = { random16: () => 99 }
          const out2 = executeTurn(state, [useMove(1, MOVE_ZAP_CANNON), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[1]).toBe(4)
          // At end of turn 2, Lock-On expires
          expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_ALWAYS_HITS)).toBe(false)
        })

        it('Lock-On fails when target is behind Substitute', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_LOCK_ON', null, null, null], pp: [5, 0, 0, 0] },
              { status2: STATUS2_SUBSTITUTE, spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_LOCK_ON), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_ALWAYS_HITS)).toBe(false)
        })
      })

      describe('EFFECT_LASER_FOCUS', () => {
        it('Laser Focus sets STATUS3_LASER_FOCUS and wears off after 2 turns', () => {
          // BattleScript_EffectLaserFocus (data/battle_scripts_1.s:1037-1047)
          // ENDTURN_LASER_FOCUS (battle_util.c:2855-2861)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_LASER_FOCUS', null, null, null], pp: [30, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Turn 1: Uses Laser Focus (timer 2 -> decrements to 1 at end of turn)
          const out1 = executeTurn(state, [useMove(1, MOVE_LASER_FOCUS), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(29)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_LASER_FOCUS)).toBe(true)
          expect(state.battlers[0]!.volatiles.laserFocusTimer).toBe(1)

          // Turn 2: Still active during turn. At end of turn decrements to 0, wears off!
          executeTurn(state, [null, null], deps)
          expect(state.battlers[0]!.volatiles.laserFocusTimer).toBe(0)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_LASER_FOCUS)).toBe(false)
        })
      })

      describe('EFFECT_MEAN_LOOK', () => {
        it('Mean Look sets STATUS2_ESCAPE_PREVENTION, prevents target escape, fails on second use, fails on Ghost, and fails on substitute', () => {
          // BattleScript_EffectMeanLook (data/battle_scripts_1.s:4890-4907)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MEAN_LOOK', 'MOVE_SUBSTITUTE', null, null], pp: [5, 10, 0, 0] },
              { moves: ['MOVE_MEAN_LOOK', null, null, null], pp: [5, 0, 0, 0], spe: 50 },
            ],
            rng,
          )

          expect(canBattlerEscape(state, 1, deps)).toBe(true)

          // Battler 0 uses Mean Look on Battler 1
          const out1 = executeTurn(state, [useMove(1, MOVE_MEAN_LOOK), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
          expect(state.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)
          expect(canBattlerEscape(state, 1, deps)).toBe(false)

          // Second use fails (jumpifstatus2 BS_TARGET, STATUS2_ESCAPE_PREVENTION)
          const out2 = executeTurn(state, [useMove(1, MOVE_MEAN_LOOK), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(3)

          // Mean Look fails on Ghost type (jumpiftype BS_TARGET, TYPE_GHOST)
          const ghostState = battle(
            [
              { moves: ['MOVE_MEAN_LOOK', null, null, null], pp: [5, 0, 0, 0] },
              { types: ['GHOST', 'MYSTERY', 'MYSTERY'], spe: 50 },
            ],
            rng,
          )
          const outGhost = executeTurn(ghostState, [useMove(1, MOVE_MEAN_LOOK), null], deps)
          const actGhost = outGhost.actions.find((a) => a.battlerId === 0)!
          expect(actGhost.missed).toBe(true)
          expect(hasFlag(ghostState.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
          expect(canBattlerEscape(ghostState, 1, deps)).toBe(true)

          // Mean Look fails if target has a Substitute (jumpifsubstituteblocks)
          const subState = battle(
            [
              { moves: ['MOVE_MEAN_LOOK', null, null, null], pp: [5, 0, 0, 0], spe: 50 },
              { moves: ['MOVE_SUBSTITUTE', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
            ],
            rng,
          )
          // Battler 1 sets up Substitute first
          executeTurn(subState, [null, useMove(1, MOVE_SUBSTITUTE)], deps)
          expect(hasFlag(subState.battlers[1]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)
          // Battler 0 uses Mean Look into Substitute -> blocked
          const outSub = executeTurn(subState, [useMove(1, MOVE_MEAN_LOOK), null], deps)
          const actSub = outSub.actions.find((a) => a.battlerId === 0)!
          expect(actSub.missed).toBe(true)
          expect(hasFlag(subState.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
        })
      })

      describe('EFFECT_FORESIGHT', () => {
        it('Foresight sets STATUS4_FORESIGHT and fails on second use', () => {
          // BattleScript_EffectForesight (data/battle_scripts_1.s:5069-5082)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FORESIGHT', null, null, null], pp: [40, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out1 = executeTurn(state, [useMove(1, MOVE_FORESIGHT), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(39)
          expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FORESIGHT)).toBe(true)

          // Second use fails (jumpifstatus4 BS_TARGET, STATUS4_FORESIGHT)
          const out2 = executeTurn(state, [useMove(1, MOVE_FORESIGHT), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(38)
        })
      })

      describe('EFFECT_MIRACLE_EYE', () => {
        it('Miracle Eye sets STATUS3_MIRACLE_EYED and fails on second use', () => {
          // BattleScript_EffectMiracleEye (data/battle_scripts_1.s:2705-2712)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MIRACLE_EYE', null, null, null], pp: [40, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out1 = executeTurn(state, [useMove(1, MOVE_MIRACLE_EYE), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(39)
          expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_MIRACLE_EYED)).toBe(true)

          // Second use fails (setmiracleeye BattleScript_ButItFailed)
          const out2 = executeTurn(state, [useMove(1, MOVE_MIRACLE_EYE), null], deps)
          const act2 = out2.actions.find((a) => a.battlerId === 0)!
          expect(act2.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(38)
        })
      })

      describe('EFFECT_PERISH_SONG', () => {
        it('Perish Song faints both sides after the count ends, respecting Soundproof', () => {
          // BattleScript_EffectPerishSong (data/battle_scripts_1.s:5083-5100)
          // HandleWishPerishSongOnTurnEnd (battle_util.c:3032-3053, battle_main.c:3489)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_PERISH_SONG', null, null, null], pp: [5, 0, 0, 0], hp: 100, maxHp: 100 },
              { hp: 100, maxHp: 100, spe: 50 },
            ],
            rng,
          )

          // Turn 1: Battler 0 uses Perish Song. Sets timer 3, decrements to 2 at end of turn.
          const out1 = executeTurn(state, [useMove(1, MOVE_PERISH_SONG), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
          expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
          expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(2)
          expect(state.battlers[1]!.volatiles.perishSongTimer).toBe(2)
          expect(state.battlers[0]!.mon.hp).toBe(100)
          expect(state.battlers[1]!.mon.hp).toBe(100)

          // Turn 2: Decrements 2 -> 1
          executeTurn(state, [null, null], deps)
          expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(1)
          expect(state.battlers[1]!.volatiles.perishSongTimer).toBe(1)
          expect(state.battlers[0]!.mon.hp).toBe(100)
          expect(state.battlers[1]!.mon.hp).toBe(100)

          // Turn 3: Decrements 1 -> 0
          executeTurn(state, [null, null], deps)
          expect(state.battlers[0]!.volatiles.perishSongTimer).toBe(0)
          expect(state.battlers[1]!.volatiles.perishSongTimer).toBe(0)
          expect(state.battlers[0]!.mon.hp).toBe(100)
          expect(state.battlers[1]!.mon.hp).toBe(100)

          // Turn 4: Timer was 0 -> both faint!
          executeTurn(state, [null, null], deps)
          expect(state.battlers[0]!.mon.hp).toBe(0)
          expect(state.battlers[1]!.mon.hp).toBe(0)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(false)
          expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_PERISH_SONG)).toBe(false)

          // Soundproof immunity: Battler 1 has ABILITY_SOUNDPROOF
          const spState = battle(
            [
              { moves: ['MOVE_PERISH_SONG', null, null, null], pp: [5, 0, 0, 0] },
              { abilities: { ability: ABILITY_SOUNDPROOF, innates: [null, null, null] }, spe: 50 },
            ],
            rng,
          )
          const spOut = executeTurn(spState, [useMove(1, MOVE_PERISH_SONG), null], deps)
          const spAct = spOut.actions.find((a) => a.battlerId === 0)!
          expect(spAct.missed).toBe(false)
          expect(hasFlag(spState.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
          expect(hasFlag(spState.battlers[1]!.statuses3, STATUS3_PERISH_SONG)).toBe(false)

          // If all active battlers are Soundproof / unaffected, Perish Song fails
          const allSpState = battle(
            [
              { moves: ['MOVE_PERISH_SONG', null, null, null], pp: [5, 0, 0, 0], abilities: { ability: ABILITY_SOUNDPROOF, innates: [null, null, null] } },
              { abilities: { ability: ABILITY_SOUNDPROOF, innates: [null, null, null] }, spe: 50 },
            ],
            rng,
          )
          const allSpOut = executeTurn(allSpState, [useMove(1, MOVE_PERISH_SONG), null], deps)
          const allSpAct = allSpOut.actions.find((a) => a.battlerId === 0)!
          expect(allSpAct.missed).toBe(true)
          expect(allSpState.battlers[0]!.mon.pp[0]).toBe(4) // costs PP
        })
      })

      describe('EFFECT_MINIMIZE', () => {
        it('Minimize sets STATUS3_MINIMIZED and raises evasion by 2 stages', () => {
          // BattleScript_EffectMinimize (data/battle_scripts_1.s:4922-4927)
          // Cmd_setminimize (battle_script_commands.c:11573-11577)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MINIMIZE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out1 = executeTurn(state, [useMove(1, MOVE_MINIMIZE), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_MINIMIZED)).toBe(true)
          // Neutral evasion stage is 6 (DEFAULT_STAT_STAGE). +2 stages raises to 8.
          expect(state.battlers[0]!.mon.statStages[STAT_EVASION]).toBe(8)
          expect(act1.statChanges).toEqual([{ battlerId: 0, stat: STAT_EVASION, change: 2 }])
        })
      })
    })
  })
})
