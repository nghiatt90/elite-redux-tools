// Bridge, batch 2: unpacking the status, volatile and round words.
//
// Each function here reads ONE fact out of a packed word or a struct field, and
// cites the line of C that reads the same fact. A wrong bit is invisible -- it
// type-checks, yields a plausible boolean, and passes any test that only asserts
// the shape -- so every flag below has a test that also fails if its mask moves
// one position in either direction.
//
// ## These are unpackers, not promotions
//
// Nothing in the sim writes status2, gStatuses3/4, gVolatileStructs,
// gRoundStructs or gSideTimers. Unpacking them correctly does not change that.
// Every field sourced from them stays a GAP in bridge.ts, for the reason stated
// at the top of that module: correct on turn one, silently stale from turn two,
// and indistinguishable from a modelled answer.
//
// The bridge still CALLS these rather than writing a placeholder, because that
// is strictly better: the value is then right for any state a caller does set,
// and the batch that makes the loop write these words needs only to delete the
// gap entry. The gap is what stops it being a promotion.
//
// ## Counters are not flags
//
// Three of these words carry counters in the same u32 as their flags. Where a
// counter is read as a boolean, or discarded, the function says so rather than
// dropping it silently -- the same treatment status1's sleep and toxic counters
// got in bridge.ts.
//
// ## Names are not evidence
//
// Two fields here mean something other than what their name suggests, both
// confirmed by reading the code that sets or reads them rather than the
// constant:
//
//   - `fear` is gVolatileStructs[battler].fear, a STRUCT FIELD. There is also a
//     STATUS4_FEAR bit. They are different things and the damage path reads the
//     struct field (battle_util.c:7062). See battlerFear below.
//   - `recentlyFainted` is `retaliateTimer == 1` exactly, not "the timer is
//     running". See recentlyFainted below.

import type { BattleStatKey } from '../types'
import type { RoundState, SideTimerState, VolatileState } from './state'
import {
  STATUS2_CONFUSION,
  STATUS2_DEFENSE_CURL,
  STATUS2_ENRAGED,
  STATUS2_INFATUATION,
  STATUS2_TRANSFORMED,
  STATUS3_CHARGED_UP,
  STATUS3_MIRACLE_EYED,
  STATUS3_ME_FIRST,
  STATUS3_ON_AIR,
  STATUS3_PHANTOM_FORCE,
  STATUS3_UNDERGROUND,
  STATUS3_UNDERWATER,
  STATUS3_EMBARGO,
  STATUS4_GHASTLY_ECHO,
  getCounter,
  hasFlag,
  statusInfatuatedWith,
} from './constants'

// ---------------------------------------------------------------------------
// status2 (BattlePokemon.status2)
// ---------------------------------------------------------------------------

/** STATUS2_CONFUSION is a 3-BIT TURN COUNTER at bit 0, not a flag
 * (constants/battle.h:149-150). Nonzero means confused; the remaining turn count
 * is discarded because the damage path only asks whether confusion is present
 * (Cosmic Daze/Cosmic Dust, Tangled Feet). A mechanic that needs the count --
 * the self-hit roll, which this engine does not model -- must read status2
 * directly. */
export function isConfused(status2: number): boolean {
  return getCounter(status2, STATUS2_CONFUSION) !== 0
}

/** STATUS2_ENRAGED, an ER addition (constants/battle.h:173). A plain flag. */
export function isEnraged(status2: number): boolean {
  return hasFlag(status2, STATUS2_ENRAGED)
}

/** STATUS2_INFATUATION is a 4-BIT MASK at bit 16, one bit per battler
 * (constants/battle.h:162) -- ANY bit set means infatuated with someone. */
export function isInfatuated(status2: number): boolean {
  return hasFlag(status2, STATUS2_INFATUATION)
}

/** STATUS2_INFATUATED_WITH(battler) -- infatuated with that SPECIFIC battler,
 * which is what BattlerBattleState.isInfatuatedWithOpponent asks. */
export function isInfatuatedWith(status2: number, battlerId: number): boolean {
  return hasFlag(status2, statusInfatuatedWith(battlerId))
}

/** STATUS2_TRANSFORMED -- the Metal Powder exemption. */
export function isTransformed(status2: number): boolean {
  return hasFlag(status2, STATUS2_TRANSFORMED)
}

/** STATUS2_DEFENSE_CURL, at bit 30. Only changes EFFECT_ROLLOUT's own
 * counter===0 branch (battle_util.c:6838-6841). */
export function hasDefenseCurl(status2: number): boolean {
  return hasFlag(status2, STATUS2_DEFENSE_CURL)
}

// ---------------------------------------------------------------------------
// gStatuses3
// ---------------------------------------------------------------------------

/** The semi-invulnerable state the DAMAGE path recognises.
 *
 * STATUS3_SEMI_INVULNERABLE is four bits (UNDERGROUND | ON_AIR | UNDERWATER |
 * PHANTOM_FORCE, constants/battle.h:240), but only three have a damage
 * counterpart: battle_util.c:7680-7682's FLAG_DMG_UNDERGROUND /
 * FLAG_DMG_UNDERWATER / FLAG_DMG_2X_IN_AIR. PHANTOM_FORCE has no such flag, so a
 * battler in Phantom Force reads as 'NONE' here -- correct for the damage
 * multiplier, and NOT a statement that it is hittable. Returned separately by
 * `isPhantomForce` so a caller that needs the accuracy/targeting side can ask.
 */
export function semiInvulnerableState(statuses3: number): 'NONE' | 'UNDERGROUND' | 'UNDERWATER' | 'AIRBORNE' {
  if (hasFlag(statuses3, STATUS3_UNDERGROUND)) return 'UNDERGROUND'
  if (hasFlag(statuses3, STATUS3_UNDERWATER)) return 'UNDERWATER'
  if (hasFlag(statuses3, STATUS3_ON_AIR)) return 'AIRBORNE'
  return 'NONE'
}

export function isPhantomForce(statuses3: number): boolean {
  return hasFlag(statuses3, STATUS3_PHANTOM_FORCE)
}

/** STATUS3_MIRACLE_EYED -- changes GetTypeModifier's chart selection. */
export function hasMiracleEye(statuses3: number): boolean {
  return hasFlag(statuses3, STATUS3_MIRACLE_EYED)
}

/** STATUS3_CHARGED_UP -- doubles Electric moves (battle_util.c:7060). */
export function isChargedUp(statuses3: number): boolean {
  return hasFlag(statuses3, STATUS3_CHARGED_UP)
}

/** STATUS3_ME_FIRST -- 1.5x (battle_util.c:7061). */
export function hasMeFirst(statuses3: number): boolean {
  return hasFlag(statuses3, STATUS3_ME_FIRST)
}

/** STATUS3_EMBARGO -- ONE of the three causes of
 * ConditionBattlerContext.itemNegated. The other two are the Magic Room field
 * status and the Klutz ability, so this is NOT the whole predicate and the
 * bridge must not treat it as such. Exposed on its own because it is the only
 * one of the three that lives in a status word. */
export function hasEmbargo(statuses3: number): boolean {
  return hasFlag(statuses3, STATUS3_EMBARGO)
}

// ---------------------------------------------------------------------------
// gStatuses4
// ---------------------------------------------------------------------------

/** STATUS4_GHASTLY_ECHO -- 1.5x (battle_util.c:7059). */
export function hasGhastlyEcho(statuses4: number): boolean {
  return hasFlag(statuses4, STATUS4_GHASTLY_ECHO)
}

// ---------------------------------------------------------------------------
// gVolatileStructs -- struct fields, not bits
// ---------------------------------------------------------------------------

/**
 * The `fear` the damage path reads.
 *
 * NOT STATUS4_FEAR. `battle_util.c:7062` is
 * `if (gVolatileStructs[battlerDef].fear) MulModifier(&modifier, UQ_4_12(1.25))`
 * -- the VolatileStruct bitfield member (include/battle.h:150), and the same
 * one ShouldSwitch (battle_ai_switch_items.c:619) and IsBattlerTrapped
 * (battle_ai_util.c:574) test. STATUS4_FEAR (constants/battle.h:287) is a
 * separate bit that none of those three read. Both exist; this is the one the
 * damage path means.
 *
 * Note also that the damage path reads the DEFENDER's fear while the
 * surrounding modifiers in that block read the attacker's. The bridge populates
 * each battler's own value and basePower.ts does the cross-read
 * (`ctx.defender.fear`), so neither side has to know about the other.
 */
export function battlerFear(volatiles: VolatileState): boolean {
  return volatiles.fear
}

/** gVolatileStructs[battler].slowStartTimer -- a COUNTER, set to 5 on entry and
 * counting down. Returned as its number, not a boolean: Slow Start's own check
 * is `if (timer)` but Lethargy reads the exact value for a 5-tier multiplier, so
 * collapsing it here would lose the distinction. */
export function slowStartTimer(volatiles: VolatileState): number {
  return volatiles.slowStartTimer
}

/** ER's five "extra stat levels", as the calculator's record. A separate
 * additive track from stat stages that cannot be copied or reset. */
export function extraStatLevels(volatiles: VolatileState): Record<BattleStatKey, number> {
  return {
    atk: volatiles.extraAttackLevel,
    def: volatiles.extraDefenseLevel,
    spatk: volatiles.extraSpAttackLevel,
    spdef: volatiles.extraSpDefenseLevel,
    spe: volatiles.extraSpeedLevel,
  }
}

/** gVolatileStructs[battler].rolloutCounter -- a 2-BIT counter (0..3), returned
 * as its value because EFFECT_ROLLOUT's power doubles per step. Cmd_handlerollout's
 * own increment gate (`rolloutCounter < 3`) makes 3 the ceiling in normal play. */
export function rolloutCounter(volatiles: VolatileState): number {
  return volatiles.rolloutCounter
}

// ---------------------------------------------------------------------------
// gRoundStructs
// ---------------------------------------------------------------------------

/** gRoundStructs[battlerAtk].helpingHand -- 1.5x (battle_util.c:7058). */
export function hasHelpingHand(round: RoundState): boolean {
  return round.helpingHand
}

/** gRoundStructs[battlerDef].safePassage -- 0.65x (battle_util.c:7063). Read
 * from the DEFENDER, like `fear` and unlike its neighbours in that block. */
export function hasSafePassage(round: RoundState): boolean {
  return round.safePassage
}

/**
 * Damaged(battler, by), src/script_conditions.cc:43-47:
 *
 *     if (!gRoundStructs[battler].damaged) return FALSE;
 *     if (by == BATTLER_NONE) return FALSE;
 *     return physicalBattlerId == by || specialBattlerId == by;
 *
 * Returns the raw pair rather than the calculator's collapsed
 * `'attacker' | 'defender' | 'none'`, because the C checks BOTH recorded
 * battler ids and a battler hit physically by one opponent and specially by
 * another was damaged by both. The 3-way enum cannot express that, so the
 * collapse belongs to the caller that knows which battler is "the attacker" of
 * the pending calculation -- and loses the both-battlers case when it happens.
 * In singles it cannot happen; in doubles it can.
 */
export function damagedBy(round: RoundState): { damaged: boolean; byBattlerIds: number[] } {
  if (!round.damaged) return { damaged: false, byBattlerIds: [] }
  const ids = new Set<number>([round.physicalBattlerId, round.specialBattlerId])
  return { damaged: true, byBattlerIds: [...ids] }
}

// ---------------------------------------------------------------------------
// gSideTimers
// ---------------------------------------------------------------------------

/**
 * RecentFainted(battler), src/script_conditions.cc:110:
 *
 *     return gSideTimers[GET_BATTLER_SIDE(battler)].retaliateTimer == 1;
 *
 * EXACTLY ONE, not "the timer is running". The timer is set to 2 when a mon on
 * that side faints (battle_script_commands.c:3238, :3242) and decremented once
 * per turn (battle_util.c:2182-2183), so the sequence is: 2 on the turn of the
 * faint (FALSE), 1 on the next turn (TRUE), 0 after (FALSE). A `> 0` test would
 * fire Retaliate a turn early, on the turn of the faint itself.
 *
 * The same timer has a SECOND, different predicate elsewhere: abilities.cc:3881
 * uses a plain `if (retaliateTimer)`, i.e. nonzero, for an ability's multiplier.
 * The two consumers genuinely disagree about the same field; see
 * `retaliateTimerActive` for that one.
 */
export function recentlyFainted(timers: SideTimerState): boolean {
  return timers.retaliateTimer === 1
}

/** The OTHER predicate on the same timer -- abilities.cc:3881's plain nonzero
 * test. Deliberately a separate function so a caller has to choose, rather than
 * one of them silently standing in for the other. */
export function retaliateTimerActive(timers: SideTimerState): boolean {
  return timers.retaliateTimer > 0
}
