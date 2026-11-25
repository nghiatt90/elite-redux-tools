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
// All six purposes are implemented: preserve, sacrifice, counter and the switch
// mechanism they share (s20c), plus entryAbility, support and the PP stall loop
// (s20c2). The entry-ability and support probes run on cloned sessions, and the
// PP loop keeps a per-layer stall counter; none of them touch the real RNG.
//
// Pure and headless: no React, no I/O. Every game rule cites the C or the data
// row that fixes it; every threshold a player chose is marked MODEL CHOICE.

import type { AiDamageRolls } from '../ai/aiCalcDamage'
import { aiDamageRolls } from '../ai/aiCalcDamage'
import { DEFAULT_STAT_STAGE, STAT_ATK, STATUS_FIELD_TERRAIN_ANY } from '../constants'
import { canBattlerEscape, isAbilityPreventingEscape, type EscapeDeps } from '../escape'
import type { BattleState } from '../state'
import { battlerHasSimAbility } from '../statBuffs'
import { applySwitchInAbilities, type BattleStartDeps } from '../switchInAbility'
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
  supportEffectPending,
} from './rolePolicy'
import type { BattleSession } from './session'
import { aiDamageDepsFor, cloneSession, firstLiveReplacement } from './session'

/** The six voluntary-switching purposes of decision 14, all implemented. */
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
 * caller ever passes a doubles state. Only SIDE 0 battlers may mark a slot
 * active: the opponent's party has its own indexes, and reading them here would
 * hide our slot 0 whenever their active mon sits in their slot 0 while ours is
 * some other slot. */
function livingBenchSlots(session: BattleSession): number[] {
  const party = session.state.sides[0].party
  const active = new Set<number>()
  for (const battler of session.state.battlers) {
    if (battler && (battler.id & 1) === 0) active.add(battler.partyIndex)
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
 * The replacement makes one prediction PER CANDIDATE, with the candidate sent
 * in as battler 0 (`stateWithReserve`), because the AI picks its move for its
 * target (decision 14: "a fresh 3-sample prediction against each candidate").
 * Each candidate is then scored against the WORST of its own predicted moves
 * (the maximum incoming roll): the three samples disagree about the move, so
 * all the evidence is kept instead of picking one sample. MODEL CHOICE (sample
 * folding only). */
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

/**
 * A voluntary switch to `slot`, by the active mon's pivot move when it has a
 * usable one, else by a hard switch (decision 14).
 *
 * A pivot is taken only when `!view.threatened || outspeeds(session, info.choice.action, view.predictedAction)`.
 * When threatened, a slower pivot lets the predicted hit land on the mon being saved,
 * while a hard switch resolves before moves.
 *
 * `pivotSwitchWorks` (rolePolicy.ts) gates HIT_ESCAPE on non-immune range, Shed Tail
 * on HP and substitute, and Parting Shot on target stat stages.
 *
 * When no pivot qualifies, a hard switch is refused if trapped (CanBattlerEscape
 * false or IsAbilityPreventingEscape prevents, battle_main.c:3745-3755, escape.ts)
 * so subsequent purposes or the role rule can act; move-switches ignore escape
 * prevention (jumpifcantswitch SWITCH_IGNORE_ESCAPE_PREVENTION, battle_scripts_1.s:5271,
 * :5358, :5379) and are returned even when trapped.
 */
function switchChoice(
  session: BattleSession,
  slot: number,
  view: PredictionView,
): PlayerChoice | null {
  const legal = legalChoices(session)
  const hard = legal.find((choice) => choice.action.action === 'SWITCH' && choice.switchTo === slot)
  if (!hard) return null
  const pivotIds = new Set(pivotMoves(session.data))
  for (const info of evaluateMoves(session, null)) {
    if (!info.moveId || !pivotIds.has(info.moveId)) continue
    const effect = session.data.dataContext.move(info.moveId)?.effect ?? null
    if (!pivotSwitchWorks(session, info, effect, null)) continue
    if (view.threatened && !outspeeds(session, info.choice.action, view.predictedAction)) continue
    return { ...info.choice, switchTo: slot }
  }
  const deps: EscapeDeps = {
    dataContext: session.data.dataContext,
    grounding: session.turnDeps.grounding,
  }
  if (!canBattlerEscape(session.state, 0, deps) || isAbilityPreventingEscape(session.state, 0, deps).prevents) {
    return null
  }
  return hard
}

// ---------------------------------------------------------------------------
// Entry-ability probe
// ---------------------------------------------------------------------------

// Deterministic seed for the entry-switch probe; the clone gets its own
// generator, so a random entry effect (Zen Garden's terrain coin) never draws
// from the real session.
const ENTRY_PROBE_SEED = 0
// The support probe's own clone seed, for the same reason.
const SUPPORT_PROBE_SEED = 0

/** The entry abilities the purpose simulates. C sources:
 * Intimidate data `abilities.cc:764-768` and `Impl<ABILITY_INTIMIDATE>`
 * `abilities.cc:771` (`.onEntry = UseIntimidateClone`); the four weather
 * setters all gate on `TryChangeBattleWeather`, which does nothing when that
 * weather is already up or a primal weather is up -- Drizzle `abilities.cc:
 * 501-514`, Sand Stream `:1076`, Drought `:1332`, Snow Warning `:1798`; the
 * four Surges all `CHECK(TryChangeBattleTerrain(...))` -- Electric `:3144`,
 * Psychic `:3160`, Misty `:3172`, Grassy `:3184`. Every other entry ability
 * stays off. */
export const ENTRY_ABILITIES_HANDLED: readonly string[] = [
  'ABILITY_INTIMIDATE',
  'ABILITY_DRIZZLE',
  'ABILITY_DROUGHT',
  'ABILITY_SAND_STREAM',
  'ABILITY_SNOW_WARNING',
  'ABILITY_ELECTRIC_SURGE',
  'ABILITY_GRASSY_SURGE',
  'ABILITY_MISTY_SURGE',
  'ABILITY_PSYCHIC_SURGE',
]

// The two setter groups, split out so the entry rule can ask "did THIS group
// change the field" instead of any effect at all.
const WEATHER_ENTRY_ABILITIES: readonly string[] = [
  'ABILITY_DRIZZLE',
  'ABILITY_DROUGHT',
  'ABILITY_SAND_STREAM',
  'ABILITY_SNOW_WARNING',
]
const TERRAIN_ENTRY_ABILITIES: readonly string[] = [
  'ABILITY_ELECTRIC_SURGE',
  'ABILITY_GRASSY_SURGE',
  'ABILITY_MISTY_SURGE',
  'ABILITY_PSYCHIC_SURGE',
]

/** The switch-in deps `applySwitchInAbilities` needs, built the way session.ts
 * builds them for the battle-start pass (`BattleStartDeps`, switchInAbility.ts:
 * 2529-2533): the probe's own grounding, data context, turn order and stat-stage
 * ratios. `grounding` is `probe.turnDeps.grounding`, which is bound to the
 * probe's state (session.ts:131-133). */
function entryProbeDeps(probe: BattleSession): BattleStartDeps {
  return {
    grounding: probe.turnDeps.grounding,
    dataContext: probe.data.dataContext,
    turnOrder: probe.data.turnOrder,
    statStageRatios: probe.data.statStageRatios,
  }
}

/** A clone of the session with `slot` standing in as battler 0, run through the
 * sim's own switch-in ability dispatcher (`applySwitchInAbilities`,
 * switchInAbility.ts:1359). Nothing here touches the real session or its RNG:
 * `stateWithReserve` copies the state and `cloneSession` deep-copies it with a
 * fresh generator (session.ts:511-518). */
function entryProbeFor(session: BattleSession, slot: number): BattleSession | null {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null || reserve.hp <= 0) return null
  const probe = cloneSession({ ...session, state: stateWithReserve(session.state, 0, reserve, slot) }, ENTRY_PROBE_SEED)
  applySwitchInAbilities(probe.state, 0, entryProbeDeps(probe), [])
  return probe
}

/** Whether `battlerId`'s ability slots (chosen ability plus the three innates,
 * with suppression) hold any of `abilityIds`. `battlerHasSimAbility` is the
 * sim's own test (statBuffs.ts:168). */
function holdsAnyAbility(
  session: BattleSession,
  battlerId: number,
  abilityIds: readonly string[],
): boolean {
  const battler = session.state.battlers[battlerId]
  if (!battler) return false
  return abilityIds.some((abilityId) =>
    battlerHasSimAbility(session.state, battler, abilityId, false, battlerId, false, session.data.dataContext),
  )
}

/** MODEL CHOICE: a field change counts only when it helps the team. Build the
 * session with exactly the probe's field (`{ ...session.state, field }`, so an
 * Intimidate or other entry effect on the probe cannot leak in) and require at
 * least one living non-active slot to improve on one of the three axes the
 * layer cares about: its best move's mean, the predicted move's highest roll on
 * it, or whether it outspeeds their active mon. The active slot is excluded
 * because the candidate replaces it. */
function fieldChangeBenefitsTeam(
  session: BattleSession,
  probe: BattleSession,
  predictedMoveId: string | null,
): boolean {
  const withField: BattleSession = { ...session, state: { ...session.state, field: probe.state.field } }
  for (const slot of livingBenchSlots(session)) {
    const before = bestReserveMove(session, slot)
    const after = bestReserveMove(withField, slot)
    if (before !== null && after !== null && after.mean > before.mean) return true
    if (predictedMoveId !== null) {
      const beforeRange = rangeOnOurReserve(session, predictedMoveId, slot)
      const afterRange = rangeOnOurReserve(withField, predictedMoveId, slot)
      const beforeHigh = beforeRange && !beforeRange.isImmune ? highestRoll(beforeRange) : 0
      const afterHigh = afterRange && !afterRange.isImmune ? highestRoll(afterRange) : 0
      if (afterHigh < beforeHigh) return true
    }
    if (!benchOutspeedsTheirActive(session, slot) && benchOutspeedsTheirActive(withField, slot)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// PP loop bookkeeping
// ---------------------------------------------------------------------------

/** MODEL CHOICE: "little or nothing" is 25% of our current HP -- a threshold the
 * player chose, not a game fact. */
export const PP_LOOP_LITTLE_PCT = 25

/** Decision 14's stop rule: both sides have switched every turn for 4 turns with
 * no HP or PP change on either side, then the loop stops. */
export const PP_LOOP_STALL_LIMIT = 4

/** One `policy` call's position, enough to tell a stalled turn from a real one. */
interface PpLoopSnapshot {
  turn: number
  ourPartyIndex: number
  theirPartyIndex: number
  ourHp: number
  theirHp: number
  ourPp: number
  theirPp: number
}

/** Summed HP and PP of one side's party. For a slot that is active this reads
 * the BATTLE mon, not the party copy: the party copy's HP is not kept in sync
 * mid-turn (switchIn.ts:251 `syncPartyHp` is what writes it back), while the
 * battler's mon is the live value. */
function sideHpAndPp(session: BattleSession, side: 0 | 1): { hp: number; pp: number } {
  const party = session.state.sides[side].party
  let hp = 0
  let pp = 0
  for (let slot = 0; slot < party.length; slot++) {
    const mon = party[slot]
    if (!mon || mon.speciesId === null) continue
    const active = session.state.battlers.find(
      (battler) => battler !== null && (battler.id & 1) === side && battler.partyIndex === slot,
    )
    const source = active ? active.mon : mon
    hp += source.hp
    for (const value of source.pp) pp += value
  }
  return { hp, pp }
}

function ppLoopSnapshot(session: BattleSession, turn: number): PpLoopSnapshot {
  const ourTotals = sideHpAndPp(session, 0)
  const theirTotals = sideHpAndPp(session, 1)
  return {
    turn,
    ourPartyIndex: session.state.battlers[0]?.partyIndex ?? -1,
    theirPartyIndex: session.state.battlers[1]?.partyIndex ?? -1,
    ourHp: ourTotals.hp,
    theirHp: theirTotals.hp,
    ourPp: ourTotals.pp,
    theirPp: theirTotals.pp,
  }
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
  return switchChoice(session, slot, view)
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
 * of at least half their HP), while our active mon does neither: no KO in two
 * AND no outspeed-with-heavy-damage, with `view.threatened` keeping a slower
 * active mon eligible for the switch. Pick the best such teammate by the
 * replacement score and switch to it. No predicted move: no fire. */
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
  // Decision 14's other side of "does neither": outspeeding with heavy damage
  // (mean roll of at least half their HP) also threatens them, so a fast heavy
  // hitter must not be switched out just because its worst roll falls short of
  // the two-hit KO. The bench side uses the same test below.
  const activeFastHeavy =
    activeOutspeeds && activeBest !== null && 2 * meanRoll(activeBest.range!) >= theirHp
  const activeDoesNeither = !activeKoInTwo && !activeFastHeavy && (activeOutspeeds || view.threatened)
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
  return switchChoice(session, pickBestBench(candidates)!.slot, view)
}

/** entryAbility: a bench mon's switch-in ability applies now and the mon
 * survives the predicted move. A candidate qualifies when it holds one of
 * `ENTRY_ABILITIES_HANDLED`, survives the predicted move's highest roll, and
 * one of:
 *
 * - Intimidate: it holds ABILITY_INTIMIDATE, the predicted move is PHYSICAL,
 *   and the simulated entry actually lowered their active mon's Attack stage
 *   (a missing statStages entry reads DEFAULT_STAT_STAGE). The comparison to
 *   the pre-probe stage is what excludes an immune target, a Substitute and a
 *   foe already at the minimum stage.
 * - A weather setter: the probe's weather differs from the real one and the
 *   active mon holds none of the four (MODEL CHOICE: two setters would
 *   otherwise ping-pong) and the new field helps the team.
 * - A terrain setter: the same test on `field.statuses & STATUS_FIELD_TERRAIN_ANY`.
 *
 * The immunity / already-up cases are not hand-modelled: `applySwitchInAbilities`
 * runs the real handlers, which are where TryChangeBattleWeather and
 * UseIntimidateClone refuse. */
function ruleEntryAbility(
  session: BattleSession,
  view: PredictionView,
  genes: TeamGenes,
): PlayerChoice | null {
  const predictedMoveId = view.predictedMoveId
  const predictedSplit =
    predictedMoveId === null ? null : (session.data.dataContext.move(predictedMoveId)?.split ?? null)
  const activeHasWeatherSetter = holdsAnyAbility(session, 0, WEATHER_ENTRY_ABILITIES)
  const activeHasTerrainSetter = holdsAnyAbility(session, 0, TERRAIN_ENTRY_ABILITIES)
  const realTerrain = session.state.field.statuses & STATUS_FIELD_TERRAIN_ANY
  const beforeAtkStage = session.state.battlers[1]?.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE

  const candidates: BenchScore[] = []
  for (const slot of livingBenchSlots(session)) {
    const reserve = session.state.sides[0].party[slot]
    if (!reserve) continue
    // Survive the predicted move: its highest roll must not reach our current
    // HP. No prediction or an immune range counts as surviving.
    if (predictedMoveId !== null) {
      const incoming = rangeOnOurReserve(session, predictedMoveId, slot)
      const high = incoming && !incoming.isImmune ? highestRoll(incoming) : 0
      if (high >= reserve.hp) continue
    }

    const probe = entryProbeFor(session, slot)
    if (!probe) continue
    if (!holdsAnyAbility(probe, 0, ENTRY_ABILITIES_HANDLED)) continue

    const afterAtkStage = probe.state.battlers[1]?.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE
    const intimidate =
      predictedSplit === 'PHYSICAL' &&
      holdsAnyAbility(probe, 0, ['ABILITY_INTIMIDATE']) &&
      afterAtkStage < beforeAtkStage

    const weather =
      holdsAnyAbility(probe, 0, WEATHER_ENTRY_ABILITIES) &&
      probe.state.field.weather !== session.state.field.weather &&
      !activeHasWeatherSetter &&
      fieldChangeBenefitsTeam(session, probe, predictedMoveId)

    const probeTerrain = probe.state.field.statuses & STATUS_FIELD_TERRAIN_ANY
    const terrain =
      holdsAnyAbility(probe, 0, TERRAIN_ENTRY_ABILITIES) &&
      probeTerrain !== realTerrain &&
      !activeHasTerrainSetter &&
      fieldChangeBenefitsTeam(session, probe, predictedMoveId)

    if (!intimidate && !weather && !terrain) continue
    const scored = scoreBench(session, slot, predictedMoveId ? [predictedMoveId] : [], genes.switchInSafety)
    if (scored) candidates.push(scored)
  }
  if (candidates.length === 0) return null
  return switchChoice(session, pickBestBench(candidates)!.slot, view)
}

/** support: bring in a support teammate whose effect is not up yet. Does not
 * fire while the active mon is itself a support with an effect still to set,
 * otherwise two supports would ping-pong before either sets anything. A
 * candidate must be a living bench slot with role 'support', still have an
 * effect to set from its own position (`supportEffectPending` on a probe with
 * the candidate as battler 0 -- the role's own setter logic, not a copy), and
 * be acceptable under `switchInSafety` without being KO'd. */
function ruleSupport(
  session: BattleSession,
  view: PredictionView,
  genes: TeamGenes,
  roles: RoleName[],
): PlayerChoice | null {
  const active = session.state.battlers[0]
  if (!active) return null
  if (roles[active.partyIndex] === 'support' && supportEffectPending(session, view)) return null

  const predictedIds = view.predictedMoveId ? [view.predictedMoveId] : []
  const candidates: BenchScore[] = []
  for (const slot of livingBenchSlots(session)) {
    if (roles[slot] !== 'support') continue
    const reserve = session.state.sides[0].party[slot]
    if (!reserve || reserve.speciesId === null) continue
    const probe = cloneSession(
      { ...session, state: stateWithReserve(session.state, 0, reserve, slot) },
      SUPPORT_PROBE_SEED,
    )
    if (!supportEffectPending(probe, view)) continue
    const scored = scoreBench(session, slot, predictedIds, genes.switchInSafety)
    if (!scored) continue
    if (!scored.acceptable || scored.incomingFraction >= 1) continue
    candidates.push(scored)
  }
  if (candidates.length === 0) return null
  return switchChoice(session, pickBestBench(candidates)!.slot, view)
}

/** Their active mon's moves that still have PP and therefore can be forced. */
function theirUsableMoves(session: BattleSession): string[] {
  const their = session.state.battlers[1]
  if (!their) return []
  const moves: string[] = []
  for (let i = 0; i < their.mon.moves.length; i++) {
    const moveId = their.mon.moves[i]
    const pp = their.mon.pp[i]
    if (moveId && pp > 0) moves.push(moveId)
  }
  return moves
}

interface PpLoopIncoming {
  /** The largest highest-roll among their usable moves onto this mon. */
  highest: number
  /** The mon's current HP. */
  hp: number
}

/** The largest highest-roll their usable moves can land on our active mon
 * (battler 0) or a bench slot, and that mon's current HP. Null when they have
 * no usable move (at least one is required) or the mon is not alive. A null or
 * immune range contributes zero. */
function ppLoopIncoming(
  session: BattleSession,
  theirMoves: readonly string[],
  slot: number | 'active',
): PpLoopIncoming | null {
  if (theirMoves.length === 0) return null
  const hp =
    slot === 'active'
      ? (session.state.battlers[0]?.mon.hp ?? 0)
      : (session.state.sides[0].party[slot]?.hp ?? 0)
  if (hp <= 0) return null
  let highest = 0
  for (const moveId of theirMoves) {
    const range =
      slot === 'active'
        ? aiDamageRolls(
            session.state,
            moveId,
            1,
            0,
            aiDamageDepsFor(session.data, session.state, session.inverseBattle),
          )
        : rangeOnOurReserve(session, moveId, slot)
    if (range && !range.isImmune) highest = Math.max(highest, highestRoll(range))
  }
  return { highest, hp }
}

function takesLittleOrNothing(incoming: PpLoopIncoming | null): incoming is PpLoopIncoming {
  return incoming !== null && incoming.highest * 100 <= PP_LOOP_LITTLE_PCT * incoming.hp
}

/** ppLoop: two of our mons both take little or nothing from every move their
 * mon has, so alternate them to drain its PP. Fires only when the ACTIVE mon
 * and at least one bench slot both qualify, and switches to the qualifying slot
 * whose worst-case fraction of HP is smallest (ties go to the lower slot). The
 * stall count (updated on every `policy` call) stops it once both sides have
 * switched for `PP_LOOP_STALL_LIMIT` turns with no HP or PP change. */
function rulePpLoop(
  session: BattleSession,
  view: PredictionView,
  stallCount: number,
): PlayerChoice | null {
  if (stallCount >= PP_LOOP_STALL_LIMIT) return null
  const theirMoves = theirUsableMoves(session)
  if (theirMoves.length === 0) return null
  if (!takesLittleOrNothing(ppLoopIncoming(session, theirMoves, 'active'))) return null

  let best: { slot: number; incoming: PpLoopIncoming } | null = null
  for (const slot of livingBenchSlots(session)) {
    const incoming = ppLoopIncoming(session, theirMoves, slot)
    if (!takesLittleOrNothing(incoming)) continue
    if (best === null) {
      best = { slot, incoming }
      continue
    }
    // Compare highest/hp by cross-multiplication so the ordering is exact for
    // integer rolls; a genuine tie falls to the lower party slot.
    const left = incoming.highest * best.incoming.hp
    const right = best.incoming.highest * incoming.hp
    if (left < right || (left === right && slot < best.slot)) best = { slot, incoming }
  }
  if (best === null) return null
  return switchChoice(session, best.slot, view)
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

  // The PP loop's stall tracker, updated on EVERY policy call before the
  // purpose loop (whichever purpose fires), as decision 14's stop rule needs.
  let ppLoopStallCount = 0
  let ppLoopPrevious: PpLoopSnapshot | null = null

  const observePpLoopStall = (session: BattleSession, turn: number): void => {
    const current = ppLoopSnapshot(session, turn)
    if (ppLoopPrevious !== null) {
      // One stalled turn: the next turn in sequence, BOTH actives changed, and
      // neither side's HP or PP moved. Anything else resets the count to 0 --
      // including a non-consecutive turn, which is also how a layer reused for
      // a new game clears its old state.
      const stalled =
        turn === ppLoopPrevious.turn + 1 &&
        current.ourPartyIndex !== ppLoopPrevious.ourPartyIndex &&
        current.theirPartyIndex !== ppLoopPrevious.theirPartyIndex &&
        current.ourHp === ppLoopPrevious.ourHp &&
        current.theirHp === ppLoopPrevious.theirHp &&
        current.ourPp === ppLoopPrevious.ourPp &&
        current.theirPp === ppLoopPrevious.theirPp
      ppLoopStallCount = stalled ? ppLoopStallCount + 1 : 0
    }
    ppLoopPrevious = current
  }

  const policy = (
    session: BattleSession,
    turn: number,
    trace: PolicyTraceEntry[],
  ): PlayerChoice | null => {
    lastSession = session
    observePpLoopStall(session, turn)
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
        case 'entryAbility':
          choice = ruleEntryAbility(session, view, genes)
          break
        case 'support':
          choice = ruleSupport(session, view, genes, roles)
          break
        case 'ppLoop':
          choice = rulePpLoop(session, view, ppLoopStallCount)
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
    // The unsubstituted state: the fainted battler 0 is still on the field, so
    // `livingBenchSlots` / `scoreBench` see the same party-slot bookkeeping the
    // live position has (the substituted states put a candidate in slot 0,
    // which would make that slot read as active instead of benched).
    const probe: BattleSession = { ...session, state }

    const candidates: BenchScore[] = []
    for (const slot of livingBenchSlots(probe)) {
      const reserve = state.sides[0].party[slot]
      if (!reserve || reserve.speciesId === null) continue
      // The AI chooses its move FOR ITS TARGET, so the prediction has to be
      // made with the candidate standing in at battler 0 (decision 14: "a
      // fresh 3-sample prediction against each candidate"). `predictAi` clones
      // the session it is handed, so neither the real state nor its RNG moves.
      const substituted = stateWithReserve(state, 0, reserve, slot)
      // gAbsentBattlerFlags can hold bit 0 when this runs -- in DOUBLES only:
      // battleFormat.ts:342/346 marks a lead that starts fainted absent, and
      // switchIn.ts:324 marks a battler that fainted with no reserve, while
      // hasNoMonsToSwitch is FALSE outside BATTLE_TYPE_DOUBLE (:3611) so
      // singles never sets it. The candidate IS the live battler 0 in this
      // copy, so the stale bit must not survive into the AI's target scan
      // (IsBattlerAlive, battle_util.c:6685-6694). Cleared on the copy only.
      const candidateState: BattleState =
        (substituted.absentBattlerFlags & (1 << 0)) === 0
          ? substituted
          : { ...substituted, absentBattlerFlags: substituted.absentBattlerFlags & ~(1 << 0) }
      const predicted = predictedMoveIds(
        predictAi({ ...session, state: candidateState }, SAMPLE_COUNT, PREDICTION_SEED),
      )
      const scored = scoreBench(probe, slot, predicted, genes.switchInSafety)
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
