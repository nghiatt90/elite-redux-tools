import { describe, expect, it } from 'vitest'
import {
  APPLY_ON_ALLY,
  APPLY_ON_ALLY_ONLY,
  APPLY_ON_ANY,
  APPLY_ON_FOE,
  APPLY_ON_OTHER,
  APPLY_ON_SELF,
  isApplyOnFlagAppropriate,
  isTargettedApplyOnFlagAppropriate,
} from './applyOn'

describe('bitflag constants (include/abilities.hh:143-152)', () => {
  it('the composite flags are exactly the documented bit unions', () => {
    expect(APPLY_ON_SELF).toBe(0)
    expect(APPLY_ON_ALLY).toBe(1)
    expect(APPLY_ON_ALLY_ONLY).toBe(5)
    expect(APPLY_ON_FOE).toBe(6)
    expect(APPLY_ON_ANY).toBe(3)
    expect(APPLY_ON_OTHER).toBe(7)
  })
})

describe('isApplyOnFlagAppropriate', () => {
  it('APPLY_ON_SELF fires only for the ability holder itself', () => {
    expect(isApplyOnFlagAppropriate(true, false, APPLY_ON_SELF)).toBe(true)
    expect(isApplyOnFlagAppropriate(false, false, APPLY_ON_SELF)).toBe(false)
    expect(isApplyOnFlagAppropriate(false, true, APPLY_ON_SELF)).toBe(false)
  })

  it('APPLY_ON_ALLY fires for allies, not self, not foes', () => {
    expect(isApplyOnFlagAppropriate(false, true, APPLY_ON_ALLY)).toBe(true)
    expect(isApplyOnFlagAppropriate(false, false, APPLY_ON_ALLY)).toBe(false) // foe
    expect(isApplyOnFlagAppropriate(true, false, APPLY_ON_ALLY)).toBe(true) // no IGNORE_SELF bit -> self also passes
  })

  it('APPLY_ON_ALLY_ONLY excludes self via the IGNORE_SELF bit', () => {
    expect(isApplyOnFlagAppropriate(false, true, APPLY_ON_ALLY_ONLY)).toBe(true)
    expect(isApplyOnFlagAppropriate(true, false, APPLY_ON_ALLY_ONLY)).toBe(false)
  })

  it('APPLY_ON_FOE fires only for the opposing side', () => {
    expect(isApplyOnFlagAppropriate(false, false, APPLY_ON_FOE)).toBe(true)
    expect(isApplyOnFlagAppropriate(false, true, APPLY_ON_FOE)).toBe(false)
    expect(isApplyOnFlagAppropriate(true, false, APPLY_ON_FOE)).toBe(false) // IGNORE_SELF bit set
  })

  it('APPLY_ON_ANY fires for self, ally, or foe', () => {
    expect(isApplyOnFlagAppropriate(true, false, APPLY_ON_ANY)).toBe(true)
    expect(isApplyOnFlagAppropriate(false, true, APPLY_ON_ANY)).toBe(true)
    expect(isApplyOnFlagAppropriate(false, false, APPLY_ON_ANY)).toBe(true)
  })

  it('APPLY_ON_OTHER fires for ally or foe but excludes self', () => {
    expect(isApplyOnFlagAppropriate(true, false, APPLY_ON_OTHER)).toBe(false)
    expect(isApplyOnFlagAppropriate(false, true, APPLY_ON_OTHER)).toBe(true)
    expect(isApplyOnFlagAppropriate(false, false, APPLY_ON_OTHER)).toBe(true)
  })

  it('defaults to APPLY_ON_SELF when unset, matching the C struct field default of 0', () => {
    expect(isApplyOnFlagAppropriate(true, false)).toBe(true)
    expect(isApplyOnFlagAppropriate(false, false)).toBe(false)
  })
})

describe('isTargettedApplyOnFlagAppropriate', () => {
  it('APPLY_ON_ATTACKER_OR_TARGET fires for either named battler', () => {
    expect(isTargettedApplyOnFlagAppropriate(true, false, false, false, 'APPLY_ON_ATTACKER_OR_TARGET')).toBe(true)
    expect(isTargettedApplyOnFlagAppropriate(false, true, false, false, 'APPLY_ON_ATTACKER_OR_TARGET')).toBe(true)
    expect(isTargettedApplyOnFlagAppropriate(false, false, false, false, 'APPLY_ON_ATTACKER_OR_TARGET')).toBe(false)
  })

  it('APPLY_ON_ATTACKER / APPLY_ON_TARGET are exclusive', () => {
    expect(isTargettedApplyOnFlagAppropriate(true, false, false, false, 'APPLY_ON_ATTACKER')).toBe(true)
    expect(isTargettedApplyOnFlagAppropriate(false, true, false, false, 'APPLY_ON_ATTACKER')).toBe(false)
    expect(isTargettedApplyOnFlagAppropriate(false, true, false, false, 'APPLY_ON_TARGET')).toBe(true)
  })

  it('falls back to the plain self/ally/foe filter for numeric flags', () => {
    expect(isTargettedApplyOnFlagAppropriate(false, false, true, false, APPLY_ON_SELF)).toBe(true)
    expect(isTargettedApplyOnFlagAppropriate(false, false, false, false, APPLY_ON_FOE)).toBe(true)
  })
})
