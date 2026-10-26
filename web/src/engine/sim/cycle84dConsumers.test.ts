// Tests for cycle 84d consumers and readers: state written by cycle 84 that previously
// had no readers, plus fixes to cycle 84 move effects.
//
// Every expected value is hand-derived directly from C source lines in
// pipeline/.upstream/eliteredux-source/src/ and data/battle_scripts_1.s.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT, getBattlerTotalSpeedStat, TOTAL_SPEED_FULL } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { runEndTurnEffects } from './endTurn'
import { runAttackCanceller } from './attackCanceller'
import { canBattlerEscape } from './escape'
import { getMoveEffectChance } from './statusEffects'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import type { ConditionBattlerContext, DamageContext } from '../types'
import type { MoveBehaviors } from '../basePower'
import { calcMoveBasePowerAfterModifiers, type BasePowerModifierContext } from '../basePower'
import { battlerFear } from './unpack'
import {
  DEFAULT_STAT_STAGE,
  MIN_STAT_STAGE,
  STAT_ACC,
  STAT_DEF,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS3_GASTRO_ACID,
  STATUS3_LEECHSEED,
  STATUS4_FEAR,
  STATUS4_SALT_CURE,
  hasFlag,
} from './constants'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const rawItems = snapshot<Array<SimItemData>>('items.json')
const itemsById = new Map(rawItems.map((item) => [item.id, item]))
const typeChart = snapshot<TypeChart>('types.json')
const inverseTypeChart = snapshot<TypeChart>('typesInverse.json')
const rawBehaviors = snapshot<{ behaviors: MoveBehaviors }>('moveBehaviors.json')
const moveBehaviors = rawBehaviors.behaviors

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
    customBehavior: (m.customBehavior ?? null) as SimMoveData['customBehavior'],
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

function battle(
  specs: {
    spe?: number
    atk?: number
    def?: number
    spatk?: number
    spdef?: number
    hp?: number
    maxHp?: number
    speciesId?: string
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    pp?: SimBattleMon['pp']
    types?: [string, string, string]
    itemId?: string | null
    gender?: SimBattleMon['gender']
    status1?: number
    status2?: number
  }[],
  rng: RandomSource = countingRng(),
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          speciesId: s.speciesId ?? 'SPECIES_MUDKIP',
          rawStats: {
            atk: s.atk ?? 100,
            def: s.def ?? 90,
            spatk: s.spatk ?? 80,
            spdef: s.spdef ?? 85,
            spe: s.spe ?? (i === 0 ? 100 : 50),
          },
          hp: s.hp ?? (s.maxHp ?? 100),
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          pp: s.pp ? ([...s.pp] as SimBattleMon['pp']) : [35, 0, 0, 0],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
          gender: s.gender ?? 'MALE',
          status1: s.status1 ?? 0,
          status2: s.status2 ?? 0,
        }),
        0,
      ),
    ),
    rng,
  })
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

function testDeps(
  damage: DamageResolver = fixedDamage(20),
  replacement?: ReplacementDeps,
  grounding: GroundingContext = GROUNDING,
): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding,
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    replacement,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
    moveBehaviors,
  }
}

const move = (id: string): SimMoveData => requireMove(id)
const slot = (...ids: string[]): SimBattleMon['moves'] => [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
const pps: SimBattleMon['pp'] = [20, 20, 0, 0]
const hasAbility = (ability: string) => ({ ability, innates: [null, null, null] as [null, null, null] })

// =============================================================================
// 1. ENDTURN_SEA_OF_FIRE_DAMAGE (battle_util.c:2545-2562)
// =============================================================================
describe('ENDTURN_SEA_OF_FIRE_DAMAGE (battle_util.c:2545-2562)', () => {
  it('deals floor(maxHP / 8) damage to non-Fire battler when side fireSeaTimer > 0', () => {
    // maxHP = 120 -> 120 / 8 = 15 damage. HP: 120 -> 105.
    const state = battle([{ maxHp: 120, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    state.sides[0].timers.fireSeaTimer = 3
    const out = executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(105)
    expect(out.endTurn).toContainEqual({
      battlerId: 0,
      effect: 'SEA_OF_FIRE',
      hpChange: -15,
      fainted: false,
    })
  })

  it('clamps damage to minimum 1 when maxHP / 8 rounds to 0', () => {
    // maxHP = 5 -> floor(5 / 8) = 0 -> clamped to 1. HP: 5 -> 4.
    const state = battle([{ maxHp: 5, hp: 5, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    state.sides[0].timers.fireSeaTimer = 2
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(4)
  })

  it('does NOT deal damage to Fire-type battler', () => {
    // IS_BATTLER_OF_TYPE(i, TYPE_FIRE) immune (:2548)
    const state = battle([{ maxHp: 100, types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    state.sides[0].timers.fireSeaTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('does NOT deal damage to battler with Magic Guard', () => {
    // !IsMagicGuardProtected(i) (:2549)
    const state = battle([
      { maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'], abilities: hasAbility('ABILITY_MAGIC_GUARD') },
      { maxHp: 100 },
    ])
    state.sides[0].timers.fireSeaTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('does NOT deal damage to battler with Flare Boost', () => {
    // !IsFlareBoostProtected(i) (:2550)
    const state = battle([
      { maxHp: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'], abilities: hasAbility('ABILITY_FLARE_BOOST') },
      { maxHp: 100 },
    ])
    state.sides[0].timers.fireSeaTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('does NOT deal damage when fireSeaTimer is 0', () => {
    const state = battle([{ maxHp: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    state.sides[0].timers.fireSeaTimer = 0
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('only affects battlers on the side that has fireSeaTimer > 0', () => {
    const state = battle([
      { maxHp: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
      { maxHp: 100, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
    ])
    // Opponent side 1 has fireSeaTimer, side 0 does not
    state.sides[1].timers.fireSeaTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(100)
    // 100 / 8 = 12 damage to battler 1
    expect(state.battlers[1]!.mon.hp).toBe(88)
  })
})

// =============================================================================
// 2. ENDTURN_SYRUP (battle_util.c:2444-2450) + BattleScript_SyrupDropsSpeed
// =============================================================================
describe('ENDTURN_SYRUP (battle_util.c:2444-2450)', () => {
  it('decrements syrupTimer and drops Speed stage by 1', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.syrupTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.syrupTimer).toBe(2)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('decrements syrupTimer from 1 to 0 and drops Speed stage', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.syrupTimer = 1
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.syrupTimer).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('blocks Speed drop when battler has Clear Body ability', () => {
    const state = battle([
      { spe: 100, abilities: hasAbility('ABILITY_CLEAR_BODY') },
      { spe: 50 },
    ])
    state.battlers[0]!.volatiles.syrupTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.syrupTimer).toBe(2)
    // Stat drop blocked by Clear Body
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })

  it('does not block Speed drop when battler holds Clear Amulet (MOVE_EFFECT_AFFECTS_USER drop)', () => {
    // BattleScript_SyrupDropsSpeed (data/battle_scripts_1.s:8226) calls statbuffchange with
    // MOVE_EFFECT_AFFECTS_USER; ChangeStatBuffs (battle_script_commands.c:9827) requires !affectsUser
    // to block with HOLD_EFFECT_CLEAR_AMULET. Thus Clear Amulet does not protect against self-inflicted drops.
    const state = battle([
      { spe: 100, itemId: 'ITEM_CLEAR_AMULET' },
      { spe: 50 },
    ])
    state.battlers[0]!.volatiles.syrupTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.syrupTimer).toBe(2)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('raises Speed by 1 when battler has Contrary ability', () => {
    const state = battle([
      { spe: 100, abilities: hasAbility('ABILITY_CONTRARY') },
      { spe: 50 },
    ])
    state.battlers[0]!.volatiles.syrupTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.syrupTimer).toBe(2)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('drops Speed by 2 stages when battler has Simple ability', () => {
    const state = battle([
      { spe: 100, abilities: hasAbility('ABILITY_SIMPLE') },
      { spe: 50 },
    ])
    state.battlers[0]!.volatiles.syrupTimer = 3
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.syrupTimer).toBe(2)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 2)
  })

  it('clamps Speed at MIN_STAT_STAGE (0) when already at minimum', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.syrupTimer = 2
    state.battlers[0]!.mon.statStages[STAT_SPEED] = MIN_STAT_STAGE
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.syrupTimer).toBe(1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(MIN_STAT_STAGE)
  })

  it('does nothing when syrupTimer is 0', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.syrupTimer = 0
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.syrupTimer).toBe(0)
    expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
  })
})

// =============================================================================
// 3. ENDTURN_SALT_CURE (battle_util.c:2634-2648)
// =============================================================================
describe('ENDTURN_SALT_CURE (battle_util.c:2634-2648)', () => {
  it('deals maxHP / 8 damage to non-Water, non-Steel battler with STATUS4_SALT_CURE', () => {
    // maxHP = 120 -> 120 / 8 = 15 damage. HP: 120 -> 105.
    const state = battle([{ maxHp: 120, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    state.battlers[0]!.statuses4 |= STATUS4_SALT_CURE
    const out = executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(105)
    expect(out.endTurn).toContainEqual({
      battlerId: 0,
      effect: 'SALT_CURE',
      hpChange: -15,
      fainted: false,
    })
  })

  it('deals maxHP / 4 damage to Water-type battler with STATUS4_SALT_CURE', () => {
    // maxHP = 120 -> 120 / 4 = 30 damage. HP: 120 -> 90.
    const state = battle([{ maxHp: 120, types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    state.battlers[0]!.statuses4 |= STATUS4_SALT_CURE
    const out = executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(90)
    expect(out.endTurn).toContainEqual({
      battlerId: 0,
      effect: 'SALT_CURE',
      hpChange: -30,
      fainted: false,
    })
  })

  it('deals maxHP / 4 damage to Steel-type battler with STATUS4_SALT_CURE', () => {
    // maxHP = 120 -> 120 / 4 = 30 damage. HP: 120 -> 90.
    const state = battle([{ maxHp: 120, types: ['STEEL', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    state.battlers[0]!.statuses4 |= STATUS4_SALT_CURE
    const out = executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(90)
    expect(out.endTurn).toContainEqual({
      battlerId: 0,
      effect: 'SALT_CURE',
      hpChange: -30,
      fainted: false,
    })
  })

  it('deals maxHP / 4 damage to Water/Steel dual-type battler with STATUS4_SALT_CURE', () => {
    // Either Water or Steel triggers the 1/4 rate (does not stack to 1/2).
    // maxHP = 120 -> 120 / 4 = 30 damage. HP: 120 -> 90.
    const state = battle([{ maxHp: 120, types: ['WATER', 'STEEL', 'MYSTERY'] }, { maxHp: 100 }])
    state.battlers[0]!.statuses4 |= STATUS4_SALT_CURE
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(90)
  })

  it('clamps damage to minimum 1 when maxHP / 8 rounds to 0', () => {
    // maxHP = 5 -> floor(5 / 8) = 0 -> clamped to 1. HP: 5 -> 4.
    const state = battle([{ maxHp: 5, hp: 5, types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    state.battlers[0]!.statuses4 |= STATUS4_SALT_CURE
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(4)
  })

  it('does NOT deal damage to battler with Magic Guard', () => {
    // !IsMagicGuardProtected(i) (:2636)
    const state = battle([
      { maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'], abilities: hasAbility('ABILITY_MAGIC_GUARD') },
      { maxHp: 100 },
    ])
    state.battlers[0]!.statuses4 |= STATUS4_SALT_CURE
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('does NOT deal damage when STATUS4_SALT_CURE bit is not set', () => {
    const state = battle([{ maxHp: 100, types: ['WATER', 'MYSTERY', 'MYSTERY'] }, { maxHp: 100 }])
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })
})

// =============================================================================
// 4. ENDTURN_OCTOLOCK (battle_util.c:2708-2716) + BattleScript_OctolockEndTurn
// =============================================================================
describe('ENDTURN_OCTOLOCK (battle_util.c:2708-2716)', () => {
  it('drops target Def and SpDef by 1 stage when octolock is true', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.octolock = true
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE - 1)
  })

  it('blocks both Def and SpDef drops when holding Clear Amulet', () => {
    const state = battle([{ spe: 100, itemId: 'ITEM_CLEAR_AMULET' }, { spe: 50 }])
    state.battlers[0]!.volatiles.octolock = true
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('blocks both Def and SpDef drops with Clear Body ability', () => {
    const state = battle([
      { spe: 100, abilities: hasAbility('ABILITY_CLEAR_BODY') },
      { spe: 50 },
    ])
    state.battlers[0]!.volatiles.octolock = true
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
  })

  it('raises both Def and SpDef by 1 stage with Contrary ability', () => {
    const state = battle([
      { spe: 100, abilities: hasAbility('ABILITY_CONTRARY') },
      { spe: 50 },
    ])
    state.battlers[0]!.volatiles.octolock = true
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE + 1)
  })

  it('drops both Def and SpDef by 2 stages with Simple ability', () => {
    const state = battle([
      { spe: 100, abilities: hasAbility('ABILITY_SIMPLE') },
      { spe: 50 },
    ])
    state.battlers[0]!.volatiles.octolock = true
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 2)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE - 2)
  })

  it('does nothing when octolock is false', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.octolock = false
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE)
  })
})

// =============================================================================
// 5. ENDTURN_THROAT_CHOP (battle_util.c:2923-2929)
// =============================================================================
describe('ENDTURN_THROAT_CHOP (battle_util.c:2923-2929)', () => {
  it('decrements throatChopTimer from 2 to 1', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.throatChopTimer = 2
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.throatChopTimer).toBe(1)
  })

  it('decrements throatChopTimer from 1 to 0', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.throatChopTimer = 1
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.throatChopTimer).toBe(0)
  })

  it('leaves throatChopTimer at 0 when already 0', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.throatChopTimer = 0
    executeTurn(state, [null, null], testDeps())
    expect(state.battlers[0]!.volatiles.throatChopTimer).toBe(0)
  })
})

// =============================================================================
// 6. CANCELLER_THROAT_CHOP (battle_util.c:3481-3490)
// =============================================================================
describe('CANCELLER_THROAT_CHOP (battle_util.c:3481-3490)', () => {
  it('cancels sound moves when throatChopTimer > 0', () => {
    const state = battle([
      { moves: slot('MOVE_HYPER_VOICE'), pp: pps, spe: 100 },
      { moves: slot('MOVE_TACKLE'), pp: pps, spe: 50 },
    ])
    state.battlers[0]!.volatiles.throatChopTimer = 1
    const unmodelled: string[] = []
    const cancelRes = runAttackCanceller(
      state,
      0,
      1,
      'MOVE_HYPER_VOICE',
      requireMove('MOVE_HYPER_VOICE'),
      unmodelled,
      null,
      GROUNDING,
      null,
      DATA_CONTEXT,
    )
    expect(cancelRes.cancelledBy).toBe('THROAT_CHOP')
    expect(state.battlers[0]!.round.usedThroatChopPreventedMove).toBe(true)
  })

  it('does NOT cancel non-sound moves even when throatChopTimer > 0', () => {
    const state = battle([
      { moves: slot('MOVE_TACKLE'), pp: pps, spe: 100 },
      { moves: slot('MOVE_TACKLE'), pp: pps, spe: 50 },
    ])
    state.battlers[0]!.volatiles.throatChopTimer = 1
    const unmodelled: string[] = []
    const cancelRes = runAttackCanceller(
      state,
      0,
      1,
      'MOVE_TACKLE',
      requireMove('MOVE_TACKLE'),
      unmodelled,
      null,
      GROUNDING,
      null,
      DATA_CONTEXT,
    )
    expect(cancelRes.cancelledBy).toBeNull()
  })

  it('does NOT cancel sound moves when throatChopTimer is 0', () => {
    const state = battle([
      { moves: slot('MOVE_HYPER_VOICE'), pp: pps, spe: 100 },
      { moves: slot('MOVE_TACKLE'), pp: pps, spe: 50 },
    ])
    state.battlers[0]!.volatiles.throatChopTimer = 0
    const unmodelled: string[] = []
    const cancelRes = runAttackCanceller(
      state,
      0,
      1,
      'MOVE_HYPER_VOICE',
      requireMove('MOVE_HYPER_VOICE'),
      unmodelled,
      null,
      GROUNDING,
      null,
      DATA_CONTEXT,
    )
    expect(cancelRes.cancelledBy).toBeNull()
  })

  it('cancels sound moves within executeTurn and prevents damage', () => {
    const state = battle([
      { moves: slot('MOVE_HYPER_VOICE'), pp: pps, spe: 100 },
      { moves: slot('MOVE_TACKLE'), pp: pps, spe: 50 },
    ])
    state.battlers[0]!.volatiles.throatChopTimer = 2
    const res = executeTurn(state, [useMove(1, move('MOVE_HYPER_VOICE')), null], testDeps())
    expect(res.actions[0]?.cancelledBy).toBe('THROAT_CHOP')
    expect(state.battlers[1]!.mon.hp).toBe(100)
    // End-turn decrements throatChopTimer from 2 to 1
    expect(state.battlers[0]!.volatiles.throatChopTimer).toBe(1)
  })
})

// =============================================================================
// 7. Side timers: rainbowTimer and swampTimer
// =============================================================================
describe('Side-timer readers: rainbowTimer and swampTimer', () => {
  it('rainbowTimer doubles secondary effect chance capped at 100 (battle_script_commands.c:3087)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    const statusDeps = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

    // Base chance 30% -> without Rainbow: 30%
    const baseChance = getMoveEffectChance(state, 0, 'MOVE_FLAMETHROWER', 2, 30, statusDeps)
    expect(baseChance).toBe(30)

    // With Rainbow timer: 30 * 2 = 60%
    state.sides[0].timers.rainbowTimer = 3
    const rainbowChance = getMoveEffectChance(state, 0, 'MOVE_FLAMETHROWER', 2, 30, statusDeps)
    expect(rainbowChance).toBe(60)

    // With Rainbow timer and 60% base: 60 * 2 = 120 -> capped at 100%
    const cappedChance = getMoveEffectChance(state, 0, 'MOVE_FLAMETHROWER', 2, 60, statusDeps)
    expect(cappedChance).toBe(100)
  })

  it('swampTimer divides grounded battler speed by 1.5 (battle_main.c:4208)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.sides[0].timers.swampTimer = 3

    // Grounded battler: speed = Math.trunc(100 / 1.5) = 66
    const groundedCtx = {
      ...NEUTRAL_TURN_ORDER_CONTEXT,
      isBattlerGrounded: () => true,
    }
    const groundedSpeed = getBattlerTotalSpeedStat(state, 0, TOTAL_SPEED_FULL, null, groundedCtx, RATIOS)
    expect(groundedSpeed).toBe(66)

    // Airborne battler: swamp has no effect, speed remains 100
    const airborneCtx = {
      ...NEUTRAL_TURN_ORDER_CONTEXT,
      isBattlerGrounded: () => false,
    }
    const airborneSpeed = getBattlerTotalSpeedStat(state, 0, TOTAL_SPEED_FULL, null, airborneCtx, RATIOS)
    expect(airborneSpeed).toBe(100)
  })
})

// =============================================================================
// 8. Fear volatile readers (battle_util.c:2961, 4852, 7062)
// =============================================================================
describe('Fear volatile readers', () => {
  function battler(overrides: Partial<ConditionBattlerContext> = {}): ConditionBattlerContext {
    return {
      speciesId: 'SPECIES_PIKACHU',
      baseSpeciesId: 'SPECIES_PIKACHU',
      heads: 1,
      isMegaEvolved: false,
      itemId: null,
      resolvedHoldEffect: null,
      itemNegated: false,
      status1: new Set(),
      hasComatose: false,
      hasBloodStainEffect: false,
      isInfatuated: false,
      isConfused: false,
      isEnraged: false,
      wasDamagedThisTurnBy: 'none',
      recentlyFainted: false,
      hp: 100,
      maxHp: 100,
      weight: 60,
      speed: 100,
      positiveStatStageCount: 0,
      negativeStatStageCount: 0,
      usedMovePpRemaining: null,
      helpingHand: false,
      ghastlyEcho: false,
      chargedUp: false,
      meFirst: false,
      fear: false,
      safePassage: false,
      itemResolvedHoldEffectStrength: null,
      lastMoveFailed: false,
      ...overrides,
    }
  }

  function damageCtx(overrides: Partial<DamageContext> = {}): DamageContext {
    return {
      attacker: battler(),
      defender: battler(),
      field: { gravityActive: false, terrain: null, weather: 'NONE' },
      attackerActsFirst: true,
      sameMoveTurnsInARow: 0,
      defenderIsSwitching: false,
      magnitudeTier: null,
      attackerRolloutCounter: 0,
      attackerHasDefenseCurl: false,
      attackerWasHitThisTurn: false,
      beatUpBaseAttack: 80,
      beatUpHitCount: 5,
      ...overrides,
    }
  }

  function bpmCtx(overrides: Partial<BasePowerModifierContext> = {}): BasePowerModifierContext {
    return {
      ...damageCtx(),
      moveType: 'NORMAL',
      isPhysical: true,
      isSpecial: false,
      attackerHoldEffect: { resolvedHoldEffect: null, strength: null, holdEffectType: null },
      attackerIsLatiOrLatias: false,
      defenderHasUnnerve: false,
      moveDoubleDamageVsMega: false,
      moveEffect: null,
      moveArgumentStatus: null,
      ...overrides,
    }
  }

  it('clears fear at end of turn when !started.fear (battle_util.c:2961-2964)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.fear = true
    state.battlers[0]!.statuses4 |= STATUS4_FEAR
    state.battlers[0]!.volatiles.started.fear = false

    runEndTurnEffects(state, [0, 1], DATA_CONTEXT)

    expect(state.battlers[0]!.volatiles.fear).toBe(false)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FEAR)).toBe(false)
  })

  it('preserves fear at end of turn when started.fear is true (applied this turn)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[0]!.volatiles.fear = true
    state.battlers[0]!.statuses4 |= STATUS4_FEAR
    state.battlers[0]!.volatiles.started.fear = true

    runEndTurnEffects(state, [0, 1], DATA_CONTEXT)

    // Fear is preserved through the turn it was started
    expect(state.battlers[0]!.volatiles.fear).toBe(true)
    expect(hasFlag(state.battlers[0]!.statuses4, STATUS4_FEAR)).toBe(true)
  })

  it('prevents escape when volatiles.fear is true (battle_util.c:4852)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    const escapeDeps = { dataContext: DATA_CONTEXT, grounding: GROUNDING }

    expect(canBattlerEscape(state, 0, escapeDeps)).toBe(true)

    state.battlers[0]!.volatiles.fear = true
    expect(canBattlerEscape(state, 0, escapeDeps)).toBe(false)
  })

  it('boosts incoming move base power by 1.25x against fearful defender (battle_util.c:7062)', () => {
    const state = battle([{ spe: 100 }, { spe: 50 }])
    state.battlers[1]!.volatiles.fear = true

    // battlerFear unpacks volatiles.fear (unpack.ts:186)
    expect(battlerFear(state.battlers[1]!.volatiles)).toBe(true)

    // calcMoveBasePowerAfterModifiers with defender.fear = true applies 1.25x modifier
    const ctx: BasePowerModifierContext = bpmCtx({
      defender: battler({ fear: true }),
    })

    // Base power 80 * 1.25 = 100
    const boostedPower = calcMoveBasePowerAfterModifiers(80, ctx)
    expect(boostedPower).toBe(100)

    // Negative case: defender without fear: 80 * 1.0 = 80
    ctx.defender.fear = false
    const normalPower = calcMoveBasePowerAfterModifiers(80, ctx)
    expect(normalPower).toBe(80)
  })
})

// =============================================================================
// 9. Cycle 84 fixes
// =============================================================================
describe('Cycle 84 fixes', () => {
  describe('EFFECT_SAPPY_SEED (battle_scripts_1.s:1189-1194)', () => {
    it('does NOT plant Leech Seed on Grass-type target even with Mycelium Might', () => {
      // Cmd_setseeded (battle_script_commands.c:9341-9355) has no Mycelium Might gate;
      // Grass types are strictly immune to Leech Seed.
      const state = battle([
        {
          moves: slot('MOVE_SAPPY_SEED'),
          pp: pps,
          abilities: hasAbility('ABILITY_MYCELIUM_MIGHT'),
        },
        { types: ['GRASS', 'MYSTERY', 'MYSTERY'] },
      ])
      executeTurn(state, [useMove(1, move('MOVE_SAPPY_SEED')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
    })
  })

  describe('EFFECT_SNAP_JAW (battle_scripts_1.s:12415-12422)', () => {
    it('draws setrandom 2 BEFORE accuracy check: roll 0 = Speed up', () => {
      // rolls: random % 2 = 0 (user Speed up), accuracy roll = 0 (hits), effectChance roll = 0 (passes)
      const state = battle([{ moves: slot('MOVE_KILOBITE'), pp: pps }, {}], scriptedRng([0, 0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_KILOBITE')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    })

    it('draws setrandom 2 BEFORE accuracy check: roll 1 = target Speed down', () => {
      // rolls: random % 2 = 1 (target Speed down), accuracy roll = 0 (hits), effectChance roll = 0 (passes)
      const state = battle([{ moves: slot('MOVE_KILOBITE'), pp: pps }, {}], scriptedRng([1, 0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_KILOBITE')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    })

    it('accuracy check failure prevents either stat change despite setrandom draw', () => {
      // Force miss via STAT_ACC = 0 (100 * 3/9 = 33 accuracy).
      // rolls: setrandom 2 = 0 (Snap Jaw), accuracy roll = 99 (99 >= 33 misses)
      const state = battle([{ moves: slot('MOVE_KILOBITE'), pp: pps }, {}], scriptedRng([0, 99]))
      state.battlers[0]!.mon.statStages[STAT_ACC] = 0
      const res = executeTurn(state, [useMove(1, move('MOVE_KILOBITE')), null], testDeps())
      expect(res.actions[0]?.missed).toBe(true)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    })
  })

  describe('EFFECT_FLAME_BURST (battle_script_commands.c:2872-2878)', () => {
    it('deals floor(partner.hp / 4) splash damage to target partner in doubles', () => {
      // Doubles battle: battler 0 attacks battler 1. Partner of battler 1 is battler 3.
      // Partner HP = 100 -> 100 / 4 = 25 damage. Partner HP: 100 -> 75.
      const state = battle([
        { moves: slot('MOVE_FLAME_BURST'), pp: pps, spe: 100 },
        { hp: 100, maxHp: 100, spe: 50 },
        { hp: 100, maxHp: 100, spe: 50 },
        { hp: 100, maxHp: 100, spe: 50 },
      ])
      state.battlersCount = 4
      executeTurn(
        state,
        [useMove(1, move('MOVE_FLAME_BURST')), null, null, null],
        testDeps(fixedDamage(30)),
      )
      // Primary target took 30 damage
      expect(state.battlers[1]!.mon.hp).toBe(70)
      // Partner took 25 splash damage
      expect(state.battlers[3]!.mon.hp).toBe(75)
    })

    it('does NOT deal splash damage to partner with Magic Guard', () => {
      const state = battle([
        { moves: slot('MOVE_FLAME_BURST'), pp: pps, spe: 100 },
        { hp: 100, maxHp: 100, spe: 50 },
        { hp: 100, maxHp: 100, spe: 50 },
        { hp: 100, maxHp: 100, spe: 50, abilities: hasAbility('ABILITY_MAGIC_GUARD') },
      ])
      state.battlersCount = 4
      executeTurn(
        state,
        [useMove(1, move('MOVE_FLAME_BURST')), null, null, null],
        testDeps(fixedDamage(30)),
      )
      expect(state.battlers[1]!.mon.hp).toBe(70)
      expect(state.battlers[3]!.mon.hp).toBe(100)
    })

    it('executes cleanly in singles without splash error', () => {
      const state = battle([
        { moves: slot('MOVE_FLAME_BURST'), pp: pps },
        { hp: 100, maxHp: 100 },
      ])
      executeTurn(state, [useMove(1, move('MOVE_FLAME_BURST')), null], testDeps(fixedDamage(30)))
      expect(state.battlers[1]!.mon.hp).toBe(70)
    })
  })

  describe('EFFECT_CORE_ENFORCER (battle_script_commands.c:2926-2930)', () => {
    it('suppresses target ability with STATUS3_GASTRO_ACID when target has already acted', () => {
      // Target is faster (spe 150 > user 100) and acts first
      const state = battle(
        [
          { moves: slot('MOVE_CORE_ENFORCER'), pp: pps, spe: 100 },
          { moves: slot('MOVE_TACKLE'), pp: pps, spe: 150 },
        ],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_CORE_ENFORCER')), useMove(0, move('MOVE_TACKLE'))], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    })

    it('does NOT suppress ability when user moves first (target has not acted yet)', () => {
      // User is faster (spe 150 > target 50) and uses Core Enforcer first
      const state = battle(
        [
          { moves: slot('MOVE_CORE_ENFORCER'), pp: pps, spe: 150 },
          { moves: slot('MOVE_TACKLE'), pp: pps, spe: 50 },
        ],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_CORE_ENFORCER')), useMove(0, move('MOVE_TACKLE'))], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    })

    it('does NOT suppress ability when target faints from the hit', () => {
      // Target acts first, but user's Core Enforcer faints target (hp = 0)
      const state = battle(
        [
          { moves: slot('MOVE_CORE_ENFORCER'), pp: pps, spe: 100 },
          { moves: slot('MOVE_TACKLE'), pp: pps, spe: 150, hp: 20 },
        ],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_CORE_ENFORCER')), useMove(0, move('MOVE_TACKLE'))], testDeps(fixedDamage(20)))
      expect(state.battlers[1]!.mon.hp).toBe(0)
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    })
  })
})
