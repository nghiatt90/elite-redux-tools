// Batch K: onDefensiveMultiplier lambdas portable with the current context shape,
// plus the composite delegates (Droideka/Fortress/Petroleum Jelly) whose entire
// hook body is 2 sequential `Impl<X>.onDefensiveMultiplier(...)` calls -- these
// weren't caught by batch H's PURE-alias census because a multi-call lambda body
// isn't the single-assignment `.onX = Impl<Y>.onX` alias FORM, even though it's
// alias-shaped in substance. Uses alias.ts's lazy lookup so import order and
// future re-ports of the delegated abilities are never a concern.
//
// Deferred (left in 99-unmodelled.ts): Chuckster/Drakelp Head (need persistent
// per-battle ability-activation-state tracking this engine doesn't model),
// Madness Enhancement (needs STATUS2_ENRAGED, not tracked), Rivalry (needs gender,
// same as its onOffensiveMultiplier half -- see that batch's note).

import { MUL } from '../macros'
import { aliasDefensiveMultiplier, aliasImmune, aliasCrit } from './alias'
import type { AbilityImpl, DefensiveMultiplierContext } from '../types'

const SUPER_EFFECTIVE = 2048 // GetSuperEffectiveMult() == UQ_4_12(2.0)

function composeDefensive(...targets: string[]) {
  const delegates = targets.map(aliasDefensiveMultiplier)
  return (ctx: DefensiveMultiplierContext): void => {
    for (const d of delegates) d(ctx)
  }
}

const LEAD_COAT: AbilityImpl = {
  id: 'ABILITY_LEAD_COAT',
  src: 'src/abilities.cc:3883',
  flags: { breakable: true },
  onDefensiveMultiplier: (ctx) => {
    if (ctx.moveSplit === 'PHYSICAL') MUL(ctx, 0.6)
  },
  onStat: (ctx) => {
    if (ctx.statId === 'spe') ctx.stat = Math.trunc(ctx.stat * 0.9)
  },
}

export const DEFENSIVE_MULTIPLIER_BATCH_C: AbilityImpl[] = [
  {
    id: 'ABILITY_BARK_SKIN',
    src: 'src/abilities.cc:11348',
    addsType: 'GHOST',
    onDefensiveMultiplier: (ctx) => {
      MUL(ctx, ctx.typeEffectiveness >= SUPER_EFFECTIVE ? 0.7 : 0.85)
    },
  },
  {
    id: 'ABILITY_ROCK_ARMOR',
    src: 'src/abilities.cc:11187',
    addsType: 'ROCK',
    onDefensiveMultiplier: (ctx) => MUL(ctx, 0.9),
  },
  {
    id: 'ABILITY_DRY_SKIN',
    src: 'src/abilities.cc:1470',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE') MUL(ctx, 1.25)
    },
    // Impl<DRY_SKIN>.onAbsorb = Impl<WATER_ABSORB>.onAbsorb (function-pointer copy).
    onAbsorb: (ctx) => ctx.moveType === 'WATER',
  },
  {
    id: 'ABILITY_SUN_BASKING',
    src: 'src/abilities.cc:7420',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if ((ctx.weather === 'SUN_PERMANENT' || ctx.weather === 'SUN_TEMPORARY' || ctx.weather === 'SUN_PRIMAL') && ctx.moveSplit === 'PHYSICAL') MUL(ctx, 0.5)
    },
    // CHECK(any sun variant) then delegates to Queenly Majesty's onImmune.
    onImmune: (ctx) =>
      (ctx.weather === 'SUN_PERMANENT' || ctx.weather === 'SUN_TEMPORARY' || ctx.weather === 'SUN_PRIMAL') && aliasImmune('ABILITY_QUEENLY_MAJESTY')(ctx),
  },
  { id: 'ABILITY_MUCUS_MEMBRANE', src: 'src/abilities.cc:11600', flags: { breakable: true }, onDefensiveMultiplier: (ctx) => MUL(ctx, 0.7) },
  {
    // Referenced by ABILITY_DEFLECT/ABILITY_ULTRA_INSTINCT's aliases (batch H).
    id: 'ABILITY_PARRY',
    src: 'src/abilities.cc:5004',
    onDefensiveMultiplier: (ctx) => MUL(ctx, 0.8),
  },
  { id: 'ABILITY_PRISMATIC_FUR', src: 'src/abilities.cc:5678', onDefensiveMultiplier: (ctx) => MUL(ctx, 0.5) },
  {
    id: 'ABILITY_PURIFYING_SALT',
    src: 'src/abilities.cc:6888',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GHOST') MUL(ctx, 0.5)
    },
  },
  {
    // Real gap fix: the C also has an onStat half (:8789-8791, Speed *0.8) missing
    // from this port entirely.
    id: 'ABILITY_TERASTAL_TREASURE',
    src: 'src/abilities.cc:8786',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => MUL(ctx, 0.6),
    onStat: (ctx) => {
      if (ctx.statId === 'spe') ctx.stat = Math.trunc(ctx.stat * 0.8)
    },
  },
  {
    // Real gap fix: the C also has an onStat half (:10792-10794, Speed *0.5)
    // missing from this port entirely.
    id: 'ABILITY_THICK_BLUBBER',
    src: 'src/abilities.cc:10785',
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE' || ctx.moveType === 'ICE') MUL(ctx, 0.25)
    },
    onStat: (ctx) => {
      if (ctx.statId === 'spe') ctx.stat = Math.trunc(ctx.stat * 0.5)
    },
  },
  {
    id: 'ABILITY_WATER_COMPACTION',
    src: 'src/abilities.cc:2623',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'WATER') MUL(ctx, 0.5)
    },
  },
  {
    // Referenced by ABILITY_PETROLEUM_JELLY's composite below.
    id: 'ABILITY_HYPER_CLEANSE',
    src: 'src/abilities.cc:10271',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'POISON') MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_IMMUNITY',
    src: 'src/abilities.cc:681',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'POISON') MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_MAGMA_ARMOR',
    src: 'src/abilities.cc:989',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'WATER' || ctx.moveType === 'ICE') MUL(ctx, 0.7)
    },
  },
  LEAD_COAT,
  {
    // .onStat = Impl<ABILITY_LEAD_COAT>.onStat, src/abilities.cc:6805 -- LEAD_COAT is
    // a plain module-level object (not yet registered when this array is built), so
    // this references its onStat function directly rather than going through
    // alias.ts's registry lookup.
    id: 'ABILITY_CHROME_COAT',
    src: 'src/abilities.cc:6800',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'SPECIAL') MUL(ctx, 0.6)
    },
    onStat: (ctx) => LEAD_COAT.onStat!(ctx),
  },
  {
    // Real gap fix: the C also copies Shell Armor's onCrit/onCritFor
    // (:12456-12457), which this port was missing entirely.
    id: 'ABILITY_DROIDEKA',
    src: 'src/abilities.cc:12450',
    applyOn: { onCritFor: 'APPLY_ON_TARGET' },
    onDefensiveMultiplier: composeDefensive('ABILITY_HEATPROOF', 'ABILITY_SHELL_ARMOR'),
    onCrit: aliasCrit('ABILITY_SHELL_ARMOR'),
  },
  {
    // Real gap fix: the C also copies Shell Armor's onCrit/onCritFor
    // (:12306-12307), which this port was missing entirely.
    id: 'ABILITY_FORTRESS',
    src: 'src/abilities.cc:12300',
    flags: { breakable: true },
    applyOn: { onCritFor: 'APPLY_ON_TARGET' },
    onDefensiveMultiplier: composeDefensive('ABILITY_FILTER', 'ABILITY_SHELL_ARMOR'),
    onCrit: aliasCrit('ABILITY_SHELL_ARMOR'),
  },
  {
    id: 'ABILITY_PETROLEUM_JELLY',
    src: 'src/abilities.cc:12617',
    flags: { breakable: true },
    onDefensiveMultiplier: composeDefensive('ABILITY_HYPER_CLEANSE', 'ABILITY_LIQUIFIED'),
  },
]
