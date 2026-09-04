import { describe, expect, it } from 'vitest'
import { ABILITY_ACTIVATION_ABILITIES } from './29-ability-activation'
import type { AbilityImpl, OffensiveMultiplierContext, DefensiveMultiplierContext, OnStatContext, OnCritContext } from '../types'
import { uq } from '../../fixed'
import { ALWAYS_CRIT } from '../../crit'

function findAbility(id: string): AbilityImpl {
  const entry = ABILITY_ACTIVATION_ABILITIES.find((a) => a.id === id)
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
    moveEffectChance: 0,
    ateBoost: false,
    defenderHasComatose: false,
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
    attackerGender: 'MALE' as const,
    defenderGender: 'MALE' as const,
    defenderIsConfused: false,
    defenderIsEnraged: false,
    defenderStatus1: new Set<string>(),
    defenderHasBloodStainEffect: false,
    attackerIsUnaware: false,
    defenderHasAnyLoweredStat: false,
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
    attackerGender: 'MALE' as const,
    defenderGender: 'MALE' as const,
    defenderIsEnraged: false,
    ...overrides,
  }
}

function statCtx(overrides: Partial<OnStatContext> = {}): OnStatContext {
  return {
    battlerId: 'self',
    statId: 'atk',
    moveId: 'MOVE_TACKLE',
    stat: 100,
    flags: { nonStackingRuin: false, nonStackingEternalFlower: false },
    weather: 'NONE',
    terrain: null,
    hp: 100,
    maxHp: 100,
    hasAnyStatus: false,
    status1: new Set(),
    isHighestAttackingStat: false,
    isHighestStat: false,
    abilityOn: false,
    boostedStat: null,
    alliesFainted: 0,
    isMegaEvolved: false,
    statOwnerHasEternalFlower: false,
    ...overrides,
  }
}

function critCtx(overrides: Partial<OnCritContext> = {}): OnCritContext {
  return {
    battlerId: 'attacker',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    typeEffectiveness: uq(1.0),
    defenderStatus1: new Set<string>(),
    defenderSpeedStageNegative: false,
    defenderResolvedHoldEffect: null,
    moveFlags: {},
    basePower: 40,
    attackerActsFirst: true,
    abilityOn: false,
    ...overrides,
  }
}

describe('ability activation batch AC', () => {
  it('Unburden doubles Speed only when abilityOn (direct read)', () => {
    const ctx = statCtx({ statId: 'spe', stat: 100, abilityOn: true })
    findAbility('ABILITY_UNBURDEN').onStat!(ctx)
    expect(ctx.stat).toBe(200)

    const off = statCtx({ statId: 'spe', stat: 100, abilityOn: false })
    findAbility('ABILITY_UNBURDEN').onStat!(off)
    expect(off.stat).toBe(100)
  })

  it('Power Outage doubles Electric moves only when NOT yet discharged (inverted read)', () => {
    const notDischarged = { ...offCtx({ moveType: 'ELECTRIC' }), modifier: uq(1.0) }
    findAbility('ABILITY_POWER_OUTAGE').onOffensiveMultiplier!(notDischarged)
    expect(notDischarged.modifier).toBe(uq(2.0))

    const discharged = { ...offCtx({ moveType: 'ELECTRIC', attackerAbilityOn: true }), modifier: uq(1.0) }
    findAbility('ABILITY_POWER_OUTAGE').onOffensiveMultiplier!(discharged)
    expect(discharged.modifier).toBe(uq(1.0))
  })

  it('Chuckster halves contact damage only when NOT yet triggered (inverted read)', () => {
    const notTriggered = { ...defCtx({ moveFlags: { contact: true } }), modifier: uq(1.0) }
    findAbility('ABILITY_CHUCKSTER').onDefensiveMultiplier!(notTriggered)
    expect(notTriggered.modifier).toBe(uq(0.5))

    const triggered = { ...defCtx({ moveFlags: { contact: true }, defenderAbilityOn: true }), modifier: uq(1.0) }
    findAbility('ABILITY_CHUCKSTER').onDefensiveMultiplier!(triggered)
    expect(triggered.modifier).toBe(uq(1.0))

    const noContact = { ...defCtx({ moveFlags: {} }), modifier: uq(1.0) }
    findAbility('ABILITY_CHUCKSTER').onDefensiveMultiplier!(noContact)
    expect(noContact.modifier).toBe(uq(1.0))
  })

  it('Drakelp Head applies 0.65x to ANY move only when NOT yet triggered (inverted read)', () => {
    const notTriggered = { ...defCtx(), modifier: uq(1.0) }
    findAbility('ABILITY_DRAKELP_HEAD').onDefensiveMultiplier!(notTriggered)
    expect(notTriggered.modifier).toBe(uq(0.65))

    const triggered = { ...defCtx({ defenderAbilityOn: true }), modifier: uq(1.0) }
    findAbility('ABILITY_DRAKELP_HEAD').onDefensiveMultiplier!(triggered)
    expect(triggered.modifier).toBe(uq(1.0))
  })

  it('Stakeout doubles damage only when abilityOn (direct read)', () => {
    const on = { ...offCtx({ attackerAbilityOn: true }), modifier: uq(1.0) }
    findAbility('ABILITY_STAKEOUT').onOffensiveMultiplier!(on)
    expect(on.modifier).toBe(uq(2.0))

    const off = { ...offCtx(), modifier: uq(1.0) }
    findAbility('ABILITY_STAKEOUT').onOffensiveMultiplier!(off)
    expect(off.modifier).toBe(uq(1.0))
  })

  it('Ambush guarantees a crit only when abilityOn (direct read)', () => {
    expect(findAbility('ABILITY_AMBUSH').onCrit!(critCtx({ abilityOn: true }))).toBe(ALWAYS_CRIT)
    expect(findAbility('ABILITY_AMBUSH').onCrit!(critCtx({ abilityOn: false }))).toBe(0)
  })

  it('Slow Start halves Atk/SpAtk/Speed only when abilityOn (direct read); Def/SpDef untouched', () => {
    for (const statId of ['atk', 'spatk', 'spe'] as const) {
      const ctx = statCtx({ statId, stat: 100, abilityOn: true })
      findAbility('ABILITY_SLOW_START').onStat!(ctx)
      expect(ctx.stat).toBe(50)
    }
    const def = statCtx({ statId: 'def', stat: 100, abilityOn: true })
    findAbility('ABILITY_SLOW_START').onStat!(def)
    expect(def.stat).toBe(100)

    const off = statCtx({ statId: 'atk', stat: 100, abilityOn: false })
    findAbility('ABILITY_SLOW_START').onStat!(off)
    expect(off.stat).toBe(100)
  })

  it('every entry cites a src line', () => {
    for (const ability of ABILITY_ACTIVATION_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
