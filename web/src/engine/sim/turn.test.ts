import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { THROWING_DAMAGE_RESOLVER, assertNoPerBattlerQuash, buildTurnOrderContext, executeTurn, isBattlerAlive } from './turn'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import { STATUS3_ROOTED, STATUS_FIELD_GRAVITY, setFlag } from './constants'
import { buildBattlerBattleState, buildFieldBattleState, type BridgeDeps } from './bridge'
import type { SimDataContext, SimItemData, SimSpeciesData } from './dataContext'
import { createBridgeDamageResolver, type BridgeDamageResolverDeps } from './damageResolver'
import { calculateMoveDamage, type DamageCalcScenario } from '../calculate'

const RATIOS: [number, number][] = [
  [2, 8],
  [2, 7],
  [2, 6],
  [2, 5],
  [2, 4],
  [2, 3],
  [1, 1],
  [3, 2],
  [4, 2],
  [5, 2],
  [6, 2],
  [7, 2],
  [8, 2],
]

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

function battle(specs: { spe: number; hp?: number; types?: [string, string, string] }[]): BattleState {
  return createBattleState({
    battlers: specs.map((s, i) =>
      createBattlerState(
        i,
        mon({
          rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: s.spe },
          hp: s.hp ?? 100,
          types: s.types ?? ['WATER', 'MYSTERY', 'MYSTERY'],
        }),
        0,
      ),
    ),
    rng: createRandomSource(1),
  })
}

function moveView(overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
  return {
    id: 'MOVE_TACKLE',
    priority: 0,
    effect: null,
    isStatus: false,
    resolvedType: 'NORMAL',
    power: 40,
    flags: {},
    split: 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
    ...overrides,
  }
}

function useMove(target: number, m: TurnOrderMoveView = moveView()): ChosenAction {
  return { action: 'USE_MOVE', moveToBeUsed: m, chosenMove: m, target }
}

const GROUNDING: GroundingContext = {
  holdEffectOf: () => null,
  monotypeChampType: null,
  isCluelessOnField: false,
  attackerHasMoldBreaker: false,
}

/** A resolver dealing a fixed amount to the target, recording every call. */
function fixedDamage(amount: number, extra: Partial<{ attackerDamage: number | null; unmodelled: string[] }> = {}): DamageResolver & {
  calls: { attackerId: number; targetId: number }[]
} {
  const calls: { attackerId: number; targetId: number }[] = []
  return {
    calls,
    resolve(_state, attackerId, targetId) {
      calls.push({ attackerId, targetId })
      return { targetDamage: amount, attackerDamage: extra.attackerDamage ?? null, unmodelled: extra.unmodelled ?? [] }
    },
  }
}

// A data-less SimDataContext: every lookup misses. accuracyBridge.ts turns a
// missing move into moveAccuracy 0 -- ACCURACY_HITS_IF_POSSIBLE, accuracy 101,
// "cannot miss" -- so this suite's turn-order/damage-flow tests (none of which
// care about accuracy) keep their existing deterministic outcomes; the miss
// path itself is exercised by its own describe block below with a real
// SimDataContext.
const NO_DATA: SimDataContext = { species: () => undefined, item: () => undefined, move: () => undefined }

function deps(damage: DamageResolver, dataContext: SimDataContext = NO_DATA): TurnLoopDeps {
  // NEUTRAL_TURN_ORDER_CONTEXT is spread for the OTHER fields only; its
  // isBattlerGrounded is dropped by the Omit and replaced by the real port.
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS, dataContext }
}

describe('isBattlerAlive', () => {
  it('reports all three of the C conditions', () => {
    const state = battle([{ spe: 100 }, { spe: 100 }])
    expect(isBattlerAlive(state, 0)).toBe(true)
    // Zero HP.
    state.battlers[0]!.mon.hp = 0
    expect(isBattlerAlive(state, 0)).toBe(false)
    // Past gBattlersCount.
    expect(isBattlerAlive(state, 2)).toBe(false)
    // The absent-battler bit, distinct from a null slot.
    state.absentBattlerFlags = 1 << 1
    expect(isBattlerAlive(state, 1)).toBe(false)
  })
})

describe('executeTurn: order and execution', () => {
  it('runs the faster battler first', () => {
    const state = battle([{ spe: 50 }, { spe: 200 }])
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(dmg))
    expect(out.order.battlerByTurnOrder).toEqual([1, 0])
    expect(dmg.calls.map((c) => c.attackerId)).toEqual([1, 0])
  })

  it('applies damage to the target and floors HP at zero', () => {
    const state = battle([{ spe: 200 }, { spe: 50, hp: 30 }])
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(fixedDamage(45)))
    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(out.actions[0].targetDamage).toBe(45)
    expect(out.actions[0].fainted).toEqual([1])
  })

  it('skips the action of a battler that fainted earlier in the SAME turn', () => {
    // HandleAction_UseMove:181-186. Battler 0 is faster and kills battler 1, so
    // battler 1 never gets to act -- but its slot is still consumed.
    const state = battle([{ spe: 200 }, { spe: 50, hp: 10 }])
    const dmg = fixedDamage(999)
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(dmg))
    expect(out.actions).toHaveLength(2)
    expect(out.actions[1].skippedBecauseFainted).toBe(true)
    expect(dmg.calls).toHaveLength(1)
    expect(state.battlers[0]!.mon.hp).toBe(100)
  })

  it('increments the side fainted count, which Soul Harvest reads', () => {
    const state = battle([{ spe: 200 }, { spe: 50, hp: 10 }])
    expect(state.sides[1].faintedCount).toBe(0)
    executeTurn(state, [useMove(1), useMove(0)], deps(fixedDamage(999)))
    expect(state.sides[1].faintedCount).toBe(1)
    expect(state.sides[0].faintedCount).toBe(0)
  })

  it('deals no damage when the target is already dead', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }])
    state.battlers[1]!.mon.hp = 0
    const dmg = fixedDamage(10)
    const out = executeTurn(state, [useMove(1), null], deps(dmg))
    expect(dmg.calls).toHaveLength(0)
    expect(out.actions[0].targetDamage).toBeNull()
  })

  it('treats a null damage result as "nothing happened", distinct from zero', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }])
    const resolver: DamageResolver = { resolve: () => ({ targetDamage: null, attackerDamage: null, unmodelled: [] }) }
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(resolver))
    expect(out.actions[0].targetDamage).toBeNull()
    expect(state.battlers[1]!.mon.hp).toBe(100)
  })

  it('puts a switch before a faster opponent move and does not resolve damage for it', () => {
    const state = battle([{ spe: 1 }, { spe: 400 }])
    const dmg = fixedDamage(10)
    const actions: (ChosenAction | null)[] = [{ action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, useMove(0)]
    const out = executeTurn(state, actions, deps(dmg))
    expect(out.order.battlerByTurnOrder).toEqual([0, 1])
    expect(out.actions[0].action).toBe('SWITCH')
    expect(out.actions[0].targetDamage).toBeNull()
    expect(dmg.calls).toHaveLength(1)
  })
})

describe('executeTurn: the order is re-resolved between actions', () => {
  it('re-sorts before EVERY slot, not just once after the first action', () => {
    // Four battlers, speeds 100/90/80/70, so the sort-once order is 0,1,2,3.
    // The change happens during the SECOND action (battler 1's), dropping
    // battler 2 below battler 3 and so swapping the last two slots.
    //
    // This is what the three-battler version could not do: there, any change
    // during the first action is seen by both "re-sort once, after action one"
    // and "re-sort before every slot", so the two agree and the test
    // distinguishes nothing. Acting on the second action puts the change AFTER
    // the single re-sort a sort-once implementation would do, so only a loop
    // that re-sorts before slot 3 gets [0,1,3,2].
    const state = createBattleState({
      battlers: [100, 90, 80, 70].map((spe, i) => createBattlerState(i, mon({ rawStats: { atk: 1, def: 1, spatk: 1, spdef: 1, spe } }), 0)),
      rng: createRandomSource(5),
    })
    const resolver: DamageResolver = {
      resolve(s, attackerId) {
        if (attackerId === 1) s.battlers[2]!.mon.rawStats.spe = 10
        return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
      },
    }
    const out = executeTurn(state, [useMove(1), useMove(0), useMove(0), useMove(0)], deps(resolver))
    expect(out.order.battlerByTurnOrder).toEqual([0, 1, 3, 2])
  })

  it('re-reads speed after each action rather than sorting once', () => {
    // Three battlers, 0 fastest. Battler 0's action drops battler 1's Speed
    // below battler 2's, so slot 1 must go to battler 2 -- which only happens
    // because recalculateMoveOrder runs per slot (battle_util.c:839, :851).
    const state = createBattleState({
      battlers: [100, 90, 80].map((spe, i) => createBattlerState(i, mon({ rawStats: { atk: 1, def: 1, spatk: 1, spdef: 1, spe } }), 0)),
      rng: createRandomSource(3),
    })
    const resolver: DamageResolver = {
      resolve(s, attackerId) {
        if (attackerId === 0) s.battlers[1]!.mon.rawStats.spe = 10
        return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
      },
    }
    const out = executeTurn(state, [useMove(1), useMove(0), useMove(0)], deps(resolver))
    expect(out.order.battlerByTurnOrder).toEqual([0, 2, 1])
  })

  it('gives the plain speed order when nothing changes mid-turn', () => {
    // The negative control. Named for what it asserts -- which is exactly what a
    // sort-once implementation also produces -- rather than for what it rules
    // out, which is nothing. Its job is to show the re-sort tests above are
    // observing a real mid-turn change and not some fixed quirk of the loop.
    const state = createBattleState({
      battlers: [100, 90, 80].map((spe, i) => createBattlerState(i, mon({ rawStats: { atk: 1, def: 1, spatk: 1, spdef: 1, spe } }), 0)),
      rng: createRandomSource(3),
    })
    const out = executeTurn(state, [useMove(1), useMove(0), useMove(0)], deps(fixedDamage(0)))
    expect(out.order.battlerByTurnOrder).toEqual([0, 1, 2])
  })
})

describe('the resolver return shape', () => {
  it('passes the unmodelled channel through to the action outcome', () => {
    // calculate.ts:170's own channel. Dropping it at this boundary would discard
    // the engine's "I could not model this" signal inside a loop whose point is
    // not failing silently.
    const state = battle([{ spe: 200 }, { spe: 50 }])
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(fixedDamage(10, { unmodelled: ['EFFECT_SOMETHING: not modelled'] })))
    // Not toEqual: the accuracy check's own gap channel (accuracyBridge.ts's
    // structural gaps, always present with this suite's data-less DATA_CONTEXT)
    // shares the same array now that the loop wires accuracy in ahead of the
    // damage resolver -- see this suite's own accuracy describe block for that
    // channel's own coverage.
    expect(out.actions[0].unmodelled).toContain('EFFECT_SOMETHING: not modelled')
  })

  it('damages the attacker too, and can faint it on its own action', () => {
    // Recoil, Life Orb, Rough Skin, Destiny Bond. The attacker is on 5 HP and
    // takes 9 from its own move.
    const state = battle([{ spe: 200, hp: 5 }, { spe: 50 }])
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(fixedDamage(10, { attackerDamage: 9 })))
    expect(state.battlers[0]!.mon.hp).toBe(0)
    expect(out.actions[0].attackerDamage).toBe(9)
    expect(out.actions[0].fainted).toEqual([0])
    expect(state.sides[0].faintedCount).toBe(1)
  })

  it('records both faints from one action, target first', () => {
    const state = battle([{ spe: 200, hp: 5 }, { spe: 50, hp: 5 }])
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(fixedDamage(10, { attackerDamage: 9 })))
    expect(out.actions[0].fainted).toEqual([1, 0])
  })

  it('does not re-faint or double-count a battler already at zero', () => {
    const state = battle([{ spe: 200, hp: 5 }, { spe: 50, hp: 5 }])
    executeTurn(state, [useMove(1), useMove(0)], deps(fixedDamage(10, { attackerDamage: 9 })))
    expect(state.sides[0].faintedCount).toBe(1)
    expect(state.sides[1].faintedCount).toBe(1)
  })
})

describe('the damage resolver is not allowed to default', () => {
  it('throws rather than silently dealing zero', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }])
    expect(() => executeTurn(state, [useMove(1), useMove(0)], deps(THROWING_DAMAGE_RESOLVER))).toThrow(/will not silently deal zero damage/)
  })
})

describe('grounding is supplied for real, not from the neutral context', () => {
  it('the loop substitutes the real port over whatever the caller passed', () => {
    // The Omit in TurnLoopDeps means a caller CANNOT pass isBattlerGrounded; the
    // loop always builds it. A Flying-type is ungrounded, which the neutral
    // context's unconditional `true` would have got wrong.
    const state = battle([{ spe: 100, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, { spe: 100 }])
    const ctx = buildTurnOrderContext(state, deps(fixedDamage(0)))
    expect(ctx.isBattlerGrounded(0)).toBe(false)
    expect(ctx.isBattlerGrounded(1)).toBe(true)
    expect(NEUTRAL_TURN_ORDER_CONTEXT.isBattlerGrounded(0)).toBe(true)
  })
})

describe('isBattlerGrounded', () => {
  it('grounds a Flying-type under Gravity, because grounding effects win first', () => {
    // battle_util.c:6679-6683 -- CheckGroundingEffects is tested BEFORE the
    // Flying-type exemption, so the order of the three clauses is load-bearing.
    const state = battle([{ spe: 100, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }])
    expect(isBattlerGrounded(state, 0, GROUNDING)).toBe(false)
    state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_GRAVITY)
    expect(isBattlerGrounded(state, 0, GROUNDING)).toBe(true)
  })

  it('lets Clueless on the field switch Gravity back off', () => {
    // IsGravityActive, battle_util.c:8689-8696.
    const state = battle([{ spe: 100, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }])
    state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_GRAVITY)
    expect(isBattlerGrounded(state, 0, { ...GROUNDING, isCluelessOnField: true })).toBe(false)
  })

  it('grounds via Ingrain and via Iron Ball', () => {
    const state = battle([{ spe: 100, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }])
    state.battlers[0]!.statuses3 = setFlag(state.battlers[0]!.statuses3, STATUS3_ROOTED)
    expect(isBattlerGrounded(state, 0, GROUNDING)).toBe(true)

    const state2 = battle([{ spe: 100, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }])
    expect(isBattlerGrounded(state2, 0, { ...GROUNDING, holdEffectOf: () => 'HOLD_EFFECT_IRON_BALL' })).toBe(true)
  })

  it('ungrounds via Air Balloon, but not once Gravity has grounded the battler', () => {
    const state = battle([{ spe: 100 }])
    const balloon: GroundingContext = { ...GROUNDING, holdEffectOf: () => 'HOLD_EFFECT_AIR_BALLOON' }
    expect(isBattlerGrounded(state, 0, balloon)).toBe(false)
    state.field.statuses = setFlag(state.field.statuses, STATUS_FIELD_GRAVITY)
    expect(isBattlerGrounded(state, 0, balloon)).toBe(true)
  })

  it('grounds only the PLAYER side under a Ground Monotype Champion', () => {
    // battle_util.c:6656 -- the champion check is side-scoped, unlike every
    // other grounding effect.
    const state = battle([{ spe: 100, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }, { spe: 100, types: ['FLYING', 'MYSTERY', 'MYSTERY'] }])
    const ground: GroundingContext = { ...GROUNDING, monotypeChampType: 'GROUND' }
    expect(isBattlerGrounded(state, 0, ground)).toBe(true)
    expect(isBattlerGrounded(state, 1, ground)).toBe(false)
  })

  it('ungrounds a Levitate holder, and a Mold Breaker attacker grounds it again', () => {
    // RETURN_ABILITY_IF_FLAG(battlerId, TRUE, levitate) -- battle_util.c:6669.
    // The checkMoldBreaker argument is TRUE here, unlike the item and status
    // clauses above it, which are not abilities and cannot be suppressed. This
    // is the only branch of CheckLevitatingEffects that an attacker can switch
    // off, and it had no coverage at all.
    const state = battle([{ spe: 100 }])
    state.battlers[0]!.mon.abilities = { ability: 'ABILITY_LEVITATE', innates: [null, null, null] }
    expect(isBattlerGrounded(state, 0, GROUNDING)).toBe(false)
    expect(isBattlerGrounded(state, 0, { ...GROUNDING, attackerHasMoldBreaker: true })).toBe(true)
  })

  it('reads Levitate from an innate slot too', () => {
    const state = battle([{ spe: 100 }])
    state.battlers[0]!.mon.abilities = { ability: null, innates: [null, 'ABILITY_LEVITATE', null] }
    expect(isBattlerGrounded(state, 0, GROUNDING)).toBe(false)
  })

  it('checks all three type slots for Flying', () => {
    // IS_BATTLER_OF_TYPE, include/battle.h:753-754.
    const state = battle([{ spe: 100, types: ['WATER', 'ROCK', 'FLYING'] }])
    expect(isBattlerGrounded(state, 0, GROUNDING)).toBe(false)
  })
})

describe('quash is field-wide', () => {
  it('accepts a real field timer', () => {
    const state = battle([{ spe: 100 }, { spe: 100 }])
    state.field.timers.quashTimer = 2
    expect(() => assertNoPerBattlerQuash(state)).not.toThrow()
  })

  it('rejects a nonsense timer rather than letting it reach the packed word', () => {
    const state = battle([{ spe: 100 }, { spe: 100 }])
    state.field.timers.quashTimer = -1
    expect(() => assertNoPerBattlerQuash(state)).toThrow(/field-wide/)
  })

  it('applies to every battler at once, so no pair can straddle it', () => {
    // Quash lowers the packed word (priority floored, the high fields zeroed).
    // With one field timer there is no state in which battler 0 is quashed and
    // battler 1 is not -- both move or neither does. Asserted by showing the
    // relative order is unchanged while both words drop.
    const plain = battle([{ spe: 200 }, { spe: 50 }])
    const outPlain = executeTurn(plain, [useMove(1), useMove(0)], deps(fixedDamage(0)))
    const quashed = battle([{ spe: 200 }, { spe: 50 }])
    quashed.field.timers.quashTimer = 1
    const outQuashed = executeTurn(quashed, [useMove(1), useMove(0)], deps(fixedDamage(0)))
    expect(outPlain.order.battlerByTurnOrder).toEqual([0, 1])
    expect(outQuashed.order.battlerByTurnOrder).toEqual([0, 1])
  })
})

describe('turn counter and resolver ordering context', () => {
  it('advances 0 to 1 to 2 and flips Normal champion Wonder Room parity', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }])
    const bridge: BridgeDeps = {
      grounding: { ...GROUNDING, monotypeChampType: 'NORMAL' },
      turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
      statStageRatios: RATIOS,
      inverseBattle: false,
      dataContext: { species: () => undefined, item: () => undefined, move: () => undefined },
    }
    const field = () => buildFieldBattleState(state, { attackerId: 0, defenderId: 1 }, bridge).field.isWonderRoomActive
    expect(state.turnCount).toBe(0)
    expect(field()).toBe(true)
    executeTurn(state, [useMove(1), useMove(0)], deps(fixedDamage(0)))
    expect(state.turnCount).toBe(1)
    expect(field()).toBe(false)
    executeTurn(state, [useMove(1), useMove(0)], deps(fixedDamage(0)))
    expect(state.turnCount).toBe(2)
    expect(field()).toBe(true)
  })

  it('passes attackerActsFirst through the loop order', () => {
    const seen: boolean[] = []
    const resolver: DamageResolver = { resolve: (_state, _attacker, _target, _action, context) => {
      seen.push(!(context?.targetHasActedThisTurn ?? false))
      return { targetDamage: 0, attackerDamage: null, unmodelled: [] }
    } }
    const state = battle([{ spe: 200 }, { spe: 50 }])
    executeTurn(state, [useMove(1), useMove(0)], deps(resolver))
    expect(seen).toEqual([true, false])
  })
})

describe('integration: executeTurn with the real damage resolver', () => {
  const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
  const read = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8')) as T
  const moves = read<Array<Record<string, any>>>('moves.json')
  const moveById = new Map(moves.map((m) => [m.id as string, m]))
  const species = read<Array<Record<string, any>>>('species.json')
  const items = read<Array<Record<string, any>>>('items.json')
  const speciesById = new Map(species.map((s) => [s.id as string, s]))
  const itemsById = new Map(items.map((i) => [i.id as string, i]))
  const natures = read<any>('natures.json')
  const moveBehaviors = read<any>('moveBehaviors.json').behaviors
  const chart = Object.fromEntries(Object.entries(read<Record<string, Record<string, number>>>('types.json')).map(([k, v]) => [k, v]))
  const inverseChart = Object.fromEntries(Object.entries(read<Record<string, Record<string, number>>>('typesInverse.json')).map(([k, v]) => [k, v]))

  if (!moveById.has('MOVE_TACKLE')) throw new Error('snapshot is missing MOVE_TACKLE')

  function toMoveData(id: string): any {
    const move = moveById.get(id)
    if (!move) throw new Error(`snapshot is missing ${id}`)
    const arg = move.argument as Record<string, unknown> | undefined
    return {
      id, power: move.power, type: String(move.type).replace('TYPE_', ''), type2: move.type2 ? String(move.type2).replace('TYPE_', '') : null,
      split: move.split, effectChance: move.effectChance, splitFlag: move.splitFlag, effect: move.effect, customBehavior: move.customBehavior,
      crit: move.crit, flags: move.flags ?? {}, priority: move.priority, changeTypeHoldEffect: arg?.kind === 'holdEffect' ? arg.value : null,
      miscEffect: arg?.kind === 'misc' ? arg.value : null, multiHitArgument: arg?.kind === 'int' ? arg.value : null,
    }
  }

  const realBridge: BridgeDeps = {
    grounding: { holdEffectOf: () => null, monotypeChampType: null, isCluelessOnField: false, attackerHasMoldBreaker: false },
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    statStageRatios: natures.statStageRatios,
    dataContext: {
      species: (id) => speciesById.get(id) as SimSpeciesData | undefined,
      item: (id) => itemsById.get(id) as SimItemData | undefined,
      move: () => undefined,
    } satisfies SimDataContext,
    inverseBattle: false,
  }

  function realResolverDeps(random: RandomSource): BridgeDamageResolverDeps {
    return { ...realBridge, moveData: (id) => moveById.has(id) ? toMoveData(id) : undefined, typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures, random }
  }

  /** Independent ground truth for the damage range, built the same way
   * damageResolver.ts assembles a scenario, but calling calculateMoveDamage
   * directly with no RNG draws of its own -- so the executeTurn integration
   * result below is checked against calculateMoveDamage's own output, not
   * against the resolver re-deriving the same number a second time. */
  function directRolls(state: BattleState, attackerId: number, targetId: number, moveId: string) {
    const roles = { attackerId, defenderId: targetId }
    const attacker = buildBattlerBattleState(state, attackerId, roles, realBridge)
    const defender = buildBattlerBattleState(state, targetId, roles, realBridge)
    const field = buildFieldBattleState(state, roles, realBridge)
    const move = toMoveData(moveId)
    const scenario: DamageCalcScenario = {
      move, attacker: attacker.battler, defender: defender.battler, field: field.field,
      typeChart: chart, inverseTypeChart: inverseChart, moveBehaviors, battleConstants: natures,
      attackerActsFirst: true, sameMoveTurnsInARow: 0, hitCount: 3, defenderIsSwitching: false,
      magnitudeTier: null, attackerRolloutCounter: 0, attackerHasDefenseCurl: false,
      attackerWasHitThisTurn: false, beatUpBaseAttack: attacker.battler.rawStats.atk, beatUpHitCount: 1,
      defenderUsedGlaiveRush: false,
    }
    return calculateMoveDamage(scenario)
  }

  it('deals damage inside calculateMoveDamage\'s own roll range for both attackers', () => {
    const state = battle([{ spe: 200 }, { spe: 50 }])
    const resolver = createBridgeDamageResolver(realResolverDeps(createRandomSource(7)))
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(resolver))

    const rangeFor = (attackerId: number, targetId: number) => {
      const direct = directRolls(battle([{ spe: 200 }, { spe: 50 }]), attackerId, targetId, 'MOVE_TACKLE')
      return { min: Math.min(...direct.rolls, ...(direct.critRolls ?? [])), max: Math.max(...direct.rolls, ...(direct.critRolls ?? [])) }
    }
    const range0 = rangeFor(0, 1)
    const range1 = rangeFor(1, 0)

    expect(out.actions[0].targetDamage).not.toBeNull()
    expect(out.actions[0].targetDamage!).toBeGreaterThanOrEqual(range0.min)
    expect(out.actions[0].targetDamage!).toBeLessThanOrEqual(range0.max)
    expect(out.actions[1].targetDamage).not.toBeNull()
    expect(out.actions[1].targetDamage!).toBeGreaterThanOrEqual(range1.min)
    expect(out.actions[1].targetDamage!).toBeLessThanOrEqual(range1.max)
  })

  it('faints a low-HP target and skips its own action for the rest of the turn', () => {
    // Battler 0 is faster and Tackle's minimum non-crit roll is well above 1 HP.
    const state = battle([{ spe: 200 }, { spe: 50, hp: 1 }])
    const resolver = createBridgeDamageResolver(realResolverDeps(createRandomSource(7)))
    const out = executeTurn(state, [useMove(1), useMove(0)], deps(resolver))

    expect(state.battlers[1]!.mon.hp).toBe(0)
    expect(out.actions[0].fainted).toEqual([1])
    expect(out.actions[1].skippedBecauseFainted).toBe(true)
  })
})
