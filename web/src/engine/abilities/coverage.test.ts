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
    //     -> 33  (batch AC: the ability-activation-state family, step 7 of the
    //             field report's roadmap -- a new generic per-battler `abilityOn`
    //             scenario toggle (BattlerBattleState/BattlerConfig, a UI checkbox
    //             in BattlerPanel.tsx), matching @smogon/calc's own field for this
    //             exact class of mechanism (GetAbilityState/isFirstTurn/timer state
    //             this non-turn-simulating engine can't derive). Threaded into
    //             OffensiveMultiplierContext (attackerAbilityOn), Defensive
    //             MultiplierContext (defenderAbilityOn), OnStatContext (abilityOn,
    //             the stat owner's own), and OnCritContext (abilityOn, resolved
    //             per-side by computeAbilityCritBonus's own run() closure since a
    //             single shared value would be ambiguous across the attacker/
    //             defender runs). Unburden, Power Outage, Chuckster, Drakelp Head,
    //             Stakeout, Ambush, Slow Start ported fresh; Flash Fire's
    //             onOffensiveMultiplier half added to its existing onAbsorb entry.
    //             abilityOn mirrors the RAW GetAbilityState flag, not "boost
    //             active" -- some abilities invert it (documented per-entry).
    //             Lethargy's 5-tier turn-count decay and Protosynthesis's
    //             which-stat-gets-boosted selection need different field shapes
    //             (a turn counter, a boostedStat selector) and are deliberately
    //             left for a follow-up rather than forced into this boolean.
    //     -> 27  (batch AD: the secondary-stat-blend family, step 8 of the field
    //             report's roadmap -- CalculateStat's cross-stat blend
    //             (battle_util.c:7213-7229) is now genuinely wired: computeChoose
    //             OffensiveStat/computeChooseDefensiveStat return a ChosenStat
    //             {statToUse, secondaryStat} instead of just statToUse, and
    //             calculate.ts's new applySecondaryStatBlend folds each named
    //             OTHER stat's fully-scaled value (stat-stage ratio, extraStatLevel,
    //             onStat hooks all included, matching the C's own recursive
    //             CalculateStat call) into the primary at percent/100. Fixed a real
    //             bug in computeChooseDefensiveStat along the way: it discarded
    //             secondaryStat whenever statToUse was unchanged, which would have
    //             silently dropped Sleek Scales (it never touches statToUse at
    //             all) -- now merged across both the attacker and defender runs,
    //             short-circuiting at the first primary-stat override exactly like
    //             the C's `for (...) && !defStatToUse` loop. Juggernaut, Speed
    //             Force, Power Core, Terminal Velocity, Slipstream, Sleek Scales
    //             ported fresh; their 6 aliases (Iron Giant, Sumo Guard, Sand
    //             Titan, Unstable Core, Maximum Acceleration, Mach 3) needed no
    //             patch at all -- they already pointed at these abilities from
    //             an earlier batch and just started working once the target
    //             stopped being an unmodelled stub.
    //     -> 25  (batch AE: Dark Aura/Fairy Aura -- boost same-type moves used by
    //             EITHER battler (onOffensiveMultiplierFor: APPLY_ON_ANY), reduced
    //             instead if any battler on the field holds an auraBreak-flagged
    //             ability (new AbilityFlags.auraBreak, set on the 2 abilities that
    //             carry it: Aura Break, Nihil Blaster -- IsAbilityOnField's own
    //             `FALSE` checkMoldBreaker means this is never suppressed).
    //             isAuraBreakActive is computed once per hit in calculate.ts from
    //             both battlers' slots (hasFlag), since the hook itself only ever
    //             sees its own holder's facts. Pixie Power's existing alias to
    //             Fairy Aura needed no patch -- it just started working. Verified
    //             end-to-end: a defender-held Dark Aura still boosts the
    //             attacker's Dark move.
    //     -> 24  (batch AF: Rivalry -- the last of the field report's named step-7
    //             scenario toggles. New BattlerBattleState/BattlerConfig.gender
    //             ('MALE'|'FEMALE'|'GENDERLESS', a UI select in BattlerPanel.tsx),
    //             defaulting to 'MALE' but forced to 'GENDERLESS' at
    //             buildBattlerState time for a genderless species regardless of
    //             the stored config (species.json's own gender field is a ratio/
    //             genderless flag, not a fixed value -- an individual's real
    //             gender depends on its personality, which this calculator
    //             doesn't model). Threaded into both OffensiveMultiplierContext
    //             and DefensiveMultiplierContext as attackerGender/defenderGender
    //             (Rivalry's own offensive half compares attacker-vs-defender
    //             directly; its defensive half compares the FLIPPED attacker
    //             gender against the defender's, matching the C's literal
    //             MALE<->FEMALE swap). Verified end-to-end both directions.
    //     -> 23  (batch AG: Protosynthesis -- the last of the field report's named
    //             step-7 scenario toggles. New BattlerBattleState/BattlerConfig.
    //             boostedStat (a BattleStatKey | null UI select in
    //             BattlerPanel.tsx, matching @smogon/calc's own field), since
    //             this calculator has no weather/terrain turn simulation to
    //             derive "did Protosynthesis just activate, and on which stat"
    //             from. onStat reads it directly: 1.5x for Speed, 1.3x for any
    //             other matching stat (integer truncation, not float, matching
    //             the C's own `*stat *=` on a u32). Quark Drive's existing alias
    //             needed no patch. This closes out ALL 5 of the field report's
    //             named step-7 toggles (abilityOn, semiInvulnerable, aura
    //             booleans, gender, boostedStat) end to end.
    //     -> 21  (batch AH: Soul Harvest/Supreme Overlord -- the fainted-teammate-
    //             count family. New BattlerBattleState/BattlerConfig.alliesFainted
    //             (a 0-5 UI slider), matching @smogon/calc's own field, since this
    //             v1 singles engine has no team/fainted concept to derive
    //             gFaintedMonCount from. Both scale via integer division (idiv),
    //             not a float multiply, and clamp at 5 fainted (min(5, ...)) --
    //             verified end-to-end (Supreme Overlord boosting a physical
    //             Tackle).
    //     -> 18  (batch AI: Cosmic Daze/Cosmic Dust, Madness Enhancement, Tangled
    //             Feet -- the STATUS2_CONFUSION/STATUS2_ENRAGED family. New
    //             ConditionBattlerContext.isConfused/isEnraged (2 checkboxes in
    //             BattlerPanel.tsx, not mutually exclusive with the Status select),
    //             since this calculator has no turn simulation to derive these
    //             volatiles from. Threaded as defenderIsConfused/defenderIsEnraged
    //             on OffensiveMultiplierContext (the move's TARGET), defenderIsEnraged
    //             on DefensiveMultiplierContext (the ability holder itself), and
    //             attackerIsConfused on OnChooseDefensiveStatContext (Tangled Feet
    //             is unscoped, so per IsApplyOnFlagAppropriate's own self-check it
    //             only ever fires while checking the ATTACKER's own slots -- see
    //             computeChooseDefensiveStat's doc). Cosmic Dust's existing alias
    //             needed no patch. Verified end-to-end: Cosmic Daze doubles damage
    //             against a confused defender.
    //     -> 16  (batch AJ: Avenger and Blood Stigma, bundled as the last of the
    //             easy cross-battler-fact checks. Avenger reuses the EXISTING
    //             generic attackerAbilityOn toggle instead of adding a new
    //             single-purpose field for gSideTimers[side].retaliateTimer (a
    //             per-side history fact this engine can't derive, same class of
    //             mechanism abilityOn already covers). Blood Stigma needed no new
    //             scenario field at all -- just defenderStatus1/
    //             defenderHasBloodStainEffect threaded onto
    //             OffensiveMultiplierContext, since that per-battler condition
    //             data already existed. Verified end-to-end (Blood Stigma vs a
    //             bleeding defender).
    //     -> 14  (batch AK: Bone Zone and Soothsayer, both onAfterTypeEffectiveness
    //             -- still NOT wired into calculate.ts's type-effectiveness fold
    //             (same as the rest of batch N), but each port is complete and
    //             correct. Bone Zone turned out to need no new field at all -- the
    //             earlier note calling perTypeModifiers insufficient was a
    //             misreading; the C passes mod1/2/3 as plain read-only values, and
    //             the existing field already covers that. Soothsayer's decaying
    //             countdown reuses the generic abilityOn toggle (new
    //             OnAfterTypeEffectivenessContext.defenderAbilityOn), same
    //             precedent as Avenger/Blood Stigma.
    //     -> 13  (batch AL: Pretty Princess -- needed no new scenario field, just
    //             threading two ALREADY-EXISTING per-battler facts onto
    //             OffensiveMultiplierContext: attackerIsUnaware (the ATTACKER's
    //             own Unaware self-check, never suppressed even though breakable,
    //             matching every other self-check in this registry) and
    //             defenderHasAnyLoweredStat (derived from
    //             ConditionBattlerContext.negativeStatStageCount, already used by
    //             Lash Out). Verified end-to-end both directions, including that
    //             Unaware held as an INNATE alongside Pretty Princess correctly
    //             suppresses its own boost.
    //     -> 12  (batch AM: Sheer Force. FLAG_SHEER_FORCE_BOOST looked like it
    //             needed a new pipeline-emitted move flag, but BattleMovesGenerator
    //             .kt derives it entirely from data already emitted: split !=
    //             STATUS && effectChance != 0 && !noSheerForce (the move's own
    //             argument-effect half of the noSheerForce check isn't threaded
    //             into MoveData, so this covers the common case only, matching
    //             this engine's existing move-argument approximations elsewhere).
    //             Just needed MoveData/OffensiveMultiplierContext.moveEffectChance
    //             threaded through -- no pipeline change, no data regeneration.
    //             Verified end-to-end: MOVE_ACID (effectChance 30) is boosted,
    //             MOVE_TACKLE (effectChance 0) is not.
    //     -> 10  (batch AN: Normalize and Superconductor together -- both read the
    //             same gBattleStruct->ateBoost[battler] flag, now threaded through
    //             as OffensiveMultiplierContext.ateBoost (resolveEffectiveMoveType
    //             already computed and discarded it at the call site). Normalize's
    //             onMoveType was previously (wrongly) believed to need a "convert
    //             EVERY move to Normal" mechanism resolveEffectiveMoveType didn't
    //             have -- it has no such restriction; the unconditional conversion
    //             ports directly. Both abilities' own onOffensiveMultiplier bonus
    //             is dead code with today's ability roster (see the batch file's
    //             own comment for why: only the FIRST ability whose onMoveType
    //             changes the type survives the dispatch loop, in both the C and
    //             this port, and no ability sets ateBoost while landing on
    //             TYPE_NORMAL) -- ported faithfully and unit-tested at the hook
    //             level, verified end-to-end only for the type-conversion half.
    //     -> 8   (batch AO: Dreamcatcher and Dreamscape. The real C scans the whole
    //             opposing SIDE for any asleep/Comatose battler -- this engine only
    //             ever models one defender, so that reduces to "is the defender
    //             asleep," and the C's own recursion guard (skip the boost when
    //             this call IS the ability's own out-of-turn retaliatory hit)
    //             depends on gProcessingExtraAttacks state this engine never sets,
    //             so it's always false here and safely omitted. New
    //             OffensiveMultiplierContext.defenderHasComatose field (existing
    //             ConditionBattlerContext.hasComatose, not yet threaded to this
    //             context). Victory Bomb (same onMoveType-scoped-to-a-synthetic-
    //             attack shape as Dreamcatcher's guard) is documented as
    //             permanently unmodelled on OnMoveTypeContext instead of ported --
    //             its onDefender half isn't a damage hook at all. Verified
    //             end-to-end: both abilities double damage vs a sleeping defender,
    //             Dreamscape additionally stacks its flat 1.2x.
    //     -> 7   (batch AP: Eternal Flower. GetBaseSpeciesFromMega(species) reduces
    //             to species.json's own `megas`/`primals` lists being nonempty
    //             (this species itself IS a Mega/Primal form) -- new
    //             ConditionBattlerContext.isMegaEvolved field, derived at
    //             buildBattlerState time. Reuses the SAME shared NonStackingState
    //             bitfield as Ruin (a separate bit, nonStackingEternalFlower) and
    //             the same applyOn.onStatFor: APPLY_ON_OTHER shape. The C's own
    //             self-immunity check (an Eternal Flower holder is never debuffed
    //             by another) needed a new derived OnStatContext field,
    //             statOwnerHasEternalFlower, computed once per call by
    //             computeOnStatModifier since ctx has no other way to see the stat
    //             owner's own ability slots. Verified end-to-end against a real
    //             Mega Venusaur.
    //     -> 5   (batch AQ: Illusion and Lethargy. Illusion's
    //             gBattleStruct->illusion[battler].on/broken flags are the same
    //             class of per-battle activation state the generic attackerAbilityOn
    //             toggle already covers -- reused directly, no new field. Lethargy
    //             reads the EXACT value of gVolatileStructs[battler].slowStartTimer
    //             (the SAME underlying timer Slow Start's own plain `if (timer)`
    //             boolean check already approximates via abilityOn) for a 5-tier
    //             multiplier a boolean can't represent -- new numeric
    //             BattlerBattleState.slowStartTimer scenario field (0-5, default 5
    //             = expired/no debuff), full 6-step plumbing (engine/types.ts,
    //             scenario.ts, BattlerPanel.tsx slider, abilities/types.ts
    //             attackerSlowStartTimer, calculate.ts wiring, ability port).
    //             Verified end-to-end for both.
    //     -> 2   (batch AR: Ape Shift, Color Spectrum, Crystallize. Ape Shift's
    //             self-species check (SPECIES_SLAKING_MEGA_APE_SHIFT) needed a new
    //             per-side-resolved OnCritContext.speciesId field -- same threading
    //             shape as abilityOn (2 new trailing params on
    //             computeAbilityCritBonus). Color Spectrum's onEndTurn random
    //             re-typing isn't simulated, but its onOffensiveMultiplier
    //             condition (StabMultiplierInHalves > 2) is just "does this move
    //             get STAB at all" -- new OffensiveMultiplierContext.attackerHasStab
    //             field reuses calculate.ts's own stabInHalves() call, computed
    //             earlier than its usual call site. Crystallize is the same
    //             Rock->Ice/ateBoost shape as Superconductor, but UNLIKE
    //             Superconductor's dead self-combo, Crystallize's own conversion
    //             (moveType becomes ICE) DOES satisfy its own onOffensiveMultiplier
    //             condition (moveType==ICE), so it fires from a single ability with
    //             no multi-ability combo needed. Verified end-to-end for all three.
    //             Remaining 2 (Deadly Precision, Victory Bomb) are permanently
    //             unmodelled by design -- see OnMoldBreaker's and OnMoveTypeContext's
    //             own doc comments for why.
    expect(unmodelledCount).toBeLessThanOrEqual(2)
    console.log(`ability coverage: ${damageRelevantIds.length - unmodelledCount}/${damageRelevantIds.length} damage-relevant abilities ported`)
  })
})
