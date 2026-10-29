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
import { SUPER_EFFECTIVE_ACCURACY_ABILITIES, SUPER_EFFECTIVE_MULTIPLIER, getSlotsInReverse } from './accuracy'
import type { BattleState } from './state'
import type { DamageResolver } from './turn'
import { isBattlerGrounded, isGravityActive } from './grounding'
import {
  DEFAULT_STAT_STAGE,
  STAT_ACC,
  STAT_EVASION,
  STATUS2_WRAPPED,
  STATUS3_ALWAYS_HITS,
  STATUS3_EMBARGO,
  STATUS3_TELEKINESIS,
  STATUS4_FORESIGHT,
  WEATHER_FOG_ANY,
  WEATHER_HAIL_ANY,
  WEATHER_RAIN_ANY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_STRONG_WINDS,
  WEATHER_SUN_ANY,
  hasFlag,
} from './constants'
import { isPhantomForce, semiInvulnerableState } from './unpack'
import { battlerHasSimAbility, getStatDropBlockType, isBattlerWeatherAffected, isSimAbilitySuppressed } from './statBuffs'
import { isKeenEdgeMove, isStrikerMove } from './statusEffects'
import { getBattlerBattleMoveTargetFlags } from './moveTargetFlags'

const bareType = (type: string | null): string => (type ?? '').replace(/^TYPE_/, '')

/** WeatherKind -> the WEATHER_*_ANY mask the C reads for that weather. Every
 * weather read GetTotalAccuracy performs is `IsBattlerWeatherAffected(target,
 * <flag>)` (battle_script_commands.c:1294 rain, :1320 hail, :1327 fog,
 * :1350 sun; the onAccuracy hooks use the same per-weather flags, e.g.
 * abilities.cc:599-608 SANDSTORM_ANY), so the bridge only needs to know which
 * mask corresponds to the single weather the bitfield already resolved to. */
const WEATHER_KIND_FLAGS: Partial<Record<string, number>> = {
  SUN_PERMANENT: WEATHER_SUN_ANY,
  SUN_TEMPORARY: WEATHER_SUN_ANY,
  SUN_PRIMAL: WEATHER_SUN_ANY,
  RAIN_PERMANENT: WEATHER_RAIN_ANY,
  RAIN_TEMPORARY: WEATHER_RAIN_ANY,
  RAIN_PRIMAL: WEATHER_RAIN_ANY,
  SANDSTORM: WEATHER_SANDSTORM_ANY,
  HAIL: WEATHER_HAIL_ANY,
  FOG: WEATHER_FOG_ANY,
  STRONG_WINDS: WEATHER_STRONG_WINDS,
}

/** Every AccuracyInputs field this bridge cannot honestly derive, because
 * nothing in the turn loop writes the C array it comes from. Declared once,
 * pushed on every call -- same shape as bridge.ts's BATCH1_GAPS, split out
 * per battler role below since attacker/defender fields need different
 * `field` names. */
function structuralGaps(): BridgeGap[] {
  return [
    { field: 'myceliumMightActive', reason: 'NO_SOURCE', detail: 'gHitMarker HITMARKER_MYCELIUM_MIGHT is a per-turn engine flag with no sim-state counterpart' },
  ]
}

export interface AccuracyBridgeDeps extends Pick<BridgeDeps, 'grounding' | 'dataContext'> {
  /** The combat resolver's type-effectiveness-only path. Optional so the
   * existing callers that only need the accuracy number keep their
   * `{ grounding, dataContext }` literals compiling; when absent (or when the
   * resolver does not implement the method) AccuracyInputs.isSuperEffective
   * stays undefined and accuracy.ts reports the gap. turn.ts's TurnLoopDeps
   * already carries the full DamageResolver, so every in-battle call site
   * supplies it without a new argument. */
  damage?: Pick<DamageResolver, 'typeEffectiveness'>
}

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

  // statusEffects.ts's StatusDeps (and moveTargetFlags.ts's dependency shape):
  // the same grounding/dataContext pair AccuracyBridgeDeps already carries.
  // The weather gates below, the STRIKER/KEEN_EDGE predicates and the Ole
  // target-flag lookup are all built from it.
  const statusDeps = { dataContext: deps.dataContext, grounding: deps.grounding }

  const { weather: rawWeather, gap: weatherGap } = weatherFromBitfield(state.field.weather)
  const gravityActive = isGravityActive(state, deps.grounding)
  if (weatherGap) gaps.push(weatherGap)
  // Every weather read in accuracy.ts -- the Thunder/Hurricane rain clause
  // (battle_script_commands.c:1294), Blizzard (:1320), Eerie Spell/Vexing Void
  // (:1327), the sun drop (:1350) and the Sand Veil / Snow Cloak / Rain Shroud
  // / Smokey Maneuvers hooks (abilities.cc:599-608, :1449-1456, :11475-11483,
  // :8187-8195) -- is `IsBattlerWeatherAffected(battlerDef, <weather's flag>)`
  // in the C. That is TRUE only while WEATHER_HAS_EFFECT (no clearSkiesTimer,
  // no Cloud Nine / Air Lock / Clueless on the field) and, for sun/rain, only
  // when the TARGET is not holding a Utility Umbrella (battle_util.c:8644-8653,
  // include/battle_util.h:45-46). When the check fails the C sees no weather at
  // all, so hand accuracy.ts 'NONE' rather than the raw field weather.
  // Echolocation (abilities.cc:11364-11371) is the one attacker-side read; it
  // uses WEATHER_FOG_ANY, for which IsBattlerWeatherAffected cannot differ
  // between the two battlers (the Utility Umbrella clause only covers sun and
  // rain), so the target's answer is also the attacker's answer there.
  const rawWeatherFlags = WEATHER_KIND_FLAGS[rawWeather] ?? 0
  const weather =
    rawWeather === 'NONE' ||
    (rawWeatherFlags !== 0 &&
      isBattlerWeatherAffected(state, targetId, rawWeatherFlags, statusDeps))
      ? rawWeather
      : 'NONE'

  const defenderHasAnticipation = defender.mon.abilities.ability === 'ABILITY_ANTICIPATION' || defender.mon.abilities.innates.includes('ABILITY_ANTICIPATION')
  const attackerHoldEffect = deps.grounding.holdEffectOf(attackerId)
  const defenderHoldEffect = deps.grounding.holdEffectOf(targetId)

  // IsStatDropBlocked(battlerAtk, STAT_ACC, FALSE) == STAT_DROP_BLOCK_SPECIFIC
  // (battle_script_commands.c:1336): the ATTACKER is the ability holder, the
  // stat is accuracy and it is not a self-drop. statBuffs.ts's
  // getStatDropBlockType is the real GetStatDropBlock port (own + partner scan).
  const accuracyBlockUnmodelled: string[] = []
  const attackerAccuracyDropBlockedSpecific =
    getStatDropBlockType(state, attackerId, STAT_ACC, false, statusDeps, accuracyBlockUnmodelled) === 'SPECIFIC'
  for (const detail of accuracyBlockUnmodelled) {
    gaps.push({ field: 'attackerAccuracyDropBlockedSpecific', reason: 'NO_SOURCE', detail })
  }

  // IsMegaLauncherBoosted is DoesMoveMatchFlag(MOVE_FLAG_MEGA_LAUNCHER)
  // (battle_util.c:9373), and DoesMoveMatchFlag falls through to the holder's
  // onModifyMoveFlags abilities (abilities.cc:374-388). Gunman is the only one
  // of those that answers TRUE for MEGA_LAUNCHER (abilities.cc:9533-9543: a
  // status move), so a Gunman holder's status moves count as Mega-Launcher
  // boosted for Artillery/Deadeye/Super Scope. The other onModifyMoveFlags
  // abilities (Brawling Wyvern PUNCH, Junshi Sanda PUNCH/KICK, Mixed Martial
  // Arts PUNCH/KICK, Rite of Passage/Festivities DANCE/SOUND, Musical Notes,
  // Reverbate, Taekkyeon) never grant MEGA_LAUNCHER and are not consulted.
  const moveFlagMegaLauncher =
    Boolean(move?.flags.bulletBased) ||
    (move?.split === 'STATUS' && battlerHasSimAbility(state, attacker, 'ABILITY_GUNMAN', false, attackerId, false, deps.dataContext))

  // GetTotalAccuracy runs its onAccuracy loop (:1354-1362) BEFORE the damage
  // step, so Fatal Precision and its aliases (abilities.cc:4397-4407) need
  // CalcTypeEffectivenessMultiplier before the accuracy roll. Only holders pay
  // for it; the value is the damage engine's own UQ_4_12 result (the same one
  // the later damage step reports), computed without drawing RNG.
  let isSuperEffective: boolean | undefined
  const attackerNeedsTypeEffectiveness = getSlotsInReverse(attacker.mon.abilities).some((abilityId) =>
    SUPER_EFFECTIVE_ACCURACY_ABILITIES.has(abilityId),
  )
  if (attackerNeedsTypeEffectiveness && move && move.split !== 'STATUS' && deps.damage?.typeEffectiveness) {
    const effectiveness = deps.damage.typeEffectiveness(state, attackerId, targetId, moveId)
    if (effectiveness.effectiveness === null) {
      gaps.push({
        field: 'isSuperEffective',
        reason: 'NEEDS_DATA',
        detail: `${moveId}'s type effectiveness could not be computed: ${effectiveness.unmodelled.join('; ')}`,
      })
    } else {
      isSuperEffective = effectiveness.effectiveness >= SUPER_EFFECTIVE_MULTIPLIER
    }
  }

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
    moveSplit: move?.split ?? null,
    // moves.json renames FLAG_MEGA_LAUNCHER/STRIKER/KEEN_EDGE (pipeline/src/erdata/emit.py:89-92).
    // Gunman is folded in above. STRIKER (IsStrikerBoosted, battle_util.c:9377)
    // and KEEN_EDGE (IsKeenEdge, :9381) are DoesMoveMatchFlag over the static
    // flag PLUS the attacker's onModifyMoveFlags abilities -- statusEffects.ts's
    // isStrikerMove / isKeenEdgeMove are that port, so the ability-granted
    // flags are applied, not just the raw moves.json bits.
    moveFlagMegaLauncher,
    moveFlagArrowBased: Boolean(move?.flags.arrowBased),
    moveFlagStriker: isStrikerMove(state, attackerId, moveId, statusDeps),
    moveFlagKeenEdge: isKeenEdgeMove(state, attackerId, moveId, statusDeps),
    // Ole's hook switches on GetBattlerBattleMoveTargetFlags(move, battler)
    // with `battler` = the ATTACKER (abilities.cc:7556-7570; the ON_ABILITY
    // macro passes battlerAtk as `battler`, battle_script_commands.c:1354-1362),
    // not on the raw moves.json target: an ability that widens a SELECTED move
    // to BOTH (Artillery / Amplifier / Sweeping Edge, battle_util.c:142-147)
    // makes Ole return NO_RESULT. moveEnd.ts delegates to moveTargetFlags.ts.
    moveTarget: move ? getBattlerBattleMoveTargetFlags(state, attackerId, moveId, move, statusDeps, statusDeps) : null,

    attackerTypes: attacker.mon.types,
    // Derived: written by BattleScript_EffectTrepidation (:8715-8723) and decremented in ENDTURN_GENERIC_BATTLER_TIMERS (:2976).
    attackerTrepidationNonzero: attacker.volatiles.trepidation > 0,
    attackerHoldEffect,
    attackerHoldEffectParam: attackerHoldEffect ? (attackerItem?.holdEffectStrength ?? 0) : 0,
    // Derived: statStages is maintained by applyStatBuff (statBuffs.ts:544).
    attackerAccStage: attacker.mon.statStages[STAT_ACC] ?? DEFAULT_STAT_STAGE,
    attackerAccuracyDropBlockedSpecific,
    attackerAbilitySlots: attacker.mon.abilities,
    attackerActsAfterDefender,
    // Derived: RoundState.usedMicleBerry is written by Micle Berry activation (moveEffects.ts:8837)
    // and cleared by Cmd_accuracycheck (battle_script_commands.c:1383-1384 / turn.ts).
    attackerUsedMicleBerry: attacker.round.usedMicleBerry,
    myceliumMightActive: false,
    isSuperEffective,

    defenderHoldEffect,
    defenderHoldEffectParam: defenderHoldEffect ? (defenderItem?.holdEffectStrength ?? 0) : 0,
    // DoesBattlerHaveAbilityShield (battle_util.c:6538-6545): the abilities' blocksAbilitySuppression flag
    // (set by no ability) or GetBattlerHoldEffect(battler, FALSE) == ABILITY_SHIELD, i.e. the raw item without
    // the Klutz negation, still gated on Embargo.
    defenderHasAbilityShield:
      defenderItem?.resolvedHoldEffect === 'HOLD_EFFECT_ABILITY_SHIELD' && !hasFlag(defender.statuses3, STATUS3_EMBARGO),
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
    // Derived: side smokescreenTimer (battle_script_commands.c:1393)
    defenderSmokescreenActive: (state.sides[targetId & 1]?.timers.smokescreenTimer ?? 0) > 0,
    defenderAbilitySlots: defender.mon.abilities,
    defenderIsWrapped: hasFlag(defender.mon.status2, STATUS2_WRAPPED),
    isAbilitySuppressed: (side, abilityId) =>
      isSimAbilitySuppressed(state, side === 'attacker' ? attacker : defender, abilityId, false, attackerId, false, deps.dataContext),
    attackerIndexFirst: attackerId < targetId,

    weather,
    gravityActive,
  }

  return { inputs, gaps, defenderHasAnticipation }
}
