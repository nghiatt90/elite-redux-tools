// Typed hook signatures for the ability registry, mirroring include/abilities.hh's
// function-pointer fields on `struct Ability`. The C passes positional arguments and
// an out-param `modifier`/`stat`/etc.; here each hook takes one named context object
// and MUTATES a small typed accumulator on it (`ctx.modifier`, `ctx.stat`), matching
// the C's `MUL_MODIFIER(modifier, val)` / `*stat *= n` idiom closely enough that a
// port reads like the original macro calls (see abilities/macros.ts).
//
// Only a subset of struct Ability's ~40 hook fields are declared here: the ones
// abilityHooks.json's damage-relevance census actually needs (see
// ability_hooks.py's _DAMAGE_HOOKS). Non-damage hooks (onEntry, onWeather, ...) have
// no reason to exist in a damage calculator's registry.

import type { BattleStatKey } from '../types'

/** MUL_MODIFIER(modifier, val) / RESISTANCE(val)'s target -- `resistance` is tracked
 * on the accumulator for signature fidelity but never read by the engine (the real
 * damage call site passes `&ignored` for it, src/battle_util.c:7531 -- verified), so
 * RESISTANCE and MUL are equivalent here; ports may use either. */
export interface ModifierAccumulator {
  modifier: number // UQ_4_12
  resistance: number // UQ_4_12, unused by damage math -- present for signature fidelity only
}

export interface OffensiveMultiplierContext extends ModifierAccumulator {
  attackerId: string // ability's own battler (may be an ally, not necessarily the move's user -- CalculateAbilityMultipliers loops all battlers)
  moveUserId: string // the battler actually using the move (battlerAtk in the C)
  defenderId: string
  moveId: string
  moveType: string
  /** CalcMoveBasePower's PRE-modifier value (:7531-7533) -- Technician reads this,
   * not the fully-modified power used in the main damage equation. */
  basePower: number
  typeEffectiveness: number // UQ_4_12
  isCrit: boolean
}

export interface DefensiveMultiplierContext extends ModifierAccumulator {
  defenderId: string // the ability's own battler == the move's target here
  attackerId: string
  moveId: string
  moveType: string
  typeEffectiveness: number // UQ_4_12
  isCrit: boolean
}

export interface OnStatContext {
  battlerId: string
  statId: BattleStatKey
  moveId: string
  stat: number // read/write -- ports mutate this directly (`ctx.stat = ...`)
  flags: { nonStackingRuin: boolean } // NonStackingState -- Ruin abilities only
}

export interface OnStabContext {
  battlerId: string
  moveType: string
}

export interface OnCritContext {
  battlerId: string // whose ability this is (attacker OR defender side -- onCrit runs for both)
  defenderId: string
  moveId: string
  typeEffectiveness: number // UQ_4_12
}

export interface OnTypeEffectivenessContext {
  attackerId: string
  defenderId: string
  moveId: string
  moveType: string
  modifier: number // UQ_4_12, read/write -- a full override, not an accumulated multiply
}

export interface OnAfterTypeEffectivenessContext {
  attackerId: string
  defenderId: string
  moveId: string
  moveType: string
  modifier: number // UQ_4_12, read/write
  perTypeModifiers: [number, number, number] // modifier1/2/3 from the three-type fold, read-only
}

export interface OnChooseOffensiveStatContext {
  battlerId: string
  moveId: string
  isCrit: boolean
  isUnaware: boolean
  statToUse: BattleStatKey // read/write
  secondaryStat: Partial<Record<BattleStatKey, number>> // read/write
}

export interface OnChooseDefensiveStatContext {
  attackerId: string
  defenderId: string
  moveId: string
  noPositiveStatStages: boolean
  isUnaware: boolean
  statToUse: BattleStatKey // read/write
  secondaryStat: Partial<Record<BattleStatKey, number>> // read/write
}

export interface OnSwapSplitContext {
  battlerId: string
  moveId: string
  moveType: string
}

export interface OnMoveTypeContext {
  battlerId: string
  moveId: string
  moveType: string // read/write -- "-ate" abilities overwrite this
  ateBoost: boolean // read/write
}

export interface OnRecoilContext {
  battlerId: string
  damage: number
  moveType: string
}

export type OnOffensiveMultiplier = (ctx: OffensiveMultiplierContext) => void
export type OnDefensiveMultiplier = (ctx: DefensiveMultiplierContext) => void
export type OnStat = (ctx: OnStatContext) => void
/** onStab returns true when this ability grants pseudo-STAB for moveType (e.g. the
 * "-ate" abilities' partner hook, Aura abilities, Protean-likes) -- NOT whether the
 * battler already has STAB by typing (that's the plain species-type check). */
export type OnStab = (ctx: OnStabContext) => boolean
/** onCrit returns a stage delta to ADD to the running crit chance, or NEVER_CRIT
 * (from ../crit.ts) to force no-crit outright, matching the C's early-return case. */
export type OnCrit = (ctx: OnCritContext) => number
export type OnTypeEffectiveness = (ctx: OnTypeEffectivenessContext) => void
export type OnAfterTypeEffectiveness = (ctx: OnAfterTypeEffectivenessContext) => void
export type OnChooseOffensiveStat = (ctx: OnChooseOffensiveStatContext) => void
export type OnChooseDefensiveStat = (ctx: OnChooseDefensiveStatContext) => void
/** onSwapSplit returns true to flip the move's damage category. */
export type OnSwapSplit = (ctx: OnSwapSplitContext) => boolean
export type OnMoveType = (ctx: OnMoveTypeContext) => void
export type OnRecoil = (ctx: OnRecoilContext) => void

export type ApplyOnField =
  | 'APPLY_ON_SELF'
  | 'APPLY_ON_ALLY'
  | 'APPLY_ON_FOE'
  | 'APPLY_ON_ATTACKER_OR_TARGET'
  | 'APPLY_ON_ATTACKER'
  | 'APPLY_ON_TARGET'

export interface AbilityFlags {
  adaptability: boolean
  unaware: boolean
  breakable: boolean
  levitate: boolean
  omniStab: boolean
  skillLink: boolean
  fortKnox: boolean
  resistsFortKnox: boolean
  magicGuard: boolean
  noRecoil: boolean
  halfRecoil: boolean
  foesMinRoll: boolean
  megaLauncherBoost: boolean
  noDamageHits: number
  ruinStat: number
  negatesBurnAtkDrop: boolean
  negatesFrzSpatkDrop: boolean
  noBurnDamage: boolean
}

export interface AbilityImpl {
  id: string
  /** Mandatory citation, e.g. "src/abilities.cc:4812" -- every port must name the
   * exact block it was transcribed from, both for review and so the coverage test
   * can cross-check it against abilityHooks.json's own sourceLine. */
  src: string
  flags?: Partial<AbilityFlags>
  addsType?: string // bare type name
  applyOn?: Partial<Record<'onOffensiveMultiplierFor' | 'onCritFor' | 'onAfterTypeEffectivenessFor' | 'onChooseDefensiveStatFor', ApplyOnField>>
  onOffensiveMultiplier?: OnOffensiveMultiplier
  onDefensiveMultiplier?: OnDefensiveMultiplier
  onStat?: OnStat
  onStab?: OnStab
  onCrit?: OnCrit
  onTypeEffectiveness?: OnTypeEffectiveness
  onAfterTypeEffectiveness?: OnAfterTypeEffectiveness
  onChooseOffensiveStat?: OnChooseOffensiveStat
  onChooseDefensiveStat?: OnChooseDefensiveStat
  onSwapSplit?: OnSwapSplit
  onMoveType?: OnMoveType
  onRecoil?: OnRecoil
}

export interface UnmodelledAbility {
  id: string
  src: string
  /** Why this damage-relevant ability has no port yet -- required, shown to users. */
  unmodelled: string
}

export type AbilityEntry = AbilityImpl | UnmodelledAbility

export function isUnmodelled(entry: AbilityEntry): entry is UnmodelledAbility {
  return 'unmodelled' in entry
}
