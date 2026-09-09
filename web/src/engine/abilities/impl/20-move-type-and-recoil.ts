// Batch R: Cosmic Wings (unblocked by the resolveEffectiveMoveType fix -- its
// original type is Flying, not Normal, so it needed the dispatcher to stop
// hardcoding the ATE_ABILITY-specific precondition), Super Strain's onRecoil
// (not wired into calculate.ts -- no recoil-damage display exists in this v1
// calculator yet -- but a complete, correct port for when it is), and Victory
// Bomb (see calculate.ts's own comment at its power-override call site for why
// its real gProcessingExtraAttacks-scoped condition is reinterpreted as "the
// user selected MOVE_EXPLOSION directly").

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
  {
    id: 'ABILITY_VICTORY_BOMB',
    src: 'src/abilities.cc:8980',
    onMoveType: (ctx) => {
      if (ctx.moveId !== 'MOVE_EXPLOSION') return
      ctx.moveType = 'FIRE'
    },
  },
]
