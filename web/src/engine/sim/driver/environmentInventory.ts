import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './moveInventory'

/**
 * Static completeness inventory for environment and scripted battle conditions.
 *
 * This inventory changes nothing in the simulator. It reads the pinned C tree
 * (`pipeline/.upstream/eliteredux-source`), the extracted data files and the
 * engine sources, and classifies every unit it defines.
 *
 * Unit kinds:
 *   1. `map-setup`       -- a flag/var/special/script command set by a map script
 *                           before a battle, or a battle-relevant value it carries.
 *   2. `battle-type`     -- a `BATTLE_TYPE_*` flag (or `FLAG_TAG_BATTLE`) that a
 *                           battle-start path sets.
 *   3. `difficulty-flag` -- a save-block difficulty/settings flag or a C rule that
 *                           derives party level, IVs, EVs or party selection.
 *   4. `trainer-flag`    -- a trainers.json field or `AI_FLAG_*` bit minted from one.
 *   5. `battle-event`    -- one distinct `event` value in encounters.json
 *                           `battleEvents`; provenance is the encounter table.
 *   6. `script-event`    -- one battle script label a scripted setup pushes.
 *
 * A unit is `ported` only when its token appears in BOTH a qualifying engine
 * source file (non-test, outside `sim/driver/` except the four loader files) and
 * an engine test file, after comments are stripped. A name alone can be a false
 * positive, so a unit may attach `UnitEvidence` that narrows what counts:
 *
 *   - `testPattern`: the test must also match a behaviour pattern, not merely
 *     name the token (`speedDown` needs `speedDown: true`, not a `false` fixture).
 *   - `productionFiles`: production evidence must come from the files that can
 *     actually run this unit (battle types are set in the driver's battle-start
 *     path, not in a unit-level helper).
 *   - `productionLinePattern`: the token must be named on a line that performs
 *     the behaviour (e.g. changes the number of active battlers).
 *   - `productionExcludeFiles`: files whose mention of the token proves nothing.
 *
 * `registeredUntested` is a sub-count of `unported`: production names the token
 * but no qualifying test does.
 *
 * `allowlisted` requires an exact pinned C `file:line` and a reason quoting that
 * line. The default list is NOT empty: eight units are provably inert for battle
 * outcome (see `DEFAULT_ALLOWLIST`).
 */

export type EnvironmentUnitKind =
  | 'map-setup'
  | 'battle-type'
  | 'difficulty-flag'
  | 'trainer-flag'
  | 'battle-event'
  | 'script-event'

export type EnvironmentUnitStatus = 'ported' | 'unported' | 'unclassified' | 'allowlisted'

export interface EnvironmentAllowlistEntry {
  /** Unit key (unique inside its kind). */
  key: string
  /** Must quote the cited C line and say why the unit cannot affect battle outcome. */
  reason: string
  /** Exact `file:line` from the pinned C. */
  cite: string
}

export interface SourceFile {
  file: string
  source: string
}

/**
 * Extra proof a unit needs before a name match counts as a port. All fields are
 * optional; a unit with no evidence keeps the plain token rule.
 *
 * Patterns are evaluated against comment-stripped sources. Do not pass a `g`
 * regex: its `lastIndex` would leak between files.
 */
export interface UnitEvidence {
  /**
   * Test evidence must name the token AND match this pattern. A bare token is
   * not enough: a `speedDown: false` fixture does not test the iron pill.
   */
  testPattern?: RegExp
  /**
   * Production evidence must come from one of these repo-relative files. Used
   * by battle-type units: the driver only starts battles from `session.ts`,
   * `runBattle.ts` or `buildParty.ts`, so a constant declared in a unit-level
   * helper is not proof that a battle of that type is ever run.
   */
  productionFiles?: readonly string[]
  /**
   * Production evidence must name the token on a line that also matches this
   * pattern, i.e. the line must perform the behaviour. Used by `forcedDouble`:
   * only `aiFlags.ts` ORs an AI bit; nothing changes the battler count.
   */
  productionLinePattern?: RegExp
  /** Production files that never count as evidence for this unit. */
  productionExcludeFiles?: readonly string[]
  /**
   * Canonical flag token when the production read line uses a numeric dispatch
   * key or helper name rather than the flag identifier itself.
   */
  evidenceToken?: string
}

export interface MapScript {
  map: string
  /** Repo-relative path of `data/maps/<map>/scripts.pory`. */
  file: string
  source: string
}

export interface MapScanHit {
  map: string
  line: number
  token: string
}

export interface MapScanResult {
  hits: MapScanHit[]
  maps: string[]
}

export interface EncounterBattleEventRow {
  event: string
  data0?: number | null
  data1?: number | null
  guard?: string | null
  map?: string | null
  script?: string | null
}

export interface TrainerRecord {
  id: string
  forcedDouble?: boolean
  risky?: boolean
  preferStatus?: boolean
  preferStall?: boolean
  noSwitching?: boolean
  class?: string
  gender?: string
}

export interface EnvironmentUnit {
  kind: EnvironmentUnitKind
  /** Deterministic key, unique inside the kind. */
  key: string
  /** Token searched for in engine sources and tests. */
  token: string
  /** Enclosing C function / switch site / data field. */
  site: string
  /** Where the unit is observed (maps, encounter rows, or "all trainer battles"). */
  scope: string
  /** Upstream file (repo-relative) holding the citation. */
  file: string
  citation: string
  status: EnvironmentUnitStatus
  /** Production names the token but no qualifying test does (sub-count of unported). */
  registeredUntested: boolean
  /** Engine test file with the strongest evidence, or null. */
  testFile: string | null
  /** Trainer ids reachable from the maps where a map-setup unit is set. */
  trainerIds: string[]
}

export interface EnvironmentUnitKindSummary {
  kind: EnvironmentUnitKind
  defined: number
  ported: number
  registeredUntested: number
  /** Includes `registeredUntested`. */
  unported: number
  unclassified: number
  allowlisted: number
}

export interface UnportedByKind {
  kind: EnvironmentUnitKind
  unported: number
  registeredUntested: number
}

export interface EnvironmentInventoryResult {
  units: EnvironmentUnit[]
  summaries: EnvironmentUnitKindSummary[]
  totalDefined: number
  totalPorted: number
  totalUnported: number
  totalRegisteredUntested: number
  totalUnclassified: number
  totalAllowlisted: number
  unportedByKind: UnportedByKind[]
  mapFileCount: number
  mapsWithSetup: number
  battleEventRowCount: number
  distinctBattleEventCount: number
  trainerCount: number
}

/**
 * Pinned in the test. Every entry below cites a C line that only feeds rewards,
 * presentation, overworld state, mon cosmetics, or post-battle rewards.
 */
export const DEFAULT_ALLOWLIST: ReadonlyArray<EnvironmentAllowlistEntry> = [
  {
    key: 'FLAG_SHINY_CREATION',
    reason:
      '`if (FlagGet(FLAG_SHINY_CREATION)) isShiny = GenerateShinyForm(species);` only selects the cosmetic shiny form.',
    cite: 'pipeline/.upstream/eliteredux-source/src/pokemon.c:499',
  },
  {
    key: 'FLAG_ALPHA_CREATION',
    reason:
      '`if (FlagGet(FLAG_ALPHA_CREATION)) isAlpha = TRUE;` only feeds the cosmetic alpha palette/sprite path.',
    cite: 'pipeline/.upstream/eliteredux-source/src/pokemon.c:504',
  },
  {
    key: 'VAR_MONOTYPE_BOOST',
    reason:
      '`Type type = VarGet(VAR_MONOTYPE_BOOST);` is read by IsPlayerPartyMonotypeType, which only gates the post-battle reward.',
    cite: 'pipeline/.upstream/eliteredux-source/src/field_specials.c:4943',
  },
  {
    key: 'VAR_TRAINER_PRIZE_BP',
    reason:
      '`if (VarGet(VAR_TRAINER_PRIZE_BP) == 0) {` is in Cmd_getmoneyreward; it only accounts battle points after the fight.',
    cite: 'pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:5809',
  },
  {
    key: 'setweather',
    reason:
      '`SetSav1Weather(weather);` writes the overworld weather; gBattleWeather is separately zeroed at battle start (src/battle_main.c:2721).',
    cite: 'pipeline/.upstream/eliteredux-source/src/scrcmd.c:724',
  },
  {
    key: 'setfieldeffectargument',
    reason:
      '`extern s32 gFieldEffectArguments[8];` -- readers are field-effect, party-menu and battle-transition visual code; none drives battle state.',
    cite: 'pipeline/.upstream/eliteredux-source/include/field_effect.h:8',
  },
  {
    key: 'trainerClass',
    reason:
      '`if (gTrainerMoneyTable[i].classId == gTrainers[trainerId].trainerClass) break;` -- trainer class only selects the prize-money row (plus ball and victory music).',
    cite: 'pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:5794',
  },
  {
    key: 'noSwitching',
    reason:
      '`if (gBattleTypeFlags & (AI_FLAG_DISABLE_SWITCHING))` tests gBattleTypeFlags (bit 1<<17, Battle Palace), so a trainer\'s aiFlags never reaches it.',
    cite: 'pipeline/.upstream/eliteredux-source/src/battle_ai_switch_items.c:611',
  },
]

export const UNIT_KIND_ORDER: ReadonlyArray<EnvironmentUnitKind> = [
  'map-setup',
  'battle-type',
  'difficulty-flag',
  'trainer-flag',
  'battle-event',
  'script-event',
]

/** Tokens used for the map-script scan (substring match, as the brief specifies). */
export const MAP_SCAN_TOKENS = [
  'setweather',
  'setfieldeffectargument',
  'FLAG_TOTEM_BATTLE',
  'FLAG_SYS_INVERSE_BATTLE',
  'VAR_BATTLE_FIELD_EFFECT_TYPE',
  'VAR_MONOTYPE_BOOST',
] as const

const ENGINE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const MAPS_DIR = join(REPO_ROOT, 'pipeline/.upstream/eliteredux-source/data/maps')
const UPSTREAM = 'pipeline/.upstream/eliteredux-source'
const UPSTREAM_SRC = `${UPSTREAM}/src`
const BATTLE_EVENTS_C = `${UPSTREAM_SRC}/battle_events.c`
const BATTLE_EVENTS_H = `${UPSTREAM}/include/constants/battle_events.h`
const CODEGEN_PATH = `${UPSTREAM}/tools/codegen/src/er/trainer/TrainerPartyGenerator.kt`
const TRAINERS_PATH = join(REPO_ROOT, 'data/v2.65beta/trainers.json')
const ENCOUNTERS_PATH = join(REPO_ROOT, 'data/v2.65beta/encounters.json')
const SOURCES_LOCK_PATH = join(REPO_ROOT, 'sources.lock.json')

export const ENVIRONMENT_INVENTORY_DOC_PATH = join(REPO_ROOT, 'docs/battle-sim/environment-inventory.md')

/** Driver loaders count as production evidence for loader-side units. */
export const LOADER_FILES = [
  'web/src/engine/sim/driver/session.ts',
  'web/src/engine/sim/driver/runBattle.ts',
  'web/src/engine/sim/driver/buildParty.ts',
  'web/src/engine/sim/driver/loadSimData.ts',
] as const

/**
 * The driver's battle-start path. `loadSimData.ts` is a data loader, so it is
 * deliberately absent: declaring a type field there does not start a battle.
 * `BATTLE_TYPE_TRAINER` is set in `session.ts:238`; `BATTLE_TYPE_DOUBLE` is not
 * set anywhere in these files, so the driver never runs a double battle.
 */
export const BATTLE_TYPE_DRIVER_FILES = [
  'web/src/engine/sim/driver/session.ts',
  'web/src/engine/sim/driver/runBattle.ts',
  'web/src/engine/sim/driver/buildParty.ts',
] as const

const BATTLE_TYPE_DRIVER_EVIDENCE: UnitEvidence = {
  productionFiles: BATTLE_TYPE_DRIVER_FILES,
  // The flag must be assigned, not merely imported or named: `session.ts:238`
  // has `battleTypeFlags: BATTLE_TYPE_TRAINER,`.
  productionLinePattern: /\bbattleTypeFlags\s*(?:\|=|:|=)/,
}

const OWN_TEST_FILE = 'web/src/engine/sim/driver/environmentInventory.test.ts'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function tokenAppears(source: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(source)
}

function cite(file: string, line: number): string {
  return `${file}:${line}`
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

export function loadMapScripts(dir: string = MAPS_DIR): MapScript[] {
  const scripts: MapScript[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name, 'scripts.pory')
    if (!existsSync(path)) continue
    scripts.push({
      map: entry.name,
      file: relative(REPO_ROOT, path).replace(/\\/g, '/'),
      source: readFileSync(path, 'utf-8'),
    })
  }
  return scripts.sort((a, b) => (a.map < b.map ? -1 : a.map > b.map ? 1 : 0))
}

export function loadTrainers(path: string = TRAINERS_PATH): TrainerRecord[] {
  return JSON.parse(readFileSync(path, 'utf-8')) as TrainerRecord[]
}

export function loadBattleEventRows(path: string = ENCOUNTERS_PATH): EncounterBattleEventRow[] {
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    battleEvents?: EncounterBattleEventRow[]
  }
  return data.battleEvents ?? []
}

function isCommentLine(line: string): boolean {
  return line.trimStart().startsWith('//') || line.trimStart().startsWith('@')
}

/** Substring scan over non-comment map-script lines. */
export function scanMapScripts(
  scripts: ReadonlyArray<MapScript>,
  tokens: ReadonlyArray<string> = MAP_SCAN_TOKENS,
): MapScanResult {
  const hits: MapScanHit[] = []
  for (const script of scripts) {
    const lines = script.source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (isCommentLine(line)) continue
      for (const token of tokens) {
        if (line.includes(token)) hits.push({ map: script.map, line: index + 1, token })
      }
    }
  }
  const maps = [...new Set(hits.map((hit) => hit.map))].sort()
  return { hits, maps }
}

export interface TokenMapHit {
  map: string
  line: number
}

/** Word-boundary occurrences of one token, first line per map, comments skipped. */
export function mapsForToken(scripts: ReadonlyArray<MapScript>, token: string): TokenMapHit[] {
  const found = new Map<string, number>()
  for (const script of scripts) {
    const lines = script.source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (isCommentLine(line)) continue
      if (!tokenAppears(line, token)) continue
      if (!found.has(script.map)) found.set(script.map, index + 1)
      break
    }
  }
  return [...found.entries()]
    .map(([map, line]) => ({ map, line }))
    .sort((a, b) => (a.map < b.map ? -1 : 1))
}

/** Every word-boundary occurrence of one token, comments skipped. */
export function tokenLines(
  scripts: ReadonlyArray<MapScript>,
  token: string,
): TokenMapHit[] {
  const hits: TokenMapHit[] = []
  for (const script of scripts) {
    const lines = script.source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (isCommentLine(line)) continue
      if (tokenAppears(line, token)) hits.push({ map: script.map, line: index + 1 })
    }
  }
  return hits
}

const TRAINER_CALL_RE = /\b(?:trainerbattle[A-Za-z_]*|starttagbattle)\s*\(([^)]*)\)/g
const TRAINER_ID_RE = /\bTRAINER_[A-Z0-9_]+\b/g

/** Trainer ids passed to trainer-battle/starttagbattle calls in the given maps. */
export function scanTrainerIds(
  scripts: ReadonlyArray<MapScript>,
  maps: ReadonlyArray<string>,
): string[] {
  const wanted = new Set(maps)
  const ids = new Set<string>()
  for (const script of scripts) {
    if (!wanted.has(script.map)) continue
    for (const line of script.source.split('\n')) {
      if (isCommentLine(line)) continue
      for (const call of line.matchAll(TRAINER_CALL_RE)) {
        for (const id of call[1].matchAll(TRAINER_ID_RE)) {
          if (id[0] !== 'TRAINER_NONE') ids.add(id[0])
        }
      }
    }
  }
  return [...ids].sort()
}

// ---------------------------------------------------------------------------
// Engine source loaders
// ---------------------------------------------------------------------------

function collectEngineFiles(predicate: (repoRel: string, isTest: boolean) => boolean): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const repoRel = relative(REPO_ROOT, full).replace(/\\/g, '/')
      const isTest = entry.name.endsWith('.test.ts')
      if (predicate(repoRel, isTest)) {
        files.push({ file: repoRel, source: readFileSync(full, 'utf-8') })
      }
    }
  }
  walk(ENGINE_DIR)
  return files
}

/**
 * Non-test engine sources. `sim/driver/` is excluded except the four loaders,
 * which are the places the sim sources a unit from data.
 */
export function loadEngineProductionFiles(): SourceFile[] {
  return collectEngineFiles(
    (repoRel, isTest) =>
      !isTest &&
      (!repoRel.startsWith('web/src/engine/sim/driver/') ||
        (LOADER_FILES as ReadonlyArray<string>).includes(repoRel)),
  ).map((file) => ({ file: file.file, source: stripComments(file.source) }))
}

/** Engine test sources except this inventory's own test file. */
export function loadEngineTestFiles(): SourceFile[] {
  return collectEngineFiles((repoRel, isTest) => isTest && repoRel !== OWN_TEST_FILE)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface TokenClassification {
  status: EnvironmentUnitStatus
  registeredUntested: boolean
  testFile: string | null
}

const JOINED_PRODUCTION_FILE = '<joined-production>'

function asProductionFiles(
  production: ReadonlyArray<SourceFile> | string,
): SourceFile[] {
  return typeof production === 'string'
    ? [{ file: JOINED_PRODUCTION_FILE, source: production }]
    : [...production]
}

function patternMatches(pattern: RegExp, source: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(source)
}

/** The token and the behaviour pattern must co-occur on one production line. */
function lineMatches(source: string, token: string, pattern: RegExp): boolean {
  for (const line of source.split('\n')) {
    if ((token === '' || tokenAppears(line, token)) && patternMatches(pattern, line)) return true
  }
  return false
}

/**
 * Classify one unit. `production` may be the per-file corpus (the normal case,
 * so `productionFiles` scoping is possible) or a single joined string used by
 * synthetic callers.
 */
export function classifyToken(
  token: string,
  production: ReadonlyArray<SourceFile> | string,
  testSources: ReadonlyArray<SourceFile>,
  evidence: UnitEvidence = {},
): TokenClassification {
  const tokenToCheck = evidence.evidenceToken ?? token
  const lineToken = evidence.evidenceToken && token === evidence.evidenceToken ? '' : token
  const productionFiles = asProductionFiles(production).map((file) => ({
    file: file.file,
    source: stripComments(file.source),
  }))
  const productionSource = productionFiles.map((file) => file.source).join('\n')
  // Raw name presence, unscoped by evidence: it decides `registeredUntested`.
  const productionNamesToken = tokenAppears(productionSource, tokenToCheck)

  const requiredFiles = evidence.productionFiles
    ? new Set(evidence.productionFiles)
    : null
  const excludedFiles = new Set(evidence.productionExcludeFiles ?? [])
  let productionQualifies = false
  for (const file of productionFiles) {
    if (requiredFiles && !requiredFiles.has(file.file)) continue
    if (excludedFiles.has(file.file)) continue
    if (evidence.productionLinePattern) {
      if (lineMatches(file.source, lineToken, evidence.productionLinePattern)) {
        productionQualifies = true
        break
      }
    } else if (tokenAppears(file.source, lineToken)) {
      productionQualifies = true
      break
    }
  }

  const matchingFiles = testSources
    .filter((file) => {
      const source = stripComments(file.source)
      if (!tokenAppears(source, tokenToCheck)) return false
      if (
        evidence.productionExcludeFiles?.includes('web/src/engine/sim/ai/aiFlags.ts') &&
        tokenToCheck.startsWith('AI_FLAG_')
      ) {
        return evidence.testPattern ? patternMatches(evidence.testPattern, source) : false
      }
      return evidence.testPattern ? patternMatches(evidence.testPattern, source) : true
    })
    .map((file) => file.file)
    .sort()
  const tested = matchingFiles.length > 0
  if (productionQualifies && tested) {
    return { status: 'ported', registeredUntested: false, testFile: matchingFiles[0] }
  }
  if (productionNamesToken && !tested) {
    return { status: 'unported', registeredUntested: true, testFile: null }
  }
  return { status: 'unported', registeredUntested: false, testFile: matchingFiles[0] ?? null }
}

/** A citation must be an exact `file:line` ending in a C/C++/header, or an upstream script. */
export function isValidAllowlistCitation(value: string): boolean {
  return /\.(?:c|cc|h|s):\d+$/.test(value)
}

/** Returns human-readable problems; empty means every entry is well formed. */
export function validateAllowlist(
  allowlist: ReadonlyArray<EnvironmentAllowlistEntry>,
): string[] {
  const problems: string[] = []
  for (const entry of allowlist) {
    if (!entry.key) problems.push(`allowlist entry has no key: ${JSON.stringify(entry)}`)
    if (!entry.reason) problems.push(`allowlist entry ${entry.key} has no reason`)
    if (!isValidAllowlistCitation(entry.cite)) {
      problems.push(`allowlist entry ${entry.key} has no exact file:line cite: ${entry.cite}`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Unit definitions
// ---------------------------------------------------------------------------

export interface MapSetupSpec {
  key: string
  token: string
  site: string
  citation: string
  evidence?: UnitEvidence
}

/** Every map-setup unit this inventory defines. Citations were read in the C. */
export const MAP_SETUP_SPECS: ReadonlyArray<MapSetupSpec> = [
  {
    key: 'FLAG_TOTEM_BATTLE',
    token: 'FLAG_TOTEM_BATTLE',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9144),
  },
  {
    key: 'VAR_TOTEM_POKEMON_ATK_BOOST',
    token: 'VAR_TOTEM_POKEMON_ATK_BOOST',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9151),
  },
  {
    key: 'VAR_TOTEM_POKEMON_DEF_BOOST',
    token: 'VAR_TOTEM_POKEMON_DEF_BOOST',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9152),
  },
  {
    key: 'VAR_TOTEM_POKEMON_SP_ATK_BOOST',
    token: 'VAR_TOTEM_POKEMON_SP_ATK_BOOST',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9153),
  },
  {
    key: 'VAR_TOTEM_POKEMON_SP_DEF_BOOST',
    token: 'VAR_TOTEM_POKEMON_SP_DEF_BOOST',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9154),
  },
  {
    key: 'VAR_TOTEM_POKEMON_SPEED_BOOST',
    token: 'VAR_TOTEM_POKEMON_SPEED_BOOST',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9155),
  },
  {
    key: 'VAR_TOTEM_POKEMON_ACCURACY_BOOST',
    token: 'VAR_TOTEM_POKEMON_ACCURACY_BOOST',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9156),
  },
  {
    key: 'VAR_TOTEM_POKEMON_EVASION_BOOST',
    token: 'VAR_TOTEM_POKEMON_EVASION_BOOST',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9157),
  },
  {
    key: 'VAR_TOTEM_MESSAGE',
    token: 'VAR_TOTEM_MESSAGE',
    site: 'AbilityOnEntryHandler totem block',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9160),
  },
  {
    key: 'FLAG_SHINY_CREATION',
    token: 'FLAG_SHINY_CREATION',
    site: 'CreateBoxMon shiny roll',
    citation: cite(`${UPSTREAM_SRC}/pokemon.c`, 499),
  },
  {
    key: 'FLAG_ALPHA_CREATION',
    token: 'FLAG_ALPHA_CREATION',
    site: 'CreateBoxMon alpha flag',
    citation: cite(`${UPSTREAM_SRC}/pokemon.c`, 504),
  },
  {
    key: 'FLAG_SYS_INVERSE_BATTLE',
    token: 'FLAG_SYS_INVERSE_BATTLE',
    site: 'IsInverseBattle',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 8028),
  },
  {
    key: 'FLAG_SYS_DISABLE_AUTOHEAL',
    token: 'FLAG_SYS_DISABLE_AUTOHEAL',
    site: 'BattleMain CB2 autoheal',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 844),
  },
  {
    key: 'VAR_BATTLE_FIELD_EFFECT_TYPE',
    token: 'VAR_BATTLE_FIELD_EFFECT_TYPE',
    site: 'TryToSetFieldEffect',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 4163),
  },
  {
    key: 'VAR_BATTLE_FIELD_ID',
    token: 'VAR_BATTLE_FIELD_ID',
    site: 'TryToSetFieldEffect',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 4164),
  },
  {
    key: 'VAR_MONOTYPE_BOOST',
    token: 'VAR_MONOTYPE_BOOST',
    site: 'IsPlayerPartyMonotypeType',
    citation: cite(`${UPSTREAM_SRC}/field_specials.c`, 4943),
  },
  {
    key: 'VAR_TRAINER_PRIZE_BP',
    token: 'VAR_TRAINER_PRIZE_BP',
    site: 'Cmd_getmoneyreward',
    citation: cite(`${UPSTREAM_SRC}/battle_script_commands.c`, 5809),
  },
  {
    key: 'setweather',
    token: 'setweather',
    site: 'ScrCmd_setweather',
    citation: cite(`${UPSTREAM_SRC}/scrcmd.c`, 724),
  },
  {
    key: 'setfieldeffectargument',
    token: 'setfieldeffectargument',
    site: 'gFieldEffectArguments',
    citation: cite(`${UPSTREAM}/include/field_effect.h`, 8),
  },
  {
    key: 'starttagbattle',
    token: 'starttagbattle',
    site: 'FLAG_TAG_BATTLE reader',
    citation: cite(`${UPSTREAM_SRC}/battle_setup.c`, 1470),
  },
  {
    key: 'HealPlayerParty',
    token: 'HealPlayerParty',
    site: 'BattleMain autoheal',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 844),
  },
  {
    key: 'setwildbattlewithcustommoves',
    token: 'setwildbattlewithcustommoves',
    site: 'ScrCmd_setwildbattlewithcustommoves',
    citation: cite(`${UPSTREAM_SRC}/scrcmd.c`, 2620),
  },
]

export interface StaticUnitSpec {
  key: string
  token: string
  site: string
  scope: string
  citation: string
  evidence?: UnitEvidence
}

export const BATTLE_TYPE_SPECS: ReadonlyArray<StaticUnitSpec> = [
  {
    key: 'BATTLE_TYPE_TRAINER',
    token: 'BATTLE_TYPE_TRAINER',
    site: 'BattleSetup_StartTrainerBattle',
    scope: 'all 932 trainer battles',
    citation: cite(`${UPSTREAM_SRC}/battle_setup.c`, 1242),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
  {
    key: 'BATTLE_TYPE_DOUBLE',
    token: 'BATTLE_TYPE_DOUBLE',
    site: 'BattleSetup_StartTrainerBattle',
    // battle_setup.c:1240 sets this only when two trainers approach; the driver's
    // session.ts:238 sets BATTLE_TYPE_TRAINER alone, and aiCheckBadMove.ts:28
    // records that battleTypeFlags never carries the double bit in this build.
    scope: 'not started by the driver: session.ts:238 sets BATTLE_TYPE_TRAINER only',
    citation: cite(`${UPSTREAM_SRC}/battle_setup.c`, 1240),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
  {
    key: 'BATTLE_TYPE_TWO_OPPONENTS',
    token: 'BATTLE_TYPE_TWO_OPPONENTS',
    site: 'BattleSetup_StartTrainerBattle',
    scope: 'two approaching trainers',
    citation: cite(`${UPSTREAM_SRC}/battle_setup.c`, 1240),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
  {
    key: 'BATTLE_TYPE_INGAME_PARTNER',
    token: 'BATTLE_TYPE_INGAME_PARTNER',
    site: 'BattleTower multi partner',
    scope: 'Battle Tower multi with an in-game partner',
    citation: cite(`${UPSTREAM_SRC}/battle_tower.c`, 1526),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
  {
    key: 'FLAG_TAG_BATTLE',
    token: 'FLAG_TAG_BATTLE',
    site: 'GetTrainerALoseText / GetTrainerBLoseText',
    scope: '26 starttagbattle calls in 6 maps',
    citation: cite(`${UPSTREAM_SRC}/battle_setup.c`, 1470),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
]

export const DIFFICULTY_FLAG_SPECS: ReadonlyArray<StaticUnitSpec> = [
  {
    key: 'gameDifficulty',
    token: 'gSaveBlock2Ptr->gameDifficulty',
    site: 'CreateNPCTrainerParty',
    scope: 'DIFFICULTY_EASY / DIFFICULTY_ACE / DIFFICULTY_ELITE / DIFFICULTY_HELL party selection',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1735),
  },
  {
    key: 'doubleBattleMode',
    token: 'doubleBattleMode',
    site: 'CreateNPCTrainerParty',
    scope: 'save-block double-battle mode toggle',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1757),
  },
  {
    key: 'HELL_MODE_EXTRA_LEVELS_FLAG',
    token: 'HELL_MODE_EXTRA_LEVELS_FLAG',
    site: 'CreateNPCTrainerParty partyData switch',
    scope: 'hell difficulty extra levels',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1805),
  },
  {
    key: 'HELL_MODE_0_IVS_FLAG',
    token: 'HELL_MODE_0_IVS_FLAG',
    site: 'CalculateMonStatsMaster',
    scope: 'hell difficulty zero IVs',
    citation: cite(`${UPSTREAM_SRC}/pokemon.c`, 989),
  },
  {
    key: 'enableEvs',
    token: 'enableEvs',
    site: 'CalculateMonStatsMaster',
    scope: 'save-block EV toggle',
    citation: cite(`${UPSTREAM_SRC}/pokemon.c`, 996),
  },
  {
    key: 'speedDown',
    token: 'speedDown',
    site: 'CalculateMonStatsMaster',
    scope: 'iron-pill zero Speed IV',
    citation: cite(`${UPSTREAM_SRC}/pokemon.c`, 994),
    // C: `if (speedDown) speedIV = 0;` (pokemon.c:994). Every engine test only
    // builds fixtures with `speedDown: false` / `ironPill: false`, so the name is
    // registered (stats.ts:93, buildParty.ts:99) but no test asserts the effect.
    evidence: { testPattern: /(?:speedDown|ironPill)\s*:\s*true\b/ },
  },
  {
    key: 'GetHighestLevelInPlayerParty',
    token: 'GetHighestLevelInPlayerParty',
    site: 'CreateNPCTrainerParty level derivation',
    scope: 'enemy level = player level + partyData.lvl + extraLevels',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1819),
  },
  {
    key: 'GetLevelCap',
    token: 'GetLevelCap',
    site: 'Cmd_getexp',
    scope: 'level-cap EXP stop',
    citation: cite(`${UPSTREAM_SRC}/battle_script_commands.c`, 3511),
  },
  {
    key: 'RegisterTrainerBattleEvents',
    token: 'RegisterTrainerBattleEvents',
    site: 'CreateNPCTrainerParty',
    scope: 'hell-mode extra trainer skills',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1773),
  },
]

export const TRAINER_FLAG_SPECS: ReadonlyArray<StaticUnitSpec> = [
  {
    key: 'risky',
    token: 'AI_FLAG_RISKY',
    site: 'trainers.json risky -> AI_FLAG_RISKY',
    scope: '4 trainers',
    citation: cite(CODEGEN_PATH, 181),
    evidence: {
      evidenceToken: 'AI_FLAG_RISKY',
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern: /\b4:\s*\(.*=>\s*aiRisky\(/,
    },
  },
  {
    key: 'preferStall',
    token: 'AI_FLAG_STALL',
    site: 'trainers.json preferStall -> AI_FLAG_STALL',
    scope: '1 trainer',
    citation: cite(CODEGEN_PATH, 182),
    evidence: {
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern: /\bif\s*\(hasFlag\(state\.aiFlags,\s*AI_FLAG_STALL\)\)\s*\{/,
      testPattern: /without AI_FLAG_STALL/,
    },
  },
  {
    key: 'preferStatus',
    token: 'AI_FLAG_PREFER_STATUS_MOVES',
    site: 'trainers.json preferStatus -> AI_FLAG_PREFER_STATUS_MOVES',
    scope: '6 trainers',
    citation: cite(CODEGEN_PATH, 183),
    evidence: {
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern: /\bhasFlag\(state\.aiFlags,\s*AI_FLAG_PREFER_STATUS_MOVES\)/,
      testPattern: /AI_FLAG_PREFER_STATUS_MOVES rewards a status move/,
    },
  },
  {
    key: 'noSwitching',
    token: 'AI_FLAG_DISABLE_SWITCHING',
    site: 'trainers.json noSwitching -> AI_FLAG_DISABLE_SWITCHING',
    scope: '5 trainers',
    citation: cite(CODEGEN_PATH, 184),
  },
  {
    key: 'forcedDouble',
    token: 'forcedDouble',
    site: 'trainers.json forcedDouble -> doubleBattle = TRUE',
    scope: '78 trainers',
    citation: cite(CODEGEN_PATH, 207),
    // TrainerPartyGenerator.kt:207 emits `doubleBattle = TRUE`, which would make
    // the fight a double. In the engine the field is only read by `aiFlags.ts`
    // to OR AI_FLAG_DOUBLE_BATTLE; nothing outside it changes the number of
    // active battlers (session.ts builds exactly two battlers), so the C effect
    // is unmodelled and the fight stays singles.
    evidence: {
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern: /\bbattlersCount\s*(?::|\+?=(?!=))/,
    },
  },
  {
    key: 'trainerClass',
    token: 'trainerClass',
    site: 'trainers.json class -> trainerClass',
    scope: '72 trainer classes',
    citation: cite(CODEGEN_PATH, 203),
  },
  {
    key: 'encounterMusic_gender',
    token: 'F_TRAINER_FEMALE',
    site: 'trainers.json gender -> encounterMusic_gender',
    scope: 'trainer-mon gender bias',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1794),
  },
  {
    key: 'AI_FLAG_CHECK_BAD_MOVE',
    token: 'AI_FLAG_CHECK_BAD_MOVE',
    site: 'always-on AI flags',
    scope: 'all 932 trainers',
    citation: cite(CODEGEN_PATH, 187),
    evidence: {
      evidenceToken: 'AI_FLAG_CHECK_BAD_MOVE',
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern: /\b0:\s*\(.*=>\s*aiCheckBadMove\(/,
    },
  },
  {
    key: 'AI_FLAG_TRY_TO_FAINT',
    token: 'AI_FLAG_TRY_TO_FAINT',
    site: 'always-on AI flags',
    scope: 'all 932 trainers',
    citation: cite(CODEGEN_PATH, 188),
    evidence: {
      evidenceToken: 'AI_FLAG_TRY_TO_FAINT',
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern: /\b1:\s*\(.*=>\s*aiTryToFaint\(/,
      testPattern: /AI_FLAG_TRY_TO_FAINT and the attacker already KOs/,
    },
  },
  {
    key: 'AI_FLAG_CHECK_VIABILITY',
    token: 'AI_FLAG_CHECK_VIABILITY',
    site: 'always-on AI flags',
    scope: 'all 932 trainers',
    citation: cite(CODEGEN_PATH, 189),
    evidence: {
      evidenceToken: 'AI_FLAG_CHECK_VIABILITY',
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern: /\b2:\s*\(.*=>\s*aiCheckViability\(/,
    },
  },
  {
    key: 'AI_FLAG_CHECK_FOE',
    token: 'AI_FLAG_CHECK_FOE',
    site: 'always-on AI flags',
    scope: 'all 932 trainers',
    citation: cite(CODEGEN_PATH, 190),
    evidence: {
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
    },
  },
  {
    key: 'AI_FLAG_SMART_SWITCHING',
    token: 'AI_FLAG_SMART_SWITCHING',
    site: 'always-on AI flags',
    scope: 'all 932 trainers',
    citation: cite(CODEGEN_PATH, 191),
    evidence: {
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern:
        /\bhasFlag\(state\.aiFlags,\s*AI_FLAG_SMART_SWITCHING\)\s*&&\s*onlyPhysicalMoves\b/,
      testPattern: /Smart Switching, and only physical moves/,
    },
  },
  {
    key: 'AI_FLAG_HP_AWARE',
    token: 'AI_FLAG_HP_AWARE',
    site: 'always-on AI flags',
    scope: 'all 932 trainers',
    citation: cite(CODEGEN_PATH, 192),
    evidence: {
      evidenceToken: 'AI_FLAG_HP_AWARE',
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern: /\b8:\s*\(.*=>\s*aiHPAware\(/,
    },
  },
  {
    key: 'AI_FLAG_WILL_SUICIDE',
    token: 'AI_FLAG_WILL_SUICIDE',
    site: 'always-on AI flags',
    scope: 'all 932 trainers',
    citation: cite(CODEGEN_PATH, 193),
    evidence: {
      productionExcludeFiles: ['web/src/engine/sim/ai/aiFlags.ts'],
      productionLinePattern:
        /\bconst willSuicide = hasFlag\(state\.aiFlags,\s*AI_FLAG_WILL_SUICIDE\)/,
    },
  },
]

export interface ScriptEventSpec {
  key: string
  token: string
  site: string
  scope: string
  citation: string
  evidence?: UnitEvidence
}

export const SCRIPT_EVENT_SPECS: ReadonlyArray<ScriptEventSpec> = [
  {
    key: 'BattleScript_WildTotemBoostActivated',
    token: 'BattleScript_WildTotemBoostActivated',
    site: 'AbilityOnEntryHandler totem message switch (default)',
    scope: '5 totem maps (all but Haxorus)',
    citation: cite(`${UPSTREAM}/data/battle_scripts_1.s`, 11710),
  },
  {
    key: 'BattleScript_HaxorusTotemBoostActivated',
    token: 'BattleScript_HaxorusTotemBoostActivated',
    site: 'AbilityOnEntryHandler totem message switch',
    scope: 'MeteorFalls_HaxorusRoom',
    citation: cite(`${UPSTREAM}/data/battle_scripts_1.s`, 11723),
  },
  {
    key: 'BattleScript_LegendaryPokemonBallBlock',
    token: 'BattleScript_LegendaryPokemonBallBlock',
    site: 'Cmd_throwball totem branch',
    scope: '6 totem wild battles',
    citation: cite(`${UPSTREAM}/data/battle_scripts_2.s`, 270),
  },
  {
    key: 'BattleScript_SetTrickRoomFromScript',
    token: 'BattleScript_SetTrickRoomFromScript',
    site: 'TryToSetFieldEffect BATTLE_FIELD_EFFECT_ROOM',
    scope: 'MossdeepCity_Gym course (VAR_BATTLE_FIELD_ID = STATUS_FIELD_TRICK_ROOM)',
    citation: cite(`${UPSTREAM}/data/battle_scripts_1.s`, 9670),
  },
  {
    key: 'BattleScript_SetGravityFromScript',
    token: 'BattleScript_SetGravityFromScript',
    site: 'TryToSetFieldEffect BATTLE_FIELD_EFFECT_ROOM',
    scope: 'EverGrandeCity_ChampionsRoom Steven doubles (VAR_BATTLE_FIELD_ID = STATUS_FIELD_GRAVITY)',
    citation: cite(`${UPSTREAM}/data/battle_scripts_1.s`, 9827),
  },
  {
    key: 'BattleScript_SetMonotypeEffect_Normal',
    token: 'BattleScript_SetMonotypeEffect_Normal',
    site: 'TryToSetMonotypeChampEffect',
    scope: 'EvergrandeCity_MonoChampRoom_1 (18 type variants)',
    citation: cite(`${UPSTREAM}/data/battle_scripts_1.s`, 9682),
  },
]

/** First line in battle_events.c naming an event, else its header definition. */
export function buildBattleEventCitations(eventSource: string, headerSource: string): Map<string, string> {
  const sourceLines = eventSource.split('\n')
  const headerLines = headerSource.split('\n')
  const citations = new Map<string, string>()
  const events = new Set<string>()
  const collector = /\bBATTLE_EVENT_[A-Z0-9_]+\b/g
  for (const line of sourceLines) {
    for (const match of line.matchAll(collector)) events.add(match[0])
  }
  for (const line of headerLines) {
    for (const match of line.matchAll(collector)) events.add(match[0])
  }
  for (const event of events) {
    let citation: string | undefined
    const casePattern = new RegExp(`^\\s*case\\s+${event}\\s*:`)
    for (let index = 0; index < sourceLines.length; index += 1) {
      if (casePattern.test(sourceLines[index])) {
        citation = cite(BATTLE_EVENTS_C, index + 1)
        break
      }
    }
    if (!citation) {
      for (let index = 0; index < sourceLines.length; index += 1) {
        if (tokenAppears(sourceLines[index], event)) {
          citation = cite(BATTLE_EVENTS_C, index + 1)
          break
        }
      }
    }
    if (!citation) {
      for (let index = 0; index < headerLines.length; index += 1) {
        if (tokenAppears(headerLines[index], event)) {
          citation = cite(BATTLE_EVENTS_H, index + 1)
          break
        }
      }
    }
    if (citation) citations.set(event, citation)
  }
  return citations
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface EnvironmentInventoryOptions {
  mapScripts?: ReadonlyArray<MapScript>
  trainers?: ReadonlyArray<TrainerRecord>
  battleEventRows?: ReadonlyArray<EncounterBattleEventRow>
  eventSource?: string
  eventHeaderSource?: string
  /** Joined production corpus; used by synthetic tests instead of `productionFiles`. */
  productionSource?: string
  /** Per-file production corpus, so `productionFiles` evidence can scope a match. */
  productionFiles?: ReadonlyArray<SourceFile>
  testSources?: ReadonlyArray<SourceFile>
  allowlist?: ReadonlyArray<EnvironmentAllowlistEntry>
  extraMapSetupSpecs?: ReadonlyArray<MapSetupSpec>
  extraScriptEventSpecs?: ReadonlyArray<ScriptEventSpec>
}

function fileOf(citation: string): string {
  return citation.replace(/:\d+$/, '')
}

export function runInventory(options: EnvironmentInventoryOptions = {}): EnvironmentInventoryResult {
  const allowlist = options.allowlist ?? DEFAULT_ALLOWLIST
  const allowlistProblems = validateAllowlist(allowlist)
  if (allowlistProblems.length > 0) throw new Error(allowlistProblems.join('\n'))

  const scripts = options.mapScripts ?? loadMapScripts()
  const trainers = options.trainers ?? loadTrainers()
  const battleEventRows = options.battleEventRows ?? loadBattleEventRows()
  const eventSource = options.eventSource ?? readFileSync(join(REPO_ROOT, BATTLE_EVENTS_C), 'utf-8')
  const eventHeaderSource =
    options.eventHeaderSource ?? readFileSync(join(REPO_ROOT, BATTLE_EVENTS_H), 'utf-8')
  const productionFiles: ReadonlyArray<SourceFile> =
    options.productionFiles ??
    (options.productionSource !== undefined
      ? [{ file: JOINED_PRODUCTION_FILE, source: options.productionSource }]
      : loadEngineProductionFiles())
  const testSources = options.testSources ?? loadEngineTestFiles()
  const mapSetupSpecs = [...MAP_SETUP_SPECS, ...(options.extraMapSetupSpecs ?? [])]
  const scriptEventSpecs = [...SCRIPT_EVENT_SPECS, ...(options.extraScriptEventSpecs ?? [])]
  const allowlistByKey = new Map(allowlist.map((entry) => [entry.key, entry]))

  const units: EnvironmentUnit[] = []

  const pushUnit = (
    kind: EnvironmentUnitKind,
    spec: {
      key: string
      token: string
      site: string
      scope: string
      citation: string
      evidence?: UnitEvidence
    },
    trainerIds: string[] = [],
  ): void => {
    const allow = allowlistByKey.get(spec.key)
    const classification = classifyToken(
      spec.token,
      productionFiles,
      testSources,
      spec.evidence,
    )
    units.push({
      kind,
      key: spec.key,
      token: spec.token,
      site: spec.site,
      scope: spec.scope,
      file: allow ? fileOf(allow.cite) : fileOf(spec.citation),
      citation: allow ? allow.cite : spec.citation,
      status: allow ? 'allowlisted' : classification.status,
      registeredUntested: allow ? false : classification.registeredUntested,
      testFile: classification.testFile,
      trainerIds: [...trainerIds].sort(),
    })
  }

  for (const spec of mapSetupSpecs) {
    const occurrences = tokenLines(scripts, spec.token)
    const maps = [...new Set(occurrences.map((hit) => hit.map))].sort()
    pushUnit(
      'map-setup',
      {
        key: spec.key,
        token: spec.token,
        site: spec.site,
        scope:
          maps.length > 0
            ? `${maps.length} map(s), ${occurrences.length} line(s): ${maps.join(', ')}`
            : '0 maps',
        citation: spec.citation,
        evidence: spec.evidence,
      },
      scanTrainerIds(scripts, maps),
    )
  }

  for (const spec of BATTLE_TYPE_SPECS) pushUnit('battle-type', spec)
  for (const spec of DIFFICULTY_FLAG_SPECS) pushUnit('difficulty-flag', spec)
  for (const spec of TRAINER_FLAG_SPECS) pushUnit('trainer-flag', spec)

  const eventRowsByEvent = new Map<string, EncounterBattleEventRow[]>()
  for (const row of battleEventRows) {
    const list = eventRowsByEvent.get(row.event) ?? []
    list.push(row)
    eventRowsByEvent.set(row.event, list)
  }
  const eventCitations = buildBattleEventCitations(eventSource, eventHeaderSource)
  for (const event of [...eventRowsByEvent.keys()].sort()) {
    const rows = eventRowsByEvent.get(event) ?? []
    const maps = [...new Set(rows.map((row) => row.map).filter((map): map is string => Boolean(map)))].sort()
    const citation = eventCitations.get(event)
    if (!citation) throw new Error(`battle event ${event} has no C or header citation`)
    pushUnit('battle-event', {
      key: event,
      token: event,
      site: 'battle_events.c switch',
      scope: `${rows.length} encounter row(s), ${maps.length} map(s)`,
      citation,
    })
  }

  for (const spec of scriptEventSpecs) pushUnit('script-event', spec)

  const summaries: EnvironmentUnitKindSummary[] = UNIT_KIND_ORDER.map((kind) => {
    const subset = units.filter((unit) => unit.kind === kind)
    return {
      kind,
      defined: subset.length,
      ported: subset.filter((unit) => unit.status === 'ported').length,
      registeredUntested: subset.filter(
        (unit) => unit.status === 'unported' && unit.registeredUntested,
      ).length,
      unported: subset.filter((unit) => unit.status === 'unported').length,
      unclassified: subset.filter((unit) => unit.status === 'unclassified').length,
      allowlisted: subset.filter((unit) => unit.status === 'allowlisted').length,
    }
  })

  const unportedByKind: UnportedByKind[] = summaries.map((summary) => ({
    kind: summary.kind,
    unported: summary.unported,
    registeredUntested: summary.registeredUntested,
  }))

  const total = (key: keyof EnvironmentUnitKindSummary): number =>
    summaries.reduce((sum, summary) => sum + (summary[key] as number), 0)

  const mapScan = scanMapScripts(scripts)

  return {
    units,
    summaries,
    totalDefined: total('defined'),
    totalPorted: total('ported'),
    totalUnported: total('unported'),
    totalRegisteredUntested: total('registeredUntested'),
    totalUnclassified: total('unclassified'),
    totalAllowlisted: total('allowlisted'),
    unportedByKind,
    mapFileCount: scripts.length,
    mapsWithSetup: mapScan.maps.length,
    battleEventRowCount: battleEventRows.length,
    distinctBattleEventCount: eventRowsByEvent.size,
    trainerCount: trainers.length,
  }
}

// ---------------------------------------------------------------------------
// Doc generation
// ---------------------------------------------------------------------------

function statusLabel(unit: EnvironmentUnit): string {
  if (unit.status === 'unported' && unit.registeredUntested) {
    return 'unported (registered, untested)'
  }
  return unit.status
}

export function generateEnvironmentInventoryDoc(
  result: EnvironmentInventoryResult,
  sourcesLockPath: string = SOURCES_LOCK_PATH,
): string {
  const sourcesLock = JSON.parse(readFileSync(sourcesLockPath, 'utf-8')) as {
    game_version?: string
    sources?: Record<string, { sha?: string }>
  }
  const elitereduxSourceSha = sourcesLock.sources?.['eliteredux-source']?.sha
  const erConfigSha = sourcesLock.sources?.['er-config']?.sha
  const gameVersion = sourcesLock.game_version
  if (!elitereduxSourceSha || !erConfigSha || !gameVersion) {
    throw new Error(`sources.lock.json at ${sourcesLockPath} is missing required fields`)
  }

  const lines: string[] = []
  lines.push('# Environment and Scripted-Condition Completeness Inventory')
  lines.push('')
  lines.push(
    'Static inventory of every environment, battle-start and scripted-condition unit that can change how a battle plays out,',
  )
  lines.push('against the battle simulator. It covers no species, move, ability or item data.')
  lines.push('')
  lines.push(
    `- **Source Commit (eliteredux-source)**: \`${elitereduxSourceSha}\` (game version \`${gameVersion}\`)`,
  )
  lines.push(`- **Source Commit (er-config)**: \`${erConfigSha}\``)
  lines.push(
    '- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/environmentInventory.test.ts`',
  )
  lines.push('')

  lines.push('## Unit Kinds and Classification Rules')
  lines.push('')
  lines.push(
    'A unit is **ported** only when its token appears in both a qualifying non-test engine source file and an engine',
  )
  lines.push(
    'test file, after comments are stripped. Qualifying production files are all non-test files under `web/src/engine/`',
  )
  lines.push(
    'except `sim/driver/`, plus the four loader files `session.ts`, `runBattle.ts`, `buildParty.ts` and `loadSimData.ts`.',
  )
  lines.push(
    '`registered, untested` means production names the token but no qualifying test does; it is counted as unported. A',
  )
  lines.push('mention in a comment is not evidence, and neither is a name alone:')
  lines.push('')
  lines.push(
    '- `speedDown` requires a test that sets `speedDown: true` or `ironPill: true`. Every current fixture sets the flag to',
  )
  lines.push(
    '  `false`, so production implements the C rule (`src/pokemon.c:994`, `if (speedDown) speedIV = 0;`) but no test asserts it.',
  )
  lines.push(
    '- Battle-type units must have the flag assigned in the driver battle-start path (`session.ts`, `runBattle.ts`,',
  )
  lines.push(
    '  `buildParty.ts`). `BATTLE_TYPE_TRAINER` qualifies (`session.ts:238`); `BATTLE_TYPE_DOUBLE` does not, so the driver',
  )
  lines.push('  never runs a double battle regardless of a constant or a hand-built test state.')
  lines.push(
    '- `forcedDouble` additionally requires a production line outside `aiFlags.ts` that changes the number of active',
  )
  lines.push(
    '  battlers. The engine only ORs `AI_FLAG_DOUBLE_BATTLE`; the codegen\'s `doubleBattle = TRUE`',
  )
  lines.push('  (`TrainerPartyGenerator.kt:207`) is unmodelled, so the fight stays singles.')
  lines.push('')
  lines.push(
    'Allowlisted units require an exact pinned C `file:line` whose line is quoted in the reason. The allowlist is not',
  )
  lines.push(
    'empty: eight units are provably battle-inert (cosmetics, overworld weather, field-effect arguments, prizes).',
  )
  lines.push('')
  lines.push('1. **map-setup**: a flag/var/special/script command set by a map script before a battle.')
  lines.push(
    `   The scan covers all ${result.mapFileCount} \`data/maps/*/scripts.pory\` files; ${result.mapsWithSetup} contain at least one of`,
  )
  lines.push(
    '   `setweather` (substring), `setfieldeffectargument`, `FLAG_TOTEM_BATTLE`, `FLAG_SYS_INVERSE_BATTLE`,',
  )
  lines.push('   `VAR_BATTLE_FIELD_EFFECT_TYPE` or `VAR_MONOTYPE_BOOST`.')
  lines.push(
    '2. **battle-type**: a `BATTLE_TYPE_*` flag or `FLAG_TAG_BATTLE` set by a battle-start path.',
  )
  lines.push(
    '3. **difficulty-flag**: a save-block difficulty/settings flag, or a C rule deriving level, IVs, EVs or party selection.',
  )
  lines.push('4. **trainer-flag**: a `trainers.json` field, or an `AI_FLAG_*` bit the codegen mints from one.')
  lines.push(
    '5. **battle-event**: one distinct `event` in `data/v2.65beta/encounters.json` `battleEvents`, with the C handler line.',
  )
  lines.push('6. **script-event**: a battle script label pushed by one of the scripted setups above.')
  lines.push('')
  lines.push(
    '`registerbattleevent` calls in map scripts are extracted into `encounters.json`, so they are represented by the',
  )
  lines.push(
    'battle-event units rather than a separate script-command unit. The sim loads that table at `loadSimData.ts:108-109`.',
  )
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push(
    '| Unit kind | Defined | Ported | Registered, untested | Unported | Unclassified | Allowlisted |',
  )
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const summary of result.summaries) {
    lines.push(
      `| \`${summary.kind}\` | ${summary.defined} | ${summary.ported} | ${summary.registeredUntested} | ${summary.unported} | ${summary.unclassified} | ${summary.allowlisted} |`,
    )
  }
  lines.push(
    `| **total** | **${result.totalDefined}** | **${result.totalPorted}** | **${result.totalRegisteredUntested}** | **${result.totalUnported}** | **${result.totalUnclassified}** | **${result.totalAllowlisted}** |`,
  )
  lines.push('')
  lines.push(
    `Trainers in \`data/v2.65beta/trainers.json\`: ${result.trainerCount}. \`battleEvents\` rows: ${result.battleEventRowCount} across ${result.distinctBattleEventCount} distinct events. Map scripts scanned: ${result.mapFileCount}; maps with a setup token: ${result.mapsWithSetup}.`,
  )
  lines.push('')

  lines.push('## Unported Units by Kind')
  lines.push('')
  lines.push('| Unit kind | Unported | Registered, untested |')
  lines.push('| --- | ---: | ---: |')
  for (const group of result.unportedByKind) {
    lines.push(`| \`${group.kind}\` | ${group.unported} | ${group.registeredUntested} |`)
  }
  lines.push('')

  const pushSection = (kind: EnvironmentUnitKind, title: string): void => {
    lines.push(`## ${title}`)
    lines.push('')
    const subset = result.units
      .filter((unit) => unit.kind === kind)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    if (subset.length === 0) {
      lines.push('None.')
      lines.push('')
      return
    }
    lines.push('| Unit key | Fights / maps | C citation | Status | Test file |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const unit of subset) {
      const testFile = unit.testFile ? `\`${unit.testFile}\`` : 'none'
      lines.push(
        `| \`${unit.key}\` | ${unit.scope} | \`${unit.citation}\` | ${statusLabel(unit)} | ${testFile} |`,
      )
    }
    lines.push('')
  }

  pushSection('map-setup', 'Map-Setup Units')
  pushSection('battle-type', 'Battle-Type Units')
  pushSection('difficulty-flag', 'Difficulty-Flag Units')
  pushSection('trainer-flag', 'Trainer-Flag Units')
  pushSection('battle-event', 'Battle-Event Units')
  pushSection('script-event', 'Script-Event Units')

  lines.push('## Unresolved Terms')
  lines.push('')
  lines.push(
    '- **`starttagbattle`**: the asm macro expansion is not in the fetched tree. Only the `FLAG_TAG_BATTLE` readers',
  )
  lines.push(
    '  (`src/battle_setup.c:1470`, `:1480`) and the `BATTLE_TYPE_*` assignments in `src/battle_setup.c:1240-1242` were read;',
  )
  lines.push('  the exact flag set by the command is inferred, not read.')
  lines.push(
    '- **`setfieldeffectargument`**: the macro body is not fetched. `gFieldEffectArguments` is declared at',
  )
  lines.push(
    '  `include/field_effect.h:8`; every reader found is field-effect, party-menu or overworld code, so the unit is',
  )
  lines.push('  allowlisted as inert for battle.')
  lines.push(
    '- **Hell-mode trainer skills**: `src/battle_events.c:502` includes `data/hell_trainer_skills.h`, which is absent from',
  )
  lines.push(
    '  the pinned tree. The events registered by `RegisterTrainerBattleEvents` therefore cannot be enumerated; the unit is',
  )
  lines.push('  reported unported rather than guessed.')
  lines.push(
    '- **`setwildbattlewithcustommoves`**: implementation read at `src/scrcmd.c:2620` (species, level, item, four moves,',
  )
  lines.push('  ability, nature, six EV arguments). The sim takes the resulting party from its caller; the command itself is',
  )
  lines.push('  not simulated.')
  lines.push(
    '- **`setweather`**: `ScrCmd_setweather` (`src/scrcmd.c:720-726`) only calls `SetSav1Weather`; `gBattleWeather` is',
  )
  lines.push('  zeroed at `src/battle_main.c:2721`, so overworld weather cannot enter a battle.')
  lines.push(
    '- **Link/multi battles**: `BATTLE_TYPE_MULTI` is only set by `src/battle_tower.c:1526` (Battle Tower), which no scanned',
  )
  lines.push('  story map starts, so it is not defined as a unit here.')
  lines.push('')

  return `${lines.join('\n')}\n`
}
