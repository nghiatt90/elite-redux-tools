// Batch E1: the 14 "-ate" abilities whose entire damage-relevant footprint is the
// ATE_ABILITY(type) macro (src/abilities.cc:295-301) -- onMoveType + onStab, and
// nothing else damage-relevant. Each also defines an onAttacker hook (a ~10% chance
// to inflict a status on contact, e.g. Pixilate/Refrigerate) that is NOT ported here:
// onAttacker isn't a damage-affecting hook (it's not in ability_hooks.py's
// _DAMAGE_HOOKS set, and this engine has no status-infliction model at all), so
// omitting it doesn't leave any damage-relevant behavior uncovered.
//
// The remaining 12 "-ate"-family abilities (Aerilate/Atomic Burst/Butterfly Wings/
// Draconic Might/Draconize/Fight Spirit/Lead Claws/Mob Boss/Stainless Steel/
// Steelworker/Unicorn/Warrior's Spear) carry EXTRA hooks beyond onMoveType/onStab
// (onStat, onOffensiveMultiplier, onTypeEffectiveness, onAfterTypeEffectiveness,
// onEntry, onInfiltrate, onDefender) -- most of those extras are themselves plain
// aliases to already-ported abilities, so they're ported in
// 15-ate-family-and-onstab.ts instead of here (only Aerilate's onStat is still left
// out, for the reason noted there).
//
// ATE_ABILITY(type)'s exact condition (src/abilities.cc:296): the type change (and
// therefore the pseudo-STAB) only applies to a move whose ORIGINAL type is Normal --
// resolveEffectiveMoveType (dispatchCalc.ts) enforces this before ever calling
// onMoveType, matching GetMoveTypeInternal's own CHECK.

import type { AbilityImpl } from '../types'

export function ateAbility(id: string, src: string, type: string): AbilityImpl {
  return {
    id,
    src,
    // CHECK(moveType == TYPE_NORMAL), src/abilities.cc:296 -- part of the
    // ATE_ABILITY macro's OWN body, not a precondition the dispatcher enforces
    // (resolveEffectiveMoveType calls every onMoveType hook regardless of the
    // move's original type; see its own doc for why).
    onMoveType: (ctx) => {
      if (ctx.moveType !== 'NORMAL') return
      ctx.moveType = type
      ctx.ateBoost = true
    },
    onStab: (ctx) => ctx.moveType === type,
  }
}

// Plain onStab-only abilities (no onMoveType at all -- pseudo-STAB for a type the
// battler doesn't naturally have, without changing the move's actual type).
const STAB_ONLY: AbilityImpl[] = [
  {
    // Also carries a non-damage `hailImmune` bitfield (weather-immunity, not part of
    // AbilityFlags/the damage model) -- not ported, matching this file's onAttacker
    // scoping rationale above.
    id: 'ABILITY_AURORA_BOREALIS',
    src: 'src/abilities.cc:3845',
    onStab: (ctx) => ctx.moveType === 'ICE',
  },
  {
    id: 'ABILITY_MOON_SPIRIT',
    src: 'src/abilities.cc:6182',
    onStab: (ctx) => ctx.moveType === 'FAIRY' || ctx.moveType === 'DARK',
  },
  {
    id: 'ABILITY_MYSTIC_POWER',
    src: 'src/abilities.cc:3800',
    flags: { omniStab: true },
    onStab: () => true,
  },
]

export const ATE_ABILITIES: AbilityImpl[] = [
  ...STAB_ONLY,
  ateAbility('ABILITY_DEVIATE', 'src/abilities.cc:9736', 'DARK'),
  ateAbility('ABILITY_EMANATE', 'src/abilities.cc:5988', 'PSYCHIC'),
  ateAbility('ABILITY_FERTILIZE', 'src/abilities.cc:6479', 'GRASS'),
  ateAbility('ABILITY_GALVANIZE', 'src/abilities.cc:2784', 'ELECTRIC'),
  ateAbility('ABILITY_HYDRATE', 'src/abilities.cc:4095', 'WATER'),
  ateAbility('ABILITY_IMMOLATE', 'src/abilities.cc:3715', 'FIRE'),
  ateAbility('ABILITY_INTOXICATE', 'src/abilities.cc:4174', 'POISON'),
  ateAbility('ABILITY_MINERALIZE', 'src/abilities.cc:5063', 'ROCK'),
  ateAbility('ABILITY_MOLTEN_COAT', 'src/abilities.cc:10285', 'ROCK'),
  ateAbility('ABILITY_PIXILATE', 'src/abilities.cc:2441', 'FAIRY'),
  ateAbility('ABILITY_POLLINATE', 'src/abilities.cc:4806', 'BUG'),
  ateAbility('ABILITY_REFRIGERATE', 'src/abilities.cc:2345', 'ICE'),
  ateAbility('ABILITY_SPECTRALIZE', 'src/abilities.cc:4839', 'GHOST'),
  ateAbility('ABILITY_TECTONIZE', 'src/abilities.cc:4029', 'GROUND'),
]
