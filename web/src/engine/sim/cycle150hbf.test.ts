/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// cycle 150hbf: OpponentHandleChooseMove overwrites the AI's chosen target for
// self-target moves (battle_controller_opponent.c:1600-1606). chooseAiAction is
// the real driver path's AI action source, so its returned `target` must already
// be the self id; executeAction must not have to correct it afterwards.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'
import type { MoveData } from '../calculate'
import type { BridgeDeps } from './bridge'
import type { ChosenAction } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { type AiDamageDeps } from './ai/aiCalcDamage'
import type { TrainerAiRow } from './ai/aiFlags'
import { chooseAiAction, type ChooseAiActionDeps } from './ai/chooseAiAction'
import { getOpponentSelectedMoveTarget } from './moveTargetFlags'
import { DEFAULT_STAT_STAGE, QUASH_DURATION, STAT_EVASION } from './constants'

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
    return { id, power: m.power, type: m.type, split: m.split, effect: m.effect, priority: m.priority, flags: m.flags ?? {}, accuracy: m.accuracy, argumentInt: arg?.kind === 'int' ? (arg.value as number) : null, target: m.target }
  },
}
const bridge: BridgeDeps = { grounding, turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, statStageRatios: natures.statStageRatios, dataContext, inverseBattle: false }
const aiDeps: AiDamageDeps = { ...bridge, moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined), typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures, holdEffectIds }
const ORDINARY_TRAINER: TrainerAiRow = { risky: false, preferStall: false, preferStatus: false, noSwitching: false, forcedDouble: false }
const deps: ChooseAiActionDeps = { ...aiDeps, trainer: ORDINARY_TRAINER }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', 'MOVE_EMBER', null, null],
    pp: [35, 15, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1), opponentParty?: SimPartyMon[]): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng, opponentParty })
}
function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

/** A battler whose only move is `moveId` -- the AI's choice is forced, so every
 * draw below is scoring/tie-break noise, not a choice between moves. */
function only(moveId: string): Partial<SimBattleMon> {
  return { moves: [moveId, null, null, null], pp: [20, 0, 0, 0] }
}

describe('cycle 150hbf - getOpponentSelectedMoveTarget (battle_controller_opponent.c:1600-1606)', () => {
  it('MOVE_TARGET_USER / USER_OR_SELECTED / USER_OR_ALLY / ALL_BATTLERS bits select the attacker', () => {
    expect(getOpponentSelectedMoveTarget(1, 'USER_OR_SELECTED', 0)).toBe(1)
    expect(getOpponentSelectedMoveTarget(1, 'USER_OR_ALLY', 0)).toBe(1)
    expect(getOpponentSelectedMoveTarget(1, 'USER', 0)).toBe(1)
    expect(getOpponentSelectedMoveTarget(1, 'ALL_BATTLERS', 0)).toBe(1)
  })

  it('anything else keeps the AI-chosen target', () => {
    expect(getOpponentSelectedMoveTarget(1, 'SELECTED', 0)).toBe(0)
    expect(getOpponentSelectedMoveTarget(1, undefined, 0)).toBe(0)
  })

  it('MOVE_TARGET_BOTH yields the player left position, battler 0', () => {
    expect(getOpponentSelectedMoveTarget(1, 'BOTH', 1)).toBe(0)
  })
})

describe('cycle 150hbf - chooseAiAction returns the controller-selected target', () => {
  it('MOVE_SWORDS_DANCE (target USER) targets the AI itself', () => {
    const s = state({}, only('MOVE_SWORDS_DANCE'), scripted(0, 0, 0, 0))
    const { action } = chooseAiAction(s, 1, deps)
    expect(action.action).toBe('USE_MOVE')
    expect(action.chosenMove?.id).toBe('MOVE_SWORDS_DANCE')
    expect(action.target).toBe(1)
  })

  it('MOVE_TRICK_ROOM (target ALL_BATTLERS) targets the AI itself', () => {
    const s = state({}, only('MOVE_TRICK_ROOM'), scripted(0, 0, 0, 0))
    const { action } = chooseAiAction(s, 1, deps)
    expect(action.chosenMove?.id).toBe('MOVE_TRICK_ROOM')
    expect(action.target).toBe(1)
  })

  it('MOVE_QUASH (target ALL_BATTLERS) targets the AI itself', () => {
    const s = state({}, only('MOVE_QUASH'), scripted(0, 0, 0, 0))
    const { action } = chooseAiAction(s, 1, deps)
    expect(action.chosenMove?.id).toBe('MOVE_QUASH')
    expect(action.target).toBe(1)
  })

  it('MOVE_TACKLE (target SELECTED) still targets the player', () => {
    const s = state({}, only('MOVE_TACKLE'), scripted(0, 0, 0, 0))
    const { action } = chooseAiAction(s, 1, deps)
    expect(action.target).toBe(0)
  })

  it('MOVE_ACID (target BOTH) targets the player left position', () => {
    const s = state({}, only('MOVE_ACID'), scripted(0, 0, 0, 0))
    const { action } = chooseAiAction(s, 1, deps)
    expect(action.chosenMove?.id).toBe('MOVE_ACID')
    expect(action.target).toBe(0)
  })
})

// A view for the player's own action; the player side is unchanged by this cycle.
const TACKLE_VIEW = {
  id: 'MOVE_TACKLE', priority: 0, effect: null, isStatus: false, resolvedType: 'NORMAL', declaredType: 'NORMAL', power: 40,
  flags: {}, split: 'PHYSICAL', hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0,
  isGrassyTerrainAffected: false, myceliumMightAffected: false,
} as const

describe('cycle 150hbf - end-to-end: the AI Quash accuracy check runs against the AI itself', () => {
  it('Quash hits and sets quashTimer even though the player sits at +6 evasion', () => {
    // Player is faster (spe 200 vs 100) so it acts first; distinct speeds also
    // mean the turn-order sort draws nothing (a speed tie is the only Random()
    // in setActionsAndBattlersTurnOrder). Drawn order through executeTurn for
    // the player's action (Tackle, accuracy 100) is one accuracy roll; the AI's
    // Quash accuracy roll is the next one.
    const s = state(
      { hp: 100, maxHp: 100, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 200 } },
      { hp: 100, maxHp: 100, ...only('MOVE_QUASH') },
      createRandomSource(1),
    )
    // Evasion +6 is the C's internal stage 12 (DEFAULT_STAT_STAGE is the neutral 6).
    s.battlers[0]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 6

    // chooseAiAction's own draws (scoring + the single-move tie-break) stay at 0,
    // so the returned action is unaffected; every executeTurn draw is scripted
    // to 90. checkAccuracy draws `random16() % 100` and misses when it is
    // >= getTotalAccuracy's answer:
    //   - against the AI itself: stage 6 vs evasion 6 -> buff 6 -> ratio [1,1]
    //     -> accuracy 100 -> 90 < 100, HIT (the state has reached the fix)
    //   - against the player at +6 evasion (stage 12): buff 0 -> ratio [1,3]
    //     (the C's 3/9) -> accuracy trunc(100 * 1/3) = 33 -> 90 >= 33, MISS
    let draws = 0
    const rng: RandomSource = { random16: () => { draws += 1; return 0 } }
    s.rng = rng

    const { action: aiAction } = chooseAiAction(s, 1, deps)
    expect(aiAction.action).toBe('USE_MOVE')
    expect(aiAction.target).toBe(1)

    const aiDraws = draws
    rng.random16 = () => (draws++ === aiDraws ? 0 : 90)

    const resolved: DamageResolver = {
      resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [] }),
    }
    const turnDeps: TurnLoopDeps = { turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, grounding, damage: resolved, statStageRatios: natures.statStageRatios, dataContext }
    const playerAction: ChosenAction = { action: 'USE_MOVE', moveToBeUsed: TACKLE_VIEW, chosenMove: TACKLE_VIEW, target: 1 }
    const out = executeTurn(s, [playerAction, aiAction], turnDeps)

    const quash = out.actions.find((a) => a.battlerId === 1)
    expect(quash).toBeDefined()
    expect(quash!.missed).toBe(false)
    expect(s.field.timers.quashTimer).toBe(QUASH_DURATION)
  })

  it('control: the pre-fix target (the player) makes the same scripted roll miss', () => {
    const s = state(
      { hp: 100, maxHp: 100, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 200 } },
      { hp: 100, maxHp: 100, ...only('MOVE_QUASH') },
      createRandomSource(1),
    )
    s.battlers[0]!.mon.statStages[STAT_EVASION] = DEFAULT_STAT_STAGE + 6
    let draws = 0
    const rng: RandomSource = { random16: () => { draws += 1; return 0 } }
    s.rng = rng
    const { action: aiAction } = chooseAiAction(s, 1, deps)
    const aiDraws = draws
    rng.random16 = () => (draws++ === aiDraws ? 0 : 90)

    const resolved: DamageResolver = { resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [] }) }
    const turnDeps: TurnLoopDeps = { turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, grounding, damage: resolved, statStageRatios: natures.statStageRatios, dataContext }
    const playerAction: ChosenAction = { action: 'USE_MOVE', moveToBeUsed: TACKLE_VIEW, chosenMove: TACKLE_VIEW, target: 1 }
    const out = executeTurn(s, [playerAction, { ...aiAction, target: 0 }], turnDeps)

    const quash = out.actions.find((a) => a.battlerId === 1)
    expect(quash!.missed).toBe(true)
    expect(s.field.timers.quashTimer).toBe(0)
  })
})
