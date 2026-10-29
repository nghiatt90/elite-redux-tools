/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 111: end-to-end multi-turn chains. Every mechanic below is ported in pieces (a writer in one
// module, the reader in another); these tests drive the real `executeTurn` for two or three
// consecutive turns so the whole chain is exercised, not just each half in isolation.
//
// `executeTurn` is one full BattleTurnPassed (turn.ts:4020-4131): the action loop, then
// DoFieldEndTurnEffects, DoBattlerEndTurnEffects, replacements, Wish/Perish Song and finally
// TurnValuesCleanUp(FALSE) -> roundStructsClear (turn.ts:4110, battle_main.c:4490-4508). A second
// `executeTurn` is therefore exactly one more turn of the real loop: between turns the recharge
// timer is decremented and STATUS2_FLINCHED is cleared by ENDTURN_FLINCH (endTurn.ts:2066-2068),
// matching the C. No separate end-turn call is made by these tests.
//
// HP bookkeeping is driven by fixed damage (the state writes under test are independent of the
// damage engine). The RNG is a counter stream; a roll of 0 always hits every accuracy check and
// satisfies every `roll < chance` secondary roll. Draw order for an ordinary damaging move is
// accuracy (turn.ts:2930) then the move's secondary chance (moveEffects.ts:12064) then abilities.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STATUS2_FLINCHED,
  STATUS2_MULTIPLETURNS,
  STATUS2_RECHARGE,
  STATUS3_ON_AIR,
  STATUS3_SEMI_INVULNERABLE,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ReplacementDeps } from './switchIn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const RATIOS = simData.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }
const only = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function partyMon(speciesId: string, overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId,
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    itemId: null,
    abilities: noAbility,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

/** Every draw is 0: accuracy always hits and every secondary `roll < chance` passes. */
function countRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

function battle(
  a: SimBattleMon,
  b: SimBattleMon,
  rng: RandomSource,
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[] } = {},
): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    playerParty: opts.playerParty,
    opponentParty: opts.opponentParty,
    rng,
  })
}

function useMove(target: number, moveId: string): ChosenAction {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  const view: TurnOrderMoveView = {
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
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function loopDeps(state: BattleState, damage: DamageResolver, replacement?: ReplacementDeps): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(simData, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
    ...(replacement ? { replacement } : {}),
  }
}

/** Fixed damage: the bookkeeping under test never depends on the damage engine's own numbers. */
const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

function actionOf(out: TurnOutcome, battlerId: number) {
  const action = out.actions.find((a) => a.battlerId === battlerId)
  if (!action) throw new Error(`no action for battler ${battlerId}`)
  return action
}

// ---------------------------------------------------------------------------
// 1. Recharge chain -- Hyper Beam
//    Writer: MOVE_EFFECT_RECHARGE (battle_script_commands.c:2813-2819, from
//    BattleScript_EffectRecharge data/battle_scripts_1.s:4532-4536), ported at
//    moveEffects.ts:12329-12335: status2 |= STATUS2_RECHARGE, rechargeTimer = 2,
//    lockedMoves[battler] = move. Readers: applyLockedMove (turn.ts:1854-1862) and
//    CANCELLER_RECHARGE (battle_util.c:3294-3304, attackCanceller.ts:448-455).
//
//    NOTE on the timer: the writer stores 2, but executeTurn's own roundStructsClear
//    (turn.ts:4110, battle_main.c:4495-4497) runs at the end of that same turn and
//    decrements it to 1. So after turn 1 the observable value is 1, and it is the turn-2
//    canceller that zeroes it (attackCanceller.ts:450-452).
// ---------------------------------------------------------------------------
describe('cycle 111 - recharge chain (Hyper Beam)', () => {
  const hyperBeamState = (rng: RandomSource = countRng()) =>
    battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_HYPER_BEAM', 'MOVE_TACKLE', null, null], pp: [5, 20, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      rng,
    )

  it('turn 1 sets flag/timer/lock, turn 2 is cancelled, turn 3 Tackle works', () => {
    const state = hyperBeamState()
    const deps = () => loopDeps(state, fixedDamage(40))

    // Turn 1: Hyper Beam hits for 40. The writer arms RECHARGE and rechargeTimer = 2, then
    // roundStructsClear decrements the timer to 1 (STATUS2_RECHARGE survives: it is only
    // cleared when the timer reaches 0).
    executeTurn(state, [useMove(1, 'MOVE_HYPER_BEAM'), null], deps())
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_RECHARGE)).toBe(true)
    expect(state.battlers[0]!.volatiles.rechargeTimer).toBe(1)
    expect(state.lockedMoves[0]).toBe('MOVE_HYPER_BEAM')
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)

    // Turn 2: Tackle is chosen, applyLockedMove swaps the locked Hyper Beam back in, and then
    // CANCELLER_RECHARGE stops it before the accuracy check. A cancelled action's script goes
    // straight to BattleScript_MoveEnd, so neither damage nor PP happens; the canceller clears
    // the flag and the timer.
    const out2 = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], deps())
    expect(actionOf(out2, 0).cancelledBy).toBe('RECHARGE')
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
    expect(state.battlers[0]!.mon.pp[1]).toBe(20)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_RECHARGE)).toBe(false)
    expect(state.battlers[0]!.volatiles.rechargeTimer).toBe(0)

    // Turn 3: the lock flags are gone, so Tackle runs normally and costs its own PP.
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], deps())
    expect(state.battlers[1]!.mon.hp).toBe(20)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
    expect(state.battlers[0]!.mon.pp[1]).toBe(19)
  })

  it('a Hyper Beam that never hits sets no recharge (the effect only runs on a hit)', () => {
    // The negative cannot be an accuracy miss: Hyper Beam's accuracy is 100 and every roll is
    // % 100, so it can only be dodged by semi-invulnerability -- exactly the C's own route into
    // BattleScript_PrintMoveMissed. Battler 1 is faster and charges Fly, so when Hyper Beam
    // resolves the target is STATUS3_ON_AIR: getTotalAccuracy takes the ALWAYS_MISSES branch
    // (accuracy.ts:613-621) and the seteffectwithchance / MOVE_EFFECT_RECHARGE never runs.
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 },
        moves: ['MOVE_HYPER_BEAM', null, null, null],
        pp: [5, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 },
        moves: ['MOVE_FLY', null, null, null],
        pp: [15, 0, 0, 0],
      }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_HYPER_BEAM'), useMove(0, 'MOVE_FLY')], loopDeps(state, fixedDamage(40)))
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_ON_AIR)).toBe(true)
    expect(actionOf(out, 0).missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4) // a miss still pays PP (Cmd_ppreduce on both paths)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_RECHARGE)).toBe(false)
    expect(state.battlers[0]!.volatiles.rechargeTimer).toBe(0)
    expect(state.lockedMoves[0]).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Flinch chain
//    Writer: MOVE_EFFECT_FLINCH (moveEffects.ts:12133-12137, battle_script_commands.c:2665-2669).
//    Fake Out reaches it through its own script (moveEffects.ts:11592-11600, chance 100).
//    Reader: CANCELLER_FLINCH (battle_util.c:3305-3314, attackCanceller.ts:457-466).
//    Clear: ENDTURN_FLINCH (endTurn.ts:2066-2068). Mid-charge loss: CancelMultiTurnMoves
//    (statusEffects.ts:658-664, battle_util.c:1164-1175).
// ---------------------------------------------------------------------------
describe('cycle 111 - flinch chain', () => {
  it('Fake Out flinches a slower target: its action is cancelled and the flag clears at turn end', () => {
    // Fake Out is priority +3, so battler 0 moves first even against the faster foe. Its 100%
    // flinch roll is drawn at moveEffects.ts:12064 and the flag is written on the target.
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_FAKE_OUT', 'MOVE_TACKLE', null, null], pp: [10, 20, 0, 0] }),
      monFor('SPECIES_MUDKIP', { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      countRng(),
    )
    const out1 = executeTurn(state, [useMove(1, 'MOVE_FAKE_OUT'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(actionOf(out1, 1).cancelledBy).toBe('FLINCH')
    expect(actionOf(out1, 1).targetDamage).toBeNull()
    expect(state.battlers[1]!.mon.pp[0]).toBe(20) // cancelled before ppreduce
    // ENDTURN_FLINCH ran inside executeTurn's own end-turn pass.
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
    // After that same end-turn pass battler 1's isFirstTurn has gone 1 -> 0, so Fake Out itself
    // would now fail (jumpifnotfirstturn); the target's own Tackle is unaffected.

    // Next turn the same target acts normally: Tackle costs PP and deals its 40.
    const out2 = executeTurn(state, [null, useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out2, 1).cancelledBy).toBeNull()
    expect(actionOf(out2, 1).targetDamage).toBe(40)
    expect(state.battlers[0]!.mon.hp).toBe(60)
    expect(state.battlers[1]!.mon.pp[0]).toBe(19)
  })

  it('a slower flincher (Iron Head) applies the flag after the target acted, so nothing is cancelled', () => {
    // Both are priority 0; the target's speed 100 beats Iron Head's 50. The target's Tackle lands
    // first, then Iron Head's 30% roll (0) sets STATUS2_FLINCHED, far too late to cancel anything;
    // ENDTURN_FLINCH clears it at the end of the turn.
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 },
        moves: ['MOVE_IRON_HEAD', null, null, null],
        pp: [15, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_IRON_HEAD'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 1).targetDamage).toBe(40)
    expect(actionOf(out, 0).targetDamage).toBe(40)
    expect(actionOf(out, 0).cancelledBy).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(60)
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[1]!.mon.pp[0]).toBe(19)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
  })

  it('a flinched mid-charge Fly user loses MULTIPLETURNS and the semi-invulnerable bit', () => {
    // CANCELLER_FLINCH calls CancelMultiTurnMoves (battle_util.c:3309), which clears
    // MULTIPLETURNS and STATUS3_SEMI_INVULNERABLE. A real flinch never survives a turn boundary
    // (ENDTURN_FLINCH clears it), so the flag is set by hand between turns to reach the branch.
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
        moves: ['MOVE_FLY', 'MOVE_TACKLE', null, null],
        pp: [15, 20, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_FLY'), null], loopDeps(state, fixedDamage(40)))
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(true)
    expect(state.lockedMoves[0]).toBe('MOVE_FLY')
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)

    state.battlers[0]!.mon.status2 |= STATUS2_FLINCHED
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 0).cancelledBy).toBe('FLINCH')
    expect(state.battlers[1]!.mon.hp).toBe(100) // the forced Fly never executed
    expect(state.battlers[0]!.mon.pp[0]).toBe(14) // and never paid PP again
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_SEMI_INVULNERABLE)).toBe(false)
    expect(state.battlers[0]!.statuses3 & STATUS3_ON_AIR).toBe(0)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Focus Punch -- BattleScript_EffectFocusPunch (data/battle_scripts_1.s:6177-6181):
//    jumpifnodamage branches to BattleScript_HitFromAccCheck either way, so a hit user still
//    punches. Cmd_jumpifnodamage (battle_script_commands.c:11671-11676) reads
//    gRoundStructs[attacker].physicalDmg/specialDmg; basePower becomes 40 at :6851-6853.
//    MOVEEND_UPDATE_LAST_MOVES records the loss of focus in gBattleStruct->lastMoveFailed
//    (:4726-4728, moveEnd.ts:6245-6252).
//
//    Elite Redux's Focus Punch therefore does NOT fail when the user is hit: the punch still
//    lands (in the C at 40 BP) and the only observable "lost focus" state is lastMoveFailed.
// ---------------------------------------------------------------------------
describe('cycle 111 - Focus Punch', () => {
  it('a hit user still punches (fixed 40) and sets its lastMoveFailed bit; -3 priority lets the target hit first', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_FOCUS_PUNCH', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_FOCUS_PUNCH'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    // Tackle went first (Focus Punch is -3): the user took 40, which is the jumpifnodamage
    // condition and the lastMoveFailed condition. Focus Punch itself still resolves for 40.
    expect(actionOf(out, 1).turnOrderIndex).toBeLessThan(actionOf(out, 0).turnOrderIndex)
    expect(state.battlers[0]!.mon.hp).toBe(60)
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(hasFlag(state.lastMoveFailed, 1 << 0)).toBe(true) // bit 0 = the Focus Punch user
    expect(hasFlag(state.lastMoveFailed, 1 << 1)).toBe(false) // the Tackle user's own move did not fail
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
  })

  it('an unhit user clears the bit (and still deals damage)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_FOCUS_PUNCH', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    state.lastMoveFailed = 1 << 0 // pre-set: the "did not take damage" branch must clear it
    const out = executeTurn(state, [useMove(1, 'MOVE_FOCUS_PUNCH'), null], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 0).targetDamage).toBe(40)
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.lastMoveFailed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Sucker Punch -- BattleScript_EffectSuckerPunch (data/battle_scripts_1.s:2336-2340) ->
//    VARIOUS_SUCKER_PUNCH_CHECK (battle_script_commands.c:7213-7219): fail when the target has
//    already acted this turn, or when the target's chosen move is STATUS. The failure label
//    BattleScript_ButItFailedAtkStringPpReduce (:5938-5939) runs ppreduce, so PP is spent.
//    Sim: turn.ts:2584-2608.
// ---------------------------------------------------------------------------
describe('cycle 111 - Sucker Punch', () => {
  it('hits first against a chosen damaging move (+1 priority beats a faster Tackle) and KOs it', () => {
    // Sucker Punch is priority +1; the target is faster (200 vs 50) but has no priority, so
    // battler 0 still moves first. Lethal fixed damage means the target never gets to act.
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 },
        moves: ['MOVE_SUCKER_PUNCH', null, null, null],
        pp: [5, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 } }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_SUCKER_PUNCH'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(100)))
    expect(out.actions[0]!.battlerId).toBe(0)
    expect(actionOf(out, 0).targetDamage).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(actionOf(out, 1).targetDamage).toBeNull() // fainted before its slot in the order
    expect(state.battlers[1]!.mon.pp[0]).toBe(20) // it never got to pay PP either
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
  })

  it('fails against a chosen STATUS move but still spends PP', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_SUCKER_PUNCH', null, null, null], pp: [5, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 },
        moves: ['MOVE_HARDEN', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_SUCKER_PUNCH'), useMove(0, 'MOVE_HARDEN')], loopDeps(state, fixedDamage(100)))
    expect(actionOf(out, 0).targetDamage).toBeNull()
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4) // ppreduce inside BattleScript_ButItFailedAtkStringPpReduce
    expect(state.battlers[0]!.mon.pp[1]).toBe(0)
    // The target's own Harden still resolves: +1 Defense (a successful action, not cancelled).
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(7)
    expect(state.battlers[1]!.mon.pp[0]).toBe(19)
  })

  it('fails when the target already moved (priority +2 Quick Attack at higher speed)', () => {
    // Quick Attack is priority +2, so it outruns Sucker Punch's +1 even before speed is consulted.
    // By the time Sucker Punch runs, targetHasActedThisTurn (turn.ts:2584-2585) is true.
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 },
        moves: ['MOVE_SUCKER_PUNCH', null, null, null],
        pp: [5, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP', {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 },
        moves: ['MOVE_QUICK_ATTACK', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_SUCKER_PUNCH'), useMove(0, 'MOVE_QUICK_ATTACK')], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 1).turnOrderIndex).toBeLessThan(actionOf(out, 0).turnOrderIndex)
    expect(state.battlers[0]!.mon.hp).toBe(60) // Quick Attack landed
    expect(state.battlers[1]!.mon.hp).toBe(100) // Sucker Punch failed for 0
    expect(actionOf(out, 0).targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 5. Drain -- BattleScript_EffectAbsorb -> BattleScript_AbsorbHeal
//    (data/battle_scripts_1.s:3286-3324), manipulatedamage DMG_TO_HP_FROM_MOVE
//    (battle_script_commands.c:9398-9411): heal = hpDealt * argument / 100, or hpDealt / 2 when
//    the argument is 0, with a floor of 1; Big Root's 3/2 (:2369-2377). Sim: turn.ts:3309-3328.
// ---------------------------------------------------------------------------
describe('cycle 111 - drain (Giga Drain)', () => {
  const gigaDrain = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { moves: ['MOVE_GIGA_DRAIN', null, null, null], pp: [10, 0, 0, 0], hp: 50, ...overrides })

  it('heals floor(hpDealt / 2) = 20', () => {
    const state = battle(gigaDrain(), monFor('SPECIES_MUDKIP'), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_GIGA_DRAIN'), null], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 0).targetDamage).toBe(40)
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.hp).toBe(70)
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
  })

  it('Big Root multiplies the drain by 3/2 (floor): 20 -> 30', () => {
    const state = battle(gigaDrain({ itemId: 'ITEM_BIG_ROOT' }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_GIGA_DRAIN'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })

  it('Liquid Ooze turns the same 20 into self-damage', () => {
    const state = battle(gigaDrain(), monFor('SPECIES_MUDKIP', { abilities: only('ABILITY_LIQUID_OOZE') }), countRng())
    executeTurn(state, [useMove(1, 'MOVE_GIGA_DRAIN'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.hp).toBe(30)
  })

  it('healing is capped at maxHp', () => {
    const state = battle(gigaDrain({ hp: 90 }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_GIGA_DRAIN'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('drains from HP actually removed: 40 into a 10 HP target heals floor(10 / 2) = 5', () => {
    const state = battle(gigaDrain(), monFor('SPECIES_MUDKIP', { hp: 10 }), countRng())
    executeTurn(state, [useMove(1, 'MOVE_GIGA_DRAIN'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(55)
  })
})

// ---------------------------------------------------------------------------
// 6. U-turn / Volt Switch -- EFFECT_HIT_ESCAPE
//    BattleScript_EffectHitEscape (data/battle_scripts_1.s:2770-2790) -> BattleScript_MoveSwitch
//    (:5371-5379); sim turn.ts:3526-3536 gates on sumHpDealt > 0, a living attacker, an undecided
//    battle and a live reserve. The switch itself is performSwitchAction (turn.ts:1629-1809).
// ---------------------------------------------------------------------------
describe('cycle 111 - U-turn', () => {
  const uTurnMon = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { moves: ['MOVE_U_TURN', null, null, null], pp: [20, 0, 0, 0], ...overrides })
  const replacement: ReplacementDeps = { chooseReplacement: () => 1 }

  it('switches the attacker to the reserve after the hit lands on the original target', () => {
    const state = battle(uTurnMon(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_TREECKO')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_U_TURN'), null], loopDeps(state, fixedDamage(40), replacement))
    // The damage went to the mon that was on the field when the move started...
    expect(actionOf(out, 0).targetDamage).toBe(40)
    expect(state.battlers[1]!.mon.hp).toBe(60)
    // ...and the attacker slot now holds party slot 1 (Treecko). The outgoing slot keeps its HP
    // (performSwitchAction's own save: turn.ts:1676-1686).
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.sides[0].party[0]!.hp).toBe(100)
    expect(state.sides[0].party[1]!.speciesId).toBe('SPECIES_TREECKO')
    expect(state.battlers[0]!.mon.pp[0]).toBe(20) // Treecko's own Tackle slot, fresh
  })

  it('does not switch with no live reserve', () => {
    const state = battle(uTurnMon(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [partyMon('SPECIES_MUDKIP')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_U_TURN'), null], loopDeps(state, fixedDamage(40), replacement))
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(actionOf(out, 0).targetDamage).toBe(40)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
  })

  it('does not switch when the hit dealt no HP (sumHpDealt == 0)', () => {
    // The C's gate is on HP actually dealt, not on the move connecting. The substitute-absorbed
    // case the C describes takes this branch, but this sim's main damage path has no substitute HP
    // routing, so a 0-damage resolution reaches the same `sumHpDealt > 0` test.
    const state = battle(uTurnMon(), monFor('SPECIES_MUDKIP'), countRng(), {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_TREECKO')],
    })
    const out = executeTurn(state, [useMove(1, 'MOVE_U_TURN'), null], loopDeps(state, fixedDamage(0), replacement))
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(actionOf(out, 0).targetDamage).toBe(0)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
  })

  it('does not U-turn when Rocky Helmet recoil faints the attacker before the switch', () => {
    // Rocky Helmet: max(1, maxHp/6) = 10 into a 10 HP attacker (moveEnd.ts:6871-6879), applied in
    // move-end before the EFFECT_HIT_ESCAPE switch check (turn.ts:3496 vs :3526). isBattlerAlive
    // (:3529) is then false, so performSwitchAction is never called. No deps.replacement is
    // supplied, so the end-of-turn faint replacement cannot mask it either; a switch attempt would
    // have pushed the "SWITCH action for battler 0" note, which is asserted absent.
    const state = battle(
      uTurnMon({ hp: 10, maxHp: 60 }),
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_ROCKY_HELMET' }),
      countRng(),
      { playerParty: [partyMon('SPECIES_MUDKIP', { hp: 10, maxHp: 60 }), partyMon('SPECIES_TREECKO')] },
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_U_TURN'), null], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 0).targetDamage).toBe(40)
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(actionOf(out, 0).fainted).toContain(0)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(actionOf(out, 0).unmodelled.some((n) => n.includes('SWITCH action for battler 0'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. Two-turn moves
//    Semi-invulnerable: BattleScript_EffectSemiInvulnerable (data/battle_scripts_1.s:5848-5895);
//    Solar Beam: BattleScript_EffectSolarbeam (:5706-5722); Skull Bash / Meteor Beam / Sky Attack:
//    BattleScript_EffectTwoTurnSecondary (:4399-4416, `argumenttomoveeffect; seteffectprimary`).
//    Sim: turn.ts:2443-2580.
//
//    NOTE: Skull Bash's er-config argument is MOVE_EFFECT_ATK_PLUS_1 (MoveList.textproto:2198-2218,
//    and the data description says "raises its Attack"), NOT the mainline Defense boost. The sim
//    raises Attack, and so this test asserts Attack +1.
// ---------------------------------------------------------------------------
describe('cycle 111 - two-turn moves', () => {
  it('Fly: turn 1 charges (PP once, lock, semi-invulnerable blinds Tackle), turn 2 is forced and hits', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_FLY', 'MOVE_TACKLE', null, null], pp: [15, 20, 0, 0] }),
      monFor('SPECIES_MUDKIP', { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      countRng(),
    )
    const out1 = executeTurn(state, [useMove(1, 'MOVE_FLY'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(25)))
    expect(actionOf(out1, 0).targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true)
    expect(state.lockedMoves[0]).toBe('MOVE_FLY')
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(true)
    // Tackle cannot reach an airborne target: the accuracy check takes its ALWAYS_MISSES branch.
    expect(actionOf(out1, 1).missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.pp[0]).toBe(19) // a miss still pays PP

    // Turn 2: Tackle is chosen, but applyLockedMove forces Fly. No second PP deduction (the
    // HITMARKER_NO_PPDEDUCT path, turn.ts:2938-2942).
    const out2 = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(25)))
    expect(actionOf(out2, 0).targetDamage).toBe(25)
    expect(actionOf(out2, 1).targetDamage).toBe(25)
    expect(state.battlers[1]!.mon.hp).toBe(75)
    expect(state.battlers[0]!.mon.hp).toBe(75)
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)
    expect(state.battlers[0]!.mon.pp[1]).toBe(20)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(state.battlers[0]!.statuses3 & STATUS3_SEMI_INVULNERABLE).toBe(0)
  })

  it('Solar Beam skips the charge turn in sun (one-turn hit)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_SOLAR_BEAM', null, null, null], pp: [10, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    state.field.weather |= WEATHER_SUN_TEMPORARY
    executeTurn(state, [useMove(1, 'MOVE_SOLAR_BEAM'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(state.lockedMoves[0]).toBeNull()
  })

  it('Solar Beam without sun charges first (negative for the sun skip)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_SOLAR_BEAM', null, null, null], pp: [10, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_SOLAR_BEAM'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true)
    expect(state.lockedMoves[0]).toBe('MOVE_SOLAR_BEAM')
  })

  it('Skull Bash raises Attack +1 on the charge turn and does not cost PP again on the hit', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_SKULL_BASH', 'MOVE_TACKLE', null, null], pp: [10, 20, 0, 0] }),
      monFor('SPECIES_MUDKIP', { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_SKULL_BASH'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7) // 6 neutral + 1
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
    expect(state.battlers[1]!.mon.hp).toBe(100)

    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[1]!.mon.hp).toBe(60)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(7)
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 8. Life Orb -- ITEMEFFECT_LIFEORB_SHELLBELL (battle_util.c:6085-6108); REQUIRE chain:
//    canProc, gTurnStructs[attacker].damagedMons, alive, not Sheer Force, no Magic Guard,
//    attacker != target; recoil = max(1, maxHp / 10). Sim: moveEnd.ts:7126-7140, case 26 past the
//    `part === 'FIRST'` return at moveEnd.ts:6975, so a multi-hit move pays it once.
// ---------------------------------------------------------------------------
describe('cycle 111 - Life Orb', () => {
  const orb = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { itemId: 'ITEM_LIFE_ORB', ...overrides })

  it('maxHp 100 -> 10 recoil after a 10-damage hit; the orb is not consumed', () => {
    const state = battle(orb(), monFor('SPECIES_MUDKIP'), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[1]!.mon.hp).toBe(90)
    expect(state.battlers[0]!.mon.hp).toBe(90)
    expect(actionOf(out, 0).attackerDamage).toBe(10)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LIFE_ORB')
  })

  it('maxHp 7 -> the floor of 1 (gBattleMoveDamage == 0 becomes 1)', () => {
    const state = battle(orb({ hp: 7, maxHp: 7 }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.mon.hp).toBe(6)
  })

  it('Magic Guard blocks the recoil entirely (REQUIRE_NOT(BATTLER_HAS_MAGIC_GUARD))', () => {
    const state = battle(orb({ abilities: only('ABILITY_MAGIC_GUARD') }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(90)
  })

  it('a hit that removes no HP pays no recoil (the damagedMons gate)', () => {
    // The C's REQUIRE reads gTurnStructs[attacker].damagedMons, i.e. HP actually dealt; a 0-damage
    // hit leaves targetDamage at 0 and case 26 skips. (Hyper Beam-style 100% accuracy means a true
    // "miss" cannot be scripted with a % 100 roll either; the semi-invulnerable miss in the recharge
    // scenario above covers that route.)
    const state = battle(orb(), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })

  it('a multi-hit move (Double Kick) pays the recoil once, after all hits', () => {
    let hits = 0
    const resolver: DamageResolver = {
      resolve: () => {
        hits++
        return { targetDamage: 10, attackerDamage: null, unmodelled: [] }
      },
    }
    const state = battle(
      orb({ moves: ['MOVE_DOUBLE_KICK', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_DOUBLE_KICK'), null], loopDeps(state, resolver))
    expect(hits).toBe(2)
    expect(state.battlers[1]!.mon.hp).toBe(80)
    expect(state.battlers[0]!.mon.hp).toBe(90) // 10, not 20
  })

  it('a self-target move pays no recoil (no damaging target)', () => {
    // Swords Dance targets USER: the status path never reaches case 26, and the C's own
    // attacker != target / damagedMons gates would stop it anyway. The +2 Attack is a concrete
    // marker that the action really ran (EFFECT_ATTACK_UP_2).
    const state = battle(
      orb({ moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(0, 'MOVE_SWORDS_DANCE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
  })

  it('the recoil can faint the user', () => {
    const state = battle(orb({ hp: 10 }), monFor('SPECIES_MUDKIP'), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[1]!.mon.hp).toBe(90)
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(actionOf(out, 0).fainted).toContain(0)
    expect(actionOf(out, 0).attackerDamage).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 9. Speed Boost across two turns (optional). ENDTURN_ABILITIES (battle_util.c:2452,
//    endTurn.ts:1013-1016) raises Speed by 1 each end of turn; the guard is `isFirstTurn !== 2`, and a
//    fresh battler starts at 2 (create.ts:80) with the battle-start cleanup at create.ts:449
//    bringing it to 1, so turn 1's own end turn already boosts. Pinned for one turn in
//    turnEndTurn.test.ts; Truant's alternating loaf is pinned over three turns in
//    cycle89aAbilities.test.ts, so neither is duplicated here.
// ---------------------------------------------------------------------------
describe('cycle 111 - Speed Boost over two turns', () => {
  it('raises Speed by 1 at the end of each turn (+1 then +2)', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: only('ABILITY_SPEED_BOOST') }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [null, null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(7)
    expect(state.battlers[0]!.volatiles.isFirstTurn).toBe(0)
    executeTurn(state, [null, null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
  })
})
