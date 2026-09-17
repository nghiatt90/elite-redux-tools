// The turn loop skeleton: run one turn's actions in order, apply damage, faint.
//
// Ported from the action-dispatch loop, not invented: RunTurnActionsFunctions
// (src/battle_main.c:4653-4669) calls one handler per slot;
// HandleAction_ActionFinished (src/battle_util.c:848-861) advances
// gCurrentTurnActionNumber and re-sorts the NEXT slot before reading its action;
// HandleAction_UseMove (:177-186) aborts the action if its battler is not alive.
// Those three are the whole shape of this module.
//
// DELIBERATELY ABSENT, all of it the next batches: move effects, status,
// switching, end-of-turn residuals, the AI, PP deduction, accuracy checks,
// multi-hit sequencing, and every battle-script behaviour. A damaging move
// hits, damage lands, a battler may faint. Nothing else happens.
//
// Absent from the three functions above SPECIFICALLY, listed because a reader
// comparing this loop against them should not have to spot the gaps:
//
//   HandleAction_ActionFinished (:848-861) -- this loop ports only the advance
//   and the re-sort. Its other six statements are all omitted:
//     :849  monToSwitchIntoId[...] = 6, resetting the pending-switch slot to the
//           PARTY_SIZE sentinel. Belongs with switching; noted because the
//           sentinel's value is itself a trap (see state.ts's own doc).
//     :856  TurnStructsClear() -- per-action reset of gTurnStructs. This loop
//           never writes TurnState, so there is nothing yet to clear.
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
  targetId: number | null
  /** HP removed from the TARGET. null means nothing happened at all, which is
   * distinct from 0. */
  targetDamage: number | null
  /** HP removed from the ATTACKER by its own action -- recoil, Life Orb, Rough
   * Skin, Destiny Bond. Carried from the start rather than added later, because
   * retrofitting it would change this interface, every resolver and every test,
   * and because the game's faint handling branches on WHICH battler fainted. */
  attackerDamage: number | null
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

export interface DamageResolver {
  resolve(state: BattleState, attackerId: number, targetId: number, action: ChosenAction): DamageResolution
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
    // :4546 / :839 / :851 -- re-sort THIS slot before reading who is in it.
    recalculateMoveOrder(order, state, actions, index, false, ctx, deps.statStageRatios)

    const battlerId = order.battlerByTurnOrder[index]
    const action = actions[battlerId] ?? null
    const actionKind = order.actionsByTurnOrder[index]

    // HandleAction_UseMove:181-186 -- a battler that fainted earlier this turn
    // does not act. Its slot is still consumed; the action is simply finished.
    const blank = { turnOrderIndex: index, battlerId, action: actionKind, targetId: null, targetDamage: null, attackerDamage: null, unmodelled: [], fainted: [] }

    if (!isBattlerAlive(state, battlerId)) {
      outcomes.push({ ...blank, skippedBecauseFainted: true })
      continue
    }

    if (actionKind !== 'USE_MOVE' || !action || action.chosenMove === null) {
      outcomes.push({ ...blank, skippedBecauseFainted: false })
      continue
    }

    const targetId = action.target
    if (targetId === null || !isBattlerAlive(state, targetId)) {
      // No living target: the move resolves to nothing here. The real game runs
      // a fail branch with messages and effect-specific behaviour; this batch
      // models only that no damage is dealt.
      outcomes.push({ ...blank, skippedBecauseFainted: false, targetId })
      continue
    }

    const { targetDamage, attackerDamage, unmodelled } = deps.damage.resolve(state, battlerId, targetId, action)
    const fainted: number[] = []
    applyDamage(state, targetId, targetDamage, fainted)
    applyDamage(state, battlerId, attackerDamage, fainted)

    outcomes.push({ turnOrderIndex: index, battlerId, action: actionKind, skippedBecauseFainted: false, targetId, targetDamage, attackerDamage, unmodelled, fainted })
  }

  return { actions: outcomes, order }
}
