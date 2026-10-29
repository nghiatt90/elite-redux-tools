/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 99: the two IsMoveAffectedByParentalBond / GetParentalBondMultiplier
// divergences in multiHit.ts's resolveHitPlan.
//
// Item 1 -- DUAL_WIELD has no REQUIRE(turn) in GetParentalBondMultiplier
// (battle_util.c:7483-7484), and Cmd_attackcanceler sets parentalBondOn =
// parentalBondInitialCount so the first hit is turn 0
// (battle_script_commands.c:1083-1090); the caller passes
// parentalBondInitialCount - parentalBondOn (battle_util.c:7631-7635). Hit 0 is
// therefore 0.7x, unlike every other trigger whose REQUIRE(turn) falls through to
// the final UQ_4_12(1.0) at battle_util.c:7487.
//
// Item 2 -- the eligibility steps of IsMoveAffectedByParentalBond
// (battle_script_commands.c:13164-13184) beyond the status/noParentalBond pair:
// Solar Beam in sun or with Chloroplast (:13167) and Electro Shot in rain (:13168)
// are eligible before the two-turn check (:13169); other two-turn effects without
// Accelerate are not. The BATTLE_TYPE_DOUBLE block (:13170-13181) is doubles-only.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from '../calculate'
import { resolveHitPlan, type MultiHitMoveData } from '../multiHit'
import { registerAbilities, _resetRegistryForTests } from '../abilities/registry'
import { PARENTAL_BOND_ABILITIES } from '../abilities/impl/24-parental-bond'
import { applyModifier, uq } from '../fixed'
import { calcStat } from '../stats'
import type { AbilitySlots } from '../abilities/dispatch'
import type { OnParentalBondContext } from '../abilities/types'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState } from '../types'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'

function slots(ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): AbilitySlots {
  return { ability, innates }
}

function move(overrides: Partial<MultiHitMoveData> = {}): MultiHitMoveData {
  return { effect: null, multiHitArgument: null, split: 'PHYSICAL', flags: {}, ...overrides }
}

function pbCtx(overrides: Partial<OnParentalBondContext> = {}): OnParentalBondContext {
  return { moveType: 'NORMAL', moveFlags: {}, weather: 'NONE', attackerHeads: 1, ...overrides }
}

function plan(result: ReturnType<typeof resolveHitPlan>) {
  if (!result || 'unmodelled' in result) throw new Error('expected a hit plan')
  return result
}

beforeEach(() => {
  _resetRegistryForTests()
  registerAbilities(PARENTAL_BOND_ABILITIES)
})

describe('resolveHitPlan -- DUAL_WIELD scales hit 0 as well (battle_util.c:7483-7484)', () => {
  it('Dual Wield with a bullet move: 2 hits, 0.7x on BOTH hit 0 (turn 0) and hit 1 (turn 1)', () => {
    const result = plan(resolveHitPlan(move({ flags: { bulletBased: true } }), slots('ABILITY_DUAL_WIELD'), slots(null), false, null, 3, pbCtx({ moveFlags: { bulletBased: true } }), 5))
    expect(result.hitCount).toBe(2)
    expect(result.hitModifier(0)).toBe(uq(0.7))
    expect(result.hitModifier(1)).toBe(uq(0.7))
  })

  it('Dual Wield with a slicing move: same 0.7x/0.7x (24-parental-bond.ts:81 accepts sliceBased too)', () => {
    const result = plan(resolveHitPlan(move({ flags: { sliceBased: true } }), slots('ABILITY_DUAL_WIELD'), slots(null), false, null, 3, pbCtx({ moveFlags: { sliceBased: true } }), 5))
    expect(result.hitCount).toBe(2)
    expect(result.hitModifier(0)).toBe(uq(0.7))
    expect(result.hitModifier(1)).toBe(uq(0.7))
  })

  it('Hyper Aggressive (Parental Bond): hit 0 stays 1.0x, hit 1 is 0.25x -- REQUIRE(turn) at :7466-7468', () => {
    const result = plan(resolveHitPlan(move(), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx(), 5))
    expect(result.hitCount).toBe(2)
    expect(result.hitModifier(0)).toBe(uq(1.0))
    expect(result.hitModifier(1)).toBe(uq(0.25))
  })

  it('Primal Maw with a biting move: hit 0 1.0x, hit 1 0.4x (:7479-7481)', () => {
    const result = plan(resolveHitPlan(move({ flags: { biteBased: true } }), slots('ABILITY_PRIMAL_MAW'), slots(null), false, null, 3, pbCtx({ moveFlags: { biteBased: true } }), 5))
    expect(result.hitCount).toBe(2)
    expect(result.hitModifier(0)).toBe(uq(1.0))
    expect(result.hitModifier(1)).toBe(uq(0.4))
  })

  it('Multi Headed with 3 heads: 3 hits, 1.0x / 0.2x / 0.15x (:7470-7474)', () => {
    const result = plan(resolveHitPlan(move(), slots('ABILITY_MULTI_HEADED'), slots(null), false, null, 3, pbCtx({ attackerHeads: 3 }), 5))
    expect(result.hitCount).toBe(3)
    expect(result.hitModifier(0)).toBe(uq(1.0))
    expect(result.hitModifier(1)).toBe(uq(0.2))
    expect(result.hitModifier(2)).toBe(uq(0.15))
  })
})

describe('resolveHitPlan -- IsMoveAffectedByParentalBond eligibility (battle_script_commands.c:13164-13184)', () => {
  it('a two-turn move without Accelerate is not eligible (:13169)', () => {
    expect(resolveHitPlan(move({ effect: 'EFFECT_SEMI_INVULNERABLE' }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx(), 5)).toBeNull()
  })

  it('the same two-turn move with Accelerate in a second ability slot IS eligible (BattlerHasAbility(..., ACCELERATE, FALSE), :13169)', () => {
    const attacker = slots('ABILITY_PARENTAL_BOND', [null, null, 'ABILITY_ACCELERATE'])
    const result = plan(resolveHitPlan(move({ effect: 'EFFECT_SEMI_INVULNERABLE' }), attacker, slots(null), false, null, 3, pbCtx(), 5))
    expect(result.hitCount).toBe(2)
    expect(result.hitModifier(1)).toBe(uq(0.25))
  })

  it('Sky Drop (EFFECT_SKY_DROP is also two_turn in MoveBehavior.proto:451) is not eligible without Accelerate', () => {
    expect(resolveHitPlan(move({ effect: 'EFFECT_SKY_DROP' }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx(), 5)).toBeNull()
  })

  it('Solar Beam: not eligible with no sun and no Chloroplast (:13169 via the two-turn set)', () => {
    expect(resolveHitPlan(move({ effect: 'EFFECT_SOLARBEAM', split: 'SPECIAL' }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx(), 5)).toBeNull()
  })

  it('Solar Beam in sun IS eligible even though it is two-turn (:13167 returns TRUE before :13169)', () => {
    const result = plan(
      resolveHitPlan(move({ effect: 'EFFECT_SOLARBEAM', split: 'SPECIAL' }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx({ weather: 'SUN_TEMPORARY' }), 5),
    )
    expect(result.hitCount).toBe(2)
  })

  it('Solar Beam with a Chloroplast-bit ability (no sun) IS eligible: HasChloroplast, battle_util.c:9340', () => {
    const attacker = slots('ABILITY_PARENTAL_BOND', [null, null, 'ABILITY_CHLOROPLAST'])
    const result = plan(resolveHitPlan(move({ effect: 'EFFECT_SOLARBEAM', split: 'SPECIAL' }), attacker, slots(null), false, null, 3, pbCtx(), 5))
    expect(result.hitCount).toBe(2)
  })

  it('the other two Chloroplast-bit abilities (Big Leaves, Solar Flare) grant the same exemption', () => {
    for (const id of ['ABILITY_BIG_LEAVES', 'ABILITY_SOLAR_FLARE']) {
      const attacker = slots('ABILITY_PARENTAL_BOND', [null, null, id])
      const result = plan(resolveHitPlan(move({ effect: 'EFFECT_SOLARBEAM', split: 'SPECIAL' }), attacker, slots(null), false, null, 3, pbCtx(), 5))
      expect(result.hitCount).toBe(2)
    }
  })

  it('Electro Shot in rain IS eligible (:13168); with no weather it is not (:13169)', () => {
    const inRain = plan(
      resolveHitPlan(move({ effect: 'EFFECT_ELECTRO_SHOT', split: 'SPECIAL' }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx({ weather: 'RAIN_TEMPORARY' }), 5),
    )
    expect(inRain.hitCount).toBe(2)
    expect(resolveHitPlan(move({ effect: 'EFFECT_ELECTRO_SHOT', split: 'SPECIAL' }), slots('ABILITY_PARENTAL_BOND'), slots(null), false, null, 3, pbCtx(), 5)).toBeNull()
  })

  it('status moves (:13165) and the parentalBondBanned flag (:13166) still reject even a DUAL_WIELD trigger', () => {
    expect(resolveHitPlan(move({ split: 'STATUS', flags: { bulletBased: true } }), slots('ABILITY_DUAL_WIELD'), slots(null), false, null, 3, pbCtx({ moveFlags: { bulletBased: true } }), 5)).toBeNull()
    expect(
      resolveHitPlan(move({ flags: { bulletBased: true, noParentalBond: true } }), slots('ABILITY_DUAL_WIELD'), slots(null), false, null, 3, pbCtx({ moveFlags: { bulletBased: true } }), 5),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// End-to-end: the calc's own hit-0 damage is scaled by DUAL_WIELD.
// ---------------------------------------------------------------------------

const DATA_DIR = new URL('../../../../data/v2.65beta/', import.meta.url)
const speciesData = JSON.parse(readFileSync(fileURLToPath(new URL('species.json', DATA_DIR)), 'utf-8'))
const movesData = JSON.parse(readFileSync(fileURLToPath(new URL('moves.json', DATA_DIR)), 'utf-8'))
const typeChart: TypeChart = JSON.parse(readFileSync(fileURLToPath(new URL('types.json', DATA_DIR)), 'utf-8'))
const inverseTypeChart: TypeChart = JSON.parse(readFileSync(fileURLToPath(new URL('typesInverse.json', DATA_DIR)), 'utf-8'))
const moveBehaviors: MoveBehaviors = JSON.parse(readFileSync(fileURLToPath(new URL('moveBehaviors.json', DATA_DIR)), 'utf-8')).behaviors
const battleConstants: BattleConstants = JSON.parse(readFileSync(fileURLToPath(new URL('natures.json', DATA_DIR)), 'utf-8'))

const speciesById: Record<string, any> = Object.fromEntries(speciesData.map((s: any) => [s.id, s]))
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

function battler(speciesId: string, overrides: Partial<BattlerBattleState> = {}): BattlerBattleState {
  const s = speciesById[speciesId]
  const level = 100
  const nature = 'NATURE_HARDY'
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
    canEvolveStrict: false,
    isInfatuatedWithOpponent: false,
    moveSlotPp: {},
    abilitySlots: { ability: null, innates: [null, null, null] },
    hasMiracleEye: false,
    ...overrides,
  }
}

function fieldState(): FieldBattleState {
  return {
    gravityActive: false,
    terrain: null,
    weather: 'NONE',
    sides: {
      attacker: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
      defender: { reflect: false, lightScreen: false, auroraVeil: false, luckyChant: false },
    },
    isDoubleBattle: false,
    isInverseRoomActive: false,
    isInverseBattleFlagSet: false,
    isWonderRoomActive: false,
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
    move: moveData('MOVE_AURA_SPHERE'),
    attacker: battler('SPECIES_GARCHOMP'),
    defender: battler('SPECIES_WAILMER'),
    field: fieldState(),
    typeChart,
    inverseTypeChart,
    moveBehaviors,
    battleConstants,
    attackerActsFirst: true,
    sameMoveTurnsInARow: 0,
    hitCount: 3,
    defenderIsSwitching: false,
    magnitudeTier: null,
    attackerRolloutCounter: 0,
    attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: false,
    beatUpBaseAttack: 80,
    beatUpHitCount: 5,
    defenderUsedGlaiveRush: false,
    ...overrides,
  }
}

describe('calculateMoveDamage -- DUAL_WIELD scales the first hit too', () => {
  it('Aura Sphere (bulletBased) vs a neutral Water defender: hit 0 is 0.7x the unscaled hit', () => {
    // Garchomp (Dragon/Ground) using Fighting Aura Sphere: no STAB. Wailmer is pure
    // Water, so Fighting is 1.0x. No abilities besides DUAL_WIELD, no screens, no
    // weather -- CalcFinalDmg's finalModifier accumulator is exactly UQ_4_12(1.0)
    // before stage #10, so folding GetParentalBondMultiplier(DUAL_WIELD, 0) in is
    // mulModifier(1024, 717) = floor((1024*717 + 512)/1024) = 717 (0.7x).
    // `rolls[15]` is the 100% roll (roll=0 -> idiv(dmg*100,100) = dmg), i.e. the
    // pre-random damage, so the scaled value is applyModifier(717, unscaled).
    const baseline = calculateMoveDamage(scenario())
    const withDualWield = calculateMoveDamage(scenario({ attacker: battler('SPECIES_GARCHOMP', { abilitySlots: slots('ABILITY_DUAL_WIELD') }) }))

    expect(withDualWield.hitCount).toBe(2)
    const unscaled = baseline.rolls[15]
    const expectedScaledHit = applyModifier(uq(0.7), unscaled)
    // Hand calculation: unscaled = 134 (Garchomp spatk 196 vs Wailmer spdef 106 at level 100:
    // floor(42*85*196/106)=6601, /50+2 = 134), so
    // floor((717*134 + 512)/1024) = floor(96590/1024) = 94, which differs from 134.
    expect(unscaled).toBe(134)
    expect(expectedScaledHit).toBe(94)
    expect(withDualWield.rolls![15]).toBe(94)
    expect(withDualWield.totalRolls![15]).toBe(94 + 94)
  })
})
