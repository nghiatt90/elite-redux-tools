// The entry point this batch adds: chooseAiAction. Ports the OPPONENT side of
// battle_controller_opponent.c:1557-1568 (OpponentHandleChooseAction falling
// through to ComputeBattleAiScores/BattleAI_ChooseMoveOrAction, then
// OpponentHandleChooseMove reading the result) for the pre-scoring
// AI_TrySwitchOrUseItem step -- see aiShouldSwitch.ts for ShouldSwitch/
// ShouldUseItem's own port (cycle 15).
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
 * chooseAiAction -- the batch's own entry point. Ports, in order:
 * `AI_TrySwitchOrUseItem`'s trainer-battle stub (this module), `BattleAI_
 * SetupFlags`'s trainer branch (aiFlags.ts, applied to `state.aiFlags` before
 * scoring), `ComputeBattleAiScores` (aiPipeline.ts), and `ChooseMoveOrAction_
 * Singles` (aiPipeline.ts, including its second switch check and tie-break).
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

  // AI_TrySwitchOrUseItem, battle_ai_switch_items.c:699+ -- runs BEFORE move
  // scoring on every trainer turn (cycle13's diagnose-output finding). A TRUE
  // ShouldSwitch here writes `state.battlers[battlerId].monToSwitchIntoId`
  // itself (aiShouldSwitch.ts's own side effect, matching the C's in-place
  // global write) and skips scoring entirely, exactly like the C's own early
  // `return;` inside AI_TrySwitchOrUseItem's trainer branch.
  const trySwitchResult = aiTrySwitchOrUseItem(state, battlerId, deps, getMostSuitableMonToSwitchInto)
  const unmodelled: string[] = [...trySwitchResult.unmodelled]
  if (trySwitchResult.switched) {
    return { action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, unmodelled }
  }

  const aiFlags = battleAiSetupFlags(deps.trainer, state.battleTypeFlags)
  const flaggedState: BattleState = { ...state, aiFlags }

  const { scores, unmodelled: scoreUnmodelled } = computeBattleAiScores(flaggedState, battlerId, battlerTarget, deps)
  unmodelled.push(...scoreUnmodelled)

  const { choice, unmodelled: choiceUnmodelled } = chooseMoveOrActionSingles(flaggedState, battlerId, scores, deps)
  unmodelled.push(...choiceUnmodelled)

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

  const battler = state.battlers[battlerId]
  const moveId = battler?.mon.moves[choice.moveIndex]
  if (!battler || !moveId) {
    throw new Error(`chooseAiAction: chosen move slot ${choice.moveIndex} for battler ${battlerId} has no move`)
  }

  const moveView = buildMoveView(moveId, deps, unmodelled)
  return {
    action: { action: 'USE_MOVE', moveToBeUsed: moveView, chosenMove: moveView, target: battlerTarget },
    unmodelled,
  }
}
