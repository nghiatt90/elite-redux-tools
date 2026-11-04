import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './moveInventory'

/**
 * Static completeness inventory for held items in `data/v2.65beta/items.json`.
 *
 * Unit kinds:
 *   1. `hold-trigger` -- one unit per (resolved hold effect, C trigger site) in
 *      `battle_util.c`, `battle_script_commands.c`, `battle_main.c`, `pokemon.c`
 *      and `abilities.cc`.
 *   2. `ai-trigger`  -- one unit per (resolved hold effect, C trigger site) in the
 *      AI files `battle_ai_util.c` / `battle_ai_main.c`.
 *   3. `item-data`   -- one unit per item whose hold effect has NO `hold-trigger`
 *      unit (data-only effects such as mega stones read through other tables).
 *   4. `natural-gift`-- one unit per berry carrying a `naturalGift` block.
 *   5. `fling`       -- one unit per item read by `VARIOUS_TRY_FLING`.
 *
 * A unit is `ported` only when its token (the `HOLD_EFFECT_*` name for trigger
 * units, the item id for item-keyed units) appears in BOTH non-test engine source
 * and an engine test. `registeredUntested` is a sub-count of `unported`: the
 * production token exists but no test names it. Comments are stripped before the
 * token search, because a mention in prose is not proof of a port.
 *
 * Nothing here changes simulator behaviour or imports engine code for its side
 * effects; `stripComments` is the move inventory's pure helper.
 */

export type ItemUnitKind = 'hold-trigger' | 'ai-trigger' | 'item-data' | 'natural-gift' | 'fling'
export type ItemUnitStatus = 'ported' | 'unported' | 'unclassified' | 'allowlisted'

export interface NaturalGiftRecord {
  type?: string
  power?: number
  effect?: string
}

export interface ItemRecord {
  id: string
  name: string
  grouping: string
  holdEffect: string
  resolvedHoldEffect: string
  holdEffectAlias?: string | null
  holdEffectStrength?: number | null
  naturalGift?: NaturalGiftRecord | null
}

export interface SourceFile {
  file: string
  source: string
}

export interface ItemAllowlistEntry {
  /** Unit key: `<HOLD_EFFECT>@<file>:<site>` for trigger units, the item id otherwise. */
  key: string
  reason: string
  /** Exact `file:line` from the pinned C. */
  cite: string
}

export interface ItemUnit {
  kind: ItemUnitKind
  /** Deterministic key: `<effect>@<file>:<site>` or the item id. */
  key: string
  /** The token used for classification: the effect name or the item id. */
  unit: string
  /** The hold effect (or the natural-gift / fling marker) the unit belongs to. */
  effect: string
  /** Enclosing C function, `ITEMEFFECT_*` case, macro or table name. */
  site: string
  /** Upstream file (repo-relative) holding the citation, or the data file. */
  file: string
  citation: string
  status: ItemUnitStatus
  /** True when production handles the unit but no qualifying test names it (sub-count of unported). */
  registeredUntested: boolean
  /** Engine test file with the strongest evidence, or null. */
  testFile: string | null
  /** Items carrying the effect (trigger units) or the single item (item-keyed units). */
  itemIds: string[]
}

export interface ItemUnitKindSummary {
  kind: ItemUnitKind
  defined: number
  ported: number
  registeredUntested: number
  /** Includes `registeredUntested`. */
  unported: number
  unclassified: number
  allowlisted: number
}

export interface UnportedTriggerKind {
  kind: ItemUnitKind
  triggerKind: string
  unported: number
}

export interface ItemInventoryResult {
  units: ItemUnit[]
  summaries: ItemUnitKindSummary[]
  totalDefined: number
  totalPorted: number
  totalUnported: number
  totalRegisteredUntested: number
  totalUnclassified: number
  totalAllowlisted: number
  unportedByTriggerKind: UnportedTriggerKind[]
  itemCount: number
  distinctHoldEffectCount: number
}

/** Pinned in the test. Empty today: no C site is provably inert. */
export const DEFAULT_ALLOWLIST: ReadonlyArray<ItemAllowlistEntry> = []

export const UNIT_KIND_ORDER: ReadonlyArray<ItemUnitKind> = [
  'hold-trigger',
  'ai-trigger',
  'item-data',
  'natural-gift',
  'fling',
]

const ENGINE_DIR = fileURLToPath(new URL('../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const ITEMS_PATH = join(REPO_ROOT, 'data/v2.65beta/items.json')
const HOLD_EFFECT_IDS_PATH = join(REPO_ROOT, 'data/v2.65beta/holdEffectIds.json')
const SOURCES_LOCK_PATH = join(REPO_ROOT, 'sources.lock.json')
const UPSTREAM_SRC = 'pipeline/.upstream/eliteredux-source/src'
const ITEMS_REPO_REL = 'data/v2.65beta/items.json'

export const HOLD_TRIGGER_FILES = [
  'battle_util.c',
  'battle_script_commands.c',
  'battle_main.c',
  'pokemon.c',
  'abilities.cc',
] as const

export const AI_TRIGGER_FILES = ['battle_ai_util.c', 'battle_ai_main.c'] as const

export const FLING_FILE = 'battle_script_commands.c'

/** `gNaturalGiftTable` read sites. */
export const NATURAL_GIFT_CITATIONS = [
  `${UPSTREAM_SRC}/battle_util.c:6840`,
  `${UPSTREAM_SRC}/battle_script_commands.c:3023`,
  `${UPSTREAM_SRC}/battle_main.c:5072`,
  `${UPSTREAM_SRC}/battle_main.c:5171`,
] as const

export const ITEM_INVENTORY_DOC_PATH = join(REPO_ROOT, 'docs/battle-sim/item-inventory.md')

const HOLD_EFFECT_TOKEN_RE = /HOLD_EFFECT_[A-Z0-9_]+/g
const ITEM_CASE_RE = /^\s*case (ITEM_[A-Z0-9_]+):/
const ITEM_EFFECT_CASE_RE = /^\s*case (ITEMEFFECT_[A-Z_]+):/
const TOP_LEVEL_FUNCTION_RE = /^[A-Za-z_][A-Za-z0-9_ \t*]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/
const TOP_LEVEL_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_ \t*]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*(\[|=)/
const MACRO_RE = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function tokenAppears(source: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(source)
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

export function loadItems(path: string = ITEMS_PATH): ItemRecord[] {
  return JSON.parse(readFileSync(path, 'utf-8')) as ItemRecord[]
}

export function loadHoldEffectIds(path: string = HOLD_EFFECT_IDS_PATH): Record<string, number> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, number>
}

/** Sorted distinct non-`HOLD_EFFECT_NONE` resolved hold effects. */
export function distinctResolvedHoldEffects(items: ItemRecord[]): string[] {
  const effects = new Set<string>()
  for (const item of items) {
    if (item.resolvedHoldEffect && item.resolvedHoldEffect !== 'HOLD_EFFECT_NONE') {
      effects.add(item.resolvedHoldEffect)
    }
  }
  return [...effects].sort()
}

export function loadHoldTriggerSources(): Record<string, string> {
  const sources: Record<string, string> = {}
  for (const file of HOLD_TRIGGER_FILES) {
    sources[file] = readFileSync(join(REPO_ROOT, UPSTREAM_SRC, file), 'utf-8')
  }
  return sources
}

export function loadAiTriggerSources(): Record<string, string> {
  const sources: Record<string, string> = {}
  for (const file of AI_TRIGGER_FILES) {
    sources[file] = readFileSync(join(REPO_ROOT, UPSTREAM_SRC, file), 'utf-8')
  }
  return sources
}

export function loadFlingSource(): string {
  return readFileSync(join(REPO_ROOT, UPSTREAM_SRC, FLING_FILE), 'utf-8')
}

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

/** Non-test engine sources outside `sim/driver/`, comment-stripped. */
export function loadEngineProductionFiles(): SourceFile[] {
  return collectEngineFiles(
    (repoRel, isTest) => !isTest && !repoRel.startsWith('web/src/engine/sim/driver/'),
  ).map((file) => ({ file: file.file, source: stripComments(file.source) }))
}

/** Non-test engine sources under `sim/ai/`, comment-stripped. */
export function loadEngineAiProductionFiles(): SourceFile[] {
  return collectEngineFiles(
    (repoRel, isTest) => !isTest && repoRel.startsWith('web/src/engine/sim/ai/'),
  ).map((file) => ({ file: file.file, source: stripComments(file.source) }))
}

/** Engine test sources except this inventory's own test file. */
export function loadEngineTestFiles(): SourceFile[] {
  return collectEngineFiles(
    (repoRel, isTest) => isTest && repoRel !== 'web/src/engine/sim/driver/itemInventory.test.ts',
  )
}

// ---------------------------------------------------------------------------
// C scanning
// ---------------------------------------------------------------------------

export interface HoldEffectHit {
  effect: string
  file: string
  site: string
  line: number
}

/** Line number -> macro name, covering every continuation line of a `#define`. */
export function buildMacroRegions(lines: string[]): Map<number, string> {
  const regions = new Map<number, string>()
  let i = 0
  while (i < lines.length) {
    const match = lines[i].match(MACRO_RE)
    if (!match) {
      i += 1
      continue
    }
    let end = i
    while (end < lines.length - 1 && lines[end].replace(/\s+$/, '').endsWith('\\')) end += 1
    for (let line = i; line <= end; line += 1) regions.set(line + 1, match[1])
    i = end + 1
  }
  return regions
}

/**
 * Name of the nearest column-0 declaration above `lineNumber`: a macro, a file-scope
 * table/variable, or a function definition. Preprocessor lines are skipped, and a
 * function prototype (line ending in `;`) is not a definition. This is how a hit
 * outside `ItemBattleEffects` gets its trigger kind.
 */
export function nearestEnclosingDefinition(lines: string[], lineNumber: number): string {
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    const text = lines[index]
    if (text.startsWith(' ') || text.startsWith('\t')) continue
    if (text.trimStart().startsWith('#')) continue
    const variable = text.match(TOP_LEVEL_VARIABLE_RE)
    if (variable) return variable[1]
    const fn = text.match(TOP_LEVEL_FUNCTION_RE)
    if (fn && !text.replace(/\s+$/, '').endsWith(';')) return fn[1]
  }
  return '?'
}

export interface ItemBattleEffectsRange {
  start: number
  end: number
  cases: Array<{ line: number; name: string }>
}

/** Locates `ItemBattleEffects` and its `case ITEMEFFECT_*` labels (1-indexed lines). */
export function findItemBattleEffectsRange(lines: string[]): ItemBattleEffectsRange | null {
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^u8 ItemBattleEffects\s*\(/.test(lines[index])) {
      start = index + 1
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let index = start; index < lines.length; index += 1) {
    const text = lines[index]
    if (text.startsWith(' ') || text.startsWith('\t') || text.trimStart().startsWith('#')) continue
    const fn = text.match(TOP_LEVEL_FUNCTION_RE)
    if (fn && !text.replace(/\s+$/, '').endsWith(';')) {
      end = index // 0-based index equals the line number before the next definition
      break
    }
  }
  const cases: Array<{ line: number; name: string }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1
    if (line < start || line > end) continue
    const match = lines[index].match(ITEM_EFFECT_CASE_RE)
    if (match) cases.push({ line, name: match[1] })
  }
  return { start, end, cases }
}

/**
 * Scans one C file for `HOLD_EFFECT_*` tokens that belong to a resolved effect and
 * attributes each hit to its trigger site. Several hits of one effect in one
 * site collapse later in `runInventory`; the first line is the citation.
 */
export function scanHoldEffectHits(
  file: string,
  source: string,
  effects: ReadonlySet<string>,
  options: { itemBattleEffects?: boolean } = {},
): HoldEffectHit[] {
  const lines = source.split('\n')
  const macros = buildMacroRegions(lines)
  const range = options.itemBattleEffects ? findItemBattleEffectsRange(lines) : null
  const hits: HoldEffectHit[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1
    const tokens = lines[index].match(HOLD_EFFECT_TOKEN_RE)
    if (!tokens) continue
    const unique = [...new Set(tokens)].filter((token) => effects.has(token))
    if (unique.length === 0) continue
    let site: string
    const macro = macros.get(line)
    if (macro) {
      site = macro
    } else if (range && line >= range.start && line <= range.end) {
      let name = ''
      for (const candidate of range.cases) {
        if (candidate.line <= line) name = candidate.name
      }
      site = name || nearestEnclosingDefinition(lines, line)
    } else {
      site = nearestEnclosingDefinition(lines, line)
    }
    for (const effect of unique) hits.push({ effect, file, site, line })
  }
  return hits
}

/** Item ids read by the `VARIOUS_TRY_FLING` switch (the only on-disk fling table consumer). */
export function parseFlingItems(source: string): Array<{ itemId: string; line: number }> {
  const lines = source.split('\n')
  const items: Array<{ itemId: string; line: number }> = []
  let inside = false
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes('case VARIOUS_TRY_FLING:')) {
      inside = true
      continue
    }
    if (!inside) continue
    const match = lines[index].match(ITEM_CASE_RE)
    if (match) items.push({ itemId: match[1], line: index + 1 })
    if (lines[index].trim() === 'return;') break
  }
  return items
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface TokenClassification {
  status: ItemUnitStatus
  registeredUntested: boolean
  testFile: string | null
}

export function classifyToken(
  token: string,
  productionSource: string,
  testSources: ReadonlyArray<SourceFile>,
): TokenClassification {
  const production = tokenAppears(productionSource, token)
  const matchingFiles = testSources
    .filter((file) => tokenAppears(stripComments(file.source), token))
    .map((file) => file.file)
    .sort()
  const tested = matchingFiles.length > 0
  if (production && tested) return { status: 'ported', registeredUntested: false, testFile: matchingFiles[0] }
  if (production) return { status: 'unported', registeredUntested: true, testFile: null }
  return { status: 'unported', registeredUntested: false, testFile: matchingFiles[0] ?? null }
}

/** A citation must be an exact `pinned C file:line`. */
export function isValidAllowlistCitation(cite: string): boolean {
  return /\.(?:c|cc|h):\d+$/.test(cite)
}

/** Returns human-readable problems; empty means every entry is well formed. */
export function validateAllowlist(allowlist: ReadonlyArray<ItemAllowlistEntry>): string[] {
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

function allowlistEntryFor(
  key: string,
  allowlist: ReadonlyArray<ItemAllowlistEntry>,
): ItemAllowlistEntry | undefined {
  return allowlist.find((entry) => entry.key === key)
}

function unitKey(effect: string, file: string, site: string): string {
  return `${effect}@${file.split('/').pop()}:${site}`
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export interface ItemInventoryOptions {
  holdTriggerSources?: Record<string, string>
  aiTriggerSources?: Record<string, string>
  flingSource?: string
  productionSource?: string
  aiProductionSource?: string
  testSources?: ReadonlyArray<SourceFile>
  allowlist?: ReadonlyArray<ItemAllowlistEntry>
}

export function runInventory(items: ItemRecord[], options: ItemInventoryOptions = {}): ItemInventoryResult {
  const allowlist = options.allowlist ?? DEFAULT_ALLOWLIST
  const allowlistProblems = validateAllowlist(allowlist)
  if (allowlistProblems.length > 0) throw new Error(allowlistProblems.join('\n'))

  const holdSources = options.holdTriggerSources ?? loadHoldTriggerSources()
  const aiSources = options.aiTriggerSources ?? loadAiTriggerSources()
  const flingSource = options.flingSource ?? loadFlingSource()
  const productionSource = stripComments(
    options.productionSource ?? loadEngineProductionFiles().map((file) => file.source).join('\n'),
  )
  const aiProductionSource = stripComments(
    options.aiProductionSource ?? loadEngineAiProductionFiles().map((file) => file.source).join('\n'),
  )
  const testSources = options.testSources ?? loadEngineTestFiles()
  const effects = new Set(distinctResolvedHoldEffects(items))

  const itemsByEffect = new Map<string, string[]>()
  for (const item of items) {
    if (!item.resolvedHoldEffect || item.resolvedHoldEffect === 'HOLD_EFFECT_NONE') continue
    const list = itemsByEffect.get(item.resolvedHoldEffect) ?? []
    list.push(item.id)
    itemsByEffect.set(item.resolvedHoldEffect, list)
  }
  for (const list of itemsByEffect.values()) list.sort()

  // Trigger units: first hit of (effect, file, site) wins, giving the lowest line.
  const holdHits = new Map<string, HoldEffectHit>()
  for (const file of HOLD_TRIGGER_FILES) {
    const source = holdSources[file]
    if (source === undefined) continue
    for (const hit of scanHoldEffectHits(file, source, effects, { itemBattleEffects: file === 'battle_util.c' })) {
      const key = unitKey(hit.effect, hit.file, hit.site)
      if (!holdHits.has(key)) holdHits.set(key, hit)
    }
  }
  const aiHits = new Map<string, HoldEffectHit>()
  for (const file of AI_TRIGGER_FILES) {
    const source = aiSources[file]
    if (source === undefined) continue
    for (const hit of scanHoldEffectHits(file, source, effects)) {
      const key = unitKey(hit.effect, hit.file, hit.site)
      if (!aiHits.has(key)) aiHits.set(key, hit)
    }
  }

  const units: ItemUnit[] = []

  for (const [key, hit] of holdHits) {
    const classification = classifyToken(hit.effect, productionSource, testSources)
    const allow = allowlistEntryFor(key, allowlist)
    const site = hit.site
    units.push({
      kind: 'hold-trigger',
      key,
      unit: hit.effect,
      effect: hit.effect,
      site,
      file: `${UPSTREAM_SRC}/${hit.file}`,
      citation: allow?.cite ?? `${UPSTREAM_SRC}/${hit.file}:${hit.line}`,
      status: site === '?' ? 'unclassified' : allow ? 'allowlisted' : classification.status,
      registeredUntested: site === '?' || allow ? false : classification.registeredUntested,
      testFile: classification.testFile,
      itemIds: itemsByEffect.get(hit.effect) ?? [],
    })
  }

  for (const [key, hit] of aiHits) {
    const classification = classifyToken(hit.effect, aiProductionSource, testSources)
    const allow = allowlistEntryFor(key, allowlist)
    const site = hit.site
    units.push({
      kind: 'ai-trigger',
      key,
      unit: hit.effect,
      effect: hit.effect,
      site,
      file: `${UPSTREAM_SRC}/${hit.file}`,
      citation: allow?.cite ?? `${UPSTREAM_SRC}/${hit.file}:${hit.line}`,
      status: site === '?' ? 'unclassified' : allow ? 'allowlisted' : classification.status,
      registeredUntested: site === '?' || allow ? false : classification.registeredUntested,
      testFile: classification.testFile,
      itemIds: itemsByEffect.get(hit.effect) ?? [],
    })
  }

  const effectsWithHoldUnit = new Set([...holdHits.values()].map((hit) => hit.effect))
  for (const item of items) {
    if (!item.resolvedHoldEffect || item.resolvedHoldEffect === 'HOLD_EFFECT_NONE') continue
    if (effectsWithHoldUnit.has(item.resolvedHoldEffect)) continue
    const key = item.id
    const classification = classifyToken(key, productionSource, testSources)
    const allow = allowlistEntryFor(key, allowlist)
    units.push({
      kind: 'item-data',
      key,
      unit: key,
      effect: item.resolvedHoldEffect,
      site: item.resolvedHoldEffect,
      file: ITEMS_REPO_REL,
      citation: allow?.cite ?? `none (data-only; ${ITEMS_REPO_REL})`,
      status: allow ? 'allowlisted' : classification.status,
      registeredUntested: allow ? false : classification.registeredUntested,
      testFile: classification.testFile,
      itemIds: [item.id],
    })
  }

  for (const item of items) {
    if (!item.naturalGift) continue
    const key = item.id
    const classification = classifyToken(key, productionSource, testSources)
    const allow = allowlistEntryFor(key, allowlist)
    units.push({
      kind: 'natural-gift',
      key,
      unit: key,
      effect: 'naturalGift',
      site: 'naturalGift',
      file: `${UPSTREAM_SRC}/${FLING_FILE}`,
      citation: allow?.cite ?? NATURAL_GIFT_CITATIONS.join('; '),
      status: allow ? 'allowlisted' : classification.status,
      registeredUntested: allow ? false : classification.registeredUntested,
      testFile: classification.testFile,
      itemIds: [item.id],
    })
  }

  for (const fling of parseFlingItems(flingSource)) {
    const key = fling.itemId
    const classification = classifyToken(key, productionSource, testSources)
    const allow = allowlistEntryFor(key, allowlist)
    units.push({
      kind: 'fling',
      key,
      unit: key,
      effect: 'VARIOUS_TRY_FLING',
      site: 'VARIOUS_TRY_FLING',
      file: `${UPSTREAM_SRC}/${FLING_FILE}`,
      citation: allow?.cite ?? `${UPSTREAM_SRC}/${FLING_FILE}:${fling.line}`,
      status: allow ? 'allowlisted' : classification.status,
      registeredUntested: allow ? false : classification.registeredUntested,
      testFile: classification.testFile,
      itemIds: [fling.itemId],
    })
  }

  const summaries: ItemUnitKindSummary[] = UNIT_KIND_ORDER.map((kind) => {
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

  const unportedGroups = new Map<string, UnportedTriggerKind>()
  for (const unit of units) {
    if (unit.status !== 'unported') continue
    const groupKey = `${unit.kind}\u0000${unit.site}`
    const existing = unportedGroups.get(groupKey)
    if (existing) existing.unported += 1
    else unportedGroups.set(groupKey, { kind: unit.kind, triggerKind: unit.site, unported: 1 })
  }
  const unportedByTriggerKind = [...unportedGroups.values()].sort((a, b) => {
    const kindDiff = UNIT_KIND_ORDER.indexOf(a.kind) - UNIT_KIND_ORDER.indexOf(b.kind)
    if (kindDiff !== 0) return kindDiff
    return a.triggerKind < b.triggerKind ? -1 : a.triggerKind > b.triggerKind ? 1 : 0
  })

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
    unportedByTriggerKind,
    itemCount: items.length,
    distinctHoldEffectCount: effects.size,
  }
}

// ---------------------------------------------------------------------------
// Doc generation
// ---------------------------------------------------------------------------

function statusLabel(unit: ItemUnit): string {
  return unit.status === 'unported' && unit.registeredUntested ? 'unported (registered, untested)' : unit.status
}

function formatItemList(itemIds: string[], names: Map<string, string>): string {
  const labels = itemIds.map((id) => names.get(id) ?? id)
  if (labels.length <= 5) return labels.join(', ')
  return `${labels.slice(0, 5).join(', ')} +${labels.length - 5}`
}

export function generateItemInventoryDoc(
  result: ItemInventoryResult,
  items: ItemRecord[],
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
  const names = new Map(items.map((item) => [item.id, item.name]))

  const lines: string[] = []
  lines.push('# Held-Item Completeness Inventory')
  lines.push('')
  lines.push(
    'Static inventory of every held-item unit for `data/v2.65beta/items.json` against the battle simulator and damage engine.',
  )
  lines.push('')
  lines.push(`- **Source Commit (eliteredux-source)**: \`${elitereduxSourceSha}\` (game version \`${gameVersion}\`)`)
  lines.push(`- **Source Commit (er-config)**: \`${erConfigSha}\``)
  lines.push(
    '- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/itemInventory.test.ts`',
  )
  lines.push('')

  lines.push('## Unit Kinds and Classification Rules')
  lines.push('')
  lines.push(
    'A unit is **ported** only when its token appears in both a non-test, non-driver engine source file and an engine test',
  )
  lines.push(
    'file, after comments are stripped. `registered, untested` means production handles the unit but no test names it;',
  )
  lines.push('it is counted as unported. Allowlisted units require an exact pinned C `file:line`.')
  lines.push('')
  lines.push(
    '1. **hold-trigger**: one unit per (resolved hold effect, C trigger site) in `battle_util.c`,',
  )
  lines.push(
    '   `battle_script_commands.c`, `battle_main.c`, `pokemon.c` and `abilities.cc`. The site is the enclosing',
  )
  lines.push(
    '   `ITEMEFFECT_*` case inside `ItemBattleEffects`, or the nearest enclosing function/table/macro elsewhere.',
  )
  lines.push('   The token is the `HOLD_EFFECT_*` name. Several hits of one effect in one site collapse to one unit.')
  lines.push(
    '2. **ai-trigger**: the same rule for `battle_ai_util.c` and `battle_ai_main.c`; production evidence must come',
  )
  lines.push('   from a source file under `web/src/engine/sim/ai/`.')
  lines.push(
    '3. **item-data**: one unit per item whose hold effect has no hold-trigger unit. The token is the item id.',
  )
  lines.push(
    '4. **natural-gift**: one unit per berry with a `naturalGift` block, citing the `gNaturalGiftTable` read sites.',
  )
  lines.push('   The token is the item id.')
  lines.push(
    '5. **fling**: one unit per item read by `VARIOUS_TRY_FLING` (no `gFlingTable` definition is on disk). The token',
  )
  lines.push('   is the item id.')
  lines.push('')
  lines.push(
    'Berry trigger conditions are represented by their `hold-trigger` units; this inventory does not create a second',
  )
  lines.push('unit kind for them.')
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
    `Items in \`data/v2.65beta/items.json\`: ${result.itemCount}; distinct non-\`HOLD_EFFECT_NONE\` resolved hold effects: ${result.distinctHoldEffectCount}.`,
  )
  lines.push('')

  lines.push('## Unported Units by Trigger Kind')
  lines.push('')
  if (result.unportedByTriggerKind.length === 0) {
    lines.push('None.')
  } else {
    lines.push('| Unit kind | Trigger kind | Unported |')
    lines.push('| --- | --- | ---: |')
    for (const group of result.unportedByTriggerKind) {
      lines.push(`| \`${group.kind}\` | \`${group.triggerKind}\` | ${group.unported} |`)
    }
  }
  lines.push('')

  const pushSection = (kind: ItemUnitKind, title: string): void => {
    lines.push(`## ${title}`)
    lines.push('')
    lines.push(
      'One line per unit, sorted by unit key. `Items` lists the first five item names sharing the hold effect',
    )
    lines.push('(then `+N`); item-keyed units list their own item.')
    lines.push('')
    const subset = result.units.filter((unit) => unit.kind === kind).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    if (subset.length === 0) {
      lines.push('None.')
      lines.push('')
      return
    }
    lines.push('| Unit key | Items | C citation | Status | Test file |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const unit of subset) {
      const citation = `\`${unit.citation}\``
      const testFile = unit.testFile ? `\`${unit.testFile}\`` : 'none'
      lines.push(
        `| \`${unit.key}\` | ${formatItemList(unit.itemIds, names)} | ${citation} | ${statusLabel(unit)} | ${testFile} |`,
      )
    }
    lines.push('')
  }

  pushSection('hold-trigger', 'Hold-Trigger Units')
  pushSection('ai-trigger', 'AI-Trigger Units')
  pushSection('item-data', 'Item-Data Units')
  pushSection('natural-gift', 'Natural-Gift Units')
  pushSection('fling', 'Fling Units')

  return `${lines.join('\n')}\n`
}
