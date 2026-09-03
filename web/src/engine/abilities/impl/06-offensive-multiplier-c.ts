// Batch A3: 8 more single-condition onOffensiveMultiplier abilities, plus 4
// "delegates to two other abilities' hooks" composites (src/abilities.cc's own
// `Impl<ABILITY_X>.onOffensiveMultiplier(DELEGATE_OFFENSIVE_MULTIPLIER)` pattern --
// ported here as direct calls to the already-ported hook functions, same shared
// modifier accumulator, matching the C's sequential calls exactly).

import { uq } from '../../fixed'
import { MUL, RESISTANCE } from '../macros'
import type { AbilityImpl } from '../types'
import { OFFENSIVE_MULTIPLIER_BATCH_A } from './01-offensive-multiplier-a'
import { OFFENSIVE_MULTIPLIER_BATCH_B } from './03-offensive-multiplier-b'

const SUPER_EFFECTIVE_THRESHOLD = uq(2.0)

function find(batch: AbilityImpl[], id: string) {
  const impl = batch.find((a) => a.id === id)
  if (!impl?.onOffensiveMultiplier) throw new Error(`${id}: no onOffensiveMultiplier to delegate to`)
  return impl.onOffensiveMultiplier
}

const IRON_FIST = find(OFFENSIVE_MULTIPLIER_BATCH_B, 'ABILITY_IRON_FIST')
const STEELY_SPIRIT = find(OFFENSIVE_MULTIPLIER_BATCH_A, 'ABILITY_STEELY_SPIRIT')
const STRIKER = find(OFFENSIVE_MULTIPLIER_BATCH_B, 'ABILITY_STRIKER')
const GIANT_WINGS = find(OFFENSIVE_MULTIPLIER_BATCH_A, 'ABILITY_GIANT_WINGS')
const LEVITATE = find(OFFENSIVE_MULTIPLIER_BATCH_A, 'ABILITY_LEVITATE')
const MIGHTY_HORN = find(OFFENSIVE_MULTIPLIER_BATCH_A, 'ABILITY_MIGHTY_HORN')

export const OFFENSIVE_MULTIPLIER_BATCH_C: AbilityImpl[] = [
  {
    id: 'ABILITY_SAGE_POWER',
    src: 'src/abilities.cc:4500',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'SPECIAL') MUL(ctx, 1.5)
    },
  },
  {
    // DoesMoveMatchFlag(..., MOVE_FLAG_SOUND) territory in vanilla, but ER's
    // FLAG_STRONG_JAW_BOOST is this pipeline's `biteBased` move flag directly.
    id: 'ABILITY_STRONG_JAW',
    src: 'src/abilities.cc:2337',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.biteBased) MUL(ctx, 1.3)
    },
  },
  {
    id: 'ABILITY_SUPER_SLAMMER',
    src: 'src/abilities.cc:6096',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.hammerBased) MUL(ctx, 1.3)
    },
  },
  {
    // basePower here is CalcMoveBasePower's PRE-modifier value (:7531-7533), already
    // documented on OffensiveMultiplierContext -- exactly what this needs to check.
    id: 'ABILITY_TECHNICIAN',
    src: 'src/abilities.cc:1599',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.basePower <= 60) MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_TINTED_LENS',
    src: 'src/abilities.cc:1698',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.typeEffectiveness <= uq(0.5)) RESISTANCE(ctx, 2)
    },
  },
  {
    id: 'ABILITY_TRANSISTOR',
    src: 'src/abilities.cc:3565',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ELECTRIC') MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_WARMONGER',
    src: 'src/abilities.cc:10734',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ROCK' || ctx.moveType === 'STEEL' || ctx.moveType === 'FIGHTING') MUL(ctx, 1.3)
    },
  },
  {
    id: 'ABILITY_WINGED_KING',
    src: 'src/abilities.cc:7433',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.typeEffectiveness >= SUPER_EFFECTIVE_THRESHOLD) MUL(ctx, 1.33)
    },
  },
  {
    // Impl<ABILITY_IRON_FIST>.onOffensiveMultiplier + Impl<ABILITY_STEELY_SPIRIT>.onOffensiveMultiplier
    id: 'ABILITY_ATOMIC_PUNCH',
    src: 'src/abilities.cc:8463',
    onOffensiveMultiplier: (ctx) => {
      IRON_FIST(ctx)
      STEELY_SPIRIT(ctx)
    },
  },
  {
    // Impl<ABILITY_IRON_FIST>.onOffensiveMultiplier + Impl<ABILITY_STRIKER>.onOffensiveMultiplier
    id: 'ABILITY_COMBAT_SPECIALIST',
    src: 'src/abilities.cc:6020',
    onOffensiveMultiplier: (ctx) => {
      IRON_FIST(ctx)
      STRIKER(ctx)
    },
  },
  {
    // Impl<ABILITY_GIANT_WINGS>.onOffensiveMultiplier + Impl<ABILITY_LEVITATE>.onOffensiveMultiplier
    id: 'ABILITY_HUGE_WINGS',
    src: 'src/abilities.cc:8534',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      GIANT_WINGS(ctx)
      LEVITATE(ctx)
    },
  },
  {
    // Impl<ABILITY_MIGHTY_HORN>.onOffensiveMultiplier, then a direct check of the
    // move's own `drill` flag (bulletBased/hornBased-style boost tags, not a
    // delegated ability).
    id: 'ABILITY_MEGA_DRILL',
    src: 'src/abilities.cc:12189',
    onOffensiveMultiplier: (ctx) => {
      MIGHTY_HORN(ctx)
      if (ctx.moveFlags.drillBased) MUL(ctx, 1.3)
    },
  },
]
