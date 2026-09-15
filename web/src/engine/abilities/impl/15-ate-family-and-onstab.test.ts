import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, lookupAbility, _resetRegistryForTests } from '../registry'
import { OFFENSIVE_MULTIPLIER_BATCH_A } from './01-offensive-multiplier-a'
import { OFFENSIVE_MULTIPLIER_BATCH_C } from './06-offensive-multiplier-c'
import { ATE_FAMILY_AND_ONSTAB } from './15-ate-family-and-onstab'
import type { AbilityImpl, OnMoveTypeContext, OnStabContext, OnTypeEffectivenessContext, OnAfterTypeEffectivenessContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = lookupAbility(id)
  if (!entry || 'unmodelled' in entry) throw new Error(`${id} not a real port`)
  return entry
}

describe('ate family + onStab batch', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_A)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_C)
    registerAbilities(ATE_FAMILY_AND_ONSTAB)
  })

  it('pure ATE abilities convert a Normal move and grant pseudo-STAB', () => {
    for (const [id, type] of [
      ['ABILITY_ATOMIC_BURST', 'ELECTRIC'],
      ['ABILITY_FIGHT_SPIRIT', 'FIGHTING'],
      ['ABILITY_MOB_BOSS', 'DARK'],
      ['ABILITY_AERILATE', 'FLYING'],
    ] as const) {
      const moveCtx: OnMoveTypeContext = { battlerId: 'x', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', ateBoost: false, moveFlags: {} }
      findAbility(id).onMoveType!(moveCtx)
      expect(moveCtx.moveType).toBe(type)
      expect(moveCtx.ateBoost).toBe(true)
      const stabCtx: OnStabContext = { battlerId: 'x', moveType: type }
      expect(findAbility(id).onStab!(stabCtx)).toBe(true)
    }
  })

  it('Butterfly Wings/Lead Claws/Unicorn/Warriors Spear delegate their offensive multiplier', () => {
    expect(findAbility('ABILITY_BUTTERFLY_WINGS').onOffensiveMultiplier).toBeDefined()
    const ctx = {
      modifier: uq(1.0),
      resistance: uq(1.0),
      battlerId: 'attacker',
      defenderId: 'defender',
      moveId: 'MOVE_TACKLE',
      moveType: 'NORMAL',
      moveSplit: 'PHYSICAL' as const,
      moveFlags: { contact: true as const },
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
      defenderStatus1: new Set<string>(),
      defenderHasBloodStainEffect: false,
      attackerIsUnaware: false,
      defenderHasAnyLoweredStat: false,
      attackerIsGrounded: true,
    }
    // Butterfly Wings -> Giant Wings: 1.3x on airBased moves
    findAbility('ABILITY_BUTTERFLY_WINGS').onOffensiveMultiplier!({ ...ctx, moveFlags: { airBased: true as const } })
    // Lead Claws -> Big Pecks: 1.3x on contact
    const leadClawsCtx = { ...ctx, modifier: uq(1.0) }
    findAbility('ABILITY_LEAD_CLAWS').onOffensiveMultiplier!(leadClawsCtx)
    expect(leadClawsCtx.modifier).toBe(uq(1.3))
    // Unicorn/Warriors Spear -> Mighty Horn: 1.3x on hornBased
    const unicornCtx = { ...ctx, modifier: uq(1.0), moveFlags: { hornBased: true as const } }
    findAbility('ABILITY_UNICORN').onOffensiveMultiplier!(unicornCtx)
    expect(unicornCtx.modifier).toBe(uq(1.3))
  })

  it('Draconize resolves a fully-blocked Dragon hit to neutral; Draconic Might aliases it', () => {
    const ctx1: OnTypeEffectivenessContext = { attackerId: 'a', defenderId: 'd', moveId: 'm', moveType: 'DRAGON', modifier: 0, defType: 'DRAGON' }
    findAbility('ABILITY_DRACONIZE').onTypeEffectiveness!(ctx1)
    expect(ctx1.modifier).toBe(uq(1.0))

    const ctx2: OnTypeEffectivenessContext = { attackerId: 'a', defenderId: 'd', moveId: 'm', moveType: 'DRAGON', modifier: 0, defType: 'DRAGON' }
    findAbility('ABILITY_DRACONIC_MIGHT').onTypeEffectiveness!(ctx2)
    expect(ctx2.modifier).toBe(uq(1.0))
    expect(findAbility('ABILITY_DRACONIC_MIGHT').addsType).toBe('DRAGON')
  })

  it('Steelworker halves Dark/Ghost damage vs a Steel-type defender; Stainless Steel aliases it', () => {
    const mk = (): OnAfterTypeEffectivenessContext => ({
      attackerId: 'a',
      defenderId: 'd',
      moveId: 'm',
      moveType: 'DARK',
      moveFlags: {},
      modifier: uq(1.0),
      perTypeModifiers: [uq(1.0), 0, 0],
      defenderTypes: ['STEEL'],
      weather: 'NONE',
      targetGrounded: true,
      defenderAtMaxHp: true,
      attackerAtMaxHp: true,
      defenderAbilityOn: false,
    })
    const c1 = mk()
    findAbility('ABILITY_STEELWORKER').onAfterTypeEffectiveness!(c1)
    expect(c1.modifier).toBe(uq(0.5))

    const c2 = mk()
    c2.defenderTypes = ['FAIRY']
    findAbility('ABILITY_STEELWORKER').onAfterTypeEffectiveness!(c2)
    expect(c2.modifier).toBe(uq(1.0))

    const c3 = mk()
    findAbility('ABILITY_STAINLESS_STEEL').onAfterTypeEffectiveness!(c3)
    expect(c3.modifier).toBe(uq(0.5))
    expect(findAbility('ABILITY_STAINLESS_STEEL').flags?.fortKnox).toBe(true)
  })

  it('plain onStab-only abilities', () => {
    const stab = (id: string, type: string) => findAbility(id).onStab!({ battlerId: 'x', moveType: type })
    expect(stab('ABILITY_ACIDIC_SLIME', 'WATER')).toBe(true)
    expect(stab('ABILITY_AMPHIBIOUS', 'WATER')).toBe(true)
    expect(stab('ABILITY_HAND_BARNACLES', 'WATER')).toBe(true)
    expect(stab('ABILITY_LUNAR_ECLIPSE', 'DARK')).toBe(true)
    expect(stab('ABILITY_LUNAR_ECLIPSE', 'FAIRY')).toBe(true)
    expect(stab('ABILITY_STORM_CLOUD', 'ELECTRIC')).toBe(true)
    expect(stab('ABILITY_TENDER_AFFECTION', 'FAIRY')).toBe(true)
    expect(stab('ABILITY_UNOWN_POWER', 'NORMAL')).toBe(true)
  })

  it('Unown Power forces Hidden Power/Secret Power up to super-effective', () => {
    const ctx: OnAfterTypeEffectivenessContext = { attackerId: 'a', defenderId: 'd', moveId: 'MOVE_HIDDEN_POWER', moveType: 'NORMAL', moveFlags: {}, modifier: uq(0.5), perTypeModifiers: [0, 0, 0], defenderTypes: [], weather: 'NONE', targetGrounded: true, defenderAtMaxHp: true, attackerAtMaxHp: true, defenderAbilityOn: false }
    findAbility('ABILITY_UNOWN_POWER').onAfterTypeEffectiveness!(ctx)
    expect(ctx.modifier).toBe(uq(2.0))
    const ctx2: OnAfterTypeEffectivenessContext = { attackerId: 'a', defenderId: 'd', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', moveFlags: {}, modifier: uq(0.5), perTypeModifiers: [0, 0, 0], defenderTypes: [], weather: 'NONE', targetGrounded: true, defenderAtMaxHp: true, attackerAtMaxHp: true, defenderAbilityOn: false }
    findAbility('ABILITY_UNOWN_POWER').onAfterTypeEffectiveness!(ctx2)
    expect(ctx2.modifier).toBe(uq(0.5))
  })

  it('every entry cites a src line', () => {
    for (const ability of ATE_FAMILY_AND_ONSTAB) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
