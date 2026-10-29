// CheckMoveLimitations, src/battle_util.c:1622-1666, called by the AI as
// `CheckMoveLimitations(battlerId, 0, 0xFF)` from SetBattlerAiData
// (battle_ai_main.c:214-218). Bit i of the returned mask is `gBitTable[i]`,
// i.e. "move slot i is unusable"; BattleAI_SetupAIData (:158-188) zeroes that
// slot's score and GetAiLogicData (:256-261) skips its simulated damage.
//
// FILTER / FILTER_NOT (include/global.h:59-62): `FILTER_NOT(x)` is
// `if (x) continue;` and `FILTER(x)` is `if (!x) continue;`. The loop
// tentatively SETS bit i (:1631) and clears it again only when every
// FILTER_NOT / FILTER line falls through (:1663), so a set bit means "at least
// one limitation fired".
//
// Lines whose input the sim does not hold are named one-by-one below, each only
// when this battler could actually be affected by that line. They contribute no
// bit (that would be inventing a state the sim does not have) and no note is
// silenced by an ability/name list.

import type { BattleState } from '../state'
import { CHOICE_HOLD_EFFECTS, STATUS2_TORMENT, STATUS3_EMBARGO, STATUS3_HEAL_BLOCK, hasFlag } from '../constants'
import { getImprisonedMovesCount, isGravityPreventingMove, isHealingMoveEffect } from '../attackCanceller'
import { isSoundMove } from '../statusEffects'
import { defAbility, getBattlerHoldEffect, selfAbility } from './aiAbilityHelpers'
import type { AiDamageDeps } from './aiCalcDamage'

/** include/battle_util.h:7-12. */
const MOVE_LIMITATION_ZEROMOVE = 1 << 0
const MOVE_LIMITATION_PP = 1 << 1
const MOVE_LIMITATION_DISABLED = 1 << 2
const MOVE_LIMITATION_TORMENTED = 1 << 3
const MOVE_LIMITATION_TAUNT = 1 << 4
const MOVE_LIMITATION_IMPRISON = 1 << 5
/** `check` is 0xFF at the AI's own call site (battle_ai_main.c:218), so every
 * MOVE_LIMITATION_* bit above is enabled. */
const MOVE_LIMITATION_CHECK_ALL = 0xff

export interface MoveLimitationsResult {
  /** `unusableMoves` return value; bit i == slot i. */
  mask: number
  unmodelled: string[]
}

/**
 * Ports CheckMoveLimitations(battlerId, 0, 0xFF) for one battler. `AI_DATA->
 * moveLimitations[battlerId]` is filled only for live battlers
 * (battle_ai_main.c:214-218) on a freshly memset AI_DATA (:219), so it is
 * computed on demand here rather than stored.
 */
export function computeMoveLimitations(state: BattleState, battlerId: number, deps: AiDamageDeps): MoveLimitationsResult {
  const battler = state.battlers[battlerId]
  const unmodelled: string[] = []
  if (!battler) return { mask: 0, unmodelled }
  if (battler.mon.hp === 0) return { mask: 0, unmodelled }

  const note = (msg: string): void => {
    if (!unmodelled.includes(msg)) unmodelled.push(msg)
  }
  // GetBattlerHoldEffect(battlerId, TRUE) (:1623) goes through IsItemNegated
  // (battle_util.c:6520-6524: Embargo or Klutz), so a negated item cannot lock
  // anything -- without this gate the notes below would fire on battlers the C
  // never reaches.
  const itemNegated = hasFlag(battler.statuses3, STATUS3_EMBARGO) || selfAbility(state, deps, battler, 'ABILITY_KLUTZ')
  const holdEffect = itemNegated ? null : getBattlerHoldEffect(battler, deps)
  const statusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }
  const moveData = (moveId: string | null) => (moveId ? deps.moveData(moveId) : undefined)
  const moves = battler.mon.moves

  // :1646 -- `HOLD_EFFECT_CHOICE(holdEffect) && *choicedMove != 0 && *choicedMove != 0xFFFF &&
  // *choicedMove != moves[i]`. The per-slot bit is set in the loop below, where moves[i] is known;
  // `battler.choicedMove` is the state MOVEEND_CHOICE_MOVE writes (moveEnd.ts applyMoveEndChoiceMove).
  // :1647-1648 -- Assault/Tactical Vest, any status move other than Me First
  // (the per-slot bit is set in the loop below, where the move's split is known).
  // :1654-1655 -- Discipline and :1660-1661 Gorilla Tactics / Sage Power read the
  // same choicedMove array; both are filters in the loop below, where moves[i] is known.
  // :1651 -- IsBelchPreventingMove (:1406-1412) reads gBattleStruct->ateBerry
  // and the item pocket; neither is modelled.
  if (moves.includes('MOVE_BELCH')) {
    note("CheckMoveLimitations' Belch check (battle_util.c:1651, IsBelchPreventingMove :1406-1412) is not modelled: ateBerry has no state in the sim and items.json carries no pocket")
  }
  // :1653 -- ItemId_GetPocket(gBattleMons[gActiveBattler].item) != POCKET_BERRIES.
  if (moves.includes('MOVE_STUFF_CHEEKS')) {
    note("CheckMoveLimitations' Stuff Cheeks berry check (battle_util.c:1653) is not modelled: items.json carries no POCKET_BERRIES grouping")
  }
  // :1656-1658 -- gLastChosenMove and the four ability-state exemptions.
  if (moves.some((m) => m !== null && moveData(m)?.flags?.everyOtherTurn)) {
    note("CheckMoveLimitations' every-other-turn check (battle_util.c:1656-1658) is not modelled: gLastChosenMove and the Rampage/Master Hand/Raging Goddess/Berserker Rage ability states are not tracked by the sim")
  }
  // :1659 -- IsSleepClauseDisablingMove (:4977-5018).
  if (moves.some((m) => { const e = moveData(m)?.effect; return e === 'EFFECT_SLEEP' || e === 'EFFECT_YAWN' })) {
    note("CheckMoveLimitations' sleep-clause check (battle_util.c:1659, IsSleepClauseDisablingMove :4977-5018) is not modelled: gameDifficulty, the monotype-champ Dark exemption and the doubles partner-chosen-move half have no state in the sim")
  }
  // :1632-1633 -- the monotype-champion line: every status move is unusable on
  // the player's side under a Fighting monotype champion.
  if (deps.grounding.monotypeChampType === 'FIGHTING' && (battlerId & 1) === 0 && moves.some((m) => m !== null && moveData(m)?.split === 'STATUS')) {
    note("CheckMoveLimitations' monotype-champion status-move lock (battle_util.c:1632-1633) is not modelled")
  }

  // IsHealBlockPreventingMove, battle_util.c:1400-1404: Heal Block on this
  // battler OR ABILITY_PERMANENCE on any live opposing-side battler
  // (IsAbilityOnOpposingSide -> IsAbilityOnSide reads `BattlerHasAbility(i,
  // ability, TRUE)`, so the Mold Breaker flag applies).
  let permanenceOnOpposingSide = false
  for (let id = 0; id < state.battlersCount; id++) {
    if ((id & 1) === (battlerId & 1)) continue
    const foe = state.battlers[id]
    if (!foe || foe.mon.hp === 0) continue
    if (defAbility(state, deps, foe, 'ABILITY_PERMANENCE', deps.grounding.attackerHasMoldBreaker)) {
      permanenceOnOpposingSide = true
      break
    }
  }

  let unusableMoves = 0
  for (let i = 0; i < 4; i++) {
    // :1630-1631.
    if (unusableMoves & (1 << i)) continue
    unusableMoves |= 1 << i
    const moveId = moves[i]

    // :1632-1633 -- see the monotype-champion note above (no bit possible).
    // :1634 -- empty slot.
    if (moveId === null && MOVE_LIMITATION_CHECK_ALL & MOVE_LIMITATION_ZEROMOVE) continue

    // :1635-1639 -- PP 0, except Spit Up / Swallow while a stockpile exists.
    if (battler.mon.pp[i] === 0 && MOVE_LIMITATION_CHECK_ALL & MOVE_LIMITATION_PP) {
      const effect = moveData(moveId)?.effect ?? null
      if (!(effect === 'EFFECT_SPIT_UP' || effect === 'EFFECT_SWALLOW')) continue
      if (!battler.volatiles.stockpileCounter) continue
    }

    // :1640 -- disabled move.
    if (battler.volatiles.disabledMove !== null && battler.volatiles.disabledMove === moveId && MOVE_LIMITATION_CHECK_ALL & MOVE_LIMITATION_DISABLED) continue
    // :1641-1642 -- Torment vs gLastMoves.
    if (moveId !== null && moveId === battler.lastMove && MOVE_LIMITATION_CHECK_ALL & MOVE_LIMITATION_TORMENTED && hasFlag(battler.mon.status2, STATUS2_TORMENT)) continue
    // :1643 -- Taunt vs a power-0 move.
    if (battler.volatiles.tauntTimer && MOVE_LIMITATION_CHECK_ALL & MOVE_LIMITATION_TAUNT && (moveData(moveId)?.power ?? 0) === 0) continue
    // :1644 -- Imprison.
    if (moveId !== null && getImprisonedMovesCount(state, battlerId, moveId) > 0 && MOVE_LIMITATION_CHECK_ALL & MOVE_LIMITATION_IMPRISON) continue
    // :1645 -- Encore locks every slot but the encored move.
    if (battler.volatiles.encoreTimer && battler.volatiles.encoredMove !== moveId) continue
    // :1646 -- Choice item lock. `holdEffect` already went through GetBattlerHoldEffect(TRUE)'s
    // negation, so Klutz/Embargo keep the full menu (the C reads the same negated value at :1623).
    if (
      holdEffect !== null &&
      CHOICE_HOLD_EFFECTS.includes(holdEffect) &&
      battler.choicedMove !== null &&
      battler.choicedMove !== moveId
    )
      continue
    // :1647-1648 -- Assault/Tactical Vest, any status move other than Me First.
    if (
      (holdEffect === 'HOLD_EFFECT_ASSAULT_VEST' || holdEffect === 'HOLD_EFFECT_TACTICAL_VEST') &&
      moveId !== 'MOVE_ME_FIRST' &&
      moveData(moveId)?.split === 'STATUS'
    )
      continue
    // :1649 -- Gravity.
    if (moveId !== null && isGravityPreventingMove(state, moveId, deps.grounding)) continue
    // :1650 -- Heal Block (IsHealBlockPreventingMove, battle_util.c:1400-1404).
    if (moveId !== null && (hasFlag(battler.statuses3, STATUS3_HEAL_BLOCK) || permanenceOnOpposingSide)) {
      const md = moveData(moveId)
      if (isHealingMoveEffect(md?.effect ?? null) && md?.split === 'STATUS') continue
    }
    // :1651 Belch / :1653 Stuff Cheeks / :1656-1658 every-other-turn / :1659
    // sleep clause -- all noted above, each with no state to test.
    // :1652 -- Throat Chop vs sound moves.
    if (battler.volatiles.throatChopTimer && moveId !== null && isSoundMove(state, battlerId, moveId, statusDeps, unmodelled)) continue
    // :1654-1655 -- Discipline reads the same choicedMove array. The C passes FALSE for mold breaker
    // (BattlerHasAbility(b, ..., FALSE)), so selfAbility; the lock is written by MOVEEND_CHOICE_MOVE's
    // Discipline-rampage branch (moveEnd.ts applyMoveEndChoiceMove).
    if (
      selfAbility(state, deps, battler, 'ABILITY_DISCIPLINE') &&
      battler.choicedMove !== null &&
      battler.choicedMove !== moveId
    )
      continue
    // :1660-1661 -- Gorilla Tactics / Sage Power, the same choicedMove lock. BATTLER_HAS_ABILITY is the
    // checkMoldBreaker=TRUE form, so defAbility (the same helper the old note used).
    if (
      (defAbility(state, deps, battler, 'ABILITY_GORILLA_TACTICS', deps.grounding.attackerHasMoldBreaker) ||
        defAbility(state, deps, battler, 'ABILITY_SAGE_POWER', deps.grounding.attackerHasMoldBreaker)) &&
      battler.choicedMove !== null &&
      battler.choicedMove !== moveId
    )
      continue
    // :1662 -- isMoveDisabled (pokemon.c:6265-6289): every branch of its body
    // is commented out and it returns FALSE unconditionally, so this line can
    // never fire. Ported as the C reads today, not as its comment blocks wish.
    // :1663.
    unusableMoves ^= 1 << i
  }

  return { mask: unusableMoves, unmodelled }
}
