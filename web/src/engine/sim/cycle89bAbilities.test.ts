/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { dispatchSwitchOutAbilities, executeTurn } from './turn'
import { applySwitchInAbilities, getSingleUseAbilityCounter, setSingleUseAbilityCounter } from './switchInAbility'
import { packStrikeoutState, runEndTurnEffects, strikeoutClearFlags, unpackStrikeoutState } from './endTurn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import { STAT_SPEED, STATUS3_HEAL_BLOCK, WEATHER_HAIL_ANY } from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))

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
  types?: [string, string, string]
  status1?: number
}

function battle(specs: Spec[], rng: RandomSource): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? s.maxHp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          status1: s.status1 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[idx++] ?? 0
    },
  }
  return r
}

const countingRng = () => scriptedRng([])

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

function testDeps(damage: DamageResolver = fixedDamage(20)): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

/** A turn where nobody acts, so only the end-turn ladder runs. */
function quietTurn(state: BattleState): TurnOutcome {
  return executeTurn(state, [null, null], testDeps())
}

/** Only the per-battler end-turn ladder (no field effects such as hail damage), every battler in id order. */
function endTurn(state: BattleState) {
  return runEndTurnEffects(state, state.battlers.map((_, i) => i), DATA_CONTEXT, { grounding: GROUNDING, statStageRatios: RATIOS })
}

function switchIn(state: BattleState, battlerId: number): string[] {
  const unmodelled: string[] = []
  applySwitchInAbilities(state, battlerId, { grounding: GROUNDING, dataContext: DATA_CONTEXT, statStageRatios: RATIOS } as Parameters<typeof applySwitchInAbilities>[2], unmodelled)
  return unmodelled
}

const hpOf = (s: BattleState, id: number) => s.battlers[id]!.mon.hp
const GAP = (battlerId: number, ability: string) => `battler ${battlerId}: ENDTURN_ABILITIES (battle_util.c:2452-2459) is not applied -- ${ability}'s onEndTurn hook was not run`

describe('Cycle 89b - Peaceful Slumber (src/abilities.cc:6341-6347 = Sweet Dreams :4288-4300, else Self Sufficient :4041-4054)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 160, hp: 50, abilities: hasAbility('ABILITY_PEACEFUL_SLUMBER'), ...extra })

  it('asleep: maxHP / 8 plus a further maxHP / 16 = 20 + 10 = 30', () => {
    const s = battle([holder({ status1: 2 }), {}], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(80)
  })

  it('awake: falls through to Self Sufficient, maxHP / 16 = 10', () => {
    const s = battle([holder(), {}], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(60)
  })

  it('Comatose counts as asleep: 30', () => {
    const s = battle([holder({ abilities: { ability: 'ABILITY_PEACEFUL_SLUMBER', innates: ['ABILITY_COMATOSE', null, null] } }), {}], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(80)
  })

  it('maxHP 8, asleep: 8 / 8 = 1, and the extra 8 / 16 is 0', () => {
    const s = battle([holder({ maxHp: 8, hp: 4, status1: 2 }), {}], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(5)
  })

  it('maxHP 8, awake: 8 / 16 = 0 is raised to 1', () => {
    const s = battle([holder({ maxHp: 8, hp: 4 }), {}], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(5)
  })

  it('does not heal at full hp', () => {
    const s = battle([holder({ hp: 160, status1: 2 }), {}], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(160)
  })

  it('is blocked by Heal Block (CanBattlerHeal)', () => {
    const s = battle([holder({ status1: 2 }), {}], countingRng())
    s.battlers[0]!.statuses3 |= STATUS3_HEAL_BLOCK
    s.battlers[0]!.volatiles.healBlockTimer = 3
    endTurn(s)
    expect(hpOf(s, 0)).toBe(50)
  })

  it('on the turn it came in (isFirstTurn == 2): awake no heal (Self Sufficient), asleep still heals (Sweet Dreams has no such check)', () => {
    const awake = battle([holder(), {}], countingRng())
    awake.battlers[0]!.volatiles.isFirstTurn = 2
    endTurn(awake)
    expect(hpOf(awake, 0)).toBe(50)
    const asleep = battle([holder({ status1: 2 }), {}], countingRng())
    asleep.battlers[0]!.volatiles.isFirstTurn = 2
    endTurn(asleep)
    expect(hpOf(asleep, 0)).toBe(80)
  })
})

describe('Cycle 89b - Sap Trap (src/abilities.cc:11390-11411)', () => {
  const holder = (): Spec => ({ abilities: hasAbility('ABILITY_SAP_TRAP') })

  it('lowers the opposing battler Speed by 1: 6 -> 5', () => {
    const s = battle([holder(), {}], countingRng())
    endTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(5)
    expect(s.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(6)
  })

  it('keeps lowering each turn', () => {
    const s = battle([holder(), {}], countingRng())
    endTurn(s)
    endTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(4)
  })

  it('does nothing at -6 (CanLowerStat)', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[1]!.mon.statStages[STAT_SPEED] = 0
    endTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(0)
  })

  it('a Contrary foe at -6 can still be "lowered" (CompareStat flips): 0 -> 1', () => {
    const s = battle([holder(), { abilities: hasAbility('ABILITY_CONTRARY') }], countingRng())
    s.battlers[1]!.mon.statStages[STAT_SPEED] = 0
    endTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(1)
  })

  it('doubles: both foes are lowered, the ally is not', () => {
    const s = battle([holder(), {}, {}, {}], countingRng())
    endTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(5)
    expect(s.battlers[3]!.mon.statStages[STAT_SPEED]).toBe(5)
    expect(s.battlers[2]!.mon.statStages[STAT_SPEED]).toBe(6)
  })

  it('doubles: a fainted foe is skipped, the other still lowered', () => {
    const s = battle([holder(), {}, {}, { hp: 0 }], countingRng())
    endTurn(s)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(5)
    expect(s.battlers[3]!.mon.statStages[STAT_SPEED]).toBe(6)
  })

  it('a foe holding the ability does not lower its own side', () => {
    const s = battle([{}, holder()], countingRng())
    endTurn(s)
    expect(s.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(5)
    expect(s.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(6)
  })
})

describe('Cycle 89b - Soothsayer (src/abilities.cc:9435-9456)', () => {
  const holder = (): Spec => ({ abilities: hasAbility('ABILITY_SOOTHSAYER') })

  it('switch-in sets the state to 4 once, and reports no unrun hook', () => {
    const s = battle([holder(), {}], countingRng())
    expect(switchIn(s, 0)).toEqual([])
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(4)
    expect(getSingleUseAbilityCounter(s, 0, 'ABILITY_SOOTHSAYER', DATA_CONTEXT)).toBe(1)
  })

  it('does not set the state again when the single-use counter is already spent', () => {
    const s = battle([holder(), {}], countingRng())
    setSingleUseAbilityCounter(s, 0, 'ABILITY_SOOTHSAYER', 1, DATA_CONTEXT)
    switchIn(s, 0)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('counts down one per end of turn: 4 -> 3 -> 2 -> 1 -> 0, and stays at 0', () => {
    const s = battle([holder(), {}], countingRng())
    switchIn(s, 0)
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      endTurn(s)
      seen.push(s.battlers[0]!.volatiles.abilityState[0]!)
    }
    expect(seen).toEqual([3, 2, 1, 0, 0])
  })

  it('a holder that never switched in (state 0) stays at 0', () => {
    const s = battle([holder(), {}], countingRng())
    endTurn(s)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })
})

describe('Cycle 89b - Talon Trap (src/abilities.cc:4732-4743)', () => {
  const holder = (): Spec => ({ abilities: hasAbility('ABILITY_TALON_TRAP') })

  it('switch-in sets the state to 1 when it is not the first turn', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    switchIn(s, 0)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(1)
  })

  it('switch-in leaves the state alone on the first turn (isFirstTurn == 2)', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 2
    switchIn(s, 0)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })

  it('the end of turn clears the state', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.abilityState[0] = 1
    endTurn(s)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
  })
})

describe('Cycle 89b - Sumo Wrestler (src/abilities.cc:12098-12115)', () => {
  const holder = (): Spec => ({ abilities: hasAbility('ABILITY_SUMO_WRESTLER') })

  it('first end of turn (state 0) only arms it; the next queues Circle Throw at power 20 and disarms', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    endTurn(s)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    expect(s.queuedExtraAttacks).toEqual([])
    endTurn(s)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(0)
    expect(s.queuedExtraAttacks).toEqual([{ ability: 'ABILITY_SUMO_WRESTLER', move: 'MOVE_CIRCLE_THROW', movePower: 20, attacker: 0, target: 1 }])
  })

  it('alternates: armed, fires, armed, fires', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    const states: number[] = []
    for (let i = 0; i < 4; i++) {
      endTurn(s)
      states.push(s.battlers[0]!.volatiles.abilityState[0]!)
    }
    expect(states).toEqual([1, 0, 1, 0])
    expect(s.queuedExtraAttacks).toHaveLength(2)
  })

  it('does nothing on the turn it came in (isFirstTurn == 2)', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 2
    s.battlers[0]!.volatiles.abilityState[0] = 1
    endTurn(s)
    expect(s.battlers[0]!.volatiles.abilityState[0]).toBe(1)
    expect(s.queuedExtraAttacks).toEqual([])
  })

  it('a holder on side 1 targets battler 0 (GetOppositeSide)', () => {
    const s = battle([{}, holder()], countingRng())
    s.battlers[1]!.volatiles.isFirstTurn = 0
    s.battlers[1]!.volatiles.abilityState[0] = 1
    endTurn(s)
    expect(s.queuedExtraAttacks).toEqual([{ ability: 'ABILITY_SUMO_WRESTLER', move: 'MOVE_CIRCLE_THROW', movePower: 20, attacker: 1, target: 0 }])
  })

  it('through a real turn the extra attack lands: 100 - 20 = 80 on the second quiet turn only', () => {
    const s = battle([holder(), {}], scriptedRng([]))
    s.battlers[0]!.volatiles.isFirstTurn = 0
    quietTurn(s)
    expect(hpOf(s, 1)).toBe(100)
    quietTurn(s)
    expect(hpOf(s, 1)).toBe(80)
  })
})

describe('Cycle 89b - Strikeout (src/abilities.cc:11082-11161)', () => {
  const holder = (): Spec => ({ abilities: hasAbility('ABILITY_STRIKEOUT') })
  const stateOf = (s: BattleState, id = 0) => unpackStrikeoutState(s.battlers[id]!.volatiles.abilityState[0]!)
  const preset = (s: BattleState, counter1: number, counter2: number, damagedBy1 = 0, damagedBy2 = 0, id = 0) => {
    s.battlers[id]!.volatiles.abilityState[0] = packStrikeoutState({ counter1, counter2, damagedBy1, damagedBy2 })
  }

  it('the packed state is four bytes, counter1 lowest', () => {
    expect(packStrikeoutState({ counter1: 1, counter2: 2, damagedBy1: 3, damagedBy2: 4 })).toBe(1 + 2 * 256 + 3 * 65536 + 4 * 16777216)
    expect(unpackStrikeoutState(0x04030201)).toEqual({ counter1: 1, counter2: 2, damagedBy1: 3, damagedBy2: 4 })
  })

  it('counts a turn without being hit by the foe in position 0/1 (counter1) and 2/3 (counter2)', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    endTurn(s)
    expect(stateOf(s)).toEqual({ counter1: 1, counter2: 1, damagedBy1: 0, damagedBy2: 0 })
  })

  it('the third quiet turn queues Whirlwind at power 20 on the opposite battler and resets counter1 (counter2 keeps counting: 3 as well, but the partner is absent)', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    preset(s, 2, 2)
    endTurn(s)
    expect(s.queuedExtraAttacks).toEqual([{ ability: 'ABILITY_STRIKEOUT', move: 'MOVE_WHIRLWIND', movePower: 20, attacker: 0, target: 1 }])
    expect(stateOf(s)).toEqual({ counter1: 0, counter2: 0, damagedBy1: 0, damagedBy2: 0 })
  })

  it('doubles: counter2 reaching 3 queues at BATTLE_PARTNER of the opposite (battler 3) before counter1 queues battler 1', () => {
    const s = battle([holder(), {}, {}, {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    preset(s, 2, 2)
    endTurn(s)
    expect(s.queuedExtraAttacks.map((a) => a.target)).toEqual([3, 1])
  })

  it('doubles: only counter2 at 3 queues only the partner target', () => {
    const s = battle([holder(), {}, {}, {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    preset(s, 0, 2)
    endTurn(s)
    expect(s.queuedExtraAttacks.map((a) => a.target)).toEqual([3])
    expect(stateOf(s)).toEqual({ counter1: 1, counter2: 0, damagedBy1: 0, damagedBy2: 0 })
  })

  it('a fainted target is not queued, but the counter still resets', () => {
    const s = battle([holder(), { hp: 0 }, {}, {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    preset(s, 2, 0)
    endTurn(s)
    expect(s.queuedExtraAttacks).toEqual([])
    expect(stateOf(s).counter1).toBe(0)
  })

  it('being damaged by the foe in position 0/1 skips counter1 for the turn and clears the flags', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    preset(s, 2, 0, 1, 0)
    endTurn(s)
    expect(s.queuedExtraAttacks).toEqual([])
    expect(stateOf(s)).toEqual({ counter1: 2, counter2: 1, damagedBy1: 0, damagedBy2: 0 })
  })

  it('does not count on the turn it came in (isFirstTurn == 2), but still clears the damaged flags', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 2
    preset(s, 1, 1, 1, 1)
    endTurn(s)
    expect(stateOf(s)).toEqual({ counter1: 1, counter2: 1, damagedBy1: 0, damagedBy2: 0 })
  })

  it('onDefender: a damaging hit from the foe marks it, so that turn does not count (counter1 stays 0)', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    s.battlers[1]!.volatiles.isFirstTurn = 0
    executeTurn(s, [null, useMove(0, requireMove('MOVE_TACKLE'))], testDeps(fixedDamage(20)))
    expect(hpOf(s, 0)).toBe(80)
    expect(stateOf(s)).toEqual({ counter1: 0, counter2: 1, damagedBy1: 0, damagedBy2: 0 })
  })

  it('onDefender: a hit that deals no damage does not mark it, so the turn counts (counter1 1)', () => {
    const s = battle([holder(), {}], countingRng())
    s.battlers[0]!.volatiles.isFirstTurn = 0
    s.battlers[1]!.volatiles.isFirstTurn = 0
    executeTurn(s, [null, useMove(0, requireMove('MOVE_TACKLE'))], testDeps(fixedDamage(0)))
    expect(stateOf(s)).toEqual({ counter1: 1, counter2: 1, damagedBy1: 0, damagedBy2: 0 })
  })

  it('strikeoutClearFlags: battler 0 or 1 clears the "1" half, anything else the "2" half', () => {
    const s = battle([holder(), {}], countingRng())
    const b = s.battlers[0]!
    for (const [clearFor, expected] of [
      [0, { counter1: 0, counter2: 4, damagedBy1: 0, damagedBy2: 2 }],
      [1, { counter1: 0, counter2: 4, damagedBy1: 0, damagedBy2: 2 }],
      [2, { counter1: 3, counter2: 0, damagedBy1: 1, damagedBy2: 0 }],
      [3, { counter1: 3, counter2: 0, damagedBy1: 1, damagedBy2: 0 }],
    ] as const) {
      preset(s, 3, 4, 1, 2)
      strikeoutClearFlags(b, 'ABILITY_STRIKEOUT', clearFor)
      expect(unpackStrikeoutState(b.volatiles.abilityState[0]!)).toEqual(expected)
    }
  })

  it('onExit: a foe switching out clears the half for that foe; no unrun-hook line is reported any more', () => {
    const s = battle([holder(), {}], countingRng())
    preset(s, 2, 2, 1, 1)
    const unmodelled: string[] = []
    dispatchSwitchOutAbilities(s, 1, undefined, testDeps(), unmodelled)
    expect(stateOf(s)).toEqual({ counter1: 0, counter2: 2, damagedBy1: 0, damagedBy2: 1 })
    expect(unmodelled.join('\n')).not.toContain('StrikeoutClearFlags')
  })

  it('onBattlerFaints: the holder knocking out the foe in position 1 clears the "1" half', () => {
    const s = battle([{ ...holder(), moves: ['MOVE_TACKLE', null, null, null] }, { hp: 20 }], countingRng())
    preset(s, 2, 2, 1, 1)
    executeTurn(s, [useMove(1, requireMove('MOVE_TACKLE')), null], testDeps(fixedDamage(20)))
    expect(hpOf(s, 1)).toBe(0)
    // The faint hook zeroed counter1 and damagedBy1 (:11157); the end of the same turn then counted counter1 up to 1 (flag cleared, so it
    // counts) while counter2 stayed at 2 (damagedBy2 was still set, so it did not count) and both flags were cleared.
    expect(stateOf(s)).toEqual({ counter1: 1, counter2: 2, damagedBy1: 0, damagedBy2: 0 })
  })
})

describe('Cycle 89b - Winter Throne (src/abilities.cc:10529-10555, scripts battle_scripts_1.s:8637-8643 and :9556-9561)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 160, abilities: hasAbility('ABILITY_WINTER_THRONE'), ...extra })
  const ICE: [string, string, string] = ['ICE', 'MYSTERY', 'MYSTERY']

  it('hurts every alive non-Ice battler, the holder included, for maxHP / 8 = 20', () => {
    const s = battle([holder(), { maxHp: 160 }], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(140)
    expect(hpOf(s, 1)).toBe(140)
  })

  it('heals an Ice-type that is hurt, by maxHP / 8 = 20 (100 -> 120)', () => {
    const s = battle([holder(), { maxHp: 160, hp: 100, types: ICE }], countingRng())
    endTurn(s)
    expect(hpOf(s, 1)).toBe(120)
  })

  it('an Ice-type holder is not hurt', () => {
    const s = battle([holder({ types: ICE }), {}], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(160)
  })

  it('the heal is sized by hpfractiontodamage, which caps at the current hp: an Ice-type with 10 hp heals 10 -> 20', () => {
    const s = battle([holder(), { maxHp: 160, hp: 10, types: ICE }], countingRng())
    endTurn(s)
    expect(hpOf(s, 1)).toBe(20)
  })

  it('does not heal a full-hp Ice-type', () => {
    const s = battle([holder(), { maxHp: 160, types: ICE }], countingRng())
    endTurn(s)
    expect(hpOf(s, 1)).toBe(160)
  })

  it('does not heal an Ice-type under Heal Block', () => {
    const s = battle([holder(), { maxHp: 160, hp: 100, types: ICE }], countingRng())
    s.battlers[1]!.statuses3 |= STATUS3_HEAL_BLOCK
    s.battlers[1]!.volatiles.healBlockTimer = 3
    endTurn(s)
    expect(hpOf(s, 1)).toBe(100)
  })

  it('Magic Guard blocks the damage', () => {
    const s = battle([holder(), { maxHp: 160, abilities: hasAbility('ABILITY_MAGIC_GUARD') }], countingRng())
    endTurn(s)
    expect(hpOf(s, 1)).toBe(160)
    expect(hpOf(s, 0)).toBe(140)
  })

  it('minimum 1 (maxHP 7 / 8 = 0 -> 1) and capped at the hp left (5 hp, 20 -> 5: faints)', () => {
    const small = battle([holder(), { maxHp: 7 }], countingRng())
    endTurn(small)
    expect(hpOf(small, 1)).toBe(6)
    const low = battle([holder(), { maxHp: 160, hp: 5 }], countingRng())
    endTurn(low)
    expect(hpOf(low, 1)).toBe(0)
  })

  it('doubles: only the lowest-numbered holder runs it, so nobody is hit twice', () => {
    const s = battle([holder(), { maxHp: 160 }, holder(), { maxHp: 160 }], countingRng())
    endTurn(s)
    for (let i = 0; i < 4; i++) expect(hpOf(s, i)).toBe(140)
  })

  it('doubles: if the first holder has fainted the next one runs it', () => {
    const s = battle([holder({ hp: 0 }), { maxHp: 160 }, holder(), { maxHp: 160 }], countingRng())
    endTurn(s)
    expect(hpOf(s, 0)).toBe(0)
    expect(hpOf(s, 1)).toBe(140)
    expect(hpOf(s, 2)).toBe(140)
    expect(hpOf(s, 3)).toBe(140)
  })

  it('its switch-in announcement is no longer reported as an unrun hook', () => {
    const s = battle([holder(), {}], countingRng())
    expect(switchIn(s, 0)).toEqual([])
  })
})

describe('Cycle 89b - Christmas Nightmare (src/abilities.cc:10558-10594)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ maxHp: 160, abilities: hasAbility('ABILITY_CHRISTMAS_NIGHTMARE'), ...extra })
  const inHail = (s: BattleState) => {
    s.field.weather = WEATHER_HAIL_ANY
    return s
  }

  it('in hail, hurts each opposing battler for maxHP / 8 = 20 (not the holder)', () => {
    const s = inHail(battle([holder(), { maxHp: 160 }], countingRng()))
    endTurn(s)
    expect(hpOf(s, 1)).toBe(140)
    expect(hpOf(s, 0)).toBe(160)
  })

  it('does nothing without hail', () => {
    const s = battle([holder(), { maxHp: 160 }], countingRng())
    endTurn(s)
    expect(hpOf(s, 1)).toBe(160)
  })

  it('does nothing when the weather has no effect (Cloud Nine on the field)', () => {
    const s = inHail(battle([holder(), { maxHp: 160, abilities: hasAbility('ABILITY_CLOUD_NINE') }], countingRng()))
    endTurn(s)
    expect(hpOf(s, 1)).toBe(160)
  })

  it('spares hail-immune foes: Ice type, Magic Guard, Ice Body', () => {
    const s = inHail(
      battle(
        [holder(), { maxHp: 160, types: ['ICE', 'MYSTERY', 'MYSTERY'] }, {}, { maxHp: 160, abilities: hasAbility('ABILITY_MAGIC_GUARD') }],
        countingRng(),
      ),
    )
    endTurn(s)
    expect(hpOf(s, 1)).toBe(160)
    expect(hpOf(s, 3)).toBe(160)
    const iceBody = inHail(battle([holder(), { maxHp: 160, abilities: hasAbility('ABILITY_ICE_BODY') }], countingRng()))
    endTurn(iceBody)
    expect(hpOf(iceBody, 1)).toBe(160)
  })

  it('doubles: hits both foes, not the ally', () => {
    const s = inHail(battle([holder(), { maxHp: 160 }, { maxHp: 160 }, { maxHp: 160 }], countingRng()))
    endTurn(s)
    expect(hpOf(s, 1)).toBe(140)
    expect(hpOf(s, 3)).toBe(140)
    expect(hpOf(s, 2)).toBe(160)
  })

  it('doubles: the first holder of the side (battler `side`, then `side ^ 2`) runs it once; the ally holder does not repeat it', () => {
    const s = inHail(battle([holder(), { maxHp: 160 }, holder(), { maxHp: 160 }], countingRng()))
    endTurn(s)
    expect(hpOf(s, 1)).toBe(140)
    expect(hpOf(s, 3)).toBe(140)
  })

  it('doubles: with only the second slot holding it, that battler runs it', () => {
    const s = inHail(battle([{ maxHp: 160 }, { maxHp: 160 }, holder(), { maxHp: 160 }], countingRng()))
    endTurn(s)
    expect(hpOf(s, 1)).toBe(140)
    expect(hpOf(s, 3)).toBe(140)
  })

  it('minimum 1 and capped at the hp left', () => {
    const s = inHail(battle([holder(), { maxHp: 7, hp: 7 }], countingRng()))
    endTurn(s)
    expect(hpOf(s, 1)).toBe(6)
    const low = inHail(battle([holder(), { maxHp: 160, hp: 5 }], countingRng()))
    endTurn(low)
    expect(hpOf(low, 1)).toBe(0)
  })

  it('its switch-in announcement is no longer reported as an unrun hook', () => {
    const s = battle([holder(), {}], countingRng())
    expect(switchIn(s, 0)).toEqual([])
  })
})

describe('Cycle 89b - Color Spectrum (src/abilities.cc:8736-8754)', () => {
  const holder = (extra: Partial<Spec> = {}): Spec => ({ abilities: hasAbility('ABILITY_COLOR_SPECTRUM'), ...extra })

  it('re-rolls Mystery, Stellar and the types it already has: 29 % 20 = 9 (Mystery), 39 % 20 = 19 (Stellar), 20 % 20 = 0 (Normal, own type), then 10 = Fire', () => {
    const rng = scriptedRng([29, 39, 20, 10])
    const s = battle([holder(), {}], rng)
    endTurn(s)
    expect(s.battlers[0]!.mon.types).toEqual(['FIRE', 'FIRE', 'MYSTERY'])
    expect(rng.calls).toBe(4)
  })

  it('a type held in the third slot is rejected too: Water/-/Fire rejects 11 and 10, accepts 15 (Ice)', () => {
    const rng = scriptedRng([11, 10, 15])
    const s = battle([holder({ types: ['WATER', 'MYSTERY', 'FIRE'] }), {}], rng)
    endTurn(s)
    expect(s.battlers[0]!.mon.types).toEqual(['ICE', 'ICE', 'MYSTERY'])
    expect(rng.calls).toBe(3)
  })

  it('can become Normal when not already Normal (draw 0)', () => {
    const s = battle([holder({ types: ['GRASS', 'MYSTERY', 'MYSTERY'] }), {}], scriptedRng([0]))
    endTurn(s)
    expect(s.battlers[0]!.mon.types).toEqual(['NORMAL', 'NORMAL', 'MYSTERY'])
  })

  it('leaves the foe alone and no longer reports an unrun hook', () => {
    const s = battle([holder(), {}], scriptedRng([10]))
    const { unmodelled } = endTurn(s)
    expect(s.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
    expect(unmodelled).not.toContain(GAP(0, 'ABILITY_COLOR_SPECTRUM'))
  })
})

describe('Cycle 89b - still-unported hooks keep reporting themselves', () => {
  for (const id of ['ABILITY_DUAL_SHADOW', 'ABILITY_CRYO_ARCHITECT']) {
    it(`${id} is reported as an unrun end-turn hook`, () => {
      const s = battle([{ abilities: hasAbility(id) }, {}], countingRng())
      const { unmodelled } = endTurn(s)
      expect(unmodelled).toContain(GAP(0, id))
    })
  }
})
