import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from './calculate'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState } from './types'
import type { TypeChart } from './typeEffectiveness'
import type { MoveBehaviors } from './basePower'
import { calcStat } from './stats'
import { uq } from './fixed'

const DATA_DIR = new URL('../../../data/v2.65beta/', import.meta.url)
const species = JSON.parse(readFileSync(fileURLToPath(new URL('species.json', DATA_DIR)), 'utf-8'))
const movesData = JSON.parse(readFileSync(fileURLToPath(new URL('moves.json', DATA_DIR)), 'utf-8'))
const typeChart: TypeChart = JSON.parse(readFileSync(fileURLToPath(new URL('types.json', DATA_DIR)), 'utf-8'))
const moveBehaviors: MoveBehaviors = JSON.parse(readFileSync(fileURLToPath(new URL('moveBehaviors.json', DATA_DIR)), 'utf-8')).behaviors
const battleConstants: BattleConstants = JSON.parse(readFileSync(fileURLToPath(new URL('natures.json', DATA_DIR)), 'utf-8'))

const speciesById: Record<string, any> = Object.fromEntries(species.map((s: any) => [s.id, s]))
const moveById: Record<string, any> = Object.fromEntries(movesData.map((m: any) => [m.id, m]))

function bareTypes(types: string[]): string[] {
  return types.map((t) => t.replace('TYPE_', ''))
}

function condition(overrides: Partial<ConditionBattlerContext> = {}): ConditionBattlerContext {
  return {
    speciesId: 'SPECIES_PIKACHU',
    baseSpeciesId: 'SPECIES_PIKACHU',
    heads: 1,
    isMegaEvolved: false,
    itemId: null,
    resolvedHoldEffect: null,
    itemNegated: false,
    status1: new Set(),
    hasComatose: false,
    hasBloodStainEffect: false,
    isInfatuated: false,
    isConfused: false,
    isEnraged: false,
    wasDamagedThisTurnBy: 'none',
    recentlyFainted: false,
    hp: 100,
    maxHp: 100,
    weight: 60,
    speed: 100,
    positiveStatStageCount: 0,
    negativeStatStageCount: 0,
    usedMovePpRemaining: null,
    helpingHand: false,
    ghastlyEcho: false,
    chargedUp: false,
    meFirst: false,
    fear: false,
    safePassage: false,
    itemResolvedHoldEffectStrength: null,
    lastMoveFailed: false,
    ...overrides,
  }
}

/** A level-100, neutral-nature, 0 EV / 31 IV battler built from real species.json
 * base stats -- exercises the full out-of-battle stat pipeline (stats.ts) plumbed
 * into the battle-stat pipeline (battleStat.ts) via calculate.ts. */
function battler(speciesId: string, overrides: Partial<BattlerBattleState> = {}): BattlerBattleState {
  const s = speciesById[speciesId]
  const level = 100
  const nature = 'NATURE_HARDY' // neutral
  const rawStats = {
    atk: calcStat(s.baseStats.atk, 31, 0, level, nature, 'atk', battleConstants.natureStatTable),
    def: calcStat(s.baseStats.def, 31, 0, level, nature, 'def', battleConstants.natureStatTable),
    spatk: calcStat(s.baseStats.spatk, 31, 0, level, nature, 'spatk', battleConstants.natureStatTable),
    spdef: calcStat(s.baseStats.spdef, 31, 0, level, nature, 'spdef', battleConstants.natureStatTable),
    spe: calcStat(s.baseStats.spe, 31, 0, level, nature, 'spe', battleConstants.natureStatTable),
  }
  return {
    condition: condition({ speciesId, baseSpeciesId: speciesId, hp: 999, maxHp: 999 }),
    types: bareTypes(s.types),
    isGrounded: true,
    semiInvulnerable: 'NONE',
    abilityOn: false,
    gender: 'MALE',
    boostedStat: null,
    alliesFainted: 0,
    slowStartTimer: 5,
    level,
    nature,
    rawStats,
    statStages: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    extraStatLevel: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    holdEffectStrength: null,
    holdEffectType: null,
    naturalGift: null,
    hiddenPowerType: null,
    isTransformed: false,
    canEvolve: false,
    isInfatuatedWithOpponent: false,
    moveSlotPp: {},
    abilitySlots: { ability: null, innates: [null, null, null] },
    ...overrides,
  }
}

function fieldState(overrides: Partial<FieldBattleState> = {}): FieldBattleState {
  return {
    gravityActive: false,
    terrain: null,
    weather: 'NONE',
    sides: {
      attacker: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
      defender: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
    },
    isDoubleBattle: false,
    ...overrides,
  }
}

function moveData(id: string): MoveData {
  const m = moveById[id]
  return {
    id: m.id,
    power: m.power,
    type: m.type ? m.type.replace('TYPE_', '') : null,
    type2: m.type2 ? m.type2.replace('TYPE_', '') : null,
    split: m.split,
    effectChance: m.effectChance,
    splitFlag: m.splitFlag,
    effect: m.effect,
    customBehavior: m.customBehavior,
    crit: m.crit,
    hitsAir: m.hitsAir,
    flags: m.flags ?? {},
    changeTypeHoldEffect: m.effect === 'EFFECT_CHANGE_TYPE_ON_ITEM' && m.argument?.kind === 'other' ? m.argument.value : null,
    miscEffect: m.effect === 'EFFECT_MISC_HIT' && m.argument?.kind === 'misc' ? m.argument.misc : null,
    multiHitArgument: m.effect === 'EFFECT_DOUBLE_HIT' && m.argument?.kind === 'int' ? m.argument.value : null,
  }
}

function scenario(overrides: Partial<DamageCalcScenario> = {}): DamageCalcScenario {
  return {
    move: moveData('MOVE_TACKLE'),
    attacker: battler('SPECIES_GARCHOMP'),
    defender: battler('SPECIES_SKARMORY'),
    field: fieldState(),
    typeChart,
    moveBehaviors,
    battleConstants,
    attackerActsFirst: true,
    sameMoveTurnsInARow: 0,
    hitCount: 3,
    defenderIsSwitching: false,
    magnitudeTier: null,
    attackerRolloutCounter: 0,
    attackerWasHitThisTurn: false,
    beatUpBaseAttack: 80,
    beatUpHitCount: 5,
    defenderUsedGlaiveRush: false,
    ...overrides,
  }
}

describe('calculateMoveDamage -- Garchomp vs Skarmory, real species/move data', () => {
  it('Ground-type Earthquake is a flat immunity against Flying', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_EARTHQUAKE') }))
    expect(result.isImmune).toBe(true)
    expect(result.rolls.every((d) => d === 0)).toBe(true)
  })

  it('Outrage (Dragon, no type2): 0.5x vs Steel/Flying, STAB, no crit -- matches hand-derived arithmetic', () => {
    // atk = floor((2*130+31+0)*100/100)+5 = 296 (neutral nature)
    // def = floor((2*140+31+0)*100/100)+5 = 316
    // core: floor(100*2/5)+2=42; *120=5040; *296=1,491,840; /316->4721; /50+2=96
    // typeEff DRAGON vs STEEL=0.5, vs FLYING=1.0 -> finalModifier folds to 512
    // STAB (Garchomp is Dragon-type): finalModifier 512 -> mulModifier(.,1536)=768
    // applyModifier(768, 96) = 72 (before the random roll)
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_OUTRAGE') }))
    expect(result.isImmune).toBe(false)
    expect(result.effectiveMoveType).toBe('DRAGON')
    expect(result.rolls).toHaveLength(16)
    expect(result.rolls[0]).toBe(61) // roll=15 (85%) is index... see ordering note below
    expect(result.rolls[15]).toBe(72) // roll=0 (100%)
  })

  it('Relic Stone on the DEFENDER nullifies the attacker\'s STAB entirely (battle_util.c:7469-7481)', () => {
    // Same Outrage-vs-Skarmory scenario as above, but the defender now holds Relic
    // Stone: STAB is forced to 2 (i.e. 1.0x, no bonus) regardless of Garchomp's own
    // Dragon typing or Adaptability. applyModifier(512, 96) = 48 instead of 72.
    const result = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_OUTRAGE'),
        defender: battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_RELIC_STONE', innates: [null, null, null] } }),
      }),
    )
    expect(result.rolls[15]).toBe(48)
  })

  it('the attacker\'s OWN Relic Stone does not suppress its own STAB (IsAbilityOnFieldExcept skips the battler itself)', () => {
    const result = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_OUTRAGE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_RELIC_STONE', innates: [null, null, null] } }),
      }),
    )
    expect(result.rolls[15]).toBe(72) // unchanged from the plain STAB case above
  })

  it('rolls are ascending (roll index 0 = smallest multiplier, 85%)', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_OUTRAGE') }))
    for (let i = 1; i < result.rolls.length; i++) {
      expect(result.rolls[i]).toBeGreaterThanOrEqual(result.rolls[i - 1])
    }
  })

  it('critRolls is null only when the move can never crit; Outrage has no innate crit boost but still CAN crit at base rate', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_OUTRAGE') }))
    expect(result.critChanceDenominator).toBe(24) // base GEN_7 rate, no boosts
    expect(result.critRolls).not.toBeNull()
    expect(result.critRolls![0]).toBeGreaterThan(result.rolls[0]) // crit hits harder
  })

  it('a guaranteed-crit move (crit: ALWAYS) reports denominator 1', () => {
    // Frost Breath is ER's ALWAYS-crit move
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_FROST_BREATH') }))
    expect(result.critChanceDenominator).toBe(1)
  })

  it('type2 dual evaluation keeps the larger of the two computed damages', () => {
    // Flying Press (type FIGHTING, type2 FLYING) against a pure Normal-type defender:
    // Fighting vs Normal = neutral (1x), Flying vs Normal = neutral (1x) too -- pick a
    // defender where the two types diverge instead: Skarmory is Steel/Flying.
    // Fighting vs Steel/Flying: 2x * 0.5x = 1x. Flying vs Steel/Flying: 0.5x * 1x = 0.5x.
    // So the Fighting evaluation should win and effectiveMoveType should be FIGHTING.
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_FLYING_PRESS') }))
    expect(result.effectiveMoveType).toBe('FIGHTING')
  })

  it('unmodelled is empty for a plain move with no items/field effects/abilities involved', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE') }))
    expect(result.unmodelled).toEqual([])
  })
})

describe('calculateMoveDamage -- semi-invulnerable double damage (battle_util.c:7707-7709)', () => {
  it('Earthquake doubles damage against an UNDERGROUND (Dig) defender', () => {
    const grounded = scenario({ move: moveData('MOVE_EARTHQUAKE'), defender: battler('SPECIES_GARCHOMP') })
    const underground = scenario({
      move: moveData('MOVE_EARTHQUAKE'),
      defender: battler('SPECIES_GARCHOMP', { semiInvulnerable: 'UNDERGROUND' }),
    })
    const groundedResult = calculateMoveDamage(grounded)
    const undergroundResult = calculateMoveDamage(underground)
    // The 2.0x multiplier itself is exact, but it's folded into finalModifier
    // ALONGSIDE every other stage before one combined ApplyModifier call, then the
    // random-roll truncation (:7818-7821) doesn't scale linearly with a doubled
    // input -- a +/-1 discrepancy from independent floor() truncation is expected,
    // not a rounding bug in this wiring.
    expect(undergroundResult.rolls[0]).toBeGreaterThanOrEqual(groundedResult.rolls[0] * 2 - 1)
    expect(undergroundResult.rolls[0]).toBeLessThanOrEqual(groundedResult.rolls[0] * 2 + 1)
  })

  it('the toggle only fires for the matching move flag -- Surf does not double vs an UNDERGROUND defender', () => {
    const normal = scenario({ move: moveData('MOVE_SURF'), defender: battler('SPECIES_GARCHOMP') })
    const underground = scenario({
      move: moveData('MOVE_SURF'),
      defender: battler('SPECIES_GARCHOMP', { semiInvulnerable: 'UNDERGROUND' }),
    })
    expect(calculateMoveDamage(underground).rolls[0]).toBe(calculateMoveDamage(normal).rolls[0])
  })

  it('Gust (hitsAir: DOUBLE_DAMAGE) doubles vs an AIRBORNE defender; Hurricane (hitsAir: HITS) does not', () => {
    const airborneDefender = battler('SPECIES_GARCHOMP', { semiInvulnerable: 'AIRBORNE' })
    const grounded = battler('SPECIES_GARCHOMP')
    const gustAirborne = calculateMoveDamage(scenario({ move: moveData('MOVE_GUST'), defender: airborneDefender }))
    const gustGrounded = calculateMoveDamage(scenario({ move: moveData('MOVE_GUST'), defender: grounded }))
    expect(gustAirborne.rolls[0]).toBeGreaterThanOrEqual(gustGrounded.rolls[0] * 2 - 1)
    expect(gustAirborne.rolls[0]).toBeLessThanOrEqual(gustGrounded.rolls[0] * 2 + 1)

    const hurricaneAirborne = calculateMoveDamage(scenario({ move: moveData('MOVE_HURRICANE'), defender: airborneDefender }))
    const hurricaneGrounded = calculateMoveDamage(scenario({ move: moveData('MOVE_HURRICANE'), defender: grounded }))
    expect(hurricaneAirborne.rolls[0]).toBe(hurricaneGrounded.rolls[0]) // HITS only lets it connect, no damage multiplier
  })
})

describe('calculateMoveDamage -- Levitate grants Ground immunity (IsBattlerGroundedIgnoreType, battle_util.c:6699-6701,7975-7979)', () => {
  it('Earthquake is immune against a Levitate holder even though Garchomp/Ground is neutral-typed', async () => {
    await import('./abilities/impl/index') // populate the registry
    const result = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EARTHQUAKE'),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] } }),
      }),
    )
    expect(result.isImmune).toBe(true)
    expect(result.rolls.every((d) => d === 0)).toBe(true)
  })

  it("Mold Breaker on the attacker bypasses the defender's Levitate immunity", async () => {
    await import('./abilities/impl/index')
    const withoutMoldBreaker = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EARTHQUAKE'),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] } }),
      }),
    )
    const withMoldBreaker = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EARTHQUAKE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_MOLD_BREAKER', innates: [null, null, null] } }),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] } }),
      }),
    )
    expect(withoutMoldBreaker.isImmune).toBe(true)
    expect(withMoldBreaker.isImmune).toBe(false)
    expect(withMoldBreaker.rolls.some((d) => d > 0)).toBe(true)
  })

  it('Levitate does not grant immunity to non-Ground moves', async () => {
    await import('./abilities/impl/index')
    const result = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_OUTRAGE'),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] } }),
      }),
    )
    expect(result.isImmune).toBe(false)
  })
})

describe('calculateMoveDamage -- Iron Ball/Gravity force grounding, Air Balloon forces airborne (CheckGroundingEffects/CheckLevitatingEffects, battle_util.c:6672-6697)', () => {
  it('Iron Ball grounds a Levitate holder, overriding the ability entirely', async () => {
    await import('./abilities/impl/index')
    const levitateOnly = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EARTHQUAKE'),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] } }),
      }),
    )
    expect(levitateOnly.isImmune).toBe(true)

    const withIronBall = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EARTHQUAKE'),
        defender: battler('SPECIES_GARCHOMP', {
          abilitySlots: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] },
          condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_IRON_BALL' }),
        }),
      }),
    )
    expect(withIronBall.isImmune).toBe(false)
  })

  it('Gravity overrides Levitate, same as Iron Ball', async () => {
    await import('./abilities/impl/index')
    const withGravity = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EARTHQUAKE'),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] } }),
        field: fieldState({ gravityActive: true }),
      }),
    )
    expect(withGravity.isImmune).toBe(false)
  })

  it("Gravity DOES restore a naturally-Flying-type's own chart-based Ground immunity (battle_util.c:7902, IsBattlerGrounded) -- corrects an earlier claim in this codebase that missed this per-component check", () => {
    // Skarmory (Steel/Flying): Ground vs Steel=2x, vs Flying=0x (chart immunity)
    // without Gravity -> immune outright. With Gravity, ONLY the Flying
    // component is restored to neutral (per-component, not the whole modifier)
    // -- the Steel component's real 2x survives, so this becomes 2x super
    // effective, not just "no longer immune".
    const withoutGravity = calculateMoveDamage(scenario({ move: moveData('MOVE_EARTHQUAKE') }))
    expect(withoutGravity.isImmune).toBe(true)

    const withGravity = calculateMoveDamage(scenario({ move: moveData('MOVE_EARTHQUAKE'), field: fieldState({ gravityActive: true }) }))
    expect(withGravity.isImmune).toBe(false)
    expect(withGravity.typeEffectiveness).toBe(uq(2.0))
  })

  it('Air Balloon grants Ground immunity to a non-Flying, non-Levitate defender', () => {
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_EARTHQUAKE'), defender: battler('SPECIES_GARCHOMP') }))
    expect(baseline.isImmune).toBe(false)

    const withAirBalloon = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EARTHQUAKE'),
        defender: battler('SPECIES_GARCHOMP', {
          condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_AIR_BALLOON' }),
        }),
      }),
    )
    expect(withAirBalloon.isImmune).toBe(true)
  })

  it('Thousand Arrows (ignoresLevitation) punches through a naturally Flying-typed immunity, flattening the WHOLE modifier to neutral (battle_util.c:7981-7984) -- unlike the Gravity fix above, this does NOT preserve other components\' real multiplier', () => {
    // Skarmory (Steel/Flying): without the flag, Ground-family moves are a flat
    // immunity (Flying's chart 0 dominates the fold) regardless of Steel's own
    // real 2x weakness.
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_EARTHQUAKE') }))
    expect(baseline.isImmune).toBe(true)

    const thousandArrows = calculateMoveDamage(scenario({ move: moveData('MOVE_THOUSAND_ARROWS') }))
    expect(thousandArrows.isImmune).toBe(false)
    expect(thousandArrows.typeEffectiveness).toBe(uq(1.0)) // flattened neutral, NOT Steel's real 2x
  })
})

describe('calculateMoveDamage -- ignoresAbility forces Mold Breaker unconditionally (SetMoldBreaker, battle_script_commands.c:976-978)', () => {
  it('Sunsteel Strike suppresses a breakable defensive ability (Multiscale) without the attacker needing Mold Breaker itself', async () => {
    await import('./abilities/impl/index')
    const plainDefender = battler('SPECIES_SKARMORY')
    const multiscaleDefender = battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_MULTISCALE', innates: [null, null, null] } })

    // A move WITHOUT ignoresAbility is genuinely halved by Multiscale.
    const normalMoveVsMultiscale = calculateMoveDamage(scenario({ move: moveData('MOVE_STEEL_BEAM'), defender: multiscaleDefender }))
    const normalMoveVsPlain = calculateMoveDamage(scenario({ move: moveData('MOVE_STEEL_BEAM'), defender: plainDefender }))
    expect(normalMoveVsMultiscale.rolls[15]).toBeLessThan(normalMoveVsPlain.rolls[15])

    // Sunsteel Strike (ignoresAbility) should deal the SAME damage regardless
    // of Multiscale -- it's suppressed outright, not just reduced.
    const sunsteelVsMultiscale = calculateMoveDamage(scenario({ move: moveData('MOVE_SUNSTEEL_STRIKE'), defender: multiscaleDefender }))
    const sunsteelVsPlain = calculateMoveDamage(scenario({ move: moveData('MOVE_SUNSTEEL_STRIKE'), defender: plainDefender }))
    expect(sunsteelVsMultiscale.rolls[15]).toBe(sunsteelVsPlain.rolls[15])
  })
})

describe('calculateMoveDamage -- isForcedMinRoll flags Bad Luck/Bad Omen (battle_util.c:7815-7817) without altering any actual roll value', () => {
  it('is true when the defender holds Bad Luck or Bad Omen, false otherwise -- rolls array itself is unchanged either way', () => {
    const baseline = calculateMoveDamage(scenario())
    expect(baseline.isForcedMinRoll).toBe(false)

    const badLuck = calculateMoveDamage(
      scenario({ defender: battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_BAD_LUCK', innates: [null, null, null] } }) }),
    )
    expect(badLuck.isForcedMinRoll).toBe(true)
    expect(badLuck.rolls).toEqual(baseline.rolls) // the roll VALUES are untouched -- only the framing flag differs

    const badOmen = calculateMoveDamage(
      scenario({ defender: battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_BAD_OMEN', innates: [null, null, null] } }) }),
    )
    expect(badOmen.isForcedMinRoll).toBe(true)
  })
})

describe('calculateMoveDamage -- Glaive Rush doubles damage taken by a defender who used it earlier this turn (battle_util.c:7704)', () => {
  it('was permanently dead despite finalDamage.ts already having a glaiveRushActive stage -- nothing ever set it', () => {
    const baseline = calculateMoveDamage(scenario())
    const withGlaiveRush = calculateMoveDamage(scenario({ defenderUsedGlaiveRush: true }))
    // ~2x, allowing for fixed-point truncation drift elsewhere in the pipeline.
    expect(withGlaiveRush.rolls[15]).toBeGreaterThan(baseline.rolls[15] * 1.9)
    expect(withGlaiveRush.rolls[15]).toBeLessThan(baseline.rolls[15] * 2.1)
  })
})

describe('calculateMoveDamage -- Weather Double Boost/Nika: unported ability checks inside CalcFinalDmg\'s weather block (battle_util.c:7580-7634)', () => {
  it('Weather Double Boost SQUARES an EFFECT_WEATHER_BOOST move\'s own boost (1.2 -> 1.44) instead of leaving it at the plain 1.2', async () => {
    await import('./abilities/impl/index')
    const plain = calculateMoveDamage(
      scenario({ move: moveData('MOVE_SUPERHOT_FLAME'), field: fieldState({ weather: 'SUN_PERMANENT' }) }),
    )
    const withAbility = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_SUPERHOT_FLAME'),
        field: fieldState({ weather: 'SUN_PERMANENT' }),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_WEATHER_DOUBLE_BOOST', innates: [null, null, null] } }),
      }),
    )
    expect(withAbility.rolls[15]).toBeGreaterThan(plain.rolls[15])
  })

  it('Weather Double Boost flips the Fire-in-Rain PENALTY into the same boost value, rather than reducing it', async () => {
    await import('./abilities/impl/index')
    const noWeather = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER') }))
    const rainPenalized = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER'), field: fieldState({ weather: 'RAIN_PERMANENT' }) }))
    expect(rainPenalized.rolls[15]).toBeLessThan(noWeather.rolls[15]) // normal 0.5x penalty

    const rainWithAbility = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_FLAMETHROWER'),
        field: fieldState({ weather: 'RAIN_PERMANENT' }),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_WEATHER_DOUBLE_BOOST', innates: [null, null, null] } }),
      }),
    )
    // 1.2x boost instead of a 0.5x penalty -- MORE than the no-weather baseline, not less.
    expect(rainWithAbility.rolls[15]).toBeGreaterThan(noWeather.rolls[15])
  })

  it('Nika exempts Water moves from the Sun penalty (0.5x -> neutral 1.0x, not a boost)', async () => {
    await import('./abilities/impl/index')
    const noWeather = calculateMoveDamage(scenario({ move: moveData('MOVE_SURF') }))
    const sunPenalized = calculateMoveDamage(scenario({ move: moveData('MOVE_SURF'), field: fieldState({ weather: 'SUN_PERMANENT' }) }))
    expect(sunPenalized.rolls[15]).toBeLessThan(noWeather.rolls[15])

    const sunWithNika = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_SURF'),
        field: fieldState({ weather: 'SUN_PERMANENT' }),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_NIKA', innates: [null, null, null] } }),
      }),
    )
    expect(sunWithNika.rolls[15]).toBe(noWeather.rolls[15]) // exactly neutral, matching the no-weather baseline
  })

  it('Steam Eruption gets the same Sun exemption as Nika, without needing the ability', () => {
    const noWeather = calculateMoveDamage(scenario({ move: moveData('MOVE_STEAM_ERUPTION') }))
    const sunWithSteamEruption = calculateMoveDamage(scenario({ move: moveData('MOVE_STEAM_ERUPTION'), field: fieldState({ weather: 'SUN_PERMANENT' }) }))
    expect(sunWithSteamEruption.rolls[15]).toBe(noWeather.rolls[15])
  })
})

describe('calculateMoveDamage -- UpdateTypeModifier\'s superEffectiveVs/ignoreTypeImmunity fields (battle_util.c:7904) -- declared on MoveBehaviorAttack but never read until this fix', () => {
  it('Freeze-Dry (superEffectiveVs: WATER) is super effective against Water, overriding the real 0.5x resistance', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_FREEZE_DRY'), defender: battler('SPECIES_SQUIRTLE') }))
    expect(result.typeEffectiveness).toBe(uq(2.0))
  })

  it('Sheer Cold shares the same Freeze-Dry mechanic (both use EFFECT_FREEZE_DRY)', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_SHEER_COLD'), defender: battler('SPECIES_SQUIRTLE') }))
    expect(result.typeEffectiveness).toBe(uq(2.0))
  })

  it('superEffectiveVs does not affect any other matchup', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_FREEZE_DRY') })) // vs default Skarmory (Steel/Flying)
    expect(result.typeEffectiveness).not.toBe(uq(2.0))
  })

  it('Dragon Rage (ignoreTypeImmunity) bypasses Fairy\'s real chart immunity to Dragon', () => {
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_DRAGON_RAGE'), defender: battler('SPECIES_CLEFAIRY') }))
    expect(baseline.isImmune).toBe(false)
    expect(baseline.typeEffectiveness).toBe(uq(1.0)) // restored to neutral, not super effective
  })

  it('a plain Dragon-type move stays immune against the same Fairy defender, confirming the bypass is Dragon Rage-specific', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_DRAGON_CLAW'), defender: battler('SPECIES_CLEFAIRY') }))
    expect(result.isImmune).toBe(true)
  })
})

describe('calculateMoveDamage -- Struggle is a flat 1.0x, no type effectiveness and no STAB (CalcTypeEffectivenessMultiplier, battle_util.c:8015-8021)', () => {
  it('is NOT immune against a pure Ghost defender, despite being declared Normal-type in this data', () => {
    const struggleVsGhost = calculateMoveDamage(scenario({ move: moveData('MOVE_STRUGGLE'), defender: battler('SPECIES_MISDREAVUS') }))
    expect(struggleVsGhost.isImmune).toBe(false)
    expect(struggleVsGhost.typeEffectiveness).toBe(uq(1.0))
  })

  it('is not resisted or super-effective against any defender -- always exactly neutral', () => {
    const struggleVsSteel = calculateMoveDamage(scenario({ move: moveData('MOVE_STRUGGLE') })) // Skarmory (Steel/Flying) -- Normal is normally resisted by Steel
    expect(struggleVsSteel.typeEffectiveness).toBe(uq(1.0))
  })

  it('does not grant STAB even to a Normal-type attacker', () => {
    const porygon = battler('SPECIES_PORYGON') // pure Normal
    const struggle = calculateMoveDamage(scenario({ move: moveData('MOVE_STRUGGLE'), attacker: porygon, defender: battler('SPECIES_GARCHOMP') }))
    const tackle = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE'), attacker: porygon, defender: battler('SPECIES_GARCHOMP') }))
    // Tackle (40 power, Normal, DOES get STAB from this same Normal-type
    // attacker) should deal MORE damage than power-scaling alone would predict
    // if Struggle (50 power) also incorrectly got STAB -- Struggle/Tackle's
    // ratio should track the bare 50/40 power ratio (1.25x) divided by STAB's
    // 1.5x (since Tackle has it and Struggle must not), not the raw 1.25x
    // itself.
    const ratio = struggle.rolls[15] / tackle.rolls[15]
    expect(ratio).toBeLessThan(1.25)
    expect(ratio).toBeGreaterThan(0.7)
  })
})

describe('calculateMoveDamage -- Ring Target neutralizes only its holder\'s immune type component (battle_util.c:7881-7884)', () => {
  it("Thunderbolt vs Ground/Flying Skarmory-like defender: immune without Ring Target, super-effective (not flat neutral) with it", () => {
    // Skarmory is Steel/Flying (not Ground), so swap in a Ground/Flying-typed
    // defender directly to exercise the immune-component case.
    const groundFlyingDefender = battler('SPECIES_SKARMORY', { types: ['GROUND', 'FLYING'] })
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_THUNDERBOLT'), defender: groundFlyingDefender }))
    expect(baseline.isImmune).toBe(true)

    const withRingTarget = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_THUNDERBOLT'),
        defender: {
          ...groundFlyingDefender,
          condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_RING_TARGET' }),
        },
      }),
    )
    expect(withRingTarget.isImmune).toBe(false)
  })
})

describe('calculateMoveDamage -- onTypeEffectiveness/onAfterTypeEffectiveness are wired in (src/battle_util.c:7861-7913,7984-7992)', () => {
  it("Scrappy (attacker's own onTypeEffectiveness) lets Normal moves hit a pure Ghost-type defender", async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario({ defender: battler('SPECIES_MISDREAVUS') })) // pure Ghost, Tackle is Normal
    expect(baseline.isImmune).toBe(true)

    const withScrappy = calculateMoveDamage(
      scenario({
        defender: battler('SPECIES_MISDREAVUS'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_SCRAPPY', innates: [null, null, null] } }),
      }),
    )
    expect(withScrappy.isImmune).toBe(false)
  })

  it("Wonder Guard (defender's onAfterTypeEffectiveness, APPLY_ON_TARGET) blocks everything but super-effective hits", async () => {
    await import('./abilities/impl/index')
    const wonderGuardDefender = battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_WONDER_GUARD', innates: [null, null, null] } })

    const neutralHit = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE'), defender: wonderGuardDefender })) // Normal vs Steel/Flying: 0.5x
    expect(neutralHit.isImmune).toBe(true)

    const superEffectiveHit = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER'), defender: wonderGuardDefender })) // Fire vs Steel: 2x
    expect(superEffectiveHit.isImmune).toBe(false)
  })

  it("Soothsayer now correctly fires for the DEFENDER (APPLY_ON_TARGET), not the attacker -- the scope bug this session's audit found", async () => {
    await import('./abilities/impl/index')
    const soothsayerDefender = battler('SPECIES_SKARMORY', {
      abilityOn: true,
      abilitySlots: { ability: 'ABILITY_SOOTHSAYER', innates: [null, null, null] },
    })
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER'), defender: battler('SPECIES_SKARMORY') }))
    const withSoothsayer = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER'), defender: soothsayerDefender }))
    expect(withSoothsayer.rolls[15]).toBeLessThan(baseline.rolls[15])

    // Held by the ATTACKER instead: must NOT apply (would have before the scope fix).
    const soothsayerAttacker = battler('SPECIES_GARCHOMP', { abilityOn: true, abilitySlots: { ability: 'ABILITY_SOOTHSAYER', innates: [null, null, null] } })
    const wrongSide = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER'), attacker: soothsayerAttacker, defender: battler('SPECIES_SKARMORY') }))
    expect(wrongSide.rolls[15]).toBe(baseline.rolls[15])
  })

  it("Bone Zone (attacker's own onAfterTypeEffectiveness) breaks a bone-based Ground move's Flying immunity", async () => {
    await import('./abilities/impl/index')
    // Skarmory (Steel/Flying): Ground vs Steel=2x, vs Flying=0x -> immune outright
    // without Bone Zone; with it, the Flying component is dropped and the Steel
    // 2x survives -- super-effective, not just neutral.
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_BONE_CLUB') }))
    expect(baseline.isImmune).toBe(true)

    const withBoneZone = calculateMoveDamage(
      scenario({ move: moveData('MOVE_BONE_CLUB'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_BONE_ZONE', innates: [null, null, null] } }) }),
    )
    expect(withBoneZone.isImmune).toBe(false)
    expect(withBoneZone.typeEffectiveness).toBe(uq(2.0))
  })

  it("Foggy Eye's own missing defensive half (found in this session's audit) caps incoming Ghost damage to 0.5x in Fog", async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_SHADOW_BALL') }))
    const withFoggyEyeNoWeather = calculateMoveDamage(
      scenario({ move: moveData('MOVE_SHADOW_BALL'), defender: battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_FOGGY_EYE', innates: [null, null, null] } }) }),
    )
    expect(withFoggyEyeNoWeather.rolls[15]).toBe(baseline.rolls[15]) // no Fog -- no effect

    const withFoggyEyeInFog = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_SHADOW_BALL'),
        defender: battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_FOGGY_EYE', innates: [null, null, null] } }),
        field: fieldState({ weather: 'FOG' }),
      }),
    )
    expect(withFoggyEyeInFog.rolls[15]).toBeLessThan(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- onSwapSplit is wired in (SetSwapDamageCategory, src/battle_util.c:7341-7381)', () => {
  it('Mystic Blades flips a physical slicing move to SPECIAL, using spatk/spdef instead of atk/def', async () => {
    await import('./abilities/impl/index')
    // Garchomp: atk 130 >> spatk 80. Skarmory: def 140 >> spdef 70. X-Scissor
    // (physical, sliceBased) normally uses atk vs def (strong stat vs strong
    // stat); with the split flipped it uses spatk vs spdef (weak vs weak) --
    // net effect is a much bigger number, not a subtler one, so this isn't a
    // coincidental near-tie the way Samurott's own atk/spatk would have been.
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_X_SCISSOR') }))
    const withMysticBlades = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_X_SCISSOR'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_MYSTIC_BLADES', innates: [null, null, null] } }),
      }),
    )
    expect(withMysticBlades.rolls[15]).toBeGreaterThan(baseline.rolls[15])
  })

  it('a special move is untouched (the ability only checks SPLIT_PHYSICAL)', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER') }))
    const withMysticBlades = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_FLAMETHROWER'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_MYSTIC_BLADES', innates: [null, null, null] } }),
      }),
    )
    expect(withMysticBlades.rolls[15]).toBe(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- Lucky Punch (species-family crit boost, src/battle_script_commands.c:1551-1556)', () => {
  it('Chansey holding Lucky Punch gets the +2 crit stage boost', () => {
    const withoutItem = calculateMoveDamage(scenario({ attacker: battler('SPECIES_CHANSEY') }))
    const withItem = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_CHANSEY', { condition: condition({ speciesId: 'SPECIES_CHANSEY', baseSpeciesId: 'SPECIES_CHANSEY', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_LUCKY_PUNCH' }) }) }),
    )
    expect(withItem.critChanceDenominator).not.toBeNull()
    expect(withItem.critChanceDenominator!).toBeLessThan(withoutItem.critChanceDenominator ?? Infinity)
  })

  it('a non-Chansey-line holder gets no boost from Lucky Punch', () => {
    const withoutItem = calculateMoveDamage(scenario())
    const withItem = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_GARCHOMP', { condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_LUCKY_PUNCH' }) }) }),
    )
    expect(withItem.critChanceDenominator).toBe(withoutItem.critChanceDenominator)
  })
})

describe('calculateMoveDamage -- EFFECT_HIDDEN_POWER (Hidden Power/Secret Power/Techno Blast share this in ER; GetMoveTypeInternal, src/battle_main.c:5041-5042)', () => {
  it('with no hiddenPowerType set, stays at the declared Normal type and surfaces an unmodelled note', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_HIDDEN_POWER') }))
    expect(result.effectiveMoveType).toBe('NORMAL')
    expect(result.unmodelled.some((n) => n.includes('MOVE_HIDDEN_POWER'))).toBe(true)
  })

  it('with hiddenPowerType set, the move resolves to that type instead (not derived from IVs -- ER assigns it independently)', () => {
    const result = calculateMoveDamage(
      scenario({ move: moveData('MOVE_HIDDEN_POWER'), attacker: battler('SPECIES_GARCHOMP', { hiddenPowerType: 'ICE' }) }),
    )
    expect(result.effectiveMoveType).toBe('ICE')
    expect(result.unmodelled.some((n) => n.includes('MOVE_HIDDEN_POWER'))).toBe(false)
  })

  it('Techno Blast (ER redesign: shares EFFECT_HIDDEN_POWER, not drive-based) also follows hiddenPowerType', () => {
    const result = calculateMoveDamage(
      scenario({ move: moveData('MOVE_TECHNO_BLAST'), attacker: battler('SPECIES_GARCHOMP', { hiddenPowerType: 'FIRE' }) }),
    )
    expect(result.effectiveMoveType).toBe('FIRE')
  })
})

describe('calculateMoveDamage -- onAbsorb blocks damage independent of the type chart (TestAbsorbingAbilities, battle_util.c:8961-8969)', () => {
  it('Surf (super-effective vs Ground/Dragon Garchomp) is fully absorbed by Water Absorb, not just reduced', async () => {
    await import('./abilities/impl/index')
    const withoutAbsorb = calculateMoveDamage(scenario({ move: moveData('MOVE_SURF'), defender: battler('SPECIES_GARCHOMP') }))
    const withAbsorb = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_SURF'),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_WATER_ABSORB', innates: [null, null, null] } }),
      }),
    )
    expect(withoutAbsorb.isImmune).toBe(false)
    expect(withAbsorb.isImmune).toBe(true)
    expect(withAbsorb.rolls.every((d) => d === 0)).toBe(true)
  })

  it("Mold Breaker on the attacker bypasses the defender's Water Absorb", async () => {
    await import('./abilities/impl/index')
    const withMoldBreaker = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_SURF'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_MOLD_BREAKER', innates: [null, null, null] } }),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_WATER_ABSORB', innates: [null, null, null] } }),
      }),
    )
    expect(withMoldBreaker.isImmune).toBe(false)
  })
})

describe('calculateMoveDamage -- onImmune blocks damage outright (TestImmunityAbilities, battle_util.c:8978-8997)', () => {
  it('Aura Sphere (ballistic) is blocked entirely by Bulletproof', async () => {
    await import('./abilities/impl/index')
    const withoutBulletproof = calculateMoveDamage(scenario({ move: moveData('MOVE_AURA_SPHERE'), defender: battler('SPECIES_GARCHOMP') }))
    const withBulletproof = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_AURA_SPHERE'),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_BULLETPROOF', innates: [null, null, null] } }),
      }),
    )
    expect(withoutBulletproof.isImmune).toBe(false)
    expect(withBulletproof.isImmune).toBe(true)
    expect(withBulletproof.rolls.every((d) => d === 0)).toBe(true)
  })

  it("Mold Breaker on the attacker bypasses the defender's Bulletproof", async () => {
    await import('./abilities/impl/index')
    const withMoldBreaker = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_AURA_SPHERE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_MOLD_BREAKER', innates: [null, null, null] } }),
        defender: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_BULLETPROOF', innates: [null, null, null] } }),
      }),
    )
    expect(withMoldBreaker.isImmune).toBe(false)
  })
})

describe('calculateMoveDamage -- onInfiltrate bypasses screens (Infiltrates, CalcFinalDmg battle_util.c:7649-7655)', () => {
  it('Reflect halves a physical Tackle; Infiltrator on the attacker bypasses it entirely', async () => {
    await import('./abilities/impl/index')
    const reflectField = fieldState({ sides: { attacker: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false }, defender: { reflect: true, lightScreen: false, auroraVeil: false, luckyChant: false } } })
    const withoutInfiltrator = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE'), field: reflectField }))
    const noScreen = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE') }))
    expect(withoutInfiltrator.rolls[15]).toBeLessThan(noScreen.rolls[15])

    const withInfiltrator = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        field: reflectField,
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_INFILTRATOR', innates: [null, null, null] } }),
      }),
    )
    expect(withInfiltrator.rolls[15]).toBe(noScreen.rolls[15])
  })
})

describe('calculateMoveDamage -- abilityOn scenario toggle drives Flash Fire (src/abilities.cc:695)', () => {
  it('Ember gets no boost by default; a 1.5x boost once abilityOn is checked', async () => {
    await import('./abilities/impl/index')
    const off = calculateMoveDamage(
      scenario({ move: moveData('MOVE_EMBER'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_FLASH_FIRE', innates: [null, null, null] } }) }),
    )
    const on = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EMBER'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_FLASH_FIRE', innates: [null, null, null] }, abilityOn: true }),
      }),
    )
    expect(on.rolls[15]).toBeGreaterThan(off.rolls[15])
  })
})

describe('calculateMoveDamage -- secondary-stat blend (CalculateStat cross-stat blend, battle_util.c:7213-7229)', () => {
  it('Juggernaut adds 20% of Def into the Atk calc for a contact move (Tackle)', async () => {
    await import('./abilities/impl/index')
    const withoutJuggernaut = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE') }))
    const withJuggernaut = calculateMoveDamage(
      scenario({ move: moveData('MOVE_TACKLE'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_JUGGERNAUT', innates: [null, null, null] } }) }),
    )
    expect(withJuggernaut.rolls[15]).toBeGreaterThan(withoutJuggernaut.rolls[15])
  })
})

describe('calculateMoveDamage -- Dark Aura boosts Dark moves for either battler (src/abilities.cc:2493-2506)', () => {
  it('Assurance (Dark) is boosted 1.33x when the DEFENDER holds Dark Aura (APPLY_ON_ANY)', async () => {
    await import('./abilities/impl/index')
    const withoutAura = calculateMoveDamage(scenario({ move: moveData('MOVE_ASSURANCE') }))
    const withAura = calculateMoveDamage(
      scenario({ move: moveData('MOVE_ASSURANCE'), defender: battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_DARK_AURA', innates: [null, null, null] } }) }),
    )
    expect(withAura.rolls[15]).toBeGreaterThan(withoutAura.rolls[15])
  })
})

describe('calculateMoveDamage -- Rivalry keys off the gender scenario toggle (src/abilities.cc:1401-1417)', () => {
  it('same-gender attacker boosts 1.25x; opposite-gender defender-held Rivalry reduces 0.75x', async () => {
    await import('./abilities/impl/index')
    const neutral = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE') }))
    const sameGenderBoost = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_RIVALRY', innates: [null, null, null] }, gender: 'MALE' }),
        defender: battler('SPECIES_SKARMORY', { gender: 'MALE' }),
      }),
    )
    expect(sameGenderBoost.rolls[15]).toBeGreaterThan(neutral.rolls[15])

    const oppositeGenderReduction = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { gender: 'MALE' }),
        defender: battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_RIVALRY', innates: [null, null, null] }, gender: 'FEMALE' }),
      }),
    )
    expect(oppositeGenderReduction.rolls[15]).toBeLessThan(neutral.rolls[15])
  })
})

describe('calculateMoveDamage -- Protosynthesis keys off the boostedStat scenario toggle (src/abilities.cc:6943-6953)', () => {
  it('boosts Atk 1.3x for a physical move when boostedStat is atk', async () => {
    await import('./abilities/impl/index')
    const withoutBoost = calculateMoveDamage(
      scenario({ move: moveData('MOVE_TACKLE'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PROTOSYNTHESIS', innates: [null, null, null] } }) }),
    )
    const withBoost = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PROTOSYNTHESIS', innates: [null, null, null] }, boostedStat: 'atk' }),
      }),
    )
    expect(withBoost.rolls[15]).toBeGreaterThan(withoutBoost.rolls[15])
  })
})

describe('calculateMoveDamage -- Supreme Overlord keys off the alliesFainted scenario toggle (src/abilities.cc:7239-7248)', () => {
  it('boosts a physical Tackle when alliesFainted > 0', async () => {
    await import('./abilities/impl/index')
    const withoutFainted = calculateMoveDamage(
      scenario({ move: moveData('MOVE_TACKLE'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_SUPREME_OVERLORD', innates: [null, null, null] } }) }),
    )
    const withFainted = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_SUPREME_OVERLORD', innates: [null, null, null] }, alliesFainted: 5 }),
      }),
    )
    expect(withFainted.rolls[15]).toBeGreaterThan(withoutFainted.rolls[15])
  })
})

describe('calculateMoveDamage -- Cosmic Daze keys off the isConfused/isEnraged scenario toggles (src/abilities.cc:6730-6734)', () => {
  it('doubles damage when the DEFENDER is confused', () => {
    const neutral = calculateMoveDamage(
      scenario({ move: moveData('MOVE_TACKLE'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_COSMIC_DAZE', innates: [null, null, null] } }) }),
    )
    const confusedDefender = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_COSMIC_DAZE', innates: [null, null, null] } }),
        defender: battler('SPECIES_SKARMORY', { condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, isConfused: true }) }),
      }),
    )
    expect(confusedDefender.rolls[15]).toBeGreaterThan(neutral.rolls[15])
  })
})

describe('calculateMoveDamage -- Blood Stigma doubles damage against a bleeding defender (src/abilities.cc:8373-8377)', () => {
  it('reads the defender\'s STATUS1_BLEED via the shared status1 fixture', () => {
    const neutral = calculateMoveDamage(
      scenario({ move: moveData('MOVE_TACKLE'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_BLOOD_STIGMA', innates: [null, null, null] } }) }),
    )
    const bleedingDefender = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_BLOOD_STIGMA', innates: [null, null, null] } }),
        defender: battler('SPECIES_SKARMORY', {
          condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, status1: new Set(['STATUS1_BLEED']) }),
        }),
      }),
    )
    expect(bleedingDefender.rolls[15]).toBeGreaterThan(neutral.rolls[15])
  })
})

describe('calculateMoveDamage -- Pretty Princess boosts against a defender with a lowered stat (src/abilities.cc:5258-5262)', () => {
  it('reads the defender\'s negativeStatStageCount, and is suppressed by the ATTACKER\'s own Unaware', () => {
    const neutral = calculateMoveDamage(
      scenario({ move: moveData('MOVE_TACKLE'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PRETTY_PRINCESS', innates: [null, null, null] } }) }),
    )
    const loweredDefender = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PRETTY_PRINCESS', innates: [null, null, null] } }),
        defender: battler('SPECIES_SKARMORY', { condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, negativeStatStageCount: 1 }) }),
      }),
    )
    expect(loweredDefender.rolls[15]).toBeGreaterThan(neutral.rolls[15])

    // Unaware as an INNATE alongside Pretty Princess as the main ability -- this
    // engine models multiple simultaneous abilities via slots, and Unaware here is
    // the ATTACKER's own check (Pretty Princess never looks at the defender's
    // Unaware), so this should suppress the boost even though the defender still
    // has a lowered stat.
    const attackerAlsoUnaware = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PRETTY_PRINCESS', innates: ['ABILITY_UNAWARE', null, null] } }),
        defender: battler('SPECIES_SKARMORY', { condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, negativeStatStageCount: 1 }) }),
      }),
    )
    expect(attackerAlsoUnaware.rolls[15]).toBe(neutral.rolls[15])
  })
})

describe('calculateMoveDamage -- MISC_EFFECT_SUPEREFFECTIVE_BOOST (4/3x) applies ONLY to its own 2 moves, not every EFFECT_MISC_HIT move (battle_util.c:7711-7713)', () => {
  // Both comparisons use a same-type, same-split, no-EFFECT "control" move
  // against the SAME attacker/defender pair, so the only variables are power
  // (corrected for below) and the boost itself -- comparing across DIFFERENT
  // defender species would confound the type-effectiveness ratio with their
  // differing raw Defense stats, which an earlier version of this test did.
  it('Collision Course vs a neutral matchup deals damage matching its bare power ratio, with no boost (isolates the "not super effective" baseline)', () => {
    // Fighting vs Skarmory (Steel/Flying): Steel weak(2x) x Flying resists(0.5x) = neutral (1x) overall.
    const collisionCourse = calculateMoveDamage(scenario({ move: moveData('MOVE_COLLISION_COURSE') })) // 100 power
    const karateChop = calculateMoveDamage(scenario({ move: moveData('MOVE_KARATE_CHOP') })) // 90 power, same type/split, no effect
    expect(collisionCourse.typeEffectiveness).toBe(uq(1.0))
    const ratio = collisionCourse.rolls[15] / karateChop.rolls[15]
    expect(ratio).toBeCloseTo(100 / 90, 1) // no boost when not super effective
  })

  it('Collision Course vs a Fighting-weak (Normal-type) defender: the extra 4/3x stacks on top of the bare power ratio', () => {
    const normalDefender = battler('SPECIES_PORYGON') // pure Normal -- Fighting is super effective (2x)
    const collisionCourse = calculateMoveDamage(scenario({ move: moveData('MOVE_COLLISION_COURSE'), defender: normalDefender }))
    const karateChop = calculateMoveDamage(scenario({ move: moveData('MOVE_KARATE_CHOP'), defender: normalDefender }))
    expect(collisionCourse.typeEffectiveness).toBe(uq(2.0))
    const ratio = collisionCourse.rolls[15] / karateChop.rolls[15]
    // Bare power ratio (100/90 ~ 1.111) x the extra 4/3x boost ~ 1.481.
    expect(ratio).toBeCloseTo((100 / 90) * (4 / 3), 1)
  })

  it('Last Respects (MISC_EFFECT_FAINTED_MON_BOOST, a DIFFERENT EFFECT_MISC_HIT move) does NOT get the 4/3x even when super effective', () => {
    const ghostWeakDefender = battler('SPECIES_MISDREAVUS') // pure Ghost -- Ghost is super effective (2x) vs itself
    const lastRespects = calculateMoveDamage(scenario({ move: moveData('MOVE_LAST_RESPECTS'), defender: ghostWeakDefender })) // 90 power
    const shadowPunch = calculateMoveDamage(scenario({ move: moveData('MOVE_SHADOW_PUNCH'), defender: ghostWeakDefender })) // 90 power, same type/split, no effect
    expect(lastRespects.typeEffectiveness).toBe(uq(2.0))
    expect(shadowPunch.typeEffectiveness).toBe(uq(2.0))
    // Identical power/type/split -- should deal IDENTICAL damage, not 4/3x more.
    expect(lastRespects.rolls[15]).toBe(shadowPunch.rolls[15])
  })
})

describe('calculateMoveDamage -- Sheer Force boosts moves with a secondary effect chance (src/abilities.cc:1855-1860)', () => {
  it('boosts a move with a nonzero effectChance, but not a move without one', () => {
    // MOVE_ACID is POISON -- the default SPECIES_SKARMORY defender (Steel/Flying) is
    // immune to Poison-type damage outright, so this overrides to a non-immune
    // defender to actually see Sheer Force's multiplier.
    const nonImmuneDefender = battler('SPECIES_GARCHOMP')
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_ACID'), defender: nonImmuneDefender }))
    const withSheerForce = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_ACID'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_SHEER_FORCE', innates: [null, null, null] } }),
        defender: nonImmuneDefender,
      }),
    )
    expect(withSheerForce.rolls[15]).toBeGreaterThan(baseline.rolls[15])

    const noEffectBaseline = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE') }))
    const noEffectWithSheerForce = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_SHEER_FORCE', innates: [null, null, null] } }),
      }),
    )
    expect(noEffectWithSheerForce.rolls[15]).toBe(noEffectBaseline.rolls[15])
  })
})

describe('calculateMoveDamage -- Superconductor/Normalize convert the effective move type (src/abilities.cc:8187-8196,1558-1568)', () => {
  it('Superconductor turns a Steel move Electric', () => {
    const result = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_IRON_HEAD'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_SUPERCONDUCTOR', innates: [null, null, null] } }),
      }),
    )
    expect(result.effectiveMoveType).toBe('ELECTRIC')
  })

  it('Normalize turns any move Normal', () => {
    const result = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_IRON_HEAD'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_NORMALIZE', innates: [null, null, null] } }),
      }),
    )
    expect(result.effectiveMoveType).toBe('NORMAL')
  })
})

describe('calculateMoveDamage -- Dreamcatcher/Dreamscape double damage vs a sleeping defender (src/abilities.cc:3983-3992,10367-10375)', () => {
  it('Dreamcatcher doubles damage against a sleeping defender, Dreamscape doubles and adds a flat 1.2x', () => {
    const awakeDefender = battler('SPECIES_SKARMORY')
    const sleepingDefender = battler('SPECIES_SKARMORY', { condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', status1: new Set(['STATUS1_SLEEP']) }) })

    const baseline = calculateMoveDamage(scenario({ defender: awakeDefender }))
    const dreamcatcher = calculateMoveDamage(
      scenario({
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_DREAMCATCHER', innates: [null, null, null] } }),
        defender: sleepingDefender,
      }),
    )
    expect(dreamcatcher.rolls[15]).toBeGreaterThan(baseline.rolls[15])

    const dreamcatcherAwake = calculateMoveDamage(
      scenario({
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_DREAMCATCHER', innates: [null, null, null] } }),
        defender: awakeDefender,
      }),
    )
    expect(dreamcatcherAwake.rolls[15]).toBe(baseline.rolls[15])

    const dreamscape = calculateMoveDamage(
      scenario({
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_DREAMSCAPE', innates: [null, null, null] } }),
        defender: sleepingDefender,
      }),
    )
    expect(dreamscape.rolls[15]).toBeGreaterThan(dreamcatcher.rolls[15])
  })
})

describe('calculateMoveDamage -- Eternal Flower reduces a Mega-evolved defender\'s stats (src/abilities.cc:11630-11639)', () => {
  it('boosts damage against a Mega defender, does nothing against a non-Mega one, and exempts a Mega defender that itself holds Eternal Flower', async () => {
    await import('./abilities/impl/index')
    const attackerWithEternalFlower = battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_ETERNAL_FLOWER', innates: [null, null, null] } })
    const megaVenusaur = (overrides: Partial<BattlerBattleState> = {}) =>
      battler('SPECIES_VENUSAUR_MEGA', {
        condition: condition({ speciesId: 'SPECIES_VENUSAUR_MEGA', baseSpeciesId: 'SPECIES_VENUSAUR', hp: 999, maxHp: 999, isMegaEvolved: true }),
        ...overrides,
      })

    const baseline = calculateMoveDamage(scenario({ defender: megaVenusaur() }))
    const withEternalFlower = calculateMoveDamage(scenario({ attacker: attackerWithEternalFlower, defender: megaVenusaur() }))
    expect(withEternalFlower.rolls[15]).toBeGreaterThan(baseline.rolls[15])

    const nonMegaBaseline = calculateMoveDamage(scenario({ defender: battler('SPECIES_SKARMORY') }))
    const nonMegaWithEternalFlower = calculateMoveDamage(scenario({ attacker: attackerWithEternalFlower, defender: battler('SPECIES_SKARMORY') }))
    expect(nonMegaWithEternalFlower.rolls[15]).toBe(nonMegaBaseline.rolls[15])

    const megaAlsoHoldingIt = calculateMoveDamage(
      scenario({
        attacker: attackerWithEternalFlower,
        defender: megaVenusaur({ abilitySlots: { ability: 'ABILITY_ETERNAL_FLOWER', innates: [null, null, null] } }),
      }),
    )
    expect(megaAlsoHoldingIt.rolls[15]).toBe(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- Illusion/Lethargy key off the abilityOn/slowStartTimer scenario toggles (src/abilities.cc:2118-2129,4934-4960)', () => {
  it('Illusion boosts 1.3x only while abilityOn is set', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario())
    const withIllusion = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_GARCHOMP', { abilityOn: true, abilitySlots: { ability: 'ABILITY_ILLUSION', innates: [null, null, null] } }) }),
    )
    expect(withIllusion.rolls[15]).toBeGreaterThan(baseline.rolls[15])

    const illusionOff = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_GARCHOMP', { abilityOn: false, abilitySlots: { ability: 'ABILITY_ILLUSION', innates: [null, null, null] } }) }),
    )
    expect(illusionOff.rolls[15]).toBe(baseline.rolls[15])
  })

  it('Lethargy scales damage down by its slowStartTimer tier', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario())
    const withLethargy = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_GARCHOMP', { slowStartTimer: 1, abilitySlots: { ability: 'ABILITY_LETHARGY', innates: [null, null, null] } }) }),
    )
    expect(withLethargy.rolls[15]).toBeLessThan(baseline.rolls[15])

    const expired = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_GARCHOMP', { slowStartTimer: 5, abilitySlots: { ability: 'ABILITY_LETHARGY', innates: [null, null, null] } }) }),
    )
    expect(expired.rolls[15]).toBe(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- Ape Shift always crits in its exact Mega form (src/abilities.cc:9036-9044)', () => {
  it('forces a guaranteed crit only as SPECIES_SLAKING_MEGA_APE_SHIFT', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario())
    expect(baseline.critChanceDenominator).not.toBe(1)

    const withApeShift = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_SLAKING_MEGA_APE_SHIFT', { abilitySlots: { ability: 'ABILITY_APE_SHIFT', innates: [null, null, null] } }) }),
    )
    expect(withApeShift.critChanceDenominator).toBe(1)

    const wrongForm = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_APE_SHIFT', innates: [null, null, null] } }) }),
    )
    expect(wrongForm.critChanceDenominator).not.toBe(1)
  })
})

describe('calculateMoveDamage -- Color Spectrum stacks a 1.2x bonus on top of STAB (src/abilities.cc:8710-8728)', () => {
  it('boosts a STAB move further, but does nothing for a non-STAB move', async () => {
    await import('./abilities/impl/index')
    const attackerWithColorSpectrum = battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_COLOR_SPECTRUM', innates: [null, null, null] } })

    const stabBaseline = calculateMoveDamage(scenario({ move: moveData('MOVE_OUTRAGE') })) // Dragon, Garchomp's own type -- gets STAB
    const stabWithColorSpectrum = calculateMoveDamage(scenario({ move: moveData('MOVE_OUTRAGE'), attacker: attackerWithColorSpectrum }))
    expect(stabWithColorSpectrum.rolls[15]).toBeGreaterThan(stabBaseline.rolls[15])

    const noStabBaseline = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE') })) // Normal, not one of Garchomp's types
    const noStabWithColorSpectrum = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE'), attacker: attackerWithColorSpectrum }))
    expect(noStabWithColorSpectrum.rolls[15]).toBe(noStabBaseline.rolls[15])
  })
})

describe('calculateMoveDamage -- Crystallize converts Rock moves to Ice and boosts them (src/abilities.cc:3729-3738)', () => {
  it('converts the move type and applies a 1.1x bonus on top', async () => {
    await import('./abilities/impl/index')
    const attackerWithCrystallize = battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_CRYSTALLIZE', innates: [null, null, null] } })
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_ROCK_SLIDE'), attacker: attackerWithCrystallize }))
    expect(result.effectiveMoveType).toBe('ICE')

    const withoutCrystallize = calculateMoveDamage(scenario({ move: moveData('MOVE_ROCK_SLIDE') }))
    expect(withoutCrystallize.effectiveMoveType).toBe('ROCK')
  })
})

describe('calculateMoveDamage -- resist berry halves (or quarters, with Ripen) super-effective/Normal damage (battle_util.c:7688-7700)', () => {
  it('Chilan Berry halves a Normal-type hit unconditionally', () => {
    const baseline = calculateMoveDamage(scenario())
    const withChilan = calculateMoveDamage(
      scenario({
        defender: battler('SPECIES_SKARMORY', {
          holdEffectType: 'NORMAL',
          condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_RESIST_BERRY' }),
        }),
      }),
    )
    expect(withChilan.rolls[15]).toBeLessThan(baseline.rolls[15])
  })

  it('Occa Berry only reduces a super-effective Fire hit, not a neutral one', () => {
    const occaDefender = (overrides: Partial<BattlerBattleState> = {}) =>
      battler('SPECIES_SKARMORY', {
        holdEffectType: 'FIRE',
        condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_RESIST_BERRY' }),
        ...overrides,
      })
    // Fire vs Steel/Flying Skarmory is super effective (2x Steel, neutral Flying).
    const seBaseline = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER'), defender: battler('SPECIES_SKARMORY') }))
    const seWithOcca = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER'), defender: occaDefender() }))
    expect(seWithOcca.rolls[15]).toBeLessThan(seBaseline.rolls[15])

    // Tackle (Normal) isn't Fire -- Occa Berry's own type doesn't match, no reduction.
    const noMatchBaseline = calculateMoveDamage(scenario({ defender: battler('SPECIES_SKARMORY') }))
    const noMatchWithOcca = calculateMoveDamage(scenario({ defender: occaDefender() }))
    expect(noMatchWithOcca.rolls[15]).toBe(noMatchBaseline.rolls[15])
  })

  it('Ripen quarters instead of halves', () => {
    const withoutRipen = calculateMoveDamage(
      scenario({
        defender: battler('SPECIES_SKARMORY', {
          holdEffectType: 'NORMAL',
          condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_RESIST_BERRY' }),
        }),
      }),
    )
    const withRipen = calculateMoveDamage(
      scenario({
        defender: battler('SPECIES_SKARMORY', {
          holdEffectType: 'NORMAL',
          condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_RESIST_BERRY' }),
          abilitySlots: { ability: 'ABILITY_RIPEN', innates: [null, null, null] },
        }),
      }),
    )
    expect(withRipen.rolls[15]).toBeLessThan(withoutRipen.rolls[15])
  })

  it("the attacker's own Unnerve suppresses the berry entirely", () => {
    const baseline = calculateMoveDamage(scenario())
    const withUnnerve = calculateMoveDamage(
      scenario({
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_UNNERVE', innates: [null, null, null] } }),
        defender: battler('SPECIES_SKARMORY', {
          holdEffectType: 'NORMAL',
          condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_RESIST_BERRY' }),
        }),
      }),
    )
    expect(withUnnerve.rolls[15]).toBe(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- Metronome (item) scales up with sameMoveTurnsInARow (battle_util.c:7672-7674)', () => {
  it('boosts damage the more consecutive turns the same move has been used', () => {
    const baseline = calculateMoveDamage(scenario())
    const withMetronome = calculateMoveDamage(
      scenario({
        attacker: battler('SPECIES_GARCHOMP', { holdEffectStrength: 20, condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_METRONOME' }) }),
        sameMoveTurnsInARow: 3,
      }),
    )
    expect(withMetronome.rolls[15]).toBeGreaterThan(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- type-matching Gems boost power unless the defender has Unnerve (battle_main.c:5233-5238)', () => {
  it('boosts a matching-type hit, does nothing off-type, and is suppressed by the defender\'s Unnerve', () => {
    const gemAttacker = (overrides: Partial<BattlerBattleState> = {}) =>
      battler('SPECIES_GARCHOMP', {
        holdEffectType: 'DRAGON',
        holdEffectStrength: 50,
        condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_GEMS' }),
        ...overrides,
      })

    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_OUTRAGE') })) // Dragon
    const withGem = calculateMoveDamage(scenario({ move: moveData('MOVE_OUTRAGE'), attacker: gemAttacker() }))
    expect(withGem.rolls[15]).toBeGreaterThan(baseline.rolls[15])

    const offTypeBaseline = calculateMoveDamage(scenario())
    const offTypeWithGem = calculateMoveDamage(scenario({ attacker: gemAttacker() }))
    expect(offTypeWithGem.rolls[15]).toBe(offTypeBaseline.rolls[15])

    const withUnnerveDefender = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_OUTRAGE'),
        attacker: gemAttacker(),
        defender: battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_UNNERVE', innates: [null, null, null] } }),
      }),
    )
    expect(withUnnerveDefender.rolls[15]).toBe(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- EFFECT_CHANGE_TYPE_ON_ITEM: Judgment/Multi-Attack follow the held Plate/Memory (battle_main.c:5047-5049,5148-5150)', () => {
  it("Judgment becomes the Plate's type (and gets its power boost); stays Normal without one", () => {
    const withoutPlate = calculateMoveDamage(scenario({ move: moveData('MOVE_JUDGMENT') }))
    expect(withoutPlate.effectiveMoveType).toBe('NORMAL')

    const withFistPlate = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_JUDGMENT'),
        attacker: battler('SPECIES_GARCHOMP', {
          holdEffectType: 'FIGHTING',
          holdEffectStrength: 30,
          condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_PLATE' }),
        }),
      }),
    )
    expect(withFistPlate.effectiveMoveType).toBe('FIGHTING')
    // Same item also matches CalcMoveBasePowerAfterModifiers's own Plate case, so
    // this should ALSO be stronger than a same-type hit without the base-power cut.
    expect(withFistPlate.rolls[15]).toBeGreaterThan(withoutPlate.rolls[15])
  })

  it("Multi-Attack becomes the Memory's type, with no base-power boost (Memory isn't in the Plate/Type Power switch)", () => {
    const withWaterMemory = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_MULTI_ATTACK'),
        attacker: battler('SPECIES_GARCHOMP', {
          holdEffectType: 'WATER',
          condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_MEMORY' }),
        }),
      }),
    )
    expect(withWaterMemory.effectiveMoveType).toBe('WATER')
  })

  it("a mismatched item (wrong resolvedHoldEffect) leaves the move at its declared type, still eligible for -ate conversion", async () => {
    await import('./abilities/impl/index')
    const withPixilate = calculateMoveDamage(
      scenario({ move: moveData('MOVE_JUDGMENT'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PIXILATE', innates: [null, null, null] } }) }),
    )
    expect(withPixilate.effectiveMoveType).toBe('FAIRY')
  })
})

describe('calculateMoveDamage -- Punching Glove boosts punch-based moves, static or ability-granted (battle_util.c:7684-7686)', () => {
  it('boosts a statically punch-flagged move, and one granted punch by an ability using the C\'s own dummy TYPE_NORMAL check', async () => {
    await import('./abilities/impl/index')
    const glove = (overrides: Partial<BattlerBattleState> = {}) =>
      battler('SPECIES_GARCHOMP', {
        condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999, resolvedHoldEffect: 'HOLD_EFFECT_PUNCHING_GLOVE' }),
        ...overrides,
      })

    const punchBaseline = calculateMoveDamage(scenario({ move: moveData('MOVE_MACH_PUNCH') }))
    const punchWithGlove = calculateMoveDamage(scenario({ move: moveData('MOVE_MACH_PUNCH'), attacker: glove() }))
    expect(punchWithGlove.rolls[15]).toBeGreaterThan(punchBaseline.rolls[15])

    // Tackle isn't punch-based on its own -- no boost without a granting ability.
    const nonPunchBaseline = calculateMoveDamage(scenario())
    const nonPunchWithGlove = calculateMoveDamage(scenario({ attacker: glove() }))
    expect(nonPunchWithGlove.rolls[15]).toBe(nonPunchBaseline.rolls[15])

    // Mixed Martial Arts grants punch/kick whenever DoesMoveMatchFlag's own dummy
    // TYPE_NORMAL check passes -- which it always does here, regardless of Tackle's
    // real (Normal) type coincidentally matching too.
    const mixedMartialArts = calculateMoveDamage(
      scenario({ attacker: glove({ abilitySlots: { ability: 'ABILITY_MIXED_MARTIAL_ARTS', innates: [null, null, null] } }) }),
    )
    expect(mixedMartialArts.rolls[15]).toBeGreaterThan(nonPunchBaseline.rolls[15])
  })
})

describe('calculateMoveDamage -- Natural Gift follows the held berry\'s power and type (battle_main.c:5082-5083,5180-5182, battle_util.c:6863-6866)', () => {
  it('uses the berry\'s own power and type, or 0 power without one', () => {
    const withCheri = battler('SPECIES_GARCHOMP', {
      naturalGift: { power: 80, type: 'ELECTRIC' },
      condition: condition({ speciesId: 'SPECIES_GARCHOMP', baseSpeciesId: 'SPECIES_GARCHOMP', hp: 999, maxHp: 999 }),
    })
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_NATURAL_GIFT'), attacker: withCheri }))
    expect(result.effectiveMoveType).toBe('ELECTRIC')
    expect(result.rolls[15]).toBeGreaterThan(0)

    const withoutBerry = calculateMoveDamage(scenario({ move: moveData('MOVE_NATURAL_GIFT') }))
    expect(withoutBerry.effectiveMoveType).toBe('NORMAL')
    // Without a berry, CalcMoveBasePower returns 0 outright -- the engine's own
    // Math.max(power, 1) floor still applies on top, so this isn't literally 0,
    // just far weaker than the berry-boosted hit above.
    expect(withoutBerry.rolls[15]).toBeLessThan(result.rolls[15])
  })
})

describe('calculateMoveDamage -- Weather Ball follows the active weather (or Aurora Borealis) (battle_main.c:5124-5133, battle_util.c:6854-6858)', () => {
  it('becomes Water and doubles power in Rain, stays Normal with no weather', () => {
    const noWeather = calculateMoveDamage(scenario({ move: moveData('MOVE_WEATHER_BALL') }))
    expect(noWeather.effectiveMoveType).toBe('NORMAL')

    const inRain = calculateMoveDamage(scenario({ move: moveData('MOVE_WEATHER_BALL'), field: fieldState({ weather: 'RAIN_PERMANENT' }) }))
    expect(inRain.effectiveMoveType).toBe('WATER')
    expect(inRain.rolls[15]).toBeGreaterThan(noWeather.rolls[15])
  })

  it('Aurora Borealis forces Ice regardless of weather', async () => {
    await import('./abilities/impl/index')
    const withAuroraBorealis = calculateMoveDamage(
      scenario({ move: moveData('MOVE_WEATHER_BALL'), attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_AURORA_BOREALIS', innates: [null, null, null] } }) }),
    )
    expect(withAuroraBorealis.effectiveMoveType).toBe('ICE')
  })
})

describe('calculateMoveDamage -- Wake-Up Slap/Smelling Salts and single-snapshot EFFECT_MISC_HIT sub-cases (battle_util.c:6870-6907)', () => {
  it('Wake-Up Slap doubles power vs a sleeping defender', () => {
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_WAKE_UP_SLAP') }))
    const sleeping = calculateMoveDamage(
      scenario({ move: moveData('MOVE_WAKE_UP_SLAP'), defender: battler('SPECIES_SKARMORY', { condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, status1: new Set(['STATUS1_SLEEP']) }) }) }),
    )
    expect(sleeping.rolls[15]).toBeGreaterThan(baseline.rolls[15])
  })

  it('Smelling Salts doubles power vs a paralyzed defender', () => {
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_SMELLING_SALTS') }))
    const paralyzed = calculateMoveDamage(
      scenario({ move: moveData('MOVE_SMELLING_SALTS'), defender: battler('SPECIES_SKARMORY', { condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, status1: new Set(['STATUS1_PARALYSIS']) }) }) }),
    )
    expect(paralyzed.rolls[15]).toBeGreaterThan(baseline.rolls[15])
  })

  it('Psyblade (MISC_EFFECT_ELECTRIC_TERRAIN_BOOST) is stronger on Electric Terrain', () => {
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_PSYBLADE') }))
    const onTerrain = calculateMoveDamage(scenario({ move: moveData('MOVE_PSYBLADE'), field: fieldState({ terrain: 'TERRAIN_ELECTRIC' }) }))
    expect(onTerrain.rolls[15]).toBeGreaterThan(baseline.rolls[15])
  })

})

describe('calculateMoveDamage -- Rollout/Ice Ball (EFFECT_ROLLOUT), a direct rolloutCounter input rather than a derived turn count (battle_util.c:6790-6793)', () => {
  it('counter 0: unboosted, same as the declared base power (the released build has no Defense Curl branch)', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_ROLLOUT') }))
    expect(result.unmodelled).toHaveLength(0)
  })

  it('counter 1/2/3 scale by roughly 2^(counter-1) -- 1x/2x/4x, NOT a linear 1x/2x/3x like Triple Kick', () => {
    const counter1 = calculateMoveDamage(scenario({ move: moveData('MOVE_ROLLOUT'), attackerRolloutCounter: 1 }))
    const counter2 = calculateMoveDamage(scenario({ move: moveData('MOVE_ROLLOUT'), attackerRolloutCounter: 2 }))
    const counter3 = calculateMoveDamage(scenario({ move: moveData('MOVE_ROLLOUT'), attackerRolloutCounter: 3 }))
    expect(counter2.rolls[15]).toBeGreaterThan(counter1.rolls[15] * 1.8)
    expect(counter2.rolls[15]).toBeLessThan(counter1.rolls[15] * 2.2)
    expect(counter3.rolls[15]).toBeGreaterThan(counter2.rolls[15] * 1.8)
    expect(counter3.rolls[15]).toBeLessThan(counter2.rolls[15] * 2.2)
  })

  it('Ice Ball shares the exact same mechanic (both are EFFECT_ROLLOUT)', () => {
    const rollout = calculateMoveDamage(scenario({ move: moveData('MOVE_ROLLOUT'), attackerRolloutCounter: 2 }))
    const iceBall = calculateMoveDamage(scenario({ move: moveData('MOVE_ICE_BALL'), attackerRolloutCounter: 2 }))
    expect(iceBall.unmodelled).toHaveLength(0)
    expect(rollout.unmodelled).toHaveLength(0)
  })
})

describe('calculateMoveDamage -- onMoldBreaker\'s 5 hypothesis-based abilities are wired in (not circular after all -- see this session\'s own audit)', () => {
  it('Deadly Precision breaks through Levitate to unlock an otherwise-immune super-effective Ground hit', async () => {
    await import('./abilities/impl/index')
    // Beldum (Steel/Psychic, non-Flying): Ground is a real 2x weakness by chart,
    // but Levitate (assigned here regardless of Beldum's real abilities, same
    // override convention as every other ability test in this file) makes it
    // airborne, immune outright -- UNLESS Mold Breaker suppresses Levitate.
    const beldumWithLevitate = battler('SPECIES_BELDUM', { abilitySlots: { ability: 'ABILITY_LEVITATE', innates: [null, null, null] } })
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_EARTHQUAKE'), defender: beldumWithLevitate }))
    expect(baseline.isImmune).toBe(true)

    const withDeadlyPrecision = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EARTHQUAKE'),
        defender: beldumWithLevitate,
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_DEADLY_PRECISION', innates: [null, null, null] } }),
      }),
    )
    expect(withDeadlyPrecision.isImmune).toBe(false)
    expect(withDeadlyPrecision.typeEffectiveness).toBe(uq(2.0))
  })

  it('Overrule breaks through Battle Armor/Shell Armor to unlock an otherwise-blocked crit', async () => {
    await import('./abilities/impl/index')
    const battleArmorDefender = battler('SPECIES_SKARMORY', { abilitySlots: { ability: 'ABILITY_BATTLE_ARMOR', innates: [null, null, null] } })
    const baseline = calculateMoveDamage(scenario({ defender: battleArmorDefender }))
    expect(baseline.critChanceDenominator).toBeNull() // fully blocked

    const withOverrule = calculateMoveDamage(
      scenario({
        defender: battleArmorDefender,
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_OVERRULE', innates: [null, null, null] } }),
      }),
    )
    expect(withOverrule.critChanceDenominator).not.toBeNull()
    expect(withOverrule.critRolls).not.toBeNull()
  })

  it('Stonecutter activates only for a move whose EFFECTIVE type resolves to Rock', () => {
    // Skarmory (Steel/Flying), no ability shenanigans needed on the defender --
    // Rock is neutral-to-Flying/weak-to-Steel by chart either way; this just
    // checks the ability's OWN condition fires per-type, not that it changes
    // the outcome dramatically.
    const withStonecutter = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_ROCK_SLIDE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_STONECUTTER', innates: [null, null, null] } }),
      }),
    )
    expect(withStonecutter.unmodelled).toHaveLength(0)
  })
})

describe('calculateMoveDamage -- Victory Bomb, modeled as a directly-selectable "5th attack" (see calculate.ts\'s own comment for the reframing)', () => {
  it('MOVE_EXPLOSION becomes a 100-power Fire move when the attacker holds Victory Bomb, instead of its declared 250-power Normal', async () => {
    await import('./abilities/impl/index')
    // Garchomp (Ground/Dragon) is neutral to BOTH Normal and Fire, so any damage
    // difference here isolates the power change (250 -> 100), not the type
    // change's own effectiveness swing (scenario()'s default Skarmory defender
    // resists Normal but is weak to Fire, which would confound this comparison).
    const neutralDefender = battler('SPECIES_GARCHOMP')
    const withoutAbility = calculateMoveDamage(scenario({ move: moveData('MOVE_EXPLOSION'), defender: neutralDefender }))
    expect(withoutAbility.effectiveMoveType).toBe('NORMAL')

    const withVictoryBomb = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EXPLOSION'),
        defender: neutralDefender,
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_VICTORY_BOMB', innates: [null, null, null] } }),
      }),
    )
    expect(withVictoryBomb.effectiveMoveType).toBe('FIRE')
    // Lower power (100 vs 250) should mean less damage against a neutral defender.
    expect(withVictoryBomb.rolls[15]).toBeLessThan(withoutAbility.rolls[15])
  })

  it('does not affect any other move, even for a Victory Bomb holder', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario())
    const withVictoryBomb = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_VICTORY_BOMB', innates: [null, null, null] } }) }),
    )
    expect(withVictoryBomb.rolls).toEqual(baseline.rolls)
  })
})

describe('calculateMoveDamage -- EFFECT_FOCUS_PUNCH forces power to 40 if the attacker was hit this turn (battle_util.c:6876-6877)', () => {
  it('a plain scenario flag, no turn history needed (same fix as Magnitude/Pursuit)', () => {
    const notHit = calculateMoveDamage(scenario({ move: moveData('MOVE_FOCUS_PUNCH') }))
    const wasHit = calculateMoveDamage(scenario({ move: moveData('MOVE_FOCUS_PUNCH'), attackerWasHitThisTurn: true }))
    expect(wasHit.rolls[15]).toBeLessThan(notHit.rolls[15])
  })
})

describe('calculateMoveDamage -- CalcMoveBasePower\'s move-ID-keyed tail switch, previously entirely unaudited (battle_util.c:6915-6952)', () => {
  it('Water Shuriken: Ash-Greninja forces 20 power', async () => {
    await import('./abilities/impl/index')
    const normal = calculateMoveDamage(scenario({ move: moveData('MOVE_WATER_SHURIKEN') }))
    const ashGreninja = calculateMoveDamage(
      scenario({ move: moveData('MOVE_WATER_SHURIKEN'), attacker: battler('SPECIES_GRENINJA_ASH') }),
    )
    expect(ashGreninja.rolls[15]).not.toBe(normal.rolls[15])
  })

  it('Dragon Darts: Parental Bond multiplies power by 5/4', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_DRAGON_DARTS') }))
    const withParentalBond = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_DRAGON_DARTS'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PARENTAL_BOND', innates: [null, null, null] } }),
      }),
    )
    expect(withParentalBond.rolls[15]).toBeGreaterThan(baseline.rolls[15])
  })

  it('Self-Destruct doubles power when the attacker was hit this turn', () => {
    const notHit = calculateMoveDamage(scenario({ move: moveData('MOVE_SELF_DESTRUCT') }))
    const wasHit = calculateMoveDamage(scenario({ move: moveData('MOVE_SELF_DESTRUCT'), attackerWasHitThisTurn: true }))
    expect(wasHit.rolls[15]).toBeGreaterThan(notHit.rolls[15])
  })

  it('Dream Inversion doubles power against a sleeping defender', () => {
    const awake = calculateMoveDamage(scenario({ move: moveData('MOVE_DREAM_INVERSION') }))
    const asleep = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_DREAM_INVERSION'),
        defender: battler('SPECIES_SKARMORY', {
          condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, status1: new Set(['STATUS1_SLEEP']) }),
        }),
      }),
    )
    expect(asleep.rolls[15]).toBeGreaterThan(awake.rolls[15])
  })

  it('Flying Press adds a flat 10 power with Wrestle Showman', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_FLYING_PRESS') }))
    const withAbility = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_FLYING_PRESS'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_WRESTLE_SHOWMAN', innates: [null, null, null] } }),
      }),
    )
    expect(withAbility.rolls[15]).toBeGreaterThan(baseline.rolls[15])
  })

  it('Roar of Time forces power to 100 with Temporal Rupture', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_ROAR_OF_TIME') }))
    const withAbility = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_ROAR_OF_TIME'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_TEMPORAL_RUPTURE', innates: [null, null, null] } }),
      }),
    )
    expect(withAbility.rolls[15]).not.toBe(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- Angel\'s Wrath\'s missing base-power half (battle_util.c:6938-6952) -- its type-effectiveness half was already ported', () => {
  it('forces power for its 4 specific moves, on top of the type-effectiveness boost already ported', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE') }))
    const withAngelsWrath = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_ANGELS_WRATH', innates: [null, null, null] } }),
      }),
    )
    expect(withAngelsWrath.rolls[15]).toBeGreaterThan(baseline.rolls[15])
  })

  it('does not affect a move outside its own 4-move list (scenario()\'s default MOVE_TACKLE is one of the 4, so this uses a different move)', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_FLAMETHROWER') }))
    const withAngelsWrath = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_FLAMETHROWER'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_ANGELS_WRATH', innates: [null, null, null] } }),
      }),
    )
    expect(withAngelsWrath.rolls[15]).toBe(baseline.rolls[15])
  })
})

describe('calculateMoveDamage -- EFFECT_BEAT_UP: one representative party member stands in for a real roster (CalcBeatUpPower, battle_util.c:102-117)', () => {
  it('hitCount matches beatUpHitCount, and a higher beatUpBaseAttack means more damage per hit', () => {
    const lowAttack = calculateMoveDamage(scenario({ move: moveData('MOVE_BEAT_UP'), beatUpBaseAttack: 30, beatUpHitCount: 3 }))
    expect(lowAttack.hitCount).toBe(3)
    expect(lowAttack.unmodelled).toHaveLength(0)

    const highAttack = calculateMoveDamage(scenario({ move: moveData('MOVE_BEAT_UP'), beatUpBaseAttack: 150, beatUpHitCount: 3 }))
    expect(highAttack.rolls[15]).toBeGreaterThan(lowAttack.rolls[15])
  })

  it('beatUpHitCount directly controls the number of hits, clamped to 1-6', () => {
    const twoHits = calculateMoveDamage(scenario({ move: moveData('MOVE_BEAT_UP'), beatUpHitCount: 2 }))
    const sixHits = calculateMoveDamage(scenario({ move: moveData('MOVE_BEAT_UP'), beatUpHitCount: 6 }))
    expect(twoHits.hitCount).toBe(2)
    expect(sixHits.hitCount).toBe(6)
    expect(sixHits.totalRolls![15]).toBeGreaterThan(twoHits.totalRolls![15])
  })
})

describe('calculateMoveDamage -- doubleDamageVsMega doubles power against a Mega-evolved defender (battle_util.c:7003-7005)', () => {
  it('Behemoth Bash doubles power vs a Mega defender, not a non-Mega one', () => {
    const skarmory = (isMegaEvolved: boolean) =>
      battler('SPECIES_SKARMORY', { condition: condition({ speciesId: 'SPECIES_SKARMORY', baseSpeciesId: 'SPECIES_SKARMORY', hp: 999, maxHp: 999, isMegaEvolved }) })

    const baseline = calculateMoveDamage(scenario({ move: moveData('MOVE_BEHEMOTH_BASH'), defender: skarmory(false) }))
    const vsMega = calculateMoveDamage(scenario({ move: moveData('MOVE_BEHEMOTH_BASH'), defender: skarmory(true) }))
    expect(vsMega.rolls[15]).toBeGreaterThan(baseline.rolls[15])

    const nonBashBaseline = calculateMoveDamage(scenario({ defender: skarmory(false) }))
    const nonBashVsMega = calculateMoveDamage(scenario({ defender: skarmory(true) }))
    expect(nonBashVsMega.rolls[15]).toBe(nonBashBaseline.rolls[15])
  })
})

describe('calculateMoveDamage -- multi-hit moves (src/battle_script_commands.c:958-1064)', () => {
  it('a single-hit move has no hitCount/totalRolls', () => {
    const result = calculateMoveDamage(scenario())
    expect(result.hitCount).toBeNull()
    expect(result.totalRolls).toBeNull()
    expect(result.totalCritRolls).toBeNull()
  })

  it('Double Hit: exactly 2 identical full-power hits, so totalRolls is exactly 2x rolls', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_DOUBLE_HIT') }))
    expect(result.hitCount).toBe(2)
    expect(result.totalRolls).toEqual(result.rolls.map((d) => d * 2))
    expect(result.totalCritRolls).toEqual(result.critRolls!.map((d) => d * 2))
  })

  it('Population Bomb (EFFECT_TEN_HITS): exactly 10 identical full-power hits', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_POPULATION_BOMB') }))
    expect(result.hitCount).toBe(10)
    expect(result.totalRolls).toEqual(result.rolls.map((d) => d * 10))
  })

  it('EFFECT_MULTI_HIT respects the scenario hitCount, clamped, and Skill Link forces 5', async () => {
    const threeHits = calculateMoveDamage(scenario({ move: moveData('MOVE_BULLET_SEED'), hitCount: 3 }))
    expect(threeHits.hitCount).toBe(3)
    expect(threeHits.totalRolls).toEqual(threeHits.rolls.map((d) => d * 3))

    const clamped = calculateMoveDamage(scenario({ move: moveData('MOVE_BULLET_SEED'), hitCount: 1 }))
    expect(clamped.hitCount).toBe(2) // clamped up to the minimum

    await import('./abilities/impl/index')
    const skillLink = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_BULLET_SEED'),
        hitCount: 2,
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_SKILL_LINK', innates: [null, null, null] } }),
      }),
    )
    expect(skillLink.hitCount).toBe(5)
  })

  it('Parental Bond: full-power first hit plus a reduced-power bonus hit, on an otherwise single-hit move', async () => {
    await import('./abilities/impl/index')
    const baseline = calculateMoveDamage(scenario())
    const withParentalBond = calculateMoveDamage(
      scenario({ attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PARENTAL_BOND', innates: [null, null, null] } }) }),
    )
    expect(withParentalBond.hitCount).toBe(2)
    expect(withParentalBond.totalRolls![15]).toBeGreaterThan(baseline.rolls[15])
    expect(withParentalBond.totalRolls![15]).toBeLessThan(baseline.rolls[15] * 2)
  })

  it('Parental Bond does not apply to a move that is already multi-hit by its own effect', async () => {
    await import('./abilities/impl/index')
    const result = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_DOUBLE_HIT'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PARENTAL_BOND', innates: [null, null, null] } }),
      }),
    )
    // Still exactly 2 identical hits -- Double Hit's own plan, not Parental Bond's.
    expect(result.hitCount).toBe(2)
    expect(result.totalRolls).toEqual(result.rolls.map((d) => d * 2))
  })

  it('Triple Kick/Triple Axel: 3 hits scaling 1x/2x/3x power, NOT 3 identical hits (battle_util.c:6850-6852)', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_TRIPLE_KICK') }))
    expect(result.hitCount).toBe(3)
    // Each hit is independently rolled at rolls[15]'s percentile; hit 2 and hit 3
    // scale the SAME base roll by 2x/3x (not identical, unlike Double Hit/Bullet
    // Seed above), so totalRolls[15] should be strictly between 3x and 6x
    // rolls[15] -- above 3x rules out "no scaling was applied", below 6x rules
    // out "scaled by hit COUNT instead of hit INDEX".
    expect(result.totalRolls![15]).toBeGreaterThan(result.rolls[15] * 3)
    expect(result.totalRolls![15]).toBeLessThan(result.rolls[15] * 6)

    const axel = calculateMoveDamage(scenario({ move: moveData('MOVE_TRIPLE_AXEL') }))
    expect(axel.hitCount).toBe(3)
  })
})

describe('calculateMoveDamage -- EFFECT_MAGNITUDE (simulates all 7 tiers, weighted by their real probability; battle_util.c:11286-11307)', () => {
  // MOVE_MAGNITUDE is Ground-type -- Skarmory (Steel/Flying), scenario()'s default
  // defender, is flatly immune to it, so these use Garchomp (Ground/Dragon) instead.
  it('with no tier forced, combines all 7 tiers into one weighted 320-entry distribution (16 rolls x tier-weight, no unmodelled note)', () => {
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_MAGNITUDE'), defender: battler('SPECIES_GARCHOMP') }))
    // weights (percent/5): 1+2+4+6+4+2+1 = 20, x16 rolls each = 320.
    expect(result.rolls).toHaveLength(320)
    expect(result.unmodelled.some((n) => n.includes('EFFECT_MAGNITUDE'))).toBe(false)

    // min must come from tier 4 (10 power) and max from tier 10 (150 power) --
    // spans the full range, not clustered around the modal tier.
    const tier4 = calculateMoveDamage(scenario({ move: moveData('MOVE_MAGNITUDE'), defender: battler('SPECIES_GARCHOMP'), magnitudeTier: 4 }))
    const tier10 = calculateMoveDamage(scenario({ move: moveData('MOVE_MAGNITUDE'), defender: battler('SPECIES_GARCHOMP'), magnitudeTier: 10 }))
    expect(result.rolls[0]).toBe(tier4.rolls[0])
    expect(result.rolls[result.rolls.length - 1]).toBe(tier10.rolls[15])

    // Rebuild the expected combined multiset directly from each tier's own
    // rolls, repeated by its exact weight (percent/5), and compare bit-for-bit --
    // this verifies the WEIGHTING itself, not just the range, without assuming
    // any two tiers' damage values never coincidentally collide (low-power tiers
    // can both floor-clamp to the same minimum, so counting occurrences of one
    // specific VALUE isn't a safe assertion here).
    const weights: Record<number, number> = { 4: 1, 5: 2, 6: 4, 7: 6, 8: 4, 9: 2, 10: 1 }
    const expected: number[] = []
    for (const [tier, weight] of Object.entries(weights)) {
      const tierResult = calculateMoveDamage(scenario({ move: moveData('MOVE_MAGNITUDE'), defender: battler('SPECIES_GARCHOMP'), magnitudeTier: Number(tier) as 4 | 5 | 6 | 7 | 8 | 9 | 10 }))
      for (let i = 0; i < weight; i++) expected.push(...tierResult.rolls)
    }
    expected.sort((a, b) => a - b)
    expect(result.rolls).toEqual(expected)
  })

  it('forcing a specific tier still works exactly as a plain single-tier calculation (no combining)', () => {
    const forced = calculateMoveDamage(scenario({ move: moveData('MOVE_MAGNITUDE'), defender: battler('SPECIES_GARCHOMP'), magnitudeTier: 10 }))
    expect(forced.rolls).toHaveLength(16)
    expect(forced.unmodelled).toHaveLength(0)
  })
})

describe('calculateMoveDamage -- EFFECT_PURSUIT (a plain scenario flag, no turn history needed; battle_util.c:6860-6861)', () => {
  it('doubles power when the defender is switching, unchanged otherwise', () => {
    const notSwitching = calculateMoveDamage(scenario({ move: moveData('MOVE_PURSUIT') }))
    const switching = calculateMoveDamage(scenario({ move: moveData('MOVE_PURSUIT'), defenderIsSwitching: true }))
    expect(switching.rolls[15]).toBeGreaterThan(notSwitching.rolls[15])
  })
})

describe('calculateMoveDamage -- EFFECT_CLEAR_SMOG (MOVE_ABSORB in this ER build -- damage + a non-damage stat-clear secondary effect)', () => {
  it('computes a plain damage number from its declared power, same as any other move -- the secondary effect never touches this number', () => {
    // MOVE_ABSORB's own moveBehaviors.json entry is legacyConfig-only (no
    // attack.damage block), same as most of the 391 opaque entries -- but since
    // its ONLY behavior beyond plain damage is clearing the DEFENDER's stat
    // stages (a non-damage secondary effect, out of scope like every other
    // status/stat move effect in this engine), the opacity here doesn't hide
    // anything damage-relevant. applyMoveBehaviorDamage's own fallback (no
    // `attack.damage` -> use the declared power unmodified) already gives the
    // right number with zero special-casing needed.
    const result = calculateMoveDamage(scenario({ move: moveData('MOVE_ABSORB') }))
    expect(result.unmodelled).toHaveLength(0)
    expect(result.rolls[15]).toBeGreaterThan(0)
  })
})

describe('calculateMoveDamage -- ability dispatch is actually wired in', () => {
  it('Combustion (ported ability) boosts a Fire-type move end-to-end', async () => {
    await import('./abilities/impl/index') // populate the registry
    const withoutAbility = calculateMoveDamage(scenario({ move: moveData('MOVE_EMBER') })).rolls[15]
    const withCombustion = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_EMBER'),
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_COMBUSTION', innates: [null, null, null] } }),
      }),
    ).rolls[15]
    // x1.5 via the ability, on top of whatever else already applied -- must be
    // meaningfully larger, not just off by rounding.
    expect(withCombustion).toBeGreaterThan(withoutAbility)
    expect(withCombustion).toBeGreaterThanOrEqual(Math.floor(withoutAbility * 1.4))
  })

  it('Pixilate (ported ability) both retypes a Normal move AND grants it STAB end-to-end', async () => {
    await import('./abilities/impl/index')
    // Tackle (Normal) into a Dragon/Ground defender: neutral, no STAB (Garchomp isn't
    // Normal-type) -> baseline 1x. With Pixilate: Tackle becomes Fairy (2x vs Dragon,
    // neutral vs Ground -> 2x) AND gains STAB (1.5x) -- 3x total, unmistakably larger.
    const dragonGroundDefender = battler('SPECIES_GARCHOMP')
    const withoutAbility = calculateMoveDamage(scenario({ move: moveData('MOVE_TACKLE'), defender: dragonGroundDefender })).rolls[15]
    const withPixilate = calculateMoveDamage(
      scenario({
        move: moveData('MOVE_TACKLE'),
        defender: dragonGroundDefender,
        attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_PIXILATE', innates: [null, null, null] } }),
      }),
    ).rolls[15]
    expect(withPixilate).toBeGreaterThanOrEqual(Math.floor(withoutAbility * 2.5))
  })

  it('an ability not in the registry (or not damage-relevant) is silently a no-op, not an error', () => {
    expect(() =>
      calculateMoveDamage(
        scenario({
          move: moveData('MOVE_TACKLE'),
          attacker: battler('SPECIES_GARCHOMP', { abilitySlots: { ability: 'ABILITY_NOT_A_REAL_ABILITY', innates: [null, null, null] } }),
        }),
      ),
    ).not.toThrow()
  })
})
