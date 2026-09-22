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
// The discriminator that keeps `gaps` meaningful: CAN A REAL BATTLE-START
// SOURCE SET THIS? encounters.json sets weather and terrain, trainer parties set
// status and full PP -- so those are derived, with a staleness note, because the
// value is genuinely right when the battle opens and only drifts because nothing
// updates it.
//
// Nothing sets stat stages. `createBattlerState` overwrites whatever is passed
// with the neutral set (create.ts:364), and no sim code changes a stage
// afterwards because there are no stat-change effects yet. So `statStages` is
// not "right at battle start and then stale" -- it is a value no caller can even
// supply, permanently neutral, reading as a modelled answer. It is a gap, and so
// is everything computed from it: `condition.speed` (the stat tail scales by
// stage) and the two stage counts that feed Punishment, Stored Power and Lash
// Out. Those are real damage numbers that would read zero forever.
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

import type { BattlerBattleState, BattleStatKey, ConditionBattlerContext, FieldBattleState, WeatherKind } from '../types'
import { BATTLE_STAT_KEYS } from '../types'
import type { BattleState } from './state'
import type { SimDataContext } from './dataContext'
import type { GroundingContext } from './grounding'
// Only isGravityActive: the full grounding port belongs to the simulator's own
// consumers, not to BattlerBattleState.isGrounded -- see that field's comment.
import { isGravityActive } from './grounding'
import type { TurnOrderContext } from './turnOrder'
import { TOTAL_SPEED_FULL, getBattlerTotalSpeedStat } from './turnOrder'
import {
  battlerFear,
  damagedBy,
  extraStatLevels,
  hasEmbargo,
  hasGhastlyEcho,
  hasHelpingHand,
  hasMeFirst,
  hasMiracleEye,
  hasSafePassage,
  isChargedUp,
  isConfused,
  isEnraged,
  isInfatuated,
  isInfatuatedWith,
  isTransformed,
  recentlyFainted,
  semiInvulnerableState,
  slowStartTimer,
} from './unpack'
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
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_LUCKY_CHANT,
  SIDE_STATUS_REFLECT,
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
  dataContext: SimDataContext
}

/**
 * Side screens are not a battle-start source in encounters.json: its field
 * effects contain screens as battle events (Mossdeep's BATTLE_EVENT_* entries),
 * while create.ts only zeroes the side statuses and timers. They are therefore
 * honest values only when a future turn loop maintains them; until then each is
 * reported as NEVER_UPDATED even though the zeroed placeholder is returned.
 */
export function buildFieldSides(state: BattleState, roles: CalculationRoles): FieldBattleState['sides'] {
  const side = (battlerId: number) => {
    const statuses = state.sides[battlerId & 1].statuses
    return {
      reflect: hasFlag(statuses, SIDE_STATUS_REFLECT),
      lightScreen: hasFlag(statuses, SIDE_STATUS_LIGHTSCREEN),
      auroraVeil: hasFlag(statuses, SIDE_STATUS_AURORA_VEIL),
      luckyChant: hasFlag(statuses, SIDE_STATUS_LUCKY_CHANT),
    }
  }
  return { attacker: side(roles.attackerId), defender: side(roles.defenderId) }
}

export interface BridgeResult {
  battler: BattlerBattleState
  gaps: BridgeGap[]
}

/** Every field this batch does not derive, with the reason. Declared as data so
 * the test can assert the list exactly; data-backed fields are added per call
 * below when a supplied context misses an entry. */
const BATCH1_GAPS: BridgeGap[] = [
  // --- stat stages, and the three fields computed from them ---------------
  // No battle-start source sets a stage, and createBattlerState:364 overwrites
  // whatever is passed with the neutral set, so this is not merely stale --
  // a caller cannot supply it at all.
  { field: 'statStages', reason: 'NEVER_UPDATED', detail: 'createBattlerState forces neutral and no sim code applies a stat change' },
  { field: 'condition.speed', reason: 'NEVER_UPDATED', detail: "GetBattlerTotalSpeedStat's tail scales by the Speed stage, which is permanently neutral" },
  { field: 'condition.positiveStatStageCount', reason: 'NEVER_UPDATED', detail: 'counted from statStages; feeds Punishment and Stored Power, so it reads 0 forever' },
  { field: 'condition.negativeStatStageCount', reason: 'NEVER_UPDATED', detail: 'counted from statStages; feeds Lash Out, so it reads 0 forever' },

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

]

const bareType = (type: string): string => type.replace(/^TYPE_/, '')

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
/**
 * Which battler plays which ROLE in the calculation this state is being built
 * for.
 *
 * Required, not optional, because `ConditionBattlerContext.wasDamagedThisTurnBy`
 * is role-relative -- it names the damager as 'attacker' or 'defender' OF THE
 * PENDING CALCULATION, not by battler id (see `evalDamaged`, conditions.ts:58).
 * Without this, building the state for one battler and for the other produce
 * opposite labels from the same battle state, and the function has no way to
 * know which it should give.
 *
 * `unpack.ts`'s `damagedBy` deliberately refuses to collapse this, since it has
 * no notion of a pending calculation. This is the layer that does, and this is
 * the input it needs to do it honestly rather than assuming a role.
 */
export interface CalculationRoles {
  attackerId: number
  defenderId: number
}

export function buildBattlerBattleState(state: BattleState, battlerId: number, roles: CalculationRoles, deps: BridgeDeps): BridgeResult {
  const battler = state.battlers[battlerId]
  if (!battler) throw new Error(`no battler at id ${battlerId}`)

  const mon = battler.mon
  const species = deps.dataContext.species(mon.speciesId)
  const item = mon.itemId === null ? null : deps.dataContext.item(mon.itemId)
  const missGaps: BridgeGap[] = []
  if (!species) {
    for (const field of ['canEvolveStrict', 'condition.baseSpeciesId', 'condition.heads', 'condition.isMegaEvolved', 'condition.weight']) {
      missGaps.push({ field, reason: 'NEEDS_DATA', detail: `species.json lookup missed ${mon.speciesId}` })
    }
  }
  if (mon.itemId !== null && !item) {
    for (const field of ['holdEffectStrength', 'holdEffectType', 'naturalGift', 'condition.resolvedHoldEffect', 'condition.itemResolvedHoldEffectStrength']) {
      missGaps.push({ field, reason: 'NEEDS_DATA', detail: `items.json lookup missed ${mon.itemId}` })
    }
  }
  const abilityIds = [mon.abilities.ability, ...mon.abilities.innates]
  const hasComatose = abilityIds.includes('ABILITY_COMATOSE') || abilityIds.includes('ABILITY_DREAMSCAPE')
  const hasBloodStainEffect = !mon.types.includes('GHOST') && !mon.types.includes('ROCK') && abilityIds.includes('ABILITY_BLOOD_STAIN')
  const statStages = statStagesToExternal(mon.statStages)

  /* DERIVED, but goes stale -- the same shape as weather and terrain in
   * buildFieldFacts. A trainer party really does set full PP, so this is right
   * when the battle opens; the turn loop lists PP deduction among the things it
   * deliberately does not do, so nothing decrements it afterwards. Its only
   * damage consumer is Trump Card, whose power is entirely PP-derived and which
   * will therefore read the opening PP for the whole battle. Not gapped,
   * because a real battle-start source sets it and a caller can change it. */
  const moveSlotPp: Record<string, number> = {}
  mon.moves.forEach((moveId, slot) => {
    if (moveId) moveSlotPp[moveId] = mon.pp[slot]
  })

  // Batch 2's unpackers. These are CALLED rather than hardcoded, so the value is
  // right for any state a caller does set -- but every field below them stays in
  // BATCH1_GAPS, because nothing in the sim writes the words they read. Computing
  // a value is not the same as maintaining one; see unpack.ts's own header.
  const damaged = damagedBy(battler.round)
  // The battler on the other side of THIS calculation, from the roles the
  // caller declared -- not `battlerId ^ 1`, which assumes singles and assumes
  // this battler's role.
  const opponentId = battlerId === roles.attackerId ? roles.defenderId : roles.attackerId

  const condition: ConditionBattlerContext = {
    speciesId: mon.speciesId,
    baseSpeciesId: species?.formOf ?? mon.speciesId,
    heads: species?.heads ?? 1,
    isMegaEvolved: (species?.megas?.length ?? 0) > 0 || (species?.primals?.length ?? 0) > 0,
    itemId: mon.itemId,
    resolvedHoldEffect: item?.resolvedHoldEffect ?? null,
    // Embargo only. Magic Room and Klutz are the other two causes and are not
    // read here, so this is a PARTIAL predicate -- which is a second reason it
    // stays gapped, on top of nothing writing statuses3.
    itemNegated: hasEmbargo(battler.statuses3),
    status1: status1ToSet(mon.status1),
    hasComatose,
    hasBloodStainEffect,
    isInfatuated: isInfatuated(mon.status2),
    isConfused: isConfused(mon.status2),
    isEnraged: isEnraged(mon.status2),
    // The 3-way collapse unpack.ts declines to make, made here because this is
    // the layer the caller told which battler holds which role. Each recorded
    // damager id is matched against the DECLARED roles; a damager that is
    // neither is 'none', which is what the C's own `by == BATTLER_NONE` guard
    // produces (script_conditions.cc:45).
    //
    // 'attacker' is tested first, so a battler damaged by BOTH roles this turn
    // reports 'attacker'. The C answers TRUE to either query and the enum holds
    // only one, so something must be lost; this states which. Unreachable in
    // singles, reachable in doubles.
    wasDamagedThisTurnBy: !damaged.damaged
      ? 'none'
      : damaged.byBattlerIds.includes(roles.attackerId)
        ? 'attacker'
        : damaged.byBattlerIds.includes(roles.defenderId)
          ? 'defender'
          : 'none',
    recentlyFainted: recentlyFainted(state.sides[battlerId & 1].timers),
    hp: mon.hp,
    maxHp: mon.maxHp,
    weight: species?.weight ?? 0,
    // Derived, and a real port: turnOrder.ts's GetBattlerTotalSpeedStat.
    speed: getBattlerTotalSpeedStat(state, battlerId, TOTAL_SPEED_FULL, null, deps.turnOrder, deps.statStageRatios),
    positiveStatStageCount: countStages(statStages, true),
    negativeStatStageCount: countStages(statStages, false),
    usedMovePpRemaining: null,
    helpingHand: hasHelpingHand(battler.round),
    ghastlyEcho: hasGhastlyEcho(battler.statuses4),
    chargedUp: isChargedUp(battler.statuses3),
    meFirst: hasMeFirst(battler.statuses3),
    // The VolatileStruct field, not STATUS4_FEAR -- see unpack.ts's battlerFear.
    // Each battler carries its own; basePower.ts reads the DEFENDER's.
    fear: battlerFear(battler.volatiles),
    safePassage: hasSafePassage(battler.round),
    itemResolvedHoldEffectStrength: item?.holdEffectStrength ?? null,
    lastMoveFailed: false,
  }

  const result: BattlerBattleState = {
    condition,
    types: mon.types,
    /* THE NAME IS A TRAP. `BattlerBattleState.isGrounded` is NOT "is this
     * battler grounded" -- it is the SPECIES-ONLY BASELINE, exactly
     * `!types.includes('FLYING')`, matching the existing builder
     * (features/damageCalc/scenario.ts:257) and this field's own doc in
     * engine/types.ts.
     *
     * calculate.ts:720-723 folds in the rest ITSELF: Iron Ball and Gravity as
     * forced-grounded, Air Balloon and the Levitate ability flag as
     * forced-airborne -- and the Levitate check is mould-breaker-aware. Passing
     * the full grounding answer here would double-apply all of that and INVERT
     * the one case that matters: a Levitate defender against a Mold Breaker
     * attacker is grounded (Levitate suppressed), so Earthquake hits, but the
     * full port returns airborne and the hit would read as immune.
     *
     * It would also be incoherent with this module's own gaps: the full port
     * applies Iron Ball, while calculate.ts's Iron Ball check reads
     * `condition.resolvedHoldEffect`, which batch 1 gaps to null -- half of one
     * mechanic on each side of the line.
     *
     * sim/grounding.ts's full port is still the right answer for the
     * SIMULATOR's own consumers, which is what turnOrder.ts's Swamp gate uses.
     * Two different questions, two different functions; only this one belongs
     * in this field. */
    isGrounded: !mon.types.includes('FLYING'),
    semiInvulnerable: semiInvulnerableState(battler.statuses3),
    abilityOn: false,
    gender: mon.gender,
    boostedStat: null,
    // Derived: the turn loop maintains this one.
    alliesFainted: state.sides[battlerId & 1].faintedCount,
    slowStartTimer: slowStartTimer(battler.volatiles),
    level: mon.level,
    nature: mon.nature,
    rawStats: mon.rawStats,
    statStages,
    extraStatLevel: extraStatLevels(battler.volatiles),
    holdEffectStrength: item?.holdEffectStrength ?? null,
    holdEffectType: item?.holdEffectType ? bareType(item.holdEffectType) : null,
    naturalGift: item?.naturalGift ? { power: item.naturalGift.power, type: bareType(item.naturalGift.type) } : null,
    hiddenPowerType: mon.hiddenPowerType,
    isTransformed: isTransformed(mon.status2),
    canEvolveStrict: (species?.evolutions?.length ?? 0) > 0,
    isInfatuatedWithOpponent: isInfatuatedWith(mon.status2, opponentId),
    moveSlotPp,
    abilitySlots: mon.abilities,
    hasMiracleEye: hasMiracleEye(battler.statuses3),
  }

  return { battler: result, gaps: [...BATCH1_GAPS, ...missGaps] }
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
