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
import { STATUS_FIELD_PSYCHIC_TERRAIN, STATUS_FIELD_TOXIC_TERRAIN, hasFlag } from './constants'
import type { SimMoveData } from './dataContext'
import type { StatusDeps } from './statusEffects'
import { isBattlerTerrainAffected, isKeenEdgeMove, isSoundMove } from './statusEffects'
import { isBattlerGrounded } from './grounding'
import { battlerHasSimAbility } from './statBuffs'

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
