// executeTurn's end-of-turn battler ladder (DoBattlerEndTurnEffects) -- see
// endTurn.ts's header for the C citations, the loop structure and the full
// enum-ordered classification (ported/unreachable/gapped) of every ENDTURN_*
// case. Split out the same way turnCanceller.test.ts split from turn.test.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import { STATUS1_BURN, STATUS1_POISON, STATUS1_TOXIC_POISON, STATUS1_TOXIC_COUNTER, getCounter } from './constants'
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
const MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')
const TOXIC_BOOST = requireAbility('ABILITY_TOXIC_BOOST')
const POISON_HEAL = requireAbility('ABILITY_POISON_HEAL')
const SPEED_BOOST = requireAbility('ABILITY_SPEED_BOOST') // has an onEndTurn hook per abilityHooks.json
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

function battle(specs: { spe: number; hp?: number; maxHp?: number; status1?: number; abilities?: SimBattleMon['abilities']; itemId?: string | null }[], rng: RandomSource): BattleState {
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
  it('gaps ENDTURN_ABILITIES exactly when the battler\'s own ability has an onEndTurn hook, and not otherwise', () => {
    const withHook = battle([{ spe: 100, maxHp: 100, abilities: { ability: SPEED_BOOST, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }], scripted())
    const out1 = executeTurn(withHook, [null, null], deps())
    expect(out1.endTurnUnmodelled).toContain(`battler 0: ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied -- ${SPEED_BOOST}'s onEndTurn hook was not run`)

    const withoutHook = battle(
      [{ spe: 100, maxHp: 100, abilities: { ability: MAGIC_GUARD, innates: [null, null, null] } }, { spe: 50, maxHp: 100 }],
      scripted(),
    )
    const out2 = executeTurn(withoutHook, [null, null], deps())
    expect(out2.endTurnUnmodelled.some((m) => m.includes('ENDTURN_ABILITIES'))).toBe(false)
  })

  it('gaps ENDTURN_ITEMS1/ENDTURN_ITEMS2 exactly when the battler holds a recognised hold effect, and not otherwise', () => {
    const withItem = battle([{ spe: 100, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }, { spe: 50, maxHp: 100 }], scripted())
    const out1 = executeTurn(withItem, [null, null], deps())
    expect(out1.endTurnUnmodelled).toContain(
      `battler 0: ENDTURN_ITEMS1/ENDTURN_ITEMS2 (battle_util.c:5622-5855) are not applied -- ITEM_LEFTOVERS's end-of-turn hold effect (HOLD_EFFECT_LEFTOVERS) was not run`,
    )

    const withoutItem = battle([{ spe: 100, maxHp: 100 }, { spe: 50, maxHp: 100 }], scripted())
    const out2 = executeTurn(withoutItem, [null, null], deps())
    expect(out2.endTurnUnmodelled.some((m) => m.includes('ENDTURN_ITEMS'))).toBe(false)
  })

  it('gaps ENDTURN_ORBS exactly when the battler holds an orb-class item, and not otherwise', () => {
    const withOrb = battle([{ spe: 100, maxHp: 100, itemId: 'ITEM_TOXIC_ORB' }, { spe: 50, maxHp: 100 }], scripted())
    const out1 = executeTurn(withOrb, [null, null], deps())
    expect(out1.endTurnUnmodelled).toContain(
      `battler 0: ENDTURN_ORBS (battle_util.c:6252-6288) is not applied -- ITEM_TOXIC_ORB's orb effect (HOLD_EFFECT_TOXIC_ORB) was not run`,
    )

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
