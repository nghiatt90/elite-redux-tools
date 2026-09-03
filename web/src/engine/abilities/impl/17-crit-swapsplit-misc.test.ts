import { beforeEach, describe, expect, it } from 'vitest'
import { registerAbilities, lookupAbility, _resetRegistryForTests } from '../registry'
import { OFFENSIVE_MULTIPLIER_BATCH_A } from './01-offensive-multiplier-a'
import { OFFENSIVE_MULTIPLIER_BATCH_B } from './03-offensive-multiplier-b'
import { OFFENSIVE_MULTIPLIER_BATCH_C } from './06-offensive-multiplier-c'
import { OFFENSIVE_MULTIPLIER_BATCH_D } from './11-offensive-multiplier-d'
import { HUB_ABILITIES } from './09-hub-abilities'
import { ATE_FAMILY_AND_ONSTAB } from './15-ate-family-and-onstab'
import { CRIT_SWAPSPLIT_MISC } from './17-crit-swapsplit-misc'
import { isTargettedApplyOnFlagAppropriate } from '../applyOn'
import { NEVER_CRIT } from '../../crit'
import type { AbilityImpl, OnCritContext, OnSwapSplitContext, OffensiveMultiplierContext, DefensiveMultiplierContext } from '../types'
import { uq } from '../../fixed'

function findAbility(id: string): AbilityImpl {
  const entry = lookupAbility(id)
  if (!entry || 'unmodelled' in entry) throw new Error(`${id} not a real port`)
  return entry
}

function critCtx(overrides: Partial<OnCritContext> = {}): OnCritContext {
  return {
    battlerId: 'x',
    defenderId: 'defender',
    moveId: 'MOVE_TACKLE',
    typeEffectiveness: uq(1.0),
    defenderStatus1: new Set(),
    defenderSpeedStageNegative: false,
    defenderResolvedHoldEffect: null,
    moveFlags: {},
    basePower: 40,
    attackerActsFirst: true,
    ...overrides,
  }
}

function swapCtx(overrides: Partial<OnSwapSplitContext> = {}): OnSwapSplitContext {
  return { battlerId: 'x', moveId: 'MOVE_TACKLE', moveType: 'NORMAL', moveSplit: 'PHYSICAL', moveFlags: {}, ...overrides }
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

describe('crit + swapSplit + misc batch O', () => {
  beforeEach(() => {
    _resetRegistryForTests()
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_A)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_B)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_C)
    registerAbilities(OFFENSIVE_MULTIPLIER_BATCH_D)
    registerAbilities(HUB_ABILITIES)
    registerAbilities(ATE_FAMILY_AND_ONSTAB)
    registerAbilities(CRIT_SWAPSPLIT_MISC)
  })

  it('Bad Luck/Stalwart force NEVER_CRIT with different apply-on scopes', () => {
    expect(findAbility('ABILITY_BAD_LUCK').onCrit!(critCtx())).toBe(NEVER_CRIT)
    expect(findAbility('ABILITY_STALWART').onCrit!(critCtx())).toBe(NEVER_CRIT)
    // Bad Luck fires when its own battler is the FOE of the context battler
    // (context battler for onCrit is always the attacker) -- verified via the
    // shared applyOn machinery rather than re-deriving the scope here.
    const badLuckScope = findAbility('ABILITY_BAD_LUCK').applyOn!.onCritFor!
    expect(isTargettedApplyOnFlagAppropriate(false, true, false, false, badLuckScope)).toBe(true) // holder is the target (foe of the attacker)
    expect(isTargettedApplyOnFlagAppropriate(true, false, true, false, badLuckScope)).toBe(false) // holder IS the attacker (isSelf true)
  })

  it('Hyper Cutter/Precise Fist key off move flags, Perfectionist off basePower', () => {
    expect(findAbility('ABILITY_HYPER_CUTTER').onCrit!(critCtx({ moveFlags: { contact: true } }))).toBe(1)
    expect(findAbility('ABILITY_HYPER_CUTTER').onCrit!(critCtx())).toBe(0)
    expect(findAbility('ABILITY_PRECISE_FIST').onCrit!(critCtx({ moveFlags: { punchBased: true } }))).toBe(1)
    expect(findAbility('ABILITY_PERFECTIONIST').onCrit!(critCtx({ basePower: 50 }))).toBe(1)
    expect(findAbility('ABILITY_PERFECTIONIST').onCrit!(critCtx({ basePower: 51 }))).toBe(0)
    expect(findAbility('ABILITY_PERFECTIONIST').onCrit!(critCtx({ basePower: 0 }))).toBe(0)
  })

  it('Strategic Pause: +2 crit stage when the attacker acts second, delegates Analytic offensively', () => {
    expect(findAbility('ABILITY_STRATEGIC_PAUSE').onCrit!(critCtx({ attackerActsFirst: false }))).toBe(2)
    expect(findAbility('ABILITY_STRATEGIC_PAUSE').onCrit!(critCtx({ attackerActsFirst: true }))).toBe(0)
    const c = offCtx({ attackerActsFirst: false })
    findAbility('ABILITY_STRATEGIC_PAUSE').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.3))
  })

  it('Mystic Blades/Energized Horns/Mythical Arrows swap split on a matching physical move', () => {
    expect(findAbility('ABILITY_MYSTIC_BLADES').onSwapSplit!(swapCtx({ moveFlags: { sliceBased: true } }))).toBe(true)
    expect(findAbility('ABILITY_MYSTIC_BLADES').onSwapSplit!(swapCtx({ moveSplit: 'SPECIAL', moveFlags: { sliceBased: true } }))).toBe(false)
    expect(findAbility('ABILITY_ENERGIZED_HORNS').onSwapSplit!(swapCtx({ moveFlags: { hornBased: true } }))).toBe(true)
    expect(findAbility('ABILITY_MYTHICAL_ARROWS').onSwapSplit!(swapCtx({ moveFlags: { arrowBased: true } }))).toBe(true)

    // Mystic Blades also delegates its offensive multiplier to Keen Edge (1.3x sliceBased)
    const c = offCtx({ moveFlags: { sliceBased: true } })
    findAbility('ABILITY_MYSTIC_BLADES').onOffensiveMultiplier!(c)
    expect(c.modifier).toBe(uq(1.3))
  })

  it('Best Offense and Pony Power alias Mystic Blades\' onSwapSplit', () => {
    expect(findAbility('ABILITY_BEST_OFFENSE').onSwapSplit!(swapCtx({ moveFlags: { sliceBased: true } }))).toBe(true)
    expect(findAbility('ABILITY_PONY_POWER').onSwapSplit!(swapCtx({ moveFlags: { sliceBased: true } }))).toBe(true)
    // Pony Power's offensive half double-applies Keen Edge's boost (Keen Edge
    // directly, then again via Mystic Blades) -- faithful to the literal C.
    const c = offCtx({ moveFlags: { sliceBased: true } })
    findAbility('ABILITY_PONY_POWER').onOffensiveMultiplier!(c)
    const expected = Math.floor((Math.floor((1024 * uq(1.3) + 512) / 1024) * uq(1.3) + 512) / 1024)
    expect(c.modifier).toBe(expected)
  })

  it('Bass Boosted composes Amplifier+Punk Rock offensively and delegates Punk Rock defensively', () => {
    const off = offCtx({ moveFlags: { sound: true } })
    findAbility('ABILITY_BASS_BOOSTED').onOffensiveMultiplier!(off)
    expect(off.modifier).toBe(uq(1.3)) // only Punk Rock's condition matches (sound); Amplifier needs Punk Rock ported too (still unmodelled) so it's a no-op
    const def = defCtx({ moveFlags: { sound: true } })
    findAbility('ABILITY_BASS_BOOSTED').onDefensiveMultiplier!(def)
    expect(def.modifier).toBe(uq(0.5))
  })

  it('every entry cites a src line', () => {
    for (const ability of CRIT_SWAPSPLIT_MISC) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
