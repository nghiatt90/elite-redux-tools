import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFunctionSlice } from './abilityHookInventory'
import { AUDIT_ALLOWLIST, type AuditAllowance } from './auditAllowlist'
import { VERIFIED_MOVE_EFFECTS } from './verifiedMoveEffects'
import {
  GENERATED_MOVE_EFFECT_NUMBERS,
  MOVE_EFFECTS_STORED_FOR_MOVEEND,
  SECONDARY_MOVE_EFFECT_MAP,
  isHandledMoveEffect,
} from '../moveEffects'

/**
 * Static completeness inventory for moves.json.
 *
 * Four unit kinds, each enumerated as one (move, unit) pair:
 *   1. `move-effect`      -- the move's `effect` field (`EFFECT_*`) in `data/v2.65beta/moves.json`.
 *   2. `secondary-effect` -- every `MOVE_EFFECT_*` in the behavior in force
 *      (`move.customBehavior ?? moveBehaviors[move.effect]`) plus the move's `argument.effect`.
 *   3. `flag`             -- every key whose value is true in `move.flags`.
 *   4. `legacy-script`    -- the behavior in force's `legacyConfig` script
 *      (`pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s` / `_2.s`).
 *
 * Nothing under `web/src/engine/` is imported for side effects here; the two
 * production constants this module extends with `export` are reported in
 * REPORT.md for this cycle.
 */

export type MoveUnitKind = 'move-effect' | 'secondary-effect' | 'flag' | 'legacy-script'
export type MoveUnitStatus = 'ported' | 'unported' | 'unclassified' | 'allowlisted'

export interface MoveUnit {
  kind: MoveUnitKind
  moveId: string
  unit: string
  status: MoveUnitStatus
  /** True when a production implementation exists but no qualifying test names the exact unit. */
  registeredUntested: boolean
  /** Upstream `file:line` evidence for the unit (script line, proto field, or allowlist citation). */
  citation: string
}

export interface MoveUnitKindSummary {
  kind: MoveUnitKind
  defined: number
  ported: number
  /** Sub-count of `unported`: production path exists, no exact test evidence found. */
  registeredUntested: number
  /** Includes `registeredUntested`. */
  unported: number
  unclassified: number
  allowlisted: number
}

export interface MovePowerWarning {
  moveId: string
  power: number
  effect: string
  script: string
  citation: string
}

export interface ScriptRecord {
  label: string
  file: string
  line: number
  commands: string[]
  truncated: boolean
  hasDamageStep: boolean
}

export interface MoveInventoryResult {
  units: MoveUnit[]
  summaries: MoveUnitKindSummary[]
  totalDefined: number
  totalPorted: number
  /** Includes registered-but-untested units. */
  totalUnported: number
  totalRegisteredUntested: number
  totalUnclassified: number
  totalAllowlisted: number
  powerWarnings: MovePowerWarning[]
  scripts: ScriptRecord[]
  flagCitations: Map<string, string>
  citedLocations: string[]
}

export interface MoveRecord {
  id: string
  effect?: string | null
  power?: number
  effectChance?: number
  flags?: Record<string, boolean>
  argument?: { kind?: string; effect?: string } | null
  customBehavior?: BehaviorRecord | null
}

export interface BehaviorRecord {
  legacyConfig?: string
  attack?: {
    secondaryEffects?: Array<{ effect?: string }>
  }
}

type MoveBehaviors = Record<string, BehaviorRecord>

export interface InventoryAllowlistEntry {
  kind: MoveUnitKind
  unit: string
  citation: string
}

const ENGINE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const MOVES_PATH = join(REPO_ROOT, 'data/v2.65beta/moves.json')
const MOVE_BEHAVIORS_PATH = join(REPO_ROOT, 'data/v2.65beta/moveBehaviors.json')
const SOURCES_LOCK_PATH = join(REPO_ROOT, 'sources.lock.json')
const BATTLE_SCRIPTS_PATHS = [
  'pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s',
  'pipeline/.upstream/eliteredux-source/data/battle_scripts_2.s',
]
const MOVE_EFFECT_PROTO_PATH = 'pipeline/.upstream/er-config/MoveEffect.proto'
const MOVE_LIST_PROTO_PATH = 'pipeline/.upstream/er-config/MoveList.proto'
const POKEMON_HEADER_PATH = 'pipeline/.upstream/eliteredux-source/include/constants/pokemon.h'
const EMIT_PY_PATH = 'pipeline/src/erdata/emit.py'
const TRAINERS_PATH = join(REPO_ROOT, 'data/v2.65beta/trainers.json')

/**
 * Files whose consuming-position references count as production move-effect handling.
 * A name in any other file -- or as a bare string in an array/Set/Record key, import
 * list or data table -- does not count, even if the file is under `web/src/engine/`.
 * See the D4 rule in REPORT.md / the generated doc.
 */
const MOVE_EFFECT_CONSUMER_FILES = [
  'web/src/engine/basePower.ts',
  'web/src/engine/multiHit.ts',
  'web/src/engine/calculate.ts',
  'web/src/engine/sim/hitScripts.ts',
  'web/src/engine/sim/damageResolver.ts',
  'web/src/engine/sim/attackCanceller.ts',
  'web/src/engine/sim/accuracy.ts',
  'web/src/engine/sim/moveTargetFlags.ts',
  'web/src/engine/sim/moveEnd.ts',
  'web/src/engine/sim/turn.ts',
  'web/src/engine/sim/turnOrder.ts',
  'web/src/engine/sim/moveEffects.ts',
  'web/src/engine/sim/statusEffects.ts',
]

const QUALIFYING_TEST_RE = /createSession|executeTurn|stepTurn|useMove|buildMoveAction|calculateMoveDamage/
const DAMAGE_STEP_COMMANDS = new Set(['damagecalc', 'typecalc', 'adjustdamage', 'healthbarupdate', 'datahpupdate'])

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

export function loadMoves(path: string = MOVES_PATH): MoveRecord[] {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as MoveRecord[]
  return raw.filter((move) => move.id !== 'MOVE_NONE')
}

export function loadMoveBehaviors(path: string = MOVE_BEHAVIORS_PATH): MoveBehaviors {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as { behaviors?: MoveBehaviors }
  if (!raw.behaviors) throw new Error(`${path} is missing the behaviors object`)
  return raw.behaviors
}

/** Every `.ts` file under web/src/engine except tests and this inventory's driver bookkeeping. */
function productionTypeScriptFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        const repoRelative = relative(REPO_ROOT, full)
        if (!repoRelative.startsWith('web/src/engine/sim/driver/')) files.push(full)
      }
    }
  }
  walk(ENGINE_DIR)
  return files
}

/** Removes comments so identifier mentions inside prose do not count as implementations. */
export function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const commentAt = line.indexOf('//')
      return commentAt >= 0 ? line.slice(0, commentAt) : line
    })
    .join('\n')
}

/** Removes data-only note blocks that intentionally list identifiers without handling them. */
function stripNoteOnlyBlocks(repoRelative: string, source: string): string {
  let out = source
  if (repoRelative === 'web/src/engine/basePower.ts') {
    const start = out.indexOf('export const UNMODELLED_BASE_POWER_EFFECTS')
    if (start >= 0) {
      const end = out.indexOf('])', start)
      if (end >= 0) out = out.slice(0, start) + out.slice(end + 2)
    }
  }
  if (repoRelative === 'web/src/engine/sim/moveEffects.ts') {
    // applySecondaryMoveEffects' final plain-damage allowlist only routes effects; the
    // comment block above it documents where each real implementation lives. Those ids
    // must not be mistaken for implementations of their own. Extract the function with
    // the shared helper so the slice boundaries stay identical to the ability inventory.
    const functionSlice = extractFunctionSlice(out, 'export function applySecondaryMoveEffects(')
    const start = out.indexOf("moveEffect === 'EFFECT_HIT' ||", out.indexOf(functionSlice))
    if (start >= 0) {
      const elseAt = out.indexOf('  } else {', start)
      const returnAt = elseAt >= 0 ? out.indexOf('return null', elseAt) : -1
      const closeAt = returnAt >= 0 ? out.indexOf('\n  }', returnAt) : -1
      if (closeAt >= 0) out = out.slice(0, start) + out.slice(closeAt)
    }
  }
  return out
}

/** Production source text with comments and note-only identifier blocks removed. */
export function loadProductionSource(): string {
  const parts: string[] = []
  for (const file of productionTypeScriptFiles()) {
    const repoRelative = relative(REPO_ROOT, file)
    const source = readFileSync(file, 'utf-8')
    parts.push(stripNoteOnlyBlocks(repoRelative, stripComments(source)))
  }
  return parts.join('\n')
}

/**
 * Comment-stripped text of the files whose consuming-position references count as a
 * move-effect (and secondary-effect) production path.
 */
export function loadMoveEffectConsumerSource(): string {
  return MOVE_EFFECT_CONSUMER_FILES.map((repoRelative) =>
    stripComments(readFileSync(join(REPO_ROOT, repoRelative), 'utf-8')),
  ).join('\n')
}

// ---------------------------------------------------------------------------
// Consumption extraction (cycle 151 D4)
// ---------------------------------------------------------------------------
//
// A unit is handled only when its identifier appears in a *consuming* position:
//   - a `case 'X':` / `case X:` label, or
//   - an equality/inequality comparison `=== 'X'` / `!== 'X'` / `=== X` / `!== X`.
// Bare membership in an array, Set, Record key, import list or data table is not a port.

/** Identifiers referenced by `case` labels or `===`/`!==` comparisons in `source`. */function extractConsumedNames(source: string, prefix: 'EFFECT_' | 'MOVE_EFFECT_'): Set<string> {
  const names = new Set<string>()
  const caseRe = new RegExp(`case\\s+['"]?(${prefix}[A-Z0-9_]+)['"]?\\s*:`, 'g')
  const compareRe = new RegExp(`(?:===|!==)\\s*['"]?(${prefix}[A-Z0-9_]+)['"]?`, 'g')
  for (const re of [caseRe, compareRe]) {
    let match: RegExpExecArray | null
    while ((match = re.exec(source)) !== null) names.add(match[1])
  }
  return names
}

function tryExtractFunctionSlice(source: string, declaration: string): string {
  try {
    return extractFunctionSlice(source, declaration)
  } catch {
    return ''
  }
}

interface ConsumptionIndex {
  moveEffects: Set<string>
  secondaryEffects: Set<string>
  /** Inclusive numeric ranges guarded by `baseEffectNum >= A` ... `baseEffectNum <= B`. */
  secondaryRanges: Array<[number, number]>
}

function resolveMoveEffectNumber(name: string): number | undefined {
  if (Object.prototype.hasOwnProperty.call(SECONDARY_MOVE_EFFECT_MAP, name)) return SECONDARY_MOVE_EFFECT_MAP[name]
  if (Object.prototype.hasOwnProperty.call(GENERATED_MOVE_EFFECT_NUMBERS, name)) return GENERATED_MOVE_EFFECT_NUMBERS[name]
  return undefined
}

/**
 * Builds the consumption index from comment-stripped consumer source. Move effects use
 * `case 'EFFECT_X':` / `=== 'EFFECT_X'` on the whole consumer text; secondary effects
 * additionally resolve the stat-change guard ranges inside `applySecondaryMoveEffects`.
 */
export function buildConsumptionIndex(source: string): ConsumptionIndex {
  const moveEffects = extractConsumedNames(source, 'EFFECT_')

  const applySecondary = tryExtractFunctionSlice(source, 'export function applySecondaryMoveEffects(')
  const applyPrimary = tryExtractFunctionSlice(source, 'export function applyPrimaryStatusEffect(')
  const secondaryEffects = new Set<string>()
  for (const name of extractConsumedNames(applySecondary, 'MOVE_EFFECT_')) secondaryEffects.add(name)
  for (const name of extractConsumedNames(applyPrimary, 'MOVE_EFFECT_')) secondaryEffects.add(name)
  // Stored-for-move-end effects are consumed by moveEnd.ts's `case 'MOVE_EFFECT_X':` switch,
  // which lives outside the two functions above; the whole consumer text is still a
  // consuming-position match (no bare-word fallback).
  for (const name of extractConsumedNames(source, 'MOVE_EFFECT_')) secondaryEffects.add(name)

  const secondaryRanges: Array<[number, number]> = []
  const rangeRe =
    /baseEffectNum\s*>=\s*(MOVE_EFFECT_[A-Z0-9_]+)[\s\S]{0,80}?baseEffectNum\s*<=\s*(MOVE_EFFECT_[A-Z0-9_]+)/g
  let match: RegExpExecArray | null
  while ((match = rangeRe.exec(applySecondary)) !== null) {
    const low = resolveMoveEffectNumber(match[1])
    const high = resolveMoveEffectNumber(match[2])
    if (low !== undefined && high !== undefined) secondaryRanges.push([low, high])
  }

  return { moveEffects, secondaryEffects, secondaryRanges }
}

function secondaryIsConsumed(name: string, index: ConsumptionIndex): boolean {
  if (index.secondaryEffects.has(name)) return true
  const value = resolveMoveEffectNumber(name)
  if (value === undefined) return false
  return index.secondaryRanges.some(([low, high]) => value >= low && value <= high)
}

/** Concatenated text of sim test files that exercise the action/damage entry points. */
export function loadQualifyingTestSource(): string {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.test.ts') && entry.name !== 'moveInventory.test.ts') {
        const source = readFileSync(full, 'utf-8')
        if (QUALIFYING_TEST_RE.test(source)) parts.push(source)
      }
    }
  }
  walk(ENGINE_DIR)
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Legacy script parsing (pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s and _2.s)
// ---------------------------------------------------------------------------

interface ScriptFile {
  repoRelative: string
  lines: string[]
}

const LABEL_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*::?\s*$/
const SCRIPT_REF_RE = /\bBattleScript_[A-Za-z0-9_]+\b/g

export function loadScriptFiles(): ScriptFile[] {
  return BATTLE_SCRIPTS_PATHS.map((repoRelative) => ({
    repoRelative,
    lines: readFileSync(join(REPO_ROOT, repoRelative), 'utf-8').split('\n'),
  }))
}

/** Every top-level label in both script files, with its linear command list up to the first terminator. */
export function parseScripts(files: ScriptFile[] = loadScriptFiles()): Map<string, ScriptRecord> {
  const scripts = new Map<string, ScriptRecord>()
  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const match = file.lines[i].match(LABEL_RE)
      if (!match) continue
      const label = match[1]
      if (scripts.has(label)) continue
      const commands: string[] = []
      let truncated = false
      for (let j = i + 1; j < file.lines.length; j++) {
        const trimmed = file.lines[j].trim()
        if (!trimmed || trimmed.startsWith('@') || LABEL_RE.test(trimmed)) continue
        commands.push(trimmed)
        const command = trimmed.split(/\s+/)[0]
        if (command === 'goto' || command === 'end' || command === 'return') break
      }
      if (commands.length > 60) truncated = true
      scripts.set(label, {
        label,
        file: file.repoRelative,
        line: i + 1,
        commands,
        truncated,
        hasDamageStep: false,
      })
    }
  }
  for (const record of scripts.values()) {
    record.hasDamageStep = scriptHasDamageStep(record.label, scripts)
  }
  return scripts
}

/**
 * True when the script, or any BattleScript_* target it delegates to, contains a
 * damage command. Delegation matters: BattleScript_EffectParalyzeHit has no local
 * `typecalc` but ends `goto BattleScript_EffectHit`
 * (pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:2857-2881), and
 * BattleScript_EffectArgumentHit delegates the same way (same file, :11831-11834).
 */
export function scriptHasDamageStep(
  label: string,
  scripts: Map<string, ScriptRecord>,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(label)) return false
  seen.add(label)
  const record = scripts.get(label)
  if (!record) return false
  for (const command of record.commands) {
    const opcode = command.split(/\s+/)[0]
    if (DAMAGE_STEP_COMMANDS.has(opcode)) return true
  }
  for (const command of record.commands) {
    for (const ref of command.match(SCRIPT_REF_RE) ?? []) {
      if (ref !== label && scriptHasDamageStep(ref, scripts, seen)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Citation loaders
// ---------------------------------------------------------------------------

/** pipeline/.upstream/er-config/MoveEffect.proto enum value -> line. */
export function loadMoveEffectProtoLines(): Map<string, number> {
  const source = readFileSync(join(REPO_ROOT, MOVE_EFFECT_PROTO_PATH), 'utf-8')
  const result = new Map<string, number>()
  let line = 0
  for (const text of source.split('\n')) {
    line++
    const match = text.match(/^\s*(MOVE_EFFECT_[A-Z0-9_]+)\s*=\s*\d+/)
    if (match) result.set(match[1], line)
  }
  return result
}

interface FlagMetadata {
  citation: string
}

/** moves.json flag key -> pipeline/.upstream/er-config/MoveList.proto field line (+ pipeline/.upstream/eliteredux-source/include/constants/pokemon.h FLAG define when the proto names one). */
export function loadFlagMetadata(): Map<string, FlagMetadata> {
  const emit = readFileSync(join(REPO_ROOT, EMIT_PY_PATH), 'utf-8')
  const protoFieldByKey = new Map<string, string>()
  for (const match of emit.matchAll(/^\s*"([A-Za-z0-9_]+)":\s*"([a-z0-9_]+)",\s*$/gm)) {
    protoFieldByKey.set(match[1], match[2])
  }

  const proto = readFileSync(join(REPO_ROOT, MOVE_LIST_PROTO_PATH), 'utf-8')
  const protoLines = proto.split('\n')
  const fieldLine = new Map<string, { line: number; flagCode: string | null }>()
  protoLines.forEach((text, index) => {
    const match = text.match(/^\s*bool\s+([a-z0-9_]+)\s*=\s*\d+\s*\[(.*)\];\s*$/)
    if (!match) return
    const code = match[2].match(/flag_code_value\)\s*=\s*"([^"]+)"/)
    fieldLine.set(match[1], { line: index + 1, flagCode: code ? code[1] : null })
  })

  const header = readFileSync(join(REPO_ROOT, POKEMON_HEADER_PATH), 'utf-8')
  const headerLines = header.split('\n')
  const defineLine = new Map<string, number>()
  headerLines.forEach((text, index) => {
    const match = text.match(/^\s*#define\s+(FLAG_[A-Z0-9_]+)\b/)
    if (match) defineLine.set(match[1], index + 1)
  })

  const metadata = new Map<string, FlagMetadata>()
  for (const [key, field] of protoFieldByKey) {
    const fieldInfo = fieldLine.get(field)
    const citations: string[] = []
    if (fieldInfo) citations.push(`${MOVE_LIST_PROTO_PATH}:${fieldInfo.line}`)
    const flagCode = fieldInfo?.flagCode
    if (flagCode && /^FLAG_[A-Z0-9_]+$/.test(flagCode)) {
      const defineAt = defineLine.get(flagCode)
      if (defineAt) citations.push(`${POKEMON_HEADER_PATH}:${defineAt}`)
    }
    metadata.set(key, { citation: citations.join('; ') })
  }
  return metadata
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function behaviorInForce(move: MoveRecord, behaviors: MoveBehaviors): BehaviorRecord {
  return move.customBehavior ?? (move.effect ? behaviors[move.effect] : undefined) ?? {}
}

function hasExactWord(haystack: string, needle: string): boolean {
  return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A flag is registered when production code reads it as a move flag, not when a comment names it. */
export function flagHasProductionRead(key: string, productionSource: string): boolean {
  const escaped = escapeRegExp(key)
  return (
    new RegExp(`[fF]lags\\??\\.${escaped}\\b`).test(productionSource) ||
    new RegExp(`hasMoveFlag\\([^)]*['"]${escaped}['"]`).test(productionSource) ||
    new RegExp(`flag\\s*===\\s*['"]${escaped}['"]`).test(productionSource)
  )
}

/**
 * Test evidence for a flag: the exact key is used as a move-flag property or read
 * through a flag helper. A bare quoted occurrence (a description string, an unrelated
 * field) is not evidence (cycle 151 D5).
 */
export function flagHasTestEvidence(key: string, testSource: string): boolean {
  const escaped = escapeRegExp(key)
  return (
    new RegExp(`\\b${escaped}\\s*:\\s*(?:true|false)`).test(testSource) ||
    new RegExp(`\\bflags\\??\\.${escaped}\\b`).test(testSource) ||
    new RegExp(`hasMoveFlag\\([^)]*['"]${escaped}['"]`).test(testSource)
  )
}

function secondaryHasProductionPath(name: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(SECONDARY_MOVE_EFFECT_MAP, name) ||
    Object.prototype.hasOwnProperty.call(GENERATED_MOVE_EFFECT_NUMBERS, name) ||
    MOVE_EFFECTS_STORED_FOR_MOVEEND.has(name)
  )
}

export const DEFAULT_ALLOWLIST: ReadonlyArray<InventoryAllowlistEntry> = AUDIT_ALLOWLIST.map(
  (entry: AuditAllowance) => ({ kind: 'move-effect' as const, unit: entry.effect, citation: entry.citation }),
)

function allowlistFor(
  kind: MoveUnitKind,
  unit: string,
  allowlist: ReadonlyArray<InventoryAllowlistEntry>,
): InventoryAllowlistEntry | undefined {
  return allowlist.find((entry) => entry.kind === kind && entry.unit === unit)
}

interface ClassifyContext {
  allowlist: ReadonlyArray<InventoryAllowlistEntry>
  productionSource: string
  /** Consuming-position identifiers from the restricted engine files. */
  consumption: ConsumptionIndex
  testSource: string
  /** Test source with comments removed; a comment is not flag test evidence (D5). */
  flagTestSource: string
  effectStatus: Map<string, MoveUnitStatus>
  effectRegisteredUntested: Map<string, boolean>
  effectCitations: Map<string, string>
  scriptRecords: Map<string, ScriptRecord>
  secondaryProtoLines: Map<string, number>
  flagMetadata: Map<string, FlagMetadata>
}

function classifyEffect(
  effect: string,
  ctx: ClassifyContext,
): { status: MoveUnitStatus; registeredUntested: boolean } {
  const allow = allowlistFor('move-effect', effect, ctx.allowlist)
  if (allow) return { status: 'allowlisted', registeredUntested: false }
  // Registry entry OR an occurrence in a consuming position. A bare identifier in an
  // array/Set/Record key, import list or data table does not count (D4).
  const production = isHandledMoveEffect(effect) || ctx.consumption.moveEffects.has(effect)
  const tested = VERIFIED_MOVE_EFFECTS.has(effect) || hasExactWord(ctx.testSource, effect)
  if (production && tested) return { status: 'ported', registeredUntested: false }
  if (production) return { status: 'unported', registeredUntested: true }
  return { status: 'unported', registeredUntested: false }
}

function classifySecondary(name: string, ctx: ClassifyContext): { status: MoveUnitStatus; registeredUntested: boolean } {
  const allow = allowlistFor('secondary-effect', name, ctx.allowlist)
  if (allow) return { status: 'allowlisted', registeredUntested: false }
  // Registry membership is necessary; the number (or its guard range / switch case) must
  // also be consumed. A name that resolves to a number with no case is unported (D4).
  const production = secondaryHasProductionPath(name) && secondaryIsConsumed(name, ctx.consumption)
  const tested = hasExactWord(ctx.testSource, name)
  if (production && tested) return { status: 'ported', registeredUntested: false }
  if (production) return { status: 'unported', registeredUntested: true }
  return { status: 'unported', registeredUntested: false }
}

function classifyFlag(key: string, ctx: ClassifyContext): { status: MoveUnitStatus; registeredUntested: boolean } {
  const allow = allowlistFor('flag', key, ctx.allowlist)
  if (allow) return { status: 'allowlisted', registeredUntested: false }
  const production = flagHasProductionRead(key, ctx.productionSource)
  const tested = flagHasTestEvidence(key, ctx.flagTestSource)
  if (production && tested) return { status: 'ported', registeredUntested: false }
  if (production) return { status: 'unported', registeredUntested: true }
  return { status: 'unported', registeredUntested: false }
}

/**
 * Builds the full inventory. Pure apart from the loader defaults: passing the
 * same data always produces the same units and counts.
 */
export function runInventory(
  moves: MoveRecord[],
  behaviors: MoveBehaviors,
  options: {
    productionSource?: string
    /** Overrides the consuming-position source used for move/secondary effects. */
    consumerSource?: string
    testSource?: string
    scripts?: Map<string, ScriptRecord>
    allowlist?: ReadonlyArray<InventoryAllowlistEntry>
  } = {},
): MoveInventoryResult {
  const allowlist = options.allowlist ?? DEFAULT_ALLOWLIST
  const productionSource = options.productionSource ?? loadProductionSource()
  // Synthetic callers that already pass a production source get the same text here;
  // real runs read only the restricted consumer files.
  const consumerSource =
    options.consumerSource ??
    (options.productionSource !== undefined ? options.productionSource : loadMoveEffectConsumerSource())
  const consumption = buildConsumptionIndex(consumerSource)
  const testSource = options.testSource ?? loadQualifyingTestSource()
  const flagTestSource = stripComments(testSource)
  const scripts = options.scripts ?? parseScripts()
  const effectProtoLines = loadMoveEffectProtoLines()
  const flagMetadata = loadFlagMetadata()

  const effectStatus = new Map<string, MoveUnitStatus>()
  const effectRegisteredUntested = new Map<string, boolean>()
  const effectCitations = new Map<string, string>()
  for (const move of moves) {
    if (move.effect == null || effectStatus.has(move.effect)) continue
    const classified = classifyEffect(move.effect, {
      allowlist,
      productionSource,
      consumption,
      testSource,
      flagTestSource,
      effectStatus,
      effectRegisteredUntested,
      effectCitations,
      scriptRecords: scripts,
      secondaryProtoLines: effectProtoLines,
      flagMetadata,
    })
    effectStatus.set(move.effect, classified.status)
    effectRegisteredUntested.set(move.effect, classified.registeredUntested)
    const script = behaviorInForce(move, behaviors).legacyConfig
    const record = script ? scripts.get(script) : undefined
    effectCitations.set(
      move.effect,
      record ? `${record.file}:${record.line}` : '',
    )
  }

  const units: MoveUnit[] = []
  const powerWarnings: MovePowerWarning[] = []

  for (const move of moves) {
    const behavior = behaviorInForce(move, behaviors)

    if (move.effect != null) {
      const status = effectStatus.get(move.effect) ?? 'unclassified'
      const allowance = allowlistFor('move-effect', move.effect, allowlist)
      units.push({
        kind: 'move-effect',
        moveId: move.id,
        unit: move.effect,
        status,
        registeredUntested: effectRegisteredUntested.get(move.effect) ?? false,
        citation: allowance?.citation ?? effectCitations.get(move.effect) ?? '',
      })
    }

    const secondaries = new Set<string>()
    for (const item of behavior.attack?.secondaryEffects ?? []) {
      if (item.effect) secondaries.add(item.effect)
    }
    if (move.argument?.kind === 'effect' && move.argument.effect) secondaries.add(move.argument.effect)
    for (const name of [...secondaries].sort()) {
      const classified = classifySecondary(name, {
        allowlist,
        productionSource,
        consumption,
        testSource,
        flagTestSource,
        effectStatus,
        effectRegisteredUntested,
        effectCitations,
        scriptRecords: scripts,
        secondaryProtoLines: effectProtoLines,
        flagMetadata,
      })
      const protoLine = effectProtoLines.get(name)
      const allowance = allowlistFor('secondary-effect', name, allowlist)
      units.push({
        kind: 'secondary-effect',
        moveId: move.id,
        unit: name,
        status: classified.status,
        registeredUntested: classified.registeredUntested,
        citation: allowance?.citation ?? (protoLine ? `${MOVE_EFFECT_PROTO_PATH}:${protoLine}` : ''),
      })
    }

    for (const [key, value] of Object.entries(move.flags ?? {})) {
      if (value !== true) continue
      const classified = classifyFlag(key, {
        allowlist,
        productionSource,
        consumption,
        testSource,
        flagTestSource,
        effectStatus,
        effectRegisteredUntested,
        effectCitations,
        scriptRecords: scripts,
        secondaryProtoLines: effectProtoLines,
        flagMetadata,
      })
      const allowance = allowlistFor('flag', key, allowlist)
      units.push({
        kind: 'flag',
        moveId: move.id,
        unit: key,
        status: classified.status,
        registeredUntested: classified.registeredUntested,
        citation: allowance?.citation ?? flagMetadata.get(key)?.citation ?? '',
      })
    }

    if (behavior.legacyConfig) {
      const record = scripts.get(behavior.legacyConfig)
      const status = move.effect != null ? effectStatus.get(move.effect) ?? 'unclassified' : 'unclassified'
      const registeredUntested = move.effect != null ? effectRegisteredUntested.get(move.effect) ?? false : false
      const allowance = allowlistFor('legacy-script', behavior.legacyConfig, allowlist)
      units.push({
        kind: 'legacy-script',
        moveId: move.id,
        unit: behavior.legacyConfig,
        status,
        registeredUntested,
        citation: allowance?.citation ?? (record ? `${record.file}:${record.line}` : ''),
      })
      if ((move.power ?? 0) > 1 && record && !record.hasDamageStep) {
        powerWarnings.push({
          moveId: move.id,
          power: move.power ?? 0,
          effect: move.effect ?? '',
          script: behavior.legacyConfig,
          citation: `${record.file}:${record.line}`,
        })
      }
    }
  }

  const summaries: MoveUnitKindSummary[] = (['move-effect', 'secondary-effect', 'flag', 'legacy-script'] as MoveUnitKind[]).map(
    (kind) => {
      const subset = units.filter((unit) => unit.kind === kind)
      return {
        kind,
        defined: subset.length,
        ported: subset.filter((unit) => unit.status === 'ported').length,
        registeredUntested: subset.filter((unit) => unit.status === 'unported' && unit.registeredUntested).length,
        unported: subset.filter((unit) => unit.status === 'unported').length,
        unclassified: subset.filter((unit) => unit.status === 'unclassified').length,
        allowlisted: subset.filter((unit) => unit.status === 'allowlisted').length,
      }
    },
  )

  const usedScriptLabels = new Set<string>()
  for (const move of moves) {
    const script = behaviorInForce(move, behaviors).legacyConfig
    if (script) usedScriptLabels.add(script)
  }

  const citedLocations = new Set<string>()
  for (const unit of units) {
    for (const location of unit.citation.split(';').map((part) => part.trim())) {
      if (location) citedLocations.add(location)
    }
  }
  for (const label of usedScriptLabels) {
    const record = scripts.get(label)
    if (record) citedLocations.add(`${record.file}:${record.line}`)
  }

  const total = (key: 'defined' | 'ported' | 'registeredUntested' | 'unported' | 'unclassified' | 'allowlisted') =>
    summaries.reduce((sum, summary) => sum + summary[key], 0)

  return {
    units,
    summaries,
    totalDefined: total('defined'),
    totalPorted: total('ported'),
    totalUnported: total('unported'),
    totalRegisteredUntested: total('registeredUntested'),
    totalUnclassified: total('unclassified'),
    totalAllowlisted: total('allowlisted'),
    powerWarnings,
    scripts: [...scripts.values()]
      .filter((record) => usedScriptLabels.has(record.label))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
    flagCitations: new Map([...flagMetadata].map(([key, value]) => [key, value.citation])),
    citedLocations: [...citedLocations].sort(),
  }
}

// ---------------------------------------------------------------------------
// Trainer grouping (cycle 151 D1)
// ---------------------------------------------------------------------------

export interface TrainerPartyMon {
  moves?: string[]
}

export interface TrainerRecord {
  id: string
  parties?: {
    ace?: TrainerPartyMon[]
    elite?: TrainerPartyMon[]
    hell?: TrainerPartyMon[]
  }
}

export function loadTrainers(path: string = TRAINERS_PATH): TrainerRecord[] {
  return JSON.parse(readFileSync(path, 'utf-8')) as TrainerRecord[]
}

/** move id -> sorted ids of the elite-tier trainers carrying it. Counted on the elite tier only. */
export function buildEliteTrainerIndex(trainers: TrainerRecord[]): Map<string, string[]> {
  const index = new Map<string, Set<string>>()
  for (const trainer of trainers) {
    for (const mon of trainer.parties?.elite ?? []) {
      for (const moveId of mon.moves ?? []) {
        let set = index.get(moveId)
        if (!set) {
          set = new Set()
          index.set(moveId, set)
        }
        set.add(trainer.id)
      }
    }
  }
  const result = new Map<string, string[]>()
  for (const [moveId, set] of index) result.set(moveId, [...set].sort())
  return result
}

export interface UnportedGroup {
  kind: MoveUnitKind
  unit: string
  statusLabel: string
  moveIds: string[]
  citations: string[]
  trainerIds: string[]
}

function statusLabelOf(status: MoveUnitStatus, registeredUntested: boolean): string {
  if (status === 'unported' && registeredUntested) return 'registered, untested'
  return status
}

/**
 * Groups unported (move, unit) pairs by unit, deterministically. Every group carries its
 * distinct move ids, its distinct citations and the elite-tier trainers whose party has
 * at least one of those moves.
 */
export function buildUnportedGroups(
  result: MoveInventoryResult,
  trainerIndex: Map<string, string[]>,
): UnportedGroup[] {
  const groups = new Map<string, { kind: MoveUnitKind; unit: string; units: MoveUnit[] }>()
  for (const unit of result.units) {
    if (unit.status !== 'unported') continue
    const key = `${unit.kind}\u0000${unit.unit}`
    let group = groups.get(key)
    if (!group) {
      group = { kind: unit.kind, unit: unit.unit, units: [] }
      groups.set(key, group)
    }
    group.units.push(unit)
  }

  const built: UnportedGroup[] = []
  for (const group of groups.values()) {
    const first = group.units[0]
    const trainers = new Set<string>()
    for (const moveId of new Set(group.units.map((unit) => unit.moveId))) {
      for (const trainerId of trainerIndex.get(moveId) ?? []) trainers.add(trainerId)
    }
    built.push({
      kind: group.kind,
      unit: group.unit,
      statusLabel: statusLabelOf(first.status, first.registeredUntested),
      moveIds: [...new Set(group.units.map((unit) => unit.moveId))].sort(),
      citations: [...new Set(group.units.map((unit) => unit.citation).filter(Boolean))].sort(),
      trainerIds: [...trainers].sort(),
    })
  }

  const kindOrder: MoveUnitKind[] = ['move-effect', 'secondary-effect', 'flag', 'legacy-script']
  return built.sort((a, b) =>
    a.kind !== b.kind
      ? kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind)
      : a.unit < b.unit
        ? -1
        : a.unit > b.unit
          ? 1
          : 0,
  )
}

const GROUP_MOVE_LIST_LIMIT = 15
const GROUP_TRAINER_LIST_LIMIT = 8

/** One deterministic markdown line per group; move ids collapse to the first 15, trainers to the first 8. */
export function formatUnportedGroup(group: UnportedGroup): string {
  const quote = (id: string) => `\`${id}\``
  const movePart =
    group.moveIds.length > GROUP_MOVE_LIST_LIMIT
      ? `${group.moveIds.length} moves (first ${GROUP_MOVE_LIST_LIMIT}): ${group.moveIds
          .slice(0, GROUP_MOVE_LIST_LIMIT)
          .map(quote)
          .join(', ')}`
      : `${group.moveIds.length} move${group.moveIds.length === 1 ? '' : 's'}: ${group.moveIds.map(quote).join(', ')}`
  const citationPart = group.citations.length > 0 ? `; ${group.citations.join('; ')}` : ''
  const trainerPart =
    group.trainerIds.length === 0
      ? 'no elite-tier trainer carries them'
      : group.trainerIds.length > GROUP_TRAINER_LIST_LIMIT
        ? `${group.trainerIds.length} elite-tier trainers (first ${GROUP_TRAINER_LIST_LIMIT}): ${group.trainerIds
            .slice(0, GROUP_TRAINER_LIST_LIMIT)
            .map(quote)
            .join(', ')}`
        : `${group.trainerIds.length} elite-tier trainer${group.trainerIds.length === 1 ? '' : 's'}: ${group.trainerIds
            .map(quote)
            .join(', ')}`
  return `- \`${group.unit}\` (${group.statusLabel}): ${movePart}${citationPart}; ${trainerPart}`
}

// ---------------------------------------------------------------------------
// Doc generation
// ---------------------------------------------------------------------------

export function generateMoveInventoryDoc(
  result: MoveInventoryResult,
  sourcesLockPath: string = SOURCES_LOCK_PATH,
  trainersPath: string = TRAINERS_PATH,
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
  const trainerIndex = buildEliteTrainerIndex(loadTrainers(trainersPath))
  const groups = buildUnportedGroups(result, trainerIndex)
  const groupsOfKind = (kind: MoveUnitKind) => groups.filter((group) => group.kind === kind)

  const lines: string[] = []
  lines.push('# Move Completeness Inventory')
  lines.push('')
  lines.push(
    'Static inventory of every (move, effect-unit) pair for `data/v2.65beta/moves.json` (excluding `MOVE_NONE`).',
  )
  lines.push('')
  lines.push(`- **Source Commit (eliteredux-source)**: \`${elitereduxSourceSha}\` (game version \`${gameVersion}\`)`)
  lines.push(`- **Source Commit (er-config)**: \`${erConfigSha}\``)
  lines.push(
    '- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/moveInventory.test.ts`',
  )
  lines.push('')

  lines.push('## Unit Kinds and Classification Rules')
  lines.push('')
  lines.push('A pair is **ported** only when a production code path handles it **and** at least one qualifying sim test')
  lines.push('names the exact unit. `registered, untested` means production handles it but no test names it; it is counted')
  lines.push('as unported. A pair is **unclassified** when the unit id is missing/empty. Allowlisted pairs cite upstream C.')
  lines.push('')
  lines.push(
    '1. **move-effect**: the move\'s `effect` (`EFFECT_*`). Production = `isHandledMoveEffect` or the id in a',
  )
  lines.push(
    '   consuming position (`case \'EFFECT_X\':`, `=== \'EFFECT_X\'`, `!== \'EFFECT_X\'`) in the restricted engine',
  )
  lines.push(
    '   files `basePower.ts`, `multiHit.ts`, `calculate.ts` and `sim/{hitScripts,damageResolver,attackCanceller,',
  )
  lines.push(
    '   accuracy,moveTargetFlags,moveEnd,turn,turnOrder,moveEffects,statusEffects}.ts`. A bare string in an',
  )
  lines.push(
    '   array/Set/Record key, import list or data table anywhere (including `web/src/engine/`) does not count.',
  )
  lines.push('   Test evidence = exact id in a sim test using')
  lines.push('   `createSession`/`executeTurn`/`stepTurn`/`useMove`/`buildMoveAction`/`calculateMoveDamage`,')
  lines.push('   or membership in `VERIFIED_MOVE_EFFECTS`.')
  lines.push(
    '2. **secondary-effect**: every `MOVE_EFFECT_*` in the behavior in force',
  )
  lines.push(
    '   (`customBehavior ?? moveBehaviors[effect]`) plus `move.argument.effect`. Production = registry',
  )
  lines.push(
    '   membership (`SECONDARY_MOVE_EFFECT_MAP` / `GENERATED_MOVE_EFFECT_NUMBERS` / `MOVE_EFFECTS_STORED_FOR_MOVEEND`)',
  )
  lines.push(
    '   **and** consumption: a `case` label in `applyPrimaryStatusEffect`, a `===`/`!==` comparison in the named',
  )
  lines.push(
    '   functions, or an inclusive `baseEffectNum >= A ... <= B` stat-change guard range. A registered name whose',
  )
  lines.push('   number has no case is unported.')
  lines.push(
    '3. **flag**: every true key in `move.flags`. Production = a move-flag read in engine source',
  )
  lines.push(
    '   (`flags.<key>`, `moveFlags.<key>`, `hasMoveFlag(..., \'<key>\')`, `flag === \'<key>\'`). Test evidence =',
  )
  lines.push(
    '   `\\b<key>: true|false`, `flags.<key>` or `hasMoveFlag(..., \'<key>\')` in a qualifying sim test; a bare',
  )
  lines.push('   quoted occurrence is not evidence.')
  lines.push(
    '4. **legacy-script**: the behavior in force\'s `legacyConfig` from `data/battle_scripts_1.s`/`_2.s`.',
  )
  lines.push(
    '   Its status mirrors the owning move effect\'s status: the script is the effect\'s implementation, so it has a',
  )
  lines.push('   port exactly when that effect does. The script section lists every script once with its commands.')
  lines.push('')
  lines.push(
    '`EFFECT_HIT` is plain damage: it has no `attack.secondaryEffects`, its script is `BattleScript_EffectHit`, and a',
  )
  lines.push('move whose effect is `EFFECT_HIT` therefore produces **no** secondary-effect unit.')
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push('| Unit kind | Defined | Ported | Registered, untested | Unported | Unclassified | Allowlisted |')
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
    `Unported includes registered-but-untested. C/script locations cited: ${result.citedLocations.length}.`,
  )
  lines.push('')

  lines.push('## Moves With Power Above 1 Whose Script Has No Damage Step')
  lines.push('')
  if (result.powerWarnings.length === 0) {
    lines.push('None.')
  } else {
    for (const warning of result.powerWarnings) {
      lines.push(
        `- \`${warning.moveId}\` (power ${warning.power}, \`${warning.effect}\`) -> \`${warning.script}\` (${warning.citation})`,
      )
    }
  }
  lines.push('')

  const pushGroupSection = (title: string, kind: MoveUnitKind): void => {
    lines.push(`## ${title}`)
    lines.push('')
    lines.push(
      'One line per unit. Move count is the number of distinct moves carrying the unit (all move ids listed up to',
    )
    lines.push(
      '15, collapsed past that); trainer counts are **elite-tier only** -- the number of trainers whose elite party',
    )
    lines.push('has at least one of the group\'s moves (first 8 ids listed). Trainer ids are sorted.')
    lines.push('')
    const kindGroups = groupsOfKind(kind)
    if (kindGroups.length === 0) lines.push('None.')
    for (const group of kindGroups) lines.push(formatUnportedGroup(group))
    lines.push('')
  }

  pushGroupSection('Unported Move-Effect Groups', 'move-effect')
  pushGroupSection('Unported Secondary-Effect Groups', 'secondary-effect')
  pushGroupSection('Unported Flag Groups', 'flag')
  pushGroupSection('Unported Legacy-Script Groups', 'legacy-script')

  lines.push('## Allowlisted Pairs')
  lines.push('')
  const allowlisted = result.units.filter((unit) => unit.status === 'allowlisted')
  if (allowlisted.length === 0) lines.push('None.')
  const allowlistedKeys = new Set<string>()
  for (const unit of allowlisted) {
    const key = `${unit.kind}:${unit.unit}:${unit.citation}`
    if (allowlistedKeys.has(key)) continue
    allowlistedKeys.add(key)
    lines.push(`- \`${unit.kind}\` \`${unit.unit}\`; ${unit.citation}`)
  }
  lines.push('')

  lines.push('## Legacy Scripts')
  lines.push('')
  lines.push(
    'Every distinct `legacyConfig` script used by a move, sorted by label. `Damage step` is true when the script or',
  )
  lines.push(
    'any `BattleScript_*` target it delegates to runs `damagecalc`/`typecalc`/`adjustdamage`/`healthbarupdate`/',
  )
  lines.push('`datahpupdate`. Commands are listed up to the first `goto`/`end`/`return`, capped at 60.')
  lines.push('')
  for (const script of result.scripts) {
    const commands = script.commands.slice(0, 60).join('; ') + (script.truncated ? '; ...' : '')
    lines.push(
      `- \`${script.label}\` (${script.file}:${script.line}) damage=${script.hasDamageStep ? 'yes' : 'no'}: ${commands || '(no commands)'}`,
    )
  }
  lines.push('')

  return `${lines.join('\n')}\n`
}

export const MOVE_INVENTORY_DOC_PATH = join(REPO_ROOT, 'docs/battle-sim/move-inventory.md')
export const MOVE_INVENTORY_TEST_ENGINE_DIR = ENGINE_DIR
