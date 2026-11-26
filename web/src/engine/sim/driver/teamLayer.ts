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
// PP loop keeps a per-layer stall counter plus a latched stop; none of them
// touch the real RNG. The PP loop also prices each bench candidate's SWITCH-IN
// on its own clone: entry hazards (`applySwitchInHazards`) and Toxic Terrain
// chip, and it disqualifies a candidate the sim's hazard port gives a status,
// so a loop that is free of move damage but not of switching is not counted as
// free (s20c2bb, s20c2bc).
//
// Pure and headless: no React, no I/O. Every game rule cites the C or the data
// row that fixes it; every threshold a player chose is marked MODEL CHOICE.

import type { AiDamageRolls } from '../ai/aiCalcDamage'
import { aiDamageRolls } from '../ai/aiCalcDamage'
import { doesBattlerHaveAbilityShield } from '../ai/aiAbilityHelpers'
import {
  DEFAULT_STAT_STAGE,
  PARTY_SIZE,
  SIDE_STATUS_HAZARDS_ANY,
  SIDE_STATUS_SAFEGUARD,
  STAT_ATK,
  STATUS1_ANY,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON_ANY,
  STATUS3_GASTRO_ACID,
  STATUS_FIELD_TERRAIN_ANY,
  STATUS_FIELD_TERRAIN_PERMANENT,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_FOG_ANY,
  hasFlag,
} from '../constants'
import { canBattlerEscape, isAbilityPreventingEscape, type EscapeDeps } from '../escape'
import { isAbilityOnField, toxicTerrainDamage } from '../fieldEndTurn'
import { applySwitchInHazards } from '../hazards'
import { ON_DEFENDER_ABILITIES, getBattlerAbilitySlotsReverse } from '../moveEnd'
import type { BattleState, BattlerState, SimPartyMon } from '../state'
import { battlerHasSimAbility, isBattlerWeatherAffected } from '../statBuffs'
import { applySwitchInAbilities, type BattleStartDeps } from '../switchInAbility'
import { canBeBurned, canBeParalyzed, canBleed, canGetFrostbite } from '../statusEffects'
import { blocksStatusMove, buildTurnOrderContext } from '../turn'
import { getMoveSpeed, type ChosenAction } from '../turnOrder'
import type { PlayerChoice } from './expectimax'
import { legalChoices } from './expectimax'
import type { PolicyTraceEntry } from './policyBattle'
import type { AiPrediction } from './policyInputs'
import { pivotMoves, predictAi } from './policyInputs'
import type { MoveChoiceInfo, PredictionView, RoleMemory, RoleName, RoleParams } from './rolePolicy'
import {
  accuracyWeightedDamage,
  DEFAULT_SAFETY_PCT,
  SAMPLE_COUNT,
  bestByDamage,
  chooseRoleAction,
  damageDistribution,
  evaluateMoves,
  highestRoll,
  koProbability,
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
import { aiDamageDepsFor, cloneSession, firstLiveReplacement, stepTurn } from './session'

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
 * threshold, the other-move KO risk, and the party slot the team protects. */
export interface TeamGenes {
  /** The order the purposes are checked in; a permutation of `TEAM_PURPOSES`. */
  purposeOrder: TeamPurpose[]
  /** One on/off gene per purpose. A false flag skips that purpose entirely. */
  purposeFlags: Record<TeamPurpose, boolean>
  /** Percent of the candidate's CURRENT HP the predicted move may remove and
   * still count as a safe switch-in. MODEL CHOICE: decision 14's default 20
   * (negligible loss; GA values 10 / 20 / 30), not a game fact. */
  switchInSafety: number
  /** Probability threshold at which any other usable opponent move KOs the
   * candidate and refuses the switch-in. MODEL CHOICE: decision 14's default
   * 0.15 (GA values 0.05 / 0.15 / 0.30). */
  otherMoveKoRisk: number
  /** Party index of the mon to protect; null means the team has no preserve
   * member. MODEL CHOICE: the design default is null. */
  preserve: number | null
}

/** Decision 14's defaults: "six purposes, checked in the GENE order (a
 * permutation) ... each with an on/off gene"; "Team genes: purpose order,
 * purpose flags, switch-in safety threshold, other-move KO risk, preserve".
 * The order below is the design's own listing (preserve, sacrifice, counter,
 * entry ability, bring in support, PP stall loop), every flag on, the 20%
 * switch-in safety line (negligible loss), the 0.15 other-move KO risk,
 * and no preserve member. */
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
  switchInSafety: 20,
  otherMoveKoRisk: 0.15,
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

/** The reserve's damage ranges onto THEIR active mon: the substituted attacker
 * route (`stateWithReserve` at battler 0, then `aiDamageRolls` 0 -> 1), the same
 * call shape `rangeAgainstTheirReserve` uses for their reserve at
 * rolePolicy.ts:222-233. Each value is the best over the reserve's usable moves
 * -- the largest WORST roll for `lowest` and the largest MEAN for `mean`, which
 * may come from two different moves. The counter rule asks a floor question of
 * one and a mean question of the other, so taking both from a single "best"
 * move would hide a mon that threatens through a different move; the two stay
 * separate so the replacement score keeps its mean ranking (the design spec
 * ranks by raw mean). Not accuracy-weighted. */
function bestReserveMove(session: BattleSession, slot: number): { lowest: number; mean: number } | null {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null) return null
  const state = stateWithReserve(session.state, 0, reserve, slot)
  const deps = aiDamageDepsFor(session.data, state, session.inverseBattle)
  let lowest: number | null = null
  let mean: number | null = null
  for (let i = 0; i < reserve.moves.length; i++) {
    const moveId = reserve.moves[i]
    const pp = reserve.pp[i]
    if (!moveId || !(pp > 0)) continue
    const range = aiDamageRolls(state, moveId, 0, 1, deps)
    if (!range || range.isImmune) continue
    const moveLow = lowestRoll(range)
    const moveMean = meanRoll(range)
    if (lowest === null || moveLow > lowest) lowest = moveLow
    if (mean === null || moveMean > mean) mean = moveMean
  }
  if (lowest === null || mean === null) return null
  return { lowest, mean }
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

/** Whether the bench candidate has SOME ONE move that outspeeds their predicted
 * action with heavy damage (battle_main.c:4386 GetWhoStrikesFirst, priority from
 * battle_main.c:4257 GetMovePriority). Unlike the switch-in ability ordering of
 * battle_main.c:4551-4566, the counter turn's order includes move priority. */
function benchFastHeavy(
  session: BattleSession,
  slot: number,
  theirHp: number,
  theirAction: ChosenAction | null,
): boolean {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null) return false
  const substituted = stateWithReserve(session.state, 0, reserve, slot)
  const probe = cloneSession({ ...session, state: substituted }, SPEED_PROBE_SEED)
  const moves = evaluateMoves(probe, null).filter(
    (info) => info.range !== null && !info.range.isImmune,
  )
  return moves.some(
    (info) =>
      2 * meanRoll(info.range!) >= theirHp &&
      outspeeds(probe, info.choice.action, theirAction),
  )
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
  /** The largest worst roll over the candidate's usable moves (possibly a
   * different move from the mean below); the counter rule's "KO in two"
   * input. */
  lowestRoll: number
  /** The largest mean roll over the candidate's usable moves; the counter
   * rule's "heavy damage" input and the replacement score's offense term. */
  meanRoll: number
  outspeeds: boolean
  /** True when the predicted move removes at most `switchInSafety`% of the
   * candidate's current HP, or when there is no prediction at all. */
  acceptable: boolean
  /** (b) - (a) of decision 14's replacement rule. */
  score: number
}

export function scoreBench(
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

/** Their active mon's moves that still have PP and therefore can be forced. */
export function theirUsableMoves(session: BattleSession): string[] {
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

/**
 * Switch-in rule for counter, entryAbility, support:
 * (a) the predicted move costs it at most `switchInSafety`% of its CURRENT HP
 *     (scoreBench `acceptable`).
 * (b) NO move their active mon has with PP left (`theirUsableMoves(session)`)
 *     KOs the candidate with probability >= `genes.otherMoveKoRisk`.
 */
export function acceptableSwitchIn(
  session: BattleSession,
  slot: number,
  predictedMoveIds: readonly string[],
  genes: TeamGenes,
): BenchScore | null {
  const scored = scoreBench(session, slot, predictedMoveIds, genes.switchInSafety)
  if (!scored || !scored.acceptable) return null
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.hp <= 0) return null
  for (const moveId of theirUsableMoves(session)) {
    const range = rangeOnOurReserve(session, moveId, slot)
    const prob = koProbability(damageDistribution(range), reserve.hp)
    if (prob >= genes.otherMoveKoRisk) return null
  }
  return scored
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
// The fodder probe's clone seed, for the same reason.
const FODDER_PROBE_SEED = 0
// The PP loop's switch-in probe seed: its clone takes hazard damage and Toxic
// Terrain chip, never the real session or its RNG.
const PP_LOOP_PROBE_SEED = 0

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
// Stay test
// ---------------------------------------------------------------------------

/** Fixed threshold for the stay test: active mon stays when KO probability
 * times accuracy is at least 50% (MODEL CHOICE: fixed, not a gene). */
export const STAY_KO_CHANCE = 0.5

export interface StayDecision {
  stay: boolean
  outspeedsWithKo: boolean
}

/** Whether a move qualifies as a KO move under the stay / usefulness test. */
export function isKoMove(
  session: BattleSession,
  info: MoveChoiceInfo,
  theirHp: number,
): boolean {
  if (!info.range || info.range.isImmune) return false
  const effect = session.data.dataContext.move(info.moveId)?.effect
  if (effect === 'EFFECT_FAKE_OUT' && !session.state.battlers[0]?.volatiles.isFirstTurn) {
    return false
  }
  const koChance =
    koProbability(damageDistribution(info.range), theirHp) * (info.accuracy / 100)
  return koChance >= STAY_KO_CHANCE
}

/**
 * Stay test: switching gives the opponent a free hit, so never switch when we
 * can KO.
 *
 * Checks candidate moves from `evaluateMoves(session, null)` (active mon vs
 * battler 1). A move qualifies as a KO move when:
 *   koProbability(damageDistribution(info.range), theirActiveHp(session)) * (info.accuracy / 100) >= STAY_KO_CHANCE
 *
 * Fake Out off the first turn is excluded.
 *
 * The active mon STAYS when some KO move satisfies:
 *   outspeeds(session, thatMove.choice.action, view.predictedAction) OR !view.koThreat
 */
export function stayTest(
  session: BattleSession,
  view: PredictionView,
): StayDecision {
  const theirHp = theirActiveHp(session)
  if (theirHp <= 0) return { stay: false, outspeedsWithKo: false }

  let hasOutspeedingKo = false
  let hasSurvivingKo = false

  for (const info of evaluateMoves(session, null)) {
    if (!isKoMove(session, info, theirHp)) continue

    if (outspeeds(session, info.choice.action, view.predictedAction)) {
      hasOutspeedingKo = true
    } else if (!view.koThreat) {
      hasSurvivingKo = true
    }
  }

  return {
    stay: hasOutspeedingKo || hasSurvivingKo,
    outspeedsWithKo: hasOutspeedingKo,
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

/** Whether a bench candidate qualifies as a good counter to their active mon. */
export function isGoodCounter(
  session: BattleSession,
  slot: number,
  score: BenchScore,
  theirHp: number,
  predictedAction: ChosenAction | null,
): boolean {
  return 2 * score.lowestRoll >= theirHp || benchFastHeavy(session, slot, theirHp, predictedAction)
}

// ---------------------------------------------------------------------------
// Fodder ability exception (s20ic)
// ---------------------------------------------------------------------------

/** The four ability-hook families that run when the holder is HIT, TOUCHED,
 * DAMAGED or FAINTS -- exactly the events a fodder mon experiences. It is a
 * MODEL CHOICE, not a game fact, that an ability from any of these families is
 * worth ranking a fodder mon for; the game behaviour itself is read from the
 * sim's existing ports (no ability is ported here). */
export type FodderHook = 'onDefender' | 'onAbsorb' | 'onDisguise' | 'onRevive'

/** How many seeds a candidate is tried on. Chance abilities (Flame Body 30% on
 * contact / 20% otherwise, abilities.cc:1126-1134) need several rolls; 32 matches
 * the "several seeds" idea of rolePolicy.ts's secondTurnRunSafe seed loop. */
export const FODDER_ABILITY_SEEDS = 32

/** onAbsorb ids, transcribed from data/v2.65beta/abilityHooks.json. Every one is
 * handled by absorb.ts's applyAbsorbEffect (HEAL / STAT / FLASH_FIRE / EVAPORATE),
 * reached from the turn path at turn.ts:4517. */
export const ON_ABSORB_ABILITIES = new Set<string>([
  'ABILITY_AERODYNAMICS',
  'ABILITY_DRY_SKIN',
  'ABILITY_EARTH_EATER',
  'ABILITY_ELEMENTAL_VORTEX',
  'ABILITY_EVAPORATE',
  'ABILITY_FIRE_ASPECT',
  'ABILITY_FLASH_FIRE',
  'ABILITY_HEAT_SINK',
  'ABILITY_ICE_DEW',
  'ABILITY_JUSTIFIED',
  'ABILITY_LIGHTNING_ASPECT',
  'ABILITY_LIGHTNING_ROD',
  'ABILITY_MOLTEN_CORE',
  'ABILITY_MOTOR_DRIVE',
  'ABILITY_POISON_ABSORB',
  'ABILITY_RESERVOIR',
  'ABILITY_SAP_SIPPER',
  'ABILITY_STORM_DRAIN',
  'ABILITY_VOLT_ABSORB',
  'ABILITY_WATER_ABSORB',
  'ABILITY_WELL_BAKED_BODY',
  'ABILITY_WIND_RIDER',
])

/** onDisguise ids, transcribed from data/v2.65beta/abilityHooks.json. The hook
 * itself is NOT ported (DoesDisguiseBlockMove, battle_script_commands.c:12273-12283). */
export const ON_DISGUISE_ABILITIES = new Set<string>([
  'ABILITY_DISGUISE',
  'ABILITY_ICE_FACE',
  'ABILITY_PATCHWORK',
])

/** onRevive ids, transcribed from data/v2.65beta/abilityHooks.json. Only
 * Recurring Nightmare is ported (turn.ts's latchRecurringNightmareOnFaint, the
 * Cmd_tryfaintmon scan at battle_script_commands.c:3184-3197). */
export const ON_REVIVE_ABILITIES = new Set<string>([
  'ABILITY_BACKUP_POWER',
  'ABILITY_RECURRING_NIGHTMARE',
])

/** A (ability, hook) pair the sim cannot evaluate, with what is missing. */
export interface FodderAbilityGap {
  abilityId: string
  hook: FodderHook
  missing: string
}

/** The static gap set, verified against the sim: all 122 onDefender ids are in
 * moveEnd.ts's PORTED_DEFENDER_ABILITIES and all 22 onAbsorb ids are handled by
 * the turn path, so only the unported onDisguise hook and BackUp Power's onRevive
 * remain. Patchwork is BOTH onDisguise (a gap) and onDefender (ported), so it can
 * still be usable through onDefender while its onDisguise half is gapped. */
export const FODDER_ABILITY_GAPS: readonly FodderAbilityGap[] = [
  {
    abilityId: 'ABILITY_DISGUISE',
    hook: 'onDisguise',
    missing: 'DoesDisguiseBlockMove (battle_script_commands.c:12273-12283) is not ported',
  },
  {
    abilityId: 'ABILITY_ICE_FACE',
    hook: 'onDisguise',
    missing: 'DoesDisguiseBlockMove (battle_script_commands.c:12273-12283) is not ported',
  },
  {
    abilityId: 'ABILITY_PATCHWORK',
    hook: 'onDisguise',
    missing: 'DoesDisguiseBlockMove (battle_script_commands.c:12273-12283) is not ported',
  },
  {
    abilityId: 'ABILITY_BACKUP_POWER',
    hook: 'onRevive',
    missing: 'BackUp Power onRevive (electric terrain) is not ported; turn.ts latches only Recurring Nightmare',
  },
]

/** The result of the fodder ability evaluation for one bench slot. */
export interface FodderAbilityTriggers {
  usable: string[]
  gaps: FodderAbilityGap[]
}

function fodderHooksFor(abilityId: string): FodderHook[] {
  const hooks: FodderHook[] = []
  if (ON_DEFENDER_ABILITIES.has(abilityId)) hooks.push('onDefender')
  if (ON_ABSORB_ABILITIES.has(abilityId)) hooks.push('onAbsorb')
  if (ON_DISGUISE_ABILITIES.has(abilityId)) hooks.push('onDisguise')
  if (ON_REVIVE_ABILITIES.has(abilityId)) hooks.push('onRevive')
  return hooks
}

function staticFodderGap(abilityId: string, hook: FodderHook): FodderAbilityGap | null {
  return FODDER_ABILITY_GAPS.find((gap) => gap.abilityId === abilityId && gap.hook === hook) ?? null
}

/** One (ability id, hook, slot index) candidate of a bench mon, in the reverse
 * slot order the game's own ON_ABILITY scan uses. */
interface FodderCandidate {
  abilityId: string
  hook: FodderHook
  slotIndex: number
}

function fodderCandidates(reserve: SimPartyMon): FodderCandidate[] {
  const candidates: FodderCandidate[] = []
  const seen = new Set<string>()
  for (const { abilityId, slotIndex } of getBattlerAbilitySlotsReverse(reserve.abilities)) {
    for (const hook of fodderHooksFor(abilityId)) {
      const key = `${abilityId}::${hook}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ abilityId, hook, slotIndex })
    }
  }
  return candidates
}

/** A clone with `slot` as battler 0 and no faint replacement: the probe must not
 * predict or recurse through the layer's own replacement. `PARTY_SIZE` is the
 * "none" value (turn.ts:2048); the end-of-turn faint-replacement path
 * (switchIn.ts:applyEndOfTurnReplacements) instead hands its result straight to
 * switchIn, which rejects PARTY_SIZE, so the documented "no replacement" default
 * (`deps.replacement` absent, turn.ts:648) is what actually brings nothing in. */
function fodderProbe(session: BattleSession, slot: number, reserve: SimPartyMon, seed: number): BattleSession {
  const base: BattleSession = {
    ...session,
    state: stateWithReserve(session.state, 0, reserve, slot),
    playerReplacement: () => PARTY_SIZE,
  }
  const probe = cloneSession(base, seed)
  probe.turnDeps = { ...probe.turnDeps, replacement: undefined }
  return probe
}

/** `reserve` with `abilityId` nulled in every ability slot it appears in. */
function reserveWithoutAbility(reserve: SimPartyMon, abilityId: string): SimPartyMon {
  const clear = (id: string | null): string | null => (id === abilityId ? null : id)
  return {
    ...reserve,
    abilities: {
      ability: clear(reserve.abilities.ability),
      innates: [
        clear(reserve.abilities.innates[0]),
        clear(reserve.abilities.innates[1]),
        clear(reserve.abilities.innates[2]),
      ],
    },
  }
}

/** The observables of their ORIGINAL active mon. If it was forced out the
 * battler at id 1 is somebody else, so read the party entry instead (which has
 * HP/status1/item/ability/types but not stat stages, statuses3 or volatiles). */
interface TheirMonView {
  hp: number
  status1: number
  statStages: readonly number[]
  status2: number
  statuses3: number
  itemId: string | null
  ability: string | null
  types: readonly string[]
  volatiles: BattlerState['volatiles'] | null
  stillActive: boolean
}

function theirMonView(state: BattleState, partyIndex: number): TheirMonView {
  const battler = state.battlers[1]
  if (battler && battler.partyIndex === partyIndex) {
    return {
      hp: battler.mon.hp,
      status1: battler.mon.status1,
      statStages: battler.mon.statStages,
      status2: battler.mon.status2,
      statuses3: battler.statuses3,
      itemId: battler.mon.itemId,
      ability: battler.mon.abilities.ability,
      types: battler.mon.types,
      volatiles: battler.volatiles,
      stillActive: true,
    }
  }
  const mon = state.sides[1].party[partyIndex]
  return {
    hp: mon?.hp ?? 0,
    status1: mon?.status1 ?? 0,
    statStages: [],
    status2: 0,
    statuses3: 0,
    itemId: mon?.itemId ?? null,
    ability: mon?.abilities.ability ?? null,
    types: mon?.types ?? ['MYSTERY', 'MYSTERY', 'MYSTERY'],
    volatiles: null,
    stillActive: false,
  }
}

function statStagesBeat(after: readonly number[], before: readonly number[], direction: 'lower' | 'higher'): boolean {
  for (let i = 0; i < 8; i++) {
    const a = after[i] ?? DEFAULT_STAT_STAGE
    const b = before[i] ?? DEFAULT_STAT_STAGE
    if (direction === 'lower' ? a < b : a > b) return true
  }
  return false
}

function typesChanged(after: readonly string[], before: readonly string[]): boolean {
  return after[0] !== before[0] || after[1] !== before[1] || after[2] !== before[2]
}

/** Their-side hazards gained between the two runs. */
function gainedHazardsOnTheirSide(withState: BattleState, withoutState: BattleState): boolean {
  const w = withState.sides[1]
  const o = withoutState.sides[1]
  if (w.timers.spikesAmount > o.timers.spikesAmount) return true
  if (w.timers.toxicSpikesAmount > o.timers.toxicSpikesAmount) return true
  if (w.timers.stealthRockType !== 0 && o.timers.stealthRockType === 0) return true
  if (w.timers.stickyWebTimer > o.timers.stickyWebTimer) return true
  if (w.timers.caltrops && !o.timers.caltrops) return true
  if (w.timers.hotCoals && !o.timers.hotCoals) return true
  if (w.timers.foamyWeb && !o.timers.foamyWeb) return true
  const newBits = (w.statuses & SIDE_STATUS_HAZARDS_ANY) & ~(o.statuses & SIDE_STATUS_HAZARDS_ANY)
  return newBits !== 0
}

/** Opponent volatile fields handleDefenderMoveEndAbility writes onto the
 * attacker: Cursed Body's disable, Talon Trap / Itchy Defense's wrap, Supersweet
 * Syrup's embargo and Perish Body's perish counter. */
function opponentVolatileGained(after: BattlerState['volatiles'], before: BattlerState['volatiles']): boolean {
  if (after.disableTimer > before.disableTimer) return true
  if (after.disabledMove !== null && before.disabledMove === null) return true
  if (after.wrapTurns > before.wrapTurns) return true
  if (after.wrapAbility !== null && before.wrapAbility === null) return true
  if (after.embargoTimer > before.embargoTimer) return true
  if (after.perishSongTimer > before.perishSongTimer) return true
  return false
}

interface FodderBenefitContext {
  slot: number
  theirIndex: number
  hook: FodderHook
  abilitySlotIndex: number
  predictedMoveId: string | null
}

/** Anything the WITH run did to them, or for us, that the WITHOUT run did not.
 * MODEL CHOICE ("beneficial to us or detrimental to them is a gain for us"): any
 * gain counts, even when the same ability also costs something. */
function hasFodderBenefit(
  withProbe: BattleSession,
  withoutProbe: BattleSession,
  ctx: FodderBenefitContext,
): boolean {
  const w = withProbe.state
  const o = withoutProbe.state
  const wThem = theirMonView(w, ctx.theirIndex)
  const oThem = theirMonView(o, ctx.theirIndex)

  if (wThem.hp < oThem.hp) return true
  if ((wThem.status1 & ~oThem.status1) !== 0) return true
  if (statStagesBeat(wThem.statStages, oThem.statStages, 'lower')) return true
  if ((wThem.status2 & ~oThem.status2) !== 0) return true
  if ((wThem.statuses3 & ~oThem.statuses3) !== 0) return true
  if (oThem.itemId !== null && wThem.itemId === null) return true
  if (wThem.ability !== oThem.ability) return true
  if (typesChanged(wThem.types, oThem.types)) return true
  if (wThem.volatiles && oThem.volatiles && opponentVolatileGained(wThem.volatiles, oThem.volatiles)) return true
  // Forced out while still alive: the battler is no longer their original mon.
  if (!wThem.stillActive && oThem.stillActive && wThem.hp > 0) return true

  // Our side: the candidate is still the battler and gained a stat stage.
  const ourWith = w.battlers[0]
  const ourWithout = o.battlers[0]
  if (
    ourWith &&
    ourWithout &&
    ourWith.mon.hp > 0 &&
    ourWith.partyIndex === ctx.slot &&
    ourWithout.partyIndex === ctx.slot &&
    statStagesBeat(ourWith.mon.statStages, ourWithout.mon.statStages, 'higher')
  ) {
    return true
  }
  if (gainedHazardsOnTheirSide(w, o)) return true
  if (
    (w.field.weather !== o.field.weather || w.field.statuses !== o.field.statuses) &&
    fieldChangeBenefitsTeam(withoutProbe, withProbe, ctx.predictedMoveId)
  ) {
    return true
  }
  // Our HP only counts for onAbsorb: an unrelated ability must not turn damage
  // drift between two runs into a fake onDefender benefit.
  if (ctx.hook === 'onAbsorb' && ourWith && ourWithout && ourWith.mon.hp > ourWithout.mon.hp) return true
  if (ctx.hook === 'onRevive') {
    const latched = w.singleUseAbility[ctx.slot]?.[ctx.abilitySlotIndex]?.[0] ?? 0
    const wasLatched = o.singleUseAbility[ctx.slot]?.[ctx.abilitySlotIndex]?.[0] ?? 0
    if (latched !== 0 && wasLatched === 0) return true
  }
  return false
}

/** Runs the WITH / WITHOUT pair over the seeds; stops at the first seed that
 * shows a benefit. If none does, the WITH run's unmodelled notes are the gap
 * report when they name the ability. */
function evaluateFodderCandidate(
  session: BattleSession,
  slot: number,
  reserve: SimPartyMon,
  candidate: FodderCandidate,
  view: PredictionView,
  action: ChosenAction,
): { usable: boolean; missing: string | null } {
  const withoutReserve = reserveWithoutAbility(reserve, candidate.abilityId)
  const theirIndex = session.state.battlers[1]?.partyIndex ?? 0
  let missing: string | null = null
  for (let seed = 0; seed < FODDER_ABILITY_SEEDS; seed++) {
    const withProbe = fodderProbe(session, slot, reserve, seed)
    const withResult = stepTurn(withProbe, null, structuredClone(action))
    if (hasFodderBenefit(withProbe, fodderProbe(session, slot, withoutReserve, seed), {
      slot,
      theirIndex,
      hook: candidate.hook,
      abilitySlotIndex: candidate.slotIndex,
      predictedMoveId: view.predictedMoveId,
    })) {
      return { usable: true, missing: null }
    }
    const note = withResult.unmodelled.find((line) => line.includes(candidate.abilityId))
    if (note) missing = note
  }
  return { usable: false, missing }
}

/**
 * Which of a bench mon's abilities and innates fire usefully when it is hit,
 * touched or faints. The game decides applicability: the sim runs the predicted
 * turn twice on cloned sessions, once with the ability and once with it nulled,
 * and a gain in the WITH run marks it usable. No condition (contact, Long Reach,
 * canBeBurned, Clear Body, survival) is copied -- the ability's own port is the
 * only source of truth. `gaps` enumerates what the sim cannot evaluate.
 */
export function fodderAbilityTriggers(
  session: BattleSession,
  slot: number,
  view: PredictionView,
): FodderAbilityTriggers {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null || reserve.hp <= 0) return { usable: [], gaps: [] }

  const candidates = fodderCandidates(reserve)
  if (candidates.length === 0) return { usable: [], gaps: [] }

  const action = view.predictedAction
  const hasPrediction =
    action !== null && action.action === 'USE_MOVE' && Boolean(action.chosenMove?.id ?? action.moveToBeUsed?.id)

  const usable: string[] = []
  const gaps: FodderAbilityGap[] = []
  const pushGap = (gap: FodderAbilityGap): void => {
    if (!gaps.some((g) => g.abilityId === gap.abilityId && g.hook === gap.hook)) gaps.push(gap)
  }

  for (const candidate of candidates) {
    const staticGap = staticFodderGap(candidate.abilityId, candidate.hook)
    if (staticGap) {
      pushGap(staticGap)
      continue
    }
    if (!hasPrediction) continue
    const result = evaluateFodderCandidate(session, slot, reserve, candidate, view, action as ChosenAction)
    if (result.usable) {
      if (!usable.includes(candidate.abilityId)) usable.push(candidate.abilityId)
    } else if (result.missing) {
      pushGap({ abilityId: candidate.abilityId, hook: candidate.hook, missing: result.missing })
    }
  }

  return { usable, gaps }
}

/** sacrifice's fodder ranking key: a bench mon whose ability or innate fires
 * usefully when it is HIT, TOUCHED or FAINTS ranks first. MODEL CHOICE (owner,
 * 2026-11-26): the ability exception is one of the three switch reasons of
 * decision 14. */
function fodderAbilityTrigger(session: BattleSession, slot: number, view: PredictionView): boolean {
  return fodderAbilityTriggers(session, slot, view).usable.length > 0
}

/**
 * MODEL CHOICE: Mon usefulness evaluated for fodder ranking.
 * Parameter-free and lexicographic, no weights.
 */
export interface MonUsefulness {
  slot: number
  /** First key: can the mon KO their active mon (>= 50% KO chance) or set a pending effect? */
  capable: boolean
  /** Second key: (hp / maxHp) * min(1, bestAccuracyWeightedDamage / theirHp). */
  damageFraction: number
}

/**
 * Evaluates the usefulness of a mon (active or bench) against their active mon.
 * MODEL CHOICE: pure function evaluating moves, KO potential, and pending support effects.
 */
export function monUsefulness(
  session: BattleSession,
  slot: number,
  view: PredictionView,
): MonUsefulness {
  const active = session.state.battlers[0]
  const isActive = active !== null && active !== undefined && active.partyIndex === slot

  let mon: { hp: number; maxHp: number }
  let probe: BattleSession
  if (isActive) {
    mon = active.mon
    probe = session
  } else {
    const reserve = session.state.sides[0].party[slot]
    if (!reserve || reserve.hp <= 0 || reserve.speciesId === null) {
      return { slot, capable: false, damageFraction: 0 }
    }
    mon = reserve
    probe = cloneSession(
      { ...session, state: stateWithReserve(session.state, 0, reserve, slot) },
      FODDER_PROBE_SEED,
    )
  }

  const theirHp = theirActiveHp(probe)
  const moves = evaluateMoves(probe, null)

  const canKo = moves.some((info) => isKoMove(probe, info, theirHp))
  const canSetSupport = supportEffectPending(probe, view)
  const capable = canKo || canSetSupport

  let bestAccuracyWeighted = 0
  for (const info of moves) {
    const dmg = accuracyWeightedDamage(info)
    if (dmg > bestAccuracyWeighted) {
      bestAccuracyWeighted = dmg
    }
  }

  const hpRatio = mon.maxHp > 0 ? mon.hp / mon.maxHp : 0
  const damageRatio = theirHp > 0 ? Math.min(1, bestAccuracyWeighted / theirHp) : 0
  const damageFraction = hpRatio * damageRatio

  return { slot, capable, damageFraction }
}

/**
 * Checks whether bench mon `a` is strictly less useful than active mon `b`.
 * The slot number never counts between active and bench.
 * MODEL CHOICE: first key lower, or equal first key and lower second key.
 */
export function isStrictlyLessUseful(a: MonUsefulness, b: MonUsefulness): boolean {
  if (a.capable !== b.capable) {
    return !a.capable && b.capable
  }
  return a.damageFraction < b.damageFraction
}

/**
 * MODEL CHOICE: Comparator for mon usefulness / bench fodder ranking.
 * Ranks less useful mons first (better fodder); lower slot breaks ties between bench mons.
 * Returns negative if a ranks before b (a is better fodder / less useful),
 * positive if b ranks before a, or 0 if identical.
 */
export function compareUsefulness(a: MonUsefulness, b: MonUsefulness): number {
  if (a.capable !== b.capable) {
    return a.capable ? 1 : -1
  }
  if (a.damageFraction !== b.damageFraction) {
    return a.damageFraction < b.damageFraction ? -1 : 1
  }
  if (a.slot !== b.slot) {
    return a.slot < b.slot ? -1 : 1
  }
  return 0
}

function rankBenchFodder(
  session: BattleSession,
  slots: readonly number[],
  view: PredictionView,
): number[] {
  // Compute the trigger ONCE per slot, not inside the sort comparator: each one
  // runs the probe over seeds, so a comparator call would multiply the cost.
  const trigger = new Map<number, boolean>()
  for (const slot of slots) trigger.set(slot, fodderAbilityTrigger(session, slot, view))
  return slots.slice().sort((slotA, slotB) => {
    const trigA = trigger.get(slotA)!
    const trigB = trigger.get(slotB)!
    if (trigA !== trigB) return trigA ? -1 : 1
    return compareUsefulness(
      monUsefulness(session, slotA, view),
      monUsefulness(session, slotB, view),
    )
  })
}

/** sacrifice: our active mon is not staying under the stay test, their active mon
 * is alive, at least one living bench slot is a good counter that cannot enter safely,
 * and no good counter can enter safely. Fodder is chosen to either stay and attack
 * (default), or switch in a bench fodder mon if the active is needed later (preserve)
 * or a bench mon is strictly less useful. The faint hands the replacement a free entry.
 * MODEL CHOICE: fodder is a state, not a role. */
function ruleSacrifice(
  session: BattleSession,
  view: PredictionView,
  genes: TeamGenes,
): PlayerChoice | null {
  const theirHp = theirActiveHp(session)
  if (theirHp <= 0) return null

  const predictedMoveIds = view.predictedMoveId ? [view.predictedMoveId] : []
  const goodUnsafeCounters: BenchScore[] = []

  for (const slot of livingBenchSlots(session)) {
    const score = scoreBench(session, slot, predictedMoveIds, genes.switchInSafety)
    if (!score) continue
    if (isGoodCounter(session, slot, score, theirHp, view.predictedAction)) {
      const safe = acceptableSwitchIn(session, slot, predictedMoveIds, genes)
      if (safe !== null) {
        // A good counter can enter safely: sacrifice does not fire (counter handles it).
        return null
      }
      goodUnsafeCounters.push(score)
    }
  }

  if (goodUnsafeCounters.length === 0) return null

  const designatedCounter = pickBestBench(goodUnsafeCounters)!

  const benchFodderPool = livingBenchSlots(session).filter(
    (slot) => slot !== designatedCounter.slot && (genes.preserve === null || slot !== genes.preserve),
  )

  const active = session.state.battlers[0]
  if (!active) return null

  // Exception (a): active mon is needed later (preserve).
  if (genes.preserve !== null && active.partyIndex === genes.preserve) {
    if (benchFodderPool.length === 0) return null
    const ranked = rankBenchFodder(session, benchFodderPool, view)
    return switchChoice(session, ranked[0]!, view)
  }

  // Exception (b): some pool mon is strictly less useful than active mon.
  const activeUsefulness = monUsefulness(session, active.partyIndex, view)
  const strictlyLessUseful = benchFodderPool.filter((slot) => {
    const benchU = monUsefulness(session, slot, view)
    return isStrictlyLessUseful(benchU, activeUsefulness)
  })

  if (strictlyLessUseful.length > 0) {
    const ranked = rankBenchFodder(session, strictlyLessUseful, view)
    return switchChoice(session, ranked[0]!, view)
  }

  // Default 1: active mon stays and attacks.
  const moves = evaluateMoves(session, null)
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
 * `switchInSafety`% of its current HP AND threatens their active mon -- any of
 * its moves has a worst roll that KOs in two or fewer hits, or any of its moves
 * outspeeds with a mean roll of at least half their HP -- while our active mon
 * does neither: no move KOes in two AND no move outspeeds with heavy damage,
 * with `view.threatened` keeping a slower active mon eligible for the switch.
 * Pick the best such teammate by the replacement score and switch to it. No
 * predicted move: no fire.
 *
 * MODEL CHOICE: "heavy damage = a mean roll of at least half their HP" is a
 * threshold the player chose, not a game fact. */
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
  // Each side of the matchup decides over its WHOLE move list, so a mon that
  // threatens through any one move counts. "KO in two" is a floor question (as
  // everywhere else in decision 14): any move whose worst roll doubled reaches
  // their HP.
  const activeKoInTwo = damaging.some((info) => 2 * lowestRoll(info.range!) >= theirHp)
  // The active's own gate, as decision 14 puts it: no KO in two, and when it
  // does not outspeed it must be the one at risk. The move with the highest
  // WORST roll is the one that answers that.
  let activeBest: MoveChoiceInfo | null = null
  for (const info of damaging) {
    if (activeBest === null || lowestRoll(info.range!) > lowestRoll(activeBest.range!)) activeBest = info
  }
  const activeOutspeeds =
    activeBest !== null ? outspeeds(session, activeBest.choice.action, view.predictedAction) : false
  // Decision 14's other side of "does neither": outspeeding with heavy damage
  // (mean roll of at least half their HP) also threatens them, so a fast heavy
  // hitter must not be switched out just because its worst roll falls short of
  // the two-hit KO. Priority rides on the action, so Extreme Speed counts as
  // outspeeding even from a slower mon. The damage test runs first so
  // `outspeeds` only probes when it can matter. The bench side uses the same
  // test below via benchFastHeavy (battle_main.c:4386).
  const activeFastHeavy = damaging.some(
    (info) =>
      2 * meanRoll(info.range!) >= theirHp &&
      outspeeds(session, info.choice.action, view.predictedAction),
  )
  const activeDoesNeither = !activeKoInTwo && !activeFastHeavy && (activeOutspeeds || view.threatened)
  if (!activeDoesNeither) return null

  const candidates: BenchScore[] = []
  for (const slot of livingBenchSlots(session)) {
    const scored = acceptableSwitchIn(session, slot, [view.predictedMoveId], genes)
    if (!scored) continue
    if (!isGoodCounter(session, slot, scored, theirHp, view.predictedAction)) continue
    candidates.push(scored)
  }
  if (candidates.length === 0) return null
  return switchChoice(session, pickBestBench(candidates)!.slot, view)
}

/** entryAbility: a bench mon's switch-in ability applies now and the mon
 * qualifies under the switch-in rule (negligible loss under `switchInSafety`%
 * of current HP and no other move KOs with >= `otherMoveKoRisk`). A candidate
 * qualifies when it holds one of `ENTRY_ABILITIES_HANDLED`, satisfies the
 * switch-in rule, and one of:
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
    const scored = acceptableSwitchIn(
      session,
      slot,
      predictedMoveId ? [predictedMoveId] : [],
      genes,
    )
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
 * qualify under the switch-in rule (acceptable under `switchInSafety` and no
 * other move KOs with >= `otherMoveKoRisk`). */
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
    const scored = acceptableSwitchIn(session, slot, predictedIds, genes)
    if (!scored) continue
    candidates.push(scored)
  }
  if (candidates.length === 0) return null
  return switchChoice(session, pickBestBench(candidates)!.slot, view)
}

interface PpLoopIncoming {
  /** The largest highest-roll among their usable moves onto this mon, plus the
   * bench candidate's switch-in HP cost (0 for the active mon). */
  highest: number
  /** The mon's current HP. */
  hp: number
}

/** `probe` with `STATUS3_GASTRO_ACID` added to battler 0's statuses3: the state
 * Gastro Acid leaves behind before it poisons (Cmd_setgastroacid,
 * battle_script_commands.c:11831-11838). A copy of the battler and of the
 * battlers array -- the session's own state is never mutated. */
function withGastroAcid(probe: BattleSession): BattleSession {
  const battlers = probe.state.battlers.slice()
  const target = battlers[0]
  if (!target) return probe
  battlers[0] = { ...target, statuses3: target.statuses3 | STATUS3_GASTRO_ACID }
  return { ...probe, state: { ...probe.state, battlers } }
}

/** Whether their `moveId` can land a non-volatile status on our mon in `slot`
 * (the active mon, or a bench slot placed at battler 0 by `stateWithReserve`).
 * Such a foe does NOT qualify for the PP loop: `aiDamageRolls` is null for a
 * power-0 move, so every switch-in would take the status and the drain would
 * never become free. Battler 1 is the attacker and battler 0 the target.
 * Deliberately not covered: Bestow only psycho-shifts onto an ALREADY statused
 * target (battle_scripts_1.s:1392-1396, 1403-1405), so it never statuses a
 * clean mon; Toxic Spikes / Caltrops lay a field hazard rather than statusing
 * the move's target; and protecting moves that status on contact need us to
 * attack. Yawn is not a threat in a loop that switches every turn: setyawn only
 * sets STATUS3_YAWN_TURN(2) (battle_script_commands.c:11852), the sleep lands
 * on the SECOND end of turn (battle_util.c:2839-2842), and every switch except
 * Baton Pass clears gStatuses3 (battle_main.c:2834-2840; Baton Pass keeps only
 * the listed bits, YAWN not among them, :2822-2824), so it never sleeps
 * anyone. Damaging moves are untouched -- their damage already counts. */
function statusLandsOnUs(
  session: BattleSession,
  moveId: string,
  slot: number | 'active',
): boolean {
  const move = session.data.dataContext.move(moveId)
  if (!move || move.split !== 'STATUS' || !move.effect) return false
  const probe: BattleSession =
    slot === 'active'
      ? session
      : { ...session, state: stateWithReserve(session.state, 0, session.state.sides[0].party[slot]!, slot) }
  const deps = aiDamageDepsFor(probe.data, probe.state, probe.inverseBattle)
  switch (move.effect) {
    case 'EFFECT_TOXIC':
    case 'EFFECT_POISON':
    case 'EFFECT_WILL_O_WISP':
    case 'EFFECT_PARALYZE':
    case 'EFFECT_PARALYZE_IGNORE_TYPE':
    case 'EFFECT_SLEEP':
      return statusMoveWorks(probe, moveId, move.effect, 1, 0)
    case 'EFFECT_TOXIC_THREAD':
      // setmoveeffect MOVE_EFFECT_POISON, battle_scripts_1.s:1727-1728.
      return statusMoveWorks(probe, moveId, 'EFFECT_POISON', 1, 0)
    case 'EFFECT_GASTRO_ACID': {
      // BattleScript_EffectGastroAcid, battle_scripts_1.s:2581-2596: the user's
      // setgastroacid suppresses our ability BEFORE the poison step, so an
      // ability immunity cannot protect. An Ability Shield is the one case the
      // suppression really does not happen (Cmd_setgastroacid); adding the flag
      // when already suppressed is idempotent.
      // attackcanceler precedes setgastroacid: an immunity (e.g. Good As Gold) blocks it.
      if (blocksStatusMove(probe.state, 1, 0, moveId, deps)) return false
      const target = probe.state.battlers[0]
      if (!target) return false
      const gateProbe = doesBattlerHaveAbilityShield(target, deps) ? probe : withGastroAcid(probe)
      return statusMoveWorks(gateProbe, moveId, 'EFFECT_POISON', 1, 0)
    }
    case 'EFFECT_SPECTRAL_FLAME': {
      // BattleScript_EffectSpectralFlame, battle_scripts_1.s:2933-2955: outside
      // fog it is Will-O-Wisp; in fog the USER's setgastroacid suppresses our
      // ability before the burn.
      if (!isBattlerWeatherAffected(probe.state, 1, WEATHER_FOG_ANY, deps)) {
        return statusMoveWorks(probe, moveId, 'EFFECT_WILL_O_WISP', 1, 0)
      }
      if (blocksStatusMove(probe.state, 1, 0, moveId, deps)) return false
      const target = probe.state.battlers[0]
      if (!target) return false
      const gateProbe = doesBattlerHaveAbilityShield(target, deps) ? probe : withGastroAcid(probe)
      return statusMoveWorks(gateProbe, moveId, 'EFFECT_WILL_O_WISP', 1, 0)
    }
    case 'EFFECT_BLEED':
      // CanBleed, battle_util.c:5106-5114; BattleScript_EffectBleed :3115-3124.
      return canBleed(probe.state, 0, 1, deps)
    case 'EFFECT_FROSTBITE':
      // CanGetFrostbite, battle_util.c:5096-5104; BattleScript_EffectFrostbite :3127-3137.
      return canGetFrostbite(probe.state, 0, 1, deps)
    case 'EFFECT_PSYCHO_SHIFT': {
      // BattleScript_EffectPsychoShift, battle_scripts_1.s:1461-1465: their mon
      // must have a status, ours none, and our side no Safeguard. Then
      // VARIOUS_PSYCHO_SHIFT (battle_script_commands.c:7641-7677) by their
      // status.
      const theirs = probe.state.battlers[1]?.mon.status1 ?? 0
      const ours = probe.state.battlers[0]?.mon.status1 ?? 0
      if ((theirs & STATUS1_ANY) === 0 || (ours & STATUS1_ANY) !== 0) return false
      if (hasFlag(probe.state.sides[0].statuses, SIDE_STATUS_SAFEGUARD)) return false
      if (hasFlag(theirs, STATUS1_PARALYSIS)) return canBeParalyzed(probe.state, 1, 0, deps)
      // The C really calls CanBeParalyzed for poison and toxic too (:7653), not
      // a poison predicate; keep it.
      if (hasFlag(theirs, STATUS1_POISON_ANY)) return canBeParalyzed(probe.state, 1, 0, deps)
      if (hasFlag(theirs, STATUS1_BURN)) return canBeBurned(probe.state, 0, 1, deps)
      // Sleep, frostbite and bleed are copied whatever the predicate says (:7671-7679).
      return true
    }
    default:
      return false
  }
}

/** The HP a bench candidate pays to enter, or null when the entry would status
 * it. Both are read off one clone of the session with the candidate standing in
 * as battler 0 (`stateWithReserve` + `cloneSession`, the same probe shape
 * `entryProbeFor` / `ruleSupport` use); the real session and its RNG are never
 * touched.
 *
 * Hazards: `applySwitchInHazards` is the sim's own port of
 * VARIOUS_DO_HAZARD_DAMAGE (battle_script_commands.c:8711-8836) and already
 * knows Spikes, Stealth Rock, Toxic Spikes, Hot Coals and Caltrops, so the cost
 * is what the probe's HP lost, not a re-derivation. `probe.turnDeps` supplies
 * the `HazardDeps` surface (grounding, dataContext, hazardTypes). A move range
 * of 0 or an immunity does not waive this: entering still costs HP.
 *
 * Toxic Terrain: the ENDTURN_TOXIC_TERRAIN chip (battle_util.c:2124-2146,
 * maxHP/16 via `hpfractiontodamage BS_STACK_1, 16`,
 * data/battle_scripts_1.s:10167-10168) lands on the same probe AFTER the
 * hazards, so it is capped by the HP they left. The C decrements the timer
 * before the damage loop (:2127-2128): a timer of 1 clears the flag and chips
 * nobody, so a terrain about to expire adds nothing. A permanent terrain,
 * `started.terrain`, or Stench on the field also suppresses the decrement.
 *
 * A status: not a damage cost but a disqualification -- if the hazard port gave
 * a clean (`status1 === 0`) entrant a status, the loop cannot call the switch
 * free. That is the sim's own hazard port (Toxic Spikes at
 * battle_script_commands.c:8760-8787, plus Hot Coals / Caltrops at :8800-8836,
 * absorb and `CanBePoisoned`/`CanBeBurned`/`CanBleed` gates included), not a
 * re-derivation; a mon that already had a status stays eligible. */
function ppLoopSwitchInCost(session: BattleSession, slot: number): number | null {
  const reserve = session.state.sides[0].party[slot]
  if (!reserve || reserve.speciesId === null) return null
  const probe = cloneSession(
    { ...session, state: stateWithReserve(session.state, 0, reserve, slot) },
    PP_LOOP_PROBE_SEED,
  )
  const hpBefore = probe.state.battlers[0]?.mon.hp ?? 0
  if (hpBefore <= 0) return null

  const statusBefore = probe.state.battlers[0]?.mon.status1 ?? 0
  applySwitchInHazards(probe.state, 0, probe.turnDeps, [])
  const statusAfter = probe.state.battlers[0]?.mon.status1 ?? 0
  if (statusBefore === 0 && statusAfter !== 0) return null
  const hazardCost = hpBefore - (probe.state.battlers[0]?.mon.hp ?? 0)

  const terrainExpires =
    hasFlag(probe.state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN) &&
    !hasFlag(probe.state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) &&
    !probe.state.field.timers.started.terrain &&
    !isAbilityOnField(probe.state, 'ABILITY_STENCH') &&
    probe.state.field.timers.terrainTimer === 1
  const terrainCost = terrainExpires ? 0 : toxicTerrainDamage(probe.state, 0, probe.turnDeps.grounding)
  return hazardCost + terrainCost
}

/** The largest highest-roll their usable moves can land on our active mon
 * (battler 0) or a bench slot -- plus, for a bench slot, the `highest` value
 * also carries the switch-in cost from `ppLoopSwitchInCost` (hazards and Toxic
 * Terrain) -- and that mon's current HP. Null when they have no usable move (at
 * least one is required), the mon is not alive, any usable move can land a
 * non-volatile status on it (`statusLandsOnUs`), or the sim's hazard port would
 * give the bench entry a status. A null or immune range contributes zero. */
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
    if (statusLandsOnUs(session, moveId, slot)) return null
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
  if (slot !== 'active') {
    const switchInCost = ppLoopSwitchInCost(session, slot)
    if (switchInCost === null) return null
    highest += switchInCost
  }
  return { highest, hp }
}

function takesLittleOrNothing(incoming: PpLoopIncoming | null): incoming is PpLoopIncoming {
  return incoming !== null && incoming.highest * 100 <= PP_LOOP_LITTLE_PCT * incoming.hp
}

/** ppLoop: two of our mons both take little or nothing from every move their
 * mon has, so alternate them to drain its PP. Fires only when the ACTIVE mon
 * and at least one bench slot both qualify, and switches to the qualifying slot
 * whose worst-case fraction of HP is smallest (ties go to the lower slot). A
 * bench slot's worst case includes its switch-in cost (`ppLoopSwitchInCost`:
 * entry hazards and Toxic Terrain, measured on a cloned probe; a status the
 * hazard port gives the entrant disqualifies outright). The stall tracker
 * (updated on every `policy` call)
 * latches `stopped` once both sides have switched for `PP_LOOP_STALL_LIMIT`
 * turns with no HP or PP change; the latch survives later turns and only a
 * non-consecutive turn clears it. */
function rulePpLoop(
  session: BattleSession,
  view: PredictionView,
  stopped: boolean,
): PlayerChoice | null {
  if (stopped) return null
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
    otherMoveKoRisk: config.genes?.otherMoveKoRisk ?? DEFAULT_TEAM_GENES.otherMoveKoRisk,
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
  // Role memory belongs to one battler OBJECT, not a party index: every
  // switch-in builds a fresh battler (`state.battlers[battlerId] = newBattler`,
  // switchIn.ts:232) and the game clears the last move there
  // (`gLastResultingMoves[gActiveBattler] = 0`, battle_main.c:2903). An identity
  // check also covers a faint replacement, a new game on a reused layer, and a
  // mon that left and came back between two calls with an unchanged party index.
  let memoryOwner: BattlerState | null = null
  let memory: RoleMemory = { turn: 0, lastMove: null }

  // The replacement callback receives only the state (session.ts:268-274), so
  // the last session `policy` saw is kept here and the faint's state is spliced
  // into it: `predictAi` / `cloneSession` rebuild their deps from the state
  // they are handed, so `{ ...lastSession, state }` is a valid probe.
  let lastSession: BattleSession | null = null

  // The PP loop's stall tracker, updated on EVERY policy call before the
  // purpose loop (whichever purpose fires), as decision 14's stop rule needs.
  let ppLoopStallCount = 0
  // Latched once the stop rule fires: the turn AFTER a stop is never a stalled
  // double switch (our role rule moves, our PP drops), so without the latch the
  // count would reset and the loop would fire again -- four swaps, one role
  // turn, four swaps, forever.
  let ppLoopStopped = false
  let ppLoopPrevious: PpLoopSnapshot | null = null

  const observePpLoopStall = (session: BattleSession, turn: number): void => {
    const current = ppLoopSnapshot(session, turn)
    if (ppLoopPrevious !== null) {
      // A non-consecutive turn is the "new game on a reused layer" signal, and
      // it is the ONLY thing that clears the latch. One stalled turn: the next
      // turn in sequence, BOTH actives changed, and neither side's HP or PP
      // moved. Anything else resets the count -- but leaves the latch set.
      if (turn !== ppLoopPrevious.turn + 1) ppLoopStopped = false
      const stalled =
        turn === ppLoopPrevious.turn + 1 &&
        current.ourPartyIndex !== ppLoopPrevious.ourPartyIndex &&
        current.theirPartyIndex !== ppLoopPrevious.theirPartyIndex &&
        current.ourHp === ppLoopPrevious.ourHp &&
        current.theirHp === ppLoopPrevious.theirHp &&
        current.ourPp === ppLoopPrevious.ourPp &&
        current.theirPp === ppLoopPrevious.theirPp
      ppLoopStallCount = stalled ? ppLoopStallCount + 1 : 0
      if (ppLoopStallCount >= PP_LOOP_STALL_LIMIT) ppLoopStopped = true
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
    // A new battler object means a switch-in: start the memory over.
    if (active !== memoryOwner) {
      memoryOwner = active
      memory = { turn: 0, lastMove: null }
    }
    // One prediction per call, at the role layer's own safety line, shared by
    // every purpose (decision 14: the same view feeds every rule).
    const view = readPredictions(session, DEFAULT_SAFETY_PCT)
    const stay = stayTest(session, view)

    if (!stay.stay || !stay.outspeedsWithKo) {
      for (const purpose of genes.purposeOrder) {
        if (!genes.purposeFlags[purpose]) continue
        if (stay.stay && purpose !== 'preserve') continue
        let choice: PlayerChoice | null = null
        switch (purpose) {
          case 'preserve':
            choice = rulePreserve(session, view, genes)
            break
          case 'sacrifice':
            choice = ruleSacrifice(session, view, genes)
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
            choice = rulePpLoop(session, view, ppLoopStopped)
            break
        }
        if (choice) {
          // A purpose-decided move is this battler's last move too, or the next
          // call's `usedProtectionLastTurn` fallback would see the stale one.
          memory.turn = session.state.turnCount + 1
          memory.lastMove = moveIdOf(choice)
          trace.push({ turn, choice: describePurpose(purpose, choice), tags: ['team', purpose] })
          return choice
        }
      }
    }

    const partyIndex = active.partyIndex
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
