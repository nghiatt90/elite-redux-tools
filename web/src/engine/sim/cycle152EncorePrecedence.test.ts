/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 152: applyEncore precedence and timing against HandleAction_UseMove.
//
// C source at the pinned SHA (pipeline/.upstream/eliteredux-source/src/battle_util.c),
// HandleAction_UseMove's branch ladder, in ORDER:
// - :212 gProcessingExtraAttacks (not exercised here)
// - :217-219 `else if (status2 & STATUS2_MULTIPLETURNS || status2 & STATUS2_RECHARGE)
//       { gCurrentMove = gChosenMove = gLockedMoves[battler];
//         gBattlerTarget = gBattleStruct->moveTarget[battler]; }`
//   -- a rampage / recharge lock keeps the STORED target and never reaches Encore.
// - :221-225 encore with encoredMove still in its slot:
//       gBattlerTarget = moveTarget[battler] = GetMoveTarget(battler, move, 0);  // :226
// - :228-236 encore with the slot overwritten:
//       gCurrentMove = moves[encoredMovePos]; encoredMove = MOVE_NONE;
//       encoredMovePos = 0; encoreTimer = 0;                                     // :231-235
//       gBattlerTarget = moveTarget[battler] = GetMoveTarget(battler, move, 0);  // :236
//
// Both :222-236 branches run at the battler's OWN action, after the alive check at :176
// and after every faster mover. GetMoveTarget(..., 0) reads
// GetBattlerBattleMoveTargetFlags (battle_util.c:128-150) -- the DYNAMIC flags, e.g.
// EFFECT_EXPANDING_FORCE on Psychic Terrain -> MOVE_TARGET_BOTH (moveTargetFlags.ts:63-66)
// -- then the Curse rule (:6353-6360) and the switch (:6363-6416). So a faster foe that
// sets Psychic Terrain this turn changes the target an encored Expanding Force resolves.
// The selection-time GetFullChosenTarget (:167) call only feeds turn order.
//
// Probe: Crispy Cream's onDefender (src/abilities.cc:10837-10842) draws `Random() % 2`
// before its damage gate, so one draw from a dispatch = MOVEEND_ABILITIES ran on that
// battler; zero = it did not. Every count below is derived by hand from the C.
//
// Targets: the sim's SetRandomTarget picks the LEFT foe deterministically when
// battlersCount > 2 (turn.ts's getMoveTarget, port of :6326-6341), while
// MOVE_TARGET_BOTH picks `attacker ^ 1` (:6369-6377). A four-battler state therefore makes
// "stored target" / "RANDOM re-derivation" / "BOTH" resolve to different battlers
// (3, 1 and 3 for attacker 0; 1 and 3 for attacker 2), which is what each assertion reads.
import { STATUS2_MULTIPLETURNS, STATUS2_RECHARGE } from './constants'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle150hTarget.test.ts.
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

/** One entry per damage.resolve call, recording the target the turn loop reached the
 * damage step with, the move actually being used (GetMoveToBeUsed / currentMove) and the
 * attacker's encore state AT USE TIME (the turn.ts reset runs before this call). */
type DamageCall = { attackerId: number; targetId: number; moveId: string; encoredMove: string | null }

function recordingDamage(amount = 0): { resolver: DamageResolver; calls: DamageCall[] } {
  const calls: DamageCall[] = []
  return {
    calls,
    resolver: {
      resolve: (state, attackerId, targetId, action) => {
        calls.push({
          attackerId,
          targetId,
          moveId: action.chosenMove?.id ?? '',
          encoredMove: state.battlers[attackerId]?.volatiles.encoredMove ?? null,
        })
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
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })

/** A party record for outcome tracking, shaped like battleEvents.test.ts's partyMon. */
function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 300,
    maxHp: 300,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

/** Runs one turn with a draw-counting RNG. `deps` defaults to a zero-damage resolver:
 * the damage seam must not fabricate a hit that changes the outcome. `prepare` mutates
 * the freshly built state before the turn starts (locked moves, the encore volatiles). */
function runTurn(
  specs: BattlerSpec[],
  actions: (ChosenAction | null)[],
  deps: TurnLoopDeps = testDeps(fixedDamage(0)),
  prepare?: (state: BattleState) => void,
  opts: { opponentParty?: SimPartyMon[] } = {},
) {
  const rng = scriptedRng([0])
  const state = battle(specs, rng, opts)
  prepare?.(state)
  const out = executeTurn(state, actions, deps)
  return { rng, state, out }
}

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

/** The outcome for one battler, whichever order it acted in. */
function outcomeFor(out: ReturnType<typeof executeTurn>, battlerId: number) {
  const found = out.actions.find((a) => a.battlerId === battlerId)
  if (!found) throw new Error(`no outcome for battler ${battlerId}`)
  return found
}

// ---------------------------------------------------------------------------
// 1. Precedence: :217-219 (lock) runs BEFORE both Encore branches (:221-236).
//    A four-battler state separates the stored target (battler 3) from the value the
//    Encore branch would derive: Outrage is MOVE_TARGET_RANDOM, and the sim's
//    SetRandomTarget picks the left foe (battler 1) when battlersCount > 2.
// ---------------------------------------------------------------------------

describe('Cycle 152 - HandleAction_UseMove lock branch precedes Encore', () => {
  it('1a: encored rampage keeps the stored target and the encore (Crispy Cream on the stored foe draws)', () => {
    // status2 & STATUS2_MULTIPLETURNS || status2 & STATUS2_RECHARGE (:217) picks
    // gCurrentMove = gLockedMoves and gBattlerTarget = gBattleStruct->moveTarget (:218-219);
    // it never reaches GetMoveTarget on :226, so the stored target 3 is used and the encore
    // survives. Draw derivation: the only action is battler 0's Outrage. Cmd_accuracycheck
    // (:1398-1447) draws Random() once; seteffectwithchance (Outrage's effectChance is 100)
    // draws once in applySecondaryMoveEffects; the damage stub draws none; MOVEEND_ABILITIES
    // (:4527-4531) reaches battler 3's Crispy Cream once -- its `Random() % 2`
    // (abilities.cc:10838) is drawn before the `targetDamage > 0` gate, and targetDamage is
    // 0 here. Total 3. A re-target would send the dispatch to battler 1 (no holder): total 2.
    // ENDTURN_ENCORE (:2792-2808) decrements the still-live encore 3 -> 2.
    const { rng, state, out } = runTurn(
      [
        { hp: 300, spe: 100, moves: ['MOVE_OUTRAGE', null, null, null], pp: [10, 0, 0, 0], status2: STATUS2_MULTIPLETURNS },
        { hp: 300, spe: 90 },
        { hp: 300, spe: 80 },
        { hp: 300, spe: 70, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [useMove(3, move('MOVE_OUTRAGE')), null, null, null],
      testDeps(fixedDamage(0)),
      (s) => {
        s.lockedMoves[0] = 'MOVE_OUTRAGE'
        encoreAt(0, 'MOVE_OUTRAGE')(s)
      },
    )
    expect(outcomeFor(out, 0).targetId).toBe(3)
    expect(rng.calls).toBe(3)
    expect(state.battlers[0]!.volatiles.encoredMove).toBe('MOVE_OUTRAGE')
    expect(state.battlers[0]!.volatiles.encoreTimer).toBe(2)
  })

  it('1b: encored recharge keeps the stored target and the encore (same branch, STATUS2_RECHARGE)', () => {
    // :217's second half. CANCELLER_RECHARGE (battle_util.c:3294-3304) cancels before the
    // accuracy check, so the only draw is the MOVEEND_ABILITIES dispatch on the target the
    // cancel path uses (turn.ts's cancelResult branch, gBattlerTarget = stored 3): one
    // Crispy Cream coin from battler 3. A re-target would reach battler 1: zero draws.
    const { rng, state, out } = runTurn(
      [
        { hp: 300, spe: 100, moves: ['MOVE_HYPER_BEAM', null, null, null], pp: [5, 0, 0, 0], status2: STATUS2_RECHARGE },
        { hp: 300, spe: 90 },
        { hp: 300, spe: 80 },
        { hp: 300, spe: 70, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [useMove(3, move('MOVE_HYPER_BEAM')), null, null, null],
      testDeps(fixedDamage(0)),
      (s) => {
        s.lockedMoves[0] = 'MOVE_HYPER_BEAM'
        encoreAt(0, 'MOVE_HYPER_BEAM')(s)
      },
    )
    expect(outcomeFor(out, 0).targetId).toBe(3)
    expect(rng.calls).toBe(1)
    expect(state.battlers[0]!.volatiles.encoredMove).toBe('MOVE_HYPER_BEAM')
    expect(state.battlers[0]!.volatiles.encoreTimer).toBe(2)
  })

  // -------------------------------------------------------------------------
  // 2. Negative: the same encored Outrage WITHOUT the lock still takes :221-226 and
  //    re-derives through GetMoveTarget. Drop the Encore path entirely and the
  //    controller's target 3 would survive; the re-derivation gives 1.
  // -------------------------------------------------------------------------

  it('2: without the lock the encore re-derives the target to the left foe (battler 1)', () => {
    // No STATUS2 lock, so :221-225 runs: GetMoveTarget(attacker, Outrage, 0) reads
    // MOVE_TARGET_RANDOM (:128-150 returns the static target), and the RANDOM case picks
    // SetRandomTarget -- the left foe, battler 1. Draws: accuracy 1 + the effectChance-100
    // secondary 1 + the coin on the dispatched battler 1 = 3. If Encore were disabled the
    // action's own target 3 stands, so the coin would land on battler 3 (no holder): 2
    // draws -- the count and the target id both move.
    const { rng, out } = runTurn(
      [
        { hp: 300, spe: 100, moves: ['MOVE_OUTRAGE', null, null, null], pp: [10, 0, 0, 0] },
        { hp: 300, spe: 90, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 80 },
        { hp: 300, spe: 70 },
      ],
      [useMove(3, move('MOVE_OUTRAGE')), null, null, null],
      testDeps(fixedDamage(0)),
      encoreAt(0, 'MOVE_OUTRAGE'),
    )
    expect(outcomeFor(out, 0).targetId).toBe(1)
    expect(rng.calls).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 3. Timing: the Encore branch's GetMoveTarget runs at the battler's OWN action, so a
//    faster foe's Psychic Terrain changes it. Encored battler 2 is slower than foe 1.
// ---------------------------------------------------------------------------

describe('Cycle 152 - Encore target is re-derived at the battler own action', () => {
  // GetBattlerBattleMoveTargetFlags: EFFECT_EXPANDING_FORCE + Psychic Terrain -> BOTH
  // (moveTargetFlags.ts:63-66). GetMoveTarget's BOTH case (:6369-6377) picks
  // `attacker ^ 1`, i.e. 3 for battler 2, while the selection-time SELECTED path goes
  // through SetRandomTarget's left foe, 1. The recording resolver reads the target the
  // turn loop actually reached the damage step with.
  it('3a: Psychic Terrain set by a faster foe moves the encored Expanding Force to BOTH (battler 3)', () => {
    // Psychic Terrain resolves first (spe 200 > 50) and sets STATUS_FIELD_PSYCHIC_TERRAIN;
    // by battler 2's action getBattlerBattleMoveTargetFlags returns BOTH, so GetMoveTarget
    // yields 2 ^ 1 = 3. A target computed once before turn order would stay at the
    // selection-time SELECTED result, 1.
    const dmg = recordingDamage(0)
    const { out } = runTurn(
      [
        { hp: 300, spe: 30 },
        { hp: 300, spe: 200, moves: ['MOVE_PSYCHIC_TERRAIN', null, null, null], pp: [10, 0, 0, 0] },
        { hp: 300, spe: 50, moves: ['MOVE_EXPANDING_FORCE', null, null, null], pp: [10, 0, 0, 0] },
        { hp: 300, spe: 10 },
      ],
      [null, useMove(0, move('MOVE_PSYCHIC_TERRAIN')), useMove(1, move('MOVE_EXPANDING_FORCE')), null],
      testDeps(dmg.resolver),
      encoreAt(2, 'MOVE_EXPANDING_FORCE'),
    )
    expect(dmg.calls).toEqual([{ attackerId: 2, targetId: 3, moveId: 'MOVE_EXPANDING_FORCE', encoredMove: 'MOVE_EXPANDING_FORCE' }])
    expect(outcomeFor(out, 2).targetId).toBe(3)
  })

  it('3b: without the terrain the same encore keeps the SELECTED target (battler 1)', () => {
    // No terrain -> GetBattlerBattleMoveTargetFlags returns the static SELECTED target
    // (moves.json), whose GetMoveTarget case runs SetRandomTarget and picks the left foe,
    // battler 1, both at selection and at execution.
    const dmg = recordingDamage(0)
    const { out } = runTurn(
      [
        { hp: 300, spe: 30 },
        { hp: 300, spe: 200 },
        { hp: 300, spe: 50, moves: ['MOVE_EXPANDING_FORCE', null, null, null], pp: [10, 0, 0, 0] },
        { hp: 300, spe: 10 },
      ],
      [null, null, useMove(1, move('MOVE_EXPANDING_FORCE')), null],
      testDeps(dmg.resolver),
      encoreAt(2, 'MOVE_EXPANDING_FORCE'),
    )
    expect(dmg.calls).toEqual([{ attackerId: 2, targetId: 1, moveId: 'MOVE_EXPANDING_FORCE', encoredMove: 'MOVE_EXPANDING_FORCE' }])
    expect(outcomeFor(out, 2).targetId).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Overwrite reset (:228-236) runs at use time, not at selection.
// ---------------------------------------------------------------------------

describe('Cycle 152 - the overwritten-encore reset happens at use time', () => {
  it('4a: an overwritten slot keeps the encore through turn order, then clears it when the move is used', () => {
    // encoredMove is Outrage but slot 0 now holds Tackle, so :228's slot test is true:
    // the C uses the slot's move and runs encoredMove = MOVE_NONE, encoredMovePos = 0,
    // encoreTimer = 0 (:231-235) at the battler's own action. The selection-time applyEncore
    // no longer clears it (it only swaps the chosen move, battle_main.c:3689-3691), so the
    // volatile is still set when setActionsAndBattlersTurnOrder runs; the recording resolver
    // observes it already cleared by the time the move reaches the damage step.
    const dmg = recordingDamage(0)
    const { state, out } = runTurn(
      [
        { hp: 300, spe: 100, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
        { hp: 300, spe: 50 },
      ],
      [useMove(1, move('MOVE_TACKLE')), null],
      testDeps(dmg.resolver),
      (s) => {
        encoreAt(0, 'MOVE_OUTRAGE')(s)
        // The state applyEncore hands to setActionsAndBattlersTurnOrder.
        expect(s.battlers[0]!.volatiles.encoredMove).toBe('MOVE_OUTRAGE')
        expect(s.battlers[0]!.volatiles.encoreTimer).toBe(3)
      },
    )
    expect(dmg.calls).toEqual([{ attackerId: 0, targetId: 1, moveId: 'MOVE_TACKLE', encoredMove: null }])
    expect(outcomeFor(out, 0).targetId).toBe(1)
    expect(state.battlers[0]!.volatiles.encoredMove).toBeNull()
    expect(state.battlers[0]!.volatiles.encoredMovePos).toBe(0)
    expect(state.battlers[0]!.volatiles.encoreTimer).toBe(0)
  })

  it('4b: the lock branch wins over the overwrite reset, so the stale encore survives its own action', () => {
    // Same overwritten slot, but :217-219 takes the branch first: the locked Outrage uses
    // the stored target and :228-236 never runs, so the encore is left untouched. The
    // 999-damage stub knocks the only foe out, and Cmd_checkteamslost sets the outcome
    // mid-action, which skips BattleTurnPassed's end-turn ladders -- ENDTURN_ENCORE
    // (:2792-2808) therefore never gets a chance to clear the stale encore, leaving the
    // use-time behaviour directly observable. Without the precedence guard applyEncore
    // would swap to the slot's Tackle and executeAction would clear the encore: the
    // resolver would then see moveId Tackle / encoredMove null.
    const dmg = recordingDamage(999)
    const { state, out } = runTurn(
      [
        { hp: 300, spe: 100, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0], status2: STATUS2_MULTIPLETURNS },
        { hp: 300, spe: 50 },
      ],
      [useMove(1, move('MOVE_OUTRAGE')), null],
      testDeps(dmg.resolver),
      (s) => {
        s.lockedMoves[0] = 'MOVE_OUTRAGE'
        encoreAt(0, 'MOVE_OUTRAGE')(s)
      },
      { opponentParty: [partyMon({ hp: 300, maxHp: 300 })] },
    )
    expect(dmg.calls).toEqual([{ attackerId: 0, targetId: 1, moveId: 'MOVE_OUTRAGE', encoredMove: 'MOVE_OUTRAGE' }])
    expect(outcomeFor(out, 0).targetId).toBe(1)
    expect(state.battleOutcome).toBe('WON')
    expect(state.battlers[0]!.volatiles.encoredMove).toBe('MOVE_OUTRAGE')
    expect(state.battlers[0]!.volatiles.encoredMovePos).toBe(0)
    expect(state.battlers[0]!.volatiles.encoreTimer).toBe(3)
  })
})

