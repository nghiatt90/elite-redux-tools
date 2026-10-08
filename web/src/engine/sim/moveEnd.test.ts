// Unit tests for Cmd_moveend ladder skeleton, recoil, Life Orb, Rocky Helmet, last-move bookkeeping (cycle 31, step 5, batch 8a).
//
// Hand-derived from upstream C source code at pinned SHA:
// - Cmd_moveend (src/battle_script_commands.c:4309-4968)
// - MOVEEND_RECOIL (src/battle_script_commands.c:4457-4517)
// - MOVEEND_ITEM_EFFECTS_TARGET / Rocky Helmet (src/battle_util.c:6160-6169)
// - MOVEEND_LIFEORB_SHELLBELL / Life Orb (src/battle_util.c:6085-6110)
// - IsMoveMakingContact (src/battle_util.c:6554-6569)
// - GetRecoilFraction (tools/codegen/src/er/move/MoveRecoilGenerator.kt:14-20)
// - MOVEEND_UPDATE_LAST_MOVES (src/battle_script_commands.c:4723-4772)
// - MOVEEND_CHARGE (src/battle_script_commands.c:4922-4933)
// - MOVEEND_SUBSTITUTE (src/battle_script_commands.c:4714-4722)
// - MOVEEND_CLEAR_BITS (src/battle_script_commands.c:4934-4957)

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
  STATUS1_NONE,
  STATUS2_SUBSTITUTE,
  STATUS3_CHARGED_UP,
  hasFlag,
} from './constants'
import {
  NO_RECOIL_ABILITIES,
  HALF_RECOIL_ABILITIES,
  RECOIL_FRACTIONS,
} from './moveEnd'

// ---------------------------------------------------------------------------
// Verbatim Fixture Block from moveEffectsScreensHazards.test.ts
// ---------------------------------------------------------------------------

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
    target: m.target as string | undefined,
    priority: m.priority as number | undefined,
    flags: (m.flags as Record<string, true>) ?? {},
    accuracy: m.accuracy as number,
    hitsAir: m.hitsAir as SimMoveData['hitsAir'],
    sheerForceBoost: m.sheerForceBoost as true | undefined,
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
    status1: STATUS1_NONE,
    status2: 0,
    ...overrides,
  }
}

function battle(
  specs: {
    spe?: number
    atk?: number
    hp?: number
    maxHp?: number
    itemId?: string | null
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    types?: SimBattleMon['types']
    statStages?: number[]
  }[],
  rng: RandomSource,
): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: s.atk ?? 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          itemId: s.itemId ?? null,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
          statStages: s.statStages ?? [],
        }),
        0,
      ),
    ),
    rng,
  })
}

function scriptedRng(rolls: number[] = []): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      if (idx < rolls.length) {
        return rolls[idx++]!
      }
      return 0
    },
  }
  return r
}

function useMove(target: number, move: SimMoveData): ChosenAction {
  const view: TurnOrderMoveView = {
    id: move.id,
    priority: move.priority ?? 0,
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

function fixedDamage(targetDamage: number): DamageResolver {
  return {
    resolve: () => ({ targetDamage, attackerDamage: null, unmodelled: [] }),
  }
}

function testDepsWithDamage(damageResolver: DamageResolver, holdEffects: Record<number, string> = {}): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  const grounding: GroundingContext = { ...GROUNDING, holdEffectOf: (id) => holdEffects[id] ?? null }
  return { turnOrder: rest, grounding, damage: damageResolver, statStageRatios: RATIOS, dataContext: DATA_CONTEXT }
}

// ---------------------------------------------------------------------------
// Move & Ability Fixtures
// ---------------------------------------------------------------------------

const MOVE_TACKLE = requireMove('MOVE_TACKLE')
const MOVE_HEAD_CHARGE = requireMove('MOVE_HEAD_CHARGE')
const MOVE_DOUBLE_EDGE = requireMove('MOVE_DOUBLE_EDGE')
const MOVE_HEAD_SMASH = requireMove('MOVE_HEAD_SMASH')
const MOVE_WATER_GUN = requireMove('MOVE_WATER_GUN')
const MOVE_FIRE_PUNCH = requireMove('MOVE_FIRE_PUNCH')
const MOVE_THUNDERBOLT = requireMove('MOVE_THUNDERBOLT')
const MOVE_FLAMETHROWER = requireMove('MOVE_FLAMETHROWER')
const MOVE_RAPID_SPIN = requireMove('MOVE_RAPID_SPIN')

const ABILITY_ROCK_HEAD = requireAbility('ABILITY_ROCK_HEAD')
const ABILITY_STEEL_BARREL = requireAbility('ABILITY_STEEL_BARREL')
const ABILITY_BRUTEFORCE = requireAbility('ABILITY_BRUTEFORCE')
const ABILITY_DAREDEVIL = requireAbility('ABILITY_DAREDEVIL')
const ABILITY_LIMBER = requireAbility('ABILITY_LIMBER')
const ABILITY_MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')
const ABILITY_LONG_REACH = requireAbility('ABILITY_LONG_REACH')
const ABILITY_SHEER_FORCE = requireAbility('ABILITY_SHEER_FORCE')
const ABILITY_ROUGH_SKIN = requireAbility('ABILITY_ROUGH_SKIN')
const ABILITY_POISON_TOUCH = requireAbility('ABILITY_POISON_TOUCH')
const ABILITY_MOXIE = requireAbility('ABILITY_MOXIE')

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe('MOVEEND_RECOIL: Recoil Moves', () => {
  it('applies 25% recoil (EFFECT_RECOIL_25, Head Charge -- Take Down is EFFECT_SPEED_DOWN_HIT in Elite Redux): floor(40 / 4) = 10 self-damage', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_HEAD_CHARGE), null], testDepsWithDamage(fixedDamage(40)))

    expect(state.battlers[1]!.mon.hp).toBe(60) // 100 - 40
    expect(state.battlers[0]!.mon.hp).toBe(90) // 100 - 10
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.targetDamage).toBe(40)
    expect(act.attackerDamage).toBe(10)
  })

  it('applies 33% recoil (EFFECT_RECOIL_33, Double-Edge): floor(60 / 3) = 20 self-damage', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[1]!.mon.hp).toBe(40) // 100 - 60
    expect(state.battlers[0]!.mon.hp).toBe(80) // 100 - 20
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(20)
  })

  it('applies 50% recoil (EFFECT_RECOIL_50, Head Smash): floor(50 / 2) = 25 self-damage', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_HEAD_SMASH), null], testDepsWithDamage(fixedDamage(50)))

    expect(state.battlers[1]!.mon.hp).toBe(50) // 100 - 50
    expect(state.battlers[0]!.mon.hp).toBe(75) // 100 - 25
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(25)
  })

  it('enforces minimum 1 recoil damage when division truncates to 0', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(1)))

    expect(state.battlers[1]!.mon.hp).toBe(99) // 100 - 1
    expect(state.battlers[0]!.mon.hp).toBe(99) // 100 - max(1, floor(1/3)) = 100 - 1
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(1)
  })

  it('deals no recoil when target took 0 damage (e.g. immunity / dummyDamage)', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(0)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('blocks recoil with Rock Head (ABILITY_ROCK_HEAD)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_ROCK_HEAD, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('blocks recoil with Steel Barrel (ABILITY_STEEL_BARREL)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_STEEL_BARREL, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('blocks recoil with Bruteforce (ABILITY_BRUTEFORCE)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_BRUTEFORCE, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('blocks recoil with Magic Guard (ABILITY_MAGIC_GUARD)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MAGIC_GUARD, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('halves recoil with Daredevil (ABILITY_DAREDEVIL): floor(20 / 2) = 10', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_DAREDEVIL, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(90) // 100 - 10
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(10)
  })

  it('halves recoil with Limber (ABILITY_LIMBER): floor(20 / 2) = 10', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_LIMBER, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(60)))

    expect(state.battlers[0]!.mon.hp).toBe(90) // 100 - 10
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(10)
  })
})

describe('MOVEEND_LIFEORB_SHELLBELL: Life Orb', () => {
  it('deals floor(maxHp / 10) self-damage on damaging hit: floor(100 / 10) = 10', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[1]!.mon.hp).toBe(50) // 100 - 50
    expect(state.battlers[0]!.mon.hp).toBe(90) // 100 - 10
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(10)
  })

  it('enforces minimum 1 Life Orb self-damage on low maxHp', () => {
    const state = battle([{ hp: 5, maxHp: 5 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(4) // 5 - 1
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(1)
  })

  it('does NOT deal Life Orb damage when target took 0 damage', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(0), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is blocked by Magic Guard (ABILITY_MAGIC_GUARD)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MAGIC_GUARD, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(100)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is negated by Sheer Force on boosted moves (Flamethrower)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_SHEER_FORCE, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_FLAMETHROWER), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(100) // Sheer Force negates Life Orb recoil
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is NOT negated by Sheer Force on non-boosted moves (Tackle)', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_SHEER_FORCE, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(50), { 0: 'HOLD_EFFECT_LIFE_ORB' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(90) // Life Orb recoil applies
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(10)
  })
})

describe('MOVEEND_ITEM_EFFECTS_TARGET: Rocky Helmet', () => {
  it('deals floor(attacker.maxHp / 6) on contact hit: floor(120 / 6) = 20', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[1]!.mon.hp).toBe(70) // 100 - 30
    expect(state.battlers[0]!.mon.hp).toBe(100) // 120 - 20
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(20)
  })

  it('does NOT deal damage on non-contact hit (Water Gun)', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_WATER_GUN), null],
      testDepsWithDamage(fixedDamage(30), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is prevented by Protective Pads (HOLD_EFFECT_PROTECTIVE_PADS) on contact', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 0: 'HOLD_EFFECT_PROTECTIVE_PADS', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is prevented by Punching Glove (HOLD_EFFECT_PUNCHING_GLOVE) on punch-based move (Fire Punch)', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_FIRE_PUNCH), null],
      testDepsWithDamage(fixedDamage(30), { 0: 'HOLD_EFFECT_PUNCHING_GLOVE', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is NOT prevented by Punching Glove on non-punch contact move (Tackle)', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 0: 'HOLD_EFFECT_PUNCHING_GLOVE', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(100) // 120 - 20
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(20)
  })

  it('is prevented by Long Reach (ABILITY_LONG_REACH)', () => {
    const state = battle(
      [{ hp: 120, maxHp: 120, abilities: { ability: ABILITY_LONG_REACH, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('is blocked by Magic Guard (ABILITY_MAGIC_GUARD)', () => {
    const state = battle(
      [{ hp: 120, maxHp: 120, abilities: { ability: ABILITY_MAGIC_GUARD, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(30), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })

  it('does NOT trigger when target took 0 damage', () => {
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_TACKLE), null],
      testDepsWithDamage(fixedDamage(0), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(120)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBeNull()
  })
})

describe('Ordering & Interactions: Rocky Helmet (13), Recoil (23), Life Orb (26)', () => {
  it('applies Rocky Helmet then Recoil in C enum order when attacker survives both', () => {
    // Attacker: maxHp 120, hp 120.
    // Target: holds Rocky Helmet, takes 60 damage from Double-Edge (33% recoil).
    // Step 13 (Rocky Helmet): floor(120 / 6) = 20 damage. Attacker HP drops to 100.
    // Step 23 (Recoil): floor(60 / 3) = 20 damage. Attacker HP drops to 80.
    // Total attackerDamage = 40.
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_DOUBLE_EDGE), null],
      testDepsWithDamage(fixedDamage(60), { 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[1]!.mon.hp).toBe(40) // 100 - 60
    expect(state.battlers[0]!.mon.hp).toBe(80) // 120 - 20 (helmet) - 20 (recoil)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(40)
    expect(act.fainted).toEqual([])
  })

  it('faints attacker from Rocky Helmet (13), suppressing subsequent Recoil (23) and Life Orb (26)', () => {
    // Attacker: maxHp 120, hp 15. Holds Life Orb.
    // Target: holds Rocky Helmet, takes 60 damage from Double-Edge.
    // Step 13 (Rocky Helmet): floor(120 / 6) = 20 damage >= 15 hp -> attacker FAINTS (hp = 0).
    // Step 23 (Recoil): REQUIRE(IsBattlerAlive) -> skipped!
    // Step 26 (Life Orb): REQUIRE(IsBattlerAlive) -> skipped!
    // Total attackerDamage = 20.
    const state = battle([{ hp: 15, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_DOUBLE_EDGE), null],
      testDepsWithDamage(fixedDamage(60), { 0: 'HOLD_EFFECT_LIFE_ORB', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(0)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(20) // Only the 20 damage from helmet, no recoil or Life Orb added
    expect(act.fainted).toContain(0)
  })

  it('applies Rocky Helmet (13) + Recoil (23) + Life Orb (26) in order when attacker survives all three', () => {
    // Attacker: maxHp 120, hp 120. Holds Life Orb.
    // Target: holds Rocky Helmet, takes 60 damage from Double-Edge.
    // Step 13 (Rocky Helmet): floor(120 / 6) = 20 damage -> hp becomes 100.
    // Step 23 (Recoil): floor(60 / 3) = 20 damage -> hp becomes 80.
    // Step 26 (Life Orb): floor(120 / 10) = 12 damage -> hp becomes 68.
    // Total attackerDamage = 20 + 20 + 12 = 52.
    const state = battle([{ hp: 120, maxHp: 120 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(
      state,
      [useMove(1, MOVE_DOUBLE_EDGE), null],
      testDepsWithDamage(fixedDamage(60), { 0: 'HOLD_EFFECT_LIFE_ORB', 1: 'HOLD_EFFECT_ROCKY_HELMET' }),
    )

    expect(state.battlers[0]!.mon.hp).toBe(68)
    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.attackerDamage).toBe(52)
  })
})

describe('State Bookkeeping & Clear Bits', () => {
  it('MOVEEND_UPDATE_LAST_MOVES (17): updates attacker.lastMove', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    expect(state.battlers[0]!.lastMove).toBeNull()

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[0]!.lastMove).toBe('MOVE_TACKLE')
  })

  it('MOVEEND_CHARGE (24): clears STATUS3_CHARGED_UP on Electric damaging move', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    state.battlers[0]!.statuses3 |= STATUS3_CHARGED_UP
    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(true)

    executeTurn(state, [useMove(1, MOVE_THUNDERBOLT), null], testDepsWithDamage(fixedDamage(50)))

    expect(hasFlag(state.battlers[0]!.statuses3, STATUS3_CHARGED_UP)).toBe(false)
  })

  it('MOVEEND_SUBSTITUTE (16): clears STATUS2_SUBSTITUTE and sets substituteDestroyedThisTurn if substituteHp is 0', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    state.battlers[1]!.mon.status2 |= STATUS2_SUBSTITUTE
    state.battlers[1]!.volatiles.substituteHp = 0
    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(true)

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(hasFlag(state.battlers[1]!.mon.status2, STATUS2_SUBSTITUTE)).toBe(false)
    expect(state.battlers[1]!.volatiles.substituteDestroyedThisTurn).toBe(true)
  })

  it('MOVEEND_CLEAR_BITS (30): resets rolloutCounter, targetAffected, gemBoost, berryReduced', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    state.battlers[0]!.volatiles.rolloutCounter = 3
    state.battlers[0]!.round.targetAffected = true
    state.battlers[0]!.turn.gemBoost = true
    state.battlers[1]!.turn.berryReduced = true

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(20)))

    expect(state.battlers[0]!.volatiles.rolloutCounter).toBe(0)
    expect(state.battlers[0]!.round.targetAffected).toBe(false)
    expect(state.battlers[0]!.turn.gemBoost).toBe(false)
    expect(state.battlers[1]!.turn.berryReduced).toBe(false)
  })
})

describe('Conditional Gaps (Out-of-scope abilities, items, moves)', () => {
  it('conditionally gaps defender contact ability (ABILITY_ROUGH_SKIN) on damaged target', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100, abilities: { ability: ABILITY_ROUGH_SKIN, innates: [null, null, null] } }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.unmodelled).toContain('move-end defender ability ABILITY_ROUGH_SKIN is not modelled yet')
  })

  it('conditionally gaps attacker contact ability (ABILITY_POISON_TOUCH) on damaging hit', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_POISON_TOUCH, innates: [null, null, null] } }, { hp: 100, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.unmodelled).toContain('move-end attacker ability ABILITY_POISON_TOUCH is not modelled yet')
  })

  it('conditionally gaps on-faint ability (ABILITY_MOXIE) when a battler faints', () => {
    const state = battle(
      [{ hp: 100, maxHp: 100, abilities: { ability: ABILITY_MOXIE, innates: [null, null, null] } }, { hp: 30, maxHp: 100 }],
      scriptedRng(),
    )
    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDepsWithDamage(fixedDamage(30)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.fainted).toContain(1)
    expect(act.unmodelled).toContain('on-faint ability ABILITY_MOXIE is not modelled yet')
  })

  it('conditionally gaps Rapid Spin hazard/binding removal', () => {
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 100, maxHp: 100 }], scriptedRng())
    const out = executeTurn(state, [useMove(1, MOVE_RAPID_SPIN), null], testDepsWithDamage(fixedDamage(20)))

    const act = out.actions.find((a) => a.battlerId === 0)!
    expect(act.unmodelled).toContain('Rapid Spin hazard/binding removal is not modelled yet')
  })
})

describe('Oracle Tests: Pinned Ability Sets & Recoil Fractions', () => {
  it('NO_RECOIL_ABILITIES pins Rock Head, Steel Barrel, Bruteforce', () => {
    expect(Array.from(NO_RECOIL_ABILITIES).sort()).toEqual([
      'ABILITY_BRUTEFORCE',
      'ABILITY_ROCK_HEAD',
      'ABILITY_STEEL_BARREL',
    ])
  })

  it('HALF_RECOIL_ABILITIES pins Daredevil, Limber', () => {
    expect(Array.from(HALF_RECOIL_ABILITIES).sort()).toEqual([
      'ABILITY_DAREDEVIL',
      'ABILITY_LIMBER',
    ])
  })

  it('RECOIL_FRACTIONS pins exact denominators for the 5 recoil effects', () => {
    expect(RECOIL_FRACTIONS).toEqual({
      EFFECT_RECOIL_25: 4,
      EFFECT_RECOIL_33: 3,
      EFFECT_RECOIL_50: 2,
      EFFECT_FLINCH_RECOIL_33: 3,
      EFFECT_FLINCH_RECOIL_50: 2,
    })
  })
})

describe('MOVEEND_RECOIL uses savedDmg', () => {
  it('recoil is a fraction of the HP actually dealt (gHpDealt, battle_script_commands.c:4335), not the overkill damage', () => {
    // Double-Edge (EFFECT_RECOIL_33) for 300 into a 90-HP target: savedDmg = 90, recoil = floor(90 / 3) = 30.
    const state = battle([{ hp: 100, maxHp: 100 }, { hp: 90, maxHp: 100 }], scriptedRng())
    executeTurn(state, [useMove(1, MOVE_DOUBLE_EDGE), null], testDepsWithDamage(fixedDamage(300)))
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(70)
  })
})
