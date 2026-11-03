/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 129: twelve copy / field-oddity move effects. Every expected number is derived by hand from
// the pinned C named on the assertion that needs it: the script in data/battle_scripts_1.s, the
// command in src/battle_script_commands.c / src/battle_util.c, or the table the sim mirrors.
// Stat stages run 0..12 with neutral 6 (DEFAULT_STAT_STAGE), so "+2" is stage 8.
// Damage shortcut used throughout: at level 50 with Attack == Defense == 100 the formula
// `((2*50/5+2) * power * atk / def / 50) + 2` reduces to `22*power/50 + 2`; a roll of 0 is the
// 100% entry of the 85..100% array (damageResolver.ts:214 draws `random16() % 16` and indexes
// `values[15 - roll]`), and type effectiveness is a final multiplier.
import { describe, expect, it } from 'vitest'

import type { BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  QUASH_DURATION,
  STAT_ATK,
  STAT_EVASION,
  STATUS2_SUBSTITUTE,
  STATUS2_TRANSFORMED,
  STATUS3_ME_FIRST,
  STATUS3_SEMI_INVULNERABLE,
  STATUS4_ELECTRIFIED,
  hasFlag,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { findAllowance } from './driver/auditAllowlist'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT, getMovePriority } from './turnOrder'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }
const only = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

/** 200 Speed against the foe's default 100 keeps GetFastestBattler's speed-tie coin flip
 * (turnOrder.ts:583, and the same flip in fieldEndTurn.ts:443) out of the scripted draw arrays. */
const FAST_STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = SIM.speciesById.get(speciesId) as { types: string[] } | undefined
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
    rawStats: FAST_STATS,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

/** Every draw is 0 (accuracy always hits, no crit, full damage); `calls` counts draws. */
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

function battle4(
  a: SimBattleMon,
  b: SimBattleMon,
  c: SimBattleMon,
  d: SimBattleMon,
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: [
      createBattlerState(0, a, 0),
      createBattlerState(1, b, 0),
      createBattlerState(2, c, 0),
      createBattlerState(3, d, 0),
    ],
    rng,
  })
}

function viewOf(moveId: string): TurnOrderMoveView {
  const m = DATA_CONTEXT.move(moveId)
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

function useMove(target: number, moveId: string): ChosenAction {
  const view = viewOf(moveId)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

/** The fixed-damage scripts overwrite the resolver's answer only when it is NON-ZERO (turn.ts:3129),
 * so `0` models a type-immune target and any positive number models a connected hit. */
const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }),
})

/** The real bridge resolver, needed wherever a number depends on the damage formula. */
function bridgeDamage(state: BattleState, random: RandomSource): DamageResolver {
  const bridge: BridgeDeps = {
    grounding: groundingFor(SIM, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  }
  const deps: BridgeDamageResolverDeps = {
    ...bridge,
    moveData: SIM.moveData,
    typeChart: SIM.typeChart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    random,
  }
  return createBridgeDamageResolver(deps)
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
  }
}

const THIS_FILE = 'web/src/engine/sim/cycle129CopyEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const ppOf = (state: BattleState, battlerId = 0, slot = 0) => state.battlers[battlerId]!.mon.pp[slot]
const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }

// BattleScript_EffectMetronome (data/battle_scripts_1.s:4568-4577),
// Cmd_metronome (src/battle_script_commands.c:10586-10613):
//   do {
//       move = (Random() % (MOVES_COUNT - 1)) + 1;
//       switch (effect) { PROTECT/PLACEHOLDER/DO_NOTHING/FOLLOW_ME/TRICK: allowed = FALSE; default TRUE; }
//   } while (!allowed && !metronomeBanned && !twoTurnMove);
// MOVES_COUNT is 1032 (metronomeMoves.ts), so roll 181 -> 182 (MOVE_PROTECT) and 265 -> 266
// (MOVE_FOLLOW_ME). The while condition uses '&&' (the C's own bug at :10603): a forbidden move
// that is metronomeBanned STOPS the redraw and gets used anyway.
describe('cycle 129 - Metronome (EFFECT_METRONOME)', () => {
  it('redraws a forbidden non-banned move (Protect) and queues the next roll as an extra attack', () => {
    // Draws: 181 -> Protect (forbidden, not metronomeBanned, not two-turn -> loop continues);
    //        0 -> Pound; the queued Pound's accuracycheck then draws once (countingRng = 0).
    const rng = scriptedRng([181, 0])
    const user = monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_METRONOME', 'MOVE_POUND', null, null],
      pp: [10, 20, 0, 0],
    })
    const state = battle(user, monFor('SPECIES_TREECKO'), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_METRONOME'), null], loopDeps(state, fixedDamage(25)))
    const userActions = out.actions.filter((a) => a.battlerId === 0)

    expect(userActions).toHaveLength(2)
    expect(userActions[0]!.missed).toBe(false)
    expect(rng.calls).toBe(3) // two Metronome rolls + Pound's accuracy roll
    expect(ppOf(state)).toBe(9) // Metronome ppreduce (:4571)
    // HITMARKER_NO_PPDEDUCT for the queued move: movePos 0 makes shouldDeductPp false (turn.ts:2020),
    // so the called Pound costs nothing even though it sits in a real slot.
    expect(ppOf(state, 0, 1)).toBe(20)
    expect(userActions[1]!.targetDamage).toBe(25)
    expect(state.battlers[1]!.mon.hp).toBe(75)
  })

  it("the do/while's && lets a metronome-banned forbidden move through: Follow Me's side timer is set", () => {
    // Draws: 181 -> Protect (redraw); 265 -> Follow Me, forbidden but metronomeBanned (:10603 condition
    // false) so the loop exits WITH Follow Me selected. Follow Me's handler has no accuracy check, so
    // the whole turn costs exactly the two Metronome rolls.
    const rng = scriptedRng([181, 265])
    const user = monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_METRONOME', null, null, null],
      pp: [10, 0, 0, 0],
    })
    const state = battle(monFor('SPECIES_TREECKO'), user, rng)
    const out = executeTurn(state, [null, useMove(0, 'MOVE_METRONOME')], loopDeps(state, fixedDamage(0)))
    const userActions = out.actions.filter((a) => a.battlerId === 1)

    expect(userActions).toHaveLength(2)
    expect(userActions[1]!.targetId).toBe(1) // Follow Me targets its user
    expect(rng.calls).toBe(2)
    expect(ppOf(state, 1)).toBe(9)
    // Cmd_setforcedtarget (:11614-11616) writes the ATTACKER's side; TurnValuesCleanUp clears only
    // followmeTimer, so the target id survives the end of the turn (turn.ts:692-711 wraps it).
    expect(state.sides[1].timers.followmeTarget).toBe(1)
    expect(state.sides[1].timers.followmeTimer).toBe(0)
  })
})

// BattleScript_EffectTrick (data/battle_scripts_1.s:6279-6291), Cmd_tryswapitems
// (src/battle_script_commands.c:11712-11765). All solver fights are trainer battles
// (BATTLE_TYPE_TRAINER) and B_TRAINERS_KNOCK_OFF_ITEMS is TRUE (include/constants/battle_config.h:103).
describe('cycle 129 - Trick (EFFECT_TRICK)', () => {
  const tricker = (itemId: string | null, overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_TRICK', null, null, null],
      pp: [10, 0, 0, 0],
      itemId,
      ...overrides,
    })
  const holder = (itemId: string | null, overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_TREECKO', { itemId, ...overrides })

  it('swaps both items, and swaps one-sidedly when only one side holds an item', () => {
    const rng = countRng()
    const state = battle(tricker('ITEM_SITRUS_BERRY'), holder('ITEM_LIECHI_BERRY'), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_TRICK'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LIECHI_BERRY')
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(rng.calls).toBe(1) // one accuracycheck roll
    expect(ppOf(state)).toBe(9)

    // Attacker item -> empty target (:11743-11744 writes both UpdateBattlerItem calls).
    const giveAway = battle(tricker('ITEM_SITRUS_BERRY'), holder(null), countRng())
    executeTurn(giveAway, [useMove(1, 'MOVE_TRICK'), null], loopDeps(giveAway, fixedDamage(0)))
    expect(giveAway.battlers[0]!.mon.itemId).toBeNull()
    expect(giveAway.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')

    // Empty attacker <- target item.
    const takeAway = battle(tricker(null), holder('ITEM_LIECHI_BERRY'), countRng())
    executeTurn(takeAway, [useMove(1, 'MOVE_TRICK'), null], loopDeps(takeAway, fixedDamage(0)))
    expect(takeAway.battlers[0]!.mon.itemId).toBe('ITEM_LIECHI_BERRY')
    expect(takeAway.battlers[1]!.mon.itemId).toBeNull()
  })

  it('fails on identical items, is blocked by Substitute before accuracy, and Sticky Hold leaves both items', () => {
    // attackerItem == targetItem jumps to BattleScript_ButItFailed (:11733).
    const same = battle(tricker('ITEM_SITRUS_BERRY'), holder('ITEM_SITRUS_BERRY'), countRng())
    const sameOut = executeTurn(same, [useMove(1, 'MOVE_TRICK'), null], loopDeps(same, fixedDamage(0)))
    expect(actionOf(sameOut, 0)?.missed).toBe(true)
    expect(same.battlers[0]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(same.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(ppOf(same)).toBe(9)

    // jumpifsubstituteblocks BattleScript_ButItFailed (:6283) runs BEFORE accuracy: zero draws.
    const subRng = countRng()
    const sub = battle(tricker('ITEM_SITRUS_BERRY'), holder('ITEM_LIECHI_BERRY'), subRng)
    sub.battlers[1]!.mon.status2 = STATUS2_SUBSTITUTE
    sub.battlers[1]!.volatiles.substituteHp = 25
    const subOut = executeTurn(sub, [useMove(1, 'MOVE_TRICK'), null], loopDeps(sub, fixedDamage(0)))
    expect(actionOf(subOut, 0)?.missed).toBe(true)
    expect(subRng.calls).toBe(0)
    expect(sub.battlers[0]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(sub.battlers[1]!.mon.itemId).toBe('ITEM_LIECHI_BERRY')
    expect(ppOf(sub)).toBe(9)

    // IsStickyHold (src/battle_util.c:9329-9333) jumps to BattleScript_MoveEnd (:11738-11739):
    // NOT a failed move, but no swap.
    const sticky = battle(
      tricker('ITEM_SITRUS_BERRY'),
      holder('ITEM_LIECHI_BERRY', { abilities: only('ABILITY_STICKY_HOLD') }),
      countRng(),
    )
    const stickyOut = executeTurn(sticky, [useMove(1, 'MOVE_TRICK'), null], loopDeps(sticky, fixedDamage(0)))
    expect(actionOf(stickyOut, 0)?.missed).toBe(false)
    expect(sticky.battlers[0]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(sticky.battlers[1]!.mon.itemId).toBe('ITEM_LIECHI_BERRY')
    expect(ppOf(sticky)).toBe(9)
  })
})

// BattleScript_EffectQuash (data/battle_scripts_1.s:2240-2249), VARIOUS_TRY_QUASH
// (src/battle_script_commands.c:7281-7290). This build's Quash is a FIELD-WIDE 5-turn timer
// (QUASH_DURATION = 5, include/battle_util.h:70), not the Gen-5 per-target flag, and
// GetMovePriority floors every move to -4 while it runs (src/battle_main.c:4262-4263).
describe('cycle 129 - Quash (EFFECT_QUASH)', () => {
  const quashUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_QUASH', null, null, null], pp: [5, 0, 0, 0], ...overrides })

  it('starts the 5-turn field timer and floors move priority at min(-4, priority)', () => {
    const state = battle(quashUser(), monFor('SPECIES_TREECKO'), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_QUASH'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(4)
    expect(state.field.timers.quashTimer).toBe(QUASH_DURATION)
    expect(state.field.timers.started.quash).toBe(true)
    // Tackle's declared priority is 0 -> min(-4, 0) = -4; Counter's is -5 -> min(-4, -5) = -5.
    expect(getMovePriority(state, 0, viewOf('MOVE_TACKLE'), 1)).toBe(-4)
    expect(getMovePriority(state, 0, viewOf('MOVE_COUNTER'), 1)).toBe(-5)
  })

  it('a second Quash fails while the timer runs; ENDTURN_QUASH then ticks the timer down', () => {
    const state = battle(quashUser(), monFor('SPECIES_TREECKO'), countRng())
    // Pre-existing timer, started.quash FALSE (so the end-of-turn tick is not suppressed).
    state.field.timers.quashTimer = 3
    const out = executeTurn(state, [useMove(1, 'MOVE_QUASH'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(4) // ppreduce already ran (:2244)
    expect(state.field.timers.started.quash).toBe(false)
    // VARIOUS_TRY_QUASH refuses to overwrite (:7283-7284); ENDTURN_QUASH (src/battle_util.c:2251-2255)
    // decrements 3 -> 2 because started.quash is FALSE.
    expect(state.field.timers.quashTimer).toBe(2)
  })
})

// BattleScript_EffectAfterYou (data/battle_scripts_1.s:1418-1427), VARIOUS_AFTER_YOU
// (src/battle_script_commands.c:7695-7702). Setting gRoundStructs[target].afterYou feeds
// GetMoveSpeed (src/battle_main.c:4302-4303), whose recalculateMoveOrder pulls the target into the
// slot immediately after the user.
describe('cycle 129 - After You (EFFECT_AFTER_YOU)', () => {
  it('pulls the slower target directly after the user: speeds 200/150/50/100 -> order [0,2,1,3]', () => {
    const state = battle4(
      monFor('SPECIES_MUDKIP', { rawStats: { ...FAST_STATS, spe: 200 }, moves: ['MOVE_AFTER_YOU', null, null, null], pp: [15, 0, 0, 0] }),
      monFor('SPECIES_TREECKO', { rawStats: { ...FAST_STATS, spe: 150 }, moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0] }),
      monFor('SPECIES_TREECKO', { rawStats: { ...FAST_STATS, spe: 50 }, moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0] }),
      monFor('SPECIES_TREECKO', { rawStats: { ...FAST_STATS, spe: 100 }, moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0] }),
      countRng(),
    )
    const out = executeTurn(
      state,
      [useMove(2, 'MOVE_AFTER_YOU'), useMove(0, 'MOVE_CELEBRATE'), useMove(0, 'MOVE_CELEBRATE'), useMove(0, 'MOVE_CELEBRATE')],
      loopDeps(state, fixedDamage(0)),
    )

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(actionOf(out, 0)?.targetId).toBe(2)
    expect(ppOf(state)).toBe(14)
    expect(out.order.battlerByTurnOrder).toEqual([0, 2, 1, 3])
  })

  it('fails when the target already acted: gCurrentTurnActionNumber >= GetBattlerTurnOrderNum(target)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_CELEBRATE', null, null, null], pp: [10, 0, 0, 0] }),
      monFor('SPECIES_TREECKO', { moves: ['MOVE_AFTER_YOU', null, null, null], pp: [15, 0, 0, 0] }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(0, 'MOVE_CELEBRATE'), useMove(0, 'MOVE_AFTER_YOU')], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 1)?.missed).toBe(true)
    expect(actionOf(out, 1)?.targetId).toBe(0)
    expect(ppOf(state, 1)).toBe(14)
  })
})

// BattleScript_EffectNaturalGift (data/battle_scripts_1.s:3046-3071): jumpifnotberry (:3050,
// VARIOUS_JUMP_IF_NOT_BERRY src/battle_script_commands.c:6869-6875), then the hit, then
// setmoveeffect NATURAL_GIFT / seteffectsecondary (:3067-3068) and `jumpifmovehadnoeffect;
// removeitem BS_ATTACKER`. Power and type come from gNaturalGiftTable[item - FIRST_BERRY_INDEX]
// (items.json naturalGift, bridged at bridge.ts:583; read by calculate.ts:926-927 and :1057).
describe('cycle 129 - Natural Gift (EFFECT_NATURAL_GIFT)', () => {
  const giftUser = (itemId: string | null) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_NATURAL_GIFT', null, null, null],
      pp: [15, 0, 0, 0],
      itemId,
    })
  const bird = () => monFor('SPECIES_TAILLOW') // NORMAL/FLYING: Ground is immune, Electric is 2x

  function resolveTypes(state: BattleState, rng: RandomSource): { resolver: DamageResolver; types: (string | null | undefined)[] } {
    const bridge = bridgeDamage(state, rng)
    const types: (string | null | undefined)[] = []
    const resolver: DamageResolver = {
      resolve: (s, a, t, action, ctx) => {
        const r = bridge.resolve(s, a, t, action, ctx)
        types.push(r.resolvedMoveType)
        return r
      },
    }
    return { resolver, types }
  }

  it('Chilan (Normal, 150 BP) hits for 68 and is consumed only after a connected hit', () => {
    // ((2*50/5+2) * 150 * 100 / 100 / 50) + 2 = 22*150/50 + 2 = 66 + 2 = 68; roll 0 = 100%.
    // Draws: accuracy 0, crit 1 (no crit), damage roll 0.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(giftUser('ITEM_CHILAN_BERRY'), bird(), rng)
    const { resolver, types } = resolveTypes(state, rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_NATURAL_GIFT'), null], loopDeps(state, resolver))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(actionOf(out, 0)?.targetDamage).toBe(68)
    expect(state.battlers[1]!.mon.hp).toBe(32)
    expect(types[0]).toBe('NORMAL')
    expect(ppOf(state)).toBe(14)
    expect(rng.calls).toBe(3)
    // removeitem BS_ATTACKER runs once the hit did something (turn.ts:3363).
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.usedHeldItem).toBe('ITEM_CHILAN_BERRY')
  })

  it('Cheri (Electric, 80 BP) is super effective on the Flying bird: 37 * 2 = 74', () => {
    // ((22 * 80 / 50) + 2) = 35 + 2 = 37; Electric vs NORMAL/FLYING = 2x -> 74.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(giftUser('ITEM_CHERI_BERRY'), bird(), rng)
    const { resolver, types } = resolveTypes(state, rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_NATURAL_GIFT'), null], loopDeps(state, resolver))

    expect(actionOf(out, 0)?.targetDamage).toBe(74)
    expect(state.battlers[1]!.mon.hp).toBe(26)
    expect(types[0]).toBe('ELECTRIC')
    expect(state.battlers[0]!.mon.itemId).toBeNull()
  })

  it('Aguav (Ground) is immune on the Flying bird, so the berry survives', () => {
    // The table says GROUND: Flying is immune to Ground, while the declared Normal type (Chilan,
    // above) hits this same bird for 68. damageResolver.ts:205 returns 0 for an immune hit without
    // reporting a resolved type, so the immunity itself is the type-override observable here.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(giftUser('ITEM_AGUAV_BERRY'), bird(), rng)
    const { resolver } = resolveTypes(state, rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_NATURAL_GIFT'), null], loopDeps(state, resolver))

    expect(actionOf(out, 0)?.targetDamage).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    // jumpifmovehadnoeffect skips removeitem (:3067-3068).
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_AGUAV_BERRY')
    expect(state.battlers[0]!.usedHeldItem ?? null).toBeNull()
  })

  it('fails before accuracy with no berry or a non-berry item, and a miss keeps the berry', () => {
    // VARIOUS_JUMP_IF_NOT_BERRY jumps to BattleScript_ButItFailed: no accuracy draw, PP still spent.
    const none = battle(giftUser(null), bird(), countRng())
    const noneOut = executeTurn(none, [useMove(1, 'MOVE_NATURAL_GIFT'), null], loopDeps(none, fixedDamage(0)))
    expect(actionOf(noneOut, 0)?.missed).toBe(true)
    expect(ppOf(none)).toBe(14)

    const leftovers = battle(giftUser('ITEM_LEFTOVERS'), bird(), countRng())
    const leftoversOut = executeTurn(leftovers, [useMove(1, 'MOVE_NATURAL_GIFT'), null], loopDeps(leftovers, fixedDamage(0)))
    expect(actionOf(leftoversOut, 0)?.missed).toBe(true)
    expect(ppOf(leftovers)).toBe(14)

    // Target at +1 evasion: accuracy 100 -> floor(100*2/3) = 66; roll 90 >= 66 misses.
    const rng = scriptedRng([90])
    const miss = battle(giftUser('ITEM_CHILAN_BERRY'), bird(), rng)
    miss.battlers[1]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 1
    const missOut = executeTurn(miss, [useMove(1, 'MOVE_NATURAL_GIFT'), null], loopDeps(miss, fixedDamage(0)))
    expect(actionOf(missOut, 0)?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(miss.battlers[0]!.mon.itemId).toBe('ITEM_CHILAN_BERRY')
    expect(ppOf(miss)).toBe(14)
  })
})

// BattleScript_EffectCopycat (data/battle_scripts_1.s:1594-1604), VARIOUS_TRY_COPYCAT
// (src/battle_script_commands.c:7541-7561). It copies the GLOBAL gLastUsedMove unless that move's
// effect is in sCopycatBannedEffects or its FLAG_COPYCAT_BANNED is set; failure costs PP (:1603).
describe('cycle 129 - Copycat (EFFECT_COPYCAT)', () => {
  const copyUser = () =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_COPYCAT', null, null, null], pp: [20, 0, 0, 0] })

  it('copies Swords Dance and applies its +2 Attack, charging Copycat PP through the called script', () => {
    const rng = countRng()
    const state = battle(copyUser(), monFor('SPECIES_TREECKO'), rng)
    state.lastUsedMove = 'MOVE_SWORDS_DANCE'
    const out = executeTurn(state, [useMove(0, 'MOVE_COPYCAT'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    // No ppreduce on Copycat's own success path; the called Swords Dance script's ppreduce costs
    // Copycat's slot (:1594-1601), and neither script draws accuracy.
    expect(ppOf(state)).toBe(19)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(rng.calls).toBe(0)
  })

  it('copies Tackle and deals its hand-derived 19 damage', () => {
    // ((22 * 40 / 50) + 2) = 17 + 2 = 19; draws: accuracy 0, crit 1, roll 0.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(copyUser(), monFor('SPECIES_TREECKO'), rng)
    state.lastUsedMove = 'MOVE_TACKLE'
    const out = executeTurn(state, [useMove(0, 'MOVE_COPYCAT'), null], loopDeps(state, bridgeDamage(state, rng)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(actionOf(out, 0)?.targetDamage).toBe(19)
    expect(state.battlers[1]!.mon.hp).toBe(81)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(3)
  })

  it('fails on a banned effect (Protect, Roar), a copycatBanned flag (Counter) or no last move', () => {
    for (const lastUsedMove of ['MOVE_PROTECT', 'MOVE_ROAR', 'MOVE_COUNTER', null]) {
      const state = battle(copyUser(), monFor('SPECIES_TREECKO'), countRng())
      state.lastUsedMove = lastUsedMove
      const out = executeTurn(state, [useMove(0, 'MOVE_COPYCAT'), null], loopDeps(state, fixedDamage(0)))
      expect(actionOf(out, 0)?.missed).toBe(true)
      expect(ppOf(state)).toBe(19) // the failure branch still runs ppreduce (:1603)
    }
  })
})

// BattleScript_EffectInstruct (data/battle_scripts_1.s:1606-1616), VARIOUS_TRY_INSTRUCT
// (src/battle_script_commands.c:7563-7586); sMoveEffectsForbiddenToInstruct (:737-774).
// A successful Instruct queues the target's last move as an extra attack with
// movePos = slot+1, so Cmd_ppreduce charges that move's slot (:7581-7586).
describe('cycle 129 - Instruct (EFFECT_INSTRUCT)', () => {
  const instructor = () =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_INSTRUCT', null, null, null], pp: [15, 0, 0, 0] })

  it('repeats the target last move, charging that move one PP and dealing its damage', () => {
    const state = battle(instructor(), monFor('SPECIES_TREECKO', { moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] }), countRng())
    state.battlers[1]!.lastMove = 'MOVE_TACKLE'
    const out = executeTurn(state, [useMove(1, 'MOVE_INSTRUCT'), null], loopDeps(state, fixedDamage(15)))
    const extra = out.actions.filter((a) => a.battlerId === 1)

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(14) // Instruct's own ppreduce (:1609)
    // The extra attack is the TARGET's Tackle: 20 -> 19, 15 damage to the instructor.
    const extraAttack = extra.find((a) => a.targetDamage !== null)
    expect(extraAttack).toBeDefined()
    expect(extraAttack!.targetDamage).toBe(15)
    expect(ppOf(state, 1)).toBe(19)
    expect(state.battlers[0]!.mon.hp).toBe(85)
  })

  it('moveendfrom MOVEEND_CLEAR_BITS (:1614) skips the choice lock and UPDATE_LAST_MOVES', () => {
    // BattleScript_EffectInstruct ends `moveendfrom MOVEEND_CLEAR_BITS; end`, so cases 0-29 never run:
    // MOVEEND_CHOICE_MOVE (:4547-4568) would otherwise lock a first-use Choice Band holder into Instruct,
    // and MOVEEND_UPDATE_LAST_MOVES (:4723-4772) would otherwise overwrite the user's last-move fields
    // and the global gLastUsedMove with Instruct. Only CLEAR_BITS (:4934-4957) runs.
    const banded = instructor()
    banded.itemId = 'ITEM_CHOICE_BAND'
    const state = battle(banded, monFor('SPECIES_TREECKO', { moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0] }), countRng())
    state.battlers[1]!.lastMove = 'MOVE_SWORDS_DANCE'
    const out = executeTurn(state, [useMove(1, 'MOVE_INSTRUCT'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.choicedMove).toBeNull()
    expect(state.battlers[0]!.lastMove).toBeNull()
    expect(state.battlers[0]!.lastResultingMove).toBeNull()
    expect(state.battlers[0]!.lastPrintedMove).toBeNull()
    expect(state.lastUsedMove).toBeNull()
    // The instructed Swords Dance still ran (+2 Attack, the target's own ladder is untouched).
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('fails at 0 PP, on a forbidden effect (Focus Punch) and with no last move', () => {
    // 0 PP in the slot: `gBattleMons[target].pp[slot]` must be > 0 (:7578).
    const noPp = battle(instructor(), monFor('SPECIES_TREECKO', { moves: ['MOVE_TACKLE', null, null, null], pp: [0, 0, 0, 0] }), countRng())
    noPp.battlers[1]!.lastMove = 'MOVE_TACKLE'
    const noPpOut = executeTurn(noPp, [useMove(1, 'MOVE_INSTRUCT'), null], loopDeps(noPp, fixedDamage(0)))
    expect(actionOf(noPpOut, 0)?.missed).toBe(true)
    expect(ppOf(noPp)).toBe(14)
    // A failed tryinstruct jumps to BattleScript_ButItFailed, whose `goto BattleScript_MoveEnd` (:5945)
    // walks the FULL ladder -- unlike the success tail, so UPDATE_LAST_MOVES does run here.
    expect(noPp.battlers[0]!.lastMove).toBe('MOVE_INSTRUCT')
    expect(noPp.lastUsedMove).toBe('MOVE_INSTRUCT')

    // EFFECT_FOCUS_PUNCH is in sMoveEffectsForbiddenToInstruct.
    const forbidden = battle(instructor(), monFor('SPECIES_TREECKO', { moves: ['MOVE_FOCUS_PUNCH', null, null, null], pp: [20, 0, 0, 0] }), countRng())
    forbidden.battlers[1]!.lastMove = 'MOVE_FOCUS_PUNCH'
    const forbiddenOut = executeTurn(forbidden, [useMove(1, 'MOVE_INSTRUCT'), null], loopDeps(forbidden, fixedDamage(0)))
    expect(actionOf(forbiddenOut, 0)?.missed).toBe(true)
    expect(ppOf(forbidden)).toBe(14)

    const empty = battle(instructor(), monFor('SPECIES_TREECKO'), countRng())
    const emptyOut = executeTurn(empty, [useMove(1, 'MOVE_INSTRUCT'), null], loopDeps(empty, fixedDamage(0)))
    expect(actionOf(emptyOut, 0)?.missed).toBe(true)
    expect(ppOf(empty)).toBe(14)
  })
})

// BattleScript_EffectMeFirst (data/battle_scripts_1.s:2131-2140), VARIOUS_TRY_ME_FIRST
// (src/battle_script_commands.c:7301-7333). Success reads the target's CHOSEN move from
// gBattleStruct->chosenMovePositions[target] (:7308-7321) and queues it as the user's extra attack.
// The 1.5x boost at battle_util.c:7061 is dead in this build: Me First's own
// MOVEEND_CLEAR_BITS (battle_script_commands.c:4948) clears STATUS3_ME_FIRST before the extra
// attack drains, so the hand-derived damage is the unboosted Tackle number.
describe('cycle 129 - Me First (EFFECT_ME_FIRST)', () => {
  function trackedBridge(state: BattleState, rng: RandomSource): { resolver: DamageResolver; seen: { attacker: number; hadMeFirst: boolean }[] } {
    const bridge = bridgeDamage(state, rng)
    const seen: { attacker: number; hadMeFirst: boolean }[] = []
    const resolver: DamageResolver = {
      resolve: (s, a, t, action, ctx) => {
        seen.push({ attacker: a, hadMeFirst: hasFlag(s.battlers[a]!.statuses3, STATUS3_ME_FIRST) })
        return bridge.resolve(s, a, t, action, ctx)
      },
    }
    return { resolver, seen }
  }

  it('a faster user borrows the target chosen Tackle for 19 damage, without the dead 1.5x boost', () => {
    // Two Tackles land: Me First's extra attack (attacker 0 -> 1) and the target's own.
    // ((22 * 40 / 50) + 2) = 19 each; draws per Tackle: accuracy 0, crit 1, roll 0.
    const rng = scriptedRng([0, 1, 0, 0, 1, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_ME_FIRST', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_TREECKO', { moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] }),
      rng,
    )
    const { resolver, seen } = trackedBridge(state, rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_ME_FIRST'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, resolver))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(6)
    expect(seen.length).toBe(2)
    expect(seen[0]!.attacker).toBe(0)
    expect(seen[0]!.hadMeFirst).toBe(false)
    expect(state.battlers[1]!.mon.hp).toBe(81)
    expect(state.battlers[0]!.mon.hp).toBe(81)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ME_FIRST)).toBe(false)
  })

  it('fails for a slower user, a status chosen move and the banned Counter', () => {
    // Slower user: the target acts first, so gCurrentTurnActionNumber > its turn-order number (:7305).
    const slow = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_ME_FIRST', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_TREECKO', { rawStats: FAST_STATS, moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] }),
      countRng(),
    )
    const slowOut = executeTurn(slow, [useMove(1, 'MOVE_ME_FIRST'), useMove(0, 'MOVE_TACKLE')], loopDeps(slow, fixedDamage(0)))
    expect(actionOf(slowOut, 0)?.missed).toBe(true)
    expect(ppOf(slow)).toBe(19)

    // power == 0 -> BattleScript_ButItFailed (:7314-7315).
    const status = battle(
      monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_ME_FIRST', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_TREECKO', { moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0] }),
      countRng(),
    )
    const statusOut = executeTurn(status, [useMove(1, 'MOVE_ME_FIRST'), useMove(0, 'MOVE_SWORDS_DANCE')], loopDeps(status, fixedDamage(0)))
    expect(actionOf(statusOut, 0)?.missed).toBe(true)
    expect(ppOf(status)).toBe(19)

    // Counter is in the banned switch (:7309-7321).
    const counter = battle(
      monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_ME_FIRST', null, null, null], pp: [20, 0, 0, 0] }),
      monFor('SPECIES_TREECKO', { moves: ['MOVE_COUNTER', null, null, null], pp: [20, 0, 0, 0] }),
      countRng(),
    )
    const counterOut = executeTurn(counter, [useMove(1, 'MOVE_ME_FIRST'), useMove(0, 'MOVE_COUNTER')], loopDeps(counter, fixedDamage(0)))
    expect(actionOf(counterOut, 0)?.missed).toBe(true)
    expect(ppOf(counter)).toBe(19)
  })
})

// BattleScript_EffectRecycle (data/battle_scripts_1.s:6363-6371), Cmd_tryrecycleitem
// (src/battle_script_commands.c:12296-12310): restore gBattleStruct->usedHeldItems[party slot][side]
// only when the battler currently holds ITEM_NONE and that recorded item is not ITEM_NONE.
describe('cycle 129 - Recycle (EFFECT_RECYCLE)', () => {
  const recycler = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_RECYCLE', null, null, null], pp: [5, 0, 0, 0], ...overrides })

  it('restores the last consumed item and clears the used slot', () => {
    const state = battle(recycler(), monFor('SPECIES_TREECKO'), countRng())
    state.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
    const out = executeTurn(state, [useMove(0, 'MOVE_RECYCLE'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(state.battlers[0]!.usedHeldItem).toBeNull()
    expect(ppOf(state)).toBe(4)
  })

  it('fails while holding any item, and with no recorded used item', () => {
    const holding = battle(recycler({ itemId: 'ITEM_LIECHI_BERRY' }), monFor('SPECIES_TREECKO'), countRng())
    holding.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
    const holdingOut = executeTurn(holding, [useMove(0, 'MOVE_RECYCLE'), null], loopDeps(holding, fixedDamage(0)))
    expect(actionOf(holdingOut, 0)?.missed).toBe(true)
    expect(holding.battlers[0]!.mon.itemId).toBe('ITEM_LIECHI_BERRY')
    expect(ppOf(holding)).toBe(4)

    const empty = battle(recycler(), monFor('SPECIES_TREECKO'), countRng())
    const emptyOut = executeTurn(empty, [useMove(0, 'MOVE_RECYCLE'), null], loopDeps(empty, fixedDamage(0)))
    expect(actionOf(emptyOut, 0)?.missed).toBe(true)
    expect(empty.battlers[0]!.mon.itemId).toBeNull()
    expect(ppOf(empty)).toBe(4)
  })

  it('a switch drops the used slot, so the incoming party member cannot recycle the outgoing item', () => {
    const state = createBattleState({
      battlers: [
        createBattlerState(0, recycler(), 0),
        createBattlerState(1, monFor('SPECIES_TREECKO'), 0),
      ],
      rng: countRng(),
      playerParty: [
        partyMon('SPECIES_MUDKIP', { moves: ['MOVE_RECYCLE', null, null, null], pp: [5, 0, 0, 0] }),
        partyMon('SPECIES_TREECKO', { moves: ['MOVE_RECYCLE', null, null, null], pp: [5, 0, 0, 0] }),
      ],
    })
    state.battlers[0]!.usedHeldItem = 'ITEM_SITRUS_BERRY'
    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.partyIndex).toBe(1)

    const out = executeTurn(state, [useMove(0, 'MOVE_RECYCLE'), null], loopDeps(state, fixedDamage(0)))
    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(ppOf(state)).toBe(4)
  })
})

// BattleScript_EffectMimic (data/battle_scripts_1.s:4555-4565), Cmd_mimicattackcopy
// (src/battle_script_commands.c:10557-10584). The accuracycheck uses
// NO_ACC_CALC_CHECK_LOCK_ON (:4560), which is not an accuracy calculation and draws no Random()
// (battle_script_commands.c:1403-1411). The mimic rewrite lives on gBattleMons only; a switch
// reloads the party copy (Cmd_switchindataupdate's memcpy, :5014), a PP-only carry-over follows the
// switch-out write at turn.ts:1679.
describe('cycle 129 - Mimic (EFFECT_MIMIC)', () => {
  const mimicUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_MIMIC', null, null, null],
      pp: [10, 0, 0, 0],
      ...overrides,
    })
  const emberTarget = () => {
    return monFor('SPECIES_TREECKO')
  }
  /** Cmd_mimicattackcopy reads gLastMoves[target] (battle_script_commands.c:10562), i.e. the
   * battler's own last-move field, not the mon record. */
  const withEmber = (state: BattleState): BattleState => {
    state.battlers[1]!.lastMove = 'MOVE_EMBER'
    return state
  }

  it('rewrites the Mimic slot to the target last move with min(5, maxPP) PP, and draws nothing', () => {
    const rng = countRng()
    const state = withEmber(battle(mimicUser(), emberTarget(), rng))
    const out = executeTurn(state, [useMove(1, 'MOVE_MIMIC'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.moves[0]).toBe('MOVE_EMBER')
    expect(state.battlers[0]!.mon.moves[1]).toBeNull()
    // Ember's max PP is 20, so the copy gets min(5, 20) = 5 (:10580-10584).
    expect(ppOf(state)).toBe(5)
    expect(state.battlers[0]!.volatiles.mimickedMoves).toBe(1 << 0)
    // NO_ACC_CALC_CHECK_LOCK_ON: no accuracy draw at all (the bug this cycle fixes).
    expect(rng.calls).toBe(0)
    // Cmd_mimicattackcopy sets gChosenMove = 0xFFFF (:10570), so MOVEEND_UPDATE_LAST_MOVES writes
    // gLastMoves/gLastPrintedMoves = 0xFFFF while gLastResultingMoves keeps the executed move.
    expect(state.battlers[0]!.lastMove).toBe('MOVE_UNSET')
    expect(state.battlers[0]!.lastPrintedMove).toBe('MOVE_UNSET')
    expect(state.battlers[0]!.lastResultingMove).toBe('MOVE_MIMIC')
    expect(state.lastUsedMove).toBe('MOVE_MIMIC') // gLastUsedMove = gCurrentMove (:4738)
  })

  it('fails when the move is already known, when Transformed, behind a Substitute or with no last move', () => {
    // Already known (move list includes the target's last move).
    const known = withEmber(battle(mimicUser({ moves: ['MOVE_MIMIC', 'MOVE_EMBER', null, null], pp: [10, 20, 0, 0] }), emberTarget(), countRng()))
    const knownOut = executeTurn(known, [useMove(1, 'MOVE_MIMIC'), null], loopDeps(known, fixedDamage(0)))
    expect(actionOf(knownOut, 0)?.missed).toBe(true)
    expect(known.battlers[0]!.mon.moves).toEqual(['MOVE_MIMIC', 'MOVE_EMBER', null, null])
    expect(ppOf(known)).toBe(9)

    // STATUS2_TRANSFORMED (:10570-10572).
    const transformed = withEmber(battle(mimicUser({ status2: STATUS2_TRANSFORMED }), emberTarget(), countRng()))
    const transformedOut = executeTurn(transformed, [useMove(1, 'MOVE_MIMIC'), null], loopDeps(transformed, fixedDamage(0)))
    expect(actionOf(transformedOut, 0)?.missed).toBe(true)
    expect(ppOf(transformed)).toBe(9)

    // jumpifsubstituteblocks runs before the accuracy operand (:4559): zero draws.
    const subRng = countRng()
    const sub = withEmber(battle(mimicUser(), emberTarget(), subRng))
    sub.battlers[1]!.mon.status2 = STATUS2_SUBSTITUTE
    sub.battlers[1]!.volatiles.substituteHp = 25
    const subOut = executeTurn(sub, [useMove(1, 'MOVE_MIMIC'), null], loopDeps(sub, fixedDamage(0)))
    expect(actionOf(subOut, 0)?.missed).toBe(true)
    expect(subRng.calls).toBe(0)
    expect(ppOf(sub)).toBe(9)

    // gLastMoves[target] == 0 -> fail.
    const noMove = battle(mimicUser(), monFor('SPECIES_TREECKO'), countRng())
    const noMoveOut = executeTurn(noMove, [useMove(1, 'MOVE_MIMIC'), null], loopDeps(noMove, fixedDamage(0)))
    expect(actionOf(noMoveOut, 0)?.missed).toBe(true)
    expect(ppOf(noMove)).toBe(9)
  })

  it('a switch restores the party copy of the moveset', () => {
    const state = withEmber(createBattleState({
      battlers: [createBattlerState(0, mimicUser(), 0), createBattlerState(1, emberTarget(), 0)],
      rng: countRng(),
      playerParty: [
        partyMon('SPECIES_MUDKIP', { moves: ['MOVE_MIMIC', null, null, null], pp: [10, 0, 0, 0] }),
        partyMon('SPECIES_TREECKO'),
      ],
    }))
    executeTurn(state, [useMove(1, 'MOVE_MIMIC'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.moves[0]).toBe('MOVE_EMBER')
    expect(state.sides[0].party[0]!.moves[0]).toBe('MOVE_MIMIC')

    state.battlers[0]!.monToSwitchIntoId = 1
    executeTurn(state, [switchAction, null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.moves[0]).toBe('MOVE_TACKLE')

    state.battlers[0]!.monToSwitchIntoId = 0
    executeTurn(state, [switchAction, null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[0]!.mon.moves[0]).toBe('MOVE_MIMIC')
    expect(state.battlers[0]!.volatiles.mimickedMoves).toBe(0)
    // switch-out writes the battler's PP back to the party (:1678-1679), so the 5 PP survives.
    expect(ppOf(state)).toBe(5)
  })
})

// BattleScript_EffectMirrorMove (data/battle_scripts_1.s:3575-3583), Cmd_trymirrormove
// (src/battle_script_commands.c:9276-9308): gLastMoves[attacker] wins; otherwise a random entry
// of the lastTakenMoveFrom row is chosen with ONE draw (:9300-9302); no candidate deducts PP and
// reports MOVE_RESULT_FAILED (:9305-9307).
describe('cycle 129 - Mirror Move (EFFECT_MIRROR_MOVE)', () => {
  const mirrorUser = () =>
    monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_MIRROR_MOVE', null, null, null], pp: [20, 0, 0, 0] })

  it('copies the direct lastTakenMove and deals the hand-derived Tackle damage', () => {
    // ((22 * 40 / 50) + 2) = 19; draws: called Tackle accuracy 0, crit 1, roll 0.
    const rng = scriptedRng([0, 1, 0])
    const state = battle(mirrorUser(), monFor('SPECIES_TREECKO'), rng)
    state.lastTakenMove[0] = 'MOVE_TACKLE'
    const out = executeTurn(state, [useMove(0, 'MOVE_MIRROR_MOVE'), null], loopDeps(state, bridgeDamage(state, rng)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(actionOf(out, 0)?.targetDamage).toBe(19)
    expect(state.battlers[1]!.mon.hp).toBe(81)
    expect(ppOf(state)).toBe(19) // the called move's ppreduce charges Mirror Move's slot
    expect(rng.calls).toBe(3)
  })

  it('falls back to lastTakenMoveFrom with one selection draw', () => {
    // Draws: selection 0 (only one candidate), then Tackle accuracy 0, crit 1, roll 0.
    const rng = scriptedRng([0, 0, 1, 0])
    const state = battle(mirrorUser(), monFor('SPECIES_TREECKO'), rng)
    state.lastTakenMoveFrom[0]![1] = 'MOVE_TACKLE'
    const out = executeTurn(state, [useMove(0, 'MOVE_MIRROR_MOVE'), null], loopDeps(state, bridgeDamage(state, rng)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(actionOf(out, 0)?.targetDamage).toBe(19)
    expect(rng.calls).toBe(4)
    expect(ppOf(state)).toBe(19)
  })

  it('with nothing to mirror it fails, spends PP and draws nothing', () => {
    const rng = countRng()
    const state = battle(mirrorUser(), monFor('SPECIES_TREECKO'), rng)
    const out = executeTurn(state, [useMove(0, 'MOVE_MIRROR_MOVE'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(19) // failure path ppreduce (:3580)
    expect(rng.calls).toBe(0)
  })
})

// BattleScript_EffectElectrify (data/battle_scripts_1.s:1976-1985), VARIOUS_TRY_ELECTRIFY
// (src/battle_script_commands.c:7338-7347), ProtectSucceeds (:6649-6656):
//
//   static int ProtectSucceeds(int battler) {
//       if (!(gBattleMoves[gLastResultingMoves[battler]].flags & FLAG_PROTECTION_MOVE)) gVolatileStructs[battler].protectUses = 0;
//       if (gVolatileStructs[battler].protectUses > 3) return FALSE;
//       if (sProtectSuccessRates[gVolatileStructs[battler].protectUses] >= Random()) return TRUE;
//       return FALSE;
//   }
//
// sProtectSuccessRates = {65535, 32767, 16383, 8191} (:727). protectUses is the sim's
// volatiles.protectUses. A
// successful Electrify sets STATUS4_ELECTRIFIED on the target, read by GetMoveTypeInternal
// (src/battle_main.c:5196); ENDTURN_ELECTRIFY clears it at the end of the turn.
describe('cycle 129 - Electrify (EFFECT_ELECTRIFY)', () => {
  const electrifier = (spe = 200) =>
    monFor('SPECIES_MUDKIP', { rawStats: { ...FAST_STATS, spe }, moves: ['MOVE_ELECTRIFY', null, null, null], pp: [3, 0, 0, 0] })
  const tackler = (spe = 100) =>
    monFor('SPECIES_TAILLOW', { rawStats: { ...FAST_STATS, spe }, moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] })

  it("turns the slower target's move Electric before it acts: Tackle becomes 19 * 2 = 38", () => {
    // Draws: Electrify accuracy 0; ProtectSucceeds roll 0 (rate 65535, 0 <= 65535);
    // Tackle accuracy 0, crit 1, roll 0. Electric vs Taillow's NORMAL/FLYING is 2x -> ((22*40/50)+2) * 2 = 38.
    const rng = scriptedRng([0, 0, 0, 1, 0])
    const state = battle(electrifier(), tackler(), rng)
    const bridge = bridgeDamage(state, rng)
    const seen: { type: string | null | undefined; electrified: boolean }[] = []
    const resolver: DamageResolver = {
      resolve: (s, a, t, action, ctx) => {
        const r = bridge.resolve(s, a, t, action, ctx)
        seen.push({ type: r.resolvedMoveType, electrified: hasFlag(s.battlers[a]!.statuses4, STATUS4_ELECTRIFIED) })
        return r
      },
    }
    const out = executeTurn(state, [useMove(1, 'MOVE_ELECTRIFY'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, resolver))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(2) // Electrify's 3 PP
    expect(state.battlers[0]!.volatiles.protectUses).toBe(1)
    expect(rng.calls).toBe(5)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.type).toBe('ELECTRIC')
    expect(seen[0]!.electrified).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(62) // 100 - 38
    // ENDTURN_ELECTRIFY (src/battle_util.c:2915-2918) clears the flag after both actions.
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_ELECTRIFIED)).toBe(false)
  })

  it('fails when the target already moved, still costing PP', () => {
    // Target acts first (200 > 100), so gCurrentTurnActionNumber >= its turn-order number (:7343).
    const rng = scriptedRng([0, 1, 0, 0, 0])
    const state = battle(electrifier(100), tackler(200), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_ELECTRIFY'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, bridgeDamage(state, rng)))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(2)
    expect(state.battlers[0]!.volatiles.protectUses).toBe(0)
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_ELECTRIFIED)).toBe(false)
  })

  it('a semi-invulnerable target makes the accuracy roll miss (accuracy 0 -> 101 can never miss otherwise)', () => {
    const rng = scriptedRng([0])
    const state = battle(electrifier(), tackler(), rng)
    // STATUS3_SEMI_INVULNERABLE forces ACCURACY_ALWAYS_MISSES (GetTotalAccuracy :1267-1275), which
    // is a 0 the `(Random() % 100) >= accuracy` test can never pass.
    state.battlers[1]!.statuses3 = STATUS3_SEMI_INVULNERABLE
    const out = executeTurn(state, [useMove(1, 'MOVE_ELECTRIFY'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(2) // BattleScript_PrintMoveMissed also ppreduces
    expect(state.battlers[0]!.volatiles.protectUses).toBe(0)
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_ELECTRIFIED)).toBe(false)
  })

  it('ProtectSucceeds can fail its own roll (last move a protection move, counter 3): 65535 > 8191', () => {
    // Accuracy roll 0, then the protection roll 65535 against sProtectSuccessRates[3] = 8191 (:6652-6654).
    const rng = scriptedRng([0, 65535])
    const state = battle(electrifier(), tackler(), rng)
    state.battlers[0]!.lastMove = 'MOVE_PROTECT' // FLAG_PROTECTION_MOVE keeps the counter
    state.battlers[0]!.volatiles.protectUses = 3
    const out = executeTurn(state, [useMove(1, 'MOVE_ELECTRIFY'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(rng.calls).toBe(2)
    expect(ppOf(state)).toBe(2)
    expect(state.battlers[0]!.volatiles.protectUses).toBe(0) // failure resets the counter
    expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_ELECTRIFIED)).toBe(false)
  })
})

describe('cycle 129 registry', () => {
  const SHIPPED_EFFECTS = [
    'EFFECT_METRONOME',
    'EFFECT_TRICK',
    'EFFECT_QUASH',
    'EFFECT_AFTER_YOU',
    'EFFECT_NATURAL_GIFT',
    'EFFECT_COPYCAT',
    'EFFECT_INSTRUCT',
    'EFFECT_ME_FIRST',
    'EFFECT_RECYCLE',
    'EFFECT_MIMIC',
    'EFFECT_MIRROR_MOVE',
    'EFFECT_ELECTRIFY',
  ]

  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('none of these effects is allowlisted: every one is observable in singles', () => {
    for (const effect of SHIPPED_EFFECTS) expect(findAllowance(effect)).toBeUndefined()
  })

  it.each([
    ['MOVE_METRONOME', 'EFFECT_METRONOME'],
    ['MOVE_TRICK', 'EFFECT_TRICK'],
    ['MOVE_QUASH', 'EFFECT_QUASH'],
    ['MOVE_AFTER_YOU', 'EFFECT_AFTER_YOU'],
    ['MOVE_NATURAL_GIFT', 'EFFECT_NATURAL_GIFT'],
    ['MOVE_COPYCAT', 'EFFECT_COPYCAT'],
    ['MOVE_INSTRUCT', 'EFFECT_INSTRUCT'],
    ['MOVE_ME_FIRST', 'EFFECT_ME_FIRST'],
    ['MOVE_RECYCLE', 'EFFECT_RECYCLE'],
    ['MOVE_MIMIC', 'EFFECT_MIMIC'],
    ['MOVE_MIRROR_MOVE', 'EFFECT_MIRROR_MOVE'],
    ['MOVE_ELECTRIFY', 'EFFECT_ELECTRIFY'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
