/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4c1 (dbl-4c, first slice): IsValidDoubleBattle and the five partner
// helpers that need no `gBattleStruct->moveTarget`.
//
// C lines checked:
//   IsValidDoubleBattle                 battle_ai_util.c:2270-2280
//   IsDoubleBattle -> IS_DOUBLE_BATTLE  battle_anim_mons.c:712, :22
//   PartnerHasSameMoveEffectWithoutTarget battle_ai_util.c:2306-2312
//   DoesPartnerHaveSameMoveEffect       battle_ai_util.c:2295-2304 (real, dbl-4c2)
//   PartnerMoveIsSameNoTarget           battle_ai_util.c:2366-2370
//   PartnerMoveEffectIsWeather          battle_ai_util.c:2326-2336
//   PartnerMoveEffectIsTerrain          battle_ai_util.c:2338-2348
//   PartnerMoveIs                       battle_ai_util.c:2350-2356
//   PartnerMoveIsSameAsAttacker         battle_ai_util.c:2358-2364 (real, dbl-4c2)
//   BATTLE_OPPOSITE / BATTLE_PARTNER    include/constants/battle.h:36-37
//   AI_CheckBadMove scoring sites       battle_ai_main.c:1072/-10 (:1120-1123),
//     EFFECT_SUNNY_DAY :1304 (-8), EFFECT_GRASSY_TERRAIN :1880 (-20),
//     EFFECT_TAILWIND :2081 (-10), EFFECT_LUCKY_CHANT :2087 (-10),
//     EFFECT_LEECH_SEED :1185 (-20 branch; the partner term is the stub),
//     EFFECT_EMBARGO :1952 (-10 branch; the partner term is the stub).
//
// LAYOUT (same as cycle3d3s): doubles, battlers 0/2 player side (the AI's foes),
// 1/3 opponent side. The AI is battler 3 and its ally is battler 1, so
// GetAllyChosenMove can return a move (`partnerBattler > sBattler_AI` would
// return MOVE_NONE). `battlerDef` is battler 0, a foe.
//
// RNG: none of these cases draw.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, SimPartyMon, Slot4 } from './state'
import { BATTLE_TYPE_DOUBLE } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCheckBadMove, getAllyChosenMove, isValidDoubleBattle } from './ai/aiCheckBadMove'

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
 * -- the switch is then decided only by the fields each test sets. */
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

describe('IsValidDoubleBattle (battle_ai_util.c:2270-2280)', () => {
  it('is false without BATTLE_TYPE_DOUBLE even with all four battlers alive', () => {
    const { state } = doublesFixture({ aiMoves: ['MOVE_TACKLE', null, null, null] })
    state.battleTypeFlags &= ~BATTLE_TYPE_DOUBLE
    expect(isValidDoubleBattle(state, 3)).toBe(false)
  })

  it('is true in a double battle with both foes alive', () => {
    const { state } = doublesFixture({ aiMoves: ['MOVE_TACKLE', null, null, null] })
    expect(isValidDoubleBattle(state, 3)).toBe(true)
  })

  it('is true when both foes are fainted but the AI partner is alive', () => {
    const { state } = doublesFixture({ aiMoves: ['MOVE_TACKLE', null, null, null] })
    state.battlers[0]!.mon.hp = 0
    state.battlers[2]!.mon.hp = 0
    expect(isValidDoubleBattle(state, 3)).toBe(true)
  })

  it('is false when one foe is fainted and the partner is fainted (needs BOTH foes alive OR partner alive)', () => {
    const { state } = doublesFixture({ aiMoves: ['MOVE_TACKLE', null, null, null], partnerAlive: false })
    state.battlers[0]!.mon.hp = 0
    // battler 2 (the other foe) is alive, but BATTLE_PARTNER(BATTLE_OPPOSITE(3)) = 0, which is fainted.
    expect(isValidDoubleBattle(state, 3)).toBe(false)
  })
})

describe('PartnerHasSameMoveEffectWithoutTarget (battle_ai_util.c:2306-2312) via EFFECT_LIGHT_SCREEN (-10)', () => {
  const partnerMoves: Slot4<string | null> = ['MOVE_LIGHT_SCREEN', null, null, null]

  it('doubles, partner chose the same effect: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_LIGHT_SCREEN', null, null, null], partnerMoves })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LIGHT_SCREEN').score).toBe(90)
  })

  it('doubles, partner fainted (getAllyChosenMove null): 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_LIGHT_SCREEN', null, null, null], partnerMoves, partnerAlive: false })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LIGHT_SCREEN').score).toBe(100)
  })

  it('singles: the same move keeps the old score 100', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_LIGHT_SCREEN', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LIGHT_SCREEN').score).toBe(100)
  })
})

describe('PartnerMoveEffectIsWeather (battle_ai_util.c:2326-2336) via EFFECT_SUNNY_DAY (-8)', () => {
  it('doubles, partner chose Rain Dance: 100 - 8 = 92', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_SUNNY_DAY', null, null, null],
      partnerMoves: ['MOVE_RAIN_DANCE', null, null, null],
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_SUNNY_DAY').score).toBe(92)
  })

  it('doubles, partner fainted: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_SUNNY_DAY', null, null, null],
      partnerMoves: ['MOVE_RAIN_DANCE', null, null, null],
      partnerAlive: false,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_SUNNY_DAY').score).toBe(100)
  })

  it('singles: Sunny Day keeps the old score 100', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_SUNNY_DAY', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_SUNNY_DAY').score).toBe(100)
  })
})

describe('PartnerMoveEffectIsTerrain (battle_ai_util.c:2338-2348) via EFFECT_GRASSY_TERRAIN (-20)', () => {
  it('doubles, partner chose Misty Terrain: 100 - 20 = 80', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_GRASSY_TERRAIN', null, null, null],
      partnerMoves: ['MOVE_MISTY_TERRAIN', null, null, null],
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASSY_TERRAIN').score).toBe(80)
  })

  it('doubles, partner fainted: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_GRASSY_TERRAIN', null, null, null],
      partnerMoves: ['MOVE_MISTY_TERRAIN', null, null, null],
      partnerAlive: false,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASSY_TERRAIN').score).toBe(100)
  })

  it('singles: Grassy Terrain keeps the old score 100', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_GRASSY_TERRAIN', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASSY_TERRAIN').score).toBe(100)
  })
})

describe('PartnerMoveIs (battle_ai_util.c:2350-2356) via EFFECT_TAILWIND (-10, battle_ai_main.c:2081)', () => {
  it('doubles, partner chose Tailwind: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_TAILWIND', null, null, null],
      partnerMoves: ['MOVE_TAILWIND', null, null, null],
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_TAILWIND').score).toBe(90)
  })

  it('doubles, partner fainted: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_TAILWIND', null, null, null],
      partnerMoves: ['MOVE_TAILWIND', null, null, null],
      partnerAlive: false,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_TAILWIND').score).toBe(100)
  })

  it('singles: Tailwind keeps the old score 100', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_TAILWIND', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_TAILWIND').score).toBe(100)
  })
})

describe('PartnerMoveIsSameNoTarget (battle_ai_util.c:2366-2370) via EFFECT_LUCKY_CHANT (-10, battle_ai_main.c:2087)', () => {
  it('doubles, partner chose Lucky Chant: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_LUCKY_CHANT', null, null, null],
      partnerMoves: ['MOVE_LUCKY_CHANT', null, null, null],
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LUCKY_CHANT').score).toBe(90)
  })

  it('doubles, partner fainted: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_LUCKY_CHANT', null, null, null],
      partnerMoves: ['MOVE_LUCKY_CHANT', null, null, null],
      partnerAlive: false,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LUCKY_CHANT').score).toBe(100)
  })

  it('singles: Lucky Chant keeps the old score 100', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_LUCKY_CHANT', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LUCKY_CHANT').score).toBe(100)
  })
})

describe('the two moveTarget helpers are real as of dbl-4c2', () => {
  // DoesPartnerHaveSameMoveEffect, battle_ai_util.c:2295-2304:
  //   if (gBattleMoves[move].effect == gBattleMoves[partnerMove].effect &&
  //       gChosenMoveByBattler[battlerAtkPartner] != MOVE_NONE &&
  //       gBattleStruct->moveTarget[battlerAtkPartner] == battlerDef) return TRUE;
  // With moveTarget[1] at its initial 0 and battlerDef 0, the partner picking
  // Leech Seed is the same effect at the same target, so EFFECT_LEECH_SEED
  // (battle_ai_main.c:1185) scores -20, no note.
  it('DoesPartnerHaveSameMoveEffect (battle_ai_util.c:2295-2304): 100 - 20 = 80, no note', () => {
    const doubles = doublesFixture({
      aiMoves: ['MOVE_LEECH_SEED', null, null, null],
      partnerMoves: ['MOVE_LEECH_SEED', null, null, null],
    })
    const r = scoreDoubles(doubles.state, doubles.deps, doubles.aiId, 'MOVE_LEECH_SEED')
    expect(r.score).toBe(80)
    expect(r.unmodelled.some((note) => note.includes('DoesPartnerHaveSameMoveEffect'))).toBe(false)

    const singles = singlesFixture({ aiMoves: ['MOVE_LEECH_SEED', null, null, null] })
    const s = scoreDoubles(singles.state, singles.deps, singles.aiId, 'MOVE_LEECH_SEED')
    expect(s.score).toBe(100) // `if (!IsDoubleBattle()) return FALSE;`
    expect(s.unmodelled.some((note) => note.includes('DoesPartnerHaveSameMoveEffect'))).toBe(false)
  })

  // PartnerMoveIsSameAsAttacker, battle_ai_util.c:2358-2364:
  //   if (gChosenMoveByBattler[battlerAtkPartner] != MOVE_NONE && move == partnerMove &&
  //       gBattleStruct->moveTarget[battlerAtkPartner] == battlerDef) return TRUE;
  // EFFECT_EMBARGO (battle_ai_main.c:1950-1952) scores -10.
  it('PartnerMoveIsSameAsAttacker (battle_ai_util.c:2358-2364): 100 - 10 = 90, no note', () => {
    const doubles = doublesFixture({
      aiMoves: ['MOVE_EMBARGO', null, null, null],
      partnerMoves: ['MOVE_EMBARGO', null, null, null],
    })
    const r = scoreDoubles(doubles.state, doubles.deps, doubles.aiId, 'MOVE_EMBARGO')
    expect(r.score).toBe(90)
    expect(r.unmodelled.some((note) => note.includes('PartnerMoveIsSameAsAttacker'))).toBe(false)

    const singles = singlesFixture({ aiMoves: ['MOVE_EMBARGO', null, null, null] })
    const s = scoreDoubles(singles.state, singles.deps, singles.aiId, 'MOVE_EMBARGO')
    expect(s.score).toBe(100) // `if (!IsDoubleBattle()) return FALSE;`
    expect(s.unmodelled.some((note) => note.includes('PartnerMoveIsSameAsAttacker'))).toBe(false)
  })
})

describe('getAllyChosenMove (battle_ai_util.c:2277-2287)', () => {
  it('returns null when the partner has the higher id (lower id chooses first)', () => {
    // AI = 1, partner = 3; the partner is AI-controlled but has the higher id.
    const { state } = doublesFixture({
      aiMoves: ['MOVE_TACKLE', null, null, null],
      aiId: 1,
      partnerMoves: ['MOVE_TAILWIND', null, null, null],
    })
    expect(getAllyChosenMove(state, 1)).toBeNull()
  })

  it('returns the partner move when the partner is alive, AI-controlled and lower-id', () => {
    const { state } = doublesFixture({
      aiMoves: ['MOVE_TACKLE', null, null, null],
      partnerMoves: ['MOVE_TAILWIND', null, null, null],
    })
    expect(getAllyChosenMove(state, 3)).toBe('MOVE_TAILWIND')
  })
})

// AI_CheckBadMove, battle_ai_main.c:1402-1410:
//   case EFFECT_FOLLOW_ME:
//   case EFFECT_HELPING_HAND:
//       if (!isDoubleBattle || !IsBattlerAlive(BATTLE_PARTNER(battlerAtk)) ||
//           PartnerHasSameMoveEffectWithoutTarget(BATTLE_PARTNER(battlerAtk), move, AI_DATA->partnerMove) ||
//           (AI_DATA->partnerMove != MOVE_NONE && IS_MOVE_STATUS(AI_DATA->partnerMove)) ||
//           *(gBattleStruct->monToSwitchIntoId + BATTLE_PARTNER(battlerAtk)) != PARTY_SIZE)
//           score -= 10;
// All five operands are ported, so the doubles cases below carry no note; the
// moves' own effect is EFFECT_HELPING_HAND / EFFECT_FOLLOW_ME.
describe('EFFECT_FOLLOW_ME / EFFECT_HELPING_HAND (-10, battle_ai_main.c:1402-1410)', () => {
  it('doubles, partner alive and chose no move: no operand true, 100, no unmodelled note', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_HELPING_HAND', null, null, null] })
    const r = scoreDoubles(state, deps, aiId, 'MOVE_HELPING_HAND')
    expect(r.score).toBe(100)
    expect(r.unmodelled.some((note) => note.includes('FOLLOW_ME') || note.includes('HELPING_HAND'))).toBe(false)
  })

  it('doubles, partner chose Helping Hand (same effect): 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_HELPING_HAND', null, null, null],
      partnerMoves: ['MOVE_HELPING_HAND', null, null, null],
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_HELPING_HAND').score).toBe(90)
  })

  it('doubles, partner chose a different STATUS move: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_HELPING_HAND', null, null, null],
      partnerMoves: ['MOVE_HARDEN', null, null, null],
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_HELPING_HAND').score).toBe(90)
  })

  it('doubles, partner chose a damaging move: no operand true, 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_HELPING_HAND', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_HELPING_HAND').score).toBe(100)
  })

  it('doubles, partner is switching out (monToSwitchIntoId != PARTY_SIZE): 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_FOLLOW_ME', null, null, null] })
    state.battlers[aiId ^ 2]!.monToSwitchIntoId = 1
    expect(scoreDoubles(state, deps, aiId, 'MOVE_FOLLOW_ME').score).toBe(90)
  })

  it('doubles, partner fainted: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_FOLLOW_ME', null, null, null], partnerAlive: false })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_FOLLOW_ME').score).toBe(90)
  })

  it('singles (`!isDoubleBattle` is true): 100 - 10 = 90, unchanged, no note', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_FOLLOW_ME', null, null, null] })
    const r = scoreDoubles(state, deps, aiId, 'MOVE_FOLLOW_ME')
    expect(r.score).toBe(90)
    expect(r.unmodelled.some((note) => note.includes('FOLLOW_ME') || note.includes('HELPING_HAND'))).toBe(false)
  })
})
