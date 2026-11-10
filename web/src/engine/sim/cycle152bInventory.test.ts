/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'

import {
  loadItems,
  runInventory,
  scanHoldEffectHits,
  type ItemRecord,
  type SourceFile,
} from './driver/itemInventory'

describe('cycle152b: held-item inventory classifier verification', () => {
  const liveItems = loadItems()
  const liveResult = runInventory(liveItems)

  describe('Item 1: per-site and production/test mutation tests', () => {
    const SYNTH_ITEM: ItemRecord = {
      id: 'ITEM_SYNTHETIC_HELD',
      name: 'Synthetic Held Item',
      grouping: 'ITEM_GROUP_HELD_ITEM',
      holdEffect: 'HOLD_EFFECT_SYNTHETIC',
      resolvedHoldEffect: 'HOLD_EFFECT_SYNTHETIC',
    }

    const SYNTH_C_SOURCE = `
u8 ItemBattleEffects(u8 battler, u8 caseID) {
    switch (caseID) {
    case 0: // ITEMEFFECT_ON_SWITCH_IN
        if (holdEffect == HOLD_EFFECT_SYNTHETIC) {
            return 0;
        }
        break;
    }
    return 0;
}
`

    const SYNTH_HOLD_SOURCES = {
      'battle_util.c': SYNTH_C_SOURCE,
    }

    it('(a) a token present only inside an it.skip, an AI file, a stripped gap set, or a note string is unported', () => {
      // 1. Present only inside it.skip(...) in a non-AI test file
      const skippedTestFile: SourceFile = {
        file: 'web/src/engine/sim/dummy.test.ts',
        source: `
it.skip('synthetic test', () => {
    expect(HOLD_EFFECT_SYNTHETIC).toBeDefined();
});
`,
      }
      const prodInMappedFunction: SourceFile = {
        file: 'web/src/engine/sim/switchIn.ts',
        source: `
export function switchIn(state, battlerId) {
    const effect = HOLD_EFFECT_SYNTHETIC;
}
`,
      }
      const resSkipped = runInventory([SYNTH_ITEM], {
        holdTriggerSources: SYNTH_HOLD_SOURCES,
        aiTriggerSources: {},
        flingSource: '',
        productionFiles: [prodInMappedFunction],
        aiProductionFiles: [],
        testSources: [skippedTestFile],
        allowlist: [],
      })
      const unitSkipped = resSkipped.units.find((u) => u.unit === 'HOLD_EFFECT_SYNTHETIC')
      expect(unitSkipped).toBeDefined()
      expect(unitSkipped?.status).toBe('unported')
      expect(unitSkipped?.registeredUntested).toBe(true)

      // 2. Present only inside an AI test file
      const aiTestFile: SourceFile = {
        file: 'web/src/engine/sim/ai/aiCheckViability.test.ts',
        source: `
it('ai test', () => {
    expect(HOLD_EFFECT_SYNTHETIC).toBeDefined();
});
`,
      }
      const resAiTest = runInventory([SYNTH_ITEM], {
        holdTriggerSources: SYNTH_HOLD_SOURCES,
        aiTriggerSources: {},
        flingSource: '',
        productionFiles: [prodInMappedFunction],
        aiProductionFiles: [],
        testSources: [aiTestFile],
        allowlist: [],
      })
      const unitAiTest = resAiTest.units.find((u) => u.unit === 'HOLD_EFFECT_SYNTHETIC')
      expect(unitAiTest?.status).toBe('unported')
      expect(unitAiTest?.registeredUntested).toBe(true)

      // 3. Present only inside an AI production file
      const aiProdFile: SourceFile = {
        file: 'web/src/engine/sim/ai/aiUtil.ts',
        source: `
export function aiEvaluate(battlerId) {
    if (effect === HOLD_EFFECT_SYNTHETIC) return 10;
}
`,
      }
      const nonAiTestFile: SourceFile = {
        file: 'web/src/engine/sim/heldItems.test.ts',
        source: `
it('real test', () => {
    expect(HOLD_EFFECT_SYNTHETIC).toBeDefined();
});
`,
      }
      const resAiProd = runInventory([SYNTH_ITEM], {
        holdTriggerSources: SYNTH_HOLD_SOURCES,
        aiTriggerSources: {},
        flingSource: '',
        productionFiles: [],
        aiProductionFiles: [aiProdFile],
        testSources: [nonAiTestFile],
        allowlist: [],
      })
      const unitAiProd = resAiProd.units.find((u) => u.unit === 'HOLD_EFFECT_SYNTHETIC')
      expect(unitAiProd?.status).toBe('unported')
      expect(unitAiProd?.registeredUntested).toBe(false)

      // 4. Present only in a stripped gap set (e.g. SWITCH_IN_HOLD_EFFECTS in switchIn.ts)
      const gapSetProdFile: SourceFile = {
        file: 'web/src/engine/sim/switchIn.ts',
        source: `
const SWITCH_IN_HOLD_EFFECTS = new Set([
  HOLD_EFFECT_SYNTHETIC,
])
export function switchIn(state, battlerId) {
  // no real implementation here
}
`,
      }
      const resGapSet = runInventory([SYNTH_ITEM], {
        holdTriggerSources: SYNTH_HOLD_SOURCES,
        aiTriggerSources: {},
        flingSource: '',
        productionFiles: [gapSetProdFile],
        aiProductionFiles: [],
        testSources: [nonAiTestFile],
        allowlist: [],
      })
      const unitGapSet = resGapSet.units.find((u) => u.unit === 'HOLD_EFFECT_SYNTHETIC')
      expect(unitGapSet?.status).toBe('unported')

      // 5. Present only in a comment / note string
      const commentProdFile: SourceFile = {
        file: 'web/src/engine/sim/switchIn.ts',
        source: `
export function switchIn(state, battlerId) {
  // Note: HOLD_EFFECT_SYNTHETIC is not implemented yet
}
`,
      }
      const resComment = runInventory([SYNTH_ITEM], {
        holdTriggerSources: SYNTH_HOLD_SOURCES,
        aiTriggerSources: {},
        flingSource: '',
        productionFiles: [commentProdFile],
        aiProductionFiles: [],
        testSources: [nonAiTestFile],
        allowlist: [],
      })
      const unitComment = resComment.units.find((u) => u.unit === 'HOLD_EFFECT_SYNTHETIC')
      expect(unitComment?.status).toBe('unported')
    })

    it('(b) a token present only in a test title is unported', () => {
      const prodInMappedFunction: SourceFile = {
        file: 'web/src/engine/sim/switchIn.ts',
        source: `
export function switchIn(state, battlerId) {
    const effect = HOLD_EFFECT_SYNTHETIC;
}
`,
      }
      const titleOnlyTestFile: SourceFile = {
        file: 'web/src/engine/sim/heldItems.test.ts',
        source: `
it('HOLD_EFFECT_SYNTHETIC should trigger on entry', () => {
    expect(1 + 1).toBe(2);
});
`,
      }
      const res = runInventory([SYNTH_ITEM], {
        holdTriggerSources: SYNTH_HOLD_SOURCES,
        aiTriggerSources: {},
        flingSource: '',
        productionFiles: [prodInMappedFunction],
        aiProductionFiles: [],
        testSources: [titleOnlyTestFile],
        allowlist: [],
      })
      const unit = res.units.find((u) => u.unit === 'HOLD_EFFECT_SYNTHETIC')
      expect(unit?.status).toBe('unported')
      expect(unit?.registeredUntested).toBe(true)
      expect(unit?.testFile).toBeNull()
    })

    it('(c) a token present in a non-AI production file in the mapped function AND in a non-skipped non-AI test is ported', () => {
      const prodInMappedFunction: SourceFile = {
        file: 'web/src/engine/sim/switchIn.ts',
        source: `
export function switchIn(state, battlerId) {
    const effect = HOLD_EFFECT_SYNTHETIC;
}
`,
      }
      const realTestFile: SourceFile = {
        file: 'web/src/engine/sim/heldItems.test.ts',
        source: `
it('triggers synthetic held effect', () => {
    const token = HOLD_EFFECT_SYNTHETIC;
    expect(token).toBeDefined();
});
`,
      }
      const res = runInventory([SYNTH_ITEM], {
        holdTriggerSources: SYNTH_HOLD_SOURCES,
        aiTriggerSources: {},
        flingSource: '',
        productionFiles: [prodInMappedFunction],
        aiProductionFiles: [],
        testSources: [realTestFile],
        allowlist: [],
      })
      const unit = res.units.find((u) => u.unit === 'HOLD_EFFECT_SYNTHETIC')
      expect(unit?.status).toBe('ported')
      expect(unit?.registeredUntested).toBe(false)
      expect(unit?.testFile).toBe('web/src/engine/sim/heldItems.test.ts')
    })

    it('(d) the same token present in production only outside the mapped function is unported', () => {
      const prodOutsideMappedFunction: SourceFile = {
        file: 'web/src/engine/sim/switchIn.ts',
        source: `
export function switchIn(state, battlerId) {
    // mapped function does not touch it
}

export function unmappedSwitchInHelper(battlerId) {
    const effect = HOLD_EFFECT_SYNTHETIC;
}
`,
      }
      const realTestFile: SourceFile = {
        file: 'web/src/engine/sim/heldItems.test.ts',
        source: `
it('tests the helper', () => {
    expect(HOLD_EFFECT_SYNTHETIC).toBeDefined();
});
`,
      }
      const res = runInventory([SYNTH_ITEM], {
        holdTriggerSources: SYNTH_HOLD_SOURCES,
        aiTriggerSources: {},
        flingSource: '',
        productionFiles: [prodOutsideMappedFunction],
        aiProductionFiles: [],
        testSources: [realTestFile],
        allowlist: [],
      })
      const unit = res.units.find((u) => u.unit === 'HOLD_EFFECT_SYNTHETIC')
      expect(unit?.status).toBe('unported')
      expect(unit?.registeredUntested).toBe(false)
    })
  })

  describe('Item 4: preprocessor guard handling', () => {
    it('skips enum members inside #ifdef HOLD_EFFECT_* and #ifdef ITEM_* in synthetic C snippets', () => {
      const cSnippet = `
void TestFunction(void) {
#ifdef HOLD_EFFECT_ACTIVE_MACRO_DEF
    if (effect == HOLD_EFFECT_IN_ACTIVE) return;
#endif
#ifdef HOLD_EFFECT_Z_CRYSTAL
    if (effect == HOLD_EFFECT_Z_CRYSTAL) return;
#endif
#ifdef ITEM_SOME_FEATURE
    if (effect == HOLD_EFFECT_IN_ITEM_GUARD) return;
#endif
    if (effect == HOLD_EFFECT_REGULAR) return;
}
`
      const effects = new Set([
        'HOLD_EFFECT_IN_ACTIVE',
        'HOLD_EFFECT_Z_CRYSTAL',
        'HOLD_EFFECT_IN_ITEM_GUARD',
        'HOLD_EFFECT_REGULAR',
      ])
      const hits = scanHoldEffectHits('synthetic.c', cSnippet, effects)
      const hitEffects = hits.map((h) => h.effect)

      expect(hitEffects).not.toContain('HOLD_EFFECT_Z_CRYSTAL')
      expect(hitEffects).not.toContain('HOLD_EFFECT_IN_ITEM_GUARD')
      expect(hitEffects).toContain('HOLD_EFFECT_REGULAR')
    })

    it('verifies HOLD_EFFECT_Z_CRYSTAL in CanBattlerGetOrLoseItem (battle_util.c:8267) is skipped and emits no unit', () => {
      const zUnit = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_Z_CRYSTAL' && u.site === 'CanBattlerGetOrLoseItem',
      )
      expect(zUnit).toBeUndefined()
    })
  })

  describe('Item 5: template declaration recognition in abilities.cc', () => {
    it('recognises constexpr Ability Impl<ABILITY_X> = and member hook lambdas', () => {
      const cppSnippet = `
template <>
constexpr Ability Impl<ABILITY_CUSTOM_TEST> = {
    .onEntry = +[](ON_ENTRY) -> int {
        if (holdEffect == HOLD_EFFECT_CUSTOM) return 1;
        return 0;
    },
};
`
      const effects = new Set(['HOLD_EFFECT_CUSTOM'])
      const hits = scanHoldEffectHits('abilities.cc', cppSnippet, effects)
      expect(hits).toHaveLength(1)
      expect(hits[0].site).toBe('Impl<ABILITY_CUSTOM_TEST>.onEntry')
    })

    it('anchors the three upstream abilities.cc template citations', () => {
      // 1. Merciless onCrit (pipeline/.upstream/eliteredux-source/src/abilities.cc:2674)
      const mercilessHit = liveResult.units.find(
        (u) =>
          u.unit === 'HOLD_EFFECT_IRON_BALL' &&
          u.citation === 'pipeline/.upstream/eliteredux-source/src/abilities.cc:2674',
      )
      expect(mercilessHit).toBeDefined()
      expect(mercilessHit?.site).toBe('Impl<ABILITY_MERCILESS>.onCrit')

      // 2. North Wind onEntry (pipeline/.upstream/eliteredux-source/src/abilities.cc:4488)
      const northWindHit = liveResult.units.find(
        (u) =>
          u.unit === 'HOLD_EFFECT_LIGHT_CLAY' &&
          u.citation === 'pipeline/.upstream/eliteredux-source/src/abilities.cc:4488',
      )
      expect(northWindHit).toBeDefined()
      expect(northWindHit?.site).toBe('Impl<ABILITY_NORTH_WIND>.onEntry')

      // 3. Zen Garden onEntry (pipeline/.upstream/eliteredux-source/src/abilities.cc:11320)
      const zenGardenHit = liveResult.units.find(
        (u) =>
          u.unit === 'HOLD_EFFECT_SEEDS' &&
          u.citation === 'pipeline/.upstream/eliteredux-source/src/abilities.cc:11320',
      )
      expect(zenGardenHit).toBeDefined()
      expect(zenGardenHit?.site).toBe('Impl<ABILITY_ZEN_GARDEN>.onEntry')
    })
  })

  describe('Item 3: item-id-keyed test recognition fixes false negatives', () => {
    it('confirms the five previously false-negative units are now ported', () => {
      // 1. Weakness Policy (ITEMEFFECT_TARGET)
      const weaknessPolicy = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_WEAKNESS_POLICY' && u.site === 'ITEMEFFECT_TARGET',
      )
      expect(weaknessPolicy).toBeDefined()
      expect(weaknessPolicy?.status).toBe('ported')

      // 2. Throat Spray (ITEMEFFECT_LIFEORB_SHELLBELL)
      const throatSpray = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_THROAT_SPRAY' && u.site === 'ITEMEFFECT_LIFEORB_SHELLBELL',
      )
      expect(throatSpray).toBeDefined()
      expect(throatSpray?.status).toBe('ported')

      // 3. Expert Belt (CalcFinalDmg)
      const expertBelt = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_EXPERT_BELT' && u.site === 'CalcFinalDmg',
      )
      expect(expertBelt).toBeDefined()
      expect(expertBelt?.status).toBe('ported')

      // 4. Salac Berry SPEED_UP (ITEMEFFECT_MOVE_END)
      const salacSpeedUp = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_SPEED_UP' && u.site === 'ITEMEFFECT_MOVE_END',
      )
      expect(salacSpeedUp).toBeDefined()
      expect(salacSpeedUp?.status).toBe('ported')

      // 5. PRIMAL_ORB @ TryPrimalReversion and @ CanMegaEvolve
      const primalOrbReversion = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_PRIMAL_ORB' && u.site === 'TryPrimalReversion',
      )
      expect(primalOrbReversion).toBeDefined()
      expect(primalOrbReversion?.status).toBe('ported')

      const primalOrbMega = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_PRIMAL_ORB' && u.site === 'CanMegaEvolve',
      )
      expect(primalOrbMega).toBeDefined()
      expect(primalOrbMega?.status).toBe('ported')
    })
  })

  describe('Item 1: confirmed false "ported" units are now correctly unported', () => {
    it('verifies the 12 ITEMEFFECT_ON_SWITCH_IN units are unported', () => {
      const switchInFalseUnits = [
        'HOLD_EFFECT_ATTACK_UP',
        'HOLD_EFFECT_CONFUSE_SPICY',
        'HOLD_EFFECT_CONFUSE_DRY',
        'HOLD_EFFECT_CONFUSE_SWEET',
        'HOLD_EFFECT_CONFUSE_BITTER',
        'HOLD_EFFECT_CONFUSE_SOUR',
        'HOLD_EFFECT_CURE_SLP',
        'HOLD_EFFECT_RESTORE_HP',
        'HOLD_EFFECT_RESTORE_PCT_HP',
        'HOLD_EFFECT_RESTORE_STATS',
        'HOLD_EFFECT_AIR_BALLOON',
        'HOLD_EFFECT_SEEDS',
      ]
      for (const effect of switchInFalseUnits) {
        const unit = liveResult.units.find(
          (u) => u.unit === effect && u.site === 'ITEMEFFECT_ON_SWITCH_IN',
        )
        expect(unit, `Expected ${effect}@ITEMEFFECT_ON_SWITCH_IN to exist`).toBeDefined()
        expect(unit?.status, `Expected ${effect}@ITEMEFFECT_ON_SWITCH_IN to be unported`).toBe('unported')
      }
    })

    it('verifies EJECT_BUTTON and STICKY_BARB at ITEMEFFECT_TARGET are unported', () => {
      const ejectButton = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_EJECT_BUTTON' && u.site === 'ITEMEFFECT_TARGET',
      )
      expect(ejectButton?.status).toBe('unported')

      const stickyBarb = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_STICKY_BARB' && u.site === 'ITEMEFFECT_TARGET',
      )
      expect(stickyBarb?.status).toBe('unported')
    })

    it('verifies MENTAL_HERB x2 (ENDTURN_ITEMS1/2 and ITEMEFFECT_MOVE_END) are unported', () => {
      const mentalHerbEndTurn = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_MENTAL_HERB' && u.site === 'ENDTURN_ITEMS1/2',
      )
      expect(mentalHerbEndTurn?.status).toBe('unported')

      const mentalHerbMoveEnd = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_MENTAL_HERB' && u.site === 'ITEMEFFECT_MOVE_END',
      )
      expect(mentalHerbMoveEnd?.status).toBe('unported')
    })

    it('verifies SEEDS@Cmd_various (battle_script_commands.c:7818) is unported', () => {
      const seedsCmd = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_SEEDS' && u.site === 'Cmd_various',
      )
      expect(seedsCmd?.status).toBe('unported')
    })

    it('verifies HOLD_EFFECT_ROCKY_HELMET in AI_CheckViability (AI trigger) is unported', () => {
      const rockyAi = liveResult.units.find(
        (u) => u.kind === 'ai-trigger' && u.unit === 'HOLD_EFFECT_ROCKY_HELMET' && u.site === 'AI_CheckViability',
      )
      expect(rockyAi?.status).toBe('unported')
    })

    it('verifies AI_DoubleBattle CURE_CONFUSION and CURE_STATUS are unported', () => {
      const confuseAi = liveResult.units.find(
        (u) => u.kind === 'ai-trigger' && u.unit === 'HOLD_EFFECT_CURE_CONFUSION' && u.site === 'AI_DoubleBattle',
      )
      expect(confuseAi?.status).toBe('unported')

      const statusAi = liveResult.units.find(
        (u) => u.kind === 'ai-trigger' && u.unit === 'HOLD_EFFECT_CURE_STATUS' && u.site === 'AI_DoubleBattle',
      )
      expect(statusAi?.status).toBe('unported')
    })
  })

  describe('Item 7: Life Orb known partial port', () => {
    it('verifies HOLD_EFFECT_LIFE_ORB at ITEMEFFECT_LIFEORB_SHELLBELL is classified as unported due to known partial differences', () => {
      const lifeOrb = liveResult.units.find(
        (u) => u.unit === 'HOLD_EFFECT_LIFE_ORB' && u.site === 'ITEMEFFECT_LIFEORB_SHELLBELL',
      )
      expect(lifeOrb).toBeDefined()
      expect(lifeOrb?.status).toBe('unported')
      expect(lifeOrb?.partialReason).toBeDefined()
      expect(lifeOrb?.partialReason).toContain('canProc')
      expect(lifeOrb?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_util.c:6085')
    })
  })
})
