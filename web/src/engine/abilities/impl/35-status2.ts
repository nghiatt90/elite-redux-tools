// Batch AI: the status2-volatile family -- STATUS2_CONFUSION/STATUS2_ENRAGED, a
// per-battler volatile separate from status1 (major status) that this calculator
// has no turn simulation to derive, so it's a scenario toggle (BattlerBattleState.
// condition.isConfused/isEnraged, 2 new checkboxes in BattlerPanel.tsx -- not
// mutually exclusive with the Status select above them).
//
// Cosmic Dust already aliases Cosmic Daze's onOffensiveMultiplier (batch H,
// 10-aliases.ts) -- no patch needed there.

import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

export const STATUS2_ABILITIES: AbilityImpl[] = [
  {
    // Checks the move's TARGET (the defender), not its own holder -- see
    // OffensiveMultiplierContext.defenderIsConfused/defenderIsEnraged's own doc.
    id: 'ABILITY_COSMIC_DAZE',
    src: 'src/abilities.cc:6730',
    onOffensiveMultiplier: (ctx) => {
      if (ctx.defenderIsConfused || ctx.defenderIsEnraged) MUL(ctx, 2)
    },
  },
  {
    id: 'ABILITY_MADNESS_ENHANCEMENT',
    src: 'src/abilities.cc:9921',
    onDefensiveMultiplier: (ctx) => {
      if (ctx.defenderIsEnraged) MUL(ctx, 0.8)
    },
  },
  {
    // Unscoped -- see OnChooseDefensiveStatContext.attackerIsConfused's own doc on
    // why this only ever fires while checking the ATTACKER's own slots.
    id: 'ABILITY_TANGLED_FEET',
    src: 'src/abilities.cc:1383',
    onChooseDefensiveStat: (ctx) => {
      if (ctx.attackerIsConfused) ctx.statToUse = 'spe'
    },
  },
]
