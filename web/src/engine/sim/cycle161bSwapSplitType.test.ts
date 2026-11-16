/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 161b: SetSwapDamageCategory receives the RESOLVED move type, not the declared
// one. DoMoveDamageCalc hands its own `*moveType` (already run through
// GetMoveTypeInternal / the dynamicMoveType write-back) to SetSwapDamageCategory
// (src/battle_util.c:7771), which forwards it to every onSwapSplit hook (:7317,
// `void SetSwapDamageCategory(int battler, int target, MoveEnum move, Type moveType)`).
// The Mystic Blades family (src/abilities.cc:6487-6494, ABILITY_PONY_POWER aliasing it
// at :6565) then passes that argument straight into DoesMoveMatchFlag
// (:6491 `DoesMoveMatchFlag(battler, move, moveType, MOVE_FLAG_KEEN_EDGE)`), and
// Chestnut Axe's grant is literally `return moveType == TYPE_GRASS;` (:11706-11715).
// IS_MOVE_TYPE reads `dynamicMoveType` when set (include/battle.h:743) -- the same
// resolved type -- and the "-ate" family writes it (ATE_ABILITY, :295-301).
//
// Everything here is Garchomp (level 100, neutral nature, 31 IV / 0 EV) against a pure
// Normal Snorlax, no items/weather/field. Raw stats: Garchomp atk 296, spatk 196;
// Snorlax def 166, spdef 256. Core (:7524-7533): dmg = floor(level*2/5)+2 = 42;
// *power; *atk; /def; /50+2. CalcFinalDmg folds typeEff, abilityMultiplier and STAB
// into ONE UQ_4_12 modifier and applies it once: applyModifier(m, dmg) =
// floor((m*dmg+512)/1024), mulModifier(a,b) = floor((a*b+512)/1024), uq(1.3)=1331,
// uq(1.5)=1536, uq(1.0)=1024. Rolls are floor(dmg*(100-roll)/100), index 0 = roll 15
// (85%), index 15 = roll 0 (100%).
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

function slotsWith(ability: string | null, innates: [string | null, string | null, string | null]): AbilitySlots {
  return { ability, innates }
}

function damageWith(moveId: string, attackerSlots: AbilitySlots, defenderSlots: AbilitySlots = slotsWith(null, [null, null, null])) {
  return calculateMoveDamage(
    scenario({
      move: moveData(moveId),
      attacker: battler('SPECIES_GARCHOMP', { abilitySlots: attackerSlots }),
      defender: battler('SPECIES_SNORLAX', { abilitySlots: defenderSlots }),
    }),
  )
}

describe('Cycle 161b -- SetSwapDamageCategory reads the RESOLVED move type', () => {
  it('Fertilize + Chestnut Axe + Pony Power + Tackle: the Fertilize-retyped GRASS move swaps to SPECIAL', () => {
    // Tackle (physical 40, declared Normal, only the contact flag -- no sliceBased):
    // Fertilize is ATE_ABILITY(TYPE_GRASS) (src/abilities.cc:6519), so
    // GetMoveTypeInternal resolves the move to GRASS; that resolved type is what
    // DoMoveDamageCalc passes to SetSwapDamageCategory (:7771). Pony Power's
    // onSwapSplit is Mystic Blades' (:6565, :6489-6493): moveSplit PHYSICAL, then
    // DoesMoveMatchFlag(battler, move, GRASS, KEEN_EDGE) -- Tackle's own flags have
    // no slice bit (:362-364), so the grant loop runs and Chestnut Axe returns
    // `moveType == TYPE_GRASS` (:11711) -> TRUE. The split swaps to SPECIAL, so the
    // core uses spatk 196 vs spdef 256 (not atk 296 vs def 166).
    //
    // SPECIAL core: 42*40=1680; *196=329,280; /256=1286; /50=25; +2=27.
    // Ability multiplier: Chestnut Axe's own Keen Edge (1.3), then Pony Power's
    // onOffensiveMultiplier which calls Keen Edge AND Mystic Blades (:6560-6564,
    // Mystic Blades is itself Keen Edge's multiplier at :6488) -- 1.3 three times:
    // mulModifier(1024,1331)=1331; mulModifier(1331,1331)=1730;
    // mulModifier(1730,1331)=2249. Type effectiveness GRASS vs Normal = 1x, and
    // Fertilize's onStab grants pseudo-STAB 1.5 on the retyped move:
    // mulModifier(1024,2249)=2249; mulModifier(2249,1536)=3374;
    // applyModifier(3374,27) = floor((3374*27+512)/1024) = 89.
    const slots = slotsWith('ABILITY_FERTILIZE', ['ABILITY_CHESTNUT_AXE', 'ABILITY_PONY_POWER', null])
    const swapped = damageWith('MOVE_TACKLE', slots)
    expect(swapped.rolls[15]).toBe(89)
    expect(swapped.rolls[0]).toBe(75)

    // Same scenario minus Pony Power: nothing swaps (Chestnut Axe has no
    // onSwapSplit), so the PHYSICAL stats apply. Only Chestnut Axe multiplies:
    // 42*40=1680; *296=497,280; /166=2995; /50=59; +2=61;
    // mulModifier(1024,1331)=1331; mulModifier(1331,1536)=1997;
    // applyModifier(1997,61) = floor((1997*61+512)/1024) = 119.
    const unswapped = damageWith('MOVE_TACKLE', slotsWith('ABILITY_FERTILIZE', ['ABILITY_CHESTNUT_AXE', null, null]))
    expect(unswapped.rolls[15]).toBe(119)
    expect(unswapped.rolls[0]).toBe(101)
    expect(swapped.rolls).not.toEqual(unswapped.rolls)
  })

  it('without Fertilize the move stays Normal: no Chestnut Axe grant, no swap, PHYSICAL numbers', () => {
    // No -ate ability, so Tackle resolves to its declared NORMAL type and
    // SetSwapDamageCategory receives NORMAL (:7771). Chestnut Axe's grant rejects it
    // (:11711), so Pony Power's onSwapSplit does not fire and the split stays
    // PHYSICAL. Keen Edge's multiplier is gated on the same grant, so no ability
    // multiplier applies either: 42*40=1680; *296=497,280; /166=2995; /50=59; +2=61;
    // typeEff 1x, ability 1x, no STAB -> applyModifier(1024,61)=61.
    const withPonyPower = damageWith('MOVE_TACKLE', slotsWith('ABILITY_CHESTNUT_AXE', ['ABILITY_PONY_POWER', null, null]))
    expect(withPonyPower.rolls[15]).toBe(61)
    expect(withPonyPower.rolls[0]).toBe(51)

    // The same mon without Pony Power deals exactly the same damage -- the only
    // reason the positive case swaps is the resolved GRASS type.
    const withoutPonyPower = damageWith('MOVE_TACKLE', slotsWith('ABILITY_CHESTNUT_AXE', [null, null, null]))
    expect(withPonyPower.rolls).toEqual(withoutPonyPower.rolls)
  })

  it('a declared-Grass move retyped AWAY from Grass does not swap (Ivy Cudgel -> Ground)', () => {
    // Ivy Cudgel is DECLARED Grass (data/v2.65beta/moves.json) but carries
    // EFFECT_SYNCHRONOISE, whose GetMoveTypeInternal case (src/battle_main.c:5147-
    // 5163) takes the user's second type, else first, else third -- for Ogerpon the
    // mask decides (resolveMoveType's ogerponMaskType). Garchomp is Dragon/Ground,
    // so the RESOLVED type is GROUND even though the declared type is Grass. The C
    // passes that resolved GROUND to SetSwapDamageCategory (:7771), so Chestnut Axe
    // (`moveType == TYPE_GRASS`, :11711) grants nothing and Pony Power's swap stays
    // off. PHYSICAL core: 42*100=4200; *296=1,243,200; /166=7489; /50=149; +2=151.
    // Type effectiveness GROUND vs Normal = 1x, no ability multiplier, and Garchomp
    // has natural STAB on the resolved GROUND type (1.5x):
    // mulModifier(1024,1536)=1536; applyModifier(1536,151) =
    // floor((1536*151+512)/1024) = 227.
    const withPonyPower = damageWith('MOVE_IVY_CUDGEL', slotsWith('ABILITY_CHESTNUT_AXE', ['ABILITY_PONY_POWER', null, null]))
    expect(withPonyPower.rolls[15]).toBe(227)
    expect(withPonyPower.rolls[0]).toBe(192)

    const withoutPonyPower = damageWith('MOVE_IVY_CUDGEL', slotsWith('ABILITY_CHESTNUT_AXE', [null, null, null]))
    expect(withPonyPower.rolls).toEqual(withoutPonyPower.rolls)
  })
})
