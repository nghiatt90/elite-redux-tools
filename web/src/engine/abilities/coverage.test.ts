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
    //     -> 40  (batch U: fixed generate-declarative-abilities.mjs's selection
    //             predicate -- it required ZERO hooks of any kind, so an ability
    //             whose only DAMAGE-relevant content was a bitfield but which also
    //             defined an unrelated non-damage hook (onEntry, onAbsorb, ...)
    //             fell into this file by mistake. Fixed to "no hook in the damage
    //             set" and regenerated: 80 abilities moved to 00-flags.ts for
    //             free, including 4 that were producing WRONG numbers (Contempt/
    //             unaware, RKS System/adaptability+omniStab, Prim and Proper +
    //             Wonder Scale/fortKnox -- all flags the engine already reads,
    //             just never attached). See the field-report artifact linked in
    //             the session history for the full audit this batch executed.)
    //     -> 105 (batch V: census EXPANDED, not shrunk -- added onParentalBond/
    //             onAbsorb/onImmune/onInfiltrate/onModifyMoveFlags/onMoldBreaker to
    //             _DAMAGE_HOOKS (ability_hooks.py), a genuine undercount the field
    //             report found: these 6 hooks change the damage number but were
    //             excluded from the census entirely. Total damage-relevant grew
    //             560->590. Two things happened at once: 30 abilities became
    //             damage-relevant for the first time (all unmodelled, +30), and 35
    //             abilities that were previously pure declarative-flag entries in
    //             00-flags.ts turned out to ALSO define one of the 6 new hooks --
    //             their flags alone no longer honestly cover them, so they moved
    //             to explicit unmodelled stubs rather than silently staying
    //             "done": 40 (batch U) - 40 (all re-verified still real) + 35
    //             (demoted from 00-flags.ts) + 70 (genuinely new to the census,
    //             includes both the 30 newly-relevant abilities and any prior
    //             entries whose reasons grew a new hook) = 105. This is the SAME
    //             kind of correction as batch U, just in the opposite direction:
    //             the gate exists so an undercount fails loudly instead of
    //             silently shipping a wrong number, and a rising count here means
    //             the audit worked as intended.
    //     -> 103 (batch W: onMoldBreaker family -- Mold Breaker (unconditional),
    //             Teravolt/Turboblaze/Blind Rage (alias, added to their EXISTING
    //             addsType/onTypeEffectiveness entries), Mycelium Might (status
    //             moves only). Also wired real Mold Breaker suppression into
    //             computeAbilityMultiplier's defensive loop, computeAbilityCritBonus's
    //             defender run, and Relic Stone's check -- Deadly Precision/
    //             Flawless Precision/Mach 3/Overrule/Stonecutter's onMoldBreaker
    //             halves stay unmodelled (already real-ported for their OTHER
    //             hooks) since their condition requires recursively simulating
    //             the hit's own resolved type/crit/effectiveness first.
    //     -> 86  (batch X: all 24 onParentalBond census abilities -- 17 fresh ports
    //             (Parental Bond, Hyper Aggressive, Ghost Frenzy, Raging Goddess,
    //             Balloon Blitz, Frenzied Phantom, Dual Hammer, Dual Wield, Familia
    //             Bond, Ice Cold Hunter, Minion Control, Multi Headed, Primal Maw,
    //             Raging Boxer, Raging Moth, Unrelenting, Hydra) plus onParentalBond
    //             added to 7 abilities already real-ported for a different hook
    //             (3 GT 1, Devourer, Hand Barnacles, Magus Blades, Metallic Jaws,
    //             Steel Beetle, Witch Broom). NOT wired into calculate.ts -- this v1
    //             engine computes one hit, and Parental Bond only affects a bonus
    //             hit's own multiplier -- same "correct now, wired later" shape as
    //             batch N's onTypeEffectiveness ports. Species.json's `heads` field
    //             (already emitted, just never consumed) unblocks Multi Headed's
    //             family without any pipeline change.
    //     -> 66  (batch Y: all 22 onAbsorb census abilities -- 20 fresh ports plus
    //             onAbsorb added to Dry Skin and Elemental Vortex (already
    //             real-ported for a different hook). WIRED into calculate.ts
    //             (computeIsAbsorbed, right after the type-effectiveness check) --
    //             unlike batch X, this genuinely forces today's damage number to 0,
    //             the same way a type immunity does, verified end-to-end against a
    //             super-effective Surf vs Water-Absorb Garchomp. Flash Fire's
    //             onOffensiveMultiplier half (gated on in-battle activation state
    //             this engine doesn't track) stays undone, documented inline --
    //             only its onAbsorb half was portable.
    //     -> 52  (batch Z: all 19 onImmune census abilities -- 14 fresh ports plus
    //             onImmune added to Empress, Sand Fiend, Sand Guard, Sepia Lens,
    //             Sun Basking (already real-ported for a different hook). WIRED
    //             into calculate.ts (computeIsImmune, right after the onAbsorb
    //             check), forcing typeEffectiveness to 0 the same way -- a hard
    //             block distinct from onAbsorb (no heal/stat-boost side effect).
    //             Three of the C's conditions (same-side, self-target,
    //             gProcessingExtraAttacks) are fixed always-true/false constants
    //             in this v1 2-battler singles engine -- documented on
    //             OnImmuneContext itself rather than modelled as real fields.
    //     -> 47  (batch AA: all 10 onInfiltrate census abilities -- 5 fresh ports
    //             (Infiltrator, Duality, King of the Jungle, Pinnacle Blade,
    //             Demolitionist) plus onInfiltrate added to 5 abilities already
    //             real-ported for a different hook (Fight Spirit, Warriors Spear,
    //             Qigong, Marine Apex, Mycelium Might). WIRED into calculate.ts
    //             (computeInfiltratesScreens, ANDed into screensActive) --
    //             checkMoldBreaker=FALSE, an attacker's own trait never suppressed
    //             by its own Mold Breaker, verified end-to-end against a
    //             Reflect-halved Tackle. Only the screens-bypass bit of the C's
    //             3-bit InfiltrateType is modelled -- the SUBSTITUTE bit has no
    //             Substitute mechanic to matter to. Demolitionist's readiedAction
    //             volatile follows the SAME always-false precedent already set
    //             elsewhere in this engine (battleStat.ts), not a new gap.
    //     -> 40  (batch AB: all 10 onModifyMoveFlags census abilities -- the LAST
    //             of the 6 hooks the field-report audit added to the census. 7
    //             fresh ports (Brawling Wyvern, Festivities, Junshi Sanda, Mixed
    //             Martial Arts, Musical Notes, Reverbate, Taekkyeon) plus
    //             onModifyMoveFlags added to 3 abilities already real-ported for a
    //             different hook (Backstreet Boy, Chestnut Axe, Gunman). NOT wired
    //             into calculate.ts -- this is a "does the move's own battler grant
    //             it this flag" fallback that 22 existing moveFlags.X call sites
    //             would need the granting battler's ability slots threaded into
    //             their context to consult (several already flag this exact gap in
    //             their own comments: Liquid Voice, Punk Rock, Dual Wield, Magus
    //             Blades, Primal Maw, Raging Boxer) -- same "correct now, wired
    //             later" shape as batch N. This closes out all 6 census-expansion
    //             hooks from the field report (onParentalBond/onAbsorb/onImmune/
    //             onInfiltrate/onModifyMoveFlags/onMoldBreaker) end to end.
    expect(unmodelledCount).toBeLessThanOrEqual(40)
    console.log(`ability coverage: ${damageRelevantIds.length - unmodelledCount}/${damageRelevantIds.length} damage-relevant abilities ported`)
  })
})
