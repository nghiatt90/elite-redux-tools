// Variable base power, ported from three distinct mechanisms in
// eliteredux-source (see docs cited on each function):
//
//   1. UpdateBaseDamage -- codegen'd from moveBehaviors.json's declarative
//      `attack.damage` blocks (27 of 460 behaviors) plus the "custom" oneof cases,
//      which are hand-written C++ template specializations in src/script_conditions.cc.
//   2. CalcMoveBasePowerAfterModifiers's own multiplier chain (src/battle_util.c:
//      6995-7117) -- hold effects, per-move-effect conditions (Facade, Brine,
//      Venoshock, Retaliate, Knock Off, ...), and the terrain STAB-style boost.
//   3. CalcMoveBasePower's hardcoded pre-switch (:6825-6913), move-id switch
//      (:6915-6935), and Angel's Wrath's own ability-gated switch (:6938-6952) --
//      ALL ported (applyPreModifierBasePower/applyMoveSpecificBasePower/
//      applyAngelsWrathBasePower, below) despite the module comment's earlier
//      claim that most of this bucket "needs turn history": Magnitude simulates
//      all 7 tiers and combines them into a real probability-weighted
//      distribution (calculateMoveDamage's own top-level gate, calculate.ts);
//      Triple Kick's power scaling is keyed on which hit of the SAME move use
//      this is (hitIndex, resolved by multiHit.ts within one calculation, no
//      history needed); Pursuit/Focus Punch/Self-Destruct each read a plain
//      scenario fact (defenderIsSwitching/attackerWasHitThisTurn) about what
//      happened this turn, not a simulated history; Rollout/Ice Ball's counter
//      (attackerRolloutCounter) IS genuine cross-turn state, but is exposed
//      directly (the user states which hit of an ongoing chain to compute)
//      rather than derived from a turn count, sidestepping an unverifiable
//      exact-increment-timing question -- see its own doc on DamageContext. Beat
//      Up (party contents) is the one genuine "no party roster" gap, resolved
//      the same way alliesFainted resolved Soul Harvest/Supreme Overlord's own
//      version of this: ONE representative value (beatUpBaseAttack) stands in
//      for the real per-ally lookup -- see its own doc on DamageContext for why
//      that's a deliberate simplification, not a bit-exact port. Weather Ball is
//      also ported (below).

import { applyModifier, idiv, mulModifier, uq } from './fixed'
import { evaluateAllConditions, type ScriptCondition } from './conditions'
import type { DamageContext } from './types'

// ---------------------------------------------------------------------------
// moveBehaviors.json shape (erdata.behaviors.move_behaviors_to_dict / move_behavior.py)
// ---------------------------------------------------------------------------

export type DamageModifierSpec =
  | { kind: 'multiply'; value: number }
  | { kind: 'add'; value: number }
  | { kind: 'set'; value: number }
  | { kind: 'custom' }
  | { kind: 'customFrom'; behavior: string }

export interface MoveBehaviorAttack {
  secondaryEffects?: unknown[]
  recoilFraction?: number
  superEffectiveVs?: string
  ignoreTypeImmunity?: boolean
  damage?: { conditions: ScriptCondition[]; modifier: DamageModifierSpec }
}

export interface MoveBehaviorEntry {
  causesFlinch: boolean
  trappingEffect: boolean
  legacyConfig?: string
  attack?: MoveBehaviorAttack
  options?: Record<string, boolean>
}

export type MoveBehaviors = Record<string, MoveBehaviorEntry>

// ---------------------------------------------------------------------------
// gPercentToModifier, src/battle_util.c:865+ -- each entry is UQ_4_12(0.01*i) for
// that specific literal i, computed once at compile time. Replicated with the same
// multiplication order (0.01 * i, not i / 100) so floating-point truncation matches
// exactly, though the two are equal for every integer i in [0, 100] in IEEE double
// precision -- this is about matching the C's *expression*, not a real risk here.
// ---------------------------------------------------------------------------

export function percentToModifier(percent: number): number {
  const clamped = Math.min(Math.max(percent, 0), 100)
  return uq(0.01 * clamped)
}

// ---------------------------------------------------------------------------
// 1. UpdateBaseDamage -- the moveBehaviors.json-driven declarative system, plus the
//    hand-written "custom" specializations (src/script_conditions.cc:133-238).
// ---------------------------------------------------------------------------

/** CustomMoveCondition<> specializations (script_conditions.cc:141-157), restricted
 * to what's meaningful in a stateless singles calculator: Round's "did my partner
 * also choose Round this turn" and Fusion Combo's "did I just use the other half of
 * the combo" both require turn history this calculator doesn't simulate, so both are
 * hardcoded false (v1 has no doubles partner and no move-history at all) rather than
 * silently guessing true. Acrobatics' "attacker holds no item" check IS a pure
 * snapshot fact and is fully implemented. */
function evaluateCustomCondition(behaviorId: string, ctx: DamageContext): boolean {
  if (behaviorId === 'EFFECT_ACROBATICS') {
    // src/script_conditions.cc:147-151. The gem-boost edge case (item consumed
    // earlier this same calculation) doesn't apply to a single point-in-time calc.
    return ctx.attacker.itemId === null
  }
  if (behaviorId === 'EFFECT_ROUND' || behaviorId === 'EFFECT_FUSION_COMBO') {
    return false
  }
  throw new Error(`no CustomMoveCondition ported for ${behaviorId}`)
}

/** CustomMoveDamage<> specializations (script_conditions.cc:158-238). Each is ported
 * bit-for-bit, bugs included -- see EFFECT_ELECTRO_BALL below. */
const CUSTOM_MOVE_DAMAGE: Record<string, (baseDamage: number, ctx: DamageContext) => number> = {
  // :159-161
  EFFECT_ERUPTION: (baseDamage, ctx) => idiv(ctx.attacker.hp * baseDamage, ctx.attacker.maxHp),

  // :163-172. Table is (weight-threshold, power) pairs; first threshold exceeding the
  // target's weight (hectograms) wins, else 120.
  EFFECT_LOW_KICK: (_baseDamage, ctx) => {
    const table: [number, number][] = [
      [100, 20],
      [250, 40],
      [500, 60],
      [1000, 80],
      [2000, 100],
    ]
    for (const [threshold, power] of table) {
      if (threshold > ctx.defender.weight) return power
    }
    return 120
  },

  // :174-182. weightRatio = floor(atkWeight / defWeight) (C integer division).
  EFFECT_HEAT_CRASH: (_baseDamage, ctx) => {
    const table = [40, 40, 60, 80, 100, 120]
    const ratio = idiv(ctx.attacker.weight, ctx.defender.weight)
    return table[Math.min(ratio, table.length - 1)]
  },

  // :184-188
  EFFECT_PUNISHMENT: (_baseDamage, ctx) => Math.min(60 + ctx.defender.positiveStatStageCount * 20, 200),

  // :190-193
  EFFECT_STORED_POWER: (baseDamage, ctx) => baseDamage + ctx.attacker.positiveStatStageCount * 20,

  // :195-201. NOTE (real upstream bug, ported faithfully): when the speed ratio is
  // out of the table's range, the C returns the table's *length* (4) directly rather
  // than indexing it (which would be 150) -- `return ARRAY_COUNT(...) - 1;` instead of
  // `return table[ARRAY_COUNT(...) - 1];`. A base power of 4, not 150.
  EFFECT_ELECTRO_BALL: (_baseDamage, ctx) => {
    const table = [40, 60, 80, 120, 150]
    const ratio = idiv(ctx.attacker.speed, ctx.defender.speed)
    if (ratio >= table.length) return table.length - 1 // the bug: length (4), not table[length-1] (150)
    return table[ratio]
  },

  // :203-207
  EFFECT_GYRO_BALL: (_baseDamage, ctx) => {
    const power = idiv(25 * ctx.defender.speed, ctx.attacker.speed) + 1
    return Math.min(power, 150)
  },

  // :209-213
  EFFECT_ECHOED_VOICE: (baseDamage, ctx) => Math.min(baseDamage * (1 + ctx.sameMoveTurnsInARow), 200),

  // :215-218
  EFFECT_LASH_OUT: (baseDamage, ctx) => Math.min(baseDamage + ctx.attacker.negativeStatStageCount * 20, 140),

  // :220-229. If the move isn't found in the attacker's moveset (slot index 4, i.e.
  // "not found"), the C returns baseDamage unchanged -- modelled here as "no PP info
  // available" (usedMovePpRemaining === null) rather than a magic slot index.
  EFFECT_TRUMP_CARD: (baseDamage, ctx) => {
    const table = [200, 80, 60, 50, 40]
    if (ctx.attacker.usedMovePpRemaining === null) return baseDamage
    const pp = ctx.attacker.usedMovePpRemaining
    return table[Math.min(pp, table.length - 1)]
  },
}

export interface BasePowerResult {
  power: number
  /** Non-empty when a behavior's mechanic wasn't ported (see UNMODELLED_BASE_POWER_EFFECTS
   * and the CustomMoveDamage/CustomMoveCondition gaps) -- callers must surface this
   * rather than presenting `power` as authoritative. */
  unmodelled: string[]
}

/**
 * UpdateBaseDamage, src/battle_util.c (codegen'd) -- applies at most one declarative
 * or custom modifier per behavior (the C `switch` has exactly one `case` per
 * behavior, so behaviors are mutually exclusive here too).
 */
export function applyMoveBehaviorDamage(baseDamage: number, behaviorId: string | null, behaviors: MoveBehaviors, ctx: DamageContext): BasePowerResult {
  if (!behaviorId) return { power: baseDamage, unmodelled: [] }
  const behavior = behaviors[behaviorId]
  const damage = behavior?.attack?.damage
  if (!damage) return { power: baseDamage, unmodelled: [] }

  const hasCustomCondition = damage.conditions.some((c) => c.kind === 'custom')
  const conditionsMet = hasCustomCondition
    ? damage.conditions.every((c) => (c.kind === 'custom' ? evaluateCustomCondition(behaviorId, ctx) : evaluateAllConditions([c], ctx)))
    : evaluateAllConditions(damage.conditions, ctx)

  if (!conditionsMet) return { power: baseDamage, unmodelled: [] }

  const modifier = damage.modifier
  if (modifier.kind === 'multiply') {
    // The C computes `baseDamage * <float literal>` -- a double multiply truncated on
    // assignment back to a u32, not a UQ_4_12 fixed-point operation.
    return { power: Math.trunc(baseDamage * modifier.value), unmodelled: [] }
  }
  if (modifier.kind === 'add') {
    return { power: baseDamage + modifier.value, unmodelled: [] }
  }
  if (modifier.kind === 'set') {
    // Real upstream bug, ported faithfully: MoveDamageGenerator.kt's SET case emits
    // `baseDamage + set`, not `set` -- "set" behaves exactly like "add".
    return { power: baseDamage + modifier.value, unmodelled: [] }
  }
  if (modifier.kind === 'customFrom') {
    return { power: baseDamage, unmodelled: [`${behaviorId}: customFrom(${modifier.behavior}) not ported`] }
  }
  // modifier.kind === 'custom' -- note Round/Fusion Combo/Acrobatics (custom
  // CONDITIONS) all pair with a plain declarative `multiply` modifier in the actual
  // data, so they're fully handled by the branch above and never reach here; this
  // branch is for the moves whose *damage value itself* needs bespoke code.
  const customDamageFn = CUSTOM_MOVE_DAMAGE[behaviorId]
  if (!customDamageFn) {
    return { power: baseDamage, unmodelled: [`${behaviorId}: no CustomMoveDamage ported`] }
  }
  return { power: customDamageFn(baseDamage, ctx), unmodelled: [] }
}

/** MISC_EFFECT_* sub-cases NOT ported by applyPreModifierBasePower below --
 * DOUBLE_DAMAGE is a coin-flip roll (`Random() % 100 < secondaryEffectChance`, no
 * honest default for a deterministic calculator), TOOK_DAMAGE_BOOST needs a
 * "times hit this battle" counter this engine has no scenario field for, and
 * TRANSMUTE (battle_script_commands.c:7205) isn't a damage effect at all (it
 * copies the target's type onto the user). */
const UNMODELLED_MISC_EFFECTS = new Set(['MISC_EFFECT_DOUBLE_DAMAGE', 'MISC_EFFECT_TOOK_DAMAGE_BOOST', 'MISC_EFFECT_TRANSMUTE'])

/**
 * The single-snapshot slice of CalcMoveBasePower's own switch (:6870-6907) --
 * EFFECT_WAKE_UP_SLAP/EFFECT_SMELLINGSALT (a plain status check) and
 * EFFECT_MISC_HIT's deterministic argument sub-cases. Runs on `actualPower`
 * BEFORE applyMoveBehaviorDamage's caller passes it into
 * calcMoveBasePowerAfterModifiers, matching CalcMoveBasePower's own position
 * ahead of CalcMoveBasePowerAfterModifiers in the real call chain. `alliesFainted`
 * isn't part of DamageContext (only BattlerBattleState carries it, see its own
 * doc) so it's a separate parameter here rather than widening that shared shape
 * for this one rarely-used case. */
/**
 * GetMoveTypeInternal's MOVE_WEATHER_BALL case (src/battle_main.c:5124-5133) and
 * CalcMoveBasePower's EFFECT_WEATHER_BALL case (:6854-6858) resolve to the SAME
 * "is some weather (or Aurora Borealis) active" fact, so both the type and the
 * power-doubling share this one function. `null` means no weather active, no
 * Aurora Borealis -- move stays Normal-type, base power unchanged.
 *
 * Chloroplast (a 4-ability declarative bitfield, always-Fire regardless of
 * weather) is NOT checked here -- it isn't in this pipeline's emitted damage-
 * relevant bitfield set yet, and adding it means a data regeneration this
 * project's convention requires asking about first. A Chloroplast holder using
 * Weather Ball outside Sun therefore under-counts (stays Normal/no boost) rather
 * than over-counting -- the safe-side gap, not a silent wrong-direction one.
 */
export function weatherBallType(weather: string, attackerHasAuroraBorealis: boolean): string | null {
  if (attackerHasAuroraBorealis) return 'ICE'
  if (weather === 'RAIN_PERMANENT' || weather === 'RAIN_TEMPORARY' || weather === 'RAIN_PRIMAL') return 'WATER'
  if (weather === 'SUN_PERMANENT' || weather === 'SUN_TEMPORARY' || weather === 'SUN_PRIMAL') return 'FIRE'
  if (weather === 'SANDSTORM') return 'ROCK'
  if (weather === 'HAIL') return 'ICE'
  if (weather === 'FOG') return 'GHOST'
  return null
}

/** Cmd_setmagnitude's own tier table, src/battle_util.c:11286-11307 -- a pure
 * per-use random roll (0-99) collapsed to its 7 displayed "Magnitude N" outcomes,
 * each with a fixed power. Exposed as a manual tier pick (DamageContext.magnitudeTier)
 * rather than simulated, same "one scenario per call" convention as every other
 * random roll this calculator reports as a range instead of drawing. */
export const MAGNITUDE_POWER: Record<number, number> = { 4: 10, 5: 30, 6: 50, 7: 70, 8: 90, 9: 110, 10: 150 }

/** Same table's probability side, as a percent (sums to 100, matching the C's own
 * 0-99 roll-range widths: 5/10/20/30/20/10/5). calculate.ts's calculateMoveDamage
 * uses this to simulate all 7 tiers and combine them into a real probability-
 * weighted damage distribution instead of asking the user to guess one tier. */
export const MAGNITUDE_PROBABILITY_PERCENT: Record<number, number> = { 4: 5, 5: 10, 6: 20, 7: 30, 8: 20, 9: 10, 10: 5 }

export function applyPreModifierBasePower(
  basePower: number,
  moveEffect: string | null,
  miscEffect: string | null,
  ctx: DamageContext,
  attackerAlliesFainted: number,
  attackerNaturalGiftPower: number | null,
  attackerHasAuroraBorealis: boolean,
  /** Which hit (0-indexed) of the CURRENT move use this is -- Triple Kick/Triple
   * Axel's own power scaling only depends on this, not on any turn-history state,
   * so it needs no scenario toggle: multiHit.ts already resolves the hit count and
   * calculate.ts's per-hit loop already threads an index through, this just reads
   * it. 0 for every non-multi-hit move (the default, single-hit case). */
  hitIndex: number = 0,
): BasePowerResult {
  if (moveEffect === 'EFFECT_WEATHER_BALL') {
    return { power: weatherBallType(ctx.field.weather, attackerHasAuroraBorealis) !== null ? basePower * 2 : basePower, unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_WAKE_UP_SLAP') {
    return { power: ctx.defender.status1.has('STATUS1_SLEEP') || ctx.defender.hasComatose ? basePower * 2 : basePower, unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_SMELLINGSALT') {
    return { power: ctx.defender.status1.has('STATUS1_PARALYSIS') ? basePower * 2 : basePower, unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_NATURAL_GIFT') {
    // Without a berry the C returns 0 outright (the move fails) -- ported as a
    // literal 0 rather than an unmodelled note, since it's a complete, correct
    // answer, not a gap; the caller's existing Math.max(power, 1) floor still
    // applies on top, same as every other move.
    return { power: attackerNaturalGiftPower ?? 0, unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_TRIPLE_KICK') {
    // battle_util.c:6850-6852: basePower *= 4 - multiHitCounter, where
    // multiHitCounter COUNTS DOWN from hitCount to 1 across the 3 hits (3,2,1) --
    // so hitIndex 0/1/2 (counting UP, this calculator's own convention) multiplies
    // by 1/2/3 respectively. Applied here (CalcMoveBasePower's own switch), NOT as
    // a final-modifier hitModifier like Parental Bond's bonus hits -- the two
    // stages truncate independently, so this needs to land at the same pipeline
    // point the C itself uses to stay bit-exact.
    return { power: basePower * (hitIndex + 1), unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_MAGNITUDE') {
    if (ctx.magnitudeTier === null) {
      // calculateMoveDamage's own top-level gate (calculate.ts) intercepts every
      // real EFFECT_MAGNITUDE call BEFORE it reaches here, simulating all 7 tiers
      // and combining them into a real probability-weighted distribution -- this
      // branch only exists as a defensive fallback for a caller that invokes this
      // function directly, bypassing that machinery. No honest single default
      // exists for an unset random roll in isolation, so Magnitude 7 (70 power,
      // the modal/most-likely outcome at 30%) is reported alongside a note, not
      // as a real answer.
      return { power: MAGNITUDE_POWER[7], unmodelled: ['EFFECT_MAGNITUDE: no magnitude tier set -- showing Magnitude 7 (modal outcome) as a rough default'] }
    }
    return { power: MAGNITUDE_POWER[ctx.magnitudeTier], unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_ROLLOUT') {
    // battle_util.c:6838-6844. counter===0: only Defense Curl doubles it (an
    // otherwise-unboosted first use is left at its declared power, matching the
    // C's guard clause exactly -- there's no case where counter 0 alone changes
    // anything). counter>=1: a left SHIFT by (counter-1), i.e. x2^(counter-1) --
    // 1/2/4x for counter 1/2/3, not a linear x1/x2/x3 like Triple Kick.
    if (ctx.attackerRolloutCounter === 0) {
      return { power: ctx.attackerHasDefenseCurl ? basePower * 2 : basePower, unmodelled: [] }
    }
    return { power: basePower * 2 ** (ctx.attackerRolloutCounter - 1), unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_FOCUS_PUNCH') {
    // battle_util.c:6876-6877 -- a full override (not a multiplier) to 40 power
    // if the attacker took ANY damage this turn before acting, matching
    // Focus Punch's real "loses focus and does a weak hit instead of failing
    // outright" mechanic. Was previously bucketed as "needs turn history" --
    // wrong, same mistake as Magnitude/Pursuit: it's a plain scenario fact.
    return { power: ctx.attackerWasHitThisTurn ? 40 : basePower, unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_BEAT_UP') {
    // CalcBeatUpPower, battle_util.c:102-117 -- a full override, applying the
    // exact same floor(baseAttack/10)+5 formula to every hit uniformly (see
    // DamageContext.beatUpBaseAttack's own doc for the "one representative
    // value instead of a real party roster" simplification this makes).
    return { power: Math.floor(ctx.beatUpBaseAttack / 10) + 5, unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_PURSUIT') {
    // battle_util.c:6860-6861 -- doubles only when the DEFENDER's chosen action
    // this turn is a switch, a plain scenario fact (DamageContext.defenderIsSwitching)
    // with no turn-history dependency at all.
    return { power: ctx.defenderIsSwitching ? basePower * 2 : basePower, unmodelled: [] }
  }
  if (moveEffect !== 'EFFECT_MISC_HIT') return { power: basePower, unmodelled: [] }

  const isBleeding = ctx.defender.status1.has('STATUS1_BLEED') || ctx.defender.hasBloodStainEffect
  switch (miscEffect) {
    case 'MISC_EFFECT_FAINTED_MON_BOOST':
      return { power: basePower + 10 * attackerAlliesFainted, unmodelled: [] }
    case 'MISC_EFFECT_ELECTRIC_TERRAIN_BOOST':
      return { power: ctx.field.terrain === 'TERRAIN_ELECTRIC' ? idiv(basePower * 3, 2) : basePower, unmodelled: [] }
    case 'MISC_EFFECT_DOUBLE_DAMAGE_VS_BLEEDING':
      return { power: isBleeding ? basePower * 2 : basePower, unmodelled: [] }
    case 'MISC_EFFECT_50_PERCENT_PLUS_DAMAGE_VS_BLEEDING':
      return { power: isBleeding ? idiv(basePower * 3, 2) : basePower, unmodelled: [] }
    case 'MISC_EFFECT_DOUBLE_DAMAGE_IN_FOG':
      return { power: ctx.field.weather === 'FOG' ? basePower * 2 : basePower, unmodelled: [] }
    default:
      if (miscEffect && UNMODELLED_MISC_EFFECTS.has(miscEffect)) return { power: basePower, unmodelled: [`${miscEffect}: not modelled`] }
      return { power: basePower, unmodelled: [] }
  }
}

/** The move-ID-keyed switch at the end of CalcMoveBasePower (battle_util.c:
 * 6915-6935) -- a SEPARATE hardcoded switch from the effect-keyed one above
 * (applyPreModifierBasePower), for one-off moves whose power depends on the
 * attacker's species/ability or the defender's status rather than a shared
 * move EFFECT. Previously entirely unaudited/unported (not even flagged as
 * unmodelled, since it isn't keyed by effect at all). Runs on whatever power
 * applyPreModifierBasePower already produced, matching the C's own ordering
 * (this switch runs strictly after the effect-switch and UpdateBaseDamage). */
export function applyMoveSpecificBasePower(
  basePower: number,
  moveId: string,
  attackerSpeciesId: string,
  attackerHasAbility: (id: string) => boolean,
  defenderStatus1: Set<string>,
  attackerWasHitThisTurn: boolean,
): number {
  switch (moveId) {
    case 'MOVE_WATER_SHURIKEN':
      if (attackerSpeciesId === 'SPECIES_GRENINJA_ASH') return 20
      if (attackerHasAbility('ABILITY_GIANT_SHURIKEN')) return 100
      return basePower
    case 'MOVE_DRAGON_DARTS':
      return attackerHasAbility('ABILITY_PARENTAL_BOND') ? Math.trunc((basePower * 5) / 4) : basePower
    case 'MOVE_SELF_DESTRUCT':
      // Same attackerWasHitThisTurn fact EFFECT_FOCUS_PUNCH reads above, just a
      // different move-specific effect (double, not a flat override).
      return attackerWasHitThisTurn ? basePower * 2 : basePower
    case 'MOVE_DREAM_INVERSION':
      return defenderStatus1.has('STATUS1_SLEEP') ? basePower * 2 : basePower
    case 'MOVE_FLYING_PRESS':
      return attackerHasAbility('ABILITY_WRESTLE_SHOWMAN') ? basePower + 10 : basePower
    case 'MOVE_ROAR_OF_TIME':
      return attackerHasAbility('ABILITY_TEMPORAL_RUPTURE') ? 100 : basePower
    default:
      return basePower
  }
}

/** Angel's Wrath's OWN move-ID-keyed switch (battle_util.c:6938-6952), gated on
 * the attacker actually holding the ability -- a flat power override for 4
 * specific moves, completely separate from (and layered on top of) the general
 * move-specific switch above. Angel's Wrath's OTHER half (its onTypeEffectiveness
 * hook, Poison Sting-vs-Steel/Electroweb-vs-Ground) was already ported
 * (16-type-effectiveness.ts) -- this base-power half was missed entirely until
 * this session's own audit of CalcMoveBasePower's tail end. */
const ANGELS_WRATH_POWER: Record<string, number> = {
  MOVE_TACKLE: 100,
  MOVE_POISON_STING: 120,
  MOVE_ELECTROWEB: 155,
  MOVE_BUG_BITE: 140,
}

export function applyAngelsWrathBasePower(basePower: number, moveId: string, attackerHasAngelsWrath: boolean): number {
  if (!attackerHasAngelsWrath) return basePower
  return ANGELS_WRATH_POWER[moveId] ?? basePower
}

// ---------------------------------------------------------------------------
// Behaviors whose base-power mechanic lives in CalcMoveBasePower's hardcoded C
// switch (:6803-6886) rather than in moveBehaviors.json -- every effect THAT
// SWITCH ACTUALLY HANDLES is now ported (see the module doc comment for the full
// history, including two that were wrongly bucketed here for a while: Focus
// Punch, and Beat Up, which turned out portable too via one representative
// party-member stand-in rather than a full roster -- see
// DamageContext.beatUpBaseAttack's own doc).
//
// This set is for a WIDER category than that switch, despite the name: any
// effect whose REAL in-battle damage this engine's formula cannot produce at
// all, not only a modifier CalcMoveBasePower's own switch is missing. Found by
// re-measuring moves.json's declared power for every move using each effect
// (matchupReport.ts's own DYNAMIC_DAMAGE_EFFECTS/TRUE_DAMAGE_UNAVAILABLE_EFFECTS
// audit, prompted by a review finding that this calculator was silently
// printing a small, wrong number for them with no warning at all):
//
// - EFFECT_SUPER_FANG, EFFECT_SUPER_FANG_HAZE, EFFECT_LEVEL_DAMAGE,
//   EFFECT_PSYWAVE, EFFECT_DRAGON_RAGE, EFFECT_ENDEAVOR, EFFECT_FINAL_GAMBIT --
//   confirmed ABSENT from CalcMoveBasePower's switch above (:6803-6886), i.e.
//   these moves' real damage bypasses CalcMoveBasePower/DoMoveDamageCalc
//   entirely in the ROM; AI_CalcDamage (battle_ai_util.c:684-703) computes them
//   via its own separate dynamic-damage switch instead, which this engine
//   doesn't port either. (EFFECT_PSYWAVE/EFFECT_DRAGON_RAGE currently have no
//   move using them in this ER data -- both moves were redesigned into ordinary
//   power-based moves with different effects -- kept for fidelity to the C.)
// - EFFECT_COUNTER, EFFECT_MIRROR_COAT, EFFECT_BIDE -- also confirmed absent
//   from the switch above; their real damage (double whatever was received, or
//   double a 2-turn accumulated total) is `legacyConfig`-only in
//   moveBehaviors.json (battle-script bytecode -- `data/battle_scripts_1.s`/
//   `_2.s` under `pipeline/.upstream/eliteredux-source/`, directly readable),
//   and AI_CalcDamage doesn't special-case them either, so it too falls
//   through to the ordinary formula.
//
// A 2026-09-15 systematic re-sweep (the audit above only ever checked
// moves.json's power===1 moves, never power===0) found three more the same
// way: every damaging (split PHYSICAL/SPECIAL) move in moves.json with
// declared power 0 OR 1 -- 24 real moves total, not counting the MOVE_NONE
// placeholder slot (split defaults to PHYSICAL on that empty-slot sentinel,
// which is never actually evaluated by any caller) -- cross-checked one at a
// time against this file's own handling. 20 of the 24 were already accounted
// for: the ten effects above, plus EFFECT_BEAT_UP/EFFECT_MAGNITUDE/
// EFFECT_NATURAL_GIFT (applyPreModifierBasePower below) and EFFECT_LOW_KICK/
// EFFECT_HEAT_CRASH/EFFECT_ELECTRO_BALL/EFFECT_GYRO_BALL (moveBehaviors.json's
// own declarative `attack.damage` with a `custom` modifier, routed through
// CUSTOM_MOVE_DAMAGE above -- MOVE_GRASS_KNOT/MOVE_LOW_KICK, MOVE_HEAT_CRASH/
// MOVE_HEAVY_SLAM/MOVE_SPLASH, and MOVE_ELECTRO_BALL/MOVE_GYRO_BALL
// respectively). The remaining 4 are new -- EFFECT_METAL_BURST
// (MOVE_METAL_BURST, MOVE_COMEUPPANCE) has the identical signature as
// EFFECT_COUNTER above (real damage proportional to the last hit taken, same
// retaliation family), added to the set below. EFFECT_PLACEHOLDER
// (MOVE_AIRBORNE_SLAM) and EFFECT_FETCH (MOVE_FETCH) are NOT added here --
// see ZERO_DAMAGE_BASE_POWER_EFFECTS below for why "not modelled" is the wrong
// label for those two.
//
// A first pass at a broader per-effect sweep -- every one of the 192 distinct
// effects used by a damaging move, not just the power<=1 slice -- inferred
// from declared power alone that no further candidate existed: reasoning that
// every effect lacking a declarative `attack.damage` block but with NORMAL
// (>1) power must have a `legacyConfig` script covering only a secondary
// effect, never the move's own damage. A 2026-09-15 review DISPROVED that
// inference by reading the actual battle scripts rather than inferring from
// declared power: MOVE_SQUALL_HAMMER (PHYSICAL, power=95 -- an entirely
// ordinary-looking value, no low-power signal at all) shares EFFECT_DEFOG
// with the status move MOVE_DEFOG, and BattleScript_EffectDefog
// (`battle_scripts_1.s:1560-1592`) has no damage-dealing step on ANY path --
// an evasion drop and a hazard clear, nothing else -- so Squall Hammer deals
// zero real damage despite its normal-looking power. Declared power is
// therefore NOT a safe proxy once an effect is shared with a STATUS move (a
// damaging move can inherit a pure-status script wholesale).
//
// A follow-up re-measured this directly rather than trust a count relayed
// secondhand (this project's own standing lesson --
// docs/battle-sim/verify-cited-numbers-and-corpus-claims.md): traced, by
// script, all 126 legacy-config effects used by a damaging move, following
// every fallthrough, goto and call from each one's own label, checking each
// visited block against 15 damage-applying opcodes found across both script
// files (damagecalc, adjustdamage, calculatesetdamage,
// counterdamagecalculator, mirrorcoatdamagecalculator,
// metalburstdamagecalculator, setdamagetohealthdifference,
// dmgtocurrattackerhp, dmgtomaxattackerhp, hpfractiontodamage,
// presentdamagecalculation, magnitudedamagecalculation,
// stockpiletobasedamage, painsplitdmgcalc, manipulatedamage -- excluding
// dohazarddamage/weatherdamage, end-of-turn/hazard mechanics unrelated to a
// move's own attack). That traced FIVE effects whose own label never reaches
// any of those opcodes: EFFECT_BIDE, EFFECT_DEFOG, EFFECT_FETCH,
// EFFECT_FUTURE_SIGHT, EFFECT_PLACEHOLDER.
//
// The relayed count was thirteen, not five -- these do NOT disagree, they
// answer DIFFERENT questions, and both are correct for the question each one
// asks. Thirteen is every legacy-config effect (of the 126) whose script
// never reaches the ORDINARY `damagecalc` opcode specifically. Of those
// thirteen, nine deal real damage through their OWN special calculator
// instead -- Bide, Counter, Mirror Coat, Endeavor, Final Gambit, Level
// Damage, Super Fang, Super Fang Haze, and Metal Burst (added by this same
// batch) -- which is exactly why they never touch the ordinary formula; all
// nine are in the "not modelled" sets below. Three deal no damage at all --
// Defog (whose only damaging user is Squall Hammer), Fetch, Placeholder --
// the "zero damage" sets below. One is NOT a gap: Future Sight
// (MOVE_FUTURE_SIGHT/MOVE_DOOM_DESIRE). 9 + 3 + 1 = 13.
//
// Five is the NARROWER, more thorough question this file's own trace asked --
// which of those thirteen never reach ANY damage-applying opcode, special
// calculators included -- and it disagrees with the nine-effect "not
// modelled" group above for a specific, explainable reason: Bide and Future
// Sight's real damage happens through a SEPARATE, delayed script the game's
// own future-attack scheduling triggers (`setbide`/`trysetfutureattack` set
// up the delayed hit; the actual damage step is a different label, not
// reachable via any goto/call FROM the effect's own starting label at all).
// Bide's delayed damage is still genuinely unported (correctly in the "not
// modelled" set below). Future Sight's is NOT: `BattleScript_MonTookFutureAttack`
// (`battle_scripts_1.s:8008-8017`) reaches `damagecalc`/`adjustdamage` -- the
// ordinary formula -- when the delayed hit actually lands, so this engine's
// existing (already-correct, never-flagged) ordinary computation for it is
// right; only the TIMING differs (computed immediately here, landing two
// turns later in the ROM), which a turn-one snapshot calculator doesn't
// represent regardless and isn't a base-power gap. Not treated as a
// candidate; not added to any set.
//
// Seismic Toss is in neither the thirteen nor the five, for the same reason
// it needs UNMODELLED_BASE_POWER_MOVE_IDS below rather than an effect entry:
// its own script branch (`battle_scripts_1.s:5822-5827`, `jumpifmove
// MOVE_SEISMIC_TOSS`) DOES reach a damage step (`calculatesetdamage` for its
// real level-based fixed damage, then `adjustdamage`) -- the ordinary
// ATK/DEF formula still can't reproduce that fixed value, but the script
// itself is not silent about it the way Fetch/Placeholder/Defog are.
//
// The honest limit of the script trace above: it covers legacy-config
// effects reachable from a damaging move; a move in the STATUS split whose
// own script might still carry a real damage step of its own was not
// checked, since a status move's damage was already out of scope. Re-verify
// by reading the scripts directly, not by re-running the power<=1 filter, if
// moveBehaviors.json's legacyConfig set changes on a repin -- see
// [[reference_unmodelled-base-power-sweep-method]] (this project's own agent
// memory) for why the power heuristic was retired rather than reused.
// ---------------------------------------------------------------------------

export const UNMODELLED_BASE_POWER_EFFECTS = new Set<string>([
  'EFFECT_SUPER_FANG',
  'EFFECT_SUPER_FANG_HAZE',
  'EFFECT_LEVEL_DAMAGE',
  'EFFECT_PSYWAVE',
  'EFFECT_DRAGON_RAGE',
  'EFFECT_ENDEAVOR',
  'EFFECT_FINAL_GAMBIT',
  'EFFECT_COUNTER',
  'EFFECT_MIRROR_COAT',
  'EFFECT_BIDE',
  'EFFECT_METAL_BURST',
])

// Move-ID-keyed twin of the effect-keyed set above, for a move whose effect is
// ALSO used by a different move that the ordinary formula computes correctly --
// adding the shared effect to the set above would falsely warn on that other
// move too. Same mechanism matchupReport.ts already built for this exact
// problem (TRUE_DAMAGE_UNAVAILABLE_MOVE_IDS, lib/matchupReport.ts) reused here
// rather than invented a second time.
//
// - MOVE_SEISMIC_TOSS shares EFFECT_SKY_DROP with MOVE_SKY_DROP (power=60) --
//   confirmed by checking every move using EFFECT_SKY_DROP directly
//   (moves.json): Sky Drop's own final hit is a real, ordinary-formula power
//   value the multi-hit/semi-invulnerable machinery already computes
//   correctly, while Seismic Toss (power=1, "deals damage based on level")
//   shares only the id, not the real mechanic. Previously left open
//   deliberately (see this file's git history) because the effect-keyed set
//   above can't discriminate the two; this move-id set is exactly the
//   discriminator that was missing.
export const UNMODELLED_BASE_POWER_MOVE_IDS = new Set<string>(['MOVE_SEISMIC_TOSS'])

// A DIFFERENT class of gap from both sets above: not "a real nonzero number
// exists and this engine can't produce it" (which is what "not modelled"
// says), but "the real number IS zero, confirmed by reading the move's own
// battle script directly, and this engine's Math.max(power, 1) floor
// (calculate.ts) prints a small nonzero one anyway." "Not modelled" would be
// a FALSE claim for these -- there's nothing uncomputed, the real answer is
// simply not what this formula produces. Kept warning-only, same as every
// other set on this page: making the calculator print the correct 0 instead
// of the small wrong number is a real, separate, reviewed decision (a shipped
// number would change), not something to fold into a warning-only batch.
//
// - EFFECT_PLACEHOLDER (MOVE_AIRBORNE_SLAM) -- BattleScript_EffectPlaceholder
//   (`battle_scripts_1.s:2847-2853`) prints STRINGID_NOTDONEYET and ends; no
//   damage step. (Also 0 PP, unselectable in a real game regardless -- kept
//   warned anyway rather than assumed dead data.)
// - EFFECT_FETCH (MOVE_FETCH) -- BattleScript_EffectFetch
//   (`battle_scripts_1.s:5316-5343`) retrieves the held item and switches out
//   (or fails outright with no item to retrieve); no damage step on any path.
export const ZERO_DAMAGE_BASE_POWER_EFFECTS = new Set<string>(['EFFECT_PLACEHOLDER', 'EFFECT_FETCH'])

// Move-ID-keyed twin of ZERO_DAMAGE_BASE_POWER_EFFECTS, for the same reason
// UNMODELLED_BASE_POWER_MOVE_IDS exists above.
//
// - MOVE_SQUALL_HAMMER shares EFFECT_DEFOG with the status move MOVE_DEFOG --
//   BattleScript_EffectDefog (`battle_scripts_1.s:1560-1592`) has no damage
//   step on any path (an evasion drop and a hazard clear), so Squall Hammer
//   deals zero real damage despite its own declared power (95) looking
//   entirely ordinary -- see this file's module comment above for why this
//   one disproved the power<=1 heuristic outright. Keyed by move id because
//   EFFECT_DEFOG is also Defog's own effect, and Defog is a genuine STATUS
//   move this warning has no business flagging.
export const ZERO_DAMAGE_BASE_POWER_MOVE_IDS = new Set<string>(['MOVE_SQUALL_HAMMER'])

// ---------------------------------------------------------------------------
// 2. CalcMoveBasePowerAfterModifiers's own chain (src/battle_util.c:6995-7117).
//    A single accumulated UQ_4_12 modifier, applied once at the end via ApplyModifier
//    -- unlike CalcFinalDmg, nothing here is a "direct" (individually-rounded) step.
// ---------------------------------------------------------------------------

export interface HoldEffectBoost {
  resolvedHoldEffect: string | null
  strength: number | null // holdEffectStrength, clamped 0-100 by percentToModifier
  holdEffectType: string | null // Plate/Type Power's secondary type id, bare name
}

export interface BasePowerModifierContext extends DamageContext {
  moveType: string
  isPhysical: boolean
  isSpecial: boolean
  attackerHoldEffect: HoldEffectBoost
  attackerIsLatiOrLatias: boolean // Soul Dew
  /** IsUnnerveAbilityOnOpposingSide(battlerAtk) -- the DEFENDER's own Unnerve,
   * checked from the attacker's perspective (opposite direction from the resist
   * berry's own Unnerve check in calculate.ts, which looks from the DEFENDER's
   * side at the attacker). Gems only. */
  defenderHasUnnerve: boolean
  /** move.flags.doubleDamageVsMega -- checked FIRST, before the hold-effect switch
   * (:7003-7005), against ConditionBattlerContext.defender.isMegaEvolved (same
   * GetBaseSpeciesFromMega equivalence as Eternal Flower's own check). */
  moveDoubleDamageVsMega: boolean
  /** the move's own `effect` (MoveBehavior id), used for the direct-condition switch
   * below -- distinct from moveBehaviors.json lookups, which key by the same ids. */
  moveEffect: string | null
  /** move.argument, only consulted for EFFECT_DOUBLE_DMG_IF_STATUS1's bitmask target
   * (a single bare STATUS1_* name in this pipeline's emitted data). */
  moveArgumentStatus: string | null
}

function isPoisonedForMove(status1: Set<string>): boolean {
  return status1.has('STATUS1_POISON') || status1.has('STATUS1_TOXIC_POISON') || status1.has('STATUS1_POISON_ANY')
}

/**
 * CalcMoveBasePowerAfterModifiers, src/battle_util.c:6995-7117 -- the hold-effect
 * boosts, the direct move-effect switch, the flat volatile-status modifiers, and the
 * terrain STAB-style +1.3x boost. Everything here reads a single-snapshot fact
 * (current status, current field state, current held item), so unlike §1's excluded
 * behaviors, all of it is implementable without turn history.
 */
export function calcMoveBasePowerAfterModifiers(actualPower: number, ctx: BasePowerModifierContext): number {
  let modifier = uq(1.0)

  // doubleDamageVsMega (:7003-7005) -- checked before the hold-effect switch.
  if (ctx.moveDoubleDamageVsMega && ctx.defender.isMegaEvolved) modifier = mulModifier(modifier, uq(2.0))

  // Attacker's hold effect (:7011-7034)
  const { resolvedHoldEffect, strength, holdEffectType } = ctx.attackerHoldEffect
  const holdEffectModifier = uq(1.0) + percentToModifier(strength ?? 0)
  if (resolvedHoldEffect === 'HOLD_EFFECT_MUSCLE_BAND' && ctx.isPhysical) modifier = mulModifier(modifier, holdEffectModifier)
  else if (resolvedHoldEffect === 'HOLD_EFFECT_WISE_GLASSES' && ctx.isSpecial) modifier = mulModifier(modifier, holdEffectModifier)
  else if (resolvedHoldEffect === 'HOLD_EFFECT_SOUL_DEW' && ctx.attackerIsLatiOrLatias && ctx.isSpecial)
    modifier = mulModifier(modifier, holdEffectModifier)
  else if ((resolvedHoldEffect === 'HOLD_EFFECT_PLATE' || resolvedHoldEffect === 'HOLD_EFFECT_TYPE_POWER') && holdEffectType === ctx.moveType)
    modifier = mulModifier(modifier, holdEffectModifier)
  // HOLD_EFFECT_GEMS's gTurnStructs[].gemBoost looks like turn-history state, but
  // ApplyTypeOverrideInformation/SetTypeBeforeUsingMove (battle_main.c:5222-5261)
  // recompute it fresh on every single move use from static facts (item type match
  // + Unnerve) -- there's no actual history involved, just a cache this static
  // calculator doesn't need and can inline directly.
  else if (resolvedHoldEffect === 'HOLD_EFFECT_GEMS' && holdEffectType === ctx.moveType && !ctx.defenderHasUnnerve)
    modifier = mulModifier(modifier, holdEffectModifier)

  // Move-effect direct switch (:7035-7071)
  switch (ctx.moveEffect) {
    case 'EFFECT_DOUBLE_DMG_IF_STATUS1':
      if (ctx.moveArgumentStatus && ctx.defender.status1.has(ctx.moveArgumentStatus)) modifier = mulModifier(modifier, uq(2.0))
      else if (ctx.moveArgumentStatus === 'STATUS1_POISON_ANY' && isPoisonedForMove(ctx.defender.status1)) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'EFFECT_FACADE':
      if (
        ['STATUS1_BURN', 'STATUS1_POISON', 'STATUS1_TOXIC_POISON', 'STATUS1_PARALYSIS', 'STATUS1_FROSTBITE', 'STATUS1_BLEED'].some((s) =>
          ctx.attacker.status1.has(s),
        ) ||
        ctx.attacker.hasBloodStainEffect
      )
        modifier = mulModifier(modifier, uq(2.0))
      break
    case 'EFFECT_BRINE':
      if (ctx.defender.hp <= idiv(ctx.defender.maxHp, 2)) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'EFFECT_VENOSHOCK':
      if (isPoisonedForMove(ctx.defender.status1)) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'EFFECT_RETALIATE':
      if (ctx.attacker.recentlyFainted) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'EFFECT_SOLARBEAM':
      // hail/sand/rain/fog, not sun -- ER-specific; Chloroplast/Aurora Borealis exempt
      // it, which this v1 pass doesn't model (no ability data yet), so the penalty is
      // applied whenever any of those four weathers is active regardless of ability.
      if (['HAIL', 'SANDSTORM', 'RAIN_PERMANENT', 'RAIN_TEMPORARY', 'RAIN_PRIMAL', 'FOG'].includes(ctx.field.weather))
        modifier = mulModifier(modifier, uq(0.5))
      break
    case 'EFFECT_STOMPING_TANTRUM':
      if (ctx.attacker.lastMoveFailed) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'EFFECT_BULLDOZE':
    case 'EFFECT_MAGNITUDE':
    case 'EFFECT_EARTHQUAKE':
      // ER removed the vanilla 0.5x Grassy Terrain nerf but left the branch in place
      // as a structural no-op (`MulModifier(&modifier, UQ_4_12(1.0))`) -- genuinely
      // does nothing, kept here only as documentation that it was checked.
      break
    case 'EFFECT_KNOCK_OFF':
      if (ctx.defender.itemId !== null) modifier = mulModifier(modifier, uq(1.5))
      break
  }

  // Flat volatile-status modifiers (:7073-7079) -- attacker-side except fear/safePassage
  if (ctx.attacker.helpingHand) modifier = mulModifier(modifier, uq(1.5))
  if (ctx.attacker.ghastlyEcho) modifier = mulModifier(modifier, uq(1.5))
  if (ctx.attacker.chargedUp && ctx.moveType === 'ELECTRIC') modifier = mulModifier(modifier, uq(2.0))
  if (ctx.attacker.meFirst) modifier = mulModifier(modifier, uq(1.5))
  if (ctx.defender.fear) modifier = mulModifier(modifier, uq(1.25))
  if (ctx.defender.safePassage) modifier = mulModifier(modifier, uq(0.65))

  // Terrain STAB-style +1.3x boost for a matching move type (:7081-7101). ER adds
  // Toxic Terrain -> Poison to vanilla's Electric/Psychic/Grassy/Misty(->Fairy) set.
  const TERRAIN_TYPE: Record<string, string> = {
    TERRAIN_ELECTRIC: 'ELECTRIC',
    TERRAIN_PSYCHIC: 'PSYCHIC',
    TERRAIN_GRASSY: 'GRASS',
    TERRAIN_MISTY: 'FAIRY',
    TERRAIN_TOXIC: 'POISON',
  }
  if (ctx.field.terrain && TERRAIN_TYPE[ctx.field.terrain] === ctx.moveType) modifier = mulModifier(modifier, uq(1.3))

  return applyModifier(modifier, actualPower)
}
