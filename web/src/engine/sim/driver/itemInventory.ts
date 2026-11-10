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

export interface KnownPartialEntry {
  key: string
  whatDiffers: string
  cite: string
}

export interface SitePortTarget {
  files: string[]
  functionName?: string
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
  /** True when the site has no entry in C_SITE_SIM_MAP. */
  unmappedSite?: boolean
  /** Reason why a known partial port is kept unported. */
  partialReason?: string
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

export const KNOWN_PARTIAL_PORTS: ReadonlyArray<KnownPartialEntry> = [
  {
    key: 'HOLD_EFFECT_LIFE_ORB@battle_util.c:ITEMEFFECT_LIFEORB_SHELLBELL',
    whatDiffers:
      'no canProc / gQueuedAttackCount gate and targetDamage > 0 instead of damagedMons check',
    cite: 'pipeline/.upstream/eliteredux-source/src/battle_util.c:6085',
  },
]

export const C_SITE_SIM_MAP: Record<string, SitePortTarget> = {
  ITEMEFFECT_ON_SWITCH_IN: {
    files: ['web/src/engine/sim/switchIn.ts'],
    functionName: 'switchIn',
  },
  'ENDTURN_ITEMS1/2': {
    files: ['web/src/engine/sim/endTurn.ts'],
    functionName: 'runEndTurnEffects',
  },
  ENDTURN_ITEMS1: {
    files: ['web/src/engine/sim/endTurn.ts'],
    functionName: 'runEndTurnEffects',
  },
  ENDTURN_ITEMS2: {
    files: ['web/src/engine/sim/endTurn.ts'],
    functionName: 'runEndTurnEffects',
  },
  ITEMEFFECT_TARGET: {
    files: ['web/src/engine/sim/moveEnd.ts'],
    functionName: 'runMoveEnd',
  },
  ITEMEFFECT_MOVE_END: {
    files: ['web/src/engine/sim/moveEnd.ts'],
  },
  ITEMEFFECT_KINGSROCK: {
    files: ['web/src/engine/sim/moveEnd.ts'],
    functionName: 'applyKingsRock',
  },
  ITEMEFFECT_LIFEORB_SHELLBELL: {
    files: ['web/src/engine/sim/moveEnd.ts'],
    functionName: 'runMoveEnd',
  },
  ITEMEFFECT_ORBS: {
    files: ['web/src/engine/sim/endTurn.ts'],
    functionName: 'runEndTurnEffects',
  },
  GetBattlerTotalSpeedStat: {
    files: ['web/src/engine/sim/turnOrder.ts'],
    functionName: 'getBattlerTotalSpeedStat',
  },
  CanBattlerGetOrLoseItem: {
    files: ['web/src/engine/sim/moveEffects.ts', 'web/src/engine/sim/moveEnd.ts'],
    functionName: 'canBattlerGetOrLoseItem',
  },
  TryPrimalReversion: {
    files: ['web/src/engine/sim/formChange.ts'],
    functionName: 'tryPrimalReversion',
  },
  CanMegaEvolve: {
    files: ['web/src/engine/sim/formChange.ts'],
    functionName: 'canMegaEvolve',
  },
  Cmd_various: {
    files: [],
  },
  BENEFITS_FROM_LEEK: {
    files: ['web/src/engine/crit.ts'],
  },
  CalcAttackStat: {
    files: ['web/src/engine/calculate.ts', 'web/src/engine/battleStat.ts'],
  },
  CalcDefenseStat: {
    files: ['web/src/engine/calculate.ts', 'web/src/engine/battleStat.ts'],
  },
  CalcFinalDmg: {
    files: ['web/src/engine/finalDamage.ts', 'web/src/engine/calculate.ts'],
  },
  CalcMoveBasePowerAfterModifiers: {
    files: ['web/src/engine/basePower.ts'],
  },
  CalcCritChanceStage: {
    files: ['web/src/engine/crit.ts'],
  },
  CheckGroundingEffects: {
    files: ['web/src/engine/sim/grounding.ts', 'web/src/engine/calculate.ts'],
  },
  CheckLevitatingEffects: {
    files: ['web/src/engine/sim/grounding.ts', 'web/src/engine/calculate.ts'],
  },
  CanBattlerEscape: {
    files: ['web/src/engine/sim/escape.ts'],
  },
  IsAbilityPreventingEscape: {
    files: ['web/src/engine/sim/escape.ts'],
  },
  IsBattlerAffectedByHazards: {
    files: ['web/src/engine/sim/hazards.ts'],
  },
  SetActionsAndBattlersTurnOrder: {
    files: ['web/src/engine/sim/turnOrder.ts'],
  },
  GetMoveSpeed: {
    files: ['web/src/engine/sim/turnOrder.ts'],
  },
  MulByTypeEffectiveness: {
    files: ['web/src/engine/typeEffectiveness.ts', 'web/src/engine/calculate.ts'],
  },
  DoBattlerEndTurnEffects: {
    files: ['web/src/engine/sim/endTurn.ts'],
  },
  DoesBattlerHaveAbilityShield: {
    files: ['web/src/engine/sim/turnOrder.ts'],
  },
  GetDrainedBigRootHp: {
    files: ['web/src/engine/sim/moveEnd.ts'],
  },
  GetMultihitType: {
    files: ['web/src/engine/multiHit.ts', 'web/src/engine/calculate.ts'],
  },
  GetTotalAccuracy: {
    files: ['web/src/engine/sim/accuracy.ts'],
  },
  IsMoveMakingContact: {
    files: ['web/src/engine/sim/moveEnd.ts'],
  },
  IsPowderImmune: {
    files: ['web/src/engine/sim/statusEffects.ts'],
  },
  SetMoveEffect: {
    files: ['web/src/engine/sim/moveEffects.ts'],
  },
  SetSwapDamageCategory: {
    files: ['web/src/engine/calculate.ts'],
  },
  SetTypeBeforeUsingMove: {
    files: ['web/src/engine/calculate.ts'],
  },
  WrapDuration: {
    files: ['web/src/engine/sim/moveEffects.ts'],
  },
  sWeatherFlagsInfo: {
    files: ['web/src/engine/sim/switchInAbility.ts'],
  },
  CheckMoveLimitations: {
    files: ['web/src/engine/sim/attackCanceller.ts'],
  },
  Cmd_removeitem: {
    files: ['web/src/engine/sim/moveEffects.ts', 'web/src/engine/sim/moveEnd.ts'],
  },
  Cmd_setlightscreen: {
    files: ['web/src/engine/sim/moveEffects.ts', 'web/src/engine/sim/hitScripts.ts'],
  },
  Cmd_setreflect: {
    files: ['web/src/engine/sim/moveEffects.ts', 'web/src/engine/sim/hitScripts.ts'],
  },
  Cmd_accuracycheck: {
    files: ['web/src/engine/sim/accuracy.ts'],
  },
  Cmd_adjustdamage: {
    files: ['web/src/engine/sim/turn.ts'],
  },
  HandleTerrainMove: {
    files: ['web/src/engine/sim/moveEffects.ts'],
  },
  IsBattlerWeatherAffected: {
    files: ['web/src/engine/sim/turn.ts', 'web/src/engine/sim/moveEffects.ts'],
  },
  IsHailImmune: {
    files: ['web/src/engine/sim/fieldEndTurn.ts'],
  },
  IsSandImmune: {
    files: ['web/src/engine/sim/fieldEndTurn.ts'],
  },
  ProtosynthesisHandler: {
    files: ['web/src/engine/sim/onWeather.ts'],
  },
  QuarkDriveHandler: {
    files: ['web/src/engine/sim/onWeather.ts'],
  },
  StrikeoutClearFlags: {
    files: ['web/src/engine/sim/endTurn.ts'],
  },
  TryChangeBattleTerrain: {
    files: ['web/src/engine/sim/moveEffects.ts'],
  },
  TrySetCantSelectMoveBattleScript: {
    files: ['web/src/engine/sim/state.ts'],
  },
  GetBattlerWeight: {
    files: ['web/src/engine/sim/moveEffects.ts'],
  },
  ApplyTypeOverrideInformation: {
    files: ['web/src/engine/basePower.ts'],
  },
  AbilityBattleEffects: {
    files: ['web/src/engine/sim/moveEnd.ts', 'web/src/engine/sim/endTurn.ts'],
  },
  CanBattlerBeForceSwitched: {
    files: ['web/src/engine/sim/moveEnd.ts'],
  },
  HandleMimicry: {
    files: ['web/src/engine/sim/switchInAbility.ts', 'web/src/engine/sim/onWeather.ts'],
  },
  // Unported sites (functions absent from sim)
  AdjustFriendship: { files: [] },
  CheckQuickClaw_CustapBerryActivation: { files: [] },
  Cmd_getexp: { files: [] },
  Cmd_setmultihitcounter: { files: [] },
  GetEvolutionTargetSpecies: { files: [] },
  GetMonMoveType: { files: [] },
  IsRunningFromBattleImpossible: { files: [] },
  PlayStatChangeAnimation: { files: [] },
  TryRunFromBattle: { files: [] },
  UPDATE_FRIENDSHIP_FROM_ITEM: { files: [] },
  // AI sites
  AI_CheckBadMove: {
    files: ['web/src/engine/sim/ai/aiCheckBadMove.ts'],
    functionName: 'aiCheckBadMove',
  },
  AI_CheckViability: {
    files: ['web/src/engine/sim/ai/aiCheckViability.ts'],
    functionName: 'aiCheckViability',
  },
  AI_MoveMakesContact: {
    files: ['web/src/engine/sim/ai/aiCheckViability.ts'],
    functionName: 'aiMoveMakesContact',
  },
  WhichMoveBetter: {
    files: ['web/src/engine/sim/ai/aiCheckViability.ts'],
  },
  ShouldPivot: {
    files: ['web/src/engine/sim/ai/aiSwitching.ts'],
  },
  ShouldFakeOut: {
    files: ['web/src/engine/sim/ai/aiCheckViability.ts'],
  },
  IsBattlerTrapped: {
    files: ['web/src/engine/sim/ai/aiSwitching.ts'],
  },
  HasHealingItem: {
    files: ['web/src/engine/sim/ai/aiCheckViability.ts'],
  },
  IncreaseConfusionScore: {
    files: ['web/src/engine/sim/ai/aiCheckViability.ts'],
  },
  GetTrapDamage: {
    files: ['web/src/engine/sim/ai/aiCheckViability.ts'],
  },
  PartyBattlerShouldAvoidHazards: {
    files: ['web/src/engine/sim/ai/aiSwitching.ts'],
  },
  AI_DoubleBattle: {
    files: [], // Doubles AI not built
  },
}

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
const TOP_LEVEL_FUNCTION_RE = /^[A-Za-z_][A-Za-z0-9_ \t*]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/
const TOP_LEVEL_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_ \t*]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*(\[|=)/
const TEMPLATE_IMPL_RE = /^constexpr\s+Ability\s+(Impl<[A-Za-z0-9_]+>)\s*=/
const HOOK_MEMBER_RE = /^\s*\.([A-Za-z0-9_]+)\s*=/
const MACRO_RE = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function tokenAppears(source: string, token: string): boolean {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`).test(source)
}

/** Removes data-only note blocks that intentionally list identifiers without handling them. */
export function stripNoteOnlyBlocks(repoRelative: string, source: string): string {
  let out = source
  if (!repoRelative || repoRelative === 'web/src/engine/basePower.ts') {
    const start = out.indexOf('export const UNMODELLED_BASE_POWER_EFFECTS')
    if (start >= 0) {
      const end = out.indexOf('])', start)
      if (end >= 0) out = out.slice(0, start) + out.slice(end + 2)
    }
  }
  if (!repoRelative || repoRelative === 'web/src/engine/sim/switchIn.ts') {
    const start = out.indexOf('const SWITCH_IN_HOLD_EFFECTS')
    if (start >= 0) {
      const end = out.indexOf('])', start)
      if (end >= 0) out = out.slice(0, start) + out.slice(end + 2)
    }
  }
  if (!repoRelative || repoRelative === 'web/src/engine/sim/endTurn.ts') {
    const start = out.indexOf('const ITEMS_1_2_HOLD_EFFECTS')
    if (start >= 0) {
      const end = out.indexOf('])', start)
      if (end >= 0) out = out.slice(0, start) + out.slice(end + 2)
    }
  }
  if (!repoRelative || repoRelative === 'web/src/engine/sim/moveEnd.ts') {
    const start = out.indexOf('const TARGET_ITEM_EFFECTS')
    if (start >= 0) {
      const end = out.indexOf('])', start)
      if (end >= 0) out = out.slice(0, start) + out.slice(end + 2)
    }
  }
  if (!repoRelative || repoRelative === 'web/src/engine/sim/moveEffects.ts') {
    const token = "deps.grounding.holdEffectOf(i) === 'HOLD_EFFECT_ROOM_SERVICE'"
    const start = out.indexOf(token)
    if (start >= 0) {
      const ifStart = out.lastIndexOf('if', start)
      const end = out.indexOf('}', start)
      if (ifStart >= 0 && end >= 0) out = out.slice(0, ifStart) + out.slice(end + 1)
    }
  }
  return out
}

/** Drops skipped or todo test blocks: it.skip, describe.skip, test.skip, it.todo, test.todo, describe.todo. */
export function stripSkippedTests(source: string): string {
  let out = source
  const pattern = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/
  while (true) {
    const match = pattern.exec(out)
    if (!match) break
    const start = match.index
    let i = start + match[0].length
    let depth = 1
    while (i < out.length && depth > 0) {
      const ch = out[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch
        i += 1
        while (i < out.length) {
          if (out[i] === '\\') {
            i += 2
          } else if (out[i] === quote) {
            i += 1
            break
          } else {
            i += 1
          }
        }
      } else if (ch === '(') {
        depth += 1
        i += 1
      } else if (ch === ')') {
        depth -= 1
        i += 1
      } else {
        i += 1
      }
    }
    out = out.slice(0, start) + ' '.repeat(i - start) + out.slice(i)
  }
  return out
}

/** Removes the string literal argument that is the test/describe title from it/test/describe calls. */
export function stripTestTitles(source: string): string {
  const pattern = /\b(?:it|test|describe)(?:\.[A-Za-z0-9_]+)*\s*\(\s*(['"`])/g
  let out = ''
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const quote = match[1]
    const quoteIndex = match.index + match[0].length - 1
    out += source.slice(lastIndex, quoteIndex + 1)
    let i = quoteIndex + 1
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2
      } else if (source[i] === quote) {
        break
      } else {
        i += 1
      }
    }
    out += ' '.repeat(Math.max(0, i - (quoteIndex + 1)))
    lastIndex = i
    pattern.lastIndex = i
  }
  out += source.slice(lastIndex)
  return out
}

/** Prepares test source by stripping comments, skipped test blocks, and title strings. */
export function cleanTestSource(source: string): string {
  return stripTestTitles(stripSkippedTests(stripComments(source)))
}

/** Extracts the body of a top-level function or exported function from source code. */
export function extractFunctionBody(source: string, functionName: string): string | null {
  const pattern = new RegExp(
    `(?:\\b(?:export\\s+)?(?:async\\s+)?function\\s+${functionName}\\b|\\b(?:export\\s+)?const\\s+${functionName}\\s*=\\s*(?:async\\s+)?(?:function\\b)?)`,
    'g',
  )
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    let pos = match.index + match[0].length

    // Skip whitespace and optional type parameters before '('
    while (pos < source.length && source[pos] !== '(' && /\s/.test(source[pos])) {
      pos += 1
    }
    if (source[pos] === '<') {
      let angleDepth = 1
      pos += 1
      while (pos < source.length && angleDepth > 0) {
        if (source[pos] === '<') angleDepth += 1
        else if (source[pos] === '>') angleDepth -= 1
        pos += 1
      }
      while (pos < source.length && source[pos] !== '(' && /\s/.test(source[pos])) {
        pos += 1
      }
    }
    if (source[pos] !== '(') continue

    // 1. Skip parameter list by balanced-paren scan from the first '('
    let parenDepth = 1
    let i = pos + 1
    while (i < source.length && parenDepth > 0) {
      const ch = source[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch
        i += 1
        while (i < source.length) {
          if (source[i] === '\\') {
            i += 2
          } else if (source[i] === q) {
            i += 1
            break
          } else {
            i += 1
          }
        }
      } else if (ch === '(') {
        parenDepth += 1
        i += 1
      } else if (ch === ')') {
        parenDepth -= 1
        i += 1
      } else {
        i += 1
      }
    }
    if (parenDepth > 0) continue

    // 2. Skip optional return annotation by scanning forward at depth 0
    let braceStart = -1
    let seenColon = false
    let lastToken = ''
    let parenDepthAfter = 0
    let bracketDepth = 0
    let angleDepth = 0
    let braceDepth = 0

    while (i < source.length) {
      const ch = source[i]
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch
        i += 1
        while (i < source.length) {
          if (source[i] === '\\') {
            i += 2
          } else if (source[i] === q) {
            i += 1
            break
          } else {
            i += 1
          }
        }
        continue
      }

      const atDepth0 = parenDepthAfter === 0 && bracketDepth === 0 && angleDepth === 0 && braceDepth === 0

      if (source.startsWith('=>', i)) {
        if (atDepth0) lastToken = '=>'
        i += 2
        continue
      }

      if (ch === '(') {
        parenDepthAfter += 1
        i += 1
      } else if (ch === ')') {
        parenDepthAfter = Math.max(0, parenDepthAfter - 1)
        i += 1
      } else if (ch === '[') {
        bracketDepth += 1
        i += 1
      } else if (ch === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1)
        i += 1
      } else if (ch === '<') {
        angleDepth += 1
        i += 1
      } else if (ch === '>') {
        angleDepth = Math.max(0, angleDepth - 1)
        i += 1
      } else if (ch === '{') {
        if (atDepth0) {
          if (seenColon && (lastToken === ':' || lastToken === '|' || lastToken === '&')) {
            braceDepth += 1
            lastToken = '{'
            i += 1
          } else {
            braceStart = i
            break
          }
        } else {
          braceDepth += 1
          i += 1
        }
      } else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1)
        if (parenDepthAfter === 0 && bracketDepth === 0 && angleDepth === 0 && braceDepth === 0) {
          lastToken = '}'
        }
        i += 1
      } else {
        if (atDepth0 && !/\s/.test(ch)) {
          if (ch === ':') {
            seenColon = true
            lastToken = ':'
          } else if (ch === '|' || ch === '&') {
            lastToken = ch
          } else {
            lastToken = ch
          }
        }
        i += 1
      }
    }

    if (braceStart === -1) continue

    // 3. Scan the function body until matching '}'
    let depth = 1
    let bodyIdx = braceStart + 1
    while (bodyIdx < source.length && depth > 0) {
      const ch = source[bodyIdx]
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch
        bodyIdx += 1
        while (bodyIdx < source.length) {
          if (source[bodyIdx] === '\\') bodyIdx += 2
          else if (source[bodyIdx] === q) {
            bodyIdx += 1
            break
          } else {
            bodyIdx += 1
          }
        }
      } else if (ch === '{') {
        depth += 1
        bodyIdx += 1
      } else if (ch === '}') {
        depth -= 1
        bodyIdx += 1
      } else {
        bodyIdx += 1
      }
    }
    return source.slice(braceStart + 1, bodyIdx - 1)
  }
  return null
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

/** Non-test, non-AI engine sources outside `sim/driver/`, comment-stripped and note-only-stripped. */
export function loadEngineProductionFiles(): SourceFile[] {
  return collectEngineFiles(
    (repoRel, isTest) =>
      !isTest &&
      !repoRel.startsWith('web/src/engine/sim/driver/') &&
      !repoRel.startsWith('web/src/engine/sim/ai/'),
  ).map((file) => ({
    file: file.file,
    source: stripNoteOnlyBlocks(file.file, stripComments(file.source)),
  }))
}

/** Non-test engine sources under `sim/ai/`, comment-stripped. */
export function loadEngineAiProductionFiles(): SourceFile[] {
  return collectEngineFiles(
    (repoRel, isTest) => !isTest && repoRel.startsWith('web/src/engine/sim/ai/'),
  ).map((file) => ({ file: file.file, source: stripComments(file.source) }))
}

/** Engine test sources outside `sim/driver/` and `sim/ai/`, excluding this inventory's own test file. */
export function loadEngineTestFiles(): SourceFile[] {
  return collectEngineFiles(
    (repoRel, isTest) =>
      isTest &&
      !repoRel.endsWith('Inventory.test.ts') &&
      !repoRel.startsWith('web/src/engine/sim/driver/') &&
      !repoRel.startsWith('web/src/engine/sim/ai/'),
  ).map((file) => ({
    file: file.file,
    source: cleanTestSource(file.source),
  }))
}

/** Engine test sources under `sim/ai/`, cleaned. */
export function loadEngineAiTestFiles(): SourceFile[] {
  return collectEngineFiles(
    (repoRel, isTest) => isTest && repoRel.startsWith('web/src/engine/sim/ai/'),
  ).map((file) => ({
    file: file.file,
    source: cleanTestSource(file.source),
  }))
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
  let hookMember: string | null = null
  for (let index = lineNumber - 2; index >= 0; index -= 1) {
    const text = lines[index]
    if (text.startsWith(' ') || text.startsWith('\t')) {
      if (!hookMember) {
        const hookMatch = text.match(HOOK_MEMBER_RE)
        if (hookMatch) hookMember = hookMatch[1]
      }
      continue
    }
    if (text.trimStart().startsWith('#')) continue
    const implMatch = text.match(TEMPLATE_IMPL_RE)
    if (implMatch) {
      return hookMember ? `${implMatch[1]}.${hookMember}` : implMatch[1]
    }
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

/** Locates `ItemBattleEffects` and its `switch (caseID)` branches (1-indexed lines). */
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
      end = index
      break
    }
  }
  const cases: Array<{ line: number; name: string }> = []
  let insideSwitch = false
  let depth = 0
  for (let index = start - 1; index < end; index += 1) {
    const line = index + 1
    const text = lines[index]
    if (!insideSwitch) {
      if (/switch\s*\(\s*caseID\s*\)/.test(text)) {
        insideSwitch = true
        depth = (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length
      }
    } else {
      if (depth === 1) {
        const match = text.match(/^\s*case\s+([^:]+):/)
        if (match) {
          const raw = match[1].trim()
          let name: string | null = null
          if (raw === '1') {
            name = 'ENDTURN_ITEMS1/2'
          } else if (raw === '0') {
            name = 'ITEMEFFECT_ON_SWITCH_IN'
          } else if (/^ITEMEFFECT_[A-Z_]+$/.test(raw)) {
            name = raw
          }
          if (name) cases.push({ line, name })
        }
      }
      depth += (text.match(/\{/g) || []).length - (text.match(/\}/g) || []).length
      if (depth <= 0) insideSwitch = false
    }
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
  const ppStack: boolean[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1
    const text = lines[index]
    const trimmed = text.trimStart()

    // Preprocessor #ifdef awareness: skip enum members inside #ifdef
    if (trimmed.startsWith('#')) {
      if (/^#\s*if(?:def|ndef)?\b/.test(trimmed)) {
        const parentActive = ppStack.length === 0 || ppStack[ppStack.length - 1]
        let active = true
        const m = trimmed.match(/^\s*#\s*(?:ifdef\s+([A-Za-z0-9_]+)|if\s+defined\s*\(\s*([A-Za-z0-9_]+)\s*\))/)
        if (m) {
          const sym = m[1] || m[2]
          if (sym.startsWith('HOLD_EFFECT_') || (sym.startsWith('ITEM_') && sym !== 'ITEM_EXPANSION')) {
            active = false
          }
        }
        ppStack.push(parentActive && active)
        continue
      } else if (/^#\s*else\b/.test(trimmed)) {
        if (ppStack.length > 0) {
          const parentActive = ppStack.length <= 1 || ppStack[ppStack.length - 2]
          ppStack[ppStack.length - 1] = parentActive && !ppStack[ppStack.length - 1]
        }
        continue
      } else if (/^#\s*elif\b/.test(trimmed)) {
        if (ppStack.length > 0) {
          const parentActive = ppStack.length <= 1 || ppStack[ppStack.length - 2]
          ppStack[ppStack.length - 1] = parentActive
        }
        continue
      } else if (/^#\s*endif\b/.test(trimmed)) {
        ppStack.pop()
        continue
      }
    }

    if (ppStack.length > 0 && !ppStack[ppStack.length - 1]) {
      continue
    }

    const tokens = text.match(HOLD_EFFECT_TOKEN_RE)
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

export interface TokenClassification {
  status: ItemUnitStatus
  registeredUntested: boolean
  testFile: string | null
}

export function classifyToken(
  token: string,
  productionSource: string,
  testSources: ReadonlyArray<SourceFile>,
  itemIds: ReadonlyArray<string> = [],
): TokenClassification {
  const production = tokenAppears(productionSource, token)
  const matchingFiles = testSources
    .filter((file) => {
      const clean = cleanTestSource(file.source)
      if (tokenAppears(clean, token)) return true
      for (const id of itemIds) {
        if (tokenAppears(clean, id)) return true
      }
      return false
    })
    .map((file) => file.file)
    .sort()
  const tested = matchingFiles.length > 0
  if (production && tested) return { status: 'ported', registeredUntested: false, testFile: matchingFiles[0] }
  if (production) return { status: 'unported', registeredUntested: true, testFile: null }
  return { status: 'unported', registeredUntested: false, testFile: matchingFiles[0] ?? null }
}

/** Checks production evidence for a given C site in the mapped function/file. */
export function checkProductionEvidenceForSite(
  site: string,
  token: string,
  productionFiles: ReadonlyArray<SourceFile>,
  fallbackProductionSource: string,
): { hasEvidence: boolean; unmappedSite: boolean } {
  const target = C_SITE_SIM_MAP[site]
  if (!target) {
    return {
      hasEvidence: tokenAppears(fallbackProductionSource, token),
      unmappedSite: true,
    }
  }

  if (target.files.length === 0) {
    return { hasEvidence: false, unmappedSite: false }
  }

  const matchedFiles = productionFiles.filter((f) => target.files.includes(f.file))
  if (matchedFiles.length === 0) {
    if (target.functionName) {
      const body = extractFunctionBody(fallbackProductionSource, target.functionName)
      return {
        hasEvidence: body !== null && tokenAppears(body, token),
        unmappedSite: false,
      }
    }
    return {
      hasEvidence: tokenAppears(fallbackProductionSource, token),
      unmappedSite: false,
    }
  }

  for (const f of matchedFiles) {
    if (target.functionName) {
      const body = extractFunctionBody(f.source, target.functionName)
      if (body && tokenAppears(body, token)) {
        return { hasEvidence: true, unmappedSite: false }
      }
    } else {
      if (tokenAppears(f.source, token)) {
        return { hasEvidence: true, unmappedSite: false }
      }
    }
  }

  return { hasEvidence: false, unmappedSite: false }
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
  productionFiles?: ReadonlyArray<SourceFile>
  productionSource?: string
  aiProductionFiles?: ReadonlyArray<SourceFile>
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

  const rawProductionFiles = options.productionFiles ?? (options.productionSource !== undefined
    ? [{ file: 'synthetic.ts', source: options.productionSource }]
    : loadEngineProductionFiles())

  const productionFiles = rawProductionFiles.map((f) => ({
    file: f.file,
    source: stripNoteOnlyBlocks(f.file, stripComments(f.source)),
  }))

  const fallbackProductionSource = options.productionSource !== undefined
    ? stripNoteOnlyBlocks('', stripComments(options.productionSource))
    : productionFiles.map((f) => f.source).join('\n')

  const aiProductionFiles = options.aiProductionFiles ?? (options.aiProductionSource !== undefined
    ? [{ file: 'synthetic-ai.ts', source: stripComments(options.aiProductionSource) }]
    : loadEngineAiProductionFiles())

  const fallbackAiProductionSource = options.aiProductionSource !== undefined
    ? stripComments(options.aiProductionSource)
    : aiProductionFiles.map((f) => f.source).join('\n')

  const rawTestSources = options.testSources ?? collectEngineFiles(
    (repoRel, isTest) => isTest && !repoRel.endsWith('Inventory.test.ts'),
  )

  const nonAiTestSources = rawTestSources.filter(
    (f) => !f.file.startsWith('web/src/engine/sim/ai/') && !f.file.startsWith('web/src/engine/sim/driver/'),
  )

  const allTestSources = rawTestSources.filter(
    (f) => !f.file.startsWith('web/src/engine/sim/driver/'),
  )

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
    const itemIds = itemsByEffect.get(hit.effect) ?? []
    const prodCheck = checkProductionEvidenceForSite(
      hit.site,
      hit.effect,
      productionFiles,
      fallbackProductionSource,
    )
    const matchingTests = nonAiTestSources
      .filter((file) => {
        const clean = cleanTestSource(file.source)
        if (tokenAppears(clean, hit.effect)) return true
        for (const id of itemIds) {
          if (tokenAppears(clean, id)) return true
        }
        return false
      })
      .map((f) => f.file)
      .sort()

    const hasTest = matchingTests.length > 0
    const allow = allowlistEntryFor(key, allowlist)
    const knownPartial = KNOWN_PARTIAL_PORTS.find((p) => p.key === key)
    const site = hit.site

    let status: ItemUnitStatus
    let registeredUntested = false

    if (site === '?') {
      status = 'unclassified'
    } else if (allow) {
      status = 'allowlisted'
    } else if (knownPartial) {
      status = 'unported'
      registeredUntested = false
    } else if (prodCheck.hasEvidence && hasTest) {
      status = 'ported'
    } else if (prodCheck.hasEvidence) {
      status = 'unported'
      registeredUntested = true
    } else {
      status = 'unported'
      registeredUntested = false
    }

    units.push({
      kind: 'hold-trigger',
      key,
      unit: hit.effect,
      effect: hit.effect,
      site,
      file: `${UPSTREAM_SRC}/${hit.file}`,
      citation: allow?.cite ?? `${UPSTREAM_SRC}/${hit.file}:${hit.line}`,
      status,
      registeredUntested,
      testFile: matchingTests[0] ?? null,
      itemIds,
      unmappedSite: prodCheck.unmappedSite,
      partialReason: knownPartial?.whatDiffers,
    })
  }

  for (const [key, hit] of aiHits) {
    const itemIds = itemsByEffect.get(hit.effect) ?? []
    const prodCheck = checkProductionEvidenceForSite(
      hit.site,
      hit.effect,
      aiProductionFiles,
      fallbackAiProductionSource,
    )
    const matchingTests = allTestSources
      .filter((file) => {
        const clean = cleanTestSource(file.source)
        if (tokenAppears(clean, hit.effect)) return true
        for (const id of itemIds) {
          if (tokenAppears(clean, id)) return true
        }
        return false
      })
      .map((f) => f.file)
      .sort()

    const hasTest = matchingTests.length > 0
    const allow = allowlistEntryFor(key, allowlist)
    const knownPartial = KNOWN_PARTIAL_PORTS.find((p) => p.key === key)
    const site = hit.site

    let status: ItemUnitStatus
    let registeredUntested = false

    if (site === '?') {
      status = 'unclassified'
    } else if (allow) {
      status = 'allowlisted'
    } else if (knownPartial) {
      status = 'unported'
      registeredUntested = false
    } else if (prodCheck.hasEvidence && hasTest) {
      status = 'ported'
    } else if (prodCheck.hasEvidence) {
      status = 'unported'
      registeredUntested = true
    } else {
      status = 'unported'
      registeredUntested = false
    }

    units.push({
      kind: 'ai-trigger',
      key,
      unit: hit.effect,
      effect: hit.effect,
      site,
      file: `${UPSTREAM_SRC}/${hit.file}`,
      citation: allow?.cite ?? `${UPSTREAM_SRC}/${hit.file}:${hit.line}`,
      status,
      registeredUntested,
      testFile: matchingTests[0] ?? null,
      itemIds,
      unmappedSite: prodCheck.unmappedSite,
      partialReason: knownPartial?.whatDiffers,
    })
  }

  const effectsWithHoldUnit = new Set([...holdHits.values()].map((hit) => hit.effect))
  for (const item of items) {
    if (!item.resolvedHoldEffect || item.resolvedHoldEffect === 'HOLD_EFFECT_NONE') continue
    if (effectsWithHoldUnit.has(item.resolvedHoldEffect)) continue
    const key = item.id
    const classification = classifyToken(key, fallbackProductionSource, nonAiTestSources, [key])
    const allow = allowlistEntryFor(key, allowlist)
    const knownPartial = KNOWN_PARTIAL_PORTS.find((p) => p.key === key)
    units.push({
      kind: 'item-data',
      key,
      unit: key,
      effect: item.resolvedHoldEffect,
      site: item.resolvedHoldEffect,
      file: ITEMS_REPO_REL,
      citation: allow?.cite ?? `none (data-only; ${ITEMS_REPO_REL})`,
      status: allow ? 'allowlisted' : knownPartial ? 'unported' : classification.status,
      registeredUntested: allow || knownPartial ? false : classification.registeredUntested,
      testFile: classification.testFile,
      itemIds: [item.id],
      partialReason: knownPartial?.whatDiffers,
    })
  }

  for (const item of items) {
    if (!item.naturalGift) continue
    const key = item.id
    const classification = classifyToken(key, fallbackProductionSource, nonAiTestSources, [key])
    const allow = allowlistEntryFor(key, allowlist)
    const knownPartial = KNOWN_PARTIAL_PORTS.find((p) => p.key === key)
    units.push({
      kind: 'natural-gift',
      key,
      unit: key,
      effect: 'naturalGift',
      site: 'naturalGift',
      file: `${UPSTREAM_SRC}/${FLING_FILE}`,
      citation: allow?.cite ?? NATURAL_GIFT_CITATIONS.join('; '),
      status: allow ? 'allowlisted' : knownPartial ? 'unported' : classification.status,
      registeredUntested: allow || knownPartial ? false : classification.registeredUntested,
      testFile: classification.testFile,
      itemIds: [item.id],
      partialReason: knownPartial?.whatDiffers,
    })
  }

  for (const fling of parseFlingItems(flingSource)) {
    const key = fling.itemId
    const classification = classifyToken(key, fallbackProductionSource, nonAiTestSources, [key])
    const allow = allowlistEntryFor(key, allowlist)
    const knownPartial = KNOWN_PARTIAL_PORTS.find((p) => p.key === key)
    units.push({
      kind: 'fling',
      key,
      unit: key,
      effect: 'VARIOUS_TRY_FLING',
      site: 'VARIOUS_TRY_FLING',
      file: `${UPSTREAM_SRC}/${FLING_FILE}`,
      citation: allow?.cite ?? `${UPSTREAM_SRC}/${FLING_FILE}:${fling.line}`,
      status: allow ? 'allowlisted' : knownPartial ? 'unported' : classification.status,
      registeredUntested: allow || knownPartial ? false : classification.registeredUntested,
      testFile: classification.testFile,
      itemIds: [fling.itemId],
      partialReason: knownPartial?.whatDiffers,
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
  if (unit.partialReason) return `unported (partial: ${unit.partialReason})`
  let base: string = unit.status
  if (unit.status === 'unported' && unit.registeredUntested) {
    base = 'unported (registered, untested)'
  }
  if (unit.unmappedSite) {
    return `${base} (site-unmapped)`
  }
  return base
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
    'A unit is **ported** only when its token appears in production source in the mapped function/file that ports that C site',
  )
  lines.push(
    'and in an engine test file outside `sim/ai/` (and `sim/driver/`). Production evidence excludes `sim/ai/` for non-AI units.',
  )
  lines.push(
    'Comments and note-only gap blocks (`SWITCH_IN_HOLD_EFFECTS`, `ITEMS_1_2_HOLD_EFFECTS`, `TARGET_ITEM_EFFECTS`, etc.)',
  )
  lines.push(
    'are stripped before scanning. Skipped tests (`it.skip`, `describe.skip`, `test.skip`, `it.todo`) and test title strings',
  )
  lines.push(
    'are removed so names alone do not count as test evidence. Tests that reference any item id carrying the effect also qualify.',
  )
  lines.push(
    '`registered, untested` means production handles the unit but no qualifying test names it; it is counted as unported.',
  )
  lines.push(
    'Sites without an explicit mapping fall back to any non-AI production file and are flagged in the doc as `site-unmapped`.',
  )
  lines.push(
    'Preprocessor `#ifdef` blocks for enum symbols (compiled out) are skipped. Allowlisted units require an exact pinned C `file:line`.',
  )
  lines.push('')
  lines.push(
    '1. **hold-trigger**: one unit per (resolved hold effect, C trigger site) in `battle_util.c`,',
  )
  lines.push(
    '   `battle_script_commands.c`, `battle_main.c`, `pokemon.c` and `abilities.cc`. The site is the enclosing',
  )
  lines.push(
    '   `ITEMEFFECT_*` case inside `ItemBattleEffects` (with numeric `case 1:` mapped to `ENDTURN_ITEMS1/2`),',
  )
  lines.push(
    '   top-level `constexpr Ability Impl<ABILITY_X> =` declaration in `abilities.cc`, or the nearest enclosing function/macro elsewhere.',
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

  if (KNOWN_PARTIAL_PORTS.length > 0) {
    lines.push('## Known Partial Ports')
    lines.push('')
    lines.push('Units whose production handling diverges from the pinned C in ways confirmed by manual audit.')
    lines.push('They are kept out of the ported count (status `unported` with a partial reason).')
    lines.push('')
    lines.push('| Unit key | What differs | C citation |')
    lines.push('| --- | --- | --- |')
    for (const partial of KNOWN_PARTIAL_PORTS) {
      lines.push(`| \`${partial.key}\` | ${partial.whatDiffers} | \`${partial.cite}\` |`)
    }
    lines.push('')
  }

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
