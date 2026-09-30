// holdEffectId() only throws on an unknown name when evaluated, so a typo in an
// unreached switch case or branch would go unnoticed. Scan the sources instead.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', '..', 'data', 'v2.65beta')
const ids = JSON.parse(readFileSync(join(DATA_DIR, 'holdEffectIds.json'), 'utf8')) as Record<string, number>

describe('HOLD_EFFECT_* literals in the AI sources', () => {
  for (const file of ['aiCheckViability.ts', 'aiCheckBadMove.ts', 'aiScorers.ts']) {
    it(`${file}: every quoted HOLD_EFFECT_* name exists in holdEffectIds.json`, () => {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8')
      const names = new Set([...source.matchAll(/'(HOLD_EFFECT_[A-Z0-9_]+)'/g)].map((m) => m[1]))
      expect(names.size).toBeGreaterThan(0)
      expect([...names].filter((n) => !(n in ids))).toEqual([])
    })
  }
})
