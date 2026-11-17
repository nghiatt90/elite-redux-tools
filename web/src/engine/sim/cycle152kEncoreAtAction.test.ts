/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 152k: Encore is applied at the battler's OWN action, and selection orders by
// encoredMove.
//
// C source at the pinned SHA (pipeline/.upstream/eliteredux-source/src/):
// - battle_util.c:217-219, HandleAction_UseMove's STATUS2_MULTIPLETURNS / STATUS2_RECHARGE
//   branch: `gCurrentMove = gChosenMove = gLockedMoves[battler]; gBattlerTarget =
//   gBattleStruct->moveTarget[battler];`. It precedes BOTH Encore branches and keeps the
//   stored target.
// - battle_util.c:221-226, encore with encoredMove still in its slot:
//       gCurrentMove = gChosenMove = encoredMove;                              // :224
//       gCurrMovePos = gChosenMovePos = encoredMovePos;                        // :225
//       gBattlerTarget = moveTarget[battler] = GetMoveTarget(attacker, move, 0); // :226
// - battle_util.c:228-236, encore with the slot overwritten by Mimic / Sketch / Transform:
//       gCurrentMove = gChosenMove = moves[encoredMovePos];                    // :232
//       encoredMove = MOVE_NONE; encoredMovePos = 0; encoreTimer = 0;           // :233-235
//       gBattlerTarget = moveTarget[battler] = GetMoveTarget(attacker, move, 0); // :236
// These run at the battler's own action (:176 is the alive check above them), AFTER every
// faster mover, so an Encore landed earlier in the SAME turn by a faster foe drives the
// slower target's action even though selection ran before the encore existed.
//
// - battle_main.c:3689-3691, selection: an encored battler gets
//   `gChosenMoveByBattler = encoredMove` and `chosenMovePositions = encoredMovePos`.
//   GetChosenMove (:4241-4247) returns the former, and RecalculateMoveOrder reads it
//   (:4551-4566 via GetMoveSpeed), so TURN ORDER IS THE ENCORED MOVE'S. Execution still uses
//   the slot's move in branch :228-236, which is the only place the two differ.
//
// Reversion notes (each test's own comment repeats its discriminator):
// - Test 1 fails if the Encore branches stop running in executeAction: the slower foe then
//   uses its chosen Scratch instead of the encored Tackle.
// - Test 2 fails the same way: with applyEncore ordering by encoredMove and no execution-time
//   branch, the foe would USE Tackle (the encored move) instead of the slot's Scratch.
// - Test 3 fails if applyEncore builds the ordering view from moves[encoredMovePos]: the
//   turn order flips, so the damage calls appear in the opposite order.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT, getMovePriority } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { STATUS2_MULTIPLETURNS } from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle150hbbEncoreTarget.test.ts.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<Record<string, unknown>>('types.json')
const inverseTypeChart = snapshot<Record<string, unknown>>('typesInverse.json')
const moveBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json').behaviors

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
    type2: m.type2 as string | null,
    target: m.target as string,
    argument: (m.argument ?? null) as SimMoveData['argument'],
    argumentInt: (m.argumentInt ?? null) as number | null,
    effectChance: m.effectChance as number | undefined,
    priority: m.priority as number | undefined,
    sheerForceBoost: m.sheerForceBoost as true | undefined,
    pp: m.pp as number,
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
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
    naturalGift: (it.naturalGift as SimItemData['naturalGift']) ?? null,
    grouping: (it.grouping as string | null) ?? null,
  }
}

function requireSpecies(id: string): SimSpeciesData {
  const s = speciesById.get(id)
  if (!s) throw new Error(`species.json has no ${id}`)
  return {
    id,
    baseStats: s.baseStats as SimSpeciesData['baseStats'],
    types: ((s.types as string[] | undefined) ?? []).map((t) => t.replace(/^TYPE_/, '')),
    abilities: ((s.abilities as (string | null)[] | undefined) ?? []).slice(),
    innates: ((s.innates as (string | null)[] | undefined) ?? []).slice(),
    weight: (s.weight as number | undefined) ?? 0,
    formOf: (s.formOf as string | null | undefined) ?? null,
  }
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
  species: (id) => (speciesById.has(id) ? requireSpecies(id) : undefined),
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
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

type BattlerSpec = {
  spe?: number
  atk?: number
  def?: number
  spatk?: number
  spdef?: number
  hp?: number
  maxHp?: number
  level?: number
  speciesId?: string
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  types?: [string, string, string]
  itemId?: string | null
  status1?: number
  status2?: number
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource = scriptedRng([0]),
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 300,
          maxHp: s.maxHp ?? 300,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
    ...opts,
  })
}

function scriptedRng(values: number[] = [0]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      const val = values[idx] ?? 0
      idx++
      return val
    },
  }
  return r
}

function useMove(target: number, moveData: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: moveData.id,
    priority: moveData.priority ?? 0,
    effect: moveData.effect,
    isStatus: moveData.split === 'STATUS',
    resolvedType: moveData.type ? (moveData.type.startsWith('TYPE_') ? moveData.type.slice(5) : moveData.type) : 'NORMAL',
    power: moveData.power,
    flags: moveData.flags,
    split: moveData.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function fixedDamage(amount: number, isCriticalHit = false): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

/** One entry per damage.resolve call, recording the move the turn loop actually reached the
 * damage step with (the `currentMoveAction` handleAction built from gCurrentMove) and the
 * attacker. The call ORDER is the turn order. */
type DamageCall = { attackerId: number; targetId: number; moveId: string }

function recordingDamage(amount = 0): { resolver: DamageResolver; calls: DamageCall[] } {
  const calls: DamageCall[] = []
  return {
    calls,
    resolver: {
      resolve: (_state, attackerId, targetId, action) => {
        calls.push({ attackerId, targetId, moveId: action.chosenMove?.id ?? '' })
        return {
          targetDamage: amount,
          attackerDamage: null,
          unmodelled: [],
          isCriticalHit: false,
          berryReduced: false,
          isSuperEffective: false,
        }
      },
    },
  }
}

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  grounding: GroundingContext = GROUNDING,
  dataContext: SimDataContext = DATA_CONTEXT,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)

/** SetEncore's volatile triple (battle_script_commands.c:10739-10758): encoredMove is the
 * move to repeat, encoredMovePos its slot index, encoreTimer 3. */
function encoreAt(battlerId: number, moveId: string, pos = 0): (state: BattleState) => void {
  return (state) => {
    const v = state.battlers[battlerId]!.volatiles
    v.encoredMove = moveId
    v.encoredMovePos = pos
    v.encoreTimer = 3
  }
}

// ---------------------------------------------------------------------------
// 1. An Encore landed mid-turn applies at the target's own action (Defect 1).
// ---------------------------------------------------------------------------

describe('Cycle 152k - Encore applies at the battler own action', () => {
  it('1: a faster foe Encores this turn; the slower target uses the encored move, not its chosen one', () => {
    // Turn 1 gives the foe (battler 1, spe 50) LAST MOVES = MOVE_TACKLE: MOVEEND_UPDATE_LAST_MOVES
    // stores gChosenMove in gLastMoves (moveEnd.ts:6763), which is what SetEncore searches
    // (:10740-10742). Turn 1's own moves are irrelevant to the assertion, so battler 0 (spe 100)
    // spends it on Focus Energy.
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_ENCORE', 'MOVE_FOCUS_ENERGY', null, null], pp: [5, 30, 0, 0] },
        { spe: 50, moves: ['MOVE_TACKLE', 'MOVE_SCRATCH', null, null], pp: [20, 20, 0, 0] },
      ],
      scriptedRng([0]),
    )
    executeTurn(state, [useMove(1, move('MOVE_FOCUS_ENERGY')), useMove(0, move('MOVE_TACKLE'))], testDeps(fixedDamage(0)))
    expect(state.battlers[1]!.lastMove).toBe('MOVE_TACKLE')

    // Turn 2: battler 0 (spe 100) moves first and lands Encore, which sets encoredMove =
    // MOVE_TACKLE at slot 0 with timer 3 (:10750-10753). The foe had chosen Scratch. Selection
    // ran before the encore existed, so nothing is swapped for ordering; HandleAction_UseMove's
    // :221-226 branch runs at the foe's OWN action and uses encoredMove (Tackle). Its target is
    // re-derived with GetMoveTarget (:226) against the foe's chosen-move target (battler 0).
    const dmg = recordingDamage(0)
    executeTurn(state, [useMove(1, move('MOVE_ENCORE')), useMove(0, move('MOVE_SCRATCH'))], testDeps(dmg.resolver))
    expect(dmg.calls).toEqual([{ attackerId: 1, targetId: 0, moveId: 'MOVE_TACKLE' }])

    // The encore survives the action (:221-226 never clears it) and ENDTURN_ENCORE
    // (battle_util.c:2792-2808) ticks 3 -> 2 because the slot still holds Tackle with PP left.
    expect(state.battlers[1]!.volatiles.encoredMove).toBe('MOVE_TACKLE')
    expect(state.battlers[1]!.volatiles.encoredMovePos).toBe(0)
    expect(state.battlers[1]!.volatiles.encoreTimer).toBe(2)
  })

  // -------------------------------------------------------------------------
  // 2. The overwritten-slot branch (:228-236) also runs at the battler's own action,
  //    and the move it uses is the SLOT's move, not encoredMove.
  // -------------------------------------------------------------------------

  it('2: an overwritten encored slot uses the slot move and ends the encore (:228-236)', () => {
    // Mimic / Sketch / Transform replaced slot 0: encoredMove is Tackle, moves[0] is Scratch.
    // The battler had chosen Focus Energy. :229-235 therefore uses moves[encoredMovePos] =
    // Scratch and clears the encore triple; with Defect 1 unfixed (applyEncore ordering by
    // encoredMove but no execution-time branch) it would use Tackle instead.
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SCRATCH', 'MOVE_FOCUS_ENERGY', null, null], pp: [20, 30, 0, 0] },
        { spe: 50 },
      ],
      scriptedRng([0]),
    )
    encoreAt(0, 'MOVE_TACKLE', 0)(state)

    const dmg = recordingDamage(0)
    executeTurn(state, [useMove(0, move('MOVE_FOCUS_ENERGY')), null], testDeps(dmg.resolver))
    expect(dmg.calls).toEqual([{ attackerId: 0, targetId: 1, moveId: 'MOVE_SCRATCH' }])
    const v = state.battlers[0]!.volatiles
    expect(v.encoredMove).toBeNull()
    expect(v.encoredMovePos).toBe(0)
    expect(v.encoreTimer).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 3. Ordering uses encoredMove (battle_main.c:3690), execution the slot move (:232).
  // -------------------------------------------------------------------------

  it('3a: encoredMove has priority 1 and the overwritten slot priority 0 -- ordered by encoredMove', () => {
    // getMovePriority reads the view it is handed (:4264 onwards); neither battler has an
    // ability, so the priority FIELD is the move's own: Aqua Jet 1, Tackle 0. getMoveSpeed
    // (:4300-4319) puts priority + 7 in the comparable's <<20 field, so battler 0
    // (priority field 8) outranks battler 1 (7) whatever their speeds: 50 vs 100. Ordered by
    // the slot move instead, both would sit at 7 and battler 1's speed 100 would win.
    const specs: BattlerSpec[] = [
      { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] },
      { spe: 100, moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] },
    ]
    const orderState = battle(specs, scriptedRng([0]))
    expect(getMovePriority(orderState, 0, useMove(1, move('MOVE_AQUA_JET')).chosenMove!, 1)).toBe(1)
    expect(getMovePriority(orderState, 0, useMove(1, move('MOVE_TACKLE')).chosenMove!, 1)).toBe(0)

    const state = battle(specs, scriptedRng([0]))
    encoreAt(0, 'MOVE_AQUA_JET', 0)(state)
    const dmg = recordingDamage(0)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(dmg.resolver))
    // Battler 0 first (encored Aqua Jet priority 1), then battler 1 -- and battler 0 USES the
    // slot's Tackle, which is what gCurrentMove becomes at :232.
    expect(dmg.calls).toEqual([
      { attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE' },
      { attackerId: 1, targetId: 0, moveId: 'MOVE_TACKLE' },
    ])
    expect(state.battlers[0]!.volatiles.encoredMove).toBeNull()
  })

  it('3b: encoredMove has priority 0 and the overwritten slot priority 1 -- still ordered by encoredMove', () => {
    // The reverse numbers: encored Tackle is 0, the slot's Aqua Jet is 1. Read from the slot
    // the battler would jump ahead (priority field 8 vs 7); read from encoredMove it sits at 7
    // and loses to battler 1's speed 100. It still EXECUTES the slot's Aqua Jet (:232).
    const specs: BattlerSpec[] = [
      { spe: 50, moves: ['MOVE_AQUA_JET', null, null, null], pp: [20, 0, 0, 0] },
      { spe: 100, moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] },
    ]
    const orderState = battle(specs, scriptedRng([0]))
    expect(getMovePriority(orderState, 0, useMove(1, move('MOVE_TACKLE')).chosenMove!, 1)).toBe(0)
    expect(getMovePriority(orderState, 0, useMove(1, move('MOVE_AQUA_JET')).chosenMove!, 1)).toBe(1)

    const state = battle(specs, scriptedRng([0]))
    encoreAt(0, 'MOVE_TACKLE', 0)(state)
    const dmg = recordingDamage(0)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), useMove(0, move('MOVE_TACKLE'))], testDeps(dmg.resolver))
    expect(dmg.calls).toEqual([
      { attackerId: 1, targetId: 0, moveId: 'MOVE_TACKLE' },
      { attackerId: 0, targetId: 1, moveId: 'MOVE_AQUA_JET' },
    ])
    expect(state.battlers[0]!.volatiles.encoredMove).toBeNull()
  })

  // -------------------------------------------------------------------------
  // 4. Negatives: no encore, and the :217-219 lock that precedes both branches.
  // -------------------------------------------------------------------------

  it('4a: without an encore the battler keeps its chosen move', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_SCRATCH', null, null, null], pp: [20, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] },
      ],
      scriptedRng([0]),
    )
    const dmg = recordingDamage(0)
    executeTurn(state, [useMove(1, move('MOVE_SCRATCH')), useMove(0, move('MOVE_TACKLE'))], testDeps(dmg.resolver))
    expect(dmg.calls).toEqual([
      { attackerId: 0, targetId: 1, moveId: 'MOVE_SCRATCH' },
      { attackerId: 1, targetId: 0, moveId: 'MOVE_TACKLE' },
    ])
  })

  it('4b: a locked battler is not swapped or re-targeted by Encore (:217-219 runs first)', () => {
    // STATUS2_MULTIPLETURNS with gLockedMoves set takes :217-219: gCurrentMove =
    // gLockedMoves[battler] (Outrage) and gBattlerTarget stays the STORED moveTarget, so the
    // live encore (Tackle, still in slot 1) is neither used (:221-226 never runs) nor cleared
    // (:228-236 never runs). A swap would show up as moveId MOVE_TACKLE.
    const state = battle(
      [
        { spe: 100, status2: STATUS2_MULTIPLETURNS, moves: ['MOVE_OUTRAGE', 'MOVE_TACKLE', null, null], pp: [5, 20, 0, 0] },
        { spe: 50 },
      ],
      scriptedRng([0]),
    )
    state.lockedMoves[0] = 'MOVE_OUTRAGE'
    encoreAt(0, 'MOVE_TACKLE', 1)(state)

    const dmg = recordingDamage(0)
    executeTurn(state, [useMove(1, move('MOVE_TACKLE')), null], testDeps(dmg.resolver))
    expect(dmg.calls).toEqual([{ attackerId: 0, targetId: 1, moveId: 'MOVE_OUTRAGE' }])
    const v = state.battlers[0]!.volatiles
    expect(v.encoredMove).toBe('MOVE_TACKLE')
    expect(v.encoredMovePos).toBe(1)
    // ENDTURN_ENCORE ticks the untouched encore 3 -> 2 (slot 1 still holds Tackle).
    expect(v.encoreTimer).toBe(2)
  })
})
