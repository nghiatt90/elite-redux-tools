/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 106c -- the third on-hit attacker batch: Tangled Tails (Know Your Place's lambda), Venoblaze Pincers,
// Virus, Vitality Strike, Wings of Pestilence, Woodland Curse (onAttacker half), Wrestle Showman and Yuki Onna
// (onAttacker half). Every block is a transcription of the onAttacker lambda in
// pipeline/.upstream/eliteredux-source/src/abilities.cc at the pinned SHA (sources.lock.json:
// eliteredux-source bdebcbbff9760cdd41a02c425bea4857fa0eee26). The tests pin the C's draw order: an ability's
// own Random() is drawn only after every earlier CHECK passes, a secondary draw is consumed even when its branch
// rejects the target, and the ability's draws come after the accuracy roll and the move's own secondary roll.
//
// Common C references (pinned upstream):
// - ShouldApplyOnHitEffect(applyTo) = DidMoveHit() && IsBattlerAlive(applyTo), src/battle_util.c:4058-4062;
//   DidMoveHit = WasMoveSuccessful && TARGET_TURN_DAMAGED, with no liveness requirement.
// - AbilityStatusEffect, src/abilities.cc:263-268; SetMoveEffect, src/battle_script_commands.c:2318-2400.
// - CanBeBurned / CanBePoisoned / CanBleed / CanInfatuate, src/battle_util.c:5042-5143.
// - Cmd_settaunt, src/battle_script_commands.c:11678-11698; BattleScript_WrestleShowman_Effect_FlyingPress,
//   data/battle_scripts_1.s:12560-12565.
// - BattleScript_HydroCircuitAbsorbEffectActivated, data/battle_scripts_1.s:11563-11570; GetDrainedBigRootHp,
//   src/battle_util.c:2369-2377.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { dispatchMoveEndAttackerAbilities } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { TypeChart } from '../typeEffectiveness'
import {
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_TOXIC_POISON,
  STATUS2_CURSED,
  STATUS2_INFATUATION,
  hasFlag,
} from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the snapshot-backed shape cycle106Abilities.test.ts uses.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const itemsById = new Map(snapshot<Array<SimItemData>>('items.json').map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
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
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
  }
}

function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id,
    baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0,
    formOf: (s.formOf as string | null | undefined) ?? null,
  }
}

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
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

type BattlerSpec = {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  gender?: SimBattleMon['gender']
  status1?: number
  status2?: number
}

function battle(specs: BattlerSpec[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? 0
      idx++
      return val
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

function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(damage: DamageResolver = fixedDamage(20), grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })
const TYPES = (t: string): [string, string, string] => [t, 'MYSTERY', 'MYSTERY']

/** The attacker-side note the dispatch is supposed to have stopped emitting for a ported ability. */
const attackerNote = (notes: string[], ability: string) =>
  notes.filter((n) => n === `move-end attacker ability ${ability} is not modelled yet`)

/** One turn: holder (battler 0) uses `moveId` on battler 1 for a fixed amount of damage. */
function run(
  ability: string,
  moveId: string,
  rolls: number[],
  holder: BattlerSpec = {},
  target: BattlerSpec = {},
  setup?: (state: BattleState) => void,
  dmg = 10,
) {
  const rng = scriptedRng(rolls)
  const state = battle([{ moves: slot(moveId), pp: pps, abilities: hasAbility(ability), ...holder }, target], rng)
  setup?.(state)
  const out = executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(dmg)))
  return { state, rng, out, holder: state.battlers[0]!, target: state.battlers[1]! }
}

/** The move-end attacker dispatch alone (no accuracy / protect pipeline), for states a real turn would not reach. */
function dispatch(
  state: BattleState,
  moveId: string,
  opts: {
    targetDamage?: number
    hpDealt?: number
    noEffect?: boolean
    isCriticalHit?: boolean
    /** GetBattlerTurnOrderNum(target) < GetBattlerTurnOrderNum(attacker); undefined = not supplied. */
    targetHasActedThisTurn?: boolean
  } = {},
) {
  const unmodelled: string[] = []
  const targetDamage = opts.targetDamage ?? 20
  const hpDealt = opts.hpDealt ?? targetDamage
  const res = dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt,
    noEffect: opts.noEffect,
    isCriticalHit: opts.isCriticalHit,
    targetHasActedThisTurn: opts.targetHasActedThisTurn,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

// ---------------------------------------------------------------------------
// 1. Tangled Tails (src/abilities.cc:12001-12004: .onAttacker = Impl<ABILITY_KNOW_YOUR_PLACE>.onAttacker)
// ---------------------------------------------------------------------------

describe('Cycle 106c - Tangled Tails onAttacker (abilities.cc:12001-12004)', () => {
  const TT = 'ABILITY_TANGLED_TAILS'

  it("runs Know Your Place's lambda: contact sets dazed = 5 and the started bit, with no roll", () => {
    const state = battle([{ abilities: hasAbility(TT), moves: slot('MOVE_TACKLE'), pp: pps }, {}], scriptedRng([]))
    const { unmodelled } = dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.volatiles.dazed).toBe(5)
    expect(state.battlers[1]!.volatiles.started.dazed).toBe(true)
    expect(attackerNote(unmodelled, TT)).toEqual([])
  })

  it('still needs contact and a target that is not already dazed', () => {
    const noContact = battle([{ abilities: hasAbility(TT), moves: slot('MOVE_WATER_GUN'), pp: pps }, {}], scriptedRng([]))
    dispatch(noContact, 'MOVE_WATER_GUN') // special, bulletBased, non-contact
    expect(noContact.battlers[1]!.volatiles.dazed).toBe(0)

    const already = battle([{ abilities: hasAbility(TT), moves: slot('MOVE_TACKLE'), pp: pps }, {}], scriptedRng([]))
    already.battlers[1]!.volatiles.dazed = 2
    dispatch(already, 'MOVE_TACKLE')
    expect(already.battlers[1]!.volatiles.dazed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 2. Venoblaze Pincers (src/abilities.cc:8128-8148)
// ---------------------------------------------------------------------------

describe('Cycle 106c - Venoblaze Pincers (abilities.cc:8128-8148)', () => {
  const VP = 'ABILITY_VENOBLAZE_PINCERS'
  const holder = { abilities: hasAbility(VP), moves: slot('MOVE_TACKLE'), pp: pps }

  it('branch 0 burns after the 20% roll and a passing CanBeBurned', () => {
    // draw 1: Random() % 100 = 5 < 20; draw 2: Random() % 2 = 0 -> CanBeBurned(target) then MOVE_EFFECT_BURN.
    const rng = scriptedRng([5, 0])
    const state = battle([holder, {}], rng)
    const { res, unmodelled } = dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(true)
    expect(rng.calls).toBe(2) // both draws, in C order
    expect(res.statusApplied).toEqual({ battlerId: 1, status: 'BURN' })
    expect(attackerNote(unmodelled, VP)).toEqual([])
  })

  it('branch 1 badly poisons after a passing CanBePoisoned(MOVE_NONE)', () => {
    const rng = scriptedRng([5, 1])
    const state = battle([holder, {}], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('the 20% roll failing ends it: the switch draw is not made', () => {
    // Random() % 100 = 20 is NOT < 20, so the second Random() % 2 is never drawn (C order).
    const rng = scriptedRng([20, 0])
    const state = battle([holder, {}], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(1)
  })

  it('a failing CanX in the chosen branch consumes both draws and does nothing', () => {
    // branch 1 (poison) on a Steel target: CanPoisonType rejects it, and the C draws no replacement branch.
    const rng = scriptedRng([5, 1])
    const state = battle([holder, { types: TYPES('STEEL') }], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(2)

    // branch 0 (burn) on a Fire target: CanBeBurned rejects the type.
    const fireRng = scriptedRng([5, 0])
    const fire = battle([holder, { types: TYPES('FIRE') }], fireRng)
    dispatch(fire, 'MOVE_TACKLE')
    expect(fire.battlers[1]!.mon.status1).toBe(0)
    expect(fireRng.calls).toBe(2)
  })

  it('needs a physical move, a live target and a damaging hit before any draw', () => {
    // IS_MOVE_PHYSICAL is a CHECK ahead of the roll: Water Gun draws nothing at all.
    const specialRng = scriptedRng([5, 0])
    const special = battle([{ ...holder, moves: slot('MOVE_WATER_GUN') }, {}], specialRng)
    dispatch(special, 'MOVE_WATER_GUN')
    expect(special.battlers[1]!.mon.status1).toBe(0)
    expect(specialRng.calls).toBe(0)

    const noDamageRng = scriptedRng([5, 0])
    const noDamage = battle([holder, {}], noDamageRng)
    dispatch(noDamage, 'MOVE_TACKLE', { targetDamage: 0, hpDealt: 0 })
    expect(noDamage.battlers[1]!.mon.status1).toBe(0)
    expect(noDamageRng.calls).toBe(0)
  })

  it('draws after the accuracy roll and after the move secondary, never before', () => {
    // Body Slam: contact + physical, EFFECT_PARALYZE_HIT at 30%. Draw order: accuracy, seteffectwithchance,
    // then MOVEEND_ABILITIES_ATTACKER's %100 and %2.
    const { rng, target } = run(VP, 'MOVE_BODY_SLAM', [0, 99, 5, 0])
    expect(rng.calls).toBe(4)
    expect(hasFlag(target.mon.status1, STATUS1_PARALYSIS)).toBe(false) // 99 >= 30: the secondary roll failed
    expect(hasFlag(target.mon.status1, STATUS1_BURN)).toBe(true) // the ability's own roll still ran
  })
})

// ---------------------------------------------------------------------------
// 3. Virus (src/abilities.cc:10907-10913)
// ---------------------------------------------------------------------------

describe('Cycle 106c - Virus (abilities.cc:10907-10913)', () => {
  const VIRUS = 'ABILITY_VIRUS'

  it('poisons a poisoned-able target with an Electric move and draws no roll', () => {
    const rng = scriptedRng([])
    const state = battle([{ abilities: hasAbility(VIRUS), moves: slot('MOVE_THUNDERBOLT'), pp: pps }, {}], rng)
    const { res, unmodelled } = dispatch(state, 'MOVE_THUNDERBOLT')
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(false) // MOVE_EFFECT_POISON, not Toxic
    expect(rng.calls).toBe(0)
    expect(res.statusApplied).toEqual({ battlerId: 1, status: 'POISON' })
    expect(attackerNote(unmodelled, VIRUS)).toEqual([])
  })

  it('needs an Electric move', () => {
    const state = battle([{ abilities: hasAbility(VIRUS), moves: slot('MOVE_WATER_GUN'), pp: pps }, {}], scriptedRng([]))
    dispatch(state, 'MOVE_WATER_GUN')
    expect(state.battlers[1]!.mon.status1).toBe(0)
  })

  it('respects CanBePoisoned (Steel target, no Corrosion) and a fainted/undamaged target', () => {
    const steel = battle([{ abilities: hasAbility(VIRUS), moves: slot('MOVE_THUNDERBOLT'), pp: pps }, { types: TYPES('STEEL') }], scriptedRng([]))
    dispatch(steel, 'MOVE_THUNDERBOLT')
    expect(steel.battlers[1]!.mon.status1).toBe(0)

    const alreadyPoisoned = battle(
      [{ abilities: hasAbility(VIRUS), moves: slot('MOVE_THUNDERBOLT'), pp: pps }, { status1: STATUS1_POISON }],
      scriptedRng([]),
    )
    dispatch(alreadyPoisoned, 'MOVE_THUNDERBOLT')
    expect(hasFlag(alreadyPoisoned.battlers[1]!.mon.status1, STATUS1_TOXIC_POISON)).toBe(false)

    const noDamage = battle([{ abilities: hasAbility(VIRUS), moves: slot('MOVE_THUNDERBOLT'), pp: pps }, {}], scriptedRng([]))
    dispatch(noDamage, 'MOVE_THUNDERBOLT', { targetDamage: 0, hpDealt: 0 })
    expect(noDamage.battlers[1]!.mon.status1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Vitality Strike (src/abilities.cc:8545-8556)
// ---------------------------------------------------------------------------

describe('Cycle 106c - Vitality Strike (abilities.cc:8545-8556)', () => {
  const VS = 'ABILITY_VITALITY_STRIKE'
  const holder = (overrides: BattlerSpec = {}) => ({ abilities: hasAbility(VS), moves: slot('MOVE_MACH_PUNCH'), pp: pps, ...overrides })

  it('heals floor(hpDealt / 10) HP after an Iron Fist move', () => {
    // gBattleMoveDamage = -50 / 10 = -5, applied to BS_ATTACKER.
    const rng = scriptedRng([])
    const state = battle([holder({ hp: 50, maxHp: 100 }), {}], rng)
    const { unmodelled } = dispatch(state, 'MOVE_MACH_PUNCH', { targetDamage: 50, hpDealt: 50 })
    expect(state.battlers[0]!.mon.hp).toBe(55)
    expect(rng.calls).toBe(0) // no roll of its own
    expect(attackerNote(unmodelled, VS)).toEqual([])
  })

  it('floors a sub-10 hpDealt to exactly 1 HP (the C bumps a zero gBattleMoveDamage to -1)', () => {
    const state = battle([holder({ hp: 50, maxHp: 100 }), {}], scriptedRng([]))
    dispatch(state, 'MOVE_MACH_PUNCH', { targetDamage: 9, hpDealt: 9 })
    expect(state.battlers[0]!.mon.hp).toBe(51)
  })

  it('needs an Iron Fist move', () => {
    // Tackle is contact but carries no punchBased flag (DoesMoveMatchFlag ... MOVE_FLAG_PUNCH).
    const state = battle([{ ...holder({ hp: 50 }), moves: slot('MOVE_TACKLE') }, {}], scriptedRng([]))
    dispatch(state, 'MOVE_TACKLE', { targetDamage: 50, hpDealt: 50 })
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('needs the attacker below max HP and a damaging hit', () => {
    const full = battle([holder({ hp: 100, maxHp: 100 }), {}], scriptedRng([]))
    dispatch(full, 'MOVE_MACH_PUNCH', { targetDamage: 50, hpDealt: 50 })
    expect(full.battlers[0]!.mon.hp).toBe(100)

    const noDamage = battle([holder({ hp: 50, maxHp: 100 }), {}], scriptedRng([]))
    dispatch(noDamage, 'MOVE_MACH_PUNCH', { targetDamage: 0, hpDealt: 0 })
    expect(noDamage.battlers[0]!.mon.hp).toBe(50)
  })

  it('caps the heal at max HP', () => {
    const state = battle([holder({ hp: 98, maxHp: 100 }), {}], scriptedRng([]))
    dispatch(state, 'MOVE_MACH_PUNCH', { targetDamage: 50, hpDealt: 50 })
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 5. Wings of Pestilence (src/abilities.cc:11297-11313)
// ---------------------------------------------------------------------------

describe('Cycle 106c - Wings of Pestilence (abilities.cc:11297-11313)', () => {
  const WOP = 'ABILITY_WINGS_OF_PESTILENCE'
  const holder = { abilities: hasAbility(WOP), moves: slot('MOVE_TACKLE'), pp: pps }

  it('curses on the 10% roll and bleeds on the 20% roll, both drawn', () => {
    const rng = scriptedRng([5, 5])
    const state = battle([holder, {}], rng)
    const { unmodelled } = dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
    expect(rng.calls).toBe(2)
    expect(attackerNote(unmodelled, WOP)).toEqual([])
  })

  it('draws the bleed roll even when the curse roll failed', () => {
    // 50 is not < 10, but Random() % 100 is still drawn a second time for the bleed half.
    const rng = scriptedRng([50, 5])
    const state = battle([holder, {}], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
    expect(rng.calls).toBe(2)
  })

  it('still burns the curse draw when the target is already cursed (C draws before the STATUS2_CURSED test)', () => {
    const rng = scriptedRng([5, 99])
    const state = battle([holder, { status2: STATUS2_CURSED }], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(false) // 99 >= 20
    expect(rng.calls).toBe(2)
  })

  it('a failing CanBleed still consumes the bleed draw and leaves the status untouched', () => {
    // Rock types are rejected by CanBleed (battle_util.c:5106-5114) after the roll.
    const rng = scriptedRng([50, 5])
    const state = battle([holder, { types: TYPES('ROCK') }], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(rng.calls).toBe(2)
  })

  it('draws nothing when the hit did not land', () => {
    const rng = scriptedRng([5, 5])
    const state = battle([holder, {}], rng)
    dispatch(state, 'MOVE_TACKLE', { targetDamage: 0, hpDealt: 0 })
    expect(state.battlers[1]!.mon.status1).toBe(0)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CURSED)).toBe(false)
    expect(rng.calls).toBe(0)
  })

  it('draws after the accuracy roll and after the move secondary', () => {
    // Body Slam's 30% paralysis secondary fails (roll 99), then the two ability draws run.
    const { rng, target } = run(WOP, 'MOVE_BODY_SLAM', [0, 99, 5, 5])
    expect(rng.calls).toBe(4)
    expect(hasFlag(target.mon.status1, STATUS1_PARALYSIS)).toBe(false)
    expect(hasFlag(target.mon.status2, STATUS2_CURSED)).toBe(true)
    expect(hasFlag(target.mon.status1, STATUS1_BLEED)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 6. Woodland Curse, onAttacker half (src/abilities.cc:9835-9845, ON_EITHER)
// ---------------------------------------------------------------------------

describe('Cycle 106c - Woodland Curse onAttacker (abilities.cc:9835-9845)', () => {
  const WC = 'ABILITY_WOODLAND_CURSE'
  const holder = { abilities: hasAbility(WC), moves: slot('MOVE_TACKLE'), pp: pps }

  it('writes TYPE_GRASS into type3 only, leaving type1 and type2 alone', () => {
    const state = battle([holder, {}], scriptedRng([]))
    const { unmodelled } = dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'GRASS'])
    expect(attackerNote(unmodelled, WC)).toEqual([])
  })

  it('needs contact', () => {
    const state = battle([{ ...holder, moves: slot('MOVE_WATER_GUN') }, {}], scriptedRng([]))
    dispatch(state, 'MOVE_WATER_GUN')
    expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })

  it('skips a target that already has Grass anywhere in its type triple', () => {
    const state = battle([holder, { types: ['NORMAL', 'GRASS', 'MYSTERY'] }], scriptedRng([]))
    dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'GRASS', 'MYSTERY'])
  })

  it('needs a damaging hit', () => {
    const state = battle([holder, {}], scriptedRng([]))
    dispatch(state, 'MOVE_TACKLE', { targetDamage: 0, hpDealt: 0 })
    expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })
})

// ---------------------------------------------------------------------------
// 7. Wrestle Showman (src/abilities.cc:11716-11725; Cmd_settaunt, battle_script_commands.c:11678-11698)
// ---------------------------------------------------------------------------

describe('Cycle 106c - Wrestle Showman (abilities.cc:11716-11725)', () => {
  const WS = 'ABILITY_WRESTLE_SHOWMAN'
  const holder = { abilities: hasAbility(WS), moves: slot('MOVE_FLYING_PRESS'), pp: pps }

  it('sets a 3-turn taunt when the target has not moved yet this turn', () => {
    const state = battle([holder, {}], scriptedRng([]))
    const { unmodelled } = dispatch(state, 'MOVE_FLYING_PRESS', { targetHasActedThisTurn: false })
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(3)
    expect(state.battlers[1]!.volatiles.tauntTimer2).toBe(3)
    expect(attackerNote(unmodelled, WS)).toEqual([])
  })

  it('sets a 4-turn taunt when the target has already moved this turn', () => {
    const state = battle([holder, {}], scriptedRng([]))
    dispatch(state, 'MOVE_FLYING_PRESS', { targetHasActedThisTurn: true })
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(4)
    expect(state.battlers[1]!.volatiles.tauntTimer2).toBe(4)
  })

  it('reports the turn-order gap instead of guessing when the slot is not supplied', () => {
    const state = battle([holder, {}], scriptedRng([]))
    const { unmodelled } = dispatch(state, 'MOVE_FLYING_PRESS')
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(0)
    expect(unmodelled.some((n) => n.includes("Wrestle Showman's turn-order check"))).toBe(true)
  })

  it('happens in a real turn: the faster holder taunts the target that has not acted', () => {
    // Battler 0 (spe 100) moves before battler 1 (spe 50), so GetBattlerTurnOrderNum(target) > attacker's -> 3,
    // then ENDTURN_TAUNT (endTurn.ts:1937-1938) ticks it down once at the end of the same turn.
    const { rng, target, out } = run(WS, 'MOVE_FLYING_PRESS', [0])
    expect(rng.calls).toBe(1) // accuracy only: the ability draws nothing
    expect(target.volatiles.tauntTimer).toBe(2)
    expect(target.volatiles.tauntTimer2).toBe(3) // tauntTimer2 is not decremented by ENDTURN_TAUNT
    expect(attackerNote(out.actions[0]!.unmodelled, WS)).toEqual([])
  })

  it('needs MOVE_FLYING_PRESS', () => {
    const state = battle([{ ...holder, moves: slot('MOVE_TACKLE') }, {}], scriptedRng([]))
    dispatch(state, 'MOVE_TACKLE', { targetHasActedThisTurn: false })
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(0)
  })

  it('is blocked by IsAbilityStatusProtected(target, CHECK_RESTRICTING) (Oblivious)', () => {
    const state = battle([holder, { abilities: hasAbility('ABILITY_OBLIVIOUS') }], scriptedRng([]))
    dispatch(state, 'MOVE_FLYING_PRESS', { targetHasActedThisTurn: false })
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(0)
  })

  it('does not overwrite an existing taunt timer', () => {
    const state = battle([holder, {}], scriptedRng([]))
    state.battlers[1]!.volatiles.tauntTimer = 2
    dispatch(state, 'MOVE_FLYING_PRESS', { targetHasActedThisTurn: false })
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(2)
    expect(state.battlers[1]!.volatiles.tauntTimer2).toBe(0)
  })

  it('needs a damaging hit', () => {
    const state = battle([holder, {}], scriptedRng([]))
    dispatch(state, 'MOVE_FLYING_PRESS', { targetDamage: 0, hpDealt: 0, targetHasActedThisTurn: false })
    expect(state.battlers[1]!.volatiles.tauntTimer).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 8. Yuki Onna, onAttacker half (src/abilities.cc:6425-6433)
// ---------------------------------------------------------------------------

describe('Cycle 106c - Yuki Onna onAttacker (abilities.cc:6425-6433)', () => {
  const YO = 'ABILITY_YUKI_ONNA'
  const holder = { abilities: hasAbility(YO), moves: slot('MOVE_TACKLE'), pp: pps }

  it('attracts after CanInfatuate passes and the 30% roll lands', () => {
    const rng = scriptedRng([5])
    const state = battle([holder, {}], rng)
    const { res, unmodelled } = dispatch(state, 'MOVE_TACKLE')
    // statusInfatuatedWith(0) = 1 << 16, inside the STATUS2_INFATUATION nibble.
    expect(state.battlers[1]!.mon.status2).toBe(1 << 16)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
    expect(rng.calls).toBe(1)
    expect(res.statusApplied).toEqual({ battlerId: 1, status: 'INFATUATION' })
    expect(attackerNote(unmodelled, YO)).toEqual([])
  })

  it('does nothing when the 30% roll fails', () => {
    const rng = scriptedRng([30])
    const state = battle([holder, {}], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(state.battlers[1]!.mon.status2).toBe(0)
    expect(rng.calls).toBe(1) // the roll is still drawn
  })

  it('checks CanInfatuate BEFORE the roll: an already-infatuated target draws nothing', () => {
    const rng = scriptedRng([5])
    const state = battle([holder, { status2: STATUS2_INFATUATION }], rng)
    dispatch(state, 'MOVE_TACKLE')
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_INFATUATION)).toBe(true)
    expect(rng.calls).toBe(0)
  })

  it('needs a damaging hit', () => {
    const rng = scriptedRng([5])
    const state = battle([holder, {}], rng)
    dispatch(state, 'MOVE_TACKLE', { targetDamage: 0, hpDealt: 0 })
    expect(state.battlers[1]!.mon.status2).toBe(0)
    expect(rng.calls).toBe(0)
  })

  it('draws after the accuracy roll in a real turn', () => {
    const { rng, target } = run(YO, 'MOVE_TACKLE', [0, 5])
    expect(rng.calls).toBe(2) // accuracy, then the ability's Random() % 100
    expect(hasFlag(target.mon.status2, STATUS2_INFATUATION)).toBe(true)
  })
})
