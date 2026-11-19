/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 5b (dbl-5b, first slice): a session can start a double battle from a
// BattleFormat. `BATTLE_TYPE_DOUBLE` and `forcedDouble` now reach the driver: the
// default format for a forced-double trainer is TRAINER | DOUBLE, and a supplied
// two-opponent format adds TWO_OPPONENTS. stepTurn chooses battler 3's action with
// the AI too, after battler 1 (battler-id order, battle_main.c:3629/:3634-3639).
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_main.c:1757-1762  `if (DoubleReady && enemyPartySize >= 2 && gTrainers[trainerNum].doubleBattle)
//                            isDoubleBattle = TRUE; else isDoubleBattle = FALSE;`
//                            (the save-option arm above it is `doubleBattleMode`, unmodelled)
//   battle_main.c:1910-1913  `if (isDoubleBattle) gBattleTypeFlags |= BATTLE_TYPE_DOUBLE;
//                            else gBattleTypeFlags |= gTrainers[trainerNum].doubleBattle;`
//                            -- the else arm ORs the trainer's own bit back in, so a
//                            forced-double trainer is a double whatever the usable-mon count.
//   battle_main.c:3629       `for (gActiveBattler = 0; gActiveBattler < gBattlersCount; gActiveBattler++)`
//                            -- action selection runs in battler-id order, 0..3 in a double.
//   battle_main.c:3634-3639  STATE_TURN_START_RECORD -> `ComputeBattleAiScores(gActiveBattler)`
//                            for every AI-controlled battler, so battler 1 scores before battler 3.
//
// battleTypeFlagsFor's own documented rules (battleFormat.ts:68-82) give every value
// asserted below: one trainer is BATTLE_TYPE_TRAINER, plus BATTLE_TYPE_DOUBLE when
// `forcedDouble`; two opponents are TRAINER | DOUBLE | TWO_OPPONENTS
// (battle_tower.c:1627-1628).

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { trainerForBattler } from './driver/battleFormat'
import { beginTurn, buildMoveAction, createSession, stepTurn } from './driver/session'
import { chooseAiAction } from './ai/chooseAiAction'
import { runBattle } from './driver/runBattle'
import { createRandomSource } from './rng'
import type { RandomSource } from './state'
import { BATTLE_TYPE_DOUBLE, BATTLE_TYPE_TRAINER, BATTLE_TYPE_TWO_OPPONENTS } from './constants'

const data = loadSimData()
// Tate & Liza is the forced-double case: trainers.json sets forcedDouble true and
// the elite tier holds six mons, so the four-battler roster has a reserve.
const tateAndLiza = data.trainersById.get('TRAINER_TATE_AND_LIZA_1')!
// Two ordinary single-trainer rows with at least two mons each, for TWO_OPPONENTS.
const trainerA = data.trainersById.get('TRAINER_SAWYER_1')!
const trainerB = data.trainersById.get('TRAINER_ROXANNE_1')!

const PLAYER_SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

function playerParty() {
  return buildPlayerParty(PLAYER_SPECS, 50, data)
}

/** A seeded RandomSource that records every value it hands out, so two runs can be
 * compared draw for draw (same helper as cycle4eChooseAiActionDoubles.test.ts). */
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

describe('createSession starts a double from a BattleFormat (dbl-5b)', () => {
  it('1. a forced-double trainer starts a four-battler session from the default format', () => {
    const session = createSession({
      data,
      playerParty: playerParty(),
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(1),
    })

    expect(tateAndLiza.forcedDouble).toBe(true)
    expect(session.state.battlersCount).toBe(4)
    // battle_main.c:1910-1913: isDoubleBattle -> `gBattleTypeFlags |= BATTLE_TYPE_DOUBLE`.
    expect(session.state.battleTypeFlags & BATTLE_TYPE_DOUBLE).toBe(BATTLE_TYPE_DOUBLE)
    expect(session.state.battleTypeFlags & BATTLE_TYPE_TRAINER).toBe(BATTLE_TYPE_TRAINER)
    // One trainer fields both flanks: no TWO_OPPONENTS bit.
    expect(session.state.battleTypeFlags & BATTLE_TYPE_TWO_OPPONENTS).toBe(0)
    expect(session.format.opponents).toHaveLength(1)
    expect(session.format.opponents[0]!.id).toBe(tateAndLiza.id)

    // startingPartyIndexes (SetBattlePartyIds, battle_controllers.c:625-642): battler 1
    // takes the opponent's first valid slot (0); battler 3 skips its flank-mate's slot
    // and takes slot 1. No TWO_OPPONENTS override (:672-673) applies here.
    const expected = buildOpponentParty(tateAndLiza, 'elite', 50, data)
    expect(session.state.battlers[1]!.partyIndex).toBe(0)
    expect(session.state.battlers[3]!.partyIndex).toBe(1)
    expect(session.state.battlers[1]!.mon.speciesId).toBe(expected[0]!.speciesId)
    expect(session.state.battlers[3]!.mon.speciesId).toBe(expected[1]!.speciesId)
  })

  it('2. a two-opponent format puts trainer A on slots 0-2 and trainer B on 3-5', () => {
    const session = createSession({
      data,
      playerParty: playerParty(),
      opponentTrainer: trainerA,
      tier: 'elite',
      rng: createRandomSource(2),
      format: { opponents: [trainerA, trainerB] },
    })

    expect(session.state.battlersCount).toBe(4)
    // battle_tower.c:1627-1628: TRAINER | DOUBLE | TWO_OPPONENTS.
    expect(session.state.battleTypeFlags & BATTLE_TYPE_TRAINER).toBe(BATTLE_TYPE_TRAINER)
    expect(session.state.battleTypeFlags & BATTLE_TYPE_DOUBLE).toBe(BATTLE_TYPE_DOUBLE)
    expect(session.state.battleTypeFlags & BATTLE_TYPE_TWO_OPPONENTS).toBe(BATTLE_TYPE_TWO_OPPONENTS)

    // SetBattlePartyIds then forces battler 1 to slot 0 and battler 3 to slot 3
    // (battle_controllers.c:672-673).
    expect(session.state.battlers[1]!.partyIndex).toBe(0)
    expect(session.state.battlers[3]!.partyIndex).toBe(3)
    const aParty = buildOpponentParty(trainerA, 'elite', 50, data)
    const bParty = buildOpponentParty(trainerB, 'elite', 50, data)
    expect(session.state.sides[1].party[0]!.speciesId).toBe(aParty[0]!.speciesId)
    expect(session.state.sides[1].party[3]!.speciesId).toBe(bParty[0]!.speciesId)

    // trainerForBattler is the roster lookup, not the AI-flag source
    // (battle_ai_main.c:147/:152 keeps one battle-wide row for every AI battler).
    expect(trainerForBattler(session.format, 1)).toBe(trainerA)
    expect(trainerForBattler(session.format, 3)).toBe(trainerB)
  })

  it('3. a non-forced trainer with no format is still a two-battler singles battle, draw for draw', () => {
    const seed = 31
    const runA = recording(seed)
    const sessionA = createSession({ data, playerParty: playerParty(), opponentTrainer: trainerA, tier: 'elite', rng: runA.rng })
    const runB = recording(seed)
    const sessionB = createSession({ data, playerParty: playerParty(), opponentTrainer: trainerA, tier: 'elite', rng: runB.rng })

    expect(sessionA.state.battlersCount).toBe(2)
    expect(sessionA.state.battleTypeFlags & BATTLE_TYPE_DOUBLE).toBe(0)

    const actionA = buildMoveAction(sessionA.state, data, 0, 'MOVE_TACKLE', sessionA.turnDeps.damage)
    const actionB = buildMoveAction(sessionB.state, data, 0, 'MOVE_TACKLE', sessionB.turnDeps.damage)
    const stepA = stepTurn(sessionA, actionA)
    // A supplied slotActions[3] is the pre-change shape: battler 3 is never consulted.
    // If the singles path drew for battler 3, runA would hold more values than runB.
    const stepB = stepTurn(sessionB, actionB, undefined, { 3: null })

    expect(runA.values).toEqual(runB.values)
    expect(stepA.outcome.actions.map((a) => a.battlerId)).toEqual(stepB.outcome.actions.map((a) => a.battlerId))
  })

  it('4. one double turn runs: battlers 0-3 all act and battler 3 acts on the AI choice', () => {
    const SEED = 4242
    /** Keep every battler alive so all four action slots are reached this turn. */
    const normalise = (session: ReturnType<typeof createSession>): void => {
      for (const battler of session.state.battlers) {
        if (!battler) continue
        battler.mon.hp = battler.mon.maxHp = 3000
        battler.mon.status1 = 0
        battler.statuses3 = 0
        battler.statuses4 = 0
      }
    }
    const make = () =>
      createSession({ data, playerParty: playerParty(), opponentTrainer: tateAndLiza, tier: 'elite', rng: createRandomSource(SEED) })

    const session = make()
    normalise(session)
    const playerAction0 = buildMoveAction(session.state, data, 0, 'MOVE_TACKLE', session.turnDeps.damage)
    const playerAction2 = buildMoveAction(session.state, data, 2, 'MOVE_TACKLE', session.turnDeps.damage)
    const step = stepTurn(session, playerAction0, undefined, { 2: playerAction2 })

    expect(step.outcome.actions.map((a) => a.battlerId)).toEqual(expect.arrayContaining([0, 1, 2, 3]))
    const battler3 = step.outcome.actions.find((a) => a.battlerId === 3)!
    expect(['USE_MOVE', 'SWITCH']).toContain(battler3.action)

    // Reconstruct the AI choice on a twin built the same way and seeded identically:
    // stepTurn runs HandleBattleEvents, then chooseAiAction(1), then chooseAiAction(3)
    // (battle_main.c:3629/:3634-3639), so replaying those two calls here reaches the
    // same decision. The outcome itself does not carry `chosenMoveId` on the normal
    // USE_MOVE return, so the move is read from gChosenMovePos for that slot.
    const twin = make()
    normalise(twin)
    beginTurn(twin)
    chooseAiAction(twin.state, 1, twin.chooseAiDeps)
    const expected3 = chooseAiAction(twin.state, 3, twin.chooseAiDeps)
    expect(expected3.action.action).toBe(battler3.action)
    if (expected3.action.action === 'USE_MOVE') {
      expect(session.state.battlers[3]!.mon.moves[session.state.chosenMovePositions[3]]).toBe(expected3.action.chosenMove?.id)
    }
  })

  it('5. partner format builds a 4-battler session (battle_tower.c:2394-2461) and mismatched opponents[0] throws', () => {
    // FillPartnerParty (battle_tower.c:2394-2461): partner formats build 4 battlers with BATTLE_TYPE_INGAME_PARTNER (dbl-6b)
    const session = createSession({
      data,
      playerParty: playerParty(),
      opponentTrainer: trainerA,
      tier: 'elite',
      rng: createRandomSource(3),
      format: { opponents: [trainerA, trainerB], partner: trainerA },
    })
    expect(session.state.battlersCount).toBe(4)

    expect(() =>
      createSession({
        data,
        playerParty: playerParty(),
        opponentTrainer: trainerA,
        tier: 'elite',
        rng: createRandomSource(3),
        format: { opponents: [trainerB] },
      }),
    ).toThrow(`createSession: format.opponents[0] must be ${trainerA.id}`)
  })

  it('6. runBattle runs a double battle to completion (dbl-5c)', () => {
    const result = runBattle({
      data,
      playerParty: playerParty(),
      opponentTrainer: tateAndLiza,
      tier: 'elite',
    })
    expect(result.outcome).not.toBe('ERROR')
    expect(result.error).toBeUndefined()
    expect(result.turns).toBeGreaterThan(0)
  })
})
