// Pure, headless role policies for the solver-v2 player side (plan decision 14,
// Step 2.0a; docs/battle-sim/solver-v2-plan.md). A role is a cheap ordered rule
// list played on battler 0 in singles: the caller picks `roles[partyIndex]` and
// passes it here, and the returned `PlayerChoice` is fed to `playPolicyBattle`.
//
// This file holds the shared inputs every role reads (a 3-sample prediction of
// the AI's next action, our damage ranges, speed order, the predicted switch-in)
// and three of the six roles: attacker, pivot and lead/hazard setter. The
// set-up sweeper, staller and support roles land in s20b2; until then the
// lead/hazard setter's staller fallback is `chooseStallerStub`.
//
// Ports of game mechanics cite the C; the policy thresholds (the 50% default
// safety line, accuracy weighting) are MODEL CHOICES and are marked as such.

import { createBattlerState } from '../create'
import type { AiDamageRolls } from '../ai/aiCalcDamage'
import { aiDamageRolls } from '../ai/aiCalcDamage'
import { SIDE_STATUS_STEALTH_ROCK } from '../constants'
import type { BattleState, SimBattleMon, SimPartyMon } from '../state'
import { buildTurnOrderContext } from '../turn'
import type { ChosenAction } from '../turnOrder'
import { getWhoStrikesFirst } from '../turnOrder'
import type { PlayerChoice } from './expectimax'
import { legalChoices } from './expectimax'
import type { PolicyTraceEntry } from './policyBattle'
import { guaranteedKo, ourDamageRange, pivotMoves, predictAi } from './policyInputs'
import type { BattleSession } from './session'
import { aiDamageDepsFor, cloneSession } from './session'

/** The roles built in this cycle. s20b2 extends the union with
 * `setupSweeper | staller | support`. */
export type RoleName = 'attacker' | 'pivot' | 'leadHazard'

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
  /** attacker / pivot / leadHazard: the HP fraction of our active mon above
   * which a predicted move counts as threatening. Default 50. */
  safetyPct?: number
}

/** Per-battler state the caller owns and persists across turns. `lastMove` is
 * written after every choice (the move id, or null for a hard switch). */
export interface RoleMemory {
  turn: number
  lastMove: string | null
}

// MODEL CHOICE: an incoming move that removes more than this percentage of our
// current HP counts as threatening. 50 is decision 14's default, not a game fact.
const DEFAULT_SAFETY_PCT = 50
// Three samples is decision 14's contract (`predictAi(session, 3, seedBase)`).
const SAMPLE_COUNT = 3
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

function lowestRoll(range: AiDamageRolls): number {
  return rollsOf(range)[0]!
}

function highestRoll(range: AiDamageRolls): number {
  return rollsOf(range)[15]!
}

function meanRoll(range: AiDamageRolls): number {
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

function moveIdOf(choice: PlayerChoice): string | null {
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
function stateWithReserve(
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
function rangeOnOurReserve(
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

interface PredictionView {
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
function readPredictions(session: BattleSession, safetyPct: number): PredictionView {
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
function outspeeds(
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

interface MoveChoiceInfo {
  choice: PlayerChoice
  moveId: string
  range: AiDamageRolls | null
  /** moves.json's declared priority (getMovePriority's base, turnOrder.ts:513-519). */
  priority: number
  accuracy: number
}

function evaluateMoves(session: BattleSession, targetSlot: number | null): MoveChoiceInfo[] {
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

function bestByDamage(pool: MoveChoiceInfo[]): MoveChoiceInfo {
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
// Roles
// ---------------------------------------------------------------------------

interface RoleDecision {
  choice: PlayerChoice
  /** Short trace tag, e.g. 'fakeout', 'ko', 'pivot'. */
  tag: string
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
function pickBenchSlot(session: BattleSession, predictedMoveId: string | null): number | null {
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

/** leadHazard: lay hazards while below the target layers and not threatened
 * with a KO; then play the fallback role (decision 14). */
function chooseLeadHazard(
  session: BattleSession,
  view: PredictionView,
  targetSlot: number | null,
  hp: number,
  params: RoleParams,
  memory: RoleMemory,
  trace: PolicyTraceEntry[] | undefined,
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
    return { choice: chooseStallerStub(session, params, memory, trace), tag: 'staller' }
  }
  return chooseAttacker(session, view, targetSlot, hp)
}

/** s20b2 replaces this with the staller rule; for now it plays the attacker
 * choice, which is what the plan's Step 2.0a stub asks for. */
export function chooseStallerStub(
  session: BattleSession,
  params: RoleParams,
  _memory?: RoleMemory,
  _trace?: PolicyTraceEntry[],
): PlayerChoice {
  const view = readPredictions(session, params.safetyPct ?? DEFAULT_SAFETY_PCT)
  const slot = resolveTargetSlot(session, view.switchSlot)
  return chooseAttacker(session, view, slot, targetHp(session, slot)).choice
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
      choice: `${role}:${decision.tag}${moveId ? ` ${moveId}` : ''}`,
      tags: [role, decision.tag],
    })
  }
  return decision.choice
}
