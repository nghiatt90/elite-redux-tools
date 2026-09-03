// Batch W: the onMoldBreaker family. Only the abilities whose condition doesn't
// require recursively simulating the hit's own resolved type/type-effectiveness/
// crit status first -- see OnMoldBreaker's own doc (types.ts) for why Deadly
// Precision, Flawless Precision, Mach 3, Overrule, and Stonecutter (already
// real-ported for their OTHER hooks) don't get an onMoldBreaker body here.

import type { AbilityImpl } from '../types'

export const MOLD_BREAKER_ABILITIES: AbilityImpl[] = [
  {
    // Referenced by Teravolt/Turboblaze/Blind Rage's onMoldBreaker (this batch,
    // and 12-adds-type.ts/10-aliases.ts's ADD-ONS below).
    id: 'ABILITY_MOLD_BREAKER',
    src: 'src/abilities.cc:1617',
    onMoldBreaker: () => true,
  },
  {
    // .onMoldBreaker only -- onInfiltrate is a SEPARATE hook (screens bypass), not
    // ported here; see the census-expansion commit for why it's a distinct batch.
    id: 'ABILITY_MYCELIUM_MIGHT',
    src: 'src/abilities.cc:11147',
    onMoldBreaker: (ctx) => ctx.moveSplit === 'STATUS',
  },
]
