// The party slots one battler may draw a replacement from.
//
// A side has ONE 6-slot party even in doubles. In a two-opponent or in-game-partner
// fight that party is really two trainers' rosters concatenated, and the game's
// reserve scans only ever look inside the half that belongs to the battler asking.
// This module is the single port of that split; the four reserve scans
// (firstLiveReplacement, hasLiveReserve, runBattle's default player policy and the
// expectimax switch list) all use it so a partner's active mon can never be offered
// as a reserve, and HasNoMonsToSwitch (hasNoMonsToSwitch, below) uses the same ranges
// to decide whether a fainted battler has to be marked absent.

import { BATTLE_TYPE_DOUBLE, BATTLE_TYPE_INGAME_PARTNER, BATTLE_TYPE_TWO_OPPONENTS, PARTY_SIZE } from './constants'
import type { BattleState, SimPartyMon } from './state'

/**
 * `[firstSlot, lastSlot)` (end exclusive) for `battlerId`'s replacement scan.
 *
 * - INGAME_PARTNER: both sides are split by flank -- HasNoMonsToSwitch's branch at
 *   src/battle_util.c:3629-3641 computes `id1 = (battler & BIT_FLANK) / 2` and scans
 *   `id1 * 3 .. id1 * 3 + 3` for either side, so battlers 0 and 1 own [0,3) and
 *   battlers 2 and 3 own [3,6). NoAliveMonsForPlayer counts only slots 0-2 for the
 *   player (src/battle_script_commands.c:3690-3694), which is the same split.
 * - TWO_OPPONENTS (without a partner): only the opponent side is partitioned, at
 *   src/battle_util.c:3672-3685 -- battler 1 (trainer A) owns [0,3) and battler 3
 *   (trainer B) owns [3,6). The player side and every other battler fall through to
 *   the whole party.
 * - Everything else (singles, a plain double, a single trainer per side): [0, PARTY_SIZE).
 *
 * The C's `BATTLE_TYPE_MULTI` link branch (src/battle_util.c:3642-3671) is not a
 * format this game runs; it is left out.
 */
export function partySlotsFor(state: BattleState, battlerId: number): [number, number] {
  return slotsForFlags(state.battleTypeFlags, battlerId)
}

/** `partySlotsFor` without a `BattleState`, for callers that only know the flags --
 * create.ts's roster assertion runs before the state exists. Same port, same rules. */
export function slotsForFlags(battleTypeFlags: number, battlerId: number): [number, number] {
  if (battleTypeFlags & BATTLE_TYPE_INGAME_PARTNER) {
    const flank = (battlerId & 2) / 2
    return [flank * 3, flank * 3 + 3]
  }
  if (battleTypeFlags & BATTLE_TYPE_TWO_OPPONENTS && (battlerId & 1) === 1) {
    return battlerId === 1 ? [0, 3] : [3, 6]
  }
  return [0, PARTY_SIZE]
}

/** A slot that could be sent in: alive, and not the C's `SPECIES_NONE` / `SPECIES_EGG`
 * (both of which the sim models as `speciesId === null`). */
function isLiveSlot(slot: SimPartyMon | undefined): boolean {
  return slot !== undefined && slot.speciesId !== null && slot.hp > 0
}

/**
 * `HasNoMonsToSwitch` (src/battle_util.c:3607-3704) -- TRUE when a fainted battler has
 * nothing at all to be replaced with, which is what makes Cmd_openpartyscreen mark it
 * absent (`gAbsentBattlerFlags |= gBitTable[gActiveBattler]`,
 * battle_script_commands.c:5234). The `partyIdBattlerOn1/2` and `monToSwitchIntoId`
 * exclusions the C also applies live in the final "plain double" branch only, and are
 * not reproduced as separate inputs: the sim writes `partyIndex` at switch-in, so the
 * two active battlers' `partyIndex` values ARE their `gBattlerPartyIndexes` entries,
 * and every `monToSwitchIntoId` the C would skip is the pending choice for one of those
 * same two battlers (the sim decides a replacement one battler at a time, so there is
 * never a *different* pending slot to skip).
 *
 * Branches, in the C's own order:
 *   1. not BATTLE_TYPE_DOUBLE -> FALSE (:3611). Singles therefore never goes absent.
 *   2. BATTLE_TYPE_INGAME_PARTNER (:3629-3641): both sides are split by flank
 *      (`id1 = (battler & BIT_FLANK) / 2`, scan `id1 * 3 .. id1 * 3 + 3`).
 *   3. BATTLE_TYPE_TWO_OPPONENTS on the opponent side (:3672-3685): battler 1 scans
 *      [0,3) (trainer A) and battler 3 scans [3,6) (trainer B).
 *   4. Otherwise (:3686-3704): one six-slot party, every slot except the two active
 *      battlers' own slots counts as a reserve.
 *
 * Not ported: the BATTLE_TYPE_MULTI link branch (:3642-3671) and the
 * BATTLE_TWO_VS_ONE_OPPONENT branch above it (:3613-3628, `BATTLE_TYPE_INGAME_PARTNER
 * && gTrainerBattleOpponent_B == 0xFFFF`). Neither is a format this game runs.
 */
export function hasNoMonsToSwitch(state: BattleState, battlerId: number): boolean {
  if ((state.battleTypeFlags & BATTLE_TYPE_DOUBLE) === 0) return false // :3611
  const side = battlerId & 1
  const party = state.sides[side].party

  if (state.battleTypeFlags & BATTLE_TYPE_INGAME_PARTNER) {
    const [first, last] = partySlotsFor(state, battlerId) // :3639-3640
    for (let i = first; i < Math.min(last, party.length); i++) {
      if (isLiveSlot(party[i])) return false
    }
    return true
  }

  if (state.battleTypeFlags & BATTLE_TYPE_TWO_OPPONENTS && side === 1) {
    const [first, last] = partySlotsFor(state, battlerId) // :3679-3681
    for (let i = first; i < Math.min(last, party.length); i++) {
      if (isLiveSlot(party[i])) return false
    }
    return true
  }

  // :3686-3704 -- `id2` is the position-left battler and `id1` the position-right one
  // for the fainting battler's side (player: 0 and 2, opponent: 1 and 3), and the loop
  // skips both of their party slots.
  const active = new Set<number>()
  for (let id = 0; id < state.battlers.length; id++) {
    if ((id & 1) !== side) continue
    const other = state.battlers[id]
    if (other) active.add(other.partyIndex)
  }
  // The C always reads PARTY_SIZE slots; a hand-built state may carry a shorter
  // roster, so clamp like every other scan in this file.
  for (let i = 0; i < Math.min(party.length, PARTY_SIZE); i++) {
    if (isLiveSlot(party[i]) && !active.has(i)) return false
  }
  return true
}
