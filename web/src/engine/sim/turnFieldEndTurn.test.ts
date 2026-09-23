// executeTurn's field-wide end-of-turn ladder (DoFieldEndTurnEffects) -- see
// fieldEndTurn.ts's header for the C citations, the loop structure and the
// full enum-ordered classification (ported/unreachable/gapped) of every
// ENDTURN_FIELD_* case. Split out the same way turnEndTurn.test.ts split from
// turn.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import {
  STATUS1_POISON,
  SIDE_STATUS_REFLECT,
  SIDE_STATUS_LIGHTSCREEN,
  WEATHER_SANDSTORM_TEMPORARY,
  WEATHER_SANDSTORM_PERMANENT,
  WEATHER_HAIL_TEMPORARY,
  STATUS_FIELD_TOXIC_TERRAIN,
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
const SAND_VEIL = requireAbility('ABILITY_SAND_VEIL')
const ICE_BODY = requireAbility('ABILITY_ICE_BODY')
const MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')
const SAFETY_GOGGLES = requireItem('ITEM_SAFETY_GOGGLES')
if (SAFETY_GOGGLES.resolvedHoldEffect !== 'HOLD_EFFECT_SAFETY_GOGGLES') throw new Error('ITEM_SAFETY_GOGGLES no longer resolves to HOLD_EFFECT_SAFETY_GOGGLES')

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

describe('executeTurn: field end-turn ladder -- weather timers (ENDTURN_SANDSTORM/HAIL, battle_util.c:1968-2018)', () => {
  it('decrements weatherDuration and expires at 0, clearing the weather bit -- no damage on the expiry turn', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    state.field.weatherDuration = 1
    const out = executeTurn(state, [null, null], deps())
    expect(state.field.weatherDuration).toBe(0)
    expect(hasFlag(state.field.weather, WEATHER_SANDSTORM_TEMPORARY)).toBe(false)
    expect(out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM')).toEqual([])
  })

  it('permanent weather does not expire and keeps dealing damage every turn', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    state.field.weatherDuration = 1
    const out = executeTurn(state, [null, null], deps())
    expect(state.field.weatherDuration).toBe(1) // never decremented
    expect(hasFlag(state.field.weather, WEATHER_SANDSTORM_PERMANENT)).toBe(true)
    expect(out.fieldEndTurn.some((r) => r.effect === 'SANDSTORM')).toBe(true)
  })

  it('weather set this turn does not decrement (the started gating) but still deals damage that same turn', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_SANDSTORM_TEMPORARY
    state.field.weatherDuration = 5
    state.field.timers.started.weather = true
    const out = executeTurn(state, [null, null], deps())
    expect(state.field.weatherDuration).toBe(5) // untouched
    expect(hasFlag(state.field.weather, WEATHER_SANDSTORM_TEMPORARY)).toBe(true)
    expect(out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM')).toHaveLength(2)
  })
})

describe('executeTurn: field end-turn ladder -- side timer + status expiry (ENDTURN_REFLECT/LIGHT_SCREEN)', () => {
  it('Reflect decrements and clears the side condition on expiry, per side, independently', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scripted())
    state.sides[0].statuses = SIDE_STATUS_REFLECT
    state.sides[0].timers.reflectTimer = 1
    state.sides[1].statuses = SIDE_STATUS_REFLECT
    state.sides[1].timers.reflectTimer = 3
    executeTurn(state, [null, null], deps())
    expect(state.sides[0].timers.reflectTimer).toBe(0)
    expect(hasFlag(state.sides[0].statuses, SIDE_STATUS_REFLECT)).toBe(false)
    expect(state.sides[1].timers.reflectTimer).toBe(2)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_REFLECT)).toBe(true)
  })

  it('Light Screen decrements and clears the side condition on expiry', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scripted())
    state.sides[1].statuses = SIDE_STATUS_LIGHTSCREEN
    state.sides[1].timers.lightscreenTimer = 1
    executeTurn(state, [null, null], deps())
    expect(state.sides[1].timers.lightscreenTimer).toBe(0)
    expect(hasFlag(state.sides[1].statuses, SIDE_STATUS_LIGHTSCREEN)).toBe(false)
  })
})

describe('executeTurn: field end-turn ladder -- Cmd_weatherdamage (battle_script_commands.c:10397-10415)', () => {
  it('sandstorm deals floor(maxHp/16), minimum 1, to a Normal-type battler with no immunity', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM')).toEqual([
      { battlerId: 0, effect: 'SANDSTORM', hpChange: -10, fainted: false },
      { battlerId: 1, effect: 'SANDSTORM', hpChange: -6, fainted: false },
    ])
  })

  it('a Rock/Ground/Steel battler takes no sandstorm damage (IsSandImmune type check)', () => {
    const state = battle([{ spe: 100, maxHp: 160, types: ['ROCK', 'MYSTERY', 'MYSTERY'] }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM' && r.battlerId === 0)).toEqual([])
    expect(out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM' && r.battlerId === 1)).toHaveLength(1)
  })

  it('an ability immunity (Sand Veil, abilityHooks.json bitfields.sandImmune) takes no sandstorm damage', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, abilities: { ability: SAND_VEIL, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM' && r.battlerId === 0)).toEqual([])
  })

  it('Safety Goggles blocks sandstorm damage', () => {
    const state = battle([{ spe: 100, maxHp: 160, itemId: 'ITEM_SAFETY_GOGGLES' }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM' && r.battlerId === 0)).toEqual([])
  })

  it('Magic Guard blocks sandstorm damage', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM' && r.battlerId === 0)).toEqual([])
  })

  it('damage order is gBattlerByTurnOrder (fieldEndTurn.ts own ENDTURN_ORDER result), observable via which battler is reported first', () => {
    // battler 1 is faster (spe 200) than battler 0 (spe 50).
    const state = battle([{ spe: 50, maxHp: 160 }, { spe: 200, maxHp: 320 }], scripted())
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurnOrder).toEqual([1, 0])
    const sandstormOutcomes = out.fieldEndTurn.filter((r) => r.effect === 'SANDSTORM')
    expect(sandstormOutcomes.map((r) => r.battlerId)).toEqual([1, 0])
  })

  it('a battler that faints to sandstorm takes no poison damage afterwards in the battler ladder', () => {
    const state = battle([{ spe: 100, maxHp: 16, hp: 1, status1: STATUS1_POISON }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_SANDSTORM_PERMANENT
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.battlerId === 0)).toEqual([{ battlerId: 0, effect: 'SANDSTORM', hpChange: -1, fainted: true }])
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(out.endTurn.filter((r) => r.battlerId === 0)).toEqual([])
  })
})

describe('executeTurn: field end-turn ladder -- hail (own immunities)', () => {
  it('deals floor(maxHp/16), minimum 1, with no immunity', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.timers.started.weather = true // avoid the expiry branch entirely for this assertion
    state.field.weatherDuration = 5
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.effect === 'HAIL')).toEqual([
      { battlerId: 0, effect: 'HAIL', hpChange: -10, fainted: false },
      { battlerId: 1, effect: 'HAIL', hpChange: -6, fainted: false },
    ])
  })

  it('an Ice-type battler takes no hail damage', () => {
    const state = battle([{ spe: 100, maxHp: 160, types: ['ICE', 'MYSTERY', 'MYSTERY'] }, { spe: 50, maxHp: 100 }], scripted())
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.timers.started.weather = true
    state.field.weatherDuration = 5
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.effect === 'HAIL' && r.battlerId === 0)).toEqual([])
  })

  it('an ability immunity (Ice Body, abilityHooks.json bitfields.hailImmune) takes no hail damage', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, abilities: { ability: ICE_BODY, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = WEATHER_HAIL_TEMPORARY
    state.field.timers.started.weather = true
    state.field.weatherDuration = 5
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn.filter((r) => r.effect === 'HAIL' && r.battlerId === 0)).toEqual([])
  })
})

describe('executeTurn: field end-turn ladder -- runtime gap lines (fieldEndTurn.ts header table)', () => {
  it('gaps ENDTURN_FOG exactly when Fog weather is active, and not otherwise', () => {
    const withFog = battle([{ spe: 100 }, { spe: 50 }], scripted())
    withFog.field.weather = 1 << 13 // WEATHER_FOG_TEMPORARY
    const out1 = executeTurn(withFog, [null, null], deps())
    expect(out1.fieldEndTurnUnmodelled.some((m) => m.includes('ENDTURN_FOG'))).toBe(true)

    const withoutFog = battle([{ spe: 100 }, { spe: 50 }], scripted())
    const out2 = executeTurn(withoutFog, [null, null], deps())
    expect(out2.fieldEndTurnUnmodelled.some((m) => m.includes('ENDTURN_FOG'))).toBe(false)
  })

  it('gaps ENDTURN_GRASSY_TERRAIN\'s heal exactly per alive battler when Grassy Terrain is active, and not otherwise', () => {
    const withTerrain = battle([{ spe: 100 }, { spe: 50 }], scripted())
    withTerrain.field.statuses = 1 << 6 // STATUS_FIELD_GRASSY_TERRAIN
    withTerrain.field.timers.terrainTimer = 5
    const out1 = executeTurn(withTerrain, [null, null], deps())
    expect(out1.fieldEndTurnUnmodelled.filter((m) => m.includes('ENDTURN_GRASSY_TERRAIN'))).toHaveLength(2)

    const withoutTerrain = battle([{ spe: 100 }, { spe: 50 }], scripted())
    const out2 = executeTurn(withoutTerrain, [null, null], deps())
    expect(out2.fieldEndTurnUnmodelled.some((m) => m.includes('ENDTURN_GRASSY_TERRAIN'))).toBe(false)
  })

  it('gaps ENDTURN_TOXIC_TERRAIN\'s damage exactly for a grounded, non-immune battler, and not otherwise', () => {
    const withTerrain = battle([{ spe: 100 }, { spe: 50 }], scripted())
    withTerrain.field.statuses = STATUS_FIELD_TOXIC_TERRAIN
    withTerrain.field.timers.terrainTimer = 5
    const out1 = executeTurn(withTerrain, [null, null], deps())
    expect(out1.fieldEndTurnUnmodelled.filter((m) => m.includes('ENDTURN_TOXIC_TERRAIN'))).toHaveLength(2)

    const poisonTypeImmune = battle([{ spe: 100, types: ['POISON', 'MYSTERY', 'MYSTERY'] }, { spe: 50, types: ['STEEL', 'MYSTERY', 'MYSTERY'] }], scripted())
    poisonTypeImmune.field.statuses = STATUS_FIELD_TOXIC_TERRAIN
    poisonTypeImmune.field.timers.terrainTimer = 5
    const out2 = executeTurn(poisonTypeImmune, [null, null], deps())
    expect(out2.fieldEndTurnUnmodelled.some((m) => m.includes('ENDTURN_TOXIC_TERRAIN'))).toBe(false)

    const withoutTerrain = battle([{ spe: 100 }, { spe: 50 }], scripted())
    const out3 = executeTurn(withoutTerrain, [null, null], deps())
    expect(out3.fieldEndTurnUnmodelled.some((m) => m.includes('ENDTURN_TOXIC_TERRAIN'))).toBe(false)
  })

  it('gaps ENDTURN_CLEARSKIES exactly when its timer reaches zero this turn, and not otherwise', () => {
    const expiring = battle([{ spe: 100 }, { spe: 50 }], scripted())
    expiring.field.timers.clearSkiesTimer = 1
    const out1 = executeTurn(expiring, [null, null], deps())
    expect(out1.fieldEndTurnUnmodelled.some((m) => m.includes('ENDTURN_CLEARSKIES'))).toBe(true)

    const notExpiring = battle([{ spe: 100 }, { spe: 50 }], scripted())
    notExpiring.field.timers.clearSkiesTimer = 3
    const out2 = executeTurn(notExpiring, [null, null], deps())
    expect(out2.fieldEndTurnUnmodelled.some((m) => m.includes('ENDTURN_CLEARSKIES'))).toBe(false)

    const inactive = battle([{ spe: 100 }, { spe: 50 }], scripted())
    const out3 = executeTurn(inactive, [null, null], deps())
    expect(out3.fieldEndTurnUnmodelled.some((m) => m.includes('ENDTURN_CLEARSKIES'))).toBe(false)
  })

  it('a battle with no active field/side state carries NO field end-turn gap lines at all -- nothing gaps unconditionally', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.fieldEndTurn).toEqual([])
    expect(out.fieldEndTurnUnmodelled).toEqual([])
  })
})
