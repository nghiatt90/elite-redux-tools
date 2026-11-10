/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibbb: DoesMoveMatchFlag's ability-grant fallback reaches Mystic Blades'
// onSwapSplit and Pinnacle Blade's onInfiltrate -- both C sites pass the REAL move
// type (not a TYPE_NORMAL dummy), so Chestnut Axe's GRASS-only KEEN_EDGE grant now
// changes the result.
//
// C at the pinned SHA:
// - DoesMoveMatchFlag (src/abilities.cc:358-386): the move's own static flag bit
//   wins outright; only if unset does it scan the ATTACKER's own ability slots via
//   onModifyMoveFlags. `moveType` is the caller's argument, not the move's own.
// - Mystic Blades onSwapSplit (src/abilities.cc:6488-6495):
//     CHECK(gBattleMoves[move].split == SPLIT_PHYSICAL)
//     CHECK(DoesMoveMatchFlag(battler, move, moveType, MOVE_FLAG_KEEN_EDGE))
//   -- the REAL move type. Aliases (Best Offense/Pony Power/Magus Blades/etc.) reuse
//   it through aliasSwapSplit.
// - Pinnacle Blade onInfiltrate (:8686-8689): DoesMoveMatchFlag(battler, move,
//   moveType, MOVE_FLAG_KEEN_EDGE) -> INFILTRATE_BREAK_SCREENS | INFILTRATE_SUBSTITUTE
//   -- again the REAL move type.
// - Chestnut Axe (:11706-11712) grants KEEN_EDGE (sliceBased) only when
//   `moveType == TYPE_GRASS`, and aliases Keen Edge's own 1.3x onOffensiveMultiplier
//   (Keen Edge itself: :3676-3679).
//
// Scenarios: Garchomp (level 100, neutral nature, 31 IV/0 EV) vs a pure Normal
// Snorlax, no items/weather. Raw stats (calcStat):
//   Garchomp atk 296, spatk 196; Snorlax def 166, spdef 256.
// Core (:7524-7533): dmg = floor(level*2/5)+2 = 42; *power; *atk; /def; /50+2.
// CalcFinalDmg folds typeEff, abilityMultiplier and STAB into ONE UQ_4_12 modifier
// (finalDamage.ts: #2 typeEff, #3 ability, #8 STAB) and applies it once:
// applyModifier(m,d) = floor((m*d+512)/1024), mulModifier(a,b) = floor((a*b+512)/1024),
// uq(n) = trunc(n*1024): uq(1.3)=1331, uq(0.5)=512, uq(1.0)=1024.
// The 16 rolls are floor(best.dmg*(100-roll)/100) with index 0 = roll 15 (85%) and
// index 15 = roll 0 (100%).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from '../calculate'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState } from '../types'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'
import { calcStat } from '../stats'
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

/** Reflect on the DEFENDER's side -- the screen relevant to a physical move
 * (calculate.ts screensApply: `split === 'PHYSICAL' && side.reflect`). */
function reflectField(): FieldBattleState {
  const base = fieldState()
  return { ...base, sides: { ...base.sides, defender: { ...base.sides.defender, reflect: true } } }
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

/** Two abilities on one battler: the chosen ability plus an innate. */
function slotsWith(ability: string | null, innates: [string | null, string | null, string | null]): AbilitySlots {
  return { ability, innates }
}

function damageWith(
  moveId: string,
  attackerSlots: AbilitySlots,
  defenderSlots: AbilitySlots = slots(null),
  defenderField: FieldBattleState = fieldState(),
) {
  return calculateMoveDamage(
    scenario({
      move: moveData(moveId),
      attacker: battler('SPECIES_GARCHOMP', { abilitySlots: attackerSlots }),
      defender: battler('SPECIES_SNORLAX', { abilitySlots: defenderSlots }),
      field: defenderField,
    }),
  )
}

function damage(moveId: string, attackerAbility: string | null, defenderAbility: string | null = null) {
  return damageWith(moveId, slots(attackerAbility), slots(defenderAbility))
}

describe('Cycle 150ibbb -- Mystic Blades onSwapSplit sees Chestnut Axe\'s KEEN_EDGE grant', () => {
  it('Mystic Blades + Chestnut Axe + Power Whip (Grass physical, no slice flag): swaps to SPECIAL with two 1.3x', () => {
    // Power Whip: type GRASS, split PHYSICAL, power 120, flags {contact,
    // mirrorMoveAffected} -- no sliceBased (verified in moves.json).
    // Chestnut Axe grants KEEN_EDGE because the caller's moveType is the REAL GRASS
    // (:6488-6495), so onSwapSplit swaps PHYSICAL -> SPECIAL.
    // Special core: 42*120=5040; *196=987840; /256=3858; /50=77; +2=79.
    // Ability multiplier: Mystic Blades AND Chestnut Axe both carry Keen Edge's
    // onOffensiveMultiplier (:6489, :11704), each firing because the slice grant now
    // matches -> mulModifier(uq(1.3),uq(1.3)) = 1730. TypeEff 1x, no STAB.
    // applyModifier(1730,79)=floor((136670+512)/1024)=133; 85% floor(133*.85)=113.
    const both = damageWith('MOVE_POWER_WHIP', slotsWith('ABILITY_MYSTIC_BLADES', ['ABILITY_CHESTNUT_AXE', null, null]))
    expect(both.rolls[15]).toBe(133)
    expect(both.rolls[0]).toBe(113)
  })

  it('Mystic Blades alone + Power Whip: no grant, split stays PHYSICAL', () => {
    // No Chestnut Axe, so DoesMoveMatchFlag finds no grant and nothing swaps; the
    // Keen Edge multiplier also never fires (both need the flag).
    // Physical core: 42*120=5040; *296=1491840; /166=8986; /50=179; +2=181.
    // finalModifier = uq(1.0)=1024 -> applyModifier(1024,181)=181;
    // 85% floor(181*.85)=153.
    const mysticOnly = damage('MOVE_POWER_WHIP', 'ABILITY_MYSTIC_BLADES')
    expect(mysticOnly.rolls[15]).toBe(181)
    expect(mysticOnly.rolls[0]).toBe(153)
  })

  it('Mystic Blades + Chestnut Axe + Tackle (Normal physical): no swap and no boost', () => {
    // Chestnut Axe only grants for GRASS (:11710-11711); Tackle is NORMAL, so
    // DoesMoveMatchFlag is false and neither the swap nor Keen Edge's 1.3x fires.
    // Physical core: 42*40=1680; *296=497280; /166=2995; /50=59; +2=61.
    const neutral = damage('MOVE_TACKLE', null)
    const both = damageWith('MOVE_TACKLE', slotsWith('ABILITY_MYSTIC_BLADES', ['ABILITY_CHESTNUT_AXE', null, null]))
    expect(neutral.rolls[15]).toBe(61)
    expect(both.rolls).toEqual(neutral.rolls)
  })

  it('Mystic Blades + Chestnut Axe + Energy Ball (Grass SPECIAL): CHECK(split == PHYSICAL) blocks the swap', () => {
    // :6490 rejects any non-physical move outright. The two Keen Edge 1.3x
    // multipliers still apply (the grant is type-based, not split-based).
    // Special core: 42*90=3780; *196=740880; /256=2894; /50=57; +2=59.
    // mulModifier(1331,1331)=1730 -> applyModifier(1730,59)=100; 85% -> 85.
    const neutral = damage('MOVE_ENERGY_BALL', null)
    const both = damageWith('MOVE_ENERGY_BALL', slotsWith('ABILITY_MYSTIC_BLADES', ['ABILITY_CHESTNUT_AXE', null, null]))
    expect(neutral.rolls[15]).toBe(59)
    expect(both.rolls[15]).toBe(100)
    expect(both.rolls[0]).toBe(85)
  })

  it('Mystic Blades alone + Leaf Blade (Grass physical, static sliceBased): still swaps', () => {
    // The static flag path is unchanged: Leaf Blade is sliceBased, so the swap and
    // the single Keen Edge 1.3x both fire.
    // Physical baseline (no ability): 42*90=3780; *296=1118880; /166=6739; /50=134;
    // +2=136. Swapped special core: 42*90*196/256 = 2894 -> /50+2 = 59.
    // applyModifier(1331,59)=77; 85% -> 65.
    const neutral = damage('MOVE_LEAF_BLADE', null)
    const mysticOnly = damage('MOVE_LEAF_BLADE', 'ABILITY_MYSTIC_BLADES')
    expect(neutral.rolls[15]).toBe(136)
    expect(mysticOnly.rolls[15]).toBe(77)
    expect(mysticOnly.rolls[0]).toBe(65)
  })
})

describe('Cycle 150ibbb -- Pinnacle Blade onInfiltrate sees Chestnut Axe\'s KEEN_EDGE grant', () => {
  it('Pinnacle Blade + Chestnut Axe + Power Whip: Reflect is bypassed', () => {
    // Pinnacle Blade's onInfiltrate (:8686-8689) calls DoesMoveMatchFlag with the
    // REAL move type, so Chestnut Axe's GRASS grant counts as KEEN_EDGE and
    // INFILTRATE_BREAK_SCREENS applies (battle_util.c:7651).
    // Physical core (Power Whip): 181 (see the Mystic Blades case above).
    // Ability multiplier: Chestnut Axe's Keen Edge 1.3x only (Pinnacle Blade has no
    // offensive multiplier) -> 1331. Screen would be a further 0.5x, but it is
    // bypassed. applyModifier(1331,181)=floor((240911+512)/1024)=235; 85% -> 199.
    // If the grant routing were a no-op the screen would still halve this to
    // applyModifier(mulModifier(1331,512)=666,181)=118, so this test fails on a no-op.
    const noScreen = damageWith('MOVE_POWER_WHIP', slotsWith('ABILITY_PINNACLE_BLADE', ['ABILITY_CHESTNUT_AXE', null, null]))
    const withReflect = damageWith(
      'MOVE_POWER_WHIP',
      slotsWith('ABILITY_PINNACLE_BLADE', ['ABILITY_CHESTNUT_AXE', null, null]),
      slots(null),
      reflectField(),
    )
    expect(noScreen.rolls[15]).toBe(235)
    expect(withReflect.rolls[15]).toBe(235)
    expect(withReflect.rolls[0]).toBe(199)
  })

  it('Pinnacle Blade alone + Power Whip: Reflect still halves', () => {
    // No grant, so the static slice flag is unset -> no infiltration. The screen is
    // a #9 finalMultiplier of uq(0.5)=512 (finalDamage.ts:126, singles).
    // applyModifier(512,181)=floor((92672+512)/1024)=91; 85% floor(91*.85)=77.
    const withReflect = damageWith('MOVE_POWER_WHIP', slots('ABILITY_PINNACLE_BLADE'), slots(null), reflectField())
    expect(withReflect.rolls[15]).toBe(91)
    expect(withReflect.rolls[0]).toBe(77)
  })

  it('Pinnacle Blade + Chestnut Axe + Tackle (Normal): Reflect still halves', () => {
    // Chestnut Axe only grants for GRASS, so the NORMAL Tackle gets no
    // infiltration; its own Keen Edge multiplier doesn't fire either.
    // Physical core 61; applyModifier(512,61)=floor((31232+512)/1024)=31;
    // 85% floor(31*.85)=26.
    const withReflect = damageWith(
      'MOVE_TACKLE',
      slotsWith('ABILITY_PINNACLE_BLADE', ['ABILITY_CHESTNUT_AXE', null, null]),
      slots(null),
      reflectField(),
    )
    expect(withReflect.rolls[15]).toBe(31)
    expect(withReflect.rolls[0]).toBe(26)
  })
})
