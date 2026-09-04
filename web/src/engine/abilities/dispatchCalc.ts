// Wires the ability registry into the damage calculation -- the actual
// CalculateAbilityMultipliers/CalculateStat/StabMultiplierInHalves/
// CalcCritChanceStage loops (src/battle_util.c:6964-6993, 7195-7202,
// 7469-7481; src/battle_script_commands.c:1529-1536), built from the primitives
// in dispatch.ts/applyOn.ts and the AbilityImpl hooks in the registry.

import { uq } from '../fixed'
import { NEVER_CRIT } from '../crit'
import { isApplyOnFlagAppropriate, isTargettedApplyOnFlagAppropriate } from './applyOn'
import type { AbilitySlots } from './dispatch'
import { forEachAbility, battlerHasAbility } from './dispatch'
import { lookupAbility } from './registry'
import { isUnmodelled } from './types'
import type {
  AbilityEntry,
  DefensiveMultiplierContext,
  OffensiveMultiplierContext,
  OnAbsorbContext,
  OnChooseDefensiveStatContext,
  OnChooseOffensiveStatContext,
  OnCritContext,
  OnImmuneContext,
  OnInfiltrateContext,
  OnMoldBreakerContext,
  OnMoveTypeContext,
  OnParentalBondContext,
  OnStatContext,
  ParentalBondTrigger,
} from './types'
import type { BattleStatKey } from '../types'

// v1 has no Neutralizing Gas / Gastro Acid modelling -- a battler's own abilities
// are NEVER suppressed by ITS OWN mold breaker (IsSuppressed's `battler !=
// gBattlerAttacker` check, src/battle_util.c:9285-9291), so every call site below
// that checks a battler's OWN slots (the attacker checking itself, an ability
// checking its own holder) uses this constant rather than the real predicate.
const NEVER_SUPPRESSED = (): boolean => false

/**
 * IsSuppressed's `breakable` branch, src/battle_util.c:9285-9291 -- an ability is
 * suppressed when Mold Breaker (or an equivalent) is active on the ATTACKER and
 * the ability being checked (necessarily NOT the attacker's own, since
 * NEVER_SUPPRESSED covers that case) has the `breakable` flag. Use this predicate
 * only for a check against a battler OTHER than the one holding the active mold
 * breaker -- in this 2-battler v1 engine, that's always the defender.
 */
function suppressedByMoldBreaker(attackerHasMoldBreaker: boolean) {
  return (_id: string, entry: AbilityEntry): boolean => attackerHasMoldBreaker && !isUnmodelled(entry) && Boolean(entry.flags?.breakable)
}

/**
 * Whether the ATTACKER's own ability slots make Mold Breaker suppression active
 * for this hit. Only ports the 5 of 10 onMoldBreaker abilities whose condition
 * doesn't require recursively simulating the hit's own resolved type/type-
 * effectiveness/crit status first -- see OnMoldBreaker's own doc for why Deadly
 * Precision/Flawless Precision/Mach 3/Overrule/Stonecutter are left unmodelled.
 */
export function computeAttackerHasMoldBreaker(attackerSlots: AbilitySlots, moveId: string, moveSplit: OnMoldBreakerContext['moveSplit']): boolean {
  let active = false
  forEachAbility(attackerSlots, NEVER_SUPPRESSED, (impl) => {
    if (!impl.onMoldBreaker) return
    if (impl.onMoldBreaker({ battlerId: 'attacker', moveId, moveSplit })) {
      active = true
      return 'break'
    }
  })
  return active
}

/** HasFortKnox, referenced by CalculateAbilityMultipliers (:6968) -- true if the
 * defender holds an (unsuppressed) ability with the fortKnox flag. No ability with
 * `fortKnox` is ever also `breakable` in the current data (verified against
 * abilityHooks.json), so Mold Breaker never actually changes this result -- this
 * function has no mold-breaker parameter for that reason, not by oversight. */
export function hasFortKnox(defenderSlots: AbilitySlots): boolean {
  let found = false
  forEachAbility(defenderSlots, NEVER_SUPPRESSED, (impl) => {
    if (impl.flags?.fortKnox) {
      found = true
      return 'break'
    }
  })
  return found
}

/**
 * GetParentalBondType, src/battle_script_commands.c:990-1003: the first attacker
 * ability (in slot order) whose onParentalBond hook returns non-null wins. Gated
 * per-ability by `!hasFortKnox(defenderSlots) || resistsFortKnox` -- unlike the
 * onOffensiveMultiplier loop (hasFortKnox blocks ALL abilities uniformly, verified
 * against CalculateAbilityMultipliers, no per-ability override exists there), this
 * IS a per-ability override, which is why `resistsFortKnox` exists as a flag at all.
 * Not suppressible by Mold Breaker -- SetMoldBreaker's HITMARKER never gates this
 * call site in the C.
 */
export function computeParentalBondTrigger(attackerSlots: AbilitySlots, defenderSlots: AbilitySlots, ctx: OnParentalBondContext): ParentalBondTrigger | null {
  const defenderHasFortKnox = hasFortKnox(defenderSlots)
  let trigger: ParentalBondTrigger | null = null
  forEachAbility(attackerSlots, NEVER_SUPPRESSED, (impl) => {
    if (!impl.onParentalBond) return
    if (defenderHasFortKnox && !impl.flags?.resistsFortKnox) return
    const result = impl.onParentalBond(ctx)
    if (result) {
      trigger = result
      return 'break'
    }
  })
  return trigger
}

/**
 * GetParentalBondMultiplier, src/battle_util.c:7483-7513 -- the bonus hit's own
 * multiplier for a given trigger and hit turn (1-indexed: turn 1 is the FIRST bonus
 * hit past the initial one). `REQUIRE(turn)` in the C just means "any nonzero turn
 * gets the flat rate"; only THREE_HEADED varies its rate by turn number.
 * ICE_COLD_HUNTER and TWO_TO_FIVE have no case here (see ParentalBondTrigger's own
 * doc) and correctly fall through to the neutral 1.0x default.
 */
export function getParentalBondMultiplier(trigger: ParentalBondTrigger | null, turn: number): number {
  switch (trigger) {
    case 'HYPER_AGGRESSIVE':
      if (turn) return uq(0.25)
      break
    case 'THREE_HEADED':
      if (turn === 1) return uq(0.2)
      if (turn === 2) return uq(0.15)
      break
    case 'MINION_CONTROL':
      if (turn) return uq(0.1)
      break
    case 'PRIMAL_MAW':
      if (turn) return uq(0.4)
      break
    case 'DUAL_WIELD':
      return uq(0.7)
    case 'FAMILIA_BOND':
      if (turn) return uq(0.5)
      break
    case 'MAGUS_BLADES':
      if (turn) return uq(0.6)
      break
  }
  return uq(1.0)
}

/**
 * TestAbsorbingAbilities, src/battle_util.c:8961-8969 -- true if any of the
 * defender's (unsuppressed) abilities redirects this move away from dealing damage.
 * checkMoldBreaker=TRUE in the C, so this uses the same suppressedByMoldBreaker
 * predicate as the defensive-multiplier loop and onCrit's defender run.
 */
export function computeIsAbsorbed(defenderSlots: AbilitySlots, ctx: OnAbsorbContext, attackerHasMoldBreaker: boolean): boolean {
  let absorbed = false
  forEachAbility(defenderSlots, suppressedByMoldBreaker(attackerHasMoldBreaker), (impl) => {
    if (impl.onAbsorb?.(ctx)) {
      absorbed = true
      return 'break'
    }
  })
  return absorbed
}

/**
 * TestImmunityAbilities, src/battle_util.c:8978-8997 -- true if any of the
 * defender's (unsuppressed) abilities blocks this move outright. checkMoldBreaker=
 * TRUE in the C, same predicate as computeIsAbsorbed. The C also scans every alive
 * battler on the field (not just the defender) for an ALLY-scoped block (Queenly
 * Majesty/Dazzling's `onImmuneFor = APPLY_ON_ALLY` protects the whole side) -- this
 * v1 singles engine has no ally battler, so only the defender's own slots are
 * checked, which is exactly equivalent for a 2-battler field.
 */
export function computeIsImmune(defenderSlots: AbilitySlots, ctx: OnImmuneContext, attackerHasMoldBreaker: boolean): boolean {
  let blocked = false
  forEachAbility(defenderSlots, suppressedByMoldBreaker(attackerHasMoldBreaker), (impl) => {
    if (impl.onImmune?.(ctx)) {
      blocked = true
      return 'break'
    }
  })
  return blocked
}

/**
 * Infiltrates, src/battle_script_commands.c:12271-12275 -- true if any of the
 * ATTACKER's abilities bypasses screens for this hit. checkMoldBreaker=FALSE (an
 * attacker's own trait, never suppressed by its own Mold Breaker), so this uses
 * NEVER_SUPPRESSED like the offensive-multiplier loop's self-checks.
 */
/**
 * IsIronFistBoosted, src/battle_util.c:9409 -- `DoesMoveMatchFlag(battler, move,
 * TYPE_NORMAL, MOVE_FLAG_PUNCH)`. The move's own static punchBased flag wins
 * outright; only when that's unset does it fall back to asking every ability on
 * the move's OWN USER (never the other battler, never mold-breaker-suppressed --
 * this is the attacker checking its own move) whether it grants punch anyway
 * (e.g. some hand-based-move-boosting ability's onModifyMoveFlags).
 *
 * `TYPE_NORMAL` here is a literal dummy the C itself passes -- NOT the move's real
 * (possibly ability-converted) type -- so an onModifyMoveFlags block that's itself
 * conditioned on moveType only grants punch through this specific check when the
 * dummy happens to match. This is deliberately narrower than a general "does the
 * move have this flag" helper: DoesMoveMatchFlag's other 21 call sites across the
 * registry (Iron Fist itself, Mega Launcher, sound-based abilities, ...) each pass
 * their OWN moveType argument -- real in some cases, a different dummy in others --
 * so a single shared helper can't safely stand in for all of them without checking
 * each call site's own convention individually; only Punching Glove's is
 * implemented here (see OnModifyMoveFlagsContext's own doc for the full backstory
 * and why the rest are still NOT wired in). */
export function isIronFistBoosted(attackerSlots: AbilitySlots, moveFlags: Record<string, true>, moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'): boolean {
  if (moveFlags.punchBased) return true
  let granted = false
  forEachAbility(attackerSlots, NEVER_SUPPRESSED, (impl) => {
    if (impl.onModifyMoveFlags?.({ flag: 'punchBased', moveType: 'NORMAL', moveFlags, moveSplit })) {
      granted = true
      return 'break'
    }
  })
  return granted
}

export function computeInfiltratesScreens(attackerSlots: AbilitySlots, ctx: OnInfiltrateContext): boolean {
  let infiltrates = false
  forEachAbility(attackerSlots, NEVER_SUPPRESSED, (impl) => {
    if (impl.onInfiltrate?.(ctx)) {
      infiltrates = true
      return 'break'
    }
  })
  return infiltrates
}

/** Whether ANY of a battler's (unsuppressed) abilities has the given boolean flag --
 * Adaptability, Unaware, Levitate, etc. are all "does this battler have the flag
 * anywhere in its 4 slots" checks in the C (RETURN_ABILITY_IF_FLAG). `moldBroken`
 * defaults to false (matching every pre-existing call site, which all check a
 * battler's own flags against itself); pass `true` only when checking a battler
 * OTHER than the one holding an active mold breaker -- of the 7 flags this
 * function reads, only `unaware` (Unaware) and `levitate` (Levitate) are ever
 * `breakable`, so this only actually matters for those two flags in the current
 * data. */
export function hasFlag(
  slots: AbilitySlots,
  flag: 'adaptability' | 'unaware' | 'magicGuard' | 'noRecoil' | 'halfRecoil' | 'skillLink' | 'levitate' | 'auraBreak',
  moldBroken = false,
): boolean {
  let found = false
  forEachAbility(slots, moldBroken ? suppressedByMoldBreaker(true) : NEVER_SUPPRESSED, (impl) => {
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
 *
 * Mold Breaker (`attackerHasMoldBreaker`, see computeAttackerHasMoldBreaker) ONLY
 * suppresses the DEFENSIVE hook loop below -- verified against the C's own
 * `checkMoldBreaker` argument at each ON_ABILITY call site: the offensive loop
 * (both branches above) passes FALSE, the defensive loop passes TRUE.
 */
export function computeAbilityMultiplier(
  attackerSlots: AbilitySlots,
  defenderSlots: AbilitySlots,
  offensive: OffensiveCtxInputs,
  defensive: DefensiveCtxInputs,
  attackerHasMoldBreaker = false,
): number {
  // ONE plain mutable object, structurally satisfying both context interfaces (each
  // hook only ever reads its own declared fields, and both write the same shared
  // `modifier`/`resistance`) -- this is what makes the accumulator genuinely shared
  // across the offensive and defensive phases, rather than two independent objects
  // that happen to start from the same uq(1.0).
  const shared = { ...offensive, ...defensive, modifier: uq(1.0), resistance: uq(1.0) }

  if (!hasFortKnox(defenderSlots)) {
    forEachAbility(attackerSlots, NEVER_SUPPRESSED, (impl) => {
      if (!impl.onOffensiveMultiplier) return
      if (!isApplyOnFlagAppropriate(true, false, impl.applyOn?.onOffensiveMultiplierFor)) return
      impl.onOffensiveMultiplier(shared)
    })
    forEachAbility(defenderSlots, NEVER_SUPPRESSED, (impl) => {
      if (!impl.onOffensiveMultiplier) return
      if (!isApplyOnFlagAppropriate(false, false, impl.applyOn?.onOffensiveMultiplierFor)) return
      impl.onOffensiveMultiplier(shared)
    })
  }

  forEachAbility(defenderSlots, suppressedByMoldBreaker(attackerHasMoldBreaker), (impl) => {
    impl.onDefensiveMultiplier?.(shared)
  })

  return shared.modifier
}

type OnStatInputs = Omit<OnStatContext, 'stat' | 'flags' | 'statOwnerHasEternalFlower'>

/**
 * CalculateStat's onStat loop (:7195-7202): both battlers' abilities can modify
 * either battler's stat, gated by onStatFor relative to the STAT OWNER (not the
 * ability holder). Returns a `preModify`-shaped function ready to compose with
 * battleStat.ts's other pre-modifiers.
 *
 * The C's ON_ABILITY call here passes `checkMoldBreaker = TRUE` (a real gap: Lead
 * Coat/Chrome Coat's speed-reducing onStat, both `breakable`, would be suppressed
 * by an attacker's Mold Breaker in the real game). NOT modelled here -- unlike
 * computeAbilityMultiplier's defensive loop, `statOwnerSlots`/`otherSlots` don't
 * carry which battler is the actual move user, so correctly suppressing only the
 * non-attacker side needs identity this function doesn't have; deferred rather
 * than guessed.
 */
export function computeOnStatModifier(statOwnerSlots: AbilitySlots, otherSlots: AbilitySlots, inputs: OnStatInputs) {
  return (stat: number): number => {
    const ctx: OnStatContext = {
      ...inputs,
      stat,
      flags: { nonStackingRuin: false, nonStackingEternalFlower: false },
      statOwnerHasEternalFlower: battlerHasAbility(statOwnerSlots, 'ABILITY_ETERNAL_FLOWER', NEVER_SUPPRESSED),
    }
    forEachAbility(statOwnerSlots, NEVER_SUPPRESSED, (impl) => {
      if (!impl.onStat) return
      if (!isApplyOnFlagAppropriate(true, false, impl.applyOn?.onStatFor)) return
      impl.onStat(ctx)
    })
    forEachAbility(otherSlots, NEVER_SUPPRESSED, (impl) => {
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
 * GetMoveTypeInternal's onMoveType loop (src/battle_main.c:5210-5211). Verified
 * against the actual ON_ABILITY call site there: the loop itself has NO "original
 * type must be Normal" gate -- that check only lives INSIDE the ATE_ABILITY macro
 * (src/abilities.cc:295-301) and each hand-written onMoveType lambda's own CHECK
 * (e.g. Cosmic Wings requires Flying, not Normal). So this dispatcher must call
 * every onMoveType hook regardless of the move's original type and let each hook's
 * own condition decide -- an earlier version of this function incorrectly
 * shortcut-returned whenever moveType wasn't 'NORMAL', which silently made
 * Cosmic Wings (and any future non-Normal-original onMoveType ability) permanently
 * inert; fixed here. Per ON_ABILITY's reverse-slot iteration plus the C's bare
 * `return` on the first hit, the first ability (innate3 -> ... -> ability) that
 * actually changes the type wins -- ties can't occur in practice since real
 * movesets never carry two type-changing abilities on the same mon, but the
 * semantics are ported exactly regardless. Ability holder is always the ATTACKER
 * (`checkMoldBreaker = FALSE` ON_ABILITY call, no cross-battler loop, unlike
 * onOffensiveMultiplier/onCrit).
 */
export function resolveEffectiveMoveType(
  attackerSlots: AbilitySlots,
  moveId: string,
  moveType: string,
  moveFlags: Record<string, true> = {},
): { moveType: string; ateBoost: boolean } {
  let resolved = moveType
  let ateBoost = false
  forEachAbility(attackerSlots, NEVER_SUPPRESSED, (impl) => {
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
  forEachAbility(attackerSlots, NEVER_SUPPRESSED, (impl) => {
    if (!impl.onStab) return
    if (impl.onStab({ battlerId: 'attacker', moveType })) {
      granted = true
      return 'break'
    }
  })
  return granted
}

type OnCritInputs = Omit<OnCritContext, 'battlerId' | 'abilityOn' | 'speciesId'>

/**
 * CalcCritChanceStage's onCrit loop (src/battle_script_commands.c:1529-1536) -- runs
 * across both battlers, filtered by IsTargettedApplyOnFlagAppropriate relative to the
 * ATTACKER (the C's fixed `contextBattler` is always battlerAtk here, regardless of
 * which battler's ability is being checked -- unlike onOffensiveMultiplier, `battler`
 * in the hook body IS the real ability holder, so the two facts are independent).
 * Accumulates a stage bonus; any hook returning NEVER_CRIT short-circuits the whole
 * calculation immediately, matching the C's early return. This loop's ON_ABILITY
 * call passes `checkMoldBreaker = TRUE` -- unlike computeAbilityMultiplier's
 * offensive loop -- so an attacker's Mold Breaker DOES bypass a `breakable`
 * defender ability's crit denial (Battle Armor/Shell Armor's NEVER_CRIT, both
 * `breakable`); `attackerHasMoldBreaker` only ever suppresses the defender's run,
 * matching IsSuppressed's own self-exemption.
 */
export function computeAbilityCritBonus(
  attackerSlots: AbilitySlots,
  defenderSlots: AbilitySlots,
  inputs: OnCritInputs,
  attackerHasMoldBreaker = false,
  attackerAbilityOn = false,
  defenderAbilityOn = false,
  attackerSpeciesId = '',
  defenderSpeciesId = '',
): number {
  let bonus = 0
  let blocked = false
  const run = (
    slots: AbilitySlots,
    battlerId: string,
    sourceIsAttacker: boolean,
    sourceIsTarget: boolean,
    abilityOn: boolean,
    speciesId: string,
    suppressed: (id: string, entry: AbilityEntry) => boolean,
  ) => {
    forEachAbility(slots, suppressed, (impl) => {
      if (blocked || !impl.onCrit) return
      if (!isTargettedApplyOnFlagAppropriate(sourceIsAttacker, sourceIsTarget, sourceIsAttacker, false, impl.applyOn?.onCritFor)) return
      const result = impl.onCrit({ battlerId, abilityOn, speciesId, ...inputs })
      if (result === NEVER_CRIT) {
        blocked = true
        return 'break'
      }
      bonus += result
    })
  }
  run(attackerSlots, 'attacker', true, false, attackerAbilityOn, attackerSpeciesId, NEVER_SUPPRESSED)
  if (!blocked) run(defenderSlots, 'defender', false, true, defenderAbilityOn, defenderSpeciesId, suppressedByMoldBreaker(attackerHasMoldBreaker))
  return blocked ? NEVER_CRIT : bonus
}

type OnChooseOffensiveStatInputs = Omit<OnChooseOffensiveStatContext, 'statToUse' | 'secondaryStat'>

/** CalculateStat's cross-stat blend result: the primary stat to use, plus a
 * percentage-of-another-stat bonus keyed by which OTHER stat contributes (e.g.
 * Juggernaut's `{ def: 20 }` on a contact move) -- see calculate.ts's
 * applySecondaryStatBlend for how these percentages get folded into the final
 * value (CalculateStat, :7213-7229). */
export interface ChosenStat {
  statToUse: BattleStatKey
  secondaryStat: Partial<Record<BattleStatKey, number>>
}

/**
 * CalcAttackStat's onChooseOffensiveStat loop (:7263-7269) -- unlike every other
 * hook here, the C checks ONLY `gAbilities[ability].onChooseOffensiveStat` truthy,
 * with NO IsApplyOnFlagAppropriate call at all: it's always the ATTACKER's own 4
 * ability slots, unconditionally.
 */
export function computeChooseOffensiveStat(attackerSlots: AbilitySlots, defaultStat: BattleStatKey, inputs: OnChooseOffensiveStatInputs): ChosenStat {
  const ctx: OnChooseOffensiveStatContext = { ...inputs, statToUse: defaultStat, secondaryStat: {} }
  forEachAbility(attackerSlots, NEVER_SUPPRESSED, (impl) => {
    impl.onChooseOffensiveStat?.(ctx)
  })
  return { statToUse: ctx.statToUse, secondaryStat: ctx.secondaryStat }
}

type OnChooseDefensiveStatInputs = Omit<OnChooseDefensiveStatContext, 'statToUse' | 'secondaryStat'>

/**
 * CalcDefenseStat's onChooseDefensiveStat loop (:7410-7419) -- iterates battlers
 * starting at the ATTACKER, stopping at the first one whose OWN 4 ability slots
 * (accumulated, last-wins, matching onOffensiveMultiplier's pattern) produce a
 * non-default statToUse; gated by IsTargettedApplyOnFlagAppropriate, where the
 * context battler is always the ATTACKER (so an unscoped hook only fires when its
 * own battler IS the attacker -- matching onCrit's documented default-scope
 * semantics) and an explicit `onChooseDefensiveStatFor: APPLY_ON_TARGET` scope is
 * what lets a defender-held ability like Blur/Elude/Sleek Scales fire at all.
 *
 * The C's loop condition is `for (...) && !defStatToUse` -- it keeps scanning
 * battlers (accumulating into the SAME shared secondaryDefStats array) until one
 * sets the primary stat, at which point it stops. Sleek Scales only ever writes
 * secondaryDefStats (never touches defStatToUse), so it must not be discarded just
 * because "nothing changed" for the primary stat -- the `??` below preserves the
 * C's stop-at-first-primary-override behavior (the defender's run, and whatever it
 * contributes to secondaryStat, is skipped entirely if the attacker's own run
 * already set a stat) while still merging in the running secondaryStat.
 */
export function computeChooseDefensiveStat(attackerSlots: AbilitySlots, defenderSlots: AbilitySlots, defaultStat: BattleStatKey, inputs: OnChooseDefensiveStatInputs): ChosenStat {
  const secondaryStat: Partial<Record<BattleStatKey, number>> = {}
  const run = (slots: AbilitySlots, sourceIsAttacker: boolean, sourceIsTarget: boolean): BattleStatKey | null => {
    const ctx: OnChooseDefensiveStatContext = { ...inputs, statToUse: defaultStat, secondaryStat: {} }
    forEachAbility(slots, NEVER_SUPPRESSED, (impl) => {
      if (!impl.onChooseDefensiveStat) return
      if (!isTargettedApplyOnFlagAppropriate(sourceIsAttacker, sourceIsTarget, sourceIsAttacker, false, impl.applyOn?.onChooseDefensiveStatFor)) return
      impl.onChooseDefensiveStat(ctx)
    })
    Object.assign(secondaryStat, ctx.secondaryStat)
    return ctx.statToUse !== defaultStat ? ctx.statToUse : null
  }
  const statToUse = run(attackerSlots, true, false) ?? run(defenderSlots, false, true) ?? defaultStat
  return { statToUse, secondaryStat }
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
