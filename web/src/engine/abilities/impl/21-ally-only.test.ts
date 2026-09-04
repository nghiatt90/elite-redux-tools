import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, _resetRegistryForTests } from '../registry'
import { computeAbilityMultiplier, computeOnStatModifier } from '../dispatchCalc'
import { ALLY_ONLY_ABILITIES } from './21-ally-only'
import { uq } from '../../fixed'

describe('ally-only batch S', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(ALLY_ONLY_ABILITIES)
  })

  it("Mosh Pit never fires even when held by the attacker (ALLY_ONLY excludes self)", () => {
    const attacker = { ability: 'ABILITY_MOSH_PIT', innates: [null, null, null] as [string | null, string | null, string | null] }
    const defender = { ability: null, innates: [null, null, null] as [string | null, string | null, string | null] }
    const result = computeAbilityMultiplier(
      attacker,
      defender,
      {
        battlerId: 'attacker',
        defenderId: 'defender',
        moveId: 'MOVE_TACKLE',
        moveType: 'NORMAL',
        moveSplit: 'PHYSICAL',
        moveFlags: { reckless: true },
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
      },
      {
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
      },
    )
    expect(result).toBe(uq(1.0))
  })

  it("Rat King never fires even when held by the stat owner (ALLY excludes self by default)", () => {
    const owner = { ability: 'ABILITY_RAT_KING', innates: [null, null, null] as [string | null, string | null, string | null] }
    const other = { ability: null, innates: [null, null, null] as [string | null, string | null, string | null] }
    const modify = computeOnStatModifier(owner, other, {
      battlerId: 'self',
      statId: 'atk',
      moveId: 'MOVE_TACKLE',
      weather: 'NONE',
      terrain: null,
      hp: 100,
      maxHp: 100,
      hasAnyStatus: false,
      status1: new Set(),
      isHighestAttackingStat: true,
      isHighestStat: true,
      abilityOn: false,
      boostedStat: null,
      alliesFainted: 0,
    })
    expect(modify(100)).toBe(100)
  })

  it('every entry cites a src line', () => {
    for (const ability of ALLY_ONLY_ABILITIES) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
