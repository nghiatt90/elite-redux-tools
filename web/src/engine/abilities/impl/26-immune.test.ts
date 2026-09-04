import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, _resetRegistryForTests } from '../registry'
import { computeIsImmune } from '../dispatchCalc'
import { IMMUNE_ABILITIES } from './26-immune'
import { ALIAS_ABILITIES } from './10-aliases'
import { HUB_ABILITIES } from './09-hub-abilities'
import { DEFENSIVE_MULTIPLIER_BATCH_C } from './13-defensive-multiplier-c'

function slots(ability: string | null): { ability: string | null; innates: [string | null, string | null, string | null] } {
  return { ability, innates: [null, null, null] }
}

function ctx(overrides: Partial<{ moveType: string; moveFlags: Record<string, true>; moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'; weather: string; movePriority: number }> = {}) {
  return {
    moveType: 'NORMAL',
    moveFlags: {},
    moveSplit: 'PHYSICAL' as const,
    weather: 'NONE',
    movePriority: 0,
    ...overrides,
  }
}

describe('immune batch Z', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(IMMUNE_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
    registerAbilities(HUB_ABILITIES)
    registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_C)
  })

  it('Queenly Majesty (and its aliases Armor Tail, Royal Decree, Dazzling, Lucha Libre) block priority moves only', () => {
    for (const id of ['ABILITY_QUEENLY_MAJESTY', 'ABILITY_ARMOR_TAIL', 'ABILITY_ROYAL_DECREE', 'ABILITY_DAZZLING', 'ABILITY_LUCHA_LIBRE']) {
      expect(computeIsImmune(slots(id), ctx({ movePriority: 1 }), false)).toBe(true)
      expect(computeIsImmune(slots(id), ctx({ movePriority: 0 }), false)).toBe(false)
    }
  })

  it('Bulletproof (and Chestnut Shield) block ballistic moves only', () => {
    for (const id of ['ABILITY_BULLETPROOF', 'ABILITY_CHESTNUT_SHIELD']) {
      expect(computeIsImmune(slots(id), ctx({ moveFlags: { ballistic: true } }), false)).toBe(true)
      expect(computeIsImmune(slots(id), ctx(), false)).toBe(false)
    }
  })

  it('Soundproof (and Noise Cancel, Parroting) block sound moves only', () => {
    for (const id of ['ABILITY_SOUNDPROOF', 'ABILITY_NOISE_CANCEL', 'ABILITY_PARROTING']) {
      expect(computeIsImmune(slots(id), ctx({ moveFlags: { sound: true } }), false)).toBe(true)
      expect(computeIsImmune(slots(id), ctx(), false)).toBe(false)
    }
  })

  it('Delta Stream (and Weather Control) block weather-based moves only', () => {
    for (const id of ['ABILITY_DELTA_STREAM', 'ABILITY_WEATHER_CONTROL']) {
      expect(computeIsImmune(slots(id), ctx({ moveFlags: { weatherBased: true } }), false)).toBe(true)
      expect(computeIsImmune(slots(id), ctx(), false)).toBe(false)
    }
  })

  it('Good As Gold blocks status moves only', () => {
    expect(computeIsImmune(slots('ABILITY_GOOD_AS_GOLD'), ctx({ moveSplit: 'STATUS' }), false)).toBe(true)
    expect(computeIsImmune(slots('ABILITY_GOOD_AS_GOLD'), ctx({ moveSplit: 'PHYSICAL' }), false)).toBe(false)
  })

  it('Radiance blocks Dark-type moves only', () => {
    expect(computeIsImmune(slots('ABILITY_RADIANCE'), ctx({ moveType: 'DARK' }), false)).toBe(true)
    expect(computeIsImmune(slots('ABILITY_RADIANCE'), ctx({ moveType: 'FIGHTING' }), false)).toBe(false)
  })

  it('Sand Guard/Sand Fiend/Sepia Lens block priority moves ONLY during sandstorm', () => {
    for (const id of ['ABILITY_SAND_GUARD', 'ABILITY_SAND_FIEND', 'ABILITY_SEPIA_LENS']) {
      expect(computeIsImmune(slots(id), ctx({ weather: 'SANDSTORM', movePriority: 1 }), false)).toBe(true)
      expect(computeIsImmune(slots(id), ctx({ weather: 'NONE', movePriority: 1 }), false)).toBe(false)
      expect(computeIsImmune(slots(id), ctx({ weather: 'SANDSTORM', movePriority: 0 }), false)).toBe(false)
    }
  })

  it('Sun Basking (and Empress via a different chain -- see below) blocks priority moves ONLY during sun', () => {
    for (const weather of ['SUN_PERMANENT', 'SUN_TEMPORARY', 'SUN_PRIMAL']) {
      expect(computeIsImmune(slots('ABILITY_SUN_BASKING'), ctx({ weather, movePriority: 1 }), false)).toBe(true)
    }
    expect(computeIsImmune(slots('ABILITY_SUN_BASKING'), ctx({ weather: 'NONE', movePriority: 1 }), false)).toBe(false)
    expect(computeIsImmune(slots('ABILITY_SUN_BASKING'), ctx({ weather: 'SUN_PERMANENT', movePriority: 0 }), false)).toBe(false)
  })

  it('Empress aliases Queenly Majesty directly (no weather gate)', () => {
    expect(computeIsImmune(slots('ABILITY_EMPRESS'), ctx({ movePriority: 1 }), false)).toBe(true)
    expect(computeIsImmune(slots('ABILITY_EMPRESS'), ctx({ movePriority: 0 }), false)).toBe(false)
  })

  it('Mold Breaker suppresses every breakable blocker but not Delta Stream', () => {
    expect(computeIsImmune(slots('ABILITY_SOUNDPROOF'), ctx({ moveFlags: { sound: true } }), true)).toBe(false)
    expect(computeIsImmune(slots('ABILITY_DELTA_STREAM'), ctx({ moveFlags: { weatherBased: true } }), true)).toBe(true)
  })

  it('every entry cites a src line', () => {
    for (const ability of IMMUNE_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
