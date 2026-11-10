/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Bug Bite / Pluck: EatTargetBerry (src/battle_script_commands.c:13221-13235) and
// BattleScript_MoveEffectBugBite (data/battle_scripts_1.s:1006-1014) ->
// VARIOUS_CONSUME_BERRY (src/battle_script_commands.c:8024-8041) ->
// ItemBattleEffects(ITEMEFFECT_BATTLER_MOVE_END) (src/battle_util.c:5872-6033).
//
// Scaffolding copied verbatim from moveEnd.test.ts's fixture block; no new helpers.

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
import { DEFAULT_STAT_STAGE, STAT_ATK, STATUS1_NONE } from './constants'

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
const ABILITY_STICKY_HOLD = requireAbility('ABILITY_STICKY_HOLD')

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
// ItemBattleEffects(ITEMEFFECT_BATTLER_MOVE_END) for the berries used here
// ---------------------------------------------------------------------------

describe('Bug Bite / Pluck eat the stolen berry (BattleScript_MoveEffectBugBite)', () => {
  it('Sitrus Berry heals the attacker by floor(maxHp * 25 / 100) and the target loses it', () => {
    // EatTargetBerry :13226-13233: target loses its berry, attacker parks its own (none) and holds the Sitrus.
    // BattleScript_MoveEffectBugBite :1010-1011: sBERRY_OVERRIDE = TRUE then consumeberry BS_ATTACKER, TRUE.
    // ItemHealHp (battle_util.c:5311-5333): HOLD_EFFECT_RESTORE_PCT_HP with holdEffectStrength 25 (items.json)
    // -> gBattleMoveDamage = maxHp * 25 / 100 = floor(100 * 25 / 100) = 25 (:5316-5317).
    const rng = scriptedRng([0])
    const state = battle([{ hp: 40 }, { itemId: 'ITEM_SITRUS_BERRY' }], rng)
    const out = executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())

    expect(state.battlers[1]!.mon.hp).toBe(70) // 100 - 30
    expect(state.battlers[1]!.mon.itemId).toBeNull() // :13227 UpdateBattlerItem(target, ITEM_NONE)
    expect(state.battlers[0]!.mon.hp).toBe(65) // 40 + 25
    expect(state.battlers[0]!.mon.itemId).toBeNull() // held nothing: changedItems[attacker] = 0, Case 27 skips
    expect(rng.calls).toBe(1) // the move is CERTAIN: accuracy draw only
    expect(actionOf(out, 0).unmodelled.some((m) => m.includes('consumeberry'))).toBe(false)
  })

  it('Pluck eats a Liechi Berry and reports +1 Attack for the attacker', () => {
    // StatRaiseBerry (battle_util.c:5195-5215): HOLD_EFFECT_ATTACK_UP, holdEffectStrength 4 is the
    // 1/4-HP *threshold*, but sBERRY_OVERRIDE makes HasEnoughHpToEatBerry return TRUE before it reads
    // the fraction (:5151), so hp 30 > maxHp/4 still triggers. SetStatChanger(STAT_ATK, 1) (:5198-5201)
    // with no Ripen (:5198) -> +1 stage. This assertion fails if the port applies the raw threshold.
    const state = battle([{ hp: 30 }, { itemId: 'ITEM_LIECHI_BERRY' }], scriptedRng([0]))
    const out = executeTurn(state, [useMove(1, MOVE_PLUCK), null], bugBiteDeps())

    expect(state.battlers[1]!.mon.itemId).toBeNull() // :13227
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(actionOf(out, 0).statChanges).toEqual(
      expect.arrayContaining([{ battlerId: 0, stat: STAT_ATK, change: 1 }]),
    )
  })

  it('the attacker gets its own Leftovers back after a berry effect fires (MOVEEND_CHANGED_ITEMS :4656-4665)', () => {
    // On a fired effect VARIOUS_CONSUME_BERRY returns at :8035 and leaves changedItems[attacker] = Leftovers;
    // MOVEEND_CHANGED_ITEMS then restores it (changedItems != 0, :4658-4662).
    const state = battle([{ hp: 40, itemId: 'ITEM_LEFTOVERS' }, { itemId: 'ITEM_SITRUS_BERRY' }], scriptedRng([0]))
    executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())

    expect(state.battlers[0]!.mon.hp).toBe(65) // 40 + 25, Sitrus fired
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
  })

  it('the attacker gets its own Leftovers back when the berry does not fire (restore block :8037-8040)', () => {
    // Sitrus at full HP: ItemHealHp's guard `!(override && hp == maxHP)` (:5315) leaves the effect unfired, so
    // VARIOUS_CONSUME_BERRY falls through to UpdateBattlerItem(attacker, changedItems[attacker]) (:8038-8039).
    const state = battle([{ hp: 100, itemId: 'ITEM_LEFTOVERS' }, { itemId: 'ITEM_SITRUS_BERRY' }], scriptedRng([0]))
    executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())

    expect(state.battlers[0]!.mon.hp).toBe(100) // no heal at full HP
    expect(state.battlers[0]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    expect(state.battlers[1]!.mon.itemId).toBeNull() // the target's berry is still taken
  })

  it('Sticky Hold keeps the berry in both Bug Bite and Pluck; the attacker neither heals nor raises a stat', () => {
    // EatTargetBerry :13223: `if (IsStickyHold(target)) return FALSE;` -- before the item swap and consume.
    const sticky = { ability: ABILITY_STICKY_HOLD, innates: [null, null, null] as [null, null, null] }

    const bugState = battle([{ hp: 40 }, { itemId: 'ITEM_SITRUS_BERRY', abilities: sticky }], scriptedRng([0]))
    executeTurn(bugState, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())
    expect(bugState.battlers[1]!.mon.itemId).toBe('ITEM_SITRUS_BERRY')
    expect(bugState.battlers[0]!.mon.hp).toBe(40)
    expect(bugState.battlers[0]!.mon.itemId).toBeNull()

    const pluckState = battle([{ hp: 30 }, { itemId: 'ITEM_LIECHI_BERRY', abilities: sticky }], scriptedRng([0]))
    executeTurn(pluckState, [useMove(1, MOVE_PLUCK), null], bugBiteDeps())
    expect(pluckState.battlers[1]!.mon.itemId).toBe('ITEM_LIECHI_BERRY')
    expect(pluckState.battlers[0]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(pluckState.battlers[0]!.mon.itemId).toBeNull()
  })

  it('a non-berry target takes the Knock Off route: no berry effect on the attacker', () => {
    // BattleScript_EffectBugBite jumps to BattleScript_EffectKnockOff for a non-berry target, so eatTargetBerry
    // never runs: ApplyBugBiteEatTargetBerry's POCKET_BERRIES check (:13222) is not even reached. The attacker
    // takes no berry effect; the seteffectwithchance roll makes two draws.
    const rng = scriptedRng([0, 0])
    const state = battle([{ hp: 40 }, { itemId: 'ITEM_LEFTOVERS' }], rng)
    executeTurn(state, [useMove(1, MOVE_BUG_BITE), null], bugBiteDeps())

    expect(state.battlers[1]!.mon.itemId).toBeNull() // knocked off
    expect(state.battlers[0]!.mon.hp).toBe(40) // no berry eaten
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.mon.statStages[STAT_ATK] ?? DEFAULT_STAT_STAGE).toBe(DEFAULT_STAT_STAGE)
    expect(rng.calls).toBe(2) // accuracy + seteffectwithchance
  })
})
