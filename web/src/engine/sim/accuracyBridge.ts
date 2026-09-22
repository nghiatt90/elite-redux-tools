// Bridge, batch 4 (accuracy): sim state -> accuracy.ts's AccuracyInputs.
//
// Same discipline as bridge.ts (batch 1): a field this sim genuinely
// maintains is derived for real; a field that exists in the state shape but
// that nothing in the sim ever WRITES is a GAP, not a value -- see bridge.ts's
// header for the full argument ("presence in the type is not evidence of
// being populated"). Every gVolatileStructs/gStatuses3/gStatuses4/gRoundStructs
// read below is gapped for exactly the reason bridge.ts's BATCH1_GAPS already
// gapped the same four arrays: nothing in the turn loop writes them, so
// reading them is only ever honestly "zero at battle start", not "the current
// value".
//
// What IS real here, and why it escapes that rule:
//   - move data (accuracy, effect, type, flags) -- a data lookup, not battle
//     state.
//   - attacker/defender types and ability slots -- SimBattleMon fields the
//     sim actually carries and never mutates mid-battle in a way that matters
//     here (types can change via move effects, which are not modelled yet,
//     so "the mon's current types" is honestly "its types").
//   - hold effects -- itemId is real state; the resolved effect is a data
//     lookup off it, same precedent as bridge.ts's condition.resolvedHoldEffect.
//   - defenderIsGrounded -- grounding.ts's REAL port, same call turn.ts's own
//     buildTurnOrderContext already makes.
//   - weather / gravityActive -- bridge.ts's buildFieldFacts, a real (if
//     stale-after-battle-start) derivation, same precedent as the damage path.
//   - attackerActsAfterDefender -- turn order has already decided this by the
//     time the loop reaches this battler's slot; GetBattlerTurnOrderNum(atk) >
//     GetBattlerTurnOrderNum(def) is exactly "has the defender's slot already
//     been reached", which is what the caller supplies as
//     `context.targetHasActedThisTurn` (turn.ts's DamageResolveContext) --
//     the SAME fact, not a new one, so this module takes it as an argument
//     rather than re-deriving it.

import type { BridgeDeps, BridgeGap } from './bridge'
import { weatherFromBitfield } from './bridge'
import type { AccuracyInputs } from './accuracy'
import type { BattleState } from './state'
import { isBattlerGrounded, isGravityActive } from './grounding'
import {
  DEFAULT_STAT_STAGE,
  STAT_ACC,
  STAT_EVASION,
  STATUS3_ALWAYS_HITS,
  STATUS3_TELEKINESIS,
  STATUS4_FORESIGHT,
  hasFlag,
} from './constants'
import { isPhantomForce, semiInvulnerableState } from './unpack'

const bareType = (type: string | null): string => (type ?? '').replace(/^TYPE_/, '')

/** Every AccuracyInputs field this bridge cannot honestly derive, because
 * nothing in the turn loop writes the C array it comes from. Declared once,
 * pushed on every call -- same shape as bridge.ts's BATCH1_GAPS, split out
 * per battler role below since attacker/defender fields need different
 * `field` names. */
function structuralGaps(): BridgeGap[] {
  return [
    { field: 'attackerTrepidationNonzero', reason: 'NEVER_UPDATED', detail: 'volatiles.trepidation; no sim code writes volatiles' },
    { field: 'attackerUsedMicleBerry', reason: 'NEVER_UPDATED', detail: 'round.usedMicleBerry; no sim code writes RoundState, so it can never read true' },
    { field: 'attackerAccStage', reason: 'NEVER_UPDATED', detail: 'statStages[STAT_ACC]; createBattlerState forces neutral and no sim code applies a stat change' },
    { field: 'defenderEvasionStage', reason: 'NEVER_UPDATED', detail: 'statStages[STAT_EVASION]; createBattlerState forces neutral and no sim code applies a stat change' },
    { field: 'defenderHasForesight', reason: 'NEVER_UPDATED', detail: 'statuses4 STATUS4_FORESIGHT; no sim code writes statuses4' },
    { field: 'defenderHasAlwaysHits', reason: 'NEVER_UPDATED', detail: 'statuses3 STATUS3_ALWAYS_HITS; no sim code writes statuses3' },
    { field: 'battlerWithSureHitIsAttacker', reason: 'NEVER_UPDATED', detail: 'volatiles.battlerWithSureHit; no sim code writes volatiles' },
    { field: 'defenderHasTelekinesis', reason: 'NEVER_UPDATED', detail: 'statuses3 STATUS3_TELEKINESIS; no sim code writes statuses3' },
    { field: 'defenderHasPhantomForce', reason: 'NEVER_UPDATED', detail: 'statuses3 semi-invulnerability; no sim code writes statuses3' },
    { field: 'defenderIsOnAir', reason: 'NEVER_UPDATED', detail: 'statuses3 semi-invulnerability; no sim code writes statuses3' },
    { field: 'defenderIsUnderground', reason: 'NEVER_UPDATED', detail: 'statuses3 semi-invulnerability; no sim code writes statuses3' },
    { field: 'defenderIsUnderwater', reason: 'NEVER_UPDATED', detail: 'statuses3 semi-invulnerability; no sim code writes statuses3' },
    {
      field: 'defenderSmokescreenActive',
      reason: 'NEVER_UPDATED',
      detail: 'side.timers.smokescreenTimer; unlike reflect/lightScreen/luckyChant, encounters.json has no battle-start source for Smokescreen at all, so this can never read true',
    },
    { field: 'myceliumMightActive', reason: 'NO_SOURCE', detail: 'gHitMarker HITMARKER_MYCELIUM_MIGHT is a per-turn engine flag with no sim-state counterpart' },
  ]
}

export interface AccuracyBridgeDeps extends Pick<BridgeDeps, 'grounding' | 'dataContext'> {}

export interface AccuracyBridgeResult {
  inputs: AccuracyInputs
  gaps: BridgeGap[]
  /** Whether the defender's ability slots name ABILITY_ANTICIPATION -- surfaced
   * separately so the caller can gap Cmd_accuracycheck's OWN Anticipation
   * miss branch (:1427-1432, NOT part of GetTotalAccuracy) by name only when
   * it could actually have mattered, the same "gap only when it could have
   * mattered" precedent as accuracy.ts's own Micle Berry/Ripen gap. */
  defenderHasAnticipation: boolean
}

/**
 * Assembles GetTotalAccuracy's inputs (accuracy.ts) from sim state for one
 * attacker/target/move. `attackerActsAfterDefender` is the caller's own
 * `context.targetHasActedThisTurn` -- see this module's header for why that
 * is the same fact, not a new one.
 */
export function buildAccuracyInputs(
  state: BattleState,
  attackerId: number,
  targetId: number,
  moveId: string,
  attackerActsAfterDefender: boolean,
  deps: AccuracyBridgeDeps,
): AccuracyBridgeResult {
  const attacker = state.battlers[attackerId]
  const defender = state.battlers[targetId]
  if (!attacker || !defender) throw new Error(`buildAccuracyInputs: no battler at ${attackerId}/${targetId}`)

  const gaps: BridgeGap[] = [...structuralGaps()]

  const move = deps.dataContext.move(moveId)
  if (!move) {
    gaps.push({ field: 'moveAccuracy', reason: 'NEEDS_DATA', detail: `moves.json lookup missed ${moveId}` })
  }

  const attackerItem = attacker.mon.itemId === null ? null : deps.dataContext.item(attacker.mon.itemId)
  if (attacker.mon.itemId !== null && !attackerItem) {
    gaps.push({ field: 'attackerHoldEffect', reason: 'NEEDS_DATA', detail: `items.json lookup missed ${attacker.mon.itemId}` })
  }
  const defenderItem = defender.mon.itemId === null ? null : deps.dataContext.item(defender.mon.itemId)
  if (defender.mon.itemId !== null && !defenderItem) {
    gaps.push({ field: 'defenderHoldEffect', reason: 'NEEDS_DATA', detail: `items.json lookup missed ${defender.mon.itemId}` })
  }

  // Inlined rather than bridge.ts's buildFieldFacts: that helper's own
  // signature wants a full BridgeDeps (turnOrder, statStageRatios,
  // inverseBattle) it does not actually read -- only `deps.grounding` feeds
  // gravityActive, and weatherFromBitfield needs no deps at all. Same two
  // real derivations (weather can go stale after battle start; gravity is a
  // genuine port), just without carrying fields this module has no use for.
  const { weather, gap: weatherGap } = weatherFromBitfield(state.field.weather)
  const gravityActive = isGravityActive(state, deps.grounding)
  if (weatherGap) gaps.push(weatherGap)

  const defenderHasAnticipation = defender.mon.abilities.ability === 'ABILITY_ANTICIPATION' || defender.mon.abilities.innates.includes('ABILITY_ANTICIPATION')

  const inputs: AccuracyInputs = {
    moveId,
    moveAccuracy: move?.accuracy ?? 0,
    moveEffect: move?.effect ?? null,
    moveType: bareType(move?.type ?? null),
    moveFlagStatStagesIgnored: Boolean(move?.flags.ignoresStatStages),
    moveFlagDmgInAir: move?.hitsAir === 'HITS',
    moveFlagDmgTwoXInAir: move?.hitsAir === 'DOUBLE_DAMAGE',
    moveFlagDmgUnderground: Boolean(move?.flags.hitsUnderground),
    moveFlagDmgUnderwater: Boolean(move?.flags.hitsUnderwater),

    attackerTypes: attacker.mon.types,
    // Gapped (structuralGaps); the C tests a live 2-bit counter this sim never
    // writes, so the only honest placeholder is "no trepidation".
    attackerTrepidationNonzero: false,
    attackerHoldEffect: attackerItem?.resolvedHoldEffect ?? null,
    attackerHoldEffectParam: attackerItem?.holdEffectStrength ?? 0,
    // Gapped: statStages is permanently neutral (see structuralGaps).
    attackerAccStage: attacker.mon.statStages[STAT_ACC] ?? DEFAULT_STAT_STAGE,
    attackerAbilitySlots: attacker.mon.abilities,
    attackerActsAfterDefender,
    // Gapped: RoundState.usedMicleBerry is never written, so it can never be true.
    attackerUsedMicleBerry: false,
    myceliumMightActive: false,

    defenderHoldEffect: defenderItem?.resolvedHoldEffect ?? null,
    defenderHoldEffectParam: defenderItem?.holdEffectStrength ?? 0,
    defenderEvasionStage: defender.mon.statStages[STAT_EVASION] ?? DEFAULT_STAT_STAGE,
    defenderHasForesight: hasFlag(defender.statuses4, STATUS4_FORESIGHT),
    defenderHasAlwaysHits: hasFlag(defender.statuses3, STATUS3_ALWAYS_HITS),
    battlerWithSureHitIsAttacker: defender.volatiles.battlerWithSureHit === attackerId,
    defenderHasTelekinesis: hasFlag(defender.statuses3, STATUS3_TELEKINESIS),
    // The one real port among the semi-invulnerability inputs: grounding.ts,
    // the same call turn.ts's own buildTurnOrderContext makes.
    defenderIsGrounded: isBattlerGrounded(state, targetId, deps.grounding),
    defenderHasPhantomForce: isPhantomForce(defender.statuses3),
    defenderIsOnAir: semiInvulnerableState(defender.statuses3) === 'AIRBORNE',
    defenderIsUnderground: semiInvulnerableState(defender.statuses3) === 'UNDERGROUND',
    defenderIsUnderwater: semiInvulnerableState(defender.statuses3) === 'UNDERWATER',
    defenderSmokescreenActive: false,
    defenderAbilitySlots: defender.mon.abilities,

    weather,
    gravityActive,
  }

  return { inputs, gaps, defenderHasAnticipation }
}
