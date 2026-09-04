// Shared engine types. `erasableSyntaxOnly` (tsconfig.app.json) bans TS `enum` --
// every enum-like value here is a `const` array/object plus a derived union type.

import type { AbilitySlots } from './abilities/dispatch'

export const STAT_KEYS = ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe'] as const
export type StatKey = (typeof STAT_KEYS)[number]

/** The five stats a nature, stat stage, or battle modifier can touch -- everything
 * except HP, which is fixed once calculated and never boosted/lowered in battle. */
export const BATTLE_STAT_KEYS = ['atk', 'def', 'spatk', 'spdef', 'spe'] as const
export type BattleStatKey = (typeof BATTLE_STAT_KEYS)[number]

export interface BaseStats {
  hp: number
  atk: number
  def: number
  spatk: number
  spdef: number
  spe: number
}

/** EVs or IVs -- one number per stat, HP included (unlike BattleStatKey). */
export type StatSpread = Record<StatKey, number>

/** src/pokemon.c's gNatureStatTable key order: ATK, DEF, SPEED, SPATK, SPDEF (no HP,
 * no accuracy/evasion -- ModifyStatByNature explicitly excludes those). Mirrors
 * natures.json's own key names exactly, which is why this isn't just BattleStatKey
 * spelled differently: "SPEED" here, "spe" there. */
export type NatureStatName = 'ATK' | 'DEF' | 'SPEED' | 'SPATK' | 'SPDEF'

/** natures.json's natureStatTable shape: {"NATURE_ADAMANT": {ATK: 1, ..., SPDEF: 0}, ...} */
export type NatureStatTable = Record<string, Record<NatureStatName, -1 | 0 | 1>>

// ---------------------------------------------------------------------------
// Damage context -- the battle-state facts a move's declarative base-power
// condition (moveBehaviors.json's `attack.damage.conditions`) or one of the
// hardcoded CustomMoveCondition<>/CustomMoveDamage<> specializations
// (src/script_conditions.cc) can read. Deliberately a flat snapshot, not a live
// simulation: this is a "what if this happened right now" calculator, not a battle
// engine, so history-dependent facts (did the target act after me this turn, was I
// damaged this turn) are inputs the UI collects as explicit toggles rather than
// things the engine derives on its own.
// ---------------------------------------------------------------------------

export interface ConditionBattlerContext {
  speciesId: string // exact SPECIES_* id
  baseSpeciesId: string // GET_BASE_SPECIES_ID(species) -- for non-exact SpeciesCondition
  heads: number // species.json's `heads` (F_TWO_HEADED/F_THREE_HEADED, pokemon.h:209-210), default 1 -- Multi Headed's onParentalBond trigger
  /** !!GetBaseSpeciesFromMega(species) -- true iff this species' OWN species.json
   * entry has a nonempty `megas` or `primals` list (i.e. this battler currently IS
   * a Mega/Primal form, not that it CAN mega-evolve -- Eternal Flower's own check
   * reads whichever species is on the field right now). */
  isMegaEvolved: boolean
  itemId: string | null
  resolvedHoldEffect: string | null // items.json's resolvedHoldEffect, for HoldEffect-keyed ItemCondition
  itemNegated: boolean // Embargo/Klutz/Magic Room-style suppression; v1 default false
  status1: Set<string> // bare STATUS1_* flags currently active (poison, burn, ...)
  hasComatose: boolean // Comatose counts as always-asleep for StatusCondition(SLEEP)
  hasBloodStainEffect: boolean // Blood Stain counts as always-bleeding for StatusCondition(BLEED)
  isInfatuated: boolean // STATUS2_INFATUATION
  isConfused: boolean // STATUS2_CONFUSION (Cosmic Daze/Cosmic Dust, Tangled Feet)
  isEnraged: boolean // STATUS2_ENRAGED (Cosmic Daze/Cosmic Dust, Madness Enhancement)
  wasDamagedThisTurnBy: 'attacker' | 'defender' | 'none' // gRoundStructs[battler].damaged + who
  recentlyFainted: boolean // side's RecentFainted() -- an ally fainted last turn (Retaliate)
  hp: number
  maxHp: number
  weight: number // hectograms, ability-adjusted (Heavy Metal etc.) -- v1: raw species weight
  speed: number // GetBattlerTotalSpeedStat equivalent, post-stage/item/ability
  positiveStatStageCount: number // CountBattlerStatIncreases -- Punishment/Stored Power
  negativeStatStageCount: number // CountBattlerStatDecreases -- Lash Out
  usedMovePpRemaining: number | null // pp[slot] for the move being used, if known -- Trump Card
  helpingHand: boolean
  ghastlyEcho: boolean // STATUS4_GHASTLY_ECHO
  chargedUp: boolean // STATUS3_CHARGED_UP
  meFirst: boolean // STATUS3_ME_FIRST
  fear: boolean // gVolatileStructs[battler].fear -- read from the OPPOSING battler in CalcMoveBasePowerAfterModifiers
  safePassage: boolean // gRoundStructs[battler].safePassage -- read from the OPPOSING battler
  itemResolvedHoldEffectStrength: number | null // holdEffectStrength, 0-100 clamped by caller
  lastMoveFailed: boolean // Stomping Tantrum
}

// ER's weather has two intensities per kind (:7592-7648) -- PERMANENT is the WEAK
// tier (ability/long-lasting weather, e.g. Drizzle), TEMPORARY/PRIMAL is the STRONG
// tier (Rain Dance-style moves, Primal Reversion) -- the opposite of what the names
// suggest at a glance. Sand and Hail contribute no *damage* multiplier at all (they
// boost the Rock/Ice defensive stat instead, in CalculateStat) -- included here only
// so field state has one representation, not because finalDamage.ts branches on them
// directly for a damage multiplier.
export const WEATHER_KINDS = [
  'NONE',
  'SUN_PERMANENT',
  'SUN_TEMPORARY',
  'SUN_PRIMAL',
  'RAIN_PERMANENT',
  'RAIN_TEMPORARY',
  'RAIN_PRIMAL',
  'SANDSTORM',
  'HAIL',
  'FOG',
  'STRONG_WINDS',
] as const
export type WeatherKind = (typeof WEATHER_KINDS)[number]

export interface ConditionFieldContext {
  gravityActive: boolean
  terrain: string | null // bare TERRAIN_* name, or null for no terrain
  weather: WeatherKind
}

export interface DamageContext {
  attacker: ConditionBattlerContext
  defender: ConditionBattlerContext
  field: ConditionFieldContext
  /** True if the attacker's action this turn resolves before the defender's --
   * drives ActsAfter-based moves (Payback, Bolt Beak, Assurance-style "acts after"
   * checks). A calculator has no real turn order without a full simulation, so this
   * is a UI-level toggle, not something derived. */
  attackerActsFirst: boolean
  sameMoveTurnsInARow: number // gBattleStruct->sameMoveTurns -- Echoed Voice, Metronome (item)
}

// ---------------------------------------------------------------------------
// The full battle-scenario shape calculate.ts's entry point consumes. Composes
// ConditionBattlerContext/ConditionFieldContext (the narrower shapes basePower.ts and
// conditions.ts already depend on) rather than duplicating their fields flat, so
// there's exactly one definition of e.g. "what a battler's held item looks like".
// ---------------------------------------------------------------------------

export interface BattlerBattleState {
  condition: ConditionBattlerContext
  types: string[] // 1-3 bare type names, in dex order (type1, type2, type3)
  isGrounded: boolean // species-only baseline (false for pure Flying-type); calculate.ts further
  // reduces this with the Levitate ABILITY flag (mold-breaker-aware) to match
  // IsBattlerGroundedIgnoreType (:6699-6701) -- Air Balloon/Magnet Rise/Telekinesis
  // (also levitating effects) and Gravity/Iron Ball/Ingrain/Smacked Down (grounding
  // effects, which override everything) have no scenario state and stay unmodelled.
  /** gStatuses3[battler] & STATUS3_UNDERGROUND/UNDERWATER/ON_AIR -- Dig/Dive/Fly-style
   * semi-invulnerability. A per-turn battle state this calculator can't derive (it
   * has no turn simulation), so it's a scenario toggle rather than computed --
   * see BattlerConfig.semiInvulnerable. Only the DEFENDER's value is ever read
   * (battle_util.c:7707-7709: FLAG_DMG_UNDERGROUND/UNDERWATER/2X_IN_AIR check
   * gStatuses3[battlerDef] specifically). */
  semiInvulnerable: 'NONE' | 'UNDERGROUND' | 'UNDERWATER' | 'AIRBORNE'
  /** A generic "is this battler's ability currently in its boosted/active state"
   * scenario toggle -- GetAbilityState/isFirstTurn/RESOURCE_FLAG-style in-battle
   * activation state (Flash Fire triggered, Unburden's item lost, Power Outage/
   * Chuckster/Drakelp Head not yet discharged, Ambush/Stakeout's first-turn check,
   * Slow Start's timer) that this non-turn-simulating calculator can't derive on
   * its own, matching @smogon/calc's own `abilityOn` field for the same class of
   * mechanism. See BattlerConfig.abilityOn. */
  abilityOn: boolean
  /** GetGenderFromSpeciesAndPersonality's result -- Rivalry's whole condition.
   * species.json's own `gender` field is a ratio (percentFemale) or `genderless`,
   * not a fixed value (an individual's actual gender depends on its personality
   * value, which this calculator doesn't model at all) -- see
   * BattlerConfig.gender's doc for how the default is picked. */
  gender: 'MALE' | 'FEMALE' | 'GENDERLESS'
  /** Protosynthesis/Quark Drive's ParadoxBoost.statId -- which stat their weather/
   * terrain-triggered activation boosted (GetAbilityStateAs(...).paradoxBoost, a
   * per-battler ability-state struct this calculator has no turn simulation to
   * derive) -- null when inactive. Matches @smogon/calc's own `boostedStat`
   * field for the same mechanism. See BattlerConfig.boostedStat's doc. */
  boostedStat: BattleStatKey | null
  /** gFaintedMonCount[GetBattlerSide(battler)] -- how many of THIS battler's OWN
   * team have fainted so far this battle (Soul Harvest, Supreme Overlord). This
   * v1 singles engine has no team/fainted concept to derive it from, matching
   * @smogon/calc's own `alliesFainted` field for the same mechanism. Both
   * abilities clamp with `min(5, ...)` in the C, so values above 5 are equivalent
   * to 5. */
  alliesFainted: number
  /** gVolatileStructs[battler].slowStartTimer -- set to 5 on entry, counts down
   * every turn to 0. Slow Start's OWN check is a plain `if (timer)` boolean
   * (already ported as the generic `abilityOn` toggle, see 29-ability-activation.ts),
   * but Lethargy reads this SAME per-battler timer's exact value for a 5-tier
   * multiplier (0.2x/0.4x/0.6x/0.8x/1.0x) -- a scenario toggle since this
   * non-turn-simulating engine can't derive how many turns have elapsed since
   * entry, same reasoning as alliesFainted above. */
  slowStartTimer: number
  level: number
  nature: string
  /** Out-of-battle stats (calcStat/calcHp already applied) -- the raw
   * `gBattleMons[battler].attack` etc. CalculateStat's own pre-modifiers (burn,
   * violent rush, hail/sand, ...) are applied on top of these by calculate.ts. */
  rawStats: Record<BattleStatKey, number>
  /** -6..+6, the conventional external representation; calculate.ts converts to the
   * C's internal 0..12 at the point of use. */
  statStages: Record<BattleStatKey, number>
  extraStatLevel: Record<BattleStatKey, number> // ER's "extra stat levels", default 0 each
  holdEffectStrength: number | null // holdEffectStrength, for Plate/Type Power/Expert Belt-style items
  holdEffectType: string | null // Plate/Type Power's secondary type
  isTransformed: boolean // STATUS2_TRANSFORMED (Metal Powder exemption)
  canEvolveStrict: boolean // Eviolite eligibility
  isInfatuatedWithOpponent: boolean // STATUS2_INFATUATION *and* infatuated specifically with the other battler
  moveSlotPp: Record<string, number> // moveId -> current pp, for Trump Card
  abilitySlots: AbilitySlots
}

export interface FieldBattleState extends ConditionFieldContext {
  sides: {
    attacker: { reflect: boolean; lightScreen: boolean; auroraVeil: boolean; luckyChant: boolean }
    defender: { reflect: boolean; lightScreen: boolean; auroraVeil: boolean; luckyChant: boolean }
  }
  isDoubleBattle: false // v1 is singles-only; literal type keeps multi-target code unreachable
}

/** natures.json's full shape, as emitted by erdata.natures.battle_constants_to_dict(). */
export interface BattleConstants {
  natureStatTable: NatureStatTable
  statStageRatios: [number, number][] // index 0..12, stage -6..+6
  criticalHitChance: number[] // index 0..4, {24, 8, 2, 1, 1} in ER (GEN_7)
  maxIvs: number
  maxEvPerStat: number
  maxEvTotal: number
  maxLevel: number
  defaultStatStage: number
  uq412Precision: number
}
