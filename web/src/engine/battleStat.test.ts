import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  attackItemModifier,
  attackPreModify,
  benefitsFromStatBuffs,
  calcAttackStatModifiers,
  calcDefenseStatModifiers,
  calculateBattleStat,
  DEFAULT_STAT_STAGE,
  defaultDefendingStat,
  defenseItemModifier,
  defensePreModify,
  noPositiveStatStages,
  spAttackPreModify,
  spDefensePreModify,
  type CalcStatInputs,
} from './battleStat'
import type { BattleConstants } from './types'

const NATURES_PATH = fileURLToPath(new URL('../../../data/v2.65beta/natures.json', import.meta.url))
const constants: BattleConstants = JSON.parse(readFileSync(NATURES_PATH, 'utf-8'))
const { statStageRatios } = constants

function baseInputs(overrides: Partial<CalcStatInputs> = {}): CalcStatInputs {
  return {
    rawStat: 300,
    extraStatLevel: 0,
    statStage: DEFAULT_STAT_STAGE,
    isUnaware: false,
    isWonderRoomActive: false,
    isOffensiveStatForWonderRoom: false,
    isCrit: false,
    isAttackRole: true,
    benefitsFromStatBuffs: true,
    preModify: (s) => s,
    applyOnStatHooks: (s) => s,
    secondaryStatPercent: 0,
    statStageRatios,
    ...overrides,
  }
}

describe('calculateBattleStat', () => {
  it('no stage change, no pre-mods: passes the raw stat straight through', () => {
    expect(calculateBattleStat(baseInputs())).toBe(300)
  })

  it('applies preModify before stat stages', () => {
    const halved = baseInputs({ preModify: (s) => Math.floor(s / 2) })
    expect(calculateBattleStat(halved)).toBe(150)
  })

  it('a +2 stat stage multiplies after pre-mods', () => {
    // index 8 ratio [20,10]: 150 * 20/10 = 300
    const boosted = baseInputs({ preModify: (s) => Math.floor(s / 2), statStage: 8 })
    expect(calculateBattleStat(boosted)).toBe(300)
  })

  it('isUnaware forces the default stage regardless of the real one', () => {
    const maxBoost = baseInputs({ statStage: 12, isUnaware: true })
    expect(calculateBattleStat(maxBoost)).toBe(300) // no change from raw
  })

  it('a crit lets the ATTACKER ignore their own negative stages (max with default)', () => {
    const loweredAtk = baseInputs({ statStage: 0, isCrit: true, isAttackRole: true }) // -6 stage
    expect(calculateBattleStat(loweredAtk)).toBe(300) // clamped up to stage 6, no change
  })

  it('a crit lets the ATTACKER keep their own positive stages (max, not reset)', () => {
    const boostedAtk = baseInputs({ statStage: 12, isCrit: true, isAttackRole: true }) // +6 stage
    expect(calculateBattleStat(boostedAtk)).toBe(1200) // max(12, 6) = 12, unaffected
  })

  it('a crit makes the DEFENDER ignore their own positive stages (min with default)', () => {
    const boostedDef = baseInputs({ statStage: 12, isCrit: true, isAttackRole: false })
    expect(calculateBattleStat(boostedDef)).toBe(300) // clamped down to stage 6
  })

  it('!benefitsFromStatBuffs clamps positive stages down regardless of crit', () => {
    const cappedAtZero = baseInputs({ statStage: 12, benefitsFromStatBuffs: false })
    expect(calculateBattleStat(cappedAtZero)).toBe(300)
  })

  it('extra stat levels apply after the stage ratio', () => {
    // +1 extra level: 300 + floor(300/5)*1 = 360
    expect(calculateBattleStat(baseInputs({ extraStatLevel: 1 }))).toBe(360)
  })

  it('ability onStat hooks run before stat stages, not after', () => {
    const doubled = baseInputs({ applyOnStatHooks: (s) => s * 2, statStage: 0 }) // -6 stage, ratio [10,40]
    // (300*2) * 10/40 = 150
    expect(calculateBattleStat(doubled)).toBe(150)
  })
})

describe('attack/sp.attack/defense/sp.defense pre-modifiers', () => {
  it('burn halves Attack', () => {
    expect(attackPreModify({ violentRush: false, showdownMode: false, readiedAction: false, isBurned: true })(101)).toBe(50)
  })

  it('violent rush and showdown mode both apply as x6/5, stacking', () => {
    const preMod = attackPreModify({ violentRush: true, showdownMode: true, readiedAction: false, isBurned: false })
    expect(preMod(100)).toBe(idivRef(idivRef(100 * 6, 5) * 6, 5))
  })

  it('frostbite halves Sp.Atk', () => {
    expect(spAttackPreModify({ rapidResponse: false, isFrostbitten: true })(101)).toBe(50)
  })

  it('Ice-type Def is boosted 1.5x in hail', () => {
    expect(defensePreModify({ isIceTypeInHail: true })(100)).toBe(150)
    expect(defensePreModify({ isIceTypeInHail: false })(100)).toBe(100)
  })

  it('Rock-type SpDef is boosted 1.5x in sandstorm', () => {
    expect(spDefensePreModify({ isRockTypeInSandstorm: true })(100)).toBe(150)
  })
})

function idivRef(a: number, b: number): number {
  return Math.floor(a / b)
}

describe('benefitsFromStatBuffs', () => {
  it('bleeding disables stat buffs entirely', () => {
    expect(benefitsFromStatBuffs(true, false, false, false)).toBe(false)
  })

  it('Blood Stain disables stat buffs entirely', () => {
    expect(benefitsFromStatBuffs(false, true, false, false)).toBe(false)
  })

  it('poisoned + opposing Hemolysis disables stat buffs', () => {
    expect(benefitsFromStatBuffs(false, false, true, true)).toBe(false)
    expect(benefitsFromStatBuffs(false, false, true, false)).toBe(true) // poisoned alone is fine
  })

  it('otherwise benefits normally', () => {
    expect(benefitsFromStatBuffs(false, false, false, false)).toBe(true)
  })
})

describe('attackItemModifier', () => {
  it('Choice Band boosts physical only', () => {
    const ctx = { resolvedHoldEffect: 'HOLD_EFFECT_CHOICE_BAND', baseSpeciesId: 'SPECIES_GARCHOMP', isPhysical: true, isSpecial: false }
    expect(attackItemModifier(ctx)).toBe(1536) // uq(1.5)
    expect(attackItemModifier({ ...ctx, isPhysical: false, isSpecial: true })).toBe(1024)
  })

  it('Light Ball gives Pikachu 2x, Raichu only 1.5x', () => {
    const pikachu = { resolvedHoldEffect: 'HOLD_EFFECT_LIGHT_BALL', baseSpeciesId: 'SPECIES_PIKACHU', isPhysical: true, isSpecial: false }
    expect(attackItemModifier(pikachu)).toBe(2048)
    expect(attackItemModifier({ ...pikachu, baseSpeciesId: 'SPECIES_RAICHU' })).toBe(1536)
    expect(attackItemModifier({ ...pikachu, baseSpeciesId: 'SPECIES_PIKACHU_LIBRE' })).toBe(1638) // uq(1.6)
  })

  it('Thick Club only boosts Cubone/Marowak physical moves', () => {
    const ctx = { resolvedHoldEffect: 'HOLD_EFFECT_THICK_CLUB', baseSpeciesId: 'SPECIES_MAROWAK', isPhysical: true, isSpecial: false }
    expect(attackItemModifier(ctx)).toBe(2048)
    expect(attackItemModifier({ ...ctx, baseSpeciesId: 'SPECIES_GARCHOMP' })).toBe(1024)
  })
})

describe('defenseItemModifier', () => {
  it('Eviolite requires CanEvolveStrict and excludes Necrozma', () => {
    const ctx = {
      resolvedHoldEffect: 'HOLD_EFFECT_EVIOLITE',
      speciesId: 'SPECIES_CHANSEY',
      baseSpeciesId: 'SPECIES_CHANSEY',
      isTransformed: false,
      canEvolveStrict: true,
      defStatToUse: 'def' as const,
    }
    expect(defenseItemModifier(ctx)).toBe(1536)
    expect(defenseItemModifier({ ...ctx, speciesId: 'SPECIES_NECROZMA', canEvolveStrict: true })).toBe(1024)
    expect(defenseItemModifier({ ...ctx, canEvolveStrict: false })).toBe(1024)
  })

  it('Assault Vest only boosts SpDef', () => {
    const ctx = {
      resolvedHoldEffect: 'HOLD_EFFECT_ASSAULT_VEST',
      speciesId: 'SPECIES_GARCHOMP',
      baseSpeciesId: 'SPECIES_GARCHOMP',
      isTransformed: false,
      canEvolveStrict: false,
      defStatToUse: 'spdef' as const,
    }
    expect(defenseItemModifier(ctx)).toBe(1536)
    expect(defenseItemModifier({ ...ctx, defStatToUse: 'def' })).toBe(1024)
  })

  it('Soul Dew keys off the BASE species, so Mega Latios still qualifies', () => {
    const ctx = {
      resolvedHoldEffect: 'HOLD_EFFECT_SOUL_DEW',
      speciesId: 'SPECIES_LATIOS_MEGA',
      baseSpeciesId: 'SPECIES_LATIOS',
      isTransformed: false,
      canEvolveStrict: false,
      defStatToUse: 'spdef' as const,
    }
    expect(defenseItemModifier(ctx)).toBe(1536)
  })

  it('calcDefenseStatModifiers applies the modifier via ApplyModifier', () => {
    const ctx = {
      resolvedHoldEffect: 'HOLD_EFFECT_ASSAULT_VEST',
      speciesId: 'SPECIES_GARCHOMP',
      baseSpeciesId: 'SPECIES_GARCHOMP',
      isTransformed: false,
      canEvolveStrict: false,
      defStatToUse: 'spdef' as const,
    }
    expect(calcDefenseStatModifiers(100, ctx)).toBe(150)
  })
})

describe('calcAttackStatModifiers', () => {
  it('stacks fog-vs-ghost, infatuation, and item multiplicatively', () => {
    const noItem = { resolvedHoldEffect: null, baseSpeciesId: 'SPECIES_GARCHOMP', isPhysical: true, isSpecial: false }
    expect(calcAttackStatModifiers({ attackStat: 100, isGhostDefenderInFog: false, isInfatuatedWithDefender: false, item: noItem })).toBe(100)
    expect(calcAttackStatModifiers({ attackStat: 100, isGhostDefenderInFog: true, isInfatuatedWithDefender: false, item: noItem })).toBe(80)
    expect(calcAttackStatModifiers({ attackStat: 100, isGhostDefenderInFog: false, isInfatuatedWithDefender: true, item: noItem })).toBe(50)
  })
})

describe('noPositiveStatStages', () => {
  it('true on crit, on a stat-stages-ignored move, or when wrapped by Grip Pincer/World Serpent', () => {
    expect(noPositiveStatStages(true, false, false)).toBe(true)
    expect(noPositiveStatStages(false, true, false)).toBe(true)
    expect(noPositiveStatStages(false, false, true)).toBe(true)
    expect(noPositiveStatStages(false, false, false)).toBe(false)
  })
})

describe('defaultDefendingStat', () => {
  it('HITS_SPDEF and HITS_DEF override the move split', () => {
    expect(defaultDefendingStat('HITS_SPDEF', true)).toBe('spdef')
    expect(defaultDefendingStat('HITS_DEF', false)).toBe('def')
  })

  it('otherwise physical hits Def, special hits SpDef', () => {
    expect(defaultDefendingStat(undefined, true)).toBe('def')
    expect(defaultDefendingStat(undefined, false)).toBe('spdef')
  })
})
