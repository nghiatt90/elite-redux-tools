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
// safety line, accuracy weighting, the heal threshold, the refresh gene) are
// MODEL CHOICES and are marked as such.

import { createBattlerState } from '../create'
import type { AiDamageRolls } from '../ai/aiCalcDamage'
import { aiDamageRolls } from '../ai/aiCalcDamage'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
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
  STATUS1_BURN,
  STATUS1_POISON_ANY,
  STATUS2_CURSED,
  STATUS2_NIGHTMARE,
  STATUS3_LEECHSEED,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_HAIL_ANY,
  WEATHER_PRIMAL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SUN_ANY,
} from '../constants'
import { weatherHasEffect } from '../fieldEndTurn'
import type { BattleState, SimBattleMon, SimPartyMon } from '../state'
import { battlerHasSimAbility, isBattlerWeatherAffected } from '../statBuffs'
import { canBeBurned, canBeParalyzed, canBeParalyzedIgnoreType, canBePoisoned, canSleep } from '../statusEffects'
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
  /** support: re-set an effect on its last turn (timer == 1) when the handler
   * accepts the re-cast. Default 'no'. MODEL CHOICE; only the screens accept a
   * re-cast and only through Screen Cleaner (see `recastAccepted`). */
  refresh?: 'yes' | 'no'
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
 * EFFECT_HIT_SWITCH_TARGET. */
const PHASE_OUT_EFFECTS: ReadonlySet<string> = new Set([
  'EFFECT_HAZE',
  'EFFECT_ROAR',
  'EFFECT_HIT_SWITCH_TARGET',
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
 * handler in moveEffects.ts was read; moves that raise an ambiguous stat are
 * deliberately omitted (EFFECT_SHARPEN picks the user's higher attacking stat,
 * getHighestAttackingStatId). The sweeper counts only STAT_ATK, STAT_SPATK and
 * STAT_SPEED; the other entries are here so the map stays a faithful record. */
const SELF_BOOST_EFFECTS: Readonly<Record<string, readonly number[]>> = {
  // BattleScript_EffectAttackUp / AttackUp2 / SpecialAttackUp(2/3) / SpeedUp(2).
  EFFECT_ATTACK_UP: [STAT_ATK],
  EFFECT_ATTACK_UP_2: [STAT_ATK],
  EFFECT_SPECIAL_ATTACK_UP: [STAT_SPATK],
  EFFECT_SPECIAL_ATTACK_UP_2: [STAT_SPATK],
  EFFECT_SPECIAL_ATTACK_UP_3: [STAT_SPATK],
  EFFECT_SPEED_UP: [STAT_SPEED],
  EFFECT_SPEED_UP_2: [STAT_SPEED],
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

/** The counting stats a self-boost move raises, or null when it is not a
 * self-boost move. */
function boostStatsOf(session: BattleSession, moveId: string): readonly number[] | null {
  const move = session.data.dataContext.move(moveId)
  if (!move || move.split !== 'STATUS' || move.target !== 'USER') return null
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
 * Poison/Steel vs Toxic -- and an existing status are respected). */
export function statusMoveWorks(session: BattleSession, moveId: string, effect: string): boolean {
  if (((session.state.battlers[1]?.mon.status1 ?? 0) & STATUS1_ANY) !== 0) return false
  const deps = aiDamageDepsFor(session.data, session.state, session.inverseBattle)
  switch (effect) {
    case 'EFFECT_TOXIC':
    case 'EFFECT_POISON':
      return canBePoisoned(session.state, 0, 1, moveId, deps)
    case 'EFFECT_WILL_O_WISP':
      return canBeBurned(session.state, 1, 0, deps)
    case 'EFFECT_PARALYZE':
      return canBeParalyzed(session.state, 0, 1, deps)
    case 'EFFECT_PARALYZE_IGNORE_TYPE':
      return canBeParalyzedIgnoreType(session.state, 0, 1, deps)
    case 'EFFECT_SLEEP':
      return canSleep(session.state, 1, 0, deps)
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
 * (battle_script_commands.c:6649-6655): the C reads `gLastResultingMoves` and
 * the flag; the policy reads the caller's memory. `protectUses > 0` is the
 * battle state's own record that a protect already succeeded. */
function usedProtectionLastTurn(session: BattleSession, memory: RoleMemory): boolean {
  if ((session.state.battlers[0]?.volatiles.protectUses ?? 0) > 0) return true
  if (!memory.lastMove) return false
  return session.data.dataContext.move(memory.lastMove)?.flags.isProtection === true
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

/** The screens, in the rule's priority order. The side status bit and the
 * side's own countdown live on `state.sides[0]` (constants.ts:279-288,
 * state.ts:509-525). */
const SCREEN_EFFECTS: readonly {
  effect: string
  up: (session: BattleSession) => boolean
  timer: (session: BattleSession) => number
}[] = [
  {
    effect: 'EFFECT_REFLECT', // handleReflect, moveEffects.ts:2940-2968
    up: (s) => (s.state.sides[0].statuses & SIDE_STATUS_REFLECT) !== 0,
    timer: (s) => s.state.sides[0].timers.reflectTimer,
  },
  {
    effect: 'EFFECT_LIGHT_SCREEN', // handleLightScreen, moveEffects.ts:2970-2998
    up: (s) => (s.state.sides[0].statuses & SIDE_STATUS_LIGHTSCREEN) !== 0,
    timer: (s) => s.state.sides[0].timers.lightscreenTimer,
  },
  {
    effect: 'EFFECT_AURORA_VEIL', // handleAuroraVeil, moveEffects.ts:3000-3028
    up: (s) => (s.state.sides[0].statuses & SIDE_STATUS_AURORA_VEIL) !== 0,
    timer: (s) => s.state.sides[0].timers.auroraVeilTimer,
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

/** True when the user's Screen Cleaner lets a screen re-cast succeed
 * (`hasReflect && !hasScreenCleaner`, moveEffects.ts:2952; the same branch in
 * handleLightScreen :2982 and handleAuroraVeil :3014). */
function hasScreenCleaner(session: BattleSession): boolean {
  const battler = session.state.battlers[0]
  if (!battler) return false
  return battlerHasSimAbility(session.state, battler, 'ABILITY_SCREEN_CLEANER', false, 0, false, session.data.dataContext)
}

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

/** Whether `effect`'s handler accepts re-setting it while it is still up.
 * Screens do, but only through the Screen Cleaner branch (handleReflect
 * moveEffects.ts:2952, handleLightScreen :2982, handleAuroraVeil :3014); for
 * Aurora Veil the hail / Aurora Borealis condition (:3014) must hold too.
 * Everything else rejects a same-effect re-cast: a weather recast fails in
 * tryChangeBattleWeather (switchInAbility.ts:427, "already active"), a
 * same-terrain recast fails in setFieldTerrain (moveEffects.ts:3404), and a
 * Trick Room recast while up TOGGLES IT OFF (handleRoomMove :3461-3475). */
function recastAccepted(session: BattleSession, effect: string): boolean {
  switch (effect) {
    case 'EFFECT_REFLECT':
    case 'EFFECT_LIGHT_SCREEN':
      return hasScreenCleaner(session)
    case 'EFFECT_AURORA_VEIL':
      return hasScreenCleaner(session) && auroraVeilWorks(session)
    default:
      return false
  }
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

/** attacker: Fake Out on its first turn in; else a guaranteed KO; else a
 * priority move when slower and threatened; else the best accuracy-weighted
 * damage (decision 14). */
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

  // Priority when we are slower and threatened (decision 14). "Slower" is read
  // with a neutral-priority move (MODEL CHOICE: priority 0 is the base-speed
  // comparison the rule refers to); priority then buys the turn.
  if (view.threatened && view.predictedAction) {
    const damaging = moves.filter((info) => hasDamage(info.range))
    const neutral = damaging.filter((info) => info.priority === 0)
    const reference = neutral.length > 0 ? bestByDamage(neutral) : damaging.length > 0 ? bestByDamage(damaging) : null
    if (reference && !outspeeds(session, reference.choice.action, view.predictedAction)) {
      const priority = damaging.filter((info) => info.priority > 0)
      if (priority.length > 0) {
        const priorityKos = priority.filter((info) => guaranteedKo(info.range!, hp))
        const pool = priorityKos.length > 0 ? priorityKos : priority
        return { choice: bestByDamage(pool).choice, tag: 'priority' }
      }
    }
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

/** pivot: on a bad matchup (threatened, or unable to damage the target) use a
 * pivot move and switch into the bench mon that takes the predicted move best;
 * else play as attacker (decision 14). */
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
    const legal = new Set(moves.map((info) => info.moveId))
    const pivotId = pivotMoves(session.data).find((id) => legal.has(id))
    if (pivotId) {
      const pivot = moves.find((info) => info.moveId === pivotId)!
      const bench = pickBenchSlot(session, view.predictedMoveId)
      // Baton Pass and the escape moves read monToSwitchIntoId (turn.ts:1864);
      // playPolicyBattle writes it from the choice's switchTo before stepTurn.
      return bench === null
        ? { choice: pivot.choice, tag: 'pivot' }
        : { choice: { ...pivot.choice, switchTo: bench }, tag: 'pivot' }
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
  const mon = session.state.battlers[0]?.mon
  if (!view.threatened && !opponentCanUndoBoosts(session) && currentBoostStage(session) < targetStage) {
    const moves = evaluateMoves(session, targetSlot)
    const boost = moves.find((info) => {
      if (!info.moveId) return false
      const stats = boostStatsOf(session, info.moveId)
      if (!stats || stats.length === 0) return false
      // The handler fails when every stat it raises is already MAX_STAT_STAGE
      // (BattleScript_EffectStatUp's jumpifstat check); don't pick such a move.
      return stats.some((stat) => (mon?.statStages[stat] ?? DEFAULT_STAT_STAGE) < MAX_STAT_STAGE)
    })
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
  const mon = session.state.battlers[0]?.mon
  const healThreshold = params.healThreshold ?? DEFAULT_HEAL_THRESHOLD
  if (mon && mon.hp * 100 < healThreshold * mon.maxHp) {
    // Direct recovery: BattleScript_EffectRestoreHp, battle_scripts_1.s:3940-3955.
    const recovery = findEffect('EFFECT_RESTORE_HP')
    if (recovery) return { choice: recovery.choice, tag: 'heal' }
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
  //    already seeded (handleLeechSeed, battle_scripts_1.s:4579-4590); Curse's
  //    Ghost branch sets STATUS2_CURSED on a target that lacks it
  //    (Cmd_cursetarget, battle_script_commands.c:11103-11113).
  const target = session.state.battlers[1]
  if (target) {
    const leechSeed = findEffect('EFFECT_LEECH_SEED')
    if (leechSeed && (target.statuses3 & STATUS3_LEECHSEED) === 0 && !target.mon.types.includes('GRASS')) {
      return { choice: leechSeed.choice, tag: 'residual' }
    }
    const curse = findEffect('EFFECT_CURSE')
    if (curse && mon?.types.includes('GHOST') && (target.mon.status2 & STATUS2_CURSED) === 0) {
      return { choice: curse.choice, tag: 'residual' }
    }
  }

  return chooseAttacker(session, view, targetSlot, hp)
}

/** The support's first effect to (re)set, in decision 14's priority order:
 * screens, weather, terrain, Trick Room. Null when every effect is already up
 * (and `refresh` does not re-set it). Timers are decrement-then-test: at
 * decision time T == 1 means the effect expires at this turn's end. */
function chooseSupportSetter(
  session: BattleSession,
  moves: MoveChoiceInfo[],
  view: PredictionView,
  refresh: boolean,
): RoleDecision | null {
  const findMove = (effect: string): MoveChoiceInfo | undefined =>
    moves.find((info) => info.moveId !== '' && session.data.dataContext.move(info.moveId)?.effect === effect)
  // Set the effect when it is down; with refresh='yes' also re-set it on its
  // last turn, but only where the handler really accepts the re-cast.
  const shouldSet = (up: boolean, timer: number, effect: string): boolean =>
    !up || (refresh && timer === 1 && recastAccepted(session, effect))

  for (const row of SCREEN_EFFECTS) {
    const move = findMove(row.effect)
    if (!move) continue
    const up = row.up(session)
    // Never pick Aurora Veil when it would fail without hail / Aurora Borealis
    // (moveEffects.ts:3014). The other screens have no such condition.
    if (row.effect === 'EFFECT_AURORA_VEIL' && !auroraVeilWorks(session)) continue
    if (shouldSet(up, row.timer(session), row.effect)) return { choice: move.choice, tag: up ? 'refresh' : 'screen' }
  }

  if (weatherMoveWorks(session)) {
    for (const row of WEATHER_EFFECTS) {
      const move = findMove(row.effect)
      if (!move) continue
      const up = (session.state.field.weather & row.mask) !== 0
      if (shouldSet(up, session.state.field.weatherDuration, row.effect)) {
        return { choice: move.choice, tag: up ? 'refresh' : 'weather' }
      }
    }
  }

  for (const row of TERRAIN_EFFECTS) {
    const move = findMove(row.effect)
    if (!move) continue
    const up = (session.state.field.statuses & row.flag) !== 0
    if (shouldSet(up, session.state.field.timers.terrainTimer, row.effect)) {
      return { choice: move.choice, tag: up ? 'refresh' : 'terrain' }
    }
  }

  const trickRoom = findMove('EFFECT_TRICK_ROOM')
  if (trickRoom) {
    const up = (session.state.field.statuses & STATUS_FIELD_TRICK_ROOM) !== 0
    // Never re-cast while up: handleRoomMove toggles it OFF (moveEffects.ts:
    // 3461-3475). Trick Room helps the slower side, so set it only when we are
    // slower. Trick Room is priority -7 in the pinned snapshot (moves.json), so
    // its own action always orders last; compare RAW speed with a
    // neutral-priority view of the action, the same way chooseAttacker reads
    // "slower" (rolePolicy.ts:619-623).
    const neutral = trickRoom.choice.action.chosenMove
      ? { ...trickRoom.choice.action, chosenMove: { ...trickRoom.choice.action.chosenMove, priority: 0 } }
      : trickRoom.choice.action
    if (
      shouldSet(up, session.state.field.timers.trickRoomTimer, 'EFFECT_TRICK_ROOM') &&
      !outspeeds(session, neutral, view.predictedAction)
    ) {
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
 * own-boost set-up is deliberately excluded (refresh = false, so only the
 * setter rule runs): a freshly switched-in mon always starts at stage 0, so
 * counting its own boosts as a pending effect would pull it in forever.
 * MODEL CHOICE, not a game fact. */
export function supportEffectPending(session: BattleSession, view: PredictionView): boolean {
  return chooseSupportSetter(session, evaluateMoves(session, null), view, false) !== null
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
  const mon = session.state.battlers[0]?.mon
  if (view.threatened || opponentCanUndoBoosts(session) || currentBoostStage(session) >= targetStage) return null
  const boost = moves.find((info) => {
    if (!info.moveId) return false
    const stats = boostStatsOf(session, info.moveId)
    if (!stats || stats.length === 0) return false
    // Do not pick a boost whose every raised stat is already MAX_STAT_STAGE
    // (BattleScript_EffectStatUp's jumpifstat check).
    return stats.some((stat) => (mon?.statStages[stat] ?? DEFAULT_STAT_STAGE) < MAX_STAT_STAGE)
  })
  return boost ? { choice: boost.choice, tag: 'setup' } : null
}

/** The can-switch gate for a pivot move used by support. A HIT_ESCAPE move
 * only queues its switch after it dealt HP damage (turn.ts:4798-4803,
 * `sumHpDealt > 0`), so an immune range wastes the turn; the other pivot
 * effects switch from their own script once a live bench slot exists. */
export function pivotSwitchWorks(pivot: MoveChoiceInfo, effect: string | null): boolean {
  if (effect === 'EFFECT_HIT_ESCAPE') return !!pivot.range && !pivot.range.isImmune
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
  const refresh = (params.refresh ?? 'no') === 'yes'

  // 1. Set the effect (or refresh it on its last turn).
  const setter = chooseSupportSetter(session, moves, view, refresh)
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
    if (bench !== null && pivotSwitchWorks(pivot, effect)) {
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
