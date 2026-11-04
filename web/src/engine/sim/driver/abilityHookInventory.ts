import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
// Sim-side sets and cases
// ---------------------------------------------------------------------------

/** web/src/engine/sim/accuracy.ts:350-595 (runAttackerAbilityHook & runDefenderAbilityHook) */
export const PORTED_ACCURACY_ABILITIES = new Set<string>([
  'ABILITY_ANGELS_WRATH',
  'ABILITY_ARTILLERY',
  'ABILITY_BAD_LUCK',
  'ABILITY_BRAWLING_WYVERN',
  'ABILITY_CHANDELIER',
  'ABILITY_COMMANDER',
  'ABILITY_COMPOUND_EYES',
  'ABILITY_DEADEYE',
  'ABILITY_DEADLY_PRECISION',
  'ABILITY_DEPTH_EXPLORER',
  'ABILITY_ECHOLOCATION',
  'ABILITY_ENLIGHTENED',
  'ABILITY_FATAL_PRECISION',
  'ABILITY_FINAL_BLOW',
  'ABILITY_FLAWLESS_PRECISION',
  'ABILITY_GIFTED_MIND',
  'ABILITY_GLACIAL_GHOST',
  'ABILITY_GRIP_PINCER',
  'ABILITY_HUNTERS_MARK',
  'ABILITY_HUSTLE',
  'ABILITY_HYPNOTIC_TRANCE',
  'ABILITY_HYPNOTIST',
  'ABILITY_ILLUMINATE',
  'ABILITY_INNER_FOCUS',
  'ABILITY_IRON_BARRAGE',
  'ABILITY_KEEN_EYE',
  'ABILITY_LULLABY',
  'ABILITY_LUNAR_ECLIPSE',
  'ABILITY_MACH_3',
  'ABILITY_NO_GUARD',
  'ABILITY_OLE',
  'ABILITY_PIXIE_POWER',
  'ABILITY_PLASMA_LAMP',
  'ABILITY_QIGONG',
  'ABILITY_RADIANCE',
  'ABILITY_RAIN_SHROUD',
  'ABILITY_REFRIGERATOR',
  'ABILITY_ROUNDHOUSE',
  'ABILITY_SAND_VEIL',
  'ABILITY_SHINY_LIGHTNING',
  'ABILITY_SIGHTING_SYSTEM',
  'ABILITY_SMOKEY_MANEUVERS',
  'ABILITY_SNOW_CLOAK',
  'ABILITY_SUPER_SCOPE',
  'ABILITY_SWEEPING_EDGE',
  'ABILITY_SWEEPING_EDGE_PLUS',
  'ABILITY_UNLOCKED_POTENTIAL',
  'ABILITY_VICTORY_STAR',
  'ABILITY_WAY_OF_PRECISION',
  'ABILITY_WORLD_SERPENT',
])

/** web/src/engine/sim/endTurn.ts:960-1782 (runEndTurnAbilities cases) */
export const PORTED_END_TURN_ABILITIES = new Set<string>([
  'ABILITY_ACID_REFLUX',
  'ABILITY_APE_SHIFT',
  'ABILITY_APPLE_PIE',
  'ABILITY_BAD_DREAMS',
  'ABILITY_BIG_LEAVES',
  'ABILITY_BLOOD_PRICE',
  'ABILITY_CARETAKER',
  'ABILITY_CELESTIAL_BLESSING',
  'ABILITY_CHOKEHOLD',
  'ABILITY_CHRISTMAS_NIGHTMARE',
  'ABILITY_COLOR_SPECTRUM',
  'ABILITY_COOL_EXIT',
  'ABILITY_CRAVING',
  'ABILITY_CRYO_ARCHITECT',
  'ABILITY_CUD_CHEW',
  'ABILITY_DRY_SKIN',
  'ABILITY_DUAL_SHADOW',
  'ABILITY_DUNE_VEIL',
  'ABILITY_ETERNAL_BLESSING',
  'ABILITY_FLAME_COAT',
  'ABILITY_FLOWER_GIFT',
  'ABILITY_FORECAST',
  'ABILITY_FUNERAL_PYRE',
  'ABILITY_HARVEST',
  'ABILITY_HEALER',
  'ABILITY_HOME_RUN',
  'ABILITY_HONEY_GATHER',
  'ABILITY_HUNGER_SWITCH',
  'ABILITY_HYDRATION',
  'ABILITY_ICE_BODY',
  'ABILITY_LEAF_GUARD',
  'ABILITY_LIFE_STEAL',
  'ABILITY_LOCUST_SWARM',
  'ABILITY_MAXIMUM_ACCELERATION',
  'ABILITY_MOODY',
  'ABILITY_PATTERN_CHANGE',
  'ABILITY_PEACEFUL_REST',
  'ABILITY_PEACEFUL_SLUMBER',
  'ABILITY_POISON_ABSORB',
  'ABILITY_POWER_CONSTRUCT',
  'ABILITY_PURIFYING_WATERS',
  'ABILITY_RAIN_DISH',
  'ABILITY_REVELATION',
  'ABILITY_SAP_TRAP',
  'ABILITY_SCHOOLING',
  'ABILITY_SELF_REPAIR',
  'ABILITY_SELF_SUFFICIENT',
  'ABILITY_SERPENT_BIND',
  'ABILITY_SHED_SKIN',
  'ABILITY_SHIELDS_DOWN',
  'ABILITY_SOOTHSAYER',
  'ABILITY_SOUL_TAP',
  'ABILITY_SPEED_BOOST',
  'ABILITY_STRIKEOUT',
  'ABILITY_SUNDAE',
  'ABILITY_SUMO_WRESTLER',
  'ABILITY_SUNS_BOUNTY',
  'ABILITY_SWEET_DREAMS',
  'ABILITY_TALON_TRAP',
  'ABILITY_TENTALOCK',
  'ABILITY_TOXIC_SPILL',
  'ABILITY_TRASH_HEAP',
  'ABILITY_TRUANT',
  'ABILITY_WHITE_NOISE',
  'ABILITY_WINTER_THRONE',
  'ABILITY_WONDER_SCALE',
  'ABILITY_ZEN_MODE',
])

/** web/src/engine/sim/moveEnd.ts:5980-6065 (dispatchOnBattlerFaints) */
export const PORTED_BATTLER_FAINTS_ABILITIES = new Set<string>([
  'ABILITY_STRIKEOUT',
  ...SET_STATE_ON_EFFECT_ABILITIES,
  ...Object.keys(KO_STAT_RAISES),
  ...KO_SOUL_EATER_ABILITIES,
  ...KO_JAWS_OF_CARNAGE_ABILITIES,
  ...KO_CRIT_BOOST_ABILITIES,
])

/** web/src/engine/sim/preempt.ts:68-84 (tryPreemptiveActions) */
export const PORTED_PREEMPT_ACTION_ABILITIES = new Set<string>([
  'ABILITY_TAG',
  'ABILITY_DREAMCATCHER',
  'ABILITY_DREAMSCAPE',
  'ABILITY_SUPER_SNIPER',
  'ABILITY_SURPRISE',
])

/** web/src/engine/sim/onWeather.ts:117-154 (dispatchOnWeatherChange) */
export const PORTED_WEATHER_ABILITIES = new Set<string>([
  'ABILITY_CHRISTMAS_NIGHTMARE',
  'ABILITY_DISGUISE',
  'ABILITY_FLARE_BOOST',
  'ABILITY_FLOWER_GIFT',
  'ABILITY_FORECAST',
  'ABILITY_ICE_FACE',
  'ABILITY_MADNESS_ENHANCEMENT',
  'ABILITY_PROTOSYNTHESIS',
])

/** web/src/engine/sim/onWeather.ts:182-198 (dispatchOnTerrainChange) */
export const PORTED_TERRAIN_ABILITIES = new Set<string>([
  'ABILITY_DRAKELP_HEAD',
  'ABILITY_MIMICRY',
  'ABILITY_QUARK_DRIVE',
  'ABILITY_TOXIC_BOOST',
])

/** web/src/engine/sim/moveTargetFlags.ts:77-94 (getBattlerBattleMoveTargetFlags) */
export const PORTED_TARGET_FLAG_ABILITIES = new Set<string>([
  'ABILITY_AMPLIFIER',
  'ABILITY_ARTILLERY',
  'ABILITY_BASS_BOOSTED',
  'ABILITY_SUPER_SCOPE',
  'ABILITY_SWEEPING_EDGE',
  'ABILITY_SWEEPING_EDGE_PLUS',
  'ABILITY_WIND_CHIMES',
])

/** web/src/engine/sim/statBuffs.ts:1214-1275 (runReactiveAbilityEffects) */
export const PORTED_REACTIVE_ABILITIES = new Set<string>([
  ...SET_STATE_ON_EFFECT_ABILITIES,
  'ABILITY_ACID_REFLUX',
  'ABILITY_EGOIST',
  'ABILITY_SHARING_IS_CARING',
])

/** web/src/engine/sim/turn.ts:1411-1430 (latchRecurringNightmareOnFaint) */
export const PORTED_REVIVE_ABILITIES = new Set<string>(['ABILITY_RECURRING_NIGHTMARE'])

/** web/src/engine/sim/absorb.ts:41-110 (HEAL_ABSORB_ABILITIES, STAT_ABSORB_ABILITIES, Flash Fire/Evaporate) */
export const PORTED_SIM_ABSORB_ABILITIES = new Set<string>([
  ...HEAL_ABSORB_ABILITIES,
  ...STAT_ABSORB_ABILITIES,
  'ABILITY_FLASH_FIRE',
  'ABILITY_EVAPORATE',
  'ABILITY_ELEMENTAL_VORTEX',
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

/**
 * Generates the deterministic markdown content for docs/battle-sim/ability-hook-inventory.md.
 */
export function generateInventoryDoc(
  inventory: InventoryResult,
  abilityHooksData: Record<string, AbilityHookRecord>,
): string {
  const lines: string[] = []

  // Section 1: Header
  lines.push('# Ability Hook Completeness Inventory')
  lines.push('')
  lines.push('Static completeness audit of all ability hooks defined in `data/v2.65beta/abilityHooks.json` against the battle simulator and damage engine implementations.')
  lines.push('')
  lines.push('- **Source Commit (eliteredux-source)**: `bdebcbbff9760cdd41a02c425bea4857fa0eee26` (game version `v2.65beta`)')
  lines.push('- **Source Commit (er-config)**: `1b8e2cc4a8096d7ec90616f87fbf771bfa732447`')
  lines.push('- **Regeneration Command**: `SIM_INVENTORY_WRITE=1 npm --prefix web test -- --run src/engine/sim/driver/abilityHookInventory.test.ts`')
  lines.push('')

  // Section 2: Classification Method per Hook Kind
  lines.push('## Classification Method per Hook Kind')
  lines.push('')
  lines.push('A `(ability, hook)` pair is classified as **ported** only when an explicit registry entry or case branch handles that exact ability and hook (or transitively through its `form: "alias"` target). Below are the detection mechanisms per hook kind:')
  lines.push('')
  lines.push('1. **Calc-side hooks (19 kinds)**: Checked via `lookupAbility(id)` in `web/src/engine/abilities/registry.ts` (populated by `web/src/engine/abilities/impl/index.ts`). Ported iff `!isUnmodelled(entry)` and `typeof entry[hook] === "function"`.')
  lines.push('   - `onOffensiveMultiplier`, `onDefensiveMultiplier`, `onStat`, `onStab`, `onCrit`, `onTypeEffectiveness`, `onAfterTypeEffectiveness`, `onChooseOffensiveStat`, `onChooseDefensiveStat`, `onSwapSplit`, `onMoveType`, `onRecoil`, `onPriority`, `onMoldBreaker`, `onParentalBond`, `onAbsorb`, `onImmune`, `onInfiltrate`, `onModifyMoveFlags`.')
  lines.push('2. **onAttacker**: Membership in exported `PORTED_ATTACKER_ABILITIES` (`web/src/engine/sim/moveEnd.ts:899`).')
  lines.push('3. **onDefender**: Membership in exported `PORTED_DEFENDER_ABILITIES` (`web/src/engine/sim/moveEnd.ts:748`).')
  lines.push('4. **onEntry**: Handled across weather/terrain/entry-move/intimidate/announce dispatch in `applySwitchInAbilities` (`web/src/engine/sim/switchInAbility.ts:1365-2486`), catalogued by exported `SWITCH_IN_ABILITY_IDS` (`:196`).')
  lines.push('5. **onEndTurn**: `runEndTurnAbilities` switch cases in `web/src/engine/sim/endTurn.ts:960-1782`.')
  lines.push('6. **onAccuracy**: Cases in `runAttackerAbilityHook` (lines 350-513) and `runDefenderAbilityHook` (lines 514-595) in `web/src/engine/sim/accuracy.ts`.')
  lines.push('7. **onBattlerFaints**: Dispatched in `web/src/engine/sim/moveEnd.ts:5980-6065`: `ABILITY_STRIKEOUT`, `SET_STATE_ON_EFFECT_ABILITIES` (`web/src/engine/sim/statusEffects.ts:285`), keys of `KO_STAT_RAISES` (`moveEnd.ts:5846`), `KO_SOUL_EATER_ABILITIES` (`:5874`), `KO_JAWS_OF_CARNAGE_ABILITIES` (`:5890`), and `KO_CRIT_BOOST_ABILITIES` (`:5897`). All other `ON_BATTLER_FAINTS_ABILITIES` hit the unmodelled note at line 6062.')
  lines.push('8. **onBeforeAttack**: Not ported (no handler in `web/src/engine/`).')
  lines.push('9. **onBlockStatDrops**: Membership in exported `STAT_DROP_BLOCK_ABILITIES` (`web/src/engine/sim/statBuffs.ts:211`).')
  lines.push('10. **onCanStatusType**: Membership in exported `CAN_STATUS_TYPE_ABILITIES` (`web/src/engine/sim/statusEffects.ts:230`).')
  lines.push('11. **onCopyMove**: Not ported (gapped in `web/src/engine/sim/moveEnd.ts:15`).')
  lines.push('12. **onDisguise**: Not ported (bust handler not modelled; note in `web/src/engine/sim/moveEnd.ts:3174`).')
  lines.push('13. **onExit**: Membership in exported `SWITCH_OUT_HOOK_ABILITIES` (`web/src/engine/sim/turn.ts:1498`).')
  lines.push('14. **onModifyEffectChance**: Membership in exported `ON_MODIFY_EFFECT_CHANCE_ABILITIES` (`web/src/engine/sim/statusEffects.ts:1848`).')
  lines.push('15. **onModifyTargetFlag**: Handled in `getBattlerBattleMoveTargetFlags` (`web/src/engine/sim/moveTargetFlags.ts:58-96`).')
  lines.push('16. **onPreemptAction**: Cases in `tryPreemptiveActions` (`web/src/engine/sim/preempt.ts:68-84`).')
  lines.push('17. **onReactive**: Handled in `runReactiveAbilityEffects` (`web/src/engine/sim/statBuffs.ts:1214-1275`): `POISON_PUPPETEER_CLONE_ABILITIES` (`SET_STATE_ON_EFFECT_ABILITIES`), `ABILITY_EGOIST`, `ABILITY_SHARING_IS_CARING`, `ABILITY_ACID_REFLUX`.')
  lines.push('18. **onRevive**: Handled in `latchRecurringNightmareOnFaint` (`web/src/engine/sim/turn.ts:1411-1430`, `ABILITY_RECURRING_NIGHTMARE`).')
  lines.push('19. **onStatLowered**: Membership in exported `ON_STAT_LOWERED_ABILITIES` (`web/src/engine/sim/ai/aiCheckBadMove.ts:368`), implemented in `ON_STAT_LOWERED_HOOKS` (`web/src/engine/sim/statBuffs.ts:930-1030`).')
  lines.push('20. **onStatusImmune**: Membership in exported `STATUS_IMMUNE_ABILITIES` (`web/src/engine/sim/statusEffects.ts:181`).')
  lines.push('21. **onTerrain**: Cases in `dispatchOnTerrainChange` (`web/src/engine/sim/onWeather.ts:182-198`).')
  lines.push('22. **onTrap**: Membership in exported `TRAPPING_ABILITIES` (`web/src/engine/sim/escape.ts:22`).')
  lines.push('23. **onWeather**: Cases in `dispatchOnWeatherChange` (`web/src/engine/sim/onWeather.ts:117-154`).')
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
  lines.push('## Bitfield-Only Abilities')
  lines.push('')
  lines.push('Abilities that define no hook lambdas in `abilityHooks.json`, only flags/bitfields. Total: **36 abilities**.')
  lines.push('')
  lines.push('### Bitfield Implementation Status in Engine & Sim Code')
  lines.push('')
  lines.push('| Bitfield | Read by Code? | Citing Files |')
  lines.push('| :--- | :--- | :--- |')
  lines.push('| `adaptability` | Yes | `web/src/engine/calculate.ts` |')
  lines.push('| `breakable` | Yes | `web/src/engine/calculate.ts`, `web/src/engine/sim/statusEffects.ts`, `web/src/engine/sim/accuracy.ts` |')
  lines.push('| `chloroplast` | Yes | `web/src/engine/basePower.ts`, `web/src/engine/multiHit.ts`, `web/src/engine/sim/moveEffects.ts` |')
  lines.push('| `fortKnox` | Yes | `web/src/engine/abilities/dispatchCalc.ts` |')
  lines.push('| `grappler` | Yes | `web/src/engine/sim/endTurn.ts`, `web/src/engine/sim/moveEnd.ts` |')
  lines.push('| `magicBounce` | No | *(not read by sim or engine code)* |')
  lines.push('| `magicGuard` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/sim/endTurn.ts` |')
  lines.push('| `mirrorArmor` | Yes | `web/src/engine/sim/hazards.ts` |')
  lines.push('| `noRecoil` | Yes | `web/src/engine/abilities/dispatchCalc.ts`, `web/src/engine/sim/moveEnd.ts`, `web/src/engine/sim/turn.ts` |')
  lines.push('| `persistent` | Yes | `web/src/engine/abilities/impl/14-on-stat-a.ts`, `web/src/engine/sim/ai/aiPipeline.ts` |')
  lines.push('| `powderImmune` | Yes | `web/src/engine/sim/attackCanceller.ts`, `web/src/engine/sim/statusEffects.ts` |')
  lines.push('| `randomizerBanned` | No | *(pipeline/randomizer metadata only)* |')
  lines.push('| `removesStatusOnImmunity` | Yes | `web/src/engine/sim/statusEffects.ts`, `web/src/engine/sim/moveEnd.ts` |')
  lines.push('| `ripen` | Yes | `web/src/engine/calculate.ts`, `web/src/engine/sim/accuracy.ts`, `web/src/engine/sim/moveEffects.ts` |')
  lines.push('| `skillLink` | Yes | `web/src/engine/calculate.ts`, `web/src/engine/abilities/dispatchCalc.ts` |')
  lines.push('| `steadfast` | No | *(not read by sim or engine code)* |')
  lines.push('| `stickyHold` | No | *(not read by sim or engine code)* |')
  lines.push('| `suctionCups` | Yes | `web/src/engine/sim/moveEffects.ts`, `web/src/engine/sim/ai/aiCheckBadMove.ts` |')
  lines.push('| `toxicTerrainImmune` | Yes | `web/src/engine/sim/fieldEndTurn.ts` |')
  lines.push('| `unaware` | Yes | `web/src/engine/calculate.ts`, `web/src/engine/sim/accuracy.ts`, `web/src/engine/sim/moveEffects.ts` |')
  lines.push('| `unsuppressable` | Yes | `web/src/engine/sim/ai/aiAbilityHelpers.ts` |')
  lines.push('')
  lines.push('### Complete List of 36 Bitfield-Only Abilities')
  lines.push('')

  const bitfieldOnlyIds = Object.keys(abilityHooksData)
    .filter((id) => {
      const rec = abilityHooksData[id]
      return !rec.hooks || Object.keys(rec.hooks).length === 0
    })
    .sort()

  for (const id of bitfieldOnlyIds) {
    const rec = abilityHooksData[id]
    const bfs = rec.bitfields ? Object.keys(rec.bitfields).sort().join(', ') : 'none'
    lines.push(`- \`${id}\` (src/abilities.cc:${rec.sourceLine}): ${bfs}`)
  }
  lines.push('')

  return lines.join('\n')
}
