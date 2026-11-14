/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 161: the four onModifyMoveFlags grants keyed on a type must each read the
// same type source as the C, instead of blindly reusing the caller's `moveType`
// argument. `DoesMoveMatchFlag` (src/abilities.cc:358-386) passes one opaque
// `moveType` argument to every grant; each grant then decides for itself, and only
// Chestnut Axe actually reads that argument.
//
// C at the pinned SHA:
// - Mixed Martial Arts (src/abilities.cc:9899-9903): the grant requires
//   `gBattleMoves[move].type == TYPE_NORMAL` -- the move's DECLARED base type.
// - Reverbate (src/abilities.cc:10655-10661): same condition, DECLARED base type.
// - Brawling Wyvern (src/abilities.cc:7600-7609): `CHECK(IS_MOVE_TYPE(move,
//   TYPE_DRAGON))`; include/battle.h:743 resolves IS_MOVE_TYPE to `dynamicMoveType`
//   (low 6 bits) when set, else the declared type -- the RESOLVED type.
// - Chestnut Axe (src/abilities.cc:11706-11715): `return moveType == TYPE_GRASS;` --
//   it really does read the caller's argument (Keen Edge passes the real/resolved
//   move type, :3676).
// - The consumers all pass a literal TYPE_NORMAL as that argument:
//   IsIronFistBoosted/IsMegaLauncherBoosted/IsStrikerBoosted/IsSoundMove
//   (src/battle_util.c:9373-9379). A grant that reads the argument therefore used
//   to fire for every move; a grant that reads a real type source does not.
//
// All scenarios are Garchomp (level 100, neutral nature, 31 IV/0 EV) against a pure
// Normal Snorlax, with no items/weather/field, so type effectiveness is 1x for every
// move except where noted. Garchomp is Dragon/Ground, so Dragon moves get 1.5x STAB;
// the -ate cases below grant pseudo-STAB on the retyped move instead.
//
// Raw stats (calcStat: floor((2*base+31)*level/100)+5):
//   Garchomp atk 296, spatk 196; Snorlax def 166, spdef 256.
// Core (:7524-7533): dmg = floor(level*2/5)+2 = 42; *power; *atk; /def; /50+2.
// CalcFinalDmg folds typeEff, abilityMultiplier and STAB into ONE UQ_4_12 modifier
// (finalDamage.ts: #2 typeEff, #3 ability, #8 STAB) and applies it once:
// applyModifier(m, dmg) = floor((m*dmg+512)/1024), mulModifier(a,b) =
// floor((a*b+512)/1024), uq(n) = trunc(n*1024): uq(1.3)=1331, uq(1.25)=1280,
// uq(1.2)=1228, uq(0.5)=512, uq(1.5)=1536. The 16 rolls are
// floor(best.dmg*(100-roll)/100) with index 0 = roll 15 (85%) and index 15 = roll 0
// (100%).
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
 * base stats -- copied from calculate.test.ts's own helper (via slice 1's file). */
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

/** Slice 2 needs two abilities on one battler (e.g. Iron Fist + Mixed Martial Arts). */
function slotsWith(ability: string | null, innates: [string | null, string | null, string | null]): AbilitySlots {
  return { ability, innates }
}

function damageWith(moveId: string, attackerSlots: AbilitySlots, defenderSlots: AbilitySlots = slots(null)) {
  return calculateMoveDamage(
    scenario({
      move: moveData(moveId),
      attacker: battler('SPECIES_GARCHOMP', { abilitySlots: attackerSlots }),
      defender: battler('SPECIES_SNORLAX', { abilitySlots: defenderSlots }),
    }),
  )
}

function damage(moveId: string, attackerAbility: string | null, defenderAbility: string | null = null) {
  return damageWith(moveId, slots(attackerAbility), slots(defenderAbility))
}

describe('Cycle 161 -- Brawling Wyvern reads the RESOLVED type through Iron Fist', () => {
  it('Iron Fist + Brawling Wyvern + Dragon Pulse: 1.3x (Dragon resolved type, punch granted)', () => {
    // Dragon Pulse (special 90, Dragon): core 59; Dragon vs Normal = 1x; Garchomp
    // STAB 1.5x -> mulModifier(1024,1536) = 1536 -> applyModifier(1536,59) = 89.
    // Brawling Wyvern checks IS_MOVE_TYPE(move, TYPE_DRAGON) (src/abilities.cc:7607),
    // which include/battle.h:743 resolves from the move itself (dynamicMoveType when
    // set, else the declared type) -- here Dragon -- so Iron Fist's punch consumer
    // applies uq(1.3): mulModifier(1536,1331) = 1997 ->
    // applyModifier(1997,59) = floor((1997*59+512)/1024) = 115; 85% floor(115*.85)=97.
    const neutral = damage('MOVE_DRAGON_PULSE', null)
    const boosted = damageWith('MOVE_DRAGON_PULSE', slotsWith('ABILITY_IRON_FIST', ['ABILITY_BRAWLING_WYVERN', null, null]))
    expect(neutral.rolls[15]).toBe(89)
    expect(boosted.rolls[15]).toBe(115)
    expect(boosted.rolls[0]).toBe(97)
  })

  it('Iron Fist + Brawling Wyvern + Flamethrower: no boost (Fire is not Dragon)', () => {
    // Flamethrower is resolved Fire; the DRAGON-only grant never fires, so the roll
    // stays at the neutral 59.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const notBoosted = damageWith('MOVE_FLAMETHROWER', slotsWith('ABILITY_IRON_FIST', ['ABILITY_BRAWLING_WYVERN', null, null]))
    expect(neutral.rolls[15]).toBe(59)
    expect(notBoosted.rolls).toEqual(neutral.rolls)
  })
})

describe('Cycle 161 -- Mixed Martial Arts reads the DECLARED base type', () => {
  it('Iron Fist + Mixed Martial Arts + Slash: 1.3x (declared Normal, non-punch)', () => {
    // Slash (physical 60, Normal, sliceBased but not punchBased): 42*60=2520;
    // *296=745,920; /166=4493; /50=89; +2=91. No STAB (Garchomp is Dragon/Ground).
    // MMA grants PUNCH because gBattleMoves[move].type == TYPE_NORMAL
    // (src/abilities.cc:9899-9903); Iron Fist then applies uq(1.3):
    // applyModifier(1331,91) = floor((1331*91+512)/1024) = 118; 85% floor(118*.85)=100.
    const neutral = damage('MOVE_SLASH', null)
    const boosted = damageWith('MOVE_SLASH', slotsWith('ABILITY_IRON_FIST', ['ABILITY_MIXED_MARTIAL_ARTS', null, null]))
    expect(neutral.rolls[15]).toBe(91)
    expect(boosted.rolls[15]).toBe(118)
    expect(boosted.rolls[0]).toBe(100)
  })

  it('Iron Fist + Mixed Martial Arts + Flamethrower: no boost (declared Fire)', () => {
    // IsIronFistBoosted still passes the literal TYPE_NORMAL (src/battle_util.c:9373-
    // 9379), but MMA now reads the move's declared type, which is Fire.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const notBoosted = damageWith('MOVE_FLAMETHROWER', slotsWith('ABILITY_IRON_FIST', ['ABILITY_MIXED_MARTIAL_ARTS', null, null]))
    expect(neutral.rolls[15]).toBe(59)
    expect(notBoosted.rolls).toEqual(neutral.rolls)
  })

  it('an -ate retyped move keeps its DECLARED Normal type for the grant (Pixilate + Slash)', () => {
    // Pixilate only retypes a move whose ORIGINAL type is Normal (src/abilities.cc:296)
    // and grants pseudo-STAB on the retyped move; Slash stays declared NORMAL, so MMA
    // still grants PUNCH even though the resolved type is FAIRY (src/abilities.cc:9901).
    // Pixilate alone: STAB 1.5x -> applyModifier(1536,91) = 137; 85% floor(137*.85)=116.
    // Pixilate + MMA + Iron Fist: mulModifier(1536,1331)=1997 ->
    // applyModifier(1997,91) = 177; 85% floor(177*.85)=150.
    const pixilateOnly = damageWith('MOVE_SLASH', slotsWith('ABILITY_PIXILATE', [null, null, null]))
    const boosted = damageWith('MOVE_SLASH', slotsWith('ABILITY_IRON_FIST', ['ABILITY_MIXED_MARTIAL_ARTS', 'ABILITY_PIXILATE', null]))
    expect(pixilateOnly.rolls[15]).toBe(137)
    expect(pixilateOnly.rolls[0]).toBe(116)
    expect(boosted.rolls[15]).toBe(177)
    expect(boosted.rolls[0]).toBe(150)
  })
})

describe('Cycle 161 -- Reverbate reads the DECLARED base type', () => {
  it('Reverbate + a declared-Normal non-sound move is blocked by Soundproof', () => {
    // Reverbate's grant requires gBattleMoves[move].type == TYPE_NORMAL
    // (src/abilities.cc:10655-10661); Tackle is declared Normal, so IsSoundMove sees
    // the SOUND grant (src/battle_util.c:9379) and Soundproof's onImmune blocks it.
    const blocked = damageWith('MOVE_TACKLE', slots('ABILITY_REVERBATE'), slots('ABILITY_SOUNDPROOF'))
    expect(blocked.isImmune).toBe(true)
    expect(blocked.rolls.every((d) => d === 0)).toBe(true)
  })

  it('Reverbate + Flamethrower still hits through Soundproof (declared Fire)', () => {
    // The literal TYPE_NORMAL argument the consumer passes does not make a Fire move
    // Normal for the grant; Flamethrower keeps its neutral 59.
    const neutral = damage('MOVE_FLAMETHROWER', null)
    const hits = damageWith('MOVE_FLAMETHROWER', slots('ABILITY_REVERBATE'), slots('ABILITY_SOUNDPROOF'))
    expect(hits.isImmune).toBe(false)
    expect(neutral.rolls[15]).toBe(59)
    expect(hits.rolls).toEqual(neutral.rolls)
  })
})

describe('Cycle 161 -- Chestnut Axe still keys on the caller argument', () => {
  it("doesMoveMatchFlag: the ARGUMENT decides, not the declared/resolved types", () => {
    // src/abilities.cc:11711: `return moveType == TYPE_GRASS;` -- unique among the
    // four grants. The argument is deliberately out of step with the move's own
    // types in these calls to show which source the grant reads.
    const axe = slots('ABILITY_CHESTNUT_AXE')
    expect(doesMoveMatchFlag(axe, 'sliceBased', 'GRASS', {}, 'PHYSICAL', 'FIRE', 'FIRE')).toBe(true)
    expect(doesMoveMatchFlag(axe, 'sliceBased', 'FIRE', {}, 'PHYSICAL', 'GRASS', 'GRASS')).toBe(false)
  })

  it('Keen Edge consumer passes the RESOLVED type, so Fertilize-retyped Slash counts as Grass', () => {
    // Fertilize is an ATE_ABILITY(GRASS) (src/abilities.cc:6479): it only retypes a
    // declared-Normal move and grants pseudo-STAB on GRASS. Keen Edge/Chestnut Axe
    // then pass that resolved GRASS as the DoesMoveMatchFlag argument (:3676), so the
    // grant fires even though Slash is DECLARED Normal.
    // Fertilize alone: STAB 1.5x -> applyModifier(1536,91) = 137; 85% 116.
    // Fertilize + Chestnut Axe: mulModifier(1536,1331)=1997 ->
    // applyModifier(1997,91) = 177; 85% 150.
    const fertilizeOnly = damage('MOVE_SLASH', 'ABILITY_FERTILIZE')
    const axe = damageWith('MOVE_SLASH', slotsWith('ABILITY_CHESTNUT_AXE', ['ABILITY_FERTILIZE', null, null]))
    expect(fertilizeOnly.rolls[15]).toBe(137)
    expect(fertilizeOnly.rolls[0]).toBe(116)
    expect(axe.rolls[15]).toBe(177)
    expect(axe.rolls[0]).toBe(150)
  })

  it('Chestnut Axe + a static Grass slicing move: unchanged 1.3x (Leaf Blade)', () => {
    // Leaf Blade (physical 90, Grass, sliceBased): 42*90=3780; *296=1,118,880;
    // /166=6739; /50=134; +2=136. The static flag short-circuits DoesMoveMatchFlag
    // (:362-364), so the grant path is not consulted; the ability multiplier still
    // applies exactly once: applyModifier(1331,136) = 177.
    const neutral = damage('MOVE_LEAF_BLADE', null)
    const axe = damage('MOVE_LEAF_BLADE', 'ABILITY_CHESTNUT_AXE')
    expect(neutral.rolls[15]).toBe(136)
    expect(axe.rolls[15]).toBe(177)
  })
})

