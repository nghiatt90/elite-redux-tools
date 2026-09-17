// GetMovePriority's ability contribution, src/battle_main.c:4264:
//
//   ON_ABILITY(battlerId, FALSE, gAbilities[ability].onPriority,
//              priority += gAbilities[ability].onPriority(battlerId, target, move))
//
// Two details of that macro matter and are easy to lose:
//
//   - It ACCUMULATES. Unlike the "first slot wins" hooks (onStab, onSwapSplit),
//     every qualifying slot's delta is added, so a mon holding two priority
//     abilities gets both. forEachAbility's callback returning nothing rather
//     than 'break' is what preserves that.
//   - checkMoldBreaker is FALSE, so NEVER_SUPPRESSED is the right predicate --
//     the same choice dispatchCalc makes for every other FALSE call site. Gastro
//     Acid and Neutralizing Gas suppression (IsSuppressed's other half,
//     src/battle_util.c:9254-9258) is not modelled anywhere in this engine yet;
//     this follows that existing gap rather than opening a new one.
//
// This lives outside dispatchCalc.ts because it is not part of the damage path:
// nothing here reaches a damage number, and dispatchCalc's module doc scopes it
// to calculate.ts's fold.

import type { AbilitySlots } from './dispatch'
import { forEachAbility } from './dispatch'
import { isIronFistBoosted } from './dispatchCalc'
// Populates the registry. dispatchCalc does NOT do this -- its consumers are
// React routes (DamageCalculator.tsx, TrainerMatchup.tsx), which import it
// themselves. The sim has no route, so without this a headless caller gets an
// empty registry, every onPriority hook silently contributes 0, and the turn
// order is wrong with nothing to notice it through. That is the same failure
// shape as a seam defaulting to the wrong answer, so the dependency is made
// local to the module whose correctness needs it rather than left to callers.
import './impl/index'
import type { OnPriorityContext } from './types'

/** IsSuppressed(battler, ability, checkMoldBreaker=FALSE) -- battle_main.c:4264
 * passes FALSE, so the Mold Breaker half never applies. Declared locally rather
 * than imported because dispatchCalc keeps its own copy private. */
const NEVER_SUPPRESSED = (): boolean => false

/** Everything getMovePriority knows about the move and the two battlers, minus
 * the precomputed fields this module derives itself. */
export interface PriorityDispatchInputs {
  battlerId: string
  holderSlots: AbilitySlots
  moveId: string
  /** GetTypeBeforeUsingMove's result -- the RESOLVED type, not the declared one. */
  moveType: string
  movePower: number
  movePriority: number
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
  moveFlags: Record<string, true>
  holderHp: number
  holderMaxHp: number
  targetHp: number | null
  targetMaxHp: number | null
}

/** Sums every ability slot's onPriority delta. Returns 0 when the holder has no
 * priority abilities, which is the overwhelmingly common case. */
export function computeAbilityPriorityBonus(inputs: PriorityDispatchInputs): number {
  const ctx: OnPriorityContext = {
    battlerId: inputs.battlerId,
    moveType: inputs.moveType,
    moveId: inputs.moveId,
    movePower: inputs.movePower,
    movePriority: inputs.movePriority,
    isStatus: inputs.moveSplit === 'STATUS',
    moveFlags: inputs.moveFlags,
    moveSplit: inputs.moveSplit,
    // BATTLER_MAX_HP, include/battle.h:749.
    holderAtMaxHp: inputs.holderHp === inputs.holderMaxHp,
    isIronFistBoosted: isIronFistBoosted(inputs.holderSlots, inputs.moveFlags, inputs.moveSplit),
    targetHp: inputs.targetHp,
    targetMaxHp: inputs.targetMaxHp,
  }

  let total = 0
  forEachAbility(inputs.holderSlots, NEVER_SUPPRESSED, (impl) => {
    if (!impl.onPriority) return
    total += impl.onPriority(ctx)
  })
  return total
}
