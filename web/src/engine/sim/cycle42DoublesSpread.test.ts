/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 42 (dbl-3b, first slice): MOVEEND_NEXT_TARGET, the double-battle re-run
// loop for BOTH and FOES_AND_ALLY moves.
//
//   Cmd_moveend's case 21 (src/battle_script_commands.c:4782-4822) re-enters the
//   move's WHOLE effect script for one more target at a time: `gBattlerTarget` is
//   moved, `moveendState = 0`, `MoveValuesCleanUp()` clears the result flags, and
//   `BattleScriptPush(gBattleScriptsForMoveEffects[effect])` restarts at
//   attackcanceler (:4806-4813). Accuracy, Protect, damage, secondaries and move-end
//   therefore run per target, each with its own RNG draws.
//
//   - The loop needs a double (`gBattleTypeFlags & BATTLE_TYPE_DOUBLE`, :4787), no
//     cancellation (`HITMARKER_UNABLE_TO_USE_MOVE`), not a charging turn, the DYNAMIC
//     target flag BOTH or FOES_AND_ALLY, and HITMARKER_NO_ATTACKSTRING clear (:4787-4790).
//   - FOES_AND_ALLY continues at the first alive non-attacker id after the current
//     target (:4794-4798) and sets HITMARKER_NO_PPDEDUCT (:4795); BOTH continues at
//     BATTLE_PARTNER(target) = target ^ 2 (include/constants/battle.h:37) and sets
//     HITMARKER_NO_ATTACKSTRING (:4800-4801).
//   - PP is charged once either way: Cmd_ppreduce clears NO_PPDEDUCT and returns
//     (:1465-1467); it returns on NO_ATTACKSTRING without deducting (:1472).
//   - HandleAction_UseMove (battle_util.c:283-289) starts a doubles FOES_AND_ALLY
//     move on the first alive non-attacker scanning ids from 0, so the target+1 scan
//     reaches every other battler.
//
// Numbers (level 100, IV 31, EV 0, neutral nature, no abilities/items/weather):
//   Garchomp (Atk 296 / SpA 196) vs Snorlax (Def 166 / SpD 256)
//   core(power p) = floor(42 * p * atk / def) = floor(.../50) + 2
//   Hyper Voice  (Normal, 95, special, BOTH):         core = floor(42*95*196/256)
//       = floor(782040/256) = 3054 -> 3054/50 = 61 -> 63; x0.75:
//       applyModifier(768, 63) = floor((768*63+512)/1024) = 47.
//   Earthquake   (Ground, 100, physical, FOES_AND_ALLY): core = floor(42*100*296/166)
//       = floor(1243200/166) = 7489 -> 149 -> 151; STAB modifier
//       mulModifier(768, 1536) = floor((768*1536+512)/1024) = 1152;
//       applyModifier(1152, 151) = floor((1152*151+512)/1024) = 170.
//   Rock Slide   (Rock, 75, physical, BOTH):          core = floor(42*75*296/166)
//       = floor(932400/166) = 5616 -> 112 -> 114; x0.75 -> floor((768*114+512)/1024)
//       = 86. With the partner dead GetMoveTargetCount is 1, so no x0.75 -> 114.
//
// C lines checked:
//   MOVEEND_NEXT_TARGET           battle_script_commands.c:4782-4822
//   Cmd_ppreduce / attackstring   battle_script_commands.c:1450-1500
//   Cmd_attackcanceler (outcome)  battle_script_commands.c:1068-1077
//   AdjustFollowupMoveTarget      battle_util.c:283-289
//   IsBattlerAlive                battle_util.c:6685-6694
//   GetMoveTargetCount            battle_util.c:6761-6781 (x0.75 at :7498)

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { buildMoveAction, cloneSession, createSession, groundingFor, stepTurn } from './driver/session'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { executeTurn, type TurnLoopDeps } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { BATTLE_TYPE_DOUBLE, STATUS1_SLEEP, setCounter } from './constants'
import { createRandomSource } from './rng'

const data = loadSimData()

// ---------------------------------------------------------------------------
// State + deps: four hand-built battlers with the fixtures the comments derive,
// and the production bridge damage resolver so the x0.75 spread term is live.
// ---------------------------------------------------------------------------

const GARCHOMP_STATS = { atk: 296, def: 226, spatk: 196, spdef: 206, spe: 240 }
const SNORLAX_STATS = { atk: 256, def: 166, spatk: 166, spdef: 256, spe: 96 }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_SNORLAX',
    rawStats: { ...SNORLAX_STATS },
    moves: [null, null, null, null],
    pp: [0, 0, 0, 0],
    hp: 999,
    maxHp: 999,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 100,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

interface Spec {
  speciesId?: string
  stats?: SimBattleMon['rawStats']
  types?: SimBattleMon['types']
  moves: SimBattleMon['moves']
  pp: SimBattleMon['pp']
  hp?: number
  status1?: number
}

/** The three idle defenders get distinct Speed values (96/95/94) so the turn-order
 * sort has no speed ties: a tie would draw a Random() and shift every scripted value. */
function battle(specs: Spec[], rng: RandomSource, flags: number = BATTLE_TYPE_DOUBLE): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? (i === 0 ? 'SPECIES_GARCHOMP' : 'SPECIES_SNORLAX'),
          rawStats: { ...(s.stats ?? (i === 0 ? GARCHOMP_STATS : { ...SNORLAX_STATS, spe: 97 - i })) },
          moves: s.moves,
          pp: s.pp,
          hp: s.hp ?? 999,
          maxHp: s.hp ?? 999,
          types: s.types ?? (i === 0 ? ['DRAGON', 'GROUND', 'MYSTERY'] : ['NORMAL', 'MYSTERY', 'MYSTERY']),
          status1: s.status1 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    battleTypeFlags: flags,
  })
}

/** Battler 3 as the attacker: same hand-derived Garchomp fixture, at a non-zero id. */
const attackerAt3 = (moveId: string): Spec => ({
  speciesId: 'SPECIES_GARCHOMP',
  stats: GARCHOMP_STATS,
  types: ['DRAGON', 'GROUND', 'MYSTERY'],
  moves: [moveId, null, null, null],
  pp: [10, 0, 0, 0],
})

function depsFor(state: BattleState): TurnLoopDeps {
  const grounding = groundingFor(data, state)
  return {
    turnOrder: data.turnOrder,
    grounding,
    damage: createBridgeDamageResolver({
      dataContext: data.dataContext,
      grounding,
      turnOrder: data.turnOrder,
      statStageRatios: data.statStageRatios,
      inverseBattle: false,
      moveData: data.moveData,
      typeChart: data.typeChart,
      inverseTypeChart: data.inverseTypeChart,
      moveBehaviors: data.moveBehaviors,
      battleConstants: data.battleConstants,
      random: { random16: () => state.rng.random16() },
    }),
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    moveBehaviors: data.moveBehaviors,
    hazardTypes: { typeChart: data.typeChart, inverseTypeChart: data.inverseTypeChart, inverseBattle: false },
  }
}

function useMove(target: number, moveId: string): ChosenAction {
  const m = data.dataContext.move(moveId)!
  const view: TurnOrderMoveView = {
    id: moveId,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags ?? {},
    split: m.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

/** Every random16() answer is consumed in order, then 0. */
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

const attacker0 = (moveId: string, pp = 10): Spec => ({ moves: [moveId, null, null, null], pp: [pp, 0, 0, 0] })
/** A Snorlax that does nothing. Distinct `spe` values keep the turn-order sort tie-free. */
const idle = (spe: number): Spec => ({
  speciesId: 'SPECIES_SNORLAX',
  stats: { ...SNORLAX_STATS, spe },
  types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
  moves: ['MOVE_CELEBRATE', null, null, null],
  pp: [10, 0, 0, 0],
})

/** Runs one turn with only battler 0 acting. */
function runMove(state: BattleState, moveId: string): ReturnType<typeof executeTurn> {
  return executeTurn(state, [useMove(1, moveId), null, null, null], depsFor(state))
}

// ---------------------------------------------------------------------------
// 1. BOTH: battlers 1 and 3 are hit, in that order, once each; PP once.
// ---------------------------------------------------------------------------
describe('(1) BOTH re-runs on the partner', () => {
  it('Hyper Voice hits foes 1 then 3 for 47 each and spends one PP', () => {
    // :4800-4801 partner = target ^ 2 (1 ^ 2 = 3); :4790 NO_ATTACKSTRING ends the loop after
    // the second pass; :1472 ppreduce then returns without a second deduction.
    const rng = scriptedRng([0, 1, 0, 0, 1, 0]) // acc, crit(no), roll(max) per pass
    const state = battle([attacker0('MOVE_HYPER_VOICE'), idle(96), idle(95), idle(94)], rng)
    const out = runMove(state, 'MOVE_HYPER_VOICE')
    const action = out.actions.find((a) => a.battlerId === 0)!

    expect(action.targetId).toBe(1) // primary fields are the FIRST pass's
    expect(action.targetDamage).toBe(47)
    expect(action.targets!.map((t) => t.targetId)).toEqual([1, 3])
    expect(action.targets!.map((t) => t.targetDamage)).toEqual([47, 47])
    expect(action.targets!.every((t) => !t.missed)).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(999 - 47)
    expect(state.battlers[3]!.mon.hp).toBe(999 - 47)
    expect(state.battlers[2]!.mon.hp).toBe(999) // BOTH is foe-only
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // one ppreduce for the whole action
  })
})

// ---------------------------------------------------------------------------
// 2. FOES_AND_ALLY: every alive non-attacker in id order, from id 0.
// ---------------------------------------------------------------------------
describe('(2) FOES_AND_ALLY iterates forward from the first alive battler', () => {
  it('Earthquake hits 1, 2 (ally) and 3 for 170 each; PP once', () => {
    // battle_util.c:283-289 starts on battler 1; :4794-4798 scans 2 then 3; the scan off the
    // end yields gBattlersCount, which IsBattlerAlive (:6685-6694) reports dead; :4795 sets
    // NO_PPDEDUCT for both re-runs and :1465-1467 consumes it without charging.
    const rng = scriptedRng([0, 1, 0, 0, 1, 0, 0, 1, 0])
    const state = battle([attacker0('MOVE_EARTHQUAKE'), idle(96), idle(95), idle(94)], rng)
    const out = runMove(state, 'MOVE_EARTHQUAKE')
    const action = out.actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.targetId)).toEqual([1, 2, 3])
    expect(action.targets!.map((t) => t.targetDamage)).toEqual([170, 170, 170])
    expect([1, 2, 3].map((id) => state.battlers[id]!.mon.hp)).toEqual([829, 829, 829])
    expect(state.battlers[0]!.mon.hp).toBe(999) // never hits the user
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// 3. Each target rolls its own accuracy; a miss on the first does not stop the loop.
// ---------------------------------------------------------------------------
describe('(3) per-target accuracy draws', () => {
  it('Heat Wave misses battler 1 (draw 99 >= 90) and hits battler 3', () => {
    // Pass 1: :1433 `(Random() % 100) >= accuracy` -> miss, no crit/roll/secondary draws.
    // Pass 2: accuracy 0 (hit), crit 1 (no crit), roll 0 (max 63 -> 47), burn chance 99
    // (99 >= 10) so no burn. Draw order is accuracy -> secondary as the pipeline runs them.
    const rng = scriptedRng([99, 0, 1, 0, 99])
    const state = battle([attacker0('MOVE_HEAT_WAVE'), idle(96), idle(95), idle(94)], rng)
    const out = runMove(state, 'MOVE_HEAT_WAVE')
    const action = out.actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.targetId)).toEqual([1, 3])
    expect(action.targets!.map((t) => t.missed)).toEqual([true, false])
    expect(action.targets!.map((t) => t.targetDamage)).toEqual([null, 47])
    expect(state.battlers[1]!.mon.hp).toBe(999)
    expect(state.battlers[3]!.mon.hp).toBe(999 - 47)
    expect(rng.calls).toBe(5)
    expect(state.battlers[0]!.mon.pp[0]).toBe(9) // the miss still pays (:1460-1506)
  })
})

// ---------------------------------------------------------------------------
// 4. A dead next target ends the loop with no extra draws; PP is not carried over.
// ---------------------------------------------------------------------------
describe('(4) dead second target', () => {
  it('BOTH Rock Slide hits only battler 1, and the next turn deducts PP again', () => {
    // :4815-4817 -- the dead partner ends the loop before the second script push, so no
    // accuracy/crit/roll draws happen for it. Pass 1 draws acc, crit, roll and the 20%
    // flinch chance (99 -> no flinch) = 4.
    const rng = scriptedRng([0, 1, 0, 99])
    const state = battle([attacker0('MOVE_ROCK_SLIDE', 10), idle(96), idle(95), { ...idle(94), hp: 0 }], rng)
    const first = runMove(state, 'MOVE_ROCK_SLIDE')
    const action = first.actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.targetId)).toEqual([1])
    // GetMoveTargetCount sees no alive partner -> 1, so no x0.75: 114.
    expect(action.targets![0]!.targetDamage).toBe(114)
    expect(state.battlers[1]!.mon.hp).toBe(999 - 114)
    expect(state.battlers[3]!.mon.hp).toBe(0)
    expect(rng.calls).toBe(4)

    // The NO_PPDEDUCT/NO_ATTACKSTRING markers are per-action: the next action pays normally.
    state.rng = scriptedRng([0, 1, 0, 99])
    runMove(state, 'MOVE_ROCK_SLIDE')
    expect(state.battlers[0]!.mon.pp[0]).toBe(8)
  })

  it('a FOES_AND_ALLY scan with no later target also stops', () => {
    // Attacker is battler 3: HandleAction_UseMove starts on battler 0, the scan then takes
    // 1 and 2 (3 is the attacker), and running off the end ends it. Four battlers, attacker last.
    const rng = scriptedRng([0, 1, 0, 0, 1, 0, 0, 1, 0])
    const state = battle([idle(96), idle(95), idle(94), attackerAt3('MOVE_EARTHQUAKE')], rng)
    executeTurn(state, [null, null, null, useMove(0, 'MOVE_EARTHQUAKE')], depsFor(state))
    expect(state.battlers[0]!.mon.hp).toBe(999 - 170)
    expect(state.battlers[1]!.mon.hp).toBe(999 - 170)
    expect(state.battlers[2]!.mon.hp).toBe(999 - 170)
    expect(state.battlers[3]!.mon.hp).toBe(999)
    expect(state.battlers[3]!.mon.pp[0]).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// 5. Negative cases: SELECTED, singles, charging turn, cancellation.
// ---------------------------------------------------------------------------
describe('(5) negatives', () => {
  it('a SELECTED move in a double hits one target and carries no targets list', () => {
    const rng = scriptedRng([0, 1, 0])
    const state = battle([attacker0('MOVE_TACKLE', 20), idle(96), idle(95), idle(94)], rng)
    const action = runMove(state, 'MOVE_TACKLE').actions.find((a) => a.battlerId === 0)!
    expect(action.targetId).toBe(1)
    expect(action.targetDamage).toBe(61) // 40 power physical: 2995/50+2
    expect(action.targets).toBeUndefined()
    expect(rng.calls).toBe(3) // accuracy, crit, roll: no second pass
  })

  it('a BOTH move in a single battle hits once and carries no targets list', () => {
    // No BATTLE_TYPE_DOUBLE -> :4787's gate. targetCount in the engine is also 1
    // (partner id 3 is past battlersCount), so the damage keeps the unscaled 114.
    const rng = scriptedRng([0, 1, 0, 99])
    const state = battle([attacker0('MOVE_ROCK_SLIDE'), idle(96)], rng, 0)
    expect(state.battlersCount).toBe(2)
    const action = runMove(state, 'MOVE_ROCK_SLIDE').actions.find((a) => a.battlerId === 0)!
    expect(action.targetDamage).toBe(114)
    expect(action.targets).toBeUndefined()
    expect(state.battlers[1]!.mon.hp).toBe(999 - 114)
  })

  it('a charging turn does not loop (:4787 !chargingTurn)', () => {
    // No two-turn move in the dataset is BOTH/FOES_AND_ALLY, so the flag is set directly on
    // a BOTH move to exercise the guard. Without it this pass would re-run for battler 3.
    const rng = scriptedRng([0, 1, 0])
    const state = battle([attacker0('MOVE_HYPER_VOICE'), idle(96), idle(95), idle(94)], rng)
    state.battlers[0]!.round.chargingTurn = true
    const action = runMove(state, 'MOVE_HYPER_VOICE').actions.find((a) => a.battlerId === 0)!
    expect(action.targets!.map((t) => t.targetId)).toEqual([1])
    expect(state.battlers[3]!.mon.hp).toBe(999)
    expect(rng.calls).toBe(3)
  })

  it('a cancelled move does not loop (HITMARKER_UNABLE_TO_USE_MOVE)', () => {
    // CANCELLER_ASLEEP :3210-3232 with a counter above 1 cancels before accuracy; the
    // C's loop condition excludes it at :4787, so the partner is never touched and no
    // draw happens. The sim's canceller returns from executeAction before the move
    // pipeline, so there is not even one target pass (`targets` stays absent). PP is
    // untouched (the cancel script never reaches ppreduce).
    const rng = scriptedRng([0, 1, 0, 0, 1, 0])
    const asleep = { ...attacker0('MOVE_HYPER_VOICE'), status1: setCounter(0, STATUS1_SLEEP, 2) }
    const state = battle([asleep, idle(96), idle(95), idle(94)], rng)
    const action = runMove(state, 'MOVE_HYPER_VOICE').actions.find((a) => a.battlerId === 0)!
    expect(action.cancelledBy).toBe('SLEEP')
    expect(action.targetDamage).toBeNull()
    expect(action.targets).toBeUndefined()
    expect(state.battlers[1]!.mon.hp).toBe(999)
    expect(state.battlers[3]!.mon.hp).toBe(999)
    expect(rng.calls).toBe(0)
    expect(state.battlers[0]!.mon.pp[0]).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 6. Singles is untouched: a fixed-seed session turn is deep-equal to itself and
//    carries no targets list.
// ---------------------------------------------------------------------------
describe('(6) singles deep-equal', () => {
  const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
  const specs = [
    { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
    { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  ]
  const build = () =>
    createSession({
      data,
      playerParty: buildPlayerParty(specs, 50, data),
      opponentTrainer: trainer,
      rng: createRandomSource(7),
    })

  it('same seed, same outcome; no targets field; PP deducted normally', () => {
    const first = build()
    const second = build()
    const a = stepTurn(first, buildMoveAction(first.state, data, 0, 'MOVE_TACKLE'))
    const b = stepTurn(second, buildMoveAction(second.state, data, 0, 'MOVE_TACKLE'))
    expect(JSON.parse(JSON.stringify(b.outcome))).toEqual(JSON.parse(JSON.stringify(a.outcome)))
    for (const action of a.outcome.actions) expect(action.targets).toBeUndefined()
    expect(first.state.battlers[0]!.mon.pp[0]).toBe(second.state.battlers[0]!.mon.pp[0])
    // Tackle starts at CalculatePPWithBonus's 32 (base 20, pokemon.c:2260-2263);
    // one use deducts one PP.
    expect(first.state.battlers[0]!.mon.pp[0]).toBe(31)
  })

  it('a doubles session built through the production layout still has the four slots', () => {
    // Guards the scaffolding the two helpers above share (cycle41's buildBattleState path).
    const dummy = build()
    const state = buildBattleState(
      { opponents: [trainer], forcedDouble: true },
      {
        data,
        tier: 'elite',
        playerParty: buildPlayerParty(specs, 50, data),
        opponentParties: [buildOpponentParty(trainer, 'elite', 50, data)],
        rng: createRandomSource(1),
      },
    )
    dummy.state = state
    const session = cloneSession(dummy, 1)
    expect(session.state.battlersCount).toBe(4)
    expect(session.state.battleTypeFlags & BATTLE_TYPE_DOUBLE).toBeTruthy()
  })
})
