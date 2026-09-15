// Batch O: the remaining onCrit/onSwapSplit lambdas portable with existing context
// fields, plus one onDefensiveMultiplier alias/composite (Bass Boosted) found
// alongside them. onSwapSplit is wired into calculate.ts's resolveSplit (attacker-
// only, dispatched via dispatchCalc.computeSwapSplit) -- found and fixed in the
// same ported-but-not-dispatched audit as onTypeEffectiveness/onAfterTypeEffectiveness.
//
// Deferred (left in 99-unmodelled.ts): Ambush/Ape Shift (need per-turn "is this the
// battler's first turn" / an exact mega-form species check, neither tracked),
// Chuckster/Drakelp Head (persistent per-battle ability-activation state), Madness
// Enhancement (STATUS2_ENRAGED, not tracked), Rivalry (needs gender).

import { NEVER_CRIT } from '../../crit'
import { APPLY_ON_FOE } from '../applyOn'
import { aliasOffensiveMultiplier, aliasDefensiveMultiplier, aliasSwapSplit, aliasCrit } from './alias'
import type { AbilityImpl } from '../types'

export const CRIT_SWAPSPLIT_MISC: AbilityImpl[] = [
  {
    id: 'ABILITY_BAD_LUCK',
    src: 'src/abilities.cc:4276',
    flags: { breakable: true, foesMinRoll: true },
    applyOn: { onCritFor: APPLY_ON_FOE },
    onCrit: () => NEVER_CRIT,
  },
  {
    // Bad Luck clone: onEntry is a Scare (Intimidate-clone) drop, non-damage. Of Bad
    // Luck's own onAccuracy/onCrit/onModifyEffectChance trio, only onCrit is
    // modelled by this engine at all (see 09-hub-abilities.ts/23-mold-breaker.ts's
    // own "onAccuracy has no modelling target here" precedent) -- so onCrit plus
    // its onCritFor scope is the only piece that matters for damage. Unlike Bad
    // Luck itself, Scarecrow's own C block does NOT set foesMinRoll -- do not add it.
    id: 'ABILITY_SCARECROW',
    src: 'src/abilities.cc:9972',
    flags: { breakable: true },
    applyOn: { onCritFor: APPLY_ON_FOE },
    onCrit: aliasCrit('ABILITY_BAD_LUCK'),
  },
  {
    id: 'ABILITY_HYPER_CUTTER',
    src: 'src/abilities.cc:1129',
    flags: { breakable: true },
    onCrit: (ctx) => (ctx.moveFlags.contact ? 1 : 0),
  },
  {
    id: 'ABILITY_PERFECTIONIST',
    src: 'src/abilities.cc:3806',
    onCrit: (ctx) => (ctx.basePower > 0 && ctx.basePower <= 50 ? 1 : 0),
  },
  {
    // IsIronFistBoosted(battler, move) == DoesMoveMatchFlag(..., MOVE_FLAG_PUNCH),
    // src/abilities.cc's punch-flag case -- same moveFlags.punchBased check Iron
    // Fist itself uses (batch 03).
    id: 'ABILITY_PRECISE_FIST',
    src: 'src/abilities.cc:4730',
    onCrit: (ctx) => (ctx.moveFlags.punchBased ? 1 : 0),
  },
  {
    id: 'ABILITY_STALWART',
    src: 'src/abilities.cc:10584',
    applyOn: { onCritFor: 'APPLY_ON_TARGET' },
    onCrit: () => NEVER_CRIT,
  },
  {
    // onOffensiveMultiplier delegates to Analytic; onCrit uses Analytic's own
    // "attacker acts second" condition (see 09-hub-abilities.ts's note on
    // attackerActsFirst) for a +2 crit stage instead of a damage multiplier. The
    // EFFECT_FUTURE_SIGHT exclusion isn't modelled, matching Analytic's own note.
    id: 'ABILITY_STRATEGIC_PAUSE',
    src: 'src/abilities.cc:9881',
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_ANALYTIC'),
    onCrit: (ctx) => (!ctx.attackerActsFirst ? 2 : 0),
  },
  {
    // Referenced by ABILITY_MAGUS_BLADES/ABILITY_SINISTER_CLAWS's aliases (batch H)
    // and ABILITY_BEST_OFFENSE/ABILITY_PONY_POWER's aliases below.
    id: 'ABILITY_MYSTIC_BLADES',
    src: 'src/abilities.cc:6460',
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_KEEN_EDGE'),
    onSwapSplit: (ctx) => ctx.moveSplit === 'PHYSICAL' && !!ctx.moveFlags.sliceBased,
  },
  {
    id: 'ABILITY_ENERGIZED_HORNS',
    src: 'src/abilities.cc:9217',
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_MIGHTY_HORN'),
    onSwapSplit: (ctx) => ctx.moveSplit === 'PHYSICAL' && !!ctx.moveFlags.hornBased,
  },
  {
    id: 'ABILITY_MYTHICAL_ARROWS',
    src: 'src/abilities.cc:7600',
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_ARCHER'),
    onSwapSplit: (ctx) => ctx.moveSplit === 'PHYSICAL' && !!ctx.moveFlags.arrowBased,
  },
  {
    // Upstream pin correction, not a porting bug: `upcoming`'s tip (2026-09-01,
    // this repo's earlier pin) reworked Best Offense to gate onChooseOffensiveStat
    // on Keen Edge and target DEF, and dropped its onOffensiveMultiplier entirely.
    // The pin actually matching the released v2.65beta ROM (2026-04-24,
    // sources.lock.json) has neither change: onOffensiveMultiplier delegates to
    // Keen Edge (+30% for slicing moves), and onChooseOffensiveStat is a plain,
    // UNCONDITIONAL +20% SpDef blend (matching the in-game description, "...and
    // use +20% Sp. Def" -- no "Keen Edge moves only" qualifier on that half).
    // Confirmed by diffing abilities.cc between both pinned SHAs.
    id: 'ABILITY_BEST_OFFENSE',
    src: 'src/abilities.cc:10190',
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_KEEN_EDGE'),
    onSwapSplit: aliasSwapSplit('ABILITY_MYSTIC_BLADES'),
    onChooseOffensiveStat: (ctx) => {
      ctx.secondaryStat.spdef = (ctx.secondaryStat.spdef ?? 0) + 20
    },
  },
  {
    id: 'ABILITY_PONY_POWER',
    src: 'src/abilities.cc:6532',
    onOffensiveMultiplier: (ctx) => {
      aliasOffensiveMultiplier('ABILITY_KEEN_EDGE')(ctx)
      aliasOffensiveMultiplier('ABILITY_MYSTIC_BLADES')(ctx)
    },
    onSwapSplit: aliasSwapSplit('ABILITY_MYSTIC_BLADES'),
  },
  {
    id: 'ABILITY_BASS_BOOSTED',
    src: 'src/abilities.cc:6629',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      aliasOffensiveMultiplier('ABILITY_AMPLIFIER')(ctx)
      aliasOffensiveMultiplier('ABILITY_PUNK_ROCK')(ctx)
    },
    onDefensiveMultiplier: aliasDefensiveMultiplier('ABILITY_PUNK_ROCK'),
  },
]
