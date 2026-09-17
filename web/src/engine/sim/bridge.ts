// Bridge, batch 1: sim state -> the damage calculator's scenario shape.
//
// The calculator's `BattlerBattleState` carries 53 fields per battler (23 of its
// own plus 30 on `ConditionBattlerContext`); `SimBattleMon` has 17. This batch
// derives the ones that need neither a data lookup nor state the sim never
// updates, and reports EVERY other field as a gap.
//
// ## Presence in the type is not evidence of being populated
//
// This is the rule the whole module is built around, and it is the reason the
// return shape is `{ battler, gaps }` rather than just a battler.
//
// Most of the calculator's per-battler facts come from `gStatuses3/4`,
// `gVolatileStructs` and `gRoundStructs`. The sim state model has all of those,
// correctly shaped and correctly zeroed. It is also true that NOTHING in the sim
// ever writes them: the turn loop writes `mon.hp` and `sides[].faintedCount`,
// and that is all. So a bridge that mapped them would type-check, would be
// correct on turn one (zero really is right at battle start), and would then be
// silently wrong from turn two onward for every battler a move should have
// affected -- reading as a modelled `false` rather than as a missing answer.
//
// That is the same failure as a seam defaulting to the wrong side, a test that
// cannot fail, and a coverage number that reads the same either way. It is the
// most convincing disguise of the four, because the field IS there.
//
// So: if the sim does not maintain it, it is a GAP, not a value. Gapped fields
// still receive a placeholder -- the calculator's types require one -- but the
// placeholder is never evidence of anything, and `gaps` is the record. A caller
// that ignores `gaps` is claiming a completeness this module did not give it.
//
// The distinction that keeps `gaps` meaningful: field-level facts a CALLER
// legitimately supplies at battle start (weather, terrain, side statuses, which
// encounters.json actually sets) are derived, not gapped. Per-battler state that
// only ever arises from move and ability effects the sim does not run is gapped.
//
// ## What this batch retires
//
// Worth stating because a diff will not show it. Seven of the calculator's
// inputs are manual toggles ONLY because the calculator has never had a
// simulation behind it -- `attackerActsFirst`, `defenderIsSwitching`,
// `alliesFainted`, `beatUpBaseAttack`, `beatUpHitCount`, `magnitudeTier`, and
// `isGrounded`/`speed`. The sim can answer them from real state: it knows the
// turn order, the chosen actions, the party roster, and it has a seeded RNG.
// This batch already supplies `isGrounded`, `speed` and `alliesFainted` that
// way. The bridge is not plumbing; it retires guesses, and that is the first
// concrete payoff of the simulator work.

import type { BattlerBattleState, BattleStatKey, ConditionBattlerContext, WeatherKind } from '../types'
import { BATTLE_STAT_KEYS } from '../types'
import type { BattleState } from './state'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded, isGravityActive } from './grounding'
import type { TurnOrderContext } from './turnOrder'
import { TOTAL_SPEED_FULL, getBattlerTotalSpeedStat } from './turnOrder'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_POISON,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_FOG_PERMANENT,
  WEATHER_FOG_TEMPORARY,
  WEATHER_HAIL_PERMANENT,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_NONE,
  WEATHER_RAIN_DOWNPOUR,
  WEATHER_RAIN_PERMANENT,
  WEATHER_RAIN_PRIMAL,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_PERMANENT,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_STRONG_WINDS,
  WEATHER_SUN_PERMANENT,
  WEATHER_SUN_PRIMAL,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/** Why a field could not be honestly derived. Four reasons, kept distinct
 * because they have different fixes and different lifetimes. */
export const GAP_REASONS = ['NEVER_UPDATED', 'NO_SOURCE', 'NEEDS_DATA', 'AMBIGUOUS'] as const
export type GapReason = (typeof GAP_REASONS)[number]

export interface BridgeGap {
  /** Dotted path into the scenario, e.g. `condition.weight`. */
  field: string
  reason: GapReason
  detail: string
}

/** Formats gaps for the damage engine's own `unmodelled[]` channel, so a
 * resolver can pass them straight through rather than inventing a second
 * vocabulary for the same idea. */
export function gapsToUnmodelled(gaps: BridgeGap[]): string[] {
  return gaps.map((g) => `${g.field}: ${g.detail} (${g.reason})`)
}

// ---------------------------------------------------------------------------
// The three conversions this batch settles
// ---------------------------------------------------------------------------

/**
 * Stat stage, internal 0..12 -> external -6..+6.
 *
 * The C stores stages with DEFAULT_STAT_STAGE (6) as neutral
 * (include/constants/pokemon.h:122-124); `BattlerBattleState.statStages` uses
 * the -6..+6 form the UI shows. The conversion is one subtraction, and getting
 * its direction or offset wrong is silent across every stat at once -- which is
 * why its tests cover both ends and the neutral point rather than one
 * representative value.
 */
export function statStageToExternal(internal: number): number {
  return internal - DEFAULT_STAT_STAGE
}

const STAT_INDEX_BY_KEY: Record<BattleStatKey, number> = {
  atk: STAT_ATK,
  def: STAT_DEF,
  spatk: STAT_SPATK,
  spdef: STAT_SPDEF,
  spe: STAT_SPEED,
}

/** The 8-entry internal array, as the 5-key external record the calculator
 * wants. Accuracy and evasion have no place in `BattleStatKey` and are dropped;
 * they are read by the AI, not the damage path. */
export function statStagesToExternal(internal: number[]): Record<BattleStatKey, number> {
  const out = {} as Record<BattleStatKey, number>
  for (const key of BATTLE_STAT_KEYS) out[key] = statStageToExternal(internal[STAT_INDEX_BY_KEY[key]] ?? DEFAULT_STAT_STAGE)
  return out
}

/** Every weather bit that maps to exactly one WeatherKind. Sandstorm, hail and
 * fog each collapse two intensity bits onto one kind, because the calculator's
 * WEATHER_KINDS has no separate tiers for them. */
const WEATHER_BIT_TO_KIND: [number, WeatherKind][] = [
  [WEATHER_SUN_TEMPORARY, 'SUN_TEMPORARY'],
  [WEATHER_SUN_PERMANENT, 'SUN_PERMANENT'],
  [WEATHER_SUN_PRIMAL, 'SUN_PRIMAL'],
  [WEATHER_RAIN_TEMPORARY, 'RAIN_TEMPORARY'],
  [WEATHER_RAIN_PERMANENT, 'RAIN_PERMANENT'],
  [WEATHER_RAIN_PRIMAL, 'RAIN_PRIMAL'],
  [WEATHER_SANDSTORM_TEMPORARY, 'SANDSTORM'],
  [WEATHER_SANDSTORM_PERMANENT, 'SANDSTORM'],
  [WEATHER_HAIL_TEMPORARY, 'HAIL'],
  [WEATHER_HAIL_PERMANENT, 'HAIL'],
  [WEATHER_FOG_TEMPORARY, 'FOG'],
  [WEATHER_FOG_PERMANENT, 'FOG'],
  [WEATHER_STRONG_WINDS, 'STRONG_WINDS'],
]

/**
 * gBattleWeather (a bitfield) -> WeatherKind (one string).
 *
 * The collapse policy, and the evidence for it. `TryChangeBattleWeather`
 * (src/battle_util.c:3730-3731) sets weather with a plain ASSIGNMENT --
 * `gBattleWeather = sWeatherFlagsInfo[weatherEnumId][0]` -- not an OR. The game
 * therefore holds at most one weather bit at a time, and the `WEATHER_*_ANY`
 * masks exist for convenient READING, not because several kinds coexist.
 *
 * So: no bits is NONE, exactly one recognised bit maps to its kind, and more
 * than one bit is a state the game's own setter cannot produce. That last case
 * is reported as AMBIGUOUS rather than resolved by a precedence rule, because
 * any precedence would be invented -- there is no code in the C that reconciles
 * two simultaneous kinds, since it never has to.
 *
 * WEATHER_RAIN_DOWNPOUR is marked unused in the header
 * (include/constants/battle.h:394) and has no WeatherKind counterpart, so it is
 * a gap too rather than being silently folded into rain.
 */
export function weatherFromBitfield(bits: number): { weather: WeatherKind; gap: BridgeGap | null } {
  if (bits === WEATHER_NONE) return { weather: 'NONE', gap: null }

  const matched = WEATHER_BIT_TO_KIND.filter(([bit]) => hasFlag(bits, bit))
  const known = matched.reduce((acc, [bit]) => acc | bit, 0)
  const unknownBits = (bits & ~known) >>> 0

  if (unknownBits & WEATHER_RAIN_DOWNPOUR) {
    return {
      weather: 'NONE',
      gap: { field: 'field.weather', reason: 'NO_SOURCE', detail: 'WEATHER_RAIN_DOWNPOUR is unused in the header and has no WeatherKind counterpart' },
    }
  }
  if (matched.length === 0) {
    return { weather: 'NONE', gap: { field: 'field.weather', reason: 'AMBIGUOUS', detail: `unrecognised weather bits 0x${bits.toString(16)}` } }
  }

  const kinds = new Set(matched.map(([, kind]) => kind))
  if (kinds.size > 1) {
    return {
      weather: 'NONE',
      gap: {
        field: 'field.weather',
        reason: 'AMBIGUOUS',
        detail: `${kinds.size} weather kinds set at once (${[...kinds].join(', ')}); TryChangeBattleWeather assigns, so the game cannot produce this and defines no precedence`,
      },
    }
  }
  return { weather: [...kinds][0], gap: null }
}

/** The bare STATUS1_* names currently set, as `ConditionBattlerContext.status1`
 * wants them.
 *
 * The SLEEP and TOXIC counters are deliberately discarded. `STATUS1_SLEEP` is a
 * 3-bit turn count and `STATUS1_TOXIC_COUNTER` a 4-bit one, but the damage path
 * reads neither -- it only asks whether the status is present. Stated here so
 * nobody later assumes the counters survived the trip: they do not, and a
 * mechanic that needs them (Nightmare's sleep dependency, toxic's ramping
 * damage) must read `battler.mon.status1` directly rather than this set. */
export function status1ToSet(packed: number): Set<string> {
  const out = new Set<string>()
  // Nonzero sleep turns means asleep; the count itself is dropped.
  if ((packed & STATUS1_SLEEP) !== 0) out.add('STATUS1_SLEEP')
  if (hasFlag(packed, STATUS1_POISON)) out.add('STATUS1_POISON')
  if (hasFlag(packed, STATUS1_BURN)) out.add('STATUS1_BURN')
  if (hasFlag(packed, STATUS1_FREEZE)) out.add('STATUS1_FREEZE')
  if (hasFlag(packed, STATUS1_PARALYSIS)) out.add('STATUS1_PARALYSIS')
  if (hasFlag(packed, STATUS1_TOXIC_POISON)) out.add('STATUS1_TOXIC_POISON')
  if (hasFlag(packed, STATUS1_FROSTBITE)) out.add('STATUS1_FROSTBITE')
  if (hasFlag(packed, STATUS1_BLEED)) out.add('STATUS1_BLEED')
  return out
}

/** gFieldStatuses' terrain bits -> the calculator's bare TERRAIN_* name. Only
 * one terrain bit is ever set (the C clears the others when setting one), so
 * unlike weather this needs no ambiguity branch. */
export function terrainFromFieldStatuses(statuses: number): string | null {
  if (hasFlag(statuses, STATUS_FIELD_GRASSY_TERRAIN)) return 'TERRAIN_GRASSY'
  if (hasFlag(statuses, STATUS_FIELD_MISTY_TERRAIN)) return 'TERRAIN_MISTY'
  if (hasFlag(statuses, STATUS_FIELD_ELECTRIC_TERRAIN)) return 'TERRAIN_ELECTRIC'
  if (hasFlag(statuses, STATUS_FIELD_PSYCHIC_TERRAIN)) return 'TERRAIN_PSYCHIC'
  if (hasFlag(statuses, STATUS_FIELD_TOXIC_TERRAIN)) return 'TERRAIN_TOXIC'
  return null
}

// ---------------------------------------------------------------------------
// The battler build
// ---------------------------------------------------------------------------

export interface BridgeDeps {
  grounding: GroundingContext
  /** Reused for the Speed stat, which turnOrder.ts already ports in full. */
  turnOrder: TurnOrderContext
  statStageRatios: [number, number][]
}

export interface BridgeResult {
  battler: BattlerBattleState
  gaps: BridgeGap[]
}

/** Every field this batch does not derive, with the reason. Declared as data so
 * the test can assert the list exactly, and so batches 2 and 3 delete entries
 * from one place as they fill them in. */
const BATCH1_GAPS: BridgeGap[] = [
  // --- state the sim has, correctly zeroed, and never updates -------------
  { field: 'semiInvulnerable', reason: 'NEVER_UPDATED', detail: 'gStatuses3 semi-invulnerability; no sim code writes statuses3' },
  { field: 'slowStartTimer', reason: 'NEVER_UPDATED', detail: 'volatiles.slowStartTimer; no sim code writes volatiles' },
  { field: 'extraStatLevel', reason: 'NEVER_UPDATED', detail: "volatiles.extra*Level; no sim code writes volatiles" },
  { field: 'isTransformed', reason: 'NEVER_UPDATED', detail: 'status2 TRANSFORMED; no sim code writes status2' },
  { field: 'isInfatuatedWithOpponent', reason: 'NEVER_UPDATED', detail: 'status2 INFATUATED_WITH; no sim code writes status2' },
  { field: 'hasMiracleEye', reason: 'NEVER_UPDATED', detail: 'gStatuses3 MIRACLE_EYED; no sim code writes statuses3' },
  { field: 'condition.itemNegated', reason: 'NEVER_UPDATED', detail: 'Embargo/Magic Room; no sim code writes statuses3 or field statuses mid-battle' },
  { field: 'condition.isInfatuated', reason: 'NEVER_UPDATED', detail: 'status2 INFATUATION' },
  { field: 'condition.isConfused', reason: 'NEVER_UPDATED', detail: 'status2 CONFUSION' },
  { field: 'condition.isEnraged', reason: 'NEVER_UPDATED', detail: 'status2 ENRAGED' },
  { field: 'condition.wasDamagedThisTurnBy', reason: 'NEVER_UPDATED', detail: 'gRoundStructs physicalDmg/specialDmg; the loop never writes RoundState' },
  { field: 'condition.recentlyFainted', reason: 'NEVER_UPDATED', detail: 'gSideTimers.retaliateTimer; no sim code writes side timers' },
  { field: 'condition.helpingHand', reason: 'NEVER_UPDATED', detail: 'gRoundStructs.helpingHand; the loop never writes RoundState' },
  { field: 'condition.ghastlyEcho', reason: 'NEVER_UPDATED', detail: 'gStatuses4 GHASTLY_ECHO' },
  { field: 'condition.chargedUp', reason: 'NEVER_UPDATED', detail: 'gStatuses3 CHARGED_UP' },
  { field: 'condition.meFirst', reason: 'NEVER_UPDATED', detail: 'gStatuses3 ME_FIRST' },
  { field: 'condition.fear', reason: 'NEVER_UPDATED', detail: 'volatiles.fear' },
  { field: 'condition.safePassage', reason: 'NEVER_UPDATED', detail: 'gRoundStructs.safePassage; the loop never writes RoundState' },

  // --- no honest source anywhere ------------------------------------------
  { field: 'abilityOn', reason: 'NO_SOURCE', detail: 'one boolean standing for per-ability activation state; volatiles.abilityState has no ability-to-slot mapping' },
  { field: 'boostedStat', reason: 'NO_SOURCE', detail: "Protosynthesis/Quark Drive's chosen stat; nothing in the sim tracks paradox activation" },
  { field: 'condition.lastMoveFailed', reason: 'NO_SOURCE', detail: 'gBattleStruct->lastMoveFailed is absent from the state model entirely' },

  // --- needs the data context (batch 3) -----------------------------------
  { field: 'holdEffectStrength', reason: 'NEEDS_DATA', detail: 'items.json lookup' },
  { field: 'holdEffectType', reason: 'NEEDS_DATA', detail: 'items.json lookup' },
  { field: 'naturalGift', reason: 'NEEDS_DATA', detail: 'items.json lookup' },
  { field: 'canEvolveStrict', reason: 'NEEDS_DATA', detail: 'species.json evolutions' },
  { field: 'condition.baseSpeciesId', reason: 'NEEDS_DATA', detail: 'species.json formOf' },
  { field: 'condition.heads', reason: 'NEEDS_DATA', detail: 'species.json heads' },
  { field: 'condition.isMegaEvolved', reason: 'NEEDS_DATA', detail: 'species.json megas/primals reverse lookup' },
  { field: 'condition.resolvedHoldEffect', reason: 'NEEDS_DATA', detail: 'items.json lookup' },
  { field: 'condition.weight', reason: 'NEEDS_DATA', detail: 'species.json weight' },
  { field: 'condition.itemResolvedHoldEffectStrength', reason: 'NEEDS_DATA', detail: 'items.json lookup' },
  { field: 'condition.hasComatose', reason: 'NEEDS_DATA', detail: 'ability identity check' },
  { field: 'condition.hasBloodStainEffect', reason: 'NEEDS_DATA', detail: 'ability identity check' },
]

function countStages(stages: Record<BattleStatKey, number>, positive: boolean): number {
  return BATTLE_STAT_KEYS.reduce((n, k) => n + (positive ? (stages[k] > 0 ? stages[k] : 0) : stages[k] < 0 ? -stages[k] : 0), 0)
}

/**
 * Builds as much of one battler's scenario state as this batch can honestly
 * derive, and reports the rest.
 *
 * `gaps` is not advisory. A caller that wants a trustworthy damage number must
 * either find it empty or surface it -- `gapsToUnmodelled` exists for exactly
 * that, so the engine's own channel carries it.
 */
export function buildBattlerBattleState(state: BattleState, battlerId: number, deps: BridgeDeps): BridgeResult {
  const battler = state.battlers[battlerId]
  if (!battler) throw new Error(`no battler at id ${battlerId}`)

  const mon = battler.mon
  const statStages = statStagesToExternal(mon.statStages)
  const moveSlotPp: Record<string, number> = {}
  mon.moves.forEach((moveId, slot) => {
    if (moveId) moveSlotPp[moveId] = mon.pp[slot]
  })

  const condition: ConditionBattlerContext = {
    speciesId: mon.speciesId,
    // GAP -- see BATCH1_GAPS. Placeholder is the species itself, which is right
    // only for a non-form; it is not evidence.
    baseSpeciesId: mon.speciesId,
    heads: 1,
    isMegaEvolved: false,
    itemId: mon.itemId,
    resolvedHoldEffect: null,
    itemNegated: false,
    status1: status1ToSet(mon.status1),
    hasComatose: false,
    hasBloodStainEffect: false,
    isInfatuated: false,
    isConfused: false,
    isEnraged: false,
    wasDamagedThisTurnBy: 'none',
    recentlyFainted: false,
    hp: mon.hp,
    maxHp: mon.maxHp,
    weight: 0,
    // Derived, and a real port: turnOrder.ts's GetBattlerTotalSpeedStat.
    speed: getBattlerTotalSpeedStat(state, battlerId, TOTAL_SPEED_FULL, null, deps.turnOrder, deps.statStageRatios),
    positiveStatStageCount: countStages(statStages, true),
    negativeStatStageCount: countStages(statStages, false),
    usedMovePpRemaining: null,
    helpingHand: false,
    ghastlyEcho: false,
    chargedUp: false,
    meFirst: false,
    fear: false,
    safePassage: false,
    itemResolvedHoldEffectStrength: null,
    lastMoveFailed: false,
  }

  const result: BattlerBattleState = {
    condition,
    types: mon.types,
    // Derived, and a real port: sim/grounding.ts.
    isGrounded: isBattlerGrounded(state, battlerId, deps.grounding),
    semiInvulnerable: 'NONE',
    abilityOn: false,
    gender: mon.gender,
    boostedStat: null,
    // Derived: the turn loop maintains this one.
    alliesFainted: state.sides[battlerId & 1].faintedCount,
    slowStartTimer: 0,
    level: mon.level,
    nature: mon.nature,
    rawStats: mon.rawStats,
    statStages,
    extraStatLevel: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    holdEffectStrength: null,
    holdEffectType: null,
    naturalGift: null,
    hiddenPowerType: mon.hiddenPowerType,
    isTransformed: false,
    canEvolveStrict: false,
    isInfatuatedWithOpponent: false,
    moveSlotPp,
    abilitySlots: mon.abilities,
    hasMiracleEye: false,
  }

  return { battler: result, gaps: [...BATCH1_GAPS] }
}

/** The field-level facts this batch derives. Unlike the per-battler state
 * above, these are legitimately supplied by the caller at battle start
 * (encounters.json sets weather and terrain for real fights), so they are
 * derived rather than gapped -- but nothing in the sim UPDATES them mid-battle
 * either, which is why a weather-setting move will not change this until the
 * batch that runs move effects lands. */
export function buildFieldFacts(state: BattleState, deps: BridgeDeps): { weather: WeatherKind; terrain: string | null; gravityActive: boolean; gaps: BridgeGap[] } {
  const { weather, gap } = weatherFromBitfield(state.field.weather)
  return {
    weather,
    terrain: terrainFromFieldStatuses(state.field.statuses),
    gravityActive: isGravityActive(state, deps.grounding),
    gaps: gap ? [gap] : [],
  }
}
