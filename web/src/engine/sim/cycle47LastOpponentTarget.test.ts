/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 47: the player controller's last-opponent override of the move-selection cursor.
//
// C lines checked:
//   battle_controller_player.c:2414-2416  the `<= 1` override (cursor + canSelectTarget = 0)
//   battle_controller_player.c:2412-2413  the zero-PP override, deliberately NOT ported
//   battle_controller_player.c:2397-2400  the default cursor (opposing side), cycle46
//   pokemon.c:1242-1252                   CountAliveMonsInBattle(BATTLE_ALIVE_EXCEPT_ACTIVE)
//   include/pokemon.h:397                 BATTLE_ALIVE_EXCEPT_ACTIVE == 0
//   pokemon.c:1267-1285                   GetDefaultMoveTarget (`<= 1` branch only)
//   include/constants/battle.h:36-37      BATTLE_OPPOSITE (^ 1) / BATTLE_PARTNER (^ 2)
//   include/constants/battle.h:496-501    MOVE_TARGET_USER / USER_OR_SELECTED bits
//   battle_controller_opponent.c:1583     the AI's own chosen target, untouched here

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { buildMoveAction } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon } from './state'

const data = loadSimData()

const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

const SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

function playerParty(): SimPartyMon[] {
  return buildPlayerParty(SPECS, 50, data)
}

function opponentParty(): SimPartyMon[] {
  return buildOpponentParty(trainer, 'elite', 50, data)
}

/** Doubles (BATTLE_TYPE_DOUBLE set) with the four standard battler slots: 0/2 player,
 * 1/3 opponent. Built through the production layout path, never by hand. */
function doublesState(rng: RandomSource = createRandomSource(1)): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng },
  )
}

function singlesState(rng: RandomSource = createRandomSource(1)): BattleState {
  return buildBattleState(
    { opponents: [trainer] },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng },
  )
}

describe('cycle47: last-opponent override of the player target cursor', () => {
  it('1. Absent {1,2}: count 1 -> default target flips to the absent foe\'s partner (3), chosen 1 ignored', () => {
    // battle_controller_player.c:2414-2416: CountAliveMonsInBattle(EXCEPT_ACTIVE) counts ids
    // {1,2,3} minus the absent bits {1,2} = {3} = 1 <= 1, so the cursor is replaced by
    // GetDefaultMoveTarget and canSelectTarget is cleared.
    // pokemon.c:1280-1285: opposing = (0 & 1) ^ 1 = 1; gAbsentBattlerFlags has bit 1, so the
    // partner BATTLE_PARTNER(1) = 1 ^ 2 = 3 is returned.
    // state.absentBattlerFlags is plain data on the returned state, so it is set directly.
    // Before this change canSelectTarget stayed 1 and chosenTarget 1 came back unchanged,
    // which is why this case passes chosenTarget 1 (the absent foe) rather than 3.
    const state = doublesState()
    state.absentBattlerFlags = 0b0110
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE', undefined, 1).target).toBe(3)
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE', undefined, 3).target).toBe(3)
  })

  it('2. Absent {2,3}: count 1 -> opposing 1 is present, cursor stays 1, chosen 3 ignored', () => {
    // CountAliveMonsInBattle(EXCEPT_ACTIVE) = ids {1,2,3} minus {2,3} = {1} = 1 <= 1.
    // GetDefaultMoveTarget: opposing = 1 and bit 1 is clear -> 1.
    // Before this change canSelectTarget stayed 1, so chosenTarget 3 came back unchanged.
    const state = doublesState()
    state.absentBattlerFlags = 0b1100
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE', undefined, 3).target).toBe(1)
  })

  it('3. Absent {2}: count 2 -> no override, chosen 3 honoured (threshold is <= 1, not <= 2)', () => {
    // CountAliveMonsInBattle(EXCEPT_ACTIVE) = ids {1,2,3} minus {2} = {1,3} = 2, so the
    // :2414-2416 condition fails and canSelectTarget stays 1 (SELECTED passes the :2404-2407 mask).
    const state = doublesState()
    state.absentBattlerFlags = 0b0100
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE', undefined, 3).target).toBe(3)
  })

  it('4. Absent none: count 3 -> no override, chosen 3 honoured', () => {
    const state = doublesState()
    state.absentBattlerFlags = 0
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE', undefined, 3).target).toBe(3)
  })

  it('5. Negative USER: count 0, MOVE_PROTECT still targets its user (0)', () => {
    // :2416 guards on !(moveTarget & (MOVE_TARGET_USER | MOVE_TARGET_USER_OR_SELECTED)), so a
    // USER move (include/constants/battle.h:496) never reaches GetDefaultMoveTarget.
    const state = doublesState()
    state.absentBattlerFlags = 0b1110
    expect(buildMoveAction(state, data, 0, 'MOVE_PROTECT').target).toBe(0)
  })

  it('6. Negative singles: the override is double-only (bufferA[..][1] == 0)', () => {
    // battle_controller_player.c:2402/2411: only the double battle `else` block holds the
    // override, so absent flags cannot move the singles cursor off the opposing battler.
    const state = singlesState()
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE').target).toBe(1)
    state.absentBattlerFlags = 0b1100
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE').target).toBe(1)
  })

  it('7. Negative opponent: battler 1 keeps its AI-chosen target (battle_controller_opponent.c:1583)', () => {
    // The override lives in battle_controller_player.c; opponent actions go through
    // getOpponentSelectedMoveTarget, which returns gBattleStruct->aiChosenTarget as-is for a
    // SELECTED move.
    const state = doublesState()
    state.absentBattlerFlags = 0b1000
    expect(buildMoveAction(state, data, 1, 'MOVE_TACKLE', undefined, 2).target).toBe(2)
  })
})
