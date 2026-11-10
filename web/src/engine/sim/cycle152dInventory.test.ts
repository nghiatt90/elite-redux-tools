/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import {
  loadEngineProductionFiles,
  loadEngineTestFiles,
  loadItems,
  runInventory,
  type ItemInventoryResult,
  type ItemUnit,
  type SourceFile,
} from './driver/itemInventory'

const items = loadItems()

const SCRIPT_FILE = 'battle_scripts_1.s'
const SCRIPT_REPO_PATH = 'pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s'

function scriptUnits(result: ItemInventoryResult): ItemUnit[] {
  return result.units.filter(
    (unit) => unit.kind === 'hold-trigger' && unit.file.endsWith(SCRIPT_FILE),
  )
}

function unitFor(
  result: ItemInventoryResult,
  kind: ItemUnit['kind'],
  effect: string,
  site: string,
): ItemUnit | undefined {
  return result.units.find((unit) => unit.kind === kind && unit.unit === effect && unit.site === site)
}

/** A credited test file must be non-AI, not skipped, and actually name the token or item id. */
function testEvidenceIsQualifying(unit: ItemUnit | undefined, tokens: string[]): boolean {
  if (!unit?.testFile) return false
  if (unit.testFile.includes('/sim/ai/')) return false
  const source = loadEngineTestFiles().find((file) => file.file === unit.testFile)
  if (!source) return false
  return tokens.some((token) => source.source.includes(token))
}

function testSourcesWithout(tokens: string[]): SourceFile[] {
  return loadEngineTestFiles().filter((file) => !tokens.some((token) => file.source.includes(token)))
}

function stubProductionFile(fileToStub: string, token: string, replacement: string): SourceFile[] {
  return loadEngineProductionFiles().map((file) =>
    file.file === fileToStub
      ? { file: file.file, source: file.source.replace(new RegExp(token, 'g'), replacement) }
      : file,
  )
}

describe('cycle 152d - battle-script hold triggers (A)', () => {
  it('baseline: the five script trigger sites exist with their C citations and statuses', () => {
    const result = runInventory(items)
    const units = scriptUnits(result)
    // 5 cycle-152d labels + 7 Power Herb `twoturnmoveacceleratecheck` labels (cycle 152d2)
    // + the synthetic BattleScript_MoveEffectBugBite site (also in battle_scripts_1.s).
    expect(units).toHaveLength(13)

    const targetPath = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_DESTINY_KNOT', 'BattleScript_TryDestinyKnotTarget')
    expect(targetPath?.citation).toBe(`${SCRIPT_REPO_PATH}:5201`)
    expect(targetPath?.status).toBe('unported')
    expect(targetPath?.registeredUntested).toBe(false)

    const attackerPath = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_DESTINY_KNOT', 'BattleScript_TryDestinyKnotAttacker')
    expect(attackerPath?.citation).toBe(`${SCRIPT_REPO_PATH}:5213`)
    expect(attackerPath?.status).toBe('ported')
    expect(testEvidenceIsQualifying(attackerPath, ['HOLD_EFFECT_DESTINY_KNOT', 'ITEM_DESTINY_KNOT'])).toBe(true)

    const clearAmulet = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_CLEAR_AMULET', 'BattleScript_GulpMissileGulping')
    expect(clearAmulet?.citation).toBe(`${SCRIPT_REPO_PATH}:7850`)
    expect(clearAmulet?.status).toBe('ported')
    expect(testEvidenceIsQualifying(clearAmulet, ['HOLD_EFFECT_CLEAR_AMULET', 'ITEM_CLEAR_AMULET'])).toBe(true)

    const adrenaline = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_ADRENALINE_ORB', 'BattleScript_TryAdrenalineOrb')
    expect(adrenaline?.citation).toBe(`${SCRIPT_REPO_PATH}:9858`)
    expect(adrenaline?.status).toBe('unported')
    expect(adrenaline?.registeredUntested).toBe(false)

    const focusSash = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_FOCUS_SASH', 'BattleScript_HangedOnMsg')
    expect(focusSash?.citation).toBe(`${SCRIPT_REPO_PATH}:10962`)
    expect(focusSash?.status).toBe('ported')
    expect(testEvidenceIsQualifying(focusSash, ['HOLD_EFFECT_FOCUS_SASH', 'ITEM_FOCUS_SASH'])).toBe(true)
  })

  it('the Destiny Knot target path has no sim handler: its Cite is the Cute Charm caller gap', () => {
    // data/battle_scripts_1.s:10578 (BattleScript_CuteCharmActivates) calls the target
    // script after Cute Charm infatuates the attacker. moveEffects.ts only ports the
    // attacker path (:5212-5222); the Cute Charm block in moveEnd.ts never re-checks the
    // attacker's knot. A test naming the effect must not make this site ported.
    const result = runInventory(items, {
      testSources: [
        { file: 'web/src/engine/sim/fabricatedDestinyKnot.test.ts', source: 'HOLD_EFFECT_DESTINY_KNOT' },
      ],
    })
    const targetPath = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_DESTINY_KNOT', 'BattleScript_TryDestinyKnotTarget')
    expect(targetPath?.status).toBe('unported')
    expect(targetPath?.registeredUntested).toBe(false)
  })

  it('negative: hold-effect mentions in .s comments or on a non-trigger label produce no unit', () => {
    const synthetic = [
      'BattleScript_Decoy:',
      '\t; jumpifnoholdeffect BS_TARGET, HOLD_EFFECT_FOCUS_SASH, BattleScript_DecoyRet',
      '\t@ jumpifholdeffect BS_ATTACKER, HOLD_EFFECT_FOCUS_SASH, BattleScript_DecoyRet',
      'BattleScript_LabelMention: @ HOLD_EFFECT_FOCUS_SASH',
      '\treturn',
      'BattleScript_DecoyRet:',
      '\treturn',
    ].join('\n')

    const result = runInventory(items, {
      holdTriggerScriptSources: { [SCRIPT_FILE]: synthetic },
    })
    // The synthetic BattleScript_MoveEffectBugBite unit is always emitted for its
    // hard-coded script site; this negative test is about hold-effect scanning.
    const scanUnits = scriptUnits(result).filter((unit) => unit.unit.startsWith('HOLD_EFFECT_'))
    expect(scanUnits).toHaveLength(0)
    expect(result.units.some((unit) => unit.site === 'BattleScript_Decoy')).toBe(false)
    expect(result.units.some((unit) => unit.site === 'BattleScript_LabelMention')).toBe(false)
  })
})

describe('cycle 152d - unscanned C files (B)', () => {
  it('baseline: the five unscanned-file units exist with their citations and kinds', () => {
    const result = runInventory(items)

    const megaChoice = unitFor(result, 'ai-trigger', 'HOLD_EFFECT_PRIMAL_ORB', 'OpponentHandleChooseMove')
    expect(megaChoice?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_controller_opponent.c:1608',
    )
    // The sim's chooseAiAction only calls canMegaEvolve(); the explicit primal-orb
    // exclusion from :1608 is not written there, and canMegaEvolve returns false for a
    // primal orb because it is not in the mega-evolution table.
    expect(megaChoice?.status).toBe('unported')
    expect(megaChoice?.registeredUntested).toBe(false)

    const bootsSwitch = unitFor(result, 'ai-trigger', 'HOLD_EFFECT_HEAVY_DUTY_BOOTS', 'CalculateHazardDamage')
    expect(bootsSwitch?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/battle_ai_switch_items.c:528',
    )
    expect(bootsSwitch?.status).toBe('unported')

    const boosterProto = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_BOOSTER_ENERGY', 'ScoreSwitchInAbility:1070')
    expect(boosterProto?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_ai_ability.c:1070')
    expect(boosterProto?.status).toBe('unported')

    const boosterQuark = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_BOOSTER_ENERGY', 'ScoreSwitchInAbility:1076')
    expect(boosterQuark?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_ai_ability.c:1076')
    expect(boosterQuark?.status).toBe('unported')

    const acrobaticsGem = unitFor(result, 'hold-trigger', 'HOLD_EFFECT_GEMS', 'CustomMoveCondition<EFFECT_ACROBATICS>')
    expect(acrobaticsGem?.citation).toBe(
      'pipeline/.upstream/eliteredux-source/src/script_conditions.cc:150',
    )
    // basePower.ts's evaluateCustomCondition ports the "no item" half only and its own
    // comment records that the gemBoost edge case is not modelled.
    expect(acrobaticsGem?.status).toBe('unported')
    expect(acrobaticsGem?.registeredUntested).toBe(false)
  })
})

describe('cycle 152d - per-site mutation checks', () => {
  it('Destiny Knot attacker path: stub handler -> unported; remove its tests -> registeredUntested', () => {
    const stubbed = runInventory(items, {
      productionFiles: stubProductionFile(
        'web/src/engine/sim/moveEffects.ts',
        'HOLD_EFFECT_DESTINY_KNOT',
        'HOLD_EFFECT_STUBBED_DESTINY_KNOT',
      ),
    })
    const stubUnit = unitFor(stubbed, 'hold-trigger', 'HOLD_EFFECT_DESTINY_KNOT', 'BattleScript_TryDestinyKnotAttacker')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    const noTests = runInventory(items, {
      testSources: testSourcesWithout(['HOLD_EFFECT_DESTINY_KNOT', 'ITEM_DESTINY_KNOT']),
    })
    const testUnit = unitFor(noTests, 'hold-trigger', 'HOLD_EFFECT_DESTINY_KNOT', 'BattleScript_TryDestinyKnotAttacker')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)
  })

  it('Focus Sash: stub handler -> unported; remove its tests -> registeredUntested', () => {
    const stubbed = runInventory(items, {
      productionFiles: stubProductionFile(
        'web/src/engine/sim/turn.ts',
        'HOLD_EFFECT_FOCUS_SASH',
        'HOLD_EFFECT_STUBBED_FOCUS_SASH',
      ),
    })
    const stubUnit = unitFor(stubbed, 'hold-trigger', 'HOLD_EFFECT_FOCUS_SASH', 'BattleScript_HangedOnMsg')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    const noTests = runInventory(items, {
      testSources: testSourcesWithout(['HOLD_EFFECT_FOCUS_SASH', 'ITEM_FOCUS_SASH']),
    })
    const testUnit = unitFor(noTests, 'hold-trigger', 'HOLD_EFFECT_FOCUS_SASH', 'BattleScript_HangedOnMsg')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)
  })

  it('Clear Amulet Gulp Missile branch: stub handler -> unported; remove its tests -> registeredUntested', () => {
    // statBuffs.ts also reads the amulet (ChangeStatBuffs' own re-check); the unit's
    // evidence is keyed to the moveEnd.ts Gulp Missile branch, so stubbing only that
    // file must be enough.
    const stubbed = runInventory(items, {
      productionFiles: stubProductionFile(
        'web/src/engine/sim/moveEnd.ts',
        'HOLD_EFFECT_CLEAR_AMULET',
        'HOLD_EFFECT_STUBBED_CLEAR_AMULET',
      ),
    })
    const stubUnit = unitFor(stubbed, 'hold-trigger', 'HOLD_EFFECT_CLEAR_AMULET', 'BattleScript_GulpMissileGulping')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    const noTests = runInventory(items, {
      testSources: testSourcesWithout(['HOLD_EFFECT_CLEAR_AMULET', 'ITEM_CLEAR_AMULET']),
    })
    const testUnit = unitFor(noTests, 'hold-trigger', 'HOLD_EFFECT_CLEAR_AMULET', 'BattleScript_GulpMissileGulping')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)
  })
})

describe('cycle 152d - pinned counts', () => {
  it('adds exactly 8 hold-trigger and 2 ai-trigger units, and 2 former item-data units now have hold units', () => {
    const result = runInventory(items)
    const count = (kind: ItemUnit['kind']) => result.units.filter((unit) => unit.kind === kind).length

    // Cycle 152d: +5 battle-script sites, +2 Booster Energy lines, +1 Acrobatics gem = 8.
    // Cycle 152d2 re-pin: +7 Power Herb script labels, +2 EatTargetBerry sites,
    // +4 EFFECT_CHANGE_TYPE_ON_ITEM sites = 237.
    // Cycle 152d3 re-pin: +14 Enigma Berry C sites = 251.
    expect(count('hold-trigger')).toBe(251)
    // +battle_controller_opponent.c:1608 and +battle_ai_switch_items.c:528.
    expect(count('ai-trigger')).toBe(59)
    // Cycle 152d: ITEM_DESTINY_KNOT and ITEM_ADRENALINE_ORB gain hold-trigger units (-2).
    // Cycle 152d2 re-pin: ITEM_POWER_HERB gains script units (-1) = 40.
    expect(count('item-data')).toBe(40)
    expect(count('natural-gift')).toBe(5)
    expect(count('fling')).toBe(11)
    // Cycle 152d2: +7 Power Herb script, +2 EatTargetBerry, +4 CHANGE_TYPE_ON_ITEM,
    // -1 Power Herb item-data = +12 (340 -> 352).
    // Cycle 152d3: +14 Enigma Berry hold-trigger units = 366.
    // Cycle 152d4: +270 Mega Stone units (266 ported, 4 allowlisted) = 636.
    expect(result.totalDefined).toBe(636)

    expect(result.totalUnclassified).toBe(0)
    // Cycle 152d2: -5 allowlisted, -1 Power Herb item-data, +1 gapped consumeberry (216).
    expect(result.totalUnported).toBe(216)
    expect(result.totalRegisteredUntested).toBe(28)
  })
})
