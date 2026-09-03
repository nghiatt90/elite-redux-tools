import { describe, expect, it } from 'vitest'
import { OFFENSIVE_MULTIPLIER_BATCH_D } from './11-offensive-multiplier-d'
import type { AbilityImpl, OffensiveMultiplierContext, DefensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = OFFENSIVE_MULTIPLIER_BATCH_D.find((a) => a.id === id)
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
    ...overrides,
  }
}

function runOff(id: string, overrides: Partial<OffensiveMultiplierContext> = {}): number {
  const c = offCtx(overrides)
  findAbility(id).onOffensiveMultiplier!(c)
  return c.modifier
}

function runDef(id: string, overrides: Partial<DefensiveMultiplierContext> = {}): number {
  const c = defCtx(overrides)
  findAbility(id).onDefensiveMultiplier!(c)
  return c.modifier
}

describe('offensive multiplier batch D', () => {
  it('unconditional multipliers', () => {
    expect(runOff('ABILITY_BLOOD_PRICE')).toBe(uq(1.3))
    expect(runOff('ABILITY_HUSTLE')).toBe(uq(1.4))
  })

  it('single/dual moveType checks', () => {
    expect(runOff('ABILITY_DEEP_FREEZE', { moveType: 'WATER' })).toBe(uq(1.25))
    expect(runOff('ABILITY_DEEP_FREEZE', { moveType: 'ICE' })).toBe(uq(1.25))
    expect(runOff('ABILITY_DEEP_FREEZE', { moveType: 'NORMAL' })).toBe(uq(1.0))
    expect(runOff('ABILITY_DOOM_BLAST', { moveType: 'DARK' })).toBe(uq(1.35))
    expect(runOff('ABILITY_DUAL_SHADOW', { moveType: 'ELECTRIC' })).toBe(uq(1.35))
    expect(runOff('ABILITY_DUAL_SHADOW', { moveType: 'DARK' })).toBe(uq(1.35))
    expect(runOff('ABILITY_DUNE_TERROR', { moveType: 'GROUND' })).toBe(uq(1.2))
    expect(runOff('ABILITY_ELECTRIC_BURST', { moveType: 'ELECTRIC' })).toBe(uq(1.35))
    expect(runOff('ABILITY_INFERNAL_RAGE', { moveType: 'FIRE' })).toBe(uq(1.35))
    expect(runOff('ABILITY_NOCTURNAL', { moveType: 'DARK' })).toBe(uq(1.25))
    expect(runOff('ABILITY_PLASMA_LAMP', { moveType: 'FIRE' })).toBe(uq(1.2))
    expect(runOff('ABILITY_PLASMA_LAMP', { moveType: 'ELECTRIC' })).toBe(uq(1.2))
  })

  it('Fossilized and Raw Wood: 1.2x offensive, 0.5x defensive, same type', () => {
    expect(runOff('ABILITY_FOSSILIZED', { moveType: 'ROCK' })).toBe(uq(1.2))
    expect(runDef('ABILITY_FOSSILIZED', { moveType: 'ROCK' })).toBe(uq(0.5))
    expect(runOff('ABILITY_RAW_WOOD', { moveType: 'GRASS' })).toBe(uq(1.2))
    expect(runDef('ABILITY_RAW_WOOD', { moveType: 'GRASS' })).toBe(uq(0.5))
  })

  it('Venoblaze Pincers keys off split, Soul Crusher off hammerBased', () => {
    expect(runOff('ABILITY_VENOBLAZE_PINCERS', { moveSplit: 'PHYSICAL' })).toBe(uq(1.2))
    expect(runOff('ABILITY_VENOBLAZE_PINCERS', { moveSplit: 'SPECIAL' })).toBe(uq(1.0))
    expect(runOff('ABILITY_SOUL_CRUSHER', { moveFlags: { hammerBased: true } })).toBe(uq(1.1))
  })

  it('Liquid Voice and Punk Rock key off the sound flag; Punk Rock also has a defensive half', () => {
    expect(runOff('ABILITY_LIQUID_VOICE', { moveFlags: { sound: true } })).toBe(uq(1.2))
    expect(runOff('ABILITY_PUNK_ROCK', { moveFlags: { sound: true } })).toBe(uq(1.3))
    expect(runDef('ABILITY_PUNK_ROCK', { moveFlags: { sound: true } })).toBe(uq(0.5))
    expect(runDef('ABILITY_PUNK_ROCK', { moveFlags: {} })).toBe(uq(1.0))
  })

  it('Rage Point keys off attackerHasAnyStatus', () => {
    expect(runOff('ABILITY_RAGE_POINT', { attackerHasAnyStatus: true })).toBe(uq(1.5))
    expect(runOff('ABILITY_RAGE_POINT', { attackerHasAnyStatus: false })).toBe(uq(1.0))
  })

  it('Arcane Force requires super-effective (>=2x)', () => {
    expect(runOff('ABILITY_ARCANE_FORCE', { typeEffectiveness: uq(2.0) })).toBe(uq(1.1))
    expect(runOff('ABILITY_ARCANE_FORCE', { typeEffectiveness: uq(1.0) })).toBe(uq(1.0))
  })

  it('Overrule doubles a crit that lands on a resisted (<1x) hit', () => {
    expect(runOff('ABILITY_OVERRULE', { isCrit: true, typeEffectiveness: uq(0.5) })).toBe(uq(2.0))
    expect(runOff('ABILITY_OVERRULE', { isCrit: false, typeEffectiveness: uq(0.5) })).toBe(uq(1.0))
    expect(runOff('ABILITY_OVERRULE', { isCrit: true, typeEffectiveness: uq(1.0) })).toBe(uq(1.0))
  })

  it('Echolocation and Foggy Eye require fog', () => {
    expect(runOff('ABILITY_ECHOLOCATION', { weather: 'FOG' })).toBe(uq(1.2))
    expect(runOff('ABILITY_ECHOLOCATION', { weather: 'NONE' })).toBe(uq(1.0))
    expect(runOff('ABILITY_FOGGY_EYE', { moveType: 'GHOST', weather: 'FOG' })).toBe(uq(1.5))
    expect(runOff('ABILITY_FOGGY_EYE', { moveType: 'GHOST', weather: 'NONE' })).toBe(uq(1.0))
  })

  it('Toxic Boost requires the attacker be poisoned AND the move be physical', () => {
    expect(runOff('ABILITY_TOXIC_BOOST', { attackerStatus1: new Set(['STATUS1_POISON']), moveSplit: 'PHYSICAL' })).toBe(uq(1.5))
    expect(runOff('ABILITY_TOXIC_BOOST', { attackerStatus1: new Set(['STATUS1_TOXIC_POISON']), moveSplit: 'PHYSICAL' })).toBe(uq(1.5))
    expect(runOff('ABILITY_TOXIC_BOOST', { attackerStatus1: new Set(['STATUS1_POISON']), moveSplit: 'SPECIAL' })).toBe(uq(1.0))
    expect(runOff('ABILITY_TOXIC_BOOST', { attackerStatus1: new Set(), moveSplit: 'PHYSICAL' })).toBe(uq(1.0))
  })

  it('the six target-type "hunter" abilities each key off one defender type', () => {
    expect(runOff('ABILITY_DRAGONSLAYER', { defenderTypes: ['DRAGON'] })).toBe(uq(1.5))
    expect(runOff('ABILITY_FAE_HUNTER', { defenderTypes: ['FAIRY'] })).toBe(uq(1.5))
    expect(runOff('ABILITY_FIREFIGHTER', { defenderTypes: ['FIRE'] })).toBe(uq(1.5))
    expect(runOff('ABILITY_LUMBERJACK', { defenderTypes: ['GRASS'] })).toBe(uq(1.5))
    expect(runOff('ABILITY_MARINE_APEX', { defenderTypes: ['WATER'] })).toBe(uq(1.5))
    expect(runOff('ABILITY_MONSTER_HUNTER', { defenderTypes: ['DARK'] })).toBe(uq(1.5))
    expect(runOff('ABILITY_DRAGONSLAYER', { defenderTypes: ['NORMAL'] })).toBe(uq(1.0))
  })

  it('Seaweed: 2x offensive Grass-vs-Fire-defender, 0.5x defensive Fire-vs-Grass-holder', () => {
    expect(runOff('ABILITY_SEAWEED', { moveType: 'GRASS', defenderTypes: ['FIRE'] })).toBe(uq(2.0))
    expect(runOff('ABILITY_SEAWEED', { moveType: 'GRASS', defenderTypes: ['WATER'] })).toBe(uq(1.0))
    expect(runDef('ABILITY_SEAWEED', { moveType: 'FIRE', defenderTypes: ['GRASS'] })).toBe(uq(0.5))
  })

  it('Flourish and Mana Coat key off terrain', () => {
    expect(runOff('ABILITY_FLOURISH', { moveType: 'GRASS', terrain: 'TERRAIN_GRASSY' })).toBe(uq(1.5))
    expect(runOff('ABILITY_FLOURISH', { moveType: 'GRASS', terrain: null })).toBe(uq(1.0))
    expect(runOff('ABILITY_MANA_COAT', { moveSplit: 'PHYSICAL', terrain: 'TERRAIN_PSYCHIC' })).toBe(uq(1.3))
    expect(runOff('ABILITY_MANA_COAT', { moveSplit: 'SPECIAL', terrain: 'TERRAIN_PSYCHIC' })).toBe(uq(1.0))
  })

  it('Rhythmic adds a flat 10 raw UQ units per same-move streak turn (bypasses MUL)', () => {
    expect(runOff('ABILITY_RHYTHMIC', { sameMoveTurnsInARow: 0 })).toBe(uq(1.0))
    expect(runOff('ABILITY_RHYTHMIC', { sameMoveTurnsInARow: 5 })).toBe(1074) // 1024 + 50
  })

  it('Plus is a documented permanent no-op in this v1 singles engine', () => {
    expect(runOff('ABILITY_PLUS')).toBe(uq(1.0))
  })

  it('every entry cites a src line', () => {
    for (const ability of OFFENSIVE_MULTIPLIER_BATCH_D) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
