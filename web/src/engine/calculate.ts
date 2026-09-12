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
  applyStatTail,
  attackPreModify,
  benefitsFromStatBuffs,
  calcAttackStatModifiers,
  calcDefenseStatModifiers,
  calculateBattleStat,
  calculateBattleStatPreStage,
  DEFAULT_STAT_STAGE,
  defaultDefendingStat,
  defensePreModify,
  noPositiveStatStages,
  spAttackPreModify,
  spDefensePreModify,
  type CalcStatInputs,
  type PreStageStat,
} from './battleStat'
import { applyStatStage } from './stats'
import {
  applyAngelsWrathBasePower,
  applyMoveBehaviorDamage,
  applyMoveSpecificBasePower,
  applyPreModifierBasePower,
  calcMoveBasePowerAfterModifiers,
  MAGNITUDE_PROBABILITY_PERCENT,
  percentToModifier,
  UNMODELLED_BASE_POWER_EFFECTS,
  weatherBallType,
  type BasePowerModifierContext,
  type MoveBehaviors,
} from './basePower'
import { calcFinalDamage, defaultFinalDamageStages } from './finalDamage'
import { resolveHitPlan } from './multiHit'
import { calcCritStage, critChanceDenominator, NEVER_CRIT, type CritStageInputs } from './crit'
import { distinctDefendingTypes, type TypeChart, type TypeModifierInputs } from './typeEffectiveness'
import {
  abilityCoverageNote,
  computeAbilityCritBonus,
  computeAbilityMultiplier,
  computeAfterTypeEffectiveness,
  computeAttackerHasMoldBreaker,
  computeIsAbsorbed,
  computeIsImmune,
  computeTypeEffectivenessWithAbilities,
  computeInfiltratesScreens,
  computeChooseDefensiveStat,
  computeChooseOffensiveStat,
  computeOnStatModifier,
  computeSwapSplit,
  hasFlag,
  hasStabOverride,
  isIronFistBoosted,
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
  /** EFFECT_CHANGE_TYPE_ON_ITEM's own argument (GetMoveTypeInternal,
   * src/battle_main.c:5047-5049,5148-5150) -- the HOLD_EFFECT_* the attacker must
   * hold for this move's type to follow the item instead of its declared type
   * (Judgment/HOLD_EFFECT_PLATE, Multi-Attack/HOLD_EFFECT_MEMORY). `null` for
   * every other move; narrowed from Move.argument's full 6-way union since this is
   * the only shape this specific mechanism needs. */
  changeTypeHoldEffect: string | null
  /** EFFECT_MISC_HIT's own argument (CalcMoveBasePower's argument switch,
   * src/battle_util.c:6884-6907) -- narrowed from Move.argument's full union to
   * just its bare `misc` value the same way changeTypeHoldEffect narrows `other`.
   * Only the deterministic single-snapshot sub-cases are consumed (see
   * basePower.ts's applyMiscHitBasePower); `null` for every non-misc-argument move. */
  miscEffect: string | null
  /** EFFECT_DOUBLE_HIT's own argument (GetMultihitType, src/battle_script_commands.c:
   * 1063-1064) -- MULTIHIT_THREE when 3, MULTIHIT_TWO (the default) otherwise.
   * Narrowed from Move.argument's `int` variant. `null` for every other move. */
  multiHitArgument: number | null
}

export interface DamageCalcScenario {
  move: MoveData
  attacker: BattlerBattleState
  defender: BattlerBattleState
  field: FieldBattleState
  typeChart: TypeChart
  /** sInverseTypeEffectivenessTable (battle_util.c:1015) -- a separate hand-written
   * chart GetTypeModifier selects instead of `typeChart` under Inverse Room/Miracle
   * Eye/B_FLAG_INVERSE_BATTLE (see resolveTypeEffectiveness below). Not derivable
   * from `typeChart` itself -- see typechart.py's own module doc on the pipeline
   * side for why. */
  inverseTypeChart: TypeChart
  moveBehaviors: MoveBehaviors
  battleConstants: BattleConstants
  /** UI-supplied context for the handful of turn-order/turn-history facts a static
   * calculator can't derive on its own -- see types.ts's DamageContext doc. */
  attackerActsFirst: boolean
  sameMoveTurnsInARow: number
  /** The hit count for a VARIABLE multi-hit move (EFFECT_MULTI_HIT's own 2-5
   * spread without Skill Link, or a Parental-Bond-family TWO_TO_FIVE trigger) --
   * this engine can't simulate the real RNG (2/2/3/3/4/5 weighted for the ability
   * version, `2 + Random()%2 + 2*(Random()%3==0)` for the move version), so it's a
   * scenario toggle like sameMoveTurnsInARow, clamped into the move's own valid
   * range at resolution time (see multiHit.ts). Ignored for fixed-count moves
   * (Double Hit, Population Bomb, Skill Link/Loaded Dice overrides, ...). */
  hitCount: number
  /** See DamageContext.defenderIsSwitching's own doc (EFFECT_PURSUIT). */
  defenderIsSwitching: boolean
  /** See DamageContext.magnitudeTier's own doc (EFFECT_MAGNITUDE). */
  magnitudeTier: 4 | 5 | 6 | 7 | 8 | 9 | 10 | null
  /** See DamageContext.attackerRolloutCounter's own doc (EFFECT_ROLLOUT). */
  attackerRolloutCounter: 0 | 1 | 2 | 3
  /** See DamageContext.attackerHasDefenseCurl's own doc (EFFECT_ROLLOUT). */
  attackerHasDefenseCurl: boolean
  /** See DamageContext.attackerWasHitThisTurn's own doc (EFFECT_FOCUS_PUNCH,
   * MOVE_SELF_DESTRUCT). */
  attackerWasHitThisTurn: boolean
  /** See DamageContext.beatUpBaseAttack's own doc (EFFECT_BEAT_UP). */
  beatUpBaseAttack: number
  /** See DamageContext.beatUpHitCount's own doc (EFFECT_BEAT_UP). */
  beatUpHitCount: number
  /** gRoundStructs[battlerDef].glaiveRush (battle_util.c:7704) -- whether the
   * DEFENDER used Glaive Rush earlier this same turn (its own move effect sets
   * this on itself, making it take double damage from the next hit it takes
   * this turn). A real gap found auditing CalcFinalDmg: finalDamage.ts already
   * had a glaiveRushActive stage, but nothing in this pipeline ever set it to
   * true -- it was permanently dead despite looking wired. A plain per-turn
   * scenario fact, same shape as attackerWasHitThisTurn. */
  defenderUsedGlaiveRush: boolean
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
  /** null for a move that only ever hits once. Otherwise the resolved hit count
   * (Double Hit's 2, Population Bomb's 10, a variable EFFECT_MULTI_HIT/Parental
   * Bond TWO_TO_FIVE spread clamped from the scenario's own hitCount toggle, ...)
   * -- see multiHit.ts. */
  hitCount: number | null
  /** Sum of ALL hits' damage at each of the 16 roll percentiles, reusing `rolls`
   * for the first hit and computing each subsequent hit (with its own
   * hitModifier, see multiHit.ts) at the SAME assumed roll percentile as the
   * first -- each hit independently draws its own 85-100% roll in the real game,
   * so this is a deliberate simplification giving valid min/max bounds on the
   * total, not the true combined distribution's shape in between. `null` when
   * hitCount is null. */
  totalRolls: number[] | null
  /** Same shape as totalRolls but with every hit forced to crit -- an upper
   * bound (in reality each hit rolls its own independent crit chance), not
   * "the expected total with critical hits factored in". `null` when hitCount is
   * null, or when the move can never crit at all (critRolls is also null then). */
  totalCritRolls: number[] | null
  /** IsAbilityOnSide(battlerDef, BAD_LUCK/BAD_OMEN), battle_util.c:7815-7817 --
   * when true, the real game's random roll is FORCED to 15 (the worst/minimum
   * of the 16), so `rolls[0]`/`totalRolls[0]` (and the matching crit row) are
   * the only value that can actually occur -- the rest of the range shown is
   * unreachable while this holds, not a real spread. A UI-level framing flag,
   * not a fixed-up number: every value in `rolls` is still independently
   * correct for what it represents. Suppression uses only the cheap, already-
   * ported onMoldBreaker abilities (via computeAttackerHasMoldBreaker with no
   * type/crit context) rather than fully re-deriving the 5 hypothesis-based
   * ones (Deadly Precision et al.) -- an attacker holding one of those AND a
   * defender holding Bad Luck/Bad Omen at once is an extreme enough edge case
   * that this simplification was chosen over duplicating that machinery here. */
  isForcedMinRoll: boolean
}

function toDamageContext(scenario: DamageCalcScenario): DamageContext {
  return {
    attacker: scenario.attacker.condition,
    defender: scenario.defender.condition,
    field: scenario.field,
    attackerActsFirst: scenario.attackerActsFirst,
    sameMoveTurnsInARow: scenario.sameMoveTurnsInARow,
    defenderIsSwitching: scenario.defenderIsSwitching,
    magnitudeTier: scenario.magnitudeTier,
    attackerRolloutCounter: scenario.attackerRolloutCounter,
    attackerHasDefenseCurl: scenario.attackerHasDefenseCurl,
    attackerWasHitThisTurn: scenario.attackerWasHitThisTurn,
    beatUpBaseAttack: scenario.beatUpBaseAttack,
    beatUpHitCount: scenario.beatUpHitCount,
  }
}

/** GetBattleMoveSplit / SetSwapDamageCategory's non-ability-hook branches
 * (src/battle_util.c:7341-7381). Ties (equal computed stats) are resolved to
 * PHYSICAL rather than the C's `Random() % 2` -- a static calculator reports one
 * scenario per call, not a coin flip. USE_LOWEST_DEFENSE is never handled by the C
 * itself (falls through to the `default` branch, i.e. behaves like USE_BASE_SPLIT) --
 * reproduced here rather than treated as an error.
 *
 * The `default` branch also runs the onSwapSplit ability census
 * (SetSwapDamageCategory's `ON_ABILITY` loop, src/battle_util.c:7344-7346) --
 * Mystic Blades/Energized Horns/Mythical Arrows/Best Offense/Pony Power/Magus
 * Blades/Sinister Claws, ported in 17-crit-swapsplit-misc.ts and 10-aliases.ts but
 * previously never dispatched from here (audit gap, same shape as the
 * onTypeEffectiveness/onAfterTypeEffectiveness fix above). USE_HIGHEST_OFFENSE/
 * USE_HIGHEST_DAMAGE are separate C branches that never reach ON_ABILITY at all, so
 * the ability census is only consulted for the `default` case here too. */
function resolveSplit(scenario: DamageCalcScenario, rawStats: { atk: number; spatk: number; def: number; spdef: number }): 'PHYSICAL' | 'SPECIAL' {
  const base = scenario.move.split === 'SPECIAL' ? 'SPECIAL' : 'PHYSICAL'
  let split: 'PHYSICAL' | 'SPECIAL' = base

  if (scenario.move.splitFlag === 'USE_HIGHEST_OFFENSE') {
    split = rawStats.atk > rawStats.spatk ? 'PHYSICAL' : rawStats.atk < rawStats.spatk ? 'SPECIAL' : base
  } else if (scenario.move.splitFlag === 'USE_HIGHEST_DAMAGE') {
    const physicalScore = rawStats.atk * rawStats.spdef
    const specialScore = rawStats.spatk * rawStats.def
    split = physicalScore > specialScore ? 'PHYSICAL' : physicalScore < specialScore ? 'SPECIAL' : base
  } else {
    const moveType = scenario.move.type ?? 'NORMAL'
    const swap = computeSwapSplit(scenario.attacker.abilitySlots, {
      battlerId: 'attacker',
      moveId: scenario.move.id,
      moveType,
      moveSplit: split,
      moveFlags: scenario.move.flags,
    })
    if (swap) split = split === 'PHYSICAL' ? 'SPECIAL' : 'PHYSICAL'
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

/**
 * isWonderRoomActive()'s ATK<->SPATK swap, battle_util.c:7111-7116 -- reassigns the
 * C's own local `statEnum` BEFORE the switch that picks the raw stat field AND
 * BEFORE the per-stat pre-modifier branch (burn/violentRush for ATK vs
 * rapidResponse/frostbite for SPATK) runs, so under Wonder Room a "physical attack"
 * computation genuinely reads SpAtk's raw stat and SpAtk's own status modifiers --
 * not just SpAtk's number substituted into ATK's modifier branch. ER swaps the
 * OFFENSIVE stats only (not Def/SpDef, unlike mainline). Applies independently to
 * EVERY CalculateStat call, including each secondary-stat blend's own recursive
 * lookup (:7199 recurses with the SAME statEnum swap re-applied at the top of that
 * call) -- which is why this lives inside computeStat itself (called for both the
 * primary stat and, via applySecondaryStatBlend's computeOther closure, each
 * secondary one) rather than being applied once by computeAttackStat/
 * computeDefenseStat before calling in.
 */
function wonderRoomStatSwap(stat: BattleStatKey, isWonderRoomActive: boolean): BattleStatKey {
  if (!isWonderRoomActive) return stat
  if (stat === 'atk') return 'spatk'
  if (stat === 'spatk') return 'atk'
  return stat
}

/** Builds CalculateStat's own input record for one (battler, stat) pair -- raw stat
 * selection, per-stat pre-modifier, ability onStat hooks, and everything else
 * CalcStatInputs needs. Shared by computeStat (the ordinary, fully-scaled result) and
 * computeStatPreStage (the split-out pre-stage-only result applySecondaryStatBlend
 * needs), so the two can never drift apart on how a stat's inputs are assembled. */
function buildCalcStatInputs(opts: ComputeStatOptions): CalcStatInputs {
  const { battler, move, field } = opts
  // See wonderRoomStatSwap's own doc -- from here down, `stat` is the (possibly
  // swapped) value CalculateStat's own body actually keys every branch off of; the
  // ability onStat hook's statId (OnStatContext.isHighestAttackingStat's own doc:
  // "GetHighestAttackingStatId(battler) == statId") is defined in terms of this
  // same post-swap value, matching the C's own onStat loop running AFTER the swap.
  const stat = wonderRoomStatSwap(opts.stat, opts.isWonderRoomActive)
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

  return {
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
      isMegaEvolved: battler.condition.isMegaEvolved,
    }),
    secondaryStatPercent: 0, // the OWN-stat self-buff variant (secondaryStat[statEnum]) -- no ability in the census ever targets its own chosen stat this way, so this stays 0; see applySecondaryStatBlend for the (used) other-stat blend
    statStageRatios: opts.statStageRatios,
  }
}

/** The parts of CalculateStat this engine can run without the ability registry:
 * raw stat selection, the per-stat pre-modifiers, stat-stage clamping, and the stage
 * ratio + extra-stat-level application. `onStat` hooks and the secondary-stat blend
 * are the identity/0 default documented in battleStat.ts. Used for every "other"
 * stat a blend reads (via applySecondaryStatBlend's `computeOther`) and for a
 * primary stat that has no blend to combine with at all -- either way, this is
 * CalculateStat's normal one-shot, fully-scaled result. */
function computeStat(opts: ComputeStatOptions): number {
  return calculateBattleStat(buildCalcStatInputs(opts))
}

/** A PreStageStat plus the two tail inputs (applyStatTail's own remaining
 * parameters) needed to finish it later -- what computeStatPreStage returns and
 * what applySecondaryStatBlend's primary argument is. */
interface PrimaryPreStage extends PreStageStat {
  statStageRatios: [number, number][]
  extraStatLevel: number
}

/** The split, PRE-stage form of computeStat -- see calculateBattleStatPreStage's own
 * doc. Returns everything applySecondaryStatBlend needs to combine this stat's
 * pre-stage value with any blend terms before running the stage ratio/extraStatLevel
 * tail exactly once, matching :7196-7211's own order. */
function computeStatPreStage(opts: ComputeStatOptions): PrimaryPreStage {
  const inputs = buildCalcStatInputs(opts)
  const pre = calculateBattleStatPreStage(inputs)
  return { ...pre, statStageRatios: inputs.statStageRatios, extraStatLevel: inputs.extraStatLevel }
}

/**
 * CalculateStat's cross-stat blend (:7196-7211; the ChosenStat doc in dispatchCalc.ts
 * cited the wrong range too -- fixed alongside this one): each OTHER stat named in
 * secondaryStat contributes `floor(thatStat'sFullValue * percent / 100)`, summed with
 * the primary's own PRE-stage value, with the stat-stage ratio (and, except for
 * Speed's own branch below, extraStatLevel) applied to that combined sum exactly
 * once -- NOT to the primary and each blend term independently before summing.
 * `thatStat'sFullValue` (`computeOther`) is a normal, fully-scaled computeStat call,
 * matching the C's own recursive `CalculateStat(..., calculatingSecondary=TRUE)`,
 * which skips the whole cross-stat-blend block itself (:7191) and so is unaffected by
 * this same combine-then-scale distinction -- only the PRIMARY's own contribution
 * needs it, which is why `primary` here is a `PreStageStat` (from computeStatPreStage)
 * rather than a plain number.
 *
 * An earlier version of this function took the primary as an already-fully-scaled
 * number and simply added each (already independently fully-scaled) blend term on
 * top. That is wrong whenever the primary's own stat stage isn't neutral: the C
 * scales the COMBINED sum by the primary's ratio, so an ordinary boosted attacker
 * (Swords Dance, say) with any blend ability active on a contact move should see the
 * blend's own contribution grow with the boost too, and didn't. Measured with a
 * probe (Garchomp + Juggernaut vs Skarmory, Tackle): the old code gave 66 for the top
 * roll at +6 Atk where a faithful port gives about 72, and the gap widens with the
 * blend percentage. This was already the shape of the bug before the Speed branch
 * below was added -- that regression was narrower (Speed only, and only when
 * secondaryStat also targets Speed) but of the same kind, and is what motivated
 * splitting calculateBattleStat into pre-stage/tail in the first place.
 *
 * `primaryStatKey` mirrors the C's own `FILTER(i != statEnum)` (:7197): the primary
 * stat's own entry in `secondaryStat` (if any) is skipped by the general loop below,
 * not blended in a second time. Callers must pass the POST-Wonder-Room-swap key (i.e.
 * run it through wonderRoomStatSwap first), matching `statEnum`'s own value at :7197
 * -- C reassigns `statEnum` for the swap at :7111-7116, before this filter runs.
 *
 * Speed is the one key where a same-stat entry is NOT simply dropped. CalculateStat's
 * self-buff branch (:7192-7194, `secondaryStat[statEnum]`, the always-0
 * `secondaryStatPercent` in buildCalcStatInputs) explicitly EXCLUDES STAT_SPEED
 * (`statEnum != STAT_SPEED`), so a Speed-primary calculation never gets that ratio
 * boost -- instead, :7202-7207 gives Speed its own separate branch: stage-scale the
 * (already blend-summed) value WITHOUT extraStatLevel, add
 * `secondaryStat[STAT_SPEED]` percent of Speed's own fully-scaled value, and return
 * immediately, skipping :7212-7214's extraStatLevel step entirely -- which is why
 * this branch calls `applyStatStage` directly instead of running the shared tail.
 * Reachable today via Momentum (onChooseOffensiveStat: `statToUse = 'spe'` on a
 * contact move) plus Speed Force (`secondaryStat.spe += 20` on a contact move) both
 * firing on the same hit. By id, not display name -- this project's species data has
 * distinct entries sharing a display name, and an earlier count of this census was
 * taken by name, silently merging forms: SPECIES_SKARMORY_MEGA_REDUX (not base
 * Skarmory) and SPECIES_ELECTRODE_HISUIAN (not base Electrode) are the two that
 * actually carry both, alongside SPECIES_ZIGZAGOON, SPECIES_ZEBSTRIKA,
 * SPECIES_WATTREL and SPECIES_KILOWATTREL. Blur/Elude (onChooseDefensiveStat,
 * `statToUse = 'spe'`) plus Sleek Scales (`secondaryStat.spe += 15`,
 * APPLY_ON_TARGET) reach the same branch on the DEFENSE side too -- code-reachable,
 * but not currently data-reachable: Sleek Scales belongs to exactly one species,
 * Garchomp, which has neither Blur nor Elude, and none of the 21 species with Blur
 * or Elude have Sleek Scales.
 */
function applySecondaryStatBlend(
  primary: PrimaryPreStage,
  secondaryStat: Partial<Record<BattleStatKey, number>>,
  computeOther: (stat: BattleStatKey) => number,
  primaryStatKey: BattleStatKey,
): number {
  let total = primary.value
  for (const [stat, percent] of Object.entries(secondaryStat) as [BattleStatKey, number][]) {
    if (!percent || stat === primaryStatKey) continue
    total += idiv(computeOther(stat) * percent, 100)
  }

  const speedPercent = primaryStatKey === 'spe' ? secondaryStat.spe : undefined
  if (speedPercent) {
    return applyStatStage(total, primary.stage, primary.statStageRatios) + idiv(computeOther('spe') * speedPercent, 100)
  }

  return applyStatTail(total, primary.stage, primary.statStageRatios, primary.extraStatLevel)
}

function computeAttackStat(
  scenario: DamageCalcScenario,
  split: 'PHYSICAL' | 'SPECIAL',
  isCrit: boolean,
  statStageRatios: [number, number][],
  // Passed in from calcInternal's own single, already-resolved decision (which
  // itself may depend on Deadly Precision/Flawless Precision/Mach 3/Overrule/
  // Stonecutter's hypothetical checks) -- Mold Breaker is one uniform flag for
  // the whole hit, so this must NOT be recomputed independently here (it used to
  // be, harmlessly for the 5 simple onMoldBreaker abilities since they don't
  // need extra context, but would silently disagree with calcInternal's own
  // value for the 5 hypothesis-based ones once those needed real context to
  // decide).
  attackerHasMoldBreaker: boolean,
) {
  const { attacker, defender, move, field } = scenario
  const unmodelled: string[] = []

  // EFFECT_LASH_OUT forces isCrit=true for the attacker's own stat calc (:7252).
  const forcedCrit = move.effect === 'EFFECT_LASH_OUT' ? true : isCrit
  // EFFECT_FOUL_PLAY uses the DEFENDER's stat and Unaware check instead (:7254-7256).
  const isFoulPlay = move.effect === 'EFFECT_FOUL_PLAY'
  const statBattler = isFoulPlay ? defender : attacker
  const isBodyPress = move.effect === 'EFFECT_BODY_PRESS'
  const defaultAtkStat: BattleStatKey = isBodyPress ? 'def' : split === 'PHYSICAL' ? 'atk' : 'spatk'
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
    computeStatPreStage({ battler: statBattler, opponent: statOpponent, stat: atkStat, move, isAttackRole: true, isCrit: forcedCrit, isWonderRoomActive: field.isWonderRoomActive, field, statStageRatios }),
    atkSecondaryStat,
    (stat) => computeStat({ battler: statBattler, opponent: statOpponent, stat, move, isAttackRole: true, isCrit: forcedCrit, isWonderRoomActive: field.isWonderRoomActive, field, statStageRatios }),
    wonderRoomStatSwap(atkStat, field.isWonderRoomActive),
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
    computeStatPreStage({ battler: defender, opponent: attacker, stat: defStat, move, isAttackRole: false, isCrit: noPositive, isWonderRoomActive: scenario.field.isWonderRoomActive, field: scenario.field, statStageRatios }),
    defSecondaryStat,
    (stat) =>
      computeStat({ battler: defender, opponent: attacker, stat, move, isAttackRole: false, isCrit: noPositive, isWonderRoomActive: scenario.field.isWonderRoomActive, field: scenario.field, statStageRatios }),
    wonderRoomStatSwap(defStat, scenario.field.isWonderRoomActive),
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

/** Lucky Punch's exact species list (src/battle_script_commands.c:1551-1556) --
 * GET_BASE_SPECIES_ID(species) checked against Happiny/Chansey/Blissey AND their
 * Redux forms individually, not a single collapsed base id (same "list each family
 * member explicitly" shape as battleStat.ts's LIGHT_BALL_MULTIPLIER). The Redux
 * entries are redundant under this pipeline's own baseSpeciesId (which already
 * collapses SPECIES_CHANSEY_REDUX's formOf back to SPECIES_CHANSEY -- see
 * BattlerBattleState.condition.baseSpeciesId's doc), but kept for parity with the
 * C's own explicit list in case that collapsing rule ever changes. */
const LUCKY_PUNCH_SPECIES = new Set([
  'SPECIES_HAPPINY',
  'SPECIES_CHANSEY',
  'SPECIES_HAPPINY_REDUX',
  'SPECIES_CHANSEY_REDUX',
  'SPECIES_BLISSEY_REDUX',
  'SPECIES_BLISSEY',
])

/** CalcCritChanceStage's non-ability inputs (src/battle_script_commands.c:1523-1558),
 * built once per scenario since none of it depends on the evaluated type or a
 * particular damage roll. */
function scenarioCritStageInputs(scenario: DamageCalcScenario): CritStageInputs {
  const { attacker, defender, move, field } = scenario
  // isForcedCrit: true -- this is calculateMoveDamage's own top-level "can this
  // move crit AT ALL" gate (scenarioCritDenominator), not one specific hit's
  // forceCrit row, so it asks Overrule's own question directly: "in a
  // hypothetical crit scenario, would Mold Breaker be active for this attacker"
  // -- exactly what's needed to decide whether an otherwise-NEVER_CRIT block
  // (Battle Armor/Shell Armor) should really still apply. moveType/
  // hypotheticalTypeEffectiveness are null here (no specific type is in scope at
  // this call site) -- see OnMoldBreakerContext's own doc on that tradeoff.
  const attackerHasMoldBreaker = computeAttackerHasMoldBreaker(attacker.abilitySlots, move.id, move.split ?? 'STATUS', null, null, true)
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
    attacker.condition.speciesId,
    defender.condition.speciesId,
  )
  return {
    // NEVER_CRIT from an onCrit hook (e.g. Battle Armor/Shell Armor) folds into the
    // same "blocked" outcome as Lucky Chant -- both mean "this hit can never crit".
    isBlocked: field.sides.defender.luckyChant || abilityBonus === NEVER_CRIT,
    isGuaranteed: move.crit === 'ALWAYS',
    abilityCritBonus: abilityBonus === NEVER_CRIT ? 0 : abilityBonus,
    hasHighCritFlag: move.crit === 'HIGH',
    hasScopeLens: attacker.condition.resolvedHoldEffect === 'HOLD_EFFECT_SCOPE_LENS',
    hasLuckyPunchOnChanseyLine:
      attacker.condition.resolvedHoldEffect === 'HOLD_EFFECT_LUCKY_PUNCH' && LUCKY_PUNCH_SPECIES.has(attacker.condition.baseSpeciesId),
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

/**
 * The grounding + type-chart-fold + onAfterTypeEffectiveness pipeline
 * (battle_util.c:6672-6701 grounding, MulByTypeEffectiveness/
 * CalcTypeEffectivenessMultiplierInternal for the fold+after-hooks), factored out
 * of calcInternal so it can be run TWICE per hit: once hypothetically with Mold
 * Breaker forced active (Deadly Precision/Flawless Precision/Mach 3/Stonecutter's
 * own onMoldBreaker condition, see OnMoldBreakerContext's doc), and once for real
 * with whichever attackerHasMoldBreaker value that hypothesis (plus every other
 * onMoldBreaker ability) actually resolves to.
 *
 * Real bug found auditing this: CalcTypeEffectivenessMultiplier
 * (battle_util.c:8015-8021) skips the ENTIRE fold for MOVE_STRUGGLE
 * unconditionally (`if (move != MOVE_STRUGGLE && IsValidType(moveType))`),
 * leaving it flat at neutral (1.0) -- no resistance, no immunity, no
 * super-effectiveness, regardless of its own declared type. This engine's data
 * gives Struggle a real declared type (TYPE_NORMAL, unlike vanilla Pokemon's
 * internal typeless/MYSTERY representation), so without this special case
 * Struggle was silently being resisted by Rock/Steel/Ghost and OUTRIGHT
 * IMMUNE against pure Ghost-type defenders -- a real, live bug for a move
 * every single Pokemon can use.
 */
function resolveTypeEffectiveness(scenario: DamageCalcScenario, moveType: string, defenderTypes: string[], attackerHasMoldBreaker: boolean): number {
  if (scenario.move.id === 'MOVE_STRUGGLE') return uq(1.0)
  const { attacker, defender, move, field, typeChart } = scenario
  // isGrounded mirrors IsBattlerGroundedIgnoreType (:6699-6701), which checks
  // CheckGroundingEffects (:6672-6685) FIRST -- Iron Ball or Gravity forces
  // grounded regardless of type/ability, short-circuiting the rest of the check
  // entirely (Ingrain/Smacked Down are volatile-status effects with no scenario
  // field here and stay unmodelled). Only when neither applies does
  // CheckLevitatingEffects (:6687-6695) get a say: defender.isGrounded is the
  // species-only baseline (Flying-type is airborne; scenario.ts builds it with no
  // ability knowledge), further overridden airborne by Levitate or Air Balloon
  // (Magnet Rise/Telekinesis are also volatile-status, same gap as above).
  //
  // CORRECTION (this session's own later audit): an earlier version of this
  // comment claimed Gravity/Iron Ball never override a naturally Flying-typed
  // defender's own chart-based Ground immunity -- that was wrong, based on an
  // incomplete IsGravityActive call-site grep that missed battle_util.c:7902,
  // reached via IsBattlerGrounded (not IsGravityActive directly). They DO
  // restore it, but only via a separate, PER-COMPONENT check
  // (dispatchCalc.ts's resolveTypeEffectivenessComponent, fed
  // isForcedGrounded below) distinct from this WHOLE-modifier isGrounded
  // override, which stays ability/item-only (IsBattlerGroundedIgnoreType,
  // genuinely type-blind) as originally described.
  const isForcedGrounded = defender.condition.resolvedHoldEffect === 'HOLD_EFFECT_IRON_BALL' || field.gravityActive
  const isForcedAirborne =
    !isForcedGrounded && (defender.condition.resolvedHoldEffect === 'HOLD_EFFECT_AIR_BALLOON' || hasFlag(defender.abilitySlots, 'levitate', attackerHasMoldBreaker))
  const isGrounded = isForcedGrounded || (defender.isGrounded && !isForcedAirborne)
  const ringTargetHeld = defender.condition.resolvedHoldEffect === 'HOLD_EFFECT_RING_TARGET'
  // UpdateTypeModifier's own two fields (battle_util.c:7904), codegen'd from
  // moveBehaviors.json's attack.superEffectiveVs/attack.ignoreTypeImmunity --
  // real gap found auditing this: both were already declared on
  // MoveBehaviorAttack but never read anywhere (Freeze-Dry/Sheer Cold vs Water,
  // Dragon Rage bypassing Fairy's chart immunity to Dragon).
  const moveBehaviorAttack = move.effect ? scenario.moveBehaviors[move.effect]?.attack : undefined
  // superEffectiveVs is the raw proto enum name (e.g. "TYPE_WATER"), like
  // move.type/type2 before scenario.ts's own bareType() strips them -- stripped
  // here directly since moveBehaviors is passed through as a raw blob with no
  // per-field processing (see scenario.ts's own comment on why holdEffectType
  // needed the same fix).
  const superEffectiveVsType = moveBehaviorAttack?.superEffectiveVs ? moveBehaviorAttack.superEffectiveVs.replace('TYPE_', '') : null
  const ignoreTypeImmunity = Boolean(moveBehaviorAttack?.ignoreTypeImmunity)
  // GetTypeModifier's own toggle inputs (battle_util.c:8021-8038) -- see
  // TypeModifierInputs's own doc (typeEffectiveness.ts) for the XOR semantics and
  // the separate Dark-vs-Psychic special case.
  const typeModifierInputs: TypeModifierInputs = {
    isInverseRoomActive: field.isInverseRoomActive,
    isInverseBattleFlagSet: field.isInverseBattleFlagSet,
    attackerHasMiracleEye: attacker.hasMiracleEye,
    defenderHasMiracleEye: defender.hasMiracleEye,
  }
  const typeFold = computeTypeEffectivenessWithAbilities(
    attacker.abilitySlots,
    moveType,
    defenderTypes,
    typeChart,
    'attacker',
    'defender',
    move.id,
    ringTargetHeld,
    isForcedGrounded,
    superEffectiveVsType,
    ignoreTypeImmunity,
    scenario.inverseTypeChart,
    typeModifierInputs,
  )
  // The post-fold Ground/grounded override (battle_util.c:7973-7977) -- same check
  // calcTypeEffectiveness's own isGrounded param applies, done manually here since
  // this call site needs the raw fold result for onAfterTypeEffectiveness's own
  // perTypeModifiers/targetGrounded fields below.
  let typeEffectivenessBeforeAfterHooks = typeFold.modifier
  if (typeEffectivenessBeforeAfterHooks !== 0 && moveType === 'GROUND' && !isGrounded) typeEffectivenessBeforeAfterHooks = 0
  // Thousand Arrows-style "ignoresLevitation" moves (battle_util.c:7981-7984,
  // FLAG_DMG_UNGROUNDED_IGNORE_TYPE_IF_FLYING) restore the WHOLE modifier to
  // neutral whenever it's flatly zero for an airborne target -- unlike the
  // grounding-based restore above (isGrounded, ability/item-only), this one
  // punches through even a NATURALLY Flying-typed target's own chart immunity,
  // which is the whole point of the move. Checked AFTER the grounding override
  // above (not independently re-deriving "is this target airborne"): if the
  // target were forcibly grounded (Iron Ball/Gravity), the per-component fold
  // below already restores the real chart value before this point is ever
  // reached, so modifier isn't 0 to begin with -- matching the C's own
  // (redundant-looking, but consistent) `!IsBattlerGrounded` guard.
  if (moveType === 'GROUND' && move.flags.ignoresLevitation && typeEffectivenessBeforeAfterHooks === 0) typeEffectivenessBeforeAfterHooks = uq(1.0)
  return computeAfterTypeEffectiveness(attacker.abilitySlots, defender.abilitySlots, attackerHasMoldBreaker, {
    attackerId: 'attacker',
    defenderId: 'defender',
    moveId: move.id,
    moveType,
    moveFlags: move.flags,
    modifier: typeEffectivenessBeforeAfterHooks,
    perTypeModifiers: typeFold.perTypeModifiers,
    defenderTypes,
    weather: field.weather,
    targetGrounded: isGrounded,
    defenderAtMaxHp: defender.condition.hp === defender.condition.maxHp,
    defenderAbilityOn: defender.abilityOn,
  })
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
  // UQ_4_12 -- GetParentalBondMultiplier's own return, folded into CalcFinalDmg's
  // stage #10 EXACTLY where the C applies it (finalDamage.ts's own
  // parentalBondMultiplier stage). uq(1.0) for the first/only hit of any move and
  // for every hit of a move's OWN multi-hit effect (Population Bomb, Double Hit,
  // ...), which never scale power per hit -- only a Parental-Bond-family bonus hit
  // uses anything else. See multiHit.ts's resolveHitPlan.
  hitModifier: number,
  /** Which hit (0-indexed) of the current move use this is -- Triple Kick/Triple
   * Axel's own base-power scaling reads this directly (applyPreModifierBasePower),
   * unlike hitModifier which is a FINAL-stage multiplier. 0 for every non-multi-hit
   * move and for every hit of a move whose OWN scaling isn't hit-index-based. */
  hitIndex: number = 0,
): { dmg: number; typeEffectiveness: number; resolvedMoveType: string; unmodelled: string[] } {
  const unmodelled: string[] = []
  const { attacker, defender, move, field, moveBehaviors, battleConstants } = scenario
  const statStageRatios = battleConstants.statStageRatios

  const attackerHasAuroraBorealis = battlerHasAbility(attacker.abilitySlots, 'ABILITY_AURORA_BOREALIS', () => false)

  // EFFECT_CHANGE_TYPE_ON_ITEM (Judgment/Plate, Multi-Attack/Memory),
  // EFFECT_NATURAL_GIFT, and EFFECT_WEATHER_BALL are all checked FIRST and, when
  // they apply, short-circuit the whole rest of GetMoveTypeInternal -- an -ate
  // ability never gets a chance to run (src/battle_main.c:5047-5049,5124-5133,
  // 5148-5150,5180-5182, each switch case in that function returns immediately on
  // match). When none applies, this falls through exactly like the C's `break`
  // does, leaving the move at its declared type for the ability loop below.
  if (move.effect === 'EFFECT_HIDDEN_POWER' && attacker.hiddenPowerType === null) {
    unmodelled.push(`${move.id}: type depends on Hidden Power type, not set on the attacker -- defaulting to its declared (Normal) type`)
  }
  const itemMoveType =
    move.changeTypeHoldEffect !== null && attacker.condition.resolvedHoldEffect === move.changeTypeHoldEffect
      ? (attacker.holdEffectType ?? inputMoveType)
      : move.effect === 'EFFECT_NATURAL_GIFT' && attacker.naturalGift !== null
        ? attacker.naturalGift.type
        : move.effect === 'EFFECT_WEATHER_BALL'
          ? weatherBallType(field.weather, attackerHasAuroraBorealis)
          : move.effect === 'EFFECT_HIDDEN_POWER' && attacker.hiddenPowerType !== null
            ? attacker.hiddenPowerType
            : null

  // "-ate" abilities (Pixilate, Aerilate, Refrigerate, ...) override a Normal-type
  // move's type BEFORE anything else runs -- type effectiveness, STAB, and the
  // terrain-boost base-power check all key off the resolved type, not the move's
  // listed one (src/battle_main.c:5203-5211, GetMoveTypeInternal).
  const { moveType, ateBoost } =
    itemMoveType !== null ? { moveType: itemMoveType, ateBoost: false } : resolveEffectiveMoveType(attacker.abilitySlots, move.id, inputMoveType, move.flags)

  const defenderTypes = distinctDefendingTypes(defender.types)

  // Deadly Precision/Flawless Precision/Mach 3/Stonecutter's own onMoldBreaker
  // condition needs to know what type effectiveness WOULD be if Mold Breaker
  // were already active -- computed via the exact same pipeline the REAL value
  // below uses, just with Mold Breaker hardcoded true for this one hypothetical
  // evaluation (see OnMoldBreakerContext's own doc on why this isn't circular).
  const hypotheticalTypeEffectiveness = resolveTypeEffectiveness(scenario, moveType, defenderTypes, true)
  // Computed here (rather than down near computeAbilityMultiplier, as in the other two
  // calcInternal-adjacent call sites) because IsBattlerGroundedIgnoreType's Levitate
  // check (below) is itself checkMoldBreaker=TRUE (battle_util.c:6694,
  // RETURN_ABILITY_IF_FLAG(battlerId, TRUE, levitate)) and runs before type
  // effectiveness is known.
  // FLAG_TARGET_ABILITY_IGNORED (SetMoldBreaker, battle_script_commands.c:976-978)
  // -- a move's own ignoresAbility flag unconditionally forces Mold Breaker,
  // checked FIRST in the C before any ability-based onMoldBreaker check even
  // runs (order doesn't matter here since this is a plain OR).
  const attackerHasMoldBreaker =
    Boolean(move.flags.ignoresAbility) || computeAttackerHasMoldBreaker(attacker.abilitySlots, move.id, split, moveType, hypotheticalTypeEffectiveness, forceCrit)
  // Mold Breaker is a single, uniform flag for the whole hit regardless of WHICH
  // ability (if any) activated it -- once attackerHasMoldBreaker is true, the
  // hypothetical pass above (which forced it true) already IS the real value, no
  // need to recompute; only a false result needs a fresh (unforced) pass.
  const typeEffectiveness = attackerHasMoldBreaker ? hypotheticalTypeEffectiveness : resolveTypeEffectiveness(scenario, moveType, defenderTypes, false)
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
    defenderHasUnnerve: battlerHasAbility(defender.abilitySlots, 'ABILITY_UNNERVE', () => false),
    moveDoubleDamageVsMega: Boolean(move.flags.doubleDamageVsMega),
    moveEffect: move.effect,
    moveArgumentStatus: null, // EFFECT_DOUBLE_DMG_IF_STATUS1's argument -- caller can extend later
  }

  const behaviorResult = applyMoveBehaviorDamage(move.power, move.effect, moveBehaviors, toDamageContext(scenario))
  unmodelled.push(...behaviorResult.unmodelled)
  // "not modelled" alone, matching UNMODELLED_MISC_EFFECTS's own message shape
  // (basePower.ts) -- an earlier "(needs turn history)" suffix here was accurate
  // for some of this set's entries (Counter/Mirror Coat/Bide) but not others
  // (Super Fang/Endeavor/Final Gambit/etc. need a real, unported formula, not
  // turn-history state), so a single reason no longer fits every member.
  if (move.effect && UNMODELLED_BASE_POWER_EFFECTS.has(move.effect)) unmodelled.push(`${move.effect}: not modelled`)
  const preModifierResult = applyPreModifierBasePower(
    behaviorResult.power,
    move.effect,
    move.miscEffect,
    toDamageContext(scenario),
    attacker.alliesFainted,
    attacker.naturalGift?.power ?? null,
    attackerHasAuroraBorealis,
    hitIndex,
  )
  unmodelled.push(...preModifierResult.unmodelled)
  // Victory Bomb (src/abilities.cc:8980-8988): the real C queues a SEPARATE,
  // later, reversed-direction attack (UseOutOfTurnAttack, the holder retaliating
  // against its attacker once it faints) -- simulating that queue is out of
  // scope for this single-hit calculator (same class of gap as Glacial Rage's
  // own follow-up move, see this session's own scoping discussion). Reframed
  // instead as a directly-selectable "5th attack": selecting MOVE_EXPLOSION IS
  // the scenario, so the C's own UseOutOfTurnAttack override (declared power 250
  // -> 100 for that specific queued call) applies unconditionally here rather
  // than only inside a simulated queue. The matching Fire-type override is
  // ABILITY_VICTORY_BOMB's own onMoveType hook (ported normally,
  // 20-move-type-and-recoil.ts), whose condition is reinterpreted the same way.
  const victoryBombPower = move.id === 'MOVE_EXPLOSION' && battlerHasAbility(attacker.abilitySlots, 'ABILITY_VICTORY_BOMB', () => false) ? 100 : null
  // CalcMoveBasePower's move-ID-keyed tail switch (battle_util.c:6915-6952) --
  // see applyMoveSpecificBasePower/applyAngelsWrathBasePower's own doc.
  const moveSpecificPower = applyMoveSpecificBasePower(
    victoryBombPower ?? preModifierResult.power,
    move.id,
    attacker.condition.speciesId,
    (id) => battlerHasAbility(attacker.abilitySlots, id, () => false),
    defender.condition.status1,
    scenario.attackerWasHitThisTurn,
  )
  const angelsWrathPower = applyAngelsWrathBasePower(moveSpecificPower, move.id, battlerHasAbility(attacker.abilitySlots, 'ABILITY_ANGELS_WRATH', () => false))
  const power = calcMoveBasePowerAfterModifiers(Math.max(angelsWrathPower, 1), basePowerCtx)

  for (const id of [attacker.abilitySlots.ability, ...attacker.abilitySlots.innates, defender.abilitySlots.ability, ...defender.abilitySlots.innates]) {
    const note = abilityCoverageNote(id)
    if (note) unmodelled.push(note)
  }

  const atk = computeAttackStat(scenario, split, isCrit, statStageRatios, attackerHasMoldBreaker)
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
      attackerHasStab: stabInHalves(attacker.types, attacker.abilitySlots, defender.abilitySlots, moveType, attackerHasMoldBreaker, move.id) > 2,
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
      attackerSlowStartTimer: attacker.slowStartTimer,
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
      attackerTypes: attacker.types,
    },
    attackerHasMoldBreaker,
  )
  const finalResult = calcFinalDamage(dmg, {
    ...defaultFinalDamageStages({ typeEffectiveness }),
    abilityMultiplier,
    parentalBondMultiplier: hitModifier,
    // MISC_EFFECT_INCREASED_CRIT_DAMAGE moves crit for x2.0 instead of x1.5
    // (src/battle_util.c:7536-7540); move.argument threading isn't wired into
    // MoveData yet, so this is always the ordinary x1.5 for now.
    critMultiplier: isCrit ? 1.5 : null,
    weatherMultiplier: weatherDamageMultiplier(
      field.weather,
      move,
      moveType,
      battlerHasAbility(attacker.abilitySlots, 'ABILITY_WEATHER_DOUBLE_BOOST', () => false),
      battlerHasAbility(attacker.abilitySlots, 'ABILITY_NIKA', () => false),
    ),
    stabInHalves: stabInHalves(attacker.types, attacker.abilitySlots, defender.abilitySlots, moveType, attackerHasMoldBreaker, move.id),
    screensActive:
      !isCrit &&
      screensApply(field, split) &&
      !computeInfiltratesScreens(attacker.abilitySlots, { moveType, moveFlags: move.flags, moveSplit: move.split ?? 'STATUS', attackerTypes: attacker.types }),
    isDoubleBattle: field.isDoubleBattle,
    resistBerryMultiplier: resistBerryMultiplier(attacker.abilitySlots, defender, moveType, typeEffectiveness),
    attackerItemMultiplier: attackerFinalItemMultiplier(attacker, typeEffectiveness, scenario.sameMoveTurnsInARow, move.flags, split),
    // Real bug found auditing this: was checking only move.effect ===
    // 'EFFECT_MISC_HIT', which is true for ALL 8 current EFFECT_MISC_HIT moves
    // (MISC_EFFECT_FAINTED_MON_BOOST, _ELECTRIC_TERRAIN_BOOST, etc.), not just
    // the 2 that actually declare MISC_EFFECT_SUPEREFFECTIVE_BOOST
    // (battle_util.c:7711-7713) -- silently giving 6 unrelated moves an extra
    // 4/3x whenever they happened to be super effective.
    hasSuperEffectiveBoost: isSuperEffective && move.miscEffect === 'MISC_EFFECT_SUPEREFFECTIVE_BOOST',
    glaiveRushActive: scenario.defenderUsedGlaiveRush,
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
 * CORRECTION (this session's own later audit): an earlier version of this
 * comment claimed Struggle is typeless so the early return is a no-op --
 * wrong, this engine's own data gives Struggle a real declared type
 * (TYPE_NORMAL), so it's a genuine, necessary check (see resolveTypeEffectiveness's
 * own matching Struggle fix, and CalcTypeEffectivenessMultiplier's own
 * unconditional Struggle bypass, battle_util.c:8015-8021, which is why THIS
 * check and that one both special-case the same move independently).
 * IsAbilityOnFieldExcept scans every battler OTHER than the one computing STAB
 * (`i == battlerId` is skipped, battle_util.c:4839-4848); in this 2-battler v1
 * singles engine "every other battler" is just the defender, so the attacker's OWN
 * Relic Stone (if it somehow held one) would NOT suppress its own STAB, matching
 * the C exactly. Relic Stone has zero hooks of its own (`breakable` only) -- this
 * is a hardcoded special case, not something the ability registry can express.
 * Mold Breaker suppression of this field-wide effect IS modelled (the
 * attackerHasMoldBreaker parameter below), despite an even earlier version of
 * this comment also claiming otherwise.
 */
function stabInHalves(
  attackerTypes: string[],
  attackerSlots: AbilitySlots,
  defenderSlots: AbilitySlots,
  moveType: string,
  attackerHasMoldBreaker: boolean,
  moveId: string,
): 2 | 3 | 4 {
  // Real bug found alongside resolveTypeEffectiveness's own Struggle fix: this
  // engine's data gives Struggle a real declared type (TYPE_NORMAL), so without
  // this explicit check a Normal-type (or Normal-STAB-granting-ability)
  // attacker would incorrectly get STAB on it -- the C's own early return here
  // isn't a no-op the way an earlier version of this comment claimed.
  if (moveId === 'MOVE_STRUGGLE') return 2
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
/**
 * CalcFinalDmg's own weather block, battle_util.c:7580-7634. Real gap found
 * auditing this: CHECK_WEATHER_DOUBLE_BOOST (ABILITY_WEATHER_DOUBLE_BOOST,
 * real species: Swablu Redux, Castform Sunny, Reuniclus Redux (+ Mega), Walking
 * Wake) wasn't ported at all -- it turns EFFECT_WEATHER_BOOST moves' normal
 * boost into a SQUARED one (1.2 -> 1.44, 1.5 -> 2.25) and, more surprisingly,
 * turns what would otherwise be the OFF-type PENALTY (Fire in Rain, Water in
 * Sun) into the SAME boost value instead of a reduction -- ported faithfully as
 * literally written, not as it "should" make sense. Separately, ABILITY_NIKA
 * and MOVE_STEAM_ERUPTION specifically exempt Water moves from the Sun penalty
 * (forcing it back to neutral 1.0 instead of 0.5x) -- also unported before this.
 */
function weatherDamageMultiplier(
  weather: FieldBattleState['weather'],
  move: MoveData,
  moveType: string,
  attackerHasWeatherDoubleBoost: boolean,
  attackerHasNika: boolean,
): number | null {
  const isWeatherBoostMove = move.effect === 'EFFECT_WEATHER_BOOST'
  const check = (boosted: number, dropped: number) => (attackerHasWeatherDoubleBoost ? boosted : dropped)
  const sunWaterPenalty = (dropped: number, boosted: number) => {
    let modifier = check(boosted, dropped)
    if (modifier < 1.0 && (attackerHasNika || move.id === 'MOVE_STEAM_ERUPTION')) modifier = 1.0
    return modifier
  }
  if (weather === 'RAIN_PERMANENT') {
    if (isWeatherBoostMove) return check(1.2 * 1.2, 1.2)
    if (moveType === 'FIRE') return check(1.2, 0.5)
    if (moveType === 'WATER') return 1.2
  } else if (weather === 'RAIN_TEMPORARY' || weather === 'RAIN_PRIMAL') {
    if (isWeatherBoostMove) return check(1.5 * 1.5, 1.5)
    if (moveType === 'FIRE') return check(1.5, 0.5)
    if (moveType === 'WATER') return 1.5
  } else if (weather === 'SUN_PERMANENT') {
    if (isWeatherBoostMove) return check(1.2 * 1.2, 1.2)
    if (moveType === 'FIRE') return 1.2
    if (moveType === 'WATER') return sunWaterPenalty(0.5, 1.2)
  } else if (weather === 'SUN_TEMPORARY' || weather === 'SUN_PRIMAL') {
    if (isWeatherBoostMove) return check(1.5 * 1.5, 1.5)
    if (moveType === 'FIRE') return 1.5
    if (moveType === 'WATER') return sunWaterPenalty(0.5, 1.5)
  }
  return null
}

function attackerFinalItemMultiplier(
  attacker: BattlerBattleState,
  typeEffectiveness: number,
  sameMoveTurnsInARow: number,
  moveFlags: Record<string, true>,
  moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS',
): number {
  const effect = attacker.condition.resolvedHoldEffect
  if (effect === 'HOLD_EFFECT_LIFE_ORB') return uq(1.3)
  if (effect === 'HOLD_EFFECT_EXPERT_BELT' && typeEffectiveness >= uq(2.0)) return uq(1.2)
  if (effect === 'HOLD_EFFECT_METRONOME') {
    const percentBoost = Math.min(sameMoveTurnsInARow * (attacker.holdEffectStrength ?? 0), 100)
    return uq(1.0) + percentToModifier(percentBoost)
  }
  if (effect === 'HOLD_EFFECT_PUNCHING_GLOVE' && isIronFistBoosted(attacker.abilitySlots, moveFlags, moveSplit)) return uq(1.1)
  // Amulet Coin (Meowth Partner-only) is deferred.
  return uq(1.0)
}

/** The defender's hold effect (:7688-7700) -- currently just the resist berry, the
 * only one of this switch's cases that changes the damage NUMBER (the others in the
 * C's own switch are status/end-of-turn effects, out of scope here). Unnerve and
 * Ripen are both plain declarative bitfields with no other behavior (same shape as
 * Relic Stone's own stabInHalves check above) -- read directly by ability ID rather
 * than adding a pipeline-emitted flag + a whole registry entry for two abilities
 * whose only damage-relevant behavior is this exact hardcoded read. */
function resistBerryMultiplier(
  attackerSlots: AbilitySlots,
  defender: BattlerBattleState,
  moveType: string,
  typeEffectiveness: number,
): 0.5 | 0.25 | null {
  if (defender.condition.resolvedHoldEffect !== 'HOLD_EFFECT_RESIST_BERRY') return null
  if (defender.holdEffectType !== moveType) return null
  if (moveType !== 'NORMAL' && typeEffectiveness < uq(2.0)) return null
  if (battlerHasAbility(attackerSlots, 'ABILITY_UNNERVE', () => false)) return null
  return battlerHasAbility(defender.abilitySlots, 'ABILITY_RIPEN', () => false) ? 0.25 : 0.5
}

/**
 * EFFECT_MAGNITUDE's own top-level path: simulates all 7 magnitude tiers (each a
 * full, independent calculateMoveDamage call with magnitudeTier forced) and
 * combines them into a REAL probability-weighted damage distribution, rather than
 * asking the caller to guess one tier. Each tier's own `rolls`/`critRolls`/
 * `totalRolls`/`totalCritRolls` (already 16 equiprobable values, or a multi-hit
 * sum of them, per calculateMoveDamage's normal contract) is repeated
 * `MAGNITUDE_PROBABILITY_PERCENT[tier] / 5` times -- since every tier's percent
 * is a multiple of 5, this always divides evenly, and the resulting 320-entry
 * array is STILL a flat equiprobable-elements array (each entry now implicitly
 * weighted by its repetition count), so every existing consumer of `rolls`
 * (kochance.ts's calcKoChances, ResultsTable's min/max formatting) needs no
 * changes at all to correctly reflect the combined distribution -- neither
 * assumes a fixed length, only that every element is equally likely.
 *
 * Non-power facts (isImmune, effectiveMoveType, hitCount, unmodelled, ...) are
 * taken from the modal tier (7, 30% -- an arbitrary but representative pick,
 * since these never vary by magnitude tier) with the tier-fallback unmodelled
 * note stripped (it doesn't apply here -- a full distribution was computed).
 */
function calculateMagnitudeDistribution(scenario: DamageCalcScenario): DamageCalcResult {
  const perTier = Object.entries(MAGNITUDE_PROBABILITY_PERCENT).map(([tierStr, percent]) => {
    const tier = Number(tierStr) as 4 | 5 | 6 | 7 | 8 | 9 | 10
    return { tier, weight: percent / 5, result: calculateMoveDamage({ ...scenario, magnitudeTier: tier }) }
  })

  function combine(pick: (r: DamageCalcResult) => number[] | null): number[] | null {
    if (perTier.some((p) => pick(p.result) === null)) return null
    const combined: number[] = []
    for (const { weight, result } of perTier) {
      const values = pick(result)!
      for (let i = 0; i < weight; i++) combined.push(...values)
    }
    return combined.sort((a, b) => a - b)
  }

  const modal = perTier.find((p) => p.tier === 7)!.result
  return {
    ...modal,
    rolls: combine((r) => r.rolls)!,
    critRolls: combine((r) => r.critRolls),
    totalRolls: combine((r) => r.totalRolls),
    totalCritRolls: combine((r) => r.totalCritRolls),
    unmodelled: modal.unmodelled.filter((n) => !n.includes('EFFECT_MAGNITUDE')),
  }
}

/** CalculateMoveDamage / DoMoveDamageCalc, src/battle_util.c:7788-7827. Evaluates
 * all 16 damage rolls (and, separately, the same 16 with a forced crit) rather than
 * drawing one; see kochance.ts for the KO-probability consumer of this shape. THE
 * ONE EXCEPTION: an EFFECT_MAGNITUDE move with no magnitudeTier forced returns a
 * larger, still-flat-equiprobable array combining all 7 tiers weighted by their
 * real probability -- see calculateMagnitudeDistribution's own doc. */
export function calculateMoveDamage(scenario: DamageCalcScenario): DamageCalcResult {
  if (scenario.move.effect === 'EFFECT_MAGNITUDE' && scenario.magnitudeTier === null) {
    return calculateMagnitudeDistribution(scenario)
  }
  const { move, attacker, defender, field } = scenario
  const moveType = move.type ?? 'NORMAL'
  const attackerRaw = { atk: scenario.attacker.rawStats.atk, spatk: scenario.attacker.rawStats.spatk, def: scenario.attacker.rawStats.def, spdef: scenario.attacker.rawStats.spdef }
  const split = resolveSplit(scenario, attackerRaw)
  const cheapAttackerHasMoldBreaker = computeAttackerHasMoldBreaker(attacker.abilitySlots, move.id, split)
  const isForcedMinRoll =
    battlerHasAbility(defender.abilitySlots, 'ABILITY_BAD_LUCK', () => cheapAttackerHasMoldBreaker) ||
    battlerHasAbility(defender.abilitySlots, 'ABILITY_BAD_OMEN', () => cheapAttackerHasMoldBreaker)

  const evaluate = (mtype: string, forceCrit: boolean, hitModifier: number, hitIndex: number) => calcInternal(scenario, mtype, split, forceCrit, hitModifier, hitIndex)

  function fullDamageForRoll(
    damageRoll: number,
    forceCrit: boolean,
    hitModifier: number,
    hitIndex: number = 0,
  ): { dmg: number; typeEffectiveness: number; effectiveMoveType: string; unmodelled: string[] } {
    const primary = evaluate(moveType, forceCrit, hitModifier, hitIndex)
    let best = { ...primary, effectiveMoveType: primary.resolvedMoveType }

    if (move.type2 && move.type2 !== moveType && move.type2 !== 'MYSTERY') {
      const alt = evaluate(move.type2, forceCrit, hitModifier, hitIndex)
      if (alt.dmg > best.dmg) best = { ...alt, effectiveMoveType: alt.resolvedMoveType }
    }

    if (best.dmg < 0) return { dmg: 0, typeEffectiveness: best.typeEffectiveness, effectiveMoveType: best.effectiveMoveType, unmodelled: best.unmodelled }

    // random factor, src/battle_util.c:7815-7821 -- Bad Luck/Bad Omen force
    // roll=15 on the defender's side; surfaced via the result's own
    // isForcedMinRoll flag (calculateMoveDamage) rather than changed here --
    // every roll in this array is still independently correct, it's the
    // CALLER's job to know only rolls[0] is reachable when that flag is set.
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
    const result = fullDamageForRoll(roll, false, uq(1.0))
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
      critRolls.push(fullDamageForRoll(roll, true, uq(1.0)).dmg)
    }
  }

  // Multi-hit: the first hit is exactly what `rolls`/`critRolls` already computed
  // (hitModifier uq(1.0)) -- only hits 1..N-1 need a fresh pass, using whatever
  // modifier this hit's mechanism (a move's own multi-hit effect, or a Parental
  // Bond bonus hit) assigns it. See multiHit.ts and DamageCalcResult's own doc for
  // why this sums independently-rolled percentiles rather than modelling the true
  // joint distribution.
  const hitPlanResult = resolveHitPlan(
    move,
    attacker.abilitySlots,
    defender.abilitySlots,
    hasFlag(attacker.abilitySlots, 'skillLink'),
    attacker.condition.resolvedHoldEffect,
    scenario.hitCount,
    { moveType, moveFlags: move.flags, weather: field.weather, attackerHeads: attacker.condition.heads },
    scenario.beatUpHitCount,
  )
  let hitCount: number | null = null
  let totalRolls: number[] | null = null
  let totalCritRolls: number[] | null = null
  if (hitPlanResult && 'unmodelled' in hitPlanResult) {
    unmodelled.add(hitPlanResult.unmodelled)
  } else if (hitPlanResult) {
    hitCount = hitPlanResult.hitCount
    totalRolls = [...rolls]
    totalCritRolls = critRolls ? [...critRolls] : null
    for (let hitIndex = 1; hitIndex < hitPlanResult.hitCount; hitIndex++) {
      const hitModifier = hitPlanResult.hitModifier(hitIndex)
      for (let roll = 15; roll >= 0; roll--) {
        const arrayIndex = 15 - roll
        const result = fullDamageForRoll(roll, false, hitModifier, hitIndex)
        totalRolls[arrayIndex] += result.dmg
        result.unmodelled.forEach((u) => unmodelled.add(u))
        if (totalCritRolls) totalCritRolls[arrayIndex] += fullDamageForRoll(roll, true, hitModifier, hitIndex).dmg
      }
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
    hitCount,
    totalRolls,
    totalCritRolls,
    isForcedMinRoll,
  }
}
