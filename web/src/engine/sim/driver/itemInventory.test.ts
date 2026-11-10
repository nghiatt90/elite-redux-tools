/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  C_SITE_SIM_MAP,
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
// Re-pinned after cycle 152d3: +14 Enigma Berry sites (3 ported battle reads, 4
// no-run/no-exp battle reads, 7 non-battle pokemon.c reads) on top of cycle 152d2's
// +7 Power Herb script labels, +2 EatTargetBerry sites, +4 EFFECT_CHANGE_TYPE_ON_ITEM.
// Cycle 152g: -2, the two Booster Energy `ScoreSwitchInAbility:1070` / `:1076` units
// moved to ai-trigger when `battle_ai_ability.c` was reclassified as an AI source.
const HOLD_TRIGGER_UNITS = 249
// Re-pinned after cycle 152g: +2, the Booster Energy `ScoreSwitchInAbility:1070` / `:1076`
// units moved here from hold-trigger (59 -> 61).
const AI_TRIGGER_UNITS = 61
// Re-pinned after cycle 152d2: ITEM_POWER_HERB loses its item-data unit once its hold
// effect gains hold-trigger units (41 -> 40).
const ITEM_DATA_UNITS = 40
// Re-pinned after cycle 152c: per-site natural-gift units (5) and fling units (11)
const NATURAL_GIFT_UNITS = 5
const FLING_UNITS = 11
const MEGA_STONE_UNITS = 270

// Unchanged by cycle 152d3: its 14 Enigma units are 3 ported + 11 allowlisted, so no
// new unported unit. (Cycle 152d2: -5 item-data units allowlisted, -1 Power Herb
// item-data unit replaced by script units, +1 gapped consumeberry.)
// Cycle 156: -1, Binding Band (`battle_util.c:2682`) gained a test.
// Cycle 152f: -1, Natural Gift's GetMovePriority unit is ported (naturalGiftPriority
// computed from the holder's item instead of hardcoded 0).
// Cycle 152h: -1, BattleScript_MoveEffectBugBite's attacker consumeberry is ported in applyBugBite.
export const UNPORTED_UNIT_COUNT = 213

// Re-pinned after cycle 152c: stricter fling test requirements and natural-gift per-site units
// Cycle 156: -1, Binding Band (`battle_util.c:2682`) gained a test.
export const REGISTERED_UNTESTED_UNIT_COUNT = 27

/**
 * Re-pinned after cycle 152d4: 5 cycle-152d2 item-data units + 11 Enigma Berry
 * sites + 4 no-row mega stones (BRUXISHITE, EXCADRILLITE_R, EYE_OF_ENDER, JELLICENTITE).
 */
export const ALLOWLISTED_UNIT_COUNT = 20

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
    expect(count('mega-stone')).toBe(MEGA_STONE_UNITS)
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

  it('reports the allowlisted unit count (cycle 152d2)', () => {
    expect(result.totalAllowlisted).toBe(ALLOWLISTED_UNIT_COUNT)
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

  it('leaves no real-inventory unit with an unmapped C site (cycle 152e)', () => {
    const unmapped = result.units.filter((unit) => unit.unmappedSite)
    expect(unmapped.map((unit) => unit.key)).toEqual([])
  })

  it('maps a fabricated site to its sim file/function and stops counting the rest of the file', () => {
    const site = 'FabricatedEffect'
    const token = 'HOLD_EFFECT_FABRICATED'
    C_SITE_SIM_MAP[site] = {
      files: ['web/src/engine/sim/fabricated.ts'],
      functionName: 'mappedHandler',
    }
    try {
      const testSources = [{ file: 'web/src/engine/sim/fabricated.test.ts', source: token }]
      const inside = runInventory([FABRICATED_ITEM], {
        ...SYNTHETIC_OPTIONS,
        productionFiles: [
          {
            file: 'web/src/engine/sim/fabricated.ts',
            source: `export function mappedHandler() {\n  return ${token}\n}\nexport function other() {\n  return 0\n}\n`,
          },
        ],
        testSources,
      })
      const ported = inside.units.find((unit) => unit.kind === 'hold-trigger')
      expect(ported?.site).toBe(site)
      expect(ported?.unmappedSite).toBe(false)
      expect(ported?.status).toBe('ported')

      // The same token in a different function of the same mapped file is not evidence.
      const outside = runInventory([FABRICATED_ITEM], {
        ...SYNTHETIC_OPTIONS,
        productionFiles: [
          {
            file: 'web/src/engine/sim/fabricated.ts',
            source: `export function mappedHandler() {\n  return 0\n}\nexport function other() {\n  return ${token}\n}\n`,
          },
        ],
        testSources,
      })
      const unported = outside.units.find((unit) => unit.kind === 'hold-trigger')
      expect(unported?.status).toBe('unported')
    } finally {
      delete C_SITE_SIM_MAP[site]
    }
  })

  it('scopes ITEMEFFECT_MOVE_END to applyMoveEndItemEffectsAll', () => {
    const token = 'HOLD_EFFECT_FABRICATED'
    // Minimal ItemBattleEffects switch whose ITEMEFFECT_MOVE_END case names the token.
    const fabricatedC = [
      'u8 ItemBattleEffects(u8 caseID, u8 battlerId, bool8 moveTurn)',
      '{',
      '    switch (caseID)',
      '    {',
      '    case ITEMEFFECT_MOVE_END:',
      `        if (holdEffect == ${token}) return TRUE;`,
      '        break;',
      '    }',
      '    return FALSE;',
      '}',
      '',
    ].join('\n')
    const testSources = [{ file: 'web/src/engine/sim/fabricated.test.ts', source: token }]
    const options = {
      ...SYNTHETIC_OPTIONS,
      holdTriggerSources: { 'battle_util.c': fabricatedC },
      testSources,
    }

    const inside = runInventory([FABRICATED_ITEM], {
      ...options,
      productionFiles: [
        {
          file: 'web/src/engine/sim/moveEnd.ts',
          source: `export function applyMoveEndItemEffectsAll() {\n  return ${token}\n}\nexport function runMoveEnd() {\n  return 0\n}\n`,
        },
      ],
    })
    const ported = inside.units.find((unit) => unit.kind === 'hold-trigger')
    expect(ported?.site).toBe('ITEMEFFECT_MOVE_END')
    expect(ported?.status).toBe('ported')

    // A token outside `applyMoveEndItemEffectsAll` no longer counts for this site.
    const outside = runInventory([FABRICATED_ITEM], {
      ...options,
      productionFiles: [
        {
          file: 'web/src/engine/sim/moveEnd.ts',
          source: `export function applyMoveEndItemEffectsAll() {\n  return 0\n}\nexport function runMoveEnd() {\n  return ${token}\n}\n`,
        },
      ],
    })
    const unported = outside.units.find((unit) => unit.kind === 'hold-trigger')
    expect(unported?.status).toBe('unported')
  })

  it('scopes a newly mapped real site (GetMoveTypeInternal) to its sim function', () => {
    const token = 'HOLD_EFFECT_GEMS'
    const site = 'GetMoveTypeInternal'
    const gemItem: ItemRecord = {
      id: 'ITEM_FABRICATED_GEM',
      name: 'Fabricated Gem',
      grouping: 'POCKET_ITEMS',
      holdEffect: token,
      resolvedHoldEffect: token,
    }
    const fabricatedC = `Type ${site}(MoveEnum move, int battlerAtk) {\n    return ${token};\n}\n`
    const testSources = [{ file: 'web/src/engine/basePower.test.ts', source: token }]
    const options = {
      ...SYNTHETIC_OPTIONS,
      holdTriggerSources: { 'battle_main.c': fabricatedC },
      testSources,
    }

    const inside = runInventory([gemItem], {
      ...options,
      productionFiles: [
        {
          file: 'web/src/engine/calculate.ts',
          source: `export function flingGemType() {\n  return '${token}'\n}\nexport function ogerponMaskType() {\n  return null\n}\n`,
        },
      ],
    })
    const ported = inside.units.find((unit) => unit.kind === 'hold-trigger')
    expect(ported?.site).toBe(site)
    expect(ported?.unmappedSite).toBe(false)
    expect(ported?.status).toBe('ported')

    const outside = runInventory([gemItem], {
      ...options,
      productionFiles: [
        {
          file: 'web/src/engine/calculate.ts',
          source: `export function flingGemType() {\n  return null\n}\nexport function ogerponMaskType() {\n  return '${token}'\n}\n`,
        },
      ],
    })
    const unported = outside.units.find((unit) => unit.kind === 'hold-trigger')
    expect(unported?.status).toBe('unported')
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
