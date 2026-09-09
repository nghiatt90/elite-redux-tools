import { describe, expect, it } from 'vitest'
import { ADDS_TYPE_ABILITIES } from './12-adds-type'

describe('adds-type abilities', () => {
  it('every entry declares a bare type name and cites a src line', () => {
    for (const ability of ADDS_TYPE_ABILITIES) {
      expect(ability.addsType).toMatch(/^[A-Z]+$/)
      expect(ability.src).toMatch(/^src\/abilities\.cc:\d+$/)
    }
  })

  it('Waterborne aliases Aquatic\'s addsType (WATER) and also carries adaptability', () => {
    const waterborne = ADDS_TYPE_ABILITIES.find((a) => a.id === 'ABILITY_WATERBORNE')!
    expect(waterborne.addsType).toBe('WATER')
    expect(waterborne.flags?.adaptability).toBe(true)
  })

  it('the four flying-adjacent abilities also carry breakable+levitate', () => {
    for (const id of ['ABILITY_DRAGONFLY', 'ABILITY_FEY_FLIGHT', 'ABILITY_HOVER', 'ABILITY_WITCH_BROOM']) {
      const a = ADDS_TYPE_ABILITIES.find((x) => x.id === id)!
      expect(a.flags?.breakable).toBe(true)
      expect(a.flags?.levitate).toBe(true)
    }
  })

  it('covers all 21 pure addsType abilities', () => {
    expect(ADDS_TYPE_ABILITIES.length).toBe(21)
  })
})
