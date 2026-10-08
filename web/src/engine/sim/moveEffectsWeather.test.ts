// Unit tests for weather-setting moves (cycle 30, step 5, batch 7).
//
// Hand-derived from upstream C source code at pinned SHA:
// - BattleScript_EffectRainDance (data/battle_scripts_1.s:5505-5511)
// - BattleScript_EffectSunnyDay (data/battle_scripts_1.s:5520-5527)
// - BattleScript_EffectSandstorm (data/battle_scripts_1.s:5117-5123)
// - BattleScript_EffectHail (data/battle_scripts_1.s:6048-6055)
// - BattleScript_EffectEerieFog (data/battle_scripts_1.s:12406-12413)
// - checkprimalweather macro (battle_script.inc:2511-2526)
// - setbattleweather macro (battle_script.inc:2297-2306) -> VARIOUS_SET_WEATHER (src/battle_script_commands.c:8634-8644)
// - TryChangeBattleWeather (src/battle_util.c:3721-3743)
// - WEATHER_DURATION (8) & WEATHER_DURATION_EXTENDED (12) (include/battle_util.h:50-51)
// - Field end-turn countdowns & residual damage (src/battle_util.c:1945-2037, fieldEndTurn.ts:557-637)
// - CheckFocusPunch_ClearVarsBeforeTurnStarts (src/battle_main.c:4589-4595, turn.ts clearStartedFlags)

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  STATUS1_NONE,
  WEATHER_FOG_PERMANENT,
  WEATHER_FOG_TEMPORARY,
  WEATHER_HAIL_ANY,
  WEATHER_HAIL_PERMANENT,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_NONE,
  WEATHER_RAIN_ANY,
  WEATHER_RAIN_PERMANENT,
  WEATHER_RAIN_PRIMAL,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_ANY,
  WEATHER_SANDSTORM_PERMANENT,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_STRONG_WINDS,
  WEATHER_SUN_ANY,
  WEATHER_SUN_PERMANENT,
  WEATHER_SUN_PRIMAL,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'
import { WEATHER_DURATION, WEATHER_DURATION_EXTENDED } from './moveEffects'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

const MOVE_RAIN_DANCE = requireMove('MOVE_RAIN_DANCE')
const MOVE_SUNNY_DAY = requireMove('MOVE_SUNNY_DAY')
const MOVE_SANDSTORM = requireMove('MOVE_SANDSTORM')
const MOVE_HAIL = requireMove('MOVE_HAIL')
const MOVE_EERIE_FOG = requireMove('MOVE_EERIE_FOG')

const ABILITY_CLOUD_NINE = requireAbility('ABILITY_CLOUD_NINE')
const ABILITY_AIR_LOCK = requireAbility('ABILITY_AIR_LOCK')

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
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: STATUS1_NONE,
    status2: 0,
    ...overrides,
  }
}

function battle(
  specs: {
    spe?: number
    atk?: number
    hp?: number
    maxHp?: number
    itemId?: string | null
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    types?: SimBattleMon['types']
    statStages?: number[]
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          itemId: s.itemId ?? null,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
          statStages: s.statStages ?? [],
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(rolls: number[] = []): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      if (idx < rolls.length) {
        return rolls[idx++]!
      }
      return 0
    },
  }
  return r
}

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: move.priority ?? 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function dummyDamage(): DamageResolver {
  return {
    resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
  }
}

function testDeps(holdEffects: Record<number, string> = {}): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const grounding: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => holdEffects[id] ?? null }
  return { turnOrder: rest, grounding, damage: dummyDamage(), statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('Weather-setting moves: success, flags, and duration', () => {
  it('Rain Dance sets WEATHER_RAIN_TEMPORARY, started.weather = true, 8-turn duration, and deducts PP', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_RAIN_DANCE', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.battlers[0]!.mon.pp = [5, 0, 0, 0]

    const out = executeTurn(state, [useMove(0, MOVE_RAIN_DANCE), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION) // 8 turns (include/battle_util.h:50)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Rain Dance with Damp Rock (HOLD_EFFECT_DAMP_ROCK) extends duration to 12 turns', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_RAIN_DANCE', null, null, null], itemId: 'ITEM_DAMP_ROCK' }, { spe: 50 }],
      scriptedRng(),
    )
    executeTurn(state, [useMove(0, MOVE_RAIN_DANCE), null], testDeps({ 0: 'HOLD_EFFECT_DAMP_ROCK' }))

    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION_EXTENDED) // 12 turns (include/battle_util.h:51)
  })

  it('Sunny Day sets WEATHER_SUN_TEMPORARY, started.weather = true, 8-turn duration, and deducts PP', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_SUNNY_DAY', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.battlers[0]!.mon.pp = [5, 0, 0, 0]

    const out = executeTurn(state, [useMove(0, MOVE_SUNNY_DAY), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_SUN_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Sunny Day with Heat Rock (HOLD_EFFECT_HEAT_ROCK) extends duration to 12 turns', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_SUNNY_DAY', null, null, null], itemId: 'ITEM_HEAT_ROCK' }, { spe: 50 }],
      scriptedRng(),
    )
    executeTurn(state, [useMove(0, MOVE_SUNNY_DAY), null], testDeps({ 0: 'HOLD_EFFECT_HEAT_ROCK' }))

    expect(state.field.weather).toBe(WEATHER_SUN_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION_EXTENDED)
  })

  it('Sandstorm sets WEATHER_SANDSTORM_TEMPORARY, started.weather = true, 8-turn duration, and deducts PP', () => {
    // Both battlers given Rock type to avoid sandstorm damage complicating assertions here
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SANDSTORM', null, null, null], types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.battlers[0]!.mon.pp = [5, 0, 0, 0]

    const out = executeTurn(state, [useMove(0, MOVE_SANDSTORM), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Sandstorm with Smooth Rock (HOLD_EFFECT_SMOOTH_ROCK) extends duration to 12 turns', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SANDSTORM', null, null, null], itemId: 'ITEM_SMOOTH_ROCK', types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    executeTurn(state, [useMove(0, MOVE_SANDSTORM), null], testDeps({ 0: 'HOLD_EFFECT_SMOOTH_ROCK' }))

    expect(state.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION_EXTENDED)
  })

  it('Hail sets WEATHER_HAIL_TEMPORARY, started.weather = true, 8-turn duration, and deducts PP', () => {
    // Both battlers given Ice type to avoid hail damage complicating assertions here
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_HAIL', null, null, null], types: ['ICE', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ICE', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.battlers[0]!.mon.pp = [5, 0, 0, 0]

    const out = executeTurn(state, [useMove(0, MOVE_HAIL), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Hail with Icy Rock (HOLD_EFFECT_ICY_ROCK) extends duration to 12 turns', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_HAIL', null, null, null], itemId: 'ITEM_ICY_ROCK', types: ['ICE', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ICE', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    executeTurn(state, [useMove(0, MOVE_HAIL), null], testDeps({ 0: 'HOLD_EFFECT_ICY_ROCK' }))

    expect(state.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION_EXTENDED)
  })

  it('Eerie Fog sets WEATHER_FOG_TEMPORARY, started.weather = true, 8-turn duration, and deducts PP', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_EERIE_FOG', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.battlers[0]!.mon.pp = [5, 0, 0, 0]

    const out = executeTurn(state, [useMove(0, MOVE_EERIE_FOG), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_FOG_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Eerie Fog with Smoke Ball (HOLD_EFFECT_SMOKE_BALL) extends duration to 12 turns', () => {
    // In Elite Redux, Smoke Ball extends Fog (src/battle_util.c:3718)
    const state = battle(
      [{ spe: 100, moves: ['MOVE_EERIE_FOG', null, null, null], itemId: 'ITEM_SMOKE_BALL' }, { spe: 50 }],
      scriptedRng(),
    )
    executeTurn(state, [useMove(0, MOVE_EERIE_FOG), null], testDeps({ 0: 'HOLD_EFFECT_SMOKE_BALL' }))

    expect(state.field.weather).toBe(WEATHER_FOG_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION_EXTENDED)
  })
})

describe('Weather-setting moves: failure when same weather is already active', () => {
  it('Rain Dance fails when WEATHER_RAIN_TEMPORARY is already active', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_RAIN_DANCE', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_RAIN_TEMPORARY
    state.field.weatherDuration = 3
    
    const out = executeTurn(state, [useMove(0, MOVE_RAIN_DANCE), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.field.weatherDuration).toBe(2) // failed move left the timer alone; end-turn decremented it
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy() // ButItFailed does not set MOVE_RESULT_MISSED
  })

  it('Rain Dance fails when WEATHER_RAIN_PERMANENT is already active', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_RAIN_DANCE', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_RAIN_PERMANENT
    state.field.weatherDuration = 0

    const out = executeTurn(state, [useMove(0, MOVE_RAIN_DANCE), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_RAIN_PERMANENT)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Sunny Day fails when WEATHER_SUN_TEMPORARY is already active', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_SUNNY_DAY', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SUN_TEMPORARY
    state.field.weatherDuration = 4
    state.field.timers.started.weather = true

    executeTurn(state, [useMove(0, MOVE_SUNNY_DAY), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_SUN_TEMPORARY)
    expect(state.field.weatherDuration).toBe(3) // failed move left the timer alone; end-turn decremented it
  })

  it('Sunny Day fails when WEATHER_SUN_PERMANENT is already active', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_SUNNY_DAY', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SUN_PERMANENT

    executeTurn(state, [useMove(0, MOVE_SUNNY_DAY), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_SUN_PERMANENT)
  })

  it('Sandstorm fails when WEATHER_SANDSTORM_TEMPORARY is already active', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SANDSTORM', null, null, null], types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    state.field.weatherDuration = 2
    state.field.timers.started.weather = true

    executeTurn(state, [useMove(0, MOVE_SANDSTORM), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)
    expect(state.field.weatherDuration).toBe(1) // failed move left the timer alone; end-turn decremented it
  })

  it('Sandstorm fails when WEATHER_SANDSTORM_PERMANENT is already active', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SANDSTORM', null, null, null], types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SANDSTORM_PERMANENT

    executeTurn(state, [useMove(0, MOVE_SANDSTORM), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_SANDSTORM_PERMANENT)
  })

  it('Hail fails when WEATHER_HAIL_TEMPORARY is already active', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_HAIL', null, null, null], types: ['ICE', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ICE', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.weatherDuration = 3
    state.field.timers.started.weather = true

    executeTurn(state, [useMove(0, MOVE_HAIL), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    expect(state.field.weatherDuration).toBe(2) // failed move left the timer alone; end-turn decremented it
  })

  it('Hail fails when WEATHER_HAIL_PERMANENT is already active', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_HAIL', null, null, null], types: ['ICE', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ICE', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_HAIL_PERMANENT

    executeTurn(state, [useMove(0, MOVE_HAIL), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_HAIL_PERMANENT)
  })

  it('Eerie Fog fails when WEATHER_FOG_TEMPORARY is already active', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_EERIE_FOG', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_FOG_TEMPORARY
    state.field.weatherDuration = 5
    state.field.timers.started.weather = true

    executeTurn(state, [useMove(0, MOVE_EERIE_FOG), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_FOG_TEMPORARY)
    expect(state.field.weatherDuration).toBe(4) // failed move left the timer alone; end-turn decremented it
  })

  it('Eerie Fog fails when WEATHER_FOG_PERMANENT is already active', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_EERIE_FOG', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_FOG_PERMANENT

    executeTurn(state, [useMove(0, MOVE_EERIE_FOG), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_FOG_PERMANENT)
  })
})

describe('Weather-setting moves: failure under primal weather and strong winds', () => {
  it('Rain Dance fails under Desolate Land / primal sun (WEATHER_SUN_PRIMAL)', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_RAIN_DANCE', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SUN_PRIMAL
    state.battlers[0]!.mon.pp = [5, 0, 0, 0]

    const out = executeTurn(state, [useMove(0, MOVE_RAIN_DANCE), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4) // PP is still deducted before checkprimalweather
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Sunny Day fails under Primordial Sea / primal rain (WEATHER_RAIN_PRIMAL)', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_SUNNY_DAY', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_RAIN_PRIMAL
    state.battlers[0]!.mon.pp = [5, 0, 0, 0]

    const out = executeTurn(state, [useMove(0, MOVE_SUNNY_DAY), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_RAIN_PRIMAL)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Sandstorm fails under Delta Stream / strong winds (WEATHER_STRONG_WINDS)', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SANDSTORM', null, null, null], types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_STRONG_WINDS
    state.battlers[0]!.mon.pp = [5, 0, 0, 0]

    const out = executeTurn(state, [useMove(0, MOVE_SANDSTORM), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_STRONG_WINDS)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Hail fails under Desolate Land / primal sun (WEATHER_SUN_PRIMAL)', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_HAIL', null, null, null], types: ['ICE', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ICE', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SUN_PRIMAL

    executeTurn(state, [useMove(0, MOVE_HAIL), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_SUN_PRIMAL)
  })

  it('Eerie Fog fails under Primordial Sea / primal rain (WEATHER_RAIN_PRIMAL)', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_EERIE_FOG', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_RAIN_PRIMAL

    executeTurn(state, [useMove(0, MOVE_EERIE_FOG), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_RAIN_PRIMAL)
  })
})

describe('Weather-setting moves: weather suppression (weatherHasEffect)', () => {
  it('Rain Dance fails if Cloud Nine is on the field (src/battle_util.c:3728-3730)', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_RAIN_DANCE', null, null, null] },
        { spe: 50, abilities: { ability: ABILITY_CLOUD_NINE, innates: [null, null, null] } },
      ],
      scriptedRng(),
    )

    executeTurn(state, [useMove(0, MOVE_RAIN_DANCE), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_NONE)
  })

  it('Sunny Day fails if Air Lock is on the field (src/battle_util.c:3728-3730)', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SUNNY_DAY', null, null, null] },
        { spe: 50, abilities: { ability: ABILITY_AIR_LOCK, innates: [null, null, null] } },
      ],
      scriptedRng(),
    )

    executeTurn(state, [useMove(0, MOVE_SUNNY_DAY), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_NONE)
  })

  it('Sandstorm fails if clearSkiesTimer > 0 (src/battle_util.c:3728-3730)', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SANDSTORM', null, null, null], types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.timers.clearSkiesTimer = 3

    executeTurn(state, [useMove(0, MOVE_SANDSTORM), null], testDeps())

    expect(state.field.weather).toBe(WEATHER_NONE)
  })

  it('Hail fails if Clueless is on the field (grounding.isCluelessOnField)', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_HAIL', null, null, null], types: ['ICE', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ICE', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )

    const depsWithClueless: TurnLoopDeps = {
      ...testDeps(),
      grounding: { ...GROUNDING, isCluelessOnField: true },
    }
    executeTurn(state, [useMove(0, MOVE_HAIL), null], depsWithClueless)

    expect(state.field.weather).toBe(WEATHER_NONE)
  })
})

describe('Weather-setting moves: one weather replacing another', () => {
  it('Sunny Day replaces active Rain (clears rain bit, sets sun bit, resets timer to 8)', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_SUNNY_DAY', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_RAIN_TEMPORARY
    state.field.weatherDuration = 2

    executeTurn(state, [useMove(0, MOVE_SUNNY_DAY), null], testDeps())

    expect(hasFlag(state.field.weather, WEATHER_RAIN_ANY)).toBe(false)
    expect(state.field.weather).toBe(WEATHER_SUN_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
  })

  it('Rain Dance replaces active Sandstorm', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_RAIN_DANCE', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    state.field.weatherDuration = 3

    executeTurn(state, [useMove(0, MOVE_RAIN_DANCE), null], testDeps())

    expect(hasFlag(state.field.weather, WEATHER_SANDSTORM_ANY)).toBe(false)
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
  })

  it('Sandstorm replaces active Sun', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SANDSTORM', null, null, null], types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ROCK', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SUN_TEMPORARY
    state.field.weatherDuration = 4

    executeTurn(state, [useMove(0, MOVE_SANDSTORM), null], testDeps())

    expect(hasFlag(state.field.weather, WEATHER_SUN_ANY)).toBe(false)
    expect(state.field.weather).toBe(WEATHER_SANDSTORM_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
  })

  it('Hail replaces active Sun', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_HAIL', null, null, null], types: ['ICE', 'MYSTERY', 'MYSTERY'] },
        { spe: 50, types: ['ICE', 'MYSTERY', 'MYSTERY'] },
      ],
      scriptedRng(),
    )
    state.field.weather = WEATHER_SUN_TEMPORARY
    state.field.weatherDuration = 5

    executeTurn(state, [useMove(0, MOVE_HAIL), null], testDeps())

    expect(hasFlag(state.field.weather, WEATHER_SUN_ANY)).toBe(false)
    expect(state.field.weather).toBe(WEATHER_HAIL_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
  })

  it('Eerie Fog replaces active Hail', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_EERIE_FOG', null, null, null] }, { spe: 50 }],
      scriptedRng(),
    )
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.weatherDuration = 1

    executeTurn(state, [useMove(0, MOVE_EERIE_FOG), null], testDeps())

    expect(hasFlag(state.field.weather, WEATHER_HAIL_ANY)).toBe(false)
    expect(state.field.weather).toBe(WEATHER_FOG_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)
  })
})

describe('Weather duration countdown across executeTurn calls', () => {
  it('set on turn 1: started.weather prevents decrement on turn 1; decrements on turn 2', () => {
    const state = battle(
      [{ spe: 100, moves: ['MOVE_RAIN_DANCE', 'MOVE_TACKLE', null, null] }, { spe: 50 }],
      scriptedRng(),
    )

    // Turn 1: user uses Rain Dance
    executeTurn(state, [useMove(0, MOVE_RAIN_DANCE), null], testDeps())

    // On turn 1, started.weather was set, so fieldEndTurn skipped decrement: duration is still 8
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.field.timers.started.weather).toBe(true)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION)

    // Turn 2: actions start; turn.ts clearStartedFlags clears started.weather; no new weather started
    executeTurn(state, [null, null], testDeps())

    // At end of turn 2, fieldEndTurn decrements weatherDuration from 8 to 7
    expect(state.field.weather).toBe(WEATHER_RAIN_TEMPORARY)
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION - 1) // 7
  })

  it('Sandstorm deals end-turn damage on the same turn it was set, and decrements on turn 2', () => {
    const state = battle(
      [
        { spe: 100, maxHp: 160, hp: 160, moves: ['MOVE_SANDSTORM', null, null, null] }, // Water type, not immune
        { spe: 50, maxHp: 100, hp: 100 }, // Water type, not immune
      ],
      scriptedRng(),
    )

    // Turn 1: Sandstorm is set
    const out1 = executeTurn(state, [useMove(0, MOVE_SANDSTORM), null], testDeps())

    // Timer not decremented this turn because started.weather was set
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION) // 8
    // End-turn residual damage DOES apply on the turn it is set (src/battle_util.c:1968-1983)
    const sandDmg1 = out1.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM')
    expect(sandDmg1).toHaveLength(2)
    expect(state.battlers[0]!.mon.hp).toBe(160 - 10) // floor(160/16) = 10
    expect(state.battlers[1]!.mon.hp).toBe(100 - 6) // floor(100/16) = 6

    // Turn 2: null actions
    const out2 = executeTurn(state, [null, null], testDeps())

    // Timer decrements on turn 2
    expect(state.field.weatherDuration).toBe(WEATHER_DURATION - 1) // 7
    const sandDmg2 = out2.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM')
    expect(sandDmg2).toHaveLength(2)
    expect(state.battlers[0]!.mon.hp).toBe(150 - 10)
    expect(state.battlers[1]!.mon.hp).toBe(94 - 6)
  })

  it('Hail deals end-turn damage on the same turn it was set, and decrements on turn 2', () => {
    const state = battle(
      [
        { spe: 100, maxHp: 160, hp: 160, moves: ['MOVE_HAIL', null, null, null] },
        { spe: 50, maxHp: 100, hp: 100 },
      ],
      scriptedRng(),
    )

    // Turn 1: Hail is set
    const out1 = executeTurn(state, [useMove(0, MOVE_HAIL), null], testDeps())

    expect(state.field.weatherDuration).toBe(WEATHER_DURATION) // 8
    const hailDmg1 = out1.fieldEndTurn.filter((r) => r.effect === 'HAIL')
    expect(hailDmg1).toHaveLength(2)
    expect(state.battlers[0]!.mon.hp).toBe(160 - 10)
    expect(state.battlers[1]!.mon.hp).toBe(100 - 6)

    // Turn 2
    const out2 = executeTurn(state, [null, null], testDeps())

    expect(state.field.weatherDuration).toBe(WEATHER_DURATION - 1) // 7
    const hailDmg2 = out2.fieldEndTurn.filter((r) => r.effect === 'HAIL')
    expect(hailDmg2).toHaveLength(2)
    expect(state.battlers[0]!.mon.hp).toBe(150 - 10)
    expect(state.battlers[1]!.mon.hp).toBe(94 - 6)
  })
})
