import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import {
  NEUTRAL_TURN_ORDER_CONTEXT,
  TOTAL_SPEED_PRIMARY,
  TOTAL_SPEED_QUASH,
  getBattlerTotalSpeedStat,
  getFastestBattler,
  getMovePriority,
  getMoveSpeed,
  getWhoStrikesFirst,
  recalculateMoveOrder,
  resolveTurnOrderAssumingNoMidTurnChanges,
  setActionsAndBattlersTurnOrder,
} from './turnOrder'
import type { ChosenAction, TurnOrderContext, TurnOrderMoveView } from './turnOrder'
import {
  DEFAULT_STAT_STAGE,
  SIDE_STATUS_TAILWIND,
  STAT_SPEED,
  STATUS1_BLEED,
  STATUS1_PARALYSIS,
  STATUS4_COILED,
  STATUS4_CUTTHROAT,
  setFlag,
} from './constants'

// gStatStageRatios for stages 0..12 (index 6 neutral) -- ER uses the GEN_7 table,
// the same values natures.json emits as `statStageRatios`. Written out here so the
// test does not need the data snapshot; index 6 is 1/1 and the ends are 2/8 and 8/2.
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
    hp: 120,
    maxHp: 120,
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

function battle(speeds: number[], rng: RandomSource = createRandomSource(1)): BattleState {
  return createBattleState({
    battlers: speeds.map((spe, i) => createBattlerState(i, mon({ rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe } }), 0)),
    rng,
  })
}

function move(overrides: Partial<TurnOrderMoveView> = {}): TurnOrderMoveView {
  return {
    id: 'MOVE_TACKLE',
    priority: 0,
    effect: null,
    isStatus: false,
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
    resolvedType: 'NORMAL',
    power: 40,
    flags: {},
    split: 'PHYSICAL',
    ...overrides,
  }
}

function useMove(m: TurnOrderMoveView = move(), target: number | null = null): ChosenAction {
  return { action: 'USE_MOVE', moveToBeUsed: m, chosenMove: m, target }
}

const ctx = NEUTRAL_TURN_ORDER_CONTEXT
function withCtx(overrides: Partial<TurnOrderContext>): TurnOrderContext {
  return { ...NEUTRAL_TURN_ORDER_CONTEXT, ...overrides }
}

/** Gives a battler an ability. Deliberately NOT routed through
 * TurnOrderContext: priority abilities are read off the battler's own slots, so
 * the neutral context cannot supply (or suppress) them. */
function withAbility(state: BattleState, battlerId: number, abilityId: string): void {
  state.battlers[battlerId]!.mon.abilities = { ability: abilityId, innates: [null, null, null] }
}

describe('getMoveSpeed packing', () => {
  it('lays the six fields out at the bit positions union SpeedValue declares', () => {
    // include/battle_main.h:29-40. A neutral battler is not all-zero above the
    // speed: both negated fields read 3 when nothing is set, so the resting
    // value is (3 << 24) | (7 << 20) | (3 << 16) | speed -- dazedNegation 3,
    // priority 7, goesLastNegation 3.
    const state = battle([100, 100])
    const v = getMoveSpeed(state, 0, useMove(), false, ctx, RATIOS)
    expect(v.priority).toBe(7)
    expect(v.goesLastNegation).toBe(3)
    expect(v.dazedNegation).toBe(3)
    expect(v.afterYou).toBe(0)
    expect(v.goesFirst).toBe(0)
    expect(v.effectiveSpeed).toBe(100)
    expect(v.comparable).toBe((3 << 24) | (7 << 20) | (3 << 16) | 100)
  })

  it('ranks After You above priority', () => {
    // afterYou is bit 26, priority bits 20-23. A +5-priority move loses to a
    // slower battler that was given After You.
    const state = battle([1, 1])
    state.battlers[1]!.round.afterYou = true
    const fast = getMoveSpeed(state, 0, useMove(move({ priority: 5 })), false, ctx, RATIOS)
    const slow = getMoveSpeed(state, 1, useMove(), false, ctx, RATIOS)
    expect(slow.comparable).toBeGreaterThan(fast.comparable)
  })

  it('ranks being dazed above priority, through a negated field', () => {
    // dazedNegation is bits 24-25 and stores ~(dazed + waterlog), so any dazed
    // battler sorts below every undazed one regardless of move priority.
    const state = battle([1, 1])
    state.battlers[0]!.volatiles.dazed = 1
    const dazedWithPriority = getMoveSpeed(state, 0, useMove(move({ priority: 5 })), false, ctx, RATIOS)
    const plain = getMoveSpeed(state, 1, useMove(), false, ctx, RATIOS)
    expect(dazedWithPriority.dazedNegation).toBe(2)
    expect(plain.dazedNegation).toBe(3)
    expect(plain.comparable).toBeGreaterThan(dazedWithPriority.comparable)
  })

  it('wraps dazed at 4 back to the undazed value, because the field is 2 bits', () => {
    // battle_main.c:4304 assigns ~(dazed + waterlog) into a 2-bit field while
    // `dazed` is a 3-bit counter. A ROM quirk, reproduced rather than corrected.
    const state = battle([1, 1])
    state.battlers[0]!.volatiles.dazed = 4
    expect(getMoveSpeed(state, 0, useMove(), false, ctx, RATIOS).dazedNegation).toBe(3)
  })

  it('sums Quick Draw and Quick Claw into goesFirst rather than treating them as one flag', () => {
    const state = battle([1, 1])
    state.battlers[0]!.round.quickDraw = true
    state.battlers[1]!.round.quickDraw = true
    state.battlers[1]!.round.usedCustapBerry = true
    expect(getMoveSpeed(state, 0, useMove(), false, ctx, RATIOS).goesFirst).toBe(1)
    expect(getMoveSpeed(state, 1, useMove(), false, ctx, RATIOS).goesFirst).toBe(2)
  })

  it('stores goesLast effects negated, so Lagging Tail lowers the value', () => {
    const state = battle([100, 100])
    const lagging = withCtx({ holdEffectOf: (b) => (b === 0 ? 'HOLD_EFFECT_LAGGING_TAIL' : null) })
    expect(getMoveSpeed(state, 0, useMove(), false, lagging, RATIOS).goesLastNegation).toBe(2)
    expect(getMoveSpeed(state, 1, useMove(), false, lagging, RATIOS).goesLastNegation).toBe(3)
  })

  it('lowers goesLastNegation for a Mycelium Might status move', () => {
    // :4319. The ONLY positive assertion for this path -- every other test that
    // mentions the flag asserts its ABSENCE (dropped under quash, not read off
    // moveToBeUsed), so without this one the line implementing it can be deleted
    // with the whole suite still green. That is exactly what happened once.
    const state = battle([100, 100])
    const m = move({ isStatus: true, myceliumMightAffected: true })
    expect(getMoveSpeed(state, 0, useMove(m), false, ctx, RATIOS).goesLastNegation).toBe(2)
  })

  it('stacks Mycelium Might with Lagging Tail, since both feed the same counter', () => {
    // Two contributions before the complement: ~2 & 3 === 1.
    const state = battle([100, 100])
    const m = move({ isStatus: true, myceliumMightAffected: true })
    const lagging = withCtx({ holdEffectOf: () => 'HOLD_EFFECT_LAGGING_TAIL' })
    expect(getMoveSpeed(state, 0, useMove(m), false, lagging, RATIOS).goesLastNegation).toBe(1)
  })

  it('makes a Mycelium Might user lose to a SLOWER battler', () => {
    // Battler 0 is twice as fast, so the only thing that can cost it the turn is
    // goesLastNegation outranking speed by bit position. Equal speeds would not
    // work here: without the effect the two would tie and the RNG tie-break
    // would pass this test roughly half the time by luck.
    const state = battle([200, 100])
    const m = move({ isStatus: true, myceliumMightAffected: true })
    expect(getWhoStrikesFirst(state, 0, 1, [useMove(m), useMove()], false, ctx, RATIOS)).toBe(1)
  })

  it('adds exactly one for drenched however large the counter is', () => {
    // :4320 is a plain ++, not += drenched.
    const state = battle([1, 1])
    state.battlers[0]!.volatiles.drenched = 1
    state.battlers[1]!.volatiles.drenched = 3
    expect(getMoveSpeed(state, 0, useMove(), false, ctx, RATIOS).goesLastNegation).toBe(2)
    expect(getMoveSpeed(state, 1, useMove(), false, ctx, RATIOS).goesLastNegation).toBe(2)
  })

  it('clamps priority into the 4-bit field around a neutral 7', () => {
    const state = battle([1, 1])
    expect(getMoveSpeed(state, 0, useMove(move({ priority: 5 })), false, ctx, RATIOS).priority).toBe(12)
    expect(getMoveSpeed(state, 0, useMove(move({ priority: 20 })), false, ctx, RATIOS).priority).toBe(15)
    expect(getMoveSpeed(state, 0, useMove(move({ priority: -20 })), false, ctx, RATIOS).priority).toBe(0)
  })

  it('leaves priority neutral when the chosen move is ignored', () => {
    const state = battle([100, 100])
    const v = getMoveSpeed(state, 0, useMove(move({ priority: 5 })), true, ctx, RATIOS)
    expect(v.priority).toBe(7)
  })
})

describe('Trick Room', () => {
  it('complements the speed within 16 bits rather than reversing the comparison', () => {
    // :4325 is `~effectiveSpeed` on a u16 field, so 100 becomes 65435.
    const state = battle([100, 100])
    const tr = withCtx({ isTrickRoomActive: true })
    expect(getMoveSpeed(state, 0, useMove(), false, tr, RATIOS).effectiveSpeed).toBe(65435)
  })

  it('makes the slower battler act first', () => {
    const state = battle([50, 200])
    const tr = withCtx({ isTrickRoomActive: true })
    expect(getWhoStrikesFirst(state, 0, 1, [useMove(), useMove()], false, tr, RATIOS)).toBe(0)
    expect(getWhoStrikesFirst(state, 0, 1, [useMove(), useMove()], false, ctx, RATIOS)).toBe(1)
  })

  it('does not override priority, because it only touches the low 16 bits', () => {
    // The battler with priority must also be the one Trick Room DISADVANTAGES,
    // or a naive priority-then-speed model passes this too. Battler 0 is the
    // faster (so Trick Room ranks it last on speed) and holds the +1 move; the
    // only reason it still goes first is that priority sits at bits 20-23, above
    // the complemented speed at bits 0-15.
    const state = battle([200, 50])
    const tr = withCtx({ isTrickRoomActive: true })
    const order = [useMove(move({ priority: 1 })), useMove()]
    expect(getMoveSpeed(state, 0, order[0], false, tr, RATIOS).effectiveSpeed).toBeLessThan(
      getMoveSpeed(state, 1, order[1], false, tr, RATIOS).effectiveSpeed,
    )
    expect(getWhoStrikesFirst(state, 0, 1, order, false, tr, RATIOS)).toBe(0)
  })

  it('is suppressed by Quash along with everything else in the high fields', () => {
    // :4325's Trick Room complement is gated on !quash.
    const state = battle([100, 100])
    state.field.timers.quashTimer = 1
    const tr = withCtx({ isTrickRoomActive: true })
    expect(getMoveSpeed(state, 0, useMove(), false, tr, RATIOS).effectiveSpeed).toBe(100)
  })
})

describe('getMovePriority', () => {
  it('floors at -4 under Quash and skips every later modifier', () => {
    const state = battle([100, 100])
    state.field.timers.quashTimer = 1
    // Prankster would add +1 to a status move; the quash return at :4262 is
    // BEFORE the ON_ABILITY line at :4264, so it never runs.
    withAbility(state, 0, 'ABILITY_PRANKSTER')
    expect(getMovePriority(state, 0, move({ priority: 3, isStatus: true, split: 'STATUS' }), null)).toBe(-4)
    // min(-4, priority) keeps an already-lower value.
    expect(getMovePriority(state, 0, move({ priority: -6 }), null)).toBe(-6)
  })

  it('gives Thief priority only when the user is itemless and the target is not', () => {
    const state = battle([100, 100])
    state.battlers[1]!.mon.itemId = 'ITEM_LEFTOVERS'
    expect(getMovePriority(state, 0, move({ effect: 'EFFECT_THIEF' }), 1)).toBe(1)
    state.battlers[0]!.mon.itemId = 'ITEM_LEFTOVERS'
    expect(getMovePriority(state, 0, move({ effect: 'EFFECT_THIEF' }), 1)).toBe(0)
  })

  it('reads BOTH sides Tailwind for Razor Wind', () => {
    // :4282 checks gSideStatuses[0] | gSideStatuses[1], not the user's own side.
    const state = battle([100, 100])
    const m = move({ id: 'MOVE_RAZOR_WIND' })
    expect(getMovePriority(state, 0, m, null)).toBe(0)
    state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_TAILWIND)
    expect(getMovePriority(state, 0, m, null)).toBe(1)
  })

  it('pairs Coiled with the strong-jaw flag and Cutthroat with keen edge', () => {
    const state = battle([100, 100])
    state.battlers[0]!.statuses4 = setFlag(state.battlers[0]!.statuses4, STATUS4_COILED)
    expect(getMovePriority(state, 0, move({ hasStrongJawBoostFlag: true }), null)).toBe(1)
    expect(getMovePriority(state, 0, move({ hasStrongJawBoostFlag: false }), null)).toBe(0)

    state.battlers[1]!.statuses4 = setFlag(state.battlers[1]!.statuses4, STATUS4_CUTTHROAT)
    expect(getMovePriority(state, 1, move({ isKeenEdge: true }), null)).toBe(1)
  })

  it('applies On The Prowl against the DECLARED priority, not the running total', () => {
    // :4284-4289 tests gBattleMoves[move].priority in both branches.
    const state = battle([100, 100])
    state.battlers[0]!.volatiles.onTheProwl = true
    expect(getMovePriority(state, 0, move({ priority: 1 }), null)).toBe(2)
    // Negative: subtract the declared priority, cancelling it.
    expect(getMovePriority(state, 0, move({ priority: -3 }), null)).toBe(0)
    // With an ability bonus on top, the negative branch still subtracts the
    // DECLARED -3 from the running total rather than from the declared value:
    // -3, +1 from Prankster, then -(-3) = +1.
    withAbility(state, 0, 'ABILITY_PRANKSTER')
    expect(getMovePriority(state, 0, move({ priority: -3, isStatus: true, split: 'STATUS' }), null)).toBe(1)
  })

  it('applies the ability bonus before the move-effect modifiers, and they stack', () => {
    // :4264 (ON_ABILITY) runs before :4266 (Grassy Glide). Opportunist supplies
    // the ability half off the TARGET's HP, Grassy Glide the move half.
    const state = battle([100, 100])
    withAbility(state, 0, 'ABILITY_OPPORTUNIST')
    state.battlers[1]!.mon.hp = 50
    expect(getMovePriority(state, 0, move({ effect: 'EFFECT_GRASSY_GLIDE', isGrassyTerrainAffected: true }), 1)).toBe(2)
  })
})

describe('getBattlerTotalSpeedStat', () => {
  it('halves for paralysis, and only by two in this build', () => {
    // B_PARALYSIS_SPEED is GEN_7 (include/constants/battle_config.h:21), so the
    // divisor is 2, not vanilla's 4.
    const state = battle([100])
    state.battlers[0]!.mon.status1 = setFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)
    expect(getBattlerTotalSpeedStat(state, 0, TOTAL_SPEED_PRIMARY, null, ctx, RATIOS)).toBe(50)
  })

  it('exempts Quick Feet from the paralysis drop', () => {
    const state = battle([100])
    state.battlers[0]!.mon.status1 = setFlag(state.battlers[0]!.mon.status1, STATUS1_PARALYSIS)
    expect(getBattlerTotalSpeedStat(state, 0, TOTAL_SPEED_PRIMARY, null, withCtx({ hasQuickFeet: () => true }), RATIOS)).toBe(100)
  })

  it('truncates each Violent Rush style boost separately instead of combining them', () => {
    // :4178-4182 -- three sequential (speed * 150) / 100 steps. 101 -> 151 ->
    // 226 -> 339, whereas one combined 101 * 337 / 100 would be 340.
    const state = battle([101])
    const b = state.battlers[0]!
    b.volatiles.violentRush = true
    b.volatiles.rapidResponse = true
    b.volatiles.showdownMode = true
    expect(getBattlerTotalSpeedStat(state, 0, TOTAL_SPEED_PRIMARY, null, ctx, RATIOS)).toBe(339)
  })

  it('caps the Speed stage at neutral when bleeding rather than zeroing the stat', () => {
    // :4232 -- min(statStage, DEFAULT_STAT_STAGE). A positive stage is lost, a
    // negative one is kept.
    const state = battle([100, 100])
    const raised = state.battlers[0]!
    raised.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE + 2
    raised.mon.status1 = setFlag(raised.mon.status1, STATUS1_BLEED)
    expect(getBattlerTotalSpeedStat(state, 0, 0, null, ctx, RATIOS)).toBe(100)

    const lowered = state.battlers[1]!
    lowered.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE - 2
    lowered.mon.status1 = setFlag(lowered.mon.status1, STATUS1_BLEED)
    expect(getBattlerTotalSpeedStat(state, 1, 0, null, ctx, RATIOS)).toBe(50)
  })

  it('applies extra stat levels BEFORE stat stages, unlike the damage path', () => {
    // :4226-4236 applies extra levels and THEN stages; CalculateStat's own tail
    // (engine/battleStat.ts's applyStatTail) does the reverse. A stage whose
    // ratio truncates separates them: at stage -1 (2/3) with one extra level,
    // extra-first gives 80 and stage-first gives 79.
    const state = battle([100])
    const b = state.battlers[0]!
    b.volatiles.extraSpeedLevel = 1
    b.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE - 1 // 2/3
    // extra-first: 100 -> 120 -> trunc(120*2/3) = 80
    // stage-first: trunc(100*2/3) = 66 -> 66 + 13 = 79
    expect(getBattlerTotalSpeedStat(state, 0, 0, null, ctx, RATIOS)).toBe(80)
  })

  it('skips abilities, Tailwind and stat stages under QUASH but keeps item effects', () => {
    const state = battle([100])
    const b = state.battlers[0]!
    b.mon.statStages[STAT_SPEED] = DEFAULT_STAT_STAGE + 2
    b.volatiles.violentRush = true
    state.sides[0].statuses = setFlag(state.sides[0].statuses, SIDE_STATUS_TAILWIND)
    const scarf = withCtx({ holdEffectOf: () => 'HOLD_EFFECT_CHOICE_SCARF' })
    // Only the Choice Scarf applies: 100 * 150 / 100 = 150.
    expect(getBattlerTotalSpeedStat(state, 0, TOTAL_SPEED_QUASH, null, scarf, RATIOS)).toBe(150)
  })

  it('doubles for Tailwind and does not also apply the Flying champion bonus', () => {
    const state = battle([100, 100])
    const flying = withCtx({ monotypeChampFlying: true })
    state.sides[1].statuses = setFlag(state.sides[1].statuses, SIDE_STATUS_TAILWIND)
    // Opponent side with Tailwind: doubled once by the if, not again by the else.
    expect(getBattlerTotalSpeedStat(state, 1, 0, null, flying, RATIOS)).toBe(200)
  })

  it('gives the Flying champion bonus to the opponent side only', () => {
    const state = battle([100, 100])
    const flying = withCtx({ monotypeChampFlying: true })
    expect(getBattlerTotalSpeedStat(state, 0, 0, null, flying, RATIOS)).toBe(100)
    expect(getBattlerTotalSpeedStat(state, 1, 0, null, flying, RATIOS)).toBe(200)
  })

  it('wraps the speed at 16 bits, because the union field is a u16', () => {
    const state = battle([40000])
    const scarf = withCtx({ holdEffectOf: () => 'HOLD_EFFECT_CHOICE_SCARF' })
    // 40000 * 150 / 100 = 60000; with Tailwind doubling first it is 120000,
    // which does not fit a u16.
    state.sides[0].statuses = setFlag(state.sides[0].statuses, SIDE_STATUS_TAILWIND)
    const total = getBattlerTotalSpeedStat(state, 0, 0, null, scarf, RATIOS)
    expect(total).toBe(120000)
    expect(getMoveSpeed(state, 0, useMove(), false, scarf, RATIOS).effectiveSpeed).toBe(120000 & 0xffff)
  })

  it('lets a wrapped speed actually LOSE to a slower battler', () => {
    // Asserting the wrapped field value alone does not show the wrap changes any
    // decision. Battler 0's real speed is 70000, which wraps to 4464; battler 1
    // is genuinely slower at 5000 but wins the comparison because of it.
    const state = battle([70000, 5000])
    expect(getMoveSpeed(state, 0, useMove(), false, ctx, RATIOS).effectiveSpeed).toBe(70000 & 0xffff)
    expect(getWhoStrikesFirst(state, 0, 1, [useMove(), useMove()], false, ctx, RATIOS)).toBe(1)
  })

  it('slows a grounded battler in Swamp and leaves an ungrounded one alone', () => {
    // :4208 requires the timer AND IsBattlerGrounded; gating on the timer alone
    // silently slows Flying-types.
    const state = battle([100, 100])
    state.sides[0].timers.swampTimer = 3
    state.sides[1].timers.swampTimer = 3
    const grounded = withCtx({ isBattlerGrounded: () => true })
    const airborne = withCtx({ isBattlerGrounded: () => false })
    expect(getBattlerTotalSpeedStat(state, 0, 0, null, grounded, RATIOS)).toBe(66)
    expect(getBattlerTotalSpeedStat(state, 1, 0, null, airborne, RATIOS)).toBe(100)
  })
})

describe('what Quash actually gates', () => {
  // The guards in GetMoveSpeed are per-field, not a blanket. afterYou and
  // dazedNegation sit inside `if (!quash)` (:4302-4305), the Mycelium Might and
  // drenched increments are individually guarded (:4319-4320), and the Trick Room
  // complement is guarded (:4325) -- but goesFirst (:4317) and the Lagging Tail
  // assignment (:4318) are NOT, and neither is the priority field itself, which
  // instead takes GetMovePriority's quash floor of -4 (:4262).
  function quashed(): BattleState {
    const state = battle([100, 100])
    state.field.timers.quashTimer = 1
    return state
  }

  it('zeroes afterYou and dazedNegation', () => {
    const state = quashed()
    state.battlers[0]!.round.afterYou = true
    state.battlers[0]!.volatiles.dazed = 0
    const v = getMoveSpeed(state, 0, useMove(), false, ctx, RATIOS)
    expect(v.afterYou).toBe(0)
    // Undazed would normally be 3; under quash the field is never assigned.
    expect(v.dazedNegation).toBe(0)
  })

  it('keeps goesFirst, which sits outside the guards', () => {
    const state = quashed()
    state.battlers[0]!.round.quickDraw = true
    state.battlers[0]!.round.usedCustapBerry = true
    expect(getMoveSpeed(state, 0, useMove(), false, ctx, RATIOS).goesFirst).toBe(2)
  })

  it('keeps the Lagging Tail bit but drops the Mycelium Might and drenched ones', () => {
    const state = quashed()
    state.battlers[0]!.volatiles.drenched = 2
    const lagging = withCtx({ holdEffectOf: () => 'HOLD_EFFECT_LAGGING_TAIL' })
    const m = move({ myceliumMightAffected: true })
    // Only Lagging Tail counts: ~1 & 3 === 2. All three would give ~3 & 3 === 0.
    expect(getMoveSpeed(state, 0, { action: 'USE_MOVE', moveToBeUsed: m, chosenMove: m, target: null }, false, lagging, RATIOS).goesLastNegation).toBe(2)
  })

  it('forces the packed priority to its floor value', () => {
    // GetMovePriority returns min(-4, priority), and GetMoveSpeed offsets by 7,
    // so a +3 move lands at 3 rather than 10.
    const state = quashed()
    expect(getMoveSpeed(state, 0, useMove(move({ priority: 3 })), false, ctx, RATIOS).priority).toBe(3)
  })

  it('makes a quashed battler lose to an identical unquashed one', () => {
    // Quash is field-wide in this build (gFieldTimers.quashTimer), so it cannot
    // be shown by comparing two battlers within one state. Compare the same
    // battler's packed word across two states instead.
    const plain = getMoveSpeed(battle([100, 100]), 0, useMove(), false, ctx, RATIOS)
    const quash = getMoveSpeed(quashed(), 0, useMove(), false, ctx, RATIOS)
    expect(quash.comparable).toBeLessThan(plain.comparable)
  })
})

describe('getWhoStrikesFirst', () => {
  it('returns 0 when battler1 is faster and 1 when it is slower', () => {
    const state = battle([200, 50])
    expect(getWhoStrikesFirst(state, 0, 1, [useMove(), useMove()], false, ctx, RATIOS)).toBe(0)
    expect(getWhoStrikesFirst(state, 1, 0, [useMove(), useMove()], false, ctx, RATIOS)).toBe(1)
  })

  it('breaks an exact tie from the seeded source, and both outcomes occur', () => {
    const state = battle([100, 100], createRandomSource(4))
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) seen.add(getWhoStrikesFirst(state, 0, 1, [useMove(), useMove()], false, ctx, RATIOS))
    expect(seen).toEqual(new Set([0, 1]))
  })

  it('lets priority beat a large speed advantage', () => {
    const state = battle([20, 400])
    expect(getWhoStrikesFirst(state, 0, 1, [useMove(move({ priority: 1 })), useMove()], false, ctx, RATIOS)).toBe(0)
  })
})

describe('getFastestBattler', () => {
  it('skips excluded battlers', () => {
    const state = battle([400, 100])
    expect(getFastestBattler(state, [useMove(), useMove()], false, 0, ctx, RATIOS)).toBe(0)
    expect(getFastestBattler(state, [useMove(), useMove()], false, 1 << 0, ctx, RATIOS)).toBe(1)
  })

  it('gives each entrant an even chance in a tie', () => {
    // :4341's dupeCount reservoir. With three tied battlers the split should be
    // roughly even; a naive "first wins" or "last wins" would not be.
    const state = createBattleState({
      battlers: [0, 1, 2].map((i) => createBattlerState(i, mon(), 0)),
      rng: createRandomSource(11),
    })
    const actions = [useMove(), useMove(), useMove()]
    const counts = [0, 0, 0]
    for (let i = 0; i < 3000; i++) counts[getFastestBattler(state, actions, false, 0, ctx, RATIOS)]++
    for (const c of counts) expect(c / 3000).toBeGreaterThan(0.25)
  })
})

describe('turn order assembly', () => {
  it('puts switches and items before moves, in battler id order', () => {
    const state = battle([1, 400])
    const actions: ChosenAction[] = [useMove(), { action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }]
    const order = setActionsAndBattlersTurnOrder(state, actions)
    expect(order.battlerByTurnOrder).toEqual([1, 0])
    expect(order.actionsByTurnOrder).toEqual(['SWITCH', 'USE_MOVE'])
  })

  it('does not speed-sort, because SetActionsAndBattlersTurnOrder own sort is dead', () => {
    // battle_main.c:4458-4479: the two grouping loops set every battler's bit in
    // `except`, so SortBattlersExcept at :4476 filters them all out and writes
    // nothing. The grouped order is battler id order.
    const state = battle([1, 400])
    const order = setActionsAndBattlersTurnOrder(state, [useMove(), useMove()])
    expect(order.battlerByTurnOrder).toEqual([0, 1])
  })

  it('recalculateMoveOrder pulls the fastest remaining battler into the slot', () => {
    const state = battle([1, 400])
    const actions = [useMove(), useMove()]
    const order = setActionsAndBattlersTurnOrder(state, actions)
    recalculateMoveOrder(order, state, actions, 0, false, ctx, RATIOS)
    expect(order.battlerByTurnOrder).toEqual([1, 0])
  })

  it('recalculateMoveOrder leaves a non-move slot alone', () => {
    // :4553 -- the early return is what preserves the switch/item grouping.
    const state = battle([1, 400])
    const actions: ChosenAction[] = [{ action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, useMove()]
    const order = setActionsAndBattlersTurnOrder(state, actions)
    expect(order.battlerByTurnOrder).toEqual([0, 1])
    recalculateMoveOrder(order, state, actions, 0, false, ctx, RATIOS)
    expect(order.battlerByTurnOrder).toEqual([0, 1])
  })

  it('re-reads speed between actions, so a mid-turn change reorders the rest', () => {
    // The lazy design is the point: RecalculateMoveOrder is called per action
    // (battle_util.c:839, :851), not once per turn.
    const state = createBattleState({
      battlers: [100, 90, 80].map((spe, i) => createBattlerState(i, mon({ rawStats: { atk: 1, def: 1, spatk: 1, spdef: 1, spe } }), 0)),
      rng: createRandomSource(2),
    })
    const actions = [useMove(), useMove(), useMove()]
    const order = setActionsAndBattlersTurnOrder(state, actions)
    recalculateMoveOrder(order, state, actions, 0, false, ctx, RATIOS)
    expect(order.battlerByTurnOrder[0]).toBe(0)

    // Battler 1 is paralysed by the first action: it should now fall behind 2.
    state.battlers[1]!.mon.status1 = setFlag(state.battlers[1]!.mon.status1, STATUS1_PARALYSIS)
    recalculateMoveOrder(order, state, actions, 1, false, ctx, RATIOS)
    expect(order.battlerByTurnOrder[1]).toBe(2)
  })

  it('resolveTurnOrderAssumingNoMidTurnChanges runs the lazy algorithm to completion', () => {
    const state = battle([50, 300])
    const order = resolveTurnOrderAssumingNoMidTurnChanges(state, [useMove(), useMove()], ctx, RATIOS)
    expect(order.battlerByTurnOrder).toEqual([1, 0])
  })

  it('orders a switch ahead of a faster opponent move', () => {
    const state = battle([1, 400])
    const actions: ChosenAction[] = [{ action: 'SWITCH', moveToBeUsed: null, chosenMove: null, target: null }, useMove()]
    const order = resolveTurnOrderAssumingNoMidTurnChanges(state, actions, ctx, RATIOS)
    expect(order.battlerByTurnOrder).toEqual([0, 1])
  })
})

describe('which accessor each value comes from', () => {
  // GetMoveToBeUsed is called once (battle_main.c:4308) and its result feeds ONLY
  // GetFullChosenTarget. Priority (:4309, via GetChosenMovePriority, which calls
  // GetChosenMove at :4252), Mycelium Might (:4319) and the speed-stat move
  // argument (:4324) all read GetChosenMove. These tests give the two fields
  // DIFFERENT moves so the assertion can only be satisfied by the right one --
  // the earlier version set both to the same object and proved nothing.
  //
  // The two accessors diverge on STATUS2_MULTIPLETURNS / STATUS2_RECHARGE, where
  // GetMoveToBeUsed returns gLockedMoves (battle_util.c:152-160), and on
  // gProcessingExtraAttacks, where GetChosenMove returns the queued extra attack
  // (:4242). Not on ordinary Encore, which writes gChosenMoveByBattler at
  // selection time so both agree.
  const locked = move({ id: 'MOVE_OUTRAGE', priority: 3, myceliumMightAffected: true })
  const chosen = move({ id: 'MOVE_THUNDER_WAVE', priority: 0, isStatus: true })

  it('takes priority from chosenMove, not moveToBeUsed', () => {
    const state = battle([100, 100])
    const v = getMoveSpeed(state, 0, { action: 'USE_MOVE', moveToBeUsed: locked, chosenMove: chosen, target: null }, false, ctx, RATIOS)
    // chosenMove's priority is 0, so the packed field stays neutral at 7. Reading
    // moveToBeUsed instead would give 10.
    expect(v.priority).toBe(7)
  })

  it('takes Mycelium Might from chosenMove, not moveToBeUsed', () => {
    // Flag the CHOSEN move and assert the effect is PRESENT. Asserting absence
    // off the locked move would pass just as well against code that never reads
    // the field at all, so it discriminated against nothing.
    const state = battle([100, 100])
    const flaggedChosen = move({ id: 'MOVE_THUNDER_WAVE', isStatus: true, myceliumMightAffected: true })
    const unflaggedLocked = move({ id: 'MOVE_OUTRAGE' })
    const v = getMoveSpeed(
      state,
      0,
      { action: 'USE_MOVE', moveToBeUsed: unflaggedLocked, chosenMove: flaggedChosen, target: null },
      false,
      ctx,
      RATIOS,
    )
    // 2 only if chosenMove was read; reading moveToBeUsed OR reading neither
    // would both leave it at 3.
    expect(v.goesLastNegation).toBe(2)
  })

  it('takes the speed-stat move argument from chosenMove, not moveToBeUsed', () => {
    // MOVE_STEAMROLLER is the one move the speed stat reads by name (:4212).
    const state = battle([100, 100])
    const steamroller = move({ id: 'MOVE_STEAMROLLER' })
    const plain = move({ id: 'MOVE_TACKLE' })
    const asChosen = getMoveSpeed(state, 0, { action: 'USE_MOVE', moveToBeUsed: plain, chosenMove: steamroller, target: null }, false, ctx, RATIOS)
    const asToBeUsed = getMoveSpeed(state, 0, { action: 'USE_MOVE', moveToBeUsed: steamroller, chosenMove: plain, target: null }, false, ctx, RATIOS)
    expect(asChosen.effectiveSpeed).toBe(150)
    expect(asToBeUsed.effectiveSpeed).toBe(100)
  })
})
