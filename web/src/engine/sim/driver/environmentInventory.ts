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
  | 'hell-trainer-skill'
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
   * Test evidence must be a stripped test file in which the token appears inside
   * an `it(` / `test(` block that also contains `expect(`.
   */
  testMustAssert?: boolean
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
  /**
   * Every entry must match the comment-stripped production source of that
   * repo-relative file, else the unit cannot be `ported`.
   */
  alsoRequires?: ReadonlyArray<{ file: string; pattern: RegExp }>
  /**
   * Production evidence is a `case '<token>':` label in a production file whose
   * body is live (not bare break, bare return, or closing brace).
   */
  caseBodyToken?: string
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
  /** Production file and line providing qualifying evidence, or null. */
  productionEvidence?: string | null
  /** Evidence configuration used to qualify this unit. */
  evidence?: UnitEvidence
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
  tagBattleRowCount: number
  tagBattleMapCount: number
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
  {
    key: 'BATTLE_EVENT_STICKY_WEB',
    reason:
      '`return EXEC_BATTLE_EVENTS_ALL_CLEAR;` is the post-switch fallthrough: BATTLE_EVENT_STICKY_WEB has no case (src/battle_events.c has only BATTLE_EVENT_PERMA_STICKY_WEB at :325 and :475), so the event cannot change battle state.',
    cite: 'pipeline/.upstream/eliteredux-source/src/battle_events.c:362',
  },
]

export const UNIT_KIND_ORDER: ReadonlyArray<EnvironmentUnitKind> = [
  'map-setup',
  'battle-type',
  'difficulty-flag',
  'trainer-flag',
  'hell-trainer-skill',
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
const HELL_TRAINER_SKILLS_H = `${UPSTREAM_SRC}/data/hell_trainer_skills.h`
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
  productionLinePattern: /\bbattleTypeFlags\s*(?:\|=|:|=)/,
}

const BATTLE_TYPE_TRAINER_EVIDENCE: UnitEvidence = {
  productionFiles: BATTLE_TYPE_DRIVER_FILES,
  productionLinePattern: /\bbattleTypeFlags\s*:\s*BATTLE_TYPE_TRAINER\s*,?\s*$/,
  testPattern: /\bcreateSession\b/,
  testMustAssert: true,
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

export interface TagBattleRow {
  guard?: string | null
  map: string
  script: string
  trainers: string[]
}

/** `tagBattles` rows from encounters.json: two-opponent fights behind a guard. */
export function loadTagBattleRows(path: string = ENCOUNTERS_PATH): TagBattleRow[] {
  const data = JSON.parse(readFileSync(path, 'utf-8')) as {
    tagBattles?: TagBattleRow[]
  }
  return data.tagBattles ?? []
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
/**
 * The `multi_2_vs_2` script macro takes no parentheses in the map scripts:
 * `multi_2_vs_2 TRAINER_A, text, TRAINER_B, text, PARTNER_ID, TRAINER_BACK_PIC_X`.
 * Only the first and third arguments are opponents; the fifth is the in-game
 * partner and the sixth a `TRAINER_BACK_PIC_*` sprite constant.
 */
const MULTI_CALL_RE = /\bmulti_2_vs_2\b([^\n]*)/

function multiCallTrainerIds(line: string): string[] {
  const match = line.match(MULTI_CALL_RE)
  if (!match) return []
  const args = match[1].split(',')
  const opponents = [args[0], args[2]].filter((arg): arg is string => arg !== undefined)
  const ids: string[] = []
  for (const arg of opponents) {
    for (const id of arg.matchAll(TRAINER_ID_RE)) {
      if (id[0] !== 'TRAINER_NONE') ids.push(id[0])
    }
  }
  return ids
}

/** Trainer ids passed to trainer-battle/starttagbattle/multi_2_vs_2 calls in the given maps. */
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
      for (const id of multiCallTrainerIds(line)) ids.add(id)
    }
  }
  return [...ids].sort()
}

// ---------------------------------------------------------------------------
// Hell trainer skills
// ---------------------------------------------------------------------------

export interface HellTrainerSkillRow {
  trainer: string
  slot: string
  event: string
  data0: string
  data1: string
  line: number
}

export function parseHellTrainerSkills(src: string): HellTrainerSkillRow[] {
  const rows: HellTrainerSkillRow[] = []
  let currentTrainer: string | null = null
  const lines = src.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const commentIdx = rawLine.indexOf('//')
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim()
    if (!line) continue

    if (currentTrainer) {
      const skillMatch = line.match(
        /^\[([A-Za-z0-9_]+)\]\s*=\s*\{\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*\},?/,
      )
      if (skillMatch) {
        rows.push({
          trainer: currentTrainer,
          slot: skillMatch[1],
          event: skillMatch[2],
          data0: skillMatch[3],
          data1: skillMatch[4],
          line: i + 1,
        })
        continue
      }

      if (line.startsWith('}')) {
        currentTrainer = null
        continue
      }
    }

    const trainerMatch = line.match(/^\[([A-Za-z0-9_]+)\]\s*=\s*\{\s*$/)
    if (trainerMatch) {
      currentTrainer = trainerMatch[1]
      continue
    }
  }

  return rows
}

export function hellTrainerSkillEvidence(row: HellTrainerSkillRow): UnitEvidence {
  return {
    productionFiles: [
      'web/src/engine/sim/battleEvents.ts',
      'web/src/engine/sim/driver/session.ts',
    ],
    caseBodyToken: row.event,
    alsoRequires: [
      {
        file: 'web/src/engine/sim/driver/session.ts',
        pattern: /\bsTrainerSkillList\b/,
      },
    ],
    testMustAssert: true,
  }
}

// ---------------------------------------------------------------------------
// Map weather scanning
// ---------------------------------------------------------------------------

export const BATTLE_MAP_WEATHERS = [
  'WEATHER_RAIN',
  'WEATHER_RAIN_THUNDERSTORM',
  'WEATHER_DOWNPOUR',
  'WEATHER_SANDSTORM',
  'WEATHER_DROUGHT',
  'WEATHER_FOG_HORIZONTAL',
] as const

const BATTLE_WEATHER_SET = new Set<string>(BATTLE_MAP_WEATHERS)

export const MAP_WEATHER_EVIDENCE: UnitEvidence = {
  productionFiles: [
    'web/src/engine/sim/driver/session.ts',
    'web/src/engine/sim/driver/runBattle.ts',
  ],
  alsoRequires: [
    {
      file: 'web/src/engine/sim/driver/session.ts',
      pattern: /\bmapWeather\b|\bGetCurrentWeather\b|\boverworldWeather\b/,
    },
  ],
  testMustAssert: true,
}

export interface MapWeatherHit {
  map: string
  weather: string
  trainerIds: string[]
}

export function scanMapHeaderWeathers(
  scripts: ReadonlyArray<MapScript>,
  mapsDir: string = MAPS_DIR,
): MapWeatherHit[] {
  const hits: MapWeatherHit[] = []
  if (!existsSync(mapsDir)) return hits
  const scriptMapNames = new Set(scripts.map((s) => s.map))
  for (const entry of readdirSync(mapsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!scriptMapNames.has(entry.name)) continue
    const mapJsonPath = join(mapsDir, entry.name, 'map.json')
    if (!existsSync(mapJsonPath)) continue
    try {
      const data = JSON.parse(readFileSync(mapJsonPath, 'utf-8')) as { weather?: string }
      const weather = data.weather
      if (weather && BATTLE_WEATHER_SET.has(weather)) {
        const trainerIds = scanTrainerIds(scripts, [entry.name])
        if (trainerIds.length > 0) {
          hits.push({ map: entry.name, weather, trainerIds })
        }
      }
    } catch {
      // ignore malformed map.json
    }
  }
  return hits.sort((a, b) => a.map.localeCompare(b.map))
}

export interface ScriptSetweatherHit {
  weather: string
  command: string
  occurrences: Array<{ map: string; line: number }>
  trainerIds: string[]
}

export function scanScriptSetweathers(
  scripts: ReadonlyArray<MapScript>,
): ScriptSetweatherHit[] {
  const byWeather = new Map<string, Array<{ map: string; line: number }>>()
  for (const script of scripts) {
    const lines = script.source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (isCommentLine(line)) continue
      const match = line.match(/\bsetweather\s+(WEATHER_[A-Z0-9_]+)\b/)
      if (match) {
        const weather = match[1]
        if (BATTLE_WEATHER_SET.has(weather)) {
          const list = byWeather.get(weather) ?? []
          list.push({ map: script.map, line: index + 1 })
          byWeather.set(weather, list)
        }
      }
    }
  }

  const result: ScriptSetweatherHit[] = []
  for (const [weather, occurrences] of [...byWeather.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const maps = [...new Set(occurrences.map((o) => o.map))].sort()
    const trainerIds = scanTrainerIds(scripts, maps)
    result.push({
      weather,
      command: `setweather ${weather}`,
      occurrences,
      trainerIds,
    })
  }
  return result
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
  )
}

/** Engine test sources except this inventory's own test file. */
export function loadEngineTestFiles(): SourceFile[] {
  return collectEngineFiles((repoRel, isTest) => isTest && repoRel !== OWN_TEST_FILE)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface TokenClassification {
  status: EnvironmentUnitStatus
  registeredUntested: boolean
  testFile: string | null
  productionEvidence: string | null
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

function checkAlsoRequires(
  productionFiles: ReadonlyArray<SourceFile>,
  alsoRequires: ReadonlyArray<{ file: string; pattern: RegExp }>,
): boolean {
  for (const req of alsoRequires) {
    const file = productionFiles.find((f) => f.file === req.file)
    if (file) {
      if (!patternMatches(req.pattern, file.source)) return false
    } else {
      const joined = productionFiles.find((f) => f.file === JOINED_PRODUCTION_FILE)
      if (joined && patternMatches(req.pattern, joined.source)) {
        continue
      }
      return false
    }
  }
  return true
}

/**
 * Checks if a switch-case label for `token` has a live body.
 * Starting at the label, skips consecutive `case ...:` / `default:` labels,
 * then requires the first statement not to be a bare `break`, a bare `return`,
 * or the closing `}` of the switch.
 */
export function hasLiveCaseBody(source: string, token: string): boolean {
  const labelRegex = new RegExp(
    `\\bcase\\s+['"\`]?${escapeRegExp(token)}['"\`]?\\s*:`,
    'g',
  )
  let match: RegExpExecArray | null
  while ((match = labelRegex.exec(source)) !== null) {
    let rest = source.slice(match.index + match[0].length)

    while (true) {
      const nextLabel = rest.match(/^\s*(?:case\s+[^:;{}]+:|default\s*:)/)
      if (nextLabel) {
        rest = rest.slice(nextLabel[0].length)
      } else {
        break
      }
    }

    rest = rest.trimStart()
    if (rest.startsWith('{')) {
      rest = rest.slice(1).trimStart()
    }

    if (rest.startsWith('}')) {
      continue
    }
    if (/^break\b(?:\s*;|\s*\}|\s*$|\s*\n)/.test(rest)) {
      continue
    }
    if (/^return\s*(?:;|\}|\n|$)/.test(rest)) {
      continue
    }

    return true
  }
  return false
}

/** Finds 1-based line of `case '<token>':` in unstripped source, skipping comment lines. */
export function findCaseLabelLine(source: string, token: string): number | null {
  const caseRegex = new RegExp(`\\bcase\\s+['"\`]?${escapeRegExp(token)}['"\`]?\\s*:`)
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue
    }
    if (caseRegex.test(lines[i])) {
      return i + 1
    }
  }
  return null
}

/** Finds 1-based line matching token and pattern in unstripped source, skipping comment lines. */
export function findPatternLine(source: string, token: string, pattern: RegExp): number | null {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue
    }
    pattern.lastIndex = 0
    if ((token === '' || tokenAppears(lines[i], token)) && pattern.test(lines[i])) {
      return i + 1
    }
  }
  return null
}

/** Finds 1-based line containing token in unstripped source, skipping comment lines. */
export function findTokenLine(source: string, token: string): number | null {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue
    }
    if (tokenAppears(lines[i], token)) {
      return i + 1
    }
  }
  return null
}

/** Extracts test callback block bodies from `it(` and `test(` declarations. */
export function extractTestBlocks(source: string): string[] {
  const blocks: string[] = []
  const testRegex = /\b(?:it|test)(?:\.[a-zA-Z0-9_]+)?\s*\(/g
  let match: RegExpExecArray | null
  while ((match = testRegex.exec(source)) !== null) {
    const startIdx = match.index + match[0].length
    let depth = 0
    let foundBrace = false
    let blockStart = -1
    let inString: string | null = null

    for (let i = startIdx; i < source.length; i++) {
      const char = source[i]
      const prev = i > startIdx ? source[i - 1] : ''

      if (inString) {
        if (char === inString && prev !== '\\') {
          inString = null
        }
        continue
      }

      if (char === "'" || char === '"' || char === '`') {
        inString = char
        continue
      }

      if (char === '{') {
        if (!foundBrace) {
          foundBrace = true
          blockStart = i + 1
        }
        depth++
      } else if (char === '}') {
        depth--
        if (foundBrace && depth === 0) {
          blocks.push(source.slice(blockStart, i))
          testRegex.lastIndex = i + 1
          break
        }
      }
    }
  }
  return blocks
}

/**
 * Returns true if `token` appears inside at least one `it(` or `test(` block
 * that also contains `expect(`.
 */
export function testFileAssertsToken(source: string, token: string): boolean {
  const blocks = extractTestBlocks(source)
  for (const block of blocks) {
    if (tokenAppears(block, token) && /\bexpect\s*\(/.test(block)) {
      return true
    }
  }
  return false
}

export function battleEventEvidence(event: string): UnitEvidence {
  return {
    productionFiles: ['web/src/engine/sim/battleEvents.ts'],
    caseBodyToken: event,
    alsoRequires: [
      {
        file: 'web/src/engine/sim/driver/session.ts',
        pattern: /\bregisterBattleEvent\s*\(\s*state\s*,\s*ev\.event\b/,
      },
    ],
    testMustAssert: true,
  }
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
  const rawProductionFiles = asProductionFiles(production)
  const productionFiles = rawProductionFiles.map((file) => ({
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
  let qualifyingFile: string | null = null
  let qualifyingLine: number | null = null

  for (let i = 0; i < productionFiles.length; i += 1) {
    const file = productionFiles[i]
    if (requiredFiles && !requiredFiles.has(file.file)) continue
    if (excludedFiles.has(file.file)) continue
    const rawSource = rawProductionFiles[i].source
    if (evidence.caseBodyToken) {
      if (hasLiveCaseBody(file.source, evidence.caseBodyToken)) {
        productionQualifies = true
        qualifyingFile = file.file
        qualifyingLine = findCaseLabelLine(rawSource, evidence.caseBodyToken)
        break
      }
    } else if (evidence.productionLinePattern) {
      if (lineMatches(file.source, lineToken, evidence.productionLinePattern)) {
        productionQualifies = true
        qualifyingFile = file.file
        qualifyingLine = findPatternLine(rawSource, lineToken, evidence.productionLinePattern)
        break
      }
    } else if (tokenAppears(file.source, lineToken)) {
      productionQualifies = true
      qualifyingFile = file.file
      qualifyingLine = findTokenLine(rawSource, lineToken || tokenToCheck)
      break
    }
  }

  if (evidence.alsoRequires && !checkAlsoRequires(productionFiles, evidence.alsoRequires)) {
    productionQualifies = false
  }

  const productionEvidence =
    productionQualifies && qualifyingFile && qualifyingLine !== null
      ? `${qualifyingFile}:${qualifyingLine}`
      : null

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
      if (evidence.testPattern && !patternMatches(evidence.testPattern, source)) {
        return false
      }
      if (evidence.testMustAssert && !testFileAssertsToken(source, tokenToCheck)) {
        return false
      }
      return true
    })
    .map((file) => file.file)
    .sort()
  const tested = matchingFiles.length > 0
  if (productionQualifies && tested) {
    return {
      status: 'ported',
      registeredUntested: false,
      testFile: matchingFiles[0],
      productionEvidence,
    }
  }
  if ((productionQualifies || productionNamesToken) && !tested) {
    return {
      status: 'unported',
      registeredUntested: true,
      testFile: null,
      productionEvidence,
    }
  }
  return {
    status: 'unported',
    registeredUntested: false,
    testFile: matchingFiles[0] ?? null,
    productionEvidence,
  }
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
  scope?: string
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
    evidence: {
      productionFiles: [
        'web/src/engine/sim/driver/session.ts',
        'web/src/engine/sim/driver/runBattle.ts',
      ],
      productionLinePattern: /\binverseBattle\s*:\s*(?!false\b)\S/,
      evidenceToken: 'FLAG_SYS_INVERSE_BATTLE',
    },
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
    scope: 'overworld weather seeds battle weather',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 4349),
    evidence: MAP_WEATHER_EVIDENCE,
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
    evidence: BATTLE_TYPE_TRAINER_EVIDENCE,
  },
  {
    key: 'BATTLE_TYPE_DOUBLE',
    token: 'BATTLE_TYPE_DOUBLE',
    site: 'BattleSetup_StartTrainerBattle',
    // battle_setup.c:1240 sets this only when two trainers approach; the driver's
    // session.ts:245 sets BATTLE_TYPE_TRAINER alone, and aiCheckBadMove.ts:28
    // records that battleTypeFlags never carries the double bit in this build.
    scope: 'not started by the driver: session.ts:245 sets BATTLE_TYPE_TRAINER only',
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
    // The real scope is computed from `encounters.json` `tagBattles` in
    // runInventory; this fallback is only used by synthetic callers.
    scope: 'starttagbattle tag battles (computed from encounters.json tagBattles)',
    citation: cite(`${UPSTREAM_SRC}/battle_setup.c`, 1470),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
]

/**
 * `multi_2_vs_2` story fights with an in-game partner. The macro body is not in
 * the fetched tree (the upstream `asm/` directory is not in `sparse_paths`); the
 * flags come from the C that starts the same battle shape,
 * `src/battle_tower.c:1647`:
 *   `gBattleTypeFlags = BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER;`
 * `src/battle_main.c:537-540` and `:602-606` read MULTI/INGAME_PARTNER and
 * `:614`/`:622` create the second opponent party under BATTLE_TYPE_TWO_OPPONENTS.
 */
export interface MultiBattleSpec extends StaticUnitSpec {
  /** Map whose `scripts.pory` holds the calls; its ids are the opponents. */
  map: string
  /** Number of `multi_2_vs_2` calls in that map. */
  callCount: number
}

export const MULTI_BATTLE_SPECS: ReadonlyArray<MultiBattleSpec> = [
  {
    key: 'multi_2_vs_2:MeteorFalls_1F_1R',
    token: 'multi_2_vs_2',
    map: 'MeteorFalls_1F_1R',
    callCount: 6,
    site: 'multi battle with an in-game partner (src/battle_tower.c:1647 shape)',
    scope:
      'MeteorFalls_1F_1R: 6 multi_2_vs_2 calls (:193, :202, :211, :220, :229, :238), opponents Courtney + Grunt, partner May (MAY_TREECKO/TORCHIC/MUDKIP_METEOR_FALLS) or Brendan (BRENDAN_*_METEOR_FALLS); second opponent party at src/battle_main.c:614,622; macro not in tree, flags inferred from the C',
    citation: cite(`${UPSTREAM_SRC}/battle_tower.c`, 1647),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
  {
    key: 'multi_2_vs_2:MossdeepCity_SpaceCenter_2F',
    token: 'multi_2_vs_2',
    map: 'MossdeepCity_SpaceCenter_2F',
    callCount: 1,
    site: 'multi battle with an in-game partner (src/battle_tower.c:1647 shape)',
    scope:
      'MossdeepCity_SpaceCenter_2F:274: 1 multi_2_vs_2 call, opponents Maxie + Courtney, partner TRAINER_STEVEN_MOSSDEEP; second opponent party at src/battle_main.c:614,622; macro not in tree, flags inferred from the C',
    citation: cite(`${UPSTREAM_SRC}/battle_tower.c`, 1647),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
]

/**
 * Rules the C applies to a tag battle (two opponents). Each token is a C-side
 * identifier the driver never assigns, so BATTLE_TYPE_DRIVER_EVIDENCE keeps them
 * unported until the driver sets BATTLE_TYPE_TWO_OPPONENTS. The tag-to-flag link
 * is inferred from `src/battle_main.c:1778` and `encounters.json`, not read from
 * a macro: the `starttagbattle` asm expansion is not in the fetched tree.
 */
export const TAG_BATTLE_SPECS: ReadonlyArray<StaticUnitSpec> = [
  {
    key: 'tagBattle:aiFlags',
    token: 'AI_FLAG_CHECK_BAD_MOVE',
    site: 'GetAiScriptsInBattle BATTLE_TYPE_TWO_OPPONENTS branch',
    scope:
      'tag battles (two opponents): the trainer aiFlags are replaced by AI_FLAG_CHECK_BAD_MOVE | AI_FLAG_TRY_TO_FAINT | AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_FOE (src/battle_ai_main.c:144-145); tag-to-flag inferred from src/battle_main.c:1778 + encounters.json',
    citation: cite(`${UPSTREAM_SRC}/battle_ai_main.c`, 145),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
  {
    key: 'tagBattle:partyCap',
    token: 'monsCount',
    site: 'CreateNPCTrainerParty BATTLE_TYPE_TWO_OPPONENTS branch',
    scope:
      'tag battles (two opponents): each opponent party is capped at 3 mons (src/battle_main.c:1778-1782); tag-to-flag inferred from src/battle_main.c:1778 + encounters.json',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1780),
    evidence: BATTLE_TYPE_DRIVER_EVIDENCE,
  },
]

export const DIFFICULTY_FLAG_SPECS: ReadonlyArray<StaticUnitSpec> = [
  {
    key: 'gameDifficulty',
    // The C names a save-block field TS can never contain. The sim implements the
    // tier selection in buildParty.ts:84-89 (`trainerRow.parties?.[tier]`, elite
    // then ace fallback), the same fallback as TrainerPartyGenerator.kt:177-178.
    token: 'parties',
    site: 'CreateNPCTrainerParty',
    scope: 'DIFFICULTY_EASY / DIFFICULTY_ACE / DIFFICULTY_ELITE / DIFFICULTY_HELL party selection',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1735),
    evidence: {
      productionFiles: ['web/src/engine/sim/driver/buildParty.ts'],
      productionLinePattern: /parties\?\.\[tier\]/,
      // A test must actually choose a tier, not merely mention the word party.
      testPattern: /\btier\s*:\s*['"](?:ace|elite)['"]/,
      testMustAssert: true,
    },
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
    // pokemon_config.h:34 defines the flag as FLAG_BADGE03_GET, not a save-file
    // settings toggle: Hell extra levels switch on automatically once that badge
    // is held (`if (FlagGet(HELL_MODE_EXTRA_LEVELS_FLAG)) extraLevels =
    // HELL_MODE_EXTRA_LEVELS;`, battle_main.c:1805).
    scope:
      'FLAG_BADGE03_GET (pokemon_config.h:34): extra levels switch on after the third badge',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1805),
  },
  {
    key: 'HELL_MODE_0_IVS_FLAG',
    token: 'HELL_MODE_0_IVS_FLAG',
    site: 'CalculateMonStatsMaster',
    // pokemon_config.h:35 defines the flag as FLAG_BADGE05_GET. The zero-IV
    // branch is player-only: pokemon.c:989 tests isEnemyMon first, so enemy mons
    // always get MAX_IVS regardless of the difficulty or the flag.
    scope:
      'FLAG_BADGE05_GET (pokemon_config.h:35): zeroes only the player side mons IVs, after the fifth badge; enemy mons keep MAX_IVS',
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
    scope: 'data/hell_trainer_skills.h (29 rows across 24 trainers)',
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 1773),
  },
  // Hell / difficulty battle rules the C applies and the sim does not. Each token
  // is a C-side identifier that no comment-stripped production file contains, so
  // the plain token rule leaves the unit unported. None of these carry evidence:
  // a name match must never be enough to mark a rule ported.
  {
    key: 'hellDamageReduction',
    token: 'isHellMode',
    site: 'final damage (isHellMode block)',
    scope:
      'Hell: defender not on the player side takes x0.9 after FLAG_BADGE02_GET, then x0.75 for both sides',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 7516),
  },
  {
    key: 'hellTypeEffectiveness',
    token: 'HELL_MODE_TYPE_EFFECTIVENESS_CHANGE',
    site: 'CalcTypeEffectivenessMultiplier',
    // The code assigns UQ_4_12(2.5) for the 4.0x case (the surrounding comment
    // says "2x"); GetSuperEffectiveMult (abilities.cc:430) returns 1.5x in Hell.
    scope: 'Hell: 2.0x becomes 1.5x and 4.0x becomes 2.5x; GetSuperEffectiveMult returns 1.5x',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 7934),
  },
  {
    key: 'hellNoEnemyFullParalysis',
    token: 'disableParalysisCancel',
    site: 'CANCELLER_PARALYSED',
    // The `Random() % 4` is evaluated before `!disableParalysisCancel` in the
    // `&&` chain, so the draw still happens for enemies.
    scope: 'Hell: enemy-side attackers never lose the 25% full-paralysis roll',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 3402),
  },
  {
    // `MOVE_EFFECT_FLINCH` is live production code all over the sim, so it cannot
    // be the token. `isHellMode` occurs only in production comments (stripped)
    // and names the guard on the same cited line.
    key: 'hellPlayerFlinchFails',
    token: 'isHellMode',
    site: 'GetMoveEffectChance',
    scope: 'Hell: a flinch secondary with baseChance < 100 always fails on the player side',
    citation: cite(`${UPSTREAM_SRC}/battle_script_commands.c`, 3076),
  },
  {
    key: 'hellEvasionClause',
    token: 'IsEvasionClauseDisablingMove',
    site: 'IsEvasionClauseDisablingMove',
    scope: 'Hell trainer battles: player-side EFFECT_EVASION_UP and EFFECT_MINIMIZE are disabled',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 4931),
  },
  {
    key: 'hellSleepMovePP',
    token: 'CalculatePPWithBonusPlayer',
    site: 'CalculatePPWithBonusPlayer',
    scope:
      'Hell: player EFFECT_SLEEP_HIT / EFFECT_SLEEP / EFFECT_SNORE / EFFECT_REST / EFFECT_SLEEP_TALK have 2 PP; other player moves get base PP with no PP Up bonus',
    citation: cite(`${UPSTREAM_SRC}/pokemon.c`, 2239),
  },
  {
    // `IsSleepClauseDisablingMove` itself is named inside a live `note(...)`
    // string in aiMoveLimitations.ts, so it would register as untested rather
    // than invisible. `partnerChoseSleepMove` is a C-side identifier from the
    // same function and appears nowhere in the production tree.
    key: 'sleepClause',
    token: 'partnerChoseSleepMove',
    site: 'IsSleepClauseDisablingMove',
    scope:
      'every difficulty except EASY: EFFECT_SLEEP / EFFECT_YAWN disabled when IsSleepDisabled(target) or, in doubles, the partner chose a sleep move',
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 4977),
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

/**
 * Monotype Champion rule sites. `getMonotypeChampType()` reads
 * `VAR_BATTLE_FIELD_EFFECT_TYPE == BATTLE_FIELD_EFFECT_MONOCHAMP` and returns
 * `VarGet(VAR_BATTLE_FIELD_ID)` (battle_util.c:4074-4079), so every rule below
 * is gated on a value the driver never sets: `loadSimData.ts:249` hard-codes
 * `monotypeChampType: null`, and no other driver file assigns it. The sim
 * already branches on `GroundingContext.monotypeChampType` at the sites named
 * in each `scope`; only the driver feed is missing. A unit becomes `ported`
 * when the driver assigns a non-null champion type.
 */
const MONOCHAMP_DRIVER_EVIDENCE: UnitEvidence = {
  productionFiles: ['web/src/engine/sim/driver/loadSimData.ts'],
  productionLinePattern: /monotypeChampType\s*:\s*(?!null\b)\S/,
}

/** One `map-setup` unit per Monotype Champion rule site. Citations were read in the C. */
export const MONOCHAMP_RULE_SPECS: ReadonlyArray<StaticUnitSpec> = [
  {
    key: 'monochamp:battle_util.c:1431',
    token: 'monotypeChampType',
    site: 'CheckMoveLimitations',
    scope:
      "[FIGHTING] status moves are unusable on the player's side: `gBattleMoves[move].split == SPLIT_STATUS && getMonotypeChampType() == TYPE_FIGHTING && GetBattlerSide(gActiveBattler) == B_SIDE_PLAYER`. Unmodelled, conditional note at web/src/engine/sim/ai/aiMoveLimitations.ts:93.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 1431),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:1632',
    token: 'monotypeChampType',
    site: 'CheckMoveLimitations move filter',
    scope:
      "[FIGHTING] the move filter repeats the status lock: `FILTER_NOT(... SPLIT_STATUS && ... TYPE_FIGHTING && GetBattlerSide(battlerId) == B_SIDE_PLAYER)`. Unmodelled, conditional note at web/src/engine/sim/ai/aiMoveLimitations.ts:93 (no limitation bit is set).",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 1632),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:2238',
    token: 'monotypeChampType',
    site: 'ENDTURN_SWAMP',
    scope:
      "[WATER] the swamp timer does not tick down for the player's side: `!(getMonotypeChampType() == TYPE_WATER && side == B_SIDE_PLAYER) && --gSideTimers[side].swampTimer == 0`. Conditional port at web/src/engine/sim/fieldEndTurn.ts:906; only the driver feed is missing.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 2238),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:2488',
    token: 'monotypeChampType',
    site: 'ENDTURN_TOXIC_WASTE_DAMAGE',
    scope:
      "[POISON] `ENDTURN_TOXIC_WASTE_DAMAGE` runs Toxic Spill's onEndTurn with `ABILITY_NONE` when `getMonotypeChampType() == TYPE_POISON && gActiveBattler == B_SIDE_PLAYER`. The ability hook's champion check is conditionally ported at web/src/engine/sim/endTurn.ts:1409; the battle_util dispatch itself is not run.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 2488),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:2635',
    token: 'monotypeChampType',
    site: 'ENDTURN_SALT_CURE',
    scope:
      "[ROCK] `ENDTURN_SALT_CURE` damages every player mon as if salt-cured: `(getMonotypeChampType() == TYPE_ROCK && GET_BATTLER_SIDE(gActiveBattler) == B_SIDE_PLAYER) || (gStatuses4[gActiveBattler] & STATUS4_SALT_CURE)`, 1/4 for Water or Steel else 1/8. Unmodelled (web/src/engine/sim/endTurn.ts:2039 notes the ROCK half has no port).",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 2635),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:2649',
    token: 'monotypeChampType',
    site: 'ENDTURN_WRAP',
    scope:
      "[BUG] `ENDTURN_WRAP` Infestation damage on every player mon: `getMonotypeChampType() == TYPE_BUG && ... GET_BATTLER_SIDE(gActiveBattler) == B_SIDE_PLAYER`. Unmodelled (web/src/engine/sim/endTurn.ts:614 notes the Bug branch has no port).",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 2649),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:4850',
    token: 'monotypeChampType',
    site: 'CanBattlerEscape',
    scope:
      "[FIGHTING] the player's side cannot switch out: the `return FALSE` branch `GetBattlerSide(battlerId) == B_SIDE_PLAYER && getMonotypeChampType() == TYPE_FIGHTING`. Conditional port at web/src/engine/sim/escape.ts:105; only the driver feed is missing.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 4850),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:4971',
    token: 'monotypeChampType',
    site: 'IsSleepDisabled',
    scope:
      "[DARK] the AI sleep clause is disabled for the player's side: `asleepmons != 0 && !(getMonotypeChampType() == TYPE_DARK && GetBattlerSide(battlerId) == B_SIDE_PLAYER)`. Unmodelled (web/src/engine/sim/ai/aiMoveLimitations.ts:89 notes the Dark exemption).",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 4971),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:6656',
    token: 'monotypeChampType',
    site: 'CheckGroundingEffects',
    scope:
      "[GROUND] the player's side is grounded: `getMonotypeChampType() == TYPE_GROUND && GetBattlerSide(battlerId) == B_SIDE_PLAYER`. Conditional port at web/src/engine/sim/grounding.ts:50; only the driver feed is missing.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 6656),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:7235',
    token: 'monotypeChampType',
    site: 'CalcAttackStat',
    scope:
      "[ICE] the attack uses Speed as the attack stat when the defender is on the player's side: `getMonotypeChampType() == TYPE_ICE && GetBattlerSide(battlerDef) == B_SIDE_PLAYER`. Unmodelled.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 7235),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:7717',
    token: 'monotypeChampType',
    site: 'post-formula damage switch',
    scope:
      "[GRASS, PSYCHIC, ELECTRIC, POISON, STEEL, GROUND, FIGHTING] the switch at :7716-7756: 0.7 for Grass/Psychic/Electric against the champion side, 0.7 Poison and Steel for both sides, Ground 0.65 on super-effective hits vs the champion side, Fighting halves/quarters super-effective damage and multiplies Fighting moves by 1.5. Unmodelled note at web/src/engine/sim/ai/aiCalcDamage.ts:208-210.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 7717),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:7861',
    token: 'monotypeChampType',
    site: 'MulByTypeEffectiveness',
    scope:
      "[FAIRY] Fairy moves hit Poison and Steel defenders super-effectively on the player's side: `moveType == TYPE_FAIRY && (defType == TYPE_POISON || defType == TYPE_STEEL) && GetBattlerSide(battlerDef) == B_SIDE_PLAYER && getMonotypeChampType() == TYPE_FAIRY`. Unmodelled note at web/src/engine/sim/ai/aiShouldSwitch.ts:219.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 7861),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:7863',
    token: 'monotypeChampType',
    site: 'MulByTypeEffectiveness',
    scope:
      "[DRAGON] a 0x effectiveness becomes 1x on the player's side: `mod == UQ_4_12(0.0) && GetBattlerSide(battlerDef) == B_SIDE_PLAYER && getMonotypeChampType() == TYPE_DRAGON`. Unmodelled note at web/src/engine/sim/ai/aiShouldSwitch.ts:219.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 7863),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:7865',
    token: 'monotypeChampType',
    site: 'MulByTypeEffectiveness',
    scope:
      "[ROCK] the `getMonotypeChampType() == TYPE_ROCK` branch (:7865-7869): Rock-on-Rock is super-effective on the player's side, and non-player-side Rock moves become immune. Unmodelled note at web/src/engine/sim/ai/aiShouldSwitch.ts:219.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 7865),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:8672',
    token: 'monotypeChampType',
    site: 'IsTrickRoomActive',
    scope:
      "[FLYING] Trick Room is never active: `IsAbilityOnField(ABILITY_CLUELESS) || getMonotypeChampType() == TYPE_FLYING`. Conditional port at web/src/engine/sim/turn.ts:631; only the driver feed is missing.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 8672),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:8674',
    token: 'monotypeChampType',
    site: 'IsTrickRoomActive',
    scope:
      "[NORMAL] Trick Room is active on odd battle turns: `getMonotypeChampType() == TYPE_NORMAL && gBattleResults.battleTurnCounter % 2 == 1`. Unmodelled (web/src/engine/sim/turnOrder.ts:186-191 documents the concept; no NORMAL-odd branch exists).",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 8674),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:8710',
    token: 'monotypeChampType',
    site: 'isWonderRoomActive',
    scope:
      "[NORMAL] Wonder Room is active on even battle turns: `getMonotypeChampType() == TYPE_NORMAL && gBattleResults.battleTurnCounter % 2 == 0`. Conditional port at web/src/engine/sim/bridge.ts:627; only the driver feed is missing.",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 8710),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:8907',
    token: 'monotypeChampType',
    site: 'IsBattlerCursed',
    scope:
      "[GHOST] `IsBattlerCursed` is true for the player's side: `getMonotypeChampType() == TYPE_GHOST && GetBattlerSide(battler) == B_SIDE_PLAYER`. Unmodelled (web/src/engine/sim/endTurn.ts:602 notes no port).",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 8907),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_util.c:9132',
    token: 'monotypeChampType',
    site: 'AbilityOnEntryHandler Dragon Monotype',
    scope:
      "[DRAGON] a one-time Fearmonger entry on the player's side: `getMonotypeChampType() == TYPE_DRAGON && GetBattlerSide(battler) == B_SIDE_PLAYER && !gVolatileStructs[battler].usedMonotypeEntry`. Unmodelled (`usedMonotypeEntry` state exists in web/src/engine/sim/state.ts:217 but no logic reads it).",
    citation: cite(`${UPSTREAM_SRC}/battle_util.c`, 9132),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_main.c:4205',
    token: 'monotypeChampType',
    site: 'getBattlerTotalSpeedStat',
    scope:
      "[FLYING] the champion's side doubles its Speed: `GET_BATTLER_SIDE(battlerId) != B_SIDE_PLAYER && getMonotypeChampType() == TYPE_FLYING`. Conditional port at web/src/engine/sim/turnOrder.ts:331; only the driver feed is missing.",
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 4205),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_main.c:5824',
    token: 'monotypeChampType',
    site: 'HandleMonoChampSpecialEffects',
    scope:
      "[all types] the switch :5823-5870, called from battle_main.c:3029: Grass/Electric/Fairy/Psychic set their terrain permanently, Fire sets primal sun, Flying strong winds, Water primal rain plus `swampTimer = 1`, Ice hail, and Dark puts the player's team to sleep (`MakePlayerTeamAsleep`). Unmodelled.",
    citation: cite(`${UPSTREAM_SRC}/battle_main.c`, 5824),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:abilities.cc:5201',
    token: 'monotypeChampType',
    site: 'Impl<ABILITY_TOXIC_SPILL>.onEntry',
    scope:
      "[POISON] Toxic Spill's onEntry is skipped when the champion is Poison: `CHECK_NOT(getMonotypeChampType() == TYPE_POISON)`. Unmodelled (web/src/engine/sim/switchInAbility.ts:2303 skips the entry effect without the champion check).",
    citation: cite(`${UPSTREAM_SRC}/abilities.cc`, 5201),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:abilities.cc:5211',
    token: 'monotypeChampType',
    site: 'Impl<ABILITY_TOXIC_SPILL>.onEndTurn',
    scope:
      "[POISON] Toxic Spill's onEndTurn is skipped when the champion is Poison: `CHECK_NOT(getMonotypeChampType() == TYPE_POISON)`. Conditional port at web/src/engine/sim/endTurn.ts:1409; only the driver feed is missing.",
    citation: cite(`${UPSTREAM_SRC}/abilities.cc`, 5211),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:abilities.cc:5246',
    token: 'monotypeChampType',
    site: 'Impl<ABILITY_TOXIC_SPILL>.onExit',
    scope:
      "[POISON] Toxic Spill's onExit is skipped when the champion is Poison: `CHECK_NOT(getMonotypeChampType() == TYPE_POISON)`. Unmodelled (web/src/engine/sim/turn.ts:1642 skips the exit effect without the champion check).",
    citation: cite(`${UPSTREAM_SRC}/abilities.cc`, 5246),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_script_commands.c:979',
    token: 'monotypeChampType',
    site: 'SetMoldBreaker',
    scope:
      "[STEEL] the Mold Breaker marker is set for the non-player side: `getMonotypeChampType() == TYPE_STEEL && GetBattlerSide(battler) != B_SIDE_PLAYER`. Unmodelled.",
    citation: cite(`${UPSTREAM_SRC}/battle_script_commands.c`, 979),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_script_commands.c:8344',
    token: 'monotypeChampType',
    site: 'Cmd_courtchange',
    scope:
      "[WATER] Court Change does not swap the swamp timer: `if (!(getMonotypeChampType() == TYPE_WATER)) SWAP(gSideTimers[0].swampTimer, gSideTimers[1].swampTimer, temp)`. Conditional port at web/src/engine/sim/moveEffects.ts:8773; only the driver feed is missing.",
    citation: cite(`${UPSTREAM_SRC}/battle_script_commands.c`, 8344),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
  },
  {
    key: 'monochamp:battle_script_commands.c:8985',
    token: 'monotypeChampType',
    site: 'Intimidate data',
    scope:
      "[DRAGON] intimidate data uses `ABILITY_FEARMONGER` for the non-player attacker when `ability == ABILITY_NONE`: `getMonotypeChampType() == TYPE_DRAGON && GetBattlerSide(gBattlerAttacker) != B_SIDE_PLAYER && ability == ABILITY_NONE`. Unmodelled.",
    citation: cite(`${UPSTREAM_SRC}/battle_script_commands.c`, 8985),
    evidence: MONOCHAMP_DRIVER_EVIDENCE,
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
  tagBattleRows?: ReadonlyArray<TagBattleRow>
  eventSource?: string
  eventHeaderSource?: string
  hellTrainerSkillsSource?: string
  /** Joined production corpus; used by synthetic tests instead of `productionFiles`. */
  productionSource?: string
  /** Per-file production corpus, so `productionFiles` evidence can scope a match. */
  productionFiles?: ReadonlyArray<SourceFile>
  testSources?: ReadonlyArray<SourceFile>
  allowlist?: ReadonlyArray<EnvironmentAllowlistEntry>
  extraMapSetupSpecs?: ReadonlyArray<MapSetupSpec>
  extraScriptEventSpecs?: ReadonlyArray<ScriptEventSpec>
  battleEventEvidence?: (event: string) => UnitEvidence
  mapsDir?: string
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
  const tagBattleRows = options.tagBattleRows ?? loadTagBattleRows()
  const tagTrainerIds = [...new Set(tagBattleRows.flatMap((row) => row.trainers))].sort()
  const tagMapCount = new Set(tagBattleRows.map((row) => row.map)).size
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
      productionEvidence: allow ? null : classification.productionEvidence,
      evidence: spec.evidence,
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
          spec.scope ??
          (maps.length > 0
            ? `${maps.length} map(s), ${occurrences.length} line(s): ${maps.join(', ')}`
            : '0 maps'),
        citation: spec.citation,
        evidence: spec.evidence,
      },
      scanTrainerIds(scripts, maps),
    )
  }

  const mapHeaderWeathers = scanMapHeaderWeathers(scripts, options.mapsDir ?? MAPS_DIR)
  for (const hit of mapHeaderWeathers) {
    const key = `map-weather:${hit.map}:${hit.weather}`
    const citation = cite(`${UPSTREAM_SRC}/battle_util.c`, 4349)
    const scope =
      hit.weather === 'WEATHER_RAIN_THUNDERSTORM'
        ? `${hit.map} (${hit.weather}) + electric terrain (src/battle_util.c:4316-4322)`
        : `${hit.map} (${hit.weather})`
    pushUnit(
      'map-setup',
      {
        key,
        token: hit.weather,
        site: 'map.json weather',
        scope,
        citation,
        evidence: MAP_WEATHER_EVIDENCE,
      },
      hit.trainerIds,
    )
  }

  const scriptSetweathers = scanScriptSetweathers(scripts)
  for (const hit of scriptSetweathers) {
    const key = `setweather:${hit.weather}`
    const citation = cite(`${UPSTREAM_SRC}/battle_util.c`, 4349)
    const scope = `${hit.occurrences.map((o) => `${o.map}:${o.line}`).join(', ')} (${hit.command})`
    pushUnit(
      'map-setup',
      {
        key,
        token: hit.weather,
        site: 'ScrCmd_setweather',
        scope,
        citation,
        evidence: MAP_WEATHER_EVIDENCE,
      },
      hit.trainerIds,
    )
  }

  // One unit per Monotype Champion rule site; every fight in this room is an
  // opponent whose rules the type gate selects (the map holds the 18 type
  // variants), so each unit carries the map's scanned opponent ids.
  const monochampTrainerIds = scanTrainerIds(scripts, ['EvergrandeCity_MonoChampRoom_1'])
  for (const spec of MONOCHAMP_RULE_SPECS) {
    pushUnit('map-setup', spec, monochampTrainerIds)
  }

  for (const spec of BATTLE_TYPE_SPECS) {
    if (spec.key === 'FLAG_TAG_BATTLE') {
      pushUnit(
        'battle-type',
        {
          ...spec,
          scope: `${tagBattleRows.length} tagBattles rows across ${tagMapCount} maps in encounters.json (starttagbattle)`,
        },
        tagTrainerIds,
      )
    } else {
      pushUnit('battle-type', spec)
    }
  }
  for (const spec of MULTI_BATTLE_SPECS) {
    pushUnit('battle-type', spec, scanTrainerIds(scripts, [spec.map]))
  }
  for (const spec of TAG_BATTLE_SPECS) pushUnit('battle-type', spec, tagTrainerIds)
  for (const spec of DIFFICULTY_FLAG_SPECS) pushUnit('difficulty-flag', spec)
  for (const spec of TRAINER_FLAG_SPECS) pushUnit('trainer-flag', spec)

  const hellSkillsPath = join(REPO_ROOT, HELL_TRAINER_SKILLS_H)
  const hellSkillsSource =
    options.hellTrainerSkillsSource ??
    (existsSync(hellSkillsPath) ? readFileSync(hellSkillsPath, 'utf-8') : '')
  const hellSkillRows = parseHellTrainerSkills(hellSkillsSource)
  for (const row of hellSkillRows) {
    const key = `${row.trainer}#${row.slot}:${row.event}`
    const citation = cite(HELL_TRAINER_SKILLS_H, row.line)
    pushUnit(
      'hell-trainer-skill',
      {
        key,
        token: row.event,
        site: 'sTrainerSkillList',
        scope: `${row.trainer} (${row.slot})`,
        citation,
        evidence: hellTrainerSkillEvidence(row),
      },
      [row.trainer],
    )
  }

  const eventRowsByEvent = new Map<string, EncounterBattleEventRow[]>()
  for (const row of battleEventRows) {
    const list = eventRowsByEvent.get(row.event) ?? []
    list.push(row)
    eventRowsByEvent.set(row.event, list)
  }
  const getBattleEventEvidence = options.battleEventEvidence ?? battleEventEvidence
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
      evidence: getBattleEventEvidence(event),
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
    tagBattleRowCount: tagBattleRows.length,
    tagBattleMapCount: tagMapCount,
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
    '  `buildParty.ts`). `BATTLE_TYPE_TRAINER` qualifies (`session.ts:245`); `BATTLE_TYPE_DOUBLE` does not, so the driver',
  )
  lines.push('  never runs a double battle regardless of a constant or a hand-built test state.')
  lines.push(
    '- `forcedDouble` additionally requires a production line outside `aiFlags.ts` that changes the number of active',
  )
  lines.push(
    '  battlers. The engine only ORs `AI_FLAG_DOUBLE_BATTLE`; the codegen\'s `doubleBattle = TRUE`',
  )
  lines.push('  (`TrainerPartyGenerator.kt:207`) is unmodelled, so the fight stays singles.')
  lines.push(
    '- `FLAG_SYS_INVERSE_BATTLE` requires production evidence in `session.ts` or `runBattle.ts` assigning `inverseBattle` from a non-literal value.',
  )
  lines.push(
    '  The sim currently hardcodes `inverseBattle: false`, so it is unported.',
  )
  const portedBattleEventCount = result.units.filter(
    (unit) => unit.kind === 'battle-event' && unit.status === 'ported',
  ).length
  const stickyWebUnit = result.units.find(
    (unit) => unit.kind === 'battle-event' && unit.key === 'BATTLE_EVENT_STICKY_WEB',
  )
  const stickyWebClause =
    stickyWebUnit?.status === 'allowlisted'
      ? `; \`${stickyWebUnit.key}\` has no case label and is allowlisted (\`src/battle_events.c:362\`, the post-switch \`return EXEC_BATTLE_EVENTS_ALL_CLEAR;\`) as a safe no-op.`
      : stickyWebUnit
        ? `; \`${stickyWebUnit.key}\` has no case label and is ${statusLabel(stickyWebUnit)}.`
        : '.'
  lines.push(
    '- Battle-event units require a live switch case in `battleEvents.ts` and dispatch wiring in `session.ts` (`registerBattleEvent`).',
  )
  lines.push(
    `  ${portedBattleEventCount} units qualify and are asserted in \`battleEvents.test.ts\`${stickyWebClause}`,
  )
  lines.push('')
  lines.push(
    'Allowlisted units require an exact pinned C `file:line` whose line is quoted in the reason. The allowlist is not',
  )
  lines.push(
    `empty: ${result.totalAllowlisted} units are provably battle-inert (cosmetics, field-effect arguments, prizes).`,
  )
  lines.push('')
  lines.push('1. **map-setup**: a flag/var/special/script command set by a map script before a battle, or map header weather.')
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
    '5. **hell-trainer-skill**: per-(trainer, skill) entries from `data/hell_trainer_skills.h` registered under Hell difficulty.',
  )
  lines.push(
    '6. **battle-event**: one distinct `event` in `data/v2.65beta/encounters.json` `battleEvents`, with the C handler line.',
  )
  lines.push('7. **script-event**: a battle script label pushed by one of the scripted setups above.')
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
    const hasProductionEvidence =
      kind === 'battle-type' ||
      kind === 'map-setup' ||
      kind === 'battle-event' ||
      kind === 'hell-trainer-skill'
    if (hasProductionEvidence) {
      lines.push(
        '| Unit key | Fights / maps | C citation | Status | Test file | Production evidence |',
      )
      lines.push('| --- | --- | --- | --- | --- | --- |')
    } else {
      lines.push('| Unit key | Fights / maps | C citation | Status | Test file |')
      lines.push('| --- | --- | --- | --- | --- |')
    }
    for (const unit of subset) {
      const testFile = unit.testFile ? `\`${unit.testFile}\`` : 'none'
      if (hasProductionEvidence) {
        const prodEvidence = unit.productionEvidence ? `\`${unit.productionEvidence}\`` : 'none'
        lines.push(
          `| \`${unit.key}\` | ${unit.scope} | \`${unit.citation}\` | ${statusLabel(unit)} | ${testFile} | ${prodEvidence} |`,
        )
      } else {
        lines.push(
          `| \`${unit.key}\` | ${unit.scope} | \`${unit.citation}\` | ${statusLabel(unit)} | ${testFile} |`,
        )
      }
    }
    lines.push('')
  }

  pushSection('map-setup', 'Map-Setup Units')
  pushSection('battle-type', 'Battle-Type Units')
  pushSection('difficulty-flag', 'Difficulty-Flag Units')
  pushSection('trainer-flag', 'Trainer-Flag Units')
  pushSection('hell-trainer-skill', 'Hell-Trainer-Skill Units')
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
    '- **Hell-mode trainer skills**: `data/hell_trainer_skills.h` (`src/battle_events.c:502`) defines 29 skill rows across 24 trainers.',
  )
  lines.push(
    '  `RegisterTrainerBattleEvents` (`src/battle_events.c:504-525`) registers these for Hell tier (`src/battle_main.c:1773`).',
  )
  lines.push(
    '  Events not in `encounters.json` `battleEvents`: `BATTLE_EVENT_EVIOLITE`, `BATTLE_EVENT_EXTRA_ABILITIES_1`,',
  )
  lines.push(
    '  `BATTLE_EVENT_EXTRA_ABILITIES_2`, `BATTLE_EVENT_EXTRA_ABILITIES_3`, `BATTLE_EVENT_LAST_STAND_STAGES`, `BATTLE_EVENT_TOXIC_SPIKES`.',
  )
  lines.push(
    '  In `battleEvents.ts`, cases exist for `TOXIC_SPIKES` (:367) and `LAST_STAND_STAGES` (:548) (case exists, never registered for hell);',
  )
  lines.push(
    '  `EVIOLITE` and `EXTRA_ABILITIES_1/2/3` have no case (C: `src/battle_util.c:7441-7445` and `src/pokemon.c:6369-6390, 6406-6432`).',
  )
  lines.push(
    '  Other table events (`NO_PROTECT`, `SPIKES`, `PERMA_STICKY_WEB`, `ONSTAY_LEECH_SEED`, `POSTURE_DEFENSE`, `STEALTH_ROCK`, `LAST_BLEED`)',
  )
  lines.push(
    '  have cases in `battleEvents.ts`, but are never registered for hell because `session.ts` does not read `sTrainerSkillList`.',
  )
  lines.push(
    '- **`setwildbattlewithcustommoves`**: implementation read at `src/scrcmd.c:2620` (species, level, item, four moves,',
  )
  lines.push('  ability, nature, six EV arguments). The sim takes the resulting party from its caller; the command itself is',
  )
  lines.push('  not simulated.')
  lines.push(
    '- **`setweather` and map weather**: `ScrCmd_setweather` (`src/scrcmd.c:720-726`) only calls `SetSav1Weather`. Overworld weather',
  )
  lines.push(
    '  enters battles via `TryDoEventsBeforeFirstTurn` calling `AbilityBattleEffects(ABILITYEFFECT_SWITCH_IN_WEATHER)` once',
  )
  lines.push(
    '  (`src/battle_main.c:3333-3336`, `src/battle_util.c:4349-4389`). RAIN, RAIN_THUNDERSTORM and DOWNPOUR set permanent+temporary',
  )
  lines.push(
    '  rain, SANDSTORM sets sandstorm, DROUGHT sets sun, and FOG_HORIZONTAL sets `WEATHER_FOG_PERMANENT` (FOG_DIAGONAL is commented out',
  )
  lines.push(
    '  at `:4375` and does not trigger). `WEATHER_RAIN_THUNDERSTORM` additionally sets permanent Electric Terrain (`src/battle_util.c:4316-4322`).',
  )
  lines.push(
    '  Because the sim does not seed battle weather from map data, `setweather` and map-weather units are reported unported rather than allowlisted.',
  )
  const multiCallCount = MULTI_BATTLE_SPECS.reduce((sum, spec) => sum + spec.callCount, 0)
  lines.push(
    `- **Multi battles**: \`BATTLE_TYPE_MULTI\` is not Battle-Tower-only. ${multiCallCount} \`multi_2_vs_2\` calls in`,
  )
  lines.push(
    '  `data/maps/MeteorFalls_1F_1R/scripts.pory` (:193, :202, :211, :220, :229, :238) and `data/maps/MossdeepCity_SpaceCenter_2F/scripts.pory` (:274)',
  )
  lines.push(
    '  are story fights with an in-game partner. The macro body is not fetched (the upstream `asm/` tree is not in `sparse_paths`),',
  )
  lines.push(
    '  so the flags are inferred from the C that starts the same shape: `src/battle_tower.c:1647` assigns',
  )
  lines.push(
    '  `BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER`;',
  )
  lines.push(
    '  `src/battle_main.c:537-540`/`:602-606` read MULTI/INGAME_PARTNER and `:614`/`:622` create the second opponent party.',
  )
  lines.push(
    `  The driver never sets those bits, so the ${MULTI_BATTLE_SPECS.length} \`multi_2_vs_2:*\` units are unported.`,
  )
  lines.push(
    `- **Tag battles**: \`encounters.json\` \`tagBattles\` has ${result.tagBattleRowCount} two-opponent rows across ${result.tagBattleMapCount} maps.`,
  )
  lines.push(
    '  The C replaces the trainer AI flags under `BATTLE_TYPE_TWO_OPPONENTS` (`src/battle_ai_main.c:144-145`) and caps each',
  )
  lines.push(
    '  opponent party at three mons (`src/battle_main.c:1778-1782`); the lose-text branch is the `FLAG_TAG_BATTLE` unit',
  )
  lines.push(
    '  (`src/battle_setup.c:1470`). The `starttagbattle` macro expansion is not in the tree, so the tag-to-`BATTLE_TYPE_TWO_OPPONENTS`',
  )
  lines.push(
    '  link is inferred from `src/battle_main.c:1778` and `encounters.json`, not read from a macro.',
  )
  lines.push('')

  return `${lines.join('\n')}\n`
}
