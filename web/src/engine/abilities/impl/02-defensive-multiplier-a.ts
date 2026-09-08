// Batch B1: straightforward onDefensiveMultiplier abilities -- single moveType/
// move-split/isCrit/weather/max-HP check against MUL(n) or RESISTANCE(n) (the two
// are equivalent here -- see macros.ts). Each cites its exact src/abilities.cc block.
//
// GetSuperEffectiveMult() (src/abilities.cc:403) is `isHellMode() &&
// HELL_MODE_TYPE_EFFECTIVENESS_CHANGE ? UQ_4_12(1.5) : UQ_4_12(2.0)` -- hell mode
// isn't modelled by this engine, so it's always the 2.0x branch.

import { uq } from '../../fixed'
import { MUL, RESISTANCE } from '../macros'
import type { AbilityImpl } from '../types'

const SUPER_EFFECTIVE_THRESHOLD = uq(2.0) // GetSuperEffectiveMult(), hell mode not modelled

export const DEFENSIVE_MULTIPLIER_BATCH_A: AbilityImpl[] = [
  {
    id: 'ABILITY_ARCTIC_FUR',
    src: 'src/abilities.cc:4928',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => MUL(ctx, 0.65),
  },
  {
    id: 'ABILITY_AURA_ARMOR',
    src: 'src/abilities.cc:12510',
    onDefensiveMultiplier: (ctx) => MUL(ctx, 0.65),
  },
  {
    // A real ER mechanic: Bad Omen halves the defender's damage taken from crits by
    // a further 3/4 (i.e. crit damage is only x0.375 of what it would otherwise be,
    // stacking with the crit x1.5 applied at a different pipeline stage).
    id: 'ABILITY_BAD_OMEN',
    src: 'src/abilities.cc:8326',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.isCrit) MUL(ctx, 0.25)
    },
  },
  {
    id: 'ABILITY_BRAIN_MASS',
    src: 'src/abilities.cc:11465',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.defenderAtMaxHp) MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_MULTISCALE',
    src: 'src/abilities.cc:1946',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.defenderAtMaxHp) MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_CHRISTMAS_SPIRIT',
    src: 'src/abilities.cc:3760',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.weather === 'HAIL') MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_FILTER',
    src: 'src/abilities.cc:1706',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.typeEffectiveness >= SUPER_EFFECTIVE_THRESHOLD) MUL(ctx, 0.65)
    },
  },
  {
    // Real gap fix: `.breakable = TRUE` (:4123) was missing -- without it, an
    // attacker's Mold Breaker never suppressed this defensive multiplier.
    id: 'ABILITY_PERMAFROST',
    src: 'src/abilities.cc:4115',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.typeEffectiveness >= SUPER_EFFECTIVE_THRESHOLD) MUL(ctx, 0.65)
    },
  },
  {
    id: 'ABILITY_PRIMAL_ARMOR',
    src: 'src/abilities.cc:4124',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.typeEffectiveness >= SUPER_EFFECTIVE_THRESHOLD) MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_FUR_COAT',
    src: 'src/abilities.cc:2318',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'PHYSICAL') MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_GUARDIAN_COAT',
    src: 'src/abilities.cc:10151',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'PHYSICAL') MUL(ctx, 0.8)
    },
  },
  {
    id: 'ABILITY_ICE_SCALES',
    src: 'src/abilities.cc:3315',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'SPECIAL') MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_OVERCOAT',
    src: 'src/abilities.cc:2060',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'SPECIAL') MUL(ctx, 0.8)
    },
  },
  {
    id: 'ABILITY_PRISM_SCALES',
    src: 'src/abilities.cc:3654',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'SPECIAL') MUL(ctx, 0.7)
    },
  },
  {
    id: 'ABILITY_HEATPROOF',
    src: 'src/abilities.cc:1459',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE') RESISTANCE(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_HEAVY_METAL',
    src: 'src/abilities.cc:1091',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GHOST' || ctx.moveType === 'DARK') RESISTANCE(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_STRONG_FOUNDATION',
    src: 'src/abilities.cc:10942',
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'WATER' || ctx.moveType === 'GROUND') RESISTANCE(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_THICK_FAT',
    src: 'src/abilities.cc:1082',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE' || ctx.moveType === 'ICE') RESISTANCE(ctx, 0.5)
    },
  },
]
