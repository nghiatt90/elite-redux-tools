/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { extractModifyEffectChanceAbilities } from './driver/abilityHookInventory'

const statusEffectsSource = readFileSync(new URL('statusEffects.ts', import.meta.url), 'utf8')

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

// ---------------------------------------------------------------------------
// Cycle 150i3 (3) - onModifyEffectChance evidence comes only from the real dispatch
// blocks, not from the note-only guard above them.
// ---------------------------------------------------------------------------

describe('Cycle 150i3 (3) - getMoveEffectChance dispatch blocks are the only evidence', () => {
  it('control: the real source yields the 13 onModifyEffectChance ids', () => {
    const extracted = extractModifyEffectChanceAbilities(statusEffectsSource)
    expect(statusEffectsSource).toContain('ABILITY_CORRUPTED_MIND')
    expect(statusEffectsSource).toContain('ABILITY_PRECISE_FIST')
    expect(statusEffectsSource).toContain('ABILITY_WAY_OF_PRECISION')
    expect(extracted.size).toBe(13)
    expect(extracted.has('ABILITY_CORRUPTED_MIND')).toBe(true)
    expect(extracted.has('ABILITY_PRECISE_FIST')).toBe(true)
    expect(extracted.has('ABILITY_WAY_OF_PRECISION')).toBe(true)
  })

  it('deleting the real Corrupted Mind branch drops it even though the guard still names it', () => {
    // The marker omits the leading `}` so the preceding branch's closing brace is not eaten with it;
    // the whole-line text is still unique (`:1922` has `||` after the literal, no `else if`).
    const mutated = removeBranch(statusEffectsSource, "else if (abilityId === 'ABILITY_CORRUPTED_MIND') {")
    expect(mutated.length).toBeLessThan(statusEffectsSource.length)
    // The note-only guard outside both dispatch blocks still mentions the id; that is the point.
    expect(mutated).toContain("abilityId === 'ABILITY_CORRUPTED_MIND'")

    const extracted = extractModifyEffectChanceAbilities(mutated)
    expect(extracted.has('ABILITY_CORRUPTED_MIND')).toBe(false)
    expect(extracted.size).toBe(12)
  })

  it('dropping Precise Fist from the x5 comparison drops it and keeps Way of Precision', () => {
    const mutated = statusEffectsSource.replace(
      "} else if (abilityId === 'ABILITY_PRECISE_FIST' || abilityId === 'ABILITY_WAY_OF_PRECISION') {",
      "} else if (abilityId === 'ABILITY_WAY_OF_PRECISION') {",
    )
    expect(mutated).not.toBe(statusEffectsSource)

    const extracted = extractModifyEffectChanceAbilities(mutated)
    expect(extracted.has('ABILITY_PRECISE_FIST')).toBe(false)
    expect(extracted.has('ABILITY_WAY_OF_PRECISION')).toBe(true)
  })

  it('an id named only in the unmodelled.push guard outside the dispatch blocks is not evidence', () => {
    const guardOnly = 'ABILITY_SYNTHETIC_GUARD_ONLY'
    const mutated = statusEffectsSource.replace(
      "if (isAttacker && (abilityId === 'ABILITY_CORRUPTED_MIND'",
      `if (isAttacker && (abilityId === 'ABILITY_CORRUPTED_MIND' || abilityId === '${guardOnly}'`,
    )
    expect(mutated).not.toBe(statusEffectsSource)
    expect(mutated).toContain(guardOnly)

    expect(extractModifyEffectChanceAbilities(statusEffectsSource).has(guardOnly)).toBe(false)
    expect(extractModifyEffectChanceAbilities(mutated).has(guardOnly)).toBe(false)
  })

  it('a synthetic id added as a real branch in each dispatch block is extracted', () => {
    const attackerId = 'ABILITY_SYNTHETIC_DISPATCH_ATTACKER'
    const foeId = 'ABILITY_SYNTHETIC_DISPATCH_FOE'

    const withAttacker = statusEffectsSource.replace(
      '      if (isAttacker) {\n',
      `      if (isAttacker) {\n        if (abilityId === '${attackerId}') { chance *= 3 }\n`,
    )
    expect(withAttacker).not.toBe(statusEffectsSource)
    expect(extractModifyEffectChanceAbilities(withAttacker).has(attackerId)).toBe(true)

    const withFoe = statusEffectsSource.replace(
      '      if (isFoe) {\n',
      `      if (isFoe) {\n        if (abilityId === '${foeId}') { chance *= 3 }\n`,
    )
    expect(withFoe).not.toBe(statusEffectsSource)
    expect(extractModifyEffectChanceAbilities(withFoe).has(foeId)).toBe(true)
  })

  it('dropLineContaining still deletes the Thermomancy branch line', () => {
    const mutated = dropLineContaining(statusEffectsSource, "abilityId === 'ABILITY_THERMOMANCY'")
    expect(extractModifyEffectChanceAbilities(mutated).has('ABILITY_THERMOMANCY')).toBe(false)
    expect(extractModifyEffectChanceAbilities(statusEffectsSource).has('ABILITY_THERMOMANCY')).toBe(true)
  })
})
