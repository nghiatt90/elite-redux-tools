import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyAngelsWrathBasePower,
  applyMoveBehaviorDamage,
  applyMoveSpecificBasePower,
  applyPreModifierBasePower,
  calcMoveBasePowerAfterModifiers,
  percentToModifier,
  weatherBallType,
  type BasePowerModifierContext,
  type MoveBehaviors,
} from './basePower'
import type { ConditionBattlerContext, DamageContext } from './types'
import { uq } from './fixed'

const BEHAVIORS_PATH = fileURLToPath(new URL('../../../data/v2.65beta/moveBehaviors.json', import.meta.url))
const behaviors: MoveBehaviors = JSON.parse(readFileSync(BEHAVIORS_PATH, 'utf-8')).behaviors

function battler(overrides: Partial<ConditionBattlerContext> = {}): ConditionBattlerContext {
  return {
    speciesId: 'SPECIES_PIKACHU',
    baseSpeciesId: 'SPECIES_PIKACHU',
    heads: 1,
    isMegaEvolved: false,
    itemId: null,
    resolvedHoldEffect: null,
    itemNegated: false,
    status1: new Set(),
    hasComatose: false,
    hasBloodStainEffect: false,
    isInfatuated: false,
    isConfused: false,
    isEnraged: false,
    wasDamagedThisTurnBy: 'none',
    recentlyFainted: false,
    hp: 100,
    maxHp: 100,
    weight: 60,
    speed: 100,
    positiveStatStageCount: 0,
    negativeStatStageCount: 0,
    usedMovePpRemaining: null,
    helpingHand: false,
    ghastlyEcho: false,
    chargedUp: false,
    meFirst: false,
    fear: false,
    safePassage: false,
    itemResolvedHoldEffectStrength: null,
    lastMoveFailed: false,
    ...overrides,
  }
}

function ctx(overrides: Partial<DamageContext> = {}): DamageContext {
  return {
    attacker: battler(),
    defender: battler(),
    field: { gravityActive: false, terrain: null, weather: 'NONE' },
    attackerActsFirst: true,
    sameMoveTurnsInARow: 0,
    defenderIsSwitching: false,
    magnitudeTier: null,
    attackerRolloutCounter: 0,
    attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: false,
    ...overrides,
  }
}

describe('applyMoveBehaviorDamage -- declarative modifiers against the real data', () => {
  it('no behavior id -> unchanged', () => {
    expect(applyMoveBehaviorDamage(80, null, behaviors, ctx())).toEqual({ power: 80, unmodelled: [] })
  })

  it('EFFECT_CAPTIVATE: x2 only when the target is infatuated', () => {
    expect(applyMoveBehaviorDamage(60, 'EFFECT_CAPTIVATE', behaviors, ctx()).power).toBe(60)
    const infatuated = ctx({ defender: battler({ isInfatuated: true }) })
    expect(applyMoveBehaviorDamage(60, 'EFFECT_CAPTIVATE', behaviors, infatuated).power).toBe(120)
  })

  it('EFFECT_ASSURANCE never triggers -- upstream leaves `by` unset (BATTLER_NONE)', () => {
    // Real bug in the data: Damaged(TARGET, BATTLER_NONE) is unconditionally false
    // (src/script_conditions.cc:45), so this move's boost never actually fires.
    const damaged = ctx({ defender: battler({ wasDamagedThisTurnBy: 'attacker' }) })
    expect(applyMoveBehaviorDamage(60, 'EFFECT_ASSURANCE', behaviors, damaged).power).toBe(60)
  })

  it('EFFECT_RETALIATE: x2 when an ally fainted last turn', () => {
    expect(applyMoveBehaviorDamage(70, 'EFFECT_RETALIATE', behaviors, ctx({ attacker: battler({ recentlyFainted: true }) })).power).toBe(140)
  })

  it('EFFECT_MISTY_TERRAIN_BOOST: the float literal is applied via Math.trunc, not the fixed-point path', () => {
    const inMisty = ctx({ attacker: battler(), field: { gravityActive: false, terrain: null, weather: 'NONE' } })
    // multiply value from the data is 1.2999999523162842 (a float32 round-trip of 1.3)
    expect(applyMoveBehaviorDamage(100, 'EFFECT_MISTY_TERRAIN_BOOST', behaviors, inMisty).power).toBe(100)
  })

  it('EFFECT_PAY_DAY (SET behaves as ADD -- a real upstream codegen bug)', () => {
    const conditionsMet = ctx({
      attacker: battler({ speciesId: 'SPECIES_MEOWTH_PARTNER', itemId: 'ITEM_AMULET_COIN' }),
    })
    // set: 120, but MoveDamageGenerator.kt emits `baseDamage + set`, not `set`
    expect(applyMoveBehaviorDamage(40, 'EFFECT_PAY_DAY', behaviors, conditionsMet).power).toBe(160)
  })

  it('EFFECT_ACROBATICS custom condition: attacker holding no item', () => {
    expect(applyMoveBehaviorDamage(55, 'EFFECT_ACROBATICS', behaviors, ctx()).power).toBe(82) // floor(55*1.5)
    const holdingItem = ctx({ attacker: battler({ itemId: 'ITEM_LEFTOVERS' }) })
    expect(applyMoveBehaviorDamage(55, 'EFFECT_ACROBATICS', behaviors, holdingItem).power).toBe(55)
  })

  it('EFFECT_ROUND and EFFECT_FUSION_COMBO custom conditions are always false in singles', () => {
    expect(applyMoveBehaviorDamage(60, 'EFFECT_ROUND', behaviors, ctx()).power).toBe(60)
    expect(applyMoveBehaviorDamage(65, 'EFFECT_FUSION_COMBO', behaviors, ctx()).power).toBe(65)
  })

  it('EFFECT_ERUPTION: proportional to attacker HP%', () => {
    const halfHp = ctx({ attacker: battler({ hp: 50, maxHp: 100 }) })
    expect(applyMoveBehaviorDamage(150, 'EFFECT_ERUPTION', behaviors, halfHp).power).toBe(75)
  })

  it('EFFECT_LOW_KICK: power scales with the DEFENDER weight', () => {
    expect(applyMoveBehaviorDamage(0, 'EFFECT_LOW_KICK', behaviors, ctx({ defender: battler({ weight: 90 }) })).power).toBe(20)
    expect(applyMoveBehaviorDamage(0, 'EFFECT_LOW_KICK', behaviors, ctx({ defender: battler({ weight: 3000 }) })).power).toBe(120)
  })

  it('EFFECT_ELECTRO_BALL bug: an out-of-range speed ratio returns the table length (4), not 150', () => {
    const fast = ctx({ attacker: battler({ speed: 500 }), defender: battler({ speed: 50 }) }) // ratio 10, out of range
    expect(applyMoveBehaviorDamage(0, 'EFFECT_ELECTRO_BALL', behaviors, fast).power).toBe(4)
  })

  it('EFFECT_ELECTRO_BALL: in-range ratio indexes the table normally', () => {
    const ratio1 = ctx({ attacker: battler({ speed: 150 }), defender: battler({ speed: 100 }) }) // floor(150/100)=1
    expect(applyMoveBehaviorDamage(0, 'EFFECT_ELECTRO_BALL', behaviors, ratio1).power).toBe(60)
  })

  it('EFFECT_TRUMP_CARD: power keyed off remaining PP', () => {
    expect(applyMoveBehaviorDamage(0, 'EFFECT_TRUMP_CARD', behaviors, ctx({ attacker: battler({ usedMovePpRemaining: 0 }) })).power).toBe(200)
    expect(applyMoveBehaviorDamage(0, 'EFFECT_TRUMP_CARD', behaviors, ctx({ attacker: battler({ usedMovePpRemaining: 4 }) })).power).toBe(40)
    expect(applyMoveBehaviorDamage(90, 'EFFECT_TRUMP_CARD', behaviors, ctx({ attacker: battler({ usedMovePpRemaining: null }) })).power).toBe(90)
  })

  it('a behavior with no attack.damage block passes power through unchanged', () => {
    expect(applyMoveBehaviorDamage(40, 'EFFECT_MULTI_HIT', behaviors, ctx())).toEqual({ power: 40, unmodelled: [] })
  })
})

describe('percentToModifier', () => {
  it('matches gPercentToModifier at the boundary values', () => {
    expect(percentToModifier(0)).toBe(uq(0))
    expect(percentToModifier(30)).toBe(uq(0.3))
    expect(percentToModifier(100)).toBe(uq(1.0))
    expect(percentToModifier(150)).toBe(uq(1.0)) // clamped, src/battle_util.c:7013
  })
})

function bpmCtx(overrides: Partial<BasePowerModifierContext> = {}): BasePowerModifierContext {
  return {
    ...ctx(),
    moveType: 'NORMAL',
    isPhysical: true,
    isSpecial: false,
    attackerHoldEffect: { resolvedHoldEffect: null, strength: null, holdEffectType: null },
    attackerIsLatiOrLatias: false,
    defenderHasUnnerve: false,
    moveDoubleDamageVsMega: false,
    moveEffect: null,
    moveArgumentStatus: null,
    ...overrides,
  }
}

describe('calcMoveBasePowerAfterModifiers', () => {
  it('Muscle Band boosts physical moves only', () => {
    const withBand: BasePowerModifierContext = bpmCtx({ attackerHoldEffect: { resolvedHoldEffect: 'HOLD_EFFECT_MUSCLE_BAND', strength: 10, holdEffectType: null } })
    expect(calcMoveBasePowerAfterModifiers(100, withBand)).toBe(110)
    expect(calcMoveBasePowerAfterModifiers(100, { ...withBand, isPhysical: false, isSpecial: true })).toBe(100)
  })

  it('Plate/Type Power boost a matching-type move, using the bare (non-TYPE_-prefixed) type name', () => {
    const withPlate = bpmCtx({ moveType: 'FIRE', attackerHoldEffect: { resolvedHoldEffect: 'HOLD_EFFECT_PLATE', strength: 20, holdEffectType: 'FIRE' } })
    expect(calcMoveBasePowerAfterModifiers(100, withPlate)).toBe(120)
    expect(calcMoveBasePowerAfterModifiers(100, { ...withPlate, moveType: 'WATER' })).toBe(100)

    const withTypePower = bpmCtx({ moveType: 'GRASS', attackerHoldEffect: { resolvedHoldEffect: 'HOLD_EFFECT_TYPE_POWER', strength: 20, holdEffectType: 'GRASS' } })
    expect(calcMoveBasePowerAfterModifiers(100, withTypePower)).toBe(120)
  })

  it('a type-matching Gem boosts power unless the defender has Unnerve', () => {
    const withGem = bpmCtx({ moveType: 'FIRE', attackerHoldEffect: { resolvedHoldEffect: 'HOLD_EFFECT_GEMS', strength: 50, holdEffectType: 'FIRE' } })
    expect(calcMoveBasePowerAfterModifiers(100, withGem)).toBe(150)
    expect(calcMoveBasePowerAfterModifiers(100, { ...withGem, moveType: 'WATER' })).toBe(100)
    expect(calcMoveBasePowerAfterModifiers(100, { ...withGem, defenderHasUnnerve: true })).toBe(100)
  })

  it('doubleDamageVsMega doubles power against a Mega-evolved defender only', () => {
    const vsMega = bpmCtx({ moveDoubleDamageVsMega: true, defender: battler({ isMegaEvolved: true }) })
    expect(calcMoveBasePowerAfterModifiers(100, vsMega)).toBe(200)
    expect(calcMoveBasePowerAfterModifiers(100, { ...vsMega, defender: battler({ isMegaEvolved: false }) })).toBe(100)
    expect(calcMoveBasePowerAfterModifiers(100, { ...vsMega, moveDoubleDamageVsMega: false })).toBe(100)
  })

  it('EFFECT_FACADE doubles power when the attacker has a major status', () => {
    const burned = bpmCtx({ moveEffect: 'EFFECT_FACADE', attacker: battler({ status1: new Set(['STATUS1_BURN']) }) })
    expect(calcMoveBasePowerAfterModifiers(70, burned)).toBe(140)
    expect(calcMoveBasePowerAfterModifiers(70, bpmCtx({ moveEffect: 'EFFECT_FACADE' }))).toBe(70)
  })

  it('EFFECT_BRINE doubles power when the target is at or below half HP', () => {
    const lowHp = bpmCtx({ moveEffect: 'EFFECT_BRINE', defender: battler({ hp: 50, maxHp: 100 }) })
    expect(calcMoveBasePowerAfterModifiers(65, lowHp)).toBe(130)
  })

  it('Knock Off gets x1.5 when the target holds an item', () => {
    const holding = bpmCtx({ moveEffect: 'EFFECT_KNOCK_OFF', defender: battler({ itemId: 'ITEM_LEFTOVERS' }) })
    // applyModifier rounds half-up: floor((1536*65+512)/1024) = floor(98.0) = 98
    expect(calcMoveBasePowerAfterModifiers(65, holding)).toBe(98)
  })

  it('terrain STAB-style boost applies only to a matching move type', () => {
    const inElectricTerrain = bpmCtx({ moveType: 'ELECTRIC', field: { gravityActive: false, terrain: 'TERRAIN_ELECTRIC', weather: 'NONE' } })
    expect(calcMoveBasePowerAfterModifiers(90, inElectricTerrain)).toBe(117) // floor(90*1.3)=117
    expect(calcMoveBasePowerAfterModifiers(90, { ...inElectricTerrain, moveType: 'WATER' })).toBe(90)
  })

  it('Helping Hand and Charged Up stack multiplicatively via mulModifier', () => {
    const boosted = bpmCtx({ moveType: 'ELECTRIC', attacker: battler({ helpingHand: true, chargedUp: true }) })
    // mulModifier(mulModifier(1024, uq(1.5)), uq(2.0)) applied to 50
    expect(calcMoveBasePowerAfterModifiers(50, boosted)).toBeGreaterThan(50 * 2) // sanity: definitely more than a single x2
  })
})

describe('moveBehaviors.json data contract -- conditions.ts crash guard', () => {
  // evaluateCondition (conditions.ts) deliberately THROWS on ScriptCondition kinds
  // 'weather'/'switching'/'ability' rather than silently degrading -- verified
  // manually against the current data (2026-09-03) that none of the structured
  // (non-legacy_config) behaviors use them. This test turns that manual
  // verification into a standing guarantee: if a future abilityHooks.json/
  // moveBehaviors.json regeneration from a newer upstream commit introduces one,
  // this fails loudly at test time instead of crashing a user's calculation.
  it('no structured behavior references an unmodelled condition kind (weather/switching/ability)', () => {
    const UNMODELLED_KINDS = new Set(['weather', 'switching', 'ability'])
    const offenders: string[] = []

    function scan(node: unknown, behaviorId: string): void {
      if (Array.isArray(node)) {
        for (const item of node) scan(item, behaviorId)
      } else if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>
        if (typeof obj.kind === 'string' && UNMODELLED_KINDS.has(obj.kind)) offenders.push(`${behaviorId}: kind="${obj.kind}"`)
        for (const value of Object.values(obj)) scan(value, behaviorId)
      }
    }

    for (const [id, cfg] of Object.entries(behaviors)) {
      if ('legacy_config' in (cfg as object)) continue // opaque, never reaches evaluateCondition
      scan(cfg, id)
    }

    expect(offenders).toEqual([])
  })
})

describe('applyPreModifierBasePower', () => {
  it('EFFECT_WAKE_UP_SLAP doubles power vs a sleeping (or Comatose) defender', () => {
    expect(applyPreModifierBasePower(100, 'EFFECT_WAKE_UP_SLAP', null, ctx({ defender: battler({ status1: new Set(['STATUS1_SLEEP']) }) }), 0, null, false).power).toBe(200)
    expect(applyPreModifierBasePower(100, 'EFFECT_WAKE_UP_SLAP', null, ctx({ defender: battler({ hasComatose: true }) }), 0, null, false).power).toBe(200)
    expect(applyPreModifierBasePower(100, 'EFFECT_WAKE_UP_SLAP', null, ctx(), 0, null, false).power).toBe(100)
  })

  it('EFFECT_SMELLINGSALT doubles power vs a paralyzed defender', () => {
    expect(applyPreModifierBasePower(75, 'EFFECT_SMELLINGSALT', null, ctx({ defender: battler({ status1: new Set(['STATUS1_PARALYSIS']) }) }), 0, null, false).power).toBe(150)
    expect(applyPreModifierBasePower(75, 'EFFECT_SMELLINGSALT', null, ctx(), 0, null, false).power).toBe(75)
  })

  it('MISC_EFFECT_FAINTED_MON_BOOST adds 10 per fainted ally', () => {
    expect(applyPreModifierBasePower(50, 'EFFECT_MISC_HIT', 'MISC_EFFECT_FAINTED_MON_BOOST', ctx(), 3, null, false).power).toBe(80)
    expect(applyPreModifierBasePower(50, 'EFFECT_MISC_HIT', 'MISC_EFFECT_FAINTED_MON_BOOST', ctx(), 0, null, false).power).toBe(50)
  })

  it('MISC_EFFECT_ELECTRIC_TERRAIN_BOOST applies 1.5x only while grounded on Electric Terrain', () => {
    const electric = ctx({ field: { gravityActive: false, weather: 'NONE', terrain: 'TERRAIN_ELECTRIC' } })
    expect(applyPreModifierBasePower(100, 'EFFECT_MISC_HIT', 'MISC_EFFECT_ELECTRIC_TERRAIN_BOOST', electric, 0, null, false).power).toBe(150)
    expect(applyPreModifierBasePower(100, 'EFFECT_MISC_HIT', 'MISC_EFFECT_ELECTRIC_TERRAIN_BOOST', ctx(), 0, null, false).power).toBe(100)
  })

  it('MISC_EFFECT_DOUBLE_DAMAGE_VS_BLEEDING and its 50%-plus sibling key off bleed/blood-stain', () => {
    const bleeding = ctx({ defender: battler({ status1: new Set(['STATUS1_BLEED']) }) })
    expect(applyPreModifierBasePower(80, 'EFFECT_MISC_HIT', 'MISC_EFFECT_DOUBLE_DAMAGE_VS_BLEEDING', bleeding, 0, null, false).power).toBe(160)
    expect(applyPreModifierBasePower(80, 'EFFECT_MISC_HIT', 'MISC_EFFECT_DOUBLE_DAMAGE_VS_BLEEDING', ctx(), 0, null, false).power).toBe(80)
    expect(applyPreModifierBasePower(80, 'EFFECT_MISC_HIT', 'MISC_EFFECT_50_PERCENT_PLUS_DAMAGE_VS_BLEEDING', bleeding, 0, null, false).power).toBe(120)

    const bloodStained = ctx({ defender: battler({ hasBloodStainEffect: true }) })
    expect(applyPreModifierBasePower(80, 'EFFECT_MISC_HIT', 'MISC_EFFECT_DOUBLE_DAMAGE_VS_BLEEDING', bloodStained, 0, null, false).power).toBe(160)
  })

  it('MISC_EFFECT_DOUBLE_DAMAGE_IN_FOG doubles power only in fog', () => {
    const fog = ctx({ field: { gravityActive: false, weather: 'FOG', terrain: null } })
    expect(applyPreModifierBasePower(90, 'EFFECT_MISC_HIT', 'MISC_EFFECT_DOUBLE_DAMAGE_IN_FOG', fog, 0, null, false).power).toBe(180)
    expect(applyPreModifierBasePower(90, 'EFFECT_MISC_HIT', 'MISC_EFFECT_DOUBLE_DAMAGE_IN_FOG', ctx(), 0, null, false).power).toBe(90)
  })

  it('surfaces the genuinely unmodelled MISC_EFFECT sub-cases without touching power', () => {
    for (const miscEffect of ['MISC_EFFECT_DOUBLE_DAMAGE', 'MISC_EFFECT_TOOK_DAMAGE_BOOST', 'MISC_EFFECT_TRANSMUTE']) {
      const result = applyPreModifierBasePower(100, 'EFFECT_MISC_HIT', miscEffect, ctx(), 0, null, false)
      expect(result.power).toBe(100)
      expect(result.unmodelled).toHaveLength(1)
    }
  })

  it('leaves power untouched for every other move effect', () => {
    expect(applyPreModifierBasePower(100, 'EFFECT_FACADE', null, ctx(), 0, null, false)).toEqual({ power: 100, unmodelled: [] })
    expect(applyPreModifierBasePower(100, null, null, ctx(), 0, null, false)).toEqual({ power: 100, unmodelled: [] })
  })

  it('EFFECT_NATURAL_GIFT uses the held berry\'s power, or 0 (the move fails) without one', () => {
    expect(applyPreModifierBasePower(0, 'EFFECT_NATURAL_GIFT', null, ctx(), 0, 90, false).power).toBe(90)
    expect(applyPreModifierBasePower(0, 'EFFECT_NATURAL_GIFT', null, ctx(), 0, null, false).power).toBe(0)
  })

  it('EFFECT_WEATHER_BALL doubles power under any weather or Aurora Borealis, not with no weather', () => {
    const rain = ctx({ field: { gravityActive: false, weather: 'RAIN_PERMANENT', terrain: null } })
    expect(applyPreModifierBasePower(50, 'EFFECT_WEATHER_BALL', null, rain, 0, null, false).power).toBe(100)
    expect(applyPreModifierBasePower(50, 'EFFECT_WEATHER_BALL', null, ctx(), 0, null, false).power).toBe(50)
    expect(applyPreModifierBasePower(50, 'EFFECT_WEATHER_BALL', null, ctx(), 0, null, true).power).toBe(100)
  })

  it('EFFECT_TRIPLE_KICK (Triple Kick/Triple Axel) scales power 1x/2x/3x by hitIndex (battle_util.c:6850-6852)', () => {
    expect(applyPreModifierBasePower(20, 'EFFECT_TRIPLE_KICK', null, ctx(), 0, null, false, 0).power).toBe(20)
    expect(applyPreModifierBasePower(20, 'EFFECT_TRIPLE_KICK', null, ctx(), 0, null, false, 1).power).toBe(40)
    expect(applyPreModifierBasePower(20, 'EFFECT_TRIPLE_KICK', null, ctx(), 0, null, false, 2).power).toBe(60)
    // hitIndex defaults to 0 for a non-multi-hit caller.
    expect(applyPreModifierBasePower(20, 'EFFECT_TRIPLE_KICK', null, ctx(), 0, null, false).power).toBe(20)
  })

  it('EFFECT_MAGNITUDE uses the fixed per-tier power table (battle_util.c:11286-11307)', () => {
    const tiers: [number, number][] = [
      [4, 10],
      [5, 30],
      [6, 50],
      [7, 70],
      [8, 90],
      [9, 110],
      [10, 150],
    ]
    for (const [tier, power] of tiers) {
      const result = applyPreModifierBasePower(1, 'EFFECT_MAGNITUDE', null, ctx({ magnitudeTier: tier as 4 | 5 | 6 | 7 | 8 | 9 | 10 }), 0, null, false)
      expect(result.power).toBe(power)
      expect(result.unmodelled).toHaveLength(0)
    }
  })

  it('EFFECT_MAGNITUDE with no tier set falls back to the modal Magnitude 7 (70) and surfaces an unmodelled note', () => {
    const result = applyPreModifierBasePower(1, 'EFFECT_MAGNITUDE', null, ctx({ magnitudeTier: null }), 0, null, false)
    expect(result.power).toBe(70)
    expect(result.unmodelled).toHaveLength(1)
  })

  it('EFFECT_ROLLOUT (Rollout/Ice Ball): counter 0 needs Defense Curl for x2, else unboosted (battle_util.c:6838-6841)', () => {
    expect(applyPreModifierBasePower(40, 'EFFECT_ROLLOUT', null, ctx({ attackerRolloutCounter: 0, attackerHasDefenseCurl: false }), 0, null, false).power).toBe(40)
    expect(applyPreModifierBasePower(40, 'EFFECT_ROLLOUT', null, ctx({ attackerRolloutCounter: 0, attackerHasDefenseCurl: true }), 0, null, false).power).toBe(80)
  })

  it('EFFECT_ROLLOUT: counter 1/2/3 shift power left by (counter-1) -- x1/x2/x4, not a linear x1/x2/x3', () => {
    expect(applyPreModifierBasePower(40, 'EFFECT_ROLLOUT', null, ctx({ attackerRolloutCounter: 1 }), 0, null, false).power).toBe(40)
    expect(applyPreModifierBasePower(40, 'EFFECT_ROLLOUT', null, ctx({ attackerRolloutCounter: 2 }), 0, null, false).power).toBe(80)
    expect(applyPreModifierBasePower(40, 'EFFECT_ROLLOUT', null, ctx({ attackerRolloutCounter: 3 }), 0, null, false).power).toBe(160)
    // Defense Curl is irrelevant once counter >= 1 -- only the counter===0 branch reads it.
    expect(applyPreModifierBasePower(40, 'EFFECT_ROLLOUT', null, ctx({ attackerRolloutCounter: 3, attackerHasDefenseCurl: true }), 0, null, false).power).toBe(160)
  })

  it('EFFECT_PURSUIT doubles power only when the defender is switching (battle_util.c:6860-6861)', () => {
    expect(applyPreModifierBasePower(50, 'EFFECT_PURSUIT', null, ctx({ defenderIsSwitching: true }), 0, null, false).power).toBe(100)
    expect(applyPreModifierBasePower(50, 'EFFECT_PURSUIT', null, ctx({ defenderIsSwitching: false }), 0, null, false).power).toBe(50)
  })

  it('EFFECT_FOCUS_PUNCH forces power to 40 (not a multiplier) only if the attacker was hit this turn (battle_util.c:6876-6877)', () => {
    expect(applyPreModifierBasePower(150, 'EFFECT_FOCUS_PUNCH', null, ctx({ attackerWasHitThisTurn: true }), 0, null, false).power).toBe(40)
    expect(applyPreModifierBasePower(150, 'EFFECT_FOCUS_PUNCH', null, ctx({ attackerWasHitThisTurn: false }), 0, null, false).power).toBe(150)
  })
})

describe('applyMoveSpecificBasePower (CalcMoveBasePower\'s move-ID-keyed tail switch, battle_util.c:6915-6935)', () => {
  const hasAbility =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id)
  const noAbility = () => false

  it('Water Shuriken: Ash-Greninja forces 20, Giant Shuriken forces 100, otherwise unchanged', () => {
    expect(applyMoveSpecificBasePower(18, 'MOVE_WATER_SHURIKEN', 'SPECIES_GRENINJA_ASH', noAbility, new Set(), false)).toBe(20)
    expect(applyMoveSpecificBasePower(18, 'MOVE_WATER_SHURIKEN', 'SPECIES_GRENINJA', hasAbility('ABILITY_GIANT_SHURIKEN'), new Set(), false)).toBe(100)
    expect(applyMoveSpecificBasePower(18, 'MOVE_WATER_SHURIKEN', 'SPECIES_GRENINJA', noAbility, new Set(), false)).toBe(18)
  })

  it('Dragon Darts: Parental Bond multiplies by 5/4, truncated', () => {
    expect(applyMoveSpecificBasePower(50, 'MOVE_DRAGON_DARTS', 'SPECIES_GARCHOMP', hasAbility('ABILITY_PARENTAL_BOND'), new Set(), false)).toBe(62)
    expect(applyMoveSpecificBasePower(50, 'MOVE_DRAGON_DARTS', 'SPECIES_GARCHOMP', noAbility, new Set(), false)).toBe(50)
  })

  it('Self-Destruct doubles power if the attacker was hit this turn, same fact Focus Punch reads', () => {
    expect(applyMoveSpecificBasePower(200, 'MOVE_SELF_DESTRUCT', 'SPECIES_GARCHOMP', noAbility, new Set(), true)).toBe(400)
    expect(applyMoveSpecificBasePower(200, 'MOVE_SELF_DESTRUCT', 'SPECIES_GARCHOMP', noAbility, new Set(), false)).toBe(200)
  })

  it('Dream Inversion doubles power vs a sleeping defender', () => {
    expect(applyMoveSpecificBasePower(70, 'MOVE_DREAM_INVERSION', 'SPECIES_GARCHOMP', noAbility, new Set(['STATUS1_SLEEP']), false)).toBe(140)
    expect(applyMoveSpecificBasePower(70, 'MOVE_DREAM_INVERSION', 'SPECIES_GARCHOMP', noAbility, new Set(), false)).toBe(70)
  })

  it('Flying Press adds a flat 10 power with Wrestle Showman', () => {
    expect(applyMoveSpecificBasePower(100, 'MOVE_FLYING_PRESS', 'SPECIES_GARCHOMP', hasAbility('ABILITY_WRESTLE_SHOWMAN'), new Set(), false)).toBe(110)
    expect(applyMoveSpecificBasePower(100, 'MOVE_FLYING_PRESS', 'SPECIES_GARCHOMP', noAbility, new Set(), false)).toBe(100)
  })

  it('Roar of Time forces power to 100 with Temporal Rupture', () => {
    expect(applyMoveSpecificBasePower(90, 'MOVE_ROAR_OF_TIME', 'SPECIES_GARCHOMP', hasAbility('ABILITY_TEMPORAL_RUPTURE'), new Set(), false)).toBe(100)
    expect(applyMoveSpecificBasePower(90, 'MOVE_ROAR_OF_TIME', 'SPECIES_GARCHOMP', noAbility, new Set(), false)).toBe(90)
  })

  it('leaves every other move untouched', () => {
    expect(applyMoveSpecificBasePower(40, 'MOVE_TACKLE', 'SPECIES_GARCHOMP', noAbility, new Set(), false)).toBe(40)
  })
})

describe('applyAngelsWrathBasePower (battle_util.c:6938-6952)', () => {
  it('forces the exact power for each of its 4 moves, only when the attacker holds it', () => {
    expect(applyAngelsWrathBasePower(40, 'MOVE_TACKLE', true)).toBe(100)
    expect(applyAngelsWrathBasePower(40, 'MOVE_POISON_STING', true)).toBe(120)
    expect(applyAngelsWrathBasePower(60, 'MOVE_ELECTROWEB', true)).toBe(155)
    expect(applyAngelsWrathBasePower(60, 'MOVE_BUG_BITE', true)).toBe(140)
  })

  it('leaves power untouched without the ability, or for any other move', () => {
    expect(applyAngelsWrathBasePower(40, 'MOVE_TACKLE', false)).toBe(40)
    expect(applyAngelsWrathBasePower(90, 'MOVE_EARTHQUAKE', true)).toBe(90)
  })
})

describe('weatherBallType', () => {
  it('Aurora Borealis wins outright, even under an unrelated weather', () => {
    expect(weatherBallType('RAIN_PERMANENT', true)).toBe('ICE')
  })

  it.each([
    ['RAIN_PERMANENT', 'WATER'],
    ['RAIN_TEMPORARY', 'WATER'],
    ['RAIN_PRIMAL', 'WATER'],
    ['SUN_PERMANENT', 'FIRE'],
    ['SUN_TEMPORARY', 'FIRE'],
    ['SUN_PRIMAL', 'FIRE'],
    ['SANDSTORM', 'ROCK'],
    ['HAIL', 'ICE'],
    ['FOG', 'GHOST'],
  ])('%s -> %s', (weather, expected) => {
    expect(weatherBallType(weather, false)).toBe(expected)
  })

  it('no weather active -> null (stays Normal-type)', () => {
    expect(weatherBallType('NONE', false)).toBeNull()
  })
})
