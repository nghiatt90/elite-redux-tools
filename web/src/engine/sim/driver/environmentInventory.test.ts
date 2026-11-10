/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWLIST,
  ENVIRONMENT_INVENTORY_DOC_PATH,
  TRAINER_FLAG_SPECS,
  classifyToken,
  generateEnvironmentInventoryDoc,
  isValidAllowlistCitation,
  loadBattleEventRows,
  loadEngineProductionFiles,
  loadEngineTestFiles,
  loadMapScripts,
  loadTrainers,
  runInventory,
  scanMapScripts,
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

const MAP_SETUP_UNITS = 22
const BATTLE_TYPE_UNITS = 5
const DIFFICULTY_FLAG_UNITS = 9
const TRAINER_FLAG_UNITS = 14
const BATTLE_EVENT_UNITS = 34
const SCRIPT_EVENT_UNITS = 6

/** Pinned today -- this number should only go DOWN. */
export const UNPORTED_UNIT_COUNT = 41

/** Pinned today -- this number should only go DOWN. */
export const REGISTERED_UNTESTED_UNIT_COUNT = 6

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
    expect(DEFAULT_ALLOWLIST.length).toBe(8)
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
    'AI_FLAG_CHECK_BAD_MOVE',
    'AI_FLAG_TRY_TO_FAINT',
    'AI_FLAG_CHECK_VIABILITY',
    'AI_FLAG_SMART_SWITCHING',
    'AI_FLAG_WILL_SUICIDE',
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
