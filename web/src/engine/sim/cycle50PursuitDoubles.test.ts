/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 50: Pursuit intercepts both foes in doubles (dbl-3c-turn-targets-pursuit).
//
// C lines checked:
//   data/battle_scripts_1.s:7196-7209      BattleScript_ActionSwitch: `setmultihit 1` in singles,
//                                          `setmultihit 2` in doubles, `decrementmultihit` per pass
//   src/battle_script_commands.c:11294-11325
//                                          Cmd_jumpifnopursuitswitchdmg: counter 1 -> LEFT foe, any
//                                          other counter -> RIGHT foe (:11295-11307); the hit's own
//                                          condition block (:11310-11313) including the switcher-hp
//                                          test that this cycle re-evaluates before every pass
//   include/constants/battle.h:30-33, 39-40, 45
//                                          PLAYER_LEFT 0, OPPONENT_LEFT 1, PLAYER_RIGHT 2,
//                                          OPPONENT_RIGHT 3 (web/src/engine/sim/constants.ts:72-75)
//
// Doubles party layout (buildBattleState): battler 0 and battler 2 are the player's party slots 0
// and 1, battler 1 and battler 3 the opponent's party slots 0 and 1.
import { describe, expect, it } from 'vitest'

import { STATUS1_SLEEP, setCounter } from './constants'
import { buildBattleState } from './driver/battleFormat'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import type { BattleState, RandomSource, SimPartyMon } from './state'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const data = loadSimData()
const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

const SPECS = [
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

const playerParty = (): SimPartyMon[] => buildPlayerParty(SPECS, 50, data)

/** The trainer's own elite party, with the first two slots' moves replaced so battler 1 (party 0,
 * LEFT) and battler 3 (party 1, RIGHT) can hold Pursuit. */
function opponentParty(slotMoves: string[][]): SimPartyMon[] {
  const party = buildOpponentParty(trainer, 'elite', 50, data)
  slotMoves.forEach((ids, index) => {
    const entry = party[index]
    if (!entry) throw new Error(`TRAINER_SAWYER_1's elite party has no slot ${index}`)
    entry.moves = [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
    entry.pp = entry.moves.map((id) => (id ? data.dataContext.move(id)?.pp ?? 0 : 0)) as SimPartyMon['pp']
  })
  return party
}

/** Scripted draws, in order, so every case names exactly what the C rolls. */
function scriptRng(values: number[]): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      const value = values[rng.calls] ?? 0
      rng.calls++
      return value
    },
  }
  return rng
}

/** All four speeds distinct so SortBattlersBySpeed's tie-break draw never fires; abilities and
 * items cleared so no ability hook or held item can add a draw to the turn. Fixture setup, not
 * an outcome. */
function normalize(state: BattleState): void {
  const speeds = [200, 180, 160, 140]
  for (let i = 0; i < state.battlersCount; i++) {
    const mon = state.battlers[i]!.mon
    mon.rawStats.spe = speeds[i]!
    mon.abilities = { ability: null, innates: [null, null, null] }
    mon.itemId = null
  }
}

function doublesState(rng: RandomSource, slotMoves: string[][]): BattleState {
  const state = buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty(slotMoves)], rng },
  )
  normalize(state)
  return state
}

function singlesState(rng: RandomSource, slotMoves: string[]): BattleState {
  const state = buildBattleState(
    { opponents: [trainer] },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty([slotMoves])], rng },
  )
  normalize(state)
  return state
}

function moveView(moveId: string): TurnOrderMoveView {
  const m = data.dataContext.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  return {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
}

/** The sim's action builder (not a React hook): an explicit target id that does NOT pass
 * through the player controller's cursor choice. */
function useMove(target: number | null, moveId: string): ChosenAction {
  const view = moveView(moveId)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }

interface ResolveCall {
  attackerId: number
  targetId: number
  moveId: string
  /** The target battler's party slot AT RESOLVE TIME. The pre-switch hit lands before
   * BattleScript_DoSwitchOut, so it still sees the OUTGOING slot (0 here); a move that runs in a
   * later turn slot after the switch sees the incoming slot (2). This is how the two are told
   * apart without reading any sim-internal flag. */
  targetPartyIndex: number
}

function recordingDamage(amount: number): { resolver: DamageResolver; calls: ResolveCall[] } {
  const calls: ResolveCall[] = []
  const resolver: DamageResolver = {
    resolve: (state, attackerId, targetId, action) => {
      calls.push({
        attackerId,
        targetId,
        moveId: action.chosenMove?.id ?? '',
        targetPartyIndex: state.battlers[targetId]?.partyIndex ?? -1,
      })
      return { targetDamage: amount, attackerDamage: null, unmodelled: [] }
    },
  }
  return { resolver, calls }
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    grounding: groundingFor(data, state),
    damage,
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    hazardTypes: { typeChart: data.typeChart, inverseTypeChart: data.inverseTypeChart, inverseBattle: false },
  }
}

/** `attacker->target[target party slot]:move`, in resolve order. */
const callList = (calls: ResolveCall[]): string[] =>
  calls.map((c) => `${c.attackerId}->${c.targetId}[${c.targetPartyIndex}]:${c.moveId}`)

/** Pre-switch hits: they resolve while the switcher (battler 0 here) is still on its OUTGOING
 * party slot 0, i.e. before BattleScript_DoSwitchOut. A move that runs later in the turn hits the
 * incoming slot 2 instead. */
const preSwitchHits = (calls: ResolveCall[]): string[] =>
  callList(calls.filter((c) => c.targetId === 0 && c.targetPartyIndex === 0))

const switchOutcome = (out: ReturnType<typeof executeTurn>) => out.actions.find((a) => a.battlerId === 0)!

describe('cycle50: Pursuit pass order (data/battle_scripts_1.s:7196-7209)', () => {
  it('1. doubles, RIGHT foe Pursuit + LEFT foe Tackle: one pre-switch hit; the RIGHT slot is consumed', () => {
    // setmultihit 2 (:7200-7201): pass 1 has counter 2 -> OPPONENT_RIGHT (battler 3).
    // The LEFT foe chose Tackle, so pass 2's jumpifnopursuitswitchdmg takes the else branch.
    const rng = scriptRng([])
    const state = doublesState(rng, [['MOVE_TACKLE'], ['MOVE_PURSUIT']])
    state.battlers[0]!.monToSwitchIntoId = 2
    const { resolver, calls } = recordingDamage(0)

    const out = executeTurn(
      state,
      [switchAction, useMove(0, 'MOVE_TACKLE'), null, useMove(0, 'MOVE_PURSUIT')],
      loopDeps(state, resolver),
    )

    // The Pursuit hit resolves inside the switch slot, before BattleScript_DoSwitchOut, so it sees
    // the OUTGOING slot 0; battler 1's Tackle runs afterwards against the incoming slot 2.
    expect(preSwitchHits(calls)).toEqual(['3->0[0]:MOVE_PURSUIT'])
    expect(callList(calls)).toEqual(['3->0[0]:MOVE_PURSUIT', '1->0[2]:MOVE_TACKLE'])
    // gActionsByTurnOrder[foe] = B_ACTION_TRY_FINISH (:11317-11319): no second use by battler 3.
    expect(calls.filter((c) => c.attackerId === 3)).toHaveLength(1)
    expect(out.actions.filter((a) => a.battlerId === 3)).toHaveLength(0)
  })

  it('2. doubles, both foes Pursuit: RIGHT first then LEFT (counter 2 -> counter 1), both damages land', () => {
    // Pass 1 counter 2 -> battler 3; decrementmultihit (:7209) -> pass 2 counter 1 -> battler 1.
    const state = doublesState(scriptRng([]), [['MOVE_PURSUIT'], ['MOVE_PURSUIT']])
    state.battlers[0]!.monToSwitchIntoId = 2
    const startHp = state.sides[0].party[0]!.hp
    const { resolver, calls } = recordingDamage(10)

    const out = executeTurn(
      state,
      [switchAction, useMove(0, 'MOVE_PURSUIT'), null, useMove(0, 'MOVE_PURSUIT')],
      loopDeps(state, resolver),
    )

    // Pass 1 (counter 2) -> battler 3, pass 2 (counter 1) -> battler 1, both before the switch.
    expect(preSwitchHits(calls)).toEqual(['3->0[0]:MOVE_PURSUIT', '1->0[0]:MOVE_PURSUIT'])
    expect(callList(calls)).toEqual(['3->0[0]:MOVE_PURSUIT', '1->0[0]:MOVE_PURSUIT'])
    // The switch outcome carries the sum of both hits.
    expect(switchOutcome(out).targetId).toBe(0)
    expect(switchOutcome(out).targetDamage).toBe(20)
    // The outgoing party slot took both hits, then the switch completed.
    expect(state.sides[0].party[0]!.hp).toBe(startHp - 20)
    expect(state.battlers[0]!.partyIndex).toBe(2)
  })

  it('3. doubles, the first hit faints the switcher: the second pass fires nothing, the switch still runs', () => {
    // :11310-11313 tests `gBattleMons[gBattlerAttacker].hp` (the switcher) at the start of every
    // pass, so pass 2 with hp 0 takes the else branch. BattleScript_DoSwitchOut is unchanged.
    const state = doublesState(scriptRng([]), [['MOVE_PURSUIT'], ['MOVE_PURSUIT']])
    state.battlers[0]!.monToSwitchIntoId = 2
    // The outgoing mon enters the turn at 5 HP; 10 damage is enough to faint it, so `D >= hp`.
    // The incoming mon is at full HP and survives the later normal Pursuit by battler 1.
    state.battlers[0]!.mon.hp = 5
    const { resolver, calls } = recordingDamage(10)

    const out = executeTurn(
      state,
      [switchAction, useMove(0, 'MOVE_PURSUIT'), null, useMove(0, 'MOVE_PURSUIT')],
      loopDeps(state, resolver),
    )

    // Only pass 1 fires: pass 2 sees gBattleMons[switcher].hp == 0. Battler 1's own slot was NOT
    // consumed, so its Pursuit runs as an ordinary move later in the turn, on the incoming mon
    // (party slot 2), not as a second interception on the outgoing one.
    expect(preSwitchHits(calls)).toEqual(['3->0[0]:MOVE_PURSUIT'])
    expect(callList(calls)).toEqual(['3->0[0]:MOVE_PURSUIT', '1->0[2]:MOVE_PURSUIT'])
    expect(state.sides[0].party[0]!.hp).toBe(0)
    // BattleScript_DoSwitchOut runs either way: the fainted outgoing mon is replaced.
    expect(state.battlers[0]!.partyIndex).toBe(2)
    expect(state.battlers[0]!.mon.hp).toBeGreaterThan(0)
    expect(switchOutcome(out).fainted).toContain(0)
  })
})

describe('cycle50: Pursuit negative cases', () => {
  it('4. doubles, the foe Pursuit targets the switcher PARTNER: no pre-switch hit', () => {
    // :11311 `gBattlerAttacker == moveTarget[gBattlerTarget]` fails: battler 3's Pursuit targets 2.
    const state = doublesState(scriptRng([]), [[], ['MOVE_PURSUIT']])
    state.battlers[0]!.monToSwitchIntoId = 2
    const { resolver, calls } = recordingDamage(0)

    executeTurn(state, [switchAction, null, null, useMove(2, 'MOVE_PURSUIT')], loopDeps(state, resolver))

    expect(preSwitchHits(calls)).toEqual([])
    // Battler 3's Pursuit still runs as an ordinary move on the partner (battler 2, party slot 1).
    expect(callList(calls)).toEqual(['3->2[1]:MOVE_PURSUIT'])
  })

  it('5. doubles, the LEFT foe is asleep: only the RIGHT foe hits', () => {
    // :11312 `!(gBattleMons[gBattlerTarget].status1 & (STATUS1_SLEEP | STATUS1_FREEZE))` blocks
    // battler 1. A nonzero sleep counter keeps it asleep through CANCELLER_ASLEEP
    // (battle_script_commands.c:3209-3247).
    const state = doublesState(scriptRng([]), [['MOVE_PURSUIT'], ['MOVE_PURSUIT']])
    state.battlers[0]!.monToSwitchIntoId = 2
    state.battlers[1]!.mon.status1 = setCounter(0, STATUS1_SLEEP, 3)
    const { resolver, calls } = recordingDamage(0)

    executeTurn(
      state,
      [switchAction, useMove(0, 'MOVE_PURSUIT'), null, useMove(0, 'MOVE_PURSUIT')],
      loopDeps(state, resolver),
    )

    expect(preSwitchHits(calls)).toEqual(['3->0[0]:MOVE_PURSUIT'])
    expect(callList(calls)).toEqual(['3->0[0]:MOVE_PURSUIT'])
    expect(calls.filter((c) => c.attackerId === 1)).toHaveLength(0)
  })
})

describe('cycle50: singles regression', () => {
  it('6a. singles, the one foe Pursuit: one pre-switch hit (counter 1 -> the LEFT foe)', () => {
    // setmultihit 1 (:7197-7198) -> Cmd_jumpifnopursuitswitchdmg's counter-1 arm (:11295-11299).
    const state = singlesState(scriptRng([]), ['MOVE_PURSUIT'])
    state.battlers[0]!.monToSwitchIntoId = 1
    const ppBefore = state.battlers[1]!.mon.pp[0]!
    const { resolver, calls } = recordingDamage(0)

    const out = executeTurn(state, [switchAction, useMove(0, 'MOVE_PURSUIT')], loopDeps(state, resolver))

    expect(preSwitchHits(calls)).toEqual(['1->0[0]:MOVE_PURSUIT'])
    expect(callList(calls)).toEqual(['1->0[0]:MOVE_PURSUIT'])
    expect(switchOutcome(out).targetId).toBe(0)
    expect(state.battlers[1]!.mon.pp[0]).toBe(ppBefore - 1) // one ppreduce (:7238)
  })

  it('6b. singles, nobody chose Pursuit: no pre-switch hit', () => {
    const state = singlesState(scriptRng([]), ['MOVE_TACKLE'])
    state.battlers[0]!.monToSwitchIntoId = 1
    const { resolver, calls } = recordingDamage(0)

    const out = executeTurn(state, [switchAction, useMove(0, 'MOVE_TACKLE')], loopDeps(state, resolver))

    expect(preSwitchHits(calls)).toEqual([])
    expect(callList(calls)).toEqual(['1->0[1]:MOVE_TACKLE'])
    expect(switchOutcome(out).targetId).toBeNull()
    expect(switchOutcome(out).targetDamage).toBeNull()
  })
})
