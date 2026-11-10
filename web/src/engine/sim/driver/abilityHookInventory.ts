import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lookupAbility } from '../../abilities/registry'
import { isUnmodelled, type AbilityEntry } from '../../abilities/types'
import '../../abilities/impl/index' // side-effect registration populates registry
import {
  PORTED_ATTACKER_ABILITIES,
  PORTED_DEFENDER_ABILITIES,
  KO_STAT_RAISES,
  KO_SOUL_EATER_ABILITIES,
  KO_JAWS_OF_CARNAGE_ABILITIES,
  KO_CRIT_BOOST_ABILITIES,
  ON_RECOIL_ABILITIES,
} from '../moveEnd'
import {
  WEATHER_SETTER_MAP,
  TERRAIN_SETTER_MAP,
  PORTED_ENTRY_MOVE_MAP,
  INTIMIDATE_CLONE_MAP,
  ADD_TYPE_ON_ENTRY,
  ANNOUNCE_ONLY_ON_ENTRY,
} from '../switchInAbility'
import { OWN_STATUS_IMMUNE_CONDITIONS, SET_STATE_ON_EFFECT_ABILITIES } from '../statusEffects'
import { ON_STAT_LOWERED_HOOKS, POISON_PUPPETEER_CLONE_ABILITIES } from '../statBuffs'
import { HEAL_ABSORB_ABILITIES, STAT_ABSORB_ABILITIES } from '../absorb'

export const HOOK_KINDS = [
  'onAbsorb',
  'onAccuracy',
  'onAfterTypeEffectiveness',
  'onAttacker',
  'onBattlerFaints',
  'onBeforeAttack',
  'onBlockStatDrops',
  'onCanStatusType',
  'onChooseDefensiveStat',
  'onChooseOffensiveStat',
  'onCopyMove',
  'onCrit',
  'onDefender',
  'onDefensiveMultiplier',
  'onDisguise',
  'onEndTurn',
  'onEntry',
  'onExit',
  'onImmune',
  'onInfiltrate',
  'onModifyEffectChance',
  'onModifyMoveFlags',
  'onModifyTargetFlag',
  'onMoldBreaker',
  'onMoveType',
  'onOffensiveMultiplier',
  'onParentalBond',
  'onPreemptAction',
  'onPriority',
  'onReactive',
  'onRecoil',
  'onRevive',
  'onStab',
  'onStat',
  'onStatLowered',
  'onStatusImmune',
  'onSwapSplit',
  'onTerrain',
  'onTrap',
  'onTypeEffectiveness',
  'onWeather',
] as const

export type HookKind = (typeof HOOK_KINDS)[number]

export interface HookDefinition {
  form?: string
  source?: string
  aliasTarget?: string
  aliasHook?: string
}

export interface AbilityHookRecord {
  id: string
  sourceLine: number
  endLine?: number
  bitfields?: Record<string, string>
  hooks?: Record<string, HookDefinition>
  applyOn?: Record<string, unknown>
  damageRelevant?: boolean
  damageRelevantReasons?: string[]
}

export type ClassificationStatus = 'ported' | 'unported' | 'unclassified' | 'allowlisted'

export interface PairClassification {
  ability: string
  hook: HookKind
  status: ClassificationStatus
  sourceLine: number
  tested: boolean
  abilityMentionedInTest: boolean
}

export interface HookKindSummary {
  hook: HookKind
  defined: number
  ported: number
  allowlisted: number
  unported: number
  unclassified: number
  tested: number
  abilityMentionedInTests: number
}

export interface InventoryResult {
  classifications: PairClassification[]
  summaries: HookKindSummary[]
  totalDefined: number
  totalPorted: number
  totalAllowlisted: number
  totalUnported: number
  totalUnclassified: number
  totalTested: number
  totalAbilityMentionedInTests: number
  unportedPairs: PairClassification[]
  /** Allowlist entries whose (ability, hook) is not defined in the hook data, or is already ported.
   * Such an entry grants nothing and hides nothing: it is stale and must be removed. */
  staleAllowlist: AllowlistEntry[]
}

export interface AllowlistEntry {
  ability: string
  hook: string
  citation: string
}

/**
 * Allowlist for (ability, hook) pairs that are deliberately permanently unmodelled / out of scope.
 * Empty today: every pair the hook data defines is either ported or counted as unported. Every entry
 * must cite its upstream source location. `runInventory` reports entries that no longer match a
 * defined, unported pair in `staleAllowlist`, so a stale entry cannot silently swallow a gap.
 */
export const ABILITY_HOOK_ALLOWLIST: ReadonlyArray<AllowlistEntry> = []

export interface NoteOnlyPair {
  ability: string
  hook: HookKind
  /** Repo-relative path plus 1-based line, for display only -- tests match on the path, not the line. */
  site: string
  /** The stripped note line exactly as it appears at the site (the only text the table pins). */
  note: string
}

/**
 * Branches whose only effect is pushing an unmodelled note.
 * Classified as unported until real simulation behavior is ported.
 */
export const NOTE_ONLY_PAIRS: ReadonlyArray<NoteOnlyPair> = [
  {
    ability: 'ABILITY_AFTERSHOCK',
    hook: 'onAttacker',
    site: 'web/src/engine/sim/moveEnd.ts:4542',
    note: `unmodelled.push("Aftershock's followup move (UseAttackerFollowUpMove MOVE_MAGNITUDE, abilities.cc:6355; ABILITY_AFTERSHOCK) is not modelled")`,
  },
  {
    ability: 'ABILITY_BLADE_DANCE',
    hook: 'onAttacker',
    site: 'web/src/engine/sim/moveEnd.ts:4552',
    note: `unmodelled.push("Blade Dance's followup move (UseAttackerFollowUpMove MOVE_LEAF_BLADE, abilities.cc:9043; ABILITY_BLADE_DANCE) is not modelled")`,
  },
  {
    ability: 'ABILITY_HIGH_TIDE',
    hook: 'onAttacker',
    site: 'web/src/engine/sim/moveEnd.ts:5579',
    note: `unmodelled.push("High Tide's followup move (UseAttackerFollowUpMove MOVE_SURF, abilities.cc:6477; ABILITY_HIGH_TIDE) is not modelled")`,
  },
  {
    ability: 'ABILITY_PURPLE_HAZE',
    hook: 'onAttacker',
    site: 'web/src/engine/sim/moveEnd.ts:5644',
    note: `unmodelled.push("Purple Haze's followup move (UseAttackerFollowUpMove MOVE_POISON_GAS, abilities.cc:10284; ABILITY_PURPLE_HAZE) is not modelled")`,
  },
  {
    ability: 'ABILITY_VOLCANO_RAGE',
    hook: 'onAttacker',
    site: 'web/src/engine/sim/moveEnd.ts:5677',
    note: `unmodelled.push("Volcano Rage's followup move (UseAttackerFollowUpMove MOVE_ERUPTION, abilities.cc:4845; ABILITY_VOLCANO_RAGE) is not modelled")`,
  },
  {
    ability: 'ABILITY_GENERATOR',
    hook: 'onExit',
    site: 'web/src/engine/sim/turn.ts:1670',
    note: 'unmodelled.push(`battler ${battlerId}: switch-out Generator SetSingleUseAbilityCounter is not modelled (ABILITY_GENERATOR)`)',
  },
  {
    ability: 'ABILITY_ENERGIZED',
    hook: 'onExit',
    site: 'web/src/engine/sim/turn.ts:1678',
    note: 'unmodelled.push(`battler ${battlerId}: switch-out Energized SetSingleUseAbilityCounter is not modelled (ABILITY_ENERGIZED)`)',
  },
  {
    ability: 'ABILITY_RETRIEVER',
    hook: 'onExit',
    site: 'web/src/engine/sim/turn.ts:1697',
    note: 'unmodelled.push(`battler ${battlerId}: switch-out Retriever item restoration is not modelled (ABILITY_RETRIEVER)`)',
  },
  {
    ability: 'ABILITY_FROSTBIND',
    hook: 'onReactive',
    site: 'web/src/engine/sim/statBuffs.ts:1588',
    note: 'const msg = `PoisonPuppeteerClone: ${abilityId} applies ${script} (src/abilities.cc:10000, 10083); that effect is not modelled`',
  },
  {
    ability: 'ABILITY_HEMOTOXIN',
    hook: 'onReactive',
    site: 'web/src/engine/sim/statBuffs.ts:1588',
    note: 'const msg = `PoisonPuppeteerClone: ${abilityId} applies ${script} (src/abilities.cc:10000, 10083); that effect is not modelled`',
  },
  {
    ability: 'ABILITY_RETRIBUTION_BLOW',
    hook: 'onReactive',
    site: 'web/src/engine/sim/statBuffs.ts:1350',
    note: 'unmodelled.push("Retribution Blow out-of-turn attack (abilities.cc:5145-5160) is not modelled (ABILITY_RETRIBUTION_BLOW)")',
  },
]

export const NOTE_ONLY_SET: ReadonlySet<string> = new Set(NOTE_ONLY_PAIRS.map((p) => `${p.ability}:${p.hook}`))

export interface HookAliasResolverAllowance {
  hook: HookKind
  citation: string
}

/**
 * Dispatchers that actually resolve aliases dynamically at runtime.
 * Empty today: dispatchers switch/lookup on the holder's own ID.
 */
export const HOOK_ALIAS_RESOLVER_ALLOWANCES: ReadonlyArray<HookAliasResolverAllowance> = []

// ---------------------------------------------------------------------------
// Dynamic sim-side extraction helpers
// ---------------------------------------------------------------------------

const ENGINE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const SOURCES_LOCK_PATH = join(REPO_ROOT, 'sources.lock.json')

const ACCURACY_PATH = join(ENGINE_DIR, 'sim/accuracy.ts')
const END_TURN_PATH = join(ENGINE_DIR, 'sim/endTurn.ts')
const PREEMPT_PATH = join(ENGINE_DIR, 'sim/preempt.ts')
const ON_WEATHER_PATH = join(ENGINE_DIR, 'sim/onWeather.ts')
const MOVE_TARGET_FLAGS_PATH = join(ENGINE_DIR, 'sim/moveTargetFlags.ts')
const STAT_BUFFS_PATH = join(ENGINE_DIR, 'sim/statBuffs.ts')
const STATUS_EFFECTS_PATH = join(ENGINE_DIR, 'sim/statusEffects.ts')
const TURN_PATH = join(ENGINE_DIR, 'sim/turn.ts')
const MOVE_END_PATH = join(ENGINE_DIR, 'sim/moveEnd.ts')
const ABSORB_PATH = join(ENGINE_DIR, 'sim/absorb.ts')
const ESCAPE_PATH = join(ENGINE_DIR, 'sim/escape.ts')
const SWITCH_IN_PATH = join(ENGINE_DIR, 'sim/switchInAbility.ts')

/**
 * Extracts the slice of code corresponding to a function declaration, from the declaration through
 * the closing brace that matches its body's opening brace. The declaration string must end at the
 * `(` of the parameter list; the parameter list and any return-type annotation are skipped.
 *
 * Comments are blanked to spaces of equal length before returning (see
 * `stripCommentsPreservingLayout`), so an ability id mentioned in a comment, in a gutted `if
 * (false)` block or in the next function's JSDoc is not part of the slice. String literals are
 * kept, so `'ABILITY_X'` branches still match. Ending at the matching brace also keeps top-level
 * tables that sit between two functions out of the caller's slice (the old next-declaration rule
 * swept `ADD_TYPE_ON_ENTRY` into `applyFrisk`'s slice and `POISON_PUPPETEER_CLONE_ABILITIES` into
 * `runReactiveAbilityEffects`'s).
 */
export function extractFunctionSlice(source: string, functionDeclaration: string): string {
  const { start, end, stripped } = locateFunctionSlice(source, functionDeclaration)
  return stripped.slice(start, end)
}

/**
 * The same slice as `extractFunctionSlice`, but cut out of the *raw* source. Comments are only
 * blanked to compute the offsets, and `stripCommentsPreservingLayout` keeps the length, so `start`
 * and `end` index the raw text too. Callers that need the text to remain an exact substring of
 * `source` -- `source.replace(slice, '')`, `source.indexOf(slice)` -- must use this variant;
 * a comment-blanked slice is no longer a substring whenever the function contains a comment.
 */
export function extractRawFunctionSlice(source: string, functionDeclaration: string): string {
  const { start, end } = locateFunctionSlice(source, functionDeclaration)
  return source.slice(start, end)
}

interface FunctionSliceLocation {
  /** Index of the declaration in both `source` and `stripped`. */
  start: number
  /** Exclusive end: one past the `}` that closes the function body. */
  end: number
  /** `source` with comments blanked, same length as `source`. */
  stripped: string
}

/** Shared offset computation for `extractFunctionSlice` and `extractRawFunctionSlice`. */
function locateFunctionSlice(source: string, functionDeclaration: string): FunctionSliceLocation {
  const stripped = stripCommentsPreservingLayout(source)
  const start = stripped.indexOf(functionDeclaration)
  if (start === -1) {
    throw new Error(`Function declaration not found: ${functionDeclaration}`)
  }
  const bodyOpen = findFunctionBodyOpen(stripped, start + functionDeclaration.length, functionDeclaration)
  const bodyClose = findMatchingBrace(stripped, bodyOpen)
  if (bodyClose === -1) {
    throw new Error(`Unbalanced braces for function declaration: ${functionDeclaration}`)
  }
  return { start, end: bodyClose + 1, stripped }
}

/** Index just past the quoted string literal that starts at `start`. */
function skipQuotedString(text: string, start: number): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length && text[i] !== quote) {
    if (text[i] === '\\') i++
    i++
  }
  return i + 1
}

/** Index of the `}` matching the `{` at `open`, ignoring braces inside quoted strings. */
function findMatchingBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuotedString(text, i) - 1
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Index of the `{` that opens the body of the function whose declaration ends at
 * `declarationEnd` (immediately after the `(` of its parameter list). Walks the balanced parameter
 * list, then the return-type annotation when there is one. A return type may itself be an object
 * type (`): { acc: number } {`), whose closing brace is followed by the body brace.
 */
function findFunctionBodyOpen(stripped: string, declarationEnd: number, declaration: string): number {
  if (!declaration.endsWith('(')) {
    throw new Error(`Function body not found: ${declaration}`)
  }
  let depth = 1
  let i = declarationEnd
  while (i < stripped.length && depth > 0) {
    const ch = stripped[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuotedString(stripped, i)
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') depth--
    i++
  }
  if (depth !== 0) throw new Error(`Function body not found: ${declaration}`)
  while (i < stripped.length && /\s/.test(stripped[i])) i++
  if (stripped[i] === '{') return i
  if (stripped[i] !== ':') throw new Error(`Function body not found: ${declaration}`)
  i++
  while (i < stripped.length && /\s/.test(stripped[i])) i++
  if (stripped[i] === '{') {
    const typeClose = findMatchingBrace(stripped, i)
    if (typeClose === -1) throw new Error(`Function body not found: ${declaration}`)
    let body = typeClose + 1
    while (body < stripped.length && /\s/.test(stripped[body])) body++
    if (stripped[body] !== '{') throw new Error(`Function body not found: ${declaration}`)
    return body
  }
  const body = stripped.indexOf('{', i)
  if (body === -1) throw new Error(`Function body not found: ${declaration}`)
  return body
}

/**
 * Extracts case 'ABILITY_...' labels from the specified function declaration in source text.
 */
export function extractCaseLabelsFromFunction(source: string, functionDeclaration: string): Set<string> {
  const slice = extractFunctionSlice(source, functionDeclaration)
  const regex = /case\s+['"](ABILITY_[A-Z0-9_]+)['"]/g
  const result = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = regex.exec(slice)) !== null) {
    result.add(match[1])
  }
  if (result.size === 0) {
    throw new Error(`Zero labels extracted for declaration: ${functionDeclaration}`)
  }
  return result
}

export function extractAccuracyAbilities(): Set<string> {
  const content = readFileSync(ACCURACY_PATH, 'utf-8')
  const atk = extractCaseLabelsFromFunction(content, 'export function runAttackerAbilityHook(')
  const def = extractCaseLabelsFromFunction(content, 'export function runDefenderAbilityHook(')
  return new Set([...atk, ...def])
}

export function extractEndTurnAbilities(): Set<string> {
  const content = readFileSync(END_TURN_PATH, 'utf-8')
  return extractCaseLabelsFromFunction(content, 'function runEndTurnAbilities(')
}

export function extractPreemptActionAbilities(): Set<string> {
  const content = readFileSync(PREEMPT_PATH, 'utf-8')
  return extractCaseLabelsFromFunction(content, 'export function tryPreemptiveActions(')
}

export function extractWeatherAbilities(): Set<string> {
  const content = readFileSync(ON_WEATHER_PATH, 'utf-8')
  return extractCaseLabelsFromFunction(content, 'export function dispatchOnWeatherChange(')
}

export function extractTerrainAbilities(): Set<string> {
  const content = readFileSync(ON_WEATHER_PATH, 'utf-8')
  return extractCaseLabelsFromFunction(content, 'export function dispatchOnTerrainChange(')
}

export function extractTargetFlagAbilities(): Set<string> {
  const content = readFileSync(MOVE_TARGET_FLAGS_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'export function getBattlerBattleMoveTargetFlags(')
  const result = new Set<string>()
  const regex = /(?:case\s+|battlerHasSimAbility\([^,]+,\s*[^,]+,\s*)['"](ABILITY_[A-Z0-9_]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(slice)) !== null) {
    // Forecast is checked in getBattlerBattleMoveTargetFlags only as a weather-move user condition (:78),
    // not as an onModifyTargetFlag hook (Forecast has no onModifyTargetFlag hook).
    if (match[1] !== 'ABILITY_FORECAST') {
      result.add(match[1])
    }
  }
  if (result.size === 0) {
    throw new Error('Zero labels extracted for declaration: export function getBattlerBattleMoveTargetFlags(')
  }
  return result
}

export function extractReactiveExtraAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(STAT_BUFFS_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'function runReactiveAbilityEffects(')
  const result = extractComparedAbilityLiterals(slice)
  if (result.size === 0) {
    throw new Error('Zero labels extracted for declaration: function runReactiveAbilityEffects(')
  }
  return result
}

export function extractReviveAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(TURN_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'function latchRecurringNightmareOnFaint(')
  const result = extractComparedAbilityLiterals(slice)
  if (result.size === 0) {
    throw new Error('Zero labels extracted for declaration: function latchRecurringNightmareOnFaint(')
  }
  return result
}

export function extractBattlerFaintsExtraAbilities(): Set<string> {
  const content = readFileSync(MOVE_END_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'function dispatchOnBattlerFaints(')
  const result = extractComparedAbilityLiterals(slice)
  if (result.size === 0) {
    throw new Error('Zero labels extracted for declaration: function dispatchOnBattlerFaints(')
  }
  return result
}

export function extractSimAbsorbExtraAbilities(): Set<string> {
  const content = readFileSync(ABSORB_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'export function applyAbsorbEffect(')
  const result = new Set<string>()
  const regex = /(?:case\s+|absorbingAbility\s*===\s*)['"](ABILITY_[A-Z0-9_]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(slice)) !== null) {
    result.add(match[1])
  }
  if (result.size === 0) {
    throw new Error('Zero labels extracted for declaration: export function applyAbsorbEffect(')
  }
  return result
}

// ---------------------------------------------------------------------------
// Source-text evidence for the hook kinds whose handlers are not `case` switches
// ---------------------------------------------------------------------------

/**
 * Keys of a top-level object literal declaration (`const NAME: T = { ... }`), read from source
 * text. The move-end handlers reach some abilities only through a table indexed by `abilityId`
 * (`ATE_ON_HIT_STATUS[abilityId]`, `CONTACT_COUNTERATTACKS[abilityId]`, ...), so the table's keys
 * are branch evidence just as much as an `if (abilityId === 'X')` comparison.
 */
function extractObjectLiteralKeys(source: string, name: string): Set<string> {
  const declaration = new RegExp(`(?:export\\s+)?const\\s+${escapeRegExp(name)}\\b`).exec(source)
  if (!declaration) throw new Error(`Table declaration not found: ${name}`)
  const equals = source.indexOf('=', declaration.index + declaration[0].length)
  if (equals === -1) throw new Error(`Table initialiser not found: ${name}`)
  const open = source.indexOf('{', equals)
  if (open === -1) throw new Error(`Table body not found: ${name}`)
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end === -1) throw new Error(`Unbalanced table body: ${name}`)
  const body = source.slice(open, end)
  const result = new Set<string>()
  const regex = /^\s*(ABILITY_[A-Z0-9_]+)\s*:/gm
  let match: RegExpExecArray | null
  while ((match = regex.exec(body)) !== null) {
    result.add(match[1])
  }
  return result
}

/**
 * The logical statement that contains `index`: walks back over continuation lines (a line ending
 * in an operator, or a comment/blank line) so a multi-line `if (` condition and a `return`
 * expression are not mistaken for each other. Semicolon-free code makes a plain "last `;`/`{`"
 * boundary wrong.
 */
function statementTextBefore(slice: string, index: number): string {
  let start = slice.lastIndexOf('\n', index) + 1
  while (start > 0) {
    const previousEnd = start - 1 // the newline character
    const previousStart = slice.lastIndexOf('\n', previousEnd - 1) + 1
    const previousLine = slice.slice(previousStart, previousEnd).trim()
    const isComment = previousLine.startsWith('//') || previousLine.startsWith('*') || previousLine.startsWith('/*')
    if (previousLine === '' || isComment || /[&|(,?:=+\-*/]$/.test(previousLine)) {
      start = previousStart
      continue
    }
    break
  }
  return slice.slice(start, index)
}

/**
 * Ability ids passed to `battlerHasSimAbility(...)` in a branch that makes the enclosing flag
 * predicate answer true: `if (... battlerHasSimAbility(...)) { return true }` or
 * `return <condition> && battlerHasSimAbility(...)`. Calls that are only used to raise a gap note
 * do neither, so a generic "this holder has a move-flag ability" loop is not evidence.
 */
function extractReturnedAbilityIds(slice: string): Set<string> {
  const result = new Set<string>()
  const callRegex = /battlerHasSimAbility\(([^()]*)\)/g
  let call: RegExpExecArray | null
  while ((call = callRegex.exec(slice)) !== null) {
    const literal = /['"](ABILITY_[A-Z0-9_]+)['"]/.exec(call[1])
    if (!literal) continue
    const start = call.index
    const end = call.index + call[0].length
    // `return moveData.split === 'STATUS' && battlerHasSimAbility(...)`
    if (/^\s*return\b/.test(statementTextBefore(slice, start))) {
      result.add(literal[1])
      continue
    }
    // `if (... battlerHasSimAbility(...)) { return true }`
    const tail = slice.slice(end, end + 200)
    if (/^[^;{}]*\)\s*\{\s*return true\b/.test(tail)) result.add(literal[1])
  }
  return result
}

/**
 * The ability ids the sim really branches on inside `canPoisonType` and `canParalyzeType`
 * (`web/src/engine/sim/statusEffects.ts`): every quoted `ABILITY_...` literal in those two
 * functions, including the array literal in the CanPoisonType bypass loop and the Angel's Wrath
 * `MOVE_POISON_STING` branch.
 */
export function extractCanStatusTypeAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(STATUS_EFFECTS_PATH, 'utf-8')
  const result = new Set<string>()
  for (const declaration of ['export function canPoisonType(', 'export function canParalyzeType(']) {
    const slice = extractFunctionSlice(content, declaration)
    const regex = /['"](ABILITY_[A-Z0-9_]+)['"]/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(slice)) !== null) {
      result.add(match[1])
    }
  }
  if (result.size === 0) {
    throw new Error('Zero ability ids extracted from canPoisonType/canParalyzeType')
  }
  return result
}

/** The ability ids `getMoveEffectChance` compares with `abilityId === ...` in its dispatch body. */
export function extractModifyEffectChanceAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(STATUS_EFFECTS_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'export function getMoveEffectChance(')
  const result = extractComparedAbilityLiterals(slice)
  if (result.size === 0) {
    throw new Error('Zero ability comparisons extracted from getMoveEffectChance')
  }
  return result
}

/**
 * The onReactive ported set: the abilities the reactive dispatcher really handles. That is every
 * ability compared in `runReactiveAbilityEffects`, plus the intersection of the gate set
 * `POISON_PUPPETEER_CLONE_ABILITIES` with the ids that appear as `case 'ABILITY_X'` labels inside
 * `runPoisonPuppeteerClone`. The gate set alone is not evidence -- a mutation that deletes a case
 * block must drop the ability, otherwise the dispatcher's real shape is not what is being measured.
 * Blood Bath, Cryostasis, Chokehold, Entrance, Neurotoxin, Poison Puppeteer and Set Ablaze each have
 * a `case` label. Frostbind and Hemotoxin are in the gate set but have no label (they are handled by
 * the `abilityId ===` branch that only pushes a note), so they never enter this set; NOTE_ONLY_SET
 * still removes any note-only pair during classification.
 */
export function extractReactiveAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(STAT_BUFFS_PATH, 'utf-8')
  const cloneHandled = extractCaseLabelsFromFunction(content, 'function runPoisonPuppeteerClone(')
  const cloneAbilities = [...POISON_PUPPETEER_CLONE_ABILITIES].filter((id) => cloneHandled.has(id))
  return new Set<string>([...cloneAbilities, ...extractReactiveExtraAbilities(content)])
}

/**
 * Ability ids the attacker move-end handler actually branches on:
 * `abilityId === 'ABILITY_X'` comparisons in `handleAttackerMoveEndAbility`, the keys of the
 * ability-keyed tables it indexes with `[abilityId]` (`ATE_ON_HIT_STATUS`,
 * `ON_EITHER_CONTACT_STATUS`; both carry the aliases the handler dispatches to, e.g. Spectral
 * Shroud's row is `ABILITY_SPECTRALIZE`), and the compared `ABILITY_SPECTRAL_SHROUD` id itself.
 */
export function extractAttackerBranchAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(MOVE_END_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'function handleAttackerMoveEndAbility(')
  const result = extractComparedAbilityLiterals(slice)
  for (const id of extractObjectLiteralKeys(content, 'ATE_ON_HIT_STATUS')) result.add(id)
  for (const id of extractObjectLiteralKeys(content, 'ON_EITHER_CONTACT_STATUS')) result.add(id)
  if (result.size === 0) {
    throw new Error('Zero ability branches extracted from handleAttackerMoveEndAbility')
  }
  return result
}

/**
 * Ability ids the defender move-end handler actually branches on: `abilityId === 'ABILITY_X'`
 * comparisons in `handleDefenderMoveEndAbility` plus the keys of the two tables it indexes with
 * `[abilityId]` (`CONTACT_COUNTERATTACKS`, `ON_EITHER_CONTACT_STATUS`).
 */
export function extractDefenderBranchAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(MOVE_END_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'function handleDefenderMoveEndAbility(')
  const result = extractComparedAbilityLiterals(slice)
  for (const id of extractObjectLiteralKeys(content, 'CONTACT_COUNTERATTACKS')) result.add(id)
  for (const id of extractObjectLiteralKeys(content, 'ON_EITHER_CONTACT_STATUS')) result.add(id)
  if (result.size === 0) {
    throw new Error('Zero ability branches extracted from handleDefenderMoveEndAbility')
  }
  return result
}

/**
 * The onRecoil abilities the MOVEEND_RECOIL loop really computes a recoil amount for: the ids
 * that are keys of both `ON_RECOIL_TYPES` (the type gate) and `ON_RECOIL_DIVISORS` (the damage
 * divisor), intersected with the loop's gate list `ON_RECOIL_ABILITIES`, and only while
 * `runMoveEnd` still reads both tables in its loop body. A key present in only one table either
 * skips every type or divides by `undefined`, so it is not ported; a gutted loop that no longer
 * reads the tables leaves the set empty.
 */
export function extractRecoilAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(MOVE_END_PATH, 'utf-8')
  const types = extractObjectLiteralKeys(content, 'ON_RECOIL_TYPES')
  const divisors = extractObjectLiteralKeys(content, 'ON_RECOIL_DIVISORS')
  const result = new Set<string>([...types].filter((id) => divisors.has(id) && ON_RECOIL_ABILITIES.includes(id)))
  if (result.size === 0) {
    throw new Error('Zero onRecoil abilities present in both ON_RECOIL_TYPES and ON_RECOIL_DIVISORS')
  }
  // `ON_RECOIL_TYPES[abilityId]` also appears in the `onRecoilHolders.some(...)` pre-check above the
  // loop, so anchor on the loop's own `const types = ...` read; otherwise deleting the loop's type
  // read would still look present.
  const slice = extractFunctionSlice(content, 'export function runMoveEnd(')
  if (!slice.includes('const types = ON_RECOIL_TYPES[abilityId]') || !slice.includes('ON_RECOIL_DIVISORS[abilityId]')) {
    return new Set()
  }
  return result
}

export type MoveFlagFamily = 'punch' | 'kick' | 'sound' | 'dance' | 'keenEdge' | 'megaLauncher'

/**
 * The MOVE_FLAG_* families each `onModifyMoveFlags` hook grants, transcribed from
 * `pipeline/.upstream/eliteredux-source/src/abilities.cc` at the pinned SHA. One hook can grant
 * more than one family (Junshi Sanda swaps PUNCH and KICK, Festivities swaps DANCE and SOUND,
 * Backstreet Boy swaps KICK and DANCE), which is why the classifier checks every family.
 *
 * C lines: Brawling Wyvern :7603-7610, Junshi Sanda :7613-7622, Mixed Martial Arts :9898-9905,
 * Gunman :9535-9540, Festivities :10194-10203, Reverbate :10657-10662, Taekkyeon :10666-10671,
 * Backstreet Boy :11570-11583, Chestnut Axe :11709-11712, Musical Notes :11988-11992.
 */
export const MODIFY_MOVE_FLAGS_GRANTS: Record<string, readonly MoveFlagFamily[]> = {
  ABILITY_BRAWLING_WYVERN: ['punch'], // PUNCH on Dragon moves
  ABILITY_JUNSHI_SANDA: ['punch', 'kick'], // PUNCH on kick moves, KICK on punch moves
  ABILITY_MIXED_MARTIAL_ARTS: ['punch', 'kick'], // both on Normal-type moves
  ABILITY_GUNMAN: ['megaLauncher'], // MEGA_LAUNCHER on status moves
  ABILITY_FESTIVITIES: ['dance', 'sound'], // DANCE on sound moves, SOUND on dance moves
  ABILITY_REVERBATE: ['sound'], // SOUND on Normal-type moves
  ABILITY_TAEKKYEON: ['dance'], // DANCE on non-status moves
  ABILITY_BACKSTREET_BOY: ['kick', 'dance'], // KICK on dance moves, DANCE on kick moves
  ABILITY_CHESTNUT_AXE: ['keenEdge'], // KEEN_EDGE on Grass moves
  ABILITY_MUSICAL_NOTES: ['sound'], // SOUND on status moves
}

/**
 * The sim predicate that answers `DoesMoveMatchFlag(... family)` and the file it lives in.
 * `null` means the sim has no predicate for that family at all: PUNCH is only reachable through
 * the damage engine's registry hooks (`isIronFistBoosted` in abilities/dispatchCalc.ts), which is
 * not a returning-true sim branch, so a hook that grants PUNCH cannot be counted as ported.
 */
const MOVE_FLAG_PREDICATES: Record<
  MoveFlagFamily,
  { file: 'statusEffects' | 'moveEnd' | 'moveTargetFlags'; declaration: string } | null
> = {
  punch: null,
  kick: { file: 'statusEffects', declaration: 'export function isStrikerMove(' },
  sound: { file: 'statusEffects', declaration: 'export function isSoundMove(' },
  dance: { file: 'moveEnd', declaration: 'export function isDanceMove(' },
  keenEdge: { file: 'statusEffects', declaration: 'export function isKeenEdgeMove(' },
  megaLauncher: { file: 'moveTargetFlags', declaration: 'export function isMegaLauncherBoostedMove(' },
}

export interface ModifyMoveFlagsSources {
  statusEffects?: string
  moveEnd?: string
  moveTargetFlags?: string
}

/**
 * The ability ids a flag predicate returns `true` for. A declaration with no returning-true branch
 * yields the empty set: deleting the only branch is evidence the family is unported, not a reason
 * to crash every importer of the pinned `PORTED_*` sets. Only a missing declaration throws, via
 * `extractFunctionSlice`.
 */
export function extractMoveFlagPredicateAbilities(source: string, declaration: string): Set<string> {
  const slice = extractFunctionSlice(source, declaration)
  return extractReturnedAbilityIds(slice)
}

/**
 * The move-flag families whose damage/immunity *consumers* read the sim predicate instead of the
 * static move flag. Empty: the predicates mention the abilities, but Soundproof / Punk Rock /
 * Amplifier still test `moveFlags.sound`, and the damage engine never applies Keen Edge's or
 * Striker's multiplier through `isKeenEdgeMove` / `isStrikerMove`, so no family is wired end to end.
 * A later cycle that ports those consumers adds the families here; until then every
 * onModifyMoveFlags pair stays unported.
 */
export const MOVE_FLAG_CONSUMERS_WIRED: readonly MoveFlagFamily[] = []

/**
 * The onModifyMoveFlags abilities whose every C-granted flag family is both wired into its consumer
 * (`consumersWired`, `MOVE_FLAG_CONSUMERS_WIRED` by default) and has a returning-true sim branch in
 * the matching predicate. An ability whose hook grants a family the sim has no predicate for (PUNCH
 * today) is not ported, and neither is one whose branch condition differs from the C. `consumersWired`
 * is a parameter so tests can exercise the gate without changing the module constant.
 */
export function extractModifyMoveFlagsAbilities(
  sources: ModifyMoveFlagsSources = {},
  consumersWired: readonly MoveFlagFamily[] = MOVE_FLAG_CONSUMERS_WIRED,
): Set<string> {
  const contents: Record<'statusEffects' | 'moveEnd' | 'moveTargetFlags', string> = {
    statusEffects: sources.statusEffects ?? readFileSync(STATUS_EFFECTS_PATH, 'utf-8'),
    moveEnd: sources.moveEnd ?? readFileSync(MOVE_END_PATH, 'utf-8'),
    moveTargetFlags: sources.moveTargetFlags ?? readFileSync(MOVE_TARGET_FLAGS_PATH, 'utf-8'),
  }
  const perFamily = new Map<MoveFlagFamily, Set<string>>()
  for (const family of Object.keys(MOVE_FLAG_PREDICATES) as MoveFlagFamily[]) {
    const predicate = MOVE_FLAG_PREDICATES[family]
    if (!predicate) continue
    perFamily.set(family, extractMoveFlagPredicateAbilities(contents[predicate.file], predicate.declaration))
  }
  const result = new Set<string>()
  for (const [id, flags] of Object.entries(MODIFY_MOVE_FLAGS_GRANTS)) {
    if (flags.every((family) => consumersWired.includes(family) && perFamily.get(family)?.has(id) === true)) {
      result.add(id)
    }
  }
  return result
}

/**
 * `'ABILITY_...'` literals that the code *branches* on: `case 'ABILITY_X':` labels and positive
 * equality comparisons against an ability variable (`abilityId === 'X'`, `slotAbility == 'X'`).
 * Bare literals that are arguments, array elements or map values are deliberately not evidence: the
 * Wind Rider branch passes `'ABILITY_WIND_RIDER'` to `disableSwitchInAbility` from the Air Blower
 * branch, so accepting argument literals kept Wind Rider "ported" after its own branch was deleted.
 * Inequality comparisons are not evidence either: the Trace exclusion `abilityId !== 'ABILITY_TRACE'`
 * in switchInAbility.ts mirrors the C's exemption (battle_util.c:9189-9195), not a Trace port, and it
 * kept Trace "ported" after its own branch was deleted.
 */
function extractComparedAbilityLiterals(slice: string): Set<string> {
  const regex = /(?:case\s+|(?:abilityId|slotAbility|currentAbility)\s*(?:===|==)\s*)['"](ABILITY_[A-Z0-9_]+)['"]/g
  const result = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = regex.exec(slice)) !== null) {
    result.add(match[1])
  }
  return result
}

/** The declaration text for a top-level function in `content`, or null if it is imported. */
function findFunctionDeclaration(content: string, name: string): string | null {
  const match = new RegExp(`(?:export\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`).exec(content)
  return match ? match[0] : null
}

export function extractTrapAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(ESCAPE_PATH, 'utf-8')
  return extractCaseLabelsFromFunction(content, 'function onTrap(')
}

export function extractBlockStatDropAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(STAT_BUFFS_PATH, 'utf-8')
  return extractCaseLabelsFromFunction(content, 'function statDropBlockForAbility(')
}

export function extractSwitchOutAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(TURN_PATH, 'utf-8')
  return extractCaseLabelsFromFunction(content, 'export function dispatchSwitchOutAbilities(')
}

/**
 * Derives the onEntry handler set from the dispatcher itself: the map tables it
 * consults plus every ability *comparison* or `case` label in `applySwitchInAbilities`
 * and the same-file helpers it calls (transitively).
 *
 * `source` defaults to the live `switchInAbility.ts`; tests pass a mutated copy.
 */
export function extractSwitchInAbilities(source?: string): Set<string> {
  const content = source ?? readFileSync(SWITCH_IN_PATH, 'utf-8')
  const result = new Set<string>([
    ...Object.keys(WEATHER_SETTER_MAP),
    ...Object.keys(TERRAIN_SETTER_MAP),
    ...Object.keys(PORTED_ENTRY_MOVE_MAP),
    ...Object.keys(INTIMIDATE_CLONE_MAP),
    ...Object.keys(ADD_TYPE_ON_ENTRY),
    ...ANNOUNCE_ONLY_ON_ENTRY,
  ])

  let comparisonCount = 0
  const visitedDeclarations = new Set<string>()
  const queue = ['export function applySwitchInAbilities(']
  while (queue.length > 0) {
    const declaration = queue.pop()!
    if (visitedDeclarations.has(declaration)) continue
    visitedDeclarations.add(declaration)
    const slice = extractFunctionSlice(content, declaration)
    const compared = extractComparedAbilityLiterals(slice)
    comparisonCount += compared.size
    for (const id of compared) result.add(id)

    const callRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    let call: RegExpExecArray | null
    while ((call = callRegex.exec(slice)) !== null) {
      const helperDeclaration = findFunctionDeclaration(content, call[1])
      if (helperDeclaration) queue.push(helperDeclaration)
    }
  }
  if (comparisonCount === 0) {
    throw new Error('Zero labels extracted for declaration: export function applySwitchInAbilities(')
  }
  return result
}

// ---------------------------------------------------------------------------
// Note-only raise sites (discovered from the sim source text)
// ---------------------------------------------------------------------------

export interface NoteOnlyRaiseSite {
  ability: string
  /** Repo-relative path, matching the `site` field of NOTE_ONLY_PAIRS (minus its display line). */
  file: string
  /** 1-based line of the note text. */
  line: number
  note: string
}

/** The three files whose note-only ability branches NOTE_ONLY_PAIRS covers. */
export const NOTE_ONLY_SCANNED_FILES: ReadonlyArray<{ file: string; path: string }> = [
  { file: 'web/src/engine/sim/moveEnd.ts', path: MOVE_END_PATH },
  { file: 'web/src/engine/sim/turn.ts', path: TURN_PATH },
  { file: 'web/src/engine/sim/statBuffs.ts', path: STAT_BUFFS_PATH },
]

const ABILITY_TEST_PATTERNS: readonly RegExp[] = [
  /case\s+['"](ABILITY_[A-Z0-9_]+)['"]/g,
  /(?:abilityId|slotAbility|currentAbility)\s*(?:===|==)\s*['"](ABILITY_[A-Z0-9_]+)['"]/g,
]

/** Every ability id a single line tests or labels (`case 'X':`, `abilityId === 'X'`, `||` chains). */
function abilityTestsOnLine(line: string): string[] {
  const ids = new Set<string>()
  for (const regex of ABILITY_TEST_PATTERNS) {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(line)) !== null) ids.add(match[1])
  }
  return [...ids]
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/** Replaces string and template literals with `''` so their contents cannot look like code. */
function stripStringLiterals(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++
        i++
      }
      i++ // closing quote
      out += "''"
    } else {
      out += ch
      i++
    }
  }
  return out
}

/**
 * Blanks `//` line comments and `/* ... *​/` block comments with spaces, keeping the string's
 * length and every newline so offsets still line up with the raw text. Quoted strings are skipped,
 * so a `//` inside a URL is not a comment; string literals themselves are kept so callers can still
 * match `'ABILITY_X'`.
 */
function stripCommentsPreservingLayout(text: string): string {
  const out = text.split('')
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuotedString(text, i)
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        out[i] = ' '
        i++
      }
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] !== '\n') out[i] = ' '
        i++
      }
      if (i < text.length) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    i++
  }
  return out.join('')
}

/** Removes `name( ... )` calls with balanced parentheses. */
function removeBalancedCalls(text: string, name: string): string {
  let out = text
  let from = 0
  for (;;) {
    const start = out.indexOf(`${name}(`, from)
    if (start === -1) return out
    let depth = 0
    let end = -1
    for (let i = start + name.length; i < out.length; i++) {
      if (out[i] === '(') depth++
      else if (out[i] === ')') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end === -1) return out
    out = out.slice(0, start) + out.slice(end)
    from = start
  }
}

/** Removes local `const NAME = ...` declarations (semicolon-free style: the statement ends at a
 * newline once brackets balance and the line does not end in a continuation operator). */
function removeConstDeclarations(text: string): string {
  let out = text
  let from = 0
  const keyword = /\bconst\s+/g
  for (;;) {
    keyword.lastIndex = from
    const match = keyword.exec(out)
    if (!match) return out
    const start = match.index
    let i = match.index + match[0].length
    while (i < out.length && /[\w$]/.test(out[i])) i++ // declaration name
    while (i < out.length && /\s/.test(out[i])) i++
    if (out[i] === ':') {
      while (i < out.length && out[i] !== '=' && out[i] !== '\n') i++ // type annotation
      while (i < out.length && /\s/.test(out[i])) i++
    }
    if (out[i] !== '=') {
      from = start + match[0].length // `for (const x of ...)` and the like: leave it alone
      continue
    }
    let depth = 0
    let end = out.length
    for (i++; i < out.length; i++) {
      const ch = out[i]
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
      else if (depth === 0 && ch === ';') {
        end = i + 1
        break
      } else if (depth === 0 && ch === '\n') {
        const before = out.slice(start, i).trimEnd()
        if (!/[=(,[{?:&|+\-*/]$/.test(before)) {
          end = i
          break
        }
      }
    }
    out = out.slice(0, start) + out.slice(end)
    from = start
  }
}

/** Removes the parenthesised condition of every `if`/`for`/`while`/`switch`. */
function removeControlFlowConditions(text: string): string {
  let out = text
  let from = 0
  const keyword = /\b(?:if|for|while|switch)\s*\(/g
  for (;;) {
    keyword.lastIndex = from
    const match = keyword.exec(out)
    if (!match) return out
    const open = match.index + match[0].length - 1
    let depth = 0
    let end = -1
    for (let i = open; i < out.length; i++) {
      if (out[i] === '(') depth++
      else if (out[i] === ')') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    if (end === -1) return out
    out = out.slice(0, open) + out.slice(end)
    from = match.index
  }
}

/**
 * True when a branch body does nothing but raise an unmodelled note and control its own flow:
 * after removing comments, strings, note pushes, local `const` declarations and `if`/`for`
 * conditions, only `break`/`continue`/`return true|false`/punctuation may remain.
 *
 * This is what separates a note-only branch (Generator's switch-out counter) from a real port
 * that also happens to raise a note (Patchwork's onDefender, Angel's Wrath's move cases).
 */
export function isNoteOnlyBranchBody(body: string): boolean {
  let rest = body
    .split('\n')
    .map((line) => {
      const commentAt = line.indexOf('//')
      return commentAt === -1 ? line : line.slice(0, commentAt)
    })
    .join('\n')
  rest = stripStringLiterals(rest)
  rest = removeBalancedCalls(rest, 'unmodelled.push')
  rest = removeBalancedCalls(rest, 'unmodelled.includes')
  rest = removeConstDeclarations(rest)
  rest = removeControlFlowConditions(rest)
  rest = rest
    .replace(/\b(?:if|for|while|switch|else|break|continue)\b/g, '')
    .replace(/\breturn\s+(?:true|false)\b/g, '')
    .replace(/[{}[\]();]/g, '')
    .replace(/\s+/g, '')
  return rest.length === 0
}

/**
 * Every raise site of a `... is not modelled` note that sits inside a note-only, ability-keyed
 * branch (nearest enclosing `case 'ABILITY_X':` / `abilityId === 'ABILITY_X'` test, `||` chains
 * returning every id on it). Comment lines are skipped; branches with real effects are not
 * reported. `sources` defaults to the live sim files; tests pass mutated copies.
 */
export function discoverNoteOnlyRaiseSites(
  sources: ReadonlyArray<{ file: string; content: string }> = NOTE_ONLY_SCANNED_FILES.map((f) => ({
    file: f.file,
    content: readFileSync(f.path, 'utf-8'),
  })),
): NoteOnlyRaiseSite[] {
  const sites: NoteOnlyRaiseSite[] = []
  for (const { file, content } of sources) {
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      if (!trimmed.includes('is not modelled')) continue

      const noteIndent = indentOf(line)
      for (let j = i - 1; j >= 0; j--) {
        const candidate = lines[j]
        if (!candidate.trim()) continue
        const candidateIndent = indentOf(candidate)
        if (candidateIndent >= noteIndent) continue
        const abilities = abilityTestsOnLine(candidate)
        if (abilities.length === 0) continue
        // The candidate's block must still be open at the note: every line between them is deeper.
        let encloses = true
        for (let k = j + 1; k < i; k++) {
          if (lines[k].trim() && indentOf(lines[k]) <= candidateIndent) {
            encloses = false
            break
          }
        }
        if (!encloses) continue

        const bodyLines: string[] = []
        for (let k = j + 1; k < lines.length; k++) {
          if (lines[k].trim() && indentOf(lines[k]) <= candidateIndent) break
          bodyLines.push(lines[k])
        }
        if (!isNoteOnlyBranchBody(bodyLines.join('\n'))) break

        for (const ability of abilities) {
          sites.push({ ability, file, line: i + 1, note: trimmed })
        }
        break
      }
    }
  }
  return sites
}

// ---------------------------------------------------------------------------
// Sim-side sets (extracted dynamically)
// ---------------------------------------------------------------------------

export const PORTED_ACCURACY_ABILITIES = extractAccuracyAbilities()
export const PORTED_END_TURN_ABILITIES = extractEndTurnAbilities()
export const PORTED_BATTLER_FAINTS_ABILITIES = new Set<string>([
  ...extractBattlerFaintsExtraAbilities(),
  ...SET_STATE_ON_EFFECT_ABILITIES,
  ...Object.keys(KO_STAT_RAISES),
  ...KO_SOUL_EATER_ABILITIES,
  ...KO_JAWS_OF_CARNAGE_ABILITIES,
  ...KO_CRIT_BOOST_ABILITIES,
])
export const PORTED_PREEMPT_ACTION_ABILITIES = extractPreemptActionAbilities()
export const PORTED_WEATHER_ABILITIES = extractWeatherAbilities()
export const PORTED_TERRAIN_ABILITIES = extractTerrainAbilities()
export const PORTED_TARGET_FLAG_ABILITIES = extractTargetFlagAbilities()
export const PORTED_REACTIVE_ABILITIES = extractReactiveAbilities()
export const PORTED_REVIVE_ABILITIES = extractReviveAbilities()
export const PORTED_SIM_ABSORB_ABILITIES = new Set<string>([
  ...HEAL_ABSORB_ABILITIES,
  ...STAT_ABSORB_ABILITIES,
  ...extractSimAbsorbExtraAbilities(),
])

export const PORTED_STATUS_IMMUNE_ABILITIES = new Set(OWN_STATUS_IMMUNE_CONDITIONS.map((c) => c.ability))
export const PORTED_BLOCK_STAT_DROP_ABILITIES_SET = extractBlockStatDropAbilities()
export const PORTED_STAT_LOWERED_ABILITIES = new Set<string>(Object.keys(ON_STAT_LOWERED_HOOKS))
export const PORTED_TRAP_ABILITIES_SET = extractTrapAbilities()
export const PORTED_SWITCH_OUT_ABILITIES_SET = extractSwitchOutAbilities()
export const PORTED_SWITCH_IN_ABILITIES = extractSwitchInAbilities()
export const PORTED_RECOIL_ABILITIES_SET = extractRecoilAbilities()
/** Branch evidence on each side of the move-end handlers (see the extractors above). */
export const PORTED_ATTACKER_BRANCH_ABILITIES = extractAttackerBranchAbilities()
export const PORTED_DEFENDER_BRANCH_ABILITIES = extractDefenderBranchAbilities()
export const PORTED_CAN_STATUS_TYPE_ABILITIES = extractCanStatusTypeAbilities()
export const PORTED_MODIFY_EFFECT_CHANCE_ABILITIES = extractModifyEffectChanceAbilities()
export const PORTED_MODIFY_MOVE_FLAGS_ABILITIES = extractModifyMoveFlagsAbilities()

const CALC_HOOKS = new Set<HookKind>([
  'onOffensiveMultiplier',
  'onDefensiveMultiplier',
  'onStat',
  'onStab',
  'onCrit',
  'onTypeEffectiveness',
  'onAfterTypeEffectiveness',
  'onChooseOffensiveStat',
  'onChooseDefensiveStat',
  'onSwapSplit',
  'onMoveType',
  'onRecoil',
  'onPriority',
  'onMoldBreaker',
  'onParentalBond',
  'onAbsorb',
  'onImmune',
  'onInfiltrate',
])

// ---------------------------------------------------------------------------
// Pure classification logic
// ---------------------------------------------------------------------------

export interface ClassificationContext {
  lookup: (id: string) => AbilityEntry | undefined
}

export function defaultLookup(id: string): AbilityEntry | undefined {
  return lookupAbility(id)
}

/**
 * Checks whether an ability has a direct port for a hook kind (without alias resolution).
 */
export function isDirectlyPorted(
  abilityId: string,
  hookKind: HookKind,
  ctx: ClassificationContext = { lookup: defaultLookup },
): boolean {
  if (NOTE_ONLY_SET.has(`${abilityId}:${hookKind}`)) {
    return false
  }

  if (CALC_HOOKS.has(hookKind)) {
    const entry = ctx.lookup(abilityId)
    if (entry && !isUnmodelled(entry) && typeof (entry as unknown as Record<string, unknown>)[hookKind] === 'function') {
      return true
    }
    // Sibling sim checks for hooks that also have sim-side lists
    if (hookKind === 'onAbsorb' && PORTED_SIM_ABSORB_ABILITIES.has(abilityId)) return true
    if (hookKind === 'onRecoil' && PORTED_RECOIL_ABILITIES_SET.has(abilityId)) return true
    return false
  }

  switch (hookKind) {
    case 'onAttacker':
      return PORTED_ATTACKER_ABILITIES.has(abilityId) && PORTED_ATTACKER_BRANCH_ABILITIES.has(abilityId)
    case 'onDefender':
      return PORTED_DEFENDER_ABILITIES.has(abilityId) && PORTED_DEFENDER_BRANCH_ABILITIES.has(abilityId)
    case 'onEntry':
      return PORTED_SWITCH_IN_ABILITIES.has(abilityId)
    case 'onEndTurn':
      return PORTED_END_TURN_ABILITIES.has(abilityId)
    case 'onAccuracy':
      return PORTED_ACCURACY_ABILITIES.has(abilityId)
    case 'onBattlerFaints':
      return PORTED_BATTLER_FAINTS_ABILITIES.has(abilityId)
    case 'onBeforeAttack':
      return false
    case 'onBlockStatDrops':
      return PORTED_BLOCK_STAT_DROP_ABILITIES_SET.has(abilityId)
    case 'onCanStatusType':
      return PORTED_CAN_STATUS_TYPE_ABILITIES.has(abilityId)
    case 'onCopyMove':
      return false
    case 'onDisguise':
      return false
    case 'onExit':
      return PORTED_SWITCH_OUT_ABILITIES_SET.has(abilityId)
    case 'onModifyEffectChance':
      return PORTED_MODIFY_EFFECT_CHANCE_ABILITIES.has(abilityId)
    case 'onModifyMoveFlags':
      // Empty while MOVE_FLAG_CONSUMERS_WIRED is empty, i.e. false for all 10 pairs. A predicate
      // mentioning the ability is not a port: the damage/immunity consumers still read static flags.
      return PORTED_MODIFY_MOVE_FLAGS_ABILITIES.has(abilityId)
    case 'onModifyTargetFlag':
      return PORTED_TARGET_FLAG_ABILITIES.has(abilityId)
    case 'onPreemptAction':
      return PORTED_PREEMPT_ACTION_ABILITIES.has(abilityId)
    case 'onReactive':
      return PORTED_REACTIVE_ABILITIES.has(abilityId)
    case 'onRevive':
      return PORTED_REVIVE_ABILITIES.has(abilityId)
    case 'onStatLowered':
      return PORTED_STAT_LOWERED_ABILITIES.has(abilityId)
    case 'onStatusImmune':
      return PORTED_STATUS_IMMUNE_ABILITIES.has(abilityId)
    case 'onTerrain':
      return PORTED_TERRAIN_ABILITIES.has(abilityId)
    case 'onTrap':
      return PORTED_TRAP_ABILITIES_SET.has(abilityId)
    case 'onWeather':
      return PORTED_WEATHER_ABILITIES.has(abilityId)
    default:
      return false
  }
}

/**
 * Classifies an (ability, hook) pair with transitive alias resolution.
 */
export function classifyPair(
  abilityId: string,
  hookKind: HookKind,
  abilityHooksData: Record<string, AbilityHookRecord>,
  ctx: ClassificationContext = { lookup: defaultLookup },
): ClassificationStatus {
  if (isDirectlyPorted(abilityId, hookKind, ctx)) {
    return 'ported'
  }

  // Follow alias only if a dispatcher allowance permits it for this hook kind
  const allowance = HOOK_ALIAS_RESOLVER_ALLOWANCES.find((a) => a.hook === hookKind)
  if (!allowance) {
    return 'unported'
  }

  // Follow alias chain transitively
  const visited = new Set<string>()
  let currId = abilityId
  let currHook: string = hookKind

  while (true) {
    const key = `${currId}:${currHook}`
    if (visited.has(key)) break
    visited.add(key)

    const hookObj = abilityHooksData[currId]?.hooks?.[currHook]
    if (hookObj?.form === 'alias' && hookObj.aliasTarget && hookObj.aliasHook) {
      currId = hookObj.aliasTarget
      currHook = hookObj.aliasHook
      if (HOOK_KINDS.includes(currHook as HookKind)) {
        if (isDirectlyPorted(currId, currHook as HookKind, ctx)) {
          return 'ported'
        }
      }
    } else {
      break
    }
  }

  return 'unported'
}

/**
 * Scans test files under engine/ and returns a Set of mentioned ability ids.
 */
export function loadTestMentionedAbilities(engineDir: string): Set<string> {
  const mentioned = new Set<string>()
  const files: string[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.test.ts') && entry !== 'abilityHookInventory.test.ts') {
        files.push(full)
      }
    }
  }

  walk(engineDir)
  const allText = files.map((f) => readFileSync(f, 'utf-8')).join('\n')

  const matches = allText.match(/\bABILITY_[A-Z0-9_]+\b/g)
  if (matches) {
    for (const id of matches) mentioned.add(id)
  }
  return mentioned
}

/**
 * Evaluates the full inventory across all abilities in abilityHooks.json.
 */
export function runInventory(
  abilityHooksData: Record<string, AbilityHookRecord>,
  testMentionedAbilities: Set<string> = new Set(),
  allowlist: ReadonlyArray<AllowlistEntry> = [],
  ctx: ClassificationContext = { lookup: defaultLookup },
): InventoryResult {
  const allowlistMap = new Set(allowlist.map((a) => `${a.ability}:${a.hook}`))
  const classifications: PairClassification[] = []
  const summaryByHook = new Map<HookKind, HookKindSummary>()

  for (const hook of HOOK_KINDS) {
    summaryByHook.set(hook, {
      hook,
      defined: 0,
      ported: 0,
      allowlisted: 0,
      unported: 0,
      unclassified: 0,
      tested: 0,
      abilityMentionedInTests: 0,
    })
  }

  const sortedAbilityIds = Object.keys(abilityHooksData).sort()

  for (const id of sortedAbilityIds) {
    const rec = abilityHooksData[id]
    if (!rec.hooks) continue
    const definedHooks = Object.keys(rec.hooks).filter((h): h is HookKind => HOOK_KINDS.includes(h as HookKind)).sort()

    for (const hook of definedHooks) {
      const isAllowed = allowlistMap.has(`${id}:${hook}`)
      let status = classifyPair(id, hook, abilityHooksData, ctx)
      if (isAllowed && status === 'unported') {
        status = 'allowlisted' // allowlisted pair shown separately
      }

      const tested = testMentionedAbilities.has(id)
      const summary = summaryByHook.get(hook)!
      summary.defined++
      if (status === 'ported') summary.ported++
      else if (status === 'allowlisted') summary.allowlisted++
      else if (status === 'unported') summary.unported++
      else summary.unclassified++
      if (tested) {
        summary.tested++
        summary.abilityMentionedInTests++
      }

      classifications.push({
        ability: id,
        hook,
        status,
        sourceLine: rec.sourceLine,
        tested,
        abilityMentionedInTest: tested,
      })
    }
  }

  const summaries = HOOK_KINDS.map((h) => summaryByHook.get(h)!)
  const totalDefined = summaries.reduce((acc, s) => acc + s.defined, 0)
  const totalPorted = summaries.reduce((acc, s) => acc + s.ported, 0)
  const totalAllowlisted = summaries.reduce((acc, s) => acc + s.allowlisted, 0)
  const totalUnported = summaries.reduce((acc, s) => acc + s.unported, 0)
  const totalUnclassified = summaries.reduce((acc, s) => acc + s.unclassified, 0)
  const totalTested = summaries.reduce((acc, s) => acc + s.tested, 0)
  const totalAbilityMentionedInTests = summaries.reduce((acc, s) => acc + s.abilityMentionedInTests, 0)
  const unportedPairs = classifications.filter((c) => c.status === 'unported')
  // An allowlist entry only means anything if it covers a real, still-unported pair: a pair the
  // hook data does not define, or one the classifier already calls ported, grants nothing.
  const statusByPair = new Map(classifications.map((c) => [`${c.ability}:${c.hook}`, c.status]))
  const staleAllowlist = allowlist.filter((entry) => {
    const status = statusByPair.get(`${entry.ability}:${entry.hook}`)
    return status === undefined || status === 'ported'
  })

  return {
    classifications,
    summaries,
    totalDefined,
    totalPorted,
    totalAllowlisted,
    totalUnported,
    totalUnclassified,
    totalTested,
    totalAbilityMentionedInTests,
    unportedPairs,
    staleAllowlist,
  }
}

function collectEngineSourceFiles(dir: string): string[] {
  const result: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...collectEngineSourceFiles(fullPath))
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.includes('abilityHookInventory')
    ) {
      result.push(fullPath)
    }
  }
  return result
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Generates the deterministic markdown content for docs/battle-sim/ability-hook-inventory.md.
 */
export function generateInventoryDoc(
  inventory: InventoryResult,
  abilityHooksData: Record<string, AbilityHookRecord>,
  sourcesLockPath: string = SOURCES_LOCK_PATH,
): string {
  const lines: string[] = []

  const sourcesLock = JSON.parse(readFileSync(sourcesLockPath, 'utf-8'))
  const elitereduxSourceSha = sourcesLock.sources?.['eliteredux-source']?.sha
  const erConfigSha = sourcesLock.sources?.['er-config']?.sha
  const gameVersion = sourcesLock.game_version
  if (!elitereduxSourceSha || !erConfigSha || !gameVersion) {
    throw new Error(`sources.lock.json at ${sourcesLockPath} is missing required fields`)
  }

  // Section 1: Header
  lines.push('# Ability Hook Completeness Inventory')
  lines.push('')
  lines.push('Static completeness audit of all ability hooks defined in `data/v2.65beta/abilityHooks.json` against the battle simulator and damage engine implementations.')
  lines.push('')
  lines.push(`- **Source Commit (eliteredux-source)**: \`${elitereduxSourceSha}\` (game version \`${gameVersion}\`)`)
  lines.push(`- **Source Commit (er-config)**: \`${erConfigSha}\``)
  lines.push('- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/abilityHookInventory.test.ts`')
  lines.push('')

  // Section 2: Classification Method per Hook Kind
  lines.push('## Classification Method per Hook Kind')
  lines.push('')
  lines.push('A `(ability, hook)` pair is classified as **ported** only when an explicit registry entry or case branch handles that exact ability and hook. Below are the detection mechanisms per hook kind:')
  lines.push('')
  lines.push('1. **Calc-side hooks (18 kinds)**: Checked via `lookupAbility(id)` in `web/src/engine/abilities/registry.ts` (populated by `web/src/engine/abilities/impl/index.ts`). Ported iff `!isUnmodelled(entry)` and `typeof entry[hook] === "function"`.')
  lines.push('   - `onOffensiveMultiplier`, `onDefensiveMultiplier`, `onStat`, `onStab`, `onCrit`, `onTypeEffectiveness`, `onAfterTypeEffectiveness`, `onChooseOffensiveStat`, `onChooseDefensiveStat`, `onSwapSplit`, `onMoveType`, `onRecoil`, `onPriority`, `onMoldBreaker`, `onParentalBond`, `onAbsorb`, `onImmune`, `onInfiltrate`. (`onRecoil` and `onAbsorb` also consult their sim-side handler tables).')
  lines.push('2. **onAttacker**: Membership in exported `PORTED_ATTACKER_ABILITIES` (`web/src/engine/sim/moveEnd.ts`) **and** branch evidence in `handleAttackerMoveEndAbility`: an `abilityId === \'ABILITY_X\'` comparison, a key of a table the handler indexes with `[abilityId]` (`ATE_ON_HIT_STATUS`, `ON_EITHER_CONTACT_STATUS`), or the alias comparison it resolves (`ABILITY_SPECTRAL_SHROUD` -> the `ABILITY_SPECTRALIZE` row).')
  lines.push('3. **onDefender**: Membership in exported `PORTED_DEFENDER_ABILITIES` (`web/src/engine/sim/moveEnd.ts`) **and** branch evidence in `handleDefenderMoveEndAbility`: an `abilityId === \'ABILITY_X\'` comparison or a key of `CONTACT_COUNTERATTACKS` / `ON_EITHER_CONTACT_STATUS`.')
  lines.push('4. **onEntry**: Handled across weather/terrain/entry-move/intimidate/announce dispatch in `applySwitchInAbilities` (`web/src/engine/sim/switchInAbility.ts`). The ported set is derived from that dispatcher: the keys of `WEATHER_SETTER_MAP`, `TERRAIN_SETTER_MAP`, `PORTED_ENTRY_MOVE_MAP`, `INTIMIDATE_CLONE_MAP`, `ADD_TYPE_ON_ENTRY` and `ANNOUNCE_ONLY_ON_ENTRY`, plus every `case` label or ability-variable comparison (`abilityId === ...`) in `applySwitchInAbilities` and the same-file helpers it calls. Bare literals passed as arguments, array elements or map values are not evidence.')
  lines.push('5. **onEndTurn**: `runEndTurnAbilities` switch cases in `web/src/engine/sim/endTurn.ts`.')
  lines.push('6. **onAccuracy**: Cases in `runAttackerAbilityHook` and `runDefenderAbilityHook` in `web/src/engine/sim/accuracy.ts`.')
  lines.push('7. **onBattlerFaints**: Dispatched in `web/src/engine/sim/moveEnd.ts` (`dispatchOnBattlerFaints`): `ABILITY_STRIKEOUT`, `SET_STATE_ON_EFFECT_ABILITIES` (`web/src/engine/sim/statusEffects.ts`), keys of `KO_STAT_RAISES`, `KO_SOUL_EATER_ABILITIES`, `KO_JAWS_OF_CARNAGE_ABILITIES`, and `KO_CRIT_BOOST_ABILITIES`. All other `ON_BATTLER_FAINTS_ABILITIES` hit the unmodelled note.')
  lines.push('8. **onBeforeAttack**: Not ported (no handler in `web/src/engine/`).')
  lines.push('9. **onBlockStatDrops**: Case labels of `statDropBlockForAbility` (`web/src/engine/sim/statBuffs.ts`), extracted from source text.')
  lines.push('10. **onCanStatusType**: Quoted `ABILITY_...` ids inside `canPoisonType` and `canParalyzeType` (`web/src/engine/sim/statusEffects.ts`), extracted from source text: the CanPoisonType bypass array, the Angel\'s Wrath `MOVE_POISON_STING` comparison, and the CanParalyzeType bypass array.')
  lines.push('11. **onCopyMove**: Not ported (gapped in `web/src/engine/sim/moveEnd.ts`).')
  lines.push('12. **onDisguise**: Not ported (bust handler not modelled; note in `web/src/engine/sim/moveEnd.ts`).')
  lines.push('13. **onExit**: Case labels of `dispatchSwitchOutAbilities` (`web/src/engine/sim/turn.ts`), extracted from source text; note-only branches are unported.')
  lines.push('14. **onModifyEffectChance**: `abilityId === \'ABILITY_X\'` comparisons inside `getMoveEffectChance` (`web/src/engine/sim/statusEffects.ts`), extracted from source text.')
  lines.push('15. **onModifyMoveFlags**: `MODIFY_MOVE_FLAGS_GRANTS` records the `MOVE_FLAG_*` families each hook grants, read from `src/abilities.cc` at the pinned SHA. A pair is ported only when **every** granted family is listed in `MOVE_FLAG_CONSUMERS_WIRED` **and** has a returning-true `battlerHasSimAbility` branch for that ability in the matching sim predicate: SOUND in `isSoundMove`, KEEN_EDGE in `isKeenEdgeMove`, KICK in `isStrikerMove`, DANCE in `isDanceMove` (`web/src/engine/sim/moveEnd.ts`), MEGA_LAUNCHER in `isMegaLauncherBoostedMove` (`web/src/engine/sim/moveTargetFlags.ts`). `MOVE_FLAG_CONSUMERS_WIRED` is **empty**, so all 10 pairs are unported: the predicates mention the abilities, but the consumers that matter in the damage path still read the static move flags, so the ability changes nothing there. The unwired consumer groups: (a) `ABILITY_SOUNDPROOF` (`web/src/engine/abilities/impl/26-immune.ts:53`) and `ABILITY_PUNK_ROCK` / `ABILITY_AMPLIFIER` (`web/src/engine/abilities/impl/11-offensive-multiplier-d.ts:141,159,162`) test the static `ctx.moveFlags.sound` where the C calls `IsSoundMove` (`src/abilities.cc:1054`, `:3307`); (b) `ABILITY_CHESTNUT_AXE` grants KEEN_EDGE (`src/abilities.cc:3676`, hook `:11706-11712`) but the damage engine never applies the C\'s `DoesMoveMatchFlag(..., MOVE_FLAG_KEEN_EDGE)` 1.3x (Chestnut Axe + Energy Ball `roll[15]` is 22 with and without the ability); (c) `ABILITY_BACKSTREET_BOY` grants KICK (`src/abilities.cc:4609`, hook `:11570-11583`) but the damage engine never applies `IsStrikerBoosted` (Backstreet Boy + Fiery Dance is 152 with and without the ability). PUNCH has no sim predicate at all (the sim only reads the static `punchBased` flag), so any hook that grants PUNCH stays unported even once every other family is wired.')
  lines.push('16. **onModifyTargetFlag**: Handled in `getBattlerBattleMoveTargetFlags` (`web/src/engine/sim/moveTargetFlags.ts`).')
  lines.push('17. **onPreemptAction**: Cases in `tryPreemptiveActions` (`web/src/engine/sim/preempt.ts`).')
  lines.push('18. **onReactive**: `abilityId === \'ABILITY_X\'` comparisons inside `runReactiveAbilityEffects` (`web/src/engine/sim/statBuffs.ts`) plus the members of `POISON_PUPPETEER_CLONE_ABILITIES` that appear as `case \'ABILITY_X\'` labels inside `runPoisonPuppeteerClone` (the gate set alone is not evidence: Frostbind and Hemotoxin are in it but only raise a note); note-only branches are unported.')
  lines.push('19. **onRevive**: Handled in `latchRecurringNightmareOnFaint` (`web/src/engine/sim/turn.ts`, `ABILITY_RECURRING_NIGHTMARE`).')
  lines.push('20. **onStatLowered**: Handled in `ON_STAT_LOWERED_HOOKS` (`web/src/engine/sim/statBuffs.ts`).')
  lines.push('21. **onStatusImmune**: Handled in `OWN_STATUS_IMMUNE_CONDITIONS` (`web/src/engine/sim/statusEffects.ts`).')
  lines.push('22. **onTerrain**: Cases in `dispatchOnTerrainChange` (`web/src/engine/sim/onWeather.ts`).')
  lines.push('23. **onTrap**: Case labels of `onTrap` (`web/src/engine/sim/escape.ts`), extracted from source text.')
  lines.push('24. **onWeather**: Cases in `dispatchOnWeatherChange` (`web/src/engine/sim/onWeather.ts`).')
  lines.push('')
  const attackerListed = Object.keys(abilityHooksData).filter((id) => Boolean(abilityHooksData[id]?.hooks?.onAttacker))
  const attackerNoBranch = attackerListed
    .filter((id) => PORTED_ATTACKER_ABILITIES.has(id) && !PORTED_ATTACKER_BRANCH_ABILITIES.has(id))
    .sort()
  const defenderListed = Object.keys(abilityHooksData).filter((id) => Boolean(abilityHooksData[id]?.hooks?.onDefender))
  const defenderNoBranch = defenderListed
    .filter((id) => PORTED_DEFENDER_ABILITIES.has(id) && !PORTED_DEFENDER_BRANCH_ABILITIES.has(id))
    .sort()
  const noBranchText = (ids: string[]): string => (ids.length === 0 ? 'none' : ids.map((id) => `\`${id}\``).join(', '))
  lines.push(
    `Move-end branch evidence: ${attackerNoBranch.length} of the ${attackerListed.length} defined \`onAttacker\` pairs are listed in \`PORTED_ATTACKER_ABILITIES\` with no branch in \`handleAttackerMoveEndAbility\` (${noBranchText(attackerNoBranch)}). ${defenderNoBranch.length} of the ${defenderListed.length} defined \`onDefender\` pairs are listed in \`PORTED_DEFENDER_ABILITIES\` with no branch in \`handleDefenderMoveEndAbility\` (${noBranchText(defenderNoBranch)}). A listed pair with no branch is unported, not an error.`,
  )
  lines.push('')

  // Section 3: Summary Table
  lines.push('## Hook Completeness Summary')
  lines.push('')
  lines.push('| Hook Kind | Defined | Ported | Allowlisted | Unported | Unclassified | Ability Mentioned in Tests |')
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |')
  for (const s of inventory.summaries) {
    lines.push(
      `| ${s.hook} | ${s.defined} | ${s.ported} | ${s.allowlisted} | ${s.unported} | ${s.unclassified} | ${s.abilityMentionedInTests} |`,
    )
  }
  lines.push(
    `| **Total** | **${inventory.totalDefined}** | **${inventory.totalPorted}** | **${inventory.totalAllowlisted}** | **${inventory.totalUnported}** | **${inventory.totalUnclassified}** | **${inventory.totalAbilityMentionedInTests}** |`,
  )
  lines.push('')

  // Section 4: Full List of Unported Pairs
  lines.push('## Unported Ability Hook Pairs')
  lines.push('')
  lines.push('Grouped by hook kind, sorted alphabetically. Source lines cite `pipeline/.upstream/eliteredux-source/src/abilities.cc`.')
  lines.push('')

  const unportedByHook = new Map<HookKind, PairClassification[]>()
  for (const p of inventory.unportedPairs) {
    if (!unportedByHook.has(p.hook)) unportedByHook.set(p.hook, [])
    unportedByHook.get(p.hook)!.push(p)
  }

  const hooksWithUnported = HOOK_KINDS.filter((h) => (unportedByHook.get(h)?.length ?? 0) > 0)
  for (const hook of hooksWithUnported) {
    const pairs = unportedByHook.get(hook)!
    lines.push(`### ${hook} (${pairs.length})`)
    lines.push('')
    for (const p of pairs) {
      const testTag = p.abilityMentionedInTest ? ' *(ability mentioned in test)*' : ''
      lines.push(`- \`${p.ability}\` (src/abilities.cc:${p.sourceLine})${testTag}`)
    }
    lines.push('')
  }

  // Section 5: Bitfield-only abilities
  const bitfieldOnlyIds = Object.keys(abilityHooksData)
    .filter((id) => {
      const rec = abilityHooksData[id]
      return !rec.hooks || Object.keys(rec.hooks).length === 0
    })
    .sort()

  lines.push('## Bitfield-Only Abilities')
  lines.push('')
  lines.push(
    `Abilities that define no hook lambdas in \`abilityHooks.json\`, only flags/bitfields. Total: **${bitfieldOnlyIds.length} abilities**.`,
  )
  lines.push('')
  lines.push('### Bitfield Implementation Status in Engine & Sim Code')
  lines.push('')
  lines.push(
    'Static detection of bitfield names across production TypeScript source files under `web/src/engine/` (excluding tests and inventory files). Note that matching on `\\bname\\b` is a name match and is a weak signal, not proof of full mechanical fidelity.',
  )
  lines.push('')
  lines.push('| Bitfield | Read by Code? | Citing Files |')
  lines.push('| :--- | :--- | :--- |')

  const allBitfields = new Set<string>()
  for (const rec of Object.values(abilityHooksData)) {
    if (rec.bitfields) {
      for (const name of Object.keys(rec.bitfields)) {
        allBitfields.add(name)
      }
    }
  }
  const sortedBitfields = Array.from(allBitfields).sort()
  const engineFiles = collectEngineSourceFiles(ENGINE_DIR)
  const fileContents = engineFiles.map((file) => ({
    relPath: relative(REPO_ROOT, file).replace(/\\/g, '/'),
    content: readFileSync(file, 'utf-8'),
  }))

  for (const bf of sortedBitfields) {
    const regex = new RegExp(`\\b${escapeRegExp(bf)}\\b`)
    const citingFiles = fileContents
      .filter((fc) => regex.test(fc.content))
      .map((fc) => fc.relPath)
      .sort()

    const readByCode = citingFiles.length > 0 ? 'Yes' : 'No'
    const citingText =
      citingFiles.length > 0 ? citingFiles.map((p) => `\`${p}\``).join(', ') : '*(not read by sim or engine code)*'
    lines.push(`| \`${bf}\` | ${readByCode} | ${citingText} |`)
  }

  lines.push('')
  lines.push(`### Complete List of ${bitfieldOnlyIds.length} Bitfield-Only Abilities`)
  lines.push('')

  for (const id of bitfieldOnlyIds) {
    const rec = abilityHooksData[id]
    const bfs = rec.bitfields ? Object.keys(rec.bitfields).sort().join(', ') : 'none'
    lines.push(`- \`${id}\` (src/abilities.cc:${rec.sourceLine}): ${bfs}`)
  }
  lines.push('')

  return lines.join('\n')
}
