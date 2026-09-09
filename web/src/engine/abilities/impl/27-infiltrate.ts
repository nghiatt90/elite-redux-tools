// Batch AA: onInfiltrate family -- census hook added in the field-report audit.
// Infiltrates (src/battle_script_commands.c:12271-12275), consulted by CalcFinalDmg
// (:7649-7655) to bypass reflect/light screen/aurora veil. WIRED into calculate.ts
// (computeInfiltratesScreens, ANDed into screensActive) -- checkMoldBreaker=FALSE,
// an attacker's own trait, never suppressed by its own Mold Breaker.
//
// Only the SCREENS-bypass boolean is modelled -- see OnInfiltrate's own doc
// (types.ts) for why the C's SUBSTITUTE bit is out of scope (no Substitute
// mechanic exists in this calculator).
//
// 5 of this batch's 10 census abilities get a fresh entry here; the other 5
// (Fight Spirit, Warriors Spear, Qigong, Marine Apex, Mycelium Might) already had a
// real entry for a different hook elsewhere and were patched in place.

import { aliasInfiltrate } from './alias'
import type { AbilityImpl } from '../types'

export const INFILTRATE_ABILITIES: AbilityImpl[] = [
  { id: 'ABILITY_INFILTRATOR', src: 'src/abilities.cc:2150', onInfiltrate: () => true },
  { id: 'ABILITY_DUALITY', src: 'src/abilities.cc:12531', onInfiltrate: aliasInfiltrate('ABILITY_INFILTRATOR') },
  { id: 'ABILITY_KING_OF_THE_JUNGLE', src: 'src/abilities.cc:12559', onInfiltrate: aliasInfiltrate('ABILITY_INFILTRATOR') },
  {
    id: 'ABILITY_PINNACLE_BLADE',
    src: 'src/abilities.cc:8661',
    onInfiltrate: (ctx) => Boolean(ctx.moveFlags.sliceBased),
  },
  {
    // The readiedAction volatile (a "did this Pokemon ready an action this turn"
    // switch-in trigger) isn't tracked anywhere in this engine -- calculate.ts's own
    // battleStat.ts wiring hardcodes the SAME flag to false for the unrelated
    // Readied Action stat-boost ability, so this follows that existing precedent
    // rather than introducing a new gap: always false, condition never met.
    id: 'ABILITY_DEMOLITIONIST',
    src: 'src/abilities.cc:7745',
    onInfiltrate: () => false,
  },
]
