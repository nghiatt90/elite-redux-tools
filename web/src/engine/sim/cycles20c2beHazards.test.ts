/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle s20c2be: Mycelium Might bypass in the switch-in hazards follows the hit marker.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import {
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_TOXIC_SPIKES,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_NONE,
  STATUS1_POISON,
} from './constants'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

function requireMove(id: string): SimMoveData {
  const m = movesById.get(id)
  if (!m) throw new Error(`moves.json has no ${id}`)
  return {
    id,
    power: m.power as number,
    type: m.type as string | null,
    split: m.split as SimMoveData['split'],
    effect: m.effect as string | null,
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    sheerForceBoost: m.sheerForceBoost as true | undefined,
  }
}

const MYCELIUM_MIGHT = requireAbility('ABILITY_MYCELIUM_MIGHT')
const CORROSION = requireAbility('ABILITY_CORROSION')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]
const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: (id) => itemsById.get(id),
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
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: STATUS1_NONE,
    status2: 0,
    ...overrides,
  }
}

function partyMon(overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    hp: 80,
    maxHp: 80,
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
    status1: STATUS1_NONE,
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

const noAbilities: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

/** Battler 0 (player, low HP, slow by default) and battler 1 (opponent, fast by default). */
function battle(
  playerParty: SimPartyMon[],
  opponentAbility: string | null = null,
  opponentParty: SimPartyMon[] = [partyMon({ hp: 100, maxHp: 100 })],
  playerOverrides: Partial<SimBattleMon> = {},
  opponentOverrides: Partial<SimBattleMon> = {},
): BattleState {
  const spec = (i: number, spe: number, hp: number, abilities: SimBattleMon['abilities'], overrides: Partial<SimBattleMon> = {}) =>
    createBattlerState(i, mon({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe }, hp, maxHp: 100, abilities, ...overrides }), 0)
  return createBattleState({
    battlers: [
      spec(0, 50, 5, noAbilities, playerOverrides),
      spec(1, 200, 100, { ability: opponentAbility, innates: [null, null, null] }, opponentOverrides),
    ],
    // random16() returning 1 passes accuracy checks and chooseRandomSwitchReplacement (1 % 6 = 1)
    rng: { random16: () => 1 } as RandomSource,
    playerParty,
    opponentParty,
  })
}

interface Hazards {
  hotCoals?: boolean
  caltrops?: boolean
  spikes?: number
  toxic?: number
}

function setHazards(state: BattleState, sideIndex: 0 | 1, h: Hazards): void {
  const side = state.sides[sideIndex]
  if (h.hotCoals) side.timers.hotCoals = true
  if (h.caltrops) side.timers.caltrops = true
  if (h.spikes) {
    side.statuses |= SIDE_STATUS_SPIKES
    side.timers.spikesAmount = h.spikes
  }
  if (h.toxic) {
    side.statuses |= SIDE_STATUS_TOXIC_SPIKES
    side.timers.toxicSpikesAmount = h.toxic
  }
}

function moveView(id: string = 'MOVE_TACKLE', overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
  const m = requireMove(id)
  return {
    id,
    priority: m.priority ?? 0,
    effect: m.effect ?? null,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ? m.type.replace(/^TYPE_/, '') : 'NORMAL',
    power: m.power ?? 0,
    flags: m.flags ?? {},
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
    ...overrides,
  }
}

function moveAction(target: number, m: TurnOrderMoveView = moveView()): ChosenAction {
  return { action: 'USE_MOVE', moveToBeUsed: m, chosenMove: m, target }
}

function switchAction(): ChosenAction {
  return { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }
}

function fixedDamage(targetDamage: number): DamageResolver {
  return { resolve: () => ({ targetDamage, attackerDamage: null, unmodelled: [] }) }
}

interface DepsOptions {
  holdEffects?: Record<number, string>
  replacement?: ReplacementDeps
  withTypes?: boolean
  inverseBattle?: boolean
}

function deps(damage: DamageResolver, o: DepsOptions = {}): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const grounding: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => o.holdEffects?.[id] ?? null }
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    replacement: o.replacement,
    hazardTypes: o.withTypes === false ? undefined : { typeChart, inverseTypeChart, inverseBattle: o.inverseBattle ?? false },
  }
}

/** Replacement choices consumed in order. */
function chooser(...indices: number[]): ReplacementDeps & { calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    chooseReplacement(_state, battlerId) {
      calls.push(battlerId)
      return indices[calls.length - 1]!
    },
  }
}

describe('Cycle s20c2be: Mycelium Might bypass in switch-in hazards follows the hit marker', () => {
  it('1. Toxic Spikes, foe has Mycelium Might, voluntary switch to a Steel mon: not poisoned', () => {
    const lead = partyMon({ speciesId: 'SPECIES_MUDKIP', hp: 100 })
    const steelReserve = partyMon({ speciesId: 'SPECIES_ARON', types: ['STEEL', 'ROCK', 'MYSTERY'], hp: 100 })
    const state = battle([lead, steelReserve], MYCELIUM_MIGHT)
    setHazards(state, 0, { toxic: 1 })
    executeTurn(state, [switchAction(), moveAction(0)], deps(fixedDamage(0), { replacement: chooser(1) }))
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_ARON')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
  })

  it('2. Control for 1: a Water mon in the same setup IS poisoned (STATUS1_POISON)', () => {
    const lead = partyMon({ speciesId: 'SPECIES_MUDKIP', hp: 100 })
    const waterReserve = partyMon({ speciesId: 'SPECIES_MUDKIP', types: ['WATER', 'MYSTERY', 'MYSTERY'], hp: 100 })
    const state = battle([lead, waterReserve], MYCELIUM_MIGHT)
    setHazards(state, 0, { toxic: 1 })
    executeTurn(state, [switchAction(), moveAction(0)], deps(fixedDamage(0), { replacement: chooser(1) }))
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_POISON)
  })

  it('3. Toxic Spikes, foe has ABILITY_CORROSION, Steel switch-in: poisoned', () => {
    const lead = partyMon({ speciesId: 'SPECIES_MUDKIP', hp: 100 })
    const steelReserve = partyMon({ speciesId: 'SPECIES_ARON', types: ['STEEL', 'ROCK', 'MYSTERY'], hp: 100 })
    const state = battle([lead, steelReserve], CORROSION)
    setHazards(state, 0, { toxic: 1 })
    executeTurn(state, [switchAction(), moveAction(0)], deps(fixedDamage(0), { replacement: chooser(1) }))
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_ARON')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_POISON)
  })

  it('4. Foe with Mycelium Might uses Dragon Tail and drags a Steel mon onto Toxic Spikes: NOT poisoned', () => {
    const lead = partyMon({ speciesId: 'SPECIES_MUDKIP', hp: 5 })
    const steelReserve = partyMon({ speciesId: 'SPECIES_ARON', types: ['STEEL', 'ROCK', 'MYSTERY'], hp: 100 })
    const state = battle([lead, steelReserve], MYCELIUM_MIGHT)
    setHazards(state, 0, { toxic: 1 })
    // Foe is faster (spe 200 vs 50), uses Dragon Tail, does 1 damage so 5 HP mon survives.
    // Dragon Tail drags slot 1 (Aron) into battler 0 via chooseRandomSwitchReplacement (rng returns 1).
    executeTurn(
      state,
      [moveAction(1), moveAction(0, moveView('MOVE_DRAGON_TAIL'))],
      deps(fixedDamage(1)),
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_ARON')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
  })

  it('5. Foe with Mycelium Might uses Roar and drags a Fire mon onto Hot Coals: burned, timer false', () => {
    const lead = partyMon({ speciesId: 'SPECIES_MUDKIP', hp: 100 })
    const fireReserve = partyMon({ speciesId: 'SPECIES_TORCHIC', types: ['FIRE', 'MYSTERY', 'MYSTERY'], hp: 100 })
    const state = battle([lead, fireReserve], MYCELIUM_MIGHT)
    setHazards(state, 0, { hotCoals: true })
    // Foe uses Roar, dragging Fire mon while myceliumMightMarker is true.
    executeTurn(
      state,
      [moveAction(1), moveAction(0, moveView('MOVE_ROAR'))],
      deps(fixedDamage(0)),
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TORCHIC')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('6. Same as 5 with a foe without the ability: not burned, timer false', () => {
    const lead = partyMon({ speciesId: 'SPECIES_MUDKIP', hp: 100 })
    const fireReserve = partyMon({ speciesId: 'SPECIES_TORCHIC', types: ['FIRE', 'MYSTERY', 'MYSTERY'], hp: 100 })
    const state = battle([lead, fireReserve], null)
    setHazards(state, 0, { hotCoals: true })
    executeTurn(
      state,
      [moveAction(1), moveAction(0, moveView('MOVE_ROAR'))],
      deps(fixedDamage(0)),
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TORCHIC')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('7. Our Mycelium Might U-turn into a Fire replacement on Hot Coals: burned', () => {
    const lead = partyMon({
      speciesId: 'SPECIES_MUDKIP',
      hp: 100,
      moves: ['MOVE_U_TURN', null, null, null],
      pp: [20, 0, 0, 0],
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
      abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
    })
    const fireReserve = partyMon({
      speciesId: 'SPECIES_TORCHIC',
      types: ['FIRE', 'MYSTERY', 'MYSTERY'],
      hp: 100,
      abilities: noAbilities,
    })
    const state = battle(
      [lead, fireReserve],
      null,
      [partyMon({ hp: 100, maxHp: 100 })],
      {
        speciesId: 'SPECIES_MUDKIP',
        hp: 100,
        rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
        moves: ['MOVE_U_TURN', null, null, null],
        pp: [20, 0, 0, 0],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    setHazards(state, 0, { hotCoals: true })
    executeTurn(
      state,
      [moveAction(1, moveView('MOVE_U_TURN')), moveAction(0)],
      deps(fixedDamage(10), { replacement: chooser(1) }),
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TORCHIC')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_BURN)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('8. Same as 7 without the ability on the U-turn user: not burned', () => {
    const lead = partyMon({
      speciesId: 'SPECIES_MUDKIP',
      hp: 100,
      moves: ['MOVE_U_TURN', null, null, null],
      pp: [20, 0, 0, 0],
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
    })
    const fireReserve = partyMon({
      speciesId: 'SPECIES_TORCHIC',
      types: ['FIRE', 'MYSTERY', 'MYSTERY'],
      hp: 100,
      abilities: noAbilities,
    })
    const state = battle(
      [lead, fireReserve],
      null,
      [partyMon({ hp: 100, maxHp: 100 })],
      {
        speciesId: 'SPECIES_MUDKIP',
        hp: 100,
        rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
        moves: ['MOVE_U_TURN', null, null, null],
        pp: [20, 0, 0, 0],
      },
    )
    setHazards(state, 0, { hotCoals: true })
    executeTurn(
      state,
      [moveAction(1, moveView('MOVE_U_TURN')), moveAction(0)],
      deps(fixedDamage(10), { replacement: chooser(1) }),
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TORCHIC')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('9. Our Mycelium Might U-turn into a Rock replacement on Caltrops: STATUS1_BLEED; control without the ability: no bleed', () => {
    // Part A: user with Mycelium Might
    const leadA = partyMon({
      speciesId: 'SPECIES_MUDKIP',
      hp: 100,
      moves: ['MOVE_U_TURN', null, null, null],
      pp: [20, 0, 0, 0],
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
      abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
    })
    const rockReserveA = partyMon({
      speciesId: 'SPECIES_GEODUDE',
      types: ['ROCK', 'GROUND', 'MYSTERY'],
      hp: 100,
      abilities: noAbilities,
    })
    const stateA = battle(
      [leadA, rockReserveA],
      null,
      [partyMon({ hp: 100, maxHp: 100 })],
      {
        speciesId: 'SPECIES_MUDKIP',
        hp: 100,
        rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
        moves: ['MOVE_U_TURN', null, null, null],
        pp: [20, 0, 0, 0],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    setHazards(stateA, 0, { caltrops: true })
    executeTurn(
      stateA,
      [moveAction(1, moveView('MOVE_U_TURN')), moveAction(0)],
      deps(fixedDamage(10), { replacement: chooser(1) }),
    )
    expect(stateA.battlers[0]!.partyIndex).toBe(1)
    expect(stateA.battlers[0]!.mon.speciesId).toBe('SPECIES_GEODUDE')
    expect(stateA.battlers[0]!.mon.status1).toBe(STATUS1_BLEED)
    expect(stateA.sides[0].timers.caltrops).toBe(false)

    // Part B: control without the ability
    const leadB = partyMon({
      speciesId: 'SPECIES_MUDKIP',
      hp: 100,
      moves: ['MOVE_U_TURN', null, null, null],
      pp: [20, 0, 0, 0],
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
    })
    const rockReserveB = partyMon({
      speciesId: 'SPECIES_GEODUDE',
      types: ['ROCK', 'GROUND', 'MYSTERY'],
      hp: 100,
      abilities: noAbilities,
    })
    const stateB = battle(
      [leadB, rockReserveB],
      null,
      [partyMon({ hp: 100, maxHp: 100 })],
      {
        speciesId: 'SPECIES_MUDKIP',
        hp: 100,
        rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
        moves: ['MOVE_U_TURN', null, null, null],
        pp: [20, 0, 0, 0],
      },
    )
    setHazards(stateB, 0, { caltrops: true })
    executeTurn(
      stateB,
      [moveAction(1, moveView('MOVE_U_TURN')), moveAction(0)],
      deps(fixedDamage(10), { replacement: chooser(1) }),
    )
    expect(stateB.battlers[0]!.partyIndex).toBe(1)
    expect(stateB.battlers[0]!.mon.speciesId).toBe('SPECIES_GEODUDE')
    expect(stateB.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    expect(stateB.sides[0].timers.caltrops).toBe(false)
  })

  it('10. End-of-turn replacement: foe with Mycelium Might KOs our mon, a Fire replacement enters on Hot Coals: not burned', () => {
    const lead = partyMon({ speciesId: 'SPECIES_MUDKIP', hp: 5 })
    const fireReserve = partyMon({ speciesId: 'SPECIES_TORCHIC', types: ['FIRE', 'MYSTERY', 'MYSTERY'], hp: 100 })
    const state = battle([lead, fireReserve], MYCELIUM_MIGHT)
    setHazards(state, 0, { hotCoals: true })
    // Foe KOs our mon with 999 damage; myceliumMightMarker cleared after action loop (:859) before end-of-turn replacement
    executeTurn(
      state,
      [null, moveAction(0)],
      deps(fixedDamage(999), { replacement: chooser(1) }),
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TORCHIC')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('11. Next turn: after a turn in which the foe with Mycelium Might attacked, a voluntary switch to a Fire mon on Hot Coals: not burned', () => {
    const lead = partyMon({ speciesId: 'SPECIES_MUDKIP', hp: 100 })
    const fireReserve = partyMon({ speciesId: 'SPECIES_TORCHIC', types: ['FIRE', 'MYSTERY', 'MYSTERY'], hp: 100 })
    const state = battle([lead, fireReserve], MYCELIUM_MIGHT, [partyMon({ hp: 100, maxHp: 100 })], { hp: 100 })
    // Turn 1: Foe attacks with Mycelium Might; both survive; turn cleans up flags
    executeTurn(state, [moveAction(1), moveAction(0)], deps(fixedDamage(10)))

    // Now set Hot Coals before turn 2
    setHazards(state, 0, { hotCoals: true })

    // Turn 2: Voluntary switch into Fire mon on Hot Coals
    executeTurn(state, [switchAction(), moveAction(0)], deps(fixedDamage(0), { replacement: chooser(1) }))
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TORCHIC')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('12. Same turn: the faster foe with Mycelium Might attacks first, then our non-Mycelium U-turn brings a Fire mon onto Hot Coals: not burned', () => {
    const lead = partyMon({
      speciesId: 'SPECIES_MUDKIP',
      hp: 100,
      moves: ['MOVE_U_TURN', null, null, null],
      pp: [20, 0, 0, 0],
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 50 },
    })
    const fireReserve = partyMon({
      speciesId: 'SPECIES_TORCHIC',
      types: ['FIRE', 'MYSTERY', 'MYSTERY'],
      hp: 100,
      abilities: noAbilities,
    })
    const state = battle(
      [lead, fireReserve],
      MYCELIUM_MIGHT, // foe has Mycelium Might and spe 200 (faster)
      [partyMon({ hp: 100, maxHp: 100 })],
      {
        speciesId: 'SPECIES_MUDKIP',
        hp: 100,
        rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 50 },
        moves: ['MOVE_U_TURN', null, null, null],
        pp: [20, 0, 0, 0],
      },
    )
    setHazards(state, 0, { hotCoals: true })
    // Foe attacks first (marker set then cleared at end of action).
    // Then player's U-turn executes (non-Mycelium, marker is false).
    // Fire replacement enters Hot Coals while marker is false -> not burned.
    executeTurn(
      state,
      [moveAction(1, moveView('MOVE_U_TURN')), moveAction(0)],
      deps(fixedDamage(10), { replacement: chooser(1) }),
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TORCHIC')
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_NONE)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })

  it('13. A Mycelium Might U-turn into an already-poisoned Fire mon on Hot Coals: status stays poison (STATUS1_ANY test comes first)', () => {
    const lead = partyMon({
      speciesId: 'SPECIES_MUDKIP',
      hp: 100,
      moves: ['MOVE_U_TURN', null, null, null],
      pp: [20, 0, 0, 0],
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
      abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
    })
    const poisonedFireReserve = partyMon({
      speciesId: 'SPECIES_TORCHIC',
      types: ['FIRE', 'MYSTERY', 'MYSTERY'],
      hp: 100,
      status1: STATUS1_POISON,
      abilities: noAbilities,
    })
    const state = battle(
      [lead, poisonedFireReserve],
      null,
      [partyMon({ hp: 100, maxHp: 100 })],
      {
        speciesId: 'SPECIES_MUDKIP',
        hp: 100,
        rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 300 },
        moves: ['MOVE_U_TURN', null, null, null],
        pp: [20, 0, 0, 0],
        abilities: { ability: MYCELIUM_MIGHT, innates: [null, null, null] },
      },
    )
    setHazards(state, 0, { hotCoals: true })
    executeTurn(
      state,
      [moveAction(1, moveView('MOVE_U_TURN')), moveAction(0)],
      deps(fixedDamage(10), { replacement: chooser(1) }),
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_TORCHIC')
    // STATUS1_ANY check prevents burn despite myceliumMightMarker being true
    expect(state.battlers[0]!.mon.status1).toBe(STATUS1_POISON)
    expect(state.sides[0].timers.hotCoals).toBe(false)
  })
})
