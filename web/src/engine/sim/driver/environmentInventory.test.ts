/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BATTLE_TYPE_SPECS,
  DEFAULT_ALLOWLIST,
  DIFFICULTY_FLAG_SPECS,
  ENVIRONMENT_INVENTORY_DOC_PATH,
  MAP_SETUP_SPECS,
  TRAINER_FLAG_SPECS,
  battleEventEvidence,
  classifyToken,
  generateEnvironmentInventoryDoc,
  hasLiveCaseBody,
  hellTrainerSkillEvidence,
  isValidAllowlistCitation,
  loadBattleEventRows,
  loadEngineProductionFiles,
  loadEngineTestFiles,
  loadMapScripts,
  loadTrainers,
  parseHellTrainerSkills,
  runInventory,
  scanMapScripts,
  testFileAssertsToken,
  validateAllowlist,
  type EnvironmentAllowlistEntry,
  type MapScript,
  type MapSetupSpec,
  type SourceFile,
} from './environmentInventory'

const scripts = loadMapScripts()
const trainers = loadTrainers()
const battleEvents = loadBattleEventRows()
const result = runInventory()

const MAP_SCRIPT_COUNT = 515
const MAPS_WITH_SETUP = 22
const TRAINER_COUNT = 932
const BATTLE_EVENT_ROWS = 51
const DISTINCT_BATTLE_EVENTS = 34

const MAP_SETUP_UNITS = 30
const BATTLE_TYPE_UNITS = 5
const DIFFICULTY_FLAG_UNITS = 16
const TRAINER_FLAG_UNITS = 14
const HELL_TRAINER_SKILL_UNITS = 29
const BATTLE_EVENT_UNITS = 34
const SCRIPT_EVENT_UNITS = 6

/**
 * Pinned count of unported units. Rises from 44 to 82 in cycle 153d because
 * false allowlist (setweather) and false absence claims (hell_trainer_skills.h)
 * were removed, adding 1 (setweather) + 4 (map headers) + 4 (script setweathers)
 * + 29 (hell skills) = 38 unported units. Rises 82 -> 89 in cycle 153e because
 * seven Hell/difficulty battle rules the inventory could not see were added as
 * difficulty-flag units; none is ported. The rise is the point: missing rules
 * must show up as unported rather than stay invisible.
 */
export const UNPORTED_UNIT_COUNT = 89

/** Pinned today -- this number should only go DOWN. */
export const REGISTERED_UNTESTED_UNIT_COUNT = 9

/** Pinned today -- this number should only go DOWN. */
export const UNCLASSIFIED_UNIT_COUNT = 0

const FABRICATED_TOKEN = 'FABRICATED_BATTLE_SETUP'
const FABRICATED_SCRIPTS: MapScript[] = [
  {
    map: 'FabricatedTown',
    file: 'pipeline/.upstream/eliteredux-source/data/maps/FabricatedTown/scripts.pory',
    source: 'script FabricatedTown_EventScript_Setup {\n\tsetvar(FABRICATED_BATTLE_SETUP, 1)\n}\n',
  },
]
const FABRICATED_SPEC: MapSetupSpec = {
  key: FABRICATED_TOKEN,
  token: FABRICATED_TOKEN,
  site: 'FabricatedSetup',
  citation: 'pipeline/.upstream/eliteredux-source/src/battle_util.c:9144',
}
const SYNTHETIC_OPTIONS = {
  mapScripts: FABRICATED_SCRIPTS,
  trainers: [],
  battleEventRows: [],
  productionSource: '',
  testSources: [],
  allowlist: [] as EnvironmentAllowlistEntry[],
  extraMapSetupSpecs: [FABRICATED_SPEC],
}

describe('environment and scripted-condition completeness inventory', () => {
  it('scans the map scripts and anchors the 22 maps that contain a battle setup token', () => {
    expect(scripts).toHaveLength(MAP_SCRIPT_COUNT)
    const scan = scanMapScripts(scripts)
    expect(scan.maps).toHaveLength(MAPS_WITH_SETUP)
    expect(result.mapFileCount).toBe(MAP_SCRIPT_COUNT)
    expect(result.mapsWithSetup).toBe(MAPS_WITH_SETUP)
    expect(scan.maps).toEqual([
      'AshenWoods',
      'BirthIsland_Exterior',
      'EverGrandeCity_ChampionsRoom',
      'EvergrandeCity_MonoChampRoom_1',
      'FarawayIsland_Entrance',
      'JaggedPass',
      'LilycoveCity',
      'MeteorFalls_HaxorusRoom',
      'MossdeepCity_Gym',
      'MtPyre_Exterior',
      'NavelRock_Top',
      'PetalburgWoods_BreloomRoom',
      'Route111',
      'Route113',
      'Route114',
      'Route120',
      'Route128',
      'Route132',
      'SeafloorCavern_Room9',
      'Seaspray_Cave_B1F',
      'SkyPillar_Outside',
      'SootopolisCity',
    ])
  })

  it('loads 932 trainers and the true battleEvents row count', () => {
    expect(trainers).toHaveLength(TRAINER_COUNT)
    expect(result.trainerCount).toBe(TRAINER_COUNT)
    expect(battleEvents).toHaveLength(BATTLE_EVENT_ROWS)
    expect(result.battleEventRowCount).toBe(BATTLE_EVENT_ROWS)
    expect(new Set(battleEvents.map((row) => row.event)).size).toBe(DISTINCT_BATTLE_EVENTS)
    expect(result.distinctBattleEventCount).toBe(DISTINCT_BATTLE_EVENTS)
  })

  it('enumerates every unit kind', () => {
    const count = (kind: string) => result.units.filter((unit) => unit.kind === kind).length
    expect(count('map-setup')).toBe(MAP_SETUP_UNITS)
    expect(count('battle-type')).toBe(BATTLE_TYPE_UNITS)
    expect(count('difficulty-flag')).toBe(DIFFICULTY_FLAG_UNITS)
    expect(count('trainer-flag')).toBe(TRAINER_FLAG_UNITS)
    expect(count('hell-trainer-skill')).toBe(HELL_TRAINER_SKILL_UNITS)
    expect(count('battle-event')).toBe(BATTLE_EVENT_UNITS)
    expect(count('script-event')).toBe(SCRIPT_EVENT_UNITS)
  })

  it('classifies every unit exactly once as ported / unported / unclassified / allowlisted', () => {
    expect(result.totalDefined).toBe(result.units.length)
    expect(
      result.totalPorted + result.totalUnported + result.totalUnclassified + result.totalAllowlisted,
    ).toBe(result.totalDefined)
    for (const unit of result.units) {
      expect(['ported', 'unported', 'unclassified', 'allowlisted']).toContain(unit.status)
      if (unit.status === 'unported') {
        // registered-but-untested is a sub-count of unported, never a separate status.
        expect(typeof unit.registeredUntested).toBe('boolean')
      } else {
        expect(unit.registeredUntested).toBe(false)
      }
    }
    for (const summary of result.summaries) {
      expect(summary.ported + summary.unported + summary.unclassified + summary.allowlisted).toBe(
        summary.defined,
      )
      expect(summary.registeredUntested).toBeLessThanOrEqual(summary.unported)
    }
    // Every unit key is unique per kind, so no unit is counted twice.
    expect(new Set(result.units.map((unit) => `${unit.kind}:${unit.key}`)).size).toBe(
      result.totalDefined,
    )
  })

  it('reports the current unported unit count -- this number should only go DOWN', () => {
    expect(result.totalUnported).toBe(UNPORTED_UNIT_COUNT)
  })

  it('reports the current registered-but-untested unit count -- this number should only go DOWN', () => {
    expect(result.totalRegisteredUntested).toBe(REGISTERED_UNTESTED_UNIT_COUNT)
  })

  it('reports the current unclassified unit count -- this number should only go DOWN', () => {
    expect(result.totalUnclassified).toBe(UNCLASSIFIED_UNIT_COUNT)
  })

  it('validates every allowlist citation format', () => {
    expect(DEFAULT_ALLOWLIST.length).toBe(7)
    for (const entry of DEFAULT_ALLOWLIST) {
      expect(isValidAllowlistCitation(entry.cite)).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(0)
    }
    expect(validateAllowlist(DEFAULT_ALLOWLIST)).toEqual([])
    // Every allowlisted unit's committed citation is the allowlist cite.
    for (const entry of DEFAULT_ALLOWLIST) {
      const unit = result.units.find((candidate) => candidate.key === entry.key)
      expect(unit?.status).toBe('allowlisted')
      expect(unit?.citation).toBe(entry.cite)
    }
  })

  it('negative (a): a fabricated map-setup unit with no sim token is unported', () => {
    const baseline = runInventory(SYNTHETIC_OPTIONS)
    const unit = baseline.units.find(
      (candidate) => candidate.kind === 'map-setup' && candidate.key === FABRICATED_TOKEN,
    )
    expect(unit?.token).toBe(FABRICATED_TOKEN)
    expect(unit?.status).toBe('unported')
    expect(unit?.registeredUntested).toBe(false)
    expect(unit?.testFile).toBeNull()
  })

  it('negative (b): a token in source but not in tests is unported + registeredUntested', () => {
    const registered = runInventory({ ...SYNTHETIC_OPTIONS, productionSource: FABRICATED_TOKEN })
    const unit = registered.units.find(
      (candidate) => candidate.kind === 'map-setup' && candidate.key === FABRICATED_TOKEN,
    )
    expect(unit?.status).toBe('unported')
    expect(unit?.registeredUntested).toBe(true)

    // The same token named in a test becomes ported.
    const both = runInventory({
      ...SYNTHETIC_OPTIONS,
      productionSource: FABRICATED_TOKEN,
      testSources: [
        { file: 'web/src/engine/sim/fabricated.test.ts', source: FABRICATED_TOKEN },
      ],
    })
    const ported = both.units.find(
      (candidate) => candidate.kind === 'map-setup' && candidate.key === FABRICATED_TOKEN,
    )
    expect(ported?.status).toBe('ported')
    expect(ported?.testFile).toBe('web/src/engine/sim/fabricated.test.ts')
  })

  it('negative (c): features really handled and tested today are ported; name-only matches are not', () => {
    // `BATTLE_TYPE_TRAINER` is a real port: the driver starts every session as a
    // trainer battle (`session.ts:238`, matching `battle_setup.c:1242`), and the
    // AI tests build states with that flag.
    const trainerBattle = result.units.find(
      (candidate) => candidate.kind === 'battle-type' && candidate.key === 'BATTLE_TYPE_TRAINER',
    )
    expect(trainerBattle?.status).toBe('ported')
    expect(trainerBattle?.testFile).not.toBeNull()

    // `speedDown` is only named: C zeroes the Speed IV with `if (speedDown)
    // speedIV = 0;` (`src/pokemon.c:994`), and production does implement it
    // (`stats.ts:93`, `buildParty.ts:99`), but every engine test fixture sets
    // `speedDown: false` / `ironPill: false` and asserts nothing about Speed.
    // Registered, untested -- not ported.
    const speedDown = result.units.find(
      (candidate) => candidate.kind === 'difficulty-flag' && candidate.key === 'speedDown',
    )
    expect(speedDown?.status).toBe('unported')
    expect(speedDown?.registeredUntested).toBe(true)

    // `BATTLE_TYPE_DOUBLE` is only named: C sets it when two trainers approach
    // (`src/battle_setup.c:1240`), but the driver's `session.ts:238` sets
    // `BATTLE_TYPE_TRAINER` alone and `aiCheckBadMove.ts:28` records that
    // `battleTypeFlags` never carries the double bit in this build. A test that
    // pokes the constant on a hand-built state does not port double battles.
    const doubleBattle = result.units.find(
      (candidate) => candidate.kind === 'battle-type' && candidate.key === 'BATTLE_TYPE_DOUBLE',
    )
    expect(doubleBattle?.status).toBe('unported')
    expect(doubleBattle?.registeredUntested).toBe(false)

    // `forcedDouble` is only named: the codegen emits `doubleBattle = TRUE`
    // (`TrainerPartyGenerator.kt:207`), but the engine only ORs
    // `AI_FLAG_DOUBLE_BATTLE` in `aiFlags.ts`. Nothing outside it changes the
    // number of active battlers, so the fight is still singles -- unmodelled.
    const forcedDouble = result.units.find(
      (candidate) => candidate.kind === 'trainer-flag' && candidate.key === 'forcedDouble',
    )
    expect(forcedDouble?.status).toBe('unported')
    expect(forcedDouble?.registeredUntested).toBe(false)
  })

  it('negative (d): an allowlist entry without an exact file:line cite is rejected', () => {
    expect(
      isValidAllowlistCitation('pipeline/.upstream/eliteredux-source/src/battle_util.c:9144'),
    ).toBe(true)
    expect(isValidAllowlistCitation('pipeline/.upstream/eliteredux-source/src/battle_util.c')).toBe(
      false,
    )
    expect(isValidAllowlistCitation('battle_util.c:not-a-line')).toBe(false)

    const bad: EnvironmentAllowlistEntry[] = [{ key: 'x', reason: 'because', cite: 'battle_util.c' }]
    expect(validateAllowlist(bad).length).toBeGreaterThan(0)
    expect(() => runInventory({ ...SYNTHETIC_OPTIONS, allowlist: bad })).toThrow()

    const good: EnvironmentAllowlistEntry[] = [
      {
        key: FABRICATED_TOKEN,
        reason: 'quoted C line is inert',
        cite: 'pipeline/.upstream/eliteredux-source/src/battle_util.c:9144',
      },
    ]
    const allowlisted = runInventory({ ...SYNTHETIC_OPTIONS, allowlist: good })
    const unit = allowlisted.units.find(
      (candidate) => candidate.kind === 'map-setup' && candidate.key === FABRICATED_TOKEN,
    )
    expect(unit?.status).toBe('allowlisted')
    expect(unit?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_util.c:9144')
  })

  it('negative (e): evidence requirements make a name-only match insufficient', () => {
    const patternedSpec: MapSetupSpec = {
      ...FABRICATED_SPEC,
      evidence: { testPattern: /FABRICATED_BATTLE_SETUP\s*:\s*true/ },
    }
    const runWith = (options: Parameters<typeof runInventory>[0]) =>
      runInventory(options).units.find((unit) => unit.key === FABRICATED_TOKEN)

    // The token is in production and in a test, but the test sets it false --
    // the same shape as `speedDown: false` in every current engine fixture.
    const nameOnly = runWith({
      ...SYNTHETIC_OPTIONS,
      productionSource: FABRICATED_TOKEN,
      extraMapSetupSpecs: [patternedSpec],
      testSources: [
        { file: 'web/src/engine/sim/fabricated.test.ts', source: `${FABRICATED_TOKEN}: false` },
      ],
    })
    expect(nameOnly?.status).toBe('unported')
    expect(nameOnly?.registeredUntested).toBe(true)

    const behaviour = runWith({
      ...SYNTHETIC_OPTIONS,
      productionSource: FABRICATED_TOKEN,
      extraMapSetupSpecs: [patternedSpec],
      testSources: [
        { file: 'web/src/engine/sim/fabricated.test.ts', source: `${FABRICATED_TOKEN}: true` },
      ],
    })
    expect(behaviour?.status).toBe('ported')

    // Production can be scoped to the files that actually run the unit. A
    // mention in a unit-level helper (the `aiFlags.ts` case) is not evidence.
    const scopedSpec: MapSetupSpec = {
      ...FABRICATED_SPEC,
      evidence: { productionFiles: ['web/src/engine/sim/driver/session.ts'] },
    }
    const helperOnly = runWith({
      ...SYNTHETIC_OPTIONS,
      productionFiles: [
        { file: 'web/src/engine/sim/ai/aiFlags.ts', source: FABRICATED_TOKEN },
      ],
      extraMapSetupSpecs: [scopedSpec],
      testSources: [{ file: 'web/src/engine/sim/fabricated.test.ts', source: FABRICATED_TOKEN }],
    })
    expect(helperOnly?.status).toBe('unported')

    const driverPath = runWith({
      ...SYNTHETIC_OPTIONS,
      productionFiles: [
        { file: 'web/src/engine/sim/driver/session.ts', source: FABRICATED_TOKEN },
      ],
      extraMapSetupSpecs: [scopedSpec],
      testSources: [{ file: 'web/src/engine/sim/fabricated.test.ts', source: FABRICATED_TOKEN }],
    })
    expect(driverPath?.status).toBe('ported')
  })

  it('anchors three hand-derived citations read in the C', () => {
    const unitFor = (kind: string, key: string) =>
      result.units.find((unit) => unit.kind === kind && unit.key === key)

    expect(unitFor('map-setup', 'FLAG_TOTEM_BATTLE')?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_util.c:9144',
    )
    expect(unitFor('difficulty-flag', 'HELL_MODE_EXTRA_LEVELS_FLAG')?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_main.c:1805',
    )
    expect(unitFor('map-setup', 'VAR_TRAINER_PRIZE_BP')?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:5809',
    )
  })

  it('lists only trainer ids that exist in trainers.json for every map-setup unit', () => {
    const known = new Set(trainers.map((trainer) => trainer.id))
    for (const unit of result.units.filter((candidate) => candidate.kind === 'map-setup')) {
      for (const id of unit.trainerIds) expect(known.has(id)).toBe(true)
    }
    // The monotype course is the densest map-setup scope; it must list real ids.
    const fieldId = result.units.find(
      (candidate) => candidate.kind === 'map-setup' && candidate.key === 'VAR_BATTLE_FIELD_ID',
    )
    expect(fieldId?.trainerIds.length).toBeGreaterThan(0)
  })

  it('generates deterministic markdown and compares it with the committed doc (or writes with SIM_INVENTORY_WRITE=1)', () => {
    const generated = generateEnvironmentInventoryDoc(result)
    expect(generateEnvironmentInventoryDoc(result)).toBe(generated)

    if (process.env.SIM_INVENTORY_WRITE === '1') {
      writeFileSync(ENVIRONMENT_INVENTORY_DOC_PATH, generated, 'utf-8')
      console.log(`Wrote environment inventory doc to ${ENVIRONMENT_INVENTORY_DOC_PATH}`)
    }

    expect(existsSync(ENVIRONMENT_INVENTORY_DOC_PATH)).toBe(true)
    expect(readFileSync(ENVIRONMENT_INVENTORY_DOC_PATH, 'utf-8')).toBe(generated)
  })
})

describe('trainer-flag evidence', () => {
  const productionFiles = loadEngineProductionFiles()
  const testFiles = loadEngineTestFiles()

  const PORTED_TRAINER_FLAG_KEYS = [
    'preferStall',
    'preferStatus',
    'AI_FLAG_TRY_TO_FAINT',
    'AI_FLAG_SMART_SWITCHING',
  ] as const

  for (const key of PORTED_TRAINER_FLAG_KEYS) {
    it(`classifies ${key} as ported on unmutated production files, and unported when the cited read line is removed`, () => {
      const spec = TRAINER_FLAG_SPECS.find((s) => s.key === key)
      expect(spec).toBeDefined()
      if (!spec) return

      const initial = classifyToken(spec.token, productionFiles, testFiles, spec.evidence)
      expect(initial.status).toBe('ported')

      expect(spec.evidence?.productionLinePattern).toBeDefined()
      const pattern = spec.evidence!.productionLinePattern!

      // Filter out any line matching the production line pattern from all production files
      const mutatedFiles: SourceFile[] = productionFiles.map((file) => ({
        file: file.file,
        source: file.source
          .split('\n')
          .filter((line) => !pattern.test(line))
          .join('\n'),
      }))

      const mutated = classifyToken(spec.token, mutatedFiles, testFiles, spec.evidence)
      expect(mutated.status).not.toBe('ported')
    })
  }

  it('rejects aiFlags.ts alone as insufficient production evidence for trainer flags', () => {
    for (const key of PORTED_TRAINER_FLAG_KEYS) {
      const spec = TRAINER_FLAG_SPECS.find((s) => s.key === key)!
      const classification = classifyToken(
        spec.token,
        [{ file: 'web/src/engine/sim/ai/aiFlags.ts', source: spec.token }],
        testFiles,
        spec.evidence,
      )
      expect(classification.status).toBe('unported')
    }
  })

  it('flips forcedDouble to ported when a production file outside aiFlags.ts writes battlersCount', () => {
    const spec = TRAINER_FLAG_SPECS.find((s) => s.key === 'forcedDouble')!
    const realClassification = classifyToken(spec.token, productionFiles, testFiles, spec.evidence)
    expect(realClassification.status).toBe('unported')
    expect(realClassification.registeredUntested).toBe(false)

    // Synthetic production file where battlersCount is set based on forcedDouble
    const syntheticFiles: SourceFile[] = [
      ...productionFiles,
      {
        file: 'web/src/engine/sim/driver/syntheticDouble.ts',
        source: 'const battlersCount = trainer.forcedDouble ? 4 : 2\n',
      },
    ]

    const syntheticClassification = classifyToken(
      spec.token,
      syntheticFiles,
      testFiles,
      spec.evidence,
    )
    expect(syntheticClassification.status).toBe('ported')
  })
})

describe('step 1: non-trainer-flag evidence', () => {
  const productionFiles = loadEngineProductionFiles()
  const testFiles = loadEngineTestFiles()

  it('1. BATTLE_TYPE_TRAINER is ported on unmodified files, and flips to unported when mutated to battleTypeFlags: BATTLE_TYPE_TRAINER & 0,', () => {
    const spec = BATTLE_TYPE_SPECS.find((s) => s.key === 'BATTLE_TYPE_TRAINER')!
    expect(spec).toBeDefined()
    const initial = classifyToken(spec.token, productionFiles, testFiles, spec.evidence)
    expect(initial.status).toBe('ported')

    const mutatedFiles = productionFiles.map((file) => {
      if (!file.file.endsWith('session.ts')) return file
      return {
        file: file.file,
        source: file.source.replace(
          'battleTypeFlags: BATTLE_TYPE_TRAINER,',
          'battleTypeFlags: BATTLE_TYPE_TRAINER & 0,',
        ),
      }
    })
    const mutated = classifyToken(spec.token, mutatedFiles, testFiles, spec.evidence)
    expect(mutated.status).toBe('unported')
  })

  it('2. FLAG_SYS_INVERSE_BATTLE stays unported with dummy constant; inverseBattle assigned from variable plus naming test flips to ported', () => {
    const spec = MAP_SETUP_SPECS.find((s) => s.key === 'FLAG_SYS_INVERSE_BATTLE')!
    expect(spec).toBeDefined()

    // Baseline: unported
    const baseline = classifyToken(spec.token, productionFiles, testFiles, spec.evidence)
    expect(baseline.status).toBe('unported')

    // Mutation 2a: dummy constant in constants.ts -- stays unported
    const dummyConstantFiles = productionFiles.map((file) => {
      if (!file.file.endsWith('constants.ts')) return file
      return {
        file: file.file,
        source: file.source + '\nexport const FLAG_SYS_INVERSE_BATTLE = 1\n',
      }
    })
    const dummyConstantClassification = classifyToken(
      spec.token,
      dummyConstantFiles,
      testFiles,
      spec.evidence,
    )
    expect(dummyConstantClassification.status).toBe('unported')

    // Mutation 2b: inverseBattle assigned from a variable in session.ts plus a test naming it flips to ported
    const variableAssignedFiles = productionFiles.map((file) => {
      if (!file.file.endsWith('session.ts')) return file
      return {
        file: file.file,
        source: file.source.replace('inverseBattle: false,', 'inverseBattle: data.inverse,'),
      }
    })
    const namingTestFiles = [
      ...testFiles,
      {
        file: 'web/src/engine/sim/dummyInverse.test.ts',
        source: 'it("tests inverse battle", () => { expect(FLAG_SYS_INVERSE_BATTLE).toBe(1) })',
      },
    ]
    const portedClassification = classifyToken(
      spec.token,
      variableAssignedFiles,
      namingTestFiles,
      spec.evidence,
    )
    expect(portedClassification.status).toBe('ported')
  })

  it('3. emptied case body for BATTLE_EVENT_REFLECT, SPIKES, STEALTH_ROCK, LAST_STAND flips to unported', () => {
    const eventsToTest = [
      'BATTLE_EVENT_REFLECT',
      'BATTLE_EVENT_SPIKES',
      'BATTLE_EVENT_STEALTH_ROCK',
      'BATTLE_EVENT_LAST_STAND',
    ]
    for (const event of eventsToTest) {
      const evidence = battleEventEvidence(event)
      const initial = classifyToken(event, productionFiles, testFiles, evidence)
      expect(initial.status).toBe('ported')

      const mutatedFiles = productionFiles.map((file) => {
        if (!file.file.endsWith('battleEvents.ts')) return file
        const caseRegex = new RegExp(
          `(case\\s+['"]${event}['"]\\s*:)[\\s\\S]*?(?=\\n\\s*(?:case|default|\\}))`,
        )
        const mutatedSource = file.source.replace(caseRegex, '$1\n      break')
        expect(mutatedSource).not.toBe(file.source)
        return { file: file.file, source: mutatedSource }
      })

      const mutated = classifyToken(event, mutatedFiles, testFiles, evidence)
      expect(mutated.status).toBe('unported')
    }
  })

  it('4. registerBattleEvent(state, ev.event, ...) removed from session.ts flips every battle-event unit to unported', () => {
    const mutatedFiles = productionFiles.map((file) => {
      if (!file.file.endsWith('session.ts')) return file
      return {
        file: file.file,
        source: file.source.replace(
          /registerBattleEvent\s*\(\s*state\s*,\s*ev\.event/g,
          '// removed',
        ),
      }
    })

    const mutatedInventory = runInventory({
      productionFiles: mutatedFiles,
      testSources: testFiles,
    })

    const battleEventUnits = mutatedInventory.units.filter((u) => u.kind === 'battle-event')
    expect(battleEventUnits.length).toBe(34)
    for (const unit of battleEventUnits) {
      expect(unit.status).toBe('unported')
    }
  })

  it('5. a name only in the BATTLE_EVENT_STEADY_* array at battleEvents.ts:108-114 (case label deleted) flips to unported', () => {
    const token = 'BATTLE_EVENT_STEADY_OFFENSE'
    const evidence = battleEventEvidence(token)
    const initial = classifyToken(token, productionFiles, testFiles, evidence)
    expect(initial.status).toBe('ported')

    const mutatedFiles = productionFiles.map((file) => {
      if (!file.file.endsWith('battleEvents.ts')) return file
      const caseRegex = new RegExp(
        `case\\s+['"]${token}['"]\\s*:[\\s\\S]*?(?=\\n\\s*(?:case|default|\\}))`,
      )
      const mutatedSource = file.source.replace(caseRegex, '')
      expect(mutatedSource).not.toBe(file.source)
      return { file: file.file, source: mutatedSource }
    })

    const mutated = classifyToken(token, mutatedFiles, testFiles, evidence)
    expect(mutated.status).toBe('unported')
  })

  it('6. a test that names the event only in a describe-level constant is not ported', () => {
    const token = 'BATTLE_EVENT_REFLECT'
    const evidence = battleEventEvidence(token)

    const nonAssertingTest: SourceFile[] = [
      {
        file: 'web/src/engine/sim/describeOnly.test.ts',
        source: `
          const BATTLE_EVENT_REFLECT = 1
          describe('describe-level constant only', () => {
            it('does unrelated work', () => {
              expect(1).toBe(1)
            })
          })
        `,
      },
    ]

    const classification = classifyToken(token, productionFiles, nonAssertingTest, evidence)
    expect(classification.status).toBe('unported')
  })

  it('7. real mutation of the unmodified corpus for REFLECT/SPIKES/STEALTH_ROCK via runInventory', () => {
    const events = ['BATTLE_EVENT_REFLECT', 'BATTLE_EVENT_SPIKES', 'BATTLE_EVENT_STEALTH_ROCK']
    for (const event of events) {
      const mutatedFiles = productionFiles.map((file) => {
        if (!file.file.endsWith('battleEvents.ts')) return file
        const caseRegex = new RegExp(
          `(case\\s+['"]${event}['"]\\s*:)[\\s\\S]*?(?=\\n\\s*(?:case|default|\\}))`,
        )
        return {
          file: file.file,
          source: file.source.replace(caseRegex, '$1\n      break'),
        }
      })

      const inventory = runInventory({
        productionFiles: mutatedFiles,
        testSources: testFiles,
      })
      const unit = inventory.units.find((u) => u.kind === 'battle-event' && u.key === event)
      expect(unit?.status).toBe('unported')
    }
  })

  it('pure helper hasLiveCaseBody correctly identifies live vs dead case bodies', () => {
    const liveSwitch = `
      switch (x) {
        case 'FOO':
          doSomething()
          break
        case 'BAR':
        case 'BAZ': {
          const y = 1
          break
        }
      }
    `
    expect(hasLiveCaseBody(liveSwitch, 'FOO')).toBe(true)
    expect(hasLiveCaseBody(liveSwitch, 'BAR')).toBe(true)
    expect(hasLiveCaseBody(liveSwitch, 'BAZ')).toBe(true)

    const deadSwitch = `
      switch (x) {
        case 'EMPTY_BREAK':
          break
        case 'EMPTY_RETURN':
          return;
        case 'EMPTY_BRACES': {}
        case 'EMPTY_CLOSE':
      }
    `
    expect(hasLiveCaseBody(deadSwitch, 'EMPTY_BREAK')).toBe(false)
    expect(hasLiveCaseBody(deadSwitch, 'EMPTY_RETURN')).toBe(false)
    expect(hasLiveCaseBody(deadSwitch, 'EMPTY_BRACES')).toBe(false)
    expect(hasLiveCaseBody(deadSwitch, 'EMPTY_CLOSE')).toBe(false)
    expect(hasLiveCaseBody(deadSwitch, 'NON_EXISTENT')).toBe(false)
  })

  it('pure helper testFileAssertsToken correctly checks assertion within test blocks', () => {
    const describeOnly = `
      const MY_TOKEN = 'token'
      describe('suite', () => {
        const INNER = MY_TOKEN
        it('tests unrelated', () => {
          expect(1).toBe(1)
        })
      })
    `
    expect(testFileAssertsToken(describeOnly, 'MY_TOKEN')).toBe(false)

    const assertingTest = `
      describe('suite', () => {
        it('tests the token', () => {
          expect(hasFlag(state, MY_TOKEN)).toBe(true)
        })
      })
    `
    expect(testFileAssertsToken(assertingTest, 'MY_TOKEN')).toBe(true)

    const nonAssertingIt = `
      describe('suite', () => {
        it('uses token without expect', () => {
          console.log(MY_TOKEN)
        })
      })
    `
    expect(testFileAssertsToken(nonAssertingIt, 'MY_TOKEN')).toBe(false)
  })

  it('8. real corpus units have productionEvidence: BATTLE_EVENT_REFLECT has line in battleEvents.ts, FLAG_SYS_INVERSE_BATTLE has null', () => {
    const inventory = runInventory()
    const reflect = inventory.units.find((u) => u.key === 'BATTLE_EVENT_REFLECT')
    expect(reflect?.productionEvidence?.startsWith('web/src/engine/sim/battleEvents.ts:')).toBe(
      true,
    )
    const inverse = inventory.units.find((u) => u.key === 'FLAG_SYS_INVERSE_BATTLE')
    expect(inverse?.productionEvidence).toBeNull()
  })
})

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

describe('step 2-3: hell skills and map weather', () => {
  const productionFiles = loadEngineProductionFiles()
  const testFiles = loadEngineTestFiles()

  it('parses hell trainer skills from synthetic source and real header (24 trainers, 29 rows)', () => {
    const synthetic = `
// Comment line
const u16 sTrainerSkillList[TRAINERS_COUNT][MAX_HELL_TRAINERS_GYM_SKILLS][BATTLE_EVENT_ARGUMENTS] = {
    [TRAINER_SYNTHETIC_1] = {
        [HELL_MODE_TRAINER_SKILL_1] = {BATTLE_EVENT_EVIOLITE, 0, 0}, // inline comment
        [HELL_MODE_TRAINER_SKILL_2] = {BATTLE_EVENT_EXTRA_ABILITIES_1, ABILITY_UNNERVE, 0},
    },
    [TRAINER_SYNTHETIC_2] = {
        [HELL_MODE_TRAINER_SKILL_1] = {BATTLE_EVENT_SPIKES, 1, 0},
    },
};
`
    const parsedSynthetic = parseHellTrainerSkills(synthetic)
    expect(parsedSynthetic).toEqual([
      {
        trainer: 'TRAINER_SYNTHETIC_1',
        slot: 'HELL_MODE_TRAINER_SKILL_1',
        event: 'BATTLE_EVENT_EVIOLITE',
        data0: '0',
        data1: '0',
        line: 5,
      },
      {
        trainer: 'TRAINER_SYNTHETIC_1',
        slot: 'HELL_MODE_TRAINER_SKILL_2',
        event: 'BATTLE_EVENT_EXTRA_ABILITIES_1',
        data0: 'ABILITY_UNNERVE',
        data1: '0',
        line: 6,
      },
      {
        trainer: 'TRAINER_SYNTHETIC_2',
        slot: 'HELL_MODE_TRAINER_SKILL_1',
        event: 'BATTLE_EVENT_SPIKES',
        data0: '1',
        data1: '0',
        line: 9,
      },
    ])

    const realPath = join(
      REPO_ROOT,
      'pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h',
    )
    const realSource = readFileSync(realPath, 'utf-8')
    const realRows = parseHellTrainerSkills(realSource)
    const distinctTrainers = new Set(realRows.map((r) => r.trainer))
    expect(distinctTrainers.size).toBe(24)
    expect(realRows).toHaveLength(29)
  })

  it('contains one unit per hell skill row, all unported, each citing a header line that contains the event', () => {
    const realPath = join(
      REPO_ROOT,
      'pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h',
    )
    const realSource = readFileSync(realPath, 'utf-8')
    const realRows = parseHellTrainerSkills(realSource)
    const realLines = realSource.split('\n')

    for (const row of realRows) {
      const unitKey = `${row.trainer}#${row.slot}:${row.event}`
      const unit = result.units.find(
        (u) => u.key === unitKey && u.kind === 'hell-trainer-skill',
      )
      expect(unit).toBeDefined()
      expect(unit?.status).toBe('unported')
      expect(unit?.citation).toBe(
        `pipeline/.upstream/eliteredux-source/src/data/hell_trainer_skills.h:${row.line}`,
      )
      const citedLine = realLines[row.line - 1]
      expect(citedLine).toContain(row.event)
    }
  })

  it('mutation: session.ts reading sTrainerSkillList plus naming test required to flip ported', () => {
    const calvinUnit = result.units.find(
      (u) =>
        u.key ===
        'TRAINER_CALVIN_1#HELL_MODE_TRAINER_SKILL_1:BATTLE_EVENT_NO_PROTECT',
    )!
    expect(calvinUnit).toBeDefined()
    expect(calvinUnit.status).toBe('unported')

    const row = {
      trainer: 'TRAINER_CALVIN_1',
      slot: 'HELL_MODE_TRAINER_SKILL_1',
      event: 'BATTLE_EVENT_NO_PROTECT',
      data0: '0',
      data1: '0',
      line: 22,
    }
    const evidence = hellTrainerSkillEvidence(row)

    // Baseline: unported
    const baseline = classifyToken(
      calvinUnit.token,
      productionFiles,
      testFiles,
      evidence,
    )
    expect(baseline.status).toBe('unported')

    // Mutation with naming/asserting test but WITHOUT sTrainerSkillList in session.ts: stays unported
    const dummyAssertingTest: SourceFile[] = [
      ...testFiles,
      {
        file: 'web/src/engine/sim/dummyHellSkill.test.ts',
        source:
          'it("tests hell skill", () => { expect(BATTLE_EVENT_NO_PROTECT).toBeDefined() })',
      },
    ]
    const withoutSession = classifyToken(
      calvinUnit.token,
      productionFiles,
      dummyAssertingTest,
      evidence,
    )
    expect(withoutSession.status).toBe('unported')

    // Mutation with sTrainerSkillList in session.ts but WITHOUT asserting test: stays unported
    const sessionWithSkills = productionFiles.map((f) => {
      if (!f.file.endsWith('session.ts')) return f
      return {
        file: f.file,
        source: f.source + '\nconst _skillTable = sTrainerSkillList;\n',
      }
    })
    const withoutTest = classifyToken(
      calvinUnit.token,
      sessionWithSkills,
      [],
      evidence,
    )
    expect(withoutTest.status).toBe('unported')

    // Mutation with BOTH: flips to ported
    const withBoth = classifyToken(
      calvinUnit.token,
      sessionWithSkills,
      dummyAssertingTest,
      evidence,
    )
    expect(withBoth.status).toBe('ported')
  })

  it('mutation: map weather requires map-weather source in session.ts plus asserting test to flip ported', () => {
    const desertUnit = result.units.find(
      (u) => u.key === 'map-weather:Route111_Desert:WEATHER_SANDSTORM',
    )!
    expect(desertUnit).toBeDefined()
    expect(desertUnit.status).toBe('unported')

    const dummyAssertingTest: SourceFile[] = [
      ...testFiles,
      {
        file: 'web/src/engine/sim/dummyMapWeather.test.ts',
        source:
          'it("tests map weather", () => { expect(WEATHER_SANDSTORM).toBeDefined() })',
      },
    ]

    // 1. A session.ts copy with an added line `const weather = 'WEATHER_SANDSTORM'`
    // leaves it unported even with an asserting test (rejects bare name match).
    const sessionWithBareWeather = productionFiles.map((f) => {
      if (!f.file.endsWith('session.ts')) return f
      return {
        file: f.file,
        source: f.source + "\nconst weather = 'WEATHER_SANDSTORM';\n",
      }
    })
    const bareMatch = classifyToken(
      desertUnit.token,
      sessionWithBareWeather,
      dummyAssertingTest,
      desertUnit.evidence,
    )
    expect(bareMatch.status).toBe('unported')

    // 2. A copy with the new required pattern but no asserting test stays unported.
    const sessionWithMapWeather = productionFiles.map((f) => {
      if (!f.file.endsWith('session.ts')) return f
      return {
        file: f.file,
        source: f.source + "\nconst mapWeather = 'WEATHER_SANDSTORM';\n",
      }
    })
    const withoutTest = classifyToken(
      desertUnit.token,
      sessionWithMapWeather,
      testFiles,
      desertUnit.evidence,
    )
    expect(withoutTest.status).toBe('unported')

    // 3. A copy with the pattern and an asserting test flips it to ported.
    const withBoth = classifyToken(
      desertUnit.token,
      sessionWithMapWeather,
      dummyAssertingTest,
      desertUnit.evidence,
    )
    expect(withBoth.status).toBe('ported')
  })

  it('setweather is no longer in DEFAULT_ALLOWLIST; map-weather units exist for the 4 maps with verified trainer ids', () => {
    expect(DEFAULT_ALLOWLIST.some((entry) => entry.key === 'setweather')).toBe(
      false,
    )

    const setweatherUnit = result.units.find((u) => u.key === 'setweather')
    expect(setweatherUnit).toBeDefined()
    expect(setweatherUnit?.status).toBe('unported')
    expect(setweatherUnit?.scope).toBe('overworld weather seeds battle weather')
    expect(setweatherUnit?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_util.c:4349',
    )

    // 4 map-weather units with verified trainer ids
    const flanneryGym = result.units.find(
      (u) =>
        u.key === 'map-weather:LavaridgeTown_Gym_1F:WEATHER_FOG_HORIZONTAL',
    )
    expect(flanneryGym).toBeDefined()
    expect(flanneryGym?.status).toBe('unported')
    expect(flanneryGym?.trainerIds).toContain('TRAINER_FLANNERY_1')
    expect(flanneryGym?.trainerIds).toEqual([
      'TRAINER_AXLE',
      'TRAINER_COLE',
      'TRAINER_DANIELLE',
      'TRAINER_ELI',
      'TRAINER_FLANNERY_1',
      'TRAINER_GERALD',
      'TRAINER_JACE',
      'TRAINER_JEFF',
      'TRAINER_KEEGAN',
    ])

    const mtPyre = result.units.find(
      (u) => u.key === 'map-weather:MtPyre_Summit:WEATHER_FOG_HORIZONTAL',
    )
    expect(mtPyre).toBeDefined()
    expect(mtPyre?.status).toBe('unported')
    expect(mtPyre?.trainerIds).toEqual(['TRAINER_ARCHIE_MT_PYRE'])

    const desert = result.units.find(
      (u) => u.key === 'map-weather:Route111_Desert:WEATHER_SANDSTORM',
    )
    expect(desert).toBeDefined()
    expect(desert?.status).toBe('unported')
    expect(desert?.trainerIds).toEqual([
      'TRAINER_AMANDA',
      'TRAINER_LETT',
      'TRAINER_ORWELL',
      'TRAINER_RODRICK',
    ])

    const sunhollow = result.units.find(
      (u) => u.key === 'map-weather:Route111_SunhollowRuins:WEATHER_SANDSTORM',
    )
    expect(sunhollow).toBeDefined()
    expect(sunhollow?.status).toBe('unported')
    expect(sunhollow?.trainerIds).toEqual(['TRAINER_GRUNT_SUNHOLLOW_1'])

    // Distinct setweather units in scripts
    expect(
      result.units.find((u) => u.key === 'setweather:WEATHER_DOWNPOUR'),
    ).toBeDefined()
    expect(
      result.units.find((u) => u.key === 'setweather:WEATHER_FOG_HORIZONTAL'),
    ).toBeDefined()
    expect(
      result.units.find((u) => u.key === 'setweather:WEATHER_RAIN'),
    ).toBeDefined()
    expect(
      result.units.find((u) => u.key === 'setweather:WEATHER_SANDSTORM'),
    ).toBeDefined()
  })
})

describe('step 4: hell and difficulty rules', () => {
  const productionFiles = loadEngineProductionFiles()
  const testFiles = loadEngineTestFiles()

  /** The C identifier each cited line must contain (not always the unit token). */
  const HELL_UNITS = [
    { key: 'hellDamageReduction', identifier: 'isHellMode' },
    { key: 'hellTypeEffectiveness', identifier: 'HELL_MODE_TYPE_EFFECTIVENESS_CHANGE' },
    { key: 'hellNoEnemyFullParalysis', identifier: 'disableParalysisCancel' },
    { key: 'hellPlayerFlinchFails', identifier: 'MOVE_EFFECT_FLINCH' },
    { key: 'hellEvasionClause', identifier: 'IsEvasionClauseDisablingMove' },
    { key: 'hellSleepMovePP', identifier: 'CalculatePPWithBonusPlayer' },
    { key: 'sleepClause', identifier: 'IsSleepClauseDisablingMove' },
  ] as const

  it('adds the seven hell/difficulty rules as unported difficulty-flag units with real C lines', () => {
    for (const { key, identifier } of HELL_UNITS) {
      const unit = result.units.find(
        (candidate) => candidate.kind === 'difficulty-flag' && candidate.key === key,
      )
      expect(unit).toBeDefined()
      expect(unit?.status).toBe('unported')
      // The token is a C-side identifier absent from comment-stripped production
      // and from every test, so the rule is invisible to the sim, not merely
      // untested.
      expect(unit?.registeredUntested).toBe(false)

      const match = unit?.citation.match(/^(.*):(\d+)$/)
      expect(match).not.toBeNull()
      if (!match) continue
      const lines = readFileSync(join(REPO_ROOT, match[1]), 'utf-8').split('\n')
      expect(lines[Number(match[2]) - 1]).toContain(identifier)
    }
  })

  it('a production comment naming a hell token does not flip the unit to ported', () => {
    const spec = DIFFICULTY_FLAG_SPECS.find((candidate) => candidate.key === 'hellDamageReduction')
    expect(spec).toBeDefined()
    if (!spec) return

    const baseline = classifyToken(spec.token, productionFiles, testFiles, spec.evidence)
    expect(baseline.status).toBe('unported')

    // A bare name in a comment is not production evidence: classifyToken strips
    // comments before matching, the same mutation shape as the 153c/153d tests.
    const commentOnly = productionFiles.map((file) =>
      file.file.endsWith('attackCanceller.ts')
        ? { file: file.file, source: `${file.source}\n// ${spec.token}\n` }
        : file,
    )
    const commented = classifyToken(spec.token, commentOnly, testFiles, spec.evidence)
    expect(commented.status).toBe('unported')
    expect(commented.registeredUntested).toBe(false)

    // The contrast: a real code line registers the name, but with no test naming
    // it the unit is still unported -- a name alone is never a port.
    const namedInCode = productionFiles.map((file) =>
      file.file.endsWith('attackCanceller.ts')
        ? { file: file.file, source: `${file.source}\nconst ${spec.token} = 1\n` }
        : file,
    )
    const registered = classifyToken(spec.token, namedInCode, testFiles, spec.evidence)
    expect(registered.status).toBe('unported')
    expect(registered.registeredUntested).toBe(true)
  })

  it('corrects the two badge-flag scopes: FLAG_BADGE03_GET and player-only FLAG_BADGE05_GET', () => {
    const extraLevels = result.units.find(
      (candidate) =>
        candidate.kind === 'difficulty-flag' && candidate.key === 'HELL_MODE_EXTRA_LEVELS_FLAG',
    )
    expect(extraLevels?.scope).toContain('FLAG_BADGE03_GET')

    const zeroIvs = result.units.find(
      (candidate) =>
        candidate.kind === 'difficulty-flag' && candidate.key === 'HELL_MODE_0_IVS_FLAG',
    )
    expect(zeroIvs?.scope).toContain('FLAG_BADGE05_GET')
    expect(zeroIvs?.scope).toContain('player')
  })
})
