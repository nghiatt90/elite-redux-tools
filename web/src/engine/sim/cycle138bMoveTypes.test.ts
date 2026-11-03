/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 138b: GetMoveTypeInternal gaps (battle_main.c:5093-5204) and Tempest Storm.
//
// Every expectation below is derived from the C, with the arithmetic spelled out.
// Damage shortcut (same as cycle 138's): level 50, Atk/Sp Atk == Def/Sp Def == 100,
// so DoMoveDamageCalcInternal's opening line is
//     dmg = ((level * 2) / 5) + 2 = 22
//     dmg = 22 * power * 100 / 100; dmg = dmg / 50 + 2
// which reduces to `22 * power / 50 + 2`, all divisions truncating. The random
// factor is `dmg = dmg * (100 - roll) / 100` with roll = Random() % 16
// (battle_util.c:7796-7800), i.e. roll 0 is 100% and roll 15 is 85%.
import { describe, expect, it } from 'vitest'

import type { DamageCalcScenario } from '../calculate'
import { resolveMoveType } from '../calculate'
import type { BridgeDeps } from './bridge'
import { buildBattlerBattleState, buildFieldBattleState } from './bridge'
import {
  STATUS3_ON_AIR,
  STATUS4_ELECTRIFIED,
  STATUS_FIELD_ELECTRIC_TERRAIN,
  STATUS_FIELD_GRAVITY,
  STATUS_FIELD_ION_DELUGE,
} from './constants'
import { createBattleState, createBattlerState } from './create'
import type { BridgeDamageResolverDeps } from './damageResolver'
import { createBridgeDamageResolver } from './damageResolver'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import type { BattleState, RandomSource, SimBattleMon } from './state'
import type { DamageResolver, TurnLoopDeps, TurnOutcome } from './turn'
import { executeTurn } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const SIM = loadSimData()
const DATA_CONTEXT = SIM.dataContext
const RATIOS = SIM.statStageRatios
const TURN_ORDER = NEUTRAL_TURN_ORDER_CONTEXT

const freshAbilities = (): SimBattleMon['abilities'] => ({ ability: null, innates: [null, null, null] })

const STATS = { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = SIM.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { ...STATS },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [20, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: freshAbilities(),
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
    // Last, so an override wins AND is cloned.
    types: [...(overrides.types ?? [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'])] as [
      string,
      string,
      string,
    ],
  }
}

/** Draws the scripted values in order (0 once they run out). */
function scriptedRng(values: number[]): RandomSource {
  let idx = 0
  return {
    random16: () => {
      const value = values[idx] ?? 0
      idx++
      return value
    },
  }
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource = scriptedRng([])): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
  })
}

function viewOf(moveId: string): TurnOrderMoveView {
  const m = DATA_CONTEXT.move(moveId)
  if (!m) throw new Error(`moves.json has no ${moveId}`)
  return {
    id: m.id,
    priority: m.priority ?? 0,
    effect: m.effect,
    isStatus: m.split === 'STATUS',
    resolvedType: m.type ?? 'NORMAL',
    power: m.power,
    flags: m.flags,
    split: m.split ?? 'PHYSICAL',
    hasStrongJawBoostFlag: false,
    isKeenEdge: false,
    naturalGiftPriority: 0,
    isGrassyTerrainAffected: false,
    myceliumMightAffected: false,
  }
}

function useMove(target: number, moveId: string): ChosenAction {
  const view = viewOf(moveId)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function bridgeFor(state: BattleState): BridgeDeps {
  return {
    grounding: groundingFor(SIM, state),
    turnOrder: TURN_ORDER,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    inverseBattle: false,
  }
}

function bridgeDamage(state: BattleState, random: RandomSource): DamageResolver {
  const deps: BridgeDamageResolverDeps = {
    ...bridgeFor(state),
    moveData: SIM.moveData,
    typeChart: SIM.typeChart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    random,
  }
  return createBridgeDamageResolver(deps)
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: TURN_ORDER,
    grounding: groundingFor(SIM, state),
    damage,
    statStageRatios: RATIOS,
    dataContext: DATA_CONTEXT,
    hazardTypes: { typeChart: SIM.typeChart, inverseTypeChart: SIM.inverseTypeChart, inverseBattle: false },
  }
}

function actionOf(out: TurnOutcome, battlerId: number) {
  const action = out.actions.find((a) => a.battlerId === battlerId)
  if (!action) throw new Error(`no action for battler ${battlerId}`)
  return action
}

/** GetMoveTypeInternal through the simulator's own bridge (damageResolver.moveType). */
function resolvedType(state: BattleState, moveId: string): string | null {
  return bridgeDamage(state, scriptedRng([])).moveType!(state, 0, 1, moveId).moveType
}

/** One direct `resolve` with a fixed non-crit roll, returning the resolved type and damage. */
function resolveMove(state: BattleState, moveId: string, roll = 0) {
  const rng = scriptedRng([roll])
  const res = bridgeDamage(state, rng).resolve(state, 0, 1, useMove(1, moveId), {
    targetHasActedThisTurn: false,
    // 1 % 24 != 0: no crit, and passing it skips the resolver's crit draw so the
    // single scripted value below is the damage roll.
    critRoll: 1,
  })
  return res
}

/** The static calculator's own view: exactly what buildScenarioFor produces, with
 * `attackerTerrainAffected` only if the caller sets it (the sim's damage path
 * always sets it for Terrain Pulse, which is why this test builds it by hand). */
function scenarioFor(state: BattleState, moveId: string, attackerTerrainAffected?: boolean): DamageCalcScenario {
  const roles = { attackerId: 0, defenderId: 1 }
  const bridge = bridgeFor(state)
  const attacker = buildBattlerBattleState(state, 0, roles, bridge)
  const defender = buildBattlerBattleState(state, 1, roles, bridge)
  const field = buildFieldBattleState(state, roles, bridge)
  const move = SIM.moveData(moveId)
  if (!move) throw new Error(`no move data for ${moveId}`)
  return {
    move,
    attacker: attacker.battler,
    defender: defender.battler,
    field: field.field,
    typeChart: SIM.typeChart,
    inverseTypeChart: SIM.inverseTypeChart,
    moveBehaviors: SIM.moveBehaviors,
    battleConstants: SIM.battleConstants,
    attackerActsFirst: true,
    sameMoveTurnsInARow: 0,
    hitCount: 0,
    defenderIsSwitching: false,
    magnitudeTier: null,
    attackerRolloutCounter: 0,
    attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: false,
    beatUpBaseAttack: 100,
    beatUpHitCount: 1,
    defenderUsedGlaiveRush: false,
    ...(attackerTerrainAffected === undefined ? {} : { attackerTerrainAffected }),
  }
}

// ---------------------------------------------------------------------------
// 1. Struggle -- battle_main.c:5095-5096
// ---------------------------------------------------------------------------
describe('cycle 138b - Struggle stays NORMAL and bypasses every retype', () => {
  it('Pixilate does not retype Struggle; Tackle from the same holder is FAIRY (negative control)', () => {
    // :5094-5096 -- `switch (move) { case MOVE_STRUGGLE: return TYPE_NORMAL; }` runs
    // BEFORE the effect switch (:5129), the Ion Deluge/Electrify block (:5196-5198)
    // and the onMoveType loop (:5200-5201), so Pixilate never sees the move.
    const state = battle(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_PIXILATE', innates: [null, null, null] } }),
      monFor('SPECIES_PORYGON'),
    )
    expect(resolvedType(state, 'MOVE_STRUGGLE')).toBe('NORMAL')
    // Negative control: the same Pixilate holder's Tackle DOES reach the hook.
    expect(resolvedType(state, 'MOVE_TACKLE')).toBe('FAIRY')
  })

  it('Electrify and Ion Deluge do not retype Struggle; they do retype Tackle (negative control)', () => {
    // battle_main.c:5196-5198 is only reachable for moves that did NOT return in the
    // move-ID switch (:5129-5192 cases all return, Play Nice's own `break`s included).
    const electrified = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_PORYGON'))
    electrified.battlers[0]!.statuses4 |= STATUS4_ELECTRIFIED
    expect(resolvedType(electrified, 'MOVE_STRUGGLE')).toBe('NORMAL')
    expect(resolvedType(electrified, 'MOVE_TACKLE')).toBe('ELECTRIC')

    const ionDeluge = battle(monFor('SPECIES_MUDKIP'), monFor('SPECIES_PORYGON'))
    ionDeluge.field.statuses |= STATUS_FIELD_ION_DELUGE
    expect(resolvedType(ionDeluge, 'MOVE_STRUGGLE')).toBe('NORMAL')
    expect(resolvedType(ionDeluge, 'MOVE_TACKLE')).toBe('ELECTRIC')
  })

  it('deals 24 to a pure Ghost, with no STAB -- CalcTypeEffectivenessMultiplier (:7986-7994) skips the fold', () => {
    // 22 * 50 / 50 + 2 = 24 (power 50). StabMultiplierInHalves's Struggle arm
    // (battle_util.c:7451) returns 2 = 1.0x, so the 1.5x multiplier never applies.
    // A Normal-type move would be immune here; the fold is skipped outright.
    const state = battle(
      monFor('SPECIES_MUDKIP', { moves: ['MOVE_STRUGGLE', null, null, null], pp: [1, 0, 0, 0] }),
      monFor('SPECIES_MISDREAVUS'),
    )
    const res = resolveMove(state, 'MOVE_STRUGGLE', 0)
    expect(res.resolvedMoveType).toBe('NORMAL')
    expect(res.targetDamage).toBe(24)
  })
})

// ---------------------------------------------------------------------------
// 2. Raging Bull -- battle_main.c:5098-5107
// ---------------------------------------------------------------------------
describe('cycle 138b - Raging Bull types by the attacker species, then falls through', () => {
  // 22 * 90 / 50 + 2 = 41 (power 90, physical, Atk/Def 100).
  const bull = (attacker: SimBattleMon) => resolveMove(battle(attacker, monFor('SPECIES_PORYGON')), 'MOVE_RAGING_BULL', 0)

  it('Combat Breed is FIGHTING: 2x vs Normal and 1.5x STAB -- 41 -> 123', () => {
    // :5099-5100. Type 2.0: ApplyModifier(uq(2.0), 41) = floor((41*8192 + 2048)/4096)
    // = 82. STAB 1.5 (Tauros is Fighting-type): floor((82*6144 + 2048)/4096) = 123.
    const res = bull(monFor('SPECIES_TAUROS_PALDEAN_COMBAT_BREED'))
    expect(res.resolvedMoveType).toBe('FIGHTING')
    expect(res.targetDamage).toBe(123)
  })

  it('Blaze Breed is FIRE and Aqua Breed is WATER: 1x vs Normal, 1.5x STAB -- 41 -> 62', () => {
    // :5101-5105. 41*1.5 = 61.5 -> 62 with the C's ApplyModifier rounding.
    const blaze = bull(monFor('SPECIES_TAUROS_PALDEAN_BLAZE_BREED'))
    expect(blaze.resolvedMoveType).toBe('FIRE')
    expect(blaze.targetDamage).toBe(62)

    const aqua = bull(monFor('SPECIES_TAUROS_PALDEAN_AQUA_BREED'))
    expect(aqua.resolvedMoveType).toBe('WATER')
    expect(aqua.targetDamage).toBe(62)
  })

  it('a non-Tauros user falls through to NORMAL and still reaches the -ate hook (negative controls)', () => {
    // :5106-5107 `break` -> declared type (TYPE_NORMAL) -> :5200-5201 onMoveType.
    const plain = bull(monFor('SPECIES_PORYGON'))
    expect(plain.resolvedMoveType).toBe('NORMAL')
    expect(plain.targetDamage).toBe(62) // Normal STAB on the Normal attacker

    const pixilated = bull(
      monFor('SPECIES_PORYGON', { abilities: { ability: 'ABILITY_PIXILATE', innates: [null, null, null] } }),
    )
    expect(pixilated.resolvedMoveType).toBe('FAIRY')
    expect(pixilated.targetDamage).not.toBe(123) // no Fighting-type super effectiveness anywhere
  })
})

// ---------------------------------------------------------------------------
// 3. Weather Ball -- battle_main.c:5113-5122
// ---------------------------------------------------------------------------
describe('cycle 138b - Weather Ball follows Chloroplast, then Aurora Borealis, then weather', () => {
  const weatherBall = (attacker: SimBattleMon, weather = 0) => {
    const state = battle(attacker, monFor('SPECIES_PORYGON'))
    state.field.weather = weather
    return resolveMove(state, 'MOVE_WEATHER_BALL', 0)
  }

  it('no weather and no ability keeps NORMAL and 50 power -- 22*50/50+2 = 24', () => {
    // :5113-5122 breaks when IsWeatherActive(WEATHER_ANY) fails, so the declared
    // Normal type survives into :5196-5201. CalcMoveBasePower (:6829-6834) leaves
    // the power at 50 too. Mudkip (Water) has no STAB on it.
    const res = weatherBall(monFor('SPECIES_MUDKIP'))
    expect(res.resolvedMoveType).toBe('NORMAL')
    expect(res.targetDamage).toBe(24)
  })

  it('Chloroplast is FIRE with no weather and doubles the power -- 22*100/50+2 = 46', () => {
    // :5114 `if (HasChloroplast(battlerAtk)) return TYPE_FIRE;` runs before the
    // REQUIRE, and :6830 doubles the base power for the same reason.
    const res = weatherBall(monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_CHLOROPLAST', innates: [null, null, null] } }))
    expect(res.resolvedMoveType).toBe('FIRE')
    expect(res.targetDamage).toBe(46)
  })

  it('Chloroplast wins over Aurora Borealis (:5114 before :5115); Aurora alone is ICE with its own STAB', () => {
    const both = weatherBall(
      monFor('SPECIES_MUDKIP', {
        abilities: { ability: 'ABILITY_CHLOROPLAST', innates: ['ABILITY_AURORA_BOREALIS', null, null] },
      }),
    )
    expect(both.resolvedMoveType).toBe('FIRE')

    const aurora = weatherBall(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_AURORA_BOREALIS', innates: [null, null, null] } }),
    )
    expect(aurora.resolvedMoveType).toBe('ICE')
    // :6830 doubles the power for Aurora Borealis too, and its own onStab hook
    // (src/abilities.cc:3872-3875, `moveType == TYPE_ICE`) makes this a 1.5x STAB
    // move for a Water-type user: 46 -> floor((46*6144 + 2048)/4096) = 69.
    expect(aurora.targetDamage).toBe(69)
  })

  it('rain without either ability is WATER (declared type would be NORMAL -- negative control)', () => {
    // :5117 `if (gBattleWeather & WEATHER_RAIN_ANY) return TYPE_WATER;`, and
    // :6832-6833 doubles the power because the weather is active. Mudkip is a
    // Water type, so this is Water STAB (1.5x, 46 -> 69) and then temporary
    // rain's own 1.5x Water boost (:7573-7575): floor((69*6144 + 2048)/4096) = 104.
    const res = weatherBall(monFor('SPECIES_MUDKIP'), 1 /* WEATHER_RAIN_TEMPORARY */)
    expect(res.resolvedMoveType).toBe('WATER')
    expect(res.targetDamage).toBe(104)
  })
})

// ---------------------------------------------------------------------------
// 4. Terrain Pulse -- battle_main.c:5173-5191, IsBattlerTerrainAffected :4901-4928
// ---------------------------------------------------------------------------
describe('cycle 138b - Terrain Pulse reads the ATTACKER grounding, not the defender', () => {
  const pulse = (attacker: SimBattleMon, opts: { terrain?: boolean; gravity?: boolean } = {}) => {
    const state = battle(attacker, monFor('SPECIES_PORYGON'))
    if (opts.terrain !== false) state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    if (opts.gravity) state.field.statuses |= STATUS_FIELD_GRAVITY
    return resolvedType(state, 'MOVE_TERRAIN_PULSE')
  }
  const withAbility = (id: string | null, base = monFor('SPECIES_PIDGEY')): SimBattleMon => ({
    ...base,
    abilities: { ability: id, innates: [null, null, null] },
  })

  it('a grounded attacker becomes ELECTRIC under Electric Terrain', () => {
    // :5175 REQUIRE(IsBattlerTerrainAffected(battlerAtk, STATUS_FIELD_TERRAIN_ANY))
    // then :5177-5178 `case STATUS_FIELD_ELECTRIC_TERRAIN: return TYPE_ELECTRIC;`.
    expect(pulse(monFor('SPECIES_MUDKIP'))).toBe('ELECTRIC')
    // Negative control: no terrain at all -> REQUIRE fails -> declared NORMAL.
    expect(pulse(monFor('SPECIES_MUDKIP'), { terrain: false })).toBe('NORMAL')
  })

  it('a Flying-type attacker is not affected; Iron Ball and Gravity restore it', () => {
    // CheckGroundingEffects (:6647-6660) beats the Flying-type check in
    // IsBattlerGrounded (:6679-6683).
    expect(pulse(monFor('SPECIES_PIDGEY'))).toBe('NORMAL')
    expect(pulse(monFor('SPECIES_PIDGEY', { itemId: 'ITEM_IRON_BALL' }))).toBe('ELECTRIC')
    expect(pulse(monFor('SPECIES_PIDGEY'), { gravity: true })).toBe('ELECTRIC')
  })

  it('Air Balloon and Levitate keep a Flying-type attacker airborne', () => {
    // CheckLevitatingEffects (:6662-6672): Air Balloon item, then the Levitate hook.
    expect(pulse(monFor('SPECIES_PIDGEY', { itemId: 'ITEM_AIR_BALLOON' }))).toBe('NORMAL')
    expect(pulse(withAbility('ABILITY_LEVITATE'))).toBe('NORMAL')
  })

  it('semi-invulnerability wins even over Iron Ball, and allowTerrainIfAirborne opts back in', () => {
    // :4905-4906 `if (IS_BATTLER_SEMI_INVULNERABLE(battler)) return FALSE;` runs
    // before both grounding tests.
    const airborne = battle(monFor('SPECIES_PIDGEY', { itemId: 'ITEM_IRON_BALL' }), monFor('SPECIES_PORYGON'))
    airborne.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN
    airborne.battlers[0]!.statuses3 |= STATUS3_ON_AIR
    expect(resolvedType(airborne, 'MOVE_TERRAIN_PULSE')).toBe('NORMAL')

    // :4926 ON_ABILITY(battler, FALSE, allowTerrainIfAirborne & terrain)
    expect(pulse(withAbility('ABILITY_ELECTRIC_SURGE'))).toBe('ELECTRIC')
  })

  it('the static calculator raises a note for the unrepresentable airborne case', () => {
    // DamageCalcScenario has no field for allowTerrainIfAirborne; with no
    // attackerTerrainAffected the calculator can only answer "airborne -> not
    // affected" and must say so rather than guess.
    const state = battle(monFor('SPECIES_PIDGEY'), monFor('SPECIES_PORYGON'))
    state.field.statuses |= STATUS_FIELD_ELECTRIC_TERRAIN

    const bare = resolveMoveType(scenarioFor(state, 'MOVE_TERRAIN_PULSE'), 'NORMAL')
    expect(bare.moveType).toBe('NORMAL')
    expect(bare.unmodelled.some((n) => n.includes('allowTerrainIfAirborne'))).toBe(true)

    // With the sim's own answer supplied there is no note left to raise.
    const supplied = resolveMoveType(scenarioFor(state, 'MOVE_TERRAIN_PULSE', true), 'NORMAL')
    expect(supplied.moveType).toBe('ELECTRIC')
    expect(supplied.unmodelled.filter((n) => n.includes('allowTerrainIfAirborne'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Tera Starstorm -- battle_main.c:5109-5111
// ---------------------------------------------------------------------------
describe('cycle 138b - Tera Starstorm is STELLAR only for a Stellar user', () => {
  // 22 * 120 / 50 + 2 = 54. The type chart's STELLAR row has NORMAL at 1.0
  // (types.json), so only STAB can change it.
  const starstorm = (attacker: SimBattleMon) => resolveMove(battle(attacker, monFor('SPECIES_PORYGON')), 'MOVE_TERA_STARSTORM', 0)

  it('Terapagos-Stellar gets STELLAR and 1.5x STAB -- 54 -> 81', () => {
    // :5110 REQUIRE(IS_BATTLER_OF_TYPE(battlerAtk, TYPE_STELLAR)) succeeds; STAB is
    // 1.5 because the attacker's own type is STELLAR too: floor((54*6144 + 2048)/4096) = 81.
    const res = starstorm(monFor('SPECIES_TERAPAGOS_STELLAR'))
    expect(res.resolvedMoveType).toBe('STELLAR')
    expect(res.targetDamage).toBe(81)
  })

  it('any other user keeps NORMAL -- 54 with no STAB (negative control)', () => {
    // :5111 REQUIRE fails -> `break` -> declared TYPE_NORMAL at :5194.
    const res = starstorm(monFor('SPECIES_MUDKIP'))
    expect(res.resolvedMoveType).toBe('NORMAL')
    expect(res.targetDamage).toBe(54)
  })

  it('a non-Stellar user still reaches the -ate hook', () => {
    // The same `break` reaches :5200-5201, so Pixilate retypes the fallen-through move.
    const pixilated = starstorm(
      monFor('SPECIES_MUDKIP', { abilities: { ability: 'ABILITY_PIXILATE', innates: [null, null, null] } }),
    )
    expect(pixilated.resolvedMoveType).toBe('FAIRY')
  })
})

// ---------------------------------------------------------------------------
// 6. Tempest Storm -- no generated behaviour, so EFFECT_HIT + BattleScript_EffectHit
// ---------------------------------------------------------------------------
describe('cycle 138b - Tempest Storm runs BattleScript_EffectHit like the generator says', () => {
  // Moves.json has effect null (MoveBehavior.proto:19's proto3 default), power 0,
  // split STATUS, accuracy 0. The generated script is therefore
  // BattleScript_EffectHit (data/battle_scripts_1.s:2857-2884): attackcanceler,
  // accuracycheck, attackstring, ppreduce, damagecalc, adjustdamage.
  //
  // Damage: CalcMoveBasePower's `if (basePower == 0) basePower = 1`
  // (battle_util.c:6932) makes the 0-power move strike at power 1, so
  // dmg = 22 * 1 * 100 / 100 / 50 + 2 = 2. Status split uses Sp. Atk/Sp. Def
  // (CalcAttackStat/CalcDefenseStat, battle_util.c:7219, 7400-7405). The declared
  // type is ELECTRIC (moves.json), and Pikachu gets 1.5x STAB: 2 -> 3. The random
  // factor is 85..100%: roll 0 keeps 3, roll 15 gives floor(3*85/100) = 2
  // (`if (dmg == 0) dmg = 1` never fires here).
  // Speeds differ so the order is forced and the speed-tie Random() never touches
  // the scripted stream (the same reason cycle 138's FAST_STATS/SLOW_STATS exist).
  const stormBattle = (defender: SimBattleMon, rng: number[]) => {
    const state = battle(
      monFor('SPECIES_PIKACHU', {
        rawStats: { ...STATS, spe: 200 },
        moves: ['MOVE_TEMPEST_STORM', null, null, null],
        pp: [5, 0, 0, 0],
      }),
      { ...defender, rawStats: { ...defender.rawStats, spe: 50 } },
      scriptedRng(rng),
    )
    return { state, deps: loopDeps(state, bridgeDamage(state, state.rng)) }
  }

  it('hits for 3 at the 100% roll and deducts PP -- no "status effects" note', () => {
    // Draw order: Cmd_accuracycheck (:1398-1447) first (accuracy 0 is 101, i.e.
    // cannot miss, but still consumes a Random()), then Cmd_critcalc, then the
    // 85..100% roll. 0 -> hit, 1 -> no crit (1 % 24), 0 -> 100%.
    const { state, deps } = stormBattle(monFor('SPECIES_PORYGON'), [0, 1, 0])
    const out = executeTurn(state, [useMove(1, 'MOVE_TEMPEST_STORM'), null], deps)

    const action = actionOf(out, 0)
    expect(action.targetDamage).toBe(3)
    expect(action.missed).toBe(false)
    expect(state.battlers[1]!.mon.hp).toBe(97)
    // Cmd_ppreduce (battle_script_commands.c:1460-1506) runs on the hit path.
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
    expect(action.unmodelled.filter((note) => note.includes('status effects are not modelled'))).toEqual([])
  })

  it('the 85% roll is 2, not 3', () => {
    const { state, deps } = stormBattle(monFor('SPECIES_PORYGON'), [0, 1, 15])
    const out = executeTurn(state, [useMove(1, 'MOVE_TEMPEST_STORM'), null], deps)
    expect(actionOf(out, 0).targetDamage).toBe(2)
    expect(state.battlers[1]!.mon.hp).toBe(98)
  })

  it('a Ground-type target is immune, and the move still costs PP (negative control)', () => {
    // CalcTypeEffectivenessMultiplier returns UQ_4_12(0.0) for Electric vs Ground and
    // the split's own 1.0 flattening only applies when the modifier is non-zero
    // (:7992), so this is a real immunity, not a status-move neutralisation.
    const { state, deps } = stormBattle(monFor('SPECIES_SANDSHREW'), [0, 1, 0])
    const out = executeTurn(state, [useMove(1, 'MOVE_TEMPEST_STORM'), null], deps)
    expect(actionOf(out, 0).targetDamage).toBe(0)
    expect(state.battlers[1]!.mon.hp).toBe(100)
    expect(state.battlers[0]!.mon.pp[0]).toBe(4)
  })
})
