/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 153g: with/without tests for the always-on and per-trainer AI flag
// bits whose only evidence used to be a name match. Each test scores the same
// scenario twice through the real pipeline, with exactly the bit under test
// set vs cleared, so the environment inventory can name a behaviour test.
//
// Scaffolding is copied locally from aiPipeline.test.ts (its `state`, `deps`,
// `mon` and data loaders); tests never import from another test file.
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
import {
  AI_FLAG_CHECK_BAD_MOVE,
  AI_FLAG_CHECK_FOE,
  AI_FLAG_CHECK_VIABILITY,
  AI_FLAG_HP_AWARE,
  AI_FLAG_RISKY,
} from './ai/aiFlags'
import { computeBattleAiScores } from './ai/aiPipeline'

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
    id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
    split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
    crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
    miscEffect: arg?.kind === 'misc' ? arg.value : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
  } as MoveData
}

// Fail loudly if a fixture id or field drifts out of the snapshot.
for (const [id, effect, crit] of [
  ['MOVE_REST', 'EFFECT_REST', undefined],
  ['MOVE_AEROBLAST', null, 'HIGH'],
  ['MOVE_THUNDERBOLT', null, undefined],
  ['MOVE_BIDE', 'EFFECT_BIDE', undefined],
  ['MOVE_TACKLE', null, undefined],
] as const) {
  const m = moveById.get(id)
  if (!m) throw new Error(`moves.json is missing ${id}`)
  if (effect && m.effect !== effect) throw new Error(`${id} is no longer ${effect} (now ${m.effect})`)
  if (crit && m.crit !== crit) throw new Error(`${id} no longer has crit ${crit} (now ${m.crit})`)
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
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', 'MOVE_EMBER', null, null],
    pp: [35, 15, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1), aiFlags = 0): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)],
    rng,
    aiFlags,
  })
}

/** Score slot 0 of a single-move attacker through the real ComputeBattleAiScores path. */
function attackerScore(
  moveId: string,
  attacker: Partial<SimBattleMon>,
  defender: Partial<SimBattleMon>,
  aiFlags: number,
): number {
  const s = state({ moves: [moveId, null, null, null], pp: [10, 0, 0, 0], ...attacker }, defender, createRandomSource(1), aiFlags)
  return computeBattleAiScores(s, 0, 1, deps).scores[0]
}

describe('trainer-flag with/without tests (cycle 153g)', () => {
  it('AI_FLAG_HP_AWARE: with and without AI_FLAG_HP_AWARE a high-HP REST scores 98 vs 100', () => {
    // AI_HPAware, battle_ai_main.c:4206-4218: at attacker HP > 70%,
    // EFFECT_REST is on the high-HP-discouraged list and loses 2.
    // MOVE_REST is EFFECT_REST (status, 0 power), so the target's own HP
    // bucket (target at 100%) adds nothing.
    const atk = { hp: 100, maxHp: 100 }
    const def = { hp: 100, maxHp: 100 }
    expect(attackerScore('MOVE_REST', atk, def, AI_FLAG_HP_AWARE)).toBe(98)
    // Negative controls: cleared, and only an unrelated flag with no dispatch
    // entry (AI_FLAG_CHECK_FOE, aiPipeline.ts DISPATCH) both stay neutral.
    expect(attackerScore('MOVE_REST', atk, def, 0)).toBe(100)
    expect(attackerScore('MOVE_REST', atk, def, AI_FLAG_CHECK_FOE)).toBe(100)
  })

  it('AI_FLAG_RISKY: with and without AI_FLAG_RISKY a HIGH-crit move scores 102 vs 100', () => {
    // AI_Risky, battle_ai_main.c:4097: TestMoveFlags(move, FLAG_HIGH_CRIT)
    // adds 2 before the risky-effect switch; MOVE_AEROBLAST's effect is null,
    // so the Random() & 1 branch is never reached (no RNG draw).
    expect(attackerScore('MOVE_AEROBLAST', {}, {}, AI_FLAG_RISKY)).toBe(102)
    expect(attackerScore('MOVE_AEROBLAST', {}, {}, 0)).toBe(100)
    expect(attackerScore('MOVE_AEROBLAST', {}, {}, AI_FLAG_CHECK_FOE)).toBe(100)
  })

  it('AI_FLAG_CHECK_BAD_MOVE: with and without AI_FLAG_CHECK_BAD_MOVE a type-immune move scores 80 vs 100', () => {
    // AI_CheckBadMove's AI_EFFECTIVENESS_x0 branch, battle_ai_main.c:599-602
    // (RETURN_SCORE_MINUS(20) at :601). Electric Thunderbolt against a pure
    // Ground defender is the 0x type immunity the branch tests.
    const groundDefender: Partial<SimBattleMon> = { types: ['GROUND', 'MYSTERY', 'MYSTERY'] }
    expect(attackerScore('MOVE_THUNDERBOLT', {}, groundDefender, AI_FLAG_CHECK_BAD_MOVE)).toBe(80)
    expect(attackerScore('MOVE_THUNDERBOLT', {}, groundDefender, 0)).toBe(100)
    expect(attackerScore('MOVE_THUNDERBOLT', {}, groundDefender, AI_FLAG_CHECK_FOE)).toBe(100)
  })

  it('AI_FLAG_CHECK_VIABILITY: with and without AI_FLAG_CHECK_VIABILITY a low-HP Bide scores 98 vs 100', () => {
    // AI_CheckViability's EFFECT_BIDE case, battle_ai_main.c:2804-2806:
    // at attacker HP < 90% it loses 2, no RNG draw.
    const lowHp = { hp: 50, maxHp: 100 }
    expect(attackerScore('MOVE_BIDE', lowHp, {}, AI_FLAG_CHECK_VIABILITY)).toBe(98)
    expect(attackerScore('MOVE_BIDE', lowHp, {}, 0)).toBe(100)
    expect(attackerScore('MOVE_BIDE', lowHp, {}, AI_FLAG_CHECK_FOE)).toBe(100)
  })

  it('AI_FLAG_CHECK_FOE: with and without AI_FLAG_CHECK_FOE the score is unchanged (the sim hard-codes the flag-on branch)', () => {
    // The C reads AI_FLAG_CHECK_FOE in GetMovesArray (battle_ai_util.c:1353)
    // to pick the real moveset vs the revealed-move history. Every trainer
    // carries the flag, so the sim always takes the TRUE branch and has no
    // dispatch entry for bit 16 (aiPipeline.ts DISPATCH). Setting or clearing
    // the bit therefore cannot change a score.
    expect(attackerScore('MOVE_TACKLE', {}, {}, AI_FLAG_CHECK_FOE)).toBe(100)
    expect(attackerScore('MOVE_TACKLE', {}, {}, 0)).toBe(100)
  })
})
