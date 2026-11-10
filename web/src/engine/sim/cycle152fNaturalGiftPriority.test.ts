/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 152f: NaturalGiftPriority. battle_main.c:4272 adds
// `NaturalGiftPriority(gBattleMons[battler].item)` to EFFECT_NATURAL_GIFT's
// priority. NaturalGiftGenerator.kt:25-29 emits `default: return TRUE` and a case
// only for a berry whose `naturalGift.priority != 0` (Custap Berry alone, at 1),
// so every held item -- Custap included -- and no item at all give 1. Natural
// Gift always gets +1.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { STATUS2_MULTIPLETURNS } from './constants'
import { createRandomSource } from './rng'
import { loadSimData } from './driver/loadSimData'
import { aiDamageDepsFor, buildMoveAction, groundingFor } from './driver/session'
import { defaultPlayerPolicy } from './driver/runBattle'
import { executeTurn } from './turn'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { DamageResolver, TurnLoopDeps } from './turn'
import type { ChosenAction } from './turnOrder'
import { chooseAiAction, type ChooseAiActionDeps } from './ai/chooseAiAction'
import type { TrainerAiRow } from './ai/aiFlags'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const RATIOS = simData.statStageRatios
const TURN_ORDER = simData.turnOrder
const ORDINARY_TRAINER: TrainerAiRow = {
  risky: false,
  preferStall: false,
  preferStatus: false,
  noSwitching: false,
  forcedDouble: false,
}

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
  })
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(simData, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors: simData.moveBehaviors,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
  }
}

function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

/** Natural Gift's base priority in data/v2.65beta/moves.json is 0, so the C's
 * `priority += NaturalGiftPriority(item)` is the whole priority of the move. */
const NATURAL_GIFT = 'MOVE_NATURAL_GIFT'

/** NaturalGiftGenerator.kt:25-29 widens the switch only for a berry whose
 * `naturalGift.priority != 0`; the snapshot has exactly one (Custap, at 1). */
const CUSTAP_BERRY_ID = [...simData.itemsById.values()]
  .find((item: { naturalGift?: { priority?: number } }) => (item?.naturalGift?.priority ?? 0) !== 0)
  ?.id as string | undefined

function naturalGiftMon(itemId: string | null, spe = 50): SimBattleMon {
  return monFor('SPECIES_MUDKIP', {
    moves: [NATURAL_GIFT, null, null, null],
    pp: [15, 0, 0, 0],
    itemId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe },
  })
}

function slowerFoe(spe = 200): SimBattleMon {
  return monFor('SPECIES_MUDKIP', {
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe },
  })
}

function actionOrder(state: BattleState, actions: (ChosenAction | null)[]): number[] {
  const out = executeTurn(state, actions, loopDeps(state, fixedDamage(10)))
  return out.actions.map((a) => a.battlerId)
}

describe('cycle 152f - NaturalGiftPriority is 1 for every item and no item', () => {
  it('Cheri Berry: the slower Natural Gift user acts first through buildMoveAction', () => {
    const state = battle(naturalGiftMon('ITEM_CHERI_BERRY'), slowerFoe())

    const gift = buildMoveAction(state, simData, 0, NATURAL_GIFT)
    const tackle = buildMoveAction(state, simData, 1, 'MOVE_TACKLE')
    expect(gift.chosenMove?.naturalGiftPriority).toBe(1)

    // Base priority 0 for both; Natural Gift's +1 breaks the speed deficit.
    expect(actionOrder(state, [gift, tackle])).toEqual([0, 1])
  })

  it('Custap Berry (the only nonzero table priority, 1): +1, not +2', () => {
    expect(CUSTAP_BERRY_ID).toBeTruthy()
    const state = battle(naturalGiftMon(CUSTAP_BERRY_ID!), slowerFoe())

    const gift = buildMoveAction(state, simData, 0, NATURAL_GIFT)
    expect(gift.chosenMove?.naturalGiftPriority).toBe(1)
    expect(actionOrder(state, [gift, buildMoveAction(state, simData, 1, 'MOVE_TACKLE')])).toEqual([0, 1])
  })

  it('Enigma Berry with HOLD_EFFECT_NONE still gives +1 (the id, not the hold effect, is read)', () => {
    const state = battle(naturalGiftMon('ITEM_ENIGMA_BERRY'), slowerFoe())

    const gift = buildMoveAction(state, simData, 0, NATURAL_GIFT)
    expect(gift.chosenMove?.naturalGiftPriority).toBe(1)
    expect(actionOrder(state, [gift, buildMoveAction(state, simData, 1, 'MOVE_TACKLE')])).toEqual([0, 1])
  })

  it('no item: default: return TRUE gives +1', () => {
    const state = battle(naturalGiftMon(null), slowerFoe())

    const gift = buildMoveAction(state, simData, 0, NATURAL_GIFT)
    expect(gift.chosenMove?.naturalGiftPriority).toBe(1)
    expect(actionOrder(state, [gift, buildMoveAction(state, simData, 1, 'MOVE_TACKLE')])).toEqual([0, 1])
  })

  it('negative: Tackle from the same slower holder is unchanged and goes second', () => {
    const state = battle(monFor('SPECIES_MUDKIP', {
      moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0],
      itemId: 'ITEM_CHERI_BERRY',
      rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 50 },
    }), slowerFoe())

    const tackle = buildMoveAction(state, simData, 0, 'MOVE_TACKLE')
    expect(tackle.chosenMove?.naturalGiftPriority).toBe(0)
    expect(actionOrder(state, [tackle, buildMoveAction(state, simData, 1, 'MOVE_TACKLE')])).toEqual([1, 0])
  })

  it('runBattle default player policy builds the view with the holder item', () => {
    const state = battle(naturalGiftMon('ITEM_CHERI_BERRY'), slowerFoe())

    const action = defaultPlayerPolicy(state, simData)
    expect(action?.chosenMove?.id).toBe(NATURAL_GIFT)
    expect(action?.chosenMove?.naturalGiftPriority).toBe(1)
  })

  it('turn.ts buildMoveView: a locked Natural Gift view carries the +1 into the turn order', () => {
    const state = battle(naturalGiftMon('ITEM_CHERI_BERRY'), slowerFoe())
    state.battlers[0]!.mon.status2 = STATUS2_MULTIPLETURNS
    state.lockedMoves[0] = NATURAL_GIFT

    // No chosen move view, so applyLockedMove goes through buildMoveView(locked).
    const lockedAction: ChosenAction = {
      action: 'USE_MOVE',
      moveToBeUsed: null,
      chosenMove: null,
      target: 1,
    }
    expect(actionOrder(state, [lockedAction, buildMoveAction(state, simData, 1, 'MOVE_TACKLE')])).toEqual([0, 1])
  })

  it('AI: chooseAiAction builds the view from the AI battler item and raises no note', () => {
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP', {
      moves: [NATURAL_GIFT, null, null, null],
      pp: [15, 0, 0, 0],
      itemId: 'ITEM_CHERI_BERRY',
    }))
    const deps: ChooseAiActionDeps = { ...aiDamageDepsFor(simData, state), trainer: ORDINARY_TRAINER }

    const { action, unmodelled } = chooseAiAction(state, 1, deps)
    expect(action.action).toBe('USE_MOVE')
    expect(action.chosenMove?.id).toBe(NATURAL_GIFT)
    expect(action.chosenMove?.naturalGiftPriority).toBe(1)
    expect(unmodelled.some((note) => note.includes('naturalGiftPriority'))).toBe(false)
  })
})
