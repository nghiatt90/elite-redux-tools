/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 126: twelve healing move effects (Geomancy through Purify). Every number below is derived by
// hand from the C: the script line in data/battle_scripts_1.s and the command in
// src/battle_script_commands.c are cited on the test that asserts it. Stat stages run 0..12
// (neutral 6), so the C's MIN_STAT_STAGE is stage 0 and MAX_STAT_STAGE stage 12.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS2_MULTIPLETURNS,
  STATUS2_NIGHTMARE,
  STATUS2_SUBSTITUTE,
  STATUS3_HEAL_BLOCK,
  STATUS3_SEMI_INVULNERABLE,
  WEATHER_FOG_TEMPORARY,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import { VERIFIED_MOVE_EFFECTS } from './driver/verifiedMoveEffects'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
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

/** The first draw is 99 (`99 % 100 >= accuracy` misses any accuracy at or below 99), the rest 0. */
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

const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

const THIS_FILE = 'web/src/engine/sim/cycle126HealingEffects.test.ts'
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect

/** The user (battler 0, Mudkip, faster than the default foe) knows only `moveId` with 10 PP. */
const user = (moveId: string, overrides: Partial<SimBattleMon> = {}) =>
  monFor('SPECIES_MUDKIP', {
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 150 },
    moves: [moveId, null, null, null],
    pp: [10, 0, 0, 0],
    ...overrides,
  })
const foe = (overrides: Partial<SimBattleMon> = {}) => monFor('SPECIES_MUDKIP', overrides)

/** Puts the user's accuracy stage at its floor, so a 100%-accuracy move becomes 33%.
 * createBattlerState starts every battler neutral, so stages are written after the battle exists. */
function atAccuracyFloor(state: BattleState): BattleState {
  state.battlers[0]!.mon.statStages[STAT_ACC] = MIN_STAT_STAGE
  return state
}

/** One turn where the user (battler 0) uses `moveId` on itself, the foe does nothing. */
function runSelf(state: BattleState, moveId: string): TurnOutcome {
  return executeTurn(state, [useMove(0, moveId), null], loopDeps(state, fixedDamage(0)))
}

const ppOf = (state: BattleState) => state.battlers[0]!.mon.pp[0]
const foeOf = (state: BattleState) => state.battlers[1]!
const actionOf = (out: TurnOutcome, battlerId: number) => out.actions.find((a) => a.battlerId === battlerId)

// BattleScript_EffectGeomancy data/battle_scripts_1.s:4455-4494. Turn 1: jumpifstatus2
// STATUS2_MULTIPLETURNS fails, BattleScriptFirstChargingTurn (:4079-4093) runs ppreduce and
// sets STATUS2_MULTIPLETURNS + MOVE_EFFECT_CHARGING (src/battle_script_commands.c:2714-2720);
// twoturnmoveacceleratecheck then normally ends the turn. Turn 2: attackcanceler,
// clearstatusfromeffect + HITMARKER_NO_PPDEDUCT (:4463-4467, so no second PP), then the
// jumpifstat ladder (:4468-4470): fails only when SpAtk AND SpDef are at MAX and Speed is
// also MAX; otherwise SpAtk, SpDef, Speed each get +2 (:4477, :4486, :4491-4493).
describe('cycle 126 - Geomancy (EFFECT_GEOMANCY)', () => {
  it('turn 1 charges: PP 10 -> 9, STATUS2_MULTIPLETURNS set, no stat change, zero draws', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GEOMANCY'), foe(), rng)
    const out = runSelf(state, 'MOVE_GEOMANCY')
    expect(ppOf(state)).toBe(9) // ppreduce inside BattleScriptFirstChargingTurn
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true) // :4460
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('turn 2 uses no PP and raises SpAtk/SpDef/Speed 6 -> 8', () => {
    const rng = countRng()
    const state = battle(user('MOVE_GEOMANCY', { pp: [9, 0, 0, 0] }), foe(), rng)
    state.battlers[0]!.mon.status2 = STATUS2_MULTIPLETURNS
    const out = executeTurn(state, [useMove(0, 'MOVE_GEOMANCY'), null], loopDeps(state, fixedDamage(0)))
    expect(ppOf(state)).toBe(9) // HITMARKER_NO_PPDEDUCT (:4467)
    expect(state.battlers[0]!.mon.status2 & STATUS2_MULTIPLETURNS).toBe(0) // clearstatusfromeffect
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(8) // +2 (:4477)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(8) // +2 (:4486)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8) // +2 (:4491)
    expect(actionOf(out, 0)?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPATK, change: 2 },
      { battlerId: 0, stat: STAT_SPDEF, change: 2 },
      { battlerId: 0, stat: STAT_SPEED, change: 2 },
    ])
    expect(rng.calls).toBe(0)
  })

  it('does not fail when only Speed can rise (SpAtk 12, SpDef 12, Speed 6 -> 8)', () => {
    const state = battle(user('MOVE_GEOMANCY', { pp: [9, 0, 0, 0] }), foe(), countRng())
    state.battlers[0]!.mon.status2 = STATUS2_MULTIPLETURNS
    state.battlers[0]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = MAX_STAT_STAGE
    const out = executeTurn(state, [useMove(0, 'MOVE_GEOMANCY'), null], loopDeps(state, fixedDamage(0)))
    // :4468 failure needs Speed EQUAL MAX as well (:4470).
    expect(out.actions[0]?.missed).toBe(false)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(8)
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 0, stat: STAT_SPEED, change: 2 }])
    expect(ppOf(state)).toBe(9)
  })

  it('clamps 11/11/11 to 12/12/12 (min(2, 12 - 11))', () => {
    const state = battle(user('MOVE_GEOMANCY', { pp: [9, 0, 0, 0] }), foe(), countRng())
    state.battlers[0]!.mon.status2 = STATUS2_MULTIPLETURNS
    for (const stat of [STAT_SPATK, STAT_SPDEF, STAT_SPEED]) state.battlers[0]!.mon.statStages[stat] = MAX_STAT_STAGE - 1
    const out = executeTurn(state, [useMove(0, 'MOVE_GEOMANCY'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(MAX_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MAX_STAT_STAGE)
    expect(actionOf(out, 0)?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_SPATK, change: 1 },
      { battlerId: 0, stat: STAT_SPDEF, change: 1 },
      { battlerId: 0, stat: STAT_SPEED, change: 1 },
    ])
    expect(ppOf(state)).toBe(9)
  })

  it('fails only when all three stats are already at 12 (:4470); nothing changes, PP stays 9', () => {
    const state = battle(user('MOVE_GEOMANCY', { pp: [9, 0, 0, 0] }), foe(), countRng())
    state.battlers[0]!.mon.status2 = STATUS2_MULTIPLETURNS
    for (const stat of [STAT_SPATK, STAT_SPDEF, STAT_SPEED]) state.battlers[0]!.mon.statStages[stat] = MAX_STAT_STAGE
    const out = executeTurn(state, [useMove(0, 'MOVE_GEOMANCY'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.missed).toBe(true)
    expect(actionOf(out, 0)?.statChanges).toEqual([])
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectHealBell data/battle_scripts_1.s:4842-4869 -> Cmd_healpartystatus
// (src/battle_script_commands.c:11022-11104). Heal Bell skips the active battler when
// IsSoundproof (battle_util.c:8864-8871) and skips a reserve whose own ability/innate is
// Soundproof (:11062-11078); Aromatherapy (:4847 jumpifnotmove) cures everyone. Both clear
// STATUS2_NIGHTMARE through the status clear, then tryhealpercenthealth 30 (:4862).
describe('cycle 126 - Heal Bell / Aromatherapy (EFFECT_HEAL_BELL)', () => {
  const party = (): SimPartyMon[] => [
    partyMon('SPECIES_MUDKIP', { hp: 40, maxHp: 100, status1: STATUS1_BURN }),
    partyMon('SPECIES_MUDKIP', { status1: STATUS1_POISON }),
    partyMon('SPECIES_MUDKIP', {
      status1: STATUS1_PARALYSIS,
      abilities: { ability: 'ABILITY_SOUNDPROOF', innates: [null, null, null] },
    }),
  ]

  it('Heal Bell cures the user, the party, and Nightmare, and heals 30%: 40 -> 70, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_HEAL_BELL', { hp: 40, maxHp: 100, status1: STATUS1_BURN, status2: STATUS2_NIGHTMARE }),
      foe(),
      rng,
      { playerParty: party() },
    )
    runSelf(state, 'MOVE_HEAL_BELL')
    expect(ppOf(state)).toBe(9) // ppreduce :4845
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.status2 & STATUS2_NIGHTMARE).toBe(0)
    expect(state.sides[0].party[0]!.status1).toBe(0) // active slot
    expect(state.sides[0].party[1]!.status1).toBe(0) // benched, not Soundproof
    expect(state.sides[0].party[2]!.status1).toBe(STATUS1_PARALYSIS) // benched Soundproof keeps it
    expect(state.battlers[0]!.mon.hp).toBe(70) // 40 + 100*30/100 (:4862)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('Aromatherapy cures a benched Soundproof mon too, and heals the same 30%', () => {
    const state = battle(
      user('MOVE_AROMATHERAPY', { hp: 40, maxHp: 100, status1: STATUS1_BURN }),
      foe(),
      countRng(),
      { playerParty: party() },
    )
    runSelf(state, 'MOVE_AROMATHERAPY')
    expect(ppOf(state)).toBe(9)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.sides[0].party[1]!.status1).toBe(0)
    expect(state.sides[0].party[2]!.status1).toBe(0) // :4847 skips the whole Soundproof block
    expect(state.battlers[0]!.mon.hp).toBe(70)
  })

  it('a Soundproof user of Heal Bell does not cure itself but still heals; the party is cured', () => {
    const state = battle(
      user('MOVE_HEAL_BELL', {
        hp: 40,
        maxHp: 100,
        status1: STATUS1_BURN,
        abilities: { ability: 'ABILITY_SOUNDPROOF', innates: [null, null, null] },
      }),
      foe(),
      countRng(),
      { playerParty: party() },
    )
    runSelf(state, 'MOVE_HEAL_BELL')
    expect(ppOf(state)).toBe(9)
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN) // IsSoundproof(battler) skips the direct clear
    expect(state.sides[0].party[0]!.status1).toBe(STATUS1_BURN) // healMon = !isSoundproof(partyIndex)
    expect(state.sides[0].party[1]!.status1).toBe(0)
    // 40 + 30 = 70, then ENDTURN_BURN costs trunc(100/16) = 6 because the user kept the burn.
    expect(state.battlers[0]!.mon.hp).toBe(64) // the heal itself has no soundproof gate
  })

  it('does not heal past max HP and still cures status', () => {
    const state = battle(
      user('MOVE_HEAL_BELL', { hp: 100, maxHp: 100, status1: STATUS1_BURN }),
      foe(),
      countRng(),
      { playerParty: [partyMon('SPECIES_MUDKIP', { status1: STATUS1_BURN })] },
    )
    runSelf(state, 'MOVE_HEAL_BELL')
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectJungleHealing data/battle_scripts_1.s:773-804:
// ppreduce (:776), jumpifteamhealthy BS_ATTACKER -> ButItFailed (:777), then 25%
// (VARIOUS_TRY_HEAL_PERCENT_HP, battle_script_commands.c:7896-7907); the cure status branch is
// skipped only for MOVE_LIFE_DEW (:791). A full-HP user with a status is not "healthy", so it
// reaches tryhealpercenthealth (silently 0) and still cures.
describe('cycle 126 - Jungle Healing / Life Dew / Lunar Blessing (EFFECT_JUNGLE_HEALING)', () => {
  it('Jungle Healing heals 25% and cures status: 40 -> 65, burn -> 0, PP 10 -> 9', () => {
    const state = battle(user('MOVE_JUNGLE_HEALING', { hp: 40, maxHp: 100, status1: STATUS1_BURN }), foe(), countRng())
    const out = runSelf(state, 'MOVE_JUNGLE_HEALING')
    expect(ppOf(state)).toBe(9)
    expect(state.battlers[0]!.mon.hp).toBe(65) // 40 + 100*25/100 (:7896-7907)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(out.actions[0]?.missed).toBe(false)
  })

  it('Life Dew heals but never cures (:791)', () => {
    const state = battle(user('MOVE_LIFE_DEW', { hp: 40, maxHp: 100, status1: STATUS1_BURN }), foe(), countRng())
    runSelf(state, 'MOVE_LIFE_DEW')
    expect(ppOf(state)).toBe(9)
    // 40 + 25 = 65, then ENDTURN_BURN costs trunc(100/16) = 6 because Life Dew left the burn.
    expect(state.battlers[0]!.mon.hp).toBe(59)
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN)
  })

  it('Lunar Blessing purges status too (only Life Dew is exempt)', () => {
    const state = battle(user('MOVE_LUNAR_BLESSING', { hp: 40, maxHp: 100, status1: STATUS1_FROSTBITE }), foe(), countRng())
    runSelf(state, 'MOVE_LUNAR_BLESSING')
    expect(state.battlers[0]!.mon.hp).toBe(65)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a full-HP user with a status still cures it and does not heal', () => {
    const state = battle(user('MOVE_JUNGLE_HEALING', { hp: 100, maxHp: 100, status1: STATUS1_POISON }), foe(), countRng())
    const out = runSelf(state, 'MOVE_JUNGLE_HEALING')
    // jumpifteamhealthy needs hp == maxHP AND status1 == 0 (:7883-7895); this user is not healthy.
    expect(out.actions[0]?.missed).toBe(false)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(ppOf(state)).toBe(9)
  })

  it('a healthy full-HP user fails (:777), PP 10 -> 9, zero draws', () => {
    const rng = countRng()
    const state = battle(user('MOVE_JUNGLE_HEALING'), foe(), rng)
    const out = runSelf(state, 'MOVE_JUNGLE_HEALING')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(ppOf(state)).toBe(9) // ppreduce :776 runs before the jump
    expect(rng.calls).toBe(0)
  })
})

// BattleScript_EffectRefresh data/battle_scripts_1.s:6484-6508: ppreduce (:6487),
// cureifburnedparalysedorpoisoned (Cmd_cureifburnedparalysedorpoisoned,
// src/battle_script_commands.c:11648-11660 clears POISON|BURN|PARALYSIS|TOXIC|FROSTBITE|BLEED),
// then tryhealpercenthealth 25 (:6494). With no curable status it runs the NoStatusHeal branch
// (:6500): heal 25 if damaged, else ButItFailed.
describe('cycle 126 - Refresh (EFFECT_REFRESH)', () => {
  it('a burned full-HP user is cured with no heal; PP 10 -> 9, zero draws', () => {
    const rng = countRng()
    const state = battle(user('MOVE_REFRESH', { status1: STATUS1_BURN }), foe(), rng)
    const out = runSelf(state, 'MOVE_REFRESH')
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(out.actions[0]?.missed).toBe(false)
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(0) // Refresh has no accuracycheck
  })

  it('a damaged burned user is cured and healed 25%: 40 -> 65', () => {
    const state = battle(user('MOVE_REFRESH', { hp: 40, maxHp: 100, status1: STATUS1_BURN }), foe(), countRng())
    runSelf(state, 'MOVE_REFRESH')
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(65)
    expect(ppOf(state)).toBe(9)
  })

  it('cures Frostbite and Bleed together (the whole mask, not only burn/paralysis/poison)', () => {
    const state = battle(
      user('MOVE_REFRESH', { hp: 40, maxHp: 100, status1: STATUS1_FROSTBITE | STATUS1_BLEED }),
      foe(),
      countRng(),
    )
    runSelf(state, 'MOVE_REFRESH')
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(65)
    expect(ppOf(state)).toBe(9)
  })

  it('with no status at full HP the NoStatusHeal branch fails (:6500-6501); PP 10 -> 9', () => {
    const state = battle(user('MOVE_REFRESH'), foe(), countRng())
    const out = runSelf(state, 'MOVE_REFRESH')
    expect(out.actions[0]?.missed).toBe(true) // tryhealpercenthealth at full HP -> ButItFailed
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(ppOf(state)).toBe(9)
  })

  it('with no status and damage it takes the heal-only branch: 40 -> 65', () => {
    const state = battle(user('MOVE_REFRESH', { hp: 40, maxHp: 100 }), foe(), countRng())
    const out = runSelf(state, 'MOVE_REFRESH')
    expect(out.actions[0]?.missed).toBe(false)
    expect(state.battlers[0]!.mon.hp).toBe(65)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectMorningSun / Synthesis / Moonlight data/battle_scripts_1.s:5496-5503 ->
// Cmd_recoverbasedonsunlight (src/battle_script_commands.c:11433-11460): bleed cures instead of
// healing (:11435-11437), a full-HP user jumps to MoveEnd (:11439-11440), and the amount is
// 1/4 in rain/sandstorm/fog/hail, 1/2 in clear weather, 2/3 in sun (:11447-11458).
// Moonlight also has the ABILITY_MOON_SPIRIT 3/4 branch (:11442-11445).
describe('cycle 126 - Synthesis / Moonlight (EFFECT_SYNTHESIS, EFFECT_MOONLIGHT)', () => {
  const at = (weather: number, hp = 10, maxHp = 150) => {
    const state = battle(user('MOVE_SYNTHESIS', { hp, maxHp }), foe(), countRng())
    state.field.weather = weather
    state.field.weatherDuration = 1 // end of turn lets it expire instead of damaging
    return state
  }

  it('clear weather heals half: 10/150 -> 85; PP 10 -> 9, zero draws', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SYNTHESIS', { hp: 10, maxHp: 150 }), foe(), rng)
    runSelf(state, 'MOVE_SYNTHESIS')
    expect(state.battlers[0]!.mon.hp).toBe(85) // 10 + 150/2 (:11457)
    expect(ppOf(state)).toBe(9) // ppreduce
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('sun heals 2/3: 10/150 -> 110', () => {
    const state = at(WEATHER_SUN_TEMPORARY)
    runSelf(state, 'MOVE_SYNTHESIS')
    expect(state.battlers[0]!.mon.hp).toBe(110) // 10 + 150*2/3
    expect(ppOf(state)).toBe(9)
  })

  it('rain heals 1/4: 10/150 -> 47', () => {
    const state = at(WEATHER_RAIN_TEMPORARY)
    runSelf(state, 'MOVE_SYNTHESIS')
    expect(state.battlers[0]!.mon.hp).toBe(47) // 10 + trunc(150/4) = 10 + 37
    expect(ppOf(state)).toBe(9)
  })

  it('sandstorm heals 1/4 (weather ends this turn, so no weather damage): 10/150 -> 47', () => {
    const state = at(WEATHER_SANDSTORM_TEMPORARY)
    runSelf(state, 'MOVE_SYNTHESIS')
    expect(state.battlers[0]!.mon.hp).toBe(47)
    expect(ppOf(state)).toBe(9)
  })

  it('hail heals 1/4: 10/150 -> 47', () => {
    const state = at(WEATHER_HAIL_TEMPORARY)
    runSelf(state, 'MOVE_SYNTHESIS')
    expect(state.battlers[0]!.mon.hp).toBe(47)
    expect(ppOf(state)).toBe(9)
  })

  it('at full HP nothing happens (MoveEnd), PP 10 -> 9', () => {
    const state = at(0, 150, 150)
    const out = runSelf(state, 'MOVE_SYNTHESIS')
    expect(state.battlers[0]!.mon.hp).toBe(150)
    expect(out.actions[0]?.missed).toBe(false)
    expect(ppOf(state)).toBe(9) // ppreduce still ran
  })

  it('bleed is cured instead of healing (:11435-11437); PP 10 -> 9', () => {
    const state = battle(user('MOVE_SYNTHESIS', { hp: 10, maxHp: 150, status1: STATUS1_BLEED }), foe(), countRng())
    runSelf(state, 'MOVE_SYNTHESIS')
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(10) // no heal; PresentHealTarget's bleed branch
    expect(ppOf(state)).toBe(9)
  })

  it('Moonlight with ABILITY_MOON_SPIRIT heals 3/4: 10/150 -> 122', () => {
    const state = battle(
      user('MOVE_MOONLIGHT', {
        hp: 10,
        maxHp: 150,
        abilities: { ability: 'ABILITY_MOON_SPIRIT', innates: [null, null, null] },
      }),
      foe(),
      countRng(),
    )
    runSelf(state, 'MOVE_MOONLIGHT')
    expect(state.battlers[0]!.mon.hp).toBe(122) // 10 + trunc(150*3/4) = 10 + 112
    expect(ppOf(state)).toBe(9)
  })

  it('Synthesis keeps the weather 1/2 with ABILITY_MOON_SPIRIT (the branch is Moonlight-only)', () => {
    const state = battle(
      user('MOVE_SYNTHESIS', {
        hp: 10,
        maxHp: 150,
        abilities: { ability: 'ABILITY_MOON_SPIRIT', innates: [null, null, null] },
      }),
      foe(),
      countRng(),
    )
    runSelf(state, 'MOVE_SYNTHESIS')
    expect(state.battlers[0]!.mon.hp).toBe(85)
    expect(ppOf(state)).toBe(9)
  })

  // battle_util.c:1400-1403 (IsHealBlockPreventingMove) and its CANCELLER_HEAL_BLOCKED at
  // :3326-3336: Heal Block cancels STATUS moves whose effect is in IsHealingMoveEffect
  // (:8880-8904, which lists EFFECT_SYNTHESIS and EFFECT_MOONLIGHT) BEFORE the handler runs,
  // so no PP is spent. The handler's own doc comment only means the handler body does not
  // check CanBattlerHeal.
  it('Heal Block cancels Synthesis before its script (no PP, no heal)', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SYNTHESIS', { hp: 10, maxHp: 150 }), foe(), rng)
    state.battlers[0]!.statuses3 = STATUS3_HEAL_BLOCK
    state.battlers[0]!.volatiles.healBlockTimer = 5
    const out = runSelf(state, 'MOVE_SYNTHESIS')
    expect(out.actions[0]?.cancelledBy).toBe('HEAL_BLOCK')
    expect(state.battlers[0]!.mon.hp).toBe(10)
    expect(ppOf(state)).toBe(10)
    expect(rng.calls).toBe(0)
  })
})

// BattleScript_EffectWish data/battle_scripts_1.s:6306-6313 -> Cmd_trywish case 0
// (src/battle_script_commands.c:11784-11793): fails if wishCounter != 0, else counter = 2 and
// wishPartyId = the user's party index. ENDTURN_WISH (battle_util.c:1943-1958) decrements every
// end of turn and, at 0, BattleScript_WishComesTrue (:8187-8207) heals max(1, wishPartyId's
// maxHP / 2) -- B_WISH_HP_SOURCE >= GEN_5 (:11801-11805), i.e. the WISHER's party slot, not the
// current battler's; a full-HP target goes to WishButFullHp; bleed is cured instead.
describe('cycle 126 - Wish (EFFECT_WISH)', () => {
  it('does not heal on the use turn; heals half of the wisher maxHP at the end of the next turn', () => {
    const rng = countRng()
    const state = battle(user('MOVE_WISH', { hp: 40, maxHp: 100 }), foe(), rng)
    const out1 = runSelf(state, 'MOVE_WISH')
    expect(ppOf(state)).toBe(9) // ppreduce :6309
    expect(state.field.wishCounter[0]).toBe(1) // 2 set by trywish, decremented once at end of turn
    expect(state.battlers[0]!.mon.hp).toBe(40) // no heal yet
    expect(out1.fieldEndTurn.some((e) => e.effect === 'WISH')).toBe(false)
    expect(rng.calls).toBe(0) // no accuracycheck

    const out2 = executeTurn(state, [null, null], loopDeps(state, fixedDamage(0)))
    expect(state.field.wishCounter[0]).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(90) // 40 + 100/2
    expect(out2.fieldEndTurn).toContainEqual({ battlerId: 0, effect: 'WISH', hpChange: 50, fainted: false })
  })

  it('a second Wish while one is pending fails but still costs PP (:11786-11790)', () => {
    const state = battle(user('MOVE_WISH', { hp: 40, maxHp: 100 }), foe(), countRng())
    runSelf(state, 'MOVE_WISH')
    expect(state.field.wishCounter[0]).toBe(1)
    const out = runSelf(state, 'MOVE_WISH')
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(8) // ppreduce runs before trywish
    // The pending Wish still comes true at this end of turn.
    expect(state.field.wishCounter[0]).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(90)
  })

  it('at full HP the wish comes true but heals nothing (WishButFullHp)', () => {
    const state = battle(user('MOVE_WISH', { hp: 100, maxHp: 100 }), foe(), countRng())
    runSelf(state, 'MOVE_WISH')
    const out = executeTurn(state, [null, null], loopDeps(state, fixedDamage(0)))
    expect(state.field.wishCounter[0]).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(out.fieldEndTurn.some((e) => e.effect === 'WISH')).toBe(false)
  })

  it('after a switch the heal still uses the WISHER party slot max HP (wishPartyId)', () => {
    // Party slot 0 is the wisher (maxHp 60); slot 1 is the replacement (maxHp 200, hp 80).
    const wisher = partyMon('SPECIES_MUDKIP', { hp: 100, maxHp: 60 })
    const replacement = partyMon('SPECIES_MUDKIP', { hp: 80, maxHp: 200 })
    const rng = countRng()
    const state = battle(user('MOVE_WISH', { hp: 100, maxHp: 100 }), foe(), rng, {
      playerParty: [wisher, replacement],
    })
    runSelf(state, 'MOVE_WISH')
    expect(state.field.wishPartyId[0]).toBe(0) // trywish records the wisher's party index
    expect(state.field.wishCounter[0]).toBe(1)

    state.battlers[0]!.monToSwitchIntoId = 1
    const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }
    executeTurn(state, [switchAction, null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.partyIndex).toBe(1)
    // :11801-11805 reads party[wishPartyId].maxHP / 2 = 60/2 = 30, not the newcomer's 200/2 = 100.
    expect(state.battlers[0]!.mon.hp).toBe(110)
    expect(state.sides[0].party[1]!.hp).toBe(110)
  })
})

// BattleScript_EffectHealPulse data/battle_scripts_1.s:2252-2267: ppreduce (:2255),
// accuracycheck NO_ACC_CALC_CHECK_LOCK_ON (:2256 -- no draw, only the semi-invulnerable check),
// jumpifsubstituteblocks (:2257), jumpifhealingblocked BS_TARGET (:2258),
// tryhealpulse BS_TARGET (VARIOUS_TRY_HEAL_PULSE, src/battle_script_commands.c:7261-7284).
// The amount is half the target's maxHP, or 3/4 when the move is bulletBased and the TARGET's
// ability has megaLauncherBoost (:7268-7271 reads gActiveBattler, the healed target). A
// STATUS1_BLEED target is cured instead (:2262). A full-HP target succeeds with no heal.
describe('cycle 126 - Heal Pulse / Floral Healing (EFFECT_HEAL_PULSE)', () => {
  const healPulse = (
    moveId: string,
    targetOverride: Partial<SimBattleMon> = {},
    userOverride: Partial<SimBattleMon> = {},
    setup: (state: BattleState) => void = () => {},
  ) => {
    const rng = countRng()
    const state = battle(user(moveId, userOverride), foe(targetOverride), rng)
    setup(state)
    const out = executeTurn(state, [useMove(1, moveId), null], loopDeps(state, fixedDamage(0)))
    return { state, out, rng }
  }

  it('heals the target half its maxHP: 10/100 -> 60; PP 10 -> 9, zero draws', () => {
    const { state, rng } = healPulse('MOVE_HEAL_PULSE', { hp: 10, maxHp: 100 })
    expect(foeOf(state).mon.hp).toBe(60) // 10 + 100/2
    expect(ppOf(state)).toBe(9) // ppreduce :2255
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON has no random
  })

  it('a full-HP target succeeds with no heal (AlreadyAtFullHp); PP 10 -> 9', () => {
    const { state, out } = healPulse('MOVE_HEAL_PULSE', { hp: 100, maxHp: 100 })
    expect(out.actions[0]?.missed).toBe(false)
    expect(foeOf(state).mon.hp).toBe(100)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute blocks it (:2257); PP 10 -> 9', () => {
    const { state, out, rng } = healPulse(
      'MOVE_HEAL_PULSE',
      { hp: 10, maxHp: 100, status2: STATUS2_SUBSTITUTE },
      {},
      (s) => {
        foeOf(s).volatiles.substituteHp = 25
      },
    )
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.hp).toBe(10)
    expect(ppOf(state)).toBe(9)
    expect(rng.calls).toBe(0) // jumpifsubstituteblocks is after the no-draw accuracycheck
  })

  it('Heal Block on the target fails it (:2258); PP 10 -> 9', () => {
    const { state, out } = healPulse('MOVE_HEAL_PULSE', { hp: 10, maxHp: 100 }, {}, (s) => {
      foeOf(s).statuses3 = STATUS3_HEAL_BLOCK
    })
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.hp).toBe(10)
    expect(ppOf(state)).toBe(9)
  })

  it('a semi-invulnerable target fails (:2256) with no draw; PP 10 -> 9', () => {
    const { state, out, rng } = healPulse('MOVE_HEAL_PULSE', { hp: 10, maxHp: 100 }, {}, (s) => {
      foeOf(s).statuses3 = STATUS3_SEMI_INVULNERABLE
    })
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.hp).toBe(10)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a bleed target is cured instead of healed (:2262); PP 10 -> 9', () => {
    const { state } = healPulse('MOVE_HEAL_PULSE', { hp: 10, maxHp: 100, status1: STATUS1_BLEED })
    expect(foeOf(state).mon.status1).toBe(0)
    expect(foeOf(state).mon.hp).toBe(10)
    expect(ppOf(state)).toBe(9)
  })

  it('Mega Launcher on the TARGET boosts Heal Pulse (bulletBased) to 3/4: 10 -> 85', () => {
    const { state } = healPulse('MOVE_HEAL_PULSE', {
      hp: 10,
      maxHp: 100,
      abilities: { ability: 'ABILITY_MEGA_LAUNCHER', innates: [null, null, null] },
    })
    expect(foeOf(state).mon.hp).toBe(85) // 10 + 100*3/4 (:7268-7271)
    expect(ppOf(state)).toBe(9)
  })

  it('Mega Launcher does not boost Floral Healing (no bulletBased flag): 10 -> 60', () => {
    const { state } = healPulse('MOVE_FLORAL_HEALING', {
      hp: 10,
      maxHp: 100,
      abilities: { ability: 'ABILITY_MEGA_LAUNCHER', innates: [null, null, null] },
    })
    expect(foeOf(state).mon.hp).toBe(60)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSwallow data/battle_scripts_1.s:6035-6048. Cmd_ppreduce (:1476-1483)
// spends one Stockpile charge through TryUseStockpile (:9521-9535) before
// Cmd_stockpiletohpheal (:9554-9593) runs; the command then heals
// maxHP / (1 << (3 - counter)), min 1 (:9575-9582), unless the counter is 0 (fail, :9557-9560),
// the user is bleeding (cure instead, :9563-9568) or at full HP (fail, :9569-9574). Every
// non-zero branch restores the saved stages with ChangeStatBuffs(-stockpileDef) for BOTH
// Defense and Sp. Def (:9586-9591), which is a C quirk when the two saved counters differ.
describe('cycle 126 - Swallow (EFFECT_SWALLOW)', () => {
  it('with one charge: ppreduce spends it, the command sees 0 and fails; no PP is spent', () => {
    const rng = countRng()
    const state = battle(user('MOVE_SWALLOW', { hp: 40, maxHp: 160 }), foe(), rng)
    const v = state.battlers[0]!.volatiles
    v.stockpileCounter = 1
    v.stockpileDef = 1
    state.battlers[0]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 1
    const out = runSelf(state, 'MOVE_SWALLOW')
    expect(v.stockpileCounter).toBe(0) // TryUseStockpile :9524
    expect(v.stockpileDef).toBe(0) // :9526-9529
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE) // one stage back
    expect(state.battlers[0]!.mon.hp).toBe(40) // Cmd_stockpiletohpheal sees 0 -> SwallowFail
    expect(ppOf(state)).toBe(10) // the charge replaced the PP (:1476-1483)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('with two charges: ppreduce leaves 1, heals maxHP/4 and restores one stage: 40 -> 80', () => {
    const state = battle(user('MOVE_SWALLOW', { hp: 40, maxHp: 160 }), foe(), countRng())
    const v = state.battlers[0]!.volatiles
    v.stockpileCounter = 2
    v.stockpileDef = 2
    v.stockpileSpDef = 2
    state.battlers[0]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 2
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = DEFAULT_STAT_STAGE + 2
    const out = runSelf(state, 'MOVE_SWALLOW')
    expect(ppOf(state)).toBe(10) // still a charge spent, not PP
    expect(state.battlers[0]!.mon.hp).toBe(80) // 40 + 160/(1 << (3-1)) = 40 + 40
    expect(v.stockpileCounter).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE) // -1 left in stockpileDef
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
    expect(out.actions[0]?.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: -1 },
      { battlerId: 0, stat: STAT_SPDEF, change: -1 },
    ])
  })

  it('with three charges: ppreduce leaves 2, heals maxHP/2: 40/160 -> 120', () => {
    const state = battle(user('MOVE_SWALLOW', { hp: 40, maxHp: 160 }), foe(), countRng())
    const v = state.battlers[0]!.volatiles
    v.stockpileCounter = 3
    v.stockpileDef = 3
    v.stockpileSpDef = 3
    state.battlers[0]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 3
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = DEFAULT_STAT_STAGE + 3
    runSelf(state, 'MOVE_SWALLOW')
    expect(state.battlers[0]!.mon.hp).toBe(120) // 160/(1 << 1) = 80
    // TryUseStockpile took one of the three stages; the command then restores the two left.
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(10)
  })

  it('at full HP the charge is spent and the counter cleared but nothing heals (:9569-9574)', () => {
    const state = battle(user('MOVE_SWALLOW', { hp: 160, maxHp: 160 }), foe(), countRng())
    const v = state.battlers[0]!.volatiles
    v.stockpileCounter = 2
    v.stockpileDef = 2
    v.stockpileSpDef = 2
    state.battlers[0]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 2
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = DEFAULT_STAT_STAGE + 2
    runSelf(state, 'MOVE_SWALLOW')
    expect(state.battlers[0]!.mon.hp).toBe(160)
    expect(v.stockpileCounter).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
    expect(ppOf(state)).toBe(10)
  })

  it('bleed is cured instead of healing (:9563-9568); the charge is spent, not PP', () => {
    const state = battle(user('MOVE_SWALLOW', { hp: 40, maxHp: 160, status1: STATUS1_BLEED }), foe(), countRng())
    const v = state.battlers[0]!.volatiles
    v.stockpileCounter = 2
    v.stockpileDef = 2
    v.stockpileSpDef = 2
    state.battlers[0]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 2
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = DEFAULT_STAT_STAGE + 2
    runSelf(state, 'MOVE_SWALLOW')
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(v.stockpileCounter).toBe(0)
    expect(ppOf(state)).toBe(10)
  })

  it('with no charge it costs PP 10 -> 9 and fails (:9557-9560)', () => {
    const state = battle(user('MOVE_SWALLOW', { hp: 40, maxHp: 160 }), foe(), countRng())
    const out = runSelf(state, 'MOVE_SWALLOW')
    expect(ppOf(state)).toBe(9)
    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(out.actions[0]?.statChanges).toEqual([])
  })

  it('the Sp. Def restore reads stockpileDef, not stockpileSpDef (:9588-9591)', () => {
    const state = battle(user('MOVE_SWALLOW', { hp: 40, maxHp: 160 }), foe(), countRng())
    const v = state.battlers[0]!.volatiles
    v.stockpileCounter = 2
    v.stockpileDef = 2
    v.stockpileSpDef = 1
    state.battlers[0]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 2
    state.battlers[0]!.mon.statStages[STAT_SPDEF] = DEFAULT_STAT_STAGE + 1
    // TryUseStockpile spends one of each: stockpileDef 1 / stockpileSpDef 0, Def 7 / SpDef 6.
    // The command then restores Sp. Def by -stockpileDef = -1, down to 5.
    runSelf(state, 'MOVE_SWALLOW')
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE - 1)
  })
})

// BattleScript_EffectStrengthSap data/battle_scripts_1.s:896-942: attackcanceler,
// jumpifsubstituteblocks ButItFailedAtkStringPpReduce (:898), accuracycheck ACC_CURR_MOVE (:899,
// one draw; a miss reaches PrintMoveMissed which ppreduce's), ppreduce (:901), then either the
// MIN_STAT_STAGE branch (:903-908, drop attempt -> MoveEnd, no heal) or getstatvalue (:910,
// CalculateStat of the TARGET's Attack) followed by the drop and the drain (:913-934).
// manipulatedamage DMG_BIG_ROOT uses GetDrainedBigRootHp (battle_util.c:2369-2376):
// Big Root x3/2 and Absorbant x3/2. A full-HP / heal-blocked / bleeding user takes the MustLower
// path, which still heals when the drop lands, but the :929 full-HP check then ends it.
describe('cycle 126 - Strength Sap (EFFECT_STRENGTH_SAP)', () => {
  it('drops the target Attack 6 -> 5 and heals by its computed Attack: 30/200 -> 130, one draw', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STRENGTH_SAP', { hp: 30, maxHp: 200 }), foe({ rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }), rng)
    const out = executeTurn(state, [useMove(1, 'MOVE_STRENGTH_SAP'), null], loopDeps(state, fixedDamage(0)))
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.hp).toBe(130) // 30 + 100
    expect(actionOf(out, 0)?.statChanges).toEqual([{ battlerId: 1, stat: STAT_ATK, change: -1 }])
    expect(rng.calls).toBe(1) // accuracycheck ACC_CURR_MOVE
    expect(ppOf(state)).toBe(9) // ppreduce :901
  })

  it('Big Root multiplies the drain by 3/2 (150%, not 130%): 10 + 150 -> 160', () => {
    const state = battle(
      user('MOVE_STRENGTH_SAP', { hp: 10, maxHp: 200, itemId: 'ITEM_BIG_ROOT' }),
      foe({ rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 } }),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_STRENGTH_SAP'), null], loopDeps(state, fixedDamage(0)))
    expect(state.battlers[0]!.mon.hp).toBe(160) // 10 + trunc(100*3/2)
    expect(ppOf(state)).toBe(9)
  })

  it('at target Attack stage 0 nothing is lowered and nothing is drained (:903-908)', () => {
    const state = battle(user('MOVE_STRENGTH_SAP', { hp: 30, maxHp: 200 }), foe(), countRng())
    foeOf(state).mon.statStages[STAT_ATK] = MIN_STAT_STAGE
    const out = executeTurn(state, [useMove(1, 'MOVE_STRENGTH_SAP'), null], loopDeps(state, fixedDamage(0)))
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(MIN_STAT_STAGE)
    expect(state.battlers[0]!.mon.hp).toBe(30)
    expect(out.actions[0]?.statChanges).toEqual([])
    expect(ppOf(state)).toBe(9)
  })

  it('a full-HP user still lowers Attack but does not heal (:929)', () => {
    const state = battle(user('MOVE_STRENGTH_SAP', { hp: 200, maxHp: 200 }), foe(), countRng())
    executeTurn(state, [useMove(1, 'MOVE_STRENGTH_SAP'), null], loopDeps(state, fixedDamage(0)))
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.hp).toBe(200)
    expect(ppOf(state)).toBe(9)
  })

  it('a Substitute sends it to ButItFailedAtkStringPpReduce (:898): no draw, PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_STRENGTH_SAP', { hp: 30, maxHp: 200 }), foe({ status2: STATUS2_SUBSTITUTE }), rng)
    foeOf(state).volatiles.substituteHp = 25
    const out = executeTurn(state, [useMove(1, 'MOVE_STRENGTH_SAP'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.hp).toBe(30)
    expect(rng.calls).toBe(0) // the jump is before accuracycheck
    expect(ppOf(state)).toBe(9) // that script still ppreduces
  })

  it('a miss at accuracy stage 0 keeps the stages and still costs PP; one draw', () => {
    const rng = missRng()
    const state = atAccuracyFloor(battle(user('MOVE_STRENGTH_SAP', { hp: 30, maxHp: 200 }), foe(), rng))
    const out = executeTurn(state, [useMove(1, 'MOVE_STRENGTH_SAP'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.hp).toBe(30)
    expect(rng.calls).toBe(1)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectRevivalBlessing data/battle_scripts_1.s:11835-11856: ppreduce (:11838),
// jumpifweatheraffected WEATHER_FOG_ANY (:11839), openpartyscreen BS_CHOOSE_FAINTED_MON /
// VARIOUS_TRY_REVIVAL_BLESSING (src/battle_script_commands.c:8434-8461, first fainted slot via
// GetFirstFaintedPartyIndex :9133-9159), revive to maxHp/2 (:8445). In singles the revived mon
// stays in the party (:11850-11856 only sends out when gBattleCommunication is TRUE).
describe('cycle 126 - Revival Blessing (EFFECT_REVIVAL_BLESSING)', () => {
  it('revives the first fainted party slot to half max HP; PP 10 -> 9, zero draws', () => {
    const rng = countRng()
    const state = battle(user('MOVE_REVIVAL_BLESSING'), foe(), rng, {
      playerParty: [
        partyMon('SPECIES_MUDKIP'),
        partyMon('SPECIES_MUDKIP', { hp: 0, maxHp: 121 }),
        partyMon('SPECIES_MUDKIP', { hp: 0, maxHp: 80 }),
      ],
    })
    const out = runSelf(state, 'MOVE_REVIVAL_BLESSING')
    expect(ppOf(state)).toBe(9) // ppreduce :11838
    expect(state.sides[0].party[1]!.hp).toBe(60) // trunc(121/2) (:8445)
    expect(state.sides[0].party[2]!.hp).toBe(0) // only the first fainted slot
    expect(state.battlers[0]!.partyIndex).toBe(0) // no switch in singles
    expect(out.actions[0]?.missed).toBe(false)
    expect(rng.calls).toBe(0) // no accuracycheck
  })

  it('fails with no fainted party slot (:8437-8440) and still costs PP', () => {
    const state = battle(user('MOVE_REVIVAL_BLESSING'), foe(), countRng(), {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_MUDKIP')],
    })
    const out = runSelf(state, 'MOVE_REVIVAL_BLESSING')
    expect(out.actions[0]?.missed).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('fails in fog (:11839) even with a fainted slot; PP 10 -> 9', () => {
    const state = battle(user('MOVE_REVIVAL_BLESSING'), foe(), countRng(), {
      playerParty: [partyMon('SPECIES_MUDKIP'), partyMon('SPECIES_MUDKIP', { hp: 0, maxHp: 100 })],
    })
    state.field.weather = WEATHER_FOG_TEMPORARY
    state.field.weatherDuration = 1
    const out = runSelf(state, 'MOVE_REVIVAL_BLESSING')
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.sides[0].party[1]!.hp).toBe(0)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectPurify data/battle_scripts_1.s:879-895: ppreduce (:882), accuracycheck
// ButItFailed NO_ACC_CALC_CHECK_LOCK_ON (:883), jumpifstatus BS_TARGET STATUS1_ANY / ButItFailed
// (:884-885), curestatus BS_TARGET (:889, VARIOUS_CURE_STATUS zeroes status1,
// src/battle_script_commands.c:7685-7689), then tryhealhalfhealth BattleScript_AlreadyAtFullHp
// BS_ATTACKER (:893): a user that CannotBattlerHeal gets 0, a full-HP user gets
// AlreadyAtFullHp, otherwise maxHp/2 (:9255-9274).
describe('cycle 126 - Purify (EFFECT_PURIFY)', () => {
  it('cures the target and heals the user half its max HP: 40/200 -> 140; PP 10 -> 9, zero draws', () => {
    const rng = countRng()
    const state = battle(
      user('MOVE_PURIFY', { hp: 40, maxHp: 200 }),
      foe({ status1: STATUS1_BURN }),
      rng,
      { opponentParty: [partyMon('SPECIES_MUDKIP', { status1: STATUS1_BURN })] },
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_PURIFY'), null], loopDeps(state, fixedDamage(0)))
    expect(foeOf(state).mon.status1).toBe(0)
    expect(state.sides[1].party[0]!.status1).toBe(0) // the party slot too
    expect(state.battlers[0]!.mon.hp).toBe(140) // 40 + 200/2
    expect(ppOf(state)).toBe(9) // ppreduce :882
    expect(rng.calls).toBe(0) // NO_ACC_CALC_CHECK_LOCK_ON
    expect(out.actions[0]?.missed).toBe(false)
  })

  it('fails on a target with no status (:884-885) and still costs PP', () => {
    const state = battle(user('MOVE_PURIFY'), foe(), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_PURIFY'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(100)
    expect(ppOf(state)).toBe(9)
  })

  it('a semi-invulnerable target fails the NO_ACC accuracy check (:883); PP 10 -> 9', () => {
    const rng = countRng()
    const state = battle(user('MOVE_PURIFY', { hp: 40, maxHp: 200 }), foe({ status1: STATUS1_BURN }), rng)
    foeOf(state).statuses3 = STATUS3_SEMI_INVULNERABLE
    const out = executeTurn(state, [useMove(1, 'MOVE_PURIFY'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.missed).toBe(true)
    expect(foeOf(state).mon.status1).toBe(STATUS1_BURN)
    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(rng.calls).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('a full-HP user still cures the target and gets AlreadyAtFullHp (no heal)', () => {
    const state = battle(user('MOVE_PURIFY', { hp: 200, maxHp: 200 }), foe({ status1: STATUS1_POISON }), countRng())
    const out = executeTurn(state, [useMove(1, 'MOVE_PURIFY'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.missed).toBe(false)
    expect(foeOf(state).mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(200)
    expect(ppOf(state)).toBe(9)
  })

  it('a bleeding user CannotBattlerHeal, so the heal is zero but the target is still cured', () => {
    const state = battle(
      user('MOVE_PURIFY', { hp: 40, maxHp: 200, status1: STATUS1_BLEED }),
      foe({ status1: STATUS1_PARALYSIS }),
      countRng(),
    )
    const out = executeTurn(state, [useMove(1, 'MOVE_PURIFY'), null], loopDeps(state, fixedDamage(0)))
    expect(out.actions[0]?.missed).toBe(false)
    expect(foeOf(state).mon.status1).toBe(0)
    // Purify cures the TARGET, not the user, so the user's bleed stays and ENDTURN_BLEED
    // costs trunc(200/16) = 12 after the move.
    expect(state.battlers[0]!.mon.hp).toBe(28) // Cmd_tryhealhalfhealth zeroes it (CanBattlerHeal)
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BLEED)
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_GEOMANCY',
  'EFFECT_HEAL_BELL',
  'EFFECT_JUNGLE_HEALING',
  'EFFECT_REFRESH',
  'EFFECT_SYNTHESIS',
  'EFFECT_MOONLIGHT',
  'EFFECT_WISH',
  'EFFECT_HEAL_PULSE',
  'EFFECT_SWALLOW',
  'EFFECT_STRENGTH_SAP',
  'EFFECT_REVIVAL_BLESSING',
  'EFFECT_PURIFY',
]

describe('cycle 126 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})

describe('cycle 126 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_GEOMANCY', 'EFFECT_GEOMANCY'],
    ['MOVE_HEAL_BELL', 'EFFECT_HEAL_BELL'],
    ['MOVE_AROMATHERAPY', 'EFFECT_HEAL_BELL'],
    ['MOVE_JUNGLE_HEALING', 'EFFECT_JUNGLE_HEALING'],
    ['MOVE_LIFE_DEW', 'EFFECT_JUNGLE_HEALING'],
    ['MOVE_LUNAR_BLESSING', 'EFFECT_JUNGLE_HEALING'],
    ['MOVE_REFRESH', 'EFFECT_REFRESH'],
    ['MOVE_SYNTHESIS', 'EFFECT_SYNTHESIS'],
    ['MOVE_MOONLIGHT', 'EFFECT_MOONLIGHT'],
    ['MOVE_WISH', 'EFFECT_WISH'],
    ['MOVE_HEAL_PULSE', 'EFFECT_HEAL_PULSE'],
    ['MOVE_FLORAL_HEALING', 'EFFECT_HEAL_PULSE'],
    ['MOVE_SWALLOW', 'EFFECT_SWALLOW'],
    ['MOVE_STRENGTH_SAP', 'EFFECT_STRENGTH_SAP'],
    ['MOVE_REVIVAL_BLESSING', 'EFFECT_REVIVAL_BLESSING'],
    ['MOVE_PURIFY', 'EFFECT_PURIFY'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})
