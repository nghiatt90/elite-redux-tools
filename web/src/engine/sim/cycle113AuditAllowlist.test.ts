/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import { AUDIT_ALLOWLIST, splitRows, validateAllowance, type AuditAllowance } from './driver/auditAllowlist'
import { loadSimData } from './driver/loadSimData'

const data = loadSimData()

function withAllowances<T>(entries: AuditAllowance[], fn: () => T): T {
  const len = AUDIT_ALLOWLIST.length
  try {
    AUDIT_ALLOWLIST.push(...entries)
    return fn()
  } finally {
    AUDIT_ALLOWLIST.length = len
  }
}

const allow = (effect: string, notes?: string[]): AuditAllowance => ({
  effect,
  reason: 'r',
  citation: 'x.c:1',
  ...(notes ? { notes } : {}),
})

describe('audit allowlist', () => {
  it('ships empty and counts everything', () => {
    expect(AUDIT_ALLOWLIST.length).toBe(0)
    const rows = [{ effect: 'E', notes: ['a'] }]
    const { counted, allowed } = splitRows(rows)
    expect(counted).toEqual(rows)
    expect(allowed).toEqual([])
  })

  it('a bare allowance covers every note of the effect', () => {
    withAllowances([allow('E')], () => {
      const { counted, allowed } = splitRows([{ effect: 'E', notes: ['a', 'b'] }])
      expect(counted).toEqual([])
      expect(allowed).toEqual([{ effect: 'E', notes: ['a', 'b'] }])
    })
  })

  it('a listed-notes allowance still counts a new note', () => {
    withAllowances([allow('E', ['a'])], () => {
      const { counted, allowed } = splitRows([{ effect: 'E', notes: ['a', 'b'] }])
      expect(counted).toEqual([{ effect: 'E', notes: ['b'] }])
      expect(allowed).toEqual([{ effect: 'E', notes: ['a'] }])
    })
  })

  it('leaves other effects untouched', () => {
    withAllowances([allow('E')], () => {
      const rows = [{ effect: 'F', notes: ['a'] }]
      const { counted, allowed } = splitRows(rows)
      expect(counted).toEqual(rows)
      expect(allowed).toEqual([])
    })
  })

  it('preserves order and extra fields', () => {
    withAllowances([allow('E', ['a'])], () => {
      const rows = [
        { effect: 'F', moves: ['m1'], bossUses: 3, notes: ['x'] },
        { effect: 'E', moves: ['m2'], bossUses: 2, notes: ['a', 'b'] },
        { effect: 'G', moves: ['m3'], bossUses: 1, notes: ['y'] },
      ]
      const { counted, allowed } = splitRows(rows)
      expect(counted).toEqual([rows[0], { ...rows[1], notes: ['b'] }, rows[2]])
      expect(allowed).toEqual([{ ...rows[1], notes: ['a'] }])
    })
  })

  it('every shipped entry is well formed, real and unique', () => {
    const effects = new Set<string>()
    for (const m of data.movesById.values() as Iterable<{ effect?: string | null }>) if (m.effect) effects.add(m.effect)
    const seen = new Set<string>()
    for (const a of AUDIT_ALLOWLIST) {
      expect(validateAllowance(a)).toEqual([])
      expect(effects.has(a.effect)).toBe(true)
      expect(seen.has(a.effect)).toBe(false)
      seen.add(a.effect)
    }
  })

  it('validateAllowance flags bad entries', () => {
    expect(validateAllowance({ effect: 'E', reason: '', citation: 'x.c:1' }).length).toBeGreaterThan(0)
    expect(validateAllowance({ effect: 'E', reason: 'r', citation: 'nowhere' }).length).toBeGreaterThan(0)
    expect(validateAllowance(allow('E'))).toEqual([])
  })
})
