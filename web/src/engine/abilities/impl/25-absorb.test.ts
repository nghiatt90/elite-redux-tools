import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, _resetRegistryForTests } from '../registry'
import { computeIsAbsorbed } from '../dispatchCalc'
import { ABSORB_ABILITIES } from './25-absorb'
import { ALIAS_ABILITIES } from './10-aliases'
import { DEFENSIVE_MULTIPLIER_BATCH_C } from './13-defensive-multiplier-c'

function slots(ability: string | null): { ability: string | null; innates: [string | null, string | null, string | null] } {
  return { ability, innates: [null, null, null] }
}

function ctx(moveType: string, moveFlags: Record<string, true> = {}) {
  return { moveType, moveFlags }
}

describe('absorb batch Y', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(ABSORB_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
    registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_C)
  })

  it('each simple type-gated absorber only fires for its own type', () => {
    const cases: [string, string][] = [
      ['ABILITY_AERODYNAMICS', 'FLYING'],
      ['ABILITY_EARTH_EATER', 'GROUND'],
      ['ABILITY_EVAPORATE', 'WATER'],
      ['ABILITY_FIRE_ASPECT', 'FIRE'],
      ['ABILITY_FLASH_FIRE', 'FIRE'],
      ['ABILITY_HEAT_SINK', 'FIRE'],
      ['ABILITY_ICE_DEW', 'ICE'],
      ['ABILITY_JUSTIFIED', 'DARK'],
      ['ABILITY_LIGHTNING_ASPECT', 'ELECTRIC'],
      ['ABILITY_LIGHTNING_ROD', 'ELECTRIC'],
      ['ABILITY_MOLTEN_CORE', 'ROCK'],
      ['ABILITY_MOTOR_DRIVE', 'ELECTRIC'],
      ['ABILITY_POISON_ABSORB', 'POISON'],
      ['ABILITY_RESERVOIR', 'WATER'],
      ['ABILITY_SAP_SIPPER', 'GRASS'],
      ['ABILITY_STORM_DRAIN', 'WATER'],
      ['ABILITY_VOLT_ABSORB', 'ELECTRIC'],
      ['ABILITY_WATER_ABSORB', 'WATER'],
      ['ABILITY_WELL_BAKED_BODY', 'FIRE'],
      ['ABILITY_DRY_SKIN', 'WATER'],
    ]
    for (const [id, absorbedType] of cases) {
      expect(computeIsAbsorbed(slots(id), ctx(absorbedType), false)).toBe(true)
      expect(computeIsAbsorbed(slots(id), ctx('NORMAL'), false)).toBe(false)
    }
  })

  it('Wind Rider checks the airBased move flag, not a type', () => {
    expect(computeIsAbsorbed(slots('ABILITY_WIND_RIDER'), ctx('FLYING', { airBased: true }), false)).toBe(true)
    expect(computeIsAbsorbed(slots('ABILITY_WIND_RIDER'), ctx('FLYING'), false)).toBe(false)
  })

  it('Elemental Vortex absorbs EITHER Water or Fire (Water Absorb OR Flash Fire)', () => {
    expect(computeIsAbsorbed(slots('ABILITY_ELEMENTAL_VORTEX'), ctx('WATER'), false)).toBe(true)
    expect(computeIsAbsorbed(slots('ABILITY_ELEMENTAL_VORTEX'), ctx('FIRE'), false)).toBe(true)
    expect(computeIsAbsorbed(slots('ABILITY_ELEMENTAL_VORTEX'), ctx('GRASS'), false)).toBe(false)
  })

  it('Mold Breaker suppresses every breakable absorber but not Justified or Elemental Vortex', () => {
    expect(computeIsAbsorbed(slots('ABILITY_WATER_ABSORB'), ctx('WATER'), true)).toBe(false) // breakable, suppressed
    expect(computeIsAbsorbed(slots('ABILITY_JUSTIFIED'), ctx('DARK'), true)).toBe(true) // not breakable
    expect(computeIsAbsorbed(slots('ABILITY_ELEMENTAL_VORTEX'), ctx('WATER'), true)).toBe(true) // not breakable
  })

  it('every entry cites a src line', () => {
    for (const ability of ABSORB_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
