/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  MOVE_FLAG_CONSUMERS_WIRED,
  PORTED_MODIFY_MOVE_FLAGS_ABILITIES,
  extractModifyMoveFlagsAbilities,
  extractReactiveAbilities,
  isDirectlyPorted,
  type MoveFlagFamily,
} from './driver/abilityHookInventory'
import { POISON_PUPPETEER_CLONE_ABILITIES } from './statBuffs'

const statusEffectsSource = readFileSync(new URL('statusEffects.ts', import.meta.url), 'utf8')
const statBuffsSource = readFileSync(new URL('statBuffs.ts', import.meta.url), 'utf8')

/** Deletes exactly one source line; the result is not a program, which is fine for text extractors. */
function dropLineContaining(source: string, needle: string): string {
  const lines = source.split('\n')
  const kept = lines.filter((line) => !line.includes(needle))
  expect(kept.length, `expected exactly one line containing ${needle}`).toBe(lines.length - 1)
  return kept.join('\n')
}

/**
 * Removes the block whose header contains `marker` (from the marker through its matching `}`).
 * Copied from cycle150gInventory.test.ts: the source need not stay a valid program.
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
// Cycle 150i item 1: a flag predicate is not a port until its consumer is wired.
// ---------------------------------------------------------------------------

describe('Cycle 150i (1) - onModifyMoveFlags needs a wired consumer, not just a predicate branch', () => {
  it('ships an empty wired list, so no onModifyMoveFlags pair is ported', () => {
    expect(MOVE_FLAG_CONSUMERS_WIRED).toEqual([])
    expect(PORTED_MODIFY_MOVE_FLAGS_ABILITIES.size).toBe(0)
    expect(extractModifyMoveFlagsAbilities()).toEqual(PORTED_MODIFY_MOVE_FLAGS_ABILITIES)
  })

  it('Musical Notes stays unported with the empty default even though isSoundMove has its branch', () => {
    // The branch exists (the predicate mentions the ability) ...
    expect(statusEffectsSource).toContain("battlerHasSimAbility(state, attacker, 'ABILITY_MUSICAL_NOTES'")
    // ... but no consumer reads isSoundMove for the damage path, so it is not a port.
    expect(isDirectlyPorted('ABILITY_MUSICAL_NOTES', 'onModifyMoveFlags')).toBe(false)
    expect(extractModifyMoveFlagsAbilities().has('ABILITY_MUSICAL_NOTES')).toBe(false)
  })

  it('with SOUND wired, the extractor ports Musical Notes only while its branch exists', () => {
    const wired: readonly MoveFlagFamily[] = ['sound']
    expect(extractModifyMoveFlagsAbilities({}, wired).has('ABILITY_MUSICAL_NOTES')).toBe(true)

    const mutated = removeBranch(statusEffectsSource, "battlerHasSimAbility(state, attacker, 'ABILITY_MUSICAL_NOTES'")
    expect(extractModifyMoveFlagsAbilities({ statusEffects: mutated }, wired).has('ABILITY_MUSICAL_NOTES')).toBe(false)
  })

  it('a family that is not wired stays unported even with the branch present', () => {
    // Musical Notes grants only SOUND; wiring every other family does not port it.
    const wired: readonly MoveFlagFamily[] = ['kick', 'dance', 'keenEdge', 'megaLauncher']
    expect(extractModifyMoveFlagsAbilities({}, wired).has('ABILITY_MUSICAL_NOTES')).toBe(false)
  })

  it('a PUNCH-granting hook stays unported even when every other family is wired', () => {
    const allButPunch: readonly MoveFlagFamily[] = ['kick', 'sound', 'dance', 'keenEdge', 'megaLauncher']
    const ported = extractModifyMoveFlagsAbilities({}, allButPunch)
    // The seven non-PUNCH hooks are ported as a control ...
    expect([...ported].sort()).toEqual([
      'ABILITY_BACKSTREET_BOY',
      'ABILITY_CHESTNUT_AXE',
      'ABILITY_FESTIVITIES',
      'ABILITY_GUNMAN',
      'ABILITY_MUSICAL_NOTES',
      'ABILITY_REVERBATE',
      'ABILITY_TAEKKYEON',
    ])
    // ... and the three that grant PUNCH are not, because no sim predicate exists for PUNCH.
    for (const id of ['ABILITY_BRAWLING_WYVERN', 'ABILITY_JUNSHI_SANDA', 'ABILITY_MIXED_MARTIAL_ARTS']) {
      expect(ported.has(id), `${id} grants PUNCH`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Cycle 150i item 2: the clone contribution comes from case labels, not the gate set.
// ---------------------------------------------------------------------------

describe('Cycle 150i (2) - onReactive clone evidence is the real case labels', () => {
  const caseHandled = [
    'ABILITY_BLOOD_BATH',
    'ABILITY_CHOKEHOLD',
    'ABILITY_CRYOSTASIS',
    'ABILITY_ENTRANCE',
    'ABILITY_NEUROTOXIN',
    'ABILITY_POISON_PUPPETEER',
    'ABILITY_SET_ABLAZE',
  ]

  it('control: the unmutated source extracts all seven case-handled clone abilities', () => {
    const extracted = extractReactiveAbilities(statBuffsSource)
    for (const id of caseHandled) {
      expect(extracted.has(id), `${id} has a case label`).toBe(true)
    }
    // Frostbind and Hemotoxin are in the gate set but only reach the note-only branch.
    expect(POISON_PUPPETEER_CLONE_ABILITIES.has('ABILITY_FROSTBIND')).toBe(true)
    expect(POISON_PUPPETEER_CLONE_ABILITIES.has('ABILITY_HEMOTOXIN')).toBe(true)
    expect(extracted.has('ABILITY_FROSTBIND'), 'no case label').toBe(false)
    expect(extracted.has('ABILITY_HEMOTOXIN'), 'no case label').toBe(false)
  })

  it('deleting the Chokehold case block drops Chokehold and keeps Neurotoxin', () => {
    const mutated = removeBranch(statBuffsSource, "case 'ABILITY_CHOKEHOLD'")
    const extracted = extractReactiveAbilities(mutated)
    expect(extracted.has('ABILITY_CHOKEHOLD')).toBe(false)
    expect(extracted.has('ABILITY_NEUROTOXIN')).toBe(true)
    expect(extractReactiveAbilities(statBuffsSource).has('ABILITY_CHOKEHOLD')).toBe(true)
  })

  it('dropping the Set Ablaze case label drops Set Ablaze', () => {
    const mutated = dropLineContaining(statBuffsSource, "case 'ABILITY_SET_ABLAZE'")
    const extracted = extractReactiveAbilities(mutated)
    expect(extracted.has('ABILITY_SET_ABLAZE')).toBe(false)
    expect(extracted.has('ABILITY_BLOOD_BATH')).toBe(true)
    expect(extractReactiveAbilities(statBuffsSource).has('ABILITY_SET_ABLAZE')).toBe(true)
  })
})
