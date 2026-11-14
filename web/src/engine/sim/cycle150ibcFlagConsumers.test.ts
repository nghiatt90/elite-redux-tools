/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 150ibc: the remaining calc-side move-flag consumers now go through
// DoesMoveMatchFlag's ability-grant fallback instead of the static moves.json bits.
//
// C at the pinned SHA:
// - DoesMoveMatchFlag (src/abilities.cc:358-386): the move's static flag bit wins
//   outright; only if unset does it scan the move USER's own ability slots via
//   onModifyMoveFlags. The `moveType` argument belongs to the caller, not the move.
// - IsIronFistBoosted / IsStrikerBoosted / IsMegaLauncherBoosted / IsSoundMove all
//   pass the literal TYPE_NORMAL (src/battle_util.c:9373-9381), so a grant whose
//   condition reads moveType only answers through those wrappers when the dummy
//   happens to match (Mixed Martial Arts: `gBattleMoves[move].type == TYPE_NORMAL`).
// - IsKeenEdge (:9381) passes the REAL move type (Chestnut Axe grants only GRASS).
// - Magical Fists' onChooseOffensiveStat (:9158-9162), Power Fists'
//   onChooseDefensiveStat (:3691-3695) and Roundhouse's onChooseDefensiveStat
//   (:5072-5084) all read IsIronFistBoosted/IsStrikerBoosted on `battler`, which the
//   dispatchers set to battlerAtk for BOTH the attacker and defender runs
//   (battle_util.c:7243-7244 and :7392-7394). The flag scan is therefore always the
//   ATTACKER's slots.
// - Precise Fist's onCrit (:4755-4759) reads IsIronFistBoosted on the ability
//   HOLDER (CalcCritChanceStage's loop, battle_script_commands.c:1529-1536).
// - Soundproof's onImmune (:1052-1058) reads IsSoundMove on the ATTACKER
//   (onImmune's second argument, battle_util.c:8962).
// - Dual Wield's onParentalBond (:5485-5491) reads IsMegaLauncherBoosted (NORMAL) or
//   DoesMoveMatchFlag(..., moveType, MOVE_FLAG_KEEN_EDGE) with the REAL type;
//   Raging Boxer's (:4160-4164) reads IsIronFistBoosted. Both run with the attacker
//   as `battler` (GetParentalBondType, battle_script_commands.c:990-1004).
//
// Every damage number is hand-derived from the C and data/v2.65beta. Level-100
// neutral-nature raw stats (calcStat): Garchomp atk 296 / def 226 / spatk 196 /
// spdef 206; Snorlax def 166 / spdef 256. Core (:7524-7533):
// dmg = floor(level*2/5)+2; *power; *atk; /def; /50+2. CalcFinalDmg folds typeEff,
// ability and the parental-bond multiplier into ONE UQ_4_12 modifier and applies it
// once: applyModifier(m,d) = floor((m*d+512)/1024), mulModifier(a,b) =
// floor((a*b+512)/1024), uq(n) = trunc(n*1024). Rolls index 15 = 100%, 0 = 85%.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { calculateMoveDamage, type DamageCalcScenario, type MoveData } from '../calculate'
import { calcStat } from '../stats'
import type { AbilitySlots } from '../abilities/dispatch'
import type { BattleConstants, BattlerBattleState, ConditionBattlerContext, FieldBattleState } from '../types'
import type { TypeChart } from '../typeEffectiveness'
import type { MoveBehaviors } from '../basePower'

import { buildPlayerParty } from './driver/buildParty'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { buildMoveAction, createSession, stepTurn, type BattleSession } from './driver/session'
import type { RandomSource } from './state'

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
 * base stats -- copied from calculate.test.ts / cycle150ibMoveFlags.test.ts. */
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

/** One calculateMoveDamage call: Garchomp attacker by default, Snorlax defender by
 * default, no items/weather/field, so type effectiveness is 1x for Normal and Grass. */
function damage(
  moveId: string,
  attackerSlots: AbilitySlots,
  defenderSlots: AbilitySlots,
  defenderSpecies = 'SPECIES_SNORLAX',
  attackerSpecies = 'SPECIES_GARCHOMP',
) {
  return calculateMoveDamage(
    scenario({
      move: moveData(moveId),
      attacker: battler(attackerSpecies, { abilitySlots: attackerSlots }),
      defender: battler(defenderSpecies, { abilitySlots: defenderSlots }),
    }),
  )
}

// Mixed Martial Arts (src/abilities.cc:9898-9904) grants PUNCH and KICK to Normal
// moves; every IsIronFistBoosted/IsStrikerBoosted wrapper passes TYPE_NORMAL, so the
// grant answers through those dummy-typed callers as well.
const MMA: [string | null, string | null, string | null] = ['ABILITY_MIXED_MARTIAL_ARTS', null, null]

// ---------------------------------------------------------------------------
// Item A: onChooseOffensiveStat / onChooseDefensiveStat read the attacker's flag scan.
// ---------------------------------------------------------------------------

describe('cycle 150ibc (A) - choose-stat hooks read DoesMoveMatchFlag', () => {
  it('Magical Fists uses SpAtk when Mixed Martial Arts grants PUNCH to a Normal move', () => {
    // Tackle (Normal, physical, not punch): core with atk 296 = 42*40*296/166/50+2 = 61.
    // Without the grant, Iron Fist's multiplier (3-offensive-multiplier-b.ts:19) is also
    // off, so the answer is a plain 61.
    // With the grant, statToUse becomes SpAtk 196: 42*40*196/166 = 1983; /50 = 39; +2 = 41.
    // Iron Fist's 1.3x then applies: applyModifier(1331, 41) = floor((54571+512)/1024) = 53.
    const withoutGrant = damage('MOVE_TACKLE', slots('ABILITY_MAGICAL_FISTS'), slots(null))
    const withGrant = damage('MOVE_TACKLE', slots('ABILITY_MAGICAL_FISTS', MMA), slots(null))
    expect(withoutGrant.rolls[15]).toBe(61)
    expect(withGrant.rolls[15]).toBe(53)
  })

  it('Power Fists picks SpDef when Mixed Martial Arts grants PUNCH to a Normal move', () => {
    // Power Fists is the ATTACKER's ability: onChooseDefensiveStat's `battler` is
    // battlerAtk (:3691-3695), and the unscoped hook only fires in the attacker's run.
    // Without the grant the defender uses Def 166 -> 61 (same core as above).
    // With the grant it uses SpDef 256: 42*40*296/256 = 1942; /50 = 38; +2 = 40.
    // Power Fists also aliases Iron Fist's 1.3x: applyModifier(1331, 40) = 52.
    const withoutGrant = damage('MOVE_TACKLE', slots('ABILITY_POWER_FISTS'), slots(null))
    const withGrant = damage('MOVE_TACKLE', slots('ABILITY_POWER_FISTS', MMA), slots(null))
    expect(withoutGrant.rolls[15]).toBe(61)
    expect(withGrant.rolls[15]).toBe(52)
  })

  it('Roundhouse picks the weaker defence when Mixed Martial Arts grants KICK', () => {
    // Defender Garchomp: Def 226 > SpDef 206, so defenderDefComparison is 'spdef'.
    // Without the grant the physical default is Def 226: 42*40*296/226 = 2200; /50 = 44; +2 = 46.
    // With the grant Roundhouse switches to SpDef 206: 2413; /50 = 48; +2 = 50.
    const withoutGrant = damage('MOVE_TACKLE', slots('ABILITY_ROUNDHOUSE'), slots(null), 'SPECIES_GARCHOMP')
    const withGrant = damage('MOVE_TACKLE', slots('ABILITY_ROUNDHOUSE', MMA), slots(null), 'SPECIES_GARCHOMP')
    expect(withoutGrant.rolls[15]).toBe(46)
    expect(withGrant.rolls[15]).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// Item B: Precise Fist's onCrit reads the HOLDER's flag scan.
// ---------------------------------------------------------------------------

describe("cycle 150ibc (B) - Precise Fist's crit stage reads DoesMoveMatchFlag", () => {
  it('a grant-only PUNCH move adds +1 crit stage (24 -> 8 denominator)', () => {
    // Stage 0 -> 1/24, stage 1 -> 1/8 (crit.ts / GEN7_CHANCE).
    const withoutGrant = damage('MOVE_TACKLE', slots('ABILITY_PRECISE_FIST'), slots(null))
    const withGrant = damage('MOVE_TACKLE', slots('ABILITY_PRECISE_FIST', MMA), slots(null))
    expect(withoutGrant.critChanceDenominator).toBe(24)
    expect(withGrant.critChanceDenominator).toBe(8)
  })

  it('negative: the DEFENDER holding the grant does not reach the attacker-held Precise Fist', () => {
    // CalcCritChanceStage's loop passes each battler as its own `battler`
    // (battle_script_commands.c:1529-1536), so Precise Fist reads the ATTACKER's slots
    // on the attacker run. A grant on the defender is therefore invisible to it; the
    // defender's own Mixed Martial Arts has no onCrit hook to fire.
    const result = damage('MOVE_TACKLE', slots('ABILITY_PRECISE_FIST'), slots('ABILITY_MIXED_MARTIAL_ARTS'))
    expect(result.critChanceDenominator).toBe(24)
  })
})

// ---------------------------------------------------------------------------
// Item C: Soundproof's onImmune reads the ATTACKER's IsSoundMove.
// ---------------------------------------------------------------------------

describe('cycle 150ibc (C) - Soundproof blocks a move made sound by the ATTACKER', () => {
  it('Reverbate on the attacker makes Tackle sound, so Soundproof blocks it', () => {
    // Reverbate grants SOUND when the move's DECLARED type is Normal
    // (gBattleMoves[move].type, src/abilities.cc:10657) -- Tackle qualifies -- and
    // IsSoundMove passes the literal TYPE_NORMAL dummy, so the grant answers.
    const blocked = damage('MOVE_TACKLE', slots('ABILITY_REVERBATE'), slots('ABILITY_SOUNDPROOF'))
    expect(blocked.isImmune).toBe(true)
    expect(blocked.rolls.every((d) => d === 0)).toBe(true)
  })

  it('negative: a Reverbate grant on the DEFENDER side does not make the move sound', () => {
    // onImmune's C hook calls IsSoundMove(attacker, move) (:1054), not the holder.
    const hits = damage('MOVE_TACKLE', slots(null), slots('ABILITY_SOUNDPROOF', ['ABILITY_REVERBATE', null, null]))
    expect(hits.isImmune).toBe(false)
    expect(hits.rolls[15]).toBe(61)
  })

  it('negative: without any grant a non-sound move hits Soundproof', () => {
    const hits = damage('MOVE_TACKLE', slots(null), slots('ABILITY_SOUNDPROOF'))
    expect(hits.isImmune).toBe(false)
    expect(hits.rolls[15]).toBe(61)
  })
})

// ---------------------------------------------------------------------------
// Item D: Dual Wield / Raging Boxer onParentalBond read the attacker's flag scan.
// ---------------------------------------------------------------------------

describe('cycle 150ibc (D) - onParentalBond reads DoesMoveMatchFlag', () => {
  it('Dual Wield gets a second hit on a Grass move made Keen Edge by Chestnut Axe', () => {
    // Energy Ball (Grass, special, 90, no static slice flag): 42*90*196/256 = 2894;
    // /50 = 57; +2 = 59. Chestnut Axe grants KEEN_EDGE because the REAL moveType is
    // GRASS (src/abilities.cc:5488), and its own Keen Edge offence is 1.3x:
    // applyModifier(1331, 59) = 77 without a bonus hit.
    // DUAL_WIELD's GetParentalBondMultiplier case has no REQUIRE(turn)
    // (battle_util.c:7483-7513), so hit 0 is 0.7x too: mulModifier(1331, 716) = 931;
    // applyModifier(931, 59) = 54 per hit; both hits total 108 at the 100% roll.
    const withoutGrant = damage('MOVE_ENERGY_BALL', slots('ABILITY_DUAL_WIELD'), slots(null))
    const withGrant = damage('MOVE_ENERGY_BALL', slots('ABILITY_DUAL_WIELD', ['ABILITY_CHESTNUT_AXE', null, null]), slots(null))
    expect(withoutGrant.hitCount).toBeNull()
    expect(withoutGrant.rolls[15]).toBe(59)
    expect(withGrant.hitCount).toBe(2)
    expect(withGrant.rolls[15]).toBe(54)
    expect(withGrant.totalRolls?.[15]).toBe(108)
  })

  it('Raging Boxer gets PRIMAL_MAW when Mixed Martial Arts grants PUNCH', () => {
    // Tackle: core with atk 296 vs Def 166 = 61 at 100%.
    // PRIMAL_MAW's case passes REQUIRE(turn) (battle_util.c:7481-7483), so hit 0 is
    // 1.0x (61) and hit 1 is 0.4x: mulModifier(1024, 409) = 409;
    // applyModifier(409, 61) = 24; the two-hit total is 85.
    const withoutGrant = damage('MOVE_TACKLE', slots('ABILITY_RAGING_BOXER'), slots(null))
    const withGrant = damage('MOVE_TACKLE', slots('ABILITY_RAGING_BOXER', MMA), slots(null))
    expect(withoutGrant.hitCount).toBeNull()
    expect(withoutGrant.rolls[15]).toBe(61)
    expect(withGrant.hitCount).toBe(2)
    expect(withGrant.rolls[15]).toBe(61)
    expect(withGrant.totalRolls?.[15]).toBe(85)
  })
})

// ---------------------------------------------------------------------------
// Session-level cases: the real turn loop, not hand-built state.
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
 * them, so no unrelated onEntry innate perturbs the turn. */
function session(player: PlayerSpec, foe: TrainerMonData, rng: RandomSource = fixedRng(1)): BattleSession {
  const party = buildPlayerParty(
    [{ species: player.species, level: 50, item: player.item ?? null, moves: player.moves }],
    50,
    data,
  )
  party[0]!.abilities = { ability: player.ability, innates: player.innates ?? [null, null, null] }
  return createSession({ data, playerParty: party, opponentTrainer: trainer([foe]), rng })
}

describe('cycle 150ibc - session-level flag consumers', () => {
  it('Soundproof blocks through the attacker’s Reverbate grant, and only through it', () => {
    const blocked = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_REVERBATE', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_SOUNDPROOF', ['MOVE_TACKLE']),
    )
    const blockedFoe = blocked.state.battlers[1]!
    stepTurn(blocked, buildMoveAction(blocked.state, data, 0, 'MOVE_TACKLE'), null)
    expect(blockedFoe.mon.hp).toBe(blockedFoe.mon.maxHp)

    // Negative: the same Soundproof target is damaged when the attacker has no grant.
    const hit = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_NONE', moves: ['MOVE_TACKLE'] },
      foeMon('SPECIES_MAGIKARP', 'ABILITY_SOUNDPROOF', ['MOVE_TACKLE']),
    )
    const hitFoe = hit.state.battlers[1]!
    stepTurn(hit, buildMoveAction(hit.state, data, 0, 'MOVE_TACKLE'), null)
    expect(hitFoe.mon.hp).toBeLessThan(hitFoe.mon.maxHp)
  })

  it('Dual Wield + a Chestnut Axe innate lands a second hit through the live turn loop', () => {
    // Both sessions run the same Energy Ball. The single-hit control keeps Chestnut
    // Axe as the chosen ability, so both have the same 1.3x Keen Edge multiplier and
    // the ONLY difference is Dual Wield's extra 0.7x hit. Before the grant plumbing
    // the two sessions would deal identical damage; afterwards the Dual Wield run
    // deals 0.7x (hit 0) + 0.7x (hit 1) = 1.4x of the control.
    const dual = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_DUAL_WIELD', innates: ['ABILITY_CHESTNUT_AXE', null, null], moves: ['MOVE_ENERGY_BALL'] },
      foeMon('SPECIES_SNORLAX', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    const single = session(
      { species: 'SPECIES_MUDKIP', ability: 'ABILITY_CHESTNUT_AXE', moves: ['MOVE_ENERGY_BALL'] },
      foeMon('SPECIES_SNORLAX', 'ABILITY_NONE', ['MOVE_TACKLE']),
    )
    const dualFoe = dual.state.battlers[1]!
    const singleFoe = single.state.battlers[1]!
    stepTurn(dual, buildMoveAction(dual.state, data, 0, 'MOVE_ENERGY_BALL'), null)
    stepTurn(single, buildMoveAction(single.state, data, 0, 'MOVE_ENERGY_BALL'), null)
    expect(dualFoe.mon.hp).toBeLessThan(singleFoe.mon.hp)
  })
})
