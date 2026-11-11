/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import { buildConsumptionIndex, tryExtractFunctionSlice } from './driver/moveInventory'

// Cycle 150i2b: the inventory extracts a function's slice by matching the brace that closes its
// body, not by running on to the next top-level declaration. The old extent swept the next file's
// import header into the name scans; these synthetic sources pin the difference without reading
// the production tree.

const APPLY_SECONDARY = 'export function applySecondaryMoveEffects('

/** A consumer source whose trailing text mentions `MOVE_EFFECT_WRAP` only outside the function. */
function withTrailingImport(bodyComparison: string): string {
  return [
    APPLY_SECONDARY,
    '  ctx: { effect: string },',
    '): string {',
    `  if (ctx.effect === '${bodyComparison}') return 'inside'`,
    '  switch (ctx.effect) {',
    "    case 'EFFECT_TEST_INSIDE':",
    "      return 'inside'",
    '    default:',
    "      return 'none'",
    '  }',
    '}',
    '',
    "import { MOVE_EFFECT_WRAP } from './x'",
    '',
    'function sibling() {',
    "  return 'MOVE_EFFECT_WRAP'",
    '}',
  ].join('\n')
}

describe('Cycle 150i2b - brace-matched function slices', () => {
  it('stops at the closing brace, so a following import and function are not part of the slice', () => {
    const source = withTrailingImport('MOVE_EFFECT_BURN')
    const slice = tryExtractFunctionSlice(source, APPLY_SECONDARY)

    expect(slice.trimEnd().endsWith('}')).toBe(true)
    expect(slice).toContain("if (ctx.effect === 'MOVE_EFFECT_BURN')")
    expect(slice).toContain("case 'EFFECT_TEST_INSIDE':")
    // These lines sit after the closing brace and must not reach the scans.
    expect(slice).not.toContain('import { MOVE_EFFECT_WRAP }')
    expect(slice).not.toContain('function sibling()')
    expect(source).toContain('function sibling()')
  })

  it('still consumes a case label that really sits inside the function body', () => {
    const source = withTrailingImport('MOVE_EFFECT_BURN')
    const index = buildConsumptionIndex(source, [], {}, new Map(), '')

    // `=== 'MOVE_EFFECT_BURN'` inside the body is a dispatch site.
    expect(index.secondaryEffects.has('MOVE_EFFECT_BURN')).toBe(true)
    // The trailing import is just an import-list member.
    expect(index.secondaryEffects.has('MOVE_EFFECT_WRAP')).toBe(false)
    // A `case` label inside the body is consumed by the move-effect scan.
    expect(index.moveEffects.has('EFFECT_TEST_INSIDE')).toBe(true)
    expect(index.secondaryEffects.size).toBe(1)
  })

  it('does not count an effect mentioned only in trailing import text, but does once it is inside', () => {
    function consumer(compareYawnInside: boolean): string {
      return [
        APPLY_SECONDARY,
        '  ctx: { effect: string },',
        '): string {',
        "  if (ctx.effect === 'MOVE_EFFECT_BURN') return 'burn'",
        ...(compareYawnInside ? ["  if (ctx.effect === 'MOVE_EFFECT_YAWN') return 'yawn'"] : []),
        "  return 'none'",
        '}',
        '',
        "import { MOVE_EFFECT_YAWN } from './x'",
        '',
        'function sibling() {',
        "  return 'MOVE_EFFECT_YAWN'",
        '}',
      ].join('\n')
    }

    // Only outside-the-function mentions: the import list and a bare string return.
    const outside = buildConsumptionIndex(consumer(false), [], {}, new Map(), '')
    expect(outside.secondaryEffects.has('MOVE_EFFECT_BURN')).toBe(true)
    expect(outside.secondaryEffects.has('MOVE_EFFECT_YAWN')).toBe(false)
    expect(outside.secondaryEffects.size).toBe(1)

    // The same name compared inside the function body is consumed.
    const inside = buildConsumptionIndex(consumer(true), [], {}, new Map(), '')
    expect(inside.secondaryEffects.has('MOVE_EFFECT_YAWN')).toBe(true)
    expect(inside.secondaryEffects.size).toBe(2)
  })
})
