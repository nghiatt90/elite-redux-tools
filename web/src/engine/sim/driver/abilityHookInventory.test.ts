/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ABILITY_HOOK_ALLOWLIST,
  HOOK_KINDS,
  classifyPair,
  extractAccuracyAbilities,
  extractBattlerFaintsExtraAbilities,
  extractCaseLabelsFromFunction,
  extractCopyMoveAbilities,
  extractEndTurnAbilities,
  extractFunctionSlice,
  extractPreemptActionAbilities,
  extractReactiveExtraAbilities,
  extractReviveAbilities,
  extractSimAbsorbExtraAbilities,
  extractTargetFlagAbilities,
  extractTerrainAbilities,
  extractWeatherAbilities,
  generateInventoryDoc,
  loadTestMentionedAbilities,
  runInventory,
  type AbilityHookRecord,
  type AllowlistEntry,
} from './abilityHookInventory'
import type { AbilityEntry, UnmodelledAbility } from '../../abilities/types'

const HOOKS_PATH = fileURLToPath(new URL('../../../../../data/v2.65beta/abilityHooks.json', import.meta.url))
const DOC_PATH = fileURLToPath(new URL('../../../../../docs/battle-sim/ability-hook-inventory.md', import.meta.url))
const ENGINE_DIR = fileURLToPath(new URL('../../', import.meta.url))

const abilityHooks: Record<string, AbilityHookRecord> = JSON.parse(readFileSync(HOOKS_PATH, 'utf-8'))

/**
 * Pinned today at 55 -- this number should only go DOWN.
 * Cycle 150g had moved onModifyMoveFlags from 10 unported to 3, because seven hooks gained a
 * returning-true flag-predicate branch. Cycle 150i reverts it to 10: a predicate branch is not a
 * port when the damage/immunity consumers still read the static move flags, and
 * MOVE_FLAG_CONSUMERS_WIRED is empty. That left 72 (the 150b/150f value 65 + the 7 reverted).
 * Cycle 162b ports Harukaze's, Generator's and Energized's onTerrain cases, which drops it to 69.
 * Cycle 150ibcd2 ports all four onCopyMove hooks (Dancer/Samba, Parroting, Lunar Affinity), dropping
 * it to 65. Cycle 150ibcd3 completes the onModifyMoveFlags consumer sweep: all six flag families are
 * wired, so all 10 pairs count as ported and the total drops to 55.
 */
export const UNPORTED_PAIR_COUNT = 55

/** Pinned today at 0 -- this number should only go DOWN. */
export const UNCLASSIFIED_PAIR_COUNT = 0

/**
 * Allowlist for pairs that are deliberately permanently unmodelled / out of scope.
 * Lives in the module (not this test) so other tests can assert it is not stale.
 */
export const ALLOWLIST: ReadonlyArray<AllowlistEntry> = ABILITY_HOOK_ALLOWLIST

describe('ability hook completeness inventory', () => {
  it('loads abilityHooks.json and asserts the hook key set equals the 41-kind list', () => {
    const presentHooks = new Set<string>()
    for (const record of Object.values(abilityHooks)) {
      if (record.hooks) {
        for (const hookName of Object.keys(record.hooks)) {
          presentHooks.add(hookName)
        }
      }
    }
    const sortedPresent = Array.from(presentHooks).sort()
    const sortedExpected = [...HOOK_KINDS].sort()
    expect(sortedPresent).toEqual(sortedExpected)
  })

  it('every (ability, hook) pair is classified exactly once as ported / unported / unclassified', () => {
    const mentioned = loadTestMentionedAbilities(ENGINE_DIR)
    const result = runInventory(abilityHooks, mentioned, ALLOWLIST)

    let totalPairsInData = 0
    for (const record of Object.values(abilityHooks)) {
      if (record.hooks) {
        totalPairsInData += Object.keys(record.hooks).length
      }
    }

    expect(result.classifications).toHaveLength(totalPairsInData)
    expect(result.totalDefined).toBe(totalPairsInData)
    expect(result.totalPorted + result.totalUnported + result.totalUnclassified + result.totalAllowlisted).toBe(
      totalPairsInData,
    )

    for (const c of result.classifications) {
      expect(['ported', 'unported', 'unclassified', 'allowlisted']).toContain(c.status)
    }
  })

  it('reports the current unported pair count -- this number should only go DOWN', () => {
    const mentioned = loadTestMentionedAbilities(ENGINE_DIR)
    const result = runInventory(abilityHooks, mentioned, ALLOWLIST)
    expect(result.totalUnported).toBe(UNPORTED_PAIR_COUNT)
  })

  it('reports the current unclassified pair count -- this number should only go DOWN', () => {
    const mentioned = loadTestMentionedAbilities(ENGINE_DIR)
    const result = runInventory(abilityHooks, mentioned, ALLOWLIST)
    expect(result.totalUnclassified).toBe(UNCLASSIFIED_PAIR_COUNT)
  })

  it('validates ALLOWLIST entries citation format', () => {
    const citationRegex = /(?:src\/)?(?:abilities\.cc|battle_util\.c|battle_script_commands\.c):\d+/
    for (const entry of ALLOWLIST) {
      expect(entry.citation).toMatch(citationRegex)
    }
  })

  it('synthetic allowlist test: an allowlisted pair is excluded from the unported count and counted as allowlisted', () => {
    const syntheticAllowlist: AllowlistEntry[] = [
      {
        ability: 'ABILITY_FABRICATED_ALLOWLIST',
        hook: 'onStat',
        citation: 'src/abilities.cc:9999',
      },
    ]

    const fabricatedData: Record<string, AbilityHookRecord> = {
      ABILITY_FABRICATED_ALLOWLIST: {
        id: 'ABILITY_FABRICATED_ALLOWLIST',
        sourceLine: 9999,
        hooks: {
          onStat: { form: 'lambda' },
        },
      },
    }

    const baseResult = runInventory(fabricatedData, new Set(), [])
    expect(baseResult.totalUnported).toBe(1)
    expect(baseResult.totalAllowlisted).toBe(0)

    const allowlistedResult = runInventory(fabricatedData, new Set(), syntheticAllowlist)
    expect(allowlistedResult.totalUnported).toBe(0)
    expect(allowlistedResult.totalAllowlisted).toBe(1)
    expect(allowlistedResult.totalPorted).toBe(baseResult.totalPorted)
  })

  it('negative cases: classifies UnmodelledAbility, unlisted ability, and unported alias target as unported', () => {
    // 1. Fabricated ability record with an UnmodelledAbility entry -> classified unported
    const unmodelledStub: UnmodelledAbility = {
      id: 'ABILITY_FABRICATED_UNMODELLED',
      src: 'src/abilities.cc:9999',
      unmodelled: 'Permanently unmodelled for testing',
    }
    const customLookup = (id: string): AbilityEntry | undefined => {
      if (id === 'ABILITY_FABRICATED_UNMODELLED') return unmodelledStub
      return undefined
    }

    const testData: Record<string, AbilityHookRecord> = {
      ABILITY_FABRICATED_UNMODELLED: {
        id: 'ABILITY_FABRICATED_UNMODELLED',
        sourceLine: 9999,
        hooks: {
          onOffensiveMultiplier: { form: 'lambda' },
        },
      },
      ABILITY_NOT_IN_ANY_LIST: {
        id: 'ABILITY_NOT_IN_ANY_LIST',
        sourceLine: 9998,
        hooks: {
          onAttacker: { form: 'lambda' },
        },
      },
      ABILITY_UNPORTED_ALIAS: {
        id: 'ABILITY_UNPORTED_ALIAS',
        sourceLine: 9997,
        hooks: {
          onAttacker: {
            form: 'alias',
            aliasTarget: 'ABILITY_NOT_IN_ANY_LIST',
            aliasHook: 'onAttacker',
          },
        },
      },
    }

    const status1 = classifyPair('ABILITY_FABRICATED_UNMODELLED', 'onOffensiveMultiplier', testData, {
      lookup: customLookup,
    })
    expect(status1).toBe('unported')

    // 2. Ability whose ID is in no list (moveEnd.ts:899 PORTED_ATTACKER_ABILITIES)
    const status2 = classifyPair('ABILITY_NOT_IN_ANY_LIST', 'onAttacker', testData, { lookup: customLookup })
    expect(status2).toBe('unported')

    // 3. Alias whose target is unported
    const status3 = classifyPair('ABILITY_UNPORTED_ALIAS', 'onAttacker', testData, { lookup: customLookup })
    expect(status3).toBe('unported')
  })

  it('each extractor returns a non-empty set and includes one known id', () => {
    const accuracy = extractAccuracyAbilities()
    expect(accuracy.size).toBeGreaterThan(0)
    expect(accuracy.has('ABILITY_COMPOUND_EYES')).toBe(true)

    const endTurn = extractEndTurnAbilities()
    expect(endTurn.size).toBeGreaterThan(0)
    expect(endTurn.has('ABILITY_SPEED_BOOST')).toBe(true)

    const preempt = extractPreemptActionAbilities()
    expect(preempt.size).toBeGreaterThan(0)
    expect(preempt.has('ABILITY_TAG')).toBe(true)

    const weather = extractWeatherAbilities()
    expect(weather.size).toBeGreaterThan(0)
    expect(weather.has('ABILITY_PROTOSYNTHESIS')).toBe(true)

    const terrain = extractTerrainAbilities()
    expect(terrain.size).toBeGreaterThan(0)
    expect(terrain.has('ABILITY_QUARK_DRIVE')).toBe(true)

    const targetFlags = extractTargetFlagAbilities()
    expect(targetFlags.size).toBeGreaterThan(0)
    expect(targetFlags.has('ABILITY_ARTILLERY')).toBe(true)

    const reactive = extractReactiveExtraAbilities()
    expect(reactive.size).toBeGreaterThan(0)
    expect(reactive.has('ABILITY_ACID_REFLUX')).toBe(true)

    const revive = extractReviveAbilities()
    expect(revive.size).toBeGreaterThan(0)
    expect(revive.has('ABILITY_RECURRING_NIGHTMARE')).toBe(true)

    const battlerFaints = extractBattlerFaintsExtraAbilities()
    expect(battlerFaints.size).toBeGreaterThan(0)
    expect(battlerFaints.has('ABILITY_STRIKEOUT')).toBe(true)

    const absorb = extractSimAbsorbExtraAbilities()
    expect(absorb.size).toBeGreaterThan(0)
    expect(absorb.has('ABILITY_FLASH_FIRE')).toBe(true)

    const copyMove = extractCopyMoveAbilities()
    expect(copyMove.size).toBe(4)
    expect(copyMove.has('ABILITY_DANCER')).toBe(true)
    expect(copyMove.has('ABILITY_LUNAR_AFFINITY')).toBe(true)
    expect(copyMove.has('ABILITY_PARROTING')).toBe(true)
    expect(copyMove.has('ABILITY_SAMBA')).toBe(true)
  })

  it('extractFunctionSlice throws if function declaration not found, and extractCaseLabelsFromFunction throws on 0 labels', () => {
    expect(() => extractFunctionSlice('function foo() {}', 'function bar(')).toThrow(
      'Function declaration not found: function bar(',
    )
    expect(() => extractCaseLabelsFromFunction('function foo() { return 1 }', 'function foo(')).toThrow(
      'Zero labels extracted for declaration: function foo(',
    )
  })

  it('inventory doc matches generated text (or writes doc when SIM_INVENTORY_WRITE=1)', () => {
    const mentioned = loadTestMentionedAbilities(ENGINE_DIR)
    const result = runInventory(abilityHooks, mentioned, ALLOWLIST)
    const generatedMarkdown = generateInventoryDoc(result, abilityHooks)

    if (process.env.SIM_INVENTORY_WRITE === '1') {
      writeFileSync(DOC_PATH, generatedMarkdown, 'utf-8')
      console.log(`Wrote ability hook inventory doc to ${DOC_PATH}`)
    }

    expect(existsSync(DOC_PATH)).toBe(true)
    const committedDoc = readFileSync(DOC_PATH, 'utf-8')
    expect(committedDoc).toBe(generatedMarkdown)
  })
})
