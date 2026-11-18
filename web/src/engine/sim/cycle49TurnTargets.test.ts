/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 49: turn.ts target sites (dbl-3c-turn-targets, all but Pursuit).
//
// C lines checked:
//   src/battle_util.c:6380             GetMoveTarget DEPENDS/BOTH/FOES_AND_ALLY/OPPONENTS_FIELD:
//                                      GetBattlerAtPosition((GetBattlerPosition(attacker) & BIT_SIDE) ^ BIT_SIDE),
//                                      the opposing LEFT battler
//   src/battle_util.c:6399-6400        the RANDOM non-double arm uses the same expression
//   src/battle_util.c:160-166          GetFullChosenTarget: MULTIPLETURNS/RECHARGE returns
//                                      gBattleStruct->moveTarget[battler]
//   src/pokemon.c:1267-1270            GetDefaultMoveTarget's opposing-left cursor
//   src/battle_util.c:3422-3429        Bide turn 3: gBattlerTarget = gTakenDmgByBattler, and only
//                                      when that battler is ABSENT re-derive with GetMoveTarget(..., 1)
//   include/constants/battle.h:491     setTarget = 1 means MOVE_TARGET_SELECTED
//   src/battle_script_commands.c:1914-1923
//                                      Cmd_datahpupdate records gTakenDmgByBattler
//
// Item 0 (Follow Me `??` fallbacks at turn.ts:935/962) needs no code change: the fallback is
// unreachable because isAffectedByFollowMe requires followmeTimer !== 0 and a live
// followmeTarget. It has no test here on purpose.
import { describe, expect, it } from 'vitest'

import { STATUS2_MULTIPLETURNS, STATUS2_RECHARGE, hasFlag } from './constants'
import { buildBattleState } from './driver/battleFormat'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import type { BattleState, RandomSource, SimPartyMon } from './state'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { applyDamage, executeTurn, getMoveTarget } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const data = loadSimData()
const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

const SPECS = [
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_BIDE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

const playerParty = (): SimPartyMon[] => buildPlayerParty(SPECS, 50, data)
const opponentParty = (): SimPartyMon[] => buildOpponentParty(trainer, 'elite', 50, data)

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

function doublesState(rng: RandomSource): BattleState {
  const state = buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng },
  )
  normalize(state)
  return state
}

function singlesState(rng: RandomSource): BattleState {
  const state = buildBattleState(
    { opponents: [trainer] },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng },
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

const noDamage: DamageResolver = {
  resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }),
}

/** Returns a fixed 19 damage so Bide can accumulate gTakenDmg without any damage-engine draws. */
const fixedDamage: DamageResolver = {
  resolve: () => ({ targetDamage: 19, attackerDamage: null, unmodelled: [] }),
}

interface ResolveCall {
  attackerId: number
  targetId: number
  moveId: string
}

function recordingDamage(): { resolver: DamageResolver; calls: ResolveCall[] } {
  const calls: ResolveCall[] = []
  const resolver: DamageResolver = {
    resolve: (_state, attackerId, targetId, action) => {
      calls.push({ attackerId, targetId, moveId: action.chosenMove?.id ?? '' })
      return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
    },
  }
  return { resolver, calls }
}

function loopDeps(state: BattleState, damage: DamageResolver = noDamage): TurnLoopDeps {
  return {
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    grounding: groundingFor(data, state),
    damage,
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    hazardTypes: { typeChart: data.typeChart, inverseTypeChart: data.inverseTypeChart, inverseBattle: false },
  }
}

/** Drives the Bide user (battler 0) through its opening and storing turns: one Tackle accuracy
 * draw per turn from battler 1, no draw from either Bide action. */
function bideThroughStoringTurn(state: BattleState, deps: TurnLoopDeps): void {
  executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE'), null, null], deps)
  executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE'), null, null], deps)
}

describe('cycle49 Item 1: getMoveTarget opposing LEFT position', () => {
  it('1a. doubles, attacker 2 (player right), FOES_AND_ALLY returns 1, not 3', () => {
    // battle_util.c:6380: (2 & BIT_SIDE) ^ BIT_SIDE = 1, GetBattlerAtPosition(1) = battler 1.
    // Before this cycle `attacker ^ 1` returned 3, the opposing RIGHT.
    const rng = scriptRng([])
    const state = doublesState(rng)
    expect(getMoveTarget(state, 2, 'MOVE_EARTHQUAKE', loopDeps(state))).toBe(1)
    expect(rng.calls).toBe(0)
  })

  it('1b. negative: attacker 0 returns 1 (the same expression in singles)', () => {
    const state = doublesState(scriptRng([]))
    expect(getMoveTarget(state, 0, 'MOVE_EARTHQUAKE', loopDeps(state))).toBe(1)
  })

  it('1c. negative: opposing left dead, its partner alive -> battler 3 (battle_util.c:6381-6384)', () => {
    const state = doublesState(scriptRng([]))
    state.battlers[1]!.mon.hp = 0 // scenario setup: the opposing-left foe starts fainted
    expect(getMoveTarget(state, 2, 'MOVE_EARTHQUAKE', loopDeps(state))).toBe(3)
  })

  it('1d. negative: RANDOM in singles returns the opposing left and draws nothing (battle_util.c:6399-6400)', () => {
    const rng = scriptRng([1]) // would pick battler 3 if any `% 2` draw happened
    const state = singlesState(rng)
    expect(getMoveTarget(state, 0, 'MOVE_OUTRAGE', loopDeps(state))).toBe(1)
    expect(rng.calls).toBe(0)
  })
})

describe('cycle49 Item 2: applyLockedMove default target', () => {
  it('2a. doubles, no action.target, locked Tackle on battler 2 targets 1, not 3', () => {
    // battle_util.c:160-166 stores the selection target; the sim's fallback is the default
    // cursor GetDefaultMoveTarget (pokemon.c:1267-1270) = (2 & 1) ^ 1 = 1.
    const state = doublesState(scriptRng([]))
    state.battlers[2]!.mon.status2 = STATUS2_MULTIPLETURNS
    state.lockedMoves[2] = 'MOVE_TACKLE'
    const recorded = recordingDamage()
    // The moved action names a DIFFERENT move so applyLockedMove runs its fallback branch.
    const out = executeTurn(state, [null, null, useMove(null, 'MOVE_GROWL'), null], loopDeps(state, recorded.resolver))
    expect(recorded.calls).toEqual([{ attackerId: 2, targetId: 1, moveId: 'MOVE_TACKLE' }])
    expect(out.actions.find((a) => a.battlerId === 2)!.targetId).toBe(1)
  })

  it('2b. negative: an explicit action.target = 3 is kept', () => {
    const state = doublesState(scriptRng([]))
    state.battlers[2]!.mon.status2 = STATUS2_MULTIPLETURNS
    state.lockedMoves[2] = 'MOVE_TACKLE'
    const recorded = recordingDamage()
    executeTurn(state, [null, null, useMove(3, 'MOVE_GROWL'), null], loopDeps(state, recorded.resolver))
    expect(recorded.calls).toEqual([{ attackerId: 2, targetId: 3, moveId: 'MOVE_TACKLE' }])
  })

  it('2c. negative: a USER-target locked move keeps battlerId (Bide data target USER)', () => {
    // MOVE_BIDE is the only USER-target move with power > 0 (moves.json). STATUS2_RECHARGE
    // takes the locked branch (:217-219) while leaving Bide's own MULTIPLETURNS unset, so its
    // turn-1 branch returns targetId = currentTargetId, which is what applyLockedMove resolved.
    const state = doublesState(scriptRng([]))
    state.battlers[2]!.mon.status2 = STATUS2_RECHARGE
    state.lockedMoves[2] = 'MOVE_BIDE'
    const out = executeTurn(state, [null, null, useMove(null, 'MOVE_TACKLE'), null], loopDeps(state))
    expect(out.actions.find((a) => a.battlerId === 2)!.targetId).toBe(2)
  })
})

describe('cycle49 Item 3: Bide turn-3 target through gAbsentBattlerFlags', () => {
  it('3a(i). damager ABSENT, even draw: picks battler 1, flips to 3; one retarget draw', () => {
    // battle_util.c:3425: gAbsentBattlerFlags has bit 1, so GetMoveTarget(attacker, BIDE, 1)
    // runs. setTarget = 1 -> MOVE_TARGET_SELECTED (:491) -> SetRandomTarget: Random() % 2 = 0
    // picks battler 1 (absent in isBattlerAlive), which flips to 1 ^ BIT_FLANK = 3.
    const rng = scriptRng([0, 0, 0, 0])
    const state = doublesState(rng)
    const deps = loopDeps(state, fixedDamage)
    bideThroughStoringTurn(state, deps)
    expect(state.battlers[0]!.takenDmgBy).toBe(1)
    state.absentBattlerFlags |= 1 << 1 // scenario setup: the damager left with no reserve

    const out = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null, null, null], deps)

    expect(out.actions[0]!.targetId).toBe(3)
    expect(out.actions[0]!.targetDamage).toBe(76) // 2 * (19 + 19)
    // turn 1 + turn 2 Tackle accuracy draws, then the retarget draw, then Bide's accuracy draw.
    expect(rng.calls).toBe(4)
  })

  it('3a(ii). damager ABSENT, odd draw: picks battler 3 directly; one retarget draw', () => {
    const rng = scriptRng([0, 0, 1, 0])
    const state = doublesState(rng)
    const deps = loopDeps(state, fixedDamage)
    bideThroughStoringTurn(state, deps)
    state.absentBattlerFlags |= 1 << 1

    const out = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null, null, null], deps)

    expect(out.actions[0]!.targetId).toBe(3)
    expect(out.actions[0]!.targetDamage).toBe(76)
    expect(rng.calls).toBe(4)
  })

  it('3b. damager fainted but NOT absent: Bide still targets it, no retarget draw', () => {
    // battle_util.c:3424: only gAbsentBattlerFlags is tested, not IsBattlerAlive.
    const rng = scriptRng([0, 0, 0])
    const state = doublesState(rng)
    const deps = loopDeps(state, fixedDamage)
    bideThroughStoringTurn(state, deps)
    state.battlers[1]!.mon.hp = 0 // scenario setup: KO'd this turn, bit not yet set

    const out = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null, null, null], deps)

    expect(out.actions[0]!.targetId).toBe(1)
    // applyDamage is a no-op at hp 0, but the computed Bide damage is still reported.
    expect(out.actions[0]!.targetDamage).toBe(76)
    expect(rng.calls).toBe(3) // the two Tackle draws plus Bide's own accuracy draw
  })

  it('3c. damager alive: unchanged, targets 1 with no retarget draw', () => {
    const rng = scriptRng([0, 0, 0])
    const state = doublesState(rng)
    const deps = loopDeps(state, fixedDamage)
    bideThroughStoringTurn(state, deps)

    const out = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null, null, null], deps)

    expect(out.actions[0]!.targetId).toBe(1)
    expect(state.battlers[1]!.mon.hp).toBeLessThan(state.battlers[1]!.mon.maxHp)
    expect(rng.calls).toBe(3)
  })

  it('3d. singles, damager ABSENT: opposing left with no draw', () => {
    const rng = scriptRng([0, 0, 0])
    const state = singlesState(rng)
    const deps = loopDeps(state, fixedDamage)
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    expect(state.battlers[0]!.takenDmgBy).toBe(1)
    state.absentBattlerFlags |= 1 << 1

    const out = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)

    // :6337 -- singles never draws and takes the left foe even when absent.
    expect(out.actions[0]!.targetId).toBe(1)
    expect(rng.calls).toBe(3)
  })
})

describe('cycle49 Item 4: applyDamage takenDmgBy fallback', () => {
  it('4a. battler 2 with no source records the opposing-left battler 1', () => {
    const state = doublesState(scriptRng([]))
    applyDamage(state, 2, 10, [], undefined)
    expect(state.battlers[2]!.takenDmg).toBe(10)
    expect(state.battlers[2]!.takenDmgBy).toBe(1)
  })

  it('4b. an explicit source 3 is kept', () => {
    const state = doublesState(scriptRng([]))
    applyDamage(state, 2, 10, [], undefined, 3)
    expect(state.battlers[2]!.takenDmgBy).toBe(3)
  })

  it('4c. negative: skipDmgTrack leaves takenDmg and takenDmgBy untouched', () => {
    const state = doublesState(scriptRng([]))
    state.battlers[2]!.takenDmg = 7
    state.battlers[2]!.takenDmgBy = 3
    applyDamage(state, 2, 10, [], undefined, undefined, true)
    expect(state.battlers[2]!.takenDmg).toBe(7)
    expect(state.battlers[2]!.takenDmgBy).toBe(3)
    expect(hasFlag(state.absentBattlerFlags, 1 << 2)).toBe(false)
  })
})
