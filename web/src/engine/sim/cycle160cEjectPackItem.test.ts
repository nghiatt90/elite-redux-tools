/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 160c: Eject Pack's ITEM branch (SWITCH_ITEM), the second half of
// ChangeStatBuffs' Eject Pack block (battle_script_commands.c:9885-9892). The
// ability branch above it is cycle 160's.
//
// Scheduling (battle_script_commands.c:9877-9892) is an `if`/`else if`: an Eject
// Pack holder whose Eject Pack ability fired never reaches the item test.
// GetBattlerHoldEffect(battler, TRUE) returns HOLD_EFFECT_NONE when IsItemNegated
// (battle_util.c:6526-6527; :6520-6524 = STATUS3_EMBARGO or ABILITY_KLUTZ), and
// IsUnnerveAbilityOnOpposingSide is the other schedule-time gate.
//
// The drain (battle_util.c:787-816) filters a SWITCH_ITEM entry on the item still
// being held, IsItemNegated and Unnerve (:795-799), then CanBattlerSwitch (:812).
// BattleScript_EjectButtonActivates (data/battle_scripts_1.s:11352-11376) runs
// removeitem BS_ATTACKER (:11357) BEFORE openpartyscreen, so the item is consumed
// only when the drain already proved a switch possible.
//
// Every expected number is hand-derived from the C in a comment.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { TypeChart } from '../typeEffectiveness'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { drainQueuedSwitches, executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { BATTLE_TYPE_TRAINER, STAT_ATK, STATUS3_EMBARGO } from './constants'
import { changeStatBuffs } from './statBuffs'

// ---------------------------------------------------------------------------
// Snapshot-backed fixtures, the shape cycle160EnragedEjectPackMinion.test.ts uses.
// ---------------------------------------------------------------------------

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id as string, item]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
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
  atk?: number
  spe?: number
  hp?: number
  maxHp?: number
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  itemId?: string | null
}

function battle(
  specs: BattlerSpec[],
  rng: RandomSource,
  opts: { playerParty?: SimPartyMon[]; opponentParty?: SimPartyMon[]; battleTypeFlags?: number } = {},
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          itemId: s.itemId ?? null,
        }),
        0,
      ),
    ),
    rng,
    playerParty: opts.playerParty,
    opponentParty: opts.opponentParty,
    battleTypeFlags: opts.battleTypeFlags,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
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
    resolvedType: moveData.type ?? 'NORMAL',
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

/** A resolver that returns a fixed amount with no draws; the turn loop still draws accuracy (and any
 *  secondary chance) itself. Copied from cycle160EnragedEjectPackMinion.test.ts. */
function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function testDeps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
    // BattleScript_EjectButtonActivates (data/battle_scripts_1.s:11352-11376) draws no random
    // number; the pick is the same injected chooser the faint path uses.
    replacement: { chooseReplacement: () => 1 },
  }
}

const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const ability = (id: string, ...innates: (string | null)[]): SimBattleMon['abilities'] => ({
  ability: id,
  innates: [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null],
})
const move = (id: string): SimMoveData => requireMove(id)

function partyMon(speciesId: string | null, hp: number): SimPartyMon {
  return {
    speciesId,
    hp,
    maxHp: 100,
    level: 50,
    moves: [null, null, null, null],
    pp: [0, 0, 0, 0],
    itemId: null,
    abilities: { ability: null, innates: [null, null, null] },
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
  }
}

const GROWL = move('MOVE_GROWL') // NORMAL, SPECIAL, 60 power, EFFECT_ATTACK_DOWN_HIT at 100% (Atk -1)

/** Battler 0 uses Growl on battler 1; battler 1 holds ITEM_EJECT_PACK (or has `holderAbility`). */
function ejectPackState(
  rng: RandomSource,
  opts: { reserve: boolean; holderAbility?: SimBattleMon['abilities']; holderItem?: string | null; opponentAbility?: SimBattleMon['abilities'] },
) {
  const party = opts.reserve
    ? [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)]
    : [partyMon('SPECIES_MUDKIP', 100)]
  return battle(
    [
      { moves: slot(GROWL.id), pp: pps, abilities: opts.opponentAbility },
      { abilities: opts.holderAbility ?? { ability: null, innates: [null, null, null] }, itemId: opts.holderItem ?? null, hp: 100, maxHp: 100 },
    ],
    rng,
    { opponentParty: party, battleTypeFlags: BATTLE_TYPE_TRAINER },
  )
}

function growlDrop(state: BattleState): { unmodelled: string[] } {
  const unmodelled: string[] = []
  changeStatBuffs(state, 1, 0, 1, -1, STAT_ATK, 0, false, { dataContext: DATA_CONTEXT, grounding: GROUNDING }, unmodelled, 'MOVE_GROWL')
  return { unmodelled }
}

function turn(state: BattleState, moveData: SimMoveData, damage = 20) {
  return executeTurn(state, [useMove(1, moveData), null], testDeps(fixedDamage(damage)))
}

// ---------------------------------------------------------------------------
// Scheduling: battle_script_commands.c:9885-9892
// ---------------------------------------------------------------------------

describe('cycle 160c - Eject Pack item branch (battle_script_commands.c:9885-9892)', () => {
  it('queues the exact SWITCH_ITEM entry at unit level', () => {
    // The ability `if` (:9877-9884) fails (no Eject Pack ability), so the item `else if` runs:
    // GetBattlerHoldEffect(holder, TRUE) == HOLD_EFFECT_EJECT_PACK, no Unnerve, no negation.
    const state = ejectPackState(scriptedRng([]), { reserve: true, holderItem: 'ITEM_EJECT_PACK' })
    const { unmodelled } = growlDrop(state)

    expect(state.queuedSwitches).toEqual([
      { ability: '', cause: 'ITEM', item: 'ITEM_EJECT_PACK', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EJECT_BUTTON' },
    ])
    expect(unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
    // The item is consumed by the drain's script, not at schedule time.
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_EJECT_PACK')
  })

  it('end to end: switches to the reserve and consumes the item', () => {
    // Growl: accuracy draw 0 (hit), effect chance draw 0 (Atk -1 fires). The drain then filters
    // CanBattlerSwitch (:812) and asks deps.replacement for slot 1. No Random() runs on
    // BattleScript_EjectButtonActivates (data/battle_scripts_1.s:11352-11376), so the pick adds no
    // draw; the third draw is the end-of-turn speed tie-break. The script's removeitem (:11357)
    // runs before openpartyscreen (:11359).
    const rng = scriptedRng([0, 0])
    const state = ejectPackState(rng, { reserve: true, holderItem: 'ITEM_EJECT_PACK' })
    const outgoing = state.battlers[1]!
    const out = turn(state, GROWL)

    expect(rng.calls).toBe(3) // accuracy + secondary + the end-of-turn speed tie-break; the pick draws nothing
    expect(state.battlers[1]!.partyIndex).toBe(1) // switched into the reserve
    expect(state.battlers[1]!.mon.itemId).toBeNull() // removeitem BS_ATTACKER (:11357)
    // The C's usedHeldItems is keyed by party slot; the sim carries it on the battler object that
    // consumed the item, which switchIn then replaces. Read it off the outgoing object.
    expect(outgoing.usedHeldItem).toBe('ITEM_EJECT_PACK')
    expect(state.queuedSwitches).toEqual([])
    expect(out.actions[0]!.unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('no reserve: CanBattlerSwitch fails and the item is NOT consumed', () => {
    // The drain filters before the script runs (battle_util.c:812 before data/battle_scripts_1.s:11357),
    // so removeitem never executes.
    const state = ejectPackState(scriptedRng([0, 0]), { reserve: false, holderItem: 'ITEM_EJECT_PACK' })
    const out = turn(state, GROWL)

    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_EJECT_PACK')
    expect(state.battlers[1]!.usedHeldItem ?? null).toBeNull()
    expect(state.queuedSwitches).toEqual([])
    expect(out.actions[0]!.unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('opposing Unnerve: nothing is queued', () => {
    // :9890 !IsUnnerveAbilityOnOpposingSide(battler) -- Unnerve sits on the foe's side.
    const state = ejectPackState(scriptedRng([]), {
      reserve: true,
      holderItem: 'ITEM_EJECT_PACK',
      opponentAbility: ability('ABILITY_UNNERVE'),
    })
    const { unmodelled } = growlDrop(state)

    expect(state.queuedSwitches).toEqual([])
    expect(unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('Embargo on the holder: nothing is queued (GetBattlerHoldEffect negation)', () => {
    // GetBattlerHoldEffect(battler, TRUE) returns HOLD_EFFECT_NONE when IsItemNegated
    // (battle_util.c:6520-6527): STATUS3_EMBARGO, or ABILITY_KLUTZ.
    const state = ejectPackState(scriptedRng([]), { reserve: true, holderItem: 'ITEM_EJECT_PACK' })
    state.battlers[1]!.statuses3 = STATUS3_EMBARGO
    const { unmodelled } = growlDrop(state)

    expect(state.queuedSwitches).toEqual([])
    expect(unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('ability branch wins: the ABILITY entry is queued and the item stays held', () => {
    // The C is an `if`/`else if` (:9877-9892): a holder with both the ability and the item takes
    // the ability branch only.
    const state = ejectPackState(scriptedRng([]), {
      reserve: true,
      holderAbility: ability('ABILITY_EJECT_PACK_ABILITY'),
      holderItem: 'ITEM_EJECT_PACK',
    })
    const { unmodelled } = growlDrop(state)

    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_EJECT_PACK_ABILITY', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EMERGENCY_EXIT' },
    ])
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_EJECT_PACK')
    expect(unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })

  it('same-turn second drop: tryScheduleSwitch keeps only the first entry', () => {
    // TryScheduleSwitch (battle_util.c:369-376) rejects a second entry for the same switchingBattler.
    const state = ejectPackState(scriptedRng([]), { reserve: true, holderItem: 'ITEM_EJECT_PACK' })
    growlDrop(state)
    growlDrop(state)

    expect(state.queuedSwitches).toEqual([
      { ability: '', cause: 'ITEM', item: 'ITEM_EJECT_PACK', setAbilityState: false, switchingBattler: 1, sourceBattler: 1, script: 'EJECT_BUTTON' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Drain filter: battle_util.c:795-799
// ---------------------------------------------------------------------------

describe('cycle 160c - SWITCH_ITEM drain filters (battle_util.c:795-799)', () => {
  it('drops the entry when the holder no longer holds the queued item', () => {
    // FILTER(gBattleMons[source].item == gQueuedSwitchData[0].item) (:795).
    const state = ejectPackState(scriptedRng([]), { reserve: true, holderItem: 'ITEM_EJECT_PACK' })
    state.queuedSwitches.push({
      ability: '',
      cause: 'ITEM',
      item: 'ITEM_EJECT_PACK',
      setAbilityState: false,
      switchingBattler: 1,
      sourceBattler: 1,
      script: 'EJECT_BUTTON',
    })
    state.battlers[1]!.mon.itemId = null // the item left the holder before the drain

    const unmodelled: string[] = []
    drainQueuedSwitches(state, testDeps(fixedDamage(0)), unmodelled)

    expect(state.queuedSwitches).toEqual([])
    expect(state.battlers[1]!.partyIndex).toBe(0) // no switch
    expect(state.battlers[1]!.mon.itemId).toBeNull() // nothing consumed
    expect(unmodelled.some((u) => u.includes('Eject Pack'))).toBe(false)
  })
})
