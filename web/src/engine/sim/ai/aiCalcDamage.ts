// AI_CalcDamage / AI_CalcPartyMonDamage, src/battle_ai_util.c:650-765 and :2429-2440.
// The AI's OWN estimate of a move's damage -- deliberately NOT the same number
// calculateMoveDamage's own rolls[] give a player: no random roll spread (the
// C's own randomFactor=FALSE), and the player's held item/moves are blanked
// until the AI has actually observed them (SetBattlerData, :520-543).
//
// Reuses the existing damage engine (calculateMoveDamage) for the single-hit
// formula itself -- crit stage, base power, attack/defense, type
// effectiveness, all of CalcFinalDmg's own modifier stack -- and layers
// AI_CalcDamage's OWN arithmetic on top exactly as the C does: the crit-chance
// blend, the fixed-damage effect overrides, and the multi-hit multiplier
// switch. The engine's calculateMoveDamage itself is NOT modified by this
// module.
//
// One pre-existing gap in the shared damage path, not introduced here:
// Monotype Champion's own post-formula multiplier switch
// (DoMoveDamageCalcInternal, battle_util.c:7716-7756) is applied by NEITHER
// AI_CalcDamage's normal path NOR calculateMoveDamage (grep-verified:
// grounding.ts's monotypeChampType is read only for the Wonder Room trigger).
// Reported as an unmodelled gap by name whenever a monotype champion is on the
// field, rather than hacked around here -- calculateMoveDamage "must not
// change" per this batch's own brief.

import type { MoveData, DamageCalcScenario } from '../../calculate'
import { calculateMoveDamage } from '../../calculate'
import type { BattleConstants } from '../../types'
import type { MoveBehaviors } from '../../basePower'
import type { TypeChart } from '../../typeEffectiveness'
import { applyModifier, idiv } from '../../fixed'
import { computeParentalBondTrigger, getParentalBondMultiplier } from '../../abilities/dispatchCalc'
import type { ParentalBondTrigger } from '../../abilities/types'
import { resolveMultihitType } from '../attackCanceller'
import type { BattleState, BattlerState, SimBattleMon, SimPartyMon } from '../state'
import { createBattlerState } from '../create'
import type { BridgeDeps, CalculationRoles } from '../bridge'
import { buildBattlerBattleState, buildFieldBattleState, gapsToUnmodelled } from '../bridge'
import { B_SIDE_OPPONENT } from '../constants'

export interface AiDamageDeps extends BridgeDeps {
  moveData(id: string): MoveData | undefined
  typeChart: TypeChart
  inverseTypeChart: TypeChart
  moveBehaviors: MoveBehaviors
  battleConstants: BattleConstants
}

export interface AiDamageResult {
  dmg: number
  unmodelled: string[]
}

/**
 * IsBattlerAIControlled, battle_ai_util.c:448-474. The full C switches on
 * `gSaveBlock2Ptr->playerAI` (a save-file toggle this tool never sets, so it
 * is always FALSE here) and on doubles-only flank positions
 * (B_POSITION_PLAYER_RIGHT/OPPONENT_RIGHT, unreachable -- doubles are out of
 * this batch's scope per the brief). Under those two fixed conditions the
 * switch collapses to exactly "is this battler on the opponent side".
 */
export function isBattlerAIControlled(battlerId: number): boolean {
  return (battlerId & 1) === B_SIDE_OPPONENT
}

/**
 * SaveBattlerData + SetBattlerData, battle_ai_util.c:504-543 (the
 * RestoreBattlerData half needs no port: this function returns a NEW mon
 * object rather than mutating shared state, so there is nothing to restore).
 * A no-op for an AI-controlled battler (`!IsBattlerAIControlled` guards both
 * C functions) -- returns the SAME mon reference in that case.
 *
 * The Illusion branch (:526-535) is not ported: ShouldFailForIllusion is a
 * hardcoded `return FALSE` in this very file (:518), so `illusionSpecies` can
 * never be nonzero and the type-masking branch it guards is dead code on this
 * checkout, not a gap.
 */
function maskBattlerMonForAi(state: BattleState, battlerId: number): SimBattleMon {
  const battler = state.battlers[battlerId]
  if (!battler) throw new Error(`aiCalcDamage: no battler at id ${battlerId}`)
  const mon = battler.mon
  if (isBattlerAIControlled(battlerId)) return mon

  const itemId = state.battleHistory.itemEffects[battlerId] === 0 ? null : mon.itemId
  const usedMoves = state.battleHistory.usedMoves[battlerId]
  const moves = mon.moves.map((moveId, slot) => (usedMoves?.[slot] ? moveId : null)) as SimBattleMon['moves']
  if (itemId === mon.itemId && moves.every((m, i) => m === mon.moves[i])) return mon
  return { ...mon, itemId, moves }
}

/** Applies `maskBattlerMonForAi` to both battlers passed in, returning a
 * shallow-cloned BattleState (only the named battler slots differ) so the
 * real state is never touched -- matching RestoreBattlerData's effect (the
 * original stays intact) without needing to actually restore anything. */
function withAiMasking(state: BattleState, battlerIds: number[]): BattleState {
  const battlers = state.battlers.slice()
  for (const id of battlerIds) {
    const battler = state.battlers[id]
    if (!battler) continue
    const mon = maskBattlerMonForAi(state, id)
    if (mon !== battler.mon) battlers[id] = { ...battler, mon }
  }
  return { ...state, battlers }
}

/**
 * GetParentalBondCount, src/battle_script_commands.c:1010-1044, for the
 * triggers reachable without a live party roster. MINION_CONTROL needs a
 * count of the attacker's non-fainted, non-egg, non-status party members --
 * gapped by name rather than guessed, same precedent as multiHit.ts's own
 * parentalBondHitCount. TWO_TO_FIVE (Unrelenting) has no case in the C's own
 * switch and falls through to `return 1`, matching multiHit.ts's comment that
 * this trigger never actually grants a bonus hit.
 */
function parentalBondCount(trigger: ParentalBondTrigger): number | { unmodelled: string } {
  switch (trigger) {
    case 'HYPER_AGGRESSIVE':
    case 'PRIMAL_MAW':
    case 'DUAL_WIELD':
    case 'ICE_COLD_HUNTER':
      return 2
    case 'THREE_HEADED':
      return 3
    case 'MINION_CONTROL':
      return { unmodelled: 'GetParentalBondCount MINION_CONTROL (battle_script_commands.c:1021-1040) needs a live party count; not modelled here (no team roster reachable from AI_CalcDamage)' }
    default:
      return 1
  }
}

interface AiScenarioBuild {
  move: MoveData
  scenario: DamageCalcScenario
  maskedState: BattleState
  unmodelled: string[]
}

/** Assembles the scenario AI_CalcDamage/AI_GetTypeEffectiveness both need:
 * SetBattlerData masking applied to BOTH battlerAtk and battlerDef
 * (battle_ai_util.c:655-659/861-865), then the same bridge the real player
 * damage path uses (buildBattlerBattleState/buildFieldBattleState). Returns
 * `null` only when the move id itself is unknown. */
function buildAiScenario(state: BattleState, moveId: string, attackerId: number, defenderId: number, deps: AiDamageDeps): AiScenarioBuild | null {
  const move = deps.moveData(moveId)
  if (!move) return null

  const maskedState = withAiMasking(state, [attackerId, defenderId])
  const roles: CalculationRoles = { attackerId, defenderId }
  const attackerBridge = buildBattlerBattleState(maskedState, attackerId, roles, deps)
  const defenderBridge = buildBattlerBattleState(maskedState, defenderId, roles, deps)
  const fieldBridge = buildFieldBattleState(maskedState, roles, deps)
  const unmodelled = [
    ...gapsToUnmodelled(attackerBridge.gaps).map((g) => `attacker.${g}`),
    ...gapsToUnmodelled(defenderBridge.gaps).map((g) => `defender.${g}`),
    ...gapsToUnmodelled(fieldBridge.gaps),
  ]

  if (move.effect === 'EFFECT_ROLLOUT') unmodelled.push('attackerRolloutCounter and attackerHasDefenseCurl are not tracked by the simulator')
  if (move.effect === 'EFFECT_BEAT_UP') unmodelled.push('beatUpBaseAttack and beatUpHitCount are not tracked by the simulator')
  if (move.effect === 'EFFECT_FOCUS_PUNCH' || move.id === 'MOVE_SELF_DESTRUCT') unmodelled.push('attackerWasHitThisTurn is not tracked by the simulator')
  if (move.effect === 'EFFECT_PURSUIT') unmodelled.push('defenderIsSwitching is false because switching is not modelled')
  if (move.effect === 'EFFECT_MAGNITUDE') {
    unmodelled.push('magnitudeTier is averaged across all magnitude tiers (calculateMoveDamage\'s own null-tier distribution) rather than drawn -- AI_CalcDamage has no real roll for this port to reuse')
  }
  if (deps.grounding.monotypeChampType) {
    unmodelled.push("Monotype Champion's post-formula damage multiplier (battle_util.c:7716-7756) is not applied by calculateMoveDamage")
  }

  const scenario: DamageCalcScenario = {
    move,
    attacker: attackerBridge.battler,
    defender: defenderBridge.battler,
    field: fieldBridge.field,
    typeChart: deps.typeChart,
    inverseTypeChart: deps.inverseTypeChart,
    moveBehaviors: deps.moveBehaviors,
    battleConstants: deps.battleConstants,
    // AI_CalcDamage has no notion of "who acts first" -- CalculateMoveDamage's
    // own signature carries no such parameter, and this call happens before
    // turn order is even decided (it IS part of deciding an action). `true`
    // (i.e. "no first-strike boost") matches the C having nothing to apply
    // here at all.
    attackerActsFirst: true,
    sameMoveTurnsInARow: maskedState.battlers[attackerId]?.sameMoveTurns ?? 0,
    hitCount: 0,
    defenderIsSwitching: false,
    magnitudeTier: null,
    attackerRolloutCounter: 0,
    attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: attackerBridge.battler.condition.wasDamagedThisTurnBy !== 'none',
    beatUpBaseAttack: attackerBridge.battler.rawStats.atk,
    beatUpHitCount: 1,
    defenderUsedGlaiveRush: false,
  }

  return { move, scenario, maskedState, unmodelled }
}

/**
 * AI_GetTypeEffectiveness, battle_ai_util.c:858-883 -- the SAME SetBattlerData
 * masking and SetTypeBeforeUsingMove/dynamic-type resolution as AI_CalcDamage
 * (both are handled by reusing calculateMoveDamage, which already resolves
 * dynamic move types and the full type-effectiveness fold internally), but
 * returning only the UQ_4_12 effectiveness multiplier -- callers compare it
 * against `UQ_4_12(2.0)` (2048) themselves, matching every call site in
 * GetMostSuitableMonToSwitchInto.
 */
export function aiGetTypeEffectiveness(state: BattleState, moveId: string, attackerId: number, defenderId: number, deps: AiDamageDeps): { effectiveness: number; unmodelled: string[] } {
  const built = buildAiScenario(state, moveId, attackerId, defenderId, deps)
  if (!built) return { effectiveness: 0, unmodelled: [`move ${moveId}: move data is unavailable`] }
  const result = calculateMoveDamage(built.scenario)
  return { effectiveness: result.typeEffectiveness, unmodelled: [...built.unmodelled, ...result.unmodelled] }
}

/**
 * AI_CalcDamage, battle_ai_util.c:650-765. Only the `dmg` output is exposed
 * (the `typeEffectiveness` out-parameter is not consumed by any of this
 * batch's callers -- see `aiGetTypeEffectiveness` for that separately).
 */
export function aiCalcDamage(state: BattleState, moveId: string, attackerId: number, defenderId: number, deps: AiDamageDeps): AiDamageResult {
  const built = buildAiScenario(state, moveId, attackerId, defenderId, deps)
  if (!built) return { dmg: 0, unmodelled: [`move ${moveId}: move data is unavailable`] }
  const { move, scenario, maskedState, unmodelled } = built

  // `if (gBattleMoves[move].power) { ... } else { dmg = 0; }` (:665-679).
  let dmg = 0
  if (move.power) {
    const result = calculateMoveDamage(scenario)
    unmodelled.push(...result.unmodelled)
    if (!result.isImmune) {
      // DoMoveDamageCalcInternal's `if (typeEffectivenessModifier == UQ_4_12(0)) return -1;`
      // then DoMoveDamageCalc's `if (dmg < 0) return 0;` -- an immune hit is a
      // clean 0 here, NOT the separate `if (dmg==0) dmg=1` floor (that floor
      // only fires inside the randomFactor branch, which AI_CalcDamage's own
      // calls -- randomFactor=FALSE both times -- never take).
      const normalDmg = result.rolls[15] // the C's randomFactor=FALSE call -- no roll spread, i.e. the max (100%) roll.
      const critDmg = result.critRolls ? result.critRolls[15] : normalDmg
      const critChance = result.critChanceDenominator // null === GetInverseCritChance's -1 sentinel (this move/battler can never crit)
      dmg = critChance === null ? normalDmg : idiv(critDmg + normalDmg * (critChance - 1), critChance)
    }
  }

  // MultihitType multihitType = GetMultihitType(battlerAtk, move); if
  // (!multihitType) multihitType = GetParentalBondType(...); (:681-682).
  const attackerBattler = maskedState.battlers[attackerId] as BattlerState
  const defenderBattler = maskedState.battlers[defenderId] as BattlerState
  const attackerHoldEffect = scenario.attacker.condition.resolvedHoldEffect
  const multihitType = resolveMultihitType(attackerBattler, moveId, deps.dataContext.move(moveId), attackerHoldEffect, unmodelled)
  let parentalBondTrigger: ParentalBondTrigger | null = null
  if (!multihitType) {
    parentalBondTrigger = computeParentalBondTrigger(scenario.attacker.abilitySlots, scenario.defender.abilitySlots, {
      moveType: scenario.move.type ?? 'NORMAL',
      moveFlags: move.flags,
      weather: scenario.field.weather,
      attackerHeads: scenario.attacker.condition.heads,
    })
  }
  const isMultiHit = multihitType !== null || parentalBondTrigger !== null

  // EFFECT_SUPER_FANG / EFFECT_SUPER_FANG_HAZE (:684-686) vs every other
  // effect (:687-748) -- mutually exclusive branches in the C, ported the
  // same way.
  if (move.effect === 'EFFECT_SUPER_FANG' || move.effect === 'EFFECT_SUPER_FANG_HAZE') {
    dmg = isMultiHit ? Math.max(2, Math.floor((defenderBattler.mon.hp * 5) / 8)) : Math.max(1, Math.floor(defenderBattler.mon.hp / 2))
  } else {
    switch (move.effect) {
      case 'EFFECT_LEVEL_DAMAGE':
      case 'EFFECT_PSYWAVE':
        dmg = attackerBattler.mon.level
        break
      case 'EFFECT_DRAGON_RAGE':
        dmg = 40
        break
      case 'EFFECT_ENDEAVOR':
        dmg = Math.max(0, defenderBattler.mon.hp - attackerBattler.mon.hp)
        break
      case 'EFFECT_FINAL_GAMBIT':
        dmg = attackerBattler.mon.hp
        break
    }

    // The multi-hit multiplier switch, :705-747.
    switch (multihitType) {
      case 'TRIPLE_KICK':
      case 'FOUR_OR_FIVE':
      case 'FIVE':
      case 'BEAT_UP':
        dmg *= 5
        break
      case 'THREE':
        dmg *= move.effect === 'EFFECT_TRIPLE_KICK' ? 6 : 3
        break
      case 'TEN':
        dmg *= 10
        break
      case 'TEN_CAN_MISS':
        dmg *= 6
        break
      case 'TWO_TO_FIVE':
        dmg *= 3
        break
      case 'TWO':
        dmg *= 2
        break
      default: {
        // Must be Parental Bond (multihitType was MULTIHIT_SINGLE and
        // GetParentalBondType supplied a real trigger).
        if (parentalBondTrigger) {
          const count = parentalBondCount(parentalBondTrigger)
          if (typeof count === 'number') {
            let multiplier = 0
            for (let i = 0; i < count; i++) multiplier += getParentalBondMultiplier(parentalBondTrigger, i)
            dmg = applyModifier(multiplier, dmg)
          } else {
            unmodelled.push(count.unmodelled)
          }
        }
      }
    }
  }

  // Handle other multi-strike moves, :750-754. FLAG_TWO_STRIKES has no
  // moves.json/SimMoveData field at all (grep-verified against the pipeline's
  // emitted flag set) -- gapped as a standing limitation rather than per-call,
  // since there is no data to test the real condition against.
  if (moveId === 'MOVE_WATER_SHURIKEN' && attackerBattler.mon.speciesId === 'SPECIES_GRENINJA_ASH') {
    dmg *= 3
  }

  return { dmg, unmodelled }
}

/**
 * AI_CalcPartyMonDamage, battle_ai_util.c:2429-2440 -- the same estimate with
 * a RESERVE party mon standing in as the attacker (PokemonToBattleMon).
 *
 * Only `gBattleMons[battlerAtk]` (the mon struct) is substituted in the C;
 * `gStatuses3/4`, `gVolatileStructs`, `gRoundStructs` and `gTurnStructs` for
 * that battler slot are untouched globals that keep whatever the PREVIOUS
 * (fainted) occupant left behind. This sim's turn loop never writes any of
 * those for a live battler either (bridge.ts's own BATCH1_GAPS list), so a
 * freshly neutral `createBattlerState` is observably identical to "whatever
 * was already there" -- except `sameMoveTurns`, which turn.ts's deductPp DOES
 * maintain for a live battler, so that one field is carried over explicitly
 * rather than reset.
 *
 * `SimPartyMon` fields used to build the substitute: speciesId, rawStats,
 * moves, pp, hp, maxHp, itemId, types, level, nature, hiddenPowerType,
 * speedDown, abilities, gender, status1 (persists across switches, matching
 * SimPartyMon's own doc). `status2` has no party-mon counterpart (cleared on
 * switch out) and is set to 0, matching a freshly-sent-out mon.
 */
export function aiCalcPartyMonDamage(state: BattleState, moveId: string, attackerId: number, defenderId: number, partyMon: SimPartyMon, deps: AiDamageDeps): AiDamageResult {
  const existing = state.battlers[attackerId]
  const substitute: SimBattleMon = {
    speciesId: partyMon.speciesId as string, // validated non-null by the caller
    rawStats: partyMon.rawStats,
    moves: partyMon.moves,
    pp: partyMon.pp,
    hp: partyMon.hp,
    maxHp: partyMon.maxHp,
    itemId: partyMon.itemId,
    statStages: [], // overwritten with the neutral set by createBattlerState
    types: partyMon.types,
    level: partyMon.level,
    nature: partyMon.nature,
    hiddenPowerType: partyMon.hiddenPowerType,
    speedDown: partyMon.speedDown,
    abilities: partyMon.abilities,
    gender: partyMon.gender,
    status1: partyMon.status1,
    status2: 0,
  }
  const scratchBattler = {
    ...createBattlerState(attackerId, substitute, existing?.partyIndex ?? 0),
    sameMoveTurns: existing?.sameMoveTurns ?? 0,
  }
  const battlers = state.battlers.slice()
  battlers[attackerId] = scratchBattler
  const substitutedState: BattleState = { ...state, battlers }

  return aiCalcDamage(substitutedState, moveId, attackerId, defenderId, deps)
}
