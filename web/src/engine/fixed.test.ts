import { describe, expect, it } from 'vitest'
import { applyModifier, idiv, mulModifier, uq, UQ_ONE } from './fixed'

// Every expected value here is either a direct C-macro definition
// (include/global.h:113-139) or hand-computed from it -- see the comment on each case.

describe('uq (UQ_4_12 constant construction)', () => {
  it('uq(1.0) is 1024, not 4096 -- ER redefines UQ_4_12_PRECISION to 10', () => {
    expect(uq(1.0)).toBe(UQ_ONE)
    expect(UQ_ONE).toBe(1024)
  })

  it('truncates rather than rounds, matching the C cast', () => {
    // (u16)(0.65 * 1024) = (u16)665.6 = 665
    expect(uq(0.65)).toBe(665)
    // (u16)(0.66 * 1024) = (u16)675.84 = 675
    expect(uq(0.66)).toBe(675)
    // (u16)(1.3 * 1024) = (u16)1331.2 = 1331
    expect(uq(1.3)).toBe(1331)
    // (u16)((4.0/3.0) * 1024) = (u16)1365.33... = 1365
    expect(uq(4 / 3)).toBe(1365)
  })

  it('exact multiplier constants used throughout the damage formula', () => {
    expect(uq(0.5)).toBe(512)
    expect(uq(0.75)).toBe(768)
    expect(uq(0.8)).toBe(819) // (u16)(0.8*1024) = (u16)819.2 = 819
    expect(uq(0.9)).toBe(921) // (u16)(0.9*1024) = (u16)921.6 = 921
    expect(uq(1.1)).toBe(1126) // (u16)(1.1*1024) = (u16)1126.4 = 1126
    expect(uq(1.2)).toBe(1228) // (u16)(1.2*1024) = (u16)1228.8 = 1228
    expect(uq(1.25)).toBe(1280)
    expect(uq(1.5)).toBe(1536)
    expect(uq(1.6)).toBe(1638) // (u16)(1.6*1024) = (u16)1638.4 = 1638
    expect(uq(2.0)).toBe(2048)
  })
})

describe('mulModifier (src/battle_util.c:6810)', () => {
  it('is the identity when multiplying by UQ_ONE', () => {
    for (const v of [0, 1, 512, 1024, 2048, 65535]) {
      expect(mulModifier(UQ_ONE, v)).toBe(v & 0xffff)
    }
  })

  it('rounds half-up on the /1024 quantization step', () => {
    // (1024 * 1) + 512 = 1536; 1536/1024 = 1.5 -> floor -> 1
    expect(mulModifier(1024, 1)).toBe(1)
    // (512 * 1) + 512 = 1024; 1024/1024 = 1 -> exact
    expect(mulModifier(512, 1)).toBe(1)
    // (512 * 3) + 512 = 2048; 2048/1024 = 2 -- applyModifier's own doc example, but
    // mulModifier and applyModifier share the exact same arithmetic
    expect(mulModifier(512, 3)).toBe(2)
  })

  it('re-quantizes at every call, so order of application matters', () => {
    // mulModifier(mulModifier(1024, a), b) is not required to equal
    // mulModifier(1024, floor(a*b/1024)) computed a different way -- the three-type
    // effectiveness fold (typeEffect.ts) depends on this staying three separate calls.
    const a = uq(2.0) // 2048
    const stepwise = mulModifier(mulModifier(1024, a), a)
    expect(stepwise).toBe(4096) // 2.0 * 2.0, exact here since 2.0 has no fractional bits
  })

  it('masks the accumulator to 16 bits, matching the C u16 storage', () => {
    // finalModifier=60000, multiplied by 2.0: (60000*2048 + 512) / 1024 = 120000
    // (unmasked), which overflows a u16 and wraps to 120000 - 65536 = 54464. Ported
    // faithfully rather than "fixed" -- this is what the ROM itself computes.
    expect(mulModifier(60000, uq(2.0))).toBe(54464)
  })
})

describe('applyModifier (src/battle_util.c:6812)', () => {
  it('is the identity when the modifier is UQ_ONE', () => {
    for (const v of [0, 1, 100, 999999]) {
      expect(applyModifier(UQ_ONE, v)).toBe(v)
    }
  })

  it('rounds half-up, not toward zero', () => {
    // (512 * 3 + 512) / 1024 = 2048/1024 = 2 (0.5 * 3 = 1.5, rounds up to 2)
    expect(applyModifier(512, 3)).toBe(2)
    // (512 * 1 + 512) / 1024 = 1024/1024 = 1 (0.5 * 1 = 0.5, rounds up to 1)
    expect(applyModifier(512, 1)).toBe(1)
    // (512 * 0 + 512) / 1024 = 512/1024 = 0 (0.5 * 0 = 0, no rounding needed)
    expect(applyModifier(512, 0)).toBe(0)
  })

  it('does not mask to 16 bits -- the C signature takes a u32 val with no overflow in practice', () => {
    expect(applyModifier(uq(1.5), 100000)).toBe(150000)
  })
})

describe('idiv', () => {
  it('truncates toward zero for non-negative operands', () => {
    expect(idiv(7, 2)).toBe(3)
    expect(idiv(6, 2)).toBe(3)
    expect(idiv(0, 5)).toBe(0)
    expect(idiv(252, 4)).toBe(63) // EV/4 truncation, used throughout monStats.ts
  })
})
