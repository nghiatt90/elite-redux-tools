import { describe, expect, it } from 'vitest'
import { TYPE_EFFECTIVENESS_ABILITIES } from './16-type-effectiveness'
import type { AbilityImpl, OnTypeEffectivenessContext, OnAfterTypeEffectivenessContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = TYPE_EFFECTIVENESS_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function teCtx(overrides: Partial<OnTypeEffectivenessContext> = {}): OnTypeEffectivenessContext {
  return { attackerId: 'a', defenderId: 'd', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', modifier: uq(1.0), defType: 'NORMAL', ...overrides }
}

function afterCtx(overrides: Partial<OnAfterTypeEffectivenessContext> = {}): OnAfterTypeEffectivenessContext {
  return {
    attackerId: 'a',
    defenderId: 'd',
    moveId: 'MOVE_TACKLE',
    moveType: 'NORMAL',
    moveFlags: {},
    modifier: uq(1.0),
    perTypeModifiers: [uq(1.0), 0, 0],
    defenderTypes: [],
    weather: 'NONE',
    targetGrounded: true,
    defenderAtMaxHp: true,
    attackerAtMaxHp: true,
    defenderAbilityOn: false,
    ...overrides,
  }
}

describe('type effectiveness batch N', () => {
  it("Angel's Wrath overrides two specific move+type pairs to super-effective", () => {
    const c1 = teCtx({ moveId: 'MOVE_POISON_STING', defType: 'STEEL', modifier: 0 })
    findAbility('ABILITY_ANGELS_WRATH').onTypeEffectiveness!(c1)
    expect(c1.modifier).toBe(uq(2.0))
    const c2 = teCtx({ moveId: 'MOVE_ELECTROWEB', defType: 'GROUND', modifier: 0 })
    findAbility('ABILITY_ANGELS_WRATH').onTypeEffectiveness!(c2)
    expect(c2.modifier).toBe(uq(2.0))
    const c3 = teCtx({ moveId: 'MOVE_TACKLE', defType: 'STEEL', modifier: 0 })
    findAbility('ABILITY_ANGELS_WRATH').onTypeEffectiveness!(c3)
    expect(c3.modifier).toBe(0)
  })

  it('Corrosion breaks Steel immunity to Poison', () => {
    const c = teCtx({ moveType: 'POISON', defType: 'STEEL', modifier: 0 })
    findAbility('ABILITY_CORROSION').onTypeEffectiveness!(c)
    expect(c.modifier).toBe(uq(2.0))
  })

  it('Corrupted Mind floors Psychic-move effectiveness at neutral', () => {
    const c = teCtx({ moveType: 'PSYCHIC', modifier: uq(0.5) })
    findAbility('ABILITY_CORRUPTED_MIND').onTypeEffectiveness!(c)
    expect(c.modifier).toBe(uq(1.0))
    const c2 = teCtx({ moveType: 'PSYCHIC', modifier: uq(2.0) })
    findAbility('ABILITY_CORRUPTED_MIND').onTypeEffectiveness!(c2)
    expect(c2.modifier).toBe(uq(2.0))
  })

  it('Ground Shock makes Electric resisted (not immune) by Ground', () => {
    const c = teCtx({ moveType: 'ELECTRIC', defType: 'GROUND', modifier: 0 })
    findAbility('ABILITY_GROUND_SHOCK').onTypeEffectiveness!(c)
    expect(c.modifier).toBe(uq(0.5))
  })

  it('Molten Down and Overwhelm/Phantom Pain/Overcharge/Scrappy remove immunities to neutral/super', () => {
    expect((() => {
      const c = teCtx({ moveType: 'FIRE', defType: 'ROCK', modifier: 0 })
      findAbility('ABILITY_MOLTEN_DOWN').onTypeEffectiveness!(c)
      return c.modifier
    })()).toBe(uq(2.0))
    expect((() => {
      const c = teCtx({ moveType: 'ELECTRIC', defType: 'ELECTRIC', modifier: uq(1.0) })
      findAbility('ABILITY_OVERCHARGE').onTypeEffectiveness!(c)
      return c.modifier
    })()).toBe(uq(2.0))
    expect((() => {
      const c = teCtx({ moveType: 'DRAGON', defType: 'FAIRY', modifier: 0 })
      findAbility('ABILITY_OVERWHELM').onTypeEffectiveness!(c)
      return c.modifier
    })()).toBe(uq(1.0))
    expect((() => {
      const c = teCtx({ moveType: 'GHOST', defType: 'NORMAL', modifier: 0 })
      findAbility('ABILITY_PHANTOM_PAIN').onTypeEffectiveness!(c)
      return c.modifier
    })()).toBe(uq(1.0))
    expect((() => {
      const c = teCtx({ moveType: 'FIGHTING', defType: 'GHOST', modifier: 0 })
      findAbility('ABILITY_SCRAPPY').onTypeEffectiveness!(c)
      return c.modifier
    })()).toBe(uq(1.0))
  })

  it('Overclock and Pyroclastic Flow compose two mutually-exclusive conditions', () => {
    const c1 = teCtx({ moveType: 'ELECTRIC', defType: 'GROUND', modifier: 0 })
    findAbility('ABILITY_OVERCLOCK').onTypeEffectiveness!(c1)
    expect(c1.modifier).toBe(uq(0.5))
    const c2 = teCtx({ moveType: 'ELECTRIC', defType: 'ELECTRIC', modifier: uq(1.0) })
    findAbility('ABILITY_OVERCLOCK').onTypeEffectiveness!(c2)
    expect(c2.modifier).toBe(uq(2.0))

    const c3 = teCtx({ moveType: 'FIRE', defType: 'ROCK', modifier: 0 })
    findAbility('ABILITY_PYROCLASTIC_FLOW').onTypeEffectiveness!(c3)
    expect(c3.modifier).toBe(uq(2.0))
    const c4 = teCtx({ moveType: 'POISON', defType: 'STEEL', modifier: 0 })
    findAbility('ABILITY_PYROCLASTIC_FLOW').onTypeEffectiveness!(c4)
    expect(c4.modifier).toBe(uq(2.0))
  })

  it('Desert Spirit lets an airborne Ground move hit in sandstorm', () => {
    const c = afterCtx({ modifier: 0, targetGrounded: false, moveType: 'GROUND', weather: 'SANDSTORM' })
    findAbility('ABILITY_DESERT_SPIRIT').onAfterTypeEffectiveness!(c)
    expect(c.modifier).toBe(uq(1.0))
    const grounded = afterCtx({ modifier: 0, targetGrounded: true, moveType: 'GROUND', weather: 'SANDSTORM' })
    findAbility('ABILITY_DESERT_SPIRIT').onAfterTypeEffectiveness!(grounded)
    expect(grounded.modifier).toBe(0)
  })

  it('Gifted Mind and Mountaineer grant full immunity to specific move types', () => {
    const c = afterCtx({ moveType: 'GHOST', modifier: uq(1.0) })
    findAbility('ABILITY_GIFTED_MIND').onAfterTypeEffectiveness!(c)
    expect(c.modifier).toBe(0)
    const c2 = afterCtx({ moveType: 'ROCK', modifier: uq(1.0) })
    findAbility('ABILITY_MOUNTAINEER').onAfterTypeEffectiveness!(c2)
    expect(c2.modifier).toBe(0)
  })

  it('Telepathy is a documented permanent no-op in this v1 singles engine', () => {
    const c = afterCtx({ modifier: uq(1.0) })
    findAbility('ABILITY_TELEPATHY').onAfterTypeEffectiveness!(c)
    expect(c.modifier).toBe(uq(1.0))
  })

  it("Tera Shell halves a neutral-or-better hit while the ATTACKER is at max HP -- the upstream bug this pin reproduces (fixed later by c8d64d01292a)", () => {
    const c = afterCtx({ modifier: uq(1.0), attackerAtMaxHp: true })
    findAbility('ABILITY_TERA_SHELL').onAfterTypeEffectiveness!(c)
    expect(c.modifier).toBe(uq(0.5))
    const c2 = afterCtx({ modifier: uq(1.0), attackerAtMaxHp: false })
    findAbility('ABILITY_TERA_SHELL').onAfterTypeEffectiveness!(c2)
    expect(c2.modifier).toBe(uq(1.0))
    // The DEFENDER's (holder's) own HP must NOT gate it at this pin.
    const c3 = afterCtx({ modifier: uq(1.0), attackerAtMaxHp: true, defenderAtMaxHp: false })
    findAbility('ABILITY_TERA_SHELL').onAfterTypeEffectiveness!(c3)
    expect(c3.modifier).toBe(uq(0.5))
  })

  it('Wonder Guard zeroes out anything below super-effective', () => {
    const c = afterCtx({ modifier: uq(1.0) })
    findAbility('ABILITY_WONDER_GUARD').onAfterTypeEffectiveness!(c)
    expect(c.modifier).toBe(0)
    const c2 = afterCtx({ modifier: uq(2.0) })
    findAbility('ABILITY_WONDER_GUARD').onAfterTypeEffectiveness!(c2)
    expect(c2.modifier).toBe(uq(2.0))
  })

  it('Bone Zone boosts a resisted (but nonzero) hit to super-effective; leaves a neutral-or-better hit alone', () => {
    // The immunity-rescue branch (mod===0) and the super-effective boost are
    // SIBLING ifs in the C, not nested -- a merely-resisted (nonzero) hit skips
    // the rescue but still gets boosted, matching Bone Zone's real "ignores
    // resistances too" behavior for bone-based moves.
    const resisted = afterCtx({ moveFlags: { boneBased: true }, modifier: uq(0.5), perTypeModifiers: [uq(0.5), 0, 0] })
    findAbility('ABILITY_BONE_ZONE').onAfterTypeEffectiveness!(resisted)
    expect(resisted.modifier).toBe(uq(1.0)) // 0.5 * SUPER_EFFECTIVE(2.0) = 1.0

    const neutral = afterCtx({ moveFlags: { boneBased: true }, modifier: uq(1.0), perTypeModifiers: [uq(1.0), 0, 0] })
    findAbility('ABILITY_BONE_ZONE').onAfterTypeEffectiveness!(neutral)
    expect(neutral.modifier).toBe(uq(1.0)) // >=1.0 -- early return
  })

  it('Bone Zone rescues a fully-immune hit by refolding the per-type modifiers, then boosts if still resisted', () => {
    // Ground/Flying-style: one type immune (0), the other resisted (0.5) -- refold
    // gives 0.5, which is still <1.0, so the super-effective boost applies too.
    const immune = afterCtx({ moveFlags: { boneBased: true }, modifier: 0, perTypeModifiers: [0, uq(0.5), 0] })
    findAbility('ABILITY_BONE_ZONE').onAfterTypeEffectiveness!(immune)
    expect(immune.modifier).toBe(uq(1.0)) // refold(0.5) * SUPER_EFFECTIVE(2.0) = 1.0

    // Fully immune with an otherwise-neutral other type: refold gives 1.0, already
    // >=1.0 so the boost is skipped.
    const immuneNeutral = afterCtx({ moveFlags: { boneBased: true }, modifier: 0, perTypeModifiers: [0, uq(1.0), 0] })
    findAbility('ABILITY_BONE_ZONE').onAfterTypeEffectiveness!(immuneNeutral)
    expect(immuneNeutral.modifier).toBe(uq(1.0))
  })

  it('Bone Zone only fires for bone-based moves', () => {
    const c = afterCtx({ moveFlags: {}, modifier: 0, perTypeModifiers: [0, uq(0.5), 0] })
    findAbility('ABILITY_BONE_ZONE').onAfterTypeEffectiveness!(c)
    expect(c.modifier).toBe(0)
  })

  it('Soothsayer halves a neutral-or-better hit only while its shield (abilityOn) is up', () => {
    const shielded = afterCtx({ modifier: uq(1.0), defenderAbilityOn: true })
    findAbility('ABILITY_SOOTHSAYER').onAfterTypeEffectiveness!(shielded)
    expect(shielded.modifier).toBe(uq(0.5))

    const noShield = afterCtx({ modifier: uq(1.0), defenderAbilityOn: false })
    findAbility('ABILITY_SOOTHSAYER').onAfterTypeEffectiveness!(noShield)
    expect(noShield.modifier).toBe(uq(1.0))

    const alreadyResisted = afterCtx({ modifier: uq(0.5), defenderAbilityOn: true })
    findAbility('ABILITY_SOOTHSAYER').onAfterTypeEffectiveness!(alreadyResisted)
    expect(alreadyResisted.modifier).toBe(uq(0.5)) // < 1.0 already -- no further halving
  })

  it('every entry cites a src line', () => {
    for (const ability of TYPE_EFFECTIVENESS_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
