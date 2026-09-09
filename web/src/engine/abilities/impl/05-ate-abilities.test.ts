import { describe, expect, it } from 'vitest'
import { ATE_ABILITIES } from './05-ate-abilities'
import { resolveEffectiveMoveType, hasStabOverride } from '../dispatchCalc'
import type { AbilitySlots } from '../dispatch'
import { registerAbilities, _resetRegistryForTests } from '../registry'

_resetRegistryForTests()
registerAbilities(ATE_ABILITIES)

function slots(ability: string | null): AbilitySlots {
  return { ability, innates: [null, null, null] }
}

describe('ate abilities', () => {
  it('Pixilate turns a Normal move into Fairy, and only a Normal move', () => {
    const holder = slots('ABILITY_PIXILATE')
    expect(resolveEffectiveMoveType(holder, 'MOVE_TACKLE', 'NORMAL')).toEqual({ moveType: 'FAIRY', ateBoost: true })
    expect(resolveEffectiveMoveType(holder, 'MOVE_EMBER', 'FIRE')).toEqual({ moveType: 'FIRE', ateBoost: false })
  })

  it('Refrigerate/Galvanize/Pollinate each convert to their own type', () => {
    expect(resolveEffectiveMoveType(slots('ABILITY_REFRIGERATE'), 'MOVE_TACKLE', 'NORMAL').moveType).toBe('ICE')
    expect(resolveEffectiveMoveType(slots('ABILITY_GALVANIZE'), 'MOVE_TACKLE', 'NORMAL').moveType).toBe('ELECTRIC')
    expect(resolveEffectiveMoveType(slots('ABILITY_POLLINATE'), 'MOVE_TACKLE', 'NORMAL').moveType).toBe('BUG')
  })

  it('a battler with no ate ability leaves the type untouched', () => {
    expect(resolveEffectiveMoveType(slots(null), 'MOVE_TACKLE', 'NORMAL')).toEqual({ moveType: 'NORMAL', ateBoost: false })
  })

  it('onStab grants pseudo-STAB once the type has actually changed', () => {
    expect(hasStabOverride(slots('ABILITY_PIXILATE'), 'FAIRY')).toBe(true)
    expect(hasStabOverride(slots('ABILITY_PIXILATE'), 'NORMAL')).toBe(false)
  })

  it('Moon Spirit and Mystic Power are onStab-only (no type change)', () => {
    expect(hasStabOverride(slots('ABILITY_MOON_SPIRIT'), 'DARK')).toBe(true)
    expect(hasStabOverride(slots('ABILITY_MOON_SPIRIT'), 'FAIRY')).toBe(true)
    expect(hasStabOverride(slots('ABILITY_MOON_SPIRIT'), 'WATER')).toBe(false)
    expect(hasStabOverride(slots('ABILITY_MYSTIC_POWER'), 'ANYTHING')).toBe(true) // omniStab: unconditional
  })

  it('every entry cites a src line', () => {
    for (const ability of ATE_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
