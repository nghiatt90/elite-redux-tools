/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 127: the thirteen protection / counter move effects from Endure to Magic Coat. Every number
// below is derived by hand from the pinned C: the script line in data/battle_scripts_1.s and the
// command in src/battle_script_commands.c are cited on the assertion they justify. Stat stages run
// 0..12 with neutral at 6, so a +1 Defense is 6 -> 7.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { DEFAULT_STAT_STAGE, MIN_STAT_STAGE, STAT_ACC, STAT_ATK, STAT_DEF, STAT_SPATK, STATUS1_PARALYSIS, STATUS3_GRUDGE, hasFlag } from './constants'
import { findAllowance } from './driver/auditAllowlist'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const RATIOS = simData.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

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

/** Every draw is 0 (accuracy always hits); `calls` counts draws. */
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

/** Draw the scripted values in order; 0 once the script runs out. `calls` counts draws. */
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

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
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

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(simData, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
  }
}

/** The fixed-damage scripts overwrite the resolver's answer only when it is NON-ZERO (turn.ts:3130),
 * so `0` models a type-immune target and any positive number models a connected hit. */
const fixedDamage = (dmg: number, extra: { isSuperEffective?: boolean } = {}): DamageResolver => ({
  resolve: () => ({
    targetDamage: dmg,
    attackerDamage: null,
    unmodelled: [],
    isCriticalHit: false,
    berryReduced: false,
    isSuperEffective: extra.isSuperEffective ?? false,
  }),
})

const THIS_FILE = 'web/src/engine/sim/cycle127ProtectionEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const ppOf = (state: BattleState, battlerId = 0) => state.battlers[battlerId]!.mon.pp[0]

const FAST = { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 } }

/** Puts battler 0's accuracy stage at its floor, so a 100%-accuracy move becomes 33% (Cmd_accuracycheck
 * reads the stage through AccuracyStatTable). createBattlerState starts neutral. */
function atAccuracyFloor(state: BattleState): BattleState {
  state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE
  return state
}

// BattleScript_EffectEndure data/battle_scripts_1.s:5035-5045 -> Cmd_setprotectlike
// (src/battle_script_commands.c:9161-9206) and ProtectSucceeds (:6649-6655):
// `sProtectSuccessRates[] = {USHRT_MAX, USHRT_MAX/2, USHRT_MAX/4, USHRT_MAX/8}` (:727) is compared
// against the whole 16-bit Random(). Endure does not protect the user: it sets
// gRoundStructs[user].endured (:9171), which Cmd_adjustdamage (:1666-1676) turns into "damage =
// hp - 1". A failed use zeroes protectUses (:9200) and sets MOVE_RESULT_MISSED.
describe('cycle 127 - Endure (EFFECT_ENDURE)', () => {
  const endureUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      ...FAST,
      moves: ['MOVE_ENDURE', null, null, null],
      pp: [5, 0, 0, 0],
      ...overrides,
    })
  const tackler = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
      ...overrides,
    })

  it('first use always succeeds (65535 >= any Random()) and leaves a lethal hit at 1 HP', () => {
    // Draws: Endure's ProtectSucceeds roll (0), then Tackle's accuracy roll (0).
    const rng = scriptedRng([0, 0])
    const state = battle(endureUser(), tackler(), rng)
    const out = executeTurn(state, [useMove(0, 'MOVE_ENDURE'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(150)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.volatiles.protectUses).toBe(1) // :9176
    expect(ppOf(state)).toBe(4) // ppreduce s:5039
    expect(actionOf(out, 1)?.targetDamage).toBe(99) // Cmd_adjustdamage: hp - 1 (:1666-1676)
    expect(state.battlers[0]!.mon.hp).toBe(1)
    expect(rng.calls).toBe(2)
  })

  it('second consecutive use fails when the 1/2 rate misses: 32767 < 32768', () => {
    // Turn 1 sets protectUses = 1; on turn 2 ProtectSucceeds reads rates[1] = USHRT_MAX/2 = 32767.
    // One rng serves both turns: draw 1 is turn 1's guaranteed success, draw 2 is turn 2's 32768.
    const rng = scriptedRng([0, 32768])
    const state = battle(endureUser(), tackler(), rng)
    executeTurn(state, [useMove(0, 'MOVE_ENDURE'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.volatiles.protectUses).toBe(1)
    expect(ppOf(state)).toBe(4)

    const out = executeTurn(state, [useMove(0, 'MOVE_ENDURE'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true) // MOVE_RESULT_MISSED (:9202)
    expect(state.battlers[0]!.volatiles.protectUses).toBe(0) // :9200
    expect(ppOf(state)).toBe(3) // ppreduce still runs
    expect(rng.calls).toBe(2) // exactly one ProtectSucceeds draw per use
  })

  it('succeeds again on the 1/2 rate when the roll is at or below 32767', () => {
    // One rng for both turns: draw 1 is turn 1's guaranteed success, draw 2 is turn 2's 32767.
    const state = battle(endureUser(), tackler(), scriptedRng([0, 32767]))
    executeTurn(state, [useMove(0, 'MOVE_ENDURE'), null], loopDeps(state, fixedDamage(0)))
    const out = executeTurn(state, [useMove(0, 'MOVE_ENDURE'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false) // 32767 >= 32767
    expect(state.battlers[0]!.volatiles.protectUses).toBe(2)
  })

  it('fails when the user moves last, and still draws the ProtectSucceeds roll', () => {
    // Endure is priority +4, so the only way it moves last here is a faster-priority foe. Helping Hand
    // is priority +5: :9165 sets notLastTurn FALSE. The C's `ProtectSucceeds(attacker) && notLastTurn`
    // evaluates the draw first, so the wasted Random() is consumed before the turn-order test.
    const rng = scriptedRng([0, 0])
    const state = battle(
      endureUser(),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_HELPING_HAND', null, null, null], pp: [20, 0, 0, 0] }),
      rng,
    )
    const out = executeTurn(state, [useMove(0, 'MOVE_ENDURE'), useMove(1, 'MOVE_HELPING_HAND')], loopDeps(state, fixedDamage(150)))
    const endure = actionOf(out, 0)!
    expect(endure.turnOrderIndex).toBe(1)
    expect(endure.missed).toBe(true)
    expect(state.battlers[0]!.volatiles.protectUses).toBe(0)
    expect(ppOf(state)).toBe(4)
    expect(rng.calls).toBe(1) // only Endure's roll; Helping Hand draws nothing
    expect(state.battlers[0]!.mon.hp).toBe(100) // round.endured was never set (:9171)
  })
})

// BattleScript_EffectHelpingHand data/battle_scripts_1.s:6268-6276 -> Cmd_trysethelpinghand
// (src/battle_script_commands.c:11700-11710): the success branch requires
// `gBattleTypeFlags & BATTLE_TYPE_DOUBLE`, a non-absent partner and neither mon already helped.
// Singles can never satisfy the type test, so the move always fails after ppreduce (:6271).
describe('cycle 127 - Helping Hand (EFFECT_HELPING_HAND, doubles-only)', () => {
  it('always fails in singles: no partner, PP 20 -> 19, no draw, no state written', () => {
    const rng = countRng()
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        ...FAST,
        moves: ['MOVE_HELPING_HAND', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP'),
      rng,
    )
    const out = executeTurn(state, [useMove(0, 'MOVE_HELPING_HAND'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true) // BattleScript_ButItFailed
    expect(ppOf(state)).toBe(19) // ppreduce :6271 runs before the check
    expect(state.battlers[0]!.round.helpingHand).toBe(false)
    expect(state.battlers[1]!.round.helpingHand).toBe(false)
    expect(state.battlers[0]!.volatiles.protectUses).toBe(0)
    expect(rng.calls).toBe(0) // the script has no accuracycheck
  })
})

// BattleScript_EffectCounter data/battle_scripts_1.s:4661-4671 ->
// Cmd_counterdamagecalculator (src/battle_script_commands.c:10663-10682): damage is
// `gRoundStructs[attacker].physicalDmg * 2` only when that damage is nonzero, came from the OTHER
// side, and that side's mon is still alive; otherwise the whole move jumps to
// BattleScript_ButItFailedAtkStringPpReduce BEFORE the accuracy check. The script then runs
// typecalc (which clears SE/NVE, so the type chart does not scale the doubled number) and
// adjustdamage (Endure / Focus Sash clamp).
describe('cycle 127 - Counter (EFFECT_COUNTER)', () => {
  const counterUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      moves: ['MOVE_COUNTER', null, null, null],
      pp: [20, 0, 0, 0],
      ...overrides,
    })
  const tackler = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      ...FAST,
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
      ...overrides,
    })

  it('a 40-damage physical hit received this turn is doubled to 80', () => {
    // Counter is priority -5, so the foe's priority-0 Tackle always resolves first and writes
    // physicalDmg = 40 on the Counter user; Counter then deals 40 * 2 = 80 (:10668).
    const rng = countRng()
    const state = battle(counterUser({ hp: 200, maxHp: 200 }), tackler({ hp: 200, maxHp: 200 }), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_COUNTER'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[0]!.mon.hp).toBe(160) // 200 - 40
    expect(actionOf(out, 0)?.targetDamage).toBe(80) // :10668
    expect(state.battlers[1]!.mon.hp).toBe(120) // 200 - 80
    expect(ppOf(state)).toBe(19) // ppreduce :4666
    expect(rng.calls).toBe(2) // Tackle accuracy then Counter's ACC_CURR_MOVE (:4664)
  })

  it('with no hit received it fails before the accuracy check: PP 20 -> 19, no draw', () => {
    const rng = countRng()
    const state = battle(counterUser(), tackler(), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_COUNTER'), null], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 0)?.missed).toBe(true) // BattleScript_ButItFailedAtkStringPpReduce (:10677)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })

  it('a special hit received does not qualify: physicalDmg stays 0, the move fails', () => {
    const rng = countRng()
    const state = battle(
      counterUser({ hp: 200, maxHp: 200 }),
      tackler({ hp: 200, maxHp: 200, moves: ['MOVE_DRAGON_PULSE', null, null, null], pp: [10, 0, 0, 0] }),
      rng,
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_COUNTER'), useMove(0, 'MOVE_DRAGON_PULSE')], loopDeps(state, fixedDamage(40)))
    // physicalDmg is the field the C's counterdamagecalculator reads (:10666); the round structs are
    // zeroed at end of turn, so the observable is that Counter's slot stayed at 0 and the move failed.
    expect(actionOf(out, 0)?.targetDamage).toBeNull()
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(200)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(1) // only the foe's Dragon Pulse accuracy roll
  })

  it('2D larger than the target HP leaves it at 0 HP (the C never clamps, hp floors at 0)', () => {
    const state = battle(counterUser({ hp: 200, maxHp: 200 }), tackler({ hp: 50, maxHp: 50 }), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_COUNTER'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 0)?.targetDamage).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(actionOf(out, 0)?.fainted).toEqual([1])
  })

  it('clears MOVE_RESULT_SUPER_EFFECTIVE / NOT_VERY_EFFECTIVE after typecalc, so Weakness Policy stays put', () => {
    // BattleScript_EffectCounter (:4667-4668) runs typecalc and then
    // `bichalfword gMoveResultFlags, MOVE_RESULT_NOT_VERY_EFFECTIVE | MOVE_RESULT_SUPER_EFFECTIVE`:
    // the doubled number is never scaled by the chart, and the effectiveness flags the move-end item
    // pass reads are neutral. The ITEMEFFECT_TARGET Weakness Policy check (battle_util.c:6172) therefore
    // does not fire even though the resolver answered "super effective".
    const state = battle(
      counterUser({ hp: 200, maxHp: 200 }),
      tackler({ hp: 200, maxHp: 200, itemId: 'ITEM_WEAKNESS_POLICY' }),
      countRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, 'MOVE_COUNTER'), useMove(0, 'MOVE_TACKLE')],
      loopDeps(state, fixedDamage(40, { isSuperEffective: true })),
    )
    expect(actionOf(out, 0)?.targetDamage).toBe(80)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_WEAKNESS_POLICY')
  })
})

// BattleScript_EffectMirrorCoat data/battle_scripts_1.s:5655-5664 ->
// Cmd_mirrorcoatdamagecalculator (src/battle_script_commands.c:10684-10703): the same command
// with `specialDmg` / `specialBattlerId` instead of the physical pair.
describe('cycle 127 - Mirror Coat (EFFECT_MIRROR_COAT)', () => {
  const coatUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      moves: ['MOVE_MIRROR_COAT', null, null, null],
      pp: [20, 0, 0, 0],
      ...overrides,
    })
  const specialAttacker = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      ...FAST,
      moves: ['MOVE_DRAGON_PULSE', null, null, null],
      pp: [10, 0, 0, 0],
      ...overrides,
    })

  it('a 40-damage special hit received this turn is doubled to 80', () => {
    const rng = countRng()
    const state = battle(coatUser({ hp: 200, maxHp: 200 }), specialAttacker({ hp: 200, maxHp: 200 }), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_MIRROR_COAT'), useMove(0, 'MOVE_DRAGON_PULSE')], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 0)?.targetDamage).toBe(80) // :10690
    expect(state.battlers[1]!.mon.hp).toBe(120)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(2)
  })

  it('a physical hit received does not qualify: the move fails with no accuracy draw', () => {
    const rng = countRng()
    const state = battle(
      coatUser({ hp: 200, maxHp: 200 }),
      specialAttacker({ hp: 200, maxHp: 200, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      rng,
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_MIRROR_COAT'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    // Mirror Coat reads specialDmg, which stayed 0 because only a physical hit landed.
    expect(actionOf(out, 0)?.targetDamage).toBeNull()
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(200)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(1)
  })

  it('with no hit received it fails and costs PP but draws nothing', () => {
    const state = battle(coatUser(), specialAttacker(), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_MIRROR_COAT'), null], loopDeps(state, fixedDamage(40)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(19)
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })
})

// BattleScript_EffectFollowMe data/battle_scripts_1.s:6202-6212 -> Cmd_setforcedtarget
// (src/battle_script_commands.c:11612-11618): always writes followmeTimer = 1,
// followmeTarget = the user and followmePowder = FLAG_POWDER onto the USER's side timers. The only
// consumer, IsAffectedByFollowMe (src/battle_util.c:118-126, used at :263-265), needs a second
// target on the side to change anything, so singles only sees the state.
describe('cycle 127 - Follow Me / Rage Powder (EFFECT_FOLLOW_ME, doubles-only)', () => {
  it('writes the side timers on the user side and the end-of-turn cleanup zeroes the timer', () => {
    const rng = countRng()
    const state = battle(
      monFor('SPECIES_MUDKIP'),
      monFor('SPECIES_MUDKIP', { ...FAST, moves: ['MOVE_RAGE_POWDER', null, null, null], pp: [20, 0, 0, 0] }),
      rng,
    )
    const out = executeTurn(state, [null, useMove(1, 'MOVE_RAGE_POWDER')], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 1)?.missed).toBe(false)
    expect(state.sides[1].timers.followmeTarget).toBe(1) // :11615
    expect(state.sides[1].timers.followmePowder).toBe(true) // FLAG_POWDER (:11616)
    expect(state.sides[0].timers.followmeTarget).toBe(0) // only the user's own side
    expect(state.sides[1].timers.followmeTimer).toBe(0) // TurnValuesCleanUp, battle_main.c:4507-4508
    expect(ppOf(state, 1)).toBe(19) // ppreduce s:6205
    expect(rng.calls).toBe(0) // no accuracycheck in the script
  })

  it('Follow Me itself is not a powder move and does not redirect the single foe', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { ...FAST, moves: ['MOVE_FOLLOW_ME', null, null, null], pp: [20, 0, 0, 0] }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_TACKLE'), useMove(1, 'MOVE_FOLLOW_ME')], loopDeps(state, fixedDamage(10)))
    expect(actionOf(out, 1)?.missed).toBe(false)
    expect(state.sides[1].timers.followmeTarget).toBe(1) // :11615
    expect(state.sides[1].timers.followmePowder).toBe(false) // TestMoveFlags FLAG_POWDER
    expect(state.battlers[1]!.mon.hp).toBe(90) // the only foe is still the only target
  })
})

// BattleScript_EffectGrudge data/battle_scripts_1.s:6511-6520 -> Cmd_setuserstatus3
// (src/battle_script_commands.c:11991-12002), and the faint half of Cmd_tryfaintmon
// (:3252-3263): while the grudge holder is on the field and faints to an OPPOSING damaging move,
// the attacker's chosen move slot is zeroed. CANCELLER_FLAGS (battle_util.c:3205-3206) clears the
// bit at the start of the holder's next action, and ClearFuryCutterDestinyBondGrudge
// (battle_util.c:6307-6311) clears it on faint.
describe('cycle 127 - Grudge (EFFECT_GRUDGE)', () => {
  it('sets STATUS3_GRUDGE and costs one PP; CANCELLER_FLAGS lets a repeat use succeed', () => {
    const rng = countRng()
    const state = battle(
      monFor('SPECIES_MUDKIP', { ...FAST, moves: ['MOVE_GRUDGE', null, null, null], pp: [5, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP'),
      rng,
    )
    const out1 = executeTurn(state, [useMove(0, 'MOVE_GRUDGE'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out1, 0)?.missed).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GRUDGE)).toBe(true)
    expect(ppOf(state)).toBe(4) // ppreduce :6514
    expect(rng.calls).toBe(0) // no accuracycheck

    // CANCELLER_FLAGS (battle_util.c:3204-3206) clears STATUS3_GRUDGE at the start of the holder's
    // next action, so the second Grudge is not the "already grudging" fail branch: it re-sets the flag.
    const out2 = executeTurn(state, [useMove(0, 'MOVE_GRUDGE'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out2, 0)?.missed).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GRUDGE)).toBe(true)
    expect(ppOf(state)).toBe(3)
  })

  it('a foe that KOs the grudge holder has its own move PP zeroed', () => {
    // The holder acts first (speed 200 vs 100), the foe's Tackle then deals 150 to a 100 HP holder:
    // the faint branch runs with gCurrentMove = the foe's chosen move, so
    // moveIndex = chosenMovePositions (:3254) then pp[moveIndex] = 0 (:3256).
    const state = battle(
      monFor('SPECIES_MUDKIP', { ...FAST, moves: ['MOVE_GRUDGE', null, null, null], pp: [5, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      countRng(),
    )
    executeTurn(state, [useMove(0, 'MOVE_GRUDGE'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(150)))
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(ppOf(state, 1)).toBe(0) // :3256
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_GRUDGE)).toBe(false) // ClearFuryCutterDestinyBondGrudge
  })

  it('a non-lethal hit leaves the attacker PP alone (only the grudge holder fainting triggers it)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { ...FAST, moves: ['MOVE_GRUDGE', null, null, null], pp: [5, 0, 0, 0] }),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      countRng(),
    )
    executeTurn(state, [useMove(0, 'MOVE_GRUDGE'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    expect(state.battlers[0]!.mon.hp).toBe(60)
    expect(ppOf(state, 1)).toBe(34) // only its own ppreduce
  })
})

// BattleScript_EffectQuickGuard data/battle_scripts_1.s:12549-12558 ->
// VARIOUS_SET_QUICK_GUARD (src/battle_script_commands.c:8886-8894): sets a 3-turn side timer and
// refuses to stack. CANCELLER_QUICK_GUARD (battle_util.c:3272-3280) cancels an opposing move whose
// GetMovePriority is > 0 with BattleScript_ButItFailed and HITMARKER_NO_ATTACKSTRING (no PP).
// Quick Guard is priority +1 in moves.json, so it cannot be used in the same turn as the priority
// move it blocks; the test sets it on turn 1.
describe('cycle 127 - Quick Guard (EFFECT_QUICK_GUARD)', () => {
  const guardUser = () =>
    monFor('SPECIES_MUDKIP', { moves: ['MOVE_QUICK_GUARD', null, null, null], pp: [10, 0, 0, 0] })

  it('sets quickGuardTimer = 3 and blocks the next turn’s priority move at no PP cost', () => {
    const state = battle(
      guardUser(),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_QUICK_ATTACK', null, null, null], pp: [20, 0, 0, 0] }),
      countRng(),
    )
    const turn1 = executeTurn(state, [useMove(0, 'MOVE_QUICK_GUARD'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(turn1, 0)?.missed).toBe(false)
    expect(state.sides[0].timers.quickGuardTimer).toBe(3) // :8891
    expect(state.sides[0].timers.started.quickGuard).toBe(true) // :8892, so this turn does not tick it
    expect(ppOf(state)).toBe(9) // ppreduce :12552

    const turn2 = executeTurn(state, [null, useMove(0, 'MOVE_QUICK_ATTACK')], loopDeps(state, fixedDamage(40)))
    const attack = actionOf(turn2, 1)!
    expect(attack.cancelledBy).toBe('QUICK_GUARD')
    expect(attack.missed).toBe(false) // BattleScript_ButItFailed, not a miss
    expect(attack.targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(100) // no damage
    expect(ppOf(state, 1)).toBe(20) // BattleScript_ButItFailed has no ppreduce
  })

  it('does not block a priority-0 move', () => {
    const state = battle(
      guardUser(),
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }),
      countRng(),
    )
    executeTurn(state, [useMove(0, 'MOVE_QUICK_GUARD'), null], loopDeps(state, fixedDamage(0)))
    const turn2 = executeTurn(state, [null, useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(40)))
    expect(actionOf(turn2, 1)?.cancelledBy).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })

  it('fails while the timer is already running, and still pays PP', () => {
    const state = battle(guardUser(), monFor('SPECIES_MUDKIP'), countRng())
    state.sides[0].timers.quickGuardTimer = 2
    const out = executeTurn(state, [useMove(0, 'MOVE_QUICK_GUARD'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true) // BattleScript_ButItFailed
    expect(state.sides[0].timers.started.quickGuard).toBe(false) // the failed use never restarts it
    // 2 -> 1: ENDTURN_MISC_SIDE_TIMERS still ticks the pre-existing timer (battle_util.c:2305).
    expect(state.sides[0].timers.quickGuardTimer).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSnatch data/battle_scripts_1.s:6522-6533 -> Cmd_trysetsnatch
// (src/battle_script_commands.c:12063-12072): fails only when the user moves last, else sets
// gRoundStructs[user].stealMove. Cmd_attackcanceler (:1175-1182) hands the next FLAG_SNATCH_AFFECTED
// move to the snatcher through BattleScript_SnatchedMove (:8346-8355), whose snatchsetbattlers
// (:12372-12382) makes the snatcher the attacker (and, for a self-targeting move, also the target).
describe('cycle 127 - Snatch (EFFECT_SNATCH)', () => {
  const snatcher = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      ...FAST,
      moves: ['MOVE_SNATCH', null, null, null],
      pp: [10, 0, 0, 0],
      ...overrides,
    })
  const dancer = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0], ...overrides })

  it('steals a snatchable status move and applies it to the snatcher (Attack 6 -> 8)', () => {
    const rng = countRng()
    const state = battle(snatcher(), dancer(), rng)
    const out = executeTurn(state, [useMove(0, 'MOVE_SNATCH'), useMove(1, 'MOVE_SWORDS_DANCE')], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(9) // Snatch's own ppreduce s:6526
    expect(ppOf(state, 1)).toBe(19) // BattleScript_SnatchedMove ppreduce (:8348), once
    expect(state.battlers[0]!.round.stealMove).toBe(false) // consumed by the canceller (:1177)
    expect(rng.calls).toBe(0) // neither script has an accuracycheck
  })

  it('does not steal a move without FLAG_SNATCH_AFFECTED', () => {
    const state = battle(snatcher(), dancer({ moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }), countRng())
    const out = executeTurn(state, [useMove(0, 'MOVE_SNATCH'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(10)))
    expect(actionOf(out, 1)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.hp).toBe(90) // the Tackle landed on the snatcher
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  it('fails when the user moves last (a priority-5 Helping Hand acts first) and still pays PP', () => {
    const state = battle(
      snatcher(),
      dancer({ moves: ['MOVE_HELPING_HAND', null, null, null], pp: [20, 0, 0, 0] }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(0, 'MOVE_SNATCH'), useMove(1, 'MOVE_HELPING_HAND')], loopDeps(state, fixedDamage(0)))
    const snatch = actionOf(out, 0)!
    expect(snatch.turnOrderIndex).toBe(1) // Helping Hand priority 5 > Snatch priority 4
    expect(snatch.missed).toBe(true) // gCurrentTurnActionNumber == gBattlersCount - 1 (:12065)
    expect(ppOf(state)).toBe(9)
    expect(state.battlers[0]!.round.stealMove).toBe(false)
  })
})

// BattleScript_EffectSuperFang data/battle_scripts_1.s:4095-4104 ->
// Cmd_calculatesetdamage (src/battle_script_commands.c:10626-10659): baseDamage =
// target.hp / 2 (:10649), AdjustFixedDamageForParentalBond, then `if (!damage) damage = 1`
// (:10656-10657). The script clears MOVE_RESULT_SUPER_EFFECTIVE | NOT_VERY_EFFECTIVE after
// typecalc (:4101), so the chart never scales the number, but a 0x immunity still leaves
// MOVE_RESULT_DOESNT_AFFECT_FOE, and Cmd_datahpupdate skips the HP update for that flag.
describe('cycle 127 - Super Fang (EFFECT_SUPER_FANG)', () => {
  const fangUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      ...FAST,
      moves: ['MOVE_SUPER_FANG', null, null, null],
      pp: [10, 0, 0, 0],
      ...overrides,
    })

  it('halves the current HP with integer division: 101 -> 50', () => {
    const rng = countRng()
    const state = battle(fangUser(), monFor('SPECIES_MUDKIP', { hp: 101, maxHp: 101 }), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_SUPER_FANG'), null], loopDeps(state, fixedDamage(1)))
    expect(actionOf(out, 0)?.targetDamage).toBe(50) // trunc(101 / 2) (:10649)
    expect(state.battlers[1]!.mon.hp).toBe(51)
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(1) // ACC_CURR_MOVE accuracycheck (:4097)
  })

  it('a 1 HP target still takes the 1-damage failsafe', () => {
    const state = battle(fangUser(), monFor('SPECIES_MUDKIP', { hp: 1, maxHp: 101 }), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_SUPER_FANG'), null], loopDeps(state, fixedDamage(1)))
    expect(actionOf(out, 0)?.targetDamage).toBe(1) // max(1, trunc(1 / 2) = 0) (:10656-10657)
    expect(state.battlers[1]!.mon.hp).toBe(0)
  })

  it('a Ghost target is immune: the fixed amount never replaces the 0 the type chart returned', () => {
    const state = battle(fangUser(), monFor('SPECIES_GASTLY', { hp: 101, maxHp: 101 }), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_SUPER_FANG'), null], loopDeps(state, fixedDamage(0)))
    // Normal vs Ghost is 0x; Cmd_typecalc sets MOVE_RESULT_DOESNT_AFFECT_FOE and Cmd_datahpupdate
    // (:1871) does nothing for it. The sim keeps the resolver's 0 rather than the failsafe 1.
    expect(actionOf(out, 0)?.targetDamage).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(101)
  })

  it('a missed accuracy roll (99 >= 90) deals nothing and still costs PP', () => {
    const rng = scriptedRng([99])
    const state = battle(fangUser(), monFor('SPECIES_MUDKIP', { hp: 101, maxHp: 101 }), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_SUPER_FANG'), null], loopDeps(state, fixedDamage(1)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(101)
    expect(ppOf(state)).toBe(9) // BattleScript_PrintMoveMissed ppreduces
    expect(rng.calls).toBe(1)
  })
})

// BattleScript_EffectFinalGambit data/battle_scripts_1.s:1642-1688: `typecalc` ->
// `dmgtocurrattackerhp` (src/battle_script_commands.c:9381, DMG_CURR_ATTACKER_HP = the user's
// current HP) -> adjustdamage -> the hit -> a SECOND `dmgtocurrattackerhp` + healthbarupdate /
// datahpupdate BS_ATTACKER. Cmd_datahpupdate (:1871) refuses to apply damage while
// MOVE_RESULT_NO_EFFECT is set, which is what a 0x immunity sets in typecalc: the user only faints
// when the hit connected.
describe('cycle 127 - Final Gambit (EFFECT_FINAL_GAMBIT)', () => {
  const gambler = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      ...FAST,
      moves: ['MOVE_FINAL_GAMBIT', null, null, null],
      pp: [5, 0, 0, 0],
      hp: 37,
      maxHp: 100,
      ...overrides,
    })

  it('deals the user’s current HP and faints the user: 37 HP -> 37 damage, user at 0', () => {
    const rng = countRng()
    const state = battle(gambler(), monFor('SPECIES_MUDKIP', { hp: 200, maxHp: 200 }), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_FINAL_GAMBIT'), null], loopDeps(state, fixedDamage(5)))
    const act = actionOf(out, 0)!
    expect(act.targetDamage).toBe(37) // DMG_CURR_ATTACKER_HP (:9381)
    expect(state.battlers[1]!.mon.hp).toBe(163)
    expect(act.attackerDamage).toBe(37) // the second dmgtocurrattackerhp, applied to BS_ATTACKER
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(act.fainted).toContain(0)
    expect(ppOf(state)).toBe(4)
    expect(rng.calls).toBe(1)
  })

  it('an immune target takes nothing and the user survives (MOVE_RESULT_NO_EFFECT skips both datahpupdates)', () => {
    const state = battle(gambler(), monFor('SPECIES_GASTLY', { hp: 101, maxHp: 101 }), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_FINAL_GAMBIT'), null], loopDeps(state, fixedDamage(0)))
    const act = actionOf(out, 0)!
    expect(act.targetDamage).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(101)
    expect(act.attackerDamage).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(37)
    expect(act.fainted).not.toContain(0)
  })

  it('a miss costs PP and does not faint the user either', () => {
    // Final Gambit is 100% accurate, so the miss needs the accuracy stage at its floor: at -6 a
    // 100% move becomes 33% (AccuracyStatTable), and 99 >= 33 misses.
    const rng = scriptedRng([99])
    const state = atAccuracyFloor(battle(gambler(), monFor('SPECIES_MUDKIP', { hp: 200, maxHp: 200 }), rng))
    const out = executeTurn(state, [useMove(1, 'MOVE_FINAL_GAMBIT'), null], loopDeps(state, fixedDamage(5)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(37)
    expect(state.battlers[1]!.mon.hp).toBe(200)
    expect(ppOf(state)).toBe(4)
  })
})

// BattleScript_EffectEndeavor data/battle_scripts_1.s:6435-6445 ->
// Cmd_setdamagetohealthdifference (src/battle_script_commands.c:11857-11864): fails when
// target.hp <= attacker.hp, else damage = target.hp - attacker.hp. The script runs ppreduce
// (:6438) and the health-difference check BEFORE accuracycheck (:6441) and does NOT call
// AdjustFixedDamageForParentalBond, so parental bond never scales it.
describe('cycle 127 - Endeavor (EFFECT_ENDEAVOR)', () => {
  const endeavored = (user: Partial<SimBattleMon>, foe: Partial<SimBattleMon>) =>
    battle(
      monFor('SPECIES_MUDKIP', { ...FAST, moves: ['MOVE_ENDEAVOR', null, null, null], pp: [5, 0, 0, 0], ...user }),
      monFor('SPECIES_MUDKIP', { ...foe }),
      countRng(),
    )

  it('target 80 / user 30 -> 50 damage', () => {
    const state = endeavored({ hp: 30, maxHp: 100 }, { hp: 80, maxHp: 100 })
    const out = executeTurn(state, [useMove(1, 'MOVE_ENDEAVOR'), null], loopDeps(state, fixedDamage(1)))
    expect(actionOf(out, 0)?.targetDamage).toBe(50) // 80 - 30 (:11861)
    expect(state.battlers[1]!.mon.hp).toBe(30)
    expect(ppOf(state)).toBe(4)
  })

  it('equal HP fails before the accuracy check', () => {
    const state = endeavored({ hp: 80, maxHp: 100 }, { hp: 80, maxHp: 100 })
    const out = executeTurn(state, [useMove(1, 'MOVE_ENDEAVOR'), null], loopDeps(state, fixedDamage(1)))
    expect(actionOf(out, 0)?.missed).toBe(true) // target.hp <= attacker.hp (:11858)
    expect(state.battlers[1]!.mon.hp).toBe(80)
    expect(ppOf(state)).toBe(4) // BattleScript_ButItFailedAtkStringPpReduce
  })

  it('a lower-HP target fails too', () => {
    const state = endeavored({ hp: 80, maxHp: 100 }, { hp: 30, maxHp: 100 })
    const out = executeTurn(state, [useMove(1, 'MOVE_ENDEAVOR'), null], loopDeps(state, fixedDamage(1)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(30)
    expect(ppOf(state)).toBe(4)
  })
})

// BattleScript_EffectFlowerShield data/battle_scripts_1.s:1287-1320: ppreduce (:1290),
// selectfirstvalidtarget, then jumpiftype BS_TARGET, TYPE_GRASS over every valid target
// (:1292-1295) before BattleScript_ButItFailed. Cmd_selectfirstvalidtarget
// (src/battle_script_commands.c:11474-11481) skips the user only when the move's target lacks
// MOVE_TARGET_USER; MOVE_FLOWER_SHIELD is MOVE_TARGET_ALL_BATTLERS (include/constants/battle.h:497-501),
// which includes it. The loop (:1298-1320) runs `setstatchanger STAT_DEF, 1, FALSE` for each
// Grass-type battler (:1303), so +1 Defense on every Grass type on the field, the user included.
describe('cycle 127 - Flower Shield (EFFECT_FLOWER_SHIELD)', () => {
  const shieldUser = (speciesId: string, overrides: Partial<SimBattleMon> = {}) =>
    monFor(speciesId, { ...FAST, moves: ['MOVE_FLOWER_SHIELD', null, null, null], pp: [10, 0, 0, 0], ...overrides })

  it('a Grass user raises its own Defense +1 and leaves a non-Grass foe alone', () => {
    const rng = countRng()
    const state = battle(shieldUser('SPECIES_TREECKO'), monFor('SPECIES_MUDKIP'), rng)
    const out = executeTurn(state, [useMove(0, 'MOVE_FLOWER_SHIELD'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1) // setstatchanger :1303
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE) // jumpiftype :1300
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 0, stat: STAT_DEF, change: 1 }])
    expect(ppOf(state)).toBe(9) // ppreduce :1290
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('raises every Grass-type on the field, the foe included', () => {
    const state = battle(shieldUser('SPECIES_TREECKO'), monFor('SPECIES_TREECKO'), countRng())
    const out = executeTurn(state, [useMove(0, 'MOVE_FLOWER_SHIELD'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(actionOf(out, 0)?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: 1 },
      { battlerId: 1, stat: STAT_DEF, change: 1 },
    ])
  })

  it('fails with no Grass-type on the field (BattleScript_ButItFailed) but still pays PP', () => {
    const state = battle(shieldUser('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), countRng())
    const out = executeTurn(state, [useMove(0, 'MOVE_FLOWER_SHIELD'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true) // :1295
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectMagicCoat data/battle_scripts_1.s:6345-6355 -> Cmd_trysetmagiccoat
// (src/battle_script_commands.c:12052-12061): fails when the user moves last, else sets
// gRoundStructs[user].bounceMove. Cmd_attackcanceler (:1153-1173) reflects the next
// FLAG_MAGIC_COAT_AFFECTED move through BattleScript_MagicCoatBounce (:8325-8333), which ppreduces
// once (HITMARKER_NO_PPDEDUCT stops the reflected script from paying again) and calls
// setmagiccoattarget BS_ATTACKER (VARIOUS_SET_MAGIC_COAT_TARGET, :6933-6940) so the reflection is
// aimed back at the original attacker.
describe('cycle 127 - Magic Coat (EFFECT_MAGIC_COAT)', () => {
  // Speed 50 keeps the coat user clearly below the 200-Speed caster even after it is paralysed,
  // so the end-of-turn SortBattlersBySpeed (battle_util.c:4329-4347) sees no tie and draws nothing.
  const coatUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 },
      moves: ['MOVE_MAGIC_COAT', null, null, null],
      pp: [15, 0, 0, 0],
      ...overrides,
    })
  const waver = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { ...FAST, moves: ['MOVE_THUNDER_WAVE', null, null, null], pp: [20, 0, 0, 0], ...overrides })

  it('bounces Thunder Wave back onto the original attacker', () => {
    // Magic Coat is priority +4, so it is armed before the priority-0 Thunder Wave resolves.
    const rng = countRng()
    const state = battle(coatUser(), waver(), rng)
    const out = executeTurn(state, [useMove(0, 'MOVE_MAGIC_COAT'), useMove(0, 'MOVE_THUNDER_WAVE')], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.round.bounceMove).toBe(false) // consumed (:1155)
    expect(state.battlers[0]!.mon.status1).toBe(0) // the coat user is untouched
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS) // reflected onto the caster
    expect(ppOf(state)).toBe(14) // Magic Coat's own ppreduce
    expect(ppOf(state, 1)).toBe(19) // BattleScript_MagicCoatBounce's single ppreduce
    expect(rng.calls).toBe(1) // the reflected Thunder Wave's ACC_CURR_MOVE draw
  })

  it('does not bounce a status move without FLAG_MAGIC_COAT_AFFECTED (Swords Dance)', () => {
    const state = battle(coatUser(), waver({ moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0] }), countRng())
    const out = executeTurn(state, [useMove(0, 'MOVE_MAGIC_COAT'), useMove(1, 'MOVE_SWORDS_DANCE')], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 1)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2) // the foe's own boost
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state, 1)).toBe(19)
  })

  it('fails when it moves last, so nothing is armed and PP is still spent', () => {
    // Magic Coat is priority +4; a priority-5 Helping Hand leaves it last in the turn, which is the
    // same condition as gCurrentTurnActionNumber == gBattlersCount - 1 (:12054).
    const state = battle(coatUser(), waver({ moves: ['MOVE_HELPING_HAND', null, null, null] }), countRng())
    const out = executeTurn(state, [useMove(0, 'MOVE_MAGIC_COAT'), useMove(1, 'MOVE_HELPING_HAND')], loopDeps(state, fixedDamage(0)))
    const coat = actionOf(out, 0)!
    expect(coat.turnOrderIndex).toBe(1)
    expect(coat.missed).toBe(true)
    expect(state.battlers[0]!.round.bounceMove).toBe(false)
    expect(ppOf(state)).toBe(14)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_ENDURE',
  'EFFECT_COUNTER',
  'EFFECT_MIRROR_COAT',
  'EFFECT_QUICK_GUARD',
  'EFFECT_GRUDGE',
  'EFFECT_SNATCH',
  'EFFECT_SUPER_FANG',
  'EFFECT_FINAL_GAMBIT',
  'EFFECT_ENDEAVOR',
  'EFFECT_FLOWER_SHIELD',
  'EFFECT_MAGIC_COAT',
]

/** Doubles-only: the C never makes them observable in a singles battle (see the block comments). */
const DOUBLES_ONLY_EFFECTS = ['EFFECT_HELPING_HAND', 'EFFECT_FOLLOW_ME']

describe('cycle 127 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('every doubles-only effect is allowlisted with a C citation and is not also claimed as verified', () => {
    for (const effect of DOUBLES_ONLY_EFFECTS) {
      const allowance = findAllowance(effect)
      expect(allowance?.reason).toBe('doubles-only, D1')
      expect(allowance?.citation).toMatch(/\.(c|h|s):\d+/)
      expect(VERIFIED_MOVE_EFFECTS.has(effect)).toBe(false)
    }
  })

  it.each([
    ['MOVE_ENDURE', 'EFFECT_ENDURE'],
    ['MOVE_HELPING_HAND', 'EFFECT_HELPING_HAND'],
    ['MOVE_COUNTER', 'EFFECT_COUNTER'],
    ['MOVE_MIRROR_COAT', 'EFFECT_MIRROR_COAT'],
    ['MOVE_FOLLOW_ME', 'EFFECT_FOLLOW_ME'],
    ['MOVE_RAGE_POWDER', 'EFFECT_FOLLOW_ME'],
    ['MOVE_SPOTLIGHT', 'EFFECT_FOLLOW_ME'],
    ['MOVE_GRUDGE', 'EFFECT_GRUDGE'],
    ['MOVE_QUICK_GUARD', 'EFFECT_QUICK_GUARD'],
    ['MOVE_SNATCH', 'EFFECT_SNATCH'],
    ['MOVE_SUPER_FANG', 'EFFECT_SUPER_FANG'],
    ['MOVE_FINAL_GAMBIT', 'EFFECT_FINAL_GAMBIT'],
    ['MOVE_ENDEAVOR', 'EFFECT_ENDEAVOR'],
    ['MOVE_FLOWER_SHIELD', 'EFFECT_FLOWER_SHIELD'],
    ['MOVE_MAGIC_COAT', 'EFFECT_MAGIC_COAT'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
