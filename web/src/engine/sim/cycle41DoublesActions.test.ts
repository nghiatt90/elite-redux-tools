/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 41 (dbl-3a): per-slot action selection and the SetRandomTarget doubles branch.
//
//   (1) SetRandomTarget draws `Random() % 2` in a double and flips a dead pick with
//       BIT_FLANK without re-checking the flank (battle_util.c:6326-6341); singles never
//       draws and always returns the left foe of the opposing side.
//   (2) buildMoveAction carries an explicit controller target: the player's cursor
//       survives only where canSelectTarget is set (battle_controller_player.c:2398-2410),
//       the AI's aiChosenTarget is used as-is apart from the USER/BOTH overrides
//       (battle_controller_opponent.c:1583, :1599-1611).
//   (3) getOpponentSelectedMoveTarget's MOVE_TARGET_BOTH absent-left fallback
//       (battle_controller_opponent.c:1602-1607).
//   (4) stepTurn runs a turn whose actions array has entries for battlers 2 and 3.
//
// C lines checked:
//   SetRandomTarget              battle_util.c:6326-6341
//   GetMoveTarget RANDOM case    battle_util.c:6393-6401
//   player canSelectTarget       battle_controller_player.c:2380-2416
//   opponent target choice       battle_controller_opponent.c:1583-1611
//   IsBattlerAlive               battle_util.c:6685-6694 (via turn.ts:331)

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { buildMoveAction, cloneSession, createSession, groundingFor, stepTurn, type BattleSession } from './driver/session'
import { getOpponentSelectedMoveTarget } from './moveTargetFlags'
import { getMoveTarget, type DamageResolver, type TurnLoopDeps } from './turn'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon } from './state'
import { BATTLE_TYPE_DOUBLE } from './constants'

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

/** Records every draw; the values are consumed in order and then fall back to 0. */
function scriptedRng(values: number[] = []): RandomSource & { calls: number } {
  let index = 0
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return values[index++] ?? 0
    },
  }
  return rng
}

/** A resolver that never draws and deals a fixed amount. */
function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    grounding: groundingFor(data, state),
    damage,
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    moveBehaviors: data.moveBehaviors,
    hazardTypes: { typeChart: data.typeChart, inverseTypeChart: data.inverseTypeChart, inverseBattle: false },
  }
}

/** A double built the way cycle 39/40 do: a normal session is created, its state is
 * swapped for the four-battler one, and cloneSession rebuilds every dep around it. */
function doublesSession(): BattleSession {
  const state = doublesState()
  const base = createSession({
    data,
    playerParty: playerParty(),
    opponentTrainer: trainer,
    rng: createRandomSource(1),
  })
  base.state = state
  return cloneSession(base, 3)
}

/** The first SELECTED damaging move in a battler's moveset (static target, so the
 * opponent controller's aiChosenTarget is what decides where it lands). */
function firstSelectableDamagingMove(state: BattleState, battlerId: number): string {
  const moves = state.battlers[battlerId]!.mon.moves
  for (const moveId of moves) {
    if (!moveId) continue
    const moveData = data.dataContext.move(moveId)
    if (moveData?.target === 'SELECTED' && (moveData.power ?? 0) > 0) return moveId
  }
  throw new Error(`battler ${battlerId} has no SELECTED damaging move`)
}

// ---------------------------------------------------------------------------
// (1) SetRandomTarget, battle_util.c:6326-6341
// ---------------------------------------------------------------------------

describe('(1) SetRandomTarget draws Random() % 2 in a double', () => {
  it('player attacker: draw 0 targets battler 1, draw 1 targets battler 3, one draw each', () => {
    // :6334 `target = GetBattlerAtPosition(targets[GetBattlerSide(battlerId)][Random() % 2])`
    // with B_SIDE_PLAYER -> {B_POSITION_OPPONENT_LEFT (1), B_POSITION_OPPONENT_RIGHT (3)}.
    const rngLeft = scriptedRng([0])
    const stateLeft = doublesState(rngLeft)
    expect(getMoveTarget(stateLeft, 0, 'MOVE_TACKLE', loopDeps(stateLeft, fixedDamage(0)))).toBe(1)
    expect(rngLeft.calls).toBe(1)

    const rngRight = scriptedRng([1])
    const stateRight = doublesState(rngRight)
    expect(getMoveTarget(stateRight, 0, 'MOVE_TACKLE', loopDeps(stateRight, fixedDamage(0)))).toBe(3)
    expect(rngRight.calls).toBe(1)
  })

  it('opponent attacker: draw 0 targets battler 0, draw 1 targets battler 2', () => {
    // B_SIDE_OPPONENT -> {B_POSITION_PLAYER_LEFT (0), B_POSITION_PLAYER_RIGHT (2)}.
    const rngLeft = scriptedRng([0])
    const stateLeft = doublesState(rngLeft)
    expect(getMoveTarget(stateLeft, 1, 'MOVE_TACKLE', loopDeps(stateLeft, fixedDamage(0)))).toBe(0)
    expect(rngLeft.calls).toBe(1)

    const rngRight = scriptedRng([1])
    const stateRight = doublesState(rngRight)
    expect(getMoveTarget(stateRight, 1, 'MOVE_TACKLE', loopDeps(stateRight, fixedDamage(0)))).toBe(2)
    expect(rngRight.calls).toBe(1)
  })
})

describe('(1b) SetRandomTarget flips a dead pick with BIT_FLANK', () => {
  it('draw selects a dead left foe -> returns the right foe', () => {
    // :6335-6336 `if (!IsBattlerAlive(target)) target ^= BIT_FLANK;` -- 1 ^ 2 = 3.
    const rng = scriptedRng([0])
    const state = doublesState(rng)
    state.battlers[1]!.mon.hp = 0
    expect(getMoveTarget(state, 0, 'MOVE_TACKLE', loopDeps(state, fixedDamage(0)))).toBe(3)
    expect(rng.calls).toBe(1)
  })

  it('draw selects a dead right foe -> returns the left foe', () => {
    // 3 ^ 2 = 1.
    const rng = scriptedRng([1])
    const state = doublesState(rng)
    state.battlers[3]!.mon.hp = 0
    expect(getMoveTarget(state, 0, 'MOVE_TACKLE', loopDeps(state, fixedDamage(0)))).toBe(1)
    expect(rng.calls).toBe(1)
  })

  it('both foes dead and the draw selects 1 -> returns the dead flank 3 anyway', () => {
    // The C does not re-check the flank: the XOR result is returned unconditionally.
    const rng = scriptedRng([0])
    const state = doublesState(rng)
    state.battlers[1]!.mon.hp = 0
    state.battlers[3]!.mon.hp = 0
    expect(getMoveTarget(state, 0, 'MOVE_TACKLE', loopDeps(state, fixedDamage(0)))).toBe(3)
  })
})

describe('(1c) singles never draws and always takes the left foe', () => {
  it('attacker 0 returns battler 1 and consumes zero draws, dead target or not', () => {
    // :6337 `target = GetBattlerAtPosition(targets[GetBattlerSide(battlerId)][0]);`
    const rng = scriptedRng([])
    const state = singlesState(rng)
    expect(getMoveTarget(state, 0, 'MOVE_TACKLE', loopDeps(state, fixedDamage(0)))).toBe(1)
    state.battlers[1]!.mon.hp = 0
    expect(getMoveTarget(state, 0, 'MOVE_TACKLE', loopDeps(state, fixedDamage(0)))).toBe(1)
    expect(rng.calls).toBe(0)
  })
})

describe('(1d) Follow Me still wins over SetRandomTarget and draws nothing', () => {
  it('a SELECTED move in a double goes to the follow-me target', () => {
    // GetMoveTarget's SELECTED case (battle_util.c:6364-6366) calls
    // IsAffectedByFollowMe first; SetRandomTarget is only reached in the else.
    const rng = scriptedRng([])
    const state = doublesState(rng)
    state.sides[1].timers.followmeTimer = 1
    state.sides[1].timers.followmeTarget = 3
    expect(getMoveTarget(state, 0, 'MOVE_TACKLE', loopDeps(state, fixedDamage(0)))).toBe(3)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (2) buildMoveAction and the controller's explicit target
// ---------------------------------------------------------------------------

describe('(2) buildMoveAction honours a chosen target only where canSelectTarget allows it', () => {
  it('player battler 2 with a SELECTED move takes either foe as given', () => {
    const state = doublesState()
    expect(state.battleTypeFlags & BATTLE_TYPE_DOUBLE).toBeTruthy()
    expect(buildMoveAction(state, data, 2, 'MOVE_TACKLE', undefined, 3).target).toBe(3)
    expect(buildMoveAction(state, data, 2, 'MOVE_TACKLE', undefined, 1).target).toBe(1)
  })

  it('a USER-target move returns the battler itself regardless of chosenTarget', () => {
    // :2397-2398 `if (moveTarget & MOVE_TARGET_USER) gMultiUsePlayerCursor = gActiveBattler;`
    const state = doublesState()
    expect(buildMoveAction(state, data, 2, 'MOVE_PROTECT', undefined, 1).target).toBe(2)
  })

  it('a BOTH move ignores chosenTarget (canSelectTarget is not set)', () => {
    // :2407-2409 -- MOVE_TARGET_BOTH is in the mask, so the cursor is not selectable and
    // the player target stays the getPlayerSelectedMoveTarget fallback, (2 & 1) ^ 1 = 1
    // (battle_controller_player.c:2397-2400).
    const state = doublesState()
    expect(buildMoveAction(state, data, 2, 'MOVE_AIR_CUTTER', undefined, 1).target).toBe(1)
  })

  it('singles is unchanged for a player and an opponent move', () => {
    // No singles caller passes chosenTarget, so the action is exactly the pre-cycle shape.
    const state = singlesState()
    const player = buildMoveAction(state, data, 0, 'MOVE_TACKLE')
    expect(player.target).toBe(1)
    expect(buildMoveAction(state, data, 0, 'MOVE_TACKLE', undefined, undefined)).toEqual(player)

    const opponent = buildMoveAction(state, data, 1, 'MOVE_TACKLE')
    expect(opponent.target).toBe(0)
    expect(buildMoveAction(state, data, 1, 'MOVE_TACKLE', undefined, undefined)).toEqual(opponent)
  })
})

// ---------------------------------------------------------------------------
// (3) getOpponentSelectedMoveTarget, battle_controller_opponent.c:1600-1611
// ---------------------------------------------------------------------------

describe('(3) opponent MOVE_TARGET_BOTH falls back to PLAYER_RIGHT when battler 0 is absent', () => {
  it('absent bit 0 set -> battler 2; clear -> battler 0', () => {
    // :1602-1607 `gBattlerTarget = GetBattlerAtPosition(B_POSITION_PLAYER_LEFT); if
    // (gAbsentBattlerFlags & gBitTable[gBattlerTarget]) gBattlerTarget =
    // GetBattlerAtPosition(B_POSITION_PLAYER_RIGHT);` and gBitTable[0] == 1.
    expect(getOpponentSelectedMoveTarget(3, 'BOTH', 1, 0)).toBe(0)
    expect(getOpponentSelectedMoveTarget(3, 'BOTH', 1, 1)).toBe(2)
  })

  it('the singles call shape is unchanged', () => {
    // :1600-1601 USER-family static targets self; the :1583 assignment otherwise stands.
    expect(getOpponentSelectedMoveTarget(1, 'USER', 0)).toBe(1)
    expect(getOpponentSelectedMoveTarget(1, 'SELECTED', 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (4) stepTurn runs slot actions for battlers 2 and 3
// ---------------------------------------------------------------------------

describe('(4) stepTurn slot actions', () => {
  it('battlers 2 and 3 act and their targets lose HP', () => {
    const session = doublesSession()
    // Every accuracy roll hits (0 always lands for these moves).
    session.state.rng = scriptedRng([])
    const foeMove = firstSelectableDamagingMove(session.state, 3)
    const hp2Before = session.state.battlers[2]!.mon.hp
    const hp3Before = session.state.battlers[3]!.mon.hp

    const step = stepTurn(
      session,
      buildMoveAction(session.state, data, 0, 'MOVE_TACKLE'),
      null,
      {
        2: buildMoveAction(session.state, data, 2, 'MOVE_TACKLE', undefined, 3),
        3: buildMoveAction(session.state, data, 3, foeMove, undefined, 2),
      },
    )

    const action2 = step.outcome.actions.find((a) => a.battlerId === 2)!
    const action3 = step.outcome.actions.find((a) => a.battlerId === 3)!
    expect(action2.targetId).toBe(3)
    expect(action2.targetDamage).toBeGreaterThan(0)
    expect(action3.targetId).toBe(2)
    expect(action3.targetDamage).toBeGreaterThan(0)
    expect(session.state.battlers[3]!.mon.hp).toBeLessThan(hp3Before)
    expect(session.state.battlers[2]!.mon.hp).toBeLessThan(hp2Before)
  })

  it('without slotActions battlers 2 and 3 do nothing (HP untouched)', () => {
    const session = doublesSession()
    session.state.rng = scriptedRng([])
    const hp2Before = session.state.battlers[2]!.mon.hp
    const hp3Before = session.state.battlers[3]!.mon.hp

    const step = stepTurn(session, buildMoveAction(session.state, data, 0, 'MOVE_TACKLE'), null)

    const action2 = step.outcome.actions.find((a) => a.battlerId === 2)
    const action3 = step.outcome.actions.find((a) => a.battlerId === 3)
    expect(action2?.targetId ?? null).toBeNull()
    expect(action2?.targetDamage ?? null).toBeNull()
    expect(action3?.targetId ?? null).toBeNull()
    expect(action3?.targetDamage ?? null).toBeNull()
    expect(session.state.battlers[2]!.mon.hp).toBe(hp2Before)
    expect(session.state.battlers[3]!.mon.hp).toBe(hp3Before)
    // The turn itself did run: battler 0's Tackle landed.
    expect(step.outcome.actions.find((a) => a.battlerId === 0)!.targetDamage).toBeGreaterThan(0)
  })

  it('a singles turn is deep-equal with and without the new parameter', () => {
    const build = (): BattleSession =>
      createSession({
        data,
        playerParty: playerParty(),
        opponentTrainer: trainer,
        rng: createRandomSource(7),
      })
    const first = build()
    const second = build()
    const action = buildMoveAction(first.state, data, 0, 'MOVE_TACKLE')
    const action2 = buildMoveAction(second.state, data, 0, 'MOVE_TACKLE')

    const withoutSlot = stepTurn(first, action)
    const withSlot = stepTurn(second, action2, undefined, undefined)

    expect(JSON.parse(JSON.stringify(withSlot.outcome))).toEqual(JSON.parse(JSON.stringify(withoutSlot.outcome)))
  })
})
