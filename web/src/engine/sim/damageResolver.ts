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
//
// FIX CYCLE 6: this resolver no longer draws its own hit count. Before this
// fix it drew 1-2 `deps.random` calls for EVERY move (including single-hit
// ones), which is not where the C draws them at all -- CANCELLER_MULTIHIT_MOVES
// (battle_util.c:3491-3541, ported in attackCanceller.ts) is the real site,
// and it runs BEFORE the accuracy check, not inside damage calc. `scenario.hitCount`
// below now reads attackCanceller.ts's own multiHitCounter, already drawn and
// written onto BattlerState.turn by the time this resolver runs -- see
// DamageCalcScenario.hitCount's own doc (calculate.ts) for the field's wider
// contract as a UI-style "scenario toggle" (this resolver is the ONE caller
// that fills it from a real draw rather than a calculator-page selection).
//
// Unrelenting (MULTIHIT_TWO_TO_FIVE) never actually grants a bonus hit in the
// real game -- GetParentalBondCount (battle_script_commands.c:1010-1044) has no
// case for it, so it falls through to `return 1` and Cmd_attackcanceler's
// `i > 1` gate (:1082-1090) never sets multiHitCounter/parentalBondOn. There is
// no Random() draw for it anywhere, so there is no hidden draw for this
// resolver to port; multiHit.ts's parentalBondHitCount returns hitCount 1 for
// this trigger, matching the C's fall-through.
import type { MoveData, DamageCalcScenario } from '../calculate'
import { calculateMoveDamage } from '../calculate'
import type { BattleConstants } from '../types'
import type { MoveBehaviors } from '../basePower'
import type { TypeChart } from '../typeEffectiveness'
import type { BattleState, RandomSource } from './state'
import type { BridgeDeps } from './bridge'
import { buildBattlerBattleState, buildFieldBattleState, gapsToUnmodelled } from './bridge'
import { STATUS2_DEFENSE_CURL, STATUS4_ELECTRIFIED, STATUS4_PLASMA_FISTS, STATUS_FIELD_ION_DELUGE, hasFlag } from './constants'
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

export function createBridgeDamageResolver(deps: BridgeDamageResolverDeps): DamageResolver {
  return {
    resolve(state: BattleState, attackerId: number, targetId: number, action: ChosenAction, context: DamageResolveContext = { targetHasActedThisTurn: false }): DamageResolution {
      if (action.action !== 'USE_MOVE' || !action.chosenMove) return { targetDamage: null, attackerDamage: null, unmodelled: [] }
      const declaredMove = deps.moveData(action.chosenMove.id)
      // Cmd_damagecalc (battle_script_commands.c:1598-1611) passes gQueuedExtraAttackData[0].movePower as CalculateMoveDamage's
      // fixedBasePower, and CalcMoveBasePowerAfterModifiers takes `fixedPower ? fixedPower : basePower` (battle_util.c:6969).
      // Every move queued with a power today (Ice Downfall's Icicle Crash 60, Snap Trap 50) is a plain-power effect, so
      // overriding the declared power is equivalent to replacing CalcMoveBasePower's result.
      const extra = state.processingExtraAttacks ? state.currentExtraAttack : null
      const move =
        declaredMove && extra?.movePower && extra.attacker === attackerId && extra.move === declaredMove.id
          ? { ...declaredMove, power: extra.movePower }
          : declaredMove
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
      // Rollout / Ice Ball / Flame Wheel read gVolatileStructs[atk].rolloutCounter AFTER Cmd_handlerollout bumped it (turn.ts runs that
      // before this call, as BattleScript_EffectRollout does, data/battle_scripts_1.s:5125-5132) and STATUS2_DEFENSE_CURL (:6813-6821).
      const attackerBattlerState = state.battlers[attackerId]!
      // tryfling (hitScripts.ts) emptied the slot already; Fling's power and a Gem's type read the item it recorded.
      const flungId = move.effect === 'EFFECT_FLING' ? attackerBattlerState.turn.flungItem : null
      const flungData = flungId ? deps.dataContext.item(flungId) : undefined
      // Beat Up's hit k is powered by party slot k (CalcBeatUpPower, battle_util.c:101-116: `party[gBattleCommunication[0] - 1]`,
      // which BattleScript_EffectBeatUp's Gen 5+ branch raises by one per hit, data/battle_scripts_1.s:5775-5779), whether or not
      // that slot is a mon that counted toward the hit total. An empty slot reads gBaseStats[SPECIES_NONE].baseAttack, which is 0.
      let beatUpBaseAttack = attacker.battler.rawStats.atk
      if (move.effect === 'EFFECT_BEAT_UP') {
        if (context.hitIndex === undefined) {
          unmodelled.push('beatUpBaseAttack and beatUpHitCount are not tracked by the simulator')
        } else {
          const slotSpecies = state.sides[attackerId & 1].party[context.hitIndex]?.speciesId ?? null
          beatUpBaseAttack = slotSpecies ? (deps.dataContext.species(slotSpecies)?.baseStats.atk ?? 0) : 0
        }
      }
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
        // CANCELLER_MULTIHIT_MOVES (attackCanceller.ts) already drew this and
        // wrote it onto TurnState before the accuracy check ran -- see this
        // module's own header. 0 when unset: resolveHitPlan (multiHit.ts)
        // does not read scenarioHitCount at all for an ordinary single-hit
        // move with no Parental Bond ability, so the placeholder is inert for
        // every move this batch's own defects actually touch (see header for
        // the one pre-existing exception this value cannot fix).
        hitCount: state.battlers[attackerId]!.turn.multiHitCounter,
        defenderIsSwitching: false,
        magnitudeTier: move.effect === 'EFFECT_MAGNITUDE' ? magnitudeTier(deps.random) : null,
        attackerRolloutCounter: Math.min(3, Math.max(0, attackerBattlerState.volatiles.rolloutCounter)) as 0 | 1 | 2 | 3,
        attackerHasDefenseCurl: hasFlag(attackerBattlerState.mon.status2, STATUS2_DEFENSE_CURL),
        attackerWasHitThisTurn: attacker.battler.condition.wasDamagedThisTurnBy !== 'none',
        // Without a hitIndex DamageContext's one-representative stand-in applies (the attacker's own Attack, with the gap
        // reported above); with one, the hit's own party slot (beatUpBaseAttack above).
        beatUpBaseAttack,
        beatUpHitCount: 1,
        defenderUsedGlaiveRush: false,
        singleHitIndex: context.hitIndex,
        // MISC_EFFECT_TOOK_DAMAGE_BOOST (battle_util.c:6869-6871) and MISC_EFFECT_DOUBLE_DAMAGE (:6872-6874): the latter's
        // Random() is drawn inside CalcMoveBasePower, i.e. before the damage roll below.
        // GetMoveTypeInternal's Normal-to-Electric overrides (battle_main.c:5196-5197)
        attackerElectrified: hasFlag(attackerBattlerState.statuses4, STATUS4_ELECTRIFIED),
        ionDelugeActive: hasFlag(state.field.statuses, STATUS_FIELD_ION_DELUGE),
        attackerPlasmaFists: hasFlag(attackerBattlerState.statuses4, STATUS4_PLASMA_FISTS),
        attackerTimesDamaged: state.sides[attackerId & 1]?.timesDamaged[attackerBattlerState.partyIndex] ?? 0,
        miscDoubleDamage: move.miscEffect === 'MISC_EFFECT_DOUBLE_DAMAGE' ? deps.random.random16() % 100 < move.effectChance : undefined,
        flungItem: flungId
          ? { id: flungId, holdEffect: flungData?.resolvedHoldEffect ?? null, holdEffectType: flungData?.holdEffectType?.replace(/^TYPE_/, '') ?? null }
          : null,
      }
      const result = calculateMoveDamage(scenario)
      unmodelled.push(...result.unmodelled)
      if (result.isImmune) return { targetDamage: 0, attackerDamage: null, unmodelled, absorbingAbility: result.absorbingAbility ?? null }

      // Cmd_critcalc runs before Cmd_damagecalc (battle_script_commands.c:1568-1585). A later hit of a multi-hit move arrives
      // with the turn loop's own gCritRoll (MakeCritRoll(), :1586, drawn at MOVEEND_MULTIHIT_MOVE :4885); SetCritFlag
      // (:1588-1594) tests `!(critRoll % critChance)`, and the loop's roll is Random() % 24, so the divisors 24/8/2/1 of
      // sCriticalHitChance (:1510) all divide it exactly.
      const denominator = result.critChanceDenominator
      const crit =
        denominator === 1 ||
        (denominator !== null && (context.critRoll !== undefined ? context.critRoll : deps.random.random16()) % denominator === 0)
      // battle_util.c:7790-7795 uses r = Random()%16 and indexes the ascending
      // 85..100% result arrays as 15-r; Bad Luck forces r=15.
      const roll = result.isForcedMinRoll ? 15 : deps.random.random16() % 16
      const values = result.hitCount === null
        ? (crit ? result.critRolls : result.rolls)
        : (crit ? result.totalCritRolls : result.totalRolls)
      if (!values) return { targetDamage: null, attackerDamage: null, unmodelled, absorbingAbility: null }
      if (result.hitCount !== null) unmodelled.push('multi-hit per-hit rolls and crits are not independently drawn')
      return {
        targetDamage: values[15 - roll],
        attackerDamage: null,
        unmodelled,
        absorbingAbility: null,
        isCriticalHit: crit,
        berryReduced: Boolean(result.berryReduced),
        isSuperEffective: result.typeEffectiveness >= 8192,
      }
    },

    confusionSelfHit(state: BattleState, battlerId: number, power: number) {
      // MOVE_NONE is a physical NORMAL move with power 0 (moves.json); the C overrides the power and passes TYPE_MYSTERY
      // as the move type, so there is no STAB and no type effectiveness.
      const moveNone = deps.moveData('MOVE_NONE')
      if (!moveNone) return { damage: null, unmodelled: ['confusion self-hit: MOVE_NONE data is unavailable'] }
      const roles = { attackerId: battlerId, defenderId: battlerId }
      const self = buildBattlerBattleState(state, battlerId, roles, deps)
      const field = buildFieldBattleState(state, roles, deps)
      const unmodelled = [...gapsToUnmodelled(self.gaps).map((gap) => `attacker.${gap}`), ...gapsToUnmodelled(field.gaps)]
      const result = calculateMoveDamage({
        move: { ...moveNone, power, type: 'MYSTERY' },
        attacker: self.battler,
        defender: self.battler,
        field: field.field,
        typeChart: deps.typeChart,
        inverseTypeChart: deps.inverseTypeChart,
        moveBehaviors: deps.moveBehaviors,
        battleConstants: deps.battleConstants,
        attackerActsFirst: false,
        sameMoveTurnsInARow: 0,
        hitCount: 0,
        defenderIsSwitching: false,
        magnitudeTier: null,
        attackerRolloutCounter: 0,
        attackerHasDefenseCurl: false,
        attackerWasHitThisTurn: false,
        beatUpBaseAttack: self.battler.rawStats.atk,
        beatUpHitCount: 1,
        defenderUsedGlaiveRush: false,
      })
      unmodelled.push(...result.unmodelled)
      // randomFactor is 0 in the C call, so the roll is the full-damage entry (index 15 of the ascending 85-100% array).
      return { damage: result.isImmune ? 0 : (result.rolls?.[15] ?? null), unmodelled }
    },
  }
}
