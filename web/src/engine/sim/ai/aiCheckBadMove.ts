// AI_CheckBadMove, battle_ai_main.c:488-2164 -- the FULL function. Cycle16
// ported :488-1298 (through EFFECT_PERISH_SONG, "part 1"); this batch
// (cycle17) ports :1299-2164 -- EFFECT_SANDSTORM through the end of the
// effect switch (:2149) plus the function's tail (the recoil-discouragement
// block and the `if (score < 0) score = 0` floor, :2151-2163). The former
// PART2_EFFECTS gap set (every part-2 case label pushing one named "handled
// in part 2" line instead of scoring) is gone now that part 2 is real code --
// removed rather than left dead, per the brief's own instruction.
//
// PART2_EFFECTS' own extraction turned up a latent defect worth recording:
// it was built by a comment-blind `grep -o "case EFFECT_..."` over
// :1299-2163, which also matched SEVEN case labels that only exist inside
// commented-out code at the end of the switch (:2121-2148 -- EFFECT_
// PLASMA_FISTS, EFFECT_SHELL_TRAP, EFFECT_BEAK_BLAST as `//`-commented TODOs,
// and EFFECT_SKY_DROP/EFFECT_NO_RETREAT/EFFECT_EXTREME_EVOBOOST/EFFECT_
// CLANGOROUS_SOUL inside a `/* */` block). None of those seven are live case
// labels in the compiled C -- they fall to `default` there, exactly as they
// do in this port's real switch below (which only contains labels the C
// switch statement itself contains). This was invisible while PART2_EFFECTS
// only gapped moves; it would have become a real scoring bug had a future
// batch trusted that set as "the real part-2 label list" for anything else.
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
//
// PART 2 (cycle17) approximations, gapped by name at each site:
//   - `sAiAbilityRatings[]` (IsAbilityOfRating, EFFECT_ROLE_PLAY) is a
//     per-ability AI-quality-rating table with no JSON export anywhere in
//     this codebase's data pipeline (abilityHooks.json carries hook bodies
//     and bitfields, not a rating score) -- always treated as below the
//     rating-5 threshold.
//   - `GetBattlerSecondaryDamage` (leech seed + nightmare + curse + trap +
//     poison + weather damage summed) has no port: reproducing it exactly
//     would need every one of those five end-of-turn damage formulas
//     re-derived outside endTurn.ts's own module-private helpers. Always
//     treated as 0 at its three call sites (EFFECT_ENDURE, EFFECT_
//     HIT_SWITCH_TARGET, EFFECT_PROTECT).
//   - `GetUsedHeldItem` (the item consumed so far this battle) has no
//     tracking anywhere in state.ts -- always ITEM_NONE, at EFFECT_RECYCLE
//     and EFFECT_BELCH.
//   - `ItemId_GetPocket(...) != POCKET_BERRIES` (EFFECT_NATURAL_GIFT,
//     EFFECT_BELCH) reuses part 1's EFFECT_STUFF_CHEEKS approximation: an
//     item-id substring check for `BERRY` rather than a real pocket lookup.
//   - `gWishFutureKnock.wishCounter[battlerAtk]` (EFFECT_WISH) has no state
//     (FieldState's own doc: "Wish, Future Sight... not modelled yet") --
//     always treated as 0 (no Wish pending).
//   - `IsMyceliumMightActive` (inside CanBeBurned/CanGetFrostbite/CanBleed/
//     CanBeConfused/CanInfatuate) needs "does the CURRENT move ignore type
//     immunity" tracking this batch does not wire -- always false, gapped
//     only when the attacker actually holds Mycelium Might (the only way it
//     could matter).
//   - `IsTrickRoomActive`'s `getMonotypeChampType() == TYPE_FLYING/NORMAL`
//     extensions (a Monotype-challenge-format concept, not modelled anywhere)
//     are dropped; only the plain `STATUS_FIELD_TRICK_ROOM` flag is checked.
//   - `AI_DATA->predictedMoves` (EFFECT_SPITE/MIMIC, EFFECT_ME_FIRST,
//     EFFECT_INSTRUCT, EFFECT_SUCKER_PUNCH, EFFECT_SEMI_INVULNERABLE) reuses
//     part 1's own gap: always MOVE_NONE (no prediction), which is the C's
//     own "no prediction" branch, not an invented substitute.
//   - `CanBattlerGetOrLoseItem`'s species-locked-item exclusions (Genesect+
//     Drive, Silvally+Memory, Arceus+Plate) are ported directly (cheap,
//     3 species checks); `IsItemNegated` (Embargo/Magic Room/Klutz
//     suppression of fling-eligibility) has no port -- always treated as
//     not negated, the common case.
//   - `DoesBattlerHaveAbilityShield`'s ability-loop (`blocksAbilitySuppression`)
//     is ported as a real bitfield scan, but the current abilityHooks.json
//     snapshot has zero abilities with that bitfield set, so the loop is
//     live code that never fires on this data -- not dead code by
//     construction, just empty by data, same distinction MOLD_BREAKABLE_
//     ABILITIES' own doc draws.

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
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_FROSTBITE,
  STATUS1_BLEED,
  STATUS2_SUBSTITUTE,
  STATUS2_NIGHTMARE,
  STATUS2_CURSED,
  STATUS2_CONFUSION,
  STATUS2_WRAPPED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_RECHARGE,
  STATUS2_TORMENT,
  STATUS2_TRANSFORMED,
  STATUS2_DESTINY_BOND,
  STATUS2_INFATUATION,
  STATUS3_LEECHSEED,
  STATUS3_PERISH_SONG,
  STATUS3_ON_AIR,
  STATUS3_UNDERGROUND,
  STATUS3_UNDERWATER,
  STATUS3_PHANTOM_FORCE,
  STATUS3_ROOTED,
  STATUS3_CHARGED_UP,
  STATUS3_AQUA_RING,
  STATUS3_MAGNET_RISE,
  STATUS3_POWER_TRICK,
  STATUS3_IMPRISONED_OTHERS,
  STATUS3_YAWN,
  STATUS3_GASTRO_ACID,
  STATUS3_ALWAYS_HITS,
  STATUS3_LASER_FOCUS,
  STATUS3_TELEKINESIS,
  STATUS3_SMACKED_DOWN,
  STATUS3_EMBARGO,
  STATUS4_COMMANDED,
  STATUS4_FORESIGHT,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_MIST,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_FUTUREATTACK,
  SIDE_STATUS_HAZARDS_ANY,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TERRAIN_ANY,
  STATUS_FIELD_FAIRY_LOCK,
  STATUS_FIELD_MUDSPORT,
  STATUS_FIELD_WATERSPORT,
  STATUS_FIELD_ION_DELUGE,
  STATUS_FIELD_WONDER_ROOM,
  STATUS_FIELD_MAGIC_ROOM,
  STATUS_FIELD_TRICK_ROOM,
  STATUS_FIELD_GRAVITY,
  WEATHER_PRIMAL_ANY,
  WEATHER_SUN_ANY,
  WEATHER_SUN_PRIMAL,
  WEATHER_RAIN_PRIMAL,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_HAIL_ANY,
  WEATHER_FOG_ANY,
} from '../constants'
import { battlerHasAbility } from '../../abilities/dispatch'
import { computeIsAbsorbed, computeIsImmune } from '../../abilities/dispatchCalc'
import { isMagicGuardProtected } from '../endTurn'
import { weatherHasEffect } from '../fieldEndTurn'
import { getWhoStrikesFirst, getBattlerTotalSpeedStat, TOTAL_SPEED_FULL } from '../turnOrder'
import { buildFieldFacts } from '../bridge'
import { aiGetMoveEffectiveness, canIndexMoveFaintTarget, canTargetFaintAi, getHealthPercentage, getRecoilFraction, isTargetingPartner } from './aiScorers'
import { isAbilityPreventingEscape, countUsablePartyMons } from './aiPipeline'
import { aiCalcDamage, type AiDamageDeps } from './aiCalcDamage'
import { AI_FLAG_WILL_SUICIDE } from './aiFlags'
import { idiv } from '../../fixed'

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
export function isValidDoubleBattle(_state: BattleState, _battlerAtk: number): boolean {
  return false
}

export function hasMoveFlag(move: ReturnType<AiDamageDeps['moveData']>, flag: string): boolean {
  return !!move?.flags?.[flag]
}

/** `moveTarget & MOVE_TARGET_USER` -- moves.json's own `target` enum spells
 * this bare 'USER' (dataContext.ts's own SimMoveData.target doc). */
export function moveTargetsUser(move: ReturnType<AiDamageDeps['moveData']>): boolean {
  return move?.target === 'USER'
}

export function isBattlerOfType(battler: BattlerState, type: string): boolean {
  return battler.mon.types.includes(type)
}

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

/** `BattlerHasAbility(battlerDef, ABILITY_X, TRUE)` -- suppressed by Mold
 * Breaker only when the checked ability is actually `breakable`
 * (`MOLD_BREAKABLE_ABILITIES` above), matching `IsSuppressed`'s real gate
 * instead of the uniform "Mold Breaker bypasses every checkMoldBreaker=TRUE
 * read" approximation an earlier revision of this file used. */
export function defAbility(battler: BattlerState, abilityId: string, attackerHasMoldBreaker: boolean): boolean {
  const suppressed = attackerHasMoldBreaker && MOLD_BREAKABLE_SET.has(abilityId)
  return battlerHasAbility(battler.mon.abilities, abilityId, () => suppressed)
}
/** `BattlerHasAbility(battler, ABILITY_X, FALSE)` or a self-check -- never
 * suppressed (see this module's header). */
export function selfAbility(battler: BattlerState, abilityId: string): boolean {
  return battlerHasAbility(battler.mon.abilities, abilityId, () => false)
}

/** IsAbilityOnField, battle_util.c:4803-4811 -- copied rather than imported
 * because fieldEndTurn.ts's own copy is module-private. Mold Breaker is
 * never applied here, matching that copy's own note: there is no single
 * "attacker" for a field-wide scan. */
export function isAbilityOnField(state: BattleState, abilityId: string): boolean {
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
export function isBattlerWeatherAffected(state: BattleState, weatherFlag: number, deps: AiDamageDeps): boolean {
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
export function isPowderImmune(defender: BattlerState, attackerHasMoldBreaker: boolean, deps: AiDamageDeps): boolean {
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
export function shouldLowerStat(defender: BattlerState, stat: number, attackerHasMoldBreaker: boolean, unmodelled: string[]): boolean {
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
export function hasMoveWithSplit(battler: BattlerState, split: 'PHYSICAL' | 'SPECIAL' | 'STATUS', deps: AiDamageDeps): boolean {
  return battler.mon.moves.some((m) => m && deps.moveData(m)?.split === split)
}

/** HasMoveWithType, battle_ai_util.c:1382-1391. */
export function hasMoveWithType(battler: BattlerState, type: string, deps: AiDamageDeps): boolean {
  return battler.mon.moves.some((m) => m && deps.moveData(m)?.type === type)
}

/** IsBattlerIncapacitated, battle_ai_util.c:2019-2028. HasThawingMove is a
 * real moveset scan (moves.json's `thawUser` flag), not a gap. */
export function isBattlerIncapacitated(battler: BattlerState, deps: AiDamageDeps): boolean {
  const hasThawingMove = battler.mon.moves.some((m) => m && deps.moveData(m)?.flags?.thawUser)
  if (hasFlag(battler.mon.status1, STATUS1_FREEZE) && !hasThawingMove) return true
  if (hasFlag(battler.mon.status1, STATUS1_SLEEP)) return true
  if (hasFlag(battler.mon.status2, STATUS2_RECHARGE)) return true // no writer in this sim; kept for parity
  return false
}

/** IsBattlerTrapped, battle_ai_util.c:566-580. `checkSwitch` is always TRUE
 * at both of this batch's call sites (the EFFECT_MEAN_LOOK branch below). */
export function isBattlerTrapped(state: BattleState, battler: BattlerState, checkSwitch: boolean, deps: AiDamageDeps): { trapped: boolean; unmodelled: string[] } {
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
export function canBePoisoned(state: BattleState, attacker: BattlerState, target: BattlerState, _deps: AiDamageDeps): { canPoison: boolean; unmodelled: string[] } {
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
export function canBeParalyzedBase(state: BattleState, target: BattlerState, _deps: AiDamageDeps): { canParalyze: boolean; unmodelled: string[] } {
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
export function aiCanParalyze(state: BattleState, attacker: BattlerState, target: BattlerState, moveId: string, deps: AiDamageDeps): { canParalyze: boolean; unmodelled: string[] } {
  const base = canBeParalyzedBase(state, target, deps)
  if (!base.canParalyze) return base
  const effResult = aiGetMoveEffectiveness(state, moveId, attacker.id, target.id, deps)
  const unmodelled = [...base.unmodelled, ...effResult.unmodelled]
  if (effResult.effectiveness === 0) return { canParalyze: false, unmodelled }
  if (doesSubstituteBlockMove(attacker, target, deps.moveData(moveId), unmodelled)) return { canParalyze: false, unmodelled }
  return { canParalyze: true, unmodelled }
}

/** CanSleep, battle_util.c:5029-5038. */
export function canSleep(state: BattleState, target: BattlerState, _deps: AiDamageDeps): { canSleep: boolean; unmodelled: string[] } {
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
export function canBeConfused(target: BattlerState, unmodelled: string[]): boolean {
  if (hasFlag(target.mon.status2, STATUS2_CONFUSION)) return false
  unmodelled.push('CanBeConfused: IsAbilityStatusProtected(battlerDef, CHECK_CONFUSION) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  return true
}

/** DoesSubstituteBlockMove, battle_script_commands.c:12252-12260. Infiltrates
 * is narrowed to the Infiltrator ability check (its dominant real-world
 * path); the move-specific Sub-piercing exemptions inside the real
 * `Infiltrates` are not modelled. */
export function doesSubstituteBlockMove(attacker: BattlerState, defender: BattlerState, move: ReturnType<AiDamageDeps['moveData']>, unmodelled: string[]): boolean {
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
export function partnerHasSameMoveEffectWithoutTarget(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}
function doesPartnerHaveSameMoveEffect(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}
function partnerMoveIsSameNoTarget(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}

// ---------------------------------------------------------------------------
// Part 2 (cycle17) helpers -- battle_ai_util.c / battle_util.c / battle_script_
// commands.c functions AI_CheckBadMove's :1299-2163 range calls that part 1
// did not already need. Grouped in C source order of first use, not
// alphabetically, so a reader can match this section against the switch below.
// ---------------------------------------------------------------------------

/** PartnerMoveEffectIsWeather/PartnerMoveEffectIsTerrain/PartnerMoveIs/
 * PartnerMoveIsSameAsAttacker, battle_ai_util.c:2325-2364 -- all four start
 * `if (!IsDoubleBattle()) return FALSE;`, so all four always return false on
 * this singles-only build, same as part 1's `partnerHasSameMoveEffectWithoutTarget`
 * family. Ported as real (if unreachable) calls through `isValidDoubleBattle`
 * for the same symmetry reason those are. */
function partnerMoveEffectIsWeather(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}
function partnerMoveEffectIsTerrain(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}
function partnerMoveIs(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}
function partnerMoveIsSameAsAttacker(state: BattleState, battlerAtk: number): boolean {
  return isValidDoubleBattle(state, battlerAtk)
}

/** AnyStatIsRaised, battle_ai_util.c:1313-1320. */
export function anyStatIsRaised(battler: BattlerState): boolean {
  for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
    if (battler.mon.statStages[i] > 6 /* DEFAULT_STAT_STAGE */) return true
  }
  return false
}

/** CountPositiveStatStages / CountNegativeStatStages, battle_ai_util.c:1322-1338. */
export function countPositiveStatStages(battler: BattlerState): number {
  let count = 0
  for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) if (battler.mon.statStages[i] > 6) count++
  return count
}
export function countNegativeStatStages(battler: BattlerState): number {
  let count = 0
  for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) if (battler.mon.statStages[i] < 6) count++
  return count
}

/** IsStickyHold, battle_util.c:9329-9333 -- `BattlerHasAbility(battler, X,
 * TRUE)` on the DEFENDER, so it goes through `defAbility` (real Mold-Breaker
 * gating; both Sticky Hold and Supersweet Syrup are in MOLD_BREAKABLE_ABILITIES). */
export function isStickyHold(defender: BattlerState, attackerHasMoldBreaker: boolean): boolean {
  return defAbility(defender, 'ABILITY_STICKY_HOLD', attackerHasMoldBreaker) || defAbility(defender, 'ABILITY_SUPERSWEET_SYRUP', attackerHasMoldBreaker)
}

/** AI_CanBurn/CanBeBurned, battle_ai_util.c:2079-2084 + battle_util.c:5061-5069.
 * IsMyceliumMightActive and IsStatusImmune(CHECK_BURN) both need ability-hook
 * wiring this batch does not have -- same gap shape as part 1's canBePoisoned/
 * canSleep/canBeParalyzedBase/canBeConfused. */
export function aiCanBurn(defender: BattlerState, unmodelled: string[]): boolean {
  if (hasFlag(defender.mon.status1, STATUS1_ANY)) return false
  if (isBattlerOfType(defender, 'FIRE')) return false
  unmodelled.push('AI_CanBurn/CanBeBurned: IsMyceliumMightActive is gapped (no current-move-ignores-immunity tracking) and IsStatusImmune(battlerDef, CHECK_BURN) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  return true
}

/** AI_CanGiveFrostbite/CanGetFrostbite, battle_ai_util.c:2086-2093 +
 * battle_util.c:5096-5104. `iceStatue` is read from the real
 * `volatiles.iceStatue` field (an earlier revision gapped it as unported; the
 * field exists on VolatileState, default false). IsMyceliumMightActive stays
 * gapped, as for the other CanBe* helpers. Effectiveness/Substitute are
 * re-checked the same way part 1's aiCanParalyze does for its own status. */
export function canGetFrostbite(battler: BattlerState, unmodelled: string[]): boolean {
  if (hasFlag(battler.mon.status1, STATUS1_ANY)) return false
  if (!battler.volatiles.iceStatue && isBattlerOfType(battler, 'ICE')) return false
  unmodelled.push('AI_CanGiveFrostbite/CanGetFrostbite: IsStatusImmune(battlerDef, CHECK_FROSTBITE) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  return true
}
export function aiCanGiveFrostbite(state: BattleState, attacker: BattlerState, defender: BattlerState, moveId: string, deps: AiDamageDeps): { can: boolean; unmodelled: string[] } {
  const unmodelled: string[] = []
  if (!canGetFrostbite(defender, unmodelled)) return { can: false, unmodelled }
  const effResult = aiGetMoveEffectiveness(state, moveId, attacker.id, defender.id, deps)
  unmodelled.push(...effResult.unmodelled)
  if (effResult.effectiveness === 0) return { can: false, unmodelled }
  if (doesSubstituteBlockMove(attacker, defender, deps.moveData(moveId), unmodelled)) return { can: false, unmodelled }
  return { can: true, unmodelled }
}

/** AI_CanCauseBleed/CanBleed, battle_ai_util.c:2095-2102 + battle_util.c:5106-5114. */
function aiCanCauseBleed(state: BattleState, attacker: BattlerState, defender: BattlerState, moveId: string, deps: AiDamageDeps): { can: boolean; unmodelled: string[] } {
  const unmodelled: string[] = []
  if (hasFlag(defender.mon.status1, STATUS1_ANY)) return { can: false, unmodelled }
  unmodelled.push('AI_CanCauseBleed/CanBleed: IsStatusImmune(battlerDef, CHECK_BLEED) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  if (isBattlerOfType(defender, 'ROCK') || isBattlerOfType(defender, 'GHOST')) return { can: false, unmodelled }
  const effResult = aiGetMoveEffectiveness(state, moveId, attacker.id, defender.id, deps)
  unmodelled.push(...effResult.unmodelled)
  if (effResult.effectiveness === 0) return { can: false, unmodelled }
  if (doesSubstituteBlockMove(attacker, defender, deps.moveData(moveId), unmodelled)) return { can: false, unmodelled }
  return { can: true, unmodelled }
}

/** AI_CanBeInfatuated/CanInfatuate, battle_ai_util.c:2104 + battle_util.c:5135-5143. */
function canInfatuate(attacker: BattlerState, defender: BattlerState, unmodelled: string[]): boolean {
  if (hasFlag(defender.mon.status2, STATUS2_INFATUATION)) return false
  if (attacker.id === defender.id) return false
  unmodelled.push('AI_CanBeInfatuated/CanInfatuate: IsAbilityStatusProtected(battlerDef, CHECK_INFATUATE) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  return true
}

/** Every ability whose abilityHooks.json marks `persistent` or `unsuppressable`
 * -- IsPersistentOrUnsuppressableAbility, battle_util.c:4790
 * (`gAbilities[ability].unsuppressable || gAbilities[ability].persistent`).
 * Feeds IsRolePlayBannedAbility(Atk)/IsWorrySeedBannedAbility/
 * IsEntrainmentBannedAbilityAttacker/IsEntrainmentTargetOrSimpleBeamBannedAbility
 * below -- every one of those is this same predicate plus (for four of them) a
 * short literal extra-abilities array taken straight from the C's own static
 * tables. Pinned by an oracle test in aiCheckBadMove.test.ts.
 *
 * Extraction: `python3 -c "import json; d=json.load(open('data/v2.65beta/
 * abilityHooks.json')); b=lambda v:v.get('bitfields',{}); print(sorted(k for
 * k,v in d.items() if b(v).get('persistent') or b(v).get('unsuppressable')))"`
 * -- 47 entries. */
export const PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES: readonly string[] = [
  'ABILITY_ANTICIPATION', 'ABILITY_AS_ONE_ICE_RIDER', 'ABILITY_AS_ONE_SHADOW_RIDER', 'ABILITY_BACKUP_POWER', 'ABILITY_BATTLE_BOND',
  'ABILITY_BLOOD_STAIN', 'ABILITY_BLOOD_STIGMA', 'ABILITY_CHEATING_DEATH', 'ABILITY_CLUELESS', 'ABILITY_COMATOSE',
  'ABILITY_COMMANDER', 'ABILITY_COWARD', 'ABILITY_CROWNED_KING', 'ABILITY_DISGUISE', 'ABILITY_DNA_SCRAMBLE',
  'ABILITY_DRAKELP_HEAD', 'ABILITY_DREAMSCAPE', 'ABILITY_DUAL_SHADOW', 'ABILITY_EJECT_PACK_ABILITY', 'ABILITY_ENERGIZED',
  'ABILITY_ETERNAL_BLESSING', 'ABILITY_FLAMMABLE_COAT', 'ABILITY_FLOWER_GIFT', 'ABILITY_FORECAST', 'ABILITY_GALLANTRY',
  'ABILITY_GENERATOR', 'ABILITY_GULP_MISSILE', 'ABILITY_HUNGER_SWITCH', 'ABILITY_ICE_FACE', 'ABILITY_JUMP_SCARE',
  'ABILITY_LOCUST_SWARM', 'ABILITY_MULTITYPE', 'ABILITY_NEUTRALIZING_GAS', 'ABILITY_PATCHWORK', 'ABILITY_POWER_CONSTRUCT',
  'ABILITY_POWER_OUTAGE', 'ABILITY_RECURRING_NIGHTMARE', 'ABILITY_REVELATION', 'ABILITY_RKS_SYSTEM', 'ABILITY_SCHOOLING',
  'ABILITY_SHIELDS_DOWN', 'ABILITY_SOOTHSAYER', 'ABILITY_STALWART', 'ABILITY_STANCE_CHANGE', 'ABILITY_WISHMAKER',
  'ABILITY_ZEN_MODE', 'ABILITY_ZERO_TO_HERO',
]
const PERSISTENT_OR_UNSUPPRESSABLE_SET = new Set(PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES)

/** IsRolePlayBannedAbilityAtk, battle_util.c:8422-8425. */
export function isRolePlayBannedAbilityAtk(ability: string | null): boolean {
  return !!ability && PERSISTENT_OR_UNSUPPRESSABLE_SET.has(ability)
}
/** IsRolePlayBannedAbility, battle_util.c:8428-8436 -- `sRolePlayBannedAbilities`
 * (:90-95) transcribed literally (4 entries, unchanged from vanilla; Prismatic
 * Fur is this game's own addition). `!ability` (ABILITY_NONE) is also banned. */
const ROLE_PLAY_BANNED_EXTRA = new Set(['ABILITY_TRACE', 'ABILITY_WONDER_GUARD', 'ABILITY_RECEIVER', 'ABILITY_PRISMATIC_FUR'])
export function isRolePlayBannedAbility(ability: string | null): boolean {
  if (!ability || ability === 'ABILITY_NONE') return true
  return PERSISTENT_OR_UNSUPPRESSABLE_SET.has(ability) || ROLE_PLAY_BANNED_EXTRA.has(ability)
}
/** IsWorrySeedBannedAbility, battle_util.c:8438-8441. */
function isWorrySeedBannedAbility(ability: string | null): boolean {
  return !!ability && PERSISTENT_OR_UNSUPPRESSABLE_SET.has(ability)
}
/** IsEntrainmentBannedAbilityAttacker, battle_util.c:8448-8455 --
 * `sSkillSwapBannedAbilities` (:85-88) transcribed literally. */
const SKILL_SWAP_BANNED = new Set(['ABILITY_WONDER_GUARD', 'ABILITY_PRISMATIC_FUR'])
function isEntrainmentBannedAbilityAttacker(ability: string | null): boolean {
  return !!ability && (PERSISTENT_OR_UNSUPPRESSABLE_SET.has(ability) || SKILL_SWAP_BANNED.has(ability))
}
/** IsEntrainmentTargetOrSimpleBeamBannedAbility, battle_util.c:8457-8464 --
 * `sEntrainmentTargetSimpleBeamBannedAbilities` (:97-99) is just Truant. */
function isEntrainmentTargetOrSimpleBeamBannedAbility(ability: string | null): boolean {
  return !!ability && (PERSISTENT_OR_UNSUPPRESSABLE_SET.has(ability) || ability === 'ABILITY_TRUANT')
}

/** GetBattlerAbility, battle_util.c:9327 -- the primary ability SLOT only
 * (`abilities[0]`), unlike `defAbility`/`selfAbility`'s innate-inclusive
 * scans. `ABILITY_NONE` for a battler with no ability set. */
export function battlerAbility(battler: BattlerState): string {
  return battler.mon.abilities.ability ?? 'ABILITY_NONE'
}

/** DoesBattlerHaveAbilityShield, battle_util.c:6539-6545. The
 * `blocksAbilitySuppression` bitfield scan is real (not hardcoded false) but
 * the current abilityHooks.json snapshot has zero abilities carrying it, so
 * this loop never actually fires on this data -- see this module's header. */
const BLOCKS_ABILITY_SUPPRESSION_ABILITIES: readonly string[] = []
function doesBattlerHaveAbilityShield(battler: BattlerState, deps: AiDamageDeps): boolean {
  const abilitySlots = [battler.mon.abilities.ability, ...battler.mon.abilities.innates].filter((x): x is string => !!x)
  if (abilitySlots.some((id) => BLOCKS_ABILITY_SUPPRESSION_ABILITIES.includes(id))) return true
  if (getBattlerHoldEffect(battler, deps) !== 'HOLD_EFFECT_ABILITY_SHIELD') return false
  return !hasFlag(battler.statuses3, STATUS3_EMBARGO)
}

/** IsInstructBannedMove / MoveRequiresRecharging / MoveCallsOtherMove,
 * battle_ai_util.c:392-419 (`sInstructBannedMoves`/`sRechargeMoves`/
 * `sOtherMoveCallingMoves`), transcribed literally. */
const INSTRUCT_BANNED_MOVES = new Set([
  'MOVE_INSTRUCT', 'MOVE_BIDE', 'MOVE_FOCUS_PUNCH', 'MOVE_BEAK_BLAST', 'MOVE_SHELL_TRAP', 'MOVE_SKETCH', 'MOVE_TRANSFORM',
  'MOVE_MIMIC', 'MOVE_KINGS_SHIELD', 'MOVE_STRUGGLE', 'MOVE_BOUNCE', 'MOVE_DIG', 'MOVE_DIVE', 'MOVE_FLY',
  'MOVE_FREEZE_SHOCK', 'MOVE_GEOMANCY', 'MOVE_ICE_BURN', 'MOVE_PHANTOM_FORCE', 'MOVE_RAZOR_WIND', 'MOVE_SHADOW_FORCE', 'MOVE_SKULL_BASH',
  'MOVE_SKY_ATTACK', 'MOVE_SKY_DROP', 'MOVE_SOLAR_BEAM', 'MOVE_SOLAR_BLADE',
])
const RECHARGE_MOVES = new Set([
  'MOVE_HYPER_BEAM', 'MOVE_BLAST_BURN', 'MOVE_HYDRO_CANNON', 'MOVE_FRENZY_PLANT', 'MOVE_GIGA_IMPACT',
  'MOVE_ROCK_WRECKER', 'MOVE_ROAR_OF_TIME', 'MOVE_PRISMATIC_LASER', 'MOVE_METEOR_ASSAULT', 'MOVE_ETERNABEAM',
])
const OTHER_MOVE_CALLING_MOVES = new Set(['MOVE_ASSIST', 'MOVE_COPYCAT', 'MOVE_ME_FIRST', 'MOVE_METRONOME', 'MOVE_MIRROR_MOVE', 'MOVE_NATURE_POWER', 'MOVE_SLEEP_TALK'])
function isInstructBannedMove(moveId: string | null): boolean {
  return !!moveId && INSTRUCT_BANNED_MOVES.has(moveId)
}
function moveRequiresRecharging(moveId: string | null): boolean {
  return !!moveId && RECHARGE_MOVES.has(moveId)
}
function moveCallsOtherMove(moveId: string | null): boolean {
  return !!moveId && OTHER_MOVE_CALLING_MOVES.has(moveId)
}

/** IsHazardMoveEffect, battle_ai_util.c:1118-1127 -- EFFECT_DEFOG's own call
 * site (:1677) is inside the isDoubleBattle-gated "partner is about to set up
 * hazards" pre-empt, which is dead code in singles (this module's header),
 * so this helper has no live call site here; kept undefined intentionally
 * (not ported as unreachable dead code, unlike the isValidDoubleBattle-gated
 * helpers, since there is nothing here that would ever call it). */

/** TERRAIN_HAS_EFFECT, include/battle_util.h:47 -- `!IsAbilityOnField(ABILITY_CLUELESS)`. */
function terrainHasEffect(state: BattleState): boolean {
  return !isAbilityOnField(state, 'ABILITY_CLUELESS')
}
/** GetCurrentTerrain, battle_util.c:8665-8669. Returns one of the
 * STATUS_FIELD_*_TERRAIN bit values, or 0 for no terrain / Clueless on field. */
export function getCurrentTerrain(state: BattleState): number {
  if (!terrainHasEffect(state)) return 0
  return state.field.statuses & STATUS_FIELD_TERRAIN_ANY
}
/** GetNaturePowerMove, battle_script_commands.c:11634-11645. The
 * `sNaturePowerMoves[gBattleTerrain]` map-location fallback (used when no
 * battle terrain is active) needs overworld-map terrain data this sim has no
 * concept of -- gapped, defaulting to the C's own MOVE_TRI_ATTACK fallback
 * (its `sNaturePowerMoves[gBattleTerrain] == MOVE_NONE` branch), rather than
 * the specific per-location move the C would actually pick. */
export function getNaturePowerMove(state: BattleState, unmodelled: string[]): string {
  const terrain = getCurrentTerrain(state)
  if (terrain === STATUS_FIELD_MISTY_TERRAIN) return 'MOVE_MOONBLAST'
  if (terrain === STATUS_FIELD_ELECTRIC_TERRAIN) return 'MOVE_THUNDERBOLT'
  if (terrain === STATUS_FIELD_GRASSY_TERRAIN) return 'MOVE_ENERGY_BALL'
  if (terrain === STATUS_FIELD_PSYCHIC_TERRAIN) return 'MOVE_PSYCHIC'
  unmodelled.push('GetNaturePowerMove: sNaturePowerMoves[gBattleTerrain] (the overworld-map-location fallback) has no port -- this sim has no map-terrain concept; defaulting to MOVE_TRI_ATTACK, the C\'s own fallback for an unmapped location')
  return 'MOVE_TRI_ATTACK'
}

/** IsGravityActive, battle_util.c:8689-8695. */
function isGravityActive(state: BattleState): boolean {
  return !isAbilityOnField(state, 'ABILITY_CLUELESS') && hasFlag(state.field.statuses, STATUS_FIELD_GRAVITY)
}
/** isMagicRoomActive, battle_util.c:8698-8704 (same shape as IsGravityActive). */
function isMagicRoomActive(state: BattleState): boolean {
  return !isAbilityOnField(state, 'ABILITY_CLUELESS') && hasFlag(state.field.statuses, STATUS_FIELD_MAGIC_ROOM)
}
/** IsTrickRoomActive, battle_util.c:8671-8677 -- `getMonotypeChampType() ==
 * TYPE_FLYING/TYPE_NORMAL` (a Monotype-challenge-format concept) is not
 * modelled anywhere in this codebase; only the plain field-status flag is
 * checked (this module's header). */
function isTrickRoomActive(state: BattleState): boolean {
  return !isAbilityOnField(state, 'ABILITY_CLUELESS') && hasFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM)
}
/** GetBattlerSideSpeedAverage, battle_ai_util.c:2181-2196 -- in singles
 * (`IsDoubleBattle()` false) this is just the battler's own fully-resolved
 * speed stat (numBattlersAlive always 1), so `getBattlerTotalSpeedStat` with
 * TOTAL_SPEED_FULL and no move context is reused directly rather than
 * re-deriving the averaging (which is dead code on this build anyway). */
export function getBattlerSideSpeedAverage(state: BattleState, battlerId: number, deps: AiDamageDeps): number {
  return getBattlerTotalSpeedStat(state, battlerId, TOTAL_SPEED_FULL, null, deps.turnOrder, deps.statStageRatios)
}

/** CanFling, battle_util.c:8414-8420. `IsItemNegated` (Embargo/Magic Room/
 * Klutz suppression of fling-eligibility) has no port -- treated as not
 * negated (the common case), gapped by name. The species-locked-item
 * exclusions inside CanBattlerGetOrLoseItem (:8250-8270 -- Enigma Berry,
 * Primal Orb, Mega Stone, and the three species+hold-effect pairs) ARE
 * ported since they are three cheap direct comparisons, not a scan. */
export function canBattlerGetOrLoseItemApprox(battler: BattlerState, itemId: string, deps: AiDamageDeps): boolean {
  if (itemId === 'ITEM_ENIGMA_BERRY') return false
  const holdEffect = deps.dataContext.item(itemId)?.resolvedHoldEffect ?? null
  if (holdEffect === 'HOLD_EFFECT_PRIMAL_ORB' || holdEffect === 'HOLD_EFFECT_MEGA_STONE') return false
  const species = battler.mon.speciesId
  if (species.startsWith('SPECIES_GENESECT') && holdEffect === 'HOLD_EFFECT_DRIVE') return false
  if (species.startsWith('SPECIES_SILVALLY') && holdEffect === 'HOLD_EFFECT_MEMORY') return false
  if (species.startsWith('SPECIES_ARCEUS') && holdEffect === 'HOLD_EFFECT_PLATE') return false
  return true
}
function canFling(attacker: BattlerState, deps: AiDamageDeps, unmodelled: string[]): boolean {
  const itemId = attacker.mon.itemId
  if (!itemId) return false
  unmodelled.push('CanFling: IsItemNegated (Embargo/Magic Room/Klutz suppression) has no port; treated as not negated')
  return canBattlerGetOrLoseItemApprox(attacker, itemId, deps)
}

/** CanCamouflage, battle_script_commands.c:12313-12316 -- `sTerrainToType[gBattleTerrain]`
 * is the SAME overworld-map-location concept GetNaturePowerMove's fallback
 * needs and this sim has no port for; approximated as "always able to
 * Camouflage" (the C's own default when no terrain-changing type applies),
 * gapped by name. */
function canCamouflage(unmodelled: string[]): boolean {
  unmodelled.push("CanCamouflage: sTerrainToType[gBattleTerrain] (overworld-map-location type) has no port; treated as the map's type never matching the attacker's own, i.e. Camouflage is always usable")
  return true
}

/** CanUseLastResort, battle_script_commands.c:6481-6489 -- `usedMoves` is a
 * per-slot reveal BITMASK on `gVolatileStructs`, distinct from
 * BattleHistoryState's own `usedMoves` (see state.ts's own doc). Checked via
 * `battler.volatiles.usedMoves` bit `1 << i`. */
function canUseLastResort(battler: BattlerState): boolean {
  for (let i = 0; i < battler.mon.moves.length; i++) {
    const moveId = battler.mon.moves[i]
    if (!moveId) continue
    if (moveId === 'MOVE_LAST_RESORT') continue
    if (hasFlag(battler.volatiles.usedMoves, 1 << i)) continue
    return false
  }
  return true
}

/** IsTelekinesisBannedSpecies, battle_script_commands.c:13007-13022
 * (`sTelekinesisBanList`), restricted to the base-game entries -- the
 * `#ifdef POKEMON_EXPANSION` entries (Alolan Diglett/Dugtrio, Sandygast/
 * Palossand, Mega Gengar) are compiled in on this build (Elite Redux is a
 * post-Gen-7-content hack), so all eight are included. */
const TELEKINESIS_BANNED_SPECIES = new Set([
  'SPECIES_DIGLETT', 'SPECIES_DUGTRIO', 'SPECIES_DIGLETT_ALOLAN', 'SPECIES_DUGTRIO_ALOLAN', 'SPECIES_SANDYGAST', 'SPECIES_PALOSSAND', 'SPECIES_GENGAR_MEGA',
])
function isTelekinesisBannedSpecies(speciesId: string): boolean {
  return TELEKINESIS_BANNED_SPECIES.has(speciesId)
}

/** Every ability whose abilityHooks.json marks `noRecoil` -- BlocksRecoil,
 * battle_ai_main.c:476-479 (`RETURN_ABILITY_IF_FLAG(battler, FALSE, noRecoil)`,
 * checkMoldBreaker=FALSE, so `selfAbility` -- never suppressed). Pinned by an
 * oracle test. Extraction: same query as PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES
 * with `bitfields.noRecoil` -- 3 entries. */
export const NO_RECOIL_ABILITIES: readonly string[] = ['ABILITY_BRUTEFORCE', 'ABILITY_ROCK_HEAD', 'ABILITY_STEEL_BARREL']
/** Every ability whose abilityHooks.json marks `halfRecoil` -- ReducesRecoil,
 * battle_ai_main.c:481-484. Extraction: `bitfields.halfRecoil` -- 2 entries. */
export const HALF_RECOIL_ABILITIES: readonly string[] = ['ABILITY_DAREDEVIL', 'ABILITY_LIMBER']
function blocksRecoil(battler: BattlerState): boolean {
  return NO_RECOIL_ABILITIES.some((id) => selfAbility(battler, id))
}
function reducesRecoil(battler: BattlerState): boolean {
  return HALF_RECOIL_ABILITIES.some((id) => selfAbility(battler, id))
}

/** CanAIFaintTarget, battle_ai_util.c:972-989, called with numHits=0 at this
 * batch's one call site (the recoil tail). `AI_DATA->moveLimitations` is not
 * modelled (nothing is limited), same precedent aiScorers.ts's own
 * `canTargetFaintAi` doc already establishes for the identical dependency --
 * this is the mirror-image helper (the AI's OWN moves against the target,
 * where canTargetFaintAi checks the target's moves against the AI). */
function canAiFaintTargetOwnMoves(state: BattleState, battlerAtk: number, battlerDef: number, deps: AiDamageDeps): { canFaint: boolean; unmodelled: string[] } {
  const attackerMon = state.battlers[battlerAtk]?.mon
  const defenderMon = state.battlers[battlerDef]?.mon
  if (!attackerMon || !defenderMon) return { canFaint: false, unmodelled: [] }
  const unmodelled: string[] = []
  for (const moveId of attackerMon.moves) {
    if (!moveId) continue
    const { dmg, unmodelled: u } = aiCalcDamage(state, moveId, battlerAtk, battlerDef, deps)
    unmodelled.push(...u)
    if (defenderMon.hp <= dmg) return { canFaint: true, unmodelled }
  }
  return { canFaint: false, unmodelled }
}
/** ShouldUseRecoilMove, battle_ai_util.c:2199-2210. */
function shouldUseRecoilMove(state: BattleState, battlerAtk: number, battlerDef: number, recoilDmg: number, deps: AiDamageDeps): { should: boolean; unmodelled: string[] } {
  const atkHp = state.battlers[battlerAtk]?.mon.hp ?? 0
  const defHp = state.battlers[battlerDef]?.mon.hp ?? 0
  if (recoilDmg >= atkHp && countUsablePartyMons(state, battlerDef) !== 0) {
    if (recoilDmg >= defHp) {
      // If this recoil move is the only way to KO the target, use it anyway.
      const faintCheck = canAiFaintTargetOwnMoves(state, battlerAtk, battlerDef, deps)
      if (!faintCheck.canFaint) return { should: true, unmodelled: faintCheck.unmodelled }
      return { should: false, unmodelled: faintCheck.unmodelled } // a non-recoil move can already win -- prefer it
    }
    return { should: false, unmodelled: [] } // will faint and not win -- not worth it
  }
  return { should: true, unmodelled: [] }
}

/** `ItemId_GetPocket(item) != POCKET_BERRIES`, reused from part 1's
 * EFFECT_STUFF_CHEEKS approximation (a berry-name substring check, not a
 * real pocket lookup) for EFFECT_NATURAL_GIFT and EFFECT_BELCH. */
function looksLikeBerry(itemId: string | null): boolean {
  return !!itemId && itemId.includes('BERRY')
}

/** AtMaxHp, battle_ai_util.c:561-563. */
export function atMaxHp(battler: BattlerState): boolean {
  return battler.mon.hp === battler.mon.maxHp
}

/** C `u8` truncation, for locals the C declares `u8` (Power/Guard Split). */
export function u8(value: number): number {
  return value & 0xff
}

/** Every ability whose abilityHooks.json marks `chloroplast` -- HasChloroplast,
 * battle_util.c:9340-9343 (`RETURN_ABILITY_IF_FLAG(battler, FALSE, chloroplast)`).
 * Extraction: same query as PERSISTENT_OR_UNSUPPRESSABLE_ABILITIES with
 * `bitfields.chloroplast` -- 3 entries. */
export const CHLOROPLAST_ABILITIES: readonly string[] = ['ABILITY_BIG_LEAVES', 'ABILITY_CHLOROPLAST', 'ABILITY_SOLAR_FLARE']

/**
 * AI_CheckBadMove, battle_ai_main.c:488-2164 (the full function, part 1 +
 * part 2). See this module's header for scope and approximations. Neither
 * part ever needs the caller's own move-slot index: no EFFECT_HIDDEN_POWER
 * case label exists anywhere in this switch (Hidden Power's variable type is
 * handled once, generically, by `moveType`/`VARIABLE_TYPE_EFFECTS` above),
 * so there is nothing for a `moveIndex` parameter to do here.
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

  // :797-2149 -- move effects.
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
    // -------------------------------------------------------------------
    // Part 2 (cycle17), battle_ai_main.c:1299-2149.
    // -------------------------------------------------------------------
    case 'EFFECT_SANDSTORM':
      if (hasFlag(state.field.weather, WEATHER_SANDSTORM_ANY | WEATHER_PRIMAL_ANY) || partnerMoveEffectIsWeather(state, battlerAtk)) score -= 8
      break
    case 'EFFECT_SUNNY_DAY':
      if (hasFlag(state.field.weather, WEATHER_SUN_ANY | WEATHER_PRIMAL_ANY) || partnerMoveEffectIsWeather(state, battlerAtk)) score -= 8
      break
    case 'EFFECT_RAIN_DANCE':
      if (hasFlag(state.field.weather, WEATHER_RAIN_ANY | WEATHER_PRIMAL_ANY) || partnerMoveEffectIsWeather(state, battlerAtk)) score -= 8
      break
    case 'EFFECT_HAIL':
      if (hasFlag(state.field.weather, WEATHER_HAIL_ANY | WEATHER_PRIMAL_ANY) || partnerMoveEffectIsWeather(state, battlerAtk)) score -= 8
      break
    case 'EFFECT_ATTRACT':
      if (!canInfatuate(attacker, defender, unmodelled)) score -= 10
      break
    case 'EFFECT_SAFEGUARD':
      if (hasFlag(state.sides[battlerAtk & 1].statuses, SIDE_STATUS_SAFEGUARD) || partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_PARTING_SHOT':
      if (countUsablePartyMons(state, battlerAtk) === 0) score -= 10
      break
    case 'EFFECT_BATON_PASS':
      if (countUsablePartyMons(state, battlerAtk) === 0) {
        score -= 10
      } else if (
        hasFlag(attacker.mon.status2, STATUS2_SUBSTITUTE) ||
        hasFlag(attacker.statuses3, STATUS3_ROOTED | STATUS3_AQUA_RING | STATUS3_MAGNET_RISE | STATUS3_POWER_TRICK) ||
        anyStatIsRaised(attacker)
      ) {
        // no score change -- matches the C's bare `break` here.
      } else {
        score -= 6
      }
      break
    case 'EFFECT_HIT_ESCAPE':
      break
    case 'EFFECT_RAPID_SPIN':
      if (hasFlag(attacker.mon.status2, STATUS2_WRAPPED) || hasFlag(attacker.statuses3, STATUS3_LEECHSEED)) {
        // check damage/accuracy -- break, no change.
      } else if (!hasFlag(state.sides[battlerAtk & 1].statuses, SIDE_STATUS_HAZARDS_ANY)) {
        score -= 6
      }
      break
    case 'EFFECT_BELLY_DRUM':
      if (selfAbility(attacker, 'ABILITY_CONTRARY')) score -= 10
      else if (getHealthPercentage(state, battlerAtk) <= 60) score -= 10
      break
    case 'EFFECT_FUTURE_SIGHT':
      if (hasFlag(state.sides[battlerDef & 1].statuses, SIDE_STATUS_FUTUREATTACK) || hasFlag(state.sides[battlerAtk & 1].statuses, SIDE_STATUS_FUTUREATTACK)) {
        score -= 12
      } else {
        score += 5
      }
      break
    case 'EFFECT_SWITCH_ARGUMENT':
      score -= 10
      break
    case 'EFFECT_FAKE_OUT': {
      if (!attacker.volatiles.isFirstTurn) {
        score -= 30
      } else if (moveId === 'MOVE_FAKE_OUT') {
        // filter out First Impression, which shares this effect.
        const holdEffect = getBattlerHoldEffect(attacker, deps)
        if (holdEffect === 'HOLD_EFFECT_CHOICE_BAND' || selfAbility(attacker, 'ABILITY_GORILLA_TACTICS')) {
          const faintCheck = canIndexMoveFaintTarget(state, battlerAtk, battlerDef, moveId, 0, deps)
          unmodelled.push(...faintCheck.unmodelled)
          if (countUsablePartyMons(state, battlerDef) > 0 || !faintCheck.faints) {
            if (countUsablePartyMons(state, battlerAtk) === 0) score -= 10
          }
        }
      }
      break
    }
    case 'EFFECT_STOCKPILE':
      if (attacker.volatiles.stockpileCounter >= 3) score -= 10
      break
    case 'EFFECT_SWALLOW':
      if (attacker.volatiles.stockpileCounter === 0) {
        score -= 10
      } else if (atMaxHp(attacker)) {
        score -= 10
      } else if (getHealthPercentage(state, battlerAtk) >= 80) {
        score -= 5 // do it if nothing better
      }
      break
    case 'EFFECT_TORMENT': {
      if (hasFlag(defender.mon.status2, STATUS2_TORMENT) || doesPartnerHaveSameMoveEffect(state, battlerAtk)) {
        score -= 10
        break
      }
      if (getBattlerHoldEffect(defender, deps) === 'HOLD_EFFECT_MENTAL_HERB') {
        unmodelled.push("AI_CheckBadMove: B_MENTAL_HERB >= GEN_5 is assumed true, same modern-gen-ruleset assumption as EFFECT_SUBSTITUTE's B_SOUND_SUBSTITUTE check")
        score -= 6
      }
      break
    }
    case 'EFFECT_WILL_O_WISP':
      if (!aiCanBurn(defender, unmodelled) || isMagicGuardProtected(state, defender)) score -= 10
      break
    case 'EFFECT_MEMENTO':
      if (countUsablePartyMons(state, battlerAtk) === 0 || doesPartnerHaveSameMoveEffect(state, battlerAtk)) {
        score -= 10
      } else if (!shouldLowerStat(defender, 1 /* STAT_ATK */, atkMoldBreaker, unmodelled) || !shouldLowerStat(defender, 4 /* STAT_SPATK */, atkMoldBreaker, unmodelled)) {
        score -= 10
      }
      break
    case 'EFFECT_FOLLOW_ME':
    case 'EFFECT_HELPING_HAND':
      // isDoubleBattle is always false -- `!isDoubleBattle` (the C's first OR
      // operand) is always true, so every other operand (partner alive,
      // partner's move, partner switching) is unreachable; always -10.
      score -= 10
      break
    case 'EFFECT_TRICK':
    case 'EFFECT_KNOCK_OFF':
      if (isStickyHold(defender, atkMoldBreaker)) score -= 10
      break
    case 'EFFECT_POLTERGEIST':
      if (!defender.mon.itemId) score -= 20
      break
    case 'EFFECT_INGRAIN':
      if (hasFlag(attacker.statuses3, STATUS3_ROOTED)) score -= 10
      break
    case 'EFFECT_AQUA_RING':
      if (hasFlag(attacker.statuses3, STATUS3_AQUA_RING)) score -= 10
      break
    case 'EFFECT_RECYCLE':
      unmodelled.push('AI_CheckBadMove: GetUsedHeldItem has no consumed-item tracking anywhere in state.ts; treated as ITEM_NONE, so this condition is always true regardless of the attacker\'s current item')
      score -= 10
      break
    case 'EFFECT_IMPRISON':
      if (hasFlag(attacker.statuses3, STATUS3_IMPRISONED_OTHERS)) score -= 10
      break
    case 'EFFECT_REFRESH':
      if (!hasFlag(defender.mon.status1, STATUS1_POISON_ANY | STATUS1_BURN | STATUS1_PARALYSIS | STATUS1_FROSTBITE | STATUS1_BLEED)) score -= 10
      break
    case 'EFFECT_PSYCHO_SHIFT': {
      if (hasFlag(attacker.mon.status1, STATUS1_POISON_ANY)) {
        const r = canBePoisoned(state, attacker, defender, deps)
        unmodelled.push(...r.unmodelled)
        if (!r.canPoison) score -= 10
      } else if (hasFlag(attacker.mon.status1, STATUS1_BURN)) {
        if (!aiCanBurn(defender, unmodelled)) score -= 10
      } else if (hasFlag(attacker.mon.status1, STATUS1_FROSTBITE)) {
        const r = aiCanGiveFrostbite(state, attacker, defender, moveId, deps)
        unmodelled.push(...r.unmodelled)
        if (!r.can) score -= 10
      } else if (hasFlag(attacker.mon.status1, STATUS1_PARALYSIS)) {
        const r = aiCanParalyze(state, attacker, defender, moveId, deps)
        unmodelled.push(...r.unmodelled)
        if (!r.canParalyze) score -= 10
      } else if (hasFlag(attacker.mon.status1, STATUS1_SLEEP)) {
        const r = canSleep(state, defender, deps)
        unmodelled.push(...r.unmodelled)
        if (!r.canSleep) score -= 10
      } else if (hasFlag(attacker.mon.status1, STATUS1_BLEED)) {
        const r = aiCanCauseBleed(state, attacker, defender, moveId, deps)
        unmodelled.push(...r.unmodelled)
        if (!r.can) score -= 10
      } else {
        score -= 10 // attacker has no status to transmit
      }
      break
    }
    case 'EFFECT_MUD_SPORT':
      if (hasFlag(state.field.statuses, STATUS_FIELD_MUDSPORT) || partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_WATER_SPORT':
      if (hasFlag(state.field.statuses, STATUS_FIELD_WATERSPORT) || partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_ABSORB':
      if (defAbility(defender, 'ABILITY_LIQUID_OOZE', atkMoldBreaker)) score -= 6
      break
    case 'EFFECT_STRENGTH_SAP':
      if (defAbility(defender, 'ABILITY_CONTRARY', atkMoldBreaker)) score -= 10
      else if (!shouldLowerStat(defender, 1 /* STAT_ATK */, atkMoldBreaker, unmodelled)) score -= 10
      break
    case 'EFFECT_COPYCAT':
    case 'EFFECT_MIRROR_MOVE': {
      unmodelled.push("AI_CheckBadMove: AI_DATA->predictedMoves has no equivalent anywhere in state.ts; treated as MOVE_NONE (no prediction), so this recurses into AI_CheckBadMove with no move data -- the C's own MOVE_NONE default-path branch, not an invented substitute")
      const r = aiCheckBadMove(state, battlerAtk, battlerDef, 'MOVE_NONE', score, deps)
      return { score: r.score, unmodelled: [...unmodelled, ...r.unmodelled] }
    }
    case 'EFFECT_FLOWER_SHIELD':
      // isDoubleBattle is always false -- the partner-of-attacker half is dead code.
      if (!isBattlerOfType(attacker, 'GRASS')) score -= 10
      break
    case 'EFFECT_AROMATIC_MIST':
      // isDoubleBattle is always false -- `!isDoubleBattle` (the C's first OR
      // operand) is always true, so this always scores -10.
      score -= 10
      break
    case 'EFFECT_BIDE': {
      const defHasDamagingMove = defender.mon.moves.some((m) => m && (deps.moveData(m)?.power ?? 0) !== 0)
      if (!defHasDamagingMove || getHealthPercentage(state, battlerAtk) < 30 || hasFlag(defender.mon.status1, STATUS1_SLEEP | STATUS1_FREEZE)) score -= 10
      break
    }
    case 'EFFECT_HIT_SWITCH_TARGET': {
      if (doesPartnerHaveSameMoveEffect(state, battlerAtk)) {
        score -= 10 // don't scare away pokemon twice
      } else {
        if (getHealthPercentage(state, battlerDef) < 10) {
          unmodelled.push("AI_CheckBadMove: GetBattlerSecondaryDamage(battlerDef) has no port; treated as 0 (falsy), so the \"target about to faint from secondary damage\" branch never fires even when the target is below 10% HP")
        }
        if (hasFlag(defender.statuses3, STATUS3_PERISH_SONG)) score -= 10
      }
      break
    }
    case 'EFFECT_CONVERSION': {
      // Check first move type.
      const firstMove = attacker.mon.moves[0]
      const firstMoveType = firstMove ? (deps.moveData(firstMove)?.type ?? null) : null
      if (firstMoveType && isBattlerOfType(attacker, firstMoveType)) score -= 10
      break
    }
    case 'EFFECT_REST':
    case 'EFFECT_RESTORE_HP':
    case 'EFFECT_SOFTBOILED':
    case 'EFFECT_ROOST': {
      // EFFECT_REST additionally checks AI_CanSleep first (the C's own
      // FALLTHROUGH into this shared healing-move body); the other three
      // skip straight to the shared body, matching the C's own case grouping.
      if (effect === 'EFFECT_REST') {
        const r = canSleep(state, attacker, deps)
        unmodelled.push(...r.unmodelled)
        if (!r.canSleep) score -= 10
      }
      if (atMaxHp(attacker)) score -= 10
      else if (getHealthPercentage(state, battlerAtk) >= 90) score -= 9 // no point healing, but do it if nothing better
      break
    }
    case 'EFFECT_MORNING_SUN':
    case 'EFFECT_SYNTHESIS':
    case 'EFFECT_MOONLIGHT':
      if (weatherHasEffect(state, deps.grounding) && hasFlag(state.field.weather, WEATHER_RAIN_ANY | WEATHER_SANDSTORM_ANY | WEATHER_HAIL_ANY)) {
        score -= 3
      } else if (atMaxHp(attacker)) {
        score -= 10
      } else if (getHealthPercentage(state, battlerAtk) >= 90) {
        score -= 9
      }
      break
    case 'EFFECT_PURIFY':
      if (!hasFlag(defender.mon.status1, STATUS1_ANY)) {
        score -= 10
      } else if (battlerDef === battlePartner(battlerAtk)) {
        // Always heal your ally.
      } else if (atMaxHp(attacker)) {
        score -= 10
      } else if (getHealthPercentage(state, battlerAtk) >= 90) {
        score -= 8
      }
      break
    case 'EFFECT_SUPER_FANG':
      if (getHealthPercentage(state, battlerDef) < 50) score -= 4
      break
    case 'EFFECT_RECOIL_IF_MISS': {
      unmodelled.push("AI_CheckBadMove: AI_GetMoveAccuracy(battlerAtk, battlerDef, move) is approximated by the move's own declared accuracy (dataContext.move's raw accuracy field, no stat-stage/weather/ability adjustment) -- reusing accuracy.ts's full pipeline was out of scope for this one case")
      const acc = deps.dataContext.move(moveId)?.accuracy ?? 100
      if (!isMagicGuardProtected(state, attacker) && acc < 75) score -= 6
      break
    }
    case 'EFFECT_TEETER_DANCE': {
      unmodelled.push("AI_CheckBadMove: EFFECT_TEETER_DANCE's partner-of-target half (:1537-1541) is NOT gated on IsDoubleBattle in the C; approximated as vacuously true (an absent partner slot never blocks) since this sim's battler slots 2/3 are always null in singles -- matching this move's real singles behavior of only the lone target mattering")
      const ignoresAbility = doesBattlerIgnoreAbilityChecks(battlerAtk, battlerDef, deps)
      const groundedInMistyTerrain = deps.turnOrder.isBattlerGrounded(battlerDef) && getCurrentTerrain(state) === STATUS_FIELD_MISTY_TERRAIN
      const targetBlocked =
        hasFlag(defender.mon.status2, STATUS2_CONFUSION) ||
        (!ignoresAbility && defAbility(defender, 'ABILITY_OWN_TEMPO', atkMoldBreaker)) ||
        (!ignoresAbility && defAbility(defender, 'ABILITY_DISCIPLINE', atkMoldBreaker)) ||
        groundedInMistyTerrain ||
        doesSubstituteBlockMove(attacker, defender, move, unmodelled)
      if (targetBlocked) score -= 10
      break
    }
    case 'EFFECT_TRANSFORM':
      if (hasFlag(attacker.mon.status2, STATUS2_TRANSFORMED) || hasFlag(defender.mon.status2, STATUS2_TRANSFORMED | STATUS2_SUBSTITUTE)) score -= 10
      break
    case 'EFFECT_TWO_TURNS_ATTACK': {
      const holdEffect = getBattlerHoldEffect(attacker, deps)
      const faintCheck = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
      unmodelled.push(...faintCheck.unmodelled)
      if (holdEffect !== 'HOLD_EFFECT_POWER_HERB' && faintCheck.canFaint) score -= 6
      break
    }
    case 'EFFECT_RECHARGE': {
      const effResult = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
      unmodelled.push(...effResult.unmodelled)
      if (defAbility(defender, 'ABILITY_WONDER_GUARD', atkMoldBreaker) && effResult.effectiveness > 5) {
        score -= 10
      } else if (!selfAbility(attacker, 'ABILITY_TRUANT')) {
        const faintCheck = canIndexMoveFaintTarget(state, battlerAtk, battlerDef, moveId, 0, deps)
        unmodelled.push(...faintCheck.unmodelled)
        if (!faintCheck.faints) score -= 2
      }
      break
    }
    case 'EFFECT_SPITE':
    case 'EFFECT_MIMIC': {
      const attackerGoesFirst = getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0
      if (attackerGoesFirst) {
        if (defender.lastMove === null) score -= 10
      } else {
        unmodelled.push('AI_CheckBadMove: AI_DATA->predictedMoves has no equivalent anywhere in state.ts; treated as MOVE_NONE (no prediction), so this always scores -10 when the opponent goes first')
        score -= 10
      }
      break
    }
    case 'EFFECT_METRONOME':
      break
    case 'EFFECT_ENDEAVOR':
    case 'EFFECT_PAIN_SPLIT':
      if (attacker.mon.hp > idiv(attacker.mon.hp + defender.mon.hp, 2)) score -= 10
      break
    case 'EFFECT_LOCK_ON':
      if (
        hasFlag(defender.statuses3, STATUS3_ALWAYS_HITS) ||
        selfAbility(attacker, 'ABILITY_NO_GUARD') ||
        defAbility(defender, 'ABILITY_NO_GUARD', atkMoldBreaker) ||
        doesPartnerHaveSameMoveEffect(state, battlerAtk)
      ) {
        score -= 10
      }
      break
    case 'EFFECT_LASER_FOCUS':
      if (hasFlag(attacker.statuses3, STATUS3_LASER_FOCUS)) score -= 10
      else if (defAbility(defender, 'ABILITY_SHELL_ARMOR', atkMoldBreaker) || defAbility(defender, 'ABILITY_BATTLE_ARMOR', atkMoldBreaker)) score -= 8
      break
    case 'EFFECT_SKETCH':
      if (defender.lastMove === null) score -= 10
      break
    case 'EFFECT_DESTINY_BOND':
      if (hasFlag(defender.mon.status2, STATUS2_DESTINY_BOND)) score -= 10
      break
    case 'EFFECT_FALSE_SWIPE':
      // TODO in the C itself -- no scoring exists for this case there either.
      break
    case 'EFFECT_HEAL_BELL':
      unmodelled.push('AI_CheckBadMove: AnyPartyMemberStatused has no party-wide status scan anywhere in this sim (only active battlers are modelled, not the full reserve party); treated as false (no party member statused), so this always scores -10')
      score -= 10
      break
    case 'EFFECT_HIT_PREVENT_ESCAPE':
      break
    case 'EFFECT_ENDURE':
      unmodelled.push('AI_CheckBadMove: GetBattlerSecondaryDamage(battlerAtk) has no port; treated as 0 (falsy)')
      if (attacker.mon.hp === 1) score -= 10
      break
    case 'EFFECT_PROTECT': {
      let decreased = false
      if (moveId === 'MOVE_QUICK_GUARD' || moveId === 'MOVE_WIDE_GUARD' || moveId === 'MOVE_CRAFTY_SHIELD') {
        // isDoubleBattle is always false -- `!isDoubleBattle` is always true.
        score -= 10
        decreased = true
      } else if (moveId === 'MOVE_MAT_BLOCK' && !attacker.volatiles.isFirstTurn) {
        score -= 10
        decreased = true
      }

      if (!decreased) {
        if (isBattlerIncapacitated(defender, deps)) {
          score -= 10
        } else if (moveId !== 'MOVE_QUICK_GUARD' && moveId !== 'MOVE_WIDE_GUARD' && moveId !== 'MOVE_CRAFTY_SHIELD') {
          unmodelled.push("AI_CheckBadMove: GetBattlerSecondaryDamage(battlerAtk) has no port; treated as 0, so the \"will faint after protecting\" branch (>= the attacker's own HP) never fires")
          if (attacker.volatiles.protectUses === 1 && state.rng.random16() % 100 < 50) {
            // isDoubleBattle is always false -- always the singles (-6) half.
            score -= 6
          } else if (attacker.volatiles.protectUses >= 2) {
            score -= 10
          }
        }
      }
      break
    }
    case 'EFFECT_BURN_UP':
      if (!isBattlerOfType(attacker, resolvedType ?? 'NORMAL')) score -= 10
      break
    case 'EFFECT_DEFOG': {
      const defSide = state.sides[battlerDef & 1]
      const atkSide = state.sides[battlerAtk & 1]
      const defHasScreensOrHazards =
        hasFlag(defSide.statuses, SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL | SIDE_STATUS_SAFEGUARD | SIDE_STATUS_MIST) ||
        defSide.timers.auroraVeilTimer !== 0 ||
        hasFlag(atkSide.statuses, SIDE_STATUS_HAZARDS_ANY)
      let handled = false
      if (defHasScreensOrHazards && partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) {
        score -= 10 // Only need one hazards removal.
        handled = true
      }
      if (!handled && hasFlag(defSide.statuses, SIDE_STATUS_HAZARDS_ANY)) {
        score -= 10 // Don't blow away opposing hazards.
        handled = true
      }
      // isDoubleBattle is always false -- the "partner is about to set up
      // hazards" pre-empt check (:1676-1683) is dead code in singles.
      if (!handled) {
        if (defender.mon.statStages[7] /* STAT_EVASION */ === MIN_STAT_STAGE || (defAbility(defender, 'ABILITY_CONTRARY', atkMoldBreaker) && !isTargetingPartner(battlerAtk, battlerDef))) {
          score -= 10
        }
      }
      break
    }
    case 'EFFECT_PSYCH_UP': {
      // isDoubleBattle is always false -- the partner-of-each-side half of
      // every OR below is dead code.
      for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
        if (attacker.mon.statStages[i] > 6 /* DEFAULT_STAT_STAGE */) score -= 10 // don't reset our boosted stats
      }
      for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
        if (defender.mon.statStages[i] < 6) score -= 10 // don't copy enemy lowered stats
      }
      break
    }
    case 'EFFECT_SPECTRAL_THIEF':
      break
    case 'EFFECT_SOLARBEAM': {
      const holdEffect = getBattlerHoldEffect(attacker, deps)
      const sunActive = weatherHasEffect(state, deps.grounding) && hasFlag(state.field.weather, WEATHER_SUN_ANY) && holdEffect !== 'HOLD_EFFECT_UTILITY_UMBRELLA'
      const hasChloroplast = CHLOROPLAST_ABILITIES.some((id) => selfAbility(attacker, id))
      if (holdEffect === 'HOLD_EFFECT_POWER_HERB' || sunActive || hasChloroplast) {
        // no-op.
      } else {
        const faintCheck = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
        unmodelled.push(...faintCheck.unmodelled)
        if (faintCheck.canFaint) score -= 4 // attacker can be knocked out
        score -= 10
      }
      break
    }
    case 'EFFECT_SEMI_INVULNERABLE':
      unmodelled.push("AI_CheckBadMove: AI_DATA->predictedMoves is always MOVE_NONE, so the \"opponent will use its own semi-invulnerable move\" branch (:1715-1717) never fires")
      if (moveId === 'MOVE_FLY' || moveId === 'MOVE_BOUNCE') {
        unmodelled.push('AI_CheckBadMove: BattlerWillFaintFromWeather has no port (BattlerAffectedBySandstorm/Hail are not ported); treated as false')
      }
      break
    case 'EFFECT_HEALING_WISH': // healing wish, lunar dance
      if (countUsablePartyMons(state, battlerAtk) === 0 || doesPartnerHaveSameMoveEffect(state, battlerAtk)) {
        score -= 10
      } else {
        unmodelled.push('AI_CheckBadMove: IsPartyFullyHealedExceptBattler has no party-wide scan anywhere in this sim (only active battlers are modelled); treated as false')
      }
      break
    case 'EFFECT_FINAL_GAMBIT':
      if (countUsablePartyMons(state, battlerAtk) === 0 || doesPartnerHaveSameMoveEffect(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_NATURE_POWER': {
      const naturePowerMove = getNaturePowerMove(state, unmodelled)
      const r = aiCheckBadMove(state, battlerAtk, battlerDef, naturePowerMove, score, deps)
      return { score: r.score, unmodelled: [...unmodelled, ...r.unmodelled] }
    }
    case 'EFFECT_TAUNT':
      if (defender.volatiles.tauntTimer > 0 || doesPartnerHaveSameMoveEffect(state, battlerAtk)) score -= 1
      if (defender.volatiles.tauntTimer !== 0) score -= 10
      break
    case 'EFFECT_BESTOW':
      if (!attacker.mon.itemId || !canBattlerGetOrLoseItemApprox(attacker, attacker.mon.itemId, deps)) score -= 10 // AI knows its own item
      break
    case 'EFFECT_ROLE_PLAY': {
      const atkAbility = battlerAbility(attacker)
      const defAbilityId = battlerAbility(defender)
      if (atkAbility === defAbilityId || defAbilityId === 'ABILITY_NONE' || isRolePlayBannedAbilityAtk(atkAbility) || isRolePlayBannedAbility(defAbilityId)) {
        score -= 10
      } else {
        unmodelled.push('AI_CheckBadMove: IsAbilityOfRating(ability, 5) has no port (sAiAbilityRatings has no JSON export anywhere in this data pipeline); treated as below the rating-5 threshold, so this -4 penalty never applies')
      }
      break
    }
    case 'EFFECT_WISH':
      unmodelled.push("AI_CheckBadMove: gWishFutureKnock.wishCounter has no state anywhere in this sim (FieldState's own doc: Wish/Future Sight not modelled yet); treated as 0 (no Wish pending)")
      break
    case 'EFFECT_ASSIST':
      if (countUsablePartyMons(state, battlerAtk) === 0) score -= 10 // no teammates to assist from
      break
    case 'EFFECT_MAGIC_COAT': {
      const hasMagicCoatAffectedMove = defender.mon.moves.some((m) => m && hasMoveFlag(deps.moveData(m), 'magicCoatAffected'))
      if (!hasMagicCoatAffectedMove) score -= 10
      break
    }
    case 'EFFECT_BELCH':
      unmodelled.push('AI_CheckBadMove: GetUsedHeldItem has no consumed-item tracking; treated as ITEM_NONE, whose pocket is never POCKET_BERRIES, so this always scores -10')
      score -= 10 // attacker has not consumed a berry
      break
    case 'EFFECT_YAWN': {
      if (hasFlag(defender.statuses3, STATUS3_YAWN)) {
        score -= 10
      } else {
        const r = canSleep(state, defender, deps)
        unmodelled.push(...r.unmodelled)
        if (!r.canSleep) score -= 10
      }
      break
    }
    case 'EFFECT_SKILL_SWAP': {
      const atkAbility = battlerAbility(attacker)
      const defAbilityId = battlerAbility(defender)
      if (atkAbility === defAbilityId || defAbilityId === 'ABILITY_NONE' || isRolePlayBannedAbility(defAbilityId)) score -= 10
      break
    }
    case 'EFFECT_WORRY_SEED':
      if (defAbility(defender, 'ABILITY_INSOMNIA', atkMoldBreaker) || isWorrySeedBannedAbility(battlerAbility(defender))) score -= 10
      break
    case 'EFFECT_GASTRO_ACID':
      if (hasFlag(defender.statuses3, STATUS3_GASTRO_ACID) || doesBattlerHaveAbilityShield(defender, deps)) score -= 10
      break
    case 'EFFECT_ENTRAINMENT': {
      const atkAbility = battlerAbility(attacker)
      if (atkAbility === 'ABILITY_NONE' || isEntrainmentBannedAbilityAttacker(atkAbility) || isEntrainmentTargetOrSimpleBeamBannedAbility(battlerAbility(defender))) {
        score -= 10
      }
      break
    }
    case 'EFFECT_CORE_ENFORCER':
      break
    case 'EFFECT_SIMPLE_BEAM':
      if (battlerAbility(attacker) === 'ABILITY_SIMPLE' || isEntrainmentTargetOrSimpleBeamBannedAbility(battlerAbility(defender))) score -= 10
      break
    case 'EFFECT_SNATCH': {
      const hasSnatchAffectedMove = defender.mon.moves.some((m) => m && hasMoveFlag(deps.moveData(m), 'snatchAffected'))
      if (!hasSnatchAffectedMove || partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) score -= 10
      break
    }
    case 'EFFECT_POWER_TRICK': {
      if (isTargetingPartner(battlerAtk, battlerDef)) {
        score -= 10
      } else {
        // :1798 reads gBattleMons[].defense/.attack -- the raw battle stats
        // (GetMonData(MON_DATA_ATK), battle_script_commands.c:6627), stage-blind.
        if (attacker.mon.rawStats.def >= attacker.mon.rawStats.atk && !hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score -= 10
      }
      break
    }
    case 'EFFECT_POWER_SWAP': // don't use if attacker's stat stages are higher than the target's
      if (isTargetingPartner(battlerAtk, battlerDef)) {
        score -= 10
      } else if (attacker.mon.statStages[1] >= defender.mon.statStages[1] && attacker.mon.statStages[4] >= defender.mon.statStages[4]) {
        score -= 10
      }
      break
    case 'EFFECT_GUARD_SWAP':
      if (isTargetingPartner(battlerAtk, battlerDef)) {
        score -= 10
      } else if (attacker.mon.statStages[2] >= defender.mon.statStages[2] && attacker.mon.statStages[5] >= defender.mon.statStages[5]) {
        score -= 10
      }
      break
    case 'EFFECT_SPEED_SWAP': {
      if (isTargetingPartner(battlerAtk, battlerDef)) {
        score -= 10
      } else {
        const atkSpeed = getBattlerTotalSpeedStat(state, battlerAtk, TOTAL_SPEED_FULL, null, deps.turnOrder, deps.statStageRatios)
        const defSpeed = getBattlerTotalSpeedStat(state, battlerDef, TOTAL_SPEED_FULL, null, deps.turnOrder, deps.statStageRatios)
        if (isTrickRoomActive(state) && atkSpeed <= defSpeed) score -= 10
        else if (atkSpeed >= defSpeed) score -= 10
      }
      break
    }
    case 'EFFECT_HEART_SWAP': {
      if (isTargetingPartner(battlerAtk, battlerDef)) {
        score -= 10
      } else {
        const atkPos = countPositiveStatStages(attacker)
        const atkNeg = countNegativeStatStages(attacker)
        const defPos = countPositiveStatStages(defender)
        const defNeg = countNegativeStatStages(defender)
        if (atkPos >= defPos && atkNeg <= defNeg) score -= 10
      }
      break
    }
    case 'EFFECT_POWER_SPLIT': {
      if (isTargetingPartner(battlerAtk, battlerDef)) {
        score -= 10
      } else {
        // :1842-1845 copies the raw, stage-blind battle stats into u8 locals, so
        // a stat above 255 wraps before the sums are compared. Reproduced.
        const atkAtk = u8(attacker.mon.rawStats.atk)
        const defAtk = u8(defender.mon.rawStats.atk)
        const atkSpa = u8(attacker.mon.rawStats.spatk)
        const defSpa = u8(defender.mon.rawStats.spatk)
        if (atkAtk + atkSpa >= defAtk + defSpa) score -= 10 // combined attacker stats are >= combined target stats
      }
      break
    }
    case 'EFFECT_GUARD_SPLIT': {
      if (isTargetingPartner(battlerAtk, battlerDef)) {
        score -= 10
      } else {
        // :1856-1859 -- same u8 truncation of raw stats as Power Split.
        const atkDef = u8(attacker.mon.rawStats.def)
        const defDef = u8(defender.mon.rawStats.def)
        const atkSpd = u8(attacker.mon.rawStats.spdef)
        const defSpd = u8(defender.mon.rawStats.spdef)
        if (atkDef + atkSpd >= defDef + defSpd) score -= 10
      }
      break
    }
    case 'EFFECT_ME_FIRST':
      // AI_DATA->predictedMoves is always MOVE_NONE (no prediction) -- the
      // "predicted move known" branch (:1867-1871) is unreachable; only the
      // "target is predicted to switch" else always fires.
      unmodelled.push('AI_CheckBadMove: AI_DATA->predictedMoves has no equivalent anywhere in state.ts; treated as MOVE_NONE, so EFFECT_ME_FIRST always scores -10')
      score -= 10
      break
    case 'EFFECT_NATURAL_GIFT':
      unmodelled.push("AI_CheckBadMove: ItemId_GetPocket is approximated via a berry-name substring check (same as part 1's EFFECT_STUFF_CHEEKS), not a real pocket lookup")
      if (selfAbility(attacker, 'ABILITY_KLUTZ') || !looksLikeBerry(attacker.mon.itemId)) score -= 10
      break
    case 'EFFECT_GRASSY_TERRAIN':
      if (partnerMoveEffectIsTerrain(state, battlerAtk) || getCurrentTerrain(state) === STATUS_FIELD_GRASSY_TERRAIN) score -= 20
      if (!terrainHasEffect(state)) score -= 20
      break
    case 'EFFECT_ELECTRIC_TERRAIN':
      if (partnerMoveEffectIsTerrain(state, battlerAtk) || getCurrentTerrain(state) === STATUS_FIELD_ELECTRIC_TERRAIN) score -= 20
      if (!terrainHasEffect(state)) score -= 20
      break
    case 'EFFECT_PSYCHIC_TERRAIN':
      if (partnerMoveEffectIsTerrain(state, battlerAtk) || getCurrentTerrain(state) === STATUS_FIELD_PSYCHIC_TERRAIN) score -= 20
      if (!terrainHasEffect(state)) score -= 20
      break
    case 'EFFECT_MISTY_TERRAIN':
      if (partnerMoveEffectIsTerrain(state, battlerAtk) || getCurrentTerrain(state) === STATUS_FIELD_MISTY_TERRAIN) score -= 20
      if (!terrainHasEffect(state)) score -= 20
      break
    case 'EFFECT_TOXIC_TERRAIN':
      if (partnerMoveEffectIsTerrain(state, battlerAtk) || getCurrentTerrain(state) === STATUS_FIELD_TOXIC_TERRAIN) score -= 20
      if (!terrainHasEffect(state)) score -= 20
      break
    case 'EFFECT_PLEDGE':
      // isDoubleBattle is always false -- this combo-move check (which only
      // applies when a partner exists) is entirely dead code in singles.
      break
    case 'EFFECT_TRICK_ROOM':
      if (isAbilityOnField(state, 'ABILITY_CLUELESS')) {
        score -= 10
      } else if (partnerMoveIs(state, battlerAtk)) {
        score -= 10
      } else if (isTrickRoomActive(state)) {
        if (getBattlerSideSpeedAverage(state, battlerAtk, deps) < getBattlerSideSpeedAverage(state, battlerDef, deps)) score -= 10 // keep Trick Room up
      } else {
        if (getBattlerSideSpeedAverage(state, battlerAtk, deps) >= getBattlerSideSpeedAverage(state, battlerDef, deps)) score -= 10 // keep Trick Room down
      }
      break
    case 'EFFECT_MAGIC_ROOM':
      if (isAbilityOnField(state, 'ABILITY_CLUELESS')) score -= 10
      else if (isMagicRoomActive(state) || partnerMoveIsSameNoTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_WONDER_ROOM':
      if (isAbilityOnField(state, 'ABILITY_CLUELESS')) score -= 10
      else if (hasFlag(state.field.statuses, STATUS_FIELD_WONDER_ROOM) || partnerMoveIsSameNoTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_GRAVITY': {
      const holdEffect = getBattlerHoldEffect(attacker, deps)
      if ((isGravityActive(state) && !isBattlerOfType(attacker, 'FLYING') && holdEffect !== 'HOLD_EFFECT_AIR_BALLOON') || partnerMoveIsSameNoTarget(state, battlerAtk)) {
        score -= 10 // should revert Gravity in the air-balloon case
      }
      break
    }
    case 'EFFECT_ION_DELUGE':
      if (hasFlag(state.field.statuses, STATUS_FIELD_ION_DELUGE) || partnerMoveIsSameNoTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_FLING':
      if (!canFling(attacker, deps, unmodelled)) score -= 10 // no item to fling
      break
    case 'EFFECT_EMBARGO':
      if (defAbility(defender, 'ABILITY_KLUTZ', atkMoldBreaker) || defender.volatiles.embargoTimer !== 0 || partnerMoveIsSameAsAttacker(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_POWDER':
      if (!hasMoveWithType(defender, 'FIRE', deps) || partnerMoveIsSameAsAttacker(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_TELEKINESIS': {
      const holdEffect = getBattlerHoldEffect(defender, deps)
      if (
        hasFlag(defender.statuses3, STATUS3_TELEKINESIS | STATUS3_ROOTED | STATUS3_SMACKED_DOWN) ||
        isGravityActive(state) ||
        holdEffect === 'HOLD_EFFECT_IRON_BALL' ||
        isTelekinesisBannedSpecies(defender.mon.speciesId) ||
        partnerMoveIsSameAsAttacker(state, battlerAtk)
      ) {
        score -= 10
      }
      break
    }
    case 'EFFECT_THROAT_CHOP':
      break
    case 'EFFECT_HEAL_BLOCK':
      if (defender.volatiles.healBlockTimer !== 0 || partnerMoveIsSameAsAttacker(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_SOAK':
      // The C's own IS_BATTLER_OF_TYPE-style all-three-types comparison means
      // a target whose type3 is TYPE_MYSTERY (no third type) matches the
      // "type3 == TYPE_MYSTERY" leg of this check the same way a genuine
      // Water/Water/(none) target would -- reproduced as-is via `.types.includes`.
      if (
        partnerMoveIsSameAsAttacker(state, battlerAtk) ||
        (defender.mon.types[0] === 'WATER' && defender.mon.types[1] === 'WATER' && defender.mon.types[2] === 'MYSTERY')
      ) {
        score -= 10 // target is already water-only
      }
      break
    case 'EFFECT_THIRD_TYPE':
      if (moveId === 'MOVE_TRICK_OR_TREAT') {
        if (isBattlerOfType(defender, 'GHOST') || partnerMoveIsSameAsAttacker(state, battlerAtk)) score -= 10
      } else if (moveId === 'MOVE_FORESTS_CURSE') {
        if (isBattlerOfType(defender, 'GRASS') || partnerMoveIsSameAsAttacker(state, battlerAtk)) score -= 10
      }
      break
    case 'EFFECT_HIT_ENEMY_HEAL_ALLY': // pollen puff
      // isTargetingPartner is always false in singles -- FALLTHROUGH into the
      // shared EFFECT_HEAL_PULSE body below, exactly as the C's own
      // FALLTHROUGH does when the (unreachable-here) partner branch is skipped.
      // eslint-disable-next-line no-fallthrough
    case 'EFFECT_HEAL_PULSE': // and Floral Healing
      // !IsTargetingPartner is always true in singles -- always "don't heal enemies".
      score -= 10
      break
    case 'EFFECT_ELECTRIFY':
      if (
        getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0 ||
        partnerMoveIsSameAsAttacker(state, battlerAtk)
      ) {
        score -= 10
      }
      break
    case 'EFFECT_TOPSY_TURVY': {
      if (!isTargetingPartner(battlerAtk, battlerDef)) {
        const defPos = countPositiveStatStages(defender)
        const defNeg = countNegativeStatStages(defender)
        if (defPos === 0 || partnerMoveIsSameAsAttacker(state, battlerAtk)) {
          score -= 10 // no good stat changes to make bad
        } else if (defNeg < defPos) {
          score -= 5 // more stages would be made positive than negative
        }
      }
      break
    }
    case 'EFFECT_FAIRY_LOCK':
      if (hasFlag(state.field.statuses, STATUS_FIELD_FAIRY_LOCK) || partnerMoveIsSameNoTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_DO_NOTHING':
      score -= 10
      break
    case 'EFFECT_INSTRUCT': {
      const opponentGoesFirst = getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 1
      let instructedMove: string | null
      if (opponentGoesFirst) {
        unmodelled.push('AI_CheckBadMove: AI_DATA->predictedMoves has no equivalent anywhere in state.ts; treated as MOVE_NONE (no prediction)')
        instructedMove = null
      } else {
        instructedMove = defender.lastMove
      }

      if (
        instructedMove === null ||
        isInstructBannedMove(instructedMove) ||
        moveRequiresRecharging(instructedMove) ||
        moveCallsOtherMove(instructedMove) ||
        partnerMoveIsSameAsAttacker(state, battlerAtk)
      ) {
        unmodelled.push('AI_CheckBadMove: gLockedMoves[battlerDef] and STATUS2_MULTIPLETURNS are not checked here (no port for either); this is a widening-safe omission since both would only ADD more -10 triggers to an already-true OR chain')
        score -= 10
      } else {
        // isDoubleBattle is always false -- the doubles branch (:2051-2052) is dead code.
        const instructedMoveData = deps.moveData(instructedMove)
        const wideTarget = instructedMoveData?.target && ['SELECTED', 'DEPENDS', 'RANDOM', 'BOTH', 'FOES_AND_ALLY', 'OPPONENTS_FIELD'].includes(instructedMoveData.target)
        if (wideTarget && instructedMove !== 'MOVE_MIND_BLOWN' && instructedMove !== 'MOVE_STEEL_BEAM') {
          score -= 10 // don't force the enemy to attack you again unless it can kill itself
        } else if (instructedMove !== 'MOVE_MIND_BLOWN') {
          score -= 5 // do something better
        }
      }
      break
    }
    case 'EFFECT_QUASH':
      // isDoubleBattle is always false -- `!isDoubleBattle` is always true.
      score -= 10
      break
    case 'EFFECT_AFTER_YOU':
      // isTargetingPartner is always false in singles -- `!IsTargetingPartner`
      // is always true, so this always scores -10.
      score -= 10
      break
    case 'EFFECT_SUCKER_PUNCH':
      unmodelled.push("AI_CheckBadMove: AI_DATA->predictedMoves is always MOVE_NONE, so EFFECT_SUCKER_PUNCH's whole scoring body (:2073-2078, an RNG draw plus a strikes-first check) is unreachable and never applies a penalty")
      break
    case 'EFFECT_TAILWIND':
      if (
        state.sides[battlerAtk & 1].timers.tailwindTimer !== 0 ||
        partnerMoveIs(state, battlerAtk) ||
        (isTrickRoomActive(state) && state.field.timers.trickRoomTimer > 1)
      ) {
        score -= 10
      }
      break
    case 'EFFECT_LUCKY_CHANT':
      if (state.sides[battlerAtk & 1].timers.luckyChantTimer !== 0 || partnerMoveIsSameNoTarget(state, battlerAtk)) score -= 10
      break
    case 'EFFECT_MAGNET_RISE': {
      const holdEffect = getBattlerHoldEffect(attacker, deps)
      const grounded = deps.turnOrder.isBattlerGrounded(battlerAtk)
      if (
        isGravityActive(state) ||
        attacker.volatiles.magnetRiseTimer !== 0 ||
        holdEffect === 'HOLD_EFFECT_IRON_BALL' ||
        hasFlag(attacker.statuses3, STATUS3_ROOTED | STATUS3_MAGNET_RISE | STATUS3_SMACKED_DOWN) ||
        !grounded
      ) {
        score -= 10
      }
      break
    }
    case 'EFFECT_CAMOUFLAGE':
      if (!canCamouflage(unmodelled)) score -= 10
      break
    case 'EFFECT_LAST_RESORT':
      if (!canUseLastResort(attacker)) score -= 10
      break
    case 'EFFECT_SYNCHRONOISE': {
      // Check holding Ring Target or is of same type.
      const holdEffect = getBattlerHoldEffect(defender, deps)
      const sameType = attacker.mon.types.some((t) => defender.mon.types.includes(t))
      if (!(holdEffect === 'HOLD_EFFECT_RING_TARGET' || sameType)) score -= 10
      break
    }
    case 'EFFECT_ERUPTION': {
      const effResult = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
      unmodelled.push(...effResult.unmodelled)
      if (effResult.effectiveness <= 3 /* AI_EFFECTIVENESS_x0_5 */) score--
      if (getHealthPercentage(state, battlerDef) < 50) score--
      break
    }
    case 'EFFECT_VITAL_THROW':
      unmodelled.push("AI_CheckBadMove: IsAiFaster(AI_CHECK_FASTER) is a distinct enum branch aiScorers.ts's own isAiFaster does not implement (that one is restricted to the AI_IS_FASTER case, per its own doc); treated as false, so this -1 penalty never applies")
      break
    case 'EFFECT_FLAIL':
      if (
        getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 1 || // opponent should go first
        getHealthPercentage(state, battlerAtk) > 50
      ) {
        score -= 4
      }
      break
    default:
      // EFFECT_HIT/EFFECT_POISON_HIT/EFFECT_BURN_HIT/EFFECT_PARALYZE_HIT/
      // EFFECT_CONFUSE_HIT and any other unlisted effect -- :798-804, the
      // damage path. Nothing to score here. This also covers the seven
      // case labels that exist only in commented-out code at :2121-2148
      // (EFFECT_PLASMA_FISTS, EFFECT_SHELL_TRAP, EFFECT_BEAK_BLAST, EFFECT_
      // SKY_DROP, EFFECT_NO_RETREAT, EFFECT_EXTREME_EVOBOOST, EFFECT_
      // CLANGOROUS_SOUL) -- see this module's header.
      break
  }

  // :2151-2158 -- recoil discouragement, applies regardless of which case
  // above fired (every branch either falls through to here via `break` or
  // `return`s earlier, matching the C's own control flow into this shared tail).
  const recoilFraction = getRecoilFraction(effect, deps.moveBehaviors)
  if (recoilFraction) {
    if (!isMagicGuardProtected(state, attacker) && !blocksRecoil(attacker)) {
      let frac = recoilFraction
      if (reducesRecoil(attacker)) frac *= 2
      const simDmg = aiCalcDamage(state, moveId, battlerAtk, battlerDef, deps)
      unmodelled.push(...simDmg.unmodelled)
      const recoilDmg = Math.max(1, idiv(simDmg.dmg, frac))
      const recoilCheck = shouldUseRecoilMove(state, battlerAtk, battlerDef, recoilDmg, deps)
      unmodelled.push(...recoilCheck.unmodelled)
      if (!recoilCheck.should) score -= 10
    }
  }

  // :2160 -- score floor.
  if (score < 0) score = 0

  return { score, unmodelled }
}

/** OnAbsorbContext/OnImmuneContext's shared `moveType`/`moveFlags` half --
 * factored out since both computeIsAbsorbed and computeIsImmune need it. */
function built_flags(move: NonNullable<ReturnType<AiDamageDeps['moveData']>>): Record<string, true> {
  return move.flags ?? {}
}
