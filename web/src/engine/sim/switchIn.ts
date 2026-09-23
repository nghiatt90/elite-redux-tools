// End-of-turn fainted-mon replacement. Ported from the two C mechanisms that
// together decide WHEN and HOW a switch happens after a faint:
//
//   - HandleFaintedMonActions (battle_util.c:3082+), specifically its state-3
//     gate: "Don't switch mons until all pokemon performed their actions or
//     the battle's over" -- `gBattleOutcome == 0 && !NoAliveMonsForEitherParty()
//     && gCurrentTurnActionNumber != gBattlersCount` defers the switch. This
//     sim never processes a fainted-mon replacement mid-turn at all (there is
//     no state machine to resume into, unlike the C's suspend/resume
//     BattleScriptExecute pattern) -- every replacement in this batch happens
//     once, after the whole turn (both end-turn ladders) has run, which is
//     exactly the state this gate is waiting for. When gBattleOutcome != 0
//     going in, HandleFaintedMonActions never reaches its own
//     BattleScript_HandleFaintedMon call at all (checkteamslost inside that
//     script jumps straight to BattleScript_FaintedMonEnd, data/
//     battle_scripts_1.s:6946-6948) -- no switch-in UI, no replacement. Ported
//     as applyEndOfTurnReplacements's own `if (state.battleOutcome) return`.
//   - Cmd_switchindataupdate (battle_script_commands.c:5008-5037) ->
//     SwitchInClearSetData (battle_main.c:2799-2934), the NON-BATON-PASS,
//     NON-SHED-TAIL branch only (this batch's own scope) -- see switchIn's own
//     citations below for exactly which fields persist and which reset.
//
// SWITCH-IN EFFECTS (hazards, onEntry abilities, switch-in items), classified
// per this batch's brief rather than ported:
//
//   Entry hazards (Spikes/Toxic Spikes/Stealth Rock/Sticky Web) -- UNRESACHABLE.
//   Nothing in web/src/engine/sim writes SideTimerState's
//   spikesAmount/toxicSpikesAmount/stealthRockType, or sets SIDE_STATUS_STICKY_
//   WEB (grep-verified: fieldEndTurn.ts only ever READS stickyWebTimer to tick
//   it down). Move effects are not modelled at all yet (turn.ts's own header:
//   "DELIBERATELY ABSENT ... hazards"), so a hazard can never be present on a
//   side for a switch-in to resolve against. No gap line is emitted for these
//   -- there is no real condition to gate one on, the same precedent
//   fieldEndTurn.ts's own header uses for ENDTURN_WISH.
//
//   Switch-in abilities (HandleSwitchInAbility's own scan over every ability
//   slot, battle_util.c, reached from Cmd_switchineffects at
//   battle_script_commands.c:5475-5541) -- GAPPED, by name, only when the
//   incoming mon's ability actually has an onEntry hook per abilityHooks.json
//   (SWITCH_IN_ABILITY_IDS below) -- same "gapped only when the real C
//   condition is true" discipline as endTurn.ts's ENDTURN_ABILITIES. Checked
//   against ALL FOUR slots (ability + 3 innates), matching
//   HandleSwitchInAbility's own GetNumPossibleAbilitiesForBattler loop --
//   UNLIKE endTurn.ts's ENDTURN_ABILITIES, which reads slot 0 only.
//
//   Switch-in items (ITEMEFFECT_ON_SWITCH_IN, battle_util.c:5418-5604) --
//   GAPPED, by name, only when the incoming mon's item's resolvedHoldEffect is
//   one of SWITCH_IN_HOLD_EFFECTS below (transcribed from that switch's own
//   `case HOLD_EFFECT_*` list, same "transcribed by name" precedent as
//   endTurn.ts's ITEMS_1_2_HOLD_EFFECTS).

import type { AbilitySlots } from '../abilities/dispatch'
import type { SimDataContext } from './dataContext'
import { createBattlerState } from './create'
import type { BattleState, SimBattleMon, SimPartyMon } from './state'
import { syncPartyHp } from './outcome'

/** HandleSwitchInAbility's own scan over every ability slot -- duplicated
 * rather than imported from fieldEndTurn.ts's private `hasAnyAbility` to avoid
 * a cross-module reach into an unexported helper (same "kept in lockstep by
 * inspection" precedent as endTurn.ts/fieldEndTurn.ts's own duplicated
 * `isAlive`/`isBattlerAlive`). */
function hasAnyAbility(slots: AbilitySlots, ids: ReadonlySet<string>): boolean {
  if (slots.ability && ids.has(slots.ability)) return true
  return slots.innates.some((id) => id !== null && ids.has(id))
}

/** abilityHooks.json (data/v2.65beta, pinned SHA) -- every ability id whose
 * `hooks.onEntry` is present. Used only to decide when the switch-in ability
 * gap line fires; the hook itself is not run. */
const SWITCH_IN_ABILITY_IDS: ReadonlySet<string> = new Set([
  'ABILITY_AIR_BLOWER', 'ABILITY_AIR_LOCK', 'ABILITY_ANTICIPATION', 'ABILITY_APE_SHIFT', 'ABILITY_AQUATIC',
  'ABILITY_AS_ONE_ICE_RIDER', 'ABILITY_AS_ONE_SHADOW_RIDER', 'ABILITY_ATLAS', 'ABILITY_AURA_BREAK', 'ABILITY_AURORAS_GALE',
  'ABILITY_BARK_SKIN', 'ABILITY_BERSERK_DNA', 'ABILITY_BLIND_RAGE', 'ABILITY_BLISTERING_SUN', 'ABILITY_BLOOD_STAIN',
  'ABILITY_BRUISER', 'ABILITY_BUTTER_UP', 'ABILITY_CHAMPIONS_ENTRANCE', 'ABILITY_CHANGE_OF_HEART', 'ABILITY_CHEAP_TACTICS',
  'ABILITY_CHEATING_DEATH', 'ABILITY_CHILLING_PRESENCE', 'ABILITY_CHRISTMAS_NIGHTMARE', 'ABILITY_CLOUD_NINE', 'ABILITY_CLUELESS',
  'ABILITY_COIL_UP', 'ABILITY_COMATOSE', 'ABILITY_COSTAR', 'ABILITY_COWARD', 'ABILITY_CROWNED_KING',
  'ABILITY_CROWNED_SHIELD', 'ABILITY_CROWNED_SWORD', 'ABILITY_CURIOUS_MEDICINE', 'ABILITY_CURLIPEDE', 'ABILITY_CURSE_OF_FAMINE',
  'ABILITY_CUTTHROAT', 'ABILITY_DARK_AURA', 'ABILITY_DAUNTLESS_SHIELD', 'ABILITY_DEEP_FRIED', 'ABILITY_DELTA_STREAM',
  'ABILITY_DEMOLITIONIST', 'ABILITY_DESERT_SPIRIT', 'ABILITY_DESOLATE_LAND', 'ABILITY_DISGUISE', 'ABILITY_DOOMBRINGER',
  'ABILITY_DOWNLOAD', 'ABILITY_DRACONIC_MIGHT', 'ABILITY_DRACO_MORALE', 'ABILITY_DRAGONFLY', 'ABILITY_DRAGONFRUIT',
  'ABILITY_DRAKELP_HEAD', 'ABILITY_DREAMSCAPE', 'ABILITY_DREAM_WHIMSY', 'ABILITY_DRIZZLE', 'ABILITY_DROUGHT',
  'ABILITY_DUST_CLOUD', 'ABILITY_EDGELORD', 'ABILITY_ELECTRIC_SURGE', 'ABILITY_ELECTRO_BOOSTER', 'ABILITY_EMBODY_ASPECT',
  'ABILITY_EMBODY_ASPECT_CORNERSTONE', 'ABILITY_EMBODY_ASPECT_HEARTHFLAME', 'ABILITY_EMBODY_ASPECT_WELLSPRING', 'ABILITY_ENERGIZED', 'ABILITY_FAIRY_AURA',
  'ABILITY_FAIRY_TALE', 'ABILITY_FEARMONGER', 'ABILITY_FEY_FLIGHT', 'ABILITY_FIRES_WRATH', 'ABILITY_FLAME_COAT',
  'ABILITY_FLARE_BOOST', 'ABILITY_FLOWER_GIFT', 'ABILITY_FOAMY_WEB', 'ABILITY_FOOD_LOVERS', 'ABILITY_FORECAST',
  'ABILITY_FOREWARN', 'ABILITY_FRISK', 'ABILITY_FROSTY_PRESCENCE', 'ABILITY_FUNERAL_PYRE', 'ABILITY_FURNACE',
  'ABILITY_GALLANTRY', 'ABILITY_GENERATOR', 'ABILITY_GLEAM_EYES', 'ABILITY_GRASSY_SURGE', 'ABILITY_GRAVITY_WELL',
  'ABILITY_GREATER_SPIRIT', 'ABILITY_GROUNDED', 'ABILITY_HADRON_ENGINE', 'ABILITY_HALF_DRAKE', 'ABILITY_HEADSTRONG',
  'ABILITY_HOSPITALITY', 'ABILITY_HOT_COALS', 'ABILITY_HOVER', 'ABILITY_ICE_AGE', 'ABILITY_ICE_FACE',
  'ABILITY_IMPOSTER', 'ABILITY_INTIMIDATE', 'ABILITY_INTREPID_SWORD', 'ABILITY_INVERSE_ROOM', 'ABILITY_I_AM_STEVE',
  'ABILITY_JUMP_SCARE', 'ABILITY_KING_OF_THE_JUNGLE', 'ABILITY_KOMODO', 'ABILITY_LAWNMOWER', 'ABILITY_LETHARGY',
  'ABILITY_LETS_DANCE', 'ABILITY_LETS_ROLL', 'ABILITY_LIGHTNING_BORN', 'ABILITY_LIGHT_SABER', 'ABILITY_LOCUST_SWARM',
  'ABILITY_LOW_BLOW', 'ABILITY_LOW_VISIBILITY', 'ABILITY_MADNESS_ENHANCEMENT', 'ABILITY_MAJESTIC_MOTH', 'ABILITY_MALICIOUS',
  'ABILITY_MASHED_POTATO', 'ABILITY_METALLIC', 'ABILITY_METALLIC_JAWS', 'ABILITY_MIMICRY', 'ABILITY_MISTY_SURGE',
  'ABILITY_MOB_BOSS', 'ABILITY_MOLD_BREAKER', 'ABILITY_MOLTEN_CORE', 'ABILITY_MONKEY_BUSINESS', 'ABILITY_MONSTER_MASH',
  'ABILITY_NEUTRALIZING_FOG', 'ABILITY_NIHIL_BLASTER', 'ABILITY_NORTH_WIND', 'ABILITY_OMINOUS_SHROUD', 'ABILITY_ON_THE_PROWL',
  'ABILITY_ORICHALCUM_PULSE', 'ABILITY_OVERCAST', 'ABILITY_OVERWATCH', 'ABILITY_PARASITIC_SPORES', 'ABILITY_PASTEL_VEIL',
  'ABILITY_PATCHWORK', 'ABILITY_PERMANENCE', 'ABILITY_PETAL_SHIELD', 'ABILITY_PETRIFY', 'ABILITY_PHANTOM',
  'ABILITY_PHANTOM_THIEF', 'ABILITY_PICKUP', 'ABILITY_PIXIE_POWER', 'ABILITY_POSEIDONS_DOMINION', 'ABILITY_POWDER_BURST',
  'ABILITY_POWER_OF_ALCHEMY', 'ABILITY_POWER_OUTAGE', 'ABILITY_PRESSURE', 'ABILITY_PRIMORDIAL_SEA', 'ABILITY_PROTOSYNTHESIS',
  'ABILITY_PSYCHIC_SURGE', 'ABILITY_PURIFYING_WATERS', 'ABILITY_QUARK_DRIVE', 'ABILITY_RAINBOW_SCALES', 'ABILITY_RAPID_RESPONSE',
  'ABILITY_READIED_ACTION', 'ABILITY_REJECTION', 'ABILITY_REVELATION', 'ABILITY_ROCKY_EXTERIOR', 'ABILITY_ROCK_ARMOR',
  'ABILITY_ROSE_GARDEN', 'ABILITY_ROYAL_DECREE', 'ABILITY_SALT_CIRCLE', 'ABILITY_SAND_BENDER', 'ABILITY_SAND_PIT',
  'ABILITY_SAND_STREAM', 'ABILITY_SCARE', 'ABILITY_SCARECROW', 'ABILITY_SCHOOLING', 'ABILITY_SCREEN_CLEANER',
  'ABILITY_SEABORNE', 'ABILITY_SEA_GUARDIAN', 'ABILITY_SHIELDS_DOWN', 'ABILITY_SHOWDOWN_MODE', 'ABILITY_SIDEWINDER',
  'ABILITY_SLOW_START', 'ABILITY_SNOWY_WRATH', 'ABILITY_SNOW_WARNING', 'ABILITY_SOOTHING_AROMA', 'ABILITY_SOOTHSAYER',
  'ABILITY_SPIDER_LAIR', 'ABILITY_SPIDER_LAIR_UPGRADE', 'ABILITY_SPYWARE', 'ABILITY_STORM_CLOUD', 'ABILITY_SUNDAE',
  'ABILITY_SUN_WORSHIP', 'ABILITY_SUPERCELL', 'ABILITY_SUPPRESS', 'ABILITY_SUPREME_OVERLORD', 'ABILITY_SWAMP_THING',
  'ABILITY_TALON_TRAP', 'ABILITY_TAR_TOSS', 'ABILITY_TASTE_THE_RAINBOW', 'ABILITY_TELEKINETIC', 'ABILITY_TERAFORM_ZERO',
  'ABILITY_TERAVOLT', 'ABILITY_TERRIFY', 'ABILITY_TOXIC_BOOST', 'ABILITY_TOXIC_SPILL', 'ABILITY_TOXIC_SURGE',
  'ABILITY_TRACE', 'ABILITY_TRASH_HEAP', 'ABILITY_TRICKSTER', 'ABILITY_TURBOBLAZE', 'ABILITY_TURF_WAR',
  'ABILITY_TWISTED_DIMENSION', 'ABILITY_UNNERVE', 'ABILITY_VIOLENT_RUSH', 'ABILITY_VOLTRON', 'ABILITY_WATCH_YOUR_STEP',
  'ABILITY_WATERBORNE', 'ABILITY_WATER_VEIL', 'ABILITY_WEB_SPINNER', 'ABILITY_WHITE_SMOKE', 'ABILITY_WILDFIRE',
  'ABILITY_WIND_RAGE', 'ABILITY_WIND_RIDER', 'ABILITY_WINTER_THRONE', 'ABILITY_WISHMAKER', 'ABILITY_WITCH_BROOM',
  'ABILITY_WOODLAND_CURSE', 'ABILITY_YUKI_ONNA', 'ABILITY_ZEN_GARDEN', 'ABILITY_ZEN_MODE', 'ABILITY_ZERO_TO_HERO',
])

/** ITEMEFFECT_ON_SWITCH_IN's own `case HOLD_EFFECT_*` list, battle_util.c:
 * 5421-5603 (the whole switch inside `if (!gTurnStructs[battlerId].
 * switchInItemDone)`), transcribed by name. */
const SWITCH_IN_HOLD_EFFECTS: ReadonlySet<string> = new Set([
  'HOLD_EFFECT_DOUBLE_PRIZE', 'HOLD_EFFECT_RESTORE_STATS', 'HOLD_EFFECT_CONFUSE_SPICY', 'HOLD_EFFECT_CONFUSE_DRY',
  'HOLD_EFFECT_CONFUSE_SWEET', 'HOLD_EFFECT_CONFUSE_BITTER', 'HOLD_EFFECT_CONFUSE_SOUR', 'HOLD_EFFECT_ATTACK_UP',
  'HOLD_EFFECT_DEFENSE_UP', 'HOLD_EFFECT_SPEED_UP', 'HOLD_EFFECT_SP_ATTACK_UP', 'HOLD_EFFECT_SP_DEFENSE_UP',
  'HOLD_EFFECT_CRITICAL_UP', 'HOLD_EFFECT_RANDOM_STAT_UP', 'HOLD_EFFECT_CURE_PAR', 'HOLD_EFFECT_CURE_PSN',
  'HOLD_EFFECT_CURE_BRN', 'HOLD_EFFECT_CURE_FRZ', 'HOLD_EFFECT_CURE_SLP', 'HOLD_EFFECT_CURE_STATUS',
  'HOLD_EFFECT_RESTORE_HP', 'HOLD_EFFECT_HONEY', 'HOLD_EFFECT_RESTORE_PCT_HP', 'HOLD_EFFECT_AIR_BALLOON',
  'HOLD_EFFECT_ROOM_SERVICE', 'HOLD_EFFECT_SEEDS',
])

/** A validated party-slot choice for a fainted battler, from the caller (the
 * player's own choice is solver input; the opponent's is
 * `ai/aiSwitching.ts`'s `createAiOpponentReplacement`, which runs a real
 * `GetMostSuitableMonToSwitchInto` port). `unmodelled` is the SAME channel
 * `applyEndOfTurnReplacements` already threads for the switch's own
 * ability/item gaps -- an implementation that reaches a decision by running
 * real AI logic (rather than being handed one, as tests do) pushes its own
 * gap lines here too, so a caller inspecting `unmodelled` sees the whole
 * decision, not just the switch that followed it. */
export interface ReplacementDeps {
  chooseReplacement(state: BattleState, battlerId: number, unmodelled: string[]): number
}

/** Any OTHER party slot on this battler's side that is alive and not an empty
 * slot -- the condition `applyEndOfTurnReplacements` gates a replacement on. */
function hasLiveReserve(state: BattleState, battlerId: number): boolean {
  const battler = state.battlers[battlerId]
  if (!battler) return false
  const party = state.sides[battlerId & 1].party
  return party.some((slot, index) => index !== battler.partyIndex && slot.speciesId !== null && slot.hp > 0)
}

/** Cmd_switchindataupdate + SwitchInClearSetData's NON-Baton-Pass, NON-Shed-
 * Tail branch (battle_script_commands.c:5008-5037, battle_main.c:2799-2934) --
 * see this module's header for exactly which of those two functions each line
 * below cites.
 *
 * | field                | source                                              |
 * |----------------------|------------------------------------------------------|
 * | species/rawStats/moves/pp/hp/maxHp/itemId/nature/hiddenPowerType/speedDown/gender/types | copied from the party record (Cmd_switchindataupdate's own memcpy from bufferB, :5015) |
 * | status1              | copied from the party record -- PERSISTS across switches (state.ts's own SimPartyMon.status1 doc; the C's memcpy includes it) |
 * | statStages           | reset to neutral (SwitchInClearSetData's own statStages loop, battle_main.c:2809 -- via createBattlerState, which already applies this) |
 * | status2/statuses3/statuses4 | zeroed (the C's `else` branch, battle_main.c:2833-2835 -- NOT the Baton-Pass/Shed-Tail branches above it) |
 * | volatiles            | fully reset (ZERO(gVolatileStructs), :2870, then isFirstTurn=2 at :2899 -- via createBattlerState/createVolatileState, already applies this) |
 * | round/turn state     | fresh (createBattlerState already applies this; the C's own per-battler RoundStruct/TurnStruct reset is a DIFFERENT call site --
 * |                      | FaintClearSetData, battle_main.c:2951 -- reached from a different script path, but the end state for a freshly-switched-in battler is the same: zeroed) |
 * | monToSwitchIntoId / aiMonToSwitchIntoId | PARTY_SIZE sentinel (createBattlerState, matching battle_main.c:3522/:2710) |
 * | lastMove/sameMoveTurns | reset to null/0 (battle_main.c's gLastMoves[gActiveBattler]=0 at :2905, gBattleStruct->sameMoveTurns[gActiveBattler]=0 at :2919 -- via createBattlerState) |
 *
 * NOT ported: SwitchInClearSetData's cross-battler cleanup (escape-prevention/
 * always-hits/infatuation/wrap bits belonging to OTHER battlers that reference
 * the outgoing one, :2810-2818, :2840-2843) -- every one of those fields
 * (STATUS2_INFATUATED_WITH, wrappedBy, STATUS3_ALWAYS_HITS'
 * battlerWithSureHit) has no writer anywhere in web/src/engine/sim (grep-
 * verified), so the cleanup has nothing to clean up; same "no gap needed, no
 * real condition exists" reasoning as fieldEndTurn.ts's ENDTURN_WISH. Also not
 * ported: the queued-extra-attack requeue (:2846-2864, multi-hit sequencing
 * is not modelled anywhere in this sim) and the mid-air Sky Drop release
 * (:2921-2933, skyDropped has no writer either).
 */
function buildSwitchedInMon(incoming: SimPartyMon): SimBattleMon {
  return {
    speciesId: incoming.speciesId as string, // validated non-null by the caller
    rawStats: incoming.rawStats,
    moves: incoming.moves,
    pp: incoming.pp,
    hp: incoming.hp,
    maxHp: incoming.maxHp,
    itemId: incoming.itemId,
    statStages: [], // overwritten with the neutral set by createBattlerState
    types: incoming.types,
    level: incoming.level,
    nature: incoming.nature,
    hiddenPowerType: incoming.hiddenPowerType,
    speedDown: incoming.speedDown,
    abilities: incoming.abilities,
    gender: incoming.gender,
    status1: incoming.status1,
    status2: 0,
  }
}

/** Performs one battler's switch-in and reports which switch-in effects apply
 * by name (see this module's header for the hazard/ability/item
 * classification). Throws on an invalid `partyIndex` -- see this batch's brief
 * on why a silent fallback would be the wrong failure mode here. */
export function switchIn(state: BattleState, battlerId: number, partyIndex: number, unmodelled: string[]): void {
  const battler = state.battlers[battlerId]
  if (!battler) throw new Error(`switchIn: no battler at id ${battlerId}`)
  const side = battlerId & 1
  const party = state.sides[side].party
  const incoming = party[partyIndex]
  if (!incoming || incoming.speciesId === null || incoming.hp <= 0 || partyIndex === battler.partyIndex) {
    throw new Error(`switchIn: invalid replacement party slot ${partyIndex} for battler ${battlerId}`)
  }

  const mon = buildSwitchedInMon(incoming)
  state.battlers[battlerId] = createBattlerState(battlerId, mon, partyIndex)
  syncPartyHp(state, battlerId)

  if (hasAnyAbility(incoming.abilities, SWITCH_IN_ABILITY_IDS)) {
    const ownAbility = incoming.abilities.ability
    const hookOwner = ownAbility && SWITCH_IN_ABILITY_IDS.has(ownAbility) ? ownAbility : incoming.abilities.innates.find((id) => id !== null && SWITCH_IN_ABILITY_IDS.has(id))
    unmodelled.push(`battler ${battlerId}: HandleSwitchInAbility (battle_util.c:5475-5541) is not applied -- ${hookOwner}'s onEntry hook was not run`)
  }
}

/** The item half of switchIn's gap reporting -- split out because it needs
 * `SimDataContext.item`, which `switchIn` itself has no reason to take. */
export function switchInItemGap(dataContext: SimDataContext, battlerId: number, incoming: SimPartyMon, unmodelled: string[]): void {
  if (!incoming.itemId) return
  const heldEffect = dataContext.item(incoming.itemId)?.resolvedHoldEffect ?? null
  if (heldEffect !== null && SWITCH_IN_HOLD_EFFECTS.has(heldEffect)) {
    unmodelled.push(`battler ${battlerId}: ITEMEFFECT_ON_SWITCH_IN (battle_util.c:5418-5604) is not applied -- ${incoming.itemId}'s switch-in hold effect (${heldEffect}) was not run`)
  }
}

/** Replaces every fainted battler whose side still has a live reserve, once
 * per side per call -- the end-of-turn shape HandleFaintedMonActions's own
 * state-3 gate is waiting for (see this module's header). No-op entirely once
 * the battle is decided, matching BattleScript_HandleFaintedMon's own
 * checkteamslost-then-jump-to-FaintedMonEnd shortcut. */
export function applyEndOfTurnReplacements(state: BattleState, deps: ReplacementDeps, dataContext: SimDataContext, unmodelled: string[]): void {
  if (state.battleOutcome) return
  for (let battlerId = 0; battlerId < state.battlersCount; battlerId++) {
    const battler = state.battlers[battlerId]
    if (!battler || battler.mon.hp !== 0) continue
    if (!hasLiveReserve(state, battlerId)) continue

    const partyIndex = deps.chooseReplacement(state, battlerId, unmodelled)
    const party = state.sides[battlerId & 1].party
    const incoming = party[partyIndex]
    switchIn(state, battlerId, partyIndex, unmodelled)
    if (incoming) switchInItemGap(dataContext, battlerId, incoming, unmodelled)
  }
}
