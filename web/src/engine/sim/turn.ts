// The turn loop skeleton: run one turn's actions in order, apply damage, faint.
//
// Ported from the action-dispatch loop, not invented: RunTurnActionsFunctions
// (src/battle_main.c:4653-4669) calls one handler per slot;
// HandleAction_ActionFinished (src/battle_util.c:848-861) advances
// gCurrentTurnActionNumber and re-sorts the NEXT slot before reading its action;
// HandleAction_UseMove (:177-186) aborts the action if its battler is not alive.
// Those three are the whole shape of this module.
//
// DELIBERATELY ABSENT, all of it the next batches: move EFFECTS (status
// application, stat changes, hazards, ...), switching, the AI, multi-hit
// sequencing, and every battle-script behaviour besides the attack canceller,
// the accuracy check and PP deduction below. A move may be cancelled before it
// is even attempted; a move may miss; PP is deducted; a hit deals damage; a
// battler may faint. Nothing else happens during the action loop itself.
//
// End-of-turn residuals: DoFieldEndTurnEffects (weather/terrain/field timers,
// battle_util.c:1768-2318) runs FIRST -- see fieldEndTurn.ts's own header for
// its enum-ordered classification and the loop-suspension mechanism it shares
// with the battler ladder below. Its own ENDTURN_ORDER case recomputes
// gBattlerByTurnOrder; that recomputed order (fieldEndTurn.ts's `order`, NOT
// this module's own action-loop `order`) is what DoBattlerEndTurnEffects
// (battle_util.c:2398-2992, endTurn.ts) then iterates, matching the C's single
// shared array -- ported for poison/toxic/burn only, see endTurn.ts's own
// header for the full enum-ordered classification of every other ENDTURN_*
// case.
//
// Cmd_attackcanceler (battle_script_commands.c:1046-1081, its own call to
// AtkCanceller_UnableToUseMove at :1081) is ported in attackCanceller.ts --
// see that module's header for the full enum-ordered ladder (ported/
// unreachable/gapped) and the RNG draws it makes. It runs BEFORE the accuracy
// check, matching BattleScript_EffectHit's own script order (data/
// battle_scripts_1.s:2857-2863): attackcanceler -> accuracycheck -> attackstring
// -> ppreduce. A cancelled action draws no accuracy, deals no damage, and
// deducts no PP -- its own cancel script (e.g. BattleScript_MoveUsedIsAsleep)
// `goto`s straight to BattleScript_MoveEnd, verified by reading each cancel
// script rather than assumed.
//
// Accuracy (Cmd_accuracycheck, battle_script_commands.c:1398-1447) and PP
// deduction (Cmd_ppreduce, :1460-1506) are ported for every USE_MOVE action
// that reaches them (not cancelled, with a living target), in that C order:
// the accuracy draw happens first (its own RandomSource draw), then PP is
// deducted UNCONDITIONALLY -- the miss branch BattleScript_PrintMoveMissed
// (battle_scripts_1.s:3092-3094) runs ppreduce as well, so a miss still costs
// PP. Two branches of Cmd_accuracycheck are NOT reachable by this loop, by
// construction rather than by omission, and are documented rather than
// gapped at runtime:
//   - the multi-hit/Parental-Bond second-hit accuracy exemption (:1412-1416)
//     needs gTurnStructs.multiHitsUsed/parentalBondOn, which nothing in this
//     loop ever sets (multi-hit sequencing is not modelled), so the
//     condition is always false and the standard accuracy-check branch
//     always runs -- exactly the behaviour this loop can represent anyway.
//   - JumpIfMoveAffectedByProtect (:1422) needs a Protecting target, which
//     RoundState.protectMove can represent but which nothing in this loop
//     ever sets (Protect is not modelled), so it is always unset.
// Cmd_accuracycheck's own Anticipation miss branch (:1427-1432, distinct from
// GetTotalAccuracy's ability loop that accuracy.ts already gaps) needs
// GetSingleUseAbilityCounter, a per-battle "already triggered" flag with no
// home in the state model, and the move's type-effectiveness multiplier,
// which is not known until the damage resolver runs afterwards -- gapped by
// name (accuracyBridge.ts's defenderHasAnticipation) only when the defender
// actually holds the ability.
//
// Absent from the three functions above SPECIFICALLY, listed because a reader
// comparing this loop against them should not have to spot the gaps:
//
//   HandleAction_ActionFinished (:848-861) -- this loop ports only the advance
//   and the re-sort, plus TurnStructsClear:
//     :856  TurnStructsClear() -- ported as turnStructsClear() below. ZERO(
//           gTurnStructs) (battle_main.c:4511) wipes EVERY battler's turn
//           struct after every action; without it a Bullet Seed's
//           multiHitCounter would leak into the attacker's next move.
//   Its other five statements are omitted:
//     :849  monToSwitchIntoId[...] = 6, resetting the pending-switch slot to the
//           PARTY_SIZE sentinel. Belongs with switching; noted because the
//           sentinel's value is itself a trap (see state.ts's own doc).
//     :857  gLastLandedMoves[gBattlerAttacker] = 0
//     :858  gLastHitByType[gBattlerAttacker] = 0
//     :859  ClearMiscTurnFlags()
//     :860  TryPreemptiveActions() -- a whole mechanic, with its own
//           onPreemptAction ability hook (battle_util.c:826) and the queued
//           extra-attack machinery at :829-834. Its own batch.
//
//   HandleAction_NothingIsFainted (:837-846) is the SIBLING handler and is not
//   ported at all. It is the same advance-and-re-sort, minus :849's sentinel
//   reset, minus TurnStructsClear and minus the two last-move resets -- it runs
//   for the B_ACTION_NOTHING_FAINTED slot, where no move was used, so there is
//   nothing move-specific to clear. A batch that models fainting mid-turn needs
//   the distinction; this one has no path that produces that action.
//
//   RunTurnActionsFunctions (:4654) opens with
//   `if (gBattleOutcome != 0) gCurrentActionFuncId = B_ACTION_FINISHED;` -- the
//   battle-over short-circuit, and the loop's real termination condition. Not
//   modelled: nothing in this batch can set an outcome, since deciding a battle
//   is over needs the reserve party and switching. It becomes load-bearing the
//   moment a faint can end a battle, and this loop will need it then.
//
// Two constraints this batch was given, and how each is met:
//
//   - Quash is FIELD-WIDE. gFieldTimers.quashTimer is a single field timer
//     (include/battle.h:326), not per-battler, so a quashed and an unquashed
//     battler cannot coexist. This loop never stores or varies quash per
//     battler; it reads state.field.timers.quashTimer through getMoveSpeed like
//     everything else, and assertNoPerBattlerQuash below states the invariant
//     for callers tempted to model it otherwise.
//   - Grounding is supplied FOR REAL, from sim/grounding.ts, not taken from
//     NEUTRAL_TURN_ORDER_CONTEXT (whose doc says a turn loop must not use it).
//     buildTurnOrderContext below assembles a context whose isBattlerGrounded is
//     the real port.

import type { BattleState } from './state'
import type { ChosenAction, TurnOrderContext, TurnOrder } from './turnOrder'
import { recalculateMoveOrder, setActionsAndBattlersTurnOrder } from './turnOrder'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import type { SimDataContext } from './dataContext'
import { gapsToUnmodelled } from './bridge'
import { buildAccuracyInputs } from './accuracyBridge'
import { getTotalAccuracy } from './accuracy'
import { battlerHasAbility } from '../abilities/dispatch'
import type { CancelReason } from './attackCanceller'
import { runAttackCanceller } from './attackCanceller'
import { createTurnState } from './create'
import type { EndTurnEffectResult } from './endTurn'
import { runEndTurnEffects } from './endTurn'
import { runFieldEndTurnEffects } from './fieldEndTurn'

/** IsBattlerAlive, src/battle_util.c:6685-6694 -- all three conditions, in
 * order: zero HP, an id past gBattlersCount, or the absent-battler bit. A null
 * slot in this model is the analogue of the second.
 *
 * NOT the whole of HandleAction_UseMove's guard. That guard (:181-186) is
 *
 *     if (field_91 & 1 << attacker ||
 *         (!IsBattlerAlive(attacker) &&
 *          !(gProcessingExtraAttacks && gQueuedExtraAttackData[0].ability &&
 *            gBattleMoves[gQueuedExtraAttackData[0].move].effect == EFFECT_EXPLOSION)))
 *
 * so two clauses are unmodelled here:
 *
 *   - `gBattleStruct->field_91`, whose own declaration says only "related to
 *     gAbsentBattlerFlags, possibly absent flags turn ago?" (battle.h:638). Low
 *     impact and genuinely unexplained in the source; not guessed at.
 *   - The explosion exception, which is NOT low impact: a battler that is dead
 *     DOES still act when an ability has queued an extra attack whose move
 *     effect is EFFECT_EXPLOSION. "Alive" is therefore not the whole test, and
 *     a loop that models queued extra attacks must restore this clause or dead
 *     Explosion users will silently stop going off. This batch has no queued
 *     extra attacks at all, so the clause is unreachable rather than wrong. */
export function isBattlerAlive(state: BattleState, battlerId: number): boolean {
  if (battlerId >= state.battlersCount) return false
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (battler.mon.hp === 0) return false
  return !(state.absentBattlerFlags & (1 << battlerId))
}

/** What one battler's action did. Returned rather than logged so tests and the
 * eventual solver can assert on a turn without re-deriving it. */
export interface ActionOutcome {
  /** The slot in turn order this was, 0-based. */
  turnOrderIndex: number
  battlerId: number
  action: ChosenAction['action']
  /** True when HandleAction_UseMove's own liveness guard (:181-186) aborted the
   * action because its battler was not alive. */
  skippedBecauseFainted: boolean
  /** Cmd_accuracycheck's own miss roll (battle_script_commands.c:1433), via
   * buildAccuracyInputs/getTotalAccuracy. Kept separate from `targetDamage`
   * being null rather than overloading it: null already means "nothing was
   * attempted" (no living target, a status move with no resolver support),
   * which is a different outcome from "the move was attempted and the
   * accuracy roll failed". False for every action that never reached the
   * accuracy check at all (skipped, no living target). */
  missed: boolean
  targetId: number | null
  /** HP removed from the TARGET. null means nothing happened at all, which is
   * distinct from 0. */
  targetDamage: number | null
  /** HP removed from the ATTACKER by its own action -- recoil, Life Orb, Rough
   * Skin, Destiny Bond. Carried from the start rather than added later, because
   * retrofitting it would change this interface, every resolver and every test,
   * and because the game's faint handling branches on WHICH battler fainted. */
  attackerDamage: number | null
  /** attackCanceller.ts's AtkCanceller_UnableToUseMove -- non-null means the
   * move was stopped before the accuracy check ever ran (no accuracy draw, no
   * damage, no PP deducted). Distinct from `missed` (the move was attempted
   * and failed its accuracy roll) and from "nothing was attempted" (no living
   * target, a status move with no resolver support, both still `targetDamage:
   * null` with `cancelledBy: null`). */
  cancelledBy: CancelReason | null
  /** HP removed from the ATTACKER by a CANCELLER_CONFUSED self-hit -- distinct
   * from `targetDamage` and from `attackerDamage` (which is the damage
   * engine's own recoil/Life-Orb/etc. channel for a move that was NOT
   * cancelled). Always null in this batch: see attackCanceller.ts's own doc on
   * why the self-hit's damage is gapped rather than computed. */
  confusionSelfHitDamage: number | null
  /** The damage engine's own "I could not model this" channel, passed through
   * rather than dropped at the boundary. Anything in here means the numbers
   * above are incomplete. */
  unmodelled: string[]
  /** Battler ids that reached 0 HP as a result of THIS action, in the order they
   * did. Target before attacker: the real ordering is decided by the move's
   * battle script, which this batch does not model, so the order here is the
   * loop's own and a later batch should assert against the script. */
  fainted: number[]
}

export interface TurnOutcome {
  actions: ActionOutcome[]
  /** The final turn order, after every lazy re-sort. Exposed because the order
   * is the thing this batch is really testing. */
  order: TurnOrder
  /** DoBattlerEndTurnEffects's residual HP effects (poison/toxic/burn) -- see
   * endTurn.ts. Separate from `actions`: these happen in their own phase after
   * the action loop, not as part of any battler's chosen action. */
  endTurn: EndTurnEffectResult[]
  /** endTurn.ts's own gap channel, kept apart from each ActionOutcome's
   * `unmodelled` because these gaps belong to the end-of-turn phase, not to
   * any one action. */
  endTurnUnmodelled: string[]
  /** DoFieldEndTurnEffects's residual HP effects (sandstorm/hail damage) --
   * see fieldEndTurn.ts. Runs BEFORE `endTurn` above, matching the real C's
   * DoFieldEndTurnEffects-before-DoBattlerEndTurnEffects order. */
  fieldEndTurn: EndTurnEffectResult[]
  /** fieldEndTurn.ts's own gap channel, kept apart from `endTurnUnmodelled`
   * because these gaps belong to the FIELD phase specifically. */
  fieldEndTurnUnmodelled: string[]
  /** fieldEndTurn.ts's own ENDTURN_ORDER result -- the recomputed
   * gBattlerByTurnOrder the C threads into BOTH the weather-damage loop above
   * AND the battler ladder afterwards. Distinct from `order` above (this
   * module's own action-loop order, established before either end-turn ladder
   * runs). Exposed so a test can assert the field ladder's own re-sort
   * happened, the same way `order` lets a test assert the action loop's. */
  endTurnOrder: number[]
}

/**
 * Resolves the damage one move does. A seam, and the honest boundary of this
 * batch.
 *
 * The existing damage engine's entry point (`calculateMoveDamage`) consumes a
 * `DamageCalcScenario`, whose `BattlerBattleState` carries roughly fifty fields
 * that the sim's `SimBattleMon` does not: item hold-effect strength and type,
 * Natural Gift data, species weight, evolution eligibility, and the whole
 * `ConditionBattlerContext`. Building one needs a species/item data context the
 * sim does not have, and the existing builder
 * (`features/damageCalc/scenario.ts:185`, 105 lines) cannot be reused because
 * `engine/` must not depend on `features/` -- see the layering rule in
 * CLAUDE.md. That bridge is its own batch; this interface is where it will
 * attach.
 *
 * The return shape is deliberately wider than this batch needs, because
 * narrowing it later would change the interface, every implementation and every
 * test:
 *
 *   - `unmodelled` is the damage engine's own channel (calculate.ts:170) for
 *     "this could not be modelled". A resolver that dropped it would discard the
 *     engine's honesty signal at exactly the boundary whose whole point is
 *     refusing to fail silently.
 *   - `attackerDamage` exists because the target is not the only battler a move
 *     can damage: recoil, Life Orb, Rough Skin and Destiny Bond all hit the
 *     attacker, and the game's faint handling branches on which one fainted.
 *
 * Each damage figure is HP to remove, already rolled. null means nothing
 * happened on that side, which is distinct from 0.
 */
export interface DamageResolution {
  targetDamage: number | null
  attackerDamage: number | null
  unmodelled: string[]
}

export interface DamageResolveContext {
  /** Whether the target's action slot was already reached this turn. */
  targetHasActedThisTurn: boolean
}

export interface DamageResolver {
  resolve(state: BattleState, attackerId: number, targetId: number, action: ChosenAction, context?: DamageResolveContext): DamageResolution
}

/** A resolver that THROWS rather than returning zero.
 *
 * Deliberately not a neutral default: a resolver that quietly deals no damage
 * would make every turn end with both battlers at full HP and every test pass,
 * which is the silent-wrong-number failure this project has now hit twice (the
 * empty ability registry, the grounding seam). A caller must supply a real
 * resolver or a test double it chose on purpose. */
export const THROWING_DAMAGE_RESOLVER: DamageResolver = {
  resolve() {
    throw new Error('no DamageResolver supplied -- the turn loop will not silently deal zero damage; see turn.ts DamageResolver')
  },
}

/** Everything the loop needs beyond the state. `grounding` is separate from
 * `turnOrder` because the grounding port needs facts (Clueless on field, Mold
 * Breaker) that turn order itself never asks about. */
export interface TurnLoopDeps {
  /** A TurnOrderContext with isBattlerGrounded left out -- this module supplies
   * it from the real port, so a caller cannot substitute the neutral guess. */
  turnOrder: Omit<TurnOrderContext, 'isBattlerGrounded'>
  grounding: GroundingContext
  damage: DamageResolver
  statStageRatios: [number, number][]
  /** accuracyBridge.ts's move/item lookups for the accuracy check. Separate
   * from the DamageResolver's own data access, which the loop has no
   * visibility into. */
  dataContext: SimDataContext
}

/** Assembles the TurnOrderContext the loop actually runs with: the caller's
 * fields plus a REAL isBattlerGrounded. Exported so a test can assert the
 * substitution happened rather than trusting it. */
export function buildTurnOrderContext(state: BattleState, deps: TurnLoopDeps): TurnOrderContext {
  return {
    ...deps.turnOrder,
    isBattlerGrounded: (battlerId: number) => isBattlerGrounded(state, battlerId, deps.grounding),
  }
}

/** The field-wide-quash invariant, stated as code because the temptation to
 * model quash per battler is real -- it reads like a per-battler status and is
 * not one. Throws rather than returning a boolean so a caller cannot ignore it.
 */
export function assertNoPerBattlerQuash(state: BattleState): void {
  // There is nowhere in the state model to PUT a per-battler quash, which is the
  // point: gFieldTimers.quashTimer (include/battle.h:326) is the only storage
  // the game has for it. This checks the one thing that could still go wrong --
  // a negative or non-integer timer smuggled in by a caller building state by
  // hand -- and documents why no per-battler variant exists.
  const t = state.field.timers.quashTimer
  if (!Number.isInteger(t) || t < 0) {
    throw new Error(`quashTimer must be a non-negative integer (it is one field-wide timer, not per battler); got ${String(t)}`)
  }
}

/**
 * Runs one turn.
 *
 * The loop mirrors the game's own control flow rather than sorting once and
 * iterating: `recalculateMoveOrder` is called for each slot AS IT IS REACHED
 * (battle_util.c:839, :851), so a Speed change or a faint caused by the first
 * action is visible to the second. That is the whole reason this is a loop with
 * a re-sort inside it and not a sorted array.
 */
/** Every battler, alive, on the SIDE OPPOSITE `battlerId` -- IsAbilityOnSide's
 * own scan (battle_util.c:4792-4799), generalised past singles' one opponent
 * since nothing here assumes battlersCount === 2. Does not apply the C's
 * mold-breaker exception (BATTLER_HAS_ABILITY_AND_ALIVE's checkMoldBreaker=
 * TRUE, :4793/4795); see deductPp's own gap note for why. */
export function isAbilityAliveOnOpposingSide(state: BattleState, battlerId: number, abilityId: string): boolean {
  const side = battlerId & 1
  for (let id = 0; id < state.battlersCount; id++) {
    if ((id & 1) === side) continue
    if (!isBattlerAlive(state, id)) continue
    const battler = state.battlers[id]
    if (battler && battlerHasAbility(battler.mon.abilities, abilityId, () => false)) return true
  }
  return false
}

/** TurnStructsClear, battle_main.c:4511 -- ZERO(gTurnStructs) for every battler. */
function turnStructsClear(state: BattleState): void {
  for (const battler of state.battlers) {
    if (battler) battler.turn = createTurnState()
  }
}

/**
 * Cmd_ppreduce, battle_script_commands.c:1460-1506. Runs for every USE_MOVE
 * action that reaches this point (a living attacker with a living target),
 * UNCONDITIONALLY of the accuracy result -- see this module's header.
 *
 * Ported: the base-1 deduction, Pressure's extra PP, the PP floor,
 * notFirstStrike, and sameMoveTurns (state.ts's own field doc explains why
 * the latter is always reset to 0 in this batch, never incremented).
 *
 * Not reachable: the HITMARKER_NO_PPDEDUCT / HITMARKER_NO_ATTACKSTRING early
 * returns (:1467-1472). gHitMarker is not modelled and nothing in this loop
 * would set either bit, so both guards are always false.
 *
 * Gapped: Stockpile's Spit Up/Swallow PP-refund branch (:1476-1483 --
 * TryUseStockpile has no port anywhere in this codebase; this falls through
 * to the ordinary deduction, the correct answer whenever Stockpile was never
 * used) and the transformed/mimicked-move branch (:1500-1504, a pure
 * UI/link-battle controller sync call with no gameplay effect for a headless
 * sim to model -- not a gap, since there is nothing for it to be wrong
 * about).
 */
function deductPp(state: BattleState, attackerId: number, moveId: string, moveEffect: string | null, unmodelled: string[]): void {
  const attacker = state.battlers[attackerId]
  if (!attacker) return
  const slot = attacker.mon.moves.findIndex((id) => id === moveId)
  if (slot === -1) return

  let ppToDeduct = 1
  // Pressure, :1474. The attacker's OWN ability check needs no mold-breaker
  // exception (a battler cannot Mold-Break itself); the OPPOSING side's check
  // does (IsAbilityOnSide's BATTLER_HAS_ABILITY_AND_ALIVE, checkMoldBreaker=
  // TRUE at :4793/4795), which isAbilityAliveOnOpposingSide does not apply --
  // gapped by name only when Pressure was actually found, so an ordinary
  // battle without Mold Breaker never sees the note.
  const attackerHasPressure = battlerHasAbility(attacker.mon.abilities, 'ABILITY_PRESSURE', () => false)
  const opposingHasPressure = isAbilityAliveOnOpposingSide(state, attackerId, 'ABILITY_PRESSURE')
  if (!attackerHasPressure && opposingHasPressure) {
    ppToDeduct++
    unmodelled.push(
      "Pressure's mold-breaker suppression (IsAbilityOnSide's checkMoldBreaker=TRUE, battle_util.c:4793) is not applied; an opposing Mold-Breaker-class attacker would bypass Pressure's extra PP cost here",
    )
  }

  if (moveEffect === 'EFFECT_SPIT_UP' || moveEffect === 'EFFECT_SWALLOW') {
    unmodelled.push('Spit Up/Swallow PP refund via TryUseStockpile (battle_script_commands.c:1476-1483) is not modelled; PP was deducted as if Stockpile were empty')
  }

  // :1485. Reads the PP slot BEFORE deduction; a slot already at 0 deducts
  // nothing and sets neither notFirstStrike nor sameMoveTurns.
  if (attacker.mon.pp[slot] > 0) {
    attacker.round.notFirstStrike = true
    // gBattleStruct->sameMoveTurns[attacker], :1486-1493 -- the increment
    // branch needs gTurnStructs.parentalBondOn > 0, which nothing in this
    // loop ever writes (see state.ts's field doc), so the reset branch
    // always runs.
    attacker.sameMoveTurns = 0
    attacker.mon.pp[slot] = Math.max(0, attacker.mon.pp[slot] - ppToDeduct)
  }
}

/** Removes HP from one battler, floors at 0, and records a faint. Shared by the
 * target and attacker halves so they cannot drift apart. */
function applyDamage(state: BattleState, battlerId: number, damage: number | null, fainted: number[]): void {
  if (damage === null) return
  const battler = state.battlers[battlerId]
  if (!battler || battler.mon.hp === 0) return
  // HP floors at 0; the C never stores a negative hp.
  battler.mon.hp = Math.max(0, battler.mon.hp - damage)
  if (battler.mon.hp === 0) {
    fainted.push(battlerId)
    // gFaintedMonCount[side], battle.h:1002 -- the count Soul Harvest and
    // Supreme Overlord read.
    state.sides[battlerId & 1].faintedCount++
  }
}

export function executeTurn(state: BattleState, actions: (ChosenAction | null)[], deps: TurnLoopDeps): TurnOutcome {
  assertNoPerBattlerQuash(state)

  const ctx = buildTurnOrderContext(state, deps)
  const order = setActionsAndBattlersTurnOrder(state, actions)
  const outcomes: ActionOutcome[] = []

  for (let index = 0; index < order.battlerByTurnOrder.length; index++) {
    // HandleAction_ActionFinished's TurnStructsClear (:856) runs after every
    // action; clearing at the top of each iteration (and once after the loop)
    // is equivalent and survives every `continue` below.
    turnStructsClear(state)
    // :4546 / :839 / :851 -- re-sort THIS slot before reading who is in it.
    recalculateMoveOrder(order, state, actions, index, false, ctx, deps.statStageRatios)

    const battlerId = order.battlerByTurnOrder[index]
    const action = actions[battlerId] ?? null
    const actionKind = order.actionsByTurnOrder[index]

    // HandleAction_UseMove:181-186 -- a battler that fainted earlier this turn
    // does not act. Its slot is still consumed; the action is simply finished.
    const blank = {
      turnOrderIndex: index,
      battlerId,
      action: actionKind,
      missed: false,
      targetId: null,
      targetDamage: null,
      attackerDamage: null,
      cancelledBy: null,
      confusionSelfHitDamage: null,
      unmodelled: [],
      fainted: [],
    }

    if (!isBattlerAlive(state, battlerId)) {
      outcomes.push({ ...blank, skippedBecauseFainted: true })
      continue
    }

    if (actionKind !== 'USE_MOVE' || !action || action.chosenMove === null) {
      outcomes.push({ ...blank, skippedBecauseFainted: false })
      continue
    }

    const targetId = action.target
    const unmodelled: string[] = []

    // Cmd_attackcanceler, battle_script_commands.c:1046-1081 -- runs BEFORE any
    // target-liveness consideration, matching the C: AtkCanceller_UnableToUseMove
    // only ever tests the ATTACKER's own state (status1/status2/abilities), so a
    // sleeping/frozen/paralysed/flinched/confused/loafing attacker is cancelled
    // even when its target has already fainted this turn.
    // attackerHoldEffect: attackCanceller.ts's own CANCELLER_MULTIHIT_MOVES
    // needs GetBattlerHoldEffect (battle_util.c:3586) for the Loaded Dice
    // check, same item-lookup precedent as accuracyBridge.ts's
    // attackerHoldEffect.
    const attackerMon = state.battlers[battlerId]?.mon
    const attackerHoldEffect = attackerMon?.itemId ? (deps.dataContext.item(attackerMon.itemId)?.resolvedHoldEffect ?? null) : null
    const cancelResult = runAttackCanceller(state, battlerId, targetId, action.chosenMove.id, deps.dataContext.move(action.chosenMove.id), unmodelled, attackerHoldEffect)
    if (cancelResult.cancelledBy) {
      outcomes.push({
        turnOrderIndex: index,
        battlerId,
        action: actionKind,
        skippedBecauseFainted: false,
        missed: false,
        targetId,
        targetDamage: null,
        attackerDamage: null,
        cancelledBy: cancelResult.cancelledBy,
        confusionSelfHitDamage: cancelResult.confusionSelfHitDamage,
        unmodelled,
        fainted: [],
      })
      continue
    }

    if (targetId === null || !isBattlerAlive(state, targetId)) {
      // No living target: the move resolves to nothing here. The real game runs
      // a fail branch with messages and effect-specific behaviour; this batch
      // models only that no damage is dealt.
      outcomes.push({ ...blank, skippedBecauseFainted: false, targetId, unmodelled })
      continue
    }

    const targetIndex = order.battlerByTurnOrder.indexOf(targetId)
    const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < index

    // Cmd_accuracycheck, battle_script_commands.c:1398-1447. Drawn from
    // state.rng BEFORE the damage resolver's own crit/roll draws, matching
    // BattleScript_EffectHit (battle_scripts_1.s:2857-2863): accuracycheck,
    // then attackstring/ppreduce, then critcalc/damagecalc inside
    // deps.damage.resolve below.
    const { inputs: accInputs, gaps: accGaps, defenderHasAnticipation } = buildAccuracyInputs(state, battlerId, targetId, action.chosenMove.id, targetHasActedThisTurn, deps)
    unmodelled.push(...gapsToUnmodelled(accGaps))
    if (defenderHasAnticipation) {
      unmodelled.push(
        "Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432) is not modelled: GetSingleUseAbilityCounter has no state anywhere in this codebase, and the type-effectiveness multiplier it needs is not known until the damage resolver runs afterwards",
      )
    }
    const accResult = getTotalAccuracy(accInputs)
    unmodelled.push(...gapsToUnmodelled(accResult.gaps))
    // :1433 -- `(Random() % 100) >= accuracy` is a MISS. 101 (\"cannot miss\")
    // is not special-cased: Random() % 100 is at most 99, so the comparison
    // can never be true, and the arithmetic alone carries the sentinel.
    const missed = state.rng.random16() % 100 >= accResult.accuracy

    // Cmd_ppreduce, :1460-1506 -- after the accuracy check, on both paths:
    // the miss branch BattleScript_PrintMoveMissed (battle_scripts_1.s:3092-
    // 3094) runs ppreduce too, so a miss still costs PP.
    deductPp(state, battlerId, action.chosenMove.id, action.chosenMove.effect, unmodelled)

    if (missed) {
      outcomes.push({
        turnOrderIndex: index,
        battlerId,
        action: actionKind,
        skippedBecauseFainted: false,
        missed: true,
        targetId,
        targetDamage: null,
        attackerDamage: null,
        cancelledBy: null,
        confusionSelfHitDamage: null,
        unmodelled,
        fainted: [],
      })
      continue
    }

    const { targetDamage, attackerDamage, unmodelled: damageUnmodelled } = deps.damage.resolve(state, battlerId, targetId, action, { targetHasActedThisTurn })
    const fainted: number[] = []
    applyDamage(state, targetId, targetDamage, fainted)
    applyDamage(state, battlerId, attackerDamage, fainted)

    outcomes.push({
      turnOrderIndex: index,
      battlerId,
      action: actionKind,
      skippedBecauseFainted: false,
      missed: false,
      targetId,
      targetDamage,
      attackerDamage,
      cancelledBy: null,
      confusionSelfHitDamage: null,
      unmodelled: [...unmodelled, ...damageUnmodelled],
      fainted,
    })
  }
  turnStructsClear(state)

  // BattleTurnPassed, battle_main.c:3465-3481: TurnValuesCleanUp(TRUE), then
  // DoFieldEndTurnEffects (fieldEndTurn.ts) and DoBattlerEndTurnEffects
  // (endTurn.ts), in that order, THEN HandleFaintedMonActions (absent --
  // switching is out of scope) and HandleWishPerishSongOnTurnEnd (absent), and
  // only after all of that does gBattleResults.battleTurnCounter++ run
  // (:3508-3511). Both residual ladders therefore belong HERE, before the
  // counter increment below -- not after it. fieldEndTurn's own ENDTURN_ORDER
  // recomputes gBattlerByTurnOrder; endTurn's battler ladder receives THAT
  // order, not this function's own `order` (see fieldEndTurn.ts's header).
  const {
    order: endTurnOrder,
    results: fieldEndTurn,
    unmodelled: fieldEndTurnUnmodelled,
  } = runFieldEndTurnEffects(state, ctx, deps.statStageRatios, deps.grounding, deps.dataContext)
  const { results: endTurn, unmodelled: endTurnUnmodelled } = runEndTurnEffects(state, endTurnOrder, deps.dataContext)

  // battle_main.c increments gBattleResults.battleTurnCounter after the action
  // loop and the end-turn ladders above; state.turnCount is therefore the
  // zero-based counter while resolving this turn (turn 1 is 0), matching
  // bridge.ts's parity checks. battle_main.c:3512-3513 saturates the u8
  // counter at 0xFF.
  state.turnCount = Math.min(0xFF, state.turnCount + 1)
  return { actions: outcomes, order, endTurn, endTurnUnmodelled, fieldEndTurn, fieldEndTurnUnmodelled, endTurnOrder }
}
