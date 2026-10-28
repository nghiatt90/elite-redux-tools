/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import {
  DEFAULT_STAT_STAGE,
  STATUS1_BURN,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_SLEEP,
  STATUS2_ESCAPE_PREVENTION,
  STATUS3_GASTRO_ACID,
  STATUS3_PERISH_SONG,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_PSYCHIC_TERRAIN,
  STATUS_FIELD_TERRAIN_PERMANENT,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  WEATHER_FOG_TEMPORARY,
  WEATHER_SUN_PRIMAL,
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

interface Spec {
  spe?: number
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

function battle(specs: Spec[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
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

/** Returns `values` in order, then 0; `calls` counts every draw. */
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

/** MOVEEND_ABILITIES for the defender, called directly so a hook's own conditions can be isolated from the rest of the turn. */
function dispatch(
  state: BattleState,
  moveId: string,
  targetDamage = 20,
  hpDealt = targetDamage,
  grounding: GroundingContext = GROUNDING,
): { unmodelled: string[]; fainted: number[] } {
  const unmodelled: string[] = []
  const fainted: number[] = []
  dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt,
    deps: testDeps(fixedDamage(targetDamage), undefined, grounding),
    unmodelled,
    fainted,
  })
  return { unmodelled, fainted }
}

const extenderGrounding: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => (id === 1 ? 'HOLD_EFFECT_TERRAIN_EXTENDER' : null) }

describe('Cycle 88b - Brain Overload / Power Leak (src/abilities.cc:11645-11655 / 10916-10926, TryChangeBattleTerrain src/battle_util.c:3778-3795)', () => {
  const cases: [string, number, string][] = [
    ['ABILITY_BRAIN_OVERLOAD', STATUS_FIELD_PSYCHIC_TERRAIN, 'Psychic'],
    ['ABILITY_POWER_LEAK', STATUS_FIELD_ELECTRIC_TERRAIN, 'Electric'],
  ]

  for (const [id, flag, name] of cases) {
    it(`${id} starts ${name} Terrain for 8 turns, owned by the holder, on any damaging hit (contact or not)`, () => {
      for (const moveId of ['MOVE_TACKLE', 'MOVE_ARCHER_SHOT']) {
        const s = battle([{}, { abilities: hasAbility(id) }], countingRng())
        dispatch(s, moveId)
        expect(hasFlag(s.field.statuses, flag), moveId).toBe(true)
        expect(s.field.timers.terrainTimer, moveId).toBe(8)
        expect(s.field.timers.terrainBattlerId, moveId).toBe(1)
        expect(s.field.timers.started.terrain, moveId).toBe(true)
      }
    })

    it(`${id} lasts 12 turns when the holder carries Terrain Extender`, () => {
      const s = battle([{}, { abilities: hasAbility(id) }], countingRng())
      dispatch(s, 'MOVE_TACKLE', 20, 20, extenderGrounding)
      expect(s.field.timers.terrainTimer).toBe(12)
    })

    it(`${id} replaces another terrain`, () => {
      const s = battle([{}, { abilities: hasAbility(id) }], countingRng())
      s.field.statuses = STATUS_FIELD_GRASSY_TERRAIN
      dispatch(s, 'MOVE_TACKLE')
      expect(hasFlag(s.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)).toBe(false)
      expect(hasFlag(s.field.statuses, flag)).toBe(true)
    })

    it(`${id} does nothing when ${name} Terrain is already up, when a permanent terrain is up, when the hit did no damage`, () => {
      const already = battle([{}, { abilities: hasAbility(id) }], countingRng())
      already.field.statuses = flag
      already.field.timers.terrainTimer = 3
      already.field.timers.terrainBattlerId = 0
      dispatch(already, 'MOVE_TACKLE')
      expect(already.field.timers.terrainTimer).toBe(3)
      expect(already.field.timers.terrainBattlerId).toBe(0)

      const permanent = battle([{}, { abilities: hasAbility(id) }], countingRng())
      permanent.field.statuses = STATUS_FIELD_TERRAIN_PERMANENT | STATUS_FIELD_GRASSY_TERRAIN
      dispatch(permanent, 'MOVE_TACKLE')
      expect(hasFlag(permanent.field.statuses, flag)).toBe(false)

      const noDamage = battle([{}, { abilities: hasAbility(id) }], countingRng())
      dispatch(noDamage, 'MOVE_TACKLE', 0)
      expect(hasFlag(noDamage.field.statuses, flag)).toBe(false)
    })
  }

  it('runs end to end: a Tackle into a Brain Overload holder leaves Psychic Terrain behind', () => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility('ABILITY_BRAIN_OVERLOAD') }], countingRng())
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(hasFlag(s.field.statuses, STATUS_FIELD_PSYCHIC_TERRAIN)).toBe(true)
  })
})

describe('Cycle 88b - Chilling Pellets, Faraday Cage, Parry, Deflect via UseOutOfTurnAttack (src/battle_util.c:3759-3777)', () => {
  const queueEntry = (ability: string, moveId: string, movePower: number) => ({ ability, move: moveId, attacker: 1, target: 0, movePower })

  it('Chilling Pellets queues Icicle Spear at power 13 on contact (abilities.cc:10700-10708)', () => {
    const s = battle([{}, { abilities: hasAbility('ABILITY_CHILLING_PELLETS') }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toEqual([queueEntry('ABILITY_CHILLING_PELLETS', 'MOVE_ICICLE_SPEAR', 13)])
    expect(s.battlers[1]?.turn.dancerUsedMove).toBe(true)
  })

  it('Faraday Cage queues Thunder Cage at power 50 on contact (abilities.cc:9316-9328)', () => {
    const s = battle([{}, { abilities: hasAbility('ABILITY_FARADAY_CAGE') }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toEqual([queueEntry('ABILITY_FARADAY_CAGE', 'MOVE_THUNDER_CAGE', 50)])
  })

  it('Parry queues Mach Punch at its natural power (movePower 0) on contact (abilities.cc:5031-5040)', () => {
    const s = battle([{}, { abilities: hasAbility('ABILITY_PARRY') }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toEqual([queueEntry('ABILITY_PARRY', 'MOVE_MACH_PUNCH', 0)])
  })

  it('Deflect queues Vacuum Wave at power 20 on any damaging hit, contact or not (abilities.cc:12536-12544)', () => {
    for (const moveId of ['MOVE_TACKLE', 'MOVE_ARCHER_SHOT']) {
      const s = battle([{}, { abilities: hasAbility('ABILITY_DEFLECT') }], countingRng())
      dispatch(s, moveId)
      expect(s.queuedExtraAttacks, moveId).toEqual([queueEntry('ABILITY_DEFLECT', 'MOVE_VACUUM_WAVE', 20)])
    }
  })

  const contactOnly = ['ABILITY_CHILLING_PELLETS', 'ABILITY_FARADAY_CAGE', 'ABILITY_PARRY']
  const all = [...contactOnly, 'ABILITY_DEFLECT']

  it('the contact variants queue nothing for a non-contact move', () => {
    for (const id of contactOnly) {
      const s = battle([{}, { abilities: hasAbility(id) }], countingRng())
      dispatch(s, 'MOVE_ARCHER_SHOT')
      expect(s.queuedExtraAttacks, id).toEqual([])
    }
  })

  it('all four queue nothing without damage, from a sleeping or frozen holder, after the holder already used an out-of-turn move, or when the attacker or holder has fainted', () => {
    for (const id of all) {
      const noDamage = battle([{}, { abilities: hasAbility(id) }], countingRng())
      dispatch(noDamage, 'MOVE_TACKLE', 0)
      expect(noDamage.queuedExtraAttacks, `${id} no damage`).toEqual([])

      const asleep = battle([{}, { abilities: hasAbility(id), status1: STATUS1_SLEEP }], countingRng())
      dispatch(asleep, 'MOVE_TACKLE')
      expect(asleep.queuedExtraAttacks, `${id} asleep`).toEqual([])

      const frozen = battle([{}, { abilities: hasAbility(id), status1: STATUS1_FREEZE }], countingRng())
      dispatch(frozen, 'MOVE_TACKLE')
      expect(frozen.queuedExtraAttacks, `${id} frozen`).toEqual([])

      const dancerUsed = battle([{}, { abilities: hasAbility(id) }], countingRng())
      dancerUsed.battlers[1]!.turn.dancerUsedMove = true
      dispatch(dancerUsed, 'MOVE_TACKLE')
      expect(dancerUsed.queuedExtraAttacks, `${id} dancerUsedMove`).toEqual([])

      const attackerDead = battle([{ hp: 0 }, { abilities: hasAbility(id) }], countingRng())
      dispatch(attackerDead, 'MOVE_TACKLE')
      expect(attackerDead.queuedExtraAttacks, `${id} attacker fainted`).toEqual([])

      const holderDead = battle([{}, { hp: 0, abilities: hasAbility(id) }], countingRng())
      dispatch(holderDead, 'MOVE_TACKLE')
      expect(holderDead.queuedExtraAttacks, `${id} holder fainted`).toEqual([])
    }
  })

  // `hits`: Icicle Spear is EFFECT_MULTI_HIT (2-5 hits); with the all-zero test rng CANCELLER_MULTIHIT_MOVES draws 2 + (0 % 2) + 2 * (0 % 3 == 0) = 4
  // (attackCanceller.ts:612-614), and every hit carries the fixed power.
  const endToEnd = (id: string, expectedMove: string, expectedPower: number, hits = 1) => {
    const s = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility(id), moves: slot('MOVE_TACKLE'), pp: pps }], countingRng())
    const seen: { attacker: number; moveId: string; movePower: number | undefined }[] = []
    const resolver: DamageResolver = {
      resolve: (state, attackerId, _targetId, action) => {
        seen.push({ attacker: attackerId, moveId: action.chosenMove!.id, movePower: state.currentExtraAttack?.movePower })
        return { targetDamage: 20, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
      },
    }
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps(resolver))
    expect(seen, id).toEqual([
      { attacker: 0, moveId: 'MOVE_TACKLE', movePower: undefined },
      ...Array.from({ length: hits }, () => ({ attacker: 1, moveId: expectedMove, movePower: expectedPower })),
    ])
    expect(s.battlers[0]?.mon.hp, id).toBe(100 - 20 * hits)
    expect(s.battlers[1]?.mon.hp, id).toBe(80)
  }

  it('end to end: the queued move runs after the attacker\'s action and reaches the damage resolver with the ability\'s movePower', () => {
    endToEnd('ABILITY_CHILLING_PELLETS', 'MOVE_ICICLE_SPEAR', 13, 4)
    endToEnd('ABILITY_FARADAY_CAGE', 'MOVE_THUNDER_CAGE', 50)
    endToEnd('ABILITY_PARRY', 'MOVE_MACH_PUNCH', 0)
    endToEnd('ABILITY_DEFLECT', 'MOVE_VACUUM_WAVE', 20)
  })
})

describe('Cycle 88b - Fog Machine (src/abilities.cc:10979-10993, TryChangeBattleWeather src/battle_util.c:3721-3743)', () => {
  const holder = { abilities: hasAbility('ABILITY_FOG_MACHINE') }

  it('starts Fog for 8 turns on a damaging hit, contact or not', () => {
    for (const moveId of ['MOVE_TACKLE', 'MOVE_ARCHER_SHOT']) {
      const s = battle([{}, holder], countingRng())
      dispatch(s, moveId)
      expect(hasFlag(s.field.weather, WEATHER_FOG_TEMPORARY), moveId).toBe(true)
      expect(s.field.weatherDuration, moveId).toBe(8)
    }
  })

  it('does nothing when Fog is already up (CHECK_NOT(gBattleWeather & WEATHER_FOG_ANY)): the old timer is kept', () => {
    const s = battle([{}, holder], countingRng())
    s.field.weather = WEATHER_FOG_TEMPORARY
    s.field.weatherDuration = 3
    dispatch(s, 'MOVE_TACKLE')
    expect(s.field.weatherDuration).toBe(3)
  })

  it('is blocked by primal weather (only the popup script runs)', () => {
    const s = battle([{}, holder], countingRng())
    s.field.weather = WEATHER_SUN_PRIMAL
    dispatch(s, 'MOVE_TACKLE')
    expect(s.field.weather).toBe(WEATHER_SUN_PRIMAL)
  })

  it('does nothing when the hit did no damage or the holder fainted (ShouldApplyOnHitEffect(battler))', () => {
    const noDamage = battle([{}, holder], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.field.weather).toBe(0)

    const dead = battle([{}, { hp: 0, ...holder }], countingRng())
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.field.weather).toBe(0)
  })
})

describe('Cycle 88b - Crispy Cream (src/abilities.cc:10838-10842 -> Flame Body :1126-1134 / Freezing Point :6360-6367)', () => {
  const holder = { abilities: hasAbility('ABILITY_CRISPY_CREAM') }

  it('an odd coin is Flame Body: contact burns on a roll below 30, 30 does not', () => {
    const hit = battle([{}, holder], scriptedRng([1, 29]))
    dispatch(hit, 'MOVE_TACKLE')
    expect(hasFlag(hit.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)

    const miss = battle([{}, holder], scriptedRng([1, 30]))
    dispatch(miss, 'MOVE_TACKLE')
    expect(miss.battlers[0]!.mon.status1).toBe(0)
  })

  it('an odd coin without contact uses the 20 chance: 19 burns, 20 does not', () => {
    const hit = battle([{}, holder], scriptedRng([1, 19]))
    dispatch(hit, 'MOVE_ARCHER_SHOT')
    expect(hasFlag(hit.battlers[0]!.mon.status1, STATUS1_BURN)).toBe(true)

    const miss = battle([{}, holder], scriptedRng([1, 20]))
    dispatch(miss, 'MOVE_ARCHER_SHOT')
    expect(miss.battlers[0]!.mon.status1).toBe(0)
  })

  it('an even coin is Freezing Point: contact gives frostbite on a roll below 20, 20 does not', () => {
    const hit = battle([{}, holder], scriptedRng([2, 19]))
    dispatch(hit, 'MOVE_TACKLE')
    expect(hasFlag(hit.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)

    const miss = battle([{}, holder], scriptedRng([2, 20]))
    dispatch(miss, 'MOVE_TACKLE')
    expect(miss.battlers[0]!.mon.status1).toBe(0)
  })

  it('an even coin without contact uses the 30 chance: 29 gives frostbite, 30 does not', () => {
    const hit = battle([{}, holder], scriptedRng([0, 29]))
    dispatch(hit, 'MOVE_ARCHER_SHOT')
    expect(hasFlag(hit.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)

    const miss = battle([{}, holder], scriptedRng([0, 30]))
    dispatch(miss, 'MOVE_ARCHER_SHOT')
    expect(miss.battlers[0]!.mon.status1).toBe(0)
  })

  it('draws the coin first and stops there when the chosen status cannot land (Fire attacker vs Flame Body, Ice attacker vs Freezing Point)', () => {
    const fire = battle([{ types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, holder], scriptedRng([1, 0]))
    dispatch(fire, 'MOVE_TACKLE')
    expect(fire.battlers[0]!.mon.status1).toBe(0)
    expect((fire.rng as ReturnType<typeof scriptedRng>).calls).toBe(1)

    const ice = battle([{ types: ['ICE', 'MYSTERY', 'MYSTERY'] }, holder], scriptedRng([0, 0]))
    dispatch(ice, 'MOVE_TACKLE')
    expect(ice.battlers[0]!.mon.status1).toBe(0)
    expect((ice.rng as ReturnType<typeof scriptedRng>).calls).toBe(1)
  })

  it('does nothing when the attacker already has a status, when the hit did no damage, or when the attacker fainted', () => {
    const statused = battle([{ status1: STATUS1_SLEEP }, holder], scriptedRng([1, 0]))
    dispatch(statused, 'MOVE_TACKLE')
    expect(statused.battlers[0]!.mon.status1).toBe(STATUS1_SLEEP)

    const noDamage = battle([{}, holder], scriptedRng([1, 0]))
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.battlers[0]!.mon.status1).toBe(0)

    const dead = battle([{ hp: 0 }, holder], scriptedRng([1, 0]))
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.battlers[0]!.mon.status1).toBe(0)
  })
})

describe('Cycle 88b - Lingering Aroma (src/abilities.cc:5826-5828 = Mummy :2182-2195)', () => {
  const ability = hasAbility('ABILITY_LINGERING_AROMA')

  it('replaces the attacker\'s ability with Lingering Aroma on contact', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ability }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.abilities.ability).toBe('ABILITY_LINGERING_AROMA')
  })

  it('does nothing when the attacker already has it, has a persistent ability, holds an Ability Shield, or the move made no contact / did no damage / the attacker fainted', () => {
    const already = battle([{ abilities: { ability: 'ABILITY_BLAZE', innates: ['ABILITY_LINGERING_AROMA', null, null] } }, { abilities: ability }], countingRng())
    dispatch(already, 'MOVE_TACKLE')
    expect(already.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const persistent = battle([{ abilities: hasAbility('ABILITY_MULTITYPE') }, { abilities: ability }], countingRng())
    dispatch(persistent, 'MOVE_TACKLE')
    expect(persistent.battlers[0]?.mon.abilities.ability).toBe('ABILITY_MULTITYPE')

    const shield = battle([{ abilities: hasAbility('ABILITY_BLAZE'), itemId: 'ITEM_ABILITY_SHIELD' }, { abilities: ability }], countingRng())
    dispatch(shield, 'MOVE_TACKLE')
    expect(shield.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const noContact = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ability }], countingRng())
    dispatch(noContact, 'MOVE_ARCHER_SHOT')
    expect(noContact.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const noDamage = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ability }], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const dead = battle([{ hp: 0, abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ability }], countingRng())
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })
})

describe('Cycle 88b - Malodor (src/abilities.cc:9853-9864)', () => {
  const holder = { abilities: hasAbility('ABILITY_MALODOR') }

  it('suppresses the attacker\'s ability (Gastro Acid) on contact', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, holder], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(hasFlag(s.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    expect(s.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })

  it('does nothing without contact, without damage, against an Ability Shield holder, or after the attacker fainted', () => {
    const noContact = battle([{}, holder], countingRng())
    dispatch(noContact, 'MOVE_ARCHER_SHOT')
    expect(hasFlag(noContact.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)

    const noDamage = battle([{}, holder], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(hasFlag(noDamage.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)

    const shield = battle([{ itemId: 'ITEM_ABILITY_SHIELD' }, holder], countingRng())
    dispatch(shield, 'MOVE_TACKLE')
    expect(hasFlag(shield.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)

    const dead = battle([{ hp: 0 }, holder], countingRng())
    dispatch(dead, 'MOVE_TACKLE')
    expect(hasFlag(dead.battlers[0]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
  })
})

describe('Cycle 88b - Perish Body (src/abilities.cc:3469-3487)', () => {
  const holder = { abilities: hasAbility('ABILITY_PERISH_BODY') }

  it('starts a 3-turn perish count on both the holder and the attacker on contact', () => {
    const s = battle([{}, holder], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    for (const id of [0, 1]) {
      const b = s.battlers[id]!
      expect(hasFlag(b.statuses3, STATUS3_PERISH_SONG), `battler ${id}`).toBe(true)
      expect(b.volatiles.perishSongTimer, `battler ${id}`).toBe(3)
      expect(b.volatiles.perishSongTimerStartValue, `battler ${id}`).toBe(3)
    }
  })

  it('leaves a perish count the holder already has alone while still starting the attacker\'s', () => {
    const s = battle([{}, holder], countingRng())
    const h = s.battlers[1]!
    h.statuses3 |= STATUS3_PERISH_SONG
    h.volatiles.perishSongTimer = 1
    h.volatiles.perishSongTimerStartValue = 3
    dispatch(s, 'MOVE_TACKLE')
    expect(h.volatiles.perishSongTimer).toBe(1)
    expect(s.battlers[0]!.volatiles.perishSongTimer).toBe(3)
    expect(hasFlag(s.battlers[0]!.statuses3, STATUS3_PERISH_SONG)).toBe(true)
  })

  it('does nothing when the attacker already has a perish count (the holder is not given one either)', () => {
    const s = battle([{}, holder], countingRng())
    s.battlers[0]!.statuses3 |= STATUS3_PERISH_SONG
    s.battlers[0]!.volatiles.perishSongTimer = 2
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]!.volatiles.perishSongTimer).toBe(2)
    expect(hasFlag(s.battlers[1]!.statuses3, STATUS3_PERISH_SONG)).toBe(false)
  })

  it('does nothing without contact, without damage, or once the holder or attacker has fainted', () => {
    const cases: [string, BattleState][] = [
      ['no contact', battle([{}, holder], countingRng())],
      ['no damage', battle([{}, holder], countingRng())],
      ['attacker fainted', battle([{ hp: 0 }, holder], countingRng())],
      ['holder fainted', battle([{}, { hp: 0, ...holder }], countingRng())],
    ]
    dispatch(cases[0]![1], 'MOVE_ARCHER_SHOT')
    dispatch(cases[1]![1], 'MOVE_TACKLE', 0)
    dispatch(cases[2]![1], 'MOVE_TACKLE')
    dispatch(cases[3]![1], 'MOVE_TACKLE')
    for (const [name, s] of cases) {
      expect(hasFlag(s.battlers[0]!.statuses3, STATUS3_PERISH_SONG), name).toBe(false)
      expect(hasFlag(s.battlers[1]!.statuses3, STATUS3_PERISH_SONG), name).toBe(false)
    }
  })
})

describe('Cycle 88b - No Turning Back (src/abilities.cc:8307-8317, BattleScript_NoTurningBack battle_scripts_1.s:1895-1902, VARIOUS_TRY_NO_RETREAT battle_script_commands.c:8126-8133)', () => {
  const holder = (hp: number) => ({ hp, abilities: hasAbility('ABILITY_NO_TURNING_BACK') })
  const stages = (s: BattleState) => [STAT_ATK, STAT_DEF, STAT_SPEED, STAT_SPATK, STAT_SPDEF].map((st) => s.battlers[1]!.mon.statStages[st])

  it('raises all five stats by 1 and sets noRetreat (not the escape-prevention status) when a hit takes the holder from 100 to 40 of 100', () => {
    const s = battle([{}, holder(40)], countingRng())
    dispatch(s, 'MOVE_TACKLE', 60)
    expect(stages(s)).toEqual([DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1])
    expect(s.battlers[1]!.volatiles.noRetreat).toBe(true)
    expect(hasFlag(s.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(false)
    expect(s.battlers[1]!.volatiles.abilityState.some(Boolean)).toBe(true)
  })

  it('triggers on exactly half: 100 -> 50 of 100', () => {
    const s = battle([{}, holder(50)], countingRng())
    dispatch(s, 'MOVE_TACKLE', 50)
    expect(s.battlers[1]!.volatiles.noRetreat).toBe(true)
  })

  it('triggers only once: the second qualifying hit changes nothing', () => {
    const s = battle([{}, holder(40)], countingRng())
    dispatch(s, 'MOVE_TACKLE', 60)
    s.battlers[1]!.volatiles.noRetreat = false
    s.battlers[1]!.mon.hp = 20
    dispatch(s, 'MOVE_TACKLE', 20)
    expect(stages(s)).toEqual([DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1, DEFAULT_STAT_STAGE + 1])
    expect(s.battlers[1]!.volatiles.noRetreat).toBe(false)
  })

  it('does nothing when the hit leaves the holder above half (100 -> 51), starts below half (40 -> 30), the holder fainted, or the hit did no damage', () => {
    const above = battle([{}, holder(51)], countingRng())
    dispatch(above, 'MOVE_TACKLE', 49)
    expect(above.battlers[1]!.volatiles.noRetreat).toBe(false)

    const alreadyBelow = battle([{}, holder(30)], countingRng())
    dispatch(alreadyBelow, 'MOVE_TACKLE', 10)
    expect(alreadyBelow.battlers[1]!.volatiles.noRetreat).toBe(false)

    const dead = battle([{}, holder(0)], countingRng())
    dispatch(dead, 'MOVE_TACKLE', 60)
    expect(dead.battlers[1]!.volatiles.noRetreat).toBe(false)

    const noDamage = battle([{}, holder(40)], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.battlers[1]!.volatiles.noRetreat).toBe(false)
    expect(stages(noDamage)).toEqual([6, 6, 6, 6, 6])
  })

  it('does nothing when the holder is already under No Retreat or escape prevention', () => {
    const noRetreat = battle([{}, holder(40)], countingRng())
    noRetreat.battlers[1]!.volatiles.noRetreat = true
    dispatch(noRetreat, 'MOVE_TACKLE', 60)
    expect(stages(noRetreat)).toEqual([6, 6, 6, 6, 6])

    const trapped = battle([{}, { ...holder(40), status2: STATUS2_ESCAPE_PREVENTION }], countingRng())
    dispatch(trapped, 'MOVE_TACKLE', 60)
    expect(stages(trapped)).toEqual([6, 6, 6, 6, 6])
    expect(trapped.battlers[1]!.volatiles.noRetreat).toBe(false)
  })

  it('still raises the other stats when one is already at +6', () => {
    const s = battle([{}, holder(40)], countingRng())
    s.battlers[1]!.mon.statStages[STAT_ATK] = 12
    dispatch(s, 'MOVE_TACKLE', 60)
    expect(stages(s)).toEqual([12, 7, 7, 7, 7])
  })
})
