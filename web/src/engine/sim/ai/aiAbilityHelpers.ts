// Ability-suppression helpers shared by the AI scorers: IsSuppressed and the
// BattlerHasAbility / IsAbilityOnField reads built on it. A leaf module -- it
// must not import aiScorers or aiCheckBadMove (pinned by aiAbilityHelpers.test.ts).
import type { BattleState, BattlerState } from '../state'
import { hasFlag, STATUS3_GASTRO_ACID, STATUS3_EMBARGO } from '../constants'
import { battlerHasAbility } from '../../abilities/dispatch'
import type { AiDamageDeps } from './aiCalcDamage'

export function getBattlerHoldEffect(battler: BattlerState, deps: AiDamageDeps): string | null {
  return battler.mon.itemId ? (deps.dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null) : null
}

/** Every ability whose `abilityHooks.json` `bitfields.breakable` is TRUE --
 * `IsSuppressed`'s own gate (`battle_util.c:9254-9261`,
 * `checkMoldBreaker && battler != gBattlerAttacker && HITMARKER_MOLD_BREAKER
 * && gAbilities[ability].breakable`). `defAbility` below reads this per
 * ability id, matching `abilities/dispatchCalc.ts`'s own
 * `suppressedByMoldBreaker` treatment of the SAME bitfield for the damage
 * path -- this list exists because `defAbility` checks bare ability ids
 * rather than going through that module's per-registered-ability dispatch,
 * so it needs its own flat lookup rather than reusing `hasFlag`'s registry
 * scan. Pinned to the snapshot by `aiCheckBadMove.test.ts`'s own oracle test.
 *
 * Extraction: `python3 -c "import json; d=json.load(open('data/v2.65beta/
 * abilityHooks.json')); print(sorted(k for k,v in d.items() if
 * v.get('bitfields',{}).get('breakable')))"` -- 196 entries. */
export const MOLD_BREAKABLE_ABILITIES: readonly string[] = [
  'ABILITY_AERIALIST', 'ABILITY_AERODYNAMICS', 'ABILITY_ANGELIC_WINGS', 'ABILITY_ANTICIPATION', 'ABILITY_APPLE_ENLIGHTENMENT',
  'ABILITY_ARCTIC_FUR', 'ABILITY_ARMOR_TAIL', 'ABILITY_AROMA_VEIL', 'ABILITY_ATLANTIC_RULER', 'ABILITY_AURA_BREAK',
  'ABILITY_BAD_LUCK', 'ABILITY_BAD_OMEN', 'ABILITY_BASS_BOOSTED', 'ABILITY_BATTLE_ARMOR', 'ABILITY_BLIGHT_SCALE',
  'ABILITY_BLOODLUST', 'ABILITY_BLOOD_BATH', 'ABILITY_BRAIN_MASS', 'ABILITY_BREAKWATER', 'ABILITY_BULLETPROOF',
  'ABILITY_CHESTNUT_SHIELD', 'ABILITY_CHRISTMAS_SPIRIT', 'ABILITY_CHROME_COAT', 'ABILITY_CLEAR_BODY', 'ABILITY_CONJOURER_OF_DECEIT',
  'ABILITY_CONTRARY', 'ABILITY_CRUST_COAT', 'ABILITY_CRYSTALLINE_ARMOR', 'ABILITY_DAZZLING', 'ABILITY_DEEP_FREEZE',
  'ABILITY_DESERT_CLOAK', 'ABILITY_DISCIPLINE', 'ABILITY_DISGUISE', 'ABILITY_DRAGONFLY', 'ABILITY_DRAGONSLAYER',
  'ABILITY_DREAM_STATE', 'ABILITY_DROIDEKA', 'ABILITY_DRY_SKIN', 'ABILITY_DUNE_TERROR', 'ABILITY_DUNE_VEIL', 'ABILITY_EARTH_EATER',
  'ABILITY_EFFECT_SPORE', 'ABILITY_EMPRESS', 'ABILITY_ENLIGHTENED', 'ABILITY_EVAPORATE', 'ABILITY_FAE_HUNTER',
  'ABILITY_FARADAY_CAGE', 'ABILITY_FEATHERCOAT', 'ABILITY_FEY_FLIGHT', 'ABILITY_FILTER', 'ABILITY_FIREFIGHTER',
  'ABILITY_FIRE_ASPECT', 'ABILITY_FIRE_RULER', 'ABILITY_FIRE_SCALES', 'ABILITY_FLAME_BUBBLE', 'ABILITY_FLAME_SHIELD',
  'ABILITY_FLASH_FIRE', 'ABILITY_FLOWER_GIFT', 'ABILITY_FLOWER_VEIL', 'ABILITY_FLUFFIEST', 'ABILITY_FLUFFY', 'ABILITY_FOOD_LOVERS',
  'ABILITY_FORTRESS', 'ABILITY_FOSSILIZED', 'ABILITY_FRIEND_GUARD', 'ABILITY_FUR_COAT', 'ABILITY_GALLANTRY', 'ABILITY_GIFTED_MIND',
  'ABILITY_GLACIAL_GHOST', 'ABILITY_GOOD_AS_GOLD', 'ABILITY_GUARDIAN_COAT', 'ABILITY_GUARD_DOG', 'ABILITY_HASTE_MAKES_WASTE',
  'ABILITY_HEADSTRONG', 'ABILITY_HEATPROOF', 'ABILITY_HEAT_SINK', 'ABILITY_HEAVY_METAL', 'ABILITY_HOVER', 'ABILITY_HUGE_WINGS',
  'ABILITY_HYPER_CLEANSE', 'ABILITY_HYPER_CUTTER', 'ABILITY_ICE_DEW', 'ABILITY_ICE_FACE', 'ABILITY_ICE_PLUMES',
  'ABILITY_ICE_SCALES', 'ABILITY_IMMUNITY', 'ABILITY_INNER_FOCUS', 'ABILITY_INSOMNIA', 'ABILITY_IRON_GIANT', 'ABILITY_JUGGERNAUT',
  'ABILITY_JUNGLES_GUARD', 'ABILITY_KEEN_EYE', 'ABILITY_LEAD_COAT', 'ABILITY_LEPIDOPTERAN', 'ABILITY_LEVITATE',
  'ABILITY_LIGHTNING_ASPECT', 'ABILITY_LIGHTNING_ROD', 'ABILITY_LIMBER', 'ABILITY_LIQUIFIED', 'ABILITY_LUCHA_LIBRE',
  'ABILITY_LUMBERJACK', 'ABILITY_MAGIC_BOUNCE', 'ABILITY_MAGMA_ARMOR', 'ABILITY_MASSIVE_PELT', 'ABILITY_MINDS_EYE',
  'ABILITY_MIRROR_ARMOR', 'ABILITY_MOLTEN_CORE', 'ABILITY_MONSTER_HUNTER', 'ABILITY_MOTOR_DRIVE', 'ABILITY_MOUNTAINEER',
  'ABILITY_MUCUS_MEMBRANE', 'ABILITY_MULTISCALE', 'ABILITY_NIHIL_BLASTER', 'ABILITY_NOCTURNAL', 'ABILITY_NOISE_CANCEL',
  'ABILITY_OBLIVIOUS', 'ABILITY_OLD_MARINER', 'ABILITY_OVERCOAT', 'ABILITY_OWN_TEMPO', 'ABILITY_PARROTING', 'ABILITY_PATCHWORK',
  'ABILITY_PERMAFROST', 'ABILITY_PERMAFROST_CLONE', 'ABILITY_POISON_ABSORB', 'ABILITY_POLLINATE', 'ABILITY_PRIMAL_ARMOR',
  'ABILITY_PRISM_SCALES', 'ABILITY_PUFFY', 'ABILITY_PUNK_ROCK', 'ABILITY_PURIFYING_SALT', 'ABILITY_PURIFYING_WATERS',
  'ABILITY_QUEENLY_MAJESTY', 'ABILITY_RADIANCE', 'ABILITY_RAINBOW_SCALES', 'ABILITY_RAIN_SHROUD', 'ABILITY_RAW_WOOD',
  'ABILITY_RELIC_STONE', 'ABILITY_RESERVOIR', 'ABILITY_RIVALRY', 'ABILITY_ROCK_HEAD', 'ABILITY_ROYAL_DECREE', 'ABILITY_SAND_FIEND',
  'ABILITY_SAND_GUARD', 'ABILITY_SAND_VEIL', 'ABILITY_SAP_SIPPER', 'ABILITY_SEAWEED', 'ABILITY_SEPIA_LENS', 'ABILITY_SHATTERED_ARMOR',
  'ABILITY_SHELL_ARMOR', 'ABILITY_SHIELD_DUST', 'ABILITY_SLIME_MOLD', 'ABILITY_SLUDGY_MIX', 'ABILITY_SMOKEY_MANEUVERS',
  'ABILITY_SMOLDERING_WOOD', 'ABILITY_SNOW_CLOAK', 'ABILITY_SOLID_ROCK', 'ABILITY_SOOTHSAYER', 'ABILITY_SOUL_HARVEST',
  'ABILITY_SOUNDPROOF', 'ABILITY_STAINLESS_STEEL', 'ABILITY_STALL', 'ABILITY_STEELWORKER', 'ABILITY_STEEL_BEETLE',
  'ABILITY_STICKY_HOLD', 'ABILITY_STONECUTTER', 'ABILITY_STORM_DRAIN', 'ABILITY_STURDY', 'ABILITY_SUCTION_CUPS',
  'ABILITY_SUMO_GUARD', 'ABILITY_SUN_BASKING', 'ABILITY_SUPERSWEET_SYRUP', 'ABILITY_SURVIVOR_BIAS', 'ABILITY_SWEET_VEIL',
  'ABILITY_TELEPATHY', 'ABILITY_TERAFORM_ZERO', 'ABILITY_TERASTAL_TREASURE', 'ABILITY_TERA_SHELL', 'ABILITY_THERMAL_ENTROPY',
  'ABILITY_THERMAL_EXCHANGE', 'ABILITY_THICK_FAT', 'ABILITY_TOXIC_SHELL', 'ABILITY_TUMMYACHE', 'ABILITY_UNAWARE',
  'ABILITY_VITAL_SPIRIT', 'ABILITY_VOLTRON', 'ABILITY_VOLT_ABSORB', 'ABILITY_WATER_ABSORB', 'ABILITY_WATER_BUBBLE',
  'ABILITY_WATER_COMPACTION', 'ABILITY_WATER_VEIL', 'ABILITY_WAY_OF_PRECISION', 'ABILITY_WEATHER_CONTROL', 'ABILITY_WELL_BAKED_BODY',
  'ABILITY_WIND_RIDER', 'ABILITY_WITCH_BROOM', 'ABILITY_WONDER_GUARD',
]
const MOLD_BREAKABLE_SET = new Set(MOLD_BREAKABLE_ABILITIES)

/** Every `abilityHooks.json` ability with `bitfields.isSoundproof` (IsSoundproof's
 * `gAbilities[ability].isSoundproof`); both have `onImmuneFor` unset. Pinned by an oracle test. */
export const SOUNDPROOF_ABILITIES: readonly string[] = ['ABILITY_NOISE_CANCEL', 'ABILITY_SOUNDPROOF']

/** Every ability whose `abilityHooks.json` `bitfields.unsuppressable` is TRUE --
 * `IsUnsuppressableAbility`, battle_util.c:4788 (`gAbilities[ability].
 * unsuppressable`). Gates the Gastro Acid / Neutralizing Gas half of
 * `isSuppressed`. Pinned to the snapshot by `aiCheckBadMove.test.ts`'s oracle test.
 *
 * Extraction: `python3 -c "import json; d=json.load(open('data/v2.65beta/
 * abilityHooks.json')); print(sorted(k for k,v in d.items() if
 * v.get('bitfields',{}).get('unsuppressable')))"` -- 32 entries. */
export const UNSUPPRESSABLE_ABILITIES: readonly string[] = [
  'ABILITY_AS_ONE_ICE_RIDER', 'ABILITY_AS_ONE_SHADOW_RIDER', 'ABILITY_BATTLE_BOND', 'ABILITY_BLOOD_STAIN', 'ABILITY_BLOOD_STIGMA',
  'ABILITY_CLUELESS', 'ABILITY_COMATOSE', 'ABILITY_COMMANDER', 'ABILITY_CROWNED_KING', 'ABILITY_DISGUISE', 'ABILITY_DNA_SCRAMBLE',
  'ABILITY_DREAMSCAPE', 'ABILITY_DUAL_SHADOW', 'ABILITY_FLAMMABLE_COAT', 'ABILITY_FLOWER_GIFT', 'ABILITY_FORECAST',
  'ABILITY_GULP_MISSILE', 'ABILITY_HUNGER_SWITCH', 'ABILITY_ICE_FACE', 'ABILITY_LOCUST_SWARM', 'ABILITY_MULTITYPE',
  'ABILITY_NEUTRALIZING_GAS', 'ABILITY_PATCHWORK', 'ABILITY_POWER_CONSTRUCT', 'ABILITY_REVELATION', 'ABILITY_RKS_SYSTEM',
  'ABILITY_SCHOOLING', 'ABILITY_SHIELDS_DOWN', 'ABILITY_STALWART', 'ABILITY_STANCE_CHANGE', 'ABILITY_ZEN_MODE', 'ABILITY_ZERO_TO_HERO',
]
const UNSUPPRESSABLE_SET = new Set(UNSUPPRESSABLE_ABILITIES)

/** IsSuppressed, battle_util.c:9254-9261:
 *
 *   if ((checkMoldBreaker && battler != gBattlerAttacker && gHitMarker & HITMARKER_MOLD_BREAKER && gAbilities[ability].breakable) ||
 *       ((gFieldTimers.neutralizingGas || gStatuses3[battler] & STATUS3_GASTRO_ACID) && !IsUnsuppressableAbility(ability)))
 *     return !DoesBattlerHaveAbilityShield(battler);
 *   return FALSE;
 *
 * Mold Breaker half: `gHitMarker & HITMARKER_MOLD_BREAKER` is the stale marker
 * of the last SetMoldBreaker call (no AI code sets it), modelled as the
 * `attackerHasMoldBreaker` the AI deps already carry. `battler != gBattlerAttacker`
 * is not modelled (gBattlerAttacker is not written anywhere in the AI's own
 * sources): callers that mean a defender pass `checkMoldBreaker` TRUE, every
 * other read passes FALSE. */
export function isSuppressed(
  state: BattleState,
  battler: BattlerState,
  abilityId: string,
  checkMoldBreaker: boolean,
  attackerHasMoldBreaker: boolean,
  deps: AiDamageDeps,
): boolean {
  if (
    (checkMoldBreaker && attackerHasMoldBreaker && MOLD_BREAKABLE_SET.has(abilityId)) ||
    ((state.field.timers.neutralizingGas || hasFlag(battler.statuses3, STATUS3_GASTRO_ACID)) && !UNSUPPRESSABLE_SET.has(abilityId))
  ) {
    return !doesBattlerHaveAbilityShield(battler, deps)
  }
  return false
}

/** `BattlerHasAbility(battler, ABILITY_X, TRUE)` -- `BATTLER_HAS_ABILITY`.
 * Mold Breaker suppresses only `breakable` abilities, and Gastro Acid /
 * Neutralizing Gas suppress every non-`unsuppressable` one (`isSuppressed`). */
export function defAbility(state: BattleState, deps: AiDamageDeps, battler: BattlerState, abilityId: string, attackerHasMoldBreaker: boolean): boolean {
  return battlerHasAbility(battler.mon.abilities, abilityId, (id) => isSuppressed(state, battler, id, true, attackerHasMoldBreaker, deps))
}
/** `BattlerHasAbility(battler, ABILITY_X, FALSE)` or a self-check -- no Mold
 * Breaker, but Gastro Acid / Neutralizing Gas still suppress. */
export function selfAbility(state: BattleState, deps: AiDamageDeps, battler: BattlerState, abilityId: string): boolean {
  return battlerHasAbility(battler.mon.abilities, abilityId, (id) => isSuppressed(state, battler, id, false, false, deps))
}

/** IsAbilityOnField, battle_util.c:4803-4811 -- copied rather than imported
 * because fieldEndTurn.ts's own copy is module-private. The C reads
 * `BattlerHasAbility(i, ability, TRUE)`, i.e. checkMoldBreaker TRUE; this copy
 * keeps that copy's own choice of never applying Mold Breaker (no single
 * "attacker" for a field-wide scan) and applies Gastro Acid / Neutralizing Gas. */
export function isAbilityOnField(state: BattleState, deps: AiDamageDeps, abilityId: string): boolean {
  for (let i = 0; i < state.battlersCount; i++) {
    const battler = state.battlers[i]
    if (battler && battler.mon.hp !== 0 && selfAbility(state, deps, battler, abilityId)) return true
  }
  return false
}

/** DoesBattlerHaveAbilityShield, battle_util.c:6539-6545. The
 * `blocksAbilitySuppression` bitfield scan is real (not hardcoded false) but
 * the current abilityHooks.json snapshot has zero abilities carrying it, so
 * this loop never actually fires on this data -- see this module's header. */
const BLOCKS_ABILITY_SUPPRESSION_ABILITIES: readonly string[] = []
export function doesBattlerHaveAbilityShield(battler: BattlerState, deps: AiDamageDeps): boolean {
  const abilitySlots = [battler.mon.abilities.ability, ...battler.mon.abilities.innates].filter((x): x is string => !!x)
  if (abilitySlots.some((id) => BLOCKS_ABILITY_SUPPRESSION_ABILITIES.includes(id))) return true
  if (getBattlerHoldEffect(battler, deps) !== 'HOLD_EFFECT_ABILITY_SHIELD') return false
  return !hasFlag(battler.statuses3, STATUS3_EMBARGO)
}
