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
// Approximations, applied uniformly rather than per-branch (see each site's
// own inline note for why):
//   - `BattlerHasAbility(x, ABILITY, TRUE)` (checkMoldBreaker=TRUE) checks on
//     battlerDef's ability are suppressed exactly when battlerAtk has Mold
//     Breaker (`deps.grounding.attackerHasMoldBreaker`), NOT per-ability
//     `breakable` flag the way abilities/dispatchCalc.ts's own
//     suppressedByMoldBreaker does for the damage path -- this batch has no
//     per-ability breakable lookup wired for AI scoring specifically, so a
//     Mold-Breaker attacker is treated as bypassing EVERY one of these
//     checks, not just the breakable ones. The same calls on battlerAtk's OWN
//     ability (BattlerStatCanRise's own Contrary read, etc.) are NEVER
//     suppressed -- an attacker's Mold Breaker does not affect its own
//     abilities (SetMoldBreaker's real guard is `battler != gBattlerAttacker`).
//   - `gBattleMoves[move].type` (the move's OWN declared type from
//     moves.json) stands in for `GET_MOVE_TYPE`'s dynamically-resolved type.
//     Reported as a gap only for the handful of moves whose type is
//     genuinely variable (Hidden Power, Weather Ball, Judgment, Techno
//     Blast, Multi-Attack, Natural Gift, Revelation Dance -- effect-name
//     matched below) since every other move's declared and resolved type
//     are the same value.
//   - A `RETURN_ABILITY_IF_FLAG`/`ON_ABILITY` scan across every ability that
//     carries a given hook flag (onStatLowered, suctionCups, alwaysSleeping,
//     ...) is narrowed to the one vanilla ability that flag is best known
//     for, since this batch does not read abilityHooks.json's flag lists --
//     see each site's own note.
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

/** `BattlerHasAbility(battlerDef, ABILITY_X, TRUE)` -- see this module's
 * header for the uniform Mold-Breaker-suppresses-everything approximation. */
function defAbility(battler: BattlerState, abilityId: string, attackerHasMoldBreaker: boolean): boolean {
  return battlerHasAbility(battler.mon.abilities, abilityId, () => attackerHasMoldBreaker)
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

/** GetMoveDynamicType, approximated as the move's own declared type --
 * see this module's header for the variable-type-move gap. */
const VARIABLE_TYPE_EFFECTS = new Set(['EFFECT_HIDDEN_POWER', 'EFFECT_WEATHER_BALL', 'EFFECT_JUDGMENT', 'EFFECT_TECHNO_BLAST', 'EFFECT_MULTI_ATTACK', 'EFFECT_NATURAL_GIFT', 'EFFECT_REVELATION_DANCE'])
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

/** LoweringStatsPointlessOrBad, battle_ai_util.c:1274-1279 -- IsStatDropBlocked
 * has no port anywhere in this codebase (see this module's header); the
 * `onStatLowered` ability-flag scan is narrowed to Defiant (the flag's best
 * known holder) rather than a real abilityHooks.json flag scan. */
function loweringStatsPointlessOrBad(defender: BattlerState, attackerHasMoldBreaker: boolean, unmodelled: string[]): boolean {
  unmodelled.push('LoweringStatsPointlessOrBad: IsStatDropBlocked(battlerDef, STAT_HP, FALSE) has no port anywhere in this codebase (same admission as accuracy.ts\'s own header); treated as not blocked')
  if (defAbility(defender, 'ABILITY_CONTRARY', attackerHasMoldBreaker)) return true
  if (defAbility(defender, 'ABILITY_DEFIANT', attackerHasMoldBreaker)) {
    unmodelled.push("LoweringStatsPointlessOrBad: RETURN_ABILITY_IF_FLAG(battlerDef, FALSE, onStatLowered) is narrowed to ABILITY_DEFIANT (this flag's best-known holder) rather than a real abilityHooks.json onStatLowered scan")
    return true
  }
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

// PART2_EFFECTS -- every case label handled ONLY in part 2 (:1299 onward,
// EFFECT_SANDSTORM through the end of the function). Transcribed from a full
// read of :1299-2164's switch labels.
const PART2_EFFECTS = new Set([
  'EFFECT_SANDSTORM', 'EFFECT_HAIL', 'EFFECT_RAIN_DANCE', 'EFFECT_SUNNY_DAY', 'EFFECT_WEATHER_BALL',
  'EFFECT_ATTRACT', 'EFFECT_SAFEGUARD', 'EFFECT_ENDURE', 'EFFECT_DESTINY_BOND', 'EFFECT_ENCORE_2', 'EFFECT_HELPING_HAND',
  'EFFECT_PROTECT', 'EFFECT_ENDEAVOR', 'EFFECT_FALSE_SWIPE', 'EFFECT_EMBARGO', 'EFFECT_TAUNT', 'EFFECT_TORMENT', 'EFFECT_IMPRISON',
  'EFFECT_GRASS_PLEDGE', 'EFFECT_WATER_PLEDGE', 'EFFECT_FIRE_PLEDGE', 'EFFECT_NATURAL_GIFT', 'EFFECT_FLING', 'EFFECT_SWITCHEROO',
  'EFFECT_HEAL_BLOCK', 'EFFECT_ELECTRIC_TERRAIN', 'EFFECT_GRASSY_TERRAIN', 'EFFECT_MISTY_TERRAIN', 'EFFECT_PSYCHIC_TERRAIN',
  'EFFECT_PLEDGE', 'EFFECT_TRICK_ROOM', 'EFFECT_MAGIC_ROOM', 'EFFECT_WONDER_ROOM', 'EFFECT_GRAVITY', 'EFFECT_ROOM_SERVICE',
  'EFFECT_YAWN', 'EFFECT_TERRAIN_PULSE', 'EFFECT_PSYCH_UP', 'EFFECT_ME_FIRST', 'EFFECT_SNATCH', 'EFFECT_HIT_ESCAPE',
  'EFFECT_RECOVER', 'EFFECT_MORNING_SUN', 'EFFECT_SYNTHESIS', 'EFFECT_MOONLIGHT', 'EFFECT_ROOST', 'EFFECT_SOFTBOILED',
  'EFFECT_SHORE_UP', 'EFFECT_PURIFY', 'EFFECT_HEALING_WISH', 'EFFECT_LUNAR_DANCE', 'EFFECT_REST', 'EFFECT_WISH', 'EFFECT_INGRAIN',
  'EFFECT_AQUA_RING', 'EFFECT_STOCKPILE', 'EFFECT_SPIT_UP', 'EFFECT_SWALLOW', 'EFFECT_STRENGTH_SAP', 'EFFECT_PAIN_SPLIT',
  'EFFECT_HIDDEN_POWER', 'EFFECT_JUDGMENT', 'EFFECT_TECHNO_BLAST', 'EFFECT_MULTI_ATTACK', 'EFFECT_REVELATION_DANCE',
  'EFFECT_BATON_PASS', 'EFFECT_VOLT_SWITCH', 'EFFECT_PARTING_SHOT', 'EFFECT_TELEPORT', 'EFFECT_ROAR_2', 'EFFECT_HEAL_PULSE',
])
// EFFECT_HIT/EFFECT_POISON_HIT/... fall through to `default` (the damage
// path, :798-804), never part 2 -- excluded above on purpose.

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
      const comatose = selfAbility(defender, 'ABILITY_COMATOSE')
      unmodelled.push("AI_CheckBadMove: IsComatose is narrowed to a plain ABILITY_COMATOSE check rather than a real 'alwaysSleeping' abilityHooks.json flag scan")
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
      else if (defAbility(defender, 'ABILITY_SUCTION_CUPS', atkMoldBreaker)) {
        unmodelled.push("AI_CheckBadMove: EFFECT_ROAR's ON_ABILITY(suctionCups) scan is narrowed to ABILITY_SUCTION_CUPS rather than a real abilityHooks.json suctionCups flag scan")
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
      const comatose = selfAbility(attacker, 'ABILITY_COMATOSE')
      unmodelled.push("AI_CheckBadMove: IsWakeupTurn is not modelled (no move-history-by-turn tracking exists in this sim -- FindMoveUsedXTurnsAgo has no port); treated as false")
      unmodelled.push("AI_CheckBadMove: IsComatose is narrowed to a plain ABILITY_COMATOSE check rather than a real 'alwaysSleeping' abilityHooks.json flag scan")
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
      } else if (!hasFlag(defender.mon.status1, STATUS1_SLEEP) || selfAbility(defender, 'ABILITY_COMATOSE')) {
        unmodelled.push("AI_CheckBadMove: IsComatose is narrowed to a plain ABILITY_COMATOSE check rather than a real 'alwaysSleeping' abilityHooks.json flag scan")
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
