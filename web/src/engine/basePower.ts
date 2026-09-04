// Variable base power, ported from three distinct mechanisms in
// eliteredux-source (see docs cited on each function):
//
//   1. UpdateBaseDamage -- codegen'd from moveBehaviors.json's declarative
//      `attack.damage` blocks (27 of 460 behaviors) plus the "custom" oneof cases,
//      which are hand-written C++ template specializations in src/script_conditions.cc.
//   2. CalcMoveBasePowerAfterModifiers's own multiplier chain (src/battle_util.c:
//      6995-7117) -- hold effects, per-move-effect conditions (Facade, Brine,
//      Venoshock, Retaliate, Knock Off, ...), and the terrain STAB-style boost.
//   3. CalcMoveBasePower's hardcoded pre-switch (:6825-6913) and move-id switch
//      (:6913-6940) -- MOSTLY not ported (see UNMODELLED_BASE_POWER_EFFECTS):
//      Rollout, Magnitude, Triple Kick, Weather Ball, Pursuit, Natural Gift, Focus
//      Punch, and Beat Up all depend on turn history (a rollout counter, "did my
//      last move fail", how many times I've been hit this battle, party contents)
//      that a stateless "what if I attacked right now" calculator has no honest
//      default for. Wake-Up Slap/Smelling Salts and the single-snapshot
//      EFFECT_MISC_HIT sub-cases (electric terrain, vs-bleeding, fog,
//      fainted-teammate count) ARE ported (applyPreModifierBasePower, below) --
//      they're pure functions of the field/battler snapshot DamageContext (plus
//      alliesFainted) already carries. The remaining EFFECT_MISC_HIT sub-cases
//      (a coin-flip double-damage roll, a "times hit this battle" counter, and a
//      non-damage type-transmute effect) are surfaced as unmodelled instead.

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
export function applyPreModifierBasePower(basePower: number, moveEffect: string | null, miscEffect: string | null, ctx: DamageContext, attackerAlliesFainted: number): BasePowerResult {
  if (moveEffect === 'EFFECT_WAKE_UP_SLAP') {
    return { power: ctx.defender.status1.has('STATUS1_SLEEP') || ctx.defender.hasComatose ? basePower * 2 : basePower, unmodelled: [] }
  }
  if (moveEffect === 'EFFECT_SMELLINGSALT') {
    return { power: ctx.defender.status1.has('STATUS1_PARALYSIS') ? basePower * 2 : basePower, unmodelled: [] }
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

// ---------------------------------------------------------------------------
// Behaviors whose base-power mechanic lives in CalcMoveBasePower's hardcoded C
// switch (:6825-6913) rather than in moveBehaviors.json, and are NOT ported --
// see the module doc comment for why. Surfaced explicitly so a move using one of
// these shows an honest "not modelled" instead of silently using its listed base
// power as if no special mechanic applied.
// ---------------------------------------------------------------------------

export const UNMODELLED_BASE_POWER_EFFECTS = new Set([
  'EFFECT_ROLLOUT',
  'EFFECT_MAGNITUDE',
  'EFFECT_TRIPLE_KICK',
  'EFFECT_WEATHER_BALL',
  'EFFECT_PURSUIT',
  'EFFECT_NATURAL_GIFT',
  'EFFECT_FOCUS_PUNCH',
  'EFFECT_BEAT_UP',
])

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
