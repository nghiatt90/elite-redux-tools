/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
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
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import { computeParentalBondTrigger } from '../abilities/dispatchCalc'
import { lookupAbility } from '../abilities/registry'
import type { AbilityImpl, OnChooseOffensiveStatContext, OnSwapSplitContext } from '../abilities/types'
import {
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_CRAFTY_SHIELD,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_WIDE_GUARD,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_TOXIC_POISON,
  STATUS2_SUBSTITUTE,
  hasFlag,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
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
  species: () => undefined,
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

function testDeps(damage: DamageResolver = fixedDamage(20), replacement?: ReplacementDeps, grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

/** One turn: holder (battler 0) uses `moveId` on battler 1 for a fixed 10 damage. */
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
function dispatchOnly(state: BattleState, moveId: string, hpDealt = 10) {
  const unmodelled: string[] = []
  const res = dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage: hpDealt,
    hpDealt,
    deps: testDeps(fixedDamage(hpDealt)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

const notModelled = (notes: string[], ability: string) => notes.filter((n) => n.includes(ability))
const TYPES = (t: string): [string, string, string] => [t, 'MYSTERY', 'MYSTERY']

describe('Cycle 95 - Impaler (src/abilities.cc:10222-10232)', () => {
  const IMPALER = 'ABILITY_IMPALER'

  it('horn move bleeds the target on roll < 30; the roll is drawn after the accuracy roll', () => {
    // Fire Glaive: hornBased, no secondary effect, accuracy 100 -> rolls: accuracy, then the ability's 30%.
    const hit = run(IMPALER, 'MOVE_FIRE_GLAIVE', [0, 29])
    expect(hasFlag(hit.target.mon.status1, STATUS1_BLEED)).toBe(true)
    expect(hit.rng.calls).toBe(2)
    expect(hit.out.actions[0]!.statusApplied).not.toBeNull()
    expect(notModelled(hit.out.actions[0]!.unmodelled, IMPALER)).toEqual([])

    // Roll 30 is not < 30
    const miss = run(IMPALER, 'MOVE_FIRE_GLAIVE', [0, 30])
    expect(hasFlag(miss.target.mon.status1, STATUS1_BLEED)).toBe(false)
    expect(miss.rng.calls).toBe(2)
  })

  it('draws no roll for a non-horn move, a bleed-immune target, a fainted target or no damage', () => {
    // Tackle is not hornBased: CHECK(hornBased) fails before Random()
    const nonHorn = run(IMPALER, 'MOVE_TACKLE', [0, 0])
    expect(nonHorn.target.mon.status1).toBe(0)
    expect(nonHorn.rng.calls).toBe(1)

    // Rock types are bleed-immune (CanBleed) -> checked before the roll
    const rock = run(IMPALER, 'MOVE_FIRE_GLAIVE', [0, 0], {}, { types: TYPES('ROCK') })
    expect(rock.target.mon.status1).toBe(0)
    expect(rock.rng.calls).toBe(1)

    // Already statused -> CanBleed fails
    const statused = run(IMPALER, 'MOVE_FIRE_GLAIVE', [0, 0], {}, { status1: STATUS1_PARALYSIS })
    expect(statused.target.mon.status1).toBe(STATUS1_PARALYSIS)
    expect(statused.rng.calls).toBe(1)

    // Target faints from the hit: ShouldApplyOnHitEffect requires IsBattlerAlive(target)
    const fainted = run(IMPALER, 'MOVE_FIRE_GLAIVE', [0, 0], {}, { hp: 10 })
    expect(fainted.target.mon.hp).toBe(0)
    expect(fainted.rng.calls).toBe(1)

    // No damage dealt -> DidMoveHit fails
    const noDamage = run(IMPALER, 'MOVE_FIRE_GLAIVE', [0, 0], {}, {}, undefined, 0)
    expect(hasFlag(noDamage.target.mon.status1, STATUS1_BLEED)).toBe(false)
    expect(noDamage.rng.calls).toBe(1)
  })
})

describe('Cycle 95 - Molten Blades (src/abilities.cc:7510-7520)', () => {
  const MB = 'ABILITY_MOLTEN_BLADES'

  it('slice move burns on roll < 20 (19 burns, 20 does not)', () => {
    // Sacred Sword: sliceBased, accuracy 100, no secondary effect -> rolls: accuracy, then the ability's 20%.
    const hit = run(MB, 'MOVE_SACRED_SWORD', [0, 19])
    expect(hasFlag(hit.target.mon.status1, STATUS1_BURN)).toBe(true)
    expect(hit.rng.calls).toBe(2)
    expect(notModelled(hit.out.actions[0]!.unmodelled, MB)).toEqual([])

    const miss = run(MB, 'MOVE_SACRED_SWORD', [0, 20])
    expect(miss.target.mon.status1).toBe(0)
    expect(miss.rng.calls).toBe(2)
  })

  it('draws no roll for a non-slice move, an already-statused target, a Fire-type target or no damage', () => {
    // Tackle is not a Keen Edge move; CanBeBurned passes, DoesMoveMatchFlag fails before the roll
    const nonSlice = run(MB, 'MOVE_TACKLE', [0, 0])
    expect(nonSlice.target.mon.status1).toBe(0)
    expect(nonSlice.rng.calls).toBe(1)

    // Already burned: CanBeBurned fails on STATUS1_ANY
    const burned = run(MB, 'MOVE_SACRED_SWORD', [0, 0], {}, { status1: STATUS1_BURN })
    expect(burned.target.mon.status1).toBe(STATUS1_BURN)
    expect(burned.rng.calls).toBe(1)

    // Fire types are burn-immune (CanBeBurned)
    const fire = run(MB, 'MOVE_SACRED_SWORD', [0, 0], {}, { types: TYPES('FIRE') })
    expect(fire.target.mon.status1).toBe(0)
    expect(fire.rng.calls).toBe(1)

    const noDamage = run(MB, 'MOVE_SACRED_SWORD', [0, 0], {}, {}, undefined, 0)
    expect(noDamage.target.mon.status1).toBe(0)
    expect(noDamage.rng.calls).toBe(1)
  })
})

describe('Cycle 95 - Toxic Chain and Komodo (src/abilities.cc:7698-7706, :10262-10267)', () => {
  for (const ability of ['ABILITY_TOXIC_CHAIN', 'ABILITY_KOMODO']) {
    it(`${ability}: toxic on roll < 30 (29 poisons, 30 does not)`, () => {
      // Tackle: accuracy 100, no secondary effect -> rolls: accuracy, then the ability's 30%.
      const hit = run(ability, 'MOVE_TACKLE', [0, 29])
      expect(hasFlag(hit.target.mon.status1, STATUS1_TOXIC_POISON)).toBe(true)
      expect(hit.rng.calls).toBe(2)
      expect(hit.out.actions[0]!.statusApplied).not.toBeNull()
      expect(notModelled(hit.out.actions[0]!.unmodelled, ability)).toEqual([])

      const miss = run(ability, 'MOVE_TACKLE', [0, 30])
      expect(miss.target.mon.status1).toBe(0)
      expect(miss.rng.calls).toBe(2)
    })

    it(`${ability}: Steel / Poison targets, statused targets and zero damage draw no roll`, () => {
      for (const type of ['STEEL', 'POISON']) {
        const immune = run(ability, 'MOVE_TACKLE', [0, 0], {}, { types: TYPES(type) })
        expect(immune.target.mon.status1).toBe(0)
        expect(immune.rng.calls).toBe(1)
      }

      const statused = run(ability, 'MOVE_TACKLE', [0, 0], {}, { status1: STATUS1_BURN })
      expect(statused.target.mon.status1).toBe(STATUS1_BURN)
      expect(statused.rng.calls).toBe(1)

      const noDamage = run(ability, 'MOVE_TACKLE', [0, 0], {}, {}, undefined, 0)
      expect(noDamage.target.mon.status1).toBe(0)
      expect(noDamage.rng.calls).toBe(1)
    })
  }
})

describe('Cycle 95 - Pinnacle Blade (src/abilities.cc:8687-8720)', () => {
  const PB = 'ABILITY_PINNACLE_BLADE'
  const SCREENS = SIDE_STATUS_REFLECT | SIDE_STATUS_LIGHTSCREEN | SIDE_STATUS_AURORA_VEIL

  it('slice move into a Substitute: the infiltrating hit lands, substituteHP ends at 0 and MOVEEND_SUBSTITUTE drops the flag', () => {
    const sub = run(
      PB,
      'MOVE_SACRED_SWORD',
      [0],
      {},
      {},
      (s) => {
        s.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
        s.battlers[1]!.volatiles.substituteHp = 25
      },
    )
    expect(sub.target.mon.hp).toBe(90) // onInfiltrate (statusEffects.ts) lets the hit past the Substitute
    expect(sub.target.volatiles.substituteHp).toBe(0)
    expect(hasFlag(sub.target.mon.status2, STATUS2_SUBSTITUTE)).toBe(false)
    expect(sub.rng.calls).toBe(1)
    expect(notModelled(sub.out.actions[0]!.unmodelled, PB)).toEqual([])

    // Non-slice move: not a Keen Edge move, so the onAttacker does nothing (and the Substitute absorbs it: this sim's damage path leaves it standing)
    const nonSlice = run(
      PB,
      'MOVE_TACKLE',
      [0],
      {},
      {},
      (s) => {
        s.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
        s.battlers[1]!.volatiles.substituteHp = 25
      },
    )
    expect(nonSlice.target.volatiles.substituteHp).toBe(25)
  })

  it('slice move shatters Reflect / Light Screen / Aurora Veil on the target side (timer and SIDE_STATUS bit), Brick Break shape', () => {
    for (const [bit, timer] of [
      [SIDE_STATUS_REFLECT, 'reflectTimer'],
      [SIDE_STATUS_LIGHTSCREEN, 'lightscreenTimer'],
      [SIDE_STATUS_AURORA_VEIL, 'auroraVeilTimer'],
    ] as const) {
      const setup = (s: BattleState) => {
        s.sides[1].statuses |= bit
        s.sides[1].timers[timer] = 3
      }
      const hit = run(PB, 'MOVE_SACRED_SWORD', [0], {}, {}, setup)
      expect(hit.state.sides[1].timers[timer]).toBe(0)
      expect(hit.state.sides[1].statuses & bit).toBe(0)
      expect(hit.rng.calls).toBe(1)

      // Non-slice move changes nothing: the screen only ticks down once at end of turn (3 -> 2)
      const nonSlice = run(PB, 'MOVE_TACKLE', [0], {}, {}, setup)
      expect(nonSlice.state.sides[1].timers[timer]).toBe(2)
      expect(nonSlice.state.sides[1].statuses & bit).toBe(bit)
    }

    // All three together are cleared in one go; the holder's own side is untouched
    const all = run(PB, 'MOVE_SACRED_SWORD', [0], {}, {}, (s) => {
      s.sides[1].statuses |= SCREENS
      s.sides[1].timers.reflectTimer = 5
      s.sides[1].timers.lightscreenTimer = 5
      s.sides[1].timers.auroraVeilTimer = 5
      s.sides[0].statuses |= SIDE_STATUS_REFLECT
      s.sides[0].timers.reflectTimer = 4
    })
    expect(all.state.sides[1].statuses & SCREENS).toBe(0)
    expect(all.state.sides[1].timers.reflectTimer + all.state.sides[1].timers.lightscreenTimer + all.state.sides[1].timers.auroraVeilTimer).toBe(0)
    expect(all.state.sides[0].statuses & SIDE_STATUS_REFLECT).toBe(SIDE_STATUS_REFLECT)
    expect(all.state.sides[0].timers.reflectTimer).toBe(3) // 4, ticked down once at end of turn
  })

  it('a fainted target keeps its side\'s screens (the screens / Feint halves need IsBattlerAlive) but the Substitute is still zeroed', () => {
    const out = run(
      PB,
      'MOVE_SACRED_SWORD',
      [0],
      {},
      { hp: 10 },
      (s) => {
        s.sides[1].statuses |= SIDE_STATUS_REFLECT
        s.sides[1].timers.reflectTimer = 3
        s.battlers[1]!.volatiles.substituteHp = 25
      },
    )
    expect(out.target.mon.hp).toBe(0)
    expect(out.state.sides[1].timers.reflectTimer).toBe(2) // 3, ticked down once at end of turn, not shattered
    expect(out.state.sides[1].statuses & SIDE_STATUS_REFLECT).toBe(SIDE_STATUS_REFLECT)
    expect(out.target.volatiles.substituteHp).toBe(0)
  })

  it('Feint half: a protected target loses protectMove and Wide Guard / Crafty Shield / Mat Block (battle_script_commands.c:2879-2891)', () => {
    // Move-end only: a real hit never reaches a Protect-ing target without a bypass, so the move-end dispatch is driven directly.
    const protectedByMove = battle([{ abilities: hasAbility(PB) }, {}], scriptedRng([]))
    protectedByMove.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
    const first = dispatchOnly(protectedByMove, 'MOVE_SACRED_SWORD')
    expect(protectedByMove.battlers[1]!.round.protectMove).toBeNull()
    expect(notModelled(first.unmodelled, PB)).toEqual([])
    expect(notModelled(first.unmodelled, 'Feint')).toEqual([])

    const sideGuards = SIDE_STATUS_WIDE_GUARD | SIDE_STATUS_CRAFTY_SHIELD | SIDE_STATUS_MAT_BLOCK
    const protectedBySide = battle([{ abilities: hasAbility(PB) }, {}], scriptedRng([]))
    protectedBySide.sides[1].statuses |= sideGuards | SIDE_STATUS_REFLECT
    dispatchOnly(protectedBySide, 'MOVE_SACRED_SWORD')
    expect(protectedBySide.sides[1].statuses & sideGuards).toBe(0)
    // IS_BATTLER_PROTECTED does not look at the screens, and no screen timer was running: the bit is left alone
    expect(protectedBySide.sides[1].statuses & SIDE_STATUS_REFLECT).toBe(SIDE_STATUS_REFLECT)

    // Not a Keen Edge move: nothing is removed
    const nonSlice = battle([{ abilities: hasAbility(PB) }, {}], scriptedRng([]))
    nonSlice.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
    nonSlice.sides[1].statuses |= sideGuards
    dispatchOnly(nonSlice, 'MOVE_TACKLE')
    expect(nonSlice.battlers[1]!.round.protectMove).toBe('MOVE_PROTECT')
    expect(nonSlice.sides[1].statuses & sideGuards).toBe(sideGuards)

    // No HP removed: DidMoveHit() fails
    const noHit = battle([{ abilities: hasAbility(PB) }, {}], scriptedRng([]))
    noHit.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
    dispatchOnly(noHit, 'MOVE_SACRED_SWORD', 0)
    expect(noHit.battlers[1]!.round.protectMove).toBe('MOVE_PROTECT')

    // Not protected: nothing to clear and no crash
    const unprotected = battle([{ abilities: hasAbility(PB) }, {}], scriptedRng([]))
    dispatchOnly(unprotected, 'MOVE_SACRED_SWORD')
    expect(unprotected.battlers[1]!.round.protectMove).toBeNull()
  })

  it('Feint half goes through SetMoveEffect, so Sheer Force still gates it (battle_script_commands.c:2361)', () => {
    // Slash is a Keen Edge move with a Sheer Force-boosted secondary effect (EFFECT_BLEED_HIT)
    expect(move('MOVE_SLASH').sheerForceBoost).toBe(true)
    const sheerForce = { ability: PB, innates: ['ABILITY_SHEER_FORCE', null, null] as [string, null, null] }
    const gated = battle([{ abilities: sheerForce }, {}], scriptedRng([]))
    gated.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
    dispatchOnly(gated, 'MOVE_SLASH')
    expect(gated.battlers[1]!.round.protectMove).toBe('MOVE_PROTECT')

    const open = battle([{ abilities: hasAbility(PB) }, {}], scriptedRng([]))
    open.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
    dispatchOnly(open, 'MOVE_SLASH')
    expect(open.battlers[1]!.round.protectMove).toBeNull()
  })
})

describe('Cycle 95 - none of the five ids is reported as unmodelled any more', () => {
  it('Impaler, Molten Blades, Toxic Chain, Komodo and Pinnacle Blade raise no "not modelled yet" note', () => {
    for (const ability of ['ABILITY_IMPALER', 'ABILITY_MOLTEN_BLADES', 'ABILITY_TOXIC_CHAIN', 'ABILITY_KOMODO', 'ABILITY_PINNACLE_BLADE']) {
      const state = battle([{ abilities: hasAbility(ability) }, {}], scriptedRng([]))
      const { unmodelled } = dispatchOnly(state, 'MOVE_SACRED_SWORD')
      expect(unmodelled.filter((n) => n.includes('not modelled yet'))).toEqual([])
    }
  })
})

describe('Cycle 95 - Best Offense (:10215-10220) and Magus Blades (:10235-10241) registry pins', () => {
  function findAbility(id: string): AbilityImpl {
    const entry = lookupAbility(id)
    if (!entry || 'unmodelled' in entry) throw new Error(`${id} not a real port`)
    return entry
  }
  const swap = (overrides: Partial<OnSwapSplitContext> = {}): OnSwapSplitContext => ({
    battlerId: 'x',
    moveId: 'MOVE_SACRED_SWORD',
    moveType: 'FIGHTING',
    moveSplit: 'PHYSICAL',
    moveFlags: { sliceBased: true },
    ...overrides,
  })
  const chooseStat = (secondaryStat: OnChooseOffensiveStatContext['secondaryStat']): OnChooseOffensiveStatContext => ({
    battlerId: 'x',
    moveId: 'MOVE_SACRED_SWORD',
    isCrit: false,
    isUnaware: false,
    moveSplit: 'PHYSICAL',
    moveFlags: { sliceBased: true },
    isHighestAttackingStat: true,
    statToUse: 'atk',
    secondaryStat,
  })

  for (const id of ['ABILITY_BEST_OFFENSE', 'ABILITY_MAGUS_BLADES']) {
    it(`${id}: Keen Edge offensive multiplier, Mystic Blades swap-split, +20 SpDef secondary stat`, () => {
      const impl = findAbility(id)
      expect(impl.onOffensiveMultiplier).toBeTypeOf('function')

      // Impl<ABILITY_MYSTIC_BLADES>.onSwapSplit (:6489-6493): PHYSICAL split and a Keen Edge move
      expect(impl.onSwapSplit!(swap())).toBe(true)
      expect(impl.onSwapSplit!(swap({ moveSplit: 'SPECIAL' }))).toBe(false)
      expect(impl.onSwapSplit!(swap({ moveFlags: {} }))).toBe(false)

      // secondaryAtkStatToUse[STAT_SPDEF] += 20, unconditionally
      const fresh = chooseStat({})
      impl.onChooseOffensiveStat!(fresh)
      expect(fresh.secondaryStat.spdef).toBe(20)
      const stacked = chooseStat({ spdef: 5 })
      impl.onChooseOffensiveStat!(stacked)
      expect(stacked.secondaryStat.spdef).toBe(25)
      const nonSlice = chooseStat({})
      nonSlice.moveFlags = {}
      impl.onChooseOffensiveStat!(nonSlice)
      expect(nonSlice.secondaryStat.spdef).toBe(20)
    })
  }

  it('Magus Blades resolves to the Dual Wield parental-bond trigger on a slice move only; Best Offense has none', () => {
    const slots = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })
    const none = { ability: null, innates: [null, null, null] as [null, null, null] }
    const ctx = (moveFlags: Record<string, true>) => ({ moveType: 'FIGHTING', moveFlags, weather: 'NONE', attackerHeads: 1 })
    expect(computeParentalBondTrigger(slots('ABILITY_MAGUS_BLADES'), none, ctx({ sliceBased: true }))).toBe('DUAL_WIELD')
    expect(computeParentalBondTrigger(slots('ABILITY_MAGUS_BLADES'), none, ctx({}))).toBeNull()
    expect(computeParentalBondTrigger(slots('ABILITY_BEST_OFFENSE'), none, ctx({ sliceBased: true }))).toBeNull()
  })
})
