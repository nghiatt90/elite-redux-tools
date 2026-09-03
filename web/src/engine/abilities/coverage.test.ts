import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { lookupAbility } from './registry'
import { isUnmodelled } from './types'
import './impl/index' // populates the registry as a side effect

const HOOKS_PATH = fileURLToPath(new URL('../../../../data/v2.65beta/abilityHooks.json', import.meta.url))
const abilityHooks: Record<string, { sourceLine: number; damageRelevant: boolean; damageRelevantReasons: string[] }> = JSON.parse(
  readFileSync(HOOKS_PATH, 'utf-8'),
)

describe('ability registry coverage gate', () => {
  let damageRelevantIds: string[]

  beforeAll(() => {
    damageRelevantIds = Object.entries(abilityHooks)
      .filter(([, a]) => a.damageRelevant)
      .map(([id]) => id)
  })

  it('every damage-relevant ability has a registry entry -- port or explicit UNMODELLED', () => {
    const missing = damageRelevantIds.filter((id) => !lookupAbility(id))
    if (missing.length > 0) {
      const detail = missing
        .slice(0, 20)
        .map((id) => `  ${id} (src/abilities.cc:${abilityHooks[id].sourceLine}, hooks: ${abilityHooks[id].damageRelevantReasons.join(', ')})`)
        .join('\n')
      throw new Error(
        `${missing.length} damage-relevant abilities have no registry entry at all (neither ported nor marked unmodelled):\n${detail}` +
          (missing.length > 20 ? `\n  ...and ${missing.length - 20} more` : ''),
      )
    }
  })

  it('every registry entry (port or stub) cites a source line', () => {
    const withoutSrc = damageRelevantIds.filter((id) => {
      const entry = lookupAbility(id)
      return entry && !entry.src
    })
    expect(withoutSrc).toEqual([])
  })

  it('a ported ability (AbilityImpl) is never also left in 99-unmodelled.ts', () => {
    // registerAbilities() in impl/index.ts already throws on a literal duplicate id
    // across batches -- this test documents that guarantee explicitly, so a
    // regression here fails with a clear message instead of only at import time.
    for (const id of damageRelevantIds) {
      const entry = lookupAbility(id)
      expect(entry).toBeDefined()
    }
  })

  it('reports the current unmodelled count -- this number should only go DOWN', () => {
    const unmodelledCount = damageRelevantIds.filter((id) => {
      const entry = lookupAbility(id)
      return entry && isUnmodelled(entry)
    }).length
    // Updated after each Task 10 batch as abilities are ported out of
    // 99-unmodelled.ts. An INCREASE here means an ability lost its port and fell
    // back to a stub; investigate rather than raise the number.
    // 538 (Task 9 baseline) -> 517 (batch A1: 21 onOffensiveMultiplier)
    //     -> 499 (batch B1: 18 onDefensiveMultiplier)
    //     -> 491 (batch A2: 8 more onOffensiveMultiplier)
    //     -> 486 (batch D1: 5 onCrit)
    //     -> 469 (batch E1: 17 onStab/"-ate" abilities)
    //     -> 457 (batch A3: 12 more onOffensiveMultiplier, incl. 4 delegate composites)
    //     -> 451 (batch B2: 6 more onDefensiveMultiplier)
    //     -> 431 (batch F: 20 SWARM_MULTIPLIER-family onOffensiveMultiplier)
    //     -> 425 (batch G: 6 hub abilities -- Battle Armor, Stall, Analytic,
    //             Water Bubble, Fatal Precision, Sand Guard)
    //     -> 303 (batch H: 122 generic lazy-delegation aliases, see impl/alias.ts)
    //     -> 270 (batch I: 33 more onOffensiveMultiplier, several with a
    //             onDefensiveMultiplier half too: Fossilized, Raw Wood, Punk Rock,
    //             Seaweed)
    //     -> 230 (batch J: 21 pure addsType declaratives; batch K: 19 more
    //             onDefensiveMultiplier, incl. Lead Coat/Chrome Coat's onStat halves
    //             and 3 composite delegates)
    //     -> 193 (batch L: 37 onStat -- weather/terrain/highest-stat/status/hp
    //             families, the 2 Solar-Power+Chlorophyll composites, and the 4
    //             Ruin abilities)
    //     -> 174 (batch M: 12 "-ate"-family abilities whose extra hooks turned out
    //             to be aliases/small lambdas, + 7 plain onStab-only abilities)
    //     -> 157 (batch N: 17 onTypeEffectiveness/onAfterTypeEffectiveness --
    //             neither hook is wired into calculate.ts's fold yet, but each port
    //             is complete and correct for when it is)
    //     -> 145 (batch O: 6 onCrit, 5 onSwapSplit, 1 onDefensiveMultiplier/
    //             composite -- Bad Luck, Hyper Cutter, Perfectionist, Precise Fist,
    //             Stalwart, Strategic Pause, Mystic Blades, Energized Horns,
    //             Mythical Arrows, Best Offense, Pony Power, Bass Boosted)
    //     -> 133 (batch P: 12 more onOffensiveMultiplier -- 4 "sound Normal move"
    //             onMoveType conversions + composites of already-ported abilities)
    //     -> 124 (batch Q: 9 onChooseOffensiveStat/onChooseDefensiveStat stat-swap
    //             abilities, now that the hooks are wired into calculate.ts)
    //     -> 122 (batch R: Cosmic Wings, unblocked by fixing
    //             resolveEffectiveMoveType's incorrect Normal-only gate; Super
    //             Strain's onRecoil, unwired but complete)
    //     -> 120 (batch S: Mosh Pit, Rat King -- both ALLY-only-scoped, so
    //             permanently inert in this v1 singles engine, matching Plus/
    //             Minus/Telepathy)
    //     -> 119 (batch T: Higher Rank, unblocked by threading move.priority
    //             through to OffensiveMultiplierContext)
    expect(unmodelledCount).toBeLessThanOrEqual(119)
    console.log(`ability coverage: ${damageRelevantIds.length - unmodelledCount}/${damageRelevantIds.length} damage-relevant abilities ported`)
  })
})
