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

/**
 * IMPORTANT, verified against src/battle_util.c:6969-6977's call site: even though
 * CalculateAbilityMultipliers loops over every battler on the field looking for one
 * whose ability defines onOffensiveMultiplier, the hook body is always called as
 * `onOffensiveMultiplier(battlerAtk, ability, battlerDef, ...)` -- i.e. `battlerId`
 * below is ALWAYS the move's actual user, never the (possibly different) battler
 * whose ability slot is being checked. This is what lets Plus/Minus-style
 * ally-boosting abilities work: the hook body checks `BATTLE_PARTNER(battlerId)`
 * (the MOVE USER's partner) rather than needing its own identity at all -- whether
 * the hook fires in the first place is decided separately by
 * IsApplyOnFlagAppropriate(battlerAtk, sourceBattler, ...for) before this is ever
 * called. Ports for ally-boosting abilities are therefore inert in this v1 singles
 * engine (no ally battler exists), which is fine -- they simply never fire, matching
 * the real mechanic's own precondition.
 */
export interface OffensiveMultiplierContext extends ModifierAccumulator {
  battlerId: string // the move's user (battlerAtk) -- see note above, NOT necessarily the ability holder
  defenderId: string
  moveId: string
  moveType: string
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS' // post-swap split (IS_MOVE_PHYSICAL/IS_MOVE_SPECIAL)
  moveFlags: Record<string, true> // gBattleMoves[move].flags -- moves.json's own `flags` shape
  /** CalcMoveBasePower's PRE-modifier value (:7531-7533) -- Technician reads this,
   * not the fully-modified power used in the main damage equation. */
  basePower: number
  typeEffectiveness: number // UQ_4_12
  isCrit: boolean
  /** HasAnyStatusOrAbility(battlerId), src/battle_util.c:9278-9283 -- despite the
   * name, no ability check at all: major status1, Comatose, or Blood Stain. (The C
   * itself has `status1 && STATUS1_ANY` -- a logical-AND typo where a bitwise-AND was
   * clearly meant -- but since status1's only bits ARE major-status bits, `status1 !=
   * 0` and `status1 & STATUS1_ANY` agree in every reachable case, so this is ported
   * as the intended check rather than replicating a no-op typo.) */
  attackerHasAnyStatus: boolean
  attackerHp: number
  attackerMaxHp: number
  /** True when the attacker's action resolves before the defender's this turn
   * (DamageContext's own attackerActsFirst, threaded through -- see its doc there
   * for why this is a UI-level fact rather than something derived). */
  attackerActsFirst: boolean
  weather: string // FieldBattleState['weather'], same bare kind as DefensiveMultiplierContext's
  defenderTypes: string[] // IS_BATTLER_OF_TYPE(target, ...) checks -- 1-3 bare type names
  attackerStatus1: Set<string> // gBattleMons[battler].status1 bare flags -- mirrors OnCritContext's defenderStatus1
  sameMoveTurnsInARow: number // gBattleStruct->sameMoveTurns[battler] -- Rhythmic
  terrain: string | null // ConditionFieldContext['terrain'] -- bare TERRAIN_* name, or null
  movePriority: number // GetMovePriority(...) -- the move's own declared priority; ability-adjusted priority (Prankster etc.) isn't modelled
}

export interface DefensiveMultiplierContext extends ModifierAccumulator {
  defenderId: string // the ability's own battler == the move's target here
  attackerId: string
  moveId: string
  moveType: string
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
  moveFlags: Record<string, true>
  typeEffectiveness: number // UQ_4_12
  isCrit: boolean
  weather: string // FieldBattleState['weather'] -- ER's bare weather kind, e.g. 'HAIL'
  defenderAtMaxHp: boolean // BATTLER_MAX_HP(battler), include/battle.h:752
  attackerActsFirst: boolean // see OffensiveMultiplierContext's doc on the same field
  defenderTypes: string[] // IS_BATTLER_OF_TYPE(battler, ...) -- the ability holder's OWN types (== the move's target here)
}

export interface OnStatContext {
  battlerId: string
  statId: BattleStatKey
  moveId: string
  stat: number // read/write -- ports mutate this directly (`ctx.stat = ...`)
  flags: { nonStackingRuin: boolean } // NonStackingState -- Ruin abilities only
  weather: string // FieldBattleState's bare weather kind
  terrain: string | null
  hp: number // the STAT OWNER's hp/maxHp (not necessarily the attacker -- onStat runs for either battler's stat calc)
  maxHp: number
  hasAnyStatus: boolean // HasAnyStatusOrAbility(battler) -- see OffensiveMultiplierContext's doc on the same check
  status1: Set<string> // gBattleMons[battler].status1 bare flags, for a SPECIFIC status check (e.g. Flare Boost's burn)
  /** GetHighestAttackingStatId(battler) == statId -- compares raw Atk vs SpAtk;
   * ties favor 'atk', matching this port's tie-break choice (not independently
   * verified against the C's own tie-break, which the source doesn't make explicit
   * at a glance). */
  isHighestAttackingStat: boolean
  /** GetHighestStatId(battler) == statId -- compares all 5 raw stats; ties favor
   * whichever is checked first in BattleStatKey order (same caveat as above). */
  isHighestStat: boolean
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
  // Merciless's own condition set -- the target's (move's target, i.e. the
  // defender's) status/stat-stage/item facts. Not filled in for the abilities
  // ported so far except Merciless.
  defenderStatus1: Set<string>
  defenderSpeedStageNegative: boolean
  defenderResolvedHoldEffect: string | null
  moveFlags: Record<string, true> // Hyper Cutter/Precise Fist need contact/punchBased
  basePower: number // Perfectionist's <=50-and-nonzero check -- CalcMoveBasePower's PRE-modifier value
  attackerActsFirst: boolean // Strategic Pause's turn-order check
}

export interface OnTypeEffectivenessContext {
  attackerId: string
  defenderId: string
  moveId: string
  moveType: string
  modifier: number // UQ_4_12, read/write -- a full override, not an accumulated multiply
  /** The SINGLE defending type currently being folded (this hook runs once per
   * component of the defender's up-to-3 types, src/battle_util.c's three-type
   * fold) -- bare type name, e.g. 'STEEL'. Not `defenderTypes` (the whole list). */
  defType: string
}

export interface OnAfterTypeEffectivenessContext {
  attackerId: string
  defenderId: string
  moveId: string
  moveType: string
  modifier: number // UQ_4_12, read/write
  perTypeModifiers: [number, number, number] // modifier1/2/3 from the three-type fold, read-only
  defenderTypes: string[] // IS_BATTLER_OF_TYPE(target, ...) checks -- e.g. Steelworker
  weather: string
  targetGrounded: boolean // !IsBattlerGroundedIgnoreType(target) checks -- BattlerBattleState's own `isGrounded`
  defenderAtMaxHp: boolean // BATTLER_MAX_HP(target)
}

export interface OnChooseOffensiveStatContext {
  battlerId: string
  moveId: string
  isCrit: boolean
  isUnaware: boolean
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
  moveFlags: Record<string, true>
  /** GetHighestAttackingStatId(battler)==STAT_ATK -- an approximation of Equinox's
   * own fully-computed-stat comparison, reusing the same raw-stat comparison (and
   * tie-break choice) as OffensiveMultiplierContext's own field of the same name. */
  isHighestAttackingStat: boolean
  statToUse: BattleStatKey // read/write
  secondaryStat: Partial<Record<BattleStatKey, number>> // read/write -- NOT consumed by calculate.ts yet (see dispatchCalc.ts's note)
}

export interface OnChooseDefensiveStatContext {
  attackerId: string
  defenderId: string
  moveId: string
  noPositiveStatStages: boolean
  isUnaware: boolean
  isCrit: boolean
  moveFlags: Record<string, true>
  defenderHasAnyStatus: boolean
  /** Approximates Deadeye/Exploit Weakness/Roundhouse's own fully-computed
   * Def-vs-SpDef comparison using RAW stats (same simplification as
   * isHighestAttackingStat elsewhere). Each picks the WEAKER of the two to attack
   * through (`if (def<spdef) DEF; else if (spdef<def) SPDEF;`) -- 'equal' when
   * neither is strictly lower. */
  defenderDefComparison: 'def' | 'spdef' | 'equal'
  statToUse: BattleStatKey // read/write
  secondaryStat: Partial<Record<BattleStatKey, number>> // read/write -- NOT consumed by calculate.ts yet (see dispatchCalc.ts's note)
}

export interface OnSwapSplitContext {
  battlerId: string
  moveId: string
  moveType: string
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS' // pre-swap split -- these hooks decide WHETHER to swap it
  moveFlags: Record<string, true>
}

export interface OnMoveTypeContext {
  battlerId: string
  moveId: string
  moveType: string // read/write -- "-ate" abilities overwrite this
  ateBoost: boolean // read/write
  moveFlags: Record<string, true> // Banshee/Power Metal/Sand Song/Snow Song's sound-flag check
}

export interface OnRecoilContext {
  battlerId: string
  damage: number
  moveType: string
}

export interface OnMoldBreakerContext {
  battlerId: string
  moveId: string
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
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
/** onRecoil returns the recoil damage amount -- also double-purposed by
 * IsRecklessBoosted (src/abilities.cc:436-443) as a truthy "does this ability
 * define its own recoil at all" check, passing a dummy damage=100. Not wired into
 * calculate.ts (no recoil-damage display exists yet in this v1 calculator). */
export type OnRecoil = (ctx: OnRecoilContext) => number
/**
 * onMoldBreaker returns whether Mold Breaker suppression is active for this hit --
 * SetMoldBreaker, src/battle_util.c:976-990. Only ported for the abilities whose
 * condition doesn't require recursively simulating the hit's own resolved type/
 * type-effectiveness/crit status first (Deadly Precision, Flawless Precision,
 * Mach 3, Overrule, and Stonecutter all do exactly that -- a genuinely circular
 * calculation this non-simulated v1 engine can't perform, so those 5 are left
 * unmodelled rather than approximated).
 */
export type OnMoldBreaker = (ctx: OnMoldBreakerContext) => boolean

export interface OnParentalBondContext {
  moveType: string
  moveFlags: Record<string, true>
  weather: string // FieldBattleState's bare weather kind, e.g. 'HAIL'
  attackerHeads: number // species.json's `heads` (F_TWO_HEADED/F_THREE_HEADED), default 1
}

/**
 * ParentalBondTrigger names mirror the C's `MultihitType` enum values consulted by
 * GetParentalBondMultiplier (src/battle_util.c:7483-7513) -- 'ICE_COLD_HUNTER' and
 * 'TWO_TO_FIVE' are real MultihitType values an onParentalBond hook can return, but
 * NEITHER has a case in that switch, so getParentalBondMultiplier (dispatchCalc.ts)
 * correctly falls through to its default 1.0x for both: Ice Cold Hunter's two hits
 * are genuinely full-power (no reduction, just a second complete hit), and
 * Unrelenting's TWO_TO_FIVE is a Skill-Link-style variable-hit-count mechanic --
 * a different multi-hit family from Parental Bond's "one bonus hit at a fixed
 * reduced power" pattern, just returned through the same onParentalBond slot.
 */
export type ParentalBondTrigger = 'HYPER_AGGRESSIVE' | 'THREE_HEADED' | 'MINION_CONTROL' | 'PRIMAL_MAW' | 'DUAL_WIELD' | 'FAMILIA_BOND' | 'MAGUS_BLADES' | 'ICE_COLD_HUNTER' | 'TWO_TO_FIVE'

/**
 * onParentalBond returns which bonus-hit trigger this ability grants for the given
 * move, or null for none (MULTIHIT_SINGLE) -- GetParentalBondType's per-ability call,
 * src/battle_script_commands.c:990-1003. NOT wired into calculate.ts: this v1 engine
 * computes exactly one hit's damage, so a ported onParentalBond hook and
 * getParentalBondMultiplier are complete and correct for the bonus hit's own
 * multiplier, but nothing yet combines that with a first-hit total the way a real
 * multi-hit sequence would (see basePower.ts's multi-hit TODO). Same shape as batch
 * N's onTypeEffectiveness ports: correct now, wired later.
 */
export type OnParentalBond = (ctx: OnParentalBondContext) => ParentalBondTrigger | null

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
  /** onOffensiveMultiplierFor is a plain AbilityApplyOn bitflag (see applyOn.ts's
   * numeric constants). onCritFor/onAfterTypeEffectivenessFor/onChooseDefensiveStatFor
   * use the separate AbilityApplyOnWithTarget encoding (TargetedApplyOn) instead. */
  applyOn?: {
    onOffensiveMultiplierFor?: number
    onStatFor?: number
    onCritFor?: import('./applyOn').TargetedApplyOn
    onAfterTypeEffectivenessFor?: import('./applyOn').TargetedApplyOn
    onChooseDefensiveStatFor?: import('./applyOn').TargetedApplyOn
  }
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
  onMoldBreaker?: OnMoldBreaker
  onParentalBond?: OnParentalBond
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
