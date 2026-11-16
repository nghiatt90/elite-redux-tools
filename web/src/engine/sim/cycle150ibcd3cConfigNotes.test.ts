/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Compile-time config in AI_CheckBadMove that the tree settles, so the port takes the
// constant branch with no unmodelled note:
//   B_SOUND_SUBSTITUTE is GEN_7 (include/constants/battle_config.h:73), so the >= GEN_6
//     guard at battle_ai_main.c:1175-1182 (EFFECT_SUBSTITUTE) is true.
//   B_MENTAL_HERB is GEN_5 (include/constants/battle_config.h:102), so the >= GEN_5
//     guards at battle_ai_main.c:1191 (Disable) and :1204 (Encore) and the standalone
//     guard at :1392 (Torment) are true.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'
import type { MoveData } from '../calculate'
import type { BridgeDeps } from './bridge'
import { type AiDamageDeps } from './ai/aiCalcDamage'
import { aiCheckBadMove } from './ai/aiCheckBadMove'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = read<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = read<Array<Record<string, any>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const natures = read<any>('natures.json')
const holdEffectIds = read<Record<string, number>>('holdEffectIds.json')
const moveBehaviors = read<any>('moveBehaviors.json').behaviors
const chart = read<Record<string, Record<string, number>>>('types.json')
const inverseChart = read<Record<string, Record<string, number>>>('typesInverse.json')

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

// Verify the ids/effects/flags this file depends on are still present in the snapshot.
if (moveById.get('MOVE_SUBSTITUTE')?.effect !== 'EFFECT_SUBSTITUTE') throw new Error('MOVE_SUBSTITUTE is no longer EFFECT_SUBSTITUTE')
if (moveById.get('MOVE_TORMENT')?.effect !== 'EFFECT_TORMENT') throw new Error('MOVE_TORMENT is no longer EFFECT_TORMENT')
if (moveById.get('MOVE_ENCORE')?.effect !== 'EFFECT_ENCORE') throw new Error('MOVE_ENCORE is no longer EFFECT_ENCORE')
if (!moveById.get('MOVE_SUPERSONIC')?.flags?.sound) throw new Error('MOVE_SUPERSONIC no longer carries flags.sound')
if (moveById.get('MOVE_TACKLE')?.flags?.sound) throw new Error('MOVE_TACKLE unexpectedly carries flags.sound')

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

// AI_DATA->holdEffects[] holds the held item's PARAM, not its hold effect
// (battle_ai_main.c:216; aiCalcDamage.ts aiHoldEffectParam), so a real Mental Herb
// (holdEffectStrength 0) does not satisfy `== HOLD_EFFECT_MENTAL_HERB` (enum id 14).
// The C branch is exercised with an item whose param is exactly that id, the same way
// aiCheckViability.test.ts:871 builds its Mental Herb holder.
const MENTAL_HERB_PARAM_ITEM = 'ITEM_PARAM_IS_HOLD_EFFECT_MENTAL_HERB'
const mentalHerbParam = holdEffectIds['HOLD_EFFECT_MENTAL_HERB']
if (mentalHerbParam === undefined) throw new Error('holdEffectIds has no HOLD_EFFECT_MENTAL_HERB')
const depsWithMentalHerbParam: AiDamageDeps = {
  ...deps,
  dataContext: {
    ...deps.dataContext,
    item: (id) => id === MENTAL_HERB_PARAM_ITEM
      ? { id, resolvedHoldEffect: null, holdEffectStrength: mentalHerbParam, holdEffectType: null, naturalGift: null }
      : deps.dataContext.item(id),
  },
}

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['NORMAL', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng })
}
function check(s: BattleState, moveId: string, d: AiDamageDeps = deps, score = 100) {
  return aiCheckBadMove(s, 0, 1, moveId, score, d)
}
const hasNote = (notes: string[], marker: string) => notes.some((n) => n.includes(marker))

describe('AI_CheckBadMove config guards take the constant branch with no unmodelled note', () => {
  it('EFFECT_SUBSTITUTE (:1175-1182): defender with a sound move still takes -8, note gone (B_SOUND_SUBSTITUTE is GEN_7)', () => {
    const s = state({ moves: ['MOVE_TACKLE', null, null, null] }, { moves: ['MOVE_SUPERSONIC', null, null, null] })
    const r = check(s, 'MOVE_SUBSTITUTE')
    expect(r.score).toBe(92)
    expect(hasNote(r.unmodelled, 'B_SOUND_SUBSTITUTE')).toBe(false)
  })

  it('EFFECT_SUBSTITUTE (:1175-1182): defender without a sound move takes no penalty and no note', () => {
    const s = state({ moves: ['MOVE_TACKLE', null, null, null] }, { moves: ['MOVE_TACKLE', null, null, null] })
    const r = check(s, 'MOVE_SUBSTITUTE')
    expect(r.score).toBe(100)
    expect(hasNote(r.unmodelled, 'B_SOUND_SUBSTITUTE')).toBe(false)
  })

  it('EFFECT_TORMENT (:1392): Mental Herb param item still takes -6, note gone (B_MENTAL_HERB is GEN_5)', () => {
    const s = state({}, { itemId: MENTAL_HERB_PARAM_ITEM })
    const r = check(s, 'MOVE_TORMENT', depsWithMentalHerbParam)
    expect(r.score).toBe(94)
    expect(hasNote(r.unmodelled, 'B_MENTAL_HERB')).toBe(false)
  })

  it('EFFECT_TORMENT (:1392): no item takes no -6 and no note', () => {
    const s = state()
    const r = check(s, 'MOVE_TORMENT')
    expect(r.score).toBe(100)
    expect(hasNote(r.unmodelled, 'B_MENTAL_HERB')).toBe(false)
  })

  it('EFFECT_ENCORE (:1204): note is gone for a Mental Herb param holder and for no item', () => {
    const withHerb = state({}, { itemId: MENTAL_HERB_PARAM_ITEM })
    withHerb.battlers[1]!.lastMove = 'MOVE_TACKLE'
    expect(hasNote(check(withHerb, 'MOVE_ENCORE', depsWithMentalHerbParam).unmodelled, 'B_MENTAL_HERB')).toBe(false)

    const noItem = state()
    noItem.battlers[1]!.lastMove = 'MOVE_TACKLE'
    expect(hasNote(check(noItem, 'MOVE_ENCORE').unmodelled, 'B_MENTAL_HERB')).toBe(false)
  })
})
