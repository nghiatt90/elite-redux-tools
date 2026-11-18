/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 43 (dbl-3b2): the spread-move tail of the move-end ladder runs ONCE.
//
//   Cmd_moveend's case 21, MOVEEND_NEXT_TARGET (src/battle_script_commands.c:4782-4822), resets
//   gBattleScripting.moveendState to 0 and returns into the move's effect script for every
//   target that still exists (:4806-4814). Cases 22-30 of that same pass therefore NEVER run:
//   the script re-enters Cmd_moveend from 0 on the next target. They run only on the pass that
//   finds no further target (:4815-4818, or the loop gate at :4787-4790 being false):
//
//     case 23 MOVEEND_RECOIL            :4457-4517  -- savedDmg / fraction
//     case 26 MOVEEND_LIFEORB_SHELLBELL :4823-4827  -- battle_util.c:6066-6124
//     case 27 MOVEEND_CHANGED_ITEMS     :4656-4665
//     case 29 MOVEEND_PICKPOCKET        :4828-4853
//     case 30 MOVEEND_CLEAR_BITS        :4934-4957  -- savedDmg = 0, damagedMons = 0
//
//   savedDmg is the SUM of gHpDealt over every pass: MOVEEND_SUM_DAMAGE adds on every entry
//   (:4334-4342) and nothing clears it until case 30. So recoil and Shell Bell read the summed
//   damage and Life Orb -- gated on gTurnStructs[attacker].damagedMons, set by any pass that dealt
//   HP (battle_script_commands.c:1691) -- fires at most once, `maxHP / 10`.
//
// Numbers reuse cycle42's hand-derived fixtures (level 100, IV 31, EV 0, neutral nature, no
// abilities/weather), with the production bridge resolver so the x0.75 spread term is live:
//   Garchomp (Atk 296 / SpA 196) vs Snorlax (Def 166 / SpD 256); core(p) = floor(42*p*atk/def)/50 + 2
//   Hyper Voice (Normal 95 special BOTH): 63 -> applyModifier(768, 63) = 47
//   Earthquake  (Ground 100 physical FOES_AND_ALLY): 151 -> STAB 1152 -> 170
//   Boomburst   (Normal 140 special FOES_AND_ALLY): core = floor(42*140*196/256) = 4501 -> 90 -> 92;
//               applyModifier(768, 92) = floor((768*92+512)/1024) = 69. EFFECT_RECOIL_50 = fraction 2
//               (moveBehaviors.json), so recoil = max(1, floor(sum / 2)).
//   Sparkling Aria (Water 100 special FOES_AND_ALLY): core = floor(42*100*196/256) = 3215 -> 64 -> 66;
//               applyModifier(768, 66) = 50.
//   Life Orb boosts the move itself by UQ_4_12(1.3) (battle_util.c:7651-7653), so a Life Orb holder's
//   numbers are the plain ones x1.3: Hyper Voice 47 -> 61, Earthquake 170 -> 221, Tackle 61 -> 79,
//   Double Hit 69 -> 90 per hit.
//
// C lines checked:
//   MOVEEND_SUM_DAMAGE         battle_script_commands.c:4334-4342
//   MOVEEND_NEXT_TARGET        battle_script_commands.c:4782-4822 (MoveValuesCleanUp :3761-3768)
//   MOVEEND_RECOIL             battle_script_commands.c:4457-4517 (NO_EFFECT :4462)
//   MOVEEND_LIFEORB_SHELLBELL  battle_script_commands.c:4823-4827, battle_util.c:6066-6124
//   MOVEEND_MOVE_EFFECTS2_ON_EACH battle_script_commands.c:4573-4632 (per pass)
//   MOVEEND_CHANGED_ITEMS      battle_script_commands.c:4656-4665
//   MOVEEND_CLEAR_BITS         battle_script_commands.c:4934-4957
//   MOVE_RESULT_NO_EFFECT      include/constants/battle.h:389; MISSED set at :1434 and :1204

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { executeTurn, type TurnLoopDeps } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { BATTLE_TYPE_DOUBLE, STATUS1_BURN } from './constants'

const data = loadSimData()

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
  maxHp?: number
  itemId?: string
  status1?: number
}

/** The three idle defenders get distinct Speed values (96/95/94) so the turn-order sort has no
 * speed ties: a tie would draw a Random() and shift every scripted value. */
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
          maxHp: s.maxHp ?? s.hp ?? 999,
          itemId: s.itemId ?? null,
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

const attacker0 = (moveId: string, extra: Partial<Spec> = {}): Spec => ({
  moves: [moveId, null, null, null],
  pp: [10, 0, 0, 0],
  ...extra,
})
/** A Snorlax that does nothing. Distinct `spe` values keep the turn-order sort tie-free. */
const idle = (spe: number, extra: Partial<Spec> = {}): Spec => ({
  speciesId: 'SPECIES_SNORLAX',
  stats: { ...SNORLAX_STATS, spe },
  types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
  moves: ['MOVE_CELEBRATE', null, null, null],
  pp: [10, 0, 0, 0],
  ...extra,
})

/** Runs one turn with only battler 0 acting. */
function runMove(state: BattleState, moveId: string): ReturnType<typeof executeTurn> {
  return executeTurn(state, [useMove(1, moveId), null, null, null], depsFor(state))
}

// ---------------------------------------------------------------------------
// 1. Life Orb on a BOTH move: one maxHP/10 loss for two hit targets.
// ---------------------------------------------------------------------------
describe('(1) Life Orb fires once for a BOTH move', () => {
  it('Hyper Voice (61 per foe with the Life Orb boost) costs the holder one maxHP/10 = 99', () => {
    // Per pass: acc(0), crit(1 -> 1 % 16 != 0), roll(0 -> max 63 -> 47 -> x1.3 = 61, :7651-7653).
    // MOVEEND_SUM_DAMAGE keeps 61 + 61 = 122 in savedDmg (:4335); case 26 does not read savedDmg but
    // damagedMons, set by both passes (:1691), and deals floor(999 / 10) = 99 ONCE (:6105-6106).
    const rng = scriptedRng([0, 1, 0, 0, 1, 0])
    const state = battle(
      [attacker0('MOVE_HYPER_VOICE', { itemId: 'ITEM_LIFE_ORB' }), idle(96), idle(95), idle(94)],
      rng,
    )
    const action = runMove(state, 'MOVE_HYPER_VOICE').actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.targetDamage)).toEqual([61, 61])
    expect(state.battlers[1]!.mon.hp).toBe(999 - 61)
    expect(state.battlers[3]!.mon.hp).toBe(999 - 61)
    // One 10% loss, not two: the attacker is on 900, never 801.
    expect(state.battlers[0]!.mon.hp).toBe(900)
    expect(action.attackerDamage).toBe(99)
    expect(rng.calls).toBe(6) // accuracy, crit, roll per pass; no Life Orb draw
  })
})

// ---------------------------------------------------------------------------
// 2. Life Orb on a FOES_AND_ALLY move hitting foe, ally and foe.
// ---------------------------------------------------------------------------
describe('(2) Life Orb fires once for FOES_AND_ALLY', () => {
  it('Earthquake (221 x3 with the Life Orb boost, ally included) costs one 99', () => {
    // HandleAction_UseMove starts on battler 1 (battle_util.c:283-289); :4794-4798 scans 2 then 3 and
    // the off-the-end scan yields gBattlersCount (dead). damagedMons is set on three passes, yet
    // MOVEEND_LIFEORB_SHELLBELL runs only in the tail (:4823-4827). 170 x1.3 (:7651-7653) = 221.
    const rng = scriptedRng([0, 1, 0, 0, 1, 0, 0, 1, 0])
    const state = battle(
      [attacker0('MOVE_EARTHQUAKE', { itemId: 'ITEM_LIFE_ORB' }), idle(96), idle(95), idle(94)],
      rng,
    )
    const action = runMove(state, 'MOVE_EARTHQUAKE').actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.targetId)).toEqual([1, 2, 3])
    expect(action.targets!.map((t) => t.targetDamage)).toEqual([221, 221, 221])
    expect(state.battlers[0]!.mon.hp).toBe(900) // one Life Orb loss
    expect(action.attackerDamage).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// 3. Recoil on a spread move: the summed damage, once.
// ---------------------------------------------------------------------------
describe('(3) recoil uses the summed savedDmg once', () => {
  it('Boomburst (69 x3) pays one max(1, floor(207 / 2)) = 103', () => {
    // EFFECT_RECOIL_50 -> recoilFraction 2 (moveBehaviors.json). savedDmg = 69 + 69 + 69 = 207
    // (:4335), and case 23 reads it once, after the last pass (:4457-4475).
    const rng = scriptedRng([0, 1, 0, 0, 1, 0, 0, 1, 0])
    const state = battle([attacker0('MOVE_BOOMBURST'), idle(96), idle(95), idle(94)], rng)
    const action = runMove(state, 'MOVE_BOOMBURST').actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.targetDamage)).toEqual([69, 69, 69])
    expect(state.battlers[0]!.mon.hp).toBe(999 - 103) // one recoil, not 34+34+34 or 103 x3
    expect(action.attackerDamage).toBe(103)
  })

  it('a protected FINAL pass suppresses that recoil (MOVE_RESULT_MISSED is NO_EFFECT)', () => {
    // MoveValuesCleanUp only runs before a re-entry (:4810), so the flags case 23 reads are the last
    // pass's. A blocked pass sets MOVE_RESULT_MISSED (battle_script_commands.c:1204), which is part of
    // MOVE_RESULT_NO_EFFECT (battle.h:389), so :4462's REQUIRE_NOT skips recoil even though savedDmg is
    // 138. The tail itself still runs (CLEAR_BITS), so savedDmg ends at 0.
    const rng = scriptedRng([0, 1, 0, 0, 1, 0])
    const state = battle([attacker0('MOVE_BOOMBURST'), idle(96), idle(95), idle(94)], rng)
    state.battlers[3]!.round.protectMove = 'MOVE_DETECT' // third pass blocked; no accuracy draw
    const action = runMove(state, 'MOVE_BOOMBURST').actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.missed)).toEqual([false, false, true])
    expect(state.battlers[0]!.mon.hp).toBe(999)
    expect(action.attackerDamage).toBeNull()
    expect(state.battlers[0]!.turn.savedDmg).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Shell Bell heals savedDmg / 4 once.
// ---------------------------------------------------------------------------
describe('(4) Shell Bell heals the summed damage once', () => {
  it('Hyper Voice (47 x2 = 94) heals floor(94 / 4) = 23', () => {
    // battle_util.c:6070-6081: REQUIRE(savedDmg), not max HP, heal = savedDmg / 4 (min 1). The tail's
    // savedDmg is the sum, so a per-pass port would have healed floor(47/4) = 11 twice.
    const rng = scriptedRng([0, 1, 0, 0, 1, 0])
    const state = battle(
      [attacker0('MOVE_HYPER_VOICE', { itemId: 'ITEM_SHELL_BELL', hp: 500, maxHp: 999 }), idle(96), idle(95), idle(94)],
      rng,
    )
    runMove(state, 'MOVE_HYPER_VOICE')
    expect(state.battlers[0]!.mon.hp).toBe(500 + 23)
  })
})

// ---------------------------------------------------------------------------
// 5. Negatives: only one pass damages / the cycle42 dead-target case.
// ---------------------------------------------------------------------------
describe('(5) one damaging pass still fires the tail', () => {
  it('Life Orb is still paid once when the second BOTH target is dead', () => {
    // :4815-4817 ends the loop before the second script push; the tail still runs on the first pass's
    // savedDmg. Pass 1 draws acc, crit, roll (Hyper Voice has no secondary roll).
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      [attacker0('MOVE_HYPER_VOICE', { itemId: 'ITEM_LIFE_ORB' }), idle(96), idle(95), { ...idle(94), hp: 0 }],
      rng,
    )
    const action = runMove(state, 'MOVE_HYPER_VOICE').actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.targetId)).toEqual([1])
    expect(state.battlers[0]!.mon.hp).toBe(900) // one Life Orb loss
    expect(action.attackerDamage).toBe(99)
  })

  it('Life Orb is still paid once when the second BOTH target is immune', () => {
    // Normal vs Ghost is 0x: the resolver reports targetDamage 0 and draws no crit/roll (damageResolver.ts:290),
    // so pass 2 consumes only its accuracy draw. damagedMons is set by pass 1 alone.
    const rng = scriptedRng([0, 1, 0, 0])
    const state = battle(
      [
        attacker0('MOVE_HYPER_VOICE', { itemId: 'ITEM_LIFE_ORB' }),
        idle(96),
        idle(95),
        idle(94, { types: ['GHOST', 'MYSTERY', 'MYSTERY'] }),
      ],
      rng,
    )
    const action = runMove(state, 'MOVE_HYPER_VOICE').actions.find((a) => a.battlerId === 0)!

    expect(action.targets!.map((t) => t.targetDamage)).toEqual([61, 0])
    expect(state.battlers[3]!.mon.hp).toBe(999)
    expect(state.battlers[0]!.mon.hp).toBe(900)
    expect(action.attackerDamage).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// 6. Non-spread moves keep their pre-change numbers: one Life Orb.
// ---------------------------------------------------------------------------
describe('(6) non-spread moves are unchanged', () => {
  it('a SELECTED move in a double pays one Life Orb', () => {
    // Tackle 40 physical: floor(42*40*296/166) = 2995 -> 59 -> 61; x1.3 (:7651-7653) = 79;
    // one MAXHP/10 = 99.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(
      [attacker0('MOVE_TACKLE', { itemId: 'ITEM_LIFE_ORB' }), idle(96), idle(95), idle(94)],
      rng,
    )
    const action = runMove(state, 'MOVE_TACKLE').actions.find((a) => a.battlerId === 0)!

    expect(action.targets).toBeUndefined()
    expect(action.targetDamage).toBe(79)
    expect(state.battlers[0]!.mon.hp).toBe(900)
    expect(action.attackerDamage).toBe(99)
  })

  it('any move in a single battle pays one Life Orb', () => {
    const rng = scriptedRng([0, 1, 0])
    const state = battle([attacker0('MOVE_TACKLE', { itemId: 'ITEM_LIFE_ORB' }), idle(96)], rng, 0)
    const action = runMove(state, 'MOVE_TACKLE').actions.find((a) => a.battlerId === 0)!

    expect(action.targetDamage).toBe(79)
    expect(state.battlers[0]!.mon.hp).toBe(900)
    expect(action.attackerDamage).toBe(99)
  })

  it('a multi-hit move pays one Life Orb (the existing FIRST/SECOND split)', () => {
    // Double Hit, two 45-power hits: 69 each, x1.3 (:7651-7653) = 90. Draw order: acc(0), crit(1),
    // roll(0), then the MOVEEND_MULTIHIT_MOVE crit roll (1); hit 2 reuses it, draws its damage roll
    // (0), then the trailing crit roll (1) and the counter reaches 0 (:4880-4921).
    const rng = scriptedRng([0, 1, 0, 1, 0, 1])
    const state = battle(
      [attacker0('MOVE_DOUBLE_HIT', { itemId: 'ITEM_LIFE_ORB' }), idle(96), idle(95), idle(94)],
      rng,
    )
    const action = runMove(state, 'MOVE_DOUBLE_HIT').actions.find((a) => a.battlerId === 0)!

    expect(action.targetDamage).toBe(180)
    expect(state.battlers[1]!.mon.hp).toBe(999 - 180)
    expect(state.battlers[0]!.mon.hp).toBe(900)
    expect(action.attackerDamage).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// 7. Case 20 runs on EVERY pass, not in the tail.
// ---------------------------------------------------------------------------
describe('(7) MOVEEND_MOVE_EFFECTS2_ON_EACH stays per pass', () => {
  it('Sparkling Aria clears both foes\' burn, pass by pass', () => {
    // case 20 (:4573-4632) reads and clears gBattleStruct->moveEffect2 at :4576-4577, so the
    // MOVE_EFFECT_REMOVE_STATUS set by EFFECT_SPARKLING_ARIA is consumed once per target. A tail-only
    // case 20 would leave the first foe burnt. 50 damage x3; no secondary draw (CERTAIN, moveEffects.ts:12135-12143).
    const rng = scriptedRng([0, 1, 0, 0, 1, 0, 0, 1, 0])
    const state = battle(
      [
        attacker0('MOVE_SPARKLING_ARIA'),
        idle(96, { status1: STATUS1_BURN }),
        idle(95, { status1: STATUS1_BURN }),
        idle(94, { status1: STATUS1_BURN }),
      ],
      rng,
    )
    runMove(state, 'MOVE_SPARKLING_ARIA')

    expect([1, 2, 3].map((id) => state.battlers[id]!.mon.hp)).toEqual([949, 949, 949])
    expect([1, 2, 3].map((id) => state.battlers[id]!.mon.status1)).toEqual([0, 0, 0])
  })
})

// ---------------------------------------------------------------------------
// 8. CLEAR_BITS runs once at the end and does not leak into the next action.
// ---------------------------------------------------------------------------
describe('(8) savedDmg is cleared in the tail', () => {
  it('is zero after a spread action and a second action pays its own recoil only', () => {
    // :4950-4951 clears savedDmg and damagedMons in MOVEEND_CLEAR_BITS, once, after the last pass.
    // Two Boombursts therefore cost 103 each (999 - 206), never 103 then 310.
    const state = battle([attacker0('MOVE_BOOMBURST'), idle(96), idle(95), idle(94)], scriptedRng([0, 1, 0, 0, 1, 0, 0, 1, 0]))
    runMove(state, 'MOVE_BOOMBURST')
    expect(state.battlers[0]!.mon.hp).toBe(999 - 103)
    expect(state.battlers[0]!.turn.savedDmg).toBe(0)

    state.rng = scriptedRng([0, 1, 0, 0, 1, 0, 0, 1, 0])
    runMove(state, 'MOVE_BOOMBURST')
    expect(state.battlers[0]!.mon.hp).toBe(999 - 206)
    expect(state.battlers[0]!.turn.savedDmg).toBe(0)
    expect([1, 2, 3].map((id) => state.battlers[id]!.mon.hp)).toEqual([861, 861, 861])
  })
})
