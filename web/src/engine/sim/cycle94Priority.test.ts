import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import {
  NEUTRAL_TURN_ORDER_CONTEXT,
  getMovePriority,
  getMoveSpeed,
  getWhoStrikesFirst,
  resolveTurnOrderAssumingNoMidTurnChanges,
} from './turnOrder'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'

const RATIOS: [number, number][] = [
  [2, 8],
  [2, 7],
  [2, 6],
  [2, 5],
  [2, 4],
  [2, 3],
  [1, 1],
  [3, 2],
  [4, 2],
  [5, 2],
  [6, 2],
  [7, 2],
  [8, 2],
]

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
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(speeds: number[], rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({
    battlers: speeds.map((spe, i) => createBattlerState(i, mon({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe } }), 0)),
    rng,
  })
}

function move(overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
  // Default: MOVE_TACKLE from data/v2.65beta/moves.json
  // (priority: 0, effect: null, power: 40, split: PHYSICAL, type: TYPE_NORMAL).
  return {
    id: 'MOVE_TACKLE',
    priority: 0,
    effect: null,
    isStatus: false,
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
    resolvedType: 'NORMAL',
    power: 40,
    flags: { contact: true, mirrorMoveAffected: true },
    split: 'PHYSICAL',
    ...overrides,
  }
}

function moveAction(m: TurnOrderMoveView = move(), target: number | null = null): ChosenAction {
  return { action: 'USE_MOVE', moveToBeUsed: m, chosenMove: m, target }
}

function withAbility(state: BattleState, battlerId: number, abilityId: string, innates: [string | null, string | null, string | null] = [null, null, null]): void {
  state.battlers[battlerId]!.mon.abilities = { ability: abilityId, innates }
}

// Move snapshots from data/v2.65beta/moves.json:
const RECOVER = move({
  id: 'MOVE_RECOVER',
  priority: 0,
  effect: 'EFFECT_RESTORE_HP',
  isStatus: true,
  resolvedType: 'NORMAL',
  power: 0,
  flags: { snatchAffected: true },
  split: 'STATUS',
})

const GIGA_DRAIN = move({
  id: 'MOVE_GIGA_DRAIN',
  priority: 0,
  effect: 'EFFECT_ABSORB',
  isStatus: false,
  resolvedType: 'GRASS',
  power: 75,
  flags: { contact: true, mirrorMoveAffected: true },
  split: 'SPECIAL',
})

const ROOST = move({
  id: 'MOVE_ROOST',
  priority: 0,
  effect: 'EFFECT_ROOST',
  isStatus: true,
  resolvedType: 'FLYING',
  power: 0,
  flags: { snatchAffected: true },
  split: 'STATUS',
})

const SWORDS_DANCE = move({
  id: 'MOVE_SWORDS_DANCE',
  priority: 0,
  effect: 'EFFECT_ATTACK_UP_2',
  isStatus: true,
  resolvedType: 'NORMAL',
  power: 0,
  flags: { dance: true, snatchAffected: true },
  split: 'STATUS',
})

const SHADOW_BALL = move({
  id: 'MOVE_SHADOW_BALL',
  priority: 0,
  effect: 'EFFECT_SPECIAL_DEFENSE_DOWN_HIT',
  isStatus: false,
  resolvedType: 'GHOST',
  power: 90,
  flags: { ballistic: true, mirrorMoveAffected: true },
  split: 'SPECIAL',
})

const THUNDER_PUNCH = move({
  id: 'MOVE_THUNDER_PUNCH',
  priority: 0,
  effect: 'EFFECT_PARALYZE_HIT',
  isStatus: false,
  resolvedType: 'ELECTRIC',
  power: 85,
  flags: { contact: true, mirrorMoveAffected: true, punchBased: true },
  split: 'PHYSICAL',
})

const ROAR_OF_TIME = move({
  id: 'MOVE_ROAR_OF_TIME',
  priority: -6,
  effect: 'EFFECT_HIT_SWITCH_TARGET',
  isStatus: false,
  resolvedType: 'DRAGON',
  power: 90,
  flags: { mirrorMoveAffected: true, sound: true },
  split: 'SPECIAL',
})

describe('Cycle 94 priority abilities: Early Grave and Triage', () => {
  it('Early Grave (src/abilities.cc:6651): +1 priority on Ghost moves at full HP only', () => {
    const state = battle([100, 100])
    withAbility(state, 0, 'ABILITY_EARLY_GRAVE')

    // Ghost move at full HP (100/100) -> +1
    expect(getMovePriority(state, 0, SHADOW_BALL, 1)).toBe(1)

    // Normal move at full HP -> 0
    expect(getMovePriority(state, 0, move(), 1)).toBe(0)

    // Ghost move at 99/100 HP -> 0
    state.battlers[0]!.mon.hp = 99
    expect(getMovePriority(state, 0, SHADOW_BALL, 1)).toBe(0)
  })

  it('Triage (src/abilities.cc:2803-2807): +3 priority on IsHealingMoveEffect moves, 0 otherwise', () => {
    const state = battle([100, 100])
    withAbility(state, 0, 'ABILITY_TRIAGE')

    // Recover (EFFECT_RESTORE_HP, base priority 0) -> 3
    expect(getMovePriority(state, 0, RECOVER, 0)).toBe(3)

    // Giga Drain (EFFECT_ABSORB, damaging special move, base priority 0) -> 3
    expect(getMovePriority(state, 0, GIGA_DRAIN, 1)).toBe(3)

    // Roost (EFFECT_ROOST, base priority 0) -> 3
    expect(getMovePriority(state, 0, ROOST, 0)).toBe(3)

    // Non-healing status move (Swords Dance, EFFECT_ATTACK_UP_2) -> 0
    expect(getMovePriority(state, 0, SWORDS_DANCE, 0)).toBe(0)

    // Move with effect: null (Tackle) -> 0
    expect(getMovePriority(state, 0, move(), 1)).toBe(0)
  })

  it('Triage stacks with Prankster when both are held on a status healing move', () => {
    const state = battle([100, 100])
    withAbility(state, 0, 'ABILITY_PRANKSTER', ['ABILITY_TRIAGE', null, null])

    // Status heal (Recover): Prankster (+1) + Triage (+3) = +4
    expect(getMovePriority(state, 0, RECOVER, 0)).toBe(4)

    // Damaging heal (Giga Drain): only Triage (+3) applies
    expect(getMovePriority(state, 0, GIGA_DRAIN, 1)).toBe(3)
  })

  it('orders a slower Triage holder using Recover ahead of a faster battler using Tackle', () => {
    // Battler 0 has speed 50 and Triage; Battler 1 has speed 200 and no ability.
    const state = battle([50, 200])
    withAbility(state, 0, 'ABILITY_TRIAGE')
    const actions: (ChosenAction | null)[] = [moveAction(RECOVER, 0), moveAction(move(), 0)]

    const speed0 = getMoveSpeed(state, 0, actions[0], false, NEUTRAL_TURN_ORDER_CONTEXT, RATIOS)
    const speed1 = getMoveSpeed(state, 1, actions[1], false, NEUTRAL_TURN_ORDER_CONTEXT, RATIOS)

    // Packed priority field is 7 + movePriority: 7 + 3 = 10 for Triage Recover vs 7 for Tackle.
    expect(speed0.priority).toBe(10)
    expect(speed1.priority).toBe(7)
    expect(getWhoStrikesFirst(state, 0, 1, actions, false, NEUTRAL_TURN_ORDER_CONTEXT, RATIOS)).toBe(0)

    const order = resolveTurnOrderAssumingNoMidTurnChanges(state, actions, NEUTRAL_TURN_ORDER_CONTEXT, RATIOS)
    expect(order.battlerByTurnOrder).toEqual([0, 1])
  })
})

describe('Cycle 94 verification pins for already-ported onPriority abilities via getMovePriority', () => {
  it.each([
    ['ABILITY_GALE_WINGS', 'FLYING'],
    ['ABILITY_WATER_GALE_WINGS', 'WATER'],
    ['ABILITY_FLAMING_SOUL', 'FIRE'],
    ['ABILITY_VOLT_RUSH', 'ELECTRIC'],
  ])('%s (GALE_WINGS_CLONE) gives +1 on %s move at full HP and 0 otherwise', (abilityId, type) => {
    const state = battle([100, 100])
    withAbility(state, 0, abilityId)

    // Matching type at full HP -> +1
    expect(getMovePriority(state, 0, move({ resolvedType: type }), 1)).toBe(1)

    // Non-matching type at full HP -> 0
    expect(getMovePriority(state, 0, move({ resolvedType: 'GROUND' }), 1)).toBe(0)

    // Matching type below full HP -> 0
    state.battlers[0]!.mon.hp = 99
    expect(getMovePriority(state, 0, move({ resolvedType: type }), 1)).toBe(0)
  })

  it('Prankster (src/abilities.cc:2244): +1 on status move, 0 on damaging move', () => {
    const state = battle([100, 100])
    withAbility(state, 0, 'ABILITY_PRANKSTER')

    expect(getMovePriority(state, 0, SWORDS_DANCE, 0)).toBe(1)
    expect(getMovePriority(state, 0, move(), 1)).toBe(0)
  })

  it('Blitz Boxer (src/abilities.cc:3725): +1 on punch move at full HP, 0 when damaged or non-punch', () => {
    const state = battle([100, 100])
    withAbility(state, 0, 'ABILITY_BLITZ_BOXER')

    expect(getMovePriority(state, 0, THUNDER_PUNCH, 1)).toBe(1)
    expect(getMovePriority(state, 0, move(), 1)).toBe(0)

    state.battlers[0]!.mon.hp = 99
    expect(getMovePriority(state, 0, THUNDER_PUNCH, 1)).toBe(0)
  })

  it('Opportunist (src/abilities.cc:4665): +1 when target HP <= maxHP / 2 (integer division), 0 otherwise', () => {
    const state = battle([100, 100])
    withAbility(state, 0, 'ABILITY_OPPORTUNIST')

    state.battlers[1]!.mon.maxHp = 100
    state.battlers[1]!.mon.hp = 50
    expect(getMovePriority(state, 0, move(), 1)).toBe(1)

    state.battlers[1]!.mon.hp = 51
    expect(getMovePriority(state, 0, move(), 1)).toBe(0)

    // Odd maxHP: 101 / 2 == 50 in C integer division
    state.battlers[1]!.mon.maxHp = 101
    state.battlers[1]!.mon.hp = 50
    expect(getMovePriority(state, 0, move(), 1)).toBe(1)

    state.battlers[1]!.mon.hp = 51
    expect(getMovePriority(state, 0, move(), 1)).toBe(0)
  })

  it('Perfectionist (src/abilities.cc:3833): +1 when 0 < power <= 25, 0 at 26 or 0', () => {
    const state = battle([100, 100])
    withAbility(state, 0, 'ABILITY_PERFECTIONIST')

    expect(getMovePriority(state, 0, move({ power: 25 }), 1)).toBe(1)
    expect(getMovePriority(state, 0, move({ power: 26 }), 1)).toBe(0)
    expect(getMovePriority(state, 0, SWORDS_DANCE, 0)).toBe(0)
  })

  it('Temporal Rupture (src/abilities.cc:10043): negates Roar of Time priority (-6 -> 0), 0 on other moves', () => {
    const state = battle([100, 100])

    // Without Temporal Rupture, Roar of Time has priority -6.
    expect(getMovePriority(state, 0, ROAR_OF_TIME, 1)).toBe(-6)

    // With Temporal Rupture, bonus is -(-6) = +6, so total priority is 0.
    withAbility(state, 0, 'ABILITY_TEMPORAL_RUPTURE')
    expect(getMovePriority(state, 0, ROAR_OF_TIME, 1)).toBe(0)
    expect(getMovePriority(state, 0, move(), 1)).toBe(0)
  })
})
