/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4c2 (dbl-4c2, first slice): model `gBattleStruct->moveTarget` and the
// three AI helpers that read it.
//
// C lines checked (pipeline/.upstream/eliteredux-source):
//   gBattleStruct->moveTarget                include/battle.h:601
//   writer, normal move-chosen branch        battle_main.c:3916
//     (`gBattleStruct->moveTarget[gActiveBattler] = gBattleResources->bufferB[gActiveBattler][3]`)
//   encored branch does NOT write moveTarget battle_main.c:3687-3692
//   DoesPartnerHaveSameMoveEffect            battle_ai_util.c:2295-2304
//   PartnerMoveEffectIsStatusSameTarget      battle_ai_util.c:2314-2323
//   PartnerMoveIsSameAsAttacker              battle_ai_util.c:2358-2364
//   AI_CanParalyze                           battle_ai_util.c:2046-2054
//   AI_CanParalyze caller (EFFECT_PARALYZE)  battle_ai_main.c:1160-1165
//   EFFECT_TAUNT scoring (-1)                battle_ai_main.c:1733-1736
//   EFFECT_EMBARGO scoring (-10)             battle_ai_main.c:1950-1952
//
// LAYOUT (same as cycle4c1): doubles, battlers 0/2 player side, 1/3 opponent
// side. The AI is battler 3 and its ally is battler 1, so GetAllyChosenMove can
// return a move (`partnerBattler > sBattler_AI` would return MOVE_NONE). The
// defender is battler 0. `state.moveTarget[partner]` is staged by hand exactly
// the way cycle4c1 stages `state.chosenMovePositions[partner]`.
//
// RNG: no case here draws; the turn-loop cases use a fixed zero-damage resolver.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor, buildMoveAction, createSession, groundingFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, SimPartyMon, Slot4 } from './state'
import { MAX_BATTLERS_COUNT } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCanParalyze, aiCheckBadMove } from './ai/aiCheckBadMove'
import type { DamageResolver, TurnLoopDeps } from './turn'
import { executeTurn } from './turn'

const data = loadSimData()
const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

const SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

function playerParty(): SimPartyMon[] {
  return buildPlayerParty(SPECS, 50, data)
}

function opponentParty(): SimPartyMon[] {
  return buildOpponentParty(trainer, 'elite', 50, data)
}

function doublesState(): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng: createRandomSource(1) },
  )
}

function singlesState(): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: false },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng: createRandomSource(1) },
  )
}

/** Every battler full HP, no status, no item, plain Blaze, Normal/Mystery types
 * -- the scoring is then decided only by the fields each test sets. */
function normaliseBattlers(state: BattleState): void {
  for (const battler of state.battlers) {
    if (!battler) continue
    battler.mon.hp = battler.mon.maxHp
    battler.mon.status1 = 0
    battler.mon.status2 = 0
    battler.statuses3 = 0
    battler.statuses4 = 0
    battler.mon.itemId = null
    battler.mon.abilities = { ability: 'ABILITY_BLAZE', innates: [null, null, null] }
    battler.mon.types = ['NORMAL', 'MYSTERY', 'MYSTERY']
  }
}

interface FixtureOptions {
  aiMoves: Slot4<string | null>
  aiId?: number
  partnerMoves?: Slot4<string | null>
  partnerChosen?: number
  /** false = the partner is fainted (getAllyChosenMove returns MOVE_NONE). */
  partnerAlive?: boolean
  /** Staged `gBattleStruct->moveTarget[partner]`; defaults to the create.ts fill of 0. */
  partnerTarget?: number
}

/** Doubles fixture with the AI at `aiId` (default 3) and its ally at aiId ^ 2. */
function doublesFixture(opts: FixtureOptions): { state: BattleState; deps: AiDamageDeps; aiId: number } {
  const state = doublesState()
  normaliseBattlers(state)
  const aiId = opts.aiId ?? 3
  const ai = state.battlers[aiId]!.mon
  ai.moves = opts.aiMoves
  ai.pp = [35, 35, 35, 35]
  ai.abilities.ability = 'ABILITY_BLAZE'

  const partnerId = aiId ^ 2
  const partner = state.battlers[partnerId]
  if (partner) {
    partner.mon.moves = opts.partnerMoves ?? [null, null, null, null]
    partner.mon.pp = [35, 35, 35, 35]
    partner.mon.abilities = { ability: 'ABILITY_BLAZE', innates: [null, null, null] }
    state.chosenMovePositions[partnerId] = opts.partnerChosen ?? 0
    if (opts.partnerTarget !== undefined) state.moveTarget[partnerId] = opts.partnerTarget
    if (opts.partnerAlive === false) partner.mon.hp = 0
  }
  return { state, deps: aiDamageDepsFor(data, state), aiId }
}

/** Singles fixture: AI battler 1, foe battler 0. No partner slot exists. */
function singlesFixture(opts: FixtureOptions): { state: BattleState; deps: AiDamageDeps; aiId: number } {
  const state = singlesState()
  normaliseBattlers(state)
  const ai = state.battlers[1]!.mon
  ai.moves = opts.aiMoves
  ai.pp = [35, 35, 35, 35]
  ai.abilities.ability = 'ABILITY_BLAZE'
  return { state, deps: aiDamageDepsFor(data, state), aiId: 1 }
}

function scoreDoubles(state: BattleState, deps: AiDamageDeps, aiId: number, moveId: string) {
  return aiCheckBadMove(state, aiId, 0, moveId, 100, deps)
}

// ---------------------------------------------------------------------------
// 1. PartnerMoveIsSameAsAttacker, battle_ai_util.c:2358-2364.
//   if (!IsDoubleBattle()) return FALSE;
//   if (gChosenMoveByBattler[battlerAtkPartner] != MOVE_NONE && move == partnerMove &&
//       gBattleStruct->moveTarget[battlerAtkPartner] == battlerDef) return TRUE;
// Exercised through EFFECT_EMBARGO, battle_ai_main.c:1950-1952:
//   case EFFECT_EMBARGO:
//       if (BattlerHasAbility(battlerDef, ABILITY_KLUTZ, FALSE) || gVolatileStructs[battlerDef].embargoTimer != 0
//           || PartnerMoveIsSameAsAttacker(BATTLE_PARTNER(battlerAtk), battlerDef, move, AI_DATA->partnerMove))
//           score -= 10;
// ---------------------------------------------------------------------------
describe('PartnerMoveIsSameAsAttacker (battle_ai_util.c:2358-2364) via EFFECT_EMBARGO (-10)', () => {
  it('doubles, partner chose the same move at the same defender: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_EMBARGO', null, null, null],
      partnerMoves: ['MOVE_EMBARGO', null, null, null],
      partnerTarget: 0,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_EMBARGO').score).toBe(90)
  })

  it('doubles, same move but the partner aimed at a different defender: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_EMBARGO', null, null, null],
      partnerMoves: ['MOVE_EMBARGO', null, null, null],
      partnerTarget: 2,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_EMBARGO').score).toBe(100)
  })

  it('doubles, partner chose a different move: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_EMBARGO', null, null, null],
      partnerMoves: ['MOVE_GROWL', null, null, null],
      partnerTarget: 0,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_EMBARGO').score).toBe(100)
  })

  it('singles: `if (!IsDoubleBattle()) return FALSE;` keeps the score at 100', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_EMBARGO', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_EMBARGO').score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 2. DoesPartnerHaveSameMoveEffect, battle_ai_util.c:2295-2304.
//   if (gBattleMoves[move].effect == gBattleMoves[partnerMove].effect &&
//       gChosenMoveByBattler[battlerAtkPartner] != MOVE_NONE &&
//       gBattleStruct->moveTarget[battlerAtkPartner] == battlerDef) return TRUE;
// Exercised through EFFECT_TAUNT, battle_ai_main.c:1733-1736:
//   case EFFECT_TAUNT:
//       if (gVolatileStructs[battlerDef].tauntTimer > 0
//           || DoesPartnerHaveSameMoveEffect(BATTLE_PARTNER(battlerAtk), battlerDef, move, AI_DATA->partnerMove))
//           score -= 1;
// ---------------------------------------------------------------------------
describe('DoesPartnerHaveSameMoveEffect (battle_ai_util.c:2295-2304) via EFFECT_TAUNT (-1)', () => {
  it('doubles, partner chose the same effect at the same defender: 100 - 1 = 99', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_TAUNT', null, null, null],
      partnerMoves: ['MOVE_TAUNT', null, null, null],
      partnerTarget: 0,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_TAUNT').score).toBe(99)
  })

  it('doubles, same effect but the partner aimed at a different defender: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_TAUNT', null, null, null],
      partnerMoves: ['MOVE_TAUNT', null, null, null],
      partnerTarget: 2,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_TAUNT').score).toBe(100)
  })

  it('doubles, partner chose a different effect: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_TAUNT', null, null, null],
      partnerMoves: ['MOVE_GROWL', null, null, null],
      partnerTarget: 0,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_TAUNT').score).toBe(100)
  })

  it('doubles, partnerMove === MOVE_NONE (fainted partner): 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_TAUNT', null, null, null],
      partnerMoves: ['MOVE_TAUNT', null, null, null],
      partnerTarget: 0,
      partnerAlive: false,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_TAUNT').score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 3. PartnerMoveEffectIsStatusSameTarget, battle_ai_util.c:2314-2323, called
// from AI_CanParalyze (battle_ai_util.c:2046-2054) as the last `||` operand:
//   gChosenMoveByBattler[partner] != MOVE_NONE && moveTarget[partner] == battlerDef &&
//   effect in { SLEEP, POISON, TOXIC, PARALYZE, WILL_O_WISP, YAWN }
// ---------------------------------------------------------------------------
describe('aiCanParalyze / PartnerMoveEffectIsStatusSameTarget (battle_ai_util.c:2314-2323, :2046-2054)', () => {
  const statusMoves: Array<[string, string]> = [
    ['EFFECT_SLEEP', 'MOVE_SLEEP_POWDER'],
    ['EFFECT_POISON', 'MOVE_POISON_POWDER'],
    ['EFFECT_TOXIC', 'MOVE_TOXIC'],
    ['EFFECT_PARALYZE', 'MOVE_THUNDER_WAVE'],
    ['EFFECT_WILL_O_WISP', 'MOVE_WILL_O_WISP'],
    ['EFFECT_YAWN', 'MOVE_YAWN'],
  ]

  it.each(statusMoves)('partner chose %s at the same defender -> canParalyze false', (_effect, partnerMove) => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_THUNDER_WAVE', null, null, null],
      partnerMoves: [partnerMove, null, null, null],
      partnerTarget: 0,
    })
    const r = aiCanParalyze(state, state.battlers[aiId]!, state.battlers[0]!, 'MOVE_THUNDER_WAVE', deps)
    expect(r.canParalyze).toBe(false)
  })

  it('partner chose a status move at a different defender -> canParalyze true', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_THUNDER_WAVE', null, null, null],
      partnerMoves: ['MOVE_SLEEP_POWDER', null, null, null],
      partnerTarget: 2,
    })
    const r = aiCanParalyze(state, state.battlers[aiId]!, state.battlers[0]!, 'MOVE_THUNDER_WAVE', deps)
    expect(r.canParalyze).toBe(true)
  })

  it('partner chose a move whose effect is not in the list -> canParalyze true', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_THUNDER_WAVE', null, null, null],
      partnerMoves: ['MOVE_GROWL', null, null, null],
      partnerTarget: 0,
    })
    const r = aiCanParalyze(state, state.battlers[aiId]!, state.battlers[0]!, 'MOVE_THUNDER_WAVE', deps)
    expect(r.canParalyze).toBe(true)
  })

  it('singles: partner read short-circuits, canParalyze true (no partner present)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_THUNDER_WAVE', null, null, null] })
    const r = aiCanParalyze(state, state.battlers[aiId]!, state.battlers[0]!, 'MOVE_THUNDER_WAVE', deps)
    expect(r.canParalyze).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. The turn.ts writer, battle_main.c:3916 (normal branch) vs :3687-3692
// (encored branch, which does not write moveTarget). Runs through executeTurn,
// not by hand.
// ---------------------------------------------------------------------------
function fixedDamage(amount: number): DamageResolver {
  return {
    resolve: () => ({
      targetDamage: amount,
      attackerDamage: null,
      unmodelled: [],
      isCriticalHit: false,
      berryReduced: false,
      isSuperEffective: false,
    }),
  }
}

function turnDepsFor(state: BattleState): TurnLoopDeps {
  return {
    turnOrder: data.turnOrder,
    grounding: groundingFor(data, state),
    damage: fixedDamage(0),
    statStageRatios: data.statStageRatios,
    dataContext: data.dataContext,
    moveBehaviors: data.moveBehaviors,
    hazardTypes: { typeChart: data.typeChart, inverseTypeChart: data.inverseTypeChart, inverseBattle: false },
  }
}

describe('executeTurn writes gBattleStruct->moveTarget (battle_main.c:3916)', () => {
  it('a normal USE_MOVE action stores its target: battler 1 at target 2 leaves moveTarget[1] === 2', () => {
    const state = doublesState()
    normaliseBattlers(state)
    state.battlers[1]!.mon.moves = ['MOVE_TACKLE', null, null, null]
    state.moveTarget[1] = 0 // previous value, as create.ts fills it
    const deps = turnDepsFor(state)
    const action = buildMoveAction(state, data, 1, 'MOVE_TACKLE', undefined, 2)
    expect(action.target).toBe(2)
    executeTurn(state, [null, action, null, null], deps)
    expect(state.moveTarget[1]).toBe(2)
  })

  it('an encored action (targetFromGetMoveTarget) leaves the previous value', () => {
    const state = doublesState()
    normaliseBattlers(state)
    state.battlers[1]!.mon.moves = ['MOVE_TACKLE', null, null, null]
    state.moveTarget[1] = 3 // previous value
    const deps = turnDepsFor(state)
    const action = buildMoveAction(state, data, 1, 'MOVE_TACKLE', undefined, 2)
    executeTurn(state, [null, { ...action, targetFromGetMoveTarget: true }, null, null], deps)
    expect(state.moveTarget[1]).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// 5. Singles regression: createSession initialises moveTarget to
// MAX_BATTLERS_COUNT zeros, so a singles turn and every helper read see 0.
// ---------------------------------------------------------------------------
describe('createSession initialises moveTarget', () => {
  it('is an array of MAX_BATTLERS_COUNT zeros', () => {
    const session = createSession({
      data,
      playerParty: playerParty(),
      opponentTrainer: trainer,
      tier: 'elite',
      rng: createRandomSource(1),
    })
    expect(session.state.moveTarget).toEqual(new Array<number>(MAX_BATTLERS_COUNT).fill(0))
  })
})
