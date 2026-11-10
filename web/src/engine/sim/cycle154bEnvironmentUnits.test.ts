/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MONOCHAMP_RULE_SPECS,
  loadEngineProductionFiles,
  loadEngineTestFiles,
  loadMapScripts,
  runInventory,
  scanTrainerIds,
  type SourceFile,
} from './driver/environmentInventory'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const MONOCHAMP_MAP = 'EvergrandeCity_MonoChampRoom_1'
const LOAD_SIM_DATA = 'web/src/engine/sim/driver/loadSimData.ts'

const scripts = loadMapScripts()
const productionFiles = loadEngineProductionFiles()
const testFiles = loadEngineTestFiles()
const result = runInventory()

const monochampUnits = result.units.filter(
  (unit) => unit.kind === 'map-setup' && unit.key.startsWith('monochamp:'),
)

const classifyMonochamp = (files: SourceFile[]) =>
  runInventory({ productionFiles: files, testSources: testFiles }).units.filter(
    (unit) => unit.kind === 'map-setup' && unit.key.startsWith('monochamp:'),
  )

const replaceLoadSimData = (source: string): SourceFile[] =>
  productionFiles.map((file) =>
    file.file.endsWith(LOAD_SIM_DATA) ? { file: file.file, source } : file,
  )

describe('cycle 154b Monotype Champion rule-site units', () => {
  it('defines one unit per rule site, each citing a pinned C line that reads getMonotypeChampType', () => {
    // The brief enumerated the sites as 23 units; reading the C shows 27:
    // 19 battle_util.c + 2 battle_main.c + 3 abilities.cc + 3
    // battle_script_commands.c. REPORT.md records the difference.
    expect(MONOCHAMP_RULE_SPECS).toHaveLength(27)
    expect(new Set(MONOCHAMP_RULE_SPECS.map((spec) => spec.key)).size).toBe(27)

    for (const spec of MONOCHAMP_RULE_SPECS) {
      expect(spec.token).toBe('monotypeChampType')
      const match = spec.citation.match(/^(.*):(\d+)$/)
      expect(match, spec.key).not.toBeNull()
      if (!match) continue
      expect(match[1].startsWith('pipeline/.upstream/eliteredux-source/')).toBe(true)
      const lines = readFileSync(join(REPO_ROOT, match[1]), 'utf-8').split('\n')
      // Every cited line must contain the gate itself, including the
      // abilities.cc and battle_main.c:5824 units.
      expect(lines[Number(match[2]) - 1], spec.key).toContain('getMonotypeChampType')
    }
  })

  it('builds every rule site as an unported map-setup unit carrying the 18 champion ids', () => {
    // Derived from the map script, not a hand-written list.
    const expectedIds = scanTrainerIds(scripts, [MONOCHAMP_MAP])
    expect(expectedIds).toHaveLength(18)
    for (const id of expectedIds) expect(id.startsWith('TRAINER_MONOCHAMP_')).toBe(true)

    expect(monochampUnits).toHaveLength(MONOCHAMP_RULE_SPECS.length)
    expect(monochampUnits.map((unit) => unit.key).sort()).toEqual(
      MONOCHAMP_RULE_SPECS.map((spec) => spec.key).sort(),
    )
    for (const unit of monochampUnits) {
      expect(unit.status).toBe('unported')
      expect(unit.trainerIds).toEqual(expectedIds)
    }
  })

  it('flips every monochamp unit only when the driver assigns a non-null champion type', () => {
    const loadSimData = productionFiles.find((file) => file.file.endsWith(LOAD_SIM_DATA))
    expect(loadSimData).toBeDefined()
    if (!loadSimData) return

    // Baseline: loadSimData.ts hard-codes `monotypeChampType: null,`.
    expect(classifyMonochamp(productionFiles).every((unit) => unit.status === 'unported')).toBe(
      true,
    )

    const assignedSource = loadSimData.source.replace(
      /monotypeChampType\s*:\s*null,/,
      'monotypeChampType: pickType(row),',
    )
    expect(assignedSource).not.toBe(loadSimData.source)
    const assigned = classifyMonochamp(replaceLoadSimData(assignedSource))
    expect(assigned).toHaveLength(MONOCHAMP_RULE_SPECS.length)
    expect(assigned.every((unit) => unit.status === 'ported')).toBe(true)

    // The same text in a comment is stripped before evidence is checked.
    const commentedSource = loadSimData.source.replace(
      /monotypeChampType\s*:\s*null,/,
      '// monotypeChampType: pickType(row),',
    )
    expect(commentedSource).not.toBe(loadSimData.source)
    expect(classifyMonochamp(replaceLoadSimData(commentedSource)).every((unit) => unit.status === 'unported')).toBe(
      true,
    )

    // An assignment in a file outside the evidence's productionFiles is not proof.
    const outside = classifyMonochamp([
      ...productionFiles,
      { file: 'web/src/engine/sim/driver/syntheticChampion.ts', source: 'monotypeChampType: pickType(row),' },
    ])
    expect(outside.every((unit) => unit.status === 'unported')).toBe(true)
  })

  it('leaves the announcement unit and the allowlisted VAR_MONOTYPE_BOOST unit unchanged', () => {
    const announcement = result.units.find(
      (unit) => unit.kind === 'script-event' && unit.key === 'BattleScript_SetMonotypeEffect_Normal',
    )
    expect(announcement).toBeDefined()
    expect(announcement?.status).toBe('unported')
    expect(announcement?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:9682',
    )

    const boost = result.units.find(
      (unit) => unit.kind === 'map-setup' && unit.key === 'VAR_MONOTYPE_BOOST',
    )
    expect(boost).toBeDefined()
    expect(boost?.status).toBe('allowlisted')
    expect(boost?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/field_specials.c:4943',
    )
  })
})
