/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 114: whitelist status effects. Each effect is read against the C (data/battle_scripts_1.s,
// src/battle_script_commands.c) and proven by a forced scenario whose numbers are derived by hand.
// All moves here are non-damaging, always-hit self moves: no accuracy draw is expected.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS2_SUBSTITUTE,
  STATUS3_HEAL_BLOCK,
  STATUS_FIELD_ELECTRIC_TERRAIN,
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

/** Every draw is 0: accuracy always hits and every secondary `roll < chance` passes. */
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

/** Fixed damage: the bookkeeping under test never depends on the damage engine's own numbers. */
const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

function actionOf(out: TurnOutcome, battlerId: number) {
  const action = out.actions.find((a) => a.battlerId === battlerId)
  if (!action) throw new Error(`no action for battler ${battlerId}`)
  return action
}


const THIS_FILE = 'web/src/engine/sim/cycle114StatusEffects.test.ts'
const user = (overrides: Partial<SimBattleMon> = {}) =>
  monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0], ...overrides })
const withMove = (moveId: string, overrides: Partial<SimBattleMon> = {}) =>
  user({ moves: [moveId, null, null, null], pp: [10, 0, 0, 0], ...overrides })

/** One full turn: the user uses `moveId`, the opponent does nothing. */
function runSelf(state: BattleState, moveId: string, replacement?: ReplacementDeps): TurnOutcome {
  return executeTurn(state, [useMove(0, moveId), null], loopDeps(state, fixedDamage(0), replacement))
}
const solo = (mon: SimBattleMon, party?: SimPartyMon[]) =>
  battle(mon, monFor('SPECIES_MUDKIP'), countRng(), party ? { playerParty: party } : {})
const effectOf = (moveId: string) => DATA_CONTEXT.move(moveId)?.effect
const stage = (state: BattleState, stat: number) => state.battlers[0]!.mon.statStages[stat]
const setStage = (state: BattleState, stat: number, v: number) => {
  state.battlers[0]!.mon.statStages[stat] = v
}
const ppOf = (state: BattleState) => state.battlers[0]!.mon.pp[0]
const hpOf = (state: BattleState) => state.battlers[0]!.mon.hp

describe('cycle 114 - effect keys of the moves under test', () => {
  it.each([
    ['MOVE_REST', 'EFFECT_REST'],
    ['MOVE_ROOST', 'EFFECT_ROOST'],
    ['MOVE_HEAL_ORDER', 'EFFECT_RESTORE_HP'],
    ['MOVE_RECOVER', 'EFFECT_RESTORE_HP'],
    ['MOVE_SLACK_OFF', 'EFFECT_RESTORE_HP'],
    ['MOVE_HEALING_WISH', 'EFFECT_HEALING_WISH'],
    ['MOVE_LUNAR_DANCE', 'EFFECT_HEALING_WISH'],
    ['MOVE_SUBSTITUTE', 'EFFECT_SUBSTITUTE'],
    ['MOVE_AGILITY', 'EFFECT_SPEED_UP_2'],
    ['MOVE_ROCK_POLISH', 'EFFECT_SPEED_UP_2'],
    ['MOVE_SWORDS_DANCE', 'EFFECT_ATTACK_UP_2'],
    ['MOVE_NASTY_PLOT', 'EFFECT_SPECIAL_ATTACK_UP_2'],
    ['MOVE_ACID_ARMOR', 'EFFECT_DEFENSE_UP_2'],
    ['MOVE_IRON_DEFENSE', 'EFFECT_DEFENSE_UP_2'],
    ['MOVE_BULK_UP', 'EFFECT_BULK_UP'],
    ['MOVE_CALM_MIND', 'EFFECT_CALM_MIND'],
    ['MOVE_DRAGON_DANCE', 'EFFECT_DRAGON_DANCE'],
  ])('%s has %s', (moveId, effect) => {
    expect(effectOf(moveId)).toBe(effect)
  })
})

// BattleScript_EffectRest battle_scripts_1.s:4023-4036, Cmd_trysetrest battle_script_commands.c:9415-9437.
describe('cycle 114 - Rest', () => {
  it('heals 40/100 to full and sets sleep counter 3 (:9432 STATUS1_SLEEP_TURN(3), PresentHeal :5915)', () => {
    const state = solo(withMove('MOVE_REST', { hp: 40 }))
    runSelf(state, 'MOVE_REST')
    expect(hpOf(state)).toBe(100)
    expect(state.battlers[0]!.mon.status1 & STATUS1_SLEEP).toBe(3)
    expect(ppOf(state)).toBe(9)
  })

  it('replaces another status with sleep (:9432 assigns status1 outright)', () => {
    const state = solo(withMove('MOVE_REST', { hp: 40, status1: STATUS1_POISON }))
    runSelf(state, 'MOVE_REST')
    expect(state.battlers[0]!.mon.status1).toBe(3)
    expect(hpOf(state)).toBe(100)
  })

  it('fails at full HP with status unchanged (:9421-9422), PP still spent (ppreduce :4026)', () => {
    const state = solo(withMove('MOVE_REST', { hp: 100 }))
    runSelf(state, 'MOVE_REST')
    expect(hpOf(state)).toBe(100)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('fails under Electric Terrain (:9423-9424): HP and status unchanged', () => {
    const state = solo(withMove('MOVE_REST', { hp: 40 }))
    state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    runSelf(state, 'MOVE_REST')
    expect(hpOf(state)).toBe(40)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(9)
  })

  it('fails for Comatose (:4028) and for sleep-protecting Insomnia (requirecandoeffect :4029)', () => {
    for (const ability of ['ABILITY_COMATOSE', 'ABILITY_INSOMNIA']) {
      const state = solo(withMove('MOVE_REST', { hp: 40, abilities: only(ability) }))
      runSelf(state, 'MOVE_REST')
      expect(hpOf(state)).toBe(40)
      expect(state.battlers[0]!.mon.status1).toBe(0)
      expect(ppOf(state)).toBe(9)
    }
  })
})

// BattleScript_EffectRoost :2736-2742, Cmd_tryhealhalfhealth :9255-9274, Cmd_setroost :4022-4047.
describe('cycle 114 - Roost', () => {
  const roostTurn = (types: string[], hp = 40) => {
    const mon = withMove('MOVE_ROOST', {
      hp,
      types: types as SimBattleMon['types'],
      rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 200 },
    })
    const state = battle(mon, monFor('SPECIES_MUDKIP', { moves: ['MOVE_TACKLE', null, null, null], pp: [10, 0, 0, 0] }), countRng())
    let typesWhenHit: string[] = []
    const damage: DamageResolver = {
      resolve: () => {
        typesWhenHit = [...state.battlers[0]!.mon.types]
        return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
      },
    }
    executeTurn(state, [useMove(1, 'MOVE_ROOST'), useMove(0, 'MOVE_TACKLE')], loopDeps(state, damage))
    return { state, typesWhenHit }
  }

  it('pure Flying at 40/100 heals maxHp/2 = 50 and is NORMAL while roosted (:9266, :4026-4031)', () => {
    const { state, typesWhenHit } = roostTurn(['FLYING', 'MYSTERY', 'MYSTERY'])
    expect(hpOf(state)).toBe(90)
    expect(typesWhenHit.slice(0, 2)).toEqual(['NORMAL', 'NORMAL'])
    expect(state.battlers[0]!.roostTypes).toEqual(['FLYING', 'FLYING'])
    expect(ppOf(state)).toBe(9)
  })

  it('Flying/Water becomes MYSTERY/WATER while roosted (:4033-4040)', () => {
    const { state, typesWhenHit } = roostTurn(['FLYING', 'WATER', 'MYSTERY'])
    expect(hpOf(state)).toBe(90)
    expect(typesWhenHit.slice(0, 2)).toEqual(['MYSTERY', 'WATER'])
    expect(state.battlers[0]!.roostTypes).toEqual(['FLYING', 'WATER'])
  })

  it('fails at full HP without setting roost (:9270-9271 jumps before setroost)', () => {
    const { state, typesWhenHit } = roostTurn(['FLYING', 'MYSTERY', 'MYSTERY'], 100)
    expect(hpOf(state)).toBe(100)
    expect(typesWhenHit[0]).toBe('FLYING')
    expect(state.battlers[0]!.roostTypes).not.toEqual(['FLYING', 'FLYING'])
    expect(ppOf(state)).toBe(9)
  })

  it('heal-blocked Roost never reaches its script: CANCELLER_HEAL_BLOCKED (battle_util.c:3326, IsHealingMoveEffect :8887) stops it before ppreduce', () => {
    const mon = withMove('MOVE_ROOST', { hp: 40, types: ['FLYING', 'MYSTERY', 'MYSTERY'] })
    const state = solo(mon)
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    state.battlers[0]!.volatiles.healBlockTimer = 5
    const out = runSelf(state, 'MOVE_ROOST')
    expect(actionOf(out, 0).cancelledBy).toBe('HEAL_BLOCK')
    expect(hpOf(state)).toBe(40)
    expect(ppOf(state)).toBe(10)
    expect(state.battlers[0]!.roostTypes).not.toEqual(['FLYING', 'FLYING'])
  })
})

// BattleScript_EffectRestoreHp :3940-3955, Cmd_tryhealhalfhealth :9255-9274.
describe('cycle 114 - Restore HP (Heal Order, Recover, Slack Off)', () => {
  it.each(['MOVE_HEAL_ORDER', 'MOVE_RECOVER', 'MOVE_SLACK_OFF'])('%s heals trunc(101/2) = 50 from 40/101', (moveId) => {
    const state = solo(withMove(moveId, { hp: 40, maxHp: 101 }))
    runSelf(state, moveId)
    expect(hpOf(state)).toBe(90) // 40 + 50 (:9266)
    expect(ppOf(state)).toBe(9)
  })

  it('maxHp 3, hp 1 heals 3/2 = 1 (:9266) -> 2', () => {
    const state = solo(withMove('MOVE_RECOVER', { hp: 1, maxHp: 3 }))
    runSelf(state, 'MOVE_RECOVER')
    expect(hpOf(state)).toBe(2)
  })

  it('heal is capped at maxHp (datahpupdate)', () => {
    const state = solo(withMove('MOVE_RECOVER', { hp: 80, maxHp: 100 }))
    runSelf(state, 'MOVE_RECOVER')
    expect(hpOf(state)).toBe(100)
  })

  it('heal-blocked user fails with HP unchanged: CANCELLER_HEAL_BLOCKED (battle_util.c:3326-3336) precedes the script, so no PP is spent', () => {
    const state = solo(withMove('MOVE_RECOVER', { hp: 40 }))
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    state.battlers[0]!.volatiles.healBlockTimer = 5
    const out = runSelf(state, 'MOVE_RECOVER')
    expect(actionOf(out, 0).cancelledBy).toBe('HEAL_BLOCK')
    expect(hpOf(state)).toBe(40)
    expect(ppOf(state)).toBe(10)
  })

  it('full HP fails (:9270-9271)', () => {
    const state = solo(withMove('MOVE_RECOVER', { hp: 100 }))
    runSelf(state, 'MOVE_RECOVER')
    expect(hpOf(state)).toBe(100)
    expect(ppOf(state)).toBe(9)
  })

  it('bleed is cured instead of healing (BattleScript_MoveUsedBleedHeal :156)', () => {
    const state = solo(withMove('MOVE_RECOVER', { hp: 40, status1: STATUS1_BLEED }))
    runSelf(state, 'MOVE_RECOVER')
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(hpOf(state)).toBe(40)
  })
})

// BattleScript_EffectHealingWish :2364-2414.
describe('cycle 114 - Healing Wish / Lunar Dance', () => {
  const replacement: ReplacementDeps = { chooseReplacement: () => 1 }
  const tacklePp = DATA_CONTEXT.move('MOVE_TACKLE')!.pp as number
  const setup = (moveId: string) => {
    const mon = withMove(moveId)
    const reserve = partyMon('SPECIES_TREECKO', { hp: 10, status1: STATUS1_POISON, pp: [3, 0, 0, 0] })
    const state = solo(mon, [partyMon('SPECIES_MUDKIP', { moves: [moveId, null, null, null], pp: [10, 0, 0, 0] }), reserve])
    runSelf(state, moveId, replacement)
    return state
  }

  it('Healing Wish: user faints, reserve enters at full HP with status cleared, PP untouched (:2402-2406)', () => {
    const state = setup('MOVE_HEALING_WISH')
    expect(state.sides[0].party[0]!.hp).toBe(0)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(hpOf(state)).toBe(100)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(ppOf(state)).toBe(3)
  })

  it('Lunar Dance additionally restores PP (:2394-2396) to the move max from moves data', () => {
    const state = setup('MOVE_LUNAR_DANCE')
    expect(state.sides[0].party[0]!.hp).toBe(0)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TREECKO')
    expect(hpOf(state)).toBe(100)
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(tacklePp).toBeGreaterThan(3)
    expect(ppOf(state)).toBe(tacklePp)
  })

  it.each(['MOVE_HEALING_WISH', 'MOVE_LUNAR_DANCE'])('%s with no live reserve fails: user keeps HP, PP spent once (:2366)', (moveId) => {
    const state = solo(withMove(moveId), [
      partyMon('SPECIES_MUDKIP', { moves: [moveId, null, null, null], pp: [10, 0, 0, 0] }),
      partyMon('SPECIES_TREECKO', { hp: 0 }),
    ])
    runSelf(state, moveId, replacement)
    expect(hpOf(state)).toBe(100)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectSubstitute :4506-4530, Cmd_setsubstitute :10535-10552.
describe('cycle 114 - Substitute', () => {
  it('maxHp 100, hp 100 -> hp 75 and substituteHp 25 (:10536-10537, :10546-10547)', () => {
    const state = solo(withMove('MOVE_SUBSTITUTE'))
    runSelf(state, 'MOVE_SUBSTITUTE')
    expect(hpOf(state)).toBe(75)
    expect(state.battlers[0]!.volatiles.substituteHp).toBe(25)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)
    expect(ppOf(state)).toBe(9)
  })

  it('hp == damage (25) fails (:10541): HP unchanged, no flag', () => {
    const state = solo(withMove('MOVE_SUBSTITUTE', { hp: 25 }))
    runSelf(state, 'MOVE_SUBSTITUTE')
    expect(hpOf(state)).toBe(25)
    expect(state.battlers[0]!.volatiles.substituteHp).toBe(0)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(false)
    expect(ppOf(state)).toBe(9)
  })

  it('hp 26 succeeds (26 > 25): hp 1', () => {
    const state = solo(withMove('MOVE_SUBSTITUTE', { hp: 26 }))
    runSelf(state, 'MOVE_SUBSTITUTE')
    expect(hpOf(state)).toBe(1)
    expect(state.battlers[0]!.volatiles.substituteHp).toBe(25)
  })

  it('an existing substitute fails before setsubstitute (:4511): substituteHp and HP unchanged', () => {
    const state = solo(withMove('MOVE_SUBSTITUTE', { status2: STATUS2_SUBSTITUTE }))
    state.battlers[0]!.volatiles.substituteHp = 7
    runSelf(state, 'MOVE_SUBSTITUTE')
    expect(hpOf(state)).toBe(100)
    expect(state.battlers[0]!.volatiles.substituteHp).toBe(7)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectStatUp :3612-3628, scripts :4240-4258.
describe('cycle 114 - single-stat +2 family', () => {
  const cases: Array<[string, string, number]> = [
    ['MOVE_AGILITY', 'speed', STAT_SPEED],
    ['MOVE_ROCK_POLISH', 'speed', STAT_SPEED],
    ['MOVE_SWORDS_DANCE', 'attack', STAT_ATK],
    ['MOVE_NASTY_PLOT', 'special attack', STAT_SPATK],
    ['MOVE_ACID_ARMOR', 'defense', STAT_DEF],
    ['MOVE_IRON_DEFENSE', 'defense', STAT_DEF],
  ]
  it.each(cases)('%s raises %s: 6 -> 8', (moveId, _label, stat) => {
    const state = solo(withMove(moveId))
    runSelf(state, moveId)
    expect(stage(state, stat)).toBe(8) // setstatchanger STAT, 2
    expect(ppOf(state)).toBe(9)
  })
  // Stages run 0..12 (MAX_STAT_STAGE = 12, neutral 6), so the brief's "7 -> 8 clamped" is read in that
  // frame: +2 from 11 clamps to 12 (ChangeStatBuffs caps at MAX_STAT_STAGE), 12 stays 12.
  it.each(cases)('%s: 7 -> 9 (no clamp yet) and 11 -> 12 (clamped)', (moveId, _label, stat) => {
    const state = solo(withMove(moveId))
    setStage(state, stat, 7)
    runSelf(state, moveId)
    expect(stage(state, stat)).toBe(9)
    const clamp = solo(withMove(moveId))
    setStage(clamp, stat, 11)
    runSelf(clamp, moveId)
    expect(stage(clamp, stat)).toBe(12)
  })
  it.each(cases)('%s at stage 12 stays 12, PP still spent', (moveId, _label, stat) => {
    const state = solo(withMove(moveId))
    setStage(state, stat, 12)
    runSelf(state, moveId)
    expect(stage(state, stat)).toBe(12)
    expect(ppOf(state)).toBe(9)
  })
})

// BattleScript_EffectBulkUp :6670-6693, CalmMind :6739-6763, DragonDance :6817-6840.
describe('cycle 114 - paired +1 stat moves', () => {
  const cases: Array<[string, number, number]> = [
    ['MOVE_BULK_UP', STAT_ATK, STAT_DEF],
    ['MOVE_CALM_MIND', STAT_SPATK, STAT_SPDEF],
    ['MOVE_DRAGON_DANCE', STAT_ATK, STAT_SPEED],
  ]
  it.each(cases)('%s: 6/6 -> 7/7', (moveId, a, b) => {
    const state = solo(withMove(moveId))
    runSelf(state, moveId)
    expect(stage(state, a)).toBe(7)
    expect(stage(state, b)).toBe(7)
    expect(ppOf(state)).toBe(9)
  })
  it.each(cases)('%s: first stat at 12, second at 6 -> 12 / 7 (stats are independent)', (moveId, a, b) => {
    const state = solo(withMove(moveId))
    setStage(state, a, 12)
    runSelf(state, moveId)
    expect(stage(state, a)).toBe(12)
    expect(stage(state, b)).toBe(7)
  })
  it.each(cases)('%s: first stat at 6, second at 12 -> 7 / 12 (the script only fails when both are capped)', (moveId, a, b) => {
    const state = solo(withMove(moveId))
    setStage(state, b, 12)
    runSelf(state, moveId)
    expect(stage(state, a)).toBe(7)
    expect(stage(state, b)).toBe(12)
  })
  it.each(cases)('%s: both at 12 -> nothing changes, PP spent', (moveId, a, b) => {
    const state = solo(withMove(moveId))
    setStage(state, a, 12)
    setStage(state, b, 12)
    runSelf(state, moveId)
    expect(stage(state, a)).toBe(12)
    expect(stage(state, b)).toBe(12)
    expect(ppOf(state)).toBe(9)
  })
})

const SHIPPED_EFFECTS = [
  'EFFECT_REST',
  'EFFECT_ROOST',
  'EFFECT_RESTORE_HP',
  'EFFECT_HEALING_WISH',
  'EFFECT_SUBSTITUTE',
  'EFFECT_SPEED_UP_2',
  'EFFECT_ATTACK_UP_2',
  'EFFECT_SPECIAL_ATTACK_UP_2',
  'EFFECT_DEFENSE_UP_2',
  'EFFECT_BULK_UP',
  'EFFECT_CALM_MIND',
  'EFFECT_DRAGON_DANCE',
]

describe('cycle 114 - registry', () => {
  it('VERIFIED_MOVE_EFFECTS names every effect proven here, pointing at this file', () => {
    for (const effect of SHIPPED_EFFECTS) expect(VERIFIED_MOVE_EFFECTS.get(effect)).toBe(THIS_FILE)
  })
})
