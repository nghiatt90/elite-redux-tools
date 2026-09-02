// ON_ABILITY's iteration order and the apply-on-flag filters, ported from
// include/battle_util.h:275-292 and src/abilities.cc:176-198.

import type { AbilityEntry, AbilityImpl, ApplyOnField } from './types'
import { isUnmodelled } from './types'
import { lookupAbility } from './registry'

/** A battler's four ability slots in the C's own storage order: slot 0 is the
 * chosen ability (`GetAbilityBySpecies`), slots 1-3 are the species' three innates
 * (`GetInnateInSlot`) -- src/battle_util.c:9315-9331 (RepopulateAbilities). A slot
 * holding `null` means "no ability here" (an innate not yet unlocked at this
 * level/difficulty, or fewer than 3 innates on this species). */
export interface AbilitySlots {
  ability: string | null
  innates: [string | null, string | null, string | null]
}

function slotIds(slots: AbilitySlots): (string | null)[] {
  return [slots.ability, ...slots.innates]
}

/**
 * ON_ABILITY, include/battle_util.h:275-281 -- iterates slots in REVERSE (innate3 ->
 * innate2 -> innate1 -> ability), running `fn` for every non-suppressed, non-null
 * slot. Accumulating hooks (onOffensiveMultiplier, onStat, ...) never return
 * 'break' and so every qualifying slot runs, each mutation re-quantizing in turn;
 * "first-wins" hooks (onStab, onSwapSplit, adaptability's flag check) return
 * 'break' from the first slot that qualifies, matching the highest-index innate
 * winning ties in the C.
 */
export function forEachAbility(
  slots: AbilitySlots,
  isSuppressed: (id: string, impl: AbilityEntry) => boolean,
  fn: (impl: AbilityImpl, id: string, slotIndex: number) => 'break' | void,
): void {
  const ids = slotIds(slots)
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = ids[i]
    if (!id) continue
    const entry = lookupAbility(id)
    if (!entry || isUnmodelled(entry)) continue
    if (isSuppressed(id, entry)) continue
    if (fn(entry, id, i) === 'break') return
  }
}

/** BattlerHasAbility, src/battle_util.c:9305-9313 -- does ANY of the battler's four
 * slots hold this exact ability (and is it not suppressed)? `checkMoldBreaker` picks
 * which suppression rule set applies -- most callers pass `true` (BATTLER_HAS_ABILITY);
 * a few explicitly ignore Mold Breaker by passing `false` (e.g. Grip Pincer's wrap
 * check in CalcDefenseStat). */
export function battlerHasAbility(slots: AbilitySlots, abilityId: string, isSuppressed: (id: string) => boolean): boolean {
  return slotIds(slots).some((id) => id === abilityId && !isSuppressed(id))
}

/**
 * IsApplyOnFlagAppropriate, src/abilities.cc:176-184 -- the self/ally/foe filter used
 * by onOffensiveMultiplierFor and onStatFor. Simplified for a singles-only engine:
 * `isSelf` is true when the ability's battler IS the context battler (the move's
 * user, for offensive hooks); `isFoe` is true when they're on opposing sides. The
 * "ally" branch can never fire in singles (no ally battler exists) and is included
 * only so this reads the same as the four-way C switch.
 */
export function isApplyOnFlagAppropriate(isSelf: boolean, isFoe: boolean, flag: ApplyOnField = 'APPLY_ON_SELF'): boolean {
  if (flag === 'APPLY_ON_SELF') return isSelf
  if (isSelf) return true // APPLY_IGNORE_SELF bit not modelled -- no v1-relevant ability sets it differently
  if (isFoe) return flag === 'APPLY_ON_FOE'
  return flag === 'APPLY_ON_ALLY'
}

/**
 * IsTargettedApplyOnFlagAppropriate, src/abilities.cc:169-175 -- the
 * attacker/target-relative filter used by onCritFor, onAfterTypeEffectivenessFor,
 * and onChooseDefensiveStatFor. Falls back to isApplyOnFlagAppropriate for the
 * self/ally/foe flag values it doesn't have its own case for.
 */
export function isTargettedApplyOnFlagAppropriate(
  sourceIsAttacker: boolean,
  sourceIsTarget: boolean,
  isSelf: boolean,
  isFoe: boolean,
  flag: ApplyOnField = 'APPLY_ON_SELF',
): boolean {
  if (flag === 'APPLY_ON_ATTACKER_OR_TARGET') return sourceIsAttacker || sourceIsTarget
  if (flag === 'APPLY_ON_ATTACKER') return sourceIsAttacker
  if (flag === 'APPLY_ON_TARGET') return sourceIsTarget
  return isApplyOnFlagAppropriate(isSelf, isFoe, flag)
}
