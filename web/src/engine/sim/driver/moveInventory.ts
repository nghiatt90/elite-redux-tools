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
} from '../moveEffects'

/**
 * Static completeness inventory for moves.json.
 *
 * Five unit kinds, each enumerated as one (move, unit) pair:
 *   1. `move-effect`      -- the move's `effect` field (`EFFECT_*`) in `data/v2.65beta/moves.json`.
 *   2. `secondary-effect` -- every `MOVE_EFFECT_*` in the behavior in force
 *      (`move.customBehavior ?? moveBehaviors[move.effect]`) plus the move's `argument.effect`.
 *   3. `flag`             -- every key whose value is true in `move.flags`.
 *   4. `legacy-script`    -- the behavior in force's `legacyConfig` script
 *      (`pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s` / `_2.s`).
 *   5. `effect-less`      -- a move whose `effect` is null (no `EFFECT_*` unit exists for it).
 *
 * Nothing under `web/src/engine/` is imported for side effects here; the two
 * production constants this module extends with `export` are reported in
 * REPORT.md for this cycle.
 */

export type MoveUnitKind = 'move-effect' | 'secondary-effect' | 'flag' | 'legacy-script' | 'effect-less'
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
    secondaryEffects?: Array<{ effect?: string; kind?: string; argumentEffect?: boolean }>
    recoilFraction?: number
    superEffectiveVs?: string | null
    ignoreTypeImmunity?: boolean
    damage?: { conditions?: unknown[]; modifier?: unknown }
  }
  causesFlinch?: boolean
  trappingEffect?: boolean
  options?: Record<string, boolean>
}

type MoveBehaviors = Record<string, BehaviorRecord>

export interface InventoryAllowlistEntry {
  kind: MoveUnitKind
  unit: string
  citation: string
  /** Exact notes the entry covers. Omitted = every note of the unit (effect-wide). */
  notes?: readonly string[]
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
const BATTLE_CONFIG_PATH = join(
  REPO_ROOT,
  'pipeline/.upstream/eliteredux-source/include/constants/battle_config.h',
)

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
    stripNoteOnlyBlocks(repoRelative, stripComments(readFileSync(join(REPO_ROOT, repoRelative), 'utf-8'))),
  ).join('\n')
}

/** True for a sim source file whose move-pipeline reads count as flag production. */
function isFlagProductionFile(repoRelative: string): boolean {
  if (!repoRelative.startsWith('web/src/engine/sim/')) return false
  if (repoRelative.startsWith('web/src/engine/sim/ai/')) return false
  if (repoRelative.startsWith('web/src/engine/sim/driver/')) return false
  // Ability dispatch is not part of the move pipeline (item 5).
  return !/Ability[^/]*\.ts$/.test(repoRelative)
}

function flagProductionFiles(): string[] {
  const files = new Set(MOVE_EFFECT_CONSUMER_FILES.map((repoRelative) => join(REPO_ROOT, repoRelative)))
  for (const file of productionTypeScriptFiles()) {
    const repoRelative = relative(REPO_ROOT, file)
    if (isFlagProductionFile(repoRelative)) files.add(file)
  }
  return [...files]
}

/**
 * Comment-stripped move-pipeline source in which a flag read counts as production:
 * `MOVE_EFFECT_CONSUMER_FILES` plus the sim sources, excluding `sim/ai/` and ability
 * files. A flag read only in AI or ability code does not count (cycle 151b item 5).
 */
export function loadFlagProductionSource(): string {
  return flagProductionFiles()
    .map((file) => stripNoteOnlyBlocks(relative(REPO_ROOT, file), stripComments(readFileSync(file, 'utf-8'))))
    .join('\n')
}

// ---------------------------------------------------------------------------
// Consumption extraction (cycle 151 D4)
// ---------------------------------------------------------------------------
//
// A unit is handled only when its identifier appears in a *consuming* position:
//   - a `case 'X':` / `case X:` label, or
//   - an equality/inequality comparison `=== 'X'` / `!== 'X'` / `=== X` / `!== X`.
// Bare membership in an array, Set, Record key, import list or data table is not a port.

/** Identifiers referenced by `case` labels or `===`/`!==` comparisons in `source`. */
function extractConsumedNames(source: string, prefix: 'EFFECT_' | 'MOVE_EFFECT_'): Set<string> {
  const names = new Set<string>()
  const caseRe = new RegExp(`case\\s+['"]?(${prefix}[A-Z0-9_]+)['"]?\\s*:`, 'g')
  const compareRe = new RegExp(`(?:===|!==)\\s*['"]?(${prefix}[A-Z0-9_]+)['"]?`, 'g')
  for (const re of [caseRe, compareRe]) {
    let match: RegExpExecArray | null
    while ((match = re.exec(source)) !== null) names.add(match[1])
  }
  return names
}

function extractCaseLabels(source: string, prefix: 'EFFECT_' | 'MOVE_EFFECT_'): Set<string> {
  const names = new Set<string>()
  const caseRe = new RegExp(`case\\s+['"]?(${prefix}[A-Z0-9_]+)['"]?\\s*:`, 'g')
  let match: RegExpExecArray | null
  while ((match = caseRe.exec(source)) !== null) names.add(match[1])
  return names
}

function tryExtractFunctionSlice(source: string, declaration: string): string {
  try {
    return extractFunctionSlice(source, declaration)
  } catch {
    return ''
  }
}

/** Removes a top-level function (or const) declaration slice when present. */
function removeFunctionSlice(source: string, declaration: string): string {
  const slice = tryExtractFunctionSlice(source, declaration)
  return slice ? source.replace(slice, '') : source
}

/**
 * Conditionals dead-code stripping. A comparison followed by `&& false` (or guarded by
 * `if (false)`) is not a live dispatch site: a real port must execute.
 */
export function stripDeadCode(source: string): string {
  let out = source
  // `moveEffect === 'EFFECT_X' && false` / `false && moveEffect === 'EFFECT_X'`
  out = out.replace(
    /((?:===|!==)\s*['"]?(?:EFFECT_|MOVE_EFFECT_)[A-Z0-9_]+['"]?)\s*&&\s*false\b/g,
    'false',
  )
  out = out.replace(
    /\bfalse\s*&&\s*((?:===|!==)\s*['"]?(?:EFFECT_|MOVE_EFFECT_)[A-Z0-9_]+['"]?)/g,
    'false',
  )
  // `if (false) { ... }` (brace matched, single nesting level is enough here)
  const falseIf = /if\s*\(\s*false\s*\)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = falseIf.exec(out)) !== null) {
    const open = out.indexOf('{', match.index)
    const close = matchBrace(out, open, '{', '}')
    if (close < 0) break
    out = out.slice(0, match.index) + out.slice(close + 1)
    falseIf.lastIndex = match.index
  }
  return out
}

/** Removes the final plain-hit routing allowlist from applySecondaryMoveEffects. */
function stripPlainHitRoutingChain(source: string): string {
  const functionSlice = tryExtractFunctionSlice(source, 'export function applySecondaryMoveEffects(')
  const start = source.indexOf("moveEffect === 'EFFECT_HIT' ||", source.indexOf(functionSlice))
  if (start < 0) return source
  const elseAt = source.indexOf('  } else {', start)
  const returnAt = elseAt >= 0 ? source.indexOf('return null', elseAt) : -1
  const closeAt = returnAt >= 0 ? source.indexOf('\n  }', returnAt) : -1
  return closeAt >= 0 ? source.slice(0, start) + source.slice(closeAt) : source
}

interface ConsumptionIndex {
  moveEffects: Set<string>
  secondaryEffects: Set<string>
  /** Inclusive numeric ranges guarded by `baseEffectNum >= A` ... `baseEffectNum <= B`. */
  secondaryRanges: Array<[number, number]>
  /** `HANDLERS` entries whose handler body does real work (not note-only, not a no-op). */
  handledEffects: Set<string>
  /** Every `HANDLERS` key, whatever the body does. */
  handlerEffects: Set<string>
  /** Keys of basePower.ts's CUSTOM_MOVE_DAMAGE Record. */
  customDamageEffects: Set<string>
  /** Effects whose declared behaviour field is read by generic pipeline code. */
  declarativeEffects: Set<string>
  /** Effects with a case in hitScripts.ts's runLegacyPreHit / runLegacyPostHit. */
  preHitEffects: Set<string>
  postHitEffects: Set<string>
  /** True when the damage path reads `.effect` for effect-null moves. */
  effectLessProduction: boolean
}

function resolveMoveEffectNumber(name: string): number | undefined {
  if (Object.prototype.hasOwnProperty.call(SECONDARY_MOVE_EFFECT_MAP, name)) return SECONDARY_MOVE_EFFECT_MAP[name]
  if (Object.prototype.hasOwnProperty.call(GENERATED_MOVE_EFFECT_NUMBERS, name)) return GENERATED_MOVE_EFFECT_NUMBERS[name]
  return undefined
}

// ---------------------------------------------------------------------------
// Declarative behaviour fields (cycle 151b item 3)
// ---------------------------------------------------------------------------
//
// Some effects have no dispatch site because their whole behaviour is a field on
// `moveBehaviors.json` read by generic code (`attack.secondaryEffects`,
// `attack.damage`, `attack.recoilFraction`, ...). A field only counts when the
// generic read is present in the consumer source: the probe below is matched
// against that source, so a field the sim does not read (trappingEffect) stays
// unported.

interface DeclarativeRule {
  id: string
  /** Every probe must match the consumer source for the field to count as read. */
  probes: RegExp[]
  applies: (behavior: BehaviorRecord) => boolean
}

const DECLARATIVE_RULES: DeclarativeRule[] = [
  {
    id: 'attack.secondaryEffects',
    probes: [/\.secondaryEffects\b/],
    applies: (behavior) => (behavior.attack?.secondaryEffects?.length ?? 0) > 0,
  },
  {
    id: 'attack.damage',
    probes: [/\.conditions\b/, /\.modifier\b/],
    applies: (behavior) => behavior.attack?.damage != null,
  },
  {
    id: 'attack.recoilFraction',
    probes: [/\.recoilFraction\b/],
    applies: (behavior) => (behavior.attack?.recoilFraction ?? 0) > 0,
  },
  {
    id: 'attack.superEffectiveVs',
    probes: [/\.superEffectiveVs\b/],
    applies: (behavior) => Boolean(behavior.attack?.superEffectiveVs),
  },
  {
    id: 'attack.ignoreTypeImmunity',
    probes: [/\.ignoreTypeImmunity\b/],
    applies: (behavior) => Boolean(behavior.attack?.ignoreTypeImmunity),
  },
  {
    id: 'options',
    probes: [/\.options\b/],
    applies: (behavior) => behavior.options != null,
  },
  {
    id: 'causesFlinch',
    probes: [/\.causesFlinch\b/],
    applies: (behavior) => behavior.causesFlinch === true,
  },
  {
    id: 'trappingEffect',
    probes: [/\.trappingEffect\b/],
    applies: (behavior) => behavior.trappingEffect === true,
  },
]

function declarativeEffectsFor(
  consumerSource: string,
  moves: MoveRecord[],
  behaviors: MoveBehaviors,
): Set<string> {
  const active = DECLARATIVE_RULES.filter((rule) => rule.probes.every((probe) => probe.test(consumerSource)))
  const effects = new Set<string>()
  for (const move of moves) {
    if (!move.effect) continue
    const behavior = behaviorInForce(move, behaviors)
    if (active.some((rule) => rule.applies(behavior))) effects.add(move.effect)
  }
  return effects
}

// ---------------------------------------------------------------------------
// Handler / Record parsing (cycle 151b item 1/3)
// ---------------------------------------------------------------------------

const HANDLERS_DECL = 'const HANDLERS: Record<string, MoveEffectHandler> = {'
const CUSTOM_DAMAGE_DECL = 'const CUSTOM_MOVE_DAMAGE: Record<string, (baseDamage: number, ctx: DamageContext) => number> = {'
const LEGACY_PRE_HIT_DECL = 'export function runLegacyPreHit('
const LEGACY_POST_HIT_DECL = 'export function runLegacyPostHit('

const IGNORED_CALL_NAMES = new Set([
  'outcome',
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'typeof',
  'Number',
  'Boolean',
  'String',
  'Math',
  'Object',
  'Array',
  'Set',
  'Map',
  'JSON',
  'Error',
  'parseInt',
  'parseFloat',
  'isNaN',
])

/** True when `source[index]` opens a `{}`/`()`/`[]` pair; returns the matching close index. */
function matchPair(source: string, openIndex: number, opener: string, closer: string): number {
  if (source[openIndex] !== opener) return -1
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      i++
      while (i < source.length) {
        if (source[i] === '\\') i += 2
        else if (source[i] === quote) break
        else i++
      }
      continue
    }
    if (char === opener) depth++
    else if (char === closer) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const matchBrace = (source: string, index: number, opener: string, closer: string) =>
  matchPair(source, index, opener, closer)

function stripStringLiterals(source: string): string {
  return source.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''")
}

/** Removes `unmodelled.push(...)` calls and reports how many notes were found. */
function removeUnmodelledPushes(source: string): { text: string; count: number } {
  let text = source
  let count = 0
  const re = /\bunmodelled\.push\s*\(/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const open = text.indexOf('(', match.index)
    const close = matchPair(text, open, '(', ')')
    if (close < 0) break
    let start = match.index
    // Include a trailing `ctx.` / destructured-object prefix so no dangling receiver remains.
    const prefix = text.slice(0, start).match(/[\w$]*\s*\.\s*$/)
    if (prefix) start -= prefix[0].length
    text = text.slice(0, start) + text.slice(close + 1)
    count++
    re.lastIndex = start
  }
  return { text, count }
}

/** Removes local `const`/`let`/`var` declarations (state writes are checked separately). */
function removeLocalDeclarations(source: string): string {
  const re = /\b(?:const|let|var)\b/g
  let text = source
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    let depth = 0
    let end = match.index
    for (; end < text.length; end++) {
      const char = text[end]
      if (char === '(' || char === '{' || char === '[') depth++
      else if (char === ')' || char === '}' || char === ']') depth--
      else if ((char === ';' || char === '\n') && depth <= 0) break
    }
    text = text.slice(0, match.index) + text.slice(end + 1)
    re.lastIndex = match.index
  }
  return text
}

export type HandlerBodyVerdict = 'real' | 'noteOnly' | 'noop'

/**
 * Classifies a handler body. A body whose only statements push to `unmodelled`
 * (or do nothing but return an outcome) is not a port: turning a handler
 * note-only or into a no-op must make its effect unported (cycle 151b item 1).
 * Any call other than the ignored combinators, or any assignment / increment,
 * counts as real work.
 */
export function analyzeHandlerBody(slice: string): HandlerBodyVerdict {
  const open = slice.indexOf('{')
  if (open < 0) return 'real'
  const body = slice.slice(open)
  const withoutNotes = removeUnmodelledPushes(body)
  const cleaned = stripStringLiterals(withoutNotes.text)
  for (const call of cleaned.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!IGNORED_CALL_NAMES.has(call[1])) return 'real'
  }
  const withoutDeclarations = removeLocalDeclarations(cleaned)
  if (/(^|[^=!<>+\-*/%&|^?:])=(?!=)/.test(withoutDeclarations)) return 'real'
  if (/\+\+|--/.test(withoutDeclarations)) return 'real'
  return withoutNotes.count > 0 ? 'noteOnly' : 'noop'
}

function extractRecordEntries(source: string, declaration: string): Map<string, string> {
  const start = source.indexOf(declaration)
  const entries = new Map<string, string>()
  if (start < 0) return entries
  const end = source.indexOf('\n}', start)
  const block = end < 0 ? source.slice(start) : source.slice(start, end + 2)
  for (const match of block.matchAll(/^\s{2}(EFFECT_[A-Z0-9_]+):\s*(.+?),?\s*$/gm)) {
    entries.set(match[1], match[2].trim())
  }
  return entries
}

/** `HANDLERS` keys whose implementation is real (an inline arrow, or a non-stub body). */
export function handledMoveEffects(source: string): Set<string> {
  const handled = new Set<string>()
  for (const [effect, value] of extractRecordEntries(source, HANDLERS_DECL)) {
    if (value.includes('=>')) {
      handled.add(effect)
      continue
    }
    const body = tryExtractFunctionSlice(source, `function ${value}(`)
    if (body && analyzeHandlerBody(body) === 'real') handled.add(effect)
  }
  return handled
}

/** Keys of basePower.ts's `CUSTOM_MOVE_DAMAGE` Record (a Record-keyed port, like HANDLERS). */
export function customDamageEffects(source: string): Set<string> {
  return new Set(extractRecordEntries(source, CUSTOM_DAMAGE_DECL).keys())
}

/**
 * Builds the consumption index from comment-stripped consumer source. A move effect
 * counts only at a dispatch site: a real `HANDLERS` entry, a `CUSTOM_MOVE_DAMAGE`
 * key, a declarative-field read, or a `case`/`===` comparison outside the predicate,
 * list and routing functions that merely classify or build effect specs.
 */
export function buildConsumptionIndex(
  source: string,
  moves: MoveRecord[] = [],
  behaviors: MoveBehaviors = {},
): ConsumptionIndex {
  const live = stripDeadCode(stripPlainHitRoutingChain(source))
  const moveEffectText = [
    'export function isHealingMoveEffect(',
    'export function isPreventableSecondaryEffect(',
    'function isTwoTurnsMoveEffect(',
    'function isTwoTurnsMove(',
  ].reduce((text, declaration) => removeFunctionSlice(text, declaration), live)

  const moveEffects = extractConsumedNames(moveEffectText, 'EFFECT_')

  const applySecondary = tryExtractFunctionSlice(live, 'export function applySecondaryMoveEffects(')
  const applyPrimary = tryExtractFunctionSlice(live, 'export function applyPrimaryStatusEffect(')
  const runMoveEnd = tryExtractFunctionSlice(live, 'export function runMoveEnd(')
  const secondaryEffects = new Set<string>()
  for (const name of extractConsumedNames(applySecondary, 'MOVE_EFFECT_')) secondaryEffects.add(name)
  for (const name of extractConsumedNames(applyPrimary, 'MOVE_EFFECT_')) secondaryEffects.add(name)
  // Stored-for-move-end effects are consumed by runMoveEnd's `switch (ctx.moveEffect2)`.
  for (const name of extractConsumedNames(runMoveEnd, 'MOVE_EFFECT_')) secondaryEffects.add(name)

  const secondaryRanges: Array<[number, number]> = []
  const rangeRe =
    /baseEffectNum\s*>=\s*(MOVE_EFFECT_[A-Z0-9_]+)[\s\S]{0,80}?baseEffectNum\s*<=\s*(MOVE_EFFECT_[A-Z0-9_]+)/g
  let match: RegExpExecArray | null
  while ((match = rangeRe.exec(applySecondary)) !== null) {
    const low = resolveMoveEffectNumber(match[1])
    const high = resolveMoveEffectNumber(match[2])
    if (low !== undefined && high !== undefined) secondaryRanges.push([low, high])
  }

  const preHit = tryExtractFunctionSlice(live, LEGACY_PRE_HIT_DECL)
  const postHit = tryExtractFunctionSlice(live, LEGACY_POST_HIT_DECL)

  return {
    moveEffects,
    secondaryEffects,
    secondaryRanges,
    handledEffects: handledMoveEffects(live),
    handlerEffects: new Set(extractRecordEntries(live, HANDLERS_DECL).keys()),
    customDamageEffects: customDamageEffects(live),
    declarativeEffects: declarativeEffectsFor(live, moves, behaviors),
    preHitEffects: extractCaseLabels(preHit, 'EFFECT_'),
    postHitEffects: extractCaseLabels(postHit, 'EFFECT_'),
    effectLessProduction: /\.effect\s*(?:===|!==)\s*null/.test(live),
  }
}

function secondaryIsConsumed(name: string, index: ConsumptionIndex): boolean {
  if (index.secondaryEffects.has(name)) return true
  const value = resolveMoveEffectNumber(name)
  if (value === undefined) return false
  return index.secondaryRanges.some(([low, high]) => value >= low && value <= high)
}

// ---------------------------------------------------------------------------
// Test evidence (cycle 151b item 2/5)
// ---------------------------------------------------------------------------
//
// The unit must be named in the same `it(` / `test(` block as a call that runs a
// move through the sim (`executeTurn` / `calculateMoveDamage` / ...). A comment,
// an AI scoring test (they assert scores, not execution), a data sentinel
// (`if (...) throw`) and a `.not.toContain('... not modelled')` assertion are not
// evidence. `sim/ai/` files are excluded when the source is loaded.

interface TestBlock {
  words: Set<string>
  text: string
}

export interface TestEvidence {
  blocks: TestBlock[]
}

/** Splits test source into `it(...)` / `test(...)` call blocks (paren matching). */
export function splitTestBlocks(source: string): string[] {
  const blocks: string[] = []
  const re = /\b(?:it|test)\s*\(/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const open = source.indexOf('(', match.index)
    const close = matchPair(source, open, '(', ')')
    if (close < 0) break
    blocks.push(source.slice(match.index, close + 1))
    re.lastIndex = close + 1
  }
  return blocks
}

/** Removes negative assertions and sentinel throws so their strings/names are not evidence. */
function stripNonEvidence(block: string): string {
  let text = block
  for (const needle of ['.not.toContain(', '.not.toMatch(']) {
    let at = text.indexOf(needle)
    while (at >= 0) {
      const open = text.indexOf('(', at + needle.length - 1)
      const close = matchPair(text, open, '(', ')')
      if (close < 0) break
      text = text.slice(0, at) + text.slice(close + 1)
      at = text.indexOf(needle, at)
    }
  }
  // `if (<condition>) throw ...` data sentinels.
  const sentinel = /if\s*\(/g
  let match: RegExpExecArray | null
  while ((match = sentinel.exec(text)) !== null) {
    const open = text.indexOf('(', match.index)
    const close = matchPair(text, open, '(', ')')
    if (close < 0) break
    const after = text.slice(close + 1).match(/^\s*throw\b/)
    if (!after) continue
    const terminators = [text.indexOf(';', close), text.indexOf('\n', close)].filter((index) => index >= 0)
    const end = terminators.length > 0 ? Math.min(...terminators) : text.length - 1
    text = text.slice(0, match.index) + text.slice(end + 1)
    sentinel.lastIndex = match.index
  }
  return text
}

export function buildTestEvidence(testSource: string): TestEvidence {
  const blocks: TestBlock[] = []
  for (const block of splitTestBlocks(stripComments(testSource))) {
    if (!QUALIFYING_TEST_RE.test(block)) continue
    const text = stripNonEvidence(block)
    blocks.push({ text, words: new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) })
  }
  return { blocks }
}

function evidenceNames(evidence: TestEvidence, words: Iterable<string>): boolean {
  const list = [...words]
  if (list.length === 0) return false
  return evidence.blocks.some((block) => list.some((word) => block.words.has(word)))
}

/** Concatenated, comment-stripped text of sim test files outside `sim/ai/`. */
export function loadQualifyingTestSource(): string {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.test.ts') && entry.name !== 'moveInventory.test.ts') {
        const repoRelative = relative(REPO_ROOT, full)
        // AI scoring tests assert on scores, not on executing the move (item 2).
        if (repoRelative.startsWith('web/src/engine/sim/ai/')) continue
        const source = readFileSync(full, 'utf-8')
        if (QUALIFYING_TEST_RE.test(source)) parts.push(stripComments(source))
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

/** `#define NAME value` from battle_config.h, resolved through `GEN_*` aliases. */
function battleConfigResolver(): (token: string) => number | undefined {
  const raw = new Map<string, string>()
  for (const line of readFileSync(BATTLE_CONFIG_PATH, 'utf-8').split('\n')) {
    const withoutComment = line.replace(/\/\/.*$/, '')
    const match = withoutComment.match(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/)
    if (match) raw.set(match[1], match[2])
  }
  const resolved = new Map<string, number>()
  const resolve = (token: string, seen: Set<string> = new Set()): number | undefined => {
    const value = token.trim()
    if (/^-?\d+$/.test(value)) return Number(value)
    if (value === 'TRUE') return 1
    if (value === 'FALSE') return 0
    if (resolved.has(value)) return resolved.get(value)
    if (seen.has(value)) return undefined
    seen.add(value)
    const alias = raw.get(value)
    if (alias === undefined) return undefined
    const number = resolve(alias, seen)
    if (number !== undefined) resolved.set(value, number)
    return number
  }
  return resolve
}

/**
 * Evaluates a `.if`/`.else` script directive against the live battle_config.h values
 * (GEN_3..GEN_8, battle_config.h:7-12). Only the live branch contributes commands, so a
 * dead `.if` branch cannot make or hide a production path.
 */
export function evaluateScriptCondition(
  expression: string,
  resolve: (token: string) => number | undefined,
): boolean {
  const expr = expression.trim()
  if (!expr) return true
  const orParts = expr.split('||')
  if (orParts.length > 1) return orParts.some((part) => evaluateScriptCondition(part, resolve))
  const andParts = expr.split('&&')
  if (andParts.length > 1) return andParts.every((part) => evaluateScriptCondition(part, resolve))
  const comparison = expr.match(/^(.+?)\s*(>=|<=|==|!=|>|<)\s*(.+)$/)
  if (!comparison) {
    const value = resolve(expr)
    return value !== undefined && value !== 0
  }
  const left = resolve(comparison[1].trim())
  const right = resolve(comparison[3].trim())
  if (left === undefined || right === undefined) return false
  switch (comparison[2]) {
    case '>=':
      return left >= right
    case '<=':
      return left <= right
    case '==':
      return left === right
    case '!=':
      return left !== right
    case '>':
      return left > right
    default:
      return left < right
  }
}

/**
 * Every top-level label in both script files, with its linear command list up to the first
 * terminator. `.if`/`.else` directives are evaluated against battle_config.h (only the live
 * branch contributes), and `call` targets are expanded one level so their commands count.
 */
export function parseScripts(files: ScriptFile[] = loadScriptFiles()): Map<string, ScriptRecord> {
  const resolve = battleConfigResolver()
  const scripts = new Map<string, ScriptRecord>()
  for (const file of files) {
    for (let i = 0; i < file.lines.length; i++) {
      const match = file.lines[i].match(LABEL_RE)
      if (!match) continue
      const label = match[1]
      if (scripts.has(label)) continue
      const commands: string[] = []
      let truncated = false
      const stack: Array<{ parentActive: boolean; branchActive: boolean; seenElse: boolean }> = []
      const active = () => stack.every((frame) => frame.parentActive && frame.branchActive)
      for (let j = i + 1; j < file.lines.length; j++) {
        const trimmed = file.lines[j].trim()
        if (!trimmed || trimmed.startsWith('@')) continue
        const directive = trimmed.match(/^\.(if|elseif|else|endif)\b(.*)$/)
        if (directive) {
          if (directive[1] === 'if') {
            stack.push({
              parentActive: active(),
              branchActive: evaluateScriptCondition(directive[2], resolve),
              seenElse: false,
            })
          } else if (directive[1] === 'else') {
            const frame = stack[stack.length - 1]
            if (frame && !frame.seenElse) {
              frame.branchActive = !frame.branchActive
              frame.seenElse = true
            }
          } else if (directive[1] === 'endif') {
            stack.pop()
          }
          continue
        }
        if (!active()) continue
        if (LABEL_RE.test(trimmed)) continue
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
  // Expand `call Target` one level so delegated commands (including damage steps) follow.
  for (const record of scripts.values()) {
    const expanded: string[] = []
    for (const command of record.commands) {
      const call = command.match(/^call\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/)
      const target = call ? scripts.get(call[1]) : undefined
      if (target && target.label !== record.label) expanded.push(...target.commands)
      else expanded.push(command)
    }
    record.commands = expanded
    if (record.commands.length > 60) record.truncated = true
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
  (entry: AuditAllowance) => ({
    kind: 'move-effect' as const,
    unit: entry.effect,
    citation: entry.citation,
    notes: entry.notes,
  }),
)

/**
 * Allowlist lookup. `AUDIT_ALLOWLIST` scopes entries that carry `notes` to exactly those
 * audit notes; an effect-wide entry (no `notes`) covers the whole unit. This inventory has
 * no per-note unit, so a note-scoped entry only allows a pair when the unit's notes are
 * among the listed ones -- which is never true for the whole unit. That is deliberate:
 * `EFFECT_DO_NOTHING`'s single-note allowance cannot hide the effect itself.
 */
function allowlistFor(
  kind: MoveUnitKind,
  unit: string,
  allowlist: ReadonlyArray<InventoryAllowlistEntry>,
  notes: readonly string[] = [],
): InventoryAllowlistEntry | undefined {
  return allowlist.find(
    (entry) =>
      entry.kind === kind &&
      entry.unit === unit &&
      (entry.notes === undefined || entry.notes.some((note) => notes.includes(note))),
  )
}

interface ClassifyContext {
  allowlist: ReadonlyArray<InventoryAllowlistEntry>
  productionSource: string
  /** Consuming-position identifiers and dispatch registries from the engine files. */
  consumption: ConsumptionIndex
  evidence: TestEvidence
  /** move effect -> distinct move ids carrying it (test evidence by move id). */
  effectMoveIds: Map<string, Set<string>>
  /** secondary MOVE_EFFECT_* -> distinct move ids carrying it. */
  secondaryMoveIds: Map<string, Set<string>>
  /** MOVE_EFFECT_* delivered through `move.argument.effect` (generic argument dispatch). */
  argumentEffects: Set<string>
  /** legacy script label -> distinct move ids carrying it. */
  scriptMoveIds: Map<string, Set<string>>
  scripts: Map<string, ScriptRecord>
}

function addToIndex(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(value)
}

function behaviorSecondaries(move: MoveRecord, behavior: BehaviorRecord): string[] {
  const secondaries = new Set<string>()
  for (const item of behavior.attack?.secondaryEffects ?? []) {
    if (item.effect) secondaries.add(item.effect)
  }
  if (move.argument?.kind === 'effect' && move.argument.effect) secondaries.add(move.argument.effect)
  return [...secondaries]
}

function buildUnitMoveIds(
  moves: MoveRecord[],
  behaviors: MoveBehaviors,
): {
  effectMoveIds: Map<string, Set<string>>
  secondaryMoveIds: Map<string, Set<string>>
  argumentEffects: Set<string>
  scriptMoveIds: Map<string, Set<string>>
} {
  const effectMoveIds = new Map<string, Set<string>>()
  const secondaryMoveIds = new Map<string, Set<string>>()
  const argumentEffects = new Set<string>()
  const scriptMoveIds = new Map<string, Set<string>>()
  for (const move of moves) {
    const behavior = behaviorInForce(move, behaviors)
    if (move.effect) addToIndex(effectMoveIds, move.effect, move.id)
    for (const name of behaviorSecondaries(move, behavior)) addToIndex(secondaryMoveIds, name, move.id)
    if (move.argument?.kind === 'effect' && move.argument.effect) {
      addToIndex(secondaryMoveIds, move.argument.effect, move.id)
      argumentEffects.add(move.argument.effect)
    }
    if (behavior.legacyConfig) addToIndex(scriptMoveIds, behavior.legacyConfig, move.id)
  }
  return { effectMoveIds, secondaryMoveIds, argumentEffects, scriptMoveIds }
}

/**
 * Production path for a move effect. Every branch is a dispatch or a read that changes
 * behaviour:
 *  - a `HANDLERS` entry whose body does real work (a note-only or empty body is not a port),
 *  - a `CUSTOM_MOVE_DAMAGE` Record key (basePower.ts:107-151),
 *  - a declarative behaviour field read by generic pipeline code,
 *  - a `case`/`===`/`!==` comparison outside the predicate/list/routing functions.
 */
function effectHasProductionPath(effect: string, ctx: ClassifyContext): boolean {
  return (
    ctx.consumption.handledEffects.has(effect) ||
    ctx.consumption.customDamageEffects.has(effect) ||
    ctx.consumption.declarativeEffects.has(effect) ||
    ctx.consumption.moveEffects.has(effect)
  )
}

/** A test block that runs a move and names the effect, or a move carrying it, is evidence. */
function effectHasTestEvidence(effect: string, ctx: ClassifyContext): boolean {
  if (VERIFIED_MOVE_EFFECTS.has(effect)) return true
  return evidenceNames(ctx.evidence, [effect, ...(ctx.effectMoveIds.get(effect) ?? [])])
}

function classifyEffect(effect: string, ctx: ClassifyContext): { status: MoveUnitStatus; registeredUntested: boolean } {
  const allow = allowlistFor('move-effect', effect, ctx.allowlist)
  if (allow) return { status: 'allowlisted', registeredUntested: false }
  // A `HANDLERS` entry is the effect's implementation: the body must do real work. A
  // note-only or empty body is not rescued by a routing comparison or a generic field.
  if (ctx.consumption.handlerEffects.has(effect)) {
    const production = ctx.consumption.handledEffects.has(effect)
    const tested = effectHasTestEvidence(effect, ctx)
    if (production && tested) return { status: 'ported', registeredUntested: false }
    if (production) return { status: 'unported', registeredUntested: true }
    return { status: 'unported', registeredUntested: false }
  }
  // A declarative behaviour field that production reads is a port on its own: the field is
  // the implementation, and the generic pipeline that reads it is covered by the suite.
  if (ctx.consumption.declarativeEffects.has(effect)) return { status: 'ported', registeredUntested: false }
  const production = effectHasProductionPath(effect, ctx)
  const tested = effectHasTestEvidence(effect, ctx)
  if (production && tested) return { status: 'ported', registeredUntested: false }
  if (production) return { status: 'unported', registeredUntested: true }
  return { status: 'unported', registeredUntested: false }
}

function classifySecondary(name: string, ctx: ClassifyContext): { status: MoveUnitStatus; registeredUntested: boolean } {
  const allow = allowlistFor('secondary-effect', name, ctx.allowlist)
  if (allow) return { status: 'allowlisted', registeredUntested: false }
  // A dispatch site is necessary. Registry membership proves the number is known; a name
  // with an explicit case (`MOVE_EFFECT_ENRAGE`, called directly by handleThirdType's
  // argument path) is a port without a map entry. A registered name with no case stays
  // unported (D4).
  const production =
    secondaryHasProductionPath(name) || ctx.consumption.secondaryEffects.has(name)
  const dispatched = production && secondaryIsConsumed(name, ctx.consumption)
  // Argument-driven secondaries are declarative: the move's `argument.effect` is dispatched
  // generically, so the argument path (not the unit name) is what tests exercise.
  const tested =
    ctx.argumentEffects.has(name) ||
    evidenceNames(ctx.evidence, [name, ...(ctx.secondaryMoveIds.get(name) ?? [])])
  if (dispatched && tested) return { status: 'ported', registeredUntested: false }
  if (dispatched) return { status: 'unported', registeredUntested: true }
  return { status: 'unported', registeredUntested: false }
}

/**
 * Flag test evidence: a qualifying block that sets the flag on a move-flags object
 * (`flags: { <key>: true }` / `moveFlags: { ... }`). A module-scope data sentinel or an
 * AI-scoring test is not a qualifying block (cycle151b item 5).
 */
function flagHasBlockEvidence(key: string, evidence: TestEvidence): boolean {
  return evidence.blocks.some(
    (block) =>
      /(?:move)?[fF]lags\s*:\s*\{/.test(block.text) && flagHasTestEvidence(key, block.text),
  )
}

function classifyFlag(key: string, ctx: ClassifyContext): { status: MoveUnitStatus; registeredUntested: boolean } {
  const allow = allowlistFor('flag', key, ctx.allowlist)
  if (allow) return { status: 'allowlisted', registeredUntested: false }
  const production = flagHasProductionRead(key, ctx.productionSource)
  const tested = flagHasBlockEvidence(key, ctx.evidence)
  if (production && tested) return { status: 'ported', registeredUntested: false }
  if (production) return { status: 'unported', registeredUntested: true }
  return { status: 'unported', registeredUntested: false }
}

/**
 * Legacy-script production path, independent of the owning move effect: a `case` label in
 * `runLegacyPreHit` / `runLegacyPostHit`, or a `setmoveeffect` the script issues whose
 * `MOVE_EFFECT_*` is consumed by item 1's secondary dispatch. A script with neither stays
 * unported even when its move effect is ported.
 */
function legacyScriptHasConsumedSecondary(label: string, ctx: ClassifyContext): boolean {
  const record = ctx.scripts.get(label)
  if (!record) return false
  for (const command of record.commands) {
    const match = command.match(/^setmoveeffect\s+(.+)$/)
    if (!match) continue
    for (const name of match[1].match(/MOVE_EFFECT_[A-Z0-9_]+/g) ?? []) {
      if (secondaryIsConsumed(name, ctx.consumption)) return true
    }
  }
  return false
}

function legacyScriptHasProductionPath(
  label: string,
  owningEffect: string | null,
  ctx: ClassifyContext,
): boolean {
  // `runLegacyPreHit`/`runLegacyPostHit` dispatch on the move effect, not on the label.
  if (owningEffect && (ctx.consumption.preHitEffects.has(owningEffect) || ctx.consumption.postHitEffects.has(owningEffect))) {
    return true
  }
  return legacyScriptHasConsumedSecondary(label, ctx)
}

function classifyLegacyScript(
  label: string,
  owningEffect: string | null,
  ctx: ClassifyContext,
): { status: MoveUnitStatus; registeredUntested: boolean } {
  // A script may be allowlisted directly, or inherit an effect-wide move-effect allowance.
  const allow =
    allowlistFor('legacy-script', label, ctx.allowlist) ??
    (owningEffect ? allowlistFor('move-effect', owningEffect, ctx.allowlist) : undefined)
  if (allow) return { status: 'allowlisted', registeredUntested: false }
  const production = legacyScriptHasProductionPath(label, owningEffect, ctx)
  const tested = evidenceNames(ctx.evidence, [label, ...(ctx.scriptMoveIds.get(label) ?? [])])
  if (production && tested) return { status: 'ported', registeredUntested: false }
  if (production) return { status: 'unported', registeredUntested: true }
  return { status: 'unported', registeredUntested: false }
}

/**
 * A move whose `effect` is null has no `EFFECT_*` unit. It is ported when the damage path
 * reads `.effect` for effect-null moves (damageResolver.ts:223) and a qualifying test names
 * the move id. 143 moves are in this position; every move id still appears in `result.units`.
 */
function classifyEffectLess(moveId: string, ctx: ClassifyContext): { status: MoveUnitStatus; registeredUntested: boolean } {
  const production = ctx.consumption.effectLessProduction
  const tested = evidenceNames(ctx.evidence, [moveId])
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
  const consumption = buildConsumptionIndex(consumerSource, moves, behaviors)
  const testSource = options.testSource ?? loadQualifyingTestSource()
  const evidence = buildTestEvidence(testSource)
  const scripts = options.scripts ?? parseScripts()
  const effectProtoLines = loadMoveEffectProtoLines()
  const flagMetadata = loadFlagMetadata()
  const { effectMoveIds, secondaryMoveIds, argumentEffects, scriptMoveIds } = buildUnitMoveIds(moves, behaviors)

  const ctx: ClassifyContext = {
    allowlist,
    productionSource,
    consumption,
    evidence,
    effectMoveIds,
    secondaryMoveIds,
    argumentEffects,
    scriptMoveIds,
    scripts,
  }

  const effectStatus = new Map<string, MoveUnitStatus>()
  const effectRegisteredUntested = new Map<string, boolean>()
  const effectCitations = new Map<string, string>()
  for (const move of moves) {
    if (move.effect == null || effectStatus.has(move.effect)) continue
    const classified = classifyEffect(move.effect, ctx)
    effectStatus.set(move.effect, classified.status)
    effectRegisteredUntested.set(move.effect, classified.registeredUntested)
    const script = behaviorInForce(move, behaviors).legacyConfig
    const record = script ? scripts.get(script) : undefined
    effectCitations.set(move.effect, record ? `${record.file}:${record.line}` : '')
  }

  // Per-unit caches: classification is a function of the unit, not of the move.
  const secondaryStatus = new Map<string, { status: MoveUnitStatus; registeredUntested: boolean }>()
  const flagStatus = new Map<string, { status: MoveUnitStatus; registeredUntested: boolean }>()

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
    } else {
      const classified = classifyEffectLess(move.id, ctx)
      units.push({
        kind: 'effect-less',
        moveId: move.id,
        unit: '<effect-less>',
        status: classified.status,
        registeredUntested: classified.registeredUntested,
        citation: '',
      })
    }

    const secondaries = new Set<string>()
    for (const item of behavior.attack?.secondaryEffects ?? []) {
      if (item.effect) secondaries.add(item.effect)
    }
    if (move.argument?.kind === 'effect' && move.argument.effect) secondaries.add(move.argument.effect)
    for (const name of [...secondaries].sort()) {
      let classified = secondaryStatus.get(name)
      if (!classified) {
        classified = classifySecondary(name, ctx)
        secondaryStatus.set(name, classified)
      }
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
      let classified = flagStatus.get(key)
      if (!classified) {
        classified = classifyFlag(key, ctx)
        flagStatus.set(key, classified)
      }
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
      const classified = classifyLegacyScript(behavior.legacyConfig, move.effect ?? null, ctx)
      const allowance =
        allowlistFor('legacy-script', behavior.legacyConfig, allowlist) ??
        (move.effect ? allowlistFor('move-effect', move.effect, allowlist) : undefined)
      units.push({
        kind: 'legacy-script',
        moveId: move.id,
        unit: behavior.legacyConfig,
        status: classified.status,
        registeredUntested: classified.registeredUntested,
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

  const summaries: MoveUnitKindSummary[] = (
    ['move-effect', 'secondary-effect', 'flag', 'legacy-script', 'effect-less'] as MoveUnitKind[]
  ).map((kind) => {
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
  })

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

  const kindOrder: MoveUnitKind[] = ['move-effect', 'secondary-effect', 'flag', 'legacy-script', 'effect-less']
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
  lines.push('as unported. A pair is **unclassified** when the unit id is missing/empty. Allowlisted pairs cite upstream C;')
  lines.push('an `AUDIT_ALLOWLIST` entry that carries `notes` covers only those audit notes, so it cannot hide a unit.')
  lines.push('')
  lines.push('Test evidence is a test **block**, not a text occurrence: the unit must be named inside the same')
  lines.push('`it(...)`/`test(...)` call as a sim entry point (`createSession`/`executeTurn`/`stepTurn`/`useMove`/')
  lines.push('`buildMoveAction`/`calculateMoveDamage`), with comments stripped. Mentioning the unit in a comment, in a')
  lines.push('`web/src/engine/sim/ai/` scoring test, in a module-scope data sentinel (`if (...) throw`) or in a')
  lines.push('`.not.toContain(\'... not modelled\')` assertion is not evidence.')
  lines.push('')
  lines.push(
    '1. **move-effect**: the move\'s `effect` (`EFFECT_*`). Production = any of:',
  )
  lines.push(
    '   - a `HANDLERS` entry whose function body does real work (a body that only pushes to `unmodelled` or is',
  )
  lines.push('     empty is **not** a port),',
  )
  lines.push('   - a `CUSTOM_MOVE_DAMAGE` Record key in `basePower.ts`,')
  lines.push(
    '   - a declarative behaviour field read by generic code: `attack.secondaryEffects`, `attack.damage`',
  )
  lines.push(
    '     (`conditions`/`modifier`), `attack.recoilFraction`, `attack.superEffectiveVs`,',
  )
  lines.push(
    '     `attack.ignoreTypeImmunity`, `options`, `causesFlinch` (a field production never reads stays unported),',
  )
  lines.push(
    '   - a `case \'EFFECT_X\':` / `=== \'EFFECT_X\'` / `!== \'EFFECT_X\'` comparison in the restricted engine files',
  )
  lines.push(
    '     `basePower.ts`, `multiHit.ts`, `calculate.ts` and `sim/{hitScripts,damageResolver,attackCanceller,',
  )
  lines.push(
    '     accuracy,moveTargetFlags,moveEnd,turn,turnOrder,moveEffects,statusEffects}.ts` -- **except** the predicate/',
  )
  lines.push(
    '     list functions `isHealingMoveEffect`, `isPreventableSecondaryEffect`, `isTwoTurnsMoveEffect`,',
  )
  lines.push(
    '     `isTwoTurnsMove`, and the plain-hit routing allowlist in `applySecondaryMoveEffects`; those classify or route',
  )
  lines.push(
    '     and are not dispatch sites. A `&& false` / `if (false)` branch is dead and does not count either.',
  )
  lines.push(
    '   Test evidence = membership in `VERIFIED_MOVE_EFFECTS`, or a qualifying block naming the effect or a move id',
  )
  lines.push('   carrying it.')
  lines.push(
    '2. **secondary-effect**: every `MOVE_EFFECT_*` in the behavior in force',
  )
  lines.push(
    '   (`customBehavior ?? moveBehaviors[effect]`) plus `move.argument.effect`. Production = consumption at a',
  )
  lines.push(
    '   dispatch site: a `case` label or `===`/`!==` comparison inside `applySecondaryMoveEffects`,',
  )
  lines.push(
    '   `applyPrimaryStatusEffect`, or `runMoveEnd`\'s `switch (ctx.moveEffect2)`, or an inclusive',
  )
  lines.push(
    '   `baseEffectNum >= A ... <= B` stat-change guard in `applySecondaryMoveEffects`. The number must also be',
  )
  lines.push(
    '   known (`SECONDARY_MOVE_EFFECT_MAP` / `GENERATED_MOVE_EFFECT_NUMBERS` / `MOVE_EFFECTS_STORED_FOR_MOVEEND`),',
  )
  lines.push(
    '   unless the case is explicit and reached directly (`MOVE_EFFECT_ENRAGE`, applied by `handleThirdType`).',
  )
  lines.push('   A registered name whose number has no case stays unported.')
  lines.push(
    '3. **flag**: every true key in `move.flags`. Production = a move-flag read in the sim move pipeline',
  )
  lines.push(
    '   (`flags.<key>`, `moveFlags.<key>`, `hasMoveFlag(..., \'<key>\')`, `flag === \'<key>\'`); `sim/ai/` and ability',
  )
  lines.push(
    '   files do not count. Test evidence = the setting (`\\b<key>: true|false`, `flags.<key>`,',
  )
  lines.push(
    '   `hasMoveFlag(..., \'<key>\')`) in a qualifying block that sets a `flags: { ... }` /',
  )
  lines.push(
    '   `moveFlags: { ... }` literal; a flag set in a module-scope fixture is not evidence.',
  ),
  lines.push(
    '4. **legacy-script**: the behavior in force\'s `legacyConfig` from `data/battle_scripts_1.s`/`_2.s`, mapped',
  )
  lines.push(
    '   **independently** of its owning move effect: production = the label is a `case` in `runLegacyPreHit` or',
  )
  lines.push(
    '   `runLegacyPostHit`, or the script issues a `setmoveeffect MOVE_EFFECT_*` that secondary consumption handles.',
  )
  lines.push(
    '   A script with neither is unported even when its move effect is ported. Test evidence = a qualifying block',
  )
  lines.push('   naming the label or a move carrying it. Scripts are parsed with `.if`/`.else` evaluated against'),
  lines.push('   `battle_config.h` (only the live branch contributes) and `call` targets expanded one level.'),
  lines.push(
    '5. **effect-less**: a move whose `effect` is null has no `EFFECT_*` unit. Production = the damage path reading',
  )
  lines.push(
    '   `.effect` for effect-null moves (`sim/damageResolver.ts`); test evidence = a qualifying block naming the move',
  )
  lines.push('   id. Every move id appears in `result.units`.')
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
  pushGroupSection('Unported Effect-Less Moves', 'effect-less')

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
