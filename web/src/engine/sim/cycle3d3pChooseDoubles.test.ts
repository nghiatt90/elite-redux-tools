/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3p (dbl-4a): ChooseMoveOrAction_Doubles (battle_ai_main.c:341-440) and
// SetRandomTarget's doubles branch (battle_util.c:6326-6341) as BattleAI_
// SetupAIData calls it (:186). Not wired into chooseAiAction -- that is dbl-4d.
//
// C lines checked:
//   ChooseMoveOrAction_Doubles        battle_ai_main.c:341-440
//   BattleAI_SetupAIData              battle_ai_main.c:158-188 (:186's draw)
//   BattleAI_DoAIProcessing           battle_ai_main.c:442-474 (via doAiProcessing)
//   SetRandomTarget                   battle_util.c:6326-6341
//   IsBattlerAlive                    battle_util.c:6685-6694
//
// Layout: doubles, so battlers 0/2 are the player side (the AI's foes) and 1/3
// the opponent side -- 1 is the AI, 3 its ally. Every draw value below is
// hand-derived from the C's own order: for each live non-self target i in
// 0, 2, 3 (1 is the AI itself), [SetRandomTarget, move tie-break]; then ONE
// final target draw (:437).

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import { AI_FLAG_HP_AWARE } from './ai/aiFlags'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { chooseMoveOrActionDoubles, setRandomTarget } from './ai/aiPipeline'

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

/** Doubles (BATTLE_TYPE_DOUBLE set) with the four standard battler slots: 0/2
 * player, 1/3 opponent. Built through the production layout path, never by hand. */
function doublesState(): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng: createRandomSource(1) },
  )
}

function singlesState(): BattleState {
  return buildBattleState(
    { opponents: [trainer] },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng: createRandomSource(1) },
  )
}

/** Records every draw in order; `overrun` trips if the caller asks for more
 * values than supplied, so a full queue + calls === length means "exactly this
 * many draws, in this order". */
function scriptedRng(values: number[]): RandomSource & { calls: number; overrun: boolean } {
  let index = 0
  const rng = {
    calls: 0,
    overrun: false,
    random16: () => {
      rng.calls++
      if (index >= values.length) rng.overrun = true
      return values[index++] ?? 0
    },
  }
  return rng
}

interface FixtureOptions {
  moves: Slot4<string | null>
  pp: Slot4<number>
  aiFlags: number
  draws: number[]
}

/** A doubles state with the AI (battler 1) owning `moves`, every battler at full
 * HP, and the scripted queue installed AFTER construction so no build-time draw
 * can shift it. */
function fixture(opts: FixtureOptions): { state: BattleState; rng: ReturnType<typeof scriptedRng>; deps: AiDamageDeps } {
  const state = doublesState()
  state.aiFlags = opts.aiFlags
  const mon = state.battlers[1]!.mon
  mon.moves = opts.moves
  mon.pp = opts.pp
  for (const battler of state.battlers) {
    if (battler) battler.mon.hp = battler.mon.maxHp
  }
  const rng = scriptedRng(opts.draws)
  state.rng = rng
  return { state, rng, deps: aiDamageDepsFor(data, state) }
}

describe('ChooseMoveOrAction_Doubles draw order (battle_ai_main.c:341-440)', () => {
  it('draws SetRandomTarget then the move tie-break per live non-self target, then one target draw', () => {
    // No aiFlags: setupAiScores leaves every slot at 100 (:167-175) and no scorer
    // runs, so the only draws are the C's own. Two real moves tie for best.
    const { state, rng, deps } = fixture({
      moves: ['MOVE_TACKLE', 'MOVE_WATER_GUN', null, null],
      pp: [35, 25, 0, 0],
      aiFlags: 0,
      // i=0: SRD 0 -> left foe (0), tie-break 0 -> slot 0
      // i=2: SRD 1 -> right foe (2),  tie-break 1 -> slot 1
      // i=3: SRD 0 -> left foe (0),   tie-break 1 -> slot 1
      draws: [0, 0, 1, 1, 0, 1, 2],
    })

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    // All three live targets score 100, so the final `% 3` over [0, 2, 3] lands on
    // the ally (index 2 of the tie list) and returns ITS move slot (:439).
    expect(result.target).toBe(3)
    expect(result.moveIndex).toBe(1)
    expect(rng.calls).toBe(7)
    expect(rng.overrun).toBe(false)
  })
})

describe("the ally's < 100 dead zone (battle_ai_main.c:407-411)", () => {
  it('turns the ally into -1 when its best score is below 100, so a 0-point foe wins', () => {
    // PP 0 on the only move: doAiProcessing forces the slot to 0 (:462-464), so
    // every target's best is 0 -- the ally's 0 < 100 makes it ineligible.
    const { state, rng, deps } = fixture({
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [0, 0, 0, 0],
      aiFlags: AI_FLAG_HP_AWARE,
      draws: [0, 0, 0, 0, 0, 0, 2],
    })

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    // Tie list over points [-1, -1, 0, -1] is [0, 2]; draw 2 % 2 = 0 -> foe 0.
    // Were the ally eligible (points 0), the list would be [0, 2, 3] and draw
    // 2 % 3 = 2 would pick the ally.
    expect(result.target).toBe(0)
    expect(rng.calls).toBe(7)
  })

  it('keeps the ally at exactly 100 -- the test is strict `<`, not `<=`', () => {
    const { state, rng, deps } = fixture({
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
      aiFlags: AI_FLAG_HP_AWARE,
      draws: [0, 0, 0, 0, 0, 0, 2],
    })

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    // HP_AWARE leaves Tackle at 100 against every target at full HP, and its own
    // partner branch returns the score untouched, so the ally stays at 100 and
    // joins the tie list [0, 2, 3]; 2 % 3 = 2 -> the ally.
    expect(result.target).toBe(3)
    expect(result.moveIndex).toBe(0)
    expect(rng.calls).toBe(7)
  })
})

describe('fainted and absent battlers (:353-356)', () => {
  it('skips a fainted foe entirely: no draws for it, and it cannot win the target pick', () => {
    const { state, rng, deps } = fixture({
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
      aiFlags: 0,
      draws: [0, 0, 0, 0, 0],
    })
    state.battlers[0]!.mon.hp = 0

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    // Two scored targets x 2 draws + 1 final = 5 (not 7). Points [-1, -1, 100,
    // 100]; the beat-all reset at :430-434 shrinks the list to [2, 3]; draw 0 -> 2.
    expect(result.target).toBe(2)
    expect(result.moveIndex).toBe(0)
    expect(rng.calls).toBe(5)
    expect(rng.overrun).toBe(false)
  })

  it('treats an absentBattlerFlags battler as fainted even though its slot keeps hp', () => {
    const { state, rng, deps } = fixture({
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
      aiFlags: 0,
      draws: [0, 0, 0, 0, 0],
    })
    state.absentBattlerFlags |= 1 << 0
    expect(state.battlers[0]!.mon.hp).toBeGreaterThan(0)

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    expect(result.target).toBe(2)
    expect(rng.calls).toBe(5)
  })

  it('picks from dead/self battlers when every candidate is -1, returning null for their 0xFF row', () => {
    const build = (finalDraw: number) => {
      const f = fixture({
        moves: ['MOVE_TACKLE', null, null, null],
        pp: [0, 0, 0, 0],
        aiFlags: AI_FLAG_HP_AWARE,
        draws: [0, 0, finalDraw],
      })
      f.state.battlers[0]!.mon.hp = 0
      f.state.battlers[2]!.mon.hp = 0
      return f
    }

    // Only battler 3 is scored (2 draws), so points are [-1, -1, -1, -1] (the
    // ally's 0 is below 100) and the tie list keeps all four indices 0..3.
    const dead = build(0)
    const deadResult = chooseMoveOrActionDoubles(dead.state, 1, dead.deps)
    expect(deadResult.target).toBe(0) // a fainted foe
    expect(deadResult.moveIndex).toBeNull() // actionOrMoveIndex[0] == 0xFF (:355)
    expect(dead.rng.calls).toBe(3)

    const self = build(1)
    const selfResult = chooseMoveOrActionDoubles(self.state, 1, self.deps)
    expect(selfResult.target).toBe(1) // the AI itself
    expect(selfResult.moveIndex).toBeNull()
    expect(self.rng.calls).toBe(3)

    const ally = build(3)
    const allyResult = chooseMoveOrActionDoubles(ally.state, 1, ally.deps)
    expect(allyResult.target).toBe(3) // live ally, 0 points but the only action
    expect(allyResult.moveIndex).toBe(0)
    expect(ally.rng.calls).toBe(3)
  })
})

describe('the move tie-break (:390-404)', () => {
  it('indexes the tie list in slot order with one draw', () => {
    const { state, rng, deps } = fixture({
      moves: ['MOVE_TACKLE', 'MOVE_WATER_GUN', null, null],
      pp: [35, 25, 0, 0],
      aiFlags: 0,
      // i=0 tie-break 0 -> slot 0; i=2 and i=3 tie-break 1 -> slot 1.
      draws: [0, 0, 0, 1, 0, 1, 2],
    })

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    // Target 3 wins the final draw, so its own slot-1 pick is the returned one.
    expect(result.target).toBe(3)
    expect(result.moveIndex).toBe(1)
    expect(rng.calls).toBe(7)
  })

  it('resets the list on a strictly greater score rather than appending', () => {
    // Slot 0 is out of PP, so doAiProcessing forces it to 0 and slot 1's 100 is a
    // strict improvement -- `>` resets the list to [1]. A `>=` (append) port would
    // keep [0, 1], and draw 0 would return slot 0.
    const { state, rng, deps } = fixture({
      moves: ['MOVE_TACKLE', 'MOVE_WATER_GUN', null, null],
      pp: [0, 25, 0, 0],
      aiFlags: AI_FLAG_HP_AWARE,
      draws: [0, 0, 0, 0, 0, 0, 0],
    })

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    expect(result.target).toBe(0)
    expect(result.moveIndex).toBe(1)
    expect(rng.calls).toBe(7)
  })

  it('seeds the list from slot 0 even when it is MOVE_NONE, like the singles tie-break', () => {
    const { state, rng, deps } = fixture({
      moves: [null, 'MOVE_TACKLE', null, null],
      pp: [0, 0, 0, 0],
      aiFlags: AI_FLAG_HP_AWARE,
      draws: [0, 0, 0, 0, 0, 0, 0],
    })

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    // Both slots are 0 (slot 1 is out of PP too), so the tie list is [0, 1] and
    // draw 0 returns the EMPTY slot 0 -- the C's own quirk (:387-403).
    expect(state.battlers[1]!.mon.moves[0]).toBeNull()
    expect(result.target).toBe(0)
    expect(result.moveIndex).toBe(0)
    expect(rng.calls).toBe(7)
  })
})

describe('SetRandomTarget (battle_util.c:6326-6341)', () => {
  it('singles: no draw, always the left battler of the opposing side', () => {
    const state = singlesState()
    const rng = scriptedRng([1, 1])
    state.rng = rng

    expect(setRandomTarget(state, 1)).toBe(0) // battlerId ^ 1
    expect(setRandomTarget(state, 0)).toBe(1)
    expect(rng.calls).toBe(0)
    expect(rng.overrun).toBe(false)
  })

  it('doubles: one draw picks the foe, and a dead pick flips with ^ BIT_FLANK without re-checking', () => {
    const state = doublesState()
    for (const battler of state.battlers) {
      if (battler) battler.mon.hp = battler.mon.maxHp
    }
    const rng = scriptedRng([0, 1, 0, 1, 0])
    state.rng = rng

    // battlerAtk 1 is on the opponent side; its foes are the player's 0 and 2.
    expect(setRandomTarget(state, 1)).toBe(0) // Random() % 2 == 0 -> targets[1][0]
    expect(setRandomTarget(state, 1)).toBe(2) // == 1 -> targets[1][1]
    // battlerAtk 0 is on the player side; its foes are 1 and 3.
    expect(setRandomTarget(state, 0)).toBe(1) // targets[0][0]
    expect(setRandomTarget(state, 0)).toBe(3) // targets[0][1]
    expect(rng.calls).toBe(4)

    // :6335-6336 -- the left foe is down, so the pick flips to 2.
    state.battlers[0]!.mon.hp = 0
    expect(setRandomTarget(state, 1)).toBe(2)
    expect(rng.calls).toBe(5)

    // With both foes down the C still returns the (dead) flank: no second check.
    state.battlers[2]!.mon.hp = 0
    expect(setRandomTarget(state, 1)).toBe(2)
  })
})
