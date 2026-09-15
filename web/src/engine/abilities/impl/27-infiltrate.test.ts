import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, _resetRegistryForTests } from '../registry'
import { computeInfiltratesScreens } from '../dispatchCalc'
import { INFILTRATE_ABILITIES } from './27-infiltrate'
import { ATE_FAMILY_AND_ONSTAB } from './15-ate-family-and-onstab'
import { ALIAS_ABILITIES } from './10-aliases'
import { OFFENSIVE_MULTIPLIER_BATCH_D } from './11-offensive-multiplier-d'
import { MOLD_BREAKER_ABILITIES } from './23-mold-breaker'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function slots(ability: string | null): { ability: string | null; innates: [string | null, string | null, string | null] } {
  return { ability, innates: [null, null, null] }
}

function ctx(overrides: Partial<{ moveType: string; moveFlags: Record<string, true>; moveSplit: 'PHYSICAL' | 'SPECIAL' | 'STATUS'; attackerTypes: string[] }> = {}) {
  return {
    moveType: 'NORMAL',
    moveFlags: {},
    moveSplit: 'PHYSICAL' as const,
    attackerTypes: [] as string[],
    ...overrides,
  }
}

describe('infiltrate batch AA', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(INFILTRATE_ABILITIES)
    registerAbilities(ATE_FAMILY_AND_ONSTAB)
    registerAbilities(ALIAS_ABILITIES)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_D)
    registerAbilities(MOLD_BREAKER_ABILITIES)
  })

  it('Infiltrator (and its aliases Duality, King of the Jungle, Marine Apex) are unconditional', () => {
    for (const id of ['ABILITY_INFILTRATOR', 'ABILITY_DUALITY', 'ABILITY_KING_OF_THE_JUNGLE', 'ABILITY_MARINE_APEX']) {
      expect(computeInfiltratesScreens(slots(id), ctx())).toBe(true)
    }
  })

  it('Fight Spirit (and its aliases Warriors Spear, Qigong) need a Fighting attacker using a Fighting move', () => {
    for (const id of ['ABILITY_FIGHT_SPIRIT', 'ABILITY_WARRIORS_SPEAR', 'ABILITY_QIGONG']) {
      expect(computeInfiltratesScreens(slots(id), ctx({ moveType: 'FIGHTING', attackerTypes: ['FIGHTING'] }))).toBe(true)
      expect(computeInfiltratesScreens(slots(id), ctx({ moveType: 'FIGHTING', attackerTypes: ['NORMAL'] }))).toBe(false)
      expect(computeInfiltratesScreens(slots(id), ctx({ moveType: 'NORMAL', attackerTypes: ['FIGHTING'] }))).toBe(false)
    }
  })

  it('Pinnacle Blade needs a slicing move', () => {
    expect(computeInfiltratesScreens(slots('ABILITY_PINNACLE_BLADE'), ctx({ moveFlags: { sliceBased: true } }))).toBe(true)
    expect(computeInfiltratesScreens(slots('ABILITY_PINNACLE_BLADE'), ctx())).toBe(false)
  })

  it('Mycelium Might needs a status move', () => {
    expect(computeInfiltratesScreens(slots('ABILITY_MYCELIUM_MIGHT'), ctx({ moveSplit: 'STATUS' }))).toBe(true)
    expect(computeInfiltratesScreens(slots('ABILITY_MYCELIUM_MIGHT'), ctx({ moveSplit: 'PHYSICAL' }))).toBe(false)
  })

  it('Demolitionist is always false -- readiedAction volatile state is untracked, same as elsewhere in this engine', () => {
    expect(computeInfiltratesScreens(slots('ABILITY_DEMOLITIONIST'), ctx())).toBe(false)
  })

  it('is never suppressed by Mold Breaker (checkMoldBreaker=FALSE -- an attacker trait, not a defender one)', () => {
    // computeInfiltratesScreens has no moldBreaker parameter at all -- this test
    // documents that omission is deliberate by simply not passing one.
    expect(computeInfiltratesScreens(slots('ABILITY_INFILTRATOR'), ctx())).toBe(true)
  })

  it('every entry cites a src line', () => {
    for (const ability of INFILTRATE_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })

  it("King of the Jungle boosts damage 1.5x vs Grass-type targets (no Grassy Surge at this pin)", () => {
    const kotj = INFILTRATE_ABILITIES.find((a) => a.id === 'ABILITY_KING_OF_THE_JUNGLE') as AbilityImpl
    const offCtx = (defenderTypes: string[]): OffensiveMultiplierContext => ({
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
      attackerSlowStartTimer: 5,
      attackerHasStab: false,
      basePower: 40,
      typeEffectiveness: uq(1.0),
      isCrit: false,
      attackerHasAnyStatus: false,
      attackerHp: 100,
      attackerMaxHp: 100,
      attackerActsFirst: true,
      weather: 'NONE',
      defenderTypes,
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
      attackerIsGrounded: true,
    })
    const grass = offCtx(['GRASS'])
    kotj.onOffensiveMultiplier!(grass)
    expect(grass.modifier).toBe(uq(1.5))
    const normal = offCtx(['NORMAL'])
    kotj.onOffensiveMultiplier!(normal)
    expect(normal.modifier).toBe(uq(1.0))
  })
})
