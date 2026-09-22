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
// switching, end-of-turn residuals, the AI, multi-hit sequencing, and every
// battle-script behaviour besides the accuracy check and PP deduction below.
// A move may miss; PP is deducted; a hit deals damage; a battler may faint.
// Nothing else happens.
//
// Accuracy (Cmd_accuracycheck, battle_script_commands.c:1398-1447) and PP
// deduction (Cmd_ppreduce, :1460-1506) are ported for every USE_MOVE action
// with a living target, in that C order: the accuracy draw happens first (its
// own RandomSource draw), then PP is deducted UNCONDITIONALLY -- the miss
// branch BattleScript_PrintMoveMissed (battle_scripts_1.s:3092-3094) runs
// ppreduce as well, so a miss still costs PP. Two branches of Cmd_accuracycheck are NOT reachable by this loop, by
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
import type { SimDataContext } from './dataContext'
import { gapsToUnmodelled } from './bridge'
import { buildAccuracyInputs } from './accuracyBridge'
import { getTotalAccuracy } from './accuracy'
import { battlerHasAbility } from '../abilities/dispatch'

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
function isAbilityAliveOnOpposingSide(state: BattleState, battlerId: number, abilityId: string): boolean {
  const side = battlerId & 1
  for (let id = 0; id < state.battlersCount; id++) {
    if ((id & 1) === side) continue
    if (!isBattlerAlive(state, id)) continue
    const battler = state.battlers[id]
    if (battler && battlerHasAbility(battler.mon.abilities, abilityId, () => false)) return true
  }
  return false
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
    // :4546 / :839 / :851 -- re-sort THIS slot before reading who is in it.
    recalculateMoveOrder(order, state, actions, index, false, ctx, deps.statStageRatios)

    const battlerId = order.battlerByTurnOrder[index]
    const action = actions[battlerId] ?? null
    const actionKind = order.actionsByTurnOrder[index]

    // HandleAction_UseMove:181-186 -- a battler that fainted earlier this turn
    // does not act. Its slot is still consumed; the action is simply finished.
    const blank = { turnOrderIndex: index, battlerId, action: actionKind, missed: false, targetId: null, targetDamage: null, attackerDamage: null, unmodelled: [], fainted: [] }

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

    const targetIndex = order.battlerByTurnOrder.indexOf(targetId)
    const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < index
    const unmodelled: string[] = []

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
      outcomes.push({ turnOrderIndex: index, battlerId, action: actionKind, skippedBecauseFainted: false, missed: true, targetId, targetDamage: null, attackerDamage: null, unmodelled, fainted: [] })
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
      unmodelled: [...unmodelled, ...damageUnmodelled],
      fainted,
    })
  }

  // battle_main.c increments gBattleResults.battleTurnCounter after the action
  // loop; state.turnCount is therefore the zero-based counter while resolving
  // this turn (turn 1 is 0), matching bridge.ts's parity checks.
  // battle_main.c:3512-3513 saturates the u8 counter at 0xFF.
  state.turnCount = Math.min(0xFF, state.turnCount + 1)
  return { actions: outcomes, order }
}
