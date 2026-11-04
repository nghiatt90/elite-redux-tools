// Port of IsAbilityPreventingEscape and CanBattlerEscape (src/battle_util.c:4826-4858)
// with the five onTrap ability hooks from data/v2.65beta/abilityHooks.json.

import type { BattleState, BattlerState } from './state'
import {
  B_SIDE_PLAYER,
  DEFAULT_STAT_STAGE,
  STAT_SPEED,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_WRAPPED,
  STATUS3_ROOTED,
  STATUS4_COMMANDED,
  STATUS_FIELD_FAIRY_LOCK,
  hasFlag,
} from './constants'
import { isBattlerGrounded, type GroundingContext } from './grounding'
import type { SimDataContext } from './dataContext'
import { battlerHasSimAbility, isSimAbilitySuppressed } from './statBuffs'

/** The 5 abilities with an `onTrap` hook in abilityHooks.json at the pinned
 * snapshot: Arena Trap, Frenzied Phantom, Magnet Pull, Sap Trap, Shadow Tag. */
export const TRAPPING_ABILITIES = new Set([
  'ABILITY_ARENA_TRAP',
  'ABILITY_FRENZIED_PHANTOM',
  'ABILITY_MAGNET_PULL',
  'ABILITY_SAP_TRAP',
  'ABILITY_SHADOW_TAG',
])

/** Abilities with the `shadowTag` bitfield in abilityHooks.json. */
const SHADOW_TAG_ABILITIES = ['ABILITY_SHADOW_TAG', 'ABILITY_FRENZIED_PHANTOM']

export interface EscapeDeps {
  dataContext: SimDataContext
  grounding: GroundingContext
}

/** ItemId_GetHoldEffect(gBattleMons[battlerId].item) -- the item's own hold effect, no Klutz/Embargo. */
function rawHoldEffect(battler: BattlerState, deps: EscapeDeps): string | null {
  return battler.mon.itemId ? (deps.dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null) : null
}

/** The onTrap hook bodies (abilityHooks.json). */
function onTrap(abilityId: string, state: BattleState, switching: BattlerState, deps: EscapeDeps): boolean {
  switch (abilityId) {
    case 'ABILITY_ARENA_TRAP':
      return isBattlerGrounded(state, switching.id, deps.grounding)
    case 'ABILITY_MAGNET_PULL':
      return switching.mon.types.includes('STEEL')
    case 'ABILITY_SAP_TRAP':
      return (switching.mon.statStages[STAT_SPEED] ?? DEFAULT_STAT_STAGE) <= 3
    case 'ABILITY_SHADOW_TAG':
    case 'ABILITY_FRENZIED_PHANTOM':
      // !BattlerHasAbility(switchingBattler, FALSE, <shadowTag predicate>)
      return !SHADOW_TAG_ABILITIES.some((id) =>
        battlerHasSimAbility(state, switching, id, false, switching.id, false, deps.dataContext),
      )
    default:
      return false
  }
}

/**
 * IsAbilityPreventingEscape, src/battle_util.c:4826-4834: raw Shed Shell, Ghost type, then
 * ON_ABILITY(opponent, FALSE, onTrap) over each alive opposing battler. `trappingBattlerId` is the
 * C's `opponent + 1` return minus one.
 */
export function isAbilityPreventingEscape(
  state: BattleState,
  battlerId: number,
  deps: EscapeDeps,
): { prevents: boolean; trappingBattlerId: number | null; unmodelled: string[] } {
  const none = { prevents: false, trappingBattlerId: null, unmodelled: [] }
  const battler = state.battlers[battlerId]
  if (!battler) return none
  if (rawHoldEffect(battler, deps) === 'HOLD_EFFECT_SHED_SHELL') return none
  if (battler.mon.types.includes('GHOST')) return none

  for (let opponentId = (battlerId & 1) ^ 1; opponentId < state.battlersCount; opponentId += 2) {
    const opponent = state.battlers[opponentId]
    if (!opponent || opponent.mon.hp <= 0 || state.absentBattlerFlags & (1 << opponentId)) continue
    const slots = [opponent.mon.abilities.ability, ...opponent.mon.abilities.innates]
    for (let idx = slots.length - 1; idx >= 0; idx--) {
      const abilityId = slots[idx]
      if (!abilityId || !TRAPPING_ABILITIES.has(abilityId)) continue
      if (isSimAbilitySuppressed(state, opponent, abilityId, false, opponentId, false, deps.dataContext)) continue
      if (onTrap(abilityId, state, battler, deps)) {
        return { prevents: true, trappingBattlerId: opponentId, unmodelled: [] }
      }
    }
  }
  return none
}

/** CanBattlerEscape, src/battle_util.c:4836-4858 (no ability check). B_GHOSTS_ESCAPE >= GEN_6. */
export function canBattlerEscape(state: BattleState, battlerId: number, deps: EscapeDeps): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return true
  if (battler.volatiles.skyDropped) return false
  if (deps.grounding.holdEffectOf(battlerId) === 'HOLD_EFFECT_SHED_SHELL') return true
  if (!battler.mon.types.includes('GHOST') && hasFlag(battler.mon.status2, STATUS2_ESCAPE_PREVENTION | STATUS2_WRAPPED)) return false
  if (hasFlag(battler.statuses4, STATUS4_COMMANDED)) return false
  if (hasFlag(battler.statuses3, STATUS3_ROOTED)) return false
  if (hasFlag(state.field.statuses, STATUS_FIELD_FAIRY_LOCK)) return false
  if ((battlerId & 1) === B_SIDE_PLAYER && deps.grounding.monotypeChampType === 'FIGHTING') return false
  if (battler.volatiles.fear) return false
  return true
}
