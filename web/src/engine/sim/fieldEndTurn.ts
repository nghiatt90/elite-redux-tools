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
//   ENDTURN_FOG               PORTED, including the "continues" branch's stat
//                            drops. `dofogstatdrops` (BattleScript_FogContinues,
//                            data/battle_scripts_1.s:7364-7377) is, like
//                            checkgrassyterrainheal/hpfractiontodamage above,
//                            secretly `various BS_ATTACKER,
//                            VARIOUS_DO_FOG_STAT_DROPS` (value 171) --
//                            Cmd_various's own case IS present at
//                            battle_script_commands.c:8601-8623: every stat
//                            stage above neutral (ATK..SPDEF) drops by 1,
//                            skipped for a Ghost/Psychic battler unless
//                            Trick-or-Treated (volatiles.trickOrTreat, real
//                            state), gated by IsBattlerWeatherAffected (=
//                            WEATHER_HAS_EFFECT for a non-sun/rain flag). The
//                            loop itself is raw battler id order, skipping
//                            absent battlers via `jumpifabsent` -- ported as
//                            `isAlive`, since the macro's own body (whether it
//                            tests gAbsentBattlerFlags alone or also hp) is
//                            not resolvable: asm/macros is NOT in
//                            sources.lock.json's sparse_paths for
//                            eliteredux-source, so no macro .inc file is
//                            fetched at all, only the VARIOUS_* constants and
//                            Cmd_various's C body they resolve to.
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
//   ENDTURN_GRASSY_TERRAIN   PORTED, including the heal. `checkgrassyterrainheal`
//                            is not a hand-written battle-script command --
//                            it expands to `various BS_ATTACKER,
//                            VARIOUS_CHECK_IF_GRASSY_TERRAIN_HEALS` (value 77,
//                            include/constants/battle_script_commands.h:160),
//                            whose Cmd_various case IS present at
//                            battle_script_commands.c:6876-6886 (an earlier
//                            pass here missed this: it grepped for a
//                            standalone `checkgrassyterrainheal`/
//                            `Cmd_checkgrassyterrainheal` symbol instead of
//                            resolving the macro to its VARIOUS_* constant and
//                            Cmd_various case first). Heals maxHP/16 (min 1),
//                            skipped for STATUS3_SEMI_INVULNERABLE, at max HP,
//                            hp == 0, or not grounded (the real
//                            isBattlerGrounded port, grounding.ts). The loop
//                            (BattleScript_GrassyTerrainHeals, data/
//                            battle_scripts_1.s:10148-10165) reads
//                            gBattlerByTurnOrder -- this case's own `order`.
//   ENDTURN_PSYCHIC_TERRAIN  PORTED.
//   ENDTURN_TOXIC_TERRAIN    PORTED, including the damage. `hpfractiontodamage`
//                            likewise expands to `various BS_STACK_1,
//                            VARIOUS_HP_FRACTION_TO_DAMAGE` (value 191), whose
//                            Cmd_various case IS present at :9017-9022:
//                            damage = maxHP/16 (the fraction argument at the
//                            script call site, data/battle_scripts_1.s:10168),
//                            capped at the battler's CURRENT hp, minimum 1.
//                            The FILTER chain around it (:2134-2139 --
//                            IsBattlerAlive, !IsMagicGuardProtected,
//                            IsBattlerTerrainAffected incl. its airborne
//                            allowTerrainIfAirborne exception (:4926, Toxic
//                            Surge), !AbilityBlocksToxicTerrain
//                            i.e. the ability's own toxicTerrainImmune
//                            bitfield, not Poison/Steel-typed) is ported in
//                            full. This loop iterates RAW BATTLER ID
//                            0..gBattlersCount-1 (`for (i = 0; i <
//                            gBattlersCount; i++)`), NOT gBattlerByTurnOrder --
//                            unlike Grassy Terrain above, confirmed by reading
//                            the C loop itself, not assumed; an earlier pass
//                            wrongly used `order` here (moot while the case
//                            was fully gapped, fixed now that it isn't).
//                            Also includes the `!IsAbilityOnField
//                            (ABILITY_STENCH)` gate on the timer's DECREMENT
//                            itself, :2126-2127 -- Stench on the field keeps
//                            toxic terrain's timer from ticking down at all,
//                            not just from damaging.
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
//   ENDTURN_CLEARSKIES       PORTED, nothing to gap. Clear Skies
//                            (VARIOUS_SET_CLEAR_SKIES, battle_script_commands.
//                            c:8682-8689) only ever SETS clearSkiesTimer; it
//                            never touches gBattleWeather. WEATHER_HAS_EFFECT's
//                            own `!clearSkiesTimer` clause (already ported)
//                            and the RAIN/SUN cases' `REQUIRE(!clearSkiesTimer)`
//                            gates (already ported) are the entire suppression
//                            mechanism -- weather resumes automatically the
//                            instant the timer expires, no separate "restore"
//                            step exists. BattleScript_ClearSkiesEnds's own
//                            `switch (gBattleWeather)` only picks a MESSAGE
//                            (which weather is "returning"); it reads
//                            gBattleWeather, never writes it -- read to its
//                            end (-> MoveWeatherChangeRet -> OnWeatherChange)
//                            to confirm.
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
import { computeBattleOutcome, syncPartyHp } from './outcome'
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
  WEATHER_FOG_TEMPORARY,
  WEATHER_FOG_PERMANENT,
  STAT_ATK,
  STAT_SPDEF,
  DEFAULT_STAT_STAGE,
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
export function isSandImmune(state: BattleState, battler: BattlerState, dataContext: SimDataContext): boolean {
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
export function isHailImmune(state: BattleState, battler: BattlerState, dataContext: SimDataContext): boolean {
  if (battler.mon.types.includes('ICE')) return true
  if (hasFlag(battler.statuses3, STATUS3_UNDERGROUND) || hasFlag(battler.statuses3, STATUS3_UNDERWATER)) return true
  const heldEffect = battler.mon.itemId ? (dataContext.item(battler.mon.itemId)?.resolvedHoldEffect ?? null) : null
  if (heldEffect === 'HOLD_EFFECT_SAFETY_GOGGLES') return true
  if (isMagicGuardProtected(state, battler)) return true
  if (hasAnyAbility(battler.mon.abilities, HAIL_IMMUNE_ABILITY_IDS)) return true
  return false
}

/** WEATHER_HAS_EFFECT, include/battle_util.h:45-46. */
export function weatherHasEffect(state: BattleState, grounding: GroundingContext): boolean {
  if (state.field.timers.clearSkiesTimer) return false
  if (grounding.isCluelessOnField) return false
  if (isAbilityOnField(state, 'ABILITY_CLOUD_NINE')) return false
  if (isAbilityOnField(state, 'ABILITY_AIR_LOCK')) return false
  return true
}

/** VARIOUS_DO_FOG_STAT_DROPS, battle_script_commands.c:8601-8623 -- what
 * `dofogstatdrops` (data/battle_scripts_1.s:7371, BattleScript_FogContinues)
 * expands to, same "hand-written mnemonic that is secretly a `various`
 * opcode" shape as checkgrassyterrainheal/hpfractiontodamage (see this
 * module's header). `IsBattlerWeatherAffected(b, WEATHER_FOG_ANY)` is
 * `hasFlag(weather, FOG_ANY) && WEATHER_HAS_EFFECT` for a non-sun/rain flag
 * (the Utility Umbrella clause only applies to WEATHER_SUN_ANY|WEATHER_RAIN_ANY)
 * -- already known true by the caller's own branch, so only weatherHasEffect
 * is checked here. Every stat stage ABOVE neutral (STAT_ATK..STAT_SPDEF, i.e.
 * NOT accuracy/evasion) drops by exactly 1, unconditionally of how far above
 * neutral it is -- not a percentage, not a full reset. */
function applyFogStatDrops(battler: BattlerState, grounding: GroundingContext, state: BattleState): void {
  if (!weatherHasEffect(state, grounding)) return
  const isGhostOrPsychic = battler.mon.types.includes('GHOST') || battler.mon.types.includes('PSYCHIC')
  if (isGhostOrPsychic && !battler.volatiles.trickOrTreat) return
  for (let stat = STAT_ATK; stat <= STAT_SPDEF; stat++) {
    if (battler.mon.statStages[stat] > DEFAULT_STAT_STAGE) battler.mon.statStages[stat]--
  }
}

/** IsBattlerTerrainAffected, battle_util.c:4901-4925, specialised to the one
 * terrain flag this module ever calls it with (STATUS_FIELD_TOXIC_TERRAIN) --
 * the fallback switch over "which terrain is active" is moot when the caller
 * already knows that terrain's own bit is set. `attackerHasMoldBreaker: false`
 * -- no attacker exists in this phase (same reasoning as isAbilityOnField). */
function isBattlerTerrainAffectedByToxicTerrain(state: BattleState, battlerId: number, battler: BattlerState, grounding: GroundingContext): boolean {
  if (grounding.isCluelessOnField) return false // TERRAIN_HAS_EFFECT
  if (hasFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE)) return false
  if (isBattlerGrounded(state, battlerId, { ...grounding, attackerHasMoldBreaker: false })) return true
  // :4926 -- ON_ABILITY(..., allowTerrainIfAirborne & type, return TRUE): an
  // airborne battler is still affected when one of its abilities opts in.
  return TOXIC_TERRAIN_AIRBORNE_ABILITIES.some((id) => battlerHasAbility(battler.mon.abilities, id, () => false))
}

/** Abilities whose abilityHooks.json `allowTerrainIfAirborne` includes
 * TERRAIN_TOXIC. Pinned to the snapshot by turnFieldEndTurn.test.ts. */
export const TOXIC_TERRAIN_AIRBORNE_ABILITIES: readonly string[] = ['ABILITY_TOXIC_SURGE']

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
  syncPartyHp(state, battlerId)
  const fainted = next === 0
  if (fainted) state.sides[battlerId & 1].faintedCount++
  results.push({ battlerId, effect, hpChange: -dmg, fainted })
}

/** battle-over short-circuit (faint-replacement batch): recomputes
 * state.battleOutcome and reports whether the caller's per-battler loop
 * should stop -- see turn.ts's own citation on why the field ladder's
 * per-battler damage loops (sandstorm/hail/toxic terrain, all below) are the
 * granularity this batch checks at, matching the C's own
 * one-battler-at-a-time damage application within a single ladder case. */
function outcomeStopsLoop(state: BattleState): boolean {
  state.battleOutcome = computeBattleOutcome(state)
  return state.battleOutcome !== null
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
        if (outcomeStopsLoop(state)) break
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
        if (outcomeStopsLoop(state)) break
      }
    }
  }

  // ENDTURN_FOG, :2020-2037. See this module's header for why
  // dofogstatdrops/VARIOUS_DO_FOG_STAT_DROPS is now ported instead of gapped.
  {
    let ended = false
    if (hasFlag(state.field.weather, WEATHER_FOG_TEMPORARY) && !state.field.timers.started.weather) {
      state.field.weatherDuration--
      if (state.field.weatherDuration === 0) {
        state.field.weather = clearFlag(state.field.weather, WEATHER_FOG_ANY)
        ended = true // BattleScript_FogEnds -- no stat drops this turn.
      }
    }
    if (!ended && hasFlag(state.field.weather, WEATHER_FOG_ANY)) {
      // BattleScript_FogContinues, data/battle_scripts_1.s:7364-7377 -- raw
      // battler id order (0..gBattlersCount-1), NOT gBattlerByTurnOrder,
      // skipping absent battlers (`jumpifabsent`; this port uses `isAlive`,
      // the same "should this battler be processed" gate the rest of this
      // module already uses, since the macro itself is not in the pinned
      // checkout to confirm whether it tests gAbsentBattlerFlags alone or
      // also hp -- see this module's header on asm/macros not being fetched).
      for (let battlerId = 0; battlerId < state.battlersCount; battlerId++) {
        if (!isAlive(state, battlerId)) continue
        const battler = state.battlers[battlerId]
        if (!battler) continue
        applyFogStatDrops(battler, grounding, state)
      }
    } else if (!ended && state.field.weather === 0 && state.field.timers.fogReturnTimer) {
      // BattleScript_FogReturns -- no stat drops the turn fog returns.
      if (state.field.timers.fogReturnTimer > 50) {
        state.field.weather = WEATHER_FOG_PERMANENT
      } else {
        state.field.weather = WEATHER_FOG_TEMPORARY
        state.field.weatherDuration = state.field.timers.fogReturnTimer
      }
      state.field.timers.fogReturnTimer = 0
    }
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

  // ENDTURN_GRASSY_TERRAIN, :2070-2081. checkgrassyterrainheal expands to
  // `various BS_ATTACKER, VARIOUS_CHECK_IF_GRASSY_TERRAIN_HEALS` (value 77,
  // include/constants/battle_script_commands.h:160) -- Cmd_various's own case,
  // battle_script_commands.c:6876-6886: skip if STATUS3_SEMI_INVULNERABLE, at
  // max HP (BATTLER_MAX_HP), hp == 0, or !IsBattlerGrounded; else heal
  // maxHP/16 (min 1). The loop itself (BattleScript_GrassyTerrainHeals, data/
  // battle_scripts_1.s:10148-10165) reads `gBattlerByTurnOrder` via
  // copyarraywithindex, i.e. THIS case's own `order` -- unlike Toxic Terrain
  // below, which iterates raw battler id.
  if (hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)) {
    if (!hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) && !state.field.timers.started.terrain) {
      state.field.timers.terrainTimer--
      if (state.field.timers.terrainTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)
    }
    for (const battlerId of order) {
      // The C's own gate here (battle_script_commands.c:6877-6879) is exactly
      // these four checks, in this order -- NOT IsBattlerAlive (no
      // gAbsentBattlerFlags check at all; a battler is skipped by its own
      // `hp == 0` clause instead).
      const battler = state.battlers[battlerId]
      if (!battler) continue
      if (hasFlag(battler.statuses3, STATUS3_SEMI_INVULNERABLE)) continue
      if (battler.mon.hp === battler.mon.maxHp) continue // BATTLER_MAX_HP
      if (battler.mon.hp === 0) continue
      if (!isBattlerGrounded(state, battlerId, { ...grounding, attackerHasMoldBreaker: false })) continue
      const heal = Math.max(1, Math.trunc(battler.mon.maxHp / 16))
      const next = Math.min(battler.mon.maxHp, battler.mon.hp + heal)
      const applied = next - battler.mon.hp
      battler.mon.hp = next
      syncPartyHp(state, battlerId)
      results.push({ battlerId, effect: 'GRASSY_TERRAIN', hpChange: applied, fainted: false })
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

  // ENDTURN_TOXIC_TERRAIN, :2124-2146 (the FILTER chain is :2134-2139). The
  // loop iterates RAW BATTLER ID 0..gBattlersCount-1 (`for (i = 0; i <
  // gBattlersCount; i++)`), NOT gBattlerByTurnOrder -- unlike Grassy Terrain
  // above, confirmed by reading the C loop itself, not assumed. hpfractiontodamage
  // expands to `various BS_STACK_1, VARIOUS_HP_FRACTION_TO_DAMAGE` (value
  // 191) with fraction=16 (the byte literal at the script call site, data/
  // battle_scripts_1.s:10168) -- Cmd_various's own case,
  // battle_script_commands.c:9017-9022: damage = maxHP/16, capped at the
  // battler's CURRENT hp (not just floored at 0 by the caller -- the cap is
  // in this command itself), minimum 1.
  if (hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)) {
    const stenchOnField = isAbilityOnField(state, 'ABILITY_STENCH')
    if (!hasFlag(state.field.statuses, STATUS_FIELD_TERRAIN_PERMANENT) && !state.field.timers.started.terrain && !stenchOnField) {
      state.field.timers.terrainTimer--
      if (state.field.timers.terrainTimer === 0) state.field.statuses = clearFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)
    }
    for (let battlerId = 0; battlerId < state.battlersCount; battlerId++) {
      if (!isAlive(state, battlerId)) continue
      const battler = state.battlers[battlerId]
      if (!battler) continue
      if (isMagicGuardProtected(state, battler)) continue
      if (!isBattlerTerrainAffectedByToxicTerrain(state, battlerId, battler, grounding)) continue
      if (hasAnyAbility(battler.mon.abilities, TOXIC_TERRAIN_IMMUNE_ABILITY_IDS)) continue
      if (battler.mon.types.includes('POISON') || battler.mon.types.includes('STEEL')) continue
      const dmg = Math.max(1, Math.min(battler.mon.hp, Math.trunc(battler.mon.maxHp / 16)))
      const next = battler.mon.hp - dmg
      battler.mon.hp = next
      syncPartyHp(state, battlerId)
      const fainted = next === 0
      if (fainted) state.sides[battlerId & 1].faintedCount++
      results.push({ battlerId, effect: 'TOXIC_TERRAIN', hpChange: -dmg, fainted })
      if (outcomeStopsLoop(state)) break
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

  // ENDTURN_CLEARSKIES, :2256-2276. Fully ported, nothing to gap: Clear Skies
  // (EFFECT_CLEAR_SKIES, VARIOUS_SET_CLEAR_SKIES, battle_script_commands.c:
  // 8682-8689) only ever SETS clearSkiesTimer -- it never touches
  // gBattleWeather at all. `WEATHER_HAS_EFFECT`'s own `!clearSkiesTimer`
  // clause (already ported, see weatherHasEffect above) and the
  // `REQUIRE(!clearSkiesTimer)` gates on ENDTURN_RAIN/ENDTURN_SUN (already
  // ported) are the ENTIRE mechanism -- weather effects are suppressed while
  // the timer is up and resume automatically the instant it expires, with no
  // separate "restore" mutation needed. BattleScript_ClearSkiesEnds's own
  // `switch (gBattleWeather)` (:2263-2273) only picks which "weather returns"
  // MESSAGE to show (Strong Winds/Primal Sun/Primal Rain); it reads
  // gBattleWeather, never writes it -- confirmed by reading
  // BattleScript_ClearSkiesEnds -> BattleScript_MoveWeatherChangeRet ->
  // BattleScript_OnWeatherChange to their ends. An earlier pass gapped this
  // case assuming a hidden weather mutation existed; verified against the
  // source that it does not.
  if (state.field.timers.clearSkiesTimer && !state.field.timers.started.clearSkiesTimer) {
    state.field.timers.clearSkiesTimer--
  }

  // ENDTURN_MISC_SIDE_TIMERS, :2278-2287.
  for (const side of state.sides) {
    if (!side.timers.started.quickGuard && side.timers.quickGuardTimer) side.timers.quickGuardTimer--
    if (!side.timers.started.rainbow && side.timers.rainbowTimer) side.timers.rainbowTimer--
  }

  return { order, results, unmodelled }
}
