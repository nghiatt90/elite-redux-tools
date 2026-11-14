// Cycle 150ibch: the onCopyMove ported set is read from the `abilityId ===` comparisons inside
// `runCopyMoveHook` (`web/src/engine/sim/moveEnd.ts`), not from a hand-written literal, so
// deleting a branch makes the extractor (and the inventory that consumes it) lose that ability.
// The four C hooks are Dancer/Samba (`IsDance`, src/abilities.cc:3008-3013 / :9406-9409),
// Parroting (`IsSoundMove`, :6880-6887) and Lunar Affinity (the move's `lunar` flag, :8855-8860).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  ABILITY_HOOK_ALLOWLIST,
  PORTED_COPY_MOVE_ABILITIES,
  extractCopyMoveAbilities,
  isDirectlyPorted,
  loadTestMentionedAbilities,
  runInventory,
  type AbilityHookRecord,
} from './driver/abilityHookInventory'

const moveEndSource = readFileSync(new URL('moveEnd.ts', import.meta.url), 'utf8')
const HOOKS_PATH = fileURLToPath(new URL('../../../../data/v2.65beta/abilityHooks.json', import.meta.url))
const ENGINE_DIR = fileURLToPath(new URL('../', import.meta.url))

const abilityHooks: Record<string, AbilityHookRecord> = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'))

const ALL_FOUR = ['ABILITY_DANCER', 'ABILITY_LUNAR_AFFINITY', 'ABILITY_PARROTING', 'ABILITY_SAMBA']

function renameComparison(source: string, from: string, to: string): string {
  const mutated = source.replace(`abilityId === '${from}'`, `abilityId === '${to}'`)
  expect(mutated, `expected a comparison for ${from}`).not.toBe(source)
  return mutated
}

describe('Cycle 150ibch - extractCopyMoveAbilities reads runCopyMoveHook source text', () => {
  it('control: the unmodified moveEnd.ts yields exactly the four onCopyMove hooks', () => {
    expect([...extractCopyMoveAbilities(moveEndSource)].sort()).toEqual([...ALL_FOUR].sort())
  })

  it('renaming the Lunar Affinity branch drops only Lunar Affinity', () => {
    const mutated = renameComparison(moveEndSource, 'ABILITY_LUNAR_AFFINITY', 'MUTATED_LUNAR')
    const result = extractCopyMoveAbilities(mutated)
    expect(result.size).toBe(3)
    expect(result.has('ABILITY_LUNAR_AFFINITY')).toBe(false)
    expect(result.has('ABILITY_DANCER')).toBe(true)
    expect(result.has('ABILITY_PARROTING')).toBe(true)
    expect(result.has('ABILITY_SAMBA')).toBe(true)
  })

  it('renaming the Parroting branch drops only Parroting', () => {
    const mutated = renameComparison(moveEndSource, 'ABILITY_PARROTING', 'MUTATED_PARROTING')
    const result = extractCopyMoveAbilities(mutated)
    expect(result.size).toBe(3)
    expect(result.has('ABILITY_PARROTING')).toBe(false)
    expect(result.has('ABILITY_LUNAR_AFFINITY')).toBe(true)
  })

  it('renaming the Samba comparison drops only Samba (Dancer survives)', () => {
    const mutated = renameComparison(moveEndSource, 'ABILITY_SAMBA', 'MUTATED_SAMBA')
    const result = extractCopyMoveAbilities(mutated)
    expect(result.size).toBe(3)
    expect(result.has('ABILITY_SAMBA')).toBe(false)
    expect(result.has('ABILITY_DANCER')).toBe(true)
  })

  it('a comment mention inside the function is not a branch', () => {
    const renamed = renameComparison(moveEndSource, 'ABILITY_LUNAR_AFFINITY', 'MUTATED_LUNAR')
    const marker = '  const dancer = state.battlers[dancerId]'
    const withComment = renamed.replace(
      marker,
      `  // abilityId === 'ABILITY_LUNAR_AFFINITY'\n${marker}`,
    )
    expect(withComment).not.toBe(renamed)
    expect(extractCopyMoveAbilities(withComment).has('ABILITY_LUNAR_AFFINITY')).toBe(false)
  })

  it('the exported constant is that extraction and the inventory treats the four as ported', () => {
    // The constant is `extractCopyMoveAbilities()` over the live file, so the inventory cannot drift
    // from the source text. `runInventory` reads the module-level constant, not a caller-supplied
    // source, so a mutated copy cannot be fed through it (see REPORT.md); the mutation cases above
    // cover the extractor and this ties the constant to it.
    expect([...PORTED_COPY_MOVE_ABILITIES].sort()).toEqual([...extractCopyMoveAbilities(moveEndSource)].sort())
    for (const id of ALL_FOUR) {
      expect(isDirectlyPorted(id, 'onCopyMove')).toBe(true)
    }

    const mentioned = loadTestMentionedAbilities(ENGINE_DIR)
    const result = runInventory(abilityHooks, mentioned, ABILITY_HOOK_ALLOWLIST)
    const copyMove = result.classifications.filter((c) => c.hook === 'onCopyMove')
    expect(copyMove).toHaveLength(4)
    expect(copyMove.every((c) => c.status === 'ported')).toBe(true)
    expect(copyMove.map((c) => c.ability).sort()).toEqual([...ALL_FOUR].sort())
  })
})
