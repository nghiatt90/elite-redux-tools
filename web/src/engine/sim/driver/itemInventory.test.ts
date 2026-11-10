/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWLIST,
  ITEM_INVENTORY_DOC_PATH,
  generateItemInventoryDoc,
  isValidAllowlistCitation,
  loadHoldEffectIds,
  loadItems,
  runInventory,
  validateAllowlist,
  type ItemAllowlistEntry,
  type ItemRecord,
} from './itemInventory'

const items = loadItems()
const result = runInventory(items)

const ITEM_COUNT = 929
const DISTINCT_HOLD_EFFECTS = 133
// Re-pinned after cycle 152b: numeric case 1 gives ENDTURN_ITEMS1/2 its own site (+22), #ifdef removes HOLD_EFFECT_Z_CRYSTAL (-1)
const HOLD_TRIGGER_UNITS = 216
const AI_TRIGGER_UNITS = 57
// Re-pinned after cycle 152b: 34 Z-crystals become item-data units now that their #ifdef trigger is compiled out (+34)
const ITEM_DATA_UNITS = 43
// Re-pinned after cycle 152c: per-site natural-gift units (5) and fling units (11)
const NATURAL_GIFT_UNITS = 5
const FLING_UNITS = 11

// Re-pinned after cycle 152c: per-site natural-gift and fling units
export const UNPORTED_UNIT_COUNT = 216

// Re-pinned after cycle 152c: stricter fling test requirements and natural-gift per-site units
export const REGISTERED_UNTESTED_UNIT_COUNT = 28

/** Pinned today at 0 -- this number should only go DOWN. */
export const UNCLASSIFIED_UNIT_COUNT = 0

const FABRICATED_ITEM: ItemRecord = {
  id: 'ITEM_FABRICATED_HOLD',
  name: 'Fabricated Hold Item',
  grouping: 'POCKET_ITEMS',
  holdEffect: 'HOLD_EFFECT_FABRICATED',
  resolvedHoldEffect: 'HOLD_EFFECT_FABRICATED',
}

const FABRICATED_C = 'u8 FabricatedEffect(u8 battlerId) {\n    return HOLD_EFFECT_FABRICATED;\n}\n'

const SYNTHETIC_OPTIONS = {
  holdTriggerSources: { 'battle_util.c': FABRICATED_C },
  aiTriggerSources: {},
  flingSource: '',
  productionSource: '',
  aiProductionSource: '',
  testSources: [],
  allowlist: [] as ItemAllowlistEntry[],
}

describe('held-item completeness inventory', () => {
  it('loads items.json and every distinct non-NONE resolved hold effect', () => {
    expect(items).toHaveLength(ITEM_COUNT)
    expect(result.itemCount).toBe(ITEM_COUNT)
    expect(result.distinctHoldEffectCount).toBe(DISTINCT_HOLD_EFFECTS)
    const holdEffectIds = loadHoldEffectIds()
    for (const item of items) {
      expect(holdEffectIds).toHaveProperty(item.resolvedHoldEffect)
    }
  })

  it('enumerates every unit kind', () => {
    const count = (kind: string) => result.units.filter((unit) => unit.kind === kind).length
    expect(count('hold-trigger')).toBe(HOLD_TRIGGER_UNITS)
    expect(count('ai-trigger')).toBe(AI_TRIGGER_UNITS)
    expect(count('item-data')).toBe(ITEM_DATA_UNITS)
    expect(count('natural-gift')).toBe(NATURAL_GIFT_UNITS)
    expect(count('fling')).toBe(FLING_UNITS)
  })

  it('classifies every unit exactly once as ported / unported / unclassified / allowlisted', () => {
    expect(result.totalDefined).toBe(result.units.length)
    expect(
      result.totalPorted + result.totalUnported + result.totalUnclassified + result.totalAllowlisted,
    ).toBe(result.totalDefined)
    for (const unit of result.units) {
      expect(['ported', 'unported', 'unclassified', 'allowlisted']).toContain(unit.status)
      if (unit.status === 'unported') {
        // registered-but-untested is a sub-count of unported, never a separate status.
        expect(typeof unit.registeredUntested).toBe('boolean')
      } else {
        expect(unit.registeredUntested).toBe(false)
      }
    }
    for (const summary of result.summaries) {
      expect(summary.ported + summary.unported + summary.unclassified + summary.allowlisted).toBe(summary.defined)
      expect(summary.registeredUntested).toBeLessThanOrEqual(summary.unported)
    }
    // Every unit key is unique, so no unit is counted twice.
    expect(new Set(result.units.map((unit) => `${unit.kind}:${unit.key}`)).size).toBe(result.totalDefined)
  })

  it('reports the current unported unit count -- this number should only go DOWN', () => {
    expect(result.totalUnported).toBe(UNPORTED_UNIT_COUNT)
  })

  it('reports the current registered-but-untested unit count -- this number should only go DOWN', () => {
    expect(result.totalRegisteredUntested).toBe(REGISTERED_UNTESTED_UNIT_COUNT)
  })

  it('reports the current unclassified unit count -- this number should only go DOWN', () => {
    expect(result.totalUnclassified).toBe(UNCLASSIFIED_UNIT_COUNT)
  })

  it('validates every allowlist citation format', () => {
    for (const entry of DEFAULT_ALLOWLIST) {
      expect(isValidAllowlistCitation(entry.cite)).toBe(true)
      expect(entry.reason.length).toBeGreaterThan(0)
    }
    expect(validateAllowlist(DEFAULT_ALLOWLIST)).toEqual([])
  })

  it('negative (a): a fabricated hold effect with a C hit but no sim token is unported', () => {
    const baseline = runInventory([FABRICATED_ITEM], SYNTHETIC_OPTIONS)
    const unit = baseline.units.find((candidate) => candidate.kind === 'hold-trigger')
    expect(unit?.unit).toBe('HOLD_EFFECT_FABRICATED')
    expect(unit?.site).toBe('FabricatedEffect')
    expect(unit?.status).toBe('unported')
    expect(unit?.registeredUntested).toBe(false)
  })

  it('negative (b): a token in source but not in tests is unported + registeredUntested', () => {
    const registered = runInventory([FABRICATED_ITEM], {
      ...SYNTHETIC_OPTIONS,
      productionSource: 'return HOLD_EFFECT_FABRICATED',
    })
    const unit = registered.units.find((candidate) => candidate.kind === 'hold-trigger')
    expect(unit?.status).toBe('unported')
    expect(unit?.registeredUntested).toBe(true)

    // The same token named in a test becomes ported.
    const both = runInventory([FABRICATED_ITEM], {
      ...SYNTHETIC_OPTIONS,
      productionSource: 'return HOLD_EFFECT_FABRICATED',
      testSources: [{ file: 'web/src/engine/sim/fabricated.test.ts', source: 'HOLD_EFFECT_FABRICATED' }],
    })
    const ported = both.units.find((candidate) => candidate.kind === 'hold-trigger')
    expect(ported?.status).toBe('ported')
    expect(ported?.testFile).toBe('web/src/engine/sim/fabricated.test.ts')
  })

  it('negative (d): an allowlist entry without an exact file:line cite is rejected', () => {
    expect(isValidAllowlistCitation('pipeline/.upstream/eliteredux-source/src/battle_util.c:5427')).toBe(true)
    expect(isValidAllowlistCitation('pipeline/.upstream/eliteredux-source/src/battle_util.c')).toBe(false)
    expect(isValidAllowlistCitation('battle_util.c:not-a-line')).toBe(false)

    const bad: ItemAllowlistEntry[] = [{ key: 'x', reason: 'because', cite: 'battle_util.c' }]
    expect(validateAllowlist(bad).length).toBeGreaterThan(0)
    expect(() => runInventory([FABRICATED_ITEM], { ...SYNTHETIC_OPTIONS, allowlist: bad })).toThrow()

    const good: ItemAllowlistEntry[] = [
      {
        key: 'HOLD_EFFECT_FABRICATED@battle_util.c:FabricatedEffect',
        reason: 'quoted C line is inert',
        cite: 'pipeline/.upstream/eliteredux-source/src/battle_util.c:5427',
      },
    ]
    const allowlisted = runInventory([FABRICATED_ITEM], { ...SYNTHETIC_OPTIONS, allowlist: good })
    const unit = allowlisted.units.find((candidate) => candidate.kind === 'hold-trigger')
    expect(unit?.status).toBe('allowlisted')
    expect(unit?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_util.c:5427')
  })

  it('anchors three hand-derived hold-trigger citations read in the C', () => {
    const unitFor = (effect: string, site: string) =>
      result.units.find(
        (unit) => unit.kind === 'hold-trigger' && unit.unit === effect && unit.site === site,
      )

    const restoreStats = unitFor('HOLD_EFFECT_RESTORE_STATS', 'ITEMEFFECT_ON_SWITCH_IN')
    expect(restoreStats?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_util.c:5427',
    )

    const lifeOrb = unitFor('HOLD_EFFECT_LIFE_ORB', 'ITEMEFFECT_LIFEORB_SHELLBELL')
    expect(lifeOrb?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_util.c:6085')

    const choiceScarf = unitFor('HOLD_EFFECT_CHOICE_SCARF', 'GetBattlerTotalSpeedStat')
    expect(choiceScarf?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_main.c:4220')
  })

  it('generates deterministic markdown and compares it with the committed doc (or writes with SIM_INVENTORY_WRITE=1)', () => {
    const generated = generateItemInventoryDoc(result, items)
    expect(generateItemInventoryDoc(result, items)).toBe(generated)

    if (process.env.SIM_INVENTORY_WRITE === '1') {
      writeFileSync(ITEM_INVENTORY_DOC_PATH, generated, 'utf-8')
      console.log(`Wrote held-item inventory doc to ${ITEM_INVENTORY_DOC_PATH}`)
    }

    expect(existsSync(ITEM_INVENTORY_DOC_PATH)).toBe(true)
    expect(readFileSync(ITEM_INVENTORY_DOC_PATH, 'utf-8')).toBe(generated)
  })
})
