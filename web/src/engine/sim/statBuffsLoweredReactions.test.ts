// Unit tests for stat-lowered reactions (Defiant / Competitive family) and Eject Pack (cycle 47).
//
// Hand-derived from upstream C sources at pinned SHA:
// - battle_util.c:1222-1255: PrepareStringBattle on STRINGID_DEFENDERSSTATFELL
//   with GetBattlerSide(changedStatsBattlerId) != GetBattlerSide(gBattlerTarget)
//   calling onStatLowered for target, then partner, gated by IsApplyOnFlagAppropriate
// - battle_script_commands.c:9875-9893: Eject Pack switch condition
// - battle_util.c:8387-8397: IsUnnerveAbilityOnOpposingSide
// - battle_util.c:8414-8422: CanRaiseStat
// - src/abilities.cc: all 11 onStatLowered hooks

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
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import {
  DEFAULT_STAT_STAGE,
  MAX_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STAT_SPDEF,
} from './constants'
import {
  canRaiseStat,
  dispatchOnStatLowered,
  isUnnerveAbilityOnOpposingSide,
} from './statBuffs'
import { applyBattleStartPass, type BattleStartDeps } from './switchInAbility'
import type { HazardDeps } from './hazards'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
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
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
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
    pp: [30, 0, 0, 0],
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

function battle(
  specs: {
    spe?: number
    atk?: number
    def?: number
    spatk?: number
    spdef?: number
    hp?: number
    maxHp?: number
    itemId?: string | null
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    statStages?: number[]
  }[],
  rng: RandomSource = scriptedRng(),
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: {
            atk: s.atk ?? 100,
            def: s.def ?? 90,
            spatk: s.spatk ?? 80,
            spdef: s.spdef ?? 85,
            spe: s.spe ?? (i === 0 ? 100 : 50),
          },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          itemId: s.itemId ?? null,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ?? [30, 0, 0, 0],
          statStages: s.statStages ?? [],
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return 0
    },
  }
  return r
}

function dummyDamage(): DamageResolver & { calls: number } {
  const r = {
    calls: 0,
    resolve: () => {
      r.calls++
      return { targetDamage: null, attackerDamage: null, unmodelled: [] }
    },
  }
  return r
}

function makeDeps(damage: DamageResolver = dummyDamage(), holdEffects: Record<number, string> = {}): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: {
      ...GROUNDING,
      holdEffectOf: (battlerId: number) => holdEffects[battlerId] ?? null,
    },
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
  }
}

function makeStartDeps(holdEffects: Record<number, string> = {}): BattleStartDeps & HazardDeps {
  return {
    grounding: {
      ...GROUNDING,
      holdEffectOf: (battlerId: number) => holdEffects[battlerId] ?? null,
    },
    dataContext: DATA_CONTEXT,
    statStageRatios: RATIOS,
  }
}

function buildMoveAction(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: 0,
    effect: move.effect,
    isStatus: move.split === 'STATUS',
    resolvedType: move.type ?? 'NORMAL',
    power: move.power,
    flags: move.flags,
    split: move.split ?? 'STATUS',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

const MOVE_SHELL_SMASH = requireMove('MOVE_SHELL_SMASH')

describe('cycle 47: stat-lowered reactions and Eject Pack', () => {
  // Test 1: Intimidate (or Screech) vs Defiant -> Atk -1 then +2 (net +1)
  it('Intimidate against Defiant: Atk lowers by 1 then Defiant raises Atk +2 (net +1, stage 7)', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
      { abilities: { ability: requireAbility('ABILITY_DEFIANT'), innates: [null, null, null] }, spe: 50 },
    ])
    const unmodelled: string[] = []
    applyBattleStartPass(state, makeStartDeps(), unmodelled)

    // Stage started at 6 (DEFAULT_STAT_STAGE). -1 from Intimidate, +2 from Defiant => 7
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(unmodelled).toEqual([])
  })

  // Test 2: Competitive -> SpAtk +2
  it('Intimidate against Competitive: Atk lowers by 1 and Competitive raises SpAtk +2 (stage 8)', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
      { abilities: { ability: requireAbility('ABILITY_COMPETITIVE'), innates: [null, null, null] }, spe: 50 },
    ])
    const unmodelled: string[] = []
    applyBattleStartPass(state, makeStartDeps(), unmodelled)

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(unmodelled).toEqual([])
  })

  // Test 3: the raised stat already at +6 -- CanRaiseStat fails, nothing happens
  it('Competitive at SpAtk +6: the reaction does nothing', () => {
    const state = battle([{ spe: 100 }, { abilities: { ability: requireAbility('ABILITY_COMPETITIVE'), innates: [null, null, null] }, spe: 50 }])
    state.battlers[1]!.mon.statStages[STAT_SPATK] = MAX_STAT_STAGE
    const unmodelled: string[] = []
    const statChanges: { battlerId: number; stat: number; change: number }[] = []

    expect(dispatchOnStatLowered(state, 1, 0, makeDeps(), unmodelled, statChanges)).toBe(false)
    expect(statChanges).toEqual([])
    expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(MAX_STAT_STAGE)
  })

  // Test 4: Self-inflicted drop (Shell Smash, affectsUser) does not trigger Defiant
  it('Self-inflicted drop (Shell Smash) does not trigger Defiant', () => {
    const state = battle([
      {
        moves: ['MOVE_SHELL_SMASH', null, null, null],
        abilities: { ability: requireAbility('ABILITY_DEFIANT'), innates: [null, null, null] },
        spe: 100,
      },
      { spe: 50 },
    ])
    const out = executeTurn(state, [buildMoveAction(0, MOVE_SHELL_SMASH), null], makeDeps())
    const action = out.actions.find((a) => a.battlerId === 0)!

    // Shell Smash lowers Def and SpDef by 1, and raises Atk, SpAtk, Speed by 2.
    // Defiant must NOT add extra Atk +2 for the self Def/SpDef drops.
    expect(action.statChanges).toEqual([
      { battlerId: 0, stat: STAT_DEF, change: -1 },
      { battlerId: 0, stat: STAT_SPDEF, change: -1 },
      { battlerId: 0, stat: STAT_ATK, change: 2 },
      { battlerId: 0, stat: STAT_SPATK, change: 2 },
      { battlerId: 0, stat: STAT_SPEED, change: 2 },
    ])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  // Test 5: Same-side drop does not trigger Defiant
  it('Same-side drop does not trigger Defiant', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_DEFIANT'), innates: [null, null, null] } },
      { spe: 50 },
      { spe: 100 },
      { spe: 50 },
    ])
    state.battlersCount = 4
    const unmodelled: string[] = []
    const statChanges: { battlerId: number; stat: number; change: number }[] = []

    // Ally battler 2 lowers partner battler 0's stat (both side 0)
    const triggered = dispatchOnStatLowered(state, 0, 2, makeDeps(), unmodelled, statChanges)
    expect(triggered).toBe(false)
    expect(statChanges).toEqual([])
    expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  // Test 6: C quirk. SetMoveEffect always calls BattleScript_StatDown (battle_script_commands.c:2779), which
  // prints gStatDownStringIds[chooser]. Contrary turns Intimidate's -1 into +1 and leaves chooser =
  // B_MSG_DEFENDER_STAT_ROSE (1), which indexes STRINGID_DEFENDERSSTATFELL, so Defiant still fires
  // (battle_util.c:1222). CanRaiseStat under Contrary passes (stage 7 > 0) and Contrary turns its +2 into -2.
  it('Contrary + Defiant: Intimidate raises Atk +1, then Defiant fires and Contrary turns its +2 into -2', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
      {
        abilities: {
          ability: requireAbility('ABILITY_DEFIANT'),
          innates: [requireAbility('ABILITY_CONTRARY'), null, null],
        },
        spe: 50,
      },
    ])
    const unmodelled: string[] = []
    applyBattleStartPass(state, makeStartDeps(), unmodelled)

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 1 - 2)
  })

  // Test 7: Run Away Speed +2
  it('Run Away: stat drop triggers Speed +2 (stage 8)', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
      { abilities: { ability: requireAbility('ABILITY_RUN_AWAY'), innates: [null, null, null] }, spe: 50 },
    ])
    const unmodelled: string[] = []
    applyBattleStartPass(state, makeStartDeps(), unmodelled)

    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 2)
  })

  // Test 8: King's Wrath (two-stat ability: Def +1 then Atk +1)
  it("King's Wrath: stat drop triggers Def +1 then Atk +1", () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
      { abilities: { ability: requireAbility('ABILITY_KINGS_WRATH'), innates: [null, null, null] }, spe: 50 },
    ])
    const unmodelled: string[] = []
    applyBattleStartPass(state, makeStartDeps(), unmodelled)

    // Intimidate lowered Atk to 5. King's Wrath raises Def +1 (stage 7) then Atk +1 (stage 6).
    expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
  })

  // Test 9: Eject Pack
  it('Eject Pack: gap recorded when no opposing Unnerve; suppressed when opposing side has Unnerve', () => {
    // 9a: No Unnerve -> gap pushed
    {
      const state = battle([
        { abilities: { ability: requireAbility('ABILITY_INTIMIDATE'), innates: [null, null, null] }, spe: 100 },
        { spe: 50, itemId: 'ITEM_EJECT_PACK' },
      ])
      const unmodelled: string[] = []
      applyBattleStartPass(state, makeStartDeps({ 1: 'HOLD_EFFECT_EJECT_PACK' }), unmodelled)

      expect(unmodelled.some((m) => m.includes('Eject Pack switch trigger'))).toBe(true)
    }

    // 9b: Opposing side has Unnerve -> Eject Pack suppressed, gap NOT pushed
    {
      const state = battle([
        {
          abilities: {
            ability: requireAbility('ABILITY_INTIMIDATE'),
            innates: [requireAbility('ABILITY_UNNERVE'), null, null],
          },
          spe: 100,
        },
        { spe: 50, itemId: 'ITEM_EJECT_PACK' },
      ])
      const unmodelled: string[] = []
      applyBattleStartPass(state, makeStartDeps({ 1: 'HOLD_EFFECT_EJECT_PACK' }), unmodelled)

      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(unmodelled.some((m) => m.includes('Eject Pack switch trigger'))).toBe(false)
    }
  })

  // Additional coverage: ally triggering for APPLY_ON_ALLY in doubles
  it("APPLY_ON_ALLY (Queen's Mourning): partner stat drop triggers SpDef +1 and SpAtk +1 on ally", () => {
    const state = battle([
      { abilities: { ability: null, innates: [null, null, null] }, spe: 100 },
      { abilities: { ability: null, innates: [null, null, null] }, spe: 50 },
      { abilities: { ability: requireAbility('ABILITY_QUEENS_MOURNING'), innates: [null, null, null] }, spe: 100 },
      { abilities: { ability: null, innates: [null, null, null] }, spe: 50 },
    ])
    state.battlersCount = 4
    const unmodelled: string[] = []
    const statChanges: { battlerId: number; stat: number; change: number }[] = []

    // Opponent 1 (side 1) lowers battler 0's (side 0) stat.
    // Partner 2 (side 0) holds Queen's Mourning with APPLY_ON_ALLY.
    const triggered = dispatchOnStatLowered(state, 0, 1, makeDeps(), unmodelled, statChanges)
    expect(triggered).toBe(true)
    expect(statChanges).toEqual([
      { battlerId: 2, stat: STAT_SPDEF, change: 1 },
      { battlerId: 2, stat: STAT_SPATK, change: 1 },
    ])
    expect(state.battlers[2]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[2]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  // Coverage for canRaiseStat and isUnnerveAbilityOnOpposingSide helper functions directly
  it('canRaiseStat and isUnnerveAbilityOnOpposingSide direct helper behavior', () => {
    const state = battle([
      { abilities: { ability: requireAbility('ABILITY_UNNERVE'), innates: [null, null, null] }, spe: 100 },
      { abilities: { ability: null, innates: [null, null, null] }, spe: 50 },
    ])

    expect(isUnnerveAbilityOnOpposingSide(state, 1, DATA_CONTEXT)).toBe(true)
    expect(isUnnerveAbilityOnOpposingSide(state, 0, DATA_CONTEXT)).toBe(false)

    expect(canRaiseStat(state, 1, STAT_ATK, DATA_CONTEXT)).toBe(true)
    state.battlers[1]!.mon.statStages[STAT_ATK] = MAX_STAT_STAGE
    expect(canRaiseStat(state, 1, STAT_ATK, DATA_CONTEXT)).toBe(false)
  })
})
