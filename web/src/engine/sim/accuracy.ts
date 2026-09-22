// GetTotalAccuracy, src/battle_script_commands.c:1251-1396, at the pinned SHA
// (sources.lock.json's eliteredux-source entry). Its caller, Cmd_accuracycheck
// (:1398-1447), is NOT ported here -- that is the next batch -- but is read
// for context: `Random() % 100 >= accuracy` means a MISS, and the C returns 101
// as a sentinel meaning "cannot miss" (moveAcc can never legitimately reach 101
// through the stage/item math below, since the final line is `min(moveAcc,
// 100)`).
//
// This is a real-battle port, not the AI's. GetTotalAccuracy takes a
// `moveState` parameter that is non-NULL only when the AI is evaluating a
// hypothetical move (AI_MISSES_THIS_TURN*, battle_ai_util.c) -- see
// Cmd_accuracycheck:1424, which always calls with NULL. This module hardcodes
// that path (`moveState == NULL`) and every `if (moveState) ... else ...`
// branch in the C takes its `else`. Porting the AI's own path is later work;
// it is not silently dropped, it is this paragraph.
//
// ## Gap discipline
//
// Same rule as bridge.ts's header: a field this module cannot honestly derive
// is a GAP, not a value, and the gap is returned alongside the number rather
// than folded into it silently. Three whole branches of the C have no port
// anywhere in this codebase and are gapped unconditionally:
//
//   - IsStatDropBlocked(battlerAtk, STAT_ACC, FALSE) == STAT_DROP_BLOCK_SPECIFIC
//     (:1336) needs the onBlockStatDrops ability hook chain (Clear Body, White
//     Smoke, Mist, Flower Veil, ...), which web/src/engine/abilities/ has no
//     type, dispatch or registry entry for at all -- checked, not assumed
//     (types.ts's AbilityImpl has no onBlockStatDrops field). Treated as
//     always false, which is the correct answer whenever neither battler holds
//     one of those abilities.
//   - HasRipenEffect(battlerAtk) (:1385) needs the `ripen` ability flag, which
//     AbilityFlags (abilities/types.ts) does not declare. The Micle Berry
//     branch (:1383-1389) is still ported -- it is real, data-driven state the
//     caller supplies -- but always takes the non-Ripen (+20%) multiplier, and
//     the ambiguity is reported as a gap whenever the berry was actually used.
//   - The onAccuracy ability loop (:1354-1362) iterates every ability slot on
//     the attacker and defender (in singles, the only two battlers the C's own
//     FILTER admits) and runs each one's onAccuracy hook. Of the 50 abilities
//     in the pinned checkout that declare one -- cross-checked mechanically
//     both against data/v2.65beta/abilityHooks.json's `hooks.onAccuracy` and
//     against a grep of every `constexpr Ability Impl<ABILITY_X>` block in
//     src/abilities.cc that declares `.onAccuracy` (aliases count: an alias
//     assignment like `Impl<ABILITY_RADIANCE>.onAccuracy =
//     Impl<ABILITY_ILLUMINATE>.onAccuracy` is a live hook, not a gap) -- NONE
//     has a port: web/src/engine/abilities/impl/09-hub-abilities.ts and
//     23-mold-breaker.ts each say so explicitly in a comment. Every slot that
//     names one of the 50 is gapped by ability id.
//
// One ability check IS ported for real, because its flag already exists in
// the registry: IsUnaware (:9006) is exactly `RETURN_ABILITY_IF_FLAG(battler,
// TRUE, unaware)`, and abilities/dispatchCalc.ts's `hasFlag` already answers
// that question for the damage path. This module calls the same function.

import type { BridgeGap } from './bridge'
import type { AbilitySlots } from '../abilities/dispatch'
import { battlerHasAbility } from '../abilities/dispatch'
import { hasFlag as abilityHasFlag } from '../abilities/dispatchCalc'
import type { WeatherKind } from '../types'
import { DEFAULT_STAT_STAGE } from './constants'

// ---------------------------------------------------------------------------
// AccuracyPriority, include/abilities.hh:74-81. Six values; this port only
// ever PRODUCES three of them (NO_RESULT, HITS_IF_POSSIBLE, ALWAYS_MISSES),
// because MULTIPLICATIVE/ADDITIVE/ALWAYS_HITS are only ever returned by an
// onAccuracy ability hook, and none is ported (see the header). The full
// six-value ordering is still transcribed here, not trimmed to the three
// this module reaches, because the numeric ordering IS the ladder: :1286's
// `if (prio < ACCURACY_HITS_IF_POSSIBLE)` gate and the final switch (:1364-
// 1371) both depend on the exact relative order, and a caller wiring in a
// real ability port later must not have to rediscover it.
// ---------------------------------------------------------------------------
export const ACCURACY_PRIORITY = {
  NO_RESULT: 0,
  MULTIPLICATIVE: 1,
  ADDITIVE: 2,
  HITS_IF_POSSIBLE: 3,
  ALWAYS_MISSES: 4,
  ALWAYS_HITS: 5,
} as const

/** gAccuracyStageRatios, src/battle_script_commands.c:651-664. A SEPARATE
 * 13-entry table from the general stat-stage ratios bridge.ts's deps carry
 * (that one is gStatStageRatios) -- accuracy has its own. Index 0 is stage
 * -6, index 6 (DEFAULT_STAT_STAGE) is neutral 1:1, index 12 is +6. */
export const ACCURACY_STAGE_RATIOS: [number, number][] = [
  [1, 3], // -6
  [3, 8], // -5
  [3, 7], // -4
  [1, 2], // -3
  [2, 3], // -2
  [3, 4], // -1
  [1, 1], //  0
  [4, 3], // +1
  [3, 2], // +2
  [2, 1], // +3
  [7, 3], // +4
  [8, 3], // +5
  [3, 1], // +6
]

/** The 50 abilities in the pinned checkout whose `.onAccuracy` hook
 * GetTotalAccuracy's ability loop (:1354-1362) would run, none of which has a
 * port. Mechanically derived -- see accuracy.test.ts's oracle test, which
 * re-derives this set from data/v2.65beta/abilityHooks.json and fails if it
 * ever drifts. Aliases (e.g. Radiance/Illuminate, Hunters Mark/Deadeye) count
 * as live hooks, same as a hand-written one. Kept as data (not a hardcoded
 * switch) so the gap-scan and its test can iterate it. */
export const UNPORTED_ACCURACY_ABILITIES = [
  'ABILITY_ANGELS_WRATH',
  'ABILITY_ARTILLERY',
  'ABILITY_BAD_LUCK',
  'ABILITY_BRAWLING_WYVERN',
  'ABILITY_CHANDELIER',
  'ABILITY_COMMANDER',
  'ABILITY_COMPOUND_EYES',
  'ABILITY_DEADEYE',
  'ABILITY_DEADLY_PRECISION',
  'ABILITY_DEPTH_EXPLORER',
  'ABILITY_ECHOLOCATION',
  'ABILITY_ENLIGHTENED',
  'ABILITY_FATAL_PRECISION',
  'ABILITY_FINAL_BLOW',
  'ABILITY_FLAWLESS_PRECISION',
  'ABILITY_GIFTED_MIND',
  'ABILITY_GLACIAL_GHOST',
  'ABILITY_GRIP_PINCER',
  'ABILITY_HUNTERS_MARK',
  'ABILITY_HUSTLE',
  'ABILITY_HYPNOTIC_TRANCE',
  'ABILITY_HYPNOTIST',
  'ABILITY_ILLUMINATE',
  'ABILITY_INNER_FOCUS',
  'ABILITY_IRON_BARRAGE',
  'ABILITY_KEEN_EYE',
  'ABILITY_LULLABY',
  'ABILITY_LUNAR_ECLIPSE',
  'ABILITY_MACH_3',
  'ABILITY_NO_GUARD',
  'ABILITY_OLE',
  'ABILITY_PIXIE_POWER',
  'ABILITY_PLASMA_LAMP',
  'ABILITY_QIGONG',
  'ABILITY_RADIANCE',
  'ABILITY_RAIN_SHROUD',
  'ABILITY_REFRIGERATOR',
  'ABILITY_ROUNDHOUSE',
  'ABILITY_SAND_VEIL',
  'ABILITY_SHINY_LIGHTNING',
  'ABILITY_SIGHTING_SYSTEM',
  'ABILITY_SMOKEY_MANEUVERS',
  'ABILITY_SNOW_CLOAK',
  'ABILITY_SUPER_SCOPE',
  'ABILITY_SWEEPING_EDGE',
  'ABILITY_SWEEPING_EDGE_PLUS',
  'ABILITY_UNLOCKED_POTENTIAL',
  'ABILITY_VICTORY_STAR',
  'ABILITY_WAY_OF_PRECISION',
  'ABILITY_WORLD_SERPENT',
] as const

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Everything GetTotalAccuracy reads, named and cited. A flat, hand-buildable
 * shape (not `BattleState`) so a test can construct one field at a time from
 * the C, the way `dataContext.ts`/`grounding.ts` do for their own callers.
 * Stat stages are the sim's INTERNAL 0..12 form (constants.ts's
 * DEFAULT_STAT_STAGE=6 neutral), matching `gBattleMons[].statStages[]`
 * directly -- this module has no reason to convert to the damage
 * calculator's external -6..+6 form, since it never touches that type.
 */
export interface AccuracyInputs {
  // -- the move, gBattleMoves[move] -----------------------------------------
  /** Needed only to compare against MOVE_SHEER_COLD/MOVE_BLIZZARD/
   * MOVE_EERIE_SPELL/MOVE_VEXING_VOID (:1320-1328). Bare `MOVE_*` id. */
  moveId: string
  /** gBattleMoves[move].accuracy (:1284). 0 means "no accuracy check" --
   * ACCURACY_HITS_IF_POSSIBLE (:1287-1288), same rung as Aerial Ace's
   * ignoresStatStages. */
  moveAccuracy: number
  /** gBattleMoves[move].effect (:1264, 1290-1315, 1300-1301). Bare `EFFECT_*`
   * id or null, matching dataContext.ts's SimMoveData.effect. */
  moveEffect: string | null
  /** GET_MOVE_TYPE(move, moveType) (:1260) -- the move's RESOLVED type (post
   * -ate abilities), bare name e.g. 'PSYCHIC'. Only compared against
   * TYPE_PSYCHIC for Trepidation (:1277). */
  moveType: string
  /** FLAG_STAT_STAGES_IGNORED, pokemon.h -- moves.json's `ignoresStatStages`
   * (:1336). Aerial Ace-class moves that skip accuracy/evasion stages. */
  moveFlagStatStagesIgnored: boolean
  /** FLAG_DMG_IN_AIR, pokemon.h:354 (:1267-1268). A SEPARATE bit from
   * FLAG_DMG_2X_IN_AIR below -- moves.json's `hitsAir` enum currently only
   * ever sets one or the other (never both), so in practice only ONE of
   * these two fields is ever true for a given move, but the C tests them as
   * two independent bits and this module transcribes that literally rather
   * than assuming they are mutually exclusive. */
  moveFlagDmgInAir: boolean
  /** FLAG_DMG_2X_IN_AIR, pokemon.h:353 (:1268-1269). See moveFlagDmgInAir's
   * note -- both are OR'd into the same miss condition, so (per the current
   * data, where a move never sets both) a semi-invulnerable-in-air defender
   * ALWAYS reads as a miss regardless of which single bit the move carries.
   * That looks like it should be "does the move have EITHER flag", but the
   * C's actual `||` of two independently-negated clauses says otherwise --
   * transcribed as written, not "fixed". */
  moveFlagDmgTwoXInAir: boolean
  /** FLAG_DMG_UNDERGROUND, moves.json's `hitsUnderground` (:1269). */
  moveFlagDmgUnderground: boolean
  /** FLAG_DMG_UNDERWATER, moves.json's `hitsUnderwater` (:1270). */
  moveFlagDmgUnderwater: boolean

  // -- attacker --------------------------------------------------------------
  /** IS_BATTLER_OF_TYPE(battlerAtk, ...) checks (:1264, 1297, 1301, 1305,
   * 1309, 1313) -- up to 3 bare type names. */
  attackerTypes: string[]
  /** gVolatileStructs[battlerAtk].trepidation (:1277) -- a 2-bit counter
   * (state.ts's VolatileState.trepidation), tested by the C as a plain
   * truthy nonzero. Reduced to a boolean by the caller, same treatment as
   * defenderHasAlwaysHits above for its own 2-bit STATUS3_ALWAYS_HITS. */
  attackerTrepidationNonzero: boolean
  /** GetBattlerHoldEffect(battlerAtk, TRUE) (:1255). Bare `HOLD_EFFECT_*` id
   * or null. Only HOLD_EFFECT_WIDE_LENS/HOLD_EFFECT_ZOOM_LENS matter here. */
  attackerHoldEffect: string | null
  /** GetBattlerHoldEffectParam(battlerAtk) (:1253) -- Wide Lens/Zoom Lens's
   * percentage bonus. Corresponds to bridge.ts's per-battler
   * itemResolvedHoldEffectStrength once this is wired in. */
  attackerHoldEffectParam: number
  /** gBattleMons[battlerAtk].statStages[STAT_ACC] (:1334) -- internal 0..12,
   * DEFAULT_STAT_STAGE (6) neutral. */
  attackerAccStage: number
  /** The attacker's 4 ability slots, for the two REAL checks this module
   * makes: IsUnaware (:1338, via abilities/dispatchCalc.hasFlag) and the
   * unported onAccuracy loop's gap scan (:1354-1362). */
  attackerAbilitySlots: AbilitySlots
  /** GetBattlerTurnOrderNum(battlerAtk) > GetBattlerTurnOrderNum(battlerDef)
   * (:1380) -- does the attacker act AFTER the defender this turn? Zoom
   * Lens's own condition; Wide Lens has no such gate. A turn-order fact the
   * sim's turnOrder.ts already derives elsewhere, supplied here rather than
   * re-derived so this module stays state-shape-agnostic. */
  attackerActsAfterDefender: boolean
  /** gRoundStructs[battlerAtk].usedMicleBerry (:1383) -- real per-turn state
   * (RoundState.usedMicleBerry), not a gap. The C also CLEARS this flag as a
   * side effect (:1384); this module is pure and does not mutate its inputs,
   * so a caller wiring this into the turn loop must clear it itself once the
   * berry's one-time use is consumed. */
  attackerUsedMicleBerry: boolean
  /** IsMyceliumMightActive(battlerAtk) (:1265), `battle_main.c:4249`:
   * `battlerId == gBattlerAttacker && gHitMarker & HITMARKER_MYCELIUM_MIGHT`.
   * In the real-battle call (Cmd_accuracycheck:1424) battlerAtk IS always
   * gBattlerAttacker, so this collapses to "is the Mycelium Might hit-marker
   * bit currently set" -- a per-turn engine flag with no sim-state
   * counterpart (gHitMarker is not modelled), so it is a scenario toggle
   * supplied directly, the same class of un-derivable per-turn fact as
   * OffensiveMultiplierContext's `attackerAbilityOn`. */
  myceliumMightActive: boolean

  // -- defender ---------------------------------------------------------------
  /** GetBattlerHoldEffect(battlerDef, TRUE) (:1256). Only
   * HOLD_EFFECT_EVASION_UP matters here. */
  defenderHoldEffect: string | null
  /** GetBattlerHoldEffectParam(battlerDef) (:1254) -- the evasion item's
   * percentage. */
  defenderHoldEffectParam: number
  /** gBattleMons[battlerDef].statStages[STAT_EVASION] (:1335) -- internal
   * 0..12. */
  defenderEvasionStage: number
  /** STATUS4_FORESIGHT (:1341) -- Foresight/Odor Sleuth/Miracle Eye-class
   * "ignore the defender's evasion boosts" status. When set, the defender's
   * evasion contribution is dropped entirely rather than merely clamped. */
  defenderHasForesight: boolean
  /** STATUS3_ALWAYS_HITS (:1262) -- the Lock-On/Mind Reader timer bits
   * (constants.ts's STATUS3_ALWAYS_HITS, a 2-bit VALUE not a plain flag, so
   * the caller must already have reduced it to "is this status currently
   * set" before handing it here -- this module only reads the boolean). */
  defenderHasAlwaysHits: boolean
  /** gVolatileStructs[battlerDef].battlerWithSureHit == battlerAtk (:1262) --
   * Lock-On/Mind Reader only guarantees a hit against the SPECIFIC battler
   * that used it, not any attacker. */
  battlerWithSureHitIsAttacker: boolean
  /** STATUS3_TELEKINESIS (:1263). */
  defenderHasTelekinesis: boolean
  /** !IsBattlerGrounded(battlerDef) (:1263) -- Telekinesis only grants the
   * always-hit sentinel while the defender is ALSO airborne (Telekinesis
   * itself lifts a grounded target, so this is reachable e.g. against an
   * Iron Ball holder Telekinesis cannot lift). Supplied as the caller's own
   * grounding answer (grounding.ts's isBattlerGrounded) rather than
   * re-derived, matching attackerActsAfterDefender's precedent. */
  defenderIsGrounded: boolean
  /** STATUS3_PHANTOM_FORCE (:1267). */
  defenderHasPhantomForce: boolean
  /** STATUS3_ON_AIR (:1267-1268, both DMG_IN_AIR and DMG_2X_IN_AIR clauses). */
  defenderIsOnAir: boolean
  /** STATUS3_UNDERGROUND (:1269). */
  defenderIsUnderground: boolean
  /** STATUS3_UNDERWATER (:1270). */
  defenderIsUnderwater: boolean
  /** gSideTimers[GET_BATTLER_SIDE(battlerDef)].smokescreenTimer (:1393) --
   * the C tests it as a plain truthy nonzero; this module only needs that
   * boolean, not the exact remaining-turns count SideTimerState carries. */
  defenderSmokescreenActive: boolean
  /** The defender's 4 ability slots -- only read by the unported onAccuracy
   * loop's gap scan (:1354-1362); nothing this module actually PORTS reads a
   * defender-side ability flag. */
  defenderAbilitySlots: AbilitySlots

  // -- field -------------------------------------------------------------
  /** ConditionFieldContext's own WeatherKind (engine/types.ts), used for the
   * Sun/Thunder/Hurricane accuracy drop (:1350-1352) and the Hail/Fog
   * exceptions for specific moves (:1320-1328). */
  weather: WeatherKind
  /** IsGravityActive() (:1391). */
  gravityActive: boolean
}

export interface AccuracyResult {
  /** The C's own return type. 101 is the "cannot miss" sentinel: the final
   * line is `min(moveAcc, 100)`, so 101 can only ever come from one of the
   * three early `return 101` branches (:1262-1265) or the ability-loop
   * switch's ALWAYS_HITS/HITS_IF_POSSIBLE case (:1365-1367, unreachable here
   * since no onAccuracy hook is ported) -- never from the stage/item math. */
  accuracy: number
  gaps: BridgeGap[]
}

const bareHoldEffect = (id: string | null, want: string): boolean => id === want

/**
 * GetTotalAccuracy, src/battle_script_commands.c:1251-1396. The real-battle
 * path only (`moveState == NULL`) -- see this module's header.
 */
export function getTotalAccuracy(inputs: AccuracyInputs): AccuracyResult {
  const gaps: BridgeGap[] = []

  // -- three early always-hits branches, :1262-1265 -------------------------
  if (inputs.defenderHasAlwaysHits && inputs.battlerWithSureHitIsAttacker) return { accuracy: 101, gaps }
  if (inputs.defenderHasTelekinesis && !inputs.defenderIsGrounded) return { accuracy: 101, gaps }
  // B_TOXIC_NEVER_MISS (GEN_7) >= GEN_6 (3) is a fixed build-config constant
  // in this checkout (include/constants/battle_config.h:10,68) -- always
  // true, so unlike every other condition here it is not a runtime input.
  if (inputs.moveEffect === 'EFFECT_TOXIC' && inputs.attackerTypes.includes('POISON')) return { accuracy: 101, gaps }
  if (inputs.myceliumMightActive) return { accuracy: 101, gaps }

  let prio: number = ACCURACY_PRIORITY.NO_RESULT

  // -- semi-invulnerability / Trepidation, :1267-1282 ------------------------
  // moveState is NULL on this path, so every `if (moveState) ... else ...`
  // below takes its else -- see this module's header.
  if (
    inputs.defenderHasPhantomForce ||
    (!inputs.moveFlagDmgInAir && inputs.defenderIsOnAir) ||
    (!inputs.moveFlagDmgTwoXInAir && inputs.defenderIsOnAir) ||
    (!inputs.moveFlagDmgUnderground && inputs.defenderIsUnderground) ||
    (!inputs.moveFlagDmgUnderwater && inputs.defenderIsUnderwater)
  ) {
    prio = ACCURACY_PRIORITY.ALWAYS_MISSES
  }

  // gVolatileStructs[battlerAtk].trepidation is a 2-bit counter (state.ts's
  // VolatileState.trepidation); the C tests it as a plain truthy nonzero.
  if (inputs.attackerTrepidationNonzero && inputs.moveType === 'PSYCHIC') {
    prio = ACCURACY_PRIORITY.ALWAYS_MISSES
  }

  let moveAcc = inputs.moveAccuracy

  // -- the "always hits if possible" exceptions, :1286-1331 ------------------
  if (prio < ACCURACY_PRIORITY.HITS_IF_POSSIBLE) {
    if (moveAcc === 0) {
      prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
    } else {
      switch (inputs.moveEffect) {
        case 'EFFECT_THUNDER':
        case 'EFFECT_HURRICANE':
          if (inputs.weather === 'RAIN_TEMPORARY' || inputs.weather === 'RAIN_PERMANENT' || inputs.weather === 'RAIN_PRIMAL') prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
          break
        case 'EFFECT_LEECH_SEED':
          if (inputs.attackerTypes.includes('GRASS')) prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
          break
        case 'EFFECT_TOXIC':
          if (inputs.attackerTypes.includes('POISON')) prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
          break
        case 'EFFECT_WILL_O_WISP':
          if (inputs.attackerTypes.includes('FIRE')) prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
          break
        case 'EFFECT_PARALYZE':
          if (inputs.attackerTypes.includes('ELECTRIC')) prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
          break
        case 'EFFECT_FROSTBITE':
          if (inputs.attackerTypes.includes('ICE')) prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
          break
      }
    }

    if (prio !== ACCURACY_PRIORITY.HITS_IF_POSSIBLE) {
      switch (inputs.moveId) {
        case 'MOVE_SHEER_COLD':
        case 'MOVE_BLIZZARD':
          // engine/types.ts's WeatherKind collapses WEATHER_HAIL_TEMPORARY and
          // WEATHER_HAIL_PERMANENT (the two bits WEATHER_HAIL_ANY covers) into
          // one 'HAIL' kind (bridge.ts's WEATHER_BIT_TO_KIND) -- a single
          // equality check against 'HAIL' is therefore the correct transcription
          // of `IsBattlerWeatherAffected(battlerDef, WEATHER_HAIL_ANY)`.
          // HasAuroraBorealis(battlerAtk) (src/battle_util.c:9345-9348) is
          // `BattlerHasAbility(battler, ABILITY_AURORA_BOREALIS, FALSE)` --
          // a PLAIN ability-id check, checkMoldBreaker=FALSE, not the
          // RETURN_ABILITY_IF_FLAG/AbilityFlags shape the header's other two
          // gaps need. battlerHasAbility already answers exactly this
          // question (see calculate.ts's identical check for Weather Ball),
          // so this IS ported for real.
          if (inputs.weather === 'HAIL' || battlerHasAbility(inputs.attackerAbilitySlots, 'ABILITY_AURORA_BOREALIS', () => false)) {
            prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
          }
          break
        case 'MOVE_EERIE_SPELL':
        case 'MOVE_VEXING_VOID':
          if (inputs.weather === 'FOG') prio = ACCURACY_PRIORITY.HITS_IF_POSSIBLE
          break
      }
    }
  }

  // -- stat stages, :1333-1347 ------------------------------------------------
  // gPotentialItemEffectBattler = battlerDef (:1333) is a side-effect global
  // write for a later message/item lookup elsewhere in the engine; it has no
  // bearing on the accuracy NUMBER this function returns, so there is
  // nothing to port for it.
  let evasionStage = inputs.defenderEvasionStage
  // IsStatDropBlocked(battlerAtk, STAT_ACC, FALSE) == STAT_DROP_BLOCK_SPECIFIC
  // has no port anywhere in this codebase (see this module's header) and is
  // therefore always treated as false; gapped unconditionally rather than
  // per-call, since it is a structural absence, not a per-scenario one.
  gaps.push({
    field: 'attackerAccuracyDropBlockedSpecific',
    reason: 'NO_SOURCE',
    detail: 'IsStatDropBlocked(battlerAtk, STAT_ACC, FALSE) == STAT_DROP_BLOCK_SPECIFIC needs the onBlockStatDrops ability hook chain, which has no type, dispatch or registry entry anywhere in web/src/engine/abilities/; treated as false',
  })
  // IsUnaware(battlerAtk) (:9006) -- checkMoldBreaker=TRUE in the C, but
  // IsSuppressed's mold-breaker branch (battle_util.c:9254-9261) only ever
  // fires when `battler != gBattlerAttacker`, and battlerAtk IS
  // gBattlerAttacker on this real-battle call path (Cmd_accuracycheck:1424),
  // so the suppression can never trigger here. Always FALSE, not a caller
  // input -- an argument that must always take one value invites a future
  // caller to pass the other.
  const attackerIsUnaware = abilityHasFlag(inputs.attackerAbilitySlots, 'unaware', false)
  if (inputs.moveFlagStatStagesIgnored) {
    evasionStage = Math.min(evasionStage, DEFAULT_STAT_STAGE)
  } else if (attackerIsUnaware) {
    evasionStage = DEFAULT_STAT_STAGE
  }

  let buff = inputs.defenderHasForesight ? inputs.attackerAccStage : inputs.attackerAccStage + DEFAULT_STAT_STAGE - evasionStage
  if (buff < 0) buff = 0
  if (buff >= ACCURACY_STAGE_RATIOS.length) buff = ACCURACY_STAGE_RATIOS.length - 1

  // -- Thunder/Hurricane/Eerie Spell/Vexing Void in sun, :1349-1352 -----------
  const isSunny = inputs.weather === 'SUN_TEMPORARY' || inputs.weather === 'SUN_PERMANENT' || inputs.weather === 'SUN_PRIMAL'
  const isSunAffectedMove = inputs.moveEffect === 'EFFECT_THUNDER' || inputs.moveEffect === 'EFFECT_HURRICANE' || inputs.moveId === 'MOVE_EERIE_SPELL' || inputs.moveId === 'MOVE_VEXING_VOID'
  if (isSunny && isSunAffectedMove) moveAcc = 50

  // -- the onAccuracy ability loop, :1354-1362 --------------------------------
  // No hook is ported (see header); gap by name whenever a battler actually
  // holds one of the 50 abilities that declare onAccuracy, in EITHER slot set
  // (singles: the C's own FILTER only ever admits battlerAtk and battlerDef).
  for (const abilityId of UNPORTED_ACCURACY_ABILITIES) {
    const onAttacker = battlerHasAbility(inputs.attackerAbilitySlots, abilityId, () => false)
    const onDefender = battlerHasAbility(inputs.defenderAbilitySlots, abilityId, () => false)
    if (onAttacker) gaps.push({ field: 'attackerAbilitySlots', reason: 'NO_SOURCE', detail: `${abilityId}'s onAccuracy hook has no port` })
    if (onDefender) gaps.push({ field: 'defenderAbilitySlots', reason: 'NO_SOURCE', detail: `${abilityId}'s onAccuracy hook has no port` })
  }

  // -- the final switch, :1364-1371 -------------------------------------------
  if (prio === ACCURACY_PRIORITY.ALWAYS_HITS || prio === ACCURACY_PRIORITY.HITS_IF_POSSIBLE) return { accuracy: 101, gaps }
  if (prio === ACCURACY_PRIORITY.ALWAYS_MISSES) return { accuracy: 0, gaps }

  // -- stage ratio and the remaining item/field multipliers, :1373-1395 ------
  const [dividend, divisor] = ACCURACY_STAGE_RATIOS[buff]
  moveAcc = Math.trunc((moveAcc * dividend) / divisor)

  if (bareHoldEffect(inputs.defenderHoldEffect, 'HOLD_EFFECT_EVASION_UP')) {
    moveAcc = Math.trunc((moveAcc * (100 - inputs.defenderHoldEffectParam)) / 100)
  }

  if (bareHoldEffect(inputs.attackerHoldEffect, 'HOLD_EFFECT_WIDE_LENS')) {
    moveAcc = Math.trunc((moveAcc * (100 + inputs.attackerHoldEffectParam)) / 100)
  } else if (bareHoldEffect(inputs.attackerHoldEffect, 'HOLD_EFFECT_ZOOM_LENS') && inputs.attackerActsAfterDefender) {
    moveAcc = Math.trunc((moveAcc * (100 + inputs.attackerHoldEffectParam)) / 100)
  }

  if (inputs.attackerUsedMicleBerry) {
    // HasRipenEffect(battlerAtk) has no port (see header) -- always the
    // non-Ripen +20% branch, gapped when it could actually have mattered
    // (i.e. only when the berry was really used this call).
    gaps.push({
      field: 'attackerUsedMicleBerry',
      reason: 'NO_SOURCE',
      detail: "HasRipenEffect(battlerAtk) needs the `ripen` ability flag, which AbilityFlags does not declare; Micle Berry's boost was computed as +20% (no Ripen) rather than the +40% Ripen would give",
    })
    moveAcc = Math.trunc((moveAcc * 120) / 100)
  }

  if (inputs.gravityActive) moveAcc = Math.trunc((moveAcc * 5) / 3)

  if (inputs.defenderSmokescreenActive) moveAcc = Math.trunc(moveAcc * 0.75)

  return { accuracy: Math.min(moveAcc, 100), gaps }
}
