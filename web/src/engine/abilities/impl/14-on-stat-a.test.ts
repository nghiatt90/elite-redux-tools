import { describe, expect, it } from 'vitest'
import { ON_STAT_BATCH_A } from './14-on-stat-a'
import type { AbilityImpl, OnStatContext } from '../types'

function findAbility(id: string): AbilityImpl {
  const entry = ON_STAT_BATCH_A.find((a) => a.id === id)
  if (!entry) throw new Error(`${id} not found in batch`)
  return entry
}

function ctx(overrides: Partial<OnStatContext> = {}): OnStatContext {
  return {
    battlerId: 'self',
    statId: 'atk',
    moveId: 'MOVE_TACKLE',
    stat: 100,
    flags: { nonStackingRuin: false },
    weather: 'NONE',
    terrain: null,
    hp: 100,
    maxHp: 100,
    hasAnyStatus: false,
    status1: new Set(),
    isHighestAttackingStat: false,
    isHighestStat: false,
    abilityOn: false,
    boostedStat: null,
    alliesFainted: 0,
    ...overrides,
  }
}

function run(id: string, overrides: Partial<OnStatContext> = {}): number {
  const c = ctx(overrides)
  findAbility(id).onStat!(c)
  return c.stat
}

describe('onStat batch A', () => {
  it('weather-boosted stats', () => {
    expect(run('ABILITY_ABOMINABLE_MONSTER', { statId: 'spdef', weather: 'HAIL' })).toBe(150)
    expect(run('ABILITY_CHLOROPHYLL', { statId: 'spe', weather: 'SUN_PERMANENT' })).toBe(150)
    expect(run('ABILITY_SAND_RUSH', { statId: 'spe', weather: 'SANDSTORM' })).toBe(150)
    expect(run('ABILITY_SLUSH_RUSH', { statId: 'spe', weather: 'HAIL' })).toBe(150)
    expect(run('ABILITY_SWIFT_SWIM', { statId: 'spe', weather: 'RAIN_PERMANENT' })).toBe(150)
    expect(run('ABILITY_ETHEREAL_RUSH', { statId: 'spe', weather: 'FOG' })).toBe(150)
    expect(run('ABILITY_SURGE_SURFER', { statId: 'spe', terrain: 'TERRAIN_ELECTRIC' })).toBe(150)
    expect(run('ABILITY_THERMAL_SLIDE', { statId: 'spe', weather: 'SUN_TEMPORARY' })).toBe(150)
    expect(run('ABILITY_THERMAL_SLIDE', { statId: 'spe', weather: 'HAIL' })).toBe(150)
    expect(run('ABILITY_THERMAL_SLIDE', { statId: 'spe', weather: 'RAIN_PERMANENT' })).toBe(100)
  })

  it('terrain-boosted stats', () => {
    expect(run('ABILITY_BIOFILM', { statId: 'spdef', terrain: 'TERRAIN_TOXIC' })).toBe(150)
    expect(run('ABILITY_FLOWER_NECKLACE', { statId: 'spdef', terrain: 'TERRAIN_GRASSY' })).toBe(150)
    expect(run('ABILITY_GRASS_PELT', { statId: 'def', terrain: 'TERRAIN_GRASSY' })).toBe(150)
    expect(run('ABILITY_JUNGLE_FEVER', { statId: 'spe', terrain: 'TERRAIN_GRASSY' })).toBe(150)
    expect(run('ABILITY_HADRON_ENGINE', { statId: 'spatk', terrain: 'TERRAIN_ELECTRIC', stat: 300 })).toBe(400)
  })

  it('the highest-attacking-stat family', () => {
    expect(run('ABILITY_ECTOPLASM', { isHighestAttackingStat: true, weather: 'FOG' })).toBe(150)
    expect(run('ABILITY_RAGING_STORM', { isHighestAttackingStat: true, weather: 'RAIN_PERMANENT' })).toBe(150)
    expect(run('ABILITY_SAND_FORCE', { isHighestAttackingStat: true, weather: 'SANDSTORM' })).toBe(150)
    expect(run('ABILITY_SOLAR_POWER', { isHighestAttackingStat: true, weather: 'SUN_PERMANENT' })).toBe(150)
    expect(run('ABILITY_WHITEOUT', { isHighestAttackingStat: true, weather: 'HAIL' })).toBe(150)
    expect(run('ABILITY_SOLAR_POWER', { isHighestAttackingStat: false, weather: 'SUN_PERMANENT' })).toBe(100)
  })

  it('Polarity boosts whichever stat is overall highest', () => {
    expect(run('ABILITY_POLARITY', { isHighestStat: true })).toBe(130)
    expect(run('ABILITY_POLARITY', { isHighestStat: false })).toBe(100)
  })

  it('unconditional flat multipliers', () => {
    expect(run('ABILITY_DEAD_POWER', { statId: 'atk' })).toBe(150)
    expect(run('ABILITY_FELINE_PROWESS', { statId: 'spatk' })).toBe(200)
    expect(run('ABILITY_HUGE_POWER', { statId: 'atk' })).toBe(200)
    expect(run('ABILITY_LIGHT_METAL', { statId: 'spe' })).toBe(130)
    expect(run('ABILITY_MAJESTIC_BIRD', { statId: 'spatk' })).toBe(150)
  })

  it('Defeatist halves Atk/SpAtk at or below 1/3 HP', () => {
    expect(run('ABILITY_DEFEATIST', { statId: 'atk', hp: 33, maxHp: 100 })).toBe(50)
    expect(run('ABILITY_DEFEATIST', { statId: 'atk', hp: 34, maxHp: 100 })).toBe(100)
    expect(run('ABILITY_DEFEATIST', { statId: 'spe', hp: 1, maxHp: 100 })).toBe(100)
  })

  it('Flare Boost/Marvel Scale/Quick Feet key off status', () => {
    expect(run('ABILITY_FLARE_BOOST', { statId: 'spatk', status1: new Set(['STATUS1_BURN']) })).toBe(150)
    expect(run('ABILITY_FLARE_BOOST', { statId: 'spatk', status1: new Set() })).toBe(100)
    expect(run('ABILITY_MARVEL_SCALE', { statId: 'def', hasAnyStatus: true })).toBe(150)
    expect(run('ABILITY_QUICK_FEET', { statId: 'spe', hasAnyStatus: true })).toBe(150)
  })

  it('Flower Gift boosts SpAtk and SpDef in sun', () => {
    expect(run('ABILITY_FLOWER_GIFT', { statId: 'spatk', weather: 'SUN_PERMANENT' })).toBe(150)
    expect(run('ABILITY_FLOWER_GIFT', { statId: 'spdef', weather: 'SUN_PERMANENT' })).toBe(150)
    expect(run('ABILITY_FLOWER_GIFT', { statId: 'atk', weather: 'SUN_PERMANENT' })).toBe(100)
  })

  it('Orichalcum Pulse boosts Atk by 4/3 in sun (integer division, not float)', () => {
    expect(run('ABILITY_ORICHALCUM_PULSE', { statId: 'atk', weather: 'SUN_PERMANENT', stat: 300 })).toBe(400)
    // 301*4/3 = 401.33... truncates to 401, not a rounded 400
    expect(run('ABILITY_ORICHALCUM_PULSE', { statId: 'atk', weather: 'SUN_PERMANENT', stat: 301 })).toBe(401)
  })

  it('Last Stand scales Def/SpDef up as HP drops', () => {
    // stat=100, maxHp=100, hp=50: bonus = trunc(trunc(100*60*50/100)/100) = trunc(3000/100) = 30
    expect(run('ABILITY_LAST_STAND', { statId: 'def', hp: 50, maxHp: 100, stat: 100 })).toBe(130)
    expect(run('ABILITY_LAST_STAND', { statId: 'def', hp: 100, maxHp: 100, stat: 100 })).toBe(100)
  })

  it('Big Leaves and Rite of Spring call Solar Power then Chlorophyll unconditionally', () => {
    expect(run('ABILITY_BIG_LEAVES', { isHighestAttackingStat: true, statId: 'atk', weather: 'SUN_PERMANENT' })).toBe(150)
    expect(run('ABILITY_BIG_LEAVES', { statId: 'spe', weather: 'SUN_PERMANENT' })).toBe(150)
    expect(run('ABILITY_RITE_OF_SPRING', { statId: 'spe', weather: 'SUN_PERMANENT' })).toBe(150)
  })

  it('the 4 Ruin abilities reduce one stat by 25%, de-duped via the shared flag', () => {
    expect(run('ABILITY_TABLETS_OF_RUIN', { statId: 'atk' })).toBe(75)
    expect(run('ABILITY_SWORD_OF_RUIN', { statId: 'def' })).toBe(75)
    expect(run('ABILITY_BEADS_OF_RUIN', { statId: 'def' })).toBe(75)
    expect(run('ABILITY_VESSEL_OF_RUIN', { statId: 'spatk' })).toBe(75)
    expect(run('ABILITY_TABLETS_OF_RUIN', { statId: 'def' })).toBe(100) // wrong stat, no-op

    const c = ctx({ statId: 'def', stat: 100 })
    findAbility('ABILITY_SWORD_OF_RUIN').onStat!(c)
    expect(c.stat).toBe(75)
    findAbility('ABILITY_BEADS_OF_RUIN').onStat!(c) // already flagged -- no further reduction
    expect(c.stat).toBe(75)

    for (const id of ['ABILITY_BEADS_OF_RUIN', 'ABILITY_SWORD_OF_RUIN', 'ABILITY_TABLETS_OF_RUIN', 'ABILITY_VESSEL_OF_RUIN']) {
      expect(findAbility(id).applyOn?.onStatFor).toBe(7) // APPLY_ON_OTHER
    }
  })

  it('every entry cites a src line', () => {
    for (const ability of ON_STAT_BATCH_A) {
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })
})
