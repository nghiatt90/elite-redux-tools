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
import { dispatchMoveEndAttackerAbilities, dispatchMoveEndDefenderAbilities } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import {
  DEFAULT_STAT_STAGE,
  STATUS1_BLEED,
  STATUS1_FREEZE,
  STATUS1_FROSTBITE,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS3_HEAL_BLOCK,
  STAT_SPATK,
  WEATHER_HAIL_PERMANENT,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SUN_PRIMAL,
  hasFlag,
} from './constants'
import { getSingleUseAbilityCounter } from './switchInAbility'

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
          // copied: hooks that swap abilities write into this object, and specs are shared between a test's cases
          abilities: s.abilities ? { ability: s.abilities.ability, innates: [...s.abilities.innates] } : { ability: null, innates: [null, null, null] },
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

describe('Cycle 88c - Freezing Point, defender half (src/abilities.cc:6359-6371, FreezingPointOnEither)', () => {
  const holder = { abilities: hasAbility('ABILITY_FREEZING_POINT') }

  it('contact frostbites the attacker on a roll below 20; 20 does not', () => {
    const hit = battle([{}, holder], scriptedRng([19]))
    dispatch(hit, 'MOVE_TACKLE')
    expect(hasFlag(hit.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)

    const miss = battle([{}, holder], scriptedRng([20]))
    dispatch(miss, 'MOVE_TACKLE')
    expect(miss.battlers[0]!.mon.status1).toBe(0)
  })

  it('a non-contact damaging hit uses the 30 chance: 29 frostbites, 30 does not', () => {
    const hit = battle([{}, holder], scriptedRng([29]))
    dispatch(hit, 'MOVE_ARCHER_SHOT')
    expect(hasFlag(hit.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)

    const miss = battle([{}, holder], scriptedRng([30]))
    dispatch(miss, 'MOVE_ARCHER_SHOT')
    expect(miss.battlers[0]!.mon.status1).toBe(0)
  })

  it('draws nothing when CanGetFrostbite fails (Ice attacker, already statused), the hit did no damage, or the attacker fainted', () => {
    const ice = battle([{ types: ['ICE', 'MYSTERY', 'MYSTERY'] }, holder], scriptedRng([0]))
    dispatch(ice, 'MOVE_TACKLE')
    expect(ice.battlers[0]!.mon.status1).toBe(0)
    expect((ice.rng as ReturnType<typeof scriptedRng>).calls).toBe(0)

    const statused = battle([{ status1: STATUS1_SLEEP }, holder], scriptedRng([0]))
    dispatch(statused, 'MOVE_TACKLE')
    expect(statused.battlers[0]!.mon.status1).toBe(STATUS1_SLEEP)
    expect((statused.rng as ReturnType<typeof scriptedRng>).calls).toBe(0)

    const noDamage = battle([{}, holder], scriptedRng([0]))
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.battlers[0]!.mon.status1).toBe(0)
    expect((noDamage.rng as ReturnType<typeof scriptedRng>).calls).toBe(0)

    const dead = battle([{ hp: 0 }, holder], scriptedRng([0]))
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.battlers[0]!.mon.status1).toBe(0)
    expect((dead.rng as ReturnType<typeof scriptedRng>).calls).toBe(0)
  })

  it('no longer reports the hook as unmodelled', () => {
    const s = battle([{}, holder], scriptedRng([0]))
    expect(dispatch(s, 'MOVE_TACKLE').unmodelled).not.toContain('move-end defender ability ABILITY_FREEZING_POINT is not modelled yet')
  })
})

describe('Cycle 88c - Cryo Proficiency, defender half (src/abilities.cc:6373-6391)', () => {
  const holder = { abilities: hasAbility('ABILITY_CRYO_PROFICIENCY') }

  it('runs the Freezing Point roll first (20 contact / 30 otherwise), then starts Hail for 8 turns', () => {
    const s = battle([{}, holder], scriptedRng([19]))
    dispatch(s, 'MOVE_TACKLE')
    expect(hasFlag(s.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
    expect(hasFlag(s.field.weather, WEATHER_HAIL_TEMPORARY)).toBe(true)
    expect(s.field.weatherDuration).toBe(8)

    const miss = battle([{}, holder], scriptedRng([20]))
    dispatch(miss, 'MOVE_TACKLE')
    expect(miss.battlers[0]!.mon.status1).toBe(0)
    expect(hasFlag(miss.field.weather, WEATHER_HAIL_TEMPORARY)).toBe(true)

    const nonContact = battle([{}, holder], scriptedRng([29]))
    dispatch(nonContact, 'MOVE_ARCHER_SHOT')
    expect(hasFlag(nonContact.battlers[0]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
    expect(hasFlag(nonContact.field.weather, WEATHER_HAIL_TEMPORARY)).toBe(true)
  })

  it('still starts Hail when the attacker cannot be frostbitten (Ice attacker), with no roll drawn', () => {
    const s = battle([{ types: ['ICE', 'MYSTERY', 'MYSTERY'] }, holder], scriptedRng([0]))
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]!.mon.status1).toBe(0)
    expect((s.rng as ReturnType<typeof scriptedRng>).calls).toBe(0)
    expect(hasFlag(s.field.weather, WEATHER_HAIL_TEMPORARY)).toBe(true)
  })

  it('still starts Hail when the attacker has already fainted: ShouldApplyOnHitEffect(battler) is about the holder', () => {
    const s = battle([{ hp: 0 }, holder], scriptedRng([0]))
    dispatch(s, 'MOVE_TACKLE')
    expect(hasFlag(s.field.weather, WEATHER_HAIL_TEMPORARY)).toBe(true)
  })

  it('does not restart Hail when it is already up (the old timer is kept); permanent Hail counts too', () => {
    const up = battle([{}, holder], scriptedRng([99]))
    up.field.weather = WEATHER_HAIL_TEMPORARY
    up.field.weatherDuration = 3
    dispatch(up, 'MOVE_TACKLE')
    expect(up.field.weatherDuration).toBe(3)

    const permanent = battle([{}, holder], scriptedRng([99]))
    permanent.field.weather = WEATHER_HAIL_PERMANENT
    dispatch(permanent, 'MOVE_TACKLE')
    expect(permanent.field.weather).toBe(WEATHER_HAIL_PERMANENT)
  })

  it('is blocked by primal weather (only the popup script runs)', () => {
    const s = battle([{}, holder], scriptedRng([99]))
    s.field.weather = WEATHER_SUN_PRIMAL
    dispatch(s, 'MOVE_TACKLE')
    expect(s.field.weather).toBe(WEATHER_SUN_PRIMAL)
  })

  it('does nothing when the hit did no damage or the holder fainted', () => {
    const noDamage = battle([{}, holder], scriptedRng([0]))
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.field.weather).toBe(0)
    expect(noDamage.battlers[0]!.mon.status1).toBe(0)

    const dead = battle([{}, { hp: 0, ...holder }], scriptedRng([99]))
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.field.weather).toBe(0)
  })
})

describe('Cycle 88c - Resilience (src/abilities.cc:12161-12175, BattleScript_ResilienceActivates battle_scripts_1.s:12582-12589)', () => {
  const holder = (hp: number, extra: Partial<Spec> = {}): Spec => ({ hp, abilities: hasAbility('ABILITY_RESILIENCE'), ...extra })

  it('heals maxHP / 4 when a hit takes the holder from above half to below half: 60 -> 40 of 100 heals to 65', () => {
    const s = battle([{}, holder(40)], countingRng())
    dispatch(s, 'MOVE_TACKLE', 20, 20)
    expect(s.battlers[1]!.mon.hp).toBe(65)
    expect(getSingleUseAbilityCounter(s, 1, 'ABILITY_RESILIENCE', DATA_CONTEXT)).toBe(1)
  })

  it('triggers on exactly half: 70 -> 50 of 100 heals to 75', () => {
    const s = battle([{}, holder(50)], countingRng())
    dispatch(s, 'MOVE_TACKLE', 20, 20)
    expect(s.battlers[1]!.mon.hp).toBe(75)
  })

  it('heals at least 1 HP: a 3 HP holder dropping 2 -> 1 heals to 2', () => {
    const s = battle([{}, holder(1, { maxHp: 3 })], countingRng())
    dispatch(s, 'MOVE_TACKLE', 1, 1)
    expect(s.battlers[1]!.mon.hp).toBe(2)
  })

  it('works once only: the counter blocks the second crossing', () => {
    const s = battle([{}, holder(40)], countingRng())
    dispatch(s, 'MOVE_TACKLE', 20, 20)
    expect(s.battlers[1]!.mon.hp).toBe(65)
    s.battlers[1]!.mon.hp = 40
    dispatch(s, 'MOVE_TACKLE', 20, 20)
    expect(s.battlers[1]!.mon.hp).toBe(40)
  })

  it('does nothing when the hit leaves the holder above half (75 -> 55), starts at or below half (40 -> 30), or the holder fainted', () => {
    const above = battle([{}, holder(55)], countingRng())
    dispatch(above, 'MOVE_TACKLE', 20, 20)
    expect(above.battlers[1]!.mon.hp).toBe(55)

    const alreadyBelow = battle([{}, holder(30)], countingRng())
    dispatch(alreadyBelow, 'MOVE_TACKLE', 10, 10)
    expect(alreadyBelow.battlers[1]!.mon.hp).toBe(30)

    const dead = battle([{}, holder(0)], countingRng())
    dispatch(dead, 'MOVE_TACKLE', 20, 20)
    expect(dead.battlers[1]!.mon.hp).toBe(0)
  })

  it('does nothing without damage, and a blocked heal (Heal Block, CanBattlerHeal) does not spend the single use', () => {
    const noDamage = battle([{}, holder(40)], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0, 0)
    expect(noDamage.battlers[1]!.mon.hp).toBe(40)

    const blocked = battle([{}, holder(40)], countingRng())
    blocked.battlers[1]!.statuses3 = STATUS3_HEAL_BLOCK
    dispatch(blocked, 'MOVE_TACKLE', 20, 20)
    expect(blocked.battlers[1]!.mon.hp).toBe(40)
    expect(getSingleUseAbilityCounter(blocked, 1, 'ABILITY_RESILIENCE', DATA_CONTEXT)).toBe(0)
  })
})

describe('Cycle 88c - Ultra Instinct, Wind Chimes via UseOutOfTurnAttack (src/abilities.cc:8226-8235, 12513-12522; src/battle_util.c:3759-3777)', () => {
  const queueEntry = (ability: string, moveId: string, movePower: number) => ({ ability, move: moveId, attacker: 1, target: 0, movePower })

  it('Ultra Instinct queues Vacuum Wave at power 20 on contact only', () => {
    const s = battle([{}, { abilities: hasAbility('ABILITY_ULTRA_INSTINCT') }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toEqual([queueEntry('ABILITY_ULTRA_INSTINCT', 'MOVE_VACUUM_WAVE', 20)])
    expect(s.battlers[1]?.turn.dancerUsedMove).toBe(true)

    const noContact = battle([{}, { abilities: hasAbility('ABILITY_ULTRA_INSTINCT') }], countingRng())
    dispatch(noContact, 'MOVE_ARCHER_SHOT')
    expect(noContact.queuedExtraAttacks).toEqual([])
  })

  it('Wind Chimes queues Hyper Voice at power 30 on any damaging hit, contact or not', () => {
    for (const moveId of ['MOVE_TACKLE', 'MOVE_ARCHER_SHOT']) {
      const s = battle([{}, { abilities: hasAbility('ABILITY_WIND_CHIMES') }], countingRng())
      dispatch(s, moveId)
      expect(s.queuedExtraAttacks, moveId).toEqual([queueEntry('ABILITY_WIND_CHIMES', 'MOVE_HYPER_VOICE', 30)])
    }
  })

  it('both queue nothing without damage, from a sleeping or frozen holder, after the holder already used an out-of-turn move, or when the attacker or holder has fainted', () => {
    for (const id of ['ABILITY_ULTRA_INSTINCT', 'ABILITY_WIND_CHIMES']) {
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

  it('end to end: the queued move runs after the attacker\'s action and reaches the damage resolver with the ability\'s movePower', () => {
    const cases: [string, string, number][] = [
      ['ABILITY_ULTRA_INSTINCT', 'MOVE_VACUUM_WAVE', 20],
      ['ABILITY_WIND_CHIMES', 'MOVE_HYPER_VOICE', 30],
    ]
    for (const [id, expectedMove, expectedPower] of cases) {
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
        { attacker: 1, moveId: expectedMove, movePower: expectedPower },
      ])
      expect(s.battlers[0]?.mon.hp, id).toBe(80)
      expect(s.battlers[1]?.mon.hp, id).toBe(80)
    }
  })
})

describe('Cycle 88c - Victory Bomb and Unstable Core (src/abilities.cc:9006-9018 and :12525-12528 = Aftermath onDefender :1663-1670)', () => {
  const queueEntry = (ability: string, moveId: string) => ({ ability, move: moveId, attacker: 1, target: 0, movePower: 100 })

  it('Victory Bomb queues Explosion at power 100 when the hit faints the holder, contact or not', () => {
    for (const moveId of ['MOVE_TACKLE', 'MOVE_ARCHER_SHOT']) {
      const s = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_VICTORY_BOMB') }], countingRng())
      dispatch(s, moveId)
      expect(s.queuedExtraAttacks, moveId).toEqual([queueEntry('ABILITY_VICTORY_BOMB', 'MOVE_EXPLOSION')])
    }
  })

  it('Victory Bomb queues even when the attacker fainted too (the hook has no attacker check)', () => {
    const s = battle([{ hp: 0 }, { hp: 0, abilities: hasAbility('ABILITY_VICTORY_BOMB') }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.queuedExtraAttacks).toEqual([queueEntry('ABILITY_VICTORY_BOMB', 'MOVE_EXPLOSION')])
  })

  it('Victory Bomb does nothing while the holder survives, without damage, from a sleeping or frozen holder, or after an out-of-turn move already ran', () => {
    const alive = battle([{}, { hp: 5, abilities: hasAbility('ABILITY_VICTORY_BOMB') }], countingRng())
    dispatch(alive, 'MOVE_TACKLE')
    expect(alive.queuedExtraAttacks).toEqual([])

    const noDamage = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_VICTORY_BOMB') }], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.queuedExtraAttacks).toEqual([])

    for (const status1 of [STATUS1_SLEEP, STATUS1_FREEZE]) {
      const s = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_VICTORY_BOMB'), status1 }], countingRng())
      dispatch(s, 'MOVE_TACKLE')
      expect(s.queuedExtraAttacks, `status ${status1}`).toEqual([])
    }

    const dancerUsed = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_VICTORY_BOMB') }], countingRng())
    dancerUsed.battlers[1]!.turn.dancerUsedMove = true
    dispatch(dancerUsed, 'MOVE_TACKLE')
    expect(dancerUsed.queuedExtraAttacks).toEqual([])
  })

  it('Unstable Core queues Explosion when Attack is the higher attacking stat, and on a tie', () => {
    const higherAtk = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_UNSTABLE_CORE') }], countingRng())
    dispatch(higherAtk, 'MOVE_TACKLE')
    expect(higherAtk.queuedExtraAttacks).toEqual([queueEntry('ABILITY_UNSTABLE_CORE', 'MOVE_EXPLOSION')])

    const tie = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_UNSTABLE_CORE') }], countingRng())
    tie.battlers[1]!.mon.rawStats.spatk = 100
    dispatch(tie, 'MOVE_TACKLE')
    expect(tie.queuedExtraAttacks).toEqual([queueEntry('ABILITY_UNSTABLE_CORE', 'MOVE_EXPLOSION')])
  })

  it('Unstable Core queues Outburst when Sp. Atk is higher, counting stat stages (GetHighestAttackingStatId(battler, TRUE))', () => {
    const raw = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_UNSTABLE_CORE') }], countingRng())
    raw.battlers[1]!.mon.rawStats.spatk = 150
    dispatch(raw, 'MOVE_TACKLE')
    expect(raw.queuedExtraAttacks).toEqual([queueEntry('ABILITY_UNSTABLE_CORE', 'MOVE_OUTBURST')])

    // 80 Sp. Atk at +2 (x2) = 160 > 100 Attack
    const staged = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_UNSTABLE_CORE') }], countingRng())
    staged.battlers[1]!.mon.statStages[STAT_SPATK] = DEFAULT_STAT_STAGE + 2
    dispatch(staged, 'MOVE_TACKLE')
    expect(staged.queuedExtraAttacks).toEqual([queueEntry('ABILITY_UNSTABLE_CORE', 'MOVE_OUTBURST')])
  })

  it('Unstable Core does nothing while the holder survives or without damage', () => {
    const alive = battle([{}, { hp: 5, abilities: hasAbility('ABILITY_UNSTABLE_CORE') }], countingRng())
    dispatch(alive, 'MOVE_TACKLE')
    expect(alive.queuedExtraAttacks).toEqual([])

    const noDamage = battle([{}, { hp: 0, abilities: hasAbility('ABILITY_UNSTABLE_CORE') }], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.queuedExtraAttacks).toEqual([])
  })

  it('end to end: Tackle faints a Victory Bomb holder and the fainted holder\'s Explosion still reaches the damage resolver at power 100', () => {
    const s = battle(
      [
        { moves: slot('MOVE_TACKLE'), pp: pps },
        { hp: 10, abilities: hasAbility('ABILITY_VICTORY_BOMB'), moves: slot('MOVE_TACKLE'), pp: pps },
      ],
      countingRng(),
    )
    const seen: { attacker: number; moveId: string; movePower: number | undefined }[] = []
    const resolver: DamageResolver = {
      resolve: (state, attackerId, _targetId, action) => {
        seen.push({ attacker: attackerId, moveId: action.chosenMove!.id, movePower: state.currentExtraAttack?.movePower })
        return { targetDamage: 20, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
      },
    }
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps(resolver))
    expect(seen).toEqual([
      { attacker: 0, moveId: 'MOVE_TACKLE', movePower: undefined },
      { attacker: 1, moveId: 'MOVE_EXPLOSION', movePower: 100 },
    ])
    expect(s.battlers[0]?.mon.hp).toBe(80)
    expect(s.battlers[1]?.mon.hp).toBe(0)
  })
})

describe('Cycle 88c - Wandering Spirit (src/abilities.cc:3490-3515, BattleScript_WanderingSpiritActivates battle_scripts_1.s:10242-10248)', () => {
  const ws = hasAbility('ABILITY_WANDERING_SPIRIT')

  it('swaps abilities with a contact attacker', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ws }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.abilities.ability).toBe('ABILITY_WANDERING_SPIRIT')
    expect(s.battlers[1]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })

  it('swaps even when the holder fainted: the hook only requires ShouldApplyOnHitEffect(attacker)', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { hp: 0, abilities: ws }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.abilities.ability).toBe('ABILITY_WANDERING_SPIRIT')
    expect(s.battlers[1]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })

  it('runs switch-in abilities for both mons afterwards: the holder\'s new Drizzle starts rain (its switch-in flag was clear)', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_DRIZZLE') }, { abilities: ws }], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[1]?.mon.abilities.ability).toBe('ABILITY_DRIZZLE')
    expect(hasFlag(s.field.weather, WEATHER_RAIN_TEMPORARY)).toBe(true)
  })

  it('ports the identity UpdateAbilityStateIndicesForNewAbility calls as written: a set slot-0 switch-in flag carries over, so Drizzle does not fire again', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_DRIZZLE') }, { abilities: ws }], countingRng())
    s.battlers[1]!.volatiles.switchInAbilityDone[0] = true
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[1]?.mon.abilities.ability).toBe('ABILITY_DRIZZLE')
    expect(s.field.weather).toBe(0)
  })

  it('does nothing for an innate Wandering Spirit (GetBattlerAbility(battler) must equal the ability)', () => {
    const s = battle(
      [{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: { ability: 'ABILITY_OVERGROW', innates: ['ABILITY_WANDERING_SPIRIT', null, null] } }],
      countingRng(),
    )
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
    expect(s.battlers[1]?.mon.abilities.ability).toBe('ABILITY_OVERGROW')
  })

  it('does nothing when the attacker already has Wandering Spirit in any slot, has a persistent ability, or holds an Ability Shield', () => {
    const already = battle([{ abilities: { ability: 'ABILITY_BLAZE', innates: ['ABILITY_WANDERING_SPIRIT', null, null] } }, { abilities: ws }], countingRng())
    dispatch(already, 'MOVE_TACKLE')
    expect(already.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
    expect(already.battlers[1]?.mon.abilities.ability).toBe('ABILITY_WANDERING_SPIRIT')

    const persistent = battle([{ abilities: hasAbility('ABILITY_MULTITYPE') }, { abilities: ws }], countingRng())
    dispatch(persistent, 'MOVE_TACKLE')
    expect(persistent.battlers[0]?.mon.abilities.ability).toBe('ABILITY_MULTITYPE')
    expect(persistent.battlers[1]?.mon.abilities.ability).toBe('ABILITY_WANDERING_SPIRIT')

    const shield = battle([{ abilities: hasAbility('ABILITY_BLAZE'), itemId: 'ITEM_ABILITY_SHIELD' }, { abilities: ws }], countingRng())
    dispatch(shield, 'MOVE_TACKLE')
    expect(shield.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
    expect(shield.battlers[1]?.mon.abilities.ability).toBe('ABILITY_WANDERING_SPIRIT')
  })

  it('does nothing without contact, without damage, or when the attacker fainted', () => {
    const noContact = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ws }], countingRng())
    dispatch(noContact, 'MOVE_ARCHER_SHOT')
    expect(noContact.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const noDamage = battle([{ abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ws }], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')

    const dead = battle([{ hp: 0, abilities: hasAbility('ABILITY_BLAZE') }, { abilities: ws }], countingRng())
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.battlers[0]?.mon.abilities.ability).toBe('ABILITY_BLAZE')
  })
})

/** MOVEEND_ABILITIES_ATTACKER, called directly: battler 0 is the holder and attacker, battler 1 the target. */
function dispatchAtk(state: BattleState, moveId: string, targetDamage = 20): { unmodelled: string[] } {
  const unmodelled: string[] = []
  dispatchMoveEndAttackerAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { unmodelled }
}

const drawn = (s: BattleState) => (s.rng as ReturnType<typeof scriptedRng>).calls

describe('Cycle 88c - Spike Armor / Fragrant Daze / Hypnotic Touch (ON_EITHER, src/abilities.cc:6798-6806, 7792-7800, 11267-11275)', () => {
  const cases: { id: string; chance: number; landed: (s: BattleState, who: number) => boolean; blocked: Spec; name: string }[] = [
    { id: 'ABILITY_SPIKE_ARMOR', chance: 30, landed: (s, w) => hasFlag(s.battlers[w]!.mon.status1, STATUS1_BLEED), blocked: { types: ['ROCK', 'MYSTERY', 'MYSTERY'] }, name: 'Rock type' },
    { id: 'ABILITY_FRAGRANT_DAZE', chance: 30, landed: (s, w) => hasFlag(s.battlers[w]!.mon.status2, STATUS2_CONFUSION), blocked: { status2: 1 }, name: 'already confused' },    { id: 'ABILITY_HYPNOTIC_TOUCH', chance: 20, landed: (s, w) => hasFlag(s.battlers[w]!.mon.status1, STATUS1_SLEEP), blocked: { status1: STATUS1_FROSTBITE }, name: 'already statused' },
  ]

  for (const c of cases) {
    const holder = () => ({ abilities: hasAbility(c.id) })

    it(`${c.id} defender: contact hit lands the status on the attacker below ${c.chance}, not at ${c.chance}`, () => {
      const hit = battle([{}, holder()], scriptedRng([c.chance - 1]))
      dispatch(hit, 'MOVE_TACKLE')
      expect(c.landed(hit, 0)).toBe(true)
      expect(c.landed(hit, 1)).toBe(false)

      const miss = battle([{}, holder()], scriptedRng([c.chance]))
      dispatch(miss, 'MOVE_TACKLE')
      expect(c.landed(miss, 0)).toBe(false)
      expect(drawn(miss)).toBe(1)
    })

    it(`${c.id} defender: needs contact, damage and a living attacker, and CanX (${c.name}); none of those draw the roll`, () => {
      const noContact = battle([{}, holder()], scriptedRng([0]))
      dispatch(noContact, 'MOVE_ARCHER_SHOT')
      expect(c.landed(noContact, 0)).toBe(false)
      expect(drawn(noContact)).toBe(0)

      const noDamage = battle([{}, holder()], scriptedRng([0]))
      dispatch(noDamage, 'MOVE_TACKLE', 0)
      expect(c.landed(noDamage, 0)).toBe(false)
      expect(drawn(noDamage)).toBe(0)

      const dead = battle([{ hp: 0 }, holder()], scriptedRng([0]))
      dispatch(dead, 'MOVE_TACKLE')
      expect(c.landed(dead, 0)).toBe(false)
      expect(drawn(dead)).toBe(0)

      const blocked = battle([c.blocked, holder()], scriptedRng([0]))
      const before = { s1: blocked.battlers[0]!.mon.status1, s2: blocked.battlers[0]!.mon.status2, types: [...blocked.battlers[0]!.mon.types] }
      dispatch(blocked, 'MOVE_TACKLE')
      expect({ s1: blocked.battlers[0]!.mon.status1, s2: blocked.battlers[0]!.mon.status2, types: blocked.battlers[0]!.mon.types }).toEqual(before)
      expect(drawn(blocked)).toBe(0)
    })

    it(`${c.id} attacker: the holder's own contact hit lands the status on the target below ${c.chance}, not at ${c.chance}`, () => {
      const hit = battle([holder(), {}], scriptedRng([c.chance - 1]))
      dispatchAtk(hit, 'MOVE_TACKLE')
      expect(c.landed(hit, 1)).toBe(true)
      expect(c.landed(hit, 0)).toBe(false)

      const miss = battle([holder(), {}], scriptedRng([c.chance]))
      dispatchAtk(miss, 'MOVE_TACKLE')
      expect(c.landed(miss, 1)).toBe(false)
      expect(drawn(miss)).toBe(1)
    })

    it(`${c.id} attacker: needs contact, damage and a living target, and CanX (${c.name}); none of those draw the roll`, () => {
      const noContact = battle([holder(), {}], scriptedRng([0]))
      dispatchAtk(noContact, 'MOVE_ARCHER_SHOT')
      expect(c.landed(noContact, 1)).toBe(false)
      expect(drawn(noContact)).toBe(0)

      const noDamage = battle([holder(), {}], scriptedRng([0]))
      dispatchAtk(noDamage, 'MOVE_TACKLE', 0)
      expect(c.landed(noDamage, 1)).toBe(false)
      expect(drawn(noDamage)).toBe(0)

      const dead = battle([holder(), { hp: 0 }], scriptedRng([0]))
      dispatchAtk(dead, 'MOVE_TACKLE')
      expect(c.landed(dead, 1)).toBe(false)
      expect(drawn(dead)).toBe(0)

      const blocked = battle([holder(), c.blocked], scriptedRng([0]))
      const before = { s1: blocked.battlers[1]!.mon.status1, s2: blocked.battlers[1]!.mon.status2, types: [...blocked.battlers[1]!.mon.types] }
      dispatchAtk(blocked, 'MOVE_TACKLE')
      expect({ s1: blocked.battlers[1]!.mon.status1, s2: blocked.battlers[1]!.mon.status2, types: blocked.battlers[1]!.mon.types }).toEqual(before)
      expect(drawn(blocked)).toBe(0)
    })
  }
})

describe('Cycle 88c - Magical Dust (ON_EITHER, src/abilities.cc:3990-4003)', () => {
  const holder = () => ({ abilities: hasAbility('ABILITY_MAGICAL_DUST') })
  const PSYCHIC: [string, string, string] = ['PSYCHIC', 'PSYCHIC', 'MYSTERY']

  it('defender: a contact hit makes the attacker pure Psychic (type1 = type2 = Psychic, type3 Mystery)', () => {
    const s = battle([{ types: ['FIRE', 'FLYING', 'GROUND'] }, holder()], countingRng())
    dispatch(s, 'MOVE_TACKLE')
    expect(s.battlers[0]!.mon.types).toEqual(PSYCHIC)
    expect(s.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
  })

  it('defender: does nothing without contact or damage, for a fainted attacker, or an attacker already Psychic (any of the three type slots)', () => {
    const base: [string, string, string] = ['NORMAL', 'MYSTERY', 'MYSTERY']
    const noContact = battle([{}, holder()], countingRng())
    dispatch(noContact, 'MOVE_ARCHER_SHOT')
    expect(noContact.battlers[0]!.mon.types).toEqual(base)

    const noDamage = battle([{}, holder()], countingRng())
    dispatch(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.battlers[0]!.mon.types).toEqual(base)

    const dead = battle([{ hp: 0 }, holder()], countingRng())
    dispatch(dead, 'MOVE_TACKLE')
    expect(dead.battlers[0]!.mon.types).toEqual(base)

    const third: [string, string, string] = ['NORMAL', 'MYSTERY', 'PSYCHIC']
    const alreadyThird = battle([{ types: third }, holder()], countingRng())
    dispatch(alreadyThird, 'MOVE_TACKLE')
    expect(alreadyThird.battlers[0]!.mon.types).toEqual(third)
  })

  it('attacker: the holder\'s contact hit makes the target pure Psychic; nothing without contact, damage, a living target, or when already Psychic', () => {
    const s = battle([holder(), { types: ['FIRE', 'FLYING', 'GROUND'] }], countingRng())
    dispatchAtk(s, 'MOVE_TACKLE')
    expect(s.battlers[1]!.mon.types).toEqual(PSYCHIC)
    expect(s.battlers[0]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])

    const base: [string, string, string] = ['NORMAL', 'MYSTERY', 'MYSTERY']
    const noContact = battle([holder(), {}], countingRng())
    dispatchAtk(noContact, 'MOVE_ARCHER_SHOT')
    expect(noContact.battlers[1]!.mon.types).toEqual(base)

    const noDamage = battle([holder(), {}], countingRng())
    dispatchAtk(noDamage, 'MOVE_TACKLE', 0)
    expect(noDamage.battlers[1]!.mon.types).toEqual(base)

    const dead = battle([holder(), { hp: 0 }], countingRng())
    dispatchAtk(dead, 'MOVE_TACKLE')
    expect(dead.battlers[1]!.mon.types).toEqual(base)

    const psychic = battle([holder(), { types: ['PSYCHIC', 'MYSTERY', 'MYSTERY'] }], countingRng())
    dispatchAtk(psychic, 'MOVE_TACKLE')
    expect(psychic.battlers[1]!.mon.types).toEqual(['PSYCHIC', 'MYSTERY', 'MYSTERY'])
  })
})

describe('Cycle 88c - Cryo Proficiency, attacker half (src/abilities.cc:6388 = Impl<ABILITY_FREEZING_POINT>.onAttacker)', () => {
  it('the holder\'s contact hit frostbites the target below 20, a non-contact hit below 30', () => {
    const hit = battle([{ abilities: hasAbility('ABILITY_CRYO_PROFICIENCY') }, {}], scriptedRng([19]))
    dispatchAtk(hit, 'MOVE_TACKLE')
    expect(hasFlag(hit.battlers[1]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)

    const miss = battle([{ abilities: hasAbility('ABILITY_CRYO_PROFICIENCY') }, {}], scriptedRng([20]))
    dispatchAtk(miss, 'MOVE_TACKLE')
    expect(miss.battlers[1]!.mon.status1).toBe(0)

    const nonContact = battle([{ abilities: hasAbility('ABILITY_CRYO_PROFICIENCY') }, {}], scriptedRng([29]))
    dispatchAtk(nonContact, 'MOVE_ARCHER_SHOT')
    expect(hasFlag(nonContact.battlers[1]!.mon.status1, STATUS1_FROSTBITE)).toBe(true)
  })

  it('does not start Hail when attacking (the hail half is defender-only)', () => {
    const s = battle([{ abilities: hasAbility('ABILITY_CRYO_PROFICIENCY') }, {}], scriptedRng([19]))
    dispatchAtk(s, 'MOVE_TACKLE')
    expect(s.field.weather).toBe(0)
  })
})
