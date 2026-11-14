/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// AI_CheckBadMove EFFECT_SUBSTITUTE sound-moveset penalty reads the TARGET's moves.
// C, pipeline/.upstream/eliteredux-source/src/battle_ai_main.c:1175-1182:
//   case EFFECT_SUBSTITUTE:
//       if (gBattleMons[battlerAtk].status2 & STATUS2_SUBSTITUTE || BattlerHasAbility(battlerDef, ABILITY_INFILTRATOR, TRUE) ||
//           BattlerHasAbility(battlerDef, ABILITY_MARINE_APEX, TRUE))
//           score -= 10;
//       else if (GetHealthPercentage(battlerAtk) <= 25)
//           score -= 10;
//       else if (B_SOUND_SUBSTITUTE >= GEN_6 && TestMoveFlagsInMoveset(battlerDef, FLAG_SOUND))
//           score -= 8;
//       break;
// TestMoveFlagsInMoveset is battle_ai_util.c:1686-1692 and scans GetMovesArray(battler)
// with a static TestMoveFlags read. B_SOUND_SUBSTITUTE is GEN_7
// (include/constants/battle_config.h:73), so the >= GEN_6 guard is true on this build.
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

// Verify the ids/flags this file depends on are still present in the snapshot.
const substitute = moveById.get('MOVE_SUBSTITUTE')
if (!substitute) throw new Error('moves.json is missing MOVE_SUBSTITUTE')
if (substitute.effect !== 'EFFECT_SUBSTITUTE') throw new Error('MOVE_SUBSTITUTE is no longer EFFECT_SUBSTITUTE')
const soundMove = moveById.get('MOVE_SUPERSONIC')
if (!soundMove) throw new Error('moves.json is missing MOVE_SUPERSONIC')
if (!soundMove.flags?.sound) throw new Error('MOVE_SUPERSONIC no longer carries flags.sound')
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
function check(s: BattleState, moveId: string, score = 100) {
  return aiCheckBadMove(s, 0, 1, moveId, score, deps)
}
const hasSoundNote = (notes: string[]) => notes.some((n) => n.includes('B_SOUND_SUBSTITUTE'))

describe('AI_CheckBadMove EFFECT_SUBSTITUTE sound penalty reads the target moveset', () => {
  it('does not penalize when only the ATTACKER has a sound move (C reads battlerDef)', () => {
    const s = state({ moves: ['MOVE_SUPERSONIC', null, null, null] }, { moves: ['MOVE_TACKLE', null, null, null] })
    const r = check(s, 'MOVE_SUBSTITUTE')
    expect(r.score).toBe(100)
    expect(hasSoundNote(r.unmodelled)).toBe(false)
  })

  it('penalizes -8 when only the DEFENDER has a sound move', () => {
    const s = state({ moves: ['MOVE_TACKLE', null, null, null] }, { moves: ['MOVE_SUPERSONIC', null, null, null] })
    const r = check(s, 'MOVE_SUBSTITUTE')
    expect(r.score).toBe(92)
    expect(hasSoundNote(r.unmodelled)).toBe(true)
  })

  it('applies a single -8 when both sides have a sound move', () => {
    const s = state({ moves: ['MOVE_SUPERSONIC', null, null, null] }, { moves: ['MOVE_SUPERSONIC', null, null, null] })
    expect(check(s, 'MOVE_SUBSTITUTE').score).toBe(92)
  })

  it('applies no penalty when neither side has a sound move', () => {
    const s = state({ moves: ['MOVE_TACKLE', null, null, null] }, { moves: ['MOVE_TACKLE', null, null, null] })
    expect(check(s, 'MOVE_SUBSTITUTE').score).toBe(100)
  })

  it('the -10 HP branch wins first: no -8 on top of it', () => {
    const s = state({ moves: ['MOVE_TACKLE', null, null, null], hp: 25, maxHp: 100 }, { moves: ['MOVE_SUPERSONIC', null, null, null] })
    expect(check(s, 'MOVE_SUBSTITUTE').score).toBe(90)
  })
})
