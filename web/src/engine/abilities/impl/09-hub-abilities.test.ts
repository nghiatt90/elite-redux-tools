import { describe, expect, it } from 'vitest'
import { HUB_ABILITIES } from './09-hub-abilities'
import { isTargettedApplyOnFlagAppropriate } from '../applyOn'
import { NEVER_CRIT } from '../../crit'
import type { AbilityImpl, DefensiveMultiplierContext, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = HUB_ABILITIES.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function offCtx(overrides: Partial<OffensiveMultiplierContext> = {}): OffensiveMultiplierContext {
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
    ...overrides,
  }
}

function defCtx(overrides: Partial<DefensiveMultiplierContext> = {}): DefensiveMultiplierContext {
  return {
    modifier: uq(1.0),
    resistance: uq(1.0),
    defenderId: 'defender',
    attackerId: 'attacker',
    moveId: 'MOVE_TACKLE',
    moveType: 'NORMAL',
    moveSplit: 'PHYSICAL',
    moveFlags: {},
    typeEffectiveness: uq(1.0),
    isCrit: false,
    weather: 'NONE',
    defenderAtMaxHp: true,
    attackerActsFirst: true,
    defenderTypes: [],
    defenderAbilityOn: false,
    ...overrides,
  }
}

describe('hub abilities', () => {
  it('Battle Armor: x0.8 defensive, never crits, and its onCritFor scopes to the target', () => {
    const ability = findAbility('ABILITY_BATTLE_ARMOR')
    const c = defCtx()
    ability.onDefensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(0.8))
    expect(ability.onCrit!({} as never)).toBe(NEVER_CRIT)
    expect(isTargettedApplyOnFlagAppropriate(false, true, false, false, ability.applyOn!.onCritFor)).toBe(true)
    expect(isTargettedApplyOnFlagAppropriate(true, false, false, false, ability.applyOn!.onCritFor)).toBe(false)
  })

  it('Stall: x0.7 defensive only when the attacker acts first', () => {
    const ability = findAbility('ABILITY_STALL')
    const first = defCtx({ attackerActsFirst: true })
    ability.onDefensiveMultiplier!(first)
    expect(first.modifier).toBe(uq(0.7))
    const second = defCtx({ attackerActsFirst: false })
    ability.onDefensiveMultiplier!(second)
    expect(second.modifier).toBe(uq(1.0))
  })

  it('Analytic: x1.3 offensive only when the attacker acts SECOND', () => {
    const ability = findAbility('ABILITY_ANALYTIC')
    const second = offCtx({ attackerActsFirst: false })
    ability.onOffensiveMultiplier!(second)
    expect(second.modifier).toBe(uq(1.3))
    const first = offCtx({ attackerActsFirst: true })
    ability.onOffensiveMultiplier!(first)
    expect(first.modifier).toBe(uq(1.0))
  })

  it('Water Bubble: x2.0 offensive on Water moves, x0.5 defensive vs Fire (Heatproof delegate)', () => {
    const ability = findAbility('ABILITY_WATER_BUBBLE')
    const off = offCtx({ moveType: 'WATER' })
    ability.onOffensiveMultiplier!(off)
    expect(off.modifier).toBe(uq(2.0))
    const def = defCtx({ moveType: 'FIRE' })
    ability.onDefensiveMultiplier!(def)
    expect(def.modifier).toBe(uq(0.5))
  })

  it('Fatal Precision: guaranteed crit only against a super-effective (>=2x) hit', () => {
    const ability = findAbility('ABILITY_FATAL_PRECISION')
    expect(ability.onCrit!({ typeEffectiveness: uq(2.0) } as never)).toBe(3)
    expect(ability.onCrit!({ typeEffectiveness: uq(1.0) } as never)).toBe(0)
  })

  it('Sand Guard: x0.5 defensive vs a special move while sandstorm is active', () => {
    const ability = findAbility('ABILITY_SAND_GUARD')
    const c = defCtx({ moveSplit: 'SPECIAL', weather: 'SANDSTORM' })
    ability.onDefensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(0.5))
    const noSand = defCtx({ moveSplit: 'SPECIAL', weather: 'NONE' })
    ability.onDefensiveMultiplier!(noSand)
    expect(noSand.modifier).toBe(uq(1.0))
    const physicalInSand = defCtx({ moveSplit: 'PHYSICAL', weather: 'SANDSTORM' })
    ability.onDefensiveMultiplier!(physicalInSand)
    expect(physicalInSand.modifier).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of HUB_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
