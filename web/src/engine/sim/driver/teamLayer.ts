// The solver-v2 TEAM LAYER (plan decision 14, "Team layer";
// docs/battle-sim/solver-v2-plan.md): voluntary switching and faint replacement
// decided ACROSS the party, composed with `chooseRoleAction` into one policy for
// `playPolicyBattle`.
//
// The layer runs BEFORE the active mon's role rule: six team PURPOSES are
// checked in the GENE order (`genes.purposeOrder`, a permutation), each with its
// own on/off gene, and the first that fires decides the turn. A purpose that
// does not fire falls through, and the active mon's `roles[partyIndex]` rule
// decides as usual. `replacement` is the same idea for the turn after a faint.
//
// Purposes in this slice (s20c): preserve, sacrifice and counter, plus the
// switch mechanism they share. entryAbility, support and the PP stall loop are
// typed, ordered and flagged here so s20c2 only adds their rules.
//
// Pure and headless: no React, no I/O. Every game rule cites the C or the data
// row that fixes it; every threshold a player chose is marked MODEL CHOICE.

import type { AiDamageRolls } from '../ai/aiCalcDamage'
import { aiDamageRolls } from '../ai/aiCalcDamage'
import type { BattleState } from '../state'
import { buildTurnOrderContext } from '../turn'
import { getMoveSpeed } from '../turnOrder'
import type { PlayerChoice } from './expectimax'
import { legalChoices } from './expectimax'
import type { PolicyTraceEntry } from './policyBattle'
import type { AiPrediction } from './policyInputs'
import { guaranteedKo, pivotMoves, predictAi } from './policyInputs'
import type { MoveChoiceInfo, PredictionView, RoleMemory, RoleName, RoleParams } from './rolePolicy'
import {
  DEFAULT_SAFETY_PCT,
  SAMPLE_COUNT,
  bestByDamage,
  chooseRoleAction,
  evaluateMoves,
  highestRoll,
  lowestRoll,
  meanRoll,
  moveIdOf,
  outspeeds,
  pickBenchSlot,
  pivotSwitchWorks,
  rangeOnOurReserve,
  readPredictions,
  stateWithReserve,
  statusMoveWorks,
} from './rolePolicy'
import type { BattleSession } from './session'
import { aiDamageDepsFor, cloneSession, firstLiveReplacement } from './session'

/** The six voluntary-switching purposes of decision 14. All six exist here so
 * `purposeOrder` and `purposeFlags` cover the whole design; the last three are
 * implemented in s20c2. */
export type TeamPurpose = 'preserve' | 'sacrifice' | 'counter' | 'entryAbility' | 'support' | 'ppLoop'

/** Every purpose, in decision 14's own order (preserve, sacrifice, counter,
 * entry ability, bring in support, PP stall loop). The default gene order. */
export const TEAM_PURPOSES: readonly TeamPurpose[] = [
  'preserve',
  'sacrifice',
  'counter',
  'entryAbility',
  'support',
  'ppLoop',
]

/** The team genes of decision 14: the purpose order (a permutation of
 * `TEAM_PURPOSES`, a GA gene), an on/off flag per purpose, the switch-in safety
 * threshold, and the party slot the team protects. */
export interface TeamGenes {
  /** The order the purposes are checked in; a permutation of `TEAM_PURPOSES`. */
  purposeOrder: TeamPurpose[]
  /** One on/off gene per purpose. A false flag skips that purpose entirely. */
  purposeFlags: Record<TeamPurpose, boolean>
  /** Percent of the candidate's CURRENT HP the predicted move may remove and
   * still count as a safe switch-in. MODEL CHOICE: decision 14's default 50,
   * not a game fact. */
  switchInSafety: number
  /** Party index of the mon to protect; null means the team has no preserve
   * member. MODEL CHOICE: the design default is null. */
  preserve: number | null
}

/** Decision 14's defaults: "six purposes, checked in the GENE order (a
 * permutation) ... each with an on/off gene"; "Team genes: purpose order,
 * purpose flags, switch-in safety threshold, preserve". The order below is the
 * design's own listing (preserve, sacrifice, counter, entry ability, bring in
 * support, PP stall loop), every flag on, the 50% switch-in safety line the
 * design names as its threshold and no preserve member. */
export const DEFAULT_TEAM_GENES: TeamGenes = {
  purposeOrder: [...TEAM_PURPOSES],
  purposeFlags: {
    preserve: true,
    sacrifice: true,
    counter: true,
    entryAbility: true,
    support: true,
    ppLoop: true,
  },
  switchInSafety: 50,
  preserve: null,
}

// Deterministic probe seeds: the layer is a pure function of the position.
// 0 matches rolePolicy.ts's PREDICTION_SEED / SPEED_PROBE_SEED.
const PREDICTION_SEED = 0
const SPEED_PROBE_SEED = 0

// ---------------------------------------------------------------------------
// Bench primitives
// ---------------------------------------------------------------------------

/** The living, non-active party slots on our side (side 0). In singles there is
 * exactly one active party index; the set form keeps the filter honest if a
 * caller ever passes a doubles state. */
function livingBenchSlots(session: BattleSession): number[] {
  const party = session.state.sides[0].party
  const active = new Set<number>()
  for (const battler of session.state.battlers) {
    if (battler) active.add(battler.partyIndex)
  }
  const slots: number[] = []
  for (let slot = 0; slot < party.length; slot++) {
    const mon = party[slot]
    if (mon && mon.speciesId !== null && mon.hp > 0 && !active.has(slot)) slots.push(slot)
  }
  return slots
}

function theirActiveHp(session: BattleSession): number {
  return session.state.battlers[1]?.mon.hp ?? 0
}

/** The reserve's best damaging move onto THEIR active mon: the substituted
 * attacker route (`stateWithReserve` at battler 0, then `aiDamageRolls` 0 -> 1),
 * the same call shape `rangeAgainstTheirReserve` uses for their reserve at
 * rolePolicy.ts:222-233. "Best" is the largest mean roll (the replacement rule
 * names that explicitly); this file's single notion of a bench mon's best move
 * so the counter rule and the replacement score cannot disagree. Not
 * accuracy-weighted -- the design spec ranks by raw mean. */
function bestReserveMove(
  session: BattleSession,
  slot: number,
): { moveId: string; lowest: number; mean: number } | null {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null) return null
  const state = stateWithReserve(session.state, 0, reserve, slot)
  const deps = aiDamageDepsFor(session.data, state, session.inverseBattle)
  let best: { moveId: string; lowest: number; mean: number } | null = null
  for (let i = 0; i < reserve.moves.length; i++) {
    const moveId = reserve.moves[i]
    const pp = reserve.pp[i]
    if (!moveId || !(pp > 0)) continue
    const range = aiDamageRolls(state, moveId, 0, 1, deps)
    if (!range || range.isImmune) continue
    const mean = meanRoll(range)
    if (best === null || mean > best.mean) best = { moveId, lowest: lowestRoll(range), mean }
  }
  return best
}

/** Whether the bench candidate would move before their active mon. `outspeeds`
 * (rolePolicy.ts:339) needs the ACTIVE mon's ChosenAction and a reserve has
 * none, so this compares the two comparable speeds with the chosen move
 * ignored -- which is what `RecalculateMoveOrder` does at a switch-in
 * (`GetFastestBattler(ignoreChosenMove = TRUE)`, battle_main.c:4551-4566, called
 * for switch-in abilities at battle_main.c:3361). With the move ignored the
 * priority bits are neutral while Trick Room, paralysis, items and abilities
 * still apply (turnOrder.ts:486-550). `stateWithReserve` supplies the candidate
 * as battler 0 and `cloneSession` rebuilds the deps around that state
 * (session.ts:511-518), so no field is invented and the real session's RNG is
 * untouched. A speed tie returns false (the tie is an RNG draw the game makes,
 * and a tie-break only needs a stable answer). */
function benchOutspeedsTheirActive(session: BattleSession, slot: number): boolean {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null) return false
  const substituted = stateWithReserve(session.state, 0, reserve, slot)
  const probe = cloneSession({ ...session, state: substituted }, SPEED_PROBE_SEED)
  const ctx = buildTurnOrderContext(probe.state, probe.turnDeps)
  const ours = getMoveSpeed(probe.state, 0, null, true, ctx, probe.data.statStageRatios).comparable
  const theirs = getMoveSpeed(probe.state, 1, null, true, ctx, probe.data.statStageRatios).comparable
  return ours > theirs
}

/** The predicted AI moves of a 3-sample `predictAi`, in sample order, deduped.
 * The replacement scores each candidate against the WORST of them (the maximum
 * incoming roll): a faint replacement has no live target for the samples to be
 * ranked against, so all the evidence is kept instead of picking one sample.
 * MODEL CHOICE (sample folding only). */
function predictedMoveIds(predictions: AiPrediction[]): string[] {
  const ids: string[] = []
  for (const sample of predictions) {
    const action = sample.action
    if (!action || action.action !== 'USE_MOVE') continue
    const moveId = action.chosenMove?.id ?? action.moveToBeUsed?.id ?? null
    if (moveId && !ids.includes(moveId)) ids.push(moveId)
  }
  return ids
}

/** One bench candidate's matchup numbers. The incoming fraction is of the
 * candidate's CURRENT HP; the offense fraction is of their active mon's current
 * HP. */
interface BenchScore {
  slot: number
  incomingFraction: number
  /** The best (largest-mean) move's worst roll; the counter rule's "KO in two"
   * input. */
  lowestRoll: number
  /** The best (largest-mean) move's mean roll; the counter rule's "heavy
   * damage" input. */
  meanRoll: number
  outspeeds: boolean
  /** True when the predicted move removes at most `switchInSafety`% of the
   * candidate's current HP, or when there is no prediction at all. */
  acceptable: boolean
  /** (b) - (a) of decision 14's replacement rule. */
  score: number
}

function scoreBench(
  session: BattleSession,
  slot: number,
  predictedMoveIds: readonly string[],
  switchInSafety: number,
): BenchScore | null {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null || reserve.hp <= 0) return null
  let incomingHigh = 0
  for (const moveId of predictedMoveIds) {
    const range: AiDamageRolls | null = rangeOnOurReserve(session, moveId, slot)
    if (range && !range.isImmune) incomingHigh = Math.max(incomingHigh, highestRoll(range))
  }
  const incomingFraction = incomingHigh / reserve.hp
  const offense = bestReserveMove(session, slot)
  const theirHp = theirActiveHp(session)
  const offenseFraction = offense && theirHp > 0 ? offense.mean / theirHp : 0
  return {
    slot,
    incomingFraction,
    lowestRoll: offense?.lowest ?? 0,
    meanRoll: offense?.mean ?? 0,
    outspeeds: benchOutspeedsTheirActive(session, slot),
    acceptable: predictedMoveIds.length === 0 || incomingFraction * 100 <= switchInSafety,
    score: offenseFraction - incomingFraction,
  }
}

/** Higher score wins; speed breaks a tie, then the lower party index. */
function betterBench(a: BenchScore, b: BenchScore): boolean {
  if (a.score !== b.score) return a.score > b.score
  if (a.outspeeds !== b.outspeeds) return a.outspeeds
  return a.slot < b.slot
}

function pickBestBench(pool: BenchScore[]): BenchScore | null {
  let best: BenchScore | null = null
  for (const candidate of pool) {
    if (best === null || betterBench(candidate, best)) best = candidate
  }
  return best
}

// ---------------------------------------------------------------------------
// The switch mechanism
// ---------------------------------------------------------------------------

/** A voluntary switch to `slot`, by the active mon's pivot move when it has a
 * usable one, else by a hard switch (decision 14: "A switch uses the active
 * mon's pivot move when it has one (Safe Passage passing a Wish), else a hard
 * switch").
 *
 * A pivot choice carries its target in `switchTo`: `playPolicyBattle` writes it
 * to `monToSwitchIntoId` before `stepTurn` (policyBattle.ts:89-91), which the
 * switch step reads (turn.ts:1864), and the pivot handlers move it into the
 * bench (moveEffects.ts:10357-10466 for Safe Passage / Baton Pass).
 *
 * `pivotSwitchWorks` (rolePolicy.ts:1104-1112) is the can-switch gate: a
 * HIT_ESCAPE move only queues its switch after it dealt HP damage
 * (turn.ts:4798-4803), so an immune range must fall back to the hard switch.
 * A Baton Pass / Shed Tail pivot needs a live bench slot, which holds here
 * because `slot` is a living candidate. */
function switchChoice(session: BattleSession, slot: number): PlayerChoice | null {
  const legal = legalChoices(session)
  const hard = legal.find((choice) => choice.action.action === 'SWITCH' && choice.switchTo === slot)
  if (!hard) return null
  const pivotIds = new Set(pivotMoves(session.data))
  for (const info of evaluateMoves(session, null)) {
    if (!info.moveId || !pivotIds.has(info.moveId)) continue
    const effect = session.data.dataContext.move(info.moveId)?.effect ?? null
    if (!pivotSwitchWorks(info, effect)) continue
    return { ...info.choice, switchTo: slot }
  }
  return hard
}

// ---------------------------------------------------------------------------
// Purposes
// ---------------------------------------------------------------------------

/** preserve: the preserve member is threatened. A bench mon is not hit this
 * turn, so the rule only fires while the preserve member IS the active mon
 * (`battlers[0].partyIndex === genes.preserve`) and the prediction threatens it;
 * then switch to the teammate that takes the predicted move best
 * (`pickBenchSlot`, rolePolicy.ts:767). No preserve gene or no bench slot: no
 * fire. */
function rulePreserve(
  session: BattleSession,
  view: PredictionView,
  genes: TeamGenes,
): PlayerChoice | null {
  const active = session.state.battlers[0]
  if (!active || genes.preserve === null) return null
  if (active.partyIndex !== genes.preserve || !view.threatened) return null
  const slot = pickBenchSlot(session, view.predictedMoveId)
  if (slot === null) return null
  return switchChoice(session, slot)
}

/** sacrifice: our active mon is doomed -- some predicted sample move can KO it
 * (`view.koThreat`) and we do not KO them first (no legal damaging move that is
 * both a guaranteed KO and faster than the predicted action) -- AND a
 * `preserve` or set-up teammate needs a safe entry. Then STAY and attack with
 * the most accuracy-weighted damage, or with a status move when nothing does
 * damage, and let the faint hand the replacement a free entry. */
function ruleSacrifice(
  session: BattleSession,
  view: PredictionView,
  genes: TeamGenes,
  roles: RoleName[],
): PlayerChoice | null {
  if (!view.koThreat) return null
  const theirHp = theirActiveHp(session)
  const moves = evaluateMoves(session, null)
  const weKoFirst = moves.some(
    (info) =>
      info.range !== null &&
      !info.range.isImmune &&
      guaranteedKo(info.range, theirHp) &&
      outspeeds(session, info.choice.action, view.predictedAction),
  )
  if (weKoFirst) return null
  const entryNeeded = livingBenchSlots(session).some(
    (slot) => slot === genes.preserve || roles[slot] === 'setupSweeper',
  )
  if (!entryNeeded) return null

  const damaging = moves.filter((info) => info.range !== null && !info.range.isImmune)
  if (damaging.length > 0) return bestByDamage(damaging).choice
  const status = moves.find(
    (info) =>
      info.moveId !== '' &&
      statusMoveWorks(session, info.moveId, session.data.dataContext.move(info.moveId)?.effect ?? ''),
  )
  if (status) return status.choice
  return moves[0]?.choice ?? legalChoices(session)[0] ?? null
}

/** counter: a bench teammate takes the predicted move for at most
 * `switchInSafety`% of its current HP AND threatens their active mon (its best
 * move's worst roll KOs in two or fewer hits, or it outspeeds with a mean roll
 * of at least half their HP), while our active mon does neither (no KO in two,
 * and it is either faster or itself threatened). Pick the best such teammate by
 * the replacement score and switch to it. No predicted move: no fire. */
function ruleCounter(
  session: BattleSession,
  view: PredictionView,
  genes: TeamGenes,
): PlayerChoice | null {
  if (view.predictedMoveId === null) return null
  const theirHp = theirActiveHp(session)
  if (theirHp <= 0) return null

  const damaging = evaluateMoves(session, null).filter(
    (info) => info.range !== null && !info.range.isImmune,
  )
  // The active mon's best move for a KO-in-two question is the one with the
  // highest WORST roll: "KO in two" is a floor question (as everywhere else in
  // decision 14), unlike the bench side, where the brief names the mean.
  let activeBest: MoveChoiceInfo | null = null
  for (const info of damaging) {
    if (activeBest === null || lowestRoll(info.range!) > lowestRoll(activeBest.range!)) activeBest = info
  }
  const activeKoInTwo = activeBest !== null && 2 * lowestRoll(activeBest.range!) >= theirHp
  // The active's own gate, as decision 14 puts it: no KO in two, and when it
  // does not outspeed it must be the one at risk.
  const activeOutspeeds =
    activeBest !== null ? outspeeds(session, activeBest.choice.action, view.predictedAction) : false
  const activeDoesNeither = !activeKoInTwo && (activeOutspeeds || view.threatened)
  if (!activeDoesNeither) return null

  const candidates: BenchScore[] = []
  for (const slot of livingBenchSlots(session)) {
    const scored = scoreBench(session, slot, [view.predictedMoveId], genes.switchInSafety)
    if (!scored) continue
    if (scored.incomingFraction * 100 > genes.switchInSafety) continue
    const koInTwo = 2 * scored.lowestRoll >= theirHp
    const fastHeavy = scored.outspeeds && 2 * scored.meanRoll >= theirHp
    if (!koInTwo && !fastHeavy) continue
    candidates.push(scored)
  }
  if (candidates.length === 0) return null
  return switchChoice(session, pickBestBench(candidates)!.slot)
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/** Sorted comparison of two purpose lists, so the permutation check is one
 * expression and reads as the developer error it is. */
function isPermutation(order: readonly TeamPurpose[]): boolean {
  if (order.length !== TEAM_PURPOSES.length) return false
  const sorted = [...order].sort()
  const expected = [...TEAM_PURPOSES].sort()
  return sorted.every((purpose, i) => purpose === expected[i])
}

/** The trace line the layer writes for a firing purpose. `moveIdOf` and
 * `switchTo` are read the same way `chooseRoleAction` reads them, so the two
 * layers' traces are comparable in a battle log. */
function describePurpose(purpose: TeamPurpose, choice: PlayerChoice): string {
  const moveId = moveIdOf(choice)
  const parts = [`team:${purpose}`]
  if (moveId) parts.push(moveId)
  if (choice.switchTo !== undefined) parts.push(`-> ${choice.switchTo}`)
  return parts.join(' ')
}

/** Builds the team layer. `roles` is indexed by party index (the same array a
 * solver passes to `chooseRoleAction`); the returned `policy` decides the turn
 * and `replacement` answers a faint, so both can be handed straight to
 * `playPolicyBattle` (`policy` and `playerReplacement`). */
export function createTeamLayer(config: {
  roles: RoleName[]
  roleParams?: RoleParams[]
  genes?: Partial<TeamGenes>
}): {
  policy: (session: BattleSession, turn: number, trace: PolicyTraceEntry[]) => PlayerChoice | null
  replacement: (state: BattleState, battlerId: number) => number
  genes: TeamGenes
} {
  const genes: TeamGenes = {
    purposeOrder: [...(config.genes?.purposeOrder ?? DEFAULT_TEAM_GENES.purposeOrder)],
    purposeFlags: { ...DEFAULT_TEAM_GENES.purposeFlags, ...config.genes?.purposeFlags },
    switchInSafety: config.genes?.switchInSafety ?? DEFAULT_TEAM_GENES.switchInSafety,
    preserve: config.genes?.preserve ?? DEFAULT_TEAM_GENES.preserve,
  }
  // A purpose order that is not a permutation of TEAM_PURPOSES is a developer
  // error (a GA gene builder bug), so it throws rather than silently dropping a
  // purpose or checking one twice.
  if (!isPermutation(genes.purposeOrder)) {
    throw new Error(
      `createTeamLayer: purposeOrder must be a permutation of TEAM_PURPOSES (got ${genes.purposeOrder.join(', ')})`,
    )
  }

  const roles = config.roles
  const roleParams = config.roleParams
  // Per-party-index role memory, created on first use and persisted across the
  // battle (the same object `chooseRoleAction` mutates).
  const memories = new Map<number, RoleMemory>()

  // The replacement callback receives only the state (session.ts:268-274), so
  // the last session `policy` saw is kept here and the faint's state is spliced
  // into it: `predictAi` / `cloneSession` rebuild their deps from the state
  // they are handed, so `{ ...lastSession, state }` is a valid probe.
  let lastSession: BattleSession | null = null

  const policy = (
    session: BattleSession,
    turn: number,
    trace: PolicyTraceEntry[],
  ): PlayerChoice | null => {
    lastSession = session
    const active = session.state.battlers[0]
    if (!active || active.mon.hp <= 0) return null
    // One prediction per call, at the role layer's own safety line, shared by
    // every purpose (decision 14: the same view feeds every rule).
    const view = readPredictions(session, DEFAULT_SAFETY_PCT)

    for (const purpose of genes.purposeOrder) {
      if (!genes.purposeFlags[purpose]) continue
      let choice: PlayerChoice | null = null
      switch (purpose) {
        case 'preserve':
          choice = rulePreserve(session, view, genes)
          break
        case 'sacrifice':
          choice = ruleSacrifice(session, view, genes, roles)
          break
        case 'counter':
          choice = ruleCounter(session, view, genes)
          break
        // s20c2: the entry-ability purpose, the bring-in-support purpose and
        // the PP stall loop land in the next slice.
        case 'entryAbility':
        case 'support':
        case 'ppLoop':
          choice = null
          break
      }
      if (choice) {
        trace.push({ turn, choice: describePurpose(purpose, choice), tags: ['team', purpose] })
        return choice
      }
    }

    const partyIndex = active.partyIndex
    let memory = memories.get(partyIndex)
    if (!memory) {
      memory = { turn: 0, lastMove: null }
      memories.set(partyIndex, memory)
    }
    return chooseRoleAction(
      session,
      roles[partyIndex] ?? 'attacker',
      roleParams?.[partyIndex] ?? {},
      memory,
      trace,
    )
  }

  const replacement = (state: BattleState, battlerId: number): number => {
    const session = lastSession
    // A faint before the first `policy` call (the lead faints on turn 1 before
    // the layer has seen a position): with no probe session the fallback is the
    // first live non-active slot, which is where the game's heuristic ends too
    // (createHeuristicPlayerReplacement, expectimax.ts:1427-1429).
    if (!session) return firstLiveReplacement(state, battlerId)
    const probe: BattleSession = { ...session, state }
    const moveIds = predictedMoveIds(predictAi(probe, SAMPLE_COUNT, PREDICTION_SEED))

    const candidates: BenchScore[] = []
    for (const slot of livingBenchSlots(probe)) {
      const scored = scoreBench(probe, slot, moveIds, genes.switchInSafety)
      if (scored) candidates.push(scored)
    }
    if (candidates.length === 0) return firstLiveReplacement(state, battlerId)

    let pool = candidates
    if (genes.preserve !== null) {
      const otherAcceptable = candidates.some(
        (candidate) => candidate.slot !== genes.preserve && candidate.acceptable,
      )
      // Skip the preserve member only while another candidate is acceptable;
      // when it is the only option it is used.
      if (otherAcceptable) pool = candidates.filter((candidate) => candidate.slot !== genes.preserve)
    }
    const best = pickBestBench(pool)
    return best ? best.slot : firstLiveReplacement(state, battlerId)
  }

  return { policy, replacement, genes }
}
