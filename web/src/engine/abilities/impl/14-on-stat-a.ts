// Batch L: onStat lambdas portable with the context fields just added (weather,
// terrain, hp/maxHp, hasAnyStatus, status1, isHighestAttackingStat, isHighestStat).
// Multiplication mirrors the C's own operator exactly per entry: `*stat *= 1.5`
// ports as `Math.trunc(ctx.stat * 1.5)` (C's `*=` on an int truncates); `*stat = *stat
// * 4 / 3` ports as the same left-to-right integer-division chain, not a single
// float multiply, since intermediate truncation can differ.
//
// Deferred (left in 99-unmodelled.ts): Aerilate (needs GetTypeBeforeUsingMove, tied
// to its own onMoveType/onStab -- port together later), Eternal Flower (mega-form +
// a SEPARATE non-stacking flag this engine doesn't track), Rat King (needs base stat
// total), Supreme Overlord/Soul Harvest (need a fainted-teammates count -- this v1
// singles engine has no team/fainted concept to default sensibly). Unburden/Slow
// Start (batch AC) and Protosynthesis (batch AG) were ALSO in this "needs
// persistent ability-activation-state" bucket originally, but a generic abilityOn/
// boostedStat scenario toggle (BattlerBattleState) unblocked them later.

import { APPLY_ON_OTHER } from '../applyOn'
import type { AbilityImpl, OnStatContext } from '../types'

const SUN = ['SUN_PERMANENT', 'SUN_TEMPORARY', 'SUN_PRIMAL']
const RAIN = ['RAIN_PERMANENT', 'RAIN_TEMPORARY', 'RAIN_PRIMAL']
const SANDSTORM = ['SANDSTORM']
const HAIL = ['HAIL']
const FOG = ['FOG']

function inWeather(ctx: OnStatContext, kinds: string[]): boolean {
  return kinds.includes(ctx.weather)
}

export const ON_STAT_BATCH_A: AbilityImpl[] = [
  {
    id: 'ABILITY_ABOMINABLE_MONSTER',
    src: 'src/abilities.cc:12471',
    onStat: (ctx) => {
      if (ctx.statId === 'spdef' && inWeather(ctx, HAIL)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_BIOFILM',
    src: 'src/abilities.cc:10143',
    onStat: (ctx) => {
      if (ctx.statId === 'spdef' && ctx.terrain === 'TERRAIN_TOXIC') ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    // Referenced by ABILITY_BIG_LEAVES/ABILITY_RITE_OF_SPRING's composites below.
    id: 'ABILITY_CHLOROPHYLL',
    src: 'src/abilities.cc:877',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && inWeather(ctx, SUN)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  { id: 'ABILITY_DEAD_POWER', src: 'src/abilities.cc:7559', onStat: (ctx) => { if (ctx.statId === 'atk') ctx.stat = Math.trunc(ctx.stat * 1.5) } },
  {
    id: 'ABILITY_DEFEATIST',
    src: 'src/abilities.cc:1874',
    onStat: (ctx) => {
      if (ctx.statId !== 'atk' && ctx.statId !== 'spatk') return
      if (ctx.hp <= Math.floor(ctx.maxHp / 3)) ctx.stat = Math.trunc(ctx.stat / 2)
    },
  },
  {
    id: 'ABILITY_ECTOPLASM',
    src: 'src/abilities.cc:7803',
    onStat: (ctx) => {
      if (ctx.isHighestAttackingStat && inWeather(ctx, FOG)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_ETHEREAL_RUSH',
    src: 'src/abilities.cc:7857',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && inWeather(ctx, FOG)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    // Was previously only referenced as a no-op via ABILITY_PURE_POWER's alias
    // (batch H) -- now a real port, so Pure Power starts working too.
    id: 'ABILITY_FELINE_PROWESS',
    src: 'src/abilities.cc:3926',
    onStat: (ctx) => {
      if (ctx.statId === 'spatk') ctx.stat = Math.trunc(ctx.stat * 2)
    },
  },
  {
    id: 'ABILITY_FLARE_BOOST',
    src: 'src/abilities.cc:1989',
    // TakesNoBurnDamage's RETURN_ABILITY_IF_FLAG(battler, FALSE, noBurnDamage)
    // (battle_util.c:2374-2377) reads this same bitfield -- see endTurn.ts.
    flags: { noBurnDamage: true },
    onStat: (ctx) => {
      if (ctx.statId !== 'spatk') return
      if (ctx.status1.has('STATUS1_BURN')) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_FLOWER_GIFT',
    src: 'src/abilities.cc:1830',
    flags: { breakable: true },
    onStat: (ctx) => {
      if (ctx.statId !== 'spatk' && ctx.statId !== 'spdef') return
      if (inWeather(ctx, SUN)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_FLOWER_NECKLACE',
    src: 'src/abilities.cc:2428',
    onStat: (ctx) => {
      if (ctx.statId === 'spdef' && ctx.terrain === 'TERRAIN_GRASSY') ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_GRASS_PELT',
    src: 'src/abilities.cc:2420',
    onStat: (ctx) => {
      if (ctx.statId === 'def' && ctx.terrain === 'TERRAIN_GRASSY') ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_HADRON_ENGINE',
    src: 'src/abilities.cc:7441',
    onStat: (ctx) => {
      if (ctx.statId === 'spatk' && ctx.terrain === 'TERRAIN_ELECTRIC') ctx.stat = Math.trunc(Math.trunc((ctx.stat * 4) / 3))
    },
  },
  { id: 'ABILITY_HUGE_POWER', src: 'src/abilities.cc:953', onStat: (ctx) => { if (ctx.statId === 'atk') ctx.stat = Math.trunc(ctx.stat * 2) } },
  {
    id: 'ABILITY_JUNGLE_FEVER',
    src: 'src/abilities.cc:12551',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && ctx.terrain === 'TERRAIN_GRASSY') ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_LAST_STAND',
    src: 'src/abilities.cc:7929',
    onStat: (ctx) => {
      if (ctx.statId !== 'def' && ctx.statId !== 'spdef') return
      // (((stat * 60) * (maxHp - hp)) / maxHp) / 100, left-to-right integer division
      const bonus = Math.trunc(Math.trunc((ctx.stat * 60 * (ctx.maxHp - ctx.hp)) / ctx.maxHp) / 100)
      ctx.stat = ctx.stat + bonus
    },
  },
  { id: 'ABILITY_LIGHT_METAL', src: 'src/abilities.cc:1938', onStat: (ctx) => { if (ctx.statId === 'spe') ctx.stat = Math.trunc(ctx.stat * 1.3) } },
  {
    // Referenced by ABILITY_AURORAS_GALE's alias (batch H).
    id: 'ABILITY_MAJESTIC_BIRD',
    src: 'src/abilities.cc:4160',
    onStat: (ctx) => {
      if (ctx.statId === 'spatk') ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_MARVEL_SCALE',
    src: 'src/abilities.cc:1270',
    onStat: (ctx) => {
      if (ctx.statId === 'def' && ctx.hasAnyStatus) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_ORICHALCUM_PULSE',
    src: 'src/abilities.cc:7410',
    onStat: (ctx) => {
      if (ctx.statId !== 'atk') return
      if (inWeather(ctx, SUN)) ctx.stat = Math.trunc(Math.trunc((ctx.stat * 4) / 3))
    },
  },
  {
    id: 'ABILITY_POLARITY',
    src: 'src/abilities.cc:1210',
    onStat: (ctx) => {
      if (ctx.isHighestStat) ctx.stat = Math.trunc(ctx.stat * 1.3)
    },
  },
  {
    id: 'ABILITY_QUICK_FEET',
    src: 'src/abilities.cc:1550',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && ctx.hasAnyStatus) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_RAGING_STORM',
    src: 'src/abilities.cc:1541',
    onStat: (ctx) => {
      if (ctx.isHighestAttackingStat && inWeather(ctx, RAIN)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    // Referenced by ABILITY_ATLANTIC_RULER/ABILITY_BREAKWATER's aliases (batch H)
    // and ABILITY_SAND_BENDER/ABILITY_SAND_FIEND's below.
    id: 'ABILITY_SAND_FORCE',
    src: 'src/abilities.cc:2225',
    onStat: (ctx) => {
      if (ctx.isHighestAttackingStat && inWeather(ctx, SANDSTORM)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_SAND_RUSH',
    src: 'src/abilities.cc:2096',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && inWeather(ctx, SANDSTORM)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    // Referenced by ABILITY_GLACIAL_GHOST/ABILITY_ICE_PICK/ABILITY_WAY_OF_SWIFTNESS's
    // aliases (batch H).
    id: 'ABILITY_SLUSH_RUSH',
    src: 'src/abilities.cc:2746',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && inWeather(ctx, HAIL)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    // Referenced by ABILITY_BIG_LEAVES/ABILITY_RITE_OF_SPRING's composites below.
    id: 'ABILITY_SOLAR_POWER',
    src: 'src/abilities.cc:1532',
    onStat: (ctx) => {
      if (ctx.isHighestAttackingStat && inWeather(ctx, SUN)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_SURGE_SURFER',
    src: 'src/abilities.cc:2798',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && ctx.terrain === 'TERRAIN_ELECTRIC') ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    // Referenced by ABILITY_ATLANTIC_RULER/ABILITY_BREAKWATER/ABILITY_PROPELLER_TAIL/
    // ABILITY_SEABORNE/ABILITY_WAY_OF_SWIFTNESS's aliases (batch H).
    id: 'ABILITY_SWIFT_SWIM',
    src: 'src/abilities.cc:869',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && inWeather(ctx, RAIN)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_THERMAL_SLIDE',
    src: 'src/abilities.cc:10396',
    onStat: (ctx) => {
      if (ctx.statId === 'spe' && (inWeather(ctx, SUN) || inWeather(ctx, HAIL))) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
  {
    id: 'ABILITY_WHITEOUT',
    src: 'src/abilities.cc:3628',
    onStat: (ctx) => {
      if (ctx.isHighestAttackingStat && inWeather(ctx, HAIL)) ctx.stat = Math.trunc(ctx.stat * 1.5)
    },
  },
]

// Big Leaves and Rite of Spring both call Solar Power's AND Chlorophyll's onStat
// unconditionally in sequence (src/abilities.cc:4719-4722, :9755-9758) -- safe to
// call both directly since their conditions (isHighestAttackingStat vs statId ===
// 'spe') never both match the same statId, so order/double-application isn't a
// concern here the way it is for MUL-based accumulators.
function solarPowerThenChlorophyll(ctx: OnStatContext): void {
  ON_STAT_BATCH_A.find((a) => a.id === 'ABILITY_SOLAR_POWER')!.onStat!(ctx)
  ON_STAT_BATCH_A.find((a) => a.id === 'ABILITY_CHLOROPHYLL')!.onStat!(ctx)
}

ON_STAT_BATCH_A.push(
  { id: 'ABILITY_BIG_LEAVES', src: 'src/abilities.cc:4719', onStat: solarPowerThenChlorophyll },
  { id: 'ABILITY_RITE_OF_SPRING', src: 'src/abilities.cc:9755', onStat: solarPowerThenChlorophyll },
)

// RuinEffect(ruinStat, battler, statId, stat, flags), src/abilities.cc:324-329 --
// each of the 4 Ruin abilities reduces ONE stat by 25%, on the OPPONENT
// (applyOn.onStatFor: APPLY_ON_OTHER, verified against abilityHooks.json), gated by
// the shared NonStackingState.nonStackingRuin flag so at most one Ruin effect
// applies per stat computation. The C ALSO checks whether the affected battler
// itself holds a same-statId Ruin ability (a self-immunity edge case); omitted here
// since a 2-battler v1 singles engine makes that check functionally redundant with
// the shared flag in every reachable case.
function ruinEffect(statId: OnStatContext['statId']) {
  return (ctx: OnStatContext): void => {
    if (ctx.statId !== statId) return
    if (ctx.flags.nonStackingRuin) return
    ctx.stat = Math.trunc(ctx.stat * 0.75)
    ctx.flags.nonStackingRuin = true
  }
}

ON_STAT_BATCH_A.push(
  { id: 'ABILITY_BEADS_OF_RUIN', src: 'src/abilities.cc:7384', applyOn: { onStatFor: APPLY_ON_OTHER }, onStat: ruinEffect('def') },
  { id: 'ABILITY_SWORD_OF_RUIN', src: 'src/abilities.cc:7370', applyOn: { onStatFor: APPLY_ON_OTHER }, onStat: ruinEffect('def') },
  { id: 'ABILITY_TABLETS_OF_RUIN', src: 'src/abilities.cc:7363', applyOn: { onStatFor: APPLY_ON_OTHER }, onStat: ruinEffect('atk') },
  { id: 'ABILITY_VESSEL_OF_RUIN', src: 'src/abilities.cc:7377', applyOn: { onStatFor: APPLY_ON_OTHER }, onStat: ruinEffect('spatk') },
)
