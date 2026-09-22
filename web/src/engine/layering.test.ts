import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `engine/` must not import from `lib/` or `features/`.
 *
 * The anti-drift note on SimDataContext guards one door -- someone adding a
 * loader where the loader would obviously go. This guards the other, which is
 * the likelier one: an engine module importing a type or helper from the layer
 * above because it is right there and the edit is in a hurry. That edit happens
 * in bridge.ts or in whatever file needs one more species field, and nobody
 * reads dataContext.ts's header on the way.
 *
 * The dependency runs one way and must keep doing so: `lib/moveData.ts` already
 * imports FROM engine, so an engine-to-lib import closes a cycle. It also breaks
 * the headless property the whole simulator rests on -- `features/` is React,
 * and `lib/` reaches the data snapshot.
 *
 * dataContext.ts's header says this property "was checked, not assumed". This
 * test is what keeps that sentence true after today.
 */

const ENGINE_DIR = fileURLToPath(new URL('.', import.meta.url))
const SELF = fileURLToPath(import.meta.url)

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTsFiles(full, out)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Matches the module specifier of any static import, `export ... from`, or
 * dynamic `import()`. Deliberately regex-based rather than AST-based: this needs
 * to be cheap and to keep working if the file fails to parse for other reasons. */
const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

function forbiddenImports(source: string): string[] {
  const bad: string[] = []
  for (const match of source.matchAll(SPECIFIER)) {
    const spec = match[1]
    // Only relative specifiers can escape the engine directory.
    if (!spec.startsWith('.')) continue
    if (/(^|\/)\.\.\/lib(\/|$)/.test(spec) || /(^|\/)\.\.\/features(\/|$)/.test(spec) || /(^|\/)\.\.\/routes(\/|$)/.test(spec)) {
      bad.push(spec)
    }
  }
  return bad
}

describe('engine layering', () => {
  const files = collectTsFiles(ENGINE_DIR)

  it('finds engine source files to check', () => {
    // Guards against the walk silently matching nothing, which would make every
    // assertion below vacuous.
    expect(files.length).toBeGreaterThan(20)
  })

  it('no file under engine/ imports from lib/, features/ or routes/', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (file === SELF) continue // its own example specifiers in the assertions below would match
      const bad = forbiddenImports(readFileSync(file, 'utf-8'))
      for (const spec of bad) offenders.push(`${file.slice(ENGINE_DIR.length)} imports ${spec}`)
    }
    expect(offenders).toEqual([])
  })

  it('detects a violation when one is present', () => {
    // The test above passes trivially if the matcher is broken, so prove the
    // matcher actually fires. Same reasoning as the bit-constant table: a check
    // whose detector is untested is a check that cannot fail.
    expect(forbiddenImports(`import type { Species } from '../lib/types'`)).toEqual(['../lib/types'])
    expect(forbiddenImports(`import { x } from '../../features/damageCalc/scenario'`)).toEqual(['../../features/damageCalc/scenario'])
    expect(forbiddenImports(`export { y } from '../lib/data'`)).toEqual(['../lib/data'])
    expect(forbiddenImports(`const m = await import('../lib/data')`)).toEqual(['../lib/data'])
    // ...and does not fire on legitimate imports.
    expect(forbiddenImports(`import { a } from './constants'`)).toEqual([])
    expect(forbiddenImports(`import { b } from '../types'`)).toEqual([])
    expect(forbiddenImports(`import { c } from 'vitest'`)).toEqual([])
    // A path that merely CONTAINS the word is not a layer escape.
    expect(forbiddenImports(`import { d } from './sublibrary/x'`)).toEqual([])
  })
})
