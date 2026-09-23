// DoBattlerEndTurnEffects, src/battle_util.c:2398-2992 -- the per-battler
// end-of-turn residual ladder BattleTurnPassed (battle_main.c:3465-3481) runs
// AFTER the action loop and TurnValuesCleanUp(TRUE), BEFORE
// HandleFaintedMonActions/HandleWishPerishSongOnTurnEnd and the
// gBattleResults.battleTurnCounter increment (:3508-3511) -- see turn.ts's own
// citation at the call site, which places this phase in that exact slot.
// DoFieldEndTurnEffects (weather/terrain/field timers, battle_util.c:1730-2318)
// runs BEFORE this -- see fieldEndTurn.ts, ported in cycle 9. Its own
// ENDTURN_ORDER case re-sorts gBattlerByTurnOrder (SortBattlersBySpeed), and
// that re-sorted order -- not the action loop's own order -- is what this
// ladder receives from turn.ts, matching the C's single shared array.
//
// LOOP STRUCTURE (read, not assumed): the C is one big while loop keyed on TWO
// trackers on gBattleStruct, turnEffectsBattlerId (which battler) and
// turnEffectsTracker (which ENDTURN_* case), both PERSISTED ACROSS CALLS
// because BattleScriptExecute suspends control back to the caller mid-ladder.
// Only ENDTURN_BATTLER_COUNT (:2981-2985) resets turnEffectsTracker to 0 and
// advances turnEffectsBattlerId -- every other case leaves the battler id
// alone, so ALL entries for one battler run (in enum order) before the next
// battler is even looked at. The outer battler order is
// gBattlerByTurnOrder[turnEffectsBattlerId] (:2408) -- the SAME order this
// turn's action loop already established (turn.ts's TurnOutcome.order), not a
// fresh sort. Absent battlers (gAbsentBattlerFlags, :2409-2412) are skipped
// without consuming any tracker entries; ported below via
// state.absentBattlerFlags, the same bit turn.ts's isBattlerAlive already
// reads.
//
// FAINT HANDLING: a fainted battler takes no further residual damage. BURN's
// own case checks `hp != 0` directly (:2574), and POISON/BAD_POISON both
// REQUIRE(IsBattlerAlive) (:2495, :2520) -- ALL THREE gate on liveness checked
// FRESH at the top of their own case, so a battler that faints from an
// earlier entry in the SAME ladder pass (its own poison damage, or an
// unported earlier entry like Leech Seed) takes no further damage from a
// later entry. This port re-checks liveness the same way, per effect, rather
// than short-circuiting the whole battler once fainted, to match exactly.
//
// RNG: none of POISON, BAD_POISON or BURN calls Random() in this C. Checked
// every branch below by name; if a future batch ports a case that does draw,
// it must draw from state.rng at the C's position, matching every other
// module in sim/.
//
// ---------------------------------------------------------------------------
// ENDTURN_* enum, battle_util.c:2320-2365, and what this batch does with each.
// "Reachable" below means: some OTHER production file in web/src/engine/sim
// already reads the exact field this case depends on as real, externally
// settable input (not merely declared in constants.ts/state.ts, and not just
// named in a comment -- checked with grep, not assumed). That is exactly
// attackCanceller.ts's own standard: compare CANCELLER_DISABLED/TAUNTED/
// HEAL_BLOCKED/THROAT_CHOP there (all "Unreachable -- has no writer" despite
// being plain constructible fields) against CANCELLER_ASLEEP/TRUANT (ported,
// because sleep/abilityState are read for real elsewhere). A "gapped" case
// below computes its REAL C condition from that same reachable state and
// pushes an unmodelled line ONLY when the condition is actually true, never
// unconditionally -- the same discipline attackCanceller.ts's own POWDER
// gaps use.
//
//   ENDTURN_SKY_DROP        Unreachable -- volatiles.shouldClearSkyDrop has no
//                           reader anywhere in web/src/engine/sim.
//   ENDTURN_INGRAIN         Gapped -- STATUS3_ROOTED is read for real by
//                           grounding.ts. Gapped when set, hp!=0, not already
//                           at max HP and CanBattlerHeal(battler) (ported
//                           below, canBattlerHeal).
//   ENDTURN_AQUA_RING       Unreachable -- STATUS3_AQUA_RING has no reader
//                           outside constants.ts.
//   ENDTURN_SYRUP           Unreachable -- volatiles.syrupTimer has no reader
//                           outside create.ts's zero default.
//   ENDTURN_ABILITIES       Gapped -- gapped when the battler's own ability
//                           (not innates -- AbilityBattleEffects(ENDTURN,...)
//                           only ever reads slot 0) has an onEndTurn hook per
//                           abilityHooks.json (ENDTURN_ABILITY_IDS below).
//   ENDTURN_ITEMS1          Gapped -- gapped when the battler's item's
//   ENDTURN_ITEMS2          resolvedHoldEffect is one of ITEMS_1_2_HOLD_EFFECTS
//                           (battle_util.c:5622-5855's own case-1 switch,
//                           transcribed by name below; this port does not
//                           distinguish which of ITEMS1 (moveTurn=FALSE) vs
//                           ITEMS2 (moveTurn=TRUE) would actually fire for a
//                           given hold effect -- both are gapped by the same
//                           set, which is honest-but-coarse: it may gap ITEMS2
//                           for a hold effect that only fires on ITEMS1's
//                           pass, but never fails to gap a hold effect that
//                           fires on either).
//   ENDTURN_ORBS            Gapped -- gapped when the battler's item's
//                           resolvedHoldEffect is one of HOLD_EFFECT_TOXIC_ORB
//                           / HOLD_EFFECT_FLAME_ORB / HOLD_EFFECT_FROST_ORB /
//                           HOLD_EFFECT_STICKY_BARB (battle_util.c:6252-6288).
//   ENDTURN_LEECH_SEED      Unreachable -- STATUS3_LEECHSEED has no reader
//                           outside constants.ts.
//   ENDTURN_TOXIC_WASTE_DAMAGE Unreachable -- gated on getMonotypeChampType(),
//                           which exists only as an external fact threaded
//                           into TurnOrderContext/GroundingContext (grounding.
//                           ts's own isCluelessOnField precedent), not as a
//                           BattleState/BattlerState field this function's own
//                           input surface can read.
//   ENDTURN_POISON          PORTED.
//   ENDTURN_BAD_POISON      PORTED.
//   ENDTURN_SEA_OF_FIRE_DAMAGE Unreachable -- side.timers.fireSeaTimer has no
//                           reader outside create.ts's zero default.
//   ENDTURN_PARASITIC_SPORES_DAMAGE Unreachable -- volatiles.parasiticSpores
//                           has no reader outside create.ts's false default.
//   ENDTURN_BURN            PORTED.
//   ENDTURN_FROSTBITE       Gapped -- STATUS1_FROSTBITE is read for real by
//                           attackCanceller.ts (thaw). Gapped when set and
//                           hp!=0 (:2585) -- same shape as BURN, out of this
//                           batch's requested scope.
//   ENDTURN_BLEED           Gapped -- STATUS1_BLEED is read for real by
//                           turnOrder.ts. The C's OTHER trigger,
//                           IsBloodStainAffected (own types + own ability, both
//                           always-real state), is computed for real below
//                           (isBloodStainAffected) rather than gapped, since
//                           nothing about it is missing. Gapped (damage not
//                           applied) when either is true and hp!=0.
//   ENDTURN_NIGHTMARES      Gapped -- STATUS2_NIGHTMARE is read for real by
//                           attackCanceller.ts (cleared on natural wake).
//                           Gapped when set, hp!=0 and STATUS1_SLEEP is also
//                           set (the C's own damage sub-branch, :2613-2617).
//   ENDTURN_CURSE           Unreachable -- STATUS2_CURSED has no reader
//                           outside constants.ts, and IsBattlerCursed (a
//                           separate ghost-curse condition) has no port.
//   ENDTURN_SALT_CURE       Unreachable -- STATUS4_SALT_CURE has no reader
//                           outside constants.ts; the monotype-champion
//                           sub-condition is unreachable for the same reason
//                           as ENDTURN_TOXIC_WASTE_DAMAGE.
//   ENDTURN_WRAP             Unreachable -- STATUS2_WRAPPED/wrapTurns/
//                           wrapAbility have no reader outside constants.ts/
//                           create.ts; the monotype-champion sub-condition is
//                           unreachable for the same reason as above.
//   ENDTURN_OCTOLOCK        Unreachable -- volatiles.octolock has no reader
//                           outside create.ts's false default.
//   ENDTURN_UPROAR          Unreachable -- STATUS2_UPROAR has no reader
//                           outside constants.ts; the case also needs
//                           CancelMultiTurnMoves/IsSoundproof, neither ported.
//   ENDTURN_THRASH          Unreachable -- STATUS2_LOCK_CONFUSE has no reader
//                           outside constants.ts; the case also needs
//                           SetMoveEffect/CancelMultiTurnMoves, neither ported.
//   ENDTURN_FLINCH          Gapped -- STATUS2_FLINCHED is read for real by
//                           attackCanceller.ts. The C unconditionally clears it
//                           every end of turn (:2771); not applied here (no
//                           mutation), gapped only when the bit is actually
//                           set, so a caller knows this port leaves a flinch
//                           flag standing past the turn that consumed it.
//   ENDTURN_DISABLE         Unreachable -- volatiles.disabledMove/disableTimer
//                           are named only in attackCanceller.ts's own
//                           "Unreachable" comment for CANCELLER_DISABLED, never
//                           read by executable code; same field, same verdict.
//   ENDTURN_ENCORE          Unreachable -- volatiles.encoreTimer/encoredMove
//                           have no reader outside create.ts's defaults.
//   ENDTURN_LOCK_ON         Unreachable -- STATUS3_ALWAYS_HITS IS read for
//                           real by accuracy.ts/accuracyBridge.ts, but
//                           accuracyBridge.ts's own gap note for it says "no
//                           sim code writes statuses3"; writing it here first,
//                           in a module that does not own that bridge's gap
//                           list, would silently stale that note rather than
//                           fix it. Left unreachable pending a batch that
//                           reconciles both.
//   ENDTURN_GHASTLY_ECHO    Gapped -- STATUS4_GHASTLY_ECHO is read for real by
//                           unpack.ts. Its paired ghastlyEchoTimer has no
//                           reader anywhere, so the exact expiry turn cannot be
//                           computed; gapped whenever the bit is set.
//   ENDTURN_COILED_UP       Gapped -- STATUS4_COILED and STATUS4_CUTTHROAT are
//                           both read for real by turnOrder.ts (priority).
//                           Gapped whenever either bit is set.
//   ENDTURN_TAUNT           Unreachable -- volatiles.tauntTimer is named only
//                           in attackCanceller.ts's "Unreachable" comment for
//                           CANCELLER_TAUNTED, never read by executable code.
//   ENDTURN_YAWN            Unreachable -- STATUS3_YAWN has no reader outside
//                           constants.ts.
//   ENDTURN_LASER_FOCUS     Unreachable -- STATUS3_LASER_FOCUS/laserFocusTimer
//                           have no reader outside constants.ts/create.ts.
//   ENDTURN_EMBARGO         Unreachable -- STATUS3_EMBARGO/embargoTimer have no
//                           reader outside constants.ts/create.ts.
//   ENDTURN_MAGNET_RISE     Gapped -- STATUS3_MAGNET_RISE is read for real by
//                           grounding.ts. Its paired magnetRiseTimer has no
//                           reader anywhere, so the exact expiry turn cannot be
//                           computed; gapped whenever the bit is set.
//   ENDTURN_TELEKINESIS     Gapped -- STATUS3_TELEKINESIS is read for real by
//                           grounding.ts, same telekinesisTimer caveat as
//                           MAGNET_RISE above.
//   ENDTURN_HEALBLOCK       Unreachable -- volatiles.healBlockTimer is named
//                           only in attackCanceller.ts's "Unreachable" comment
//                           for CANCELLER_HEAL_BLOCKED, never read by
//                           executable code. STATUS3_HEAL_BLOCK the packed bit
//                           has no reader either, EXCEPT inside this module's
//                           own canBattlerHeal (CanBattlerHeal, ported below
//                           for Poison Heal) -- that makes the bit reachable
//                           for canBattlerHeal's own purpose, but the ENDTURN_
//                           HEALBLOCK case itself (which would tick the paired
//                           timer down to clear it) stays Unreachable since the
//                           timer has no reader anywhere.
//   ENDTURN_ROOST           Unreachable -- gBattleResources->flags[]'s
//                           RESOURCE_FLAG_ROOST bit has no equivalent field in
//                           this state model at all.
//   ENDTURN_ELECTRIFY       Unreachable -- STATUS4_ELECTRIFIED has no reader
//                           outside constants.ts.
//   ENDTURN_POWDER          Gapped -- STATUS2_POWDER is read for real by
//                           attackCanceller.ts (CANCELLER_POWDER_STATUS). The C
//                           unconditionally clears it every end of turn
//                           (:2920); not applied here, gapped only when the bit
//                           is actually set.
//   ENDTURN_THROAT_CHOP     Unreachable -- volatiles.throatChopTimer is named
//                           only in attackCanceller.ts's "Unreachable" comment
//                           for CANCELLER_THROAT_CHOP, never read by
//                           executable code.
//   ENDTURN_SLOW_START      Gapped (timer sub-branch only) -- volatiles.
//                           slowStartTimer is read for real by bridge.ts/
//                           unpack.ts (itself NEVER_UPDATED there for the same
//                           "no sim code writes volatiles" reason as several
//                           accuracy fields). Gapped when slowStartTimer is
//                           nonzero and the battler holds ABILITY_SLOW_START or
//                           ABILITY_LETHARGY. The DISCIPLINE sub-branch
//                           (:2943-2952) is Unreachable: volatiles.
//                           disciplineCounter/gBattleStruct->choicedMove have
//                           no reader anywhere.
//   ENDTURN_PLASMA_FISTS    Unreachable -- STATUS4_PLASMA_FISTS has no reader
//                           outside constants.ts.
//   ENDTURN_GENERIC_BATTLER_TIMERS Gapped -- of its nine sub-fields,
//                           rapidResponse/showdownMode/violentRush/onTheProwl/
//                           dazed (turnOrder.ts) and trepidation
//                           (accuracy.ts/accuracyBridge.ts, itself
//                           NEVER_UPDATED there) are read for real; fear
//                           (STATUS4_FEAR) and readiedAction have no reader
//                           anywhere. Gapped, without the `.started` gating the
//                           C applies (that flag has no reader anywhere either,
//                           so this port cannot tell "began this turn" apart
//                           from "still active"), whenever any of the six real
//                           fields is nonzero/true.
//   ENDTURN_BATTLER_COUNT   The ladder's own terminal case (:2981-2985) --
//                           not a residual effect; ported as the loop's own
//                           per-battler advance, see runEndTurnEffects below.
//
// The pre-loop check at :2401, `AbilityBattleEffects(ABILITYEFFECT_REACTIVE,
// ...)` (Grudge's own reactive-ability trigger before the ladder even starts),
// is Unreachable: no AbilityBattleEffects/ABILITYEFFECT_REACTIVE port exists
// anywhere in this codebase.

import type { BattleState, BattlerState } from './state'
import type { SimDataContext } from './dataContext'
import { isAbilityAliveOnOpposingSide } from './turn'
import { battlerHasAbility } from '../abilities/dispatch'
import { hasFlag as abilitySlotsHaveFlag } from '../abilities/dispatchCalc'
import {
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS2_FLINCHED,
  STATUS2_NIGHTMARE,
  STATUS2_POWDER,
  STATUS3_HEAL_BLOCK,
  STATUS3_MAGNET_RISE,
  STATUS3_ROOTED,
  STATUS3_TELEKINESIS,
  STATUS4_COILED,
  STATUS4_CUTTHROAT,
  STATUS4_GHASTLY_ECHO,
  STATUS_FIELD_MAGIC_ROOM,
  getCounter,
  hasFlag,
  setCounter,
} from './constants'

/** ItemBattleEffects's `case 1:` body (ENDTURN_ITEMS1/ENDTURN_ITEMS2, both call
 * sites), battle_util.c:5622-5855 -- every HOLD_EFFECT_* switched on there,
 * transcribed by name (used only to decide when to emit the gap line, never to
 * apply a value -- same precedent as attackCanceller.ts's
 * HIT_COUNT_OVERRIDE_MOVES). */
const ITEMS_1_2_HOLD_EFFECTS = new Set([
  'HOLD_EFFECT_RESTORE_HP',
  'HOLD_EFFECT_HONEY',
  'HOLD_EFFECT_RESTORE_PCT_HP',
  'HOLD_EFFECT_RESTORE_PP',
  'HOLD_EFFECT_RESTORE_STATS',
  'HOLD_EFFECT_BLACK_SLUDGE',
  'HOLD_EFFECT_LEFTOVERS',
  'HOLD_EFFECT_CONFUSE_SPICY',
  'HOLD_EFFECT_CONFUSE_DRY',
  'HOLD_EFFECT_CONFUSE_SWEET',
  'HOLD_EFFECT_CONFUSE_BITTER',
  'HOLD_EFFECT_CONFUSE_SOUR',
  'HOLD_EFFECT_ATTACK_UP',
  'HOLD_EFFECT_DEFENSE_UP',
  'HOLD_EFFECT_SPEED_UP',
  'HOLD_EFFECT_SP_ATTACK_UP',
  'HOLD_EFFECT_SP_DEFENSE_UP',
  'HOLD_EFFECT_CRITICAL_UP',
  'HOLD_EFFECT_RANDOM_STAT_UP',
  'HOLD_EFFECT_CURE_PAR',
  'HOLD_EFFECT_CURE_PSN',
  'HOLD_EFFECT_CURE_BRN',
  'HOLD_EFFECT_CURE_FRZ',
  'HOLD_EFFECT_CURE_SLP',
  'HOLD_EFFECT_CURE_CONFUSION',
  'HOLD_EFFECT_CURE_STATUS',
  'HOLD_EFFECT_MENTAL_HERB',
  'HOLD_EFFECT_MICLE_BERRY',
])

/** ITEMEFFECT_ORBS's own switch, battle_util.c:6252-6288. */
const ORBS_HOLD_EFFECTS = new Set(['HOLD_EFFECT_TOXIC_ORB', 'HOLD_EFFECT_FLAME_ORB', 'HOLD_EFFECT_FROST_ORB', 'HOLD_EFFECT_STICKY_BARB'])

/** abilityHooks.json (data/v2.65beta, pinned SHA) -- every ability id whose
 * `hooks.onEndTurn` is present, read once during porting rather than looked up
 * at runtime (same precedent as HIT_COUNT_OVERRIDE_MOVES above). Used only to
 * decide when ENDTURN_ABILITIES's gap line fires. */
const ENDTURN_ABILITY_IDS = new Set([
  'ABILITY_ACID_REFLUX',
  'ABILITY_APE_SHIFT',
  'ABILITY_APPLE_PIE',
  'ABILITY_BAD_DREAMS',
  'ABILITY_BIG_LEAVES',
  'ABILITY_BLOOD_PRICE',
  'ABILITY_CARETAKER',
  'ABILITY_CELESTIAL_BLESSING',
  'ABILITY_CHOKEHOLD',
  'ABILITY_CHRISTMAS_NIGHTMARE',
  'ABILITY_COLOR_SPECTRUM',
  'ABILITY_COOL_EXIT',
  'ABILITY_CRAVING',
  'ABILITY_CRYO_ARCHITECT',
  'ABILITY_CUD_CHEW',
  'ABILITY_DRY_SKIN',
  'ABILITY_DUAL_SHADOW',
  'ABILITY_DUNE_VEIL',
  'ABILITY_ETERNAL_BLESSING',
  'ABILITY_FLAME_COAT',
  'ABILITY_FLOWER_GIFT',
  'ABILITY_FORECAST',
  'ABILITY_FUNERAL_PYRE',
  'ABILITY_HARVEST',
  'ABILITY_HEALER',
  'ABILITY_HOME_RUN',
  'ABILITY_HONEY_GATHER',
  'ABILITY_HUNGER_SWITCH',
  'ABILITY_HYDRATION',
  'ABILITY_ICE_BODY',
  'ABILITY_LEAF_GUARD',
  'ABILITY_LIFE_STEAL',
  'ABILITY_LOCUST_SWARM',
  'ABILITY_MAXIMUM_ACCELERATION',
  'ABILITY_MOODY',
  'ABILITY_PATTERN_CHANGE',
  'ABILITY_PEACEFUL_REST',
  'ABILITY_PEACEFUL_SLUMBER',
  'ABILITY_POISON_ABSORB',
  'ABILITY_POWER_CONSTRUCT',
  'ABILITY_PURIFYING_WATERS',
  'ABILITY_RAIN_DISH',
  'ABILITY_REVELATION',
  'ABILITY_SAP_TRAP',
  'ABILITY_SCHOOLING',
  'ABILITY_SELF_REPAIR',
  'ABILITY_SELF_SUFFICIENT',
  'ABILITY_SERPENT_BIND',
  'ABILITY_SHED_SKIN',
  'ABILITY_SHIELDS_DOWN',
  'ABILITY_SOOTHSAYER',
  'ABILITY_SOUL_TAP',
  'ABILITY_SPEED_BOOST',
  'ABILITY_STRIKEOUT',
  'ABILITY_SUMO_WRESTLER',
  'ABILITY_SUNDAE',
  'ABILITY_SUNS_BOUNTY',
  'ABILITY_SWEET_DREAMS',
  'ABILITY_TALON_TRAP',
  'ABILITY_TENTALOCK',
  'ABILITY_TOXIC_SPILL',
  'ABILITY_TRASH_HEAP',
  'ABILITY_TRUANT',
  'ABILITY_WHITE_NOISE',
  'ABILITY_WINTER_THRONE',
  'ABILITY_WONDER_SCALE',
  'ABILITY_ZEN_MODE',
])

const NO_SUPPRESSION = () => false

/** IsMagicGuardProtected, battle_util.c:8923-8928. The `magicGuard` ability
 * flag is the same one dispatchCalc.ts's hasFlag already serves elsewhere
 * (Magic Guard, Chestnut Shield, ...); this reuses it rather than duplicating
 * a lookup, per this batch's own instruction to check for an existing
 * predicate first. `isMagicRoomActive()`'s own gFieldStatuses bit is real,
 * externally-settable state (STATUS_FIELD_MAGIC_ROOM lives in the same
 * `field.statuses` word grounding.ts already reads for STATUS_FIELD_GRAVITY),
 * so it is applied for real below -- MINUS isMagicRoomActive's own
 * IsAbilityOnField(ABILITY_CLUELESS) exemption, which needs a whole-field
 * ability scan this codebase has no shared helper for yet (grounding.ts's own
 * isCluelessOnField is a caller-supplied fact for exactly this reason, not
 * computed in sim/). A Clueless-on-field battle where Magic Room is up will
 * therefore incorrectly treat every battler as Magic-Guard-protected here. */
export function isMagicGuardProtected(state: BattleState, battler: BattlerState): boolean {
  if (abilitySlotsHaveFlag(battler.mon.abilities, 'magicGuard')) return true
  return hasFlag(state.field.statuses, STATUS_FIELD_MAGIC_ROOM)
}

/** TakesNoBurnDamage, battle_util.c:2374-2377 -- RETURN_ABILITY_IF_FLAG(battler,
 * FALSE, noBurnDamage). The five abilities carrying this bitfield in
 * abilityHooks.json (Heatproof, Flare Boost, Droideka, Iron Giant, Thermal
 * Entropy) had the field declared in AbilityFlags but never set on any
 * registry entry until this batch -- see this batch's edits to
 * 02-defensive-multiplier-a.ts, 14-on-stat-a.ts, 10-aliases.ts and
 * 13-defensive-multiplier-c.ts. */
function takesNoBurnDamage(battler: BattlerState): boolean {
  return abilitySlotsHaveFlag(battler.mon.abilities, 'noBurnDamage')
}

/** IsBloodStainAffected, battle_util.c:9000-9004 -- own types, own ability,
 * both always-real state, so computed for real rather than gapped. */
function isBloodStainAffected(battler: BattlerState): boolean {
  if (battler.mon.types.includes('GHOST')) return false
  if (battler.mon.types.includes('ROCK')) return false
  return battlerHasAbility(battler.mon.abilities, 'ABILITY_BLOOD_STAIN', NO_SUPPRESSION)
}

/** CanBattlerHeal, battle_util.c:8979-8986 -- every clause is real state:
 * STATUS3_HEAL_BLOCK (packed statuses3 bit), STATUS1_BLEED, IsBloodStainAffected
 * (above) and IsAbilityOnOpposingSide (turn.ts's isAbilityAliveOnOpposingSide,
 * exported for this reuse) for Permanence/Hemolysis. IsAbilityOnOpposingSide's
 * own mold-breaker exception (IsAbilityOnSide's checkMoldBreaker=TRUE,
 * battle_util.c:4793/4795) is NOT applied here -- isAbilityAliveOnOpposingSide
 * already documents this gap at its own call site in turn.ts (the Pressure
 * check); same treatment, only surfaced here when Permanence or Hemolysis is
 * actually found on the opposing side. */
function canBattlerHeal(state: BattleState, battlerId: number, battler: BattlerState, unmodelled: string[]): boolean {
  if (hasFlag(battler.statuses3, STATUS3_HEAL_BLOCK)) return false
  if (hasFlag(battler.mon.status1, STATUS1_BLEED)) return false
  if (isBloodStainAffected(battler)) return false
  if (isAbilityAliveOnOpposingSide(state, battlerId, 'ABILITY_PERMANENCE')) {
    unmodelled.push(
      "CanBattlerHeal's IsAbilityOnOpposingSide(ABILITY_PERMANENCE) (battle_util.c:8983) found Permanence without its own mold-breaker suppression (IsAbilityOnSide's checkMoldBreaker=TRUE, battle_util.c:4793) applied; a Mold-Breaker-class attacker would bypass Permanence's healing block here",
    )
    return false
  }
  if (hasFlag(battler.mon.status1, STATUS1_POISON) || hasFlag(battler.mon.status1, STATUS1_TOXIC_POISON)) {
    if (isAbilityAliveOnOpposingSide(state, battlerId, 'ABILITY_HEMOLYSIS')) {
      unmodelled.push(
        "CanBattlerHeal's IsAbilityOnOpposingSide(ABILITY_HEMOLYSIS) (battle_util.c:8984) found Hemolysis without its own mold-breaker suppression (IsAbilityOnSide's checkMoldBreaker=TRUE, battle_util.c:4793) applied; a Mold-Breaker-class attacker would bypass Hemolysis's healing block here",
      )
      return false
    }
  }
  return true
}

/** One residual HP effect from the end-of-turn ladder. Separate from turn.ts's
 * ActionOutcome[] -- see turn.ts's own executeTurn for where this is folded
 * into TurnOutcome. */
export interface EndTurnEffectResult {
  battlerId: number
  /** 'SANDSTORM'/'HAIL' are the field ladder's own entries (fieldEndTurn.ts's
   * Cmd_weatherdamage port) -- reusing this same shape rather than a parallel
   * one, since both are "one residual HP effect for one battler". */
  effect: 'POISON' | 'TOXIC' | 'BURN' | 'SANDSTORM' | 'HAIL'
  /** HP change applied to the battler: negative is damage, positive is a heal
   * (Poison Heal). Already floored/capped against 0..maxHp by the caller. */
  hpChange: number
  /** True when this effect brought the battler to 0 HP. */
  fainted: boolean
}

/** Applies `hpChange` to a battler, floors at 0 and caps at maxHp (Poison
 * Heal's own heal branch never overheals -- CanBattlerHeal / BATTLER_MAX_HP
 * already gate it in the caller, but this stays defensive rather than trusting
 * that gate never changes). Mirrors turn.ts's own applyDamage/fainted
 * bookkeeping (state.sides[..].faintedCount). */
function applyEndTurnHp(state: BattleState, battlerId: number, battler: BattlerState, hpChange: number): boolean {
  const next = Math.max(0, Math.min(battler.mon.maxHp, battler.mon.hp + hpChange))
  battler.mon.hp = next
  if (next === 0) {
    state.sides[battlerId & 1].faintedCount++
    return true
  }
  return false
}

/** ENDTURN_POISON / ENDTURN_BAD_POISON's shared Poison Heal branch,
 * battle_util.c:2497-2505 / :2522-2530 -- identical in both cases. Returns
 * null when Poison Heal's own REQUIRE guards (not at max HP, CanBattlerHeal)
 * fail, matching the C's `break` (tracker already advanced by the caller;
 * nothing happens this case). */
function poisonHealBranch(state: BattleState, battlerId: number, battler: BattlerState, unmodelled: string[]): number | null {
  if (battler.mon.hp === battler.mon.maxHp) return null // BATTLER_MAX_HP, :2498/:2523
  if (!canBattlerHeal(state, battlerId, battler, unmodelled)) return null
  const heal = Math.max(1, Math.trunc(battler.mon.maxHp / 8))
  return heal // positive: a heal
}

/** ENDTURN_POISON, battle_util.c:2492-2515. */
function runPoison(state: BattleState, battlerId: number, battler: BattlerState, unmodelled: string[]): EndTurnEffectResult | null {
  if (!hasFlag(battler.mon.status1, STATUS1_POISON)) return null // REQUIRE, :2494
  if (battler.mon.hp === 0) return null // REQUIRE(IsBattlerAlive), :2495

  let hpChange: number
  if (battlerHasAbility(battler.mon.abilities, 'ABILITY_POISON_HEAL', NO_SUPPRESSION)) {
    const heal = poisonHealBranch(state, battlerId, battler, unmodelled)
    if (heal === null) return null
    hpChange = heal
  } else {
    if (isMagicGuardProtected(state, battler)) return null // REQUIRE_NOT, :2507
    if (battlerHasAbility(battler.mon.abilities, 'ABILITY_TOXIC_BOOST', NO_SUPPRESSION)) return null // REQUIRE_NOT, :2508
    hpChange = -Math.max(1, Math.trunc(battler.mon.maxHp / 8)) // :2510-2511
  }

  const fainted = applyEndTurnHp(state, battlerId, battler, hpChange)
  return { battlerId, effect: 'POISON', hpChange, fainted }
}

/** ENDTURN_BAD_POISON, battle_util.c:2516-2544. The toxic counter increment
 * (:2532-2533) happens ONLY in the non-Poison-Heal branch, and BEFORE the
 * damage read (:2540 reads status1 AFTER the increment) -- both ported
 * exactly in that order. */
function runBadPoison(state: BattleState, battlerId: number, battler: BattlerState, unmodelled: string[]): EndTurnEffectResult | null {
  if (!hasFlag(battler.mon.status1, STATUS1_TOXIC_POISON)) return null // REQUIRE, :2519
  if (battler.mon.hp === 0) return null // REQUIRE(IsBattlerAlive), :2520

  let hpChange: number
  if (battlerHasAbility(battler.mon.abilities, 'ABILITY_POISON_HEAL', NO_SUPPRESSION)) {
    const heal = poisonHealBranch(state, battlerId, battler, unmodelled)
    if (heal === null) return null
    hpChange = heal
  } else {
    // :2532-2533 -- counter caps at 15 (STATUS1_TOXIC_TURN(15)); increments by
    // 1 otherwise. Applied to status1 before the damage read below.
    const counter = getCounter(battler.mon.status1, STATUS1_TOXIC_COUNTER)
    if (counter !== 15) {
      battler.mon.status1 = setCounter(battler.mon.status1, STATUS1_TOXIC_COUNTER, counter + 1)
    }

    if (isMagicGuardProtected(state, battler)) return null // REQUIRE_NOT, :2535
    if (battlerHasAbility(battler.mon.abilities, 'ABILITY_TOXIC_BOOST', NO_SUPPRESSION)) return null // REQUIRE_NOT, :2536

    // :2538-2540. `(status1 & MASK) * dmgPerTurn >> 8` with MASK already
    // positioned at bit 8 is exactly `counter * dmgPerTurn` -- see this
    // module's header on getCounter/setCounter for why the raw C bit
    // arithmetic and the decoded counter agree.
    const dmgPerTurn = Math.max(1, Math.trunc(battler.mon.maxHp / 16))
    const newCounter = getCounter(battler.mon.status1, STATUS1_TOXIC_COUNTER)
    hpChange = -(newCounter * dmgPerTurn)
  }

  const fainted = applyEndTurnHp(state, battlerId, battler, hpChange)
  return { battlerId, effect: 'TOXIC', hpChange, fainted }
}

/** ENDTURN_BURN, battle_util.c:2573-2582. B_BURN_DAMAGE is pinned to GEN_7 in
 * this C (include/constants/battle_config.h:36), so the ternary always takes
 * the /16 branch -- there is no separate Elite Redux burn-fraction override to
 * port; transcribed as the one live branch rather than as a dead ternary. */
function runBurn(state: BattleState, battlerId: number, battler: BattlerState): EndTurnEffectResult | null {
  if (!hasFlag(battler.mon.status1, STATUS1_BURN)) return null
  if (battler.mon.hp === 0) return null
  if (takesNoBurnDamage(battler)) return null
  if (isMagicGuardProtected(state, battler)) return null // MAGIC_GUARD_CHECK, :2575

  const hpChange = -Math.max(1, Math.trunc(battler.mon.maxHp / 16)) // :2577-2578
  const fainted = applyEndTurnHp(state, battlerId, battler, hpChange)
  return { battlerId, effect: 'BURN', hpChange, fainted }
}

/** Pushes an unmodelled line for a "gapped at runtime" case, but only when its
 * real C condition is actually true for this battler -- see this module's
 * header table. Kept as one small helper so every gap call site reads the
 * same way. */
function gapIf(condition: boolean, unmodelled: string[], message: string): void {
  if (condition) unmodelled.push(message)
}

/**
 * Runs every ENDTURN_* case this batch supports, for every battler, in
 * `battlerOrder` (this turn's own gBattlerByTurnOrder -- see this module's
 * header). One battler completes its ENTIRE ladder pass before the next
 * battler is even looked at, matching the C's own turnEffectsBattlerId/
 * turnEffectsTracker nesting.
 */
export function runEndTurnEffects(state: BattleState, battlerOrder: readonly number[], dataContext: SimDataContext): { results: EndTurnEffectResult[]; unmodelled: string[] } {
  const results: EndTurnEffectResult[] = []
  const unmodelled: string[] = []

  for (const battlerId of battlerOrder) {
    if (hasFlag(state.absentBattlerFlags, 1 << battlerId)) continue // :2409-2412
    const battler = state.battlers[battlerId]
    if (!battler) continue

    // ENDTURN_INGRAIN, :2426-2434.
    gapIf(
      hasFlag(battler.statuses3, STATUS3_ROOTED) &&
        battler.mon.hp !== 0 &&
        battler.mon.hp !== battler.mon.maxHp &&
        canBattlerHeal(state, battlerId, battler, unmodelled),
      unmodelled,
      `battler ${battlerId}: ENDTURN_INGRAIN (battle_util.c:2426-2434) is not applied -- Ingrain's maxHP/8 heal was skipped`,
    )

    // ENDTURN_ABILITIES, :2452-2459 -- the battler's OWN ability slot only
    // (AbilityBattleEffects(ABILITYEFFECT_ENDTURN, battler, ...) reads
    // gBattleMons[battler].ability, never the innate slots).
    const ownAbility = battler.mon.abilities.ability
    gapIf(
      ownAbility !== null && ENDTURN_ABILITY_IDS.has(ownAbility),
      unmodelled,
      `battler ${battlerId}: ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied -- ${ownAbility}'s onEndTurn hook was not run`,
    )

    // ENDTURN_ITEMS1 / ENDTURN_ITEMS2, :2460-2467.
    const heldEffect = battler.mon.itemId ? (dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null) : null
    gapIf(
      heldEffect !== null && ITEMS_1_2_HOLD_EFFECTS.has(heldEffect),
      unmodelled,
      `battler ${battlerId}: ENDTURN_ITEMS1/ENDTURN_ITEMS2 (battle_util.c:5622-5855) are not applied -- ${battler.mon.itemId}'s end-of-turn hold effect (${heldEffect}) was not run`,
    )

    // ENDTURN_ORBS, :2468-2471.
    gapIf(
      heldEffect !== null && ORBS_HOLD_EFFECTS.has(heldEffect),
      unmodelled,
      `battler ${battlerId}: ENDTURN_ORBS (battle_util.c:6252-6288) is not applied -- ${battler.mon.itemId}'s orb effect (${heldEffect}) was not run`,
    )

    const poison = runPoison(state, battlerId, battler, unmodelled)
    if (poison) results.push(poison)
    const badPoison = poison ? null : runBadPoison(state, battlerId, battler, unmodelled)
    if (badPoison) results.push(badPoison)

    // ENDTURN_FROSTBITE, :2584-2596 -- same shape as BURN, out of this batch's
    // requested scope.
    gapIf(
      hasFlag(battler.mon.status1, STATUS1_FROSTBITE) && battler.mon.hp !== 0,
      unmodelled,
      `battler ${battlerId}: ENDTURN_FROSTBITE (battle_util.c:2584-2596) is not applied -- frostbite damage was skipped`,
    )

    // ENDTURN_BLEED, :2598-2607.
    gapIf(
      (hasFlag(battler.mon.status1, STATUS1_BLEED) || isBloodStainAffected(battler)) && battler.mon.hp !== 0,
      unmodelled,
      `battler ${battlerId}: ENDTURN_BLEED (battle_util.c:2598-2607) is not applied -- bleed damage was skipped`,
    )

    // ENDTURN_NIGHTMARES, :2608-2622 -- only the damage sub-branch (asleep) is
    // gapped; the silent-clear sub-branch (awake) has no numeric consequence.
    gapIf(
      hasFlag(battler.mon.status2, STATUS2_NIGHTMARE) && battler.mon.hp !== 0 && hasFlag(battler.mon.status1, STATUS1_SLEEP),
      unmodelled,
      `battler ${battlerId}: ENDTURN_NIGHTMARES (battle_util.c:2608-2622) is not applied -- maxHP/4 nightmare damage was skipped`,
    )

    const burn = runBurn(state, battlerId, battler)
    if (burn) results.push(burn)

    // ENDTURN_FLINCH, :2770-2772 -- the C clears STATUS2_FLINCHED
    // unconditionally every end of turn; not applied here.
    gapIf(
      hasFlag(battler.mon.status2, STATUS2_FLINCHED),
      unmodelled,
      `battler ${battlerId}: ENDTURN_FLINCH (battle_util.c:2770-2772) is not applied -- the flinch flag was not cleared`,
    )

    // ENDTURN_GHASTLY_ECHO, :2813-2816.
    gapIf(
      hasFlag(battler.statuses4, STATUS4_GHASTLY_ECHO),
      unmodelled,
      `battler ${battlerId}: ENDTURN_GHASTLY_ECHO (battle_util.c:2813-2816) is not applied -- ghastlyEchoTimer has no reader anywhere, so its expiry cannot be computed`,
    )

    // ENDTURN_COILED_UP, :2818-2829.
    gapIf(
      hasFlag(battler.statuses4, STATUS4_COILED) || hasFlag(battler.statuses4, STATUS4_CUTTHROAT),
      unmodelled,
      `battler ${battlerId}: ENDTURN_COILED_UP (battle_util.c:2818-2829) is not applied -- STATUS4_COILED/STATUS4_CUTTHROAT were not cleared`,
    )

    // ENDTURN_MAGNET_RISE, :2875-2884.
    gapIf(
      hasFlag(battler.statuses3, STATUS3_MAGNET_RISE),
      unmodelled,
      `battler ${battlerId}: ENDTURN_MAGNET_RISE (battle_util.c:2875-2884) is not applied -- magnetRiseTimer has no reader anywhere, so its expiry cannot be computed`,
    )

    // ENDTURN_TELEKINESIS, :2886-2894.
    gapIf(
      hasFlag(battler.statuses3, STATUS3_TELEKINESIS),
      unmodelled,
      `battler ${battlerId}: ENDTURN_TELEKINESIS (battle_util.c:2886-2894) is not applied -- telekinesisTimer has no reader anywhere, so its expiry cannot be computed`,
    )

    // ENDTURN_POWDER, :2919-2921 -- the C clears STATUS2_POWDER unconditionally
    // every end of turn; not applied here.
    gapIf(
      hasFlag(battler.mon.status2, STATUS2_POWDER),
      unmodelled,
      `battler ${battlerId}: ENDTURN_POWDER (battle_util.c:2919-2921) is not applied -- the powder flag was not cleared`,
    )

    // ENDTURN_SLOW_START, :2930-2941 -- timer sub-branch only.
    gapIf(
      battler.volatiles.slowStartTimer !== 0 &&
        (battlerHasAbility(battler.mon.abilities, 'ABILITY_SLOW_START', NO_SUPPRESSION) ||
          battlerHasAbility(battler.mon.abilities, 'ABILITY_LETHARGY', NO_SUPPRESSION)),
      unmodelled,
      `battler ${battlerId}: ENDTURN_SLOW_START's timer sub-branch (battle_util.c:2930-2941) is not applied -- slowStartTimer was not decremented`,
    )

    // ENDTURN_GENERIC_BATTLER_TIMERS, :2960-2979 -- six of its nine sub-fields
    // are real elsewhere (see header); gapped without the `.started` gating
    // the C applies, since that flag has no reader anywhere either.
    gapIf(
      battler.volatiles.rapidResponse ||
        battler.volatiles.showdownMode ||
        battler.volatiles.violentRush ||
        battler.volatiles.onTheProwl ||
        battler.volatiles.dazed !== 0 ||
        battler.volatiles.trepidation !== 0,
      unmodelled,
      `battler ${battlerId}: ENDTURN_GENERIC_BATTLER_TIMERS (battle_util.c:2960-2979) is not applied -- one-turn volatile timers were not cleared/decremented`,
    )
  }

  return { results, unmodelled }
}
