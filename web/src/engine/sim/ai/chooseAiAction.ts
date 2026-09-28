// chooseAiAction: the AI's entry point. Ports battle_main.c:3636-3639
// (STATE_TURN_START_RECORD: "Do AI score computations here so we can use them
// in AI_TrySwitchOrUseItem" -- ComputeBattleAiScores/ChooseMoveOrAction_Singles
// run FIRST, including the tie-break RNG and the scoring's own second switch
// check) together with battle_controller_opponent.c:1557-1568
// (OpponentHandleChooseAction -> AI_TrySwitchOrUseItem, THEN
// OpponentHandleChooseMove reading gBattleStruct->aiMoveOrAction). See
// aiShouldSwitch.ts for ShouldSwitch/ShouldUseItem's own port (cycle 15).
//
// CYCLE15 FIX PASS (this file): the original cycle15 pass had this backwards
// -- it ran AI_TrySwitchOrUseItem BEFORE move scoring, scoring only when it
// didn't switch. cycle13's diagnose-output.md §2 correction (lead-verified)
// established the real order is scoring FIRST, matching STATE_TURN_START_RECORD
// running before STATE_BEFORE_ACTION_CHOSEN's CHOOSEACTION dispatch. This pass
// reorders to match: `state.rng` is now drawn in the order score->tie-break->
// ShouldSwitch's own helpers, not the reverse.
//
// WIRING: in the real game the AI decides its action BEFORE the player's menu
// even opens (there is no "the AI reacts to what the player chose" step at
// selection time -- both sides commit, then turn order decides who acts
// first). This sim's `executeTurn` (turn.ts) takes already-chosen actions, so
// `chooseAiAction` runs BEFORE `executeTurn`, not inside it, and its result
// feeds straight into the `actions` array `executeTurn` is called with --
// `executeTurn`'s own signature is unchanged by this batch.

import type { AiSwitchingDeps } from './aiSwitching'
import { getMostSuitableMonToSwitchInto } from './aiSwitching'
import type { BattleState } from '../state'
import type { ChosenAction, TurnOrderMoveView } from '../turnOrder'
import { battleAiSetupFlags, type TrainerAiRow } from './aiFlags'
import { chooseMoveOrActionSingles, computeBattleAiScores, setRandomTargetSingles } from './aiPipeline'
import { aiTrySwitchOrUseItem } from './aiShouldSwitch'
import { PARTY_SIZE } from '../constants'

/** `TurnOrderMoveView` fields this batch cannot resolve without a wiring this
 * sim does not have yet (dynamic move type resolution, terrain grounding, the
 * Keen Edge helper, Mycelium Might) default to their NEUTRAL value -- same
 * precedent turn.test.ts's own hand-built `moveView()` fixture already uses
 * for every caller that does not care about ability-priority edge cases.
 * `hasStrongJawBoostFlag` is unconditionally false because FLAG_STRONG_JAW_BOOST
 * is never emitted on this build (grep-verified against
 * tools/codegen/src/er/move/BattleMovesGenerator.kt's `bitFlags` sources: three
 * hardcoded names plus MoveList.proto's own `flag_code_value` options, neither
 * of which include it) -- same "ported as dead code stays dead code" precedent
 * as aiCalcDamage.ts's FLAG_TWO_STRIKES note, not an approximation. */
function buildMoveView(moveId: string, deps: AiSwitchingDeps, unmodelled: string[]): TurnOrderMoveView {
  const move = deps.moveData(moveId)
  if (!move) unmodelled.push(`buildMoveView: move data is unavailable for ${moveId}`)

  if (move?.effect === 'EFFECT_GRASSY_GLIDE') {
    unmodelled.push(`buildMoveView: isGrassyTerrainAffected not resolved for ${moveId} (EFFECT_GRASSY_GLIDE priority bonus needs grounding this batch does not wire)`)
  }
  if (move?.effect === 'EFFECT_NATURAL_GIFT') {
    unmodelled.push(`buildMoveView: naturalGiftPriority not resolved for ${moveId} (EFFECT_NATURAL_GIFT priority needs the held item's Natural Gift table)`)
  }

  return {
    id: moveId,
    priority: move?.priority ?? 0,
    effect: move?.effect ?? null,
    isStatus: move?.split === 'STATUS',
    resolvedType: move?.type ?? 'MYSTERY', // GetTypeBeforeUsingMove's dynamic resolution not applied -- declared type used.
    power: move?.power ?? 0,
    flags: move?.flags ?? {},
    split: move?.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
}

export interface ChooseAiActionDeps extends AiSwitchingDeps {
  trainer: TrainerAiRow
}

/**
 * chooseAiAction -- the batch's own entry point. Ports, in the C's own order
 * (cycle13 diagnose-output.md §2, lead-verified correction; cycle15's fix
 * pass applies it here): `BattleAI_SetupFlags`'s trainer branch (aiFlags.ts,
 * applied to `state.aiFlags` before scoring), `ComputeBattleAiScores`
 * (aiPipeline.ts), `ChooseMoveOrAction_Singles` (aiPipeline.ts, including its
 * own second switch check and tie-break) -- STEP 1, run at
 * `STATE_TURN_START_RECORD` in the C -- THEN `AI_TrySwitchOrUseItem`'s
 * trainer-battle branch (aiShouldSwitch.ts) -- STEP 2, run at the CHOOSEACTION
 * dispatch, `battle_controller_opponent.c:1557-1561`, structurally before
 * OpponentHandleChooseMove (`:1568+`) ever consults step 1's own choice.
 *
 * PRIORITY BETWEEN STEP 1's AND STEP 2's SWITCH DECISIONS: step 2 always runs
 * before step 1's choice is ever consulted (CHOOSEACTION precedes CHOOSEMOVE
 * unconditionally), so a TRUE `ShouldSwitch` (step 2) always wins outright,
 * regardless of what step 1 decided -- `OpponentHandleChoosePokemon`
 * (`battle_controller_opponent.c:1652`) reads `AI_monToSwitchIntoId` (step 2's
 * own resolved slot, written by `aiShouldSwitch.ts`'s `decide` closure) FIRST,
 * before ever falling back to a fresh `GetMostSuitableMonToSwitchInto` call --
 * see aiSwitching.ts's own header for that citation. When step 2 says FALSE
 * and step 1 chose `AI_CHOICE_SWITCH` on its own (its second switch check,
 * `battle_ai_main.c:294-318`, which does NOT itself resolve a party slot),
 * the switch is honored via `deps.replacement` at `executeTurn`'s SWITCH
 * handling, reusing `GetMostSuitableMonToSwitchInto`+fallback exactly as
 * `AI_monToSwitchIntoId` being `PARTY_SIZE` would make `OpponentHandleChoosePokemon`
 * do in the C.
 *
 * NOT MODELLED: when step 1 chooses `AI_CHOICE_SWITCH` and step 2's FIRST
 * evaluation of `ShouldSwitch` is FALSE, `OpponentHandleChooseMove`'s own
 * `AI_CHOICE_SWITCH` branch emits `(1, 10, 0xFFFF)`
 * (`battle_controller_opponent.c:1593-1594`), which `HandleTurnActionSelectionState`'s
 * `STATE_WAIT_ACTION_CASE_CHOSEN` default branch (`battle_main.c:3888-3894`,
 * `bufferB[2]|bufferB[3]<<8 == 0xFFFF`) turns into `comm = STATE_BEFORE_ACTION_CHOSEN`
 * -- bouncing back to redo action selection, which re-runs CHOOSEACTION (a
 * SECOND, independent `ShouldSwitch` evaluation with fresh RNG). This port
 * does not model that re-entry loop: the byte-level mechanism by which
 * `gChosenActionByBattler`/`bufferB[gActiveBattler][1]` ultimately resolves
 * to `B_ACTION_SWITCH` for a switch decided this way (`AI_TrySwitchOrUseItem`'s
 * own switch branch never itself calls `BtlController_Emit*`, so this
 * necessarily depends on the buffer's PRIOR contents, which this reading of
 * the decomp could not conclusively pin down within this batch) is UNVERIFIED.
 * `chooseAiAction` therefore evaluates step 2 exactly ONCE per call: if that
 * one evaluation says FALSE, step 1's own switch choice (if any) is honored
 * as-is, with no second `ShouldSwitch` draw. This is a real, named gap, not a
 * silent simplification.
 *
 * `battlerId` must be an opponent battler (odd id) -- same restriction
 * aiSwitching.ts's `createAiOpponentReplacement` already enforces, and for the
 * same reason: this port only reaches trainer AI data (`state.aiFlags`,
 * `deps.trainer`) for the opponent side.
 */
export function chooseAiAction(state: BattleState, battlerId: number, deps: ChooseAiActionDeps): { action: ChosenAction; unmodelled: string[] } {
  if ((battlerId & 1) !== 1) {
    throw new Error(`chooseAiAction: battler ${battlerId} is not on the opponent side`)
  }
  const battlerTarget = setRandomTargetSingles(battlerId)
  const unmodelled: string[] = []

  const aiFlags = battleAiSetupFlags(deps.trainer, state.battleTypeFlags)
  const flaggedState: BattleState = { ...state, aiFlags }

  // Step 1, battle_main.c:3632-3639 (STATE_TURN_START_RECORD) -- scoring and
  // ChooseMoveOrAction_Singles' own tie-break/second switch check, BEFORE
  // AI_TrySwitchOrUseItem ever runs.
  const { scores, unmodelled: scoreUnmodelled } = computeBattleAiScores(flaggedState, battlerId, battlerTarget, deps)
  unmodelled.push(...scoreUnmodelled)

  const { choice, unmodelled: choiceUnmodelled } = chooseMoveOrActionSingles(flaggedState, battlerId, scores, deps)
  unmodelled.push(...choiceUnmodelled)

  const battler = flaggedState.battlers[battlerId]
  let moveView: TurnOrderMoveView | null = null
  if (choice.kind === 'move') {
    const moveId = battler?.mon.moves[choice.moveIndex]
    if (!battler || !moveId) {
      throw new Error(`chooseAiAction: chosen move slot ${choice.moveIndex} for battler ${battlerId} has no move`)
    }
    moveView = buildMoveView(moveId, deps, unmodelled)
  }

  // STATE_BEFORE_ACTION_CHOSEN (battle_main.c:3641) resets the pending-switch
  // slot after scoring and before CHOOSEACTION.
  if (battler) battler.monToSwitchIntoId = PARTY_SIZE

  // Step 2, battle_ai_switch_items.c:699+ (AI_TrySwitchOrUseItem, run from
  // OpponentHandleChooseAction, battle_controller_opponent.c:1557-1561) --
  // see this function's own doc for the priority this gives step 2 over step
  // 1's own choice, and the re-entry gap this port does not model.
  const trySwitchResult = aiTrySwitchOrUseItem(flaggedState, battlerId, deps, getMostSuitableMonToSwitchInto, battlerTarget, choice, moveView)
  unmodelled.push(...trySwitchResult.unmodelled)
  if (trySwitchResult.switched) {
    return { action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, unmodelled }
  }

  if (choice.kind === 'switch') {
    // ChooseMoveOrAction_Singles' OWN second switch check (battle_ai_main.c:
    // 294-318) does NOT resolve or store a specific party slot -- it only sets
    // AI_THINKING_STRUCT->switchMon and returns AI_CHOICE_SWITCH; the actual
    // mon is picked later, when OpponentHandleChoosePokemon runs (a SEPARATE,
    // later call to GetMostSuitableMonToSwitchInto plus its own fallback --
    // exactly what aiSwitching.ts's `createAiOpponentReplacement` already
    // ports). `state.battlers[battlerId].monToSwitchIntoId` is left at
    // PARTY_SIZE here on purpose; `executeTurn`'s SWITCH handling resolves it
    // via `deps.replacement`, reusing that same mechanism rather than
    // duplicating it.
    return { action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, unmodelled }
  }

  return {
    action: { action: 'USE_MOVE', moveToBeUsed: moveView!, chosenMove: moveView!, target: battlerTarget },
    unmodelled,
  }
}
