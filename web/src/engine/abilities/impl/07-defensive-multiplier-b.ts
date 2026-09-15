// Batch B2: the remaining pure onDefensiveMultiplier abilities (Stall, needing
// per-battler turn-order info this engine doesn't track, stays unmodelled).

import { uq } from '../../fixed'
import { MUL, RESISTANCE } from '../macros'
import type { AbilityImpl } from '../types'

// Real gap fix: all 3 callers' `.breakable = TRUE` was missing -- without it, an
// attacker's Mold Breaker never suppressed this defensive multiplier.
function fluffyLike(id: string, src: string, weakType: string): AbilityImpl {
  return {
    id,
    src,
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === weakType) RESISTANCE(ctx, 2.0)
      if (ctx.moveFlags.contact) MUL(ctx, 0.5)
    },
  }
}

export const DEFENSIVE_MULTIPLIER_BATCH_B: AbilityImpl[] = [
  fluffyLike('ABILITY_FLUFFY', 'src/abilities.cc:2998', 'FIRE'),
  fluffyLike('ABILITY_FLUFFIEST', 'src/abilities.cc:8436', 'FIRE'),
  fluffyLike('ABILITY_LIQUIFIED', 'src/abilities.cc:4053', 'WATER'),
  {
    id: 'ABILITY_FEATHERCOAT',
    src: 'src/abilities.cc:12327',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      MUL(ctx, ctx.typeEffectiveness < uq(1.0) ? 0.8 : 0.9)
    },
  },
  {
    id: 'ABILITY_AEGIS_WARD',
    src: 'src/abilities.cc:12212',
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GHOST' || ctx.moveType === 'DARK' || ctx.moveType === 'PSYCHIC') RESISTANCE(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_ELEMENTAL_AEGIS',
    src: 'src/abilities.cc:12198',
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE' || ctx.moveType === 'WATER' || ctx.moveType === 'ELECTRIC') RESISTANCE(ctx, 0.5)
    },
  },
]
