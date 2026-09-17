import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { lookupAbility } from './registry'
import { isUnmodelled } from './types'
import { REMAINING_ON_PRIORITY } from './impl/44-priority'
import './impl/index' // populates the registry as a side effect

// A SEPARATE gate from coverage.test.ts, deliberately.
//
// That one iterates abilityHooks.json's `damageRelevant` set, which 16 of the 19
// onPriority abilities are not in -- so it can neither see them nor be weakened
// by them. Rather than widen its population (which would move its "may only go
// down" number for a reason unrelated to damage), priority coverage gets its own
// gate with its own direction.
//
// Note what that does NOT mean: the damage gate continuing to report the same
// number after a registry change is not evidence the change was safe, since its
// population comes from committed hook data the change cannot touch. The
// argument is structural, and it is written out on OnPriorityContext.

const HOOKS_PATH = fileURLToPath(new URL('../../../../data/v2.65beta/abilityHooks.json', import.meta.url))
const abilityHooks: Record<string, { sourceLine: number; hooks?: Record<string, unknown> }> = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'))

const onPriorityIds = Object.entries(abilityHooks)
  .filter(([, a]) => a.hooks?.onPriority)
  .map(([id]) => id)

describe('onPriority coverage gate', () => {
  it('the census still holds 19 onPriority abilities out of 1016', () => {
    // Both numbers are cited in 44-priority.ts and turnOrder.ts. If a repin moves
    // either, those comments are stale and this fails first.
    expect(onPriorityIds).toHaveLength(19)
    expect(Object.keys(abilityHooks)).toHaveLength(1016)
  })

  it('every onPriority ability is either ported or on the remaining list, and never both', () => {
    // This is what stops REMAINING_ON_PRIORITY drifting: it has to account for
    // exactly the abilities that are not ported.
    const remaining = new Set(REMAINING_ON_PRIORITY.map((r) => r.id))
    const ported = onPriorityIds.filter((id) => {
      const entry = lookupAbility(id)
      return entry && !isUnmodelled(entry) && 'onPriority' in entry && entry.onPriority
    })

    expect(ported.filter((id) => remaining.has(id))).toEqual([])
    const unaccounted = onPriorityIds.filter((id) => !remaining.has(id) && !ported.includes(id))
    expect(unaccounted).toEqual([])
    expect(ported.length + remaining.size).toBe(onPriorityIds.length)
  })

  it('reports the ported count -- this number should only go UP', () => {
    const ported = onPriorityIds.filter((id) => {
      const entry = lookupAbility(id)
      return entry && !isUnmodelled(entry) && 'onPriority' in entry && entry.onPriority
    })
    // 0 -> 9 (batch AS: the 9 fielded by the 40 Elite boss fights -- 8 new
    // entries in 44-priority.ts plus Perfectionist's onPriority added to its
    // existing onCrit entry in batch O). A DECREASE means an ability lost its
    // hook; investigate rather than lowering this.
    expect(ported.length).toBeGreaterThanOrEqual(9)
  })

  it('every remaining entry cites the RIGHT source line and says what it needs', () => {
    // Comparing against the scraped sourceLine, not a shape regex. A regex only
    // proves the string looks like a citation, and the Perfectionist bug this
    // batch fixed was a perfectly well-formed citation pointing at a different
    // ability -- the exact defect a format check cannot see. All ten match
    // today, so this costs nothing now and catches drift after a repin.
    for (const r of REMAINING_ON_PRIORITY) {
      expect(onPriorityIds).toContain(r.id)
      expect(r.src).toBe(`src/abilities.cc:${abilityHooks[r.id].sourceLine}`)
      expect(r.needs.length).toBeGreaterThan(0)
    }
  })

  it('each ported entry cites the source line abilityHooks.json records', () => {
    // The Perfectionist entry was found citing a line belonging to a different
    // ability; this stops that recurring for the priority family.
    for (const id of onPriorityIds) {
      const entry = lookupAbility(id)
      if (!entry || isUnmodelled(entry) || !('onPriority' in entry) || !entry.onPriority) continue
      expect(entry.src).toBe(`src/abilities.cc:${abilityHooks[id].sourceLine}`)
    }
  })
})
