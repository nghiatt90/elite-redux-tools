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
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  hasFlag,
} from './constants'
import { buildBattlerBattleState, type BridgeDeps, type CalculationRoles } from './bridge'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))

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
    target: m.target as string,
    priority: (m.priority as number) ?? 0,
  }
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

const MOVE_TACKLE = requireMove('MOVE_TACKLE')
const MOVE_TREPIDATION = requireMove('MOVE_TREPIDATION')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: (id) => (id === 0 ? null : null),
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: (id) => speciesById.get(id) as unknown as SimSpeciesData | undefined,
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

const BRIDGE_DEPS: BridgeDeps = {
  grounding: GROUNDING,
  turnOrder: { ...NEUTRAL_TURN_ORDER_CONTEXT, isBattlerGrounded: () => true },
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  inverseBattle: false,
}

const ROLES: CalculationRoles = { attackerId: 0, defenderId: 1 }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE],
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

function battle(
  specs: {
    spe: number
    hp?: number
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    itemId?: string | null
    status2?: number
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe },
          hp: s.hp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ?? [35, 0, 0, 0],
          itemId: s.itemId ?? null,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function countingRng(): RandomSource {
  return { random16: () => 0 }
}

function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function fixedDamage(amount: number): DamageResolver & { calls: number } {
  const r = {
    calls: 0,
    resolve: () => {
      r.calls++
      return { targetDamage: amount, attackerDamage: null, unmodelled: [] }
    },
  }
  return r
}

function deps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('Trepidation volatile (battle_script_commands.c:8715-8723, battle_util.c:2976)', () => {
  it('is set to 3 by the hit, skips the end-turn tick on the turn it started, then counts down', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_TREPIDATION', null, null, null], pp: [10, 0, 0, 0] },
        { spe: 50 },
      ],
      countingRng(),
    )
    executeTurn(state, [useMove(1, MOVE_TREPIDATION), null], deps(fixedDamage(10)))
    expect(state.battlers[1]!.volatiles.trepidation).toBe(3)
    executeTurn(state, [null, null], deps(fixedDamage(10)))
    expect(state.battlers[1]!.volatiles.trepidation).toBe(2)
  })

  it('does not restart while already active', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_TREPIDATION', null, null, null], pp: [10, 0, 0, 0] },
        { spe: 50 },
      ],
      countingRng(),
    )
    executeTurn(state, [useMove(1, MOVE_TREPIDATION), null], deps(fixedDamage(10)))
    executeTurn(state, [null, null], deps(fixedDamage(10)))
    executeTurn(state, [useMove(1, MOVE_TREPIDATION), null], deps(fixedDamage(10)))
    expect(state.battlers[1]!.volatiles.trepidation).toBe(1)
  })
})

describe('lastMoveFailed (battle_script_commands.c:4724-4730)', () => {
  it('is set when the move did nothing, cleared by the next move that landed, and read by the bridge', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], countingRng())
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(0)))
    expect(hasFlag(state.lastMoveFailed, 1)).toBe(true)
    expect(buildBattlerBattleState(state, 0, ROLES, BRIDGE_DEPS).battler.condition.lastMoveFailed).toBe(true)
    expect(buildBattlerBattleState(state, 1, ROLES, BRIDGE_DEPS).battler.condition.lastMoveFailed).toBe(false)

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(10)))
    expect(hasFlag(state.lastMoveFailed, 1)).toBe(false)
  })

  it('is not set by a plain accuracy miss (MOVE_RESULT_MISSED is not FAILED | DOESNT_AFFECT_FOE)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }], scripted(99))
    state.battlers[0]!.mon.statStages[6] = 0
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(10)))
    expect(out.actions.find((a) => a.battlerId === 0)!.missed).toBe(true)
    expect(hasFlag(state.lastMoveFailed, 1)).toBe(false)
  })
})
