/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 98b: gQueuedSwitchData / TryScheduleSwitch and its drain (battle_util.c:369-376,
// 771-816, 378-412), used by the two onDefender abilities that force the ATTACKER to switch:
// Chuckster (abilities.cc:10438-10463) and Restraining Order (:8579-8597). The switch itself is
// the existing forceRandomSwitch (moveEffects.ts), whose Random() % 6 pick loop is
// Cmd_forcerandomswitch (battle_script_commands.c:10156-10182).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { MoveBehaviors } from '../basePower'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { drainQueuedSwitches, executeTurn } from './turn'
import { dispatchMoveEndDefenderAbilities } from './moveEnd'
import { tryScheduleSwitch } from './moveEffects'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import { BATTLE_TYPE_TRAINER } from './constants'

// ---------------------------------------------------------------------------
// Fixtures -- the snapshot-backed shape cycle96Abilities.test.ts uses.
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

function partyMon(speciesId: string | null, hp: number, abilities: SimPartyMon['abilities'] = { ability: null, innates: [null, null, null] }): SimPartyMon {
  return {
    speciesId,
    hp,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    itemId: null,
    abilities,
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
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
  status2?: number
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
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: { atk: s.atk ?? 100, def: s.def ?? 90, spatk: s.spatk ?? 80, spdef: s.spdef ?? 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          level: s.level ?? 50,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          status2: s.status2 ?? 0,
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
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

const CHUCKSTER = 'ABILITY_CHUCKSTER'
const RESTRAINING_ORDER = 'ABILITY_RESTRAINING_ORDER'

/** Three live party mons -- the reserve a forced switch needs. */
const liveParty = (): SimPartyMon[] => [partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100), partyMon('SPECIES_MUDKIP', 100)]

/** One turn: battler 0 uses `moveId` on battler 1; battler 1 does nothing. */
function turn(state: BattleState, moveId: string, damage = 20): ReturnType<typeof executeTurn> {
  return executeTurn(state, [useMove(1, move(moveId)), null], testDeps(fixedDamage(damage)))
}

/** The move-end defender dispatch alone (no queue drain), for states a real turn would not reach. */
function dispatchDefender(state: BattleState, moveId: string, targetDamage = 20) {
  const unmodelled: string[] = []
  const res = dispatchMoveEndDefenderAbilities({
    state,
    attackerId: 0,
    targetId: 1,
    moveId,
    moveData: move(moveId),
    targetDamage,
    hpDealt: targetDamage,
    deps: testDeps(fixedDamage(targetDamage)),
    unmodelled,
    fainted: [],
  })
  return { res, unmodelled }
}

// ---------------------------------------------------------------------------
// Chuckster (src/abilities.cc:10438-10463)
// ---------------------------------------------------------------------------

describe('Cycle 98b - Chuckster forces the contact attacker out (abilities.cc:10438-10463)', () => {
  it('sets its state at hook time and switches the attacker: pick 0 is the current slot, pick 1 lands', () => {
    // Cmd_forcerandomswitch's loop (battle_script_commands.c:10176-10180):
    // do { i = Random() % 6; } while (i == current || empty/fainted).
    // Battler 0 starts on party slot 0, so 0 % 6 == 0 is rejected and 1 % 6 == 1 is taken.
    const party = liveParty()
    const rng = scriptedRng([0 /* accuracy */, 0 /* pick, rejected */, 1 /* pick, accepted */])
    const state = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility(CHUCKSTER) }], rng, {
      playerParty: party,
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })

    turn(state, 'MOVE_TACKLE')

    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1)
    expect(state.queuedSwitches).toEqual([])

    // Delta, not total: the same hit with no Chuckster draws only its accuracy roll.
    const baselineRng = scriptedRng([])
    const baseline = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, {}], baselineRng, {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    turn(baseline, 'MOVE_TACKLE')
    expect(baselineRng.calls).toBe(1)
    expect(rng.calls - baselineRng.calls).toBe(2)
  })

  it('does not fire on a non-contact move (Water Gun family; Hyper Voice here)', () => {
    const rng = scriptedRng([])
    const state = battle([{ moves: slot('MOVE_HYPER_VOICE'), pp: pps }, { abilities: hasAbility(CHUCKSTER) }], rng, {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    turn(state, 'MOVE_HYPER_VOICE')
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expect(state.queuedSwitches).toEqual([])
  })

  it('does not fire on a miss (DidMoveHit false): Megahorn, roll 99 >= 85 accuracy', () => {
    const rng = scriptedRng([99])
    const state = battle([{ moves: slot('MOVE_MEGAHORN'), pp: pps }, { abilities: hasAbility(CHUCKSTER) }], rng, {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    const out = turn(state, 'MOVE_MEGAHORN')
    expect(out.actions[0]!.missed).toBe(true)
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
    expect(state.queuedSwitches).toEqual([])
  })

  it('does not fire a second time: the hook state is already set on the next contact hit', () => {
    const rng = scriptedRng([0, 0, 1]) // accuracy, rejected pick, accepted pick
    const state = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility(CHUCKSTER) }], rng, {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    turn(state, 'MOVE_TACKLE')
    expect(state.battlers[0]!.partyIndex).toBe(1)

    const secondRng = scriptedRng([])
    state.rng = secondRng
    const out = turn(state, 'MOVE_TACKLE')
    expect(out.actions[0]!.missed).toBe(false)
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.queuedSwitches).toEqual([])
    expect(secondRng.calls).toBe(1) // accuracy only; no pick loop
  })

  it('sets its state but cannot switch when the attacker is the only live mon (CanBattlerSwitch false, :812)', () => {
    const rng = scriptedRng([])
    const state = battle([{ moves: slot('MOVE_TACKLE'), pp: pps }, { abilities: hasAbility(CHUCKSTER) }], rng, {
      playerParty: [partyMon('SPECIES_MUDKIP', 100)],
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    turn(state, 'MOVE_TACKLE')
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1) // hook spent it anyway
    expect(rng.calls).toBe(1) // no pick draw
  })

  it('is blocked by the attacker\'s Suction Cups, but the hook still spends its state', () => {
    const rng = scriptedRng([])
    const state = battle(
      [{ moves: slot('MOVE_TACKLE'), pp: pps, abilities: hasAbility('ABILITY_SUCTION_CUPS') }, { abilities: hasAbility(CHUCKSTER) }],
      rng,
      { playerParty: liveParty(), battleTypeFlags: BATTLE_TYPE_TRAINER },
    )
    turn(state, 'MOVE_TACKLE')
    expect(state.battlers[0]!.partyIndex).toBe(0)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1)
    expect(rng.calls).toBe(1) // forceRandomSwitch returns BLOCKED before the pick loop
  })
})

// ---------------------------------------------------------------------------
// Restraining Order (src/abilities.cc:8579-8597)
// ---------------------------------------------------------------------------

describe('Cycle 98b - Restraining Order forces the attacker out without a contact check (abilities.cc:8579-8597)', () => {
  it('fires on a non-contact hit; the DRAIN sets the state, not the hook', () => {
    const party = liveParty()
    const rng = scriptedRng([0 /* accuracy */, 0 /* rejected pick */, 1 /* accepted pick */])
    const state = battle([{ moves: slot('MOVE_HYPER_VOICE'), pp: pps }, { abilities: hasAbility(RESTRAINING_ORDER) }], rng, {
      playerParty: party,
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })

    // The hook alone schedules, and leaves the ability armed.
    const queued = battle([{ moves: slot('MOVE_HYPER_VOICE'), pp: pps }, { abilities: hasAbility(RESTRAINING_ORDER) }], scriptedRng([]), {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    dispatchDefender(queued, 'MOVE_HYPER_VOICE')
    expect(queued.queuedSwitches).toHaveLength(1)
    expect(queued.battlers[1]!.volatiles.abilityState[0]).toBe(0)

    turn(state, 'MOVE_HYPER_VOICE')
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(1) // set by the drain
    expect(state.queuedSwitches).toEqual([])

    const baselineRng = scriptedRng([])
    const baseline = battle([{ moves: slot('MOVE_HYPER_VOICE'), pp: pps }, {}], baselineRng, {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    turn(baseline, 'MOVE_HYPER_VOICE')
    expect(baselineRng.calls).toBe(1)
    expect(rng.calls - baselineRng.calls).toBe(2)
  })

  it('does not schedule outside a trainer battle (CanBattlerBeForceSwitched, abilities.cc:2608-2616)', () => {
    const state = battle([{ moves: slot('MOVE_HYPER_VOICE'), pp: pps }, { abilities: hasAbility(RESTRAINING_ORDER) }], scriptedRng([]), {
      playerParty: liveParty(),
      battleTypeFlags: 0,
    })
    dispatchDefender(state, 'MOVE_HYPER_VOICE')
    expect(state.queuedSwitches).toEqual([])
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
  })

  it('does not schedule when the attacker fainted to the hit (ShouldApplyOnHitEffect)', () => {
    const state = battle([{ hp: 0, moves: slot('MOVE_HYPER_VOICE'), pp: pps }, { abilities: hasAbility(RESTRAINING_ORDER) }], scriptedRng([]), {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    dispatchDefender(state, 'MOVE_HYPER_VOICE')
    expect(state.queuedSwitches).toEqual([])
    expect(state.battlers[1]!.volatiles.abilityState[0]).toBe(0)
  })

  it('does not fire a second time: the drain set the state on the first hit', () => {
    const rng = scriptedRng([0, 0, 1])
    const state = battle([{ moves: slot('MOVE_HYPER_VOICE'), pp: pps }, { abilities: hasAbility(RESTRAINING_ORDER) }], rng, {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    turn(state, 'MOVE_HYPER_VOICE')
    expect(state.battlers[0]!.partyIndex).toBe(1)
    const secondRng = scriptedRng([])
    state.rng = secondRng
    turn(state, 'MOVE_HYPER_VOICE')
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.queuedSwitches).toEqual([])
    expect(secondRng.calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Queue mechanics (battle_util.c:369-376, 787-816)
// ---------------------------------------------------------------------------

describe('Cycle 98b - queued switch mechanics', () => {
  it('tryScheduleSwitch refuses a second entry for the same switchingBattler (:369-376)', () => {
    const state = battle([{}, {}], scriptedRng([]))
    const entry = { ability: CHUCKSTER, setAbilityState: false, switchingBattler: 0, sourceBattler: 1 }
    expect(tryScheduleSwitch(state, entry)).toBe(true)
    expect(tryScheduleSwitch(state, { ...entry })).toBe(false)
    expect(state.queuedSwitches).toEqual([entry])
  })

  it('drains LIFO (:788): the last scheduled switch lands first', () => {
    const partyA = liveParty()
    const partyB = liveParty()
    const rng = scriptedRng([1, 2])
    const state = battle([{}, {}], rng, {
      playerParty: partyA,
      opponentParty: partyB,
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    state.battlers[0]!.mon.abilities = hasAbility(RESTRAINING_ORDER)
    state.battlers[1]!.mon.abilities = hasAbility(CHUCKSTER)

    // Pushed first, drained second: battler 1 switches to its second pick (2).
    expect(tryScheduleSwitch(state, { ability: CHUCKSTER, setAbilityState: false, switchingBattler: 1, sourceBattler: 1 })).toBe(true)
    // Pushed second, drained first: battler 0 takes the first pick (1).
    expect(tryScheduleSwitch(state, { ability: RESTRAINING_ORDER, setAbilityState: false, switchingBattler: 0, sourceBattler: 0 })).toBe(true)

    drainQueuedSwitches(state, testDeps(), [])

    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[1]!.partyIndex).toBe(2)
    expect(state.queuedSwitches).toEqual([])
  })

  it('draw order: accuracy, the move\'s secondary roll, then the pick loop in the drain', () => {
    // Body Slam (EFFECT_PARALYZE_HIT, 30%): roll 99 fails the secondary, so no status.
    const rng = scriptedRng([0 /* accuracy */, 99 /* secondary */, 0 /* rejected pick */, 1 /* accepted pick */])
    const state = battle([{ moves: slot('MOVE_BODY_SLAM'), pp: pps }, { abilities: hasAbility(CHUCKSTER) }], rng, {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    turn(state, 'MOVE_BODY_SLAM')
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(rng.calls).toBe(4)

    // Baseline: the same move with no Chuckster draws only accuracy + secondary.
    const baselineRng = scriptedRng([])
    const baseline = battle([{ moves: slot('MOVE_BODY_SLAM'), pp: pps }, {}], baselineRng, {
      playerParty: liveParty(),
      battleTypeFlags: BATTLE_TYPE_TRAINER,
    })
    turn(baseline, 'MOVE_BODY_SLAM')
    expect(baselineRng.calls).toBe(2)
    expect(rng.calls - baselineRng.calls).toBe(2)
  })
})
