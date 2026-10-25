// Test suite verifying turn-loop held item ports against C behavior
// (src/battle_script_commands.c, src/battle_util.c, src/battle_main.c, data/battle_scripts_1.s).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import {
  DEFAULT_STAT_STAGE,
  STAT_ATK,
  STAT_DEF,
  STAT_SPEED,
  STAT_SPATK,
  STATUS1_BURN,
  STATUS1_FROSTBITE,
  STATUS1_PARALYSIS,
  STATUS1_TOXIC_POISON,
  STATUS3_EMBARGO,
  hasFlag,
} from './constants'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'
import type { GroundingContext } from './grounding'
import type { SimDataContext, SimItemData, SimMoveData } from './dataContext'
import type { TypeChart } from '../typeEffectiveness'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { buildAccuracyInputs } from './accuracyBridge'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const snapshot = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
const rawMoves = snapshot<Array<Record<string, unknown>>>('moves.json')
const movesById = new Map(rawMoves.map((m) => [m.id as string, m]))
const abilityIds = new Set(snapshot<Array<{ id: string }>>('abilities.json').map((a) => a.id))
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
    pp: m.pp as number,
  }
}

function requireAbility(id: string): string {
  if (!abilityIds.has(id)) throw new Error(`abilities.json has no ${id}`)
  return id
}

function requireItem(id: string): SimItemData {
  const item = itemsById.get(id)
  if (!item) throw new Error(`items.json has no ${id}`)
  return item
}

const MOVE_TACKLE = requireMove('MOVE_TACKLE')
const MOVE_SWORDS_DANCE = requireMove('MOVE_SWORDS_DANCE')
const MOVE_HYPER_VOICE = requireMove('MOVE_HYPER_VOICE')

const ABILITY_UNNERVE = requireAbility('ABILITY_UNNERVE')
const ABILITY_KLUTZ = requireAbility('ABILITY_KLUTZ')
const ABILITY_RIPEN = requireAbility('ABILITY_RIPEN')
const ABILITY_GLUTTONY = requireAbility('ABILITY_GLUTTONY')
const ABILITY_MAGIC_GUARD = requireAbility('ABILITY_MAGIC_GUARD')

requireItem('ITEM_FOCUS_SASH')
requireItem('ITEM_LEFTOVERS')
requireItem('ITEM_BLACK_SLUDGE')
requireItem('ITEM_SITRUS_BERRY')
requireItem('ITEM_ORAN_BERRY')
requireItem('ITEM_WHITE_HERB')
requireItem('ITEM_LUM_BERRY')
requireItem('ITEM_SALAC_BERRY')
requireItem('ITEM_FIGY_BERRY')
requireItem('ITEM_TOXIC_ORB')
requireItem('ITEM_FLAME_ORB')
requireItem('ITEM_FROST_ORB')
requireItem('ITEM_STICKY_BARB')
requireItem('ITEM_WEAKNESS_POLICY')
requireItem('ITEM_THROAT_SPRAY')
requireItem('ITEM_CUSTAP_BERRY')
requireItem('ITEM_AIR_BALLOON')
requireItem('ITEM_OCCA_BERRY')
requireItem('ITEM_WIDE_LENS')
requireItem('ITEM_BRIGHT_POWDER')

const RATIOS: [number, number][] = [
  [2, 8], [2, 7], [2, 6], [2, 5], [2, 4], [2, 3], [1, 1], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2],
]

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
    hp?: number
    maxHp?: number
    abilities?: SimBattleMon['abilities']
    moves?: SimBattleMon['moves']
    types?: [string, string, string]
    itemId?: string | null
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
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe ?? (i === 0 ? 100 : 50) },
          hp: s.hp ?? 100,
          maxHp: s.maxHp ?? 100,
          abilities: s.abilities ?? { ability: null, innates: [null, null, null] },
          moves: s.moves ?? ['MOVE_TACKLE', null, null, null],
          types: s.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY'],
          itemId: s.itemId ?? null,
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

function testGrounding(state: BattleState): GroundingContext {
  return {
    holdEffectOf: (battlerId) => {
      const b = state.battlers[battlerId]
      if (!b || !b.mon.itemId) return null
      if (hasFlag(b.statuses3, STATUS3_EMBARGO)) return null
      if (b.mon.abilities.ability === 'ABILITY_KLUTZ' || b.mon.abilities.innates.includes('ABILITY_KLUTZ')) return null
      return itemsById.get(b.mon.itemId)?.resolvedHoldEffect ?? null
    },
    monotypeChampType: null,
    isCluelessOnField: false,
    attackerHasMoldBreaker: false,
  }
}

function testDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return {
    turnOrder: rest,
    grounding: testGrounding(state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart, inverseTypeChart, inverseBattle: false },
  }
}

// ---------------------------------------------------------------------------
// 1. Focus Sash (Cmd_adjustdamage, battle_script_commands.c:1645-1673)
// ---------------------------------------------------------------------------
describe('Focus Sash', () => {
  it('survives a lethal hit at 100% HP with 1 HP and consumes the sash', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_FOCUS_SASH' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 150, attackerDamage: null, unmodelled: [], hpDealt: 150 }),
    }

    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.hp).toBe(1)
    expect(defender.mon.itemId).toBeNull()
    const action = out.actions[0]!
    expect(action.targetDamage).toBe(99)
  })

  it('does NOT trigger if HP is below 100%, and defender faints without consuming sash', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 99, maxHp: 100, itemId: 'ITEM_FOCUS_SASH' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 150, attackerDamage: null, unmodelled: [], hpDealt: 150 }),
    }

    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.hp).toBe(0)
    expect(defender.mon.itemId).toBe('ITEM_FOCUS_SASH')
    const action = out.actions[0]!
    expect(action.targetDamage).toBe(150)
  })

  it('does NOT trigger under Unnerve on opposing side', () => {
    const rng = countingRng()
    const state = battle(
      [
        { spe: 100, abilities: { ability: ABILITY_UNNERVE, innates: [null, null, null] } },
        { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_FOCUS_SASH' },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 150, attackerDamage: null, unmodelled: [], hpDealt: 150 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.hp).toBe(0)
  })

  it('does NOT trigger when item is negated by Klutz', () => {
    const rng = countingRng()
    const state = battle(
      [
        { spe: 100 },
        { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_FOCUS_SASH', abilities: { ability: ABILITY_KLUTZ, innates: [null, null, null] } },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 150, attackerDamage: null, unmodelled: [], hpDealt: 150 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.hp).toBe(0)
  })

  it('does NOT consume Focus Sash if Endure already preserved 1 HP', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_FOCUS_SASH' }],
      rng,
    )
    state.battlers[1]!.round.endured = true
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 150, attackerDamage: null, unmodelled: [], hpDealt: 150 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.hp).toBe(1)
    // In C (battle_script_commands.c:1675-1679), sash is NOT consumed if endured
    expect(defender.mon.itemId).toBe('ITEM_FOCUS_SASH')
  })
})

// ---------------------------------------------------------------------------
// 2. Resist Berries (Cmd_adjustdamage, battle_script_commands.c:1693-1697)
// ---------------------------------------------------------------------------
describe('Resist Berries', () => {
  it('consumes resist berry on super-effective hit that was berry-reduced', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_OCCA_BERRY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({
        targetDamage: 40,
        attackerDamage: null,
        unmodelled: [],
        hpDealt: 40,
        berryReduced: true,
        isSuperEffective: true,
      }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.hp).toBe(60)
    expect(defender.mon.itemId).toBeNull()
  })

  it('does NOT consume resist berry when Unnerve is active on opposing side', () => {
    const rng = countingRng()
    const state = battle(
      [
        { spe: 100, abilities: { ability: ABILITY_UNNERVE, innates: [null, null, null] } },
        { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_OCCA_BERRY' },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({
        targetDamage: 80,
        attackerDamage: null,
        unmodelled: [],
        hpDealt: 80,
        berryReduced: false,
        isSuperEffective: true,
      }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.itemId).toBe('ITEM_OCCA_BERRY')
  })
})

// ---------------------------------------------------------------------------
// 3. Custap Berry (battle_main.c:4411-4414, :4616)
// ---------------------------------------------------------------------------
describe('Custap Berry', () => {
  it('allows slower battler at <= 25% HP to move first and consumes berry upon move use', () => {
    const rng = countingRng()
    // Battler 0 has speed 100, Battler 1 has speed 10 with Custap at 25/100 HP
    const state = battle(
      [{ spe: 100 }, { spe: 10, hp: 25, maxHp: 100, itemId: 'ITEM_CUSTAP_BERRY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [], hpDealt: 10 }),
    }

    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), useMove(0, MOVE_TACKLE)], testDeps(state, dmg))
    // Battler 1 moved first because Custap gave priority
    expect(out.actions[0]!.battlerId).toBe(1)
    expect(out.actions[1]!.battlerId).toBe(0)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('does NOT activate above 25% HP without Gluttony', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 10, hp: 26, maxHp: 100, itemId: 'ITEM_CUSTAP_BERRY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [], hpDealt: 10 }),
    }

    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), useMove(0, MOVE_TACKLE)], testDeps(state, dmg))
    // Slower battler moves second
    expect(out.actions[0]!.battlerId).toBe(0)
    expect(out.actions[1]!.battlerId).toBe(1)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_CUSTAP_BERRY')
  })

  it('activates at <= 50% HP with Gluttony', () => {
    const rng = countingRng()
    const state = battle(
      [
        { spe: 100 },
        { spe: 10, hp: 50, maxHp: 100, itemId: 'ITEM_CUSTAP_BERRY', abilities: { ability: ABILITY_GLUTTONY, innates: [null, null, null] } },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [], hpDealt: 10 }),
    }

    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), useMove(0, MOVE_TACKLE)], testDeps(state, dmg))
    expect(out.actions[0]!.battlerId).toBe(1)
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('does NOT activate under Unnerve', () => {
    const rng = countingRng()
    const state = battle(
      [
        { spe: 100, abilities: { ability: ABILITY_UNNERVE, innates: [null, null, null] } },
        { spe: 10, hp: 25, maxHp: 100, itemId: 'ITEM_CUSTAP_BERRY' },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [], hpDealt: 10 }),
    }

    const out = executeTurn(state, [useMove(1, MOVE_TACKLE), useMove(0, MOVE_TACKLE)], testDeps(state, dmg))
    expect(out.actions[0]!.battlerId).toBe(0)
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_CUSTAP_BERRY')
  })
})

// ---------------------------------------------------------------------------
// 4. Air Balloon (MOVEEND_ITEM_EFFECTS_TARGET, battle_util.c:6154-6159)
// ---------------------------------------------------------------------------
describe('Air Balloon', () => {
  it('pops when holder is damaged by an attack', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_AIR_BALLOON' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 30, attackerDamage: null, unmodelled: [], hpDealt: 30 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    expect(state.battlers[1]!.mon.itemId).toBeNull()
  })

  it('does NOT pop on status moves', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_AIR_BALLOON' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [useMove(1, MOVE_SWORDS_DANCE), null], testDeps(state, dmg))
    expect(state.battlers[1]!.mon.itemId).toBe('ITEM_AIR_BALLOON')
  })
})

// ---------------------------------------------------------------------------
// 5. Weakness Policy (MOVEEND_ITEM_EFFECTS_TARGET, battle_util.c:6171-6176)
// ---------------------------------------------------------------------------
describe('Weakness Policy', () => {
  it('raises Atk and SpAtk by +2 on super-effective hit and is consumed', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_WEAKNESS_POLICY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 40, attackerDamage: null, unmodelled: [], hpDealt: 40, isSuperEffective: true }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(defender.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 2)
    expect(defender.mon.itemId).toBeNull()
  })

  it('does NOT trigger on non-super-effective hit', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_WEAKNESS_POLICY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 40, attackerDamage: null, unmodelled: [], hpDealt: 40, isSuperEffective: false }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.statStages[STAT_ATK]).toBe(DEFAULT_STAT_STAGE)
    expect(defender.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(defender.mon.itemId).toBe('ITEM_WEAKNESS_POLICY')
  })
})

// ---------------------------------------------------------------------------
// 6. Throat Spray (MOVEEND_LIFEORB_SHELLBELL, battle_util.c:6111-6124)
// ---------------------------------------------------------------------------
describe('Throat Spray', () => {
  it('raises SpAtk by +1 when user executes a damaging sound move', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, itemId: 'ITEM_THROAT_SPRAY' }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 40, attackerDamage: null, unmodelled: [], hpDealt: 40 }),
    }

    executeTurn(state, [useMove(1, MOVE_HYPER_VOICE), null], testDeps(state, dmg))
    const attacker = state.battlers[0]!
    expect(attacker.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(attacker.mon.itemId).toBeNull()
  })

  it('does NOT trigger on non-sound moves', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, itemId: 'ITEM_THROAT_SPRAY' }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 40, attackerDamage: null, unmodelled: [], hpDealt: 40 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const attacker = state.battlers[0]!
    expect(attacker.mon.statStages[STAT_SPATK]).toBe(DEFAULT_STAT_STAGE)
    expect(attacker.mon.itemId).toBe('ITEM_THROAT_SPRAY')
  })
})

// ---------------------------------------------------------------------------
// 7. Move-End Berries & Herbs (MOVEEND_ITEM_EFFECTS_ALL, battle_util.c:5874-6033)
// ---------------------------------------------------------------------------
describe('Move-End Berries & Herbs', () => {
  it('Sitrus Berry restores 25% max HP when damaged to <= 50%', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 60, attackerDamage: null, unmodelled: [], hpDealt: 60 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    // 100 - 60 = 40 HP (<= 50%), heals 25 HP -> 65 HP
    expect(defender.mon.hp).toBe(65)
    expect(defender.mon.itemId).toBeNull()
  })

  it('Sitrus Berry with Ripen doubles heal to 50% max HP', () => {
    const rng = countingRng()
    const state = battle(
      [
        { spe: 100 },
        { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY', abilities: { ability: ABILITY_RIPEN, innates: [null, null, null] } },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 60, attackerDamage: null, unmodelled: [], hpDealt: 60 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    // 100 - 60 = 40 HP, heals 25 * 2 = 50 HP -> 90 HP
    expect(defender.mon.hp).toBe(90)
    expect(defender.mon.itemId).toBeNull()
  })

  it('Oran Berry restores 10 flat HP at <= 50%', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_ORAN_BERRY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 60, attackerDamage: null, unmodelled: [], hpDealt: 60 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    // 100 - 60 = 40 HP, heals 10 -> 50 HP
    expect(defender.mon.hp).toBe(50)
    expect(defender.mon.itemId).toBeNull()
  })

  it('Figy Berry restores maxHp/2 at <= 25%', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_FIGY_BERRY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 80, attackerDamage: null, unmodelled: [], hpDealt: 80 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    // 100 - 80 = 20 HP (<= 25%), heals maxHp / holdEffectParam(2) = 50 -> 70 HP (HealConfuseBerry, battle_util.c:5171)
    expect(defender.mon.hp).toBe(70)
    expect(defender.mon.itemId).toBeNull()
  })

  it('Salac Berry boosts Speed by +1 at <= 25%', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_SALAC_BERRY' }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 80, attackerDamage: null, unmodelled: [], hpDealt: 80 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(defender.mon.itemId).toBeNull()
  })

  it('Salac Berry triggers at <= 50% with Gluttony', () => {
    const rng = countingRng()
    const state = battle(
      [
        { spe: 100 },
        { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_SALAC_BERRY', abilities: { ability: ABILITY_GLUTTONY, innates: [null, null, null] } },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 60, attackerDamage: null, unmodelled: [], hpDealt: 60 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    // 40 HP is <= 50%, Gluttony activates Salac Berry
    expect(defender.mon.statStages[STAT_SPEED]).toBe(DEFAULT_STAT_STAGE + 1)
    expect(defender.mon.itemId).toBeNull()
  })

  it('White Herb restores lowered stat stage back to neutral', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_WHITE_HERB' }],
      rng,
    )
    state.battlers[1]!.mon.statStages[STAT_DEF] = DEFAULT_STAT_STAGE - 2
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [], hpDealt: 10 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.statStages[STAT_DEF]).toBe(DEFAULT_STAT_STAGE)
    expect(defender.mon.itemId).toBeNull()
  })

  it('Lum Berry cures status condition at move end', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100 }, { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_LUM_BERRY', status1: STATUS1_PARALYSIS }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 10, attackerDamage: null, unmodelled: [], hpDealt: 10 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.status1).toBe(0)
    expect(defender.mon.itemId).toBeNull()
  })

  it('Unnerve prevents all berries from activating at move end', () => {
    const rng = countingRng()
    const state = battle(
      [
        { spe: 100, abilities: { ability: ABILITY_UNNERVE, innates: [null, null, null] } },
        { spe: 50, hp: 100, maxHp: 100, itemId: 'ITEM_SITRUS_BERRY' },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: 60, attackerDamage: null, unmodelled: [], hpDealt: 60 }),
    }

    executeTurn(state, [useMove(1, MOVE_TACKLE), null], testDeps(state, dmg))
    const defender = state.battlers[1]!
    expect(defender.mon.hp).toBe(40)
    expect(defender.mon.itemId).toBe('ITEM_SITRUS_BERRY')
  })
})

// ---------------------------------------------------------------------------
// 8. Leftovers & Black Sludge (ENDTURN_ITEMS1, battle_util.c:5694-5716)
// ---------------------------------------------------------------------------
describe('Leftovers and Black Sludge', () => {
  it('Leftovers heals floor(maxHp/16) at end of turn', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, hp: 80, maxHp: 100, itemId: 'ITEM_LEFTOVERS' }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    const out = executeTurn(state, [null, null], testDeps(state, dmg))
    expect(state.battlers[0]!.mon.hp).toBe(86) // 80 + 6 = 86
    expect(out.endTurn).toContainEqual({ battlerId: 0, effect: 'ITEM', hpChange: 6, fainted: false })
  })

  it('Black Sludge heals Poison-types by floor(maxHp/16)', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, hp: 80, maxHp: 100, itemId: 'ITEM_BLACK_SLUDGE', types: ['POISON', 'MYSTERY', 'MYSTERY'] }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    expect(state.battlers[0]!.mon.hp).toBe(86)
  })

  it('Black Sludge damages non-Poison types by floor(maxHp/8)', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, hp: 100, maxHp: 100, itemId: 'ITEM_BLACK_SLUDGE', types: ['NORMAL', 'MYSTERY', 'MYSTERY'] }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    const out = executeTurn(state, [null, null], testDeps(state, dmg))
    expect(state.battlers[0]!.mon.hp).toBe(88) // 100 - 12 = 88
    expect(out.endTurn).toContainEqual({ battlerId: 0, effect: 'ITEM', hpChange: -12, fainted: false })
  })

  it('Black Sludge does not damage non-Poison types with Magic Guard', () => {
    const rng = countingRng()
    const state = battle(
      [
        {
          spe: 100,
          hp: 100,
          maxHp: 100,
          itemId: 'ITEM_BLACK_SLUDGE',
          types: ['NORMAL', 'MYSTERY', 'MYSTERY'],
          abilities: { ability: ABILITY_MAGIC_GUARD, innates: [null, null, null] },
        },
        { spe: 50 },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Leftovers is inactive under Klutz or Embargo', () => {
    const rng = countingRng()
    const state = battle(
      [
        {
          spe: 100,
          hp: 80,
          maxHp: 100,
          itemId: 'ITEM_LEFTOVERS',
          abilities: { ability: ABILITY_KLUTZ, innates: [null, null, null] },
        },
        { spe: 50 },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    expect(state.battlers[0]!.mon.hp).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// 9. Status Orbs & Sticky Barb (ENDTURN_ORBS, battle_util.c:6252-6288)
// ---------------------------------------------------------------------------
describe('Status Orbs and Sticky Barb', () => {
  it('Toxic Orb inflicts toxic poison at end of turn, dealing bad poison damage', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, hp: 100, maxHp: 100, itemId: 'ITEM_TOXIC_ORB' }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    const holder = state.battlers[0]!
    expect(holder.mon.status1 & STATUS1_TOXIC_POISON).toBe(STATUS1_TOXIC_POISON)
    expect(holder.mon.hp).toBe(94) // 100 - floor(100/16) = 94
  })

  it('Flame Orb inflicts burn at end of turn, dealing burn damage', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, hp: 100, maxHp: 100, itemId: 'ITEM_FLAME_ORB' }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    const holder = state.battlers[0]!
    expect(holder.mon.status1 & STATUS1_BURN).toBe(STATUS1_BURN)
    expect(holder.mon.hp).toBe(94) // 100 - floor(100/16) = 94
  })

  it('Frost Orb inflicts frostbite at end of turn', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, hp: 100, maxHp: 100, itemId: 'ITEM_FROST_ORB' }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    const holder = state.battlers[0]!
    expect(holder.mon.status1 & STATUS1_FROSTBITE).toBe(STATUS1_FROSTBITE)
  })

  it('Sticky Barb deals 1/8 max HP damage at end of turn unless Magic Guard', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, hp: 100, maxHp: 100, itemId: 'ITEM_STICKY_BARB' }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    expect(state.battlers[0]!.mon.hp).toBe(88) // 100 - 12 = 88
  })

  it('Toxic Orb does not poison Poison-type holders', () => {
    const rng = countingRng()
    const state = battle(
      [{ spe: 100, hp: 100, maxHp: 100, itemId: 'ITEM_TOXIC_ORB', types: ['POISON', 'MYSTERY', 'MYSTERY'] }, { spe: 50 }],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    expect(state.battlers[0]!.mon.status1).toBe(0)
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('Status orbs do not activate under Klutz or Embargo', () => {
    const rng = countingRng()
    const state = battle(
      [
        {
          spe: 100,
          hp: 100,
          maxHp: 100,
          itemId: 'ITEM_TOXIC_ORB',
          abilities: { ability: ABILITY_KLUTZ, innates: [null, null, null] },
        },
        { spe: 50 },
      ],
      rng,
    )
    const dmg: DamageResolver = {
      resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }),
    }

    executeTurn(state, [null, null], testDeps(state, dmg))
    expect(state.battlers[0]!.mon.status1).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 10. Accuracy Bridge Negation (Wide Lens, Bright Powder)
// ---------------------------------------------------------------------------
describe('Accuracy Bridge Item Negation', () => {
  it('Wide Lens provides hold effect when not negated, but is negated by Klutz', () => {
    const rng = countingRng()
    const normalState = battle(
      [{ spe: 100, itemId: 'ITEM_WIDE_LENS' }, { spe: 50 }],
      rng,
    )
    const normalInputs = buildAccuracyInputs(normalState, 0, 1, 'MOVE_TACKLE', false, {
      grounding: testGrounding(normalState),
      dataContext: DATA_CONTEXT,
    })
    expect(normalInputs.inputs.attackerHoldEffect).toBe('HOLD_EFFECT_WIDE_LENS')

    const klutzState = battle(
      [
        { spe: 100, itemId: 'ITEM_WIDE_LENS', abilities: { ability: ABILITY_KLUTZ, innates: [null, null, null] } },
        { spe: 50 },
      ],
      rng,
    )
    const klutzInputs = buildAccuracyInputs(klutzState, 0, 1, 'MOVE_TACKLE', false, {
      grounding: testGrounding(klutzState),
      dataContext: DATA_CONTEXT,
    })
    expect(klutzInputs.inputs.attackerHoldEffect).toBeNull()
  })

  it('Bright Powder provides hold effect when not negated, but is negated by Embargo', () => {
    const rng = countingRng()
    const normalState = battle(
      [{ spe: 100 }, { spe: 50, itemId: 'ITEM_BRIGHT_POWDER' }],
      rng,
    )
    const normalInputs = buildAccuracyInputs(normalState, 0, 1, 'MOVE_TACKLE', false, {
      grounding: testGrounding(normalState),
      dataContext: DATA_CONTEXT,
    })
    expect(normalInputs.inputs.defenderHoldEffect).toBe('HOLD_EFFECT_EVASION_UP')

    const embargoState = battle(
      [{ spe: 100 }, { spe: 50, itemId: 'ITEM_BRIGHT_POWDER' }],
      rng,
    )
    embargoState.battlers[1]!.statuses3 |= STATUS3_EMBARGO
    const embargoInputs = buildAccuracyInputs(embargoState, 0, 1, 'MOVE_TACKLE', false, {
      grounding: testGrounding(embargoState),
      dataContext: DATA_CONTEXT,
    })
    expect(embargoInputs.inputs.defenderHoldEffect).toBeNull()
  })
})
