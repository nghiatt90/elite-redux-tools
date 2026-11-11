/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibcd2: MOVEEND_DANCER (src/battle_script_commands.c:4854-4879) and the four
// onCopyMove hooks dispatched by AbilityBattleEffects(ABILITYEFFECT_MOVE_END_OTHER)
// (src/battle_util.c:4496-4503):
//   Dancer   src/abilities.cc:3008-3013  CHECK(IsDance(attacker, move))
//   Samba    src/abilities.cc:9406-9409  Impl<ABILITY_DANCER>.onCopyMove
//   Parroting src/abilities.cc:6880-6887 CHECK(IsSoundMove(attacker, move))
//   Lunar Affinity src/abilities.cc:8855-8860 CHECK(gBattleMoves[move].lunar)
// All four end in UseOutOfTurnAttack(battler, target, ability, move, 0)
// (src/battle_util.c:3759-3777), ported as queueOutOfTurnAttack in moveEnd.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { runMoveEnd } from './moveEnd'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import { DEFAULT_STAT_STAGE, STAT_ATK, STAT_SPEED, STATUS1_SLEEP } from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')

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
    pp: m.pp as number,
  }
}

// Dancer's path never reads species data; only moves and the (empty) item table are consulted.
function speciesData(_id: string): SimSpeciesData | undefined {
  return undefined
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
  species: speciesData,
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

interface Spec {
  spe?: number
  hp?: number
  maxHp?: number
  abilities?: SimBattleMon['abilities']
  moves?: SimBattleMon['moves']
  pp?: SimBattleMon['pp']
  status1?: number
}

function battlerSpec(id: number, s: Spec) {
  return createBattlerState(
    id,
    mon({
      rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (id === 0 ? 100 : 50) },
      hp: s.hp ?? 100,
      maxHp: s.maxHp ?? 100,
      abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
      moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
      pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
      status1: s.status1 ?? 0,
    }),
    0,
  )
}

function battle(specs: Spec[], rng: RandomSource): BattleState {
  return createBattleState({ battlers: specs.map((s, i) => battlerSpec(i, s)), rng })
}

function countingRng(): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return 0
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

function testDeps(damage: DamageResolver = fixedDamage(20), replacement?: ReplacementDeps): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: GROUNDING,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })
const stage = (s: BattleState, id: number, stat: number, fallback = DEFAULT_STAT_STAGE) =>
  s.battlers[id]?.mon.statStages[stat] ?? fallback

describe('Cycle 150ibcd2 - MOVEEND_DANCER copies (battle_script_commands.c:4854-4879)', () => {
  it('Dancer (slower) copies the opponent\'s Swords Dance: +2 Atk, and its own action still runs', () => {
    const s = battle(
      [
        { moves: slot('MOVE_SWORDS_DANCE'), pp: [20, 0, 0, 0] },
        { abilities: hasAbility('ABILITY_DANCER'), moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
      ],
      countingRng(),
    )
    executeTurn(s, [useMove(0, move('MOVE_SWORDS_DANCE')), useMove(0, move('MOVE_TACKLE'))], testDeps())

    // The initial Swords Dance raises battler 0; the copy (queued at move-end, drained as an
    // extra attack) raises the dancer. The dancer's own Tackle still consumes its PP slot.
    expect(stage(s, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE + 2)
    expect(stage(s, 1, STAT_ATK)).toBe(DEFAULT_STAT_STAGE + 2)
    expect(s.battlers[1]!.mon.pp[0]).toBe(34)
    expect(s.queuedExtraAttacks).toEqual([])
  })

  it('Samba copies Dragon Dance (Impl<ABILITY_DANCER>.onCopyMove): +1 Atk and +1 Speed', () => {
    const s = battle(
      [
        { moves: slot('MOVE_DRAGON_DANCE'), pp: [20, 0, 0, 0] },
        { abilities: hasAbility('ABILITY_SAMBA'), moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
      ],
      countingRng(),
    )
    executeTurn(s, [useMove(0, move('MOVE_DRAGON_DANCE')), useMove(0, move('MOVE_TACKLE'))], testDeps())

    expect(stage(s, 1, STAT_ATK)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(stage(s, 1, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE + 1)
    expect(s.battlers[1]!.mon.pp[0]).toBe(34)
  })

  it('Parroting copies a sound move (Hyper Voice) and damages the original user', () => {
    const calls: { attacker: number; moveId: string; target: number; dancerUsed: boolean }[] = []
    const resolver: DamageResolver = {
      resolve: (state, attackerId, targetId, action) => {
        calls.push({
          attacker: attackerId,
          moveId: action.chosenMove!.id,
          target: targetId,
          dancerUsed: Boolean(state.battlers[1]?.turn.dancerUsedMove),
        })
        return { targetDamage: 20, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
      },
    }
    const s = battle(
      [
        { moves: slot('MOVE_HYPER_VOICE'), pp: [10, 0, 0, 0] },
        { abilities: hasAbility('ABILITY_PARROTING') },
      ],
      countingRng(),
    )
    executeTurn(s, [useMove(1, move('MOVE_HYPER_VOICE')), null], testDeps(resolver))

    expect(calls).toEqual([
      { attacker: 0, moveId: 'MOVE_HYPER_VOICE', target: 1, dancerUsed: false },
      // UseOutOfTurnAttack sets dancerUsedMove before the copy executes; the copy is BATTLE_OPPOSITE(dancer).
      { attacker: 1, moveId: 'MOVE_HYPER_VOICE', target: 0, dancerUsed: true },
    ])
    expect(s.battlers[0]!.mon.hp).toBe(80)
    expect(s.battlers[1]!.mon.hp).toBe(80)
  })

  it('Lunar Affinity copies a lunar move (Moonblast) and damages the original user', () => {
    const calls: { attacker: number; moveId: string; target: number }[] = []
    const resolver: DamageResolver = {
      resolve: (_state, attackerId, targetId, action) => {
        calls.push({ attacker: attackerId, moveId: action.chosenMove!.id, target: targetId })
        return { targetDamage: 20, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
      },
    }
    const s = battle(
      [
        { moves: slot('MOVE_MOONBLAST'), pp: [15, 0, 0, 0] },
        { abilities: hasAbility('ABILITY_LUNAR_AFFINITY') },
      ],
      countingRng(),
    )
    executeTurn(s, [useMove(1, move('MOVE_MOONBLAST')), null], testDeps(resolver))

    expect(calls).toEqual([
      { attacker: 0, moveId: 'MOVE_MOONBLAST', target: 1 },
      { attacker: 1, moveId: 'MOVE_MOONBLAST', target: 0 },
    ])
    expect(s.battlers[0]!.mon.hp).toBe(80)
  })
})

describe('Cycle 150ibcd2 - MOVEEND_DANCER negatives', () => {
  it('a non-dance, non-sound, non-lunar move (Tackle) is not copied', () => {
    const seen: number[] = []
    const resolver: DamageResolver = {
      resolve: (_state, attackerId) => {
        seen.push(attackerId)
        return { targetDamage: 20, attackerDamage: null, unmodelled: [], isCriticalHit: false, berryReduced: false, isSuperEffective: false }
      },
    }
    const s = battle(
      [
        { moves: slot('MOVE_TACKLE'), pp: [35, 0, 0, 0] },
        { abilities: hasAbility('ABILITY_DANCER') },
      ],
      countingRng(),
    )
    executeTurn(s, [useMove(1, move('MOVE_TACKLE')), null], testDeps(resolver))
    expect(seen).toEqual([0])
    expect(s.battlers[0]!.mon.hp).toBe(100)
  })

  it('an asleep dancer does not copy UseOutOfTurnAttack\'s STATUS1_SLEEP gate (:3761)', () => {
    const s = battle(
      [
        { moves: slot('MOVE_AQUA_STEP'), pp: [20, 0, 0, 0] },
        { abilities: hasAbility('ABILITY_DANCER'), status1: STATUS1_SLEEP },
      ],
      countingRng(),
    )
    executeTurn(s, [useMove(1, move('MOVE_AQUA_STEP')), null], testDeps())

    // The dance move still hits and raises the user's Speed; the sleeping holder boosts nothing.
    expect(stage(s, 1, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE)
    expect(s.battlers[1]!.mon.hp).toBe(80)
  })

  it('the attacker\'s own Dancer never copies its own move (the candidate list excludes gBattlerAttacker)', () => {
    const s = battle(
      [
        { abilities: hasAbility('ABILITY_DANCER'), moves: slot('MOVE_SWORDS_DANCE'), pp: [20, 0, 0, 0] },
        {},
      ],
      countingRng(),
    )
    executeTurn(s, [useMove(0, move('MOVE_SWORDS_DANCE')), null], testDeps())
    expect(stage(s, 0, STAT_ATK)).toBe(DEFAULT_STAT_STAGE + 2)
    expect(s.queuedExtraAttacks).toEqual([])
  })

  it('a no-effect move (MOVE_RESULT_NO_EFFECT) copies nothing, even for a dance move', () => {
    const s = battle(
      [
        { moves: slot('MOVE_AQUA_STEP'), pp: [20, 0, 0, 0] },
        { abilities: hasAbility('ABILITY_DANCER'), spe: 200 },
      ],
      countingRng(),
    )
    // targetDamage 0 (protect/immunity) is the sim's MOVE_RESULT_NO_EFFECT proxy.
    runMoveEnd({
      state: s,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_AQUA_STEP',
      targetDamage: 0,
      hpDealt: 0,
      noEffect: true,
      deps: testDeps(fixedDamage(0)),
      unmodelled: [],
      fainted: [],
    })
    expect(s.queuedExtraAttacks).toEqual([])
    expect(stage(s, 1, STAT_SPEED)).toBe(DEFAULT_STAT_STAGE)
  })

  it('dancerUsedMove already set blocks the copy, and the old gap note is gone', () => {
    const s = battle(
      [
        { moves: slot('MOVE_SWORDS_DANCE'), pp: [20, 0, 0, 0] },
        { abilities: hasAbility('ABILITY_DANCER') },
      ],
      countingRng(),
    )
    const unmodelled: string[] = []
    runMoveEnd({
      state: s,
      attackerId: 0,
      targetId: 0,
      moveId: 'MOVE_SWORDS_DANCE',
      targetDamage: 0,
      hpDealt: 0,
      noEffect: false,
      deps: testDeps(fixedDamage(0)),
      unmodelled,
      fainted: [],
    })
    expect(s.queuedExtraAttacks.map((a) => a.attacker)).toEqual([1])
    expect(s.battlers[1]!.turn.dancerUsedMove).toBe(true)
    expect(unmodelled).not.toContain('move-end Dancer (ABILITY_DANCER) is not modelled yet')

    // Second move-end in the same turn: gTurnStructs[1].dancerUsedMove is still set.
    const second: string[] = []
    runMoveEnd({
      state: s,
      attackerId: 0,
      targetId: 0,
      moveId: 'MOVE_SWORDS_DANCE',
      targetDamage: 0,
      hpDealt: 0,
      noEffect: false,
      deps: testDeps(fixedDamage(0)),
      unmodelled: second,
      fainted: [],
    })
    expect(s.queuedExtraAttacks.map((a) => a.attacker)).toEqual([1])
  })
})

describe('Cycle 150ibcd2 - MOVEEND_DANCER ordering', () => {
  it('two dancers sort fastest-first; the C walks the list in reverse so the drain (LIFO) pops the faster first', () => {
    // Doubles layout: 0/2 player side, 1/3 opponent side. Speeds 2 > 3 > 1, so the C sort is [2,3,1]
    // and the reverse walk queues 1 (no ability), 3, then 2.
    const s = createBattleState({
      battlers: [
        battlerSpec(0, { spe: 100, moves: slot('MOVE_AQUA_STEP'), pp: [20, 0, 0, 0] }),
        battlerSpec(1, { spe: 10 }),
        battlerSpec(2, { spe: 150, abilities: hasAbility('ABILITY_DANCER') }),
        battlerSpec(3, { spe: 50, abilities: hasAbility('ABILITY_DANCER') }),
      ],
      rng: countingRng(),
    })
    runMoveEnd({
      state: s,
      attackerId: 0,
      targetId: 1,
      moveId: 'MOVE_AQUA_STEP',
      targetDamage: 20,
      hpDealt: 20,
      noEffect: false,
      deps: testDeps(),
      unmodelled: [],
      fainted: [],
    })

    expect(s.queuedExtraAttacks.map((a) => a.attacker)).toEqual([3, 2])
    // BATTLE_OPPOSITE(dancer): battler 2 (side 0) copies at 3, battler 3 (side 1) copies at 2.
    expect(s.queuedExtraAttacks.map((a) => a.target)).toEqual([2, 3])
    // LIFO: the last push (battler 2, the fastest) comes off first.
    expect(s.queuedExtraAttacks.pop()!.attacker).toBe(2)
    expect(s.queuedExtraAttacks.pop()!.attacker).toBe(3)
  })
})
