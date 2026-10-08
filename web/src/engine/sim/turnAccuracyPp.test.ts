// executeTurn's accuracy check (Cmd_accuracycheck) and PP deduction
// (Cmd_ppreduce) -- see turn.ts's header for the C citations and the exact
// scope this batch covers. Split from turn.test.ts per the execute brief:
// the turn-order suite there stays data-less (NO_DATA -- moveAccuracy 0,
// "cannot miss"), so it is unaffected by anything here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimMoveData } from './dataContext'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))

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
  }
}
function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}
// Fail loudly here, not by a silently-vacuous test later, if any of these ids
// are ever renamed or removed.
const TACKLE = requireMove('MOVE_TACKLE') // accuracy 100
const THUNDER = requireMove('MOVE_THUNDER') // accuracy 85
const AERIAL_ACE = requireMove('MOVE_AERIAL_ACE') // accuracy 0 -> the 101 "cannot miss" sentinel
requireAbility('ABILITY_PRESSURE')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false }
const DATA_CONTEXT: SimDataContext = {
  species: () => undefined,
  item: () => undefined,
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
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function battle(specs: { spe: number; hp?: number; abilities?: SimBattleMon['abilities']; moves?: SimBattleMon['moves']; pp?: SimBattleMon['pp'] }[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe },
          hp: s.hp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ?? [35, 0, 0, 0],
        }),
        0,
      ),
    ),
    rng,
  })
}

function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

function useMove(target: number, move: SimMoveData = TACKLE): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id, priority: 0, effect: move.effect, isStatus: move.split === 'STATUS', resolvedType: move.type ?? 'NORMAL', power: move.power,
    flags: move.flags, split: move.split ?? 'PHYSICAL', hasStrongJawBoostFlag: false, isKeenEdge: false, naturalGiftPriority: 0,
    isGrassyTerrainAffected: false, myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function fixedDamage(amount: number): DamageResolver & { calls: number } {
  const r = { calls: 0, resolve: () => { r.calls++; return { targetDamage: amount, attackerDamage: null, unmodelled: [] } } }
  return r
}

function deps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('executeTurn: accuracy check (Cmd_accuracycheck, battle_script_commands.c:1398-1447)', () => {
  it('hits at the boundary: draw 84 against accuracy 85 (84 < 85)', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(84))
    const out = executeTurn(state, [useMove(1, THUNDER), null], deps(fixedDamage(10)))
    expect(out.actions[0].missed).toBe(false)
    expect(out.actions[0].targetDamage).toBe(10)
    expect(state.battlers[1]!.mon.hp).toBe(90)
  })

  it('misses at the boundary: draw 85 against accuracy 85 (85 >= 85)', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(85))
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1, THUNDER), null], deps(dmg))
    expect(out.actions[0].missed).toBe(true)
    // A miss deals no damage: distinct from an immunity (0), and distinct from
    // "nothing was attempted" only in that missed is explicitly true.
    expect(out.actions[0].targetDamage).toBeNull()
    expect(state.battlers[1]!.mon.hp).toBe(100)
    // The damage resolver never runs for a missed move.
    expect(dmg.calls).toBe(0)
  })

  it('a 101-accuracy move (moveAccuracy 0, ACCURACY_HITS_IF_POSSIBLE) never misses, even at the top of the draw range', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(99))
    const out = executeTurn(state, [useMove(1, AERIAL_ACE), null], deps(fixedDamage(10)))
    expect(out.actions[0].missed).toBe(false)
    expect(out.actions[0].targetDamage).toBe(10)
  })

  it('draws the accuracy check before the damage resolver\'s own draws', () => {
    // Two values on the SAME state.rng: 10 for the accuracy check (consumed
    // first, invisibly to this test) and 42 for whatever the resolver draws
    // next. If the resolver ever saw 10 instead of 42, the accuracy draw was
    // not consumed first.
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(10, 42))
    const seen: number[] = []
    const resolver: DamageResolver = {
      resolve(s) {
        seen.push(s.rng.random16())
        return { targetDamage: 1, attackerDamage: null, unmodelled: [] }
      },
    }
    executeTurn(state, [useMove(1, TACKLE), null], deps(resolver))
    expect(seen).toEqual([42])
  })

  it('the accuracy draw does not happen for a fainted attacker\'s skipped action', () => {
    const state = battle([{ spe: 200, hp: 0 }, { spe: 50 }], scripted(85)) // 85 would miss THUNDER if drawn
    const out = executeTurn(state, [useMove(1, THUNDER), null], deps(fixedDamage(10)))
    expect(out.actions[0].skippedBecauseFainted).toBe(true)
    expect(out.actions[0].missed).toBe(false)
  })

  it('every structural accuracy gap is reported, exactly, for a plain hit with no Pressure/Anticipation/Stockpile', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }], scripted(0))
    const out = executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    const gapFields = [
      'attackerTrepidationNonzero', 'attackerUsedMicleBerry', 'attackerAccStage', 'defenderEvasionStage',
      'defenderHasForesight', 'defenderHasAlwaysHits', 'battlerWithSureHitIsAttacker', 'defenderHasTelekinesis',
      'defenderHasPhantomForce', 'defenderIsOnAir', 'defenderIsUnderground', 'defenderIsUnderwater',
      'defenderSmokescreenActive', 'myceliumMightActive',
      // accuracy.ts's own unconditional gap (IsStatDropBlocked), appended after
      // accuracyBridge.ts's structural list.
      'attackerAccuracyDropBlockedSpecific',
    ]
    for (const field of gapFields) {
      expect(out.actions[0].unmodelled.some((u) => u.startsWith(`${field}:`))).toBe(true)
    }
    // And nothing else -- no Pressure/Anticipation/Stockpile note when none apply.
    expect(out.actions[0].unmodelled.some((u) => u.includes('Anticipation'))).toBe(false)
    expect(out.actions[0].unmodelled.some((u) => u.includes('Pressure'))).toBe(false)
  })

  it('gaps Cmd_accuracycheck\'s own Anticipation branch by name only when the defender holds it', () => {
    const withAnticipation = battle([{ spe: 200 }, { spe: 50, abilities: { ability: 'ABILITY_ANTICIPATION', innates: [null, null, null] } }], scripted(0))
    const out = executeTurn(withAnticipation, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out.actions[0].unmodelled.some((u) => u.includes('Anticipation'))).toBe(true)

    const without = battle([{ spe: 200 }, { spe: 50 }], scripted(0))
    const out2 = executeTurn(without, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(out2.actions[0].unmodelled.some((u) => u.includes('Anticipation'))).toBe(false)
  })
})

describe('executeTurn: PP deduction (Cmd_ppreduce, battle_script_commands.c:1460-1506)', () => {
  it('a normal hit deducts 1 PP', () => {
    const state = battle([{ spe: 200, pp: [10, 0, 0, 0] }, { spe: 50 }], scripted(0))
    executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
  })

  it('sets notFirstStrike and resets sameMoveTurns to 0 on a real deduction', () => {
    const state = battle([{ spe: 200, pp: [10, 0, 0, 0] }, { spe: 50 }], scripted(0))
    state.battlers[0]!.sameMoveTurns = 3
    executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.round.notFirstStrike).toBe(false) // set by ppreduce, then cleared by TurnValuesCleanUp(FALSE) at end of turn (battle_main.c:3492)
    expect(state.battlers[0]!.sameMoveTurns).toBe(0)
  })

  it('Pressure on the opposing side deducts an extra PP (2 total)', () => {
    const state = battle(
      [{ spe: 200, pp: [10, 0, 0, 0] }, { spe: 50, abilities: { ability: 'ABILITY_PRESSURE', innates: [null, null, null] } }],
      scripted(0),
    )
    executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(8)
  })

  it('the attacker\'s OWN Pressure does not double-deduct against itself', () => {
    const state = battle(
      [{ spe: 200, pp: [10, 0, 0, 0], abilities: { ability: 'ABILITY_PRESSURE', innates: [null, null, null] } }, { spe: 50 }],
      scripted(0),
    )
    executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
  })

  it('PP floors at 0 and never goes negative', () => {
    const state = battle([{ spe: 200, pp: [1, 0, 0, 0] }, { spe: 50, abilities: { ability: 'ABILITY_PRESSURE', innates: [null, null, null] } }], scripted(0))
    executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(0)
  })

  it('a slot already at 0 PP deducts nothing and sets neither notFirstStrike nor sameMoveTurns', () => {
    const state = battle([{ spe: 200, pp: [0, 0, 0, 0] }, { spe: 50 }], scripted(0))
    state.battlers[0]!.sameMoveTurns = 7
    executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(0)
    expect(state.battlers[0]!.round.notFirstStrike).toBe(false)
    expect(state.battlers[0]!.sameMoveTurns).toBe(7)
  })

  it('a skipped action (fainted attacker) deducts nothing', () => {
    const state = battle([{ spe: 200, hp: 0, pp: [10, 0, 0, 0] }, { spe: 50 }], scripted(0))
    executeTurn(state, [useMove(1, TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.mon.pp[0]).toBe(10)
  })

  it('a missed move still deducts PP', () => {
    const state = battle([{ spe: 200, pp: [10, 0, 0, 0], moves: ['MOVE_THUNDER', null, null, null] }, { spe: 50 }], scripted(85)) // 85 misses THUNDER (accuracy 85)
    const out = executeTurn(state, [useMove(1, THUNDER), null], deps(fixedDamage(10)))
    expect(out.actions[0].missed).toBe(true)
    expect(state.battlers[0]!.mon.pp[0]).toBe(9)
  })

  it('gaps Spit Up/Swallow\'s Stockpile PP refund by name, only for that move effect', () => {
    const spitUpId = rawMoves.find((m) => m.effect === 'EFFECT_SPIT_UP')?.id as string | undefined
    if (!spitUpId) return // no EFFECT_SPIT_UP move in this snapshot; nothing to assert
    const spitUp = requireMove(spitUpId)
    const state = battle([{ spe: 200, pp: [10, 0, 0, 0], moves: [spitUpId, null, null, null] }, { spe: 50 }], scripted(0))
    const out = executeTurn(state, [useMove(1, spitUp), null], deps(fixedDamage(10)))
    expect(out.actions[0].unmodelled.some((u) => u.includes('Stockpile'))).toBe(true)
  })
})
