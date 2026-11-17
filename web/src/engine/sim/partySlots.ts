// The party slots one battler may draw a replacement from.
//
// A side has ONE 6-slot party even in doubles. In a two-opponent or in-game-partner
// fight that party is really two trainers' rosters concatenated, and the game's
// reserve scans only ever look inside the half that belongs to the battler asking.
// This module is the single port of that split; the four reserve scans
// (firstLiveReplacement, hasLiveReserve, runBattle's default player policy and the
// expectimax switch list) all use it so a partner's active mon can never be offered
// as a reserve.

import { BATTLE_TYPE_INGAME_PARTNER, BATTLE_TYPE_TWO_OPPONENTS, PARTY_SIZE } from './constants'
import type { BattleState } from './state'

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
  const flags = state.battleTypeFlags
  if (flags & BATTLE_TYPE_INGAME_PARTNER) {
    const flank = (battlerId & 2) / 2
    return [flank * 3, flank * 3 + 3]
  }
  if (flags & BATTLE_TYPE_TWO_OPPONENTS && (battlerId & 1) === 1) {
    return battlerId === 1 ? [0, 3] : [3, 6]
  }
  return [0, PARTY_SIZE]
}
