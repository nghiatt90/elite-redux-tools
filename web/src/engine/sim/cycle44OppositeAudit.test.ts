/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SIM_DIR = resolve(import.meta.dirname)
const REPO_ROOT = resolve(SIM_DIR, '../../../..')
const DOC_PATH = join(REPO_ROOT, 'docs', 'battle-sim', 'doubles-opposite-audit.md')

export const OPPOSITE_REGEX = /\^ ?1\b/
export const C_CITATION_REGEX = /\.(c|cc|h|s|json):\d+/

export const VALID_CLASSES = new Set([
  'side-flip',
  'single-foe-by-design',
  'needs-all-foes',
  'needs-chosen-target',
  'singles-only-ai',
  'comment-only',
])

export interface ParsedTableRow {
  file: string
  line: number
  expression: string
  classLabel: string
  cCitation: string
  doublesFix: string
  note: string
}

export function getSimTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...getSimTsFiles(fullPath))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(fullPath)
    }
  }
  return files.sort()
}

export function countOppositeSitesInFile(content: string): number {
  return content.split('\n').filter((line) => OPPOSITE_REGEX.test(line)).length
}

export function splitMarkdownTableRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && !escaped) {
      escaped = true
      current += ch
    } else if (ch === '|' && !escaped) {
      cells.push(current)
      current = ''
    } else {
      escaped = false
      current += ch
    }
  }
  cells.push(current)
  return cells
    .map((c) => c.trim().replace(/\\\|/g, '|'))
    .slice(1, -1)
}

export function parseAuditTable(markdown: string): ParsedTableRow[] {
  const rows: ParsedTableRow[] = []
  const lines = markdown.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = splitMarkdownTableRow(trimmed)
    if (cells.length < 6) continue
    if (cells[0] === 'file:line' || cells[0].startsWith('---')) continue
    const fileLineMatch = cells[0].match(/^(.*?):(\d+)$/)
    if (!fileLineMatch) continue
    rows.push({
      file: fileLineMatch[1],
      line: Number(fileLineMatch[2]),
      expression: cells[1],
      classLabel: cells[2],
      cCitation: cells[3],
      doublesFix: cells[4],
      note: cells[5],
    })
  }
  return rows
}

export function compareCounts(
  fileCounts: Record<string, number>,
  tableRows: ParsedTableRow[],
): { matches: boolean; diffs: string[] } {
  const tableCounts: Record<string, number> = {}
  for (const row of tableRows) {
    tableCounts[row.file] = (tableCounts[row.file] ?? 0) + 1
  }
  const diffs: string[] = []
  const allFiles = new Set([...Object.keys(fileCounts), ...Object.keys(tableCounts)])
  for (const file of Array.from(allFiles).sort()) {
    const actual = fileCounts[file] ?? 0
    const inTable = tableCounts[file] ?? 0
    if (actual !== inTable) {
      diffs.push(`${file}: actual source ${actual} vs table ${inTable}`)
    }
  }
  return { matches: diffs.length === 0, diffs }
}

describe('cycle44 raw `^ 1` audit (dbl-3c)', () => {
  it('pure comparison helper detects mismatch on a synthetic table with missing rows (negative case)', () => {
    const syntheticFileCounts: Record<string, number> = {
      'web/src/engine/sim/turn.ts': 13,
      'web/src/engine/sim/escape.ts': 1,
    }
    const syntheticMarkdown = `
| file:line | expression (trimmed) | class | C citation (file:line) | doubles fix needed? | note |
| --- | --- | --- | --- | --- | --- |
| web/src/engine/sim/turn.ts:930 | \`const side = (attacker & 1) ^ 1\` | side-flip | battle_util.c:6364 | none | ok |
| web/src/engine/sim/escape.ts:79 | \`for (let opponentId = (battlerId & 1) ^ 1; ...)\` | side-flip | battle_util.c:4829 | none | ok |
`
    const parsed = parseAuditTable(syntheticMarkdown)
    const result = compareCounts(syntheticFileCounts, parsed)
    expect(result.matches).toBe(false)
    expect(result.diffs).toContain('web/src/engine/sim/turn.ts: actual source 13 vs table 1')
  })

  it('verifies that table rows match non-test .ts source counts per file', () => {
    const files = getSimTsFiles(SIM_DIR)
    const fileCounts: Record<string, number> = {}

    for (const filePath of files) {
      const relPath = relative(REPO_ROOT, filePath)
      const content = readFileSync(filePath, 'utf8')
      const count = countOppositeSitesInFile(content)
      if (count > 0) {
        fileCounts[relPath] = count
      }
    }

    const docContent = readFileSync(DOC_PATH, 'utf8')
    const tableRows = parseAuditTable(docContent)

    expect(tableRows.length).toBe(81)

    const comparison = compareCounts(fileCounts, tableRows)
    expect(comparison.diffs).toEqual([])
    expect(comparison.matches).toBe(true)
  })

  it('asserts every row has a valid class and required C citations', () => {
    const docContent = readFileSync(DOC_PATH, 'utf8')
    const tableRows = parseAuditTable(docContent)

    expect(tableRows.length).toBe(81)

    for (const row of tableRows) {
      expect(VALID_CLASSES.has(row.classLabel)).toBe(true)

      if (
        row.classLabel === 'single-foe-by-design' ||
        row.classLabel === 'needs-all-foes' ||
        row.classLabel === 'needs-chosen-target'
      ) {
        expect(row.cCitation).toBeTruthy()
        expect(C_CITATION_REGEX.test(row.cCitation)).toBe(true)
      }
    }
  })
})
