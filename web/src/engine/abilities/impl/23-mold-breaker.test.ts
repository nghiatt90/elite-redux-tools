import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, _resetRegistryForTests } from '../registry'
import { computeAttackerHasMoldBreaker, computeAbilityMultiplier, computeAbilityCritBonus } from '../dispatchCalc'
import { battlerHasAbility } from '../dispatch'
import { MOLD_BREAKER_ABILITIES } from './23-mold-breaker'
import { ADDS_TYPE_ABILITIES } from './12-adds-type'
import { ALIAS_ABILITIES } from './10-aliases'
import { DEFENSIVE_MULTIPLIER_BATCH_A } from './02-defensive-multiplier-a'
import { HUB_ABILITIES } from './09-hub-abilities'
import { NEVER_CRIT } from '../../crit'
import { uq } from '../../fixed'

function slots(ability: string | null): { ability: string | null; innates: [string | null, string | null, string | null] } {
  return { ability, innates: [null, null, null] }
}

describe('mold breaker batch W', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(MOLD_BREAKER_ABILITIES)
    registerAbilities(ADDS_TYPE_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
    registerAbilities(DEFENSIVE_MULTIPLIER_BATCH_A)
    registerAbilities(HUB_ABILITIES)
  })

  it('Mold Breaker is unconditionally active; Teravolt/Turboblaze/Blind Rage alias it', () => {
    for (const id of ['ABILITY_MOLD_BREAKER', 'ABILITY_TERAVOLT', 'ABILITY_TURBOBLAZE', 'ABILITY_BLIND_RAGE']) {
      expect(computeAttackerHasMoldBreaker(slots(id), 'MOVE_TACKLE', 'PHYSICAL')).toBe(true)
    }
  })

  it('Mycelium Might only activates for status moves', () => {
    expect(computeAttackerHasMoldBreaker(slots('ABILITY_MYCELIUM_MIGHT'), 'MOVE_GROWL', 'STATUS')).toBe(true)
    expect(computeAttackerHasMoldBreaker(slots('ABILITY_MYCELIUM_MIGHT'), 'MOVE_TACKLE', 'PHYSICAL')).toBe(false)
  })

  it('a non-mold-breaker attacker reports false', () => {
    expect(computeAttackerHasMoldBreaker(slots(null), 'MOVE_TACKLE', 'PHYSICAL')).toBe(false)
    expect(computeAttackerHasMoldBreaker(slots('ABILITY_MULTISCALE'), 'MOVE_TACKLE', 'PHYSICAL')).toBe(false) // real ability, no onMoldBreaker hook
  })

  it('Mold Breaker bypasses a breakable defensive multiplier (e.g. Multiscale)', () => {
    const attacker = slots('ABILITY_MOLD_BREAKER')
    const defender = slots('ABILITY_MULTISCALE')
    const offensiveCtx = {
      battlerId: 'attacker',
      defenderId: 'defender',
      moveId: 'MOVE_TACKLE',
      moveType: 'NORMAL',
      moveSplit: 'PHYSICAL' as const,
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
      attackerStatus1: new Set<string>(),
      sameMoveTurnsInARow: 0,
      terrain: null,
      movePriority: 0,
      attackerAbilityOn: false,
      isAuraBreakActive: false,
      attackerGender: 'MALE' as const,
      defenderGender: 'MALE' as const,
      defenderIsConfused: false,
      defenderIsEnraged: false,
    }
    const defensiveCtx = {
      defenderId: 'defender',
      attackerId: 'attacker',
      moveId: 'MOVE_TACKLE',
      moveType: 'NORMAL',
      moveSplit: 'PHYSICAL' as const,
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
    }

    const withMoldBreaker = computeAbilityMultiplier(attacker, defender, offensiveCtx, defensiveCtx, true)
    expect(withMoldBreaker).toBe(uq(1.0)) // Multiscale's 0.5x suppressed

    const withoutMoldBreaker = computeAbilityMultiplier(slots(null), defender, offensiveCtx, defensiveCtx, false)
    expect(withoutMoldBreaker).toBe(uq(0.5)) // Multiscale applies normally
  })

  it('Mold Breaker bypasses Battle Armor/Shell Armor\'s crit denial', () => {
    const critInputs = {
      defenderId: 'defender',
      moveId: 'MOVE_TACKLE',
      typeEffectiveness: uq(1.0),
      defenderStatus1: new Set<string>(),
      defenderSpeedStageNegative: false,
      defenderResolvedHoldEffect: null,
      moveFlags: {},
      basePower: 40,
      attackerActsFirst: true,
    }
    const withMoldBreaker = computeAbilityCritBonus(slots('ABILITY_MOLD_BREAKER'), slots('ABILITY_BATTLE_ARMOR'), critInputs, true)
    expect(withMoldBreaker).toBe(0) // no bonus, but NOT blocked

    const withoutMoldBreaker = computeAbilityCritBonus(slots(null), slots('ABILITY_BATTLE_ARMOR'), critInputs, false)
    expect(withoutMoldBreaker).toBe(NEVER_CRIT)
  })

  it("battlerHasAbility's own suppression predicate correctly gates Relic Stone under mold breaker (regression for stabInHalves)", () => {
    const defender = slots('ABILITY_RELIC_STONE')
    expect(battlerHasAbility(defender, 'ABILITY_RELIC_STONE', () => true)).toBe(false) // suppressed
    expect(battlerHasAbility(defender, 'ABILITY_RELIC_STONE', () => false)).toBe(true) // present, unsuppressed
  })

  it('every entry cites a src line', () => {
    for (const ability of MOLD_BREAKER_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
