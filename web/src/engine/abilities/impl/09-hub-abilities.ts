// Batch G: "hub" abilities -- high alias-fan-in targets, so porting these unlocks
// several `Impl<ABILITY_X>.hookName` aliases (see 10-aliases.ts) once written.

import { MUL } from '../macros'
import { NEVER_CRIT } from '../../crit'
import { aliasImmune } from './alias'
import type { AbilityImpl } from '../types'

export const HUB_ABILITIES: AbilityImpl[] = [
  {
    // src/abilities.cc:525-530. onCritFor: APPLY_ON_TARGET -- IsTargettedApplyOnFlagAppropriate
    // fires this when the ability's own battler is the move's TARGET, i.e. the
    // defender, matching a defensive "never crit me" ability.
    id: 'ABILITY_BATTLE_ARMOR',
    src: 'src/abilities.cc:525',
    flags: { breakable: true },
    applyOn: { onCritFor: 'APPLY_ON_TARGET' },
    onDefensiveMultiplier: (ctx) => MUL(ctx, 0.8),
    onCrit: () => NEVER_CRIT,
  },
  {
    // src/abilities.cc:1590-1596. gCurrentTurnActionNumber < GetBattlerTurnOrderNum(battler)
    // -- `battler` here is the ability holder (the defender in onDefensiveMultiplier),
    // and "current turn action number" is the attacker's action being processed right
    // now, so this reduces to "the defender (Stall's holder) has not acted yet this
    // turn" == the attacker acts first, exactly DefensiveMultiplierContext's
    // attackerActsFirst.
    id: 'ABILITY_STALL',
    src: 'src/abilities.cc:1590',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.attackerActsFirst) MUL(ctx, 0.7)
    },
  },
  {
    // src/abilities.cc:2110-2115. GetBattlerTurnOrderNum(target) < gCurrentTurnActionNumber
    // -- `target` is the move's target (the defender); this is the mirror image of
    // Stall's condition above: the defender's turn order slot has ALREADY passed by
    // the time the attacker's action runs, i.e. the defender moved first this turn ==
    // NOT attackerActsFirst. The C also excludes EFFECT_FUTURE_SIGHT, which this v1
    // engine's direct-damage calculator has no representation for (Future Sight never
    // flows through this per-move calculation as an ordinary hit) -- omitted rather
    // than modelled.
    id: 'ABILITY_ANALYTIC',
    src: 'src/abilities.cc:2110',
    onOffensiveMultiplier: (ctx) => {
      if (!ctx.attackerActsFirst) MUL(ctx, 1.3)
    },
  },
  {
    // src/abilities.cc:2704-2712. onDefensiveMultiplier delegates to Heatproof
    // (0.5x vs Fire, src/abilities.cc's Heatproof block, already ported in
    // 02-defensive-multiplier-a.ts) -- ported here as a direct literal rather than a
    // cross-batch import, since the condition is one line.
    id: 'ABILITY_WATER_BUBBLE',
    src: 'src/abilities.cc:2704',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'WATER') MUL(ctx, 2.0)
    },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveType === 'FIRE') MUL(ctx, 0.5)
    },
  },
  {
    // src/abilities.cc:4370-4379. onAccuracy (never-miss vs. a super-effective hit)
    // isn't a damage-VALUE hook -- this engine reports damage assuming a hit, so
    // onAccuracy has no modelling target here; only onCrit is ported.
    id: 'ABILITY_FATAL_PRECISION',
    src: 'src/abilities.cc:4370',
    onCrit: (ctx) => {
      const SUPER_EFFECTIVE = 2048 // GetSuperEffectiveMult() == UQ_4_12(2.0), see typeEffectiveness.ts
      return ctx.typeEffectiveness >= SUPER_EFFECTIVE ? 3 /* ALWAYS_CRIT */ : 0
    },
  },
  {
    // src/abilities.cc:6221-6230. onImmune delegates to Queenly Majesty (a
    // priority-move immunity, not a damage-value hook, so not modelled here);
    // onDefensiveMultiplier: 0.5x vs a special move while the ATTACKER is
    // sandstorm-affected.
    id: 'ABILITY_SAND_GUARD',
    src: 'src/abilities.cc:6221',
    flags: { breakable: true },
    onDefensiveMultiplier: (ctx) => {
      if (ctx.moveSplit === 'SPECIAL' && ctx.weather === 'SANDSTORM') MUL(ctx, 0.5)
    },
    // CHECK(sandstorm) then delegates to Queenly Majesty's onImmune (movePriority > 0).
    onImmune: (ctx) => ctx.weather === 'SANDSTORM' && aliasImmune('ABILITY_QUEENLY_MAJESTY')(ctx),
  },
]
