// Orchestration: BattleAI_SetupAIData (battle_ai_main.c:158-188),
// ChooseMoveOrAction_Singles (:270-339), ChooseMoveOrAction_Doubles (:341-440),
// BattleAI_DoAIProcessing (:442-474), ComputeBattleAiScores (:208-212), the
// singles-only half of BattleAI_ChooseMoveOrAction (:190-205), and the second
// switch check embedded in ChooseMoveOrAction_Singles (:294-318).
//
// The doubles chooser is ported as of dbl-4a (cycle 3d3p) but NOT wired into
// any live path: `chooseAiAction` still calls the singles half only (that is
// dbl-4d). AI_DoubleBattle's own scoring is ported as of dbl-4b (cycle 3d3q,
// aiDoubleBattle.ts), and its partner-target DAMAGE GATE and ability loop
// (:2303-2398) landed in dbl-4b2 (cycle 3d3r); the partner-target
// attack-effect switch (:2395-2482) landed in dbl-4b3 (cycle 3d3s).
// `AI_DATA->partnerMove = GetAllyChosenMove()`
// (:368) is still not filled by the chooser itself: aiDoubleBattle reads
// `state.chosenMovePositions` through `getAllyChosenMove` directly, which is
// the same value the chooser's own copy would hold (wiring it is dbl-4b), and
// `IsValidDoubleBattle` is a real check as of dbl-4c (cycle 4c1), alongside the
// five partner helpers that need no `moveTarget`; the three that read
// `gBattleStruct->moveTarget` are real as of dbl-4c2 (cycle 4c2).
//
// AI_CheckBadMove PART 1 is wired for real as of the ai-checkbadmove-1 batch
// (aiCheckBadMove.ts, battle_ai_main.c:488-1298 through EFFECT_PERISH_SONG).
// AI_CheckViability PART 1 (battle_ai_main.c:2515-3223, through
// EFFECT_PERISH_SONG) is wired for real as of the ai-checkviability-1 batch
// (aiCheckViability.ts). Part 2 (:3224-3986, EFFECT_SANDSTORM through the
// function's end) still falls through `applyMoveEffectSwitch`'s own `default`
// case there, which reports a named per-effect gap rather than silently
// scoring 0 -- see that module's own header.

import type { BattleState, BattlerState } from '../state'
import type { BaseStats } from '../../types'
import { BATTLE_TYPE_DOUBLE, hasFlag, PARTY_SIZE, STATUS2_ESCAPE_PREVENTION, STATUS2_WRAPPED, STATUS3_ROOTED, STATUS4_COMMANDED } from '../constants'
import { AI_FLAG_CHECK_BAD_MOVE, AI_FLAG_CHECK_VIABILITY, AI_FLAG_PREFER_BATON_PASS, AI_FLAG_TRY_TO_FAINT } from './aiFlags'
import { aiHPAware, aiRisky, aiTryToFaint } from './aiScorers'
import { aiCheckBadMove } from './aiCheckBadMove'
import { aiCheckViability } from './aiCheckViability'
import { aiDoubleBattle } from './aiDoubleBattle'
import { getMostSuitableMonToSwitchInto, type AiSwitchingDeps } from './aiSwitching'
import type { AiDamageDeps } from './aiCalcDamage'
import { computeMoveLimitations } from './aiMoveLimitations'
import { isAbilityPreventingEscape } from '../escape'
import { countUsablePartyMons } from './aiAbilityHelpers'

/** include/constants/battle.h:18, 66. Same values aiSwitching.ts's own module
 * header cites (BATTLE_TYPE_ARENA) and state.ts's aiFlags doc cites
 * (BATTLE_TYPE_PALACE, which SHARES A BIT with AI_FLAG_DISABLE_SWITCHING --
 * the known dead-flag bug, reproduced not fixed, see state.ts). */
const BATTLE_TYPE_ARENA = 1 << 18
const BATTLE_TYPE_PALACE = 1 << 17

/** MOVE_POWER-style stub score, unchanged. */
type ScorerResult = { score: number; unmodelled: string[] }
type Scorer = (state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, moveIndex: number, score: number, deps: AiDamageDeps) => ScorerResult

/** sBattleAiFuncTable, battle_ai_main.c:60-93 -- restricted to the bits this
 * batch's `state.aiFlags` can ever carry (this module's own aiFlags finding:
 * every trainer's aiFlags is CHECK_BAD_MOVE|TRY_TO_FAINT|CHECK_VIABILITY|
 * CHECK_FOE|SMART_SWITCHING|HP_AWARE|WILL_SUICIDE, plus RISKY/STALL/
 * PREFER_STATUS_MOVES/DISABLE_SWITCHING per trainer -- never SETUP_FIRST_TURN,
 * PREFER_STRONGEST_MOVE or PREFER_BATON_PASS). Bits with no entry here behave
 * exactly like the C's own NULL table slots: BattleAI_DoAIProcessing's dispatch
 * guard (`sBattleAiFuncTable[aiLogicId] != NULL`) skips them, leaving the score
 * unchanged for that pass -- whether the C's own table slot is truly NULL (bits
 * 9, 11-14, 17-28) or non-NULL but never reached by a trainer's aiFlags (bits
 * 3, 5, 6, 29-31), the OBSERVABLE effect on a trainer battle's scores is
 * identical, so this table only needs entries for bits a trainer can set.
 * Bit 7 (AI_FLAG_DOUBLE_BATTLE) now has an entry; only a doubles trainer's
 * aiFlags sets it (BattleAI_SetupFlags' forcedDouble OR). */
const DISPATCH: Record<number, Scorer> = {
  0: (s, a, d, m, _i, sc, deps) => aiCheckBadMove(s, a, d, m, sc, deps), // AI_FLAG_CHECK_BAD_MOVE -- part 1 (this batch), part 2 to follow
  1: (s, a, d, m, i, sc, deps) => aiTryToFaint(s, a, d, m, i, sc, deps), // AI_FLAG_TRY_TO_FAINT
  2: (s, a, d, m, i, sc, deps) => aiCheckViability(s, a, d, m, sc, deps, i), // AI_FLAG_CHECK_VIABILITY -- part 1 (this batch), part 2 to follow
  4: (s, a, d, m, _i, sc, deps) => aiRisky(s, a, d, m, sc, deps), // AI_FLAG_RISKY
  // AI_FLAG_DOUBLE_BATTLE -- AI_DoubleBattle, complete since dbl-4b3
  // (cycle 3d3s): the partner-target attack-effect switch (:2395-2482) is
  // ported.
  7: (s, a, d, m, i, sc, deps) => aiDoubleBattle(s, a, d, m, i, sc, deps),
  8: (s, a, d, m, _i, sc, deps) => aiHPAware(s, a, d, m, sc, deps), // AI_FLAG_HP_AWARE
}

/**
 * BattleAI_SetupAIData, battle_ai_main.c:158-188, called as
 * `BattleAI_SetupAIData(0xF)` by ComputeBattleAiScores -- every score slot
 * starts at 100. `AI_DATA->moveLimitations` (Taunt/Disable/Torment/Imprison/
 * heal-block-style move limitations) is computed for real as of cycle 98
 * (`computeMoveLimitations`, aiMoveLimitations.ts, CheckMoveLimitations
 * battle_util.c:1622-1666) and zeroes every flagged score slot exactly like the
 * C's own `if (gBitTable[i] & moveLimitations) score[i] = 0` (:185-187).
 *
 * The C memsets AI_THINKING_STRUCT before scoring (:164), which also clears
 * `switchMon` (the persistent "step 1 chose AI_CHOICE_SWITCH" flag consumed by
 * ShouldSwitchIfAllBadMoves); `state.aiSwitchMon` is reset here for that reason.
 *
 * `gBattlerTarget = SetRandomTarget(sBattler_AI)` (:186) is NOT a caller
 * responsibility to seed RNG for: SetRandomTarget (battle_util.c:6326-6341)
 * only draws `Random() % 2` inside its `BATTLE_TYPE_DOUBLE` branch, which this
 * singles-only sim never takes -- the else branch is a pure function of side,
 * `targets[side][0]`, equal to `battlerId ^ 1` in singles. No RNG draw.
 */
export function setupAiScores(state: BattleState, battlerAtk: number, deps: AiDamageDeps): { scores: [number, number, number, number]; unmodelled: string[] } {
  // :164-166 -- memset preserves only aiFlags; switchMon goes back to FALSE.
  state.aiSwitchMon = false
  const battler = state.battlers[battlerAtk]
  const scores: [number, number, number, number] = [100, 100, 100, 100]
  if (!battler) return { scores, unmodelled: [] }
  const limits = computeMoveLimitations(state, battlerAtk, deps)
  // :183-187.
  for (let i = 0; i < 4; i++) {
    if (limits.mask & (1 << i)) scores[i] = 0
  }
  return { scores, unmodelled: limits.unmodelled }
}

/** SetRandomTarget's singles-only else branch, battle_util.c:6337 -- see
 * `setupAiScores`'s own doc for why this draws no RNG. */
export function setRandomTargetSingles(battlerAtk: number): number {
  return battlerAtk ^ 1
}

/** include/constants/battle.h:45-46. */
const BIT_SIDE = 1
const BIT_FLANK = 2

/** IsBattlerAlive, battle_util.c:6685-6694. A local copy of turn.ts's export of
 * the same: turn.ts -> ai/chooseAiAction -> this module, so importing back from
 * turn.ts would close a runtime cycle. The absent-battler test is what makes a
 * replaced battler read as fainted here (docs/battle-sim/doubles-plan.md step
 * 2.5) -- its slot keeps hp > 0 while `gAbsentBattlerFlags` holds its bit.
 * Exported for aiDoubleBattle.ts's GetAllyChosenMove and EFFECT_HAIL branches
 * rather than copied a third time. */
export function isBattlerAlive(state: BattleState, battlerId: number): boolean {
  if (battlerId >= state.battlersCount) return false
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) return false
  return !hasFlag(state.absentBattlerFlags, 1 << battlerId)
}

/**
 * SetRandomTarget, battle_util.c:6326-6341 -- the same table and rules as
 * turn.ts's own closure (:908-926), duplicated here for the cycle reason above.
 * In a double this draws `Random() % 2` exactly once (:6334); a dead pick flips
 * to the flank with `^ BIT_FLANK` and the C does NOT re-check the flank (:6335-
 * 6336), so two fainted foes still yield one of them. Singles draws nothing and
 * takes the left entry (`targets[side][0]`, :6337).
 */
export function setRandomTarget(state: BattleState, battlerId: number): number {
  const side = battlerId & BIT_SIDE // GetBattlerSide
  const targets = [
    [1, 3], // B_SIDE_PLAYER -> B_POSITION_OPPONENT_LEFT, B_POSITION_OPPONENT_RIGHT
    [0, 2], // B_SIDE_OPPONENT -> B_POSITION_PLAYER_LEFT, B_POSITION_PLAYER_RIGHT
  ]
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_DOUBLE)) {
    const target = targets[side][state.rng.random16() % 2]
    return isBattlerAlive(state, target) ? target : target ^ BIT_FLANK
  }
  return targets[side][0]
}

/**
 * BattleAI_DoAIProcessing, battle_ai_main.c:442-474 -- one pass over all four
 * move slots for ONE aiLogicId (flag bit). A slot whose move is MOVE_NONE or
 * whose PP is 0 gets its score forced to 0 EVERY pass (moveConsidered==0 at
 * :449, which the C's own AIState_Processing branch at :462-464 turns into
 * `score[i] = 0` unconditionally) -- so this is re-checked every call rather
 * than assumed to stay zeroed from `setupAiScores`.
 */
export function doAiProcessing(state: BattleState, battlerAtk: number, battlerDef: number, bit: number, scores: [number, number, number, number], deps: AiDamageDeps): string[] {
  const unmodelled: string[] = []
  const battler = state.battlers[battlerAtk]
  if (!battler) return unmodelled
  const scorer = DISPATCH[bit]

  for (let i = 0; i < 4; i++) {
    const moveId = battler.mon.moves[i]
    const usable = !!moveId && battler.mon.pp[i] !== 0
    if (!usable || scores[i] <= 0) {
      scores[i] = 0
      continue
    }
    if (scorer) {
      const result = scorer(state, battlerAtk, battlerDef, moveId as string, i, scores[i], deps)
      scores[i] = result.score
      unmodelled.push(...result.unmodelled)
    }
    // A bit with no dispatch entry (this table's own doc) leaves scores[i]
    // unchanged, matching the C's NULL-slot skip.
  }
  return unmodelled
}

/**
 * ComputeBattleAiScores, battle_ai_main.c:208-212 + BattleAI_ChooseMoveOrAction's
 * singles half (:190-205) -- iterates every set bit in `state.aiFlags` from bit
 * 0 upward (the C's own `while (flags) { if (flags&1) DoAIProcessing(); flags
 * >>= 1; aiLogicId++ }`), running `doAiProcessing` for each. The C's own
 * `gRoundStructs[gActiveBattler]` memset-except-protectMove (:200-201) has no
 * effect on scoring (it runs AFTER scores are already finalised, before
 * returning), so it is not reproduced by this scoring function -- a caller
 * driving a real RoundState reset does that itself, the same layering
 * `executeTurn` already uses for round-state resets elsewhere.
 */
export function computeBattleAiScores(state: BattleState, battlerAtk: number, battlerDef: number, deps: AiDamageDeps): { scores: [number, number, number, number]; unmodelled: string[] } {
  const setup = setupAiScores(state, battlerAtk, deps)
  const scores = setup.scores
  const unmodelled = [...setup.unmodelled]
  const aiFlags = state.aiFlags

  for (let bit = 0; bit < 32; bit++) {
    if (!hasFlag(aiFlags, 1 << bit)) continue
    unmodelled.push(...doAiProcessing(state, battlerAtk, battlerDef, bit, scores, deps))
  }

  return { scores, unmodelled }
}

export { isAbilityPreventingEscape }
export { countUsablePartyMons }

/** GetTotalBaseStat -- reused from species data via `deps.dataContext.species`
 * (SimSpeciesData.baseStats, engine/sim/dataContext.ts). */
function getTotalBaseStat(baseStats: BaseStats): number {
  return Object.values(baseStats).reduce((a: number, b: number) => a + b, 0)
}

export type AiChoice = { kind: 'switch' } | { kind: 'move'; moveIndex: number }

/**
 * ChooseMoveOrAction_Singles, battle_ai_main.c:270-339 -- the second switch
 * check (:294-318) plus the tie-break (:320-338). `AI_ACTION_FLEE`/`AI_ACTION_
 * WATCH` (:295-296, Roaming/Safari-only actions this batch's aiFlags can never
 * set -- AI_Roaming/AI_Safari are never dispatched, see DISPATCH's own doc) are
 * not checked, since `state.aiFlags` can never carry AI_FLAG_ROAMING/SAFARI on
 * a trainer battle.
 *
 * The second switch check's own guard skips `STATUS3_ROOTED`/`STATUS4_COMMANDED`/
 * `skyDropped`/`fear`/wrap-or-escape-prevention/BATTLE_TYPE_ARENA|PALACE exactly
 * as the C does.
 */
export function chooseMoveOrActionSingles(state: BattleState, battlerAtk: number, scores: [number, number, number, number], deps: AiSwitchingDeps): { choice: AiChoice; unmodelled: string[] } {
  const unmodelled: string[] = []
  const battler = state.battlers[battlerAtk] as BattlerState

  const gateFlags = AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_BAD_MOVE | AI_FLAG_TRY_TO_FAINT | AI_FLAG_PREFER_BATON_PASS
  const usableParty = countUsablePartyMons(state, battlerAtk)
  const escapeCheck = isAbilityPreventingEscape(state, battlerAtk, deps)
  unmodelled.push(...escapeCheck.unmodelled)

  const canConsiderSwitch =
    usableParty > 0 &&
    !escapeCheck.prevents &&
    !hasFlag(battler.mon.status2, STATUS2_WRAPPED | STATUS2_ESCAPE_PREVENTION) &&
    !hasFlag(battler.statuses3, STATUS3_ROOTED) &&
    !hasFlag(battler.statuses4, STATUS4_COMMANDED) &&
    !battler.volatiles.skyDropped &&
    !battler.volatiles.fear &&
    !hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA | BATTLE_TYPE_PALACE) &&
    hasFlag(state.aiFlags, gateFlags)

  if (canConsiderSwitch) {
    const species = deps.dataContext.species(battler.mon.speciesId)
    const bst = species ? getTotalBaseStat(species.baseStats) : 0
    const notWeak = bst >= 310 && battler.mon.hp >= Math.floor(battler.mon.maxHp / 2)
    if (notWeak) {
      const cap = hasFlag(state.aiFlags, AI_FLAG_CHECK_VIABILITY) ? 95 : 93
      const allBelowCap = scores.every((s) => s <= cap)
      if (allBelowCap) {
        const result = getMostSuitableMonToSwitchInto(state, battlerAtk, deps)
        unmodelled.push(...result.unmodelled)
        if (result.partyIndex !== PARTY_SIZE) {
          // battle_ai_main.c:313-315 -- `AI_THINKING_STRUCT->switchMon = TRUE;`
          // before returning AI_CHOICE_SWITCH. Consumed by
          // ShouldSwitchIfAllBadMoves (battle_ai_switch_items.c:49-62) in the
          // same chooseAiAction call.
          state.aiSwitchMon = true
          return { choice: { kind: 'switch' }, unmodelled }
        }
      }
    }
  }

  // Tie-break, :320-338. Only slots with an actual move (MOVE_NONE excluded,
  // matching `gBattleMons[sBattler_AI].moves[i] != MOVE_NONE` at :325) compete.
  // The C seeds currentMoveArray[0]/consideredMoveArray[0] from slot 0
  // UNCONDITIONALLY (:321-322), even if slot 0 is MOVE_NONE -- then the loop
  // from i=1 only ever ADDS to or REPLACES consideredMoveArray, never removes
  // slot 0 for being MOVE_NONE. A MOVE_NONE slot 0 therefore stays eligible
  // for the final `Random() % numOfBestMoves` pick whenever no other slot's
  // score exceeds its (forced-to-0) score, an observable oddity this port
  // reproduces rather than "fixes" -- matching aiSwitching.ts's own precedent
  // for a transcribed rather than corrected bug.
  let bestScore = scores[0]
  let bestIndices = [0]
  for (let i = 1; i < 4; i++) {
    if (battler.mon.moves[i] === null) continue
    if (scores[i] === bestScore) {
      bestIndices.push(i)
    } else if (scores[i] > bestScore) {
      bestScore = scores[i]
      bestIndices = [i]
    }
  }

  const pick = bestIndices[state.rng.random16() % bestIndices.length]
  return { choice: { kind: 'move', moveIndex: pick }, unmodelled }
}

/**
 * ChooseMoveOrAction_Doubles, battle_ai_main.c:341-440 -- one scoring pass per
 * live battler that is not the AI itself, then one target pick over those
 * battlers' best move scores. dbl-4a: NOT wired into `chooseAiAction` (dbl-4d),
 * and the ally-facing half is still missing: `AI_DATA->partnerMove =
 * GetAllyChosenMove()` (:368) is dbl-4b, and the partner-gated helpers the
 * scorers call (`isValidDoubleBattle`, aiCheckBadMove.ts) landed in dbl-4c
 * (cycle 4c1); the three that need `gBattleStruct->moveTarget` are real as of
 * dbl-4c2. The flags
 * this cycle's own tests dispatch (AI_FLAG_HP_AWARE, or none) read neither.
 *
 * ORDERING, which the caller's RNG stream depends on. Per live non-self `i`
 * (:353-356 skip, :358-361 setup): `setupAiScores`'s score reset (BattleAI_SetupAIData, :361),
 * then SetRandomTarget's single draw (:186 inside SetupAIData; its return value
 * is discarded because :363 overwrites gBattlerTarget with `i` -- ONLY the draw
 * is observable), then one `doAiProcessing` per set `state.aiFlags` bit with
 * `battlerDef = i` (:371-380, bit 0 upward), then the move tie-break's draw
 * (:404, ONE draw even when only one slot is best). After the loop, exactly one
 * more draw for the target (`Random() % mostViableTargetsNo`, :437).
 *
 * NO DAMAGE CACHE, deliberately: `AI_DATA->simulatedDmg` / `->effectiveness`
 * (GetAiLogicData, :223-268; written back write-only at :414-417) is a
 * battle-start copy of AI_CalcDamage, and this sim recomputes the same triple
 * on demand (aiScorers.ts's header). GetAiLogicData fills it for every alive
 * AI-controlled attacker against EVERY other battler -- its own ally included,
 * :245-246 -- which is exactly what `battlerDef = i` asks aiCalcDamage for here. So
 * no new state field and no cache: the numbers are the cache's numbers.
 * `aiFinalScore` (:415) has no reader anywhere.
 *
 * Quirks reproduced, not fixed (they match chooseMoveOrActionSingles' own):
 * slot 0 seeds the tie-break unconditionally, even when `moves[0]` is
 * MOVE_NONE (:387-403); the target loop seeds from index 0 unconditionally, so
 * the AI itself (0xFF action, -1 points) and fainted battlers are candidates
 * whenever every score is -1 or ties (:421-435); the ally's dead-zone is
 * `best < 100` -- strict, so exactly 100 survives (:407-411).
 *
 * NOT modelled, by scope: `AI_ACTION_FLEE`/`AI_ACTION_WATCH` (:382-385) cannot
 * be set by any trainer flag (same reasoning as chooseMoveOrActionSingles);
 * the `BATTLE_TYPE_PALACE` `palaceFlags >> 4` branch (:359-360); and
 * `RecordLastUsedMoveByTarget` (:366, `RecordKnownMove(gBattlerTarget,
 * gLastMoves[gBattlerTarget])`, battle_ai_util.c:446) -- the sim has no
 * known-move/`RecordKnownMove` store at all, so there is no helper to call and
 * this stays a named gap.
 */
export function chooseMoveOrActionDoubles(state: BattleState, battlerAtk: number, deps: AiSwitchingDeps): { moveIndex: number | null; target: number; unmodelled: string[] } {
  const unmodelled: string[] = []
  const aiMon = state.battlers[battlerAtk]
  const actionOrMoveIndex: (number | null)[] = [null, null, null, null] // null == 0xFF
  const bestMovePointsForTarget = [-1, -1, -1, -1]

  for (let i = 0; i < 4; i++) {
    // :353-356 -- self and fainted battlers are never scored; their 0xFF/-1 row
    // can still WIN the target pick below, because -1 ties with -1.
    if (i === battlerAtk || !isBattlerAlive(state, i)) {
      actionOrMoveIndex[i] = null
      bestMovePointsForTarget[i] = -1
      continue
    }

    const setup = setupAiScores(state, battlerAtk, deps)
    const scores = setup.scores
    unmodelled.push(...setup.unmodelled)

    // :361 + :186 -- BattleAI_SetupAIData(0xF) ends with SetRandomTarget, whose
    // draw is the only effect that survives :363's overwrite.
    setRandomTarget(state, battlerAtk)

    // :369-380 -- `flags >>= 1` per pass, so bit 0 first.
    for (let bit = 0; bit < 32; bit++) {
      if (!hasFlag(state.aiFlags, 1 << bit)) continue
      unmodelled.push(...doAiProcessing(state, battlerAtk, i, bit, scores, deps))
    }

    // :390-403 -- two independent comparisons in this order: equal appends to the
    // tie list, strictly greater resets it. Slot 0 seeds both unconditionally.
    let best = scores[0]
    const indices = [0]
    for (let j = 1; j < 4; j++) {
      if (!aiMon || aiMon.mon.moves[j] === null) continue // MOVE_NONE (:391)
      if (scores[j] === best) indices.push(j)
      if (scores[j] > best) {
        best = scores[j]
        indices.length = 0
        indices.push(j)
      }
    }

    actionOrMoveIndex[i] = indices[state.rng.random16() % indices.length] // :404
    bestMovePointsForTarget[i] = best
    // :407-411 -- Don't use a move against the ally unless it scores at least 100.
    if (i === (battlerAtk ^ BIT_FLANK) && bestMovePointsForTarget[i] < 100) bestMovePointsForTarget[i] = -1
  }

  // :421-435 -- same unconditional-index-0 seed as the move tie-break above.
  let mostMovePoints = bestMovePointsForTarget[0]
  let targets = [0]
  for (let i = 1; i < 4; i++) {
    if (mostMovePoints === bestMovePointsForTarget[i]) targets.push(i)
    if (mostMovePoints < bestMovePointsForTarget[i]) {
      mostMovePoints = bestMovePointsForTarget[i]
      targets = [i]
    }
  }

  // :437 -- ONE draw, always, even with a single viable target. :438 writes
  // gBattleStruct->aiChosenTarget; the sim has no such field, so the caller
  // takes the returned target instead.
  const target = targets[state.rng.random16() % targets.length]
  return { moveIndex: actionOrMoveIndex[target], target, unmodelled }
}
