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
// application, stat changes, hazards, ...), the AI, multi-hit sequencing, and
// every battle-script behaviour besides the attack canceller, the accuracy
// check and PP deduction below. A move may be cancelled before it is even
// attempted; a move may miss; PP is deducted; a hit deals damage; a battler
// may faint. Nothing else happens during the action loop itself.
//
// SWITCHING is now PARTIAL, not absent: this batch (faint-replacement) ports
// end-of-turn replacement only -- see switchIn.ts's own header. Still absent:
// mid-turn switching (a chosen SWITCH action, U-turn/Baton-Pass/Roar-class
// forced switches), and the AI's own replacement choice
// (GetMostSuitableMonToSwitchInto) -- this batch takes the replacement choice
// as an injected dependency (TurnLoopDeps.replacement) instead.
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
//     :849  monToSwitchIntoId[...] = 6 -- ported as resetPendingSwitch();
//           once chosen switches exist, a stale slot would be reused by every
//           later GetMostSuitableMonToSwitchInto call.
//     :857  gLastLandedMoves[gBattlerAttacker] = 0 -- ported below (resets
//           battler.lastLandedMove to null).
//     :858  gLastHitByType[gBattlerAttacker] = 0 -- ported below (resets
//           battler.lastHitByType to null).
//   Its other two statements are omitted:
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
//   battle-over short-circuit, and the loop's real termination condition.
//   PORTED (faint-replacement batch): state.battleOutcome is recomputed after
//   every damage application (applyDamage below, via outcome.ts's
//   computeBattleOutcome) and checked at the top of every remaining slot in
//   THIS loop -- see the loop body's own citation on why that is a deliberate
//   extension past the literal C timing (checkteamslost is not actually
//   called after an ordinary move's tryfaintmon in the real game) rather than
//   a guess. Both end-turn ladders and end-of-turn replacement are gated on
//   it too -- see executeTurn's own citation at the bottom of this file.
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

import type { BattleOutcome, BattleState, BattlerState, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderContext, TurnOrder, TurnOrderMoveView } from './turnOrder'
import { recalculateMoveOrder, setActionsAndBattlersTurnOrder } from './turnOrder'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import type { SimDataContext } from './dataContext'
import { gapsToUnmodelled } from './bridge'
import { buildAccuracyInputs } from './accuracyBridge'
import { getTotalAccuracy } from './accuracy'
export { buildAccuracyInputs, getTotalAccuracy }
import { battlerHasAbility } from '../abilities/dispatch'
import type { CancelReason } from './attackCanceller'
import { runAttackCanceller } from './attackCanceller'
import { clearBattlerLastTakenMove, createFieldBeganThisTurn, createRoundState, createSideBeganThisTurn, createTurnState, createVolatileBeganThisTurn } from './create'
import type { EndTurnEffectResult } from './endTurn'
import { canBattlerHeal, runEndTurnEffects } from './endTurn'
import { runFieldEndTurnEffects } from './fieldEndTurn'
import { computeBattleOutcome, syncPartyHp } from './outcome'
import type { ReplacementDeps } from './switchIn'
import { applyEndOfTurnReplacements, switchIn } from './switchIn'
import type { HazardTypeDeps } from './hazards'
import { getBattlerAbilitySlotsReverse, runMoveEnd, runMoveEndBookkeeping } from './moveEnd'
import { applyAbsorbEffect } from './absorb'
import { checkMegaEvolutionBeforeTurn, undoMegaEvolution } from './formChange'
import {
  BATTLE_TYPE_ARENA,
  B_SIDE_PLAYER,
  clearFlag,
  hasFlag,
  PARTY_SIZE,
  setFlag,
  SIDE_STATUS_CRAFTY_SHIELD,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_WIDE_GUARD,
  STATUS1_ANY,
  STATUS2_CONFUSION,
  STATUS2_CURSED,
  STATUS2_ENRAGED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_MULTIPLETURNS,
  STATUS2_POWDER,
  STATUS2_SUBSTITUTE,
  STATUS2_TORMENT,
  STATUS3_ALWAYS_HITS,
  STATUS3_ALWAYS_HITS_TURN,
  STATUS3_AQUA_RING,
  STATUS3_CHARGED_UP,
  STATUS3_EMBARGO,
  STATUS3_GASTRO_ACID,
  STATUS3_GRUDGE,
  STATUS3_HEAL_BLOCK,
  STATUS3_LEECHSEED,
  STATUS3_LEECHSEED_BATTLER,
  STATUS3_MAGNET_RISE,
  STATUS3_ON_AIR,
  STATUS3_PERISH_SONG,
  STATUS3_PHANTOM_FORCE,
  STATUS3_POWER_TRICK,
  STATUS3_ROOTED,
  STATUS3_SEMI_INVULNERABLE,
  STATUS3_TELEKINESIS,
  STATUS3_UNDERGROUND,
  STATUS3_UNDERWATER,
  STATUS4_SALT_CURE,
  STATUS_FIELD_TRICK_ROOM,
  WEATHER_FOG_ANY,
} from './constants'
import { canBattlerEscape, isAbilityPreventingEscape, type EscapeDeps } from './escape'
import type { MoveBehaviors } from '../basePower'
import { applySecondaryMoveEffects, getMoveEffectHandler } from './moveEffects'
import {
  attackerHasMoldBreakerActive,
  battlerHasSimAbility,
  B_MSG_DEFENDER_STAT_FELL,
  changeStatBuffsImplicit,
  consumeHeldItem,
  dispatchOnStatLowered,
  isBattlerWeatherAffected,
  isSimAbilitySuppressed,
  isUnnerveAbilityOnOpposingSide,
  MOVE_EFFECT_ATK_MINUS_1,
  MOVE_EFFECT_DEF_MINUS_1,
  MOVE_EFFECT_SP_DEF_MINUS_1,
  MOVE_EFFECT_SPD_MINUS_1,
  STAT_BUFF_UPDATE_MOVE_EFFECT,
  runReactiveAbilityEffects,
} from './statBuffs'
import {
  applyPrimaryStatusEffect,
  cancelMultiTurnMoves,
  doesSubstituteBlockMove,
  isPowderImmune,
  isPreventableSecondaryEffect,
  MOVE_EFFECT_BLEED,
  MOVE_EFFECT_BURN,
  MOVE_EFFECT_PARALYSIS,
  MOVE_EFFECT_POISON,
  PRIMARY_STATUS_MOVE_EFFECT,
  testSheerForceFlag,
  type StatusDeps,
} from './statusEffects'
import { runBattleEvents } from './battleEvents'

/**
 * Cmd_setsemiinvulnerablebit, src/battle_script_commands.c:11541-11566.
 * Sets the appropriate semi-invulnerable status flag on battler.statuses3 for two-turn moves.
 */
export function setSemiInvulnerableBit(battler: BattlerState, moveId: string): void {
  switch (moveId) {
    case 'MOVE_FLY':
    case 'MOVE_BOUNCE':
    case 'MOVE_ROCK_CLIMB':
    case 'MOVE_SKY_DROP':
    case 'MOVE_SEISMIC_TOSS':
      battler.statuses3 = setFlag(battler.statuses3, STATUS3_ON_AIR)
      break
    case 'MOVE_DIG':
      battler.statuses3 = setFlag(battler.statuses3, STATUS3_UNDERGROUND)
      break
    case 'MOVE_DIVE':
    case 'MOVE_TOXIC_PLUNGE':
      battler.statuses3 = setFlag(battler.statuses3, STATUS3_UNDERWATER)
      break
    case 'MOVE_PHANTOM_FORCE':
    case 'MOVE_SHADOW_FORCE':
    case 'MOVE_CHEAP_SHOT':
    case 'MOVE_READY_OR_NOT':
      battler.statuses3 = setFlag(battler.statuses3, STATUS3_PHANTOM_FORCE)
      break
  }
}

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

export interface StatChangeOutcome {
  battlerId: number
  stat: number
  change: number
}

export interface StatusAppliedOutcome {
  battlerId: number
  status: string
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
  /** True when RunTurnActionsFunctions's own short-circuit (battle_main.c:4654,
   * `if (gBattleOutcome != 0) gCurrentActionFuncId = B_ACTION_FINISHED;`) ran
   * for this slot -- the outcome was already decided (by an earlier action's
   * faint this SAME turn) before this slot was even reached. Distinct from
   * `skippedBecauseFainted`: THIS battler may well still be alive; its action
   * simply never runs because the battle is already over. Not attempted, not
   * cancelled, not missed -- every other outcome field stays at its blank
   * default. */
  battleOver: boolean
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
  /** Stat changes applied during this action. null when not attempted/applicable (e.g. damaging moves or unhandled actions). */
  statChanges: StatChangeOutcome[] | null
  /** Status applied during this action. null when not attempted/applicable or no status was applied. */
  statusApplied: StatusAppliedOutcome | null
  /** The damage engine's own "I could not model this" channel, passed through
   * rather than dropped at the boundary. Anything in here means the numbers
   * above are incomplete. */
  unmodelled: string[]
  /** Battler ids that reached 0 HP as a result of THIS action, in the order they
   * did. Target before attacker: the real ordering is decided by the move's
   * battle script, which this batch does not model, so the order here is the
   * loop's own and a later batch should assert against the script. */
  fainted: number[]
  /**
   * Overrides gChosenMove for move-end bookkeeping (src/battle_script_commands.c:10483, 10836).
   * E.g. Transform and Sketch set gChosenMove = 0xFFFF (MOVE_UNSET).
   */
  chosenMoveId?: string
  /**
   * Cmd_jumptocalledmove (battle_script_commands.c:5906-5914):
   * When set on a handler outcome, instructs executeAction to re-enter the move pipeline for moveId.
   */
  jumpToCalledMove?: {
    moveId: string
    keepChosenMove?: boolean
    targetId?: number | null
  }
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
   * happened, the same way `order` lets a test assert the action loop's. Empty
   * when the field ladder never ran at all (the outcome was already decided
   * before this turn's end-turn phases started -- see `outcome` below). */
  endTurnOrder: number[]
  /** `state.battleOutcome` as it stands when this turn finishes -- see
   * state.ts's own `BattleOutcome` doc and outcome.ts's `computeBattleOutcome`
   * for how it gets set. Mirrors the state field rather than replacing it, the
   * same precedent as `order`/`endTurn` exposing state the loop mutates in
   * place. */
  outcome: BattleOutcome
  /** switchIn.ts's own gap channel (switch-in abilities/items whose real C
   * condition was true for the mon that just took the field) -- kept apart
   * from `endTurnUnmodelled` because these gaps belong to the replacement
   * phase, which runs after both end-turn ladders, not to either ladder
   * itself. Empty when no replacement happened this turn (nothing fainted, no
   * live reserve, the battle was already decided, or the caller supplied no
   * `deps.replacement` at all). */
  replacementUnmodelled: string[]
  /** Number of Mega Evolutions that took place this turn. */
  megaEvolutions?: number
  /** Which battlers evolved this turn, in battler order (CheckMegaEvolutionBeforeTurn, battle_main.c:4513-4541). */
  megaEvolved?: { battlerId: number; speciesId: string; unmodelled: string[] }[]
  /** battleEvents.ts's own gap channel. */
  battleEventsUnmodelled?: string[]
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
  absorbingAbility?: string | null
  isCriticalHit?: boolean
  berryReduced?: boolean
  isSuperEffective?: boolean
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
  /** switchIn.ts's own injected choice for which reserve replaces a fainted
   * active battler at end of turn -- AND (cycle 15) for resolving a chosen
   * SWITCH action's target party slot when `state.battlers[id].monToSwitchIntoId`
   * was left at PARTY_SIZE (ChooseMoveOrAction_Singles' own second switch
   * check does not resolve a specific mon itself, matching
   * OpponentHandleChoosePokemon reaching the SAME `GetMostSuitableMonToSwitchInto`
   * + fallback this deps object already runs for end-of-turn replacement).
   * Optional and defaulting to "no replacement": every caller that predates
   * this batch (every existing test in this directory) supplies no party
   * roster at all, so there is never a live reserve to replace regardless --
   * but making this optional rather than mandatory keeps those callers'
   * `TurnLoopDeps` literals compiling unchanged. */
  replacement?: ReplacementDeps
  /** moveBehaviors.json's `behaviors` map. Optional: when absent, structured
   * behaviors read from moveData.customBehavior instead. */
  moveBehaviors?: MoveBehaviors
  /** Type tables for Stealth Rock's GetStealthHazardDamage (hazards.ts).
   * Optional for the same reason as `replacement`; a Stealth Rock switch-in
   * without it is gapped rather than guessed. */
  hazardTypes?: HazardTypeDeps
}

/** Assembles the TurnOrderContext the loop actually runs with: the caller's
 * fields plus a REAL isBattlerGrounded. Exported so a test can assert the
 * substitution happened rather than trusting it. */
export function buildTurnOrderContext(state: BattleState, deps: TurnLoopDeps): TurnOrderContext {
  return {
    ...deps.turnOrder,
    get isTrickRoomActive() {
      if (deps.grounding.isCluelessOnField || deps.grounding.monotypeChampType === 'FLYING') return false
      return deps.turnOrder.isTrickRoomActive || hasFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM)
    },
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

/** HandleAction_ActionFinished:849 -- monToSwitchIntoId[battler] = PARTY_SIZE. */
function resetPendingSwitch(state: BattleState, battlerId: number): void {
  const battler = state.battlers[battlerId]
  if (battler) battler.monToSwitchIntoId = PARTY_SIZE
}

/** TurnValuesCleanUp(FALSE), battle_main.c:4490-4492, 4505-4508 -- ZERO(gRoundStructs[i]) for every battler,
 * decrement isFirstTurn, clear the one-turn side shields (Wide Guard, Crafty Shield, Mat Block),
 * and clear followmeTimer. */
export function roundStructsClear(state: BattleState): void {
  for (const battler of state.battlers) {
    if (battler) {
      battler.round = createRoundState()
      if (battler.volatiles.isFirstTurn) {
        battler.volatiles.isFirstTurn--
      }
    }
  }
  for (const side of state.sides) {
    side.statuses = clearFlag(side.statuses, SIDE_STATUS_WIDE_GUARD | SIDE_STATUS_CRAFTY_SHIELD | SIDE_STATUS_MAT_BLOCK)
    side.timers.followmeTimer = 0
  }
}

/** CheckFocusPunch_ClearVarsBeforeTurnStarts, battle_main.c:4589-4595 -- every `started`
 * flag is cleared before the turn's actions, not at the end of the previous turn, so a
 * timer set by a between-turns switch-in is still counted down this turn. */
export function clearStartedFlags(state: BattleState): void {
  for (const battler of state.battlers) {
    if (battler) battler.volatiles.started = createVolatileBeganThisTurn()
  }
  for (const side of state.sides) {
    side.timers.started = createSideBeganThisTurn()
  }
  state.field.timers.started = createFieldBeganThisTurn()
}

/**
 * ProtectType enum, include/battle_util.h:286-291.
 */
export const ProtectType = {
  PROTECT_NONE: 0,
  PROTECT_BLOCK: 1 << 0,
  PROTECT_TOUCH_BUT_DAMAGED: 1 << 1,
  PROTECT_BLOCK_ALWAYS_TOUCH: (1 << 0) | (1 << 2),
} as const
export type ProtectType = (typeof ProtectType)[keyof typeof ProtectType]

/** FLAG_PROTECT_AFFECTED as the codegen emits it (BattleMovesGenerator.kt:16-24, :89):
 * `!move.ignoresProtect && move.target in PROTECT_AFFECTED_TARGETS`. */
const PROTECT_AFFECTED_TARGETS = new Set(['BOTH', 'DEPENDS', 'FOES_AND_ALLY', 'RANDOM', 'SELECTED', 'USER_OR_SELECTED'])
function isProtectAffected(moveData: { flags?: Record<string, true>; target?: string } | undefined): boolean {
  return !moveData?.flags?.ignoresProtect && PROTECT_AFFECTED_TARGETS.has(moveData?.target ?? '')
}

/**
 * IsAffectedByFollowMe, src/battle_util.c:118-126.
 * Checks whether an incoming move from battlerAtk is redirected by defSide's Follow Me / Rage Powder.
 */
export function isAffectedByFollowMe(
  state: BattleState,
  battlerAtk: number,
  defSide: number,
  moveId: string,
  deps: TurnLoopDeps,
): boolean {
  const sideTimers = state.sides[defSide]?.timers
  if (!sideTimers || sideTimers.followmeTimer === 0) return false
  const targetId = sideTimers.followmeTarget
  const targetMon = state.battlers[targetId]
  if (!targetMon || targetMon.mon.hp === 0) return false

  const moveData = deps.dataContext.move(moveId)
  if (moveData?.effect === 'EFFECT_SNIPE_SHOT') return false

  // IsAbilityStatusProtected(battlerAtk, CHECK_REDIRECTION) (src/battle_script_commands.c:6579, src/abilities.cc:10606, 10615)
  const attacker = state.battlers[battlerAtk]
  if (attacker) {
    if (
      battlerHasSimAbility(state, attacker, 'ABILITY_PROPELLER_TAIL', false, battlerAtk, false, deps.dataContext) ||
      battlerHasSimAbility(state, attacker, 'ABILITY_STALWART', false, battlerAtk, false, deps.dataContext)
    ) {
      return false
    }
  }

  // if (gSideTimers[defSide].followmePowder && IsPowderImmune(battlerAtk, TRUE)) return FALSE;
  if (sideTimers.followmePowder && isPowderImmune(state, battlerAtk, battlerAtk, deps)) {
    return false
  }

  return true
}

/**
 * GetMoveTarget, src/battle_util.c:6343-6416.
 * Resolves the target battler for a move (defaulting setTarget = 0).
 */
export function getMoveTarget(
  state: BattleState,
  attacker: number,
  moveId: string,
  deps: TurnLoopDeps,
  setTarget: number = 0,
): number {
  let moveTarget: string
  const moveData = deps.dataContext.move(moveId)

  if (setTarget) {
    moveTarget = moveData?.target ?? 'SELECTED'
  } else {
    moveTarget = moveData?.target ?? 'SELECTED'
  }

  // Special cases (src/battle_util.c:6353-6360)
  if (moveId === 'MOVE_CURSE') {
    const attackerBattler = state.battlers[attacker]
    const isGhost = attackerBattler?.mon.types.includes('TYPE_GHOST') ?? false
    if (isGhost || isBattlerWeatherAffected(state, attacker, WEATHER_FOG_ANY, deps)) {
      moveTarget = 'SELECTED'
    } else {
      moveTarget = 'USER'
    }
  }

  const getPartner = (id: number): number => id ^ 2
  const isAlive = (id: number): boolean => isBattlerAlive(state, id)

  // SetRandomTarget (src/battle_util.c:6326-6341)
  const setRandomTarget = (battlerId: number): number => {
    const side = battlerId & 1
    const targets = [
      [1, 3], // B_SIDE_PLAYER -> OPPONENT_LEFT (1), OPPONENT_RIGHT (3)
      [0, 2], // B_SIDE_OPPONENT -> PLAYER_LEFT (0), PLAYER_RIGHT (2)
    ]
    if (state.battlersCount > 2) {
      const target = targets[side][0]
      if (isAlive(target)) return target
      const flank = target ^ 2
      if (isAlive(flank)) return flank
      return target
    } else {
      return targets[side][0]
    }
  }

  let targetBattler = 0
  const side = (attacker & 1) ^ 1

  switch (moveTarget) {
    case 'SELECTED': {
      if (isAffectedByFollowMe(state, attacker, side, moveId, deps)) {
        targetBattler = state.sides[side]?.timers.followmeTarget ?? (attacker ^ 1)
      } else {
        targetBattler = setRandomTarget(attacker)
      }
      break
    }
    case 'DEPENDS':
    case 'BOTH':
    case 'FOES_AND_ALLY':
    case 'OPPONENTS_FIELD': {
      targetBattler = attacker ^ 1
      if (!isAlive(targetBattler)) {
        const partner = getPartner(targetBattler)
        if (isAlive(partner)) {
          targetBattler = partner
        } else if (moveTarget === 'FOES_AND_ALLY' && isAlive(getPartner(attacker))) {
          targetBattler = getPartner(attacker)
        }
      }
      break
    }
    case 'RANDOM': {
      if (isAffectedByFollowMe(state, attacker, side, moveId, deps)) {
        targetBattler = state.sides[side]?.timers.followmeTarget ?? (attacker ^ 1)
      } else if (state.battlersCount > 2) {
        targetBattler = setRandomTarget(attacker)
      } else {
        targetBattler = attacker ^ 1
      }
      break
    }
    case 'USER_OR_SELECTED':
    case 'USER':
    default:
      targetBattler = attacker
      break
    case 'ALLY': {
      const partner = getPartner(attacker)
      if (isAlive(partner)) {
        targetBattler = partner
      } else {
        targetBattler = attacker
      }
      break
    }
  }

  return targetBattler
}

/**
 * BlocksPrankster, src/battle_util.c:8622-8635.
 * Returns true if battlerPrankster's status move is blocked by battlerDef's Dark typing.
 */
export function blocksPrankster(
  state: BattleState,
  moveId: string,
  battlerPranksterId: number,
  battlerDefId: number,
  checkTarget: boolean,
  deps: TurnLoopDeps,
): boolean {
  // battle_util.c:8623-8628
  if (state.processingExtraAttacks) {
    if (!state.currentExtraAttack?.prankster) return false
  } else {
    const moveData = deps.dataContext.move(moveId)
    if (moveData?.split !== 'STATUS') return false
    const pranksterBattler = state.battlers[battlerPranksterId]
    if (!pranksterBattler) return false
    if (!battlerHasSimAbility(state, pranksterBattler, 'ABILITY_PRANKSTER', false, battlerPranksterId, false, deps.dataContext)) {
      return false
    }
  }
  if ((battlerPranksterId & 1) === (battlerDefId & 1)) return false
  const moveData = deps.dataContext.move(moveId)
  if (checkTarget && (moveData?.target === 'OPPONENTS_FIELD' || moveData?.target === 'DEPENDS')) return false
  const defBattler = state.battlers[battlerDefId]
  if (!defBattler) return false
  if (!defBattler.mon.types.includes('DARK')) return false
  if (hasFlag(defBattler.statuses3, STATUS3_SEMI_INVULNERABLE)) return false

  return true
}

/**
 * Port of IsBattlerProtected, src/battle_util.c:6571-6645.
 */
export function isBattlerProtected(
  state: BattleState,
  attackerId: number,
  targetId: number,
  moveId: string,
  targetHasActedThisTurn: boolean,
  deps: TurnLoopDeps,
  unmodelled: string[],
): ProtectType {
  const targetBattler = state.battlers[targetId]
  const attackerBattler = state.battlers[attackerId]
  if (!targetBattler || !attackerBattler) return ProtectType.PROTECT_NONE

  const moveData = deps.dataContext.move(moveId)
  const isStatus = moveData?.split === 'STATUS'
  const moveType = moveData?.type ?? null

  // :6578 -- if (IS_MOVE_STATUS(move) && !(gBattleMoves[move].flags & FLAG_PROTECT_AFFECTED)) return PROTECT_NONE;
  const protectAffected = isProtectAffected(moveData)
  if (isStatus && !protectAffected) {
    return ProtectType.PROTECT_NONE
  }

  // :6580-6588 -- switch (gRoundStructs[battlerId].protectMove) for Merculight and Detect
  switch (targetBattler.round.protectMove) {
    case 'MOVE_MERCULIGHT': {
      const { inputs, gaps, defenderHasAnticipation } = buildAccuracyInputs(
        state,
        attackerId,
        targetId,
        moveId,
        targetHasActedThisTurn,
        deps,
      )
      unmodelled.push(...gapsToUnmodelled(gaps))
      if (defenderHasAnticipation) {
        unmodelled.push(
          "Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432) is not modelled: GetSingleUseAbilityCounter has no state anywhere in this codebase, and the type-effectiveness multiplier it needs is not known until the damage resolver runs afterwards",
        )
      }
      const accResult = getTotalAccuracy(inputs)
      unmodelled.push(...gapsToUnmodelled(accResult.gaps))
      if (accResult.accuracy < 101 && !isStatus) {
        return ProtectType.PROTECT_BLOCK_ALWAYS_TOUCH
      }
      break
    }
    case 'MOVE_DETECT': {
      const { inputs, gaps, defenderHasAnticipation } = buildAccuracyInputs(
        state,
        attackerId,
        targetId,
        moveId,
        targetHasActedThisTurn,
        deps,
      )
      unmodelled.push(...gapsToUnmodelled(gaps))
      if (defenderHasAnticipation) {
        unmodelled.push(
          "Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432) is not modelled: GetSingleUseAbilityCounter has no state anywhere in this codebase, and the type-effectiveness multiplier it needs is not known until the damage resolver runs afterwards",
        )
      }
      const accResult = getTotalAccuracy(inputs)
      unmodelled.push(...gapsToUnmodelled(accResult.gaps))
      if (accResult.accuracy < 101) {
        return ProtectType.PROTECT_BLOCK
      }
      break
    }
  }

  // :6590-6603 -- evadesProtect logic
  let evadesProtect = false
  const isContact = moveData?.flags?.contact === true

  if (
    (battlerHasSimAbility(state, attackerBattler, 'ABILITY_UNSEEN_FIST', false, attackerId, false, deps.dataContext) ||
      battlerHasSimAbility(state, attackerBattler, 'ABILITY_FINAL_BLOW', false, attackerId, false, deps.dataContext)) &&
    isContact
  ) {
    evadesProtect = true
  } else if (
    battlerHasSimAbility(state, attackerBattler, 'ABILITY_DEMOLITIONIST', false, attackerId, false, deps.dataContext) &&
    attackerBattler.volatiles.readiedAction
  ) {
    evadesProtect = true
  } else if (
    battlerHasSimAbility(state, attackerBattler, 'ABILITY_PINNACLE_BLADE', false, attackerId, false, deps.dataContext) &&
    moveData?.flags?.sliceBased === true
  ) {
    evadesProtect = true
  } else if (!protectAffected) {
    evadesProtect = true
  } else if (moveData?.effect === 'EFFECT_FEINT') {
    evadesProtect = true
  }

  // :6604-6636
  if (!evadesProtect) {
    const protectMove = targetBattler.round.protectMove
    if (protectMove) {
      switch (protectMove) {
        case 'MOVE_NONE':
          break

        case 'MOVE_OBSTRUCT':
        case 'MOVE_SILK_TRAP':
        case 'MOVE_BURNING_BULWARK':
        case 'MOVE_KINGS_SHIELD':
        case 'MOVE_IRON_DEFENSE':
          if (!isStatus) return ProtectType.PROTECT_BLOCK
          break

        case 'MOVE_TANGLING_HUSK':
          if (moveType !== 'TYPE_FIRE') return ProtectType.PROTECT_BLOCK
          break

        case 'MOVE_CAMOUFLAGE':
          return ProtectType.PROTECT_BLOCK_ALWAYS_TOUCH

        case 'MOVE_ICE_BURN':
        case 'MOVE_FREEZE_SHOCK':
          break

        default:
          return ProtectType.PROTECT_BLOCK
      }
    }

    const side = targetId & 1
    const sideStatuses = state.sides[side]?.statuses ?? 0
    if (
      (sideStatuses & SIDE_STATUS_WIDE_GUARD) &&
      (moveData?.target === 'BOTH' || moveData?.target === 'FOES_AND_ALLY')
    ) {
      return ProtectType.PROTECT_BLOCK
    } else if ((sideStatuses & SIDE_STATUS_CRAFTY_SHIELD) && isStatus) {
      return ProtectType.PROTECT_BLOCK
    } else if ((sideStatuses & SIDE_STATUS_MAT_BLOCK) && !isStatus) {
      return ProtectType.PROTECT_BLOCK
    }
  }

  // :6638-6642
  const protectMove = targetBattler.round.protectMove
  if (protectMove === 'MOVE_ICE_BURN' || protectMove === 'MOVE_FREEZE_SHOCK') {
    return ProtectType.PROTECT_TOUCH_BUT_DAMAGED
  }

  return ProtectType.PROTECT_NONE
}

/**
 * MOVEEND_PROTECT_LIKE_EFFECT, src/battle_script_commands.c:4343-4433. Every
 * shield but Camouflage sets gBattleScripting.moveEffect and calls
 * BattleScript_KingsShieldEffect (data/battle_scripts_1.s:10550-10557), which
 * swaps attacker and target around `seteffectsecondary` -- SetMoveEffect(FALSE,
 * FALSE) with the protector as gBattlerAttacker, the contact attacker as
 * gEffectBattler, and gCurrentMove still the contact attacker's move. The
 * script's HITMARKER_IGNORE_SUBSTITUTE is never read by DoesSubstituteBlockMove
 * (:12252-12260), so a Substitute still blocks the effect.
 *
 * Not ported: MOVE_IRON_DEFENSE (Angel's Wrath, :4353-4374) is unreachable --
 * Iron Defense is EFFECT_DEFENSE_UP_2 and never sets protectMove. Mirror
 * Armor's STAT_BUFF_ALLOW_PTR (:2774) is not applied, as in
 * applySecondaryMoveEffects.
 */
const PROTECT_LIKE_MOVE_EFFECTS: Record<string, number> = {
  MOVE_BANEFUL_BUNKER: MOVE_EFFECT_POISON,
  MOVE_SILK_TRAP: MOVE_EFFECT_SPD_MINUS_1,
  MOVE_TANGLING_HUSK: MOVE_EFFECT_SPD_MINUS_1,
  MOVE_BURNING_BULWARK: MOVE_EFFECT_BURN,
  MOVE_ICE_BURN: MOVE_EFFECT_BURN,
  MOVE_SPIKY_SHIELD: MOVE_EFFECT_BLEED,
  MOVE_MERCULIGHT: MOVE_EFFECT_PARALYSIS,
  MOVE_FREEZE_SHOCK: MOVE_EFFECT_PARALYSIS,
  MOVE_OBSTRUCT: MOVE_EFFECT_DEF_MINUS_1,
  MOVE_MIND_READER: MOVE_EFFECT_SP_DEF_MINUS_1,
  MOVE_KINGS_SHIELD: MOVE_EFFECT_ATK_MINUS_1,
}

export function handleProtectLikeMoveEnd(
  state: BattleState,
  attackerId: number,
  targetId: number,
  currentMoveId: string,
  deps: TurnLoopDeps,
  unmodelled: string[],
): { statChanges: StatChangeOutcome[] | null; statusApplied: StatusAppliedOutcome | null } {
  const none = { statChanges: null, statusApplied: null }
  const attacker = state.battlers[attackerId]
  const target = state.battlers[targetId]
  if (!attacker?.round.touchedProtectLike || !target) return none
  attacker.round.touchedProtectLike = false
  const protectMove = target.round.protectMove
  if (!protectMove) return none

  // :4415-4427
  if (protectMove === 'MOVE_CAMOUFLAGE') {
    const moveType = deps.dataContext.move(currentMoveId)?.type
    if (!moveType) return none
    const bareType = moveType.replace(/^TYPE_/, '')
    if (target.mon.types.includes(bareType)) return none
    target.mon.types[2] = bareType
    unmodelled.push(
      "Camouflage's added type reads the move's declared type; GET_MOVE_TYPE's dynamic type changes (:4417) are not applied",
    )
    return none
  }

  const moveEffect = PROTECT_LIKE_MOVE_EFFECTS[protectMove]
  if (moveEffect === undefined) return none

  const protectorId = targetId
  const statusDeps: StatusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }

  if (moveEffect <= PRIMARY_STATUS_MOVE_EFFECT) {
    const res = applyPrimaryStatusEffect(state, protectorId, attackerId, moveEffect, currentMoveId, statusDeps, unmodelled, false, false)
    return {
      statChanges: null,
      statusApplied: res.applied && res.status ? { battlerId: attackerId, status: res.status } : null,
    }
  }

  // SetMoveEffect's preamble (:2348-2388) for the stat drops; Safeguard
  // (:2352) only covers effects <= MOVE_EFFECT_CONFUSION, so it never applies.
  if (isPreventableSecondaryEffect(moveEffect)) {
    const protector = state.battlers[protectorId]
    const protectorHasMoldBreaker = protector ? attackerHasMoldBreakerActive(protector, statusDeps) : false
    const hasShieldDust = battlerHasSimAbility(
      state,
      attacker,
      'ABILITY_SHIELD_DUST',
      true,
      protectorId,
      protectorHasMoldBreaker,
      deps.dataContext,
    )
    if (hasShieldDust || deps.grounding.holdEffectOf(attackerId) === 'HOLD_EFFECT_COVERT_CLOAK') return none
  }
  if (testSheerForceFlag(state, protectorId, currentMoveId, statusDeps)) return none
  if (attacker.mon.hp === 0) return none
  if (doesSubstituteBlockMove(state, protectorId, attackerId, currentMoveId, statusDeps, unmodelled)) return none

  // :2765-2781
  const statId = moveEffect - MOVE_EFFECT_ATK_MINUS_1 + 1
  const res = changeStatBuffsImplicit(
    state,
    protectorId,
    attackerId,
    -1,
    statId,
    STAT_BUFF_UPDATE_MOVE_EFFECT,
    true,
    statusDeps,
    unmodelled,
    currentMoveId,
  )
  const changes: StatChangeOutcome[] = []
  if (res.delta !== 0) {
    changes.push({ battlerId: attackerId, stat: statId, change: res.delta })
  }
  if (res.multistringChooser === B_MSG_DEFENDER_STAT_FELL && (protectorId & 1) !== (attackerId & 1)) {
    dispatchOnStatLowered(state, attackerId, protectorId, statusDeps, unmodelled, changes)
  }
  return changes.length > 0 ? { statChanges: changes, statusApplied: null } : none
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
export function deductPp(state: BattleState, attackerId: number, moveId: string, moveEffect: string | null, unmodelled: string[]): void {
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
 * target and attacker halves so they cannot drift apart.
 *
 * Also syncs the battler's party slot (outcome.ts's `syncPartyHp`) and
 * recomputes `state.battleOutcome` (outcome.ts's `computeBattleOutcome`) --
 * this is this batch's own "after each action's faints" call site (see this
 * module's header and outcome.ts's own header on why party HP, not battler
 * HP, is what checkteamslost actually sums). Recomputing unconditionally
 * (not just when `fainted` grew) matches Cmd_checkteamslost's own
 * unconditional call: a damage application that does NOT faint anyone cannot
 * change the outcome, but computing it fresh every time is cheaper than a
 * second conditional and cannot disagree with one. */
export function applyDamage(state: BattleState, battlerId: number, damage: number | null, fainted: number[]): void {
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
    // Cmd_tryfaintmon (src/battle_script_commands.c:3238, 3242): retaliateTimer set to 2 on faint
    state.sides[battlerId & 1].timers.retaliateTimer = 2
    clearBattlerLastTakenMove(state, battlerId)
  }
  syncPartyHp(state, battlerId)
  state.battleOutcome = computeBattleOutcome(state)
}

/**
 * HandleAction_Switch, battle_util.c:378-410, through BattleScript_ActionSwitch
 * (data/battle_scripts_1.s:7194-7224) to `switchindataupdate`/
 * `SwitchInClearSetData` -- a CHOSEN (not faint-triggered) mid-turn switch.
 *
 * Reuses switchIn.ts's `switchIn` for the incoming half exactly as the brief
 * requires ("don't write a second one") -- that function already performs
 * everything `Cmd_switchindataupdate` does (species/stats/moves/pp/hp/item/
 * status1 copied in, stat stages and volatiles reset, switch-in ability/item
 * gap reporting). The one thing `switchIn` does NOT do, because the
 * end-of-turn faint-replacement caller never needs it (a fainted mon's status1
 * is moot), is persist the OUTGOING mon's own current state back to its party
 * record before it is overwritten -- `saveattackerandtargetto34` plus the
 * party sync every other HP writer in this file already performs (outcome.ts's
 * `syncPartyHp`) covers HP, but `status1` (state.ts's own doc: "Persists
 * across switches ... copied back to the party mon") has no writer until now,
 * since nothing previously switched OUT a still-living battler mid-turn.
 *
 * The target party slot comes from `battler.monToSwitchIntoId`
 * (`gBattleStruct->monToSwitchIntoId[gActiveBattler]`) when a caller already
 * resolved it (aiShouldSwitch.ts's `aiTrySwitchOrUseItem` writes this as a
 * side effect of `ShouldSwitch` deciding TRUE); when it is still `PARTY_SIZE`
 * (ChooseMoveOrAction_Singles' own second switch check never resolves a
 * specific mon -- see chooseAiAction.ts's own citation), `deps.replacement` is
 * asked instead, reusing the SAME `GetMostSuitableMonToSwitchInto` + fallback
 * mechanism `applyEndOfTurnReplacements` already runs, matching
 * `OpponentHandleChoosePokemon` being the one real function both call sites
 * reach in the C.
 *
 * Ported: `switchoutabilities` (BattleScript_DoSwitchOut, battle_scripts_1.s:7211;
 * Cmd_switchoutabilities, src/battle_script_commands.c:12102-12120), dispatching
 * Regenerator, Eternal Blessing, Natural Cure, Self-Repair, Natural Recovery,
 * and reporting gaps for abilities requiring unmodelled state (Toxic Spill, Trash Heap,
 * Generator, Energized, Zero to Hero, Retriever, Strikeout).
 *
 * NOT ported, gapped by name only when reached: Pursuit-style `jumpifnopursuitswitchdmg`
 * branch (an opposing Pursuit user damaging the switching mon before it leaves) --
 * Pursuit's own switch-detection needs `defenderIsSwitching`, which aiCalcDamage.ts's
 * own header already notes is hardcoded false. Hazards on entry stay unreachable, same
 * precedent as switchIn.ts's own header.
 */
export const SWITCH_OUT_HOOK_ABILITIES: ReadonlySet<string> = new Set([
  'ABILITY_REGENERATOR',
  'ABILITY_ETERNAL_BLESSING',
  'ABILITY_NATURAL_CURE',
  'ABILITY_SELF_REPAIR',
  'ABILITY_NATURAL_RECOVERY',
  'ABILITY_TOXIC_SPILL',
  'ABILITY_TRASH_HEAP',
  'ABILITY_GENERATOR',
  'ABILITY_ENERGIZED',
  'ABILITY_ZERO_TO_HERO',
  'ABILITY_RETRIEVER',
  'ABILITY_STRIKEOUT',
])

/**
 * Port of Cmd_switchoutabilities (src/battle_script_commands.c:12102-12120).
 *
 * Runs on-field exit hooks when a living battler switches out (battle_scripts_1.s:7211).
 *
 * Evaluates battlers in order starting from the switching battler:
 *   for (int i = 0; i < gBattlersCount; i++) {
 *     int battler = (gActiveBattler + i) % gBattlersCount;
 *     FILTER(i == 0 || IsBattlerAlive(battler))
 *     ON_ABILITY(battler, FALSE,
 *       gAbilities[ability].onExit && IsApplyOnFlagAppropriate(gActiveBattler, battler, gAbilities[ability].onExitFor),
 *       ...)
 *   }
 *
 * Within each battler, scans ability slots in reverse order (slot 3 -> 2 -> 1 -> 0, matching ON_ABILITY).
 * Checks suppression (IsSuppressed, checkMoldBreaker=FALSE -> Neutralizing Gas / Gastro Acid).
 */
export function dispatchSwitchOutAbilities(
  state: BattleState,
  switchingBattlerId: number,
  outgoingSlot: SimPartyMon | undefined,
  deps: TurnLoopDeps,
  unmodelled: string[],
): void {
  for (let i = 0; i < state.battlersCount; i++) {
    const battlerId = (switchingBattlerId + i) % state.battlersCount
    if (i !== 0 && !isBattlerAlive(state, battlerId)) continue
    const battler = state.battlers[battlerId]
    if (!battler) continue

    const slots = getBattlerAbilitySlotsReverse(battler.mon.abilities)
    for (const { abilityId } of slots) {
      if (!SWITCH_OUT_HOOK_ABILITIES.has(abilityId)) continue

      // IsApplyOnFlagAppropriate(contextBattler=switchingBattler, sourceBattler=battler, onExitFor), abilities.cc:190-198.
      // Strikeout has onExitFor = APPLY_ON_FOE, which without APPLY_IGNORE_SELF also passes for the switching
      // battler itself (:192). All other onExit abilities default to APPLY_ON_SELF.
      const isFoe = (battlerId & 1) !== (switchingBattlerId & 1)
      const isSelf = battlerId === switchingBattlerId

      if (abilityId === 'ABILITY_STRIKEOUT') {
        if (!isFoe && !isSelf) continue
      } else {
        if (!isSelf) continue
      }

      // IsSuppressed(battler, ability, checkMoldBreaker=FALSE)
      if (isSimAbilitySuppressed(state, battler, abilityId, false, 0, false, deps.dataContext)) {
        continue
      }

      switch (abilityId) {
        case 'ABILITY_REGENERATOR':
        case 'ABILITY_ETERNAL_BLESSING': {
          // Impl<ABILITY_REGENERATOR>.onExit (abilities.cc:2106-2111) / Impl<ABILITY_ETERNAL_BLESSING>.onExit (abilities.cc:8156):
          //   CHECK(IsBattlerAlive(battler))
          //   CHECK_NOT(BATTLER_MAX_HP(battler))
          //   BattleScriptCall(BattleScript_RegeneratorExits) -> tryhealpercenthealth BS_STACK_1, 33 + datahpupdate BS_STACK_1
          // Cmd_tryhealpercenthealth (battle_script_commands.c:7896-7907):
          //   maxHP * 33 / 100, clamped min 1. Fails if max HP or !CanBattlerHeal.
          if (battler.mon.hp <= 0) break
          if (battler.mon.hp >= battler.mon.maxHp) break
          if (!canBattlerHeal(state, battlerId, battler, unmodelled)) break

          const heal = Math.max(1, Math.trunc((battler.mon.maxHp * 33) / 100))
          battler.mon.hp = Math.min(battler.mon.maxHp, battler.mon.hp + heal)
          if (outgoingSlot) outgoingSlot.hp = battler.mon.hp
          break
        }

        case 'ABILITY_NATURAL_CURE':
        case 'ABILITY_SELF_REPAIR': {
          // Impl<ABILITY_NATURAL_CURE>.onExit (abilities.cc:866-876) / Impl<ABILITY_SELF_REPAIR>.onExit (abilities.cc:5295):
          //   CHECK(IsBattlerAlive(battler))
          //   CHECK(gBattleMons[battler].status1 & STATUS1_ANY)
          //   gBattleMons[battler].status1 &= ~STATUS1_ANY;
          //   BattleScriptCall(BattleScript_NaturalCureExits) -> curestatus BS_STACK_1 (status1 = 0)
          if (battler.mon.hp <= 0) break
          if (!hasFlag(battler.mon.status1, STATUS1_ANY)) break

          battler.mon.status1 = 0
          if (outgoingSlot) outgoingSlot.status1 = 0
          break
        }

        case 'ABILITY_NATURAL_RECOVERY': {
          // Impl<ABILITY_NATURAL_RECOVERY>.onExit (abilities.cc:6263):
          //   return Impl<ABILITY_NATURAL_CURE>.onExit(DELEGATE_EXIT) | Impl<ABILITY_REGENERATOR>.onExit(DELEGATE_EXIT)
          if (battler.mon.hp > 0 && hasFlag(battler.mon.status1, STATUS1_ANY)) {
            battler.mon.status1 = 0
            if (outgoingSlot) outgoingSlot.status1 = 0
          }
          if (battler.mon.hp > 0 && battler.mon.hp < battler.mon.maxHp && canBattlerHeal(state, battlerId, battler, unmodelled)) {
            const heal = Math.max(1, Math.trunc((battler.mon.maxHp * 33) / 100))
            battler.mon.hp = Math.min(battler.mon.maxHp, battler.mon.hp + heal)
            if (outgoingSlot) outgoingSlot.hp = battler.mon.hp
          }
          break
        }

        case 'ABILITY_TOXIC_SPILL':
        case 'ABILITY_TRASH_HEAP':
          // Impl<ABILITY_TOXIC_SPILL>.onExit (abilities.cc:5245-5249), Trash Heap aliases it (:8978):
          // BattleScript_TheToxicWasHasDissapeared (battle_scripts_1.s:9370-9373) only prints a message.
          break

        case 'ABILITY_GENERATOR': {
          // Impl<ABILITY_GENERATOR>.onExit (abilities.cc:6200-6204):
          //   CHECK(gStatuses3[battler] & STATUS3_CHARGED_UP)
          //   SetSingleUseAbilityCounter(battler, ability, FALSE)
          if (hasFlag(battler.statuses3, STATUS3_CHARGED_UP)) {
            unmodelled.push(`battler ${battlerId}: switch-out Generator SetSingleUseAbilityCounter is not modelled`)
          }
          break
        }

        case 'ABILITY_ENERGIZED': {
          // Impl<ABILITY_ENERGIZED>.onExit (abilities.cc:8730): Impl<ABILITY_GENERATOR>.onExit
          if (hasFlag(battler.statuses3, STATUS3_CHARGED_UP)) {
            unmodelled.push(`battler ${battlerId}: switch-out Energized SetSingleUseAbilityCounter is not modelled`)
          }
          break
        }

        case 'ABILITY_ZERO_TO_HERO': {
          // Impl<ABILITY_ZERO_TO_HERO>.onExit (abilities.cc:7136-7139):
          //   SetSingleUseAbilityCounter(battler, ability, TRUE)
          unmodelled.push(`battler ${battlerId}: switch-out Zero to Hero SetSingleUseAbilityCounter is not modelled`)
          break
        }

        case 'ABILITY_RETRIEVER': {
          // Impl<ABILITY_RETRIEVER>.onExit (abilities.cc:6575-6591):
          //   CHECK(IsBattlerAlive(battler))
          //   CHECK_NOT(gBattleMons[battler].item)
          //   restores originalItem from itemStolen / opposingOriginalItems
          if (battler.mon.hp > 0 && battler.mon.itemId === null) {
            unmodelled.push(`battler ${battlerId}: switch-out Retriever item restoration is not modelled`)
          }
          break
        }

        case 'ABILITY_STRIKEOUT': {
          // Impl<ABILITY_STRIKEOUT>.onExit (abilities.cc:11158-11160, onExitFor = APPLY_ON_FOE):
          //   StrikeoutClearFlags(battler, ability, switchingBattler)
          unmodelled.push(`battler ${battlerId}: switch-out StrikeoutClearFlags for switching battler ${switchingBattlerId} is not modelled`)
          break
        }
      }
    }
  }
}

export interface SwitchActionOptions {
  ignoreEscapePrevention?: boolean
  forcedPartyIndex?: number
  healingWish?: boolean
  lunarDance?: boolean
  batonPass?: boolean
  shedTail?: boolean
}

export function performSwitchAction(
  state: BattleState,
  battlerId: number,
  deps: TurnLoopDeps,
  options?: SwitchActionOptions,
): string[] {
  const unmodelled: string[] = []
  const battler = state.battlers[battlerId]
  if (!battler) return unmodelled

  const escapeDeps: EscapeDeps = { dataContext: deps.dataContext, grounding: deps.grounding }

  if (!options?.ignoreEscapePrevention) {
    // battle_main.c:3747-3755: the party menu refuses the switch (PARTY_ACTION_CANT_SWITCH /
    // PARTY_ACTION_ABILITY_PREVENTS), so the game never queues it; the sim drops the action.
    if (hasFlag(state.battleTypeFlags, BATTLE_TYPE_ARENA) || !canBattlerEscape(state, battlerId, escapeDeps)) {
      unmodelled.push(`executeTurn: SWITCH action for battler ${battlerId} refused (cannot escape)`)
      return unmodelled
    }
    const abilityTrap = isAbilityPreventingEscape(state, battlerId, escapeDeps)
    unmodelled.push(...abilityTrap.unmodelled)
    if (abilityTrap.prevents) {
      unmodelled.push(`executeTurn: SWITCH action for battler ${battlerId} refused (prevented by ability of battler ${abilityTrap.trappingBattlerId})`)
      return unmodelled
    }
  }

  let partyIndex = options?.forcedPartyIndex !== undefined ? options.forcedPartyIndex : battler.monToSwitchIntoId
  if (partyIndex === PARTY_SIZE) {
    if (!deps.replacement) {
      unmodelled.push(`executeTurn: SWITCH action for battler ${battlerId} had no monToSwitchIntoId set and no deps.replacement was supplied -- nothing to switch into`)
      return unmodelled
    }
    partyIndex = deps.replacement.chooseReplacement(state, battlerId, unmodelled)
  }
  if (partyIndex === PARTY_SIZE) {
    unmodelled.push(`executeTurn: SWITCH action for battler ${battlerId} could not resolve a replacement party slot`)
    return unmodelled
  }

  const party = state.sides[battlerId & 1].party
  const outgoingSlot = party[battler.partyIndex]
  if (outgoingSlot) {
    // saveattackerandtargetto34 + status1's own "persists across switches"
    // rule (state.ts) -- HP is already current via syncPartyHp, carried here
    // too defensively so this function does not depend on every damage path
    // upstream having synced it.
    outgoingSlot.hp = battler.mon.hp
    outgoingSlot.status1 = battler.mon.status1
    // Cmd_ppreduce emits REQUEST_PP_DATA_BATTLE, so the party mon carries the spent PP.
    outgoingSlot.pp = [...battler.mon.pp] as typeof outgoingSlot.pp
  }

  // Cmd_switchoutabilities (battle_scripts_1.s:7211, battle_script_commands.c:12102)
  dispatchSwitchOutAbilities(state, battlerId, outgoingSlot, deps, unmodelled)

  if (outgoingSlot) {
    outgoingSlot.hp = battler.mon.hp
    outgoingSlot.status1 = battler.mon.status1
  }

  // State carry-over capture for Baton Pass and Shed Tail
  // (Cmd_switchindataupdate, battle_script_commands.c:5023-5026; SwitchInClearSetData, battle_main.c:2808-2838, 2878-2892)
  const savedStatStages = options?.batonPass ? [...battler.mon.statStages] : null
  const savedStatus2 = options?.batonPass
    ? (battler.mon.status2 &
        (STATUS2_CONFUSION |
          STATUS2_SUBSTITUTE |
          STATUS2_ESCAPE_PREVENTION |
          STATUS2_CURSED |
          STATUS2_POWDER |
          STATUS2_ENRAGED))
    : options?.shedTail
      ? (battler.mon.status2 & STATUS2_SUBSTITUTE)
      : null
  const savedStatuses3 = options?.batonPass
    ? (battler.statuses3 &
        (STATUS3_LEECHSEED_BATTLER |
          STATUS3_LEECHSEED |
          STATUS3_ALWAYS_HITS |
          STATUS3_PERISH_SONG |
          STATUS3_ROOTED |
          STATUS3_GASTRO_ACID |
          STATUS3_EMBARGO |
          STATUS3_TELEKINESIS |
          STATUS3_MAGNET_RISE |
          STATUS3_HEAL_BLOCK |
          STATUS3_AQUA_RING |
          STATUS3_POWER_TRICK))
    : null
  const savedStatuses4 = options?.batonPass ? (battler.statuses4 & STATUS4_SALT_CURE) : null
  const savedVolatiles = options?.batonPass
    ? {
        started: { ...battler.volatiles.started },
        substituteHp: battler.volatiles.substituteHp,
        battlerWithSureHit: battler.volatiles.battlerWithSureHit,
        perishSongTimer: battler.volatiles.perishSongTimer,
        perishSongTimerStartValue: battler.volatiles.perishSongTimerStartValue,
        battlerPreventingEscape: battler.volatiles.battlerPreventingEscape,
        critBoost: battler.volatiles.critBoost,
        parasiticSpores: battler.volatiles.parasiticSpores,
        dazed: battler.volatiles.dazed,
        trepidation: battler.volatiles.trepidation,
        drenched: battler.volatiles.drenched,
      }
    : null
  const savedSubstituteHp = options?.shedTail ? battler.volatiles.substituteHp : 0

  if (options?.batonPass) {
    // battle_main.c:2826-2832: update opposing battlers with sure-hit targeting active battler
    for (let i = 0; i < state.battlersCount; i++) {
      const opp = state.battlers[i]
      if (
        opp &&
        (battlerId & 1) !== (i & 1) &&
        hasFlag(opp.statuses3, STATUS3_ALWAYS_HITS) &&
        opp.volatiles.battlerWithSureHit === battlerId
      ) {
        opp.statuses3 = clearFlag(opp.statuses3, STATUS3_ALWAYS_HITS) | STATUS3_ALWAYS_HITS_TURN(2)
      }
    }
  }

  if (options?.healingWish) {
    const incomingSlot = party[partyIndex]
    if (incomingSlot) {
      incomingSlot.hp = incomingSlot.maxHp
      incomingSlot.status1 = 0
      if (options.lunarDance) {
        // VARIOUS_RESTORE_PP (battle_scripts_1.s:2396, battle_script_commands.c:7116-7129)
        for (let mIdx = 0; mIdx < incomingSlot.moves.length; mIdx++) {
          const mId = incomingSlot.moves[mIdx]
          if (mId) {
            const mData = deps.dataContext.move(mId)
            if (mData?.pp !== undefined) {
              incomingSlot.pp[mIdx] = mData.pp
            }
          }
        }
      }
    }
  }

  switchIn(state, battlerId, partyIndex, deps, unmodelled, (newBattler) => {
    if (options?.batonPass) {
      if (savedStatStages) newBattler.mon.statStages = [...savedStatStages]
      if (savedStatus2 !== null) newBattler.mon.status2 = savedStatus2
      if (savedStatuses3 !== null) newBattler.statuses3 = savedStatuses3
      if (savedStatuses4 !== null) newBattler.statuses4 = savedStatuses4
      if (savedVolatiles) {
        newBattler.volatiles.started = { ...savedVolatiles.started }
        newBattler.volatiles.substituteHp = savedVolatiles.substituteHp
        newBattler.volatiles.battlerWithSureHit = savedVolatiles.battlerWithSureHit
        newBattler.volatiles.perishSongTimer = savedVolatiles.perishSongTimer
        newBattler.volatiles.perishSongTimerStartValue = savedVolatiles.perishSongTimerStartValue
        newBattler.volatiles.battlerPreventingEscape = savedVolatiles.battlerPreventingEscape
        newBattler.volatiles.critBoost = savedVolatiles.critBoost
        newBattler.volatiles.parasiticSpores = savedVolatiles.parasiticSpores
        newBattler.volatiles.dazed = savedVolatiles.dazed
        newBattler.volatiles.trepidation = savedVolatiles.trepidation
        newBattler.volatiles.drenched = savedVolatiles.drenched
      }
      // Power trick swap (battle_main.c:2833)
      if (savedStatuses3 !== null && hasFlag(savedStatuses3, STATUS3_POWER_TRICK)) {
        newBattler.mon.rawStats = { ...newBattler.mon.rawStats }
        const atk = newBattler.mon.rawStats.atk
        newBattler.mon.rawStats.atk = newBattler.mon.rawStats.def
        newBattler.mon.rawStats.def = atk
      }
    } else if (options?.shedTail) {
      if (savedStatus2 !== null) newBattler.mon.status2 = savedStatus2
      newBattler.volatiles.substituteHp = savedSubstituteHp
    }
  })
  return unmodelled
}

/** The TurnOrderMoveView of `moveId`, built from its move data over `base` (whose
 * battler-dependent fields are kept, as chooseAiAction's buildMoveView leaves them). */
function moveViewFor(base: TurnOrderMoveView, moveId: string, dataContext: SimDataContext): TurnOrderMoveView {
  const move = dataContext.move(moveId)
  return {
    ...base,
    id: moveId,
    priority: move?.priority ?? 0,
    effect: move?.effect ?? null,
    isStatus: move?.split === 'STATUS',
    resolvedType: move?.type ?? 'MYSTERY',
    power: move?.power ?? 0,
    flags: move?.flags ?? {},
    split: move?.split ?? 'STATUS',
  }
}

/**
 * Encore. Selection (battle_main.c:3689-3691) replaces an encored battler's chosen move with
 * encoredMove before turn order is computed; HandleAction_UseMove (battle_util.c:221-236) keeps
 * it, or -- when the slot no longer holds the encored move -- uses that slot's move and ends the
 * encore. The sim keeps the caller's target rather than re-running GetMoveTarget.
 */
function applyEncore(state: BattleState, battlerId: number, action: ChosenAction | null, deps: TurnLoopDeps): ChosenAction | null {
  const battler = state.battlers[battlerId]
  if (!action || action.action !== 'USE_MOVE' || !action.chosenMove || !battler?.volatiles.encoredMove) return action
  const v = battler.volatiles
  const slotMove = battler.mon.moves[v.encoredMovePos]
  if (slotMove !== v.encoredMove) {
    v.encoredMove = null
    v.encoredMovePos = 0
    v.encoreTimer = 0
  }
  if (!slotMove || slotMove === action.chosenMove.id) return action
  const view = moveViewFor(action.chosenMove, slotMove, deps.dataContext)
  return { ...action, chosenMove: view, moveToBeUsed: view }
}

export function executeAction(
  state: BattleState,
  battlerId: number,
  action: ChosenAction | null,
  actionKind: 'USE_MOVE' | 'USE_ITEM' | 'SWITCH',
  index: number,
  order: TurnOrder,
  deps: TurnLoopDeps,
): ActionOutcome {
  // HandleAction_UseMove:181-186 -- a battler that fainted earlier this turn
  // does not act. Its slot is still consumed; the action is simply finished.
  const blank: ActionOutcome = {
    turnOrderIndex: index,
    battlerId,
    action: actionKind,
    skippedBecauseFainted: false,
    battleOver: false,
    missed: false,
    targetId: null,
    targetDamage: null,
    attackerDamage: null,
    cancelledBy: null,
    confusionSelfHitDamage: null,
    statChanges: null,
    statusApplied: null,
    unmodelled: [],
    fainted: [],
  }

  // RunTurnActionsFunctions, battle_main.c:4654 -- `if (gBattleOutcome != 0)
  // gCurrentActionFuncId = B_ACTION_FINISHED;`, checked BEFORE the action
  // handler for this slot ever runs (so it takes priority over the
  // liveness check right below: a battler that is still alive but whose
  // opponent has no mons left does not act either). This batch's own
  // extension of the C's timing -- see outcome.ts's header and this
  // module's own header on "after each action's faints" -- means
  // state.battleOutcome can already be set here even in a case the literal
  // C would not have decided until later (checkteamslost is not called
  // after an ordinary move's tryfaintmon in the real game); that is a
  // deliberate simplification this batch's brief asks for, not an
  // oversight.
  if (state.battleOutcome) {
    return { ...blank, skippedBecauseFainted: false, battleOver: true }
  }

  // HandleAction_UseMove:181-186, battle_util.c:182-183 -- alive check has an exception
  // for extra attack explosions queued by abilities
  if (!isBattlerAlive(state, battlerId)) {
    const isExplosion =
      state.processingExtraAttacks &&
      Boolean(state.currentExtraAttack?.ability) &&
      deps.dataContext.move(action?.chosenMove?.id ?? '')?.effect === 'EFFECT_EXPLOSION'
    if (!isExplosion) {
      return { ...blank, skippedBecauseFainted: true, battleOver: false }
    }
  }

  // HandleAction_Switch, battle_util.c:378 -- runs in this slot, before any
  // USE_MOVE slot (SWITCH actions are grouped first by
  // setActionsAndBattlersTurnOrder; see performSwitchAction's own header).
  if (actionKind === 'SWITCH') {
    const switchUnmodelled = performSwitchAction(state, battlerId, deps)
    return { ...blank, skippedBecauseFainted: false, battleOver: false, unmodelled: switchUnmodelled }
  }

  if (actionKind !== 'USE_MOVE' || !action || action.chosenMove === null) {
    return { ...blank, skippedBecauseFainted: false, battleOver: false }
  }

  const attackerBattler = state.battlers[battlerId]!
  let targetId = action.target
  const unmodelled: string[] = []

  // battle_util.c:205-207, data/battle_scripts_1.s:4776: PP is not deducted for extra attacks
  // without movePos (Metronome) or under sleepTalk (Sleep Talk), or when noPpDeduct is set.
  const shouldDeductPp =
    !state.processingExtraAttacks ||
    (Boolean(state.currentExtraAttack?.movePos) &&
      !state.battlers[battlerId]?.turn.sleepTalk &&
      !state.currentExtraAttack?.noPpDeduct)

  // Cmd_ppreduce (battle_script_commands.c:1460-1500) has no "already deducted" state: only
  // HITMARKER_NO_PPDEDUCT skips it, once. A script that reaches ppreduce twice (Gastro Acid's
  // failure into BattleScript_EffectPoison, Assist's ppreduce before jumptocalledmove) deducts twice.
  const performPpDeduct = () => {
    if (shouldDeductPp && action.chosenMove) {
      deductPp(state, battlerId, action.chosenMove.id, action.chosenMove.effect, unmodelled)
    }
  }

  // Target selection: IsAffectedByFollowMe (src/battle_util.c:118-126, 263-265, 6365-6366, 6395-6396)
  const initialMoveData = deps.dataContext.move(action.chosenMove.id)
  const defSide = (battlerId & 1) ^ 1
  const isSingleTargetMove = initialMoveData?.target === 'SELECTED' || initialMoveData?.target === 'RANDOM'
  if (
    isSingleTargetMove &&
    isAffectedByFollowMe(state, battlerId, defSide, action.chosenMove.id, deps) &&
    (battlerId & 1) !== (state.sides[defSide].timers.followmeTarget & 1)
  ) {
    targetId = state.sides[defSide].timers.followmeTarget
  }

  // Torment move restriction (battle_util.c:1443-1452, 1641-1642).
  // In C, Torment prevents selecting lastMove during move selection; when
  // evaluated directly at action execution, gap the unmodelled restriction.
  if (
    hasFlag(attackerBattler.mon.status2, STATUS2_TORMENT) &&
    action.chosenMove.id === attackerBattler.lastMove &&
    attackerBattler.lastMove !== 'MOVE_STRUGGLE'
  ) {
    unmodelled.push(
      `battler ${battlerId}: Torment move restriction (battle_util.c:1443-1452) is not enforced at selection time`,
    )
  }

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
  const cancelResult = runAttackCanceller(state, battlerId, targetId, action.chosenMove.id, deps.dataContext.move(action.chosenMove.id), unmodelled, attackerHoldEffect, deps.grounding, action.chosenMove)
  if (cancelResult.cancelledBy) {
    return {
      turnOrderIndex: index,
      battlerId,
      action: actionKind,
      skippedBecauseFainted: false,
      battleOver: false,
      missed: false,
      targetId,
      targetDamage: null,
      attackerDamage: null,
      cancelledBy: cancelResult.cancelledBy,
      confusionSelfHitDamage: cancelResult.confusionSelfHitDamage,
      statChanges: null,
      statusApplied: null,
      unmodelled,
      fainted: [],
    }
  }

  const runMovePipeline = (
    currentMove: TurnOrderMoveView,
    chosenMove: TurnOrderMoveView,
    currentTargetId: number | null,
    _isCalledJump: boolean,
  ): ActionOutcome => {
    let currentChosenMoveId = chosenMove.id
    const moveData = deps.dataContext.move(currentMove.id)
    const moveFlags = moveData?.flags

    // Cmd_attackcanceler: Magic Coat bounce, src/battle_script_commands.c:1153-1173,
    // and BattleScript_MagicCoatBounce / BattleScript_MagicCoatBouncePrankster (data/battle_scripts_1.s:8325-8344)
    if (moveFlags?.magicCoatAffected && !state.battlers[battlerId]?.round.usesBouncedMove) {
      const isBouncedByCoat = currentTargetId !== null && Boolean(state.battlers[currentTargetId]?.round.bounceMove)
      const isBouncedByAbility =
        currentTargetId !== null &&
        battlerHasSimAbility(
          state,
          state.battlers[currentTargetId]!,
          'ABILITY_MAGIC_BOUNCE',
          true,
          battlerId,
          attackerHasMoldBreakerActive(attackerBattler, deps),
          deps.dataContext,
        )

      if (isBouncedByCoat || isBouncedByAbility) {
        if (isBouncedByCoat) {
          state.battlers[currentTargetId!]!.round.bounceMove = false
        }
        state.battlers[currentTargetId!]!.round.usesBouncedMove = true
        performPpDeduct()

        if (isBouncedByCoat && blocksPrankster(state, currentMove.id, currentTargetId!, battlerId, true, deps)) {
          // BattleScript_MagicCoatBouncePrankster (:8335-8344)
          runMoveEndBookkeeping({
            state,
            attackerId: battlerId,
            targetId: currentTargetId,
            currentMoveId: currentMove.id,
            chosenMoveId: currentChosenMoveId,
            deps,
            noEffect: true,
            obeys: true,
            fainted: [],
          })
          return {
            turnOrderIndex: index,
            battlerId,
            action: actionKind,
            skippedBecauseFainted: false,
            battleOver: false,
            missed: true,
            targetId: battlerId,
            targetDamage: null,
            attackerDamage: null,
            cancelledBy: null,
            confusionSelfHitDamage: null,
            statChanges: null,
            statusApplied: null,
            unmodelled,
            fainted: [],
          }
        }

        // setmagiccoattarget BS_ATTACKER (VARIOUS_SET_MAGIC_COAT_TARGET, battle_script_commands.c:6933-6940)
        const bounceAttackerId = currentTargetId!
        const bounceDefSide = (bounceAttackerId & 1) ^ 1
        const bounceTargetId = isAffectedByFollowMe(state, bounceAttackerId, bounceDefSide, currentMove.id, deps)
          ? state.sides[bounceDefSide].timers.followmeTarget
          : battlerId

        const bouncedMoveEffect = currentMove.effect ?? moveData?.effect ?? null
        const bouncedHandler = getMoveEffectHandler(bouncedMoveEffect)
        if (bouncedHandler) {
          let bouncedChosenMoveId = chosenMove.id
          const effectOutcome = bouncedHandler({
            state,
            battlerId: bounceAttackerId,
            targetId: bounceTargetId,
            action: { action: 'USE_MOVE', chosenMove: currentMove, moveToBeUsed: currentMove, target: bounceTargetId },
            turnOrderIndex: index,
            order,
            deps,
            unmodelled,
            deductPp: () => {}, // PP already deducted with HITMARKER_NO_PPDEDUCT (:8331)
            applyDamage,
            setChosenMove: (mId: string) => {
              bouncedChosenMoveId = mId
            },
          })
          if (effectOutcome.chosenMoveId !== undefined) {
            bouncedChosenMoveId = effectOutcome.chosenMoveId
          }
          const reactiveStatChanges: StatChangeOutcome[] = []
          runReactiveAbilityEffects(state, deps, unmodelled, reactiveStatChanges, order.battlerByTurnOrder)
          if (reactiveStatChanges.length > 0) {
            effectOutcome.statChanges = [...(effectOutcome.statChanges ?? []), ...reactiveStatChanges]
          }
          runMoveEndBookkeeping({
            state,
            attackerId: bounceAttackerId,
            targetId: bounceTargetId,
            currentMoveId: currentMove.id,
            chosenMoveId: bouncedChosenMoveId,
            deps,
            noEffect: Boolean(effectOutcome.missed),
            moveFailed: Boolean(effectOutcome.missed),
            obeys: true,
            fainted: effectOutcome.fainted ?? [],
          })
          return { ...effectOutcome, turnOrderIndex: index, battlerId }
        } else {
          unmodelled.push(
            `BattleScript_MagicCoatBounce: unhandled move effect ${bouncedMoveEffect} for bounced move ${currentMove.id} is not modelled`,
          )
          return {
            turnOrderIndex: index,
            battlerId,
            action: actionKind,
            skippedBecauseFainted: false,
            battleOver: false,
            missed: false,
            targetId: bounceTargetId,
            targetDamage: null,
            attackerDamage: null,
            cancelledBy: null,
            confusionSelfHitDamage: null,
            statChanges: null,
            statusApplied: null,
            unmodelled,
            fainted: [],
          }
        }
      }
    }

    // Cmd_attackcanceler: Snatch consumer, src/battle_script_commands.c:1175-1182,
    // and BattleScript_SnatchedMove (data/battle_scripts_1.s:8346-8355)
    let snatcherId: number | null = null
    for (const bId of order.battlerByTurnOrder) {
      if (state.battlers[bId]?.round.stealMove) {
        snatcherId = bId
        break
      }
    }
    if (snatcherId !== null && moveFlags?.snatchAffected) {
      state.battlers[snatcherId]!.round.stealMove = false
      performPpDeduct()

      // Cmd_snatchsetbattlers (:12372-12382) + swapattackerwithtarget (:5850-5853):
      // If attacker == target (or self-targeting move), target becomes snatcher
      const isSelfTargeting = currentTargetId === battlerId || moveData?.target === 'USER' || moveData?.target === 'USER_OR_ALLY'
      const snatchedTargetId = isSelfTargeting ? snatcherId : battlerId

      const snatchedMoveEffect = currentMove.effect ?? moveData?.effect ?? null
      const snatchedHandler = getMoveEffectHandler(snatchedMoveEffect)
      if (snatchedHandler) {
        let snatchedChosenMoveId = chosenMove.id
        const effectOutcome = snatchedHandler({
          state,
          battlerId: snatcherId,
          targetId: snatchedTargetId,
          action: { action: 'USE_MOVE', chosenMove: currentMove, moveToBeUsed: currentMove, target: snatchedTargetId },
          turnOrderIndex: index,
          order,
          deps,
          unmodelled,
          deductPp: () => {}, // PP already deducted with HITMARKER_NO_PPDEDUCT (:8353)
          applyDamage,
          setChosenMove: (mId: string) => {
            snatchedChosenMoveId = mId
          },
        })
        if (effectOutcome.chosenMoveId !== undefined) {
          snatchedChosenMoveId = effectOutcome.chosenMoveId
        }
        const reactiveStatChanges: StatChangeOutcome[] = []
        runReactiveAbilityEffects(state, deps, unmodelled, reactiveStatChanges, order.battlerByTurnOrder)
        if (reactiveStatChanges.length > 0) {
          effectOutcome.statChanges = [...(effectOutcome.statChanges ?? []), ...reactiveStatChanges]
        }
        runMoveEndBookkeeping({
          state,
          attackerId: snatcherId,
          targetId: snatchedTargetId,
          currentMoveId: currentMove.id,
          chosenMoveId: snatchedChosenMoveId,
          deps,
          noEffect: Boolean(effectOutcome.missed),
            moveFailed: Boolean(effectOutcome.missed),
          obeys: true,
          fainted: effectOutcome.fainted ?? [],
        })
        return { ...effectOutcome, turnOrderIndex: index, battlerId }
      } else {
        unmodelled.push(
          `BattleScript_SnatchedMove: unhandled move effect ${snatchedMoveEffect} for snatched move ${currentMove.id} is not modelled`,
        )
        return {
          turnOrderIndex: index,
          battlerId,
          action: actionKind,
          skippedBecauseFainted: false,
          battleOver: false,
          missed: false,
          targetId: snatchedTargetId,
          targetDamage: null,
          attackerDamage: null,
          cancelledBy: null,
          confusionSelfHitDamage: null,
          statChanges: null,
          statusApplied: null,
          unmodelled,
          fainted: [],
        }
      }
    }

    // Move effect dispatch runs between attackcanceler and the accuracy/damage path.
    // Handled status moves (Swords Dance, Belly Drum, etc.) do not draw accuracy in
    // C battle scripts; their script runs ppreduce and applies their effects directly.
    const moveEffect = currentMove.effect ?? moveData?.effect ?? null
    const handler = getMoveEffectHandler(moveEffect)
    if (handler) {
      let jumpedOutcome: ActionOutcome | null = null
      const effectOutcome = handler({
        state,
        battlerId,
        targetId: currentTargetId,
        action: {
          action: 'USE_MOVE',
          chosenMove,
          moveToBeUsed: currentMove,
          target: currentTargetId,
        },
        turnOrderIndex: index,
        order,
        deps,
        unmodelled,
        deductPp: performPpDeduct,
        applyDamage,
        setChosenMove: (mId: string) => {
          currentChosenMoveId = mId
        },
        jumpToCalledMove: (calledMoveId: string, keepChosenMove: boolean = true, overrideTargetId?: number | null): ActionOutcome => {
          const nextChosenMove = keepChosenMove ? chosenMove : buildMoveView(calledMoveId, deps.dataContext)
          const nextCurrentMove = buildMoveView(calledMoveId, deps.dataContext)
          const nextTargetId = overrideTargetId !== undefined && overrideTargetId !== null
            ? overrideTargetId
            : getMoveTarget(state, battlerId, calledMoveId, deps)
          jumpedOutcome = runMovePipeline(nextCurrentMove, nextChosenMove, nextTargetId, true)
          return jumpedOutcome
        },
      })

      if (jumpedOutcome) {
        return jumpedOutcome
      }

      if (effectOutcome.jumpToCalledMove) {
        const { moveId: calledMoveId, keepChosenMove = true, targetId: overrideTargetId } = effectOutcome.jumpToCalledMove
        const nextChosenMove = keepChosenMove ? chosenMove : buildMoveView(calledMoveId, deps.dataContext)
        const nextCurrentMove = buildMoveView(calledMoveId, deps.dataContext)
        const nextTargetId = overrideTargetId !== undefined && overrideTargetId !== null
          ? overrideTargetId
          : getMoveTarget(state, battlerId, calledMoveId, deps)
        return runMovePipeline(nextCurrentMove, nextChosenMove, nextTargetId, true)
      }

      if (effectOutcome.chosenMoveId !== undefined) {
        currentChosenMoveId = effectOutcome.chosenMoveId
      }

      if (currentTargetId !== null && state.battlers[battlerId]?.round.touchedProtectLike) {
        const protectMoveEnd = handleProtectLikeMoveEnd(state, battlerId, currentTargetId, currentMove.id, deps, unmodelled)
        if (protectMoveEnd.statChanges) {
          effectOutcome.statChanges = [...(effectOutcome.statChanges ?? []), ...protectMoveEnd.statChanges]
        }
        if (protectMoveEnd.statusApplied) {
          effectOutcome.statusApplied = protectMoveEnd.statusApplied
        }
      }
      // Nearest sim point for handled status moves (Swords Dance, etc.) to trigger
      // ABILITYEFFECT_REACTIVE (Cmd_moveend, src/battle_script_commands.c:4330).
      const reactiveStatChanges: StatChangeOutcome[] = []
      runReactiveAbilityEffects(state, deps, unmodelled, reactiveStatChanges, order.battlerByTurnOrder)
      if (reactiveStatChanges.length > 0) {
        effectOutcome.statChanges = [...(effectOutcome.statChanges ?? []), ...reactiveStatChanges]
      }
      runMoveEndBookkeeping({
        state,
        attackerId: battlerId,
        targetId: currentTargetId,
        currentMoveId: currentMove.id,
        chosenMoveId: currentChosenMoveId,
        deps,
        noEffect: Boolean(effectOutcome.missed),
            moveFailed: Boolean(effectOutcome.missed),
        obeys: true,
        fainted: effectOutcome.fainted ?? [],
      })
      return effectOutcome
    }

    // Two-turn semi-invulnerable moves (Fly, Bounce, Dig, Dive, Phantom Force, etc.)
    // BattleScript_EffectSemiInvulnerable (data/battle_scripts_1.s:5848-5895)
    let isSecondTurnSemiInvuln = false
    if (moveEffect === 'EFFECT_SEMI_INVULNERABLE') {
      const attackerBattler = state.battlers[battlerId]!
      if (!hasFlag(attackerBattler.mon.status2, STATUS2_MULTIPLETURNS)) {
        // BattleScriptFirstChargingTurn (data/battle_scripts_1.s:4079-4093) + BattleScript_FirstTurnSemiInvulnerable (:5876-5879)
        performPpDeduct()
        attackerBattler.mon.status2 = setFlag(attackerBattler.mon.status2, STATUS2_MULTIPLETURNS)
        attackerBattler.round.chargingTurn = true

        // Cmd_setsemiinvulnerablebit (src/battle_script_commands.c:11541-11566)
        setSemiInvulnerableBit(attackerBattler, currentMove.id)

        // twoturnmoveacceleratecheck (:5879)
        const hasAccelerate = battlerHasSimAbility(
          state,
          attackerBattler,
          'ABILITY_ACCELERATE',
          false,
          battlerId,
          false,
          deps.dataContext,
        )
        let accelerated = hasAccelerate
        if (!accelerated) {
          const itemId = attackerBattler.mon.itemId
          const itemNegated =
            hasFlag(attackerBattler.statuses3, STATUS3_EMBARGO) ||
            battlerHasSimAbility(state, attackerBattler, 'ABILITY_KLUTZ', false, battlerId, false, deps.dataContext)
          if (!itemNegated && itemId === 'ITEM_ENIGMA_BERRY') {
            unmodelled.push('Enigma Berry holdEffect (battle_util.c:6533-6534) is not modelled')
          }
          const holdEffect = !itemNegated && itemId ? (deps.dataContext.item(itemId)?.resolvedHoldEffect ?? null) : null
          if (holdEffect === 'HOLD_EFFECT_POWER_HERB' && !isUnnerveAbilityOnOpposingSide(state, battlerId, deps.dataContext)) {
            consumeHeldItem(state, attackerBattler, unmodelled)
            accelerated = true
          }
        }

        if (!accelerated) {
          runMoveEndBookkeeping({
            state,
            attackerId: battlerId,
            targetId: currentTargetId,
            currentMoveId: currentMove.id,
            chosenMoveId: currentChosenMoveId,
            deps,
            noEffect: false,
            obeys: true,
            fainted: [],
          })
          return {
            turnOrderIndex: index,
            battlerId,
            action: actionKind,
            skippedBecauseFainted: false,
            battleOver: false,
            missed: false,
            targetId: currentTargetId,
            targetDamage: null,
            attackerDamage: null,
            cancelledBy: null,
            confusionSelfHitDamage: null,
            statChanges: null,
            statusApplied: null,
            unmodelled,
            fainted: [],
          }
        }
      }

      // Turn 2 (or accelerated Turn 1): BattleScript_SecondTurnSemiInvulnerable (data/battle_scripts_1.s:5880-5895)
      // clearstatusfromeffect BS_ATTACKER (:5884)
      attackerBattler.mon.status2 = clearFlag(attackerBattler.mon.status2, STATUS2_MULTIPLETURNS)
      if (battlerHasSimAbility(state, attackerBattler, 'ABILITY_ACCELERATE', false, battlerId, false, deps.dataContext)) {
        attackerBattler.round.chargingTurn = false
      }
      isSecondTurnSemiInvuln = true
    }

    if (currentTargetId === null || !isBattlerAlive(state, currentTargetId)) {
      if (isSecondTurnSemiInvuln) {
        state.battlers[battlerId]!.statuses3 = clearFlag(state.battlers[battlerId]!.statuses3, STATUS3_SEMI_INVULNERABLE)
      }
      // No living target: the move resolves to nothing here. The real game runs
      // a fail branch with messages and effect-specific behaviour; this batch
      // models only that no damage is dealt.
      return { ...blank, skippedBecauseFainted: false, battleOver: false, targetId: currentTargetId, unmodelled }
    }

    const targetIndex = order.battlerByTurnOrder.indexOf(currentTargetId)
    const targetHasActedThisTurn = targetIndex >= 0 && targetIndex < index

    const isContact = moveData?.flags?.contact === true

    // Check Protect before accuracy check (battle_util.c:6571-6645, battle_script_commands.c:1198-1210, 1422)
    const protectType = isBattlerProtected(state, battlerId, currentTargetId, currentMove.id, targetHasActedThisTurn, deps, unmodelled)
    if (protectType !== ProtectType.PROTECT_NONE) {
      if (protectType === ProtectType.PROTECT_BLOCK_ALWAYS_TOUCH || isContact) {
        state.battlers[battlerId]!.round.touchedProtectLike = true
      }
    }
    if ((protectType & ProtectType.PROTECT_BLOCK) !== 0) {
      cancelMultiTurnMoves(state.battlers[battlerId]!)
      if (!isSecondTurnSemiInvuln) {
        performPpDeduct()
      }
      const protectMoveEnd = handleProtectLikeMoveEnd(state, battlerId, currentTargetId, currentMove.id, deps, unmodelled)
      runMoveEndBookkeeping({
        state,
        attackerId: battlerId,
        targetId: currentTargetId,
        currentMoveId: currentMove.id,
        chosenMoveId: currentChosenMoveId,
        deps,
        noEffect: true,
        obeys: true,
        fainted: [],
      })
      return {
        turnOrderIndex: index,
        battlerId,
        action: actionKind,
        skippedBecauseFainted: false,
        battleOver: false,
        missed: true,
        targetId: currentTargetId,
        targetDamage: null,
        attackerDamage: null,
        cancelledBy: null,
        confusionSelfHitDamage: null,
        statChanges: protectMoveEnd.statChanges,
        statusApplied: protectMoveEnd.statusApplied,
        unmodelled,
        fainted: [],
      }
    }

    // Cmd_accuracycheck, battle_script_commands.c:1398-1447. Drawn from
    // state.rng BEFORE the damage resolver's own crit/roll draws, matching
    // BattleScript_EffectHit (battle_scripts_1.s:2857-2863): accuracycheck,
    // then attackstring/ppreduce, then critcalc/damagecalc inside
    // deps.damage.resolve below.
    const { inputs: accInputs, gaps: accGaps, defenderHasAnticipation } = buildAccuracyInputs(state, battlerId, currentTargetId, currentMove.id, targetHasActedThisTurn, deps)
    unmodelled.push(...gapsToUnmodelled(accGaps))
    if (defenderHasAnticipation) {
      unmodelled.push(
        "Cmd_accuracycheck's own Anticipation miss branch (battle_script_commands.c:1427-1432) is not modelled: GetSingleUseAbilityCounter has no state anywhere in this codebase, and the type-effectiveness multiplier it needs is not known until the damage resolver runs afterwards",
      )
    }
    const accResult = getTotalAccuracy(accInputs)
    unmodelled.push(...gapsToUnmodelled(accResult.gaps))
    // battle_script_commands.c:1383-1384
    if (state.battlers[battlerId]?.round.usedMicleBerry) {
      state.battlers[battlerId]!.round.usedMicleBerry = false
    }
    // :1433 -- `(Random() % 100) >= accuracy` is a MISS. 101 (\"cannot miss\")
    // is not special-cased: Random() % 100 is at most 99, so the comparison
    // can never be true, and the arithmetic alone carries the sentinel.
    const missed = state.rng.random16() % 100 >= accResult.accuracy

    // Cmd_clearsemiinvulnerablebit (src/battle_script_commands.c:11568-11571)
    // Cleared on both hit and miss paths: BattleScript_SemiInvulnerableTryHit (:5889) and BattleScript_SemiInvulnerableMiss (:5893).
    if (isSecondTurnSemiInvuln) {
      state.battlers[battlerId]!.statuses3 = clearFlag(state.battlers[battlerId]!.statuses3, STATUS3_SEMI_INVULNERABLE)
    }

    // Cmd_ppreduce, :1460-1506 -- after the accuracy check, on both paths:
    // the miss branch BattleScript_PrintMoveMissed (battle_scripts_1.s:3092-
    // 3094) runs ppreduce too, so a miss still costs PP.
    // HITMARKER_NO_PPDEDUCT on turn 2 skips second deduction.
    if (!isSecondTurnSemiInvuln) {
      performPpDeduct()
    }

    if (missed) {
      const protectMoveEnd = handleProtectLikeMoveEnd(state, battlerId, currentTargetId, currentMove.id, deps, unmodelled)
      runMoveEndBookkeeping({
        state,
        attackerId: battlerId,
        targetId: currentTargetId,
        currentMoveId: currentMove.id,
        chosenMoveId: currentChosenMoveId,
        deps,
        noEffect: true,
        obeys: true,
        fainted: [],
      })
      return {
        turnOrderIndex: index,
        battlerId,
        action: actionKind,
        skippedBecauseFainted: false,
        battleOver: false,
        missed: true,
        targetId: currentTargetId,
        targetDamage: null,
        attackerDamage: null,
        cancelledBy: null,
        confusionSelfHitDamage: null,
        statChanges: protectMoveEnd.statChanges,
        statusApplied: protectMoveEnd.statusApplied,
        unmodelled,
        fainted: [],
      }
    }

    const currentMoveAction: ChosenAction = {
      action: 'USE_MOVE',
      chosenMove: currentMove,
      moveToBeUsed: currentMove,
      target: currentTargetId,
    }

    if (attackerBattler.round.usedCustapBerry && deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_CUSTAP_BERRY') {
      // BattleScript_CustapBerryActivation (battle_main.c:4616-4618): removeitem BS_ATTACKER
      attackerBattler.mon.itemId = null
    }

    let { targetDamage, attackerDamage, unmodelled: damageUnmodelled, absorbingAbility, isCriticalHit, berryReduced, isSuperEffective } = deps.damage.resolve(state, battlerId, currentTargetId, currentMoveAction, { targetHasActedThisTurn })

    if (absorbingAbility) {
      const absorbOutcome = applyAbsorbEffect({
        state,
        attackerId: battlerId,
        targetId: currentTargetId,
        absorbingAbility,
        moveId: currentMove.id,
        deps,
        unmodelled,
      })

      // In C: JumpIfMoveFailed jumps to BattleScript_AfterAbsorbEffect (battle_script_commands.c:1221),
      // which sets MOVE_RESULT_DOESNT_AFFECT_FOE and jumps to BattleScript_MoveEnd (battle_scripts_1.s:10038-10042).
      // Damage calculation and secondary effects (seteffectwithchance) are skipped entirely.
      const moveEndOutcome = runMoveEnd({
        state,
        attackerId: battlerId,
        targetId: currentTargetId,
        moveId: currentMove.id,
        chosenMoveId: currentChosenMoveId,
        targetDamage: 0,
        hpDealt: 0,
        noEffect: true,
        moveEffect2: null,
        deps,
        unmodelled,
        fainted: [],
      })

      const finalStatChanges: StatChangeOutcome[] = []
      if (absorbOutcome.statChanges.length > 0) finalStatChanges.push(...absorbOutcome.statChanges)
      if (moveEndOutcome.statChanges) finalStatChanges.push(...moveEndOutcome.statChanges)

      return {
        turnOrderIndex: index,
        battlerId,
        action: actionKind,
        skippedBecauseFainted: false,
        battleOver: false,
        missed: false,
        targetId: currentTargetId,
        targetDamage: 0,
        attackerDamage: moveEndOutcome.attackerDamage,
        cancelledBy: null,
        confusionSelfHitDamage: null,
        statChanges: finalStatChanges.length > 0 ? finalStatChanges : null,
        statusApplied: moveEndOutcome.statusApplied,
        unmodelled: [...unmodelled, ...damageUnmodelled],
        fainted: [],
      }
    }

    // Cmd_adjustdamage (battle_script_commands.c:1626-1676) -- Endure / falseSwipe / Focus Sash stops HP at 1 (:1645-1673)
    const targetBattler = state.battlers[currentTargetId]
    const isFalseSwipe = Boolean(state.processingExtraAttacks && state.currentExtraAttack?.falseSwipe)
    const targetHoldEffect = deps.grounding.holdEffectOf(currentTargetId)
    const hasFocusSash =
      targetHoldEffect === 'HOLD_EFFECT_FOCUS_SASH' &&
      !isUnnerveAbilityOnOpposingSide(state, currentTargetId, deps.dataContext) &&
      targetBattler &&
      targetBattler.mon.hp === targetBattler.mon.maxHp
    if (
      targetDamage !== null &&
      targetBattler &&
      targetBattler.mon.hp > 0 &&
      (targetBattler.round.endured || isFalseSwipe || hasFocusSash) &&
      targetDamage >= targetBattler.mon.hp
    ) {
      targetDamage = Math.max(0, targetBattler.mon.hp - 1)
      if (hasFocusSash && !targetBattler.round.endured && !isFalseSwipe) {
        // BattleScript_HangedOnMsg (data/battle_scripts_1.s:10962-10963): removeitem BS_TARGET
        targetBattler.mon.itemId = null
      }
    }

    // Check damage reducing berries (battle_script_commands.c:1693-1697)
    if (berryReduced && targetBattler) {
      targetBattler.turn.berryReduced = true
    }
    if (targetBattler?.turn.berryReduced && targetDamage !== null && targetDamage > 0 && targetBattler.mon.itemId) {
      // BattleScript_TargetAteItem (data/battle_scripts_1.s:10786-10793): removeitem BS_TARGET
      targetBattler.mon.itemId = null
    }

    const fainted: number[] = []
    const targetHpBefore = targetBattler?.mon.hp ?? 0
    applyDamage(state, currentTargetId, targetDamage, fainted)
    const hpDealt = targetHpBefore - (targetBattler?.mon.hp ?? 0)

    // Cmd_datahpupdate damage tracking (src/battle_script_commands.c:1935-1959)
    if (targetBattler && hpDealt > 0) {
      const isPhysical = (currentMove.split ?? moveData?.split) === 'PHYSICAL'
      if (isPhysical && currentMove.id !== 'MOVE_PAIN_SPLIT') {
        targetBattler.round.physicalDmg = hpDealt
        targetBattler.turn.physicalDmg = hpDealt
        targetBattler.round.physicalBattlerId = battlerId
        targetBattler.turn.physicalBattlerId = battlerId
      } else if (!isPhysical) {
        targetBattler.round.specialDmg = hpDealt
        targetBattler.turn.specialDmg = hpDealt
        targetBattler.round.specialBattlerId = battlerId
        targetBattler.turn.specialBattlerId = battlerId
      }
      targetBattler.round.damaged = true
    }

    // Grudge faint trigger (Cmd_tryfaintmon: battle_script_commands.c:3252-3263)
    if (
      fainted.includes(currentTargetId) &&
      targetBattler &&
      hasFlag(targetBattler.statuses3, STATUS3_GRUDGE) &&
      (battlerId & 1) !== (currentTargetId & 1) &&
      attackerBattler.mon.hp > 0 &&
      currentMove.id !== 'MOVE_STRUGGLE'
    ) {
      // The C zeroes gBattleStruct->chosenMovePositions[attacker]; the sim has no chosen slot, so
      // it finds the slot by move id, which a called move (Metronome etc.) does not have.
      const moveIdx = attackerBattler.mon.moves.indexOf(currentMove.id)
      if (moveIdx !== -1) {
        attackerBattler.mon.pp[moveIdx] = 0
      } else {
        unmodelled.push(
          `battler ${battlerId}: Grudge's PP wipe (battle_script_commands.c:3252-3263) is not applied -- ${currentMove.id} is not in the chosen-move slot lookup`,
        )
      }
      // Not part of tryfaintmon: ClearFuryCutterDestinyBondGrudge (battle_util.c:6307-6311) on faint.
      targetBattler.statuses3 = clearFlag(targetBattler.statuses3, STATUS3_GRUDGE)
    }

    applyDamage(state, battlerId, attackerDamage, fainted)

    // Secondary move effects (BattleScript_EffectHit, seteffectwithchance).
    const secondaryResult = applySecondaryMoveEffects({
      state,
      attackerId: battlerId,
      targetId: currentTargetId,
      moveId: currentMove.id,
      targetDamage,
      deps: {
        dataContext: deps.dataContext,
        grounding: deps.grounding,
        moveBehaviors: deps.moveBehaviors,
      },
      unmodelled,
    })

    // Cmd_moveend state machine ladder (battle_script_commands.c:4309-4968).
    const moveEndOutcome = runMoveEnd({
      state,
      attackerId: battlerId,
      targetId: currentTargetId,
      moveId: currentMove.id,
      chosenMoveId: currentChosenMoveId,
      targetDamage: targetDamage ?? 0,
      hpDealt,
      isCriticalHit,
      isSuperEffective,
      moveEffect2: secondaryResult?.moveEffect2 ?? null,
      deps,
      unmodelled,
      fainted,
    })

    const finalStatChanges: StatChangeOutcome[] = []
    if (secondaryResult?.statChanges) finalStatChanges.push(...secondaryResult.statChanges)
    if (moveEndOutcome.statChanges) finalStatChanges.push(...moveEndOutcome.statChanges)
    const finalStatusApplied = secondaryResult?.statusApplied ?? moveEndOutcome.statusApplied

    const combinedAttackerDamage = (attackerDamage !== null || moveEndOutcome.attackerDamage !== null)
      ? (attackerDamage ?? 0) + (moveEndOutcome.attackerDamage ?? 0)
      : null

    return {
      turnOrderIndex: index,
      battlerId,
      action: actionKind,
      skippedBecauseFainted: false,
      battleOver: false,
      missed: false,
      targetId: currentTargetId,
      targetDamage,
      attackerDamage: combinedAttackerDamage,
      cancelledBy: null,
      confusionSelfHitDamage: null,
      statChanges: secondaryResult?.statChanges || moveEndOutcome.statChanges ? finalStatChanges : null,
      statusApplied: finalStatusApplied,
      unmodelled: [...unmodelled, ...damageUnmodelled],
      fainted,
    }
  }

  return runMovePipeline(action.chosenMove, action.chosenMove, targetId, false)
}

function buildMoveView(id: string, dataContext: SimDataContext): TurnOrderMoveView {
  const data = dataContext.move(id)
  return {
    id,
    priority: data?.priority ?? 0,
    effect: data?.effect ?? null,
    isStatus: data?.split === 'STATUS',
    resolvedType: data?.type ?? 'NORMAL',
    power: data?.power ?? 0,
    flags: data?.flags ?? {},
    split: data?.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
}

/**
 * Drains gQueuedExtraAttackData, matching HandleAction_TryFinish (src/battle_util.c:751-769)
 * and TryPerformExtraAction (:771-783).
 *
 * In C:
 *   while (gQueuedAttackCount) {
 *       gQueuedExtraAttackData[0] = gQueuedExtraAttackData[gQueuedAttackCount--];
 *       FILTER(IsBattlerAlive(gQueuedExtraAttackData[0].attacker) ||
 *              (gQueuedExtraAttackData[0].ability && gBattleMoves[gQueuedExtraAttackData[0].move].effect == EFFECT_EXPLOSION))
 *       ClearMiscTurnFlags();
 *       gProcessingExtraAttacks = TRUE;
 *       gCurrentActionFuncId = B_ACTION_USE_MOVE;
 *       return TRUE;
 *   }
 *
 * C quirk kept: gQueuedExtraAttackData is named 'queue' but drained via gQueuedAttackCount-- (:776),
 * making it LIFO (pop from end) rather than FIFO.
 */
export function drainQueuedExtraAttacks(
  state: BattleState,
  index: number,
  order: TurnOrder,
  deps: TurnLoopDeps,
  outcomes: ActionOutcome[],
): void {
  while (state.queuedExtraAttacks.length > 0) {
    const extraAttack = state.queuedExtraAttacks.pop()!
    const moveData = deps.dataContext.move(extraAttack.move)
    const isExplosion = Boolean(extraAttack.ability) && moveData?.effect === 'EFFECT_EXPLOSION'

    if (!isBattlerAlive(state, extraAttack.attacker) && !isExplosion) {
      continue
    }

    state.processingExtraAttacks = true
    state.currentExtraAttack = extraAttack

    const moveView = buildMoveView(extraAttack.move, deps.dataContext)
    const extraAction: ChosenAction = {
      action: 'USE_MOVE',
      chosenMove: moveView,
      moveToBeUsed: moveView,
      target: extraAttack.target,
    }

    const extraOutcome = executeAction(state, extraAttack.attacker, extraAction, 'USE_MOVE', index, order, deps)
    outcomes.push(extraOutcome)
    state.currentExtraAttack = null
  }
  state.processingExtraAttacks = false
  state.currentExtraAttack = null
}

export function executeTurn(state: BattleState, actions: (ChosenAction | null)[], deps: TurnLoopDeps): TurnOutcome {
  // HandleBattleEvents (src/battle_main.c:5888, :3417, :3527)
  const battleEventsUnmodelled: string[] = []
  runBattleEvents(
    state,
    {
      dataContext: deps.dataContext,
      grounding: deps.grounding,
    },
    battleEventsUnmodelled,
  )

  assertNoPerBattlerQuash(state)
  clearStartedFlags(state)
  actions = actions.map((a, id) => applyEncore(state, id, a, deps))

  // TurnBasedPriority (battle_main.c:4411-4414) -- Custap Berry
  for (let i = 0; i < state.battlersCount; i++) {
    const b = state.battlers[i]
    if (!b || b.mon.hp === 0) continue
    const holdEffect = deps.grounding.holdEffectOf(i)
    if (
      holdEffect === 'HOLD_EFFECT_CUSTAP_BERRY' &&
      !isUnnerveAbilityOnOpposingSide(state, i, deps.dataContext)
    ) {
      const hasGluttony = battlerHasSimAbility(state, b, 'ABILITY_GLUTTONY', false, i, false, deps.dataContext)
      const threshold = Math.floor(b.mon.maxHp / (hasGluttony ? 2 : 4))
      if (b.mon.hp <= threshold) {
        b.round.usedCustapBerry = true
      }
    }
  }

  const ctx = buildTurnOrderContext(state, deps)
  const order = setActionsAndBattlersTurnOrder(state, actions)
  for (let i = 0; i < state.battlersCount; i++) {
    const a = actions[i]
    if (a?.action === 'USE_MOVE' && a.chosenMove) {
      const pos = state.battlers[i]?.mon.moves.indexOf(a.chosenMove.id) ?? -1
      state.chosenMovePositions[i] = pos >= 0 ? pos : 0
    }
  }
  const outcomes: ActionOutcome[] = []

  // CheckMegaEvolutionBeforeTurn (battle_main.c:4513-4541) and TryChangeTurnOrder (:4545-4549)
  const megaEvolved = checkMegaEvolutionBeforeTurn(state, actions, order, deps)
  const megaEvolutions = megaEvolved.length

  // RunTurnActionsFunctions, battle_main.c:3320 -- drain any attacks queued before first action
  if (state.queuedExtraAttacks.length > 0) {
    drainQueuedExtraAttacks(state, 0, order, deps, outcomes)
  }

  for (let index = 0; index < order.battlerByTurnOrder.length; index++) {
    // HandleAction_ActionFinished's TurnStructsClear (:856) runs after every
    // action; clearing at the top of each iteration (and once after the loop)
    // is equivalent and survives every `continue` below.
    turnStructsClear(state)
    // :849 -- the finished action's battler gets its pending-switch slot reset
    // to PARTY_SIZE before the re-sort; recalculateMoveOrder only touches slots
    // >= index, so [index - 1] is still that battler.
    if (index > 0) {
      const prevBattlerId = order.battlerByTurnOrder[index - 1]
      resetPendingSwitch(state, prevBattlerId)
      // :857-858 gLastLandedMoves[gBattlerAttacker] = 0; gLastHitByType[gBattlerAttacker] = 0;
      const prevBattler = state.battlers[prevBattlerId]
      if (prevBattler && actions[prevBattlerId]) {
        prevBattler.lastLandedMove = null
        prevBattler.lastHitByType = null
      }
    }
    // :4546 / :839 / :851 -- re-sort THIS slot before reading who is in it.
    recalculateMoveOrder(order, state, actions, index, false, ctx, deps.statStageRatios)

    const battlerId = order.battlerByTurnOrder[index]
    const action = actions[battlerId] ?? null
    const actionKind = order.actionsByTurnOrder[index]

    const outcome = executeAction(state, battlerId, action, actionKind, index, order, deps)
    outcomes.push(outcome)
    // Drain queued extra attacks immediately after action finishes, matching HandleAction_TryFinish
    drainQueuedExtraAttacks(state, index, order, deps, outcomes)
  }
  turnStructsClear(state)
  const lastActor = order.battlerByTurnOrder[order.battlerByTurnOrder.length - 1]
  if (lastActor !== undefined) {
    resetPendingSwitch(state, lastActor)
    // :857-858 gLastLandedMoves[gBattlerAttacker] = 0; gLastHitByType[gBattlerAttacker] = 0;
    const lastBattler = state.battlers[lastActor]
    if (lastBattler && actions[lastActor]) {
      lastBattler.lastLandedMove = null
      lastBattler.lastHitByType = null
    }
  }

  // BattleTurnPassed, battle_main.c:3465-3481: TurnValuesCleanUp(TRUE), then
  // DoFieldEndTurnEffects (fieldEndTurn.ts) and DoBattlerEndTurnEffects
  // (endTurn.ts), in that order, THEN HandleFaintedMonActions (switchIn.ts's
  // applyEndOfTurnReplacements, below) and HandleWishPerishSongOnTurnEnd
  // (below), and only after all of that does
  // gBattleResults.battleTurnCounter++ run (:3508-3511). Both residual
  // ladders therefore belong HERE, before the counter increment below -- not
  // after it. fieldEndTurn's own ENDTURN_ORDER recomputes gBattlerByTurnOrder;
  // endTurn's battler ladder receives THAT order, not this function's own
  // `order` (see fieldEndTurn.ts's header).
  //
  // BattleTurnPassed's own gate, `if (gBattleOutcome == 0 && !ranEndTurnEffects)
  // { if (DoFieldEndTurnEffects()) return; if (DoBattlerEndTurnEffects())
  // return; ... }` (:3479): when the outcome is ALREADY decided going into
  // this phase (a mid-turn action faint, per this batch's own extension --
  // see the action loop's own citation above), NEITHER ladder runs at all.
  // When the outcome becomes decided PARTWAY THROUGH the field ladder (a
  // fainting weather/terrain tick), fieldEndTurn.ts's own per-battler loops
  // stop early (see that module's own citation), and the battler ladder
  // (endTurn.ts) is skipped entirely here -- the real C achieves the same
  // result via re-entering BattleTurnPassed on its next call and finding
  // gBattleOutcome != 0 before DoBattlerEndTurnEffects ever runs.
  let endTurnOrder: number[] = []
  let fieldEndTurn: EndTurnEffectResult[] = []
  let fieldEndTurnUnmodelled: string[] = []
  let endTurn: EndTurnEffectResult[] = []
  let endTurnUnmodelled: string[] = []
  if (!state.battleOutcome) {
    const fieldResult = runFieldEndTurnEffects(state, ctx, deps.statStageRatios, deps.grounding, deps.dataContext)
    endTurnOrder = fieldResult.order
    fieldEndTurn = fieldResult.results
    fieldEndTurnUnmodelled = fieldResult.unmodelled
    if (!state.battleOutcome) {
      const battlerResult = runEndTurnEffects(state, endTurnOrder, deps.dataContext, {
        grounding: deps.grounding,
        statStageRatios: deps.statStageRatios,
      })
      endTurn = battlerResult.results
      endTurnUnmodelled = battlerResult.unmodelled
    }
  }

  // BattleTurnPassed, battle_main.c:3483: if (gQueuedAttackCount || gQueuedSwitchCount) return;
  // Extra attacks queued during end-turn run before replacements and wish/perish song
  if (!state.battleOutcome && state.queuedExtraAttacks.length > 0) {
    drainQueuedExtraAttacks(state, order.battlerByTurnOrder.length - 1, order, deps, outcomes)
  }

  // HandleFaintedMonActions's state-3 gate is exactly "the whole turn (both
  // ladders) is done" -- see switchIn.ts's own header for why this is the one
  // place this batch calls applyEndOfTurnReplacements, and why it is a no-op
  // both when deps.replacement was never supplied (every pre-this-batch
  // caller) and when state.battleOutcome is already set (no switch-in UI
  // exists once the battle is decided).
  const replacementUnmodelled: string[] = []
  if (deps.replacement) applyEndOfTurnReplacements(state, deps.replacement, deps, replacementUnmodelled)

  // HandleWishPerishSongOnTurnEnd (battle_util.c:2997-3078) in C has state 0: futureSightCounter (:2998-3031),
  // state 1: perishSongTimer (:3032-3053), state 2: arenaTurnCounter (:3060-3072). Wish itself is not
  // in HandleWishPerishSongOnTurnEnd; it is in DoFieldEndTurnEffects / ENDTURN_WISH (battle_util.c:1943-1958)
  // in fieldEndTurn.ts, which runs during runFieldEndTurnEffects above.
  // HandleWishPerishSongOnTurnEnd's perishSongTimer runs after HandleFaintedMonActions
  // (battle_main.c:3485-3489), over gBattlerByTurnOrder (endTurnOrder) skipping absent battlers.
  // BattleScript_PerishSongTakesLife's faint is then replaced on the next HandleFaintedMonActions pass.
  if (!state.battleOutcome) {
    let perishFainted = false
    for (const bId of endTurnOrder) {
      const b = state.battlers[bId]
      if (!b || hasFlag(state.absentBattlerFlags, 1 << bId) || !hasFlag(b.statuses3, STATUS3_PERISH_SONG)) continue
      if (b.volatiles.perishSongTimer === 0) {
        b.statuses3 = clearFlag(b.statuses3, STATUS3_PERISH_SONG)
        const faintedList: number[] = []
        applyDamage(state, bId, b.mon.hp, faintedList)
        if (faintedList.length) perishFainted = true
      } else {
        b.volatiles.perishSongTimer--
      }
    }
    if (perishFainted && deps.replacement) applyEndOfTurnReplacements(state, deps.replacement, deps, replacementUnmodelled)
  }

  // TurnValuesCleanUp(FALSE), battle_main.c:3492: ZERO(gRoundStructs[i])
  roundStructsClear(state)

  // HandleEndTurn_ContinueBattle, battle_main.c:3446: gQueuedAttackCount = 0;
  state.queuedExtraAttacks = []
  state.processingExtraAttacks = false
  state.currentExtraAttack = null

  // BattleCleanUp / battle_main.c:4830: UndoMegaEvolution for all player party slots at battle end
  if (state.battleOutcome !== null) {
    for (let i = 0; i < PARTY_SIZE; i++) {
      undoMegaEvolution(state, B_SIDE_PLAYER, i, deps.dataContext)
    }
  }

  // battle_main.c increments gBattleResults.battleTurnCounter after the action
  // loop and the end-turn ladders above; state.turnCount is therefore the
  // zero-based counter while resolving this turn (turn 1 is 0), matching
  // bridge.ts's parity checks. battle_main.c:3512-3513 saturates the u8
  // counter at 0xFF.
  state.turnCount = Math.min(0xFF, state.turnCount + 1)
  state.battleEventsDone = false
  return {
    actions: outcomes,
    order,
    endTurn,
    endTurnUnmodelled,
    fieldEndTurn,
    fieldEndTurnUnmodelled,
    endTurnOrder,
    outcome: state.battleOutcome,
    replacementUnmodelled,
    megaEvolutions,
    megaEvolved,
    battleEventsUnmodelled,
  }
}
