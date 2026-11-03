/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 130: nine copy/field-oddity move effects. Every expected number is derived by hand from
// the pinned C named on the assertion that needs it: the script in data/battle_scripts_1.s, the
// command in src/battle_script_commands.c / src/battle_util.c, or the table the sim mirrors.
// Stat stages run 0..12 with neutral 6 (DEFAULT_STAT_STAGE), so "+1" is stage 7 and "+2" is 8.
// Damage shortcut used throughout: at level 50 with Attack == Defense == 100 the formula
// `((2*50/5+2) * power * atk / def / 50) + 2` reduces to `22*power/50 + 2`; a roll of 0 is the
// 100% entry of the 85..100% array, and type effectiveness is a final multiplier.
// Draw order used by the forced scenarios: a move with an accuracy check spends exactly one draw
// on it (accuracy 0 resolves to 101, HITS_IF_POSSIBLE, but still draws once), a plain damage hit
// then spends one crit draw and one damage-roll draw, and NO_ACC_CALC_CHECK_LOCK_ON (Powder,
// Bestow) spends none. Assist/Conversion/Conversion 2/Sketch/Transform/Court Change draw only
// where their own command does.
import { describe, expect, it } from 'vitest'

import type { BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_TAILWIND,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_POISON,
  STATUS2_MULTIPLETURNS,
  STATUS2_POWDER,
  STATUS2_SUBSTITUTE,
  STATUS2_TRANSFORMED,
  STATUS3_SEMI_INVULNERABLE,
  STATUS_FIELD_ION_DELUGE,
  WEATHER_RAIN_TEMPORARY,
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
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

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

const THIS_FILE = 'web/src/engine/sim/cycle130CopyEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const ppOf = (state: BattleState, battlerId = 0, slot = 0) => state.battlers[battlerId]!.mon.pp[slot]

// BattleScript_EffectAssist (data/battle_scripts_1.s:6315-6325),
// Cmd_assistattackselect (src/battle_script_commands.c:12004-12050). The pool is every move of
// every OTHER party member that is not one of the seven forbidden effects, not copycatBanned and
// not a two-turn move; the selection roll is ((Random() & 0xFF) * poolLength) >> 8. The called
// move is run through jumptocalledmove TRUE, so its own ppreduce charges the CHOSEN (Assist) slot
// a second time. Empty party move slots are filled with real moves here so the C's own
// MOVE_NONE-is-a-pool-entry quirk (gBattleMoves[MOVE_NONE].effect is not in the forbidden switch)
// never comes into play.
describe('cycle 130 - Assist (EFFECT_ASSIST)', () => {
  it('copies the first pooled ally move through jumptocalledmove and charges the Assist slot twice', () => {
    // Party slot 1 contributes four moves, so the pool is [Swords Dance, Tackle, Ember, Pound];
    // roll 0 -> ((0 & 0xFF) * 4) >> 8 = 0. Swords Dance needs no accuracy draw, so the only draw
    // is the selection roll. PP: outer ppreduce (:6318) 20 -> 19, called script's ppreduce 19 -> 18.
    const rng = countRng()
    const user = monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_ASSIST', null, null, null],
      pp: [20, 0, 0, 0],
    })
    const state = createBattleState({
      battlers: [createBattlerState(0, user, 0), createBattlerState(1, monFor('SPECIES_TREECKO'), 0)],
      rng,
      playerParty: [
        partyMon('SPECIES_MUDKIP', { moves: ['MOVE_ASSIST', 'MOVE_TACKLE', 'MOVE_TACKLE', 'MOVE_TACKLE'], pp: [20, 20, 20, 20] }),
        partyMon('SPECIES_TREECKO', { moves: ['MOVE_SWORDS_DANCE', 'MOVE_TACKLE', 'MOVE_EMBER', 'MOVE_POUND'], pp: [20, 20, 25, 35] }),
      ],
    })

    const out = executeTurn(state, [useMove(1, 'MOVE_ASSIST'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(ppOf(state)).toBe(18)
    expect(rng.calls).toBe(1)
  })

  it('fails before the selection draw, for one PP, when every ally move is forbidden or two-turn', () => {
    // Protect/Roar are in the forbidden switch (:12016-12024), Solar Beam is a two-turn move
    // (:12031). chooseableMovesNo == 0 jumps to BattleScript_ButItFailed (:12047-12049) without
    // ever calling Random, and only Assist's own ppreduce ran.
    const rng = countRng()
    const user = monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_ASSIST', null, null, null],
      pp: [20, 0, 0, 0],
    })
    const state = createBattleState({
      battlers: [createBattlerState(0, user, 0), createBattlerState(1, monFor('SPECIES_TREECKO'), 0)],
      rng,
      playerParty: [
        partyMon('SPECIES_MUDKIP', { moves: ['MOVE_ASSIST', 'MOVE_TACKLE', 'MOVE_TACKLE', 'MOVE_TACKLE'], pp: [20, 20, 20, 20] }),
        partyMon('SPECIES_TREECKO', { moves: ['MOVE_PROTECT', 'MOVE_SOLAR_BEAM', 'MOVE_PROTECT', 'MOVE_ROAR'], pp: [10, 10, 10, 20] }),
      ],
    })

    const out = executeTurn(state, [useMove(1, 'MOVE_ASSIST'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(0)
  })
})

// BattleScript_EffectPowder (data/battle_scripts_1.s:1121-1132), VARIOUS_SET_POWDER
// (src/battle_script_commands.c:6910-6912), CANCELLER_POWDER_STATUS
// (src/battle_util.c:3468-3477), ENDTURN_POWDER (src/battle_util.c:2919-2921).
// Powder's accuracycheck is NO_ACC_CALC_CHECK_LOCK_ON (:1123), so it draws nothing. The status is
// consumed the same turn by a Fire move BEFORE that move's own accuracy check (the canceller
// ladder runs first), which is why one turn can both set and spend it. The target is Torchic,
// not a Grass type: CANCELLER_POWDER_MOVE (battle_util.c:3456-3466 via IsPowderImmune,
// :3190-3197) would cancel Powder itself against a Grass target and the flag would never be set.
describe('cycle 130 - Powder (EFFECT_POWDER)', () => {
  it("a same-turn Fire move explodes its user for maxHP/4 and never reaches accuracy or damage", () => {
    // Draws: Powder's lock-on check 0, and the cancelled Ember draws nothing at all (its
    // attackcanceler runs before accuracycheck). 100 / 4 = 25.
    const rng = countRng()
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: FAST_STATS,
        moves: ['MOVE_POWDER', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_TORCHIC', { moves: ['MOVE_EMBER', null, null, null], pp: [25, 0, 0, 0] }),
      rng,
    )

    const out = executeTurn(state, [useMove(1, 'MOVE_POWDER'), useMove(0, 'MOVE_EMBER')], loopDeps(state, fixedDamage(50)))
    const ember = actionOf(out, 1)!

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(19)
    expect(ember.cancelledBy).toBe('POWDER_STATUS')
    expect(ember.targetDamage).toBeNull()
    expect(ember.attackerDamage).toBe(25)
    expect(state.battlers[1]!.mon.hp).toBe(75)
    expect(ppOf(state, 1)).toBe(24)
    expect(rng.calls).toBe(0)
    // ENDTURN_POWDER clears the flag at the end of the same turn.
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_POWDER)).toBe(false)
  })

  it('Magic Guard zeroes the self-damage and maxHP 3 truncates to 0, but both moves still cancel', () => {
    // BATTLER_HAS_MAGIC_GUARD (:2384) is IsMagicGuardProtected (:3474): 0 instead of maxHP / 4.
    const guarded = battle(
      monFor('SPECIES_MUDKIP', {
        status2: STATUS2_POWDER,
        abilities: only('ABILITY_MAGIC_GUARD'),
        moves: ['MOVE_EMBER', null, null, null],
        pp: [25, 0, 0, 0],
      }),
      monFor('SPECIES_TREECKO'),
      countRng(),
    )
    const guardedOut = executeTurn(guarded, [useMove(1, 'MOVE_EMBER'), null], loopDeps(guarded, fixedDamage(50)))
    expect(actionOf(guardedOut, 0)?.cancelledBy).toBe('POWDER_STATUS')
    expect(actionOf(guardedOut, 0)?.attackerDamage).toBe(0)
    expect(guarded.battlers[0]!.mon.hp).toBe(100)
    expect(ppOf(guarded)).toBe(24)

    // Integer division in C: 3 / 4 == 0.
    const tiny = battle(
      monFor('SPECIES_MUDKIP', {
        hp: 3,
        maxHp: 3,
        status2: STATUS2_POWDER,
        moves: ['MOVE_EMBER', null, null, null],
        pp: [25, 0, 0, 0],
      }),
      monFor('SPECIES_TREECKO'),
      countRng(),
    )
    const tinyOut = executeTurn(tiny, [useMove(1, 'MOVE_EMBER'), null], loopDeps(tiny, fixedDamage(50)))
    expect(actionOf(tinyOut, 0)?.cancelledBy).toBe('POWDER_STATUS')
    expect(actionOf(tinyOut, 0)?.attackerDamage).toBe(0)
    expect(tiny.battlers[0]!.mon.hp).toBe(3)
  })

  it('already-powdered and semi-invulnerable targets fail after PP, drawing nothing', () => {
    const user = () =>
      monFor('SPECIES_MUDKIP', { rawStats: FAST_STATS, moves: ['MOVE_POWDER', null, null, null], pp: [20, 0, 0, 0] })

    // jumpifstatus2 BS_TARGET, STATUS2_POWDER (:1126) -> BattleScript_ButItFailed.
    const alreadyRng = countRng()
    const already = battle(user(), monFor('SPECIES_TORCHIC', { status2: STATUS2_POWDER }), alreadyRng)
    const alreadyOut = executeTurn(already, [useMove(1, 'MOVE_POWDER'), null], loopDeps(already, fixedDamage(0)))
    expect(actionOf(alreadyOut, 0)?.missed).toBe(true)
    expect(ppOf(already)).toBe(19)
    expect(alreadyRng.calls).toBe(0)

    // NO_ACC_CALC_CHECK_LOCK_ON (:1123) fails on a semi-invulnerable target.
    const semi = battle(user(), monFor('SPECIES_TORCHIC'), countRng())
    semi.battlers[1]!.statuses3 = STATUS3_SEMI_INVULNERABLE
    const semiOut = executeTurn(semi, [useMove(1, 'MOVE_POWDER'), null], loopDeps(semi, fixedDamage(0)))
    expect(actionOf(semiOut, 0)?.missed).toBe(true)
    expect(ppOf(semi)).toBe(19)
    expect(hasFlag(semi.battlers[1]!.mon.status2, STATUS2_POWDER)).toBe(false)
  })
})

// BattleScript_EffectSketch (data/battle_scripts_1.s:4752-4761),
// Cmd_copymovepermanently (src/battle_script_commands.c:10834-10873). The copied move is
// gLastPrintedMoves[target]; the slot is gCurrMovePos (the sim's indexOf('MOVE_SKETCH') for a
// single Sketch slot) and the PP is the copied move's full base PP, not min(5, PP).
describe('cycle 130 - Sketch (EFFECT_SKETCH)', () => {
  it("writes the foe's last printed move and its full base PP into the Sketch slot, and persists to the party", () => {
    const rng = countRng()
    const user = monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_SKETCH', null, null, null],
      pp: [1, 0, 0, 0],
    })
    const state = createBattleState({
      battlers: [createBattlerState(0, user, 0), createBattlerState(1, monFor('SPECIES_TREECKO'), 0)],
      rng,
      playerParty: [partyMon('SPECIES_MUDKIP', { moves: ['MOVE_SKETCH', null, null, null], pp: [1, 0, 0, 0] })],
    })
    state.battlers[1]!.lastPrintedMove = 'MOVE_FLAMETHROWER'

    const out = executeTurn(state, [useMove(1, 'MOVE_SKETCH'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.moves[0]).toBe('MOVE_FLAMETHROWER')
    expect(ppOf(state)).toBe(15) // Flamethrower's base PP, overwriting Sketch's spent 0
    expect(state.sides[0].party[0]!.moves[0]).toBe('MOVE_FLAMETHROWER')
    expect(state.sides[0].party[0]!.pp[0]).toBe(15)
    expect(rng.calls).toBe(0)
  })

  it('fails for Struggle, Sketch, an empty last move, a Transformed user, or an already-known move', () => {
    const sketchUser = (overrides: Partial<SimBattleMon> = {}) =>
      monFor('SPECIES_MUDKIP', {
        rawStats: FAST_STATS,
        moves: ['MOVE_SKETCH', null, null, null],
        pp: [1, 0, 0, 0],
        ...overrides,
      })
    const missedWith = (user: SimBattleMon, lastPrintedMove: string | null) => {
      const state = battle(user, monFor('SPECIES_TREECKO'), countRng())
      state.battlers[1]!.lastPrintedMove = lastPrintedMove
      const out = executeTurn(state, [useMove(1, 'MOVE_SKETCH'), null], loopDeps(state, fixedDamage(0)))
      expect(actionOf(out, 0)?.missed).toBe(true)
      expect(ppOf(state)).toBe(0) // Sketch's own ppreduce already ran (:4755)
      expect(state.battlers[0]!.mon.moves[0]).toBe('MOVE_SKETCH')
      return state
    }

    missedWith(sketchUser(), 'MOVE_STRUGGLE')
    missedWith(sketchUser(), 'MOVE_SKETCH')
    missedWith(sketchUser(), null)
    missedWith(sketchUser({ status2: STATUS2_TRANSFORMED }), 'MOVE_EMBER')

    // The "already knows" scan skips Sketch itself (:10845-10848); Flamethrower in slot 1 fails.
    const knownRng = countRng()
    const known = battle(
      sketchUser({ moves: ['MOVE_SKETCH', 'MOVE_FLAMETHROWER', null, null], pp: [1, 15, 0, 0] }),
      monFor('SPECIES_TREECKO'),
      knownRng,
    )
    known.battlers[1]!.lastPrintedMove = 'MOVE_FLAMETHROWER'
    const knownOut = executeTurn(known, [useMove(1, 'MOVE_SKETCH'), null], loopDeps(known, fixedDamage(0)))
    expect(actionOf(knownOut, 0)?.missed).toBe(true)
    expect(known.battlers[0]!.mon.moves).toEqual(['MOVE_SKETCH', 'MOVE_FLAMETHROWER', null, null])
    expect(ppOf(known)).toBe(0)
    expect(knownRng.calls).toBe(0)
  })
})

// BattleScript_EffectBestow (data/battle_scripts_1.s:1381-1416), VARIOUS_BESTOW
// (src/battle_script_commands.c:7703-7712), VARIOUS_PSYCHO_SHIFT (:7641-7684).
// trybestow does NOT check that the target is itemless (so Bestow overwrites), and passes the
// TARGET's item (not the attacker's) to CanBattlerGetOrLoseItem. The jumpifstatus checks
// BS_TARGET, not BS_ATTACKER, so the status half only runs when the target already has a status.
describe('cycle 130 - Bestow (EFFECT_BESTOW)', () => {
  const bestower = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_BESTOW', null, null, null],
      pp: [15, 0, 0, 0],
      ...overrides,
    })

  it('hands the item over, overwriting a different target item, and draws no accuracy', () => {
    // accuracycheck NO_ACC_CALC_CHECK_LOCK_ON (:1383) -> zero draws. UpdateBattlerItem(attacker,
    // ITEM_NONE) then UpdateBattlerItem(target, gLastUsedItem) (:7709-7710).
    const ontoEmptyRng = countRng()
    const ontoEmpty = battle(bestower({ itemId: 'ITEM_ORAN_BERRY' }), monFor('SPECIES_TREECKO'), ontoEmptyRng)
    const emptyOut = executeTurn(ontoEmpty, [useMove(1, 'MOVE_BESTOW'), null], loopDeps(ontoEmpty, fixedDamage(0)))
    expect(actionOf(emptyOut, 0)?.missed).toBe(false)
    expect(ontoEmpty.battlers[0]!.mon.itemId).toBeNull()
    expect(ontoEmpty.battlers[1]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(ppOf(ontoEmpty)).toBe(14)
    expect(ontoEmptyRng.calls).toBe(0)

    // The C quirk: no check for an existing target item, so a Sitrus Berry is overwritten.
    const ontoSitrus = battle(bestower({ itemId: 'ITEM_ORAN_BERRY' }), monFor('SPECIES_TREECKO', { itemId: 'ITEM_SITRUS_BERRY' }), countRng())
    const sitrusOut = executeTurn(ontoSitrus, [useMove(1, 'MOVE_BESTOW'), null], loopDeps(ontoSitrus, fixedDamage(0)))
    expect(actionOf(sitrusOut, 0)?.missed).toBe(false)
    expect(ontoSitrus.battlers[0]!.mon.itemId).toBeNull()
    expect(ontoSitrus.battlers[1]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(ppOf(ontoSitrus)).toBe(14)
  })

  it('fails for no item, an unlosable Mega Stone, or a Substitute, still spending one PP', () => {
    const noItem = battle(bestower(), monFor('SPECIES_TREECKO'), countRng())
    const noItemOut = executeTurn(noItem, [useMove(1, 'MOVE_BESTOW'), null], loopDeps(noItem, fixedDamage(0)))
    expect(actionOf(noItemOut, 0)?.missed).toBe(true)
    expect(noItem.battlers[1]!.mon.itemId).toBeNull()
    expect(ppOf(noItem)).toBe(14)

    // CanBattlerGetOrLoseItem (src/battle_util.c:8250-8273) rejects HOLD_EFFECT_MEGA_STONE.
    const mega = battle(bestower({ itemId: 'ITEM_SCEPTILITE' }), monFor('SPECIES_TREECKO'), countRng())
    const megaOut = executeTurn(mega, [useMove(1, 'MOVE_BESTOW'), null], loopDeps(mega, fixedDamage(0)))
    expect(actionOf(megaOut, 0)?.missed).toBe(true)
    expect(mega.battlers[0]!.mon.itemId).toBe('ITEM_SCEPTILITE')
    expect(ppOf(mega)).toBe(14)

    // jumpifsubstituteblocks BattleScript_ButItFailed (:1386).
    const sub = battle(bestower({ itemId: 'ITEM_ORAN_BERRY' }), monFor('SPECIES_TREECKO'), countRng())
    sub.battlers[1]!.mon.status2 = STATUS2_SUBSTITUTE
    sub.battlers[1]!.volatiles.substituteHp = 25
    const subOut = executeTurn(sub, [useMove(1, 'MOVE_BESTOW'), null], loopDeps(sub, fixedDamage(0)))
    expect(actionOf(subOut, 0)?.missed).toBe(true)
    expect(sub.battlers[0]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(sub.battlers[1]!.mon.itemId).toBeNull()
    expect(ppOf(sub)).toBe(14)
  })

  it('a statused target takes the item and then VARIOUS_PSYCHO_SHIFT copies the ATTACKER status1', () => {
    // Attacker has no status, target is poisoned: i stays TRUE in :7641-7684, so
    // target.status1 = attacker.status1 & STATUS1_ANY = 0, curing the poison.
    const clean = battle(bestower({ itemId: 'ITEM_ORAN_BERRY' }), monFor('SPECIES_TREECKO', { status1: STATUS1_POISON }), countRng())
    const cleanOut = executeTurn(clean, [useMove(1, 'MOVE_BESTOW'), null], loopDeps(clean, fixedDamage(0)))
    expect(actionOf(cleanOut, 0)?.missed).toBe(false)
    expect(clean.battlers[1]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(clean.battlers[1]!.mon.status1).toBe(0)

    // A burn cannot pass to an already-statused target: CanBeBurned (:7656-7664) fails because
    // the target already has STATUS1_ANY, so i = FALSE and the target keeps its poison.
    const burned = battle(
      bestower({ itemId: 'ITEM_ORAN_BERRY', status1: STATUS1_BURN }),
      monFor('SPECIES_TREECKO', { status1: STATUS1_POISON }),
      countRng(),
    )
    const burnedOut = executeTurn(burned, [useMove(1, 'MOVE_BESTOW'), null], loopDeps(burned, fixedDamage(0)))
    expect(actionOf(burnedOut, 0)?.missed).toBe(false)
    expect(burned.battlers[1]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
    expect(burned.battlers[1]!.mon.status1).toBe(STATUS1_POISON)
  })
})

// BattleScript_EffectIonDeluge (data/battle_scripts_1.s:2228-2238), reader GetMoveTypeInternal
// (src/battle_main.c:5196-5197: a Normal move becomes Electric while STATUS_FIELD_ION_DELUGE is
// set), ENDTURN_ION_DELUGE (src/battle_util.c:2171-2174). Ion Deluge's accuracycheck is
// ACC_CURR_MOVE (:2230); its declared accuracy is 0, so it spends one draw and always hits.
describe('cycle 130 - Ion Deluge (EFFECT_ION_DELUGE)', () => {
  it('makes a same-turn Normal move Electric: Tackle vs a Water user doubles from 19 to 38', () => {
    // Draws: Ion Deluge accuracy 0, Tackle accuracy 0, crit 1 (no crit), damage roll 0.
    // Tackle: 22*40/50 + 2 = 19; Electric vs Water is 2x -> 38.
    const rng = scriptedRng([0, 0, 1, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: FAST_STATS,
        moves: ['MOVE_ION_DELUGE', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_TREECKO', { moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] }),
      rng,
    )

    const out = executeTurn(
      state,
      [useMove(1, 'MOVE_ION_DELUGE'), useMove(0, 'MOVE_TACKLE')],
      loopDeps(state, bridgeDamage(state, rng)),
    )

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(19)
    expect(actionOf(out, 1)?.targetDamage).toBe(38)
    expect(state.battlers[0]!.mon.hp).toBe(62)
    expect(rng.calls).toBe(4)
    // ENDTURN_ION_DELUGE clears the field bit at the end of the same turn.
    expect(hasFlag(state.field.statuses, STATUS_FIELD_ION_DELUGE)).toBe(false)
  })

  it('leaves a non-Normal move alone: Brine stays Water and deals its halved 16', () => {
    // Brine: 22*70/50 + 2 = 32; Water vs Water is 0.5x -> 16. If the field converted it to
    // Electric it would be 32*2 = 64.
    const rng = scriptedRng([0, 0, 1, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: FAST_STATS,
        moves: ['MOVE_ION_DELUGE', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_TREECKO', { moves: ['MOVE_BRINE', null, null, null], pp: [10, 0, 0, 0] }),
      rng,
    )

    const out = executeTurn(
      state,
      [useMove(1, 'MOVE_ION_DELUGE'), useMove(0, 'MOVE_BRINE')],
      loopDeps(state, bridgeDamage(state, rng)),
    )

    expect(actionOf(out, 1)?.targetDamage).toBe(16)
    expect(rng.calls).toBe(4)
  })

  it('a missed Ion Deluge leaves the field untouched: the same-turn Tackle stays Normal for 19', () => {
    // The target is semi-invulnerable, so checkAccuracy forces a miss after spending its one
    // draw. The target can still act, and its Tackle resolves as Normal (19, not 38).
    const rng = scriptedRng([0, 0, 1, 0])
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: FAST_STATS,
        moves: ['MOVE_ION_DELUGE', null, null, null],
        pp: [20, 0, 0, 0],
      }),
      monFor('SPECIES_TREECKO', { moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] }),
      rng,
    )
    state.battlers[1]!.statuses3 = STATUS3_SEMI_INVULNERABLE

    const out = executeTurn(
      state,
      [useMove(1, 'MOVE_ION_DELUGE'), useMove(0, 'MOVE_TACKLE')],
      loopDeps(state, bridgeDamage(state, rng)),
    )

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state)).toBe(19)
    expect(actionOf(out, 1)?.targetDamage).toBe(19)
    expect(state.battlers[0]!.mon.hp).toBe(81)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_ION_DELUGE)).toBe(false)
    expect(rng.calls).toBe(4)
  })
})

// BattleScript_EffectCourtChange (data/battle_scripts_1.s:24-32),
// VARIOUS_SWAP_SIDE_EFFECTS (src/battle_script_commands.c:8325-8378).
// SIDE_STATUS_SWAPPABLE (include/constants/battle.h:356-357) is hazards + screens + Safeguard +
// Mist + Tailwind + Smokescreen; Lucky Chant is excluded from the status word even though its
// timer is swapped, and the *BattlerId fields are flipped with BATTLE_OPPOSITE (id ^ 1).
describe('cycle 130 - Court Change (EFFECT_COURT_CHANGE)', () => {
  it('swaps screens, hazards, timers and the battler-id fields, leaving weather alone', () => {
    const rng = countRng()
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: FAST_STATS,
        moves: ['MOVE_COURT_CHANGE', null, null, null],
        pp: [10, 0, 0, 0],
      }),
      monFor('SPECIES_TREECKO'),
      rng,
    )
    state.sides[0].statuses = SIDE_STATUS_REFLECT | SIDE_STATUS_SPIKES
    state.sides[0].timers.reflectTimer = 5
    state.sides[0].timers.spikesAmount = 2
    state.sides[0].timers.luckyChantTimer = 4
    state.sides[0].timers.hotCoals = true
    state.sides[0].timers.caltrops = true
    state.sides[0].timers.swampTimer = 3
    state.sides[0].timers.stickyWebTimer = 2
    state.sides[1].statuses = SIDE_STATUS_TAILWIND
    state.sides[1].timers.tailwindTimer = 3
    state.sides[1].timers.stealthRockType = 5
    state.field.weather = WEATHER_RAIN_TEMPORARY

    const out = executeTurn(state, [useMove(1, 'MOVE_COURT_CHANGE'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(0)

    // SIDE_STATUS_SWAPPABLE bits (:8328-8332).
    expect(state.sides[0].statuses).toBe(SIDE_STATUS_TAILWIND)
    expect(state.sides[1].statuses).toBe(SIDE_STATUS_REFLECT | SIDE_STATUS_SPIKES)

    // Timers and hazard amounts (:8334-8350). Side 1 ends the turn holding Reflect and
    // Tailwind, and ClearStartedFlags (turn.ts:722) wiped started.* at the start of the turn,
    // so ENDTURN_REFLECT / ENDTURN_TAILWIND tick each of them down once: 5 -> 4 and 3 -> 2.
    // Lucky Chant's timer swaps but SIDE_STATUS_LUCKY_CHANT is not in SIDE_STATUS_SWAPPABLE,
    // so ENDTURN_LUCKY_CHANT never runs and its 4 survives untouched.
    expect(state.sides[0].timers.reflectTimer).toBe(0)
    expect(state.sides[1].timers.reflectTimer).toBe(4)
    expect(state.sides[0].timers.spikesAmount).toBe(0)
    expect(state.sides[1].timers.spikesAmount).toBe(2)
    expect(state.sides[0].timers.tailwindTimer).toBe(2)
    expect(state.sides[1].timers.tailwindTimer).toBe(0)
    expect(state.sides[0].timers.stealthRockType).toBe(5)
    expect(state.sides[1].timers.stealthRockType).toBe(0)
    expect(state.sides[0].timers.luckyChantTimer).toBe(0)
    expect(state.sides[1].timers.luckyChantTimer).toBe(4)
    expect(state.sides[0].timers.hotCoals).toBe(false)
    expect(state.sides[1].timers.hotCoals).toBe(true)
    expect(state.sides[0].timers.caltrops).toBe(false)
    expect(state.sides[1].timers.caltrops).toBe(true)
    // ENDTURN_SWAMP likewise ticks the side that ends the turn holding it: 3 -> 2.
    expect(state.sides[0].timers.swampTimer).toBe(0)
    expect(state.sides[1].timers.swampTimer).toBe(2)

    // Neither side has foamyWeb, so the sticky-web TIMER swaps (:8352-8357).
    expect(state.sides[0].timers.stickyWebTimer).toBe(0)
    expect(state.sides[1].timers.stickyWebTimer).toBe(2)

    // UPDATE_COURTCHANGED_BATTLER: every default id 0 becomes 0 ^ 1 = 1 (:8359-8374).
    expect(state.sides[0].timers.reflectBattlerId).toBe(1)
    expect(state.sides[1].timers.reflectBattlerId).toBe(1)
    expect(state.sides[0].timers.tailwindBattlerId).toBe(1)
    expect(state.sides[1].timers.tailwindBattlerId).toBe(1)
    expect(state.sides[0].timers.luckyChantBattlerId).toBe(1)
    expect(state.sides[1].timers.luckyChantBattlerId).toBe(1)

    // The swap is side-effect-only: the weather word is not one of the moved fields.
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
  })

  it('on two empty sides it creates no hazard or screen; only the battler-id flip happens', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        rawStats: FAST_STATS,
        moves: ['MOVE_COURT_CHANGE', null, null, null],
        pp: [10, 0, 0, 0],
      }),
      monFor('SPECIES_TREECKO'),
      countRng(),
    )
    state.field.weather = WEATHER_RAIN_TEMPORARY

    executeTurn(state, [useMove(1, 'MOVE_COURT_CHANGE'), null], loopDeps(state, fixedDamage(0)))

    expect(state.sides[0].statuses).toBe(0)
    expect(state.sides[1].statuses).toBe(0)
    expect(state.sides[0].timers.reflectTimer).toBe(0)
    expect(state.sides[1].timers.reflectTimer).toBe(0)
    expect(state.sides[0].timers.spikesAmount).toBe(0)
    expect(state.sides[1].timers.spikesAmount).toBe(0)
    expect(state.sides[0].timers.reflectBattlerId).toBe(1)
    expect(state.sides[1].timers.reflectBattlerId).toBe(1)
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
  })
})

// BattleScript_EffectConversion (data/battle_scripts_1.s:3831-3868),
// Cmd_tryconversiontypechange (src/battle_script_commands.c:10205-10236).
// The command inspects the moves in slot order, skips TYPE_MYSTERY, and SETS the type from the
// FIRST usable move; if that first move's types already match, it breaks and changes nothing
// instead of trying a later move. Both paths then run the same ConversionBoost quirk:
// jumpifstat STAT_ATK (< MAX) before raising SpAtk and Speed by one each.
describe('cycle 130 - Conversion (EFFECT_CONVERSION)', () => {
  const conversionUser = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_CONVERSION', null, null, null],
      pp: [20, 0, 0, 0],
      ...overrides,
    })

  it('takes the first move slot: Ember makes Water into Fire/Fire and boosts SpAtk/Speed', () => {
    // Conversion sits in slot 1 so the slot-0 Ember is the FIRST usable move. The loop reads
    // every slot including the move being used, so this ordering is the only way to show a
    // non-Normal result (a Conversion in slot 0 would pick its own NORMAL type).
    const rng = countRng()
    const state = battle(
      conversionUser({ moves: ['MOVE_EMBER', 'MOVE_CONVERSION', 'MOVE_TACKLE', null], pp: [25, 20, 35, 0] }),
      monFor('SPECIES_TREECKO'),
      rng,
    )

    const out = executeTurn(state, [useMove(1, 'MOVE_CONVERSION'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.types).toEqual(['FIRE', 'FIRE', 'MYSTERY'])
    // Quirk kept: the gate reads STAT_ATK (still 6), but the boosts are SpAtk and Speed.
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(ppOf(state, 0, 1)).toBe(19)
    expect(rng.calls).toBe(0)
  })

  it('does not fall through to a later move when the first one already matches', () => {
    // Already Fire (type2 MYSTERY falls back to type1): Ember matches, so the loop breaks at
    // :10224 and Tackle is never considered. The boost path still runs and succeeds.
    const state = battle(
      conversionUser({
        types: ['FIRE', 'MYSTERY', 'MYSTERY'],
        moves: ['MOVE_EMBER', 'MOVE_CONVERSION', 'MOVE_TACKLE', null],
        pp: [25, 20, 35, 0],
      }),
      monFor('SPECIES_TREECKO'),
      countRng(),
    )

    const out = executeTurn(state, [useMove(1, 'MOVE_CONVERSION'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.types).toEqual(['FIRE', 'MYSTERY', 'MYSTERY'])
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(ppOf(state, 0, 1)).toBe(19)
  })

  it('skips a TYPE_MYSTERY move; a maxed ATK+SPEED with no type change fails', () => {
    // Present is TYPE_MYSTERY, so the loop moves on to slot 1's Conversion (NORMAL). Were
    // Present not skipped the written type would be MYSTERY.
    const skipped = battle(
      conversionUser({ moves: ['MOVE_PRESENT', 'MOVE_CONVERSION', 'MOVE_EMBER', null], pp: [15, 20, 25, 0] }),
      monFor('SPECIES_TREECKO'),
      countRng(),
    )
    const skippedOut = executeTurn(skipped, [useMove(1, 'MOVE_CONVERSION'), null], loopDeps(skipped, fixedDamage(0)))
    expect(actionOf(skippedOut, 0)?.missed).toBe(false)
    expect(skipped.battlers[0]!.mon.types).toEqual(['NORMAL', 'NORMAL', 'MYSTERY'])
    expect(ppOf(skipped, 0, 1)).toBe(19)

    // Both STAT_ATK and STAT_SPEED at MAX -> BattleScript_CantRaiseMultipleStats: failure.
    const maxed = battle(
      conversionUser({
        types: ['FIRE', 'MYSTERY', 'MYSTERY'],
        moves: ['MOVE_EMBER', 'MOVE_CONVERSION', null, null],
        pp: [25, 20, 0, 0],
      }),
      monFor('SPECIES_TREECKO'),
      countRng(),
    )
    maxed.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    maxed.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    const maxedOut = executeTurn(maxed, [useMove(1, 'MOVE_CONVERSION'), null], loopDeps(maxed, fixedDamage(0)))
    expect(actionOf(maxedOut, 0)?.missed).toBe(true)
    expect(maxed.battlers[0]!.mon.types).toEqual(['FIRE', 'MYSTERY', 'MYSTERY'])
    expect(maxed.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(maxed, 0, 1)).toBe(19)
  })
})

// BattleScript_EffectConversion2 (data/battle_scripts_1.s:4728-4737),
// Cmd_settypetorandomresistance (src/battle_script_commands.c:10788-10825).
// The resist mask is built over the 20 gTypes with GetTypeModifier(lastHitByType, type); the
// redraw loop is `i = Random() % NUMBER_OF_MON_TYPES`, discarding non-mask bits and types the
// user already has. For a Fire last hit the 0x/0.5x defenders are ROCK (5), FIRE (10), WATER
// (11) and DRAGON (16); NORMAL is neutral, so bit 0 is never in the mask.
describe('cycle 130 - Conversion 2 (EFFECT_CONVERSION_2)', () => {
  const conversion2User = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_CONVERSION_2', null, null, null],
      pp: [20, 0, 0, 0],
      ...overrides,
    })
  const hitByFire = (state: BattleState): BattleState => {
    state.battlers[0]!.lastLandedMove = 'MOVE_EMBER'
    state.battlers[0]!.lastHitByType = 'FIRE'
    state.battlers[0]!.lastHitBy = 1
    return state
  }

  it('redraws a neutral type and an already-owned resist, then becomes ROCK on the third draw', () => {
    // Draws: 0 (NORMAL, not in the mask), 11 (WATER resists Fire but the user is already Water,
    // so the bit is removed), 5 (ROCK -> SET_BATTLER_TYPE). Three draws.
    const rng = scriptedRng([0, 11, 5])
    const state = hitByFire(battle(conversion2User(), monFor('SPECIES_TREECKO'), rng))

    const out = executeTurn(state, [useMove(1, 'MOVE_CONVERSION_2'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.types).toEqual(['ROCK', 'ROCK', 'MYSTERY'])
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(3)
  })

  it('no last landed move changes no type; with maxed ATK+SPEED it fails for one PP and no draws', () => {
    const rng = countRng()
    const state = battle(conversion2User(), monFor('SPECIES_TREECKO'), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE

    const out = executeTurn(state, [useMove(1, 'MOVE_CONVERSION_2'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(19)
    expect(rng.calls).toBe(0)
  })

  it('a two-turn move still charging on the last hitter is ignored (IsTwoTurnsMove + STATUS2_MULTIPLETURNS)', () => {
    const rng = countRng()
    const state = hitByFire(battle(conversion2User(), monFor('SPECIES_TREECKO'), rng))
    state.battlers[0]!.lastLandedMove = 'MOVE_SOLAR_BEAM'
    state.battlers[0]!.lastHitByType = 'GRASS'
    state.battlers[1]!.mon.status2 = STATUS2_MULTIPLETURNS

    const out = executeTurn(state, [useMove(1, 'MOVE_CONVERSION_2'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[0]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(rng.calls).toBe(0)
  })
})

// BattleScript_EffectTransform (data/battle_scripts_1.s:4276-4290),
// Cmd_transformdataexecution (src/battle_script_commands.c:10482-10533).
// Copies species/rawStats (not HP)/types/speedDown/abilities/moves/statStages, sets STATUS2_
// TRANSFORMED, clears the disable/mimic/used-move volatiles, gives every copied move
// min(5, basePP) PP, and finishes with `switchinabilities BS_ATTACKER`.
describe('cycle 130 - Transform (EFFECT_TRANSFORM)', () => {
  const transformer = (overrides: Partial<SimBattleMon> = {}) =>
    monFor('SPECIES_MUDKIP', {
      rawStats: FAST_STATS,
      moves: ['MOVE_TRANSFORM', null, null, null],
      pp: [10, 0, 0, 0],
      hp: 80,
      maxHp: 80,
      ...overrides,
    })
  const targetMon = () =>
    monFor('SPECIES_TREECKO', {
      rawStats: { atk: 110, def: 90, spatk: 120, spdef: 95, spe: 130 },
      moves: ['MOVE_FLAMETHROWER', 'MOVE_SPIT_UP', null, null],
      pp: [15, 2, 0, 0],
      abilities: only('ABILITY_DRIZZLE'),
    })

  it('copies species/stats/types/abilities/moves/stages with min(5, PP), keeps HP, and runs the new switch-in ability', () => {
    const rng = countRng()
    const state = battle(transformer(), targetMon(), rng)
    state.battlers[1]!.mon.statStages[STAT_ATK] = 8
    state.battlers[1]!.mon.statStages[STAT_DEF] = 4
    state.battlers[1]!.mon.statStages[STAT_SPEED] = 9

    const out = executeTurn(state, [useMove(1, 'MOVE_TRANSFORM'), null], loopDeps(state, fixedDamage(0)))

    expect(actionOf(out, 0)?.missed).toBe(false)
    // Slot 0 now holds the copied Flamethrower at min(5, 15) PP; Transform's own spend is
    // overwritten by the copy.
    expect(ppOf(state)).toBe(5)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(state.battlers[0]!.mon.rawStats).toEqual({ atk: 110, def: 90, spatk: 120, spdef: 95, spe: 130 })
    expect(state.battlers[0]!.mon.types).toEqual(['GRASS', 'MYSTERY', 'MYSTERY'])
    expect(state.battlers[0]!.mon.abilities).toEqual(only('ABILITY_DRIZZLE'))
    expect(state.battlers[0]!.mon.moves).toEqual(['MOVE_FLAMETHROWER', 'MOVE_SPIT_UP', null, null])
    // Flamethrower 15 -> 5; Spit Up 2 stays 2 (min(5, basePP)); empty slots 0.
    expect(state.battlers[0]!.mon.pp).toEqual([5, 2, 0, 0])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(8)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(4)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(9)
    // HP/maxHP are NOT copied (:10492-10532).
    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[0]!.mon.maxHp).toBe(80)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_TRANSFORMED)).toBe(true)
    // switchinabilities BS_ATTACKER (:4289) runs the copied Drizzle: rain for 8 turns.
    expect(hasFlag(state.field.weather, WEATHER_RAIN_TEMPORARY)).toBe(true)
    // The copy left both battlers at Speed 130, so ENDTURN_ORDER's GetFastestBattler breaks the
    // tie with one draw (turnOrder.ts:583 via sortBattlersBySpeed). No other step draws.
    expect(rng.calls).toBe(1)
  })

  it('fails against an already Transformed, semi-invulnerable, or Illusion-hidden target', () => {
    const tries = (mutate: (state: BattleState) => void) => {
      const state = battle(transformer(), targetMon(), countRng())
      mutate(state)
      const out = executeTurn(state, [useMove(1, 'MOVE_TRANSFORM'), null], loopDeps(state, fixedDamage(0)))
      expect(actionOf(out, 0)?.missed).toBe(true)
      expect(ppOf(state)).toBe(9)
      expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
      expect(state.battlers[0]!.mon.moves).toEqual(['MOVE_TRANSFORM', null, null, null])
      expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_TRANSFORMED)).toBe(false)
      expect(hasFlag(state.field.weather, WEATHER_RAIN_TEMPORARY)).toBe(false)
    }

    tries((state) => {
      state.battlers[1]!.mon.status2 = STATUS2_TRANSFORMED
    })
    tries((state) => {
      state.battlers[1]!.statuses3 = STATUS3_SEMI_INVULNERABLE
    })
    tries((state) => {
      // GetIllusionMonPtr (src/battle_util.c:8281-8292) is non-null while illusion.on is set.
      state.battlers[1]!.illusion = { set: true, on: true, broken: false, partyId: 0 }
    })
  })
})

describe('cycle 130 registry', () => {
  const SHIPPED_EFFECTS = [
    'EFFECT_ASSIST',
    'EFFECT_POWDER',
    'EFFECT_SKETCH',
    'EFFECT_BESTOW',
    'EFFECT_ION_DELUGE',
    'EFFECT_COURT_CHANGE',
    'EFFECT_CONVERSION',
    'EFFECT_CONVERSION_2',
    'EFFECT_TRANSFORM',
  ]

  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('none of these effects is allowlisted: all nine are singles-observable', () => {
    for (const effect of SHIPPED_EFFECTS) expect(findAllowance(effect)).toBeUndefined()
  })

  it.each([
    ['MOVE_ASSIST', 'EFFECT_ASSIST'],
    ['MOVE_POWDER', 'EFFECT_POWDER'],
    ['MOVE_SKETCH', 'EFFECT_SKETCH'],
    ['MOVE_BESTOW', 'EFFECT_BESTOW'],
    ['MOVE_ION_DELUGE', 'EFFECT_ION_DELUGE'],
    ['MOVE_COURT_CHANGE', 'EFFECT_COURT_CHANGE'],
    ['MOVE_CONVERSION', 'EFFECT_CONVERSION'],
    ['MOVE_CONVERSION_2', 'EFFECT_CONVERSION_2'],
    ['MOVE_TRANSFORM', 'EFFECT_TRANSFORM'],
  ])('%s has %s', (moveId, effect) => expect(effectOf(moveId)).toBe(effect))
})
