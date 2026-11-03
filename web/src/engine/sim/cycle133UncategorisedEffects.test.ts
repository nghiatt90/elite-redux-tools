/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 133: twelve uncategorised move effects: Shore Up, Third Type, Psycho Shift,
// Stuff Cheeks, Gear Up, Shelter, Fairy Lock, Magnitude, Teatime, Tidy Up, Waterlog, and Showtime.
// Every expected number is hand-derived from the pinned C in data/battle_scripts_1.s,
// src/battle_script_commands.c, src/battle_util.c, or src/battle_main.c.
//
// Stat stages run 0..12 with neutral 6 (DEFAULT_STAT_STAGE), so "-1" is stage 5 and "+1" stage 7.
// Damage shortcut used throughout: at level 50 with Atk == Def == 100
// `((2*50/5+2) * power * atk / def) / 50 + 2` reduces to `22*power/50 + 2` with divisions truncating.
//
// Draw order: an accuracy-checked move spends one accuracy draw (a 0-accuracy move still spends it).
// Moves without accuracycheck in their C scripts spend no accuracy draw.
import { describe, expect, it } from 'vitest'

import type { BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS2_ENRAGED,
  STATUS_FIELD_FAIRY_LOCK,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_TEMPORARY,
  hasFlag,
} from './constants'
import { canBattlerEscape } from './escape'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { findAllowance } from './driver/auditAllowlist'
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

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

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

const THIS_FILE = 'web/src/engine/sim/cycle133UncategorisedEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)
const ppOf = (state: BattleState, battlerId = 0, slot = 0) => state.battlers[battlerId]!.mon.pp[slot]
const stageOf = (state: BattleState, battlerId: number, stat: number) => state.battlers[battlerId]!.mon.statStages[stat] ?? DEFAULT_STAT_STAGE

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
function runVs(state: BattleState, moveId: string, replacement?: ReplacementDeps): TurnOutcome {
  return executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedDamage(0), replacement))
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
// 1. EFFECT_SHORE_UP. BattleScript_EffectShoreUp (battle_scripts_1.s:5498-5503).
// ppreduce (:5501)
// recoverbasedonsunlight BattleScript_AlreadyAtFullHp (:5502)
// Cmd_recoverbasedonsunlight (battle_script_commands.c:11433-11460).
// Shore Up branch (:11439-11443):
//   sandstorm: 2 * maxHP / 3
//   else: maxHP / 2
// ---------------------------------------------------------------------------
describe('cycle 133 - Shore Up (EFFECT_SHORE_UP)', () => {
  it('heals 1/2 max HP in clear weather without accuracy check (5498-5503, 11442)', () => {
    // maxHP 100, hp 10. Clear weather: heals 100 / 2 = 50 -> 60 hp (:11443).
    // No accuracycheck in script -> 0 rng draws.
    const rng = countRng()
    const state = battle(user('MOVE_SHORE_UP', 10, { hp: 10, maxHp: 100 }), foe(), rng)
    const out = runVs(state, 'MOVE_SHORE_UP')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :5501
    expect(state.battlers[0]!.mon.hp).toBe(60) // 10 + 50 = 60 (:11443)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('heals 2/3 max HP in sandstorm (11440-11441)', () => {
    // maxHP 100, hp 10. Sandstorm: heals Math.trunc(2 * 100 / 3) = 66 -> 76 hp (:11441).
    // User Marshtomp is Water/Ground, immune to sandstorm residual damage.
    const rng = countRng()
    const state = battle(
      user('MOVE_SHORE_UP', 10, {
        speciesId: 'SPECIES_MARSHTOMP',
        types: ['WATER', 'GROUND', 'MYSTERY'],
        hp: 10,
        maxHp: 100,
      }),
      foe(),
      rng,
    )
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    runVs(state, 'MOVE_SHORE_UP')

    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.hp).toBe(76) // 10 + 66 = 76 (:11441)
  })

  it('heals 1/2 max HP in rain (not reduced to 1/4 like Synthesis/Moonlight) (11439-11443)', () => {
    // Shore Up has its own if-branch (:11439), so rain falls to else: maxHP / 2 = 50 -> 60 hp.
    const rng = countRng()
    const state = battle(user('MOVE_SHORE_UP', 10, { hp: 10, maxHp: 100 }), foe(), rng)
    state.field.weather = WEATHER_RAIN_TEMPORARY
    runVs(state, 'MOVE_SHORE_UP')

    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.hp).toBe(60) // 10 + 50 = 60 (:11443)
  })

  it('negative case: fails at full HP and heals nothing (:11438 -> :11458 BattleScript_AlreadyAtFullHp)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHORE_UP', 10, { hp: 100, maxHp: 100 }), foe(), rng)
    runVs(state, 'MOVE_SHORE_UP')

    expect(ppOf(state, 0)).toBe(9) // ppreduce ran before the jump (:5501)
    expect(state.battlers[0]!.mon.hp).toBe(100) // remains at 100
  })
})

// ---------------------------------------------------------------------------
// 2. EFFECT_THIRD_TYPE. BattleScript_EffectThirdType (battle_scripts_1.s:1269-1281).
// accuracycheck (:1271)
// ppreduce (:1273)
// trysetthirdtype BS_TARGET, BattleScript_ButItFailed (:1274, VARIOUS_TRY_THIRD_TYPE:7768-7781)
// argumenttomoveeffect + seteffectprimary (:1279-1280)
// ---------------------------------------------------------------------------
describe('cycle 133 - Third Type (EFFECT_THIRD_TYPE)', () => {
  it("Forest's Curse adds Grass as the target's 3rd type (:1274, :7777)", () => {
    // Target Mudkip is TYPE_WATER. Draw 0 = accuracy hit.
    const rng = countRng()
    const state = battle(user('MOVE_FORESTS_CURSE', 20), foe(), rng)
    const out = runVs(state, 'MOVE_FORESTS_CURSE')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(19) // ppreduce :1273
    expect(state.battlers[1]!.mon.types[2]).toBe('GRASS') // type3 set to GRASS (:7777)
    expect(rng.calls).toBe(1) // 1 accuracy draw
  })

  it('Trick-Or-Treat adds Ghost as the target 3rd type (:1274, :7777)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TRICK_OR_TREAT', 20), foe(), rng)
    const out = runVs(state, 'MOVE_TRICK_OR_TREAT')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(19)
    expect(state.battlers[1]!.mon.types[2]).toBe('GHOST') // :7777
  })

  it('Incite adds Dark as 3rd type and applies enrage status (:1274, :1279-1280, :7713)', () => {
    // MOVE_INCITE has argument MOVE_EFFECT_ENRAGE (moves.json).
    const rng = countRng()
    const state = battle(user('MOVE_INCITE', 10), foe(), rng)
    const out = runVs(state, 'MOVE_INCITE')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[1]!.mon.types[2]).toBe('DARK') // :7777
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ENRAGED)).toBe(true) // argumenttomoveeffect :1279
  })

  it('negative case 1: fails when target already has the added type (:7770, :7774 -> BattleScript_ButItFailed)', () => {
    const rng = countRng()
    // Foe is already Grass type (Treecko)
    const state = battle(user('MOVE_FORESTS_CURSE', 20), monFor('SPECIES_TREECKO'), rng)
    const out = runVs(state, 'MOVE_FORESTS_CURSE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(19) // ppreduce :1273 ran
    expect(state.battlers[1]!.mon.types[2]).not.toBe('GRASS') // failed, not modified
  })

  it('negative case 2: accuracy miss at floor leaves target unaffected (:1271 -> BattleScript_PrintMoveMissed)', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_FORESTS_CURSE', 20), foe(), rng))
    const out = runVs(state, 'MOVE_FORESTS_CURSE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(19)
    expect(state.battlers[1]!.mon.types[2]).toBe('MYSTERY')
  })

  it('edge case: Trick-Or-Treat on a Ghost type does NOT fail; sets trickOrTreat volatile (:7771-7773)', () => {
    const rng = countRng()
    // Foe is Ghost type (Gastly)
    const state = battle(user('MOVE_TRICK_OR_TREAT', 20), monFor('SPECIES_GASTLY'), rng)
    const out = runVs(state, 'MOVE_TRICK_OR_TREAT')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(19)
    expect(state.battlers[1]!.volatiles.trickOrTreat).toBe(true) // :7772
  })
})

// ---------------------------------------------------------------------------
// 3. EFFECT_PSYCHO_SHIFT. BattleScript_EffectPsychoShift (battle_scripts_1.s:1456-1478).
// accuracycheck (:1458)
// ppreduce (:1460)
// jumpifstatus BS_ATTACKER, STATUS1_ANY (:1461)
// jumpifstatus BS_TARGET, STATUS1_ANY (:1464)
// trypsychoshift BattleScript_ButItFailed (:1466, VARIOUS_PSYCHO_SHIFT :7641-7684)
// curestatus BS_ATTACKER (:1474)
// ---------------------------------------------------------------------------
describe('cycle 133 - Psycho Shift (EFFECT_PSYCHO_SHIFT)', () => {
  it('transfers paralysis from user to target and cures user (:7679, :1474)', () => {
    // 300 Spe -> paralyzed speed 150 > foe 100, avoiding speed tie draw.
    // Draw 0 = paralysis immobility check: 1 % 4 !== 0 -> user acts (:3402).
    // Draw 1 = Psycho Shift 100 accuracy (moves.json) -> 0 is hit.
    const rng = scriptedRng([1, 0])
    const state = battle(
      user('MOVE_PSYCHO_SHIFT', 10, {
        rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 300 },
        status1: STATUS1_PARALYSIS,
      }),
      foe(),
      rng,
    )
    const out = runVs(state, 'MOVE_PSYCHO_SHIFT')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :1460
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS) // transferred to target (:7679)
    expect(state.battlers[0]!.mon.status1).toBe(0) // user cured (:1474)
  })

  it('transfers burn from user to target and cures user (:7669, :7679, :1474)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PSYCHO_SHIFT', 10, { status1: STATUS1_BURN }), foe(), rng)
    const out = runVs(state, 'MOVE_PSYCHO_SHIFT')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })

  it('negative case 1: user with no status fails (:1461 -> BattleScript_ButItFailed)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PSYCHO_SHIFT', 10, { status1: 0 }), foe(), rng)
    const out = runVs(state, 'MOVE_PSYCHO_SHIFT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :1460 ran
    expect(state.battlers[1]!.mon.status1).toBe(0)
  })

  it('negative case 2: target already statused causes move to fail (:1464 -> BattleScript_ButItFailed)', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_PSYCHO_SHIFT', 10, { status1: STATUS1_BURN }),
      foe({ status1: STATUS1_PARALYSIS }),
      rng,
    )
    const out = runVs(state, 'MOVE_PSYCHO_SHIFT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN) // user retains status
    expect(state.battlers[1]!.mon.status1).toBe(STATUS1_PARALYSIS)
  })

  it('negative case 3: target immune to burn causes move to fail (:7664 -> BattleScript_BRNPrevention)', () => {
    const rng = countRng()
    // Charmander is Fire type -> CanBeBurned returns FALSE (:7664)
    const state = battle(
      user('MOVE_PSYCHO_SHIFT', 10, { status1: STATUS1_BURN }),
      monFor('SPECIES_CHARMANDER'),
      rng,
    )
    const out = runVs(state, 'MOVE_PSYCHO_SHIFT')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9)
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN) // user not cured
    expect(state.battlers[1]!.mon.status1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. EFFECT_STUFF_CHEEKS. BattleScript_EffectStuffCheeks (battle_scripts_1.s:559-580).
// ppreduce (:562)
// jumpifnotberry BS_ATTACKER, BattleScript_ButItFailed (:563)
// consumeberry BS_ATTACKER (:569)
// setstatchanger STAT_DEF, 2, FALSE (:573)
// ---------------------------------------------------------------------------
describe('cycle 133 - Stuff Cheeks (EFFECT_STUFF_CHEEKS)', () => {
  it('eats held berry, raises Defense by 2, spends 1 PP without accuracy draw (:559, :562, :569, :573)', () => {
    const rng = countRng()
    // User at 50/100 HP with Oran Berry: berry heals 10 HP (50 -> 60) and is consumed (:569, :10860).
    const state = battle(user('MOVE_STUFF_CHEEKS', 10, { hp: 50, maxHp: 100, itemId: 'ITEM_ORAN_BERRY' }), foe(), rng)
    const out = runVs(state, 'MOVE_STUFF_CHEEKS')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :562
    expect(state.battlers[0]!.mon.itemId).toBeNull() // berry consumed (:569)
    expect(state.battlers[0]!.mon.hp).toBe(60) // healed 10 HP by Oran Berry (:10860)
    expect(stageOf(state, 0, STAT_DEF)).toBe(8) // +2 stages from neutral 6 -> 8 (:573)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('negative case: fails if user holds no berry (:563 -> BattleScript_ButItFailed)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STUFF_CHEEKS', 10, { itemId: null }), foe(), rng)
    const out = runVs(state, 'MOVE_STUFF_CHEEKS')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :562 ran
    expect(stageOf(state, 0, STAT_DEF)).toBe(6) // Defense unchanged
  })
})

// ---------------------------------------------------------------------------
// 5. EFFECT_GEAR_UP. BattleScript_EffectGearUp (battle_scripts_1.s:1212-1241).
// ppreduce (:1215)
// jumpifstat BS_ATTACKER, CMP_LESS_THAN, STAT_SPEED, MAX_STAT_STAGE, BattleScript_GearUpDoMoveAnim (:1216)
// jumpifstat BS_ATTACKER, CMP_EQUAL, STAT_SPATK, MAX_STAT_STAGE, BattleScript_CantRaiseMultipleStats (:1217)
// Speed <= 10 -> +2 Speed (:1223); Speed == 11 -> +1 Speed (:1226)
// +1 SpAtk (:1233)
// ---------------------------------------------------------------------------
describe('cycle 133 - Gear Up (EFFECT_GEAR_UP)', () => {
  it('raises Speed by 2 and SpAtk by 1 at neutral stages (:1215, :1223, :1233)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GEAR_UP', 10), foe(), rng)
    const out = runVs(state, 'MOVE_GEAR_UP')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :1215
    expect(stageOf(state, 0, STAT_SPEED)).toBe(8) // +2 stages (6 -> 8, :1223)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7) // +1 stage (6 -> 7, :1233)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('raises Speed by 1 when Speed stage is 11 (:1220, :1226)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GEAR_UP', 10), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = 11
    runVs(state, 'MOVE_GEAR_UP')

    expect(ppOf(state, 0)).toBe(9)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(12) // +1 stage (11 -> 12, :1226)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(7) // +1 stage (6 -> 7, :1233)
  })

  it('negative case: fails when both Speed and SpAtk are at max (:1216-1217 -> BattleScript_CantRaiseMultipleStats)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GEAR_UP', 10), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_GEAR_UP')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :1215 ran
    expect(stageOf(state, 0, STAT_SPEED)).toBe(MAX_STAT_STAGE)
    expect(stageOf(state, 0, STAT_SPATK)).toBe(MAX_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 6. EFFECT_SHELTER. BattleScript_EffectShelter (battle_scripts_1.s:11940-11965).
// ppreduce (:11943)
// jumpifstat BS_ATTACKER, CMP_NOT_EQUAL, STAT_DEF, MAX_STAT_STAGE, BattleScript_EffectShelter_Works (:11944)
// jumpifabsent BS_ATTACKER_PARTNER, BattleScript_ButItFailed (:11945)
// setstatchanger STAT_DEF, 2, FALSE (:11949)
// ---------------------------------------------------------------------------
describe('cycle 133 - Shelter (EFFECT_SHELTER)', () => {
  it('raises user Defense by 2 stages without accuracy check (:11940, :11943, :11949)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHELTER', 10), foe(), rng)
    const out = runVs(state, 'MOVE_SHELTER')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :11943
    expect(stageOf(state, 0, STAT_DEF)).toBe(8) // +2 stages (6 -> 8, :11949)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('negative case: fails in singles when user Defense is already at max (:11944-11945 -> BattleScript_ButItFailed)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHELTER', 10), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_DEF] = MAX_STAT_STAGE
    const out = runVs(state, 'MOVE_SHELTER')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :11943 ran
    expect(stageOf(state, 0, STAT_DEF)).toBe(MAX_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 7. EFFECT_FAIRY_LOCK. BattleScript_EffectFairyLock (battle_scripts_1.s:835-845).
// accuracycheck (:837)
// ppreduce (:839)
// trysetfairylock BattleScript_ButItFailed (:840, VARIOUS_TRY_FAIRY_LOCK:6799-6808)
// CanBattlerEscape (battle_util.c:4848): blocks escape under STATUS_FIELD_FAIRY_LOCK
// ENDTURN_FAIRY_LOCK (battle_util.c:2175-2178): timer decrements when !started
// ---------------------------------------------------------------------------
describe('cycle 133 - Fairy Lock (EFFECT_FAIRY_LOCK)', () => {
  it('sets field fairy lock, blocks escape on next turn, and expires at end of next turn (:835-845, :6804-6806, :4848, :2176-2177)', () => {
    // Turn 1: Fairy Lock used. Draw 0 = accuracy hit.
    const rng = countRng()
    const state = battle(user('MOVE_FAIRY_LOCK', 10), foe(), rng)
    const out = runVs(state, 'MOVE_FAIRY_LOCK')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :839
    expect(hasFlag(state.field.statuses, STATUS_FIELD_FAIRY_LOCK)).toBe(true) // :6804
    expect(state.field.timers.fairyLockTimer).toBe(1) // :6806
    expect(rng.calls).toBe(1) // 1 accuracy draw

    // During next turn: escape is blocked for battler 1 (:4848)
    const escapeDeps = { dataContext: DATA_CONTEXT, grounding: groundingFor(SIM, state) }
    expect(canBattlerEscape(state, 1, escapeDeps)).toBe(false)

    // Turn 2: another turn executes, end of turn ticks timer 1 -> 0, clearing lock (:2176-2177)
    runVs(state, 'MOVE_TACKLE')
    expect(hasFlag(state.field.statuses, STATUS_FIELD_FAIRY_LOCK)).toBe(false) // :2177
    expect(canBattlerEscape(state, 1, escapeDeps)).toBe(true) // escape restored
  })

  it('negative case: fails when Fairy Lock is already active on field (:6801-6802 -> BattleScript_ButItFailed)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_FAIRY_LOCK', 10), foe(), rng)
    state.field.statuses |= STATUS_FIELD_FAIRY_LOCK
    state.field.timers.fairyLockTimer = 1
    const out = runVs(state, 'MOVE_FAIRY_LOCK')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :839 ran
  })
})

// ---------------------------------------------------------------------------
// 8. EFFECT_MAGNITUDE. BattleScript_EffectMagnitude (battle_scripts_1.s:5253-5264).
// ppreduce (:5257)
// magnitudedamagecalculation (:5258, Cmd_magnitudedamagecalculation:11250-11284)
// accuracycheck (:5262)
// Thresholds in C: <5 (tier 4, 10 bp), <15 (tier 5, 30 bp), <35 (tier 6, 50 bp),
//   <65 (tier 7, 70 bp), <85 (tier 8, 90 bp), <95 (tier 9, 110 bp), else (tier 10, 150 bp).
// Hand-derived damage at level 50, Atk 100, Def 100, neutral type (Mudkip vs Mudkip):
//   `Math.trunc(22 * power / 50) + 2`
//   tier 4 (bp 10): trunc(220/50)+2 = 6 dmg
//   tier 5 (bp 30): trunc(660/50)+2 = 15 dmg
//   tier 6 (bp 50): trunc(1100/50)+2 = 24 dmg
//   tier 7 (bp 70): trunc(1540/50)+2 = 32 dmg
//   tier 8 (bp 90): trunc(1980/50)+2 = 41 dmg
//   tier 9 (bp 110): trunc(2420/50)+2 = 50 dmg
//   tier 10 (bp 150): trunc(3300/50)+2 = 68 dmg
// ---------------------------------------------------------------------------
describe('cycle 133 - Magnitude (EFFECT_MAGNITUDE)', () => {
  // Draw order:
  // Draw 0 = accuracy check (< 100 hits).
  // Draw 1 = magnitude roll (Random() % 100).
  // Draw 2 = crit check (1 = no crit).
  // Draw 3 = damage roll (0 = max 100% roll).
  it.each([
    [4, 6], // roll 4 < 5 -> tier 4 (power 10 -> 6 dmg, :11261)
    [5, 15], // roll 5 < 15 -> tier 5 (power 30 -> 15 dmg, :11264)
    [14, 15], // roll 14 < 15 -> tier 5 (power 30 -> 15 dmg, :11264)
    [15, 24], // roll 15 < 35 -> tier 6 (power 50 -> 24 dmg, :11267)
    [34, 24], // roll 34 < 35 -> tier 6 (power 50 -> 24 dmg, :11267)
    [35, 32], // roll 35 < 65 -> tier 7 (power 70 -> 32 dmg, :11270)
    [64, 32], // roll 64 < 65 -> tier 7 (power 70 -> 32 dmg, :11270)
    [65, 41], // roll 65 < 85 -> tier 8 (power 90 -> 41 dmg, :11273)
    [84, 41], // roll 84 < 85 -> tier 8 (power 90 -> 41 dmg, :11273)
    [85, 50], // roll 85 < 95 -> tier 9 (power 110 -> 50 dmg, :11276)
    [94, 50], // roll 94 < 95 -> tier 9 (power 110 -> 50 dmg, :11276)
    [95, 68], // roll 95 >= 95 -> tier 10 (power 150 -> 68 dmg, :11279)
  ] as const)('boundary roll %i resolves to expected damage %i (:11259-11281)', (roll, expectedDmg) => {
    const rng = scriptedRng([0, roll, 1, 0])
    const state = battle(user('MOVE_MAGNITUDE', 20), foe({ hp: 100, maxHp: 100 }), rng)
    runVsReal(state, 'MOVE_MAGNITUDE')

    expect(ppOf(state, 0)).toBe(19) // ppreduce :5257
    expect(100 - state.battlers[1]!.mon.hp).toBe(expectedDmg)
  })

  it('negative case: accuracy miss at floor deals 0 damage (:5262 -> BattleScript_MoveMissedPause)', () => {
    const rng = missRng() // draw 0 is 99 > 33% floor
    const state = atAccuracyFloor(battle(user('MOVE_MAGNITUDE', 20), foe({ hp: 100, maxHp: 100 }), rng))
    const out = runVsReal(state, 'MOVE_MAGNITUDE')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(19) // ppreduce :5257 ran before accuracycheck
    expect(state.battlers[1]!.mon.hp).toBe(100) // undamaged
  })
})

// ---------------------------------------------------------------------------
// 9. EFFECT_TEATIME. BattleScript_EffectTeatime (battle_scripts_1.s:12622-12652).
// ppreduce (:12625)
// BattleScript_Teatime_AnyBerriesLoop (:12626-12634): checks all battlers for berry
// BattleScript_Teatime_EatBerriesLoop (:12638-12650): all holding berries consume them
// ---------------------------------------------------------------------------
describe('cycle 133 - Teatime (EFFECT_TEATIME)', () => {
  it('forces all battlers holding a berry to consume them (:12625, :12638-12650)', () => {
    const rng = countRng()
    // Both user and foe damaged so HP-restoring berries activate and are consumed (:12648, :10860)
    const state = battle(
      user('MOVE_TEATIME', 10, { hp: 50, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY' }),
      foe({ hp: 50, maxHp: 100, itemId: 'ITEM_ORAN_BERRY' }),
      rng,
    )
    const out = runVs(state, 'MOVE_TEATIME')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :12625
    expect(state.battlers[0]!.mon.itemId).toBeNull() // user berry consumed (:12648)
    expect(state.battlers[0]!.mon.hp).toBe(75) // Sitrus heals 25% = 25 HP -> 75
    expect(state.battlers[1]!.mon.itemId).toBeNull() // foe berry consumed (:12648)
    expect(state.battlers[1]!.mon.hp).toBe(60) // Oran heals 10 HP -> 60
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('negative case: fails if no battler on the field holds a berry (:12634 -> BattleScript_ButItFailed)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TEATIME', 10, { itemId: null }), foe({ itemId: null }), rng)
    const out = runVs(state, 'MOVE_TEATIME')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :12625 ran
  })
})

// ---------------------------------------------------------------------------
// 10. EFFECT_TIDY_UP. BattleScript_EffectTidyUp (battle_scripts_1.s:5440-5465).
// ppreduce (:5443)
// setmoveeffect MOVE_EFFECT_RAPIDSPIN | MOVE_EFFECT_AFFECTS_USER | MOVE_EFFECT_CERTAIN (:5446)
//   -> rapidspinfree (battle_script_commands.c:11367-11426): clears user side hazards
// jumpifstat BS_ATTACKER, CMP_LESS_THAN, STAT_ATK, MAX_STAT_STAGE, BattleScript_TidyUpDoMoveAnim (:5448)
// jumpifstat BS_ATTACKER, CMP_EQUAL, STAT_SPEED, MAX_STAT_STAGE, BattleScript_CantRaiseMultipleStats (:5449)
// +1 Atk (:5452), +1 Speed (:5457)
// ---------------------------------------------------------------------------
describe('cycle 133 - Tidy Up (EFFECT_TIDY_UP)', () => {
  it('clears hazards on user side and raises Atk and Speed by 1 (:5443, :5446, :5452, :5457, :11367-11426)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TIDY_UP', 10), foe(), rng)
    state.sides[0]!.statuses |= SIDE_STATUS_SPIKES | SIDE_STATUS_STEALTH_ROCK
    state.sides[0]!.timers.spikesAmount = 2
    state.sides[0]!.timers.stealthRockType = 6 // rock type
    const out = runVs(state, 'MOVE_TIDY_UP')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :5443
    // Hazards cleared on user's side (:11408, :11422)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(false)
    expect(state.sides[0]!.timers.spikesAmount).toBe(0)
    // +1 Atk, +1 Speed (:5452, :5457)
    expect(stageOf(state, 0, STAT_ATK)).toBe(7) // 6 -> 7
    expect(stageOf(state, 0, STAT_SPEED)).toBe(7) // 6 -> 7
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('negative case: when both Atk and Speed are at max, stat boost fails but hazards are still cleared (:5446, :5449)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_TIDY_UP', 10), foe(), rng)
    state.battlers[0]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MAX_STAT_STAGE
    state.sides[0]!.statuses |= SIDE_STATUS_SPIKES
    state.sides[0]!.timers.spikesAmount = 1
    const out = runVs(state, 'MOVE_TIDY_UP')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(9) // ppreduce :5443 ran
    // Rapid spin free ran BEFORE stat check (:5446)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
    expect(state.sides[0]!.timers.spikesAmount).toBe(0)
    expect(stageOf(state, 0, STAT_ATK)).toBe(MAX_STAT_STAGE)
    expect(stageOf(state, 0, STAT_SPEED)).toBe(MAX_STAT_STAGE)
  })
})

// ---------------------------------------------------------------------------
// 11. EFFECT_WATERLOG. BattleScript_EffectWaterlog (battle_scripts_1.s:2993-3011).
// accuracycheck (:2995)
// ppreduce (:2997)
// setwaterlogged BS_TARGET (:2998, VARIOUS_WATERLOG:8916-8918) -> sets round.waterlog = true
// setmoveeffect MOVE_EFFECT_DRENCH (:3001)
// rain boost: setmoveeffectchance 50 (:3005), else 20% (:3007)
// ---------------------------------------------------------------------------
describe('cycle 133 - Waterlog (EFFECT_WATERLOG)', () => {
  it('delays target (halving speed twice -> out.endTurnOrder puts user first) in clear weather (:2995, :2997, :2998, :8917)', () => {
    // Waterlog has priority 3 (moves.json).
    // User has Spe 60, Foe has Spe 100. Normally Foe (100) > User (60) in endTurnOrder.
    // Waterlog hits -> target's speed quartered to 25 (:4304) for the round.
    // In endTurnOrder, User (Spe 60) > Foe (quartered to 25), so order is [0, 1].
    // Draw 0 = accuracy hit (< 100).
    // Draw 1 = drench roll: 50 >= 20 -> drench does not land.
    const rng = scriptedRng([0, 50])
    const state = battle(
      user('MOVE_WATERLOG', 15, { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 60 } }),
      foe({ rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 } }),
      rng,
    )
    const out = runVs(state, 'MOVE_WATERLOG')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(14) // ppreduce :2997
    expect(out.endTurnOrder).toEqual([0, 1]) // target quartered from 100 -> 25 (:4304)
    expect(state.battlers[1]!.volatiles.drenched).toBe(0) // drench roll 50 >= 20
    expect(rng.calls).toBe(2) // 1 accuracy, 1 drench chance
  })

  it('drenches target in rain with 50% chance (:3005, :3007)', () => {
    // In rain, chance is 50%. Treecko is Grass type (can be drenched, unlike Water types :1442).
    // Draw 0 = accuracy hit (< 100).
    // Draw 1 = drench roll: 30 < 50 -> drench lands!
    // Draw 2 = drench duration: 2 + (0 % 2) = 2 turns.
    const rng = scriptedRng([0, 30, 0])
    const state = battle(
      user('MOVE_WATERLOG', 15, { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 60 } }),
      monFor('SPECIES_TREECKO', { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 } }),
      rng,
    )
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = runVs(state, 'MOVE_WATERLOG')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(14)
    expect(out.endTurnOrder).toEqual([0, 1])
    expect(state.battlers[1]!.volatiles.drenched).toBe(2) // drenched 2 turns
  })

  it('negative case: accuracy miss at floor leaves target speed unaffected (:2995 -> BattleScript_PrintMoveMissed)', () => {
    const rng = missRng()
    const state = atAccuracyFloor(
      battle(
        user('MOVE_WATERLOG', 15, { rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 60 } }),
        foe({ rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 } }),
        rng,
      ),
    )
    const out = runVs(state, 'MOVE_WATERLOG')

    expect(actionOf(out, 0)?.missed).toBe(true)
    expect(ppOf(state, 0)).toBe(14)
    // Missed -> target speed not quartered, so Foe (Spe 100) > User (Spe 60) in endTurnOrder
    expect(out.endTurnOrder).toEqual([1, 0])
    expect(state.battlers[1]!.volatiles.drenched).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 12. EFFECT_SHOWTIME. BattleScript_EffectShowtime (battle_scripts_1.s:12479-12502).
// ppreduce (:12481)
// showtime 0 (:12482, VARIOUS_SHOWTIME:8697-8700): clears trickRoom, wonderRoom, inverseRoom
// showtime 1 (:12486, VARIOUS_SHOWTIME:8704-8710): sets magicRoom = 5 if not active
// BattleScript_MoveSwitch (:12490): switches user out if possible
// ---------------------------------------------------------------------------
describe('cycle 133 - Showtime (EFFECT_SHOWTIME)', () => {
  it('clears trick room and sets magic room to 5 turns (:12481, :8698, :8708)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHOWTIME', 10), foe(), rng)
    state.field.timers.trickRoomTimer = 3
    const out = runVs(state, 'MOVE_SHOWTIME')

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(ppOf(state, 0)).toBe(9) // ppreduce :12481
    expect(state.field.timers.trickRoomTimer).toBe(0) // cleared (:8698)
    expect(state.field.timers.magicRoomTimer).toBe(5) // set to 5 (:8708)
    expect(state.field.timers.started.magicRoom).toBe(true)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('switches the user out when a reserve mon is available (:12490, :5371-5373)', () => {
    const rng = countRng()
    const replacement: ReplacementDeps = { chooseReplacement: () => 1 }
    const state = battle(user('MOVE_SHOWTIME', 10), foe(), rng, {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_TREECKO')],
    })
    const out = runVs(state, 'MOVE_SHOWTIME', replacement)

    expect(actionOf(out, 0)?.missed).toBeFalsy()
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO') // switched to reserve (:5372)
    expect(state.battlers[0]!.partyIndex).toBe(1)
  })

  it('edge case: does not reset magic room timer when magic room is already active (:8704-8705)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SHOWTIME', 10), foe(), rng)
    state.field.timers.magicRoomTimer = 2
    runVs(state, 'MOVE_SHOWTIME')

    expect(ppOf(state, 0)).toBe(9)
    // Mode 1 jumps past setting magic room when timer > 0 (:8705)
    expect(state.field.timers.magicRoomTimer).toBe(2) // remains 2, not reset to 5
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe('cycle 133 registry', () => {
  const SHIPPED_EFFECTS = [
    'EFFECT_SHORE_UP',
    'EFFECT_THIRD_TYPE',
    'EFFECT_PSYCHO_SHIFT',
    'EFFECT_STUFF_CHEEKS',
    'EFFECT_GEAR_UP',
    'EFFECT_SHELTER',
    'EFFECT_FAIRY_LOCK',
    'EFFECT_MAGNITUDE',
    'EFFECT_TEATIME',
    'EFFECT_TIDY_UP',
    'EFFECT_WATERLOG',
    'EFFECT_SHOWTIME',
  ]

  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })

  it('none of these effects is allowlisted: all twelve have singles-observable behaviour', () => {
    for (const effect of SHIPPED_EFFECTS) expect(findAllowance(effect)).toBeUndefined()
  })

  it.each([
    ['MOVE_SHORE_UP', 'EFFECT_SHORE_UP'],
    ['MOVE_FORESTS_CURSE', 'EFFECT_THIRD_TYPE'],
    ['MOVE_INCITE', 'EFFECT_THIRD_TYPE'],
    ['MOVE_TRICK_OR_TREAT', 'EFFECT_THIRD_TYPE'],
    ['MOVE_PSYCHO_SHIFT', 'EFFECT_PSYCHO_SHIFT'],
    ['MOVE_STUFF_CHEEKS', 'EFFECT_STUFF_CHEEKS'],
    ['MOVE_GEAR_UP', 'EFFECT_GEAR_UP'],
    ['MOVE_SHELTER', 'EFFECT_SHELTER'],
    ['MOVE_FAIRY_LOCK', 'EFFECT_FAIRY_LOCK'],
    ['MOVE_MAGNITUDE', 'EFFECT_MAGNITUDE'],
    ['MOVE_TEATIME', 'EFFECT_TEATIME'],
    ['MOVE_TIDY_UP', 'EFFECT_TIDY_UP'],
    ['MOVE_WATERLOG', 'EFFECT_WATERLOG'],
    ['MOVE_SHOWTIME', 'EFFECT_SHOWTIME'],
  ])('%s has %s', (moveId, effect) => expect(effectOf(moveId)).toBe(effect))
})
