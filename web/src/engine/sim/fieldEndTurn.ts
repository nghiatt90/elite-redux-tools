// DoFieldEndTurnEffects, src/battle_util.c:1768-2318 -- the field-wide
// end-of-turn ladder. BattleTurnPassed (battle_main.c:3465-3481) runs this
// BEFORE DoBattlerEndTurnEffects (endTurn.ts) -- see that module's own header
// for the exact call-order citation. Called from turn.ts.
//
// LOOP STRUCTURE (read, not assumed): the same turnCountersTracker/
// turnSideTracker suspend-and-resume shape as endTurn.ts's own battler ladder
// (BattleScriptExecute yields control back to the caller mid-case, and
// DoFieldEndTurnEffects is re-entered on the next call, picking up where
// turnCountersTracker left off). A side-looped case (e.g. ENDTURN_REFLECT)
// that hits its `effect++` branch for side 0 returns immediately WITHOUT
// advancing turnCountersTracker, so the SAME case runs again next call and
// finishes side 1 then. Over the whole sequence of calls every case's full
// body runs for both sides -- there is no game-visible branch where a side is
// skipped because another side "used up" the turn, only interleaving with
// message display. This port applies every case's full effect in one pass,
// exactly as endTurn.ts's own header already established for the battler
// ladder's analogous mechanism.
//
// THE ENUM ORDER IS NOT THE CASE ORDER IN THE SOURCE FILE: Safeguard and
// Lucky Chant are swapped (enum has LUCKY_CHANT before SAFEGUARD; the `case`
// blocks in battle_util.c appear MIST, SAFEGUARD, LUCKY_CHANT, TAILWIND --
// SAFEGUARD before LUCKY_CHANT), and Gravity/Water Sport/Mud Sport sit AFTER
// the five terrains in the file even though the enum lists them BEFORE the
// terrains. Execution order is the ENUM order (switch dispatches on
// turnCountersTracker, which only ever advances by the enum's own ++), so
// this module is written and documented in ENUM order, matching each case's
// real line citation in the file regardless of where it physically sits.
//
// ---------------------------------------------------------------------------
// ENDTURN_FIELD_* enum, battle_util.c:1730-1766, and what this batch does.
//
//   ENDTURN_ORDER            PORTED (approximated) -- SortBattlersBySpeed
//                            (:8468-8476) calls SortBattlersExcept(arr, TRUE,
//                            0), a bubble sort with an RNG-broken tie at every
//                            adjacent comparison. This port instead builds the
//                            order via repeated turnOrder.ts getFastestBattler
//                            calls (ignoreChosenMoves=true, excluding battlers
//                            already placed) -- the SAME reservoir tie-break
//                            turnOrder.ts already uses elsewhere, which gives
//                            the correct PROBABILITY DISTRIBUTION over
//                            orderings but not the literal bubble-sort RNG
//                            call SEQUENCE SortBattlersExcept makes. Per the
//                            plan's "statistically faithful, not bit-exact"
//                            decision (state.ts's own header) this is judged
//                            sufficient; a caller wanting the exact RNG trace
//                            would need a literal SortBattlersExcept port.
//                            gBattlerAttacker/gBattlerTarget's pre-loop
//                            defaulting (:1774-1777) has no port -- it only
//                            selects a message/animation target and every
//                            later case overwrites it with its own value.
//   ENDTURN_REFLECT          PORTED.
//   ENDTURN_LIGHT_SCREEN     PORTED.
//   ENDTURN_AURORA_VEIL      PORTED (Aurora Veil timer + Spider Web timer,
//                            both real state; Spider Web is folded into this
//                            same case in the C, :1901-1911).
//   ENDTURN_MIST             PORTED.
//   ENDTURN_LUCKY_CHANT      PORTED.
//   ENDTURN_SAFEGUARD        PORTED.
//   ENDTURN_TAILWIND         PORTED.
//   ENDTURN_WISH             Unreachable -- no field anywhere in this state
//                            model corresponds to gWishFutureKnock.wishCounter
//                            or its heal amount (BattlerState/SideState have
//                            no such field); there is no real condition to
//                            gate a runtime gap on, so none is emitted (same
//                            treatment as endTurn.ts's ENDTURN_LEECH_SEED).
//   ENDTURN_RAIN             PORTED (timer only; rain never damages).
//   ENDTURN_SANDSTORM        PORTED (timer + Cmd_weatherdamage's damage, see
//                            below).
//   ENDTURN_SUN              PORTED (timer only; sun never damages).
//   ENDTURN_HAIL              PORTED (timer + damage, see below).
//   ENDTURN_FOG               Gapped -- the timer/fogReturnTimer bookkeeping
//                            is real state and portable, but the "continues"
//                            branch runs `dofogstatdrops` (BattleScript_
//                            FogContinues, data/battle_scripts_1.s:7369-7373),
//                            an actual per-battler stat-stage change with no
//                            port anywhere in this codebase's stat-stage
//                            machinery. Gapped whenever Fog is actually active
//                            or about to return (state.field.weather has a
//                            FOG bit, or fogReturnTimer is nonzero) rather
//                            than mutating the timer only halfway.
//   ENDTURN_GRAVITY          PORTED.
//   ENDTURN_WATER_SPORT      PORTED. NOTE: the C's own condition has NO
//                            `!started.waterSport` gate (unlike ENDTURN_MUD_
//                            SPORT immediately below it, which does check
//                            `!started.mudSport`) even though FieldBeganThisTurn
//                            declares a `waterSport` bit -- an asymmetry
//                            confirmed by reading both case bodies side by
//                            side, not assumed, and reproduced rather than
//                            "fixed".
//   ENDTURN_MUD_SPORT        PORTED (with the started.mudSport gate).
//   ENDTURN_TRICK_ROOM       PORTED (Trick Room timer AND, in the SAME case,
//                            Inverse Room's timer -- :1961-1975 folds both).
//   ENDTURN_WONDER_ROOM      PORTED.
//   ENDTURN_MAGIC_ROOM       PORTED. NOTE: unlike every other room/terrain
//                            case, this one has NO `!started.magicRoom` gate
//                            at all (:2019-2024) even though FieldBeganThisTurn
//                            declares a `magicRoom` bit -- confirmed by
//                            reading the case body, reproduced as written.
//   ENDTURN_ELECTRIC_TERRAIN PORTED.
//   ENDTURN_MISTY_TERRAIN    PORTED.
//   ENDTURN_GRASSY_TERRAIN   PORTED (timer only) -- the heal itself is gapped:
//                            `checkgrassyterrainheal` (data/battle_scripts_1.
//                            s:10152) has NO handler anywhere in the pinned
//                            eliteredux-source checkout's src/ (grepped the
//                            whole tree; only the .s call site exists), so its
//                            heal amount and immunities cannot be transcribed,
//                            only guessed -- gapped rather than guessed.
//   ENDTURN_PSYCHIC_TERRAIN  PORTED.
//   ENDTURN_TOXIC_TERRAIN    PORTED (timer only, including the `!IsAbilityOnField
//                            (ABILITY_STENCH)` gate on the DECREMENT itself,
//                            :2126-2127 -- Stench on the field keeps toxic
//                            terrain's timer from ticking down at all, not
//                            just from damaging). The damage loop is gapped:
//                            `hpfractiontodamage` (data/battle_scripts_1.s:
//                            10168, BattleScript_ToxicTerrainDamages) has the
//                            same problem as checkgrassyterrainheal above --
//                            no handler in src/battle_script_commands.c.
//                            Gapped per battler, only when this battler's own
//                            real damage condition (alive, not Magic-Guard-
//                            protected, terrain-affected via the real
//                            isBattlerGrounded port, not Stench-immune, not
//                            Poison/Steel-typed) is actually true.
//   ENDTURN_ION_DELUGE       PORTED (unconditional clear every turn, :2143).
//   ENDTURN_FAIRY_LOCK       PORTED.
//   ENDTURN_RETALIATE        PORTED (both sides, no started gate -- plain
//                            `if (timer > 0) timer--`).
//   ENDTURN_RAINBOW          PORTED. NOTE: rainbowTimer is ALSO decremented
//                            again, unconditionally of THIS case ever running,
//                            by ENDTURN_MISC_SIDE_TIMERS's DECREMENT_SIDE_TIMER
//                            macro below (:2313) -- a genuine double-decrement
//                            in the C, confirmed by reading both case bodies;
//                            reproduced, not fixed. There is no SIDE_STATUS_
//                            RAINBOW bit (constants.ts has none) -- presence is
//                            governed purely by rainbowTimer > 0.
//   ENDTURN_SEA_OF_FIRE      PORTED.
//   ENDTURN_SWAMP            PORTED, including the Monotype Champion WATER
//                            exemption for the player's own side (:2213-2214).
//   ENDTURN_QUASH            PORTED (field-wide, per turn.ts's own quash
//                            invariant).
//   ENDTURN_SMOKESCREEN      PORTED.
//   ENDTURN_CLEARSKIES       PORTED (timer only) -- the actual "which weather
//                            just ended" resolution
//                            (BattleScript_ClearSkiesEnds -> BattleScript_
//                            MoveWeatherChangeRet -> BattleScript_
//                            OnWeatherChange) does not, in the portion of this
//                            codebase's pinned source reachable from here,
//                            show WHERE gBattleWeather itself gets cleared --
//                            gapped whenever clearSkiesTimer actually reaches
//                            zero this call, rather than guessing which bits
//                            a chain of `goto`s three scripts deep would
//                            clear.
//   ENDTURN_MISC_SIDE_TIMERS PORTED (quickGuardTimer and rainbowTimer, both
//                            sides, both started-gated -- see ENDTURN_RAINBOW's
//                            note above for the rainbowTimer double-decrement
//                            this case is one half of).
//   ENDTURN_FIELD_COUNT      The ladder's own terminal case -- not a residual
//                            effect, nothing to port.
//
// WEATHER DAMAGE (Cmd_weatherdamage, battle_script_commands.c:10397-10415,
// reached via BattleScript_DamagingWeatherContinues, data/battle_scripts_1.s:
// 7313-7338): `IsBattlerAlive(b) && WEATHER_HAS_EFFECT && !IsMagicGuardProtected(b)`
// gates BOTH sandstorm and hail; WEATHER_HAS_EFFECT (include/battle_util.h:45-46)
// is `!clearSkiesTimer && !IsAbilityOnField(CLOUD_NINE) && !IsAbilityOnField
// (AIR_LOCK) && !IsAbilityOnField(CLUELESS)` -- all real, computed for real
// below (isAbilityOnField scans all alive battlers with NO mold-breaker
// exception applied, same precedent as turn.ts's isAbilityAliveOnOpposingSide;
// no gap is needed because this phase has no "attacker" for Mold Breaker to
// belong to). Sand immunity (IsSandImmune, :10376-10385) and hail immunity
// (IsHailImmune, :10388-10395) are ported for every real-state clause (types,
// STATUS3_UNDERGROUND/UNDERWATER, Safety Goggles, Magic Guard, the ability's
// own sandImmune/hailImmune bitfield from abilityHooks.json) EXCEPT Desert
// Cloak's ally check (IsSandImmune's last clause) -- BATTLE_PARTNER(battler)
// never exists in this singles-only engine (battlersCount === 2), so that
// clause can never be true here and is Unreachable by construction, not
// gapped. Damage is applied in `order` (this case's own ENDTURN_ORDER result,
// which IS gBattlerByTurnOrder for the rest of this ladder AND for
// endTurn.ts's battler ladder afterwards -- turn.ts threads it through).
//
// RNG: only ENDTURN_ORDER draws (see its own note above, via
// getFastestBattler's tie-break). No other case in this module calls
// Random() in the C -- checked every branch by name.

import type { BattleState, BattlerState } from './state'
import type { TurnOrderContext } from './turnOrder'
import { getFastestBattler } from './turnOrder'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import type { SimDataContext } from './dataContext'
import type { AbilitySlots } from '../abilities/dispatch'
import { battlerHasAbility } from '../abilities/dispatch'
import { isMagicGuardProtected, type EndTurnEffectResult } from './endTurn'
import {
  hasFlag,
  clearFlag,
  B_SIDE_PLAYER,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_MIST,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_LUCKY_CHANT,
  SIDE_STATUS_TAILWIND,
  SIDE_STATUS_SMOKESCREEN,
  WEATHER_RAIN_ANY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_RAIN_DOWNPOUR,
  WEATHER_RAIN_PERMANENT,
  WEATHER_RAIN_PRIMAL,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SANDSTORM_PERMANENT,
  WEATHER_SUN_ANY,
  WEATHER_SUN_TEMPORARY,
  WEATHER_SUN_PERMANENT,
  WEATHER_SUN_PRIMAL,
  WEATHER_HAIL_ANY,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_HAIL_PERMANENT,
  WEATHER_FOG_ANY,
  STATUS_FIELD_TRICK_ROOM,
  STATUS_FIELD_INVERSE_ROOM,
  STATUS_FIELD_WONDER_ROOM,
  STATUS_FIELD_MAGIC_ROOM,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_MISTY_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_TERRAIN_PERMANENT,
  STATUS_FIELD_WATERSPORT,
  STATUS_FIELD_MUDSPORT,
  STATUS_FIELD_GRAVITY,
  STATUS_FIELD_ION_DELUGE,
  STATUS_FIELD_FAIRY_LOCK,
  STATUS3_UNDERGROUND,
  STATUS3_UNDERWATER,
  STATUS3_SEMI_INVULNERABLE,
} from './constants'

/** IsBattlerAlive, src/battle_util.c:6685-6694 -- duplicated (rather than
 * imported from turn.ts) solely to avoid a circular import: turn.ts imports
 * THIS module to call runFieldEndTurnEffects. Kept in lockstep with turn.ts's
 * own isBattlerAlive by inspection; both are three lines transcribing the same
 * three C conditions. */
function isAlive(state: BattleState, battlerId: number): boolean {
  if (battlerId >= state.battlersCount) return false
  const battler = state.battlers[battlerId]
  if (!battler) return false
  if (battler.mon.hp === 0) return false
  return !(state.absentBattlerFlags & (1 << battlerId))
}

/** IsAbilityOnField, src/battle_util.c:4803-4811 -- true if ANY alive battler
 * holds this ability. `BattlerHasAbility(i, ability, TRUE)`'s mold-breaker
 * exception is not applied (no gap needed: this phase has no attacking
 * battler for Mold Breaker to belong to, so the exception can never actually
 * differ from the unsuppressed answer here). */
function isAbilityOnField(state: BattleState, abilityId: string): boolean {
  for (let i = 0; i < state.battlersCount; i++) {
    if (!isAlive(state, i)) continue
    const battler = state.battlers[i]
    if (battler && battlerHasAbility(battler.mon.abilities, abilityId, () => false)) return true
  }
  return false
}

/** RETURN_ABILITY_IF_FLAG(battler, FALSE, sandImmune) / hailImmune --
 * abilityHooks.json's own bitfields, transcribed by id (same precedent as
 * endTurn.ts's ENDTURN_ABILITY_IDS): every ability whose `bitfields.sandImmune`
 * / `bitfields.hailImmune` is TRUE, checked against ALL FOUR ability slots
 * (not just the chosen one), matching RETURN_ABILITY_IF_FLAG's own
 * BattlerHasAbilityFlag scan. */
const SAND_IMMUNE_ABILITY_IDS = new Set([
  'ABILITY_DESERT_CLOAK',
  'ABILITY_DESERT_SPIRIT',
  'ABILITY_DUNE_TERROR',
  'ABILITY_DUNE_VEIL',
  'ABILITY_GUARDIAN_COAT',
  'ABILITY_OVERCOAT',
  'ABILITY_SAND_BENDER',
  'ABILITY_SAND_FIEND',
  'ABILITY_SAND_FORCE',
  'ABILITY_SAND_GUARD',
  'ABILITY_SAND_RUSH',
  'ABILITY_SAND_SPIT',
  'ABILITY_SAND_VEIL',
  'ABILITY_SEPIA_LENS',
])
const HAIL_IMMUNE_ABILITY_IDS = new Set([
  'ABILITY_AURORAS_GALE',
  'ABILITY_AURORA_BOREALIS',
  'ABILITY_CHRISTMAS_NIGHTMARE',
  'ABILITY_CHRISTMAS_SPIRIT',
  'ABILITY_CRYO_PROFICIENCY',
  'ABILITY_GLACIAL_GHOST',
  'ABILITY_GUARDIAN_COAT',
  'ABILITY_ICE_BODY',
  'ABILITY_ICE_COLD_HUNTER',
  'ABILITY_ICE_FACE',
  'ABILITY_ICE_PICK',
  'ABILITY_NORTH_WIND',
  'ABILITY_OVERCOAT',
  'ABILITY_SLUSH_RUSH',
  'ABILITY_SNOW_CLOAK',
  'ABILITY_SUNDAE',
  'ABILITY_WHITEOUT',
])
/** AbilityBlocksToxicTerrain, battle_util.c:1723-1726 -- RETURN_ABILITY_IF_FLAG
 * (battler, FALSE, toxicTerrainImmune). */
const TOXIC_TERRAIN_IMMUNE_ABILITY_IDS = new Set(['ABILITY_POISON_HEAL', 'ABILITY_STENCH'])

function hasAnyAbility(slots: AbilitySlots, ids: Set<string>): boolean {
  if (slots.ability && ids.has(slots.ability)) return true
  return slots.innates.some((id) => id !== null && ids.has(id))
}

/** IsSandImmune, battle_script_commands.c:10376-10385 -- every clause except
 * Desert Cloak's ally check (see this module's header). */
function isSandImmune(state: BattleState, battler: BattlerState, dataContext: SimDataContext): boolean {
  if (battler.mon.types.includes('ROCK')) return true
  if (battler.mon.types.includes('GROUND')) return true
  if (battler.mon.types.includes('STEEL')) return true
  if (hasFlag(battler.statuses3, STATUS3_UNDERGROUND) || hasFlag(battler.statuses3, STATUS3_UNDERWATER)) return true
  const heldEffect = battler.mon.itemId ? (dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null) : null
  if (heldEffect === 'HOLD_EFFECT_SAFETY_GOGGLES') return true
  if (isMagicGuardProtected(state, battler)) return true
  if (hasAnyAbility(battler.mon.abilities, SAND_IMMUNE_ABILITY_IDS)) return true
  return false
}

/** IsHailImmune, battle_script_commands.c:10388-10395. */
function isHailImmune(state: BattleState, battler: BattlerState, dataContext: SimDataContext): boolean {
  if (battler.mon.types.includes('ICE')) return true
  if (hasFlag(battler.statuses3, STATUS3_UNDERGROUND) || hasFlag(battler.statuses3, STATUS3_UNDERWATER)) return true
  const heldEffect = battler.mon.itemId ? (dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null) : null
  if (heldEffect === 'HOLD_EFFECT_SAFETY_GOGGLES') return true
  if (isMagicGuardProtected(state, battler)) return true
  if (hasAnyAbility(battler.mon.abilities, HAIL_IMMUNE_ABILITY_IDS)) return true
  return false
}

/** WEATHER_HAS_EFFECT, include/battle_util.h:45-46. */
function weatherHasEffect(state: BattleState, grounding: GroundingContext): boolean {
  if (state.field.timers.clearSkiesTimer) return false
  if (grounding.isCluelessOnField) return false
  if (isAbilityOnField(state, 'ABILITY_CLOUD_NINE')) return false
  if (isAbilityOnField(state, 'ABILITY_AIR_LOCK')) return false
  return true
}

/** IsBattlerTerrainAffected, battle_util.c:4901-4925, specialised to the one
 * terrain flag this module ever calls it with (STATUS_FIELD_TOXIC_TERRAIN) --
 * the fallback switch over "which terrain is active" is moot when the caller
 * already knows that terrain's own bit is set. `attackerHasMoldBreaker: false`
 * -- no attacker exists in this phase (same reasoning as isAbilityOnField). */
function isBattlerTerrainAffectedByToxicTerrain(state: BattleState, battlerId: number, battler: BattlerState, grounding: GroundingContext): boolean {
  if (grounding.isCluelessOnField) return false // TERRAIN_HAS_EFFECT
  if (hasFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE)) return false
  return isBattlerGrounded(state, battlerId, { ...grounding, attackerHasMoldBreaker: false })
}

/** SortBattlersBySpeed(gBattlerByTurnOrder, FALSE) -> SortBattlersExcept(arr,
 * TRUE, 0), battle_util.c/battle_main.c -- see this module's header for why
 * this is an approximation (same result distribution, different RNG call
 * sequence) rather than a literal port of the bubble sort. */
function sortBattlersBySpeed(state: BattleState, ctx: TurnOrderContext, statStageRatios: [number, number][]): number[] {
  const order: number[] = []
  let exclude = 0
  for (let i = 0; i < state.battlersCount; i++) {
    const fastest = getFastestBattler(state, [], true, exclude, ctx, statStageRatios)
    order.push(fastest)
    exclude |= 1 << fastest
  }
  return order
}

/** One residual weather-damage HP change, applied and recorded in `order`. */
function applyWeatherDamage(state: BattleState, battlerId: number, battler: BattlerState, effect: 'SANDSTORM' | 'HAIL', results: EndTurnEffectResult[]): void {
  const dmg = Math.max(1, Math.trunc(battler.mon.maxHp / 16))
  const next = Math.max(0, battler.mon.hp - dmg)
  battler.mon.hp = next
  const fainted = next === 0
  if (fainted) state.sides[battlerId & 1].faintedCount++
  results.push({ battlerId, effect, hpChange: -dmg, fainted })
}

/**
 * Runs every ENDTURN_FIELD_* case this batch supports, in ENUM order (see this
 * module's header for why that differs from the file's own case order).
 * Returns the ENDTURN_ORDER result (`order`) so the caller can feed the SAME
 * recomputed gBattlerByTurnOrder into the battler ladder afterwards.
 */
export function runFieldEndTurnEffects(
  state: BattleState,
  ctx: TurnOrderContext,
  statStageRatios: [number, number][],
  grounding: GroundingContext,
  dataContext: SimDataContext,
): { order: number[]; results: EndTurnEffectResult[]; unmodelled: string[] } {
  const results: EndTurnEffectResult[] = []
  const unmodelled: string[] = []

  // ENDTURN_ORDER, :1787-1791.
  const order = sortBattlersBySpeed(state, ctx, statStageRatios)

  // ENDTURN_REFLECT, :1792-1810.
  for (const side of state.sides) {
    if (hasFlag(side.statuses, SIDE_STATUS_REFLECT) && !side.timers.started.reflect) {
      side.timers.reflectTimer--
      if (side.timers.reflectTimer === 0) side.statuses = clearFlag(side.statuses, SIDE_STATUS_REFLECT)
    }
  }

  // ENDTURN_LIGHT_SCREEN, :1812-1830.
  for (const side of state.sides) {
    if (hasFlag(side.statuses, SIDE_STATUS_LIGHTSCREEN) && !side.timers.started.lightscreen) {
      side.timers.lightscreenTimer--
      if (side.timers.lightscreenTimer === 0) side.statuses = clearFlag(side.statuses, SIDE_STATUS_LIGHTSCREEN)
    }
  }

  // ENDTURN_AURORA_VEIL, :1832-1863 (Aurora Veil, then Spider Web in the SAME case).
  for (const side of state.sides) {
    if (hasFlag(side.statuses, SIDE_STATUS_AURORA_VEIL) && !side.timers.started.auroraVeil) {
      side.timers.auroraVeilTimer--
      if (side.timers.auroraVeilTimer === 0) side.statuses = clearFlag(side.statuses, SIDE_STATUS_AURORA_VEIL)
    }
    if (hasFlag(side.statuses, SIDE_STATUS_STICKY_WEB) && !side.timers.started.spiderWeb && side.timers.stickyWebTimer) {
      side.timers.stickyWebTimer--
      if (side.timers.stickyWebTimer === 0) {
        side.statuses = clearFlag(side.statuses, SIDE_STATUS_STICKY_WEB)
        side.timers.foamyWeb = false
      }
    }
  }

  // ENDTURN_MIST, :1865-1879 -- gated on mistTimer != 0, NOT on the SIDE_STATUS_MIST bit.
  for (const side of state.sides) {
    if (side.timers.mistTimer !== 0 && !side.timers.started.mist) {
      side.timers.mistTimer--
      if (side.timers.mistTimer === 0) side.statuses = clearFlag(side.statuses, SIDE_STATUS_MIST)
    }
  }

  // ENDTURN_SAFEGUARD, :1881-1899 (enum position; the file's own case order has this AFTER Lucky Chant).
  for (const side of state.sides) {
    if (hasFlag(side.statuses, SIDE_STATUS_SAFEGUARD) && !side.timers.started.safeguard) {
      side.timers.safeguardTimer--
      if (side.timers.safeguardTimer === 0) side.statuses = clearFlag(side.statuses, SIDE_STATUS_SAFEGUARD)
    }
  }

  // ENDTURN_LUCKY_CHANT, :1901-1911 (enum position).
  for (const side of state.sides) {
    if (hasFlag(side.statuses, SIDE_STATUS_LUCKY_CHANT) && !side.timers.started.luckyChant) {
      side.timers.luckyChantTimer--
      if (side.timers.luckyChantTimer === 0) side.statuses = clearFlag(side.statuses, SIDE_STATUS_LUCKY_CHANT)
    }
  }

  // ENDTURN_TAILWIND, :1913-1927.
  for (const side of state.sides) {
    if (hasFlag(side.statuses, SIDE_STATUS_TAILWIND) && !side.timers.started.tailwind) {
      side.timers.tailwindTimer--
      if (side.timers.tailwindTimer === 0) side.statuses = clearFlag(side.statuses, SIDE_STATUS_TAILWIND)
    }
  }

  // ENDTURN_WISH, :1929-1943 -- Unreachable, see this module's header.

  // ENDTURN_RAIN, :1945-1966 -- REQUIRE(!clearSkiesTimer).
  if (!state.field.timers.clearSkiesTimer && hasFlag(state.field.weather, WEATHER_RAIN_ANY)) {
    const permanentOrPrimal = hasFlag(state.field.weather, WEATHER_RAIN_PERMANENT) || hasFlag(state.field.weather, WEATHER_RAIN_PRIMAL)
    if (!permanentOrPrimal && !state.field.timers.started.weather) {
      state.field.weatherDuration--
      if (state.field.weatherDuration === 0) {
        state.field.weather = clearFlag(clearFlag(state.field.weather, WEATHER_RAIN_TEMPORARY), WEATHER_RAIN_DOWNPOUR)
      }
    }
  }

  // ENDTURN_SANDSTORM, :1968-1983 -- no REQUIRE(!clearSkiesTimer) here (asymmetric vs RAIN/SUN, transcribed as written).
  if (hasFlag(state.field.weather, WEATHER_SANDSTORM_ANY)) {
    let ended = false
    if (!hasFlag(state.field.weather, WEATHER_SANDSTORM_PERMANENT) && !state.field.timers.started.weather) {
      state.field.weatherDuration--
      if (state.field.weatherDuration === 0) {
        state.field.weather = clearFlag(state.field.weather, WEATHER_SANDSTORM_TEMPORARY)
        ended = true
      }
    }
    if (!ended) {
      const weatherOk = weatherHasEffect(state, grounding)
      for (const battlerId of order) {
        if (!isAlive(state, battlerId)) continue
        const battler = state.battlers[battlerId]
        if (!battler) continue
        if (!weatherOk) continue
        if (isMagicGuardProtected(state, battler)) continue
        if (isSandImmune(state, battler, dataContext)) continue
        applyWeatherDamage(state, battlerId, battler, 'SANDSTORM', results)
      }
    }
  }

  // ENDTURN_SUN, :1985-2001 -- REQUIRE(!clearSkiesTimer).
  if (!state.field.timers.clearSkiesTimer && hasFlag(state.field.weather, WEATHER_SUN_ANY)) {
    const permanentOrPrimal = hasFlag(state.field.weather, WEATHER_SUN_PERMANENT) || hasFlag(state.field.weather, WEATHER_SUN_PRIMAL)
    if (!permanentOrPrimal && !state.field.timers.started.weather) {
      state.field.weatherDuration--
      if (state.field.weatherDuration === 0) state.field.weather = clearFlag(state.field.weather, WEATHER_SUN_TEMPORARY)
    }
  }

  // ENDTURN_HAIL, :2003-2018.
  if (hasFlag(state.field.weather, WEATHER_HAIL_ANY)) {
    let ended = false
    if (!hasFlag(state.field.weather, WEATHER_HAIL_PERMANENT) && !state.field.timers.started.weather) {
      state.field.weatherDuration--
      if (state.field.weatherDuration === 0) {
        state.field.weather = clearFlag(state.field.weather, WEATHER_HAIL_TEMPORARY)
        ended = true
      }
    }
    if (!ended) {
      const weatherOk = weatherHasEffect(state, grounding)
      for (const battlerId of order) {
        if (!isAlive(state, battlerId)) continue
        const battler = state.battlers[battlerId]
        if (!battler) continue
        if (!weatherOk) continue
        if (isMagicGuardProtected(state, battler)) continue
        if (isHailImmune(state, battler, dataContext)) continue
        applyWeatherDamage(state, battlerId, battler, 'HAIL', results)
      }
    }
  }

  // ENDTURN_FOG, :2020-2037 -- gapped, see this module's header.
  if (hasFlag(state.field.weather, WEATHER_FOG_ANY) || state.field.timers.fogReturnTimer !== 0) {
    unmodelled.push(
      'ENDTURN_FOG (battle_util.c:2020-2037) is not applied -- dofogstatdrops (data/battle_scripts_1.s:7369-7373) has no port anywhere in this codebase',
    )
  }

  // ENDTURN_GRAVITY, :2117-2124 (enum position; the file places this AFTER the terrains).
  if (hasFlag(state.field.statuses, STATUS_FIELD_GRAVITY) && !state.field.timers.started.gravity) {
    state.field.timers.gravityTimer--
    if (state.field.timers.gravityTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_GRAVITY)
  }

  // ENDTURN_WATER_SPORT, :2107-2110 -- NO started gate, see this module's header.
  if (hasFlag(state.field.statuses, STATUS_FIELD_WATERSPORT)) {
    state.field.timers.waterSportTimer--
    if (state.field.timers.waterSportTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_WATERSPORT)
  }

  // ENDTURN_MUD_SPORT, :2112-2115.
  if (hasFlag(state.field.statuses, STATUS_FIELD_MUDSPORT) && !state.field.timers.started.mudSport) {
    state.field.timers.mudSportTimer--
    if (state.field.timers.mudSportTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_MUDSPORT)
  }

  // ENDTURN_TRICK_ROOM, :1961-1975 (folds Inverse Room's timer too).
  if (hasFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM) && !state.field.timers.started.trickRoom) {
    state.field.timers.trickRoomTimer--
    if (state.field.timers.trickRoomTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_TRICK_ROOM)
  }
  if (hasFlag(state.field.statuses, STATUS_FIELD_INVERSE_ROOM) && !state.field.timers.started.inverseRoom) {
    state.field.timers.inverseRoomTimer--
    if (state.field.timers.inverseRoomTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_INVERSE_ROOM)
  }

  // ENDTURN_WONDER_ROOM, :1977-1984.
  if (hasFlag(state.field.statuses, STATUS_FIELD_WONDER_ROOM) && !state.field.timers.started.wonderRoom) {
    state.field.timers.wonderRoomTimer--
    if (state.field.timers.wonderRoomTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_WONDER_ROOM)
  }

  // ENDTURN_MAGIC_ROOM, :2019-2024 -- NO started gate, see this module's header.
  if (hasFlag(state.field.statuses, STATUS_FIELD_MAGIC_ROOM)) {
    state.field.timers.magicRoomTimer--
    if (state.field.timers.magicRoomTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_MAGIC_ROOM)
  }

  // ENDTURN_ELECTRIC_TERRAIN, :2049-2058.
  if (
    hasFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN) &&
    !hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) &&
    !state.field.timers.started.terrain
  ) {
    state.field.timers.terrainTimer--
    if (state.field.timers.terrainTimer === 0) {
      state.field.statuses = clearFlag(clearFlag(state.field.statuses, STATUS_FIELD_ELECTRIC_TERRAIN), STATUS_FIELD_TERRAIN_PERMANENT)
    }
  }

  // ENDTURN_MISTY_TERRAIN, :2060-2068.
  if (
    hasFlag(state.field.statuses, STATUS_FIELD_MISTY_TERRAIN) &&
    !hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) &&
    !state.field.timers.started.terrain
  ) {
    state.field.timers.terrainTimer--
    if (state.field.timers.terrainTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_MISTY_TERRAIN)
  }

  // ENDTURN_GRASSY_TERRAIN, :2070-2081 -- timer only, heal gapped (see header).
  if (hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)) {
    if (!hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) && !state.field.timers.started.terrain) {
      state.field.timers.terrainTimer--
      if (state.field.timers.terrainTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)
    }
    for (const battlerId of order) {
      if (!isAlive(state, battlerId)) continue
      unmodelled.push(
        `battler ${battlerId}: ENDTURN_GRASSY_TERRAIN's heal (checkgrassyterrainheal, data/battle_scripts_1.s:10152) is not applied -- the command has no handler anywhere in the pinned eliteredux-source checkout`,
      )
    }
  }

  // ENDTURN_PSYCHIC_TERRAIN, :2083-2091.
  if (
    hasFlag(state.field.statuses, STATUS_FIELD_PSYCHIC_TERRAIN) &&
    !hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) &&
    !state.field.timers.started.terrain
  ) {
    state.field.timers.terrainTimer--
    if (state.field.timers.terrainTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_PSYCHIC_TERRAIN)
  }

  // ENDTURN_TOXIC_TERRAIN, :2093-2140 -- timer (with the Stench decrement gate) is
  // ported; the damage loop is gapped per battler (see header).
  if (hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)) {
    const stenchOnField = isAbilityOnField(state, 'ABILITY_STENCH')
    if (!hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) && !state.field.timers.started.terrain && !stenchOnField) {
      state.field.timers.terrainTimer--
      if (state.field.timers.terrainTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)
    }
    for (const battlerId of order) {
      if (!isAlive(state, battlerId)) continue
      const battler = state.battlers[battlerId]
      if (!battler) continue
      if (isMagicGuardProtected(state, battler)) continue
      if (!isBattlerTerrainAffectedByToxicTerrain(state, battlerId, battler, grounding)) continue
      if (hasAnyAbility(battler.mon.abilities, TOXIC_TERRAIN_IMMUNE_ABILITY_IDS)) continue
      if (battler.mon.types.includes('POISON') || battler.mon.types.includes('STEEL')) continue
      unmodelled.push(
        `battler ${battlerId}: ENDTURN_TOXIC_TERRAIN's damage (hpfractiontodamage, data/battle_scripts_1.s:10168) is not applied -- the command has no handler anywhere in the pinned eliteredux-source checkout`,
      )
    }
  }

  // ENDTURN_ION_DELUGE, :2143-2146 -- unconditional.
  state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_ION_DELUGE)

  // ENDTURN_FAIRY_LOCK, :2148-2154.
  if (hasFlag(state.field.statuses, STATUS_FIELD_FAIRY_LOCK) && !state.field.timers.started.fairyLock) {
    state.field.timers.fairyLockTimer--
    if (state.field.timers.fairyLockTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_FAIRY_LOCK)
  }

  // ENDTURN_RETALIATE, :2156-2160 -- no started gate.
  for (const side of state.sides) {
    if (side.timers.retaliateTimer > 0) side.timers.retaliateTimer--
  }

  // ENDTURN_RAINBOW, :2162-2182 -- see header note on the MISC_SIDE_TIMERS double-decrement.
  for (const side of state.sides) {
    if (side.timers.rainbowTimer && !side.timers.started.rainbow) {
      side.timers.rainbowTimer--
    }
  }

  // ENDTURN_SEA_OF_FIRE, :2184-2204.
  for (const side of state.sides) {
    if (side.timers.fireSeaTimer > 0 && !side.timers.started.fireSea) {
      side.timers.fireSeaTimer--
    }
  }

  // ENDTURN_SWAMP, :2205-2226 -- the Monotype Champion WATER exemption applies
  // only to the PLAYER's own side.
  state.sides.forEach((side, sideIndex) => {
    if (side.timers.swampTimer > 0 && !side.timers.started.swamp && !(grounding.monotypeChampType === 'WATER' && sideIndex === B_SIDE_PLAYER)) {
      side.timers.swampTimer--
    }
  })

  // ENDTURN_QUASH, :2228-2232.
  if (state.field.timers.quashTimer && !state.field.timers.started.quash) {
    state.field.timers.quashTimer--
  }

  // ENDTURN_SMOKESCREEN, :2235-2254.
  for (const side of state.sides) {
    if (side.timers.smokescreenTimer && !side.timers.started.smokescreen) {
      side.timers.smokescreenTimer--
      if (side.timers.smokescreenTimer === 0) side.statuses = clearFlag(side.statuses, SIDE_STATUS_SMOKESCREEN)
    }
  }

  // ENDTURN_CLEARSKIES, :2256-2276 -- timer only, see header.
  if (state.field.timers.clearSkiesTimer && !state.field.timers.started.clearSkiesTimer) {
    state.field.timers.clearSkiesTimer--
    if (state.field.timers.clearSkiesTimer === 0) {
      unmodelled.push(
        'ENDTURN_CLEARSKIES (battle_util.c:2256-2276) reached zero, but which weather bits BattleScript_ClearSkiesEnds actually clears is not determinable from the reachable pinned source -- the field weather word was left unchanged',
      )
    }
  }

  // ENDTURN_MISC_SIDE_TIMERS, :2278-2287.
  for (const side of state.sides) {
    if (!side.timers.started.quickGuard && side.timers.quickGuardTimer) side.timers.quickGuardTimer--
    if (!side.timers.started.rainbow && side.timers.rainbowTimer) side.timers.rainbowTimer--
  }

  return { order, results, unmodelled }
}
