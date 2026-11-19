/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import { wilsonInterval } from './driver/wilson'

describe('wilsonInterval', () => {
  it('40 straight wins at per-look 0.005 has a corrected lower bound of 0.835', () => {
    expect(wilsonInterval(40, 40, 2.807).lower).toBeCloseTo(0.835, 3)
  })

  it('0 wins in 40 gives the mirrored upper bound', () => {
    expect(wilsonInterval(0, 40, 2.807).upper).toBeCloseTo(0.165, 3)
  })

  it('400 games at 200 wins has a half-width of 0.0695 at z 2.807', () => {
    const { lower, upper } = wilsonInterval(200, 400, 2.807)
    expect((upper - lower) / 2).toBeCloseTo(0.0695, 3)
  })

  it('n = 0 throws', () => {
    expect(() => wilsonInterval(0, 0, 2.807)).toThrow()
  })
})
