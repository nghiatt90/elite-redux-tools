/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_FLAG_SPECS,
  classifyToken,
  loadEngineProductionFiles,
  loadEngineTestFiles,
  runInventory,
} from './driver/environmentInventory'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const result = runInventory()
const productionFiles = loadEngineProductionFiles()
const testFiles = loadEngineTestFiles()

const NEW_UNITS = [
  { key: 'hellHeldItemClause', file: 'pokemon.c', identifier: 'DIFFICULTY_HELL' },
  { key: 'easyTrainerEvs', file: 'battle_main.c', identifier: 'DIFFICULTY_EASY' },
] as const

describe('cycle 153i missing difficulty gates', () => {
  it('adds both units as unported difficulty-flag units', () => {
    for (const { key } of NEW_UNITS) {
      const unit = result.units.find(
        (candidate) => candidate.kind === 'difficulty-flag' && candidate.key === key,
      )
      expect(unit, key).toBeDefined()
      expect(unit?.status).toBe('unported')
      // A name match must never mark a rule ported.
      expect(unit?.registeredUntested).toBe(false)
    }
  })

  it('cites a real C line holding the difficulty identifier', () => {
    for (const { key, file, identifier } of NEW_UNITS) {
      const unit = result.units.find(
        (candidate) => candidate.kind === 'difficulty-flag' && candidate.key === key,
      )
      expect(unit, key).toBeDefined()
      const match = unit?.citation.match(/^(.*):(\d+)$/)
      expect(match, key).not.toBeNull()
      if (!match) continue
      expect(match[1].endsWith(file), key).toBe(true)
      const lines = readFileSync(join(REPO_ROOT, match[1]), 'utf-8').split('\n')
      expect(lines[Number(match[2]) - 1], key).toContain(identifier)
    }
  })

  it('records the Easy gap on the ported gameDifficulty unit without changing its status', () => {
    const unit = result.units.find(
      (candidate) => candidate.kind === 'difficulty-flag' && candidate.key === 'gameDifficulty',
    )
    expect(unit).toBeDefined()
    expect(unit?.status).toBe('ported')
    expect(unit?.scope).toContain('DIFFICULTY_EASY is not modelled')
  })

  it('a production comment naming GetHeldItemIfNotDuplicate does not flip the unit to ported', () => {
    const spec = DIFFICULTY_FLAG_SPECS.find(
      (candidate) => candidate.key === 'hellHeldItemClause',
    )
    expect(spec).toBeDefined()
    if (!spec) return

    const baseline = classifyToken(spec.token, productionFiles, testFiles, spec.evidence)
    expect(baseline.status).toBe('unported')

    // classifyToken strips comments before matching, so a bare name in a comment
    // is not production evidence (the 153c/153d mutation shape).
    const commentOnly = productionFiles.map((file) =>
      file.file.endsWith('attackCanceller.ts')
        ? { file: file.file, source: `${file.source}\n// ${spec.token}\n` }
        : file,
    )
    const commented = classifyToken(spec.token, commentOnly, testFiles, spec.evidence)
    expect(commented.status).toBe('unported')
    expect(commented.registeredUntested).toBe(false)
  })
})
