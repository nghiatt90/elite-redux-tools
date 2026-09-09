// Batch AG: Protosynthesis -- the last of the field report's named step-7 scenario
// toggles (abilityOn, gender, aura booleans, boostedStat). Its onEntry/onWeather
// halves (ParadoxBoost activation on switch-in/weather change) aren't modelled --
// this calculator has no turn simulation to derive "did this just activate" from,
// so BattlerBattleState.boostedStat is a direct scenario toggle instead (matching
// @smogon/calc's own field). onStat just reads it: 1.5x for Speed, 1.3x for any
// other matching stat (src/abilities.cc:6943-6953). Quark Drive already aliases
// this onStat (batch H, 10-aliases.ts) -- no patch needed there.

import type { AbilityImpl } from '../types'

export const PROTOSYNTHESIS_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_PROTOSYNTHESIS',
    src: 'src/abilities.cc:6943',
    onStat: (ctx) => {
      if (ctx.boostedStat !== ctx.statId) return
      ctx.stat = Math.trunc(ctx.stat * (ctx.statId === 'spe' ? 1.5 : 1.3))
    },
  },
]
