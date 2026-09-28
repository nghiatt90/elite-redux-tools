// AI_CheckBadMove, battle_ai_main.c:488-1298 -- PART 1 ONLY, through the
// EFFECT_PERISH_SONG case. Part 2 (:1299 EFFECT_SANDSTORM onward) is the next
// batch; PART2_EFFECTS below names every case label that lives there so a
// move whose effect falls in that set gets one gap line instead of silence.
//
// This batch is singles-only (this project's own scope, CLAUDE.md). Every
// `if (isDoubleBattle) { ... }` block in the C (the def-partner-ability
// checks at :674-706, and the doubles halves of EFFECT_ROTOTILLER,
// EFFECT_GEAR_UP, EFFECT_MAGNETIC_FLUX, EFFECT_HAZE, EFFECT_PERISH_SONG) is
// DEAD CODE here, not a gap: `isValidDoubleBattle` below is always false on
// this build (battleTypeFlags never carries BATTLE_TYPE_DOUBLE -- grepped,
// no writer anywhere in web/src/engine/sim), matching aiPipeline.ts's own
// "ChooseMoveOrAction_Doubles is not ported" scope note. Likewise every
// `PartnerHasSameMoveEffectWithoutTarget` / `DoesPartnerHaveSameMoveEffect` /
// `PartnerMoveIsSameNoTarget` call is transcribed in full (cheap, and matches
// aiScorers.ts's isTargetingPartner precedent for "port the general form
// rather than special-case singles at every call site") but each starts with
// `if (!IsDoubleBattle()) return FALSE;` in the C, so every one of them
// always returns false here.
//
// FIX PASS (post-review, cycle16): three findings from the first review
// pass are corrected here rather than left as approximations --
//   1. `PART2_EFFECTS` was hand-typed and covered barely a third of the
//      real :1299-2163 case labels, with several entries that never matched
//      any real effect name at all. Replaced with the full, mechanically
//      extracted 147-label set (see PART2_EFFECTS's own doc for the exact
//      extraction command), pinned by an oracle test.
//   2. Mold Breaker's `defAbility` used to suppress EVERY `checkMoldBreaker=
//      TRUE` ability check uniformly. It now reads the real per-ability
//      `breakable` bitfield (`MOLD_BREAKABLE_ABILITIES`, extracted from
//      abilityHooks.json the same way), matching `IsSuppressed`'s actual gate
//      and `abilities/dispatchCalc.ts`'s own `suppressedByMoldBreaker`
//      treatment of the same field for the damage path.
//   3. The three `RETURN_ABILITY_IF_FLAG`/`ON_ABILITY` scans (onStatLowered,
//      suctionCups, alwaysSleeping) that were narrowed to one hardcoded
//      ability now check the FULL ability list for that hook flag
//      (`ON_STAT_LOWERED_ABILITIES`, `SUCTION_CUPS_ABILITIES`,
//      `ALWAYS_SLEEPING_ABILITIES`), each pinned by its own oracle test.
//
// Remaining approximations (see each site's own inline note for why):
//   - `gBattleMoves[move].type` (the move's OWN declared type from
//     moves.json) stands in for `GET_MOVE_TYPE`'s dynamically-resolved type.
//     Reported as a gap only for the handful of moves whose type is
//     genuinely variable (Hidden Power, Weather Ball, Natural Gift,
//     Revelation Dance, and Judgment/Techno Blast/Multi-Attack under their
//     real shared effect name `EFFECT_CHANGE_TYPE_ON_ITEM` -- see
//     VARIABLE_TYPE_EFFECTS's own doc) since every other move's declared and
//     resolved type are the same value.
//   - `IsStatDropBlocked` has no port anywhere in this codebase (confirmed:
//     accuracy.ts's own header makes the same admission for its ACC case) --
//     always false, gapped by name whenever `shouldLowerStat` is evaluated.
//   - Anticipation's `GetSingleUseAbilityCounter` has no state anywhere in
//     this codebase either (turn.ts's own admission, word for word) -- the
//     whole Anticipation check is gapped by name whenever battlerDef holds
//     the ability.

import type { BattleState, BattlerState } from '../state'
import {
  hasFlag,
  STAT_ATK,
  NUM_BATTLE_STATS,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STATUS1_SLEEP,
  STATUS1_POISON_ANY,
  STATUS1_ANY,
  STATUS1_FREEZE,
  STATUS2_SUBSTITUTE,
  STATUS2_NIGHTMARE,
  STATUS2_CURSED,
  STATUS2_CONFUSION,
  STATUS2_WRAPPED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_RECHARGE,
  STATUS3_LEECHSEED,
  STATUS3_PERISH_SONG,
  STATUS3_ON_AIR,
  STATUS3_UNDERGROUND,
  STATUS3_UNDERWATER,
  STATUS3_PHANTOM_FORCE,
  STATUS3_ROOTED,
  STATUS3_CHARGED_UP,
  STATUS4_COMMANDED,
  STATUS4_FORESIGHT,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_MIST,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_FAIRY_LOCK,
  WEATHER_PRIMAL_ANY,
  WEATHER_SUN_ANY,
  WEATHER_SUN_PRIMAL,
  WEATHER_RAIN_PRIMAL,
  WEATHER_HAIL_ANY,
  WEATHER_FOG_ANY,
} from '../constants'
import { battlerHasAbility } from '../../abilities/dispatch'
import { computeIsAbsorbed, computeIsImmune } from '../../abilities/dispatchCalc'
import { isMagicGuardProtected } from '../endTurn'
import { weatherHasEffect } from '../fieldEndTurn'
import { getWhoStrikesFirst } from '../turnOrder'
import { buildFieldFacts } from '../bridge'
import { aiGetMoveEffectiveness, getHealthPercentage, isTargetingPartner } from './aiScorers'
import { isAbilityPreventingEscape, countUsablePartyMons } from './aiPipeline'
import type { AiDamageDeps } from './aiCalcDamage'
import { AI_FLAG_WILL_SUICIDE } from './aiFlags'

type Result = { score: number; unmodelled: string[] }

// ---------------------------------------------------------------------------
// Small battler-id arithmetic -- BATTLE_PARTNER/FOE macros, constants/battle.h:37
// and include/battle_ai_util.h:10. Ported in full (not special-cased to
// singles) for the same reason isTargetingPartner is: cheap, and every other
// port in this file already needs to call them at all four sites the C does.
// ---------------------------------------------------------------------------
function battlePartner(battlerId: number): number {
  return battlerId ^ 2
}
function foeOf(battlerId: number): number {
  return battlerId ^ 1
}

/** IsValidDoubleBattle, battle_ai_util.c:2270-2280 -- always false on this
 * build (see this module's header). Ported as a real (if unreachable) check
 * rather than a hardcoded `false` so a future doubles batch has a single
 * place to fix. */
function isValidDoubleBattle(_state: BattleState, _battlerAtk: number): boolean {
  return false
}

function hasMoveFlag(move: ReturnType<AiDamageDeps['moveData']>, flag: string): boolean {
  return !!move?.flags?.[flag]
}

/** `moveTarget & MOVE_TARGET_USER` -- moves.json's own `target` enum spells
 * this bare 'USER' (dataContext.ts's own SimMoveData.target doc). */
function moveTargetsUser(move: ReturnType<AiDamageDeps['moveData']>): boolean {
  return move?.target === 'USER'
}

function isBattlerOfType(battler: BattlerState, type: string): boolean {
  return battler.mon.types.includes(type)
}

function getBattlerHoldEffect(battler: BattlerState, deps: AiDamageDeps): string | null {
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

/** `BattlerHasAbility(battlerDef, ABILITY_X, TRUE)` -- suppressed by Mold
 * Breaker only when the checked ability is actually `breakable`
 * (`MOLD_BREAKABLE_ABILITIES` above), matching `IsSuppressed`'s real gate
 * instead of the uniform "Mold Breaker bypasses every checkMoldBreaker=TRUE
 * read" approximation an earlier revision of this file used. */
function defAbility(battler: BattlerState, abilityId: string, attackerHasMoldBreaker: boolean): boolean {
  const suppressed = attackerHasMoldBreaker && MOLD_BREAKABLE_SET.has(abilityId)
  return battlerHasAbility(battler.mon.abilities, abilityId, () => suppressed)
}
/** `BattlerHasAbility(battler, ABILITY_X, FALSE)` or a self-check -- never
 * suppressed (see this module's header). */
function selfAbility(battler: BattlerState, abilityId: string): boolean {
  return battlerHasAbility(battler.mon.abilities, abilityId, () => false)
}

/** IsAbilityOnField, battle_util.c:4803-4811 -- copied rather than imported
 * because fieldEndTurn.ts's own copy is module-private. Mold Breaker is
 * never applied here, matching that copy's own note: there is no single
 * "attacker" for a field-wide scan. */
function isAbilityOnField(state: BattleState, abilityId: string): boolean {
  for (let i = 0; i < state.battlersCount; i++) {
    const battler = state.battlers[i]
    if (battler && battler.mon.hp !== 0 && selfAbility(battler, abilityId)) return true
  }
  return false
}

/** `IsBattlerWeatherAffected(b, W)` for a non-sun/rain flag (the Utility
 * Umbrella exemption only applies to WEATHER_SUN_ANY/WEATHER_RAIN_ANY, per
 * fieldEndTurn.ts's own VARIOUS_DO_FOG_STAT_DROPS note) -- `hasFlag(weather,
 * W) && weatherHasEffect`. */
function isBattlerWeatherAffected(state: BattleState, weatherFlag: number, deps: AiDamageDeps): boolean {
  return hasFlag(state.field.weather, weatherFlag) && weatherHasEffect(state, deps.grounding)
}

/** GetMoveDynamicType, approximated as the move's own declared type -- see
 * this module's header for the variable-type-move gap. Verified against
 * data/v2.65beta/moves.json's real `effect` values (an earlier revision of
 * this set used 'EFFECT_JUDGMENT'/'EFFECT_TECHNO_BLAST'/'EFFECT_MULTI_ATTACK',
 * none of which any move in this snapshot actually carries -- MOVE_JUDGMENT,
 * MOVE_TECHNO_BLAST and MOVE_MULTI_ATTACK all share the real effect
 * `EFFECT_CHANGE_TYPE_ON_ITEM` instead, which is what changes their type by
 * held Plate/Drive/Memory). `EFFECT_CHANGE_TYPE_ON_ITEM` is not a case label
 * anywhere in AI_CheckBadMove's switch (grepped against the same extraction
 * this module's PART2_EFFECTS doc cites), so it correctly falls to the
 * default damage path in both part 1 and part 2 -- it only needs to be here,
 * for the pre-switch ladder's own `resolvedType` reads. */
const VARIABLE_TYPE_EFFECTS = new Set(['EFFECT_HIDDEN_POWER', 'EFFECT_WEATHER_BALL', 'EFFECT_NATURAL_GIFT', 'EFFECT_REVELATION_DANCE', 'EFFECT_CHANGE_TYPE_ON_ITEM'])
function moveType(moveId: string, deps: AiDamageDeps, unmodelled: string[]): string | null {
  const move = deps.moveData(moveId)
  if (move?.effect && VARIABLE_TYPE_EFFECTS.has(move.effect)) {
    unmodelled.push(`AI_CheckBadMove: ${moveId} (${move.effect}) has a variable type; scored using its declared type (${move.type ?? 'null'}) rather than GetMoveDynamicType's resolved one`)
  }
  return move?.type ?? null
}

/** IsSemiInvulnerable, battle_ai_util.c:1140-1150. */
function isSemiInvulnerable(defender: BattlerState, move: ReturnType<AiDamageDeps['moveData']>): boolean {
  if (hasFlag(defender.statuses3, STATUS3_PHANTOM_FORCE)) return true
  if (!(move?.hitsAir === 'HITS' || move?.hitsAir === 'DOUBLE_DAMAGE') && hasFlag(defender.statuses3, STATUS3_ON_AIR)) return true
  if (!hasMoveFlag(move, 'hitsUnderwater') && hasFlag(defender.statuses3, STATUS3_UNDERWATER)) return true
  if (!hasMoveFlag(move, 'hitsUnderground') && hasFlag(defender.statuses3, STATUS3_UNDERGROUND)) return true
  return false
}

/** IsPowderImmune, battle_util.c:3190-3204 -- Grass-type or Overcoat holder
 * is immune; Safety Goggles is a held-item exemption this port also checks
 * via resolvedHoldEffect. checkMoldBreaker is threaded through for the
 * Overcoat read (the only ability half of this check). */
function isPowderImmune(defender: BattlerState, attackerHasMoldBreaker: boolean, deps: AiDamageDeps): boolean {
  if (isBattlerOfType(defender, 'GRASS')) return true
  if (defAbility(defender, 'ABILITY_OVERCOAT', attackerHasMoldBreaker)) return true
  if (getBattlerHoldEffect(defender, deps) === 'HOLD_EFFECT_SAFETY_GOGGLES') return true
  return false
}

/** IsAromaVeilProtectedMove, battle_ai_util.c:1056-1067. */
function isAromaVeilProtectedMove(moveId: string): boolean {
  return ['MOVE_DISABLE', 'MOVE_ATTRACT', 'MOVE_ENCORE', 'MOVE_TORMENT', 'MOVE_TAUNT', 'MOVE_HEAL_BLOCK'].includes(moveId)
}

/** IsNonVolatileStatusMoveEffect, battle_ai_util.c:1070-1082. */
const NON_VOLATILE_STATUS_EFFECTS = new Set(['EFFECT_SLEEP', 'EFFECT_TOXIC', 'EFFECT_POISON', 'EFFECT_PARALYZE', 'EFFECT_WILL_O_WISP', 'EFFECT_YAWN'])
function isNonVolatileStatusMoveEffect(effect: string | null): boolean {
  return !!effect && NON_VOLATILE_STATUS_EFFECTS.has(effect)
}

/** IsStatLoweringMoveEffect, battle_ai_util.c:1096-1116. */
const STAT_LOWERING_EFFECTS = new Set([
  'EFFECT_ATTACK_DOWN', 'EFFECT_DEFENSE_DOWN', 'EFFECT_SPEED_DOWN', 'EFFECT_SPECIAL_ATTACK_DOWN', 'EFFECT_SPECIAL_DEFENSE_DOWN',
  'EFFECT_ACCURACY_DOWN', 'EFFECT_EVASION_DOWN', 'EFFECT_ATTACK_DOWN_2', 'EFFECT_DEFENSE_DOWN_2', 'EFFECT_SPEED_DOWN_2',
  'EFFECT_SPECIAL_ATTACK_DOWN_2', 'EFFECT_SPECIAL_DEFENSE_DOWN_2', 'EFFECT_ACCURACY_DOWN_2', 'EFFECT_EVASION_DOWN_2',
])
function isStatLoweringMoveEffect(effect: string | null): boolean {
  return !!effect && STAT_LOWERING_EFFECTS.has(effect)
}

/** DoesBattlerIgnoreAbilityChecks, battle_ai_util.c:1046-1051 --
 * `DoesBattlerHaveAbilityShield` (an Ability Shield hold-effect check) is not
 * wired; approximated as absent (the common case). `battler === battlerDef`
 * (self-targeting) always returns false, matching the C. */
function doesBattlerIgnoreAbilityChecks(battlerAtk: number, battlerDef: number, deps: AiDamageDeps): boolean {
  if (battlerAtk === battlerDef) return false
  return deps.grounding.attackerHasMoldBreaker
}

/** DoesBattlerIgnoreAbilityorInnateChecks, battle_util.c:8655 --
 * `SetMoldBreaker(battler, MOVE_NONE)` for battlerAtk itself, which is what
 * both of this batch's call sites (:535, :539) pass. */
function doesBattlerIgnoreAbilityOrInnateChecks(deps: AiDamageDeps): boolean {
  return deps.grounding.attackerHasMoldBreaker
}

/** BattlerStatCanRise, battle_ai_util.c:1293-1303. `battler` here is always
 * battlerAtk checking its OWN ability (never suppressed by its own Mold
 * Breaker -- see this module's header). */
function battlerStatCanRise(state: BattleState, battler: BattlerState, stat: number, deps: AiDamageDeps): boolean {
  if (isBattlerWeatherAffected(state, WEATHER_FOG_ANY, deps) && (battler.volatiles.trickOrTreat || !(isBattlerOfType(battler, 'GHOST') || isBattlerOfType(battler, 'PSYCHIC')))) {
    return false
  }
  if (selfAbility(battler, 'ABILITY_CONTRARY')) return battler.mon.statStages[stat] > MIN_STAT_STAGE
  return battler.mon.statStages[stat] < MAX_STAT_STAGE
}

/** Every ability whose `abilityHooks.json` `hooks.onStatLowered` is present --
 * `RETURN_ABILITY_IF_FLAG(battlerDef, FALSE, onStatLowered)`'s real flag
 * scan. `FALSE` is the macro's `checkMoldBreaker` argument, so this is NEVER
 * suppressed by Mold Breaker (unlike `SUCTION_CUPS_ABILITIES` below, whose
 * own C call passes `TRUE`). Pinned to the snapshot by
 * `aiCheckBadMove.test.ts`'s own oracle test.
 *
 * Extraction: `python3 -c "import json; d=json.load(open('data/v2.65beta/
 * abilityHooks.json')); print(sorted(k for k,v in d.items() if
 * 'onStatLowered' in v.get('hooks',{})))"` -- 11 entries. */
export const ON_STAT_LOWERED_ABILITIES: readonly string[] = [
  'ABILITY_COMPETITIVE', 'ABILITY_CONTEMPT', 'ABILITY_DEFIANT', 'ABILITY_DUALITY', 'ABILITY_EMPERORS_WRATH',
  'ABILITY_FIRE_RULER', 'ABILITY_KINGS_WRATH', 'ABILITY_LUCHA_LIBRE', 'ABILITY_NARCISSIST', 'ABILITY_QUEENS_MOURNING',
  'ABILITY_RUN_AWAY',
]

/** Every ability whose `abilityHooks.json` `bitfields.suctionCups` is set --
 * `ON_ABILITY(battlerDef, TRUE, gAbilities[ability].suctionCups, ...)`'s
 * flag scan (EFFECT_ROAR). `TRUE` here is checkMoldBreaker, so each is still
 * individually gated by `defAbility`'s own real `breakable` lookup (Guard Dog
 * and Suction Cups are breakable; Strong Foundation and Superheavy are not --
 * see MOLD_BREAKABLE_ABILITIES). Pinned by aiCheckBadMove.test.ts.
 *
 * Extraction: same query as ON_STAT_LOWERED_ABILITIES with `bitfields.
 * suctionCups` in place of `'onStatLowered' in hooks` -- 4 entries. */
export const SUCTION_CUPS_ABILITIES: readonly string[] = ['ABILITY_GUARD_DOG', 'ABILITY_STRONG_FOUNDATION', 'ABILITY_SUCTION_CUPS', 'ABILITY_SUPERHEAVY']

/** Every ability whose `abilityHooks.json` `bitfields.alwaysSleeping` is set
 * -- `IsComatose`'s real flag scan (`RETURN_ABILITY_IF_FLAG(battler, FALSE,
 * alwaysSleeping)`), read without Mold-Breaker suppression (the macro's
 * `FALSE` argument) via `selfAbility`. Pinned by aiCheckBadMove.test.ts.
 *
 * Extraction: same query with `bitfields.alwaysSleeping` -- 2 entries. */
export const ALWAYS_SLEEPING_ABILITIES: readonly string[] = ['ABILITY_COMATOSE', 'ABILITY_DREAMSCAPE']

/** LoweringStatsPointlessOrBad, battle_ai_util.c:1274-1279 -- IsStatDropBlocked
 * has no port anywhere in this codebase (see this module's header). */
function loweringStatsPointlessOrBad(defender: BattlerState, attackerHasMoldBreaker: boolean, unmodelled: string[]): boolean {
  unmodelled.push('LoweringStatsPointlessOrBad: IsStatDropBlocked(battlerDef, STAT_HP, FALSE) has no port anywhere in this codebase (same admission as accuracy.ts\'s own header); treated as not blocked')
  if (defAbility(defender, 'ABILITY_CONTRARY', attackerHasMoldBreaker)) return true
  if (ON_STAT_LOWERED_ABILITIES.some((id) => selfAbility(defender, id))) return true
  return false
}

/** ShouldLowerStat, battle_ai_util.c:1283-1291. `stat < 4` is the C's own
 * literal (statStages are 0..12, DEFAULT 6 -- already lowered two stages or
 * more). */
function shouldLowerStat(defender: BattlerState, stat: number, attackerHasMoldBreaker: boolean, unmodelled: string[]): boolean {
  if (defender.mon.statStages[stat] < 4) return false
  if (loweringStatsPointlessOrBad(defender, attackerHasMoldBreaker, unmodelled)) return false
  unmodelled.push('ShouldLowerStat: IsStatDropBlocked(battlerDef, stat, FALSE) has no port anywhere in this codebase; treated as not blocked')
  return true
}

/** AreBattlersStatsMaxed, battle_ai_util.c:1305-1311. */
function areBattlersStatsMaxed(battler: BattlerState): boolean {
  for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
    if (battler.mon.statStages[i] < MAX_STAT_STAGE) return false
  }
  return true
}

/** HasMoveWithSplit, battle_ai_util.c:1371-1380 -- GetMovesArray always
 * returns the real moveset on this build (every trainer carries
 * AI_FLAG_CHECK_FOE, aiScorers.ts's own canTargetFaintAi doc). */
function hasMoveWithSplit(battler: BattlerState, split: 'PHYSICAL' | 'SPECIAL' | 'STATUS', deps: AiDamageDeps): boolean {
  return battler.mon.moves.some((m) => m && deps.moveData(m)?.split === split)
}

/** HasMoveWithType, battle_ai_util.c:1382-1391. */
function hasMoveWithType(battler: BattlerState, type: string, deps: AiDamageDeps): boolean {
  return battler.mon.moves.some((m) => m && deps.moveData(m)?.type === type)
}

/** IsBattlerIncapacitated, battle_ai_util.c:2019-2028. HasThawingMove is a
 * real moveset scan (moves.json's `thawUser` flag), not a gap. */
function isBattlerIncapacitated(battler: BattlerState, deps: AiDamageDeps): boolean {
  const hasThawingMove = battler.mon.moves.some((m) => m && deps.moveData(m)?.flags?.thawUser)
  if (hasFlag(battler.mon.status1, STATUS1_FREEZE) && !hasThawingMove) return true
  if (hasFlag(battler.mon.status1, STATUS1_SLEEP)) return true
  if (hasFlag(battler.mon.status2, STATUS2_RECHARGE)) return true // no writer in this sim; kept for parity
  return false
}

/** IsBattlerTrapped, battle_ai_util.c:566-580. `checkSwitch` is always TRUE
 * at both of this batch's call sites (the EFFECT_MEAN_LOOK branch below). */
function isBattlerTrapped(state: BattleState, battler: BattlerState, checkSwitch: boolean, deps: AiDamageDeps): { trapped: boolean; unmodelled: string[] } {
  const unmodelled: string[] = []
  const holdEffect = getBattlerHoldEffect(battler, deps)
  if (battler.volatiles.skyDropped) return { trapped: true, unmodelled }
  if (isBattlerOfType(battler, 'GHOST') || holdEffect === 'HOLD_EFFECT_SHED_SHELL' || (!checkSwitch && selfAbility(battler, 'ABILITY_RUN_AWAY'))) {
    return { trapped: false, unmodelled }
  }
  const escapeCheck = isAbilityPreventingEscape(state, battler.id)
  unmodelled.push(...escapeCheck.unmodelled)
  const trapped =
    hasFlag(battler.mon.status2, STATUS2_ESCAPE_PREVENTION | STATUS2_WRAPPED) ||
    hasFlag(battler.statuses4, STATUS4_COMMANDED) ||
    battler.volatiles.fear ||
    escapeCheck.prevents ||
    hasFlag(battler.statuses3, STATUS3_ROOTED) ||
    hasFlag(state.field.statuses, STATUS_FIELD_FAIRY_LOCK)
  return { trapped, unmodelled }
}

/** CanBePoisoned, battle_util.c:5040-5049 -- IsMyceliumMightActive and
 * IsAbilityStatusProtected both need ability-hook wiring this batch does not
 * have (the former: does the CURRENT move carry a status-bypass behavior;
 * the latter: Limber/Insomnia/Immunity/-class status-immunity abilities).
 * Gapped by name whenever reached, matching the codebase's own precedent for
 * an unwired ability-hook chain (accuracy.ts's IsStatDropBlocked). */
function canBePoisoned(state: BattleState, attacker: BattlerState, target: BattlerState, _deps: AiDamageDeps): { canPoison: boolean; unmodelled: string[] } {
  const unmodelled: string[] = []
  if (hasFlag(target.mon.status1, STATUS1_ANY)) return { canPoison: false, unmodelled }
  if (hasFlag(state.field.statuses, STATUS_FIELD_MISTY_TERRAIN)) return { canPoison: false, unmodelled }
  if (hasFlag(state.sides[target.id & 1].statuses, SIDE_STATUS_SAFEGUARD)) return { canPoison: false, unmodelled }
  unmodelled.push('CanBePoisoned/IsStatusImmune: IsAbilityStatusProtected(battlerDef, CHECK_POISON) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  if ((isBattlerOfType(target, 'POISON') || isBattlerOfType(target, 'STEEL')) && !defAbility(attacker, 'ABILITY_CORROSION', false)) {
    return { canPoison: false, unmodelled }
  }
  return { canPoison: true, unmodelled }
}

/** CanBeParalyzed, battle_util.c mirrors CanBePoisoned's shape; ELECTRIC-type
 * targets are immune (CanParalyzeType), same onCanStatusType gap. */
function canBeParalyzedBase(state: BattleState, target: BattlerState, _deps: AiDamageDeps): { canParalyze: boolean; unmodelled: string[] } {
  const unmodelled: string[] = []
  if (hasFlag(target.mon.status1, STATUS1_ANY)) return { canParalyze: false, unmodelled }
  if (hasFlag(state.field.statuses, STATUS_FIELD_MISTY_TERRAIN)) return { canParalyze: false, unmodelled }
  if (hasFlag(state.sides[target.id & 1].statuses, SIDE_STATUS_SAFEGUARD)) return { canParalyze: false, unmodelled }
  unmodelled.push('CanBeParalyzed/IsStatusImmune: IsAbilityStatusProtected(battlerDef, CHECK_PARALYSIS) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  if (isBattlerOfType(target, 'ELECTRIC')) return { canParalyze: false, unmodelled }
  return { canParalyze: true, unmodelled }
}

/** AI_CanParalyze, battle_ai_util.c:2046-2054 -- the ONLY one of the three
 * AI_Can* wrappers that adds checks beyond its base Can-status function
 * (AI_CanPutToSleep/AI_CanPoison are bare passthroughs to CanSleep/
 * CanBePoisoned, per the C's own one-line bodies). PartnerMoveEffectIsStatusSameTarget
 * always returns false (see this module's doubles-only helpers). */
function aiCanParalyze(state: BattleState, attacker: BattlerState, target: BattlerState, moveId: string, deps: AiDamageDeps): { canParalyze: boolean; unmodelled: string[] } {
  const base = canBeParalyzedBase(state, target, deps)
  if (!base.canParalyze) return base
  const effResult = aiGetMoveEffectiveness(state, moveId, attacker.id, target.id, deps)
  const unmodelled = [...base.unmodelled, ...effResult.unmodelled]
  if (effResult.effectiveness === 0) return { canParalyze: false, unmodelled }
  if (doesSubstituteBlockMove(attacker, target, deps.moveData(moveId), unmodelled)) return { canParalyze: false, unmodelled }
  return { canParalyze: true, unmodelled }
}

/** CanSleep, battle_util.c:5029-5038. */
function canSleep(state: BattleState, target: BattlerState, _deps: AiDamageDeps): { canSleep: boolean; unmodelled: string[] } {
  const unmodelled: string[] = []
  if (hasFlag(target.mon.status1, STATUS1_ANY)) return { canSleep: false, unmodelled }
  if (hasFlag(state.field.statuses, STATUS_FIELD_MISTY_TERRAIN)) return { canSleep: false, unmodelled }
  if (hasFlag(state.sides[target.id & 1].statuses, SIDE_STATUS_SAFEGUARD)) return { canSleep: false, unmodelled }
  unmodelled.push('CanSleep/IsStatusImmune: IsAbilityStatusProtected(battlerDef, CHECK_SLEEP) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  if (hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN)) return { canSleep: false, unmodelled }
  return { canSleep: true, unmodelled }
}

/** CanBeConfused, battle_util.c:5116-5123 -- IsAbilityStatusProtected(CHECK_CONFUSION)
 * covers Own Tempo and similar; same gap treatment. */
function canBeConfused(target: BattlerState, unmodelled: string[]): boolean {
  if (hasFlag(target.mon.status2, STATUS2_CONFUSION)) return false
  unmodelled.push('CanBeConfused: IsAbilityStatusProtected(battlerDef, CHECK_CONFUSION) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  return true
}

/** DoesSubstituteBlockMove, battle_script_commands.c:12252-12260. Infiltrates
 * is narrowed to the Infiltrator ability check (its dominant real-world
 * path); the move-specific Sub-piercing exemptions inside the real
 * `Infiltrates` are not modelled. */
function doesSubstituteBlockMove(attacker: BattlerState, defender: BattlerState, move: ReturnType<AiDamageDeps['moveData']>, unmodelled: string[]): boolean {
  if (!hasFlag(defender.mon.status2, STATUS2_SUBSTITUTE)) return false
  if (hasMoveFlag(move, 'sound')) return false
  if (hasMoveFlag(move, 'ignoresSubstitute')) return false
  if (selfAbility(attacker, 'ABILITY_INFILTRATOR')) {
    unmodelled.push("DoesSubstituteBlockMove: Infiltrates() is narrowed to a plain ABILITY_INFILTRATOR check; other Infiltrates paths (move-specific Sub-piercing exemptions) are not modelled")
    return false
  }
  return true
}

/** PartnerHasSameMoveEffectWithoutTarget / DoesPartnerHaveSameMoveEffect /
 * PartnerMoveIsSameNoTarget, battle_ai_util.c:2295-2378 -- all three start
 * `if (!IsDoubleBattle()) return FALSE;`; ported in full for symmetry with
 * this module's other partner helpers even though `isValidDoubleBattle`
 * (this module's own copy of the same fact) makes every call here return
 * false on this build. */
function partnerHasSameMoveEffectWithoutTarget(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}
function doesPartnerHaveSameMoveEffect(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}
function partnerMoveIsSameNoTarget(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}

/**
 * PART2_EFFECTS -- every case label handled ONLY in part 2 (:1299 onward,
 * EFFECT_SANDSTORM through the function's closing brace at :2163). An
 * earlier revision of this set was hand-typed from partial reading and
 * covered barely a third of the real labels, with several names
 * (EFFECT_ENCORE_2, EFFECT_ROAR_2, EFFECT_FIRE_PLEDGE/WATER_PLEDGE/
 * GRASS_PLEDGE, EFFECT_RECOVER, EFFECT_JUDGMENT, EFFECT_TECHNO_BLAST,
 * EFFECT_MULTI_ATTACK) that never matched any real case label or moves.json
 * effect value at all -- caught by review, not by a test, which is why this
 * set is now extracted mechanically instead of transcribed by eye, and
 * pinned by an oracle test in aiCheckBadMove.test.ts.
 *
 * Extraction (run from the repo root, against the pinned eliteredux-source
 * checkout): `awk 'NR>=1299 && NR<=2163' pipeline/.upstream/eliteredux-source/
 * src/battle_ai_main.c | grep -o "case EFFECT_[A-Za-z0-9_]*" | sed 's/case //'
 * | sort -u` -- 147 distinct labels, exactly matching this set's size
 * (asserted by aiCheckBadMove.test.ts).
 */
export const PART2_EFFECTS = new Set([
  'EFFECT_ABSORB', 'EFFECT_AFTER_YOU', 'EFFECT_AQUA_RING', 'EFFECT_AROMATIC_MIST', 'EFFECT_ASSIST', 'EFFECT_ATTRACT',
  'EFFECT_BATON_PASS', 'EFFECT_BEAK_BLAST', 'EFFECT_BELCH', 'EFFECT_BELLY_DRUM', 'EFFECT_BESTOW', 'EFFECT_BIDE',
  'EFFECT_BURN_UP', 'EFFECT_CAMOUFLAGE', 'EFFECT_CLANGOROUS_SOUL', 'EFFECT_CONVERSION', 'EFFECT_COPYCAT', 'EFFECT_CORE_ENFORCER',
  'EFFECT_DEFOG', 'EFFECT_DESTINY_BOND', 'EFFECT_DO_NOTHING', 'EFFECT_ELECTRIC_TERRAIN', 'EFFECT_ELECTRIFY', 'EFFECT_EMBARGO',
  'EFFECT_ENDEAVOR', 'EFFECT_ENDURE', 'EFFECT_ENTRAINMENT', 'EFFECT_ERUPTION', 'EFFECT_EXTREME_EVOBOOST', 'EFFECT_FAIRY_LOCK',
  'EFFECT_FAKE_OUT', 'EFFECT_FALSE_SWIPE', 'EFFECT_FINAL_GAMBIT', 'EFFECT_FLAIL', 'EFFECT_FLING', 'EFFECT_FLOWER_SHIELD',
  'EFFECT_FOLLOW_ME', 'EFFECT_FUTURE_SIGHT', 'EFFECT_GASTRO_ACID', 'EFFECT_GRASSY_TERRAIN', 'EFFECT_GRAVITY', 'EFFECT_GUARD_SPLIT',
  'EFFECT_GUARD_SWAP', 'EFFECT_HAIL', 'EFFECT_HEAL_BELL', 'EFFECT_HEAL_BLOCK', 'EFFECT_HEALING_WISH', 'EFFECT_HEAL_PULSE',
  'EFFECT_HEART_SWAP', 'EFFECT_HELPING_HAND', 'EFFECT_HIT_ENEMY_HEAL_ALLY', 'EFFECT_HIT_ESCAPE', 'EFFECT_HIT_PREVENT_ESCAPE',
  'EFFECT_HIT_SWITCH_TARGET', 'EFFECT_IMPRISON', 'EFFECT_INGRAIN', 'EFFECT_INSTRUCT', 'EFFECT_ION_DELUGE', 'EFFECT_KNOCK_OFF',
  'EFFECT_LASER_FOCUS', 'EFFECT_LAST_RESORT', 'EFFECT_LOCK_ON', 'EFFECT_LUCKY_CHANT', 'EFFECT_MAGIC_COAT', 'EFFECT_MAGIC_ROOM',
  'EFFECT_MAGNET_RISE', 'EFFECT_ME_FIRST', 'EFFECT_MEMENTO', 'EFFECT_METRONOME', 'EFFECT_MIMIC', 'EFFECT_MIRROR_MOVE',
  'EFFECT_MISTY_TERRAIN', 'EFFECT_MOONLIGHT', 'EFFECT_MORNING_SUN', 'EFFECT_MUD_SPORT', 'EFFECT_NATURAL_GIFT',
  'EFFECT_NATURE_POWER', 'EFFECT_NO_RETREAT', 'EFFECT_PAIN_SPLIT', 'EFFECT_PARTING_SHOT', 'EFFECT_PLASMA_FISTS',
  'EFFECT_PLEDGE', 'EFFECT_POLTERGEIST', 'EFFECT_POWDER', 'EFFECT_POWER_SPLIT', 'EFFECT_POWER_SWAP', 'EFFECT_POWER_TRICK',
  'EFFECT_PROTECT', 'EFFECT_PSYCHIC_TERRAIN', 'EFFECT_PSYCHO_SHIFT', 'EFFECT_PSYCH_UP', 'EFFECT_PURIFY', 'EFFECT_QUASH',
  'EFFECT_RAIN_DANCE', 'EFFECT_RAPID_SPIN', 'EFFECT_RECHARGE', 'EFFECT_RECOIL_IF_MISS', 'EFFECT_RECYCLE', 'EFFECT_REFRESH',
  'EFFECT_REST', 'EFFECT_RESTORE_HP', 'EFFECT_ROLE_PLAY', 'EFFECT_ROOST', 'EFFECT_SAFEGUARD', 'EFFECT_SANDSTORM',
  'EFFECT_SEMI_INVULNERABLE', 'EFFECT_SHELL_TRAP', 'EFFECT_SIMPLE_BEAM', 'EFFECT_SKETCH', 'EFFECT_SKILL_SWAP',
  'EFFECT_SKY_DROP', 'EFFECT_SNATCH', 'EFFECT_SOAK', 'EFFECT_SOFTBOILED', 'EFFECT_SOLARBEAM', 'EFFECT_SPECTRAL_THIEF',
  'EFFECT_SPEED_SWAP', 'EFFECT_SPITE', 'EFFECT_STOCKPILE', 'EFFECT_STRENGTH_SAP', 'EFFECT_SUCKER_PUNCH', 'EFFECT_SUNNY_DAY',
  'EFFECT_SUPER_FANG', 'EFFECT_SWALLOW', 'EFFECT_SWITCH_ARGUMENT', 'EFFECT_SYNCHRONOISE', 'EFFECT_SYNTHESIS', 'EFFECT_TAILWIND',
  'EFFECT_TAUNT', 'EFFECT_TEETER_DANCE', 'EFFECT_TELEKINESIS', 'EFFECT_THIRD_TYPE', 'EFFECT_THROAT_CHOP', 'EFFECT_TOPSY_TURVY',
  'EFFECT_TORMENT', 'EFFECT_TOXIC_TERRAIN', 'EFFECT_TRANSFORM', 'EFFECT_TRICK', 'EFFECT_TRICK_ROOM', 'EFFECT_TWO_TURNS_ATTACK',
  'EFFECT_VITAL_THROW', 'EFFECT_WATER_SPORT', 'EFFECT_WILL_O_WISP', 'EFFECT_WISH', 'EFFECT_WONDER_ROOM', 'EFFECT_WORRY_SEED',
  'EFFECT_YAWN',
])
// EFFECT_HIT/EFFECT_POISON_HIT/EFFECT_BURN_HIT/EFFECT_PARALYZE_HIT/
// EFFECT_CONFUSE_HIT fall through to `default` (the damage path, :798-804),
// never part 2 -- excluded above on purpose. Every OTHER moves.json effect
// value that is neither a part-1 case label (handled explicitly in the
// switch below) nor in this set is, by construction, not a case label
// anywhere in AI_CheckBadMove's switch at all (verified: the full :488-2163
// label extraction has exactly 246 distinct entries = this set's 147 plus
// the 99 part-1 labels, with zero overlap) -- so it legitimately falls to
// `default` in the real C too, the same as EFFECT_HIT. aiCheckBadMove.test.ts
// asserts this for a sample of such effects (e.g. EFFECT_HEX, EFFECT_PAYBACK)
// to distinguish "correctly silent" from "incorrectly silent".

/**
 * AI_CheckBadMove, battle_ai_main.c:488-1298. See this module's header for
 * scope and approximations. `moveIndex` is the caller's own slot 0-3, needed
 * for nothing in part 1 (part 2's EFFECT_HIDDEN_POWER-family cases would use
 * it) -- kept in the signature for symmetry with the DISPATCH table's Scorer
 * shape in aiPipeline.ts.
 */
export function aiCheckBadMove(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps): Result {
  const unmodelled: string[] = []
  const attacker = state.battlers[battlerAtk]
  const defender = state.battlers[battlerDef]
  if (!attacker || !defender) return { score, unmodelled }

  const move = deps.moveData(moveId)
  const effect = move?.effect ?? null
  const atkMoldBreaker = deps.grounding.attackerHasMoldBreaker

  // :507 -- IsTargetingPartner.
  if (isTargetingPartner(battlerAtk, battlerDef)) return { score, unmodelled }

  // :509 -- disabled move. `disabledMove` has no writer in this sim
  // (Disable's own move effect is not ported, attackCanceller.ts's own
  // CANCELLER_DISABLED note), so this is dead code here, not a gap.
  if (attacker.volatiles.disabledMove === moveId && attacker.volatiles.disableTimer !== 0) return { score: score - 20, unmodelled }

  // :511 -- Truant + non-status move.
  if (move?.split !== 'STATUS' && selfAbility(attacker, 'ABILITY_TRUANT')) return { score: score - 20, unmodelled }

  const resolvedType = moveType(moveId, deps, unmodelled)

  // :516-766 -- checks that only apply when the move does NOT target the user.
  if (!moveTargetsUser(move)) {
    if (hasMoveFlag(move, 'powderAffected') && isPowderImmune(defender, atkMoldBreaker, deps)) return { score: score - 20, unmodelled }
    if (resolvedType === 'FLYING' && defAbility(defender, 'ABILITY_AERODYNAMICS', atkMoldBreaker)) return { score: score - 30, unmodelled }
    if (resolvedType === 'POISON' && defAbility(defender, 'ABILITY_POISON_ABSORB', atkMoldBreaker)) return { score: score - 30, unmodelled }
    if ((resolvedType === 'FLYING' || resolvedType === 'FIRE') && defAbility(defender, 'ABILITY_INFLATABLE', atkMoldBreaker)) return { score: score - 20, unmodelled }
    if (resolvedType === 'ROCK' && defAbility(defender, 'ABILITY_MOUNTAINEER', atkMoldBreaker) && !doesBattlerIgnoreAbilityOrInnateChecks(deps)) return { score: score - 20, unmodelled }
    if (resolvedType === 'DARK' && isAbilityOnField(state, 'ABILITY_RADIANCE') && !doesBattlerIgnoreAbilityOrInnateChecks(deps)) return { score: score - 20, unmodelled }
    if (resolvedType === 'ICE' && defAbility(defender, 'ABILITY_ICE_DEW', atkMoldBreaker)) return { score: score - 20, unmodelled }
    // :547-551 -- Lightning Rod on the defender OR its (always-absent-in-singles) partner.
    if (resolvedType === 'ELECTRIC' && defAbility(defender, 'ABILITY_LIGHTNING_ROD', atkMoldBreaker)) return { score: score - 20, unmodelled }
    if (resolvedType === 'ELECTRIC' && defAbility(defender, 'ABILITY_VOLT_ABSORB', atkMoldBreaker)) return { score: score - 20, unmodelled }
    if (resolvedType === 'GROUND' && defAbility(defender, 'ABILITY_EARTH_EATER', atkMoldBreaker)) return { score: score - 20, unmodelled }
    if (moveId === 'MOVE_LEECH_SEED' && isMagicGuardProtected(state, defender)) return { score: score - 20, unmodelled }

    if (resolvedType === 'FIRE' && isBattlerOfType(defender, 'GRASS') && defAbility(defender, 'ABILITY_SEAWEED', atkMoldBreaker)) score += 2
    if (hasMoveFlag(move, 'boneBased') && defAbility(defender, 'ABILITY_BONE_ZONE', atkMoldBreaker)) score += 2
    if (resolvedType === 'GRASS' && isBattlerOfType(defender, 'FIRE') && selfAbility(attacker, 'ABILITY_SEAWEED')) score += 2
    if (resolvedType === 'ELECTRIC' && isBattlerOfType(defender, 'GROUND') && selfAbility(attacker, 'ABILITY_GROUND_SHOCK')) score += 2
    if (resolvedType === 'ELECTRIC' && isBattlerOfType(defender, 'ELECTRIC') && selfAbility(attacker, 'ABILITY_OVERCHARGE')) score += 2
    if (resolvedType === 'FIRE' && isBattlerOfType(defender, 'ROCK') && selfAbility(attacker, 'ABILITY_MOLTEN_DOWN')) score += 2
    if (resolvedType === 'DRAGON' && isBattlerOfType(defender, 'FAIRY') && selfAbility(attacker, 'ABILITY_OVERWHELM')) score += 2

    // :596 -- semi-invulnerable target, effect isn't the semi-invulnerable
    // charge move itself, and the AI goes first.
    if (isSemiInvulnerable(defender, move) && effect !== 'EFFECT_SEMI_INVULNERABLE' && getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) !== 1) {
      return { score: score - 20, unmodelled }
    }

    // :600-607 -- AI_GetEffectiveness enum.
    const effResult = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
    unmodelled.push(...effResult.unmodelled)
    if (effResult.effectiveness === 0) return { score: score - 20, unmodelled } // AI_EFFECTIVENESS_x0
    if (effResult.effectiveness === 2) return { score: score - 10, unmodelled } // AI_EFFECTIVENESS_x0_25

    // :610-707 -- target (and, in doubles, target-partner) ability checks.
    if (!doesBattlerIgnoreAbilityChecks(battlerAtk, battlerDef, deps)) {
      const built = move
        ? {
            moveType: resolvedType ?? 'NORMAL',
            moveFlags: built_flags(move),
          }
        : null
      if (built) {
        if (computeIsAbsorbed(defender.mon.abilities, built, atkMoldBreaker)) return { score: score - 20, unmodelled } // TestAbsorbingAbilitiesOnly
        const weather = buildFieldFacts(state, deps).weather
        if (
          computeIsImmune(
            defender.mon.abilities,
            { moveType: built.moveType, moveFlags: built.moveFlags, moveSplit: (move?.split ?? 'STATUS') as 'PHYSICAL' | 'SPECIAL' | 'STATUS', weather, movePriority: move?.priority ?? 0 },
            atkMoldBreaker,
          )
        ) {
          return { score: score - 20, unmodelled } // TestImmunityAbilitiesOnly
        }
      }

      // :615-671 -- the per-ability-slot switch. `GetNumPossibleAbilitiesForBattler`
      // is the fixed slot count (ability + innates); every slot on `defender.mon.abilities`.
      const defSlots = [defender.mon.abilities.ability, ...defender.mon.abilities.innates].filter((x): x is string => !!x)
      for (const abilityToCheck of defSlots) {
        switch (abilityToCheck) {
          case 'ABILITY_GIFTED_MIND':
            if (resolvedType === 'DARK' || resolvedType === 'GHOST' || resolvedType === 'BUG') return { score: score - 20, unmodelled }
            break
          case 'ABILITY_RATTLED':
            if (move?.split !== 'STATUS' && (resolvedType === 'DARK' || resolvedType === 'GHOST' || resolvedType === 'BUG')) return { score: score - 10, unmodelled }
            break
          case 'ABILITY_FLOWER_VEIL':
            if (isBattlerOfType(defender, 'GRASS') && (isNonVolatileStatusMoveEffect(effect) || isStatLoweringMoveEffect(effect))) return { score: score - 10, unmodelled }
            break
          case 'ABILITY_MAGIC_BOUNCE':
            if (hasMoveFlag(move, 'magicCoatAffected')) return { score: score - 20, unmodelled }
            break
          case 'ABILITY_CONTRARY':
            if (isStatLoweringMoveEffect(effect)) return { score: score - 20, unmodelled }
            break
          case 'ABILITY_CLEAR_BODY':
          case 'ABILITY_FULL_METAL_BODY':
            if (isStatLoweringMoveEffect(effect)) return { score: score - 10, unmodelled }
            break
          case 'ABILITY_HYPER_CUTTER':
            if ((effect === 'EFFECT_ATTACK_DOWN' || effect === 'EFFECT_ATTACK_DOWN_2') && !['MOVE_PLAY_NICE', 'MOVE_NOBLE_ROAR', 'MOVE_TEARFUL_LOOK', 'MOVE_VENOM_DRENCH'].includes(moveId)) {
              return { score: score - 10, unmodelled }
            }
            break
          case 'ABILITY_KEEN_EYE':
            if (effect === 'EFFECT_ACCURACY_DOWN' || effect === 'EFFECT_ACCURACY_DOWN_2') return { score: score - 10, unmodelled }
            break
          case 'ABILITY_BIG_PECKS':
            if (effect === 'EFFECT_DEFENSE_DOWN' || effect === 'EFFECT_DEFENSE_DOWN_2') return { score: score - 10, unmodelled }
            break
          case 'ABILITY_CONTEMPT':
          case 'ABILITY_DEFIANT':
          case 'ABILITY_COMPETITIVE':
            if (isStatLoweringMoveEffect(effect) && !isTargetingPartner(battlerAtk, battlerDef)) return { score: score - 8, unmodelled }
            break
          case 'ABILITY_BLOOD_STAIN':
          case 'ABILITY_COMATOSE':
          case 'ABILITY_DREAMSCAPE':
            if (isNonVolatileStatusMoveEffect(effect)) return { score: score - 10, unmodelled }
            break
          case 'ABILITY_SHIELDS_DOWN':
            unmodelled.push('AI_CheckBadMove: IsShieldsDownProtected(battlerAtk) is not modelled (Minior form-state is not tracked); treated as not protected')
            break
          case 'ABILITY_WONDER_SKIN':
            // Accuracy override to 50 for status moves -- has no effect on
            // score here (the C stores it in a local the rest of the
            // function never rereads for a score delta), so nothing to port.
            break
          case 'ABILITY_LEAF_GUARD':
            if (weatherHasEffect(state, deps.grounding) && hasFlag(state.field.weather, WEATHER_SUN_ANY) && getBattlerHoldEffect(defender, deps) !== 'HOLD_EFFECT_UTILITY_UMBRELLA' && isNonVolatileStatusMoveEffect(effect)) {
              return { score: score - 10, unmodelled }
            }
            break
        }
      }
      // :674-706 -- def-PARTNER ability checks, doubles only -- dead code
      // in singles (isValidDoubleBattle is always false), not ported branch
      // by branch; see this module's header.
    }

    // :710-725 -- Magic Guard.
    if (isMagicGuardProtected(state, defender)) {
      switch (effect) {
        case 'EFFECT_POISON':
        case 'EFFECT_WILL_O_WISP':
        case 'EFFECT_TOXIC':
        case 'EFFECT_LEECH_SEED':
          score -= 5
          break
        case 'EFFECT_CURSE':
          if (isBattlerOfType(attacker, 'GHOST')) score -= 5
          else if (isBattlerWeatherAffected(state, WEATHER_FOG_ANY, deps)) score -= 5
          break
      }
    }

    // :727-730 -- Anticipation. GetSingleUseAbilityCounter has no state
    // anywhere in this codebase (turn.ts's own admission) -- gapped
    // wholesale whenever the defender holds the ability.
    if (defAbility(defender, 'ABILITY_ANTICIPATION', false)) {
      unmodelled.push('AI_CheckBadMove: Anticipation (battle_ai_main.c:727-730) needs GetSingleUseAbilityCounter, which has no state anywhere in this codebase (same admission as turn.ts\'s own header); not scored')
    }

    // :733-735 -- Wonder Guard.
    if (defAbility(defender, 'ABILITY_WONDER_GUARD', atkMoldBreaker)) {
      const effResult2 = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
      unmodelled.push(...effResult2.unmodelled)
      if (effResult2.effectiveness > 5 && (move?.power ?? 0) > 0) return { score: score - 20, unmodelled } // > AI_EFFECTIVENESS_x2
    }

    // :738 -- Aroma Veil.
    if (defAbility(defender, 'ABILITY_AROMA_VEIL', atkMoldBreaker) && isAromaVeilProtectedMove(moveId)) return { score: score - 20, unmodelled }
    // :741 -- Sweet Veil.
    if (defAbility(defender, 'ABILITY_SWEET_VEIL', atkMoldBreaker) && (effect === 'EFFECT_SLEEP' || effect === 'EFFECT_YAWN')) return { score: score - 10, unmodelled }
    // :744 -- Magic Bounce.
    if (defAbility(defender, 'ABILITY_MAGIC_BOUNCE', atkMoldBreaker) && hasMoveFlag(move, 'magicCoatAffected')) return { score: score - 20, unmodelled }
    // :746 -- Clear Amulet.
    if (getBattlerHoldEffect(defender, deps) === 'HOLD_EFFECT_CLEAR_AMULET' && isStatLoweringMoveEffect(effect)) return { score: score - 10, unmodelled }

    // :749-752 -- Prankster + Dark-type immunity to status-priority moves.
    if (selfAbility(attacker, 'ABILITY_PRANKSTER') && isBattlerOfType(defender, 'DARK') && move?.split === 'STATUS' && move?.target !== 'OPPONENTS_FIELD' && move?.target !== 'USER') {
      return { score: score - 10, unmodelled }
    }

    // :755-765 -- terrain.
    if (hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN) && (effect === 'EFFECT_SLEEP' || effect === 'EFFECT_YAWN')) return { score: score - 20, unmodelled }
    if (hasFlag(state.field.statuses, STATUS_FIELD_MISTY_TERRAIN) && (isNonVolatileStatusMoveEffect(effect) || effect === 'EFFECT_SWAGGER' || effect === 'EFFECT_FLATTER' || effect === 'EFFECT_TEETER_DANCE')) {
      return { score: score - 20, unmodelled } // IsConfusionMoveEffect transcribed inline
    }
    if (hasFlag(state.field.statuses, STATUS_FIELD_PSYCHIC_TERRAIN) && (move?.priority ?? 0) > 0 && move?.target !== 'USER') return { score: score - 20, unmodelled }
  } // end !moveTargetsUser(move)

  // :770-794 -- any-target checks.
  if (attacker.volatiles.throatChopTimer && hasMoveFlag(move, 'sound')) return { score: 0, unmodelled }
  if (attacker.volatiles.healBlockTimer && (move?.effect === 'EFFECT_RESTORE_HP' || move?.effect === 'EFFECT_REST')) {
    unmodelled.push('AI_CheckBadMove: IsHealBlockPreventingMove is narrowed to EFFECT_RESTORE_HP/EFFECT_REST; other healing-adjacent effects it covers (Wish, Rest-family, Pain Split heal half, ...) are not enumerated')
    return { score: 0, unmodelled }
  }
  // A heal-blocked part-2 healing effect this narrowing doesn't name (EFFECT_
  // WISH, EFFECT_PAIN_SPLIT, ...) is NOT caught here -- it falls through and
  // is instead caught by the PART2_EFFECTS gap below, which returns the
  // UNMODIFIED `score`, not the C's real hard `0`. This is a genuine behavior
  // difference in that specific interaction (heal-blocked + part-2 healing
  // effect), not just a granularity-of-disclosure difference, though the move
  // is still gapped (never silently mis-scored with no signal at all).
  if (weatherHasEffect(state, deps.grounding)) {
    if (hasFlag(state.field.weather, WEATHER_PRIMAL_ANY)) {
      if (['MOVE_SUNNY_DAY', 'MOVE_RAIN_DANCE', 'MOVE_HAIL', 'MOVE_SANDSTORM', 'MOVE_EERIE_FOG'].includes(moveId)) return { score: score - 30, unmodelled }
    }
    if (move?.split !== 'STATUS') {
      if (hasFlag(state.field.weather, WEATHER_SUN_PRIMAL) && resolvedType === 'WATER') return { score: score - 30, unmodelled }
      if (hasFlag(state.field.weather, WEATHER_RAIN_PRIMAL) && resolvedType === 'FIRE') return { score: score - 30, unmodelled }
    }
  }

  // :797-1298 -- move effects.
  if (effect && PART2_EFFECTS.has(effect)) {
    unmodelled.push(`AI_CheckBadMove: ${effect} is handled only in part 2 (battle_ai_main.c:1299+); not scored by this batch`)
    return { score, unmodelled }
  }

  switch (effect) {
    case 'EFFECT_SLEEP': {
      const r = canSleep(state, defender, deps)
      unmodelled.push(...r.unmodelled)
      if (!r.canSleep) score -= 10
      break
    }
    case 'EFFECT_EXPLOSION': {
      const willSuicide = hasFlag(state.aiFlags, AI_FLAG_WILL_SUICIDE)
      if (!willSuicide) score -= 2
      const effResult3 = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
      unmodelled.push(...effResult3.unmodelled)
      if (effResult3.effectiveness === 0) {
        score -= 10
      } else if (isAbilityOnField(state, 'ABILITY_DAMP') && !doesBattlerIgnoreAbilityChecks(battlerAtk, battlerDef, deps)) {
        score -= 10
      } else if (countUsablePartyMons(state, battlerAtk) === 0) {
        if (countUsablePartyMons(state, battlerDef) !== 0) score -= 10
        else score -= 1
      }
      break
    }
    case 'EFFECT_DREAM_EATER': {
      const asleep = hasFlag(defender.mon.status1, STATUS1_SLEEP)
      const comatose = ALWAYS_SLEEPING_ABILITIES.some((id) => selfAbility(defender, id))
      if (!asleep || comatose) {
        score -= 8
      } else {
        const effResult4 = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
        unmodelled.push(...effResult4.unmodelled)
        if (effResult4.effectiveness === 0) score -= 10
      }
      break
    }
    case 'EFFECT_ATTACK_UP':
    case 'EFFECT_ATTACK_UP_2':
      if (!battlerStatCanRise(state, attacker, 1 /* STAT_ATK */, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
      break
    case 'EFFECT_STUFF_CHEEKS': {
      const pocket = attacker.mon.itemId ? deps.dataContext.item(attacker.mon.itemId) : undefined
      unmodelled.push('AI_CheckBadMove: ItemId_GetPocket(item) != POCKET_BERRIES is approximated via a berry-name check, not a real pocket lookup')
      if (!attacker.mon.itemId || !attacker.mon.itemId.includes('BERRY')) return { score: 0, unmodelled }
      if (!battlerStatCanRise(state, attacker, 2 /* STAT_DEF */, deps)) score -= 10
      void pocket
      break
    }
    case 'EFFECT_DEFENSE_UP':
    case 'EFFECT_DEFENSE_UP_2':
    case 'EFFECT_DEFENSE_UP_3':
    case 'EFFECT_DEFENSE_CURL':
      if (!battlerStatCanRise(state, attacker, 2 /* STAT_DEF */, deps)) score -= 10
      break
    case 'EFFECT_SPECIAL_ATTACK_UP':
    case 'EFFECT_SPECIAL_ATTACK_UP_2':
    case 'EFFECT_SPECIAL_ATTACK_UP_3':
      if (!battlerStatCanRise(state, attacker, 4 /* STAT_SPATK */, deps) || !hasMoveWithSplit(attacker, 'SPECIAL', deps)) score -= 10
      break
    case 'EFFECT_SPECIAL_DEFENSE_UP':
    case 'EFFECT_SPECIAL_DEFENSE_UP_2':
      if (!battlerStatCanRise(state, attacker, 5 /* STAT_SPDEF */, deps)) score -= 10
      break
    case 'EFFECT_ACCURACY_UP':
    case 'EFFECT_ACCURACY_UP_2':
      if (!battlerStatCanRise(state, attacker, 6 /* STAT_ACC */, deps)) score -= 10
      break
    case 'EFFECT_EVASION_UP':
    case 'EFFECT_EVASION_UP_2':
    case 'EFFECT_MINIMIZE':
      if (!battlerStatCanRise(state, attacker, 7 /* STAT_EVASION */, deps)) score -= 10
      break
    case 'EFFECT_COSMIC_POWER':
      if (!battlerStatCanRise(state, attacker, 2, deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 5, deps)) score -= 8
      break
    case 'EFFECT_BULK_UP':
      if (!battlerStatCanRise(state, attacker, 1, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 2, deps)) score -= 8
      break
    case 'EFFECT_CALM_MIND':
      if (!battlerStatCanRise(state, attacker, 4, deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 5, deps)) score -= 8
      break
    case 'EFFECT_DRAGON_DANCE':
      if (!battlerStatCanRise(state, attacker, 1, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 3 /* STAT_SPEED */, deps)) score -= 8
      break
    case 'EFFECT_COIL':
      if (!battlerStatCanRise(state, attacker, 6, deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 1, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 8
      else if (!battlerStatCanRise(state, attacker, 2, deps)) score -= 6
      break
    case 'EFFECT_ATTACK_ACCURACY_UP':
      if (!selfAbility(attacker, 'ABILITY_CONTRARY')) {
        if (attacker.mon.statStages[1] >= MAX_STAT_STAGE && (attacker.mon.statStages[6] >= MAX_STAT_STAGE || !hasMoveWithSplit(attacker, 'PHYSICAL', deps))) score -= 10
      } else {
        score -= 10
      }
      break
    case 'EFFECT_CHARGE':
      if (hasFlag(attacker.statuses3, STATUS3_CHARGED_UP)) score -= 20
      else if (!hasMoveWithType(attacker, 'ELECTRIC', deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 5, deps)) score -= 5
      break
    case 'EFFECT_QUIVER_DANCE':
    case 'EFFECT_GEOMANCY':
      if (attacker.mon.statStages[4] >= MAX_STAT_STAGE || !hasMoveWithSplit(attacker, 'SPECIAL', deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 3, deps)) score -= 8
      else if (!battlerStatCanRise(state, attacker, 5, deps)) score -= 6
      break
    case 'EFFECT_SHIFT_GEAR':
      if (!battlerStatCanRise(state, attacker, 1, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 3, deps)) score -= 8
      break
    case 'EFFECT_SHELL_SMASH':
      if (!selfAbility(attacker, 'ABILITY_CONTRARY')) {
        if (!battlerStatCanRise(state, attacker, 2, deps)) score -= 10
        else if (!battlerStatCanRise(state, attacker, 5, deps)) score -= 8
      } else {
        if (!battlerStatCanRise(state, attacker, 1, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
        else if (!battlerStatCanRise(state, attacker, 4, deps) || !hasMoveWithSplit(attacker, 'SPECIAL', deps)) score -= 8
        else if (!battlerStatCanRise(state, attacker, 3, deps)) score -= 6
      }
      break
    case 'EFFECT_GROWTH':
    case 'EFFECT_ATTACK_SPATK_UP':
      if (!battlerStatCanRise(state, attacker, 1, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
      else if (!battlerStatCanRise(state, attacker, 4, deps) || !hasMoveWithSplit(attacker, 'SPECIAL', deps)) score -= 8
      break
    case 'EFFECT_ROTOTILLER':
      // Doubles-partner half (:951-953) is dead code in singles.
      if (!(isBattlerOfType(attacker, 'GRASS') && battlerStatCanRise(state, attacker, 1, deps))) score -= 10
      break
    case 'EFFECT_GEAR_UP': {
      const plusMinus = selfAbility(attacker, 'ABILITY_PLUS') || selfAbility(attacker, 'ABILITY_MINUS')
      if (plusMinus) {
        if (!battlerStatCanRise(state, attacker, 1, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
        else if (!battlerStatCanRise(state, attacker, 4, deps) || !hasMoveWithSplit(attacker, 'SPECIAL', deps)) score -= 8
        break
      }
      score -= 10 // !isDoubleBattle path -- always taken in singles.
      break
    }
    case 'EFFECT_ACUPRESSURE': {
      const blocked = doesSubstituteBlockMove(attacker, defender, move, unmodelled) || areBattlersStatsMaxed(defender)
      if (blocked) score -= 10
      break
    }
    case 'EFFECT_MAGNETIC_FLUX': {
      const plusMinus2 = selfAbility(attacker, 'ABILITY_PLUS') || selfAbility(attacker, 'ABILITY_MINUS')
      if (plusMinus2) {
        if (!battlerStatCanRise(state, attacker, 2, deps)) score -= 10
        else if (!battlerStatCanRise(state, attacker, 5, deps)) score -= 8
      } else {
        score -= 10
      }
      break
    }
    case 'EFFECT_ATTACK_DOWN':
    case 'EFFECT_ATTACK_DOWN_2':
      if (!shouldLowerStat(defender, 1, atkMoldBreaker, unmodelled)) score -= 10
      break
    case 'EFFECT_DEFENSE_DOWN':
    case 'EFFECT_DEFENSE_DOWN_2':
      if (!shouldLowerStat(defender, 2, atkMoldBreaker, unmodelled)) score -= 10
      break
    case 'EFFECT_SPEED_DOWN':
    case 'EFFECT_SPEED_DOWN_2':
      if (!shouldLowerStat(defender, 3, atkMoldBreaker, unmodelled)) score -= 10
      else if (defAbility(defender, 'ABILITY_SPEED_BOOST', atkMoldBreaker)) score -= 10
      break
    case 'EFFECT_SPECIAL_ATTACK_DOWN':
    case 'EFFECT_SPECIAL_ATTACK_DOWN_2':
      if (!shouldLowerStat(defender, 4, atkMoldBreaker, unmodelled)) score -= 10
      break
    case 'EFFECT_SPECIAL_DEFENSE_DOWN':
    case 'EFFECT_SPECIAL_DEFENSE_DOWN_2':
      if (!shouldLowerStat(defender, 5, atkMoldBreaker, unmodelled)) score -= 10
      break
    case 'EFFECT_ACCURACY_DOWN':
    case 'EFFECT_ACCURACY_DOWN_2':
      if (!shouldLowerStat(defender, 6, atkMoldBreaker, unmodelled)) score -= 10
      break
    case 'EFFECT_EVASION_DOWN':
    case 'EFFECT_EVASION_DOWN_2':
      if (!shouldLowerStat(defender, 7, atkMoldBreaker, unmodelled)) score -= 10
      break
    case 'EFFECT_TICKLE':
      if (!shouldLowerStat(defender, 1, atkMoldBreaker, unmodelled)) score -= 10
      else if (!shouldLowerStat(defender, 2, atkMoldBreaker, unmodelled)) score -= 8
      break
    case 'EFFECT_VENOM_DRENCH':
      if (!hasFlag(defender.mon.status1, STATUS1_POISON_ANY)) {
        score -= 10
      } else {
        if (!shouldLowerStat(defender, 3, atkMoldBreaker, unmodelled)) score -= 10
        else if (!shouldLowerStat(defender, 4, atkMoldBreaker, unmodelled)) score -= 8
        else if (!shouldLowerStat(defender, 1, atkMoldBreaker, unmodelled)) score -= 6
      }
      break
    case 'EFFECT_NOBLE_ROAR':
      if (!shouldLowerStat(defender, 4, atkMoldBreaker, unmodelled)) score -= 10
      else if (!shouldLowerStat(defender, 1, atkMoldBreaker, unmodelled)) score -= 8
      break
    case 'EFFECT_CAPTIVATE': {
      const atkGender = attacker.mon.gender
      const defGender = defender.mon.gender
      if (atkGender === 'GENDERLESS' || defGender === 'GENDERLESS' || atkGender === defGender) score -= 10
      break
    }
    case 'EFFECT_HAZE': {
      if (partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) {
        score -= 10
      } else {
        for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
          if (attacker.mon.statStages[i] > 6 /* DEFAULT_STAT_STAGE */) score -= 10
        }
        for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
          if (defender.mon.statStages[i] < 6) score -= 10
        }
      }
      break
    }
    case 'EFFECT_LEVEL_DAMAGE':
    case 'EFFECT_PSYWAVE':
    case 'EFFECT_SKULL_BASH':
    case 'EFFECT_SUPERPOWER':
    case 'EFFECT_LOW_KICK': {
      const effResult5 = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
      unmodelled.push(...effResult5.unmodelled)
      if (defAbility(defender, 'ABILITY_WONDER_GUARD', atkMoldBreaker) && effResult5.effectiveness > 5) score -= 10
      break
    }
    case 'EFFECT_FOCUS_PUNCH':
      if (!hasFlag(attacker.mon.status2, STATUS2_SUBSTITUTE)) score += 5
      else score -= 10
      break
    case 'EFFECT_COUNTER':
    case 'EFFECT_MIRROR_COAT': {
      const incapacitated = isBattlerIncapacitated(defender, deps) || hasFlag(defender.mon.status2, STATUS2_CONFUSION)
      if (incapacitated) score -= 1
      // AI_DATA->predictedMoves has no equivalent anywhere in state.ts's
      // BattleHistoryState (grepped: no `predictedMoves` field exists) --
      // treated as MOVE_NONE (no prediction), which is the C's own "no
      // prediction" branch, not a substitute value invented for this port.
      const predictedMove: string | null = null
      unmodelled.push('AI_CheckBadMove: AI_DATA->predictedMoves has no equivalent anywhere in state.ts; treated as MOVE_NONE (no prediction)')
      if (!predictedMove) score -= 10
      break
    }
    case 'EFFECT_ROAR':
      if (countUsablePartyMons(state, battlerDef) === 0) score -= 10
      else if (hasFlag(defender.statuses4, STATUS4_COMMANDED)) score -= 10
      else if (SUCTION_CUPS_ABILITIES.some((id) => defAbility(defender, id, atkMoldBreaker))) {
        score -= 10
      }
      break
    case 'EFFECT_TOXIC_THREAD':
    case 'EFFECT_POISON':
    case 'EFFECT_TOXIC': {
      if (effect === 'EFFECT_TOXIC_THREAD' && !shouldLowerStat(defender, 3, atkMoldBreaker, unmodelled)) score -= 1
      const r = canBePoisoned(state, attacker, defender, deps)
      unmodelled.push(...r.unmodelled)
      if (!r.canPoison) score -= 10
      break
    }
    case 'EFFECT_LIGHT_SCREEN':
      if (hasFlag(state.sides[battlerAtk & 1].statuses, SIDE_STATUS_LIGHTSCREEN) || partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_REFLECT':
      if (hasFlag(state.sides[battlerAtk & 1].statuses, SIDE_STATUS_REFLECT) || partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_AURORA_VEIL':
      if (hasFlag(state.sides[battlerAtk & 1].statuses, SIDE_STATUS_AURORA_VEIL) || partnerHasSameMoveEffectWithoutTarget(state, battlerAtk) || !hasFlag(state.field.weather, WEATHER_HAIL_ANY)) {
        score -= 10
      }
      break
    case 'EFFECT_OHKO':
      score -= 10 // OHKO moves were removed from this game.
      break
    case 'EFFECT_MIST':
      if (hasFlag(state.sides[battlerAtk & 1].statuses, SIDE_STATUS_MIST) || partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_FOCUS_ENERGY':
      if (attacker.volatiles.critBoost > 1) score -= 10
      break
    case 'EFFECT_DRAGON_CHEER': {
      const partner = state.battlers[battlePartner(battlerAtk)]
      if (attacker.volatiles.critBoost > 1 || (partner && partner.volatiles.critBoost > 1)) score -= 10
      break
    }
    case 'EFFECT_CONFUSE':
    case 'EFFECT_SWAGGER':
    case 'EFFECT_FLATTER': {
      const partnerMoveIsConfusion = false // AI_DATA->partnerMove is never set in singles.
      if (!canBeConfused(defender, unmodelled) || partnerMoveIsConfusion) score -= 20
      break
    }
    case 'EFFECT_PARALYZE': {
      const r = aiCanParalyze(state, attacker, defender, moveId, deps)
      unmodelled.push(...r.unmodelled)
      if (!r.canParalyze) score -= 20
      break
    }
    case 'EFFECT_SUBSTITUTE':
      if (hasFlag(attacker.mon.status2, STATUS2_SUBSTITUTE) || defAbility(defender, 'ABILITY_INFILTRATOR', atkMoldBreaker) || defAbility(defender, 'ABILITY_MARINE_APEX', atkMoldBreaker)) {
        score -= 10
      } else if (getHealthPercentage(state, battlerAtk) <= 25) {
        score -= 10
      } else if (attacker.mon.moves.some((m) => m && deps.moveData(m)?.flags?.sound)) {
        unmodelled.push('AI_CheckBadMove: B_SOUND_SUBSTITUTE >= GEN_6 is assumed true (this build targets a modern-gen ruleset, same assumption GetBattleMoveSplit makes for B_PHYSICAL_SPECIAL_SPLIT)')
        score -= 8
      }
      break
    case 'EFFECT_LEECH_SEED':
      if (hasFlag(defender.statuses3, STATUS3_LEECHSEED) || isBattlerOfType(defender, 'GRASS') || doesPartnerHaveSameMoveEffect(state, battlerAtk)) {
        score -= 20
      } else if (defAbility(defender, 'ABILITY_LIQUID_OOZE', atkMoldBreaker)) {
        score -= 3
      }
      break
    case 'EFFECT_DISABLE':
    case 'EFFECT_ENCORE': {
      const timer = effect === 'EFFECT_DISABLE' ? defender.volatiles.disableTimer : defender.volatiles.encoreTimer
      const mentalHerbBlocks = getBattlerHoldEffect(defender, deps) === 'HOLD_EFFECT_MENTAL_HERB'
      unmodelled.push('AI_CheckBadMove: B_MENTAL_HERB >= GEN_5 is assumed true, same modern-gen-ruleset assumption as EFFECT_SUBSTITUTE\'s B_SOUND_SUBSTITUTE check')
      if (timer === 0 && !mentalHerbBlocks && !doesPartnerHaveSameMoveEffect(state, battlerAtk)) {
        const goesFirst = getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0
        if (goesFirst) {
          if (defender.lastMove === null) score -= 10
        } else {
          unmodelled.push('AI_CheckBadMove: AI_DATA->predictedMoves has no equivalent anywhere in state.ts; treated as MOVE_NONE (no prediction)')
          score -= 10
        }
      } else {
        score -= 10
      }
      break
    }
    case 'EFFECT_SNORE':
    case 'EFFECT_SLEEP_TALK': {
      const asleep = hasFlag(attacker.mon.status1, STATUS1_SLEEP)
      const comatose = ALWAYS_SLEEPING_ABILITIES.some((id) => selfAbility(attacker, id))
      unmodelled.push("AI_CheckBadMove: IsWakeupTurn is not modelled (no move-history-by-turn tracking exists in this sim -- FindMoveUsedXTurnsAgo has no port); treated as false")
      const isWakeupTurn = false
      if (isWakeupTurn || !asleep || !comatose) score -= 10
      break
    }
    case 'EFFECT_MEAN_LOOK': {
      const trapResult = isBattlerTrapped(state, defender, true, deps)
      unmodelled.push(...trapResult.unmodelled)
      if (trapResult.trapped || doesPartnerHaveSameMoveEffect(state, battlerAtk)) score -= 10
      break
    }
    case 'EFFECT_NIGHTMARE':
      if (hasFlag(defender.mon.status2, STATUS2_NIGHTMARE)) {
        score -= 10
      } else if (!hasFlag(defender.mon.status1, STATUS1_SLEEP) || ALWAYS_SLEEPING_ABILITIES.some((id) => selfAbility(defender, id))) {
        score -= 8
      } else if (doesPartnerHaveSameMoveEffect(state, battlerAtk)) {
        score -= 10
      }
      break
    case 'EFFECT_CURSE':
      if (isBattlerOfType(attacker, 'GHOST') || isBattlerWeatherAffected(state, WEATHER_FOG_ANY, deps)) {
        if (hasFlag(defender.mon.status2, STATUS2_CURSED) || doesPartnerHaveSameMoveEffect(state, battlerAtk)) {
          score -= 10
        } else if (getHealthPercentage(state, battlerAtk) <= 50) {
          score -= 6
        }
      } else {
        if (!battlerStatCanRise(state, attacker, 1, deps) || !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
        else if (!battlerStatCanRise(state, attacker, 2, deps)) score -= 8
      }
      break
    case 'EFFECT_SPIKES': {
      const layers = state.sides[battlerDef & 1].timers.spikesAmount
      if (layers >= 3) score -= 10
      else if (partnerMoveIsSameNoTarget(state, battlerAtk) && layers === 2) score -= 10
      break
    }
    case 'EFFECT_STEALTH_ROCK':
      if (hasFlag(state.sides[battlerDef & 1].statuses, SIDE_STATUS_STEALTH_ROCK) || partnerMoveIsSameNoTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_TOXIC_SPIKES': {
      const layers = state.sides[battlerDef & 1].timers.toxicSpikesAmount
      if (layers >= 2) score -= 10
      else if (partnerMoveIsSameNoTarget(state, battlerAtk) && layers === 1) score -= 10
      break
    }
    case 'EFFECT_STICKY_WEB':
      // Quirk, reproduced not fixed: the C's own :1268-1272 tests the SAME
      // SIDE_STATUS_STICKY_WEB flag in both branches (unlike Spikes/Toxic
      // Spikes/Stealth Rock, whose second branch checks a DIFFERENT
      // condition) -- the `else if` can only ever be reached when the first
      // branch was already false, making it permanently dead.
      if (hasFlag(state.sides[battlerDef & 1].statuses, SIDE_STATUS_STICKY_WEB)) score -= 10
      else if (partnerMoveIsSameNoTarget(state, battlerAtk) && hasFlag(state.sides[battlerDef & 1].statuses, SIDE_STATUS_STICKY_WEB)) score -= 10
      break
    case 'EFFECT_FORESIGHT':
      if (hasFlag(defender.statuses4, STATUS4_FORESIGHT)) score -= 10
      else if (defender.mon.statStages[7] /* STAT_EVASION */ <= 4 || !isBattlerOfType(defender, 'GHOST') || doesPartnerHaveSameMoveEffect(state, battlerAtk)) score -= 9
      break
    case 'EFFECT_PERISH_SONG': {
      // Doubles branch (:1282-1292) is dead code in singles -- only the else
      // branch (:1293-1297) is reachable.
      if (countUsablePartyMons(state, battlerAtk) === 0 && !selfAbility(attacker, 'ABILITY_SOUNDPROOF') && countUsablePartyMons(state, battlerDef) >= 1) {
        score -= 10
      }
      const foe = foeOf(battlerAtk)
      const foeBattler = state.battlers[foe]
      if ((foeBattler && hasFlag(foeBattler.statuses3, STATUS3_PERISH_SONG)) || selfAbility(defender, 'ABILITY_SOUNDPROOF')) score -= 10
      unmodelled.push("AI_CheckBadMove: IsSoundproof is narrowed to a plain ABILITY_SOUNDPROOF check on the named battler (no partner-side scan, since singles has no partner)")
      break
    }
    default:
      // EFFECT_HIT/EFFECT_POISON_HIT/EFFECT_BURN_HIT/EFFECT_PARALYZE_HIT/
      // EFFECT_CONFUSE_HIT and any other unlisted effect -- :798-804, the
      // damage path. Nothing to score here.
      break
  }

  return { score, unmodelled }
}

/** OnAbsorbContext/OnImmuneContext's shared `moveType`/`moveFlags` half --
 * factored out since both computeIsAbsorbed and computeIsImmune need it. */
function built_flags(move: NonNullable<ReturnType<AiDamageDeps['moveData']>>): Record<string, true> {
  return move.flags ?? {}
}
