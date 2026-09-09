// Elite Redux's UQ_4_12 fixed-point type, ported bit-for-bit from
// eliteredux-source's include/global.h:113-139 and src/battle_util.c:6808-6812.
//
// Despite the name, ER redefines UQ_4_12_PRECISION to 10 (not 12), so
// UQ_4_12(1.0) === 1024, not 4096. Every multiplier constant in the damage formula is
// a value of this type, C-truncated at construction (UQ_4_12(0.65) truncates to 665,
// not a rounded 666). Two operations exist on it:
//
//   MulModifier(u16* m, u16 val)  -- *m = UQ_4_12_TO_INT(*m * val + UQ_4_12_ROUND)
//   ApplyModifier(u16 m, u32 val) -- returns UQ_4_12_TO_INT(m * val + UQ_4_12_ROUND)
//
// both round-half-up-then-truncate, and MulModifier re-quantizes its accumulator at
// every call -- so applying the same set of multipliers in a different order can
// produce a different final damage number. The engine must apply modifiers in
// exactly the C's order; see finalDamage.ts.

/** UQ_4_12(1.0) -- the fixed-point representation of the multiplier 1.0. */
export const UQ_ONE = 1024

/** UQ_4_12_ROUND -- 1 << (UQ_4_12_PRECISION - 1), the round-half-up constant. */
export const UQ_ROUND = 512

/**
 * UQ_4_12(n) -- converts a decimal multiplier to its fixed-point representation,
 * truncating exactly as the C macro `((u16)((n) * (1 << 10)))` does. Use this to
 * define every multiplier constant ported from the C (UQ_4_12(0.5), UQ_4_12(1.3), ...)
 * rather than writing the pre-computed integer by hand -- the truncation itself is
 * part of what a faithful port needs to reproduce.
 */
export function uq(n: number): number {
  return Math.trunc(n * UQ_ONE)
}

/**
 * MulModifier, src/battle_util.c:6810 -- multiplies two UQ_4_12 values and
 * re-quantizes the u16 result. `finalModifier` in CalcFinalDmg is exactly this u16
 * accumulator, and it genuinely can overflow past 65535 with enough stacked
 * multipliers (masked here with `& 0xffff`, matching the C's u16 storage) -- ported
 * faithfully rather than "fixed", since the point of this engine is to match the ROM
 * including its edge cases.
 */
export function mulModifier(m: number, val: number): number {
  return Math.floor((m * val + UQ_ROUND) / UQ_ONE) & 0xffff
}

/**
 * ApplyModifier, src/battle_util.c:6812 -- applies a UQ_4_12 modifier to an integer
 * damage/stat value. The C's `u32 val` argument does not realistically overflow at
 * battle-relevant magnitudes, so no masking is applied here (contrast mulModifier).
 */
export function applyModifier(m: number, val: number): number {
  return Math.floor((m * val + UQ_ROUND) / UQ_ONE)
}

/** C integer division truncating toward zero, for the non-negative operands the
 * damage formula always uses (`dmg / 50`, `ev / 4`, ...). Math.floor is equivalent to
 * C truncation only for non-negative values, which is all this engine ever divides. */
export function idiv(a: number, b: number): number {
  return Math.floor(a / b)
}
