// Batch AB: onModifyMoveFlags family -- the last of the 6 census hooks added in the
// field-report audit. DoesMoveMatchFlag (src/abilities.cc:358-386): each port below
// is a complete, correct answer to "does this ability grant the move this flag."
//
// Grants do NOT read the caller's `ctx.moveType` argument except where the C does:
// Chestnut Axe alone tests the argument (`moveType == TYPE_GRASS`, src/abilities.cc:
// 11711). Mixed Martial Arts (:9901) and Reverbate (:10657) test the move's DECLARED
// base type (`gBattleMoves[move].type`, ctx.declaredMoveType), and Brawling Wyvern
// (:7607) tests the RESOLVED type (IS_MOVE_TYPE, include/battle.h:743,
// ctx.resolvedMoveType) -- so a TYPE_NORMAL dummy caller does not make every move
// Normal, and a real-type caller does not hide an -ate retype.
//
// These hooks are now wired for the consumers whose call-site moveType convention
// has been checked: Iron Fist's punch path (dispatchCalc.isIronFistBoosted, for
// Punching Glove), the Iron Fist, Mega Launcher, Liquid Voice and Punk Rock offensive
// multipliers (TYPE_NORMAL dummies), Punk Rock's defensive half (IsSoundMove on the
// attacker), Hammer Fist (the real move type), Keen Edge and Striker, Mystic Blades'
// onSwapSplit (real type) and Pinnacle Blade's onInfiltrate (real type). The
// Amplifier/Bass Boosted/Sludgy Mix aliases pass the ctx through to Punk Rock
// unchanged. Still static (`ctx.moveFlags.*` only, so grants do not yet change the
// result): Soundproof's onImmune, the chooseStat hooks, onCrit, onParentalBond, and
// the accuracy/sim consumers; see OnModifyMoveFlags's own doc (types.ts).
//
// 7 of this batch's 10 census abilities get a fresh entry here; Backstreet Boy,
// Chestnut Axe, and Gunman already had a real entry for a different hook elsewhere
// and were patched in place.

import type { AbilityImpl } from '../types'

export const MODIFY_MOVE_FLAGS_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_BRAWLING_WYVERN',
    src: 'src/abilities.cc:7575',
    // IS_MOVE_TYPE(move, TYPE_DRAGON), src/abilities.cc:7607 -- the RESOLVED type
    // (dynamicMoveType if set, else the declared type; include/battle.h:743).
    onModifyMoveFlags: (ctx) => ctx.flag === 'punchBased' && ctx.resolvedMoveType === 'DRAGON',
  },
  {
    id: 'ABILITY_FESTIVITIES',
    src: 'src/abilities.cc:10168',
    onModifyMoveFlags: (ctx) => {
      if (ctx.flag === 'dance') return Boolean(ctx.moveFlags.sound)
      if (ctx.flag === 'sound') return Boolean(ctx.moveFlags.dance)
      return false
    },
  },
  {
    // Cross-swap: grants Punch to Kick-flagged moves and vice versa.
    id: 'ABILITY_JUNSHI_SANDA',
    src: 'src/abilities.cc:7586',
    onModifyMoveFlags: (ctx) => {
      if (ctx.flag === 'punchBased') return Boolean(ctx.moveFlags.kickBased)
      if (ctx.flag === 'kickBased') return Boolean(ctx.moveFlags.punchBased)
      return false
    },
  },
  {
    id: 'ABILITY_MIXED_MARTIAL_ARTS',
    src: 'src/abilities.cc:9872',
    // `gBattleMoves[move].type == TYPE_NORMAL`, src/abilities.cc:9901 -- the
    // DECLARED base type, not the caller's moveType argument nor the resolved type.
    onModifyMoveFlags: (ctx) => (ctx.flag === 'punchBased' || ctx.flag === 'kickBased') && ctx.declaredMoveType === 'NORMAL',
  },
  {
    id: 'ABILITY_MUSICAL_NOTES',
    src: 'src/abilities.cc:11960',
    onModifyMoveFlags: (ctx) => ctx.flag === 'sound' && ctx.moveSplit === 'STATUS',
  },
  {
    id: 'ABILITY_REVERBATE',
    src: 'src/abilities.cc:10628',
    // `gBattleMoves[move].type == TYPE_NORMAL`, src/abilities.cc:10657 -- the
    // DECLARED base type, not the caller's moveType argument nor the resolved type.
    onModifyMoveFlags: (ctx) => ctx.flag === 'sound' && ctx.declaredMoveType === 'NORMAL',
  },
  {
    id: 'ABILITY_TAEKKYEON',
    src: 'src/abilities.cc:10637',
    onModifyMoveFlags: (ctx) => ctx.flag === 'dance' && ctx.moveSplit !== 'STATUS',
  },
]
