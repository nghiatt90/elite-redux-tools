// TryPreemptiveActions, src/battle_util.c:821-835 (also called from
// battle_main.c:4639 before the first action of the turn, and from both
// HandleAction_ActionFinished (:860) and HandleAction_NothingIsFainted (:845)),
// plus the onPreemptAction hook of the five abilities that have one:
// Tag (:10338-10351), Dreamcatcher (:4021-4024), Dreamscape (:10403, an alias
// of Dreamcatcher's hook), Super Sniper (:9832) and Surprise (:10355-10374).
//
// The shape of the mechanic: before the slot at `index` runs, every ALIVE
// battler on the opposite side has its ability slots walked in the C's own
// order (slot 3 down to slot 0, ON_ABILITY in include/battle_util.h:269-275).
// A slot whose ability has onPreemptAction may push onto
// gQueuedExtraAttackData; after the walk, if the queue is non-empty the
// pending slot action is PARKED (gDelayedTurnActionId = gCurrentActionFuncId),
// the LAST queued entry is popped into slot 0 and executed as an extra attack,
// and the parked action then runs in the same slot (HandleAction_TryFinish,
// battle_util.c:751-769, restores it). turn.ts does that sequencing; this module
// only decides what gets queued.
//
// `battler` in the hook is the ability HOLDER, `turnBattler` is the battler
// about to act (the actor whose pending action the hooks inspect).

import { MAX_MON_MOVES, STATUS1_SLEEP, WEATHER_FOG_ANY, hasFlag } from './constants'
import { getBattlerAbilitySlotsReverse, getBattlerBattleMoveTargetFlags } from './moveEnd'
import type { BattleState } from './state'
import { battlerHasSimAbility, isBattlerWeatherAffected, isSimAbilitySuppressed } from './statBuffs'
import type { StatusDeps } from './statusEffects'
import type { ChosenAction, TurnOrder } from './turnOrder'
import { battlerSide, getMovePriority } from './turnOrder'
import type { TurnLoopDeps } from './turn'
import { isBattlerAlive } from './turn'

/**
 * TryPreemptiveActions, src/battle_util.c:821-835.
 *
 * `index` is gCurrentTurnActionNumber; `order` mirrors gBattlerByTurnOrder /
 * gActionsByTurnOrder. The actor's PENDING action is `order.actionsByTurnOrder[index]`
 * (`B_ACTION_SWITCH` = 'SWITCH', `B_ACTION_USE_MOVE` = 'USE_MOVE').
 *
 * Every push goes through to `state.queuedExtraAttacks`, which turn.ts drains
 * LIFO exactly as TryPerformExtraAction does (:771-783).
 */
export function tryPreemptiveActions(
  state: BattleState,
  index: number,
  order: TurnOrder,
  actions: (ChosenAction | null)[],
  deps: TurnLoopDeps,
): void {
  const turnBattler = order.battlerByTurnOrder[index]
  if (turnBattler === undefined) return
  const turnAction = order.actionsByTurnOrder[index]
  const statusDeps: StatusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }

  // GetOppositeSide(battler) = BATTLE_OPPOSITE(GetBattlerSide(battler))
  // (battle_anim_mons.c:671, :673): the loop starts at the FIRST battler of the
  // opposite side and steps by 2, so in singles that is the one opponent and in
  // doubles both opponents. FILTER(IsBattlerAlive(opponent)) drops a fainted one.
  for (let opponent = battlerSide(turnBattler) ^ 1; opponent < state.battlersCount; opponent += 2) {
    if (!isBattlerAlive(state, opponent)) continue
    const holder = state.battlers[opponent]
    if (!holder) continue

    // ON_ABILITY(opponent, TRUE, gAbilities[ability].onPreemptAction, ...):
    // slots walked as numPossibleAbilities-1 .. 0, and
    // FILTER_NOT(IsSuppressed(battler, ability, checkMoldBreaker)). The TRUE
    // only matters when HITMARKER_MOLD_BREAKER is set, which it is not outside
    // a move's own resolution -- the hitmarker is cleared by ClearMiscTurnFlags
    // before every call site of TryPreemptiveActions.
    for (const { abilityId } of getBattlerAbilitySlotsReverse(holder.mon.abilities)) {
      if (isSimAbilitySuppressed(state, holder, abilityId, true, opponent, false, deps.dataContext)) continue

      switch (abilityId) {
        case 'ABILITY_TAG':
          tryPreemptTag(state, holder.id, abilityId, turnBattler, turnAction)
          break
        case 'ABILITY_DREAMCATCHER':
        case 'ABILITY_DREAMSCAPE':
          // Dreamscape (src/abilities.cc:10403) is
          // `Impl<ABILITY_DREAMCATCHER>.onPreemptAction`.
          tryPreemptDreamcatcher(state, holder.id, abilityId, turnBattler, turnAction, order, actions, deps, statusDeps)
          break
        case 'ABILITY_SUPER_SNIPER':
          // src/abilities.cc:9832 -- UseTurnAttackAsPursuit with no extra condition.
          useTurnAttackAsPursuit(state, holder.id, abilityId, turnBattler, turnAction, order, actions, deps, statusDeps)
          break
        case 'ABILITY_SURPRISE':
          tryPreemptSurprise(state, holder.id, abilityId, turnBattler, turnAction, actions, deps, statusDeps)
          break
        default:
          break
      }
    }
  }
}

/** Tag, src/abilities.cc:10338-10351. Queues a fixed 20-power Pursuit at the
 * switching battler. No `movePos`, so no PP is deducted; and unlike
 * UseTurnAttackAsPursuit the holder's own slot is NOT consumed. */
function tryPreemptTag(
  state: BattleState,
  holderId: number,
  ability: string,
  turnBattler: number,
  turnAction: ChosenAction['action'] | 'FINISHED',
): void {
  if (turnAction !== 'SWITCH') return
  state.queuedExtraAttacks.push({
    ability,
    move: 'MOVE_PURSUIT',
    movePower: 20,
    attacker: holderId,
    target: turnBattler,
  })
}

/** Dreamcatcher, src/abilities.cc:4021-4024: the actor must be asleep (or
 * Comatose), then UseTurnAttackAsPursuit runs unchanged.
 * Dreamscape (:10403) reuses this hook verbatim. */
function tryPreemptDreamcatcher(
  state: BattleState,
  holderId: number,
  ability: string,
  turnBattler: number,
  turnAction: ChosenAction['action'] | 'FINISHED',
  order: TurnOrder,
  actions: (ChosenAction | null)[],
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
): void {
  const actor = state.battlers[turnBattler]
  if (!actor) return
  // `gBattleMons[turnBattler].status1 & STATUS1_SLEEP || IsComatose(turnBattler)`
  if (!hasFlag(actor.mon.status1, STATUS1_SLEEP) && !isComatose(state, turnBattler, deps)) return
  useTurnAttackAsPursuit(state, holderId, ability, turnBattler, turnAction, order, actions, deps, statusDeps)
}

/**
 * UseTurnAttackAsPursuit, src/abilities.cc:390-418. Called by Dreamcatcher,
 * Dreamscape and Super Sniper.
 *
 * The holder's CHOSEN move is queued at the switching battler, with
 * `movePos = chosenMovePositions[battler] + 1` (clamped to MAX_MON_MOVES) so
 * HandleAction_UseMove deducts PP for it (:205-207, :667-674), and the holder's
 * own slot is overwritten with B_ACTION_FINISHED so it does not use the move a
 * second time later in the turn.
 */
function useTurnAttackAsPursuit(
  state: BattleState,
  holderId: number,
  ability: string,
  turnBattler: number,
  turnAction: ChosenAction['action'] | 'FINISHED',
  order: TurnOrder,
  actions: (ChosenAction | null)[],
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
): boolean {
  // CHECK(gCurrentActionFuncId == B_ACTION_SWITCH)
  if (turnAction !== 'SWITCH') return false

  // CHECK(gActionsByTurnOrder[GetBattlerTurnOrderNum(battler)] == B_ACTION_USE_MOVE):
  // the holder has not acted yet and chose a move. GetBattlerTurnOrderNum
  // (battle_script_commands.c:2169-2174) scans gBattlerByTurnOrder for the id.
  const holderSlot = order.battlerByTurnOrder.indexOf(holderId)
  if (holderSlot === -1) return false
  if (order.actionsByTurnOrder[holderSlot] !== 'USE_MOVE') return false

  // GetChosenMove(battler) (battle_main.c:4234-4241). gProcessingExtraAttacks is
  // FALSE when a preempt hook runs (HandleAction_TryFinish clears it before
  // dispatch), so this is gChosenMoveByBattler -- the sim's chosenMove.
  const holderAction = actions[holderId]
  if (!holderAction || !holderAction.chosenMove) return false
  const moveId = holderAction.chosenMove.id
  const moveData = deps.dataContext.move(moveId)

  // GetBattlerBattleMoveTargetFlags(move, battler) (battle_util.c:128-149).
  const targetFlag = getBattlerBattleMoveTargetFlags(state, holderId, moveId, moveData, deps, statusDeps)
  switch (targetFlag) {
    case 'SELECTED':
      // CHECK(gBattleStruct->moveTarget[battler] == turnBattler)
      if (holderAction.target !== turnBattler) return false
      break
    case 'BOTH':
    case 'FOES_AND_ALLY':
      break
    case 'RANDOM':
    default:
      return false
  }

  const chosenPosition = (state.chosenMovePositions[holderId] ?? 0) + 1
  state.queuedExtraAttacks.push({
    ability,
    move: moveId,
    attacker: holderId,
    target: turnBattler,
    movePos: Math.min(chosenPosition, MAX_MON_MOVES),
  })
  order.actionsByTurnOrder[holderSlot] = 'FINISHED'
  return true
}

/**
 * Surprise, src/abilities.cc:10355-10374. In fog, when the battler about to act
 * uses a NON-ZERO-priority move aimed somewhere Astonish can reach, the holder
 * throws a free Astonish at it before that move runs. The holder's own action is
 * not consumed.
 */
function tryPreemptSurprise(
  state: BattleState,
  holderId: number,
  ability: string,
  turnBattler: number,
  turnAction: ChosenAction['action'] | 'FINISHED',
  actions: (ChosenAction | null)[],
  deps: TurnLoopDeps,
  statusDeps: StatusDeps,
): void {
  // CHECK(gCurrentActionFuncId == B_ACTION_USE_MOVE)
  if (turnAction !== 'USE_MOVE') return
  // CHECK(IsBattlerWeatherAffected(battler, WEATHER_FOG_ANY)) (battle_util.c:8644-8653)
  if (!isBattlerWeatherAffected(state, holderId, WEATHER_FOG_ANY, { dataContext: deps.dataContext, grounding: deps.grounding })) return

  // MoveEnum move = GetChosenMove(turnBattler); targetFlag = GetBattlerBattleMoveTargetFlags(move, turnBattler)
  const actorAction = actions[turnBattler]
  if (!actorAction || !actorAction.chosenMove) return
  const moveId = actorAction.chosenMove.id
  const targetFlag = getBattlerBattleMoveTargetFlags(state, turnBattler, moveId, deps.dataContext.move(moveId), deps, statusDeps)

  // CHECK(GetMovePriority(turnBattler, move, gBattleStruct->moveTarget[turnBattler])):
  // a bare truthiness test, so a NEGATIVE priority passes too; only 0 fails.
  if (getMovePriority(state, turnBattler, actorAction.chosenMove, actorAction.target) === 0) return

  switch (targetFlag) {
    case 'BOTH':
    case 'RANDOM':
    case 'FOES_AND_ALLY':
      break
    case 'SELECTED':
      // CHECK(GetBattlerSide(gBattleStruct->moveTarget[turnBattler]) == GetBattlerSide(battler))
      if (actorAction.target === null || battlerSide(actorAction.target) !== battlerSide(holderId)) return
      break
    default:
      return
  }

  state.queuedExtraAttacks.push({ ability, move: 'MOVE_ASTONISH', attacker: holderId, target: turnBattler })
}

/**
 * IsComatose, src/battle_util.c:8995-8998:
 * `RETURN_ABILITY_IF_FLAG(battler, FALSE, alwaysSleeping)` -- any unsuppressed
 * ability slot carrying the `alwaysSleeping` bitfield. abilityHooks.json lists
 * exactly two abilities with that flag: ABILITY_COMATOSE and ABILITY_DREAMSCAPE
 * (bridge.ts:408 derives it the same way).
 */
function isComatose(state: BattleState, battlerId: number, deps: TurnLoopDeps): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  return (
    battlerHasSimAbility(state, battler, 'ABILITY_COMATOSE', false, battlerId, false, deps.dataContext) ||
    battlerHasSimAbility(state, battler, 'ABILITY_DREAMSCAPE', false, battlerId, false, deps.dataContext)
  )
}
