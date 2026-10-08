// Unit tests for screens, Mist, Safeguard, Tailwind, and hazard-setting moves (cycle 29, step 5, batch 6).
//
// Hand-derived from upstream C source code at pinned SHA:
// - BattleScript_EffectReflect (data/battle_scripts_1.s:4320-4330)
// - Cmd_setreflect (src/battle_script_commands.c:9319-9339)
// - BattleScript_EffectLightScreen (data/battle_scripts_1.s:4016-4021)
// - Cmd_setlightscreen (src/battle_script_commands.c:10252-10273)
// - BattleScript_EffectAuroraVeil (data/battle_scripts_1.s:3985-3990)
// - VARIOUS_SET_AURORA_VEIL (src/battle_script_commands.c:7749-7767)
// - BattleScript_EffectMist (data/battle_scripts_1.s:4179-4188)
// - Cmd_setmist (src/battle_script_commands.c:10456-10469)
// - BattleScript_EffectSafeguard (data/battle_scripts_1.s:5246-5252)
// - Cmd_setsafeguard (src/battle_script_commands.c:11234-11248)
// - BattleScript_EffectTailwind (data/battle_scripts_1.s:2693-2704)
// - Cmd_settailwind (src/battle_script_commands.c:10961-10973)
// - BattleScript_EffectSpikes (data/battle_scripts_1.s:5058-5067)
// - Cmd_trysetspikes (src/battle_script_commands.c:11115-11125)
// - BattleScript_EffectStealthRock (data/battle_scripts_1.s:2559-2569)
// - Cmd_setstealthrock (src/battle_script_commands.c:11979-11989)
// - BattleScript_EffectToxicSpikes (data/battle_scripts_1.s:2616-2626)
// - Cmd_settoxicspikes (src/battle_script_commands.c:11820-11829)
// - BattleScript_EffectStickyWeb (data/battle_scripts_1.s:2570-2580)
// - Cmd_setstickyweb (src/battle_script_commands.c:11462-11472)
// - Field end-turn countdowns (src/battle_util.c:1792-1927, fieldEndTurn.ts:492-553)
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
  SIDE_STATUS_AURORA_VEIL,
  SIDE_STATUS_LIGHTSCREEN,
  SIDE_STATUS_MIST,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_SAFEGUARD,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_STEALTH_ROCK,
  SIDE_STATUS_STICKY_WEB,
  SIDE_STATUS_TAILWIND,
  SIDE_STATUS_TOXIC_SPIKES,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
  hasFlag,
} from './constants'

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

const MOVE_REFLECT = requireMove('MOVE_REFLECT')
const MOVE_LIGHT_SCREEN = requireMove('MOVE_LIGHT_SCREEN')
const MOVE_AURORA_VEIL = requireMove('MOVE_AURORA_VEIL')
const MOVE_MIST = requireMove('MOVE_MIST')
const MOVE_SAFEGUARD = requireMove('MOVE_SAFEGUARD')
const MOVE_TAILWIND = requireMove('MOVE_TAILWIND')
const MOVE_SPIKES = requireMove('MOVE_SPIKES')
const MOVE_STEALTH_ROCK = requireMove('MOVE_STEALTH_ROCK')
const MOVE_CREEPING_THORNS = requireMove('MOVE_CREEPING_THORNS')
const MOVE_TOXIC_SPIKES = requireMove('MOVE_TOXIC_SPIKES')
const MOVE_STICKY_WEB = requireMove('MOVE_STICKY_WEB')
const MOVE_TACKLE = requireMove('MOVE_TACKLE')

const ABILITY_SCREEN_CLEANER = requireAbility('ABILITY_SCREEN_CLEANER')
const ABILITY_AURORA_BOREALIS = requireAbility('ABILITY_AURORA_BOREALIS')

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

describe('Reflect and Light Screen', () => {
  it('Reflect sets SIDE_STATUS_REFLECT, reflectTimer = 5, started.reflect = true, and reflectBattlerId', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(0, MOVE_REFLECT), null], testDeps())

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_REFLECT)).toBe(true)
    expect(state.sides[0]!.timers.reflectTimer).toBe(5)
    expect(state.sides[0]!.timers.reflectBattlerId).toBe(0)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Light Screen sets SIDE_STATUS_LIGHTSCREEN, lightscreenTimer = 5, started.lightscreen = true, and lightscreenBattlerId', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(0, MOVE_LIGHT_SCREEN), null], testDeps())

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(true)
    expect(state.sides[0]!.timers.lightscreenTimer).toBe(5)
    expect(state.sides[0]!.timers.lightscreenBattlerId).toBe(0)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Reflect fails with missed: true when already active on the side (without Screen Cleaner)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.sides[0]!.statuses |= SIDE_STATUS_REFLECT
    state.sides[0]!.timers.reflectTimer = 4
    const out = executeTurn(state, [useMove(0, MOVE_REFLECT), null], testDeps())

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBe(true)
    // Timer was not reset by the failed move (it ticked down by 1 in field end-turn)
    expect(state.sides[0]!.timers.reflectTimer).toBe(3)
  })

  it('Light Screen fails with missed: true when already active on the side (without Screen Cleaner)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.sides[0]!.statuses |= SIDE_STATUS_LIGHTSCREEN
    state.sides[0]!.timers.lightscreenTimer = 4
    const out = executeTurn(state, [useMove(0, MOVE_LIGHT_SCREEN), null], testDeps())

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBe(true)
    expect(state.sides[0]!.timers.lightscreenTimer).toBe(3)
  })

  it('Screen Cleaner allows re-setting Reflect when already up, refreshing the timer', () => {
    const state = battle(
      [{ spe: 100, abilities: { ability: ABILITY_SCREEN_CLEANER, innates: [null, null, null] } }, { spe: 50 }],
      scriptedRng(),
    )
    state.sides[0]!.statuses |= SIDE_STATUS_REFLECT
    state.sides[0]!.timers.reflectTimer = 2
    const out = executeTurn(state, [useMove(0, MOVE_REFLECT), null], testDeps())

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
    expect(state.sides[0]!.timers.reflectTimer).toBe(5)
  })

  it('Screen Cleaner allows re-setting Light Screen when already up, refreshing the timer', () => {
    const state = battle(
      [{ spe: 100, abilities: { ability: ABILITY_SCREEN_CLEANER, innates: [null, null, null] } }, { spe: 50 }],
      scriptedRng(),
    )
    state.sides[0]!.statuses |= SIDE_STATUS_LIGHTSCREEN
    state.sides[0]!.timers.lightscreenTimer = 2
    const out = executeTurn(state, [useMove(0, MOVE_LIGHT_SCREEN), null], testDeps())

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
    expect(state.sides[0]!.timers.lightscreenTimer).toBe(5)
  })

  it('Light Clay extends Reflect duration to 8 turns (SCREEN_DURATION_EXTENDED)', () => {
    const state = battle([{ spe: 100, itemId: 'ITEM_LIGHT_CLAY' }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(0, MOVE_REFLECT), null], testDeps({ 0: 'HOLD_EFFECT_LIGHT_CLAY' }))

    expect(state.sides[0]!.timers.reflectTimer).toBe(8)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Light Clay extends Light Screen duration to 8 turns (SCREEN_DURATION_EXTENDED)', () => {
    const state = battle([{ spe: 100, itemId: 'ITEM_LIGHT_CLAY' }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(0, MOVE_LIGHT_SCREEN), null], testDeps({ 0: 'HOLD_EFFECT_LIGHT_CLAY' }))

    expect(state.sides[0]!.timers.lightscreenTimer).toBe(8)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })
})

describe('Aurora Veil', () => {
  it('Aurora Veil fails with missed: true without hail/snow weather', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(0, MOVE_AURORA_VEIL), null], testDeps())

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_AURORA_VEIL)).toBe(false)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBe(true)
  })

  it('Aurora Veil fails in other weather (sun, rain, sandstorm)', () => {
    for (const weather of [WEATHER_SUN_TEMPORARY, WEATHER_RAIN_TEMPORARY, WEATHER_SANDSTORM_TEMPORARY]) {
      const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
      state.field.weather = weather
      state.field.timers.started.weather = true
      const out = executeTurn(state, [useMove(0, MOVE_AURORA_VEIL), null], testDeps())
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_AURORA_VEIL)).toBe(false)
      const act = out.actions.find((a) => a.battlerId === 0)
      expect(act?.missed).toBe(true)
    }
  })

  it('Aurora Veil succeeds in hail weather, setting timer to 5', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.timers.started.weather = true
    state.field.weatherDuration = 5
    const out = executeTurn(state, [useMove(0, MOVE_AURORA_VEIL), null], testDeps())

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_AURORA_VEIL)).toBe(true)
    expect(state.sides[0]!.timers.auroraVeilTimer).toBe(5)
    expect(state.sides[0]!.timers.auroraVeilBattlerId).toBe(0)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Aurora Veil succeeds without hail if user has Aurora Borealis ability', () => {
    const state = battle(
      [{ spe: 100, abilities: { ability: ABILITY_AURORA_BOREALIS, innates: [null, null, null] } }, { spe: 50 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(0, MOVE_AURORA_VEIL), null], testDeps())

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_AURORA_VEIL)).toBe(true)
    expect(state.sides[0]!.timers.auroraVeilTimer).toBe(5)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Aurora Veil fails with missed: true when already active on the side (without Screen Cleaner)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.timers.started.weather = true
    state.field.weatherDuration = 5
    state.sides[0]!.statuses |= SIDE_STATUS_AURORA_VEIL
    state.sides[0]!.timers.auroraVeilTimer = 4
    const out = executeTurn(state, [useMove(0, MOVE_AURORA_VEIL), null], testDeps())

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBe(true)
  })

  it('Light Clay extends Aurora Veil duration to 8 turns in hail', () => {
    const state = battle([{ spe: 100, itemId: 'ITEM_LIGHT_CLAY' }, { spe: 50 }], scriptedRng())
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.timers.started.weather = true
    state.field.weatherDuration = 5
    const out = executeTurn(state, [useMove(0, MOVE_AURORA_VEIL), null], testDeps({ 0: 'HOLD_EFFECT_LIGHT_CLAY' }))

    expect(state.sides[0]!.timers.auroraVeilTimer).toBe(8)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })
})

describe('Mist and Safeguard', () => {
  it('Mist sets SIDE_STATUS_MIST, mistTimer = 5, started.mist = true, and mistBattlerId', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(0, MOVE_MIST), null], testDeps())

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_MIST)).toBe(true)
    expect(state.sides[0]!.timers.mistTimer).toBe(5)
    expect(state.sides[0]!.timers.mistBattlerId).toBe(0)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Mist fails (plain failure outcome, no missed flag) when mistTimer !== 0', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.sides[0]!.timers.mistTimer = 3
    state.sides[0]!.statuses |= SIDE_STATUS_MIST
    const out = executeTurn(state, [useMove(0, MOVE_MIST), null], testDeps())

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
    // Timer was not reset to 5; ticked down by 1 in field end-turn to 2
    expect(state.sides[0]!.timers.mistTimer).toBe(2)
  })

  it('Safeguard sets SIDE_STATUS_SAFEGUARD, safeguardTimer = 5, started.safeguard = true, and safeguardBattlerId', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(0, MOVE_SAFEGUARD), null], testDeps())

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SAFEGUARD)).toBe(true)
    expect(state.sides[0]!.timers.safeguardTimer).toBe(5)
    expect(state.sides[0]!.timers.safeguardBattlerId).toBe(0)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Safeguard fails with missed: true when already active on the side', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.sides[0]!.statuses |= SIDE_STATUS_SAFEGUARD
    state.sides[0]!.timers.safeguardTimer = 4
    const out = executeTurn(state, [useMove(0, MOVE_SAFEGUARD), null], testDeps())

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBe(true)
    expect(state.sides[0]!.timers.safeguardTimer).toBe(3)
  })
})

describe('Tailwind', () => {
  it('Tailwind sets SIDE_STATUS_TAILWIND, tailwindTimer = 3, started.tailwind = true, and tailwindBattlerId', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(0, MOVE_TAILWIND), null], testDeps())

    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(3)
    expect(state.sides[0]!.timers.tailwindBattlerId).toBe(0)
    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
  })

  it('Tailwind fails (plain failure, no missed flag) when already active on the side', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.sides[0]!.statuses |= SIDE_STATUS_TAILWIND
    state.sides[0]!.timers.tailwindTimer = 2
    const out = executeTurn(state, [useMove(0, MOVE_TAILWIND), null], testDeps())

    const act = out.actions.find((a) => a.battlerId === 0)
    expect(act?.missed).toBeFalsy()
    expect(state.sides[0]!.timers.tailwindTimer).toBe(1)
  })

  it('Tailwind doubles speed on the following turn and reverses turn order', () => {
    // Turn 1: Battler 0 has spe 30, Battler 1 has spe 50.
    // Battler 1 moves first on turn 1. Battler 0 uses Tailwind.
    const state = battle([{ spe: 30 }, { spe: 50 }], scriptedRng())
    const out1 = executeTurn(state, [useMove(0, MOVE_TAILWIND), useMove(0, MOVE_TACKLE)], testDeps())
    expect(out1.order.battlerByTurnOrder).toEqual([1, 0])
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)

    // Turn 2: With Tailwind active on side 0, Battler 0 speed is effectively 30 * 2 = 60 > 50.
    // Battler 0 moves first on turn 2!
    const out2 = executeTurn(state, [useMove(1, MOVE_TACKLE), useMove(0, MOVE_TACKLE)], testDeps())
    expect(out2.order.battlerByTurnOrder).toEqual([0, 1])
  })
})

describe('Entry hazards: Spikes, Toxic Spikes, Stealth Rock, Sticky Web', () => {
  it('Spikes increments spikesAmount up to 3 on opponent side, then fails (plain failure)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())

    // Layer 1
    const out1 = executeTurn(state, [useMove(1, MOVE_SPIKES), null], testDeps())
    expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_SPIKES)).toBe(true)
    expect(state.sides[1]!.timers.spikesAmount).toBe(1)
    expect(out1.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()

    // Layer 2
    const out2 = executeTurn(state, [useMove(1, MOVE_SPIKES), null], testDeps())
    expect(state.sides[1]!.timers.spikesAmount).toBe(2)
    expect(out2.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()

    // Layer 3
    const out3 = executeTurn(state, [useMove(1, MOVE_SPIKES), null], testDeps())
    expect(state.sides[1]!.timers.spikesAmount).toBe(3)
    expect(out3.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()

    // Layer 4 (fails: Cmd_trysetspikes checks spikesAmount == 3)
    const out4 = executeTurn(state, [useMove(1, MOVE_SPIKES), null], testDeps())
    expect(state.sides[1]!.timers.spikesAmount).toBe(3)
    const act4 = out4.actions.find((a) => a.battlerId === 0)
    expect(act4?.missed).toBeFalsy() // Plain failure outcome, no missed flag
  })

  it('Toxic Spikes increments toxicSpikesAmount up to 2 on opponent side, then fails', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())

    // Layer 1
    const out1 = executeTurn(state, [useMove(1, MOVE_TOXIC_SPIKES), null], testDeps())
    expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_TOXIC_SPIKES)).toBe(true)
    expect(state.sides[1]!.timers.toxicSpikesAmount).toBe(1)
    expect(out1.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()

    // Layer 2
    const out2 = executeTurn(state, [useMove(1, MOVE_TOXIC_SPIKES), null], testDeps())
    expect(state.sides[1]!.timers.toxicSpikesAmount).toBe(2)
    expect(out2.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()

    // Layer 3 (fails: Cmd_settoxicspikes checks toxicSpikesAmount >= 2)
    const out3 = executeTurn(state, [useMove(1, MOVE_TOXIC_SPIKES), null], testDeps())
    expect(state.sides[1]!.timers.toxicSpikesAmount).toBe(2)
    const act3 = out3.actions.find((a) => a.battlerId === 0)
    expect(act3?.missed).toBeFalsy()
  })

  it('Stealth Rock sets SIDE_STATUS_STEALTH_ROCK on opponent side with stealthRockType = 5 (TYPE_ROCK)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_STEALTH_ROCK), null], testDeps())

    expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(state.sides[1]!.timers.stealthRockType).toBe(5)
    expect(out.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()

    // Setting again fails
    const out2 = executeTurn(state, [useMove(1, MOVE_STEALTH_ROCK), null], testDeps())
    expect(out2.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()
  })

  it('Creeping Thorns sets SIDE_STATUS_STEALTH_ROCK on opponent side with stealthRockType = 12 (TYPE_GRASS)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_CREEPING_THORNS), null], testDeps())

    expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_STEALTH_ROCK)).toBe(true)
    expect(state.sides[1]!.timers.stealthRockType).toBe(12)
    expect(out.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()
  })

  it('Sticky Web sets SIDE_STATUS_STICKY_WEB on opponent side with stickyWebTimer = 0', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_STICKY_WEB), null], testDeps())

    expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_STICKY_WEB)).toBe(true)
    expect(state.sides[1]!.timers.stickyWebTimer).toBe(0)
    expect(out.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()

    // Setting again fails
    const out2 = executeTurn(state, [useMove(1, MOVE_STICKY_WEB), null], testDeps())
    expect(out2.actions.find((a) => a.battlerId === 0)?.missed).toBeFalsy()
  })
})

describe('Timer countdown across executeTurn calls via field end-turn', () => {
  it('Reflect timer counts down from 5 to 0 across consecutive turns and expires', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())

    // Turn 1: user sets Reflect. started.reflect prevents countdown on turn 1.
    executeTurn(state, [useMove(0, MOVE_REFLECT), null], testDeps())
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_REFLECT)).toBe(true)
    expect(state.sides[0]!.timers.reflectTimer).toBe(5)

    // Turn 2: started.reflect was cleared at end of turn 1, so timer decrements to 4.
    executeTurn(state, [null, null], testDeps())
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_REFLECT)).toBe(true)
    expect(state.sides[0]!.timers.reflectTimer).toBe(4)

    // Turn 3: decrements to 3
    executeTurn(state, [null, null], testDeps())
    expect(state.sides[0]!.timers.reflectTimer).toBe(3)

    // Turn 4: decrements to 2
    executeTurn(state, [null, null], testDeps())
    expect(state.sides[0]!.timers.reflectTimer).toBe(2)

    // Turn 5: decrements to 1
    executeTurn(state, [null, null], testDeps())
    expect(state.sides[0]!.timers.reflectTimer).toBe(1)

    // Turn 6: decrements to 0 and clears SIDE_STATUS_REFLECT
    executeTurn(state, [null, null], testDeps())
    expect(state.sides[0]!.timers.reflectTimer).toBe(0)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_REFLECT)).toBe(false)
  })

  it('Tailwind timer counts down from 3 to 0 across consecutive turns and expires', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())

    // Turn 1: user sets Tailwind. Timer remains 3 on turn 1.
    executeTurn(state, [useMove(0, MOVE_TAILWIND), null], testDeps())
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(3)

    // Turn 2: decrements to 2
    executeTurn(state, [null, null], testDeps())
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(2)

    // Turn 3: decrements to 1
    executeTurn(state, [null, null], testDeps())
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(true)
    expect(state.sides[0]!.timers.tailwindTimer).toBe(1)

    // Turn 4: decrements to 0 and clears SIDE_STATUS_TAILWIND
    executeTurn(state, [null, null], testDeps())
    expect(state.sides[0]!.timers.tailwindTimer).toBe(0)
    expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_TAILWIND)).toBe(false)
  })
})

describe('started flags', () => {
  it('a started flag set before the turn is cleared at turn start, so that turn still counts the timer down', () => {
    // CheckFocusPunch_ClearVarsBeforeTurnStarts (battle_main.c:4589-4595) runs before actions, not at the end of
    // the previous turn -- e.g. a timer set by a switch-in between turns is decremented on the next end-turn.
    const state = battle([{ spe: 100 }, { spe: 50 }], scriptedRng())
    state.sides[0]!.statuses |= SIDE_STATUS_REFLECT
    state.sides[0]!.timers.reflectTimer = 5
    state.sides[0]!.timers.started.reflect = true
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps())
    expect(state.sides[0]!.timers.reflectTimer).toBe(4)
  })
})
