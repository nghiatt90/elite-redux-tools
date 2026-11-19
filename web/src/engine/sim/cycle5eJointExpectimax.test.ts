/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 5e: joint expectimax choices for two player battlers.
// In doubles (battlersCount === 4), expectimax evaluates joint actions for
// battlers 0 and 2, pruning each battler's move list to top-K plus the best switch,
// skipping pairs that switch into the same slot, and scoring the cross product.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_main.c:3629       `for (gActiveBattler = 0; gActiveBattler < gBattlersCount; gActiveBattler++)`
//                            -- action selection loops over all battlers in ID order (0..3 in doubles).
//   battle_main.c:3646-3647  `if (gBattleStruct->field_91 & gBitTable[gActiveBattler])
//                            gChosenActionByBattler[gActiveBattler] = B_ACTION_NOTHING_FAINTED;`
//                            -- absent / fainted battlers with no reserve get no action (null action).
//   battle_main.c:3757-3762  `if (gActiveBattler == 2 && gChosenActionByBattler[0] == B_ACTION_SWITCH)`
//                            -- partner cannot choose the slot battler 0 chose to switch into.
//   battle_main.c:4325       `if (!quash && IsTrickRoomActive()) speedValue.effectiveSpeed = ~speedValue.effectiveSpeed;`
//                            -- Trick Room reverses the speed compare in turn order; the leaf term
//                               uses the mean active speed of living actives as a heuristic.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createSession, stepTurn } from './driver/session'
import { createRandomSource } from './rng'
import { fightSpecFor } from './driver/fightSpec'
import {
  chooseExpectimaxJointAction,
  createHeuristicPlayerReplacement,
  evaluateState,
  legalChoices,
  playExpectimaxBattle,
  pruneChoices,
  type PlayerChoice,
} from './driver/expectimax'

const data = loadSimData()
const tateAndLiza = data.trainersById.get('TRAINER_TATE_AND_LIZA_1')!
const may = data.trainersById.get('TRAINER_MAY_ROUTE_103_TORCHIC')!

const PLAYER_4_MONS = [
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_WATERFALL', 'MOVE_EARTHQUAKE', 'MOVE_ICE_BEAM', 'MOVE_PROTECT'] },
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_ROCK_SLIDE', 'MOVE_CRUNCH', 'MOVE_EARTHQUAKE', 'MOVE_PROTECT'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_METEOR_MASH', 'MOVE_BULLET_PUNCH', 'MOVE_PSYCHIC', 'MOVE_PROTECT'] },
  { species: 'SPECIES_SALAMENCE', level: 50, moves: ['MOVE_DRAGON_CLAW', 'MOVE_FLY', 'MOVE_FLAMETHROWER', 'MOVE_PROTECT'] },
]

function make4MonParty() {
  return buildPlayerParty(PLAYER_4_MONS, 50, data)
}

describe('cycle 5e: joint expectimax choices for two player battlers', () => {
  it('1. legalChoices per battler excludes both active party slots and returns moves with pp > 0', () => {
    const party = make4MonParty()
    const session = createSession({
      data,
      playerParty: party,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })

    // In Tate & Liza (double), battler 0 has partyIndex 0 (Swampert) and battler 2 has partyIndex 1 (Tyranitar).
    expect(session.state.battlers[0]?.partyIndex).toBe(0)
    expect(session.state.battlers[2]?.partyIndex).toBe(1)
    expect(session.state.battlersCount).toBe(4)

    // Battler 2 (Tyranitar)
    const choices2 = legalChoices(session, 2)
    const moves2 = choices2.filter((c) => c.switchTo === undefined)
    const switches2 = choices2.filter((c) => c.switchTo !== undefined)

    // Tyranitar has 4 moves
    expect(moves2.map((c) => c.action.chosenMove?.id)).toEqual([
      'MOVE_ROCK_SLIDE',
      'MOVE_CRUNCH',
      'MOVE_EARTHQUAKE',
      'MOVE_PROTECT',
    ])

    // Switches must exclude party index 0 (battler 0) and 1 (battler 2)
    // 4-mon party with 2 on field leaves exactly 2 switch targets: indices 2 and 3
    const switchTargets2 = switches2.map((c) => c.switchTo)
    expect(switchTargets2).toEqual([2, 3])

    // Battler 0 (Swampert)
    const choices0 = legalChoices(session, 0)
    const switches0 = choices0.filter((c) => c.switchTo !== undefined)
    const switchTargets0 = switches0.map((c) => c.switchTo)
    expect(switchTargets0).toEqual([2, 3])

    // Negative case: in singles (battlersCount === 2), legalChoices equals hand-built expectation
    const singlesSession = createSession({
      data,
      playerParty: make4MonParty(),
      opponentTrainer: may,
      tier: 'ace',
      rng: createRandomSource(42),
    })
    expect(singlesSession.state.battlersCount).toBe(2)
    const singlesChoices = legalChoices(singlesSession)
    const handBuiltMoves = [
      'MOVE_WATERFALL',
      'MOVE_EARTHQUAKE',
      'MOVE_ICE_BEAM',
      'MOVE_PROTECT',
    ]
    const singlesMoves = singlesChoices.filter((c) => c.switchTo === undefined).map((c) => c.action.chosenMove?.id)
    const singlesSwitches = singlesChoices.filter((c) => c.switchTo !== undefined).map((c) => c.switchTo)
    expect(singlesMoves).toEqual(handBuiltMoves)
    // In singles, only battler 0 is active (index 0), so bench targets are 1, 2, 3
    expect(singlesSwitches).toEqual([1, 2, 3])
  })

  it('2. evaluateState doubles terms reflect battler 2 HP and stat stages', () => {
    const party = make4MonParty()
    const session = createSession({
      data,
      playerParty: party,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(100),
    })

    const battler2 = session.state.battlers[2]!
    expect(battler2).toBeDefined()
    const initialMaxHp = battler2.mon.maxHp
    const initialHp = battler2.mon.hp
    expect(initialHp).toBe(initialMaxHp)

    const baseScore = evaluateState(session.state, { statusTerms: false })

    // Halve battler 2 HP
    const halfHp = Math.floor(initialHp / 2)
    battler2.mon.hp = halfHp

    const halvedScore = evaluateState(session.state, { statusTerms: false })
    const hpFractionDiff = (initialHp - halfHp) / initialMaxHp
    // positionScore is me.hp - them.hp + ..., so score drop should exactly match hpFractionDiff
    expect(baseScore - halvedScore).toBeCloseTo(hpFractionDiff, 5)

    // Restore HP
    battler2.mon.hp = initialHp
    const restoredScore = evaluateState(session.state, { statusTerms: false })
    expect(restoredScore).toBeCloseTo(baseScore, 5)

    // Boost one stat stage on battler 2 (Atk: index 1, stage starts at 6)
    expect(battler2.mon.statStages[1]).toBe(6)
    battler2.mon.statStages[1] = 7 // +1 stage
    const boostedScore = evaluateState(session.state, { statusTerms: false })
    // Each stat stage adds 0.04 to positionScore
    expect(boostedScore - restoredScore).toBeCloseTo(0.04, 5)
  })

  it('3. Joint chooser top-K prunes moves and keeps best switch in rank order', () => {
    // Direct test of pruneChoices: given 6 move choices with known one-turn ranks,
    // assert it keeps the best K in rank order.
    const fakeChoices: PlayerChoice[] = [
      { action: { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { id: 'MOVE_1', name: 'M1' } as any, target: null } },
      { action: { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { id: 'MOVE_2', name: 'M2' } as any, target: null } },
      { action: { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { id: 'MOVE_3', name: 'M3' } as any, target: null } },
      { action: { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { id: 'MOVE_4', name: 'M4' } as any, target: null } },
      { action: { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { id: 'MOVE_5', name: 'M5' } as any, target: null } },
      { action: { action: 'USE_MOVE', moveToBeUsed: null, chosenMove: { id: 'MOVE_6', name: 'M6' } as any, target: null } },
    ]
    const scores = new Map<PlayerChoice, number>([
      [fakeChoices[0]!, 10],
      [fakeChoices[1]!, 50],
      [fakeChoices[2]!, 30],
      [fakeChoices[3]!, 60],
      [fakeChoices[4]!, 20],
      [fakeChoices[5]!, 40],
    ])

    const prunedK3 = pruneChoices(fakeChoices, (c) => scores.get(c)!, 3)
    // Best 3 scores: MOVE_4 (60), MOVE_2 (50), MOVE_6 (40)
    expect(prunedK3.map((c) => c.action.chosenMove?.id)).toEqual(['MOVE_4', 'MOVE_2', 'MOVE_6'])

    // With a switch choice included, best switch is preserved alongside topK moves
    const fakeSwitch1: PlayerChoice = {
      action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null },
      switchTo: 2,
    }
    const fakeSwitch2: PlayerChoice = {
      action: { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null },
      switchTo: 3,
    }
    scores.set(fakeSwitch1, 15)
    scores.set(fakeSwitch2, 45) // better switch
    const choicesWithSwitches = [...fakeChoices, fakeSwitch1, fakeSwitch2]
    const prunedWithSwitches = pruneChoices(choicesWithSwitches, (c) => scores.get(c)!, 2)
    // Top 2 moves: MOVE_4 (60), MOVE_2 (50), plus best switch: fakeSwitch2 (45)
    expect(prunedWithSwitches).toEqual([fakeChoices[3], fakeChoices[1], fakeSwitch2])

    // In a live Tate & Liza session with topK = 1
    const party = make4MonParty()
    const session = createSession({
      data,
      playerParty: party,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(1),
    })
    const joint = chooseExpectimaxJointAction(
      session,
      { depth: 1, samples: 2, innerSamples: 1, switchMargin: 0.05, statusTerms: false },
      1,
      1,
    )
    expect(joint[0]).not.toBeNull()
    expect(joint[2]).not.toBeNull()

    const legal0 = legalChoices(session, 0)
    const legal2 = legalChoices(session, 2)
    // Both choices must be in their battler's legal list
    const match0 =
      joint[0]?.switchTo === undefined
        ? legal0.some((c) => c.action.chosenMove?.id === joint[0]?.action.chosenMove?.id && c.switchTo === undefined)
        : legal0.some((c) => c.switchTo === joint[0]?.switchTo)
    expect(match0).toBe(true)

    const match2 =
      joint[2]?.switchTo === undefined
        ? legal2.some((c) => c.action.chosenMove?.id === joint[2]?.action.chosenMove?.id && c.switchTo === undefined)
        : legal2.some((c) => c.switchTo === joint[2]?.switchTo)
    expect(match2).toBe(true)

    // No two switch choices share switchTo
    if (joint[0]?.switchTo !== undefined && joint[2]?.switchTo !== undefined) {
      expect(joint[0].switchTo).not.toBe(joint[2].switchTo)
    }
  })

  it('4. Dominance: forced KO scenario picks the KO move; negative picks something else', () => {
    // Party with battler 0 having a lethal move and a non-damaging move (Harden).
    // Note: in Elite Redux, MOVE_SPLASH is a damaging physical Heat Crash clone, so
    // MOVE_HARDEN (status) is used as the non-damaging move. Swampert is given Jolly nature
    // and Speed EVs so it acts before Tate & Liza's leads instead of fainting before moving.
    const partyKO = buildPlayerParty(
      [
        { species: 'SPECIES_SWAMPERT', level: 50, nature: 'NATURE_JOLLY', evs: { spe: 252 }, moves: ['MOVE_HARDEN', 'MOVE_WATERFALL'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_HARDEN'] },
      ],
      50,
      data,
    )
    const session = createSession({
      data,
      playerParty: partyKO,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })

    // Set opponent active battler 1 to 1 HP so Waterfall definitely KOs
    if (session.state.battlers[1]) session.state.battlers[1].mon.hp = 1

    const joint = chooseExpectimaxJointAction(
      session,
      { depth: 1, samples: 1, innerSamples: 1, switchMargin: 0.05, statusTerms: false },
      42,
      4,
    )
    expect(joint[0]?.action.chosenMove?.id).toBe('MOVE_WATERFALL')

    // Negative case: remove Waterfall so only Harden remains
    const partyNoKO = buildPlayerParty(
      [
        { species: 'SPECIES_SWAMPERT', level: 50, nature: 'NATURE_JOLLY', evs: { spe: 252 }, moves: ['MOVE_HARDEN'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_HARDEN'] },
      ],
      50,
      data,
    )
    const sessionNoKO = createSession({
      data,
      playerParty: partyNoKO,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })
    if (sessionNoKO.state.battlers[1]) sessionNoKO.state.battlers[1].mon.hp = 1

    const jointNoKO = chooseExpectimaxJointAction(
      sessionNoKO,
      { depth: 1, samples: 1, innerSamples: 1, switchMargin: 0.05, statusTerms: false },
      42,
      4,
    )
    // Must not pick Waterfall
    expect(jointNoKO[0]?.action.chosenMove?.id).not.toBe('MOVE_WATERFALL')
    expect(jointNoKO[0]?.action.chosenMove?.id).toBe('MOVE_HARDEN')
  })

  it('5. Dominance battler 2: forced KO scenario picks KO move and stepTurn executes it', () => {
    // Scaffolding of test 4: battler 0 holds only harmless moves (Harden),
    // battler 2 holds a harmless move and a lethal move (Waterfall).
    // Swampert is given Jolly nature and Speed EVs so it acts before Tate & Liza's leads.
    const partyKO = buildPlayerParty(
      [
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_HARDEN'] },
        { species: 'SPECIES_SWAMPERT', level: 50, nature: 'NATURE_JOLLY', evs: { spe: 252 }, moves: ['MOVE_HARDEN', 'MOVE_WATERFALL'] },
      ],
      50,
      data,
    )
    const session = createSession({
      data,
      playerParty: partyKO,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })

    // Set opponent active battler 1 to 1 HP so Waterfall definitely KOs
    expect(session.state.battlers[1]).toBeDefined()
    session.state.battlers[1]!.mon.hp = 1

    const joint = chooseExpectimaxJointAction(
      session,
      { depth: 1, samples: 1, innerSamples: 1, switchMargin: 0.05, statusTerms: false },
      42,
      4,
    )
    // (a) chooseExpectimaxJointAction returns that KO move for joint[2]
    expect(joint[2]?.action.chosenMove?.id).toBe('MOVE_WATERFALL')

    // (b) after stepTurn with joint[2].action, the targeted opponent battler's mon.hp is 0
    const targetedOpponent = session.state.battlers[1]!
    stepTurn(session, joint[0]!.action, undefined, { 2: joint[2]!.action })
    expect(targetedOpponent.mon.hp).toBe(0)

    // Negative run with { 2: null } leaves its hp above 0
    const sessionNegative = createSession({
      data,
      playerParty: partyKO,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })
    expect(sessionNegative.state.battlers[1]).toBeDefined()
    sessionNegative.state.battlers[1]!.mon.hp = 1
    const negativeOpponent = sessionNegative.state.battlers[1]!

    stepTurn(sessionNegative, joint[0]!.action, undefined, { 2: null })
    expect(negativeOpponent.mon.hp).toBeGreaterThan(0)
    expect(sessionNegative.state.battlers[1]!.mon.hp).toBeGreaterThan(0)

    // Negative case: remove Waterfall so only Harden remains on battler 2
    const partyNoKO = buildPlayerParty(
      [
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_HARDEN'] },
        { species: 'SPECIES_SWAMPERT', level: 50, nature: 'NATURE_JOLLY', evs: { spe: 252 }, moves: ['MOVE_HARDEN'] },
      ],
      50,
      data,
    )
    const sessionNoKO = createSession({
      data,
      playerParty: partyNoKO,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(42),
    })
    expect(sessionNoKO.state.battlers[1]).toBeDefined()
    sessionNoKO.state.battlers[1]!.mon.hp = 1

    const jointNoKO = chooseExpectimaxJointAction(
      sessionNoKO,
      { depth: 1, samples: 1, innerSamples: 1, switchMargin: 0.05, statusTerms: false },
      42,
      4,
    )
    expect(jointNoKO[2]?.action.chosenMove?.id).not.toBe('MOVE_WATERFALL')
    expect(jointNoKO[2]?.action.chosenMove?.id).toBe('MOVE_HARDEN')
  })

  it('6. Both battlers act: playExpectimaxBattle on Tate & Liza 1 runs deterministically', () => {
    const spec = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    const seed = 54321
    const expectimaxOptions = { depth: 1, samples: 2, innerSamples: 1, switchMargin: 0.05, statusTerms: true }

    const res1 = playExpectimaxBattle({
      data,
      opponentTrainer: tateAndLiza,
      format: spec.format,
      inverseBattle: spec.inverseBattle,
      battleEvents: spec.battleEvents,
      startFieldEffects: spec.startFieldEffects,
      playerParty: make4MonParty(),
      seed,
      maxTurns: 8,
      expectimax: expectimaxOptions,
    })

    const res2 = playExpectimaxBattle({
      data,
      opponentTrainer: tateAndLiza,
      format: spec.format,
      inverseBattle: spec.inverseBattle,
      battleEvents: spec.battleEvents,
      startFieldEffects: spec.startFieldEffects,
      playerParty: make4MonParty(),
      seed,
      maxTurns: 8,
      expectimax: expectimaxOptions,
    })

    expect(['WON', 'LOST', 'DREW', 'MAX_TURNS']).toContain(res1.outcome)
    expect(res1.turns).toBeGreaterThan(0)
    expect([0, 1, 2, 3]).toContain(res1.finalActive.partyIndex)
    expect(PLAYER_4_MONS.map((m) => m.species)).toContain(res1.finalActive.mon.speciesId)
    expect(res2.finalActive.partyIndex).toBe(res1.finalActive.partyIndex)
    expect(res1.outcome).toBe(res2.outcome)
    expect(res1.turns).toBe(res2.turns)
    expect(res1.finalScore).toBe(res2.finalScore)
  })

  it('7. Singles unchanged: equivalence of legalChoices and heuristic replacement', () => {
    const singlesSession = createSession({
      data,
      playerParty: make4MonParty(),
      opponentTrainer: may,
      tier: 'ace',
      rng: createRandomSource(777),
    })

    // legalChoices(session) equals legalChoices(session, 0)
    expect(legalChoices(singlesSession)).toEqual(legalChoices(singlesSession, 0))

    // createHeuristicPlayerReplacement(data)(state, 0) equals createHeuristicPlayerReplacement(data)(state)
    const replacer = createHeuristicPlayerReplacement(data)
    expect(replacer(singlesSession.state, 0)).toBe(replacer(singlesSession.state))
  })

  it('8. Replacement per battler: battler 2 faint picks live bench mon excluding partners', () => {
    const party = make4MonParty()
    const session = createSession({
      data,
      playerParty: party,
      opponentTrainer: tateAndLiza,
      tier: 'elite',
      rng: createRandomSource(999),
    })

    // Initial state: battler 0 is partyIndex 0, battler 2 is partyIndex 1
    expect(session.state.battlers[0]?.partyIndex).toBe(0)
    expect(session.state.battlers[2]?.partyIndex).toBe(1)

    // Hand-faint battler 2
    session.state.battlers[2]!.mon.hp = 0

    const replacer = createHeuristicPlayerReplacement(data)
    const replacementSlot = replacer(session.state, 2)

    // Must be neither battler 0's index (0) nor battler 2's own index (1)
    expect(replacementSlot).not.toBe(0)
    expect(replacementSlot).not.toBe(1)
    expect([2, 3]).toContain(replacementSlot)

    // Must be a living mon
    const chosenMon = session.state.sides[0].party[replacementSlot]
    expect(chosenMon).toBeDefined()
    expect(chosenMon!.hp).toBeGreaterThan(0)
  })
})
