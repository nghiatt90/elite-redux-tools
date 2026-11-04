/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 142c: ENDTURN_TOXIC_TERRAIN clears STATUS_FIELD_TOXIC_TERRAIN *before*
// the damage loop's FILTER chain runs, and that chain's IsBattlerTerrainAffected
// (:4902 -> IsTerrainActive :4886-4889) tests the field bit. The clearing tick
// therefore chips NOBODY. Grassy Terrain is the opposite (its heal script never
// tests the field bit) and is pinned below as unchanged.
//
// Scaffolding copied from turnFieldEndTurn.test.ts (same battle()/scripted()/
// deps() shape, same committed data snapshot).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import {
  STATUS_FIELD_TOXIC_TERRAIN,
  STATUS_FIELD_GRASSY_TERRAIN,
  STATUS_FIELD_TERRAIN_PERMANENT,
  hasFlag,
} from './constants'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn, THROWING_DAMAGE_RESOLVER } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData } from './dataContext'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const speciesIds = new Set(snapshot<Array<{ id: string }>>('species.json').map((s) => s.id))

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
function requireItem(id: string): SimItemData {
  const it = itemsById.get(id)
  if (!it) throw new Error(`items.json has no ${id}`)
  return {
    id,
    resolvedHoldEffect: (it.resolvedHoldEffect as string | null) ?? null,
    holdEffectStrength: (it.holdEffectStrength as number | null) ?? null,
    holdEffectType: (it.holdEffectType as string | null) ?? null,
    naturalGift: (it.naturalGift as { power: number; type: string } | null) ?? null,
  }
}
function requireSpecies(id: string): string {
  if (!speciesIds.has(id)) throw new Error(`species.json has no ${id}`)
  return id
}

// Fail loudly, not by a silently-vacuous test later, if any of these ids are
// ever renamed or removed.
const MUDKIP = requireSpecies('SPECIES_MUDKIP')
const STENCH = requireAbility('ABILITY_STENCH')

const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: () => undefined,
}
const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: MUDKIP,
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

function battle(specs: { spe: number; hp?: number; maxHp?: number; types?: SimBattleMon['types']; abilities?: SimBattleMon['abilities']; itemId?: string | null; status1?: number }[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe },
          hp: s.hp ?? s.maxHp ?? 100,
          maxHp: s.maxHp ?? 100,
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

function deps(damage: DamageResolver = THROWING_DAMAGE_RESOLVER): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

/** Raw NORMAL-typed battlers, spe 100 / 50, both maxHp 160 (chip =
 * floor(160/16) = 10). `started` flags are zeroed by executeTurn itself
 * (clearStartedFlags, turn.ts, battle_main.c:4589-4595), so sequential turns on
 * one state run the way the game does. */
function toxicBattle(timer: number): BattleState {
  const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 160 }], scripted())
  state.field.statuses = STATUS_FIELD_TOXIC_TERRAIN
  state.field.timers.terrainTimer = timer
  return state
}

describe('ENDTURN_TOXIC_TERRAIN: the clearing tick chips nobody (IsTerrainActive, battle_util.c:4886-4889 / :4902)', () => {
  it('timer 3, not started: ticks 3->2 and 2->1 chip 10 each, tick 1->0 clears the bit and does not chip', () => {
    const state = toxicBattle(3)

    const turn1 = executeTurn(state, [null, null], deps())
    expect(state.field.timers.terrainTimer).toBe(2)
    // floor(160/16) = 10 for both grounded NORMAL battlers.
    expect(turn1.fieldEndTurn.filter((r) => r.effect === 'TOXIC_TERRAIN')).toEqual([
      { battlerId: 0, effect: 'TOXIC_TERRAIN', hpChange: -10, fainted: false },
      { battlerId: 1, effect: 'TOXIC_TERRAIN', hpChange: -10, fainted: false },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(150)
    expect(state.battlers[1]!.mon.hp).toBe(150)

    const turn2 = executeTurn(state, [null, null], deps())
    expect(state.field.timers.terrainTimer).toBe(1)
    expect(turn2.fieldEndTurn.filter((r) => r.effect === 'TOXIC_TERRAIN')).toEqual([
      { battlerId: 0, effect: 'TOXIC_TERRAIN', hpChange: -10, fainted: false },
      { battlerId: 1, effect: 'TOXIC_TERRAIN', hpChange: -10, fainted: false },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(140)
    expect(state.battlers[1]!.mon.hp).toBe(140)

    // Third tick: 1 -> 0, :2128-2133 clears the bit BEFORE the :2134-2139
    // FILTER chain runs, so IsTerrainActive (:4902, :4886-4889) is false for
    // every battler. No chip.
    const turn3 = executeTurn(state, [null, null], deps())
    expect(state.field.timers.terrainTimer).toBe(0)
    expect(turn3.fieldEndTurn.filter((r) => r.effect === 'TOXIC_TERRAIN')).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(140)
    expect(state.battlers[1]!.mon.hp).toBe(140)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)).toBe(false)

    // Total: TWO chips over a 3-tick terrain, i.e. terrainTimer - 1.
    expect(160 - state.battlers[0]!.mon.hp).toBe(20)
  })

  it('timer 1, not started: the very first tick clears the bit, zero chips total', () => {
    const state = toxicBattle(1)
    const out = executeTurn(state, [null, null], deps())
    expect(state.field.timers.terrainTimer).toBe(0)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)).toBe(false)
    expect(out.fieldEndTurn.filter((r) => r.effect === 'TOXIC_TERRAIN')).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(160)
    expect(state.battlers[1]!.mon.hp).toBe(160)
  })

  it('permanent terrain (:2126 `!(gFieldStatuses & STATUS_FIELD_TERRAIN_PERMANENT)`) never clears, so it chips every tick', () => {
    // Guard against over-correcting the fix: with the permanent bit set the
    // countdown (:2126-2127) never runs, the field bit is never cleared, and
    // the chip must still fire on every turn.
    const state = toxicBattle(3)
    state.field.statuses = state.field.statuses | STATUS_FIELD_TERRAIN_PERMANENT

    const turn1 = executeTurn(state, [null, null], deps())
    expect(turn1.fieldEndTurn.filter((r) => r.effect === 'TOXIC_TERRAIN').map((r) => r.hpChange)).toEqual([-10, -10])
    expect(state.field.timers.terrainTimer).toBe(3) // permanent: no decrement

    const turn2 = executeTurn(state, [null, null], deps())
    expect(turn2.fieldEndTurn.filter((r) => r.effect === 'TOXIC_TERRAIN').map((r) => r.hpChange)).toEqual([-10, -10])
    expect(hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(140)
  })

  it('Stench on the field freezes the countdown (:2127) so the bit survives and the non-Stench battler keeps chipping', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, abilities: { ability: STENCH, innates: [null, null, null] } }, { spe: 50, maxHp: 160 }],
      scripted(),
    )
    state.field.statuses = STATUS_FIELD_TOXIC_TERRAIN
    state.field.timers.terrainTimer = 2

    for (const expectedHp of [150, 140]) {
      const out = executeTurn(state, [null, null], deps())
      // Battler 0 is AbilityBlocksToxicTerrain-immune; battler 1 is not.
      expect(out.fieldEndTurn.filter((r) => r.effect === 'TOXIC_TERRAIN')).toEqual([
        { battlerId: 1, effect: 'TOXIC_TERRAIN', hpChange: -10, fainted: false },
      ])
      expect(state.battlers[1]!.mon.hp).toBe(expectedHp)
      expect(state.battlers[0]!.mon.hp).toBe(160)
    }
    expect(state.field.timers.terrainTimer).toBe(2) // frozen by Stench
    expect(hasFlag(state.field.statuses, STATUS_FIELD_TOXIC_TERRAIN)).toBe(true)
  })

  it('a Poison-typed battler is never chipped (FILTER_NOT(IS_BATTLER_OF_TYPE(TYPE_POISON)), :2138)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, types: ['POISON', 'MYSTERY', 'MYSTERY'] }, { spe: 50, maxHp: 160, types: ['STEEL', 'MYSTERY', 'MYSTERY'] }],
      scripted(),
    )
    state.field.statuses = STATUS_FIELD_TOXIC_TERRAIN
    state.field.timers.terrainTimer = 2
    for (let turn = 0; turn < 2; turn++) {
      const out = executeTurn(state, [null, null], deps())
      expect(out.fieldEndTurn.filter((r) => r.effect === 'TOXIC_TERRAIN')).toEqual([])
    }
    expect(state.battlers[0]!.mon.hp).toBe(160)
    expect(state.battlers[1]!.mon.hp).toBe(160)
  })
})

describe('ENDTURN_GRASSY_TERRAIN: the clearing tick still heals (VARIOUS_CHECK_IF_GRASSY_TERRAIN_HEALS, battle_script_commands.c:6876-6886)', () => {
  it('timer 1 on a grounded battler at 80/160 heals floor(160/16) = 10 on the clearing tick and clears the bit', () => {
    // battle_util.c:2100-2112 clears the bit, then calls
    // BattleScript_GrassyTerrainHeals unconditionally; the heal gate never tests
    // the field bit, so unlike Toxic Terrain this tick heals. Left as-is.
    const state = battle([{ spe: 100, maxHp: 160, hp: 80 }, { spe: 50, maxHp: 100 }], scripted())
    state.field.statuses = STATUS_FIELD_GRASSY_TERRAIN
    state.field.timers.terrainTimer = 1
    const out = executeTurn(state, [null, null], deps())
    expect(state.field.timers.terrainTimer).toBe(0)
    expect(hasFlag(state.field.statuses, STATUS_FIELD_GRASSY_TERRAIN)).toBe(false)
    expect(out.fieldEndTurn.filter((r) => r.effect === 'GRASSY_TERRAIN' && r.battlerId === 0)).toEqual([
      { battlerId: 0, effect: 'GRASSY_TERRAIN', hpChange: 10, fainted: false },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(90)
  })
})
