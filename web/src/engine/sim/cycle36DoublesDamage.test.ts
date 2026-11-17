/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 36 (dbl-1): the three doubles-dependent terms in CalcFinalDmg, so a later
// doubles engine can feed them. The standalone calculator stays singles: every
// scenario below explicitly opts in.
//
//   (1) GetMoveTargetCount(move, battlerAtk, battlerDef) >= 2 -> x0.75
//       (battle_util.c:6761-6781, 7498). Ported in ../moveTargetCount.ts.
//   (2) Reflect/Light Screen/Aurora Veil -> x0.66 under BATTLE_TYPE_DOUBLE, else x0.5
//       (battle_util.c:7621-7626).
//   (3) The defender's ALIVE partner's Friend Guard / Caretaker / Food Lovers, each
//       BATTLER_HAS_ABILITY_AND_ALIVE(BATTLE_PARTNER(battlerDef), ability, TRUE) ->
//       x0.5 (battle_util.c:7637-7640). TRUE means the attacker's Mold Breaker
//       suppresses a `breakable` ability; per abilityHooks.json Friend Guard and
//       Food Lovers are breakable, Caretaker is not.
//
// Scaffolding (scenario builder, fixed-point helpers, species stats) is copied from
// cycle161MoveFlagTypes.test.ts. Attacker is Garchomp (atk 296), defender Snorlax
// (def 166), both level 100, neutral nature, 31 IV / 0 EV; move is Tackle (Normal,
// 40 power, physical) against a pure Normal Snorlax, so type effectiveness is 1x,
// Garchomp (Dragon/Ground) has no STAB on it, and no weather/ability multiplier is
// in play. Core (:7517-7533): dmg = 42 * 40 = 1680; * 296 = 497280; /166 = 2995;
// /50 = 59; +2 = 61. rolls[15] is the 100% roll (idiv(dmg*100, 100) = dmg).
//
// Fixed-point: uq(n) = trunc(n*1024); mulModifier(a,b) = floor((a*b+512)/1024);
// applyModifier(m,v) = floor((m*v+512)/1024). uq(0.75)=768, uq(0.5)=512,
// uq(0.66)=675 (truncated).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from '../calculate'
import { getMoveTargetCount } from '../moveTargetCount'
import { registerAbilities, _resetRegistryForTests } from '../abilities/registry'
import { MOLD_BREAKER_ABILITIES } from '../abilities/impl/23-mold-breaker'
import { applyModifier, mulModifier, uq } from '../fixed'
import { calcStat } from '../stats'
import type { AbilitySlots } from '../abilities/dispatch'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState } from '../types'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'

const DATA_DIR = new URL('../../../../data/v2.65beta/', import.meta.url)
const species = JSON.parse(readFileSync(fileURLToPath(new URL('species.json', DATA_DIR)), 'utf-8'))
const movesData = JSON.parse(readFileSync(fileURLToPath(new URL('moves.json', DATA_DIR)), 'utf-8'))
const typeChart: TypeChart = JSON.parse(readFileSync(fileURLToPath(new URL('types.json', DATA_DIR)), 'utf-8'))
const inverseTypeChart: TypeChart = JSON.parse(readFileSync(fileURLToPath(new URL('typesInverse.json', DATA_DIR)), 'utf-8'))
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

/** A level-100, neutral-nature, 0 EV / 31 IV battler from real species.json base
 * stats -- copied from calculate.test.ts's own helper via cycle161's file. */
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
    canEvolveStrict: false,
    isInfatuatedWithOpponent: false,
    moveSlotPp: {},
    abilitySlots: { ability: null, innates: [null, null, null] },
    hasMiracleEye: false,
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
    isInverseRoomActive: false,
    isInverseBattleFlagSet: false,
    isWonderRoomActive: false,
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
    defender: battler('SPECIES_SNORLAX'),
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

function slots(ability: string | null): AbilitySlots {
  return { ability, innates: [null, null, null] }
}

function slotsWith(ability: string | null, innates: [string | null, string | null, string | null]): AbilitySlots {
  return { ability, innates }
}

/** The maximum (100%) damage roll -- rolls[15] is `idiv(dmg * 100, 100)` = `dmg`. */
function maxRoll(s: DamageCalcScenario): number {
  return calculateMoveDamage(s).rolls[15]
}

beforeEach(() => {
  _resetRegistryForTests()
  registerAbilities(MOLD_BREAKER_ABILITIES)
})

describe('getMoveTargetCount -- battle_util.c:6761-6781', () => {
  const base = { moveId: 'MOVE_TACKLE', targetFlag: 'SELECTED', atkAlive: true, defAlive: true, defPartnerAlive: true, atkPartnerAlive: true }

  it('BOTH: alive(def) + alive(partner(def))', () => {
    expect(getMoveTargetCount({ ...base, targetFlag: 'BOTH' })).toBe(2)
    expect(getMoveTargetCount({ ...base, targetFlag: 'BOTH', defPartnerAlive: false })).toBe(1)
  })

  it('FOES_AND_ALLY: all three of def, partner(def), partner(atk)', () => {
    expect(getMoveTargetCount({ ...base, targetFlag: 'FOES_AND_ALLY' })).toBe(3)
    expect(getMoveTargetCount({ ...base, targetFlag: 'FOES_AND_ALLY', atkPartnerAlive: false })).toBe(2)
  })

  it('Sparkling Aria rewrites FOES_AND_ALLY to BOTH before the switch', () => {
    expect(getMoveTargetCount({ ...base, moveId: 'MOVE_SPARKLING_ARIA', targetFlag: 'FOES_AND_ALLY' })).toBe(2)
    // The rewrite is conditional on the flag: any other target is untouched.
    expect(getMoveTargetCount({ ...base, moveId: 'MOVE_SPARKLING_ARIA', targetFlag: 'BOTH' })).toBe(2)
  })

  it('OPPONENTS_FIELD is always 1, even with the foe fainted', () => {
    expect(getMoveTargetCount({ ...base, targetFlag: 'OPPONENTS_FIELD' })).toBe(1)
    expect(getMoveTargetCount({ ...base, targetFlag: 'OPPONENTS_FIELD', defAlive: false })).toBe(1)
  })

  it('DEPENDS / SELECTED / RANDOM / USER_OR_SELECTED: alive(def)', () => {
    for (const targetFlag of ['DEPENDS', 'SELECTED', 'RANDOM', 'USER_OR_SELECTED']) {
      expect(getMoveTargetCount({ ...base, targetFlag })).toBe(1)
      expect(getMoveTargetCount({ ...base, targetFlag, defAlive: false, atkAlive: true })).toBe(0)
    }
  })

  it('USER: alive(atk)', () => {
    expect(getMoveTargetCount({ ...base, targetFlag: 'USER' })).toBe(1)
    expect(getMoveTargetCount({ ...base, targetFlag: 'USER', atkAlive: false })).toBe(0)
  })

  it('unknown flag (ALLY, USER_OR_ALLY, ALL_BATTLERS, ...) hits default: 0', () => {
    expect(getMoveTargetCount({ ...base, targetFlag: 'ALLY' })).toBe(0)
    expect(getMoveTargetCount({ ...base, targetFlag: 'ALL_BATTLERS' })).toBe(0)
    expect(getMoveTargetCount({ ...base, targetFlag: 'NOT_A_TARGET' })).toBe(0)
  })
})

describe('multi-target x0.75 -- battle_util.c:7498', () => {
  it('targetCount: 2 applies uq(0.75) once: 61 -> 46', () => {
    // mulModifier(1024, 768) = floor((1024*768+512)/1024) = 768
    // applyModifier(768, 61) = floor((768*61+512)/1024) = 46
    expect(maxRoll(scenario({ targetCount: 2 }))).toBe(applyModifier(mulModifier(uq(1.0), uq(0.75)), 61))
    expect(maxRoll(scenario({ targetCount: 2 }))).toBe(46)
  })

  it('targetCount: 3 (FOES_AND_ALLY) applies it once, not twice', () => {
    expect(maxRoll(scenario({ targetCount: 3 }))).toBe(46)
  })

  it('targetCount absent and targetCount: 1 both equal the singles value (61)', () => {
    expect(maxRoll(scenario())).toBe(61)
    expect(maxRoll(scenario({ targetCount: 1 }))).toBe(61)
  })
})

describe("ally damage reducers -- battle_util.c:7637-7640, each x0.5", () => {
  it('Friend Guard on the defender ally: 61 -> 31 (0.5, not the old 0.75)', () => {
    // mulModifier(1024, 512) = 512; applyModifier(512, 61) = floor((512*61+512)/1024) = 31
    const reduced = maxRoll(scenario({ defenderAllyAbilitySlots: slots('ABILITY_FRIEND_GUARD') }))
    expect(reduced).toBe(applyModifier(mulModifier(uq(1.0), uq(0.5)), 61))
    expect(reduced).toBe(31)
  })

  it('Friend Guard + Caretaker + Food Lovers: 0.5 * 0.5 * 0.5, re-quantized each step -> 8', () => {
    // 1024 -> mulModifier(1024,512) = 512
    //      -> mulModifier(512,512)  = floor((512*512+512)/1024)  = 256
    //      -> mulModifier(256,512)  = floor((256*512+512)/1024)  = 128
    // applyModifier(128, 61) = floor((128*61+512)/1024) = 8
    const ally = slotsWith('ABILITY_FRIEND_GUARD', ['ABILITY_CARETAKER', 'ABILITY_FOOD_LOVERS', null])
    expect(maxRoll(scenario({ defenderAllyAbilitySlots: ally }))).toBe(8)
  })

  it('no alive partner (null or absent) leaves the damage unchanged', () => {
    expect(maxRoll(scenario({ defenderAllyAbilitySlots: null }))).toBe(61)
    expect(maxRoll(scenario())).toBe(61)
  })

  it('Mold Breaker suppresses Friend Guard and Food Lovers, but NOT Caretaker', () => {
    // BATTLER_HAS_ABILITY_AND_ALIVE(..., TRUE): two of the three are breakable
    // (abilityHooks.json), so only Caretaker survives -> one x0.5 -> 31.
    const attacker = battler('SPECIES_GARCHOMP', { abilitySlots: slots('ABILITY_MOLD_BREAKER') })
    const ally = slotsWith('ABILITY_FRIEND_GUARD', ['ABILITY_CARETAKER', 'ABILITY_FOOD_LOVERS', null])
    expect(maxRoll(scenario({ attacker, defenderAllyAbilitySlots: ally }))).toBe(31)

    // Control: with Caretaker alone (no breakable ability) Mold Breaker changes nothing.
    expect(maxRoll(scenario({ attacker, defenderAllyAbilitySlots: slots('ABILITY_CARETAKER') }))).toBe(31)
  })
})

describe('screens under BATTLE_TYPE_DOUBLE -- battle_util.c:7621-7626', () => {
  it('Reflect vs a physical move: x0.5 in singles (61 -> 31) and x0.66 in doubles (-> 40)', () => {
    // singles: mulModifier(1024, 512) = 512; applyModifier(512, 61) = 31
    // doubles: uq(0.66) = 675; mulModifier(1024, 675) = 675;
    //          applyModifier(675, 61) = floor((675*61+512)/1024) = 40
    const reflect = { reflect: true, lightScreen: false, auroraVeil: false, luckyChant: false }
    const singles = scenario({ field: fieldState({ sides: { ...fieldState().sides, defender: reflect } }) })
    const doubles = scenario({ field: fieldState({ isDoubleBattle: true, sides: { ...fieldState().sides, defender: reflect } }) })
    expect(maxRoll(singles)).toBe(31)
    expect(maxRoll(doubles)).toBe(40)
    expect(maxRoll(doubles)).toBe(applyModifier(mulModifier(uq(1.0), uq(0.66)), 61))
  })
})
