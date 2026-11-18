/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4e (dbl-4e): chooseAiAction for any AI battler in a double.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_ai_main.c:190-205   BattleAI_ChooseMoveOrAction's DOUBLE branch
//   battle_ai_main.c:130-155   BattleAI_SetupFlags (opponent A + DOUBLE_BATTLE)
//   battle_ai_main.c:208-212   ComputeBattleAiScores -> SetupAIData(0xF) (:186 draw)
//   battle_ai_main.c:341-440   ChooseMoveOrAction_Doubles (per-target setup, tie, target)
//   battle_util.c:6326-6341    SetRandomTarget (one draw in a double)
//   battle_controller_opponent.c:1599-1611 OpponentHandleChooseMove default:
//   battle_controller_opponent.c:1570-1611 chosenMoveId 0xFF -> moves[0xFF]
//
// LAYOUT: two-opponent format, like cycle4dPartyIndexes.test.ts. Trainer A's
// party sits in opponent slots 0-2 and trainer B's in 3-5; battler 1 is
// trainer A's slot 0 and battler 3 is trainer B's slot 3.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState, trainerForBattler } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource } from './state'
import { BATTLE_TYPE_DOUBLE, BATTLE_TYPE_TWO_OPPONENTS } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { chooseAiAction, type ChooseAiActionDeps } from './ai/chooseAiAction'
import {
  chooseMoveOrActionDoubles,
  chooseMoveOrActionSingles,
  computeBattleAiScores,
  setRandomTargetSingles,
} from './ai/aiPipeline'
import {
  AI_FLAG_CHECK_BAD_MOVE,
  AI_FLAG_CHECK_FOE,
  AI_FLAG_CHECK_VIABILITY,
  AI_FLAG_DOUBLE_BATTLE,
  AI_FLAG_TRY_TO_FAINT,
  battleAiSetupFlags,
} from './ai/aiFlags'

const data = loadSimData()
const trainerA = data.trainersById.get('TRAINER_SAWYER_1')!
const trainerB = data.trainersById.get('TRAINER_ROXANNE_1')!

const SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

/** A two-opponent state: trainer A in opponent slots 0-2, trainer B in 3-5. */
function makeMulti(rng: RandomSource): BattleState {
  return buildBattleState(
    { opponents: [trainerA, trainerB] },
    {
      data,
      tier: 'elite',
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentParties: [buildOpponentParty(trainerA, 'elite', 50, data), buildOpponentParty(trainerB, 'elite', 50, data)],
      rng,
    },
  )
}

function makeSingles(rng: RandomSource): BattleState {
  return buildBattleState(
    { opponents: [trainerA], forcedDouble: false },
    {
      data,
      tier: 'elite',
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentParties: [buildOpponentParty(trainerA, 'elite', 50, data)],
      rng,
    },
  )
}

/** Every battler full HP, no status, no item, plain Blaze, Normal/Mystery types
 * -- same fixture shape as cycle4dPartyIndexes.test.ts. */
function normaliseBattlers(state: BattleState): void {
  for (const battler of state.battlers) {
    if (!battler) continue
    battler.mon.hp = battler.mon.maxHp
    battler.mon.status1 = 0
    battler.mon.status2 = 0
    battler.statuses3 = 0
    battler.statuses4 = 0
    battler.mon.itemId = null
    battler.mon.abilities = { ability: 'ABILITY_BLAZE', innates: [null, null, null] }
    battler.mon.types = ['NORMAL', 'MYSTERY', 'MYSTERY']
  }
}

/** One move with PP in slot 0, MOVE_NONE elsewhere, so the chooser's tie-break
 * can only return slot 0 and the tests below are about the target, not the move. */
function forceSingleMove(state: BattleState, battlerId: number, moveId: string): void {
  const mon = state.battlers[battlerId]!.mon
  mon.moves = [moveId, null, null, null]
  mon.pp = [10, 0, 0, 0]
}

/** A seeded RandomSource that records every value it hands out, so two runs can
 * be compared draw for draw. */
function recording(seed: number): { rng: RandomSource; values: number[] } {
  const base = createRandomSource(seed)
  const values: number[] = []
  return {
    rng: {
      random16(): number {
        const value = base.random16()
        values.push(value)
        return value
      },
    },
    values,
  }
}

function deps(state: BattleState): AiDamageDeps {
  return aiDamageDepsFor(data, state)
}

/** `ChooseAiActionDeps` for a battler: `deps.trainer` is the battle-wide
 * opponent-A row, which is what BattleAI_SetupFlags reads for EVERY AI battler
 * (battle_ai_main.c:147/:152) -- not the battler's own trainer. */
function chooseDeps(state: BattleState): ChooseAiActionDeps {
  return { ...aiDamageDepsFor(data, state), trainer: trainerA }
}

/** `buildBattleState` seeds `aiFlags` with `battleAiSetupFlags(opponents[0], 0)`,
 * i.e. without the battle's own flags; `chooseAiAction` recomputes it from
 * `state.battleTypeFlags` before scoring. The twins below must do the same. */
function withSetupFlags(state: BattleState): BattleState {
  state.aiFlags = battleAiSetupFlags(trainerA, state.battleTypeFlags)
  return state
}

describe('chooseAiAction in a double: the doubles chooser, for either AI battler', () => {
  it('battler 3 (right flank) returns USE_MOVE, and the target is ChooseMoveOrAction_Doubles\' target', () => {
    const seed = 4242
    const run = recording(seed)
    const state = makeMulti(run.rng)
    normaliseBattlers(state)
    forceSingleMove(state, 3, 'MOVE_TACKLE')

    const { action } = chooseAiAction(state, 3, chooseDeps(state))
    expect(action.action).toBe('USE_MOVE')
    expect(action.chosenMove?.id).toBe('MOVE_TACKLE')

    // The same board, same seed. ComputeBattleAiScores' outer
    // BattleAI_SetupAIData(0xF) runs SetRandomTarget before
    // BattleAI_ChooseMoveOrAction (battle_ai_main.c:210 -> :186), so one draw
    // precedes the chooser in a double (battle_util.c:6334).
    const twin = recording(seed)
    const chooserState = withSetupFlags(makeMulti(twin.rng))
    normaliseBattlers(chooserState)
    forceSingleMove(chooserState, 3, 'MOVE_TACKLE')
    chooserState.rng.random16() // the outer SetRandomTarget's draw
    const chooser = chooseMoveOrActionDoubles(chooserState, 3, deps(chooserState))

    expect(action.target).toBe(chooser.target)
    // The whole leading draw sequence is identical: outer draw, then the
    // chooser's per-target setup/tie-break draws and its final target draw.
    expect(run.values.slice(0, twin.values.length)).toEqual(twin.values)
  })

  it('battler 1 (left flank) returns USE_MOVE, and the target is ChooseMoveOrAction_Doubles\' target', () => {
    const seed = 777
    const run = recording(seed)
    const state = makeMulti(run.rng)
    normaliseBattlers(state)
    forceSingleMove(state, 1, 'MOVE_TACKLE')

    const { action } = chooseAiAction(state, 1, chooseDeps(state))
    expect(action.action).toBe('USE_MOVE')
    expect(action.chosenMove?.id).toBe('MOVE_TACKLE')

    const twin = recording(seed)
    const chooserState = withSetupFlags(makeMulti(twin.rng))
    normaliseBattlers(chooserState)
    forceSingleMove(chooserState, 1, 'MOVE_TACKLE')
    chooserState.rng.random16()
    const chooser = chooseMoveOrActionDoubles(chooserState, 1, deps(chooserState))

    expect(action.target).toBe(chooser.target)
    expect(run.values.slice(0, twin.values.length)).toEqual(twin.values)
  })

  it('the doubles chooser draws a different number of times than the singles one on the same board', () => {
    // battler 3 in this board has three live non-self battlers (0, 1, 2), so
    // ChooseMoveOrAction_Doubles makes three scoring passes plus its own
    // SetRandomTarget per pass (:358-361 -> :186) and two tie/target draws
    // (:404, :437). ChooseMoveOrAction_Singles would make one scoring pass and
    // one tie-break draw (:338). Both run the same scorers, so the doubles
    // count is strictly larger -- the branch is not a no-op.
    const seed = 4242
    const doublesRun = recording(seed)
    const doublesState = withSetupFlags(makeMulti(doublesRun.rng))
    normaliseBattlers(doublesState)
    forceSingleMove(doublesState, 3, 'MOVE_TACKLE')
    doublesState.rng.random16()
    chooseMoveOrActionDoubles(doublesState, 3, deps(doublesState))

    const singlesRun = recording(seed)
    const singlesState = withSetupFlags(makeMulti(singlesRun.rng))
    normaliseBattlers(singlesState)
    forceSingleMove(singlesState, 3, 'MOVE_TACKLE')
    const battlerTarget = setRandomTargetSingles(3)
    const { scores } = computeBattleAiScores(singlesState, 3, battlerTarget, deps(singlesState))
    chooseMoveOrActionSingles(singlesState, 3, scores, deps(singlesState))

    expect(doublesRun.values.length).toBeGreaterThan(singlesRun.values.length)
  })
})

describe('chooseAiAction: the singles branch is unchanged', () => {
  it('a state without BATTLE_TYPE_DOUBLE still runs scoring + ChooseMoveOrAction_Singles, draw for draw', () => {
    const seed = 99
    const run = recording(seed)
    const state = makeSingles(run.rng)
    normaliseBattlers(state)
    forceSingleMove(state, 1, 'MOVE_TACKLE')
    expect(state.battleTypeFlags & BATTLE_TYPE_DOUBLE).toBe(0)

    const { action } = chooseAiAction(state, 1, chooseDeps(state))
    expect(action.action).toBe('USE_MOVE')
    // SELECTED target, surviving as aiChosenTarget -- setRandomTargetSingles(1) = 0.
    expect(action.target).toBe(0)
    expect(action.chosenMove?.id).toBe('MOVE_TACKLE')

    // The pre-change sequence, hand-run on a twin built from the same seed:
    // setRandomTargetSingles (no draw, battle_util.c:6337), then
    // ComputeBattleAiScores (battle_ai_main.c:208-212) with gBattlerTarget =
    // battlerId ^ 1, then ChooseMoveOrAction_Singles (:270-339).
    const twin = recording(seed)
    const twinState = withSetupFlags(makeSingles(twin.rng))
    normaliseBattlers(twinState)
    forceSingleMove(twinState, 1, 'MOVE_TACKLE')
    const battlerTarget = setRandomTargetSingles(1)
    const { scores } = computeBattleAiScores(twinState, 1, battlerTarget, deps(twinState))
    const { choice } = chooseMoveOrActionSingles(twinState, 1, scores, deps(twinState))
    expect(choice).toEqual({ kind: 'move', moveIndex: 0 })
    expect(twinState.battlers[1]!.mon.moves[0]).toBe(action.chosenMove?.id)
    // Identical draw order: the singles scoring/tie-break sequence is a prefix
    // of chooseAiAction's own draws (later draws are AI_TrySwitchOrUseItem's).
    expect(run.values.slice(0, twin.values.length)).toEqual(twin.values)
  })
})

describe('chooseAiAction: battler-id guard', () => {
  it('battler 0 and battler 2 still throw, naming dbl-6b', () => {
    const state = makeMulti(createRandomSource(1))
    normaliseBattlers(state)
    expect(() => chooseAiAction(state, 0, chooseDeps(state))).toThrow(/dbl-6b/)
    expect(() => chooseAiAction(state, 2, chooseDeps(state))).toThrow(/dbl-6b/)
    // The message keeps the pre-change wording too, so the older test's
    // /not on the opponent side/ assertion still describes the behaviour.
    expect(() => chooseAiAction(state, 0, chooseDeps(state))).toThrow(/not on the opponent side/)
  })

  it('an id outside the battle throws', () => {
    const state = makeSingles(createRandomSource(1))
    normaliseBattlers(state)
    expect(() => chooseAiAction(state, 3, chooseDeps(state))).toThrow(/not in this battle/)
  })
})

describe('OpponentHandleChooseMove default: target mask (battle_controller_opponent.c:1599-1611)', () => {
  it('a USER-target move leaves the target at the user (battler 3)', () => {
    // :1600-1601 -- MOVE_TARGET_USER is a bit test, so the opponent controller
    // overwrites aiChosenTarget with gActiveBattler for every self-target move.
    const state = makeMulti(createRandomSource(1))
    normaliseBattlers(state)
    forceSingleMove(state, 3, 'MOVE_AGILITY') // target: USER
    const { action } = chooseAiAction(state, 3, chooseDeps(state))
    expect(action.action).toBe('USE_MOVE')
    expect(action.target).toBe(3)
  })

  it('a BOTH-target move aims at player left, or player right when player left is absent', () => {
    // :1602-1607 -- gBattlerTarget = GetBattlerAtPosition(B_POSITION_PLAYER_LEFT)
    // (battler 0), unless gAbsentBattlerFlags has its bit, then PLAYER_RIGHT (2).
    const make = (absentBattlerFlags: number): BattleState => {
      const state = makeMulti(createRandomSource(1))
      normaliseBattlers(state)
      forceSingleMove(state, 3, 'MOVE_EARTHQUAKE') // target: BOTH
      state.absentBattlerFlags = absentBattlerFlags
      return state
    }
    const targetFor = (state: BattleState): number | null => chooseAiAction(state, 3, chooseDeps(state)).action.target

    expect(targetFor(make(0))).toBe(0)

    // Negative control: player RIGHT absent does not move the target off 0.
    expect(targetFor(make(1 << 2))).toBe(0)

    expect(targetFor(make(1 << 0))).toBe(2)
  })
})

describe('trainerForBattler (docs/battle-sim/doubles-plan.md:121-129)', () => {
  it('battler 1 is opponents[0]; battler 3 is opponents[1], or opponents[0] in a forced double', () => {
    expect(trainerForBattler({ opponents: [trainerA, trainerB] }, 1)).toBe(trainerA)
    expect(trainerForBattler({ opponents: [trainerA, trainerB] }, 3)).toBe(trainerB)
    expect(trainerForBattler({ opponents: [trainerA], forcedDouble: true }, 3)).toBe(trainerA)
  })

  it('battler 2 needs a partner and battler 0 is the player', () => {
    expect(() => trainerForBattler({ opponents: [trainerA, trainerB] }, 2)).toThrow(/no partner/)
    expect(() => trainerForBattler({ opponents: [trainerA, trainerB], partner: trainerA }, 2)).not.toThrow()
    expect(trainerForBattler({ opponents: [trainerA, trainerB], partner: trainerB }, 2)).toBe(trainerB)
    expect(() => trainerForBattler({ opponents: [trainerA, trainerB] }, 0)).toThrow(/the player/)
  })
})

describe('chooseAiAction flags in a two-opponent double', () => {
  it('the TWO_OPPONENTS fixed set plus DOUBLE_BATTLE is what chooseAiAction hands to its scorers', () => {
    // battle_ai_main.c:144-145 selects the fixed four flags for TWO_OPPONENTS
    // (replacing the trainer-derived set), and :152-154 ORs AI_FLAG_DOUBLE_BATTLE
    // for DOUBLE/TWO_OPPONENTS. `chooseAiAction` recomputes exactly this from
    // `deps.trainer` and `state.battleTypeFlags` for EVERY AI battler (the C
    // reads gTrainerBattleOpponent_A, not the battler's own trainer), so the
    // value is asserted here rather than through an internal spy.
    const state = makeMulti(createRandomSource(1))
    expect(state.battleTypeFlags & BATTLE_TYPE_DOUBLE).toBe(BATTLE_TYPE_DOUBLE)
    expect(state.battleTypeFlags & BATTLE_TYPE_TWO_OPPONENTS).toBe(BATTLE_TYPE_TWO_OPPONENTS)
    expect(battleAiSetupFlags(trainerA, state.battleTypeFlags)).toBe(
      AI_FLAG_CHECK_BAD_MOVE | AI_FLAG_TRY_TO_FAINT | AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_FOE | AI_FLAG_DOUBLE_BATTLE,
    )
    // Same value for the right-flank battler's trainer (trainer B): the flags do
    // not depend on which trainer owns the battler.
    expect(battleAiSetupFlags(trainerB, state.battleTypeFlags)).toBe(
      AI_FLAG_CHECK_BAD_MOVE | AI_FLAG_TRY_TO_FAINT | AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_FOE | AI_FLAG_DOUBLE_BATTLE,
    )
  })
})
