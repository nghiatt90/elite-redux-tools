// chooseAiAction: the AI's entry point. Ports battle_main.c:3636-3639
// (STATE_TURN_START_RECORD: "Do AI score computations here so we can use them
// in AI_TrySwitchOrUseItem" -- ComputeBattleAiScores/ChooseMoveOrAction_Singles
// run FIRST, including the tie-break RNG and the scoring's own second switch
// check) together with battle_controller_opponent.c:1557-1568
// (OpponentHandleChooseAction -> AI_TrySwitchOrUseItem, THEN
// OpponentHandleChooseMove reading gBattleStruct->aiMoveOrAction). See
// aiShouldSwitch.ts for ShouldSwitch/ShouldUseItem's own port (cycle 15).
//
// DOUBLES (dbl-4e): BattleAI_ChooseMoveOrAction's own branch
// (battle_ai_main.c:195-198) is now modelled -- `!(gBattleTypeFlags &
// BATTLE_TYPE_DOUBLE)` -> ChooseMoveOrAction_Singles, else
// ChooseMoveOrAction_Doubles (aiPipeline.ts:351). The doubles chooser owns its
// own per-target scoring loop, so the singles scoring sequence is NOT run for a
// double; only ComputeBattleAiScores' outer BattleAI_SetupAIData(0xF)'s
// SetRandomTarget draw (:186, one draw in a double, battle_util.c:6334) still
// happens first, because ComputeBattleAiScores (:208-212) runs before
// BattleAI_ChooseMoveOrAction in the C.
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
import { naturalGiftPriority } from '../turnOrder'
import { battleAiSetupFlags, type TrainerAiRow } from './aiFlags'
import { chooseMoveOrActionDoubles, chooseMoveOrActionSingles, computeBattleAiScores, setRandomTarget, setRandomTargetSingles, type AiChoice } from './aiPipeline'
import { aiTrySwitchOrUseItem } from './aiShouldSwitch'
import { BATTLE_TYPE_DOUBLE, BATTLE_TYPE_INGAME_PARTNER, hasFlag, PARTY_SIZE } from '../constants'
import { canMegaEvolve } from '../formChange'
import { isKeenEdgeMove } from '../statusEffects'
import { isSimAbilitySuppressed } from '../statBuffs'
import { getOpponentSelectedMoveTarget, getPartnerSelectedMoveTarget } from '../moveTargetFlags'
import { resolveEffectiveMoveType } from '../../abilities/dispatchCalc'
import type { AbilitySlots } from '../../abilities/dispatch'

/** `TurnOrderMoveView` fields this batch cannot resolve without a wiring this
 * sim does not have yet (dynamic move type resolution beyond the onMoveType
 * "-ate" subset -- see `resolvedType` below --, terrain grounding, the
 * Mycelium Might check) default to their NEUTRAL value -- same precedent
 * turn.test.ts's own hand-built `moveView()` fixture already uses for every
 * caller that does not care about ability-priority edge cases.
 * `hasStrongJawBoostFlag` is unconditionally false because FLAG_STRONG_JAW_BOOST
 * is never emitted on this build (grep-verified against
 * tools/codegen/src/er/move/BattleMovesGenerator.kt's `bitFlags` sources: three
 * hardcoded names plus MoveList.proto's own `flag_code_value` options, neither
 * of which include it) -- same "ported as dead code stays dead code" precedent
 * as aiCalcDamage.ts's FLAG_TWO_STRIKES note, not an approximation.
 * `isKeenEdge` IS resolved here: `AiSwitchingDeps` extends `BridgeDeps`, which
 * carries both `dataContext` and `grounding`, so Cutthroat's +1 priority
 * (battle_main.c:4278) sees the AI's granted keen-edge moves too. */
function buildMoveView(
  state: BattleState,
  battlerId: number,
  moveId: string,
  deps: AiSwitchingDeps,
  unmodelled: string[],
  itemId: string | null,
): TurnOrderMoveView {
  const move = deps.moveData(moveId)
  if (!move) unmodelled.push(`buildMoveView: move data is unavailable for ${moveId}`)

  if (move?.effect === 'EFFECT_GRASSY_GLIDE') {
    unmodelled.push(`buildMoveView: isGrassyTerrainAffected not resolved for ${moveId} (EFFECT_GRASSY_GLIDE priority bonus needs grounding this batch does not wire)`)
  }

  const declaredType = move?.type ?? 'MYSTERY'
  // GetTypeBeforeUsingMove (battle_main.c:5206-5209 -> GetMoveTypeInternal
  // :5093-5204) is this view's source. `AiDamageDeps` carries no DamageResolver, so
  // only the onMoveType "-ate" subset is reachable here: the item/effect/field arms
  // (Weather Ball, Hidden Power, Judgment/Plate, Natural Gift, Electrify, Ion Deluge,
  // Plasma Fists) still fall back to the declared type. attackCanceller.ts:609-610
  // reaches the same subset for its Powder check; aiCheckBadMove.ts:288-294 already
  // reports the variable-type gap for the scoring path, so no second note here.
  // GetMoveTypeInternal's final loop runs through ON_ABILITY
  // (battle_main.c:5200-5201), whose FILTER_NOT(IsSuppressed)
  // (include/battle_util.h:269-275) drops a Gastro Acid / Neutralizing Gas
  // ability. `mon.abilities` carries the RAW slots, so clear the suppressed ones
  // for this call -- same filter damageResolver.ts's moveType applies on the
  // player side. (checkMoldBreaker FALSE: the attacker's own ability is never
  // Mold-Breaker-suppressed -- battle_util.c:9257's `battler != attacker`.)
  const attacker = state.battlers[battlerId]
  const rawSlots = attacker?.mon.abilities ?? { ability: null, innates: [null, null, null] }
  const alive = (id: string | null): string | null =>
    id && attacker && !isSimAbilitySuppressed(state, attacker, id, false, battlerId, false, deps.dataContext) ? id : null
  const abilitySlots: AbilitySlots = {
    ability: alive(rawSlots.ability),
    innates: [alive(rawSlots.innates[0]), alive(rawSlots.innates[1]), alive(rawSlots.innates[2])],
  }
  const resolvedType = move
    ? resolveEffectiveMoveType(abilitySlots, moveId, declaredType, move.flags ?? {}).moveType
    : declaredType

  return {
    id: moveId,
    priority: move?.priority ?? 0,
    effect: move?.effect ?? null,
    isStatus: move?.split === 'STATUS',
    resolvedType,
    declaredType,
    power: move?.power ?? 0,
    flags: move?.flags ?? {},
    split: move?.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    // IsKeenEdge(battler, move, GetTypeBeforeUsingMove(move, battler)), battle_main.c:4278.
    isKeenEdge: isKeenEdgeMove(state, battlerId, moveId, {
      dataContext: deps.dataContext,
      grounding: deps.grounding,
    }),
    naturalGiftPriority: move?.effect === 'EFFECT_NATURAL_GIFT' ? naturalGiftPriority(itemId) : 0,
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
 * `battlerId` must be an opponent battler (odd id): 1 or 3 in the four-battler
 * states `buildBattleState` produces. Both flanks are supported as of dbl-4e --
 * `BattleAI_SetupFlags` reads gTrainerBattleOpponent_A for every AI battler
 * (`battle_ai_main.c:147`, :152), so `deps.trainer` stays the battle-wide
 * opponent-A row rather than the battler's own trainer (see
 * `trainerForBattler` in driver/battleFormat.ts for the roster-side lookup).
 * Even ids still throw, with one exception: 0 is player-controlled, while the
 * in-game partner (battler 2, BATTLE_TYPE_INGAME_PARTNER) is driven by the
 * opponent's AI flags through PlayerPartnerHandleChooseMove / PlayerPartnerHandleChooseAction
 * (battle_controller_player_partner.c:1517-1550) -- dbl-6b2.
 */
export function chooseAiAction(state: BattleState, battlerId: number, deps: ChooseAiActionDeps): { action: ChosenAction; unmodelled: string[] } {
  if (battlerId < 0 || battlerId >= state.battlersCount) {
    throw new Error(`chooseAiAction: battler ${battlerId} is not in this battle (${state.battlersCount} battlers)`)
  }
  const isPartner = battlerId === 2 && hasFlag(state.battleTypeFlags, BATTLE_TYPE_INGAME_PARTNER)
  if ((battlerId & 1) !== 1 && !isPartner) {
    throw new Error(
      `chooseAiAction: battler ${battlerId} is not on the opponent side (battler 0 is player-controlled; battler 2 requires BATTLE_TYPE_INGAME_PARTNER; see dbl-6b)`,
    )
  }
  const unmodelled: string[] = []

  const aiFlags = battleAiSetupFlags(deps.trainer, state.battleTypeFlags)
  const flaggedState: BattleState = { ...state, aiFlags }

  // Step 1, battle_main.c:3632-3639 (STATE_TURN_START_RECORD) -- scoring and
  // the chooser's own tie-break/second switch check, BEFORE
  // AI_TrySwitchOrUseItem ever runs.
  let battlerTarget: number
  let choice: AiChoice
  if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_DOUBLE)) {
    // BattleAI_ChooseMoveOrAction (:195-198) takes the doubles branch. The
    // chooser re-runs BattleAI_SetupAIData(0xF) per target (:358-361), so the
    // singles scoring sequence above is not run; ComputeBattleAiScores' own
    // outer BattleAI_SetupAIData(0xF) (:210) still comes first, and its
    // SetRandomTarget (:186) is the FIRST draw in a double
    // (battle_util.c:6334) -- its return value is discarded because :363 and
    // :437 overwrite gBattlerTarget, so only the draw is observable.
    setRandomTarget(flaggedState, battlerId)

    const doubles = chooseMoveOrActionDoubles(flaggedState, battlerId, deps)
    unmodelled.push(...doubles.unmodelled)
    // :438 -- gBattleStruct->aiChosenTarget[sBattler_AI] = gBattlerTarget: the
    // per-battler target this port takes as its battlerTarget.
    battlerTarget = doubles.target

    let moveIndex = doubles.moveIndex
    if (moveIndex === null) {
      // :382-385/:438 -- 0xFF means "no action scored for the winning target"
      // (the AI itself or a fainted battler won the -1 tie at :421-435).
      // OpponentHandleChooseMove's `default:` case then evaluates
      // `moveInfo->moves[chosenMoveId]` with chosenMoveId == 0xFF
      // (battle_controller_opponent.c:1600), an index past the 4-slot array
      // with no defined behaviour in the C. Rather than invent one, fall back
      // to slot 0 and report it.
      unmodelled.push(
        'chooseAiAction: ChooseMoveOrAction_Doubles returned 0xFF (battle_ai_main.c:355/:438); OpponentHandleChooseMove reads moveInfo->moves[0xFF] (battle_controller_opponent.c:1600) with no defined behaviour -- using move slot 0',
      )
      moveIndex = 0
    }
    // The doubles chooser returns a move slot or 0xFF only (:382-385's
    // AI_CHOICE_FLEE/ai_CHOICE_WATCH are unreachable for a trainer's aiFlags),
    // so there is no AI_CHOICE_SWITCH to carry here.
    choice = { kind: 'move', moveIndex }
  } else {
    battlerTarget = setRandomTargetSingles(battlerId)

    const { scores, unmodelled: scoreUnmodelled } = computeBattleAiScores(flaggedState, battlerId, battlerTarget, deps)
    unmodelled.push(...scoreUnmodelled)

    const { choice: singlesChoice, unmodelled: choiceUnmodelled } = chooseMoveOrActionSingles(flaggedState, battlerId, scores, deps)
    unmodelled.push(...choiceUnmodelled)
    choice = singlesChoice
  }

  const battler = flaggedState.battlers[battlerId]
  let moveView: TurnOrderMoveView | null = null
  let chosenMoveId: string | null = null
  if (choice.kind === 'move') {
    chosenMoveId = battler?.mon.moves[choice.moveIndex] ?? null
    if (!battler || !chosenMoveId) {
      throw new Error(`chooseAiAction: chosen move slot ${choice.moveIndex} for battler ${battlerId} has no move`)
    }
    moveView = buildMoveView(flaggedState, battlerId, chosenMoveId, deps, unmodelled, battler.mon.itemId)
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

  // OpponentHandleChooseMove, battle_controller_opponent.c:1608:
  // "if (CanMegaEvolve(gActiveBattler) && ItemId_GetHoldEffect(mon.item) != HOLD_EFFECT_PRIMAL_ORB) -> RET_MEGA_EVOLUTION"
  // PlayerPartnerHandleChooseMove, battle_controller_player_partner.c:1545-1548:
  // "if (CanMegaEvolve(gActiveBattler)) -> RET_MEGA_EVOLUTION" (no primal orb check)
  const holdEffect = battler?.mon.itemId ? deps.dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null : null
  const isPrimalOrb = holdEffect === ('HOLD_' + 'EFFECT_PRIMAL_ORB')
  const canMega = canMegaEvolve(state, battlerId, deps.dataContext)
  const mega = isPartner ? canMega : canMega && !isPrimalOrb

  const staticTarget = chosenMoveId === null ? undefined : deps.moveData(chosenMoveId)?.target
  const target = isPartner
    ? getPartnerSelectedMoveTarget(
        battlerId,
        staticTarget,
        battlerTarget,
        state.absentBattlerFlags,
      )
    : getOpponentSelectedMoveTarget(
        battlerId,
        staticTarget,
        battlerTarget,
        state.absentBattlerFlags,
      )

  return {
    action: {
      action: 'USE_MOVE',
      moveToBeUsed: moveView!,
      chosenMove: moveView!,
      target,
      ...(mega ? { mega: true } : {}),
    },
    unmodelled,
  }
}
