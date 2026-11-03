/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 135: audit-noted and oddball move effects: Party Favors, Camouflage (EFFECT_PROTECT),
// Heat Crash / Heavy Slam / Splash, Metal Burst / Comeuppance, plus behaviour checks for the
// allowlisted Ally Switch, Celebrate / Happy Hour / Hold Hands and Airborne Slam.
// Every expected number is hand-derived from the pinned C in data/battle_scripts_1.s,
// src/battle_script_commands.c, src/battle_util.c, src/battle_main.c or src/script_conditions.cc.
//
// Damage shortcut used throughout: at level 50 with Atk == Def == 100
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2` with divisions truncating.
//
// Draw order: an accuracy-checked move spends one accuracy draw. With the real damage engine a hit then
// spends the crit draw (1 = no crit) and the damage roll (0 = full damage). Moves without accuracycheck
// in their C scripts spend no accuracy draw.
import { describe, expect, it } from 'vitest'

import type { BridgeDeps } from './bridge'
import { MIN_STAT_STAGE, STAT_ACC, STATUS3_HEAL_BLOCK, WEATHER_RAIN_TEMPORARY } from './constants'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { findAllowance, validateAllowance } from './driver/auditAllowlist'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ReplacementDeps } from './switchIn'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const freshAbilities = (): SimBattleMon['abilities'] => ({ ability: null, innates: [null, null, null] })

/** 200 Speed against the foe's default 100 keeps GetFastestBattler's speed-tie coin flip
 * (turnOrder.ts:583) out of the scripted draw arrays. */
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
    abilities: freshAbilities(),
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

/** Every draw is 0 (accuracy always hits, crit, full damage); `calls` counts draws. */
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

/** Draws the scripted values in order (0 once they run out); `calls` counts draws. */
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

/** The first draw is 99, which misses any accuracy at or below 99; the rest 0. */
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
    rng,
    ...(opts.playerParty ? { playerParty: opts.playerParty } : {}),
    ...(opts.opponentParty ? { opponentParty: opts.opponentParty } : {}),
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

function loopDeps(state: BattleState, damage: DamageResolver, replacement?: ReplacementDeps): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
    ...(replacement ? { replacement } : {}),
  }
}

const THIS_FILE = 'web/src/engine/sim/cycle135OddballEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const ppOf = (state: BattleState, battlerId = 0, slot = 0) => state.battlers[battlerId]!.mon.pp[slot]

/** The user (battler 0, Mudkip, faster than default foe) knows only `moveId`; `pp` is its PP. */
const user = (moveId: string, pp: number, overrides: Partial<SimBattleMon> = {}) =>
  monFor('SPECIES_MUDKIP', {
    rawStats: { ...FAST_STATS },
    moves: [moveId, null, null, null],
    pp: [pp, 0, 0, 0],
    ...overrides,
  })
const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

/** One turn: the user (battler 0) uses `moveId` on battler 1, the foe does nothing. */
function runVs(state: BattleState, moveId: string, damage: DamageResolver = fixedDamage(0), replacement?: ReplacementDeps): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, damage, replacement))
}

/** The same, but with the real damage engine. */
function runVsReal(state: BattleState, moveId: string): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, bridgeDamage(state, state.rng)))
}

/** Puts the user's accuracy at its floor, so a 100%-accuracy move becomes 33%. */
function atAccuracyFloor(state: BattleState): BattleState {
  state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE
  return state
}

// ---------------------------------------------------------------------------
// 1. EFFECT_ALLY_SWITCH (allowlisted, doubles-only). VARIOUS_SWAP_WITH
// (src/battle_script_commands.c:8855-8878) only swaps a partner's slot data; singles has no partner.
// ---------------------------------------------------------------------------
describe('EFFECT_ALLY_SWITCH (MOVE_ALLY_SWITCH, allowlisted)', () => {
  it('in singles it spends one PP and changes nothing on either side, with no draws', () => {
    const rng = countRng()
    const state = battle(user('MOVE_ALLY_SWITCH', 15), foe(), rng)
    runVs(state, 'MOVE_ALLY_SWITCH')

    expect(ppOf(state, 0)).toBe(14)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. EFFECT_DO_NOTHING (allowlisted: Happy Hour's only effect is the prize-money multiplier,
// src/battle_script_commands.c:2692-2697). BattleScript_EffectDoNothing (data/battle_scripts_1.s:4594-4620).
// ---------------------------------------------------------------------------
describe('EFFECT_DO_NOTHING (Celebrate, Happy Hour, Hold Hands; allowlisted)', () => {
  it.each(['MOVE_CELEBRATE', 'MOVE_HAPPY_HOUR'])('%s spends one PP and changes no HP, with no draws', (moveId) => {
    const rng = countRng()
    const state = battle(user(moveId, 30), foe(), rng)
    const out = runVs(state, moveId)

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(29) // ppreduce (:4597)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })

  it('negative case: Hold Hands fails in singles (target == attacker, BattleScript_EffectHoldHands) after ppreduce', () => {
    const rng = countRng()
    const state = battle(user('MOVE_HOLD_HANDS', 40), foe(), rng)
    const out = runVs(state, 'MOVE_HOLD_HANDS')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(39)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. EFFECT_PLACEHOLDER (allowlisted). BattleScript_EffectPlaceholder (data/battle_scripts_1.s:2847-2854):
// attackcanceler ; attackstring ; ppreduce ; printstring STRINGID_NOTDONEYET ; goto MoveEnd. No accuracycheck.
// ---------------------------------------------------------------------------
describe('EFFECT_PLACEHOLDER (MOVE_AIRBORNE_SLAM, allowlisted)', () => {
  it('spends one PP and leaves the target untouched even when the resolver would deal damage', () => {
    const rng = countRng()
    const state = battle(user('MOVE_AIRBORNE_SLAM', 10), foe(), rng)
    const out = runVs(state, 'MOVE_AIRBORNE_SLAM', fixedDamage(40))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })

  it('negative case: a miss roll changes nothing, because there is no accuracycheck', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_AIRBORNE_SLAM', 10), foe(), rng))
    const out = runVs(state, 'MOVE_AIRBORNE_SLAM', fixedDamage(40))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. EFFECT_PARTY_FAVORS. BattleScript_EffectPartyFavors (data/battle_scripts_1.s:2957-2990):
// accuracycheck (:2959) ; ppreduce (:2961) ; the hit ; then TryHealStack for the attacker (:2975-2976) and
// its partner (:2977-2979, absent in singles -> jumpifabsent :2983).
// VARIOUS_TRY_HEAL_PERCENT_HP (src/battle_script_commands.c:7891-7901): heal = maxHP * 25 / 100 (min 1);
// fails at full HP (:7898) or when !CanBattlerHeal (:7900, Heal Block among others).
// ---------------------------------------------------------------------------
describe('EFFECT_PARTY_FAVORS (MOVE_PARTY_FAVORS)', () => {
  it('a landing hit heals the user 100 * 25 / 100 = 25: 40 -> 65 (:7895)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PARTY_FAVORS', 10, { hp: 40 }), foe(), rng)
    const out = runVs(state, 'MOVE_PARTY_FAVORS', fixedDamage(10))

    expect(actionOf(out, 0)?.missed).toBe(false)
    expect(state.battlers[1]!.mon.hp).toBe(90)
    expect(state.battlers[0]!.mon.hp).toBe(65)
    expect(ppOf(state, 0)).toBe(9)
    expect(rng.calls).toBe(1) // accuracy only; fixedDamage draws nothing
  })

  it('integer heal: maxHP 90 heals 90 * 25 / 100 = 22: 40 -> 62 (:7895)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PARTY_FAVORS', 10, { hp: 40, maxHp: 90 }), foe(), rng)
    runVs(state, 'MOVE_PARTY_FAVORS', fixedDamage(10))

    expect(state.battlers[0]!.mon.hp).toBe(62)
    expect(ppOf(state, 0)).toBe(9)
    expect(rng.calls).toBe(1)
  })

  it('negative case: at full HP the heal fails (:7898)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PARTY_FAVORS', 10), foe(), rng)
    runVs(state, 'MOVE_PARTY_FAVORS', fixedDamage(10))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[1]!.mon.hp).toBe(90)
    expect(rng.calls).toBe(1)
  })

  it('negative case: Heal Block makes CanBattlerHeal fail, so no heal (:7900)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PARTY_FAVORS', 10, { hp: 40 }), foe(), rng)
    state.battlers[0]!.statuses3 = STATUS3_HEAL_BLOCK
    runVs(state, 'MOVE_PARTY_FAVORS', fixedDamage(10))

    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(state.battlers[1]!.mon.hp).toBe(90)
  })

  it('negative case: a miss skips the hit and the heal (accuracycheck -> BattleScript_PrintMoveMissed, :2959)', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_PARTY_FAVORS', 10, { hp: 40 }), foe(), rng))
    const out = runVs(state, 'MOVE_PARTY_FAVORS', fixedDamage(10))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(ppOf(state, 0)).toBe(9)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 6. EFFECT_PROTECT: Camouflage's type-adding branch. IsBattlerProtected returns
// PROTECT_BLOCK_ALWAYS_TOUCH for MOVE_CAMOUFLAGE (src/battle_util.c:6622-6623); MOVEEND_PROTECT_LIKE_EFFECT
// (src/battle_script_commands.c:4415-4427) then reads GET_MOVE_TYPE(gCurrentMove) and, unless the target
// already has that type, writes it to type3. Weather Ball's type: GetMoveTypeInternal
// (src/battle_main.c:5113-5122), rain -> TYPE_WATER. The core Protect group is covered by
// moveEffectsProtect.test.ts.
// ---------------------------------------------------------------------------
describe('EFFECT_PROTECT (MOVE_CAMOUFLAGE type change)', () => {
  /** The foe (battler 1) uses Camouflage (priority 4) and the user then attacks into it. */
  function runIntoCamouflage(state: BattleState, moveId: string): TurnOutcome {
    return executeTurn(state, [useMove(1, moveId), useMove(1, 'MOVE_CAMOUFLAGE')], loopDeps(state, fixedDamage(30)))
  }
  const camoFoe = (types: [string, string, string]) =>
    foe({ moves: ['MOVE_CAMOUFLAGE', null, null, null], pp: [10, 0, 0, 0], types })

  it('a plain Electric move is blocked and adds Electric as type 3 (:4416-4423)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_THUNDER_SHOCK', 15), camoFoe(['WATER', 'MYSTERY', 'MYSTERY']), rng)
    runIntoCamouflage(state, 'MOVE_THUNDER_SHOCK')

    expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'MYSTERY', 'ELECTRIC'])
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(ppOf(state, 0)).toBe(14)
    expect(ppOf(state, 1)).toBe(9)
  })

  it('Weather Ball in rain resolves to Water before the type is added (battle_main.c:5117)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WEATHER_BALL', 15), camoFoe(['GRASS', 'MYSTERY', 'MYSTERY']), rng)
    state.field.weather = WEATHER_RAIN_TEMPORARY
    runIntoCamouflage(state, 'MOVE_WEATHER_BALL')

    expect(state.battlers[1]!.mon.types).toEqual(['GRASS', 'MYSTERY', 'WATER'])
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })

  it('Weather Ball with no weather stays Normal (battle_main.c:5116 REQUIRE fails)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WEATHER_BALL', 15), camoFoe(['GRASS', 'MYSTERY', 'MYSTERY']), rng)
    runIntoCamouflage(state, 'MOVE_WEATHER_BALL')

    expect(state.battlers[1]!.mon.types).toEqual(['GRASS', 'MYSTERY', 'NORMAL'])
  })

  it('negative case: a type the target already has changes nothing (IS_BATTLER_OF_TYPE, :4418)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WATER_GUN', 15), camoFoe(['WATER', 'MYSTERY', 'MYSTERY']), rng)
    runIntoCamouflage(state, 'MOVE_WATER_GUN')

    expect(state.battlers[1]!.mon.types).toEqual(['WATER', 'MYSTERY', 'MYSTERY'])
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(ppOf(state, 0)).toBe(14)
  })
})

// ---------------------------------------------------------------------------
// 7. EFFECT_HEAT_CRASH (Heat Crash, Heavy Slam, Splash). CustomMoveDamage<EFFECT_HEAT_CRASH>
// (src/script_conditions.cc:176-184): weightRatio = atkWeight / defWeight (integer),
// sHeatCrashPowerTable = {40, 40, 60, 80, 100, 120}, ratio >= 6 -> 120. The listed base power (1) is ignored.
// Weights (species.json, hectograms): Kecleon 220, Mudkip 76, Treecko 50, Torchic 25.
// The foe's types are set to Normal so every move here is neutral; the Kecleon user has no STAB on them.
//   Kecleon vs Mudkip:  220/76 = 2 -> 60  -> 22*60/50  = 26 + 2 = 28
//   Kecleon vs Treecko: 220/50 = 4 -> 100 -> 22*100/50 = 44 + 2 = 46
//   Kecleon vs Torchic: 220/25 = 8 -> 120 -> 22*120/50 = 52 + 2 = 54
//   Mudkip vs Kecleon:   76/220 = 0 -> 40 -> 22*40/50  = 17 + 2 = 19
// ---------------------------------------------------------------------------
describe('EFFECT_HEAT_CRASH (Heat Crash, Heavy Slam, Splash)', () => {
  const NORMAL_TYPES: [string, string, string] = ['NORMAL', 'MYSTERY', 'MYSTERY']
  const kecleon = (moveId: string) =>
    monFor('SPECIES_KECLEON', { rawStats: { ...FAST_STATS }, moves: [moveId, null, null, null], pp: [10, 0, 0, 0] })

  it.each([
    ['MOVE_HEAVY_SLAM', 'SPECIES_MUDKIP', 28],
    ['MOVE_HEAVY_SLAM', 'SPECIES_TREECKO', 46],
    ['MOVE_HEAVY_SLAM', 'SPECIES_TORCHIC', 54],
    ['MOVE_HEAT_CRASH', 'SPECIES_TREECKO', 46],
  ] as const)('%s by Kecleon into %s deals %i (:178-182)', (moveId, foeSpecies, expected) => {
    const rng = scriptedRng([0, 1, 0]) // accuracy, no crit, full roll
    const state = battle(kecleon(moveId), monFor(foeSpecies, { types: NORMAL_TYPES }), rng)
    runVsReal(state, moveId)

    expect(100 - state.battlers[1]!.mon.hp).toBe(expected)
    expect(ppOf(state, 0)).toBe(9)
    expect(rng.calls).toBe(3)
  })

  it('Splash (listed power 1) uses the same table: Kecleon into Mudkip deals 28', () => {
    // Splash also carries a 20% MOVE_EFFECT_DRENCH (moves.json effectChance 20): the 4th draw, 99, fails it.
    const rng = scriptedRng([0, 1, 0, 99])
    const state = battle(kecleon('MOVE_SPLASH'), monFor('SPECIES_MUDKIP', { types: NORMAL_TYPES }), rng)
    runVsReal(state, 'MOVE_SPLASH')

    expect(100 - state.battlers[1]!.mon.hp).toBe(28)
    expect(ppOf(state, 0)).toBe(9)
    expect(rng.calls).toBe(4)
  })

  it('a lighter user drops to the bottom tier: Mudkip into Kecleon, ratio 0 -> 40 power -> 19', () => {
    const rng = scriptedRng([0, 1, 0])
    const state = battle(user('MOVE_HEAVY_SLAM', 10), monFor('SPECIES_KECLEON', { types: NORMAL_TYPES }), rng)
    runVsReal(state, 'MOVE_HEAVY_SLAM')

    expect(100 - state.battlers[1]!.mon.hp).toBe(19)
    expect(rng.calls).toBe(3)
  })

  it('negative case: a miss deals no damage and still spends PP', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(kecleon('MOVE_HEAVY_SLAM'), monFor('SPECIES_TORCHIC', { types: NORMAL_TYPES }), rng))
    const out = runVsReal(state, 'MOVE_HEAVY_SLAM')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(ppOf(state, 0)).toBe(9)
    expect(rng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 8. EFFECT_METAL_BURST (Metal Burst, Comeuppance). BattleScript_EffectMetalBurst (data/battle_scripts_1.s:2353-2361):
// metalburstdamagecalculator ButItFailedAtkStringPpReduce runs BEFORE accuracycheck.
// Cmd_metalburstdamagecalculator (src/battle_script_commands.c:13102-13131): the physical (then special) damage
// taken this round from a live opposing battler, * 150 / 100, minimum 1; else fail.
// ---------------------------------------------------------------------------
describe('EFFECT_METAL_BURST (Metal Burst, Comeuppance)', () => {
  /** The faster foe Tackles the slow user first for `dmg`, then the user answers with `moveId`. */
  function afterTackle(moveId: string, dmg: number) {
    const rng = countRng()
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: [moveId, null, null, null], pp: [10, 0, 0, 0] }),
      foe({ rawStats: { ...FAST_STATS } }),
      rng,
    )
    executeTurn(state, [useMove(1, moveId), useMove(0, 'MOVE_TACKLE')], loopDeps(state, fixedDamage(dmg)))
    return { state, rng }
  }

  it('Metal Burst after taking 20 physical returns 20 * 150 / 100 = 30 (:13108)', () => {
    const { state, rng } = afterTackle('MOVE_METAL_BURST', 20)

    expect(state.battlers[0]!.mon.hp).toBe(80)
    expect(state.battlers[1]!.mon.hp).toBe(70)
    expect(ppOf(state, 0)).toBe(9)
    expect(rng.calls).toBe(2) // Tackle's accuracy, then Metal Burst's
  })

  it('Comeuppance truncates: 15 taken -> 15 * 150 / 100 = 22 (:13108)', () => {
    const { state, rng } = afterTackle('MOVE_COMEUPPANCE', 15)

    expect(state.battlers[1]!.mon.hp).toBe(78)
    expect(ppOf(state, 0)).toBe(9)
    expect(rng.calls).toBe(2)
  })

  it('negative case: no damage taken this round fails before the accuracy check (:13126-13127)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_METAL_BURST', 10), foe(), rng)
    const out = runVs(state, 'MOVE_METAL_BURST', fixedDamage(20))

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(ppOf(state, 0)).toBe(9) // ButItFailedAtkStringPpReduce
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe('cycle 135 registry', () => {
  const VERIFIED = ['EFFECT_PARTY_FAVORS', 'EFFECT_PROTECT', 'EFFECT_HEAT_CRASH', 'EFFECT_METAL_BURST']
  const ALLOWLISTED = ['EFFECT_ALLY_SWITCH', 'EFFECT_DO_NOTHING', 'EFFECT_PLACEHOLDER']

  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of VERIFIED) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('every allowlisted effect has a valid allowance', () => {
    for (const effect of ALLOWLISTED) {
      const allowance = findAllowance(effect)
      expect(allowance, effect).toBeDefined()
      expect(validateAllowance(allowance!)).toEqual([])
    }
  })

  it.each([
    ['MOVE_ALLY_SWITCH', 'EFFECT_ALLY_SWITCH'],
    ['MOVE_CELEBRATE', 'EFFECT_DO_NOTHING'],
    ['MOVE_HAPPY_HOUR', 'EFFECT_DO_NOTHING'],
    ['MOVE_HOLD_HANDS', 'EFFECT_DO_NOTHING'],
    ['MOVE_AIRBORNE_SLAM', 'EFFECT_PLACEHOLDER'],
    ['MOVE_PARTY_FAVORS', 'EFFECT_PARTY_FAVORS'],
    ['MOVE_CAMOUFLAGE', 'EFFECT_PROTECT'],
    ['MOVE_HEAT_CRASH', 'EFFECT_HEAT_CRASH'],
    ['MOVE_HEAVY_SLAM', 'EFFECT_HEAT_CRASH'],
    ['MOVE_SPLASH', 'EFFECT_HEAT_CRASH'],
    ['MOVE_METAL_BURST', 'EFFECT_METAL_BURST'],
    ['MOVE_COMEUPPANCE', 'EFFECT_METAL_BURST'],
  ])('%s has %s', (moveId, effect) => expect(effectOf(moveId)).toBe(effect))
})
