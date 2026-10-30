/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 115: whitelist status effects (first 12 of 14). Each effect is read against the C
// (data/battle_scripts_1.s, src/battle_script_commands.c) and proven by a forced scenario whose
// numbers are derived by hand. Stat stages run 0..12 here (neutral 6), so "-6" in the C's own
// frame is stage 0 (MIN_STAT_STAGE).
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  STAT_ACC,
  STAT_ATK,
  STAT_SPATK,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_TOXIC_POISON,
  STATUS2_SUBSTITUTE,
  STATUS3_HEAL_BLOCK,
  hasFlag,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
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

/** The first draw is 99 (`99 % 100 >= accuracy` misses any accuracy below 100), the rest 0. */
function missRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => (rng.calls++ === 0 ? 99 : 0),
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

const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

const THIS_FILE = 'web/src/engine/sim/cycle115StatusEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect

/** The user (battler 0, Mudkip) knows only `moveId` with 10 PP. */
const user = (moveId: string, overrides: Partial<SimBattleMon> = {}) =>
  monFor('SPECIES_MUDKIP', { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 150 }, moves: [moveId, null, null, null], pp: [10, 0, 0, 0], ...overrides })
const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

/** One turn: the user (battler 0) uses `moveId` on battler 1, the foe does nothing. */
function runVs(state: BattleState, moveId: string, replacement?: ReplacementDeps): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedDamage(0), replacement))
}
/** One turn: the user uses `moveId` on itself. */
function runSelf(state: BattleState, moveId: string, replacement?: ReplacementDeps): TurnOutcome {
  return executeTurn(state, [useMove(0, moveId), null], loopDeps(state, fixedDamage(0), replacement))
}
/**
 * The user acts first (faster), then the foe Tackles; `snap` runs when the foe's Tackle resolves,
 * i.e. after the user's move and before any end-of-turn timer ticks.
 */
function runSnap<T>(state: BattleState, moveId: string, snap: () => T): T {
  let seen: T | undefined
  const damage: DamageResolver = {
    resolve: () => {
      seen = snap()
      return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
    },
  }
  executeTurn(state, [useMove(1, moveId), useMove(0, 'MOVE_TACKLE')], loopDeps(state, damage))
  return seen as T
}
const FAST = { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 } }

const ppOf = (state: BattleState) => state.battlers[0]!.mon.pp[0]
const foeOf = (state: BattleState) => state.battlers[1]!

describe('cycle 115 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_TOXIC', 'EFFECT_TOXIC'],
    ['MOVE_WILL_O_WISP', 'EFFECT_WILL_O_WISP'],
    ['MOVE_THUNDER_WAVE', 'EFFECT_PARALYZE'],
    ['MOVE_ENCORE', 'EFFECT_ENCORE'],
    ['MOVE_TAUNT', 'EFFECT_TAUNT'],
    ['MOVE_BATON_PASS', 'EFFECT_BATON_PASS'],
    ['MOVE_PARTING_SHOT', 'EFFECT_PARTING_SHOT'],
    ['MOVE_MILK_DRINK', 'EFFECT_SOFTBOILED'],
    ['MOVE_SOFT_BOILED', 'EFFECT_SOFTBOILED'],
    ['MOVE_STEALTH_ROCK', 'EFFECT_STEALTH_ROCK'],
    ['MOVE_CREEPING_THORNS', 'EFFECT_STEALTH_ROCK'],
    ['MOVE_LIGHT_SCREEN', 'EFFECT_LIGHT_SCREEN'],
    ['MOVE_REFLECT', 'EFFECT_REFLECT'],
    ['MOVE_SPIKES', 'EFFECT_SPIKES'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})

// BattleScript_EffectToxic battle_scripts_1.s:3957-3970.
describe('cycle 115 - Toxic', () => {
  it('poisons a normal target (:3965-3966 seteffectprimary), one accuracy draw, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TOXIC'), foe(), rng)
    runVs(state, 'MOVE_TOXIC')
    expect(foeOf(state).mon.status1 & STATUS1_TOXIC_POISON).toBe(STATUS1_TOXIC_POISON)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails on a Poison-type target (requirecandoeffect :3961): status 0, no draw, PP spent (:3960)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TOXIC'), foe({ types: ['POISON', 'MYSTERY', 'MYSTERY'] }), rng)
    runVs(state, 'MOVE_TOXIC')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('fails on a Steel-type target (requirecandoeffect :3961)', () => {
    const state = battle(user('MOVE_TOXIC'), foe({ types: ['STEEL', 'MYSTERY', 'MYSTERY'] }), countRng())
    runVs(state, 'MOVE_TOXIC')
    expect(foeOf(state).mon.status1).toBe(0)
  })

  it('fails on an already-burned target: status stays BURN (:3961)', () => {
    const state = battle(user('MOVE_TOXIC'), foe({ status1: STATUS1_BURN }), countRng())
    runVs(state, 'MOVE_TOXIC')
    expect(foeOf(state).mon.status1).toBe(STATUS1_BURN)
  })

  it('an accuracy miss (draw 99 >= 90) leaves status 0 and still spends PP (:3962 after ppreduce :3960)', () => {
    const rng = missRng()
    const state = battle(user('MOVE_TOXIC'), foe(), rng)
    runVs(state, 'MOVE_TOXIC')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectWillOWisp :6090-6103.
describe('cycle 115 - Will-O-Wisp', () => {
  it('burns a normal target (:6100-6101), one draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WILL_O_WISP'), foe(), rng)
    runVs(state, 'MOVE_WILL_O_WISP')
    expect(foeOf(state).mon.status1).toBe(STATUS1_BURN)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('fails on a Fire-type target (requirecandoeffect :6095): status 0, no draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WILL_O_WISP'), foe({ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }), rng)
    runVs(state, 'MOVE_WILL_O_WISP')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('fails behind a Substitute (jumpifsubstituteblocks :6094): status1 unchanged, no draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WILL_O_WISP'), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    runVs(state, 'MOVE_WILL_O_WISP')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it("Safeguard on the target side fails in requirecandoeffect (:6095, CanBeBurned -> IsStatusImmune battle_util.c:5028) BEFORE the accuracy roll: no draw, status 0", () => {
    const rng = countRng()
    const state = battle(user('MOVE_WILL_O_WISP'), foe(), rng)
    state.sides[1].statuses |= SIDE_STATUS_SAFEGUARD
    runVs(state, 'MOVE_WILL_O_WISP')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('a miss (draw 99 >= 90) leaves status 0', () => {
    const state = battle(user('MOVE_WILL_O_WISP'), foe(), missRng())
    runVs(state, 'MOVE_WILL_O_WISP')
    expect(foeOf(state).mon.status1).toBe(0)
  })
})

// BattleScript_EffectParalyze :4362-4376.
describe('cycle 115 - Thunder Wave (EFFECT_PARALYZE)', () => {
  it('paralyses a normal target (:4372-4373), one draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_THUNDER_WAVE'), foe(), rng)
    runVs(state, 'MOVE_THUNDER_WAVE')
    expect(foeOf(state).mon.status1).toBe(STATUS1_PARALYSIS)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })

  it('a Ground-type target fails through typecalc (:4366): status 0, NO accuracy draw, PP spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_THUNDER_WAVE'), foe({ types: ['GROUND', 'MYSTERY', 'MYSTERY'] }), rng)
    runVs(state, 'MOVE_THUNDER_WAVE')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  // requirecandoeffect uses CanBeParalyzedIgnoreType (battle_script_commands.c:8553-8554,
  // battle_util.c:5082-5088), which ignores type, so the accuracy draw IS consumed for an Electric
  // target; the later setmoveeffect PARALYSIS (no IGNORE_TYPE_IMMUNITIES) checks CanParalyzeType
  // (battle_script_commands.c:2499) and blocks the status.
  it('an Electric-type target is not paralysed, but the accuracy draw is consumed', () => {
    const rng = countRng()
    const state = battle(user('MOVE_THUNDER_WAVE'), foe({ types: ['ELECTRIC', 'MYSTERY', 'MYSTERY'] }), rng)
    runVs(state, 'MOVE_THUNDER_WAVE')
    expect(foeOf(state).mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
  })

  it('an already-paralysed target fails (status1 & STATUS1_ANY, :5083); a burned one keeps BURN', () => {
    const state = battle(user('MOVE_THUNDER_WAVE'), foe({ status1: STATUS1_BURN }), countRng())
    runVs(state, 'MOVE_THUNDER_WAVE')
    expect(foeOf(state).mon.status1).toBe(STATUS1_BURN)
    const rng = countRng()
    const para = battle(user('MOVE_THUNDER_WAVE'), foe({ status1: STATUS1_PARALYSIS }), rng)
    runVs(para, 'MOVE_THUNDER_WAVE')
    expect(foeOf(para).mon.status1).toBe(STATUS1_PARALYSIS)
    expect(rng.calls).toBe(0)
  })

  it('a miss (draw 99 >= 90) leaves status 0', () => {
    const state = battle(user('MOVE_THUNDER_WAVE'), foe(), missRng())
    runVs(state, 'MOVE_THUNDER_WAVE')
    expect(foeOf(state).mon.status1).toBe(0)
  })
})

// BattleScript_EffectEncore :4678-4689, SetEncore battle_script_commands.c:10739-10758.
describe('cycle 115 - Encore', () => {
  // Target knows Scratch (slot 0) and Tackle (slot 1); its last move is Tackle.
  const encoreTarget = (lastMove: string | null, moves: [string | null, string | null, string | null, string | null] = ['MOVE_SCRATCH', 'MOVE_TACKLE', null, null], pp: [number, number, number, number] = [10, 15, 0, 0]) => {
    const state = battle(user('MOVE_ENCORE'), foe({ moves, pp }), countRng())
    foeOf(state).lastMove = lastMove
    return state
  }

  it('encores Tackle in slot 1: encoredMove, encoredMovePos 1, timer 3 set (:10750-10753; end of turn ticks it to 2, ENDTURN_ENCORE :2799)', () => {
    const state = encoreTarget('MOVE_TACKLE')
    runVs(state, 'MOVE_ENCORE')
    const v = foeOf(state).volatiles
    expect(v.encoredMove).toBe('MOVE_TACKLE')
    expect(v.encoredMovePos).toBe(1)
    expect(v.encoreTimerStartValue).toBe(3)
    expect(v.encoreTimer).toBe(2)
    expect(ppOf(state)).toBe(9)
  })

  it.each(['MOVE_STRUGGLE', 'MOVE_ENCORE', 'MOVE_MIRROR_MOVE'])('fails when the last move is %s even if known (:10745-10747)', (last) => {
    const state = encoreTarget(last, [last, 'MOVE_TACKLE', null, null], [10, 15, 0, 0])
    runVs(state, 'MOVE_ENCORE')
    expect(foeOf(state).volatiles.encoredMove).toBeNull()
    expect(foeOf(state).volatiles.encoreTimer).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('fails when the last-move slot has 0 PP (:10749 pp[i] != 0)', () => {
    const state = encoreTarget('MOVE_TACKLE', ['MOVE_SCRATCH', 'MOVE_TACKLE', null, null], [10, 0, 0, 0])
    runVs(state, 'MOVE_ENCORE')
    expect(foeOf(state).volatiles.encoredMove).toBeNull()
    expect(foeOf(state).volatiles.encoreTimer).toBe(0)
  })

  it('fails with no last move (gLastMoves 0 matches no filled slot with PP)', () => {
    const state = encoreTarget(null)
    runVs(state, 'MOVE_ENCORE')
    expect(foeOf(state).volatiles.encoredMove).toBeNull()
  })

  it('an already-encored target fails with encoredMove unchanged (:10749 encoredMove == 0); the timer only ticks 2 -> 1', () => {
    const state = encoreTarget('MOVE_TACKLE')
    foeOf(state).volatiles.encoredMove = 'MOVE_SCRATCH'
    foeOf(state).volatiles.encoredMovePos = 0
    foeOf(state).volatiles.encoreTimer = 2
    runVs(state, 'MOVE_ENCORE')
    expect(foeOf(state).volatiles.encoredMove).toBe('MOVE_SCRATCH')
    expect(foeOf(state).volatiles.encoredMovePos).toBe(0)
    expect(foeOf(state).volatiles.encoreTimer).toBe(1)
  })

  // The sim used to refuse here too (extra `encoreTimer !== 0` test); SetEncore never reads the timer.
  it('a stale encoreTimer with no encoredMove does not block (:10749 tests encoredMove only)', () => {
    const state = encoreTarget('MOVE_TACKLE')
    foeOf(state).volatiles.encoreTimer = 2
    runVs(state, 'MOVE_ENCORE')
    expect(foeOf(state).volatiles.encoredMove).toBe('MOVE_TACKLE')
    expect(foeOf(state).volatiles.encoreTimerStartValue).toBe(3)
    expect(foeOf(state).volatiles.encoreTimer).toBe(2) // set to 3, ticked to 2 at end of turn
  })

  it('a miss (user accuracy stage 0 = 33%, draw 99) encores nothing but PrintMoveMissed still spends PP (:3092-3094)', () => {
    const rng = missRng()
    const mon = user('MOVE_ENCORE')
    const state = battle(mon, foe({ moves: ['MOVE_SCRATCH', 'MOVE_TACKLE', null, null], pp: [10, 15, 0, 0] }), rng)
    state.battlers[0]!.mon.statStages[STAT_ACC] = 0
    foeOf(state).lastMove = 'MOVE_TACKLE'
    runVs(state, 'MOVE_ENCORE')
    expect(rng.calls).toBe(1)
    expect(foeOf(state).volatiles.encoredMove).toBeNull()
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectTaunt :6255-6266, Cmd_settaunt :11678-11698.
describe('cycle 115 - Taunt', () => {
  it('target that has not moved yet: timer 3 at once (4 - 1, :11684-11686); ticks to 2 at end of turn (ENDTURN_TAUNT :2832)', () => {
    const state = battle(user('MOVE_TAUNT', FAST), foe(), countRng())
    const during = runSnap(state, 'MOVE_TAUNT', () => ({
      timer: foeOf(state).volatiles.tauntTimer,
      timer2: foeOf(state).volatiles.tauntTimer2,
    }))
    expect(during).toEqual({ timer: 3, timer2: 3 })
    expect(foeOf(state).volatiles.tauntTimer).toBe(2)
    expect(ppOf(state)).toBe(9)
  })

  it('target that already moved: timer 4 (tauntTimer2 4); ticks to 3 at end of turn', () => {
    const state = battle(user('MOVE_TAUNT'), foe(FAST), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TAUNT'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(0)))
    expect(foeOf(state).volatiles.tauntTimer2).toBe(4)
    expect(foeOf(state).volatiles.tauntTimer).toBe(3)
  })

  it('an Oblivious target fails (:11680): timer stays 0', () => {
    const state = battle(user('MOVE_TAUNT', FAST), foe({ abilities: only('ABILITY_OBLIVIOUS') }), countRng())
    runVs(state, 'MOVE_TAUNT')
    expect(foeOf(state).volatiles.tauntTimer).toBe(0)
    expect(foeOf(state).volatiles.tauntTimer2).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('an already-taunted target fails (:11682 tauntTimer != 0): tauntTimer2 unchanged', () => {
    const state = battle(user('MOVE_TAUNT', FAST), foe(), countRng())
    foeOf(state).volatiles.tauntTimer = 2
    foeOf(state).volatiles.tauntTimer2 = 4
    runVs(state, 'MOVE_TAUNT')
    expect(foeOf(state).volatiles.tauntTimer2).toBe(4) // a fresh Taunt would write 3 or 4 over it
    expect(foeOf(state).volatiles.tauntTimer).toBe(1) // 2, ticked once at end of turn
  })

  it('a miss (user accuracy stage 0 = 33%, draw 99) taunts nothing, PP spent', () => {
    const rng = missRng()
    const state = battle(user('MOVE_TAUNT', FAST), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ACC] = 0
    runVs(state, 'MOVE_TAUNT')
    expect(rng.calls).toBe(1)
    expect(foeOf(state).volatiles.tauntTimer).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectBatonPass :5266-5285 (BattleScript_BatonPassSwitch onward).
describe('cycle 115 - Baton Pass', () => {
  const replacement: ReplacementDeps = { chooseReplacement: () => 1 }
  const withReserve = (reserve: SimPartyMon) =>
    battle(
      user('MOVE_BATON_PASS'),
      foe(),
      countRng(),
      { playerParty: [partyMon('SPECIES_MUDKIP', { moves: ['MOVE_BATON_PASS', null, null, null], pp: [10, 0, 0, 0] }), reserve] },
    )

  it('user with +2 Atk (stage 8) hands it to the reserve, which enters; PP spent once', () => {
    const state = withReserve(partyMon('SPECIES_TREECKO'))
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    runSelf(state, 'MOVE_BATON_PASS', replacement)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(state.sides[0].party[0]!.pp[0]).toBe(9)
  })

  it('a plain switch-out does not pass stages (control: the carry-over is Baton Pass specific)', () => {
    const state = withReserve(partyMon('SPECIES_TREECKO'))
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    // Same turn via Parting Shot would reset; use the effect-less path: EFFECT_PARTING_SHOT switches normally.
    const ps = battle(
      user('MOVE_PARTING_SHOT'),
      foe(),
      countRng(),
      { playerParty: [partyMon('SPECIES_MUDKIP', { moves: ['MOVE_PARTING_SHOT', null, null, null], pp: [10, 0, 0, 0] }), partyMon('SPECIES_TREECKO')] },
    )
    ps.battlers[0]!.mon.statStages[STAT_ATK] = 8
    runVs(ps, 'MOVE_PARTING_SHOT', replacement)
    expect(ps.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(ps.battlers[0]!.mon.statStages[STAT_ATK]).toBe(6)
  })

  it('with no live reserve it fails: the user stays in, stages kept, PP deducted once (:5271 after ppreduce :5269)', () => {
    const state = withReserve(partyMon('SPECIES_TREECKO', { hp: 0 }))
    state.battlers[0]!.mon.statStages[STAT_ATK] = 8
    runSelf(state, 'MOVE_BATON_PASS', replacement)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectPartingShot :1091-1113.
describe('cycle 115 - Parting Shot', () => {
  const replacement: ReplacementDeps = { chooseReplacement: () => 1 }
  const setup = (opts: { reserve?: SimPartyMon; target?: Partial<SimBattleMon>; rng?: RandomSource } = {}) =>
    battle(
      user('MOVE_PARTING_SHOT'),
      foe(opts.target ?? {}),
      opts.rng ?? countRng(),
      {
        playerParty: [
          partyMon('SPECIES_MUDKIP', { moves: ['MOVE_PARTING_SHOT', null, null, null], pp: [10, 0, 0, 0] }),
          opts.reserve ?? partyMon('SPECIES_TREECKO'),
        ],
      },
    )
  const foeStage = (state: BattleState, stat: number) => foeOf(state).mon.statStages[stat]

  it('target 0/0 (stage 6/6) -> -1/-1 (stage 5/5) and the user is replaced (:1104-1111, :1115)', () => {
    const state = setup()
    runVs(state, 'MOVE_PARTING_SHOT', replacement)
    expect(foeStage(state, STAT_ATK)).toBe(5)
    expect(foeStage(state, STAT_SPATK)).toBe(5)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.sides[0].party[0]!.pp[0]).toBe(9)
  })

  it('Atk at -6 (stage 0), SpAtk 0 -> Atk stays -6, SpAtk -1 (:1095 jumps on Atk > MIN), user still switches', () => {
    const state = setup()
    foeOf(state).mon.statStages[STAT_ATK] = 0
    runVs(state, 'MOVE_PARTING_SHOT', replacement)
    expect(foeStage(state, STAT_ATK)).toBe(0)
    expect(foeStage(state, STAT_SPATK)).toBe(5)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
  })

  it('both at -6 fails (:1096 BattleScript_CantLowerMultipleStats): no stat change, no switch, PP spent', () => {
    const rng = countRng()
    const state = setup({ rng })
    foeOf(state).mon.statStages[STAT_ATK] = 0
    foeOf(state).mon.statStages[STAT_SPATK] = 0
    runVs(state, 'MOVE_PARTING_SHOT', replacement)
    expect(foeStage(state, STAT_ATK)).toBe(0)
    expect(foeStage(state, STAT_SPATK)).toBe(0)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a miss (user accuracy stage 0 = 33%, draw 99): no stat change and no switch (:1098 -> PrintMoveMissed)', () => {
    const rng = missRng()
    const state = setup({ rng })
    state.battlers[0]!.mon.statStages[STAT_ACC] = 0
    runVs(state, 'MOVE_PARTING_SHOT', replacement)
    expect(rng.calls).toBe(1)
    expect(foeStage(state, STAT_ATK)).toBe(6)
    expect(foeStage(state, STAT_SPATK)).toBe(6)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(9)
  })

  // statbuffchange with STAT_BUFF_ALLOW_PTR jumps to the next label when the drop is blocked
  // (:1105, :1111), and the script ends at BattleScript_EffectPartingShotSwitch, so the user still
  // switches when Clear Body stops both drops.
  it('Clear Body blocks both drops but the user still switches', () => {
    const state = setup({ target: { abilities: only('ABILITY_CLEAR_BODY') } })
    runVs(state, 'MOVE_PARTING_SHOT', replacement)
    expect(foeStage(state, STAT_ATK)).toBe(6)
    expect(foeStage(state, STAT_SPATK)).toBe(6)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
  })

  it('no live reserve: the drops land but the user stays in (BattleScript_DoMoveSwitch can-switch check)', () => {
    const state = setup({ reserve: partyMon('SPECIES_TREECKO', { hp: 0 }) })
    runVs(state, 'MOVE_PARTING_SHOT', replacement)
    expect(foeStage(state, STAT_ATK)).toBe(5)
    expect(foeStage(state, STAT_SPATK)).toBe(5)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
  })
})

// BattleScript_EffectSoftboiled :5909-5925, Cmd_tryhealhalfhealth :9255-9274.
describe('cycle 115 - Soft-Boiled / Milk Drink', () => {
  it.each(['MOVE_MILK_DRINK', 'MOVE_SOFT_BOILED'])('%s heals trunc(100/2) = 50 from 40/100 -> 90 (:9266)', (moveId) => {
    const state = battle(user(moveId, { hp: 40 }), foe(), countRng())
    runSelf(state, moveId)
    expect(state.battlers[0]!.mon.hp).toBe(90)
    expect(ppOf(state)).toBe(9)
  })

  it.each(['MOVE_MILK_DRINK', 'MOVE_SOFT_BOILED'])('%s at full HP fails (:9270-9271): HP stays 100, PP spent', (moveId) => {
    const state = battle(user(moveId), foe(), countRng())
    runSelf(state, moveId)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(ppOf(state)).toBe(9)
  })

  it.each(['MOVE_MILK_DRINK', 'MOVE_SOFT_BOILED'])('%s while heal-blocked fails with HP unchanged (jumpifhealingblocked :5913)', (moveId) => {
    const state = battle(user(moveId, { hp: 40 }), foe(), countRng())
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    state.battlers[0]!.volatiles.healBlockTimer = 5
    runSelf(state, moveId)
    expect(state.battlers[0]!.mon.hp).toBe(40)
  })
})

// BattleScript_EffectStealthRock :2559-2569, Cmd_setstealthrock :11979-11989.
describe('cycle 115 - Stealth Rock / Creeping Thorns', () => {
  it.each([
    ['MOVE_STEALTH_ROCK', 5], // TYPE_ROCK (constants/pokemon.h:13)
    ['MOVE_CREEPING_THORNS', 12], // TYPE_GRASS (constants/pokemon.h:20)
  ])('%s sets the opponent side flag and stealthRockType %i; own side untouched (:11984-11985)', (moveId, typeId) => {
    const state = battle(user(moveId), foe(), countRng())
    runVs(state, moveId)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(state.sides[1].timers.stealthRockType).toBe(typeId)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
    expect(state.sides[0].timers.stealthRockType).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a second use fails (:11981): the type is unchanged even when the second move has another type, PP spent both times', () => {
    const rockFirst = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_STEALTH_ROCK', 'MOVE_CREEPING_THORNS', null, null], pp: [10, 10, 0, 0] }),
      foe(),
      countRng(),
    )
    runVs(rockFirst, 'MOVE_STEALTH_ROCK')
    runVs(rockFirst, 'MOVE_CREEPING_THORNS')
    expect(rockFirst.sides[1].timers.stealthRockType).toBe(5)
    expect(rockFirst.battlers[0]!.mon.pp[0]).toBe(9)
    expect(rockFirst.battlers[0]!.mon.pp[1]).toBe(9)
  })

  it('a second use of the same move: flag still set, PP 10 -> 8', () => {
    const state = battle(user('MOVE_STEALTH_ROCK'), foe(), countRng())
    runVs(state, 'MOVE_STEALTH_ROCK')
    runVs(state, 'MOVE_STEALTH_ROCK')
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(ppOf(state)).toBe(8)
  })
})

// BattleScript_EffectLightScreen :4016-4021 / Reflect :4320-4335, Cmd_setlightscreen :10252-10273,
// Cmd_setreflect :9319-9339. SCREEN_DURATION 5 / SCREEN_DURATION_EXTENDED 8 (battle_util.h:63-64).
describe.each([
  ['MOVE_LIGHT_SCREEN', SIDE_STATUS_LIGHTSCREEN, 'lightscreenTimer', 'lightscreenBattlerId'],
  ['MOVE_REFLECT', SIDE_STATUS_REFLECT, 'reflectTimer', 'reflectBattlerId'],
] as const)('cycle 115 - %s', (moveId, flag, timerKey, battlerKey) => {
  const sideNow = (state: BattleState) => ({
    flag: hasFlag(state.sides[0].statuses, flag),
    timer: state.sides[0].timers[timerKey],
    by: state.sides[0].timers[battlerKey],
  })

  it('sets the side flag, timer 5, setter = attacker (battler 0); opposing side untouched', () => {
    const state = battle(user(moveId, FAST), foe(), countRng())
    const seen = runSnap(state, moveId, () => sideNow(state))
    expect(seen).toEqual({ flag: true, timer: 5, by: 0 })
    expect(hasFlag(state.sides[1].statuses, flag)).toBe(false)
    expect(ppOf(state)).toBe(9)
  })

  it('Light Clay extends it to 8 (SCREEN_DURATION_EXTENDED)', () => {
    const state = battle(user(moveId, { ...FAST, itemId: 'ITEM_LIGHT_CLAY' }), foe(), countRng())
    expect(runSnap(state, moveId, () => sideNow(state))).toEqual({ flag: true, timer: 8, by: 0 })
  })

  it('a second use fails and the timer stays 3 (MOVE_RESULT_MISSED path), PP still spent', () => {
    const state = battle(user(moveId, FAST), foe(), countRng())
    state.sides[0].statuses |= flag
    state.sides[0].timers[timerKey] = 3
    state.sides[0].timers[battlerKey] = 1
    const seen = runSnap(state, moveId, () => sideNow(state))
    expect(seen).toEqual({ flag: true, timer: 3, by: 1 })
    expect(ppOf(state)).toBe(9)
  })

  it('a Screen Cleaner user re-sets the running screen to timer 5 and takes ownership', () => {
    const state = battle(user(moveId, { ...FAST, abilities: only('ABILITY_SCREEN_CLEANER') }), foe(), countRng())
    state.sides[0].statuses |= flag
    state.sides[0].timers[timerKey] = 3
    state.sides[0].timers[battlerKey] = 1
    expect(runSnap(state, moveId, () => sideNow(state))).toEqual({ flag: true, timer: 5, by: 0 })
  })
})

// BattleScript_EffectSpikes :5058-5068, Cmd_trysetspikes :11115-11125.
describe('cycle 115 - Spikes', () => {
  it('layers 1, 2, 3 on three uses, a fourth leaves it at 3; PP deducted every time; own side stays 0', () => {
    const state = battle(user('MOVE_SPIKES'), foe(), countRng())
    const layers: number[] = []
    for (let i = 0; i < 4; i++) {
      runVs(state, 'MOVE_SPIKES')
      layers.push(state.sides[1].timers.spikesAmount)
      expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_SPIKES)).toBe(true)
      expect(ppOf(state)).toBe(9 - i)
    }
    expect(layers).toEqual([1, 2, 3, 3])
    expect(state.sides[0].timers.spikesAmount).toBe(0)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(false)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_TOXIC',
  'EFFECT_WILL_O_WISP',
  'EFFECT_PARALYZE',
  'EFFECT_ENCORE',
  'EFFECT_TAUNT',
  'EFFECT_BATON_PASS',
  'EFFECT_PARTING_SHOT',
  'EFFECT_SOFTBOILED',
  'EFFECT_STEALTH_ROCK',
  'EFFECT_LIGHT_SCREEN',
  'EFFECT_REFLECT',
  'EFFECT_SPIKES',
]

describe('cycle 115 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})
