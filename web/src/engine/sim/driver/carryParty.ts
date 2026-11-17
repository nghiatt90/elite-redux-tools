// End-of-battle carry-over for a no-heal chain: turns the player's party at the end
// of one fight into the party that starts the next one, following the C's own
// end-of-battle block in order (battle_main.c:4818-4852):
//   TryRestoreStolenItems (:4827) -> UndoMegaEvolution/UndoFormChange per slot
//   (:4829-4831) -> CalculateMonStats per non-empty slot (:4845-4852).
//
// Everything battle-scoped (stat stages, status2, volatiles, weather, screens) lives
// in the C's battle structs and has no SimPartyMon counterpart, so building the
// result from the pre-battle party plus only HP and status1 drops all of it by
// construction. The result is a fresh deep copy; the inputs are never mutated.

import type { BattlerState, SimPartyMon } from '../state'
import { cloneParty } from './session'

/** The slot the next battle sends out: IsValidForBattle (battle_controllers.c:607-613)
 * requires species != SPECIES_NONE/EGG and HP != 0, and SetBattlePartyIds
 * (:615-675) walks the party in slot order and takes the first such mon. Returns -1
 * when nobody is alive, passed to `createSession({ leadIndex })` by the caller. */
export function firstLiveSlot(party: SimPartyMon[]): number {
  for (let i = 0; i < party.length; i++) {
    const mon = party[i]
    if (mon && mon.speciesId !== null && mon.hp > 0) return i
  }
  return -1
}

/** One carried party member for the next fight of a no-heal chain.
 *
 * `startParty` is the party the previous fight started with, `endParty` its
 * `finalParty`/`state.sides[0].party`, and `activeBattler` the player's `state.battlers[0]`
 * (its live HP/status are the authoritative ones for the slot still on the field).
 *
 * NOT modelled: the battle-won revive (battle_main.c:4675-4683), where a fainted
 * battler that still has an onRevive ability charge gets max HP / 4 in the party.
 * That needs the ability single-use counters, which the party record does not carry. */
export function carryParty(
  startParty: SimPartyMon[],
  endParty: SimPartyMon[],
  activeBattler?: BattlerState,
): SimPartyMon[] {
  if (startParty.length !== endParty.length) {
    throw new Error(
      `carryParty: startParty has ${startParty.length} slots but endParty has ${endParty.length}`,
    )
  }

  // Items are restored first (battle_main.c:4827 -> TryRestoreStolenItems,
  // battle_util.c:8478-8498). B_RESTORE_ALL_ITEMS is TRUE (battle_config.h:189), so
  // every slot's held item goes back to the one captured at battle start
  // (battle_main.c:2781, itemStolen[i].originalItem) -- a consumed berry or Focus
  // Sash included. Taking itemId from `startParty` is exactly that.
  // PP is restored by CalculateMonStats' shouldRestorePP (pokemon.c:1013-1019), which
  // sets each move's PP back to its base PP. The sim does not model PP bonuses or
  // PP Ups, so base PP is `startParty[i].pp`.
  // Abilities stay as `startParty` has them (UNGATED): `createSession` runs
  // gateInnates on its own clone of whatever party it is handed
  // (session.ts:266-268), so carrying the session's already-gated innates would
  // re-gate them. A form revert's own re-gate (formChange.ts:864-905) is likewise
  // undone by taking the pre-battle slots.
  const carried = cloneParty(startParty)

  for (let i = 0; i < carried.length; i++) {
    const start = startParty[i]!
    const end = endParty[i]!
    const slot = carried[i]!

    // The mon still on the field keeps its live status1 (and hp) on the battler;
    // the party slot is only written on switch-out (turn.ts:1848-1859) and, for
    // status1, on Rest. The C's REQUEST_ALL_BATTLE handler writes both back from the
    // battle mon (battle_controller_player.c:3821 MON_DATA_STATUS, :3823 MON_DATA_HP).
    const isActive = activeBattler !== undefined && activeBattler.partyIndex === i
    const liveHp = isActive ? activeBattler!.mon.hp : end.hp
    const liveStatus = isActive ? activeBattler!.mon.status1 : end.status1

    // CalculateMonStats reads oldMaxHP from the slot before recalculating it
    // (pokemon.c:976,1002-1010). The party slot still holds the form-changed maxHp at
    // this point (formChange.ts:361 writes it), and the live battler's maxHp is kept
    // equal to it (formChange.ts:347-361). newMaxHP is the reverted/base value.
    const oldMaxHp = end.maxHp
    const newMaxHp = start.maxHp

    let hp: number
    if (start.speciesId === 'SPECIES_SHEDINJA') {
      // pokemon.c:1027-1031, keyed on the REVERTED species (UndoFormChange ran first).
      hp = liveHp !== 0 || oldMaxHp === 0 ? 1 : liveHp
    } else if (liveHp === 0 && oldMaxHp === 0) {
      // pokemon.c:1033-1034. Unreachable for a real party slot: a slot with 0 max HP
      // cannot also have been fought, but the C handles it, so this does too.
      hp = newMaxHp
    } else if (liveHp !== 0) {
      // pokemon.c:1035-1039 -- carry the max-HP delta across a form revert, floored at 1.
      hp = liveHp + newMaxHp - oldMaxHp
      if (hp <= 0) hp = 1
    } else {
      // pokemon.c:1040-1041 -- a fainted mon stays fainted.
      hp = 0
    }

    slot.hp = hp
    // Status1 persists across battles (battle_controller_player.c:3821). No other
    // party-carried battle state exists: status2 and the volatiles are cleared on
    // switch-out and live only in the battle structs (state.ts SimPartyMon).
    slot.status1 = liveStatus
  }

  return carried
}
