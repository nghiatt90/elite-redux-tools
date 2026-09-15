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
  /** gActionsByTurnOrder[target] == B_ACTION_SWITCH -- EFFECT_PURSUIT's own doubling
   * condition (battle_util.c:6860). A fact about the DEFENDER's chosen action this
   * turn, not derivable without a full turn simulation -- a scenario toggle, same
   * shape as attackerActsFirst. */
  defenderIsSwitching: boolean
  /** Cmd_setmagnitude's own random roll, pre-resolved to the displayed "Magnitude N"
   * tier (4-10) rather than the raw 0-99 roll -- battle_util.c:11265-11307's table
   * is a pure, turn-history-free random draw (unlike Rollout/Triple Kick, which
   * depend on which hit/turn this is), so a manual tier pick is the same "pick one
   * scenario, not a probability distribution" pattern this calculator already
   * uses everywhere else. null leaves EFFECT_MAGNITUDE unmodelled. */
  magnitudeTier: 4 | 5 | 6 | 7 | 8 | 9 | 10 | null
  /** gVolatileStructs[battlerAtk].rolloutCounter, read directly rather than
   * derived from a turn count -- Rollout/Ice Ball (EFFECT_ROLLOUT) share this.
   * Unlike Triple Kick's hitIndex (which this calculator resolves itself within
   * one move use), rolloutCounter persists ACROSS turns via Cmd_handlerollout's
   * own post-hit increment (battle_script_commands.c:11176-11191) -- and that
   * function's exact ordering relative to THIS turn's own base-power calculation
   * isn't verifiable from the available decompiled source (no battle-script
   * bytecode to confirm it), so rather than guess an off-by-one mapping from "N
   * consecutive turns" to a counter value, this exposes the raw counter itself:
   * the user states which hit of an ongoing chain they want computed, sidestepping
   * the turn-simulation question entirely. 0-3 -- capped at 3 because
   * Cmd_handlerollout's own increment gate (`rolloutCounter < 3`) makes it
   * unreachable through normal chained use. Counter 0 leaves power untouched: the
   * released build's EFFECT_ROLLOUT is a bare `REQUIRE(rolloutCounter)` shift
   * (battle_util.c:6790-6793) with NO Defense Curl branch -- upstream added that
   * (and with it the only reason to model STATUS2_DEFENSE_CURL at all) after this
   * pin, so there is no attackerHasDefenseCurl input here. */
  attackerRolloutCounter: 0 | 1 | 2 | 3
  /** gRoundStructs[battlerAtk].physicalDmg/specialDmg, collapsed to one boolean --
   * "was the attacker damaged (by either category) earlier THIS turn, before
   * acting" (battle_script_commands.c:1939-1951 sets it on taking a hit; reset
   * each turn, per the "Round" -- one turn -- naming, same scope as
   * sameMoveTurnsInARow's own "Battle"-wide vs per-turn distinction). Used by
   * EFFECT_FOCUS_PUNCH (:6876-6877, power forced to 40 if true) and
   * MOVE_SELF_DESTRUCT's own hardcoded case (:6926-6927, doubles power) -- a
   * plain scenario fact, no turn simulation needed, same shape as
   * defenderIsSwitching. */
  attackerWasHitThisTurn: boolean
  /** CalcBeatUpPower's own per-hit formula (battle_util.c:102-117): floor(base
   * Attack / 10) + 5, using the SPECIFIC party member (by index) hitting this
   * time -- a genuine "no party roster" gap, same class as Soul Harvest/Supreme
   * Overlord before alliesFainted existed. Rather than leave it unmodelled
   * outright, this exposes ONE representative base Attack stat (the user's own
   * choice -- e.g. the party's average, or a specific ally they care about) and
   * applies CalcBeatUpPower's formula to it UNIFORMLY across every hit, instead
   * of each hit drawing a different party member's own value. A deliberate
   * simplification (the real move usually hits with several DIFFERENT base
   * Attack values in sequence), not a bit-exact port -- see MULTIHIT_BEAT_UP's
   * own doc in multiHit.ts for why this line was drawn here rather than
   * building a full party-roster UI for one move. */
  beatUpBaseAttack: number
  /** GetParentalBondCount's own MINION_CONTROL-style live party count
   * (battle_script_commands.c:1023-1038, "count = 1" for the user itself plus
   * one per other living, non-egg, non-status ally) -- same "no party concept"
   * gap, exposed as a direct hit-count toggle since there's nothing else to
   * derive it from. 1-6 (the user alone, up to 5 more allies). */
  beatUpHitCount: number
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
  isGrounded: boolean // species-only baseline (false for pure Flying-type). calculate.ts's
  // computeIsGrounded resolves the REAL IsBattlerGroundedIgnoreType (:6699-6701)
  // from this: Iron Ball/Gravity force grounded, Air Balloon/Levitate (mold-breaker-
  // aware) force airborne otherwise. Magnet Rise/Telekinesis (levitating) and
  // Ingrain/Smacked Down (grounding) are volatile statuses with no scenario field
  // here and stay genuinely unmodelled.
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
  /** items.json's own `naturalGift` block, power+type only (the confusion/frostbite
   * secondary effect isn't modelled, same as every other move's secondary effect in
   * this engine) -- null when not holding a berry. EFFECT_NATURAL_GIFT
   * (CalcMoveBasePower/GetMoveTypeInternal) reads this directly rather than via
   * resolvedHoldEffect/holdEffectType, which are a DIFFERENT mechanism (Plate/Type
   * Power/Gems' own type-MATCH check) that berries don't participate in. */
  naturalGift: { power: number; type: string } | null
  /** EFFECT_HIDDEN_POWER's type (Hidden Power, Secret Power, and -- in this ER
   * redesign, see MoveList.textproto's own description -- Techno Blast too, all
   * three sharing one effect: GetMoveTypeInternal/GetTypeBeforeUsingMove,
   * src/battle_main.c:5041-5042,5141-5142 return `mon->hpType` directly). NOT
   * derived from IVs: unlike vanilla Pokemon's classic IV-parity formula, this
   * ER build assigns hpType as its own independently-random BoxMon field at
   * creation (src/pokemon.c:573-579, `Random() % (NUMBER_OF_MON_TYPES - 1)`,
   * excluding Mystery) -- and ER also forces every IV to 31 on recalculation
   * (scenario.ts's defaultIvs doc), which would make the vanilla formula always
   * return the same type anyway. A real scenario toggle, same shape as
   * boostedStat/gender, not something this calculator can derive -- null when
   * unset, which leaves the move at its declared (Normal) type and surfaces an
   * unmodelled note instead of silently guessing. */
  hiddenPowerType: string | null
  isTransformed: boolean // STATUS2_TRANSFORMED (Metal Powder exemption)
  /** CanEvolve(species) (battle_util.c:7271-7278) -- Eviolite eligibility. A bare
   * "has any gEvolutionTable row", which INCLUDES the EVO_DEEVOLUTION rows, so an
   * Eeveelution or a Necrozma form qualifies. Upstream later swapped Eviolite to a
   * CanEvolveStrict() that drops the de-evolution rows and excludes Necrozma
   * itself, but that is not in the released build this data is pinned to. */
  canEvolve: boolean
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
