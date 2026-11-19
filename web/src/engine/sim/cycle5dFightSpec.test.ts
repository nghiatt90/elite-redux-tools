/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 5d: fight specs and the scripted start-of-battle Trick Room.
// Connects encounters.json rows to runBattle/createSession via fightSpecFor,
// and applies the scripted start-of-battle Trick Room for Tate & Liza.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_util.c:4162-4170  TryToSetFieldEffect reads VAR_BATTLE_FIELD_EFFECT_TYPE and VAR_BATTLE_FIELD_ID,
//                            isTemporary = FALSE
//   battle_util.c:4240-4252  case BATTLE_FIELD_EFFECT_ROOM / STATUS_FIELD_TRICK_ROOM:
//                            if (!(gFieldStatuses & STATUS_FIELD_TRICK_ROOM)) {
//                                gFieldTimers.started.trickRoom = TRUE;
//                                gFieldStatuses |= STATUS_FIELD_TRICK_ROOM;
//                                if (isTemporary) gFieldTimers.trickRoomTimer = TRICK_ROOM_DURATION;
//                                else gFieldTimers.trickRoomTimer = ROOM_DURATION_MAX; (255, battle_util.h:62)
//                            }
//   battle_util.c:4346-4347  case ABILITYEFFECT_SWITCH_IN_TERRAIN: if (TryToSetFieldEffect(battler)) effect++;
//   battle_main.c:3338       TryDoEventsBeforeFirstTurn: if (!gBattleStruct->terrainDone &&
//                            AbilityBattleEffects(ABILITYEFFECT_SWITCH_IN_TERRAIN, 0, 0, TRUE, 0) != 0)
//   battle_main.c:4325       GetMoveSpeed: if (!quash && IsTrickRoomActive()) speedValue.effectiveSpeed = ~speedValue.effectiveSpeed;
//   fieldEndTurn.ts:740-742  ENDTURN_TRICK_ROOM: decrements trickRoomTimer when !started.trickRoom;
//                            started.trickRoom is cleared before turn 1 (turn.ts:815),
//                            so 255 becomes 254 at the end of turn 1 and never expires in 60 turns.

import { describe, expect, it } from 'vitest'

import { loadSimData, type SimDataBundle } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { buildMoveAction, createSession, stepTurn } from './driver/session'
import { runBattle } from './driver/runBattle'
import { createRandomSource } from './rng'
import { hasFlag, STATUS_FIELD_TRICK_ROOM } from './constants'
import { fightSpecFor } from './driver/fightSpec'

const data = loadSimData()

const PLAYER_SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

function playerParty() {
  return buildPlayerParty(PLAYER_SPECS, 50, data)
}

describe('cycle 5d: fight specs and start-of-battle Trick Room', () => {
  it('1. fightSpecFor resolves Tate & Liza 1 and negative cases correctly', () => {
    // Tate & Liza 1:
    // - encounters.json inverseBattles has 1 row: TRAINER_TATE_AND_LIZA_1 (guard: null)
    // - fieldEffects has 1 row: MossdeepCity_Gym_EventScript_TateAndLiza with Trick Room (guard: null)
    // - battleEvents has 1 row: MossdeepCity_Gym_EventScript_TateAndLiza with BATTLE_EVENT_TENSE_BATTLE (guard: null)
    const spec1 = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    expect(spec1.inverseBattle).toBe(true)
    expect(spec1.format.opponents.length).toBe(1)
    expect(spec1.startFieldEffects).toEqual([
      { effectType: 'BATTLE_FIELD_EFFECT_ROOM', fieldId: 'STATUS_FIELD_TRICK_ROOM' },
    ])
    expect(spec1.battleEvents).toHaveLength(1)
    expect(spec1.battleEvents[0]!.event).toBe('BATTLE_EVENT_TENSE_BATTLE')
    expect(spec1.skipped).toEqual([])

    // Negative: Tate & Liza 2 has Trick Room but inverseBattle is false and no Tense Battle event
    const spec2 = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_2')
    expect(spec2.inverseBattle).toBe(false)
    expect(spec2.startFieldEffects).toEqual([
      { effectType: 'BATTLE_FIELD_EFFECT_ROOM', fieldId: 'STATUS_FIELD_TRICK_ROOM' },
    ])
    expect(spec2.battleEvents).toEqual([])
    expect(spec2.skipped).toEqual([])

    // Non-Mossdeep trainer gets [], [], false, and single-opponent format
    const specOther = fightSpecFor(data, 'TRAINER_ROXANNE_1')
    expect(specOther.startFieldEffects).toEqual([])
    expect(specOther.battleEvents).toEqual([])
    expect(specOther.inverseBattle).toBe(false)
    expect(specOther.format.opponents.length).toBe(1)
    expect(specOther.format.opponents[0]!.id).toBe('TRAINER_ROXANNE_1')
    expect(specOther.skipped).toEqual([])
  })

  it('2. fightSpecFor resolves Juan tag battle stages and Wallace', () => {
    // Juan stage 1: script SootopolisCity_Gym_1F_EventScript_Juan -> ['TRAINER_JUAN_1', 'TRAINER_WALLACE']
    const specJuan1 = fightSpecFor(data, 'TRAINER_JUAN_1')
    expect(specJuan1.format.opponents.map((t) => t.id)).toEqual(['TRAINER_JUAN_1', 'TRAINER_WALLACE'])
    const sessionJuan1 = createSession({ data, ...specJuan1, playerParty: playerParty(), rng: createRandomSource(1) })
    expect(sessionJuan1.state.battlersCount).toBe(4)

    // Juan stage 2: script SootopolisCity_Gym_1F_EventScript_Juan_Battle_2 -> ['TRAINER_JUAN_5', 'TRAINER_WALLACE_5']
    const specJuan5 = fightSpecFor(data, 'TRAINER_JUAN_5')
    expect(specJuan5.format.opponents.map((t) => t.id)).toEqual(['TRAINER_JUAN_5', 'TRAINER_WALLACE_5'])
    const sessionJuan5 = createSession({ data, ...specJuan5, playerParty: playerParty(), rng: createRandomSource(1) })
    expect(sessionJuan5.state.battlersCount).toBe(4)

    // TRAINER_WALLACE alone is not the first trainer of a Juan row and gets single-opponent format.
    // In trainers.json forcedDouble is false, so session has 2 battlers.
    const specWallace = fightSpecFor(data, 'TRAINER_WALLACE')
    expect(specWallace.format.opponents.map((t) => t.id)).toEqual(['TRAINER_WALLACE'])
    expect(specWallace.opponentTrainer.forcedDouble).toBe(false)
    const sessionWallace = createSession({ data, ...specWallace, playerParty: playerParty(), rng: createRandomSource(1) })
    expect(sessionWallace.state.battlersCount).toBe(2)
  })

  it('3. Trick Room state and turn-order reversal under battle_main.c:4325', () => {
    const spec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    const party = playerParty()

    // Session built with spec (includes startFieldEffects):
    const sessionWithTR = createSession({
      data,
      ...spec,
      playerParty: party,
      rng: createRandomSource(1),
    })
    // battle_util.c:4240-4252: STATUS_FIELD_TRICK_ROOM bit is set and trickRoomTimer is ROOM_DURATION_MAX (255)
    expect(hasFlag(sessionWithTR.state.field.statuses, STATUS_FIELD_TRICK_ROOM)).toBe(true)
    expect(sessionWithTR.state.field.timers.trickRoomTimer).toBe(255)

    // Negative: session built for Tate & Liza 1 WITHOUT startFieldEffects has neither
    const sessionWithoutTR = createSession({
      data,
      ...spec,
      startFieldEffects: [],
      playerParty: party,
      rng: createRandomSource(1),
    })
    expect(hasFlag(sessionWithoutTR.state.field.statuses, STATUS_FIELD_TRICK_ROOM)).toBe(false)
    expect(sessionWithoutTR.state.field.timers.trickRoomTimer).toBe(0)

    // Battler 1 in Tate & Liza 1's elite party is Tapu Lele:
    // Level 50, Base Spe 95, IV 0 (ironPill: true), EV 0, Nature Quiet (-Spe, 0.9x):
    // floor((2 * 95 + 0 + 0) * 50 / 100 + 5) = 100; floor(100 * 0.9) = 90.
    const tapuLeleSpe = sessionWithTR.state.battlers[1]!.mon.rawStats.spe
    expect(tapuLeleSpe).toBe(90)

    // Build player party with mon faster than Tapu Lele:
    // Jolteon: Level 50, Base Spe 130, IV 31, EV 0, Nature Hardy:
    // floor((2 * 130 + 31) * 0.5 + 5) = 150 > 90.
    const fasterParty = buildPlayerParty(
      [
        { species: 'SPECIES_JOLTEON', level: 50, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
      ],
      50,
      data,
    )
    const jolteonSpe = fasterParty[0]!.rawStats.spe
    expect(jolteonSpe).toBe(150)
    expect(jolteonSpe).toBeGreaterThan(tapuLeleSpe)

    // Case A (faster player mon):
    // Under Trick Room (battle_main.c:4325): effectiveSpeed is inverted, so slower mon (battler 1) acts first!
    const trSessionFast = createSession({
      data,
      ...spec,
      playerParty: fasterParty,
      rng: createRandomSource(1),
    })
    // Restrict to battlers 0 and 1 so "both choosing a damaging move" decides slot 0:
    trSessionFast.state.battlersCount = 2

    const playerActionFast = buildMoveAction(trSessionFast.state, data, 0, 'MOVE_TACKLE', trSessionFast.turnDeps.damage, 1)
    const opponentActionFast = buildMoveAction(trSessionFast.state, data, 1, 'MOVE_TACKLE', trSessionFast.turnDeps.damage, 0)
    const stepFastTR = stepTurn(trSessionFast, playerActionFast, opponentActionFast)
    expect(stepFastTR.outcome.actions[0]!.battlerId).toBe(1)

    // Without Trick Room: faster mon (battler 0) acts first
    const noTrSessionFast = createSession({
      data,
      ...spec,
      startFieldEffects: [],
      playerParty: fasterParty,
      rng: createRandomSource(1),
    })
    noTrSessionFast.state.battlersCount = 2

    const noTrPlayerActionFast = buildMoveAction(noTrSessionFast.state, data, 0, 'MOVE_TACKLE', noTrSessionFast.turnDeps.damage, 1)
    const noTrOpponentActionFast = buildMoveAction(noTrSessionFast.state, data, 1, 'MOVE_TACKLE', noTrSessionFast.turnDeps.damage, 0)
    const stepFastNoTR = stepTurn(noTrSessionFast, noTrPlayerActionFast, noTrOpponentActionFast)
    expect(stepFastNoTR.outcome.actions[0]!.battlerId).toBe(0)

    // Build player party with mon slower than Tapu Lele:
    // Torkoal: Level 50, Base Spe 20, IV 0 (ironPill: true), EV 0, Nature Quiet (-Spe, 0.9x):
    // floor((2 * 20 + 0) * 0.5 + 5) = 25; floor(25 * 0.9) = 22 < 90.
    const slowerParty = buildPlayerParty(
      [
        { species: 'SPECIES_TORKOAL', level: 50, ironPill: true, nature: 'NATURE_QUIET', moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
      ],
      50,
      data,
    )
    const torkoalSpe = slowerParty[0]!.rawStats.spe
    expect(torkoalSpe).toBe(22)
    expect(torkoalSpe).toBeLessThan(tapuLeleSpe)

    // Case B (slower player mon):
    // Under Trick Room: slower mon (battler 0, Spe 22) acts first!
    const trSessionSlow = createSession({
      data,
      ...spec,
      playerParty: slowerParty,
      rng: createRandomSource(1),
    })
    trSessionSlow.state.battlersCount = 2

    const playerActionSlow = buildMoveAction(trSessionSlow.state, data, 0, 'MOVE_TACKLE', trSessionSlow.turnDeps.damage, 1)
    const opponentActionSlow = buildMoveAction(trSessionSlow.state, data, 1, 'MOVE_TACKLE', trSessionSlow.turnDeps.damage, 0)
    const stepSlowTR = stepTurn(trSessionSlow, playerActionSlow, opponentActionSlow)
    expect(stepSlowTR.outcome.actions[0]!.battlerId).toBe(0)

    // Without Trick Room: faster mon (battler 1, Spe 90) acts first!
    const noTrSessionSlow = createSession({
      data,
      ...spec,
      startFieldEffects: [],
      playerParty: slowerParty,
      rng: createRandomSource(1),
    })
    noTrSessionSlow.state.battlersCount = 2

    const noTrPlayerActionSlow = buildMoveAction(noTrSessionSlow.state, data, 0, 'MOVE_TACKLE', noTrSessionSlow.turnDeps.damage, 1)
    const noTrOpponentActionSlow = buildMoveAction(noTrSessionSlow.state, data, 1, 'MOVE_TACKLE', noTrSessionSlow.turnDeps.damage, 0)
    const stepSlowNoTR = stepTurn(noTrSessionSlow, noTrPlayerActionSlow, noTrOpponentActionSlow)
    expect(stepSlowNoTR.outcome.actions[0]!.battlerId).toBe(1)

    // Timer behaviour after 1 turn:
    // fieldEndTurn.ts:740-742 decrements trickRoomTimer from 255 to 254 because started.trickRoom
    // was cleared at turn start by turn.ts:815 clearVarsBeforeTurnStarts.
    expect(trSessionFast.state.field.timers.trickRoomTimer).toBe(254)
    expect(hasFlag(trSessionFast.state.field.statuses, STATUS_FIELD_TRICK_ROOM)).toBe(true)
  })

  it('4. inverseBattle reaches session for Tate & Liza 1 and is false for 2', () => {
    const spec1 = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    const spec2 = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_2')
    expect(spec1.inverseBattle).toBe(true)
    expect(spec2.inverseBattle).toBe(false)

    const session1 = createSession({ data, ...spec1, playerParty: playerParty(), rng: createRandomSource(1) })
    const session2 = createSession({ data, ...spec2, playerParty: playerParty(), rng: createRandomSource(1) })
    expect(session1.inverseBattle).toBe(true)
    expect(session2.inverseBattle).toBe(false)
  })

  it('5. guarded field-effect rows are not applied and recorded in skipped', () => {
    const guardedRow = {
      effectType: 'BATTLE_FIELD_EFFECT_ROOM',
      fieldId: 'STATUS_FIELD_GRAVITY',
      guard: 'switch(var(VAR_ELITE_4_MODE)) case 2',
      map: 'EverGrandeCity_ChampionsRoom',
      script: 'EverGrandeCity_ChampionsRoom_EventScript_Steven',
      trainers: ['TRAINER_ROXANNE_1'],
    }
    const customData: SimDataBundle = {
      ...data,
      fieldEffects: [...data.fieldEffects, guardedRow],
    }
    const spec = fightSpecFor(customData, 'TRAINER_ROXANNE_1')
    expect(spec.startFieldEffects).toEqual([])
    expect(spec.skipped).toHaveLength(1)
    expect(spec.skipped[0]).toBe('fieldEffect:EverGrandeCity_ChampionsRoom_EventScript_Steven:switch(var(VAR_ELITE_4_MODE)) case 2')
    expect(spec.skipped[0]).toContain('switch(var(VAR_ELITE_4_MODE)) case 2')
  })

  it('6. runBattle smoke test for Tate & Liza 1 returns non-error outcome and is deterministic', () => {
    const spec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    const res1 = runBattle({
      data,
      playerParty: playerParty(),
      rng: createRandomSource(12345),
      maxTurns: 60,
      ...spec,
    })
    expect(['WON', 'LOST', 'DREW', 'MAX_TURNS'], res1.error ?? '').toContain(res1.outcome)
    expect(res1.outcome).not.toBe('ERROR')

    const res2 = runBattle({
      data,
      playerParty: playerParty(),
      rng: createRandomSource(12345),
      maxTurns: 60,
      ...spec,
    })
    expect(JSON.stringify(res1.log)).toBe(JSON.stringify(res2.log))
  })

  it('7. singles unchanged: non-forced, non-tag trainer produces identical state to old way', () => {
    const trainerId = 'TRAINER_ROXANNE_1'
    const spec = fightSpecFor(data, trainerId)
    const party = playerParty()
    const sessionA = createSession({
      data,
      ...spec,
      playerParty: party,
      rng: createRandomSource(42),
    })
    const sessionB = createSession({
      data,
      opponentTrainer: data.trainersById.get(trainerId)!,
      playerParty: party,
      rng: createRandomSource(42),
    })

    const { rng: _rngA, ...stateA } = sessionA.state
    const { rng: _rngB, ...stateB } = sessionB.state
    expect(stateA).toEqual(stateB)
  })
})
