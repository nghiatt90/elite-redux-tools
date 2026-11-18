/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 46: doubles default-foe fallbacks in player target selection and buildMoveAction.
//
// C lines checked:
//   player default cursor position   battle_controller_player.c:2397-2400
//   opponent controller aiChosenTarget battle_controller_opponent.c:1583
//   GetDefaultMoveTarget opposite-side left pokemon.c:1267-1270
//   BIT_SIDE definition              include/constants/battle.h:45

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
  // Battler 2 is the second slot, so a bulky species keeps it alive after the fast
  // Lycanroc on battler 3 acts first in test (4).
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

describe('cycle46: doubles default-foe fallbacks in player target selection and buildMoveAction', () => {
  it('1. Doubles player default target picks opposite-side left (battler 0 -> 1, battler 2 -> 1)', () => {
    // battle_controller_player.c:2397-2400:
    // gMultiUsePlayerCursor = GetBattlerAtPosition((GetBattlerPosition(gActiveBattler) & BIT_SIDE) ^ BIT_SIDE);
    // (0 & 1) ^ 1 = 1; (2 & 1) ^ 1 = 1 (was 2 ^ 1 = 3).
    const state = doublesState()
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE').target).toBe(1)
    expect(buildMoveAction(state, data, 2, 'MOVE_TACKLE').target).toBe(1)
  })

  it('2. Doubles player battler 2 MOVE_AIR_CUTTER (BOTH) with chosenTarget 3 falls back to side default 1', () => {
    // MOVE_TARGET_BOTH cannot be selected by player (battle_controller_player.c:2407-2409),
    // falling back to getPlayerSelectedMoveTarget: (2 & 1) ^ 1 = 1.
    const state = doublesState()
    expect(buildMoveAction(state, data, 2, 'MOVE_AIR_CUTTER', undefined, 3).target).toBe(1)
  })

  it('3. Doubles opponent default target with no chosenTarget picks opposite-side left (battler 3 -> 0, battler 1 -> 0)', () => {
    // pokemon.c:1267-1270: opposing side left = GetBattlerAtPosition((pos & BIT_SIDE) ^ BIT_SIDE).
    // (3 & 1) ^ 1 = 0 (was 3 ^ 1 = 2); (1 & 1) ^ 1 = 0.
    const state = doublesState()
    expect(buildMoveAction(state, data, 3, 'MOVE_TACKLE').target).toBe(0)
    expect(buildMoveAction(state, data, 1, 'MOVE_TACKLE').target).toBe(0)
  })

  it('4. Doubles opponent with chosenTarget 2 for battler 3 survives', () => {
    // battle_controller_opponent.c:1583: gBattlerTarget = gBattleStruct->aiChosenTarget[gActiveBattler]
    const state = doublesState()
    expect(buildMoveAction(state, data, 3, 'MOVE_TACKLE', undefined, 2).target).toBe(2)
  })

  it('5. Negative: battler 2 MOVE_PROTECT (USER) -> 2; singles battler 0 -> 1 and battler 1 -> 0 unchanged', () => {
    // MOVE_TARGET_USER returns battlerId (battle_controller_player.c:2397-2398)
    const dState = doublesState()
    expect(buildMoveAction(dState, data, 2, 'MOVE_PROTECT').target).toBe(2)

    const sState = singlesState()
    expect(buildMoveAction(sState, data, 0, 'MOVE_TACKLE').target).toBe(1)
    expect(buildMoveAction(sState, data, 1, 'MOVE_TACKLE').target).toBe(0)
  })
})
