// NoAliveMonsForPlayer / NoAliveMonsForOpponent (battle_script_commands.c:
// 3686-3719) and Cmd_checkteamslost's own OR of them (:3727-3730) into
// gBattleOutcome. Split out because both turn.ts (mid-action faints) and
// endTurn.ts/fieldEndTurn.ts (residual faints) need to recompute the outcome
// at the point a faint occurs -- see turn.ts's own citations for exactly which
// C call sites this batch treats as "the outcome is decided here" and why.
//
// PARTY HP, NOT BATTLER HP: both C functions sum `GetMonData(&party[i],
// MON_DATA_HP)` over the WHOLE roster, never `gBattleMons[battler].hp`
// directly. In the real game the active battler's own party slot stays live
// throughout the fight -- every damage/heal path re-syncs it via a controller
// message (`BtlController_EmitSetMonData(..., MON_DATA_HP, ...)`, e.g.
// battle_controller_player.c:3823) -- so summing the party is equivalent to
// summing "every reserve plus whichever one is active". This sim has no
// controller layer, so the same effect is produced explicitly: every place
// that changes `battler.mon.hp` also writes it into
// `state.sides[side].party[battler.partyIndex].hp` (this module's own
// `syncPartyHp`), and this module then only ever reads the party.
//
// EGGS AND ARENA: `MON_DATA_IS_EGG` and `BATTLE_TYPE_ARENA`'s per-mon
// "already lost" bitmask are both unreachable here -- eggs cannot occur in
// the 40 scripted fights (CLAUDE.md) and Arena is a battle type this sim does
// not model (battleTypeFlags is read nowhere in sim/ for BATTLE_TYPE_ARENA).
// A party slot with `speciesId === null` (SPECIES_NONE, an empty slot) is
// excluded, matching `GetMonData(..., MON_DATA_SPECIES)` being falsy.
//
// BATTLE_TYPE_INGAME_PARTNER's own MULTI_PARTY_SIZE branch
// (NoAliveMonsForPlayer, :3690-3694) is doubles-only (in-game partner trainer
// battles) and unreachable: this sim is singles-only (CLAUDE.md).

import type { BattleOutcome, BattleState } from './state'
import { B_SIDE_OPPONENT, B_SIDE_PLAYER } from './constants'

/** Writes a battler's current HP back to its own party slot, so
 * `computeBattleOutcome`'s party-only summation stays accurate without
 * re-deriving "which slot is this battler" at every call site. Every
 * production writer of `battler.mon.hp` calls this immediately afterward --
 * turn.ts's `applyDamage`, endTurn.ts's `applyEndTurnHp`, and
 * fieldEndTurn.ts's `applyWeatherDamage` and its two inline heal/damage
 * applications (grassy terrain, toxic terrain). */
export function syncPartyHp(state: BattleState, battlerId: number): void {
  const battler = state.battlers[battlerId]
  if (!battler) return
  const slot = state.sides[battlerId & 1].party[battler.partyIndex]
  if (slot) slot.hp = battler.mon.hp
}

/** NoAliveMonsForPlayer / NoAliveMonsForOpponent's shared shape, parameterised
 * on the side rather than duplicated -- see this module's header for what is
 * and is not reproduced.
 *
 * AN EMPTY PARTY IS "NO DATA", NOT "WIPED OUT". The real game's party array
 * always exists (it is the save file's roster; `gPlayerParty[0]` IS the
 * active battler's own record) -- a real battle can never have `party.length
 * === 0`. Every test in this directory predating this batch, though,
 * constructs a `BattleState` via `createBattleState({battlers, rng})` with no
 * `playerParty`/`opponentParty` at all, because outcome tracking did not
 * exist yet. Treating an empty party as "zero HP, side lost" would make
 * `computeBattleOutcome` return `'DREW'` after the very FIRST damage
 * application in every one of those tests (regardless of whether anything
 * actually fainted), silently truncating their own action loops and end-turn
 * ladders. Returning `false` for an empty party instead means "this side has
 * no party data, so this function has nothing to say about it" -- a caller
 * that wants outcome tracking opts in by supplying a party, the same way a
 * caller opts out of every other party-shaped mechanic in this codebase by
 * leaving the relevant field at its zero default. */
function noAliveMonsForSide(state: BattleState, sideIndex: 0 | 1): boolean {
  const party = state.sides[sideIndex].party
  if (party.length === 0) return false
  let hpCount = 0
  for (const mon of party) {
    if (mon.speciesId === null) continue // MON_DATA_SPECIES falsy, :3691/:3697/:3712
    hpCount += mon.hp
  }
  return hpCount === 0
}

/** Cmd_checkteamslost, battle_script_commands.c:3727-3730 -- the OR of both
 * sides' own check, with B_OUTCOME_WON=1/LOST=2 (include/constants/battle.h:
 * 91-93) so both-at-once IS B_OUTCOME_DREW (3) by construction, not a
 * separately-decided case. Pure: callers assign the result to
 * `state.battleOutcome` themselves, at the point the C's own checkteamslost
 * call site sits (see turn.ts/endTurn.ts/fieldEndTurn.ts for exactly where). */
export function computeBattleOutcome(state: BattleState): BattleOutcome {
  const lost = noAliveMonsForSide(state, B_SIDE_PLAYER)
  const won = noAliveMonsForSide(state, B_SIDE_OPPONENT)
  if (lost && won) return 'DREW'
  if (lost) return 'LOST'
  if (won) return 'WON'
  return null
}
