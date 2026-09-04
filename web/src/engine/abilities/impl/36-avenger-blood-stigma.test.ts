import { describe, expect, it } from 'vitest'
import { AVENGER_BLOOD_STIGMA_ABILITIES } from './36-avenger-blood-stigma'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = AVENGER_BLOOD_STIGMA_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function ctx(overrides: Partial<OffensiveMultiplierContext> = {}): OffensiveMultiplierContext {
  return {
    modifier: uq(1.0),
    resistance: uq(1.0),
    battlerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    moveType: 'NORMAL',
    moveSplit: 'PHYSICAL',
    moveFlags: {},
    basePower: 40,
    typeEffectiveness: uq(1.0),
    isCrit: false,
    attackerHasAnyStatus: false,
    attackerHp: 100,
    attackerMaxHp: 100,
    attackerActsFirst: true,
    weather: 'NONE',
    defenderTypes: [],
    attackerStatus1: new Set(),
    sameMoveTurnsInARow: 0,
    terrain: null,
    movePriority: 0,
    attackerAbilityOn: false,
    isAuraBreakActive: false,
    attackerGender: 'MALE',
    defenderGender: 'MALE',
    defenderIsConfused: false,
    defenderIsEnraged: false,
    defenderStatus1: new Set(),
    defenderHasBloodStainEffect: false,
    ...overrides,
  }
}

describe('avenger + blood stigma batch AJ', () => {
  it('Avenger boosts 1.5x only when abilityOn (reuses the generic activation toggle)', () => {
    const on = ctx({ attackerAbilityOn: true })
    findAbility('ABILITY_AVENGER').onOffensiveMultiplier!(on)
    expect(on.modifier).toBe(uq(1.5))

    const off = ctx()
    findAbility('ABILITY_AVENGER').onOffensiveMultiplier!(off)
    expect(off.modifier).toBe(uq(1.0))
  })

  it('Blood Stigma doubles damage when the DEFENDER is bleeding (status1 or Blood Stain)', () => {
    const bleeding = ctx({ defenderStatus1: new Set(['STATUS1_BLEED']) })
    findAbility('ABILITY_BLOOD_STIGMA').onOffensiveMultiplier!(bleeding)
    expect(bleeding.modifier).toBe(uq(2.0))

    const bloodStain = ctx({ defenderHasBloodStainEffect: true })
    findAbility('ABILITY_BLOOD_STIGMA').onOffensiveMultiplier!(bloodStain)
    expect(bloodStain.modifier).toBe(uq(2.0))

    const neither = ctx()
    findAbility('ABILITY_BLOOD_STIGMA').onOffensiveMultiplier!(neither)
    expect(neither.modifier).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of AVENGER_BLOOD_STIGMA_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
