// chooseAiAction, ported in chooseAiAction.ts. End-to-end: the AI's own
// decision feeds executeTurn exactly as a real turn loop would call it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBattleState, createBattlerState } from '../create'
import { createRandomSource } from '../rng'
import { NEUTRAL_TURN_ORDER_CONTEXT } from '../turnOrder'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from '../state'
import type { GroundingContext } from '../grounding'
import type { SimDataContext, SimItemData, SimSpeciesData } from '../dataContext'
import type { MoveData } from '../../calculate'
import type { BridgeDeps } from '../bridge'
import type { ChosenAction } from '../turnOrder'
import { STATUS1_SLEEP } from '../constants'
import type { DamageResolver, TurnLoopDeps } from '../turn'
import { executeTurn } from '../turn'
import { type AiDamageDeps } from './aiCalcDamage'
import type { TrainerAiRow } from './aiFlags'
import { chooseAiAction, type ChooseAiActionDeps } from './chooseAiAction'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = read<Array<Record<string, any>>>('moves.json')
const moveById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawSpecies = read<Array<Record<string, any>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const rawItems = read<Array<Record<string, any>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const natures = read<any>('natures.json')
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

for (const id of ['MOVE_TACKLE', 'MOVE_EMBER']) {
  if (!moveById.has(id)) throw new Error(`moves.json is missing ${id}`)
}
if (!speciesById.has('SPECIES_MUDKIP')) throw new Error('species.json is missing SPECIES_MUDKIP')

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
const aiDeps: AiDamageDeps = { ...bridge, moveData: (id) => (moveById.has(id) ? toMoveData(id) : undefined), typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures }
const ORDINARY_TRAINER: TrainerAiRow = { risky: false, preferStall: false, preferStatus: false, noSwitching: false, forcedDouble: false }
const deps: ChooseAiActionDeps = { ...aiDeps, trainer: ORDINARY_TRAINER }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', 'MOVE_EMBER', null, null],
    pp: [35, 15, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
  }
}
function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP', hp: 100, maxHp: 100, level: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], itemId: null,
    abilities: { ability: null, innates: [null, null, null] }, rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, nature: 'NATURE_HARDY',
    hiddenPowerType: null, speedDown: false, gender: 'MALE', status1: 0, types: ['WATER', 'MYSTERY', 'MYSTERY'], ...overrides,
  }
}
function state(a: Partial<SimBattleMon> = {}, d: Partial<SimBattleMon> = {}, rng: RandomSource = createRandomSource(1), opponentParty?: SimPartyMon[]): BattleState {
  return createBattleState({ battlers: [createBattlerState(0, mon(a), 0), createBattlerState(1, mon(d), 0)], rng, opponentParty })
}
function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

describe('chooseAiAction', () => {
  it('throws for a battler on the player side', () => {
    const s = state()
    expect(() => chooseAiAction(s, 0, deps)).toThrow(/not on the opponent side/)
  })

  it('pushes the ShouldUseItem gap line when ShouldSwitch has no reserves to switch into', () => {
    // No opponentParty supplied -- ShouldSwitch's own availableToSwitch count
    // is 0, so it returns FALSE and AI_TrySwitchOrUseItem falls to
    // ShouldUseItem, which always reports its own "always FALSE" gap (see
    // aiShouldSwitch.ts).
    const s = state()
    const { unmodelled } = chooseAiAction(s, 1, deps)
    expect(unmodelled.some((u) => u.includes('ShouldUseItem'))).toBe(true)
  })

  it('produces a USE_MOVE action naming one of the battler\'s own moves, targeting the opposite battler', () => {
    const s = state()
    const { action } = chooseAiAction(s, 1, deps)
    expect(action.action).toBe('USE_MOVE')
    expect(action.target).toBe(0)
    expect(['MOVE_TACKLE', 'MOVE_EMBER']).toContain(action.chosenMove?.id)
    expect(action.chosenMove).toEqual(action.moveToBeUsed)
  })

  it('produces a SWITCH action when the second switch check\'s conditions are all met', () => {
    // A weak-scoring opponent (both CheckBadMove/CheckViability stubbed to
    // leave scores at 100, so force scores below the cap directly is not
    // possible through chooseAiAction's own public surface -- this batch has
    // no scorer that discounts a plain-damage move below 95/93 yet (that is
    // batches 2-5's own job). So the switch branch is exercised at the
    // aiPipeline.ts unit level (aiPipeline.test.ts's own "second switch check"
    // suite) instead of here; chooseAiAction's own contract is just "whatever
    // chooseMoveOrActionSingles decides, wire it into a ChosenAction" -- this
    // test instead asserts the SWITCH shape is well-formed when reached.
    const s = state({}, { hp: 100, maxHp: 100, pp: [0, 0, 0, 0] }, createRandomSource(1), [partyMon({ hp: 100 }), partyMon({ hp: 100 })])
    // Every move slot's PP is 0 -- SetupAIData forces every score to 0, which
    // trivially satisfies "all scores <= cap".
    const { action } = chooseAiAction(s, 1, deps)
    expect(action).toEqual({ action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null })
  })
})

describe('end-to-end: chooseAiAction then executeTurn, with the AI\'s move actually used', () => {
  it('the AI-chosen move id shows up as the executed action\'s ChosenAction', () => {
    const s = state({ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }, createRandomSource(1))
    const { action: aiAction } = chooseAiAction(s, 1, deps)
    expect(aiAction.action).toBe('USE_MOVE')

    // A resolver that RECORDS which move id it was called with for each
    // attacker -- proves the AI's own chosen move (not a hardcoded default)
    // is what reaches move resolution, since ActionOutcome itself carries no
    // moveId field to assert against directly.
    const resolvedMoveIdByAttacker = new Map<number, string | undefined>()
    const recordingResolver: DamageResolver = {
      resolve(_state, attackerId, _targetId, action) {
        resolvedMoveIdByAttacker.set(attackerId, action.chosenMove?.id)
        return { targetDamage: 10, attackerDamage: null, unmodelled: [] }
      },
    }

    const turnDeps: TurnLoopDeps = { turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, grounding, damage: recordingResolver, statStageRatios: natures.statStageRatios, dataContext }
    const playerAction: ChosenAction = {
      action: 'USE_MOVE',
      moveToBeUsed: { id: 'MOVE_TACKLE', priority: 0, effect: null, isStatus: false, resolvedType: 'NORMAL', power: 40, flags: {}, split: 'PHYSICAL', hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0, isGrassyTerrainAffected: false, myceliumMightAffected: false },
      chosenMove: { id: 'MOVE_TACKLE', priority: 0, effect: null, isStatus: false, resolvedType: 'NORMAL', power: 40, flags: {}, split: 'PHYSICAL', hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0, isGrassyTerrainAffected: false, myceliumMightAffected: false },
      target: 1,
    }
    const out = executeTurn(s, [playerAction, aiAction], turnDeps)

    expect(out.actions.length).toBe(2)
    expect(resolvedMoveIdByAttacker.get(1)).toBe(aiAction.chosenMove?.id)
  })
})

describe('chooseAiAction: draw order -- step 1 (scoring/tie-break) is consumed before step 2 (ShouldSwitch)', () => {
  it('the scoring draws (indices 0-2) are consumed before ShouldSwitchIfEncored\'s own draw (index 3)', () => {
    // With this fixture (full-HP battlers, both MOVE_TACKLE/MOVE_EMBER able
    // to faint the opponent), chooseAiAction draws state.rng exactly 4 times,
    // in this order (verified via instrumented rng -- see the fix-brief's own
    // "trace every draw" requirement):
    //   0, 1: AI_TryToFaint's own GetWhoStrikesFirst speed-tie draw
    //         (battle_ai_main.c:2172), once per move slot that can faint
    //   2:    ChooseMoveOrAction_Singles' own tie-break (battle_ai_main.c:338,
    //         a 2-way tie between the two equally-scored moves)
    //   3:    ShouldSwitchIfEncored's own Random()&1 draw
    //         (battle_ai_switch_items.c:310): odd -- switches immediately
    // If chooseAiAction still ran ShouldSwitch BEFORE scoring (the pre-fix
    // order), index 0 would instead be ShouldSwitchIfEncored's own draw
    // (Encored decides on a single draw, with no scoring draws preceding it)
    // -- an EVEN value at index 0 would then NOT switch under the old order,
    // while the new (correct) order still switches on index 3 regardless of
    // what index 0 holds. Scripting index 0 EVEN and index 3 ODD therefore
    // distinguishes the two orders.
    const s = state({ hp: 1000, maxHp: 1000 }, { hp: 100, maxHp: 100 }, scripted(0, 0, 0, 1), [partyMon({ hp: 100 }), partyMon({ hp: 100 })])
    s.battlers[1]!.volatiles.encoredMove = 'MOVE_TACKLE'
    const { action, unmodelled } = chooseAiAction(s, 1, deps)
    expect(action.action).toBe('SWITCH')
    expect(unmodelled.some((u) => u.includes('shouldSwitchIfEncored') || u.includes('ShouldSwitchIfEncored'))).toBe(false) // no gap line -- this helper is fully ported
  })
})

describe('end-to-end: chooseAiAction decides a switch (ShouldSwitch, not the second switch check), executeTurn carries it out', () => {
  it('a hand-built bad matchup (asleep + Natural Cure) makes the AI switch, and executeTurn brings in the chosen reserve', () => {
    const reserve = partyMon({ hp: 77, maxHp: 90, moves: ['MOVE_EMBER', null, null, null] })
    const s = state(
      { hp: 100, maxHp: 100 },
      { hp: 100, maxHp: 100, status1: STATUS1_SLEEP, abilities: { ability: 'ABILITY_NATURAL_CURE', innates: [null, null, null] } },
      // cycle15's fix pass reorders chooseAiAction: step 1 (scoring, including
      // the tie-break's own Random() % numOfBestMoves draw) now runs BEFORE
      // step 2 (ShouldSwitch) -- state.rng is drawn in this order, verified
      // via the draw-order test below:
      //   0, 1: AI_TryToFaint's own GetWhoStrikesFirst speed-tie draw
      //         (battle_ai_main.c:2172), once per move slot that can faint
      //         this fixture's full-HP opponent (both MOVE_TACKLE and
      //         MOVE_EMBER can, and both battlers share the same Speed stat,
      //         so each draws a tie-break)
      //   2:    ChooseMoveOrAction_Singles' own tie-break (battle_ai_main.c:338,
      //         a 2-way tie between the two equally-scored moves)
      //   3:    ShouldSwitchIfNaturalCure's own first Random()&1 draw
      //         (battle_ai_switch_items.c:275): odd -- switches immediately
      scripted(0, 0, 0, 1),
      [partyMon({ hp: 100 }), reserve],
    )
    const { action: aiAction, unmodelled } = chooseAiAction(s, 1, deps)
    expect(aiAction).toEqual({ action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null })
    expect(unmodelled.some((u) => u.includes('ShouldSwitchIfNaturalCure'))).toBe(true)
    // aiTrySwitchOrUseItem already resolved the target via
    // GetMostSuitableMonToSwitchInto (the only reserve, party slot 1) --
    // executeTurn needs no deps.replacement to carry this switch out.
    expect(s.battlers[1]!.monToSwitchIntoId).toBe(1)

    const turnDeps: TurnLoopDeps = { turnOrder: NEUTRAL_TURN_ORDER_CONTEXT, grounding, damage: { resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }) }, statStageRatios: natures.statStageRatios, dataContext }
    const out = executeTurn(s, [null, aiAction], turnDeps)

    // SWITCH actions are grouped FIRST by setActionsAndBattlersTurnOrder,
    // regardless of battler id -- battler 1's SWITCH is turn-order slot 0.
    expect(out.actions[0].battlerId).toBe(1)
    expect(out.actions[0].action).toBe('SWITCH')
    expect(s.battlers[1]!.partyIndex).toBe(1)
    expect(s.battlers[1]!.mon.hp).toBe(77)
    expect(s.battlers[1]!.mon.moves).toEqual(['MOVE_EMBER', null, null, null])
    // The outgoing (now-benched) mon's own party record still shows its HP.
    expect(s.sides[1].party[0]!.hp).toBe(100)
  })
})
