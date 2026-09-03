// Generic lazy delegation for the ~122 abilities whose entire damage-relevant hook
// set is `.onX = Impl<ABILITY_OTHER>.onX` in the C (abilityHooks.json's "alias"
// form). Each helper here returns a hook function that looks up the target ability
// AT CALL TIME (not at module-load time), so batch import order never matters and a
// target ported in a LATER batch still resolves correctly for an alias registered
// earlier. If the target isn't ported yet (still an UnmodelledAbility stub), the
// delegate is a safe no-op -- identical to the target's own current (unmodelled)
// behavior, and it starts working automatically the moment the target is ported.

import { lookupAbility } from '../registry'
import { isUnmodelled } from '../types'
import type {
  OffensiveMultiplierContext,
  DefensiveMultiplierContext,
  OnStatContext,
  OnStabContext,
  OnCritContext,
  OnTypeEffectivenessContext,
  OnAfterTypeEffectivenessContext,
  OnChooseOffensiveStatContext,
  OnChooseDefensiveStatContext,
  OnSwapSplitContext,
  OnMoveTypeContext,
  OnMoldBreakerContext,
} from '../types'

export function aliasOffensiveMultiplier(target: string) {
  return (ctx: OffensiveMultiplierContext): void => {
    const t = lookupAbility(target)
    if (t && !isUnmodelled(t)) t.onOffensiveMultiplier?.(ctx)
  }
}

export function aliasDefensiveMultiplier(target: string) {
  return (ctx: DefensiveMultiplierContext): void => {
    const t = lookupAbility(target)
    if (t && !isUnmodelled(t)) t.onDefensiveMultiplier?.(ctx)
  }
}

export function aliasStat(target: string) {
  return (ctx: OnStatContext): void => {
    const t = lookupAbility(target)
    if (t && !isUnmodelled(t)) t.onStat?.(ctx)
  }
}

export function aliasStab(target: string) {
  return (ctx: OnStabContext): boolean => {
    const t = lookupAbility(target)
    return t && !isUnmodelled(t) ? (t.onStab?.(ctx) ?? false) : false
  }
}

export function aliasCrit(target: string) {
  return (ctx: OnCritContext): number => {
    const t = lookupAbility(target)
    return t && !isUnmodelled(t) ? (t.onCrit?.(ctx) ?? 0) : 0
  }
}

export function aliasTypeEffectiveness(target: string) {
  return (ctx: OnTypeEffectivenessContext): void => {
    const t = lookupAbility(target)
    if (t && !isUnmodelled(t)) t.onTypeEffectiveness?.(ctx)
  }
}

export function aliasAfterTypeEffectiveness(target: string) {
  return (ctx: OnAfterTypeEffectivenessContext): void => {
    const t = lookupAbility(target)
    if (t && !isUnmodelled(t)) t.onAfterTypeEffectiveness?.(ctx)
  }
}

export function aliasChooseOffensiveStat(target: string) {
  return (ctx: OnChooseOffensiveStatContext): void => {
    const t = lookupAbility(target)
    if (t && !isUnmodelled(t)) t.onChooseOffensiveStat?.(ctx)
  }
}

export function aliasChooseDefensiveStat(target: string) {
  return (ctx: OnChooseDefensiveStatContext): void => {
    const t = lookupAbility(target)
    if (t && !isUnmodelled(t)) t.onChooseDefensiveStat?.(ctx)
  }
}

export function aliasSwapSplit(target: string) {
  return (ctx: OnSwapSplitContext): boolean => {
    const t = lookupAbility(target)
    return t && !isUnmodelled(t) ? (t.onSwapSplit?.(ctx) ?? false) : false
  }
}

export function aliasMoveType(target: string) {
  return (ctx: OnMoveTypeContext): void => {
    const t = lookupAbility(target)
    if (t && !isUnmodelled(t)) t.onMoveType?.(ctx)
  }
}

export function aliasMoldBreaker(target: string) {
  return (ctx: OnMoldBreakerContext): boolean => {
    const t = lookupAbility(target)
    return t && !isUnmodelled(t) ? (t.onMoldBreaker?.(ctx) ?? false) : false
  }
}
