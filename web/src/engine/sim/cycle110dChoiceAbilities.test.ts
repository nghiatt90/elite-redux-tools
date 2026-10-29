/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 110d: the ability half of MOVEEND_CHOICE_MOVE -- Discipline (rampage moves only), Gorilla
// Tactics and Sage Power all write gBattleStruct->choicedMove, Discipline's ENDTURN_SLOW_START
// countdown clears it, and both selection filters (CheckMoveLimitations for the AI, the
// TrySetCantSelectMoveBattleScript block for the player) obey it.
//
// Writer: battle_script_commands.c:4547-4568. Discipline countdown: battle_util.c:2943-2952
// (BattleScript_DisciplineLockEnds, data/battle_scripts_1.s:8119, only prints). AI filter:
// battle_util.c:1654-1655 and :1660-1661. Player filter: battle_util.c:1585-1596.
//
// The turn loop is driven with a fixed-damage resolver so only the accuracy roll is drawn (0 always
// succeeds); the RNG draw order is the same one cycle110bHeldItems.test.ts's header documents.
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { runEndTurnEffects } from './endTurn'
import { createBridgeDamageResolver } from './damageResolver'
import { aiDamageDepsFor, createSession, groundingFor } from './driver/session'
import { buildPlayerParty } from './driver/buildParty'
import { loadSimData } from './driver/loadSimData'
import { legalChoices } from './driver/expectimax'
import { runMoveEndBookkeeping } from './moveEnd'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { computeMoveLimitations } from './ai/aiMoveLimitations'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext
const RATIOS = simData.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }
const only = (ability: string): SimBattleMon['abilities'] => ({ ability, innates: [null, null, null] })

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
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

function countRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
  })
}

function useMove(target: number, moveId: string): ChosenAction {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  const view: TurnOrderMoveView = {
    id: m.id,
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
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(simData, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: simData.typeChart, inverseTypeChart: simData.inverseTypeChart, inverseBattle: false },
  }
}

/** The real damage engine, reading hold effects from the state being fought over. */
function bridgeDamage(state: BattleState): DamageResolver {
  return createBridgeDamageResolver({
    moveData: simData.moveData,
    typeChart: simData.typeChart,
    inverseTypeChart: simData.inverseTypeChart,
    moveBehaviors: simData.moveBehaviors,
    battleConstants: simData.battleConstants,
    random: state.rng,
    grounding: groundingFor(simData, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  })
}

/** Fixed damage: keeps the choicedMove bookkeeping independent of the damage engine. */
const fixedDamage = (dmg: number): DamageResolver => ({
  resolve: () => ({ targetDamage: dmg, attackerDamage: null, unmodelled: [] }),
})

// ---------------------------------------------------------------------------
// 1. Recording -- MOVEEND_CHOICE_MOVE battle_script_commands.c:4547-4568
// ---------------------------------------------------------------------------
describe('cycle 110d - MOVEEND_CHOICE_MOVE ability writers', () => {
  it('Gorilla Tactics records the chosen move (`BATTLER_HAS_ABILITY(atk, GORILLA_TACTICS)`, :4553)', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: only('ABILITY_GORILLA_TACTICS') }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_TACKLE')
  })

  it('Sage Power records the chosen move (`BATTLER_HAS_ABILITY(atk, SAGE_POWER)`, :4554)', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: only('ABILITY_SAGE_POWER') }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_TACKLE')
  })

  it("Discipline does nothing for a non-rampage move (its clause requires EFFECT_RAMPAGE, :4554)", () => {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: only('ABILITY_DISCIPLINE') }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.choicedMove).toBeNull()
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(0)
  })

  it('a battler with none of the abilities and no Choice item never records a lock', () => {
    const state = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.choicedMove).toBeNull()
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Discipline countdown -- writing :4555-4556, expiry battle_util.c:2943-2952
// ---------------------------------------------------------------------------
describe('cycle 110d - Discipline rampage lock countdown', () => {
  function rampageState(overrides: Partial<SimBattleMon> = {}) {
    return battle(
      monFor('SPECIES_MUDKIP', {
        abilities: only('ABILITY_DISCIPLINE'),
        moves: ['MOVE_OUTRAGE', null, null, null],
        pp: [10, 0, 0, 0],
        ...overrides,
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
  }

  it('arms disciplineCounter = 3 with the lock, then ENDTURN_SLOW_START ticks 3 -> 2 -> 1 -> clear', () => {
    const state = rampageState()
    // The writer alone (:4555-4556 runs before any end-of-turn pass).
    runMoveEndBookkeeping({
      state,
      attackerId: 0,
      targetId: 1,
      currentMoveId: 'MOVE_OUTRAGE',
      chosenMoveId: 'MOVE_OUTRAGE',
      deps: loopDeps(state, fixedDamage(0)),
      noEffect: false,
    })
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_OUTRAGE')
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(3)

    const endTurnPass = () => runEndTurnEffects(state, [0, 1], DATA_CONTEXT, { grounding: groundingFor(simData, state) })

    endTurnPass()
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(2)
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_OUTRAGE')

    endTurnPass()
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(1)
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_OUTRAGE')

    endTurnPass()
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(0)
    expect(state.battlers[0]!.choicedMove).toBeNull()
  })

  it('a Choice item blocks the tick (`!HOLD_EFFECT_CHOICE(GetBattlerHoldEffect(b, FALSE))`)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        abilities: only('ABILITY_DISCIPLINE'),
        itemId: 'ITEM_CHOICE_BAND',
        moves: ['MOVE_OUTRAGE', null, null, null],
        pp: [10, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_OUTRAGE'), null], loopDeps(state, fixedDamage(10)))
    // The writer arms 3 (Discipline + rampage); the item guard keeps the same turn's end-of-turn pass from ticking it.
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_OUTRAGE')
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(3)
  })

  it('Gorilla Tactics blocks the tick (`!BATTLER_HAS_ABILITY(b, GORILLA_TACTICS)`)', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', {
        abilities: { ability: 'ABILITY_DISCIPLINE', innates: ['ABILITY_GORILLA_TACTICS', null, null] },
        moves: ['MOVE_OUTRAGE', null, null, null],
        pp: [10, 0, 0, 0],
      }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_OUTRAGE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_OUTRAGE')
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(3)
  })

  it('a Discipline holder with a Choice item still locks a non-rampage move through the item clause', () => {
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: only('ABILITY_DISCIPLINE'), itemId: 'ITEM_CHOICE_BAND' }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, fixedDamage(10)))
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_TACKLE')
    expect(state.battlers[0]!.volatiles.disciplineCounter).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. AI selection filter -- CheckMoveLimitations battle_util.c:1654-1655, :1660-1661
// ---------------------------------------------------------------------------
describe('cycle 110d - CheckMoveLimitations choicedMove filters', () => {
  const MOVES: SimBattleMon['moves'] = ['MOVE_TACKLE', 'MOVE_WATER_GUN', 'MOVE_EMBER', 'MOVE_VINE_WHIP']
  const PP: SimBattleMon['pp'] = [10, 10, 10, 10]

  function limits(abilities: SimBattleMon['abilities'], locked: string | null) {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities, moves: MOVES, pp: PP }), monFor('SPECIES_MUDKIP'), countRng())
    state.battlers[0]!.choicedMove = locked
    return computeMoveLimitations(state, 0, aiDamageDepsFor(simData, state))
  }

  it('Gorilla Tactics / Sage Power: every slot but the locked one is unusable (:1660-1661)', () => {
    for (const ability of ['ABILITY_GORILLA_TACTICS', 'ABILITY_SAGE_POWER']) {
      // Locked into slot 0 (Tackle): the filter sets bits 1, 2 and 3 -> 0b1110.
      expect(limits(only(ability), 'MOVE_TACKLE').mask).toBe(0b1110)
      expect(limits(only(ability), null).mask).toBe(0)
    }
  })

  it('Discipline: every slot but the locked one is unusable (:1654-1655, mold breaker FALSE)', () => {
    expect(limits(only('ABILITY_DISCIPLINE'), 'MOVE_TACKLE').mask).toBe(0b1110)
    expect(limits(only('ABILITY_DISCIPLINE'), null).mask).toBe(0)
  })

  it('the stale "not modelled" notes are gone', () => {
    for (const result of [limits(only('ABILITY_GORILLA_TACTICS'), 'MOVE_TACKLE'), limits(only('ABILITY_DISCIPLINE'), 'MOVE_TACKLE')]) {
      const joined = result.unmodelled.join(' | ')
      expect(joined).not.toContain('Discipline choicedMove lock')
      expect(joined).not.toContain('Gorilla Tactics / Sage Power choicedMove lock')
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Player selection -- TrySetCantSelectMoveBattleScript battle_util.c:1585-1596
// ---------------------------------------------------------------------------
describe('cycle 110d - legalChoices choicedMove filter', () => {
  const sessionWith = (ability: string) => {
    const party = buildPlayerParty(
      [
        { species: 'SPECIES_MUDKIP', level: 50, nature: 'NATURE_HARDY', ability, moves: ['MOVE_TACKLE', 'MOVE_WATER_GUN', null, null] },
        { species: 'SPECIES_MUDKIP', level: 50, nature: 'NATURE_HARDY', ability: 'ABILITY_TORRENT', moves: ['MOVE_EMBER', null, null, null] },
      ],
      50,
      simData,
    )
    return createSession({
      data: simData,
      playerParty: party,
      opponentTrainer: simData.trainersById.get('TRAINER_SAWYER_1')!,
      rng: createRandomSource(1),
    })
  }
  const menu = (session: ReturnType<typeof sessionWith>) =>
    legalChoices(session).map((choice) => (choice.action.action === 'USE_MOVE' ? choice.action.chosenMove?.id ?? null : 'SWITCH'))

  it('a locked Gorilla Tactics holder offers only the locked move plus switches; unlocked offers all', () => {
    const session = sessionWith('ABILITY_GORILLA_TACTICS')
    expect(menu(session)).toEqual(['MOVE_TACKLE', 'MOVE_WATER_GUN', 'SWITCH'])
    session.state.battlers[0]!.choicedMove = 'MOVE_TACKLE'
    expect(menu(session)).toEqual(['MOVE_TACKLE', 'SWITCH'])
  })

  it('the same filter applies to Discipline and Sage Power (:1585-1596)', () => {
    for (const ability of ['ABILITY_DISCIPLINE', 'ABILITY_SAGE_POWER']) {
      const session = sessionWith(ability)
      session.state.battlers[0]!.choicedMove = 'MOVE_WATER_GUN'
      expect(menu(session)).toEqual(['MOVE_WATER_GUN', 'SWITCH'])
    }
  })
})

// Keep the imported bridge helper used for completeness: the real damage engine must also drive the
// same writer (the focused cases above use fixed damage to isolate the lock bookkeeping).
describe('cycle 110d - real damage engine integration', () => {
  it('Gorilla Tactics records through the engine-backed resolver too', () => {
    const state = battle(monFor('SPECIES_MUDKIP', { abilities: only('ABILITY_GORILLA_TACTICS') }), monFor('SPECIES_MUDKIP'), countRng())
    executeTurn(state, [useMove(1, 'MOVE_TACKLE'), null], loopDeps(state, bridgeDamage(state)))
    expect(state.battlers[0]!.choicedMove).toBe('MOVE_TACKLE')
  })
})
