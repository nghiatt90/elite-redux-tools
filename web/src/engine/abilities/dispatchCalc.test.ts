import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeAbilityCritBonus,
  computeAbilityMultiplier,
  computeAfterTypeEffectiveness,
  computeOnStatModifier,
  computeSwapSplit,
  computeTypeEffectivenessWithAbilities,
  hasFlag,
  hasFortKnox,
  hasStabOverride,
  isIronFistBoosted,
} from './dispatchCalc'
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
    const base = { defenderId: 'defender', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', moveSplit: 'PHYSICAL' as const, moveFlags: {}, moveEffectChance: 0, ateBoost: false, defenderHasComatose: false, attackerSlowStartTimer: 5, attackerHasStab: false, typeEffectiveness: uq(1.0), isCrit: false, weather: 'NONE', defenderAtMaxHp: true, attackerActsFirst: true, defenderTypes: [] as string[], defenderAbilityOn: false, attackerGender: 'MALE' as const, defenderGender: 'MALE' as const, defenderIsConfused: false, defenderIsEnraged: false, defenderStatus1: new Set<string>(), defenderHasBloodStainEffect: false, attackerIsUnaware: false, defenderHasAnyLoweredStat: false, attackerIsGrounded: true, attackerTypes: [] as string[] }
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
    const base = { defenderId: 'defender', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', moveSplit: 'PHYSICAL' as const, moveFlags: {}, moveEffectChance: 0, ateBoost: false, defenderHasComatose: false, attackerSlowStartTimer: 5, attackerHasStab: false, typeEffectiveness: uq(1.0), isCrit: false, weather: 'NONE', defenderAtMaxHp: true, attackerActsFirst: true, defenderTypes: [] as string[], defenderAbilityOn: false, attackerGender: 'MALE' as const, defenderGender: 'MALE' as const, defenderIsConfused: false, defenderIsEnraged: false, defenderStatus1: new Set<string>(), defenderHasBloodStainEffect: false, attackerIsUnaware: false, defenderHasAnyLoweredStat: false, attackerIsGrounded: true, attackerTypes: [] as string[] }
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

describe('isIronFistBoosted', () => {
  it("the move's own static punchBased flag wins outright, no ability needed", () => {
    expect(isIronFistBoosted(slots(null), { punchBased: true }, 'PHYSICAL')).toBe(true)
  })

  it('a non-punch move with no relevant ability is not boosted', () => {
    expect(isIronFistBoosted(slots(null), {}, 'PHYSICAL')).toBe(false)
  })

  it("falls back to an ability's onModifyMoveFlags, passing the dummy TYPE_NORMAL (not the move's real type)", () => {
    const grantsPunchOnNormalOnly: AbilityImpl = {
      id: 'ABILITY_TEST_GRANTS_PUNCH',
      src: 'test',
      onModifyMoveFlags: (ctx) => ctx.flag === 'punchBased' && ctx.moveType === 'NORMAL',
    }
    registerAbilities([grantsPunchOnNormalOnly])
    // No moveType is passed in at all -- this always checks against the dummy, so
    // it grants punch regardless of what type the move actually is.
    expect(isIronFistBoosted(slots('ABILITY_TEST_GRANTS_PUNCH'), {}, 'PHYSICAL')).toBe(true)
  })

  it('does not fall back to an ability that requires a flag already present', () => {
    const crossSwap: AbilityImpl = {
      id: 'ABILITY_TEST_CROSS_SWAP',
      src: 'test',
      onModifyMoveFlags: (ctx) => ctx.flag === 'punchBased' && Boolean(ctx.moveFlags.kickBased),
    }
    registerAbilities([crossSwap])
    expect(isIronFistBoosted(slots('ABILITY_TEST_CROSS_SWAP'), {}, 'PHYSICAL')).toBe(false)
    expect(isIronFistBoosted(slots('ABILITY_TEST_CROSS_SWAP'), { kickBased: true }, 'PHYSICAL')).toBe(true)
  })
})

describe('computeSwapSplit', () => {
  const swapIfPhysicalSlicing: AbilityImpl = {
    id: 'ABILITY_TEST_MYSTIC_BLADES',
    src: 'test',
    onSwapSplit: (ctx) => ctx.moveSplit === 'PHYSICAL' && Boolean(ctx.moveFlags.sliceBased),
  }

  it('no matching ability -> no swap', () => {
    expect(
      computeSwapSplit(slots(null), { battlerId: 'attacker', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', moveSplit: 'PHYSICAL', moveFlags: {} }),
    ).toBe(false)
  })

  it("a physical slicing move with Mystic Blades-shaped ability -> swap", () => {
    registerAbilities([swapIfPhysicalSlicing])
    expect(
      computeSwapSplit(slots('ABILITY_TEST_MYSTIC_BLADES'), {
        battlerId: 'attacker',
        moveId: 'MOVE_SLASH',
        moveType: 'NORMAL',
        moveSplit: 'PHYSICAL',
        moveFlags: { sliceBased: true },
      }),
    ).toBe(true)
  })

  it('a special slicing move does not swap (condition already false, matching the C)', () => {
    registerAbilities([swapIfPhysicalSlicing])
    expect(
      computeSwapSplit(slots('ABILITY_TEST_MYSTIC_BLADES'), {
        battlerId: 'attacker',
        moveId: 'MOVE_SLASH',
        moveType: 'NORMAL',
        moveSplit: 'SPECIAL',
        moveFlags: { sliceBased: true },
      }),
    ).toBe(false)
  })
})

describe('computeOnStatModifier', () => {
  it('the stat owner\'s own onStat hook applies by default (APPLY_ON_SELF)', () => {
    const ownHook: AbilityImpl = { id: 'ABILITY_TEST_OWNSTAT', src: 'test', onStat: (ctx) => (ctx.stat += 10) }
    registerAbilities([ownHook])
    const modify = computeOnStatModifier(slots('ABILITY_TEST_OWNSTAT'), slots(null), { battlerId: 'x', moveId: 'MOVE_TACKLE', statId: 'atk', weather: 'NONE', terrain: null, hp: 100, maxHp: 100, hasAnyStatus: false, status1: new Set(), isHighestAttackingStat: false, isHighestStat: false, abilityOn: false, boostedStat: null, alliesFainted: 0, isMegaEvolved: false, isGrounded: true })
    expect(modify(100)).toBe(110)
  })

  it('the OTHER battler\'s onStat hook needs an explicit non-self scope to affect this stat', () => {
    // IsApplyOnFlagAppropriate's default (unset onStatFor = APPLY_ON_SELF) only
    // fires when the ability holder IS the stat owner -- an opponent's ability
    // affecting your stat (e.g. an aura effect) must opt in explicitly.
    const unscoped: AbilityImpl = { id: 'ABILITY_TEST_OTHERSTAT_UNSCOPED', src: 'test', onStat: (ctx) => (ctx.stat *= 2) }
    registerAbilities([unscoped])
    const unscopedModify = computeOnStatModifier(slots(null), slots('ABILITY_TEST_OTHERSTAT_UNSCOPED'), { battlerId: 'x', moveId: 'MOVE_TACKLE', statId: 'atk', weather: 'NONE', terrain: null, hp: 100, maxHp: 100, hasAnyStatus: false, status1: new Set(), isHighestAttackingStat: false, isHighestStat: false, abilityOn: false, boostedStat: null, alliesFainted: 0, isMegaEvolved: false, isGrounded: true })
    expect(unscopedModify(100)).toBe(100) // no-op: the other battler's ability never applied

    _resetRegistryForTests()
    const scoped: AbilityImpl = { id: 'ABILITY_TEST_OTHERSTAT_SCOPED', src: 'test', applyOn: { onStatFor: APPLY_ON_ANY }, onStat: (ctx) => (ctx.stat *= 2) }
    registerAbilities([scoped])
    const scopedModify = computeOnStatModifier(slots(null), slots('ABILITY_TEST_OTHERSTAT_SCOPED'), { battlerId: 'x', moveId: 'MOVE_TACKLE', statId: 'atk', weather: 'NONE', terrain: null, hp: 100, maxHp: 100, hasAnyStatus: false, status1: new Set(), isHighestAttackingStat: false, isHighestStat: false, abilityOn: false, boostedStat: null, alliesFainted: 0, isMegaEvolved: false, isGrounded: true })
    expect(scopedModify(100)).toBe(200)
  })
})

describe('computeTypeEffectivenessWithAbilities', () => {
  const chart = {
    NORMAL: { GHOST: 0, NORMAL: 1 },
    FIRE: { GRASS: 2, WATER: 0.5 },
  }

  it('folds multiple defending types the same way as the plain chart lookup, with no abilities', () => {
    const result = computeTypeEffectivenessWithAbilities(slots(null), 'FIRE', ['GRASS'], chart, 'attacker', 'defender', 'MOVE_TACKLE', false)
    expect(result.modifier).toBe(uq(2.0))
    expect(result.perTypeModifiers).toEqual([uq(2.0), 0, 0])
  })

  it("the attacker's own onTypeEffectiveness ability overrides an immune component (Scrappy-style)", () => {
    const scrappyLike: AbilityImpl = {
      id: 'ABILITY_TEST_SCRAPPY',
      src: 'test',
      onTypeEffectiveness: (ctx) => {
        if (ctx.moveType === 'NORMAL' && ctx.defType === 'GHOST' && ctx.modifier === 0) ctx.modifier = uq(1.0)
      },
    }
    registerAbilities([scrappyLike])
    const result = computeTypeEffectivenessWithAbilities(slots('ABILITY_TEST_SCRAPPY'), 'NORMAL', ['GHOST'], chart, 'attacker', 'defender', 'MOVE_TACKLE', false)
    expect(result.modifier).toBe(uq(1.0))
  })

  it("Ring Target only applies when no ability already changed the component", () => {
    const withRingTarget = computeTypeEffectivenessWithAbilities(slots(null), 'NORMAL', ['GHOST'], chart, 'attacker', 'defender', 'MOVE_TACKLE', true)
    expect(withRingTarget.modifier).toBe(uq(1.0))

    const scrappyToHalf: AbilityImpl = {
      id: 'ABILITY_TEST_SCRAPPY_HALF',
      src: 'test',
      onTypeEffectiveness: (ctx) => {
        if (ctx.modifier === 0) ctx.modifier = uq(0.5)
      },
    }
    registerAbilities([scrappyToHalf])
    // The ability already changed it (to 0.5, not the Ring Target default of 1.0) --
    // Ring Target must NOT also apply on top.
    const withBoth = computeTypeEffectivenessWithAbilities(slots('ABILITY_TEST_SCRAPPY_HALF'), 'NORMAL', ['GHOST'], chart, 'attacker', 'defender', 'MOVE_TACKLE', true)
    expect(withBoth.modifier).toBe(uq(0.5))
  })

  it('defenderForcedGrounded restores ONLY the Ground-vs-Flying component (battle_util.c:7902), leaving other components alone', () => {
    const groundVsSteelFlying = { GROUND: { STEEL: 2, FLYING: 0 } }
    const withoutGrounding = computeTypeEffectivenessWithAbilities(slots(null), 'GROUND', ['STEEL', 'FLYING'], groundVsSteelFlying, 'attacker', 'defender', 'MOVE_EARTHQUAKE', false, false)
    expect(withoutGrounding.modifier).toBe(0) // flat immunity via the Flying component

    const withForcedGrounding = computeTypeEffectivenessWithAbilities(
      slots(null),
      'GROUND',
      ['STEEL', 'FLYING'],
      groundVsSteelFlying,
      'attacker',
      'defender',
      'MOVE_EARTHQUAKE',
      false,
      true,
    )
    // Flying's 0 restored to neutral (1.0), Steel's real 2x survives -- 2x
    // super effective overall, NOT flattened to neutral.
    expect(withForcedGrounding.modifier).toBe(uq(2.0))
  })

  it('defenderForcedGrounded does nothing for a non-Ground move or a non-Flying component', () => {
    const chart2 = { FIRE: { FLYING: 2 }, GROUND: { NORMAL: 1 } }
    const fireVsFlying = computeTypeEffectivenessWithAbilities(slots(null), 'FIRE', ['FLYING'], chart2, 'attacker', 'defender', 'MOVE_FLAMETHROWER', false, true)
    expect(fireVsFlying.modifier).toBe(uq(2.0)) // untouched -- not a Ground move

    const groundVsNormal = computeTypeEffectivenessWithAbilities(slots(null), 'GROUND', ['NORMAL'], chart2, 'attacker', 'defender', 'MOVE_EARTHQUAKE', false, true)
    expect(groundVsNormal.modifier).toBe(uq(1.0)) // untouched -- not a Flying component, and not 0 anyway
  })

  it('superEffectiveVsType unconditionally overrides a component to exactly 2.0x, even overriding a real resistance (Freeze-Dry-style, battle_util.c:7904)', () => {
    const iceChart = { ICE: { WATER: 0.5, GRASS: 1 } }
    const vsWater = computeTypeEffectivenessWithAbilities(slots(null), 'ICE', ['WATER'], iceChart, 'attacker', 'defender', 'MOVE_FREEZE_DRY', false, false, 'WATER')
    expect(vsWater.modifier).toBe(uq(2.0)) // NOT the real 0.5x resistance

    const vsGrass = computeTypeEffectivenessWithAbilities(slots(null), 'ICE', ['GRASS'], iceChart, 'attacker', 'defender', 'MOVE_FREEZE_DRY', false, false, 'WATER')
    expect(vsGrass.modifier).toBe(uq(1.0)) // untouched -- Grass isn't the declared superEffectiveVs type
  })

  it('ignoreTypeImmunity restores a flatly-immune component to neutral, but leaves a non-zero component alone (Dragon Rage-style, battle_util.c:7904)', () => {
    const dragonChart = { DRAGON: { FAIRY: 0, STEEL: 0.5 } }
    const vsFairy = computeTypeEffectivenessWithAbilities(slots(null), 'DRAGON', ['FAIRY'], dragonChart, 'attacker', 'defender', 'MOVE_DRAGON_RAGE', false, false, null, true)
    expect(vsFairy.modifier).toBe(uq(1.0)) // restored from 0 to neutral, not super effective

    const vsSteel = computeTypeEffectivenessWithAbilities(slots(null), 'DRAGON', ['STEEL'], dragonChart, 'attacker', 'defender', 'MOVE_DRAGON_RAGE', false, false, null, true)
    expect(vsSteel.modifier).toBe(uq(0.5)) // untouched -- not flatly 0, ignoreTypeImmunity doesn't apply
  })
})

describe('computeAfterTypeEffectiveness', () => {
  function afterCtx(overrides: Partial<Parameters<typeof computeAfterTypeEffectiveness>[3]> = {}): Parameters<typeof computeAfterTypeEffectiveness>[3] {
    return {
      attackerId: 'attacker',
      defenderId: 'defender',
      moveId: 'MOVE_TACKLE',
      moveType: 'NORMAL',
      moveFlags: {},
      modifier: uq(2.0),
      perTypeModifiers: [uq(2.0), 0, 0],
      defenderTypes: ['NORMAL'],
      weather: 'NONE',
      targetGrounded: true,
      defenderAtMaxHp: true,
      attackerAtMaxHp: true,
      defenderAbilityOn: false,
      ...overrides,
    }
  }

  it("a defender's onAfterTypeEffectiveness ability needs an explicit APPLY_ON_TARGET scope to fire (Wonder-Guard-style)", () => {
    const wonderGuardLike: AbilityImpl = {
      id: 'ABILITY_TEST_WONDER_GUARD',
      src: 'test',
      flags: { breakable: true },
      applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
      onAfterTypeEffectiveness: (ctx) => {
        if (ctx.modifier < uq(2.0)) ctx.modifier = 0
      },
    }
    registerAbilities([wonderGuardLike])
    const result = computeAfterTypeEffectiveness(slots(null), slots('ABILITY_TEST_WONDER_GUARD'), false, afterCtx({ modifier: uq(1.0) }))
    expect(result).toBe(0)
  })

  it("an unscoped onAfterTypeEffectiveness ability only ever fires for the ATTACKER (Bone-Zone-style), never the defender", () => {
    const boneZoneLike: AbilityImpl = {
      id: 'ABILITY_TEST_BONE_ZONE',
      src: 'test',
      onAfterTypeEffectiveness: (ctx) => {
        if (ctx.modifier === 0) ctx.modifier = uq(1.0)
      },
    }
    registerAbilities([boneZoneLike])
    const onAttacker = computeAfterTypeEffectiveness(slots('ABILITY_TEST_BONE_ZONE'), slots(null), false, afterCtx({ modifier: 0 }))
    expect(onAttacker).toBe(uq(1.0))

    _resetRegistryForTests()
    registerAbilities([boneZoneLike])
    const onDefender = computeAfterTypeEffectiveness(slots(null), slots('ABILITY_TEST_BONE_ZONE'), false, afterCtx({ modifier: 0 }))
    expect(onDefender).toBe(0) // never applied -- unscoped means attacker-only
  })

  it("Mold Breaker suppresses a breakable defender ability, but never the attacker's own", () => {
    const breakableDefense: AbilityImpl = {
      id: 'ABILITY_TEST_BREAKABLE_DEFENSE',
      src: 'test',
      flags: { breakable: true },
      applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
      onAfterTypeEffectiveness: (ctx) => {
        ctx.modifier = 0
      },
    }
    registerAbilities([breakableDefense])
    const suppressed = computeAfterTypeEffectiveness(slots(null), slots('ABILITY_TEST_BREAKABLE_DEFENSE'), true, afterCtx({ modifier: uq(1.0) }))
    expect(suppressed).toBe(uq(1.0)) // Mold Breaker bypassed it
    const notSuppressed = computeAfterTypeEffectiveness(slots(null), slots('ABILITY_TEST_BREAKABLE_DEFENSE'), false, afterCtx({ modifier: uq(1.0) }))
    expect(notSuppressed).toBe(0)
  })
})
