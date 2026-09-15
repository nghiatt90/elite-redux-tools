// Batch I: onOffensiveMultiplier lambdas portable with the context fields now
// available (moveType/moveFlags/moveSplit/typeEffectiveness/isCrit/weather/terrain/
// defenderTypes/attackerStatus1/sameMoveTurnsInARow). RESISTANCE(n) sites use MUL --
// see macros.ts's doc on why the two are equivalent for damage purposes.

import { MUL } from '../macros'
import { mulModifier, uq } from '../../fixed'
import { aliasInfiltrate, aliasStab } from './alias'
import type { AbilityImpl } from '../types'

const SUPER_EFFECTIVE = 2048 // GetSuperEffectiveMult() == UQ_4_12(2.0)

export const OFFENSIVE_MULTIPLIER_BATCH_D: AbilityImpl[] = [
  { id: 'ABILITY_BLOOD_PRICE', src: 'src/abilities.cc:6756', onOffensiveMultiplier: (ctx) => MUL(ctx, 1.3) },
  { id: 'ABILITY_HUSTLE', src: 'src/abilities.cc:1172', onOffensiveMultiplier: (ctx) => MUL(ctx, 1.4) },
  {
    id: 'ABILITY_DEEP_FREEZE',
    src: 'src/abilities.cc:9343',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'WATER' || ctx.moveType === 'ICE') MUL(ctx, 1.25)
    },
    // Real gap fix: the C also has an onDefensiveMultiplier half (:9349-9351,
    // RESISTANCE(.5) vs Fire) that this port was entirely missing.
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE') MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_DOOM_BLAST',
    src: 'src/abilities.cc:9270',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'DARK') MUL(ctx, 1.35)
    },
  },
  {
    id: 'ABILITY_DUAL_SHADOW',
    src: 'src/abilities.cc:9540',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ELECTRIC' || ctx.moveType === 'DARK') MUL(ctx, 1.35)
    },
  },
  {
    id: 'ABILITY_DUNE_TERROR',
    src: 'src/abilities.cc:5432',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GROUND') MUL(ctx, 1.2)
    },
    // Real gap fix: the C also has an onDefensiveMultiplier half (:5436-5438,
    // MUL(.65) in Sandstorm) that this port was missing.
    onDefensiveMultiplier: (ctx) => {
      if (ctx.weather === 'SANDSTORM') MUL(ctx, 0.65)
    },
  },
  {
    id: 'ABILITY_ELECTRIC_BURST',
    src: 'src/abilities.cc:4309',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ELECTRIC') MUL(ctx, 1.35)
    },
  },
  {
    // Referenced by ABILITY_STONECUTTER's alias (already ported in batch H).
    id: 'ABILITY_FOSSILIZED',
    src: 'src/abilities.cc:3951',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ROCK') MUL(ctx, 1.2)
    },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'ROCK') MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_INFERNAL_RAGE',
    src: 'src/abilities.cc:5446',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE') MUL(ctx, 1.35)
    },
  },
  {
    id: 'ABILITY_NOCTURNAL',
    src: 'src/abilities.cc:4001',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'DARK') MUL(ctx, 1.25)
    },
    // Real gap fix: the C also has an onDefensiveMultiplier half (:4005-4007,
    // RESISTANCE(.75) vs Dark/Fairy) that this port was missing.
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'DARK' || ctx.moveType === 'FAIRY') MUL(ctx, 0.75)
    },
  },
  {
    id: 'ABILITY_PLASMA_LAMP',
    src: 'src/abilities.cc:6056',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE' || ctx.moveType === 'ELECTRIC') MUL(ctx, 1.2)
    },
  },
  {
    // Referenced by ABILITY_SMOLDERING_WOOD's alias (already ported in batch H).
    id: 'ABILITY_RAW_WOOD',
    src: 'src/abilities.cc:4322',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GRASS') MUL(ctx, 1.2)
    },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GRASS') MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_VENOBLAZE_PINCERS',
    src: 'src/abilities.cc:8102',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'PHYSICAL') MUL(ctx, 1.2)
    },
  },
  {
    id: 'ABILITY_SOUL_CRUSHER',
    src: 'src/abilities.cc:8044',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.hammerBased) MUL(ctx, 1.1)
    },
    // Real gap fix: the C's onChooseDefensiveStat half (:8048-8050, hammerBased ->
    // SPDEF) was missing from this port entirely.
    onChooseDefensiveStat: (ctx) => {
      if (ctx.moveFlags.hammerBased) ctx.statToUse = 'spdef'
    },
  },
  {
    // IsSoundMove's C also lets an attacker-held ability GRANT the sound flag
    // (onModifyMoveFlags) when the move's own FLAG_SOUND is unset -- no ability in
    // this engine currently implements that fallback, so this checks the move's own
    // `sound` flag only. If a sound-granting ability is ever ported, revisit.
    id: 'ABILITY_LIQUID_VOICE',
    src: 'src/abilities.cc:2763',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.sound) MUL(ctx, 1.2)
    },
    // Real gap fix: the C's own onMoveType half (:2767-2771, sound Normal move ->
    // Water) was missing -- BANSHEE/POWER_METAL/SAND_SONG/SNOW_SONG (18-offensive-
    // multiplier-e.ts's soundAteAbility) already ported this exact shape for their
    // own types, this just never landed on Liquid Voice itself.
    onMoveType: (ctx) => {
      if (ctx.moveType === 'NORMAL' && ctx.moveFlags?.sound) ctx.moveType = 'WATER'
    },
  },
  {
    // See Liquid Voice's note above on IsSoundMove's unmodelled ability-granted
    // fallback. Referenced by ABILITY_AMPLIFIER/ABILITY_BASS_BOOSTED/
    // ABILITY_SLUDGY_MIX's aliases (already ported in batch H).
    id: 'ABILITY_PUNK_ROCK',
    src: 'src/abilities.cc:3277',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.sound) MUL(ctx, 1.3)
    },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveFlags.sound) MUL(ctx, 0.5)
    },
  },
  {
    // HasAnyStatusOrAbility -- see OffensiveMultiplierContext.attackerHasAnyStatus's
    // own doc on the C's logical-AND typo (harmless here).
    id: 'ABILITY_RAGE_POINT',
    src: 'src/abilities.cc:8758',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.attackerHasAnyStatus) MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_ARCANE_FORCE',
    src: 'src/abilities.cc:6367',
    // Real gap fix: the C also has `.onStab = Impl<MYSTIC_POWER>.onStab` (always
    // TRUE) plus `.omniStab = TRUE` -- this port had neither, so Arcane Force never
    // actually granted its unconditional pseudo-STAB.
    flags: { omniStab: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.typeEffectiveness >= SUPER_EFFECTIVE) MUL(ctx, 1.1)
    },
    onStab: aliasStab('ABILITY_MYSTIC_POWER'),
  },
  {
    id: 'ABILITY_OVERRULE',
    src: 'src/abilities.cc:9891',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.isCrit && ctx.typeEffectiveness < uq(1.0)) MUL(ctx, 2)
    },
    // src/abilities.cc:9895-9904 -- `return gIsCriticalHit`. Since this
    // calculator reports a crit and non-crit row as two separate, deterministic
    // scenarios rather than drawing one random roll, "does this hit crit"
    // translates directly to isForcedCrit (see OnMoldBreakerContext's own doc).
    onMoldBreaker: (ctx) => ctx.isForcedCrit,
  },
  {
    id: 'ABILITY_ECHOLOCATION',
    src: 'src/abilities.cc:11336',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.weather === 'FOG') MUL(ctx, 1.2)
    },
  },
  {
    // Real gap fix: this port previously only had the offensive half
    // (onOffensiveMultiplier) -- the C also has a defensive half
    // (onAfterTypeEffectiveness, :11414-11420, APPLY_ON_TARGET) capping incoming
    // Ghost-type damage to 0.5x while the DEFENDER is in Fog, which was missing
    // entirely.
    id: 'ABILITY_FOGGY_EYE',
    src: 'src/abilities.cc:11409',
    applyOn: { onAfterTypeEffectivenessFor: 'APPLY_ON_TARGET' },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GHOST' && ctx.weather === 'FOG') MUL(ctx, 1.5)
    },
    onAfterTypeEffectiveness: (ctx) => {
      if (ctx.moveType !== 'GHOST') return
      if (ctx.weather !== 'FOG') return
      if (ctx.modifier > uq(0.5)) ctx.modifier = uq(0.5)
    },
  },
  {
    id: 'ABILITY_TOXIC_BOOST',
    src: 'src/abilities.cc:1967',
    onOffensiveMultiplier: (ctx) => {
      const poisoned = ctx.attackerStatus1.has('STATUS1_POISON') || ctx.attackerStatus1.has('STATUS1_TOXIC_POISON') || ctx.attackerStatus1.has('STATUS1_POISON_ANY')
      if (poisoned && ctx.moveSplit === 'PHYSICAL') MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_DRAGONSLAYER',
    src: 'src/abilities.cc:4071',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderTypes.includes('DRAGON')) MUL(ctx, 1.5)
    },
    // Real gap fix: the C also has an onDefensiveMultiplier half (:4075-4078,
    // MUL(.5) when the ATTACKER is Dragon-type) that this port was missing.
    onDefensiveMultiplier: (ctx) => {
      if (ctx.attackerTypes.includes('DRAGON')) MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_FAE_HUNTER',
    src: 'src/abilities.cc:5701',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderTypes.includes('FAIRY')) MUL(ctx, 1.5)
    },
    // Real gap fix: the C also has an onDefensiveMultiplier half (:5705-5707,
    // RESISTANCE(.5) when the ATTACKER is Fairy-type) that this port was missing.
    onDefensiveMultiplier: (ctx) => {
      if (ctx.attackerTypes.includes('FAIRY')) MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_FIREFIGHTER',
    src: 'src/abilities.cc:9776',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderTypes.includes('FIRE')) MUL(ctx, 1.5)
    },
    // Real gap fix: the C also has an onDefensiveMultiplier half (:9780-9782,
    // MUL(.5) when the ATTACKER is Fire-type) that this port was missing.
    onDefensiveMultiplier: (ctx) => {
      if (ctx.attackerTypes.includes('FIRE')) MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_LUMBERJACK',
    src: 'src/abilities.cc:5736',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderTypes.includes('GRASS')) MUL(ctx, 1.5)
    },
    // Real gap fix: the C also has an onDefensiveMultiplier half (:5740-5742,
    // RESISTANCE(.5) when the ATTACKER is Grass-type) that this port was missing.
    onDefensiveMultiplier: (ctx) => {
      if (ctx.attackerTypes.includes('GRASS')) MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_MARINE_APEX',
    src: 'src/abilities.cc:4898',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderTypes.includes('WATER')) MUL(ctx, 1.5)
    },
    onInfiltrate: aliasInfiltrate('ABILITY_INFILTRATOR'),
  },
  {
    id: 'ABILITY_MONSTER_HUNTER',
    src: 'src/abilities.cc:6653',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderTypes.includes('DARK')) MUL(ctx, 1.5)
    },
    // Real gap fix: the C also has an onDefensiveMultiplier half (:6657-6659,
    // MUL(.5) when the ATTACKER is Dark-type) that this port was missing.
    onDefensiveMultiplier: (ctx) => {
      if (ctx.attackerTypes.includes('DARK')) MUL(ctx, 0.5)
    },
  },
  {
    // onOffensiveMultiplier's `target` is the move's target (the defender);
    // onDefensiveMultiplier's `battler` is the ability holder, which IS the
    // defender in that hook -- so both read as "defenderTypes" here, just from
    // the two different context shapes. Referenced by ABILITY_OLD_MARINER's alias
    // (already ported in batch H) for both hooks.
    id: 'ABILITY_SEAWEED',
    src: 'src/abilities.cc:4388',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GRASS' && ctx.defenderTypes.includes('FIRE')) MUL(ctx, 2)
    },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE' && ctx.defenderTypes.includes('GRASS')) MUL(ctx, 0.5)
    },
  },
  {
    id: 'ABILITY_FLOURISH',
    src: 'src/abilities.cc:7631',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'GRASS' && ctx.terrain === 'TERRAIN_GRASSY' && ctx.attackerIsGrounded) MUL(ctx, 1.5)
    },
  },
  {
    id: 'ABILITY_MANA_COAT',
    src: 'src/abilities.cc:12647',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.terrain === 'TERRAIN_PSYCHIC' && ctx.moveSplit === 'PHYSICAL') MUL(ctx, 1.3)
    },
  },
  {
    // Not MUL(n) -- the C calls MulModifier directly with a raw UQ_4_12 operand
    // (UQ_4_12(1.0) + 10*n), not a decimal multiplier, so this bypasses the MUL
    // macro and calls mulModifier() with the literal fixed-point value.
    id: 'ABILITY_RHYTHMIC',
    src: 'src/abilities.cc:7996',
    onOffensiveMultiplier: (ctx) => {
      ctx.modifier = mulModifier(ctx.modifier, uq(1.0) + 10 * ctx.sameMoveTurnsInARow)
    },
  },
  {
    // Requires a live ally battler (BATTLE_PARTNER) to ever apply -- this v1
    // singles engine has none, so this is a faithful, permanent no-op (matching
    // the real ability's own precondition, not a modelling gap). ABILITY_MINUS
    // already aliases this (batch H) and inherits the same no-op.
    id: 'ABILITY_PLUS',
    src: 'src/abilities.cc:1195',
    onOffensiveMultiplier: () => {},
  },
]
