// Evaluates moveBehaviors.json's ScriptCondition entries -- the declarative
// predicates behind a move's `attack.damage.conditions` list. These aren't evaluated
// by any runtime C function; ER's Kotlin codegen (tools/codegen/src/er/move/
// MoveDamageGenerator.kt) bakes each condition into a literal `REQUIRE(...)` call
// inside a generated switch statement at BUILD time. This module is the runtime
// equivalent: same semantics as the C helper functions in src/script_conditions.cc
// (StatusCondition, Damaged, ActsAfter, TerrainCondition, ...), driven by a
// DamageContext snapshot instead of live battle globals.
//
// Multiple conditions in one move's list are AND'd together (REQUIRE breaks out of
// the switch -- i.e. "return baseDamage unmodified" -- on the first failure,
// src/script_conditions.cc via MoveDamageGenerator.kt). Within a single `species` or
// `item` condition, multiple listed species/items/hold-effects are OR'd
// (`.joinToString(" || ")` in the generator).

import type { ConditionBattlerContext, DamageContext } from './types'

// A ScriptCondition entry as emitted by erdata.move_behavior.script_condition_to_dict
// -- see pipeline/src/erdata/move_behavior.py for the full shape per `kind`.
export type ScriptCondition =
  | { kind: 'weather'; weather: string; battler: 'BATTLER_NONE' | 'BATTLER_ATTACKER' | 'BATTLER_TARGET' }
  | { kind: 'damaged'; battler: 'BATTLER_ATTACKER' | 'BATTLER_TARGET'; by: 'BATTLER_NONE' | 'BATTLER_ATTACKER' | 'BATTLER_TARGET' }
  | { kind: 'status'; status: string; battler: 'BATTLER_ATTACKER' | 'BATTLER_TARGET' }
  | { kind: 'switching'; battler: 'BATTLER_ATTACKER' | 'BATTLER_TARGET' }
  | { kind: 'actsAfter'; before: string; after: string; failIfSwitching: boolean }
  | { kind: 'terrain'; terrain: string; battler: 'BATTLER_NONE' | 'BATTLER_ATTACKER' | 'BATTLER_TARGET' }
  | { kind: 'fieldEffect'; effect: string }
  | { kind: 'ability'; ability: string; battler: 'BATTLER_ATTACKER' | 'BATTLER_TARGET'; checkMoldBreaker: boolean }
  | { kind: 'hp'; hp: string; battler: 'BATTLER_ATTACKER' | 'BATTLER_TARGET' }
  | { kind: 'recentFainted'; battler: 'BATTLER_ATTACKER' | 'BATTLER_TARGET' }
  | { kind: 'custom' }
  | { kind: 'species'; species: string[]; battler: 'BATTLER_ATTACKER' | 'BATTLER_TARGET'; exact: boolean }
  | { kind: 'item'; item: string[]; holdEffect: string[]; battler: 'BATTLER_ATTACKER' | 'BATTLER_TARGET'; skipDisabling: boolean }

function battlerOf(ctx: DamageContext, which: 'BATTLER_ATTACKER' | 'BATTLER_TARGET'): ConditionBattlerContext {
  return which === 'BATTLER_ATTACKER' ? ctx.attacker : ctx.defender
}

/**
 * StatusCondition, src/script_conditions.cc:22-29. `status` is a bare STATUS1_* or
 * STATUS2_INFATUATION name (ScriptConditions.proto's Status enum covers both status
 * banks in one enum, including the STATUS1_ANY/STATUS1_POISON_ANY/STATUS1_CAN_ACT
 * aggregate values -- v1 only implements the concrete single-status and STATUS1_ANY/
 * STATUS2_INFATUATION cases actually used by the 27 damage-modifier configs).
 */
function evalStatus(status: string, battler: ConditionBattlerContext): boolean {
  if (status === 'STATUS2_INFATUATION') return battler.isInfatuated
  if (status === 'STATUS1_ANY') return battler.status1.size > 0
  if (status === 'STATUS1_SLEEP') return battler.status1.has('STATUS1_SLEEP') || battler.hasComatose
  if (status === 'STATUS1_BLEED') return battler.status1.has('STATUS1_BLEED') || battler.hasBloodStainEffect
  return battler.status1.has(status)
}

/** Damaged, src/script_conditions.cc:43-47 -- NOTE the `by === 'BATTLER_NONE'` guard
 * makes this unconditionally false whenever a config's `by` field is left at its
 * proto3 default (0 = BATTLER_NONE). Ported faithfully: if an upstream config never
 * sets `by`, its Damaged() condition really is dead code in the ROM too. */
function evalDamaged(battler: ConditionBattlerContext, by: 'BATTLER_NONE' | 'BATTLER_ATTACKER' | 'BATTLER_TARGET'): boolean {
  if (battler.wasDamagedThisTurnBy === 'none') return false
  if (by === 'BATTLER_NONE') return false
  const damagedBy = battler.wasDamagedThisTurnBy === 'attacker' ? 'BATTLER_ATTACKER' : 'BATTLER_TARGET'
  return damagedBy === by
}

/** ActsAfter, src/script_conditions.cc:51-64, specialized to the only two battlers a
 * singles calculator has (BATTLER_NONE branches -- "any battler acted yet" -- don't
 * apply outside a real turn order and aren't used by any of the 27 damage configs
 * this pipeline currently emits, so they throw rather than silently misresolve).
 * `failIfSwitching` is a switch-in interaction with no meaning for a static
 * "what if I attack right now" calculator, and is ignored. */
function evalActsAfter(ctx: DamageContext, before: string, after: string): boolean {
  if (before === 'BATTLER_NONE' || after === 'BATTLER_NONE') {
    throw new Error(`ActsAfter(${before}, ${after}): BATTLER_NONE branch not modelled by this calculator`)
  }
  const attackerOrder = ctx.attackerActsFirst ? 0 : 1
  const targetOrder = ctx.attackerActsFirst ? 1 : 0
  const orderOf = (b: string) => (b === 'BATTLER_ATTACKER' ? attackerOrder : targetOrder)
  return orderOf(after) > orderOf(before)
}

/** TerrainCondition, src/script_conditions.cc:67-79. `battler` is accepted but not
 * distinguished from the field-wide check in v1 (no per-battler terrain-seed
 * immunity modelled) -- both read `ctx.field.terrain`. TERRAIN_ANY (=6 in the proto,
 * a "some terrain is up" sentinel distinct from any one terrain enum value) matches
 * whenever any terrain is active. */
function evalTerrain(ctx: DamageContext, terrain: string): boolean {
  if (terrain === 'TERRAIN_NONE') return ctx.field.terrain === null
  if (terrain === 'TERRAIN_ANY') return ctx.field.terrain !== null
  return ctx.field.terrain === terrain
}

/** FieldEffectCondition, src/script_conditions.cc:86-93 -- only FIELD_EFFECT_GRAVITY
 * is a real value in the proto (the enum's other member, FIELD_EFFECT_NONE, has no
 * case in the C switch and would fall to its `default: return FALSE`). */
function evalFieldEffect(ctx: DamageContext, effect: string): boolean {
  if (effect === 'FIELD_EFFECT_GRAVITY') return ctx.field.gravityActive
  return false
}

/** SpeciesCondition, src/script_conditions.cc:112-117. Multiple species in one
 * condition are OR'd (MoveDamageGenerator.kt's `.joinToString(" || ")`). */
function evalSpecies(battler: ConditionBattlerContext, species: string[], exact: boolean): boolean {
  return species.some((s) => (exact ? battler.speciesId === s : battler.baseSpeciesId === s))
}

/** ItemCondition, src/script_conditions.cc:119-127 -- item ids and hold effects in
 * one condition are OR'd together (MoveDamageGenerator.kt concatenates both lists
 * before joining), and each check independently applies `checkDisabling` (the
 * inverse of the proto's own `skip_disabling` -- see ItemGenerator's `!skipDisabling`
 * negation, kept exactly as the generator writes it). */
function evalItem(battler: ConditionBattlerContext, item: string[], holdEffect: string[], skipDisabling: boolean): boolean {
  const checkDisabling = !skipDisabling
  const byId = item.some((i) => battler.itemId === i && (!checkDisabling || !battler.itemNegated))
  const byHoldEffect = holdEffect.some((h) => battler.resolvedHoldEffect === h && (!checkDisabling || !battler.itemNegated))
  return byId || byHoldEffect
}

/**
 * Evaluates one ScriptCondition against a DamageContext snapshot. `custom` conditions
 * (Fusion Combo, Acrobatics, Round) are NOT handled here -- they're per-behavior
 * hardcoded C++ (CustomMoveCondition<> specializations), and basePower.ts dispatches
 * them by MoveBehavior id directly rather than through this generic evaluator.
 * Calling this with `kind: 'custom'` is a programming error, not a data gap.
 */
export function evaluateCondition(condition: ScriptCondition, ctx: DamageContext): boolean {
  switch (condition.kind) {
    case 'weather':
      // No damage-modifier config in the current data uses a weather condition
      // (re-verified 2026-09-03, all 69 structured/non-legacy moveBehaviors.json
      // configs); the three-tier weather model (FieldState) needed to implement
      // this properly belongs in finalDamage.ts's own weather block, not
      // duplicated here.
      throw new Error('ScriptCondition kind "weather" is not modelled by evaluateCondition')
    case 'damaged':
      return evalDamaged(battlerOf(ctx, condition.battler), condition.by)
    case 'status':
      return evalStatus(condition.status, battlerOf(ctx, condition.battler))
    case 'switching':
      // Verified (2026-09-03, all 69 structured/non-legacy moveBehaviors.json
      // configs): none currently reference this condition kind.
      throw new Error('ScriptCondition kind "switching" is not modelled by evaluateCondition')
    case 'actsAfter':
      return evalActsAfter(ctx, condition.before, condition.after)
    case 'terrain':
      return evalTerrain(ctx, condition.terrain)
    case 'fieldEffect':
      return evalFieldEffect(ctx, condition.effect)
    case 'ability':
      // Verified (2026-09-03, same sweep as 'switching' above): none currently
      // reference this condition kind either. Re-check this if abilityHooks.json
      // or moveBehaviors.json is regenerated from a newer upstream commit --
      // this throw is a deliberate crash-not-silently-wrong choice, not a safe
      // default, precisely because it's unverified for FUTURE data.
      throw new Error('ScriptCondition kind "ability" is not modelled by evaluateCondition (needs the ability registry)')
    case 'hp':
      if (condition.hp === 'HP_LOW') {
        const b = battlerOf(ctx, condition.battler)
        return b.hp <= Math.floor(b.maxHp / 2)
      }
      return false
    case 'recentFainted':
      return battlerOf(ctx, condition.battler).recentlyFainted
    case 'custom':
      throw new Error('ScriptCondition kind "custom" must be dispatched by MoveBehavior id, not evaluateCondition')
    case 'species':
      return evalSpecies(battlerOf(ctx, condition.battler), condition.species, condition.exact)
    case 'item':
      return evalItem(battlerOf(ctx, condition.battler), condition.item, condition.holdEffect, condition.skipDisabling)
  }
}

/** AND-folds a full condition list, matching REQUIRE's break-on-first-failure. */
export function evaluateAllConditions(conditions: ScriptCondition[], ctx: DamageContext): boolean {
  return conditions.every((c) => evaluateCondition(c, ctx))
}
