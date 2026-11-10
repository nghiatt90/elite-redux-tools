/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  PORTED_RECOIL_ABILITIES_SET,
  extractAttackerBranchAbilities,
  extractCanStatusTypeAbilities,
  extractFunctionSlice,
  extractModifyMoveFlagsAbilities,
  extractRecoilAbilities,
  extractReviveAbilities,
} from './driver/abilityHookInventory'

const moveEndSource = readFileSync(new URL('moveEnd.ts', import.meta.url), 'utf8')
const statusEffectsSource = readFileSync(new URL('statusEffects.ts', import.meta.url), 'utf8')
const turnSource = readFileSync(new URL('turn.ts', import.meta.url), 'utf8')

/** Deletes exactly one source line; the result is not a program, which is fine for text extractors. */
function dropLineContaining(source: string, needle: string): string {
  const lines = source.split('\n')
  const kept = lines.filter((line) => !line.includes(needle))
  expect(kept.length, `expected exactly one line containing ${needle}`).toBe(lines.length - 1)
  return kept.join('\n')
}

/**
 * Removes the block whose header contains `marker` (from the marker through its matching `}`).
 * Copied from cycle150iInventory.test.ts: the source need not stay a valid program.
 */
function removeBranch(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const open = source.indexOf('{', start)
  if (open === -1) throw new Error(`no block after ${marker}`)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(0, start) + source.slice(i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${marker}`)
}

/** Removes the branch at `marker` and leaves a comment mention plus a gutted `if (false) {}`. */
function replaceBranchWithComment(source: string, marker: string, comment: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const without = removeBranch(source, marker)
  expect(without.length).toBeLessThan(source.length)
  return without.slice(0, start) + `${comment}\n  if (false) {}` + without.slice(start)
}

// ---------------------------------------------------------------------------
// Cycle 150i2 item 4: comments and the next declaration's JSDoc are not branches.
// ---------------------------------------------------------------------------

describe('Cycle 150i2 (4a) - a comment mention of Paint Shot is not a branch', () => {
  it('replacing the real ABILITY_PAINT_SHOT comparison with a comment drops it', () => {
    expect(moveEndSource).toContain("if (abilityId === 'ABILITY_PAINT_SHOT')")
    expect(extractAttackerBranchAbilities(moveEndSource).has('ABILITY_PAINT_SHOT')).toBe(true)

    const mutated = replaceBranchWithComment(
      moveEndSource,
      "if (abilityId === 'ABILITY_PAINT_SHOT')",
      "  // was: abilityId === 'ABILITY_PAINT_SHOT'",
    )
    expect(extractAttackerBranchAbilities(mutated).has('ABILITY_PAINT_SHOT')).toBe(false)
  })
})

describe('Cycle 150i2 (4b) - the next function JSDoc is not canParalyzeType branch evidence', () => {
  it('a JSDoc mention of ABILITY_DEPRAVITY after canParalyzeType does not count', () => {
    expect(statusEffectsSource).toContain("['ABILITY_OVERCHARGE', 'ABILITY_DEPRAVITY']")
    expect(extractCanStatusTypeAbilities(statusEffectsSource).has('ABILITY_DEPRAVITY')).toBe(true)

    const withoutDepravity = statusEffectsSource.replace(
      "for (const ability of ['ABILITY_OVERCHARGE', 'ABILITY_DEPRAVITY']) {",
      "for (const ability of ['ABILITY_OVERCHARGE']) {",
    )
    expect(withoutDepravity).not.toBe(statusEffectsSource)
    const mutated = withoutDepravity.replace(
      '/**\n * CancelMultiTurnMoves',
      "/**\n * 'ABILITY_DEPRAVITY' is only mentioned here.\n * CancelMultiTurnMoves",
    )
    expect(mutated).not.toBe(withoutDepravity)
    expect(extractCanStatusTypeAbilities(mutated).has('ABILITY_DEPRAVITY')).toBe(false)
  })
})

describe('Cycle 150i2 (4c) - the slice ends at the matching body brace', () => {
  it('does not reach the next function JSDoc and keeps strings and nested blocks', () => {
    const src = [
      'function first() {',
      '  const s = "}"',
      '  if (true) {',
      '    return s',
      '  }',
      '}',
      '',
      "/** case 'ABILITY_X': mentioned only in prose */",
      'function second() {',
      "  return 'ABILITY_X'",
      '}',
    ].join('\n')
    const slice = extractFunctionSlice(src, 'function first(')
    expect(slice).not.toContain('ABILITY_X')
    expect(slice).toContain('const s = "}"')
    expect(slice).toContain('  if (true) {')
    expect(slice).toContain('  }\n}')
  })

  it('a quoted // survives, a block comment is blanked, newlines are kept', () => {
    const src = [
      'function foo() {',
      "  const url = 'http://example.com/a//b'",
      "  /* 'ABILITY_Y' */",
      '  return url',
      '}',
    ].join('\n')
    const slice = extractFunctionSlice(src, 'function foo(')
    expect(slice).toContain("'http://example.com/a//b'")
    expect(slice).not.toContain('ABILITY_Y')
    expect(slice.split('\n').length).toBe(src.split('\n').length)
  })

  it('unbalanced braces throw, naming the declaration', () => {
    expect(() => extractFunctionSlice('function foo() { if (x) {', 'function foo(')).toThrow('function foo(')
  })
})

// ---------------------------------------------------------------------------
// Cycle 150i2 item 5: onRecoil only counts while runMoveEnd consumes both tables.
// ---------------------------------------------------------------------------

describe('Cycle 150i2 (5) - onRecoil requires the consuming loop', () => {
  it('control: the unmodified source matches the pinned set', () => {
    expect(extractRecoilAbilities(moveEndSource)).toEqual(PORTED_RECOIL_ABILITIES_SET)
  })

  it('dropping the divisor read inside runMoveEnd empties the set', () => {
    const mutated = dropLineContaining(moveEndSource, 'ON_RECOIL_DIVISORS[abilityId]')
    expect(extractRecoilAbilities(mutated)).toEqual(new Set())
  })

  it('dropping the loop type read empties the set even though the some() pre-check remains', () => {
    const mutated = dropLineContaining(moveEndSource, 'const types = ON_RECOIL_TYPES[abilityId]')
    expect(mutated).toContain('ON_RECOIL_TYPES[abilityId]') // the onRecoilHolders.some pre-check
    expect(extractRecoilAbilities(mutated)).toEqual(new Set())
  })
})

// ---------------------------------------------------------------------------
// Cycle 150i2 item 6: revive uses the shared comparison extractor; a predicate with no
// returning-true branch is an empty set rather than a module-load crash.
// ---------------------------------------------------------------------------

/**
 * `latchRecurringNightmareOnFaint` has exactly one positive ability comparison, so deleting it (or
 * turning it into `!==`) leaves `extractReviveAbilities` at its guarded "Zero labels" empty set.
 * Either outcome proves the branch is gone.
 */
function reviveDropped(mutated: string): boolean {
  try {
    return !extractReviveAbilities(mutated).has('ABILITY_RECURRING_NIGHTMARE')
  } catch (error) {
    expect(String(error)).toContain('Zero labels extracted')
    return true
  }
}

describe('Cycle 150i2 (6a) - extractReviveAbilities reads the shared branch evidence', () => {
  it('control: the unmodified turn.ts has the Recurring Nightmare branch', () => {
    expect(extractReviveAbilities(turnSource).has('ABILITY_RECURRING_NIGHTMARE')).toBe(true)
  })

  it('removing the branch drops Recurring Nightmare', () => {
    const mutated = removeBranch(turnSource, "if (abilityId === 'ABILITY_RECURRING_NIGHTMARE')")
    expect(reviveDropped(mutated)).toBe(true)
  })

  it('an inequality comparison is not a branch', () => {
    const mutated = turnSource.replace(
      "if (abilityId === 'ABILITY_RECURRING_NIGHTMARE')",
      "if (abilityId !== 'ABILITY_RECURRING_NIGHTMARE')",
    )
    expect(mutated).not.toBe(turnSource)
    expect(reviveDropped(mutated)).toBe(true)
  })
})

describe('Cycle 150i2 (6b) - a flag predicate with zero returning-true branches is empty', () => {
  it('removing the Chestnut Axe branch from isKeenEdgeMove does not throw', () => {
    expect(extractModifyMoveFlagsAbilities({ statusEffects: statusEffectsSource }, ['keenEdge']).has('ABILITY_CHESTNUT_AXE')).toBe(
      true,
    )
    const mutated = removeBranch(statusEffectsSource, "battlerHasSimAbility(state, attacker, 'ABILITY_CHESTNUT_AXE'")
    const extracted = extractModifyMoveFlagsAbilities({ statusEffects: mutated }, ['keenEdge'])
    expect(extracted.has('ABILITY_CHESTNUT_AXE')).toBe(false)
  })
})
