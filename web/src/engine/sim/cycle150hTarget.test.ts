/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150h: MOVEEND_ABILITIES must dispatch on the C's gBattlerTarget, which for a
// self-targeting move is the ATTACKER, not the foe named by the AI's action.target.
//
// Hand-derived from eliteredux-source at the pinned SHA:
// - battle_controller_opponent.c:1600-1601 (return-values path) and :1625-1626 (the
//   no-return-values path): `if (gBattleMoves[move].target & (MOVE_TARGET_USER_OR_SELECTED |
//   MOVE_TARGET_USER)) gBattlerTarget = gActiveBattler;` -- the attacker. The AI's action.target
//   is always the foe (ai/chooseAiAction.ts:134,196), so the sim's targetId is wrong for these.
// - battle_util.c:236-292: gBattlerTarget is read back from gBattleStruct->moveTarget[attacker],
//   written from that controller buffer (battle_main.c:3687, 3916); the MOVE_TARGET_ALLY branch
//   (:283-287) picks the live partner, else the attacker.
// - battle_script_commands.c:4527-4530 + battle_util.c:4485-4489: MOVEEND_ABILITIES runs
//   AbilityBattleEffects(ABILITYEFFECT_MOVE_END, gBattlerTarget).
// - Impl<ABILITY_CRISPY_CREAM>.onDefender (src/abilities.cc:10837-10842) draws `Random() % 2`
//   before either delegated hook and before their ShouldApplyOnHitEffect check, so the holder
//   spends one draw even on a zero-damage dispatch. Used here as the target-identity probe.
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
import { STATUS1_PARALYSIS } from './constants'

// ---------------------------------------------------------------------------
// Scaffolding -- snapshot-backed SimDataContext with real species records,
// copied from cycle150cFidelity.test.ts.
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

function testDeps(damage: DamageResolver = fixedDamage(20), grounding: GroundingContext = GROUNDING): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart: typeChart as never, inverseTypeChart: inverseTypeChart as never, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const hasAbility = (ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): SimBattleMon['abilities'] => ({ ability, innates })


// ---------------------------------------------------------------------------
// Item 1 -- the canceller exit dispatches on the attacker for a USER move.
// ---------------------------------------------------------------------------

describe('Cycle 150h - self-target MOVEEND_ABILITIES dispatch', () => {
  // CANCELLER_PARALYSED (battle_util.c:3400-3413): `(Random() % 4) == 0` cancels. Swords Dance's
  // data target is USER, so battle_controller_opponent.c:1600-1601 overwrites the controller's
  // foe target with gActiveBattler before MoveEnd runs. One draw for the paralysis roll, one for
  // the attacker's own Crispy Cream %2 (abilities.cc:10837-10842 draws before any check).
  // spe 200: turnOrder.ts halves a paralysed battler's speed for ordering, so 200 -> 100 still
  // outruns the foe's default 50 and the attacker keeps the first slot.
  it('1: a fully paralysed Swords Dance user runs its own Crispy Cream (2 draws)', () => {
    const rng = scriptedRng([0])
    const state = battle([
      {
        status1: STATUS1_PARALYSIS,
        spe: 200,
        moves: ['MOVE_SWORDS_DANCE', null, null, null],
        pp: [20, 0, 0, 0],
        abilities: hasAbility('ABILITY_CRISPY_CREAM'),
      },
      { hp: 300 },
    ], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_SWORDS_DANCE')), null], testDeps(fixedDamage(0)))
    expect(out.actions[0]!.cancelledBy).toBe('PARALYSIS')
    expect(rng.calls).toBe(2)
    // The dispatch carries targetDamage 0, so the delegated Flame Body / Freezing Point half
    // applies nothing; the paralysis bit is all that remains.
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_PARALYSIS)
  })

  // Same turn, holder on the foe only: the foe is not gBattlerTarget, so its Crispy Cream never
  // draws. Only the paralysis roll is spent.
  it('2: the same turn with Crispy Cream on the foe only draws just once', () => {
    const rng = scriptedRng([0])
    const state = battle([
      { status1: STATUS1_PARALYSIS, spe: 200, moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], rng)
    const out = executeTurn(state, [useMove(1, move('MOVE_SWORDS_DANCE')), null], testDeps(fixedDamage(0)))
    expect(out.actions[0]!.cancelledBy).toBe('PARALYSIS')
    expect(rng.calls).toBe(1)
  })

  // The status-move exit (turn.ts's handler path, not the canceller) has the same rule: a normal
  // Swords Dance dispatches on the attacker, so only the user's Crispy Cream draws.
  it('status-move exit: user-side holder draws one %2, foe-side holder draws none', () => {
    const userRng = scriptedRng([0])
    const user = battle([
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      { hp: 300 },
    ], userRng)
    executeTurn(user, [useMove(1, move('MOVE_SWORDS_DANCE')), null], testDeps(fixedDamage(0)))
    expect(userRng.calls).toBe(1)

    const foeRng = scriptedRng([0])
    const foe = battle([
      { moves: ['MOVE_SWORDS_DANCE', null, null, null], pp: [20, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], foeRng)
    executeTurn(foe, [useMove(1, move('MOVE_SWORDS_DANCE')), null], testDeps(fixedDamage(0)))
    expect(foeRng.calls).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Item 3 -- damaging SELECTED moves keep the foe target; the fix must not reach them.
  // -------------------------------------------------------------------------

  it('3: a fully paralysed Tackle still dispatches on the foe (holder there draws once)', () => {
    const foeRng = scriptedRng([0])
    const foe = battle([
      { status1: STATUS1_PARALYSIS, spe: 200, moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0] },
      { hp: 300, abilities: hasAbility('ABILITY_CRISPY_CREAM') },
    ], foeRng)
    const out = executeTurn(foe, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(out.actions[0]!.cancelledBy).toBe('PARALYSIS')
    expect(foeRng.calls).toBe(2) // paralysis roll + the foe's %2

    const userRng = scriptedRng([0])
    const user = battle([
      { status1: STATUS1_PARALYSIS, spe: 200, moves: ['MOVE_TACKLE', null, null, null], pp: [20, 0, 0, 0], abilities: hasAbility('ABILITY_CRISPY_CREAM') },
      { hp: 300 },
    ], userRng)
    executeTurn(user, [useMove(1, move('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(userRng.calls).toBe(1) // paralysis roll only: the attacker is not the dispatched holder
  })
})
