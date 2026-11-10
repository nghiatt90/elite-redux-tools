// Batch AB: onModifyMoveFlags family -- the last of the 6 census hooks added in the
// field-report audit. DoesMoveMatchFlag (src/abilities.cc:358-386): each port below
// is a complete, correct answer to "does this ability grant the move this flag."
//
// These hooks are now wired for the consumers whose call-site moveType convention
// has been checked: Iron Fist's punch path (dispatchCalc.isIronFistBoosted, for
// Punching Glove), plus the Keen Edge and Striker offensive multipliers. The other
// consumers -- Mega Launcher and the sound family (Soundproof/Punk Rock/Amplifier/
// Liquid Voice) -- still test the static `ctx.moveFlags.*` flag, so grants for those
// families do not yet change damage; see OnModifyMoveFlags's own doc (types.ts).
//
// 7 of this batch's 10 census abilities get a fresh entry here; Backstreet Boy,
// Chestnut Axe, and Gunman already had a real entry for a different hook elsewhere
// and were patched in place.

import type { AbilityImpl } from '../types'

export const MODIFY_MOVE_FLAGS_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_BRAWLING_WYVERN',
    src: 'src/abilities.cc:7575',
    onModifyMoveFlags: (ctx) => ctx.flag === 'punchBased' && ctx.moveType === 'DRAGON',
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
    onModifyMoveFlags: (ctx) => (ctx.flag === 'punchBased' || ctx.flag === 'kickBased') && ctx.moveType === 'NORMAL',
  },
  {
    id: 'ABILITY_MUSICAL_NOTES',
    src: 'src/abilities.cc:11960',
    onModifyMoveFlags: (ctx) => ctx.flag === 'sound' && ctx.moveSplit === 'STATUS',
  },
  {
    id: 'ABILITY_REVERBATE',
    src: 'src/abilities.cc:10628',
    onModifyMoveFlags: (ctx) => ctx.flag === 'sound' && ctx.moveType === 'NORMAL',
  },
  {
    id: 'ABILITY_TAEKKYEON',
    src: 'src/abilities.cc:10637',
    onModifyMoveFlags: (ctx) => ctx.flag === 'dance' && ctx.moveSplit !== 'STATUS',
  },
]
