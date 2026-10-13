// Switch-in ability dispatcher and battle-start pass.
//
// Ported from upstream C sources at pinned SHA:
//
// 1. Switch-in ability dispatch (HandleSwitchInAbility, battle_util.c:9103-9204):
//    Invoked during switch-in (Cmd_switchineffects, battle_script_commands.c:5520-5525)
//    and battle start (TryDoEventsBeforeFirstTurn, battle_main.c:3354-3382).
//    - Slot iteration order: walks GetNumPossibleAbilitiesForBattler slots in reverse:
//      abilityNumber = numPossibleAbilities - i (battle_util.c:9108).
//      i = 0 is extra switch-in effects (Commander / Dragon Monotype / Totem, :9113-9176).
//      i = 1 is slot 3 (innates[2], :9108, :9183).
//      i = 2 is slot 2 (innates[1]).
//      i = 3 is slot 1 (innates[0]).
//      i = 4 is slot 0 (ability).
//    - gAbilities[ability].onEntry check (:9184): only abilities with an onEntry hook fire.
//    - IsSuppressed(battler, ability, FALSE) (:9187): suppressed abilities (Neutralizing Gas,
//      Gastro Acid) do not activate.
//    - CheckAndSetSwitchInAbility (:9193, :3929-3942): tracks single activation per slot via
//      gVolatileStructs[battlerId].switchInAbilityDone[GetAbilityIndex(battlerId, ability, FALSE)].
//
// 2. Weather setters (TryChangeBattleWeather, battle_util.c:3721-3743):
//    - Drizzle (abilities.cc:501-514), Drought (:1332-1345), Sand Stream (:1076-1089),
//      Snow Warning (:1798-1811) and their onEntry aliases:
//      - Seaborne (abilities.cc:6467 -> Drizzle)
//      - Storm Cloud (abilities.cc:11903 -> Drizzle)
//      - Orichalcum Pulse (abilities.cc:7437 -> Drought)
//      - Desert Spirit (abilities.cc:7666 -> Sand Stream)
//      - Sand Bender (abilities.cc:9178 -> Sand Stream)
//      - Snowy Wrath (abilities.cc:8295 -> Snow Warning)
//      - Sundae (abilities.cc:11283 -> Snow Warning)
//    - TryChangeBattleWeather rules:
//      - Blocked if WEATHER_PRIMAL_ANY is active (:3725-3727).
//      - Blocked if !WEATHER_HAS_EFFECT (:3728-3730, include/battle_util.h:45-46, fieldEndTurn.ts).
//      - Blocked if matching weather is already active (:3731) -- does not reset duration.
//      - Duration: WEATHER_DURATION (8), extended to WEATHER_DURATION_EXTENDED (12)
//        if battler holds the matching rock (Damp Rock, Heat Rock, Smooth Rock, Icy Rock)
//        per GetBattlerHoldEffect(battler, TRUE) == sWeatherFlagsInfo[weatherEnumId][2] (:3734-3737).
//
// 3. Battle-start pass for leads (TryDoEventsBeforeFirstTurn, battle_main.c:3354-3382):
//    - Runs before turn actions begin (when gBattleResults.battleTurnCounter == 0).
//    - Orders leads by speed (gBattlerByTurnOrder via RecalculateMoveOrder(counter, TRUE), :3356).
//    - Evaluates each live lead mon from fastest to slowest; later weather setters override
//      earlier ones.

import {
  DEFAULT_STAT_STAGE,
  DEFAULT_STAT_STAGE_RATIOS,
  ENUM_WEATHER_FOG,
  ENUM_WEATHER_HAIL,
  ENUM_WEATHER_RAIN,
  ENUM_WEATHER_RAIN_PRIMAL,
  ENUM_WEATHER_SANDSTORM,
  ENUM_WEATHER_STRONG_WINDS,
  ENUM_WEATHER_SUN,
  ENUM_WEATHER_SUN_PRIMAL,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_STEALTH_ROCK,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
  STATUS2_DEFENSE_CURL,
  STATUS2_ENRAGED,
  STATUS2_SUBSTITUTE,
  STATUS4_COILED,
  STATUS4_CUTTHROAT,
  WEATHER_DURATION,
  WEATHER_DURATION_EXTENDED,
  WEATHER_FOG_ANY,
  WEATHER_FOG_PERMANENT,
  WEATHER_FOG_TEMPORARY,
  WEATHER_HAIL_PERMANENT,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_PRIMAL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_RAIN_PERMANENT,
  WEATHER_RAIN_PRIMAL,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_PERMANENT,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_STRONG_WINDS,
  WEATHER_SUN_ANY,
  WEATHER_SUN_PERMANENT,
  WEATHER_SUN_PRIMAL,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import type { BattleState, BattlerState } from './state'
import type { SimDataContext } from './dataContext'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import { weatherHasEffect } from './fieldEndTurn'
import {
  B_MSG_STAT_WONT_DECREASE,
  battlerHasSimAbility,
  changeStatBuffs,
  getHighestAttackingStatId,
  getHighestDefendingStatId,
  getHighestStatId,
  isBattlerWeatherAffected,
  isSimAbilitySuppressed,
  MOVE_EFFECT_AFFECTS_USER,
  MOVE_EFFECT_CERTAIN,
  RESET_STAT_BUFFS,
  RESET_STAT_DROPS,
  STAT_BUFF_NOT_PROTECT_AFFECTED,
  STAT_BUFF_UPDATE_MOVE_EFFECT,
  tryResetBattlerStatChanges,
} from './statBuffs'
import type { ChosenAction, TurnOrder, TurnOrderContext } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT, recalculateMoveOrder } from './turnOrder'
import type { HazardDeps } from './hazards'
import { TYPE_ROCK_ID } from './hazards'

/** abilityHooks.json (data/v2.65beta, pinned SHA) -- every ability id whose
 * `hooks.onEntry` is present. */
export const SWITCH_IN_ABILITY_IDS: ReadonlySet<string> = new Set([
  'ABILITY_AIR_BLOWER', 'ABILITY_AIR_LOCK', 'ABILITY_ANTICIPATION', 'ABILITY_APE_SHIFT', 'ABILITY_AQUATIC',
  'ABILITY_AS_ONE_ICE_RIDER', 'ABILITY_AS_ONE_SHADOW_RIDER', 'ABILITY_ATLAS', 'ABILITY_AURA_BREAK', 'ABILITY_AURORAS_GALE',
  'ABILITY_BARK_SKIN', 'ABILITY_BERSERK_DNA', 'ABILITY_BLIND_RAGE', 'ABILITY_BLISTERING_SUN', 'ABILITY_BLOOD_STAIN',
  'ABILITY_BRUISER', 'ABILITY_BUTTER_UP', 'ABILITY_CHAMPIONS_ENTRANCE', 'ABILITY_CHANGE_OF_HEART', 'ABILITY_CHEAP_TACTICS',
  'ABILITY_CHEATING_DEATH', 'ABILITY_CHILLING_PRESENCE', 'ABILITY_CHRISTMAS_NIGHTMARE', 'ABILITY_CLOUD_NINE', 'ABILITY_CLUELESS',
  'ABILITY_COIL_UP', 'ABILITY_COMATOSE', 'ABILITY_COSTAR', 'ABILITY_COWARD', 'ABILITY_CROWNED_KING',
  'ABILITY_CROWNED_SHIELD', 'ABILITY_CROWNED_SWORD', 'ABILITY_CURIOUS_MEDICINE', 'ABILITY_CURLIPEDE', 'ABILITY_CURSE_OF_FAMINE',
  'ABILITY_CUTTHROAT', 'ABILITY_DARK_AURA', 'ABILITY_DAUNTLESS_SHIELD', 'ABILITY_DEEP_FRIED', 'ABILITY_DELTA_STREAM',
  'ABILITY_DEMOLITIONIST', 'ABILITY_DESERT_SPIRIT', 'ABILITY_DESOLATE_LAND', 'ABILITY_DISGUISE', 'ABILITY_DOOMBRINGER',
  'ABILITY_DOWNLOAD', 'ABILITY_DRACONIC_MIGHT', 'ABILITY_DRACO_MORALE', 'ABILITY_DRAGONFLY', 'ABILITY_DRAGONFRUIT',
  'ABILITY_DRAKELP_HEAD', 'ABILITY_DREAMSCAPE', 'ABILITY_DREAM_WHIMSY', 'ABILITY_DRIZZLE', 'ABILITY_DROUGHT',
  'ABILITY_DUST_CLOUD', 'ABILITY_EDGELORD', 'ABILITY_ELECTRIC_SURGE', 'ABILITY_ELECTRO_BOOSTER', 'ABILITY_EMBODY_ASPECT',
  'ABILITY_EMBODY_ASPECT_CORNERSTONE', 'ABILITY_EMBODY_ASPECT_HEARTHFLAME', 'ABILITY_EMBODY_ASPECT_WELLSPRING', 'ABILITY_ENERGIZED', 'ABILITY_FAIRY_AURA',
  'ABILITY_FAIRY_TALE', 'ABILITY_FEARMONGER', 'ABILITY_FEY_FLIGHT', 'ABILITY_FIRES_WRATH', 'ABILITY_FLAME_COAT',
  'ABILITY_FLARE_BOOST', 'ABILITY_FLOWER_GIFT', 'ABILITY_FOAMY_WEB', 'ABILITY_FOOD_LOVERS', 'ABILITY_FORECAST',
  'ABILITY_FOREWARN', 'ABILITY_FRISK', 'ABILITY_FROSTY_PRESCENCE', 'ABILITY_FUNERAL_PYRE', 'ABILITY_FURNACE',
  'ABILITY_GALLANTRY', 'ABILITY_GENERATOR', 'ABILITY_GLEAM_EYES', 'ABILITY_GRASSY_SURGE', 'ABILITY_GRAVITY_WELL',
  'ABILITY_GREATER_SPIRIT', 'ABILITY_GROUNDED', 'ABILITY_HADRON_ENGINE', 'ABILITY_HALF_DRAKE', 'ABILITY_HEADSTRONG',
  'ABILITY_HOSPITALITY', 'ABILITY_HOT_COALS', 'ABILITY_HOVER', 'ABILITY_ICE_AGE', 'ABILITY_ICE_FACE',
  'ABILITY_IMPOSTER', 'ABILITY_INTIMIDATE', 'ABILITY_INTREPID_SWORD', 'ABILITY_INVERSE_ROOM', 'ABILITY_I_AM_STEVE',
  'ABILITY_JUMP_SCARE', 'ABILITY_KING_OF_THE_JUNGLE', 'ABILITY_KOMODO', 'ABILITY_LAWNMOWER', 'ABILITY_LETHARGY',
  'ABILITY_LETS_DANCE', 'ABILITY_LETS_ROLL', 'ABILITY_LIGHTNING_BORN', 'ABILITY_LIGHT_SABER', 'ABILITY_LOCUST_SWARM',
  'ABILITY_LOW_BLOW', 'ABILITY_LOW_VISIBILITY', 'ABILITY_MADNESS_ENHANCEMENT', 'ABILITY_MAJESTIC_MOTH', 'ABILITY_MALICIOUS',
  'ABILITY_MASHED_POTATO', 'ABILITY_METALLIC', 'ABILITY_METALLIC_JAWS', 'ABILITY_MIMICRY', 'ABILITY_MISTY_SURGE',
  'ABILITY_MOB_BOSS', 'ABILITY_MOLD_BREAKER', 'ABILITY_MOLTEN_CORE', 'ABILITY_MONKEY_BUSINESS', 'ABILITY_MONSTER_MASH',
  'ABILITY_NEUTRALIZING_FOG', 'ABILITY_NIHIL_BLASTER', 'ABILITY_NORTH_WIND', 'ABILITY_OMINOUS_SHROUD', 'ABILITY_ON_THE_PROWL',
  'ABILITY_ORICHALCUM_PULSE', 'ABILITY_OVERCAST', 'ABILITY_OVERWATCH', 'ABILITY_PARASITIC_SPORES', 'ABILITY_PASTEL_VEIL',
  'ABILITY_PATCHWORK', 'ABILITY_PERMANENCE', 'ABILITY_PETAL_SHIELD', 'ABILITY_PETRIFY', 'ABILITY_PHANTOM',
  'ABILITY_PHANTOM_THIEF', 'ABILITY_PICKUP', 'ABILITY_PIXIE_POWER', 'ABILITY_POSEIDONS_DOMINION', 'ABILITY_POWDER_BURST',
  'ABILITY_POWER_OF_ALCHEMY', 'ABILITY_POWER_OUTAGE', 'ABILITY_PRESSURE', 'ABILITY_PRIMORDIAL_SEA', 'ABILITY_PROTOSYNTHESIS',
  'ABILITY_PSYCHIC_SURGE', 'ABILITY_PURIFYING_WATERS', 'ABILITY_QUARK_DRIVE', 'ABILITY_RAINBOW_SCALES', 'ABILITY_RAPID_RESPONSE',
  'ABILITY_READIED_ACTION', 'ABILITY_REJECTION', 'ABILITY_REVELATION', 'ABILITY_ROCKY_EXTERIOR', 'ABILITY_ROCK_ARMOR',
  'ABILITY_ROSE_GARDEN', 'ABILITY_ROYAL_DECREE', 'ABILITY_SALT_CIRCLE', 'ABILITY_SAND_BENDER', 'ABILITY_SAND_PIT',
  'ABILITY_SAND_STREAM', 'ABILITY_SCARE', 'ABILITY_SCARECROW', 'ABILITY_SCHOOLING', 'ABILITY_SCREEN_CLEANER',
  'ABILITY_SEABORNE', 'ABILITY_SEA_GUARDIAN', 'ABILITY_SHIELDS_DOWN', 'ABILITY_SHOWDOWN_MODE', 'ABILITY_SIDEWINDER',
  'ABILITY_SLOW_START', 'ABILITY_SNOWY_WRATH', 'ABILITY_SNOW_WARNING', 'ABILITY_SOOTHING_AROMA', 'ABILITY_SOOTHSAYER',
  'ABILITY_SPIDER_LAIR', 'ABILITY_SPIDER_LAIR_UPGRADE', 'ABILITY_SPYWARE', 'ABILITY_STORM_CLOUD', 'ABILITY_SUNDAE',
  'ABILITY_SUN_WORSHIP', 'ABILITY_SUPERCELL', 'ABILITY_SUPPRESS', 'ABILITY_SUPREME_OVERLORD', 'ABILITY_SWAMP_THING',
  'ABILITY_TALON_TRAP', 'ABILITY_TAR_TOSS', 'ABILITY_TASTE_THE_RAINBOW', 'ABILITY_TELEKINETIC', 'ABILITY_TERAFORM_ZERO',
  'ABILITY_TERAVOLT', 'ABILITY_TERRIFY', 'ABILITY_TOXIC_BOOST', 'ABILITY_TOXIC_SPILL', 'ABILITY_TOXIC_SURGE',
  'ABILITY_TRACE', 'ABILITY_TRASH_HEAP', 'ABILITY_TRICKSTER', 'ABILITY_TURBOBLAZE', 'ABILITY_TURF_WAR',
  'ABILITY_TWISTED_DIMENSION', 'ABILITY_UNNERVE', 'ABILITY_VIOLENT_RUSH', 'ABILITY_VOLTRON', 'ABILITY_WATCH_YOUR_STEP',
  'ABILITY_WATERBORNE', 'ABILITY_WATER_VEIL', 'ABILITY_WEB_SPINNER', 'ABILITY_WHITE_SMOKE', 'ABILITY_WILDFIRE',
  'ABILITY_WIND_RAGE', 'ABILITY_WIND_RIDER', 'ABILITY_WINTER_THRONE', 'ABILITY_WISHMAKER', 'ABILITY_WITCH_BROOM',
  'ABILITY_WOODLAND_CURSE', 'ABILITY_YUKI_ONNA', 'ABILITY_ZEN_GARDEN', 'ABILITY_ZEN_MODE', 'ABILITY_ZERO_TO_HERO',
])

/**
 * Ported weather setters and their onEntry aliases:
 * - ABILITY_DRIZZLE (abilities.cc:501-514)
 * - ABILITY_SEABORNE (abilities.cc:6467, alias Impl<ABILITY_DRIZZLE>.onEntry)
 * - ABILITY_STORM_CLOUD (abilities.cc:11903, alias Impl<ABILITY_DRIZZLE>.onEntry)
 * - ABILITY_DROUGHT (abilities.cc:1332-1345)
 * - ABILITY_ORICHALCUM_PULSE (abilities.cc:7437, alias Impl<ABILITY_DROUGHT>.onEntry)
 * - ABILITY_SAND_STREAM (abilities.cc:1076-1089)
 * - ABILITY_DESERT_SPIRIT (abilities.cc:7666, alias Impl<ABILITY_SAND_STREAM>.onEntry)
 * - ABILITY_SAND_BENDER (abilities.cc:9178, alias Impl<ABILITY_SAND_STREAM>.onEntry)
 * - ABILITY_SNOW_WARNING (abilities.cc:1798-1811)
 * - ABILITY_SNOWY_WRATH (abilities.cc:8295, alias Impl<ABILITY_SNOW_WARNING>.onEntry)
 * - ABILITY_SUNDAE (abilities.cc:11283, alias Impl<ABILITY_SNOW_WARNING>.onEntry)
 */
export const WEATHER_SETTER_MAP: Readonly<Record<string, number>> = {
  ABILITY_DRIZZLE: ENUM_WEATHER_RAIN,
  ABILITY_SEABORNE: ENUM_WEATHER_RAIN,
  ABILITY_STORM_CLOUD: ENUM_WEATHER_RAIN,
  ABILITY_DROUGHT: ENUM_WEATHER_SUN,
  ABILITY_ORICHALCUM_PULSE: ENUM_WEATHER_SUN,
  ABILITY_SAND_STREAM: ENUM_WEATHER_SANDSTORM,
  ABILITY_DESERT_SPIRIT: ENUM_WEATHER_SANDSTORM,
  ABILITY_SAND_BENDER: ENUM_WEATHER_SANDSTORM,
  ABILITY_SNOW_WARNING: ENUM_WEATHER_HAIL,
  ABILITY_SNOWY_WRATH: ENUM_WEATHER_HAIL,
  ABILITY_SUNDAE: ENUM_WEATHER_HAIL,
}

interface WeatherFlagInfo {
  tempFlag: number
  permFlag: number
  extendingHoldEffect: string | null
}

/** sWeatherFlagsInfo, battle_util.c:3710-3719. */
const WEATHER_FLAGS_INFO: Record<number, WeatherFlagInfo> = {
  [ENUM_WEATHER_RAIN]: {
    tempFlag: WEATHER_RAIN_TEMPORARY,
    permFlag: WEATHER_RAIN_PERMANENT,
    extendingHoldEffect: 'HOLD_EFFECT_DAMP_ROCK',
  },
  [ENUM_WEATHER_RAIN_PRIMAL]: {
    tempFlag: WEATHER_RAIN_PRIMAL,
    permFlag: WEATHER_RAIN_PRIMAL,
    extendingHoldEffect: 'HOLD_EFFECT_DAMP_ROCK',
  },
  [ENUM_WEATHER_SUN]: {
    tempFlag: WEATHER_SUN_TEMPORARY,
    permFlag: WEATHER_SUN_PERMANENT,
    extendingHoldEffect: 'HOLD_EFFECT_HEAT_ROCK',
  },
  [ENUM_WEATHER_SUN_PRIMAL]: {
    tempFlag: WEATHER_SUN_PRIMAL,
    permFlag: WEATHER_SUN_PRIMAL,
    extendingHoldEffect: 'HOLD_EFFECT_HEAT_ROCK',
  },
  [ENUM_WEATHER_SANDSTORM]: {
    tempFlag: WEATHER_SANDSTORM_TEMPORARY,
    permFlag: WEATHER_SANDSTORM_PERMANENT,
    extendingHoldEffect: 'HOLD_EFFECT_SMOOTH_ROCK',
  },
  [ENUM_WEATHER_HAIL]: {
    tempFlag: WEATHER_HAIL_TEMPORARY,
    permFlag: WEATHER_HAIL_PERMANENT,
    extendingHoldEffect: 'HOLD_EFFECT_ICY_ROCK',
  },
  [ENUM_WEATHER_STRONG_WINDS]: {
    tempFlag: WEATHER_STRONG_WINDS,
    permFlag: WEATHER_STRONG_WINDS,
    extendingHoldEffect: null,
  },
  [ENUM_WEATHER_FOG]: {
    tempFlag: WEATHER_FOG_TEMPORARY,
    permFlag: WEATHER_FOG_PERMANENT,
    extendingHoldEffect: 'HOLD_EFFECT_SMOKE_BALL',
  },
}

/**
 * TryChangeBattleWeather, battle_util.c:3721-3743.
 *
 * - FLAG_PERMANENT_UNCHANGEABLE_WEATHER (:3722) is an overworld flag the sim does not model.
 * - Fails if WEATHER_PRIMAL_ANY is active, unless the battler has Desolate Land / Primordial Sea /
 *   Delta Stream (BATTLER_HAS_ABILITY, :3725-3727). viaAbility is unused in the C body.
 * - Fails if !WEATHER_HAS_EFFECT (:3728-3730, include/battle_util.h:45-46, fieldEndTurn.ts:390-396).
 * - Fails if already active (gBattleWeather & (sWeatherFlagsInfo[weather][0] | sWeatherFlagsInfo[weather][1])) (:3731).
 * - Sets gBattleWeather = sWeatherFlagsInfo[weather][0] (:3732).
 * - Sets gFieldTimers.started.weather = TRUE (:3733).
 * - Sets gWishFutureKnock.weatherDuration to WEATHER_DURATION_EXTENDED (12) if GetBattlerHoldEffect matches,
 *   else WEATHER_DURATION (8) (:3734-3737, include/battle_util.h:50-51).
 */
export function tryChangeBattleWeather(
  state: BattleState,
  battlerId: number,
  weatherEnum: number,
  _viaAbility: boolean,
  deps: { grounding: GroundingContext; dataContext: SimDataContext },
): boolean {
  if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
    const battler = state.battlers[battlerId]
    const hasPrimalAbility =
      !!battler &&
      ['ABILITY_DESOLATE_LAND', 'ABILITY_PRIMORDIAL_SEA', 'ABILITY_DELTA_STREAM'].some((ab) =>
        battlerHasSimAbility(state, battler, ab, false, battlerId, false, deps.dataContext),
      )
    if (!hasPrimalAbility) return false
  }

  if (
    weatherEnum !== ENUM_WEATHER_SUN_PRIMAL &&
    weatherEnum !== ENUM_WEATHER_RAIN_PRIMAL &&
    weatherEnum !== ENUM_WEATHER_STRONG_WINDS &&
    !weatherHasEffect(state, deps.grounding)
  ) {
    return false
  }

  const info = WEATHER_FLAGS_INFO[weatherEnum]
  if (!info) return false

  if (hasFlag(state.field.weather, info.tempFlag | info.permFlag)) {
    return false
  }

  state.field.weather = info.tempFlag
  state.field.timers.started.weather = true

  const heldEffect = deps.grounding.holdEffectOf(battlerId)
  const isExtended = info.extendingHoldEffect !== null && heldEffect === info.extendingHoldEffect
  state.field.weatherDuration = isExtended ? WEATHER_DURATION_EXTENDED : WEATHER_DURATION

  return true
}

/**
 * GetAbilityIndex, battle_util.c:9299-9313.
 * Returns the first slot index (0..3) with the given ability that is not suppressed.
 */
function getAbilityIndex(
  state: BattleState,
  battler: BattlerState,
  abilityId: string,
  dataContext: SimDataContext,
): number {
  const slots = [
    battler.mon.abilities.ability,
    battler.mon.abilities.innates[0],
    battler.mon.abilities.innates[1],
    battler.mon.abilities.innates[2],
  ]
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] === abilityId) {
      if (!isSimAbilitySuppressed(state, battler, abilityId, false, battler.id, false, dataContext)) {
        return i
      } else {
        return slots.length
      }
    }
  }
  return slots.length
}

/**
 * CheckAndSetSwitchInAbility, battle_util.c:3929-3942.
 * Ensures each switch-in ability fires at most once per switch-in.
 */
function checkAndSetSwitchInAbility(
  state: BattleState,
  battler: BattlerState,
  abilityId: string,
  dataContext: SimDataContext,
): boolean {
  const index = getAbilityIndex(state, battler, abilityId, dataContext)
  if (index >= 4) return false
  if (!battler.volatiles.switchInAbilityDone[index]) {
    battler.volatiles.switchInAbilityDone[index] = true
    return true
  }
  return false
}

/**
 * The 12 abilities with tauntImmune = TRUE (abilities.cc).
 * IsBattlerImmuneToLowerStatsFromIntimidateClone (battle_script_commands.c:10275-10281).
 */
export const TAUNT_IMMUNE_ABILITIES: ReadonlySet<string> = new Set([
  'ABILITY_OBLIVIOUS',
  'ABILITY_OWN_TEMPO',
  'ABILITY_INNER_FOCUS',
  'ABILITY_VITAL_SPIRIT',
  'ABILITY_SCRAPPY',
  'ABILITY_OVERWHELM',
  'ABILITY_DISCIPLINE',
  'ABILITY_ENLIGHTENED',
  'ABILITY_UNLOCKED_POTENTIAL',
  'ABILITY_WAY_OF_PRECISION',
  'ABILITY_BLIND_RAGE',
  'ABILITY_BIRD_OF_PREY',
])

/**
 * IsBattlerImmuneToLowerStatsFromIntimidateClone, battle_script_commands.c:10275-10281.
 * Guard Dog is NOT immune (it converts the drop into a raise in VARIOUS_DO_INTIMIDATE).
 * Checks tauntImmune with checkMoldBreaker = FALSE.
 */
export function isBattlerImmuneToLowerStatsFromIntimidateClone(
  state: BattleState,
  target: BattlerState,
  dataContext: SimDataContext,
): boolean {
  if (battlerHasSimAbility(state, target, 'ABILITY_GUARD_DOG', false, target.id, false, dataContext)) {
    return false
  }
  for (const abilityId of TAUNT_IMMUNE_ABILITIES) {
    if (battlerHasSimAbility(state, target, abilityId, false, target.id, false, dataContext)) {
      return true
    }
  }
  return false
}

export interface IntimidateCloneInfo {
  stats: readonly ('DEFENDING' | 'ATTACKING' | number)[]
  amount: number
  resetsOppBuffs?: boolean
  setsViolentRush?: boolean
}

/**
 * Intimidate family data from GetIntimidateData / Intimidate<ABILITY_*> (abilities.cc).
 * Loop order in C runs `numStatsLowered - 1` down to 0, reflected in the `stats` array order.
 */
export const INTIMIDATE_CLONE_MAP: Readonly<Record<string, IntimidateCloneInfo>> = {
  ABILITY_INTIMIDATE: { stats: [STAT_ATK], amount: 1 },
  ABILITY_SCARE: { stats: [STAT_SPATK], amount: 1 },
  // C loops numStatsLowered - 1 down to 0: statsLowered = {STAT_ATK, STAT_SPATK, 0} -> SPATK then ATK
  ABILITY_FEARMONGER: { stats: [STAT_SPATK, STAT_ATK], amount: 1 },
  ABILITY_FIRES_WRATH: { stats: [STAT_SPATK, STAT_ATK], amount: 1 },
  ABILITY_YUKI_ONNA: { stats: [STAT_SPATK, STAT_ATK], amount: 1 },
  // Malicious: statsLowered = {STAT_HIGHEST_ATTACKING, STAT_HIGHEST_DEFENDING, 0} -> DEFENDING then ATTACKING
  ABILITY_MALICIOUS: { stats: ['DEFENDING', 'ATTACKING'], amount: 1 },
  ABILITY_TERRIFY: { stats: [STAT_SPATK], amount: 2 },
  ABILITY_PETRIFY: { stats: [STAT_SPEED], amount: 1, resetsOppBuffs: true },
  ABILITY_GLEAM_EYES: { stats: [STAT_SPATK], amount: 1 },
  ABILITY_CHAMPIONS_ENTRANCE: { stats: [STAT_ATK], amount: 1, setsViolentRush: true },
  ABILITY_SCARECROW: { stats: [STAT_SPATK], amount: 1 },
  ABILITY_MOB_BOSS: { stats: [STAT_SPATK], amount: 2 },
}

export interface SwitchInAbilityDeps extends HazardDeps {
  statStageRatios?: [number, number][]
}

/**
 * UseIntimidateClone (battle_util.c:4064-4072) and VARIOUS_DO_INTIMIDATE (battle_script_commands.c:8969-9016).
 */
function applyIntimidateClone(
  state: BattleState,
  battlerId: number,
  info: IntimidateCloneInfo,
  deps: SwitchInAbilityDeps,
  unmodelled: string[],
): void {
  const battler = state.battlers[battlerId]
  if (!battler) return
  const statStageRatios = deps.statStageRatios ?? DEFAULT_STAT_STAGE_RATIOS

  if (info.setsViolentRush) {
    battler.volatiles.violentRush = true
    battler.volatiles.started.violentRush = true
  }

  // Impl<ABILITY_PETRIFY>.onEntry (abilities.cc:8446-8452): the reset loop runs inside onEntry, before the
  // pushed BattleScript_IntimidateActivatedNew executes.
  if (info.resetsOppBuffs) {
    for (let i = (battlerId & 1) ^ 1; i < state.battlersCount; i += 2) {
      if ((state.battlers[i]?.mon.hp ?? 0) === 0) continue
      tryResetBattlerStatChanges(state, i, RESET_STAT_BUFFS)
    }
  }

  // BattleScript_IntimidateActivatedNew: dointimidate BS_TARGET, then BS_TARGET_PARTNER, with
  // gBattlerTarget = BATTLE_OPPOSITE(battler) (battle_util.c:4067).
  const firstTarget = battlerId ^ 1
  for (const targetId of [firstTarget, firstTarget ^ 2]) {
    const target = state.battlers[targetId]
    if (!target || target.mon.hp === 0) continue

    // VARIOUS_DO_INTIMIDATE reads the ability from gBattleScripting.abilityPopupOverwrite (:8970). An
    // immunity popup (:8979) or Guard Dog popup (:9011) on the first target overwrites it, so the
    // partner's GetIntimidateData returns NULL and REQUIRE skips it.
    if (isBattlerImmuneToLowerStatsFromIntimidateClone(state, target, deps.dataContext)) {
      break
    }

    // SetMoveEffect's DoesSubstituteBlockMove (:2388) uses the stale gBattlerAttacker / gCurrentMove;
    // the intimidator stands in for gBattlerAttacker here.
    const hasSub = hasFlag(target.mon.status2, STATUS2_SUBSTITUTE)
    const infiltrates = battlerHasSimAbility(
      state,
      battler,
      'ABILITY_INFILTRATOR',
      false,
      battlerId,
      false,
      deps.dataContext,
    )
    if (hasSub && !infiltrates) {
      continue
    }

    const hasGuardDog = battlerHasSimAbility(
      state,
      target,
      'ABILITY_GUARD_DOG',
      true,
      battlerId,
      false,
      deps.dataContext,
    )

    let blocked = false
    for (const statKey of info.stats) {
      let statId: number
      if (statKey === 'DEFENDING') {
        statId = getHighestDefendingStatId(state, targetId, statStageRatios)
      } else if (statKey === 'ATTACKING') {
        statId = getHighestAttackingStatId(state, targetId, statStageRatios)
      } else {
        statId = statKey
      }

      const stageBefore = target.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
      const delta = hasGuardDog ? info.amount : -info.amount
      const res = changeStatBuffs(
        state,
        targetId,
        battlerId,
        targetId,
        delta,
        statId,
        STAT_BUFF_UPDATE_MOVE_EFFECT,
        true,
        deps,
        unmodelled,
      )
      if (!hasGuardDog && res.multistringChooser === B_MSG_STAT_WONT_DECREASE && stageBefore !== MIN_STAT_STAGE) {
        blocked = true
      }
    }

    if (hasGuardDog) break
    if (blocked && targetId === firstTarget && state.battlers[firstTarget ^ 2]) {
      unmodelled.push(
        `battler ${battlerId}: a stat-drop block on battler ${targetId} may overwrite abilityPopupOverwrite (battle_script_commands.c:9797-9820) and skip the partner's dointimidate; the partner is still processed`,
      )
    }
  }
}

/** CanRaiseStat, battle_util.c:9364 -> CompareStat (:8545-8561), which flips the test under Contrary. */
function canRaiseStat(state: BattleState, battler: BattlerState, statId: number, dataContext: SimDataContext): boolean {
  const stage = battler.mon.statStages[statId] ?? DEFAULT_STAT_STAGE
  if (battlerHasSimAbility(state, battler, 'ABILITY_CONTRARY', true, battler.id, false, dataContext)) {
    return stage > MIN_STAT_STAGE
  }
  return stage < MAX_STAT_STAGE
}

/**
 * Impl<ABILITY_DOWNLOAD>.onEntry (abilities.cc:1517-1528).
 */
function applyDownload(
  state: BattleState,
  battlerId: number,
  deps: SwitchInAbilityDeps,
  unmodelled: string[],
): void {
  // gBattlerTarget = BATTLE_OPPOSITE(battler); the partner fallback tests IsBattlerAlive(battler), not the
  // target, so a fainted opposite battler is still the one read.
  const oppId = battlerId ^ 1
  if (!state.battlers[oppId]) return

  const statStageRatios = deps.statStageRatios ?? DEFAULT_STAT_STAGE_RATIOS
  const highestDefending = getHighestDefendingStatId(state, oppId, statStageRatios)
  const statToRaise = highestDefending === STAT_DEF ? STAT_SPATK : STAT_ATK

  changeStatBuffs(
    state,
    battlerId,
    battlerId,
    battlerId,
    1,
    statToRaise,
    MOVE_EFFECT_AFFECTS_USER,
    false,
    deps,
    unmodelled,
  )
}

/**
 * Dispatches switch-in abilities for a single battler.
 * Ported from HandleSwitchInAbility (battle_util.c:9103-9204) and
 * Cmd_switchineffects (battle_script_commands.c:5520-5525).
 *
 * Walks the battler's slots in the C's order:
 *   numPossibleAbilities = 4 (GetNumPossibleAbilitiesForBattler, pokemon.c:6423)
 *   i = 0 -> slot 4 (Extra switch-in effects: Commander / Dragon Monotype / Totem, battle_util.c:9113-9176)
 *   i = 1 -> slot 3 (innates[2], battle_util.c:9108, :9183)
 *   i = 2 -> slot 2 (innates[1])
 *   i = 3 -> slot 1 (innates[0])
 *   i = 4 -> slot 0 (ability)
 */
export function applySwitchInAbilities(
  state: BattleState,
  battlerId: number,
  deps: SwitchInAbilityDeps,
  unmodelled: string[],
): void {
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) return

  const statStageRatios = deps.statStageRatios ?? DEFAULT_STAT_STAGE_RATIOS

  const slotEntries: Array<{ slotIndex: number; abilityId: string | null }> = [
    { slotIndex: 3, abilityId: battler.mon.abilities.innates[2] },
    { slotIndex: 2, abilityId: battler.mon.abilities.innates[1] },
    { slotIndex: 1, abilityId: battler.mon.abilities.innates[0] },
    { slotIndex: 0, abilityId: battler.mon.abilities.ability },
  ]

  for (const { abilityId } of slotEntries) {
    if (!abilityId) continue
    if (!SWITCH_IN_ABILITY_IDS.has(abilityId)) continue
    if (isSimAbilitySuppressed(state, battler, abilityId, false, battler.id, false, deps.dataContext)) {
      continue
    }
    if (!checkAndSetSwitchInAbility(state, battler, abilityId, deps.dataContext)) {
      continue
    }

    // 1. Weather setters (Cycle 36)
    const weatherEnum = WEATHER_SETTER_MAP[abilityId]
    if (weatherEnum !== undefined) {
      tryChangeBattleWeather(state, battlerId, weatherEnum, true, deps)
      continue
    }

    // 2. Intimidate family via UseIntimidateClone
    const intimidateInfo = INTIMIDATE_CLONE_MAP[abilityId]
    if (intimidateInfo !== undefined) {
      applyIntimidateClone(state, battlerId, intimidateInfo, deps, unmodelled)
      if (abilityId === 'ABILITY_GLEAM_EYES') {
        unmodelled.push(`battler ${battlerId}: Gleam Eyes' onEntry also runs Impl<ABILITY_FRISK>.onEntry (abilities.cc:8832), which is not ported`)
      }
      continue
    }

    // 3. Download
    if (abilityId === 'ABILITY_DOWNLOAD') {
      applyDownload(state, battlerId, deps, unmodelled)
      continue
    }

    // 4. Plain stat raises
    if (
      abilityId === 'ABILITY_INTREPID_SWORD' ||
      abilityId === 'ABILITY_CROWNED_SWORD' ||
      abilityId === 'ABILITY_EMBODY_ASPECT_HEARTHFLAME'
    ) {
      if (canRaiseStat(state, battler, STAT_ATK, deps.dataContext)) {
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          1,
          STAT_ATK,
          MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    if (
      abilityId === 'ABILITY_DAUNTLESS_SHIELD' ||
      abilityId === 'ABILITY_CROWNED_SHIELD' ||
      abilityId === 'ABILITY_EMBODY_ASPECT_CORNERSTONE'
    ) {
      if (canRaiseStat(state, battler, STAT_DEF, deps.dataContext)) {
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          1,
          STAT_DEF,
          MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    if (abilityId === 'ABILITY_EMBODY_ASPECT') {
      if (canRaiseStat(state, battler, STAT_SPEED, deps.dataContext)) {
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          1,
          STAT_SPEED,
          MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    if (abilityId === 'ABILITY_EMBODY_ASPECT_WELLSPRING') {
      if (canRaiseStat(state, battler, STAT_SPDEF, deps.dataContext)) {
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          1,
          STAT_SPDEF,
          MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    if (abilityId === 'ABILITY_LETS_ROLL' || abilityId === 'ABILITY_CURLIPEDE') {
      if (canRaiseStat(state, battler, STAT_DEF, deps.dataContext)) {
        // The C assigns rather than ORs, clearing every other status2 bit.
        battler.mon.status2 = STATUS2_DEFENSE_CURL
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          1,
          STAT_DEF,
          MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_NOT_PROTECT_AFFECTED | MOVE_EFFECT_CERTAIN,
          false,
          deps,
          unmodelled,
        )
      }
      if (abilityId === 'ABILITY_CURLIPEDE') {
        if (!hasFlag(battler.statuses4, STATUS4_COILED)) {
          battler.statuses4 |= STATUS4_COILED
        }
      }
      continue
    }

    if (abilityId === 'ABILITY_MAJESTIC_MOTH') {
      const statId = getHighestStatId(state, battlerId, statStageRatios)
      changeStatBuffs(
        state,
        battlerId,
        battlerId,
        battlerId,
        1,
        statId,
        MOVE_EFFECT_AFFECTS_USER,
        false,
        deps,
        unmodelled,
      )
      continue
    }

    if (abilityId === 'ABILITY_SEA_GUARDIAN') {
      if (isBattlerWeatherAffected(state, battlerId, WEATHER_RAIN_ANY, deps)) {
        const statId = getHighestStatId(state, battlerId, statStageRatios)
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          1,
          statId,
          MOVE_EFFECT_AFFECTS_USER,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    if (abilityId === 'ABILITY_SUN_WORSHIP') {
      if (isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, deps)) {
        const statId = getHighestStatId(state, battlerId, statStageRatios)
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          1,
          statId,
          MOVE_EFFECT_AFFECTS_USER,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    if (abilityId === 'ABILITY_GREATER_SPIRIT') {
      if (isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps)) {
        const statId = getHighestStatId(state, battlerId, statStageRatios)
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          1,
          statId,
          MOVE_EFFECT_AFFECTS_USER,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    if (abilityId === 'ABILITY_FURNACE') {
      const side = battlerId & 1
      if (
        hasFlag(state.sides[side]?.statuses ?? 0, SIDE_STATUS_STEALTH_ROCK) &&
        state.sides[side]?.timers.stealthRockType === TYPE_ROCK_ID
      ) {
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          2,
          STAT_SPEED,
          MOVE_EFFECT_AFFECTS_USER,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    if (abilityId === 'ABILITY_BERSERK_DNA') {
      const atkStat = getHighestAttackingStatId(state, battlerId, statStageRatios)
      if (canRaiseStat(state, battler, atkStat, deps.dataContext)) {
        battler.mon.status2 |= STATUS2_ENRAGED
        changeStatBuffs(
          state,
          battlerId,
          battlerId,
          battlerId,
          2,
          atkStat,
          MOVE_EFFECT_AFFECTS_USER,
          false,
          deps,
          unmodelled,
        )
      }
      continue
    }

    // 5. Flag setters
    if (abilityId === 'ABILITY_VIOLENT_RUSH') {
      battler.volatiles.violentRush = true
      battler.volatiles.started.violentRush = true
      continue
    }

    if (abilityId === 'ABILITY_SHOWDOWN_MODE') {
      battler.volatiles.showdownMode = true
      battler.volatiles.started.showdownMode = true
      continue
    }

    if (abilityId === 'ABILITY_RAPID_RESPONSE') {
      battler.volatiles.rapidResponse = true
      battler.volatiles.started.rapidResponse = true
      continue
    }

    if (abilityId === 'ABILITY_ON_THE_PROWL' || abilityId === 'ABILITY_OVERWATCH') {
      battler.volatiles.onTheProwl = true
      battler.volatiles.started.onTheProwl = true
      continue
    }

    if (abilityId === 'ABILITY_COIL_UP' || abilityId === 'ABILITY_SIDEWINDER') {
      if (!hasFlag(battler.statuses4, STATUS4_COILED)) {
        battler.statuses4 |= STATUS4_COILED
      }
      continue
    }

    if (abilityId === 'ABILITY_CUTTHROAT' || abilityId === 'ABILITY_EDGELORD') {
      if (!hasFlag(battler.statuses4, STATUS4_CUTTHROAT)) {
        battler.statuses4 |= STATUS4_CUTTHROAT
      }
      continue
    }

    // 6. Pressure onEntry stat reset
    if (abilityId === 'ABILITY_PRESSURE') {
      for (let i = 0; i < state.battlersCount; i++) {
        const b = state.battlers[i]
        if (!b || b.mon.hp === 0) continue
        tryResetBattlerStatChanges(state, i, i === battlerId ? RESET_STAT_DROPS : RESET_STAT_BUFFS)
      }
      continue
    }

    unmodelled.push(
      `battler ${battlerId}: HandleSwitchInAbility (battle_util.c:9103-9204) is not applied -- ${abilityId}'s onEntry hook was not run`,
    )
  }
}

export interface BattleStartDeps {
  grounding: GroundingContext
  dataContext: SimDataContext
  turnOrder?: Omit<TurnOrderContext, 'isBattlerGrounded'>
  statStageRatios?: [number, number][]
}

/**
 * TryDoEventsBeforeFirstTurn switch-in abilities pass (battle_main.c:3354-3382).
 * Resolves switch-in abilities for all live leads in speed order (gBattlerByTurnOrder)
 * before the first turn actions begin.
 */
export function applyBattleStartPass(
  state: BattleState,
  deps: BattleStartDeps,
  unmodelled: string[],
): void {
  const statStageRatios = deps.statStageRatios ?? DEFAULT_STAT_STAGE_RATIOS
  const turnOrderCtx: TurnOrderContext = {
    isBattlerGrounded: (battlerId) => isBattlerGrounded(state, battlerId, deps.grounding),
    ...(deps.turnOrder ?? NEUTRAL_TURN_ORDER_CONTEXT),
  }

  const order: TurnOrder = {
    battlerByTurnOrder: Array.from({ length: state.battlersCount }, (_, i) => i),
    actionsByTurnOrder: new Array<ChosenAction['action']>(state.battlersCount).fill('USE_MOVE'),
  }

  for (let i = 0; i < state.battlersCount; i++) {
    recalculateMoveOrder(order, state, [], i, true, turnOrderCtx, statStageRatios)
    const battlerId = order.battlerByTurnOrder[i]
    if (battlerId === undefined) continue
    const battler = state.battlers[battlerId]
    if (!battler || battler.mon.hp === 0) continue

    applySwitchInAbilities(state, battlerId, deps as SwitchInAbilityDeps, unmodelled)
  }
}
