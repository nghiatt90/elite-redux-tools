// Port of status-eligibility predicates and SetMoveEffect primary status path.
//
// Sources:
// - Status-eligibility predicates: src/battle_util.c:5024-5143
// - SetMoveEffect primary status branch: src/battle_script_commands.c:2311-2588, 2657-2664
// - Helper predicates: src/battle_script_commands.c:6465-6479 (CanPoisonType, CanParalyzeType)
// - IsAbilityStatusProtected: src/battle_script_commands.c:6579-6591
// - IsBattlerTerrainAffected / IsTerrainActive: src/battle_util.c:4886-4929
// - IsMyceliumMightActive: src/battle_main.c:4249
// - DoesSubstituteBlockMove: src/battle_script_commands.c:12252-12260
// - Infiltrates: src/battle_script_commands.c:12246-12250
// - CancelMultiTurnMoves: src/battle_util.c:1164-1175
// - IsPreventableSecondaryEffect: src/battle_script_commands.c:2240-2292
// - Sleep duration rule: include/constants/battle_config.h:56 (B_SLEEP_TURNS == GEN_7)
// - Ability hook lists: data/v2.65beta/abilityHooks.json

import type { BattleState, BattlerState } from './state'
import {
  SIDE_STATUS_SAFEGUARD,
  STATUS1_ANY,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS2_BIDE,
  STATUS2_CONFUSION,
  STATUS2_ENRAGED,
  STATUS2_INFATUATION,
  STATUS2_LOCK_CONFUSE,
  STATUS2_MULTIPLETURNS,
  STATUS2_SUBSTITUTE,
  STATUS2_UPROAR,
  STATUS3_SEMI_INVULNERABLE,
  STATUS4_FEAR,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  MOVE_EFFECT_WRAP,
  WEATHER_SANDSTORM_ANY,
  clearFlag,
  hasFlag,
  setCounter,
  setFlag,
  statusInfatuatedWith,
} from './constants'
import {
  attackerHasMoldBreakerActive,
  battlerHasSimAbility,
  isBattlerWeatherAffected,
  isSimAbilitySuppressed,
} from './statBuffs'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import type { SimDataContext } from './dataContext'
import { resolveEffectiveMoveType } from '../abilities/dispatchCalc'
import { SOUNDPROOF_ABILITIES } from './ai/aiAbilityHelpers'
// ON_ABILITY's reverse slot order (battle_util.h:269-275). accuracy.ts has no
// dependency on statusEffects, so this import closes no runtime cycle.
import { getSlotsInReverse } from './accuracy'

// ---------------------------------------------------------------------------
// Constants and Bitflags
// ---------------------------------------------------------------------------

// StatusCheckEnum, include/abilities.hh:99-115
export const CHECK_NONE = 0
export const CHECK_SLEEP = 1
export const CHECK_POISON = 1 << 1
export const CHECK_BURN = 1 << 2
export const CHECK_PARALYSIS = 1 << 3
export const CHECK_FROSTBITE = 1 << 4
export const CHECK_BLEED = 1 << 5
export const CHECK_STATUS1 =
  CHECK_SLEEP | CHECK_POISON | CHECK_BURN | CHECK_PARALYSIS | CHECK_FROSTBITE | CHECK_BLEED
export const CHECK_CONFUSION = 1 << 6
export const CHECK_INFATUATE = 1 << 7
export const CHECK_RESTRICTING = 1 << 8
export const CHECK_HEAL_BLOCK = 1 << 9
export const CHECK_DRENCH = 1 << 10
export const CHECK_FLINCH = 1 << 11
export const CHECK_REDIRECTION = 1 << 12

export type StatusCheck = number

// MoveEffectEnum, pipeline/.upstream/er-config/MoveEffect.proto
export const MOVE_EFFECT_NONE = 0
export const MOVE_EFFECT_SLEEP = 1
export const MOVE_EFFECT_POISON = 2
export const MOVE_EFFECT_BURN = 3
export const MOVE_EFFECT_FREEZE = 4
export const MOVE_EFFECT_PARALYSIS = 5
export const MOVE_EFFECT_TOXIC = 6
export const MOVE_EFFECT_FROSTBITE = 7
export const MOVE_EFFECT_BLEED = 8
export const MOVE_EFFECT_CONFUSION = 9
export const MOVE_EFFECT_FLINCH = 10
export const MOVE_EFFECT_TRI_ATTACK = 11
export const MOVE_EFFECT_ATK_PLUS_1 = 17
export const MOVE_EFFECT_DEF_PLUS_1 = 18
export const MOVE_EFFECT_SPD_PLUS_1 = 19
export const MOVE_EFFECT_SP_ATK_PLUS_1 = 20
export const MOVE_EFFECT_SP_DEF_PLUS_1 = 21
export const MOVE_EFFECT_ACC_PLUS_1 = 22
export const MOVE_EFFECT_EVS_PLUS_1 = 23
export const MOVE_EFFECT_ATK_MINUS_1 = 24
export const MOVE_EFFECT_DEF_MINUS_1 = 25
export const MOVE_EFFECT_SPD_MINUS_1 = 26
export const MOVE_EFFECT_SP_ATK_MINUS_1 = 27
export const MOVE_EFFECT_SP_DEF_MINUS_1 = 28
export const MOVE_EFFECT_ACC_MINUS_1 = 29
export const MOVE_EFFECT_EVS_MINUS_1 = 30
export const MOVE_EFFECT_PREVENT_ESCAPE = 34
export const MOVE_EFFECT_NIGHTMARE = 35
// pipeline/.upstream/er-config/MoveEffect.proto:47: MOVE_EFFECT_ALL_STATS_UP = 36;
export const MOVE_EFFECT_ALL_STATS_UP = 36
export const MOVE_EFFECT_ATK_PLUS_2 = 41
export const MOVE_EFFECT_DEF_PLUS_2 = 42
export const MOVE_EFFECT_SPD_PLUS_2 = 43
export const MOVE_EFFECT_SP_ATK_PLUS_2 = 44
export const MOVE_EFFECT_SP_DEF_PLUS_2 = 45
export const MOVE_EFFECT_ACC_PLUS_2 = 46
export const MOVE_EFFECT_EVS_PLUS_2 = 47
export const MOVE_EFFECT_ATK_MINUS_2 = 48
export const MOVE_EFFECT_DEF_MINUS_2 = 49
export const MOVE_EFFECT_SPD_MINUS_2 = 50
export const MOVE_EFFECT_SP_ATK_MINUS_2 = 51
export const MOVE_EFFECT_SP_DEF_MINUS_2 = 52
export const MOVE_EFFECT_ACC_MINUS_2 = 53
export const MOVE_EFFECT_EVS_MINUS_2 = 54
export const MOVE_EFFECT_ATTRACT = 73
export const MOVE_EFFECT_CURSE = 74
export const MOVE_EFFECT_DISABLE = 75
export const MOVE_EFFECT_SALT_CURE = 77
export const MOVE_EFFECT_SYRUP = 85
export const MOVE_EFFECT_YAWN = 89
export const MOVE_EFFECT_ENRAGE = 98
export const MOVE_EFFECT_DRENCH = 99

// include/constants/battle.h:456
export const PRIMARY_STATUS_MOVE_EFFECT = MOVE_EFFECT_BLEED

// tools/codegen/src/er/defines/MoveEffectGenerator.kt:20-22
export const MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES = 1 << 13 // 0x2000
export const MOVE_EFFECT_AFFECTS_USER = 1 << 14 // 0x4000
export const MOVE_EFFECT_CERTAIN = 1 << 15 // 0x8000

// TerrainType enum, include/abilities.hh:158-166
export const TERRAIN_NONE = 0
export const TERRAIN_GRASSY = 1 << 0
export const TERRAIN_ELECTRIC = 1 << 1
export const TERRAIN_PSYCHIC = 1 << 2
export const TERRAIN_MISTY = 1 << 3
export const TERRAIN_TOXIC = 1 << 4
export const TERRAIN_ANY =
  TERRAIN_GRASSY | TERRAIN_ELECTRIC | TERRAIN_PSYCHIC | TERRAIN_MISTY | TERRAIN_TOXIC

// InfiltrateType enum, include/abilities.hh:16-19
export const INFILTRATE_NONE = 0
export const INFILTRATE_SCREENS = 1 << 0
export const INFILTRATE_SUBSTITUTE = 1 << 1
export const INFILTRATE_BREAK_SCREENS = 1 << 2

// ---------------------------------------------------------------------------
// Ability Hook Lists (data/v2.65beta/abilityHooks.json)
// ---------------------------------------------------------------------------

/**
 * All 40 abilities with `hooks.onStatusImmune` in data/v2.65beta/abilityHooks.json.
 * Derived using:
 * grep -oP '"onStatusImmune":\{.*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 * Pinned with oracle test.
 */
export const STATUS_IMMUNE_ABILITIES = [
  'ABILITY_AMPHIBIOUS',
  'ABILITY_AROMA_VEIL',
  'ABILITY_BLOODLUST',
  'ABILITY_BLOOD_BATH',
  'ABILITY_BLOOD_STAIN',
  'ABILITY_BLOOD_STIGMA',
  'ABILITY_COMATOSE',
  'ABILITY_DESERT_CLOAK',
  'ABILITY_DISCIPLINE',
  'ABILITY_DREAMSCAPE',
  'ABILITY_DUNE_VEIL',
  'ABILITY_ENLIGHTENED',
  'ABILITY_FLAME_BUBBLE',
  'ABILITY_FLOWER_VEIL',
  'ABILITY_HYPER_CLEANSE',
  'ABILITY_IMMUNITY',
  'ABILITY_INNER_FOCUS',
  'ABILITY_INSOMNIA',
  'ABILITY_IRON_GIANT',
  'ABILITY_JUGGERNAUT',
  'ABILITY_JUNGLES_GUARD',
  'ABILITY_LIMBER',
  'ABILITY_MAGMA_ARMOR',
  'ABILITY_OBLIVIOUS',
  'ABILITY_OWN_TEMPO',
  'ABILITY_PROPELLER_TAIL',
  'ABILITY_PURIFYING_SALT',
  'ABILITY_PURIFYING_WATERS',
  'ABILITY_RUDE_AWAKENING',
  'ABILITY_SHIELDS_DOWN',
  'ABILITY_STALWART',
  'ABILITY_SUMO_GUARD',
  'ABILITY_SWEET_VEIL',
  'ABILITY_THERMAL_ENTROPY',
  'ABILITY_THERMAL_EXCHANGE',
  'ABILITY_UNLOCKED_POTENTIAL',
  'ABILITY_VITAL_SPIRIT',
  'ABILITY_WATER_BUBBLE',
  'ABILITY_WATER_VEIL',
  'ABILITY_WAY_OF_PRECISION',
] as const

/**
 * All 8 abilities with `hooks.onCanStatusType` in data/v2.65beta/abilityHooks.json.
 * Derived using:
 * grep -oP '"onCanStatusType":\{.*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 * Pinned with oracle test.
 */
export const CAN_STATUS_TYPE_ABILITIES = [
  'ABILITY_ACIDIC_SLIME',
  'ABILITY_ANGELS_WRATH',
  'ABILITY_CORROSION',
  'ABILITY_DEPRAVITY',
  'ABILITY_OVERCHARGE',
  'ABILITY_PYROCLASTIC_FLOW',
  'ABILITY_TRASH_HEAP',
  'ABILITY_TUMMYACHE',
] as const

/**
 * All 12 abilities with `bitfields.allowTerrainIfAirborne` in data/v2.65beta/abilityHooks.json.
 * Derived using:
 * grep -oP '"allowTerrainIfAirborne":"[^"]*".*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 */
export const ALLOW_TERRAIN_IF_AIRBORNE_ABILITIES = [
  'ABILITY_BRAIN_OVERLOAD',
  'ABILITY_ELECTRIC_SURGE',
  'ABILITY_GRASSY_SURGE',
  'ABILITY_HADRON_ENGINE',
  'ABILITY_HARUKAZE',
  'ABILITY_MISTY_SURGE',
  'ABILITY_POWER_LEAK',
  'ABILITY_PSYCHIC_SURGE',
  'ABILITY_SEED_SOWER',
  'ABILITY_SUPERCELL',
  'ABILITY_TOXIC_SURGE',
  'ABILITY_ZEN_GARDEN',
] as const

/**
 * Terrain masks for allowTerrainIfAirborne abilities (include/abilities.hh:158-166).
 * Stored as combined bitmasks per ability rather than hand-split per terrain.
 */
export const ALLOW_TERRAIN_IF_AIRBORNE_MASKS: Record<string, number> = {
  ABILITY_BRAIN_OVERLOAD: TERRAIN_PSYCHIC,
  ABILITY_ELECTRIC_SURGE: TERRAIN_ELECTRIC,
  ABILITY_GRASSY_SURGE: TERRAIN_GRASSY,
  ABILITY_HADRON_ENGINE: TERRAIN_ELECTRIC,
  ABILITY_HARUKAZE: TERRAIN_GRASSY,
  ABILITY_MISTY_SURGE: TERRAIN_MISTY,
  ABILITY_POWER_LEAK: TERRAIN_ELECTRIC,
  ABILITY_PSYCHIC_SURGE: TERRAIN_PSYCHIC,
  ABILITY_SEED_SOWER: TERRAIN_GRASSY,
  ABILITY_SUPERCELL: TERRAIN_ELECTRIC,
  ABILITY_TOXIC_SURGE: TERRAIN_TOXIC,
  ABILITY_ZEN_GARDEN: TERRAIN_GRASSY | TERRAIN_PSYCHIC,
}

/**
 * All 9 abilities with `bitfields.setStateOnEffect` in data/v2.65beta/abilityHooks.json.
 * Derived using:
 * grep -oP '"setStateOnEffect":"[^"]*".*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 */
export const SET_STATE_ON_EFFECT_ABILITIES = [
  'ABILITY_BLOOD_BATH',
  'ABILITY_CHOKEHOLD',
  'ABILITY_CRYOSTASIS',
  'ABILITY_ENTRANCE',
  'ABILITY_FROSTBIND',
  'ABILITY_HEMOTOXIN',
  'ABILITY_NEUROTOXIN',
  'ABILITY_POISON_PUPPETEER',
  'ABILITY_SET_ABLAZE',
] as const

/**
 * Mapping of move effect to abilities reacting via SetOnMoveEffectReactionFlags
 * (src/battle_script_commands.c:2294-2298).
 */
export const SET_STATE_ON_EFFECT_MAP: Record<number, string[]> = {
  [MOVE_EFFECT_BLEED]: ['ABILITY_BLOOD_BATH'],
  [MOVE_EFFECT_WRAP]: ['ABILITY_CHOKEHOLD'],
  [MOVE_EFFECT_CONFUSION]: ['ABILITY_ENTRANCE'],
  [MOVE_EFFECT_FROSTBITE]: ['ABILITY_CRYOSTASIS', 'ABILITY_FROSTBIND'],
  [MOVE_EFFECT_POISON]: ['ABILITY_HEMOTOXIN', 'ABILITY_NEUROTOXIN', 'ABILITY_POISON_PUPPETEER'],
  [MOVE_EFFECT_BURN]: ['ABILITY_SET_ABLAZE'],
}

/**
 * SetOnMoveEffectReactionFlags, src/battle_script_commands.c:2294-2298.
 *
 * ON_ABILITY(attacker, FALSE, gAbilities[ability].setStateOnEffect == effect,
 *            SetBattlerAffectedFlag(attacker, target, ability))
 *
 * `holderId` is SetMoveEffect's gBattleScripting.battler -- the attacker for a normal effect
 * (:2338-2343) and the TARGET for a MOVE_EFFECT_AFFECTS_USER effect. The loop walks the holder's
 * slots in reverse (battle_util.h:269-275) and skips suppressed abilities (checkMoldBreaker FALSE).
 * SetBattlerAffectedFlag (:13190-13195) ORs `1 << target` into the holder's ability-state byte, but
 * GetAbilityState/SetAbilityState resolve the ability through GetAbilityIndex, i.e. the FIRST forward
 * slot holding it, so a duplicate slot writes the same byte.
 *
 * The armed bit is consumed by PoisonPuppeteerClone (src/abilities.cc:286-312), which filters
 * `battler != target`; a self-set bit (holder == effectBattler) is therefore never applied.
 */
export function setOnMoveEffectReactionFlags(
  state: BattleState,
  holderId: number,
  effectBattlerId: number,
  moveEffect: number,
  deps: StatusDeps,
): void {
  const holder = state.battlers[holderId]
  if (!holder || holder.mon.hp === 0) return

  // `int effect = moveEffect == MOVE_EFFECT_TOXIC ? MOVE_EFFECT_POISON : moveEffect;` (:2295)
  const effect = moveEffect === MOVE_EFFECT_TOXIC ? MOVE_EFFECT_POISON : moveEffect
  const reactionAbilities = SET_STATE_ON_EFFECT_MAP[effect]
  if (!reactionAbilities) return

  for (const abilityId of getSlotsInReverse(holder.mon.abilities)) {
    if (!reactionAbilities.includes(abilityId)) continue
    if (isSimAbilitySuppressed(state, holder, abilityId, false, holderId, false, deps.dataContext)) continue

    const slot = findAbilitySlot(holder.mon.abilities, abilityId)
    if (slot < 0) continue
    holder.volatiles.abilityState[slot] = (holder.volatiles.abilityState[slot] ?? 0) | (1 << effectBattlerId)
  }
}

/**
 * Exactly 7 Minior species protected by Shields Down (src/abilities.cc:2680-2720).
 */
export const SHIELDS_DOWN_PROTECTED_SPECIES = [
  'SPECIES_MINIOR',
  'SPECIES_MINIOR_METEOR_ORANGE',
  'SPECIES_MINIOR_METEOR_YELLOW',
  'SPECIES_MINIOR_METEOR_GREEN',
  'SPECIES_MINIOR_METEOR_BLUE',
  'SPECIES_MINIOR_METEOR_INDIGO',
  'SPECIES_MINIOR_METEOR_VIOLET',
] as const

/**
 * All 10 abilities with `hooks.onModifyMoveFlags` in data/v2.65beta/abilityHooks.json.
 * DoesMoveMatchFlag (src/abilities.cc:331-361).
 * Derived using:
 * grep -oP '"onModifyMoveFlags":\{.*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 */
export const MODIFY_MOVE_FLAGS_ABILITIES = [
  'ABILITY_BACKSTREET_BOY',
  'ABILITY_BRAWLING_WYVERN',
  'ABILITY_CHESTNUT_AXE',
  'ABILITY_FESTIVITIES',
  'ABILITY_GUNMAN',
  'ABILITY_JUNSHI_SANDA',
  'ABILITY_MIXED_MARTIAL_ARTS',
  'ABILITY_MUSICAL_NOTES',
  'ABILITY_REVERBATE',
  'ABILITY_TAEKKYEON',
] as const

/**
 * All 10 abilities with `hooks.onInfiltrate` in data/v2.65beta/abilityHooks.json.
 * Infiltrates (src/battle_script_commands.c:12246-12250).
 * Derived using:
 * grep -oP '"onInfiltrate":\{.*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 */
export const INFILTRATE_ABILITIES = [
  'ABILITY_DEMOLITIONIST',
  'ABILITY_DUALITY',
  'ABILITY_FIGHT_SPIRIT',
  'ABILITY_INFILTRATOR',
  'ABILITY_KING_OF_THE_JUNGLE',
  'ABILITY_MARINE_APEX',
  'ABILITY_MYCELIUM_MIGHT',
  'ABILITY_PINNACLE_BLADE',
  'ABILITY_QIGONG',
  'ABILITY_WARRIORS_SPEAR',
] as const

/**
 * Abilities that can bypass Substitute (returning a mask with INFILTRATE_SUBSTITUTE).
 * Infiltrator and aliases (Duality, King of the Jungle, Marine Apex), Mycelium Might (status),
 * and Pinnacle Blade (Keen Edge moves).
 * Note: Demolitionist, Fight Spirit, Qigong and Warrior's Spear return only INFILTRATE_BREAK_SCREENS.
 */
export const INFILTRATES_SUBSTITUTE_ABILITIES = [
  'ABILITY_DUALITY',
  'ABILITY_INFILTRATOR',
  'ABILITY_KING_OF_THE_JUNGLE',
  'ABILITY_MARINE_APEX',
  'ABILITY_MYCELIUM_MIGHT',
  'ABILITY_PINNACLE_BLADE',
] as const

/**
 * All 4 abilities with `bitfields.powderImmune` in data/v2.65beta/abilityHooks.json.
 * Derived using:
 * grep -oP '"powderImmune":"TRUE".*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 */
export const POWDER_IMMUNE_ABILITIES = [
  'ABILITY_EFFECT_SPORE',
  'ABILITY_GUARDIAN_COAT',
  'ABILITY_OVERCOAT',
  'ABILITY_SHIELD_DUST',
] as const

/**
 * All 2 abilities with `bitfields.pollinateImmunities` in data/v2.65beta/abilityHooks.json.
 * Derived using:
 * grep -oP '"pollinateImmunities":"TRUE".*?"id":"ABILITY_[^"]*"' /home/nghiatruong/git-repos/personal/elitereduxtools/data/v2.65beta/abilityHooks.json
 */
export const POLLINATE_IMMUNITIES_ABILITIES = [
  'ABILITY_POLLINATE',
  'ABILITY_STEEL_BEETLE',
] as const

// ---------------------------------------------------------------------------
// Dependencies and Results Interfaces
// ---------------------------------------------------------------------------

export interface StatusDeps {
  dataContext: SimDataContext
  grounding: GroundingContext
}

export interface ApplyStatusResult {
  applied: boolean
  doesntAffectFoe: boolean
  status?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function findAbilitySlot(
  slots: { ability: string | null; innates: (string | null)[] },
  abilityId: string,
): number {
  if (slots.ability === abilityId) return 0
  for (let i = 0; i < slots.innates.length; i++) {
    if (slots.innates[i] === abilityId) return i + 1
  }
  return -1
}

/**
 * IsPowderImmune, src/battle_util.c:3190-3197.
 * Checks powder immunity via Mycelium Might bypass, Grass type, Safety Goggles,
 * powderImmune abilities, and Bug pollinateImmunities.
 */
export function isPowderImmune(
  state: BattleState,
  attackerId: number,
  targetId: number,
  deps: StatusDeps,
): boolean {
  if (isMyceliumMightActive(state, attackerId, deps)) return false

  const target = state.battlers[targetId]
  if (!target) return false

  if (target.mon.types.includes('GRASS')) return true

  if (deps.grounding.holdEffectOf(targetId) === 'HOLD_EFFECT_SAFETY_GOGGLES') return true

  const attacker = state.battlers[attackerId]
  const attackerHasMoldBreaker = attacker ? attackerHasMoldBreakerActive(attacker, deps) : false

  for (const ability of POWDER_IMMUNE_ABILITIES) {
    if (battlerHasSimAbility(state, target, ability, true, attackerId, attackerHasMoldBreaker, deps.dataContext)) {
      return true
    }
  }

  if (target.mon.types.includes('BUG')) {
    for (const ability of POLLINATE_IMMUNITIES_ABILITIES) {
      if (battlerHasSimAbility(state, target, ability, true, attackerId, attackerHasMoldBreaker, deps.dataContext)) {
        return true
      }
    }
  }

  return false
}

/**
 * IsMyceliumMightActive, src/battle_main.c:4249.
 * Checks whether the attacker has Mycelium Might active (unsuppressed, mold breaker=false).
 */
export function isMyceliumMightActive(
  state: BattleState,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  if (attackerId == null) return false
  const attacker = state.battlers[attackerId]
  if (!attacker) return false
  return battlerHasSimAbility(state, attacker, 'ABILITY_MYCELIUM_MIGHT', false, attackerId, false, deps.dataContext)
}

/**
 * IsTerrainActive, src/battle_util.c:4886-4889.
 * TERRAIN_HAS_EFFECT (no Clueless on field) plus the terrain flag.
 */
export function isTerrainActive(
  state: BattleState,
  terrainFlag: number,
  deps: StatusDeps,
): boolean {
  if (deps.grounding.isCluelessOnField) return false
  return hasFlag(state.field.statuses, terrainFlag)
}

/**
 * IsBattlerTerrainAffected, src/battle_util.c:4901-4929.
 * Checks if terrain is active and battler is affected (grounded or allowTerrainIfAirborne).
 */
export function isBattlerTerrainAffected(
  state: BattleState,
  battlerId: number,
  terrainFlag: number,
  deps: StatusDeps,
): boolean {
  if (!isTerrainActive(state, terrainFlag, deps)) return false

  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE)) return false

  if (isBattlerGrounded(state, battlerId, deps.grounding)) {
    return true
  }

  // Active terrain switch (battle_util.c:4908-4924)
  let type = TERRAIN_NONE
  const activeTerrain = state.field.statuses & STATUS_FIELD_TERRAIN_ANY
  switch (activeTerrain) {
    case STATUS_FIELD_TOXIC_TERRAIN:
      type = TERRAIN_TOXIC
      break
    case STATUS_FIELD_MISTY_TERRAIN:
      type = TERRAIN_MISTY
      break
    case STATUS_FIELD_GRASSY_TERRAIN:
      type = TERRAIN_GRASSY
      break
    case STATUS_FIELD_ELECTRIC_TERRAIN:
      type = TERRAIN_ELECTRIC
      break
    case STATUS_FIELD_PSYCHIC_TERRAIN:
      type = TERRAIN_PSYCHIC
      break
  }

  if (type === TERRAIN_NONE) return false

  // ON_ABILITY(battlerId, FALSE, allowTerrainIfAirborne & type) (:4926)
  for (const [ability, mask] of Object.entries(ALLOW_TERRAIN_IF_AIRBORNE_MASKS)) {
    if ((mask & type) !== 0) {
      if (battlerHasSimAbility(state, battler, ability, false, battlerId, false, deps.dataContext)) {
        return true
      }
    }
  }

  return false
}

/**
 * CanPoisonType, src/battle_script_commands.c:6465-6470.
 * Checks Poison/Steel immunity and Corrosion / Angel's Wrath bypasses.
 */
export function canPoisonType(
  state: BattleState,
  attackerId: number,
  targetId: number,
  move: string | null | undefined,
  deps: StatusDeps,
): boolean {
  const target = state.battlers[targetId]
  if (!target) return true
  if (!target.mon.types.includes('POISON') && !target.mon.types.includes('STEEL')) return true

  const attacker = state.battlers[attackerId]
  if (!attacker) return false

  for (const ability of [
    'ABILITY_CORROSION',
    'ABILITY_PYROCLASTIC_FLOW',
    'ABILITY_TRASH_HEAP',
    'ABILITY_ACIDIC_SLIME',
    'ABILITY_TUMMYACHE',
  ]) {
    if (battlerHasSimAbility(state, attacker, ability, false, attackerId, false, deps.dataContext)) return true
  }

  if (
    move === 'MOVE_POISON_STING' &&
    battlerHasSimAbility(state, attacker, 'ABILITY_ANGELS_WRATH', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }

  return false
}

/**
 * CanParalyzeType, src/battle_script_commands.c:6472-6479.
 * Checks Electric immunity and Overcharge / Depravity bypasses.
 */
export function canParalyzeType(
  state: BattleState,
  attackerId: number,
  targetId: number,
  deps: StatusDeps,
): boolean {
  const target = state.battlers[targetId]
  if (!target) return true
  if (!target.mon.types.includes('ELECTRIC')) return true

  const attacker = state.battlers[attackerId]
  if (!attacker) return false

  for (const ability of ['ABILITY_OVERCHARGE', 'ABILITY_DEPRAVITY']) {
    if (battlerHasSimAbility(state, attacker, ability, false, attackerId, false, deps.dataContext)) return true
  }

  return false
}

/**
 * CancelMultiTurnMoves, src/battle_util.c:1164-1175.
 * Clears multi-turn volatile flags (MULTIPLETURNS, LOCK_CONFUSE, UPROAR, BIDE).
 */
export function cancelMultiTurnMoves(battler: BattlerState): void {
  const clearMask2 = STATUS2_MULTIPLETURNS | STATUS2_LOCK_CONFUSE | STATUS2_UPROAR | STATUS2_BIDE
  battler.mon.status2 = clearFlag(battler.mon.status2, clearMask2)
  if (!battler.volatiles.skyDropped) {
    battler.statuses3 = clearFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE)
  }
}

/**
 * IsSoundMove, src/battle_util.c:9379:
 * DoesMoveMatchFlag(battler, move, TYPE_NORMAL, MOVE_FLAG_SOUND).
 * Checks move's static sound flag, and falls back to onModifyMoveFlags abilities
 * (Festivities for dance moves, Musical Notes for status moves, Reverbate for Normal moves).
 * If attacker has an ability that modifies move flags that cannot be evaluated statically,
 * pushes 'DoesMoveMatchFlag' to unmodelled.
 */
export function isSoundMove(
  state: BattleState,
  attackerId: number,
  moveId: string | null | undefined,
  deps: StatusDeps,
  unmodelled?: string[],
): boolean {
  if (!moveId) return false
  const moveData = deps.dataContext.move(moveId)
  if (moveData?.flags?.sound) return true

  const attacker = state.battlers[attackerId]
  if (!attacker) return false

  // Check abilities granting MOVE_FLAG_SOUND via onModifyMoveFlags
  if (
    moveData?.flags?.dance &&
    battlerHasSimAbility(state, attacker, 'ABILITY_FESTIVITIES', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }
  if (
    moveData?.split === 'STATUS' &&
    battlerHasSimAbility(state, attacker, 'ABILITY_MUSICAL_NOTES', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }
  if (
    moveData?.type === 'TYPE_NORMAL' &&
    battlerHasSimAbility(state, attacker, 'ABILITY_REVERBATE', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }

  // Gap on any attacker ability that modifies move flags
  for (const ability of MODIFY_MOVE_FLAGS_ABILITIES) {
    if (battlerHasSimAbility(state, attacker, ability, false, attackerId, false, deps.dataContext)) {
      unmodelled?.push('DoesMoveMatchFlag')
      break
    }
  }

  return false
}

/**
 * IsKeenEdge, src/battle_util.c:9381:
 * DoesMoveMatchFlag(battler, move, GetTypeBeforeUsingMove(move, battler), MOVE_FLAG_KEEN_EDGE).
 * Checks move's static sliceBased flag (mapped to keen_edge in codegen/proto),
 * and falls back to onModifyMoveFlags abilities (Chestnut Axe for Grass moves,
 * tested against the RESOLVED type).
 * Gaps by name when attacker has an ability modifying move flags.
 */
export function isKeenEdgeMove(
  state: BattleState,
  attackerId: number,
  moveId: string | null | undefined,
  deps: StatusDeps,
  unmodelled?: string[],
): boolean {
  if (!moveId) return false
  const moveData = deps.dataContext.move(moveId)
  if (moveData?.flags?.sliceBased) return true

  const attacker = state.battlers[attackerId]
  if (!attacker) return false

  // The C passes GetTypeBeforeUsingMove as DoesMoveMatchFlag's third argument
  // (battle_util.c:9381), i.e. the RESOLVED type, not the declared one. Only
  // Chestnut Axe's grant reads it (`moveType == TYPE_GRASS`, abilities.cc:11709),
  // and an "-ate" ability such as Fertilize can turn a Normal move into Grass.
  const resolvedType = moveData?.type
    ? resolveEffectiveMoveType(attacker.mon.abilities, moveId, moveData.type, moveData.flags ?? {}).moveType
    : null
  if (
    resolvedType === 'GRASS' &&
    battlerHasSimAbility(state, attacker, 'ABILITY_CHESTNUT_AXE', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }

  for (const ability of MODIFY_MOVE_FLAGS_ABILITIES) {
    if (battlerHasSimAbility(state, attacker, ability, false, attackerId, false, deps.dataContext)) {
      unmodelled?.push('DoesMoveMatchFlag')
      break
    }
  }

  return false
}

/**
 * IsStrikerBoosted, src/battle_util.c:9377:
 * DoesMoveMatchFlag(battler, move, TYPE_NORMAL, MOVE_FLAG_KICK).
 * Checks the move's static kickBased flag (FLAG_STRIKER_BOOST, moves.json
 * `kickBased`) and the onModifyMoveFlags abilities that grant MOVE_FLAG_KICK
 * (src/abilities.cc:358-388):
 *   - Junshi Sanda (:7613-7622) when the move has FLAG_IRON_FIST_BOOST (`punchBased`);
 *   - Mixed Martial Arts (:9898-9905) when the move's own data type is TYPE_NORMAL;
 *   - Backstreet Boy (:11570-11583) when the move has FLAG_DANCE (`dance`).
 * Every other onModifyMoveFlags ability in the checkout grants PUNCH, SOUND,
 * DANCE, MEGA_LAUNCHER or KEEN_EDGE only (Brawling Wyvern :7603, Gunman :9535,
 * Festivities :10194, Reverbate :10657, Taekkyeon :10666, Chestnut Axe :11709,
 * Musical Notes :11988), never KICK, so unlike isSoundMove/isKeenEdgeMove there
 * is no DoesMoveMatchFlag gap to push here.
 */
export function isStrikerMove(
  state: BattleState,
  attackerId: number,
  moveId: string | null | undefined,
  deps: StatusDeps,
): boolean {
  if (!moveId) return false
  const moveData = deps.dataContext.move(moveId)
  if (moveData?.flags?.kickBased) return true

  const attacker = state.battlers[attackerId]
  if (!attacker) return false

  if (
    moveData?.flags?.punchBased &&
    battlerHasSimAbility(state, attacker, 'ABILITY_JUNSHI_SANDA', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }
  if (
    moveData?.type === 'NORMAL' &&
    battlerHasSimAbility(state, attacker, 'ABILITY_MIXED_MARTIAL_ARTS', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }
  if (
    moveData?.flags?.dance &&
    battlerHasSimAbility(state, attacker, 'ABILITY_BACKSTREET_BOY', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }

  return false
}

/**
 * Infiltrates(battlerAtk, move, moveType, INFILTRATE_SUBSTITUTE), src/battle_script_commands.c:12246-12250.
 * Runs onInfiltrate hooks and checks (result & INFILTRATE_SUBSTITUTE).
 * - Infiltrator and aliases (Duality, King of the Jungle, Marine Apex) return SCREENS | SUBSTITUTE.
 * - Mycelium Might returns SCREENS | SUBSTITUTE only for status moves.
 * - Pinnacle Blade returns BREAK_SCREENS | SUBSTITUTE only for Keen Edge moves.
 * - Demolitionist, Fight Spirit, Qigong and Warrior's Spear return only BREAK_SCREENS (never bypass Substitute).
 */
export function infiltratesSubstitute(
  state: BattleState,
  attackerId: number,
  moveId: string | null | undefined,
  deps: StatusDeps,
  unmodelled?: string[],
): boolean {
  const attacker = state.battlers[attackerId]
  if (!attacker) return false

  for (const ability of [
    'ABILITY_INFILTRATOR',
    'ABILITY_DUALITY',
    'ABILITY_KING_OF_THE_JUNGLE',
    'ABILITY_MARINE_APEX',
  ]) {
    if (battlerHasSimAbility(state, attacker, ability, false, attackerId, false, deps.dataContext)) {
      return true
    }
  }

  const moveData = moveId ? deps.dataContext.move(moveId) : undefined
  if (
    moveData?.split === 'STATUS' &&
    battlerHasSimAbility(state, attacker, 'ABILITY_MYCELIUM_MIGHT', false, attackerId, false, deps.dataContext)
  ) {
    return true
  }

  if (
    battlerHasSimAbility(state, attacker, 'ABILITY_PINNACLE_BLADE', false, attackerId, false, deps.dataContext) &&
    isKeenEdgeMove(state, attackerId, moveId, deps, unmodelled)
  ) {
    return true
  }

  return false
}

/**
 * DoesSubstituteBlockMove, src/battle_script_commands.c:12252-12260.
 * Checks if target's Substitute blocks the incoming move.
 */
export function doesSubstituteBlockMove(
  state: BattleState,
  attackerId: number,
  targetId: number,
  moveId: string | null | undefined,
  deps: StatusDeps,
  unmodelled?: string[],
): boolean {
  const target = state.battlers[targetId]
  if (!target || !hasFlag(target.mon.status2, STATUS2_SUBSTITUTE)) return false

  const attacker = state.battlers[attackerId]
  if (!attacker) return true

  const moveData = moveId ? deps.dataContext.move(moveId) : undefined

  // 1. Sound moves bypass Substitute (src/battle_script_commands.c:12254, battle_util.c:9379)
  if (isSoundMove(state, attackerId, moveId, deps, unmodelled)) return false

  // 2. FLAG_HIT_IN_SUBSTITUTE bypasses Substitute (src/battle_script_commands.c:12255)
  // Emitted as `ignoresSubstitute` in moves.json (pipeline/src/erdata/emit.py:82, BattleMovesGenerator.kt:110-127)
  if (moveData?.flags?.ignoresSubstitute) return false

  // 3. Infiltrates(battlerAtk, move, moveType, INFILTRATE_SUBSTITUTE) (src/battle_script_commands.c:12257)
  if (infiltratesSubstitute(state, attackerId, moveId, deps, unmodelled)) return false

  return true
}

/**
 * IsPreventableSecondaryEffect, src/battle_script_commands.c:2240-2292.
 * Checks if a move effect can be blocked by Shield Dust / Covert Cloak.
 */
export function isPreventableSecondaryEffect(moveEffect: number): boolean {
  switch (moveEffect) {
    case MOVE_EFFECT_SLEEP:
    case MOVE_EFFECT_POISON:
    case MOVE_EFFECT_BURN:
    case MOVE_EFFECT_FREEZE:
    case MOVE_EFFECT_PARALYSIS:
    case MOVE_EFFECT_TOXIC:
    case MOVE_EFFECT_FROSTBITE:
    case MOVE_EFFECT_BLEED:
    case MOVE_EFFECT_CONFUSION:
    case MOVE_EFFECT_FLINCH:
    case MOVE_EFFECT_ATK_PLUS_1:
    case MOVE_EFFECT_DEF_PLUS_1:
    case MOVE_EFFECT_SPD_PLUS_1:
    case MOVE_EFFECT_SP_ATK_PLUS_1:
    case MOVE_EFFECT_SP_DEF_PLUS_1:
    case MOVE_EFFECT_ACC_PLUS_1:
    case MOVE_EFFECT_EVS_PLUS_1:
    case MOVE_EFFECT_ATK_MINUS_1:
    case MOVE_EFFECT_DEF_MINUS_1:
    case MOVE_EFFECT_SPD_MINUS_1:
    case MOVE_EFFECT_SP_ATK_MINUS_1:
    case MOVE_EFFECT_SP_DEF_MINUS_1:
    case MOVE_EFFECT_ACC_MINUS_1:
    case MOVE_EFFECT_EVS_MINUS_1:
    case MOVE_EFFECT_ATK_PLUS_2:
    case MOVE_EFFECT_DEF_PLUS_2:
    case MOVE_EFFECT_SPD_PLUS_2:
    case MOVE_EFFECT_SP_ATK_PLUS_2:
    case MOVE_EFFECT_SP_DEF_PLUS_2:
    case MOVE_EFFECT_ACC_PLUS_2:
    case MOVE_EFFECT_EVS_PLUS_2:
    case MOVE_EFFECT_ATK_MINUS_2:
    case MOVE_EFFECT_DEF_MINUS_2:
    case MOVE_EFFECT_SPD_MINUS_2:
    case MOVE_EFFECT_SP_ATK_MINUS_2:
    case MOVE_EFFECT_SP_DEF_MINUS_2:
    case MOVE_EFFECT_ACC_MINUS_2:
    case MOVE_EFFECT_EVS_MINUS_2:
    case MOVE_EFFECT_ATTRACT:
    case MOVE_EFFECT_CURSE:
    case MOVE_EFFECT_DISABLE:
    case MOVE_EFFECT_SALT_CURE:
    case MOVE_EFFECT_PREVENT_ESCAPE:
    case MOVE_EFFECT_NIGHTMARE:
    case MOVE_EFFECT_SYRUP:
    case MOVE_EFFECT_DRENCH:
      return true
    default:
      return false
  }
}

/**
 * TestSheerForceFlag, src/battle_util.c:8531-8536:
 * BattlerHasAbility(battler, ABILITY_SHEER_FORCE, FALSE) && gBattleMoves[move].flags & FLAG_SHEER_FORCE_BOOST.
 *
 * In codegen (BattleMovesGenerator.kt:70-77, 100), FLAG_SHEER_FORCE_BOOST requires
 * split != STATUS, effectChance > 0, and neither move.effect nor move.argument.effect.effect has noSheerForce.
 *
 * The codegen does NOT read the move's own `no_sheer_force` flag (moves.json `flags.noSheerForce`), only
 * the MoveBehavior / argument MoveEffect `noSheerForce` options, which the snapshot does not carry per move.
 * Reads moveData.sheerForceBoost emitted by pipeline per BattleMovesGenerator.kt:70-77.
 */
export function testSheerForceFlag(
  state: BattleState,
  attackerId: number,
  moveId: string | null | undefined,
  deps: StatusDeps,
): boolean {
  const attacker = state.battlers[attackerId]
  if (!attacker) return false
  if (!battlerHasSimAbility(state, attacker, 'ABILITY_SHEER_FORCE', false, attackerId, false, deps.dataContext)) {
    return false
  }
  if (!moveId) return false
  const moveData = deps.dataContext.move(moveId)
  return moveData?.sheerForceBoost === true
}

// ---------------------------------------------------------------------------
// Status Immunity and Eligibility Predicates
// ---------------------------------------------------------------------------

/** One onStatusImmune ability's condition, in the EXACT order
 * IsAbilityStatusProtected tests them. `extra` models the hook's own additional
 * CHECK (GetAbilityState, weather, Grass-type). The table exists so the
 * cure-on-immunity helper (findCureOnImmunityAbility, below) can ask the same
 * per-ability question without duplicating or reordering the predicates. */
type StatusImmuneCondition = {
  ability: string
  statusMask: number
  extra?: (state: BattleState, battlerId: number, battler: BattlerState, deps: StatusDeps) => boolean
}

/** Every own-slot onStatusImmune ability, in isAbilityStatusProtected's order.
 * Order is load-bearing: the first match is the ability the C's ON_ABILITY
 * loop (battle_util.h:269-275, reverse slot order) would name. */
const OWN_STATUS_IMMUNE_CONDITIONS: readonly StatusImmuneCondition[] = [
  // CHECK_SLEEP
  { ability: 'ABILITY_INSOMNIA', statusMask: CHECK_SLEEP },
  { ability: 'ABILITY_VITAL_SPIRIT', statusMask: CHECK_SLEEP },
  { ability: 'ABILITY_SWEET_VEIL', statusMask: CHECK_SLEEP },
  {
    ability: 'ABILITY_RUDE_AWAKENING',
    statusMask: CHECK_SLEEP,
    // abilities.cc:1364-1366 -- CHECK(GetAbilityState(battler, ability))
    extra: (_state, _battlerId, battler) => {
      const slot = findAbilitySlot(battler.mon.abilities, 'ABILITY_RUDE_AWAKENING')
      return slot !== -1 && (battler.volatiles.abilityState[slot] ?? 0) !== 0
    },
  },
  // CHECK_BURN
  { ability: 'ABILITY_WATER_VEIL', statusMask: CHECK_BURN },
  { ability: 'ABILITY_PURIFYING_WATERS', statusMask: CHECK_BURN },
  { ability: 'ABILITY_WATER_BUBBLE', statusMask: CHECK_BURN },
  { ability: 'ABILITY_FLAME_BUBBLE', statusMask: CHECK_BURN },
  { ability: 'ABILITY_THERMAL_EXCHANGE', statusMask: CHECK_BURN },
  { ability: 'ABILITY_THERMAL_ENTROPY', statusMask: CHECK_BURN },
  // CHECK_PARALYSIS
  { ability: 'ABILITY_LIMBER', statusMask: CHECK_PARALYSIS },
  { ability: 'ABILITY_JUGGERNAUT', statusMask: CHECK_PARALYSIS },
  { ability: 'ABILITY_SUMO_GUARD', statusMask: CHECK_PARALYSIS },
  { ability: 'ABILITY_IRON_GIANT', statusMask: CHECK_PARALYSIS },
  // CHECK_FROSTBITE
  { ability: 'ABILITY_MAGMA_ARMOR', statusMask: CHECK_FROSTBITE },
  // CHECK_BLEED
  { ability: 'ABILITY_BLOOD_BATH', statusMask: CHECK_BLEED },
  { ability: 'ABILITY_BLOODLUST', statusMask: CHECK_BLEED },
  // Immunity blocks non-sleep status1 (src/abilities.cc:713)
  { ability: 'ABILITY_IMMUNITY', statusMask: CHECK_STATUS1 & ~CHECK_SLEEP },
  // Full status1 immunities
  { ability: 'ABILITY_COMATOSE', statusMask: CHECK_STATUS1 },
  { ability: 'ABILITY_DREAMSCAPE', statusMask: CHECK_STATUS1 },
  { ability: 'ABILITY_PURIFYING_SALT', statusMask: CHECK_STATUS1 },
  { ability: 'ABILITY_BLOOD_STAIN', statusMask: CHECK_STATUS1 },
  { ability: 'ABILITY_BLOOD_STIGMA', statusMask: CHECK_STATUS1 },
  { ability: 'ABILITY_HYPER_CLEANSE', statusMask: CHECK_STATUS1 },
  {
    ability: 'ABILITY_SHIELDS_DOWN',
    statusMask: CHECK_STATUS1,
    extra: (_state, _battlerId, battler) =>
      SHIELDS_DOWN_PROTECTED_SPECIES.includes(
        battler.mon.speciesId as (typeof SHIELDS_DOWN_PROTECTED_SPECIES)[number],
      ),
  },
  {
    ability: 'ABILITY_FLOWER_VEIL',
    statusMask: CHECK_STATUS1,
    extra: (_state, _battlerId, battler) => battler.mon.types.includes('GRASS'),
  },
  {
    ability: 'ABILITY_JUNGLES_GUARD',
    statusMask: CHECK_STATUS1,
    extra: (_state, _battlerId, battler) => battler.mon.types.includes('GRASS'),
  },
  {
    ability: 'ABILITY_DESERT_CLOAK',
    statusMask: CHECK_STATUS1,
    extra: (state, battlerId, _battler, deps) =>
      isBattlerWeatherAffected(state, battlerId, WEATHER_SANDSTORM_ANY, deps),
  },
  {
    ability: 'ABILITY_DUNE_VEIL',
    statusMask: CHECK_STATUS1,
    extra: (state, battlerId, _battler, deps) =>
      isBattlerWeatherAffected(state, battlerId, WEATHER_SANDSTORM_ANY, deps),
  },
  // CHECK_CONFUSION
  { ability: 'ABILITY_OWN_TEMPO', statusMask: CHECK_CONFUSION },
  { ability: 'ABILITY_DISCIPLINE', statusMask: CHECK_CONFUSION },
  // CHECK_INFATUATE | CHECK_RESTRICTING
  { ability: 'ABILITY_OBLIVIOUS', statusMask: CHECK_INFATUATE | CHECK_RESTRICTING },
  // CHECK_INFATUATE | CHECK_RESTRICTING | CHECK_HEAL_BLOCK
  { ability: 'ABILITY_AROMA_VEIL', statusMask: CHECK_INFATUATE | CHECK_RESTRICTING | CHECK_HEAL_BLOCK },
  // CHECK_DRENCH
  { ability: 'ABILITY_AMPHIBIOUS', statusMask: CHECK_DRENCH },
  // CHECK_FLINCH
  { ability: 'ABILITY_INNER_FOCUS', statusMask: CHECK_FLINCH },
  { ability: 'ABILITY_ENLIGHTENED', statusMask: CHECK_FLINCH },
  { ability: 'ABILITY_UNLOCKED_POTENTIAL', statusMask: CHECK_FLINCH },
  { ability: 'ABILITY_WAY_OF_PRECISION', statusMask: CHECK_FLINCH },
  // CHECK_REDIRECTION
  { ability: 'ABILITY_PROPELLER_TAIL', statusMask: CHECK_REDIRECTION },
  { ability: 'ABILITY_STALWART', statusMask: CHECK_REDIRECTION },
]

const STATUS_IMMUNE_CONDITION_BY_ABILITY = new Map(
  OWN_STATUS_IMMUNE_CONDITIONS.map((condition) => [condition.ability, condition]),
)

/** Every ability whose abilityHooks.json `bitfields.removesStatusOnImmunity` is
 * TRUE and that declares an onStatusImmune hook. Extraction:
 * `python3 -c "import json; d=json.load(open('data/v2.65beta/abilityHooks.json'));
 * print(sorted(k for k,v in d.items() if
 * v.get('bitfields',{}).get('removesStatusOnImmunity')))"` -- 29 entries. The
 * three that carry the bitfield but declare NO onStatusImmune hook
 * (Bruteforce, Rock Head, Steel Barrel) are omitted: ON_ABILITY's own
 * `removesStatusOnImmunity && onStatusImmune` filter means they can never cure
 * anything, so 26 remain. The list is pinned to the snapshot by
 * cycle103StatusImmune.test.ts. */
export const REMOVES_STATUS_ON_IMMUNITY_ABILITIES: readonly string[] = [
  'ABILITY_BLOODLUST',
  'ABILITY_BLOOD_BATH',
  'ABILITY_BLOOD_STAIN',
  'ABILITY_BLOOD_STIGMA',
  'ABILITY_COMATOSE',
  'ABILITY_DISCIPLINE',
  'ABILITY_DREAMSCAPE',
  'ABILITY_FLAME_BUBBLE',
  'ABILITY_HYPER_CLEANSE',
  'ABILITY_IMMUNITY',
  'ABILITY_INSOMNIA',
  'ABILITY_IRON_GIANT',
  'ABILITY_JUGGERNAUT',
  'ABILITY_LIMBER',
  'ABILITY_MAGMA_ARMOR',
  'ABILITY_OBLIVIOUS',
  'ABILITY_OWN_TEMPO',
  'ABILITY_PURIFYING_SALT',
  'ABILITY_PURIFYING_WATERS',
  'ABILITY_RUDE_AWAKENING',
  'ABILITY_SUMO_GUARD',
  'ABILITY_THERMAL_ENTROPY',
  'ABILITY_THERMAL_EXCHANGE',
  'ABILITY_VITAL_SPIRIT',
  'ABILITY_WATER_BUBBLE',
  'ABILITY_WATER_VEIL',
]
const REMOVES_STATUS_ON_IMMUNITY_SET = new Set(REMOVES_STATUS_ON_IMMUNITY_ABILITIES)

/** The onStatusImmune half of one ability: does the hook itself return TRUE for
 * this status? Used by both isAbilityStatusProtected (via the table loop) and
 * findCureOnImmunityAbility (per slot). */
function abilityStatusImmuneMatches(
  condition: StatusImmuneCondition,
  status: StatusCheck,
  state: BattleState,
  battlerId: number,
  battler: BattlerState,
  deps: StatusDeps,
): boolean {
  if ((status & condition.statusMask) === 0) return false
  if (condition.extra && !condition.extra(state, battlerId, battler, deps)) return false
  return true
}

/**
 * MOVEEND_STATUS_IMMUNITY_ABILITIES' per-ability question: find the first
 * ability in ON_ABILITY order (reverse slots, battle_util.h:269-275) whose
 * removesStatusOnImmunity bitfield is set and whose onStatusImmune hook returns
 * TRUE for `status` (battle_util.c:4560-4609). checkMoldBreaker is FALSE there,
 * so a breakable ability is NOT suppressed by a Mold Breaker move that landed
 * the status -- the whole point of this move-end re-check.
 *
 * Suppression uses the same isSimAbilitySuppressed helper the ON_ABILITY macro's
 * FILTER_NOT(IsSuppressed(...)) transcribes (Gastro Acid / Neutralizing Gas,
 * plus the Ability Shield escape).
 */
export function findCureOnImmunityAbility(
  state: BattleState,
  battlerId: number,
  status: StatusCheck,
  deps: StatusDeps,
): string | null {
  const battler = state.battlers[battlerId]
  if (!battler) return null
  for (const abilityId of getSlotsInReverse(battler.mon.abilities)) {
    if (!REMOVES_STATUS_ON_IMMUNITY_SET.has(abilityId)) continue
    if (isSimAbilitySuppressed(state, battler, abilityId, false, battlerId, false, deps.dataContext)) continue
    const condition = STATUS_IMMUNE_CONDITION_BY_ABILITY.get(abilityId)
    if (!condition) continue
    if (abilityStatusImmuneMatches(condition, status, state, battlerId, battler, deps)) return abilityId
  }
  return null
}

/**
 * IsAbilityStatusProtected, src/battle_script_commands.c:6579-6591.
 * Returns the protecting ability ID if protected, or null if not protected.
 */
export function isAbilityStatusProtected(
  state: BattleState,
  battlerId: number,
  status: StatusCheck,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): string | null {
  const battler = state.battlers[battlerId]
  if (!battler) return null

  const attacker = attackerId != null ? state.battlers[attackerId] : null
  const attackerHasMoldBreaker = attacker ? attackerHasMoldBreakerActive(attacker, deps) : false

  const has = (abilityId: string) =>
    battlerHasSimAbility(state, battler, abilityId, true, attackerId ?? -1, attackerHasMoldBreaker, deps.dataContext)

  // 1. Direct abilities on battler
  for (const condition of OWN_STATUS_IMMUNE_CONDITIONS) {
    if (!abilityStatusImmuneMatches(condition, status, state, battlerId, battler, deps)) continue
    if (has(condition.ability)) return condition.ability
  }

  // 2. Partner abilities (APPLY_ON_ALLY) in doubles
  const partnerId = battlerId ^ 2
  if (partnerId < state.battlersCount) {
    const partner = state.battlers[partnerId]
    if (partner && partner.mon.hp > 0) {
      const partnerHas = (abilityId: string) =>
        battlerHasSimAbility(state, partner, abilityId, true, attackerId ?? -1, attackerHasMoldBreaker, deps.dataContext)

      if (status & (CHECK_INFATUATE | CHECK_RESTRICTING | CHECK_HEAL_BLOCK)) {
        if (partnerHas('ABILITY_AROMA_VEIL')) return 'ABILITY_AROMA_VEIL'
      }
      if (status & CHECK_SLEEP) {
        if (partnerHas('ABILITY_SWEET_VEIL')) return 'ABILITY_SWEET_VEIL'
      }
      if (status & CHECK_STATUS1) {
        if (battler.mon.types.includes('GRASS')) {
          if (partnerHas('ABILITY_FLOWER_VEIL')) return 'ABILITY_FLOWER_VEIL'
          if (partnerHas('ABILITY_JUNGLES_GUARD')) return 'ABILITY_JUNGLES_GUARD'
        }
        if (isBattlerWeatherAffected(state, partnerId, WEATHER_SANDSTORM_ANY, deps)) {
          if (partnerHas('ABILITY_DESERT_CLOAK')) return 'ABILITY_DESERT_CLOAK'
          if (partnerHas('ABILITY_DUNE_VEIL')) return 'ABILITY_DUNE_VEIL'
        }
      }
    }
  }

  return null
}

/**
 * IsStatusImmune, src/battle_util.c:5024-5030.
 * Returns false if not immune, true if immune by terrain/safeguard/status1, or ability string if immune by ability.
 */
export function isStatusImmune(
  state: BattleState,
  battlerId: number,
  status: StatusCheck,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): string | boolean {
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) return true
  if (battler.mon.status1 !== 0) return true
  if (isBattlerTerrainAffected(state, battlerId, STATUS_FIELD_MISTY_TERRAIN, deps)) return true
  const side = battlerId & 1
  if (hasFlag(state.sides[side].statuses, SIDE_STATUS_SAFEGUARD)) return true

  const ability = isAbilityStatusProtected(state, battlerId, status, attackerId, deps)
  if (ability) return ability
  return false
}

/**
 * CanSleep, src/battle_util.c:5032-5039.
 */
export function canSleep(
  state: BattleState,
  battlerId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.mon.status1, STATUS1_ANY)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (isStatusImmune(state, battlerId, CHECK_SLEEP, attackerId, deps)) return false
  if (isBattlerTerrainAffected(state, battlerId, STATUS_FIELD_ELECTRIC_TERRAIN, deps)) return false
  return true
}

/**
 * CanBePoisoned, src/battle_util.c:5042-5050.
 */
export function canBePoisoned(
  state: BattleState,
  attackerId: number,
  targetId: number,
  move: string | null | undefined,
  deps: StatusDeps,
): boolean {
  const target = state.battlers[targetId]
  if (!target) return false
  if (hasFlag(target.mon.status1, STATUS1_ANY)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (isStatusImmune(state, targetId, CHECK_POISON, attackerId, deps)) return false
  if (!canPoisonType(state, attackerId, targetId, move, deps)) return false
  return true
}

/**
 * CanBeBurnedIgnoreTypeImmunity, src/battle_util.c:5052-5059.
 */
export function canBeBurnedIgnoreTypeImmunity(
  state: BattleState,
  battlerId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.mon.status1, STATUS1_ANY)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (isStatusImmune(state, battlerId, CHECK_BURN, attackerId, deps)) return false
  return true
}

/**
 * CanBeBurned, src/battle_util.c:5061-5070.
 */
export function canBeBurned(
  state: BattleState,
  battlerId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.mon.status1, STATUS1_ANY)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (battler.mon.types.includes('FIRE')) return false
  if (isStatusImmune(state, battlerId, CHECK_BURN, attackerId, deps)) return false
  return true
}

/**
 * CanBeParalyzedIgnoreType, src/battle_util.c:5082-5088.
 */
export function canBeParalyzedIgnoreType(
  state: BattleState,
  attackerId: number,
  targetId: number,
  deps: StatusDeps,
): boolean {
  const target = state.battlers[targetId]
  if (!target) return false
  if (hasFlag(target.mon.status1, STATUS1_ANY)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (isStatusImmune(state, targetId, CHECK_PARALYSIS, attackerId, deps)) return false
  return true
}

/**
 * CanBeParalyzed, src/battle_util.c:5072-5080.
 */
export function canBeParalyzed(
  state: BattleState,
  attackerId: number,
  targetId: number,
  deps: StatusDeps,
): boolean {
  const target = state.battlers[targetId]
  if (!target) return false
  if (hasFlag(target.mon.status1, STATUS1_ANY)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (isStatusImmune(state, targetId, CHECK_PARALYSIS, attackerId, deps)) return false
  if (!canParalyzeType(state, attackerId, targetId, deps)) return false
  return true
}

/**
 * CanBeFrozen, src/battle_util.c:5090-5094.
 */
export function canBeFrozen(
  state: BattleState,
  battlerId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  if (isStatusImmune(state, battlerId, CHECK_FROSTBITE, attackerId, deps)) return false
  return true
}

/**
 * CanGetFrostbite, src/battle_util.c:5096-5104.
 */
export function canGetFrostbite(
  state: BattleState,
  battlerId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.mon.status1, STATUS1_ANY)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (!battler.volatiles.iceStatue && battler.mon.types.includes('ICE')) return false
  if (isStatusImmune(state, battlerId, CHECK_FROSTBITE, attackerId, deps)) return false
  return true
}

/**
 * CanBleed, src/battle_util.c:5106-5114.
 */
export function canBleed(
  state: BattleState,
  battlerId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.mon.status1, STATUS1_ANY)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (isStatusImmune(state, battlerId, CHECK_BLEED, attackerId, deps)) return false
  if (battler.mon.types.includes('ROCK') || battler.mon.types.includes('GHOST')) return false
  return true
}

/**
 * CanBeConfused, src/battle_util.c:5116-5123.
 */
export function canBeConfused(
  state: BattleState,
  battlerId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.mon.status2, STATUS2_CONFUSION)) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (isAbilityStatusProtected(state, battlerId, CHECK_CONFUSION, attackerId, deps)) return false
  return true
}

/**
 * CanBeDrenched, src/battle_util.c:5125-5133.
 */
export function canBeDrenched(
  state: BattleState,
  battlerId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (battler.volatiles.drenched > 0) return false
  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (battler.mon.types.includes('WATER')) return false
  if (isAbilityStatusProtected(state, battlerId, CHECK_DRENCH, attackerId, deps)) return false
  return true
}

/**
 * CanInfatuate, src/battle_util.c:5135-5143.
 */
export function canInfatuate(
  state: BattleState,
  attackerId: number,
  targetId: number,
  deps: StatusDeps,
): boolean {
  const target = state.battlers[targetId]
  if (!target) return false
  if (hasFlag(target.mon.status2, STATUS2_INFATUATION)) return false
  if (attackerId === targetId) return false
  const attacker = state.battlers[attackerId]
  if (!attacker || attacker.mon.hp === 0) return false

  if (isMyceliumMightActive(state, attackerId, deps)) return true
  if (isAbilityStatusProtected(state, targetId, CHECK_INFATUATE, attackerId, deps)) return false
  return true
}

/**
 * SetMoveEffect MOVE_EFFECT_DRENCH (src/battle_script_commands.c:3031-3036).
 */
export function applyDrenchEffect(
  state: BattleState,
  targetId: number,
  attackerId: number | null | undefined,
  deps: StatusDeps,
): boolean {
  const target = state.battlers[targetId]
  if (!target || !canBeDrenched(state, targetId, attackerId, deps)) return false
  target.volatiles.drenched = 2 + (state.rng.random16() % 2)
  target.volatiles.started.drenched = true
  return true
}

/**
 * SetMoveEffect MOVE_EFFECT_ATTRACT (src/battle_script_commands.c:2727-2732, battle_util.c:5135-5143).
 */
export function applyAttractEffect(
  state: BattleState,
  attackerId: number,
  targetId: number,
  deps: StatusDeps,
): boolean {
  const target = state.battlers[targetId]
  if (!target || !canInfatuate(state, attackerId, targetId, deps)) return false
  target.mon.status2 = setFlag(target.mon.status2, statusInfatuatedWith(attackerId))
  return true
}

/**
 * SetMoveEffect MOVE_EFFECT_FEAR (src/battle_script_commands.c:2996-3000, battle_scripts_1.s:2444-2458).
 */
export function applyFearEffect(
  state: BattleState,
  targetId: number,
): boolean {
  const target = state.battlers[targetId]
  if (!target) return false
  if (!target.volatiles.fear && !hasFlag(target.statuses4, STATUS4_FEAR)) {
    target.statuses4 = setFlag(target.statuses4, STATUS4_FEAR)
    target.volatiles.fear = true
    target.volatiles.started.fear = true
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// SetMoveEffect Primary Status Path
// ---------------------------------------------------------------------------

/**
 * Port of SetMoveEffect primary status branch.
 * src/battle_script_commands.c:2311-2588, 2657-2664.
 *
 * Top of SetMoveEffect (:2348-2388) checks Shield Dust / Covert Cloak, Safeguard,
 * Sheer Force, dead battler, and Substitute (DoesSubstituteBlockMove).
 *
 * Applies primary status effects (SLEEP, POISON, TOXIC, BURN, PARALYSIS, FROSTBITE, BLEED)
 * and CONFUSION, setting the exact status1/status2 bits, drawing sleep and confusion durations,
 * arming SetOnMoveEffectReactionFlags, and pushing the Synchronize gap when it applies.
 *
 * @returns ApplyStatusResult indicating whether applied and whether MOVE_RESULT_DOESNT_AFFECT_FOE was set.
 */
export function applyPrimaryStatusEffect(
  state: BattleState,
  attackerId: number,
  targetId: number,
  moveEffect: number,
  /** null for an ability script whose gCurrentMove is not threaded through (PoisonPuppeteerClone). */
  moveId: string | null,
  deps: StatusDeps,
  unmodelled?: string[],
  primary: boolean = true,
  certain: boolean = false,
  /** HITMARKER_IGNORE_SAFEGUARD -- set by abilities.cc's AbilityStatusEffect /
   * AbilityStatusEffectSafe (:263-284) before their seteffectsecondary. */
  ignoreSafeguard: boolean = false,
): ApplyStatusResult {
  const affectsUser = hasFlag(moveEffect, MOVE_EFFECT_AFFECTS_USER)
  const effectBattlerId = affectsUser ? attackerId : targetId
  const userBattlerId = affectsUser ? targetId : attackerId
  const ignoreTypeImmunities = hasFlag(moveEffect, MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES)
  const isCertain = certain || hasFlag(moveEffect, MOVE_EFFECT_CERTAIN)
  const baseEffect = moveEffect & ~(MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN)

  const effectBattler = state.battlers[effectBattlerId]
  if (!effectBattler) return { applied: false, doesntAffectFoe: false }

  const attackerBattler = state.battlers[attackerId]

  // Top of SetMoveEffect (src/battle_script_commands.c:2348-2388)
  // 1. Shield Dust / Covert Cloak (:2348-2350)
  if (!ignoreSafeguard && !primary && !affectsUser && isPreventableSecondaryEffect(baseEffect)) {
    const attackerHasMoldBreaker = attackerBattler ? attackerHasMoldBreakerActive(attackerBattler, deps) : false
    const hasShieldDust = battlerHasSimAbility(
      state,
      effectBattler,
      'ABILITY_SHIELD_DUST',
      true,
      attackerId,
      attackerHasMoldBreaker,
      deps.dataContext,
    )
    const hasCovertCloak = deps.grounding.holdEffectOf(effectBattlerId) === 'HOLD_EFFECT_COVERT_CLOAK'
    if (hasShieldDust || hasCovertCloak) {
      return { applied: false, doesntAffectFoe: false }
    }
  }

  // 2. Safeguard (:2352-2354)
  if (!ignoreSafeguard && !primary && baseEffect <= MOVE_EFFECT_CONFUSION) {
    const effectSide = effectBattlerId & 1
    if (hasFlag(state.sides[effectSide].statuses, SIDE_STATUS_SAFEGUARD)) {
      return { applied: false, doesntAffectFoe: false }
    }
  }

  // 3. TestSheerForceFlag (:2361)
  // Evaluated for gBattlerAttacker (attackerId) regardless of primary.
  if (testSheerForceFlag(state, attackerId, moveId, deps)) {
    return { applied: false, doesntAffectFoe: false }
  }

  // 4. Dead battler check (:2364)
  if (effectBattler.mon.hp === 0) {
    return { applied: false, doesntAffectFoe: false }
  }

  // 5. DoesSubstituteBlockMove (:2388, 12252-12260)
  if (!affectsUser && doesSubstituteBlockMove(state, userBattlerId, effectBattlerId, moveId, deps, unmodelled)) {
    return { applied: false, doesntAffectFoe: false }
  }

  let statusChanged = false

  switch (baseEffect) {
    case MOVE_EFFECT_SLEEP: {
      // Check active Uproar unless effect battler has Soundproof (battle_script_commands.c:2395-2400)
      const hasSoundproof = SOUNDPROOF_ABILITIES.some((a) =>
        battlerHasSimAbility(state, effectBattler, a, true, effectBattlerId, false, deps.dataContext),
      )
      if (!hasSoundproof) {
        let uproarActive = false
        // The C loop checks all battlers without hp > 0 filter (:2396-2397)
        for (let i = 0; i < state.battlersCount; i++) {
          const b = state.battlers[i]
          if (b && hasFlag(b.mon.status2, STATUS2_UPROAR)) {
            uproarActive = true
            break
          }
        }
        if (uproarActive) return { applied: false, doesntAffectFoe: false }
      }

      if (!canSleep(state, effectBattlerId, userBattlerId, deps)) break

      cancelMultiTurnMoves(effectBattler)

      // Sleep duration draw: include/constants/battle_config.h:56 defines B_SLEEP_TURNS as GEN_7 (>= GEN_5);
      // src/battle_script_commands.c:2555 draws (Random() % 3) + 2 turns.
      const sleepTurns = (state.rng.random16() % 3) + 2
      effectBattler.mon.status1 = setCounter(effectBattler.mon.status1, STATUS1_SLEEP, sleepTurns)
      statusChanged = true
      break
    }

    case MOVE_EFFECT_POISON: {
      // Ability immunity check (:2408-2421)
      const immune = isStatusImmune(state, effectBattlerId, CHECK_POISON, userBattlerId, deps)
      if (typeof immune === 'string' && (primary || isCertain)) {
        return { applied: false, doesntAffectFoe: false }
      }
      // Note: CanPoisonType with HITMARKER_IGNORE_SAFEGUARD (:2422) never triggers for moves.
      if (!canBePoisoned(state, userBattlerId, effectBattlerId, moveId, deps)) break

      effectBattler.mon.status1 = setFlag(effectBattler.mon.status1, STATUS1_POISON)
      statusChanged = true
      break
    }

    case MOVE_EFFECT_TOXIC: {
      // Ability immunity check (:2511-2524)
      const immune = isStatusImmune(state, effectBattlerId, CHECK_POISON, userBattlerId, deps)
      if (typeof immune === 'string' && (primary || isCertain)) {
        return { applied: false, doesntAffectFoe: false }
      }
      // Note: CanPoisonType with HITMARKER_IGNORE_SAFEGUARD (:2525) never triggers for moves.
      // Toxic fails if target already has any status1 (:2532)
      if (effectBattler.mon.status1 !== 0) break

      if (canBePoisoned(state, userBattlerId, effectBattlerId, moveId, deps)) {
        // Sets STATUS1_TOXIC_POISON and resets STATUS1_TOXIC_COUNTER to 0 (:2535-2536, 2557)
        effectBattler.mon.status1 = setFlag(effectBattler.mon.status1, STATUS1_TOXIC_POISON)
        effectBattler.mon.status1 = setCounter(effectBattler.mon.status1, STATUS1_TOXIC_COUNTER, 0)
        statusChanged = true
        break
      } else {
        // C: gMoveResultFlags |= MOVE_RESULT_DOESNT_AFFECT_FOE (:2540)
        return { applied: false, doesntAffectFoe: true }
      }
    }

    case MOVE_EFFECT_BURN: {
      // Existing status1 check (:2436)
      if (hasFlag(effectBattler.mon.status1, STATUS1_ANY)) break

      // Blocking ability check (:2438-2452)
      const blockingAbility = isAbilityStatusProtected(state, effectBattlerId, CHECK_BURN, userBattlerId, deps)
      if (blockingAbility && (primary || isCertain)) {
        return { applied: false, doesntAffectFoe: false }
      }
      // Note: Fire-type immunity under HITMARKER_IGNORE_SAFEGUARD (:2453) never triggers for moves.
      if (!canBeBurned(state, effectBattlerId, userBattlerId, deps)) break

      effectBattler.mon.status1 = setFlag(effectBattler.mon.status1, STATUS1_BURN)
      statusChanged = true
      break
    }

    case MOVE_EFFECT_PARALYSIS: {
      // Existing status1 check (:2474)
      if (hasFlag(effectBattler.mon.status1, STATUS1_ANY)) break

      // Blocking ability check (:2476-2494)
      const blockingAbility = isAbilityStatusProtected(state, effectBattlerId, CHECK_PARALYSIS, userBattlerId, deps)
      if (blockingAbility) {
        if (primary || isCertain) {
          return { applied: false, doesntAffectFoe: false }
        } else {
          break
        }
      }

      // ignoreTypeImmunities bypasses CanBeParalyzed (:2495-2498)
      if (ignoreTypeImmunities) {
        statusChanged = true
        effectBattler.mon.status1 = setFlag(effectBattler.mon.status1, STATUS1_PARALYSIS)
        break
      }

      // Note: CanParalyzeType under HITMARKER_IGNORE_SAFEGUARD (:2499) never triggers for moves.
      if (!canBeParalyzed(state, userBattlerId, effectBattlerId, deps)) break

      effectBattler.mon.status1 = setFlag(effectBattler.mon.status1, STATUS1_PARALYSIS)
      statusChanged = true
      break
    }

    case MOVE_EFFECT_FREEZE: {
      if (!canBeFrozen(state, effectBattlerId, userBattlerId, deps)) break
      cancelMultiTurnMoves(effectBattler)
      effectBattler.mon.status1 = setFlag(effectBattler.mon.status1, STATUS1_FREEZE)
      statusChanged = true
      break
    }

    case MOVE_EFFECT_FROSTBITE: {
      if (!canGetFrostbite(state, effectBattlerId, userBattlerId, deps)) break
      effectBattler.mon.status1 = setFlag(effectBattler.mon.status1, STATUS1_FROSTBITE)
      statusChanged = true
      break
    }

    case MOVE_EFFECT_BLEED: {
      if (!canBleed(state, effectBattlerId, userBattlerId, deps)) break
      effectBattler.mon.status1 = setFlag(effectBattler.mon.status1, STATUS1_BLEED)
      statusChanged = true
      break
    }

    case MOVE_EFFECT_CONFUSION: {
      // Confusion volatile (src/battle_script_commands.c:2657-2664)
      if (hasFlag(effectBattler.mon.status2, STATUS2_CONFUSION)) {
        return { applied: false, doesntAffectFoe: false }
      }
      if (!canBeConfused(state, effectBattlerId, userBattlerId, deps)) {
        return { applied: false, doesntAffectFoe: false }
      }

      // SetOnMoveEffectReactionFlags (:2659) -- holder is gBattleScripting.battler (userBattlerId)
      setOnMoveEffectReactionFlags(state, userBattlerId, effectBattlerId, MOVE_EFFECT_CONFUSION, deps)

      // Confusion duration draw: (Random() % 2) + 3 turns (src/battle_script_commands.c:2660)
      const confusionTurns = (state.rng.random16() % 2) + 3
      effectBattler.mon.status2 = setCounter(effectBattler.mon.status2, STATUS2_CONFUSION, confusionTurns)
      return { applied: true, doesntAffectFoe: false, status: 'CONFUSION' }
    }

    case MOVE_EFFECT_ENRAGE: {
      // Enrage volatile (src/battle_script_commands.c:3025-3030)
      if (hasFlag(effectBattler.mon.status2, STATUS2_ENRAGED)) {
        return { applied: false, doesntAffectFoe: false }
      }
      effectBattler.mon.status2 = setFlag(effectBattler.mon.status2, STATUS2_ENRAGED)
      const slot = findAbilitySlot(effectBattler.mon.abilities, 'ABILITY_MENTAL_POLLUTION')
      if (slot >= 0) {
        effectBattler.volatiles.abilityState[slot] = 1
      }
      return { applied: true, doesntAffectFoe: false, status: 'ENRAGED' }
    }

    case MOVE_EFFECT_TRI_ATTACK: {
      // Tri Attack effect pick (src/battle_script_commands.c:2698-2706)
      if (effectBattler.mon.status1 === 0) {
        const triEffects = [MOVE_EFFECT_BURN, MOVE_EFFECT_FROSTBITE, MOVE_EFFECT_PARALYSIS]
        const roll = state.rng.random16() % 3
        const pickedEffect = triEffects[roll]
        return applyPrimaryStatusEffect(
          state,
          attackerId,
          targetId,
          pickedEffect,
          moveId,
          deps,
          unmodelled,
          primary,
          certain,
        )
      }
      return { applied: false, doesntAffectFoe: false }
    }

    default:
      return { applied: false, doesntAffectFoe: false }
  }

  if (statusChanged) {
    // Synchronize check (src/battle_script_commands.c:2574-2578).
    // The C unconditionally sets synchronizeMoveEffect for poison, toxic, paralysis and burn;
    // Synchronize's reaction runs later in the move-end ladder.
    if (
      baseEffect === MOVE_EFFECT_POISON ||
      baseEffect === MOVE_EFFECT_TOXIC ||
      baseEffect === MOVE_EFFECT_PARALYSIS ||
      baseEffect === MOVE_EFFECT_BURN
    ) {
      unmodelled?.push('synchronizeMoveEffect')
    }

    // SetOnMoveEffectReactionFlags (src/battle_script_commands.c:2294-2298, 2580). The holder is
    // gBattleScripting.battler: gBattlerAttacker normally, gBattlerTarget for AFFECTS_USER (:2338-2343).
    setOnMoveEffectReactionFlags(state, userBattlerId, effectBattlerId, baseEffect, deps)

    return { applied: true, doesntAffectFoe: false, status: PRIMARY_STATUS_NAMES[baseEffect] }
  }

  return { applied: false, doesntAffectFoe: false }
}

export const PRIMARY_STATUS_NAMES: Record<number, string> = {
  [MOVE_EFFECT_SLEEP]: 'SLEEP',
  [MOVE_EFFECT_POISON]: 'POISON',
  [MOVE_EFFECT_TOXIC]: 'TOXIC',
  [MOVE_EFFECT_BURN]: 'BURN',
  [MOVE_EFFECT_PARALYSIS]: 'PARALYSIS',
  [MOVE_EFFECT_FREEZE]: 'FREEZE',
  [MOVE_EFFECT_FROSTBITE]: 'FROSTBITE',
  [MOVE_EFFECT_BLEED]: 'BLEED',
}

/**
 * All 13 abilities with `hooks.onModifyEffectChance` in data/v2.65beta/abilityHooks.json.
 * Derived using:
 * grep -oP '"onModifyEffectChance":\{[^\}]*\}.*?"id":"(ABILITY_[^"]*)"' data/v2.65beta/abilityHooks.json
 */
export const ON_MODIFY_EFFECT_CHANCE_ABILITIES = [
  'ABILITY_ANGELS_WRATH',
  'ABILITY_BAD_LUCK',
  'ABILITY_CHANDELIER',
  'ABILITY_CORRUPTED_MIND',
  'ABILITY_CRYOMANCY',
  'ABILITY_CRYOSTASIS',
  'ABILITY_LUCKY_WINGS',
  'ABILITY_PRECISE_FIST',
  'ABILITY_PYROMANCY',
  'ABILITY_SERENE_GRACE',
  'ABILITY_SNOWY_WRATH',
  'ABILITY_THERMOMANCY',
  'ABILITY_WAY_OF_PRECISION',
] as const

/**
 * GetMoveEffectChance, src/battle_script_commands.c:3071-3090.
 * Calculates effective move secondary effect chance considering onModifyEffectChance abilities,
 * rainbow timer, and capping at 100.
 */
export function getMoveEffectChance(
  state: BattleState,
  attackerId: number,
  moveId: string | null | undefined,
  moveEffect: number,
  baseChance: number,
  deps: StatusDeps,
  unmodelled?: string[],
): number {
  // battle_script_commands.c:3073:
  // if (moveEffect == MOVE_EFFECT_FLINCH && gTurnStructs[gBattlerAttacker].parentalBondOn < gTurnStructs[gBattlerAttacker].parentalBondInitialCount) return 0;
  // The next guard (:3076) -- FLINCH with baseChance < 100 on isHellMode() + B_SIDE_PLAYER -- has no
  // hell-mode flag in BattleState, so it is not modelled (the sim has no such mode).
  const attacker = state.battlers[attackerId]
  if (
    moveEffect === MOVE_EFFECT_FLINCH &&
    attacker &&
    attacker.turn.parentalBondOn < attacker.turn.parentalBondInitialCount
  ) {
    return 0
  }

  let chance = baseChance

  const moveData = moveId ? deps.dataContext.move(moveId) : null
  const moveType = moveData?.type ?? null
  const isPsychic = moveType === 'PSYCHIC' || moveType === 'TYPE_PSYCHIC'
  const isPunch = moveData?.flags?.punchBased === true
  // ON_ABILITY(abilityBattler, TRUE, ...) (:3082): the attacker's Mold Breaker can break another battler's
  // breakable hook (Bad Luck is breakable).
  const attackerHasMoldBreaker = attacker ? attackerHasMoldBreakerActive(attacker, deps) : false

  for (let i = 0; i < state.battlersCount; i++) {
    const abilityBattlerId = (attackerId + i) % state.battlersCount
    const abilityBattler = state.battlers[abilityBattlerId]
    if (!abilityBattler) continue
    if (i !== 0 && abilityBattler.mon.hp === 0) continue

    // IsApplyOnFlagAppropriate(battler, abilityBattler, gAbilities[ability].onModifyEffectChanceFor).
    // The field defaults to APPLY_ON_SELF (0, include/abilities.hh:142, 236), which is why the 12 other
    // hooks only run for the attacker; Bad Luck sets APPLY_ON_FOE (abilities.cc:4315), so an ally's Bad
    // Luck never applies (same side -> needs APPLY_ON_ALLY, abilities.cc:190-197).
    const isAttacker = abilityBattlerId === attackerId
    const isFoe = (abilityBattlerId & 1) !== (attackerId & 1)

    // ON_ABILITY walks the slots in reverse (include/battle_util.h:269-275: idx 3 -> 0). The order is
    // observable because Corrupted Mind multiplies an int by 1.4 (`*effectChance *= 1.4`, abilities.cc:9469)
    // and Bad Luck zeroes the running value, so the reverse order is reproduced here.
    for (const abilityId of getSlotsInReverse(abilityBattler.mon.abilities)) {
      if (!abilityId) continue
      if (isSimAbilitySuppressed(state, abilityBattler, abilityId, true, attackerId, attackerHasMoldBreaker, deps.dataContext)) {
        continue
      }
      if (isAttacker && (abilityId === 'ABILITY_CORRUPTED_MIND' || abilityId === 'ABILITY_PRECISE_FIST' || abilityId === 'ABILITY_WAY_OF_PRECISION')) {
        unmodelled?.push(`GetMoveEffectChance: ${abilityId} reads GET_MOVE_TYPE / DoesMoveMatchFlag(MOVE_FLAG_PUNCH); this uses the base type and flags.punchBased`)
      }

      if (isAttacker) {
        if (abilityId === 'ABILITY_ANGELS_WRATH') {
          if (moveId === 'MOVE_POISON_STING') chance = 100
        } else if (abilityId === 'ABILITY_CHANDELIER' || abilityId === 'ABILITY_PYROMANCY') {
          if (moveEffect === MOVE_EFFECT_BURN) chance *= 5
        } else if (abilityId === 'ABILITY_CORRUPTED_MIND') {
          if (isPsychic) chance = Math.floor(chance * 1.4)
        } else if (
          abilityId === 'ABILITY_CRYOMANCY' ||
          abilityId === 'ABILITY_CRYOSTASIS' ||
          abilityId === 'ABILITY_SNOWY_WRATH'
        ) {
          if (moveEffect === MOVE_EFFECT_FROSTBITE) chance *= 5
        } else if (abilityId === 'ABILITY_PRECISE_FIST' || abilityId === 'ABILITY_WAY_OF_PRECISION') {
          if (isPunch) chance *= 5
        } else if (abilityId === 'ABILITY_SERENE_GRACE' || abilityId === 'ABILITY_LUCKY_WINGS') {
          chance *= 2
        } else if (abilityId === 'ABILITY_THERMOMANCY') {
          if (moveEffect === MOVE_EFFECT_FROSTBITE || moveEffect === MOVE_EFFECT_BURN) chance *= 5
        }
      }

      if (isFoe) {
        if (abilityId === 'ABILITY_BAD_LUCK') {
          if (chance < 100) chance = 0
        }
      }
    }
  }

  const attackerSide = attackerId & 1
  if (state.sides[attackerSide]?.timers?.rainbowTimer > 0) {
    chance *= 2
  }

  return Math.min(chance, 100)
}
