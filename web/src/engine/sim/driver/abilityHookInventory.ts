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
} from '../moveEnd'
import { SWITCH_IN_ABILITY_IDS } from '../switchInAbility'
import {
  STATUS_IMMUNE_ABILITIES,
  CAN_STATUS_TYPE_ABILITIES,
  MODIFY_MOVE_FLAGS_ABILITIES,
  INFILTRATE_ABILITIES,
  ON_MODIFY_EFFECT_CHANCE_ABILITIES,
  SET_STATE_ON_EFFECT_ABILITIES,
} from '../statusEffects'
import { STAT_DROP_BLOCK_ABILITIES } from '../statBuffs'
import { TRAPPING_ABILITIES } from '../escape'
import { SWITCH_OUT_HOOK_ABILITIES } from '../turn'
import { ON_STAT_LOWERED_ABILITIES } from '../ai/aiCheckBadMove'
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

export type ClassificationStatus = 'ported' | 'unported' | 'unclassified'

export interface PairClassification {
  ability: string
  hook: HookKind
  status: ClassificationStatus
  sourceLine: number
  tested: boolean
}

export interface HookKindSummary {
  hook: HookKind
  defined: number
  ported: number
  unported: number
  unclassified: number
  tested: number
}

export interface InventoryResult {
  classifications: PairClassification[]
  summaries: HookKindSummary[]
  totalDefined: number
  totalPorted: number
  totalUnported: number
  totalUnclassified: number
  totalTested: number
  unportedPairs: PairClassification[]
}

export interface AllowlistEntry {
  ability: string
  hook: string
  citation: string
}

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
const TURN_PATH = join(ENGINE_DIR, 'sim/turn.ts')
const MOVE_END_PATH = join(ENGINE_DIR, 'sim/moveEnd.ts')
const ABSORB_PATH = join(ENGINE_DIR, 'sim/absorb.ts')

/**
 * Extracts the slice of code corresponding to a function declaration, up to the next top-level function or EOF.
 */
export function extractFunctionSlice(source: string, functionDeclaration: string): string {
  const start = source.indexOf(functionDeclaration)
  if (start === -1) {
    throw new Error(`Function declaration not found: ${functionDeclaration}`)
  }
  const afterStart = source.slice(start + functionDeclaration.length)
  const nextFuncMatch = afterStart.match(/\n(?:export\s+)?function\s+/)
  const end = nextFuncMatch ? start + functionDeclaration.length + nextFuncMatch.index! : source.length
  return source.slice(start, end)
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
    if (match[1] !== 'ABILITY_FORECAST') {
      result.add(match[1])
    }
  }
  if (result.size === 0) {
    throw new Error('Zero labels extracted for declaration: export function getBattlerBattleMoveTargetFlags(')
  }
  return result
}

export function extractReactiveExtraAbilities(): Set<string> {
  const content = readFileSync(STAT_BUFFS_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'function runReactiveAbilityEffects(')
  const result = new Set<string>()
  const regex = /(?:case\s+|abilityId\s*===\s*)['"](ABILITY_[A-Z0-9_]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(slice)) !== null) {
    if (match[1] !== 'ABILITY_RETRIBUTION_BLOW') {
      result.add(match[1])
    }
  }
  if (result.size === 0) {
    throw new Error('Zero labels extracted for declaration: function runReactiveAbilityEffects(')
  }
  return result
}

export function extractReviveAbilities(): Set<string> {
  const content = readFileSync(TURN_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'function latchRecurringNightmareOnFaint(')
  const result = new Set<string>()
  const regex = /(?:case\s+|abilityId\s*!==\s*|abilityId\s*===\s*)['"](ABILITY_[A-Z0-9_]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(slice)) !== null) {
    result.add(match[1])
  }
  if (result.size === 0) {
    throw new Error('Zero labels extracted for declaration: function latchRecurringNightmareOnFaint(')
  }
  return result
}

export function extractBattlerFaintsExtraAbilities(): Set<string> {
  const content = readFileSync(MOVE_END_PATH, 'utf-8')
  const slice = extractFunctionSlice(content, 'function dispatchOnBattlerFaints(')
  const result = new Set<string>()
  const regex = /(?:case\s+|abilityId\s*===\s*)['"](ABILITY_[A-Z0-9_]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(slice)) !== null) {
    result.add(match[1])
  }
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
export const PORTED_REACTIVE_ABILITIES = new Set<string>([
  ...SET_STATE_ON_EFFECT_ABILITIES,
  ...extractReactiveExtraAbilities(),
])
export const PORTED_REVIVE_ABILITIES = extractReviveAbilities()
export const PORTED_SIM_ABSORB_ABILITIES = new Set<string>([
  ...HEAL_ABSORB_ABILITIES,
  ...STAT_ABSORB_ABILITIES,
  ...extractSimAbsorbExtraAbilities(),
])

const STAT_DROP_BLOCK_SET = new Set<string>(STAT_DROP_BLOCK_ABILITIES)
const CAN_STATUS_TYPE_SET = new Set<string>(CAN_STATUS_TYPE_ABILITIES)
const STATUS_IMMUNE_SET = new Set<string>(STATUS_IMMUNE_ABILITIES)
const ON_STAT_LOWERED_SET = new Set<string>(ON_STAT_LOWERED_ABILITIES)
const MODIFY_MOVE_FLAGS_SET = new Set<string>(MODIFY_MOVE_FLAGS_ABILITIES)
const INFILTRATE_SET = new Set<string>(INFILTRATE_ABILITIES)
const ON_MODIFY_EFFECT_CHANCE_SET = new Set<string>(ON_MODIFY_EFFECT_CHANCE_ABILITIES)

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
  'onModifyMoveFlags',
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
  if (CALC_HOOKS.has(hookKind)) {
    const entry = ctx.lookup(abilityId)
    if (entry && !isUnmodelled(entry) && typeof (entry as unknown as Record<string, unknown>)[hookKind] === 'function') {
      return true
    }
    // Sibling sim checks for hooks that also have sim-side lists
    if (hookKind === 'onAbsorb' && PORTED_SIM_ABSORB_ABILITIES.has(abilityId)) return true
    if (hookKind === 'onInfiltrate' && INFILTRATE_SET.has(abilityId)) return true
    if (hookKind === 'onModifyMoveFlags' && MODIFY_MOVE_FLAGS_SET.has(abilityId)) return true
    return false
  }

  switch (hookKind) {
    case 'onAttacker':
      return PORTED_ATTACKER_ABILITIES.has(abilityId)
    case 'onDefender':
      return PORTED_DEFENDER_ABILITIES.has(abilityId)
    case 'onEntry':
      return SWITCH_IN_ABILITY_IDS.has(abilityId)
    case 'onEndTurn':
      return PORTED_END_TURN_ABILITIES.has(abilityId)
    case 'onAccuracy':
      return PORTED_ACCURACY_ABILITIES.has(abilityId)
    case 'onBattlerFaints':
      return PORTED_BATTLER_FAINTS_ABILITIES.has(abilityId)
    case 'onBeforeAttack':
      return false
    case 'onBlockStatDrops':
      return STAT_DROP_BLOCK_SET.has(abilityId)
    case 'onCanStatusType':
      return CAN_STATUS_TYPE_SET.has(abilityId)
    case 'onCopyMove':
      return false
    case 'onDisguise':
      return false
    case 'onExit':
      return SWITCH_OUT_HOOK_ABILITIES.has(abilityId)
    case 'onModifyEffectChance':
      return ON_MODIFY_EFFECT_CHANCE_SET.has(abilityId)
    case 'onModifyTargetFlag':
      return PORTED_TARGET_FLAG_ABILITIES.has(abilityId)
    case 'onPreemptAction':
      return PORTED_PREEMPT_ACTION_ABILITIES.has(abilityId)
    case 'onReactive':
      return PORTED_REACTIVE_ABILITIES.has(abilityId)
    case 'onRevive':
      return PORTED_REVIVE_ABILITIES.has(abilityId)
    case 'onStatLowered':
      return ON_STAT_LOWERED_SET.has(abilityId)
    case 'onStatusImmune':
      return STATUS_IMMUNE_SET.has(abilityId)
    case 'onTerrain':
      return PORTED_TERRAIN_ABILITIES.has(abilityId)
    case 'onTrap':
      return TRAPPING_ABILITIES.has(abilityId)
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
      unported: 0,
      unclassified: 0,
      tested: 0,
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
        status = 'ported' // allowlisted pair excluded from unported count
      }

      const tested = testMentionedAbilities.has(id)
      const summary = summaryByHook.get(hook)!
      summary.defined++
      if (status === 'ported') summary.ported++
      else if (status === 'unported') summary.unported++
      else summary.unclassified++
      if (tested) summary.tested++

      classifications.push({
        ability: id,
        hook,
        status,
        sourceLine: rec.sourceLine,
        tested,
      })
    }
  }

  const summaries = HOOK_KINDS.map((h) => summaryByHook.get(h)!)
  const totalDefined = summaries.reduce((acc, s) => acc + s.defined, 0)
  const totalPorted = summaries.reduce((acc, s) => acc + s.ported, 0)
  const totalUnported = summaries.reduce((acc, s) => acc + s.unported, 0)
  const totalUnclassified = summaries.reduce((acc, s) => acc + s.unclassified, 0)
  const totalTested = summaries.reduce((acc, s) => acc + s.tested, 0)
  const unportedPairs = classifications.filter((c) => c.status === 'unported')

  return {
    classifications,
    summaries,
    totalDefined,
    totalPorted,
    totalUnported,
    totalUnclassified,
    totalTested,
    unportedPairs,
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
): string {
  const lines: string[] = []

  let elitereduxSourceSha = 'bdebcbbff9760cdd41a02c425bea4857fa0eee26'
  let erConfigSha = '1b8e2cc4a8096d7ec90616f87fbf771bfa732447'
  let gameVersion = 'v2.65beta'
  try {
    const sourcesLock = JSON.parse(readFileSync(SOURCES_LOCK_PATH, 'utf-8'))
    elitereduxSourceSha = sourcesLock.sources?.['eliteredux-source']?.sha ?? elitereduxSourceSha
    erConfigSha = sourcesLock.sources?.['er-config']?.sha ?? erConfigSha
    gameVersion = sourcesLock.game_version ?? gameVersion
  } catch {
    // Fallback if not readable
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
  lines.push('A `(ability, hook)` pair is classified as **ported** only when an explicit registry entry or case branch handles that exact ability and hook (or transitively through its `form: "alias"` target). Below are the detection mechanisms per hook kind:')
  lines.push('')
  lines.push('1. **Calc-side hooks (19 kinds)**: Checked via `lookupAbility(id)` in `web/src/engine/abilities/registry.ts` (populated by `web/src/engine/abilities/impl/index.ts`). Ported iff `!isUnmodelled(entry)` and `typeof entry[hook] === "function"`.')
  lines.push('   - `onOffensiveMultiplier`, `onDefensiveMultiplier`, `onStat`, `onStab`, `onCrit`, `onTypeEffectiveness`, `onAfterTypeEffectiveness`, `onChooseOffensiveStat`, `onChooseDefensiveStat`, `onSwapSplit`, `onMoveType`, `onRecoil`, `onPriority`, `onMoldBreaker`, `onParentalBond`, `onAbsorb`, `onImmune`, `onInfiltrate`, `onModifyMoveFlags`.')
  lines.push('2. **onAttacker**: Membership in exported `PORTED_ATTACKER_ABILITIES` (`web/src/engine/sim/moveEnd.ts`).')
  lines.push('3. **onDefender**: Membership in exported `PORTED_DEFENDER_ABILITIES` (`web/src/engine/sim/moveEnd.ts`).')
  lines.push('4. **onEntry**: Handled across weather/terrain/entry-move/intimidate/announce dispatch in `applySwitchInAbilities` (`web/src/engine/sim/switchInAbility.ts`), catalogued by exported `SWITCH_IN_ABILITY_IDS`.')
  lines.push('5. **onEndTurn**: `runEndTurnAbilities` switch cases in `web/src/engine/sim/endTurn.ts`.')
  lines.push('6. **onAccuracy**: Cases in `runAttackerAbilityHook` and `runDefenderAbilityHook` in `web/src/engine/sim/accuracy.ts`.')
  lines.push('7. **onBattlerFaints**: Dispatched in `web/src/engine/sim/moveEnd.ts` (`dispatchOnBattlerFaints`): `ABILITY_STRIKEOUT`, `SET_STATE_ON_EFFECT_ABILITIES` (`web/src/engine/sim/statusEffects.ts`), keys of `KO_STAT_RAISES`, `KO_SOUL_EATER_ABILITIES`, `KO_JAWS_OF_CARNAGE_ABILITIES`, and `KO_CRIT_BOOST_ABILITIES`. All other `ON_BATTLER_FAINTS_ABILITIES` hit the unmodelled note.')
  lines.push('8. **onBeforeAttack**: Not ported (no handler in `web/src/engine/`).')
  lines.push('9. **onBlockStatDrops**: Membership in exported `STAT_DROP_BLOCK_ABILITIES` (`web/src/engine/sim/statBuffs.ts`).')
  lines.push('10. **onCanStatusType**: Membership in exported `CAN_STATUS_TYPE_ABILITIES` (`web/src/engine/sim/statusEffects.ts`).')
  lines.push('11. **onCopyMove**: Not ported (gapped in `web/src/engine/sim/moveEnd.ts`).')
  lines.push('12. **onDisguise**: Not ported (bust handler not modelled; note in `web/src/engine/sim/moveEnd.ts`).')
  lines.push('13. **onExit**: Membership in exported `SWITCH_OUT_HOOK_ABILITIES` (`web/src/engine/sim/turn.ts`).')
  lines.push('14. **onModifyEffectChance**: Membership in exported `ON_MODIFY_EFFECT_CHANCE_ABILITIES` (`web/src/engine/sim/statusEffects.ts`).')
  lines.push('15. **onModifyTargetFlag**: Handled in `getBattlerBattleMoveTargetFlags` (`web/src/engine/sim/moveTargetFlags.ts`).')
  lines.push('16. **onPreemptAction**: Cases in `tryPreemptiveActions` (`web/src/engine/sim/preempt.ts`).')
  lines.push('17. **onReactive**: Handled in `runReactiveAbilityEffects` (`web/src/engine/sim/statBuffs.ts`): `POISON_PUPPETEER_CLONE_ABILITIES` (`SET_STATE_ON_EFFECT_ABILITIES`), `ABILITY_EGOIST`, `ABILITY_SHARING_IS_CARING`, `ABILITY_ACID_REFLUX`.')
  lines.push('18. **onRevive**: Handled in `latchRecurringNightmareOnFaint` (`web/src/engine/sim/turn.ts`, `ABILITY_RECURRING_NIGHTMARE`).')
  lines.push('19. **onStatLowered**: Membership in exported `ON_STAT_LOWERED_ABILITIES` (`web/src/engine/sim/ai/aiCheckBadMove.ts`), implemented in `ON_STAT_LOWERED_HOOKS` (`web/src/engine/sim/statBuffs.ts`).')
  lines.push('20. **onStatusImmune**: Membership in exported `STATUS_IMMUNE_ABILITIES` (`web/src/engine/sim/statusEffects.ts`).')
  lines.push('21. **onTerrain**: Cases in `dispatchOnTerrainChange` (`web/src/engine/sim/onWeather.ts`).')
  lines.push('22. **onTrap**: Membership in exported `TRAPPING_ABILITIES` (`web/src/engine/sim/escape.ts`).')
  lines.push('23. **onWeather**: Cases in `dispatchOnWeatherChange` (`web/src/engine/sim/onWeather.ts`).')
  lines.push('')

  // Section 3: Summary Table
  lines.push('## Hook Completeness Summary')
  lines.push('')
  lines.push('| Hook Kind | Defined | Ported | Unported | Unclassified | Mentioned in Tests |')
  lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |')
  for (const s of inventory.summaries) {
    lines.push(`| ${s.hook} | ${s.defined} | ${s.ported} | ${s.unported} | ${s.unclassified} | ${s.tested} |`)
  }
  lines.push(
    `| **Total** | **${inventory.totalDefined}** | **${inventory.totalPorted}** | **${inventory.totalUnported}** | **${inventory.totalUnclassified}** | **${inventory.totalTested}** |`,
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
      const testTag = p.tested ? ' *(mentioned in test)*' : ''
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
