/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 153g: CanFling (battle_util.c:8414-8420) now honours IsItemNegated
// (:6520-6524) -- the Embargo flag or Klutz. The C's IsItemNegated has no
// Magic Room clause. AI_CheckBadMove's EFFECT_FLING case subtracts 10 when
// canFling is false, so every expectation below is 100 (usable) or 90.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { createRandomSource } from '../rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import { STATUS3_EMBARGO, STATUS3_GASTRO_ACID } from '../constants'
import type { BattleState, RandomSource, SimBattleMon } from '../state'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import type { AiDamageDeps } from './aiCalcDamage'
import { aiCheckBadMove } from './aiCheckBadMove'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = read<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = read<Array<Record<string, any>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const abilityIds = new Set(read<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const natures = read<any>('natures.json')
const holdEffectIds = read<Record<string, number>>('holdEffectIds.json')
const moveBehaviors = read<any>('moveBehaviors.json').behaviors
const chart = read<Record<string, Record<string, number>>>('types.json')
const inverseChart = read<Record<string, Record<string, number>>>('typesInverse.json')

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
const KLUTZ = requireAbility('ABILITY_KLUTZ')
if (!moveById.has('MOVE_FLING')) throw new Error('moves.json is missing MOVE_FLING')
if (moveById.get('MOVE_FLING')!.effect !== 'EFFECT_FLING') throw new Error('MOVE_FLING is no longer EFFECT_FLING')
if (!itemsById.has('ITEM_ORAN_BERRY')) throw new Error('items.json is missing ITEM_ORAN_BERRY')

function toMoveData(id: string): MoveData {
  const move = moveById.get(id)
  if (!move) throw new Error(`snapshot is missing ${id}`)
  const arg = move.argument as Record<string, unknown> | undefined
  return {
    id, power: move.power, type: move.type ? String(move.type).replace('TYPE_', '') : null, type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, hitsAir: move.hitsAir === 'DOESNT_HIT_AIR' ? undefined : move.hitsAir, flags: move.flags ?? {}, priority: move.priority,
    changeTypeHoldEffect: arg?.kind === 'holdEffect' ? (arg.value as string) : null,
    miscEffect: arg?.kind === 'misc' ? (arg.value as string) : null, multiHitArgument: arg?.kind === 'int' ? (arg.value as number) : null,
    target: move.target,
  } as MoveData
}

const grounding: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const dataContext: SimDataContext = {
  species: (id) => speciesById.get(id) as SimSpeciesData | undefined,
  item: (id) => itemsById.get(id) as SimItemData | undefined,
  move: (id) => {
    const m = moveById.get(id)
    if (!m) return undefined
    const arg = m.argument as Record<string, unknown> | undefined
    return { id, power: m.power, type: m.type, split: m.split, effect: m.effect, priority: m.priority, flags: m.flags ?? {}, accuracy: m.accuracy, argumentInt: arg?.kind === 'int' ? (arg.value as number) : null }
  },
}
const bridge: BridgeDeps = { grounding, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext, inverseBattle: false }
const deps: AiDamageDeps = { ...bridge, moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined), typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures, holdEffectIds }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_FLING', null, null, null],
    pp: [10, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['NORMAL', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng })
}
function check(s: BattleState, moveId: string, score = 100) {
  return aiCheckBadMove(s, 0, 1, moveId, score, deps)
}

describe('CanFling / IsItemNegated (cycle 153g)', () => {
  it('baseline: a held flingable item with no Embargo or Klutz is not penalized', () => {
    const s = state({ itemId: 'ITEM_ORAN_BERRY' })
    expect(check(s, 'MOVE_FLING').score).toBe(100)
  })

  it('Embargo on the attacker negates the item: -10', () => {
    const s = state({ itemId: 'ITEM_ORAN_BERRY' })
    s.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    expect(check(s, 'MOVE_FLING').score).toBe(90)
  })

  it('Klutz on the attacker negates the item: -10', () => {
    const s = state({ itemId: 'ITEM_ORAN_BERRY', abilities: { ability: KLUTZ, innates: [null, null, null] } })
    expect(check(s, 'MOVE_FLING').score).toBe(90)
  })

  it('Klutz under Gastro Acid is suppressed (BattlerHasAbility(..., FALSE)): no penalty', () => {
    const s = state({ itemId: 'ITEM_ORAN_BERRY', abilities: { ability: KLUTZ, innates: [null, null, null] } })
    s.battlers[0]!.statuses3 |= STATUS3_GASTRO_ACID
    expect(check(s, 'MOVE_FLING').score).toBe(100)
  })

  it("Embargo on the DEFENDER only does not affect the attacker's Fling: no penalty", () => {
    const s = state({ itemId: 'ITEM_ORAN_BERRY' })
    s.battlers[1]!.statuses3 |= STATUS3_EMBARGO
    expect(check(s, 'MOVE_FLING').score).toBe(100)
  })

  it('the CanFling IsItemNegated gap note is gone', () => {
    const s = state({ itemId: 'ITEM_ORAN_BERRY' })
    s.battlers[0]!.statuses3 |= STATUS3_EMBARGO
    const r = check(s, 'MOVE_FLING')
    expect(r.unmodelled.some((n) => n.startsWith('CanFling: IsItemNegated'))).toBe(false)
  })
})
