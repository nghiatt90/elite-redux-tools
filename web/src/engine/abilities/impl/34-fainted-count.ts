// Batch AH: the fainted-teammate-count family -- Soul Harvest/Supreme Overlord's
// entire effect is a scaling formula on gFaintedMonCount[GetBattlerSide(battler)],
// clamped with `min(5, ...)` in the C. This v1 singles engine has no team/fainted
// concept to derive that from, so BattlerBattleState.alliesFainted is a direct
// scenario toggle instead (matching @smogon/calc's own `alliesFainted` field).
//
// Both use integer division (idiv), not a float multiply -- matching the C's
// `*stat = *stat * (N + min(5, fainted)) / N` on a u32.

import { idiv } from '../../fixed'
import type { AbilityImpl } from '../types'

export const FAINTED_COUNT_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_SOUL_HARVEST',
    src: 'src/abilities.cc:10776',
    flags: { breakable: true },
    onStat: (ctx) => {
      if (ctx.statId === 'spe') return
      ctx.stat = idiv(ctx.stat * (20 + Math.min(5, ctx.alliesFainted)), 20)
    },
  },
  {
    id: 'ABILITY_SUPREME_OVERLORD',
    src: 'src/abilities.cc:7239',
    onStat: (ctx) => {
      if (ctx.statId !== 'atk' && ctx.statId !== 'spatk') return
      ctx.stat = idiv(ctx.stat * (10 + Math.min(5, ctx.alliesFainted)), 10)
    },
  },
]
