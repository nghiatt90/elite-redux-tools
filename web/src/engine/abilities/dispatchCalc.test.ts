import { beforeEach, describe, expect, it } from 'vitest'
import { computeAbilityCritBonus, computeAbilityMultiplier, computeOnStatModifier, hasFlag, hasFortKnox, hasStabOverride } from './dispatchCalc'
import { registerAbilities, _resetRegistryForTests } from './registry'
import { APPLY_ON_ANY } from './applyOn'
import { ALWAYS_CRIT, NEVER_CRIT } from '../crit'
import { uq } from '../fixed'
import type { AbilitySlots } from './dispatch'
import type { AbilityImpl } from './types'

function slots(ability: string | null, innates: (string | null)[] = [null, null, null]): AbilitySlots {
  return { ability, innates: innates as [string | null, string | null, string | null] }
}

beforeEach(() => {
  _resetRegistryForTests()
})

describe('computeAbilityMultiplier', () => {
  it('shares ONE accumulator across the offensive and defensive phases', () => {
    // Two 1.5x offensive boosts (attacker + defender-side offensive hook) then a
    // 0.5x defensive hook, all on the SAME running modifier -- verifies this isn't
    // two independently-computed results multiplied together afterward (see the
    // module doc comment on why that would give a different, wrong number).
    const boostAbility: AbilityImpl = { id: 'ABILITY_TEST_BOOST', src: 'test', onOffensiveMultiplier: (ctx) => (ctx.modifier = Math.floor((ctx.modifier * 1536 + 512) / 1024)) }
    const halveAbility: AbilityImpl = { id: 'ABILITY_TEST_HALVE', src: 'test', onDefensiveMultiplier: (ctx) => (ctx.modifier = Math.floor((ctx.modifier * 512 + 512) / 1024)) }
    registerAbilities([boostAbility, halveAbility])

    const attacker = slots('ABILITY_TEST_BOOST')
    const defender = slots('ABILITY_TEST_HALVE')
    const base = { defenderId: 'defender', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', moveSplit: 'PHYSICAL' as const, moveFlags: {}, moveEffectChance: 0, ateBoost: false, typeEffectiveness: uq(1.0), isCrit: false, weather: 'NONE', defenderAtMaxHp: true, attackerActsFirst: true, defenderTypes: [] as string[], defenderAbilityOn: false, attackerGender: 'MALE' as const, defenderGender: 'MALE' as const, defenderIsConfused: false, defenderIsEnraged: false, defenderStatus1: new Set<string>(), defenderHasBloodStainEffect: false, attackerIsUnaware: false, defenderHasAnyLoweredStat: false }
    const result = computeAbilityMultiplier(attacker, defender, { battlerId: 'attacker', basePower: 40, attackerHasAnyStatus: false,
    attackerHp: 100,
    attackerMaxHp: 100,
    attackerStatus1: new Set(), sameMoveTurnsInARow: 0, terrain: null, movePriority: 0, attackerAbilityOn: false, isAuraBreakActive: false,
    ...base }, { attackerId: 'attacker', ...base })

    // mulModifier(mulModifier(1024, 1536), 512) == mulModifier(1536, 512)
    const expected = Math.floor((Math.floor((1024 * 1536 + 512) / 1024) * 512 + 512) / 1024)
    expect(result).toBe(expected)
  })

  it('HasFortKnox on the defender suppresses ALL offensive multipliers, not just its own', () => {
    const boostAbility: AbilityImpl = { id: 'ABILITY_TEST_BOOST2', src: 'test', onOffensiveMultiplier: (ctx) => (ctx.modifier = Math.floor((ctx.modifier * 1536 + 512) / 1024)) }
    const fortKnox: AbilityImpl = { id: 'ABILITY_TEST_FORTKNOX', src: 'test', flags: { fortKnox: true } }
    registerAbilities([boostAbility, fortKnox])

    const attacker = slots('ABILITY_TEST_BOOST2')
    const defender = slots('ABILITY_TEST_FORTKNOX')
    const base = { defenderId: 'defender', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', moveSplit: 'PHYSICAL' as const, moveFlags: {}, moveEffectChance: 0, ateBoost: false, typeEffectiveness: uq(1.0), isCrit: false, weather: 'NONE', defenderAtMaxHp: true, attackerActsFirst: true, defenderTypes: [] as string[], defenderAbilityOn: false, attackerGender: 'MALE' as const, defenderGender: 'MALE' as const, defenderIsConfused: false, defenderIsEnraged: false, defenderStatus1: new Set<string>(), defenderHasBloodStainEffect: false, attackerIsUnaware: false, defenderHasAnyLoweredStat: false }
    const result = computeAbilityMultiplier(attacker, defender, { battlerId: 'attacker', basePower: 40, attackerHasAnyStatus: false,
    attackerHp: 100,
    attackerMaxHp: 100,
    attackerStatus1: new Set(), sameMoveTurnsInARow: 0, terrain: null, movePriority: 0, attackerAbilityOn: false, isAuraBreakActive: false,
    ...base }, { attackerId: 'attacker', ...base })
    expect(result).toBe(uq(1.0)) // the attacker's own boost never ran
  })

  it('hasFortKnox itself detects the flag across any of the 4 slots', () => {
    const fortKnox: AbilityImpl = { id: 'ABILITY_TEST_FORTKNOX2', src: 'test', flags: { fortKnox: true } }
    registerAbilities([fortKnox])
    expect(hasFortKnox(slots(null, ['ABILITY_TEST_FORTKNOX2', null, null]))).toBe(true)
    expect(hasFortKnox(slots(null))).toBe(false)
  })
})

describe('computeAbilityCritBonus', () => {
  it('sums stage bonuses from multiple abilities on the attacker (default APPLY_ON_SELF scope)', () => {
    const a: AbilityImpl = { id: 'ABILITY_TEST_CRITA', src: 'test', onCrit: () => 1 }
    const b: AbilityImpl = { id: 'ABILITY_TEST_CRITB', src: 'test', onCrit: () => 2 }
    registerAbilities([a, b])
    const result = computeAbilityCritBonus(slots('ABILITY_TEST_CRITA', ['ABILITY_TEST_CRITB', null, null]), slots(null), {
      defenderId: 'defender',
      moveId: 'MOVE_TACKLE',
      typeEffectiveness: uq(1.0),
      defenderStatus1: new Set<string>(),
      defenderSpeedStageNegative: false,
      defenderResolvedHoldEffect: null,
      moveFlags: {},
      basePower: 40,
      attackerActsFirst: true,
    })
    expect(result).toBe(3)
  })

  it('a defender-held onCrit hook needs an explicit non-self applyOn scope to fire at all', () => {
    // Verifies IsTargettedApplyOnFlagAppropriate's real default: contextBattler is
    // always the ATTACKER (src/battle_script_commands.c:1529-1536), so an ability
    // with no onCritFor set (APPLY_ON_SELF, the C struct's zero-value default) only
    // ever applies when ITS OWN BATTLER is attacking -- a defender-held ability with
    // the default scope is a silent no-op, by design, matching the C exactly.
    const unscoped: AbilityImpl = { id: 'ABILITY_TEST_CRIT_UNSCOPED', src: 'test', onCrit: () => 5 }
    registerAbilities([unscoped])
    const inputs = {
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
    expect(computeAbilityCritBonus(slots(null), slots('ABILITY_TEST_CRIT_UNSCOPED'), inputs)).toBe(0)

    _resetRegistryForTests()
    const scoped: AbilityImpl = { id: 'ABILITY_TEST_CRIT_SCOPED', src: 'test', applyOn: { onCritFor: APPLY_ON_ANY }, onCrit: () => 5 }
    registerAbilities([scoped])
    expect(computeAbilityCritBonus(slots(null), slots('ABILITY_TEST_CRIT_SCOPED'), inputs)).toBe(5)
  })

  it('NEVER_CRIT from either battler short-circuits the whole result', () => {
    const blocker: AbilityImpl = { id: 'ABILITY_TEST_BLOCKER', src: 'test', onCrit: () => NEVER_CRIT }
    const booster: AbilityImpl = { id: 'ABILITY_TEST_BOOSTER', src: 'test', onCrit: () => ALWAYS_CRIT }
    registerAbilities([blocker, booster])
    const result = computeAbilityCritBonus(slots('ABILITY_TEST_BLOCKER'), slots('ABILITY_TEST_BOOSTER'), {
      defenderId: 'defender',
      moveId: 'MOVE_TACKLE',
      typeEffectiveness: uq(1.0),
      defenderStatus1: new Set<string>(),
      defenderSpeedStageNegative: false,
      defenderResolvedHoldEffect: null,
      moveFlags: {},
      basePower: 40,
      attackerActsFirst: true,
    })
    expect(result).toBe(NEVER_CRIT)
  })
})

describe('hasStabOverride and hasFlag', () => {
  it('hasStabOverride returns true from the first qualifying slot (reverse order)', () => {
    const stabber: AbilityImpl = { id: 'ABILITY_TEST_STAB', src: 'test', onStab: (ctx) => ctx.moveType === 'FIRE' }
    registerAbilities([stabber])
    expect(hasStabOverride(slots(null, [null, 'ABILITY_TEST_STAB', null]), 'FIRE')).toBe(true)
    expect(hasStabOverride(slots(null, [null, 'ABILITY_TEST_STAB', null]), 'WATER')).toBe(false)
  })

  it('hasFlag finds a bitfield anywhere in the 4 slots', () => {
    const adapt: AbilityImpl = { id: 'ABILITY_TEST_ADAPT', src: 'test', flags: { adaptability: true } }
    registerAbilities([adapt])
    expect(hasFlag(slots('ABILITY_TEST_ADAPT'), 'adaptability')).toBe(true)
    expect(hasFlag(slots(null), 'adaptability')).toBe(false)
  })
})

describe('computeOnStatModifier', () => {
  it('the stat owner\'s own onStat hook applies by default (APPLY_ON_SELF)', () => {
    const ownHook: AbilityImpl = { id: 'ABILITY_TEST_OWNSTAT', src: 'test', onStat: (ctx) => (ctx.stat += 10) }
    registerAbilities([ownHook])
    const modify = computeOnStatModifier(slots('ABILITY_TEST_OWNSTAT'), slots(null), { battlerId: 'x', moveId: 'MOVE_TACKLE', statId: 'atk', weather: 'NONE', terrain: null, hp: 100, maxHp: 100, hasAnyStatus: false, status1: new Set(), isHighestAttackingStat: false, isHighestStat: false, abilityOn: false, boostedStat: null, alliesFainted: 0 })
    expect(modify(100)).toBe(110)
  })

  it('the OTHER battler\'s onStat hook needs an explicit non-self scope to affect this stat', () => {
    // IsApplyOnFlagAppropriate's default (unset onStatFor = APPLY_ON_SELF) only
    // fires when the ability holder IS the stat owner -- an opponent's ability
    // affecting your stat (e.g. an aura effect) must opt in explicitly.
    const unscoped: AbilityImpl = { id: 'ABILITY_TEST_OTHERSTAT_UNSCOPED', src: 'test', onStat: (ctx) => (ctx.stat *= 2) }
    registerAbilities([unscoped])
    const unscopedModify = computeOnStatModifier(slots(null), slots('ABILITY_TEST_OTHERSTAT_UNSCOPED'), { battlerId: 'x', moveId: 'MOVE_TACKLE', statId: 'atk', weather: 'NONE', terrain: null, hp: 100, maxHp: 100, hasAnyStatus: false, status1: new Set(), isHighestAttackingStat: false, isHighestStat: false, abilityOn: false, boostedStat: null, alliesFainted: 0 })
    expect(unscopedModify(100)).toBe(100) // no-op: the other battler's ability never applied

    _resetRegistryForTests()
    const scoped: AbilityImpl = { id: 'ABILITY_TEST_OTHERSTAT_SCOPED', src: 'test', applyOn: { onStatFor: APPLY_ON_ANY }, onStat: (ctx) => (ctx.stat *= 2) }
    registerAbilities([scoped])
    const scopedModify = computeOnStatModifier(slots(null), slots('ABILITY_TEST_OTHERSTAT_SCOPED'), { battlerId: 'x', moveId: 'MOVE_TACKLE', statId: 'atk', weather: 'NONE', terrain: null, hp: 100, maxHp: 100, hasAnyStatus: false, status1: new Set(), isHighestAttackingStat: false, isHighestStat: false, abilityOn: false, boostedStat: null, alliesFainted: 0 })
    expect(scopedModify(100)).toBe(200)
  })
})
