/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150hbb: HandleAction_UseMove re-derives gBattlerTarget with
// GetMoveTarget(attacker, move, 0) on BOTH Encore branches, and MOVEEND_ABILITIES then
// dispatches on that re-derived target instead of the controller rule.
//
// C source at the pinned SHA (pipeline/.upstream/eliteredux-source/src/battle_util.c):
// - HandleAction_UseMove:221-225 (encoredMove still in its slot):
//     gCurrentMove = gChosenMove = encoredMove;
//     gBattlerTarget = gBattleStruct->moveTarget[gBattlerAttacker] =
//         GetMoveTarget(gBattlerAttacker, gCurrentMove, 0);                      // :226
// - HandleAction_UseMove:228-236 (encoredMove overwritten): resets the encore and
//     re-derives the same way from the slot's new move.                         // :236
// - GetMoveTarget:6343-6416 with setTarget == 0 reads
//   GetBattlerBattleMoveTargetFlags (battle_util.c:128-150) -- the DYNAMIC flags:
//     Rain Dance / Sunny Day / Sandstorm / Hail / Eerie Fog -> USER unless the
//     attacker has ABILITY_FORECAST; Expanding Force on Psychic Terrain and Toxic
//     Thread on Toxic Terrain -> BOTH; onModifyTargetFlag abilities too. Then the
//     Curse rule applies to EITHER side: Ghost or fog -> SELECTED, else USER
//     (:6353-6360). Then the switch (:6363-6415).
// - No controller code runs after HandleAction_UseMove before MOVEEND_ABILITIES:
//   battle_script_commands.c:4527-4531 calls
//   AbilityBattleEffects(ABILITYEFFECT_MOVE_END, gBattlerTarget)
//   (battle_util.c:4485-4489). The controller rules in resolveMoveEndDispatchTarget
//   only decide the target chosen at SELECTION, which Encore replaces.
//
// Probe: Crispy Cream's onDefender (src/abilities.cc:10837-10842) draws `Random() % 2`
// BEFORE anything else, so one rng draw from a dispatch = MOVEEND_ABILITIES ran on that
// battler; zero = it did not. Every draw count below is derived by hand from the C.
//
// Reversion note: tests 1 and 2 fail without this cycle's Encore re-derivation (the
// `target` and its `targetFromGetMoveTarget` flag are written together): the 150hb
// controller rule keeps the foe for the AI's non-Ghost Curse (static SELECTED) and for
// Rain Dance (the opponent controller ignores the dynamic flags), so the attacker-side
// holder would draw zero. Tests 3, 4 and 5 are negatives that the controller rule
// already satisfies. See REPORT.md for the narrower case (removing only the bypass
// guard while keeping the re-derived target) and why it is not observable here.
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

/** Runs one turn with a draw-counting RNG. `deps` defaults to a zero-damage resolver:
 * these are all status moves, so the damage seam must not fabricate a hit. `prepare`
 * mutates the freshly built state before the turn starts; test 3 uses it to isolate
 * the target dispatch from Forecast's unrelated onAttacker follow-up. */
function runTurn(
  specs: BattlerSpec[],
  actions: (ChosenAction | null)[],
  deps: TurnLoopDeps = testDeps(fixedDamage(0)),
  prepare?: (state: BattleState) => void,
) {
  const rng = scriptedRng([0])
  const state = battle(specs, rng)
  prepare?.(state)
  const out = executeTurn(state, actions, deps)
  return { rng, state, out }
}

/** HandleAction_UseMove:221-225's "encoredMove still in its slot" branch: the battler's
 * volatile points at the move that occupies that slot, so the encore is live. */
function encoreAI(moveId: string): (state: BattleState) => void {
  return (state) => {
    const v = state.battlers[1]!.volatiles
    v.encoredMove = moveId
    v.encoredMovePos = 0
    v.encoreTimer = 3
  }
}

// ---------------------------------------------------------------------------
// 1. Encored AI non-Ghost Curse. Static target is SELECTED, but GetMoveTarget's
//    Curse rule (:6353-6360) turns it into USER for the ATTACKER, on either side.
// ---------------------------------------------------------------------------

describe('Cycle 150hbb - Encore re-derives gBattlerTarget with GetMoveTarget', () => {
  it('1a: encored AI non-Ghost Curse dispatches on the attacker (own Crispy Cream draws once)', () => {
    // battle_util.c:226 puts GetMoveTarget(attacker, MOVE_CURSE, 0) into gBattlerTarget.
    // Non-Ghost, no fog -> MOVE_TARGET_USER -> targetBattler = attacker (:6402-6405),
    // so MOVEEND_ABILITIES reaches the AI's own holder. The 150hb non-encore test saw
    // zero draws here because the opponent controller reads only the static SELECTED.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50 },
        { hp: 300, spe: 200, moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [null, useMove(0, move('MOVE_CURSE'))],
      testDeps(fixedDamage(0)),
      encoreAI('MOVE_CURSE'),
    )
    expect(rng.calls).toBe(1)
  })

  it('1b: the same encored AI Curse does not dispatch on the foe (foe Crispy Cream draws none)', () => {
    // The re-derived gBattlerTarget is the attacker, so battler 0's holder is never the
    // defender in the MOVEEND_ABILITIES pass.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 200, moves: ['MOVE_CURSE', null, null, null], pp: [10, 0, 0, 0] },
      ],
      [null, useMove(0, move('MOVE_CURSE'))],
      testDeps(fixedDamage(0)),
      encoreAI('MOVE_CURSE'),
    )
    expect(rng.calls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 2. Encored AI Rain Dance without Forecast: the DYNAMIC flags return USER
  //    (battle_util.c:134-143), so the attacker is gBattlerTarget.
  // -------------------------------------------------------------------------

  it('2a: encored AI Rain Dance dispatches on the attacker (own Crispy Cream draws once)', () => {
    // GetMoveTarget's setTarget == 0 arm calls GetBattlerBattleMoveTargetFlags (:6350);
    // Rain Dance is in the weather list and the attacker has no Forecast, so it returns
    // MOVE_TARGET_USER and the switch (:6402-6405) picks the attacker.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50 },
        { hp: 300, spe: 200, moves: ['MOVE_RAIN_DANCE', null, null, null], pp: [10, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [null, useMove(0, move('MOVE_RAIN_DANCE'))],
      testDeps(fixedDamage(0)),
      encoreAI('MOVE_RAIN_DANCE'),
    )
    expect(rng.calls).toBe(1)
  })

  it('2b: the same encored AI Rain Dance does not dispatch on the foe (foe holder draws none)', () => {
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 200, moves: ['MOVE_RAIN_DANCE', null, null, null], pp: [10, 0, 0, 0] },
      ],
      [null, useMove(0, move('MOVE_RAIN_DANCE'))],
      testDeps(fixedDamage(0)),
      encoreAI('MOVE_RAIN_DANCE'),
    )
    expect(rng.calls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 3. Encored Rain Dance WITH Forecast: the dynamic branch falls through to the
  //    STATIC SELECTED target (:138-143), so the foe is gBattlerTarget.
  // -------------------------------------------------------------------------

  it('3: encored AI Rain Dance with Forecast falls back to SELECTED and dispatches on the foe', () => {
    // `if (!BATTLER_HAS_ABILITY(battler, ABILITY_FORECAST)) return MOVE_TARGET_USER;`
    // -- with Forecast there is no early return, GetBattlerBattleMoveTargetFlags
    // returns the static target (SELECTED, moves.json), and GetMoveTarget's SELECTED
    // case picks the opposing battler (:6363-6364).
    //
    // Forecast is in ATTACKER_FOLLOWUP_ABILITIES (moveEnd.ts:4436-4448): its
    // onAttacker hook queues a power-0 Weather Ball that this loop would otherwise
    // drain as an extra attack whose own draws would pollute the count. The sim's
    // `canUseExtraMove` honours `!round.attackCancelled` (mirrored from
    // battle_util.c:8716-8722); target flags never read that field.
    const suppressForecastFollowUp = (s: BattleState) => {
      encoreAI('MOVE_RAIN_DANCE')(s)
      s.battlers[1]!.round.attackCancelled = true
    }
    const foeHolder = runTurn(
      [
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 200, moves: ['MOVE_RAIN_DANCE', null, null, null], pp: [10, 0, 0, 0], abilities: hasAbility('ABILITY_FORECAST') },
      ],
      [null, useMove(0, move('MOVE_RAIN_DANCE'))],
      testDeps(fixedDamage(0)),
      suppressForecastFollowUp,
    )
    expect(foeHolder.rng.calls).toBe(1)

    // Same turn with the holder on the attacker instead: the attacker is not
    // gBattlerTarget, so its own Crispy Cream does not draw. This half catches an
    // implementation that returned USER without consulting Forecast.
    const userHolder = runTurn(
      [
        { hp: 300, spe: 50 },
        {
          hp: 300,
          spe: 200,
          moves: ['MOVE_RAIN_DANCE', null, null, null],
          pp: [10, 0, 0, 0],
          abilities: hasAbility('ABILITY_FORECAST', ['ABILITY_CRISPY_CREAM', null, null]),
        },
      ],
      [null, useMove(0, move('MOVE_RAIN_DANCE'))],
      testDeps(fixedDamage(0)),
      suppressForecastFollowUp,
    )
    expect(userHolder.rng.calls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 4. Negative: encored Ghost Curse keeps SELECTED (:6354-6355), so the foe.
  // -------------------------------------------------------------------------

  it('4: encored AI Ghost Curse dispatches on the foe (foe holder draws once)', () => {
    // `if (IS_BATTLER_OF_TYPE(attacker, TYPE_GHOST)) moveTarget = MOVE_TARGET_SELECTED;`
    // -- the Curse rule overrides even the static SELECTED with SELECTED, and the
    // SELECTED case picks the opposing battler.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        {
          hp: 300,
          spe: 200,
          types: ['GHOST', 'MYSTERY', 'MYSTERY'],
          moves: ['MOVE_CURSE', null, null, null],
          pp: [10, 0, 0, 0],
        },
      ],
      [null, useMove(0, move('MOVE_CURSE'))],
      testDeps(fixedDamage(0)),
      encoreAI('MOVE_CURSE'),
    )
    // Exactly one draw: the foe's holder. The attacker's own holder (a second run not
    // needed here) would draw zero because the attacker is not the dispatch target.
    expect(rng.calls).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 5. Negative: the SAME Rain Dance without Encore keeps 150hb's controller
  //    rule -- the opponent controller reads the static SELECTED target.
  // -------------------------------------------------------------------------

  it('5: non-encored AI Rain Dance still dispatches on the foe (static target, 150hb behaviour)', () => {
    // No Encore means applyEncore does not set targetFromGetMoveTarget; the opponent
    // controller path in resolveMoveEndDispatchTarget reads the static SELECTED target
    // (battle_controller_opponent.c:1598-1601), so the foe's holder draws.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 200, moves: ['MOVE_RAIN_DANCE', null, null, null], pp: [10, 0, 0, 0] },
      ],
      [null, useMove(0, move('MOVE_RAIN_DANCE'))],
    )
    expect(rng.calls).toBe(1)
  })
})

