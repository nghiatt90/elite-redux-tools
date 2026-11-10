// Batch A2: more onOffensiveMultiplier abilities -- move-flag checks via the
// DoesMoveMatchFlag helper (src/abilities.cc:358-386: the move's own static flag
// bit, falling back to an onModifyMoveFlags scan of the attacker's abilities),
// a super-effective check, and HasAnyStatusOrAbility-gated boosts.

import { uq } from '../../fixed'
import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

const SUPER_EFFECTIVE_THRESHOLD = uq(2.0) // GetSuperEffectiveMult(), hell mode not modelled

export const OFFENSIVE_MULTIPLIER_BATCH_B: AbilityImpl[] = [
  {
    // DoesMoveMatchFlag(..., MOVE_FLAG_PUNCH) === moveFlags.punchBased
    id: 'ABILITY_IRON_FIST',
    src: 'src/abilities.cc:1504',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.punchBased) MUL(ctx, 1.3)
    },
  },
  {
    // DoesMoveMatchFlag(..., moveType, MOVE_FLAG_KEEN_EDGE) -- the REAL move type,
    // src/abilities.cc:3676 (Chestnut Axe's grant is `moveType == TYPE_GRASS`).
    id: 'ABILITY_KEEN_EDGE',
    src: 'src/abilities.cc:3676',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.matchesMoveFlag('sliceBased', ctx.moveType)) MUL(ctx, 1.3)
    },
  },
  {
    // IsMegaLauncherBoosted -> DoesMoveMatchFlag(..., MOVE_FLAG_MEGA_LAUNCHER) === moveFlags.bulletBased
    id: 'ABILITY_MEGA_LAUNCHER',
    src: 'src/abilities.cc:2411',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.bulletBased) MUL(ctx, 1.3)
    },
  },
  {
    // IsStrikerBoosted -> DoesMoveMatchFlag(..., TYPE_NORMAL, MOVE_FLAG_KICK),
    // src/battle_util.c:9377 -- the C passes a literal TYPE_NORMAL dummy, NOT the
    // move's type (Backstreet Boy's grant reads only the move's Dance flag).
    id: 'ABILITY_STRIKER',
    src: 'src/abilities.cc:4609',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.matchesMoveFlag('kickBased', 'NORMAL')) MUL(ctx, 1.3)
    },
  },
  {
    id: 'ABILITY_NEUROFORCE',
    src: 'src/abilities.cc:3179',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.typeEffectiveness >= SUPER_EFFECTIVE_THRESHOLD) MUL(ctx, 1.35)
    },
  },
  {
    // IsRecklessBoosted also covers SNATCH2_ENRAGED and a probe of the battler's own
    // onRecoil ability hooks (src/abilities.cc:436-442); both are v1 simplifications
    // left out here (neither "enraged" volatile status nor an onRecoil-hook probe
    // is threaded through this context yet), so this ports only the common case --
    // the move's own reckless flag.
    id: 'ABILITY_RECKLESS',
    src: 'src/abilities.cc:1816',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.reckless) MUL(ctx, 1.2)
    },
  },
  {
    id: 'ABILITY_GUTS',
    src: 'src/abilities.cc:1261',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.attackerHasAnyStatus && ctx.moveSplit === 'PHYSICAL') MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_DETERMINATION',
    src: 'src/abilities.cc:6470',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.attackerHasAnyStatus && ctx.moveSplit === 'SPECIAL') MUL(ctx, 1.5)
    },
  },
]
