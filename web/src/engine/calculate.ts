// The top-level entry point: CalculateMoveDamage -> DoMoveDamageCalc ->
// DoMoveDamageCalcInternal -> CalcFinalDmg (src/battle_util.c:7722-7845), tying
// together every module in this directory. This is the "port the REAL calculator,
// not the buggy in-battle preview" path named in the project plan.
//
// Ability hooks ARE wired in (abilities/dispatchCalc.ts), so results reflect
// whichever abilities the ported registry batches cover -- see
// abilities/impl/99-unmodelled.ts for what's still a stub. `unmodelled` on the
// result collects a human-readable note per gap actually encountered in a given
// scenario, so a caller can render "this result doesn't account for X" instead of
// silently presenting a partially ability-blind number as complete.

import { idiv, uq } from './fixed'
import {
  attackPreModify,
  benefitsFromStatBuffs,
  calcAttackStatModifiers,
  calcDefenseStatModifiers,
  calculateBattleStat,
  DEFAULT_STAT_STAGE,
  defaultDefendingStat,
  defensePreModify,
  noPositiveStatStages,
  spAttackPreModify,
  spDefensePreModify,
} from './battleStat'
import { applyMoveBehaviorDamage, calcMoveBasePowerAfterModifiers, type BasePowerModifierContext, type MoveBehaviors } from './basePower'
import { calcFinalDamage, defaultFinalDamageStages } from './finalDamage'
import { calcCritStage, critChanceDenominator, NEVER_CRIT, type CritStageInputs } from './crit'
import { calcTypeEffectiveness, distinctDefendingTypes, type TypeChart } from './typeEffectiveness'
import {
  abilityCoverageNote,
  computeAbilityCritBonus,
  computeAbilityMultiplier,
  computeAttackerHasMoldBreaker,
  computeIsAbsorbed,
  computeIsImmune,
  computeInfiltratesScreens,
  computeChooseDefensiveStat,
  computeChooseOffensiveStat,
  computeOnStatModifier,
  hasFlag,
  hasStabOverride,
  resolveEffectiveMoveType,
} from './abilities/dispatchCalc'
import { battlerHasAbility } from './abilities/dispatch'
import type { AbilitySlots } from './abilities/dispatch'
import type { BattleConstants, BattlerBattleState, BattleStatKey, DamageContext, FieldBattleState } from './types'

export interface MoveData {
  id: string
  power: number
  type: string | null
  type2: string | null
  split: 'PHYSICAL' | 'SPECIAL' | 'STATUS' | null
  effectChance: number
  splitFlag?: string // USE_HIGHEST_OFFENSE | USE_HIGHEST_DAMAGE | HITS_DEF | HITS_SPDEF | USE_LOWEST_DEFENSE (never handled, see below)
  effect: string | null
  customBehavior?: unknown
  crit?: 'HIGH' | 'ALWAYS'
  hitsAir?: 'HITS' | 'DOUBLE_DAMAGE'
  flags: Record<string, true>
  priority?: number // Higher Rank's GetMovePriority(...) > 0 check -- ability-adjusted priority (Prankster etc.) isn't modelled, just the move's own declared value
}

export interface DamageCalcScenario {
  move: MoveData
  attacker: BattlerBattleState
  defender: BattlerBattleState
  field: FieldBattleState
  typeChart: TypeChart
  moveBehaviors: MoveBehaviors
  battleConstants: BattleConstants
  /** UI-supplied context for the handful of turn-order/turn-history facts a static
   * calculator can't derive on its own -- see types.ts's DamageContext doc. */
  attackerActsFirst: boolean
  sameMoveTurnsInARow: number
}

export interface DamageCalcResult {
  /** All 16 non-crit damage rolls (85%-100%), ascending. */
  rolls: number[]
  /** The same 16 rolls with the crit multiplier forced on -- null if this move/battler
   * combination can never crit (Lucky Chant, Shell Armor-style, etc. -- none of which
   * are wired yet, so this is null only when the move itself can't crit). */
  critRolls: number[] | null
  critChanceDenominator: number | null
  effectiveMoveType: string
  typeEffectiveness: number // UQ_4_12
  isImmune: boolean
  unmodelled: string[]
}

function toDamageContext(scenario: DamageCalcScenario): DamageContext {
  return {
    attacker: scenario.attacker.condition,
    defender: scenario.defender.condition,
    field: scenario.field,
    attackerActsFirst: scenario.attackerActsFirst,
    sameMoveTurnsInARow: scenario.sameMoveTurnsInARow,
  }
}

/** GetBattleMoveSplit / SetSwapDamageCategory's non-ability-hook branches
 * (src/battle_util.c:7341-7381). Ties (equal computed stats) are resolved to
 * PHYSICAL rather than the C's `Random() % 2` -- a static calculator reports one
 * scenario per call, not a coin flip. USE_LOWEST_DEFENSE is never handled by the C
 * itself (falls through to the `default` branch, i.e. behaves like USE_BASE_SPLIT) --
 * reproduced here rather than treated as an error. */
function resolveSplit(scenario: DamageCalcScenario, rawStats: { atk: number; spatk: number; def: number; spdef: number }): 'PHYSICAL' | 'SPECIAL' {
  const base = scenario.move.split === 'SPECIAL' ? 'SPECIAL' : 'PHYSICAL'
  let split: 'PHYSICAL' | 'SPECIAL' = base

  if (scenario.move.splitFlag === 'USE_HIGHEST_OFFENSE') {
    split = rawStats.atk > rawStats.spatk ? 'PHYSICAL' : rawStats.atk < rawStats.spatk ? 'SPECIAL' : base
  } else if (scenario.move.splitFlag === 'USE_HIGHEST_DAMAGE') {
    const physicalScore = rawStats.atk * rawStats.spdef
    const specialScore = rawStats.spatk * rawStats.def
    split = physicalScore > specialScore ? 'PHYSICAL' : physicalScore < specialScore ? 'SPECIAL' : base
  }

  if (scenario.attacker.condition.resolvedHoldEffect === 'HOLD_EFFECT_SWIRLY_GLASSES') {
    split = split === 'PHYSICAL' ? 'SPECIAL' : 'PHYSICAL'
  }
  return split
}

function toInternalStage(externalStage: number): number {
  return Math.max(0, Math.min(12, externalStage + DEFAULT_STAT_STAGE))
}

// GetHighestAttackingStatId/GetHighestStatId, src/battle_util.c -- compares RAW
// stats (not stat-staged). Ties favor 'atk' / BattleStatKey's own declared order
// respectively; not independently verified against the C's own tie-break.
function isHighestAttackingStat(battler: BattlerBattleState, stat: BattleStatKey): boolean {
  const highest = battler.rawStats.atk >= battler.rawStats.spatk ? 'atk' : 'spatk'
  return stat === highest
}
function isHighestStat(battler: BattlerBattleState, stat: BattleStatKey): boolean {
  const keys: BattleStatKey[] = ['atk', 'def', 'spatk', 'spdef', 'spe']
  let best: BattleStatKey = keys[0]
  for (const k of keys) if (battler.rawStats[k] > battler.rawStats[best]) best = k
  return stat === best
}

interface ComputeStatOptions {
  battler: BattlerBattleState
  opponent: BattlerBattleState
  stat: BattleStatKey
  move: MoveData
  isAttackRole: boolean
  isCrit: boolean
  isWonderRoomActive: boolean
  field: FieldBattleState
  statStageRatios: [number, number][]
}

/** The parts of CalculateStat this engine can run without the ability registry:
 * raw stat selection, the per-stat pre-modifiers, stat-stage clamping, and the stage
 * ratio + extra-stat-level application. `onStat` hooks and the secondary-stat blend
 * are the identity/0 default documented in battleStat.ts. */
function computeStat(opts: ComputeStatOptions): number {
  const { battler, stat, move, field } = opts
  const isIceType = battler.types.includes('ICE')
  const isRockType = battler.types.includes('ROCK')

  const preModify =
    stat === 'atk'
      ? attackPreModify({
          violentRush: false,
          showdownMode: false,
          readiedAction: false,
          isBurned: battler.condition.status1.has('STATUS1_BURN') && move.effect !== 'EFFECT_FACADE',
        })
      : stat === 'spatk'
        ? spAttackPreModify({ rapidResponse: false, isFrostbitten: battler.condition.status1.has('STATUS1_FROSTBITE') && move.effect !== 'EFFECT_FACADE' })
        : stat === 'def'
          ? defensePreModify({ isIceTypeInHail: isIceType && field.weather === 'HAIL' })
          : stat === 'spdef'
            ? spDefensePreModify({ isRockTypeInSandstorm: isRockType && field.weather === 'SANDSTORM' })
            : (s: number) => s // speed has no CalculateStat pre-modifier of its own

  const isBleeding = battler.condition.status1.has('STATUS1_BLEED')
  const isPoisoned = battler.condition.status1.has('STATUS1_POISON') || battler.condition.status1.has('STATUS1_TOXIC_POISON')

  return calculateBattleStat({
    rawStat: battler.rawStats[stat],
    extraStatLevel: battler.extraStatLevel[stat] ?? 0,
    statStage: toInternalStage(battler.statStages[stat] ?? 0),
    // IsUnaware(opponent) -- Unaware makes the OPPONENT ignore THIS battler's stat
    // changes, so it's the opponent's ability that gates this, not the stat owner's
    // own (src/battle_util.c:7255 for attack, :7398 for defense).
    isUnaware: hasFlag(opts.opponent.abilitySlots, 'unaware'),
    isWonderRoomActive: opts.isWonderRoomActive,
    isOffensiveStatForWonderRoom: stat === 'atk' || stat === 'spatk',
    isCrit: opts.isCrit,
    isAttackRole: opts.isAttackRole,
    benefitsFromStatBuffs: benefitsFromStatBuffs(isBleeding, battler.condition.hasBloodStainEffect, isPoisoned, false),
    preModify,
    applyOnStatHooks: computeOnStatModifier(battler.abilitySlots, opts.opponent.abilitySlots, {
      battlerId: 'self',
      statId: stat,
      moveId: move.id,
      weather: field.weather,
      terrain: field.terrain,
      hp: battler.condition.hp,
      maxHp: battler.condition.maxHp,
      hasAnyStatus: battler.condition.status1.size > 0 || battler.condition.hasComatose || battler.condition.hasBloodStainEffect,
      status1: battler.condition.status1,
      isHighestAttackingStat: isHighestAttackingStat(battler, stat),
      isHighestStat: isHighestStat(battler, stat),
      abilityOn: battler.abilityOn,
      boostedStat: battler.boostedStat,
      alliesFainted: battler.alliesFainted,
    }),
    secondaryStatPercent: 0, // the OWN-stat self-buff variant (secondaryStat[statEnum]) -- no ability in the census ever targets its own chosen stat this way, so this stays 0; see applySecondaryStatBlend for the (used) other-stat blend
    statStageRatios: opts.statStageRatios,
  })
}

/**
 * CalculateStat's cross-stat blend (:7213-7220): each OTHER stat named in
 * secondaryStat contributes `floor(thatStat'sFullValue * percent / 100)`, added on
 * top of the primary stat's own fully-scaled value -- `thatStat'sFullValue` is
 * computed the same way as the primary (stat-stage scaling, extraStatLevel, onStat
 * hooks all included, matching the C's own recursive CalculateStat call), just for
 * a different stat key. `computeOther` is the caller's own computeStat closure so
 * this stays agnostic to which battler/move/crit context it's being called in.
 */
function applySecondaryStatBlend(primary: number, secondaryStat: Partial<Record<BattleStatKey, number>>, computeOther: (stat: BattleStatKey) => number): number {
  let total = primary
  for (const [stat, percent] of Object.entries(secondaryStat) as [BattleStatKey, number][]) {
    if (!percent) continue
    total += idiv(computeOther(stat) * percent, 100)
  }
  return total
}

function computeAttackStat(scenario: DamageCalcScenario, split: 'PHYSICAL' | 'SPECIAL', isCrit: boolean, statStageRatios: [number, number][]) {
  const { attacker, defender, move, field } = scenario
  const unmodelled: string[] = []

  // EFFECT_LASH_OUT forces isCrit=true for the attacker's own stat calc (:7252).
  const forcedCrit = move.effect === 'EFFECT_LASH_OUT' ? true : isCrit
  // EFFECT_FOUL_PLAY uses the DEFENDER's stat and Unaware check instead (:7254-7256).
  const isFoulPlay = move.effect === 'EFFECT_FOUL_PLAY'
  const statBattler = isFoulPlay ? defender : attacker
  const isBodyPress = move.effect === 'EFFECT_BODY_PRESS'
  const defaultAtkStat: BattleStatKey = isBodyPress ? 'def' : split === 'PHYSICAL' ? 'atk' : 'spatk'
  const attackerHasMoldBreaker = computeAttackerHasMoldBreaker(attacker.abilitySlots, move.id, move.split ?? 'STATUS')
  // onChooseOffensiveStat only runs in the non-Foul-Play/Body-Press/Monotype-Champ
  // case (:7255-7269) -- the Monotype Champ special case isn't modelled here.
  const { statToUse: atkStat, secondaryStat: atkSecondaryStat } =
    isFoulPlay || isBodyPress
      ? { statToUse: defaultAtkStat, secondaryStat: {} }
      : computeChooseOffensiveStat(attacker.abilitySlots, defaultAtkStat, {
          battlerId: 'attacker',
          moveId: move.id,
          isCrit: forcedCrit,
          // Unaware IS breakable -- a defender's Unaware here can be bypassed by
          // the attacker's own Mold Breaker.
          isUnaware: hasFlag(defender.abilitySlots, 'unaware', attackerHasMoldBreaker),
          moveSplit: split,
          moveFlags: move.flags,
          isHighestAttackingStat: isHighestAttackingStat(attacker, 'atk'),
        })

  const statOpponent = statBattler === attacker ? defender : attacker
  const rawAtkStat = applySecondaryStatBlend(
    computeStat({ battler: statBattler, opponent: statOpponent, stat: atkStat, move, isAttackRole: true, isCrit: forcedCrit, isWonderRoomActive: false, field, statStageRatios }),
    atkSecondaryStat,
    (stat) => computeStat({ battler: statBattler, opponent: statOpponent, stat, move, isAttackRole: true, isCrit: forcedCrit, isWonderRoomActive: false, field, statStageRatios }),
  )

  const isGhostDefenderInFog = defender.types.includes('GHOST') && field.weather === 'FOG'
  const finalAtk = calcAttackStatModifiers({
    attackStat: rawAtkStat,
    isGhostDefenderInFog,
    isInfatuatedWithDefender: attacker.isInfatuatedWithOpponent,
    item: {
      resolvedHoldEffect: attacker.condition.resolvedHoldEffect,
      baseSpeciesId: attacker.condition.baseSpeciesId,
      isPhysical: split === 'PHYSICAL',
      isSpecial: split === 'SPECIAL',
    },
  })
  return { value: finalAtk, unmodelled }
}

function computeDefenseStat(scenario: DamageCalcScenario, split: 'PHYSICAL' | 'SPECIAL', isCrit: boolean, statStageRatios: [number, number][]) {
  const { attacker, defender, move } = scenario
  const unmodelled: string[] = []

  const isWrappedGripPincer = false // Wrap + Grip Pincer/World Serpent -- deferred (ability)
  const noPositive = noPositiveStatStages(isCrit, Boolean(move.flags.ignoresStatStages), isWrappedGripPincer)
  const defaultDefStat = defaultDefendingStat(move.splitFlag, split === 'PHYSICAL')
  const defRaw = defender.rawStats
  const { statToUse: defStat, secondaryStat: defSecondaryStat } = computeChooseDefensiveStat(attacker.abilitySlots, defender.abilitySlots, defaultDefStat, {
    attackerId: 'attacker',
    defenderId: 'defender',
    moveId: move.id,
    noPositiveStatStages: noPositive,
    isUnaware: hasFlag(attacker.abilitySlots, 'unaware'),
    isCrit,
    moveFlags: move.flags,
    defenderHasAnyStatus: defender.condition.status1.size > 0 || defender.condition.hasComatose || defender.condition.hasBloodStainEffect,
    defenderDefComparison: defRaw.def < defRaw.spdef ? 'def' : defRaw.spdef < defRaw.def ? 'spdef' : 'equal',
    attackerIsConfused: attacker.condition.isConfused,
  })

  const rawDefStat = applySecondaryStatBlend(
    computeStat({ battler: defender, opponent: attacker, stat: defStat, move, isAttackRole: false, isCrit: noPositive, isWonderRoomActive: false, field: scenario.field, statStageRatios }),
    defSecondaryStat,
    (stat) => computeStat({ battler: defender, opponent: attacker, stat, move, isAttackRole: false, isCrit: noPositive, isWonderRoomActive: false, field: scenario.field, statStageRatios }),
  )

  const finalDef = calcDefenseStatModifiers(rawDefStat, {
    resolvedHoldEffect: defender.condition.resolvedHoldEffect,
    speciesId: defender.condition.speciesId,
    baseSpeciesId: defender.condition.baseSpeciesId,
    isTransformed: defender.isTransformed,
    canEvolveStrict: defender.canEvolveStrict,
    defStatToUse: defStat,
  })
  return { value: finalDef, unmodelled }
}

/** CalcCritChanceStage's non-ability inputs (src/battle_script_commands.c:1523-1558),
 * built once per scenario since none of it depends on the evaluated type or a
 * particular damage roll. */
function scenarioCritStageInputs(scenario: DamageCalcScenario): CritStageInputs {
  const { attacker, defender, move, field } = scenario
  const attackerHasMoldBreaker = computeAttackerHasMoldBreaker(attacker.abilitySlots, move.id, move.split ?? 'STATUS')
  const abilityBonus = computeAbilityCritBonus(
    attacker.abilitySlots,
    defender.abilitySlots,
    {
      defenderId: 'defender',
      moveId: move.id,
      typeEffectiveness: uq(1.0),
      defenderStatus1: defender.condition.status1,
      defenderSpeedStageNegative: defender.statStages.spe < 0,
      defenderResolvedHoldEffect: defender.condition.resolvedHoldEffect,
      moveFlags: move.flags,
      // Perfectionist's own check reads CalcMoveBasePower's PRE-modifier value
      // elsewhere in the pipeline; this call site runs before that's computed, so
      // move.power (the raw declared value) is used instead -- an approximation for
      // the handful of moves whose behavior config changes power before the crit
      // check would otherwise see it.
      basePower: move.power,
      attackerActsFirst: scenario.attackerActsFirst,
    },
    attackerHasMoldBreaker,
    attacker.abilityOn,
    defender.abilityOn,
  )
  return {
    // NEVER_CRIT from an onCrit hook (e.g. Battle Armor/Shell Armor) folds into the
    // same "blocked" outcome as Lucky Chant -- both mean "this hit can never crit".
    isBlocked: field.sides.defender.luckyChant || abilityBonus === NEVER_CRIT,
    isGuaranteed: move.crit === 'ALWAYS',
    abilityCritBonus: abilityBonus === NEVER_CRIT ? 0 : abilityBonus,
    hasHighCritFlag: move.crit === 'HIGH',
    hasScopeLens: attacker.condition.resolvedHoldEffect === 'HOLD_EFFECT_SCOPE_LENS',
    hasLuckyPunchOnChanseyLine: false, // needs a species-family table -- deferred
    hasLeekOnFarfetchdLine: attacker.condition.resolvedHoldEffect === 'HOLD_EFFECT_LEEK',
    isViseGrip: move.id === 'MOVE_VISE_GRIP',
  }
}

/** The crit chance denominator for this scenario, or null if this move/battler
 * combination can never crit -- shared by both the roll loop and the separate
 * crit-forced pass so the two can't drift apart. */
function scenarioCritDenominator(scenario: DamageCalcScenario): number | null {
  const stage = calcCritStage(scenarioCritStageInputs(scenario))
  return critChanceDenominator(stage, scenario.battleConstants.criticalHitChance)
}

/** DoMoveDamageCalcInternal's core equation for ONE evaluated type, up to (but not
 * including) the random factor -- src/battle_util.c:7722-7786. Returns -1 when the
 * type effectiveness is a flat immunity, matching the C's early return.
 *
 * `forceCrit` selects which of the two output rows (calculateMoveDamage's `rolls` vs
 * `critRolls`) this evaluation belongs to, rather than drawing a random 0-23 crit
 * roll per src/battle_script_commands.c:1589's MakeCritRoll() -- a deterministic
 * calculator reports both a non-crit and a (when possible) crit row, not one sampled
 * outcome. A move whose crit is unconditionally guaranteed (crit denominator 1) still
 * reports its "non-crit" row as non-crit even though the real game can never actually
 * produce that row -- callers should prefer `critRolls` whenever
 * `critChanceDenominator === 1`. */
function calcInternal(
  scenario: DamageCalcScenario,
  inputMoveType: string,
  split: 'PHYSICAL' | 'SPECIAL',
  forceCrit: boolean,
): { dmg: number; typeEffectiveness: number; resolvedMoveType: string; unmodelled: string[] } {
  const unmodelled: string[] = []
  const { attacker, defender, move, field, typeChart, moveBehaviors, battleConstants } = scenario
  const statStageRatios = battleConstants.statStageRatios

  // "-ate" abilities (Pixilate, Aerilate, Refrigerate, ...) override a Normal-type
  // move's type BEFORE anything else runs -- type effectiveness, STAB, and the
  // terrain-boost base-power check all key off the resolved type, not the move's
  // listed one (src/battle_main.c:5203-5211, GetMoveTypeInternal).
  const { moveType, ateBoost } = resolveEffectiveMoveType(attacker.abilitySlots, move.id, inputMoveType, move.flags)

  // Computed here (rather than down near computeAbilityMultiplier, as in the other two
  // calcInternal-adjacent call sites) because IsBattlerGroundedIgnoreType's Levitate
  // check (below) is itself checkMoldBreaker=TRUE (battle_util.c:6694,
  // RETURN_ABILITY_IF_FLAG(battlerId, TRUE, levitate)) and runs before type
  // effectiveness is known.
  const attackerHasMoldBreaker = computeAttackerHasMoldBreaker(attacker.abilitySlots, move.id, split)

  const defenderTypes = distinctDefendingTypes(defender.types)
  // isGrounded mirrors IsBattlerGroundedIgnoreType (:6699-6701): defender.isGrounded is
  // the species-only baseline (Flying-type is airborne; scenario.ts builds it with no
  // ability knowledge). The Levitate ABILITY is the one levitating effect this engine
  // models -- Air Balloon/Magnet Rise/Telekinesis (also CheckLevitatingEffects,
  // :6687-6695) and Gravity/Iron Ball/Ingrain/Smacked Down (the grounding effects that
  // override everything, CheckGroundingEffects, :6672-6685) have no scenario state here
  // and stay unmodelled, same as the rest of the field-state backlog.
  const isGrounded = defender.isGrounded && !hasFlag(defender.abilitySlots, 'levitate', attackerHasMoldBreaker)
  const typeEffectiveness = calcTypeEffectiveness(moveType, defenderTypes, typeChart, isGrounded)
  if (typeEffectiveness === 0) return { dmg: -1, typeEffectiveness, resolvedMoveType: moveType, unmodelled }

  // TestAbsorbingAbilities (:8961-8969) -- a hit-blocking check distinct from type
  // immunity (Volt Absorb/Water Absorb/etc. can zero out a move whose type chart
  // entry is otherwise neutral or even super-effective). Forcing typeEffectiveness
  // to 0 here, same as the Levitate/isGrounded case above, is what makes the
  // outer calculateMoveDamage's `isImmune` flag (typeEffectiveness === 0) read
  // correctly for this case too, not just true type immunity.
  if (computeIsAbsorbed(defender.abilitySlots, { moveType, moveFlags: move.flags }, attackerHasMoldBreaker)) {
    return { dmg: -1, typeEffectiveness: 0, resolvedMoveType: moveType, unmodelled }
  }

  // TestImmunityAbilities (:8978-8997) -- a hard block distinct from both type
  // immunity and onAbsorb (no heal/stat-boost side effect, just "this move fails").
  if (
    computeIsImmune(
      defender.abilitySlots,
      { moveType, moveFlags: move.flags, moveSplit: move.split ?? 'STATUS', weather: field.weather, movePriority: move.priority ?? 0 },
      attackerHasMoldBreaker,
    )
  ) {
    return { dmg: -1, typeEffectiveness: 0, resolvedMoveType: moveType, unmodelled }
  }

  const isCrit = forceCrit

  const basePowerCtx: BasePowerModifierContext = {
    ...toDamageContext(scenario),
    moveType,
    isPhysical: split === 'PHYSICAL',
    isSpecial: split === 'SPECIAL',
    attackerHoldEffect: {
      resolvedHoldEffect: attacker.condition.resolvedHoldEffect,
      strength: attacker.holdEffectStrength,
      holdEffectType: attacker.holdEffectType,
    },
    attackerIsLatiOrLatias: attacker.condition.baseSpeciesId === 'SPECIES_LATIAS' || attacker.condition.baseSpeciesId === 'SPECIES_LATIOS',
    moveEffect: move.effect,
    moveArgumentStatus: null, // EFFECT_DOUBLE_DMG_IF_STATUS1's argument -- caller can extend later
  }

  const behaviorResult = applyMoveBehaviorDamage(move.power, move.effect, moveBehaviors, toDamageContext(scenario))
  unmodelled.push(...behaviorResult.unmodelled)
  const power = calcMoveBasePowerAfterModifiers(Math.max(behaviorResult.power, 1), basePowerCtx)

  for (const id of [attacker.abilitySlots.ability, ...attacker.abilitySlots.innates, defender.abilitySlots.ability, ...defender.abilitySlots.innates]) {
    const note = abilityCoverageNote(id)
    if (note) unmodelled.push(note)
  }

  const atk = computeAttackStat(scenario, split, isCrit, statStageRatios)
  const def = computeDefenseStat(scenario, split, isCrit, statStageRatios)
  unmodelled.push(...atk.unmodelled, ...def.unmodelled)

  let dmg = idiv(attacker.level * 2, 5) + 2
  dmg *= power
  dmg *= atk.value
  dmg = idiv(dmg, def.value)
  dmg = idiv(dmg, 50) + 2

  const isSuperEffective = typeEffectiveness >= uq(2.0)
  const abilityMultiplier = computeAbilityMultiplier(
    attacker.abilitySlots,
    defender.abilitySlots,
    {
      battlerId: 'attacker',
      defenderId: 'defender',
      moveId: move.id,
      moveType,
      moveSplit: split,
      moveFlags: move.flags,
      moveEffectChance: move.effectChance,
      ateBoost,
      basePower: power,
      typeEffectiveness,
      isCrit,
      attackerHasAnyStatus: attacker.condition.status1.size > 0 || attacker.condition.hasComatose || attacker.condition.hasBloodStainEffect,
      attackerHp: attacker.condition.hp,
      attackerMaxHp: attacker.condition.maxHp,
      attackerActsFirst: scenario.attackerActsFirst,
      weather: field.weather,
      defenderTypes: defender.types,
      attackerStatus1: attacker.condition.status1,
      sameMoveTurnsInARow: scenario.sameMoveTurnsInARow,
      terrain: field.terrain,
      movePriority: move.priority ?? 0,
      attackerAbilityOn: attacker.abilityOn,
      isAuraBreakActive: hasFlag(attacker.abilitySlots, 'auraBreak') || hasFlag(defender.abilitySlots, 'auraBreak'),
      attackerGender: attacker.gender,
      defenderGender: defender.gender,
      defenderIsConfused: defender.condition.isConfused,
      defenderIsEnraged: defender.condition.isEnraged,
      defenderStatus1: defender.condition.status1,
      defenderHasBloodStainEffect: defender.condition.hasBloodStainEffect,
      defenderHasComatose: defender.condition.hasComatose,
      attackerIsUnaware: hasFlag(attacker.abilitySlots, 'unaware'),
      defenderHasAnyLoweredStat: defender.condition.negativeStatStageCount > 0,
    },
    {
      defenderId: 'defender',
      attackerId: 'attacker',
      moveId: move.id,
      moveType,
      moveSplit: split,
      moveFlags: move.flags,
      typeEffectiveness,
      isCrit,
      weather: field.weather,
      defenderAtMaxHp: defender.condition.hp === defender.condition.maxHp,
      attackerActsFirst: scenario.attackerActsFirst,
      defenderTypes: defender.types,
      defenderAbilityOn: defender.abilityOn,
      attackerGender: attacker.gender,
      defenderGender: defender.gender,
      defenderIsEnraged: defender.condition.isEnraged,
    },
    attackerHasMoldBreaker,
  )
  const finalResult = calcFinalDamage(dmg, {
    ...defaultFinalDamageStages({ typeEffectiveness }),
    abilityMultiplier,
    // MISC_EFFECT_INCREASED_CRIT_DAMAGE moves crit for x2.0 instead of x1.5
    // (src/battle_util.c:7536-7540); move.argument threading isn't wired into
    // MoveData yet, so this is always the ordinary x1.5 for now.
    critMultiplier: isCrit ? 1.5 : null,
    weatherMultiplier: weatherDamageMultiplier(field.weather, move, moveType),
    stabInHalves: stabInHalves(attacker.types, attacker.abilitySlots, defender.abilitySlots, moveType, attackerHasMoldBreaker),
    screensActive:
      !isCrit &&
      screensApply(field, split) &&
      !computeInfiltratesScreens(attacker.abilitySlots, { moveType, moveFlags: move.flags, moveSplit: move.split ?? 'STATUS', attackerTypes: attacker.types }),
    isDoubleBattle: field.isDoubleBattle,
    resistBerryMultiplier: null, // resist-berry consumption isn't tracked yet -- deferred
    attackerItemMultiplier: attackerFinalItemMultiplier(attacker, typeEffectiveness),
    hasSuperEffectiveBoost: isSuperEffective && move.effect === 'EFFECT_MISC_HIT',
    // battle_util.c:7707-7709 -- both the move's own flag AND the defender's
    // semi-invulnerable state (a scenario toggle, see BattlerBattleState's doc)
    // must hold. hitsAir only doubles for the FLAG_DMG_2X_IN_AIR variant --
    // hitsAir === 'HITS' (FLAG_DMG_IN_AIR) only lets the move connect at all,
    // with no damage multiplier of its own.
    hitsSemiInvulnerableUnderground: Boolean(move.flags.hitsUnderground) && defender.semiInvulnerable === 'UNDERGROUND',
    hitsSemiInvulnerableUnderwater: Boolean(move.flags.hitsUnderwater) && defender.semiInvulnerable === 'UNDERWATER',
    hitsSemiInvulnerableInAir: move.hitsAir === 'DOUBLE_DAMAGE' && defender.semiInvulnerable === 'AIRBORNE',
  })

  return { dmg: finalResult.dmg, typeEffectiveness, resolvedMoveType: moveType, unmodelled }
}

/**
 * StabMultiplierInHalves, src/battle_util.c:7469-7481.
 *
 *   if (move == MOVE_STRUGGLE) return 2;
 *   if (IsAbilityOnFieldExcept(battler, ABILITY_RELIC_STONE)) return 2;
 *
 * Struggle is typeless (no move type to check STAB against at all), so the early
 * return there is a pure no-op we get for free by construction -- omitted.
 * IsAbilityOnFieldExcept scans every battler OTHER than the one computing STAB
 * (`i == battlerId` is skipped, battle_util.c:4839-4848); in this 2-battler v1
 * singles engine "every other battler" is just the defender, so the attacker's OWN
 * Relic Stone (if it somehow held one) would NOT suppress its own STAB, matching
 * the C exactly. Relic Stone has zero hooks of its own (`breakable` only) -- this
 * is a hardcoded special case, not something the ability registry can express.
 * Mold Breaker suppression of `breakable` abilities (including this one) isn't
 * modelled yet -- see isSuppressed's own doc in dispatchCalc.ts.
 */
function stabInHalves(
  attackerTypes: string[],
  attackerSlots: AbilitySlots,
  defenderSlots: AbilitySlots,
  moveType: string,
  attackerHasMoldBreaker: boolean,
): 2 | 3 | 4 {
  // Relic Stone is `breakable` -- an attacker with an active Mold Breaker bypasses
  // the field-wide STAB suppression, per IsSuppressed's own rule.
  if (battlerHasAbility(defenderSlots, 'ABILITY_RELIC_STONE', () => attackerHasMoldBreaker)) return 2
  const isStab = attackerTypes.includes(moveType) || hasStabOverride(attackerSlots, moveType)
  if (!isStab) return 2
  return hasFlag(attackerSlots, 'adaptability') ? 4 : 3
}

function screensApply(field: FieldBattleState, split: 'PHYSICAL' | 'SPECIAL'): boolean {
  const side = field.sides.defender
  if (side.auroraVeil) return true
  if (split === 'PHYSICAL' && side.reflect) return true
  if (split === 'SPECIAL' && side.lightScreen) return true
  return false
  // Infiltrator-style screen-bypassing abilities are handled at the call site via
  // computeInfiltratesScreens, not here -- this function only knows the field/side
  // state, not the attacker's abilities.
}

/** The weather damage block, src/battle_util.c:7592-7648 -- ER's two-tier weather
 * (PERMANENT = weak, TEMPORARY/PRIMAL = strong). ABILITY_WEATHER_DOUBLE_BOOST is
 * deferred (assume absent, i.e. the non-boosted branch always applies). */
function weatherDamageMultiplier(weather: FieldBattleState['weather'], move: MoveData, moveType: string): number | null {
  const isWeatherBoostMove = move.effect === 'EFFECT_WEATHER_BOOST'
  if (weather === 'RAIN_PERMANENT') {
    if (isWeatherBoostMove) return 1.2
    if (moveType === 'FIRE') return 0.5
    if (moveType === 'WATER') return 1.2
  } else if (weather === 'RAIN_TEMPORARY' || weather === 'RAIN_PRIMAL') {
    if (isWeatherBoostMove) return 1.5
    if (moveType === 'FIRE') return 0.5
    if (moveType === 'WATER') return 1.5
  } else if (weather === 'SUN_PERMANENT') {
    if (isWeatherBoostMove) return 1.2
    if (moveType === 'FIRE') return 1.2
    if (moveType === 'WATER') return 0.5
  } else if (weather === 'SUN_TEMPORARY' || weather === 'SUN_PRIMAL') {
    if (isWeatherBoostMove) return 1.5
    if (moveType === 'FIRE') return 1.5
    if (moveType === 'WATER') return 0.5
  }
  return null
}

function attackerFinalItemMultiplier(attacker: BattlerBattleState, typeEffectiveness: number): number {
  const effect = attacker.condition.resolvedHoldEffect
  if (effect === 'HOLD_EFFECT_LIFE_ORB') return uq(1.3)
  if (effect === 'HOLD_EFFECT_EXPERT_BELT' && typeEffectiveness >= uq(2.0)) return uq(1.2)
  // Metronome (needs same-move-turn tracking), Amulet Coin (Meowth Partner-only), and
  // Punching Glove (needs IsIronFistBoosted, an ability check) are deferred.
  return uq(1.0)
}

/** CalculateMoveDamage / DoMoveDamageCalc, src/battle_util.c:7788-7827. Evaluates
 * all 16 damage rolls (and, separately, the same 16 with a forced crit) rather than
 * drawing one; see kochance.ts for the KO-probability consumer of this shape. */
export function calculateMoveDamage(scenario: DamageCalcScenario): DamageCalcResult {
  const { move } = scenario
  const moveType = move.type ?? 'NORMAL'
  const attackerRaw = { atk: scenario.attacker.rawStats.atk, spatk: scenario.attacker.rawStats.spatk, def: scenario.attacker.rawStats.def, spdef: scenario.attacker.rawStats.spdef }
  const split = resolveSplit(scenario, attackerRaw)

  const evaluate = (mtype: string, forceCrit: boolean) => calcInternal(scenario, mtype, split, forceCrit)

  function fullDamageForRoll(damageRoll: number, forceCrit: boolean): { dmg: number; typeEffectiveness: number; effectiveMoveType: string; unmodelled: string[] } {
    const primary = evaluate(moveType, forceCrit)
    let best = { ...primary, effectiveMoveType: primary.resolvedMoveType }

    if (move.type2 && move.type2 !== moveType && move.type2 !== 'MYSTERY') {
      const alt = evaluate(move.type2, forceCrit)
      if (alt.dmg > best.dmg) best = { ...alt, effectiveMoveType: alt.resolvedMoveType }
    }

    if (best.dmg < 0) return { dmg: 0, typeEffectiveness: best.typeEffectiveness, effectiveMoveType: best.effectiveMoveType, unmodelled: best.unmodelled }

    // random factor, src/battle_util.c:7815-7821 -- Bad Luck/Bad Omen (deferred) would
    // force roll=15 on the defender's side.
    let dmg = idiv(best.dmg * (100 - damageRoll), 100)
    if (dmg === 0) dmg = 1
    return { dmg, typeEffectiveness: best.typeEffectiveness, effectiveMoveType: best.effectiveMoveType, unmodelled: best.unmodelled }
  }

  const unmodelled = new Set<string>()
  const rolls: number[] = []
  let typeEffectiveness = uq(1.0)
  let effectiveMoveType = moveType
  // `roll` is the C's own roll variable (multiplier = (100-roll)%, so roll=0 is the
  // maximum 100% hit and roll=15 the minimum 85% hit, src/battle_util.c:7816-7817).
  // Iterated 15 -> 0 here so the OUTPUT array itself reads ascending (index 0 =
  // smallest/85% roll, index 15 = largest/100% roll) -- the conventional order for
  // presenting a damage range.
  for (let roll = 15; roll >= 0; roll--) {
    const result = fullDamageForRoll(roll, false)
    rolls.push(result.dmg)
    typeEffectiveness = result.typeEffectiveness
    effectiveMoveType = result.effectiveMoveType
    result.unmodelled.forEach((u) => unmodelled.add(u))
  }

  const isImmune = typeEffectiveness === 0

  // A separate crit-forced pass, so callers can show "if this crits" alongside the
  // normal spread without re-deriving crit eligibility themselves.
  const canCrit = scenarioCritDenominator(scenario)
  let critRolls: number[] | null = null
  if (canCrit !== null) {
    critRolls = []
    for (let roll = 15; roll >= 0; roll--) {
      critRolls.push(fullDamageForRoll(roll, true).dmg)
    }
  }

  return {
    rolls,
    critRolls,
    critChanceDenominator: canCrit,
    effectiveMoveType,
    typeEffectiveness,
    isImmune,
    unmodelled: [...unmodelled],
  }
}
