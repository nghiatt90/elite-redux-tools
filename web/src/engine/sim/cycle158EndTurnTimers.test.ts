/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 158: ENDTURN_GENERIC_BATTLER_TIMERS and ENDTURN_COILED_UP.
//
// C sources, quoted in full in the brief:
// - ENDTURN_GENERIC_BATTLER_TIMERS (pipeline/.upstream/eliteredux-source/src/battle_util.c:2960-2979):
//   fear cleared when !started.fear, the five one-turn volatiles (rapidResponse,
//   readiedAction, showdownMode, violentRush, onTheProwl) cleared when not started
//   this turn, and dazed/trepidation/drenched decremented (when not started this
//   turn) in that order. `started` is zeroed at the start of each turn
//   (battle_main.c:4589-4591), so a flag set during the turn's actions survives
//   this end-of-turn and is cleared at the NEXT one.
// - ENDTURN_COILED_UP (battle_util.c:2818-2829): when COILED is set and the last
//   move was a Strong Jaw (biteBased) move and Sidewinder's ability state is 0,
//   COILED clears; otherwise Sidewinder's state is reset to 0. CUTTHROAT clears
//   when the last move is a Keen Edge (sliceBased) move.
import { describe, expect, it } from 'vitest'

import { STATUS4_COILED, STATUS4_CUTTHROAT, hasFlag } from './constants'
import { createBattleState, createBattlerState } from './create'
import { loadSimData } from './driver/loadSimData'
import { getAbilityStateOf, runEndTurnEffects, setAbilityStateOf } from './endTurn'
import { executeTurn } from './turn'
import type { DamageResolver, TurnLoopDeps } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import type { BattleState, SimBattleMon, SimPartyMon } from './state'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const GROUNDING = simData.grounding
const RATIOS = simData.statStageRatios

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function partyMon(speciesId: string, overrides: Partial<SimPartyMon> = {}): SimPartyMon {
  return {
    speciesId,
    hp: 100,
    maxHp: 100,
    level: 50,
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    itemId: null,
    abilities: noAbility,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    gender: 'MALE',
    status1: 0,
    types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
    ...overrides,
  }
}

const DUMMY_DAMAGE: DamageResolver = { resolve: () => ({ targetDamage: 0, attackerDamage: null, unmodelled: [] }) }

const LOOP_DEPS: TurnLoopDeps = {
  turnOrder: simData.turnOrder,
  grounding: GROUNDING,
  damage: DUMMY_DAMAGE,
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  moveBehaviors: simData.moveBehaviors,
  hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
}

function battle(mon: Partial<SimBattleMon> = {}, party?: SimPartyMon[]): BattleState {
  return createBattleState({
    battlers: [
      createBattlerState(0, monFor('SPECIES_MUDKIP', mon), 0),
      createBattlerState(1, monFor('SPECIES_MUDKIP'), 0),
    ],
    rng: { random16: () => 0 },
    ...(party ? { playerParty: party } : {}),
  })
}

/** One end-of-turn ladder pass over battler 0 only. */
function endTurn(state: BattleState) {
  return runEndTurnEffects(state, [0], DATA_CONTEXT, { grounding: GROUNDING })
}

function viewOf(moveId: string): TurnOrderMoveView {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  return {
    id: moveId,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
}

function useMove(target: number, moveId: string): ChosenAction {
  const view = viewOf(moveId)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

const switchAction: ChosenAction = { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }

describe('Cycle 158 - one-turn volatiles (ENDTURN_GENERIC_BATTLER_TIMERS, battle_util.c:2960-2979)', () => {
  const ONE_TURN_FLAGS = ['rapidResponse', 'readiedAction', 'showdownMode', 'violentRush', 'onTheProwl'] as const

  for (const flag of ONE_TURN_FLAGS) {
    it(`${flag} clears when it was not started this turn and survives when it was`, () => {
      const cleared = battle()
      cleared.battlers[0]!.volatiles[flag] = true
      cleared.battlers[0]!.volatiles.started[flag] = false
      endTurn(cleared)
      expect(cleared.battlers[0]!.volatiles[flag]).toBe(false)

      const kept = battle()
      kept.battlers[0]!.volatiles[flag] = true
      kept.battlers[0]!.volatiles.started[flag] = true
      endTurn(kept)
      expect(kept.battlers[0]!.volatiles[flag]).toBe(true)
    })
  }

  it('dazed = 5 started this turn survives at 5, then 4, 3, 2, 1, 0', () => {
    const state = battle()
    const b = state.battlers[0]!
    b.volatiles.dazed = 5
    b.volatiles.started.dazed = true
    endTurn(state)
    expect(b.volatiles.dazed).toBe(5)

    b.volatiles.started.dazed = false
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      endTurn(state)
      seen.push(b.volatiles.dazed)
    }
    expect(seen).toEqual([4, 3, 2, 1, 0])
    // No underflow at 0.
    endTurn(state)
    expect(b.volatiles.dazed).toBe(0)
  })

  it('drenched 2 decrements to 0 when not started, survives at 2 when started', () => {
    const ticking = battle()
    ticking.battlers[0]!.volatiles.drenched = 2
    ticking.battlers[0]!.volatiles.started.drenched = false
    endTurn(ticking)
    expect(ticking.battlers[0]!.volatiles.drenched).toBe(1)
    endTurn(ticking)
    expect(ticking.battlers[0]!.volatiles.drenched).toBe(0)

    const fresh = battle()
    fresh.battlers[0]!.volatiles.drenched = 2
    fresh.battlers[0]!.volatiles.started.drenched = true
    endTurn(fresh)
    expect(fresh.battlers[0]!.volatiles.drenched).toBe(2)
  })

  it('an entry ability sets violentRush for its entry turn and the next end turn clears it', () => {
    const state = battle(
      {},
      [
        partyMon('SPECIES_MUDKIP'),
        partyMon('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_VIOLENT_RUSH', innates: [null, null, null] } }),
      ],
    )
    state.battlers[0]!.monToSwitchIntoId = 1
    // Turn 1: battler 0 switches in the Violent Rush mon; the entry happens during the
    // turn, so `started.violentRush` is true at this end-of-turn and the flag survives.
    executeTurn(state, [switchAction, useMove(0, 'MOVE_TACKLE')], LOOP_DEPS)
    expect(state.battlers[0]!.mon.speciesId).toBe('SPECIES_MUDKIP')
    expect(state.battlers[0]!.volatiles.violentRush).toBe(true)

    // Turn 2: `started` is zeroed at turn start, so the following end turn clears it
    // (the permanent x1.5 Speed in turnOrder.ts is gone with the flag).
    executeTurn(state, [null, useMove(0, 'MOVE_TACKLE')], LOOP_DEPS)
    expect(state.battlers[0]!.volatiles.violentRush).toBe(false)
  })
})

describe('Cycle 158 - Coiled Up and Cutthroat (ENDTURN_COILED_UP, battle_util.c:2818-2829)', () => {
  const SIDEWINDER: SimBattleMon['abilities'] = { ability: 'ABILITY_SIDEWINDER', innates: [null, null, null] }

  it('a bite last move with Sidewinder state 0 clears COILED', () => {
    const state = battle({ abilities: SIDEWINDER })
    const b = state.battlers[0]!
    b.statuses4 |= STATUS4_COILED
    b.lastMove = 'MOVE_BITE'
    endTurn(state)
    expect(hasFlag(b.statuses4, STATUS4_COILED)).toBe(false)
  })

  it('a non-bite last move keeps COILED and spends Sidewinder state', () => {
    const state = battle({ abilities: SIDEWINDER })
    const b = state.battlers[0]!
    b.statuses4 |= STATUS4_COILED
    b.lastMove = 'MOVE_TACKLE'
    setAbilityStateOf(b, 'ABILITY_SIDEWINDER', 1)
    endTurn(state)
    expect(hasFlag(b.statuses4, STATUS4_COILED)).toBe(true)
    expect(getAbilityStateOf(b, 'ABILITY_SIDEWINDER')).toBe(0)
  })

  it('Sidewinder state 1 shields COILED for exactly one end turn', () => {
    const state = battle({ abilities: SIDEWINDER })
    const b = state.battlers[0]!
    b.statuses4 |= STATUS4_COILED
    b.lastMove = 'MOVE_BITE'
    setAbilityStateOf(b, 'ABILITY_SIDEWINDER', 1)
    endTurn(state)
    expect(hasFlag(b.statuses4, STATUS4_COILED)).toBe(true)
    expect(getAbilityStateOf(b, 'ABILITY_SIDEWINDER')).toBe(0)
    endTurn(state)
    expect(hasFlag(b.statuses4, STATUS4_COILED)).toBe(false)
  })

  it('COILED not set still resets Sidewinder state to 0', () => {
    const state = battle({ abilities: SIDEWINDER })
    const b = state.battlers[0]!
    b.lastMove = 'MOVE_BITE'
    setAbilityStateOf(b, 'ABILITY_SIDEWINDER', 1)
    endTurn(state)
    expect(getAbilityStateOf(b, 'ABILITY_SIDEWINDER')).toBe(0)
  })

  it('a slice last move clears CUTTHROAT; a non-slice move keeps it', () => {
    const slice = battle()
    slice.battlers[0]!.statuses4 |= STATUS4_CUTTHROAT
    slice.battlers[0]!.lastMove = 'MOVE_SLASH'
    endTurn(slice)
    expect(hasFlag(slice.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(false)

    const plain = battle()
    plain.battlers[0]!.statuses4 |= STATUS4_CUTTHROAT
    plain.battlers[0]!.lastMove = 'MOVE_TACKLE'
    endTurn(plain)
    expect(hasFlag(plain.battlers[0]!.statuses4, STATUS4_CUTTHROAT)).toBe(true)
  })

  it('the two removed gap notes are not raised for a battler holding these flags', () => {
    const state = battle({ abilities: SIDEWINDER })
    const b = state.battlers[0]!
    b.volatiles.violentRush = true
    b.volatiles.dazed = 3
    b.volatiles.drenched = 1
    b.statuses4 |= STATUS4_COILED | STATUS4_CUTTHROAT
    b.lastMove = 'MOVE_BITE'
    const { unmodelled } = endTurn(state)
    expect(unmodelled.some((n) => n.includes('ENDTURN_COILED_UP'))).toBe(false)
    expect(unmodelled.some((n) => n.includes('ENDTURN_GENERIC_BATTLER_TIMERS'))).toBe(false)
    // ...and the state actually changed, so the absence is not vacuous.
    expect(b.volatiles.violentRush).toBe(false)
    expect(b.volatiles.dazed).toBe(2)
    expect(hasFlag(b.statuses4, STATUS4_COILED)).toBe(false)
  })
})
