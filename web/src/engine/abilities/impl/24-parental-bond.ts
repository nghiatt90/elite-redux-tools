// Batch X: onParentalBond family -- census hook added in the field-report audit
// (ability_hooks.py's _DAMAGE_HOOKS). Feeds GetParentalBondType/GetParentalBondMultiplier
// (src/battle_script_commands.c:990-1003; src/battle_util.c:7483-7513): a bonus hit at a
// fixed (or trigger-dependent) reduced power, on top of the move's normal single hit.
//
// Wired into calculate.ts via multiHit.ts's resolveHitPlan -- HYPER_AGGRESSIVE,
// PRIMAL_MAW, DUAL_WIELD, ICE_COLD_HUNTER (2 hits) and THREE_HEADED (3 hits) all
// resolve to a real hitCount/hitModifier. MINION_CONTROL (a live party-member
// count) stays unmodelled -- no team concept in this v1 singles engine, same
// class of gap Soul Harvest/Supreme Overlord had before alliesFainted existed.
// TWO_TO_FIVE (Unrelenting) has NO case in GetParentalBondCount
// (battle_script_commands.c:1010-1044) either, so multiHit.ts's
// parentalBondHitCount returns hitCount 1 for it -- the bonus hit never
// triggers in the real game. See OnParentalBond's own doc in types.ts for why
// ICE_COLD_HUNTER and TWO_TO_FIVE fall through getParentalBondMultiplier's
// default.
//
// FAMILIA_BOND and MAGUS_BLADES ParentalBondTrigger values were removed (dead
// code): ABILITY_FAMILIA_BOND exists in neither the pinned abilities.cc nor
// data/v2.65beta/abilities.json -- no such ability was ever released --
// and ABILITY_MAGUS_BLADES's own onParentalBond is a function-pointer alias of
// Dual Wield's (abilities.cc:10235's `.onParentalBond = Impl<ABILITY_DUAL_WIELD>
// .onParentalBond`), already ported that way in 10-aliases.ts, so it resolves
// to DUAL_WIELD and never had a MAGUS_BLADES-typed trigger of its own to serve.
//
// 16 of this batch's 24 census abilities get a fresh entry here; the other 7
// (3_GT_1, DEVOURER, HAND_BARNACLES, MAGUS_BLADES, METALLIC_JAWS, STEEL_BEETLE,
// WITCH_BROOM) already had a real entry for a DIFFERENT hook elsewhere and were
// patched in place to add onParentalBond, not duplicated here.

import { aliasParentalBond } from './alias'
import type { AbilityImpl } from '../types'

export const PARENTAL_BOND_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_PARENTAL_BOND',
    src: 'src/abilities.cc:2487',
    flags: { resistsFortKnox: true },
    onParentalBond: () => 'HYPER_AGGRESSIVE',
  },
  {
    // Impl<HYPER_AGGRESSIVE>.onParentalBond = Impl<PARENTAL_BOND>.onParentalBond (function-
    // pointer copy, not the resistsFortKnox flag -- Hyper Aggressive doesn't declare it).
    id: 'ABILITY_HYPER_AGGRESSIVE',
    src: 'src/abilities.cc:4561',
    onParentalBond: aliasParentalBond('ABILITY_PARENTAL_BOND'),
  },
  {
    // Chains through Hyper Aggressive, same as the C's Impl<GHOST_FRENZY>.onParentalBond
    // = Impl<HYPER_AGGRESSIVE>.onParentalBond.
    id: 'ABILITY_GHOST_FRENZY',
    src: 'src/abilities.cc:12272',
    onParentalBond: aliasParentalBond('ABILITY_HYPER_AGGRESSIVE'),
  },
  {
    id: 'ABILITY_RAGING_GODDESS',
    src: 'src/abilities.cc:8909',
    onParentalBond: aliasParentalBond('ABILITY_PARENTAL_BOND'),
  },
  {
    id: 'ABILITY_BALLOON_BLITZ',
    src: 'src/abilities.cc:9255',
    onParentalBond: aliasParentalBond('ABILITY_PARENTAL_BOND'),
  },
  {
    id: 'ABILITY_FRENZIED_PHANTOM',
    src: 'src/abilities.cc:9624',
    onParentalBond: aliasParentalBond('ABILITY_PARENTAL_BOND'),
  },
  {
    id: 'ABILITY_DUAL_HAMMER',
    src: 'src/abilities.cc:8011',
    onParentalBond: (ctx) => (ctx.moveFlags.hammerBased ? 'DUAL_WIELD' : null),
  },
  {
    // IsMegaLauncherBoosted (bulletBased) or IsKeenEdge (sliceBased) -- like Liquid
    // Voice's IsSoundMove note, DoesMoveMatchFlag's ability-granted-flag fallback
    // (onModifyMoveFlags) isn't modelled; this checks the move's own flags only.
    id: 'ABILITY_DUAL_WIELD',
    src: 'src/abilities.cc:5459',
    onParentalBond: (ctx) => (ctx.moveFlags.bulletBased || ctx.moveFlags.sliceBased ? 'DUAL_WIELD' : null),
  },
  {
    id: 'ABILITY_ICE_COLD_HUNTER',
    src: 'src/abilities.cc:8034',
    onParentalBond: (ctx) => (ctx.moveType === 'ICE' && ctx.weather === 'HAIL' ? 'ICE_COLD_HUNTER' : null),
  },
  {
    id: 'ABILITY_MINION_CONTROL',
    src: 'src/abilities.cc:7479',
    onParentalBond: () => 'MINION_CONTROL',
  },
  {
    // F_TWO_HEADED/F_THREE_HEADED (pokemon.h:209-210), sourced from er-config's
    // species.heads proto field (already emitted as species.json's `heads`).
    id: 'ABILITY_MULTI_HEADED',
    src: 'src/abilities.cc:4444',
    flags: { resistsFortKnox: true },
    onParentalBond: (ctx) => {
      if (ctx.attackerHeads === 2) return 'HYPER_AGGRESSIVE'
      if (ctx.attackerHeads >= 3) return 'THREE_HEADED'
      return null
    },
  },
  {
    id: 'ABILITY_PRIMAL_MAW',
    src: 'src/abilities.cc:5306',
    onParentalBond: (ctx) => (ctx.moveFlags.biteBased ? 'PRIMAL_MAW' : null),
  },
  {
    // IsIronFistBoosted (punchBased) -- reuses PRIMAL_MAW's own trigger/multiplier
    // (0.4x), confirmed directly from the C body, not a copy-paste mistake here.
    id: 'ABILITY_RAGING_BOXER',
    src: 'src/abilities.cc:4133',
    onParentalBond: (ctx) => (ctx.moveFlags.punchBased ? 'PRIMAL_MAW' : null),
  },
  {
    id: 'ABILITY_RAGING_MOTH',
    src: 'src/abilities.cc:5810',
    onParentalBond: (ctx) => (ctx.moveType === 'FIRE' ? 'DUAL_WIELD' : null),
  },
  {
    // Returns MULTIHIT_TWO_TO_FIVE -- but GetParentalBondCount (battle_script_
    // commands.c:1010-1044) has no case for it, so it never actually grants a
    // bonus hit in the real game; multiHit.ts's parentalBondHitCount returns 1
    // for this trigger for that reason. See ParentalBondTrigger's own doc.
    id: 'ABILITY_UNRELENTING',
    src: 'src/abilities.cc:12247',
    onParentalBond: () => 'TWO_TO_FIVE',
  },
  {
    id: 'ABILITY_HYDRA',
    src: 'src/abilities.cc:11261',
    flags: { resistsFortKnox: true },
    onParentalBond: aliasParentalBond('ABILITY_MULTI_HEADED'),
  },
]
