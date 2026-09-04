import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, lookupAbility, _resetRegistryForTests } from '../registry'
import { OFFENSIVE_MULTIPLIER_BATCH_A } from './01-offensive-multiplier-a'
import { OFFENSIVE_MULTIPLIER_BATCH_B } from './03-offensive-multiplier-b'
import { OFFENSIVE_MULTIPLIER_BATCH_C } from './06-offensive-multiplier-c'
import { OFFENSIVE_MULTIPLIER_BATCH_D } from './11-offensive-multiplier-d'
import { SWARM_FAMILY } from './08-swarm-family'
import { HUB_ABILITIES } from './09-hub-abilities'
import { ALIAS_ABILITIES } from './10-aliases'
import { ATE_FAMILY_AND_ONSTAB } from './15-ate-family-and-onstab'
import { OFFENSIVE_MULTIPLIER_BATCH_E } from './18-offensive-multiplier-e'
import type { AbilityImpl, OffensiveMultiplierContext, OnMoveTypeContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = lookupAbility(id)
  if (!entry || 'unmodelled' in entry) throw new Error(`${id} not a real port`)
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
    ...overrides,
  }
}

describe('offensive multiplier batch E', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_A)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_B)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_C)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_D)
    registerAbilities(SWARM_FAMILY)
    registerAbilities(HUB_ABILITIES)
    registerAbilities(ALIAS_ABILITIES)
    registerAbilities(ATE_FAMILY_AND_ONSTAB)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_E)
  })

  it('Banshee/Power Metal/Sand Song/Snow Song convert a sound Normal move without setting ateBoost', () => {
    for (const [id, type] of [
      ['ABILITY_BANSHEE', 'GHOST'],
      ['ABILITY_POWER_METAL', 'STEEL'],
      ['ABILITY_SAND_SONG', 'GROUND'],
      ['ABILITY_SNOW_SONG', 'ICE'],
    ] as const) {
      const ctx: OnMoveTypeContext = { battlerId: 'x', moveId: 'MOVE_HYPER_VOICE', moveType: 'NORMAL', ateBoost: false, moveFlags: { sound: true } }
      findAbility(id).onMoveType!(ctx)
      expect(ctx.moveType).toBe(type)
      expect(ctx.ateBoost).toBe(false)

      const nonSound: OnMoveTypeContext = { battlerId: 'x', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', ateBoost: false, moveFlags: {} }
      findAbility(id).onMoveType!(nonSound)
      expect(nonSound.moveType).toBe('NORMAL')

      // Offensive half delegates to Liquid Voice (1.2x on sound moves)
      const off = offCtx({ moveFlags: { sound: true } })
      findAbility(id).onOffensiveMultiplier!(off)
      expect(off.modifier).toBe(uq(1.2))
    }
  })

  it('Magical Fists/Power Fists alias Iron Fist', () => {
    for (const id of ['ABILITY_MAGICAL_FISTS', 'ABILITY_POWER_FISTS']) {
      const c = offCtx({ moveFlags: { punchBased: true } })
      findAbility(id).onOffensiveMultiplier!(c)
      expect(c.modifier).toBe(uq(1.3))
    }
  })

  it('Mind Crush aliases Strong Jaw, Gnashing Cannon composes Mega Launcher + Mind Crush', () => {
    const mc = offCtx({ moveFlags: { biteBased: true } })
    findAbility('ABILITY_MIND_CRUSH').onOffensiveMultiplier!(mc)
    expect(mc.modifier).toBe(uq(1.3))

    const gc = offCtx({ moveFlags: { bulletBased: true } })
    findAbility('ABILITY_GNASHING_CANNON').onOffensiveMultiplier!(gc)
    expect(gc.modifier).toBe(uq(1.3))
  })

  it('Calculative composes Analytic + Neuroforce', () => {
    const c = offCtx({ attackerActsFirst: false, typeEffectiveness: uq(2.0) })
    findAbility('ABILITY_CALCULATIVE').onOffensiveMultiplier!(c)
    const expected = Math.floor((Math.floor((1024 * uq(1.3) + 512) / 1024) * uq(1.35) + 512) / 1024)
    expect(c.modifier).toBe(expected)
  })

  it("Reaper's Embrace composes Foul Energy + Tough Claws", () => {
    const c = offCtx({ moveType: 'DARK', attackerHp: 33, attackerMaxHp: 100, moveFlags: { contact: true } })
    findAbility('ABILITY_REAPERS_EMBARCE').onOffensiveMultiplier!(c)
    const expected = Math.floor((Math.floor((1024 * uq(1.5) + 512) / 1024) * uq(1.3) + 512) / 1024)
    expect(c.modifier).toBe(expected)
  })

  it('Aerialist composes Levitate + Flock', () => {
    const c = offCtx({ moveType: 'FLYING', attackerHp: 33, attackerMaxHp: 100 })
    findAbility('ABILITY_AERIALIST').onOffensiveMultiplier!(c)
    const expected = Math.floor((Math.floor((1024 * uq(1.25) + 512) / 1024) * uq(1.5) + 512) / 1024)
    expect(c.modifier).toBe(expected)
    expect(findAbility('ABILITY_AERIALIST').flags?.levitate).toBe(true)
  })

  it("Super Sniper delegates Sniper's crit boost", () => {
    const c = offCtx({ isCrit: true })
    findAbility('ABILITY_SUPER_SNIPER').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.5))
  })

  it('every entry cites a src line', () => {
    for (const ability of OFFENSIVE_MULTIPLIER_BATCH_E) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
