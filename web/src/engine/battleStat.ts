// CalculateStat / CalcAttackStat / CalcDefenseStat, ported from
// src/battle_util.c:7129-7466. This sits above the pure primitives in stats.ts
// (applyStatStage, applyExtraStatLevels, applyStatusHalving), which this module calls.
//
// Ability hooks (`onStat`, `onChooseOffensiveStat`, `onChooseDefensiveStat`) are not
// wired in yet -- the ability registry doesn't exist until Task 9/10. Every place the
// C consults one takes an injected function here, defaulting to a no-op/identity, so
// this module is already the exact shape the registry will plug into rather than
// something that needs restructuring later. Similarly, the C's recursive
// "secondary stat" blend (a move/ability reading e.g. some % of Defense as Attack) is
// simplified to one pre-summed percentage rather than the full recursion -- nothing
// sets a non-zero secondary stat until the onChooseOffensiveStat/onChooseDefensiveStat
// hook batch is ported, so this is inert until then, and is documented as a
// known simplification to revisit at that point.

import { applyModifier, idiv, mulModifier, uq } from './fixed'
import { applyExtraStatLevels, applyStatStage } from './stats'
import type { BattleStatKey } from './types'

export const DEFAULT_STAT_STAGE = 6 // src/pokemon.c / include/constants/pokemon.h:123

/**
 * BenefitsFromStatBuffs, src/battle_util.c:9019-9024. `opponentHasHemolysis` is a
 * caller-supplied fact (the ability isn't ported yet) rather than looked up here.
 */
export function benefitsFromStatBuffs(isBleeding: boolean, hasBloodStainEffect: boolean, isPoisoned: boolean, opponentHasHemolysis: boolean): boolean {
  if (isBleeding) return false
  if (hasBloodStainEffect) return false
  if (isPoisoned && opponentHasHemolysis) return false
  return true
}

export interface CalcStatInputs {
  /** The raw stat (already run through calcStat's out-of-battle formula), before any
   * of CalculateStat's own per-stat pre-modifiers. */
  rawStat: number
  extraStatLevel: number
  /** 0..12 -- the C's own internal stage representation (6 = no change), NOT -6..+6. */
  statStage: number
  isUnaware: boolean
  isWonderRoomActive: boolean
  /** True only for STAT_ATK/STAT_SPATK, gates the Wonder Room default-stage override
   * alongside isWonderRoomActive (:7204). */
  isOffensiveStatForWonderRoom: boolean
  isCrit: boolean
  /** True when this call is computing the ATTACKER's stat (CalcAttackStat's role),
   * false for the DEFENDER's (CalcDefenseStat's role) -- drives which direction a
   * crit ignores stat stages in (:7205-7208). */
  isAttackRole: boolean
  benefitsFromStatBuffs: boolean
  /** Per-stat pre-modifier, applied to rawStat before ability hooks or stat stages --
   * violentRush/showdownMode/readiedAction/burn for ATK, rapidResponse/frostbite for
   * SPATK, hail-boosted Ice Def, sandstorm-boosted Rock SpDef. Identity if none apply. */
  preModify: (stat: number) => number
  /** ability onStat hooks, accumulated -- identity until the registry exists. */
  applyOnStatHooks: (stat: number) => number
  /** pre-summed secondary-stat percentage (see module doc); 0 until wired. */
  secondaryStatPercent: number
  statStageRatios: [number, number][]
}

/** CalculateStat, src/battle_util.c:7129-7241 (the non-recursive core; STAT_HP and
 * STAT_SPEED's own raw-stat derivation are the caller's responsibility -- this
 * function starts from `rawStat` already selected). */
export function calculateBattleStat(inputs: CalcStatInputs): number {
  let statBase = inputs.preModify(inputs.rawStat)
  statBase = inputs.applyOnStatHooks(statBase)

  let stage = inputs.statStage
  if (inputs.isUnaware) stage = DEFAULT_STAT_STAGE
  else if (inputs.isWonderRoomActive && inputs.isOffensiveStatForWonderRoom) stage = DEFAULT_STAT_STAGE
  else if (inputs.isCrit && inputs.isAttackRole) stage = Math.max(stage, DEFAULT_STAT_STAGE)
  else if (inputs.isCrit && !inputs.isAttackRole) stage = Math.min(stage, DEFAULT_STAT_STAGE)
  if (!inputs.benefitsFromStatBuffs) stage = Math.min(stage, DEFAULT_STAT_STAGE)

  if (inputs.secondaryStatPercent) {
    statBase = idiv(statBase * (100 + inputs.secondaryStatPercent), 100)
  }

  statBase = applyStatStage(statBase, stage, inputs.statStageRatios)
  statBase = applyExtraStatLevels(statBase, inputs.extraStatLevel)
  return statBase
}

// ---------------------------------------------------------------------------
// Per-stat pre-modifiers (:7146-7187), as composable `preModify` factories.
// ---------------------------------------------------------------------------

export function attackPreModify(opts: { violentRush: boolean; showdownMode: boolean; readiedAction: boolean; isBurned: boolean }) {
  return (stat: number): number => {
    let s = stat
    if (opts.violentRush) s = idiv(s * 6, 5)
    if (opts.showdownMode) s = idiv(s * 6, 5)
    if (opts.readiedAction) s *= 2
    if (opts.isBurned) s = idiv(s, 2)
    return s
  }
}

export function spAttackPreModify(opts: { rapidResponse: boolean; isFrostbitten: boolean }) {
  return (stat: number): number => {
    let s = stat
    if (opts.rapidResponse) s = idiv(s * 6, 5)
    if (opts.isFrostbitten) s = idiv(s, 2)
    return s
  }
}

export function defensePreModify(opts: { isIceTypeInHail: boolean }) {
  return (stat: number): number => (opts.isIceTypeInHail ? idiv(stat * 3, 2) : stat)
}

export function spDefensePreModify(opts: { isRockTypeInSandstorm: boolean }) {
  return (stat: number): number => (opts.isRockTypeInSandstorm ? idiv(stat * 3, 2) : stat)
}

// ---------------------------------------------------------------------------
// CalcAttackStat / CalcDefenseStat item modifiers (:7273-7314, :7434-7458).
// ---------------------------------------------------------------------------

const LIGHT_BALL_MULTIPLIER: Record<string, number> = {
  SPECIES_PIKACHU: 2.0,
  SPECIES_PICHU: 2.0,
  SPECIES_PICHU_SPIKY_EARED: 2.0,
  SPECIES_PIKACHU_PARTNER: 1.6,
  SPECIES_PIKACHU_BELLE: 1.6,
  SPECIES_PIKACHU_COSPLAY: 1.6,
  SPECIES_PIKACHU_LIBRE: 1.6,
  SPECIES_PIKACHU_POP_STAR: 1.6,
  SPECIES_PIKACHU_ROCK_STAR: 1.6,
  SPECIES_PIKACHU_PH_D: 1.6,
  SPECIES_PIKACHU_PARTNER_MEGA: 1.6,
  SPECIES_RAICHU: 1.5,
}

export interface AttackItemContext {
  resolvedHoldEffect: string | null
  baseSpeciesId: string // GET_BASE_SPECIES_ID
  isPhysical: boolean
  isSpecial: boolean
}

/** The attacker's hold-effect switch inside CalcAttackStat (:7280-7314). */
export function attackItemModifier(item: AttackItemContext): number {
  let modifier = uq(1.0)
  switch (item.resolvedHoldEffect) {
    case 'HOLD_EFFECT_THICK_CLUB':
      if ((item.baseSpeciesId === 'SPECIES_CUBONE' || item.baseSpeciesId === 'SPECIES_MAROWAK') && item.isPhysical) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'HOLD_EFFECT_DEEP_SEA_TOOTH':
      if (item.baseSpeciesId === 'SPECIES_CLAMPERL' && item.isSpecial) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'HOLD_EFFECT_LIGHT_BALL': {
      const mult = LIGHT_BALL_MULTIPLIER[item.baseSpeciesId]
      if (mult) modifier = mulModifier(modifier, uq(mult))
      break
    }
    case 'HOLD_EFFECT_LEEK':
      if (item.baseSpeciesId === 'SPECIES_FARFETCHD' && item.isPhysical) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'HOLD_EFFECT_CHOICE_BAND':
      if (item.isPhysical) modifier = mulModifier(modifier, uq(1.5))
      break
    case 'HOLD_EFFECT_CHOICE_SPECS':
      if (item.isSpecial) modifier = mulModifier(modifier, uq(1.5))
      break
  }
  return modifier
}

export interface CalcAttackStatOptions {
  attackStat: number // result of calculateBattleStat for the chosen offensive stat.
  // Foul Play/Body Press's stat/battler selection happens in calculate.ts before this
  // is called; item/status modifiers below always key off the attacking side.
  isGhostDefenderInFog: boolean // src/battle_util.c:7274 -- Trick-or-Treat exempts this
  isInfatuatedWithDefender: boolean
  item: AttackItemContext
}

/** CalcAttackStat's post-CalculateStat modifier chain (:7272-7314). The C selects
 * the stat and battler (Foul Play/Body Press/ability overrides) before calling this;
 * that selection lives in calculate.ts, since it needs move-effect data this module
 * doesn't otherwise touch. */
export function calcAttackStatModifiers(opts: CalcAttackStatOptions): number {
  let modifier = uq(1.0)
  if (opts.isGhostDefenderInFog) modifier = mulModifier(modifier, uq(0.8))
  if (opts.isInfatuatedWithDefender) modifier = mulModifier(modifier, uq(0.5))
  modifier = mulModifier(modifier, attackItemModifier(opts.item))
  return applyModifier(modifier, opts.attackStat)
}

export interface DefenseItemContext {
  resolvedHoldEffect: string | null
  speciesId: string // exact species -- Deep Sea Scale/Metal Powder/Necrozma check against this
  baseSpeciesId: string // GET_BASE_SPECIES_ID -- Soul Dew's Latias/Latios check (so a Mega form still qualifies)
  isTransformed: boolean // STATUS2_TRANSFORMED -- Metal Powder exemption
  canEvolve: boolean // Eviolite -- CanEvolve(), de-evolution rows included
  defStatToUse: 'atk' | 'def' | 'spatk' | 'spdef' | 'spe'
}

/** The defender's hold-effect switch inside CalcDefenseStat (:7434-7458). ER's Soul
 * Dew Gen<=6 defensive boost (`#if B_SOUL_DEW_BOOST <= GEN_6`) is included -- ER
 * doesn't override this config, so the branch is live. */
export function defenseItemModifier(item: DefenseItemContext): number {
  let modifier = uq(1.0)
  switch (item.resolvedHoldEffect) {
    case 'HOLD_EFFECT_DEEP_SEA_SCALE':
      if (item.speciesId === 'SPECIES_CLAMPERL' && item.defStatToUse === 'spdef') modifier = mulModifier(modifier, uq(2.0))
      break
    case 'HOLD_EFFECT_METAL_POWDER':
      if (item.speciesId === 'SPECIES_DITTO' && item.defStatToUse === 'def' && !item.isTransformed) modifier = mulModifier(modifier, uq(2.0))
      break
    case 'HOLD_EFFECT_EVIOLITE':
      if (item.canEvolve) modifier = mulModifier(modifier, uq(1.5))
      break
    case 'HOLD_EFFECT_ASSAULT_VEST':
      if (item.defStatToUse === 'spdef') modifier = mulModifier(modifier, uq(1.5))
      break
    case 'HOLD_EFFECT_TACTICAL_VEST':
      if (item.defStatToUse === 'def') modifier = mulModifier(modifier, uq(1.5))
      break
    case 'HOLD_EFFECT_SOUL_DEW':
      if ((item.baseSpeciesId === 'SPECIES_LATIAS' || item.baseSpeciesId === 'SPECIES_LATIOS') && item.defStatToUse === 'spdef')
        modifier = mulModifier(modifier, uq(1.5))
      break
  }
  return modifier
}

export function calcDefenseStatModifiers(defenseStat: number, item: DefenseItemContext): number {
  return applyModifier(defenseItemModifier(item), defenseStat)
}

/**
 * noPositiveStatStages, src/battle_util.c:7398-7400 -- crit, a stat-stages-ignored
 * move flag, or (Wrap'd defender + Grip Pincer/World Serpent attacker). The last
 * clause needs the ability registry; caller passes it as a fact.
 */
export function noPositiveStatStages(isCrit: boolean, moveIgnoresStatStages: boolean, isWrappedAndAttackerHasGripPincerOrWorldSerpent: boolean): boolean {
  return isCrit || moveIgnoresStatStages || isWrappedAndAttackerHasGripPincerOrWorldSerpent
}

/** GetBattleMoveSplit's defending-stat selection, src/battle_util.c:7421-7429
 * (the non-ability-overridden branch; onChooseDefensiveStat hooks run first in the
 * real C and are out of scope here). */
export function defaultDefendingStat(splitFlag: string | undefined, isPhysical: boolean): BattleStatKey {
  if (splitFlag === 'HITS_SPDEF') return 'spdef'
  if (splitFlag === 'HITS_DEF') return 'def'
  return isPhysical ? 'def' : 'spdef'
}
