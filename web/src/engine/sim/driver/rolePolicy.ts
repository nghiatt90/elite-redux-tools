// Pure, headless role policies for the solver-v2 player side (plan decision 14,
// Step 2.0a; docs/battle-sim/solver-v2-plan.md). A role is a cheap ordered rule
// list played on battler 0 in singles: the caller picks `roles[partyIndex]` and
// passes it here, and the returned `PlayerChoice` is fed to `playPolicyBattle`.
//
// This file holds the shared inputs every role reads (a 3-sample prediction of
// the AI's next action, our damage ranges, speed order, the predicted switch-in)
// and all six roles: attacker, pivot, lead/hazard setter, set-up sweeper,
// staller and support.
//
// Ports of game mechanics cite the C; the policy thresholds (the 50% default
// safety line, accuracy weighting, the heal threshold) are MODEL CHOICES and
// are marked as such.

import { createBattlerState } from '../create'
import type { AiDamageRolls } from '../ai/aiCalcDamage'
import { aiDamageRolls } from '../ai/aiCalcDamage'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_STEALTH_ROCK,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_ANY,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_POISON_ANY,
  STATUS1_SLEEP,
  STATUS2_CURSED,
  STATUS2_NIGHTMARE,
  STATUS2_SUBSTITUTE,
  STATUS3_LEECHSEED,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_FOG_ANY,
  WEATHER_HAIL_ANY,
  WEATHER_PRIMAL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_ANY,
} from '../constants'
import { isHealingBlocked } from '../endTurn'
import { weatherHasEffect } from '../fieldEndTurn'
import type { BattleState, BattlerState, SimBattleMon, SimPartyMon } from '../state'
import { battlerHasSimAbility, isBattlerWeatherAffected } from '../statBuffs'
import {
  CHECK_SLEEP,
  canBeBurned,
  canBeParalyzed,
  canBeParalyzedIgnoreType,
  canBePoisoned,
  canSleep,
  doesSubstituteBlockMove,
  isAbilityStatusProtected,
  isBattlerTerrainAffected,
  isPowderImmune,
} from '../statusEffects'
import { buildTurnOrderContext } from '../turn'
import type { ChosenAction } from '../turnOrder'
import { getWhoStrikesFirst } from '../turnOrder'
import type { PlayerChoice } from './expectimax'
import { legalChoices } from './expectimax'
import type { PolicyTraceEntry } from './policyBattle'
import { guaranteedKo, ourDamageRange, pivotMoves, predictAi } from './policyInputs'
import type { BattleSession } from './session'
import { aiDamageDepsFor, cloneSession } from './session'

/** All six roles of decision 14: attacker, pivot, lead/hazard setter, set-up
 * sweeper, staller and support. */
export type RoleName = 'attacker' | 'pivot' | 'leadHazard' | 'setupSweeper' | 'staller' | 'support'

/** Role parameters. These are GA genes in the solver (plan decision 14, at most
 * two per role), so every one is optional with the default below. */
export interface RoleParams {
  /** pivot: what counts as a bad matchup. Default 'either'. */
  badMatchup?: 'threatened' | 'noDamage' | 'either'
  /** leadHazard: hazard layers to reach, capped per hazard type (Stealth Rock
   * 1, Spikes 3, Toxic Spikes 2). Default 1. */
  targetLayers?: number
  /** leadHazard: role played once the layers are laid. Default 'attacker'. */
  fallbackRole?: 'attacker' | 'staller'
  /** attacker / pivot / leadHazard / setupSweeper: the HP fraction of our
   * active mon above which a predicted move counts as threatening. Default 50.
   * For the sweeper this is also its "safe to boost" line. */
  safetyPct?: number
  /** setupSweeper: boost while the highest of our Attack / Sp. Atk / Speed
   * stages is below this many stages above neutral. Default 2. */
  targetStage?: 1 | 2 | 3 | 6
  /** staller: heal below this percentage of max HP. Default 50. */
  healThreshold?: 33 | 50 | 66
}

/** Per-battler state the caller owns and persists across turns. `lastMove` is
 * written after every choice (the move id, or null for a hard switch). */
export interface RoleMemory {
  turn: number
  lastMove: string | null
}

// MODEL CHOICE: an incoming move that removes more than this percentage of our
// current HP counts as threatening. 50 is decision 14's default, not a game fact.
export const DEFAULT_SAFETY_PCT = 50
// MODEL CHOICE: decision 14's own defaults for the two new roles.
const DEFAULT_TARGET_STAGE = 2
const DEFAULT_HEAL_THRESHOLD = 50
// Three samples is decision 14's contract (`predictAi(session, 3, seedBase)`).
export const SAMPLE_COUNT = 3
// Deterministic probe seeds: the policy is a pure function of the position.
const PREDICTION_SEED = 0
const SPEED_PROBE_SEED = 0

const MOVE_FAKE_OUT = 'MOVE_FAKE_OUT'

/** The three hazard moves, matched by their moves.json `effect` so a repointed
 * move id in the snapshot is followed rather than a hardcoded name list:
 * MOVE_STEALTH_ROCK = EFFECT_STEALTH_ROCK, MOVE_SPIKES = EFFECT_SPIKES,
 * MOVE_TOXIC_SPIKES = EFFECT_TOXIC_SPIKES. `max` is the layer cap the C enforces
 * -- Spikes < 3 and Toxic Spikes < 2, Stealth Rock once
 * (battle_script_commands.c:9606-9622; Cmd_trysetspikes :11115-11123). Order is
 * the rule's priority: Stealth Rock, then Spikes, then Toxic Spikes. */
const HAZARD_EFFECTS: readonly { effect: string; max: number }[] = [
  { effect: 'EFFECT_STEALTH_ROCK', max: 1 },
  { effect: 'EFFECT_SPIKES', max: 3 },
  { effect: 'EFFECT_TOXIC_SPIKES', max: 2 },
]

function rollsOf(range: AiDamageRolls): number[] {
  return range.totalRolls ?? range.rolls
}

export function lowestRoll(range: AiDamageRolls): number {
  return rollsOf(range)[0]!
}

export function highestRoll(range: AiDamageRolls): number {
  return rollsOf(range)[15]!
}

export function meanRoll(range: AiDamageRolls): number {
  const rolls = rollsOf(range)
  let sum = 0
  for (const roll of rolls) sum += roll
  return sum / rolls.length
}

/** The move has a damage range and the target is not immune to its type. */
function hasDamage(range: AiDamageRolls | null): range is AiDamageRolls {
  return range !== null && !range.isImmune
}

/** The pivot rule's own "unable to damage the target": no legal damaging move
 * whose worst roll is above zero and whose type is not immune. */
function dealsDamage(range: AiDamageRolls | null): range is AiDamageRolls {
  return hasDamage(range) && lowestRoll(range) > 0
}

/** moves.json's accuracy, where 0 means "no accuracy check" (dataContext.ts's
 * SimMoveData.accuracy doc; ACCURACY_HITS_IF_POSSIBLE). */
function accuracyPct(session: BattleSession, moveId: string): number {
  const accuracy = session.data.dataContext.move(moveId)?.accuracy ?? 0
  return accuracy > 0 ? accuracy : 100
}

export function moveIdOf(choice: PlayerChoice): string | null {
  return choice.action.chosenMove?.id ?? choice.action.moveToBeUsed?.id ?? null
}

function legalMoveChoices(session: BattleSession): PlayerChoice[] {
  return legalChoices(session).filter((choice) => choice.action.action === 'USE_MOVE')
}

// ---------------------------------------------------------------------------
// Damage ranges against a substituted reserve mon
// ---------------------------------------------------------------------------

/** `PokemonToBattleMon`'s shape for a reserve as `AI_CalcPartyMonDamage` builds
 * it (aiCalcDamage.ts:588-618): every field a SimPartyMon carries except
 * status2, which is cleared on switch out. */
function battleMonFromReserve(reserve: SimPartyMon): SimBattleMon {
  return {
    speciesId: reserve.speciesId as string,
    abilityNum: reserve.abilityNum,
    rawStats: reserve.rawStats,
    moves: reserve.moves,
    pp: reserve.pp,
    hp: reserve.hp,
    maxHp: reserve.maxHp,
    itemId: reserve.itemId,
    statStages: [],
    types: reserve.types,
    level: reserve.level,
    nature: reserve.nature,
    hiddenPowerType: reserve.hiddenPowerType,
    speedDown: reserve.speedDown,
    abilities: reserve.abilities,
    gender: reserve.gender,
    status1: reserve.status1,
    status2: 0,
  }
}

/** The state with `battlerId` replaced by a fresh battler holding `reserve` --
 * the same substitution `aiCalcPartyMonDamage` performs for an ATTACKER
 * (aiCalcDamage.ts:610-616), applied to whichever side we need. */
export function stateWithReserve(
  state: BattleState,
  battlerId: number,
  reserve: SimPartyMon,
  partyIndex: number,
): BattleState {
  const existing = state.battlers[battlerId]
  const battlers = state.battlers.slice()
  battlers[battlerId] = {
    ...createBattlerState(battlerId, battleMonFromReserve(reserve), partyIndex),
    sameMoveTurns: existing?.sameMoveTurns ?? 0,
  }
  return { ...state, battlers }
}

/** Our move `moveId` (battler 0) onto their reserve `slot` (battler 1): the
 * predicted switch-in route. `ourDamageRange` cannot do this because it reads
 * the live battler 1, so the defender is substituted first. */
function rangeAgainstTheirReserve(
  session: BattleSession,
  moveId: string,
  slot: number,
): AiDamageRolls | null {
  const reserve = session.state.sides[1].party[slot]
  if (!reserve || reserve.speciesId === null || reserve.hp <= 0) return null
  const state = stateWithReserve(session.state, 1, reserve, slot)
  return aiDamageRolls(state, moveId, 0, 1, aiDamageDepsFor(session.data, state, session.inverseBattle))
}

/** Their move `moveId` (battler 1) onto our reserve `slot` (battler 0): used to
 * pick the bench mon that takes the predicted move best. */
export function rangeOnOurReserve(
  session: BattleSession,
  moveId: string,
  slot: number,
): AiDamageRolls | null {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null || reserve.hp <= 0) return null
  const state = stateWithReserve(session.state, 0, reserve, slot)
  return aiDamageRolls(state, moveId, 1, 0, aiDamageDepsFor(session.data, state, session.inverseBattle))
}

// ---------------------------------------------------------------------------
// Shared inputs
// ---------------------------------------------------------------------------

export interface PredictionView {
  /** Any sample's move removes more than `safetyPct` of our HP or KOs us. */
  threatened: boolean
  /** Any sample's move can KO us at its highest roll (the KO-only gate the
   * hazard lead uses). */
  koThreat: boolean
  /** Majority party slot when at least 2 of 3 samples switch into the same
   * slot; null otherwise. */
  switchSlot: number | null
  /** The sample move with the highest roll, else the first sample move. */
  predictedAction: ChosenAction | null
  predictedMoveId: string | null
}

/** `chooseAiAction` 3 times on clones (predictAi), then folds the samples into
 * the facts every role reads. A SWITCH sample is safe: the AI is leaving, so
 * nothing hits us this turn (decision 14). */
export function readPredictions(session: BattleSession, safetyPct: number): PredictionView {
  const samples = predictAi(session, SAMPLE_COUNT, PREDICTION_SEED)
  const ourHp = session.state.battlers[0]?.mon.hp ?? 0
  const deps = aiDamageDepsFor(session.data, session.state, session.inverseBattle)
  const switchCounts = new Map<number, number>()
  let threatened = false
  let koThreat = false
  let bestAction: ChosenAction | null = null
  let bestMoveId: string | null = null
  let bestHigh = -1
  let firstAction: ChosenAction | null = null
  let firstMoveId: string | null = null

  for (const sample of samples) {
    const action = sample.action
    if (!action) continue
    if (action.action === 'SWITCH') {
      if (sample.switchSlot !== null) {
        switchCounts.set(sample.switchSlot, (switchCounts.get(sample.switchSlot) ?? 0) + 1)
      }
      continue
    }
    if (action.action !== 'USE_MOVE') continue
    const moveId = action.chosenMove?.id ?? action.moveToBeUsed?.id ?? null
    if (!moveId) continue
    if (firstAction === null) {
      firstAction = action
      firstMoveId = moveId
    }
    const range = aiDamageRolls(session.state, moveId, 1, 0, deps)
    if (!range || range.isImmune) continue
    const high = highestRoll(range)
    if (high >= ourHp) koThreat = true
    if (high >= ourHp || high * 100 > safetyPct * ourHp) threatened = true
    if (high > bestHigh) {
      bestHigh = high
      bestAction = action
      bestMoveId = moveId
    }
  }

  let switchSlot: number | null = null
  for (const [slot, count] of switchCounts) {
    if (count >= 2) switchSlot = slot
  }

  return {
    threatened,
    koThreat,
    switchSlot,
    predictedAction: bestAction ?? firstAction,
    predictedMoveId: bestMoveId ?? firstMoveId,
  }
}

/** The party slot damage choices target: the predicted switch-in when a
 * majority of samples switch into a live reserve, else null (the active
 * battler 1). */
function resolveTargetSlot(session: BattleSession, switchSlot: number | null): number | null {
  if (switchSlot === null) return null
  const reserve = session.state.sides[1].party[switchSlot]
  if (!reserve || reserve.speciesId === null || reserve.hp <= 0) return null
  return switchSlot
}

function targetHp(session: BattleSession, targetSlot: number | null): number {
  if (targetSlot === null) return session.state.battlers[1]?.mon.hp ?? 0
  return session.state.sides[1].party[targetSlot]?.hp ?? 0
}

/** `getWhoStrikesFirst` on a fresh clone: a speed tie draws RNG, so the real
 * session's generator must never move. battler 0 first == return 0. */
export function outspeeds(
  session: BattleSession,
  ourAction: ChosenAction,
  theirAction: ChosenAction | null,
): boolean {
  if (!theirAction) return true
  const probe = cloneSession(session, SPEED_PROBE_SEED)
  const ctx = buildTurnOrderContext(probe.state, probe.turnDeps)
  return (
    getWhoStrikesFirst(probe.state, 0, 1, [ourAction, theirAction], false, ctx, probe.data.statStageRatios) === 0
  )
}

export interface MoveChoiceInfo {
  choice: PlayerChoice
  moveId: string
  range: AiDamageRolls | null
  /** moves.json's declared priority (getMovePriority's base, turnOrder.ts:513-519). */
  priority: number
  accuracy: number
}

export function evaluateMoves(session: BattleSession, targetSlot: number | null): MoveChoiceInfo[] {
  return legalMoveChoices(session).map((choice) => {
    const moveId = moveIdOf(choice) ?? ''
    const range =
      moveId === ''
        ? null
        : targetSlot === null
          ? ourDamageRange(session, moveId, 0, 1)
          : rangeAgainstTheirReserve(session, moveId, targetSlot)
    return {
      choice,
      moveId,
      range,
      priority: moveId === '' ? 0 : (session.data.dataContext.move(moveId)?.priority ?? 0),
      accuracy: moveId === '' ? 100 : accuracyPct(session, moveId),
    }
  })
}

/** mean damage x accuracy/100 (MODEL CHOICE: the attacker's fallback ranking). */
function accuracyWeightedDamage(info: MoveChoiceInfo): number {
  if (!info.range || info.range.isImmune) return 0
  return meanRoll(info.range) * (info.accuracy / 100)
}

export function bestByDamage(pool: MoveChoiceInfo[]): MoveChoiceInfo {
  let best = pool[0]!
  let bestValue = accuracyWeightedDamage(best)
  for (const info of pool) {
    const value = accuracyWeightedDamage(info)
    if (value > bestValue) {
      best = info
      bestValue = value
    }
  }
  return best
}

function bestByLowestRoll(pool: MoveChoiceInfo[]): MoveChoiceInfo {
  let best = pool[0]!
  let bestRoll = lowestRoll(best.range!)
  for (const info of pool) {
    const roll = lowestRoll(info.range!)
    if (roll > bestRoll) {
      best = info
      bestRoll = roll
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Set-up sweeper inputs (decision 14)
// ---------------------------------------------------------------------------

/** Effects that make the opponent able to undo our boosts: Haze resets every
 * stage, Roar/Whirlwind and the hit-and-switch moves drag us out. Matched by
 * moves.json `effect` rather than a name list, so a repointed move id is
 * followed. Verified in data/v2.65beta/moves.json: MOVE_HAZE EFFECT_HAZE,
 * MOVE_ROAR EFFECT_ROAR, MOVE_DRAGON_TAIL / MOVE_WHIRLWIND / MOVE_CIRCLE_THROW
 * EFFECT_HIT_SWITCH_TARGET.
 *
 * Super Fang / Ruination run Haze after the hit unless the move had no effect:
 * EFFECT_SUPER_FANG_HAZE (MOVE_NATURES_MADNESS, MOVE_RUINATION),
 * BattleScript_EffectSuperFangHaze (battle_scripts_1.s:4105-4118) -> Cmd_normalisebuffs
 * (battle_script_commands.c:9988-9994).
 * Clear Smog resets every stage of a damaged target:
 * EFFECT_CLEAR_SMOG (MOVE_CLEAR_SMOG, MOVE_ABSORB, MOVE_FORCE_PALM),
 * BattleScript_EffectClearSmog (battle_scripts_1.s:1700-1702) -> MOVE_EFFECT_CLEAR_SMOG
 * (battle_script_commands.c:2863-2870). */
const PHASE_OUT_EFFECTS: ReadonlySet<string> = new Set([
  'EFFECT_HAZE',
  'EFFECT_ROAR',
  'EFFECT_HIT_SWITCH_TARGET',
  'EFFECT_SUPER_FANG_HAZE',
  'EFFECT_CLEAR_SMOG',
])

/** Abilities with `bitfields.unaware` set in data/v2.65beta/abilityHooks.json --
 * the same four moveEffects.ts's IsUnaware scan lists (`IsUnaware`,
 * battle_util.c:9006-9009). An Unaware opponent ignores our stages, so a boost
 * is wasted. Read off the party mon's `abilities` (AbilitySlots: chosen slot 0
 * plus the three innates), which is where SimPartyMon keeps them
 * (state.ts:450). */
const UNAWARE_ABILITIES: readonly string[] = [
  'ABILITY_CONTEMPT',
  'ABILITY_LEPIDOPTERAN',
  'ABILITY_SWORD_OF_DAMNATION',
  'ABILITY_UNAWARE',
]

/** A self-boost move's effect -> the stats its handler raises, with the battle
 * script that sets `setstatchanger` (data/battle_scripts_1.s). Only rows whose
 * handler in moveEffects.ts was read. The sweeper counts only STAT_ATK, STAT_SPATK
 * and STAT_SPEED; the other entries are here so the map stays a faithful record. */
const SELF_BOOST_EFFECTS: Readonly<Record<string, readonly number[]>> = {
  // BattleScript_EffectAttackUp / AttackUp2 / SpecialAttackUp(2/3) / SpeedUp(2).
  EFFECT_ATTACK_UP: [STAT_ATK],
  EFFECT_ATTACK_UP_2: [STAT_ATK],
  EFFECT_SPECIAL_ATTACK_UP: [STAT_SPATK],
  EFFECT_SPECIAL_ATTACK_UP_2: [STAT_SPATK],
  EFFECT_SPECIAL_ATTACK_UP_3: [STAT_SPATK],
  EFFECT_SPEED_UP: [STAT_SPEED],
  EFFECT_SPEED_UP_2: [STAT_SPEED],
  // BattleScript_EffectBellyDrum (battle_scripts_1.s:5592-5604; Cmd_maxattackhalvehp, battle_script_commands.c:11338-11354).
  EFFECT_BELLY_DRUM: [STAT_ATK],
  // BattleScript_EffectSharpen (battle_scripts_1.s:12008-12046; GetHighestAttackingStatId, battle_script_commands.c:8159-8170).
  EFFECT_SHARPEN: [STAT_ATK, STAT_SPATK],
  // BattleScript_EffectKarma (battle_scripts_1.s:4989 onwards): Speed -1, Sp. Atk +1, Sp. Def +1.
  EFFECT_KARMA: [STAT_SPATK, STAT_SPDEF],
  // BattleScript_EffectCurse (battle_scripts_1.s:4928-4960): Speed -1, Attack +1, Defense +1 (non-Ghost branch).
  EFFECT_CURSE: [STAT_ATK, STAT_DEF],
  // BattleScript_EffectBulkUp (battle_scripts_1.s:6670-6693).
  EFFECT_BULK_UP: [STAT_ATK, STAT_DEF],
  // BattleScript_EffectCoil (:2019-2061).
  EFFECT_COIL: [STAT_ATK, STAT_DEF, STAT_ACC],
  // BattleScript_EffectCalmMind (:6739-6763).
  EFFECT_CALM_MIND: [STAT_SPATK, STAT_SPDEF],
  // BattleScript_EffectDragonDance (:6817-6836).
  EFFECT_DRAGON_DANCE: [STAT_ATK, STAT_SPEED],
  // BattleScript_EffectQuiverDance (:2063-2093).
  EFFECT_QUIVER_DANCE: [STAT_SPATK, STAT_SPDEF, STAT_SPEED],
  // BattleScript_EffectVictoryDance (:2095-2125).
  EFFECT_VICTORY_DANCE: [STAT_ATK, STAT_DEF, STAT_SPEED],
  // BattleScript_EffectMysticDance (:6773-6797).
  EFFECT_MYSTIC_DANCE: [STAT_SPATK, STAT_SPEED],
  // BattleScript_EffectAttackUpUserAlly (:34-69): Attack (partner too in doubles).
  EFFECT_HOWL: [STAT_ATK],
  // BattleScript_EffectMeditate (:6714-6737).
  EFFECT_MEDITATE: [STAT_ATK, STAT_SPDEF],
  // BattleScript_EffectAttackAccUp (:2167-2190).
  EFFECT_ATTACK_ACCURACY_UP: [STAT_ATK, STAT_ACC],
  // BattleScript_EffectAttackSpAttackUp (:2142-2165).
  EFFECT_ATTACK_SPATK_UP: [STAT_ATK, STAT_SPATK],
  // BattleScript_EffectShiftGear (:1988-2017): Speed +2 (or +1 above stage 10), Attack +1.
  EFFECT_SHIFT_GEAR: [STAT_SPEED, STAT_ATK],
  // BattleScript_EffectGrowth (:1912-1946): +1 each, +2 in sun.
  EFFECT_GROWTH: [STAT_ATK, STAT_SPATK],
  // BattleScript_EffectShellSmash (:1800-1846): also lowers Def/SpDef, which do not count.
  EFFECT_SHELL_SMASH: [STAT_ATK, STAT_SPATK, STAT_SPEED],
  // BattleScript_EffectGeomancy (:4455-4494).
  EFFECT_GEOMANCY: [STAT_SPATK, STAT_SPDEF, STAT_SPEED],
  // BattleScript_EffectTakeHeart (:6695-6712).
  EFFECT_TAKE_HEART: [STAT_SPATK, STAT_SPDEF],
  // BattleScript_EffectClangorousSoul (:245-257) -> BattleScript_AllStatsUp (:7891-7925).
  EFFECT_CLANGOROUS_SOUL: [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF],
  // BattleScript_EffectFilletAway (:5606-5642).
  EFFECT_FILLET_AWAY: [STAT_ATK, STAT_SPATK, STAT_SPEED],
  // BattleScript_EffectNoRetreat (:338-354) -> BattleScript_AllStatsUp (:7891-7925).
  EFFECT_NO_RETREAT: [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF],
  // BattleScript_EffectTidyUp (:5440-5465).
  EFFECT_TIDY_UP: [STAT_ATK, STAT_SPEED],
}

/** The stats that count toward the sweeper's stage: Attack, Sp. Atk, Speed
 * (decision 14). The Def / Sp. Def / accuracy entries above are informational. */
function isCountingStat(stat: number): boolean {
  return stat === STAT_ATK || stat === STAT_SPATK || stat === STAT_SPEED
}

/** Ghost-branch Curse check: BattleScript_EffectCurse (battle_scripts_1.s:4928-4930)
 * jumps to GhostCurse when the attacker is Ghost type or fog is effective on it. */
function isGhostCurseUser(session: BattleSession): boolean {
  const mon = session.state.battlers[0]?.mon
  return (
    (mon?.types.includes('GHOST') ?? false) ||
    isBattlerWeatherAffected(
      session.state,
      0,
      WEATHER_FOG_ANY,
      aiDamageDepsFor(session.data, session.state, session.inverseBattle),
    )
  )
}

/** The counting stats a self-boost move raises, or null when it is not a
 * self-boost move. */
export function boostStatsOf(session: BattleSession, moveId: string): readonly number[] | null {
  const move = session.data.dataContext.move(moveId)
  if (!move || move.split !== 'STATUS') return null
  if (move.effect === 'EFFECT_CURSE') {
    if (isGhostCurseUser(session)) return null
  } else if (move.target !== 'USER') {
    return null
  }
  const stats = move.effect ? SELF_BOOST_EFFECTS[move.effect] : undefined
  return stats ? stats.filter(isCountingStat) : null
}

// ---------------------------------------------------------------------------
// Staller inputs (decision 14)
// ---------------------------------------------------------------------------

/** Effects that set a major status and the C predicate the move's handler checks
 * before it can (`CanBePoisoned` battle_util.c:5042-5050, `CanBeBurned`
 * :5061-5070, `CanBeParalyzed` :5072-5080, `CanSleep` :5032-5039), all ported in
 * statusEffects.ts. Kept small on purpose: the common status moves. */
const STATUS_EFFECTS: ReadonlySet<string> = new Set([
  'EFFECT_TOXIC', // BattleScript_EffectToxic, battle_scripts_1.s:3957-3970
  'EFFECT_POISON', // BattleScript_EffectPoison, :4332-4344 (Poison Powder-family)
  'EFFECT_WILL_O_WISP', // BattleScript_EffectWillOWisp, :6090-6103
  'EFFECT_PARALYZE', // BattleScript_EffectParalyze, :4362-4376 (Thunder Wave)
  'EFFECT_PARALYZE_IGNORE_TYPE', // BattleScript_EffectParalyzeIgnoreType, :4346-4360
  'EFFECT_SLEEP', // BattleScript_EffectSleep, :3103-...
])

/** Whether `moveId`'s status effect can land on battler 1, using the same
 * CanBe* helpers the move handlers use (so type immunity -- Fire vs Will-O-Wisp,
 * Poison/Steel vs Toxic -- and an existing status are respected), plus the two
 * gates that run before them: the powder canceller
 * (CANCELLER_POWDER_MOVE, battle_util.c:3455-3466 -> IsPowderImmune :3190-3197)
 * and, for EFFECT_PARALYZE only, typecalc (battle_scripts_1.s:4366). */
export function statusMoveWorks(session: BattleSession, moveId: string, effect: string): boolean {
  if (((session.state.battlers[1]?.mon.status1 ?? 0) & STATUS1_ANY) !== 0) return false
  const deps = aiDamageDepsFor(session.data, session.state, session.inverseBattle)
  // CANCELLER_POWDER_MOVE (battle_util.c:3455-3466): a FLAG_POWDER move is
  // cancelled outright when IsPowderImmune (battle_util.c:3190-3197) holds --
  // attacker != target and no Mycelium Might on the attacker are the C's own
  // entry conditions and isPowderImmune already applies the Mycelium Might
  // bypass, matching attackCanceller.ts:580. Covers Spore, Sleep Powder,
  // Stun Spore and Poison Powder.
  if (session.data.dataContext.move(moveId)?.flags.powderAffected && isPowderImmune(session.state, 0, 1, deps)) {
    return false
  }
  switch (effect) {
    case 'EFFECT_TOXIC':
    case 'EFFECT_POISON':
      return canBePoisoned(session.state, 0, 1, moveId, deps)
    case 'EFFECT_WILL_O_WISP':
      return canBeBurned(session.state, 1, 0, deps)
    case 'EFFECT_PARALYZE': {
      // BattleScript_EffectParalyze runs typecalc (:4366) before
      // requirecandoeffect (:4367), so an Electric-type move on a Ground target
      // sets MOVE_RESULT_DOESNT_AFFECT_FOE and accuracycheck (:4369) jumps to
      // BattleScript_ButItFailed (JumpIfMoveFailed,
      // battle_script_commands.c:1213) -- the same check handleParalyze makes
      // (moveEffects.ts:2025-2028). The later `setmoveeffect MOVE_EFFECT_PARALYSIS`
      // (:4372, no ignore-type flag) re-checks CanBeParalyzed
      // (battle_script_commands.c:2506; battle_util.c:5072-5080), which
      // canBeParalyzed ports -- keeping it, not the ignore-type variant, is what
      // stops an Electric target from being reported as paralyzable.
      const target = session.state.battlers[1]
      const moveType = (session.data.dataContext.move(moveId)?.type ?? 'TYPE_ELECTRIC').replace(/^TYPE_/, '')
      if (moveType === 'ELECTRIC' && (target?.mon.types.includes('GROUND') ?? false)) return false
      return canBeParalyzed(session.state, 0, 1, deps)
    }
    case 'EFFECT_PARALYZE_IGNORE_TYPE':
      // BattleScript_EffectParalyzeIgnoreType (:4346-4360) keeps
      // MOVE_EFFECT_IGNORE_TYPE_IMMUNITIES on setmoveeffect and has no typecalc,
      // so Ground typing does not stop it.
      return canBeParalyzedIgnoreType(session.state, 0, 1, deps)
    case 'EFFECT_SLEEP':
      return canSleep(session.state, 1, 0, deps)
    default:
      return false
  }
}

/** Move effects that recover HP directly on the user, gated by chooseStaller rule 2. */
export const RECOVERY_EFFECTS: ReadonlySet<string> = new Set([
  'EFFECT_RESTORE_HP',
  'EFFECT_SOFTBOILED',
  'EFFECT_ROOST',
  'EFFECT_MORNING_SUN',
  'EFFECT_SYNTHESIS',
  'EFFECT_MOONLIGHT',
  'EFFECT_SHORE_UP',
  'EFFECT_REST',
  'EFFECT_STRENGTH_SAP',
  'EFFECT_JUNGLE_HEALING',
])

/**
 * Whether a recovery move's healing effect would succeed and heal battler 0
 * (chooseStaller rule 2).
 *
 * 1. EFFECT_RESTORE_HP (battle_scripts_1.s:3940-3955) and EFFECT_SOFTBOILED (:5909-5924):
 *    `jumpifhealingblocked` fails the move. Usable unless `isHealingBlocked`.
 *    A bleeding user cures the bleed on execution, so isHealingBlocked's STATUS1_BLEED
 *    strip allows it.
 * 2. EFFECT_ROOST (:2736-2742): MODEL CHOICE: the script does not fail, but
 *    `Cmd_tryhealhalfhealth` (battle_script_commands.c:9255-9274) zeroes the heal when
 *    `!CanBattlerHeal`, so a blocked Roost would repeat for nothing; same gate as 1.
 * 3. EFFECT_MORNING_SUN, SYNTHESIS, MOONLIGHT, SHORE_UP (:5495-5503):
 *    `Cmd_recoverbasedonsunlight` (battle_script_commands.c:11433-11462) fails only at
 *    full HP and has no heal-block check. Usable below max HP.
 * 4. EFFECT_REST (:4023-4036, Cmd_trysetrest :9415-9437, handleRest):
 *    Not usable when asleep, has Comatose, ability-protected from sleep (CHECK_SLEEP),
 *    or on Electric or Misty Terrain.
 * 5. EFFECT_STRENGTH_SAP (:896-945, handleStrengthSap):
 *    Not usable when substitute blocks or target's Attack stage is MIN_STAT_STAGE.
 * 6. EFFECT_JUNGLE_HEALING (:773-804, handleJungleHealing):
 *    Not usable when healing is blocked. Additionally MOVE_LIFE_DEW is not usable
 *    while bleeding (heals nothing under bleed and skips status cure, :791).
 */
export function recoveryMoveWorks(
  session: BattleSession,
  moveId: string,
  effect: string,
  battler: BattlerState = session.state.battlers[0]!,
  deps = aiDamageDepsFor(session.data, session.state, session.inverseBattle),
): boolean {
  if (!battler) return false
  switch (effect) {
    case 'EFFECT_RESTORE_HP':
    case 'EFFECT_SOFTBOILED':
    case 'EFFECT_ROOST':
      // BattleScript_EffectRestoreHp (battle_scripts_1.s:3940-3955) and Softboiled
      // (:5909-5924) fail via jumpifhealingblocked.
      // MODEL CHOICE: BattleScript_EffectRoost (:2736-2742) does not fail when
      // healing is blocked, but Cmd_tryhealhalfhealth (battle_script_commands.c:9255-9274)
      // zeroes the heal when !CanBattlerHeal, so a blocked Roost would repeat for nothing.
      return !isHealingBlocked(session.state, 0, battler, [], session.data.dataContext)

    case 'EFFECT_MORNING_SUN':
    case 'EFFECT_SYNTHESIS':
    case 'EFFECT_MOONLIGHT':
    case 'EFFECT_SHORE_UP':
      // BattleScript_EffectMorningSun / Synthesis / Moonlight / ShoreUp (:5495-5503)
      // -> Cmd_recoverbasedonsunlight (battle_script_commands.c:11433-11462) fails
      // only at full HP and has no heal-block check. Usable below max HP.
      return true

    case 'EFFECT_REST':
      // BattleScript_EffectRest (:4023-4036), Cmd_trysetrest (battle_script_commands.c:9415-9437),
      // sim handleRest (moveEffects.ts:5030): fails when already asleep, has Comatose,
      // ability-protected from sleep, or on Electric or Misty Terrain.
      if ((battler.mon.status1 & STATUS1_SLEEP) !== 0) return false
      if (battlerHasSimAbility(session.state, battler, 'ABILITY_COMATOSE', false, 0, false, session.data.dataContext)) {
        return false
      }
      if (isAbilityStatusProtected(session.state, 0, CHECK_SLEEP, 0, deps) !== null) {
        return false
      }
      if (isBattlerTerrainAffected(session.state, 0, STATUS_FIELD_ELECTRIC_TERRAIN, deps)) {
        return false
      }
      if (isBattlerTerrainAffected(session.state, 0, STATUS_FIELD_MISTY_TERRAIN, deps)) {
        return false
      }
      return true

    case 'EFFECT_STRENGTH_SAP':
      // BattleScript_EffectStrengthSap (:896-945), sim handleStrengthSap: fails when
      // blocked by substitute (:898) or target's Attack stage is MIN_STAT_STAGE (:903-908,
      // where the script falls through without healing).
      if (doesSubstituteBlockMove(session.state, 0, 1, moveId, deps)) {
        return false
      }
      if ((session.state.battlers[1]?.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE) === MIN_STAT_STAGE) {
        return false
      }
      return true

    case 'EFFECT_JUNGLE_HEALING':
      // BattleScript_EffectJungleHealing (:773-804), sim handleJungleHealing:
      // not usable when healing is blocked. Additionally Life Dew (script :791)
      // skips status cure and heals nothing under bleed, so it is unusable while bleeding.
      // Jungle Healing and Lunar Blessing cure the bleed, so they stay usable.
      if (isHealingBlocked(session.state, 0, battler, [], session.data.dataContext)) {
        return false
      }
      if (moveId === 'MOVE_LIFE_DEW' && (battler.mon.status1 & STATUS1_BLEED) !== 0) {
        return false
      }
      return true

    default:
      return false
  }
}

/** A protection move as ProtectSucceeds / Cmd_setprotectlike read it
 * (battle_script_commands.c:6649-6655, PROTECT_SUCCESS_RATES :727): the
 * moves.json `isProtection` flag, effect EFFECT_PROTECT, priority +4 and a
 * self target. The flag test is what excludes EFFECT_PROTECT moves that are not
 * protection -- MOVE_CRAFTY_SHIELD is effect EFFECT_PROTECT but unflagged and
 * priority 3 in the pinned snapshot. */
function isProtectionMove(session: BattleSession, moveId: string): boolean {
  const move = session.data.dataContext.move(moveId)
  return (
    !!move &&
    move.effect === 'EFFECT_PROTECT' &&
    move.flags.isProtection === true &&
    move.priority === 4 &&
    move.target === 'USER'
  )
}

/** ProtectSucceeds's "the previous move was a protection move" test
 * (battle_script_commands.c:6649-6655): matches the sim's `handleProtect`
 * by reading `battlers[0].lastMove` (falling back to memory.lastMove when null)
 * and testing the `isProtection` flag. */
function usedProtectionLastTurn(session: BattleSession, memory: RoleMemory): boolean {
  const battlerLastMove = session.state.battlers[0]?.lastMove ?? null
  const lastMove = battlerLastMove !== null ? battlerLastMove : memory.lastMove
  if (!lastMove) return false
  return session.data.dataContext.move(lastMove)?.flags.isProtection === true
}

/** Residual damage ticking on the opponent's active mon (decision 14):
 * poison/burn/Leech Seed statuses3/status2 bits. */
function targetHasResidual(session: BattleSession): boolean {
  const target = session.state.battlers[1]
  if (!target) return false
  return (
    (target.mon.status1 & STATUS1_POISON_ANY) !== 0 ||
    (target.mon.status1 & STATUS1_BURN) !== 0 ||
    (target.statuses3 & STATUS3_LEECHSEED) !== 0 ||
    (target.mon.status2 & STATUS2_CURSED) !== 0 ||
    (target.mon.status2 & STATUS2_NIGHTMARE) !== 0
  )
}

// ---------------------------------------------------------------------------
// Support inputs (decision 14)
// ---------------------------------------------------------------------------

/** The screens, in the rule's priority order. The side status bit lives on
 * `state.sides[0]` (constants.ts:279-288, state.ts:509-525). */
const SCREEN_EFFECTS: readonly {
  effect: string
  up: (session: BattleSession) => boolean
}[] = [
  {
    effect: 'EFFECT_REFLECT', // handleReflect, moveEffects.ts:2940-2968
    up: (s) => (s.state.sides[0].statuses & SIDE_STATUS_REFLECT) !== 0,
  },
  {
    effect: 'EFFECT_LIGHT_SCREEN', // handleLightScreen, moveEffects.ts:2970-2998
    up: (s) => (s.state.sides[0].statuses & SIDE_STATUS_LIGHTSCREEN) !== 0,
  },
  {
    effect: 'EFFECT_AURORA_VEIL', // handleAuroraVeil, moveEffects.ts:3000-3028
    up: (s) => (s.state.sides[0].statuses & SIDE_STATUS_AURORA_VEIL) !== 0,
  },
]

/** The four weather moves, keyed by the `*_ANY` mask of the weather they set
 * (constants.ts:338-360), with the shared `field.weatherDuration` countdown. */
const WEATHER_EFFECTS: readonly { effect: string; mask: number }[] = [
  { effect: 'EFFECT_RAIN_DANCE', mask: WEATHER_RAIN_ANY }, // handleRainDance, moveEffects.ts:3344
  { effect: 'EFFECT_SUNNY_DAY', mask: WEATHER_SUN_ANY }, // handleSunnyDay, :3354
  { effect: 'EFFECT_SANDSTORM', mask: WEATHER_SANDSTORM_ANY }, // handleSandstorm, :3364
  { effect: 'EFFECT_HAIL', mask: WEATHER_HAIL_ANY }, // handleHail, :3374
]

/** The five terrains and their `STATUS_FIELD_*_TERRAIN` bits (constants.ts:
 * 313-326), sharing `field.timers.terrainTimer`. */
const TERRAIN_EFFECTS: readonly { effect: string; flag: number }[] = [
  { effect: 'EFFECT_ELECTRIC_TERRAIN', flag: STATUS_FIELD_ELECTRIC_TERRAIN }, // handleElectricTerrain, moveEffects.ts:3418
  { effect: 'EFFECT_GRASSY_TERRAIN', flag: STATUS_FIELD_GRASSY_TERRAIN }, // handleGrassyTerrain, :3422
  { effect: 'EFFECT_MISTY_TERRAIN', flag: STATUS_FIELD_MISTY_TERRAIN }, // handleMistyTerrain, :3426
  { effect: 'EFFECT_PSYCHIC_TERRAIN', flag: STATUS_FIELD_PSYCHIC_TERRAIN }, // handlePsychicTerrain, :3430
  { effect: 'EFFECT_TOXIC_TERRAIN', flag: STATUS_FIELD_TOXIC_TERRAIN }, // handleToxicTerrain, :3434
]

/** handleAuroraVeil's weather gate: it also fails when it is not hailing and
 * the user lacks Aurora Borealis (moveEffects.ts:3014). */
function auroraVeilWorks(session: BattleSession): boolean {
  if (isBattlerWeatherAffected(session.state, 0, WEATHER_HAIL_ANY, {
    dataContext: session.data.dataContext,
    grounding: session.turnDeps.grounding,
  })) {
    return true
  }
  const battler = session.state.battlers[0]
  return (
    !!battler &&
    battlerHasSimAbility(session.state, battler, 'ABILITY_AURORA_BOREALIS', false, 0, false, session.data.dataContext)
  )
}

/** applyWeatherMove's gates: `checkprimalweather` ends the move with no change
 * while a primal weather is up (moveEffects.ts:3334-3338, unconditional), and
 * TryChangeBattleWeather fails when weather has no effect at all
 * (switchInAbility.ts:417-420, `weatherHasEffect` -- Cloud Nine / Air Lock). */
function weatherMoveWorks(session: BattleSession): boolean {
  if ((session.state.field.weather & WEATHER_PRIMAL_ANY) !== 0) return false
  return weatherHasEffect(session.state, session.turnDeps.grounding)
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

interface RoleDecision {
  choice: PlayerChoice
  /** Short trace tag, e.g. 'fakeout', 'ko', 'pivot'. */
  tag: string
  /** An optional tag appended after `tag` (the lead/hazard fallback shows the
   * delegated role's own tag, e.g. ['leadHazard', 'staller', 'status']). */
  subTag?: string
}

/** attacker: Fake Out on its first turn in; else a guaranteed KO (a priority KO
 * first when slower and threatened); else the best accuracy-weighted damage
 * (decision 14, plan :329). Priority is only a tie-break among KO moves. */
function chooseAttacker(
  session: BattleSession,
  view: PredictionView,
  targetSlot: number | null,
  hp: number,
): RoleDecision {
  const moves = evaluateMoves(session, targetSlot)
  const active = session.state.battlers[0]

  // Fake Out gate: BattleScript_EffectFakeOut jumpifnotfirstturn
  // (data/battle_scripts_1.s:5932-5934; Cmd_jumpifnotfirstturn,
  // battle_script_commands.c:9439-9446) -- it works only while the user's own
  // isFirstTurn is nonzero. The type-immunity case rides on the range's
  // isImmune.
  if (active && active.volatiles.isFirstTurn) {
    const fakeOut = moves.find((info) => info.moveId === MOVE_FAKE_OUT && info.range && !info.range.isImmune)
    if (fakeOut) return { choice: fakeOut.choice, tag: 'fakeout' }
  }

  // A guaranteed KO needs the lowest roll to finish the target.
  const kos = moves.filter((info) => info.range && !info.range.isImmune && guaranteedKo(info.range, hp))
  if (kos.length > 0) {
    const faster = kos.filter((info) => outspeeds(session, info.choice.action, view.predictedAction))
    const pool = faster.length > 0 ? faster : kos
    return { choice: bestByLowestRoll(pool).choice, tag: 'ko' }
  }

  const damaging = moves.filter((info) => hasDamage(info.range))
  if (damaging.length > 0) return { choice: bestByDamage(damaging).choice, tag: 'damage' }

  const fallback = moves[0]?.choice ?? legalChoices(session)[0]
  if (!fallback) throw new Error('chooseRoleAction: no legal choice for battler 0')
  return { choice: fallback, tag: 'first' }
}

/** The bench slot that takes the least of the predicted move's highest roll,
 * or null when there is no living reserve. Singles: the only active slot is
 * battler 0's partyIndex. */
export function pickBenchSlot(session: BattleSession, predictedMoveId: string | null): number | null {
  const party = session.state.sides[0].party
  const activeSlot = session.state.battlers[0]?.partyIndex ?? 0
  const living: number[] = []
  for (let slot = 0; slot < party.length; slot++) {
    const mon = party[slot]
    if (mon && mon.speciesId !== null && mon.hp > 0 && slot !== activeSlot) living.push(slot)
  }
  if (living.length === 0) return null
  if (!predictedMoveId) return living[0]!
  let best = living[0]!
  let bestHigh = Infinity
  for (const slot of living) {
    const range = rangeOnOurReserve(session, predictedMoveId, slot)
    const high = range && !range.isImmune ? highestRoll(range) : 0
    if (high < bestHigh) {
      bestHigh = high
      best = slot
    }
  }
  return best
}

/** pivot: on a bad matchup (threatened, or unable to damage the target) use the
 * first pivot move that can really switch -- a HIT_ESCAPE whose damage lands,
 * Shed Tail past its own gates, and any of them with a live bench slot -- into
 * the bench mon that takes the predicted move best; else play as attacker
 * (decision 14). */
function choosePivot(
  session: BattleSession,
  view: PredictionView,
  targetSlot: number | null,
  hp: number,
  params: RoleParams,
): RoleDecision {
  const moves = evaluateMoves(session, targetSlot)
  const canDamage = moves.some((info) => dealsDamage(info.range))
  const badMatchup = params.badMatchup ?? 'either'
  const threatenedGate = badMatchup !== 'noDamage' && view.threatened
  const noDamageGate = badMatchup !== 'threatened' && !canDamage
  if (threatenedGate || noDamageGate) {
    // Every pivot script ends in a can-switch test: HIT_ESCAPE skips the switch
    // on jumpifmovehadnoeffect (:2788), BattleScript_DoMoveSwitch's
    // jumpifcantswitch (:5379) covers the rest, Baton Pass / Teleport fail
    // outright (:5271), Shed Tail fails on HP or a substitute (:5356-5358).
    // A failing first pivot must not hide a working second one, so scan in
    // pivotMoves order.
    const bench = pickBenchSlot(session, view.predictedMoveId)
    if (bench !== null) {
      for (const id of pivotMoves(session.data)) {
        const pivot = moves.find((info) => info.moveId === id)
        if (!pivot) continue
        const effect = session.data.dataContext.move(id)?.effect ?? null
        if (!pivotSwitchWorks(session, pivot, effect, targetSlot)) continue
        // Baton Pass and the escape moves read monToSwitchIntoId (turn.ts:1864);
        // playPolicyBattle writes it from the choice's switchTo before stepTurn.
        return { choice: { ...pivot.choice, switchTo: bench }, tag: 'pivot' }
      }
    }
  }
  return chooseAttacker(session, view, targetSlot, hp)
}

/** The current layer count on the OPPOSING side (we lay hazards on sides[1]).
 * Stealth Rock's presence is the side status bit; its ER type lives in
 * `timers.stealthRockType` (state.ts:520-524). */
function hazardCount(session: BattleSession, effect: string): number {
  const side = session.state.sides[1]
  switch (effect) {
    case 'EFFECT_SPIKES':
      return side.timers.spikesAmount
    case 'EFFECT_TOXIC_SPIKES':
      return side.timers.toxicSpikesAmount
    case 'EFFECT_STEALTH_ROCK':
      return (side.statuses & SIDE_STATUS_STEALTH_ROCK) !== 0 ? 1 : 0
    default:
      return 0
  }
}

/** The highest of our Attack, Sp. Atk and Speed stages relative to neutral.
 * statStages[] stores the C's internal 0..12 with 6 neutral (constants.ts:63;
 * STAT_ATK = 1, STAT_SPEED = 3, STAT_SPATK = 4, constants.ts:46-49). */
function currentBoostStage(session: BattleSession): number {
  const mon = session.state.battlers[0]?.mon
  if (!mon) return 0
  const stages = (stat: number) => (mon.statStages[stat] ?? DEFAULT_STAT_STAGE) - DEFAULT_STAT_STAGE
  return Math.max(stages(STAT_ATK), stages(STAT_SPATK), stages(STAT_SPEED))
}

/** True when any live opponent party mon can undo our stages: a Haze or
 * phazing move, or an Unaware slot. The opposing movesets are visible
 * (SimPartyMon.moves is Slot4<string | null>, state.ts:447). */
function opponentCanUndoBoosts(session: BattleSession): boolean {
  for (const mon of session.state.sides[1].party) {
    if (!mon || mon.speciesId === null || mon.hp <= 0) continue
    for (const moveId of mon.moves) {
      if (!moveId) continue
      const effect = session.data.dataContext.move(moveId)?.effect
      if (effect && PHASE_OUT_EFFECTS.has(effect)) return true
    }
    for (const ability of [mon.abilities.ability, ...mon.abilities.innates]) {
      if (ability && UNAWARE_ABILITIES.includes(ability)) return true
    }
  }
  return false
}

/** Whether a move is a usable self-boost for set-up or Baton Pass. */
function isUsableBoostMove(session: BattleSession, info: MoveChoiceInfo): boolean {
  if (!info.moveId) return false
  const stats = boostStatsOf(session, info.moveId)
  if (!stats || stats.length === 0) return false
  const mon = session.state.battlers[0]?.mon
  if (!mon) return false
  // The handler fails when every stat it raises is already MAX_STAT_STAGE
  // (BattleScript_EffectStatUp's jumpifstat check); don't pick such a move.
  if (!stats.some((stat) => (mon.statStages[stat] ?? DEFAULT_STAT_STAGE) < MAX_STAT_STAGE)) {
    return false
  }
  // Cmd_maxattackhalvehp (battle_script_commands.c:11338-11354; handleBellyDrum
  // moveEffects.ts:1698-1700): Belly Drum fails when current HP <= maxHp / 2.
  const move = session.data.dataContext.move(info.moveId)
  if (move?.effect === 'EFFECT_BELLY_DRUM') {
    const halfHp = Math.max(1, Math.floor(mon.maxHp / 2))
    if (mon.hp <= halfHp) return false
  }
  return true
}

/** setupSweeper: while below the target stage, safe (no sample threatens) and
 * the opponent cannot undo the boost, use a legal self-boost move; else play as
 * attacker (decision 14). */
function chooseSetupSweeper(
  session: BattleSession,
  view: PredictionView,
  targetSlot: number | null,
  hp: number,
  params: RoleParams,
): RoleDecision {
  const targetStage = params.targetStage ?? DEFAULT_TARGET_STAGE
  if (!view.threatened && !opponentCanUndoBoosts(session) && currentBoostStage(session) < targetStage) {
    const moves = evaluateMoves(session, targetSlot)
    const boost = moves.find((info) => isUsableBoostMove(session, info))
    if (boost) return { choice: boost.choice, tag: 'setup' }
  }
  return chooseAttacker(session, view, targetSlot, hp)
}

/** leadHazard: lay hazards while below the target layers and not threatened
 * with a KO; then play the fallback role (decision 14). */
function chooseLeadHazard(
  session: BattleSession,
  view: PredictionView,
  targetSlot: number | null,
  hp: number,
  params: RoleParams,
  memory: RoleMemory,
  _trace: PolicyTraceEntry[] | undefined,
): RoleDecision {
  if (!view.koThreat) {
    const moves = evaluateMoves(session, targetSlot)
    const targetLayers = params.targetLayers ?? 1
    for (const hazard of HAZARD_EFFECTS) {
      const target = Math.min(targetLayers, hazard.max)
      if (hazardCount(session, hazard.effect) >= target) continue
      const move = moves.find(
        (info) => info.moveId !== '' && session.data.dataContext.move(info.moveId)?.effect === hazard.effect,
      )
      if (move) return { choice: move.choice, tag: 'hazard' }
    }
  }
  if ((params.fallbackRole ?? 'attacker') === 'staller') {
    const staller = chooseStaller(session, view, targetSlot, hp, params, memory)
    return { choice: staller.choice, tag: 'staller', subTag: staller.tag }
  }
  return chooseAttacker(session, view, targetSlot, hp)
}

/** staller: status the target when it has none; heal below the threshold
 * (recovery, or Wish then Protect); Protect while residual damage ticks; else a
 * residual or damaging move (decision 14). */
function chooseStaller(
  session: BattleSession,
  view: PredictionView,
  targetSlot: number | null,
  hp: number,
  params: RoleParams,
  memory: RoleMemory,
): RoleDecision {
  const moves = evaluateMoves(session, targetSlot)
  const findEffect = (effect: string): MoveChoiceInfo | undefined =>
    moves.find((info) => info.moveId !== '' && session.data.dataContext.move(info.moveId)?.effect === effect)
  const findProtect = (): MoveChoiceInfo | undefined =>
    moves.find((info) => info.moveId !== '' && isProtectionMove(session, info.moveId))

  // 1. Status the target when it has none and the move works on it. Skipped
  //    when a sample can KO us: a status move would not save the turn then.
  if (!view.koThreat) {
    for (const info of moves) {
      if (!info.moveId) continue
      const effect = session.data.dataContext.move(info.moveId)?.effect ?? null
      if (effect && STATUS_EFFECTS.has(effect) && statusMoveWorks(session, info.moveId, effect)) {
        return { choice: info.choice, tag: 'status' }
      }
    }
  }

  // 2. Heal below the threshold.
  const battler = session.state.battlers[0]
  const mon = battler?.mon
  const healThreshold = params.healThreshold ?? DEFAULT_HEAL_THRESHOLD
  if (battler && mon && mon.hp * 100 < healThreshold * mon.maxHp) {
    const deps = aiDamageDepsFor(session.data, session.state, session.inverseBattle)
    let restChoice: MoveChoiceInfo | undefined
    for (const info of moves) {
      if (!info.moveId) continue
      const effect = session.data.dataContext.move(info.moveId)?.effect ?? null
      if (!effect || !RECOVERY_EFFECTS.has(effect) || !recoveryMoveWorks(session, info.moveId, effect, battler, deps)) {
        continue
      }
      if (effect === 'EFFECT_REST') {
        // MODEL CHOICE: Rest puts the user to sleep for 3 turns, so choose it
        // only when no other usable recovery move exists.
        if (!restChoice) restChoice = info
      } else {
        return { choice: info.choice, tag: 'heal' }
      }
    }
    if (restChoice) {
      return { choice: restChoice.choice, tag: 'heal' }
    }
    // Wish: BattleScript_EffectWish, :6306-6313. Cmd_trywish case 0 fails
    // while wishCounter != 0 (battle_script_commands.c:11784-11793).
    const wish = findEffect('EFFECT_WISH')
    const wishCounter = session.state.field.wishCounter[0] ?? 0
    if (wish && wishCounter === 0) return { choice: wish.choice, tag: 'wish' }
    // Counter 1: the Wish used last turn lands at the end of THIS turn, so
    // Protect now. The C decrements at end of turn and heals when it reaches 0
    // (battle_util.c:1946).
    if (wishCounter === 1 && !usedProtectionLastTurn(session, memory)) {
      const protect = findProtect()
      if (protect) return { choice: protect.choice, tag: 'protect' }
    }
  }

  // 3. Protect while residual damage ticks on the target and we did not protect
  //    last turn (ProtectSucceeds, battle_script_commands.c:6649-6655).
  if (!usedProtectionLastTurn(session, memory) && targetHasResidual(session)) {
    const protect = findProtect()
    if (protect) return { choice: protect.choice, tag: 'protect' }
  }

  // 4. Residual, else damaging. Leech Seed fails on a Grass target or when
  //    already seeded (handleLeechSeed, battle_scripts_1.s:4579-4590); Curse
  //    takes its Ghost branch when the attacker is Ghost OR fog is effective on
  //    it (BattleScript_EffectCurse, :4928-4930:
  //    `jumpiftype BS_ATTACKER, TYPE_GHOST` then
  //    `jumpifweatheraffected BS_ATTACKER, WEATHER_FOG_ANY`), and that branch
  //    sets STATUS2_CURSED on a target that lacks it (Cmd_cursetarget,
  //    battle_script_commands.c:11103-11113). The fog test is the handler's own
  //    isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps)
  //    (moveEffects.ts:3806), so Cloud Nine / Air Lock via grounding is respected.
  const target = session.state.battlers[1]
  if (target) {
    const leechSeed = findEffect('EFFECT_LEECH_SEED')
    if (leechSeed && (target.statuses3 & STATUS3_LEECHSEED) === 0 && !target.mon.types.includes('GRASS')) {
      return { choice: leechSeed.choice, tag: 'residual' }
    }
    const curse = findEffect('EFFECT_CURSE')
    if (curse && (target.mon.status2 & STATUS2_CURSED) === 0) {
      if (isGhostCurseUser(session)) return { choice: curse.choice, tag: 'residual' }
    }
  }

  return chooseAttacker(session, view, targetSlot, hp)
}

/** The support's first effect to set, in decision 14's priority order:
 * screens, weather, terrain, Trick Room. Null when every effect is already up. */
function chooseSupportSetter(
  session: BattleSession,
  moves: MoveChoiceInfo[],
  view: PredictionView,
): RoleDecision | null {
  const findMove = (effect: string): MoveChoiceInfo | undefined =>
    moves.find((info) => info.moveId !== '' && session.data.dataContext.move(info.moveId)?.effect === effect)

  for (const row of SCREEN_EFFECTS) {
    const move = findMove(row.effect)
    if (!move) continue
    const up = row.up(session)
    // Never pick Aurora Veil when it would fail without hail / Aurora Borealis
    // (moveEffects.ts:3014). The other screens have no such condition.
    if (row.effect === 'EFFECT_AURORA_VEIL' && !auroraVeilWorks(session)) continue
    if (!up) return { choice: move.choice, tag: 'screen' }
  }

  if (weatherMoveWorks(session)) {
    for (const row of WEATHER_EFFECTS) {
      const move = findMove(row.effect)
      if (!move) continue
      const up = (session.state.field.weather & row.mask) !== 0
      if (!up) return { choice: move.choice, tag: 'weather' }
    }
  }

  for (const row of TERRAIN_EFFECTS) {
    const move = findMove(row.effect)
    if (!move) continue
    const up = (session.state.field.statuses & row.flag) !== 0
    if (!up) return { choice: move.choice, tag: 'terrain' }
  }

  const trickRoom = findMove('EFFECT_TRICK_ROOM')
  if (trickRoom) {
    const up = (session.state.field.statuses & STATUS_FIELD_TRICK_ROOM) !== 0
    // Never re-cast while up: handleRoomMove toggles it OFF (moveEffects.ts:
    // 3461-3475). Trick Room helps the slower side, so set it only when we are
    // slower. Trick Room is priority -7 in the pinned snapshot (moves.json), so
    // its own action always orders last; compare RAW speed with a
    // neutral-priority view of the action, the same way chooseAttacker's KO
    // tie-break reads "outspeeds".
    const neutral = trickRoom.choice.action.chosenMove
      ? { ...trickRoom.choice.action, chosenMove: { ...trickRoom.choice.action.chosenMove, priority: 0 } }
      : trickRoom.choice.action
    if (!up && !outspeeds(session, neutral, view.predictedAction)) {
      return { choice: trickRoom.choice, tag: 'trickroom' }
    }
  }

  return null
}

/** Whether the support role still has a field or side effect to set from this
 * position: the role's own setter rule (`chooseSupportSetter`) picks something.
 * The team layer's bring-in-support purpose uses this instead of copying the
 * "effect is up" logic (teamLayer.ts).
 *
 * Only the screens, weather, terrain and Trick Room count. The Baton Pass
 * own-boost set-up is deliberately excluded (only the setter rule runs): a
 * freshly switched-in mon always starts at stage 0, so counting its own boosts
 * as a pending effect would pull it in forever. MODEL CHOICE, not a game fact. */
export function supportEffectPending(session: BattleSession, view: PredictionView): boolean {
  return chooseSupportSetter(session, evaluateMoves(session, null), view) !== null
}

/** Own boosts for Baton Pass: while below the target stage, safe (the
 * setupSweeper's gate) and able to pass to a live bench slot, use a legal
 * self-boost move. Once at the target stage the pivot hand-off below carries
 * the stages across with Baton Pass (turn.ts:1905-1930, handleBatonPass
 * moveEffects.ts:10437+). */
function chooseBatonPassSetup(
  session: BattleSession,
  view: PredictionView,
  moves: MoveChoiceInfo[],
  params: RoleParams,
): RoleDecision | null {
  const batonPass = moves.find(
    (info) => info.moveId !== '' && session.data.dataContext.move(info.moveId)?.effect === 'EFFECT_BATON_PASS',
  )
  if (!batonPass) return null
  // Both the boost and the pass need a living bench slot to pass into.
  if (pickBenchSlot(session, view.predictedMoveId) === null) return null
  const targetStage = params.targetStage ?? DEFAULT_TARGET_STAGE
  if (view.threatened || opponentCanUndoBoosts(session) || currentBoostStage(session) >= targetStage) return null
  const boost = moves.find((info) => isUsableBoostMove(session, info))
  return boost ? { choice: boost.choice, tag: 'setup' } : null
}

/** The can-switch gate for a pivot move across teamLayer, choosePivot and chooseSupport:
 * - EFFECT_HIT_ESCAPE only queues its switch after dealing HP damage (turn.ts:4798-4803,
 *   `sumHpDealt > 0`), so an immune range fails to switch.
 * - EFFECT_SHED_TAIL fails when STATUS2_SUBSTITUTE is already set (battle_scripts_1.s:5356)
 *   or hp <= max(1, floor(maxHp / 2)) (Cmd_setsubstitute, battle_script_commands.c:10535-10546).
 * - EFFECT_PARTING_SHOT fails with no switch when the target's Attack and Sp. Atk stages
 *   are both MIN_STAT_STAGE (battle_scripts_1.s:1091-1096, :6638-6643; handlePartingShot in
 *   moveEffects.ts:10845-10849). Applied only when targetSlot is null (the active battler 1);
 *   a predicted switch-in (non-null slot) enters with fresh stages.
 * - Other pivot effects switch once a live bench slot exists. */
export function pivotSwitchWorks(
  session: BattleSession,
  pivot: MoveChoiceInfo,
  effect: string | null,
  targetSlot: number | null,
): boolean {
  if (effect === 'EFFECT_HIT_ESCAPE') return !!pivot.range && !pivot.range.isImmune
  if (effect === 'EFFECT_SHED_TAIL') {
    const mon = session.state.battlers[0]?.mon
    if (!mon) return false
    return mon.hp > Math.max(1, Math.floor(mon.maxHp / 2)) && (mon.status2 & STATUS2_SUBSTITUTE) === 0
  }
  if (effect === 'EFFECT_PARTING_SHOT') {
    if (targetSlot !== null) return true
    const target = session.state.battlers[1]?.mon
    if (!target) return true
    const atkStage = target.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
    const spAtkStage = target.statStages[STAT_SPATK] ?? DEFAULT_STAT_STAGE
    if (atkStage === MIN_STAT_STAGE && spAtkStage === MIN_STAT_STAGE) return false
    return true
  }
  return true
}

/** support: set its effect when it is not up (screens, weather, terrain,
 * Trick Room, or its own boosts to pass with Baton Pass); then hand off with a
 * pivot move if it has one; without one, switch out when threatened and a
 * teammate takes the predicted move better, else play its fallback role
 * (decision 14). */
function chooseSupport(
  session: BattleSession,
  view: PredictionView,
  targetSlot: number | null,
  hp: number,
  params: RoleParams,
  memory: RoleMemory,
): RoleDecision {
  const moves = evaluateMoves(session, targetSlot)

  // 1. Set the effect.
  const setter = chooseSupportSetter(session, moves, view)
  if (setter) return setter
  const batonSetup = chooseBatonPassSetup(session, view, moves, params)
  if (batonSetup) return batonSetup

  // 2. Hand off with a pivot move once nothing is left to set. A live bench
  // slot is required; a HIT_ESCAPE pivot additionally needs its damage to land.
  const pivotId = pivotMoves(session.data).find((id) => moves.some((info) => info.moveId === id))
  if (pivotId) {
    const pivot = moves.find((info) => info.moveId === pivotId)!
    const bench = pickBenchSlot(session, view.predictedMoveId)
    const effect = session.data.dataContext.move(pivotId)?.effect ?? null
    if (bench !== null && pivotSwitchWorks(session, pivot, effect, targetSlot)) {
      return { choice: { ...pivot.choice, switchTo: bench }, tag: 'pivot' }
    }
  }

  // 3. Without a usable pivot move: a hard switch when threatened and a
  // teammate takes the predicted move better than our active mon.
  if (view.threatened && view.predictedMoveId) {
    const bench = pickBenchSlot(session, view.predictedMoveId)
    if (bench !== null) {
      const deps = aiDamageDepsFor(session.data, session.state, session.inverseBattle)
      const incoming = aiDamageRolls(session.state, view.predictedMoveId, 1, 0, deps)
      const ours = incoming && !incoming.isImmune ? highestRoll(incoming) : 0
      const benchRange = rangeOnOurReserve(session, view.predictedMoveId, bench)
      const benchHigh = benchRange && !benchRange.isImmune ? highestRoll(benchRange) : 0
      if (benchHigh < ours) {
        const switchChoice = legalChoices(session).find(
          (choice) => choice.action.action === 'SWITCH' && choice.switchTo === bench,
        )
        if (switchChoice) return { choice: switchChoice, tag: 'switch' }
      }
    }
  }

  // Fallback role, as chooseLeadHazard does (rolePolicy.ts:793-797).
  if ((params.fallbackRole ?? 'attacker') === 'staller') {
    const staller = chooseStaller(session, view, targetSlot, hp, params, memory)
    return { choice: staller.choice, tag: 'staller', subTag: staller.tag }
  }
  return chooseAttacker(session, view, targetSlot, hp)
}

function decide(
  session: BattleSession,
  role: RoleName,
  params: RoleParams,
  memory: RoleMemory,
  trace: PolicyTraceEntry[] | undefined,
): RoleDecision {
  const view = readPredictions(session, params.safetyPct ?? DEFAULT_SAFETY_PCT)
  const slot = resolveTargetSlot(session, view.switchSlot)
  const hp = targetHp(session, slot)
  switch (role) {
    case 'pivot':
      return choosePivot(session, view, slot, hp, params)
    case 'leadHazard':
      return chooseLeadHazard(session, view, slot, hp, params, memory, trace)
    case 'setupSweeper':
      return chooseSetupSweeper(session, view, slot, hp, params)
    case 'staller':
      return chooseStaller(session, view, slot, hp, params, memory)
    case 'support':
      return chooseSupport(session, view, slot, hp, params, memory)
    case 'attacker':
    default:
      return chooseAttacker(session, view, slot, hp)
  }
}

/**
 * The role's action for the player's battler 0 this turn. `role` is the role
 * for the mon on the field (`roles[session.state.battlers[0].partyIndex]`);
 * `memory` is caller-owned and persisted across turns; `trace`, when passed,
 * receives one `PolicyTraceEntry` describing the decision.
 */
export function chooseRoleAction(
  session: BattleSession,
  role: RoleName,
  params: RoleParams = {},
  memory: RoleMemory = { turn: 0, lastMove: null },
  trace?: PolicyTraceEntry[],
): PlayerChoice {
  const decision = decide(session, role, params, memory, trace)
  const moveId = moveIdOf(decision.choice)
  // turnCount is the number of COMPLETED turns (turn.ts:5774 increments it at
  // BattleTurnPassed), so the turn being decided is one past it.
  const turn = session.state.turnCount + 1
  memory.turn = turn
  memory.lastMove = moveId
  if (trace) {
    trace.push({
      turn,
      choice: `${role}:${decision.tag}${decision.subTag ? `:${decision.subTag}` : ''}${moveId ? ` ${moveId}` : ''}`,
      tags: decision.subTag ? [role, decision.tag, decision.subTag] : [role, decision.tag],
    })
  }
  return decision.choice
}
