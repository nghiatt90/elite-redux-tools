/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HOOK_KINDS,
  classifyPair,
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

/** Pinned today at 54 -- this number should only go DOWN. */
export const UNPORTED_PAIR_COUNT = 54

/** Pinned today at 0 -- this number should only go DOWN. */
export const UNCLASSIFIED_PAIR_COUNT = 0

/**
 * Allowlist for pairs that are deliberately permanently unmodelled / out of scope.
 * Empty today. Every entry must cite its upstream source location.
 */
export const ALLOWLIST: ReadonlyArray<AllowlistEntry> = []

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
    expect(result.totalPorted + result.totalUnported + result.totalUnclassified).toBe(totalPairsInData)

    for (const c of result.classifications) {
      expect(['ported', 'unported', 'unclassified']).toContain(c.status)
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

  it('synthetic allowlist test: an allowlisted pair is excluded from the unported count', () => {
    const syntheticAllowlist: AllowlistEntry[] = [
      {
        ability: 'ABILITY_AERILATE',
        hook: 'onStat',
        citation: 'src/abilities.cc:2502',
      },
    ]

    const baseResult = runInventory(abilityHooks, new Set(), [])
    expect(baseResult.totalUnported).toBe(UNPORTED_PAIR_COUNT)

    const allowlistedResult = runInventory(abilityHooks, new Set(), syntheticAllowlist)
    expect(allowlistedResult.totalUnported).toBe(UNPORTED_PAIR_COUNT - 1)
    expect(allowlistedResult.totalPorted).toBe(baseResult.totalPorted + 1)
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
