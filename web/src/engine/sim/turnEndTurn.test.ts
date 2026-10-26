// executeTurn's end-of-turn battler ladder (DoBattlerEndTurnEffects) -- see
// endTurn.ts's header for the C citations, the loop structure and the full
// enum-ordered classification (ported/unreachable/gapped) of every ENDTURN_*
// case. Split out the same way turnCanceller.test.ts split from turn.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import {
  DEFAULT_STAT_STAGE,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS1_TOXIC_COUNTER,
  STATUS1_TOXIC_POISON,
  STATUS2_CURSED,
  STATUS2_NIGHTMARE,
  STATUS2_WRAPPED,
  STATUS3_GASTRO_ACID,
  STATUS3_HEAL_BLOCK,
  STATUS_FIELD_TOXIC_TERRAIN,
  WEATHER_FOG_TEMPORARY,
  WEATHER_HAIL_TEMPORARY,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
  getCounter,
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
    grouping: (it.grouping as string | null) ?? null,
  }
}
function requireSpecies(id: string): string {
  if (!speciesIds.has(id)) throw new Error(`species.json has no ${id}`)
  return id
}

// Fail loudly, not by a silently-vacuous test later, if any of these ids are
// ever renamed or removed.
const MUDKIP = requireSpecies('SPECIES_MUDKIP')
const MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')
const TOXIC_BOOST = requireAbility('ABILITY_TOXIC_BOOST')
const POISON_HEAL = requireAbility('ABILITY_POISON_HEAL')
const SPEED_BOOST = requireAbility('ABILITY_SPEED_BOOST') // has an onEndTurn hook per abilityHooks.json
const MAXIMUM_ACCELERATION = requireAbility('ABILITY_MAXIMUM_ACCELERATION')
const RAIN_DISH = requireAbility('ABILITY_RAIN_DISH')
const ICE_BODY = requireAbility('ABILITY_ICE_BODY')
const SUNDAE = requireAbility('ABILITY_SUNDAE')
const DRY_SKIN = requireAbility('ABILITY_DRY_SKIN')
const HYDRATION = requireAbility('ABILITY_HYDRATION')
const PURIFYING_WATERS = requireAbility('ABILITY_PURIFYING_WATERS')
const SHED_SKIN = requireAbility('ABILITY_SHED_SKIN')
const PATTERN_CHANGE = requireAbility('ABILITY_PATTERN_CHANGE')
const WONDER_SCALE = requireAbility('ABILITY_WONDER_SCALE')
const SELF_SUFFICIENT = requireAbility('ABILITY_SELF_SUFFICIENT')
const SELF_REPAIR = requireAbility('ABILITY_SELF_REPAIR')
const DUNE_VEIL = requireAbility('ABILITY_DUNE_VEIL')
const POISON_ABSORB = requireAbility('ABILITY_POISON_ABSORB')
const GAPPED_END_TURN_ABILITY = requireAbility('ABILITY_LIFE_STEAL') // onEndTurn hook still unported (Bad Dreams used to stand here)
const LEFTOVERS = requireItem('ITEM_LEFTOVERS')
if (LEFTOVERS.resolvedHoldEffect !== 'HOLD_EFFECT_LEFTOVERS') throw new Error('ITEM_LEFTOVERS no longer resolves to HOLD_EFFECT_LEFTOVERS')
const TOXIC_ORB = requireItem('ITEM_TOXIC_ORB')
if (TOXIC_ORB.resolvedHoldEffect !== 'HOLD_EFFECT_TOXIC_ORB') throw new Error('ITEM_TOXIC_ORB no longer resolves to HOLD_EFFECT_TOXIC_ORB')

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
    spe: number
    hp?: number
    maxHp?: number
    status1?: number
    abilities?: SimBattleMon['abilities']
    itemId?: string | null
    types?: SimBattleMon['types']
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe },
          hp: s.hp ?? s.maxHp ?? 100,
          maxHp: s.maxHp ?? 100,
          status1: s.status1 ?? 0,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          itemId: s.itemId ?? null,
          ...(s.types ? { types: s.types } : {}),
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

/** `itemsOf` makes grounding.holdEffectOf read the battlers' real held items, as the production wiring does. */
function deps(damage: DamageResolver = THROWING_DAMAGE_RESOLVER, itemsOf?: BattleState): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const grounding = itemsOf
    ? {
        ...GROUNDING,
        holdEffectOf: (id: number) => {
          const itemId = itemsOf.battlers[id]?.mon.itemId
          return itemId ? (DATA_CONTEXT.item(itemId)?.resolvedHoldEffect ?? null) : null
        },
      }
    : GROUNDING
  return { turnOrder: rest, grounding, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('executeTurn: end-turn ladder -- ENDTURN_POISON (battle_util.c:2492-2515)', () => {
  it('deals floor(maxHp/8) when the fraction is exact', () => {
    const state = battle([{ spe: 100, maxHp: 80, status1: STATUS1_POISON }, { spe: 50, maxHp: 100 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'POISON', hpChange: -10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(70)
  })

  it('floors to 0 and the minimum-1 rule applies', () => {
    // maxHp=7 -> 7/8 = 0 before the minimum-1 rule.
    const state = battle([{ spe: 100, maxHp: 7, status1: STATUS1_POISON }, { spe: 50, maxHp: 100 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'POISON', hpChange: -1, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(6)
  })

  it('Magic Guard prevents the damage entirely -- no outcome, no HP change', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, status1: STATUS1_POISON, abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })

  it('Toxic Boost prevents the damage entirely (the C\'s own TOXIC_BOOST_CHECK)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, status1: STATUS1_POISON, abilities: { ability: TOXIC_BOOST, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })

  it('Poison Heal heals floor(maxHp/8) instead of damaging', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, status1: STATUS1_POISON, abilities: { ability: POISON_HEAL, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'POISON', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })

  it('Poison Heal does not overheal past max HP -- BATTLER_MAX_HP gates it, no outcome', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 80, status1: STATUS1_POISON, abilities: { ability: POISON_HEAL, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_BAD_POISON / toxic (battle_util.c:2516-2544)', () => {
  it('the counter increments and damage grows across two consecutive executeTurn calls', () => {
    // maxHp=160 -> dmgPerTurn = max(1, floor(160/16)) = 10; turn 1 counter=1 -> 10, turn 2 counter=2 -> 20.
    const state = battle([{ spe: 100, maxHp: 160, status1: STATUS1_TOXIC_POISON }, { spe: 50, maxHp: 100 }], scripted())

    const out1 = executeTurn(state, [null, null], deps())
    expect(out1.endTurn).toEqual([{ battlerId: 0, effect: 'TOXIC', hpChange: -10, fainted: false }])
    expect(getCounter(state.battlers[0]!.mon.status1, STATUS1_TOXIC_COUNTER)).toBe(1)
    expect(state.battlers[0]!.mon.hp).toBe(150)

    const out2 = executeTurn(state, [null, null], deps())
    expect(out2.endTurn).toEqual([{ battlerId: 0, effect: 'TOXIC', hpChange: -20, fainted: false }])
    expect(getCounter(state.battlers[0]!.mon.status1, STATUS1_TOXIC_COUNTER)).toBe(2)
    expect(state.battlers[0]!.mon.hp).toBe(130)
  })

  it('Poison Heal heals instead and does NOT increment the toxic counter (the C\'s increment lives only in the non-heal branch)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, status1: STATUS1_TOXIC_POISON, abilities: { ability: POISON_HEAL, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'TOXIC', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(60)
    expect(getCounter(state.battlers[0]!.mon.status1, STATUS1_TOXIC_COUNTER)).toBe(0)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_BURN (battle_util.c:2573-2582)', () => {
  it('deals floor(maxHp/16) -- B_BURN_DAMAGE is pinned to GEN_7 in this C, no separate ER fraction', () => {
    const state = battle([{ spe: 100, maxHp: 160, status1: STATUS1_BURN }, { spe: 50, maxHp: 100 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'BURN', hpChange: -10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(150)
  })

  it('floors to 0 and the minimum-1 rule applies', () => {
    const state = battle([{ spe: 100, maxHp: 15, status1: STATUS1_BURN }, { spe: 50, maxHp: 100 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'BURN', hpChange: -1, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(14)
  })

  it('Magic Guard prevents burn damage too', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, status1: STATUS1_BURN, abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(160)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_FROSTBITE (battle_util.c:2584-2596)', () => {
  it('deals floor(maxHp/16), minimum 1', () => {
    const state = battle([{ spe: 100, maxHp: 160, status1: STATUS1_FROSTBITE }, { spe: 50, maxHp: 100 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'FROSTBITE', hpChange: -10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(150)

    const tiny = battle([{ spe: 100, maxHp: 15, status1: STATUS1_FROSTBITE }, { spe: 50, maxHp: 100 }], scripted())
    expect(executeTurn(tiny, [null, null], deps()).endTurn).toEqual([{ battlerId: 0, effect: 'FROSTBITE', hpChange: -1, fainted: false }])
  })

  it('Magic Guard prevents it', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, status1: STATUS1_FROSTBITE, abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    expect(executeTurn(state, [null, null], deps()).endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(160)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_BLEED (battle_util.c:2598-2607)', () => {
  it('deals floor(maxHp/16) (BLEED_DAMAGE), minimum 1', () => {
    const state = battle([{ spe: 100, maxHp: 160, status1: STATUS1_BLEED }, { spe: 50, maxHp: 100 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'BLEED', hpChange: -10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(150)
  })

  it('Magic Guard prevents it', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, status1: STATUS1_BLEED, abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    expect(executeTurn(state, [null, null], deps()).endTurn).toEqual([])
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_NIGHTMARES (battle_util.c:2608-2622)', () => {
  it('deals floor(maxHp/4) while asleep', () => {
    const state = battle([{ spe: 100, maxHp: 160, status1: STATUS1_SLEEP }, { spe: 50, maxHp: 100 }], scripted())
    state.battlers[0]!.mon.status2 |= STATUS2_NIGHTMARE
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'NIGHTMARE', hpChange: -40, fainted: false }])
  })

  it('silently clears the flag when the battler is awake', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.battlers[0]!.mon.status2 |= STATUS2_NIGHTMARE
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.status2 & STATUS2_NIGHTMARE).toBe(0)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_CURSE (battle_util.c:2624-2633)', () => {
  it('deals floor(maxHp/4)', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.battlers[0]!.mon.status2 |= STATUS2_CURSED
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'CURSE', hpChange: -40, fainted: false }])
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_WRAP (battle_util.c:2662-2704)', () => {
  it('--wrapTurns, then maxHp/8 while turns remain', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.battlers[0]!.mon.status2 |= STATUS2_WRAPPED
    state.battlers[0]!.volatiles.wrapTurns = 3
    state.wrappedBy[0] = 1
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'WRAP', hpChange: -20, fainted: false }])
    expect(state.battlers[0]!.volatiles.wrapTurns).toBe(2)
  })

  it('breaks free without damage when the counter reaches 0', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100 }], scripted())
    state.battlers[0]!.mon.status2 |= STATUS2_WRAPPED
    state.battlers[0]!.volatiles.wrapTurns = 1
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.status2 & STATUS2_WRAPPED).toBe(0)
  })

  it('maxHp/6 when the wrapper has a grappler ability (HasGrappler)', () => {
    const state = battle([{ spe: 100, maxHp: 160 }, { spe: 50, maxHp: 100, abilities: { ability: 'ABILITY_GRAPPLER', innates: [null, null, null] } }], scripted())
    state.battlers[0]!.mon.status2 |= STATUS2_WRAPPED
    state.battlers[0]!.volatiles.wrapTurns = 3
    state.wrappedBy[0] = 1
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'WRAP', hpChange: -26, fainted: false }])
  })
})

describe('executeTurn: end-turn ladder -- fainting and battler order', () => {
  it('a battler that faints from residual damage is reported, floors at 0, and takes no further residual damage this pass', () => {
    // Both poisoned AND burned; poison alone (maxHp/8) brings hp to exactly 0,
    // so BURN's own `hp != 0` guard (:2574) must skip it entirely.
    const state = battle([{ spe: 100, maxHp: 80, hp: 10, status1: STATUS1_POISON | STATUS1_BURN }, { spe: 50, maxHp: 100 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'POISON', hpChange: -10, fainted: true }])
    expect(state.battlers[0]!.mon.hp).toBe(0)
  })

  it('residuals run in gBattlerByTurnOrder order -- the faster battler\'s ladder completes before the slower one\'s even starts', () => {
    // Battler 1 is faster (spe 200) than battler 0 (spe 50); both poisoned with
    // maxHp chosen so the two damage amounts are distinguishable.
    const state = battle([{ spe: 50, maxHp: 80, status1: STATUS1_POISON }, { spe: 200, maxHp: 160, status1: STATUS1_POISON }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.order.battlerByTurnOrder).toEqual([1, 0])
    expect(out.endTurn).toEqual([
      { battlerId: 1, effect: 'POISON', hpChange: -20, fainted: false },
      { battlerId: 0, effect: 'POISON', hpChange: -10, fainted: false },
    ])
  })
})

describe('executeTurn: end-turn ladder -- runtime gap lines (endTurn.ts header table)', () => {
  it('gaps ENDTURN_ABILITIES exactly when the battler\'s own ability has an unmodelled onEndTurn hook, and not otherwise', () => {
    const withHook = battle([{ spe: 100, maxHp: 100, abilities: { ability: GAPPED_END_TURN_ABILITY, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }], scripted())
    const out1 = executeTurn(withHook, [null, null], deps())
    expect(out1.endTurnUnmodelled).toContain(`battler 0: ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied -- ${GAPPED_END_TURN_ABILITY}'s onEndTurn hook was not run`)

    const withoutHook = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out2 = executeTurn(withoutHook, [null, null], deps())
    expect(out2.endTurnUnmodelled.some((m) => m.includes('ENDTURN_ABILITIES'))).toBe(false)
  })

  it('gaps ENDTURN_ABILITIES for an innate slot too (ABILITYEFFECT_ENDTURN loops every slot, battle_util.c:4397-4399)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: MAGIC_GUARD, innates: [null, GAPPED_END_TURN_ABILITY, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurnUnmodelled).toContain(`battler 0: ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied -- ${GAPPED_END_TURN_ABILITY}'s onEndTurn hook was not run`)
  })

  it('restores HP with Leftovers at end of turn and does not emit ENDTURN_ITEMS1 gap', () => {
    const withItem = battle([{ spe: 100, hp: 80, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }, { spe: 50, maxHp: 100 }], scripted())
    const out1 = executeTurn(withItem, [null, null], deps(undefined, withItem))
    expect(withItem.battlers[0]!.mon.hp).toBe(86) // 80 + floor(100/16) = 86
    expect(out1.endTurn).toEqual([
      { battlerId: 0, effect: 'ITEM', hpChange: 6, fainted: false },
    ])
    expect(out1.endTurnUnmodelled.some((m) => m.includes('ENDTURN_ITEMS'))).toBe(false)

    const withoutItem = battle([{ spe: 100, maxHp: 100 }, { spe: 50, maxHp: 100 }], scripted())
    const out2 = executeTurn(withoutItem, [null, null], deps())
    expect(out2.endTurnUnmodelled.some((m) => m.includes('ENDTURN_ITEMS'))).toBe(false)
  })

  it('inflicts toxic poison with Toxic Orb at end of turn and does not emit ENDTURN_ORBS gap', () => {
    const withOrb = battle([{ spe: 100, maxHp: 100, itemId: 'ITEM_TOXIC_ORB' }, { spe: 50, maxHp: 100 }], scripted())
    const out1 = executeTurn(withOrb, [null, null], deps(undefined, withOrb))
    expect(withOrb.battlers[0]!.mon.status1 & STATUS1_TOXIC_POISON).toBe(STATUS1_TOXIC_POISON)
    expect(withOrb.battlers[0]!.mon.hp).toBe(94) // 100 - floor(100/16) = 94 from bad poison
    expect(out1.endTurnUnmodelled.some((m) => m.includes('ENDTURN_ORBS'))).toBe(false)

    const withoutOrb = battle([{ spe: 100, maxHp: 100 }, { spe: 50, maxHp: 100 }], scripted())
    const out2 = executeTurn(withoutOrb, [null, null], deps())
    expect(out2.endTurnUnmodelled.some((m) => m.includes('ENDTURN_ORBS'))).toBe(false)
  })

  it('a battler with no held item, no ability and no status carries NO end-turn gap lines at all -- nothing gaps unconditionally', () => {
    const state = battle([{ spe: 100, maxHp: 100 }, { spe: 50, maxHp: 100 }], scripted())
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(out.endTurnUnmodelled).toEqual([])
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: Speed Boost (battle_util.c:2452, abilities.cc:515-524)', () => {
  it('raises Speed by 1 at end of turn when not the switch-in turn (isFirstTurn != 2)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: SPEED_BOOST, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(out.endTurn).toEqual([])
  })

  it('does NOT raise Speed on the turn the battler enters battle (isFirstTurn == 2 guard)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: SPEED_BOOST, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 2
    expect(state.battlers[0]!.volatiles.isFirstTurn).toBe(2)
    executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })

  it('does NOT raise Speed if Speed is already at maximum (+6 stages / stage 12)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: SPEED_BOOST, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.battlers[0]!.mon.statStages[STAT_SPEED] = 12
    executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(12)
  })

  it('Maximum Acceleration shares Speed Boost implementation (abilities.cc:8419)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: MAXIMUM_ACCELERATION, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: Rain Dish (abilities.cc:1063-1074)', () => {
  it('heals floor(maxHp/8) in rain when damaged and not on switch-in turn', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: RAIN_DISH, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })

  it('floors to 0 and respects the minimum-1 rule (maxHp=7 -> 1 HP heal)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 7, hp: 5, abilities: { ability: RAIN_DISH, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 1, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(6)
  })

  it('does not heal if weather is not rain', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: RAIN_DISH, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = 0
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('does not heal on switch-in turn (isFirstTurn == 2)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: RAIN_DISH, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 2
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('does not heal if battler is already at full HP (BATTLER_MAX_HP)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 80, abilities: { ability: RAIN_DISH, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })

  it('does not heal under Heal Block (CanBattlerHeal)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: RAIN_DISH, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: Ice Body (abilities.cc:1778-1789) & Sundae (abilities.cc:11284)', () => {
  it('heals floor(maxHp/8) in hail when damaged and not on switch-in turn', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: ICE_BODY, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = WEATHER_HAIL_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })

  it('does not heal if weather is not hail', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: ICE_BODY, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = 0
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('Sundae shares Ice Body implementation and heals in hail (abilities.cc:11284)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: SUNDAE, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = WEATHER_HAIL_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: Dry Skin (abilities.cc:1498-1510)', () => {
  it('heals in rain by delegating to Rain Dish implementation', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: DRY_SKIN, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(60)
  })

  it('takes floor(maxHp/8) damage in sun, even on switch-in turn (no isFirstTurn guard)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: DRY_SKIN, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 2
    expect(state.battlers[0]!.volatiles.isFirstTurn).toBe(2)
    state.field.weather = WEATHER_SUN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: -10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(40)
  })

  it('sun damage floors to 0 and respects the minimum-1 rule (maxHp=7 -> 1 HP damage)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 7, hp: 5, abilities: { ability: DRY_SKIN, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = WEATHER_SUN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: -1, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(4)
  })

  it('Magic Guard prevents sun damage (!IsMagicGuardProtected)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: DRY_SKIN, innates: [MAGIC_GUARD, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = WEATHER_SUN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('Heal Block does NOT prevent sun damage (only blocks healing, not damage)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: DRY_SKIN, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    state.field.weather = WEATHER_SUN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: -10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(40)
  })

  it('sun damage can cause battler to faint', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 5, abilities: { ability: DRY_SKIN, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = WEATHER_SUN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: -5, fainted: true }])
    expect(state.battlers[0]!.mon.hp).toBe(0)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: Hydration (abilities.cc:1549-1558) & Purifying Waters (abilities.cc:6459)', () => {
  it('cures status1 in rain before ENDTURN_POISON runs, preventing poison damage this turn', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 80, status1: STATUS1_POISON, abilities: { ability: HYDRATION, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })

  it('does not cure status1 if weather is not rain, so poison damage still occurs', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 80, status1: STATUS1_POISON, abilities: { ability: HYDRATION, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = 0
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_POISON)
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'POISON', hpChange: -10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(70)
  })

  it('Purifying Waters shares Hydration implementation and cures status in rain (abilities.cc:6459)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 80, status1: STATUS1_BURN, abilities: { ability: PURIFYING_WATERS, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: Shed Skin (abilities.cc:1278-1287), Pattern Change (abilities.cc:8301) & Wonder Scale (abilities.cc:10024)', () => {
  it('cures status1 on successful roll (Random() % 100 < 30), preventing burn damage this turn', () => {
    // scripted roll of 29: 29 % 100 = 29 < 30 -> cures status1
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 160, status1: STATUS1_BURN, abilities: { ability: SHED_SKIN, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(29),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(160)
  })

  it('fails to cure status1 on roll >= 30, so burn damage occurs (floor(160/16) = 10)', () => {
    // scripted roll of 30: 30 % 100 = 30, not < 30 -> fails to cure
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 160, status1: STATUS1_BURN, abilities: { ability: SHED_SKIN, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(30),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN)
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'BURN', hpChange: -10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(150)
  })

  it('Pattern Change shares Shed Skin implementation and cures status on successful roll (abilities.cc:8301)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 160, status1: STATUS1_BURN, abilities: { ability: PATTERN_CHANGE, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(0),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(160)
  })

  it('Wonder Scale shares Shed Skin implementation and cures status on successful roll (abilities.cc:10024)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 160, status1: STATUS1_BURN, abilities: { ability: WONDER_SCALE, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(15),
    )
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(160)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: Self-Sufficient (abilities.cc:4041-4054), Self-Repair (abilities.cc:5294) & Dune Veil (abilities.cc:10960)', () => {
  it('heals floor(maxHp/16) when damaged and not on switch-in turn', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 100, abilities: { ability: SELF_SUFFICIENT, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(110)
  })

  it('floors to 0 and respects the minimum-1 rule (maxHp=15 -> 1 HP heal)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 15, hp: 10, abilities: { ability: SELF_SUFFICIENT, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 1, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(11)
  })

  it('does not heal on switch-in turn (isFirstTurn == 2)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 100, abilities: { ability: SELF_SUFFICIENT, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 2
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('does not heal if at full HP (BATTLER_MAX_HP)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 160, abilities: { ability: SELF_SUFFICIENT, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(160)
  })

  it('does not heal under Heal Block (CanBattlerHeal)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 100, abilities: { ability: SELF_SUFFICIENT, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Self-Repair shares Self-Sufficient implementation (abilities.cc:5294)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 100, abilities: { ability: SELF_REPAIR, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(110)
  })

  it('Dune Veil shares Self-Sufficient implementation (abilities.cc:10960)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 100, abilities: { ability: DUNE_VEIL, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false }])
    expect(state.battlers[0]!.mon.hp).toBe(110)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: Poison Absorb (abilities.cc:4438-4449)', () => {
  it('heals floor(maxHp/8) in Toxic Terrain when grounded, damaged and not on switch-in turn', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: POISON_ABSORB, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([{ battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false }])
    // The field ladder's Toxic Terrain chip (80 / 16 = 5) runs first: 50 - 5 + 10.
    expect(state.battlers[0]!.mon.hp).toBe(55)
  })

  it('does not heal outside Toxic Terrain', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: POISON_ABSORB, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })

  it('does not heal if ungrounded in Toxic Terrain (Flying type)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 80, hp: 50, abilities: { ability: POISON_ABSORB, innates: [null, null, null] }, types: ['FLYING', 'FLYING', 'FLYING'] }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.statuses |= STATUS_FIELD_TOXIC_TERRAIN
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([])
    expect(state.battlers[0]!.mon.hp).toBe(50)
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES: slot dispatch, innates & suppression (battle_util.c:4397-4399, :9213-9239)', () => {
  it('triggers end-turn abilities placed in innate slots', () => {
    const state = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: MAGIC_GUARD, innates: [null, SPEED_BOOST, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('runs innate slots before chosen ability slot in exact C order (innate[2], innate[1], innate[0], ability)', () => {
    // Battler with innate Rain Dish (innate[0]) and chosen Self-Sufficient (ability).
    // In rain, maxHp 160, hp 100: Rain Dish heals 20 (to 120), Self-Sufficient heals 10 (to 130).
    const state = battle(
      [{ spe: 100, maxHp: 160, hp: 100, abilities: { ability: SELF_SUFFICIENT, innates: [RAIN_DISH, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.field.weather = WEATHER_RAIN_TEMPORARY
    const out = executeTurn(state, [null, null], deps())
    expect(out.endTurn).toEqual([
      { battlerId: 0, effect: 'ABILITY', hpChange: 20, fainted: false },
      { battlerId: 0, effect: 'ABILITY', hpChange: 10, fainted: false },
    ])
    expect(state.battlers[0]!.mon.hp).toBe(130)
  })

  it('suppresses end-turn ability when Gastro Acid is active (STATUS3_GASTRO_ACID, battle_util.c:9233)', () => {
    const state = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: SPEED_BOOST, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    state.battlers[0]!.volatiles.isFirstTurn = 0
    state.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    const out = executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    expect(out.endTurn).toEqual([])
    expect(out.endTurnUnmodelled).toEqual([])
  })
})

describe('executeTurn: end-turn ladder -- ENDTURN_ABILITIES (Sweet Dreams, Peaceful Rest, Leaf Guard, Healer, Harvest, Bad Dreams)', () => {
  const ab = (id: string) => ({ ability: requireAbility(id), innates: [null, null, null] as [null, null, null] })

  it('Sweet Dreams heals maxHp/8 while asleep, not while awake', () => {
    const asleep = battle([{ spe: 100, maxHp: 160, hp: 100, status1: STATUS1_SLEEP, abilities: ab('ABILITY_SWEET_DREAMS') }, { spe: 50 }], scripted())
    executeTurn(asleep, [null, null], deps())
    expect(asleep.battlers[0]!.mon.hp).toBe(120)
    const awake = battle([{ spe: 100, maxHp: 160, hp: 100, abilities: ab('ABILITY_SWEET_DREAMS') }, { spe: 50 }], scripted())
    executeTurn(awake, [null, null], deps())
    expect(awake.battlers[0]!.mon.hp).toBe(100)
  })

  it('Peaceful Rest heals maxHp/8 in fog only', () => {
    const fog = battle([{ spe: 100, maxHp: 160, hp: 100, abilities: ab('ABILITY_PEACEFUL_REST') }, { spe: 50 }], scripted())
    fog.field.weather |= WEATHER_FOG_TEMPORARY
    executeTurn(fog, [null, null], deps())
    expect(fog.battlers[0]!.mon.hp).toBe(120)
    const clear = battle([{ spe: 100, maxHp: 160, hp: 100, abilities: ab('ABILITY_PEACEFUL_REST') }, { spe: 50 }], scripted())
    executeTurn(clear, [null, null], deps())
    expect(clear.battlers[0]!.mon.hp).toBe(100)
  })

  it('Leaf Guard cures the primary status in sun', () => {
    const state = battle([{ spe: 100, maxHp: 160, status1: STATUS1_SLEEP, abilities: ab('ABILITY_LEAF_GUARD') }, { spe: 50 }], scripted())
    state.field.weather |= WEATHER_SUN_TEMPORARY
    executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })

  it('Healer cures its own status on a roll under 30', () => {
    const cured = battle([{ spe: 100, maxHp: 160, status1: STATUS1_BURN, abilities: ab('ABILITY_HEALER') }, { spe: 50 }], scripted(10, 10, 10, 10))
    executeTurn(cured, [null, null], deps())
    expect(cured.battlers[0]!.mon.status1).toBe(0)
    const kept = battle([{ spe: 100, maxHp: 160, status1: STATUS1_BURN, abilities: ab('ABILITY_HEALER') }, { spe: 50 }], scripted(60, 60, 60, 60))
    executeTurn(kept, [null, null], deps())
    expect(kept.battlers[0]!.mon.status1).toBe(STATUS1_BURN)
  })

  it('Harvest restores the last consumed berry in sun', () => {
    const state = battle([{ spe: 100, maxHp: 160, abilities: ab('ABILITY_HARVEST') }, { spe: 50 }], scripted())
    state.field.weather |= WEATHER_SUN_TEMPORARY
    state.battlers[0]!.usedHeldItem = 'ITEM_ORAN_BERRY'
    executeTurn(state, [null, null], deps())
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_ORAN_BERRY')
  })

  it('Bad Dreams takes maxHp/4 from a sleeping foe, and Sweet Dreams on the foe prevents it', () => {
    const state = battle([{ spe: 100, maxHp: 160, abilities: ab('ABILITY_BAD_DREAMS') }, { spe: 50, maxHp: 80, status1: STATUS1_SLEEP }], scripted())
    executeTurn(state, [null, null], deps())
    expect(state.battlers[1]!.mon.hp).toBe(60)
    const protectedFoe = battle([{ spe: 100, maxHp: 160, abilities: ab('ABILITY_BAD_DREAMS') }, { spe: 50, maxHp: 80, status1: STATUS1_SLEEP, abilities: ab('ABILITY_SWEET_DREAMS') }], scripted())
    executeTurn(protectedFoe, [null, null], deps())
    expect(protectedFoe.battlers[1]!.mon.hp).toBe(80)
  })
})
