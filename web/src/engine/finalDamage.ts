// CalcFinalDmg, src/battle_util.c:7517-7720 -- 17 stages in EXACT order. Two distinct
// channels, kept separate here exactly as the C keeps them separate:
//
//   - `finalModifier`: an accumulated UQ_4_12 value, re-quantized via mulModifier at
//     each stage, applied to `dmg` ONCE at the very end via applyModifier.
//   - direct `dmg = applyModifier(m, dmg)` operations (crit, weather): each is its
//     own immediate rounding step, interleaved with the accumulator above.
//
// Because mulModifier re-quantizes every time, stage ORDER is directly observable in
// the output, not just which multipliers apply -- this file's stage order is the
// single most important thing about it to keep synchronized with the C.

import { applyModifier, mulModifier, uq } from './fixed'

export interface FinalDamageStages {
  /** #1 multi-target reduction (:7524) -- always false in this v1 singles-only engine;
   * kept as an explicit field (not hardcoded away) so doubles support later is a
   * one-line change here, not a rewrite. */
  isMultiTarget: boolean
  /** #2 type effectiveness, as a UQ_4_12 value from typeEffectiveness.ts. */
  typeEffectiveness: number
  /** #3 CalculateAbilityMultipliers' result (offensive * defensive), UQ_4_12 --
   * uq(1.0) until the ability registry is wired (Task 9/10). */
  abilityMultiplier: number
  /** #4 crit: which flat multiplier applies (1.5 normally, 2.0 for
   * MISC_EFFECT_INCREASED_CRIT_DAMAGE moves) -- `null` when this isn't a crit. */
  critMultiplier: 1.5 | 2.0 | null
  // #5 hell mode and #6 damage slider are intentionally omitted: both are
  // player-facing difficulty/QoL options with no equivalent in a standalone damage
  // calculator, and both default to no-op in the unmodified game anyway.
  /** #7 weather, as a direct per-step multiplier already resolved by the caller (see
   * weather.ts) -- `null` when no weather multiplier applies to this move/type pair. */
  weatherMultiplier: number | null
  /** #8 STAB, expressed the way StabMultiplierInHalves returns it: 4 = Adaptability's
   * 2.0x, 3 = ordinary 1.5x, 2 (or any other value) = no STAB. */
  stabInHalves: 2 | 3 | 4
  /** #9 screens -- Reflect/Light Screen/Aurora Veil, already resolved to "does this
   * apply" by the caller (crit and Infiltrator both bypass it -- see calculate.ts). */
  screensActive: boolean
  isDoubleBattle: boolean // only affects the screens multiplier (0.5 vs 0.66)
  /** #10 Parental Bond-family bonus hit's own reduced-power multiplier, UQ_4_12 --
   * uq(1.0) for a move's first/only hit and for every hit of a move's OWN
   * multi-hit effect (Population Bomb, Double Hit, ...), which never scale power
   * per hit. Set by calculate.ts per-hit via multiHit.ts's resolveHitPlan. */
  parentalBondMultiplier: number
  /** #11 defender's ally Friend Guard/Caretaker/Food Lovers count (0-3, each x0.75) --
   * always 0 in singles (no ally exists to have the ability). */
  allyDamageReducerCount: number
  /** #12 attacker's held item, already resolved to its UQ_4_12 multiplier by the
   * caller (Expert Belt/Life Orb/Metronome/Amulet Coin/Punching Glove -- see
   * items.ts), uq(1.0) if none applies. */
  attackerItemMultiplier: number
  /** #13 defender's resist berry: 0.5 normally, 0.25 with Ripen -- `null` if no berry
   * reduction applies. */
  resistBerryMultiplier: 0.5 | 0.25 | null
  /** #14 Glaive Rush -- the defender used it last turn against this attacker. */
  glaiveRushActive: boolean
  /** #15 semi-invulnerable 2x situations: underground (Dig), underwater (Dive), or
   * airborne (Fly/Bounce) with the move's matching FLAG_DMG_* set. At most one is
   * ever true for a given move+target in practice, but the C checks all three
   * independently, so this does too. */
  hitsSemiInvulnerableUnderground: boolean
  hitsSemiInvulnerableUnderwater: boolean
  hitsSemiInvulnerableInAir: boolean
  /** #16 MISC_EFFECT_SUPEREFFECTIVE_BOOST, only when typeEffectiveness >= 2.0x. */
  hasSuperEffectiveBoost: boolean
}

/** Every intermediate value CalcFinalDmg passes through, in order -- for tests that
 * assert stage POSITION as well as stage VALUE (the class of bug this port is most
 * exposed to: a correct multiplier applied in the wrong place). */
export interface FinalDamageTraceEntry {
  stage: string
  channel: 'finalModifier' | 'dmg'
  before: number
  after: number
}

export interface FinalDamageResult {
  dmg: number
  trace: FinalDamageTraceEntry[]
}

/**
 * CalcFinalDmg, src/battle_util.c:7517-7720. `dmg` is the value coming out of the
 * core equation (level/power/atk/def, already floor(.../50)+2'd) -- see calculate.ts.
 */
export function calcFinalDamage(dmg: number, stages: FinalDamageStages): FinalDamageResult {
  const trace: FinalDamageTraceEntry[] = []
  let finalModifier = uq(1.0)
  let d = dmg

  const mulFinal = (stage: string, factor: number) => {
    const before = finalModifier
    finalModifier = mulModifier(finalModifier, factor)
    trace.push({ stage, channel: 'finalModifier', before, after: finalModifier })
  }
  const applyDirect = (stage: string, factor: number) => {
    const before = d
    d = applyModifier(factor, d)
    trace.push({ stage, channel: 'dmg', before, after: d })
  }

  // #1 multi-target (:7524)
  if (stages.isMultiTarget) mulFinal('multiTarget', uq(0.75))

  // #2 type effectiveness (:7527)
  mulFinal('typeEffectiveness', stages.typeEffectiveness)

  // #3 ability multipliers (:7529-7532)
  mulFinal('abilityMultiplier', stages.abilityMultiplier)

  // #4 critical hit -- direct on dmg (:7535-7541)
  if (stages.critMultiplier !== null) applyDirect('crit', uq(stages.critMultiplier))

  // #5/#6 hell mode / damage slider -- intentionally omitted, see field doc.

  // #7 weather -- direct on dmg (:7592-7648)
  if (stages.weatherMultiplier !== null) applyDirect('weather', uq(stages.weatherMultiplier))

  // #8 STAB (:7638-7646)
  if (stages.stabInHalves === 4) mulFinal('stab', uq(2.0))
  else if (stages.stabInHalves === 3) mulFinal('stab', uq(1.5))

  // #9 screens (:7648-7656)
  if (stages.screensActive) mulFinal('screens', stages.isDoubleBattle ? uq(0.66) : uq(0.5))

  // #10 Parental Bond family (:7658-7662)
  if (stages.parentalBondMultiplier !== uq(1.0)) mulFinal('parentalBond', stages.parentalBondMultiplier)

  // #11 ally damage reducers, x0.75 each, stacking (:7665-7667)
  for (let i = 0; i < stages.allyDamageReducerCount; i++) mulFinal('allyDamageReducer', uq(0.75))

  // #12 attacker item (:7670-7688)
  if (stages.attackerItemMultiplier !== uq(1.0)) mulFinal('attackerItem', stages.attackerItemMultiplier)

  // #13 defender resist berry (:7691-7702)
  if (stages.resistBerryMultiplier !== null) mulFinal('resistBerry', uq(stages.resistBerryMultiplier))

  // #14 Glaive Rush (:7704)
  if (stages.glaiveRushActive) mulFinal('glaiveRush', uq(2.0))

  // #15 semi-invulnerable 2x situations (:7706-7708)
  if (stages.hitsSemiInvulnerableUnderground) mulFinal('hitsUnderground', uq(2.0))
  if (stages.hitsSemiInvulnerableUnderwater) mulFinal('hitsUnderwater', uq(2.0))
  if (stages.hitsSemiInvulnerableInAir) mulFinal('hitsInAir', uq(2.0))

  // #16 super-effective boost, only when typeEff >= 2.0x (:7710-7713)
  if (stages.hasSuperEffectiveBoost && stages.typeEffectiveness >= uq(2.0)) mulFinal('superEffectiveBoost', uq(4.0 / 3.0))

  // #17 apply the accumulated modifier once, floor at 1 (:7715-7718)
  const beforeFinal = d
  d = applyModifier(finalModifier, d)
  trace.push({ stage: 'applyFinalModifier', channel: 'dmg', before: beforeFinal, after: d })
  if (d === 0) {
    const beforeFloor = d
    d = 1
    trace.push({ stage: 'floorAtOne', channel: 'dmg', before: beforeFloor, after: d })
  }

  return { dmg: d, trace }
}

/** A stage-agnostic default: every optional multiplier at its inert value, so a test
 * or caller only needs to override what it's actually exercising. */
export function defaultFinalDamageStages(dmg: { typeEffectiveness: number }): FinalDamageStages {
  return {
    isMultiTarget: false,
    typeEffectiveness: dmg.typeEffectiveness,
    abilityMultiplier: uq(1.0),
    critMultiplier: null,
    weatherMultiplier: null,
    stabInHalves: 2,
    screensActive: false,
    isDoubleBattle: false,
    parentalBondMultiplier: uq(1.0),
    allyDamageReducerCount: 0,
    attackerItemMultiplier: uq(1.0),
    resistBerryMultiplier: null,
    glaiveRushActive: false,
    hitsSemiInvulnerableUnderground: false,
    hitsSemiInvulnerableUnderwater: false,
    hitsSemiInvulnerableInAir: false,
    hasSuperEffectiveBoost: false,
  }
}
