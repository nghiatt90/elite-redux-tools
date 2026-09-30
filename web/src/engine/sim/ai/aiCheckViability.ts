// AI_CheckViability, battle_ai_main.c:2515-3986 -- PART 1 (this batch,
// ai-checkviability-1): the pre-switch checks (:2516-2626, including the
// attacker-ability loop at :2605-2624) and the move-effect switch from its
// first case (EFFECT_HIT, :2628) through EFFECT_PERISH_SONG (:3221-3223), the
// last label before EFFECT_SANDSTORM (:3224) where part 2 begins. Every case
// label the C switch itself declares in this range is transcribed; none are
// invented.
//
// `predictedMove` (the function's own local, declared `u16 predictedMove =
// gLastMoves[battlerDef]; // for now`) is NOT the same thing as
// `AI_DATA->predictedMoves[]`, the genuinely unmodelled prediction system
// aiCheckBadMove.ts's own header gaps -- it is the DEFENDER's real last used
// move (`battler.lastMove`, a tracked field), so every read of it below is
// live data, not a gap. `AI_DATA->partnerMove` IS the doubles-only field that
// is always MOVE_NONE on this singles-only build (structural, matching
// aiCheckBadMove.ts's own non-gapped treatment of the same field).
//
// RNG: AI_CheckViability itself contains 35 direct `Random()`/`AI_RandLessThan`
// lines across its FULL range (:2515-3986, lead's own grep count) -- every one
// of them falls inside THIS batch's :2515-3223 slice (part 2 draws no RNG of
// its own directly in battle_ai_main.c). Each is cited at its call site below
// by its battle_ai_main.c line number. A handful of the battle_ai_util.c
// HELPER functions this batch also transcribes for the first time draw their
// OWN RNG too (IncreaseSleepScore's `AI_RandLessThan(128)`,
// ProtectChecks' bare `Random() % 256 < 100`, ShouldAbsorb's bare
// `Random() % 3`) -- these are real draws that must land at the correct point
// in `state.rng`'s sequence for RNG-order fidelity, but are not among the "35"
// (they are not lines of AI_CheckViability's own body); each is called out at
// its own definition below.
//
// Singles-only (this project's own scope, CLAUDE.md), matching
// aiCheckBadMove.ts's own precedent: `isValidDoubleBattle`/`isDoubleBattle`
// reads are transcribed as real (if unreachable) calls, and every
// `if (isDoubleBattle) {...}` branch here is DEAD CODE on this build, not a
// gap (EFFECT_ROAR/EFFECT_CLEAR_SMOG's ally-inclusive stat count,
// EFFECT_HIT_ESCAPE/PARTING_SHOT's doubles branch inside ShouldPivot's own
// caller). `AI_DATA->partnerMove`-gated `PartnerHasSameMoveEffectWithoutTarget`
// (EFFECT_HAZE) reuses aiCheckBadMove.ts's own always-false doubles helper.
//
// Reused rather than rewritten (per the brief): `MOLD_BREAKABLE_ABILITIES`,
// `ALWAYS_SLEEPING_ABILITIES`, `defAbility`/`selfAbility`, `u8`, `atMaxHp`,
// `isBattlerOfType`, `getBattlerHoldEffect`, `hasMoveWithSplit`/
// `hasMoveWithType`, `isBattlerIncapacitated`, `isBattlerTrapped`,
// `canBePoisoned`/`canBeParalyzedBase`/`aiCanParalyze`/`canSleep`/
// `canBeConfused`, `doesSubstituteBlockMove`, `shouldLowerStat`,
// `partnerHasSameMoveEffectWithoutTarget`, `anyStatIsRaised`,
// `countPositiveStatStages`, `isStickyHold`, `canBattlerGetOrLoseItemApprox`
// (all from aiCheckBadMove.ts, exported for this batch) and `isAiFaster`,
// `canIndexMoveFaintTarget`, `canTargetFaintAi`, `getMoveDamageResult`,
// `getHealthPercentage`, `aiGetMoveEffectiveness`, `isTargetingPartner` (from
// aiScorers.ts).
//
// Approximations/gaps (each named at its own call site too):
//   - `atkPriority = GetMovePriority(battlerAtk, move, battlerDef)` (:2519) is
//     approximated as the move's own declared priority (`move.priority`),
//     the same simplification aiScorers.ts's `isAiFaster`/`aiTryToFaint`
//     already document ("Higher Rank" precedent) -- ability/terrain priority
//     modifiers (Prankster-family, Gale Wings, Grassy Glide, Natural Gift,
//     On the Prowl) are not applied to this ONE pre-switch check. Gapped only
//     when the move actually carries a variable-priority effect.
//   - `IsAiFaster(AI_CHECK_SLOWER)` is exactly `!isAiFaster(...)`
//     (AI_CHECK_FASTER) -- verified against IsAiFaster's own C body: for
//     every one of its three branches (priority-count win/loss/tie), the
//     AI_CHECK_SLOWER result is the bitwise negation of the AI_CHECK_FASTER
//     result, so this is a real equivalence, not an approximation.
//   - `GetBattlerSecondaryDamage`/`BattlerWillFaintFromSecondaryDamage`,
//     `IsUnnerveAbilityOnOpposingSide`, `PartyBattlerShouldAvoidHazards`,
//     `CanTargetFaintAiWithMod`'s AI_DATA->moveLimitations term, and
//     `IsAbilityStatusProtected`'s onCanStatusType scan reuse the SAME gap
//     shape aiCheckBadMove.ts's own header already establishes for each
//     (secondary damage: always 0/false; Unnerve: always false; hazard-avoid:
//     always false; move limitations: never limited; status-immunity
//     ability hooks: never protected) -- named again at each new call site
//     here since this is the first batch to reach them.
//   - `HasMoveWithLowAccuracy`'s `AI_GetMoveAccuracy` (the fully-modified
//     accuracy, weather/item/ability-adjusted) is approximated by each
//     move's own declared `accuracy` field, the same "declared value stands
//     in for the resolved one" precedent aiCheckBadMove.ts's `moveType`
//     documents for GetMoveDynamicType.
//   - `CompareStat`'s own Contrary-flip is checked as a plain self-ability
//     read, without threading through whether the OPPOSING battler holds
//     Mold Breaker (the C's own `BattlerHasAbility(battlerId, CONTRARY,
//     TRUE)` suppression direction) -- gapped only at its one call site
//     (EFFECT_SPEED_UP), since that is a narrow edge case (attacker has
//     Contrary AND faces a Mold-Breaker-wielding opponent while using a
//     speed-boosting move).
//   - `IsWakeupTurn` reuses aiCheckBadMove.ts's own gap (no
//     move-history-by-turn tracking exists in this sim) -- always false.

import type { BattleState, BattlerState } from '../state'
import {
  hasFlag,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_ACC,
  STAT_EVASION,
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  STATUS1_SLEEP,
  STATUS1_POISON_ANY,
  STATUS1_TOXIC_POISON,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_BURN,
  STATUS1_BLEED,
  STATUS2_SUBSTITUTE,
  STATUS2_CURSED,
  STATUS2_WRAPPED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS3_LEECHSEED,
  STATUS3_PERISH_SONG,
  STATUS3_ROOTED,
  STATUS3_AQUA_RING,
  STATUS3_MAGNET_RISE,
  STATUS3_POWER_TRICK,
  STATUS3_ALWAYS_HITS,
  STATUS3_YAWN,
  STATUS3_HEAL_BLOCK,
  STATUS4_COMMANDED,
  STATUS1_PARALYSIS,
  STATUS2_CONFUSION,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_AURORA_VEIL,
  WEATHER_HAIL_ANY,
  WEATHER_FOG_ANY,
  WEATHER_SUN_ANY,
  WEATHER_RAIN_ANY,
  STATUS2_NIGHTMARE,
  NUM_BATTLE_STATS,
  STATUS1_ANY,
  STATUS2_DEFENSE_CURL,
  STATUS3_GASTRO_ACID,
  STATUS3_SEMI_INVULNERABLE,
  SIDE_STATUS_HAZARDS_ANY,
  SIDE_STATUS_SCREEN_ANY,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_MIST,
  SIDE_STATUS_SPIKES,
  STATUS_FIELD_MISTY_TERRAIN,
  WEATHER_SANDSTORM_ANY,
  WEATHER_PRIMAL_ANY,
} from '../constants'
import { getWhoStrikesFirst, getBattlerTotalSpeedStat, TOTAL_SPEED_FULL } from '../turnOrder'
import {
  isValidDoubleBattle,
  hasMoveFlag,
  moveTargetsUser,
  isBattlerOfType,
  getBattlerHoldEffect,
  defAbility,
  selfAbility,
  isBattlerWeatherAffected,
  shouldLowerStat,
  hasMoveWithSplit,
  hasMoveWithType,
  isBattlerIncapacitated,
  isBattlerTrapped,
  canBePoisoned,
  aiCanParalyze,
  canSleep,
  canBeConfused,
  doesSubstituteBlockMove,
  partnerHasSameMoveEffectWithoutTarget,
  anyStatIsRaised,
  countPositiveStatStages,
  isStickyHold,
  canBattlerGetOrLoseItemApprox,
  atMaxHp,
  ALWAYS_SLEEPING_ABILITIES,
  CHLOROPLAST_ABILITIES,
  isPowderImmune,
  getCurrentTerrain,
  getNaturePowerMove,
  isRolePlayBannedAbility,
  isRolePlayBannedAbilityAtk,
  aiCanBurn,
  canGetFrostbite,
  aiCanGiveFrostbite,
  battlerAbility,
} from './aiCheckBadMove'
import {
  isTargetingPartner,
  getHealthPercentage,
  aiGetMoveEffectiveness,
  canIndexMoveFaintTarget,
  canTargetFaintAi,
  getMoveDamageResult,
  MOVE_POWER_WEAK,
  isAiFaster,
} from './aiScorers'
import { aiCalcDamage, type AiDamageDeps } from './aiCalcDamage'
import { shouldSwitch } from './aiShouldSwitch'
import { countUsablePartyMons } from './aiPipeline'
import { aiCheckBadMove } from './aiCheckBadMove'
import { isMagicGuardProtected } from '../endTurn'
import { weatherHasEffect, isSandImmune, isHailImmune } from '../fieldEndTurn'
import { getAbilityRating, isAbilityOfRating } from './aiAbilityRatings'
import { AI_FLAG_PREFER_STATUS_MOVES, AI_FLAG_WILL_SUICIDE, AI_FLAG_SMART_SWITCHING, AI_FLAG_STALL, AI_FLAG_SCREENER, AI_FLAG_TRY_TO_FAINT } from './aiFlags'

type Result = { score: number; unmodelled: string[] }

/** `AI_RandLessThan(val)` -- `(Random() % 0xFF) < val`, rng.ts's own documented
 * shape (0xFF = 255, not 256). */
function aiRandLessThan(state: BattleState, val: number): boolean {
  return state.rng.random16() % 0xff < val
}

/** `HasMoveEffect(battlerId, effect)`, battle_ai_util.c -- not previously
 * ported anywhere in this codebase; a plain moveset scan. */
function hasMoveEffect(battler: BattlerState, effect: string, deps: AiDamageDeps): boolean {
  return battler.mon.moves.some((m) => m && deps.moveData(m)?.effect === effect)
}

/** `HasDamagingMove(battlerId)`, battle_ai_util.c:1631-1639. */
function hasDamagingMove(battler: BattlerState, deps: AiDamageDeps): boolean {
  return battler.mon.moves.some((m) => m && (deps.moveData(m)?.power ?? 0) !== 0)
}

/** `TestMoveFlagsInMoveset(battler, flags)`, battle_ai_util.c:1686-1692. */
function testMoveFlagsInMoveset(battler: BattlerState, flag: string, deps: AiDamageDeps): boolean {
  return battler.mon.moves.some((m) => m && hasMoveFlag(deps.moveData(m), flag))
}

/** `IsEncoreEncouragedEffect(moveEffect)`, battle_ai_util.c:302-350 for the
 * table + :1661-1667 for the scan. Transcribed in full (57 entries, one
 * literal duplicate -- EFFECT_SKILL_SWAP appears twice in the C's own array
 * at :306 and :356, reproduced here as a Set so the duplicate is harmless). */
const ENCORE_ENCOURAGED_EFFECTS = new Set([
  'EFFECT_DREAM_EATER', 'EFFECT_ATTACK_UP', 'EFFECT_DEFENSE_UP', 'EFFECT_SPEED_UP', 'EFFECT_SPECIAL_ATTACK_UP',
  'EFFECT_HAZE', 'EFFECT_ROAR', 'EFFECT_CONVERSION', 'EFFECT_TOXIC', 'EFFECT_LIGHT_SCREEN',
  'EFFECT_REST', 'EFFECT_SUPER_FANG', 'EFFECT_SPECIAL_DEFENSE_UP_2', 'EFFECT_CONFUSE', 'EFFECT_POISON',
  'EFFECT_PARALYZE', 'EFFECT_LEECH_SEED', 'EFFECT_DO_NOTHING', 'EFFECT_ATTACK_UP_2', 'EFFECT_ENCORE',
  'EFFECT_CONVERSION_2', 'EFFECT_LOCK_ON', 'EFFECT_HEAL_BELL', 'EFFECT_MEAN_LOOK', 'EFFECT_NIGHTMARE',
  'EFFECT_PROTECT', 'EFFECT_SKILL_SWAP', 'EFFECT_FORESIGHT', 'EFFECT_PERISH_SONG', 'EFFECT_SANDSTORM',
  'EFFECT_ENDURE', 'EFFECT_SWAGGER', 'EFFECT_ATTRACT', 'EFFECT_SAFEGUARD', 'EFFECT_RAIN_DANCE',
  'EFFECT_SUNNY_DAY', 'EFFECT_BELLY_DRUM', 'EFFECT_PSYCH_UP', 'EFFECT_FUTURE_SIGHT', 'EFFECT_FAKE_OUT',
  'EFFECT_STOCKPILE', 'EFFECT_SPIT_UP', 'EFFECT_SWALLOW', 'EFFECT_HAIL', 'EFFECT_TORMENT',
  'EFFECT_WILL_O_WISP', 'EFFECT_FOLLOW_ME', 'EFFECT_CHARGE', 'EFFECT_TRICK', 'EFFECT_ROLE_PLAY',
  'EFFECT_INGRAIN', 'EFFECT_RECYCLE', 'EFFECT_KNOCK_OFF', 'EFFECT_IMPRISON', 'EFFECT_REFRESH',
  'EFFECT_GRUDGE', 'EFFECT_TEETER_DANCE', 'EFFECT_MUD_SPORT', 'EFFECT_WATER_SPORT', 'EFFECT_DRAGON_DANCE',
  'EFFECT_CAMOUFLAGE',
])
function isEncoreEncouragedEffect(effect: string | null): boolean {
  return !!effect && ENCORE_ENCOURAGED_EFFECTS.has(effect)
}

/** Every ability whose `abilityHooks.json` `bitfields.unaware` is set --
 * `IsUnaware`'s real flag scan (`RETURN_ABILITY_IF_FLAG(battler, TRUE,
 * unaware)`). `TRUE` is checkMoldBreaker, so reads go through `defAbility`.
 *
 * Extraction: same query shape as aiCheckBadMove.ts's ON_STAT_LOWERED_ABILITIES
 * with `bitfields.unaware` -- 4 entries. */
const UNAWARE_ABILITIES: readonly string[] = ['ABILITY_CONTEMPT', 'ABILITY_LEPIDOPTERAN', 'ABILITY_SWORD_OF_DAMNATION', 'ABILITY_UNAWARE']
function isUnaware(battler: BattlerState, attackerHasMoldBreaker: boolean): boolean {
  return UNAWARE_ABILITIES.some((id) => defAbility(battler, id, attackerHasMoldBreaker))
}

/** `IsBloodStainAffected(battler)`, battle_util.c -- Ghost/Rock immune,
 * otherwise a plain Blood Stain ability check. */
function isBloodStainAffected(battler: BattlerState): boolean {
  if (isBattlerOfType(battler, 'GHOST') || isBattlerOfType(battler, 'ROCK')) return false
  return selfAbility(battler, 'ABILITY_BLOOD_STAIN')
}

/** `CanBattlerHeal(battler)`, battle_util.c:8979-8986. `IsAbilityOnOpposingSide`
 * (Permanence/Hemolysis) has no port anywhere in this codebase -- no existing
 * "any battler on a side" ability scanner exists to build it from within this
 * batch's scope, so both checks are gapped, treated as absent (the common
 * case). Gapped only when the battler is actually asleep/poisoned enough for
 * it to matter is not tracked either; reported once per call as a standing
 * caveat like aiPipeline.ts's own moveLimitations note. */
function canBattlerHeal(battler: BattlerState, unmodelled: string[]): boolean {
  if (hasFlag(battler.statuses3, STATUS3_HEAL_BLOCK)) return false
  if (hasFlag(battler.mon.status1, STATUS1_BLEED)) return false
  if (isBloodStainAffected(battler)) return false
  unmodelled.push('CanBattlerHeal: IsAbilityOnOpposingSide(battler, ABILITY_PERMANENCE/ABILITY_HEMOLYSIS) has no port anywhere in this codebase; treated as absent')
  return true
}

/** `CompareStat(battlerId, statId, cmpTo, cmpKind)`, battle_util.c:8545-8580 --
 * narrowed to this batch's one call shape (`cmpKind = CMP_LESS_THAN`, i.e. the
 * literal `3` at :2682). The Contrary flip is checked as a bare self-ability
 * read (see this module's header gap note on Mold-Breaker direction). */
function compareStatLessThan(battler: BattlerState, stat: number, cmpTo: number): boolean {
  const contrary = selfAbility(battler, 'ABILITY_CONTRARY')
  const value = battler.mon.statStages[stat]
  if (contrary) {
    const flippedCmpTo = cmpTo === MAX_STAT_STAGE ? 0 : cmpTo
    return value > flippedCmpTo
  }
  return value < cmpTo
}

/** `CanAIFaintTarget(battlerAtk, battlerDef, numHits)`, battle_ai_util.c:
 * 972-987 -- loops the ATTACKER's own moveset (not the defender's, unlike
 * `canTargetFaintAi`), multiplying by `numHits` when nonzero. Recomputed via
 * `aiCalcDamage` per move rather than reading a `simulatedDmg` cache, same
 * precedent `canTargetFaintAi`'s own header documents. */
function canAiFaintTarget(state: BattleState, battlerAtk: number, battlerDef: number, numHits: number, deps: AiDamageDeps): { canFaint: boolean; unmodelled: string[] } {
  const attacker = state.battlers[battlerAtk]
  const target = state.battlers[battlerDef]?.mon
  if (!attacker || !target) return { canFaint: false, unmodelled: [] }
  const unmodelled: string[] = []
  for (const moveId of attacker.mon.moves) {
    if (!moveId) continue
    const { dmg, unmodelled: u } = aiCalcDamage(state, moveId, battlerAtk, battlerDef, deps)
    unmodelled.push(...u)
    const totalDmg = numHits ? dmg * numHits : dmg
    if (target.hp <= totalDmg) return { canFaint: true, unmodelled }
  }
  return { canFaint: false, unmodelled }
}

/** `CanTargetFaintAiWithMod(battlerDef, battlerAtk, hpMod, dmgMod)`,
 * battle_ai_util.c:1005-1021 -- same shape as `canTargetFaintAi` (loops the
 * POTENTIAL ATTACKER's moveset against the AI), with `hpMod` added to the AI's
 * HP and `dmgMod` multiplying each hit. `AI_DATA->moveLimitations` is not
 * modelled (same gap `canTargetFaintAi`'s own header documents) -- every move
 * is treated as usable. */
function canTargetFaintAiWithMod(state: BattleState, battlerDef: number, battlerAtk: number, hpMod: number, dmgMod: number, deps: AiDamageDeps): { canFaint: boolean; unmodelled: string[] } {
  const potentialAttacker = state.battlers[battlerDef]
  const aiMon = state.battlers[battlerAtk]?.mon
  if (!potentialAttacker || !aiMon) return { canFaint: false, unmodelled: [] }
  const unmodelled: string[] = []
  const hpCheck = aiMon.hp + hpMod
  for (const moveId of potentialAttacker.mon.moves) {
    if (!moveId) continue
    const { dmg, unmodelled: u } = aiCalcDamage(state, moveId, battlerDef, battlerAtk, deps)
    unmodelled.push(...u)
    const totalDmg = dmgMod ? dmg * dmgMod : dmg
    if (totalDmg >= hpCheck) return { canFaint: true, unmodelled }
  }
  return { canFaint: false, unmodelled }
}

/** `CanMoveFaintBattler(move, battlerDef, battlerAtk, nHits)`,
 * battle_ai_util.c:991-1001 -- `nHits` is accepted but never actually used by
 * the C body (its multiply-by-hits logic is commented out alongside the
 * moveLimitations check), a quirk reproduced here by simply not taking a
 * `numHits` parameter at all. `attackerId` "uses" `move` against `defenderId`. */
function canMoveFaintBattler(state: BattleState, moveId: string | null, attackerId: number, defenderId: number, deps: AiDamageDeps): { faints: boolean; unmodelled: string[] } {
  if (!moveId) return { faints: false, unmodelled: [] }
  const defender = state.battlers[defenderId]?.mon
  if (!defender) return { faints: false, unmodelled: [] }
  const { dmg, unmodelled } = aiCalcDamage(state, moveId, attackerId, defenderId, deps)
  return { faints: dmg >= defender.hp, unmodelled }
}

/** `HasMoveWithLowAccuracy(battlerAtk, battlerDef, accCheck, ignoreStatus, ...)`,
 * battle_ai_util.c:1427-1449 -- `AI_GetMoveAccuracy` (the fully-modified
 * accuracy) is approximated by each move's own declared `accuracy` (see this
 * module's header gap note); the MOVE_TARGET_USER/OPPONENTS_FIELD exclusion is
 * skipped (status-move accuracy==0 already covers the dominant real case,
 * "always hits" moves). `AI_DATA->moveLimitations` is not modelled (every move
 * usable, same as elsewhere in this batch). */
function hasMoveWithLowAccuracy(battler: BattlerState, accCheck: number, ignoreStatus: boolean, deps: AiDamageDeps, unmodelled: string[]): boolean {
  unmodelled.push('HasMoveWithLowAccuracy: AI_GetMoveAccuracy (weather/item/ability-modified accuracy) is approximated by the move\'s own declared accuracy')
  for (const moveId of battler.mon.moves) {
    if (!moveId) continue
    const split = deps.moveData(moveId)?.split
    const move = deps.dataContext.move(moveId) // `.accuracy` lives on SimMoveData, not MoveData (see this module's header).
    if (!move) continue
    if (ignoreStatus && split === 'STATUS') continue
    if (split !== 'STATUS' && move.accuracy === 0) continue
    if (move.accuracy !== 0 && move.accuracy <= accCheck) return true
  }
  return false
}

/** `IsPinchBerryItemEffect(holdEffect)`, item.c:383-397. */
const PINCH_BERRY_EFFECTS = new Set([
  'HOLD_EFFECT_ATTACK_UP', 'HOLD_EFFECT_DEFENSE_UP', 'HOLD_EFFECT_SPEED_UP', 'HOLD_EFFECT_SP_ATTACK_UP',
  'HOLD_EFFECT_SP_DEFENSE_UP', 'HOLD_EFFECT_CRITICAL_UP', 'HOLD_EFFECT_RANDOM_STAT_UP', 'HOLD_EFFECT_CUSTAP_BERRY', 'HOLD_EFFECT_MICLE_BERRY',
])
function isPinchBerryItemEffect(holdEffect: string | null): boolean {
  return !!holdEffect && PINCH_BERRY_EFFECTS.has(holdEffect)
}

/** `ShouldAbsorb(battlerAtk, battlerDef, move, damage)`, battle_ai_util.c:
 * 2202-2219. Draws `Random() % 3` (truthy, i.e. != 0 -- a 2/3 chance), its OWN
 * RNG line (not one of AI_CheckViability's 35), only when the AI goes first
 * and the target can't otherwise faint it. `move==0xFFFF` (using an item) is
 * never reached by a move-scoring call, so that half of the `||` is dead here. */
function shouldAbsorb(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, damage: number, deps: AiDamageDeps): { should: boolean; unmodelled: string[] } {
  const unmodelled: string[] = []
  const attacker = state.battlers[battlerAtk] as BattlerState
  const goesFirst = getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0
  if (goesFirst) {
    const move = deps.dataContext.move(moveId) // `.argumentInt` lives on SimMoveData, not MoveData.
    const healPercent = move?.argumentInt ? move.argumentInt : 50
    let healDmg = Math.floor((healPercent * damage) / 100)
    if (!canBattlerHeal(attacker, unmodelled)) healDmg = 0
    const targetCanFaint = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
    unmodelled.push(...targetCanFaint.unmodelled)
    if (targetCanFaint.canFaint) {
      const withHeal = canTargetFaintAiWithMod(state, battlerDef, battlerAtk, healDmg, 0, deps)
      unmodelled.push(...withHeal.unmodelled)
      if (!withHeal.canFaint) return { should: true, unmodelled }
    } else if (getHealthPercentage(state, battlerAtk) < 60 && state.rng.random16() % 3 !== 0) {
      return { should: true, unmodelled }
    }
  } else {
    const targetCanFaint = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
    unmodelled.push(...targetCanFaint.unmodelled)
    if (!targetCanFaint.canFaint) return { should: true, unmodelled }
  }
  return { should: false, unmodelled }
}

/** `ShouldRecover(battlerAtk, battlerDef, move, healPercent)`,
 * battle_ai_util.c:2232-2245. No RNG of its own. */
function shouldRecover(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, healPercent: number, deps: AiDamageDeps): { should: boolean; unmodelled: string[] } {
  const unmodelled: string[] = []
  const attacker = state.battlers[battlerAtk] as BattlerState
  const goesFirst = getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0
  if (!goesFirst) return { should: false, unmodelled }
  const { dmg, unmodelled: dmgU } = aiCalcDamage(state, moveId, battlerAtk, battlerDef, deps)
  unmodelled.push(...dmgU)
  let healAmount = Math.floor((healPercent * dmg) / 100)
  if (!canBattlerHeal(attacker, unmodelled)) healAmount = 0
  const targetCanFaint = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
  unmodelled.push(...targetCanFaint.unmodelled)
  if (targetCanFaint.canFaint) {
    const withHeal = canTargetFaintAiWithMod(state, battlerDef, battlerAtk, healAmount, 0, deps)
    unmodelled.push(...withHeal.unmodelled)
    if (!withHeal.canFaint) return { should: true, unmodelled }
  } else if (getHealthPercentage(state, battlerAtk) < 60 && state.rng.random16() % 3 !== 0) {
    return { should: true, unmodelled }
  }
  return { should: false, unmodelled }
}

/** `ShouldSetScreen(battlerAtk, battlerDef, moveEffect)`, battle_ai_util.c:
 * 2247-2266. `HasAuroraBorealis` (a real ability, `ABILITY_AURORA_BOREALIS`)
 * is a plain self-ability read, no gap. No RNG. */
function shouldSetScreen(state: BattleState, battlerAtk: number, battlerDef: number, moveEffect: string, deps: AiDamageDeps): boolean {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  const atkSideStatuses = state.sides[battlerAtk & 1].statuses
  switch (moveEffect) {
    case 'EFFECT_AURORA_VEIL':
      if (
        (isBattlerWeatherAffected(state, WEATHER_HAIL_ANY, deps) || selfAbility(attacker, 'ABILITY_AURORA_BOREALIS')) &&
        !hasFlag(atkSideStatuses, SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL)
      ) {
        return true
      }
      break
    case 'EFFECT_REFLECT':
      if (hasMoveWithSplit(defender, 'PHYSICAL', deps) && !hasFlag(atkSideStatuses, SIDE_STATUS_REFLECT)) return true
      break
    case 'EFFECT_LIGHT_SCREEN':
      if (hasMoveWithSplit(defender, 'SPECIAL', deps) && !hasFlag(atkSideStatuses, SIDE_STATUS_LIGHTSCREEN)) return true
      break
  }
  return false
}

/** `ShouldTrap(battlerAtk, battlerDef, move)`, battle_ai_util.c:2119-2131.
 * `BattlerWillFaintFromSecondaryDamage` reuses the established
 * GetBattlerSecondaryDamage gap (always 0, so always false here). No RNG. */
function shouldTrap(state: BattleState, battlerAtk: number, battlerDef: number, deps: AiDamageDeps, unmodelled: string[]): boolean {
  unmodelled.push('ShouldTrap: BattlerWillFaintFromSecondaryDamage(battlerDef) needs GetBattlerSecondaryDamage, which has no port anywhere in this codebase; treated as false')
  if (hasFlag(state.aiFlags, AI_FLAG_STALL)) {
    const canFaint = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
    unmodelled.push(...canFaint.unmodelled)
    if (!canFaint.canFaint) return true
  }
  return false
}

/** `ShouldTryToFlinch(battlerAtk, battlerDef, move)`, battle_ai_util.c:
 * 2106-2117. `IsAbilityStatusProtected(battlerDef, CHECK_FLINCH)` needs the
 * same onCanStatusType ability-hook scan aiCheckBadMove.ts's own
 * canBePoisoned/canSleep/etc. already gap -- treated as not protected. No RNG. */
function shouldTryToFlinch(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, deps: AiDamageDeps, unmodelled: string[]): number {
  unmodelled.push('ShouldTryToFlinch: IsAbilityStatusProtected(battlerDef, CHECK_FLINCH) needs an onCanStatusType ability-hook scan this batch does not wire; treated as not protected')
  const defender = state.battlers[battlerDef] as BattlerState
  const attacker = state.battlers[battlerAtk] as BattlerState
  if (doesSubstituteBlockMove(attacker, defender, deps.moveData(moveId), unmodelled) || getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 1) {
    return 0
  }
  if (hasFlag(defender.mon.status1, STATUS1_SLEEP) && !hasMoveEffect(defender, 'EFFECT_SLEEP_TALK', deps) && !hasMoveEffect(defender, 'EFFECT_SNORE', deps)) {
    return 0
  }
  if (hasFlag(defender.mon.status1, STATUS1_PARALYSIS) || hasFlag(defender.mon.status2, STATUS2_CONFUSION)) return 2
  return 1
}

/** `ShouldUseWishAromatherapy(battlerAtk, battlerDef, move)`, battle_ai_util.c:
 * 2372-2401 -- the singles half only (`!IsDoubleBattle()` is always true).
 * Soundproof/Noise Cancel are plain self-ability reads on the party mon.
 * `GetAIPartyIndexes` collapses to the literal 0..5 range, per aiSwitching.ts's
 * own header precedent. `MON_DATA_IS_EGG` is not modelled (eggs are not a
 * concept in this sim's party data, same as aiSwitching.ts's own doc). No RNG. */
function shouldUseWishAromatherapy(state: BattleState, battlerDef: number, moveId: string, deps: AiDamageDeps): boolean {
  const side = state.sides[battlerDef & 1]
  let hasStatus = false
  let needHealing = false
  for (const mon of side.party) {
    if (!mon || mon.speciesId === null || mon.hp === 0) continue
    if (mon.hp * 100 < mon.maxHp * 65) needHealing = true
    if (mon.status1 !== 0) {
      const soundproof = mon.abilities.ability === 'ABILITY_SOUNDPROOF' || mon.abilities.innates.includes('ABILITY_SOUNDPROOF')
      const noiseCancel = mon.abilities.ability === 'ABILITY_NOISE_CANCEL' || mon.abilities.innates.includes('ABILITY_NOISE_CANCEL')
      if (moveId !== 'MOVE_HEAL_BELL' || !soundproof) hasStatus = true
      if (moveId !== 'MOVE_HEAL_BELL' || !noiseCancel) hasStatus = true
    }
  }
  const effect = deps.moveData(moveId)?.effect
  if (effect === 'EFFECT_WISH') return needHealing
  if (effect === 'EFFECT_HEAL_BELL') return hasStatus
  return false
}

/** `ProtectChecks(battlerAtk, battlerDef, move, predictedMove, score)`,
 * battle_ai_util.c:1242-1268. `predictedMove` is real (`battler.lastMove`,
 * see this module's header); its `!= MOVE_NONE && !IS_MOVE_STATUS` branch
 * only fires when the defender's actual last move exists and was damaging.
 * Draws a bare `Random() % 256 < 100` (NOT `AI_RandLessThan`'s `% 0xFF` -- its
 * own literal `% 256`), its own RNG line, only when `protectUses == 0` and the
 * predicted-move branch doesn't fire. */
function protectChecks(state: BattleState, battlerAtk: number, battlerDef: number, predictedMoveId: string | null, score: number, deps: AiDamageDeps): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  const uses = attacker.volatiles.protectUses
  if (uses === 0) {
    const predicted = predictedMoveId ? deps.moveData(predictedMoveId) : null
    if (predicted && predicted.split !== 'STATUS') {
      score += 2
    } else if (state.rng.random16() % 256 < 100) {
      score++
    }
  } else {
    score -= Math.min(uses, 3)
  }
  if (
    hasFlag(attacker.mon.status1, STATUS1_POISON_ANY | STATUS1_BURN | STATUS1_FROSTBITE) ||
    hasFlag(attacker.mon.status2, STATUS2_CURSED) ||
    hasFlag(attacker.statuses3, STATUS3_PERISH_SONG | STATUS3_LEECHSEED | STATUS3_YAWN)
  ) {
    score--
  }
  if (
    hasFlag(defender.mon.status1, STATUS1_TOXIC_POISON) ||
    hasFlag(defender.mon.status2, STATUS2_CURSED) ||
    hasFlag(defender.statuses3, STATUS3_PERISH_SONG | STATUS3_LEECHSEED | STATUS3_YAWN)
  ) {
    score += 2
  }
  return score
}

/** `ShouldPivot(battlerAtk, battlerDef, move, moveIndex)`, battle_ai_util.c:
 * 1876-1997 -- the singles branch only (`!IsDoubleBattle()` always true).
 * `PartyBattlerShouldAvoidHazards` (needs the resolved switch-target mon's
 * species/ability/item and side hazard state) and `IsUnnerveAbilityOnOpposingSide`
 * have no port anywhere in this codebase -- both gapped, treated as
 * false/absent (the common case, and the C's own "not avoiding hazards"/"not
 * unnerved" defaults). `BattlerWillFaintFromSecondaryDamage` reuses the
 * established GetBattlerSecondaryDamage gap. No RNG of its own (ShouldSwitch,
 * which it calls, may draw). */
const DONT_PIVOT = 0
const CAN_TRY_PIVOT = 1
const PIVOT = 2
function shouldPivot(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, deps: AiDamageDeps): { result: number; unmodelled: string[] } {
  const unmodelled: string[] = []
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  const move = deps.moveData(moveId)
  const isStatus = move?.split === 'STATUS'

  unmodelled.push('ShouldPivot: PartyBattlerShouldAvoidHazards has no port anywhere in this codebase (needs the resolved switch-target mon); treated as false')
  const hasStatBoost = anyStatIsRaised(attacker) || defender.mon.statStages[STAT_EVASION] >= 9

  const switchResult = shouldSwitch(state, battlerAtk, deps)
  unmodelled.push(...switchResult.unmodelled)
  const doesSwitch = switchResult.shouldSwitch

  if (countUsablePartyMons(state, battlerAtk) === 0) return { result: CAN_TRY_PIVOT, unmodelled }

  const attackerGoesFirst = getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0
  unmodelled.push('ShouldPivot: IsUnnerveAbilityOnOpposingSide has no port anywhere in this codebase; treated as false')
  const sashOrSturdyBreak = () => {
    const holdEffect = getBattlerHoldEffect(defender, deps)
    return atMaxHp(defender) && (holdEffect === 'HOLD_EFFECT_FOCUS_SASH' || defAbility(defender, 'ABILITY_STURDY', deps.grounding.attackerHasMoldBreaker) || defAbility(defender, 'ABILITY_MULTISCALE', deps.grounding.attackerHasMoldBreaker) || defAbility(defender, 'ABILITY_SHADOW_SHIELD', deps.grounding.attackerHasMoldBreaker))
  }

  if (attackerGoesFirst) {
    const faintNow = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
    unmodelled.push(...faintNow.unmodelled)
    if (!faintNow.canFaint) {
      const faintIn2 = canAiFaintTarget(state, battlerAtk, battlerDef, 2, deps)
      unmodelled.push(...faintIn2.unmodelled)
      if (faintIn2.canFaint) {
        const targetFaintsAi = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
        unmodelled.push(...targetFaintsAi.unmodelled)
        if (targetFaintsAi.canFaint) return { result: PIVOT, unmodelled }
        if (!isStatus && (doesSwitch || sashOrSturdyBreak())) return { result: PIVOT, unmodelled }
      } else if (!hasStatBoost) {
        if (!isStatus && sashOrSturdyBreak()) return { result: PIVOT, unmodelled }
        if (doesSwitch) return { result: PIVOT, unmodelled }
      }
    }
  } else {
    const targetFaintsAi = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
    unmodelled.push(...targetFaintsAi.unmodelled)
    if (targetFaintsAi.canFaint) {
      if (move?.effect === 'EFFECT_SWITCH_ARGUMENT') return { result: DONT_PIVOT, unmodelled }
      return { result: CAN_TRY_PIVOT, unmodelled }
    }
    const twoHko = canTargetFaintAiWithMod(state, battlerDef, battlerAtk, 0, 2, deps)
    unmodelled.push(...twoHko.unmodelled)
    unmodelled.push('ShouldPivot: BattlerWillFaintFromSecondaryDamage(battlerAtk) needs GetBattlerSecondaryDamage, which has no port anywhere in this codebase; treated as false')
    if (twoHko.canFaint) {
      const faintNow = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
      unmodelled.push(...faintNow.unmodelled)
      if (faintNow.canFaint) {
        return { result: CAN_TRY_PIVOT, unmodelled }
      }
      return { result: PIVOT, unmodelled }
    } else {
      const faintNow = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
      unmodelled.push(...faintNow.unmodelled)
      if (faintNow.canFaint) {
        if (!hasStatBoost) return { result: CAN_TRY_PIVOT, unmodelled }
      } else {
        const faintIn2 = canAiFaintTarget(state, battlerAtk, battlerDef, 2, deps)
        unmodelled.push(...faintIn2.unmodelled)
        if (faintIn2.canFaint) {
          const holdEffect = getBattlerHoldEffect(defender, deps)
          if (isStatus && (doesSwitch || (holdEffect === 'HOLD_EFFECT_FOCUS_SASH' && atMaxHp(defender)))) {
            return { result: DONT_PIVOT, unmodelled }
          }
          return { result: CAN_TRY_PIVOT, unmodelled }
        } else if (!hasStatBoost) {
          return { result: CAN_TRY_PIVOT, unmodelled }
        }
      }
    }
  }
  return { result: DONT_PIVOT, unmodelled }
}

/** `IncreaseStatUpScore(battlerAtk, battlerDef, statId, score)`,
 * battle_ai_util.c:2592-2650. `GetBattlerSecondaryDamage`/
 * `BattlerWillFaintFromWeather` reuse the established always-0/false gaps.
 * No RNG. */
function increaseStatUpScore(state: BattleState, battlerAtk: number, battlerDef: number, statId: number, moveId: string, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  const atkMoldBreaker = deps.grounding.attackerHasMoldBreaker

  const canFaint = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
  unmodelled.push(...canFaint.unmodelled)
  if (canFaint.canFaint) return score

  if (defAbility(attacker, 'ABILITY_CONTRARY', atkMoldBreaker) || (isUnaware(defender, atkMoldBreaker) && statId !== STAT_SPEED)) return score

  const atkHp = getHealthPercentage(state, battlerAtk)
  if (atkHp < 80 && aiRandLessThan(state, 128)) return score

  if (hasFlag(state.aiFlags, AI_FLAG_TRY_TO_FAINT)) {
    const faint = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
    unmodelled.push(...faint.unmodelled)
    if (faint.canFaint) return score
  }

  if (isBattlerWeatherAffected(state, WEATHER_FOG_ANY, deps) && (attacker.volatiles.trickOrTreat || !(isBattlerOfType(attacker, 'GHOST') || isBattlerOfType(attacker, 'PSYCHIC')))) {
    return score
  }

  if (hasFlag(defender.mon.status1, STATUS1_SLEEP) && attacker.mon.statStages[statId] < 8) score += 5
  if (hasMoveEffect(attacker, 'EFFECT_STORED_POWER', deps) && attacker.mon.statStages[statId] < 8 && atkHp > 40) score += 5

  switch (statId) {
    case STAT_ATK:
      if (hasMoveWithSplit(attacker, 'PHYSICAL', deps) && atkHp > 40) {
        if (attacker.mon.statStages[STAT_ATK] < 8) score += 2
        else if (attacker.mon.statStages[STAT_ATK] < 10) score++
      }
      if (hasMoveEffect(attacker, 'EFFECT_FOUL_PLAY', deps)) score++
      break
    case STAT_DEF: {
      const lastMoveIsPhysical = defender.lastMove ? deps.moveData(defender.lastMove)?.split === 'PHYSICAL' : false
      if ((hasMoveWithSplit(defender, 'PHYSICAL', deps) || lastMoveIsPhysical) && atkHp > 70) {
        if (attacker.mon.statStages[STAT_DEF] < 8) score += 2
        else if (attacker.mon.statStages[STAT_DEF] < 10) score++
      }
      break
    }
    case STAT_SPEED:
      // `IsAiFaster(AI_CHECK_SLOWER)` -- "is the target faster" -- is exactly
      // `!isAiFaster(AI_CHECK_FASTER)` (see this module's header equivalence
      // note).
      if (!isAiFaster(state, battlerAtk, battlerDef, moveId, deps)) {
        if (attacker.mon.statStages[STAT_SPEED] < 8) score += 2
        else if (attacker.mon.statStages[STAT_SPEED] < 10) score++
      }
      break
    case STAT_SPATK:
      if (hasMoveWithSplit(attacker, 'SPECIAL', deps) && atkHp > 40) {
        if (attacker.mon.statStages[STAT_SPATK] < 8) score += 2
        else if (attacker.mon.statStages[STAT_SPATK] < 10) score++
      }
      break
    case STAT_SPDEF: {
      const lastMoveIsSpecial = defender.lastMove ? deps.moveData(defender.lastMove)?.split === 'SPECIAL' : false
      if ((hasMoveWithSplit(defender, 'SPECIAL', deps) || lastMoveIsSpecial) && atkHp > 70) {
        if (attacker.mon.statStages[STAT_SPDEF] < 8) score += 2
        else if (attacker.mon.statStages[STAT_SPDEF] < 10) score++
      }
      break
    }
    case STAT_ACC:
      if (hasMoveWithLowAccuracy(attacker, 80, true, deps, unmodelled)) score += 2
      else if (hasMoveWithLowAccuracy(attacker, 90, true, deps, unmodelled)) score++
      break
    case STAT_EVASION:
      unmodelled.push('IncreaseStatUpScore(STAT_EVASION): BattlerWillFaintFromWeather has no port anywhere in this codebase; treated as false')
      unmodelled.push('IncreaseStatUpScore(STAT_EVASION): GetBattlerSecondaryDamage has no port anywhere in this codebase; treated as 0')
      if (!hasFlag(attacker.statuses3, STATUS3_ROOTED)) score += 2
      else score++
      break
  }
  return score
}

/** The shared body of `case EFFECT_GROWTH` (after its own Chloroplast/Sun
 * bonus) and `case EFFECT_ATTACK_SPATK_UP`, battle_ai_main.c:2874-2880 --
 * pulled into its own function since TS's `noFallthroughCasesInSwitch`
 * forbids the C's own syntactic fallthrough between the two cases (see each
 * case's own call site). */
function applyAttackSpatkUp(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  if (getHealthPercentage(state, battlerAtk) <= 40 || selfAbility(attacker, 'ABILITY_CONTRARY')) return score
  if (hasMoveWithSplit(attacker, 'PHYSICAL', deps)) return increaseStatUpScore(state, battlerAtk, battlerDef, STAT_ATK, moveId, score, deps, unmodelled)
  if (hasMoveWithSplit(attacker, 'SPECIAL', deps)) return increaseStatUpScore(state, battlerAtk, battlerDef, STAT_SPATK, moveId, score, deps, unmodelled)
  return score
}

/** `IncreasePoisonScore(battlerAtk, battlerDef, move, score)`,
 * battle_ai_util.c:2672-2679. `AI_CanPoison` is a bare `CanBePoisoned` wrapper
 * (its own one-line C body) -- `canBePoisoned` handles that directly. No RNG. */
function increasePoisonScore(state: BattleState, battlerAtk: number, battlerDef: number, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  if (hasFlag(state.aiFlags, AI_FLAG_TRY_TO_FAINT)) {
    const faint = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
    unmodelled.push(...faint.unmodelled)
    if (faint.canFaint) return score
  }
  const poison = canBePoisoned(state, attacker, defender, deps)
  unmodelled.push(...poison.unmodelled)
  if (poison.canPoison && getHealthPercentage(state, battlerDef) > 20) {
    if (!hasDamagingMove(defender, deps)) score += 2
    if (hasFlag(state.aiFlags, AI_FLAG_STALL) && hasMoveEffect(attacker, 'EFFECT_PROTECT', deps)) score++
    if (hasMoveEffect(attacker, 'EFFECT_VENOSHOCK', deps) || hasMoveEffect(attacker, 'EFFECT_HEX', deps) || hasMoveEffect(attacker, 'EFFECT_VENOM_DRENCH', deps) || selfAbility(attacker, 'ABILITY_MERCILESS')) {
      score += 2
    } else {
      score++
    }
  }
  return score
}

/** `IncreaseParalyzeScore(battlerAtk, battlerDef, move, score)`,
 * battle_ai_util.c:2701-2714. No RNG. */
function increaseParalyzeScore(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  if (hasFlag(state.aiFlags, AI_FLAG_TRY_TO_FAINT)) {
    const faint = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
    unmodelled.push(...faint.unmodelled)
    if (faint.canFaint) return score
  }
  const paralyze = aiCanParalyze(state, attacker, defender, moveId, deps)
  unmodelled.push(...paralyze.unmodelled)
  if (paralyze.canParalyze) {
    const atkSpeed = getBattlerSpeedForParalyze(state, battlerAtk, deps)
    const defSpeed = getBattlerSpeedForParalyze(state, battlerDef, deps)
    if ((defSpeed >= atkSpeed && defSpeed / 2 < atkSpeed) || hasMoveEffect(attacker, 'EFFECT_HEX', deps) || hasMoveEffect(attacker, 'EFFECT_FLINCH_HIT', deps) || hasFlag(defender.mon.status2, STATUS2_CONFUSION)) {
      score += 4
    } else {
      score += 2
    }
  }
  return score
}
/** `GetBattlerTotalSpeedStat(battler, TOTAL_SPEED_FULL, move)` -- reused from
 * turnOrder.ts's own export (aiScorers.ts's `isAiFaster` doesn't need it
 * directly, but this call site does). `MOVE_NONE` (the defender's own read)
 * is passed as `null`. */
function getBattlerSpeedForParalyze(state: BattleState, battlerId: number, deps: AiDamageDeps): number {
  return getBattlerTotalSpeedStat(state, battlerId, TOTAL_SPEED_FULL, null, deps.turnOrder, deps.statStageRatios)
}

/** `IncreaseSleepScore(battlerAtk, battlerDef, move, score)`,
 * battle_ai_util.c:2716-2731. `AI_CanPutToSleep` is a bare `CanSleep(battlerDef)`
 * wrapper. Draws `AI_RandLessThan(128)` -- its own RNG line (battle_ai_util.c:
 * 2724), not one of AI_CheckViability's 35. */
function increaseSleepScore(state: BattleState, battlerAtk: number, battlerDef: number, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  if (hasFlag(state.aiFlags, AI_FLAG_TRY_TO_FAINT)) {
    const faint = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
    unmodelled.push(...faint.unmodelled)
    if (faint.canFaint) return score
  }
  const sleep = canSleep(state, defender, deps)
  unmodelled.push(...sleep.unmodelled)
  if (!sleep.canSleep) return score
  score += 3
  if (aiRandLessThan(state, 128)) score += 2
  if ((hasMoveEffect(attacker, 'EFFECT_DREAM_EATER', deps) || hasMoveEffect(attacker, 'EFFECT_NIGHTMARE', deps)) && !(hasMoveEffect(defender, 'EFFECT_SNORE', deps) || hasMoveEffect(defender, 'EFFECT_SLEEP_TALK', deps))) {
    score++
  }
  // C also ORs `HasMoveEffect(BATTLE_PARTNER(battlerAtk), EFFECT_HEX)` here --
  // dead code on this singles-only build (no partner slot exists in this sim's
  // battler state), same doubles-dead-code treatment as this file's other
  // partner reads (e.g. `partnerHasSameMoveEffectWithoutTarget`).
  if (hasMoveEffect(attacker, 'EFFECT_HEX', deps)) score++
  return score
}

/** `IncreaseConfusionScore(battlerAtk, battlerDef, move, score)`,
 * battle_ai_util.c:2733-2746. `AI_DATA->partnerMove` is always MOVE_NONE
 * (structural, see this module's header) so `IsConfusionMoveEffect(gBattleMoves
 * [AI_DATA->partnerMove].effect)` is always false here -- not a gap. No RNG. */
function increaseConfusionScore(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  if (hasFlag(state.aiFlags, AI_FLAG_TRY_TO_FAINT)) {
    const faint = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
    unmodelled.push(...faint.unmodelled)
    if (faint.canFaint) return score
  }
  const canConfuse = canBeConfused(defender, unmodelled)
  const holdEffect = getBattlerHoldEffect(defender, deps)
  const move = deps.moveData(moveId)
  const secondaryOk = moveConfusionThresholdOk(move)
  if (canConfuse && holdEffect !== 'HOLD_EFFECT_CURE_CONFUSION' && holdEffect !== 'HOLD_EFFECT_CURE_STATUS' && secondaryOk) {
    if (hasFlag(defender.mon.status1, STATUS1_PARALYSIS) || (selfAbility(attacker, 'ABILITY_SERENE_GRACE') && hasMoveEffect(attacker, 'EFFECT_FLINCH_HIT', deps))) {
      score += 3
    } else {
      score += 2
    }
  }
  return score
}
/** `gBattleMoves[move].secondaryEffectChance >= 30 || gBattleMoves[move].split
 * == SPLIT_STATUS` -- `MoveData.effectChance` (calculate.ts) is the same
 * `moves.json` field, so this is a direct read, not an approximation. */
function moveConfusionThresholdOk(move: ReturnType<AiDamageDeps['moveData']> | undefined): boolean {
  if (!move) return false
  if (move.split === 'STATUS') return true
  return move.effectChance >= 30
}

/** `AI_MoveMakesContact(battler, holdEffect, move)`, battle_ai_util.c:
 * 743-746 -- note the C's own condition is `contact && LONG_REACH && holdEffect
 * != PROTECTIVE_PADS`, i.e. it returns TRUE only when the move makes contact
 * AND the battler has Long Reach (which normally REMOVES contact) AND isn't
 * holding Protective Pads -- an inverted-looking quirk reproduced exactly as
 * written, not "fixed" to the intuitive `!LONG_REACH` reading. */
function aiMoveMakesContact(battler: BattlerState, holdEffect: string | null, move: ReturnType<AiDamageDeps['moveData']>): boolean {
  return !!hasMoveFlag(move, 'contact') && selfAbility(battler, 'ABILITY_LONG_REACH') && holdEffect !== 'HOLD_EFFECT_PROTECTIVE_PADS'
}

// ---------------------------------------------------------------------------
// Part 2a helpers (battle_ai_main.c:3224-3606's own battle_ai_util.c callees)
// ---------------------------------------------------------------------------

/** `BATTLE_PARTNER(battler)`, constants/battle.h:37. */
function battlePartner(battlerId: number): number {
  return battlerId ^ 2
}

/** `IsBattlerAlive(battlerId)`, battle_util.c:6685-6694. The partner slot in
 * singles is `>= gBattlersCount` / absent, so a partner read is FALSE. */
function isBattlerAlive(state: BattleState, battlerId: number): boolean {
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) return false
  if (battlerId >= state.battlersCount) return false
  return !hasFlag(state.absentBattlerFlags, 1 << battlerId)
}

/** `HasMoveEffect(battlerId, effect)` for a battler slot that may be empty (the
 * doubles-only `BATTLE_PARTNER(...)` reads; an empty slot has no moves). */
function hasMoveEffectOf(state: BattleState, battlerId: number, effect: string, deps: AiDamageDeps): boolean {
  const battler = state.battlers[battlerId]
  return !!battler && hasMoveEffect(battler, effect, deps)
}

/** `HasMoveWithType(battlerId, type)` for a possibly-empty slot. */
function hasMoveWithTypeOf(state: BattleState, battlerId: number, type: string, deps: AiDamageDeps): boolean {
  const battler = state.battlers[battlerId]
  return !!battler && hasMoveWithType(battler, type, deps)
}

/** `HasMove(battlerId, move)`, battle_ai_util.c:1416-1425. */
function hasMove(battler: BattlerState, moveId: string): boolean {
  return battler.mon.moves.some((m) => m === moveId)
}

/** `HasDamagingMoveOfType(battlerId, type)`, battle_ai_util.c:1642-1651. */
function hasDamagingMoveOfType(battler: BattlerState, type: string, deps: AiDamageDeps): boolean {
  return battler.mon.moves.some((m) => {
    const md = m ? deps.moveData(m) : undefined
    return !!md && md.type === type && md.power !== 0
  })
}

/** `IsWeatherActive(weather)`, battle_util.c:8639-8642. */
function isWeatherActive(state: BattleState, weatherFlag: number, deps: AiDamageDeps): boolean {
  if (!hasFlag(state.field.weather, weatherFlag)) return false
  return weatherHasEffect(state, deps.grounding)
}

/** `AI_DATA->holdEffects[battler]` / `AI_GetHoldEffect(battler)`.
 *
 * QUIRK NOT REPRODUCED (named, exactly when it applies): battle_ai_main.c:216
 * fills `AI_DATA->holdEffects[battlerId]` from `ItemId_GetHoldEffectParam(
 * gBattleMons[battlerId].item)` -- the item's numeric PARAM, not
 * `ItemId_GetHoldEffect`. Every `holdEffects[b] == HOLD_EFFECT_X` comparison in
 * the C therefore compares a param against an enum value. The numeric
 * HOLD_EFFECT_* values live in `generated/constants/hold_effects.h`, which is
 * not fetched, so the real comparison cannot be evaluated; this port (like part
 * 1 and aiCheckBadMove.ts before it) reads the item's real resolved hold
 * effect. For an item-less battler the two agree (param 0 == HOLD_EFFECT_NONE),
 * so the note is only pushed when an item is held. */
function aiHoldEffect(battler: BattlerState, deps: AiDamageDeps, unmodelled: string[]): string | null {
  if (battler.mon.itemId) {
    const note = 'AI_DATA->holdEffects[] is filled from ItemId_GetHoldEffectParam (battle_ai_main.c:216), not the hold effect itself; the C compares an item PARAM against HOLD_EFFECT_* enum values (numeric values live in the unfetched generated/constants/hold_effects.h). This port reads the real resolved hold effect instead'
    if (!unmodelled.includes(note)) unmodelled.push(note)
  }
  return getBattlerHoldEffect(battler, deps)
}

/** `HasChloroplast(battler)`, battle_util.c:9340-9343
 * (`RETURN_ABILITY_IF_FLAG(battler, FALSE, chloroplast)`, never suppressed). */
function hasChloroplast(battler: BattlerState): boolean {
  return CHLOROPLAST_ABILITIES.some((id) => selfAbility(battler, id))
}

/** `HasWeatherBallAndNoForcedTyping(battler)`, battle_ai_util.c:1155-1157.
 * `HasAuroraBorealis` is `BattlerHasAbility(battler, ABILITY_AURORA_BOREALIS,
 * FALSE)` (battle_util.c:9345-9348). */
function hasWeatherBallAndNoForcedTyping(battler: BattlerState, deps: AiDamageDeps): boolean {
  return !hasChloroplast(battler) && !selfAbility(battler, 'ABILITY_AURORA_BOREALIS') && hasMoveEffect(battler, 'EFFECT_WEATHER_BALL', deps)
}

/** `ShouldSetSandstorm(battler, holdEffect)`, battle_ai_util.c:1159-1169
 * (`holdEffect` is never read). `BATTLER_HAS_ABILITY`-family reads here are on
 * the attacker itself, so never suppressed. No RNG. */
function shouldSetSandstorm(state: BattleState, battlerAtk: number, deps: AiDamageDeps): boolean {
  const attacker = state.battlers[battlerAtk] as BattlerState
  if (!weatherHasEffect(state, deps.grounding)) return false
  if (hasFlag(state.field.weather, WEATHER_SANDSTORM_ANY | WEATHER_PRIMAL_ANY)) return false
  return isSandImmune(state, attacker, deps.dataContext) || hasMoveEffect(attacker, 'EFFECT_SHORE_UP', deps) || hasWeatherBallAndNoForcedTyping(attacker, deps)
}

/** `ShouldSetHail`, battle_ai_util.c:1171-1182. */
function shouldSetHail(state: BattleState, battlerAtk: number, deps: AiDamageDeps): boolean {
  const attacker = state.battlers[battlerAtk] as BattlerState
  if (!weatherHasEffect(state, deps.grounding)) return false
  if (hasFlag(state.field.weather, WEATHER_HAIL_ANY | WEATHER_PRIMAL_ANY)) return false
  return (
    isHailImmune(state, attacker, deps.dataContext) ||
    (!selfAbility(attacker, 'ABILITY_AURORA_BOREALIS') && (hasMove(attacker, 'MOVE_BLIZZARD') || hasMoveEffect(attacker, 'EFFECT_AURORA_VEIL', deps))) ||
    hasWeatherBallAndNoForcedTyping(attacker, deps)
  )
}

/** `ShouldSetRain`, battle_ai_util.c:1184-1197. */
function shouldSetRain(state: BattleState, battlerAtk: number, deps: AiDamageDeps): boolean {
  const attacker = state.battlers[battlerAtk] as BattlerState
  if (!weatherHasEffect(state, deps.grounding)) return false
  if (hasFlag(state.field.weather, WEATHER_RAIN_ANY | WEATHER_PRIMAL_ANY)) return false
  return (
    selfAbility(attacker, 'ABILITY_SWIFT_SWIM') ||
    selfAbility(attacker, 'ABILITY_FORECAST') ||
    selfAbility(attacker, 'ABILITY_HYDRATION') ||
    selfAbility(attacker, 'ABILITY_RAIN_DISH') ||
    selfAbility(attacker, 'ABILITY_DRY_SKIN') ||
    hasMoveEffect(attacker, 'EFFECT_THUNDER', deps) ||
    hasMoveEffect(attacker, 'EFFECT_HURRICANE', deps) ||
    hasWeatherBallAndNoForcedTyping(attacker, deps) ||
    hasMoveWithType(attacker, 'WATER', deps)
  )
}

/** `ShouldSetSun`, battle_ai_util.c:1199-1215. */
function shouldSetSun(state: BattleState, battlerAtk: number, deps: AiDamageDeps): boolean {
  const attacker = state.battlers[battlerAtk] as BattlerState
  if (!weatherHasEffect(state, deps.grounding)) return false
  if (hasFlag(state.field.weather, WEATHER_SUN_ANY | WEATHER_PRIMAL_ANY)) return false
  return (
    selfAbility(attacker, 'ABILITY_CHLOROPHYLL') ||
    selfAbility(attacker, 'ABILITY_FLOWER_GIFT') ||
    selfAbility(attacker, 'ABILITY_FORECAST') ||
    selfAbility(attacker, 'ABILITY_LEAF_GUARD') ||
    selfAbility(attacker, 'ABILITY_SOLAR_POWER') ||
    selfAbility(attacker, 'ABILITY_HARVEST') ||
    hasMoveWithType(attacker, 'FIRE', deps) ||
    (!hasChloroplast(attacker) &&
      (hasMoveEffect(attacker, 'EFFECT_SOLARBEAM', deps) ||
        hasMoveEffect(attacker, 'EFFECT_MORNING_SUN', deps) ||
        hasMoveEffect(attacker, 'EFFECT_SYNTHESIS', deps) ||
        hasMoveEffect(attacker, 'EFFECT_MOONLIGHT', deps) ||
        hasMoveEffect(attacker, 'EFFECT_GROWTH', deps))) ||
    hasWeatherBallAndNoForcedTyping(attacker, deps)
  )
}

/** `sFogAbilities[]`, battle_ai_util.c:1217-1223, transcribed literally. */
const FOG_ABILITIES: readonly string[] = ['ABILITY_ECTOPLASM', 'ABILITY_ETHEREAL_RUSH', 'ABILITY_WHITE_NOISE', 'ABILITY_PEACEFUL_REST', 'ABILITY_SURPRISE']
/** `ShouldSetFog`, battle_ai_util.c:1225-1240. */
function shouldSetFog(state: BattleState, battlerAtk: number, deps: AiDamageDeps): boolean {
  const attacker = state.battlers[battlerAtk] as BattlerState
  if (!weatherHasEffect(state, deps.grounding)) return false
  if (hasFlag(state.field.weather, WEATHER_FOG_ANY | WEATHER_PRIMAL_ANY)) return false
  if (isBattlerOfType(attacker, 'GHOST') && !attacker.volatiles.trickOrTreat) return true
  if (hasMove(attacker, 'MOVE_OMINOUS_WIND')) return true
  return FOG_ABILITIES.some((id) => selfAbility(attacker, id))
}

/** `ShouldPoisonSelf(battler)`, battle_ai_util.c:2034-2043. `CanBePoisoned(battler,
 * battler, MOVE_NONE)` keeps canBePoisoned's own gaps. Every ability read is
 * `BattlerHasAbility(..., FALSE)` on the battler itself. */
function shouldPoisonSelf(state: BattleState, battlerId: number, deps: AiDamageDeps, unmodelled: string[]): boolean {
  const battler = state.battlers[battlerId] as BattlerState
  const poison = canBePoisoned(state, battler, battler, deps)
  unmodelled.push(...poison.unmodelled)
  if (!poison.canPoison) return false
  return (
    selfAbility(battler, 'ABILITY_POISON_HEAL') ||
    selfAbility(battler, 'ABILITY_MARVEL_SCALE') ||
    selfAbility(battler, 'ABILITY_QUICK_FEET') ||
    isMagicGuardProtected(state, battler) ||
    hasMoveEffect(battler, 'EFFECT_FACADE', deps) ||
    hasMoveEffect(battler, 'EFFECT_PSYCHO_SHIFT', deps) ||
    (selfAbility(battler, 'ABILITY_TOXIC_BOOST') && hasMoveWithSplit(battler, 'PHYSICAL', deps)) ||
    (selfAbility(battler, 'ABILITY_GUTS') && hasMoveWithSplit(battler, 'PHYSICAL', deps))
  )
}

/** `ShouldBurnSelf(battler)`, battle_ai_util.c:2059-2068. */
function shouldBurnSelf(state: BattleState, battlerId: number, deps: AiDamageDeps, unmodelled: string[]): boolean {
  const battler = state.battlers[battlerId] as BattlerState
  if (!aiCanBurn(battler, unmodelled)) return false
  return (
    selfAbility(battler, 'ABILITY_QUICK_FEET') ||
    selfAbility(battler, 'ABILITY_HEATPROOF') ||
    isMagicGuardProtected(state, battler) ||
    hasMoveEffect(battler, 'EFFECT_FACADE', deps) ||
    hasMoveEffect(battler, 'EFFECT_PSYCHO_SHIFT', deps) ||
    (selfAbility(battler, 'ABILITY_FLARE_BOOST') && hasMoveWithSplit(battler, 'SPECIAL', deps)) ||
    (selfAbility(battler, 'ABILITY_GUTS') && hasMoveWithSplit(battler, 'PHYSICAL', deps)) ||
    (selfAbility(battler, 'ABILITY_DETERMINATION') && hasMoveWithSplit(battler, 'SPECIAL', deps))
  )
}

/** `ShouldFrostbiteSelf(battler)`, battle_ai_util.c:2070-2077. */
function shouldFrostbiteSelf(state: BattleState, battlerId: number, deps: AiDamageDeps, unmodelled: string[]): boolean {
  const battler = state.battlers[battlerId] as BattlerState
  if (!canGetFrostbite(battler, unmodelled)) return false
  return (
    isMagicGuardProtected(state, battler) ||
    hasMoveEffect(battler, 'EFFECT_FACADE', deps) ||
    hasMoveEffect(battler, 'EFFECT_PSYCHO_SHIFT', deps) ||
    (selfAbility(battler, 'ABILITY_GUTS') && hasMoveWithSplit(battler, 'PHYSICAL', deps)) ||
    (selfAbility(battler, 'ABILITY_DETERMINATION') && hasMoveWithSplit(battler, 'SPECIAL', deps))
  )
}

/** `IncreaseBurnScore(battlerAtk, battlerDef, move, score)`, battle_ai_util.c:
 * 2688-2699. `AI_CanBurn`'s `partnerMove` term is always MOVE_NONE on this
 * singles-only build (structural). No RNG. */
function increaseBurnScore(state: BattleState, battlerAtk: number, battlerDef: number, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  if (hasFlag(state.aiFlags, AI_FLAG_TRY_TO_FAINT)) {
    const faint = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
    unmodelled.push(...faint.unmodelled)
    if (faint.canFaint) return score
  }
  if (aiCanBurn(defender, unmodelled)) {
    score++
    if (hasMoveWithSplit(defender, 'PHYSICAL', deps)) {
      const canFaint = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
      unmodelled.push(...canFaint.unmodelled)
      if (canFaint.canFaint) score += 2
    }
    if (hasMoveEffect(attacker, 'EFFECT_HEX', deps) || hasMoveEffectOf(state, battlePartner(battlerAtk), 'EFFECT_HEX', deps)) score++
  }
  return score
}

/** `IncreaseFrostbiteScore`, battle_ai_util.c:2747-2758. */
function increaseFrostbiteScore(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  if (hasFlag(state.aiFlags, AI_FLAG_TRY_TO_FAINT)) {
    const faint = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
    unmodelled.push(...faint.unmodelled)
    if (faint.canFaint) return score
  }
  const frostbite = aiCanGiveFrostbite(state, attacker, defender, moveId, deps)
  unmodelled.push(...frostbite.unmodelled)
  if (frostbite.can) {
    score++
    if (hasMoveWithSplit(defender, 'SPECIAL', deps)) {
      const canFaint = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
      unmodelled.push(...canFaint.unmodelled)
      if (canFaint.canFaint) score += 2
    }
    if (hasMoveEffect(attacker, 'EFFECT_HEX', deps) || hasMoveEffectOf(state, battlePartner(battlerAtk), 'EFFECT_HEX', deps)) score++
  }
  return score
}

/** `ShouldFakeOut(battlerAtk, battlerDef, move)`, battle_ai_util.c:2129-2138.
 * `AI_GetHoldEffect` is the holdEffects[] read (see aiHoldEffect). */
function shouldFakeOut(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, deps: AiDamageDeps, unmodelled: string[]): boolean {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  if (aiHoldEffect(attacker, deps, unmodelled) === 'HOLD_EFFECT_CHOICE_BAND' && countUsablePartyMons(state, battlerAtk) === 0) return false
  if (
    attacker.volatiles.isFirstTurn &&
    shouldTryToFlinch(state, battlerAtk, battlerDef, moveId, deps, unmodelled) !== 0 &&
    !doesSubstituteBlockMove(attacker, defender, deps.moveData(moveId), unmodelled)
  ) {
    return true
  }
  return false
}

/** `CanKnockOffItem(battler, item)`, battle_ai_util.c:2000-2016. The
 * `!(gBattleTypeFlags & (EREADER|FRONTIER|LINK|RECORDED_LINK|SECRET_BASE
 * [|TRAINER])) && side == B_SIDE_PLAYER` early-out cannot fire: `#if defined
 * B_TRAINERS_KNOCK_OFF_ITEMS` is a DEFINED-ness test, and the macro is defined
 * (`TRUE`, include/constants/battle_config.h:103), which adds BATTLE_TYPE_TRAINER
 * to the mask; every fight this sim scores is a trainer battle (aiFlags.ts's own
 * note on `!(gBattleTypeFlags & BATTLE_TYPE_TRAINER)`), so the mask always
 * matches and the side check is skipped. */
function canKnockOffItem(battler: BattlerState, itemId: string | null, deps: AiDamageDeps): boolean {
  if (!itemId) return false
  if (isStickyHold(battler, deps.grounding.attackerHasMoldBreaker)) return false
  return canBattlerGetOrLoseItemApprox(battler, itemId, deps)
}

/** `GetUsedHeldItem(battler)`, battle_util.c:8637. See `BattlerState.usedHeldItem`. */
function getUsedHeldItem(battler: BattlerState, unmodelled: string[]): string | null {
  if (battler.usedHeldItem === undefined) {
    unmodelled.push('GetUsedHeldItem: gBattleStruct->usedHeldItems is never written by this sim (item consumption is unmodelled); read as ITEM_NONE')
  }
  return battler.usedHeldItem ?? null
}

/** `sRecycleEncouragedItems[]`, battle_ai_util.c:2530-2543 (`ITEM_FOCUS_SASH` is
 * behind `#ifdef ITEM_EXPANSION`, which is defined: global.h:216). */
const RECYCLE_ENCOURAGED_ITEMS: readonly string[] = [
  'ITEM_CHESTO_BERRY', 'ITEM_LUM_BERRY', 'ITEM_STARF_BERRY', 'ITEM_SITRUS_BERRY', 'ITEM_MICLE_BERRY',
  'ITEM_CUSTAP_BERRY', 'ITEM_MENTAL_HERB', 'ITEM_BERRY_JUICE', 'ITEM_FOCUS_SASH',
]
function isRecycleEncouragedItem(itemId: string | null): boolean {
  return !!itemId && RECYCLE_ENCOURAGED_ITEMS.includes(itemId)
}
/** `IsStatBoostingBerry(item)`, battle_ai_util.c:2546-2562 (`ITEM_MICLE_BERRY`
 * behind the defined `ITEM_EXPANSION`; the Lansat case is commented out). */
const STAT_BOOSTING_BERRIES: readonly string[] = ['ITEM_LIECHI_BERRY', 'ITEM_GANLON_BERRY', 'ITEM_SALAC_BERRY', 'ITEM_PETAYA_BERRY', 'ITEM_APICOT_BERRY', 'ITEM_STARF_BERRY', 'ITEM_MICLE_BERRY']
function isStatBoostingBerry(itemId: string | null): boolean {
  return !!itemId && STAT_BOOSTING_BERRIES.includes(itemId)
}
/** `ShouldRestoreHpBerry(battlerAtk, item)`, battle_ai_util.c:2564-2579. */
const RESTORE_HP_BERRIES: readonly string[] = ['ITEM_SITRUS_BERRY', 'ITEM_FIGY_BERRY', 'ITEM_WIKI_BERRY', 'ITEM_MAGO_BERRY', 'ITEM_AGUAV_BERRY', 'ITEM_IAPAPA_BERRY']
function shouldRestoreHpBerry(battler: BattlerState, itemId: string | null): boolean {
  if (itemId === 'ITEM_ORAN_BERRY') return battler.mon.maxHp <= 50
  return !!itemId && RESTORE_HP_BERRIES.includes(itemId)
}

/** Every ability whose abilityHooks.json marks `ripen` -- `HasRipenEffect(battler)`,
 * battle_util.c:5162-5165 (`RETURN_ABILITY_IF_FLAG(battler, FALSE, ripen)`, never
 * suppressed). Pinned by an oracle test. Extraction: same query as
 * CHLOROPLAST_ABILITIES with `bitfields.ripen` -- 3 entries. */
export const RIPEN_ABILITIES: readonly string[] = ['ABILITY_APPLE_PIE', 'ABILITY_RIPEN', 'ABILITY_SUGAR_RUSH']
function hasRipenEffect(battler: BattlerState): boolean {
  return RIPEN_ABILITIES.some((id) => selfAbility(battler, id))
}

/** `CountBattlerStatIncreases(battlerId, countEvasionAcc)`, battle_util.c:
 * 6736-6747 -- loops from index 0 (STAT_HP, always DEFAULT_STAT_STAGE, so it
 * contributes nothing) through NUM_BATTLE_STATS. */
function countBattlerStatIncreases(battler: BattlerState, countEvasionAcc: boolean): number {
  let count = 0
  for (let i = 0; i < NUM_BATTLE_STATS; i++) {
    if ((i === STAT_ACC || i === STAT_EVASION) && !countEvasionAcc) continue
    if (battler.mon.statStages[i] > DEFAULT_STAT_STAGE) count += battler.mon.statStages[i] - DEFAULT_STAT_STAGE
  }
  return count
}

/** The `EFFECT_DEFOG` body (:3379-3410), which `EFFECT_RAPID_SPIN` (:3375-3378)
 * enters by `FALLTHROUGH` after its own IncreaseStatUpScore. The C's inner
 * `break`s all leave the `switch (move)` and then the case -- early returns
 * here. The `isDoubleBattle` partner-hazard pre-empt (:3390-3394,
 * `IsHazardMoveEffect(partnerMove effect)`) is dead code on this singles-only
 * build (`AI_DATA->partnerMove` is MOVE_NONE, structural), so it is not
 * transcribed and `IsHazardMoveEffect` has no call site to port. */
function defogBody(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  const atkSide = state.sides[battlerAtk & 1].statuses
  const defSide = state.sides[battlerDef & 1].statuses

  if (hasFlag(atkSide, SIDE_STATUS_HAZARDS_ANY) && countUsablePartyMons(state, battlerAtk) !== 0) return score + 3

  switch (moveId) {
    case 'MOVE_DEFOG':
      if (hasFlag(defSide, SIDE_STATUS_SCREEN_ANY | SIDE_STATUS_SAFEGUARD | SIDE_STATUS_MIST)) {
        score += 3
      } else if (!hasFlag(defSide, SIDE_STATUS_SPIKES)) {
        // Don't blow away hazards if you set them up
        if (shouldLowerStat(defender, STAT_EVASION, deps.grounding.attackerHasMoldBreaker, unmodelled)) {
          if (defender.mon.statStages[STAT_EVASION] > 7 || hasMoveWithLowAccuracy(attacker, 90, true, deps, unmodelled)) score += 2
          else score++
        }
      }
      break
    case 'MOVE_RAPID_SPIN':
      if (hasFlag(attacker.statuses3, STATUS3_LEECHSEED) || hasFlag(attacker.mon.status2, STATUS2_WRAPPED)) score += 3
      break
  }
  return score
}

/** The shared body of `case EFFECT_TRICK` / `case EFFECT_BESTOW`,
 * battle_ai_main.c:3437-3512. Two nested `switch (holdEffects[...])`es over the
 * attacker's then (in the outer `default:`) the defender's item. Bestow differs
 * only in the outer `default:`'s `move != MOVE_BESTOW` gate. Every hold-effect
 * read is `AI_DATA->holdEffects[]` (see aiHoldEffect's quirk note). */
function applyTrickBestow(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps, unmodelled: string[]): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  const atkMoldBreaker = deps.grounding.attackerHasMoldBreaker
  const isDoubleBattle = isValidDoubleBattle(state, battlerAtk)

  switch (aiHoldEffect(attacker, deps, unmodelled)) {
    case 'HOLD_EFFECT_CHOICE_SCARF':
      score += 2 // assume its beneficial
      break
    case 'HOLD_EFFECT_CHOICE_BAND':
      if (!hasMoveWithSplit(defender, 'PHYSICAL', deps)) score += 2
      break
    case 'HOLD_EFFECT_CHOICE_SPECS':
      if (!hasMoveWithSplit(defender, 'SPECIAL', deps)) score += 2
      break
    case 'HOLD_EFFECT_TOXIC_ORB':
      if (!shouldPoisonSelf(state, battlerAtk, deps, unmodelled)) score += 2
      break
    case 'HOLD_EFFECT_FLAME_ORB':
      if (!shouldBurnSelf(state, battlerAtk, deps, unmodelled)) score += 2
      break
    case 'HOLD_EFFECT_FROST_ORB':
      if (!shouldFrostbiteSelf(state, battlerAtk, deps, unmodelled)) score += 2
      break
    case 'HOLD_EFFECT_BLACK_SLUDGE':
      if (!isBattlerOfType(defender, 'POISON') && !isMagicGuardProtected(state, defender)) score += 3
      break
    case 'HOLD_EFFECT_IRON_BALL':
      if (!hasMoveEffect(defender, 'EFFECT_FLING', deps) || !deps.turnOrder.isBattlerGrounded(battlerDef)) score += 2
      break
    case 'HOLD_EFFECT_LAGGING_TAIL':
    case 'HOLD_EFFECT_STICKY_BARB':
      score += 3
      break
    case 'HOLD_EFFECT_UTILITY_UMBRELLA':
      if (!selfAbility(attacker, 'ABILITY_SOLAR_POWER') && !selfAbility(attacker, 'ABILITY_DRY_SKIN') && weatherHasEffect(state, deps.grounding)) {
        if (defAbility(defender, 'ABILITY_SWIFT_SWIM', atkMoldBreaker) && isWeatherActive(state, WEATHER_RAIN_ANY, deps)) score += 3 // Slow 'em down
        if (defAbility(defender, 'ABILITY_CHLOROPHYLL', atkMoldBreaker) && isWeatherActive(state, WEATHER_SUN_ANY, deps)) score += 3 // Slow 'em down
        if (defAbility(defender, 'ABILITY_FLOWER_GIFT', atkMoldBreaker) && isWeatherActive(state, WEATHER_SUN_ANY, deps)) score += 3 // Slow 'em down
      }
      break
    case 'HOLD_EFFECT_EJECT_BUTTON': {
      // The C's `if (!IsRaidBattle() && IsDynamaxed(battlerDef) && ...` is a comment.
      const partner = battlePartner(battlerAtk)
      const partnerBattler = state.battlers[partner]
      if (hasDamagingMove(attacker, deps) || (isDoubleBattle && isBattlerAlive(state, partner) && !!partnerBattler && hasDamagingMove(partnerBattler, deps))) score += 2 // Force 'em out next turn
      break
    }
    default:
      if (moveId !== 'MOVE_BESTOW' && attacker.mon.itemId === null) {
        switch (aiHoldEffect(defender, deps, unmodelled)) {
          case 'HOLD_EFFECT_CHOICE_BAND':
            break
          case 'HOLD_EFFECT_TOXIC_ORB':
            if (shouldPoisonSelf(state, battlerAtk, deps, unmodelled)) score += 2
            break
          case 'HOLD_EFFECT_FLAME_ORB':
            if (shouldBurnSelf(state, battlerAtk, deps, unmodelled)) score += 2
            break
          case 'HOLD_EFFECT_FROST_ORB':
            if (shouldFrostbiteSelf(state, battlerAtk, deps, unmodelled)) score += 2
            break
          case 'HOLD_EFFECT_BLACK_SLUDGE':
            if (isBattlerOfType(attacker, 'POISON') || isMagicGuardProtected(state, attacker)) score += 3
            break
          case 'HOLD_EFFECT_IRON_BALL':
            if (hasMoveEffect(attacker, 'EFFECT_FLING', deps)) score += 2
            break
          case 'HOLD_EFFECT_LAGGING_TAIL':
          case 'HOLD_EFFECT_STICKY_BARB':
            break
          default:
            score++ // other hold effects generally universally good
            break
        }
      }
      break
  }
  return score
}

/**
 * AI_CheckViability, battle_ai_main.c:2515-3223 (this batch's slice).
 *
 * Pre-switch checks: :2516-2626 (always-hits, high crit, already dead, damage,
 * status-move preference, thaw, burn, frostbite, the two "player can KO the AI
 * next turn" forcing checks, the Choice-item/Gorilla-Tactics/Sage-Power
 * switch-forcing check, and the attacker-ability loop). Then the move-effect
 * switch from EFFECT_HIT through EFFECT_PERISH_SONG.
 */
export function aiCheckViability(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps): Result {
  const unmodelled: string[] = []
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  const move = deps.moveData(moveId)
  const moveEffect = move?.effect ?? null

  // :2527 -- Targeting partner check.
  if (isTargetingPartner(battlerAtk, battlerDef)) return { score, unmodelled }

  const effResult = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
  unmodelled.push(...effResult.unmodelled)
  const effectiveness = effResult.effectiveness
  // :2519 -- GetMovePriority approximated by the move's own declared priority
  // (see this module's header gap note).
  const atkPriority = move?.priority ?? 0
  const predictedMoveId = defender.lastMove // :2521 -- real data, see header.
  const atkHpPercent = getHealthPercentage(state, battlerAtk)
  const defHpPercent = getHealthPercentage(state, battlerDef)

  // :2530-2533 -- check always hits. RNG line :2532. `.accuracy` lives on
  // SimMoveData, not MoveData (see this module's header).
  const simMove = deps.dataContext.move(moveId)
  if (move?.split !== 'STATUS' && simMove?.accuracy === 0) {
    if (defender.mon.statStages[STAT_EVASION] >= 10 || attacker.mon.statStages[STAT_ACC] <= 2) score++
    if (aiRandLessThan(state, 100) && (defender.mon.statStages[STAT_EVASION] >= 8 || attacker.mon.statStages[STAT_ACC] <= 4)) score++
  }

  // :2536 -- check high crit. RNG line :2536.
  if (move?.crit === 'HIGH' && effectiveness >= 5 /* AI_EFFECTIVENESS_x2 */ && aiRandLessThan(state, 128)) score++

  // :2538-2546 -- check already dead. C: `CanTargetFaintAi(battlerAtk, battlerDef)`
  // (this specific call is written battlerAtk-first, unlike the other
  // CanTargetFaintAi call sites in this function -- see the two "player can
  // KO the AI" checks below, both battlerDef-first).
  if (!isBattlerIncapacitated(defender, deps)) {
    const canFaint = canTargetFaintAi(state, battlerAtk, battlerDef, deps)
    unmodelled.push(...canFaint.unmodelled)
    if (canFaint.canFaint && getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 1) {
      if (atkPriority > 0) score++
      else score--
    }
  }

  // :2549 -- check damage.
  if ((move?.power ?? 0) !== 0) {
    const dmgResult = getMoveDamageResult(state, battlerAtk, battlerDef, moveId, 0, deps)
    unmodelled.push(...dmgResult.unmodelled)
    if (dmgResult.result === MOVE_POWER_WEAK) score--
  }

  // :2552 -- check status move preference (AI_FLAG_PREFER_STATUS_MOVES).
  if (hasFlag(state.aiFlags, AI_FLAG_PREFER_STATUS_MOVES) && move?.split === 'STATUS' && effectiveness !== 0) score++

  // :2555-2556 -- check thawing moves.
  if (hasFlag(attacker.mon.status1, STATUS1_FREEZE | STATUS1_FROSTBITE) && hasMoveFlag(move, 'thawUser')) {
    // `gBattleTypeFlags & BATTLE_TYPE_DOUBLE` -- always false on this build
    // (see `isValidDoubleBattle`'s own doc), so this is dead code, not a gap.
    score += isValidDoubleBattle(state, battlerAtk) ? 20 : 10
  }

  // :2559-2567 -- check burn.
  if (hasFlag(attacker.mon.status1, STATUS1_BURN)) {
    const natCure = selfAbility(attacker, 'ABILITY_NATURAL_CURE') || selfAbility(attacker, 'ABILITY_NATURAL_RECOVERY') || selfAbility(attacker, 'ABILITY_SELF_REPAIR')
    if (natCure && hasFlag(state.aiFlags, AI_FLAG_SMART_SWITCHING) && onlyPhysicalMoves(attacker, deps)) {
      score = 90
    } else if (move?.split === 'PHYSICAL' && moveEffect !== 'EFFECT_FACADE' && !ignoresBurnAtkDrop(attacker)) {
      score -= 2
    }
  }

  // :2570-2578 -- checks frostbite.
  if (hasFlag(attacker.mon.status1, STATUS1_FROSTBITE)) {
    const natCure = selfAbility(attacker, 'ABILITY_NATURAL_CURE') || selfAbility(attacker, 'ABILITY_NATURAL_RECOVERY') || selfAbility(attacker, 'ABILITY_SELF_REPAIR')
    if (natCure) {
      if (hasFlag(state.aiFlags, AI_FLAG_SMART_SWITCHING) && onlySpecialMoves(attacker, deps)) score = 90
    } else if (move?.split === 'SPECIAL' && moveEffect !== 'EFFECT_FACADE' && !ignoresFrostbiteSpatkDrop(attacker)) {
      score -= 2
    }
  }

  // :2581 -- Player can defeat the AI next turn, force a damaging move. C:
  // `CanTargetFaintAi(battlerDef, battlerAtk)`.
  if (move?.split === 'STATUS') {
    const faintsAtk = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
    unmodelled.push(...faintsAtk.unmodelled)
    if (faintsAtk.canFaint) score -= 20
  }

  // :2584 -- Player can defeat the AI next turn and is faster, force priority.
  if ((move?.priority ?? 0) > 0) {
    const faintsAtk = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
    unmodelled.push(...faintsAtk.unmodelled)
    if (faintsAtk.canFaint && getWhoStrikesFirst(state, battlerDef, battlerAtk, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0) {
      score += 8
    }
  }

  // :2586-2592 -- Choice item/Gorilla Tactics/Sage Power switch-forcing check.
  const atkHoldEffect = getBattlerHoldEffect(attacker, deps)
  const hasChoiceLock = atkHoldEffect === 'HOLD_EFFECT_CHOICE_BAND' || atkHoldEffect === 'HOLD_EFFECT_CHOICE_SCARF' || atkHoldEffect === 'HOLD_EFFECT_CHOICE_SPECS'
  if (hasChoiceLock || selfAbility(attacker, 'ABILITY_GORILLA_TACTICS') || selfAbility(attacker, 'ABILITY_SAGE_POWER')) {
    if (countUsablePartyMons(state, battlerAtk) > 1) {
      const badMoveResult = aiCheckBadMove(state, battlerAtk, battlerDef, moveId, score, deps)
      unmodelled.push(...badMoveResult.unmodelled)
      if (badMoveResult.score <= 80) score -= 20
    }
  }

  // :2605-2624 -- attacker ability checks. `GetNumPossibleAbilitiesForBattler`/
  // `GetBattlerAbilityInSlot` collapse to a scan over the attacker's own
  // ability + innate slots, same simplification aiCheckBadMove.ts's own
  // defender-ability loop (:615-671) already uses.
  const atkSlots = [attacker.mon.abilities.ability, ...attacker.mon.abilities.innates].filter((x): x is string => !!x)
  const STAT_UP_ABILITIES = new Set(['ABILITY_MOXIE', 'ABILITY_BEAST_BOOST', 'ABILITY_SOUL_HEART', 'ABILITY_CHILLING_NEIGH', 'ABILITY_GRIM_NEIGH', 'ABILITY_AS_ONE_ICE_RIDER', 'ABILITY_AS_ONE_SHADOW_RIDER'])
  for (const abilityToCheck of atkSlots) {
    if (STAT_UP_ABILITIES.has(abilityToCheck)) {
      if (getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0) {
        const faintResult = canIndexMoveFaintTarget(state, battlerAtk, battlerDef, moveId, 0, deps)
        unmodelled.push(...faintResult.unmodelled)
        if (faintResult.faints) score += 8
      }
    }
  }

  // :2627 -- the move-effect switch.
  score = applyMoveEffectSwitch(state, battlerAtk, battlerDef, moveId, moveEffect, score, effectiveness, atkHpPercent, defHpPercent, predictedMoveId, deps, unmodelled)

  return { score, unmodelled }
}

/** `HasOnlyMovesWithSplit(battler, SPLIT_SPECIAL, TRUE)`/`SPLIT_PHYSICAL` --
 * "every damaging move in the moveset has this split" (status moves don't
 * count against it). Not previously ported anywhere in this codebase. */
function onlyPhysicalMoves(battler: BattlerState, deps: AiDamageDeps): boolean {
  return battler.mon.moves.every((m) => {
    if (!m) return true
    const md = deps.moveData(m)
    if (!md || md.split === 'STATUS') return true
    return md.split === 'PHYSICAL'
  })
}
function onlySpecialMoves(battler: BattlerState, deps: AiDamageDeps): boolean {
  return battler.mon.moves.every((m) => {
    if (!m) return true
    const md = deps.moveData(m)
    if (!md || md.split === 'STATUS') return true
    return md.split === 'SPECIAL'
  })
}

/** `IgnoresBurnAtkDrop(battler)`, battle_util.c:7095-7098 --
 * `RETURN_ABILITY_IF_FLAG(battler, FALSE, negatesBurnAtkDrop)`. `FALSE` is
 * checkMoldBreaker, so this is a plain self-ability read (never suppressed).
 *
 * Extraction: same query shape as this module's UNAWARE_ABILITIES with
 * `bitfields.negatesBurnAtkDrop` -- 7 entries. */
const NEGATES_BURN_ATK_DROP_ABILITIES: readonly string[] = ['ABILITY_DROIDEKA', 'ABILITY_FLARE_BOOST', 'ABILITY_GUTS', 'ABILITY_HEATPROOF', 'ABILITY_IRON_GIANT', 'ABILITY_RAGE_POINT', 'ABILITY_THERMAL_ENTROPY']
function ignoresBurnAtkDrop(battler: BattlerState): boolean {
  return NEGATES_BURN_ATK_DROP_ABILITIES.some((id) => selfAbility(battler, id))
}
/** `IgnoresFrostbiteSpatkDrop(battler)`, battle_util.c:7100-7103 -- same
 * shape, `bitfields.negatesFrzSpatkDrop` -- 2 entries. */
const NEGATES_FRZ_SPATK_DROP_ABILITIES: readonly string[] = ['ABILITY_DETERMINATION', 'ABILITY_RAGE_POINT']
function ignoresFrostbiteSpatkDrop(battler: BattlerState): boolean {
  return NEGATES_FRZ_SPATK_DROP_ABILITIES.some((id) => selfAbility(battler, id))
}

/**
 * Every EFFECT_* case label AI_CheckViability's switch declares in battle_ai_main.c
 * :3224-3606 (EFFECT_SANDSTORM through EFFECT_PSYCHO_SHIFT, whose `break` is at
 * :3606) -- the labels this batch (part 2a) ports. Mechanically extracted with both
 * `//` and `/* * /` comments stripped (the four labels that exist only inside a
 * commented-out TODO block at the end of the switch -- EFFECT_EXTREME_EVOBOOST,
 * EFFECT_CLANGOROUS_SOUL, EFFECT_NO_RETREAT, EFFECT_SKY_DROP -- are outside this
 * range anyway). 47 entries. Used only by this module's own oracle test.
 */
export const PART2A_EFFECTS: readonly string[] = [
  'EFFECT_ATTACK_UP_HIT', 'EFFECT_ATTRACT', 'EFFECT_BELLY_DRUM', 'EFFECT_BESTOW', 'EFFECT_BRICK_BREAK',
  'EFFECT_CHARGE', 'EFFECT_DEFENSE_CURL', 'EFFECT_DEFOG', 'EFFECT_EERIE_FOG', 'EFFECT_ENTRAINMENT',
  'EFFECT_FAKE_OUT', 'EFFECT_FELL_STINGER', 'EFFECT_FLATTER', 'EFFECT_FOLLOW_ME', 'EFFECT_GASTRO_ACID',
  'EFFECT_HAIL', 'EFFECT_IMPRISON', 'EFFECT_INGRAIN', 'EFFECT_KNOCK_OFF', 'EFFECT_MAGIC_COAT',
  'EFFECT_NATURE_POWER', 'EFFECT_OVERHEAT', 'EFFECT_PSYCHO_SHIFT', 'EFFECT_PSYCH_UP', 'EFFECT_PURSUIT',
  'EFFECT_RAIN_DANCE', 'EFFECT_RAPID_SPIN', 'EFFECT_RECYCLE', 'EFFECT_REFRESH', 'EFFECT_ROLE_PLAY',
  'EFFECT_ROLLOUT', 'EFFECT_SAFEGUARD', 'EFFECT_SANDSTORM', 'EFFECT_SEMI_INVULNERABLE', 'EFFECT_SIMPLE_BEAM',
  'EFFECT_SKILL_SWAP', 'EFFECT_SPECTRAL_THIEF', 'EFFECT_STOCKPILE', 'EFFECT_STORED_POWER', 'EFFECT_SUNNY_DAY',
  'EFFECT_SUPERPOWER', 'EFFECT_SWAGGER', 'EFFECT_TAUNT', 'EFFECT_TORMENT', 'EFFECT_TRICK',
  'EFFECT_WILL_O_WISP', 'EFFECT_WORRY_SEED',
]

/**
 * Every EFFECT_* case label declared in :3607-3984 (EFFECT_GRUDGE to the switch's
 * closing brace) -- part 2b's scope, still gapped by the `default` branch of
 * applyMoveEffectSwitch. Same mechanical, comment-stripped extraction (so the four
 * commented-out labels above are excluded). 70 entries; 47 + 70 == the 117 labels
 * the old single PART2_EFFECTS list held.
 */
export const PART2B_EFFECTS: readonly string[] = [
  'EFFECT_BUG_BITE', 'EFFECT_BULK_UP', 'EFFECT_CALM_MIND', 'EFFECT_CAMOUFLAGE', 'EFFECT_CONVERSION',
  'EFFECT_CONVERSION_2', 'EFFECT_COSMIC_POWER', 'EFFECT_COUNTER', 'EFFECT_DRAGON_DANCE', 'EFFECT_ELECTRIC_TERRAIN',
  'EFFECT_ELECTRIFY', 'EFFECT_EMBARGO', 'EFFECT_ENDEAVOR', 'EFFECT_FACADE', 'EFFECT_FAIRY_LOCK',
  'EFFECT_FEINT', 'EFFECT_FLAIL', 'EFFECT_FLAME_BURST', 'EFFECT_FLING', 'EFFECT_FOCUS_PUNCH',
  'EFFECT_GEAR_UP', 'EFFECT_GEOMANCY', 'EFFECT_GRASSY_TERRAIN', 'EFFECT_GRAVITY', 'EFFECT_GRUDGE',
  'EFFECT_GUARD_SPLIT', 'EFFECT_GUARD_SWAP', 'EFFECT_HEAL_BLOCK', 'EFFECT_HEART_SWAP', 'EFFECT_INCINERATE',
  'EFFECT_ION_DELUGE', 'EFFECT_LUCKY_CHANT', 'EFFECT_MAGIC_ROOM', 'EFFECT_MAGNET_RISE', 'EFFECT_METAL_BURST',
  'EFFECT_MIRROR_COAT', 'EFFECT_MISTY_TERRAIN', 'EFFECT_MUD_SPORT', 'EFFECT_PLEDGE', 'EFFECT_POWDER',
  'EFFECT_POWER_SPLIT', 'EFFECT_POWER_SWAP', 'EFFECT_POWER_TRICK', 'EFFECT_PSYCHIC_TERRAIN', 'EFFECT_QUASH',
  'EFFECT_QUIVER_DANCE', 'EFFECT_RECHARGE', 'EFFECT_REVENGE', 'EFFECT_SHELL_SMASH', 'EFFECT_SHIFT_GEAR',
  'EFFECT_SHORE_UP', 'EFFECT_SKULL_BASH', 'EFFECT_SMACK_DOWN', 'EFFECT_SMELLINGSALT', 'EFFECT_SNATCH',
  'EFFECT_SOAK', 'EFFECT_SOLARBEAM', 'EFFECT_SPEED_SWAP', 'EFFECT_TAILWIND', 'EFFECT_TELEKINESIS',
  'EFFECT_THIRD_TYPE', 'EFFECT_THROAT_CHOP', 'EFFECT_TICKLE', 'EFFECT_TOPSY_TURVY', 'EFFECT_TOXIC_THREAD',
  'EFFECT_TRICK_ROOM', 'EFFECT_TWO_TURNS_ATTACK', 'EFFECT_WAKE_UP_SLAP', 'EFFECT_WATER_SPORT', 'EFFECT_WONDER_ROOM',
]

/**
 * The move-effect switch itself, battle_ai_main.c:2627-3223 -- from
 * EFFECT_HIT through EFFECT_PERISH_SONG (the last label before
 * EFFECT_SANDSTORM at :3224, where part 2 begins). One `case` block per C
 * case label, in the C's own order.
 */
function applyMoveEffectSwitch(
  state: BattleState,
  battlerAtk: number,
  battlerDef: number,
  moveId: string,
  moveEffect: string | null,
  score: number,
  effectiveness: number,
  atkHpPercent: number,
  defHpPercent: number,
  predictedMoveId: string | null,
  deps: AiDamageDeps,
  unmodelled: string[],
): number {
  const attacker = state.battlers[battlerAtk] as BattlerState
  const defender = state.battlers[battlerDef] as BattlerState
  const atkMoldBreaker = deps.grounding.attackerHasMoldBreaker

  switch (moveEffect) {
    case 'EFFECT_HIT':
    case 'EFFECT_POISON_HIT':
    case 'EFFECT_BURN_HIT':
    case 'EFFECT_PARALYZE_HIT':
      break

    case 'EFFECT_SLEEP':
    case 'EFFECT_YAWN':
      score = increaseSleepScore(state, battlerAtk, battlerDef, score, deps, unmodelled)
      break

    case 'EFFECT_ABSORB': {
      const holdEffect = getBattlerHoldEffect(attacker, deps)
      if (holdEffect === 'HOLD_EFFECT_BIG_ROOT') score++
      // RNG line :2640.
      if (effectiveness <= 3 /* AI_EFFECTIVENESS_x0_5 */ && aiRandLessThan(state, 50)) score -= 3
      break
    }

    case 'EFFECT_EXPLOSION':
    case 'EFFECT_MEMENTO':
      if (hasFlag(state.aiFlags, AI_FLAG_WILL_SUICIDE) && defender.mon.statStages[STAT_EVASION] < 7) {
        // RNG line :2645.
        if (atkHpPercent < 50 && aiRandLessThan(state, 128)) score++
      }
      break

    case 'EFFECT_MIRROR_MOVE': {
      // C: `return AI_CheckViability(battlerAtk, battlerDef, gLastMoves[battlerDef],
      // score);` -- re-enters the TOP-LEVEL function (review finding, CRITICAL), not
      // just the effect switch: the mirrored move gets its OWN fresh pre-switch
      // ladder (always-hits/high-crit RNG, already-dead, damage-weak, status-move
      // preference, thaw/burn/frostbite, both KO-forcing checks, the Choice-lock
      // check, the attacker-ability loop) and its own `effectiveness`/HP context,
      // not the ORIGINAL Mirror Move's. An earlier revision of this file recursed
      // into `applyMoveEffectSwitch` directly, reusing Mirror Move's own (always
      // AI_EFFECTIVENESS_x1, since it's STATUS-split) effectiveness and skipping
      // every pre-switch RNG draw for the mirrored move -- a real RNG-order and
      // scoring bug, not a stylistic difference.
      //
      // Guard: if the mirrored move's OWN effect is again EFFECT_MIRROR_MOVE or
      // EFFECT_MIMIC, recursing would look up the SAME `gLastMoves[battlerDef]`
      // and hit the identical branch again with unchanged inputs -- a genuine
      // infinite loop in the C itself (a real bug there too, not something this
      // port invents), so it is the one case worth refusing rather than
      // reproducing as an unbounded JS call stack.
      if (predictedMoveId !== null) {
        const targetEffect = deps.moveData(predictedMoveId)?.effect ?? null
        if (targetEffect === 'EFFECT_MIRROR_MOVE' || targetEffect === 'EFFECT_MIMIC') {
          unmodelled.push(`EFFECT_MIRROR_MOVE: gLastMoves[battlerDef] (${predictedMoveId}) is itself ${targetEffect}, which would recurse into the same lookup forever (a real infinite loop in the C too); refused instead of reproducing the hang`)
          break
        }
        const recursed = aiCheckViability(state, battlerAtk, battlerDef, predictedMoveId, score, deps)
        unmodelled.push(...recursed.unmodelled)
        return recursed.score
      }
      break
    }

    case 'EFFECT_ATTACK_UP':
    case 'EFFECT_ATTACK_UP_2':
      if (movesWithSplitUnusable(state, battlerAtk, battlerDef, 'PHYSICAL', deps, unmodelled)) {
        score -= 8
        break
      } else if (attacker.mon.statStages[STAT_ATK] < 9) {
        // RNG line :2658.
        if (atkHpPercent > 90 && aiRandLessThan(state, 128)) {
          score += 2
          break
        }
      }
      // RNG line :2664.
      if (!aiRandLessThan(state, 100)) score--
      break

    case 'EFFECT_DEFENSE_UP':
    case 'EFFECT_DEFENSE_UP_2':
    case 'EFFECT_DEFENSE_UP_3':
      if (!hasMoveWithSplit(defender, 'PHYSICAL', deps)) score -= 2
      // RNG lines :2672, :2674.
      if (atkHpPercent > 90 && aiRandLessThan(state, 128)) score += 2
      else if (atkHpPercent > 70 && aiRandLessThan(state, 200)) break
      else if (atkHpPercent < 40) score -= 2
      break

    case 'EFFECT_SPEED_UP':
    case 'EFFECT_SPEED_UP_2':
      // `IsAiFaster(AI_CHECK_SLOWER)` -- "is the TARGET faster" -- is exactly
      // `!isAiFaster(AI_CHECK_FASTER)` (see this module's header equivalence
      // note). The C's true branch (target faster) is the bonus-check branch;
      // its else (AI faster or tied) is the flat -3.
      if (!isAiFaster(state, battlerAtk, battlerDef, moveId, deps)) {
        if (!aiRandLessThan(state, 70) && compareStatLessThan(attacker, STAT_SPEED, MAX_STAT_STAGE)) {
          // RNG line :2682.
          score += 3
        }
      } else {
        score -= 3
      }
      break

    case 'EFFECT_SPECIAL_ATTACK_UP':
    case 'EFFECT_SPECIAL_ATTACK_UP_2':
    case 'EFFECT_SPECIAL_ATTACK_UP_3':
      if (movesWithSplitUnusable(state, battlerAtk, battlerDef, 'SPECIAL', deps, unmodelled)) {
        score -= 8
        break
      } else if (attacker.mon.statStages[STAT_SPATK] < 9) {
        // RNG line :2694.
        if (atkHpPercent > 90 && aiRandLessThan(state, 128)) {
          score += 2
          break
        }
      }
      // RNG line :2700.
      if (!aiRandLessThan(state, 100)) score--
      break

    case 'EFFECT_SPECIAL_DEFENSE_UP':
    case 'EFFECT_SPECIAL_DEFENSE_UP_2':
      if (!hasMoveWithSplit(defender, 'SPECIAL', deps)) score -= 2
      // RNG lines :2707, :2709.
      if (atkHpPercent > 90 && aiRandLessThan(state, 128)) score += 2
      else if (getHealthPercentage(state, battlerAtk) > 70 && aiRandLessThan(state, 200)) break
      else if (getHealthPercentage(state, battlerAtk) < 40) score -= 2
      break

    case 'EFFECT_ACCURACY_UP':
    case 'EFFECT_ACCURACY_UP_2':
      // RNG line :2716.
      if (attacker.mon.statStages[STAT_ACC] >= 9 && !aiRandLessThan(state, 50)) score -= 2
      else if (atkHpPercent <= 70) score -= 2
      else score++
      break

    case 'EFFECT_EVASION_UP':
    case 'EFFECT_EVASION_UP_2': {
      // RNG lines :2725-2730, :2735.
      if (atkHpPercent > 90 && !aiRandLessThan(state, 100)) score += 3
      if (attacker.mon.statStages[STAT_EVASION] > 9 && aiRandLessThan(state, 128)) score--
      if (hasFlag(defender.mon.status1, STATUS1_POISON_ANY) && atkHpPercent >= 50 && !aiRandLessThan(state, 80)) score += 3
      if (hasFlag(defender.statuses3, STATUS3_LEECHSEED) && !aiRandLessThan(state, 70)) score += 3
      if (hasFlag(attacker.statuses3, STATUS3_ROOTED) && aiRandLessThan(state, 128)) score += 2
      if (hasFlag(defender.mon.status2, STATUS2_CURSED) && !aiRandLessThan(state, 70)) score += 3
      if (atkHpPercent < 70 || attacker.mon.statStages[STAT_EVASION] === DEFAULT_STAT_STAGE) {
        break
      } else if (atkHpPercent < 40 || defHpPercent < 40) {
        score -= 2
      } else if (!aiRandLessThan(state, 70)) {
        score -= 2
      }
      break
    }

    case 'EFFECT_ATTACK_DOWN':
    case 'EFFECT_ATTACK_DOWN_2':
      if (!shouldLowerStat(defender, STAT_ATK, atkMoldBreaker, unmodelled)) score -= 2
      if (defender.mon.statStages[STAT_ATK] < DEFAULT_STAT_STAGE) score--
      else if (atkHpPercent <= 90) score--
      // RNG line :2746.
      if (defender.mon.statStages[STAT_ATK] > 3 && !aiRandLessThan(state, 50)) score -= 2
      else if (defHpPercent < 70) score -= 2
      break

    case 'EFFECT_DEFENSE_DOWN':
    case 'EFFECT_DEFENSE_DOWN_2':
      if (!shouldLowerStat(defender, STAT_DEF, atkMoldBreaker, unmodelled)) score -= 2
      // RNG line :2754 (two draws -- the C's `||` short-circuits the second
      // AI_RandLessThan(50) only when the first is already true).
      if ((atkHpPercent < 70 && !aiRandLessThan(state, 50)) || (defender.mon.statStages[STAT_DEF] <= 3 && !aiRandLessThan(state, 50))) score -= 2
      if (defHpPercent <= 70) score -= 2
      break

    case 'EFFECT_SPEED_DOWN':
    case 'EFFECT_SPEED_DOWN_2':
      if (isAiFaster(state, battlerAtk, battlerDef, moveId, deps)) {
        score -= 3
      } else if (!aiRandLessThan(state, 70)) {
        // RNG line :2761.
        score += 2
      }
      break

    case 'EFFECT_SPECIAL_ATTACK_DOWN':
    case 'EFFECT_SPECIAL_ATTACK_DOWN_2':
      if (!shouldLowerStat(defender, STAT_SPATK, atkMoldBreaker, unmodelled)) score -= 2
      if (defender.mon.statStages[STAT_SPATK] < DEFAULT_STAT_STAGE) score--
      else if (atkHpPercent <= 90) score--
      // RNG line :2771.
      if (defender.mon.statStages[STAT_SPATK] > 3 && !aiRandLessThan(state, 50)) score -= 2
      else if (defHpPercent < 70) score -= 2
      break

    case 'EFFECT_SPECIAL_DEFENSE_DOWN':
    case 'EFFECT_SPECIAL_DEFENSE_DOWN_2':
      if (!shouldLowerStat(defender, STAT_SPDEF, atkMoldBreaker, unmodelled)) score -= 2
      // RNG line :2779.
      if ((atkHpPercent < 70 && !aiRandLessThan(state, 50)) || (defender.mon.statStages[STAT_SPDEF] <= 3 && !aiRandLessThan(state, 50))) score -= 2
      if (defHpPercent <= 70) score -= 2
      break

    case 'EFFECT_ACCURACY_DOWN':
    case 'EFFECT_ACCURACY_DOWN_2': {
      if (shouldLowerStat(defender, STAT_ACC, atkMoldBreaker, unmodelled)) score -= 2
      // RNG lines :2785-2789.
      if ((atkHpPercent < 70 || defHpPercent < 70) && aiRandLessThan(state, 100)) score--
      if (defender.mon.statStages[STAT_ACC] <= 4 && !aiRandLessThan(state, 80)) score -= 2
      if (hasFlag(defender.mon.status1, STATUS1_POISON_ANY) && !aiRandLessThan(state, 70)) score += 2
      if (hasFlag(defender.statuses3, STATUS3_LEECHSEED) && !aiRandLessThan(state, 70)) score += 2
      if (hasFlag(defender.statuses3, STATUS3_ROOTED) && aiRandLessThan(state, 128)) score++
      if (hasFlag(defender.mon.status2, STATUS2_CURSED) && !aiRandLessThan(state, 70)) score += 2
      if (atkHpPercent > 70 || defender.mon.statStages[STAT_ACC] < DEFAULT_STAT_STAGE) {
        break
      } else if (atkHpPercent < 40 || defHpPercent < 40 || !aiRandLessThan(state, 70)) {
        // RNG line :2793 (drawn only when neither hp check is already true --
        // `||` short-circuit, same as the C).
        score -= 2
      }
      break
    }

    case 'EFFECT_EVASION_DOWN':
    case 'EFFECT_EVASION_DOWN_2':
      if (!shouldLowerStat(defender, STAT_EVASION, atkMoldBreaker, unmodelled)) score -= 2
      // RNG line :2799.
      if ((atkHpPercent < 70 || defender.mon.statStages[STAT_EVASION] <= 3) && !aiRandLessThan(state, 50)) score -= 2
      if (defHpPercent <= 70) score -= 2
      if (attacker.mon.statStages[STAT_ACC] < DEFAULT_STAT_STAGE) score++
      if (defender.mon.statStages[STAT_EVASION] < 7 || selfAbility(attacker, 'ABILITY_NO_GUARD')) score -= 2
      break

    case 'EFFECT_BIDE':
      if (atkHpPercent < 90) score -= 2
      break

    case 'EFFECT_DREAM_EATER':
      // FALLTHROUGH to EFFECT_ACUPRESSURE's own `break` in the C -- that case
      // does nothing, so this is written as a plain early exit instead of a
      // syntactic fallthrough (tsconfig's `noFallthroughCasesInSwitch`
      // forbids the latter; the observable behavior is identical).
      if (hasFlag(defender.mon.status1, STATUS1_SLEEP)) score++
      break

    case 'EFFECT_ACUPRESSURE':
      break

    case 'EFFECT_ATTACK_ACCURACY_UP':
      score = increaseStatUpScore(state, battlerAtk, battlerDef, STAT_ATK, moveId, score, deps, unmodelled)
      score = increaseStatUpScore(state, battlerAtk, battlerDef, STAT_ACC, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_GROWTH': {
      const holdEffect = getBattlerHoldEffect(attacker, deps)
      const hasChloroplast = CHLOROPLAST_ABILITIES.some((id) => selfAbility(attacker, id))
      if ((weatherHasEffect(state, deps.grounding) && hasFlag(state.field.weather, WEATHER_SUN_ANY) && holdEffect !== 'HOLD_EFFECT_UTILITY_UMBRELLA') || hasChloroplast) {
        score++
      }
      // FALLTHROUGH to EFFECT_ATTACK_SPATK_UP's own body in the C -- written
      // as an explicit shared-helper call instead of a syntactic fallthrough
      // (tsconfig's `noFallthroughCasesInSwitch` forbids the latter).
      score = applyAttackSpatkUp(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break
    }

    case 'EFFECT_ATTACK_SPATK_UP':
      score = applyAttackSpatkUp(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_HAZE':
      // `AnyStatIsRaised(BATTLE_PARTNER(battlerAtk))` -- the ATTACKER'S OWN
      // PARTNER (not the attacker itself, and not the defender); the partner
      // slot does not exist in this sim's singles-only battler state (only
      // battlerAtk/battlerDef are ever populated), so this reads as always
      // false here, matching `partnerHasSameMoveEffectWithoutTarget`'s own
      // always-false doubles-only treatment for the second half of the `||`.
      if (partnerHasSameMoveEffectWithoutTarget(state, battlerAtk)) score -= 3
      break
    // NOTE: the C's own `case EFFECT_HAZE` block ends with a stray
    // `FALLTHROUGH` INSIDE its own braces before `break` (:335), which the
    // compiler treats as dead/unreachable (the preceding `break` at the top
    // of EFFECT_HAZE's own block already exits the switch on every path) --
    // reproduced faithfully by NOT falling through to EFFECT_ROAR here either.

    case 'EFFECT_ROAR':
    case 'EFFECT_CLEAR_SMOG':
      score += Math.min(countPositiveStatStages(defender), 4)
      break

    case 'EFFECT_MULTI_HIT':
    case 'EFFECT_DOUBLE_HIT':
    case 'EFFECT_TRIPLE_KICK': {
      const holdEffect = getBattlerHoldEffect(attacker, deps)
      const defHoldEffect = getBattlerHoldEffect(defender, deps)
      if (aiMoveMakesContact(attacker, holdEffect, deps.moveData(moveId)) && !isMagicGuardProtected(state, attacker) && defHoldEffect === 'HOLD_EFFECT_ROCKY_HELMET') {
        score -= 2
      }
      break
    }

    case 'EFFECT_FLINCH_HIT':
      score += shouldTryToFlinch(state, battlerAtk, battlerDef, moveId, deps, unmodelled)
      break

    case 'EFFECT_SWALLOW': {
      const stockpile = attacker.volatiles.stockpileCounter
      if (stockpile === 0) {
        break
      } else {
        const healPercent = stockpile === 1 ? 25 : stockpile === 2 ? 50 : stockpile === 3 ? 100 : 0
        const recover = shouldRecover(state, battlerAtk, battlerDef, moveId, healPercent, deps)
        unmodelled.push(...recover.unmodelled)
        if (recover.should) score += 2
      }
      break
    }

    case 'EFFECT_RESTORE_HP':
    case 'EFFECT_SOFTBOILED':
    case 'EFFECT_ROOST':
    case 'EFFECT_MORNING_SUN':
    case 'EFFECT_SYNTHESIS':
    case 'EFFECT_MOONLIGHT': {
      const recover = shouldRecover(state, battlerAtk, battlerDef, moveId, 50, deps)
      unmodelled.push(...recover.unmodelled)
      if (recover.should) score += 3
      if (getBattlerHoldEffect(attacker, deps) === 'HOLD_EFFECT_BIG_ROOT') score++
      break
    }

    case 'EFFECT_TOXIC':
    case 'EFFECT_POISON':
      score = increasePoisonScore(state, battlerAtk, battlerDef, score, deps, unmodelled)
      break

    case 'EFFECT_LIGHT_SCREEN':
    case 'EFFECT_REFLECT':
    case 'EFFECT_AURORA_VEIL':
      if (shouldSetScreen(state, battlerAtk, battlerDef, moveEffect, deps)) {
        score += 5
        if (getBattlerHoldEffect(attacker, deps) === 'HOLD_EFFECT_LIGHT_CLAY') score += 2
        if (hasFlag(state.aiFlags, AI_FLAG_SCREENER)) score += 2
      }
      break

    case 'EFFECT_REST': {
      unmodelled.push('EFFECT_REST: AI_CanSleep/CanSleep(battlerAtk) reuses the onCanStatusType ability-hook gap; treated as sleepable when otherwise unstatused')
      const canSleepSelf = canSleep(state, attacker, deps)
      unmodelled.push(...canSleepSelf.unmodelled)
      if (!canSleepSelf.canSleep) {
        break
      }
      const recover = shouldRecover(state, battlerAtk, battlerDef, moveId, 100, deps)
      unmodelled.push(...recover.unmodelled)
      if (recover.should) {
        const holdEffect = getBattlerHoldEffect(attacker, deps)
        // `gWishFutureKnock.weatherDuration != 1` -- rain ending NEXT turn
        // shouldn't count as a reliable Hydration cure; this sim tracks the
        // same countdown at `state.field.weatherDuration` (fieldEndTurn.ts),
        // so this is a real read, not a gap (an earlier revision of this file
        // dropped the term without naming it).
        const hasWakeupHelp =
          holdEffect === 'HOLD_EFFECT_CURE_SLP' ||
          holdEffect === 'HOLD_EFFECT_CURE_STATUS' ||
          hasMoveEffect(attacker, 'EFFECT_SLEEP_TALK', deps) ||
          hasMoveEffect(attacker, 'EFFECT_SNORE', deps) ||
          selfAbility(attacker, 'ABILITY_SHED_SKIN') ||
          selfAbility(attacker, 'ABILITY_EARLY_BIRD') ||
          (hasFlag(state.field.weather, WEATHER_RAIN_ANY) && state.field.weatherDuration !== 1 && selfAbility(attacker, 'ABILITY_HYDRATION') && holdEffect !== 'HOLD_EFFECT_UTILITY_UMBRELLA')
        score += hasWakeupHelp ? 2 : 1
      }
      break
    }

    case 'EFFECT_OHKO':
      if (hasFlag(attacker.statuses3, STATUS3_ALWAYS_HITS)) score += 5
      break

    case 'EFFECT_TRAP':
    case 'EFFECT_WHIRLPOOL':
    case 'EFFECT_MEAN_LOOK':
      // `B_GHOSTS_ESCAPE >= GEN_6 && IS_BATTLER_OF_TYPE(battlerDef, TYPE_GHOST)` --
      // `B_GHOSTS_ESCAPE` is `GEN_7` on this build (battle_config.h:45), so this
      // term is compile-time live, not dead code.
      if (hasMoveEffect(defender, 'EFFECT_RAPID_SPIN', deps) || isBattlerOfType(defender, 'GHOST') || hasFlag(defender.mon.status2, STATUS2_WRAPPED)) {
        break
      } else if (shouldTrap(state, battlerAtk, battlerDef, deps, unmodelled)) {
        score += 5
      }
      break

    case 'EFFECT_MIST':
      if (hasFlag(state.aiFlags, AI_FLAG_SCREENER)) score += 2
      break

    case 'EFFECT_FOCUS_ENERGY':
    case 'EFFECT_LASER_FOCUS': {
      const holdEffect = getBattlerHoldEffect(attacker, deps)
      if (selfAbility(attacker, 'ABILITY_SUPER_LUCK') || selfAbility(attacker, 'ABILITY_SNIPER') || holdEffect === 'HOLD_EFFECT_SCOPE_LENS' || testMoveFlagsInMoveset(attacker, 'highCrit', deps)) {
        score += 2
      }
      break
    }

    case 'EFFECT_CONFUSE_HIT':
      if (selfAbility(attacker, 'ABILITY_SERENE_GRACE')) score++
      score = increaseConfusionScore(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_CONFUSE':
      score = increaseConfusionScore(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_PARALYZE':
      score = increaseParalyzeScore(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_ATTACK_DOWN_HIT':
    case 'EFFECT_DEFENSE_DOWN_HIT':
    case 'EFFECT_SPECIAL_ATTACK_DOWN_HIT':
    case 'EFFECT_SPECIAL_DEFENSE_DOWN_HIT':
    case 'EFFECT_ACCURACY_DOWN_HIT':
    case 'EFFECT_EVASION_DOWN_HIT':
      if (selfAbility(attacker, 'ABILITY_SERENE_GRACE') && !selfAbility(defender, 'ABILITY_CONTRARY')) score += 2
      break

    case 'EFFECT_SPEED_DOWN_HIT':
      if (isAiFaster(state, battlerAtk, battlerDef, moveId, deps)) {
        score -= 2
      } else if (!aiRandLessThan(state, 70)) {
        score++
      }
      if (selfAbility(attacker, 'ABILITY_SERENE_GRACE') && !selfAbility(defender, 'ABILITY_CONTRARY')) score++
      // NOTE: C :458-464 -- a SECOND `if (ShouldLowerStat(...))` block sits
      // AFTER this case's own `break;` (:457), making it unreachable dead
      // code (a quirk, reproduced by simply never evaluating it here).
      break

    case 'EFFECT_SUBSTITUTE': {
      if (hasFlag(attacker.mon.status2, STATUS2_SUBSTITUTE)) score -= 10
      if (hasFlag(defender.statuses3, STATUS3_PERISH_SONG)) score += 3
      if (hasFlag(defender.mon.status1, STATUS1_BURN | STATUS1_POISON_ANY | STATUS1_FROSTBITE)) score++
      if (
        hasMoveEffect(defender, 'EFFECT_SLEEP', deps) ||
        hasMoveEffect(defender, 'EFFECT_TOXIC', deps) ||
        hasMoveEffect(defender, 'EFFECT_POISON', deps) ||
        hasMoveEffect(defender, 'EFFECT_PARALYZE', deps) ||
        hasMoveEffect(defender, 'EFFECT_WILL_O_WISP', deps) ||
        hasMoveEffect(defender, 'EFFECT_CONFUSE', deps) ||
        hasMoveEffect(defender, 'EFFECT_LEECH_SEED', deps)
      ) {
        score += 2
      }
      // C: `(!(status2 & (WRAPPED|ESCAPE_PREVENTION)) || !(gStatuses4[battlerDef] &
      // STATUS4_COMMANDED)) && ...` -- the `|| !commanded` term was dropped in an
      // earlier revision of this file, which changes the result whenever the
      // defender is wrapped/escape-prevented but NOT Commanded (the common case
      // for any ordinary Wrap/Bind/Fire Spin, not just Dondozo/Tatsugiri).
      if ((!hasFlag(defender.mon.status2, STATUS2_WRAPPED | STATUS2_ESCAPE_PREVENTION) || !hasFlag(defender.statuses4, STATUS4_COMMANDED)) && getHealthPercentage(state, battlerAtk) > 70) score++
      break
    }

    case 'EFFECT_MIMIC':
      // C: `return AI_CheckViability(battlerAtk, battlerDef, gLastMoves[battlerDef],
      // score);` -- same top-level re-entry as EFFECT_MIRROR_MOVE above (review
      // finding, CRITICAL); same self-referential-recursion guard applies.
      if (getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0) {
        if (defender.lastMove !== null) {
          const targetEffect = deps.moveData(defender.lastMove)?.effect ?? null
          if (targetEffect === 'EFFECT_MIRROR_MOVE' || targetEffect === 'EFFECT_MIMIC') {
            unmodelled.push(`EFFECT_MIMIC: gLastMoves[battlerDef] (${defender.lastMove}) is itself ${targetEffect}, which would recurse into the same lookup forever (a real infinite loop in the C too); refused instead of reproducing the hang`)
            break
          }
          const recursed = aiCheckViability(state, battlerAtk, battlerDef, defender.lastMove, score, deps)
          unmodelled.push(...recursed.unmodelled)
          return recursed.score
        }
      }
      break

    case 'EFFECT_LEECH_SEED': {
      // C: `IS_BATTLER_OF_TYPE(battlerDef,GRASS) || LEECHSEED || RAPID_SPIN ||
      // BattlerHasAbility(battlerDef, ABILITY_LIQUID_OOZE, TRUE) ||
      // IsMagicGuardProtected(battlerDef)` -- the Liquid Ooze and Magic Guard
      // terms were dropped in an earlier revision of this file.
      if (
        isBattlerOfType(defender, 'GRASS') ||
        hasFlag(defender.statuses3, STATUS3_LEECHSEED) ||
        hasMoveEffect(defender, 'EFFECT_RAPID_SPIN', deps) ||
        defAbility(defender, 'ABILITY_LIQUID_OOZE', atkMoldBreaker) ||
        isMagicGuardProtected(state, defender)
      ) {
        break
      }
      score += 3
      // C: `if (!HasDamagingMove(battlerDef) || IsBattlerTrapped(battlerDef, FALSE))
      // score += 2;` -- the IsBattlerTrapped OR-term was dropped in an earlier
      // revision of this file. `checkSwitch=FALSE` matches the C's literal arg.
      const trapped = isBattlerTrapped(state, defender, false, deps)
      unmodelled.push(...trapped.unmodelled)
      if (!hasDamagingMove(defender, deps) || trapped.trapped) score += 2
      break
    }

    case 'EFFECT_DO_NOTHING':
      break

    case 'EFFECT_SWITCH_ARGUMENT':
      // `if (!(gBattleTypeFlags & BATTLE_TYPE_TRAINER) || GetBattlerSide(battlerAtk)
      // != B_SIDE_PLAYER) break; FALLTHROUGH` -- battlerAtk is ALWAYS the AI here,
      // and the AI is never B_SIDE_PLAYER (this sim only ever scores the
      // opponent's moves), so `GetBattlerSide(battlerAtk) != B_SIDE_PLAYER` is
      // unconditionally true regardless of the trainer-battle flag -- the
      // fallthrough to EFFECT_HIT_ESCAPE/PARTING_SHOT's pivot logic can never
      // be reached from this case on this build. Structural, not a gap.
      break

    case 'EFFECT_HIT_ESCAPE':
    case 'EFFECT_PARTING_SHOT': {
      const pivot = shouldPivot(state, battlerAtk, battlerDef, moveId, deps)
      unmodelled.push(...pivot.unmodelled)
      if (pivot.result === DONT_PIVOT) score -= 10
      else if (pivot.result === PIVOT) score += 7
      break
    }

    case 'EFFECT_BATON_PASS': {
      const switchResult = shouldSwitch(state, battlerAtk, deps)
      unmodelled.push(...switchResult.unmodelled)
      // C ORs `STATUS3_ROOTED | STATUS3_AQUA_RING | STATUS3_MAGNET_RISE |
      // STATUS3_POWER_TRICK` as one combined-flag read (same pattern
      // aiCheckBadMove.ts:1698 already uses) -- an earlier revision of this file
      // checked only STATUS3_ROOTED.
      if (
        switchResult.shouldSwitch &&
        (hasFlag(attacker.mon.status2, STATUS2_SUBSTITUTE) || hasFlag(attacker.statuses3, STATUS3_ROOTED | STATUS3_AQUA_RING | STATUS3_MAGNET_RISE | STATUS3_POWER_TRICK) || anyStatIsRaised(attacker))
      ) {
        score += 5
      }
      break
    }

    case 'EFFECT_DISABLE': {
      // `B_MENTAL_HERB >= GEN_5 && holdEffects[battlerDef] != HOLD_EFFECT_MENTAL_HERB`
      // -- `B_MENTAL_HERB` is `GEN_5` on this build (battle_config.h:102), so the
      // compile-time half is always true and the hold-effect check is live; an
      // earlier revision of this file dropped it entirely.
      if (defender.volatiles.disableTimer === 0 && getBattlerHoldEffect(defender, deps) !== 'HOLD_EFFECT_MENTAL_HERB') {
        if (getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0) {
          if (defender.lastMove !== null) {
            const faints = canMoveFaintBattler(state, defender.lastMove, battlerDef, battlerAtk, deps)
            unmodelled.push(...faints.unmodelled)
            if (faints.faints) score += 2
          }
        } else if (predictedMoveId !== null && deps.moveData(predictedMoveId)?.split === 'STATUS') {
          score++
        }
      }
      break
    }

    case 'EFFECT_ENCORE':
      // Same Mental Herb exclusion as EFFECT_DISABLE above.
      if (defender.volatiles.encoreTimer === 0 && getBattlerHoldEffect(defender, deps) !== 'HOLD_EFFECT_MENTAL_HERB') {
        const lastEffect = defender.lastMove ? (deps.moveData(defender.lastMove)?.effect ?? null) : null
        if (isEncoreEncouragedEffect(lastEffect)) score += 3
      }
      break

    case 'EFFECT_PAIN_SPLIT': {
      const newHp = Math.floor((attacker.mon.hp + defender.mon.hp) / 2)
      const healthBenchmark = Math.floor((attacker.mon.hp * 12) / 10)
      if (newHp > healthBenchmark) {
        const dmgResult = aiCalcDamage(state, moveId, battlerAtk, battlerDef, deps)
        unmodelled.push(...dmgResult.unmodelled)
        const absorb = shouldAbsorb(state, battlerAtk, battlerDef, moveId, dmgResult.dmg, deps)
        unmodelled.push(...absorb.unmodelled)
        if (absorb.should) score += 2
      }
      break
    }

    case 'EFFECT_SLEEP_TALK':
    case 'EFFECT_SNORE':
      unmodelled.push('EFFECT_SLEEP_TALK/EFFECT_SNORE: IsWakeupTurn has no port (no move-history-by-turn tracking exists in this sim); treated as false')
      if (hasFlag(attacker.mon.status1, STATUS1_SLEEP)) score += 10
      break

    case 'EFFECT_LOCK_ON':
      if (hasMoveEffect(attacker, 'EFFECT_OHKO', deps)) {
        score += 3
      } else if (selfAbility(attacker, 'ABILITY_COMPOUND_EYES') && hasMoveWithLowAccuracy(attacker, 80, true, deps, unmodelled)) {
        score += 3
      } else if (hasMoveWithLowAccuracy(attacker, 85, true, deps, unmodelled)) {
        score += 3
      } else if (hasMoveWithLowAccuracy(attacker, 90, true, deps, unmodelled)) {
        score++
      }
      break

    case 'EFFECT_SPEED_UP_HIT':
      if (selfAbility(attacker, 'ABILITY_SERENE_GRACE') && !selfAbility(defender, 'ABILITY_CONTRARY') && !isAiFaster(state, battlerAtk, battlerDef, moveId, deps)) {
        score += 3
      }
      break

    case 'EFFECT_DESTINY_BOND': {
      if (getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0) {
        const faintsAtk = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
        unmodelled.push(...faintsAtk.unmodelled)
        if (faintsAtk.canFaint) score += 3
      }
      break
    }

    case 'EFFECT_SPITE':
      // TODO in the C itself -- predicted move, never implemented there either.
      break

    case 'EFFECT_WISH':
    case 'EFFECT_HEAL_BELL':
      if (shouldUseWishAromatherapy(state, battlerDef, moveId, deps)) score += 7
      break

    case 'EFFECT_THIEF': {
      // `canSteal = FALSE; #if B_TRAINERS_KNOCK_OFF_ITEMS == TRUE canSteal = TRUE;
      // #endif; if (BATTLE_TYPE_FRONTIER || GetBattlerSide(battlerAtk) ==
      // B_SIDE_PLAYER) canSteal = TRUE;` -- `B_TRAINERS_KNOCK_OFF_ITEMS` is `TRUE`
      // on this pinned build (battle_config.h:103, "trainers can steal/swap your
      // items"), so the `#if` block is compile-time LIVE and sets canSteal
      // unconditionally, before the BATTLE_TYPE_FRONTIER/B_SIDE_PLAYER OR-check
      // ever runs -- that check can only ALSO set it true, never back to false,
      // so it is dead code on THIS build regardless of side (an earlier revision
      // of this file assumed the vanilla default of B_TRAINERS_KNOCK_OFF_ITEMS
      // unset, which is wrong for Elite Redux specifically; also assumed the
      // dead OR-check was the reason canSteal ends up true, when it is really
      // the compile-time flag).
      const canSteal = true
      const atkItem = attacker.mon.itemId
      const defItem = defender.mon.itemId
      if (canSteal && !atkItem && defItem && canBattlerGetOrLoseItemApprox(defender, defItem, deps) && canBattlerGetOrLoseItemApprox(attacker, defItem, deps) && !hasMoveEffect(attacker, 'EFFECT_ACROBATICS', deps) && !isStickyHold(defender, atkMoldBreaker)) {
        const defHoldEffect = getBattlerHoldEffect(defender, deps)
        switch (defHoldEffect) {
          case null:
          case 'HOLD_EFFECT_NONE':
            break
          case 'HOLD_EFFECT_CHOICE_BAND':
          case 'HOLD_EFFECT_CHOICE_SCARF':
          case 'HOLD_EFFECT_CHOICE_SPECS':
            score += 2
            break
          case 'HOLD_EFFECT_TOXIC_ORB':
            unmodelled.push('EFFECT_THIEF: ShouldPoisonSelf has no port anywhere in this codebase; treated as false')
            break
          case 'HOLD_EFFECT_FLAME_ORB':
            unmodelled.push('EFFECT_THIEF: ShouldBurnSelf has no port anywhere in this codebase; treated as false')
            break
          case 'HOLD_EFFECT_FROST_ORB':
            unmodelled.push('EFFECT_THIEF: ShouldFrostbiteSelf has no port anywhere in this codebase; treated as false')
            break
          case 'HOLD_EFFECT_BLACK_SLUDGE':
            if (isBattlerOfType(attacker, 'POISON')) score += 2
            break
          case 'HOLD_EFFECT_IRON_BALL':
            if (hasMoveEffect(attacker, 'EFFECT_FLING', deps)) score += 2
            break
          case 'HOLD_EFFECT_LAGGING_TAIL':
          case 'HOLD_EFFECT_STICKY_BARB':
            break
          default:
            score++
            break
        }
      }
      break
    }

    case 'EFFECT_NIGHTMARE': {
      const comatose = ALWAYS_SLEEPING_ABILITIES.some((id) => selfAbility(defender, id))
      if (!hasFlag(defender.mon.status2, STATUS2_NIGHTMARE) && (comatose || hasFlag(defender.mon.status1, STATUS1_SLEEP))) {
        score += 5
        const trapped = isBattlerTrapped(state, defender, true, deps)
        unmodelled.push(...trapped.unmodelled)
        if (trapped.trapped) score += 3
      }
      break
    }

    case 'EFFECT_CURSE':
      if (isBattlerOfType(attacker, 'GHOST') || isBattlerWeatherAffected(state, WEATHER_FOG_ANY, deps)) {
        const trapped = isBattlerTrapped(state, defender, true, deps)
        unmodelled.push(...trapped.unmodelled)
        if (trapped.trapped) score += 3
        else score++
        break
      } else {
        // `IsMagicGuardProtected(battlerDef)` -- the DEFENDER, not the
        // self-targeting attacker Curse actually boosts; reproduced exactly
        // as the C writes it (a quirk, not "fixed" to battlerAtk).
        if (selfAbility(attacker, 'ABILITY_CONTRARY') || isMagicGuardProtected(state, defender)) break
        else if (attacker.mon.statStages[STAT_ATK] < 8) score += 8 - attacker.mon.statStages[STAT_ATK]
        else if (attacker.mon.statStages[STAT_SPEED] < 3) break
        else if (attacker.mon.statStages[STAT_DEF] < 8) score += 8 - attacker.mon.statStages[STAT_DEF]
      }
      break

    case 'EFFECT_PROTECT': {
      const predicted = predictedMoveId
      switch (moveId) {
        case 'MOVE_QUICK_GUARD':
          if (predicted !== null && (deps.moveData(predicted)?.priority ?? 0) > 0) {
            score = protectChecks(state, battlerAtk, battlerDef, predicted, score, deps)
          }
          break
        case 'MOVE_WIDE_GUARD': {
          const predictedTarget = predicted ? deps.moveData(predicted)?.target : undefined
          if (predicted !== null && (predictedTarget === 'BOTH' || predictedTarget === 'FOES_AND_ALLY')) {
            score = protectChecks(state, battlerAtk, battlerDef, predicted, score, deps)
          }
          break
        }
        case 'MOVE_CRAFTY_SHIELD': {
          const predictedMove = predicted ? deps.moveData(predicted) : null
          if (predicted !== null && predictedMove?.split === 'STATUS' && !moveTargetsUser(predictedMove)) {
            score = protectChecks(state, battlerAtk, battlerDef, predicted, score, deps)
          }
          break
        }
        case 'MOVE_MAT_BLOCK': {
          const predictedMove = predicted ? deps.moveData(predicted) : null
          if (attacker.volatiles.isFirstTurn && predicted !== null && predictedMove?.split !== 'STATUS' && predictedMove && !moveTargetsUser(predictedMove)) {
            score = protectChecks(state, battlerAtk, battlerDef, predicted, score, deps)
          }
          break
        }
        case 'MOVE_KINGS_SHIELD':
          if (attacker.mon.speciesId === 'SPECIES_AEGISLASH_BLADE' && selfAbility(attacker, 'ABILITY_STANCE_CHANGE') && !isBattlerIncapacitated(defender, deps)) {
            score += 3
          } else {
            // FALLTHROUGH to `default` in the C -- written as an explicit
            // call instead of a syntactic fallthrough (tsconfig's
            // `noFallthroughCasesInSwitch` forbids the latter).
            score = protectChecks(state, battlerAtk, battlerDef, predicted, score, deps)
          }
          break
        default:
          score = protectChecks(state, battlerAtk, battlerDef, predicted, score, deps)
          break
      }
      break
    }

    case 'EFFECT_ENDURE': {
      const faintsAtk = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
      unmodelled.push(...faintsAtk.unmodelled)
      if (faintsAtk.canFaint) {
        if (attacker.mon.hp > Math.floor(attacker.mon.maxHp / 4) && isPinchBerryItemEffect(getBattlerHoldEffect(attacker, deps))) {
          score += 3
        }
      }
      break
    }

    case 'EFFECT_SPIKES':
    case 'EFFECT_STEALTH_ROCK':
    case 'EFFECT_STICKY_WEB':
    case 'EFFECT_TOXIC_SPIKES':
      if (defAbility(defender, 'ABILITY_MAGIC_BOUNCE', atkMoldBreaker) || countUsablePartyMons(state, battlerDef) === 0) break
      if (attacker.volatiles.isFirstTurn) score += 2
      break

    case 'EFFECT_FORESIGHT':
      if (selfAbility(attacker, 'ABILITY_SCRAPPY')) break
      if (selfAbility(attacker, 'ABILITY_BLIND_RAGE')) {
        break
      } else if (defender.mon.statStages[STAT_EVASION] > DEFAULT_STAT_STAGE || (isBattlerOfType(defender, 'GHOST') && (hasMoveWithType(attacker, 'NORMAL', deps) || hasMoveWithType(attacker, 'FIGHTING', deps)))) {
        score += 2
      }
      break

    case 'EFFECT_MIRACLE_EYE':
      if (defender.mon.statStages[STAT_EVASION] > DEFAULT_STAT_STAGE || (isBattlerOfType(defender, 'DARK') && hasMoveWithType(attacker, 'PSYCHIC', deps))) {
        score += 2
      }
      break

    case 'EFFECT_PERISH_SONG': {
      const trapped = isBattlerTrapped(state, defender, true, deps)
      unmodelled.push(...trapped.unmodelled)
      if (trapped.trapped) score += 3
      break
    }

    // ======================================================================
    // Part 2a: EFFECT_SANDSTORM (:3224) through EFFECT_PSYCHO_SHIFT (:3606).
    // ======================================================================

    case 'EFFECT_SANDSTORM':
      if (shouldSetSandstorm(state, battlerAtk, deps)) {
        score++
        if (aiHoldEffect(attacker, deps, unmodelled) === 'HOLD_EFFECT_SMOOTH_ROCK') score++
        if (hasMoveEffect(defender, 'EFFECT_MORNING_SUN', deps) || hasMoveEffect(defender, 'EFFECT_SYNTHESIS', deps) || hasMoveEffect(defender, 'EFFECT_MOONLIGHT', deps)) score += 2
      }
      break

    case 'EFFECT_HAIL':
      if (shouldSetHail(state, battlerAtk, deps)) {
        if (
          (hasMoveEffect(attacker, 'EFFECT_AURORA_VEIL', deps) || hasMoveEffectOf(state, battlePartner(battlerAtk), 'EFFECT_AURORA_VEIL', deps)) &&
          shouldSetScreen(state, battlerAtk, battlerDef, 'EFFECT_AURORA_VEIL', deps)
        ) {
          score += 3
        }
        score++
        if (aiHoldEffect(attacker, deps, unmodelled) === 'HOLD_EFFECT_ICY_ROCK') score++
        if (hasMoveEffect(defender, 'EFFECT_MORNING_SUN', deps) || hasMoveEffect(defender, 'EFFECT_SYNTHESIS', deps) || hasMoveEffect(defender, 'EFFECT_MOONLIGHT', deps)) score += 2
      }
      break

    case 'EFFECT_RAIN_DANCE':
      if (shouldSetRain(state, battlerAtk, deps)) {
        score++
        if (aiHoldEffect(attacker, deps, unmodelled) === 'HOLD_EFFECT_DAMP_ROCK') score++
        if (hasMoveEffect(defender, 'EFFECT_MORNING_SUN', deps) || hasMoveEffect(defender, 'EFFECT_SYNTHESIS', deps) || hasMoveEffect(defender, 'EFFECT_MOONLIGHT', deps)) score += 2
        if (hasMoveWithType(defender, 'FIRE', deps) || hasMoveWithTypeOf(state, battlePartner(battlerDef), 'FIRE', deps)) score++
      }
      break

    case 'EFFECT_SUNNY_DAY':
      if (shouldSetSun(state, battlerAtk, deps)) {
        score++
        if (aiHoldEffect(attacker, deps, unmodelled) === 'HOLD_EFFECT_HEAT_ROCK') score++
        if (hasMoveWithType(defender, 'WATER', deps) || hasMoveWithTypeOf(state, battlePartner(battlerDef), 'WATER', deps)) score++
        if (hasMoveEffect(defender, 'EFFECT_THUNDER', deps) || hasMoveEffectOf(state, battlePartner(battlerDef), 'EFFECT_THUNDER', deps)) score++
      }
      break

    case 'EFFECT_EERIE_FOG':
      if (shouldSetFog(state, battlerAtk, deps)) score++
      break

    case 'EFFECT_ATTACK_UP_HIT':
      if (selfAbility(attacker, 'ABILITY_SERENE_GRACE')) score = increaseStatUpScore(state, battlerAtk, battlerDef, STAT_ATK, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_FELL_STINGER': {
      if (attacker.mon.statStages[STAT_ATK] < MAX_STAT_STAGE && !selfAbility(attacker, 'ABILITY_CONTRARY')) {
        const faints = canIndexMoveFaintTarget(state, battlerAtk, battlerDef, moveId, 0, deps)
        unmodelled.push(...faints.unmodelled)
        if (faints.faints) {
          // `GetWhoStrikesFirst(battlerAtk, battlerDef, TRUE) == 0` -- attacker goes first.
          if (getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0) score += 9
          else score += 3
        }
      }
      break
    }

    case 'EFFECT_BELLY_DRUM': {
      const faintsAtk = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
      unmodelled.push(...faintsAtk.unmodelled)
      if (!faintsAtk.canFaint && hasMoveWithSplit(attacker, 'PHYSICAL', deps) && !selfAbility(attacker, 'ABILITY_CONTRARY')) {
        score += MAX_STAT_STAGE - attacker.mon.statStages[STAT_ATK]
      }
      break
    }

    case 'EFFECT_PSYCH_UP':
    case 'EFFECT_SPECTRAL_THIEF':
      // Want to copy positive stat changes
      for (let i = STAT_ATK; i < NUM_BATTLE_STATS; i++) {
        if (defender.mon.statStages[i] > attacker.mon.statStages[i]) {
          switch (i) {
            case STAT_ATK:
              if (hasMoveWithSplit(attacker, 'PHYSICAL', deps)) score++
              break
            case STAT_SPATK:
              if (hasMoveWithSplit(attacker, 'SPECIAL', deps)) score++
              break
            case STAT_ACC:
            case STAT_EVASION:
            case STAT_SPEED:
              score++
              break
            case STAT_DEF:
            case STAT_SPDEF:
              if (hasFlag(state.aiFlags, AI_FLAG_STALL)) score++
              break
          }
        }
      }
      break

    case 'EFFECT_SEMI_INVULNERABLE':
      score++
      // `predictedMove != MOVE_NONE && !isDoubleBattle`
      if (predictedMoveId !== null && !isValidDoubleBattle(state, battlerAtk)) {
        const predictedEffect = deps.moveData(predictedMoveId)?.effect ?? null
        if (getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0) {
          // Attacker goes first
          if (predictedEffect === 'EFFECT_EXPLOSION' || predictedEffect === 'EFFECT_PROTECT') score += 3
        } else if (predictedEffect === 'EFFECT_SEMI_INVULNERABLE' && !hasFlag(defender.statuses3, STATUS3_SEMI_INVULNERABLE)) {
          score += 3
        }
      }
      break

    case 'EFFECT_DEFENSE_CURL':
      if (hasMoveEffect(attacker, 'EFFECT_ROLLOUT', deps) && !hasFlag(attacker.mon.status2, STATUS2_DEFENSE_CURL)) score++
      score = increaseStatUpScore(state, battlerAtk, battlerDef, STAT_DEF, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_FAKE_OUT':
      // `move == MOVE_FAKE_OUT` filters out First Impression, which shares the effect.
      if (moveId === 'MOVE_FAKE_OUT' && shouldFakeOut(state, battlerAtk, battlerDef, moveId, deps, unmodelled)) score += 16
      break

    case 'EFFECT_STOCKPILE':
      if (selfAbility(attacker, 'ABILITY_CONTRARY')) break
      if (hasMoveEffect(attacker, 'EFFECT_SWALLOW', deps) || hasMoveEffect(attacker, 'EFFECT_SPIT_UP', deps)) score += 2
      score = increaseStatUpScore(state, battlerAtk, battlerDef, STAT_DEF, moveId, score, deps, unmodelled)
      score = increaseStatUpScore(state, battlerAtk, battlerDef, STAT_SPDEF, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_ROLLOUT':
      if (hasFlag(attacker.mon.status2, STATUS2_DEFENSE_CURL)) score += 8
      break

    case 'EFFECT_SWAGGER':
      if (hasMoveEffect(attacker, 'EFFECT_FOUL_PLAY', deps) || hasMoveEffect(attacker, 'EFFECT_PSYCH_UP', deps) || hasMoveEffect(attacker, 'EFFECT_SPECTRAL_THIEF', deps)) score++
      if (defAbility(defender, 'ABILITY_CONTRARY', atkMoldBreaker)) score += 2
      score = increaseConfusionScore(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_FLATTER':
      if (hasMoveEffect(attacker, 'EFFECT_PSYCH_UP', deps) || hasMoveEffect(attacker, 'EFFECT_SPECTRAL_THIEF', deps)) score += 2
      if (defAbility(defender, 'ABILITY_CONTRARY', atkMoldBreaker)) score += 2
      score = increaseConfusionScore(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_ATTRACT': {
      // `!isDoubleBattle && BattlerWillFaintFromSecondaryDamage(battlerDef) &&
      // GetWhoStrikesFirst(...) == 1` -> break. BattlerWillFaintFromSecondaryDamage
      // reuses the established GetBattlerSecondaryDamage gap (always false).
      unmodelled.push('EFFECT_ATTRACT: BattlerWillFaintFromSecondaryDamage(battlerDef) needs GetBattlerSecondaryDamage, which has no port anywhere in this codebase; treated as false')
      const trapped = isBattlerTrapped(state, defender, true, deps)
      unmodelled.push(...trapped.unmodelled)
      if (hasFlag(defender.mon.status1, STATUS1_ANY) || hasFlag(defender.mon.status2, STATUS2_CONFUSION) || trapped.trapped) score += 2
      else score++
      break
    }

    case 'EFFECT_SAFEGUARD':
      if (!(getCurrentTerrain(state) === STATUS_FIELD_MISTY_TERRAIN) || !deps.turnOrder.isBattlerGrounded(battlerAtk)) score++
      // The C's `CountUsablePartyMons(battlerDef) != 0 -> score += 8` is commented out.
      break

    case 'EFFECT_PURSUIT':
      // The whole body is a `/*TODO ... */` block in the C: nothing executes.
      break

    case 'EFFECT_RAPID_SPIN':
      score = increaseStatUpScore(state, battlerAtk, battlerDef, STAT_SPEED, moveId, score, deps, unmodelled) // Gen 8 increases speed
      score = defogBody(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_DEFOG':
      score = defogBody(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_TORMENT':
      break

    case 'EFFECT_WILL_O_WISP':
      score = increaseBurnScore(state, battlerAtk, battlerDef, score, deps, unmodelled)
      break

    case 'EFFECT_FOLLOW_ME':
      if (
        isValidDoubleBattle(state, battlerAtk) &&
        moveId !== 'MOVE_SPOTLIGHT' &&
        !isBattlerIncapacitated(defender, deps) &&
        (moveId !== 'MOVE_RAGE_POWDER' || !isPowderImmune(defender, atkMoldBreaker, deps)) && // Rage Powder doesn't affect powder immunities
        isBattlerAlive(state, battlePartner(battlerAtk))
      ) {
        const predictedMoveOnPartner = state.battlers[battlePartner(battlerAtk)]?.lastMove ?? null
        if (predictedMoveOnPartner !== null && deps.moveData(predictedMoveOnPartner)?.split !== 'STATUS') score += 3
      }
      break

    case 'EFFECT_NATURE_POWER': {
      // C: `return AI_CheckViability(battlerAtk, battlerDef, GetNaturePowerMove(), score)` --
      // the top-level function, with its own fresh pre-switch ladder.
      const recursed = aiCheckViability(state, battlerAtk, battlerDef, getNaturePowerMove(state, unmodelled), score, deps)
      unmodelled.push(...recursed.unmodelled)
      return recursed.score
    }

    case 'EFFECT_CHARGE':
      if (hasDamagingMoveOfType(attacker, 'ELECTRIC', deps)) score += 2
      score = increaseStatUpScore(state, battlerAtk, battlerDef, STAT_SPDEF, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_TAUNT':
      if (predictedMoveId !== null && deps.moveData(predictedMoveId)?.split === 'STATUS') score += 10 // was 3
      else if (hasMoveWithSplit(defender, 'STATUS', deps)) score += 2
      break

    case 'EFFECT_TRICK':
    case 'EFFECT_BESTOW':
      score = applyTrickBestow(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    case 'EFFECT_ROLE_PLAY':
      if (
        !isRolePlayBannedAbilityAtk(battlerAbility(attacker)) &&
        !isRolePlayBannedAbility(battlerAbility(defender)) &&
        !isAbilityOfRating(battlerAbility(attacker), 5) &&
        isAbilityOfRating(battlerAbility(defender), 5)
      ) {
        score += 2
      }
      break

    case 'EFFECT_INGRAIN':
      if (aiHoldEffect(attacker, deps, unmodelled) === 'HOLD_EFFECT_BIG_ROOT') score += 3
      else score++
      break

    case 'EFFECT_SUPERPOWER':
    case 'EFFECT_OVERHEAT':
      if (selfAbility(attacker, 'ABILITY_CONTRARY')) score += 10
      break

    case 'EFFECT_MAGIC_COAT': {
      // `gBattleMoves[predictedMove].target & (MOVE_TARGET_SELECTED |
      // MOVE_TARGET_OPPONENTS_FIELD | MOVE_TARGET_BOTH)` -- QUIRK: MOVE_TARGET_SELECTED
      // is 0x0 (include/constants/battle.h:491), so it contributes NOTHING to the
      // mask; only BOTH (0x8) and OPPONENTS_FIELD (0x40) can match. A predicted
      // move with the ordinary single-target `SELECTED` spelling never does.
      const predicted = predictedMoveId !== null ? deps.moveData(predictedMoveId) : undefined
      if (predicted?.split === 'STATUS' && (predicted.target === 'OPPONENTS_FIELD' || predicted.target === 'BOTH')) score += 3
      break
    }

    case 'EFFECT_RECYCLE': {
      const usedItem = getUsedHeldItem(attacker, unmodelled)
      if (usedItem !== null) score++
      if (isRecycleEncouragedItem(usedItem)) score++
      if (hasRipenEffect(attacker)) {
        if (isStatBoostingBerry(usedItem) && atkHpPercent > 60) {
          score++
        } else if (shouldRestoreHpBerry(attacker, usedItem)) {
          // C computes `u16 toHeal` BEFORE the branch, whenever HasRipenEffect is
          // true: `(param == 10) ? 10 : maxHP / param`. param 0 would divide by
          // zero in the C (reachable for a non-HP-berry used item, but then toHeal
          // is never read); it is only consumed here, where the item is an HP berry.
          const param = usedItem ? (deps.dataContext.item(usedItem)?.holdEffectStrength ?? 0) : 0
          if (param === 0) unmodelled.push(`EFFECT_RECYCLE: ItemId_GetHoldEffectParam(${usedItem}) is 0 in the snapshot, so the C's u16 toHeal = maxHP / 0 is undefined; treated as 0`)
          const toHeal = param === 10 ? 10 : param === 0 ? 0 : Math.floor(attacker.mon.maxHp / param) & 0xffff
          const canFaintNow = canAiFaintTarget(state, battlerAtk, battlerDef, 0, deps)
          unmodelled.push(...canFaintNow.unmodelled)
          if (!canFaintNow.canFaint) {
            let cond = false
            if (getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0) {
              const targetFaints = canTargetFaintAiWithMod(state, battlerDef, battlerAtk, 0, 0, deps)
              unmodelled.push(...targetFaints.unmodelled)
              cond = targetFaints.canFaint
            }
            if (!cond) {
              const targetFaintsAfterHeal = canTargetFaintAiWithMod(state, battlerDef, battlerAtk, toHeal, 0, deps)
              unmodelled.push(...targetFaintsAfterHeal.unmodelled)
              cond = !targetFaintsAfterHeal.canFaint
            }
            // Recycle healing berry if we can't otherwise faint the target and the target wont kill us after we activate the berry
            if (cond) score++
          }
        }
      }
      break
    }

    case 'EFFECT_BRICK_BREAK': {
      const defSide = state.sides[battlerDef & 1].statuses
      if (hasFlag(defSide, SIDE_STATUS_REFLECT)) score++
      if (hasFlag(defSide, SIDE_STATUS_LIGHTSCREEN)) score++
      if (hasFlag(defSide, SIDE_STATUS_AURORA_VEIL)) score++
      break
    }

    case 'EFFECT_STORED_POWER':
      if (countBattlerStatIncreases(attacker, true) < 2) score -= 4
      else if (countBattlerStatIncreases(attacker, true) > 6) score += 4
      break

    case 'EFFECT_KNOCK_OFF':
      if (canKnockOffItem(defender, defender.mon.itemId, deps)) {
        switch (aiHoldEffect(defender, deps, unmodelled)) {
          case 'HOLD_EFFECT_IRON_BALL':
            if (hasMoveEffect(defender, 'EFFECT_FLING', deps)) score += 4
            break
          case 'HOLD_EFFECT_LAGGING_TAIL':
          case 'HOLD_EFFECT_STICKY_BARB':
            break
          default:
            score += 3
            break
        }
      }
      break

    case 'EFFECT_SKILL_SWAP':
      if (getAbilityRating(battlerAbility(defender)) > getAbilityRating(battlerAbility(attacker))) score++
      break

    case 'EFFECT_WORRY_SEED':
    case 'EFFECT_GASTRO_ACID':
    case 'EFFECT_SIMPLE_BEAM':
      if (isAbilityOfRating(battlerAbility(defender), 5)) score += 2
      break

    case 'EFFECT_ENTRAINMENT':
      if (isAbilityOfRating(battlerAbility(defender), 5) || getAbilityRating(battlerAbility(attacker)) <= 0) {
        if (battlerAbility(attacker) !== battlerAbility(defender) && !hasFlag(defender.statuses3, STATUS3_GASTRO_ACID)) score += 2
      }
      break

    case 'EFFECT_IMPRISON':
      if (predictedMoveId !== null && hasMove(attacker, predictedMoveId)) score += 3
      else if (attacker.volatiles.isFirstTurn === 0) score++
      break

    case 'EFFECT_REFRESH':
      if (hasFlag(attacker.mon.status1, STATUS1_POISON_ANY | STATUS1_BURN | STATUS1_PARALYSIS | STATUS1_FROSTBITE | STATUS1_BLEED)) score += 2
      break

    case 'EFFECT_PSYCHO_SHIFT':
      if (hasFlag(attacker.mon.status1, STATUS1_POISON_ANY)) score = increasePoisonScore(state, battlerAtk, battlerDef, score, deps, unmodelled)
      else if (hasFlag(attacker.mon.status1, STATUS1_BURN)) score = increaseBurnScore(state, battlerAtk, battlerDef, score, deps, unmodelled)
      else if (hasFlag(attacker.mon.status1, STATUS1_PARALYSIS)) score = increaseParalyzeScore(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      else if (hasFlag(attacker.mon.status1, STATUS1_SLEEP)) score = increaseSleepScore(state, battlerAtk, battlerDef, score, deps, unmodelled)
      else if (hasFlag(attacker.mon.status1, STATUS1_FROSTBITE)) score = increaseFrostbiteScore(state, battlerAtk, battlerDef, moveId, score, deps, unmodelled)
      break

    default:
      // Every label from EFFECT_GRUDGE onward (battle_ai_main.c:3607+) is part
      // 2b's own scope -- gapped explicitly rather than silently scored as 0. An
      // effect with NO case label anywhere in the C's switch (which has no
      // top-level `default:`) is a genuine no-op there, so it is not a gap.
      if (moveEffect && PART2B_EFFECTS.includes(moveEffect)) {
        unmodelled.push(`AI_CheckViability part 2b gap: ${moveEffect} is handled at battle_ai_main.c:3607+, not yet ported`)
      }
      break
  }

  return score
}

/** `MovesWithSplitUnusable(attacker, target, split)`, battle_ai_util.c:
 * 600-615 -- NOT an AI_CheckBadMove delegate (an earlier draft of this file
 * guessed wrong): it scans the attacker's OWN moveset for moves of `split`,
 * and returns TRUE only if EVERY one of them (or there are none at all) is
 * 0x-effective against the target. `SetTypeBeforeUsingMove`/`GET_MOVE_TYPE`
 * (the move's dynamically-resolved type) is approximated by the move's own
 * declared type, same precedent as this module's other type reads. */
function movesWithSplitUnusable(state: BattleState, battlerAtk: number, battlerDef: number, split: 'PHYSICAL' | 'SPECIAL', deps: AiDamageDeps, unmodelled: string[]): boolean {
  const attacker = state.battlers[battlerAtk] as BattlerState
  let anyUsable = false
  for (const moveId of attacker.mon.moves) {
    if (!moveId) continue
    const md = deps.moveData(moveId)
    if (md?.split !== split) continue
    const effResult = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
    unmodelled.push(...effResult.unmodelled)
    if (effResult.effectiveness !== 0) {
      anyUsable = true
      break
    }
  }
  return !anyUsable
}
