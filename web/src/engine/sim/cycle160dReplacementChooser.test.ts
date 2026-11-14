/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 160d: Emergency Exit / Wimp Out / Hollow Ice Zone (script EMERGENCY_EXIT) and
// Eject Pack / Eject Button (script EJECT_BUTTON) queued switches pick their replacement
// through deps.replacement, the same injected chooser the faint path uses.
//
// Neither script draws a random number:
//  - BattleScript_EjectButtonActivates (data/battle_scripts_1.s:11352-11376): removeitem
//    BS_ATTACKER (:11357), openpartyscreen (:11359), no Random() command.
//  - BattleScript_EmergencyExit (data/battle_scripts_1.s:9479-9500): openpartyscreen (:9487),
//    no Random() command.
// The player picks through the party screen; the AI through GetMostSuitableMonToSwitchInto
// (src/battle_controller_opponent.c:1645-1656).
//
// Scaffolding copied from cycle160cEjectPackItem.test.ts (snapshot-backed fixtures, battle,
// scriptedRng, ejectPackState) and cycle145bAbilities.test.ts (crossedBattle / defenderHit).

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
import type { ReplacementDeps } from './switchIn'
import { BATTLE_TYPE_TRAINER, STAT_ATK } from './constants'
import { changeStatBuffs } from './statBuffs'
import { dispatchMoveEndAttackerAbilities, dispatchMoveEndDefenderAbilities } from './moveEnd'

// ---------------------------------------------------------------------------
// Snapshot-backed fixtures, the shape cycle160cEjectPackItem.test.ts uses.
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

/** A resolver that returns a fixed amount with no draws; the turn loop still draws accuracy. */
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

function testDeps(damage: DamageResolver, replacement?: ReplacementDeps): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    moveBehaviors,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
    replacement,
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

const TACKLE = move('MOVE_TACKLE') // NORMAL, PHYSICAL, 40 power, accuracy 100, no secondary
const GROWL = move('MOVE_GROWL') // NORMAL, SPECIAL, EFFECT_ATTACK_DOWN_HIT at 100% (Atk -1)
const ICE_BEAM = move('MOVE_ICE_BEAM')

/** Three live party slots: the active slot 0 plus reserves 1 and 2. */
function liveParty(): SimPartyMon[] {
  return [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)]
}

/** Keeps the incoming mon slower than the attacker so the end-of-turn speed tie-break
 *  (getFastestBattler) never draws and the cursor only reflects the scripted attack. */
function slowReserve(party: SimPartyMon[], index: number): SimPartyMon[] {
  party[index]!.rawStats = { ...party[index]!.rawStats, spe: 10 }
  return party
}

/** Battler 0 uses Growl on the Eject Pack holder (battler 1). */
function ejectPackBattle(rng: RandomSource, party: SimPartyMon[]) {
  return battle(
    [{ moves: slot(GROWL.id), pp: pps }, { hp: 100, maxHp: 100, itemId: 'ITEM_EJECT_PACK' }],
    rng,
    { opponentParty: party, battleTypeFlags: BATTLE_TYPE_TRAINER },
  )
}

/** Schedules Eject Pack's SWITCH_ITEM entry through ChangeStatBuffs (battle_script_commands.c:9885-9892). */
function scheduleEjectPack(state: BattleState): string[] {
  const unmodelled: string[] = []
  changeStatBuffs(state, 1, 0, 1, -1, STAT_ATK, 0, false, { dataContext: DATA_CONTEXT, grounding: GROUNDING }, unmodelled, 'MOVE_GROWL')
  return unmodelled
}

/** A holder on `holder`'s side of the field. `hp` is 100 for a turn loop that applies a
 *  60-damage hit, or 40 for a direct dispatch that only reports hpDealt = 60. */
function crossedBattle(holder: 0 | 1, rng: RandomSource, party: SimPartyMon[], hp: number): BattleState {
  const holderAbilities = ability('ABILITY_EMERGENCY_EXIT')
  const specs: BattlerSpec[] =
    holder === 0
      ? [{ spe: 200, hp, maxHp: 100, abilities: holderAbilities }, { spe: 50 }]
      : [{ spe: 200 }, { spe: 50, hp, maxHp: 100, abilities: holderAbilities }]
  return battle(specs, rng, {
    playerParty: holder === 0 ? party : undefined,
    opponentParty: holder === 1 ? party : undefined,
    battleTypeFlags: BATTLE_TYPE_TRAINER,
  })
}

/** Runs BattleScript_EmergencyExit's schedule (the onDefender hook) without a turn loop. */
function scheduleEmergencyExit(state: BattleState, holder: 0 | 1, unmodelled: string[]): void {
  dispatchMoveEndDefenderAbilities({
    state,
    attackerId: holder === 0 ? 1 : 0,
    targetId: holder,
    moveId: TACKLE.id,
    moveData: TACKLE,
    targetDamage: 60,
    hpDealt: 60,
    deps: testDeps(fixedDamage(0)),
    unmodelled,
    fainted: [],
  })
}

// ---------------------------------------------------------------------------
// 1. Emergency Exit uses the injected chooser on both sides, with no rng draw.
// ---------------------------------------------------------------------------

describe('cycle 160d - Emergency Exit replacement chooser', () => {
  it('player side (even battler 0): a chooser returning slot 2 brings slot 2 in, not slot 1', () => {
    // BattleScript_EmergencyExit (data/battle_scripts_1.s:9479-9500) has no Random(); the pick
    // is the chooser's. Tackle draws accuracy only, and the reserve is slower than the attacker,
    // so the cursor is 1 -- the replacement adds nothing.
    const rng = scriptedRng([0])
    const state = crossedBattle(0, rng, slowReserve(liveParty(), 2), 100)
    const chosen: number[] = []
    const deps = testDeps(fixedDamage(60), {
      chooseReplacement: (_state, battlerId) => {
        chosen.push(battlerId)
        return 2
      },
    })

    executeTurn(state, [null, useMove(0, TACKLE)], deps)

    expect(chosen).toEqual([0])
    expect(state.battlers[0]!.partyIndex).toBe(2)
    expect(rng.calls).toBe(1) // Tackle accuracy only
    expect(state.queuedSwitches).toEqual([])
  })

  it('opponent side (odd battler 1): the chooser returns the other slot and it enters', () => {
    const rng = scriptedRng([0])
    const state = crossedBattle(1, rng, slowReserve(liveParty(), 2), 100)
    const deps = testDeps(fixedDamage(60), { chooseReplacement: () => 2 })

    executeTurn(state, [useMove(1, TACKLE), null], deps)

    expect(state.battlers[1]!.partyIndex).toBe(2)
    expect(rng.calls).toBe(1) // Tackle accuracy only
    expect(state.queuedSwitches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Eject Pack item (EJECT_BUTTON) uses the chooser; removeitem still runs first.
// ---------------------------------------------------------------------------

describe('cycle 160d - Eject Button / Eject Pack replacement chooser', () => {
  it('consumes the item, sends in the chooser pick and adds no rng draw', () => {
    // Growl draws accuracy + secondary. BattleScript_EjectButtonActivates
    // (data/battle_scripts_1.s:11352-11376) draws nothing, so the cursor stays at 2.
    const rng = scriptedRng([0, 0])
    const state = ejectPackBattle(rng, slowReserve(liveParty(), 1))
    const deps = testDeps(fixedDamage(20), { chooseReplacement: () => 1 })

    executeTurn(state, [useMove(1, GROWL), null], deps)

    expect(state.battlers[1]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.mon.itemId).toBeNull() // removeitem BS_ATTACKER (:11357)
    expect(rng.calls).toBe(2) // accuracy + secondary only
    expect(state.queuedSwitches).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Hollow Ice Zone queues EMERGENCY_EXIT for the attacker and uses the chooser.
// ---------------------------------------------------------------------------

describe('cycle 160d - Hollow Ice Zone replacement chooser', () => {
  it('the attacker-side EMERGENCY_EXIT entry takes the chooser pick', () => {
    // Hollow Ice Zone (src/abilities.cc:12178-12198) queues BattleScript_EmergencyExitPopupNoPause
    // with switchingBattler = sourceBattler = the attacker. The script draws nothing.
    const rng = scriptedRng([])
    const party = slowReserve(liveParty(), 2)
    const state = battle(
      [{ spe: 200, abilities: ability('ABILITY_HOLLOW_ICE_ZONE'), moves: slot(ICE_BEAM.id), pp: pps }, { spe: 50 }],
      rng,
      { playerParty: party, battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    const unmodelled: string[] = []
    dispatchMoveEndAttackerAbilities({
      state,
      attackerId: 0,
      targetId: 1,
      moveId: ICE_BEAM.id,
      moveData: ICE_BEAM,
      targetDamage: 20,
      hpDealt: 20,
      deps: testDeps(fixedDamage(20)),
      unmodelled,
      fainted: [],
    })
    expect(state.queuedSwitches).toEqual([
      { ability: 'ABILITY_HOLLOW_ICE_ZONE', setAbilityState: false, switchingBattler: 0, sourceBattler: 0, script: 'EMERGENCY_EXIT' },
    ])

    drainQueuedSwitches(state, testDeps(fixedDamage(0), { chooseReplacement: () => 2 }), unmodelled)

    expect(state.battlers[0]!.partyIndex).toBe(2)
    expect(rng.calls).toBe(0) // neither the schedule nor the pick draws
  })
})

// ---------------------------------------------------------------------------
// 4. No deps.replacement: no switch, a note naming the script, item still consumed.
// ---------------------------------------------------------------------------

describe('cycle 160d - missing deps.replacement', () => {
  it('Eject Pack: removeitem already ran, so the item is consumed but the holder stays in', () => {
    // C order: removeitem (:11357) precedes openpartyscreen (:11359). With no chooser the sim
    // cannot run the party screen, so it records the gap after the consumption.
    const rng = scriptedRng([])
    const state = ejectPackBattle(rng, liveParty())
    const unmodelled = scheduleEjectPack(state)
    const outgoing = state.battlers[1]!

    drainQueuedSwitches(state, testDeps(fixedDamage(0)), unmodelled)

    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(state.battlers[1]!.mon.itemId).toBeNull() // removeitem ran before the pick
    expect(outgoing.usedHeldItem).toBe('ITEM_EJECT_PACK')
    expect(unmodelled.some((u) => u.includes('EJECT_BUTTON') && u.includes('no deps.replacement'))).toBe(true)
    expect(state.queuedSwitches).toEqual([])
    expect(rng.calls).toBe(0)
  })

  it('Emergency Exit: nothing else changes and the gap names EMERGENCY_EXIT', () => {
    const rng = scriptedRng([])
    const state = crossedBattle(1, rng, liveParty(), 40)
    const unmodelled: string[] = []
    scheduleEmergencyExit(state, 1, unmodelled)
    expect(state.queuedSwitches).toHaveLength(1)

    drainQueuedSwitches(state, testDeps(fixedDamage(0)), unmodelled)

    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(40) // unchanged: no switch, no damage
    expect(unmodelled.some((u) => u.includes('EMERGENCY_EXIT') && u.includes('no deps.replacement'))).toBe(true)
    expect(state.queuedSwitches).toEqual([])
    expect(rng.calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Chooser returns an unusable slot: no switch, a note, no crash.
// ---------------------------------------------------------------------------

describe('cycle 160d - unusable replacement choice', () => {
  it('chooser returns the current partyIndex: no switch and a note', () => {
    const rng = scriptedRng([])
    const state = crossedBattle(1, rng, liveParty(), 40)
    const unmodelled: string[] = []
    scheduleEmergencyExit(state, 1, unmodelled)

    drainQueuedSwitches(state, testDeps(fixedDamage(0), { chooseReplacement: () => 0 }), unmodelled)

    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(unmodelled.some((u) => u.includes('EMERGENCY_EXIT replacement choice 0') && u.includes('not a usable party slot'))).toBe(true)
    expect(state.queuedSwitches).toEqual([])
  })

  it('chooser returns a fainted slot: no switch and a note', () => {
    const rng = scriptedRng([])
    const party = liveParty()
    party[2]!.hp = 0 // fainted reserve
    const state = crossedBattle(1, rng, party, 40)
    const unmodelled: string[] = []
    scheduleEmergencyExit(state, 1, unmodelled)

    drainQueuedSwitches(state, testDeps(fixedDamage(0), { chooseReplacement: () => 2 }), unmodelled)

    expect(state.battlers[1]!.partyIndex).toBe(0)
    expect(unmodelled.some((u) => u.includes('EMERGENCY_EXIT replacement choice 2') && u.includes('not a usable party slot'))).toBe(true)
    expect(state.queuedSwitches).toEqual([])
  })
})
