// Move-effect and hit-plus-effect script ports checked against C source:
// SetMoveEffect cases (battle_script_commands.c:2595-3012) and legacy scripts
// (data/battle_scripts_1.s).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import { applySecondaryMoveEffects } from './moveEffects'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { ReplacementDeps } from './switchIn'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_SPIKES,
  SIDE_STATUS_WIDE_GUARD,
  STAT_ATK,
  STAT_DEF,
  STAT_SPATK,
  STAT_SPDEF,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_BURN,
  STATUS1_PARALYSIS,
  STATUS1_POISON,
  STATUS1_SLEEP,
  STATUS2_CONFUSION,
  STATUS2_ESCAPE_PREVENTION,
  STATUS2_FLINCHED,
  STATUS3_GASTRO_ACID,
  STATUS3_HEAL_BLOCK,
  STATUS3_LEECHSEED,
  STATUS4_FEAR,
  STATUS4_SALT_CURE,
  STATUS_FIELD_GRASSY_TERRAIN,
  WEATHER_RAIN_TEMPORARY,
  WEATHER_SUN_TEMPORARY,
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
  rng: RandomSource,
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
          hp: s.hp ?? 100,
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

// -----------------------------------------------------------------------------
// Part 1: Missing SetMoveEffect cases
// -----------------------------------------------------------------------------

describe('Part 1: SetMoveEffect cases missing from SECONDARY_MOVE_EFFECT_MAP', () => {
  describe('MOVE_EFFECT_DIRE_CLAW (battle_script_commands.c:2708-2713)', () => {
    it('inflicts STATUS1_POISON when random % 3 === 0', () => {
      // rolls: acc check (0), chance check (0 < 50), random % 3 = 0 -> Poison
      const state = battle([{ moves: slot('MOVE_DIRE_CLAW'), pp: pps }, {}], scriptedRng([0, 0, 0]))
      const res = executeTurn(state, [useMove(1, move('MOVE_DIRE_CLAW')), null], testDeps())
      expect(res.actions[0]?.statusApplied?.status).toBe('POISON')
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
    })

    it('inflicts STATUS1_BLEED when random % 3 === 1', () => {
      // rolls: acc check (0), chance check (0 < 50), random % 3 = 1 -> Bleed
      const state = battle([{ moves: slot('MOVE_DIRE_CLAW'), pp: pps }, {}], scriptedRng([0, 0, 1]))
      const res = executeTurn(state, [useMove(1, move('MOVE_DIRE_CLAW')), null], testDeps())
      expect(res.actions[0]?.statusApplied?.status).toBe('BLEED')
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
    })

    it('inflicts STATUS1_PARALYSIS when random % 3 === 2', () => {
      // rolls: acc check (0), chance check (0 < 50), random % 3 = 2 -> Paralysis
      const state = battle([{ moves: slot('MOVE_DIRE_CLAW'), pp: pps }, {}], scriptedRng([0, 0, 2]))
      const res = executeTurn(state, [useMove(1, move('MOVE_DIRE_CLAW')), null], testDeps())
      expect(res.actions[0]?.statusApplied?.status).toBe('PARALYSIS')
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)).toBe(true)
    })

    it('is blocked by C gate: fails if target already has primary status1 != 0', () => {
      const state = battle([{ moves: slot('MOVE_DIRE_CLAW'), pp: pps }, { status1: STATUS1_BURN }], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_DIRE_CLAW')), null], testDeps())
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    })

    it('does not trigger if effect chance roll fails', () => {
      // rolls: acc check (0), chance check (90 >= 50 fails)
      const state = battle([{ moves: slot('MOVE_DIRE_CLAW'), pp: pps }, {}], scriptedRng([0, 90]))
      executeTurn(state, [useMove(1, move('MOVE_DIRE_CLAW')), null], testDeps())
      expect(state.battlers[1]!.mon.status1).toBe(0)
    })
  })

  describe('MOVE_EFFECT_FEAR (battle_script_commands.c:2996-3000)', () => {
    it('inflicts STATUS4_FEAR and sets volatiles.fear on hit', () => {
      // Terror Charge has secondaryEffects: MOVE_EFFECT_BLEED and MOVE_EFFECT_FEAR with chance 50
      const state = battle([{ moves: slot('MOVE_TERROR_CHARGE'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_TERROR_CHARGE')), null], testDeps())
      expect(state.battlers[1]!.volatiles.fear).toBe(true)
      expect(state.battlers[1]!.volatiles.started.fear).toBe(true)
      expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)
    })

    it('is blocked by C gate: does not re-apply if volatiles.fear is already true', () => {
      const state = battle([{ moves: slot('MOVE_TERROR_CHARGE'), pp: pps }, {}], countingRng())
      // Turn 1 applies Fear: sets fear = true and started.fear = true, preserved across turn 1 end
      executeTurn(state, [useMove(1, move('MOVE_TERROR_CHARGE')), null], testDeps())
      expect(state.battlers[1]!.volatiles.fear).toBe(true)
      expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(true)

      // Turn 2: started.fear is cleared before actions (turn.ts:654-664). Second Terror Charge is
      // blocked by C gate (!volatiles.fear) from re-applying (so started.fear remains false),
      // and Fear clears at end of the next turn (battle_util.c:2960-2964).
      executeTurn(state, [useMove(1, move('MOVE_TERROR_CHARGE')), null], testDeps())
      expect(state.battlers[1]!.volatiles.fear).toBe(false)
      expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_FEAR)).toBe(false)
    })
  })

  describe('MOVE_EFFECT_WATER_PLEDGE / FIRE_PLEDGE / GRASS_PLEDGE (battle_script_commands.c:2612-2656)', () => {
    it('Water Pledge in Sun creates user Rainbow (3 turns)', () => {
      const state = battle([{ moves: slot('MOVE_WATER_PLEDGE'), pp: pps }, {}], countingRng())
      state.field.weather = WEATHER_SUN_TEMPORARY
      executeTurn(state, [useMove(1, move('MOVE_WATER_PLEDGE')), null], testDeps())
      expect(state.sides[0]!.timers.rainbowTimer).toBe(3)
      expect(state.sides[0]!.timers.started.rainbow).toBe(true)
    })

    it('Water Pledge in Grassy Terrain creates target Swamp (3 turns)', () => {
      const state = battle([{ moves: slot('MOVE_WATER_PLEDGE'), pp: pps }, {}], countingRng())
      state.field.statuses |= STATUS_FIELD_GRASSY_TERRAIN
      executeTurn(state, [useMove(1, move('MOVE_WATER_PLEDGE')), null], testDeps())
      expect(state.sides[1]!.timers.swampTimer).toBe(3)
      expect(state.sides[1]!.timers.started.swamp).toBe(true)
    })

    it('Water Pledge without Sun or Grassy Terrain creates no field effect in singles', () => {
      const state = battle([{ moves: slot('MOVE_WATER_PLEDGE'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_WATER_PLEDGE')), null], testDeps())
      expect(state.sides[0]!.timers.rainbowTimer).toBe(0)
      expect(state.sides[1]!.timers.swampTimer).toBe(0)
    })

    it('Fire Pledge in Rain creates user Rainbow (3 turns)', () => {
      const state = battle([{ moves: slot('MOVE_FIRE_PLEDGE'), pp: pps }, {}], countingRng())
      state.field.weather = WEATHER_RAIN_TEMPORARY
      executeTurn(state, [useMove(1, move('MOVE_FIRE_PLEDGE')), null], testDeps())
      expect(state.sides[0]!.timers.rainbowTimer).toBe(3)
      expect(state.sides[0]!.timers.started.rainbow).toBe(true)
    })

    it('Fire Pledge in Grassy Terrain creates target Fire Sea (3 turns)', () => {
      const state = battle([{ moves: slot('MOVE_FIRE_PLEDGE'), pp: pps }, {}], countingRng())
      state.field.statuses |= STATUS_FIELD_GRASSY_TERRAIN
      executeTurn(state, [useMove(1, move('MOVE_FIRE_PLEDGE')), null], testDeps())
      expect(state.sides[1]!.timers.fireSeaTimer).toBe(3)
      expect(state.sides[1]!.timers.started.fireSea).toBe(true)
    })

    it('Grass Pledge in Sun creates target Fire Sea (3 turns)', () => {
      const state = battle([{ moves: slot('MOVE_GRASS_PLEDGE'), pp: pps }, {}], countingRng())
      state.field.weather = WEATHER_SUN_TEMPORARY
      executeTurn(state, [useMove(1, move('MOVE_GRASS_PLEDGE')), null], testDeps())
      expect(state.sides[1]!.timers.fireSeaTimer).toBe(3)
      expect(state.sides[1]!.timers.started.fireSea).toBe(true)
    })

    it('Grass Pledge in Rain creates target Swamp (3 turns)', () => {
      const state = battle([{ moves: slot('MOVE_GRASS_PLEDGE'), pp: pps }, {}], countingRng())
      state.field.weather = WEATHER_RAIN_TEMPORARY
      executeTurn(state, [useMove(1, move('MOVE_GRASS_PLEDGE')), null], testDeps())
      expect(state.sides[1]!.timers.swampTimer).toBe(3)
      expect(state.sides[1]!.timers.started.swamp).toBe(true)
    })
  })

  describe('MOVE_EFFECT_GLAIVE_RUSH (battle_script_commands.c:2961-2963)', () => {
    it('sets round.glaiveRush = true on the user', () => {
      const state = battle([{ moves: slot('MOVE_GLAIVE_RUSH'), pp: pps }, {}], countingRng())
      applySecondaryMoveEffects({
        state,
        attackerId: 0,
        targetId: 1,
        moveId: 'MOVE_GLAIVE_RUSH',
        targetDamage: 50,
        deps: testDeps(),
        unmodelled: [],
      })
      expect(state.battlers[0]!.round.glaiveRush).toBe(true)
    })
  })

  describe('MOVE_EFFECT_ORDER_UP (battle_script_commands.c:2595-2611)', () => {
    it('in singles, resolves cleanly with no partner and applies no stat boosts', () => {
      const state = battle(
        [{ moves: slot('MOVE_ORDER_UP'), pp: pps, speciesId: 'SPECIES_DONDOZO' }, {}],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_ORDER_UP')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    })
  })

  describe('MOVE_EFFECT_PSYCHIC_NOISE (battle_script_commands.c:3006-3012)', () => {
    it('sets STATUS3_HEAL_BLOCK and healBlockTimer = 2 on target', () => {
      const state = battle([{ moves: slot('MOVE_PSYCHIC_NOISE'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_PSYCHIC_NOISE')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_HEAL_BLOCK)).toBe(true)
      // Set to 2 by Psychic Noise, decremented to 1 by ENDTURN_HEALBLOCK (:1252) at end of turn
      expect(state.battlers[1]!.volatiles.healBlockTimer).toBe(1)
    })

    it('is blocked by C gate: does not overwrite if already heal blocked', () => {
      const state = battle([{ moves: slot('MOVE_PSYCHIC_NOISE'), pp: pps }, {}], countingRng())
      state.battlers[1]!.statuses3 |= STATUS3_HEAL_BLOCK
      state.battlers[1]!.volatiles.healBlockTimer = 5
      executeTurn(state, [useMove(1, move('MOVE_PSYCHIC_NOISE')), null], testDeps())
      // Preserved at 5, decremented to 4 by ENDTURN_HEALBLOCK (:1252) at end of turn
      expect(state.battlers[1]!.volatiles.healBlockTimer).toBe(4)
    })
  })

  describe('MOVE_EFFECT_SALT_CURE (battle_script_commands.c:2964-2970)', () => {
    it('sets STATUS4_SALT_CURE on target', () => {
      const state = battle([{ moves: slot('MOVE_SALT_CURE'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_SALT_CURE')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_SALT_CURE)).toBe(true)
    })

    it('is blocked by C gate: does not duplicate if already salt cured', () => {
      const state = battle([{ moves: slot('MOVE_SALT_CURE'), pp: pps }, {}], countingRng())
      state.battlers[1]!.statuses4 |= STATUS4_SALT_CURE
      executeTurn(state, [useMove(1, move('MOVE_SALT_CURE')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses4, STATUS4_SALT_CURE)).toBe(true)
    })
  })

  describe('MOVE_EFFECT_SYRUP (battle_script_commands.c:2971-2982)', () => {
    it('sets syrupTimer = 3 on target, decremented to 2 at end of turn (battle_util.c:2444-2450)', () => {
      const state = battle([{ moves: slot('MOVE_SYRUP_BOMB'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_SYRUP_BOMB')), null], testDeps())
      // In C (battle_util.c:2444-2450): ENDTURN_SYRUP decrements syrupTimer at turn end (3 -> 2).
      expect(state.battlers[1]!.volatiles.syrupTimer).toBe(2)
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    })

    it('is blocked by C gate: does not overwrite existing syrupTimer; decrements at end of turn', () => {
      const state = battle([{ moves: slot('MOVE_SYRUP_BOMB'), pp: pps }, {}], countingRng())
      state.battlers[1]!.volatiles.syrupTimer = 1
      executeTurn(state, [useMove(1, move('MOVE_SYRUP_BOMB')), null], testDeps())
      // In C: not overwritten, and decremented from 1 to 0 at turn end.
      expect(state.battlers[1]!.volatiles.syrupTimer).toBe(0)
    })
  })

  describe('MOVE_EFFECT_PAYDAY (battle_script_commands.c:2679-2691)', () => {
    it('deals damage with no effect on battle stats or conditions', () => {
      const state = battle([{ moves: slot('MOVE_PAY_DAY'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_PAY_DAY')), null], testDeps(fixedDamage(25)))
      expect(state.battlers[1]!.mon.hp).toBe(75)
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    })
  })
})

// -----------------------------------------------------------------------------
// Part 2: Stat/user-effect scripts
// -----------------------------------------------------------------------------

describe('Part 2: Stat and user-effect scripts', () => {
  describe('EFFECT_DEFENSE_UP2_HIT (Diamond Storm, battle_scripts_1.s:336-345)', () => {
    it('raises user Def by 2 stages when 50% chance passes', () => {
      // rolls: acc check (0), chance check (0 < 50 passes)
      const state = battle([{ moves: slot('MOVE_DIAMOND_STORM'), pp: pps }, {}], scriptedRng([0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_DIAMOND_STORM')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 2)
    })

    it('does not raise Def when 50% chance fails', () => {
      // rolls: acc check (0), chance check (90 >= 50 fails)
      const state = battle([{ moves: slot('MOVE_DIAMOND_STORM'), pp: pps }, {}], scriptedRng([0, 90]))
      executeTurn(state, [useMove(1, move('MOVE_DIAMOND_STORM')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    })
  })

  describe('EFFECT_ATTACKER_DEFENSE_DOWN_HIT (Clanging Scales, battle_scripts_1.s:356-364)', () => {
    it('certainly drops user Def by 1 stage on hit', () => {
      const state = battle([{ moves: slot('MOVE_CLANGING_SCALES'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_CLANGING_SCALES')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    })
  })

  describe('EFFECT_HYPERSPACE_FURY (battle_scripts_1.s:365-370)', () => {
    it('succeeds for SPECIES_HOOPA_UNBOUND and drops user Def by 1', () => {
      const state = battle(
        [{ moves: slot('MOVE_HYPERSPACE_FURY'), pp: pps, speciesId: 'SPECIES_HOOPA_UNBOUND' }, {}],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_HYPERSPACE_FURY')), null], testDeps(fixedDamage(40)))
      expect(state.battlers[1]!.mon.hp).toBe(60)
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
    })

    it('fails pre-hit for non-Hoopa-Unbound species without deducting PP', () => {
      const state = battle(
        [{ moves: slot('MOVE_HYPERSPACE_FURY'), pp: [5, 0, 0, 0], speciesId: 'SPECIES_MUDKIP' }, {}],
        countingRng(),
      )
      const res = executeTurn(state, [useMove(1, move('MOVE_HYPERSPACE_FURY')), null], testDeps(fixedDamage(40)))
      expect(res.actions[0]?.missed).toBe(true)
      expect(state.battlers[1]!.mon.hp).toBe(100)
      expect(state.battlers[0]!.mon.pp[0]).toBe(5)
    })
  })

  describe('EFFECT_V_CREATE (battle_scripts_1.s:1052-1077)', () => {
    it('drops user Def, SpDef, and Speed by 1 stage', () => {
      const state = battle([{ moves: slot('MOVE_V_CREATE'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_V_CREATE')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.battlers[0]!.mon.statStages[STAT_SPDEF]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    })
  })

  describe('EFFECT_RIP_AND_TEAR (battle_scripts_1.s:1078-1090)', () => {
    it('certainly drops target Speed by 1 and applies Bleed when chance passes', () => {
      // rolls: acc check (0), bleed chance check (0 passes)
      const state = battle([{ moves: slot('MOVE_RIP_AND_TEAR'), pp: pps }, {}], scriptedRng([0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_RIP_AND_TEAR')), null], testDeps())
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
    })

    it('still drops target Speed by 1 even when Bleed chance fails', () => {
      // rolls: acc check (0), bleed chance check (99 fails if chance < 99)
      // Note: Rip and Tear effectChance is 100 in data, but certain speed drop is guaranteed
      const state = battle([{ moves: slot('MOVE_RIP_AND_TEAR'), pp: pps }, { status1: STATUS1_BURN }], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_RIP_AND_TEAR')), null], testDeps())
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    })
  })

  describe('EFFECT_SNAP_JAW (Kilobite, battle_scripts_1.s:1091-1100)', () => {
    it('raises user Speed by 1 when random % 2 === 0', () => {
      // rolls: acc check (0), chance check (0), random % 2 = 0
      const state = battle([{ moves: slot('MOVE_KILOBITE'), pp: pps }, {}], scriptedRng([0, 0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_KILOBITE')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    })

    it('drops target Speed by 1 when random % 2 === 1', () => {
      // rolls: random % 2 = 1 (target Speed drop), acc check (0), chance check (0 < 100 passes)
      const state = battle([{ moves: slot('MOVE_KILOBITE'), pp: pps }, {}], scriptedRng([1, 0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_KILOBITE')), null], testDeps())
      expect(state.battlers[0]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    })
  })

  describe('EFFECT_BULLDOZE (battle_scripts_1.s:1101-1105)', () => {
    it('drops target Speed by 1 stage on hit', () => {
      const state = battle([{ moves: slot('MOVE_BULLDOZE'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_BULLDOZE')), null], testDeps())
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE - 1)
    })
  })

  describe('EFFECT_ARGUMENT_HIT_IF_STAT_UP (Alluring Voice, battle_scripts_1.s:1106-1120)', () => {
    it('inflicts STATUS2_CONFUSION when target has any stat stage > 6', () => {
      const state = battle([{ moves: slot('MOVE_ALLURING_VOICE'), pp: pps }, {}], countingRng())
      state.battlers[1]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 1
      executeTurn(state, [useMove(1, move('MOVE_ALLURING_VOICE')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(true)
    })

    it('does not inflict confusion when target has no boosted stat stages', () => {
      const state = battle([{ moves: slot('MOVE_ALLURING_VOICE'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_ALLURING_VOICE')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
    })

    it('is blocked when attacker has Unaware', () => {
      const state = battle(
        [{ moves: slot('MOVE_ALLURING_VOICE'), pp: pps, abilities: hasAbility('ABILITY_UNAWARE') }, {}],
        countingRng(),
      )
      state.battlers[1]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
      executeTurn(state, [useMove(1, move('MOVE_ALLURING_VOICE')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_CONFUSION)).toBe(false)
    })
  })

  describe('EFFECT_HEAT_CRASH (Splash argument effect, battle_scripts_1.s:1121-1126)', () => {
    it('applies Drench argument effect when chance passes', () => {
      // Splash has argument effect MOVE_EFFECT_DRENCH with chance 20
      // rolls: acc check (0), chance check (0 < 20 passes)
      const state = battle([{ moves: slot('MOVE_SPLASH'), pp: pps }, {}], scriptedRng([0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_SPLASH')), null], testDeps())
      expect(state.battlers[1]!.volatiles.drenched).toBeGreaterThan(0)
    })

    it('does not apply Drench when chance fails', () => {
      // rolls: acc check (0), chance check (50 >= 20 fails)
      const state = battle([{ moves: slot('MOVE_SPLASH'), pp: pps }, {}], scriptedRng([0, 50]))
      executeTurn(state, [useMove(1, move('MOVE_SPLASH')), null], testDeps())
      expect(state.battlers[1]!.volatiles.drenched).toBe(0)
    })
  })

  describe('EFFECT_FALSE_SWIPE (battle_scripts_1.s:1127-1132)', () => {
    it('applies Bleed argument effect when chance passes', () => {
      // False Swipe has argument effect MOVE_EFFECT_BLEED with chance 50
      // rolls: acc check (0), chance check (0 < 50 passes)
      const state = battle([{ moves: slot('MOVE_FALSE_SWIPE'), pp: pps }, {}], scriptedRng([0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_FALSE_SWIPE')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(true)
    })

    it('does not apply Bleed when chance fails', () => {
      // rolls: acc check (0), chance check (80 >= 50 fails)
      const state = battle([{ moves: slot('MOVE_FALSE_SWIPE'), pp: pps }, {}], scriptedRng([0, 80]))
      executeTurn(state, [useMove(1, move('MOVE_FALSE_SWIPE')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BLEED)).toBe(false)
    })
  })
})

// -----------------------------------------------------------------------------
// Part 3: Status/field-on-target scripts
// -----------------------------------------------------------------------------

describe('Part 3: Status and field-on-target scripts', () => {
  describe('EFFECT_JAW_LOCK (battle_scripts_1.s:1133-1137)', () => {
    it('inflicts STATUS2_ESCAPE_PREVENTION on BOTH target and attacker', () => {
      const state = battle([{ moves: slot('MOVE_JAW_LOCK'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_JAW_LOCK')), null], testDeps())
      expect(hasFlag(state.battlers[0]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
      expect(state.battlers[0]!.volatiles.battlerPreventingEscape).toBe(1)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
      expect(state.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)
    })
  })

  describe('EFFECT_FLAME_BURST (battle_scripts_1.s:1138-1142)', () => {
    it('executes cleanly in singles without partner splash error', () => {
      const state = battle([{ moves: slot('MOVE_FLAME_BURST'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_FLAME_BURST')), null], testDeps(fixedDamage(30)))
      expect(state.battlers[1]!.mon.hp).toBe(70)
    })
  })

  describe('EFFECT_THROAT_CHOP (battle_scripts_1.s:1143-1147)', () => {
    it('sets throatChopTimer = 2 on target, decremented to 1 by endTurn', () => {
      const state = battle([{ moves: slot('MOVE_THROAT_CHOP'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_THROAT_CHOP')), null], testDeps())
      // ENDTURN_THROAT_CHOP (battle_util.c:2923-2929) decrements 2 -> 1 at end of turn
      expect(state.battlers[1]!.volatiles.throatChopTimer).toBe(1)
    })
  })

  describe('EFFECT_CORE_ENFORCER (battle_scripts_1.s:1148-1152)', () => {
    it('suppresses target ability with STATUS3_GASTRO_ACID when target has already acted', () => {
      // Target is faster (spe 150 > user 100) and uses Tackle first
      const state = battle(
        [{ moves: slot('MOVE_CORE_ENFORCER'), pp: pps, spe: 100 }, { moves: slot('MOVE_TACKLE'), pp: pps, spe: 150 }],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_CORE_ENFORCER')), useMove(0, move('MOVE_TACKLE'))], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(true)
    })

    it('does NOT suppress ability when user moves first (target has not acted yet)', () => {
      // User is faster (spe 150 > target 50) and uses Core Enforcer first
      const state = battle(
        [{ moves: slot('MOVE_CORE_ENFORCER'), pp: pps, spe: 150 }, { moves: slot('MOVE_TACKLE'), pp: pps, spe: 50 }],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_CORE_ENFORCER')), useMove(0, move('MOVE_TACKLE'))], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_GASTRO_ACID)).toBe(false)
    })
  })

  describe('EFFECT_CLEAR_SMOG (battle_scripts_1.s:1153-1157)', () => {
    it('resets all target stat stages to DEFAULT_STAT_STAGE (6) on hit', () => {
      const state = battle([{ moves: slot('MOVE_CLEAR_SMOG'), pp: pps }, {}], countingRng())
      state.battlers[1]!.mon.statStages[STAT_ATK] = 10
      state.battlers[1]!.mon.statStages[STAT_DEF] = 3
      state.battlers[1]!.mon.statStages[STAT_SPEED] = 8
      executeTurn(state, [useMove(1, move('MOVE_CLEAR_SMOG')), null], testDeps())
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[1]!.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE)
    })
  })

  describe('EFFECT_SPECTRAL_THIEF (battle_scripts_1.s:1158-1162)', () => {
    it('steals target positive stat boosts and adds them to user', () => {
      const state = battle([{ moves: slot('MOVE_SPECTRAL_THIEF'), pp: pps }, {}], countingRng())
      state.battlers[1]!.mon.statStages[STAT_ATK] = DEFAULT_STAT_STAGE + 2
      state.battlers[1]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE + 1
      state.battlers[1]!.mon.statStages[STAT_SPATK] = DEFAULT_STAT_STAGE - 1 // negative stage: not stolen
      executeTurn(state, [useMove(1, move('MOVE_SPECTRAL_THIEF')), null], testDeps())
      // Target positive stages reset to 6; negative stage untouched
      expect(state.battlers[1]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[1]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
      expect(state.battlers[1]!.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE - 1)
      // Attacker gained the stolen boosts
      expect(state.battlers[0]!.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
      expect(state.battlers[0]!.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE + 1)
    })
  })

  describe('EFFECT_FEINT (battle_scripts_1.s:1163-1167)', () => {
    it('breaks target protect and clears side wide guard', () => {
      const state = battle([{ moves: slot('MOVE_FEINT'), pp: pps }, {}], countingRng())
      state.battlers[1]!.round.protectMove = 'MOVE_PROTECT'
      state.sides[1]!.statuses |= SIDE_STATUS_WIDE_GUARD
      executeTurn(state, [useMove(1, move('MOVE_FEINT')), null], testDeps())
      expect(state.battlers[1]!.round.protectMove).toBeNull()
      expect(hasFlag(state.sides[1]!.statuses, SIDE_STATUS_WIDE_GUARD)).toBe(false)
    })
  })

  describe('EFFECT_INCINERATE (battle_scripts_1.s:1168-1172)', () => {
    it('destroys target held Berry', () => {
      const state = battle([{ moves: slot('MOVE_INCINERATE'), pp: pps }, { itemId: 'ITEM_SITRUS_BERRY' }], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_INCINERATE')), null], testDeps())
      expect(state.battlers[1]!.mon.itemId).toBeNull()
    })

    it('does not destroy non-berry/gem item', () => {
      const state = battle([{ moves: slot('MOVE_INCINERATE'), pp: pps }, { itemId: 'ITEM_LEFTOVERS' }], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_INCINERATE')), null], testDeps())
      expect(state.battlers[1]!.mon.itemId).toBe('ITEM_LEFTOVERS')
    })
  })

  describe('EFFECT_WAKE_UP_SLAP and EFFECT_SPARKLING_ARIA (battle_scripts_1.s:1173-1182)', () => {
    it('Wake-Up Slap cures target sleep', () => {
      const state = battle([{ moves: slot('MOVE_WAKE_UP_SLAP'), pp: pps }, { status1: STATUS1_SLEEP }], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_WAKE_UP_SLAP')), null], testDeps())
      expect(state.battlers[1]!.mon.status1).toBe(0)
    })

    it('Sparkling Aria cures target burn', () => {
      const state = battle([{ moves: slot('MOVE_SPARKLING_ARIA'), pp: pps }, { status1: STATUS1_BURN }], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_SPARKLING_ARIA')), null], testDeps())
      expect(state.battlers[1]!.mon.status1).toBe(0)
    })

    it('Wake-Up Slap does not cure non-sleep status', () => {
      const state = battle([{ moves: slot('MOVE_WAKE_UP_SLAP'), pp: pps }, { status1: STATUS1_BURN }], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_WAKE_UP_SLAP')), null], testDeps())
      expect(state.battlers[1]!.mon.status1).toBe(STATUS1_BURN)
    })
  })

  describe('EFFECT_UPPER_HAND (battle_scripts_1.s:331-335)', () => {
    it('flinches target when target chose a priority move and has not moved yet', () => {
      // Upper Hand has priority 3; Extreme Speed has priority 2
      const state = battle(
        [{ moves: slot('MOVE_UPPER_HAND'), pp: pps }, { moves: slot('MOVE_EXTREME_SPEED'), pp: pps }],
        countingRng(),
      )
      const res = executeTurn(
        state,
        [useMove(1, move('MOVE_UPPER_HAND')), useMove(0, move('MOVE_EXTREME_SPEED'))],
        testDeps(),
      )
      expect(res.actions[1]?.cancelledBy).toBe('FLINCH')
    })

    it('fails pre-hit and deducts PP if target chose a non-priority move', () => {
      const state = battle(
        [{ moves: slot('MOVE_UPPER_HAND'), pp: [15, 0, 0, 0] }, { moves: slot('MOVE_TACKLE'), pp: pps }],
        countingRng(),
      )
      const res = executeTurn(
        state,
        [useMove(1, move('MOVE_UPPER_HAND')), useMove(0, move('MOVE_TACKLE'))],
        testDeps(),
      )
      expect(res.actions[0]?.missed).toBe(true)
      expect(state.battlers[0]!.mon.pp[0]).toBe(14)
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_FLINCHED)).toBe(false)
    })
  })

  describe('EFFECT_OCTOLOCK (battle_scripts_1.s:1183-1188)', () => {
    it('traps target with STATUS2_ESCAPE_PREVENTION and octolock volatile', () => {
      const state = battle([{ moves: slot('MOVE_OCTOLOCK'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_OCTOLOCK')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_ESCAPE_PREVENTION)).toBe(true)
      expect(state.battlers[1]!.volatiles.battlerPreventingEscape).toBe(0)
      expect(state.battlers[1]!.volatiles.octolock).toBe(true)
    })
  })

  describe('EFFECT_SAPPY_SEED (battle_scripts_1.s:1189-1194)', () => {
    it('plants STATUS3_LEECHSEED on non-Grass target', () => {
      const state = battle([{ moves: slot('MOVE_SAPPY_SEED'), pp: pps }, {}], countingRng())
      executeTurn(state, [useMove(1, move('MOVE_SAPPY_SEED')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(true)
    })

    it('fails to plant Leech Seed on Grass-type target', () => {
      const state = battle(
        [{ moves: slot('MOVE_SAPPY_SEED'), pp: pps }, { types: ['GRASS', 'MYSTERY', 'MYSTERY'] }],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_SAPPY_SEED')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.statuses3, STATUS3_LEECHSEED)).toBe(false)
    })
  })

  describe('EFFECT_BURN_UP (battle_scripts_1.s:729-735)', () => {
    it('removes Fire type from user on hit when user is Fire type', () => {
      const state = battle(
        [{ moves: slot('MOVE_BURN_UP'), pp: pps, types: ['FIRE', 'MYSTERY', 'MYSTERY'] }, {}],
        countingRng(),
      )
      executeTurn(state, [useMove(1, move('MOVE_BURN_UP')), null], testDeps())
      expect(state.battlers[0]!.mon.types.includes('FIRE')).toBe(false)
      expect(state.battlers[0]!.mon.types[0]).toBe('MYSTERY')
    })

    it('fails pre-hit and deducts PP when user lacks Fire type', () => {
      const state = battle(
        [{ moves: slot('MOVE_BURN_UP'), pp: [5, 0, 0, 0], types: ['WATER', 'MYSTERY', 'MYSTERY'] }, {}],
        countingRng(),
      )
      const res = executeTurn(state, [useMove(1, move('MOVE_BURN_UP')), null], testDeps())
      expect(res.actions[0]?.missed).toBe(true)
      expect(state.battlers[0]!.mon.pp[0]).toBe(4)
      expect(state.battlers[1]!.mon.hp).toBe(100)
    })
  })

  describe('EFFECT_MORTAL_SPIN (battle_scripts_1.s:1195-1200)', () => {
    it('clears user hazards and poisons target', () => {
      const state = battle([{ moves: slot('MOVE_MORTAL_SPIN'), pp: pps }, {}], countingRng())
      state.sides[0]!.statuses |= SIDE_STATUS_SPIKES
      executeTurn(state, [useMove(1, move('MOVE_MORTAL_SPIN')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_POISON)).toBe(true)
      expect(hasFlag(state.sides[0]!.statuses, SIDE_STATUS_SPIKES)).toBe(false)
    })
  })

  describe('EFFECT_MATCHA_GOTCHA (battle_scripts_1.s:1201-1206)', () => {
    it('inflicts burn on target when 20% burn chance passes', () => {
      // rolls: acc check (0), chance check (0 < 20 passes)
      const state = battle([{ moves: slot('MOVE_MATCHA_GOTCHA'), pp: pps }, {}], scriptedRng([0, 0]))
      executeTurn(state, [useMove(1, move('MOVE_MATCHA_GOTCHA')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(true)
    })

    it('does not inflict burn when chance fails', () => {
      // rolls: acc check (0), chance check (50 >= 20 fails)
      const state = battle([{ moves: slot('MOVE_MATCHA_GOTCHA'), pp: pps }, {}], scriptedRng([0, 50]))
      executeTurn(state, [useMove(1, move('MOVE_MATCHA_GOTCHA')), null], testDeps())
      expect(hasFlag(state.battlers[1]!.mon.status1, STATUS1_BURN)).toBe(false)
    })
  })
})
