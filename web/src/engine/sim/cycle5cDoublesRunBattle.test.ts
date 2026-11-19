/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 5c (dbl-5c): runBattle supports double battles.
// Battler 0 and battler 2 both receive actions each turn; the default player
// policy evaluates highest-power moves per battler or switches on faint when a
// reserve exists; absent / fainted battlers with no reserve receive null actions.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_main.c:3629       `for (gActiveBattler = 0; gActiveBattler < gBattlersCount; gActiveBattler++)`
//                            -- action selection loops over all battlers (0..3 in doubles).
//   battle_main.c:3646-3647  `if (gBattleStruct->field_91 & gBitTable[gActiveBattler])
//                            gChosenActionByBattler[gActiveBattler] = B_ACTION_NOTHING_FAINTED;`
//                            -- absent / fainted battlers with no reserve get no action.
//   battle_main.c:3757-3762  `if (gActiveBattler == 2 && gChosenActionByBattler[0] == B_ACTION_SWITCH)`
//                            -- switch selection skips partner's chosen switch slot.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createSession } from './driver/session'
import { defaultPlayerPolicy, runBattle } from './driver/runBattle'
import { createRandomSource } from './rng'

const data = loadSimData()
const tateAndLiza = data.trainersById.get('TRAINER_TATE_AND_LIZA_1')!
const may = data.trainersById.get('TRAINER_MAY_ROUTE_103_TORCHIC')!

const PLAYER_SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

function playerParty() {
  return buildPlayerParty(PLAYER_SPECS, 50, data)
}

describe('runBattle supports double battles (dbl-5c)', () => {
  it('1. Tate & Liza smoke with determinism', () => {
    const seed = 12345
    const party1 = playerParty()
    const result1 = runBattle({
      data,
      playerParty: party1,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(seed),
      maxTurns: 60,
    })

    const party2 = playerParty()
    const result2 = runBattle({
      data,
      playerParty: party2,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(seed),
      maxTurns: 60,
    })

    expect(result1.outcome).not.toBe('ERROR')
    expect(result1.error).toBeUndefined()
    expect(result1.turns).toBeGreaterThan(0)
    expect(result1.outcome).toBe(result2.outcome)
    expect(result1.turns).toBe(result2.turns)
    expect(result1.log).toEqual(result2.log)
  })

  it('2. per-battler policy picking different best moves', () => {
    // Battler 0 has Tackle (40) vs Earthquake (100) -> should choose Earthquake
    // Battler 2 has Scratch (40) vs Waterfall (80) -> should choose Waterfall
    const party = buildPlayerParty(
      [
        { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE', 'MOVE_EARTHQUAKE'] },
        { species: 'SPECIES_GYARADOS', level: 50, moves: ['MOVE_SCRATCH', 'MOVE_WATERFALL'] },
      ],
      50,
      data,
    )

    const session = createSession({
      data,
      playerParty: party,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })
    const policyAction0 = defaultPlayerPolicy(session.state, data, session.turnDeps.damage, 0)
    const policyAction2 = defaultPlayerPolicy(session.state, data, session.turnDeps.damage, 2)
    expect(policyAction0?.action).toBe('USE_MOVE')
    expect(policyAction0?.chosenMove?.id).toBe('MOVE_EARTHQUAKE')
    expect(policyAction2?.action).toBe('USE_MOVE')
    expect(policyAction2?.chosenMove?.id).toBe('MOVE_WATERFALL')

    const result = runBattle({
      data,
      playerParty: party,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
      maxTurns: 1,
    })

    expect(result.log[0]).toBeDefined()
    const action0 = result.log[0]!.actions.find((a) => a.battlerId === 0)
    const action2 = result.log[0]!.actions.find((a) => a.battlerId === 2)

    expect(action0?.action).toBe('USE_MOVE')
    expect(action2?.action).toBe('USE_MOVE')
  })

  it('3. faint with reserve gives SWITCH', () => {
    const party = buildPlayerParty(
      [
        { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
      ],
      50,
      data,
    )
    const session = createSession({
      data,
      playerParty: party,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(1),
    })

    // Faint battler 2; battler 0 is alive (slot 0), battler 2 was slot 1, reserve is slot 2 (Swampert)
    session.state.battlers[2]!.mon.hp = 0

    const action2 = defaultPlayerPolicy(session.state, data, session.turnDeps.damage, 2)
    expect(action2).toEqual({
      action: 'SWITCH',
      moveToBeUsed: null,
      chosenMove: null,
      target: null,
    })
    expect(session.state.battlers[2]!.monToSwitchIntoId).toBe(2)

    // And test battler 0 fainted with reserve
    session.state.battlers[2]!.mon.hp = 100
    session.state.battlers[0]!.mon.hp = 0
    const action0 = defaultPlayerPolicy(session.state, data, session.turnDeps.damage, 0)
    expect(action0).toEqual({
      action: 'SWITCH',
      moveToBeUsed: null,
      chosenMove: null,
      target: null,
    })
    expect(session.state.battlers[0]!.monToSwitchIntoId).toBe(2)
  })

  it('4. singles unchanged', () => {
    const playerPartySingle = buildPlayerParty(
      [
        {
          species: 'SPECIES_SWAMPERT',
          level: 50,
          nature: 'NATURE_ADAMANT',
          evs: { hp: 252, atk: 252, spe: 4 },
          moves: ['MOVE_WATERFALL', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH', 'MOVE_ROCK_SLIDE'],
        },
        {
          species: 'SPECIES_GARCHOMP',
          level: 50,
          nature: 'NATURE_JOLLY',
          evs: { atk: 252, spe: 252, hp: 4 },
          moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
        },
      ],
      50,
      data,
    )
    const rng = createRandomSource(42)
    const result = runBattle({
      data,
      playerParty: playerPartySingle,
      opponentTrainer: may,
      tier: 'elite',
      rng,
      maxTurns: 60,
    })

    expect(result.outcome).toBe('WON')
    expect(result.turns).toBe(5)
    expect(result.error).toBeUndefined()
  })

  it('5. custom policy sees 0 and 2 on doubles and only 0 on singles', () => {
    const doublesSeenBattlers = new Set<number>()
    const doublesResult = runBattle({
      data,
      playerParty: playerParty(),
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(1),
      maxTurns: 1,
      playerPolicy: (state, _unmodelled, battlerId) => {
        doublesSeenBattlers.add(battlerId)
        return defaultPlayerPolicy(state, data, undefined, battlerId)
      },
    })
    expect(doublesResult.error).toBeUndefined()
    expect(Array.from(doublesSeenBattlers).sort()).toEqual([0, 2])

    const singlesSeenBattlers = new Set<number>()
    const singlesResult = runBattle({
      data,
      playerParty: playerParty(),
      opponentTrainer: may,
      tier: 'elite',
      rng: createRandomSource(1),
      maxTurns: 1,
      playerPolicy: (state, _unmodelled, battlerId) => {
        singlesSeenBattlers.add(battlerId)
        return defaultPlayerPolicy(state, data, undefined, battlerId)
      },
    })
    expect(singlesResult.error).toBeUndefined()
    expect(Array.from(singlesSeenBattlers)).toEqual([0])
  })
})
