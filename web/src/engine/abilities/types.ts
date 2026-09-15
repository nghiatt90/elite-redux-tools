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
  /** gBattleMoves[move].secondaryEffectChance -- Sheer Force's own trigger condition
   * (BattleMovesGenerator.kt's `sheerForce` local) is `split != STATUS && effectChance
   * != 0 && !noSheerForce`, all three pieces already emitted; no separate
   * FLAG_SHEER_FORCE_BOOST needs threading through the pipeline. */
  moveEffectChance: number
  /** gBattleStruct->ateBoost[battler] -- resolveEffectiveMoveType's own return value
   * (dispatchCalc.ts), true when SOME onMoveType hook on this battler set it while
   * resolving the move's effective type this turn (Superconductor/Normalize read
   * this on themselves; it's a per-battler flag from the SAME resolution pass that
   * already produced this ctx's own moveType, not a separate lookup). */
  ateBoost: boolean
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
  /** A generic per-battler "is this ability's boosted state currently active" flag
   * -- a scenario toggle, not derived, matching @smogon/calc's own `abilityOn`
   * design for the same class of mechanism (Flash Fire's RESOURCE_FLAG_FLASH_FIRE,
   * Power Outage/Stakeout's GetAbilityState/isFirstTurn checks, Ambush's own
   * isFirstTurn -- none of which this non-turn-simulating engine can derive on its
   * own). Named from the ATTACKER's perspective, matching attackerHp/
   * attackerStatus1/etc. above -- every onOffensiveMultiplier ability that reads it
   * is a self-check (APPLY_ON_SELF, the default), so this is always the loop's own
   * current battler when it's actually invoked. */
  attackerAbilityOn: boolean
  /** IsAbilityOnField(FALSE, ...auraBreak...) -- true if EITHER battler holds an
   * `auraBreak`-flagged ability (Aura Break, Nihil Blaster). Computed once from
   * both battlers' slots and handed in here since this hook only ever sees its
   * own holder's context, not the other battler's abilities; the C's own
   * explicit `FALSE` (checkMoldBreaker) means this is never suppressed. */
  isAuraBreakActive: boolean
  attackerGender: 'MALE' | 'FEMALE' | 'GENDERLESS' // Rivalry's own condition (GetGenderFromSpeciesAndPersonality)
  defenderGender: 'MALE' | 'FEMALE' | 'GENDERLESS'
  defenderIsConfused: boolean // STATUS2_CONFUSION on the move's TARGET -- Cosmic Daze/Cosmic Dust
  defenderIsEnraged: boolean // STATUS2_ENRAGED on the move's TARGET -- Cosmic Daze/Cosmic Dust
  defenderStatus1: Set<string> // gBattleMons[target].status1 bare flags -- Blood Stigma
  defenderHasBloodStainEffect: boolean
  /** ConditionBattlerContext.hasComatose for the DEFENDER -- Dreamcatcher/Dreamscape's
   * own "is asleep" check treats Comatose as always-asleep, same as
   * attackerHasAnyStatus/defenderHasAnyStatus do elsewhere. */
  defenderHasComatose: boolean
  attackerSlowStartTimer: number // BattlerBattleState.slowStartTimer -- Lethargy's own 5-tier read of the same timer Slow Start reads as a boolean
  /** StabMultiplierInHalves(battler, moveType, move) > 2 -- does this move
   * currently get a STAB bonus at all (plain 1.5x OR Adaptability's 2x)? Color
   * Spectrum's own onEndTurn random-type-reassignment isn't simulated by this
   * engine (no turn history), but its onOffensiveMultiplier condition is just
   * this STAB fact, independent of HOW the attacker came to have that type --
   * calculate.ts recomputes the same stabInHalves() call already used for the
   * real STAB fold, just earlier. */
  attackerHasStab: boolean
  attackerIsUnaware: boolean // IsUnaware(battler) -- Pretty Princess's OWN Unaware check (self, not the defender's)
  defenderHasAnyLoweredStat: boolean // HasAnyLoweredStat(target) -- Pretty Princess
  /** IsBattlerGroundedIgnoreType(battler), src/battle_util.c:6651-6653 -- this
   * hook's `battler` param is ALWAYS the move's actual user (see this
   * interface's own doc comment above), so this is the ATTACKER's own resolved
   * grounding, computed by calculate.ts's computeIsGrounded. Flourish's
   * IsBattlerTerrainAffected(battler, GRASSY_TERRAIN) needs it. */
  attackerIsGrounded: boolean
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
  defenderAbilityOn: boolean // see OffensiveMultiplierContext's attackerAbilityOn doc -- same generic toggle, defender-named here (Chuckster/Drakelp Head)
  attackerGender: 'MALE' | 'FEMALE' | 'GENDERLESS' // Rivalry's own condition (GetGenderFromSpeciesAndPersonality)
  defenderGender: 'MALE' | 'FEMALE' | 'GENDERLESS'
  defenderIsEnraged: boolean // STATUS2_ENRAGED on the ability holder itself (== the move's target here) -- Madness Enhancement
  attackerTypes: string[] // IS_BATTLER_OF_TYPE(attacker, ...) -- the move USER's own types (Dragonslayer/Fae Hunter/Firefighter/Lumberjack/Monster Hunter's defensive halves)
}

export interface OnStatContext {
  battlerId: string
  statId: BattleStatKey
  moveId: string
  stat: number // read/write -- ports mutate this directly (`ctx.stat = ...`)
  flags: { nonStackingRuin: boolean; nonStackingEternalFlower: boolean } // NonStackingState -- shared bitfield, Ruin abilities + Eternal Flower each own one bit
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
  abilityOn: boolean // see OffensiveMultiplierContext's attackerAbilityOn doc -- the STAT OWNER's own toggle (Unburden/Slow Start)
  boostedStat: BattleStatKey | null // Protosynthesis/Quark Drive's ParadoxBoost.statId -- the STAT OWNER's own, null when inactive
  alliesFainted: number // gFaintedMonCount[GetBattlerSide(battler)] -- the STAT OWNER's own team's fainted count (Soul Harvest, Supreme Overlord)
  isMegaEvolved: boolean // ConditionBattlerContext.isMegaEvolved for the STAT OWNER -- Eternal Flower
  /** BattlerHasAbility(battler, ABILITY_ETERNAL_FLOWER, FALSE) -- does the STAT
   * OWNER itself hold Eternal Flower? (Its onStatFor=APPLY_ON_OTHER, so the hook
   * body's "battler" is whoever is having their stat computed, not the holder --
   * this is that battler's own self-immunity check, computed by
   * computeOnStatModifier from statOwnerSlots since ctx has no other way to see
   * the stat owner's own ability slots.) */
  statOwnerHasEternalFlower: boolean
  /** IsBattlerGroundedIgnoreType(battler), src/battle_util.c:6651-6653, for the
   * STAT OWNER (this hook's `battler` -- see CalculateStat's own ON_ABILITY call,
   * battle_util.c:7143-7148 -- is always whoever's stat is being computed, not
   * the ability holder). computed by calculate.ts's computeIsGrounded. Biofilm/
   * Grass Pelt/Flower Necklace/Hadron Engine's IsBattlerTerrainAffected calls
   * need it; Surge Surfer/Jungle Fever do NOT (their C uses the bare
   * IsTerrainActive, no grounding check). */
  isGrounded: boolean
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
  // Resolved per-side by computeAbilityCritBonus's own run() closure (NOT part of
  // OnCritInputs -- callers supply attackerAbilityOn/defenderAbilityOn separately,
  // since a single shared value would be ambiguous across the attacker and
  // defender runs). The ability HOLDER's own toggle (Ambush's isFirstTurn).
  abilityOn: boolean
  /** ConditionBattlerContext.speciesId for the ABILITY HOLDER (self, same
   * per-side-resolved shape as abilityOn above) -- Ape Shift's own exact-form
   * check (SPECIES_SLAKING_MEGA_APE_SHIFT), not the general baseSpeciesId used
   * for form-agnostic matching elsewhere. */
  speciesId: string
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
  moveFlags: Record<string, true> // Bone Zone's own FLAG_BONE_BASED check
  modifier: number // UQ_4_12, read/write
  perTypeModifiers: [number, number, number] // modifier1/2/3 from the three-type fold, read-only
  defenderTypes: string[] // IS_BATTLER_OF_TYPE(target, ...) checks -- e.g. Steelworker
  weather: string
  targetGrounded: boolean // !IsBattlerGroundedIgnoreType(target) checks -- BattlerBattleState's own `isGrounded`
  defenderAtMaxHp: boolean // BATTLER_MAX_HP(target)
  /** BATTLER_MAX_HP(battler) -- battle_util.c:7931 always passes the ATTACKER as
   * this hook's `battler` param (the ability-owner loop var is only used for the
   * applyOn filter, never forwarded into the call), so this reads the ATTACKER's
   * own HP regardless of which side's ability is running. Needed only by Tera
   * Shell at this pin -- see its own comment in 16-type-effectiveness.ts. */
  attackerAtMaxHp: boolean
  defenderAbilityOn: boolean // GetAbilityState(target, ability) -- Soothsayer's own decaying-countdown "is my shield still up" check, reusing the generic abilityOn toggle rather than a single-purpose field
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
  secondaryStat: Partial<Record<BattleStatKey, number>> // read/write -- folded in by calculate.ts's applySecondaryStatBlend
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
  /** STATUS2_CONFUSION -- Tangled Feet's own condition. Unscoped (no explicit
   * onChooseDefensiveStatFor), so per IsApplyOnFlagAppropriate's own
   * contextBattler==sourceBattler self-check (contextBattler is always battlerAtk
   * here), this ability's condition only ever gets checked while scanning the
   * ATTACKER's own slots -- see computeChooseDefensiveStat's doc. Named from the
   * attacker's perspective for that reason, not because it's a general rule for
   * this context. */
  attackerIsConfused: boolean
  statToUse: BattleStatKey // read/write
  secondaryStat: Partial<Record<BattleStatKey, number>> // read/write -- folded in by calculate.ts's applySecondaryStatBlend
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

/**
 * Victory Bomb (src/abilities.cc:8980-8991) is left permanently unmodelled, same
 * class of gap as the onMoldBreaker abilities documented above OnMoldBreaker: its
 * onMoveType CHECK(gProcessingExtraAttacks) CHECK(gQueuedExtraAttackData[0].ability
 * == ability) scopes the Fire-type override to ONE specific synthetic attack -- the
 * holder's own post-faint retaliatory Explosion (its onDefender hook), which this
 * non-turn-simulating engine never constructs. Its onDefender itself isn't a damage
 * hook at all (it decides whether to launch an out-of-turn counter-move on the
 * DEFENDER'S death, not this move's own damage), so there's no partial port
 * available here -- the whole mechanic is out of scope for a static single-hit
 * damage number, like Dreamcatcher's own FILTER_NOT guard (see 40-dreamcatcher.ts).
 */

export interface OnRecoilContext {
  battlerId: string
  damage: number
  moveType: string
}

export interface OnMoldBreakerContext {
  battlerId: string
  moveId: string
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
  /** The ate-boost/ability-resolved type calcInternal is CURRENTLY evaluating --
   * calcInternal runs once per candidate type (moveType, then move.type2 if
   * present), so this is always a single concrete type from that call's own
   * perspective, never both at once. Stonecutter's own condition. null from
   * scenarioCritStageInputs's own call site (see isForcedCrit), which has no
   * specific type in scope at all. */
  moveType: string | null
  /** Type effectiveness computed via the EXACT SAME grounding+fold+afterHooks
   * pipeline calcInternal itself uses for the real number, except with Mold
   * Breaker hardcoded active for this one hypothetical evaluation -- Deadly
   * Precision/Flawless Precision/Mach 3's own condition (`CalculateMoveDamage
   * AndEffectiveness` with HITMARKER_MOLD_BREAKER forced on, src/abilities.cc's
   * onMoldBreaker bodies). null from scenarioCritStageInputs's call site, for the
   * same reason as moveType -- treat null as "this ability can't activate from
   * here" rather than throwing; a real compound edge case (this ability AND
   * Overrule on the very same battler) would then only get partial credit, but
   * no current species/ability data combines them so this hasn't mattered yet. */
  hypotheticalTypeEffectiveness: number | null
  /** Whether the scenario being evaluated assumes this hit crits. Overrule's own
   * condition is literally `gIsCriticalHit` in the C -- since this calculator
   * reports a crit and non-crit row as two separate, deterministic scenarios
   * rather than drawing one random roll, "does this hit crit" translates
   * directly to "is this the forced-crit row/hypothesis", with no further
   * ability-suppression math needed. calcInternal passes its own `forceCrit`
   * parameter directly (Overrule is active on the crit row, not the non-crit
   * one); scenarioCritStageInputs's own top-level "can this move crit AT ALL"
   * gate passes `true` unconditionally, asking exactly Overrule's own question
   * ("in a hypothetical crit scenario, would Mold Breaker be active for this
   * attacker") to decide whether an otherwise-NEVER_CRIT block (Battle Armor/
   * Shell Armor) should really apply. */
  isForcedCrit: boolean
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
 * SetMoldBreaker, src/battle_util.c:976-990. Deadly Precision/Flawless Precision/
 * Mach 3/Overrule/Stonecutter all decide their OWN activation by evaluating the
 * hit's type effectiveness or crit status hypothetically WITH Mold Breaker forced
 * on first -- this reads as circular (Mold Breaker is needed to compute type
 * effectiveness, but these abilities need type effectiveness to decide Mold
 * Breaker) but isn't actually one: it's a bounded two-branch lookup (evaluate the
 * hypothesis once, branch on it), not an iterative fixed point, so it's fully
 * portable -- see OnMoldBreakerContext's own doc on the extra fields
 * (moveType/hypotheticalTypeEffectiveness/isForcedCrit) calculate.ts precomputes
 * for exactly this purpose.
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
 * src/battle_script_commands.c:990-1003. Wired into calculate.ts via multiHit.ts's
 * resolveHitPlan (which also handles a move's own DOUBLE_HIT/MULTI_HIT/TEN_HITS
 * effects, mutually exclusive with this hook in the C's own dispatch order) --
 * DamageCalcResult's hitCount/totalRolls/totalCritRolls carry the summed multi-hit
 * total, alongside the existing single-hit rolls/critRolls.
 */
export type OnParentalBond = (ctx: OnParentalBondContext) => ParentalBondTrigger | null

export interface OnAbsorbContext {
  moveType: string
  moveFlags: Record<string, true>
}

/**
 * onAbsorb returns whether this ability redirects the move away from dealing damage
 * entirely -- TestAbsorbingAbilities, src/battle_util.c:8961-8969, called with
 * checkMoldBreaker=TRUE (breakable abilities ARE suppressible; Justified and Elemental
 * Vortex are the only two of the census's 22 that aren't breakable). The C's actual
 * return value also carries a stat-boost/heal/flash-fire-flag payload (`*statId`, the
 * ABSORB_RESULT_* bits) -- irrelevant here, since this calculator shows one hit's
 * damage number, not HP/stat side effects, so only "absorbed or not" is modelled.
 */
export type OnAbsorb = (ctx: OnAbsorbContext) => boolean

export interface OnImmuneContext {
  moveType: string
  moveFlags: Record<string, true>
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
  weather: string
  movePriority: number
}

/**
 * onImmune returns whether this ability blocks the move outright (0 damage, no
 * absorb-style side effect) -- TestImmunityAbilities, src/battle_util.c:8978-8997,
 * called with checkMoldBreaker=TRUE. Three conditions the real C checks are always
 * true/false in this v1 engine and are simply not modelled per-call: `battler !=
 * attacker` and `GetBattlerSide(attacker) != GetBattlerSide(battler)` (this
 * calculator always evaluates a distinct attacker/defender pair on opposite
 * sides -- always true), `GetBattlerBattleMoveTargetFlags(move, attacker) &
 * MOVE_TARGET_USER` (a self-targeted damaging move essentially doesn't exist in
 * the dataset -- Bide is the sole exception, already a known special case
 * elsewhere -- so treated as always false/non-self-targeted), and
 * `gProcessingExtraAttacks` (multi-hit simulation state this engine doesn't have --
 * always false, so `CHECK_NOT` always passes).
 */
export type OnImmune = (ctx: OnImmuneContext) => boolean

export interface OnInfiltrateContext {
  moveType: string
  moveFlags: Record<string, true>
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
  attackerTypes: string[]
}

/**
 * onInfiltrate returns whether the ATTACKER bypasses reflect/light screen/aurora
 * veil for this hit -- Infiltrates, src/battle_script_commands.c:12271-12275,
 * called with checkMoldBreaker=FALSE (an attacker's own trait, never suppressed,
 * same shape as the offensive-multiplier loop's self-checks). The real C returns a
 * 3-bit InfiltrateType (SCREENS/SUBSTITUTE/BREAK_SCREENS, abilities.hh:16-19) and
 * CalcFinalDmg only ever tests `type & (SCREENS | BREAK_SCREENS)` (:7651) -- the
 * SUBSTITUTE bit only matters for whether a Substitute blocks the move outright, a
 * mechanic this calculator doesn't model, so this hook collapses straight to "does
 * this bypass screens," not the raw bitmask.
 */
export type OnInfiltrate = (ctx: OnInfiltrateContext) => boolean

export interface OnModifyMoveFlagsContext {
  flag: 'punchBased' | 'kickBased' | 'bulletBased' | 'sliceBased' | 'sound' | 'dance'
  moveType: string
  moveFlags: Record<string, true>
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'
}

/**
 * onModifyMoveFlags returns whether this ability GRANTS the given move flag to the
 * current move (for this hit only) -- DoesMoveMatchFlag, src/abilities.cc:331-361:
 * every IsXBoosted-style helper (IsIronFistBoosted/IsStrikerBoosted/
 * IsMegaLauncherBoosted/IsSoundMove/IsDance/IsKeenEdge) first checks the move's own
 * flag bit, and ONLY IF THAT'S UNSET falls back to asking every ability on the
 * move's own battler whether it grants the flag anyway. `flag`'s 6 values are the
 * only ones any onModifyMoveFlags block in the census switches on, spelled with the
 * same names as MoveData.flags' own keys (see emit.py's _MOVE_FLAGS) so a future
 * `flag`-keyed fallback reads as `moveFlags[flag] || ability grants it`.
 *
 * Wired into calculate.ts for exactly ONE of DoesMoveMatchFlag's call sites so far
 * (dispatchCalc.isIronFistBoosted, for Punching Glove) -- the C passes a literal
 * TYPE_NORMAL dummy there rather than the move's real type, which is why that one
 * generalizes safely. The other 21 call sites (Iron Fist itself, Mega Launcher,
 * sound-based abilities, ...) each pass their OWN moveType argument (real in some
 * cases, a different dummy in others) and reach every existing
 * `ctx.moveFlags.sound`/`.punchBased`/`.kickBased`/`.bulletBased`/`.sliceBased`/
 * `.dance` check across the registry (several already carrying a comment flagging
 * this gap -- Liquid Voice, Punk Rock, Dual Wield, Magus Blades, Primal Maw,
 * Raging Boxer) -- NOT safe to fold into one shared helper without checking each
 * site's own convention individually, so those stay unwired. Each port below is
 * complete and correct for when that plumbing exists.
 */
export type OnModifyMoveFlags = (ctx: OnModifyMoveFlagsContext) => boolean

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
  /** Set on exactly 2 abilities in the census (Aura Break, Nihil Blaster) --
   * Dark Aura/Fairy Aura's own condition checks whether ANY battler on the field
   * has this flag (IsAbilityOnField(FALSE, ...auraBreak...), src/abilities.cc:2496,
   * 2513), not a general-purpose flag other abilities are expected to read. */
  auraBreak: boolean
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
  onAbsorb?: OnAbsorb
  onImmune?: OnImmune
  onInfiltrate?: OnInfiltrate
  onModifyMoveFlags?: OnModifyMoveFlags
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
