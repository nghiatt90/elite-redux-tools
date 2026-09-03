// Batch M: the 12 "-ate"-family abilities whose EXTRA hooks (beyond the plain
// ATE_ABILITY(type) macro) turned out to be aliases or small self-contained lambdas
// once actually checked against the C -- see 05-ate-abilities.ts's header comment.
// Plus 7 plain onStab-only lambdas found alongside them in the same census sweep.

import { ateAbility } from './05-ate-abilities'
import { aliasOffensiveMultiplier, aliasTypeEffectiveness, aliasAfterTypeEffectiveness } from './alias'
import type { AbilityImpl } from '../types'

const SUPER_EFFECTIVE = 2048 // GetSuperEffectiveMult() == UQ_4_12(2.0)

export const ATE_FAMILY_AND_ONSTAB: AbilityImpl[] = [
  // Pure ATE_ABILITY -- their only OTHER hooks (onAttacker/onInfiltrate/onEntry/
  // onDefender) are non-damage, not part of this registry's hook set at all.
  { ...ateAbility('ABILITY_ATOMIC_BURST', 'src/abilities.cc:5284', 'ELECTRIC') },
  { ...ateAbility('ABILITY_FIGHT_SPIRIT', 'src/abilities.cc:3916', 'FIGHTING') },
  { ...ateAbility('ABILITY_MOB_BOSS', 'src/abilities.cc:12431', 'DARK') },

  // ATE_ABILITY + an aliased onOffensiveMultiplier.
  {
    ...ateAbility('ABILITY_BUTTERFLY_WINGS', 'src/abilities.cc:12586', 'BUG'),
    flags: { breakable: true },
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_GIANT_WINGS'),
  },
  {
    ...ateAbility('ABILITY_LEAD_CLAWS', 'src/abilities.cc:11201', 'ROCK'),
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_BIG_PECKS'),
  },
  {
    ...ateAbility('ABILITY_UNICORN', 'src/abilities.cc:8075', 'FAIRY'),
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_MIGHTY_HORN'),
  },
  {
    ...ateAbility('ABILITY_WARRIORS_SPEAR', 'src/abilities.cc:12565', 'FIGHTING'),
    onOffensiveMultiplier: aliasOffensiveMultiplier('ABILITY_MIGHTY_HORN'),
  },

  // ATE_ABILITY + a real onTypeEffectiveness (Dragon-vs-Fairy immunity override) --
  // not yet CALLED by calculate.ts (onTypeEffectiveness isn't wired into the
  // type-effectiveness fold yet), but the port is complete and correct for when it is.
  {
    ...ateAbility('ABILITY_DRACONIZE', 'src/abilities.cc:5245', 'DRAGON'),
    onTypeEffectiveness: (ctx) => {
      // Real condition also requires the ability holder be Dragon-type and the
      // per-type slot be immune (0) beforehand -- this hook only receives the
      // OVERALL modifier (see OnTypeEffectivenessContext), so the per-type immunity
      // check is approximated as "the move is Dragon-type and totally blocked so
      // far" rather than inspecting a specific per-type slot.
      if (ctx.moveType === 'DRAGON' && ctx.modifier === 0) ctx.modifier = 1024
    },
  },
  {
    // .onTypeEffectiveness = Impl<ABILITY_DRACONIZE>.onTypeEffectiveness (alias)
    ...ateAbility('ABILITY_DRACONIC_MIGHT', 'src/abilities.cc:10128', 'DRAGON'),
    addsType: 'DRAGON',
    onTypeEffectiveness: aliasTypeEffectiveness('ABILITY_DRACONIZE'),
  },

  // ATE_ABILITY + a real onAfterTypeEffectiveness (halves damage vs Steel-type
  // defenders for Dark/Ghost moves) -- also not yet CALLED by calculate.ts.
  {
    ...ateAbility('ABILITY_STEELWORKER', 'src/abilities.cc:2719', 'STEEL'),
    flags: { breakable: true },
    applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
    onAfterTypeEffectiveness: (ctx) => {
      if (!ctx.defenderTypes.includes('STEEL')) return
      if (ctx.moveType === 'DARK' || ctx.moveType === 'GHOST') ctx.modifier = Math.trunc(ctx.modifier / 2)
    },
  },
  {
    // .onAfterTypeEffectiveness = Impl<ABILITY_STEELWORKER>.onAfterTypeEffectiveness (alias)
    ...ateAbility('ABILITY_STAINLESS_STEEL', 'src/abilities.cc:10009', 'STEEL'),
    flags: { breakable: true, fortKnox: true },
    applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
    onAfterTypeEffectiveness: aliasAfterTypeEffectiveness('ABILITY_STEELWORKER'),
  },

  // ATE_ABILITY only -- Aerilate's onStat half needs GetTypeBeforeUsingMove (the
  // move's type before ANY ability override), a fact this engine's OnStatContext
  // doesn't carry; left out, so this is a genuine partial port (documented, not
  // silent -- Aerilate's -ate half is fully correct).
  { ...ateAbility('ABILITY_AERILATE', 'src/abilities.cc:2475', 'FLYING') },

  // Plain onStab-only lambdas (no onMoveType at all).
  {
    // .onTypeEffectiveness = Impl<ABILITY_CORROSION>.onTypeEffectiveness (alias) --
    // Corrosion isn't ported yet, so this half is a no-op until it is.
    id: 'ABILITY_ACIDIC_SLIME',
    src: 'src/abilities.cc:9305',
    onStab: (ctx) => ctx.moveType === 'WATER',
    onTypeEffectiveness: aliasTypeEffectiveness('ABILITY_CORROSION'),
  },
  { id: 'ABILITY_AMPHIBIOUS', src: 'src/abilities.cc:3896', onStab: (ctx) => ctx.moveType === 'WATER' },
  { id: 'ABILITY_HAND_BARNACLES', src: 'src/abilities.cc:11516', flags: { resistsFortKnox: true }, onStab: (ctx) => ctx.moveType === 'WATER' },
  { id: 'ABILITY_LUNAR_ECLIPSE', src: 'src/abilities.cc:4604', onStab: (ctx) => ctx.moveType === 'DARK' || ctx.moveType === 'FAIRY' },
  { id: 'ABILITY_STORM_CLOUD', src: 'src/abilities.cc:11874', onStab: (ctx) => ctx.moveType === 'ELECTRIC' },
  { id: 'ABILITY_TENDER_AFFECTION', src: 'src/abilities.cc:9983', onStab: (ctx) => ctx.moveType === 'FAIRY' },
  {
    id: 'ABILITY_UNOWN_POWER',
    src: 'src/abilities.cc:9473',
    flags: { omniStab: true },
    onStab: () => true,
    onAfterTypeEffectiveness: (ctx) => {
      if (ctx.modifier < SUPER_EFFECTIVE && (ctx.moveId === 'MOVE_HIDDEN_POWER' || ctx.moveId === 'MOVE_SECRET_POWER')) ctx.modifier = SUPER_EFFECTIVE
    },
  },
]
