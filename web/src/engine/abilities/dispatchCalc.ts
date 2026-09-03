// Wires the ability registry into the damage calculation -- the actual
// CalculateAbilityMultipliers/CalculateStat/StabMultiplierInHalves/
// CalcCritChanceStage loops (src/battle_util.c:6964-6993, 7195-7202,
// 7469-7481; src/battle_script_commands.c:1529-1536), built from the primitives
// in dispatch.ts/applyOn.ts and the AbilityImpl hooks in the registry.

import { uq } from '../fixed'
import { NEVER_CRIT } from '../crit'
import { isApplyOnFlagAppropriate, isTargettedApplyOnFlagAppropriate } from './applyOn'
import type { AbilitySlots } from './dispatch'
import { forEachAbility } from './dispatch'
import { lookupAbility } from './registry'
import { isUnmodelled } from './types'
import type { DefensiveMultiplierContext, OffensiveMultiplierContext, OnCritContext, OnMoveTypeContext, OnStatContext } from './types'

// v1 has no Mold Breaker / Neutralizing Gas / Gastro Acid modelling yet -- every
// ability's `breakable` flag is simply never suppressed. Isolated into one function
// so wiring that in later touches one place, not every call site below.
function isSuppressed(): boolean {
  return false
}

/** HasFortKnox, referenced by CalculateAbilityMultipliers (:6968) -- true if the
 * defender holds an (unsuppressed) ability with the fortKnox flag. */
export function hasFortKnox(defenderSlots: AbilitySlots): boolean {
  let found = false
  forEachAbility(defenderSlots, isSuppressed, (impl) => {
    if (impl.flags?.fortKnox) {
      found = true
      return 'break'
    }
  })
  return found
}

/** Whether ANY of a battler's (unsuppressed) abilities has the given boolean flag --
 * Adaptability, Unaware, Levitate, etc. are all "does this battler have the flag
 * anywhere in its 4 slots" checks in the C (RETURN_ABILITY_IF_FLAG). */
export function hasFlag(slots: AbilitySlots, flag: 'adaptability' | 'unaware' | 'magicGuard' | 'noRecoil' | 'halfRecoil' | 'skillLink'): boolean {
  let found = false
  forEachAbility(slots, isSuppressed, (impl) => {
    if (impl.flags?.[flag]) {
      found = true
      return 'break'
    }
  })
  return found
}

type OffensiveCtxInputs = Omit<OffensiveMultiplierContext, 'modifier' | 'resistance'>
type DefensiveCtxInputs = Omit<DefensiveMultiplierContext, 'modifier' | 'resistance'>

/**
 * CalculateAbilityMultipliers, src/battle_util.c:6964-6993 -- ONE shared modifier
 * accumulator threaded through both the offensive loop (every battler on the field;
 * here, attacker and defender, the only two that exist in singles, each gated by
 * IsApplyOnFlagAppropriate relative to the MOVE'S USER -- see
 * OffensiveMultiplierContext's doc comment -- and skipped entirely if the defender
 * HasFortKnox) and the defensive hook (the defender's own abilities only, no
 * apply-on-flag check at all). Kept as one function rather than two, because
 * MulModifier re-quantizes at every call: computing the offensive and defensive
 * results independently and then combining them would NOT equal accumulating both
 * into the same running modifier, which is what the C actually does.
 */
export function computeAbilityMultiplier(attackerSlots: AbilitySlots, defenderSlots: AbilitySlots, offensive: OffensiveCtxInputs, defensive: DefensiveCtxInputs): number {
  // ONE plain mutable object, structurally satisfying both context interfaces (each
  // hook only ever reads its own declared fields, and both write the same shared
  // `modifier`/`resistance`) -- this is what makes the accumulator genuinely shared
  // across the offensive and defensive phases, rather than two independent objects
  // that happen to start from the same uq(1.0).
  const shared = { ...offensive, ...defensive, modifier: uq(1.0), resistance: uq(1.0) }

  if (!hasFortKnox(defenderSlots)) {
    forEachAbility(attackerSlots, isSuppressed, (impl) => {
      if (!impl.onOffensiveMultiplier) return
      if (!isApplyOnFlagAppropriate(true, false, impl.applyOn?.onOffensiveMultiplierFor)) return
      impl.onOffensiveMultiplier(shared)
    })
    forEachAbility(defenderSlots, isSuppressed, (impl) => {
      if (!impl.onOffensiveMultiplier) return
      if (!isApplyOnFlagAppropriate(false, false, impl.applyOn?.onOffensiveMultiplierFor)) return
      impl.onOffensiveMultiplier(shared)
    })
  }

  forEachAbility(defenderSlots, isSuppressed, (impl) => {
    impl.onDefensiveMultiplier?.(shared)
  })

  return shared.modifier
}

type OnStatInputs = Omit<OnStatContext, 'stat' | 'flags'>

/**
 * CalculateStat's onStat loop (:7195-7202): both battlers' abilities can modify
 * either battler's stat, gated by onStatFor relative to the STAT OWNER (not the
 * ability holder). Returns a `preModify`-shaped function ready to compose with
 * battleStat.ts's other pre-modifiers.
 */
export function computeOnStatModifier(statOwnerSlots: AbilitySlots, otherSlots: AbilitySlots, inputs: OnStatInputs) {
  return (stat: number): number => {
    const ctx: OnStatContext = { ...inputs, stat, flags: { nonStackingRuin: false } }
    forEachAbility(statOwnerSlots, isSuppressed, (impl) => {
      if (!impl.onStat) return
      if (!isApplyOnFlagAppropriate(true, false, impl.applyOn?.onStatFor)) return
      impl.onStat(ctx)
    })
    forEachAbility(otherSlots, isSuppressed, (impl) => {
      if (!impl.onStat) return
      // The other battler's ability, relative to the stat owner: never self, never
      // an ally (no ally battler exists in singles) -- always the "foe" branch.
      if (!isApplyOnFlagAppropriate(false, false, impl.applyOn?.onStatFor)) return
      impl.onStat(ctx)
    })
    return ctx.stat
  }
}

/**
 * StabMultiplierInHalves' onStab loop (:7473-7476) -- first ability (reverse slot
 * order) that returns true grants pseudo-STAB, matching the C's break-on-first-hit.
 * Adaptability itself is a separate flag check, not an onStab hook -- see hasFlag.
 */
/**
 * GetMoveTypeInternal's onMoveType loop (src/battle_main.c:5210-5211) -- the "-ate"
 * abilities. The C only overrides the type when the move's ORIGINAL type is Normal
 * (`CHECK(moveType == TYPE_NORMAL)` inside the ATE_ABILITY macro, src/abilities.cc:
 * 295-301) and, per ON_ABILITY's reverse-slot iteration plus the C's bare `return`
 * on the first hit, the first ability (innate3 -> ... -> ability) that actually
 * changes the type wins -- ties can't occur in practice since real movesets never
 * carry two "-ate" abilities on the same mon, but the semantics are ported exactly
 * regardless. Ability holder is always the ATTACKER (`checkMoldBreaker = FALSE`
 * ON_ABILITY call, no cross-battler loop, unlike onOffensiveMultiplier/onCrit).
 */
export function resolveEffectiveMoveType(
  attackerSlots: AbilitySlots,
  moveId: string,
  moveType: string,
  moveFlags: Record<string, true> = {},
): { moveType: string; ateBoost: boolean } {
  if (moveType !== 'NORMAL') return { moveType, ateBoost: false }
  let resolved = moveType
  let ateBoost = false
  forEachAbility(attackerSlots, isSuppressed, (impl) => {
    if (!impl.onMoveType) return
    const ctx: OnMoveTypeContext = { battlerId: 'attacker', moveId, moveType, ateBoost: false, moveFlags }
    impl.onMoveType(ctx)
    if (ctx.moveType !== moveType) {
      resolved = ctx.moveType
      ateBoost = ctx.ateBoost
      return 'break'
    }
  })
  return { moveType: resolved, ateBoost }
}

export function hasStabOverride(attackerSlots: AbilitySlots, moveType: string): boolean {
  let granted = false
  forEachAbility(attackerSlots, isSuppressed, (impl) => {
    if (!impl.onStab) return
    if (impl.onStab({ battlerId: 'attacker', moveType })) {
      granted = true
      return 'break'
    }
  })
  return granted
}

type OnCritInputs = Omit<OnCritContext, 'battlerId'>

/**
 * CalcCritChanceStage's onCrit loop (src/battle_script_commands.c:1529-1536) -- runs
 * across both battlers, filtered by IsTargettedApplyOnFlagAppropriate relative to the
 * ATTACKER (the C's fixed `contextBattler` is always battlerAtk here, regardless of
 * which battler's ability is being checked -- unlike onOffensiveMultiplier, `battler`
 * in the hook body IS the real ability holder, so the two facts are independent).
 * Accumulates a stage bonus; any hook returning NEVER_CRIT short-circuits the whole
 * calculation immediately, matching the C's early return.
 */
export function computeAbilityCritBonus(attackerSlots: AbilitySlots, defenderSlots: AbilitySlots, inputs: OnCritInputs): number {
  let bonus = 0
  let blocked = false
  const run = (slots: AbilitySlots, battlerId: string, sourceIsAttacker: boolean, sourceIsTarget: boolean) => {
    forEachAbility(slots, isSuppressed, (impl) => {
      if (blocked || !impl.onCrit) return
      if (!isTargettedApplyOnFlagAppropriate(sourceIsAttacker, sourceIsTarget, sourceIsAttacker, false, impl.applyOn?.onCritFor)) return
      const result = impl.onCrit({ battlerId, ...inputs })
      if (result === NEVER_CRIT) {
        blocked = true
        return 'break'
      }
      bonus += result
    })
  }
  run(attackerSlots, 'attacker', true, false)
  if (!blocked) run(defenderSlots, 'defender', false, true)
  return blocked ? NEVER_CRIT : bonus
}

/** Whether a slot's registered entry (if any) is a real port, used by callers that
 * want to know if "no ability selected" vs "ability selected but unmodelled". */
export function abilityCoverageNote(id: string | null): string | null {
  if (!id) return null
  const entry = lookupAbility(id)
  if (!entry) return `${id}: not in the ability manifest at all (may be non-damage-relevant)`
  if (isUnmodelled(entry)) return `${id}: ${entry.unmodelled}`
  return null
}
