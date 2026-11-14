/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150hbc: resolveMoveEndDispatchTarget compared move-target flags as strings, so
// MOVE_TARGET_ALL_BATTLERS fell through to the selected target (the foe). Both controllers
// test BITS, and ALL_BATTLERS carries MOVE_TARGET_USER.
//
// C source at the pinned SHA (pipeline/.upstream/eliteredux-source):
// - include/constants/battle.h:499-501:
//     #define MOVE_TARGET_USER_OR_ALLY MOVE_TARGET_USER | MOVE_TARGET_ALLY
//     #define MOVE_TARGET_ALL_BATTLERS (0x100 | MOVE_TARGET_USER)
// - Player, src/battle_controller_player.c:2385-2398: Curse special case, else
//     moveTarget = GetBattlerBattleMoveTargetFlags(...); then
//     `if (moveTarget & MOVE_TARGET_USER) gMultiUsePlayerCursor = gActiveBattler;`.
//   A bit test, so USER, USER_OR_ALLY and ALL_BATTLERS all select the user;
//   USER_OR_SELECTED (0x2) does not carry the USER bit on the player side.
// - Opponent, src/battle_controller_opponent.c:1600-1601, 1625-1626:
//     `if (gBattleMoves[move].target & (MOVE_TARGET_USER_OR_SELECTED | MOVE_TARGET_USER))
//          gBattlerTarget = gActiveBattler;`
//   so USER, USER_OR_SELECTED, USER_OR_ALLY and ALL_BATTLERS all select the user.
// - MOVEEND_ABILITIES then runs AbilityBattleEffects(ABILITYEFFECT_MOVE_END, gBattlerTarget)
//   (src/battle_script_commands.c:4527-4531, src/battle_util.c:4485-4489).
//
// Probe: Crispy Cream's onDefender (src/abilities.cc:10837-10842) draws `Random() % 2`
// BEFORE anything else and only then gates on targetDamage > 0, so one rng draw from a
// dispatch = MOVEEND_ABILITIES ran on that battler holding it, zero = it did not.
//
// Reversion note: tests 1, 2, 3 and 4 exercise the helper directly -- tests 1/3 fail
// without it (the foe, not the holder, is dispatched, so the holder draws zero) and
// tests 2/4 fail without it (the holder, not the foe-attacker, is dispatched, so the
// holder draws one). Test 5 is the regression guard for a plain SELECTED move, which the
// helper deliberately leaves on targetIdForDispatch.
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

/** Runs one turn with a draw-counting RNG. The damage resolver is fixed at zero: these
 * are all status moves, so the damage seam must not fabricate a hit. */
function runTurn(
  specs: BattlerSpec[],
  actions: (ChosenAction | null)[],
  deps: TurnLoopDeps = testDeps(fixedDamage(0)),
) {
  const rng = scriptedRng([0])
  const state = battle(specs, rng)
  const out = executeTurn(state, actions, deps)
  return { rng, state, out }
}

describe('Cycle 150hbc - ALL_BATTLERS carries the MOVE_TARGET_USER bit', () => {
  it('1: AI Trick Room dispatches MOVEEND_ABILITIES on itself (own Crispy Cream draws once)', () => {
    // moves.json: MOVE_TRICK_ROOM target ALL_BATTLERS, effect EFFECT_TRICK_ROOM. handleTrickRoom
    // (moveEffects.ts:3475) only deducts PP and toggles the field timer -- no Random().
    // Opponent controller (battle_controller_opponent.c:1600-1601, 1625-1626) tests
    // `target & (MOVE_TARGET_USER_OR_SELECTED | MOVE_TARGET_USER)`: ALL_BATTLERS is
    // 0x100 | MOVE_TARGET_USER (battle.h:501), so gBattlerTarget = gActiveBattler (battler 1).
    // MOVEEND_ABILITIES on battler 1 runs Crispy Cream's onDefender (abilities.cc:10837-10842):
    // one `Random() % 2` draw, then the `targetDamage > 0` gate stops it (status move -> 0).
    // Exactly one draw.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50 },
        { hp: 300, spe: 200, moves: ['MOVE_TRICK_ROOM', null, null, null], pp: [5, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [null, useMove(0, move('MOVE_TRICK_ROOM'))],
    )
    expect(rng.calls).toBe(1)
  })

  it('2: the same AI Trick Room does not dispatch on the foe (foe Crispy Cream draws none)', () => {
    // The controller sets gBattlerTarget = gActiveBattler (the AI attacker, battler 1), so the
    // foe (battler 0) is never the MOVEEND_ABILITIES target: its holder is not reached. Battler
    // 1 has no abilities, so no draw at all. Reverting the bit test dispatches on battler 0 and
    // this becomes 1.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 200, moves: ['MOVE_TRICK_ROOM', null, null, null], pp: [5, 0, 0, 0] },
      ],
      [null, useMove(0, move('MOVE_TRICK_ROOM'))],
    )
    expect(rng.calls).toBe(0)
  })

  it('3: player Haze dispatches MOVEEND_ABILITIES on itself (own Crispy Cream draws once)', () => {
    // moves.json: MOVE_HAZE target ALL_BATTLERS, effect EFFECT_HAZE. handleHaze
    // (moveEffects.ts:3542) deducts PP and resets stat changes -- no Random().
    // Player controller (battle_controller_player.c:2394-2398) gets the flag from
    // GetBattlerBattleMoveTargetFlags (moveTargetFlags.ts:51), which passes the
    // ALL_BATTLERS string through, then tests `moveTarget & MOVE_TARGET_USER`
    // (battle.h:501: ALL_BATTLERS = 0x100 | USER) -> gActiveBattler (battler 0).
    // One Crispy Cream coin, then the targetDamage gate: exactly one draw.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 100, moves: ['MOVE_HAZE', null, null, null], pp: [20, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 50 },
      ],
      [useMove(1, move('MOVE_HAZE')), null],
    )
    expect(rng.calls).toBe(1)
  })

  it('4: the same player Haze does not dispatch on the foe (foe Crispy Cream draws none)', () => {
    // gBattlerTarget is the player's own battler 0, which has no abilities: zero draws.
    // Reverting the bit test dispatches on the selected foe (battler 1) and this becomes 1.
    const { rng } = runTurn(
      [
        { hp: 300, spe: 100, moves: ['MOVE_HAZE', null, null, null], pp: [20, 0, 0, 0] },
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [useMove(1, move('MOVE_HAZE')), null],
    )
    expect(rng.calls).toBe(0)
  })

  it('5: a plain SELECTED status move still dispatches on the foe (1 on the foe, 0 on the attacker)', () => {
    // Regression guard: the helper must not turn every target into the user. moves.json
    // MOVE_MEAN_LOOK is SELECTED / EFFECT_MEAN_LOOK, handled at moveEffects.ts:4527.
    // The opponent controller reads the static SELECTED target (no USER bit, not
    // USER_OR_SELECTED), so gBattlerTarget = targetIdForDispatch = battler 0 (the foe).
    // Mean Look's accuracycheck is NO_ACC_CALC_CHECK_LOCK_ON (:4541) -- no `Random() % 100`
    // roll -- so the only draw is Crispy Cream's coin on the dispatched battler.
    // (MOVE_TOXIC would behave the same way through the dispatch, but its handler
    // calls checkAccuracy -> an extra Random() % 100 at battle_script_commands.c:1433,
    // so the counts would be 2 and 1 for an unrelated reason.)
    const foeHolder = runTurn(
      [
        { hp: 300, spe: 50, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
        { hp: 300, spe: 200, moves: ['MOVE_MEAN_LOOK', null, null, null], pp: [10, 0, 0, 0] },
      ],
      [null, useMove(0, move('MOVE_MEAN_LOOK'))],
    )
    expect(foeHolder.rng.calls).toBe(1)

    const userHolder = runTurn(
      [
        { hp: 300, spe: 50 },
        { hp: 300, spe: 200, moves: ['MOVE_MEAN_LOOK', null, null, null], pp: [10, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      ],
      [null, useMove(0, move('MOVE_MEAN_LOOK'))],
    )
    expect(userHolder.rng.calls).toBe(0)
  })
})
