// Batch Q: the onChooseOffensiveStat/onChooseDefensiveStat abilities that only
// SWAP which stat is used (no secondary-stat blend) -- see dispatchCalc.ts's note
// on why the blend-only abilities (Juggernaut, Power Core, Slipstream, Speed Force,
// Terminal Velocity, Sleek Scales) stay unmodelled.
//
// Deferred (left in 99-unmodelled.ts): Tangled Feet (needs STATUS2_CONFUSION,
// not tracked).

import type { AbilityImpl } from '../types'

export const CHOOSE_STAT_ABILITIES: AbilityImpl[] = [
  {
    id: 'ABILITY_ANCIENT_IDOL',
    src: 'src/abilities.cc:3795',
    onChooseOffensiveStat: (ctx) => {
      ctx.statToUse = ctx.moveSplit === 'PHYSICAL' ? 'def' : 'spdef'
    },
  },
  {
    // Approximates the C's own recursively-computed Atk-vs-SpAtk comparison with
    // the raw-stat isHighestAttackingStat fact (see the context field's own doc).
    id: 'ABILITY_EQUINOX',
    src: 'src/abilities.cc:5357',
    onChooseOffensiveStat: (ctx) => {
      ctx.statToUse = ctx.isHighestAttackingStat ? 'atk' : 'spatk'
    },
  },
  {
    id: 'ABILITY_IMPULSE',
    src: 'src/abilities.cc:7019',
    onChooseOffensiveStat: (ctx) => {
      if (!ctx.moveFlags.contact) ctx.statToUse = 'spe'
    },
  },
  {
    id: 'ABILITY_MOMENTUM',
    src: 'src/abilities.cc:4654',
    onChooseOffensiveStat: (ctx) => {
      if (ctx.moveFlags.contact) ctx.statToUse = 'spe'
    },
  },
  {
    id: 'ABILITY_BLUR',
    src: 'src/abilities.cc:9841',
    applyOn: { onChooseDefensiveStatFor: 'APPLY_ON_TARGET' },
    onChooseDefensiveStat: (ctx) => {
      if (ctx.moveFlags.contact) ctx.statToUse = 'spe'
    },
  },
  {
    id: 'ABILITY_ELUDE',
    src: 'src/abilities.cc:9856',
    applyOn: { onChooseDefensiveStatFor: 'APPLY_ON_TARGET' },
    onChooseDefensiveStat: (ctx) => {
      if (!ctx.moveFlags.contact) ctx.statToUse = 'spe'
    },
  },
  {
    id: 'ABILITY_DEADEYE',
    src: 'src/abilities.cc:4742',
    onChooseDefensiveStat: (ctx) => {
      if (!ctx.isCrit) return
      if (ctx.defenderDefComparison !== 'equal') ctx.statToUse = ctx.defenderDefComparison
    },
  },
  {
    id: 'ABILITY_EXPLOIT_WEAKNESS',
    src: 'src/abilities.cc:3770',
    onChooseDefensiveStat: (ctx) => {
      if (!ctx.defenderHasAnyStatus) return
      if (ctx.defenderDefComparison !== 'equal') ctx.statToUse = ctx.defenderDefComparison
    },
  },
  {
    // IsStrikerBoosted(battler, move) -- Striker's own condition, moveFlags.kickBased.
    id: 'ABILITY_ROUNDHOUSE',
    src: 'src/abilities.cc:5045',
    onChooseDefensiveStat: (ctx) => {
      if (!ctx.moveFlags.kickBased) return
      if (ctx.defenderDefComparison !== 'equal') ctx.statToUse = ctx.defenderDefComparison
    },
  },
]
