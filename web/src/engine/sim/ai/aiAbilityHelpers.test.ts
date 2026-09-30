import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const AI_DIR = import.meta.dirname

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const m of src.matchAll(/^(?:import|export)\b[^'"]*?from\s+'(\.[^']+)'/gm)) {
    const base = resolve(dirname(file), m[1])
    const target = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((p) => existsSync(p))
    if (target) out.push(target)
  }
  return out
}

function reachable(start: string): Set<string> {
  const seen = new Set<string>()
  const stack = [start]
  while (stack.length) {
    const f = stack.pop() as string
    for (const dep of importsOf(f)) {
      if (!seen.has(dep)) {
        seen.add(dep)
        stack.push(dep)
      }
    }
  }
  return seen
}

const helpers = join(AI_DIR, 'aiAbilityHelpers.ts')
const scorers = join(AI_DIR, 'aiScorers.ts')
const badMove = join(AI_DIR, 'aiCheckBadMove.ts')

describe('ai ability helpers module graph', () => {
  it('aiAbilityHelpers does not reach aiScorers or aiCheckBadMove', () => {
    const deps = reachable(helpers)
    expect(deps.has(scorers)).toBe(false)
    expect(deps.has(badMove)).toBe(false)
  })

  it('aiScorers does not reach aiCheckBadMove (no cycle between the two)', () => {
    expect(reachable(scorers).has(badMove)).toBe(false)
  })

  it('the import scan sees aiCheckBadMove reaching aiScorers', () => {
    expect(reachable(badMove).has(scorers)).toBe(true)
  })
})
