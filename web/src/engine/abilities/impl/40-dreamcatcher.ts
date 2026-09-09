// Batch AO: Dreamcatcher and Dreamscape. Dreamcatcher's real C body loops the WHOLE
// opposing side (up to 2/3 battlers in doubles/triples) checking IsBattlerAlive +
// asleep/Comatose, doubling damage against the first one found -- this engine only
// ever models a single attacker vs a single defender, so "some opposing battler is
// asleep" reduces to "the defender is asleep" (the only opposing battler that
// exists in this model; IsBattlerAlive is also trivially true, since computing
// damage against an already-fainted defender isn't a scenario this engine
// represents). The C's FILTER_NOT guard (skip the boost when this very
// onOffensiveMultiplier call is itself Dreamcatcher's own out-of-turn retaliatory
// hit against that same sleeping target, so it doesn't double-dip) depends on
// gProcessingExtraAttacks/gQueuedExtraAttackData -- state this non-turn-simulating
// engine never sets, so that branch is always false here and can't ever apply;
// omitting it changes nothing reachable.
//
// Dreamscape ALWAYS applies its own flat 1.2x (unconditional MUL after delegating to
// Dreamcatcher's check) -- these compose independently, not exclusively.

import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

export const DREAMCATCHER_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_DREAMCATCHER',
    src: 'src/abilities.cc:3983',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderStatus1.has('STATUS1_SLEEP') || ctx.defenderHasComatose) MUL(ctx, 2.0)
    },
  },
  {
    id: 'ABILITY_DREAMSCAPE',
    src: 'src/abilities.cc:10367',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderStatus1.has('STATUS1_SLEEP') || ctx.defenderHasComatose) MUL(ctx, 2.0)
      MUL(ctx, 1.2)
    },
  },
]
