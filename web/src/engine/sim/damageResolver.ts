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

const variableEffects = new Set(['EFFECT_MULTI_HIT'])
const neutralToggleNotes: Record<string, string> = {
  EFFECT_ECHOED_VOICE: 'sameMoveTurnsInARow is not tracked by the simulator',
  EFFECT_ROLLOUT: 'attackerRolloutCounter and attackerHasDefenseCurl are not tracked by the simulator',
  EFFECT_BEAT_UP: 'beatUpBaseAttack and beatUpHitCount are not tracked by the simulator',
  EFFECT_FOCUS_PUNCH: 'attackerWasHitThisTurn is not tracked by the simulator',
  EFFECT_SELF_DESTRUCT: 'attackerWasHitThisTurn is not tracked by the simulator',
  EFFECT_PURSUIT: 'defenderIsSwitching is false because switching is not modelled',
}

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
      const toggleNote = neutralToggleNotes[move.effect ?? '']
      if (toggleNote) unmodelled.push(toggleNote)
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
        sameMoveTurnsInARow: 0,
        hitCount: variableEffects.has(move.effect ?? '') ? variableHitCount(deps.random) : 3,
        defenderIsSwitching: false,
        magnitudeTier: move.effect === 'EFFECT_MAGNITUDE' ? magnitudeTier(deps.random) : null,
        attackerRolloutCounter: 0,
        attackerHasDefenseCurl: false,
        attackerWasHitThisTurn: attacker.battler.condition.wasDamagedThisTurnBy !== 'none',
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
      if (move.effect === 'EFFECT_RECOIL' || move.effect === 'EFFECT_ABSORB' || attacker.battler.condition.resolvedHoldEffect === 'HOLD_EFFECT_LIFE_ORB') {
        unmodelled.push('recoil, drain, and Life Orb attacker damage are not modelled yet')
      }
      return { targetDamage: values[15 - roll], attackerDamage: null, unmodelled }
    },
  }
}
