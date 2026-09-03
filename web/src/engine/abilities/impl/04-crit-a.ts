// Batch D1: onCrit abilities. Return a stage delta to ADD to the running crit
// chance, or ALWAYS_CRIT (an alias of the stage clamp ceiling, not NEVER_CRIT) to
// force a guaranteed crit outright. Ambush (needs `gVolatileStructs[battler].isFirstTurn`,
// a per-turn fact this engine doesn't track) is left unmodelled.

import { ALWAYS_CRIT } from '../../crit'
import type { AbilityImpl } from '../types'

export const CRIT_BATTLE_A: AbilityImpl[] = [
  {
    id: 'ABILITY_BATTLE_AURA',
    src: 'src/abilities.cc:7963',
    onCrit: () => 2,
  },
  {
    id: 'ABILITY_GIANT_SHURIKEN',
    src: 'src/abilities.cc:11671',
    onCrit: (ctx) => (ctx.moveId === 'MOVE_WATER_SHURIKEN' ? 1 : 0),
  },
  {
    id: 'ABILITY_HEAVEN_ASUNDER',
    src: 'src/abilities.cc:6421',
    onCrit: (ctx) => (ctx.moveId === 'MOVE_SPACIAL_REND' ? ALWAYS_CRIT : 1),
  },
  {
    id: 'ABILITY_SUPER_LUCK',
    src: 'src/abilities.cc:1623',
    onCrit: () => 1,
  },
  {
    // Merciless: guaranteed crit against a target that's poisoned, paralyzed,
    // bleeding, has a lowered Speed stat, or holds an Iron Ball.
    id: 'ABILITY_MERCILESS',
    src: 'src/abilities.cc:2641',
    onCrit: (ctx) => {
      if (ctx.defenderStatus1.has('STATUS1_POISON') || ctx.defenderStatus1.has('STATUS1_TOXIC_POISON') || ctx.defenderStatus1.has('STATUS1_POISON_ANY')) return ALWAYS_CRIT
      if (ctx.defenderStatus1.has('STATUS1_PARALYSIS')) return ALWAYS_CRIT
      if (ctx.defenderStatus1.has('STATUS1_BLEED')) return ALWAYS_CRIT
      if (ctx.defenderSpeedStageNegative) return ALWAYS_CRIT
      if (ctx.defenderResolvedHoldEffect === 'HOLD_EFFECT_IRON_BALL') return ALWAYS_CRIT
      return 0
    },
  },
]
