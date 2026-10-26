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
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { TypeChart } from '../typeEffectiveness'
import {
  BATTLE_EVENTS_MAX_REGISTERABLE,
  BATTLE_TYPE_DOUBLE,
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_LUCKY_CHANT,
  SIDE_STATUS_MAT_BLOCK,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TOXIC_SPIKES,
  SIDE_STATUS_WIDE_GUARD,
  STAT_ACC,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_NONE,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_POISON,
  STATUS2_SUBSTITUTE,
  STATUS3_EMBARGO,
  STATUS3_HEAL_BLOCK,
  STATUS3_LEECHSEED,
  STATUS3_MAGNET_RISE,
  STATUS4_FORESIGHT,
  hasFlag,
} from './constants'
import {
  affectNStatusOnTeamFromLastToFirst,
  depleteTeamPowerPointOfMove,
  hasNumberOfTurnsStayedReached,
  isBattleEventForbiddenOnSwitchIn,
  registerBattleEvent,
  runBattleEvents,
  setSubstituteBattleEvent,
  unregisterBattlesEvents,
  unregisterCurrentBattleEvent,
} from './battleEvents'
import { eventsForFight } from './driver/battleEventSetup'
import { createSession, stepTurn } from './driver/session'
import { loadSimData } from './driver/loadSimData'
import { buildPlayerParty } from './driver/buildParty'
import { createRandomSource } from './rng'

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
    pp: m.pp as number,
  }
}

const MOVE_TACKLE = requireMove('MOVE_TACKLE')

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

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
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
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
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
  playerPartyOverrides?: SimPartyMon[],
  opponentPartyOverrides?: SimPartyMon[],
): BattleState {
  const pParty = playerPartyOverrides ?? specs.slice(0, 1).map((s) => partyMon({ hp: s.hp ?? 100, maxHp: s.maxHp ?? 100 }))
  const oParty = opponentPartyOverrides ?? specs.slice(1, 2).map((s) => partyMon({ hp: s.hp ?? 100, maxHp: s.maxHp ?? 100 }))

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
          pp: s.pp ?? [35, 0, 0, 0],
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        i === 0 ? 0 : 0,
      ),
    ),
    rng,
    playerParty: pParty,
    opponentParty: oParty,
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

function dummyDamage(): DamageResolver & { calls: number } {
  const r = {
    calls: 0,
    resolve: () => {
      r.calls++
      return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
    },
  }
  return r
}

function testDeps(damage: DamageResolver = dummyDamage()): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

function pickMoveAction(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power ?? 0,
    flags: move.flags ?? {},
    split: move.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

describe('Battle event helper functions', () => {
  it('isBattleEventForbiddenOnSwitchIn returns true for STEADY_* events and false for others', () => {
    expect(isBattleEventForbiddenOnSwitchIn('BATTLE_EVENT_STEADY_OFFENSE')).toBe(true)
    expect(isBattleEventForbiddenOnSwitchIn('BATTLE_EVENT_STEADY_SPEED')).toBe(true)
    expect(isBattleEventForbiddenOnSwitchIn('BATTLE_EVENT_SPIKES')).toBe(false)
  })

  it('affectNStatusOnTeamFromLastToFirst skips slot 0 and stops when n exhausted', () => {
    const party = [partyMon(), partyMon(), partyMon()]
    const state = battle([{}, {}], countingRng(), party)
    const affected = affectNStatusOnTeamFromLastToFirst(state, STATUS1_PARALYSIS, 1)
    expect(affected).toBe(true)
    expect(state.sides[0].party[2]!.status1).toBe(STATUS1_PARALYSIS)
    expect(state.sides[0].party[1]!.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].party[0]!.status1).toBe(STATUS1_NONE)
  })

  it('hasNumberOfTurnsStayedReached resets data1 on isFirstTurn and increments on non-first turn', () => {
    const state = battle([{}, {}], countingRng())
    const event = { id: 'TEST', data0: 2, data1: 1 }
    state.battlers[0]!.volatiles.isFirstTurn = 1
    expect(hasNumberOfTurnsStayedReached(state, event, 0)).toBe(false)
    expect(event.data1).toBe(0)

    state.battlers[0]!.volatiles.isFirstTurn = 0
    expect(hasNumberOfTurnsStayedReached(state, event, 0)).toBe(false)
    expect(event.data1).toBe(1)
    expect(hasNumberOfTurnsStayedReached(state, event, 0)).toBe(true)
    expect(event.data1).toBe(2)
  })

  it('setSubstituteBattleEvent sets SUBSTITUTE status and substituteHp', () => {
    const state = battle([{}, { hp: 120, maxHp: 120 }], countingRng())
    setSubstituteBattleEvent(state, 1)
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)
    expect(state.battlers[1]!.volatiles.substituteHp).toBe(30)
  })

  it('depleteTeamPowerPointOfMove zeroes pp of target move across party and battlers', () => {
    const party = [partyMon({ moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] })]
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }, {}], countingRng(), party)
    expect(depleteTeamPowerPointOfMove(state, 'MOVE_TACKLE')).toBe(true)
    expect(state.sides[0].party[0]!.pp[0]).toBe(0)
    expect(state.battlers[0]!.mon.pp[0]).toBe(0)
  })
})

describe('Battle events state & registration semantics', () => {
  it('registers up to 16 events, bitmasks data0 and data1 with 0xF, and ignores excess (RegisterBattleEvent, battle_events.c:27-40)', () => {
    const state = battle([{}, {}], countingRng())
    expect(state.battleEvents).toEqual([])

    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_OFFENSE', 0x14, 0x25)
    expect(state.battleEvents.length).toBe(1)
    expect(state.battleEvents[0]).toEqual({
      id: 'BATTLE_EVENT_POSTURE_OFFENSE',
      data0: 4, // 0x14 & 0xF = 4
      data1: 5, // 0x25 & 0xF = 5
    })

    // Fill to BATTLE_EVENTS_MAX_REGISTERABLE (16)
    for (let i = 1; i < BATTLE_EVENTS_MAX_REGISTERABLE; i++) {
      registerBattleEvent(state, `EVENT_${i}`, i, 0)
    }
    expect(state.battleEvents.length).toBe(16)

    // 17th registration is ignored
    registerBattleEvent(state, 'EVENT_OVERFLOW', 1, 1)
    expect(state.battleEvents.length).toBe(16)
  })

  it('unregisterBattlesEvents clears all events and resets cursor (battle_events.c:43-46)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'EVENT_1', 1, 0)
    registerBattleEvent(state, 'EVENT_2', 2, 0)
    state.currentBattleEvent = 1

    unregisterBattlesEvents(state)
    expect(state.battleEvents).toEqual([])
    expect(state.currentBattleEvent).toBe(0)
  })

  it('unregisterCurrentBattleEvent swap-removes with last element and steps cursor back (battle_events.c:54-58)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'EVENT_A', 1, 0)
    registerBattleEvent(state, 'EVENT_B', 2, 0)
    registerBattleEvent(state, 'EVENT_C', 3, 0)

    // Cursor at index 0 (EVENT_A)
    state.currentBattleEvent = 0
    unregisterCurrentBattleEvent(state)

    // Length is now 2; slot 0 was replaced by EVENT_C, cursor stepped back to -1
    expect(state.battleEvents.length).toBe(2)
    expect(state.battleEvents[0]!.id).toBe('EVENT_C')
    expect(state.battleEvents[1]!.id).toBe('EVENT_B')
    expect(state.currentBattleEvent).toBe(-1)
  })
})

describe('Battle events BeforeFirstTurn (turn 0) ports', () => {
  it('POSTURE_OFFENSE, DEFENSE, SPECIAL, SPDEF, SPEED boost extra*Level and unregister (battle_events.c:201-240)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_OFFENSE', 3, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_DEFENSE', 0, 0) // data0 == 0 defaults to 4
    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_SPECIAL', 2, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_SPDEF', 5, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_SPEED', 1, 0)

    runBattleEvents(state)

    const opp = state.battlers[1]!
    expect(opp.volatiles.extraAttackLevel).toBe(3)
    expect(opp.volatiles.extraDefenseLevel).toBe(4) // defaulted to 4
    expect(opp.volatiles.extraSpAttackLevel).toBe(2)
    expect(opp.volatiles.extraSpDefenseLevel).toBe(5)
    expect(opp.volatiles.extraSpeedLevel).toBe(1)
    expect(state.battleEvents).toEqual([]) // all unregister
  })

  it('POSTURE events boost both opponents in double battles (battle_events.c:188-191)', () => {
    const state = battle([{}, {}, {}, {}], countingRng())
    state.battleTypeFlags |= BATTLE_TYPE_DOUBLE
    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_SPEED', 2, 0)

    runBattleEvents(state)

    expect(state.battlers[1]!.volatiles.extraSpeedLevel).toBe(2)
    expect(state.battlers[3]!.volatiles.extraSpeedLevel).toBe(2)
  })

  it('POSTURE_ACCURACY is a no-op in C and does not unregister (battle_events.c:241-249)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_ACCURACY', 4, 0)

    runBattleEvents(state)
    expect(state.battleEvents.length).toBe(1)
    expect(state.battleEvents[0]!.id).toBe('BATTLE_EVENT_POSTURE_ACCURACY')
  })

  it('POSTURE_CRIT unregisters with no state mutation (battle_events.c:250-253)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_POSTURE_CRIT', 0, 0)

    runBattleEvents(state)
    expect(state.battleEvents).toEqual([])
  })

  it('LAST status events affect reserve player party mons from last to slot 1 and unregister (battle_events.c:254-282)', () => {
    const party = [
      partyMon(), // slot 0 (active lead - untouched)
      partyMon(), // slot 1
      partyMon(), // slot 2
      partyMon(), // slot 3
    ]
    const state = battle([{}, {}], countingRng(), party)
    registerBattleEvent(state, 'BATTLE_EVENT_LAST_PARALYZED', 2, 0) // affect 2 from last

    runBattleEvents(state)

    expect(state.sides[0].party[0]!.status1).toBe(STATUS1_NONE) // lead untouched
    expect(state.sides[0].party[1]!.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].party[2]!.status1).toBe(STATUS1_PARALYSIS)
    expect(state.sides[0].party[3]!.status1).toBe(STATUS1_PARALYSIS)
    expect(state.battleEvents).toEqual([])
  })

  it('LAST_BURNED, LAST_SLEEP, LAST_FROSTBITE, LAST_BLEED, LAST_TOXIC set correct status flags', () => {
    const testCases: [string, number][] = [
      ['BATTLE_EVENT_LAST_BURNED', STATUS1_BURN],
      ['BATTLE_EVENT_LAST_SLEEP', STATUS1_SLEEP],
      ['BATTLE_EVENT_LAST_FROSTBITE', STATUS1_FROSTBITE],
      ['BATTLE_EVENT_LAST_BLEED', STATUS1_BLEED],
      ['BATTLE_EVENT_LAST_TOXIC', STATUS1_TOXIC_POISON],
      ['BATTLE_EVENT_LAST_POISONED', STATUS1_POISON],
    ]

    for (const [event, expectedStatus] of testCases) {
      const party = [partyMon(), partyMon()]
      const state = battle([{}, {}], countingRng(), party)
      registerBattleEvent(state, event, 1, 0)
      runBattleEvents(state)
      expect(state.sides[0].party[1]!.status1).toBe(expectedStatus)
      expect(state.battleEvents).toEqual([])
    }
  })

  it('STEALTH_ROCK sets SIDE_STATUS_STEALTH_ROCK and stealthRockType = 5 (TYPE_ROCK_ID) (battle_events.c:283-286)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_STEALTH_ROCK', 0, 0)

    runBattleEvents(state)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(state.sides[0].timers.stealthRockType).toBe(5)
    expect(state.battleEvents).toEqual([])
  })

  it('SPIKES sets SIDE_STATUS_SPIKES and spikesAmount = data0 & 3 (battle_events.c:291-294)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_SPIKES', 2, 0)

    runBattleEvents(state)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(state.sides[0].timers.spikesAmount).toBe(2)
    expect(state.battleEvents).toEqual([])
  })

  it('TOXIC_SPIKES sets SIDE_STATUS_TOXIC_SPIKES and toxicSpikesAmount = 2 (battle_events.c:287-290)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_TOXIC_SPIKES', 0, 0)

    runBattleEvents(state)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(true)
    expect(state.sides[0].timers.toxicSpikesAmount).toBe(2)
    expect(state.battleEvents).toEqual([])
  })

  it('EMBARGO sets STATUS3_EMBARGO and embargoTimer on player lead (battle_events.c:295-303)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_EMBARGO', 5, 0)

    runBattleEvents(state)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_EMBARGO)).toBe(true)
    expect(state.battlers[0]!.volatiles.embargoTimer).toBe(5)
    expect(state.battleEvents).toEqual([])
  })

  it('REFLECT, LIGHTSCREEN, LUCKY_CHANT set opponent side statuses and timers (battle_events.c:304-318)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_REFLECT', 5, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_LIGHTSCREEN', 5, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_LUCKY_CHANT', 5, 0)

    runBattleEvents(state)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(true)
    expect(state.sides[1].timers.reflectTimer).toBe(5)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(true)
    expect(state.sides[1].timers.lightscreenTimer).toBe(5)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_LUCKY_CHANT)).toBe(true)
    expect(state.sides[1].timers.luckyChantTimer).toBe(5)
    expect(state.battleEvents).toEqual([])
  })

  it('PERMA_WIDE_GUARD and PERMA_STICKY_WEB set status and do NOT unregister (battle_events.c:320-329)', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_PERMA_WIDE_GUARD', 0, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_PERMA_STICKY_WEB', 0, 0)

    runBattleEvents(state)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_WIDE_GUARD)).toBe(true)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
    // Both remain registered!
    expect(state.battleEvents.length).toBe(2)
  })

  it('NO_PROTECT depletes PP of MOVE_PROTECT across party and active battlers and unregisters (battle_events.c:330-333, 167-185)', () => {
    const party = [
      partyMon({ moves: ['MOVE_PROTECT', null, null, null], pp: [10, 0, 0, 0] }),
      partyMon({ moves: ['MOVE_TACKLE', 'MOVE_PROTECT', null, null], pp: [35, 10, 0, 0] }),
    ]
    const state = battle([{ moves: ['MOVE_PROTECT', null, null, null], pp: [10, 0, 0, 0] }, {}], countingRng(), party)
    registerBattleEvent(state, 'BATTLE_EVENT_NO_PROTECT', 0, 0)

    runBattleEvents(state)
    expect(state.sides[0].party[0]!.pp[0]).toBe(0)
    expect(state.sides[0].party[1]!.pp[1]).toBe(0)
    expect(state.battlers[0]!.mon.pp[0]).toBe(0)
    expect(state.battleEvents).toEqual([])
  })

  it('NO_PROTECT does not unregister when no party mon has MOVE_PROTECT', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_NO_PROTECT', 0, 0)

    runBattleEvents(state)
    expect(state.battleEvents.length).toBe(1)
  })
})

describe('Battle events StartTurn (turn > 0) ports', () => {
  it('STEADY_* events are blocked on switch-in turn (isFirstTurn == 1) (battle_events.c:375)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    state.battlers[1]!.volatiles.isFirstTurn = 1
    registerBattleEvent(state, 'BATTLE_EVENT_STEADY_OFFENSE', 0, 0)

    runBattleEvents(state)
    // No stat change while isFirstTurn == 1
    expect(state.battlers[1]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    // Remains registered
    expect(state.battleEvents.length).toBe(1)
  })

  it('STEADY_* events boost stats by +1 on turns where isFirstTurn == 0 and do not unregister (battle_events.c:379-397)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    state.battlers[1]!.volatiles.isFirstTurn = 0
    registerBattleEvent(state, 'BATTLE_EVENT_STEADY_OFFENSE', 0, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_STEADY_DEFENSE', 0, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_STEADY_SPECIAL', 0, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_STEADY_SPDEF', 0, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_STEADY_SPEED', 0, 0)
    registerBattleEvent(state, 'BATTLE_EVENT_STEADY_ACCURACY', 0, 0)

    runBattleEvents(state)

    const opp = state.battlers[1]!
    expect(opp.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(opp.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(opp.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(opp.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(opp.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(opp.mon.statStages[STAT_ACC]).toBe(DEFAULT_STAT_STAGE + 1)
    // None unregister
    expect(state.battleEvents.length).toBe(6)
  })

  it('ONSWITCH_MAT_BLOCK sets SIDE_STATUS_MAT_BLOCK on switch-in, decrements count, and unregisters when data0 <= 1 (battle_events.c:402-414)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    state.battlers[1]!.volatiles.isFirstTurn = 1
    // data0 = 2 uses
    registerBattleEvent(state, 'BATTLE_EVENT_ONSWITCH_MAT_BLOCK', 2, 0)

    // First switch-in: data0 becomes 1, data1 = 1, does NOT unregister
    runBattleEvents(state)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_MAT_BLOCK)).toBe(true)
    expect(state.battleEvents.length).toBe(1)
    expect(state.battleEvents[0]!.data0).toBe(1)
    expect(state.battleEvents[0]!.data1).toBe(1)

    // Next turn where isFirstTurn != 1: resets data1 to 0
    state.battleEventsDone = false
    state.battlers[1]!.volatiles.isFirstTurn = 0
    runBattleEvents(state)
    expect(state.battleEvents[0]!.data1).toBe(0)

    // Next switch-in where isFirstTurn == 1 and data0 == 1: unregisters!
    state.battleEventsDone = false
    state.battlers[1]!.volatiles.isFirstTurn = 1
    runBattleEvents(state)
    expect(state.battleEvents).toEqual([])
  })

  it('ONSTAY_FORESIGHT sets STATUS4_FORESIGHT after stayed turns reached (battle_events.c:415-419, 148-155)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    // data0 = 2 turns
    registerBattleEvent(state, 'BATTLE_EVENT_ONSTAY_FORESIGHT', 2, 0)

    // Turn 1 stayed (isFirstTurn == 0): data1 becomes 1 (< 2), no foresight
    state.battlers[0]!.volatiles.isFirstTurn = 0
    runBattleEvents(state)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FORESIGHT)).toBe(false)

    // Turn 2 stayed: data1 becomes 2 (>= 2), sets STATUS4_FORESIGHT!
    state.battleEventsDone = false
    runBattleEvents(state)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FORESIGHT)).toBe(true)
  })

  it('ONSTAY_LEECH_SEED sets STATUS3_LEECHSEED on player lead when stayed turns reached (battle_events.c:420-426)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    state.battlers[0]!.volatiles.isFirstTurn = 0
    registerBattleEvent(state, 'BATTLE_EVENT_ONSTAY_LEECH_SEED', 1, 0) // data0 = 1 turn

    runBattleEvents(state)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
  })

  it('ONSTAY_MAGNET_RISE sets STATUS3_MAGNET_RISE on opponent lead when stayed turns reached (battle_events.c:427-432)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    state.battlers[1]!.volatiles.isFirstTurn = 0
    registerBattleEvent(state, 'BATTLE_EVENT_ONSTAY_MAGNET_RISE', 1, 0)

    runBattleEvents(state)
    expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_MAGNET_RISE)).toBe(true)
  })

  it('LAST_STAND triggers when opponent faintedCount matches data0, boosts extra*Level by data1, and unregisters (battle_events.c:433-441)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    state.sides[1].faintedCount = 4 // not 5
    registerBattleEvent(state, 'BATTLE_EVENT_LAST_STAND', 5, 3) // triggers at 5 fainted, +3 boost

    runBattleEvents(state)
    expect(state.battlers[1]!.volatiles.extraAttackLevel).toBe(0) // not triggered yet
    expect(state.battleEvents.length).toBe(1)

    // Opponent faintedCount reaches 5
    state.battleEventsDone = false
    state.sides[1].faintedCount = 5
    runBattleEvents(state)

    const opp = state.battlers[1]!
    expect(opp.volatiles.extraAttackLevel).toBe(3)
    expect(opp.volatiles.extraDefenseLevel).toBe(3)
    expect(opp.volatiles.extraSpAttackLevel).toBe(3)
    expect(opp.volatiles.extraSpDefenseLevel).toBe(3)
    expect(opp.volatiles.extraSpeedLevel).toBe(3)
    expect(state.battleEvents).toEqual([]) // unregisters
  })

  it('LAST_STAND_STAGES sets statStages to DEFAULT_STAT_STAGE + level and unregisters (battle_events.c:442-454)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    state.sides[1].faintedCount = 5
    registerBattleEvent(state, 'BATTLE_EVENT_LAST_STAND_STAGES', 5, 2)

    runBattleEvents(state)

    const opp = state.battlers[1]!
    expect(opp.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(opp.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(opp.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(opp.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(opp.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(state.battleEvents).toEqual([])
  })

  it('SUBSTITUTE sets substituteHp = floor(maxHp / 4) when faintedCount matches data0 and unregisters (battle_events.c:455-460, 157-165)', () => {
    const state = battle([{}, { hp: 200, maxHp: 200 }], countingRng())
    state.turnCount = 1
    state.sides[1].faintedCount = 5
    registerBattleEvent(state, 'BATTLE_EVENT_SUBSTITUTE', 5, 0)

    runBattleEvents(state)

    const opp = state.battlers[1]!
    expect(hasFlag(opp.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)
    expect(opp.volatiles.substituteHp).toBe(50) // 200 / 4
    expect(state.battleEvents).toEqual([])
  })

  it('PERMA_HEAL_BLOCK sets STATUS3_HEAL_BLOCK and healBlockTimer = 5 without unregistering (battle_events.c:461-465)', () => {
    const state = battle([{}, {}], countingRng())
    state.turnCount = 1
    registerBattleEvent(state, 'BATTLE_EVENT_PERMA_HEAL_BLOCK', 0, 0)

    runBattleEvents(state)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_HEAL_BLOCK)).toBe(true)
    expect(state.battlers[0]!.volatiles.healBlockTimer).toBe(5)
    expect(state.battleEvents.length).toBe(1)
  })

  it('ONDS_COPY_STATS copies stat stages from player lead to opponent lead on death-switch (battle_events.c:480-484)', () => {
    const state = battle([{ atk: 100 }, {}], countingRng())
    state.turnCount = 1
    state.battlers[0]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 4
    state.battlers[0]!.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE + 2

    // Opponent death-switches in: isFirstTurn == 1 and retaliateTimer == 1
    state.battlers[1]!.volatiles.isFirstTurn = 1
    state.sides[1].timers.retaliateTimer = 1
    registerBattleEvent(state, 'BATTLE_EVENT_ONDS_COPY_STATS', 0, 0)

    runBattleEvents(state)

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 4)
    expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  it('TENSE_BATTLE unregisters when 50% or more mons fainted on both sides (battle_events.c:485-497)', () => {
    const party = [partyMon(), partyMon(), partyMon(), partyMon()]
    const oppParty = [partyMon(), partyMon(), partyMon(), partyMon()]
    const state = battle([{}, {}], countingRng(), party, oppParty)
    state.turnCount = 1
    registerBattleEvent(state, 'BATTLE_EVENT_TENSE_BATTLE', 0, 0)

    // Fainted 1 each (25% each): condition not met
    state.sides[0].faintedCount = 1
    state.sides[1].faintedCount = 1
    runBattleEvents(state)
    expect(state.battleEvents.length).toBe(1)

    // Fainted 2 each (50% each): condition met -> unregisters!
    state.battleEventsDone = false
    state.sides[0].faintedCount = 2
    state.sides[1].faintedCount = 2
    runBattleEvents(state)
    expect(state.battleEvents).toEqual([])
  })

  it('BATTLE_EVENT_STICKY_WEB is unhandled in C and acts as a safe no-op', () => {
    const state = battle([{}, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_STICKY_WEB', 0, 0)

    runBattleEvents(state)
    // No crash, remains in list
    expect(state.battleEvents.length).toBe(1)
  })
})

describe('eventsForFight data loader & guard evaluation', () => {
  const enc = snapshot<{ battleEvents: Array<any> }>('encounters.json')

  it('Petalburg City Gym returns exactly Norman\'s 9 events with empty defeated set', () => {
    const res = eventsForFight(enc, 'PetalburgCity_Gym', new Set())
    expect(res.events.length).toBe(9)
    const eventIds = res.events.map((e) => e.event)
    expect(eventIds).toEqual([
      'BATTLE_EVENT_POSTURE_SPEED',
      'BATTLE_EVENT_STEADY_ACCURACY',
      'BATTLE_EVENT_LAST_STAND',
      'BATTLE_EVENT_SPIKES',
      'BATTLE_EVENT_POSTURE_DEFENSE',
      'BATTLE_EVENT_ONSTAY_LEECH_SEED',
      'BATTLE_EVENT_POSTURE_OFFENSE',
      'BATTLE_EVENT_SUBSTITUTE',
      'BATTLE_EVENT_TENSE_BATTLE',
    ])
  })

  it('Petalburg City Gym filters out POSTURE_SPEED when Randall is defeated', () => {
    const defeated = new Set(['TRAINER_RANDALL'])
    const res = eventsForFight(enc, 'PetalburgCity_Gym', defeated)
    expect(res.events.length).toBe(8)
    expect(res.events.some((e) => e.event === 'BATTLE_EVENT_POSTURE_SPEED')).toBe(false)
  })

  it('unsupported guards (e.g. Mossdeep City Gym) are skipped and reported in skippedGuards', () => {
    const res = eventsForFight(enc, 'MossdeepCity_Gym', new Set())
    expect(res.skippedGuards.length).toBeGreaterThan(0)
    expect(res.skippedGuards.some((g) => g.includes('var(VAR_RESULT)'))).toBe(true)
  })
})

describe('Turn loop & session integration', () => {
  it('executeTurn automatically runs registered battle events at start of turn', () => {
    const state = battle([{ moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] }, {}], countingRng())
    registerBattleEvent(state, 'BATTLE_EVENT_SPIKES', 2, 0)

    executeTurn(state, [pickMoveAction(1, MOVE_TACKLE), null], testDeps())
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(state.sides[0].timers.spikesAmount).toBe(2)
    expect(state.battleEvents).toEqual([]) // Spikes unregistered on turn 0
    expect(state.turnCount).toBe(1)
  })

  it('createSession registers events and applies BeforeFirstTurn pass', () => {
    const data = loadSimData()
    const specs = [
      {
        species: 'SPECIES_TYRANITAR',
        level: 50,
        nature: 'NATURE_ADAMANT',
        evs: { hp: 252, atk: 252, spdef: 4 },
        ability: 'ABILITY_SAND_STREAM',
        item: 'ITEM_SMOOTH_ROCK',
        moves: ['MOVE_STONE_EDGE', 'MOVE_CRUNCH', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH'],
      },
    ]
    const session = createSession({
      data,
      playerParty: buildPlayerParty(specs, 50, data),
      opponentTrainer: data.trainersById.get('TRAINER_SAWYER_1')!,
      rng: createRandomSource(1),
      battleEvents: [
        { event: 'BATTLE_EVENT_POSTURE_OFFENSE', data0: 4, data1: 0 },
      ],
    })

    // BeforeFirstTurn ran during createSession
    expect(session.state.battlers[1]!.volatiles.extraAttackLevel).toBe(4)
    expect(session.state.battleEvents).toEqual([])
  })

  it('stepTurn runs battle events BEFORE chooseAiAction so AI acts on updated state', () => {
    const data = loadSimData()
    const specs = [
      {
        species: 'SPECIES_MUDKIP',
        level: 50,
        nature: 'NATURE_HARDY',
        evs: { hp: 252, atk: 252, spdef: 4 },
        ability: 'ABILITY_TORRENT',
        item: 'ITEM_NONE',
        moves: ['MOVE_TACKLE'],
      },
    ]
    const session = createSession({
      data,
      playerParty: buildPlayerParty(specs, 50, data),
      opponentTrainer: data.trainersById.get('TRAINER_SAWYER_1')!,
      rng: createRandomSource(1),
      battleEvents: [
        { event: 'BATTLE_EVENT_SPIKES', data0: 2, data1: 0 },
      ],
    })

    const result = stepTurn(session, null)
    expect(result.outcome).toBeDefined()
    expect(hasFlag(session.state.sides[0].statuses, SIDE_STATUS_SPIKES)).toBe(true)
  })
})
