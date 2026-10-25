import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn, setSemiInvulnerableBit } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData, SimSpeciesData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  STATUS2_MULTIPLETURNS,
  STATUS3_ON_AIR,
  STATUS3_PHANTOM_FORCE,
  STATUS3_SEMI_INVULNERABLE,
  STATUS3_UNDERGROUND,
  STATUS3_UNDERWATER,
  hasFlag,
} from './constants'
import { buildBattlerBattleState, type BridgeDeps, type CalculationRoles } from './bridge'
import { applyBattleStartPass } from './switchInAbility'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<Record<string, unknown>>>('items.json')
const itemsById = new Map(rawItems.map((i) => [i.id as string, i]))
const rawSpecies = snapshot<Array<Record<string, unknown>>>('species.json')
const speciesById = new Map(rawSpecies.map((s) => [s.id as string, s]))
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
    target: m.target as string,
    priority: (m.priority as number) ?? 0,
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
    naturalGift: (it.naturalGift as { power: number; type: string } | null) ?? null,
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

const MOVE_FLY = requireMove('MOVE_FLY')
const MOVE_DIG = requireMove('MOVE_DIG')
const MOVE_DIVE = requireMove('MOVE_DIVE')
const MOVE_PHANTOM_FORCE = requireMove('MOVE_PHANTOM_FORCE')
const MOVE_EARTHQUAKE = requireMove('MOVE_EARTHQUAKE')
const MOVE_GUST = requireMove('MOVE_GUST')
const MOVE_SURF = requireMove('MOVE_SURF')
const MOVE_TACKLE = requireMove('MOVE_TACKLE')
const MOVE_PROTECT = requireMove('MOVE_PROTECT')
const ITEM_POWER_HERB = requireItem('ITEM_POWER_HERB')
requireAbility('ABILITY_ACCELERATE')
requireAbility('ABILITY_SLOW_START')
requireAbility('ABILITY_LETHARGY')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

const GROUNDING: GroundingContext = {
  holdEffectOf: (id) => (id === 0 ? null : null),
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

const DATA_CONTEXT: SimDataContext = {
  species: (id) => speciesById.get(id) as unknown as SimSpeciesData | undefined,
  item: (id) => (itemsById.has(id) ? requireItem(id) : undefined),
  move: (id) => (movesById.has(id) ? requireMove(id) : undefined),
}

const BRIDGE_DEPS: BridgeDeps = {
  grounding: GROUNDING,
  turnOrder: { ...NEUTRAL_TURN_ORDER_CONTEXT, isBattlerGrounded: () => true },
  statStageRatios: RATIOS,
  dataContext: DATA_CONTEXT,
  inverseBattle: false,
}

const ROLES: CalculationRoles = { attackerId: 0, defenderId: 1 }

function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE, DEFAULT_STAT_STAGE],
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

function battle(
  specs: {
    spe: number
    hp?: number
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    itemId?: string | null
    status2?: number
  }[],
  rng: RandomSource,
): BattleState {
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
          itemId: s.itemId ?? null,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
}

function countingRng(): RandomSource {
  return { random16: () => 0 }
}

function scripted(...values: number[]): RandomSource {
  let i = 0
  return { random16: () => values[i++] ?? 0 }
}

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function fixedDamage(amount: number): DamageResolver & { calls: number } {
  const r = {
    calls: 0,
    resolve: () => {
      r.calls++
      return { targetDamage: amount, attackerDamage: null, unmodelled: [] }
    },
  }
  return r
}

function deps(damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

describe('setSemiInvulnerableBit (Cmd_setsemiinvulnerablebit, battle_script_commands.c:11541-11566)', () => {
  it('sets correct statuses3 flag for each semi-invulnerable move', () => {
    const b = createBattlerState(0, mon(), 0)

    setSemiInvulnerableBit(b, 'MOVE_FLY')
    expect(hasFlag(b.statuses3, STATUS3_ON_AIR)).toBe(true)
    b.statuses3 = 0

    setSemiInvulnerableBit(b, 'MOVE_BOUNCE')
    expect(hasFlag(b.statuses3, STATUS3_ON_AIR)).toBe(true)
    b.statuses3 = 0

    setSemiInvulnerableBit(b, 'MOVE_DIG')
    expect(hasFlag(b.statuses3, STATUS3_UNDERGROUND)).toBe(true)
    b.statuses3 = 0

    setSemiInvulnerableBit(b, 'MOVE_DIVE')
    expect(hasFlag(b.statuses3, STATUS3_UNDERWATER)).toBe(true)
    b.statuses3 = 0

    setSemiInvulnerableBit(b, 'MOVE_TOXIC_PLUNGE')
    expect(hasFlag(b.statuses3, STATUS3_UNDERWATER)).toBe(true)
    b.statuses3 = 0

    setSemiInvulnerableBit(b, 'MOVE_PHANTOM_FORCE')
    expect(hasFlag(b.statuses3, STATUS3_PHANTOM_FORCE)).toBe(true)
    b.statuses3 = 0

    setSemiInvulnerableBit(b, 'MOVE_SHADOW_FORCE')
    expect(hasFlag(b.statuses3, STATUS3_PHANTOM_FORCE)).toBe(true)
    b.statuses3 = 0
  })
})

describe('EFFECT_SEMI_INVULNERABLE execution: Fly', () => {
  it('charges on turn 1 (deducts PP, sets STATUS3_ON_AIR, avoids ground attack) and hits on turn 2 (clears STATUS3_ON_AIR, no extra PP cost)', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_FLY', null, null, null], pp: [15, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_EARTHQUAKE', null, null, null], pp: [10, 0, 0, 0] },
      ],
      countingRng(),
    )

    // Turn 1: battler 0 charges Fly; battler 1 tries Earthquake
    const out1 = executeTurn(state, [useMove(1, MOVE_FLY), useMove(0, MOVE_EARTHQUAKE)], deps(fixedDamage(20)))

    // Battler 0 charged
    const act0 = out1.actions.find((a) => a.battlerId === 0)!
    expect(act0.missed).toBe(false)
    expect(act0.targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(true)

    // Bridge sees airborne state during turn 1
    const { battler: bridge0 } = buildBattlerBattleState(state, 0, ROLES, BRIDGE_DEPS)
    expect(bridge0.semiInvulnerable).toBe('AIRBORNE')

    // Battler 1's Earthquake misses because battler 0 is on air
    const act1 = out1.actions.find((a) => a.battlerId === 1)!
    expect(act1.missed).toBe(true)
    expect(act1.targetDamage).toBeNull()
    expect(state.battlers[0]!.mon.hp).toBe(100)

    // Turn 2: battler 0 strikes with Fly
    const out2 = executeTurn(state, [useMove(1, MOVE_FLY), useMove(0, MOVE_EARTHQUAKE)], deps(fixedDamage(25)))
    const act0Turn2 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act0Turn2.missed).toBe(false)
    expect(act0Turn2.targetDamage).toBe(25)
    expect(state.battlers[1]!.mon.hp).toBe(75)

    // Statuses cleared on turn 2 hit and PP was not deducted a second time
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(false)
    expect(state.battlers[0]!.statuses3 & STATUS3_SEMI_INVULNERABLE).toBe(0)

    // Bridge confirms semi-invulnerability is NONE after hit
    const { battler: bridge0After } = buildBattlerBattleState(state, 0, ROLES, BRIDGE_DEPS)
    expect(bridge0After.semiInvulnerable).toBe('NONE')
  })

  it('Fly with Power Herb strikes on turn 1 and consumes the herb', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_FLY', null, null, null], pp: [15, 0, 0, 0], itemId: ITEM_POWER_HERB.id },
        { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      ],
      countingRng(),
    )

    const out = executeTurn(state, [useMove(1, MOVE_FLY), useMove(0, MOVE_TACKLE)], deps(fixedDamage(20)))
    const act0 = out.actions.find((a) => a.battlerId === 0)!
    expect(act0.missed).toBe(false)
    expect(act0.targetDamage).toBe(20)
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)
    expect(state.battlers[0]!.mon.itemId).toBeNull()
    expect(state.battlers[0]!.usedHeldItem).toBe(ITEM_POWER_HERB.id)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(false)
  })

  it('Fly with ABILITY_ACCELERATE strikes on turn 1 without consuming an item', () => {
    const state = battle(
      [
        {
          spe: 100,
          moves: ['MOVE_FLY', null, null, null],
          pp: [15, 0, 0, 0],
          abilities: { ability: 'ABILITY_ACCELERATE', innates: [null, null, null] },
        },
        { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      ],
      countingRng(),
    )

    const out = executeTurn(state, [useMove(1, MOVE_FLY), useMove(0, MOVE_TACKLE)], deps(fixedDamage(20)))
    const act0 = out.actions.find((a) => a.battlerId === 0)!
    expect(act0.missed).toBe(false)
    expect(act0.targetDamage).toBe(20)
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(false)
  })

  it('Gust (hitsAir DOUBLE_DAMAGE only) still misses an airborne Fly user: the C ORs two negated flag tests', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_FLY', null, null, null], pp: [15, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_GUST', null, null, null], pp: [35, 0, 0, 0] },
      ],
      countingRng(),
    )

    const out = executeTurn(state, [useMove(1, MOVE_FLY), useMove(0, MOVE_GUST)], deps(fixedDamage(15)))
    const act1 = out.actions.find((a) => a.battlerId === 1)!
    // battle_script_commands.c:1267-1268 misses unless the move has BOTH FLAG_DMG_IN_AIR and
    // FLAG_DMG_2X_IN_AIR; moves.json's hitsAir sets at most one, so Gust misses (C quirk kept).
    expect(act1.missed).toBe(true)
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Fly missing on turn 2 still clears STATUS3_ON_AIR and does not deduct PP', () => {
    // Fly has accuracy 100, which a % 100 roll can never miss, so drop the user's accuracy stage to -6 (33%); every draw is 99.
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_FLY', null, null, null], pp: [15, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      ],
      scripted(99, 99, 99),
    )
    state.battlers[0]!.mon.statStages[6] = 0

    // Turn 1
    executeTurn(state, [useMove(1, MOVE_FLY), null], deps(fixedDamage(10)))
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(true)

    // Turn 2: misses
    const out2 = executeTurn(state, [useMove(1, MOVE_FLY), null], deps(fixedDamage(10)))
    const act0 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act0.missed).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(false)
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)
  })

  it('Protect on turn 2 blocks Fly and clears STATUS3_ON_AIR via cancelMultiTurnMoves', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_FLY', null, null, null], pp: [15, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_PROTECT', null, null, null], pp: [10, 0, 0, 0] },
      ],
      countingRng(),
    )

    // Turn 1: charge
    executeTurn(state, [useMove(1, MOVE_FLY), null], deps(fixedDamage(10)))
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(true)

    // Turn 2: battler 1 uses Protect (+4 priority)
    const protect = useMove(0, MOVE_PROTECT)
    protect.chosenMove = { ...protect.chosenMove!, priority: 4 }
    protect.moveToBeUsed = protect.chosenMove
    const out2 = executeTurn(state, [useMove(1, MOVE_FLY), protect], deps(fixedDamage(10)))
    const act0 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act0.missed).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_ON_AIR)).toBe(false)
    expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_MULTIPLETURNS)).toBe(false)
    expect(state.battlers[0]!.mon.pp[0]).toBe(14)
  })
})

describe('EFFECT_SEMI_INVULNERABLE execution: Dig, Dive, and Phantom Force', () => {
  it('Dig sets STATUS3_UNDERGROUND on turn 1; Tackle misses but Earthquake hits underground target', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_DIG', null, null, null], pp: [10, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      ],
      countingRng(),
    )

    const out = executeTurn(state, [useMove(1, MOVE_DIG), useMove(0, MOVE_TACKLE)], deps(fixedDamage(10)))
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_UNDERGROUND)).toBe(true)
    const act1 = out.actions.find((a) => a.battlerId === 1)!
    expect(act1.missed).toBe(true)

    // Earthquake can hit underground target
    const eqState = battle(
      [
        { spe: 100, moves: ['MOVE_DIG', null, null, null], pp: [10, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_EARTHQUAKE', null, null, null], pp: [10, 0, 0, 0] },
      ],
      countingRng(),
    )
    const eqOut = executeTurn(eqState, [useMove(1, MOVE_DIG), useMove(0, MOVE_EARTHQUAKE)], deps(fixedDamage(15)))
    const eqAct1 = eqOut.actions.find((a) => a.battlerId === 1)!
    expect(eqAct1.missed).toBe(false)
    expect(eqState.battlers[0]!.mon.hp).toBe(85)
  })

  it('Dive sets STATUS3_UNDERWATER on turn 1; Tackle misses but Surf hits underwater target', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_DIVE', null, null, null], pp: [10, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      ],
      countingRng(),
    )

    const out = executeTurn(state, [useMove(1, MOVE_DIVE), useMove(0, MOVE_TACKLE)], deps(fixedDamage(10)))
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_UNDERWATER)).toBe(true)
    const act1 = out.actions.find((a) => a.battlerId === 1)!
    expect(act1.missed).toBe(true)

    // Surf can hit underwater target
    const surfState = battle(
      [
        { spe: 100, moves: ['MOVE_DIVE', null, null, null], pp: [10, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_SURF', null, null, null], pp: [15, 0, 0, 0] },
      ],
      countingRng(),
    )
    const surfOut = executeTurn(surfState, [useMove(1, MOVE_DIVE), useMove(0, MOVE_SURF)], deps(fixedDamage(15)))
    const surfAct1 = surfOut.actions.find((a) => a.battlerId === 1)!
    expect(surfAct1.missed).toBe(false)
    expect(surfState.battlers[0]!.mon.hp).toBe(85)
  })

  it('Phantom Force sets STATUS3_PHANTOM_FORCE on turn 1 and strikes on turn 2', () => {
    const state = battle(
      [
        { spe: 100, moves: ['MOVE_PHANTOM_FORCE', null, null, null], pp: [10, 0, 0, 0] },
        { spe: 50, moves: ['MOVE_TACKLE', null, null, null], pp: [35, 0, 0, 0] },
      ],
      countingRng(),
    )

    // Turn 1
    const out1 = executeTurn(state, [useMove(1, MOVE_PHANTOM_FORCE), useMove(0, MOVE_TACKLE)], deps(fixedDamage(10)))
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PHANTOM_FORCE)).toBe(true)
    const act1 = out1.actions.find((a) => a.battlerId === 1)!
    expect(act1.missed).toBe(true)

    // Turn 2
    const out2 = executeTurn(state, [useMove(1, MOVE_PHANTOM_FORCE), null], deps(fixedDamage(20)))
    const act0 = out2.actions.find((a) => a.battlerId === 0)!
    expect(act0.missed).toBe(false)
    expect(act0.targetDamage).toBe(20)
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_PHANTOM_FORCE)).toBe(false)
  })
})

describe('Slow Start (ABILITY_SLOW_START / ABILITY_LETHARGY)', () => {
  it('switch-in initializes slowStartTimer to 5, end-turn decrements it, and bridge derives it with no gap', () => {
    const state = battle(
      [
        {
          spe: 100,
          abilities: { ability: 'ABILITY_SLOW_START', innates: [null, null, null] },
        },
        { spe: 50 },
      ],
      countingRng(),
    )

    // Apply battle start pass (runs switch-in abilities)
    applyBattleStartPass(state, { grounding: GROUNDING, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }, [])
    expect(state.battlers[0]!.volatiles.slowStartTimer).toBe(5)

    // Bridge sees slowStartTimer: 5 and does NOT gap it
    const { battler: bridgeInitial, gaps: gapsInitial } = buildBattlerBattleState(state, 0, ROLES, BRIDGE_DEPS)
    expect(bridgeInitial.slowStartTimer).toBe(5)
    expect(gapsInitial.some((g) => g.field === 'slowStartTimer')).toBe(false)

    // Turn 1 executes -> endTurn decrements slowStartTimer to 4
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.volatiles.slowStartTimer).toBe(4)

    // Turn 2 -> 3
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.volatiles.slowStartTimer).toBe(3)

    // Turn 3 -> 2
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.volatiles.slowStartTimer).toBe(2)

    // Turn 4 -> 1
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.volatiles.slowStartTimer).toBe(1)

    // Turn 5 -> 0
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.volatiles.slowStartTimer).toBe(0)

    // Turn 6: stays 0
    executeTurn(state, [useMove(1, MOVE_TACKLE), null], deps(fixedDamage(10)))
    expect(state.battlers[0]!.volatiles.slowStartTimer).toBe(0)
  })

  it('ABILITY_LETHARGY initializes slowStartTimer to 5 on switch-in', () => {
    const state = battle(
      [
        {
          spe: 100,
          abilities: { ability: 'ABILITY_LETHARGY', innates: [null, null, null] },
        },
        { spe: 50 },
      ],
      countingRng(),
    )

    applyBattleStartPass(state, { grounding: GROUNDING, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }, [])
    expect(state.battlers[0]!.volatiles.slowStartTimer).toBe(5)
  })
})
