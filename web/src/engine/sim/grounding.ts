// IsBattlerGrounded and its two helpers, src/battle_util.c:6647-6683.
//
// Written for the turn loop, which must supply real grounding rather than take
// the neutral context's majority guess (see NEUTRAL_TURN_ORDER_CONTEXT's own
// doc). Every input is in the sim state or resolvable from the ability registry,
// so this is a real port, not another seam.

import type { BattleState } from './state'
import { B_SIDE_PLAYER, STATUS3_MAGNET_RISE, STATUS3_ROOTED, STATUS3_SMACKED_DOWN, STATUS3_TELEKINESIS, STATUS_FIELD_GRAVITY, hasFlag } from './constants'
import { hasFlag as abilitySlotsHaveFlag } from '../abilities/dispatchCalc'

/** Facts the grounding check needs that the state model does not itself carry. */
export interface GroundingContext {
  /** `GetBattlerHoldEffect(battler, TRUE)` -- bare HOLD_EFFECT_* name or null. */
  holdEffectOf(battlerId: number): string | null
  /** `getMonotypeChampType()` -- a bare type name or null. Read TWICE by the
   * grounding path alone: GROUND grounds the player's side (:6656), and it also
   * feeds IsGravityActive's sibling checks elsewhere. */
  monotypeChampType: string | null
  /** `IsAbilityOnField(ABILITY_CLUELESS)` -- suppresses Gravity (:8690). A
   * whole-field ability scan the state model has the data for but no helper to
   * do; the same fact engine/types.ts already collapses for Inverse and Wonder
   * Room. */
  isCluelessOnField: boolean
  /** Whether the battler whose grounding is being tested is currently being
   * attacked by a Mold Breaker holder -- CheckLevitatingEffects passes
   * checkMoldBreaker TRUE (:6669), unlike most of this module's callers. */
  attackerHasMoldBreaker: boolean
}

/** IsGravityActive, src/battle_util.c:8689-8696. Clueless anywhere on the field
 * beats the field status. */
export function isGravityActive(state: BattleState, ctx: GroundingContext): boolean {
  if (ctx.isCluelessOnField) return false
  return hasFlag(state.field.statuses, STATUS_FIELD_GRAVITY)
}

/** CheckGroundingEffects, src/battle_util.c:6647-6660 -- effects that force a
 * battler onto the ground, and which beat BOTH the Flying type and every
 * levitating effect. */
function checkGroundingEffects(state: BattleState, battlerId: number, ctx: GroundingContext): boolean {
  if (ctx.holdEffectOf(battlerId) === 'HOLD_EFFECT_IRON_BALL') return true
  if (isGravityActive(state, ctx)) return true
  const battler = state.battlers[battlerId]
  if (!battler) return false
  // STATUS3_ROOTED is Ingrain.
  if (hasFlag(battler.statuses3, STATUS3_ROOTED)) return true
  if (hasFlag(battler.statuses3, STATUS3_SMACKED_DOWN)) return true
  // :6656 -- a GROUND Monotype Champion grounds the PLAYER's side only.
  if (ctx.monotypeChampType === 'GROUND' && (battlerId & 1) === B_SIDE_PLAYER) return true
  return false
}

/** CheckLevitatingEffects, src/battle_util.c:6662-6672. The C returns the
 * ABILITY responsible (for the message) or TRUE/FALSE; only its truthiness
 * matters here, so this returns a boolean and notes the difference.
 *
 * Note the ability check passes checkMoldBreaker TRUE (:6669,
 * RETURN_ABILITY_IF_FLAG(battlerId, TRUE, levitate)) -- Levitate is suppressed
 * by an attacking Mold Breaker, unlike the item and status effects above it,
 * which are not abilities and cannot be. */
function checkLevitatingEffects(state: BattleState, battlerId: number, ctx: GroundingContext): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (hasFlag(battler.statuses3, STATUS3_TELEKINESIS)) return true
  if (hasFlag(battler.statuses3, STATUS3_MAGNET_RISE)) return true
  if (ctx.holdEffectOf(battlerId) === 'HOLD_EFFECT_AIR_BALLOON') return true
  return abilitySlotsHaveFlag(battler.mon.abilities, 'levitate', ctx.attackerHasMoldBreaker)
}

/**
 * IsBattlerGrounded, src/battle_util.c:6679-6683.
 *
 * Order matters and is not intuitive: a grounding effect wins outright, THEN a
 * Flying type is ungrounded regardless of anything else, and only then do the
 * levitating effects decide. So Gravity grounds a Flying-type, but Air Balloon
 * does not un-ground a mon that Gravity has already grounded.
 */
export function isBattlerGrounded(state: BattleState, battlerId: number, ctx: GroundingContext): boolean {
  if (checkGroundingEffects(state, battlerId, ctx)) return true
  const battler = state.battlers[battlerId]
  if (!battler) return false
  // IS_BATTLER_OF_TYPE checks all three type slots (include/battle.h:753-754).
  if (battler.mon.types.includes('FLYING')) return false
  return !checkLevitatingEffects(state, battlerId, ctx)
}

// IsBattlerGroundedIgnoreType (src/battle_util.c:6674-6677) is the same test
// WITHOUT the Flying-type exemption -- `CheckGroundingEffects(b) ||
// !CheckLevitatingEffects(b)`. It is deliberately NOT exported here: its only
// caller is the Ground-type immunity check at :7948, which lives on the damage
// path and is outside this batch. It belongs with whoever ports that check, and
// it would arrive untested if left here now. Both of its helpers are above.
