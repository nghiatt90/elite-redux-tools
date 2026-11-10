/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import {
  loadEngineProductionFiles,
  loadEngineTestFiles,
  loadItems,
  runInventory,
} from './driver/itemInventory'

const items = loadItems()

function testSourcesWithout(filePatterns: string[]) {
  return loadEngineTestFiles().filter(
    (f) => !filePatterns.some((pattern) => f.file.includes(pattern)),
  )
}

describe('cycle 152c - Natural Gift and Fling per-site units', () => {
  it('baseline: Natural Gift has 5 per-site units (4 ported, 1 priority gap)', () => {
    const res = runInventory(items)
    const ngUnits = res.units.filter((u) => u.kind === 'natural-gift')
    expect(ngUnits).toHaveLength(5)

    const power = ngUnits.find((u) => u.site === 'CalcMoveBasePower')
    expect(power?.status).toBe('ported')
    expect(power?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_util.c:6840')
    expect(power?.testFile).toBe('web/src/engine/basePower.test.ts')

    const type = ngUnits.find((u) => u.site === 'GetMoveType')
    expect(type?.status).toBe('ported')
    expect(type?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_main.c:5072')
    expect(type?.testFile).toBe('web/src/engine/calculate.test.ts')

    const effect = ngUnits.find((u) => u.site === 'SetMoveEffect')
    expect(effect?.status).toBe('ported')
    expect(effect?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_script_commands.c:3023')
    expect(effect?.testFile).toBe('web/src/engine/sim/cycle87Effects.test.ts')

    const removal = ngUnits.find((u) => u.site === 'EffectNaturalGift')
    expect(removal?.status).toBe('ported')
    expect(removal?.citation).toBe('pipeline/.upstream/eliteredux-source/data/battle_scripts_1.s:3068')
    expect(removal?.testFile).toBe('web/src/engine/sim/cycle129CopyEffects.test.ts')

    const priority = ngUnits.find((u) => u.site === 'GetMovePriority')
    expect(priority?.status).toBe('unported')
    expect(priority?.registeredUntested).toBe(false)
    expect(priority?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_main.c:4272')
    expect(priority?.partialReason).toContain('naturalGiftPriority')
  })

  it('Natural Gift power: stub handler -> unported; remove test -> registeredUntested', () => {
    // 1. Stub the power handler in basePower.ts
    const stubbedProduction = loadEngineProductionFiles().map((f) =>
      f.file === 'web/src/engine/basePower.ts'
        ? { file: f.file, source: f.source.replace(/attackerNaturalGiftPower/g, 'stubbedNaturalGiftPower') }
        : f,
    )
    const stubRes = runInventory(items, { productionFiles: stubbedProduction })
    const stubUnit = stubRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'CalcMoveBasePower')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    // 2. Remove exactly the file the report credits (basePower.test.ts)
    const testRes = runInventory(items, { testSources: testSourcesWithout(['basePower.test.ts']) })
    const testUnit = testRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'CalcMoveBasePower')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)

    // A decoy Natural Gift test does not satisfy this site's predicate: removing
    // cycle129CopyEffects leaves the unit ported on basePower.test.ts.
    const decoyRes = runInventory(items, { testSources: testSourcesWithout(['cycle129CopyEffects.test.ts']) })
    const decoyUnit = decoyRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'CalcMoveBasePower')
    expect(decoyUnit?.status).toBe('ported')
    expect(decoyUnit?.testFile).toBe('web/src/engine/basePower.test.ts')
  })

  it('Natural Gift type: stub handler -> unported; remove test -> registeredUntested', () => {
    // 1. Stub the type handler in calculate.ts
    const stubbedProduction = loadEngineProductionFiles().map((f) =>
      f.file === 'web/src/engine/calculate.ts'
        ? { file: f.file, source: f.source.replace(/\bnaturalGift\b/g, 'stubbedGift') }
        : f,
    )
    const stubRes = runInventory(items, { productionFiles: stubbedProduction })
    const stubUnit = stubRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'GetMoveType')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    // 2. Remove exactly the file the report credits (calculate.test.ts)
    const testRes = runInventory(items, { testSources: testSourcesWithout(['calculate.test.ts']) })
    const testUnit = testRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'GetMoveType')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)

    // A decoy Natural Gift test does not satisfy this site's predicate: removing
    // cycle149cMoveEndType leaves the unit ported on calculate.test.ts.
    const decoyRes = runInventory(items, { testSources: testSourcesWithout(['cycle149cMoveEndType.test.ts']) })
    const decoyUnit = decoyRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'GetMoveType')
    expect(decoyUnit?.status).toBe('ported')
    expect(decoyUnit?.testFile).toBe('web/src/engine/calculate.test.ts')
  })

  it('Natural Gift effect: stub handler -> unported; remove test -> registeredUntested', () => {
    // 1. Stub the effect handler in moveEffects.ts
    const stubbedProduction = loadEngineProductionFiles().map((f) =>
      f.file === 'web/src/engine/sim/moveEffects.ts'
        ? { file: f.file, source: f.source.replace(/\bnaturalGift\b/g, 'stubbedGift') }
        : f,
    )
    const stubRes = runInventory(items, { productionFiles: stubbedProduction })
    const stubUnit = stubRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'SetMoveEffect')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    // 2. Remove exactly the file the report credits (cycle87Effects.test.ts)
    const testRes = runInventory(items, { testSources: testSourcesWithout(['cycle87Effects.test.ts']) })
    const testUnit = testRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'SetMoveEffect')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)

    // A decoy Natural Gift test does not satisfy this site's predicate: removing
    // calculate.test.ts leaves the unit ported on cycle87Effects.test.ts.
    const decoyRes = runInventory(items, { testSources: testSourcesWithout(['calculate.test.ts']) })
    const decoyUnit = decoyRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'SetMoveEffect')
    expect(decoyUnit?.status).toBe('ported')
    expect(decoyUnit?.testFile).toBe('web/src/engine/sim/cycle87Effects.test.ts')
  })

  it('Natural Gift berry removal: stub handler -> unported; remove test -> registeredUntested', () => {
    // 1. Stub the berry removal handler in turn.ts
    const stubbedProduction = loadEngineProductionFiles().map((f) =>
      f.file === 'web/src/engine/sim/turn.ts'
        ? { file: f.file, source: f.source.replace(/moveEffect === 'EFFECT_NATURAL_GIFT'/g, 'false') }
        : f,
    )
    const stubRes = runInventory(items, { productionFiles: stubbedProduction })
    const stubUnit = stubRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'EffectNaturalGift')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    // 2. Remove exactly the file the report credits (cycle129CopyEffects.test.ts)
    const testRes = runInventory(items, { testSources: testSourcesWithout(['cycle129CopyEffects.test.ts']) })
    const testUnit = testRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'EffectNaturalGift')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)

    // A decoy Natural Gift test does not satisfy this site's predicate: removing
    // basePower.test.ts leaves the unit ported on cycle129CopyEffects.test.ts.
    const decoyRes = runInventory(items, { testSources: testSourcesWithout(['basePower.test.ts']) })
    const decoyUnit = decoyRes.units.find((u) => u.kind === 'natural-gift' && u.site === 'EffectNaturalGift')
    expect(decoyUnit?.status).toBe('ported')
    expect(decoyUnit?.testFile).toBe('web/src/engine/sim/cycle129CopyEffects.test.ts')
  })

  it('baseline: Fling has 11 units (2 ported, 8 registeredUntested, 1 unported)', () => {
    const res = runInventory(items)
    const flingUnits = res.units.filter((u) => u.kind === 'fling')
    expect(flingUnits).toHaveLength(11)

    const lightBall = flingUnits.find((u) => u.key === 'ITEM_LIGHT_BALL')
    expect(lightBall?.status).toBe('ported')
    expect(lightBall?.testFile).toContain('cycle87Effects')

    const ironBall = flingUnits.find((u) => u.key === 'ITEM_IRON_BALL')
    expect(ironBall?.status).toBe('ported')
    expect(ironBall?.site).toBe('CalcMoveBasePower')
    expect(ironBall?.testFile).toContain('cycle87Effects')

    const bigNugget = flingUnits.find((u) => u.key === 'ITEM_BIG_NUGGET')
    expect(bigNugget?.status).toBe('unported')
    expect(bigNugget?.registeredUntested).toBe(true)
    expect(bigNugget?.site).toBe('CalcMoveBasePower')

    const flameOrb = flingUnits.find((u) => u.key === 'ITEM_FLAME_ORB')
    expect(flameOrb?.status).toBe('unported')
    expect(flameOrb?.registeredUntested).toBe(true)

    const canFling = flingUnits.find((u) => u.key === 'CanFling')
    expect(canFling?.status).toBe('unported')
    expect(canFling?.registeredUntested).toBe(false)
  })

  it('Fling Light Ball: stub handler -> unported; remove test -> registeredUntested', () => {
    // 1. Stub Light Ball in moveEffects.ts
    const stubbedProduction = loadEngineProductionFiles().map((f) =>
      f.file === 'web/src/engine/sim/moveEffects.ts'
        ? { file: f.file, source: f.source.replace(/ITEM_LIGHT_BALL/g, 'ITEM_STUB_LIGHT_BALL') }
        : f,
    )
    const stubRes = runInventory(items, { productionFiles: stubbedProduction })
    const stubUnit = stubRes.units.find((u) => u.kind === 'fling' && u.key === 'ITEM_LIGHT_BALL')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    // 2. Remove cycle87Effects test
    const testsWithoutFling = loadEngineTestFiles().filter((f) => !f.file.includes('cycle87Effects'))
    const testRes = runInventory(items, { testSources: testsWithoutFling })
    const testUnit = testRes.units.find((u) => u.kind === 'fling' && u.key === 'ITEM_LIGHT_BALL')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)
  })

  it('Fling Iron Ball: stub handler -> unported; remove test -> registeredUntested', () => {
    // 1. Stub Iron Ball in basePower.ts
    const stubbedProduction = loadEngineProductionFiles().map((f) =>
      f.file === 'web/src/engine/basePower.ts'
        ? { file: f.file, source: f.source.replace(/ITEM_IRON_BALL/g, 'ITEM_STUB_IRON_BALL') }
        : f,
    )
    const stubRes = runInventory(items, { productionFiles: stubbedProduction })
    const stubUnit = stubRes.units.find((u) => u.kind === 'fling' && u.key === 'ITEM_IRON_BALL')
    expect(stubUnit?.status).toBe('unported')
    expect(stubUnit?.registeredUntested).toBe(false)

    // 2. Remove cycle87Effects test
    const testsWithoutFling = loadEngineTestFiles().filter((f) => !f.file.includes('cycle87Effects'))
    const testRes = runInventory(items, { testSources: testsWithoutFling })
    const testUnit = testRes.units.find((u) => u.kind === 'fling' && u.key === 'ITEM_IRON_BALL')
    expect(testUnit?.status).toBe('unported')
    expect(testUnit?.registeredUntested).toBe(true)
  })
})
