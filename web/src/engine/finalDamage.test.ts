import { describe, expect, it } from 'vitest'
import { calcFinalDamage, defaultFinalDamageStages, type FinalDamageStages } from './finalDamage'
import { applyModifier, mulModifier, uq } from './fixed'

function stages(overrides: Partial<FinalDamageStages> = {}): FinalDamageStages {
  return { ...defaultFinalDamageStages({ typeEffectiveness: uq(1.0) }), ...overrides }
}

describe('calcFinalDamage -- neutral case', () => {
  it('an unmodified hit returns the base damage unchanged', () => {
    expect(calcFinalDamage(100, stages()).dmg).toBe(100)
  })

  it('damage never rounds down to 0', () => {
    expect(calcFinalDamage(0, stages({ typeEffectiveness: uq(0.25) })).dmg).toBe(1)
  })
})

describe('calcFinalDamage -- individual stages, value AND position', () => {
  it('#1 multi-target x0.75', () => {
    const result = calcFinalDamage(100, stages({ isMultiTarget: true }))
    expect(result.dmg).toBe(75)
    expect(result.trace[0]).toMatchObject({ stage: 'multiTarget', channel: 'finalModifier' })
  })

  it('#2 type effectiveness folds via finalModifier, not a direct dmg multiply', () => {
    const result = calcFinalDamage(100, stages({ typeEffectiveness: uq(2.0) }))
    expect(result.dmg).toBe(200)
    const entry = result.trace.find((t) => t.stage === 'typeEffectiveness')
    expect(entry?.channel).toBe('finalModifier')
  })

  it('#3 ability multiplier applies before crit', () => {
    const result = calcFinalDamage(100, stages({ abilityMultiplier: uq(1.5), critMultiplier: 1.5 }))
    const abilityIdx = result.trace.findIndex((t) => t.stage === 'abilityMultiplier')
    const critIdx = result.trace.findIndex((t) => t.stage === 'crit')
    expect(abilityIdx).toBeLessThan(critIdx)
  })

  it('#4 crit is a DIRECT dmg operation (its own rounding step), not finalModifier', () => {
    const result = calcFinalDamage(101, stages({ critMultiplier: 1.5 }))
    // applyModifier(uq(1.5), 101) = floor((1536*101+512)/1024) = floor(152.0) = 152
    expect(result.dmg).toBe(152)
    const entry = result.trace.find((t) => t.stage === 'crit')
    expect(entry?.channel).toBe('dmg')
  })

  it('MISC_EFFECT_INCREASED_CRIT_DAMAGE moves crit for x2.0 instead of x1.5', () => {
    expect(calcFinalDamage(100, stages({ critMultiplier: 2.0 })).dmg).toBe(200)
  })

  it('#7 weather is a DIRECT dmg operation, applied AFTER crit and BEFORE stab', () => {
    const result = calcFinalDamage(100, stages({ critMultiplier: 1.5, weatherMultiplier: 1.5, stabInHalves: 3 }))
    const critIdx = result.trace.findIndex((t) => t.stage === 'crit')
    const weatherIdx = result.trace.findIndex((t) => t.stage === 'weather')
    const stabIdx = result.trace.findIndex((t) => t.stage === 'stab')
    expect(critIdx).toBeLessThan(weatherIdx)
    expect(weatherIdx).toBeLessThan(stabIdx)
    const weatherEntry = result.trace.find((t) => t.stage === 'weather')
    expect(weatherEntry?.channel).toBe('dmg')
  })

  it('#8 STAB: 1.5x ordinary, 2.0x with Adaptability (stabInHalves=4)', () => {
    expect(calcFinalDamage(100, stages({ stabInHalves: 3 })).dmg).toBe(150)
    expect(calcFinalDamage(100, stages({ stabInHalves: 4 })).dmg).toBe(200)
    expect(calcFinalDamage(100, stages({ stabInHalves: 2 })).dmg).toBe(100) // no STAB
  })

  it('#9 screens: 0.5x singles, 0.66x doubles', () => {
    expect(calcFinalDamage(100, stages({ screensActive: true, isDoubleBattle: false })).dmg).toBe(50)
    // applyModifier-equivalent via mulModifier+applyModifier chain: uq(0.66)=675
    expect(calcFinalDamage(100, stages({ screensActive: true, isDoubleBattle: true })).dmg).toBe(applyModifier(mulModifier(uq(1.0), uq(0.66)), 100))
  })

  it('#12 attacker item: Life Orb x1.3, Expert Belt x1.2', () => {
    expect(calcFinalDamage(100, stages({ attackerItemMultiplier: uq(1.3) })).dmg).toBe(130)
    expect(calcFinalDamage(100, stages({ attackerItemMultiplier: uq(1.2) })).dmg).toBe(120)
  })

  it('#13 resist berry: 0.5x normally, 0.25x with Ripen', () => {
    expect(calcFinalDamage(100, stages({ resistBerryMultiplier: 0.5 })).dmg).toBe(50)
    expect(calcFinalDamage(100, stages({ resistBerryMultiplier: 0.25 })).dmg).toBe(25)
  })

  it('#14 Glaive Rush x2', () => {
    expect(calcFinalDamage(100, stages({ glaiveRushActive: true })).dmg).toBe(200)
  })

  it('#15 semi-invulnerable hits stack independently (each x2)', () => {
    expect(calcFinalDamage(100, stages({ hitsSemiInvulnerableUnderground: true })).dmg).toBe(200)
    expect(calcFinalDamage(100, stages({ hitsSemiInvulnerableUnderwater: true, hitsSemiInvulnerableInAir: true })).dmg).toBe(400)
  })

  it('#16 super-effective boost (4/3) only applies at >=2x effectiveness', () => {
    expect(calcFinalDamage(100, stages({ typeEffectiveness: uq(2.0), hasSuperEffectiveBoost: true })).dmg).toBe(
      applyModifier(mulModifier(uq(2.0), uq(4 / 3)), 100),
    )
    expect(calcFinalDamage(100, stages({ typeEffectiveness: uq(1.0), hasSuperEffectiveBoost: true })).dmg).toBe(100) // below 2x, no boost
  })

  it('#11 ally damage reducers stack multiplicatively (Friend Guard + Caretaker)', () => {
    const result = calcFinalDamage(100, stages({ allyDamageReducerCount: 2 }))
    expect(result.dmg).toBe(applyModifier(mulModifier(mulModifier(uq(1.0), uq(0.75)), uq(0.75)), 100))
  })
})

describe('calcFinalDamage -- full stage order matches src/battle_util.c:7517-7720', () => {
  it('every stage present in a maximal case appears in the documented order', () => {
    const result = calcFinalDamage(1000, {
      isMultiTarget: true,
      typeEffectiveness: uq(2.0),
      abilityMultiplier: uq(1.1),
      critMultiplier: 1.5,
      weatherMultiplier: 1.5,
      stabInHalves: 3,
      screensActive: true,
      isDoubleBattle: false,
      parentalBondMultiplier: uq(1.25),
      allyDamageReducerCount: 1,
      attackerItemMultiplier: uq(1.3),
      resistBerryMultiplier: 0.5,
      glaiveRushActive: true,
      hitsSemiInvulnerableUnderground: true,
      hitsSemiInvulnerableUnderwater: false,
      hitsSemiInvulnerableInAir: false,
      hasSuperEffectiveBoost: true,
    })
    const order = result.trace.map((t) => t.stage)
    expect(order).toEqual([
      'multiTarget',
      'typeEffectiveness',
      'abilityMultiplier',
      'crit',
      'weather',
      'stab',
      'screens',
      'parentalBond',
      'allyDamageReducer',
      'attackerItem',
      'resistBerry',
      'glaiveRush',
      'hitsUnderground',
      'superEffectiveBoost',
      'applyFinalModifier',
    ])
  })
})
