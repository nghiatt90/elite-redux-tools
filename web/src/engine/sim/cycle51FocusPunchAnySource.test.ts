/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 51: CalcMoveBasePower's Focus Punch override and Self-Destruct doubling read the
// ATTACKER's OWN round struct, whoever dealt the damage.
//
// C lines checked:
//   src/battle_util.c:6851-6852  case EFFECT_FOCUS_PUNCH: if (gRoundStructs[battlerAtk].physicalDmg ||
//                                gRoundStructs[battlerAtk].specialDmg) basePower = 40;
//   src/battle_util.c:6901-6903  case MOVE_SELF_DESTRUCT: if (... same two counters ...) basePower *= 2;
//   src/battle_script_commands.c:1935-1959  the ONLY writers of physicalDmg/specialDmg; both are skipped
//                                under HITMARKER_PASSIVE_DAMAGE, so passive damage never sets them.
//   battle_ai_main.c:190-203     AI scoring reads the live gRoundStructs; the memset of those structs runs
//                                AFTER AI_CalcDamage returns, so the AI sees this turn's counters.
//
// Doubles party layout (buildBattleState): battler 0 and battler 2 are the player's party slots 0
// and 1, battler 1 and battler 3 the opponent's party slots 0 and 1.
//
// Every draw is scripted to 0: accuracy 0 % 100 is a hit, the crit test 0 % denominator === 0 is a
// crit, and 0 % 16 = 0 indexes the max (100%) roll at `values[15]`. The hit and no-hit runs
// therefore use exactly the same crit and percentile, and the ONLY difference is the base power:
// 40 vs the declared 150 for Focus Punch, 400 vs 200 for Self-Destruct.
import { describe, expect, it } from 'vitest'

import { calculateMoveDamage, type DamageCalcScenario } from '../calculate'
import { idiv } from '../fixed'
import { getMoveTargetCount } from '../moveTargetCount'
import { buildBattlerBattleState, buildFieldBattleState } from './bridge'
import { createBattleState, createBattlerState } from './create'
import { createBridgeDamageResolver } from './damageResolver'
import { buildBattleState } from './driver/battleFormat'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { loadSimData } from './driver/loadSimData'
import { aiDamageDepsFor, groundingFor } from './driver/session'
import { getBattlerBattleMoveTargetFlags } from './moveTargetFlags'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimBattleMon, SimPartyMon } from './state'
import type { DamageResolveContext, DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn, isBattlerAlive } from './turn'
import type { ChosenAction, TurnOrderMoveView } from './turnOrder'
import { NEUTRAL_TURN_ORDER_CONTEXT } from './turnOrder'

const data = loadSimData()
const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

const FOCUS_PUNCH = 'MOVE_FOCUS_PUNCH'
const SELF_DESTRUCT = 'MOVE_SELF_DESTRUCT'

/** Constant 0 stream: hit, crit, and the 100% roll on every single draw (see the header). */
function scriptRng(): RandomSource {
  return { random16: () => 0 }
}

/** The move under test sits on player slot `attackerSlot` (battler `attackerSlot * 2`); the
 * other two slots carry Tackle. */
function playerParty(attackerMove: string, attackerSlot = 0): SimPartyMon[] {
  const moves = [['MOVE_TACKLE'], ['MOVE_TACKLE'], ['MOVE_TACKLE']]
  moves[attackerSlot] = [attackerMove]
  return buildPlayerParty(
    moves.map((m) => ({ species: 'SPECIES_SWAMPERT', level: 50, moves: m })),
    50,
    data,
  )
}

/** The trainer's elite party, with the first two slots' moves replaced; slot 0 is battler 1 and
 * slot 1 is battler 3. */
function opponentParty(slotMoves: string[][]): SimPartyMon[] {
  const party = buildOpponentParty(trainer, 'elite', 50, data)
  slotMoves.forEach((ids, index) => {
    const entry = party[index]
    if (!entry) throw new Error(`TRAINER_SAWYER_1's elite party has no slot ${index}`)
    entry.moves = [ids[0] ?? null, ids[1] ?? null, ids[2] ?? null, ids[3] ?? null]
    entry.pp = entry.moves.map((id) => (id ? data.dataContext.move(id)?.pp ?? 0 : 0)) as SimPartyMon['pp']
  })
  return party
}

/** Distinct speeds so SortBattlersBySpeed's tie-break draw never fires; abilities and items
 * cleared so no ability hook or held item adds a draw. Fixture setup, not an outcome. */
function normalize(state: BattleState, speeds = [200, 180, 160, 140]): void {
  for (let i = 0; i < state.battlersCount; i++) {
    const mon = state.battlers[i]!.mon
    mon.rawStats.spe = speeds[i]!
    mon.abilities = { ability: null, innates: [null, null, null] }
    mon.itemId = null
  }
}

function doublesState(
  rng: RandomSource,
  attackerMove: string,
  slotMoves: string[][],
  speeds?: number[],
  attackerSlot = 0,
): BattleState {
  const state = buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(attackerMove, attackerSlot), opponentParties: [opponentParty(slotMoves)], rng },
  )
  normalize(state, speeds)
  return state
}

function moveView(moveId: string): TurnOrderMoveView {
  const m = data.dataContext.move(moveId)
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

/** The sim's action builder (not a React hook): an explicit target id. */
function useMove(target: number | null, moveId: string): ChosenAction {
  const view = moveView(moveId)
  return { action: 'USE_MOVE', moveToBeUsed: view, chosenMove: view, target }
}

function resolverFor(state: BattleState, rng: RandomSource): DamageResolver {
  return createBridgeDamageResolver({
    dataContext: data.dataContext,
    grounding: groundingFor(data, state),
    turnOrder: data.turnOrder,
    statStageRatios: data.statStageRatios,
    inverseBattle: false,
    moveData: data.moveData,
    typeChart: data.typeChart,
    inverseTypeChart: data.inverseTypeChart,
    moveBehaviors: data.moveBehaviors,
    battleConstants: data.battleConstants,
    random: rng,
  })
}

interface ResolveRecord {
  attackerId: number
  targetId: number
  moveId: string
  context: DamageResolveContext | undefined
  /** The attacker's round counters AT RESOLVE TIME. executeTurn's end-of-turn
   * TurnValuesCleanUp zeroes gRoundStructs (turn.ts:5749), so the live state no
   * longer carries them once the call returns. */
  physicalDmg: number
  specialDmg: number
  physicalBattlerId: number
}

/** Delegates to the real resolver (so hits really land) while recording the exact context and
 * round struct the turn loop saw. */
function recording(resolver: DamageResolver, records: ResolveRecord[]): DamageResolver {
  return {
    ...resolver,
    resolve(state, attackerId, targetId, action, context) {
      const round = state.battlers[attackerId]!.round
      records.push({
        attackerId,
        targetId,
        moveId: action.chosenMove?.id ?? '',
        context,
        physicalDmg: round.physicalDmg,
        specialDmg: round.specialDmg,
        physicalBattlerId: round.physicalBattlerId,
      })
      return resolver.resolve(state, attackerId, targetId, action, context)
    },
  }
}

function loopDeps(state: BattleState, damage: DamageResolver): TurnLoopDeps {
  return {
    turnOrder: NEUTRAL_TURN_ORDER_CONTEXT,
    grounding: groundingFor(data, state),
    damage,
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    hazardTypes: { typeChart: data.typeChart, inverseTypeChart: data.inverseTypeChart, inverseBattle: false },
  }
}

/** The engine's own number for this move with DamageContext.attackerWasHitThisTurn stated
 * explicitly -- independent of the sim wiring under test. The scenario mirrors the one
 * damageResolver.ts's buildScenarioFor assembles for these moves (targetCount included, because
 * Self-Destruct's FOES_AND_ALLY pass takes CalcFinalDmg's x0.75); with the constant-0 stream the
 * crit fires and the index-15 (100%) roll is picked, exactly as the resolver's draws do. */
function engineDamage(
  state: BattleState,
  attackerId: number,
  targetId: number,
  moveId: string,
  wasHit: boolean,
  context: DamageResolveContext | undefined,
): number {
  const roles = { attackerId, defenderId: targetId }
  const bridgeDeps = {
    grounding: groundingFor(data, state),
    turnOrder: data.turnOrder,
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    inverseBattle: false,
  }
  const attacker = buildBattlerBattleState(state, attackerId, roles, bridgeDeps)
  const defender = buildBattlerBattleState(state, targetId, roles, bridgeDeps)
  const field = buildFieldBattleState(state, roles, bridgeDeps)
  const statusDeps = { dataContext: data.dataContext, grounding: bridgeDeps.grounding }
  const targetFlag = getBattlerBattleMoveTargetFlags(
    state,
    attackerId,
    moveId,
    data.dataContext.move(moveId),
    bridgeDeps,
    statusDeps,
  )
  const targetCount = getMoveTargetCount({
    moveId,
    targetFlag,
    atkAlive: isBattlerAlive(state, attackerId),
    defAlive: isBattlerAlive(state, targetId),
    defPartnerAlive: isBattlerAlive(state, targetId ^ 2),
    atkPartnerAlive: isBattlerAlive(state, attackerId ^ 2),
  })
  const scenario: DamageCalcScenario = {
    move: data.moveData(moveId)!,
    attacker: attacker.battler,
    defender: defender.battler,
    field: field.field,
    typeChart: data.typeChart,
    inverseTypeChart: data.inverseTypeChart,
    moveBehaviors: data.moveBehaviors,
    battleConstants: data.battleConstants,
    attackerActsFirst: !context?.targetHasActedThisTurn,
    sameMoveTurnsInARow: 0,
    hitCount: 0,
    defenderIsSwitching: Boolean(context?.defenderIsSwitching),
    magnitudeTier: null,
    attackerRolloutCounter: 0,
    attackerHasDefenseCurl: false,
    attackerWasHitThisTurn: wasHit,
    beatUpBaseAttack: attacker.battler.rawStats.atk,
    beatUpHitCount: 1,
    defenderUsedGlaiveRush: false,
    targetCount,
  }
  const result = calculateMoveDamage(scenario)
  const values = result.critChanceDenominator !== null ? result.critRolls : result.rolls
  return values![15]!
}

/** The fresh state the expected-value calls run against (same species/stats, no hits yet). */
function expectedState(attackerMove: string, speeds?: number[], attackerSlot = 0): BattleState {
  return doublesState(scriptRng(), attackerMove, [[], []], speeds, attackerSlot)
}

describe('cycle51: Focus Punch reads the attacker round struct, any damager (battle_util.c:6851-6852)', () => {
  it('1. doubles: an ALLY hits the attacker earlier in the turn -> 40 power', () => {
    const rng = scriptRng()
    const state = doublesState(rng, FOCUS_PUNCH, [[], []])
    const records: ResolveRecord[] = []

    const out = executeTurn(
      state,
      // Focus Punch is priority -3, so battler 2's priority-0 Tackle runs first even at equal speed.
      [useMove(1, FOCUS_PUNCH), null, useMove(0, 'MOVE_TACKLE'), null],
      loopDeps(state, recording(resolverFor(state, rng), records)),
    )

    // The ally's real hit filled the attacker's round counters (battle_script_commands.c:1935-1959),
    // read at Focus Punch's own resolve time (executeTurn zeroes the structs on the way out).
    const record = records.find((r) => r.attackerId === 0 && r.moveId === FOCUS_PUNCH)
    expect(record).toBeDefined()
    expect(record!.physicalDmg).toBeGreaterThan(0)
    expect(record!.physicalBattlerId).toBe(2)

    const outcome = out.actions.find((a) => a.battlerId === 0)!
    expect(outcome.targetId).toBe(1)

    // Same crit/percentile in both references; only base power differs: 150 declared -> 40 on a hit.
    const reference = expectedState(FOCUS_PUNCH)
    expect(data.moveData(FOCUS_PUNCH)!.power).toBe(150)
    const expected40 = engineDamage(reference, 0, 1, FOCUS_PUNCH, true, record!.context)
    const expectedFull = engineDamage(reference, 0, 1, FOCUS_PUNCH, false, record!.context)
    expect(expected40).toBeLessThan(expectedFull)
    expect(outcome.targetDamage).toBe(expected40)
  })

  it('2. doubles: a foe that is NOT the target hits the attacker first -> 40 power', () => {
    const rng = scriptRng()
    const state = doublesState(rng, FOCUS_PUNCH, [[], ['MOVE_TACKLE']])
    const records: ResolveRecord[] = []

    const out = executeTurn(
      state,
      [useMove(1, FOCUS_PUNCH), null, null, useMove(0, 'MOVE_TACKLE')],
      loopDeps(state, recording(resolverFor(state, rng), records)),
    )

    const record = records.find((r) => r.attackerId === 0 && r.moveId === FOCUS_PUNCH)
    expect(record!.physicalDmg).toBeGreaterThan(0)
    expect(record!.physicalBattlerId).toBe(3)

    const outcome = out.actions.find((a) => a.battlerId === 0)!
    expect(outcome.targetId).toBe(1)
    const reference = expectedState(FOCUS_PUNCH)
    const expected40 = engineDamage(reference, 0, 1, FOCUS_PUNCH, true, record!.context)
    const expectedFull = engineDamage(reference, 0, 1, FOCUS_PUNCH, false, record!.context)
    expect(outcome.targetDamage).toBe(expected40)
    expect(outcome.targetDamage).not.toBe(expectedFull)
  })

  it('2b. doubles: the Focus Punch user is battler 2, hit by its ally battler 0 -> 40 power', () => {
    // Kept alongside cases 1-2 because a zeroed RoundStruct has specialBattlerId = 0, which
    // happens to equal battler 0's id: for a battler-0 attacker the old role-relative flag
    // accidentally answered TRUE. Attacker battler 2 has no such coincidence -- before this fix
    // the flag was 'none' and Focus Punch kept its full power.
    const rng = scriptRng()
    const state = doublesState(rng, FOCUS_PUNCH, [[], []], undefined, 1)
    const records: ResolveRecord[] = []

    const out = executeTurn(
      state,
      [useMove(2, 'MOVE_TACKLE'), null, useMove(1, FOCUS_PUNCH), null],
      loopDeps(state, recording(resolverFor(state, rng), records)),
    )

    const record = records.find((r) => r.attackerId === 2 && r.moveId === FOCUS_PUNCH)
    expect(record!.physicalDmg).toBeGreaterThan(0)
    expect(record!.physicalBattlerId).toBe(0)

    const outcome = out.actions.find((a) => a.battlerId === 2)!
    expect(outcome.targetId).toBe(1)
    const reference = expectedState(FOCUS_PUNCH, undefined, 1)
    const expected40 = engineDamage(reference, 2, 1, FOCUS_PUNCH, true, record!.context)
    const expectedFull = engineDamage(reference, 2, 1, FOCUS_PUNCH, false, record!.context)
    expect(expected40).toBeLessThan(expectedFull)
    expect(outcome.targetDamage).toBe(expected40)
  })

  it('3. negative: nobody hit the attacker -> the declared 150 power', () => {
    const rng = scriptRng()
    const state = doublesState(rng, FOCUS_PUNCH, [[], []])
    const records: ResolveRecord[] = []

    const out = executeTurn(
      state,
      [useMove(1, FOCUS_PUNCH), null, null, null],
      loopDeps(state, recording(resolverFor(state, rng), records)),
    )

    const record = records.find((r) => r.attackerId === 0 && r.moveId === FOCUS_PUNCH)
    expect(record!.physicalDmg).toBe(0)
    expect(record!.specialDmg).toBe(0)

    const outcome = out.actions.find((a) => a.battlerId === 0)!
    const reference = expectedState(FOCUS_PUNCH)
    const expectedFull = engineDamage(reference, 0, 1, FOCUS_PUNCH, false, record!.context)
    const expected40 = engineDamage(reference, 0, 1, FOCUS_PUNCH, true, record!.context)
    expect(outcome.targetDamage).toBe(expectedFull)
    expect(outcome.targetDamage!).toBeGreaterThan(expected40)
  })

  it('4. negative: `round.damaged` (passive-style) with zero damage counters stays at full power', () => {
    // Set by hand (allowed for this one case): Cmd_datahpupdate skips physicalDmg/specialDmg under
    // HITMARKER_PASSIVE_DAMAGE (:1935-1959), while the `damaged` bit and a damager id can still be
    // recorded. The old role-relative `wasDamagedThisTurnBy` read TRUE here; the C reads the two
    // counters, so this must stay at the declared 150.
    const state = doublesState(scriptRng(), FOCUS_PUNCH, [[], []])
    state.battlers[0]!.round.damaged = true
    state.battlers[0]!.round.physicalBattlerId = 1
    expect(state.battlers[0]!.round.physicalDmg).toBe(0)
    expect(state.battlers[0]!.round.specialDmg).toBe(0)

    const passived = resolverFor(state, scriptRng()).resolve(state, 0, 1, useMove(1, FOCUS_PUNCH))
    const reference = expectedState(FOCUS_PUNCH)
    expect(passived.targetDamage).toBe(engineDamage(reference, 0, 1, FOCUS_PUNCH, false, undefined))
    expect(passived.targetDamage!).toBeGreaterThan(engineDamage(reference, 0, 1, FOCUS_PUNCH, true, undefined))
  })
})

describe('cycle51: Self-Destruct doubles off the same counters (battle_util.c:6901-6903)', () => {
  // Battler 2 (speed 200) outruns the priority-0 Self-Destruct user (speed 100).
  const SELF_DESTRUCT_SPEEDS = [100, 60, 200, 40]

  it('5a. doubles: the ally hits first -> 2x base power', () => {
    const rng = scriptRng()
    const state = doublesState(rng, SELF_DESTRUCT, [[], []], SELF_DESTRUCT_SPEEDS)
    const records: ResolveRecord[] = []

    const out = executeTurn(
      state,
      [useMove(1, SELF_DESTRUCT), null, useMove(0, 'MOVE_TACKLE'), null],
      loopDeps(state, recording(resolverFor(state, rng), records)),
    )

    const record = records.find((r) => r.attackerId === 0 && r.moveId === SELF_DESTRUCT && r.targetId === 1)
    expect(record!.physicalDmg).toBeGreaterThan(0)

    const outcome = out.actions.find((a) => a.battlerId === 0)!
    // FOES_AND_ALLY passes each target through its own script pass (:4782-4822).
    const pass = outcome.targets?.find((t) => t.targetId === 1)
    expect(pass).toBeDefined()

    expect(data.moveData(SELF_DESTRUCT)!.power).toBe(200)
    const reference = expectedState(SELF_DESTRUCT, SELF_DESTRUCT_SPEEDS)
    const expectedDoubled = engineDamage(reference, 0, 1, SELF_DESTRUCT, true, record?.context)
    const expectedFull = engineDamage(reference, 0, 1, SELF_DESTRUCT, false, record?.context)
    expect(expectedDoubled).toBeGreaterThan(expectedFull)
    expect(pass!.targetDamage).toBe(expectedDoubled)
  })

  it('5b. negative: nobody hit the user -> the declared 200 power', () => {
    const rng = scriptRng()
    const state = doublesState(rng, SELF_DESTRUCT, [[], []], SELF_DESTRUCT_SPEEDS)
    const records: ResolveRecord[] = []

    const out = executeTurn(
      state,
      [useMove(1, SELF_DESTRUCT), null, null, null],
      loopDeps(state, recording(resolverFor(state, rng), records)),
    )

    const record = records.find((r) => r.attackerId === 0 && r.moveId === SELF_DESTRUCT && r.targetId === 1)
    expect(record!.physicalDmg).toBe(0)

    const outcome = out.actions.find((a) => a.battlerId === 0)!
    const pass = outcome.targets?.find((t) => t.targetId === 1)
    expect(pass).toBeDefined()

    const reference = expectedState(SELF_DESTRUCT, SELF_DESTRUCT_SPEEDS)
    const expectedFull = engineDamage(reference, 0, 1, SELF_DESTRUCT, false, record?.context)
    const expectedDoubled = engineDamage(reference, 0, 1, SELF_DESTRUCT, true, record?.context)
    expect(pass!.targetDamage).toBe(expectedFull)
    expect(pass!.targetDamage!).toBeLessThan(expectedDoubled)
  })
})

describe('cycle51: AI scoring reads the live round struct (battle_ai_main.c:190-203)', () => {
  function mon(overrides: Partial<SimBattleMon> = {}): SimBattleMon {
    return {
      speciesId: 'SPECIES_MUDKIP', rawStats: { atk: 100, def: 90, spatk: 80, spdef: 85, spe: 100 }, moves: ['MOVE_TACKLE', null, null, null],
      pp: [35, 0, 0, 0], hp: 100, maxHp: 100, itemId: null, statStages: [], types: ['WATER', 'MYSTERY', 'MYSTERY'], level: 50, nature: 'NATURE_HARDY',
      hiddenPowerType: null, speedDown: false, abilities: { ability: null, innates: [null, null, null] }, gender: 'MALE', status1: 0, status2: 0, ...overrides,
    }
  }
  function singlesState(): BattleState {
    return createBattleState({ battlers: [createBattlerState(0, mon(), 0), createBattlerState(1, mon(), 0)], rng: createRandomSource(1) })
  }
  /** AI_CalcDamage's own blend (battle_ai_util.c:673-676) with the hit flag stated explicitly. */
  function blended(s: BattleState, wasHit: boolean): number {
    const deps = aiDamageDepsFor(data, s)
    const roles = { attackerId: 1, defenderId: 0 }
    const attacker = buildBattlerBattleState(s, 1, roles, deps)
    const defender = buildBattlerBattleState(s, 0, roles, deps)
    const field = buildFieldBattleState(s, roles, deps)
    const scenario: DamageCalcScenario = {
      move: data.moveData(FOCUS_PUNCH)!, attacker: attacker.battler, defender: defender.battler, field: field.field,
      typeChart: data.typeChart, inverseTypeChart: data.inverseTypeChart, moveBehaviors: data.moveBehaviors,
      battleConstants: data.battleConstants, attackerActsFirst: true, sameMoveTurnsInARow: 0, hitCount: 0,
      defenderIsSwitching: false, magnitudeTier: null, attackerRolloutCounter: 0, attackerHasDefenseCurl: false,
      attackerWasHitThisTurn: wasHit, beatUpBaseAttack: attacker.battler.rawStats.atk, beatUpHitCount: 1,
      defenderUsedGlaiveRush: false,
    }
    const result = calculateMoveDamage(scenario)
    const normal = result.rolls[15]
    const crit = result.critRolls ? result.critRolls[15] : normal
    const chance = result.critChanceDenominator
    return chance === null ? normal : idiv(crit + normal * (chance - 1), chance)
  }

  it('6. aiCalcDamage: specialDmg > 0 gives the 40-power estimate, 0 gives the full-power one', async () => {
    const { aiCalcDamage } = await import('./ai/aiCalcDamage')
    const hit = singlesState()
    hit.battlers[1]!.round.specialDmg = 12 // the AI's own battler (battler 1) was hit this turn
    const reduced = aiCalcDamage(hit, FOCUS_PUNCH, 1, 0, aiDamageDepsFor(data, hit))

    const unhit = singlesState()
    const full = aiCalcDamage(unhit, FOCUS_PUNCH, 1, 0, aiDamageDepsFor(data, unhit))

    expect(reduced.dmg).toBe(blended(hit, true))
    expect(full.dmg).toBe(blended(unhit, false))
    expect(reduced.dmg).toBeLessThan(full.dmg)
  })
})
