// Batch AF: Rivalry -- the last of the field report's named step-7 scenario
// toggles (abilityOn, boostedStat, gender, aura booleans). Two independent halves:
// onOffensiveMultiplier boosts 1.25x when the ATTACKER's own gender matches the
// defender's; onDefensiveMultiplier reduces to 0.75x when the ATTACKER's gender is
// the OPPOSITE of the DEFENDER's (i.e. Rivalry punishes being attacked by the
// opposite sex too, not just rewarding same-sex attacks) -- src/abilities.cc:
// 1401-1417. Genderless on EITHER side always exempts both halves, matching the
// C's `genderAtk != MON_GENDERLESS` guard (a flipped Genderless stays Genderless,
// so it can never equal a real gender either).

import { MUL } from '../macros'
import type { AbilityImpl } from '../types'

const OPPOSITE: Record<'MALE' | 'FEMALE' | 'GENDERLESS', 'MALE' | 'FEMALE' | 'GENDERLESS'> = {
  MALE: 'FEMALE',
  FEMALE: 'MALE',
  GENDERLESS: 'GENDERLESS',
}

export const RIVALRY_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_RIVALRY',
    src: 'src/abilities.cc:1401',
    flags: { breakable: true },
    onOffensiveMultiplier: (ctx) => {
      if (ctx.attackerGender !== 'GENDERLESS' && ctx.attackerGender === ctx.defenderGender) MUL(ctx, 1.25)
    },
    onDefensiveMultiplier: (ctx) => {
      const flipped = OPPOSITE[ctx.attackerGender]
      if (flipped !== 'GENDERLESS' && flipped === ctx.defenderGender) MUL(ctx, 0.75)
    },
  },
]
