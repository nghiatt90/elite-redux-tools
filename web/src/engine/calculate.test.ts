import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from './calculate'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState } from './types'
import type { TypeChart } from './typeEffectiveness'
import type { MoveBehaviors } from './basePower'
import { calcStat } from './stats'

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
    itemId: null,
    resolvedHoldEffect: null,
    itemNegated: false,
    status1: new Set(),
    hasComatose: false,
    hasBloodStainEffect: false,
    isInfatuated: false,
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
    level,
    nature,
    rawStats,
    statStages: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    extraStatLevel: { atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    holdEffectStrength: null,
    holdEffectType: null,
    isTransformed: false,
    canEvolveStrict: false,
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
    splitFlag: m.splitFlag,
    effect: m.effect,
    customBehavior: m.customBehavior,
    crit: m.crit,
    hitsAir: m.hitsAir,
    flags: m.flags ?? {},
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
