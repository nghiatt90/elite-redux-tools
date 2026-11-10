/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWLIST,
  loadEngineProductionFiles,
  loadEngineTestFiles,
  loadItems,
  runInventory,
  validateAllowlist,
  type ItemInventoryResult,
  type ItemUnit,
  type SourceFile,
} from './driver/itemInventory'

const items = loadItems()

const SCRIPT_FILE = 'battle_scripts_1.s'
const SCRIPT_REPO_PATH = 'pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s'
const SRC_REPO_PATH = 'pipeline/.upstream/eliteredux-source/src'

function unitFor(
  result: ItemInventoryResult,
  kind: ItemUnit['kind'],
  unit: string,
  site: string,
): ItemUnit | undefined {
  return result.units.find(
    (candidate) => candidate.kind === kind && candidate.unit === unit && candidate.site === site,
  )
}

function itemDataUnit(result: ItemInventoryResult, id: string): ItemUnit | undefined {
  return result.units.find((candidate) => candidate.kind === 'item-data' && candidate.unit === id)
}

function testSourcesWithout(tokens: string[]): SourceFile[] {
  return loadEngineTestFiles().filter((file) => !tokens.some((token) => file.source.includes(token)))
}

function stubProductionFile(fileToStub: string, token: string, replacement: string): SourceFile[] {
  return loadEngineProductionFiles().map((file) =>
    file.file === fileToStub
      ? { file: file.file, source: file.source.split(token).join(replacement) }
      : file,
  )
}

/** Every battle-script label that runs twoturnmoveacceleratecheck, with its line. */
const POWER_HERB_SITES: Array<[string, number]> = [
  ['BattleScript_EffectTwoTurnSecondary_AfterSetString', 4409],
  ['BattleScript_EffectTwoTurnRetaliation_AfterSetString', 4431],
  ['BattleScript_EffectTwoTurnsAttackCheckSkipCharge', 4449],
  ['BattleScript_EffectGeomancy', 4460],
  ['BattleScript_EffectElectroShot', 5731],
  ['BattleScript_EffectSkyDrop', 5811],
  ['BattleScript_FirstTurnSemiInvulnerable', 5879],
]

describe('cycle 152d2 - non-battle effects allowlisted (A)', () => {
  it('baseline: five item-data units are allowlisted with exact non-battle C cites', () => {
    const result = runInventory(items)
    const allowlisted: Array<[string, string]> = [
      ['ITEM_CLEANSE_TAG', SRC_REPO_PATH + '/wild_encounter.c:1166'],
      ['ITEM_PURE_INCENSE', SRC_REPO_PATH + '/daycare.c:724'],
      ['ITEM_DRAGON_SCALE', SRC_REPO_PATH + '/battle_debug.c:2066'],
      ['ITEM_UPGRADE', SRC_REPO_PATH + '/battle_debug.c:2068'],
      ['ITEM_GRACIDEA', SRC_REPO_PATH + '/battle_debug.c:2101'],
    ]
    for (const [id, cite] of allowlisted) {
      const unit = itemDataUnit(result, id)
      expect(unit?.status).toBe('allowlisted')
      expect(unit?.citation).toBe(cite)
      expect(unit?.registeredUntested).toBe(false)
    }
    // Cycle 152d4 added 4 no-row mega stone allowlist entries (16 + 4 = 20).
    expect(result.totalAllowlisted).toBe(20)
    expect(validateAllowlist(DEFAULT_ALLOWLIST)).toEqual([])
    expect(DEFAULT_ALLOWLIST).toHaveLength(20)

    // ITEM_Z_RING stays unported: HOLD_EFFECT_Z_RING and ITEM_Z_RING occur nowhere in the
    // pinned C tree (src/, include/, data/), so there is no exact file:line cite to give.
    const zRing = itemDataUnit(result, 'ITEM_Z_RING')
    expect(zRing?.status).toBe('unported')
    expect(zRing?.citation).toContain('data-only')
  })

  it('Power Herb: the item-data unit is gone and seven script units carry the macro cites', () => {
    const result = runInventory(items)
    expect(itemDataUnit(result, 'ITEM_POWER_HERB')).toBeUndefined()

    const units = result.units.filter(
      (unit) => unit.kind === 'hold-trigger' && unit.unit === 'HOLD_EFFECT_POWER_HERB',
    )
    expect(units).toHaveLength(7)
    for (const [site, line] of POWER_HERB_SITES) {
      const unit = units.find((candidate) => candidate.site === site)
      expect(unit?.citation).toBe(SCRIPT_REPO_PATH + ':' + line)
      expect(unit?.file).toBe(SCRIPT_REPO_PATH)
      expect(unit?.status).toBe('ported')
      // cycle152d3 came later and its Power Herb positive control names ITEM_POWER_HERB,
      // so it can be the alphabetically first matching test file.
      expect(unit?.testFile).toMatch(/cycle87bEffects\.test\.ts$|moveEffects\.test\.ts$|cycle152d3Enigma\.test\.ts$/)
    }
  })
})

describe('cycle 152d2 - EatTargetBerry and EFFECT_CHANGE_TYPE_ON_ITEM (C, D)', () => {
  it('baseline: C1 ports the pocket/Sticky Hold/removal flow, C2 stays gapped', () => {
    const result = runInventory(items)

    const c1 = unitFor(result, 'hold-trigger', 'POCKET_BERRIES', 'EatTargetBerry')
    expect(c1?.citation).toBe(SRC_REPO_PATH + '/battle_script_commands.c:4595')
    expect(c1?.effect).toBe('eatTargetBerry')
    expect(c1?.status).toBe('ported')
    expect(c1?.registeredUntested).toBe(false)
    expect(c1?.testFile).toBe('web/src/engine/sim/moveEnd.test.ts')

    const c2 = unitFor(result, 'hold-trigger', 'BattleScript_MoveEffectBugBite', 'BattleScript_MoveEffectBugBite')
    expect(c2?.citation).toBe(SCRIPT_REPO_PATH + ':1006')
    expect(c2?.effect).toBe('eatTargetBerry')
    expect(c2?.status).toBe('unported')
    expect(c2?.registeredUntested).toBe(false)
    expect(c2?.testFile).toBeNull()
  })

  it('baseline: Plate and Memory carry one unit per CHANGE_TYPE_ON_ITEM C site', () => {
    const result = runInventory(items)
    const sites: Array<[string, number]> = [
      ['CHANGE_TYPE_ON_ITEM:5036', 5036],
      ['CHANGE_TYPE_ON_ITEM:5137', 5137],
    ]
    for (const effect of ['HOLD_EFFECT_PLATE', 'HOLD_EFFECT_MEMORY']) {
      for (const [site, line] of sites) {
        const unit = result.units.find(
          (candidate) => candidate.kind === 'hold-trigger' && candidate.effect === effect && candidate.site === site,
        )
        expect(unit?.citation).toBe(SRC_REPO_PATH + '/battle_main.c:' + line)
        expect(unit?.status).toBe('ported')
        expect(unit?.testFile).toBe('web/src/engine/calculate.test.ts')
      }
    }
    // No HOLD_EFFECT_DRIVE unit: no move's argument is DRIVE in the pinned data
    // (Techno Blast is EFFECT_HIDDEN_POWER; only Judgment/Plate and Multi-Attack/Memory carry
    // EFFECT_CHANGE_TYPE_ON_ITEM).
    expect(
      result.units.some(
        (unit) => unit.kind === 'hold-trigger' && unit.effect === 'HOLD_EFFECT_DRIVE' && unit.site.startsWith('CHANGE_TYPE_ON_ITEM'),
      ),
    ).toBe(false)
  })
})

describe('cycle 152d2 - per-site mutation checks', () => {
  it('Power Herb: stub the accelerate branch -> unported; remove its tests -> registeredUntested', () => {
    const stubbed = runInventory(items, {
      productionFiles: stubProductionFile(
        'web/src/engine/sim/turn.ts',
        'HOLD_EFFECT_POWER_HERB',
        'HOLD_EFFECT_STUBBED_POWER_HERB',
      ),
    })
    const stubUnit = unitFor(stubbed, 'hold-trigger', 'HOLD_EFFECT_POWER_HERB', 'BattleScript_EffectElectroShot')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    const noTests = runInventory(items, {
      testSources: testSourcesWithout(['ITEM_POWER_HERB', 'HOLD_EFFECT_POWER_HERB']),
    })
    const testUnit = unitFor(noTests, 'hold-trigger', 'HOLD_EFFECT_POWER_HERB', 'BattleScript_EffectElectroShot')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)
  })

  it('EatTargetBerry: stub the pocket branch -> unported; remove its tests -> registeredUntested', () => {
    const stubbed = runInventory(items, {
      productionFiles: stubProductionFile('web/src/engine/sim/moveEnd.ts', 'POCKET_BERRIES', 'POCKET_STUBBED'),
    })
    const stubUnit = unitFor(stubbed, 'hold-trigger', 'POCKET_BERRIES', 'EatTargetBerry')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    const noTests = runInventory(items, {
      testSources: testSourcesWithout(['MOVE_BUG_BITE', 'MOVE_PLUCK', 'ABILITY_STICKY_HOLD']),
    })
    const testUnit = unitFor(noTests, 'hold-trigger', 'POCKET_BERRIES', 'EatTargetBerry')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)
  })

  it('CHANGE_TYPE_ON_ITEM: stub the branch -> unported; remove its tests -> registeredUntested', () => {
    const stubbed = runInventory(items, {
      productionFiles: stubProductionFile(
        'web/src/engine/calculate.ts',
        'changeTypeHoldEffect',
        'stubbedChangeTypeHoldEffect',
      ),
    })
    const stubUnit = unitFor(stubbed, 'hold-trigger', 'changeTypeHoldEffect', 'CHANGE_TYPE_ON_ITEM:5036')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    const noTests = runInventory(items, {
      testSources: testSourcesWithout(['MOVE_JUDGMENT', 'MOVE_MULTI_ATTACK']),
    })
    const testUnit = unitFor(noTests, 'hold-trigger', 'changeTypeHoldEffect', 'CHANGE_TYPE_ON_ITEM:5036')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)
  })
})

describe('cycle 152d2 - negatives and pinned counts', () => {
  it('negative: an allowlist entry without an exact file:line cite is rejected', () => {
    expect(
      validateAllowlist([{ key: 'ITEM_FABRICATED', reason: 'fabricated', cite: 'battle_debug.c' }]).length,
    ).toBeGreaterThan(0)
    expect(() =>
      runInventory(items, {
        allowlist: [{ key: 'ITEM_FABRICATED', reason: 'fabricated', cite: 'battle_debug.c' }],
      }),
    ).toThrow()
  })

  it('negative: a twoturn macro in a comment or outside any label produces no unit', () => {
    const synthetic = [
      'twoturnmoveacceleratecheck',
      'BattleScript_Decoy:',
      '; twoturnmoveacceleratecheck',
      '@ twoturnmoveacceleratecheck',
      'return',
    ].join(String.fromCharCode(10))
    const result = runInventory(items, {
      holdTriggerScriptSources: { [SCRIPT_FILE]: synthetic },
    })
    expect(
      result.units.filter(
        (unit) => unit.kind === 'hold-trigger' && unit.unit === 'HOLD_EFFECT_POWER_HERB' && unit.file.endsWith(SCRIPT_FILE),
      ),
    ).toHaveLength(0)
    expect(result.units.some((unit) => unit.site === 'BattleScript_Decoy')).toBe(false)
    expect(result.totalUnclassified).toBe(0)
  })

  it('counts: +7 Power Herb, +2 EatTargetBerry, +4 CHANGE_TYPE_ON_ITEM, -1 Power Herb item-data', () => {
    const result = runInventory(items)
    const count = (kind: ItemUnit['kind']) => result.units.filter((unit) => unit.kind === kind).length

    // Cycle 152d3: +14 Enigma hold-trigger units (3 ported, 11 allowlisted).
    expect(count('hold-trigger')).toBe(251)
    expect(count('ai-trigger')).toBe(59)
    expect(count('item-data')).toBe(40)
    expect(count('natural-gift')).toBe(5)
    expect(count('fling')).toBe(11)
    expect(result.totalDefined).toBe(636)
    expect(result.totalPorted).toBe(400)
    expect(result.totalUnported).toBe(216)
    expect(result.totalRegisteredUntested).toBe(28)
    expect(result.totalAllowlisted).toBe(20)
    expect(result.totalUnclassified).toBe(0)
  })
})
