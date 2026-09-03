// Batch R: Cosmic Wings (unblocked by the resolveEffectiveMoveType fix -- its
// original type is Flying, not Normal, so it needed the dispatcher to stop
// hardcoding the ATE_ABILITY-specific precondition) and Super Strain's onRecoil
// (not wired into calculate.ts -- no recoil-damage display exists in this v1
// calculator yet -- but a complete, correct port for when it is).

import type { AbilityImpl } from '../types'

export const MOVE_TYPE_AND_RECOIL_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_COSMIC_WINGS',
    src: 'src/abilities.cc:11394',
    onMoveType: (ctx) => {
      if (ctx.moveType !== 'FLYING') return
      ctx.moveType = 'FAIRY'
      // The C doesn't set *ateBoost here (unlike ATE_ABILITY) -- faithful omission.
    },
  },
  {
    id: 'ABILITY_SUPER_STRAIN',
    src: 'src/abilities.cc:6289',
    onRecoil: (ctx) => Math.max(Math.floor(ctx.damage / 4), 1),
  },
]
