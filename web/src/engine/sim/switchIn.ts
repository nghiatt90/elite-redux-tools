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
//   Entry hazards (Spikes/Stealth Rock/Toxic Spikes/Sticky Web) -- PORTED, in
//   hazards.ts's applySwitchInHazards (Cmd_switchineffects's first pass,
//   battle_script_commands.c:5512-5515, VARIOUS_DO_HAZARD_DAMAGE :8711-8830).
//   They run right after the battler is rebuilt and BEFORE the ability and item
//   gaps below, as in the C: that second pass (:5517+) only happens for a mon
//   that is still alive after the hazards, so a hazard faint emits neither gap
//   and leaves the battler at 0 HP for applyEndOfTurnReplacements to replace
//   again. Hot Coals / Caltrops, Mirror Armor on Sticky Web and the Toxic
//   Spikes reaction flags are gapped inside hazards.ts, only when they apply.
//
//   Switch-in abilities (HandleSwitchInAbility's own scan over every ability
//   slot, battle_util.c, reached from Cmd_switchineffects at
//   battle_script_commands.c:5475-5541 and TryDoEventsBeforeFirstTurn at
//   battle_main.c:3354-3382):
//   - PORTED: weather setters (Drizzle, Drought, Sand Stream, Snow Warning
//     and aliases Seaborne, Storm Cloud, Orichalcum Pulse, Desert Spirit,
//     Sand Bender, Snowy Wrath, Sundae) through tryChangeBattleWeather
//     (matching TryChangeBattleWeather, battle_util.c:3721-3743).
//   - Dispatched across all four ability slots in C order (slot 3 down to 0,
//     matching HandleSwitchInAbility's numPossibleAbilities - i loop).
//   - Lead pass: applyBattleStartPass walks leads in speed order
//     (gBattlerByTurnOrder via RecalculateMoveOrder, battle_main.c:3356).
//   - Gapped: all other onEntry abilities remain conditional gaps in
//     unmodelled[], checked against SWITCH_IN_ABILITY_IDS and suppressed
//     per IsSuppressed (battle_util.c:9187).
//
//   Switch-in items (ITEMEFFECT_ON_SWITCH_IN, battle_util.c:5418-5604) --
//   GAPPED, by name, only when the incoming mon's item's resolvedHoldEffect is
//   one of SWITCH_IN_HOLD_EFFECTS below (transcribed from that switch's own
//   `case HOLD_EFFECT_*` list, same "transcribed by name" precedent as
//   endTurn.ts's ITEMS_1_2_HOLD_EFFECTS).

import { createBattlerState } from './create'
import { applySwitchInHazards, type HazardDeps } from './hazards'
import type { BattleState, SimBattleMon, SimPartyMon } from './state'
import { syncPartyHp } from './outcome'
import {
  applyBattleStartPass,
  applySwitchInAbilities,
  tryChangeBattleWeather,
  type BattleStartDeps,
  SWITCH_IN_ABILITY_IDS,
  WEATHER_SETTER_MAP,
} from './switchInAbility'

export {
  applyBattleStartPass,
  applySwitchInAbilities,
  tryChangeBattleWeather,
  type BattleStartDeps,
  SWITCH_IN_ABILITY_IDS,
  WEATHER_SETTER_MAP,
}



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
export function hasLiveReserve(state: BattleState, battlerId: number): boolean {
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

/** Performs one battler's switch-in: rebuilds the battler, resolves entry
 * hazards (hazards.ts), then -- only if the mon survived them -- reports which
 * switch-in effects apply by name (see this module's header). Throws on an
 * invalid `partyIndex` -- see this batch's brief on why a silent fallback would
 * be the wrong failure mode here. */
export function switchIn(state: BattleState, battlerId: number, partyIndex: number, deps: HazardDeps, unmodelled: string[]): void {
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

  applySwitchInHazards(state, battlerId, deps, unmodelled)
  if (state.battlers[battlerId]!.mon.hp === 0) return

  applySwitchInAbilities(state, battlerId, deps, unmodelled)

  if (!incoming.itemId) return
  const heldEffect = deps.dataContext.item(incoming.itemId)?.resolvedHoldEffect ?? null
  if (heldEffect !== null && SWITCH_IN_HOLD_EFFECTS.has(heldEffect)) {
    unmodelled.push(`battler ${battlerId}: ITEMEFFECT_ON_SWITCH_IN (battle_util.c:5418-5604) is not applied -- ${incoming.itemId}'s switch-in hold effect (${heldEffect}) was not run`)
  }
}

/** Replaces every fainted battler whose side still has a live reserve, once
 * per side per call -- the end-of-turn shape HandleFaintedMonActions's own
 * state-3 gate is waiting for (see this module's header). A replacement that
 * faints to its own entry hazards is replaced again (HandleFaintedMonActions
 * runs again for it in the C), until a mon survives, the side runs out of
 * reserves, or the battle is decided. No-op entirely once the battle is
 * decided, matching BattleScript_HandleFaintedMon's own checkteamslost-then-
 * jump-to-FaintedMonEnd shortcut. */
export function applyEndOfTurnReplacements(state: BattleState, deps: ReplacementDeps, switchDeps: HazardDeps, unmodelled: string[]): void {
  if (state.battleOutcome) return
  for (let battlerId = 0; battlerId < state.battlersCount; battlerId++) {
    while (!state.battleOutcome && state.battlers[battlerId]?.mon.hp === 0 && hasLiveReserve(state, battlerId)) {
      const partyIndex = deps.chooseReplacement(state, battlerId, unmodelled)
      switchIn(state, battlerId, partyIndex, switchDeps, unmodelled)
    }
  }
}
