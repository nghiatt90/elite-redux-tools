// Multi-hit resolution: GetMultihitType/GetParentalBondType/GetParentalBondCount
// (src/battle_script_commands.c:958-1064) collapsed into one function, since the
// C's own control flow makes them mutually exclusive -- CANCELLER_MULTIHIT_MOVES
// (a move's OWN multi-hit effect) always runs first and sets multiHitCounter;
// GetParentalBondType's caller only even checks Parental Bond `if
// (!multiHitCounter)` (battle_script_commands.c:1086), so a move that's already
// multi-hit by its own effect can never ALSO get a Parental Bond bonus hit.
//
// Every hit of a move's own multi-hit effect (Double Hit, Population Bomb, the
// Skill-Link/Loaded-Dice-boosted forms of EFFECT_MULTI_HIT) deals FULL,
// unscaled power via THIS module's hitModifier -- confirmed against
// CalcMoveBasePower's own switch (battle_util.c:6825-6907), which has no case
// for these effects at all. Only a Parental-Bond-family hit uses anything other
// than 1.0 here, and for DUAL_WIELD even hit 0 is scaled (0.7x -- see the
// hitModifier construction below). Triple Kick/Triple Axel (MULTIHIT_TRIPLE_KICK)
// scale power too, but NOT via hitModifier -- their scaling happens at
// CalcMoveBasePower's own pipeline stage (basePower.ts's applyPreModifierBasePower,
// keyed on hitIndex), which calculate.ts's per-hit loop threads separately from
// the hitModifier this module returns; see that function's own doc for why the
// two stages can't share one mechanism and stay bit-exact.
//
// MULTIHIT_BEAT_UP (party-based hit count) IS resolved here now, via its own
// beatUpHitCount scenario toggle -- see that function's own doc.

import { uq } from './fixed'
import { computeParentalBondTrigger, getParentalBondMultiplier } from './abilities/dispatchCalc'
import { battlerHasAbility } from './abilities/dispatch'
import type { AbilitySlots } from './abilities/dispatch'
import type { OnParentalBondContext, ParentalBondTrigger } from './abilities/types'

export interface HitPlan {
  hitCount: number
  /** UQ_4_12 -- the modifier for the (0-indexed) hit, folded into CalcFinalDmg's
   * own parentalBondMultiplier stage regardless of which mechanism produced it. */
  hitModifier: (hitIndex: number) => number
}

export type HitPlanResult = HitPlan | { unmodelled: string } | null

/**
 * The C's `twoTurnMove` bit (include/pokemon.h:273), which IsMoveAffectedByParentalBond
 * reads at battle_script_commands.c:13169. The pipeline emits no such flag in
 * moves.json (zero moves carry one), so this reproduces the codegen's own definition:
 * `move.twoTurn || move.effect.getOption(twoTurn)`
 * (tools/codegen/src/er/move/BattleMovesGenerator.kt:94,106). er-config's
 * MoveBehavior.proto declares the `two_turn` option on exactly these eight effects
 * (:93, :164, :168, :354, :419, :443, :451, :467) and no move in MoveList.textproto
 * sets the per-move `two_turn` field, so the effect set IS the bit on this pinned
 * config. Note sim/turn.ts's TWO_TURN_EFFECTS lists only five of the eight (it omits
 * EFFECT_GEOMANCY, EFFECT_SKY_DROP and EFFECT_TWO_TURNS_ATTACK); this is the complete
 * set the C data actually has -- see REPORT.md.
 */
const TWO_TURN_EFFECTS: ReadonlySet<string> = new Set([
  'EFFECT_TWO_TURNS_ATTACK',
  'EFFECT_SOLARBEAM',
  'EFFECT_SEMI_INVULNERABLE',
  'EFFECT_GEOMANCY',
  'EFFECT_TWO_TURN_SECONDARY',
  'EFFECT_ELECTRO_SHOT',
  'EFFECT_SKY_DROP',
  'EFFECT_TWO_TURN_RETALIATION',
])

/**
 * WEATHER_SUN_ANY / WEATHER_RAIN_ANY (include/constants/battle.h), narrowed to the
 * calculator's own WeatherKind union (engine/types.ts:87-104). That union has no
 * RAIN_DOWNPOUR member -- the header marks WEATHER_RAIN_DOWNPOUR unused and
 * sim/bridge.ts surfaces it as a NO_SOURCE gap -- so there is nothing to add for it.
 * Like every other calc-level weather check (e.g. basePower.ts:747), this reads the
 * bare weather kind the scenario already carries; Cloud Nine/Air Lock/Clueless
 * (WEATHER_HAS_EFFECT) and Utility Umbrella are not modelled anywhere in the calc.
 */
const SUN_WEATHERS: ReadonlySet<string> = new Set(['SUN_PERMANENT', 'SUN_TEMPORARY', 'SUN_PRIMAL'])
const RAIN_WEATHERS: ReadonlySet<string> = new Set(['RAIN_PERMANENT', 'RAIN_TEMPORARY', 'RAIN_PRIMAL'])

/**
 * HasChloroplast, src/battle_util.c:9340 (`RETURN_ABILITY_IF_FLAG(battler, FALSE,
 * chloroplast)`, i.e. checkMoldBreaker=FALSE). Only three abilities carry the
 * bitfield: ABILITY_CHLOROPLAST (src/abilities.cc:3651), ABILITY_SOLAR_FLARE (:4641)
 * and ABILITY_BIG_LEAVES (:4753), confirmed against abilityHooks.json's `bitfields`.
 * The pipeline does not emit a `chloroplast` bitfield into the calc (see
 * basePower.ts:243-248), so they are listed by id here.
 */
const CHLOROPLAST_ABILITIES = ['ABILITY_BIG_LEAVES', 'ABILITY_CHLOROPLAST', 'ABILITY_SOLAR_FLARE'] as const

function isTwoTurnEffect(effect: string | null): boolean {
  return effect !== null && TWO_TURN_EFFECTS.has(effect)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * GetParentalBondCount, src/battle_script_commands.c:1010-1044. MINION_CONTROL's
 * own count is a live count of the attacker's non-fainted, non-egg, non-status
 * party members (:1023-1040); a caller that can see the party passes it as
 * `minionControlCount`, and a caller that cannot (the standalone calculator) keeps
 * the unmodelled result rather than guessing. TWO_TO_FIVE (Unrelenting,
 * src/abilities.cc:12247-12249's onParentalBond) has NO case in that switch --
 * only PARENTAL_BOND_HYPER_AGGRESSIVE/PRIMAL_MAW/DUAL_WIELD/ICE_COLD_HUNTER/
 * THREE_HEADED/MINION_CONTROL are handled (include/abilities.hh:36-54's
 * PARENTAL_BOND_* values), so it falls through to the switch's own `return 1`,
 * and Cmd_attackcanceler's `i > 1` gate (:1082-1090) then never sets
 * multiHitCounter/parentalBondOn at all -- Unrelenting never actually grants a
 * bonus hit in the real game.
 */
export function parentalBondHitCount(trigger: ParentalBondTrigger, minionControlCount?: number): { hitCount: number } | { unmodelled: string } {
  switch (trigger) {
    case 'HYPER_AGGRESSIVE':
    case 'PRIMAL_MAW':
    case 'DUAL_WIELD':
    case 'ICE_COLD_HUNTER':
      return { hitCount: 2 }
    case 'THREE_HEADED':
      return { hitCount: 3 }
    case 'TWO_TO_FIVE':
      return { hitCount: 1 }
    case 'MINION_CONTROL':
      // :1023-1040 -- `count = 1`, then +1 per OTHER eligible party member.
      if (minionControlCount !== undefined) return { hitCount: minionControlCount }
      return { unmodelled: 'Minion Control: party-based hit count not modelled (caller supplied no minionControlCount)' }
  }
}

export interface MultiHitMoveData {
  effect: string | null
  multiHitArgument: number | null
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS' | null
  flags: Record<string, true>
}

/** The three fields IsMoveAffectedByParentalBond reads. Narrower than MultiHitMoveData
 * (and matching sim/dataContext.ts's SimMoveData) so the simulator's Cmd_attackcanceler
 * port can share the function without inventing a multiHitArgument it does not have. */
export interface ParentalBondMoveData {
  effect: string | null
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS' | null
  flags: Record<string, true>
}

/**
 * IsMoveAffectedByParentalBond, src/battle_script_commands.c:13164-13184 -- the
 * eligibility gate GetParentalBondType (:992) applies before the ability loop.
 * Shared by multiHit.ts's resolveHitPlan (the calculator) and sim/attackCanceller.ts
 * (Cmd_attackcanceler's :1083-1091 setup), so the two can never disagree.
 *
 * The checks run in the C's own order:
 *   1. status move                     -> not eligible (:13165)
 *   2. parentalBondBanned flag         -> not eligible (:13166)
 *   3. Solar Beam in sun / Chloroplast -> ELIGIBLE, returns TRUE before the two-turn
 *                                         check ever runs (:13167)
 *   4. Electro Shot in rain            -> ELIGIBLE, same early return (:13168)
 *   5. two-turn move without Accelerate -> not eligible (:13169)
 *   6. the BATTLE_TYPE_DOUBLE target-count block (:13170-13181) is doubles-only;
 *      this engine is singles, so it has no singles-relevant effect to port.
 */
export function isMoveAffectedByParentalBond(move: ParentalBondMoveData, attackerSlots: AbilitySlots, ctx: OnParentalBondContext): boolean {
  if (move.split === 'STATUS' || move.flags.noParentalBond) return false
  const hasChloroplast = CHLOROPLAST_ABILITIES.some((id) => battlerHasAbility(attackerSlots, id, () => false))
  const twoTurnExempt =
    (move.effect === 'EFFECT_SOLARBEAM' && (SUN_WEATHERS.has(ctx.weather) || hasChloroplast)) ||
    (move.effect === 'EFFECT_ELECTRO_SHOT' && RAIN_WEATHERS.has(ctx.weather))
  // BattlerHasAbility(battlerId, ABILITY_ACCELERATE, FALSE) -- the non-mold-breaker-
  // suppressible form, hence the always-false suppression predicate.
  if (!twoTurnExempt && isTwoTurnEffect(move.effect) && !battlerHasAbility(attackerSlots, 'ABILITY_ACCELERATE', () => false)) return false
  return true
}

export function resolveHitPlan(
  move: MultiHitMoveData,
  attackerSlots: AbilitySlots,
  defenderSlots: AbilitySlots,
  attackerHasSkillLink: boolean,
  attackerResolvedHoldEffect: string | null,
  scenarioHitCount: number,
  parentalBondCtx: OnParentalBondContext,
  scenarioBeatUpHitCount: number,
  /** GetParentalBondCount's MINION_CONTROL branch (:1023-1040): the live party
   * count the simulator can supply. Absent for the standalone calculator, which
   * keeps the unmodelled result. */
  minionControlCount?: number,
): HitPlanResult {
  // A move's own multi-hit effect (CANCELLER_MULTIHIT_MOVES, battle_util.c:3496-3542).
  if (move.effect === 'EFFECT_DOUBLE_HIT') {
    return { hitCount: move.multiHitArgument === 3 ? 3 : 2, hitModifier: () => uq(1.0) }
  }
  if (move.effect === 'EFFECT_TEN_HITS') {
    return { hitCount: 10, hitModifier: () => uq(1.0) }
  }
  if (move.effect === 'EFFECT_MULTI_HIT') {
    if (attackerHasSkillLink) return { hitCount: 5, hitModifier: () => uq(1.0) }
    const usesLoadedDice = attackerResolvedHoldEffect === 'HOLD_EFFECT_LOADED_DICE'
    const [min, max] = usesLoadedDice ? [4, 5] : [2, 5]
    return { hitCount: clamp(scenarioHitCount, min, max), hitModifier: () => uq(1.0) }
  }
  // MULTIHIT_TRIPLE_KICK (Triple Kick/Triple Axel share EFFECT_TRIPLE_KICK) --
  // always exactly 3 hits, fixed (battle_util.c:3506-3509, no Skill Link/Loaded
  // Dice interaction: those only ever apply to MULTIHIT_TWO_TO_FIVE-family moves).
  // hitModifier stays uq(1.0) for every hit -- the power scaling isn't a
  // final-stage multiplier, it happens earlier via basePower.ts's own hitIndex
  // parameter (applyPreModifierBasePower's EFFECT_TRIPLE_KICK case), matching the
  // C's own pipeline stage (CalcMoveBasePower, not CalcFinalDmg).
  if (move.effect === 'EFFECT_TRIPLE_KICK') {
    return { hitCount: 3, hitModifier: () => uq(1.0) }
  }
  // MULTIHIT_BEAT_UP -- a live count of the attacker's non-fainted, non-egg,
  // non-status party members (battle_script_commands.c:1023-1038), exposed
  // directly as its own scenario toggle (beatUpHitCount) since there's no party
  // roster to derive it from -- same shape as Triple Kick's own hitModifier
  // (power scaling happens via basePower.ts's EFFECT_BEAT_UP case, not here).
  if (move.effect === 'EFFECT_BEAT_UP') {
    return { hitCount: clamp(scenarioBeatUpHitCount, 1, 6), hitModifier: () => uq(1.0) }
  }

  // Parental Bond family (IsMoveAffectedByParentalBond + GetParentalBondType/Count,
  // battle_script_commands.c:992-1004,1011-1040,13164-13184). The eligibility checks
  // are isMoveAffectedByParentalBond's (see its doc for the C order).
  if (!isMoveAffectedByParentalBond(move, attackerSlots, parentalBondCtx)) return null
  const trigger = computeParentalBondTrigger(attackerSlots, defenderSlots, parentalBondCtx)
  if (!trigger) return null
  const countResult = parentalBondHitCount(trigger, minionControlCount)
  if ('unmodelled' in countResult) return countResult
  if (countResult.hitCount <= 1) return null
  return {
    hitCount: countResult.hitCount,
    // GetParentalBondMultiplier(trigger, parentalBondInitialCount - parentalBondOn),
    // battle_util.c:7631-7635. Cmd_attackcanceler sets parentalBondOn =
    // parentalBondInitialCount = count (battle_script_commands.c:1083-1090), so the
    // FIRST hit is turn 0 -- and DUAL_WIELD's case has no REQUIRE(turn)
    // (battle_util.c:7483-7484), so it is 0.7x from hit 0 onward. Every other trigger
    // passes REQUIRE(turn) and therefore stays 1.0x at hit 0.
    hitModifier: (hitIndex) => getParentalBondMultiplier(trigger, hitIndex),
  }
}
