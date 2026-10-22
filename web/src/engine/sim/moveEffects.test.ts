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
  SIDE_STATUS_LUCKY_CHANT,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SAFEGUARD,
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
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_TOXIC_POISON,
  SIDE_STATUS_SMOKESCREEN,
  STATUS2_CONFUSION,
  STATUS2_CURSED,
  STATUS2_DESTINY_BOND,
  STATUS2_ENRAGED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_INFATUATION,
  STATUS2_MULTIPLETURNS,
  STATUS2_NIGHTMARE,
  STATUS2_POWDER,
  STATUS2_SUBSTITUTE,
  STATUS2_TORMENT,
  STATUS3_ALWAYS_HITS,
  STATUS3_AQUA_RING,
  STATUS3_CHARGED_UP,
  STATUS3_EMBARGO,
  STATUS3_GASTRO_ACID,
  STATUS3_GRUDGE,
  STATUS3_HEAL_BLOCK,
  STATUS3_IMPRISONED_OTHERS,
  STATUS3_LASER_FOCUS,
  STATUS3_MAGNET_RISE,
  STATUS3_MINIMIZED,
  STATUS3_MIRACLE_EYED,
  STATUS3_PERISH_SONG,
  STATUS3_ROOTED,
  STATUS3_POWER_TRICK,
  STATUS3_TELEKINESIS,
  STATUS4_CUTTHROAT,
  STATUS4_ELECTRIFIED,
  STATUS4_FEAR,
  STATUS4_FORESIGHT,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRAVITY,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  STATUS_FIELD_FAIRY_LOCK,
  STATUS_FIELD_MUDSPORT,
  STATUS_FIELD_WATERSPORT,
  SPORT_DURATION,
  QUASH_DURATION,
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
    type2: m.type2 as string | null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
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
const MOVE_WISH = requireMove('MOVE_WISH')
const MOVE_HEAL_BELL = requireMove('MOVE_HEAL_BELL')
const MOVE_AROMATHERAPY = requireMove('MOVE_AROMATHERAPY')
const MOVE_REFRESH = requireMove('MOVE_REFRESH')
const MOVE_PURIFY = requireMove('MOVE_PURIFY')
const MOVE_TAKE_HEART = requireMove('MOVE_TAKE_HEART')
const MOVE_REST = requireMove('MOVE_REST')
const MOVE_HEAL_PULSE = requireMove('MOVE_HEAL_PULSE')
const MOVE_FLORAL_HEALING = requireMove('MOVE_FLORAL_HEALING')
const MOVE_PSYCHO_SHIFT = requireMove('MOVE_PSYCHO_SHIFT')
const MOVE_STOCKPILE = requireMove('MOVE_STOCKPILE')
const MOVE_SWALLOW = requireMove('MOVE_SWALLOW')
const MOVE_PSYCH_UP = requireMove('MOVE_PSYCH_UP')
const MOVE_POWER_SWAP = requireMove('MOVE_POWER_SWAP')
const MOVE_GUARD_SWAP = requireMove('MOVE_GUARD_SWAP')
const MOVE_SPEED_SWAP = requireMove('MOVE_SPEED_SWAP')
const MOVE_HEART_SWAP = requireMove('MOVE_HEART_SWAP')
const MOVE_POWER_SPLIT = requireMove('MOVE_POWER_SPLIT')
const MOVE_GUARD_SPLIT = requireMove('MOVE_GUARD_SPLIT')
const MOVE_TOPSY_TURVY = requireMove('MOVE_TOPSY_TURVY')
const MOVE_ACUPRESSURE = requireMove('MOVE_ACUPRESSURE')
const MOVE_CLANGOROUS_SOUL = requireMove('MOVE_CLANGOROUS_SOUL')
const MOVE_FILLET_AWAY = requireMove('MOVE_FILLET_AWAY')
const MOVE_NO_RETREAT = requireMove('MOVE_NO_RETREAT')
const MOVE_TIDY_UP = requireMove('MOVE_TIDY_UP')
const MOVE_VENOM_DRENCH = requireMove('MOVE_VENOM_DRENCH')
const MOVE_TOXIC_THREAD = requireMove('MOVE_TOXIC_THREAD')
const MOVE_TAR_SHOT = requireMove('MOVE_TAR_SHOT')
const MOVE_SPICY_EXTRACT = requireMove('MOVE_SPICY_EXTRACT')
const MOVE_MEMENTO = requireMove('MOVE_MEMENTO')
const MOVE_SOAK = requireMove('MOVE_SOAK')
const MOVE_MAGIC_POWDER = requireMove('MOVE_MAGIC_POWDER')
const MOVE_FORESTS_CURSE = requireMove('MOVE_FORESTS_CURSE')
const MOVE_TRICK_OR_TREAT = requireMove('MOVE_TRICK_OR_TREAT')
const MOVE_INCITE = requireMove('MOVE_INCITE')
const MOVE_CONVERSION = requireMove('MOVE_CONVERSION')
const MOVE_REFLECT_TYPE = requireMove('MOVE_REFLECT_TYPE')
const MOVE_LUCKY_CHANT = requireMove('MOVE_LUCKY_CHANT')
const MOVE_QUICK_GUARD = requireMove('MOVE_QUICK_GUARD')
const MOVE_MAT_BLOCK = requireMove('MOVE_MAT_BLOCK')
const MOVE_SMOKESCREEN = requireMove('MOVE_SMOKESCREEN')
const MOVE_MUD_SPORT = requireMove('MOVE_MUD_SPORT')
const MOVE_WATER_SPORT = requireMove('MOVE_WATER_SPORT')
const MOVE_FAIRY_LOCK = requireMove('MOVE_FAIRY_LOCK')
const MOVE_GASTRO_ACID = requireMove('MOVE_GASTRO_ACID')
const MOVE_SIMPLE_BEAM = requireMove('MOVE_SIMPLE_BEAM')
const MOVE_WORRY_SEED = requireMove('MOVE_WORRY_SEED')
const MOVE_ENTRAINMENT = requireMove('MOVE_ENTRAINMENT')
const MOVE_ROLE_PLAY = requireMove('MOVE_ROLE_PLAY')
const MOVE_SKILL_SWAP = requireMove('MOVE_SKILL_SWAP')
const MOVE_SPITE = requireMove('MOVE_SPITE')
const MOVE_GRUDGE = requireMove('MOVE_GRUDGE')
const MOVE_IMPRISON = requireMove('MOVE_IMPRISON')
const MOVE_TELEKINESIS = requireMove('MOVE_TELEKINESIS')
const MOVE_ELECTRIFY = requireMove('MOVE_ELECTRIFY')
const MOVE_POWER_TRICK = requireMove('MOVE_POWER_TRICK')
const MOVE_ION_DELUGE = requireMove('MOVE_ION_DELUGE')
const MOVE_POWDER = requireMove('MOVE_POWDER')
const MOVE_EMBER = requireMove('MOVE_EMBER')
const MOVE_CELEBRATE = requireMove('MOVE_CELEBRATE')
const MOVE_HOLD_HANDS = requireMove('MOVE_HOLD_HANDS')
const MOVE_AUTOTOMIZE = requireMove('MOVE_AUTOTOMIZE')
const MOVE_FLOWER_SHIELD = requireMove('MOVE_FLOWER_SHIELD')
const MOVE_ROTOTILLER = requireMove('MOVE_ROTOTILLER')
const MOVE_MAGNETIC_FLUX = requireMove('MOVE_MAGNETIC_FLUX')
const MOVE_COURT_CHANGE = requireMove('MOVE_COURT_CHANGE')
const MOVE_AFTER_YOU = requireMove('MOVE_AFTER_YOU')
const MOVE_QUASH = requireMove('MOVE_QUASH')
const MOVE_COACHING = requireMove('MOVE_COACHING')
const MOVE_AROMATIC_MIST = requireMove('MOVE_AROMATIC_MIST')
const MOVE_TEATIME = requireMove('MOVE_TEATIME')
const MOVE_STUFF_CHEEKS = requireMove('MOVE_STUFF_CHEEKS')
const MOVE_BESTOW = requireMove('MOVE_BESTOW')
const MOVE_CALTROPS = requireMove('MOVE_CALTROPS')
const MOVE_GEOMANCY = requireMove('MOVE_GEOMANCY')
const MOVE_KINESIS = requireMove('MOVE_KINESIS')
const MOVE_DRAIN_BRAIN = requireMove('MOVE_DRAIN_BRAIN')
const MOVE_WATERLOG = requireMove('MOVE_WATERLOG')
const MOVE_BATON_PASS = requireMove('MOVE_BATON_PASS')
const MOVE_TRICK = requireMove('MOVE_TRICK')
const MOVE_SWITCHEROO = requireMove('MOVE_SWITCHEROO')
const MOVE_SNATCH = requireMove('MOVE_SNATCH')
const MOVE_MAGIC_COAT = requireMove('MOVE_MAGIC_COAT')
const MOVE_ALLY_SWITCH = requireMove('MOVE_ALLY_SWITCH')
const MOVE_RAGE_POWDER = requireMove('MOVE_RAGE_POWDER')
const MOVE_SPOTLIGHT = requireMove('MOVE_SPOTLIGHT')

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
const ABILITY_COMATOSE = requireAbility('ABILITY_COMATOSE')
const ABILITY_INSOMNIA = requireAbility('ABILITY_INSOMNIA')
const ABILITY_VITAL_SPIRIT = requireAbility('ABILITY_VITAL_SPIRIT')
const ABILITY_MEGA_LAUNCHER = requireAbility('ABILITY_MEGA_LAUNCHER')
const ABILITY_DROUGHT = requireAbility('ABILITY_DROUGHT')
const ABILITY_WONDER_GUARD = requireAbility('ABILITY_WONDER_GUARD')
const ABILITY_PLUS = requireAbility('ABILITY_PLUS')
const ABILITY_MINUS = requireAbility('ABILITY_MINUS')
const ABILITY_STICKY_HOLD = requireAbility('ABILITY_STICKY_HOLD')
const ABILITY_MOLD_BREAKER = requireAbility('ABILITY_MOLD_BREAKER')

const ITEM_UTILITY_UMBRELLA = requireItem('ITEM_UTILITY_UMBRELLA')
const ITEM_BOOSTER_ENERGY = requireItem('ITEM_BOOSTER_ENERGY')
const ITEM_LIECHI_BERRY = requireItem('ITEM_LIECHI_BERRY')
const ITEM_SITRUS_BERRY = requireItem('ITEM_SITRUS_BERRY')
const ITEM_POWER_HERB = requireItem('ITEM_POWER_HERB')

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
    const state = battle([{ moves: ['MOVE_BATON_PASS', null, null, null], pp: [10, 0, 0, 0] }, {}], rng)
    const dmg = dummyDamage()

    const out = executeTurn(state, [useMove(1, MOVE_BATON_PASS), null], testDeps(dmg))

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

      describe('EFFECT_WISH', () => {
        it('Wish sets wishCounter=2, decrements at end of turn, heals half max HP at end of next turn', () => {
          // BattleScript_EffectWish (data/battle_scripts_1.s:6306-6313)
          // Cmd_trywish (battle_script_commands.c:11783-11818)
          // TurnBasedEffects case ENDTURN_WISH (battle_util.c:1943-1958)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_WISH', null, null, null], pp: [10, 0, 0, 0], hp: 50, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )

          // Turn 1: Uses Wish at 50/100 HP.
          const out1 = executeTurn(state, [useMove(1, MOVE_WISH), null], deps)
          const act1 = out1.actions.find((a) => a.battlerId === 0)!
          expect(act1.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          // wishCounter was 2 during turn, decremented to 1 at end-of-turn.
          expect(state.field.wishCounter[0]).toBe(1)
          // No heal yet on turn 1.
          expect(state.battlers[0]!.mon.hp).toBe(50)
          expect(out1.fieldEndTurn.some((e) => e.effect === 'WISH')).toBe(false)

          // Turn 2: Wish comes true at end of turn!
          const out2 = executeTurn(state, [null, null], deps)
          expect(state.field.wishCounter[0]).toBe(0)
          // Heals half of user's max HP (50 HP): 50 -> 100.
          expect(state.battlers[0]!.mon.hp).toBe(100)
          expect(out2.fieldEndTurn).toContainEqual({ battlerId: 0, effect: 'WISH', hpChange: 50, fainted: false })
        })

        it('Wish fails if wishCounter is already active', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_WISH', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.field.wishCounter = [1, 0, 0, 0]

          const out = executeTurn(state, [useMove(1, MOVE_WISH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9) // Costs PP even when it fails
        })

        it('Wish clears STATUS1_BLEED instead of healing HP', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_WISH', null, null, null], pp: [10, 0, 0, 0], hp: 50, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          executeTurn(state, [useMove(1, MOVE_WISH), null], deps)
          expect(state.field.wishCounter[0]).toBe(1)

          // Afflict bleed before end of turn 2
          state.battlers[0]!.mon.status1 = STATUS1_BLEED
          executeTurn(state, [null, null], deps)

          expect(state.field.wishCounter[0]).toBe(0)
          expect(state.battlers[0]!.mon.status1).toBe(0) // Cured bleed
          expect(state.battlers[0]!.mon.hp).toBe(50) // HP not healed
        })

        it('Wish does not heal when at full HP or under Heal Block', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Full HP test
          const stateFull = battle(
            [
              { moves: ['MOVE_WISH', null, null, null], pp: [10, 0, 0, 0], hp: 100, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          executeTurn(stateFull, [useMove(1, MOVE_WISH), null], deps)
          const outFull = executeTurn(stateFull, [null, null], deps)
          expect(stateFull.battlers[0]!.mon.hp).toBe(100)
          expect(outFull.fieldEndTurn.some((e) => e.effect === 'WISH')).toBe(false)

          // Heal Block test
          const stateBlocked = battle(
            [
              { moves: ['MOVE_WISH', null, null, null], pp: [10, 0, 0, 0], hp: 50, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          executeTurn(stateBlocked, [useMove(1, MOVE_WISH), null], deps)
          stateBlocked.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
          const outBlocked = executeTurn(stateBlocked, [null, null], deps)
          expect(stateBlocked.battlers[0]!.mon.hp).toBe(50)
          expect(outBlocked.fieldEndTurn.some((e) => e.effect === 'WISH')).toBe(false)
        })
      })

      describe('EFFECT_HEAL_BELL', () => {
        it('Heal Bell cures active status, clears Nightmare, heals user 30% max HP, and cures reserve party mons', () => {
          // BattleScript_EffectHealBell (data/battle_scripts_1.s:4842-4869)
          // Cmd_healpartystatus (src/battle_script_commands.c:11022-11101)
          // tryhealpercenthealth BS_ATTACKER, 30 (src/battle_script_commands.c:7896-7907)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_HEAL_BELL', null, null, null], pp: [5, 0, 0, 0], hp: 50, maxHp: 100, status1: STATUS1_BURN, status2: STATUS2_NIGHTMARE },
              { spe: 50 },
            ],
            rng,
          )
          // Add reserve party mon with status
          state.sides[0].party = [
            {
              speciesId: 'SPECIES_MUDKIP',
              types: ['WATER', 'MYSTERY', 'MYSTERY'],
              hp: 50,
              maxHp: 100,
              level: 50,
              moves: [null, null, null, null],
              pp: [0, 0, 0, 0],
              itemId: null,
              abilities: { ability: null, innates: [null, null, null] },
              rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
              nature: 'NATURE_HARDY',
              hiddenPowerType: null,
              speedDown: false,
              gender: 'MALE',
              status1: STATUS1_BURN,
            },
            {
              speciesId: 'SPECIES_TORCHIC',
              types: ['WATER', 'MYSTERY', 'MYSTERY'],
              hp: 100,
              maxHp: 100,
              level: 50,
              moves: [null, null, null, null],
              pp: [0, 0, 0, 0],
              itemId: null,
              abilities: { ability: null, innates: [null, null, null] },
              rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
              nature: 'NATURE_HARDY',
              hiddenPowerType: null,
              speedDown: false,
              gender: 'MALE',
              status1: STATUS1_PARALYSIS,
            },
            {
              speciesId: 'SPECIES_EXPLOUD',
              types: ['WATER', 'MYSTERY', 'MYSTERY'],
              hp: 100,
              maxHp: 100,
              level: 50,
              moves: [null, null, null, null],
              pp: [0, 0, 0, 0],
              itemId: null,
              abilities: { ability: ABILITY_SOUNDPROOF, innates: [null, null, null] },
              rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
              nature: 'NATURE_HARDY',
              hiddenPowerType: null,
              speedDown: false,
              gender: 'MALE',
              status1: STATUS1_POISON,
            },
          ]

          const out = executeTurn(state, [useMove(1, MOVE_HEAL_BELL), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          // Active battler cured of status1 and Nightmare
          expect(state.battlers[0]!.mon.status1).toBe(0)
          expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_NIGHTMARE)).toBe(false)
          // User healed 30% max HP: 50 -> 80
          expect(state.battlers[0]!.mon.hp).toBe(80)

          // Reserve party mon without Soundproof is cured
          expect(state.sides[0].party[1]!.status1).toBe(0)
          // Reserve party mon with Soundproof is NOT cured
          expect(state.sides[0].party[2]!.status1).toBe(STATUS1_POISON)
        })

        it('Heal Bell respects Soundproof on active battler, Aromatherapy ignores Soundproof', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Soundproof user with Heal Bell
          const stateBell = battle(
            [
              {
                moves: ['MOVE_HEAL_BELL', null, null, null],
                pp: [5, 0, 0, 0],
                status1: STATUS1_BURN,
                abilities: { ability: ABILITY_SOUNDPROOF, innates: [null, null, null] },
              },
              { spe: 50 },
            ],
            rng,
          )
          const outBell = executeTurn(stateBell, [useMove(1, MOVE_HEAL_BELL), null], deps)
          expect(outBell.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          // Status NOT cured due to Soundproof
          expect(stateBell.battlers[0]!.mon.status1).toBe(STATUS1_BURN)

          // Soundproof user with Aromatherapy
          const stateAroma = battle(
            [
              {
                moves: ['MOVE_AROMATHERAPY', null, null, null],
                pp: [5, 0, 0, 0],
                status1: STATUS1_BURN,
                abilities: { ability: ABILITY_SOUNDPROOF, innates: [null, null, null] },
              },
              { spe: 50 },
            ],
            rng,
          )
          const outAroma = executeTurn(stateAroma, [useMove(1, MOVE_AROMATHERAPY), null], deps)
          expect(outAroma.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          // Status IS cured because Aromatherapy ignores Soundproof
          expect(stateAroma.battlers[0]!.mon.status1).toBe(0)
        })
      })

      describe('EFFECT_REFRESH', () => {
        it('Refresh cures burn/poison/paralysis and heals 25% max HP', () => {
          // BattleScript_EffectRefresh (data/battle_scripts_1.s:6484-6508)
          // Cmd_cureifburnedparalysedorpoisoned (src/battle_script_commands.c:11648-11660)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_REFRESH', null, null, null], pp: [10, 0, 0, 0], hp: 50, maxHp: 100, status1: STATUS1_BURN },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_REFRESH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(state.battlers[0]!.mon.status1).toBe(0)
          // 50 + 25 = 75 HP
          expect(state.battlers[0]!.mon.hp).toBe(75)
        })

        it('Refresh cures status even at full HP without failing', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              // Burn, not paralysis: countingRng's 0 would fully paralyse the user in CANCELLER_PARALYSED.
              { moves: ['MOVE_REFRESH', null, null, null], pp: [10, 0, 0, 0], hp: 100, maxHp: 100, status1: STATUS1_BURN },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_REFRESH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.status1).toBe(0)
          expect(state.battlers[0]!.mon.hp).toBe(100)
        })

        it('Refresh fails at full HP if user has no status', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_REFRESH', null, null, null], pp: [10, 0, 0, 0], hp: 100, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_REFRESH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9) // Costs PP
        })

        it('Refresh heals 25% max HP when damaged even if user has no status', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_REFRESH', null, null, null], pp: [10, 0, 0, 0], hp: 50, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_REFRESH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.hp).toBe(75)
        })
      })

      describe('EFFECT_PURIFY', () => {
        it('Purify cures target status and restores 50% max HP to user', () => {
          // BattleScript_EffectPurify (data/battle_scripts_1.s:879-895)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_PURIFY', null, null, null], pp: [20, 0, 0, 0], hp: 50, maxHp: 100 },
              { spe: 50, status1: STATUS1_POISON },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_PURIFY), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          expect(state.battlers[1]!.mon.status1).toBe(0)
          expect(state.battlers[0]!.mon.hp).toBe(100)
        })

        it('Purify fails if target has no status', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_PURIFY', null, null, null], pp: [20, 0, 0, 0], hp: 50, maxHp: 100 },
              { spe: 50, status1: 0 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_PURIFY), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          expect(state.battlers[0]!.mon.hp).toBe(50)
        })

        it('Purify leaves a bleeding user alone: tryhealhalfhealth zeroes the heal and RestoreHp has no bleed cure', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_PURIFY', null, null, null], pp: [20, 0, 0, 0], hp: 50, maxHp: 100, status1: STATUS1_BLEED },
              { spe: 50, status1: STATUS1_BURN },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_PURIFY), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.status1).toBe(0) // Target cured
          // Cmd_tryhealhalfhealth (battle_script_commands.c:9255-9274): CanBattlerHeal fails on bleed, so the
          // heal is 0; BattleScript_RestoreHp (battle_scripts_1.s:3949-3955) has no bleed branch.
          expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BLEED)
          expect(state.battlers[0]!.mon.hp).toBe(50)
        })
      })

      describe('EFFECT_TAKE_HEART', () => {
        it('Take Heart cures user status and boosts SpAtk +1 and SpDef +1', () => {
          // BattleScript_EffectTakeHeart (data/battle_scripts_1.s:6695-6712)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              // Burn, not paralysis: countingRng's 0 would fully paralyse the user in CANCELLER_PARALYSED.
              { moves: ['MOVE_TAKE_HEART', null, null, null], pp: [5, 0, 0, 0], status1: STATUS1_BURN },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_TAKE_HEART), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          expect(state.battlers[0]!.mon.status1).toBe(0)
          // Default stat stage is 6; +1 raises to 7
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
          expect(act.statChanges).toEqual([
            { battlerId: 0, stat: STAT_SPATK, change: 1 },
            { battlerId: 0, stat: STAT_SPDEF, change: 1 },
          ])
        })

        it('Take Heart works and boosts stats even without status', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TAKE_HEART', null, null, null], pp: [5, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_TAKE_HEART), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
        })

        it('Take Heart fails if user has no status and both stats are maxed', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TAKE_HEART', null, null, null], pp: [5, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
          state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE

          const out = executeTurn(state, [useMove(1, MOVE_TAKE_HEART), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
        })
      })

      describe('EFFECT_REST', () => {
        it('Rest fully heals HP, cures prior status, and sets sleep counter to 3 turns', () => {
          // BattleScript_EffectRest (data/battle_scripts_1.s:4023-4036)
          // Cmd_trysetrest (src/battle_script_commands.c:9415-9437)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_REST', null, null, null], pp: [10, 0, 0, 0], hp: 30, maxHp: 100, status1: STATUS1_BURN, status2: STATUS2_NIGHTMARE },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_REST), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          // Fully healed: 30 -> 100
          expect(state.battlers[0]!.mon.hp).toBe(100)
          // Burn replaced by sleep for 3 turns (STATUS1_SLEEP_TURN(3)); Cmd_trysetrest writes status1 only,
          // so Nightmare stays.
          expect(state.battlers[0]!.mon.status1).toBe(3)
          expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_NIGHTMARE)).toBe(true)
        })

        it('Rest fails at full HP', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_REST', null, null, null], pp: [10, 0, 0, 0], hp: 100, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_REST), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(state.battlers[0]!.mon.status1).toBe(0)
        })

        it('Rest fails if already asleep or Comatose', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Already asleep
          const stateAsleep = battle(
            [
              { moves: ['MOVE_REST', null, null, null], pp: [10, 0, 0, 0], hp: 50, maxHp: 100, status1: 2 },
              { spe: 50 },
            ],
            rng,
          )
          // An asleep user never reaches the script: CANCELLER_ASLEEP stops it first.
          const outAsleep = executeTurn(stateAsleep, [useMove(1, MOVE_REST), null], deps)
          expect(outAsleep.actions.find((a) => a.battlerId === 0)!.cancelledBy).toBe('SLEEP')

          // Comatose
          const stateComatose = battle(
            [
              {
                moves: ['MOVE_REST', null, null, null],
                pp: [10, 0, 0, 0],
                hp: 50,
                maxHp: 100,
                abilities: { ability: ABILITY_COMATOSE, innates: [null, null, null] },
              },
              { spe: 50 },
            ],
            rng,
          )
          const outComatose = executeTurn(stateComatose, [useMove(1, MOVE_REST), null], deps)
          expect(outComatose.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
        })

        it('Rest fails if protected by sleep immunity ability (Insomnia / Vital Spirit)', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Insomnia
          const stateInsomnia = battle(
            [
              {
                moves: ['MOVE_REST', null, null, null],
                pp: [10, 0, 0, 0],
                hp: 50,
                maxHp: 100,
                abilities: { ability: ABILITY_INSOMNIA, innates: [null, null, null] },
              },
              { spe: 50 },
            ],
            rng,
          )
          const outInsomnia = executeTurn(stateInsomnia, [useMove(1, MOVE_REST), null], deps)
          expect(outInsomnia.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)

          // Vital Spirit
          const stateVital = battle(
            [
              {
                moves: ['MOVE_REST', null, null, null],
                pp: [10, 0, 0, 0],
                hp: 50,
                maxHp: 100,
                abilities: { ability: ABILITY_VITAL_SPIRIT, innates: [null, null, null] },
              },
              { spe: 50 },
            ],
            rng,
          )
          const outVital = executeTurn(stateVital, [useMove(1, MOVE_REST), null], deps)
          expect(outVital.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
        })

        it('Rest fails on Electric Terrain or Misty Terrain when grounded', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Electric Terrain
          const stateElectric = battle(
            [
              { moves: ['MOVE_REST', null, null, null], pp: [10, 0, 0, 0], hp: 50, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          stateElectric.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
          const outElectric = executeTurn(stateElectric, [useMove(1, MOVE_REST), null], deps)
          expect(outElectric.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)

          // Misty Terrain
          const stateMisty = battle(
            [
              { moves: ['MOVE_REST', null, null, null], pp: [10, 0, 0, 0], hp: 50, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          stateMisty.field.statuses |= STATUS_FIELD_MISTY_TERRAIN
          const outMisty = executeTurn(stateMisty, [useMove(1, MOVE_REST), null], deps)
          expect(outMisty.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
        })
      })

      describe('EFFECT_HEAL_PULSE', () => {
        it('Heal Pulse heals target 50% max HP, and 75% max HP with Mega Launcher', () => {
          // BattleScript_EffectHealPulse (data/battle_scripts_1.s:2252-2267)
          // Cmd_tryhealpulse (src/battle_script_commands.c:7261-7280)
          const deps = testDeps()
          const rng = countingRng()
          // Standard 50% heal
          const state = battle(
            [
              { moves: ['MOVE_HEAL_PULSE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50, hp: 40, maxHp: 100 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_HEAL_PULSE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          // 40 + 50 = 90 HP
          expect(state.battlers[1]!.mon.hp).toBe(90)

          // Mega Launcher boosted (75% heal)
          const stateMega = battle(
            [
              {
                moves: ['MOVE_HEAL_PULSE', null, null, null],
                pp: [10, 0, 0, 0],
              },
              // VARIOUS_TRY_HEAL_PULSE reads megaLauncherBoost on the TARGET (gActiveBattler, :7268-7271).
              { spe: 50, hp: 20, maxHp: 100, abilities: { ability: ABILITY_MEGA_LAUNCHER, innates: [null, null, null] } },
            ],
            rng,
          )
          const outMega = executeTurn(stateMega, [useMove(1, MOVE_HEAL_PULSE), null], deps)
          expect(outMega.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          // 20 + 75 = 95 HP
          expect(stateMega.battlers[1]!.mon.hp).toBe(95)
        })

        it('Floral Healing heals target 50% max HP', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FLORAL_HEALING', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50, hp: 40, maxHp: 100 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_FLORAL_HEALING), null], deps)
          expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          expect(state.battlers[1]!.mon.hp).toBe(90)
        })

        it('Heal Pulse fails against Substitute and Heal Block', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Substitute
          const stateSub = battle(
            [
              { moves: ['MOVE_HEAL_PULSE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50, hp: 40, maxHp: 100, status2: STATUS2_SUBSTITUTE },
            ],
            rng,
          )
          const outSub = executeTurn(stateSub, [useMove(1, MOVE_HEAL_PULSE), null], deps)
          expect(outSub.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
          expect(stateSub.battlers[1]!.mon.hp).toBe(40)

          // Heal Block
          const stateBlock = battle(
            [
              { moves: ['MOVE_HEAL_PULSE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50, hp: 40, maxHp: 100 },
            ],
            rng,
          )
          stateBlock.battlers[1]!.statuses3 |= STATUS3_HEAL_BLOCK
          const outBlock = executeTurn(stateBlock, [useMove(1, MOVE_HEAL_PULSE), null], deps)
          expect(outBlock.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
          expect(stateBlock.battlers[1]!.mon.hp).toBe(40)
        })

        it('Heal Pulse clears bleed on target without restoring HP', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_HEAL_PULSE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50, hp: 40, maxHp: 100, status1: STATUS1_BLEED },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_HEAL_PULSE), null], deps)
          expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          expect(state.battlers[1]!.mon.status1).toBe(0)
          expect(state.battlers[1]!.mon.hp).toBe(40)
        })
      })

      describe('EFFECT_PSYCHO_SHIFT', () => {
        it('Psycho Shift moves frostbite even onto an Ice type (VARIOUS_PSYCHO_SHIFT has no fail branch for it)', () => {
          const state = battle(
            [
              { moves: ['MOVE_PSYCHO_SHIFT', null, null, null], pp: [10, 0, 0, 0], status1: STATUS1_FROSTBITE },
              { spe: 50, types: ['ICE', 'MYSTERY', 'MYSTERY'] },
            ],
            countingRng(),
          )
          executeTurn(state, [useMove(1, MOVE_PSYCHO_SHIFT), null], testDeps())
          expect(state.battlers[1]!.mon.status1).toBe(STATUS1_FROSTBITE)
          expect(state.battlers[0]!.mon.status1).toBe(0)
        })

        it('Psycho Shift transfers user burn to target and cures user', () => {
          // BattleScript_EffectPsychoShift (data/battle_scripts_1.s:1456-1478)
          // Cmd_trypsychoshift (src/battle_script_commands.c:7641-7684)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_PSYCHO_SHIFT', null, null, null], pp: [10, 0, 0, 0], status1: STATUS1_BURN },
              { spe: 50, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_PSYCHO_SHIFT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(state.battlers[0]!.mon.status1).toBe(0) // User cured
          expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN) // Target burned
        })

        it('Psycho Shift fails if user has no status or target already has status', () => {
          const deps = testDeps()
          const rng = countingRng()
          // User has no status
          const stateNoStatus = battle(
            [
              { moves: ['MOVE_PSYCHO_SHIFT', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          const outNoStatus = executeTurn(stateNoStatus, [useMove(1, MOVE_PSYCHO_SHIFT), null], deps)
          expect(outNoStatus.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)

          // Target already has status
          const stateTargetStat = battle(
            [
              { moves: ['MOVE_PSYCHO_SHIFT', null, null, null], pp: [10, 0, 0, 0], status1: STATUS1_BURN },
              { spe: 50, status1: STATUS1_PARALYSIS },
            ],
            rng,
          )
          const outTargetStat = executeTurn(stateTargetStat, [useMove(1, MOVE_PSYCHO_SHIFT), null], deps)
          expect(outTargetStat.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
          expect(stateTargetStat.battlers[0]!.mon.status1).toBe(STATUS1_BURN)
        })

        it('Psycho Shift fails against Safeguard or type immunity', () => {
          const deps = testDeps()
          const rng = countingRng()
          // Safeguard
          const stateSafe = battle(
            [
              { moves: ['MOVE_PSYCHO_SHIFT', null, null, null], pp: [10, 0, 0, 0], status1: STATUS1_BURN },
              { spe: 50 },
            ],
            rng,
          )
          stateSafe.sides[1].statuses |= SIDE_STATUS_SAFEGUARD
          const outSafe = executeTurn(stateSafe, [useMove(1, MOVE_PSYCHO_SHIFT), null], deps)
          expect(outSafe.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)

          // Fire-type immune to burn
          const stateFire = battle(
            [
              { moves: ['MOVE_PSYCHO_SHIFT', null, null, null], pp: [10, 0, 0, 0], status1: STATUS1_BURN },
              { spe: 50, types: ['FIRE', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )
          const outFire = executeTurn(stateFire, [useMove(1, MOVE_PSYCHO_SHIFT), null], deps)
          expect(outFire.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
        })
      })

      describe('EFFECT_STOCKPILE', () => {
        it('Stockpile raises Def and SpDef +1 and caps at 3 stockpiles', () => {
          // BattleScript_EffectStockpile (data/battle_scripts_1.s:5979-6007)
          // Cmd_stockpile (src/battle_script_commands.c:9494-9519)
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_STOCKPILE', null, null, null], pp: [5, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          // Use 1
          const out1 = executeTurn(state, [useMove(1, MOVE_STOCKPILE), null], deps)
          expect(out1.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          expect(state.battlers[0]!.volatiles.stockpileCounter).toBe(1)
          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
          expect(state.battlers[0]!.volatiles.stockpileDef).toBe(1)
          expect(state.battlers[0]!.volatiles.stockpileSpDef).toBe(1)

          // Use 2
          const out2 = executeTurn(state, [useMove(1, MOVE_STOCKPILE), null], deps)
          expect(out2.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          expect(state.battlers[0]!.volatiles.stockpileCounter).toBe(2)
          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(8)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(8)
          expect(state.battlers[0]!.volatiles.stockpileDef).toBe(2)
          expect(state.battlers[0]!.volatiles.stockpileSpDef).toBe(2)

          // Use 3
          const out3 = executeTurn(state, [useMove(1, MOVE_STOCKPILE), null], deps)
          expect(out3.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          expect(state.battlers[0]!.volatiles.stockpileCounter).toBe(3)
          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(9)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(9)

          // Use 4: fails because stockpileCounter is already 3
          const out4 = executeTurn(state, [useMove(1, MOVE_STOCKPILE), null], deps)
          expect(out4.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
          expect(state.battlers[0]!.volatiles.stockpileCounter).toBe(3)
          expect(state.battlers[0]!.mon.pp[0]).toBe(1) // Costs PP
        })
      })

      describe('EFFECT_SWALLOW', () => {
        it('Swallow restores 50% max HP like Recover (mapped to handleHealHalf)', () => {
          // MoveBehaviorConfigList.textproto:778-779
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SWALLOW', null, null, null], pp: [2, 0, 0, 0], hp: 40, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )
          const out = executeTurn(state, [useMove(1, MOVE_SWALLOW), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(1)
          // 40 + 50 = 90 HP
          expect(state.battlers[0]!.mon.hp).toBe(90)
        })
      })
    })

    describe('Cycle 57: Stat copy/swap/split, self multi-stat, and target drop moves', () => {
      // Part 1: Stat copy / swap / split moves
      describe('EFFECT_PSYCH_UP', () => {
        it('copies all target stat stages and costs PP', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_PSYCH_UP', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.battlers[1]!.mon.statStages[STAT_ATK] = 8
          state.battlers[1]!.mon.statStages[STAT_SPATK] = 5
          state.battlers[1]!.mon.statStages[STAT_SPEED] = 9

          const out = executeTurn(state, [useMove(1, MOVE_PSYCH_UP), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(5)
          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(9)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(8)
        })

        it('bypasses substitute and copies stages', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_PSYCH_UP', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50, status2: STATUS2_SUBSTITUTE },
            ],
            rng,
          )
          state.battlers[1]!.volatiles.substituteHp = 25
          state.battlers[1]!.mon.statStages[STAT_DEF] = 10

          const out = executeTurn(state, [useMove(1, MOVE_PSYCH_UP), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(10)
        })
      })

      describe('EFFECT_POWER_SWAP', () => {
        it('swaps Atk/SpAtk stages and rawStats between user and target', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_POWER_SWAP', null, null, null], pp: [10, 0, 0, 0], atk: 120, spatk: 80 },
              { spe: 50, atk: 60, spatk: 140 },
            ],
            rng,
          )
          state.battlers[0]!.mon.statStages[STAT_ATK] = 7
          state.battlers[0]!.mon.statStages[STAT_SPATK] = 6
          state.battlers[1]!.mon.statStages[STAT_ATK] = 4
          state.battlers[1]!.mon.statStages[STAT_SPATK] = 9

          const out = executeTurn(state, [useMove(1, MOVE_POWER_SWAP), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)

          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(4)
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(9)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(7)
          expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(6)

          expect(state.battlers[0]!.mon.rawStats.atk).toBe(60)
          expect(state.battlers[0]!.mon.rawStats.spatk).toBe(140)
          expect(state.battlers[1]!.mon.rawStats.atk).toBe(120)
          expect(state.battlers[1]!.mon.rawStats.spatk).toBe(80)
        })
      })

      describe('EFFECT_GUARD_SWAP', () => {
        it('swaps Def/SpDef stages and rawStats between user and target', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_GUARD_SWAP', null, null, null], pp: [10, 0, 0, 0], def: 110, spdef: 70 },
              { spe: 50, def: 50, spdef: 130 },
            ],
            rng,
          )
          state.battlers[0]!.mon.statStages[STAT_DEF] = 8
          state.battlers[0]!.mon.statStages[STAT_SPDEF] = 6
          state.battlers[1]!.mon.statStages[STAT_DEF] = 5
          state.battlers[1]!.mon.statStages[STAT_SPDEF] = 10

          const out = executeTurn(state, [useMove(1, MOVE_GUARD_SWAP), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)

          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(5)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(10)
          expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(8)
          expect(state.battlers[1]!.mon.statStages[STAT_SPDEF]).toBe(6)

          expect(state.battlers[0]!.mon.rawStats.def).toBe(50)
          expect(state.battlers[0]!.mon.rawStats.spdef).toBe(130)
          expect(state.battlers[1]!.mon.rawStats.def).toBe(110)
          expect(state.battlers[1]!.mon.rawStats.spdef).toBe(70)
        })
      })

      describe('EFFECT_SPEED_SWAP', () => {
        it('swaps Speed stage and rawStats between user and target', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SPEED_SWAP', null, null, null], pp: [10, 0, 0, 0], spe: 120 },
              { spe: 50 },
            ],
            rng,
          )
          state.battlers[0]!.mon.statStages[STAT_SPEED] = 9
          state.battlers[1]!.mon.statStages[STAT_SPEED] = 4

          const out = executeTurn(state, [useMove(1, MOVE_SPEED_SWAP), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)

          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(4)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(9)
          expect(state.battlers[0]!.mon.rawStats.spe).toBe(50)
          expect(state.battlers[1]!.mon.rawStats.spe).toBe(120)
        })
      })

      describe('EFFECT_HEART_SWAP', () => {
        it('swaps all 7 stat stages and leaves rawStats untouched', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_HEART_SWAP', null, null, null], pp: [10, 0, 0, 0], atk: 100, def: 90 },
              { spe: 50, atk: 70, def: 60 },
            ],
            rng,
          )
          state.battlers[0]!.mon.statStages[STAT_ATK] = 8
          state.battlers[0]!.mon.statStages[STAT_DEF] = 4
          state.battlers[0]!.mon.statStages[STAT_ACC] = 7
          state.battlers[1]!.mon.statStages[STAT_ATK] = 5
          state.battlers[1]!.mon.statStages[STAT_DEF] = 9
          state.battlers[1]!.mon.statStages[STAT_ACC] = 3

          const out = executeTurn(state, [useMove(1, MOVE_HEART_SWAP), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)

          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(5)
          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(9)
          expect(state.battlers[0]!.mon.statStages[STAT_ACC]).toBe(3)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(8)
          expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(4)
          expect(state.battlers[1]!.mon.statStages[STAT_ACC]).toBe(7)

          expect(state.battlers[0]!.mon.rawStats.atk).toBe(100)
          expect(state.battlers[1]!.mon.rawStats.atk).toBe(70)
        })
      })

      describe('EFFECT_POWER_SPLIT', () => {
        it('averages Atk and SpAtk raw stats using integer division and leaves stages intact', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_POWER_SPLIT', null, null, null], pp: [10, 0, 0, 0], atk: 105, spatk: 80 },
              { spe: 50, atk: 70, spatk: 111 },
            ],
            rng,
          )
          state.battlers[0]!.mon.statStages[STAT_ATK] = 8
          state.battlers[1]!.mon.statStages[STAT_ATK] = 4

          const out = executeTurn(state, [useMove(1, MOVE_POWER_SPLIT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)

          expect(state.battlers[0]!.mon.rawStats.atk).toBe(87)
          expect(state.battlers[1]!.mon.rawStats.atk).toBe(87)
          expect(state.battlers[0]!.mon.rawStats.spatk).toBe(95)
          expect(state.battlers[1]!.mon.rawStats.spatk).toBe(95)

          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(4)
        })
      })

      describe('EFFECT_GUARD_SPLIT', () => {
        it('averages Def and SpDef raw stats using integer division and leaves stages intact', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_GUARD_SPLIT', null, null, null], pp: [10, 0, 0, 0], def: 120, spdef: 75 },
              { spe: 50, def: 50, spdef: 80 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_GUARD_SPLIT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)

          expect(state.battlers[0]!.mon.rawStats.def).toBe(85)
          expect(state.battlers[1]!.mon.rawStats.def).toBe(85)
          expect(state.battlers[0]!.mon.rawStats.spdef).toBe(77)
          expect(state.battlers[1]!.mon.rawStats.spdef).toBe(77)
        })
      })

      describe('EFFECT_TOPSY_TURVY', () => {
        it('inverts positive and negative stat stages on the target', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TOPSY_TURVY', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.battlers[1]!.mon.statStages[STAT_ATK] = 8
          state.battlers[1]!.mon.statStages[STAT_DEF] = 4
          state.battlers[1]!.mon.statStages[STAT_SPATK] = 10
          state.battlers[1]!.mon.statStages[STAT_SPEED] = 3

          const out = executeTurn(state, [useMove(1, MOVE_TOPSY_TURVY), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)

          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(4)
          expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(8)
          expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(2)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(9)
        })

        it('fails with missed: true if all 7 target stat stages are neutral (6)', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TOPSY_TURVY', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_TOPSY_TURVY), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        })
      })

      // Part 2: Self multi-stat moves
      describe('EFFECT_ACUPRESSURE', () => {
        it('raises a random non-maxed stat by 2 using scripted RNG', () => {
          const deps = testDeps()
          // (random16() % 7) + 1: value 2 yields (2 % 7) + 1 = 3 (STAT_SPEED)
          const rng = scriptedRng([2])
          const state = battle(
            [
              { moves: ['MOVE_ACUPRESSURE', null, null, null], pp: [30, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(0, MOVE_ACUPRESSURE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(29)
          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
        })

        it('fails with missed: true if all stats are maxed at MAX_STAT_STAGE (12)', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_ACUPRESSURE', null, null, null], pp: [30, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          for (let i = STAT_ATK; i <= STAT_EVASION; i++) {
            state.battlers[0]!.mon.statStages[i] = MAX_STAT_STAGE
          }

          const out = executeTurn(state, [useMove(0, MOVE_ACUPRESSURE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(29)
        })
      })

      describe('EFFECT_CLANGOROUS_SOUL', () => {
        it('deducts 1/3 max HP and raises all 5 battle stats by 1 stage', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_CLANGOROUS_SOUL', null, null, null], pp: [5, 0, 0, 0], hp: 90, maxHp: 90 },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(0, MOVE_CLANGOROUS_SOUL), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          expect(state.battlers[0]!.mon.hp).toBe(60)
          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
        })

        it('fails with missed: true if HP <= 1/3 max HP without deducting HP', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_CLANGOROUS_SOUL', null, null, null], pp: [5, 0, 0, 0], hp: 30, maxHp: 90 },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(0, MOVE_CLANGOROUS_SOUL), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.hp).toBe(30)
          expect(state.battlers[0]!.mon.pp[0]).toBe(4)
        })
      })

      describe('EFFECT_FILLET_AWAY', () => {
        it('deducts 50% current HP and raises Atk, SpAtk, Speed by 2 stages', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FILLET_AWAY', null, null, null], pp: [10, 0, 0, 0], hp: 80, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(0, MOVE_FILLET_AWAY), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          expect(state.battlers[0]!.mon.hp).toBe(40)
          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8)
          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
        })

        it('fails with missed: true if current HP <= 1', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FILLET_AWAY', null, null, null], pp: [10, 0, 0, 0], hp: 1, maxHp: 100 },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(0, MOVE_FILLET_AWAY), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.hp).toBe(1)
        })
      })

      describe('EFFECT_NO_RETREAT', () => {
        it('raises all 5 battle stats by 1 stage and prevents the user from switching', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_NO_RETREAT', null, null, null], pp: [5, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(0, MOVE_NO_RETREAT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(7)
          expect(state.battlers[0]!.volatiles.noRetreat).toBe(true)
          expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
          expect(canBattlerEscape(state, 0, { dataContext: DATA_CONTEXT, grounding: GROUNDING })).toBe(false)
        })

        it('fails with missed: true if used when already active', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_NO_RETREAT', null, null, null], pp: [5, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.battlers[0]!.volatiles.noRetreat = true

          const out = executeTurn(state, [useMove(0, MOVE_NO_RETREAT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
        })
      })

      describe('EFFECT_TIDY_UP', () => {
        it('clears hazards from user side and raises Atk and Speed by 1 stage', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TIDY_UP', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.sides[0]!.statuses = setFlag(
            state.sides[0]!.statuses,
            SIDE_STATUS_SPIKES | SIDE_STATUS_STEALTH_ROCK | SIDE_STATUS_STICKY_WEB | SIDE_STATUS_TOXIC_SPIKES,
          )

          const out = executeTurn(state, [useMove(0, MOVE_TIDY_UP), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)

          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_STICKY_WEB)).toBe(false)
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(false)
        })

        it('clears hazards even when stats are maxed, but marks move missed: true', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TIDY_UP', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
          state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
          state.sides[0]!.statuses = setFlag(state.sides[0]!.statuses, SIDE_STATUS_STEALTH_ROCK)

          const out = executeTurn(state, [useMove(0, MOVE_TIDY_UP), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
        })
      })

      // Part 3: Target drops
      describe('EFFECT_VENOM_DRENCH', () => {
        it('fails with missed: true on an unpoisoned target without toxic terrain', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_VENOM_DRENCH', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_VENOM_DRENCH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        })

        it('lowers Atk, SpAtk, and Speed by 1 stage on a poisoned target', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_VENOM_DRENCH', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, status1: STATUS1_POISON },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_VENOM_DRENCH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(5)
          expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(5)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(5)
        })

        it('lowers Atk, SpAtk, and Speed by 1 stage on a badly poisoned target', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_VENOM_DRENCH', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, status1: STATUS1_TOXIC_POISON },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_VENOM_DRENCH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(5)
          expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(5)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(5)
        })

        it('succeeds on an unpoisoned target when Toxic Terrain is active', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_VENOM_DRENCH', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)

          const out = executeTurn(state, [useMove(1, MOVE_VENOM_DRENCH), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(5)
          expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(5)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(5)
        })
      })

      describe('EFFECT_TOXIC_THREAD', () => {
        it('lowers target Speed by 3 stages and poisons the target (ER C drops Speed by 3)', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TOXIC_THREAD', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_TOXIC_THREAD), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(3)
          expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
        })

        it('fails with missed: true if target has Substitute', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TOXIC_THREAD', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, status2: STATUS2_SUBSTITUTE },
            ],
            rng,
          )
          state.battlers[1]!.volatiles.substituteHp = 25

          const out = executeTurn(state, [useMove(1, MOVE_TOXIC_THREAD), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(6)
        })
      })

      describe('EFFECT_TAR_SHOT', () => {
        it('lowers Speed by 1 stage and sets tarShot volatile', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TAR_SHOT', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_TAR_SHOT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(5)
          expect(state.battlers[1]!.volatiles.tarShot).toBe(true)
        })

        it('fails with missed: true if tarShot is already active on the target', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TAR_SHOT', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.battlers[1]!.volatiles.tarShot = true

          const out = executeTurn(state, [useMove(1, MOVE_TAR_SHOT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
        })
      })

      describe('EFFECT_SPICY_EXTRACT', () => {
        it('does not trigger Defiant: its Def drop prints the stat-ROSE string (battle_scripts_1.s:5180)', () => {
          const state = battle(
            [
              { moves: ['MOVE_SPICY_EXTRACT', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50, abilities: { ability: ABILITY_DEFIANT, innates: [null, null, null] } },
            ],
            countingRng(),
          )
          executeTurn(state, [useMove(1, MOVE_SPICY_EXTRACT), null], testDeps())
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
          expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 2)
        })

        it('raises target Atk by 2, lowers Def by 2, and inflicts Confusion', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SPICY_EXTRACT', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_SPICY_EXTRACT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(8)
          expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(4)
          expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
        })

        it('fails with missed: true if target has Substitute', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SPICY_EXTRACT', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50, status2: STATUS2_SUBSTITUTE },
            ],
            rng,
          )
          state.battlers[1]!.volatiles.substituteHp = 25

          const out = executeTurn(state, [useMove(1, MOVE_SPICY_EXTRACT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(6)
        })
      })

      describe('EFFECT_MEMENTO', () => {
        it('user faints and lowers target Atk and SpAtk by 2 stages', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MEMENTO', null, null, null], pp: [10, 0, 0, 0], hp: 100 },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_MEMENTO), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.hp).toBe(0)
          expect(act.attackerDamage).toBe(100)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(4)
          expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(4)
        })

        it('fails without fainting user if target has Substitute', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MEMENTO', null, null, null], pp: [10, 0, 0, 0], hp: 100 },
              { spe: 50, status2: STATUS2_SUBSTITUTE },
            ],
            rng,
          )
          state.battlers[1]!.volatiles.substituteHp = 25

          const out = executeTurn(state, [useMove(1, MOVE_MEMENTO), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.hp).toBe(100)
          expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(6)
        })
      })

      describe('EFFECT_SOAK', () => {
        it('makes target pure Water and deducts PP', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SOAK', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, types: ['FIRE', 'FLYING', 'MYSTERY'] },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_SOAK), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'WATER', 'MYSTERY'])
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        })

        it('fails on target that is already pure Water', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SOAK', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_SOAK), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
          expect(state.battlers[0]!.mon.pp[0]).toBe(19)
        })

        it('fails if target has Substitute', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SOAK', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, types: ['FIRE', 'MYSTERY', 'MYSTERY'], status2: STATUS2_SUBSTITUTE },
            ],
            rng,
          )
          state.battlers[1]!.volatiles.substituteHp = 25

          const out = executeTurn(state, [useMove(1, MOVE_SOAK), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[1]!.mon.types).toEqual(['FIRE', 'MYSTERY', 'MYSTERY'])
        })

        it('Magic Powder turns target into pure Psychic', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MAGIC_POWDER', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, types: ['GRASS', 'POISON', 'MYSTERY'] },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_MAGIC_POWDER), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.types).toEqual(['PSYCHIC', 'PSYCHIC', 'MYSTERY'])
        })

        it('compares type1/type2 only: a Water/Water target with a Grass type3 still fails (VARIOUS_TRY_SOAK :7369)', () => {
          const state = battle(
            [
              { moves: ['MOVE_SOAK', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, types: ['WATER', 'WATER', 'GRASS'] },
            ],
            countingRng(),
          )
          const out = executeTurn(state, [useMove(1, MOVE_SOAK), null], testDeps())
          expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
          expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'WATER', 'GRASS'])
        })
      })

      describe('EFFECT_THIRD_TYPE', () => {
        it("Forest's Curse adds Grass as the third type", () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FORESTS_CURSE', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_FORESTS_CURSE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'GRASS'])
        })

        it("Forest's Curse fails if target is already Grass type", () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FORESTS_CURSE', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, types: ['GRASS', 'POISON', 'MYSTERY'] },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_FORESTS_CURSE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
        })

        it('Trick-or-Treat sets trickOrTreat flag and succeeds even if target is already Ghost', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_TRICK_OR_TREAT', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50, types: ['GHOST', 'POISON', 'MYSTERY'] },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_TRICK_OR_TREAT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.volatiles.trickOrTreat).toBe(true)
          expect(state.battlers[1]!.mon.types[2]).toBe('GHOST')
        })

        it('Incite adds Dark as third type and inflicts ENRAGED status', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_INCITE', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50, types: ['FIRE', 'FLYING', 'MYSTERY'] },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_INCITE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.types).toEqual(['FIRE', 'FLYING', 'DARK'])
          expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ENRAGED)).toBe(true)
          expect(act.statusApplied).toEqual({ battlerId: 1, status: 'ENRAGED' })
        })
      })

      describe('EFFECT_CONVERSION', () => {
        it("changes the user to its first non-mystery move's type and boosts SpAtk/Speed", () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              {
                moves: ['MOVE_THUNDER_WAVE', 'MOVE_CONVERSION', null, null],
                pp: [20, 30, 0, 0],
                types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
              },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(2, MOVE_CONVERSION), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.types).toEqual(['ELECTRIC', 'ELECTRIC', 'MYSTERY'])
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
        })

        it('fails type change if already of that type but still raises stats per C quirk', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              {
                moves: ['MOVE_CONVERSION', 'MOVE_EMBER', null, null],
                pp: [30, 25, 0, 0],
                types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
              },
              { spe: 50 },
            ],
            rng,
          )

          // Conversion is move 0 (type NORMAL); user is already pure NORMAL.
          // Type change fails in C, but it still proceeds to stat buffs!
          const out = executeTurn(state, [useMove(1, MOVE_CONVERSION), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
          expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(7)
          expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
        })
      })

      describe('EFFECT_REFLECT_TYPE', () => {
        it("copies user's type1 and type2 onto the target (ER design)", () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              {
                moves: ['MOVE_REFLECT_TYPE', null, null, null],
                pp: [15, 0, 0, 0],
                types: ['ELECTRIC', 'STEEL', 'MYSTERY'],
              },
              {
                spe: 50,
                types: ['FIRE', 'FLYING', 'GRASS'],
              },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_REFLECT_TYPE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.battlers[1]!.mon.types).toEqual(['ELECTRIC', 'STEEL', 'GRASS'])
        })

        it('fails if target is Arceus or Silvally', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              {
                moves: ['MOVE_REFLECT_TYPE', null, null, null],
                pp: [15, 0, 0, 0],
                types: ['FIRE', 'MYSTERY', 'MYSTERY'],
              },
              {
                spe: 50,
                types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
              },
            ],
            rng,
          )
          state.battlers[1]!.mon.speciesId = 'SPECIES_ARCEUS'

          const out = executeTurn(state, [useMove(1, MOVE_REFLECT_TYPE), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
        })

        it("a mono-typed user writes its type into both of the target's slots (:7355-7357)", () => {
          const state = battle(
            [
              { moves: ['MOVE_REFLECT_TYPE', null, null, null], pp: [15, 0, 0, 0], types: ['FIRE', 'MYSTERY', 'MYSTERY'] },
              { spe: 50, types: ['WATER', 'GROUND', 'GRASS'] },
            ],
            countingRng(),
          )
          executeTurn(state, [useMove(1, MOVE_REFLECT_TYPE), null], testDeps())
          expect(state.battlers[1]!.mon.types).toEqual(['FIRE', 'FIRE', 'GRASS'])
        })

        it('a user with type1 MYSTERY (e.g. after Burn Up) copies its type2 twice (:7352-7354)', () => {
          const state = battle(
            [
              { moves: ['MOVE_REFLECT_TYPE', null, null, null], pp: [15, 0, 0, 0], types: ['MYSTERY', 'FLYING', 'MYSTERY'] },
              { spe: 50, types: ['WATER', 'GROUND', 'MYSTERY'] },
            ],
            countingRng(),
          )
          executeTurn(state, [useMove(1, MOVE_REFLECT_TYPE), null], testDeps())
          expect(state.battlers[1]!.mon.types).toEqual(['FLYING', 'FLYING', 'MYSTERY'])
        })

        it('fails when the user has no type1/type2 (:7358-7359)', () => {
          const state = battle(
            [
              { moves: ['MOVE_REFLECT_TYPE', null, null, null], pp: [15, 0, 0, 0], types: ['MYSTERY', 'MYSTERY', 'GHOST'] },
              { spe: 50, types: ['WATER', 'GROUND', 'MYSTERY'] },
            ],
            countingRng(),
          )
          const out = executeTurn(state, [useMove(1, MOVE_REFLECT_TYPE), null], testDeps())
          expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
          expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'GROUND', 'MYSTERY'])
        })
      })

      describe('EFFECT_LUCKY_CHANT', () => {
        it('sets luckyChantTimer to 5 and sets SIDE_STATUS_LUCKY_CHANT', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_LUCKY_CHANT', null, null, null], pp: [30, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_LUCKY_CHANT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.sides[0]!.timers.luckyChantTimer).toBe(5)
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_LUCKY_CHANT)).toBe(true)
        })

        it('fails if Lucky Chant is already active on user side', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_LUCKY_CHANT', null, null, null], pp: [30, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.sides[0]!.statuses |= SIDE_STATUS_LUCKY_CHANT
          state.sides[0]!.timers.luckyChantTimer = 3

          const out = executeTurn(state, [useMove(1, MOVE_LUCKY_CHANT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
        })
      })

      describe('EFFECT_QUICK_GUARD', () => {
        it('sets quickGuardTimer to 3 and blocks opposing priority attack', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_QUICK_GUARD', null, null, null], pp: [15, 0, 0, 0], spe: 100 },
              { moves: ['MOVE_BABY_DOLL_EYES', null, null, null], pp: [30, 0, 0, 0], spe: 50 },
            ],
            rng,
          )

          const guard = useMove(1, MOVE_QUICK_GUARD)
          guard.chosenMove = { ...guard.chosenMove!, priority: 1 }
          const eyes = useMove(0, MOVE_BABY_DOLL_EYES)
          eyes.chosenMove = { ...eyes.chosenMove!, priority: 1 }
          const out = executeTurn(state, [guard, eyes], deps)
          const act0 = out.actions.find((a) => a.battlerId === 0)!
          expect(act0.missed).toBe(false)
          // started.quickGuard keeps ENDTURN_MISC_SIDE_TIMERS from ticking it on the setting turn.
          expect(state.sides[0]!.timers.quickGuardTimer).toBe(3)

          const act1 = out.actions.find((a) => a.battlerId === 1)!
          expect(act1.cancelledBy).toBe('QUICK_GUARD')
          expect(state.battlers[1]!.mon.pp[0]).toBe(30) // BattleScript_ButItFailed has no ppreduce
        })

        it('does not block a priority-0 move', () => {
          const state = battle(
            [
              { moves: ['MOVE_QUICK_GUARD', null, null, null], pp: [15, 0, 0, 0], spe: 100 },
              { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], spe: 50 },
            ],
            countingRng(),
          )
          const out = executeTurn(state, [useMove(1, MOVE_QUICK_GUARD), useMove(0, MOVE_TACKLE)], testDeps())
          expect(out.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBeNull()
        })

        it('fails if Quick Guard is already active', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_QUICK_GUARD', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.sides[0]!.timers.quickGuardTimer = 2

          const out = executeTurn(state, [useMove(1, MOVE_QUICK_GUARD), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
        })
      })

      describe('EFFECT_MAT_BLOCK', () => {
        it('succeeds on first turn, protects against attack, and wears off at end of turn', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MAT_BLOCK', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
              { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], spe: 50 },
            ],
            rng,
          )
          state.battlers[0]!.volatiles.isFirstTurn = 1

          const out = executeTurn(state, [useMove(1, MOVE_MAT_BLOCK), useMove(0, MOVE_TACKLE)], deps)
          const act0 = out.actions.find((a) => a.battlerId === 0)!
          expect(act0.missed).toBe(false)

          const act1 = out.actions.find((a) => a.battlerId === 1)!
          expect(act1.missed).toBe(true)
          expect(act1.targetDamage).toBeNull()

          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_MAT_BLOCK)).toBe(false)
        })

        it('fails if not the user first turn', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MAT_BLOCK', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
              { spe: 50 },
            ],
            rng,
          )
          state.battlers[0]!.volatiles.isFirstTurn = 0

          const out = executeTurn(state, [useMove(1, MOVE_MAT_BLOCK), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
          expect(state.battlers[0]!.mon.pp[0]).toBe(9) // ButItFailedAtkStringPpReduce
        })
      })

      describe('EFFECT_SMOKESCREEN', () => {
        it('sets smokescreenTimer to 5 and sets SIDE_STATUS_SMOKESCREEN', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SMOKESCREEN', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_SMOKESCREEN), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.sides[0]!.timers.smokescreenTimer).toBe(5)
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SMOKESCREEN)).toBe(true)
        })

        it('fails if Smokescreen is already active', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_SMOKESCREEN', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.sides[0]!.statuses |= SIDE_STATUS_SMOKESCREEN
          state.sides[0]!.timers.smokescreenTimer = 4

          const out = executeTurn(state, [useMove(1, MOVE_SMOKESCREEN), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
        })

        it("succeeds without resetting a timer-only smokescreen (jumpifsideaffecting reads the bit, :12389)", () => {
          const state = battle(
            [
              { moves: ['MOVE_SMOKESCREEN', null, null, null], pp: [20, 0, 0, 0] },
              { spe: 50 },
            ],
            countingRng(),
          )
          state.sides[0]!.timers.smokescreenTimer = 3
          const out = executeTurn(state, [useMove(1, MOVE_SMOKESCREEN), null], testDeps())
          expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
          expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SMOKESCREEN)).toBe(false)
        })
      })

      describe('EFFECT_MUD_SPORT and EFFECT_WATER_SPORT', () => {
        it('Mud Sport sets field mudSportTimer to 5 and STATUS_FIELD_MUDSPORT', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MUD_SPORT', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_MUD_SPORT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.field.timers.mudSportTimer).toBe(SPORT_DURATION)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_MUDSPORT)).toBe(true)
        })

        it('Mud Sport fails if already active', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_MUD_SPORT', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.field.statuses |= STATUS_FIELD_MUDSPORT
          state.field.timers.mudSportTimer = 3

          const out = executeTurn(state, [useMove(1, MOVE_MUD_SPORT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
        })

        it('Water Sport sets field waterSportTimer to 5 and STATUS_FIELD_WATERSPORT', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_WATER_SPORT', null, null, null], pp: [15, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_WATER_SPORT), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          // Kept quirk: ENDTURN_WATER_SPORT (battle_util.c:2148) has no started.waterSport check, unlike
          // Mud Sport's (:2156), so the setting turn already counts down.
          expect(state.field.timers.waterSportTimer).toBe(SPORT_DURATION - 1)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_WATERSPORT)).toBe(true)
        })
      })

      describe('EFFECT_FAIRY_LOCK', () => {
        it('sets fairyLockTimer to 1, sets STATUS_FIELD_FAIRY_LOCK, and prevents escape', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FAIRY_LOCK', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )

          const out = executeTurn(state, [useMove(1, MOVE_FAIRY_LOCK), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(false)
          expect(state.field.timers.fairyLockTimer).toBe(1)
          expect(hasFlag(state.field.statuses, STATUS_FIELD_FAIRY_LOCK)).toBe(true)
          expect(canBattlerEscape(state, 1, deps)).toBe(false)
        })

        it('fails if Fairy Lock is already active', () => {
          const deps = testDeps()
          const rng = countingRng()
          const state = battle(
            [
              { moves: ['MOVE_FAIRY_LOCK', null, null, null], pp: [10, 0, 0, 0] },
              { spe: 50 },
            ],
            rng,
          )
          state.field.statuses |= STATUS_FIELD_FAIRY_LOCK
          state.field.timers.fairyLockTimer = 1

          const out = executeTurn(state, [useMove(1, MOVE_FAIRY_LOCK), null], deps)
          const act = out.actions.find((a) => a.battlerId === 0)!
          expect(act.missed).toBe(true)
        })
      })

      describe('Cycle 59: Ability-change moves', () => {
        describe('EFFECT_GASTRO_ACID', () => {
          it('Gastro Acid sets STATUS3_GASTRO_ACID and applies poison on success', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_GASTRO_ACID', null, null, null], pp: [10, 0, 0, 0] },
                {
                  types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_GASTRO_ACID), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
            expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
            expect(act.statusApplied?.status).toBe('POISON')
            // Deducted 1 PP on success path (:2585)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails via BattleScript_EffectPoison on Steel type when target already has Gastro Acid and costs a second PP', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_GASTRO_ACID', null, null, null], pp: [10, 0, 0, 0] },
                {
                  types: ['STEEL', 'MYSTERY', 'MYSTERY'],
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )
            state.battlers[1]!.statuses3 |= STATUS3_GASTRO_ACID

            const out = executeTurn(state, [useMove(1, MOVE_GASTRO_ACID), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            // BattleScript_EffectPoison -> requirecandoeffect fails on Steel type
            expect(act.missed).toBe(true)
            // ppreduce called twice: once at Gastro Acid :2585 and once at EffectPoison :4335
            expect(state.battlers[0]!.mon.pp[0]).toBe(8)
          })

          it('fails if target holds Ability Shield and cannot be poisoned', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_GASTRO_ACID', null, null, null], pp: [10, 0, 0, 0] },
                {
                  types: ['STEEL', 'MYSTERY', 'MYSTERY'],
                  itemId: 'ITEM_ABILITY_SHIELD',
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_GASTRO_ACID), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(8)
          })
        })

        describe('EFFECT_SIMPLE_BEAM', () => {
          it('makes target primary ability ABILITY_SIMPLE and clears abilityState[0]', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_SIMPLE_BEAM', null, null, null], pp: [15, 0, 0, 0] },
                {
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )
            state.battlers[1]!.volatiles.abilityState[0] = 5

            const out = executeTurn(state, [useMove(1, MOVE_SIMPLE_BEAM), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_SIMPLE')
            expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
          })

          it('fails if target already has ABILITY_SIMPLE in primary slot', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_SIMPLE_BEAM', null, null, null], pp: [15, 0, 0, 0] },
                {
                  abilities: { ability: ABILITY_SIMPLE, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_SIMPLE_BEAM), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
          })

          it('fails if target already has ABILITY_SIMPLE in an innate slot (HasAbilityIgnoringSuppression)', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_SIMPLE_BEAM', null, null, null], pp: [15, 0, 0, 0] },
                {
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [ABILITY_SIMPLE, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_SIMPLE_BEAM), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
          })

          it('fails if target holds Ability Shield', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_SIMPLE_BEAM', null, null, null], pp: [15, 0, 0, 0] },
                {
                  itemId: 'ITEM_ABILITY_SHIELD',
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_SIMPLE_BEAM), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
          })
        })

        describe('EFFECT_WORRY_SEED', () => {
          it('Worry Seed sets ABILITY_INSOMNIA and applies Fear', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_WORRY_SEED', null, null, null], pp: [10, 0, 0, 0] },
                {
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )
            state.battlers[1]!.volatiles.abilityState[0] = 3

            const out = executeTurn(state, [useMove(1, MOVE_WORRY_SEED), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_INSOMNIA')
            expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
            expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
            expect(state.battlers[1]!.volatiles.fear).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('on tryworryseed fail (target already has Insomnia), branches to EffectWorrySeed_Fear and still applies Fear', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_WORRY_SEED', null, null, null], pp: [10, 0, 0, 0] },
                {
                  abilities: { ability: ABILITY_INSOMNIA, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_WORRY_SEED), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            // Does not fail/miss: branches to BattleScript_EffectWorrySeed_Fear
            expect(act.missed).toBe(false)
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_INSOMNIA')
            expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
            expect(state.battlers[1]!.volatiles.fear).toBe(true)
          })

          it('fails to replace an unsuppressable ability (Comatose) but still applies Fear', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_WORRY_SEED', null, null, null], pp: [10, 0, 0, 0] },
                {
                  abilities: { ability: ABILITY_COMATOSE, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_WORRY_SEED), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_COMATOSE')
            expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
            expect(state.battlers[1]!.volatiles.fear).toBe(true)
          })
        })

        describe('EFFECT_ENTRAINMENT', () => {
          it('copies user primary ability to target and triggers target switch-in ability (Drought sets Sun)', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_ENTRAINMENT', null, null, null],
                  abilities: { ability: ABILITY_DROUGHT, innates: [null, null, null] },
                  pp: [15, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_ENTRAINMENT), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_DROUGHT')
            // switchinabilities BS_TARGET: target triggers Drought, activating Sun
            expect(hasFlag(state.field.weather, WEATHER_SUN_ANY)).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
          })

          it('fails if user has a banned ability (Wonder Guard)', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_ENTRAINMENT', null, null, null],
                  abilities: { ability: ABILITY_WONDER_GUARD, innates: [null, null, null] },
                  pp: [15, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_ENTRAINMENT), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
          })

          it('fails if target already has user ability in an innate slot (HasAbilityIgnoringSuppression)', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_ENTRAINMENT', null, null, null],
                  abilities: { ability: ABILITY_DROUGHT, innates: [null, null, null] },
                  pp: [15, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [ABILITY_DROUGHT, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_ENTRAINMENT), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
          })
        })

        describe('EFFECT_ROLE_PLAY', () => {
          it('copies target primary ability to user and resets user abilityState[0]', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_ROLE_PLAY', null, null, null],
                  abilities: { ability: ABILITY_DROUGHT, innates: [null, null, null] },
                  pp: [10, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )
            state.battlers[0]!.volatiles.abilityState[0] = 7

            const out = executeTurn(state, [useMove(1, MOVE_ROLE_PLAY), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
            expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails on banned target ability (Wonder Guard) and still costs PP (ppreduce before fail)', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_ROLE_PLAY', null, null, null],
                  abilities: { ability: ABILITY_DROUGHT, innates: [null, null, null] },
                  pp: [10, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_WONDER_GUARD, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_ROLE_PLAY), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_DROUGHT')
            // ppreduce ran before trycopyability / BattleScript_ButItFailed (:6297)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails if user already has target ability in an innate slot (HasAbilityIgnoringSuppression)', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_ROLE_PLAY', null, null, null],
                  abilities: { ability: ABILITY_DROUGHT, innates: [ABILITY_CLEAR_BODY, null, null] },
                  pp: [10, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_ROLE_PLAY), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
          })
        })

        describe('EFFECT_SKILL_SWAP', () => {
          it('swaps primaries between user and target, updates ability states, and triggers switch-in abilities', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_SKILL_SWAP', null, null, null],
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  pp: [10, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_DROUGHT, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )
            state.battlers[0]!.volatiles.abilityState[0] = 2
            state.battlers[1]!.volatiles.abilityState[0] = 4

            const out = executeTurn(state, [useMove(1, MOVE_SKILL_SWAP), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_DROUGHT')
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
            expect(state.battlers[0]!.volatiles.abilityState[0]).toBe(0)
            expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
            // switchinabilities triggers: user got Drought -> sets Sun!
            expect(hasFlag(state.field.weather, WEATHER_SUN_ANY)).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails on banned ability (Wonder Guard on target) and costs PP (ppreduce before fail)', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_SKILL_SWAP', null, null, null],
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  pp: [10, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_WONDER_GUARD, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_SKILL_SWAP), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_WONDER_GUARD')
            // ppreduce ran before tryswapabilities (:6452)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails if target holds Ability Shield', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_SKILL_SWAP', null, null, null],
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [null, null, null] },
                  pp: [10, 0, 0, 0],
                },
                {
                  itemId: 'ITEM_ABILITY_SHIELD',
                  abilities: { ability: ABILITY_DROUGHT, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_SKILL_SWAP), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.abilities.ability).toBe('ABILITY_CLEAR_BODY')
            expect(state.battlers[1]!.mon.abilities.ability).toBe('ABILITY_DROUGHT')
          })

          it('fails if user already has target ability in an innate slot (HasAbilityIgnoringSuppression)', () => {
            const deps = testDeps()
            const rng = countingRng()
            const state = battle(
              [
                {
                  moves: ['MOVE_SKILL_SWAP', null, null, null],
                  abilities: { ability: ABILITY_CLEAR_BODY, innates: [ABILITY_DROUGHT, null, null] },
                  pp: [10, 0, 0, 0],
                },
                {
                  abilities: { ability: ABILITY_DROUGHT, innates: [null, null, null] },
                  spe: 50,
                },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_SKILL_SWAP), null], deps)
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
          })
        })
      })

      describe('Cycle 60: Spite, Grudge, Imprison, Telekinesis, Electrify, Power Trick, Ion Deluge, Powder', () => {
        describe('EFFECT_SPITE', () => {
          it("cuts the target's last-used move's PP by 4 (B_PP_REDUCED_BY_SPITE >= GEN_4)", () => {
            const state = battle(
              [
                { moves: ['MOVE_SPITE', null, null, null], pp: [10, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[1]!.lastMove = 'MOVE_TACKLE'

            const out = executeTurn(state, [useMove(1, MOVE_SPITE), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(state.battlers[1]!.mon.pp[0]).toBe(6)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails when the target has no last move, and still costs the user PP (ppreduce precedes tryspiteppreduce)', () => {
            const state = battle(
              [
                { moves: ['MOVE_SPITE', null, null, null], pp: [10, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[1]!.lastMove = null

            const out = executeTurn(state, [useMove(1, MOVE_SPITE), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(state.battlers[1]!.mon.pp[0]).toBe(10)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails when the last move has 0 PP left (B_CAN_SPITE_FAIL >= GEN_4)', () => {
            const state = battle(
              [
                { moves: ['MOVE_SPITE', null, null, null], pp: [10, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [0, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[1]!.lastMove = 'MOVE_TACKLE'

            const out = executeTurn(state, [useMove(1, MOVE_SPITE), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('clamps the cut to the remaining PP and cancels a multi-turn move when PP reaches 0', () => {
            const state = battle(
              [
                { moves: ['MOVE_SPITE', null, null, null], pp: [10, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [2, 0, 0, 0], status2: STATUS2_MULTIPLETURNS },
              ],
              countingRng(),
            )
            state.battlers[1]!.lastMove = 'MOVE_TACKLE'

            const out = executeTurn(state, [useMove(1, MOVE_SPITE), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(state.battlers[1]!.mon.pp[0]).toBe(0)
            expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
          })
        })

        describe('EFFECT_GRUDGE', () => {
          it('sets STATUS3_GRUDGE on the user (the next attackcanceler clears it, so check after a turn with no further move)', () => {
            const state = battle(
              [
                { moves: ['MOVE_GRUDGE', null, null, null], pp: [5, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_GRUDGE), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GRUDGE)).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          })

          it('re-using Grudge with it already set succeeds: CANCELLER_FLAGS clears it first, so setuserstatus3 never sees it set', () => {
            const state = battle(
              [
                { moves: ['MOVE_GRUDGE', null, null, null], pp: [5, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[0]!.statuses3 = setFlag(state.battlers[0]!.statuses3, STATUS3_GRUDGE)

            const out = executeTurn(state, [useMove(0, MOVE_GRUDGE), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GRUDGE)).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(4)
          })

          it("zeroes the PP of the move that faints the Grudge user (Cmd_tryfaintmon, :3252-3263)", () => {
            const lethal: DamageResolver & { calls: number } = {
              calls: 0,
              resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [] }),
            }
            const state = battle(
              [
                { hp: 10, moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0], spe: 10 },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
              ],
              countingRng(),
            )
            state.battlers[0]!.statuses3 = setFlag(state.battlers[0]!.statuses3, STATUS3_GRUDGE)

            executeTurn(state, [null, useMove(0, MOVE_TACKLE)], testDeps(lethal))
            expect(state.battlers[0]!.mon.hp).toBe(0)
            expect(state.battlers[1]!.mon.pp[0]).toBe(0)
            expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GRUDGE)).toBe(false)
          })
        })

        describe('EFFECT_IMPRISON', () => {
          it('sets STATUS3_IMPRISONED_OTHERS when the user shares a move with a foe', () => {
            const state = battle(
              [
                { moves: ['MOVE_IMPRISON', 'MOVE_TACKLE', null, null], pp: [10, 10, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_IMPRISON), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_IMPRISONED_OTHERS)).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails when no move is shared with a foe, and still costs PP (ppreduce precedes tryimprison)', () => {
            const state = battle(
              [
                { moves: ['MOVE_IMPRISON', null, null, null], pp: [10, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_IMPRISON), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_IMPRISONED_OTHERS)).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails when the user already has STATUS3_IMPRISONED_OTHERS', () => {
            const state = battle(
              [
                { moves: ['MOVE_IMPRISON', 'MOVE_TACKLE', null, null], pp: [10, 10, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[0]!.statuses3 = setFlag(state.battlers[0]!.statuses3, STATUS3_IMPRISONED_OTHERS)

            const out = executeTurn(state, [useMove(0, MOVE_IMPRISON), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('CANCELLER_IMPRISONED stops a foe from using a move the imprisoner knows', () => {
            const state = battle(
              [
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0], spe: 10 },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
              ],
              countingRng(),
            )
            state.battlers[0]!.statuses3 = setFlag(state.battlers[0]!.statuses3, STATUS3_IMPRISONED_OTHERS)

            const out = executeTurn(state, [null, useMove(0, MOVE_TACKLE)], testDeps())
            expect(out.actions.find((a) => a.battlerId === 1)!.cancelledBy).toBe('IMPRISON')
            expect(state.battlers[0]!.mon.hp).toBe(100)
          })
        })

        describe('EFFECT_TELEKINESIS', () => {
          it('sets STATUS3_TELEKINESIS with a 3 turn timer that ENDTURN_TELEKINESIS counts down and clears', () => {
            const state = battle(
              [
                { moves: ['MOVE_TELEKINESIS', null, null, null], pp: [15, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_TELEKINESIS), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_TELEKINESIS)).toBe(true)
            expect(state.battlers[1]!.volatiles.telekinesisTimer).toBe(2)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)

            executeTurn(state, [null, null], testDeps())
            expect(state.battlers[1]!.volatiles.telekinesisTimer).toBe(1)
            expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_TELEKINESIS)).toBe(true)

            executeTurn(state, [null, null], testDeps())
            expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_TELEKINESIS)).toBe(false)
          })

          it('fails on a banned species (sTelekinesisBanList) and still costs PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_TELEKINESIS', null, null, null], pp: [15, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[1]!.mon.speciesId = 'SPECIES_DIGLETT'

            const out = executeTurn(state, [useMove(1, MOVE_TELEKINESIS), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_TELEKINESIS)).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
          })

          it('fails when the target is STATUS3_ROOTED', () => {
            const state = battle(
              [
                { moves: ['MOVE_TELEKINESIS', null, null, null], pp: [15, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[1]!.statuses3 = setFlag(state.battlers[1]!.statuses3, STATUS3_ROOTED)

            const out = executeTurn(state, [useMove(1, MOVE_TELEKINESIS), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
          })

          it('fails when the target already has STATUS3_TELEKINESIS (Gravity is unreachable here: it cancels Telekinesis first)', () => {
            const state = battle(
              [
                { moves: ['MOVE_TELEKINESIS', null, null, null], pp: [15, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[1]!.statuses3 = setFlag(state.battlers[1]!.statuses3, STATUS3_TELEKINESIS)
            state.battlers[1]!.volatiles.telekinesisTimer = 3

            const out = executeTurn(state, [useMove(1, MOVE_TELEKINESIS), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(state.battlers[1]!.volatiles.telekinesisTimer).toBe(2)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
          })
        })

        describe('EFFECT_ELECTRIFY', () => {
          it('succeeds when the user acts before the target: bumps protectUses and notes the unported type reader', () => {
            const state = battle(
              [
                { moves: ['MOVE_ELECTRIFY', null, null, null], pp: [3, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_ELECTRIFY), useMove(0, MOVE_TACKLE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.volatiles.protectUses).toBe(1)
            expect(state.battlers[0]!.mon.pp[0]).toBe(2)
            expect(act.unmodelled.some((m) => m.includes('STATUS4_ELECTRIFIED'))).toBe(true)
          })

          it('fails when the target has already acted (gCurrentTurnActionNumber >= target turn order), resets protectUses and costs PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_ELECTRIFY', null, null, null], pp: [3, 0, 0, 0], spe: 10 },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
              ],
              countingRng(),
            )
            state.battlers[0]!.volatiles.protectUses = 2

            const out = executeTurn(state, [useMove(1, MOVE_ELECTRIFY), useMove(0, MOVE_TACKLE)], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(state.battlers[0]!.volatiles.protectUses).toBe(0)
            expect(state.battlers[0]!.mon.pp[0]).toBe(2)
          })

          it('ENDTURN_ELECTRIFY clears STATUS4_ELECTRIFIED', () => {
            const state = battle([{}, {}], countingRng())
            state.battlers[1]!.statuses4 = setFlag(state.battlers[1]!.statuses4, STATUS4_ELECTRIFIED)

            executeTurn(state, [null, null], testDeps())
            expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_ELECTRIFIED)).toBe(false)
          })
        })

        describe('EFFECT_POWER_TRICK', () => {
          it('swaps Attack and Defense (stats and stages) and sets STATUS3_POWER_TRICK; a second use swaps back', () => {
            const state = battle(
              [
                { moves: ['MOVE_POWER_TRICK', null, null, null], pp: [10, 0, 0, 0], atk: 120, def: 70 },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[0]!.mon.statStages[STAT_ATK] = 8
            state.battlers[0]!.mon.statStages[STAT_DEF] = 5

            const out = executeTurn(state, [useMove(0, MOVE_POWER_TRICK), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_POWER_TRICK)).toBe(true)
            expect(state.battlers[0]!.mon.rawStats.atk).toBe(70)
            expect(state.battlers[0]!.mon.rawStats.def).toBe(120)
            expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(5)
            expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(8)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)

            executeTurn(state, [useMove(0, MOVE_POWER_TRICK), null], testDeps())
            expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_POWER_TRICK)).toBe(false)
            expect(state.battlers[0]!.mon.rawStats.atk).toBe(120)
            expect(state.battlers[0]!.mon.rawStats.def).toBe(70)
          })
        })

        describe('EFFECT_ION_DELUGE', () => {
          it('costs PP and succeeds, noting the unported type reader (the flag itself is cleared by ENDTURN_ION_DELUGE in the same executeTurn)', () => {
            const state = battle(
              [
                { moves: ['MOVE_ION_DELUGE', null, null, null], pp: [20, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_ION_DELUGE), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
            expect(act.unmodelled.some((m) => m.includes('STATUS_FIELD_ION_DELUGE'))).toBe(true)
          })
        })

        describe('EFFECT_POWDER', () => {
          it('sets STATUS2_POWDER on the target: its Fire move that turn reaches CANCELLER_POWDER_STATUS', () => {
            const state = battle(
              [
                { moves: ['MOVE_POWDER', null, null, null], pp: [20, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_EMBER', null, null, null], pp: [25, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_POWDER), useMove(0, MOVE_EMBER)], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
            expect(
              out.actions.find((a) => a.battlerId === 1)!.unmodelled.some((m) => m.includes('CANCELLER_POWDER_STATUS')),
            ).toBe(true)
          })

          it('fails when the target already has STATUS2_POWDER, and still costs PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_POWDER', null, null, null], pp: [20, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0], status2: STATUS2_POWDER },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_POWDER), null], testDeps())
            expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          })

          it('ENDTURN_POWDER clears STATUS2_POWDER', () => {
            const state = battle([{}, { status2: STATUS2_POWDER }], countingRng())

            executeTurn(state, [null, null], testDeps())
            expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_POWDER)).toBe(false)
          })
        })

        describe('EFFECT_DO_NOTHING', () => {
          it('costs PP and changes nothing (Celebrate / vanilla Splash)', () => {
            const state = battle(
              [
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [20, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_CELEBRATE), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.statChanges).toEqual([])
            expect(act.statusApplied).toBeNull()
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
            expect(state.battlers[0]!.mon.hp).toBe(100)
            expect(state.battlers[1]!.mon.hp).toBe(100)
          })

          it('Hold Hands fails in singles when gBattlerTarget == gBattlerAttacker and still costs PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_HOLD_HANDS', null, null, null], pp: [20, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_HOLD_HANDS), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          })
        })

        describe('EFFECT_AUTOTOMIZE', () => {
          it('raises user Speed by +2, increments autotomizeCount, and notes the weight reader gap', () => {
            const state = battle(
              [
                { moves: ['MOVE_AUTOTOMIZE', null, null, null], pp: [15, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_AUTOTOMIZE), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 2 }])
            expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
            expect(state.battlers[0]!.volatiles.autotomizeCount).toBe(1)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
            expect(act.unmodelled.some((m) => m.includes('autotomizeCount'))).toBe(true)
          })

          it('fails when Speed is already at MAX_STAT_STAGE: does not increment autotomizeCount or gap weight', () => {
            const state = battle(
              [
                { moves: ['MOVE_AUTOTOMIZE', null, null, null], pp: [15, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE

            const out = executeTurn(state, [useMove(0, MOVE_AUTOTOMIZE), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(act.statChanges).toEqual([])
            expect(state.battlers[0]!.volatiles.autotomizeCount).toBe(0)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
            expect(act.unmodelled.some((m) => m.includes('autotomizeCount'))).toBe(false)
          })
        })

        describe('EFFECT_FLOWER_SHIELD', () => {
          it('raises Defense by +1 of Grass-type battlers only (including airborne Grass-types)', () => {
            const state = battle(
              [
                {
                  moves: ['MOVE_FLOWER_SHIELD', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['GRASS', 'FLYING', 'MYSTERY'],
                },
                {
                  moves: ['MOVE_TACKLE', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['WATER', 'MYSTERY', 'MYSTERY'],
                },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_FLOWER_SHIELD), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 1 }])
            expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('fails when no battler on the field is Grass-type, and still costs PP', () => {
            const state = battle(
              [
                {
                  moves: ['MOVE_FLOWER_SHIELD', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['FAIRY', 'MYSTERY', 'MYSTERY'],
                },
                {
                  moves: ['MOVE_TACKLE', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['WATER', 'MYSTERY', 'MYSTERY'],
                },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_FLOWER_SHIELD), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(act.statChanges).toEqual([])
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })
        })

        describe('EFFECT_ROTOTILLER', () => {
          it('raises Atk and SpAtk by +1 of grounded Grass-types only (or +2 in Grassy Terrain)', () => {
            const state = battle(
              [
                {
                  moves: ['MOVE_ROTOTILLER', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['GRASS', 'MYSTERY', 'MYSTERY'],
                },
                {
                  moves: ['MOVE_TACKLE', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['GRASS', 'FLYING', 'MYSTERY'],
                },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_ROTOTILLER), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.statChanges).toEqual([
              { battlerId: 0, stat: STAT_ATK, change: 1 },
              { battlerId: 0, stat: STAT_SPATK, change: 1 },
            ])
            expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
            expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })

          it('raises Atk and SpAtk by +2 when STATUS_FIELD_GRASSY_TERRAIN is active', () => {
            const state = battle(
              [
                {
                  moves: ['MOVE_ROTOTILLER', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['GRASS', 'MYSTERY', 'MYSTERY'],
                },
                {
                  moves: ['MOVE_TACKLE', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['WATER', 'MYSTERY', 'MYSTERY'],
                },
              ],
              countingRng(),
            )
            state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)
            state.field.timers.terrainTimer = 5

            const out = executeTurn(state, [useMove(0, MOVE_ROTOTILLER), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.statChanges).toEqual([
              { battlerId: 0, stat: STAT_ATK, change: 2 },
              { battlerId: 0, stat: STAT_SPATK, change: 2 },
            ])
          })

          it('fails when no grounded Grass-type battler qualifies, and still costs PP', () => {
            const state = battle(
              [
                {
                  moves: ['MOVE_ROTOTILLER', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['GROUND', 'MYSTERY', 'MYSTERY'],
                },
                {
                  moves: ['MOVE_TACKLE', null, null, null],
                  pp: [10, 0, 0, 0],
                  types: ['GRASS', 'FLYING', 'MYSTERY'],
                },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_ROTOTILLER), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(act.statChanges).toEqual([])
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })
        })

        describe('EFFECT_MAGNETIC_FLUX', () => {
          it('raises Def and SpDef by +1 when the user has Plus or Minus', () => {
            const state = battle(
              [
                {
                  moves: ['MOVE_MAGNETIC_FLUX', null, null, null],
                  pp: [20, 0, 0, 0],
                  abilities: { ability: ABILITY_PLUS, innates: [null, null, null] },
                },
                {
                  moves: ['MOVE_TACKLE', null, null, null],
                  pp: [10, 0, 0, 0],
                  abilities: { ability: ABILITY_MINUS, innates: [null, null, null] },
                },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_MAGNETIC_FLUX), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.statChanges).toEqual([
              { battlerId: 0, stat: STAT_DEF, change: 1 },
              { battlerId: 0, stat: STAT_SPDEF, change: 1 },
            ])
            expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
            expect(state.battlers[1]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          })

          it('fails when neither user nor ally has Plus or Minus, and still costs PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_MAGNETIC_FLUX', null, null, null], pp: [20, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_MAGNETIC_FLUX), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(act.statChanges).toEqual([])
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
          })
        })

        describe('EFFECT_COURT_CHANGE', () => {
          it('swaps swappable side statuses, timers, and battlerIds (BATTLE_OPPOSITE) between the two sides', () => {
            const state = battle(
              [
                { moves: ['MOVE_COURT_CHANGE', null, null, null], pp: [10, 0, 0, 0] },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] },
              ],
              countingRng(),
            )
            // Side 1 has Reflect (timer 4 -> swapped to side 0, then ENDTURN_REFLECT ticks it to 3)
            // Side 0 has Spikes (2 layers)
            state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)
            state.sides[1].timers.reflectTimer = 4
            state.sides[1].timers.reflectBattlerId = 1

            state.sides[0].statuses = setFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)
            state.sides[0].timers.spikesAmount = 2

            const out = executeTurn(state, [useMove(0, MOVE_COURT_CHANGE), null], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)

            // Reflect moved to side 0 (timer 4 decremented to 3 at end of turn) and reflectBattlerId = 1 ^ 1 = 0
            expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_REFLECT)).toBe(true)
            expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(false)
            expect(state.sides[0].timers.reflectTimer).toBe(3)
            expect(state.sides[1].timers.reflectTimer).toBe(0)
            expect(state.sides[0].timers.reflectBattlerId).toBe(0)

            // Spikes moved to side 1 with 2 layers
            expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(true)
            expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
            expect(state.sides[1].timers.spikesAmount).toBe(2)
            expect(state.sides[0].timers.spikesAmount).toBe(0)
          })
        })

        describe('EFFECT_AFTER_YOU', () => {
          it('sets target.round.afterYou and reorders a slower target to act immediately after the user', () => {
            const state = battle(
              [
                { moves: ['MOVE_AFTER_YOU', null, null, null], pp: [15, 0, 0, 0], spe: 200 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 150 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
              ],
              countingRng(),
            )

            // Battler 0 (spe 200) targets slowest battler 2 (spe 50); recalculateMoveOrder pulls battler 2 into slot 1
            const out = executeTurn(
              state,
              [useMove(2, MOVE_AFTER_YOU), useMove(1, MOVE_CELEBRATE), useMove(2, MOVE_CELEBRATE), useMove(3, MOVE_CELEBRATE)],
              testDeps(),
            )
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.targetId).toBe(2)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
            expect(out.order.battlerByTurnOrder).toEqual([0, 2, 1, 3])
          })

          it('fails when the target has already acted this turn, and still costs PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_AFTER_YOU', null, null, null], pp: [15, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            // Battler 0 acts first at slot 0; battler 1 uses After You on battler 0 at slot 1
            const out = executeTurn(state, [useMove(0, MOVE_CELEBRATE), useMove(0, MOVE_AFTER_YOU)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 1)!
            expect(act.missed).toBe(true)
            expect(act.targetId).toBe(0)
            expect(state.battlers[1]!.mon.pp[0]).toBe(14)
          })
        })

        describe('EFFECT_QUASH', () => {
          it('sets field quashTimer to QUASH_DURATION (5) and started.quash = true when inactive', () => {
            const state = battle(
              [
                { moves: ['MOVE_QUASH', null, null, null], pp: [5, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_QUASH), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(4)
            expect(state.field.timers.quashTimer).toBe(QUASH_DURATION)
            expect(state.field.timers.started.quash).toBe(true)
          })

          it('fails when quashTimer is already active, and still costs PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_QUASH', null, null, null], pp: [5, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )
            state.field.timers.quashTimer = 3

            const out = executeTurn(state, [useMove(1, MOVE_QUASH), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(4)
            // Pre-existing quashTimer (3) was not reset to 5; ENDTURN_QUASH decremented it to 2
            expect(state.field.timers.quashTimer).toBe(2)
          })
        })

        describe('EFFECT_COACHING', () => {
          it('raises alive ally Attack and Defense by +1 stage in doubles', () => {
            const state = battle(
              [
                { moves: ['MOVE_COACHING', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 90 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 80 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 70 },
              ],
              countingRng(),
            )

            const out = executeTurn(
              state,
              [useMove(2, MOVE_COACHING), useMove(1, MOVE_CELEBRATE), useMove(2, MOVE_CELEBRATE), useMove(3, MOVE_CELEBRATE)],
              testDeps(),
            )
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.targetId).toBe(2)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(state.battlers[2]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(state.battlers[2]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(act.statChanges).toEqual([
              { battlerId: 2, stat: STAT_ATK, change: 1 },
              { battlerId: 2, stat: STAT_DEF, change: 1 },
            ])
          })

          it('fails in singles (no ally) or when ally is already at max Attack and Defense', () => {
            // Singles: no alive partner (battler 2 is absent)
            const singlesState = battle(
              [
                { moves: ['MOVE_COACHING', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )
            const singlesOut = executeTurn(
              singlesState,
              [useMove(0, MOVE_COACHING), useMove(0, MOVE_CELEBRATE)],
              testDeps(),
            )
            const singlesAct = singlesOut.actions.find((a) => a.battlerId === 0)!
            expect(singlesAct.missed).toBe(true)
            expect(singlesState.battlers[0]!.mon.pp[0]).toBe(9)

            // Doubles: ally already at MAX_STAT_STAGE for both Attack and Defense
            const doublesState = battle(
              [
                { moves: ['MOVE_COACHING', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 90 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 80 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 70 },
              ],
              countingRng(),
            )
            doublesState.battlers[2]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
            doublesState.battlers[2]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE

            const doublesOut = executeTurn(
              doublesState,
              [useMove(2, MOVE_COACHING), useMove(1, MOVE_CELEBRATE), useMove(2, MOVE_CELEBRATE), useMove(3, MOVE_CELEBRATE)],
              testDeps(),
            )
            const doublesAct = doublesOut.actions.find((a) => a.battlerId === 0)!
            expect(doublesAct.missed).toBe(true)
            expect(doublesAct.targetId).toBe(2)
            expect(doublesState.battlers[0]!.mon.pp[0]).toBe(9)
            expect(doublesAct.statChanges).toEqual([])
          })
        })

        describe('EFFECT_AROMATIC_MIST', () => {
          it('raises user and alive partner Sp. Def by +2 stages in doubles (and user alone in singles)', () => {
            const state = battle(
              [
                { moves: ['MOVE_AROMATIC_MIST', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 90 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 80 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 70 },
              ],
              countingRng(),
            )

            const out = executeTurn(
              state,
              [useMove(0, MOVE_AROMATIC_MIST), useMove(1, MOVE_CELEBRATE), useMove(2, MOVE_CELEBRATE), useMove(3, MOVE_CELEBRATE)],
              testDeps(),
            )
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 2)
            expect(state.battlers[2]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 2)
            expect(act.statChanges).toEqual([
              { battlerId: 0, stat: STAT_SPDEF, change: 2 },
              { battlerId: 2, stat: STAT_SPDEF, change: 2 },
            ])
          })

          it('fails when user is at max Sp. Def and partner is absent or also at max Sp. Def', () => {
            // Singles: user at MAX_STAT_STAGE, partner absent -> fails
            const singlesState = battle(
              [
                { moves: ['MOVE_AROMATIC_MIST', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )
            singlesState.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE

            const singlesOut = executeTurn(
              singlesState,
              [useMove(0, MOVE_AROMATIC_MIST), useMove(0, MOVE_CELEBRATE)],
              testDeps(),
            )
            const singlesAct = singlesOut.actions.find((a) => a.battlerId === 0)!
            expect(singlesAct.missed).toBe(true)
            expect(singlesState.battlers[0]!.mon.pp[0]).toBe(9)
            expect(singlesAct.statChanges).toEqual([])

            // Doubles: user at MAX_STAT_STAGE, partner also at MAX_STAT_STAGE -> fails
            const doublesState = battle(
              [
                { moves: ['MOVE_AROMATIC_MIST', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 90 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 80 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 70 },
              ],
              countingRng(),
            )
            doublesState.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
            doublesState.battlers[2]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE

            const doublesOut = executeTurn(
              doublesState,
              [useMove(0, MOVE_AROMATIC_MIST), useMove(1, MOVE_CELEBRATE), useMove(2, MOVE_CELEBRATE), useMove(3, MOVE_CELEBRATE)],
              testDeps(),
            )
            const doublesAct = doublesOut.actions.find((a) => a.battlerId === 0)!
            expect(doublesAct.missed).toBe(true)
            expect(doublesState.battlers[0]!.mon.pp[0]).toBe(9)
            expect(doublesAct.statChanges).toEqual([])
          })
        })

        describe('EFFECT_TEATIME', () => {
          it('forces all alive battlers holding non-negated berries to consume them in battler id order with sBERRY_OVERRIDE', () => {
            const state = battle(
              [
                { moves: ['MOVE_TEATIME', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: ITEM_LIECHI_BERRY.id },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, hp: 50, maxHp: 100, itemId: ITEM_SITRUS_BERRY.id },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_TEATIME), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            // Battler 0 ate Liechi Berry (+1 Atk even at full HP due to sBERRY_OVERRIDE)
            expect(state.battlers[0]!.mon.itemId).toBeNull()
            expect(state.battlers[0]!.usedHeldItem).toBe(ITEM_LIECHI_BERRY.id)
            expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
            // Battler 1 ate Sitrus Berry (+25 HP)
            expect(state.battlers[1]!.mon.itemId).toBeNull()
            expect(state.battlers[1]!.usedHeldItem).toBe(ITEM_SITRUS_BERRY.id)
            expect(state.battlers[1]!.mon.hp).toBe(75)
          })

          it('fails when no alive battler holds a non-negated berry', () => {
            const state = battle(
              [
                { moves: ['MOVE_TEATIME', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: ITEM_BOOSTER_ENERGY.id },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, itemId: ITEM_LIECHI_BERRY.id },
              ],
              countingRng(),
            )
            // Battler 1's berry is negated by Embargo
            state.battlers[1]!.statuses3 = setFlag(state.battlers[1]!.statuses3, STATUS3_EMBARGO)

            const out = executeTurn(state, [useMove(1, MOVE_TEATIME), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(state.battlers[1]!.mon.itemId).toBe(ITEM_LIECHI_BERRY.id)
          })
        })

        describe('EFFECT_STUFF_CHEEKS', () => {
          it('consumes user berry with sBERRY_OVERRIDE and raises Defense by +2 stages', () => {
            const state = battle(
              [
                { moves: ['MOVE_STUFF_CHEEKS', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: ITEM_LIECHI_BERRY.id },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_STUFF_CHEEKS), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(state.battlers[0]!.mon.itemId).toBeNull()
            expect(state.battlers[0]!.usedHeldItem).toBe(ITEM_LIECHI_BERRY.id)
            // Liechi Berry raised Attack by +1, then Stuff Cheeks raised Defense by +2
            expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 2)
            expect(act.statChanges).toEqual([
              { battlerId: 0, stat: STAT_ATK, change: 1 },
              { battlerId: 0, stat: STAT_DEF, change: 2 },
            ])
          })

          it('fails when user does not hold a non-negated berry', () => {
            const state = battle(
              [
                { moves: ['MOVE_STUFF_CHEEKS', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: null },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_STUFF_CHEEKS), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
            expect(act.statChanges).toEqual([])
          })
        })

        describe('EFFECT_BESTOW', () => {
          it('transfers user held item to target and (when target already has status1) runs trypsychoshift without curing user', () => {
            const state = battle(
              [
                {
                  moves: ['MOVE_BESTOW', null, null, null],
                  pp: [15, 0, 0, 0],
                  spe: 100,
                  itemId: ITEM_SITRUS_BERRY.id,
                  status1: STATUS1_BLEED,
                },
                {
                  moves: ['MOVE_CELEBRATE', null, null, null],
                  pp: [10, 0, 0, 0],
                  spe: 50,
                  itemId: null,
                  status1: STATUS1_PARALYSIS,
                },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_BESTOW), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
            expect(state.battlers[0]!.mon.itemId).toBeNull()
            expect(state.battlers[1]!.mon.itemId).toBe(ITEM_SITRUS_BERRY.id)
            // C quirk (:1392-1402): jumpifstatus tests BS_TARGET, trypsychoshift overwrites target status1 with user's, and curestatus BS_ATTACKER is never called
            expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BLEED)
            expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BLEED)
          })

          it('fails when user holds no item and target has no status1, while still deducting PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_BESTOW', null, null, null], pp: [15, 0, 0, 0], spe: 100, itemId: null },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, itemId: null },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_BESTOW), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
            expect(state.battlers[1]!.mon.itemId).toBeNull()
          })
        })

        describe('EFFECT_CALTROPS', () => {
          it('sets caltrops on the opposing side timer without setting any gSideStatuses bit', () => {
            const state = battle(
              [
                { moves: ['MOVE_CALTROPS', null, null, null], pp: [20, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_CALTROPS), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
            expect(state.sides[1].timers.caltrops).toBe(true)
            expect(state.sides[0].timers.caltrops).toBe(false)
            expect(state.sides[1].statuses).toBe(0)
          })

          it('fails when caltrops is already set on the opposing side, while still deducting PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_CALTROPS', null, null, null], pp: [20, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )
            state.sides[1].timers.caltrops = true

            const out = executeTurn(state, [useMove(1, MOVE_CALTROPS), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(19)
            expect(state.sides[1].timers.caltrops).toBe(true)
          })
        })

        describe('EFFECT_GEOMANCY', () => {
          it('charges on turn 1 (deducting PP and setting STATUS2_MULTIPLETURNS) and raises SpAtk/SpDef/Speed by +2 on turn 2 (or immediately with Power Herb)', () => {
            const state = battle(
              [
                { moves: ['MOVE_GEOMANCY', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            // Turn 1: charging turn
            const out1 = executeTurn(state, [useMove(0, MOVE_GEOMANCY), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act1 = out1.actions.find((a) => a.battlerId === 0)!
            expect(act1.missed).toBe(false)
            expect(act1.statChanges).toEqual([])
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true)

            // Turn 2: execution turn (HITMARKER_NO_PPDEDUCT -> PP stays 9)
            const out2 = executeTurn(state, [useMove(0, MOVE_GEOMANCY), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act2 = out2.actions.find((a) => a.battlerId === 0)!
            expect(act2.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
            expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 2)
            expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 2)
            expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
            expect(act2.statChanges).toEqual([
              { battlerId: 0, stat: STAT_SPATK, change: 2 },
              { battlerId: 0, stat: STAT_SPDEF, change: 2 },
              { battlerId: 0, stat: STAT_SPEED, change: 2 },
            ])

            // Power Herb: completes in 1 turn and consumes Power Herb
            const herbState = battle(
              [
                { moves: ['MOVE_GEOMANCY', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: ITEM_POWER_HERB.id },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )
            const herbOut = executeTurn(herbState, [useMove(0, MOVE_GEOMANCY), useMove(0, MOVE_CELEBRATE)], testDeps())
            const herbAct = herbOut.actions.find((a) => a.battlerId === 0)!
            expect(herbAct.missed).toBe(false)
            expect(herbState.battlers[0]!.mon.pp[0]).toBe(9)
            expect(herbState.battlers[0]!.mon.itemId).toBeNull()
            expect(herbState.battlers[0]!.usedHeldItem).toBe(ITEM_POWER_HERB.id)
            expect(hasFlag(herbState.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
            expect(herbAct.statChanges).toEqual([
              { battlerId: 0, stat: STAT_SPATK, change: 2 },
              { battlerId: 0, stat: STAT_SPDEF, change: 2 },
              { battlerId: 0, stat: STAT_SPEED, change: 2 },
            ])
          })

          it('fails on the second turn when SpAtk, SpDef, and Speed are all already at max stage', () => {
            const state = battle(
              [
                { moves: ['MOVE_GEOMANCY', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )
            state.battlers[0]!.mon.status2 = setFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)
            state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
            state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
            state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE

            const out = executeTurn(state, [useMove(0, MOVE_GEOMANCY), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(act.statChanges).toEqual([])
            expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(10)
          })
        })

        describe('EFFECT_KINESIS', () => {
          it('destroys target held item and flinches the target', () => {
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_KINESIS', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, itemId: ITEM_SITRUS_BERRY.id },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_KINESIS), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act0 = out.actions.find((a) => a.battlerId === 0)!
            const act1 = out.actions.find((a) => a.battlerId === 1)!
            expect(act0.missed).toBe(false)
            expect(rng.calls).toBe(1)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(state.battlers[1]!.mon.itemId).toBeNull()
            expect(act1.cancelledBy).toBe('FLINCH')
          })

          it('fails when target holds no item (or has Sticky Hold) and does not flinch the target', () => {
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_KINESIS', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, itemId: null },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_KINESIS), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act0 = out.actions.find((a) => a.battlerId === 0)!
            const act1 = out.actions.find((a) => a.battlerId === 1)!
            expect(act0.missed).toBe(true)
            expect(rng.calls).toBe(1)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(act1.cancelledBy).toBeNull()
          })
        })

        describe('EFFECT_DRAIN_BRAIN', () => {
          it('lowers target SpAtk by 1 stage and heals the user by target pre-drop effective SpAtk', () => {
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_DRAIN_BRAIN', null, null, null], pp: [10, 0, 0, 0], spe: 100, hp: 50, maxHp: 200 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, spatk: 60 },
              ],
              rng,
            )
            state.battlers[1]!.mon.statStages[STAT_SPATK] = DEFAULT_STAT_STAGE + 2 // +2 stage -> 60 * 4 / 2 = 120

            const out = executeTurn(state, [useMove(1, MOVE_DRAIN_BRAIN), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(rng.calls).toBe(1)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
            expect(act.statChanges).toEqual([{ battlerId: 1, stat: STAT_SPATK, change: -1 }])
            expect(state.battlers[0]!.mon.hp).toBe(170)
          })

          it('fails to heal when target SpAtk is already at MIN_STAT_STAGE', () => {
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_DRAIN_BRAIN', null, null, null], pp: [10, 0, 0, 0], spe: 100, hp: 50, maxHp: 200 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, spatk: 100 },
              ],
              rng,
            )
            state.battlers[1]!.mon.statStages[STAT_SPATK] = MIN_STAT_STAGE

            const out = executeTurn(state, [useMove(1, MOVE_DRAIN_BRAIN), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(true)
            expect(act.statChanges).toEqual([])
            expect(state.battlers[0]!.mon.hp).toBe(50)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
          })
        })

        describe('EFFECT_WATERLOG', () => {
          it('waterlogs the target (quartering its speed for the round) and inflicts Drench with 20% base / 50% rain chance', () => {
            // Roll 1: accuracy (0 < 100 -> hit)
            // Roll 2: drench chance in rain (35 < 50 -> triggers, whereas 35 >= 20 would not without rain)
            // Roll 3: drench duration (1 -> 2 + (1 % 2) = 3 turns)
            const rng = scriptedRng([0, 35, 1])
            const state = battle(
              [
                { moves: ['MOVE_WATERLOG', null, null, null], pp: [15, 0, 0, 0], spe: 60 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
              ],
              rng,
            )
            state.field.weather = WEATHER_RAIN_TEMPORARY

            const out = executeTurn(state, [useMove(1, MOVE_WATERLOG), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(rng.calls).toBe(3)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
            // Target's speed (100) was quartered to 25 by round.waterlog, so battler 0 (spe 60) went first in endTurnOrder.
            expect(out.endTurnOrder).toEqual([0, 1])
            expect(state.battlers[1]!.volatiles.drenched).toBe(3)
            expect(state.battlers[1]!.volatiles.started.drenched).toBe(true)
          })

          it('does not drench a Water-type target even when the effect chance roll passes, and fails completely on accuracy miss', () => {
            // Water-type target: accuracy roll 0, drench chance roll 0 (< 20), but CanBeDrenched returns false (no duration roll).
            const waterRng = scriptedRng([0, 0])
            const waterState = battle(
              [
                { moves: ['MOVE_WATERLOG', null, null, null], pp: [15, 0, 0, 0], spe: 60 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] },
              ],
              waterRng,
            )
            const waterOut = executeTurn(waterState, [useMove(1, MOVE_WATERLOG), useMove(0, MOVE_CELEBRATE)], testDeps())
            expect(waterOut.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(waterRng.calls).toBe(2)
            expect(waterOut.endTurnOrder).toEqual([0, 1])
            expect(waterState.battlers[1]!.volatiles.drenched).toBe(0)

            // Accuracy miss: target at +1 Evasion (accuracy = floor(100 * 2 / 3) = 66), roll 90 >= 66 -> misses.
            const missRng = scriptedRng([90])
            const missState = battle(
              [
                { moves: ['MOVE_WATERLOG', null, null, null], pp: [15, 0, 0, 0], spe: 60 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
              ],
              missRng,
            )
            missState.battlers[1]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 1
            const missOut = executeTurn(missState, [useMove(1, MOVE_WATERLOG), useMove(0, MOVE_CELEBRATE)], testDeps())
            expect(missOut.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(missRng.calls).toBe(1)
            expect(missState.battlers[0]!.mon.pp[0]).toBe(14)
            expect(missOut.endTurnOrder).toEqual([1, 0])
            expect(missState.battlers[1]!.volatiles.drenched).toBe(0)
          })
        })

        describe('EFFECT_TRICK', () => {
          it('swaps held items between user and target (including one-sided swaps and Mold Breaker bypassing target Sticky Hold)', () => {
            // Two-item swap via MOVE_TRICK
            const rng = countingRng()
            const state = battle(
              [
                { moves: ['MOVE_TRICK', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: ITEM_SITRUS_BERRY.id },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, itemId: ITEM_LIECHI_BERRY.id },
              ],
              rng,
            )

            const out = executeTurn(state, [useMove(1, MOVE_TRICK), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(rng.calls).toBe(1)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(state.battlers[0]!.mon.itemId).toBe(ITEM_LIECHI_BERRY.id)
            expect(state.battlers[1]!.mon.itemId).toBe(ITEM_SITRUS_BERRY.id)

            // One-sided swap via MOVE_SWITCHEROO with Mold Breaker bypassing target's Sticky Hold
            const mbRng = countingRng()
            const mbState = battle(
              [
                {
                  moves: ['MOVE_SWITCHEROO', null, null, null],
                  pp: [10, 0, 0, 0],
                  spe: 100,
                  itemId: null,
                  abilities: { ability: ABILITY_MOLD_BREAKER, innates: [null, null, null] },
                },
                {
                  moves: ['MOVE_CELEBRATE', null, null, null],
                  pp: [10, 0, 0, 0],
                  spe: 50,
                  itemId: ITEM_POWER_HERB.id,
                  abilities: { ability: ABILITY_STICKY_HOLD, innates: [null, null, null] },
                },
              ],
              mbRng,
            )

            const mbOut = executeTurn(mbState, [useMove(1, MOVE_SWITCHEROO), useMove(0, MOVE_CELEBRATE)], testDeps())
            expect(mbOut.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(mbState.battlers[0]!.mon.itemId).toBe(ITEM_POWER_HERB.id)
            expect(mbState.battlers[1]!.mon.itemId).toBeNull()
          })

          it('fails when both hold identical or empty items, when Substitute blocks before accuracy, or when target has Sticky Hold', () => {
            // Identical non-null items fail (attacker.item == target.item)
            const sameItemState = battle(
              [
                { moves: ['MOVE_TRICK', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: ITEM_SITRUS_BERRY.id },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50, itemId: ITEM_SITRUS_BERRY.id },
              ],
              countingRng(),
            )
            const sameItemOut = executeTurn(sameItemState, [useMove(1, MOVE_TRICK), useMove(0, MOVE_CELEBRATE)], testDeps())
            expect(sameItemOut.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(sameItemState.battlers[0]!.mon.pp[0]).toBe(9)

            // Target Substitute blocks before accuracy check (0 RNG draws)
            const subRng = countingRng()
            const subState = battle(
              [
                { moves: ['MOVE_TRICK', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: ITEM_SITRUS_BERRY.id },
                {
                  moves: ['MOVE_CELEBRATE', null, null, null],
                  pp: [10, 0, 0, 0],
                  spe: 50,
                  itemId: ITEM_LIECHI_BERRY.id,
                  status2: STATUS2_SUBSTITUTE,
                },
              ],
              subRng,
            )
            subState.battlers[1]!.volatiles.substituteHp = 25
            const subOut = executeTurn(subState, [useMove(1, MOVE_TRICK), useMove(0, MOVE_CELEBRATE)], testDeps())
            expect(subOut.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
            expect(subRng.calls).toBe(0)
            expect(subState.battlers[0]!.mon.pp[0]).toBe(9)
            expect(subState.battlers[0]!.mon.itemId).toBe(ITEM_SITRUS_BERRY.id)
            expect(subState.battlers[1]!.mon.itemId).toBe(ITEM_LIECHI_BERRY.id)

            // C quirk (:11737): target's Sticky Hold blocks Trick even when target holds no item
            const shState = battle(
              [
                { moves: ['MOVE_TRICK', null, null, null], pp: [10, 0, 0, 0], spe: 100, itemId: ITEM_SITRUS_BERRY.id },
                {
                  moves: ['MOVE_CELEBRATE', null, null, null],
                  pp: [10, 0, 0, 0],
                  spe: 50,
                  itemId: null,
                  abilities: { ability: ABILITY_STICKY_HOLD, innates: [null, null, null] },
                },
              ],
              countingRng(),
            )
            const shOut = executeTurn(shState, [useMove(1, MOVE_TRICK), useMove(0, MOVE_CELEBRATE)], testDeps())
            expect(shOut.actions.find((a) => a.battlerId === 0)!.missed).toBe(false)
            expect(shState.battlers[0]!.mon.itemId).toBe(ITEM_SITRUS_BERRY.id)
            expect(shState.battlers[1]!.mon.itemId).toBeNull()
          })
        })

        describe('EFFECT_SNATCH', () => {
          it('sets user round.stealMove when user does not act last in the turn', () => {
            const state = battle(
              [
                { moves: ['MOVE_SNATCH', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            let stealMoveDuringTurn = false
            const spyDmg: DamageResolver = {
              resolve: (s) => {
                stealMoveDuringTurn = s.battlers[0]!.round.stealMove
                return { targetDamage: 10, attackerDamage: null, unmodelled: [] }
              },
            }

            const out = executeTurn(state, [useMove(0, MOVE_SNATCH), useMove(0, MOVE_TACKLE)], testDeps(spyDmg))
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(stealMoveDuringTurn).toBe(true)
            expect(act.unmodelled.some((u) => u.includes('stealMove'))).toBe(true)
            // Cleared at end of turn by roundStructsClear
            expect(state.battlers[0]!.round.stealMove).toBe(false)
          })

          it('fails when user acts last in the turn (gCurrentTurnActionNumber == gBattlersCount - 1), while still deducting PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_SNATCH', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(0, MOVE_SNATCH), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.turnOrderIndex).toBe(1)
            expect(act.missed).toBe(true)
            expect(state.battlers[0]!.mon.pp[0]).toBe(9)
            expect(act.unmodelled).toEqual([])
          })
        })

        describe('EFFECT_MAGIC_COAT', () => {
          it('sets user round.bounceMove and targets the user when user does not act last in the turn', () => {
            const state = battle(
              [
                { moves: ['MOVE_MAGIC_COAT', null, null, null], pp: [15, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            let bounceMoveDuringTurn = false
            const spyDmg: DamageResolver = {
              resolve: (s) => {
                bounceMoveDuringTurn = s.battlers[0]!.round.bounceMove
                return { targetDamage: 10, attackerDamage: null, unmodelled: [] }
              },
            }

            const out = executeTurn(state, [useMove(1, MOVE_MAGIC_COAT), useMove(0, MOVE_TACKLE)], testDeps(spyDmg))
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.missed).toBe(false)
            expect(act.targetId).toBe(0)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
            expect(bounceMoveDuringTurn).toBe(true)
            expect(act.unmodelled.some((u) => u.includes('bounceMove'))).toBe(true)
            expect(state.battlers[0]!.round.bounceMove).toBe(false)
          })

          it('fails when user acts last in the turn (gCurrentTurnActionNumber == gBattlersCount - 1), while still deducting PP', () => {
            const state = battle(
              [
                { moves: ['MOVE_MAGIC_COAT', null, null, null], pp: [15, 0, 0, 0], spe: 50 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 100 },
              ],
              countingRng(),
            )

            const out = executeTurn(state, [useMove(1, MOVE_MAGIC_COAT), useMove(0, MOVE_CELEBRATE)], testDeps())
            const act = out.actions.find((a) => a.battlerId === 0)!
            expect(act.turnOrderIndex).toBe(1)
            expect(act.missed).toBe(true)
            expect(act.targetId).toBe(0)
            expect(state.battlers[0]!.mon.pp[0]).toBe(14)
            expect(act.unmodelled).toEqual([])
          })
        })

        describe('EFFECT_ALLY_SWITCH', () => {
          it('resolves target to BATTLE_PARTNER(user) in doubles (or user in singles), deducts PP without failing, and gaps VARIOUS_SWAP_WITH', () => {
            // Doubles with alive partner (battler 2)
            const doublesState = battle(
              [
                { moves: ['MOVE_ALLY_SWITCH', null, null, null], pp: [15, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 90 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 80 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 70 },
              ],
              countingRng(),
            )

            const doublesOut = executeTurn(
              doublesState,
              [useMove(2, MOVE_ALLY_SWITCH), useMove(1, MOVE_CELEBRATE), useMove(2, MOVE_CELEBRATE), useMove(3, MOVE_CELEBRATE)],
              testDeps(),
            )
            const doublesAct = doublesOut.actions.find((a) => a.battlerId === 0)!
            expect(doublesAct.missed).toBe(false)
            expect(doublesAct.targetId).toBe(2)
            expect(doublesState.battlers[0]!.mon.pp[0]).toBe(14)
            expect(doublesAct.unmodelled.some((u) => u.includes('VARIOUS_SWAP_WITH'))).toBe(true)

            // Singles: BattleScript_EffectAllySwitch (:12538-12548) has no failure branch in C; resolves targetId to user
            const singlesState = battle(
              [
                { moves: ['MOVE_ALLY_SWITCH', null, null, null], pp: [15, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )

            const singlesOut = executeTurn(
              singlesState,
              [useMove(0, MOVE_ALLY_SWITCH), useMove(0, MOVE_CELEBRATE)],
              testDeps(),
            )
            const singlesAct = singlesOut.actions.find((a) => a.battlerId === 0)!
            expect(singlesAct.missed).toBe(false)
            expect(singlesAct.targetId).toBe(0)
            expect(singlesState.battlers[0]!.mon.pp[0]).toBe(14)
            expect(singlesAct.unmodelled.some((u) => u.includes('VARIOUS_SWAP_WITH'))).toBe(true)
          })
        })

        describe('EFFECT_FOLLOW_ME', () => {
          it('sets followmeTimer, followmeTarget, and followmePowder on the user side for Follow Me, Rage Powder, and Spotlight', () => {
            // Follow Me: followmePowder = false, no accuracy roll drawn
            const fmRng = countingRng()
            const fmState = battle(
              [
                { moves: ['MOVE_FOLLOW_ME', null, null, null], pp: [20, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              fmRng,
            )
            const fmOut = executeTurn(fmState, [useMove(0, MOVE_FOLLOW_ME), useMove(0, MOVE_CELEBRATE)], testDeps())
            const fmAct = fmOut.actions.find((a) => a.battlerId === 0)!
            expect(fmAct.missed).toBe(false)
            expect(fmAct.targetId).toBe(0)
            expect(fmRng.calls).toBe(0)
            expect(fmState.battlers[0]!.mon.pp[0]).toBe(19)
            expect(fmState.sides[0].timers.followmeTimer).toBe(1)
            expect(fmState.sides[0].timers.followmeTarget).toBe(0)
            expect(fmState.sides[0].timers.followmePowder).toBe(false)
            expect(fmAct.unmodelled.some((u) => u.includes('IsAffectedByFollowMe'))).toBe(true)

            // Rage Powder (on battler 1, side 1): followmePowder = true
            const rpState = battle(
              [
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
                { moves: ['MOVE_RAGE_POWDER', null, null, null], pp: [20, 0, 0, 0], spe: 100 },
              ],
              countingRng(),
            )
            const rpOut = executeTurn(rpState, [useMove(0, MOVE_CELEBRATE), useMove(1, MOVE_RAGE_POWDER)], testDeps())
            const rpAct = rpOut.actions.find((a) => a.battlerId === 1)!
            expect(rpAct.missed).toBe(false)
            expect(rpAct.targetId).toBe(1)
            expect(rpState.battlers[1]!.mon.pp[0]).toBe(19)
            expect(rpState.sides[1].timers.followmeTimer).toBe(1)
            expect(rpState.sides[1].timers.followmeTarget).toBe(1)
            expect(rpState.sides[1].timers.followmePowder).toBe(true)

            // Spotlight: C quirk (:11614-11616) writes followmeTarget = gBattlerAttacker on user's side even though target is SELECTED
            const spState = battle(
              [
                { moves: ['MOVE_SPOTLIGHT', null, null, null], pp: [15, 0, 0, 0], spe: 100 },
                { moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0], spe: 50 },
              ],
              countingRng(),
            )
            const spOut = executeTurn(spState, [useMove(1, MOVE_SPOTLIGHT), useMove(0, MOVE_CELEBRATE)], testDeps())
            const spAct = spOut.actions.find((a) => a.battlerId === 0)!
            expect(spAct.missed).toBe(false)
            expect(spAct.targetId).toBe(1)
            expect(spState.battlers[0]!.mon.pp[0]).toBe(14)
            expect(spState.sides[0].timers.followmeTimer).toBe(1)
            expect(spState.sides[0].timers.followmeTarget).toBe(0)
            expect(spState.sides[0].timers.followmePowder).toBe(false)
            expect(spState.sides[1].timers.followmeTimer).toBe(0)
          })
        })
      })
    })
  })
})
