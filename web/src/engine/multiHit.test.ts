import { beforeEach, describe, expect, it } from 'vitest'
import { resolveHitPlan, type MultiHitMoveData } from './multiHit'
import { registerAbilities, _resetRegistryForTests } from './abilities/registry'
import { PARENTAL_BOND_ABILITIES } from './abilities/impl/24-parental-bond'
import { uq } from './fixed'
import type { AbilitySlots } from './abilities/dispatch'
import type { OnParentalBondContext } from './abilities/types'

function slots(ability: string | null): AbilitySlots {
  return { ability, innates: [null, null, null] }
}

function move(overrides: Partial<MultiHitMoveData> = {}): MultiHitMoveData {
  return { effect: null, multiHitArgument: null, split: 'PHYSICAL', flags: {}, ...overrides }
}

function pbCtx(overrides: Partial<OnParentalBondContext> = {}): OnParentalBondContext {
  return { moveType: 'NORMAL', moveFlags: {}, weather: 'NONE', attackerHeads: 1, ...overrides }
}

describe('resolveHitPlan -- a move\'s own multi-hit effect', () => {
  it('EFFECT_DOUBLE_HIT is 2 hits (or 3 with argument 3), full power every hit', () => {
    const result = resolveHitPlan(move({ effect: 'EFFECT_DOUBLE_HIT' }), slots(null), slots(null), false, null, 3, pbCtx())
    expect(result).not.toBeNull()
    if (!result || 'unmodelled' in result) throw new Error('expected a hit plan')
    expect(result.hitCount).toBe(2)
    expect(result.hitModifier(0)).toBe(uq(1.0))
    expect(result.hitModifier(1)).toBe(uq(1.0))

    const threeHit = resolveHitPlan(move({ effect: 'EFFECT_DOUBLE_HIT', multiHitArgument: 3 }), slots(null), slots(null), false, null, 3, pbCtx())
    if (!threeHit || 'unmodelled' in threeHit) throw new Error('expected a hit plan')
    expect(threeHit.hitCount).toBe(3)
  })

  it('EFFECT_TEN_HITS is always 10', () => {
    const result = resolveHitPlan(move({ effect: 'EFFECT_TEN_HITS' }), slots(null), slots(null), false, null, 3, pbCtx())
    if (!result || 'unmodelled' in result) throw new Error('expected a hit plan')
    expect(result.hitCount).toBe(10)
  })

  it('EFFECT_MULTI_HIT is the scenario hitCount clamped to 2-5, or a flat 5 with Skill Link', () => {
    const withSkillLink = resolveHitPlan(move({ effect: 'EFFECT_MULTI_HIT' }), slots(null), slots(null), true, null, 2, pbCtx())
    if (!withSkillLink || 'unmodelled' in withSkillLink) throw new Error('expected a hit plan')
    expect(withSkillLink.hitCount).toBe(5)

    const clampedLow = resolveHitPlan(move({ effect: 'EFFECT_MULTI_HIT' }), slots(null), slots(null), false, null, 0, pbCtx())
    if (!clampedLow || 'unmodelled' in clampedLow) throw new Error('expected a hit plan')
    expect(clampedLow.hitCount).toBe(2)

    const clampedHigh = resolveHitPlan(move({ effect: 'EFFECT_MULTI_HIT' }), slots(null), slots(null), false, null, 99, pbCtx())
    if (!clampedHigh || 'unmodelled' in clampedHigh) throw new Error('expected a hit plan')
    expect(clampedHigh.hitCount).toBe(5)

    const withLoadedDice = resolveHitPlan(move({ effect: 'EFFECT_MULTI_HIT' }), slots(null), slots(null), false, 'HOLD_EFFECT_LOADED_DICE', 2, pbCtx())
    if (!withLoadedDice || 'unmodelled' in withLoadedDice) throw new Error('expected a hit plan')
    expect(withLoadedDice.hitCount).toBe(4) // clamped to [4, 5], not [2, 5]
  })
})

describe('resolveHitPlan -- Parental Bond family', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(PARENTAL_BOND_ABILITIES)
  })

  it('Parental Bond itself: 2 hits, full power then the HYPER_AGGRESSIVE 0.25x bonus hit', () => {
    const result = resolveHitPlan(move(), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx())
    if (!result || 'unmodelled' in result) throw new Error('expected a hit plan')
    expect(result.hitCount).toBe(2)
    expect(result.hitModifier(0)).toBe(uq(1.0))
    expect(result.hitModifier(1)).toBe(uq(0.25))
  })

  it('does not trigger for a STATUS move or a move flagged noParentalBond', () => {
    expect(resolveHitPlan(move({ split: 'STATUS' }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx())).toBeNull()
    expect(resolveHitPlan(move({ flags: { noParentalBond: true } }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx())).toBeNull()
  })

  it('does not trigger without a Parental-Bond-family ability', () => {
    expect(resolveHitPlan(move(), slots(null), slots(null), false, null, 3, pbCtx())).toBeNull()
  })

  it('is mutually exclusive with a move\'s own multi-hit effect (the move\'s own effect always wins)', () => {
    const result = resolveHitPlan(move({ effect: 'EFFECT_DOUBLE_HIT' }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx())
    if (!result || 'unmodelled' in result) throw new Error('expected a hit plan')
    // Double Hit's own 2-hit, full-power plan, NOT Parental Bond's 0.25x bonus hit.
    expect(result.hitModifier(1)).toBe(uq(1.0))
  })
})
