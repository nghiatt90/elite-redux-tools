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
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  clearFlag,
  hasFlag,
  setCounter,
  setFlag,
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
import { SOUNDPROOF_ABILITIES } from './ai/aiAbilityHelpers'

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
  [MOVE_EFFECT_CONFUSION]: ['ABILITY_ENTRANCE'],
  [MOVE_EFFECT_FROSTBITE]: ['ABILITY_CRYOSTASIS', 'ABILITY_FROSTBIND'],
  [MOVE_EFFECT_POISON]: ['ABILITY_HEMOTOXIN', 'ABILITY_NEUROTOXIN', 'ABILITY_POISON_PUPPETEER'],
  [MOVE_EFFECT_BURN]: ['ABILITY_SET_ABLAZE'],
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
    moveData?.type === 'NORMAL' &&
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
 * DoesMoveMatchFlag(battler, move, moveType, MOVE_FLAG_KEEN_EDGE).
 * Checks move's static sliceBased flag (mapped to keen_edge in codegen/proto),
 * and falls back to onModifyMoveFlags abilities (Chestnut Axe for Grass moves).
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

  if (
    moveData?.type === 'GRASS' &&
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
  if (status & CHECK_SLEEP) {
    if (has('ABILITY_INSOMNIA')) return 'ABILITY_INSOMNIA'
    if (has('ABILITY_VITAL_SPIRIT')) return 'ABILITY_VITAL_SPIRIT'
    if (has('ABILITY_SWEET_VEIL')) return 'ABILITY_SWEET_VEIL'
    if (has('ABILITY_RUDE_AWAKENING')) {
      const slot = findAbilitySlot(battler.mon.abilities, 'ABILITY_RUDE_AWAKENING')
      if (slot !== -1 && (battler.volatiles.abilityState[slot] ?? 0) !== 0) {
        return 'ABILITY_RUDE_AWAKENING'
      }
    }
  }

  if (status & CHECK_BURN) {
    if (has('ABILITY_WATER_VEIL')) return 'ABILITY_WATER_VEIL'
    if (has('ABILITY_PURIFYING_WATERS')) return 'ABILITY_PURIFYING_WATERS'
    if (has('ABILITY_WATER_BUBBLE')) return 'ABILITY_WATER_BUBBLE'
    if (has('ABILITY_FLAME_BUBBLE')) return 'ABILITY_FLAME_BUBBLE'
    if (has('ABILITY_THERMAL_EXCHANGE')) return 'ABILITY_THERMAL_EXCHANGE'
    if (has('ABILITY_THERMAL_ENTROPY')) return 'ABILITY_THERMAL_ENTROPY'
  }

  if (status & CHECK_PARALYSIS) {
    if (has('ABILITY_LIMBER')) return 'ABILITY_LIMBER'
    if (has('ABILITY_JUGGERNAUT')) return 'ABILITY_JUGGERNAUT'
    if (has('ABILITY_SUMO_GUARD')) return 'ABILITY_SUMO_GUARD'
    if (has('ABILITY_IRON_GIANT')) return 'ABILITY_IRON_GIANT'
  }

  if (status & CHECK_FROSTBITE) {
    if (has('ABILITY_MAGMA_ARMOR')) return 'ABILITY_MAGMA_ARMOR'
  }

  if (status & CHECK_BLEED) {
    if (has('ABILITY_BLOOD_BATH')) return 'ABILITY_BLOOD_BATH'
    if (has('ABILITY_BLOODLUST')) return 'ABILITY_BLOODLUST'
  }

  // Immunity blocks non-sleep status1 (src/abilities.cc:713)
  if (status & (CHECK_STATUS1 & ~CHECK_SLEEP)) {
    if (has('ABILITY_IMMUNITY')) return 'ABILITY_IMMUNITY'
  }

  // Full status1 immunities
  if (status & CHECK_STATUS1) {
    if (has('ABILITY_COMATOSE')) return 'ABILITY_COMATOSE'
    if (has('ABILITY_DREAMSCAPE')) return 'ABILITY_DREAMSCAPE'
    if (has('ABILITY_PURIFYING_SALT')) return 'ABILITY_PURIFYING_SALT'
    if (has('ABILITY_BLOOD_STAIN')) return 'ABILITY_BLOOD_STAIN'
    if (has('ABILITY_BLOOD_STIGMA')) return 'ABILITY_BLOOD_STIGMA'
    if (has('ABILITY_HYPER_CLEANSE')) return 'ABILITY_HYPER_CLEANSE'
    if (
      SHIELDS_DOWN_PROTECTED_SPECIES.includes(
        battler.mon.speciesId as (typeof SHIELDS_DOWN_PROTECTED_SPECIES)[number],
      ) &&
      has('ABILITY_SHIELDS_DOWN')
    ) {
      return 'ABILITY_SHIELDS_DOWN'
    }
    if (battler.mon.types.includes('GRASS')) {
      if (has('ABILITY_FLOWER_VEIL')) return 'ABILITY_FLOWER_VEIL'
      if (has('ABILITY_JUNGLES_GUARD')) return 'ABILITY_JUNGLES_GUARD'
    }
    if (isBattlerWeatherAffected(state, battlerId, WEATHER_SANDSTORM_ANY, deps)) {
      if (has('ABILITY_DESERT_CLOAK')) return 'ABILITY_DESERT_CLOAK'
      if (has('ABILITY_DUNE_VEIL')) return 'ABILITY_DUNE_VEIL'
    }
  }

  if (status & CHECK_CONFUSION) {
    if (has('ABILITY_OWN_TEMPO')) return 'ABILITY_OWN_TEMPO'
    if (has('ABILITY_DISCIPLINE')) return 'ABILITY_DISCIPLINE'
  }

  if (status & (CHECK_INFATUATE | CHECK_RESTRICTING)) {
    if (has('ABILITY_OBLIVIOUS')) return 'ABILITY_OBLIVIOUS'
  }

  if (status & (CHECK_INFATUATE | CHECK_RESTRICTING | CHECK_HEAL_BLOCK)) {
    if (has('ABILITY_AROMA_VEIL')) return 'ABILITY_AROMA_VEIL'
  }

  if (status & CHECK_DRENCH) {
    if (has('ABILITY_AMPHIBIOUS')) return 'ABILITY_AMPHIBIOUS'
  }

  if (status & CHECK_FLINCH) {
    if (has('ABILITY_INNER_FOCUS')) return 'ABILITY_INNER_FOCUS'
    if (has('ABILITY_ENLIGHTENED')) return 'ABILITY_ENLIGHTENED'
    if (has('ABILITY_UNLOCKED_POTENTIAL')) return 'ABILITY_UNLOCKED_POTENTIAL'
    if (has('ABILITY_WAY_OF_PRECISION')) return 'ABILITY_WAY_OF_PRECISION'
  }

  if (status & CHECK_REDIRECTION) {
    if (has('ABILITY_PROPELLER_TAIL')) return 'ABILITY_PROPELLER_TAIL'
    if (has('ABILITY_STALWART')) return 'ABILITY_STALWART'
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
 * and pushing unmodelled gaps for Synchronize and SetOnMoveEffectReactionFlags when they apply.
 *
 * @returns ApplyStatusResult indicating whether applied and whether MOVE_RESULT_DOESNT_AFFECT_FOE was set.
 */
export function applyPrimaryStatusEffect(
  state: BattleState,
  attackerId: number,
  targetId: number,
  moveEffect: number,
  moveId: string,
  deps: StatusDeps,
  unmodelled?: string[],
  primary: boolean = true,
  certain: boolean = false,
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
  // Note: HITMARKER_IGNORE_SAFEGUARD is never set for moves.
  if (!primary && !affectsUser && isPreventableSecondaryEffect(baseEffect)) {
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
  // Note: HITMARKER_IGNORE_SAFEGUARD is never set for moves.
  if (!primary && baseEffect <= MOVE_EFFECT_CONFUSION) {
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

      // SetOnMoveEffectReactionFlags (:2659)
      if (attackerBattler) {
        const reactionAbilities = SET_STATE_ON_EFFECT_MAP[MOVE_EFFECT_CONFUSION]
        if (reactionAbilities) {
          for (const ability of reactionAbilities) {
            if (battlerHasSimAbility(state, attackerBattler, ability, false, attackerId, false, deps.dataContext)) {
              unmodelled?.push('SetOnMoveEffectReactionFlags')
              break
            }
          }
        }
      }

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

    // SetOnMoveEffectReactionFlags (src/battle_script_commands.c:2294-2298, 2580)
    if (attackerBattler) {
      const reactionEffect = baseEffect === MOVE_EFFECT_TOXIC ? MOVE_EFFECT_POISON : baseEffect
      const reactionAbilities = SET_STATE_ON_EFFECT_MAP[reactionEffect]
      if (reactionAbilities) {
        for (const ability of reactionAbilities) {
          if (battlerHasSimAbility(state, attackerBattler, ability, false, attackerId, false, deps.dataContext)) {
            unmodelled?.push('SetOnMoveEffectReactionFlags')
            break
          }
        }
      }
    }

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
  let chance = baseChance

  const moveData = moveId ? deps.dataContext.move(moveId) : null
  const moveType = moveData?.type ?? null
  const isPsychic = moveType === 'PSYCHIC' || moveType === 'TYPE_PSYCHIC'
  const isPunch = moveData?.flags?.punchBased === true
  const attacker = state.battlers[attackerId]
  // ON_ABILITY(abilityBattler, TRUE, ...) (:3082): the attacker's Mold Breaker can break another battler's
  // breakable hook (Bad Luck is breakable).
  const attackerHasMoldBreaker = attacker ? attackerHasMoldBreakerActive(attacker, deps) : false

  for (let i = 0; i < state.battlersCount; i++) {
    const abilityBattlerId = (attackerId + i) % state.battlersCount
    const abilityBattler = state.battlers[abilityBattlerId]
    if (!abilityBattler) continue
    if (i !== 0 && abilityBattler.mon.hp === 0) continue

    const isAttacker = abilityBattlerId === attackerId
    const isFoe = (abilityBattlerId & 1) !== (attackerId & 1)

    const abilities = [abilityBattler.mon.abilities.ability, ...abilityBattler.mon.abilities.innates]
    for (const abilityId of abilities) {
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
