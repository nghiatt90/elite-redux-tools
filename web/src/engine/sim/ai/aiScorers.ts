// AI_TryToFaint (battle_ai_main.c:2165-2213), AI_Risky (:4094-4126), AI_HPAware
// (:4180-4346), plus the battle_ai_util.c helpers all three call: IsTargetingPartner
// (:2288-2291), CanIndexMoveFaintTarget (:1340-1347), CanTargetFaintAi (:955-968),
// GetHealthPercentage (:559), GetMoveDamageResult (:794-850), WhichMoveBetter
// (:768-792), GetRecoilFraction (generated, tools/codegen/src/er/move/
// MoveRecoilGenerator.kt -- see getRecoilFraction's own doc), IsAiFaster
// (:916-952), AI_GetMoveEffectiveness (:878-884) and its own AI_GetEffectiveness
// switch (:886-912). IsStatRaisingEffect (:1564-1603) / IsStatLoweringEffect
// (:1605-1629) are ported inline in aiHPAware since neither is reused elsewhere
// in this batch.
//
// AI_DATA->simulatedDmg[atk][def][*] is a battle-start cache GetAiLogicData
// (battle_ai_main.c:223-268) fills by calling AI_CalcDamage once per
// battler-pair-move. This sim has no such cache (state.ts's own scope note:
// only RNG-sequence-only state is omitted, but a precomputed damage table is
// exactly the kind of derived cache a caller can recompute on demand instead of
// storing) -- every helper below that would have read the cache instead calls
// aiCalcDamage/aiCalcPartyMonDamage directly, for the SAME (moveId, attacker,
// defender) triple GetAiLogicData's own loop would have populated it with. The
// numbers are identical; only the caching is gone.
//
// CanTargetFaintAi (battle_ai_util.c:955-968) has a real indexing bug on this
// pinned build: `AI_DATA->simulatedDmg[battlerDef][battlerAtk][moves[i]]`
// indexes the cache's per-MOVE-SLOT dimension (length MAX_MON_MOVES, 4) with
// `moves[i]`, a MoveEnum id (typically in the hundreds) -- not `i`, the loop's
// own slot counter that CanIndexMoveFaintTarget (:1341) and every other caller
// of this cache uses correctly. On real hardware this reads whatever EWRAM
// memory sits past the end of that 4-entry row (the next battler-pair's row,
// and eventually other AiLogicData fields), which is genuine out-of-bounds
// undefined behaviour this port cannot reproduce without emulating the struct's
// memory layout -- unlike aiSwitching.ts's AI_FLAG_DISABLE_SWITCHING bug, which
// has a well-defined reproducible answer (a flag that is always read from the
// wrong word). `canTargetFaintAi` below uses the SLOT index instead (the
// evidently-intended behaviour, matching CanIndexMoveFaintTarget's own
// convention) and this is called out here rather than silently "fixed".

import { idiv } from '../../fixed'
import type { BattleState } from '../state'
import { getWhoStrikesFirst } from '../turnOrder'
import { WEATHER_STRONG_WINDS, hasFlag } from '../constants'
import { weatherHasEffect } from '../fieldEndTurn'
import { aiCalcDamage, aiGetTypeEffectiveness as aiGetTypeEffectivenessRaw, type AiDamageDeps } from './aiCalcDamage'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** IsTargetingPartner, battle_ai_util.c:2288-2291 -- same-side battlers. Always
 * FALSE in this sim's singles battles (battlersCount 2, ids 0/1 on opposite
 * sides), ported in full anyway because AI_HPAware's own partner branch reads
 * it as its FIRST condition and staying general is cheaper than special-casing
 * singles at every call site. */
export function isTargetingPartner(battlerAtk: number, battlerDef: number): boolean {
  return (battlerAtk & 1) === (battlerDef & 1)
}

/** GetHealthPercentage, battle_ai_util.c:559. */
export function getHealthPercentage(state: BattleState, battlerId: number): number {
  const mon = state.battlers[battlerId]?.mon
  if (!mon || mon.maxHp === 0) return 0
  return idiv(100 * mon.hp, mon.maxHp)
}

/** AI_GetEffectiveness, battle_ai_util.c:886-912 -- maps a UQ_4_12 multiplier to
 * the AI_EFFECTIVENESS_x* enum (constants/battle_ai.h:18-25). `default` (any
 * multiplier not one of the six named ones, e.g. a 3x/1.5x ability-modified
 * value) reads as AI_EFFECTIVENESS_x1, matching the C's own fallthrough. */
function aiGetEffectivenessEnum(multiplier: number): number {
  switch (multiplier) {
    case 0:
      return 0 // AI_EFFECTIVENESS_x0
    case 256: // UQ_4_12(0.25) -- UQ_ONE(1024) * 0.25
      return 2 // AI_EFFECTIVENESS_x0_25
    case 512: // UQ_4_12(0.5)
      return 3 // AI_EFFECTIVENESS_x0_5
    case 1024: // UQ_4_12(1.0)
      return 4 // AI_EFFECTIVENESS_x1
    case 2048: // UQ_4_12(2.0)
      return 5 // AI_EFFECTIVENESS_x2
    case 4096: // UQ_4_12(4.0)
      return 6 // AI_EFFECTIVENESS_x4
    default:
      return 4 // AI_EFFECTIVENESS_x1
  }
}

/** AI_GetMoveEffectiveness, battle_ai_util.c:878-884. Status moves (SPLIT_STATUS)
 * are always AI_EFFECTIVENESS_x1 without ever resolving a type multiplier --
 * ported as its own early return, not as "multiply by 1", to match the C not
 * calling AI_GetTypeEffectiveness at all in that case. */
export function aiGetMoveEffectiveness(state: BattleState, moveId: string, battlerAtk: number, battlerDef: number, deps: AiDamageDeps): { effectiveness: number; unmodelled: string[] } {
  const move = deps.moveData(moveId)
  if (move?.split === 'STATUS') return { effectiveness: 4, unmodelled: [] }
  const built = aiGetTypeEffectivenessRaw(state, moveId, battlerAtk, battlerDef, deps)
  return { effectiveness: aiGetEffectivenessEnum(built.effectiveness), unmodelled: built.unmodelled }
}

/** CanIndexMoveFaintTarget, battle_ai_util.c:1340-1347. `numHits` multiplies the
 * looked-up damage before comparing -- ported even though every caller in this
 * batch passes 0 (multi-hit-aware callers are a later batch), so a future
 * caller does not have to relearn this parameter exists. */
export function canIndexMoveFaintTarget(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, numHits: number, deps: AiDamageDeps): { faints: boolean; unmodelled: string[] } {
  const target = state.battlers[battlerDef]?.mon
  if (!target) return { faints: false, unmodelled: [] }
  const { dmg, unmodelled } = aiCalcDamage(state, moveId, battlerAtk, battlerDef, deps)
  const totalDmg = numHits ? dmg * numHits : dmg
  return { faints: target.hp <= totalDmg, unmodelled }
}

/** CanTargetFaintAi, battle_ai_util.c:955-968 -- see this module's header for
 * the indexing-bug note. `battlerDef` here is the C's own first parameter (the
 * POTENTIAL ATTACKER, i.e. the target from the AI's point of view) and
 * `battlerAtk` is the C's second parameter (the AI's own battler) -- kept in
 * the C's own (confusing) parameter order and names so a reader can match this
 * against the source line for line; every call site in this file passes them
 * exactly as the C does (`CanTargetFaintAi(battlerDef, battlerAtk)` inside a
 * function whose OWN battlerAtk/battlerDef are the AI's attacker/target).
 *
 * `AI_DATA->moveLimitations[battlerDef]` (disabled/PP-exhausted/Taunted moves)
 * is not modelled by this sim yet (no caller populates it) -- CHECK_BAD_MOVE
 * and CHECK_VIABILITY, the batches that maintain move limitations, are stubs
 * in this one, so `unusable` reads as "nothing is limited", the same
 * "effect absent" default this project uses elsewhere for an unwired dependency.
 * `GetMovesArray` (:1349-1357) is also not ported: it returns EITHER the real
 * moveset OR the AI's revealed-move history depending on AI_FLAG_CHECK_FOE and
 * whether the battler is itself AI-controlled, and every trainer in the 40
 * fights always carries AI_FLAG_CHECK_FOE (this batch's own aiFlags finding),
 * which makes `GetMovesArray` always return `gBattleMons[battler].moves` on
 * this build -- so the real moveset is used unconditionally, matching that
 * always-true condition rather than reproducing the branch.
 */
export function canTargetFaintAi(state: BattleState, battlerDef: number, battlerAtk: number, deps: AiDamageDeps): { canFaint: boolean; unmodelled: string[] } {
  const potentialAttacker = state.battlers[battlerDef]
  const aiMon = state.battlers[battlerAtk]?.mon
  if (!potentialAttacker || !aiMon) return { canFaint: false, unmodelled: [] }
  const unmodelled: string[] = []
  for (const moveId of potentialAttacker.mon.moves) {
    if (!moveId) continue
    const { dmg, unmodelled: u } = aiCalcDamage(state, moveId, battlerDef, battlerAtk, deps)
    unmodelled.push(...u)
    if (dmg >= aiMon.hp) return { canFaint: true, unmodelled }
  }
  return { canFaint: false, unmodelled }
}

/** GetRecoilFraction, generated by MoveRecoilGenerator.kt from
 * `MOVE_BEHAVIORS[effect].attack.recoilFraction` (filtered to >0 entries) --
 * moveBehaviors.json's own `attack.recoilFraction` field is the SAME source
 * the generator reads, so this is a direct lookup rather than a re-derivation. */
function getRecoilFraction(effect: string | null, moveBehaviors: AiDamageDeps['moveBehaviors']): number {
  if (!effect) return 0
  return moveBehaviors[effect]?.attack?.recoilFraction ?? 0
}

/** IS_MOVE_PHYSICAL, include/battle.h:745. */
function isMovePhysical(moveId: string, deps: AiDamageDeps): boolean {
  return deps.moveData(moveId)?.split === 'PHYSICAL'
}

/**
 * WhichMoveBetter, battle_ai_util.c:768-792. Returns 1 ("move2 is better"), 0
 * ("move1 is better") or 2 ("no preference").
 *
 * The ability/item checks (Rocky Helmet/Iron Barbs/Rough Skin/Double Iron
 * Barbs on the target, Rock Head/Steel Barrel on the AI's own battler) are
 * NARROWED to abilities only -- the C's own condition also ORs in
 * `BATTLE_HISTORY->itemEffects[gBattlerTarget] == HOLD_EFFECT_ROCKY_HELMET`
 * (the AI's OBSERVED knowledge that the target holds Rocky Helmet), but
 * `BattleHistoryState.itemEffects` is a numeric hold-effect id
 * (`0` = "not yet seen") this sim's item data has no id<->HOLD_EFFECT_* table
 * to resolve against (`SimItemData.resolvedHoldEffect` is a bare string, not
 * the numeric id the C compares). Dropping the item half is the conservative
 * direction: Rocky Helmet is rare and "not yet observed" (0) is by far the
 * common case even in the C. The ability half is ALSO read WITHOUT Mold
 * Breaker/Neutralizing Gas suppression -- `battlerHasAbility` needs an
 * `isSuppressed` predicate this sim has no wiring for yet (no caller threads
 * gStatuses3 GASTRO_ACID or a Neutralizing-Gas-on-field fact into this batch).
 * The C's own BATTLER_HAS_ABILITY(..., checkMoldBreaker=TRUE) macro WOULD
 * suppress these under Mold Breaker; this port cannot, and the resulting
 * imprecision is reported as a gap only when one of the four abilities is
 * actually present on the target (i.e. only when it could have mattered),
 * rather than unconditionally.
 */
function whichMoveBetter(state: BattleState, battlerAtk: number, battlerDef: number, move1: string, move2: string, deps: AiDamageDeps): { result: 0 | 1 | 2; unmodelled: string[] } {
  const unmodelled: string[] = []
  const target = state.battlers[battlerDef]?.mon
  const attacker = state.battlers[battlerAtk]?.mon
  const targetHasHurtBackAbility =
    !!target &&
    (target.abilities.ability === 'ABILITY_IRON_BARBS' ||
      target.abilities.ability === 'ABILITY_ROUGH_SKIN' ||
      target.abilities.ability === 'ABILITY_DOUBLE_IRON_BARBS' ||
      target.abilities.innates.includes('ABILITY_IRON_BARBS') ||
      target.abilities.innates.includes('ABILITY_ROUGH_SKIN') ||
      target.abilities.innates.includes('ABILITY_DOUBLE_IRON_BARBS'))
  if (target && target.itemId !== 'ITEM_PROTECTIVE_PADS' && targetHasHurtBackAbility) {
    unmodelled.push('WhichMoveBetter: physical-move-hurts-back check does not model Mold Breaker/Neutralizing Gas suppression of the target ability')
    const move1Physical = isMovePhysical(move1, deps)
    const move2Physical = isMovePhysical(move2, deps)
    if (move1Physical && !move2Physical) return { result: 1, unmodelled }
    if (move2Physical && !move1Physical) return { result: 0, unmodelled }
  }

  const attackerBlocksRecoil = !!attacker && (attacker.abilities.ability === 'ABILITY_ROCK_HEAD' || attacker.abilities.ability === 'ABILITY_STEEL_BARREL')
  if (!attackerBlocksRecoil) {
    const move1Data = deps.moveData(move1)
    const move2Data = deps.moveData(move2)
    const move1Recoil = getRecoilFraction(move1Data?.effect ?? null, deps.moveBehaviors)
    const move2Recoil = getRecoilFraction(move2Data?.effect ?? null, deps.moveBehaviors)
    if (move1Recoil && !move2Recoil && move2Data?.effect !== 'EFFECT_RECHARGE') return { result: 1, unmodelled }
    if (move2Recoil && !move1Recoil && move1Data?.effect !== 'EFFECT_RECHARGE') return { result: 0, unmodelled }
  }

  const effect1 = deps.moveData(move1)?.effect ?? null
  const effect2 = deps.moveData(move2)?.effect ?? null
  if (effect1 === 'EFFECT_RECHARGE' && effect2 !== 'EFFECT_RECHARGE') return { result: 1, unmodelled }
  if (effect2 === 'EFFECT_RECHARGE' && effect1 !== 'EFFECT_RECHARGE') return { result: 0, unmodelled }
  // `gBattleMoves[move].effect == 0` -- EFFECT_NONE (a plain damaging move with
  // no additional effect), not "move data missing". `deps.moveData` returning
  // undefined (an unknown move id) is treated the same as EFFECT_NONE would be
  // for this comparison's purposes, since neither move "has" an effect.
  const hasEffect1 = !!effect1 && effect1 !== 'EFFECT_NONE'
  const hasEffect2 = !!effect2 && effect2 !== 'EFFECT_NONE'
  if (!hasEffect1 && hasEffect2) return { result: 1, unmodelled }
  if (!hasEffect2 && hasEffect1) return { result: 0, unmodelled }

  return { result: 2, unmodelled }
}

/**
 * GetMoveDamageResult, battle_ai_util.c:794-850 -- classifies `move` (at
 * `moveIndex`, the attacker's own slot 0-3) as MOVE_POWER_BEST(1) / GOOD(2) /
 * WEAK(3) among the attacker's OWN four moves. `sDiscouragedPowerfulMoveEffects`
 * (:367-375) is transcribed as a literal set.
 *
 * The `Random() & 1` tie-break inside WhichMoveBetter's caller loop (:827) uses
 * `state.rng`, per the plan's statistical-fidelity decision (not the game's own
 * stream).
 */
const DISCOURAGED_POWERFUL_MOVE_EFFECTS = new Set(['EFFECT_EXPLOSION', 'EFFECT_DREAM_EATER', 'EFFECT_RECHARGE', 'EFFECT_SKULL_BASH', 'EFFECT_FOCUS_PUNCH', 'EFFECT_SUPERPOWER', 'EFFECT_ERUPTION', 'EFFECT_MIND_BLOWN'])

export const MOVE_POWER_OTHER = 0
export const MOVE_POWER_BEST = 1
export const MOVE_POWER_GOOD = 2
export const MOVE_POWER_WEAK = 3

export function getMoveDamageResult(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, moveIndex: number, deps: AiDamageDeps): { result: number; unmodelled: string[] } {
  const unmodelled: string[] = []
  const attacker = state.battlers[battlerAtk]?.mon
  const defender = state.battlers[battlerDef]?.mon
  if (!attacker || !defender) return { result: MOVE_POWER_WEAK, unmodelled }

  const move = deps.moveData(moveId)
  const moveIsDiscouraged = !!move?.effect && DISCOURAGED_POWERFUL_MOVE_EFFECTS.has(move.effect)
  if (!move?.power || moveIsDiscouraged) return { result: MOVE_POWER_WEAK, unmodelled }

  const moveDmgs: number[] = [0, 0, 0, 0]
  for (let i = 0; i < attacker.moves.length; i++) {
    const checkedMoveId = attacker.moves[i]
    if (!checkedMoveId) continue
    const checkedMove = deps.moveData(checkedMoveId)
    const checkedIsDiscouraged = !!checkedMove?.effect && DISCOURAGED_POWERFUL_MOVE_EFFECTS.has(checkedMove.effect)
    if (!checkedMove?.power || checkedIsDiscouraged) continue
    const { dmg, unmodelled: u } = aiCalcDamage(state, checkedMoveId, battlerAtk, battlerDef, deps)
    unmodelled.push(...u)
    moveDmgs[i] = dmg
  }

  const hpCeiling = defender.hp + idiv(5 * defender.hp, 100)
  for (let i = 0; i < moveDmgs.length; i++) {
    if (moveDmgs[i] > hpCeiling) moveDmgs[i] = hpCeiling
  }

  let bestId = 0
  for (let i = 1; i < moveDmgs.length; i++) {
    if (moveDmgs[i] > moveDmgs[bestId]) {
      bestId = i
      continue
    }
    if (moveDmgs[i] === moveDmgs[bestId]) {
      const bestMoveId = attacker.moves[bestId]
      const iMoveId = attacker.moves[i]
      if (!bestMoveId || !iMoveId) continue
      const { result: cmp, unmodelled: u } = whichMoveBetter(state, battlerAtk, battlerDef, bestMoveId, iMoveId, deps)
      unmodelled.push(...u)
      if (cmp === 2) {
        if (state.rng.random16() & 1) continue
        bestId = i
      } else if (cmp === 1) {
        bestId = i
      }
    }
  }

  const currId = moveIndex
  let result: number
  if (currId === bestId) {
    result = MOVE_POWER_BEST
  } else {
    const currMoveId = attacker.moves[currId]
    const bestMoveId = attacker.moves[bestId]
    const percentDiff = idiv(moveDmgs[bestId] * 100, hpCeiling) - idiv(moveDmgs[currId] * 100, hpCeiling)
    let notWorse = 0
    if (currMoveId && bestMoveId) {
      const { result: cmp, unmodelled: u } = whichMoveBetter(state, battlerAtk, battlerDef, bestMoveId, currMoveId, deps)
      unmodelled.push(...u)
      notWorse = cmp
    }
    if ((moveDmgs[currId] >= hpCeiling || moveDmgs[bestId] < hpCeiling) && percentDiff <= 30 && notWorse !== 0) {
      result = MOVE_POWER_GOOD
    } else {
      result = MOVE_POWER_WEAK
    }
  }

  return { result, unmodelled }
}

/**
 * IsAiFaster, battle_ai_util.c:916-952 -- restricted to the `battler ===
 * AI_IS_FASTER` (0) case, the only one this batch's callers (AI_TryToFaint)
 * ever pass. Priority is read as the move's OWN DECLARED value
 * (`deps.moveData(id)?.priority`), not the full ability-adjusted
 * `GetMovePriority` -- the SAME simplification `calculate.ts`'s own `priority`
 * field doc already establishes for Higher Rank's identical `GetMovePriority(...)
 * > 0`-shaped check ("ability-adjusted priority (Prankster etc.) isn't
 * modelled, just the move's own declared value"), not a new approximation
 * invented for this batch.
 */
export function isAiFaster(state: BattleState, aiBattlerId: number, targetBattlerId: number, aiMoveId: string, deps: AiDamageDeps): boolean {
  const prioAi = deps.moveData(aiMoveId)?.priority ?? 0
  let fasterAi = 0
  let fasterPlayer = 0
  const target = state.battlers[targetBattlerId]
  if (target) {
    for (const moveId of target.mon.moves) {
      if (!moveId) continue
      const prioPlayer = deps.moveData(moveId)?.priority ?? 0
      if (prioAi > prioPlayer) fasterAi++
      else if (prioPlayer > prioAi) fasterPlayer++
    }
  }
  if (fasterAi > fasterPlayer) return true
  if (fasterAi < fasterPlayer) return false
  return getWhoStrikesFirst(state, aiBattlerId, targetBattlerId, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios) === 0
}

// ---------------------------------------------------------------------------
// Score functions
// ---------------------------------------------------------------------------

/**
 * AI_TryToFaint, battle_ai_main.c:2165-2213.
 *
 * `GetMovePriority(battlerAtk, move, battlerDef) > 0` (:2172) uses the move's
 * own declared priority, the same Higher-Rank-precedent simplification
 * `isAiFaster` above documents. `GetWhoStrikesFirst(battlerAtk, battlerDef,
 * TRUE)` (:2172) is `getWhoStrikesFirst` with `ignoreChosenMoves=true` and no
 * real actions, matching aiSwitching.ts's `isTruantMonVulnerable` precedent for
 * the same C call shape.
 */
export function aiTryToFaint(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, moveIndex: number, score: number, deps: AiDamageDeps): { score: number; unmodelled: string[] } {
  const unmodelled: string[] = []
  if (isTargetingPartner(battlerAtk, battlerDef)) return { score, unmodelled }

  const move = deps.moveData(moveId)
  if (!move?.power) return { score, unmodelled }

  const faintCheck = canIndexMoveFaintTarget(state, battlerAtk, battlerDef, moveId, 0, deps)
  unmodelled.push(...faintCheck.unmodelled)

  if (faintCheck.faints && move.effect !== 'EFFECT_EXPLOSION') {
    const strikesFirst = getWhoStrikesFirst(state, battlerAtk, battlerDef, [null, null, null, null], true, deps.turnOrder, deps.statStageRatios)
    const priority = move.priority ?? 0
    if (strikesFirst === 0 || priority > 0) score += 4
    else score += 2
  } else {
    if (move.crit === 'HIGH') score += 2

    const dmgResult = getMoveDamageResult(state, battlerAtk, battlerDef, moveId, moveIndex, deps)
    unmodelled.push(...dmgResult.unmodelled)
    if (dmgResult.result === MOVE_POWER_WEAK) score -= 1
    if (dmgResult.result === MOVE_POWER_BEST) score += 1

    const effectivenessResult = aiGetMoveEffectiveness(state, moveId, battlerAtk, battlerDef, deps)
    unmodelled.push(...effectivenessResult.unmodelled)
    // :2185/:2192 -- WEATHER_HAS_EFFECT gates this, so Cloud Nine / Air Lock /
    // Clueless / Clear Skies suppress the discount.
    const strongWindsFlyingImmune =
      weatherHasEffect(state, deps.grounding) && hasFlag(state.field.weather, WEATHER_STRONG_WINDS) && state.battlers[battlerDef]?.mon.types.includes('FLYING')
    if (effectivenessResult.effectiveness === 6) {
      // AI_EFFECTIVENESS_x4
      score += strongWindsFlyingImmune ? 2 : 4
    } else if (effectivenessResult.effectiveness === 5) {
      // AI_EFFECTIVENESS_x2
      if (!strongWindsFlyingImmune) score += 2
    }
  }

  // AI_TryToFaint_CheckIfDanger, :2202-2208.
  if (!isAiFaster(state, battlerAtk, battlerDef, moveId, deps)) {
    const dangerCheck = canTargetFaintAi(state, battlerDef, battlerAtk, deps)
    unmodelled.push(...dangerCheck.unmodelled)
    if (dangerCheck.canFaint) {
      const dmgResult = getMoveDamageResult(state, battlerAtk, battlerDef, moveId, moveIndex, deps)
      unmodelled.push(...dmgResult.unmodelled)
      if (dmgResult.result !== MOVE_POWER_BEST) score -= 1
      else score += 1
    }
  }

  return { score, unmodelled }
}

/** EFFECT_* names AI_Risky's switch tests, battle_ai_main.c:4099-4118 --
 * transcribed as a literal set since every case shares the same `Random() & 1`
 * body. */
const RISKY_EFFECTS = new Set([
  'EFFECT_SLEEP',
  'EFFECT_EXPLOSION',
  'EFFECT_MIRROR_MOVE',
  'EFFECT_OHKO',
  'EFFECT_CONFUSE',
  'EFFECT_METRONOME',
  'EFFECT_PSYWAVE',
  'EFFECT_COUNTER',
  'EFFECT_DESTINY_BOND',
  'EFFECT_SWAGGER',
  'EFFECT_ATTRACT',
  'EFFECT_ALL_STATS_UP_HIT',
  'EFFECT_BELLY_DRUM',
  'EFFECT_MIRROR_COAT',
  'EFFECT_FOCUS_PUNCH',
  'EFFECT_REVENGE',
  'EFFECT_TEETER_DANCE',
])

/** AI_Risky, battle_ai_main.c:4094-4126. */
export function aiRisky(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps): { score: number; unmodelled: string[] } {
  if (isTargetingPartner(battlerAtk, battlerDef)) return { score, unmodelled: [] }

  const move = deps.moveData(moveId)
  if (move?.crit === 'HIGH') score += 2

  if (move?.effect && RISKY_EFFECTS.has(move.effect) && state.rng.random16() & 1) score += 2

  return { score, unmodelled: [] }
}

/** IsStatRaisingEffect, battle_ai_util.c:1564-1603. */
const STAT_RAISING_EFFECTS = new Set([
  'EFFECT_ATTACK_UP', 'EFFECT_ATTACK_UP_2', 'EFFECT_DEFENSE_UP', 'EFFECT_DEFENSE_UP_2', 'EFFECT_DEFENSE_UP_3',
  'EFFECT_SPEED_UP', 'EFFECT_SPEED_UP_2', 'EFFECT_SPECIAL_ATTACK_UP', 'EFFECT_SPECIAL_ATTACK_UP_2', 'EFFECT_SPECIAL_ATTACK_UP_3',
  'EFFECT_SPECIAL_DEFENSE_UP', 'EFFECT_SPECIAL_DEFENSE_UP_2', 'EFFECT_ACCURACY_UP', 'EFFECT_ACCURACY_UP_2',
  'EFFECT_EVASION_UP', 'EFFECT_EVASION_UP_2', 'EFFECT_MINIMIZE', 'EFFECT_DEFENSE_CURL', 'EFFECT_CHARGE', 'EFFECT_CALM_MIND',
  'EFFECT_COSMIC_POWER', 'EFFECT_DRAGON_DANCE', 'EFFECT_ACUPRESSURE', 'EFFECT_SHELL_SMASH', 'EFFECT_SHIFT_GEAR',
  'EFFECT_ATTACK_ACCURACY_UP', 'EFFECT_ATTACK_SPATK_UP', 'EFFECT_GROWTH', 'EFFECT_COIL', 'EFFECT_QUIVER_DANCE',
  'EFFECT_BULK_UP', 'EFFECT_GEOMANCY', 'EFFECT_STOCKPILE',
]) // :1564-1603

/** IsStatLoweringEffect, battle_ai_util.c:1605-1629. */
const STAT_LOWERING_EFFECTS = new Set([
  'EFFECT_ATTACK_DOWN', 'EFFECT_DEFENSE_DOWN', 'EFFECT_SPEED_DOWN', 'EFFECT_SPECIAL_ATTACK_DOWN', 'EFFECT_SPECIAL_DEFENSE_DOWN',
  'EFFECT_ACCURACY_DOWN', 'EFFECT_EVASION_DOWN', 'EFFECT_ATTACK_DOWN_2', 'EFFECT_DEFENSE_DOWN_2', 'EFFECT_SPEED_DOWN_2',
  'EFFECT_SPECIAL_ATTACK_DOWN_2', 'EFFECT_SPECIAL_DEFENSE_DOWN_2', 'EFFECT_ACCURACY_DOWN_2', 'EFFECT_EVASION_DOWN_2',
  'EFFECT_TICKLE', 'EFFECT_CAPTIVATE', 'EFFECT_NOBLE_ROAR',
]) // :1605-1629

/** High-HP discouraged effects, AI_HPAware :4204-4218 (`GetHealthPercentage > 70`). */
const HP_AWARE_HIGH_HP_DISCOURAGED = new Set([
  'EFFECT_EXPLOSION', 'EFFECT_RESTORE_HP', 'EFFECT_REST', 'EFFECT_DESTINY_BOND', 'EFFECT_ENDURE', 'EFFECT_MORNING_SUN',
  'EFFECT_SYNTHESIS', 'EFFECT_MOONLIGHT', 'EFFECT_SHORE_UP', 'EFFECT_SOFTBOILED', 'EFFECT_ROOST', 'EFFECT_MEMENTO', 'EFFECT_GRUDGE',
])
/** Med-HP discouraged effects, AI_HPAware :4226-4240 (30 < HP% <= 70). */
const HP_AWARE_MED_HP_DISCOURAGED = new Set([
  'EFFECT_EXPLOSION', 'EFFECT_BIDE', 'EFFECT_CONVERSION', 'EFFECT_LIGHT_SCREEN', 'EFFECT_MIST', 'EFFECT_FOCUS_ENERGY',
  'EFFECT_CONVERSION_2', 'EFFECT_SAFEGUARD', 'EFFECT_BELLY_DRUM',
])
/** Low-HP discouraged effects, AI_HPAware :4246-4273 (HP% <= 30). */
const HP_AWARE_LOW_HP_DISCOURAGED = new Set([
  'EFFECT_BIDE', 'EFFECT_CONVERSION', 'EFFECT_REFLECT', 'EFFECT_LIGHT_SCREEN', 'EFFECT_AURORA_VEIL', 'EFFECT_MIST', 'EFFECT_FOCUS_ENERGY',
  'EFFECT_RAGE', 'EFFECT_CONVERSION_2', 'EFFECT_LOCK_ON', 'EFFECT_SAFEGUARD', 'EFFECT_BELLY_DRUM', 'EFFECT_PSYCH_UP', 'EFFECT_MIRROR_COAT',
  'EFFECT_SOLARBEAM', 'EFFECT_TWO_TURNS_ATTACK', 'EFFECT_ERUPTION', 'EFFECT_TICKLE', 'EFFECT_SUNNY_DAY', 'EFFECT_SANDSTORM', 'EFFECT_HAIL', 'EFFECT_RAIN_DANCE',
])
/** Discouraged-against-a-medium-HP-target effects, AI_HPAware :4286-4329
 * (target HP 30 < HP% <= 70, the target-HP half of the function). */
const HP_AWARE_TARGET_MED_HP_DISCOURAGED = new Set([
  'EFFECT_ATTACK_UP', 'EFFECT_DEFENSE_UP', 'EFFECT_SPEED_UP', 'EFFECT_SPECIAL_ATTACK_UP', 'EFFECT_SPECIAL_DEFENSE_UP',
  'EFFECT_ACCURACY_UP', 'EFFECT_EVASION_UP', 'EFFECT_ATTACK_DOWN', 'EFFECT_DEFENSE_DOWN', 'EFFECT_SPEED_DOWN',
  'EFFECT_SPECIAL_ATTACK_DOWN', 'EFFECT_SPECIAL_DEFENSE_DOWN', 'EFFECT_ACCURACY_DOWN', 'EFFECT_EVASION_DOWN',
  'EFFECT_MIST', 'EFFECT_FOCUS_ENERGY', 'EFFECT_ATTACK_UP_2', 'EFFECT_DEFENSE_UP_2', 'EFFECT_SPEED_UP_2',
  'EFFECT_SPECIAL_ATTACK_UP_2', 'EFFECT_SPECIAL_DEFENSE_UP_2', 'EFFECT_ACCURACY_UP_2', 'EFFECT_EVASION_UP_2',
  'EFFECT_ATTACK_DOWN_2', 'EFFECT_DEFENSE_DOWN_2', 'EFFECT_SPEED_DOWN_2', 'EFFECT_SPECIAL_ATTACK_DOWN_2',
  'EFFECT_SPECIAL_DEFENSE_DOWN_2', 'EFFECT_ACCURACY_DOWN_2', 'EFFECT_EVASION_DOWN_2', 'EFFECT_POISON', 'EFFECT_PAIN_SPLIT',
  'EFFECT_PERISH_SONG', 'EFFECT_SAFEGUARD', 'EFFECT_TICKLE', 'EFFECT_COSMIC_POWER', 'EFFECT_BULK_UP', 'EFFECT_CALM_MIND',
  'EFFECT_DRAGON_DANCE', 'EFFECT_DEFENSE_UP_3', 'EFFECT_SPECIAL_ATTACK_UP_3',
])

/**
 * AI_HPAware, battle_ai_main.c:4180-4346.
 *
 * `SetTypeBeforeUsingMove`/`GET_MOVE_TYPE` (:4184-4185) resolve the move's
 * dynamic type only for the `IsTargetingPartner` branch's own Volt/Earth/Dry
 * Skin-Water-Absorb ally-safety check (:4189-4192) -- unreachable in this
 * sim's singles battles (`isTargetingPartner` is always false, see its own
 * doc), so that branch and the dynamic-type resolution it alone needs are
 * both dead code here, not a gap. Ported as a direct singles-only skip rather
 * than as unreachable-but-present code, matching aiCalcDamage.ts's own
 * FLAG_TWO_STRIKES precedent for "ported as dead code stays dead code".
 */
export function aiHPAware(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps): { score: number; unmodelled: string[] } {
  const unmodelled: string[] = []
  const move = deps.moveData(moveId)
  const effect = move?.effect ?? null

  if (isTargetingPartner(battlerAtk, battlerDef)) {
    // Unreachable in singles -- see this function's own doc.
    return { score, unmodelled }
  }

  const atkHp = getHealthPercentage(state, battlerAtk)
  if (atkHp > 70) {
    if (effect && HP_AWARE_HIGH_HP_DISCOURAGED.has(effect)) score -= 2
  } else if (atkHp > 30) {
    if (effect && (STAT_RAISING_EFFECTS.has(effect) || STAT_LOWERING_EFFECTS.has(effect))) score -= 2
    if (effect && HP_AWARE_MED_HP_DISCOURAGED.has(effect)) score -= 2
  } else {
    if (effect && (STAT_RAISING_EFFECTS.has(effect) || STAT_LOWERING_EFFECTS.has(effect))) score -= 2
    if (effect && HP_AWARE_LOW_HP_DISCOURAGED.has(effect)) score -= 2
  }

  const faintCheck = canIndexMoveFaintTarget(state, battlerAtk, battlerDef, moveId, 0, deps)
  unmodelled.push(...faintCheck.unmodelled)
  if (faintCheck.faints) {
    score += 2
  } else {
    const defHp = getHealthPercentage(state, battlerDef)
    if (defHp > 70) {
      // nothing -- :4281-4283.
    } else if (defHp > 30) {
      if (effect && HP_AWARE_TARGET_MED_HP_DISCOURAGED.has(effect)) score -= 2
    } else {
      if (move?.split === 'STATUS') score -= 2 // IS_MOVE_STATUS(move), :4335.
    }
  }

  return { score, unmodelled }
}
