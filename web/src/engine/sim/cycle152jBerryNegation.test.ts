/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// VARIOUS_CONSUME_BERRY (src/battle_script_commands.c:8024-8041) on the Bug Bite / Pluck path:
// item negation inside ItemBattleEffects (GetBattlerHoldEffect(battlerId, TRUE), battle_util.c:5411 /
// IsItemNegated :6520-6527) and the HP-zero gate in HasEnoughHpToEatBerry (:5146-5148), both of
// which leave the effect unfired so the :8037-8040 restore runs.
//
// Scaffolding copied verbatim from cycle152hBugBite.test.ts's fixture block; no new helpers.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import { STATUS1_NONE, STATUS3_EMBARGO, setFlag } from './constants'
import { consumeBerryWithOverride } from './moveEffects'

// ---------------------------------------------------------------------------
// Verbatim Fixture Block from moveEnd.test.ts
// ---------------------------------------------------------------------------

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
    type: m.type ? String(m.type).replace('TYPE_', '') : null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    sheerForceBoost: m.sheerForceBoost as true | undefined,
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
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

function fixedDamage(targetDamage: number, isCriticalHit?: boolean): DamageResolver {
  return {
    resolve: () => ({ targetDamage, attackerDamage: null, unmodelled: [], isCriticalHit: isCriticalHit ?? false }),
  }
}

function testDepsWithDamage(damageResolver: DamageResolver, holdEffects: Record<number, string> = {}): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const grounding: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => holdEffects[id] ?? null }
  return { turnOrder: rest, grounding, damage: damageResolver, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

// requireMove() omits effectChance / argument (adding them would start firing secondary effects in every older test).
function withEffectData(id: string): SimMoveData {
  const raw = movesById.get(id)!
  return { ...requireMove(id), effectChance: raw.effectChance as number, argument: raw.argument as SimMoveData['argument'] }
}

const MOVE_BUG_BITE = withEffectData('MOVE_BUG_BITE')
const MOVE_PLUCK = withEffectData('MOVE_PLUCK')

const itemMoveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors
function itemMoveDeps(damage: DamageResolver, holdEffects: Record<number, string>, moves: SimMoveData[]): TurnLoopDeps {
  const byId = new Map(moves.map((m) => [m.id, m]))
  return {
    ...testDepsWithDamage(damage, holdEffects),
    dataContext: { ...DATA_CONTEXT, move: (id) => byId.get(id) ?? DATA_CONTEXT.move(id) },
    moveBehaviors: itemMoveBehaviors,
  }
}

function actionOf(out: ReturnType<typeof executeTurn>, battlerId: number) {
  return out.actions.find((a) => a.battlerId === battlerId)!
}

const bugBiteDeps = () => itemMoveDeps(fixedDamage(30), {}, [MOVE_BUG_BITE, MOVE_PLUCK])

// ---------------------------------------------------------------------------
// Item negation and the fainted-eater restore in VARIOUS_CONSUME_BERRY
// ---------------------------------------------------------------------------

describe('consumeBerryWithOverride: negation and the fainted-eater restore', () => {
  it('Klutz keeps the stolen Sitrus from firing; the attacker gets Leftovers back', () => {
    // ItemBattleEffects :5411 reads GetBattlerHoldEffect(battlerId, TRUE); IsItemNegated (:6520-6527)
    // returns HOLD_EFFECT_NONE for ABILITY_KLUTZ, so the Sitrus switch fires nothing, ItemBattleEffects
    // returns 0, and VARIOUS_CONSUME_BERRY restores changedItems[attacker] (:8037-8040).
    const klutz = { ability: requireAbility('ABILITY_KLUTZ'), innates: [null, null, null] as [null, null, null] }
    const rng = scriptedRng([0])
    const state = battle([{ hp: 40, itemId: 'ITEM_LEFTOVERS', abilities: klutz }, { itemId: 'ITEM_SITRUS_BERRY' }], rng)
    const out = executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())

    expect(state.battlers[0]!.mon.hp).toBe(40) // no +25 heal
    expect(state.battlers[1]!.mon.itemId).toBeNull() // EatTargetBerry :13226-13227 still takes it
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS') // :8038-8039
    expect(rng.calls).toBe(1) // accuracy draw only; the berry's switch made no draw at all
    expect(actionOf(out, 0).unmodelled.some((m) => m.includes('consumeberry'))).toBe(false)
  })

  it('Embargo negates the stolen berry the same way (IsItemNegated :6521)', () => {
    // IsItemNegated (battle_util.c:6520-6524): `if (gStatuses3[battlerId] & STATUS3_EMBARGO) return TRUE;`
    const rng = scriptedRng([0])
    const state = battle([{ hp: 40, itemId: 'ITEM_LEFTOVERS' }, { itemId: 'ITEM_SITRUS_BERRY' }], rng)
    const attacker = state.battlers[0]!
    attacker.statuses3 = setFlag(attacker.statuses3, STATUS3_EMBARGO)
    executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())

    expect(state.battlers[0]!.mon.hp).toBe(40)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('negative control: without Klutz/Embargo the Sitrus fires and heals the attacker to 65', () => {
    // Same setup as the two tests above with neither negating condition: ItemHealHp (battle_util.c:5314)
    // heals floor(100 * 25 / 100) = 25 and returns ITEM_HP_CHANGE, so :8035 returns before the restore.
    const state = battle([{ hp: 40, itemId: 'ITEM_LEFTOVERS' }, { itemId: 'ITEM_SITRUS_BERRY' }], scriptedRng([0]))
    executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())

    expect(state.battlers[0]!.mon.hp).toBe(65)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS') // MOVEEND_CHANGED_ITEMS :4656-4665
  })

  it('an attacker KO\'d by Rough Skin before the berry script keeps no item (HasEnoughHpToEatBerry :5148)', () => {
    // MOVEEND_ABILITIES (:342) runs before MOVEEND_MOVE_EFFECTS2_ON_EACH (:357): Rough Skin
    // (src/abilities.cc:783-790, `gBattleMoveDamage = maxHP / 8`, min 1) drops the 1-HP attacker to 0
    // before case MOVE_EFFECT_BUG_BITE (src/battle_script_commands.c:4596-4598) runs. HasEnoughHpToEatBerry
    // (:5146-5148) returns FALSE for hp 0 under the override too, so nothing fires and the :8038-8039
    // restore hands back the attacker's own item -- ITEM_NONE here.
    const roughSkin = { ability: requireAbility('ABILITY_ROUGH_SKIN'), innates: [null, null, null] as [null, null, null] }
    const rng = scriptedRng([0])
    const state = battle([{ hp: 1 }, { itemId: 'ITEM_SITRUS_BERRY', abilities: roughSkin }], rng)
    executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())

    expect(state.battlers[0]!.mon.hp).toBe(0) // floor(100 / 8) = 12 recoil from 1 HP
    expect(state.battlers[0]!.mon.itemId).toBeNull() // not the stolen Sitrus
    expect(state.battlers[1]!.mon.itemId).toBeNull() // EatTargetBerry still ran
  })

  it('a fainted eater that held Leftovers gets it back and stays at 0 HP (:8038-8039)', () => {
    // Direct call: the restore block is the only thing that runs for a fainted battler, and it
    // writes changedItems[battler] into the slot (:8038-8039) regardless of HP.
    const state = battle([{ hp: 0, itemId: 'ITEM_SITRUS_BERRY' }, {}], scriptedRng([]))
    state.battlers[0]!.changedItem = 'ITEM_LEFTOVERS'
    consumeBerryWithOverride(state, 0, 0, 'MOVE_BUG_BITE', bugBiteDeps(), [], [], true)

    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(state.battlers[0]!.changedItem).toBeNull()
  })
})
