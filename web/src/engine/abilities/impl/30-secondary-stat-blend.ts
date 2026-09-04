// Batch AD: the secondary-stat-blend family -- onChooseOffensiveStat/
// onChooseDefensiveStat abilities whose ENTIRE effect is CalculateStat's cross-stat
// blend (:7213-7229): add a percentage of a DIFFERENT stat's fully-scaled value on
// top of the primary one. Left unmodelled until now because that blend needed a
// bigger change than a single context field -- see dispatchCalc.ts's
// computeChooseOffensiveStat/computeChooseDefensiveStat and calculate.ts's
// applySecondaryStatBlend, both now wired end-to-end.
//
// 6 of this batch's 12 census abilities get a fresh entry here; the other 6
// (Maximum Acceleration, Iron Giant, Mach 3, Sumo Guard, Unstable Core, Sand
// Titan) already had a real entry for a different hook elsewhere and were patched
// in place to alias the same onChoose*Stat body.

import type { AbilityImpl } from '../types'

export const SECONDARY_STAT_BLEND_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_JUGGERNAUT',
    src: 'src/abilities.cc:4141',
    flags: { breakable: true },
    onChooseOffensiveStat: (ctx) => {
      if (ctx.moveFlags.contact) ctx.secondaryStat.def = (ctx.secondaryStat.def ?? 0) + 20
    },
  },
  {
    id: 'ABILITY_SPEED_FORCE',
    src: 'src/abilities.cc:4530',
    onChooseOffensiveStat: (ctx) => {
      if (ctx.moveFlags.contact) ctx.secondaryStat.spe = (ctx.secondaryStat.spe ?? 0) + 20
    },
  },
  {
    id: 'ABILITY_POWER_CORE',
    src: 'src/abilities.cc:4618',
    onChooseOffensiveStat: (ctx) => {
      const stat = ctx.moveSplit === 'PHYSICAL' ? 'def' : 'spdef'
      ctx.secondaryStat[stat] = (ctx.secondaryStat[stat] ?? 0) + 20
    },
  },
  {
    id: 'ABILITY_TERMINAL_VELOCITY',
    src: 'src/abilities.cc:7027',
    onChooseOffensiveStat: (ctx) => {
      if (ctx.moveSplit === 'SPECIAL') ctx.secondaryStat.spe = (ctx.secondaryStat.spe ?? 0) + 20
    },
  },
  {
    id: 'ABILITY_SLIPSTREAM',
    src: 'src/abilities.cc:8387',
    onChooseOffensiveStat: (ctx) => {
      ctx.secondaryStat.spe = (ctx.secondaryStat.spe ?? 0) + 20
    },
  },
  {
    // onChooseDefensiveStatFor: APPLY_ON_TARGET -- only fires when checked against
    // the DEFENDER's own slots (see computeChooseDefensiveStat's doc on why this
    // survives even though it never touches statToUse itself).
    id: 'ABILITY_SLEEK_SCALES',
    src: 'src/abilities.cc:9850',
    applyOn: { onChooseDefensiveStatFor: 'APPLY_ON_TARGET' },
    onChooseDefensiveStat: (ctx) => {
      ctx.secondaryStat.spe = (ctx.secondaryStat.spe ?? 0) + 15
    },
  },
]
