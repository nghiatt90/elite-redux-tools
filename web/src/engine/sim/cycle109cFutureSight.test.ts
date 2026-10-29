/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 109c: Future Sight / Doom Desire delayed attack and Forewarn.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - struct WishFutureKnock (include/battle.h:333-341): futureSightCounter/Attacker/Move/Power
//   are per battler, index-parallel arrays of MAX_BATTLERS_COUNT.
// - Cmd_trysetfutureattack (src/battle_script_commands.c:11483-11500): fails when the target
//   counter is nonzero; otherwise sets the side flag, records gCurrentMove / its move-table
//   power / gBattlerAttacker, sets the counter to 3, and prints the Doom Desire or Future
//   Sight message.
// - BattleScript_EffectFutureSight (data/battle_scripts_1.s:5692-5701): attackcanceler,
//   attackstring, ppreduce, trysetfutureattack BattleScript_ButItFailed, animation, message,
//   goto BattleScript_MoveEnd. No accuracy check, no damage on the use turn.
// - HandleWishPerishSongOnTurnEnd state 0 (src/battle_util.c:2998-3031): plain battler index
//   order, skip absent slots, `--counter == 0 && hp != 0` schedules the hit, and the side
//   flag clears only when this battler's counter AND its flank partner's (`^ BIT_FLANK`,
//   BIT_FLANK == 2, include/constants/battle.h:46) are both 0.
// - BattleScript_MonTookFutureAttack (data/battle_scripts_1.s:8008-8049): accuracycheck,
//   damagecalc, adjustdamage, HP update, tryfaintmon, then `moveendcase MOVEEND_RAGE` and
//   `moveendfromto MOVEEND_ITEM_EFFECTS_ALL, MOVEEND_UPDATE_LAST_MOVES`. No attackcanceler,
//   no ppreduce, no secondary effect.
// - Cmd_damagecalc (src/battle_script_commands.c:1605-1610): the recorded futureSightPower
//   is the fixedBasePower for the delayed hit.
// - Impl<ABILITY_FOREWARN>.onEntry (src/abilities.cc:1700-1715): opposite battler, swapped to
//   its partner when that opposite is dead OR already has a pending Future Sight; the two
//   CHECKs fail silently; then flag + move Future Sight + power 80 + attacker holder + counter 3.
import { describe, expect, it } from 'vitest'

import { DEFAULT_STAT_STAGE, SIDE_STATUS_FUTUREATTACK, STAT_EVASION, hasFlag } from './constants'
import { createBattleState, createBattlerState } from './create'
import type { SimMoveData } from './dataContext'
import { loadSimData } from './driver/loadSimData'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { SwitchInAbilityDeps } from './switchInAbility'
import { applySwitchInAbilities } from './switchInAbility'
import type { DamageResolveContext, DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const GROUNDING = simData.grounding
const RATIOS = simData.statStageRatios

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as
    | { types: string[]; abilities: (string | null)[]; innates: (string | null)[] }
    | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_FUTURE_SIGHT', null, null, null],
    pp: [5, 0, 0, 0],
    hp: 1000,
    maxHp: 1000,
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

function scriptedRng(rolls: number[]): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return rolls[rng.calls - 1] ?? 0
    },
  }
  return rng
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource = { random16: () => 0 }): BattleState {
  // The two battlers must not tie on Speed: getFastestBattler (turnOrder.ts:583) breaks a
  // Speed tie by drawing Random() % 2 from the SAME state.rng the accuracy/crit/damage rolls
  // come from, which would put stray draws in front of every assertion below. `monFor` gives
  // every mon Speed 100, so the second battler is made one point slower (it moves second,
  // as it does in a real singles turn).
  const slower = { ...b, rawStats: { ...b.rawStats, spe: b.rawStats.spe - 1 } }
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, slower, 0)],
    rng,
  })
}

/** `TurnOutcome.actions` is in turn order, not battler order -- look up by battler id. */
function actionOf(out: TurnOutcome, battlerId: number) {
  const action = out.actions.find((a) => a.battlerId === battlerId)
  if (!action) throw new Error(`no action for battler ${battlerId}`)
  return action
}

const move = (id: string): SimMoveData => {
  const m = DATA_CONTEXT.move(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return m
}

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ?? 'NORMAL',
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

/** A resolver whose damage IS the power it was handed: the turn loop's power override is
 * visible directly as an HP number. `state.currentExtraAttack` is set only around the call
 * (runFutureSightCountdown parks the recorded power there), so reading it here proves the
 * stored power, not the move table's, reached the damage step. */
interface EchoResolver extends DamageResolver {
  calls: Array<{ attackerId: number; targetId: number; move: string; power: number }>
}

function powerEchoResolver(): EchoResolver {
  const calls: EchoResolver['calls'] = []
  return {
    calls,
    resolve(state, attackerId, targetId, action, _context?: DamageResolveContext) {
      const power = state.currentExtraAttack?.movePower ?? action.chosenMove?.power ?? 0
      calls.push({ attackerId, targetId, move: action.chosenMove?.id ?? '', power })
      return { targetDamage: power, attackerDamage: null, unmodelled: [] }
    },
  }
}

/** Draws crit then the damage roll inside resolve, the order the real resolver uses
 * (Cmd_critcalc then Cmd_damagecalc). The accuracy draw is made by the turn loop BEFORE
 * this is called, so a scripted [accuracy, crit, roll] sequence lands in that order. */
interface DrawOrderResolver extends DamageResolver {
  calls: Array<{ critRoll: number; roll: number; power: number }>
}

function drawOrderResolver(): DrawOrderResolver {
  const calls: DrawOrderResolver['calls'] = []
  return {
    calls,
    resolve(state, _attackerId, _targetId, action, _context?: DamageResolveContext) {
      const critRoll = state.rng.random16()
      const roll = state.rng.random16() % 16
      const power = state.currentExtraAttack?.movePower ?? action.chosenMove?.power ?? 0
      calls.push({ critRoll, roll, power })
      return { targetDamage: power + roll, attackerDamage: null, unmodelled: [] }
    },
  }
}

function loopDeps(damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: simData.turnOrder,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
  }
}

const SWITCH_DEPS: SwitchInAbilityDeps = { dataContext: DATA_CONTEXT, grounding: GROUNDING, statStageRatios: RATIOS }

const FS = move('MOVE_FUTURE_SIGHT')
const DD = move('MOVE_DOOM_DESIRE')

describe('Cycle 109c - Future Sight use turn (Cmd_trysetfutureattack)', () => {
  it('records counter 3 (decremented to 2 at the same turn-end), move, attacker, power 120 and the side flag; deals no damage and draws no RNG', () => {
    // Derivation for the use turn:
    //   Cmd_trysetfutureattack: futureSightCounter[target] = 3, move = gCurrentMove,
    //   power = gBattleMoves[gCurrentMove].power = 120 (moves.json MOVE_FUTURE_SIGHT),
    //   attacker = gBattlerAttacker, gSideStatuses[side] |= SIDE_STATUS_FUTUREATTACK.
    //   No accuracycheck and no damagecalc in BattleScript_EffectFutureSight (s:5692-5701).
    //   The same turn's HandleWishPerishSongOnTurnEnd state 0 then runs --counter (battle_util.c:3005),
    //   so the value observed after executeTurn is 3 - 1 = 2.
    const rng = scriptedRng([])
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), rng)
    const damage = powerEchoResolver()
    const out = executeTurn(state, [useMove(1, FS), null], loopDeps(damage))

    expect(state.field.futureSightCounter[1]).toBe(2)
    expect(state.field.futureSightMove[1]).toBe('MOVE_FUTURE_SIGHT')
    expect(state.field.futureSightPower[1]).toBe(120)
    expect(state.field.futureSightAttacker[1]).toBe(0)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(true)

    // No damage on the use turn and no accuracy/crit/roll draw: nothing called the resolver.
    expect(damage.calls).toHaveLength(0)
    expect(state.battlers[1]!.mon.hp).toBe(1000)
    expect(actionOf(out, 0).targetDamage).toBeNull()
    expect(rng.calls).toBe(0)

    // ppreduce precedes trysetfutureattack (s:5696-5697).
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
  })

  it('a second use while the counter is nonzero fails and still spends PP', () => {
    // Cmd_trysetfutureattack: `if (futureSightCounter[target] != 0) jump failure`
    // (battle_script_commands.c:11484-11485). ppreduce is BEFORE it, so the PP is spent.
    // Turn 1 leaves the counter at 3 - 1 = 2; turn 2's failed use runs before the turn-end
    // decrement, which takes 2 -> 1, so no delayed hit fires here.
    const rng = scriptedRng([])
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), rng)
    const damage = powerEchoResolver()
    const deps = loopDeps(damage)

    executeTurn(state, [useMove(1, FS), null], deps)
    expect(state.field.futureSightCounter[1]).toBe(2)

    const out = executeTurn(state, [useMove(1, FS), null], deps)
    expect(actionOf(out, 0).missed).toBe(true)
    expect(state.battlers[0]!.mon.pp[0]).toBe(3)
    expect(state.field.futureSightCounter[1]).toBe(1)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(true)
    expect(damage.calls).toHaveLength(0)
    expect(state.battlers[1]!.mon.hp).toBe(1000)
  })

  it('Doom Desire records MOVE_DOOM_DESIRE with its own move-table power (140)', () => {
    // Cmd_trysetfutureattack stores gCurrentMove and gBattleMoves[gCurrentMove].power.
    // moves.json: MOVE_DOOM_DESIRE has power 140, so the recorded power is 140 (not Future Sight's 120).
    const state = battle(monFor('SPECIES_MUDKIP', { moves: ['MOVE_DOOM_DESIRE', null, null, null] }), monFor('SPECIES_MUDKIP'))
    const damage = powerEchoResolver()
    executeTurn(state, [useMove(1, DD), null], loopDeps(damage))

    expect(state.field.futureSightMove[1]).toBe('MOVE_DOOM_DESIRE')
    expect(state.field.futureSightPower[1]).toBe(140)
    expect(state.field.futureSightCounter[1]).toBe(2)
    expect(damage.calls).toHaveLength(0)
  })
})

describe('Cycle 109c - end-of-turn countdown and delayed hit', () => {
  it('decrements 3 -> 2 -> 1 -> 0 and lands the hit on the third turn-end pass, for exactly the stored power', () => {
    // HandleWishPerishSongOnTurnEnd state 0: `futureSightCounter != 0 && --counter == 0 && hp != 0`
    // (battle_util.c:3005). After the use turn the counter is 2, then 1, then the third pass
    // reaches 0 and executes BattleScript_MonTookFutureAttack with futureSightPower as the
    // damagecalc power (battle_script_commands.c:1605-1610). The echo resolver answers with
    // that power, so HP falls by exactly 120.
    const rng = scriptedRng([])
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), rng)
    const damage = powerEchoResolver()
    const deps = loopDeps(damage)

    executeTurn(state, [useMove(1, FS), null], deps)
    expect(state.field.futureSightCounter[1]).toBe(2)

    executeTurn(state, [null, null], deps)
    expect(state.field.futureSightCounter[1]).toBe(1)
    expect(state.battlers[1]!.mon.hp).toBe(1000)

    executeTurn(state, [null, null], deps)
    expect(state.field.futureSightCounter[1]).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(880) // 1000 - 120
    expect(damage.calls).toEqual([{ attackerId: 0, targetId: 1, move: 'MOVE_FUTURE_SIGHT', power: 120 }])

    // Both counters are 0, so the side flag is cleared (battle_util.c:3023-3026).
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(false)
  })

  it('uses the STORED power, not the move table re-read: changing futureSightPower changes the damage', () => {
    // Cmd_damagecalc replaces the move power with futureSightPower once the counter is 0
    // (battle_script_commands.c:1605-1610). Both states are identical apart from that stored
    // number, and the echo resolver reports it, so the HP loss is 60 vs 120.
    const base = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), scriptedRng([]))
    const low = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), scriptedRng([]))
    const damageBase = powerEchoResolver()
    const damageLow = powerEchoResolver()

    executeTurn(base, [useMove(1, FS), null], loopDeps(damageBase))
    executeTurn(low, [useMove(1, FS), null], loopDeps(damageLow))
    low.field.futureSightPower[1] = 60

    executeTurn(base, [null, null], loopDeps(damageBase))
    executeTurn(low, [null, null], loopDeps(damageLow))
    executeTurn(base, [null, null], loopDeps(damageBase))
    executeTurn(low, [null, null], loopDeps(damageLow))

    expect(base.battlers[1]!.mon.hp).toBe(880) // 1000 - 120
    expect(low.battlers[1]!.mon.hp).toBe(940) // 1000 - 60
    expect(damageLow.calls.at(-1)?.power).toBe(60)
  })

  it('misses when the accuracy roll fails: no damage, and no crit/roll draw after it', () => {
    // Cmd_accuracycheck (battle_script_commands.c:1433): (Random() % 100) >= accuracy is a
    // MISS. Stat stages are stored 0..12 with DEFAULT_STAT_STAGE == 6 (constants.ts:59), so
    // +6 evasion is index 12 and accuracy.ts:705 computes buff = 6 + 6 - 12 = 0, giving
    // ACCURACY_STAGE_RATIOS[0] = 1/3 (accuracy.ts:86): 100 / 3 = 33. A scripted roll of 50 misses.
    // BattleScript_FutureAttackMiss (s:8043-8049) only reports failure, so no moveend and no
    // further RNG draws happen.
    const rng = scriptedRng([50])
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), rng)
    const damage = powerEchoResolver()
    const deps = loopDeps(damage)

    executeTurn(state, [useMove(1, FS), null], deps)
    executeTurn(state, [null, null], deps)
    state.battlers[1]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 6
    // One pass left: counter 1 -> 0, hit scheduled, accuracy drawn once and missed.
    executeTurn(state, [null, null], deps)

    expect(state.field.futureSightCounter[1]).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(1000)
    expect(damage.calls).toHaveLength(0)
    expect(rng.calls).toBe(1)
    // The C clears SIDE_STATUS_FUTUREATTACK right after BattleScriptExecute (:3023-3026),
    // before the script's own accuracycheck runs, so a miss still clears it.
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(false)
  })

  it('draws accuracy, then crit, then the damage roll -- in that order', () => {
    // The turn loop draws (Random() % 100) for accuracy (Cmd_accuracycheck:1433), then the
    // resolver draws the crit roll (Cmd_critcalc:1577) and the 0..15 damage roll
    // (battle_util.c:7790-7795). Scripted [50, 5, 7]: accuracy 50 < 100 hits, critRoll 5,
    // roll 7, so the echo+roll resolver deals 120 + 7 = 127.
    const rng = scriptedRng([50, 5, 7])
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), rng)
    const damage = drawOrderResolver()
    const deps = loopDeps(damage)

    executeTurn(state, [useMove(1, FS), null], deps)
    expect(rng.calls).toBe(0) // the use turn draws nothing for itself
    executeTurn(state, [null, null], deps)
    executeTurn(state, [null, null], deps)

    expect(rng.calls).toBe(3)
    expect(damage.calls).toEqual([{ critRoll: 5, roll: 7, power: 120 }])
    expect(state.battlers[1]!.mon.hp).toBe(873) // 1000 - (120 + 7)
  })

  it('a fainted holder still ticks its counter to 0 but takes no hit', () => {
    // `--futureSightCounter == 0 && gBattleMons[holder].hp != 0` (:3005): the decrement happens
    // regardless of the holder's HP. A fainted holder never schedules the attack, so the side
    // flag (cleared only inside that branch, :3023-3026) stays set.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), scriptedRng([]))
    const damage = powerEchoResolver()
    const deps = loopDeps(damage)

    executeTurn(state, [useMove(1, FS), null], deps) // counter 3 -> 2
    executeTurn(state, [null, null], deps) // counter 2 -> 1
    state.battlers[1]!.mon.hp = 0
    executeTurn(state, [null, null], deps) // counter 1 -> 0, no hit

    expect(state.field.futureSightCounter[1]).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(damage.calls).toHaveLength(0)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(true)
  })

  it('clears the side flag only when the flank partner counter is also 0', () => {
    // battle_util.c:3023-3026 tests `futureSightCounter[holder] == 0 &&
    // futureSightCounter[holder ^ BIT_FLANK] == 0` (BIT_FLANK = 2). In singles the partner of
    // battler 1 is index 3, a spare array entry that is normally 0; forcing it nonzero must
    // keep the flag set even though battler 1's own counter reaches 0 and the hit lands.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), scriptedRng([]))
    const damage = powerEchoResolver()
    const deps = loopDeps(damage)

    executeTurn(state, [useMove(1, FS), null], deps) // counter 3 -> 2
    executeTurn(state, [null, null], deps) // counter 2 -> 1
    state.field.futureSightCounter[1 ^ 2] = 1 // flank partner (battler 3)
    executeTurn(state, [null, null], deps) // counter 1 -> 0, hit lands

    expect(state.field.futureSightCounter[1]).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(880)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(true)
  })

  it('a fainted recorded attacker does not stop the hit: that battler slot is used as-is', () => {
    // HandleWishPerishSongOnTurnEnd only tests the HOLDER's HP (:3005), and the damage calc
    // reads the recorded attacker slot's stats. Kicking off an attacker whose battler 0 has
    // fainted still calls the resolver with attackerId 0 and deals damage to battler 1.
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), scriptedRng([]))
    const damage = powerEchoResolver()
    const deps = loopDeps(damage)

    executeTurn(state, [useMove(1, FS), null], deps)
    state.battlers[0]!.mon.hp = 0
    executeTurn(state, [null, null], deps)
    executeTurn(state, [null, null], deps)

    expect(damage.calls).toEqual([{ attackerId: 0, targetId: 1, move: 'MOVE_FUTURE_SIGHT', power: 120 }])
    expect(state.battlers[1]!.mon.hp).toBe(880)
  })
})

describe('Cycle 109c - Forewarn (Impl<ABILITY_FOREWARN>.onEntry, abilities.cc:1700-1715)', () => {
  function forewarnMon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
    return monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_FOREWARN', innates: [null, null, null] }, ...overrides })
  }

  it('sets move Future Sight, power 80 (not 120), attacker = holder, counter 3 and the side flag on the opposite battler', () => {
    // abilities.cc:1708-1712: move = MOVE_FUTURE_SIGHT, power = 80, attacker = battler,
    // counter = 3, gSideStatuses[side of target] |= SIDE_STATUS_FUTUREATTACK. BATTLE_OPPOSITE(0) = 1.
    const state = battle(forewarnMon(), monFor('SPECIES_MUDKIP'))
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, SWITCH_DEPS, unmodelled)

    expect(state.field.futureSightCounter[1]).toBe(3)
    expect(state.field.futureSightMove[1]).toBe('MOVE_FUTURE_SIGHT')
    expect(state.field.futureSightPower[1]).toBe(80)
    expect(state.field.futureSightAttacker[1]).toBe(0)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(true)
    // The ported hook must no longer report the generic gap.
    expect(unmodelled.some((n) => n.includes('ABILITY_FOREWARN'))).toBe(false)
  })

  it('no-ops when the opposite battler is dead (singles has no partner)', () => {
    // The target starts at BATTLE_OPPOSITE(0) = 1; dead -> BATTLE_PARTNER(1) = 3, which is not
    // a live battler in singles, so CHECK(IsBattlerAlive(target)) fails the hook silently.
    const state = battle(forewarnMon(), monFor('SPECIES_MUDKIP', { hp: 0 }))
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, SWITCH_DEPS, unmodelled)

    expect(state.field.futureSightCounter[1]).toBe(0)
    expect(state.field.futureSightMove[1]).toBeNull()
    expect(state.field.futureSightPower[1]).toBe(0)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(false)
  })

  it('no-ops when the opposite battler already has a pending Future Sight', () => {
    // `if (!IsBattlerAlive(target) || futureSightCounter[target]) target = BATTLE_PARTNER(target)`
    // (abilities.cc:1704-1705). The partner slot 3 is not alive in singles, so the hook fails
    // and the existing counter/power/attacker are untouched.
    const state = battle(forewarnMon(), monFor('SPECIES_MUDKIP'))
    state.field.futureSightCounter[1] = 2
    state.field.futureSightPower[1] = 55
    state.field.futureSightAttacker[1] = 7
    // A pending Future Sight means the side flag is already up; the hook must leave it up.
    state.sides[1].statuses |= SIDE_STATUS_FUTUREATTACK
    const unmodelled: string[] = []
    applySwitchInAbilities(state, 0, SWITCH_DEPS, unmodelled)

    expect(state.field.futureSightCounter[1]).toBe(2)
    expect(state.field.futureSightPower[1]).toBe(55)
    expect(state.field.futureSightAttacker[1]).toBe(7)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_FUTUREATTACK)).toBe(true)
  })

  it('the Forewarn-scheduled attack hits for 80 power, not the move table\'s 120', () => {
    // Same countdown as the move-set case (state 0), but futureSightPower was written by the
    // hook as 80 (abilities.cc:1709). The echo resolver reports the stored number, so HP falls
    // by 80 rather than 120.
    const state = battle(forewarnMon(), monFor('SPECIES_MUDKIP'), scriptedRng([]))
    const damage = powerEchoResolver()
    const deps = loopDeps(damage)
    applySwitchInAbilities(state, 0, SWITCH_DEPS, [])

    executeTurn(state, [null, null], deps) // counter 3 -> 2
    executeTurn(state, [null, null], deps) // counter 2 -> 1
    executeTurn(state, [null, null], deps) // counter 1 -> 0, hit

    expect(state.field.futureSightCounter[1]).toBe(0)
    expect(damage.calls).toEqual([{ attackerId: 0, targetId: 1, move: 'MOVE_FUTURE_SIGHT', power: 80 }])
    expect(state.battlers[1]!.mon.hp).toBe(920) // 1000 - 80
  })

  it('does not overwrite a raised evasion sentinel (sanity check on the target slot)', () => {
    // The hook always resolves BATTLE_OPPOSITE(0) = 1; an unrelated stat stage on the target
    // must be untouched. This also pins the numbers without a future hit landing yet.
    const state = battle(forewarnMon(), monFor('SPECIES_MUDKIP'))
    state.battlers[1]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 3
    applySwitchInAbilities(state, 0, SWITCH_DEPS, [])
    expect(state.battlers[1]!.mon.statStages[STAT_EVASION]).toBe(DEFAULT_STAT_STAGE + 3)
    expect(state.field.futureSightCounter[1]).toBe(3)
  })
})
