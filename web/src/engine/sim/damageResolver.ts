// DamageResolver bridge: assembles the simulator's role-relative state for the
// existing calculateMoveDamage port, then applies the game's final crit and
// random-roll draws. The C order is crit first, then the damage percentile.
// Immune is 0 because the move happened but dealt no HP damage; a missing move
// is null because no move happened. Multi-hit totals deliberately share one
// percentile and one crit decision because calculate.ts documents that
// simplification rather than drawing each hit independently.
//
// Deliberately absent here: accuracy, move effects/status, recoil/drain,
// switching, residuals, and the simulator's untracked turn-history toggles.
// Those remain in unmodelled[] so this seam never presents an incomplete
// number as complete.
import type { MoveData, DamageCalcScenario } from '../calculate'
import { calculateMoveDamage } from '../calculate'
import type { BattleConstants } from '../types'
import type { MoveBehaviors } from '../basePower'
import type { TypeChart } from '../typeEffectiveness'
import type { BattleState, RandomSource } from './state'
import type { BridgeDeps } from './bridge'
import { buildBattlerBattleState, buildFieldBattleState, gapsToUnmodelled } from './bridge'
import type { DamageResolution, DamageResolveContext, DamageResolver } from './turn'
import type { ChosenAction } from './turnOrder'

export interface BridgeDamageResolverDeps extends BridgeDeps {
  moveData(id: string): MoveData | undefined
  typeChart: TypeChart
  inverseTypeChart: TypeChart
  moveBehaviors: MoveBehaviors
  battleConstants: BattleConstants
  random: RandomSource
}

const recoilEffects = new Set(['EFFECT_RECOIL_25', 'EFFECT_RECOIL_33', 'EFFECT_RECOIL_50', 'EFFECT_RECOIL_HP_25', 'EFFECT_FLINCH_RECOIL_33'])

function magnitudeTier(random: RandomSource): 4 | 5 | 6 | 7 | 8 | 9 | 10 {
  const roll = random.random16() % 100
  if (roll < 5) return 4
  if (roll < 15) return 5
  if (roll < 35) return 6
  if (roll < 65) return 7
  if (roll < 85) return 8
  if (roll < 95) return 9
  return 10
}

function variableHitCount(random: RandomSource): number {
  return 2 + (random.random16() % 2) + ((random.random16() % 3 === 0) ? 2 : 0)
}

export function createBridgeDamageResolver(deps: BridgeDamageResolverDeps): DamageResolver {
  return {
    resolve(state: BattleState, attackerId: number, targetId: number, action: ChosenAction, context: DamageResolveContext = { targetHasActedThisTurn: false }): DamageResolution {
      if (action.action !== 'USE_MOVE' || !action.chosenMove) return { targetDamage: null, attackerDamage: null, unmodelled: [] }
      const move = deps.moveData(action.chosenMove.id)
      if (!move) return { targetDamage: null, attackerDamage: null, unmodelled: [`move ${action.chosenMove.id}: move data is unavailable`] }
      if (move.split === 'STATUS') return { targetDamage: null, attackerDamage: null, unmodelled: ['status effects are not modelled yet'] }

      const roles = { attackerId, defenderId: targetId }
      const attacker = buildBattlerBattleState(state, attackerId, roles, deps)
      const defender = buildBattlerBattleState(state, targetId, roles, deps)
      const field = buildFieldBattleState(state, roles, deps)
      const unmodelled = [
        ...gapsToUnmodelled(attacker.gaps).map((gap) => `attacker.${gap}`),
        ...gapsToUnmodelled(defender.gaps).map((gap) => `defender.${gap}`),
        ...gapsToUnmodelled(field.gaps),
      ]
      // attackerFinalItemMultiplier (calculate.ts:1219-1222) is the ONLY real
      // consumer of sameMoveTurnsInARow -- HOLD_EFFECT_METRONOME's per-move-in-
      // a-row damage boost, for ANY move the attacker uses. It is not keyed on
      // Echoed Voice: this dataset's MOVE_ECHOED_VOICE has effect
      // EFFECT_TRIPLE_KICK (not EFFECT_ECHOED_VOICE, which appears nowhere in
      // moves.json), so basePower.ts's EFFECT_ECHOED_VOICE case is unreachable
      // and Echoed Voice's own power scaling is Triple-Kick-shaped, not tied to
      // this toggle at all.
      //
      // No longer a gap: turn.ts's deductPp now maintains
      // BattlerState.sameMoveTurns for real (Cmd_ppreduce,
      // battle_script_commands.c:1486-1493). It is always 0 in this batch --
      // the C's own increment branch needs gTurnStructs.parentalBondOn > 0,
      // which nothing in this codebase's turn loop writes (multi-hit/Parental
      // Bond sequencing is not modelled) -- which is the CORRECT value for
      // every scenario this batch can represent, not a guess: see
      // state.ts's sameMoveTurns doc.
      if (move.effect === 'EFFECT_ROLLOUT') unmodelled.push('attackerRolloutCounter and attackerHasDefenseCurl are not tracked by the simulator')
      if (move.effect === 'EFFECT_BEAT_UP') unmodelled.push('beatUpBaseAttack and beatUpHitCount are not tracked by the simulator')
      if (move.effect === 'EFFECT_FOCUS_PUNCH' || move.id === 'MOVE_SELF_DESTRUCT') unmodelled.push('attackerWasHitThisTurn is not tracked by the simulator')
      if (move.effect === 'EFFECT_PURSUIT') unmodelled.push('defenderIsSwitching is false because switching is not modelled')
      const scenario: DamageCalcScenario = {
        move,
        attacker: attacker.battler,
        defender: defender.battler,
        field: field.field,
        typeChart: deps.typeChart,
        inverseTypeChart: deps.inverseTypeChart,
        moveBehaviors: deps.moveBehaviors,
        battleConstants: deps.battleConstants,
        attackerActsFirst: !context.targetHasActedThisTurn,
        sameMoveTurnsInARow: state.battlers[attackerId]!.sameMoveTurns,
        // This scenario is also consumed by Parental-Bond TWO_TO_FIVE, not
        // only EFFECT_MULTI_HIT. Loaded Dice uses the game's 4-or-5 draw.
        hitCount: attacker.battler.condition.resolvedHoldEffect === 'HOLD_EFFECT_LOADED_DICE'
          ? 4 + (deps.random.random16() % 2)
          : variableHitCount(deps.random),
        defenderIsSwitching: false,
        magnitudeTier: move.effect === 'EFFECT_MAGNITUDE' ? magnitudeTier(deps.random) : null,
        attackerRolloutCounter: 0,
        attackerHasDefenseCurl: false,
        attackerWasHitThisTurn: attacker.battler.condition.wasDamagedThisTurnBy !== 'none',
        // DamageContext documents this as a representative party member's
        // base Attack; no party roster exists, so keep the attacker as the
        // explicit representative and report the gap for Beat Up.
        beatUpBaseAttack: attacker.battler.rawStats.atk,
        beatUpHitCount: 1,
        defenderUsedGlaiveRush: false,
      }
      const result = calculateMoveDamage(scenario)
      unmodelled.push(...result.unmodelled)
      if (result.isImmune) return { targetDamage: 0, attackerDamage: null, unmodelled }

      // Cmd_critcalc runs before Cmd_damagecalc (battle_script_commands.c:1568-1585).
      const denominator = result.critChanceDenominator
      const crit = denominator === 1 || (denominator !== null && deps.random.random16() % denominator === 0)
      // battle_util.c:7790-7795 uses r = Random()%16 and indexes the ascending
      // 85..100% result arrays as 15-r; Bad Luck forces r=15.
      const roll = result.isForcedMinRoll ? 15 : deps.random.random16() % 16
      const values = result.hitCount === null
        ? (crit ? result.critRolls : result.rolls)
        : (crit ? result.totalCritRolls : result.totalRolls)
      if (!values) return { targetDamage: null, attackerDamage: null, unmodelled }
      if (result.hitCount !== null) unmodelled.push('multi-hit per-hit rolls and crits are not independently drawn')
      if (recoilEffects.has(move.effect ?? '') || move.effect === 'EFFECT_ABSORB' || attacker.battler.condition.resolvedHoldEffect === 'HOLD_EFFECT_LIFE_ORB') {
        unmodelled.push('recoil, drain, and Life Orb attacker damage are not modelled yet')
      }
      return { targetDamage: values[15 - roll], attackerDamage: null, unmodelled }
    },
  }
}
