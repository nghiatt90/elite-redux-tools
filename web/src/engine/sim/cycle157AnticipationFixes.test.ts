/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 157: two Anticipation fidelity fixes left by cycle 159.
//
// 1. AI_CheckBadMove's -5 (battle_ai_main.c:727-730) compares the RAW
//    CalcTypeEffectivenessMultiplier value against UQ_4_12(2.0), not the
//    collapsed AI_EFFECTIVENESS enum. aiGetEffectivenessEnum (aiScorers.ts:79)
//    maps every multiplier that is not exactly 0/0.25/0.5/1/2/4 to x1, so an
//    8x hit used to score 100 instead of 95.
// 2. BattleScript_BideAttack's `accuracycheck` (data/battle_scripts_1.s:7522)
//    reaches the same Cmd_accuracycheck else-branch as every other site
//    (src/battle_script_commands.c:1419-1433): against a semi-invulnerable
//    target GetTotalAccuracy returns 0, so a super-effective Bide release at an
//    Anticipation holder sets the counter and consumes NO Random() draw.
//
// Every number below is hand-derived in a comment.

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { STATUS3_ON_AIR } from './constants'
import { aiCheckBadMove } from './ai/aiCheckBadMove'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { aiDamageDepsFor, groundingFor } from './driver/session'
import { getSingleUseAbilityCounter, setSingleUseAbilityCounter } from './switchInAbility'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { TypeChart } from '../typeEffectiveness'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios

const FAST_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }
const SLOW_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 }
const NO_ABILITIES: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }
const ANTICIPATION: SimBattleMon['abilities'] = { ability: 'ABILITY_ANTICIPATION', innates: [null, null, null] }

function monFor(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { ...SLOW_STATS },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ...NO_ABILITIES },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)], rng })
}

/** `random16` returns values[calls-1] (0 past the end) and counts every draw. */
function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      const value = values[idx] ?? 0
      idx++
      return value
    },
  }
  return rng
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
    split: m.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function bridgeDamage(state: BattleState, chart: TypeChart): DamageResolver {
  return createBridgeDamageResolver({
    grounding: groundingFor(SIM, state),
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
    moveData: SIM.moveData,
    typeChart: chart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    random: state.rng,
  })
}

function loopDeps(state: BattleState, damage: DamageResolver, chart: TypeChart): TurnLoopDeps {
  return {
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors: SIM.moveBehaviors,
    hazardTypes: { typeChart: chart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
  }
}

const counterOf = (state: BattleState): number => getSingleUseAbilityCounter(state, 1, 'ABILITY_ANTICIPATION', DATA_CONTEXT)

// ---------------------------------------------------------------------------
// 1. AI_CheckBadMove's Anticipation -5 uses the raw multiplier
// ---------------------------------------------------------------------------

describe('cycle 157 - AI_CheckBadMove Anticipation (battle_ai_main.c:727-730)', () => {
  it('an 8x move scores 95 (raw multiplier, not the enum)', () => {
    // C: `if (BATTLER_HAS_ABILITY(def, ANTICIPATION) && !GetSingleUseAbilityCounter(def, ANTICIPATION) &&
    // CalcTypeEffectivenessMultiplier(move, moveType, atk, def, TRUE) >= UQ_4_12(2.0) &&
    // GetTotalAccuracy(...) <= 100) RETURN_SCORE_MINUS(5);`
    // Aqua Jet is WATER, 40 power, accuracy 100, EFFECT_NONE. Defender types
    // FIRE/GROUND/ROCK: types.json WATER->{FIRE,GROUND,ROCK} are all 2.0, so the
    // three-type fold (typeEffectiveness.ts's MulModifier calls) is 2*2*2 = 8x =
    // UQ_4_12(8.0) = 8192. The AI_EFFECTIVENESS enum maps 8192 to x1 (4 -- the
    // pre-fix `>= 5` test therefore scored 100); the raw 8192 >= 2048 scores 95.
    // Accuracy 100 <= 100. Draws: none (AI scoring is pure).
    const rng = scriptedRng([])
    const state = battle(
      monFor({ moves: ['MOVE_AQUA_JET', null, null, null], pp: [20, 0, 0, 0] }),
      monFor({ types: ['FIRE', 'GROUND', 'ROCK'], abilities: { ...ANTICIPATION } }),
      rng,
    )
    const scored = aiCheckBadMove(state, 0, 1, 'MOVE_AQUA_JET', 100, aiDamageDepsFor(SIM, state))
    expect(scored.score).toBe(95) // 100 - 5
    expect(rng.calls).toBe(0)
  })

  it('exact 1x scores 100', () => {
    // WATER vs NORMAL is 1.0 = UQ_4_12(1.0) = 1024 < 2048; no penalty.
    const rng = scriptedRng([])
    const state = battle(
      monFor({ moves: ['MOVE_AQUA_JET', null, null, null], pp: [20, 0, 0, 0] }),
      monFor({ types: ['NORMAL', 'MYSTERY', 'MYSTERY'], abilities: { ...ANTICIPATION } }),
      rng,
    )
    expect(aiCheckBadMove(state, 0, 1, 'MOVE_AQUA_JET', 100, aiDamageDepsFor(SIM, state)).score).toBe(100)
  })

  it('exact 2x still scores 95', () => {
    // Crackle Slam is ELECTRIC; WATER is 2.0 -> UQ_4_12(2048) >= the threshold
    // (the cycle159 case at its :420 must keep passing too).
    const rng = scriptedRng([])
    const state = battle(
      monFor({ moves: ['MOVE_CRACKLE_SLAM', null, null, null], pp: [20, 0, 0, 0] }),
      monFor({ types: ['WATER', 'MYSTERY', 'MYSTERY'], abilities: { ...ANTICIPATION } }),
      rng,
    )
    expect(aiCheckBadMove(state, 0, 1, 'MOVE_CRACKLE_SLAM', 100, aiDamageDepsFor(SIM, state)).score).toBe(95)
  })

  it('counter already set scores 100', () => {
    // `!GetSingleUseAbilityCounter(def, ANTICIPATION)` is false, so the raw
    // effectiveness call (and GetTotalAccuracy) is never made.
    const rng = scriptedRng([])
    const state = battle(
      monFor({ moves: ['MOVE_AQUA_JET', null, null, null], pp: [20, 0, 0, 0] }),
      monFor({ types: ['FIRE', 'GROUND', 'ROCK'], abilities: { ...ANTICIPATION } }),
      rng,
    )
    setSingleUseAbilityCounter(state, 1, 'ABILITY_ANTICIPATION', 1, DATA_CONTEXT)
    expect(aiCheckBadMove(state, 0, 1, 'MOVE_AQUA_JET', 100, aiDamageDepsFor(SIM, state)).score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 2. Bide turn-3 accuracycheck reaches the Anticipation branch
// ---------------------------------------------------------------------------

describe('cycle 157 - BattleScript_BideAttack accuracycheck (battle_scripts_1.s:7522)', () => {
  // The snapshot chart has no type weak to NORMAL; this test needs Bide (NORMAL,
  // PHYSICAL) to be 2x against a WATER defender, so only the NORMAL row's WATER
  // entry is raised to 2.0. It does not touch NORMAL vs anything else, so the
  // foe's Tackles against the NORMAL-typed user in turns 1-2 stay 1x.
  const BIDE_CHART: TypeChart = { ...SIM.typeChart, NORMAL: { ...SIM.typeChart.NORMAL, WATER: 2 } }
  // Tackle damage/time is cycle135b's setup: 2 turns of 19 damage = takenDmg 38.
  // Draws per Tackle: accuracy (0, hit), crit (1, no crit), roll (0, max roll).
  const TACKLE_DRAWS = [0, 1, 0, 0, 1, 0]

  function bideBattle(foeTypes: [string, string, string], foeAbilities: SimBattleMon['abilities'], rng: RandomSource) {
    const user = monFor({
      rawStats: { ...FAST_STATS },
      moves: ['MOVE_BIDE', null, null, null],
      pp: [10, 0, 0, 0],
      types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    })
    const foe = monFor({ types: foeTypes, abilities: foeAbilities })
    const state = battle(user, foe, rng)
    const deps = loopDeps(state, bridgeDamage(state, BIDE_CHART), BIDE_CHART)
    return { state, deps }
  }

  it('a super-effective release misses with no Random() draw and sets the counter', () => {
    // C (battle_script_commands.c:1427-1432): GetTotalAccuracy returns 0 against
    // a semi-invulnerable target (:1267-1275), so `accuracy <= 100` holds even
    // for Bide's accuracy-0 sentinel. NORMAL vs the WATER defender is 2.0 =
    // UQ_4_12(2048) >= 2048 and the counter is 0, so the `else if` roll is
    // skipped: SetSingleUseAbilityCounter + MOVE_RESULT_MISSED, 0 draws.
    const rng = scriptedRng(TACKLE_DRAWS)
    const { state, deps } = bideBattle(['WATER', 'MYSTERY', 'MYSTERY'], { ...ANTICIPATION }, rng)

    executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    expect(state.battlers[0]!.takenDmg).toBe(38) // 19 + 19
    expect(rng.calls).toBe(6) // 3 draws per Tackle, nothing for Bide's turn 1-2

    state.battlers[1]!.statuses3 |= STATUS3_ON_AIR
    const out = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(out.actions[0]!.missed).toBe(true)
    expect(out.actions[0]!.targetDamage).toBeNull()
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(counterOf(state)).toBe(1)
    // The branch fired, so the `(Random() % 100) >= accuracy` roll never ran.
    expect(rng.calls).toBe(6)
  })

  it('negative: counter already spent -> the ordinary roll is drawn', () => {
    // Same setup, but GetSingleUseAbilityCounter(def, ANTICIPATION) is 1, so the
    // branch is false; the else-if roll runs (1 draw). Accuracy is 0 against the
    // semi-invulnerable target, so any roll is a miss.
    const rng = scriptedRng([...TACKLE_DRAWS, 0])
    const { state, deps } = bideBattle(['WATER', 'MYSTERY', 'MYSTERY'], { ...ANTICIPATION }, rng)
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    setSingleUseAbilityCounter(state, 1, 'ABILITY_ANTICIPATION', 1, DATA_CONTEXT)

    state.battlers[1]!.statuses3 |= STATUS3_ON_AIR
    const out = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(out.actions[0]!.missed).toBe(true)
    expect(rng.calls).toBe(7) // + the accuracy roll
    expect(counterOf(state)).toBe(1) // unchanged
  })

  it('negative: non-super-effective target -> the ordinary roll is drawn', () => {
    // NORMAL vs NORMAL is 1.0 = 1024 < 2048, so the branch is false even with
    // the counter at 0. The else-if roll runs (1 draw) and misses on accuracy 0;
    // the counter stays 0.
    const rng = scriptedRng([...TACKLE_DRAWS, 0])
    const { state, deps } = bideBattle(['NORMAL', 'MYSTERY', 'MYSTERY'], { ...ANTICIPATION }, rng)
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)
    executeTurn(state, [useMove(1, 'MOVE_BIDE'), useMove(0, 'MOVE_TACKLE')], deps)

    state.battlers[1]!.statuses3 |= STATUS3_ON_AIR
    const out = executeTurn(state, [useMove(1, 'MOVE_BIDE'), null], deps)
    expect(out.actions[0]!.missed).toBe(true)
    expect(rng.calls).toBe(7) // + the accuracy roll
    expect(counterOf(state)).toBe(0)
  })
})
