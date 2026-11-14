/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibce: onParentalBond must receive the RESOLVED move type (GET_MOVE_TYPE
// after the dynamic type is set), not the declared `gBattleMoves[move].type`.
//
// C at the pinned SHA:
// - GetParentalBondType(battler, target, move, moveType) forwards `moveType` to
//   gAbilities[ability].onParentalBond(battler, move, moveType)
//   (src/battle_script_commands.c:991,996-1003).
// - Cmd_attackcanceler: GET_MOVE_TYPE(gCurrentMove, moveType) (:1033) then
//   GetParentalBondType(..., moveType) (:1084).
// - AI_CalcDamage: SetTypeBeforeUsingMove + GET_MOVE_TYPE, CalculateMoveDamage
//   (&moveType), then GetParentalBondType(..., moveType) (battle_ai_util.c:660-682).
// - Hook bodies that read it: Dual Wield's DoesMoveMatchFlag(..., moveType,
//   MOVE_FLAG_KEEN_EDGE) (abilities.cc:5488), Raging Moth's TYPE_FIRE check
//   (:5839), Ice Cold Hunter's TYPE_ICE check (:8062).
//
// Ice Cold Hunter (:8057-8064) is this file's vehicle: it needs the RESOLVED type
// to be ICE and hail. A Normal move + Refrigerate (ATE_ABILITY, abilities.cc:295-301)
// resolves to ICE, so it triggers; a declared Ice move + Normalize (unconditional
// ->NORMAL, :1589) resolves to NORMAL, so it must not.
//
// Every damage number is hand-derived from the C and data/v2.65beta. Level-100
// neutral-nature raw stats (calcStat): Garchomp atk 296 / spatk 196; Snorlax
// def 166 / spdef 256. Core (:7524-7533): floor(level*2/5)+2; *power; *atk;
// /def; /50+2. STAB enters CalcFinalDmg's single accumulated modifier
// (finalDamage.ts #8), so a 1.5x STAB is applyModifier(1536, core). Rolls
// index 15 = 100%, 0 = 85%.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from '../calculate'
import { calcStat } from '../stats'
import type { AbilitySlots } from '../abilities/dispatch'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState, WeatherKind } from '../types'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'

import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import { runAttackCanceller } from './attackCanceller'
import { createBattleState, createBattlerState } from './create'
import { createRandomSource } from './rng'
import { WEATHER_HAIL_TEMPORARY } from './constants'
import { aiCalcDamage, type AiDamageDeps } from './ai/aiCalcDamage'
import type { RandomSource, SimBattleMon } from './state'

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
 * base stats -- same helper as cycle150ibcFlagConsumers.test.ts. */
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

function slots(ability: string | null, innates: [string | null, string | null, string | null] = [null, null, null]): AbilitySlots {
  return { ability, innates }
}

/** Garchomp attacker vs Snorlax defender at level 100, neutral natures, no items. */
function calc(moveId: string, attackerSlots: AbilitySlots, weather: WeatherKind = 'NONE', defenderSlots: AbilitySlots = slots(null)) {
  return calculateMoveDamage(
    scenario({
      move: moveData(moveId),
      attacker: battler('SPECIES_GARCHOMP', { abilitySlots: attackerSlots }),
      defender: battler('SPECIES_SNORLAX', { abilitySlots: defenderSlots }),
      field: fieldState({ weather }),
    }),
  )
}

// ---------------------------------------------------------------------------
// Item A/B: calculateMoveDamage's hit plan reads the RESOLVED type (A), and the
// negative cases that would fire on the declared type alone (B).
// ---------------------------------------------------------------------------

describe('cycle 150ibce (A/B) - the calculator passes GET_MOVE_TYPE to onParentalBond', () => {
  it('Refrigerate retypes Tackle to Ice, so Ice Cold Hunter gets its second hit in hail', () => {
    // Tackle: Normal, physical, 40. Core with Garchomp atk 296 vs Snorlax Def 166:
    // 42*40*296/166 = 2995; /50 = 59; +2 = 61. Refrigerate's onStab grants STAB
    // (hasStabOverride, dispatchCalc.ts) since the RESOLVED type is ICE;
    // CalcFinalDmg folds it into the accumulated modifier: applyModifier(1536, 61) = 92.
    // ICE_COLD_HUNTER has no case in GetParentalBondMultiplier (battle_util.c:7483-7513),
    // so both hits are 1.0x: rolls[15] = 92, totalRolls[15] = 184.
    // Ice vs Normal is 1x, so no type multiplier enters.
    const result = calc('MOVE_TACKLE', slots('ABILITY_ICE_COLD_HUNTER', ['ABILITY_REFRIGERATE', null, null]), 'HAIL')
    expect(result.effectiveMoveType).toBe('ICE')
    expect(result.hitCount).toBe(2)
    expect(result.rolls[15]).toBe(92)
    expect(result.totalRolls?.[15]).toBe(184)
  })

  it('negative: a declared Normal move with no -ate stays Normal, so Ice Cold Hunter never triggers', () => {
    // No onMoveType ability: resolveMoveType keeps Tackle's declared NORMAL. Core 61,
    // no STAB (Garchomp is Dragon/Ground): rolls[15] = 61 and no hit plan.
    const result = calc('MOVE_TACKLE', slots('ABILITY_ICE_COLD_HUNTER'), 'HAIL')
    expect(result.effectiveMoveType).toBe('NORMAL')
    expect(result.hitCount).toBeNull()
    expect(result.rolls[15]).toBe(61)
  })

  it('positive control: a declared Ice move triggers without any -ate ability', () => {
    // Ice Beam: Ice, special, 90. Core with Garchomp SpAtk 196 vs Snorlax SpDef 256:
    // 42*90*196/256 = 2893; /50 = 57; +2 = 59. Garchomp is Dragon/Ground and Ice Cold
    // Hunter defines no onStab, so there is no STAB: rolls[15] = 59, totalRolls[15] = 118.
    const result = calc('MOVE_ICE_BEAM', slots('ABILITY_ICE_COLD_HUNTER'), 'HAIL')
    expect(result.hitCount).toBe(2)
    expect(result.rolls[15]).toBe(59)
    expect(result.totalRolls?.[15]).toBe(118)
  })

  it('negative: Normalize resolves a declared Ice move to Normal, so Ice Cold Hunter does not trigger', () => {
    // Normalize's onMoveType is unconditional ->NORMAL (abilities.cc:1589), so the
    // declared-Ice Ice Beam resolves to NORMAL. Core is the same 59 (spread is not
    // per-type); no STAB (Garchomp is not Normal, Normalize defines no onStab),
    // Normal vs Normal is 1x: rolls[15] = 59, no hit plan. Passing the declared ICE
    // type here (the pre-fix behaviour) would wrongly give hitCount 2.
    const result = calc('MOVE_ICE_BEAM', slots('ABILITY_ICE_COLD_HUNTER', ['ABILITY_NORMALIZE', null, null]), 'HAIL')
    expect(result.effectiveMoveType).toBe('NORMAL')
    expect(result.hitCount).toBeNull()
    expect(result.rolls[15]).toBe(59)
  })
})

// ---------------------------------------------------------------------------
// Item C: the live Cmd_attackcanceler setup reads the RESOLVED type too.
// ---------------------------------------------------------------------------

const data = loadSimData()

function fixedRng(value: number): RandomSource {
  return { random16: () => value }
}

function foeMon(speciesId: string, ability: string, moves: string[]): TrainerMonData {
  return {
    species: speciesId,
    item: 'ITEM_NONE',
    nature: 'NATURE_HARDY',
    ability,
    evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
    moves,
    ironPill: false,
    hiddenPowerType: 'TYPE_NORMAL',
  }
}

function trainer(mons: TrainerMonData[]): TrainerData {
  return {
    ...data.trainersById.get('TRAINER_SAWYER_1')!,
    noSwitching: true,
    parties: { ace: mons, elite: mons, hell: mons },
  }
}

interface PlayerSpec {
  species: string
  ability: string | null
  item?: string | null
  moves: string[]
  innates?: [string | null, string | null, string | null]
}

/** Level-50 player vs a same-level foe (the driver derives the opponent level from
 * the player's highest level). Player innates are cleared unless the scenario needs
 * them. */
function session(player: PlayerSpec, foe: TrainerMonData, rng: RandomSource = fixedRng(1)): BattleSession {
  const party = buildPlayerParty(
    [{ species: player.species, level: 50, item: player.item ?? null, moves: player.moves }],
    50,
    data,
  )
  party[0]!.abilities = { ability: player.ability, innates: player.innates ?? [null, null, null] }
  return createSession({ data, playerParty: party, opponentTrainer: trainer([foe]), rng })
}

describe('cycle 150ibce (C) - Cmd_attackcanceler passes GET_MOVE_TYPE to GetParentalBondType', () => {
  it('Refrigerate + Ice Cold Hunter sets multiHitCounter 2, and the live loop lands both hits', () => {
    const dual = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_ICE_COLD_HUNTER', innates: ['ABILITY_REFRIGERATE', null, null], moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_SNORLAX', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    dual.state.field.weather = WEATHER_HAIL_TEMPORARY
    // battle_script_commands.c:1033 (GET_MOVE_TYPE, Refrigerate -> ICE) then
    // :1084-1091 (parentalBondTrigger = GetParentalBondType(..., moveType),
    // GetParentalBondCount -> 2, so multiHitCounter = parentalBondOn =
    // parentalBondInitialCount = 2).
    const result = runAttackCanceller(dual.state, 0, 1, 'MOVE_TACKLE', data.dataContext.move('MOVE_TACKLE'), [])
    expect(result.cancelledBy).toBeNull()
    expect(dual.state.battlers[0]!.turn.multiHitCounter).toBe(2)
    expect(dual.state.battlers[0]!.turn.parentalBondTrigger).toBe('ABILITY_ICE_COLD_HUNTER')

    // The real turn loop: both sessions are hail and both face the same foe; the
    // control has no Refrigerate, so its Tackle stays Normal and hits once.
    const live = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_ICE_COLD_HUNTER', innates: ['ABILITY_REFRIGERATE', null, null], moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_SNORLAX', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    const control = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_ICE_COLD_HUNTER', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_SNORLAX', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    live.state.field.weather = WEATHER_HAIL_TEMPORARY
    control.state.field.weather = WEATHER_HAIL_TEMPORARY
    stepTurn(live, buildMoveAction(live.state, data, 0, 'MOVE_TACKLE'), null)
    stepTurn(control, buildMoveAction(control.state, data, 0, 'MOVE_TACKLE'), null)
    expect(live.state.battlers[1]!.mon.hp).toBeLessThan(control.state.battlers[1]!.mon.hp)
  })

  it('negative: Normalize turns a declared Ice move Normal, so no counter is set', () => {
    const neg = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_ICE_COLD_HUNTER', innates: ['ABILITY_NORMALIZE', null, null], moves: ['MOVE_ICE_BEAM'] },
      foeMon('SPECIES_SNORLAX', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    neg.state.field.weather = WEATHER_HAIL_TEMPORARY
    const result = runAttackCanceller(neg.state, 0, 1, 'MOVE_ICE_BEAM', data.dataContext.move('MOVE_ICE_BEAM'), [])
    expect(result.cancelledBy).toBeNull()
    expect(neg.state.battlers[0]!.turn.multiHitCounter).toBe(0)
    expect(neg.state.battlers[0]!.turn.parentalBondTrigger).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Item D: AI_CalcDamage passes the moveType CalculateMoveDamage wrote back.
// ---------------------------------------------------------------------------

const aiDeps: AiDamageDeps = {
  grounding: data.grounding,
  turnOrder: data.turnOrder,
  statStageRatios: data.statStageRatios,
  dataContext: data.dataContext,
  inverseBattle: false,
  moveData: data.moveData,
  typeChart: data.typeChart,
  inverseTypeChart: data.inverseTypeChart,
  moveBehaviors: data.moveBehaviors,
  battleConstants: data.battleConstants,
  holdEffectIds: data.holdEffectIds,
}

function aiMon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  return {
    speciesId: 'SPECIES_MUDKIP',
    rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: ['WATER', 'MYSTERY', 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: { ability: null, innates: [null, null, null] },
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

/** battler 0 = player, battler 1 = the AI; weather = hail. */
function aiState(attacker: Partial<SimBattleMon>, defender: Partial<SimBattleMon>): ReturnType<typeof createBattleState> {
  const state = createBattleState({
    battlers: [createBattlerState(0, aiMon(defender), 0), createBattlerState(1, aiMon(attacker), 0)],
    rng: createRandomSource(1),
  })
  state.field.weather = WEATHER_HAIL_TEMPORARY
  return state
}

describe('cycle 150ibce (D) - AI_CalcDamage passes the resolved type to GetParentalBondType', () => {
  it('the -ate case gets the two-hit estimate', () => {
    // Level 50, atk 100 vs def 90, Tackle 40: floor(50*2/5)+2 = 22; 22*40*100/90
    // = 977; /50 = 19; +2 = 21. Refrigerate grants STAB (resolved ICE):
    // applyModifier(1536, 21) = 32. Crit 1.5x on 21 = 32, then the same 1.5x STAB
    // modifier = 48; blend idiv(48 + 32*23, 24) = 32.
    // GetParentalBondMultiplier is 1.0 for both ICE_COLD_HUNTER hits, so the C's
    // `dmg = ApplyModifier(sum, dmg)` (battle_ai_util.c:735-742) is
    // applyModifier(2048, 32) = 64.
    const s = aiState(
      { abilities: { ability: 'ABILITY_ICE_COLD_HUNTER', innates: ['ABILITY_REFRIGERATE', null, null] }, moves: ['MOVE_TACKLE', null, null, null] },
      { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
    )
    const out = aiCalcDamage(s, 'MOVE_TACKLE', 1, 0, aiDeps)
    expect(out.dmg).toBe(64)
  })

  it('negative: Normalize leaves Ice Beam Normal, so the estimate stays one hit', () => {
    // Level 50, SpAtk 80 vs SpDef 85, Ice Beam 90: 22*90*80/85 = 1863; /50 = 37;
    // +2 = 39. Resolved NORMAL, no STAB: 39. Crit 1.5x = 59; blend
    // idiv(59 + 39*23, 24) = 39. No parental bond trigger, so no multiplier.
    const s = aiState(
      { abilities: { ability: 'ABILITY_ICE_COLD_HUNTER', innates: ['ABILITY_NORMALIZE', null, null] }, moves: ['MOVE_ICE_BEAM', null, null, null] },
      { types: ['NORMAL', 'MYSTERY', 'MYSTERY'] },
    )
    const out = aiCalcDamage(s, 'MOVE_ICE_BEAM', 1, 0, aiDeps)
    expect(out.dmg).toBe(39)
  })
})
