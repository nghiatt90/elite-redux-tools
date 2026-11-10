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
  /** Non-skeleton script commands still unported, with their `Cmd_` line (0 = no Cmd_). */
  unhandledScriptCommands: UnhandledScriptCommand[]
  flagCitations: Map<string, string>
  citedLocations: string[]
}

export interface UnhandledScriptCommand {
  command: string
  opcode: string
  /** `battle_script_commands.c` line of `Cmd_<opcode>`, or 0 when the source has none. */
  cLine: number
  /** Distinct scripts blocked by it (labels). */
  scripts: string[]
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
/** A call (not just a name) of one of the sim entry points. */
const ENTRY_POINT_CALL_RE = /\b(?:createSession|executeTurn|stepTurn|useMove|buildMoveAction|calculateMoveDamage)\s*\(/
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
  // The applySecondaryMoveEffects plain-hit routing chain is NOT removed here: cycle 151b's
  // rework reads it as a production site (a plain hit routed to the damage path). The
  // consumption index strips it before extracting `case`/`===` names, so a routing mention
  // still does not make an effect a handler port on its own.
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
  /** Plain-hit effects the routing chain sends to the shared damage path (no secondary step). */
  plainHitEffects: Set<string>
  /** Non-skeleton script opcodes whose opcode-specific production site is present. */
  handledOpcodes: Set<string>
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
  scripts: Map<string, ScriptRecord> = new Map(),
  /**
   * Comment-stripped source the `SCRIPT_OPCODE_HANDLERS` probes run against. Defaults to the
   * whole engine production tree; synthetic callers pass their own text so a deleted
   * production site can be mutation-tested.
   */
  handlerSource: string = loadProductionSource(),
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

  const index: ConsumptionIndex = {
    moveEffects,
    secondaryEffects,
    secondaryRanges,
    handledEffects: handledMoveEffects(live),
    handlerEffects: new Set(extractRecordEntries(live, HANDLERS_DECL).keys()),
    customDamageEffects: customDamageEffects(live),
    declarativeEffects: declarativeEffectsFor(live, moves, behaviors),
    preHitEffects: extractCaseLabels(preHit, 'EFFECT_'),
    postHitEffects: extractCaseLabels(postHit, 'EFFECT_'),
    plainHitEffects: new Set(),
    handledOpcodes: handledScriptOpcodes(handlerSource),
    effectLessProduction: /\.effect\s*(?:===|!==)\s*null/.test(live),
  }
  // Read from the un-stripped source: `live` deliberately removes the plain-hit routing
  // chain so its entries are not mistaken for `case`/`===` handler sites.
  index.plainHitEffects = plainHitEffectsFor(source, moves, behaviors, scripts, index)
  return index
}

function secondaryIsConsumed(name: string, index: ConsumptionIndex): boolean {
  if (index.secondaryEffects.has(name)) return true
  const value = resolveMoveEffectNumber(name)
  if (value === undefined) return false
  return index.secondaryRanges.some(([low, high]) => value >= low && value <= high)
}

// ---------------------------------------------------------------------------
// Script opcode handlers (cycle 151b rework 2, defect A)
// ---------------------------------------------------------------------------
//
// A non-skeleton script command is handled only at an opcode-specific site. The owning
// effect having some production path (`HANDLERS`, `CUSTOM_MOVE_DAMAGE`, a declarative
// field, the plain-hit chain) is not that: it says nothing about whether the engine
// executes `setsprite` or `playanimation`.
//
// Each entry below names:
//   - `opcode`: the script command's first token;
//   - `cSite`: the `Cmd_<opcode>` / `VARIOUS_<opcode>` handler in
//     `battle_script_commands.c` (the upstream definition of the opcode's behaviour);
//   - `simSite`: the production file:line in `web/src/engine/sim/` that implements it;
//   - `probes`: regexes that must ALL match the comment-stripped consumer source. They are
//     the code itself, not the opcode name, so deleting the implementation makes the
//     opcode unhandled again (mutation-tested in cycle151bInventory.test.ts).
export interface ScriptOpcodeHandler {
  opcode: string
  cSite: string
  simSite: string
  probes: RegExp[]
}

export const SCRIPT_OPCODE_HANDLERS: ReadonlyArray<ScriptOpcodeHandler> = [
  // Stat stages.
  {
    opcode: 'statbuffchange',
    cSite: 'battle_script_commands.c:258',
    simSite: 'web/src/engine/sim/statBuffs.ts:589',
    probes: [/export function changeStatBuffs\(/],
  },
  {
    opcode: 'setstatchanger',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/statBuffs.ts:742',
    probes: [/export function changeStatBuffsImplicit\(/],
  },
  {
    opcode: 'averagestats',
    cSite: 'battle_script_commands.c:372',
    simSite: 'web/src/engine/sim/moveEffects.ts:5492',
    probes: [/function handlePowerSplit\(/, /function handleGuardSplit\(/],
  },
  {
    opcode: 'swapstatstages',
    cSite: 'battle_script_commands.c:371',
    simSite: 'web/src/engine/sim/moveEffects.ts:5320',
    probes: [/function handlePowerSwap\(/, /function handleGuardSwap\(/, /function handleHeartSwap\(/],
  },
  {
    opcode: 'swapstat',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:5414',
    probes: [/function handleSpeedSwap\(/],
  },
  {
    opcode: 'invertstatstages',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:5554',
    probes: [/function handleTopsyTurvy\(/],
  },
  {
    opcode: 'normalisebuffs',
    cSite: 'battle_script_commands.c:259',
    simSite: 'web/src/engine/sim/moveEffects.ts:3517',
    probes: [/function handleHaze\(/],
  },
  {
    opcode: 'powertrick',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:8204',
    probes: [/export function handlePowerTrick\(/],
  },
  {
    opcode: 'raisehighestattackingstat',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:3183',
    probes: [/getHighestAttackingStatId\(state, bId, statStageRatios\)/],
  },
  {
    opcode: 'cutonethirdhpraisestats',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:5670',
    probes: [/const hpFraction = Math\.max\(1, Math\.trunc\(battler\.mon\.maxHp \/ 3\)\)/],
  },
  {
    opcode: 'maxattackhalvehp',
    cSite: 'battle_script_commands.c:309',
    simSite: 'web/src/engine/sim/moveEffects.ts:1693',
    probes: [/const halfHp = Math\.max\(1, Math\.floor\(battler\.mon\.maxHp \/ 2\)\)/],
  },
  {
    opcode: 'increasecrit',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:1464',
    probes: [/battler\.volatiles\.critBoost \+= increase/],
  },

  // Status and volatile setters.
  {
    opcode: 'setdefensecurlbit',
    cSite: 'battle_script_commands.c:312',
    simSite: 'web/src/engine/sim/moveEffects.ts:972',
    probes: [/setFlag\(battler\.mon\.status2, STATUS2_DEFENSE_CURL\)/],
  },
  {
    opcode: 'setminimize',
    cSite: 'battle_script_commands.c:320',
    simSite: 'web/src/engine/sim/moveEffects.ts:4751',
    probes: [/setFlag\(battler\.statuses3, STATUS3_MINIMIZED\)/],
  },
  {
    opcode: 'setcharge',
    cSite: 'battle_script_commands.c:324',
    simSite: 'web/src/engine/sim/moveEffects.ts:4415',
    probes: [/setFlag\(battler\.statuses3, STATUS3_CHARGED_UP\)/],
  },
  {
    opcode: 'setbide',
    cSite: 'battle_script_commands.c:260',
    simSite: 'web/src/engine/sim/turn.ts:2827',
    probes: [/STATUS2_BIDE_TURN\(2\)/],
  },
  {
    opcode: 'setdestinybond',
    cSite: 'battle_script_commands.c:291',
    simSite: 'web/src/engine/sim/moveEffects.ts:3892',
    probes: [/setFlag\(battler\.mon\.status2, STATUS2_DESTINY_BOND\)/],
  },
  {
    opcode: 'setseeded',
    cSite: 'battle_script_commands.c:248',
    simSite: 'web/src/engine/sim/moveEffects.ts:12742',
    probes: [/STATUS3_LEECHSEED \| \(attackerId & STATUS3_LEECHSEED_BATTLER\)/],
  },
  {
    opcode: 'setforesight',
    cSite: 'battle_script_commands.c:298',
    simSite: 'web/src/engine/sim/battleEvents.ts:504',
    probes: [/target\.statuses4 = setFlag\(target\.statuses4, STATUS4_FORESIGHT\)/],
  },
  {
    opcode: 'setmiracleeye',
    cSite: 'battle_script_commands.c:252',
    simSite: 'web/src/engine/sim/moveEffects.ts:4630',
    probes: [/setFlag\(target\.statuses3, STATUS3_MIRACLE_EYED\)/],
  },
  {
    opcode: 'setgastroacid',
    cSite: 'battle_script_commands.c:335',
    simSite: 'web/src/engine/sim/moveEffects.ts:7653',
    probes: [/setFlag\(target\.statuses3, STATUS3_GASTRO_ACID\)/],
  },
  {
    opcode: 'setyawn',
    cSite: 'battle_script_commands.c:336',
    simSite: 'web/src/engine/sim/moveEffects.ts:2136',
    probes: [/setCounter\(target\.statuses3, STATUS3_YAWN, 2\)/],
  },
  {
    opcode: 'settelekinesis',
    cSite: 'battle_script_commands.c:370',
    simSite: 'web/src/engine/sim/moveEffects.ts:8122',
    probes: [/target\.volatiles\.telekinesisTimer = 3/],
  },
  {
    opcode: 'sethealblock',
    cSite: 'battle_script_commands.c:195',
    simSite: 'web/src/engine/sim/moveEffects.ts:4233',
    probes: [/target\.volatiles\.healBlockTimer = 5/],
  },
  {
    opcode: 'setembargo',
    cSite: 'battle_script_commands.c:303',
    simSite: 'web/src/engine/sim/moveEffects.ts:4262',
    probes: [/target\.volatiles\.embargoTimer = 5/],
  },
  {
    opcode: 'settaunt',
    cSite: 'battle_script_commands.c:329',
    simSite: 'web/src/engine/sim/moveEffects.ts:4062',
    probes: [/target\.volatiles\.tauntTimer = turns/],
  },
  {
    opcode: 'settorment',
    cSite: 'battle_script_commands.c:327',
    simSite: 'web/src/engine/sim/moveEffects.ts:4200',
    probes: [/setFlag\(target\.mon\.status2, STATUS2_TORMENT\)/],
  },
  {
    opcode: 'setoctolock',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:12094',
    probes: [/targetBattler\.volatiles\.octolock = true/],
  },
  {
    opcode: 'setpowder',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:8280',
    probes: [/setFlag\(target\.mon\.status2, STATUS2_POWDER\)/],
  },
  {
    opcode: 'setwaterlogged',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:10005',
    probes: [/target\.round\.waterlog = true/],
  },
  {
    opcode: 'setuserstatus3',
    cSite: 'battle_script_commands.c:342',
    simSite: 'web/src/engine/sim/moveEffects.ts:4491',
    probes: [/setFlag\(battler\.statuses3, STATUS3_LASER_FOCUS\)/],
  },
  {
    opcode: 'setroost',
    cSite: 'battle_script_commands.c:187',
    simSite: 'web/src/engine/sim/moveEffects.ts:2549',
    probes: [/battler\.roostTypes = \['FLYING', 'FLYING'\]/],
  },

  // Move-slot and move-lock state.
  {
    opcode: 'disablelastusedattack',
    cSite: 'battle_script_commands.c:284',
    simSite: 'web/src/engine/sim/moveEffects.ts:4107',
    probes: [/target\.volatiles\.disabledMove = lastMove/],
  },
  {
    opcode: 'trysetencore',
    cSite: 'battle_script_commands.c:285',
    simSite: 'web/src/engine/sim/moveEffects.ts:4160',
    probes: [/target\.volatiles\.encoredMove = lastMove/],
  },
  {
    opcode: 'trysetperishsong',
    cSite: 'battle_script_commands.c:299',
    simSite: 'web/src/engine/sim/moveEffects.ts:4667',
    probes: [/b\.volatiles\.perishSongTimer = 3/],
  },
  {
    opcode: 'trysetfairylock',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:7524',
    probes: [/state\.field\.statuses \|= STATUS_FIELD_FAIRY_LOCK/],
  },
  {
    opcode: 'trysetfutureattack',
    cSite: 'battle_script_commands.c:316',
    simSite: 'web/src/engine/sim/moveEffects.ts:4731',
    probes: [/state\.field\.futureSightMove\[targetId\] = currentMove\.id/],
  },
  {
    opcode: 'trysetrest',
    cSite: 'battle_script_commands.c:250',
    simSite: 'web/src/engine/sim/moveEffects.ts:5000',
    probes: [/function handleRest\(/],
  },
  {
    opcode: 'trysetmagiccoat',
    cSite: 'battle_script_commands.c:344',
    simSite: 'web/src/engine/sim/moveEffects.ts:10188',
    probes: [/export function handleMagicCoat\(/],
  },
  {
    opcode: 'trysetsnatch',
    cSite: 'battle_script_commands.c:345',
    simSite: 'web/src/engine/sim/moveEffects.ts:10157',
    probes: [/export function handleSnatch\(/],
  },
  {
    opcode: 'tryimprison',
    cSite: 'battle_script_commands.c:340',
    simSite: 'web/src/engine/sim/moveEffects.ts:8055',
    probes: [/setFlag\(battler\.statuses3, STATUS3_IMPRISONED_OTHERS\)/],
  },
  {
    opcode: 'tryelectrify',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:8143',
    probes: [/export function handleElectrify\(/],
  },
  {
    opcode: 'trytarshot',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:6057',
    probes: [/target\.volatiles\.tarShot = true/],
  },
  {
    opcode: 'cantarshotwork',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:6028',
    probes: [/target\.volatiles\.tarShot \|\| speedStage >= MAX_STAT_STAGE/],
  },
  {
    opcode: 'trynoretreat',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:5764',
    probes: [/function handleNoRetreat\(/],
  },
  {
    opcode: 'stockpile',
    cSite: 'battle_script_commands.c:254',
    simSite: 'web/src/engine/sim/moveEffects.ts:5211',
    probes: [/battler\.volatiles\.stockpileCounter\+\+/],
  },

  // Damage calculation.
  {
    opcode: 'calculatesetdamage',
    cSite: 'battle_script_commands.c:280',
    simSite: 'web/src/engine/sim/turn.ts:2025',
    probes: [/case 'EFFECT_LEVEL_DAMAGE':/, /case 'EFFECT_SUPER_FANG':/],
  },
  {
    opcode: 'counterdamagecalculator',
    cSite: 'battle_script_commands.c:282',
    simSite: 'web/src/engine/sim/turn.ts:2011',
    probes: [/case 'EFFECT_COUNTER':/],
  },
  {
    opcode: 'mirrorcoatdamagecalculator',
    cSite: 'battle_script_commands.c:283',
    simSite: 'web/src/engine/sim/turn.ts:2014',
    probes: [/case 'EFFECT_MIRROR_COAT':/],
  },
  {
    opcode: 'metalburstdamagecalculator',
    cSite: 'battle_script_commands.c:376',
    simSite: 'web/src/engine/sim/turn.ts:2017',
    probes: [/case 'EFFECT_METAL_BURST':/],
  },
  {
    opcode: 'setdamagetohealthdifference',
    cSite: 'battle_script_commands.c:337',
    simSite: 'web/src/engine/sim/turn.ts:2020',
    probes: [/case 'EFFECT_ENDEAVOR':/],
  },
  {
    opcode: 'dmgtocurrattackerhp',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/turn.ts:2032',
    probes: [/case 'EFFECT_FINAL_GAMBIT':/],
  },
  {
    opcode: 'painsplitdmgcalc',
    cSite: 'battle_script_commands.c:286',
    simSite: 'web/src/engine/sim/moveEffects.ts:2734',
    probes: [/function handlePainSplit\(/],
  },
  {
    opcode: 'magnitudedamagecalculation',
    cSite: 'battle_script_commands.c:306',
    simSite: 'web/src/engine/sim/damageResolver.ts:55',
    probes: [/function magnitudeTier\(random: RandomSource\)/],
  },
  {
    opcode: 'handlerollout',
    cSite: 'battle_script_commands.c:300',
    simSite: 'web/src/engine/sim/turn.ts:3791',
    probes: [/if \(moveEffect === 'EFFECT_ROLLOUT'\)/],
  },
  {
    opcode: 'suckerpunchcheck',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/turn.ts:3284',
    probes: [/moveEffect === 'EFFECT_SUCKER_PUNCH'/],
  },
  {
    opcode: 'trypupperhand',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/turn.ts:3511',
    probes: [/moveEffect === 'EFFECT_UPPER_HAND'/],
  },
  {
    opcode: 'dmg_1_2_attackerhp',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:3814',
    probes: [/const hpCost = Math\.max\(1, Math\.floor\(battler\.mon\.maxHp \/ 2\)\)/],
  },
  {
    opcode: 'setatkhptozero',
    cSite: 'battle_script_commands.c:242',
    simSite: 'web/src/engine/sim/moveEffects.ts:6183',
    probes: [/const userHp = battler\.mon\.hp/],
  },
  {
    opcode: 'instanthpdrop',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:11084',
    probes: [/healingWish: true/],
  },
  {
    opcode: 'faintifabilitynotdamp',
    cSite: 'battle_script_commands.c:241',
    simSite: 'web/src/engine/sim/turn.ts:3315',
    probes: [/isAbilityOnField\(state, 'ABILITY_DAMP', deps\)/],
  },
  {
    opcode: 'confuseifrepeatingattackends',
    cSite: 'battle_script_commands.c:261',
    simSite: 'web/src/engine/sim/moveEffects.ts:11759',
    probes: [/STATUS2_LOCK_CONFUSE/],
  },

  // Copying moves, abilities, items and stats.
  {
    opcode: 'copyfoestats',
    cSite: 'battle_script_commands.c:310',
    simSite: 'web/src/engine/sim/moveEffects.ts:5288',
    probes: [/function handlePsychUp\(/],
  },
  {
    opcode: 'copymovepermanently',
    cSite: 'battle_script_commands.c:289',
    simSite: 'web/src/engine/sim/moveEffects.ts:6805',
    probes: [/export function handleSketch\(/],
  },
  {
    opcode: 'mimicattackcopy',
    cSite: 'battle_script_commands.c:278',
    simSite: 'web/src/engine/sim/moveEffects.ts:6682',
    probes: [/export function handleMimic\(/],
  },
  {
    opcode: 'metronome',
    cSite: 'battle_script_commands.c:279',
    simSite: 'web/src/engine/sim/moveEffects.ts:7078',
    probes: [/export function handleMetronome\(/],
  },
  {
    opcode: 'assistattackselect',
    cSite: 'battle_script_commands.c:343',
    simSite: 'web/src/engine/sim/moveEffects.ts:7157',
    probes: [/export function handleAssist\(/],
  },
  {
    opcode: 'trycopycat',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:6570',
    probes: [/export function handleCopycat\(/],
  },
  {
    opcode: 'trymirrormove',
    cSite: 'battle_script_commands.c:245',
    simSite: 'web/src/engine/sim/moveEffects.ts:6755',
    probes: [/export function handleMirrorMove\(/],
  },
  {
    opcode: 'tryinstruct',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:6632',
    probes: [/export function handleInstruct\(/],
  },
  {
    opcode: 'trymefirst',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:7317',
    probes: [/export function handleMeFirst\(/],
  },
  {
    opcode: 'tryafteryou',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:8819',
    probes: [/export function handleAfterYou\(/],
  },
  {
    opcode: 'tryquash',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:8859',
    probes: [/export function handleQuash\(/],
  },
  {
    opcode: 'tryaccupressure',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:5598',
    probes: [/function handleAcupressure\(/],
  },
  {
    opcode: 'tryswapitems',
    cSite: 'battle_script_commands.c:331',
    simSite: 'web/src/engine/sim/moveEffects.ts:10067',
    probes: [/export function handleTrick\(/],
  },
  {
    opcode: 'tryrecycleitem',
    cSite: 'battle_script_commands.c:355',
    simSite: 'web/src/engine/sim/moveEffects.ts:3970',
    probes: [/function handleRecycle\(/],
  },
  {
    opcode: 'trybestow',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:9549',
    probes: [/export function handleBestow\(/],
  },
  {
    opcode: 'consumeberry',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/statBuffs.ts:1107',
    probes: [/export function consumeHeldItem\(/],
  },
  {
    opcode: 'tryswapabilities',
    cSite: 'battle_script_commands.c:339',
    simSite: 'web/src/engine/sim/moveEffects.ts:7882',
    probes: [/export function handleSkillSwap\(/],
  },
  {
    opcode: 'trycopyability',
    cSite: 'battle_script_commands.c:332',
    simSite: 'web/src/engine/sim/moveEffects.ts:7833',
    probes: [/export function handleRolePlay\(/],
  },
  {
    opcode: 'trycopyabilitybetween',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:6875',
    probes: [/export function handleDoodle\(/],
  },
  {
    opcode: 'setabilitysimple',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:7681',
    probes: [/export function handleSimpleBeam\(/],
  },
  {
    opcode: 'tryentrainment',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:7785',
    probes: [/export function handleEntrainment\(/],
  },
  {
    opcode: 'tryworryseed',
    cSite: 'battle_script_commands.c:375',
    simSite: 'web/src/engine/sim/moveEffects.ts:7727',
    probes: [/export function handleWorrySeed\(/],
  },
  {
    opcode: 'switchinabilities',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/switchInAbility.ts:1359',
    probes: [/export function applySwitchInAbilities\(/],
  },
  {
    opcode: 'tryreflecttype',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:6403',
    probes: [/export function handleReflectType\(/],
  },
  {
    opcode: 'trysoak',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:6220',
    probes: [/export function handleSoak\(/],
  },
  {
    opcode: 'trysetthirdtype',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:6269',
    probes: [/export function handleThirdType\(/],
  },
  {
    opcode: 'tryconversiontypechange',
    cSite: 'battle_script_commands.c:265',
    simSite: 'web/src/engine/sim/moveEffects.ts:6314',
    probes: [/export function handleConversion\(/],
  },
  {
    opcode: 'settypetorandomresistance',
    cSite: 'battle_script_commands.c:287',
    simSite: 'web/src/engine/sim/moveEffects.ts:6454',
    probes: [/export function handleConversion2\(/],
  },
  {
    opcode: 'transformdataexecution',
    cSite: 'battle_script_commands.c:276',
    simSite: 'web/src/engine/sim/moveEffects.ts:7019',
    probes: [/export function handleTransform\(/],
  },
  {
    opcode: 'trydobeatup',
    cSite: 'battle_script_commands.c:317',
    simSite: 'web/src/engine/sim/damageResolver.ts:123',
    probes: [/let beatUpBaseAttack = attacker\.battler\.rawStats\.atk/],
  },

  // Healing and party status.
  {
    opcode: 'healpartystatus',
    cSite: 'battle_script_commands.c:295',
    simSite: 'web/src/engine/sim/moveEffects.ts:4787',
    probes: [/function handleHealBell\(/],
  },
  {
    opcode: 'tryhealhalfhealth',
    cSite: 'battle_script_commands.c:244',
    simSite: 'web/src/engine/sim/moveEffects.ts:2523',
    probes: [/function handleHealHalf\(/],
  },
  {
    opcode: 'tryhealpercenthealth',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:2701',
    probes: [/function handleJungleHealing\(/],
  },
  {
    opcode: 'recoverbasedonsunlight',
    cSite: 'battle_script_commands.c:313',
    simSite: 'web/src/engine/sim/moveEffects.ts:2658',
    probes: [/function handleWeatherRecovery\(/],
  },
  {
    opcode: 'tryhealpulse',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:5065',
    probes: [/function handleHealPulse\(/],
  },
  {
    opcode: 'trywish',
    cSite: 'battle_script_commands.c:333',
    simSite: 'web/src/engine/sim/moveEffects.ts:4683',
    probes: [/function handleWish\(/],
  },
  {
    opcode: 'tryrevivalblessing',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:11011',
    probes: [/export function handleRevivalBlessing\(/],
  },
  {
    opcode: 'trylosepercenthp',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:5710',
    probes: [/function handleFilletAway\(/],
  },
  {
    opcode: 'cureifburnedparalysedorpoisoned',
    cSite: 'battle_script_commands.c:326',
    simSite: 'web/src/engine/sim/moveEffects.ts:4841',
    probes: [/function handleRefresh\(/],
  },

  // Battle-script dispatch for effect slots.
  {
    opcode: 'seteffectprimary',
    cSite: 'battle_script_commands.c:143',
    simSite: 'web/src/engine/sim/statusEffects.ts:1546',
    probes: [/export function applyPrimaryStatusEffect\(/],
  },
  {
    opcode: 'seteffectsecondary',
    cSite: 'battle_script_commands.c:144',
    simSite: 'web/src/engine/sim/moveEffects.ts:11579',
    probes: [/export function applySecondaryMoveEffects\(/],
  },

  // Sides, field and weather.
  {
    opcode: 'setreflect',
    cSite: 'battle_script_commands.c:247',
    simSite: 'web/src/engine/sim/moveEffects.ts:2956',
    probes: [/sideState\.timers\.reflectTimer = isExtended \? 8 : 5/],
  },
  {
    opcode: 'setlightscreen',
    cSite: 'battle_script_commands.c:267',
    simSite: 'web/src/engine/sim/moveEffects.ts:2982',
    probes: [/sideState\.timers\.lightscreenTimer = isExtended \? 8 : 5/],
  },
  {
    opcode: 'setauroraveil',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:3018',
    probes: [/sideState\.timers\.auroraVeilTimer = isExtended \? 8 : 5/],
  },
  {
    opcode: 'setmist',
    cSite: 'battle_script_commands.c:274',
    simSite: 'web/src/engine/sim/moveEffects.ts:3086',
    probes: [/sideState\.timers\.mistTimer = 5/],
  },
  {
    opcode: 'setsafeguard',
    cSite: 'battle_script_commands.c:305',
    simSite: 'web/src/engine/sim/moveEffects.ts:3112',
    probes: [/sideState\.timers\.safeguardTimer = 5/],
  },
  {
    opcode: 'settailwind',
    cSite: 'battle_script_commands.c:293',
    simSite: 'web/src/engine/sim/moveEffects.ts:3137',
    probes: [/trySetTailwind\(state, side, battlerId, 3\)/],
  },
  {
    opcode: 'setstealthrock',
    cSite: 'battle_script_commands.c:341',
    simSite: 'web/src/engine/sim/moveEffects.ts:3204',
    probes: [/sideState\.timers\.stealthRockType = getMoveTypeNumber/],
  },
  {
    opcode: 'settoxicspikes',
    cSite: 'battle_script_commands.c:334',
    simSite: 'web/src/engine/sim/moveEffects.ts:3226',
    probes: [/sideState\.timers\.toxicSpikesAmount\+\+/],
  },
  {
    opcode: 'trysetspikes',
    cSite: 'battle_script_commands.c:297',
    simSite: 'web/src/engine/sim/moveEffects.ts:3180',
    probes: [/sideState\.timers\.spikesAmount\+\+/],
  },
  {
    opcode: 'setstickyweb',
    cSite: 'battle_script_commands.c:314',
    simSite: 'web/src/engine/sim/moveEffects.ts:12753',
    probes: [/trySetStickyWeb\(state, targetSide, 0, false\)/],
  },
  {
    opcode: 'trysetcaltrops',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:9669',
    probes: [/sideState\.timers\.caltrops = true/],
  },
  {
    opcode: 'setluckychant',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:7400',
    probes: [/timers\.luckyChantTimer = SCREEN_DURATION/],
  },
  {
    opcode: 'setquickguard',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:7410',
    probes: [/export function handleQuickGuard\(/],
  },
  {
    opcode: 'setprotectlike',
    cSite: 'battle_script_commands.c:240',
    simSite: 'web/src/engine/sim/moveEffects.ts:2409',
    probes: [/export function handleProtect\(/],
  },
  {
    opcode: 'setsubstitute',
    cSite: 'battle_script_commands.c:277',
    simSite: 'web/src/engine/sim/moveEffects.ts:4322',
    probes: [/battler\.volatiles\.substituteHp = hp/],
  },
  {
    opcode: 'setterrain',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:3373',
    probes: [/export function setFieldTerrain\(/],
  },
  {
    opcode: 'setroom',
    cSite: 'battle_script_commands.c:338',
    simSite: 'web/src/engine/sim/moveEffects.ts:3423',
    probes: [/function handleRoomMove\(/],
  },
  {
    opcode: 'setgravity',
    cSite: 'battle_script_commands.c:226',
    simSite: 'web/src/engine/sim/moveEffects.ts:3492',
    probes: [/state\.field\.timers\.gravityTimer = GRAVITY_DURATION/],
  },
  {
    opcode: 'setbattleweather',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:3288',
    probes: [/tryChangeBattleWeather\(state, battlerId, weatherEnum, false, deps\)/],
  },
  {
    opcode: 'checkprimalweather',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/switchInAbility.ts:411',
    probes: [/hasFlag\(state\.field\.weather, WEATHER_PRIMAL_ANY\)/],
  },
  {
    opcode: 'trysetclearskies',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:3535',
    probes: [/function handleClearSkies\(/],
  },
  {
    opcode: 'defogclear',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:3599',
    probes: [/function clearDefog\(/],
  },
  {
    opcode: 'removelightscreenreflect',
    cSite: 'battle_script_commands.c:359',
    simSite: 'web/src/engine/sim/turn.ts:3768',
    probes: [/moveEffect === 'EFFECT_BRICK_BREAK'/],
  },
  {
    opcode: 'swapsideeffects',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:8744',
    probes: [/export function handleCourtChange\(/],
  },
  {
    opcode: 'settypebasedhalvers',
    cSite: 'battle_script_commands.c:353',
    simSite: 'web/src/engine/sim/moveEffects.ts:7489',
    probes: [/state\.field\.statuses \|= STATUS_FIELD_MUDSPORT/],
  },
  {
    opcode: 'setalwayshitflag',
    cSite: 'battle_script_commands.c:288',
    simSite: 'web/src/engine/sim/moveEffects.ts:4466',
    probes: [/STATUS3_ALWAYS_HITS_TURN\(2\)/],
  },
  {
    opcode: 'onweatherchange',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/onWeather.ts:229',
    probes: [/export function dispatchOnWeatherChange\(/],
  },
  {
    opcode: 'onterrainchange',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/onWeather.ts:301',
    probes: [/export function dispatchOnTerrainChange\(/],
  },
  {
    opcode: 'setsemiinvulnerablebit',
    cSite: 'battle_script_commands.c:318',
    simSite: 'web/src/engine/sim/turn.ts:279',
    probes: [/export function setSemiInvulnerableBit\(/],
  },
  {
    opcode: 'clearsemiinvulnerablebit',
    cSite: 'battle_script_commands.c:319',
    simSite: 'web/src/engine/sim/turn.ts:3245',
    probes: [/clearFlag\(state\.battlers\[battlerId\]!\.statuses3, STATUS3_SEMI_INVULNERABLE\)/],
  },
  {
    opcode: 'setskydrop',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/turn.ts:3124',
    probes: [/targetBattler\.volatiles\.skyDropped = true/],
  },
  {
    opcode: 'showtime',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:10612',
    probes: [/export function handleShowtime\(/],
  },
  {
    opcode: 'trepidation',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:11847',
    probes: [/targetBattler\.volatiles\.trepidation = 3/],
  },
  {
    opcode: 'twoturnmoveacceleratecheck',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/turn.ts:3167',
    probes: [/const hasAccelerate = battlerHasSimAbility/],
  },
  {
    opcode: 'getrototillertargets',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:8558',
    probes: [/export function handleRototiller\(/],
  },
  {
    opcode: 'tryspiteppreduce',
    cSite: 'battle_script_commands.c:294',
    simSite: 'web/src/engine/sim/moveEffects.ts:7940',
    probes: [/export function handleSpite\(/],
  },
  {
    opcode: 'infatuatewithbattler',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/moveEffects.ts:2379',
    probes: [/function handleAttract\(/],
  },
  {
    opcode: 'tryinfatuating',
    cSite: 'battle_script_commands.c:272',
    simSite: 'web/src/engine/sim/moveEffects.ts:2379',
    probes: [/function handleAttract\(/],
  },
  {
    opcode: 'scheduleswitch',
    cSite: 'asm macro (no Cmd_ in sparse checkout)',
    simSite: 'web/src/engine/sim/turn.ts:1718',
    probes: [/export function performSwitchAction\(/],
  },
]

/** Opcodes whose production site is present in the comment-stripped consumer source. */
export function handledScriptOpcodes(source: string): Set<string> {
  const handled = new Set<string>()
  for (const handler of SCRIPT_OPCODE_HANDLERS) {
    if (handler.probes.every((probe) => probe.test(source))) handled.add(handler.opcode)
  }
  return handled
}

function opcodeHasHandler(opcode: string, handledOpcodes: ReadonlySet<string>): boolean {
  return handledOpcodes.has(opcode)
}


// ---------------------------------------------------------------------------
// Plain hits (cycle 151b rework, defect 3)
// ---------------------------------------------------------------------------

/**
 * Opcodes that are the shared hit frame / control flow, not per-script behaviour.
 * Each is asm-level machinery implemented once in
 * `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c`, not a move rule:
 *
 *   attackcanceler       Cmd_attackcanceler        :1046
 *   accuracycheck        Cmd_accuracycheck         (battle_script_commands.c, `Cmd_accuracycheck`)
 *   attackstring         Cmd_attackstring
 *   ppreduce             Cmd_ppreduce
 *   critcalc             Cmd_critcalc
 *   damagecalc           Cmd_damagecalc
 *   typecalc             Cmd_typecalc
 *   adjustdamage         Cmd_adjustdamage
 *   attackanimation      Cmd_attackanimation
 *   waitanimation        Cmd_waitanimation
 *   healthbarupdate      Cmd_healthbarupdate
 *   datahpupdate         Cmd_datahpupdate
 *   critmessage          Cmd_critmessage
 *   effectivenesssound   Cmd_effectivenesssound
 *   resultmessage        Cmd_resultmessage
 *   printstring          Cmd_printstring
 *   printfromtable       Cmd_printfromtable
 *   waitmessage          Cmd_waitmessage
 *   seteffectwithchance  Cmd_seteffectwithchance
 *   tryfaintmon          Cmd_tryfaintmon
 *   moveendall/moveendcase/moveendfrom/moveendto  Cmd_moveendall / Cmd_moveendcase (the MoveEnd
 *                        fan-out: `moveendall` walks the move-end cases and `moveendcase` runs one)
 *   hitanimation, waitstate, pause, end, return, goto, call: the frame's animation/control ops
 *   setbyte/copybyte/orword/andword/orhalfword/bichalfword/bicword/sethword/addbyte/subbyte/
 *   getbattler/setrandom: argument marshalling (`sB_ANIM_ARG1`, `gBattlerTarget`, ...)
 *   saveattackertostack3/readattackerfromstack3/savetargettostack4/readtargetfromstack4/
 *   saveattackerandtargetto34: the stack helpers used to loop battlers
 *   selectfirstvalidtarget/setallytonexttarget/showabilitypopup/recordability/movevaluescleanup/
 *   incrementgamestat: bookkeeping
 *   all `jumpif*` opcodes: conditional control flow. The taken branch's own commands are
 *   still in the parsed command list, so treating the jump itself as frame cannot hide a
 *   behaviour opcode.
 */
const SCRIPT_FRAME_OPCODES = new Set([
  'attackcanceler',
  'accuracycheck',
  'attackstring',
  'ppreduce',
  'critcalc',
  'damagecalc',
  'typecalc',
  'adjustdamage',
  'multihitresultmessage',
  'attackanimation',
  'waitanimation',
  'healthbarupdate',
  'datahpupdate',
  'critmessage',
  'effectivenesssound',
  'resultmessage',
  'printstring',
  'printfromtable',
  'waitmessage',
  'seteffectwithchance',
  'tryfaintmon',
  'moveendall',
  'moveendcase',
  'moveendfrom',
  'moveendto',
  'hitanimation',
  'waitstate',
  'pause',
  'end',
  'return',
  'goto',
  'call',
  'setbyte',
  'copybyte',
  'orword',
  'andword',
  'orhalfword',
  'bichalfword',
  'bicword',
  'sethword',
  'addbyte',
  'subbyte',
  'getbattler',
  'setrandom',
  'saveattackertostack3',
  'readattackerfromstack3',
  'savetargettostack4',
  'readtargetfromstack4',
  'saveattackerandtargetto34',
  'selectfirstvalidtarget',
  'setallytonexttarget',
  'showabilitypopup',
  'recordability',
  'movevaluescleanup',
  'incrementgamestat',
])

/** True for a script opcode that carries no move-specific behaviour of its own. */
export function isScriptFrameOpcode(opcode: string): boolean {
  return SCRIPT_FRAME_OPCODES.has(opcode) || opcode.startsWith('jump')
}

/** Distinct, order-preserving non-frame opcodes of a parsed script. */
export function scriptBehaviourCommands(record: ScriptRecord): string[] {
  const seen = new Set<string>()
  const commands: string[] = []
  for (const command of record.commands) {
    const opcode = command.split(/\s+/)[0]
    if (!opcode || isScriptFrameOpcode(opcode) || seen.has(opcode)) continue
    seen.add(opcode)
    commands.push(command)
  }
  return commands
}

/**
 * The `applySecondaryMoveEffects` plain-hit routing chain: effects this engine treats as
 * pure damage, with no secondary step of their own. `web/src/engine/sim/moveEffects.ts`
 * routes them to the shared damage path instead of pushing a "secondary effect not
 * modelled" note. The chain is the production site for the effects that need no
 * dedicated handler; an entry alone is not enough (see `plainHitEffectsFor`).
 */
export function plainHitRoutingEffects(source: string): Set<string> {
  const functionSlice = tryExtractFunctionSlice(source, 'export function applySecondaryMoveEffects(')
  const start = source.indexOf("moveEffect === 'EFFECT_HIT' ||", source.indexOf(functionSlice))
  if (start < 0) return new Set()
  const elseAt = source.indexOf('  } else {', start)
  const block = elseAt < 0 ? source.slice(start) : source.slice(start, elseAt)
  return new Set(block.match(/EFFECT_[A-Z0-9_]+/g) ?? [])
}

/** True when every command of the script is frame/control flow and it reaches a damage step. */
function scriptIsPlainHit(label: string, scripts: Map<string, ScriptRecord>): boolean {
  const record = scripts.get(label)
  if (!record || !record.hasDamageStep) return false
  return record.commands.every((command) => isScriptFrameOpcode(command.split(/\s+/)[0] ?? ''))
}

/**
 * Effects that are a plain hit in singles: the routing chain is their only production
 * claim, the declared behavior has no extra step, and every carrier is a damaging move
 * whose script is the plain hit frame. Verified against the scripts:
 *
 *   EFFECT_HIT                       -> `BattleScript_EffectHit` (data/battle_scripts_1.s:2857-2885):
 *       attackcanceler; accuracycheck; attackstring; ppreduce; damagecalc; adjustdamage;
 *       attackanimation; waitanimation; effectivenesssound; hitanimation; waitstate;
 *       healthbarupdate; datahpupdate; critmessage; waitmessage; resultmessage; waitmessage;
 *       seteffectwithchance; tryfaintmon; moveendall; end
 *   EFFECT_GUST                      -> `BattleScript_EffectGust` (:5703-5704): `goto BattleScript_EffectHit`
 *   EFFECT_DECORATE                  -> `BattleScript_EffectDecorate` (:582-584):
 *       `jumpiftargetally BattleScript_EffectDecorate_Ally; goto BattleScript_EffectHit`.
 *       The ally branch is a doubles-only path; this sim is singles, so a foe target takes EffectHit.
 *   EFFECT_CHANGE_TYPE_ON_ITEM       -> `BattleScript_EffectHit` (MoveBehaviorConfigList textproto);
 *       the type rule is `GetMoveTypeInternal`'s `changeTypeHoldEffect` read
 *       (web/src/engine/calculate.ts:1061-1064) of the held Plate/Memory wired from `move.argument`
 *       (web/src/engine/sim/driver/loadSimData.ts:226-230).
 *   EFFECT_HIT_ENEMY_HEAL_ALLY       -> `BattleScript_EffectHitEnemyHealAlly` (:1556-1558):
 *       `jumpiftargetally BattleScript_EffectHealPulse; goto BattleScript_EffectHit` -- the heal
 *       is the ally branch, unreachable in singles; Present's MYSTERY type is calculate.ts:1020.
 *
 * `web/src/engine/sim/moveEffects.ts`'s routing chain is the site that decides exactly this
 * (`moveEffect === 'EFFECT_CHANGE_TYPE_ON_ITEM' ||`, `moveEffect === 'EFFECT_GUST' ||`,
 * `((moveEffect === 'EFFECT_DECORATE' || moveEffect === 'EFFECT_HIT_ENEMY_HEAL_ALLY') && foe)`).
 */
export function plainHitEffectsFor(
  source: string,
  moves: MoveRecord[],
  behaviors: MoveBehaviors,
  scripts: Map<string, ScriptRecord>,
  consumption: ConsumptionIndex,
): Set<string> {
  const routed = plainHitRoutingEffects(source)
  const result = new Set<string>()
  if (routed.size === 0) return result
  const carriers = new Map<string, MoveRecord[]>()
  for (const move of moves) {
    if (!move.effect || !routed.has(move.effect)) continue
    const list = carriers.get(move.effect) ?? []
    list.push(move)
    carriers.set(move.effect, list)
  }
  for (const effect of routed) {
    // The chain is the effect's only production claim. A handler, custom base power, a
    // declarative field or a `case` means the effect has its own port.
    if (
      consumption.handlerEffects.has(effect) ||
      consumption.handledEffects.has(effect) ||
      consumption.customDamageEffects.has(effect) ||
      consumption.declarativeEffects.has(effect) ||
      consumption.moveEffects.has(effect) ||
      consumption.preHitEffects.has(effect) ||
      consumption.postHitEffects.has(effect)
    ) {
      continue
    }
    const list = carriers.get(effect) ?? []
    if (list.length === 0) continue
    const plain = list.every((move) => {
      const behavior = behaviorInForce(move, behaviors)
      const attack = behavior.attack
      const extraStep =
        (attack?.secondaryEffects?.length ?? 0) > 0 ||
        attack?.damage != null ||
        (attack?.recoilFraction ?? 0) > 0 ||
        Boolean(attack?.superEffectiveVs) ||
        Boolean(attack?.ignoreTypeImmunity) ||
        behavior.causesFlinch === true ||
        behavior.trappingEffect === true ||
        behavior.options != null
      if (extraStep) return false
      if ((move.power ?? 0) <= 1) return false
      const label = behavior.legacyConfig
      return label !== undefined && scriptIsPlainHit(label, scripts)
    })
    if (!plain) continue
    // A non-effect `move.argument` is an extra rule (Judgment/Multi-Attack's held-item type).
    // It only counts when the damage path actually reads the argument mechanism.
    const argumentDriven = list.some((move) => move.argument != null && move.argument.kind !== 'effect')
    if (argumentDriven && !/changeTypeHoldEffect|argumentInt/.test(source)) continue
    result.add(effect)
  }
  return result
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
  /** Repo-relative test file, when the evidence was built from named files. */
  file?: string
}

export interface TestEvidence {
  blocks: TestBlock[]
}

export interface TestFileSource {
  file: string
  source: string
}

/**
 * Local function declarations in one test file, with their source slice. Two shapes:
 * `function name(...) { ... }` and `const name = (...) => ...` / `const name = arg => ...`.
 * Used only to resolve helper wrappers over a sim entry point (cycle 151b rework defect 2).
 */
function localFunctionBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>()
  const addBody = (name: string, bodyStart: number): void => {
    const open = source.indexOf('{', bodyStart)
    if (open < 0) return
    // Reject a type annotation that swallows the next construct: a `;` before the brace
    // means this was a declaration, not a definition.
    const semicolon = source.indexOf(';', bodyStart)
    if (semicolon >= 0 && semicolon < open) return
    const close = matchPair(source, open, '{', '}')
    if (close > open) bodies.set(name, source.slice(open, close + 1))
  }
  for (const match of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const paramsOpen = source.indexOf('(', match.index)
    const paramsClose = matchPair(source, paramsOpen, '(', ')')
    if (paramsClose < 0) continue
    addBody(match[1], paramsClose + 1)
  }
  const arrowRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g
  for (const match of source.matchAll(arrowRe)) {
    const arrowAt = source.indexOf('=>', match.index)
    const after = source.slice(arrowAt + 2).match(/^\s*\{/)
    if (after) {
      addBody(match[1], arrowAt + 2)
    } else {
      // Expression body: to the end of the statement (a newline at nesting depth 0).
      const bodyStart = arrowAt + 2
      let depth = 0
      let end = bodyStart
      for (; end < source.length; end++) {
        const char = source[end]
        if (char === '(' || char === '{' || char === '[') depth++
        else if (char === ')' || char === '}' || char === ']') depth--
        else if (char === '\n' && depth <= 0) break
      }
      bodies.set(match[1], source.slice(bodyStart, end))
    }
  }
  return bodies
}

/**
 * Names of functions defined in a test file whose body reaches a sim entry point, directly
 * or through another such wrapper. A block that calls one of these runs the sim just as
 * surely as one that calls `executeTurn` inline (cycle 151b rework defect 2: cycle87's
 * `fire(...)`, cycle114's `runVs(...)`).
 */
export function wrapperFunctionNames(source: string): Set<string> {
  const bodies = localFunctionBodies(source)
  const wrappers = new Set<string>()
  for (const [name, body] of bodies) if (ENTRY_POINT_CALL_RE.test(body)) wrappers.add(name)
  let changed = true
  while (changed) {
    changed = false
    for (const [name, body] of bodies) {
      if (wrappers.has(name)) continue
      for (const wrapper of wrappers) {
        if (new RegExp(`\\b${escapeRegExp(wrapper)}\\s*\\(`).test(body)) {
          wrappers.add(name)
          changed = true
          break
        }
      }
    }
  }
  return wrappers
}

function callsAny(text: string, names: Iterable<string>): boolean {
  for (const name of names) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(text)) return true
  }
  return false
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

/**
 * Qualifying blocks of one test file. The file qualifies when it reaches a sim entry point
 * anywhere (an import or a local wrapper's body); a block qualifies when it calls an entry
 * point, or a local wrapper over one, after comments and non-evidence constructs are
 * stripped. A module-scope fixture never appears in a block, so it cannot be evidence.
 */
export function buildTestEvidence(testSource: string): TestEvidence {
  const source = stripComments(testSource)
  if (!QUALIFYING_TEST_RE.test(source)) return { blocks: [] }
  const wrappers = wrapperFunctionNames(source)
  const blocks: TestBlock[] = []
  for (const block of splitTestBlocks(source)) {
    const text = stripNonEvidence(block)
    if (!ENTRY_POINT_CALL_RE.test(text) && !callsAny(text, wrappers)) continue
    blocks.push({ text, words: new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) })
  }
  return { blocks }
}

/** Concatenated evidence of several test files, each analysed on its own (file boundary kept). */
export function buildTestEvidenceForFiles(files: readonly TestFileSource[]): TestEvidence {
  return {
    blocks: files.flatMap((file) =>
      buildTestEvidence(file.source).blocks.map((block) => ({ ...block, file: file.file })),
    ),
  }
}

function evidenceNames(evidence: TestEvidence, words: Iterable<string>): boolean {
  const list = [...words]
  if (list.length === 0) return false
  return evidence.blocks.some((block) => list.some((word) => block.words.has(word)))
}

/** Every engine test file outside `sim/ai/` that references a sim entry point at all. */
export function loadQualifyingTestFiles(): TestFileSource[] {
  const files: TestFileSource[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.test.ts') && entry.name !== 'moveInventory.test.ts') {
        const repoRelative = relative(REPO_ROOT, full)
        // AI scoring tests assert on scores, not on executing the move (item 2).
        if (repoRelative.startsWith('web/src/engine/sim/ai/')) continue
        const source = stripComments(readFileSync(full, 'utf-8'))
        if (QUALIFYING_TEST_RE.test(source)) files.push({ file: repoRelative, source })
      }
    }
  }
  walk(ENGINE_DIR)
  return files
}

/** Concatenated, comment-stripped text of the qualifying test files (context free; file boundaries lost). */
export function loadQualifyingTestSource(): string {
  return loadQualifyingTestFiles()
    .map((file) => file.source)
    .join('\n')
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
 * Test evidence for a flag literal: the exact key is set on a move-flags object
 * (`flags: { <key>: true }`), used as a move-flag property, or read through a flag helper.
 * A bare quoted occurrence (a description string, an unrelated field) is not evidence
 * (cycle 151 D5).
 */
export function flagHasTestEvidence(key: string, testSource: string): boolean {
  const escaped = escapeRegExp(key)
  return (
    new RegExp(`\\b${escaped}\\s*:\\s*(?:true|false)`).test(testSource) ||
    new RegExp(`\\bflags\\??\\.${escaped}\\b`).test(testSource) ||
    new RegExp(`hasMoveFlag\\([^)]*['"]${escaped}['"]`).test(testSource)
  )
}

/** Argument text of every sim-entry-point call in `text`. */
function entryPointArgumentTexts(text: string): string[] {
  const argumentsList: string[] = []
  const re = new RegExp(ENTRY_POINT_CALL_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const open = text.indexOf('(', match.index)
    const close = matchPair(text, open, '(', ')')
    if (close > open) argumentsList.push(text.slice(open + 1, close))
  }
  return argumentsList
}

/**
 * True when the block sets the flag key on a move literal that is actually passed to a sim
 * entry point: either inline in the call's arguments, or through a variable declared in the
 * same block. A module-scope fixture or a literal that is only compared/asserted does not
 * count (cycle 151b rework defect 1).
 */
export function flagSetOnRunnerMoveInBlock(key: string, text: string): boolean {
  const escaped = escapeRegExp(key)
  const literal = new RegExp(`(?:move)?[fF]lags\\s*:\\s*\\{[^}]*\\b${escaped}\\s*:\\s*true\\b`, 's')
  const args = entryPointArgumentTexts(text).join('\n')
  if (args && literal.test(args)) return true
  if (!args) return false
  // `const mon = { ..., flags: { <key>: true } }` then `executeTurn(state, mon, ...)`.
  const declarationRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{/g
  for (const match of text.matchAll(declarationRe)) {
    const open = text.indexOf('{', match.index)
    const close = matchPair(text, open, '{', '}')
    if (close < 0) continue
    if (!literal.test(text.slice(open, close + 1))) continue
    if (new RegExp(`\\b${escapeRegExp(match[1])}\\b`).test(args)) return true
  }
  return false
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
  /** flag key -> distinct move ids that carry it as `true`. */
  flagMoveIds: Map<string, Set<string>>
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
  flagMoveIds: Map<string, Set<string>>
} {
  const effectMoveIds = new Map<string, Set<string>>()
  const secondaryMoveIds = new Map<string, Set<string>>()
  const argumentEffects = new Set<string>()
  const scriptMoveIds = new Map<string, Set<string>>()
  const flagMoveIds = new Map<string, Set<string>>()
  for (const move of moves) {
    const behavior = behaviorInForce(move, behaviors)
    if (move.effect) addToIndex(effectMoveIds, move.effect, move.id)
    for (const name of behaviorSecondaries(move, behavior)) addToIndex(secondaryMoveIds, name, move.id)
    if (move.argument?.kind === 'effect' && move.argument.effect) {
      addToIndex(secondaryMoveIds, move.argument.effect, move.id)
      argumentEffects.add(move.argument.effect)
    }
    if (behavior.legacyConfig) addToIndex(scriptMoveIds, behavior.legacyConfig, move.id)
    for (const [key, value] of Object.entries(move.flags ?? {})) {
      if (value === true) addToIndex(flagMoveIds, key, move.id)
    }
  }
  return { effectMoveIds, secondaryMoveIds, argumentEffects, scriptMoveIds, flagMoveIds }
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
  // A plain hit has no behaviour of its own: `applySecondaryMoveEffects`' routing chain
  // sends it to the shared damage path, which the suite exercises. The chain is the
  // production site; removing its entry makes the effect unported (see the mutation tests).
  if (ctx.consumption.plainHitEffects.has(effect)) return { status: 'ported', registeredUntested: false }
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

/** Flags carried by this many moves or fewer need the flag named, not just a carrier run. */
const FLAG_FEW_CARRIERS = 5
/** Flags carried by this many moves or more are "generic" (`contact`, `protect`, ...). */
const FLAG_GENERIC_CARRIERS = 100

/**
 * Ability/effect identifiers that read `key` in production: every `flags.<key>` /
 * `hasMoveFlag(..., '<key>')` site contributes the `ABILITY_*` / `EFFECT_*` /
 * `MOVE_EFFECT_*` tokens in a small window around it. The window is the expression that
 * guards the read (`if (ctx.moveFlags.drillBased)` sits inside `ABILITY_MEGA_DRILL`), not
 * the whole file, so an unrelated neighbouring ability does not become a reader.
 */
export function flagReaderTokens(key: string, productionSource: string): Set<string> {
  const escaped = escapeRegExp(key)
  const readRes = [
    new RegExp(`[fF]lags\\??\\.${escaped}\\b`, 'g'),
    new RegExp(`hasMoveFlag\\([^)]*['"]${escaped}['"]`, 'g'),
    new RegExp(`flag\\s*===\\s*['"]${escaped}['"]`, 'g'),
  ]
  const readers = new Set<string>()
  for (const re of readRes) {
    let match: RegExpExecArray | null
    while ((match = re.exec(productionSource)) !== null) {
      const window = productionSource.slice(Math.max(0, match.index - 300), match.index + 300)
      for (const token of window.match(/\b(?:ABILITY|EFFECT|MOVE_EFFECT)_[A-Z0-9_]+/g) ?? []) {
        readers.add(token)
      }
    }
  }
  return readers
}

/**
 * Flag test evidence (cycle 151b rework defect 2). A qualifying block proves a flag only
 * when it names a subject carrying the flag **and** shows the flag's production read being
 * what the block exercises. Concretely, a block counts when:
 *   - it sets the flag key on a move-flags literal passed to a sim entry point
 *     (`flagSetOnRunnerMoveInBlock`, rule (a)); or
 *   - it names the flag key itself (`flags.<key>`, `hasMoveFlag(..., '<key>')`, or the
 *     quoted key) together with a move id that carries the flag; or
 *   - it names a move id that carries the flag **and** names an ability/effect token from
 *     the production site that reads the flag (`flagReaderTokens`, rule (b)).
 *
 * A bare move-id match is not enough. For a flag with fewer than `FLAG_FEW_CARRIERS`
 * carriers the test file must also name the flag key. For a generic flag
 * (`>= FLAG_GENERIC_CARRIERS` carriers, e.g. `contact`) the block itself must name the
 * key or a reading ability/effect: running one carrier move says nothing about the flag.
 * A module-scope fixture, a comment, an AI-scoring test and a `.not.toContain` note are
 * never blocks and never count.
 */
function flagHasBlockEvidence(key: string, ctx: ClassifyContext): boolean {
  const carriers = ctx.flagMoveIds.get(key) ?? new Set<string>()
  const generic = carriers.size >= FLAG_GENERIC_CARRIERS
  const readers = flagReaderTokens(key, ctx.productionSource)
  const escaped = escapeRegExp(key)

  const namesKey = (block: TestBlock): boolean =>
    new RegExp(`[fF]lags\\??\\.${escaped}\\b`).test(block.text) ||
    new RegExp(`hasMoveFlag\\([^)]*['"]${escaped}['"]`).test(block.text) ||
    new RegExp(`['"\`]${escaped}['"\`]`).test(block.text)
  const namesCarrier = (block: TestBlock): boolean => {
    for (const moveId of carriers) if (block.words.has(moveId)) return true
    return false
  }
  const showsReader = (block: TestBlock): boolean => {
    for (const reader of readers) if (block.words.has(reader)) return true
    return false
  }

  if (ctx.evidence.blocks.some((block) => flagSetOnRunnerMoveInBlock(key, block.text))) return true

  const fileNamesKey = (file: string | undefined): boolean =>
    ctx.evidence.blocks.some((block) => (block.file ?? '') === (file ?? '') && namesKey(block))

  return ctx.evidence.blocks.some((block) => {
    const subject = namesCarrier(block) || namesKey(block)
    if (!subject) return false
    // A generic flag always needs the read in the block itself.
    if (generic) return namesKey(block) || showsReader(block)
    const readEvidence = namesKey(block) || showsReader(block)
    if (carriers.size < FLAG_FEW_CARRIERS) {
      // A move-id-only match needs the file to name the flag key at all.
      return readEvidence || fileNamesKey(block.file)
    }
    return readEvidence
  })
}

function classifyFlag(key: string, ctx: ClassifyContext): { status: MoveUnitStatus; registeredUntested: boolean } {
  const allow = allowlistFor('flag', key, ctx.allowlist)
  if (allow) return { status: 'allowlisted', registeredUntested: false }
  const production = flagHasProductionRead(key, ctx.productionSource)
  const tested = flagHasBlockEvidence(key, ctx)
  if (production && tested) return { status: 'ported', registeredUntested: false }
  if (production) return { status: 'unported', registeredUntested: true }
  return { status: 'unported', registeredUntested: false }
}

const BATTLE_SCRIPT_COMMANDS_PATH = 'pipeline/.upstream/eliteredux-source/src/battle_script_commands.c'

let commandHandlerLines: Map<string, number> | null = null

/**
 * Script opcode -> the line of its `Cmd_<opcode>` definition in
 * `battle_script_commands.c`. Commands implemented as `VARIOUS_*` subcommands (there is no
 * `Cmd_checkpoltergeist`) or macros are simply absent from the map.
 */
export function loadCommandHandlerLines(
  path: string = join(REPO_ROOT, BATTLE_SCRIPT_COMMANDS_PATH),
): Map<string, number> {
  if (commandHandlerLines) return commandHandlerLines
  const lines = readFileSync(path, 'utf-8').split('\n')
  const map = new Map<string, number>()
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^static void Cmd_([a-z0-9_]+)\(/)
    if (match && !map.has(match[1])) map.set(match[1], index + 1)
  }
  commandHandlerLines = map
  return map
}

let knownScriptOpcodes: Set<string> | null = null

/**
 * Every opcode spelling that occurs in the upstream battle scripts. A real command is
 * either in this set (it is compiled from `battle_scripts_1.s`/`_2.s`, including
 * macro-dispatched `VARIOUS_*` commands) or has a `Cmd_` in `battle_script_commands.c`.
 * A synthetic/unknown opcode is neither, so it cannot be silently treated as handled.
 */
export function loadKnownScriptOpcodes(): Set<string> {
  if (knownScriptOpcodes) return knownScriptOpcodes
  const set = new Set<string>()
  for (const repoRelative of BATTLE_SCRIPTS_PATHS) {
    for (const line of readFileSync(join(REPO_ROOT, repoRelative), 'utf-8').split('\n')) {
      const match = line.match(/^\t+([a-z][a-z0-9_]*)\b/)
      if (match) set.add(match[1])
    }
  }
  knownScriptOpcodes = set
  return set
}

/**
 * Whether the owning effect has some production path at all. This is NOT a handler for the
 * effect's script commands: a `HANDLERS` body, `CUSTOM_MOVE_DAMAGE` rule, declarative field
 * or plain-hit routing entry only says the effect has a port somewhere. The script is
 * ported only when each non-skeleton command is handled at an opcode-specific site
 * (`SCRIPT_OPCODE_HANDLERS`), so this predicate is used for reporting / skeleton-only
 * scripts, never to absolve a behaviour command.
 */
function effectHasScriptImplementation(effect: string | null, ctx: ClassifyContext): boolean {
  if (!effect) return false
  return (
    effectHasProductionPath(effect, ctx) ||
    ctx.consumption.plainHitEffects.has(effect) ||
    ctx.consumption.preHitEffects.has(effect) ||
    ctx.consumption.postHitEffects.has(effect)
  )
}

/**
 * Legacy-script production path (cycle 151b rework defect 4), computed from the script's
 * **non-skeleton** commands only (`scriptBehaviourCommands`). Skeleton opcodes are the
 * shared hit frame that `web/src/engine/sim/turn.ts` + `damageResolver.ts` already run.
 *
 *  - A script made only of skeleton opcodes is the plain-hit skeleton. It is ported when
 *    its owning move effect is ported -- the same damage path (`calculate.ts`,
 *    `damageResolver.ts`) then executes what the script says.
 *  - A script with non-skeleton commands is ported only when each of those commands has a
 *    handler:
 *      * the owning effect has a `case` in `runLegacyPreHit`/`runLegacyPostHit`
 *        (`hitScripts.ts`), which is the hand-written port of that whole script, or
 *      * `setmoveeffect MOVE_EFFECT_*`, whose effects must all be consumed by the
 *        secondary dispatch (`secondaryIsConsumed`), or
 *      * a production site in `SCRIPT_OPCODE_HANDLERS`, cited by file:line and matched
 *        against the comment-stripped sim source (removing that code makes the opcode
 *        unhandled again).
 *    The owning effect having *some* production path is not a handler (cycle 151b rework 2,
 *    defect A). Anything else is a real gap and is reported with its `Cmd_` line.
 */
function unhandledScriptCommands(
  label: string,
  owningEffect: string | null,
  ctx: ClassifyContext,
): string[] {
  const record = ctx.scripts.get(label)
  if (!record) return []
  // `runLegacyPreHit`/`runLegacyPostHit` dispatch on the move effect, not on the label;
  // when the effect is cased there, that case is the port of this script's commands.
  if (
    owningEffect &&
    (ctx.consumption.preHitEffects.has(owningEffect) || ctx.consumption.postHitEffects.has(owningEffect))
  ) {
    return []
  }
  const known = loadKnownScriptOpcodes()
  const unhandled: string[] = []
  for (const command of scriptBehaviourCommands(record)) {
    const opcode = command.split(/\s+/)[0] ?? ''
    // An opcode that does not occur in the upstream scripts is not a command this engine
    // can know about: a fabricated command must never ride on its effect's port.
    if (!known.has(opcode)) {
      unhandled.push(command)
      continue
    }
    if (opcode === 'setmoveeffect') {
      const names = command.match(/MOVE_EFFECT_[A-Z0-9_]+/g) ?? []
      // `setmoveeffect 0` only clears the stored effect: nothing to dispatch.
      if (names.length === 0) continue
      if (names.some((name) => !secondaryIsConsumed(name, ctx.consumption))) unhandled.push(command)
      continue
    }
    if (!opcodeHasHandler(opcode, ctx.consumption.handledOpcodes)) unhandled.push(command)
  }
  return unhandled
}

interface LegacyScriptClassification {
  status: MoveUnitStatus
  registeredUntested: boolean
  /** Non-skeleton commands with no handler (empty when the script has a production path). */
  unhandled: string[]
}

function classifyLegacyScript(
  label: string,
  owningEffect: string | null,
  owningEffectPorted: boolean,
  ctx: ClassifyContext,
): LegacyScriptClassification {
  // A script may be allowlisted directly, or inherit an effect-wide move-effect allowance.
  const allow =
    allowlistFor('legacy-script', label, ctx.allowlist) ??
    (owningEffect ? allowlistFor('move-effect', owningEffect, ctx.allowlist) : undefined)
  if (allow) return { status: 'allowlisted', registeredUntested: false, unhandled: [] }
  const record = ctx.scripts.get(label)
  if (!record) return { status: 'unclassified', registeredUntested: false, unhandled: [] }
  const unhandled = unhandledScriptCommands(label, owningEffect, ctx)
  const production =
    unhandled.length === 0 &&
    (scriptBehaviourCommands(record).length === 0
      ? owningEffectPorted
      : effectHasScriptImplementation(owningEffect, ctx))
  if (!production) return { status: 'unported', registeredUntested: false, unhandled }
  const tested = evidenceNames(ctx.evidence, [label, ...(ctx.scriptMoveIds.get(label) ?? [])])
  if (tested) return { status: 'ported', registeredUntested: false, unhandled: [] }
  return { status: 'unported', registeredUntested: true, unhandled: [] }
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
  const scripts = options.scripts ?? parseScripts()
  const consumption = buildConsumptionIndex(consumerSource, moves, behaviors, scripts, productionSource)
  const evidence =
    options.testSource !== undefined
      ? buildTestEvidence(options.testSource)
      : buildTestEvidenceForFiles(loadQualifyingTestFiles())
  const effectProtoLines = loadMoveEffectProtoLines()
  const flagMetadata = loadFlagMetadata()
  const { effectMoveIds, secondaryMoveIds, argumentEffects, scriptMoveIds, flagMoveIds } = buildUnitMoveIds(
    moves,
    behaviors,
  )

  const ctx: ClassifyContext = {
    allowlist,
    productionSource,
    consumption,
    evidence,
    effectMoveIds,
    secondaryMoveIds,
    argumentEffects,
    scriptMoveIds,
    flagMoveIds,
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
  const unhandledScripts = new Map<string, { command: string; scripts: Set<string> }>()

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
      const owningEffectPorted = move.effect != null && effectStatus.get(move.effect) === 'ported'
      const classified = classifyLegacyScript(
        behavior.legacyConfig,
        move.effect ?? null,
        owningEffectPorted,
        ctx,
      )
      for (const command of classified.unhandled) {
        const opcode = command.split(/\s+/)[0] ?? ''
        const entry = unhandledScripts.get(opcode) ?? { command, scripts: new Set<string>() }
        entry.scripts.add(behavior.legacyConfig)
        unhandledScripts.set(opcode, entry)
      }
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
    unhandledScriptCommands: [...unhandledScripts.entries()]
      .map(([opcode, entry]) => ({
        command: entry.command,
        opcode,
        cLine: loadCommandHandlerLines().get(opcode) ?? 0,
        scripts: [...entry.scripts].sort(),
      }))
      .sort((a, b) => (a.opcode < b.opcode ? -1 : a.opcode > b.opcode ? 1 : 0)),
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
  lines.push('`it(...)`/`test(...)` call that reaches a sim entry point (`createSession`/`executeTurn`/`stepTurn`/')
  lines.push('`useMove`/`buildMoveAction`/`calculateMoveDamage`), with comments stripped. A block reaches one directly,')
  lines.push('or through a **file-local wrapper** (`fire(...)`, `runVs(...)`, ...) defined in the same test file whose body')
  lines.push('calls an entry point; a wrapper defined in the file but not called by the block is not evidence. Mentioning')
  lines.push('the unit in a comment, in a `web/src/engine/sim/ai/` scoring test, in a module-scope data sentinel')
  lines.push('(`if (...) throw`) or in a `.not.toContain(\'... not modelled\')` assertion is not evidence.')
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
    '     `isTwoTurnsMove`; those classify and are not dispatch sites. The plain-hit routing chain is not read as a',
  )
  lines.push(
    '     `case`/comparison site either -- it is handled explicitly by the plain-hit bullet below. A `&& false` /',
  )
  lines.push('     `if (false)` branch is dead and does not count either.',
  )
  lines.push(
    '   - a plain hit: the effect is one of the entries of the routing chain at the top of `applySecondaryMoveEffects`',
  )
  lines.push(
    '     (`moveEffects.ts`), the production site that sends `EFFECT_HIT`, `EFFECT_GUST`, `EFFECT_DECORATE`,',
  )
  lines.push(
    '     `EFFECT_CHANGE_TYPE_ON_ITEM` and `EFFECT_HIT_ENEMY_HEAL_ALLY` to the shared damage path. The chain entry is',
  )
  lines.push(
    '     accepted only when every carrier move is a plain hit (power > 1, no secondary/extra attack step, no',
  )
  lines.push(
    '     flinch/trap/options, and a script made only of the skeleton opcodes). `EFFECT_CHANGE_TYPE_ON_ITEM`',
  )
  lines.push(
    '     (Judgment/Multi-Attack) changes type in `calculate.ts:1061-1064` from the held Plate/Memory wired by',
  )
  lines.push(
    '     `sim/driver/loadSimData.ts:226`; `EFFECT_HIT_ENEMY_HEAL_ALLY` (Pollen Puff/Present) is a plain hit on a foe,',
  )
  lines.push(
    '     with Present\'s MYSTERY type at `calculate.ts:1020` -- their scripts (`BattleScript_EffectHit`,',
  )
  lines.push(
    '     `BattleScript_EffectHitEnemyHealAlly:1556-1558`) take the ally-heal branch only in doubles. The chain is',
  )
  lines.push('     not a name list: removing an effect\'s entry makes it unported (mutation-tested).')
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
    '3. **flag**: every true key in `move.flags`. Production = a move-flag read in engine source that runs move',
  )
  lines.push(
    '   logic (`flags.<key>`, `moveFlags.<key>`, `hasMoveFlag(..., \'<key>\')`, `flag === \'<key>\'`), with comments',
  )
  lines.push(
    '   stripped so a prose mention is not a read. Test evidence = a qualifying block that names a real move id',
  )
  lines.push('   carrying the flag')
  lines.push(
    '   (`moves.json`), or sets `<key>: true` on a `flags`/`moveFlags` literal actually passed to a sim entry point',
  )
  lines.push(
    '   in that block. A module-scope fixture, the `cycle98AiState.test.ts` data sentinel, a comment and an',
  )
  lines.push('   AI-scoring test are not evidence.'),
  lines.push(
    '4. **legacy-script**: the behavior in force\'s `legacyConfig` from `data/battle_scripts_1.s`/`_2.s`. Status is',
  )
  lines.push(
    '   computed from **non-skeleton** commands only. Skeleton opcodes (`attackcanceler`, `accuracycheck`,',
  )
  lines.push(
    '   `attackstring`, `critcalc`, `damagecalc`, `typecalc`, `adjustdamage`, `attackanimation`, `waitanimation`,',
  )
  lines.push(
    '   `effectivenesssound`, `resultmessage`, `printstring`, `waitmessage`, `seteffectwithchance`, `tryfaintmon`,',
  )
  lines.push(
    '   `moveendall`/`moveendcase`, and the rest of `SCRIPT_FRAME_OPCODES`; each is a `Cmd_*` in',
  )
  lines.push(
    '   `battle_script_commands.c` and is shared machinery, not a move rule). A skeleton-only script is the plain-hit',
  )
  lines.push(
    '   skeleton: ported when its owning move effect is ported (the damage path). A script with a non-skeleton',
  )
  lines.push(
    '   command is ported only when every such command has its own handler; the owning effect being ported is not',
  )
  lines.push(
    '   enough. A command is handled by (a) a real shared `runLegacyPreHit`/`runLegacyPostHit` `case` for the owning',
  )
  lines.push(
    '   effect, (b) a `setmoveeffect MOVE_EFFECT_*` whose effects are all consumed by the secondary dispatch, or',
  )
  lines.push(
    '   (c) an opcode entry in `SCRIPT_OPCODE_HANDLERS` whose production-site probes all match the engine source.',
  )
  lines.push(
    '   The last rule is how shared machinery (`statbuffchange`, `setreflect`, ...) is recognised without a bare name',
  )
  lines.push(
    '   list. Commands left without a handler are listed under "Legacy Script Commands Without a Handler". Test',
  )
  lines.push(
    '   evidence = a qualifying block naming the label or a move carrying it. Scripts are parsed with `.if`/`.else`',
  )
  lines.push('   evaluated against `battle_config.h` and `call` targets expanded one level.'),
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

  lines.push('## Legacy Script Commands Without a Handler')
  lines.push('')
  lines.push(
    'Every distinct non-skeleton script command that keeps a script unported, with the `Cmd_<opcode>` definition',
  )
  lines.push('line in `pipeline/.upstream/eliteredux-source/src/battle_script_commands.c` (`--` = no such command).')
  lines.push('')
  if (result.unhandledScriptCommands.length === 0) {
    lines.push('None.')
  } else {
    for (const command of result.unhandledScriptCommands) {
      const location =
        command.cLine > 0 ? `battle_script_commands.c:${command.cLine}` : 'no `Cmd_` definition in this source'
      lines.push(
        `- \`${command.command}\` -- ${location}; blocks ${command.scripts.map((script) => `\`${script}\``).join(', ')}`,
      )
    }
  }
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
