/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ib slice 1: DoesMoveMatchFlag's ability-grant fallback reaches two damage
// consumers -- Keen Edge and Striker.
//
// C at the pinned SHA:
// - DoesMoveMatchFlag (src/abilities.cc:358-386): the move's own static flag bit wins
//   outright; only if unset does it ask every ability on the move's own battler via
//   onModifyMoveFlags. `moveType` is the caller's, not the move's.
// - Impl<ABILITY_KEEN_EDGE>.onOffensiveMultiplier (src/abilities.cc:3676):
//   DoesMoveMatchFlag(battler, move, moveType, MOVE_FLAG_KEEN_EDGE) -> MUL(1.3), with the
//   REAL move type. Chestnut Axe aliases this multiplier and grants KEEN_EDGE when the
//   move is Grass (src/abilities.cc:11706-11712).
// - Impl<ABILITY_STRIKER>.onOffensiveMultiplier (src/abilities.cc:4609):
//   IsStrikerBoosted(battler, move) -> MUL(1.3); IsStrikerBoosted is
//   DoesMoveMatchFlag(battler, move, TYPE_NORMAL, MOVE_FLAG_KICK) (src/battle_util.c:9377),
//   a literal TYPE_NORMAL dummy. Backstreet Boy aliases this multiplier and grants KICK to
//   Dance moves (:11566-11583).
//
// All scenarios are Garchomp (level 100, neutral nature, 31 IV/0 EV) against a pure
// Normal Snorlax, with no items/weather/field and no STAB, so type effectiveness is 1x
// for every move except High Jump Kick (Fighting vs Normal = 2x).
//
// Raw stats (calcStat: floor((2*base+31)*level/100)+5):
//   Garchomp atk 296, spatk 196; Snorlax def 166, spdef 256.
// Core (:7524-7533): dmg = floor(level*2/5)+2 = 42; *power; *atk; /def; /50+2.
// CalcFinalDmg folds typeEff then abilityMultiplier into ONE UQ_4_12 modifier and applies
// it once: applyModifier(m, dmg) = floor((m*dmg+512)/1024). A 1.3x ability gives
// mulModifier(1024, uq(1.3)) = uq(1.3) = 1331. The 16 rolls are then
// floor(best.dmg*(100-roll)/100) with index 0 = roll 15 (85%) and index 15 = roll 0 (100%).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from '../calculate'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState } from '../types'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'
import { calcStat } from '../stats'
import { doesMoveMatchFlag } from '../abilities/dispatchCalc'
import type { AbilitySlots } from '../abilities/dispatch'

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

/** A level-100, neutral-nature, 0 EV / 31 IV battler built from real species.json
 * base stats -- copied from calculate.test.ts's own helper. */
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

function damage(moveId: string, attackerAbility: string | null, defenderAbility: string | null = null) {
  return calculateMoveDamage(
    scenario({
      move: moveData(moveId),
      attacker: battler('SPECIES_GARCHOMP', { abilitySlots: slots(attackerAbility) }),
      defender: battler('SPECIES_SNORLAX', { abilitySlots: slots(defenderAbility) }),
    }),
  )
}

describe('Cycle 150ib -- DoesMoveMatchFlag grants reach Keen Edge and Striker', () => {
  it('Chestnut Axe + Energy Ball (Grass, no slice flag): Keen Edge 1.3x', () => {
    // Energy Ball (special, 90): 42*90=3780; *196=740,880; /256=2894; /50=57; +2=59.
    // TypeEff Grass vs Normal = 1x. Chestnut Axe grants KEEN_EDGE because the real
    // moveType is GRASS, so finalModifier = mulModifier(1024, 1331) = 1331:
    // applyModifier(1331, 59) = floor((1331*59+512)/1024) = floor(79041/1024) = 77.
    // rolls: index 15 = 100% (59 -> 77), index 0 = 85% (floor(59*.85)=50 -> floor(77*.85)=65).
    const neutral = damage('MOVE_ENERGY_BALL', null)
    const chestnut = damage('MOVE_ENERGY_BALL', 'ABILITY_CHESTNUT_AXE')
    expect(neutral.rolls[15]).toBe(59)
    expect(chestnut.rolls[15]).toBe(77)
    expect(neutral.rolls[0]).toBe(50)
    expect(chestnut.rolls[0]).toBe(65)
  })

  it('Chestnut Axe + Flamethrower (Fire, no slice flag): no boost (negative)', () => {
    // Same 59 base as Energy Ball (special 90, same stats), but the grant requires
    // moveType == GRASS, so nothing changes.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const chestnut = damage('MOVE_FLAMETHROWER', 'ABILITY_CHESTNUT_AXE')
    expect(neutral.rolls[15]).toBe(59)
    expect(chestnut.rolls).toEqual(neutral.rolls)
  })

  it('Keen Edge + Leaf Blade still 1.3x via the static slice flag; Chestnut Axe doubles it exactly once', () => {
    // Leaf Blade (physical, 90): 42*90=3780; *296=1,118,880; /166=6739; /50=134; +2=136.
    // TypeEff Grass vs Normal = 1x. Both Keen Edge (static sliceBased) and Chestnut Axe
    // (static flag early-returns DoesMoveMatchFlag) apply exactly ONE MUL:
    // applyModifier(1331, 136) = floor((181016+512)/1024) = 177. Two MULs would give
    // mulModifier(1331,1331)=1730 -> applyModifier(1730,136)=230, which is NOT seen.
    const neutral = damage('MOVE_LEAF_BLADE', null)
    const keen = damage('MOVE_LEAF_BLADE', 'ABILITY_KEEN_EDGE')
    const chestnut = damage('MOVE_LEAF_BLADE', 'ABILITY_CHESTNUT_AXE')
    expect(neutral.rolls[15]).toBe(136)
    expect(keen.rolls[15]).toBe(177)
    expect(chestnut.rolls[15]).toBe(177)
  })

  it('Backstreet Boy + Fiery Dance (Dance, not Kick): Striker 1.3x via the KICK grant', () => {
    // Fiery Dance (special, 80): 42*80=3360; *196=658,560; /256=2572; /50=51; +2=53.
    // TypeEff Fire vs Normal = 1x. Backstreet Boy grants KICK to Dance moves; Striker's
    // consumer passes the TYPE_NORMAL dummy (the grant does not read moveType):
    // applyModifier(1331, 53) = floor((70543+512)/1024) = 69.
    // rolls: 100% 53 -> 69; 85% floor(53*.85)=45 -> floor(69*.85)=58.
    const neutral = damage('MOVE_FIERY_DANCE', null)
    const backstreet = damage('MOVE_FIERY_DANCE', 'ABILITY_BACKSTREET_BOY')
    expect(neutral.rolls[15]).toBe(53)
    expect(backstreet.rolls[15]).toBe(69)
    expect(neutral.rolls[0]).toBe(45)
    expect(backstreet.rolls[0]).toBe(58)
  })

  it('Backstreet Boy + a non-Dance non-Kick move: no boost (negative)', () => {
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const backstreet = damage('MOVE_FLAMETHROWER', 'ABILITY_BACKSTREET_BOY')
    expect(neutral.rolls[15]).toBe(59)
    expect(backstreet.rolls).toEqual(neutral.rolls)
  })

  it('Backstreet Boy + High Jump Kick: 1.3x via the static kickBased flag', () => {
    // High Jump Kick (physical, 130): 42*130=5460; *296=1,616,160; /166=9735; /50=194; +2=196.
    // TypeEff Fighting vs Normal = 2x: finalModifier = mulModifier(1024,2048)=2048, then
    // mulModifier(2048,1331)=floor((2048*1331+512)/1024)=2662. Without the ability,
    // finalModifier stays 2048: applyModifier(2048,196)=392; with it,
    // applyModifier(2662,196)=floor((521752+512)/1024)=510.
    // rolls: 100% 392 -> 510; 85% floor(392*.85)=333 -> floor(510*.85)=433.
    const neutral = damage('MOVE_HIGH_JUMP_KICK', null)
    const backstreet = damage('MOVE_HIGH_JUMP_KICK', 'ABILITY_BACKSTREET_BOY')
    expect(neutral.rolls[15]).toBe(392)
    expect(backstreet.rolls[15]).toBe(510)
    expect(neutral.rolls[0]).toBe(333)
    expect(backstreet.rolls[0]).toBe(433)
  })

  it('Striker + a Dance move: no boost -- Striker has no onModifyMoveFlags (negative)', () => {
    const neutral = damage('MOVE_FIERY_DANCE', null)
    const striker = damage('MOVE_FIERY_DANCE', 'ABILITY_STRIKER')
    expect(neutral.rolls[15]).toBe(53)
    expect(striker.rolls).toEqual(neutral.rolls)
  })

  it('Chestnut Axe on the DEFENDER only: no boost -- the grant scans the attacker\'s slots', () => {
    // energy ball base 59; the defender's onOffensiveMultiplier never runs (not the move
    // user), and doesMoveMatchFlag scans attackerSlots, which is neutral here.
    const neutral = damage('MOVE_ENERGY_BALL', null)
    const defenderOnly = damage('MOVE_ENERGY_BALL', null, 'ABILITY_CHESTNUT_AXE')
    expect(neutral.rolls[15]).toBe(59)
    expect(defenderOnly.rolls).toEqual(neutral.rolls)
  })
})

describe('Cycle 150ib -- doesMoveMatchFlag passes the caller\'s moveType', () => {
  it('Mixed Martial Arts grants KICK only when the type argument is NORMAL', () => {
    // Mirrors src/abilities.cc:9872: (flag == PUNCH || flag == KICK) && moveType == NORMAL.
    // This is what makes Striker's TYPE_NORMAL dummy and Keen Edge's REAL type behave
    // differently for a type-conditioned grant.
    const mma = slots('ABILITY_MIXED_MARTIAL_ARTS')
    expect(doesMoveMatchFlag(mma, 'kickBased', 'NORMAL', {}, 'PHYSICAL')).toBe(true)
    expect(doesMoveMatchFlag(mma, 'kickBased', 'FIRE', {}, 'PHYSICAL')).toBe(false)
    // The static flag still wins without consulting any ability (:362-364).
    expect(doesMoveMatchFlag(mma, 'kickBased', 'FIRE', { kickBased: true }, 'PHYSICAL')).toBe(true)
  })
})
