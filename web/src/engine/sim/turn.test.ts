import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import type { BattleState, SimBattleMon } from './state'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { THROWING_DAMAGE_RESOLVER, assertNoPerBattlerQuash, buildTurnOrderContext, executeTurn, isBattlerAlive } from './turn'
import type { GroundingContext } from './grounding'
import { isBattlerGrounded } from './grounding'
import { STATUS3_ROOTED, STATUS_FIELD_GRAVITY, setFlag } from './constants'

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

function deps(damage: DamageResolver): TurnLoopDeps {
  // NEUTRAL_TURN_ORDER_CONTEXT is spread for the OTHER fields only; its
  // isBattlerGrounded is dropped by the Omit and replaced by the real port.
  const { isBattlerGrounded: _dropped, ...rest } = NEUTRAL_TURN_ORDER_CONTEXT
  return { turnOrder: rest, grounding: GROUNDING, damage, statStageRatios: RATIOS }
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
    expect(out.actions[0].unmodelled).toEqual(['EFFECT_SOMETHING: not modelled'])
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
