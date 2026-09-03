// Batch F: the SWARM_MULTIPLIER / BOOSTED_SWARM_MULTIPLIER macro family,
// src/abilities.cc:303-320:
//
//   #define SWARM_MULTIPLIER(type) ... if (hp <= maxHP/3) MUL(1.5) else MUL(1.2)
//   #define BOOSTED_SWARM_MULTIPLIER(type) ... if (hp <= maxHP/3) MUL(1.8) else MUL(1.3)
//
// Both check `gBattleMons[battler].hp`/`.maxHP`, where `battler` is the ability's own
// battler. No applyOn is set on any of these 20 (default APPLY_ON_SELF), so the hook
// only ever runs when its own battler IS the context battler -- which for
// onOffensiveMultiplier is always battlerAtk (see OffensiveMultiplierContext's doc).
// That means `battler` in the C is always the attacker here, so ctx.attackerHp/
// ctx.attackerMaxHp are the right substitution.

import { MUL } from '../macros'
import type { AbilityImpl, OffensiveMultiplierContext } from '../types'

function swarmMultiplier(type: string, low: number, high: number) {
  return (ctx: OffensiveMultiplierContext) => {
    if (ctx.moveType !== type) return
    if (ctx.attackerHp <= Math.floor(ctx.attackerMaxHp / 3)) MUL(ctx, low)
    else MUL(ctx, high)
  }
}

export const SWARM_FAMILY: AbilityImpl[] = [
  { id: 'ABILITY_OVERGROW', src: 'src/abilities.cc:1279', onOffensiveMultiplier: swarmMultiplier('GRASS', 1.5, 1.2) },
  { id: 'ABILITY_BLAZE', src: 'src/abilities.cc:1284', onOffensiveMultiplier: swarmMultiplier('FIRE', 1.5, 1.2) },
  { id: 'ABILITY_TORRENT', src: 'src/abilities.cc:1289', onOffensiveMultiplier: swarmMultiplier('WATER', 1.5, 1.2) },
  { id: 'ABILITY_SWARM', src: 'src/abilities.cc:1294', onOffensiveMultiplier: swarmMultiplier('BUG', 1.5, 1.2) },
  { id: 'ABILITY_VENGEANCE', src: 'src/abilities.cc:3694', onOffensiveMultiplier: swarmMultiplier('GHOST', 1.5, 1.2) },
  { id: 'ABILITY_EARTHBOUND', src: 'src/abilities.cc:3912', onOffensiveMultiplier: swarmMultiplier('GROUND', 1.5, 1.2) },
  { id: 'ABILITY_SHORT_CIRCUIT', src: 'src/abilities.cc:4156', onOffensiveMultiplier: swarmMultiplier('ELECTRIC', 1.5, 1.2) },
  { id: 'ABILITY_PSYCHIC_MIND', src: 'src/abilities.cc:4402', onOffensiveMultiplier: swarmMultiplier('PSYCHIC', 1.5, 1.2) },
  { id: 'ABILITY_FLOCK', src: 'src/abilities.cc:4567', onOffensiveMultiplier: swarmMultiplier('FLYING', 1.5, 1.2) },
  { id: 'ABILITY_FIGHTER', src: 'src/abilities.cc:6515', onOffensiveMultiplier: swarmMultiplier('FIGHTING', 1.5, 1.2) },
  { id: 'ABILITY_ROCKHARD_WILL', src: 'src/abilities.cc:7763', onOffensiveMultiplier: swarmMultiplier('ROCK', 1.5, 1.2) },
  { id: 'ABILITY_FOUL_ENERGY', src: 'src/abilities.cc:12538', onOffensiveMultiplier: swarmMultiplier('DARK', 1.5, 1.2) },

  { id: 'ABILITY_HELLBLAZE', src: 'src/abilities.cc:5292', onOffensiveMultiplier: swarmMultiplier('FIRE', 1.8, 1.3) },
  { id: 'ABILITY_RIPTIDE', src: 'src/abilities.cc:5297', onOffensiveMultiplier: swarmMultiplier('WATER', 1.8, 1.3) },
  { id: 'ABILITY_FOREST_RAGE', src: 'src/abilities.cc:5302', onOffensiveMultiplier: swarmMultiplier('GRASS', 1.8, 1.3) },
  { id: 'ABILITY_PURGATORY', src: 'src/abilities.cc:5984', onOffensiveMultiplier: swarmMultiplier('GHOST', 1.8, 1.3) },
  { id: 'ABILITY_GLADIATOR', src: 'src/abilities.cc:9387', onOffensiveMultiplier: swarmMultiplier('FIGHTING', 1.8, 1.3) },
  { id: 'ABILITY_ROCKHARD_SHAFT', src: 'src/abilities.cc:9725', onOffensiveMultiplier: swarmMultiplier('ROCK', 1.8, 1.3) },
  { id: 'ABILITY_3_GT_1', src: 'src/abilities.cc:12466', onOffensiveMultiplier: swarmMultiplier('WATER', 1.8, 1.3) },
  { id: 'ABILITY_OVERWHELMING_MIND', src: 'src/abilities.cc:12527', onOffensiveMultiplier: swarmMultiplier('PSYCHIC', 1.8, 1.3) },
]
