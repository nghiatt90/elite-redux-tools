// Move-flag / move-target-flag derivations shared by the turn loop and the
// accuracy bridge.
//
// This module exists to keep accuracyBridge.ts out of moveEnd.ts. moveEnd.ts
// imports turn.ts at runtime (ProtectType, applyDamage, getMoveTarget, ...),
// turn.ts imports accuracyBridge.ts, so `accuracyBridge -> moveEnd` would close
// a runtime cycle. Nothing here imports moveEnd.ts, turn.ts or accuracyBridge.ts
// (only statusEffects/statBuffs/grounding/constants/state/dataContext), so
// `accuracyBridge -> this module` is acyclic. moveEnd.ts re-exports both
// functions so its existing importers (preempt.ts, cycle92FollowUps.test.ts)
// are unchanged.
//
// The bodies are verbatim moves of the two functions that used to live in
// moveEnd.ts; only the `deps` parameter types were narrowed from TurnLoopDeps
// to the fields the bodies actually read (dataContext and, for the target
// flags, grounding -- exactly statusEffects.ts's StatusDeps). Behaviour is
// unchanged and every caller passes a superset object.

import type { BattleState } from './state'
import {
  BATTLE_TYPE_DOUBLE,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_FOG_ANY,
  hasFlag,
} from './constants'
import type { SimMoveData } from './dataContext'
import type { StatusDeps } from './statusEffects'
import { isBattlerTerrainAffected, isKeenEdgeMove, isSoundMove } from './statusEffects'
import { isBattlerGrounded } from './grounding'
import { battlerHasSimAbility, isBattlerWeatherAffected } from './statBuffs'

/**
 * IsMegaLauncherBoosted (src/battle_util.c:9373) -> DoesMoveMatchFlag(battler, move, TYPE_NORMAL, MOVE_FLAG_MEGA_LAUNCHER)
 * (src/abilities.cc:358-388): static FLAG_MEGA_LAUNCHER_BOOST (`bulletBased` in moves.json), else ABILITY_GUNMAN's
 * onModifyMoveFlags (:9535-9540) which grants MOVE_FLAG_MEGA_LAUNCHER to status moves.
 */
export function isMegaLauncherBoostedMove(
  state: BattleState,
  battlerId: number,
  moveData: SimMoveData | undefined,
  deps: Pick<StatusDeps, 'dataContext'>,
): boolean {
  if (!moveData) return false
  if (moveData.flags?.bulletBased) return true
  const battler = state.battlers[battlerId]
  if (!battler) return false
  return moveData.split === 'STATUS' && battlerHasSimAbility(state, battler, 'ABILITY_GUNMAN', false, battlerId, false, deps.dataContext)
}

/**
 * GetBattlerBattleMoveTargetFlags (src/battle_util.c:128-149), read by AdjustFollowupMoveTarget.
 * Exported for preempt.ts: the onPreemptAction hooks (UseTurnAttackAsPursuit,
 * Surprise) call this same function to decide which target shapes they accept.
 * accuracyBridge.ts reads it for Ole's onAccuracy hook (abilities.cc:7556-7570).
 */
export function getBattlerBattleMoveTargetFlags(
  state: BattleState,
  battlerId: number,
  moveId: string,
  moveData: SimMoveData | undefined,
  deps: Pick<StatusDeps, 'dataContext' | 'grounding'>,
  statusDeps: StatusDeps,
): string {
  if (moveData?.effect === 'EFFECT_EXPANDING_FORCE' && isBattlerTerrainAffected(state, battlerId, STATUS_FIELD_PSYCHIC_TERRAIN, statusDeps)) {
    return 'BOTH'
  }
  if (
    moveData?.effect === 'EFFECT_TOXIC_THREAD' &&
    isBattlerGrounded(state, battlerId, deps.grounding) &&
    hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)
  ) {
    return 'BOTH'
  }

  if (
    moveId === 'MOVE_RAIN_DANCE' ||
    moveId === 'MOVE_SUNNY_DAY' ||
    moveId === 'MOVE_SANDSTORM' ||
    moveId === 'MOVE_HAIL' ||
    moveId === 'MOVE_EERIE_FOG'
  ) {
    const holder = state.battlers[battlerId]
    if (!holder || !battlerHasSimAbility(state, holder, 'ABILITY_FORECAST', false, battlerId, false, deps.dataContext)) {
      return 'USER'
    }
  }

  let flag = moveData?.target ?? 'SELECTED'
  const battler = state.battlers[battlerId]
  if (battler && (flag === 'SELECTED' || flag === 'RANDOM')) {
    if (
      (battlerHasSimAbility(state, battler, 'ABILITY_ARTILLERY', false, battlerId, false, deps.dataContext) ||
        battlerHasSimAbility(state, battler, 'ABILITY_SUPER_SCOPE', false, battlerId, false, deps.dataContext)) &&
      isMegaLauncherBoostedMove(state, battlerId, moveData, deps)
    ) {
      flag = 'BOTH'
    } else if (
      (battlerHasSimAbility(state, battler, 'ABILITY_AMPLIFIER', false, battlerId, false, deps.dataContext) ||
        battlerHasSimAbility(state, battler, 'ABILITY_BASS_BOOSTED', false, battlerId, false, deps.dataContext) ||
        battlerHasSimAbility(state, battler, 'ABILITY_WIND_CHIMES', false, battlerId, false, deps.dataContext)) &&
      isSoundMove(state, battlerId, moveId, statusDeps)
    ) {
      flag = 'BOTH'
    } else if (
      (battlerHasSimAbility(state, battler, 'ABILITY_SWEEPING_EDGE', false, battlerId, false, deps.dataContext) ||
        battlerHasSimAbility(state, battler, 'ABILITY_SWEEPING_EDGE_PLUS', false, battlerId, false, deps.dataContext)) &&
      isKeenEdgeMove(state, battlerId, moveId, statusDeps)
    ) {
      flag = 'BOTH'
    }
  }
  return flag
}

/**
 * The PLAYER controller's target choice at move selection,
 * src/battle_controller_player.c:2385-2398, returned as a battler id:
 *
 *     if (moveInfo->moves[...] == MOVE_CURSE) {
 *         if (monType1/2/3 == TYPE_GHOST) moveTarget = MOVE_TARGET_SELECTED;
 *         else if (IsBattlerWeatherAffected(gActiveBattler, WEATHER_FOG_ANY)) moveTarget = MOVE_TARGET_SELECTED;
 *         else moveTarget = MOVE_TARGET_USER;
 *     } else {
 *         moveTarget = GetBattlerBattleMoveTargetFlags(...);
 *     }
 *     if (moveTarget & MOVE_TARGET_USER) gMultiUsePlayerCursor = gActiveBattler;
 *     else gMultiUsePlayerCursor = <opposing side>;
 *
 * That id is what `gBattleStruct->moveTarget[]` stores for the turn, and
 * HandleAction_UseMove (:242) reads it back without re-reading the flags, so the sim
 * must decide it once, at selection, and not re-derive it at execution.
 *
 * The test is a BIT test: `MOVE_TARGET_USER` is set in USER, USER_OR_ALLY
 * (USER | ALLY) and ALL_BATTLERS (0x100 | USER, include/constants/battle.h:499-501),
 * but not in USER_OR_SELECTED (0x2). MOVE_TARGET_ALLY on the player side is left to
 * `battlerId ^ 1` here; the live-partner re-check happens at execution
 * (battle_util.c:283-287, resolveMoveEndDispatchTarget).
 */
export function getPlayerSelectedMoveTarget(
  state: BattleState,
  battlerId: number,
  moveId: string,
  moveData: SimMoveData | undefined,
  deps: Pick<StatusDeps, 'dataContext' | 'grounding'>,
  statusDeps: StatusDeps,
): number {
  const moveTarget = playerMoveTargetFlag(state, battlerId, moveId, moveData, deps, statusDeps)
  if (moveTarget === 'USER' || moveTarget === 'USER_OR_ALLY' || moveTarget === 'ALL_BATTLERS') return battlerId
  return battlerId ^ 1
}

/** The `moveTarget` word both the cursor choice and the canSelectTarget gate read:
 * GetBattlerBattleMoveTargetFlags with the Curse special case
 * (battle_controller_player.c:2386-2394). */
function playerMoveTargetFlag(
  state: BattleState,
  battlerId: number,
  moveId: string,
  moveData: SimMoveData | undefined,
  deps: Pick<StatusDeps, 'dataContext' | 'grounding'>,
  statusDeps: StatusDeps,
): string {
  if (moveId === 'MOVE_CURSE') {
    const isGhost = state.battlers[battlerId]?.mon.types.includes('GHOST') ?? false
    return isGhost || isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, deps) ? 'SELECTED' : 'USER'
  }
  return getBattlerBattleMoveTargetFlags(state, battlerId, moveId, moveData, deps, statusDeps)
}

/**
 * canSelectTarget, src/battle_controller_player.c:2402-2410: whether the player's
 * cursor (`gMultiUsePlayerCursor`) survives as this move's target. It is set only in
 * a double (`bufferA[gActiveBattler][1]`, :2402) and only when the DYNAMIC target has
 * none of RANDOM | BOTH | DEPENDS | FOES_AND_ALLY | OPPONENTS_FIELD | USER | ALLY:
 *
 *     if (!(moveTarget & (MOVE_TARGET_RANDOM | MOVE_TARGET_BOTH | MOVE_TARGET_DEPENDS |
 *                         MOVE_TARGET_FOES_AND_ALLY | MOVE_TARGET_OPPONENTS_FIELD |
 *                         MOVE_TARGET_USER | MOVE_TARGET_ALLY)))
 *         canSelectTarget = 1;  // either selected or user
 *     if (moveTarget == (MOVE_TARGET_USER | MOVE_TARGET_ALLY) && IsBattlerAlive(BATTLE_PARTNER(gActiveBattler)))
 *         canSelectTarget = 1;
 *
 * The two later overrides -- zero PP (:2412-2413) and
 * `CountAliveMonsInBattle(BATTLE_ALIVE_EXCEPT_ACTIVE) <= 1` (:2414-2416) -- are
 * selection-UI state the sim does not carry into buildMoveAction; callers that pass an
 * explicit target are already past that screen.
 */export function playerCanSelectMoveTarget(
  state: BattleState,
  battlerId: number,
  moveId: string,
  moveData: SimMoveData | undefined,
  deps: Pick<StatusDeps, 'dataContext' | 'grounding'>,
  statusDeps: StatusDeps,
): boolean {
  if (!hasFlag(state.battleTypeFlags, BATTLE_TYPE_DOUBLE)) return false
  const moveTarget = playerMoveTargetFlag(state, battlerId, moveId, moveData, deps, statusDeps)
  // USER_OR_ALLY is USER | ALLY, so it fails the mask and gets its own partner-alive
  // exception (:2409-2410).
  if (moveTarget === 'USER_OR_ALLY') return isPartnerAlive(state, battlerId)
  return !(
    moveTarget === 'RANDOM' ||
    moveTarget === 'BOTH' ||
    moveTarget === 'DEPENDS' ||
    moveTarget === 'FOES_AND_ALLY' ||
    moveTarget === 'OPPONENTS_FIELD' ||
    moveTarget === 'USER' ||
    moveTarget === 'ALLY'
  )
}

/** IsBattlerAlive(BATTLE_PARTNER(battlerId)); inlined here because turn.ts imports
 * this module, so isBattlerAlive cannot be imported back (module-header note). */
function isPartnerAlive(state: BattleState, battlerId: number): boolean {
  const partner = battlerId ^ 2
  const battler = state.battlers[partner]
  if (!battler || battler.mon.hp === 0) return false
  return (state.absentBattlerFlags & (1 << partner)) === 0
}

/**
 * The OPPONENT controller's target choice at move selection,
 * src/battle_controller_opponent.c:1599-1611 (OpponentHandleChooseMove's `default:`
 * case), returned as a battler id:
 *
 *     if (target & (MOVE_TARGET_USER_OR_SELECTED | MOVE_TARGET_USER)) gBattlerTarget = gActiveBattler;
 *     if (target & MOVE_TARGET_BOTH) gBattlerTarget = GetBattlerAtPosition(B_POSITION_PLAYER_LEFT);
 *
 * The first test is a BIT test: MOVE_TARGET_USER is set in USER, USER_OR_ALLY
 * (USER | ALLY) and ALL_BATTLERS (0x100 | USER), and USER_OR_SELECTED is a bit set
 * only in itself (include/constants/battle.h:496-501), so exactly those four
 * spellings select the attacker. BOTH yields the player's left position, battler 0,
 * and falls to PLAYER_RIGHT (battler 2) when battler 0 is absent (:1602-1607):
 *
 *     if (target & MOVE_TARGET_BOTH) {
 *         gBattlerTarget = GetBattlerAtPosition(B_POSITION_PLAYER_LEFT);
 *         if (gAbsentBattlerFlags & gBitTable[gBattlerTarget])
 *             gBattlerTarget = GetBattlerAtPosition(B_POSITION_PLAYER_RIGHT);
 *     }
 *
 * `absentBattlerFlags` is the caller's `state.absentBattlerFlags` (gAbsentBattlerFlags);
 * `gBitTable[0]` is `1 << 0`. Every other static target keeps the AI's own choice
 * (gBattleStruct->aiChosenTarget, assigned at :1583). The opponent branch has no Curse
 * special case (unlike the player's :2386-2394).
 */
export function getOpponentSelectedMoveTarget(
  battlerId: number,
  staticTarget: string | undefined,
  aiChosenTarget: number,
  absentBattlerFlags: number = 0,
): number {
  if (
    staticTarget === 'USER' ||
    staticTarget === 'USER_OR_SELECTED' ||
    staticTarget === 'USER_OR_ALLY' ||
    staticTarget === 'ALL_BATTLERS'
  ) {
    return battlerId
  }
  if (staticTarget === 'BOTH') {
    // B_POSITION_PLAYER_LEFT is battle.h:30; GetBattlerAtPosition is the identity for a
    // non-multi battle, so the position doubles as the battler id.
    const playerLeft = 0
    return hasFlag(absentBattlerFlags, 1 << playerLeft) ? 2 : playerLeft
  }
  return aiChosenTarget
}
