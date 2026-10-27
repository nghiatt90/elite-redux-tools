import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
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
import {
  DEFAULT_STAT_STAGE,
  STAT_DEF,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_TOXIC_POISON,
  STATUS2_CONFUSION,
  STATUS2_ENRAGED,
  STATUS2_FLINCHED,
  STATUS2_INFATUATION,
  STATUS4_FEAR,
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
    pp: m.pp as number,
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

function battle(
  specs: {
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
  }[],
  rng: RandomSource,
): BattleState {
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

function countingRng(): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return 0
    },
  }
  return r
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
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

describe('Cycle 86 - "-ate" 10% on-hit status abilities (src/abilities.cc)', () => {
  const waterType: [string, string, string] = ['WATER', 'MYSTERY', 'MYSTERY']
  const fairyType: [string, string, string] = ['FAIRY', 'MYSTERY', 'MYSTERY']
  const rockType: [string, string, string] = ['ROCK', 'MYSTERY', 'MYSTERY']
  const electricType: [string, string, string] = ['ELECTRIC', 'MYSTERY', 'MYSTERY']
  const iceType: [string, string, string] = ['ICE', 'MYSTERY', 'MYSTERY']
  const poisonType: [string, string, string] = ['POISON', 'MYSTERY', 'MYSTERY']
  const psychicType: [string, string, string] = ['PSYCHIC', 'MYSTERY', 'MYSTERY']
  const fireType: [string, string, string] = ['FIRE', 'MYSTERY', 'MYSTERY']
  const ghostType: [string, string, string] = ['GHOST', 'MYSTERY', 'MYSTERY']
  const darkType: [string, string, string] = ['DARK', 'MYSTERY', 'MYSTERY']

  it('Hydrate drenches target 1 in 10 on a Water move (abilities.cc:4122-4133)', () => {
    // scripted: roll 0 = accuracy (hits), roll 1 = Hydrate roll (0 % 10 === 0 -> procs), roll 2 = drench duration (0 -> 2 turns)
    const hit = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, types: waterType, abilities: hasAbility('ABILITY_HYDRATE') }, {}], scriptedRng([0, 0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.volatiles.drenched).toBeGreaterThan(0)

    // Negative: wrong roll (5 % 10 !== 0)
    const miss = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, types: waterType, abilities: hasAbility('ABILITY_HYDRATE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.volatiles.drenched).toBe(0)

    // Negative: attacker not Water type
    const wrongType = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, types: fireType, abilities: hasAbility('ABILITY_HYDRATE') }, {}], scriptedRng([0, 0, 0]))
    executeTurn(wrongType, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(wrongType.battlers[1]?.volatiles.drenched).toBe(0)

    // Negative: target is Water type (immune to drench)
    const waterTarget = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, types: waterType, abilities: hasAbility('ABILITY_HYDRATE') }, { types: waterType }], scriptedRng([0, 0, 0]))
    executeTurn(waterTarget, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(waterTarget.battlers[1]?.volatiles.drenched).toBe(0)

    // Negative: 0 damage dealt
    const zeroDmg = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, types: waterType, abilities: hasAbility('ABILITY_HYDRATE') }, {}], scriptedRng([0, 0, 0]))
    executeTurn(zeroDmg, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(0)))
    expect(zeroDmg.battlers[1]?.volatiles.drenched).toBe(0)

    // Type change: Normal move Tackle converted to Water by Hydrate triggers onAttacker
    const tackleConv = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: waterType, abilities: hasAbility('ABILITY_HYDRATE') }, {}], scriptedRng([0, 0, 0]))
    executeTurn(tackleConv, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(tackleConv.battlers[1]?.volatiles.drenched).toBeGreaterThan(0)
  })

  it('Pixilate attracts target 1 in 10 on a Fairy move (abilities.cc:2468-2479, 9287, 8101)', () => {
    // Tackle converted to Fairy by Pixilate; Male attacker, Female target
    const hit = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: fairyType, abilities: hasAbility('ABILITY_PIXILATE'), gender: 'MALE' }, { gender: 'FEMALE' }], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(hit.battlers[1]?.mon.status2 ?? 0, STATUS2_INFATUATION)).toBe(true)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: fairyType, abilities: hasAbility('ABILITY_PIXILATE'), gender: 'MALE' }, { gender: 'FEMALE' }], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(miss.battlers[1]?.mon.status2 ?? 0, STATUS2_INFATUATION)).toBe(false)

    // Negative: non-Fairy attacker does not infatuate (src/battle_util.c:5135-5143 CanInfatuate has no gender check; checks IS_BATTLER_OF_TYPE)
    const nonFairy = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: ['NORMAL', 'MYSTERY', 'MYSTERY'], abilities: hasAbility('ABILITY_PIXILATE') }, {}], scriptedRng([0, 0]))
    executeTurn(nonFairy, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(nonFairy.battlers[1]?.mon.status2 ?? 0, STATUS2_INFATUATION)).toBe(false)

    // Aliases: Striker Pixilate and Unicorn
    const striker = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: fairyType, abilities: hasAbility('ABILITY_STRIKER_PIXILATE'), gender: 'MALE' }, { gender: 'FEMALE' }], scriptedRng([0, 0]))
    executeTurn(striker, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(striker.battlers[1]?.mon.status2 ?? 0, STATUS2_INFATUATION)).toBe(true)

    const unicorn = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: fairyType, abilities: hasAbility('ABILITY_UNICORN'), gender: 'MALE' }, { gender: 'FEMALE' }], scriptedRng([0, 0]))
    executeTurn(unicorn, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(unicorn.battlers[1]?.mon.status2 ?? 0, STATUS2_INFATUATION)).toBe(true)
  })

  it('Mineralize bleeds target 1 in 10 on a Rock move (abilities.cc:5090-5101, 11229)', () => {
    const hit = battle([{ moves: slot('MOVE_POWER_GEM'), pp: pps, types: rockType, abilities: hasAbility('ABILITY_MINERALIZE') }, {}], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_POWER_GEM')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.mon.status1).toBe(STATUS1_BLEED)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_POWER_GEM'), pp: pps, types: rockType, abilities: hasAbility('ABILITY_MINERALIZE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_POWER_GEM')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.mon.status1).toBe(0)

    // Negative: target is Rock type (cannot bleed)
    const rockTarget = battle([{ moves: slot('MOVE_POWER_GEM'), pp: pps, types: rockType, abilities: hasAbility('ABILITY_MINERALIZE') }, { types: rockType }], scriptedRng([0, 0]))
    executeTurn(rockTarget, [useMove(1, move('MOVE_POWER_GEM')), null], testDeps(fixedDamage(10)))
    expect(rockTarget.battlers[1]?.mon.status1).toBe(0)

    // Alias: Lead Claws
    const lead = battle([{ moves: slot('MOVE_POWER_GEM'), pp: pps, types: rockType, abilities: hasAbility('ABILITY_LEAD_CLAWS') }, {}], scriptedRng([0, 0]))
    executeTurn(lead, [useMove(1, move('MOVE_POWER_GEM')), null], testDeps(fixedDamage(10)))
    expect(lead.battlers[1]?.mon.status1).toBe(STATUS1_BLEED)
  })

  it('Galvanize paralyzes target 1 in 10 on an Electric move (abilities.cc:2811-2822, 5310)', () => {
    const hit = battle([{ moves: slot('MOVE_SHOCK_WAVE'), pp: pps, types: electricType, abilities: hasAbility('ABILITY_GALVANIZE') }, {}], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_SHOCK_WAVE')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.mon.status1).toBe(STATUS1_PARALYSIS)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_SHOCK_WAVE'), pp: pps, types: electricType, abilities: hasAbility('ABILITY_GALVANIZE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_SHOCK_WAVE')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.mon.status1).toBe(0)

    // Negative: target is Electric type
    const elecTarget = battle([{ moves: slot('MOVE_SHOCK_WAVE'), pp: pps, types: electricType, abilities: hasAbility('ABILITY_GALVANIZE') }, { types: electricType }], scriptedRng([0, 0]))
    executeTurn(elecTarget, [useMove(1, move('MOVE_SHOCK_WAVE')), null], testDeps(fixedDamage(10)))
    expect(elecTarget.battlers[1]?.mon.status1).toBe(0)

    // Alias: Atomic Burst
    const atomic = battle([{ moves: slot('MOVE_SHOCK_WAVE'), pp: pps, types: electricType, abilities: hasAbility('ABILITY_ATOMIC_BURST') }, {}], scriptedRng([0, 0]))
    executeTurn(atomic, [useMove(1, move('MOVE_SHOCK_WAVE')), null], testDeps(fixedDamage(10)))
    expect(atomic.battlers[1]?.mon.status1).toBe(STATUS1_PARALYSIS)
  })

  it('Refrigerate frostbites target 1 in 10 on an Ice move (abilities.cc:2372-2383)', () => {
    const hit = battle([{ moves: slot('MOVE_ICE_SHARD'), pp: pps, types: iceType, abilities: hasAbility('ABILITY_REFRIGERATE') }, {}], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_ICE_SHARD')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.mon.status1).toBe(STATUS1_FROSTBITE)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_ICE_SHARD'), pp: pps, types: iceType, abilities: hasAbility('ABILITY_REFRIGERATE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_ICE_SHARD')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.mon.status1).toBe(0)

    // Negative: target is Ice type
    const iceTarget = battle([{ moves: slot('MOVE_ICE_SHARD'), pp: pps, types: iceType, abilities: hasAbility('ABILITY_REFRIGERATE') }, { types: iceType }], scriptedRng([0, 0]))
    executeTurn(iceTarget, [useMove(1, move('MOVE_ICE_SHARD')), null], testDeps(fixedDamage(10)))
    expect(iceTarget.battlers[1]?.mon.status1).toBe(0)
  })

  it('Intoxicate toxic-poisons target 1 in 10 on a Poison move (abilities.cc:4201-4212, 8984)', () => {
    // Tackle converted to Poison by Intoxicate
    const hit = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: poisonType, abilities: hasAbility('ABILITY_INTOXICATE') }, {}], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(hit.battlers[1]?.mon.status1 ?? 0, STATUS1_TOXIC_POISON)).toBe(true)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: poisonType, abilities: hasAbility('ABILITY_INTOXICATE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.mon.status1).toBe(0)

    // Negative: target is Steel type
    const steelTarget = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: poisonType, abilities: hasAbility('ABILITY_INTOXICATE') }, { types: ['STEEL', 'MYSTERY', 'MYSTERY'] }], scriptedRng([0, 0]))
    executeTurn(steelTarget, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(steelTarget.battlers[1]?.mon.status1).toBe(0)

    // Alias: Sludgy Mix
    const sludgy = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: poisonType, abilities: hasAbility('ABILITY_SLUDGY_MIX') }, {}], scriptedRng([0, 0]))
    executeTurn(sludgy, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(sludgy.battlers[1]?.mon.status1 ?? 0, STATUS1_TOXIC_POISON)).toBe(true)
  })

  it('Emanate confuses target 1 in 10 on a Psychic move (abilities.cc:6015-6026, 6330)', () => {
    const hit = battle([{ moves: slot('MOVE_PSYSHOCK'), pp: pps, types: psychicType, abilities: hasAbility('ABILITY_EMANATE') }, {}], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_PSYSHOCK')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(hit.battlers[1]?.mon.status2 ?? 0, STATUS2_CONFUSION)).toBe(true)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_PSYSHOCK'), pp: pps, types: psychicType, abilities: hasAbility('ABILITY_EMANATE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_PSYSHOCK')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(miss.battlers[1]?.mon.status2 ?? 0, STATUS2_CONFUSION)).toBe(false)

    // Alias: Enlightened
    const enlight = battle([{ moves: slot('MOVE_PSYSHOCK'), pp: pps, types: psychicType, abilities: hasAbility('ABILITY_ENLIGHTENED') }, {}], scriptedRng([0, 0]))
    executeTurn(enlight, [useMove(1, move('MOVE_PSYSHOCK')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(enlight.battlers[1]?.mon.status2 ?? 0, STATUS2_CONFUSION)).toBe(true)
  })

  it('Immolate and Solar Flare burn target 1 in 10 on a Fire move (abilities.cc:3742-3753, 4637)', () => {
    // Tackle converted to Fire by Immolate
    const hit = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: fireType, abilities: hasAbility('ABILITY_IMMOLATE') }, {}], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.mon.status1).toBe(STATUS1_BURN)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: fireType, abilities: hasAbility('ABILITY_IMMOLATE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.mon.status1).toBe(0)

    // Negative: target is Fire type
    const fireTarget = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: fireType, abilities: hasAbility('ABILITY_IMMOLATE') }, { types: fireType }], scriptedRng([0, 0]))
    executeTurn(fireTarget, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(fireTarget.battlers[1]?.mon.status1).toBe(0)

    // Alias: Solar Flare
    const flare = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, types: fireType, abilities: hasAbility('ABILITY_SOLAR_FLARE') }, {}], scriptedRng([0, 0]))
    executeTurn(flare, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(flare.battlers[1]?.mon.status1).toBe(STATUS1_BURN)
  })

  it('Spectralize inflicts Fear 1 in 10 on a Ghost move (abilities.cc:4865-4875)', () => {
    const hit = battle([{ moves: slot('MOVE_SHADOW_SNEAK'), pp: pps, types: ghostType, abilities: hasAbility('ABILITY_SPECTRALIZE') }, {}], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_SHADOW_SNEAK')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.volatiles.fear).toBe(true)
    expect(hasFlag(hit.battlers[1]?.statuses4 ?? 0, STATUS4_FEAR)).toBe(true)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_SHADOW_SNEAK'), pp: pps, types: ghostType, abilities: hasAbility('ABILITY_SPECTRALIZE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_SHADOW_SNEAK')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.volatiles.fear).toBe(false)
  })

  it('Deviate and Mob Boss enrage target 1 in 10 on a Dark move (abilities.cc:9755-9768, 12450)', () => {
    const hit = battle([{ moves: slot('MOVE_PAYBACK'), pp: pps, types: darkType, abilities: hasAbility('ABILITY_DEVIATE') }, {}], scriptedRng([0, 0]))
    executeTurn(hit, [useMove(1, move('MOVE_PAYBACK')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(hit.battlers[1]?.mon.status2 ?? 0, STATUS2_ENRAGED)).toBe(true)

    // Negative: wrong roll
    const miss = battle([{ moves: slot('MOVE_PAYBACK'), pp: pps, types: darkType, abilities: hasAbility('ABILITY_DEVIATE') }, {}], scriptedRng([0, 5]))
    executeTurn(miss, [useMove(1, move('MOVE_PAYBACK')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(miss.battlers[1]?.mon.status2 ?? 0, STATUS2_ENRAGED)).toBe(false)

    // Alias: Mob Boss
    const mob = battle([{ moves: slot('MOVE_PAYBACK'), pp: pps, types: darkType, abilities: hasAbility('ABILITY_MOB_BOSS') }, {}], scriptedRng([0, 0]))
    executeTurn(mob, [useMove(1, move('MOVE_PAYBACK')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(mob.battlers[1]?.mon.status2 ?? 0, STATUS2_ENRAGED)).toBe(true)
  })
})

describe('Cycle 86 - Other status-on-hit attacker abilities (src/abilities.cc)', () => {
  it('Resonance bleeds target on sound moves 50% of the time (abilities.cc:7871-7880)', () => {
    // Hyper Voice is a sound move (flags.sound = true, accuracy = 100, effectChance = 0)
    // scripted: roll 0 = accuracy (hits), roll 1 = 20 (< 50 -> procs bleed)
    const hit = battle([{ moves: slot('MOVE_HYPER_VOICE'), pp: pps, abilities: hasAbility('ABILITY_RESONANCE') }, {}], scriptedRng([0, 20]))
    executeTurn(hit, [useMove(1, move('MOVE_HYPER_VOICE')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.mon.status1).toBe(STATUS1_BLEED)

    // Negative: roll >= 50
    const miss = battle([{ moves: slot('MOVE_HYPER_VOICE'), pp: pps, abilities: hasAbility('ABILITY_RESONANCE') }, {}], scriptedRng([0, 75]))
    executeTurn(miss, [useMove(1, move('MOVE_HYPER_VOICE')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.mon.status1).toBe(0)

    // Negative: non-sound move (Water Gun)
    const nonSound = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, abilities: hasAbility('ABILITY_RESONANCE') }, {}], scriptedRng([0, 20]))
    executeTurn(nonSound, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(nonSound.battlers[1]?.mon.status1).toBe(0)
  })

  it('Solenoglyphs toxic-poisons target on Strong Jaw / bite moves 50% of the time (abilities.cc:4371-4380)', () => {
    // Psychic Fangs is a Strong Jaw move (flags.biteBased = true, accuracy = 100, effectChance = 0)
    // scripted: roll 0 = accuracy, roll 1 = 1 (1 % 2 !== 0 -> procs toxic)
    const hit = battle([{ moves: slot('MOVE_PSYCHIC_FANGS'), pp: pps, abilities: hasAbility('ABILITY_SOLENOGLYPHS') }, {}], scriptedRng([0, 1]))
    executeTurn(hit, [useMove(1, move('MOVE_PSYCHIC_FANGS')), null], testDeps(fixedDamage(10)))
    expect(hasFlag(hit.battlers[1]?.mon.status1 ?? 0, STATUS1_TOXIC_POISON)).toBe(true)

    // Negative: roll % 2 === 0
    const miss = battle([{ moves: slot('MOVE_PSYCHIC_FANGS'), pp: pps, abilities: hasAbility('ABILITY_SOLENOGLYPHS') }, {}], scriptedRng([0, 0]))
    executeTurn(miss, [useMove(1, move('MOVE_PSYCHIC_FANGS')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.mon.status1).toBe(0)

    // Negative: non-bite move (Tackle)
    const nonBite = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_SOLENOGLYPHS') }, {}], scriptedRng([0, 1]))
    executeTurn(nonBite, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(nonBite.battlers[1]?.mon.status1).toBe(0)
  })

  it('Razor Sharp and To The Bone bleed target on critical hits (abilities.cc:9021-9029, 9032)', () => {
    const hit = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_RAZOR_SHARP') }, {}], countingRng())
    executeTurn(hit, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10, true)))
    expect(hit.battlers[1]?.mon.status1).toBe(STATUS1_BLEED)

    // Negative: non-critical hit
    const nonCrit = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_RAZOR_SHARP') }, {}], countingRng())
    executeTurn(nonCrit, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10, false)))
    expect(nonCrit.battlers[1]?.mon.status1).toBe(0)

    // Alias: To The Bone
    const toTheBone = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_TO_THE_BONE') }, {}], countingRng())
    executeTurn(toTheBone, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10, true)))
    expect(toTheBone.battlers[1]?.mon.status1).toBe(STATUS1_BLEED)
  })

  it('Fearmonger inflicts Fear on contact moves 10% of the time (abilities.cc:5170-5180)', () => {
    // Tackle is contact (flags.contact = true, accuracy = 100, effectChance = 0)
    // scripted: roll 0 = accuracy, roll 1 = 5 (< 10 -> procs fear)
    const hit = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_FEARMONGER') }, {}], scriptedRng([0, 5]))
    executeTurn(hit, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.volatiles.fear).toBe(true)
    expect(hasFlag(hit.battlers[1]?.statuses4 ?? 0, STATUS4_FEAR)).toBe(true)

    // Negative: roll >= 10
    const miss = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_FEARMONGER') }, {}], scriptedRng([0, 25]))
    executeTurn(miss, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.volatiles.fear).toBe(false)

    // Negative: non-contact move (Water Gun)
    const nonContact = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, abilities: hasAbility('ABILITY_FEARMONGER') }, {}], scriptedRng([0, 5]))
    executeTurn(nonContact, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(nonContact.battlers[1]?.volatiles.fear).toBe(false)
  })

  it('Menacing Situation inflicts Fear on contact moves 30% of the time (abilities.cc:7905-7919)', () => {
    const hit = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_MENACING_SITUATION') }, {}], scriptedRng([0, 15]))
    executeTurn(hit, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.volatiles.fear).toBe(true)

    // Negative: roll >= 30
    const miss = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_MENACING_SITUATION') }, {}], scriptedRng([0, 50]))
    executeTurn(miss, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.volatiles.fear).toBe(false)
  })

  it('Freezing Point inflicts Frostbite: 20% on contact, 30% on non-contact (abilities.cc:6360-6371)', () => {
    // Contact move Tackle (chance 20%): roll 15 < 20 procs
    const hitContact = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_FREEZING_POINT') }, {}], scriptedRng([0, 15]))
    executeTurn(hitContact, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(hitContact.battlers[1]?.mon.status1).toBe(STATUS1_FROSTBITE)

    // Contact move Tackle: roll 25 >= 20 misses
    const missContact = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_FREEZING_POINT') }, {}], scriptedRng([0, 25]))
    executeTurn(missContact, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(missContact.battlers[1]?.mon.status1).toBe(0)

    // Non-contact move Water Gun (chance 30%): roll 25 < 30 procs
    const hitNonContact = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, abilities: hasAbility('ABILITY_FREEZING_POINT') }, {}], scriptedRng([0, 25]))
    executeTurn(hitNonContact, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(hitNonContact.battlers[1]?.mon.status1).toBe(STATUS1_FROSTBITE)

    // Non-contact move Water Gun: roll 35 >= 30 misses
    const missNonContact = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, abilities: hasAbility('ABILITY_FREEZING_POINT') }, {}], scriptedRng([0, 35]))
    executeTurn(missNonContact, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(missNonContact.battlers[1]?.mon.status1).toBe(0)
  })

  it('Vital Spirit heals user status after a Fighting move (abilities.cc:1351-1364)', () => {
    // Karate Chop is Fighting type
    const state = battle([{ moves: slot('MOVE_KARATE_CHOP'), pp: pps, status1: STATUS1_BURN, abilities: hasAbility('ABILITY_VITAL_SPIRIT') }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_KARATE_CHOP')), null], testDeps(fixedDamage(10)))
    expect(state.battlers[0]?.mon.status1).toBe(0)

    // Negative: non-Fighting move (Water Gun) does not heal status
    const nonFight = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, status1: STATUS1_BURN, abilities: hasAbility('ABILITY_VITAL_SPIRIT') }, {}], countingRng())
    executeTurn(nonFight, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(nonFight.battlers[0]?.mon.status1).toBe(STATUS1_BURN)
  })

  it('Whiplash lowers target Defense by 1 on physical move, once per turn (abilities.cc:8942-8954)', () => {
    // Tackle is Physical
    const state = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_WHIPLASH') }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(10)))
    expect(state.battlers[1]?.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)

    // Negative: Special move Water Gun does not lower Defense
    const special = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, abilities: hasAbility('ABILITY_WHIPLASH') }, {}], countingRng())
    executeTurn(special, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(special.battlers[1]?.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
  })
})

describe('Cycle 86 - Self-damage / healing / other attacker abilities (src/abilities.cc)', () => {
  it('Aftermath flinches target on Explosion (abilities.cc:1655-1662)', () => {
    // Explosion self-KOs user (hp: 0); Aftermath flinches target even when user has fainted.
    // STATUS2_FLINCHED is cleared at end of turn (endTurn.ts:1352), so observe directly via dispatchMoveEndAttackerAbilities.
    const hit = battle([{ hp: 0, moves: slot('MOVE_EXPLOSION'), pp: pps, abilities: hasAbility('ABILITY_AFTERMATH') }, {}], countingRng())
    dispatchMoveEndAttackerAbilities({
      state: hit,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_EXPLOSION',
      moveData: move('MOVE_EXPLOSION'),
      targetDamage: 10,
      hpDealt: 10,
      deps: testDeps(fixedDamage(10)),
      unmodelled: [],
      fainted: [0],
    })
    expect(hasFlag(hit.battlers[1]?.mon.status2 ?? 0, STATUS2_FLINCHED)).toBe(true)

    // Negative: non-explosion move Tackle does not flinch
    const nonExp = battle([{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_AFTERMATH') }, {}], countingRng())
    dispatchMoveEndAttackerAbilities({
      state: nonExp,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_TACKLE',
      moveData: move('MOVE_TACKLE'),
      targetDamage: 10,
      hpDealt: 10,
      deps: testDeps(fixedDamage(10)),
      unmodelled: [],
      fainted: [],
    })
    expect(hasFlag(nonExp.battlers[1]?.mon.status2 ?? 0, STATUS2_FLINCHED)).toBe(false)
  })

  it('Energy Tap recovers 1/8 of hp dealt (abilities.cc:10623-10634)', () => {
    // User at 50/100 HP, deals 40 damage -> recovers floor(40 / 8) = 5 HP -> 55 HP
    const state = battle([{ hp: 50, maxHp: 100, moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_ENERGY_TAP') }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(40)))
    expect(state.battlers[0]?.mon.hp).toBe(55)

    // Negative: User at max HP stays at max HP
    const full = battle([{ hp: 100, maxHp: 100, moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_ENERGY_TAP') }, {}], countingRng())
    executeTurn(full, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(40)))
    expect(full.battlers[0]?.mon.hp).toBe(100)

    // Negative: 0 damage dealt -> no healing
    const zeroDmg = battle([{ hp: 50, maxHp: 100, moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_ENERGY_TAP') }, {}], countingRng())
    executeTurn(zeroDmg, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(0)))
    expect(zeroDmg.battlers[0]?.mon.hp).toBe(50)
  })

  it('Fertilize recovers 1/10 of hp dealt by Grass attacker on a Grass move (abilities.cc:6506-6520)', () => {
    // Grass attacker, Vine Whip (Grass), dealt 50 damage -> recovers floor(50 / 10) = 5 HP
    const state = battle([{ hp: 50, maxHp: 100, types: ['GRASS', 'MYSTERY', 'MYSTERY'], moves: slot('MOVE_VINE_WHIP'), pp: pps, abilities: hasAbility('ABILITY_FERTILIZE') }, {}], countingRng())
    executeTurn(state, [useMove(1, move('MOVE_VINE_WHIP')), null], testDeps(fixedDamage(50)))
    expect(state.battlers[0]?.mon.hp).toBe(55)

    // Negative: non-Grass move (Water Gun) does not heal (Tackle is converted to Grass by Fertilize's ATE_ABILITY(TYPE_GRASS) at abilities.cc:6519)
    const nonGrassMove = battle([{ hp: 50, maxHp: 100, types: ['GRASS', 'MYSTERY', 'MYSTERY'], moves: slot('MOVE_WATER_GUN'), pp: pps, abilities: hasAbility('ABILITY_FERTILIZE') }, {}], countingRng())
    executeTurn(nonGrassMove, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(50)))
    expect(nonGrassMove.battlers[0]?.mon.hp).toBe(50)

    // Negative: non-Grass attacker does not heal
    const nonGrassAttacker = battle([{ hp: 50, maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'], moves: slot('MOVE_VINE_WHIP'), pp: pps, abilities: hasAbility('ABILITY_FERTILIZE') }, {}], countingRng())
    executeTurn(nonGrassAttacker, [useMove(1, move('MOVE_VINE_WHIP')), null], testDeps(fixedDamage(50)))
    expect(nonGrassAttacker.battlers[0]?.mon.hp).toBe(50)
  })

  it('Molten Coat burns target 50% of the time on Rock moves (abilities.cc:10313-10324)', () => {
    // Power Gem is Rock move
    // scripted: roll 0 = accuracy, roll 1 = 1 (1 % 2 !== 0 -> procs burn)
    const hit = battle([{ moves: slot('MOVE_POWER_GEM'), pp: pps, abilities: hasAbility('ABILITY_MOLTEN_COAT') }, {}], scriptedRng([0, 1]))
    executeTurn(hit, [useMove(1, move('MOVE_POWER_GEM')), null], testDeps(fixedDamage(10)))
    expect(hit.battlers[1]?.mon.status1).toBe(STATUS1_BURN)

    // Negative: roll % 2 === 0
    const miss = battle([{ moves: slot('MOVE_POWER_GEM'), pp: pps, abilities: hasAbility('ABILITY_MOLTEN_COAT') }, {}], scriptedRng([0, 0]))
    executeTurn(miss, [useMove(1, move('MOVE_POWER_GEM')), null], testDeps(fixedDamage(10)))
    expect(miss.battlers[1]?.mon.status1).toBe(0)

    // Negative: non-Rock move (Water Gun) does not burn (Tackle is converted to Rock by Molten Coat's ATE_ABILITY(TYPE_ROCK) at abilities.cc:10323)
    const nonRock = battle([{ moves: slot('MOVE_WATER_GUN'), pp: pps, abilities: hasAbility('ABILITY_MOLTEN_COAT') }, {}], scriptedRng([0, 1]))
    executeTurn(nonRock, [useMove(1, move('MOVE_WATER_GUN')), null], testDeps(fixedDamage(10)))
    expect(nonRock.battlers[1]?.mon.status1).toBe(0)
  })
})
