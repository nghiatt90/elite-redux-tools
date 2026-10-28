/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 87b: tests for the move effects cycle 87a ported without a test. Every expected number is hand-derived from the C cited on the
// test (damage formula battle_util.c:7707-7711 at level 50, maximum roll, no crit: floor(floor(22 * power * A / D) / 50) + 2).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import type { BridgeDeps } from './bridge'
import {
  DEFAULT_STAT_STAGE,
  STAT_SPATK,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS2_MULTIPLETURNS,
  WEATHER_RAIN_TEMPORARY,
  hasFlag,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, any>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const speciesById = new Map(snapshot<Array<SimSpeciesData>>('species.json').map((s) => [s.id, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const natures = snapshot<any>('natures.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    type2: m.type2 as string | null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: m.argument?.kind === 'int' ? (m.argument.value as number) : null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

/** The engine's MoveData shape (calculate.ts), as damageResolver.test.ts builds it. */
function engineMove(id: string): any {
  const move = movesById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: move.effect === 'EFFECT_MISC_HIT' && arg?.kind === 'misc' ? arg.misc : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
    argumentStatus: move.effect === 'EFFECT_DOUBLE_DMG_IF_STATUS1' && arg?.kind === 'status' ? arg.status : null,
  }
}

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }

const DATA_CONTEXT: SimDataContext = {
  species: (id) => speciesById.get(id),
  item: (id) => itemsById.get(id),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    level: 50,
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

interface BattlerSpec {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource, playerParty?: SimPartyMon[], opponentParty?: SimPartyMon[]): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    playerParty,
    opponentParty,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[idx++] ?? 0
    },
  }
  return r
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

function bridgeDamage(random: RandomSource): DamageResolver {
  const bridge: BridgeDeps = { grounding: GROUNDING, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext: DATA_CONTEXT, inverseBattle: false }
  const deps: BridgeDamageResolverDeps = {
    ...bridge,
    moveData: (id) => (movesById.has(id) ? engineMove(id) : undefined),
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants: natures,
    random,
  }
  return createBridgeDamageResolver(deps)
}

function testDeps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
    moveBehaviors,
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const WATER: [string, string, string] = ['WATER', 'MYSTERY', 'MYSTERY']
const FIGHTING: [string, string, string] = ['FIGHTING', 'MYSTERY', 'MYSTERY'] // no STAB on the foe's Tackle, neutral to Fire
const baseDamage = (power: number, a = 100, d = 90) => Math.floor(Math.floor((22 * power * a) / d) / 50) + 2
const MAX_ROLL = [50, 1, 0] // accuracy hit, crit check fails (1 % 24 != 0), maximum damage roll
const ITEM_POWER_HERB = 'ITEM_POWER_HERB'

// -----------------------------------------------------------------------------
// Item 1: Electro Shot and Shell Trap
// -----------------------------------------------------------------------------

describe('Electro Shot (BattleScript_EffectElectroShot, data/battle_scripts_1.s:5723-5732)', () => {
  // Special, power 120, Electric. A Water attacker has no STAB; Sp. Atk 80 vs Sp. Def 85 against a Normal target (neutral).
  // Un-boosted: floor(floor(22*120*80/85)/50)+2 = floor(2484/50)+2 = 51. After +1 (ratio 3/2): A = 120, floor(3727/50)+2 = 76.
  const setup = (spec: BattlerSpec, rng: RandomSource) => battle([{ types: WATER, moves: slot('MOVE_ELECTRO_SHOT'), pp: pps, ...spec }, {}], rng)

  it('charge turn: Sp. Atk +1, PP spent, no hit; second turn hits with the raised stat and spends no more PP', () => {
    expect(baseDamage(120, 80, 85)).toBe(51)
    expect(baseDamage(120, 120, 85)).toBe(76)
    const rng = scriptedRng(MAX_ROLL)
    const state = setup({}, rng)
    const deps = testDeps(bridgeDamage(rng))

    const out1 = executeTurn(state, [useMove(1, move('MOVE_ELECTRO_SHOT')), null], deps)
    const act1 = out1.actions.find((a) => a.battlerId === 0)!
    expect(act1.targetDamage).toBeNull()
    expect(rng.calls).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)

    const out2 = executeTurn(state, [useMove(1, move('MOVE_ELECTRO_SHOT')), null], deps)
    const act2 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act2.targetDamage).toBe(76)
    expect(state.battlers[1]!.mon.hp).toBe(24)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(act2.unmodelled).not.toContain('secondary effect of EFFECT_ELECTRO_SHOT not modelled')
  })

  it('in rain the charge is skipped: the raise and the hit happen in the same turn (jumpifweatheraffected WEATHER_RAIN_ANY, s:5730)', () => {
    const rng = scriptedRng(MAX_ROLL)
    const state = setup({}, rng)
    state.field.weather = WEATHER_RAIN_TEMPORARY
    state.field.weatherDuration = 5
    const out = executeTurn(state, [useMove(1, move('MOVE_ELECTRO_SHOT')), null], testDeps(bridgeDamage(rng)))
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.targetDamage).toBe(76)
    expect(state.battlers[1]!.mon.hp).toBe(24)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(state.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
  })

  it('rain does not spend a Power Herb, whereas without rain the herb is consumed and the move fires on turn 1 (twoturnmoveacceleratecheck)', () => {
    const rainRng = scriptedRng(MAX_ROLL)
    const rainy = setup({ itemId: ITEM_POWER_HERB }, rainRng)
    rainy.field.weather = WEATHER_RAIN_TEMPORARY
    rainy.field.weatherDuration = 5
    executeTurn(rainy, [useMove(1, move('MOVE_ELECTRO_SHOT')), null], testDeps(bridgeDamage(rainRng)))
    expect(rainy.battlers[0]!.mon.itemId).toBe(ITEM_POWER_HERB)

    const herbRng = scriptedRng(MAX_ROLL)
    const herb = setup({ itemId: ITEM_POWER_HERB }, herbRng)
    const out = executeTurn(herb, [useMove(1, move('MOVE_ELECTRO_SHOT')), null], testDeps(bridgeDamage(herbRng)))
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBe(76)
    expect(herb.battlers[0]!.mon.itemId).toBeNull()
    expect(herb.battlers[0]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
  })
})

describe('Shell Trap (BattleScript_EffectShellTrap, s:4672-4676; VARIOUS_SHELL_TRAP_CHOICE, battle_script_commands.c:8905-8915)', () => {
  // Priority -3, Fire, special, power 150. Water user: no STAB. Sp. Atk 80 vs Sp. Def 85: floor(floor(22*150*80/85)/50)+2 = floor(3105/50)+2 = 64.
  // The foe's Tackle (Atk 100 vs Def 90) deals floor(977/50)+2 = 21 first.
  it('hits back after taking a physical hit this turn', () => {
    expect(baseDamage(150, 80, 85)).toBe(64)
    expect(baseDamage(40)).toBe(21)
    const rng = scriptedRng([...MAX_ROLL, ...MAX_ROLL])
    const state = battle([{ types: WATER, moves: slot('MOVE_SHELL_TRAP'), pp: pps }, { types: FIGHTING, moves: slot('MOVE_TACKLE'), pp: pps }], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_SHELL_TRAP')), useMove(0, move('MOVE_TACKLE'))], testDeps(bridgeDamage(rng)))
    expect(state.battlers[0]!.mon.hp).toBe(79)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.targetDamage).toBe(64)
    expect(state.battlers[1]!.mon.hp).toBe(36)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(act.unmodelled).not.toContain('secondary effect of EFFECT_SHELL_TRAP not modelled')
  })

  it('fails when nothing hit the user: no damage, PP spent once (BattleScript_ButItFailedAtkStringPpReduce)', () => {
    const rng = scriptedRng(MAX_ROLL)
    const state = battle([{ types: WATER, moves: slot('MOVE_SHELL_TRAP'), pp: pps }, {}], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_SHELL_TRAP')), null], testDeps(bridgeDamage(rng)))
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.targetDamage ?? 0).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(rng.calls).toBe(0)
  })

  it('fails when only a special hit landed (physicalDmg is the gate, not damage taken)', () => {
    const rng = scriptedRng([...MAX_ROLL, ...MAX_ROLL])
    const state = battle([{ types: WATER, moves: slot('MOVE_SHELL_TRAP'), pp: pps }, { moves: slot('MOVE_SWIFT'), pp: pps }], rng)
    executeTurn(state, [useMove(1, move('MOVE_SHELL_TRAP')), useMove(0, move('MOVE_SWIFT'))], testDeps(bridgeDamage(rng)))
    expect(state.battlers[0]!.mon.hp).toBeLessThan(100)
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })
})

describe('Shell Trap retarget (battle_script_commands.c:8908-8912)', () => {
  it('in a double battle the hit goes to whoever landed the physical hit, not the chosen target', () => {
    // Battler 0 (trap user) aims at 1, but 3 is the one that Tackles it: gBattlerTarget = physicalBattlerId (:8911).
    const rng = scriptedRng([...MAX_ROLL, ...MAX_ROLL])
    const state = battle(
      [
        { types: WATER, moves: slot('MOVE_SHELL_TRAP'), pp: pps, spe: 100 },
        { types: FIGHTING, spe: 10 },
        { types: WATER, spe: 20 },
        { types: FIGHTING, moves: slot('MOVE_TACKLE'), pp: pps, spe: 50 },
      ],
      rng,
    )
    const out = executeTurn(
      state,
      [useMove(1, move('MOVE_SHELL_TRAP')), null, null, useMove(0, move('MOVE_TACKLE'))],
      testDeps(bridgeDamage(rng)),
    )
    expect(state.battlers[0]!.mon.hp).toBe(79)
    expect(out.actions.find((a) => a.battlerId === 0)!.targetId).toBe(3)
    expect(state.battlers[3]!.mon.hp).toBe(36)
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })
})

// -----------------------------------------------------------------------------
// Item 2: Ice Burn / Freeze Shock charge turn, Pursuit, Grassy Glide, Revelation Dance
// -----------------------------------------------------------------------------

describe('Ice Burn / Freeze Shock charge turn (BattleScript_EffectTwoTurnRetaliation, s:4424-4438; VARIOUS_SET_BEAK_BLAST, c:7815-7817)', () => {
  // The user charges at speed 100; the foe (speed 50) then Tackles it. protectMove = the charging move makes IsBattlerProtected return
  // PROTECT_TOUCH_BUT_DAMAGED (battle_util.c:6638-6642): the hit lands in full and MOVEEND_PROTECT_LIKE_EFFECT (c:4385-4400) burns /
  // paralyses a CONTACT attacker. Tackle: floor(floor(22*40*100/90)/50)+2 = 21 on a Water user (no STAB for a Fighting foe).
  const charge = (moveId: string, foeMove: string, spec: BattlerSpec = {}) => {
    const rng = scriptedRng([...MAX_ROLL, ...MAX_ROLL])
    const state = battle([{ types: WATER, moves: slot(moveId), pp: pps, ...spec }, { types: FIGHTING, moves: slot(foeMove), pp: pps }], rng)
    const out = executeTurn(state, [useMove(1, move(moveId)), useMove(0, move(foeMove))], testDeps(bridgeDamage(rng)))
    return { state, out, rng }
  }

  it('Ice Burn: the charging turn spends PP, deals nothing, takes the contact hit in full and burns the attacker', () => {
    const { state, out } = charge('MOVE_ICE_BURN', 'MOVE_TACKLE')
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(79) // 100 - 21: PROTECT_TOUCH_BUT_DAMAGED does not block
    expect(state.battlers[1]!.mon.hp).toBe(94) // the burn's end-of-turn damage, floor(100 / 16) = 6; Tackle itself did nothing to the foe
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(true)
  })

  it('Freeze Shock paralyses the contact attacker instead', () => {
    const { state } = charge('MOVE_FREEZE_SHOCK', 'MOVE_TACKLE')
    expect(state.battlers[0]!.mon.hp).toBe(79)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(false)
  })

  it('a non-contact move (Swift) is neither blocked nor punished', () => {
    const { state } = charge('MOVE_ICE_BURN', 'MOVE_SWIFT')
    expect(state.battlers[0]!.mon.hp).toBeLessThan(100)
    expect(state.battlers[1]!.mon.status1).toBe(0)
  })

  it('a Power Herb finishes the move on turn 1 and sets no retaliation (the SetRetaliation label is only reached when the check does not accelerate)', () => {
    // Draws: the hit (accuracy, crit, roll), the 30% paralysis chance (99 = no), then the foe's Tackle.
    const rng = scriptedRng([...MAX_ROLL, 99, ...MAX_ROLL])
    const state = battle(
      [{ types: WATER, moves: slot('MOVE_FREEZE_SHOCK'), pp: pps, itemId: ITEM_POWER_HERB }, { types: FIGHTING, moves: slot('MOVE_TACKLE'), pp: pps }],
      rng,
    )
    const out = executeTurn(state, [useMove(1, move('MOVE_FREEZE_SHOCK')), useMove(0, move('MOVE_TACKLE'))], testDeps(bridgeDamage(rng)))
    expect(out.actions.find((a) => a.battlerId === 0)!.targetDamage).toBeGreaterThan(0)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBeLessThan(100) // the Tackle landed
    expect(state.battlers[1]!.mon.status1).toBe(0) // and was not punished
  })

  it('the second turn is the hit itself: no PP, the charge flag cleared (the round struct is per turn, so no protection carries over)', () => {
    const rng = scriptedRng([...MAX_ROLL, ...MAX_ROLL, 99])
    const state = battle([{ types: WATER, moves: slot('MOVE_FREEZE_SHOCK'), pp: pps }, { types: FIGHTING }], rng)
    const deps = testDeps(bridgeDamage(rng))
    executeTurn(state, [useMove(1, move('MOVE_FREEZE_SHOCK')), null], deps)
    executeTurn(state, [useMove(1, move('MOVE_FREEZE_SHOCK')), null], deps)
    expect(state.battlers[0]!.mon.pp[0]).toBe(19)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(state.battlers[1]!.mon.hp).toBeLessThan(100)
    expect(state.battlers[0]!.round.protectMove).toBeFalsy()
  })
})

describe('plain-hit scripts: Pursuit, Grassy Glide, Revelation Dance (er-config MoveBehaviorConfigList.textproto:614-617, :1694-1696, :1531-1533)', () => {
  const hit = (moveId: string, attacker: BattlerSpec = {}, defender: BattlerSpec = {}) => {
    const rng = scriptedRng(MAX_ROLL)
    const state = battle([{ types: WATER, moves: slot(moveId), pp: pps, ...attacker }, defender], rng)
    const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(bridgeDamage(rng)))
    return { state, act: out.actions.find((a) => a.battlerId === 0)! }
  }

  it('Pursuit hits for its plain 50 power and keeps its own switch-interception note, without the generic secondary-effect note', () => {
    const { act } = hit('MOVE_PURSUIT')
    expect(baseDamage(50)).toBe(26)
    expect(act.targetDamage).toBe(26)
    expect(act.unmodelled).toContain('defenderIsSwitching is false because switching is not modelled')
    expect(act.unmodelled).not.toContain('secondary effect of EFFECT_PURSUIT not modelled')
  })

  it('Grassy Glide hits for its plain 70 power', () => {
    const { act, state } = hit('MOVE_GRASSY_GLIDE')
    expect(baseDamage(70)).toBe(36)
    expect(act.targetDamage).toBe(36)
    expect(state.battlers[1]!.mon.hp).toBe(64)
    expect(act.unmodelled).not.toContain('secondary effect of EFFECT_GRASSY_GLIDE not modelled')
  })

  it("Revelation Dance takes the user's first type (battle_main.c:5141): STAB, and the type chart is read for that type", () => {
    // Special, power 100: floor(floor(22*100*80/85)/50)+2 = 43, then STAB 1.5 via ApplyModifier (modifier * val + 2048) >> 12 = 65.
    // User types [Ground]: Ground vs Normal is neutral.
    expect(baseDamage(100, 80, 85)).toBe(43)
    const ground = hit('MOVE_REVELATION_DANCE', { types: ['GROUND', 'MYSTERY', 'MYSTERY'] })
    expect(ground.act.targetDamage).toBe(65)
    expect(ground.act.unmodelled).not.toContain('secondary effect of EFFECT_REVELATION_DANCE not modelled')
    // User types [Water]: against a Fire target the same move is 2x (Water is Revelation Dance's type), against Grass 0.5x.
    const vsFire = hit('MOVE_REVELATION_DANCE', {}, { types: ['FIRE', 'MYSTERY', 'MYSTERY'] })
    const vsGrass = hit('MOVE_REVELATION_DANCE', {}, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] })
    // STAB and type effectiveness are one product in CalcFinalDmg (battle_util.c:7501, 7612-7618): 1.5 * 2 = 3.0, ApplyModifier(12288, 43) = 129
    expect(vsFire.act.targetDamage).toBe(129)
    expect(vsGrass.act.targetDamage).toBe(32) // 1.5 * 0.5 = 0.75, (3072 * 43 + 2048) >> 12
  })
})
