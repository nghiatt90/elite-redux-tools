// Batch A1: straightforward onOffensiveMultiplier abilities whose body is a single
// moveType/move-split/move-flag/isCrit check against `MUL(n)` -- no helper function
// this engine hasn't already got the inputs for. Each entry cites its exact
// src/abilities.cc block. Values are ER-specific, sourced from the C, not from
// memory of vanilla Pokemon -- e.g. Levitate's 1.25x here has nothing to do with
// vanilla Levitate, which has no offensive effect at all.

import { MUL } from '../macros'
import { APPLY_ON_ALLY, APPLY_ON_ALLY_ONLY } from '../applyOn'
import type { AbilityImpl } from '../types'

export const OFFENSIVE_MULTIPLIER_BATCH_A: AbilityImpl[] = [
  {
    // applyOn: APPLY_ON_ALLY -- never fires in this v1 singles engine (no ally
    // battler exists); ported faithfully anyway so the registry entry is complete.
    id: 'ABILITY_AIRBORNE',
    src: 'src/abilities.cc:6845',
    applyOn: { onOffensiveMultiplierFor: APPLY_ON_ALLY },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FLYING') MUL(ctx, 1.3)
    },
  },
  {
    id: 'ABILITY_ANTARCTIC_BIRD',
    src: 'src/abilities.cc:3707',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FLYING' || ctx.moveType === 'ICE') MUL(ctx, 1.3)
    },
  },
  {
    id: 'ABILITY_AQUATIC_DWELLER',
    src: 'src/abilities.cc:8843',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'WATER') MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_ARCHER',
    src: 'src/abilities.cc:6088',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.arrowBased) MUL(ctx, 1.3)
    },
  },
  {
    // applyOn: APPLY_ON_ALLY_ONLY -- never fires in singles.
    id: 'ABILITY_BATTERY',
    src: 'src/abilities.cc:2989',
    applyOn: { onOffensiveMultiplierFor: APPLY_ON_ALLY_ONLY },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'SPECIAL') MUL(ctx, 1.3)
    },
  },
  {
    // IsMoveMakingContact also checks Protective Pads/Long Reach negation on the
    // C side; not modelled here yet (both are items/abilities this engine doesn't
    // resolve at the point this hook runs) -- approximated as the plain contact flag.
    id: 'ABILITY_BIG_PECKS',
    src: 'src/abilities.cc:2088',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.contact) MUL(ctx, 1.3)
    },
  },
  {
    id: 'ABILITY_COMBUSTION',
    src: 'src/abilities.cc:6524',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE') MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_DEVIOUS_PRESENT',
    src: 'src/abilities.cc:11386',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ICE' || ctx.moveFlags.throwingBased) MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_DRAGONS_MAW',
    src: 'src/abilities.cc:3573',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'DRAGON') MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_ELECTROCYTES',
    src: 'src/abilities.cc:3742',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ELECTRIC') MUL(ctx, 1.25)
    },
  },
  {
    id: 'ABILITY_FIELD_EXPLORER',
    src: 'src/abilities.cc:4571',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.fieldBased) MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_GIANT_WINGS',
    src: 'src/abilities.cc:4646',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.airBased) MUL(ctx, 1.3)
    },
  },
  {
    id: 'ABILITY_GORILLA_TACTICS',
    src: 'src/abilities.cc:3491',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'PHYSICAL') MUL(ctx, 1.5)
    },
  },
  {
    // Levitate's grounding/type-immunity mechanic lives outside struct Ability
    // (consulted directly via the `.levitate` bitfield in IsBattlerGroundedIgnoreType,
    // src/battle_util.c) and is modelled at the type-effectiveness layer
    // (BattlerBattleState.isGrounded), not here -- this hook is the WHOLE of
    // Levitate's presence in `struct Ability`'s function-pointer fields.
    id: 'ABILITY_LEVITATE',
    src: 'src/abilities.cc:781',
    flags: { levitate: true, breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FLYING') MUL(ctx, 1.25)
    },
  },
  {
    id: 'ABILITY_LONG_REACH',
    src: 'src/abilities.cc:2755',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'PHYSICAL') MUL(ctx, 1.2)
    },
  },
  {
    id: 'ABILITY_MIGHTY_HORN',
    src: 'src/abilities.cc:4907',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.hornBased) MUL(ctx, 1.3)
    },
  },
  {
    // applyOn: APPLY_ON_ALLY_ONLY -- never fires in singles. Unconditional MUL when
    // it does fire (no self-check in the C at all -- the ally-only scoping IS the
    // whole condition).
    id: 'ABILITY_POWER_SPOT',
    src: 'src/abilities.cc:3346',
    applyOn: { onOffensiveMultiplierFor: APPLY_ON_ALLY_ONLY },
    onOffensiveMultiplier: (ctx) => MUL(ctx, 1.3),
  },
  {
    id: 'ABILITY_ROCKY_PAYLOAD',
    src: 'src/abilities.cc:5782',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ROCK' || ctx.moveFlags.throwingBased) MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_SNIPER',
    src: 'src/abilities.cc:1571',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.isCrit) MUL(ctx, 1.5)
    },
  },
  {
    // applyOn: APPLY_ON_ALLY -- never fires in singles.
    id: 'ABILITY_STEELY_SPIRIT',
    src: 'src/abilities.cc:3433',
    applyOn: { onOffensiveMultiplierFor: APPLY_ON_ALLY },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'STEEL') MUL(ctx, 1.3)
    },
  },
  {
    // DoesMoveMatchFlag(..., MOVE_FLAG_PUNCH) -- moves.json's `punchBased` flag is
    // this pipeline's own name for exactly that (see emit.py's _MOVE_FLAGS: the key
    // is renamed from the raw `iron_fist` proto field to read as "boosted by Iron
    // Fist", i.e. punch-based).
    id: 'ABILITY_HAMMER_FIST',
    src: 'src/abilities.cc:11498',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.punchBased || ctx.moveFlags.hammerBased) MUL(ctx, 1.25)
    },
  },
]
