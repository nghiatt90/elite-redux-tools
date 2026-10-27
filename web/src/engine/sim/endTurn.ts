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
//   ENDTURN_INGRAIN         Ported (:2426-2434) -- heals maxHP/8 at end of turn
//                           with Big Root / Absorbant bonus.
//   ENDTURN_AQUA_RING       Ported (:2435-2443) -- heals maxHP/16 at end of turn
//                           with Big Root / Absorbant bonus.
//   ENDTURN_SYRUP           Ported (:2444-2450) plus BattleScript_SyrupDropsSpeed
//                           (Speed -1 stage, gates, syrupTimer decrement).
//   ENDTURN_ABILITIES       PORTED (subset) / Gapped -- AbilityBattleEffects(
//                           ENDTURN,...) (:4397-4399) runs HandleEndTurnAbility
//                           (:9213-9239) walking slots from GetNumPossibleAbilitiesForBattler()
//                           down to 0 (innates[2], innates[1], innates[0], ability).
//                           Skips fainted (hp===0, :9217) and suppressed abilities
//                           (isSimAbilitySuppressed, :9233). Ported hooks:
//                           Speed Boost (and Maximum Acceleration), Rain Dish,
//                           Ice Body (and Sundae), Dry Skin, Hydration (and
//                           Purifying Waters), Shed Skin (and Pattern Change,
//                           Wonder Scale), Self-Sufficient (and Self-Repair,
//                           Apple Pie, Dune Veil), Poison Absorb. Unported
//                           hooks remain conditionally gapped (ENDTURN_ABILITY_IDS).
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
//   ENDTURN_LEECH_SEED      PORTED.
//   ENDTURN_TOXIC_WASTE_DAMAGE Unreachable -- gated on getMonotypeChampType(),
//                           which exists only as an external fact threaded
//                           into TurnOrderContext/GroundingContext (grounding.
//                           ts's own isCluelessOnField precedent), not as a
//                           BattleState/BattlerState field this function's own
//                           input surface can read.
//   ENDTURN_POISON          PORTED.
//   ENDTURN_BAD_POISON      PORTED.
//   ENDTURN_SEA_OF_FIRE_DAMAGE Ported (:2545-2562) -- maxHP/8 damage to non-Fire
//                           battlers without Magic Guard / Flare Boost on the side with fireSeaTimer.
//   ENDTURN_PARASITIC_SPORES_DAMAGE Ported (:2561-2570) -- maxHP/8 to non-Ghost
//                           battlers without Magic Guard when volatiles.parasiticSpores is set.
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
//   ENDTURN_SALT_CURE       Ported (:2634-2648) -- STATUS4_SALT_CURE damage (1/4 for
//                           Water/Steel else 1/8, Magic Guard); monotype-champion
//                           Rock condition is unmodelled external fact.
//   ENDTURN_WRAP             Unreachable -- STATUS2_WRAPPED/wrapTurns/
//                           wrapAbility have no reader outside constants.ts/
//                           create.ts; the monotype-champion sub-condition is
//                           unreachable for the same reason as above.
//   ENDTURN_OCTOLOCK        Ported (:2708-2716) plus BattleScript_OctolockEndTurn
//                           (Def and SpDef -1, gates IsStatDropBlocked, Clear Amulet).
//   ENDTURN_UPROAR          Unreachable -- STATUS2_UPROAR has no reader
//                           outside constants.ts; the case also needs
//                           CancelMultiTurnMoves/IsSoundproof, neither ported.
//   ENDTURN_THRASH          Unreachable -- STATUS2_LOCK_CONFUSE has no reader
//                           outside constants.ts; the case also needs
//                           SetMoveEffect/CancelMultiTurnMoves, neither ported.
//   ENDTURN_FLINCH          Ported -- battle_util.c:2770-2772: unconditionally
//                           clears STATUS2_FLINCHED every end of turn.
//   ENDTURN_DISABLE         Ported (:2774-2791) -- decrements disableTimer;
//                           clears disabledMove when timer reaches 0 or move is
//                           forgotten.
//   ENDTURN_ENCORE          Ported (:2792-2808) -- decrements encoreTimer;
//                           clears encoredMove when timer reaches 0, PP is 0,
//                           or move is forgotten.
//   ENDTURN_LOCK_ON         Ported (:2809-2812) -- decrements STATUS3_ALWAYS_HITS
//                           counter by STATUS3_ALWAYS_HITS_TURN(1).
//   ENDTURN_GHASTLY_ECHO    Ported (:2813-2816) -- ghastlyEchoTimer (written by
//                           turn.ts when Ghastly Echo's switch-in sets the status)
//                           counts down and clears STATUS4_GHASTLY_ECHO at 0.
//   ENDTURN_COILED_UP       Gapped -- STATUS4_COILED and STATUS4_CUTTHROAT are
//                           both read for real by turnOrder.ts (priority).
//                           Gapped whenever either bit is set.
//   ENDTURN_TAUNT           Ported (:2831-2838) -- decrements tauntTimer until 0.
//   ENDTURN_YAWN            Ported (:2839-2854) -- drowsiness countdown and
//                           sleep on 0 turns remaining if CanSleep is true.
//   ENDTURN_LASER_FOCUS     Ported (:2855-2861) -- decrements laserFocusTimer;
//                           clears STATUS3_LASER_FOCUS at 0.
//   ENDTURN_EMBARGO         Ported (:2862-2874) -- decrements embargoTimer,
//                           clears STATUS3_EMBARGO at 0, clears
//                           substituteDestroyedThisTurn.
//   ENDTURN_MAGNET_RISE     Ported (:2875-2884) -- decrements magnetRiseTimer;
//                           clears STATUS3_MAGNET_RISE at 0.
//   ENDTURN_TELEKINESIS     Ported (:2886-2894) -- decrements telekinesisTimer;
//                           clears STATUS3_TELEKINESIS at 0.
//   ENDTURN_HEALBLOCK       Ported (:2896-2906) -- decrements healBlockTimer,
//                           clears STATUS3_HEAL_BLOCK when timer reaches 0.
//   ENDTURN_ROOST           PORTED -- clears RESOURCE_FLAG_ROOST and restores
//                           original types from battler.roostTypes (:2907-2914).
//   ENDTURN_ELECTRIFY       Ported (:2915-2918) -- clears STATUS4_ELECTRIFIED at end of turn.
//   ENDTURN_POWDER          Ported (:2919-2921) -- unconditionally clears
//                           STATUS2_POWDER every end of turn.
//   ENDTURN_THROAT_CHOP     Ported (:2923-2929) -- decrements volatiles.throatChopTimer.
//   ENDTURN_SLOW_START      Ported (timer decrement, :2930-2941) -- decrements
//                           volatiles.slowStartTimer when > 0. The DISCIPLINE
//                           sub-branch (:2943-2952) is Unreachable: volatiles.
//                           disciplineCounter/gBattleStruct->choicedMove have
//                           no reader anywhere.
//   ENDTURN_PLASMA_FISTS    Ported (:2956-2959) -- clears STATUS4_PLASMA_FISTS; the
//                           reader is calculate.ts's attackerPlasmaFists.
//   ENDTURN_GENERIC_BATTLER_TIMERS Gapped (subset ported) -- fear (STATUS4_FEAR /
//                           volatiles.fear) cleared when !started.fear (:2961-2964);
//                           trepidation timer decremented. Other volatile timers
//                           remain gapped.
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
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import { battlerSide } from './turnOrder'
import type { StatusDeps } from './statusEffects'
import { canBeBurned, canBeConfused, canBePoisoned, canGetFrostbite, canSleep, cancelMultiTurnMoves, isBattlerTerrainAffected } from './statusEffects'
import { isAbilityAliveOnOpposingSide } from './turn'
import { computeBattleOutcome, syncPartyHp } from './outcome'
import { battlerHasAbility } from '../abilities/dispatch'
import { hasFlag as abilitySlotsHaveFlag } from '../abilities/dispatchCalc'
import { changeStatBuffs, changeStatBuffsImplicit, hasClearAmulet, isBattlerWeatherAffected, isSimAbilitySuppressed, isStatDropBlocked, MOVE_EFFECT_AFFECTS_USER, runReactiveAbilityEffects, STAT_BUFF_ALLOW_PTR } from './statBuffs'
import {
  STAT_DEF,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_ANY,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS2_FLINCHED,
  STATUS2_CURSED,
  STATUS2_CONFUSION,
  STATUS2_LOCK_CONFUSE,
  STATUS2_MULTIPLETURNS,
  STATUS2_NIGHTMARE,
  STATUS2_WRAPPED,
  STATUS2_POWDER,
  STATUS3_ALWAYS_HITS,
  STATUS3_ALWAYS_HITS_TURN,
  STATUS3_AQUA_RING,
  STATUS3_EMBARGO,
  STATUS3_HEAL_BLOCK,
  STATUS3_LASER_FOCUS,
  STATUS3_LEECHSEED,
  STATUS3_LEECHSEED_BATTLER,
  RESOURCE_FLAG_ROOST,
  STATUS3_MAGNET_RISE,
  STATUS3_ROOTED,
  STATUS3_SEMI_INVULNERABLE,
  STATUS3_TELEKINESIS,
  STATUS3_YAWN,
  STATUS4_COILED,
  STATUS4_CUTTHROAT,
  STATUS4_ELECTRIFIED,
  STATUS4_PLASMA_FISTS,
  STATUS4_FEAR,
  STATUS4_GHASTLY_ECHO,
  STATUS4_SALT_CURE,
  STATUS_FIELD_MAGIC_ROOM,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_HAIL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_FOG_ANY,
  WEATHER_SUN_ANY,
  clearFlag,
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

/** abilityHooks.json (data/v2.65beta, pinned SHA) -- unported ability ids whose
 * `hooks.onEndTurn` is present, read once during porting rather than looked up
 * at runtime (same precedent as HIT_COUNT_OVERRIDE_MOVES above). Used only to
 * decide when ENDTURN_ABILITIES's gap line fires for unported hooks. */
const ENDTURN_ABILITY_IDS = new Set([
  'ABILITY_ACID_REFLUX',
  'ABILITY_APE_SHIFT',
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
  'ABILITY_DUAL_SHADOW',
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
  'ABILITY_LEAF_GUARD',
  'ABILITY_LIFE_STEAL',
  'ABILITY_LOCUST_SWARM',
  'ABILITY_MOODY',
  'ABILITY_PEACEFUL_REST',
  'ABILITY_PEACEFUL_SLUMBER',
  'ABILITY_POWER_CONSTRUCT',
  'ABILITY_REVELATION',
  'ABILITY_SAP_TRAP',
  'ABILITY_SCHOOLING',
  'ABILITY_SERPENT_BIND',
  'ABILITY_SHIELDS_DOWN',
  'ABILITY_SOOTHSAYER',
  'ABILITY_SOUL_TAP',
  'ABILITY_STRIKEOUT',
  'ABILITY_SUMO_WRESTLER',
  'ABILITY_SUNS_BOUNTY',
  'ABILITY_SWEET_DREAMS',
  'ABILITY_TALON_TRAP',
  'ABILITY_TENTALOCK',
  'ABILITY_TOXIC_SPILL',
  'ABILITY_TRASH_HEAP',
  'ABILITY_TRUANT',
  'ABILITY_WHITE_NOISE',
  'ABILITY_WINTER_THRONE',
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
/** The `jumpifhealingblocked` macro (asm/macros/battle_script.inc:2493-2510):
 * CanBattlerHeal (battle_util.c:8979-8986) minus its STATUS1_BLEED clause. */
export function isHealingBlocked(state: BattleState, battlerId: number, battler: BattlerState, unmodelled: string[]): boolean {
  const status1 = battler.mon.status1
  battler.mon.status1 = clearFlag(status1, STATUS1_BLEED)
  const blocked = !canBattlerHeal(state, battlerId, battler, unmodelled)
  battler.mon.status1 = status1
  return blocked
}

export function canBattlerHeal(state: BattleState, battlerId: number, battler: BattlerState, unmodelled: string[]): boolean {
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
  /** 'SANDSTORM'/'HAIL'/'GRASSY_TERRAIN'/'TOXIC_TERRAIN' are the field
   * ladder's own entries (fieldEndTurn.ts) -- reusing this same shape rather
   * than a parallel one, since all are "one residual HP effect for one
   * battler". 'ABILITY' is the ENDTURN_ABILITIES ladder case (battle_util.c:2452-2459). */
  effect: 'POISON' | 'TOXIC' | 'BURN' | 'FROSTBITE' | 'BLEED' | 'NIGHTMARE' | 'CURSE' | 'WRAP' | 'SANDSTORM' | 'HAIL' | 'GRASSY_TERRAIN' | 'TOXIC_TERRAIN' | 'LEECH_SEED' | 'ABILITY' | 'INGRAIN' | 'AQUA_RING' | 'WISH' | 'ITEM' | 'SEA_OF_FIRE' | 'SALT_CURE' | 'PARASITIC_SPORES'
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
  syncPartyHp(state, battlerId)
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

/** ENDTURN_FROSTBITE, battle_util.c:2584-2596 (B_BURN_DAMAGE >= GEN_7: maxHP / 16). */
function runFrostbite(state: BattleState, battlerId: number, battler: BattlerState): EndTurnEffectResult | null {
  if (!hasFlag(battler.mon.status1, STATUS1_FROSTBITE)) return null
  if (battler.mon.hp === 0) return null
  if (isMagicGuardProtected(state, battler)) return null // MAGIC_GUARD_CHECK

  const hpChange = -Math.max(1, Math.trunc(battler.mon.maxHp / 16))
  const fainted = applyEndTurnHp(state, battlerId, battler, hpChange)
  return { battlerId, effect: 'FROSTBITE', hpChange, fainted }
}

/** ENDTURN_BLEED, battle_util.c:2598-2607 (BLEED_DAMAGE(hp) = hp / 16, include/constants/battle.h:142). */
/** WasUnableToUseMove, battle_util.c:1181-1190. */
function wasUnableToUseMove(battler: BattlerState): boolean {
  const r = battler.round
  return (
    r.prlzImmobility || r.usedImprisonedMove || r.loveImmobility || r.usedDisabledMove || r.usedTauntedMove ||
    r.usedGravityPreventedMove || r.usedHealBlockedMove || r.flag2Unknown || r.flinchImmobility || r.powderSelfDmg ||
    r.usedThroatChopPreventedMove
  )
}

const GRAPPLER_ABILITIES = ['ABILITY_GRAPPLER', 'ABILITY_TANGLED_TAILS', 'ABILITY_TENTALOCK']

/** ENDTURN_CURSE, battle_util.c:2624-2633: maxHP / 4. The IsBattlerCursed alternative (Ghost monotype champion) has no port. */
function runCurse(state: BattleState, battlerId: number, battler: BattlerState): EndTurnEffectResult | null {
  if (!hasFlag(battler.mon.status2, STATUS2_CURSED)) return null
  if (battler.mon.hp === 0) return null
  if (isMagicGuardProtected(state, battler)) return null // MAGIC_GUARD_CHECK

  const hpChange = -Math.max(1, Math.trunc(battler.mon.maxHp / 4))
  const fainted = applyEndTurnHp(state, battlerId, battler, hpChange)
  return { battlerId, effect: 'CURSE', hpChange, fainted }
}

/**
 * ENDTURN_WRAP, battle_util.c:2646-2711, the STATUS2_WRAPPED branch (the Bug monotype champion branch has no port):
 * --wrapTurns; while it is nonzero the battler takes maxHP / 6 (the wrapper has a grappler ability or Binding Band)
 * or maxHP / 8, otherwise the status ends.
 */
function runWrap(state: BattleState, battlerId: number, battler: BattlerState, dataContext: SimDataContext, grounding: GroundingContext | undefined): EndTurnEffectResult | null {
  if (!hasFlag(battler.mon.status2, STATUS2_WRAPPED)) return null
  if (battler.mon.hp === 0) return null

  battler.volatiles.wrapTurns--
  if (battler.volatiles.wrapTurns === 0) {
    battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_WRAPPED)
    battler.volatiles.wrapAbility = null
    return null
  }
  if (isMagicGuardProtected(state, battler)) return null // MAGIC_GUARD_CHECK

  const wrapper = state.battlers[state.wrappedBy[battlerId]]
  // HasGrappler = the `grappler` ability flag (abilityHooks.json: Grappler, Tangled Tails, Tentalock).
  const hasGrappler =
    !!wrapper && GRAPPLER_ABILITIES.some((ab) => battlerHasAbility(wrapper.mon.abilities, ab, NO_SUPPRESSION))
  const hasBindingBand = grounding?.holdEffectOf(state.wrappedBy[battlerId]) === 'HOLD_EFFECT_BINDING_BAND'
  void dataContext
  const divisor = hasGrappler || hasBindingBand ? 6 : 8
  const hpChange = -Math.max(1, Math.trunc(battler.mon.maxHp / divisor))
  const fainted = applyEndTurnHp(state, battlerId, battler, hpChange)
  return { battlerId, effect: 'WRAP', hpChange, fainted }
}

function runBleed(state: BattleState, battlerId: number, battler: BattlerState): EndTurnEffectResult | null {
  if (!hasFlag(battler.mon.status1, STATUS1_BLEED) && !isBloodStainAffected(battler)) return null
  if (battler.mon.hp === 0) return null
  if (isMagicGuardProtected(state, battler)) return null // MAGIC_GUARD_CHECK

  const hpChange = -Math.max(1, Math.trunc(battler.mon.maxHp / 16))
  const fainted = applyEndTurnHp(state, battlerId, battler, hpChange)
  return { battlerId, effect: 'BLEED', hpChange, fainted }
}

/** ENDTURN_NIGHTMARES, battle_util.c:2608-2622: maxHP / 4 while asleep, otherwise the flag is silently cleared. */
function runNightmare(state: BattleState, battlerId: number, battler: BattlerState): EndTurnEffectResult | null {
  if (!hasFlag(battler.mon.status2, STATUS2_NIGHTMARE)) return null
  if (battler.mon.hp === 0) return null
  if (isMagicGuardProtected(state, battler)) return null // MAGIC_GUARD_CHECK precedes the sleep check
  if (!hasFlag(battler.mon.status1, STATUS1_SLEEP)) {
    battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_NIGHTMARE)
    return null
  }

  const hpChange = -Math.max(1, Math.trunc(battler.mon.maxHp / 4))
  const fainted = applyEndTurnHp(state, battlerId, battler, hpChange)
  return { battlerId, effect: 'NIGHTMARE', hpChange, fainted }
}

/**
 * ENDTURN_LEECH_SEED, src/battle_util.c:2472-2486 and BattleScript_LeechSeedTurnDrain
 * (data/battle_scripts_1.s:7482-7509).
 */
export function runLeechSeed(
  state: BattleState,
  battlerId: number,
  battler: BattlerState,
  dataContext: SimDataContext,
  unmodelled: string[],
): EndTurnEffectResult[] {
  if (!hasFlag(battler.statuses3, STATUS3_LEECHSEED)) return []
  if (battler.mon.hp === 0) return []
  const seederId = battler.statuses3 & STATUS3_LEECHSEED_BATTLER
  const seeder = state.battlers[seederId]
  if (!seeder || seeder.mon.hp === 0) return []
  if (isMagicGuardProtected(state, battler)) return [] // REQUIRE_NOT(IsMagicGuardProtected), :2477

  const rawDmg = Math.trunc(battler.mon.maxHp / 8) // :2480
  const dmg = rawDmg === 0 ? 1 : rawDmg // :2481
  const hpDealt = Math.min(battler.mon.hp, dmg) // datahpupdate BS_ATTACKER, :7486-7487

  const seededFainted = applyEndTurnHp(state, battlerId, battler, -hpDealt)
  const results: EndTurnEffectResult[] = [
    {
      battlerId,
      effect: 'LEECH_SEED',
      hpChange: -hpDealt,
      fainted: seededFainted,
    },
  ]

  // BattleScript_LeechSeedTurnDrain:7488: jumpifability BS_ATTACKER, ABILITY_LIQUID_OOZE
  const hasLiquidOoze = battlerHasAbility(battler.mon.abilities, 'ABILITY_LIQUID_OOZE', NO_SUPPRESSION)
  if (hasLiquidOoze) {
    const oozeFainted = applyEndTurnHp(state, seederId, seeder, -hpDealt)
    results.push({
      battlerId: seederId,
      effect: 'LEECH_SEED',
      hpChange: -hpDealt,
      fainted: oozeFainted,
    })
  } else {
    // BattleScript_LeechSeedTurnDrain:7490-7491:
    // jumpifhealingblocked BS_TARGET, BattleScript_LeechSeedHealBlock
    // jumpifstatus BS_TARGET, STATUS1_BLEED, BattleScript_LeechSeedHealBlock
    if (canBattlerHeal(state, seederId, seeder, unmodelled)) {
      let healAmount = hpDealt
      // manipulatedamage DMG_BIG_ROOT (battle_script_commands.c:9384-9386, battle_util.c:2369-2376)
      const seederItem = seeder.mon.itemId ? dataContext.item(seeder.mon.itemId) : null
      if (seederItem?.resolvedHoldEffect === 'HOLD_EFFECT_BIG_ROOT') {
        healAmount = Math.trunc((healAmount * 3) / 2)
      }
      if (battlerHasAbility(seeder.mon.abilities, 'ABILITY_ABSORBANT', NO_SUPPRESSION)) {
        healAmount = Math.trunc((healAmount * 3) / 2)
      }
      const prevHp = seeder.mon.hp
      applyEndTurnHp(state, seederId, seeder, healAmount)
      const actualHeal = seeder.mon.hp - prevHp
      if (actualHeal > 0) {
        results.push({
          battlerId: seederId,
          effect: 'LEECH_SEED',
          hpChange: actualHeal,
          fainted: false,
        })
      }
    }
  }

  return results
}

/** Pushes an unmodelled line for a "gapped at runtime" case, but only when its
 * real C condition is actually true for this battler -- see this module's
 * header table. Kept as one small helper so every gap call site reads the
 * same way. */
function gapIf(condition: boolean, unmodelled: string[], message: string): void {
  if (condition) unmodelled.push(message)
}

/**
 * IsBattlerTerrainAffected(battlerId, STATUS_FIELD_TOXIC_TERRAIN), battle_util.c:4901-4925.
 * Checks whether Toxic Terrain is active, the battler is not semi-invulnerable,
 * and either grounded or carries allowTerrainIfAirborne (Toxic Surge).
 */
function isBattlerTerrainAffectedByToxicTerrain(
  state: BattleState,
  battlerId: number,
  battler: BattlerState,
  grounding?: GroundingContext,
): boolean {
  if (!hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)) return false
  if (grounding?.isCluelessOnField) return false
  if (hasFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE)) return false
  const gCtx: GroundingContext = grounding ?? {
    holdEffectOf: () => null,
    monotypeChampType: null,
    isCluelessOnField: false,
    attackerHasMoldBreaker: false,
  }
  if (isBattlerGrounded(state, battlerId, { ...gCtx, attackerHasMoldBreaker: false })) return true
  return battlerHasAbility(battler.mon.abilities, 'ABILITY_TOXIC_SURGE', NO_SUPPRESSION)
}

export const NO_GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }

/** An ability heal at end of turn: the shared tail of the ported abilities below. */
function healEndTurn(state: BattleState, battlerId: number, battler: BattlerState, amount: number, results: EndTurnEffectResult[]): void {
  const prevHp = battler.mon.hp
  applyEndTurnHp(state, battlerId, battler, amount)
  const actualHeal = battler.mon.hp - prevHp
  if (actualHeal > 0) {
    results.push({ battlerId, effect: 'ABILITY', hpChange: actualHeal, fainted: false })
  }
}

/** AbilityHealMonStatus, battle_util.c:4036-4057: clears every primary status and Nightmare. */
function healMonStatus(state: BattleState, battlerId: number, battler: BattlerState): boolean {
  if (!hasFlag(battler.mon.status1, STATUS1_ANY)) return false
  battler.mon.status1 = 0
  battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_NIGHTMARE)
  const partySlot = state.sides[battlerId & 1].party[battler.partyIndex]
  if (partySlot) partySlot.status1 = 0
  return true
}

/**
 * ENDTURN_ABILITIES, battle_util.c:2452-2459 -> AbilityBattleEffects(ABILITYEFFECT_ENDTURN, ...)
 * (:4397-4399) -> HandleEndTurnAbility (:9213-9239).
 * Slot order: walks numPossibleAbilities down to 0, visiting slot 3 (innates[2]),
 * slot 2 (innates[1]), slot 1 (innates[0]), then slot 0 (chosen ability).
 * Skips fainted battlers (IsBattlerAlive, :9217) and suppressed abilities (IsSuppressed, :9233).
 */
function runEndTurnAbilities(
  state: BattleState,
  battlerId: number,
  battler: BattlerState,
  dataContext: SimDataContext,
  deps: { grounding?: GroundingContext; statStageRatios?: [number, number][] } | undefined,
  unmodelled: string[],
): EndTurnEffectResult[] {
  const results: EndTurnEffectResult[] = []

  const { ability, innates } = battler.mon.abilities
  const slots: readonly (string | null)[] = [
    innates[2] ?? null,
    innates[1] ?? null,
    innates[0] ?? null,
    ability,
  ]

  for (const slotAbility of slots) {
    if (slotAbility === null) continue
    if (battler.mon.hp === 0) break // IsBattlerAlive check, :9217
    if (isSimAbilitySuppressed(state, battler, slotAbility, false, battlerId, false, dataContext)) continue // IsSuppressed check, :9233

    switch (slotAbility) {
      case 'ABILITY_SPEED_BOOST':
      case 'ABILITY_MAXIMUM_ACCELERATION': {
        // src/abilities.cc:515-524, 8419
        if (battler.volatiles.isFirstTurn !== 2) {
          changeStatBuffs(
            state,
            battlerId,
            battlerId,
            battlerId,
            1,
            STAT_SPEED,
            MOVE_EFFECT_AFFECTS_USER,
            false,
            { dataContext, grounding: deps?.grounding },
            unmodelled,
          )
        }
        break
      }

      case 'ABILITY_RAIN_DISH': {
        // src/abilities.cc:1063-1074
        if (
          battler.mon.hp !== battler.mon.maxHp &&
          canBattlerHeal(state, battlerId, battler, unmodelled) &&
          battler.volatiles.isFirstTurn !== 2 &&
          isBattlerWeatherAffected(state, battlerId, WEATHER_RAIN_ANY, { dataContext, grounding: deps?.grounding })
        ) {
          const heal = Math.max(1, Math.trunc(battler.mon.maxHp / 8))
          const prevHp = battler.mon.hp
          applyEndTurnHp(state, battlerId, battler, heal)
          const actualHeal = battler.mon.hp - prevHp
          if (actualHeal > 0) {
            results.push({ battlerId, effect: 'ABILITY', hpChange: actualHeal, fainted: false })
          }
        }
        break
      }

      case 'ABILITY_ICE_BODY':
      case 'ABILITY_SUNDAE': {
        // src/abilities.cc:1778-1789, 11284
        if (
          battler.mon.hp !== battler.mon.maxHp &&
          canBattlerHeal(state, battlerId, battler, unmodelled) &&
          battler.volatiles.isFirstTurn !== 2 &&
          isBattlerWeatherAffected(state, battlerId, WEATHER_HAIL_ANY, { dataContext, grounding: deps?.grounding })
        ) {
          const heal = Math.max(1, Math.trunc(battler.mon.maxHp / 8))
          const prevHp = battler.mon.hp
          applyEndTurnHp(state, battlerId, battler, heal)
          const actualHeal = battler.mon.hp - prevHp
          if (actualHeal > 0) {
            results.push({ battlerId, effect: 'ABILITY', hpChange: actualHeal, fainted: false })
          }
        }
        break
      }

      case 'ABILITY_DRY_SKIN': {
        // src/abilities.cc:1498-1510
        if (
          isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, { dataContext, grounding: deps?.grounding }) &&
          !isMagicGuardProtected(state, battler)
        ) {
          const dmg = Math.max(1, Math.trunc(battler.mon.maxHp / 8))
          const prevHp = battler.mon.hp
          const fainted = applyEndTurnHp(state, battlerId, battler, -dmg)
          results.push({ battlerId, effect: 'ABILITY', hpChange: battler.mon.hp - prevHp, fainted })
        } else if (
          battler.mon.hp !== battler.mon.maxHp &&
          canBattlerHeal(state, battlerId, battler, unmodelled) &&
          battler.volatiles.isFirstTurn !== 2 &&
          isBattlerWeatherAffected(state, battlerId, WEATHER_RAIN_ANY, { dataContext, grounding: deps?.grounding })
        ) {
          const heal = Math.max(1, Math.trunc(battler.mon.maxHp / 8))
          const prevHp = battler.mon.hp
          applyEndTurnHp(state, battlerId, battler, heal)
          const actualHeal = battler.mon.hp - prevHp
          if (actualHeal > 0) {
            results.push({ battlerId, effect: 'ABILITY', hpChange: actualHeal, fainted: false })
          }
        }
        break
      }

      case 'ABILITY_HYDRATION':
      case 'ABILITY_PURIFYING_WATERS': {
        // src/abilities.cc:1549-1558, 6459
        if (
          isBattlerWeatherAffected(state, battlerId, WEATHER_RAIN_ANY, { dataContext, grounding: deps?.grounding }) &&
          hasFlag(battler.mon.status1, STATUS1_ANY)
        ) {
          battler.mon.status1 = 0
          battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_NIGHTMARE)
          const partySlot = state.sides[battlerId & 1].party[battler.partyIndex]
          if (partySlot) partySlot.status1 = 0
        }
        break
      }

      case 'ABILITY_SHED_SKIN':
      case 'ABILITY_PATTERN_CHANGE':
      case 'ABILITY_WONDER_SCALE': {
        // src/abilities.cc:1278-1287, 8301, 10024
        // RNG: Random() % 100 < 30 drawn first in exact C order
        const roll = state.rng.random16()
        if (roll % 100 < 30) {
          if (hasFlag(battler.mon.status1, STATUS1_ANY)) {
            battler.mon.status1 = 0
            battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_NIGHTMARE)
            const partySlot = state.sides[battlerId & 1].party[battler.partyIndex]
            if (partySlot) partySlot.status1 = 0
          }
        }
        break
      }

      case 'ABILITY_SELF_SUFFICIENT':
      case 'ABILITY_SELF_REPAIR':
      case 'ABILITY_APPLE_PIE':
      case 'ABILITY_DUNE_VEIL': {
        // src/abilities.cc:4041-4054, 5294, 8878, 10960
        if (
          battler.mon.hp !== battler.mon.maxHp &&
          canBattlerHeal(state, battlerId, battler, unmodelled) &&
          battler.volatiles.isFirstTurn !== 2
        ) {
          const heal = Math.max(1, Math.trunc(battler.mon.maxHp / 16))
          const prevHp = battler.mon.hp
          applyEndTurnHp(state, battlerId, battler, heal)
          const actualHeal = battler.mon.hp - prevHp
          if (actualHeal > 0) {
            results.push({ battlerId, effect: 'ABILITY', hpChange: actualHeal, fainted: false })
          }
        }
        break
      }

      case 'ABILITY_POISON_ABSORB': {
        // src/abilities.cc:4438-4449
        if (
          battler.mon.hp !== battler.mon.maxHp &&
          canBattlerHeal(state, battlerId, battler, unmodelled) &&
          battler.volatiles.isFirstTurn !== 2 &&
          isBattlerTerrainAffectedByToxicTerrain(state, battlerId, battler, deps?.grounding)
        ) {
          const heal = Math.max(1, Math.trunc(battler.mon.maxHp / 8))
          const prevHp = battler.mon.hp
          applyEndTurnHp(state, battlerId, battler, heal)
          const actualHeal = battler.mon.hp - prevHp
          if (actualHeal > 0) {
            results.push({ battlerId, effect: 'ABILITY', hpChange: actualHeal, fainted: false })
          }
        }
        break
      }

      case 'ABILITY_SWEET_DREAMS': {
        // src/abilities.cc:4288-4300: maxHP / 8 while asleep or Comatose
        const asleep = hasFlag(battler.mon.status1, STATUS1_SLEEP) || battlerHasAbility(battler.mon.abilities, 'ABILITY_COMATOSE', NO_SUPPRESSION)
        if (battler.mon.hp !== battler.mon.maxHp && canBattlerHeal(state, battlerId, battler, unmodelled) && asleep) {
          healEndTurn(state, battlerId, battler, Math.max(1, Math.trunc(battler.mon.maxHp / 8)), results)
        }
        break
      }

      case 'ABILITY_PEACEFUL_REST':
      case 'ABILITY_WHITE_NOISE': {
        // src/abilities.cc (Impl<PEACEFUL_REST>.onEndTurn), BattleScript_RainDishActivates: maxHP / 8 in fog
        if (
          battler.mon.hp !== battler.mon.maxHp &&
          canBattlerHeal(state, battlerId, battler, unmodelled) &&
          battler.volatiles.isFirstTurn !== 2 &&
          isBattlerWeatherAffected(state, battlerId, WEATHER_FOG_ANY, { dataContext, grounding: deps?.grounding })
        ) {
          healEndTurn(state, battlerId, battler, Math.max(1, Math.trunc(battler.mon.maxHp / 8)), results)
        }
        break
      }

      case 'ABILITY_CELESTIAL_BLESSING':
      case 'ABILITY_ETERNAL_BLESSING': {
        // Impl<CELESTIAL_BLESSING>.onEndTurn, BattleScript_SelfSufficientActivates: maxHP / 12 on Misty Terrain
        if (
          battler.mon.hp !== battler.mon.maxHp &&
          canBattlerHeal(state, battlerId, battler, unmodelled) &&
          battler.volatiles.isFirstTurn !== 2 &&
          isBattlerTerrainAffected(state, battlerId, STATUS_FIELD_MISTY_TERRAIN, { dataContext, grounding: deps?.grounding ?? NO_GROUNDING })
        ) {
          healEndTurn(state, battlerId, battler, Math.max(1, Math.trunc(battler.mon.maxHp / 12)), results)
        }
        break
      }

      case 'ABILITY_LEAF_GUARD': {
        // Impl<LEAF_GUARD>.onEndTurn: sun -> AbilityHealMonStatus (battle_util.c:4036-4057)
        if (isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, { dataContext, grounding: deps?.grounding })) {
          healMonStatus(state, battlerId, battler)
        }
        break
      }

      case 'ABILITY_HEALER':
      case 'ABILITY_CARETAKER': {
        // Impl<HEALER>.onEndTurn: Random() % 100 < 30, then the partner (none in singles) or the battler itself
        if (state.rng.random16() % 100 < 30) healMonStatus(state, battlerId, battler)
        break
      }

      case 'ABILITY_HARVEST':
      case 'ABILITY_SUNS_BOUNTY':
      case 'ABILITY_BIG_LEAVES': {
        // Impl<HARVEST>.onEndTurn (Sun's Bounty / Big Leaves are Harvest | Leaf Guard): restore the last consumed berry
        const used = battler.usedHeldItem
        if (!battler.mon.itemId && used && dataContext.item(used)?.grouping === 'POCKET_BERRIES') {
          if (isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, { dataContext, grounding: deps?.grounding }) || state.rng.random16() % 2) {
            battler.mon.itemId = used
            battler.usedHeldItem = null
          }
        }
        if (slotAbility !== 'ABILITY_HARVEST' && isBattlerWeatherAffected(state, battlerId, WEATHER_SUN_ANY, { dataContext, grounding: deps?.grounding })) {
          healMonStatus(state, battlerId, battler)
        }
        break
      }

      case 'ABILITY_BAD_DREAMS': {
        // BattleScript_BadDreamsActivates / Cmd_trygetbaddreamstarget (battle_script_commands.c:13072-13089): every sleeping or Comatose
        // foe loses maxHP / 4 unless it has Sweet Dreams or Peaceful Slumber; Magic Guard skips the damage.
        for (const target of state.battlers) {
          if (!target || (target.id & 1) === (battlerId & 1) || target.mon.hp === 0) continue
          const dreaming = hasFlag(target.mon.status1, STATUS1_SLEEP) || battlerHasAbility(target.mon.abilities, 'ABILITY_COMATOSE', NO_SUPPRESSION)
          if (!dreaming) continue
          if (
            battlerHasAbility(target.mon.abilities, 'ABILITY_SWEET_DREAMS', NO_SUPPRESSION) ||
            battlerHasAbility(target.mon.abilities, 'ABILITY_PEACEFUL_SLUMBER', NO_SUPPRESSION)
          ) {
            continue
          }
          if (isMagicGuardProtected(state, target)) continue
          const dmg = Math.max(1, Math.trunc(target.mon.maxHp / 4))
          const fainted = applyEndTurnHp(state, target.id, target, -dmg)
          results.push({ battlerId: target.id, effect: 'ABILITY', hpChange: -dmg, fainted })
        }
        break
      }

      default: {
        if (ENDTURN_ABILITY_IDS.has(slotAbility)) {
          // Conditional gap for unmodelled abilities:
          // Schooling requires level >= 20 in C (src/abilities.cc:2838)
          const cond = slotAbility === 'ABILITY_SCHOOLING' ? battler.mon.level >= 20 : true
          gapIf(
            cond,
            unmodelled,
            `battler ${battlerId}: ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied -- ${slotAbility}'s onEndTurn hook was not run`,
          )
        }
        break
      }
    }
  }

  return results
}

/**
 * Runs every ENDTURN_* case this batch supports, for every battler, in
 * `battlerOrder` (this turn's own gBattlerByTurnOrder -- see this module's
 * header). One battler completes its ENTIRE ladder pass before the next
 * battler is even looked at, matching the C's own turnEffectsBattlerId/
 * turnEffectsTracker nesting.
 */
export function runEndTurnEffects(
  state: BattleState,
  battlerOrder: readonly number[],
  dataContext: SimDataContext,
  deps?: { grounding?: GroundingContext; statStageRatios?: [number, number][] },
): { results: EndTurnEffectResult[]; unmodelled: string[] } {
  const results: EndTurnEffectResult[] = []
  const unmodelled: string[] = []

  // battle_util.c:2401 -- AbilityBattleEffects(ABILITYEFFECT_REACTIVE, 0, 0, ABILITY_BS_EXECUTE, 0)
  runReactiveAbilityEffects(state, { dataContext, grounding: deps?.grounding }, unmodelled, undefined, battlerOrder)

  const statusDeps: StatusDeps = {
    dataContext,
    grounding: deps?.grounding ?? {
      holdEffectOf: () => null,
      monotypeChampType: null,
      isCluelessOnField: false,
      attackerHasMoldBreaker: false,
    },
  }

  for (const battlerId of battlerOrder) {
    if (hasFlag(state.absentBattlerFlags, 1 << battlerId)) continue // :2409-2412
    const battler = state.battlers[battlerId]
    if (!battler) continue

    // ENDTURN_INGRAIN, battle_util.c:2426-2434.
    if (
      hasFlag(battler.statuses3, STATUS3_ROOTED) &&
      battler.mon.hp !== 0 &&
      battler.mon.hp !== battler.mon.maxHp &&
      canBattlerHeal(state, battlerId, battler, unmodelled)
    ) {
      let healAmount = Math.max(1, Math.floor(battler.mon.maxHp / 8))
      const item = battler.mon.itemId ? dataContext.item(battler.mon.itemId) : null
      if (item?.resolvedHoldEffect === 'HOLD_EFFECT_BIG_ROOT') {
        healAmount = Math.trunc((healAmount * 3) / 2)
      }
      if (battlerHasAbility(battler.mon.abilities, 'ABILITY_ABSORBANT', NO_SUPPRESSION)) {
        healAmount = Math.trunc((healAmount * 3) / 2)
      }
      const prevHp = battler.mon.hp
      applyEndTurnHp(state, battlerId, battler, healAmount)
      const actualHeal = battler.mon.hp - prevHp
      if (actualHeal > 0) {
        results.push({
          battlerId,
          effect: 'INGRAIN',
          hpChange: actualHeal,
          fainted: false,
        })
      }
    }

    // ENDTURN_AQUA_RING, battle_util.c:2435-2443.
    if (
      hasFlag(battler.statuses3, STATUS3_AQUA_RING) &&
      battler.mon.hp !== 0 &&
      battler.mon.hp !== battler.mon.maxHp &&
      canBattlerHeal(state, battlerId, battler, unmodelled)
    ) {
      let healAmount = Math.max(1, Math.floor(battler.mon.maxHp / 16))
      const item = battler.mon.itemId ? dataContext.item(battler.mon.itemId) : null
      if (item?.resolvedHoldEffect === 'HOLD_EFFECT_BIG_ROOT') {
        healAmount = Math.trunc((healAmount * 3) / 2)
      }
      if (battlerHasAbility(battler.mon.abilities, 'ABILITY_ABSORBANT', NO_SUPPRESSION)) {
        healAmount = Math.trunc((healAmount * 3) / 2)
      }
      const prevHp = battler.mon.hp
      applyEndTurnHp(state, battlerId, battler, healAmount)
      const actualHeal = battler.mon.hp - prevHp
      if (actualHeal > 0) {
        results.push({
          battlerId,
          effect: 'AQUA_RING',
          hpChange: actualHeal,
          fainted: false,
        })
      }
    }

    // ENDTURN_SYRUP, battle_util.c:2444-2450, BattleScript_SyrupDropsSpeed (data/battle_scripts_1.s:8224-8231).
    if (battler.volatiles.syrupTimer > 0) {
      battler.volatiles.syrupTimer--
      changeStatBuffsImplicit(
        state,
        battlerId,
        battlerId,
        -1,
        STAT_SPEED,
        MOVE_EFFECT_AFFECTS_USER | STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext, grounding: statusDeps.grounding },
        unmodelled,
      )
    }

    // ENDTURN_ABILITIES, :2452-2459 -- AbilityBattleEffects(ABILITYEFFECT_ENDTURN)
    // runs HandleEndTurnAbility over EVERY ability slot in descending order (:4397-4399, :9213).
    const abilityResults = runEndTurnAbilities(state, battlerId, battler, dataContext, deps, unmodelled)
    results.push(...abilityResults)

    // ENDTURN_ITEMS1 / ENDTURN_ITEMS2, :2460-2467 (battle_util.c:5622-5855).
    const holdEffect = statusDeps.grounding.holdEffectOf(battlerId)
    if (holdEffect === 'HOLD_EFFECT_LEFTOVERS') {
      if (battler.mon.hp > 0 && battler.mon.hp < battler.mon.maxHp && canBattlerHeal(state, battlerId, battler, unmodelled)) {
        const heal = Math.max(1, Math.floor(battler.mon.maxHp / 16))
        const prevHp = battler.mon.hp
        applyEndTurnHp(state, battlerId, battler, heal)
        const actualHeal = battler.mon.hp - prevHp
        if (actualHeal > 0) {
          results.push({ battlerId, effect: 'ITEM', hpChange: actualHeal, fainted: false })
        }
      }
    } else if (holdEffect === 'HOLD_EFFECT_BLACK_SLUDGE') {
      if (battler.mon.hp > 0) {
        if (battler.mon.types.includes('POISON')) {
          if (battler.mon.hp < battler.mon.maxHp && canBattlerHeal(state, battlerId, battler, unmodelled)) {
            const heal = Math.max(1, Math.floor(battler.mon.maxHp / 16))
            const prevHp = battler.mon.hp
            applyEndTurnHp(state, battlerId, battler, heal)
            const actualHeal = battler.mon.hp - prevHp
            if (actualHeal > 0) {
              results.push({ battlerId, effect: 'ITEM', hpChange: actualHeal, fainted: false })
            }
          }
        } else if (!isMagicGuardProtected(state, battler)) {
          const dmg = Math.max(1, Math.floor(battler.mon.maxHp / 8))
          const fainted = applyEndTurnHp(state, battlerId, battler, -dmg)
          results.push({ battlerId, effect: 'ITEM', hpChange: -dmg, fainted })
        }
      }
    } else {
      gapIf(
        holdEffect !== null && ITEMS_1_2_HOLD_EFFECTS.has(holdEffect),
        unmodelled,
        `battler ${battlerId}: ENDTURN_ITEMS1/ENDTURN_ITEMS2 (battle_util.c:5622-5855) are not applied -- ${battler.mon.itemId}'s end-of-turn hold effect (${holdEffect}) was not run`,
      )
    }

    // ENDTURN_ORBS, :2468-2471 (battle_util.c:6252-6288).
    if (battler.mon.hp > 0) {
      if (holdEffect === 'HOLD_EFFECT_TOXIC_ORB') {
        if (canBePoisoned(state, battlerId, battlerId, null, statusDeps)) {
          battler.mon.status1 = STATUS1_TOXIC_POISON
        }
      } else if (holdEffect === 'HOLD_EFFECT_FLAME_ORB') {
        if (canBeBurned(state, battlerId, battlerId, statusDeps)) {
          battler.mon.status1 = STATUS1_BURN
        }
      } else if (holdEffect === 'HOLD_EFFECT_FROST_ORB') {
        if (canGetFrostbite(state, battlerId, battlerId, statusDeps)) {
          battler.mon.status1 = STATUS1_FROSTBITE
        }
      } else if (holdEffect === 'HOLD_EFFECT_STICKY_BARB') {
        if (!isMagicGuardProtected(state, battler)) {
          const dmg = Math.max(1, Math.floor(battler.mon.maxHp / 8))
          const fainted = applyEndTurnHp(state, battlerId, battler, -dmg)
          results.push({ battlerId, effect: 'ITEM', hpChange: -dmg, fainted })
        }
      }
    }

    // ENDTURN_LEECH_SEED, :2472-2486.
    const leechResults = runLeechSeed(state, battlerId, battler, dataContext, unmodelled)
    results.push(...leechResults)

    const poison = runPoison(state, battlerId, battler, unmodelled)
    if (poison) results.push(poison)
    const badPoison = poison ? null : runBadPoison(state, battlerId, battler, unmodelled)
    if (badPoison) results.push(badPoison)

    // ENDTURN_SEA_OF_FIRE_DAMAGE, battle_util.c:2545-2562.
    // maxHP/8 to non-Fire battlers without Magic Guard / Flare Boost on the side with fireSeaTimer.
    if (
      !hasFlag(state.absentBattlerFlags, 1 << battlerId) &&
      battler.mon.hp > 0 &&
      !battler.mon.types.includes('FIRE') &&
      (state.sides[battlerSide(battlerId)]?.timers.fireSeaTimer ?? 0) > 0 &&
      !isMagicGuardProtected(state, battler) &&
      !battlerHasAbility(battler.mon.abilities, 'ABILITY_FLARE_BOOST', NO_SUPPRESSION)
    ) {
      const dmg = Math.max(1, Math.floor(battler.mon.maxHp / 8))
      const fainted = applyEndTurnHp(state, battlerId, battler, -dmg)
      results.push({ battlerId, effect: 'SEA_OF_FIRE', hpChange: -dmg, fainted })
    }

    // ENDTURN_PARASITIC_SPORES_DAMAGE, battle_util.c:2561-2570.
    // maxHP/8 to non-Ghost battlers with parasiticSpores without Magic Guard.
    if (
      !hasFlag(state.absentBattlerFlags, 1 << battlerId) &&
      battler.mon.hp > 0 &&
      battler.volatiles.parasiticSpores &&
      !battler.mon.types.includes('GHOST') &&
      !isMagicGuardProtected(state, battler)
    ) {
      const dmg = Math.max(1, Math.floor(battler.mon.maxHp / 8))
      const fainted = applyEndTurnHp(state, battlerId, battler, -dmg)
      results.push({ battlerId, effect: 'PARASITIC_SPORES', hpChange: -dmg, fainted })
    }

    const frostbite = runFrostbite(state, battlerId, battler)
    if (frostbite) results.push(frostbite)

    const bleed = runBleed(state, battlerId, battler)
    if (bleed) results.push(bleed)

    const nightmare = runNightmare(state, battlerId, battler)
    if (nightmare) results.push(nightmare)

    const curse = runCurse(state, battlerId, battler)
    if (curse) results.push(curse)

    // ENDTURN_SALT_CURE, battle_util.c:2634-2648.
    // STATUS4_SALT_CURE damage (1/4 for Water/Steel else 1/8, Magic Guard).
    // getMonotypeChampType() == TYPE_ROCK half is not modelled (external fact, see header).
    if (hasFlag(battler.statuses4, STATUS4_SALT_CURE) && battler.mon.hp !== 0) {
      if (!isMagicGuardProtected(state, battler)) {
        const isWaterOrSteel = battler.mon.types.includes('WATER') || battler.mon.types.includes('STEEL')
        const fraction = isWaterOrSteel ? 4 : 8
        const dmg = Math.max(1, Math.floor(battler.mon.maxHp / fraction))
        const fainted = applyEndTurnHp(state, battlerId, battler, -dmg)
        results.push({ battlerId, effect: 'SALT_CURE', hpChange: -dmg, fainted })
      }
    }

    const wrap = runWrap(state, battlerId, battler, dataContext, deps?.grounding)
    if (wrap) results.push(wrap)

    // ENDTURN_OCTOLOCK, battle_util.c:2708-2716, BattleScript_OctolockEndTurn (data/battle_scripts_1.s:282-305).
    if (
      battler.volatiles.octolock &&
      !isStatDropBlocked(state, battler, STAT_DEF, false, { dataContext, grounding: statusDeps.grounding }, unmodelled) &&
      !isStatDropBlocked(state, battler, STAT_SPDEF, false, { dataContext, grounding: statusDeps.grounding }, unmodelled) &&
      !hasClearAmulet(battler, dataContext)
    ) {
      changeStatBuffsImplicit(
        state,
        battlerId,
        battlerId,
        -1,
        STAT_DEF,
        STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext, grounding: statusDeps.grounding },
        unmodelled,
      )
      changeStatBuffsImplicit(
        state,
        battlerId,
        battlerId,
        -1,
        STAT_SPDEF,
        STAT_BUFF_ALLOW_PTR,
        true,
        { dataContext, grounding: statusDeps.grounding },
        unmodelled,
      )
    }

    const burn = runBurn(state, battlerId, battler)
    if (burn) results.push(burn)

    // ENDTURN_THRASH, :2753-2768: count the Outrage / Thrash / Petal Dance lock down; an interrupted lock is cancelled, and a lock
    // that runs out confuses the user (MOVE_EFFECT_CONFUSION | MOVE_EFFECT_AFFECTS_USER through SetMoveEffect).
    if (hasFlag(battler.mon.status2, STATUS2_LOCK_CONFUSE)) {
      const remaining = getCounter(battler.mon.status2, STATUS2_LOCK_CONFUSE) - 1
      battler.mon.status2 = setCounter(battler.mon.status2, STATUS2_LOCK_CONFUSE, remaining)
      if (wasUnableToUseMove(battler)) {
        cancelMultiTurnMoves(battler)
      } else if (remaining === 0 && hasFlag(battler.mon.status2, STATUS2_MULTIPLETURNS)) {
        battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_MULTIPLETURNS)
        if (!hasFlag(battler.mon.status2, STATUS2_CONFUSION) && canBeConfused(state, battlerId, battlerId, statusDeps)) {
          battler.mon.status2 = setCounter(battler.mon.status2, STATUS2_CONFUSION, (state.rng.random16() % 2) + 3)
        }
      }
    }

    // ENDTURN_FLINCH, :2770-2772 -- the C clears STATUS2_FLINCHED
    // unconditionally every end of turn.
    battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_FLINCHED)

    // ENDTURN_DISABLE, :2774-2791.
    if (battler.volatiles.disableTimer !== 0) {
      const moveIdx = battler.volatiles.disabledMove
        ? battler.mon.moves.indexOf(battler.volatiles.disabledMove)
        : -1
      if (moveIdx === -1) {
        battler.volatiles.disabledMove = null
        battler.volatiles.disableTimer = 0
      } else if (--battler.volatiles.disableTimer === 0) {
        battler.volatiles.disabledMove = null
      }
    }

    // ENDTURN_ENCORE, :2792-2808.
    if (battler.volatiles.encoreTimer !== 0) {
      const pos = battler.volatiles.encoredMovePos
      if (battler.mon.moves[pos] !== battler.volatiles.encoredMove) {
        battler.volatiles.encoredMove = null
        battler.volatiles.encoreTimer = 0
      } else if (
        --battler.volatiles.encoreTimer === 0 ||
        (battler.mon.pp[pos] ?? 0) === 0
      ) {
        battler.volatiles.encoredMove = null
        battler.volatiles.encoreTimer = 0
      }
    }

    // ENDTURN_LOCK_ON, battle_util.c:2809-2812.
    if (hasFlag(battler.statuses3, STATUS3_ALWAYS_HITS)) {
      battler.statuses3 -= STATUS3_ALWAYS_HITS_TURN(1)
    }

    // ENDTURN_GHASTLY_ECHO, :2813-2816.
    if (battler.volatiles.ghastlyEchoTimer && --battler.volatiles.ghastlyEchoTimer === 0) {
      battler.statuses4 = clearFlag(battler.statuses4, STATUS4_GHASTLY_ECHO)
    }

    // ENDTURN_COILED_UP, :2818-2829.
    gapIf(
      hasFlag(battler.statuses4, STATUS4_COILED) || hasFlag(battler.statuses4, STATUS4_CUTTHROAT),
      unmodelled,
      `battler ${battlerId}: ENDTURN_COILED_UP (battle_util.c:2818-2829) is not applied -- STATUS4_COILED/STATUS4_CUTTHROAT were not cleared`,
    )

    // ENDTURN_TAUNT, :2831-2838.
    if (battler.volatiles.tauntTimer > 0) {
      battler.volatiles.tauntTimer--
    }

    // ENDTURN_YAWN, :2839-2854.
    if (hasFlag(battler.statuses3, STATUS3_YAWN)) {
      const counter = getCounter(battler.statuses3, STATUS3_YAWN)
      const newCounter = counter > 0 ? counter - 1 : 0
      battler.statuses3 = setCounter(battler.statuses3, STATUS3_YAWN, newCounter)
      if (!hasFlag(battler.statuses3, STATUS3_YAWN) && canSleep(state, battlerId, undefined, statusDeps)) {
        cancelMultiTurnMoves(battler)
        const sleepTurns = (state.rng.random16() & 3) + 2
        battler.mon.status1 = setCounter(battler.mon.status1, STATUS1_SLEEP, sleepTurns)
      }
    }

    // ENDTURN_LASER_FOCUS, battle_util.c:2855-2861.
    if (hasFlag(battler.statuses3, STATUS3_LASER_FOCUS)) {
      if (battler.volatiles.laserFocusTimer === 0 || --battler.volatiles.laserFocusTimer === 0) {
        battler.statuses3 = clearFlag(battler.statuses3, STATUS3_LASER_FOCUS)
      }
    }

    // ENDTURN_EMBARGO, :2862-2874.
    if (hasFlag(battler.statuses3, STATUS3_EMBARGO)) {
      if (battler.volatiles.embargoTimer === 0 || --battler.volatiles.embargoTimer === 0) {
        battler.statuses3 = clearFlag(battler.statuses3, STATUS3_EMBARGO)
      }
    }
    battler.volatiles.substituteDestroyedThisTurn = false

    // ENDTURN_MAGNET_RISE, battle_util.c:2875-2884.
    if (hasFlag(battler.statuses3, STATUS3_MAGNET_RISE)) {
      if (battler.volatiles.magnetRiseTimer === 0 || --battler.volatiles.magnetRiseTimer === 0) {
        battler.statuses3 = clearFlag(battler.statuses3, STATUS3_MAGNET_RISE)
      }
    }

    // ENDTURN_TELEKINESIS, :2886-2894.
    if (hasFlag(battler.statuses3, STATUS3_TELEKINESIS)) {
      if (battler.volatiles.telekinesisTimer === 0 || --battler.volatiles.telekinesisTimer === 0) {
        battler.statuses3 = clearFlag(battler.statuses3, STATUS3_TELEKINESIS)
      }
    }

    // ENDTURN_HEALBLOCK, :2896-2906.
    if (hasFlag(battler.statuses3, STATUS3_HEAL_BLOCK)) {
      if (battler.volatiles.healBlockTimer === 0 || --battler.volatiles.healBlockTimer === 0) {
        battler.statuses3 = clearFlag(battler.statuses3, STATUS3_HEAL_BLOCK)
      }
    }

    // ENDTURN_ROOST, :2907-2914.
    if (hasFlag(battler.resourceFlags ?? 0, RESOURCE_FLAG_ROOST)) {
      battler.resourceFlags = clearFlag(battler.resourceFlags ?? 0, RESOURCE_FLAG_ROOST)
      const [r1, r2] = battler.roostTypes ?? ['NORMAL', 'NORMAL']
      battler.mon.types = [r1, r2, battler.mon.types[2]]
    }

    // ENDTURN_ELECTRIFY, :2915-2918 -- clears STATUS4_ELECTRIFIED at end of turn.
    battler.statuses4 = clearFlag(battler.statuses4, STATUS4_ELECTRIFIED)

    // ENDTURN_POWDER, :2919-2921 -- unconditional.
    battler.mon.status2 = clearFlag(battler.mon.status2, STATUS2_POWDER)

    // ENDTURN_THROAT_CHOP, battle_util.c:2923-2929 -- timer decrement.
    if (battler.volatiles.throatChopTimer > 0) {
      battler.volatiles.throatChopTimer--
    }

    // ENDTURN_SLOW_START, :2930-2941 -- timer decrement.
    if (battler.volatiles.slowStartTimer > 0) {
      battler.volatiles.slowStartTimer--
    }

    // ENDTURN_PLASMA_FISTS, :2956-2959 -- clears STATUS4_PLASMA_FISTS (its reader is calculate.ts's attackerPlasmaFists).
    battler.statuses4 = clearFlag(battler.statuses4, STATUS4_PLASMA_FISTS)

    // ENDTURN_GENERIC_BATTLER_TIMERS, :2960-2979 -- SUBTRACT_VOLATILE_TIMER(trepidation) (:2976)
    if (battler.volatiles.trepidation > 0 && !battler.volatiles.started.trepidation) {
      battler.volatiles.trepidation--
    }
    if (!battler.volatiles.started.fear) {
      battler.statuses4 = clearFlag(battler.statuses4, STATUS4_FEAR)
      battler.volatiles.fear = false
    }

    gapIf(
      battler.volatiles.rapidResponse ||
        battler.volatiles.showdownMode ||
        battler.volatiles.violentRush ||
        battler.volatiles.onTheProwl ||
        battler.volatiles.dazed !== 0,
      unmodelled,
      `battler ${battlerId}: ENDTURN_GENERIC_BATTLER_TIMERS (battle_util.c:2960-2979) is not applied -- one-turn volatile timers were not cleared/decremented`,
    )

    // battle-over short-circuit (faint-replacement batch). The C does NOT
    // finish this battler's case list first: DoBattlerEndTurnEffects returns
    // the moment any case fires an effect, and the next BattleTurnPassed call
    // sees gBattleOutcome != 0 (battle_main.c:3479) and never re-enters it, so
    // the state machine is abandoned mid-list. Checking here, after the
    // battler's cases, gives the same observable result: the case that
    // decided the outcome fainted a battler, and a fainted battler's own
    // remaining cases are skipped anyway. Later battlers get nothing either way.
    state.battleOutcome = computeBattleOutcome(state)
    if (state.battleOutcome) break
  }

  return { results, unmodelled }
}
