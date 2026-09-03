// Batch N: onTypeEffectiveness (immunity-breaking, per-defending-type) and
// onAfterTypeEffectiveness (post-fold, whole-modifier) abilities. Neither hook is
// wired into calculate.ts's type-effectiveness fold yet, but each port here is a
// complete, correct translation of its C body -- see the context types' own docs.
//
// Deferred (left in 99-unmodelled.ts): Normalize (its onTypeEffectiveness alone
// would be a partial port -- its onMoveType/onOffensiveMultiplier halves need a
// "convert EVERY move to Normal" mechanism this engine's resolveEffectiveMoveType
// doesn't have, since it only handles the opposite "-ate" direction), Bone Zone
// (needs mod1/2/3 individually WRITABLE, not just the read-only perTypeModifiers
// this engine exposes -- its fallback path reconstructs the whole three-type fold),
// Soothsayer (needs per-ability activation-state tracking).

import { uq } from '../../fixed'
import type { AbilityImpl, OnTypeEffectivenessContext } from '../types'

const SUPER_EFFECTIVE = 2048 // GetSuperEffectiveMult() == UQ_4_12(2.0)

export const TYPE_EFFECTIVENESS_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_ANGELS_WRATH',
    src: 'src/abilities.cc:5543',
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveId === 'MOVE_POISON_STING' && ctx.defType === 'STEEL') ctx.modifier = SUPER_EFFECTIVE
      else if (ctx.moveId === 'MOVE_ELECTROWEB' && ctx.defType === 'GROUND') ctx.modifier = SUPER_EFFECTIVE
    },
  },
  {
    // Referenced by ABILITY_ACIDIC_SLIME's alias (batch M) and
    // ABILITY_PYROCLASTIC_FLOW's composite below.
    id: 'ABILITY_CORROSION',
    src: 'src/abilities.cc:2925',
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'POISON' && ctx.defType === 'STEEL') ctx.modifier = SUPER_EFFECTIVE
    },
  },
  {
    id: 'ABILITY_CORRUPTED_MIND',
    src: 'src/abilities.cc:9433',
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'PSYCHIC' && ctx.modifier < uq(1.0)) ctx.modifier = uq(1.0)
    },
  },
  {
    // Referenced by ABILITY_OVERCLOCK's composite below.
    id: 'ABILITY_GROUND_SHOCK',
    src: 'src/abilities.cc:3784',
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'ELECTRIC' && ctx.defType === 'GROUND' && ctx.modifier === 0) ctx.modifier = uq(0.5)
    },
  },
  {
    // Referenced by ABILITY_MAGMA_EATER's alias (batch H) and
    // ABILITY_PYROCLASTIC_FLOW's composite below.
    id: 'ABILITY_MOLTEN_DOWN',
    src: 'src/abilities.cc:4551',
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'FIRE' && ctx.defType === 'ROCK') ctx.modifier = SUPER_EFFECTIVE
    },
  },
  {
    // Referenced by ABILITY_DEPRAVITY's alias (batch H) and
    // ABILITY_OVERCLOCK's composite below.
    id: 'ABILITY_OVERCHARGE',
    src: 'src/abilities.cc:4473',
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'ELECTRIC' && ctx.defType === 'ELECTRIC') ctx.modifier = SUPER_EFFECTIVE
    },
  },
  {
    // Referenced by ABILITY_BLIND_RAGE/ABILITY_BIRD_OF_PREY/ABILITY_MINDS_EYE's
    // aliases (batch H).
    id: 'ABILITY_OVERWHELM',
    src: 'src/abilities.cc:4202',
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'DRAGON' && ctx.defType === 'FAIRY' && ctx.modifier === 0) ctx.modifier = uq(1.0)
    },
  },
  {
    // Referenced by ABILITY_SOUL_DEVOURER's alias (batch H).
    id: 'ABILITY_PHANTOM_PAIN',
    src: 'src/abilities.cc:5972',
    onTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'GHOST' && ctx.defType === 'NORMAL' && ctx.modifier === 0) ctx.modifier = uq(1.0)
    },
  },
  {
    // .onOffensiveMultiplier reasons omitted (this ability has none) -- unlike
    // NORMAL/FIGHTING vs GHOST here uses an OR of two move types.
    id: 'ABILITY_SCRAPPY',
    src: 'src/abilities.cc:1728',
    onTypeEffectiveness: (ctx) => {
      if ((ctx.moveType === 'NORMAL' || ctx.moveType === 'FIGHTING') && ctx.defType === 'GHOST' && ctx.modifier === 0) ctx.modifier = uq(1.0)
    },
  },
]

function ground(ctx: OnTypeEffectivenessContext) {
  TYPE_EFFECTIVENESS_ABILITIES.find((a) => a.id === 'ABILITY_GROUND_SHOCK')!.onTypeEffectiveness!(ctx)
}
function overcharge(ctx: OnTypeEffectivenessContext) {
  TYPE_EFFECTIVENESS_ABILITIES.find((a) => a.id === 'ABILITY_OVERCHARGE')!.onTypeEffectiveness!(ctx)
}
function molten(ctx: OnTypeEffectivenessContext) {
  TYPE_EFFECTIVENESS_ABILITIES.find((a) => a.id === 'ABILITY_MOLTEN_DOWN')!.onTypeEffectiveness!(ctx)
}
function corrosion(ctx: OnTypeEffectivenessContext) {
  TYPE_EFFECTIVENESS_ABILITIES.find((a) => a.id === 'ABILITY_CORROSION')!.onTypeEffectiveness!(ctx)
}

TYPE_EFFECTIVENESS_ABILITIES.push(
  {
    // Ground Shock's ELECTRIC-vs-GROUND and Overcharge's ELECTRIC-vs-ELECTRIC
    // conditions are mutually exclusive by defType, so calling both directly gives
    // the same result as the C's `||` short-circuit (src/abilities.cc:12664-12667).
    id: 'ABILITY_OVERCLOCK',
    src: 'src/abilities.cc:12664',
    onTypeEffectiveness: (ctx) => {
      ground(ctx)
      overcharge(ctx)
    },
  },
  {
    // Molten Down's FIRE-vs-ROCK and Corrosion's POISON-vs-STEEL conditions are
    // mutually exclusive by moveType (src/abilities.cc:7938-7941).
    id: 'ABILITY_PYROCLASTIC_FLOW',
    src: 'src/abilities.cc:7938',
    onTypeEffectiveness: (ctx) => {
      molten(ctx)
      corrosion(ctx)
    },
  },
)

TYPE_EFFECTIVENESS_ABILITIES.push(
  {
    id: 'ABILITY_DESERT_SPIRIT',
    src: 'src/abilities.cc:7639',
    onAfterTypeEffectiveness: (ctx) => {
      if (ctx.modifier === 0 && !ctx.targetGrounded && ctx.moveType === 'GROUND' && ctx.weather === 'SANDSTORM') ctx.modifier = uq(1.0)
    },
  },
  {
    id: 'ABILITY_GIFTED_MIND',
    src: 'src/abilities.cc:5327',
    flags: { breakable: true },
    applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
    onAfterTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'BUG' || ctx.moveType === 'GHOST' || ctx.moveType === 'DARK') ctx.modifier = 0
    },
  },
  {
    id: 'ABILITY_MOUNTAINEER',
    src: 'src/abilities.cc:4084',
    flags: { breakable: true },
    applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
    onAfterTypeEffectiveness: (ctx) => {
      if (ctx.moveType === 'ROCK') ctx.modifier = 0
    },
  },
  {
    // BATTLE_PARTNER(battler) requires a live ally battler -- never fires in this
    // v1 singles engine, matching Plus/Minus's own documented no-op precondition
    // (see 11-offensive-multiplier-d.ts).
    id: 'ABILITY_TELEPATHY',
    src: 'src/abilities.cc:2015',
    flags: { breakable: true },
    onAfterTypeEffectiveness: () => {},
  },
  {
    id: 'ABILITY_TERA_SHELL',
    src: 'src/abilities.cc:7662',
    flags: { breakable: true },
    applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
    onAfterTypeEffectiveness: (ctx) => {
      if (ctx.modifier >= uq(1.0) && ctx.defenderAtMaxHp) ctx.modifier = uq(0.5)
    },
  },
  {
    id: 'ABILITY_WONDER_GUARD',
    src: 'src/abilities.cc:770',
    flags: { breakable: true },
    applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
    onAfterTypeEffectiveness: (ctx) => {
      if (ctx.modifier < SUPER_EFFECTIVE) ctx.modifier = 0
    },
  },
)
