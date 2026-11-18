/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4c5 (dbl-4c5, first slice): wire AI_DATA->partnerMove into the four
// AI_CheckViability helpers that still treated it as MOVE_NONE.
//
// C lines checked (pipeline/.upstream/eliteredux-source):
//   EFFECT_DEFOG partner-hazard pre-empt   battle_ai_main.c:3386-3395
//   GetWhoStrikesFirst (1 = 2nd arg fast)  battle_main.c:4386-4398
//   IsHazardMoveEffect                     battle_ai_util.c:1118-1127
//   MOVE_WIDE_GUARD partner branch         battle_ai_main.c:3161-3166
//   ProtectChecks                          battle_ai_util.c:1242-1268
//   IncreaseConfusionScore                 battle_ai_util.c:2733-2746
//   IsConfusionMoveEffect                  battle_ai_util.c:1084-1094
//   AI_CanBurn / IncreaseBurnScore         battle_ai_util.c:2079-2084, 2688-2699
//   ShouldBurnSelf (CanBeBurned, no partner) battle_ai_util.c:2059-2068
//   EFFECT_WILL_O_WISP bad-move half       battle_ai_main.c:1395
//   GetAllyChosenMove / partnerMove        battle_ai_util.c:2277-2287
//
// LAYOUT (same as cycle4c3/4c4): doubles, battlers 0/2 player side, 1/3
// opponent side. The AI is battler 3 and its ally is battler 1; battlerDef is
// battler 0. In singles the AI is battler 1 and the foe battler 0.
//
// Every expected number starts from a base derived by running the SAME call
// with the partner move absent (or a harmless one), and shows the C arithmetic
// in the assertion's message. No effect remaps are needed here: all four hazard
// effects, EFFECT_WILL_O_WISP, EFFECT_PROTECT (Wide Guard), EFFECT_SWAGGER /
// FLATTER / TEETER_DANCE / CONFUSE and the BOTH/FOES_AND_ALLY targets exist in
// data/v2.65beta/moves.json on real moves.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import { STAT_EVASION, SIDE_STATUS_SPIKES } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCheckViability as aiCheckViabilityAt } from './ai/aiCheckViability'
import { aiCheckBadMove } from './ai/aiCheckBadMove'

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

function doublesState(rng: RandomSource = createRandomSource(1)): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng },
  )
}

function singlesState(rng: RandomSource = createRandomSource(1)): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: false },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng },
  )
}

/** Every battler full HP, no status, no item, plain Blaze, Normal/Mystery types
 * -- scoring is then decided only by the fields each test sets. */
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
  /** false = the partner is fainted (getAllyChosenMove returns null). */
  partnerAlive?: boolean
  rng?: RandomSource
}

/** Doubles fixture with the AI at `aiId` (default 3) and its ally at aiId ^ 2. */
function doublesFixture(opts: FixtureOptions): { state: BattleState; deps: AiDamageDeps; aiId: number } {
  const state = doublesState(opts.rng ?? createRandomSource(1))
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
  const state = singlesState(opts.rng ?? createRandomSource(1))
  normaliseBattlers(state)
  const ai = state.battlers[1]!.mon
  ai.moves = opts.aiMoves
  ai.pp = [35, 35, 35, 35]
  ai.abilities.ability = 'ABILITY_BLAZE'
  return { state, deps: aiDamageDepsFor(data, state), aiId: 1 }
}

/** The exported function takes the caller's move-slot index (movesetIndex),
 * which none of these cases varies; default it the way aiCheckViability.test.ts
 * does. */
function aiCheckViability(state: BattleState, battlerAtk: number, battlerDef: number, moveId: string, score: number, deps: AiDamageDeps) {
  return aiCheckViabilityAt(state, battlerAtk, battlerDef, moveId, score, deps, 0)
}

function setSpeed(state: BattleState, id: number, speed: number): void {
  state.battlers[id]!.mon.rawStats.spe = speed
}

function setStat(state: BattleState, id: number, stat: number, value: number): void {
  state.battlers[id]!.mon.statStages[stat] = value
}

function scriptedRng(values: number[]): RandomSource & { calls: number } {
  let idx = 0
  const r = {
    calls: 0,
    random16: () => {
      r.calls++
      return values[idx++] ?? 0
    },
  }
  return r
}

// ---------------------------------------------------------------------------
// 1. EFFECT_DEFOG partner-hazard pre-empt, battle_ai_main.c:3386-3395.
//   else if (!(defSide & SIDE_STATUS_SPIKES)) {
//     if (isDoubleBattle) {
//       if (IsHazardMoveEffect(gBattleMoves[AI_DATA->partnerMove].effect)
//           && GetWhoStrikesFirst(battlerAtk, BATTLE_PARTNER(battlerAtk), TRUE) == 1)
//         break;   // skips the evasion-lowering check
//     }
//     ...evasion check: +2 if evasion > 7 or an accuracy<=90 move, else +1
//   }
// Base with no partner hazard and default evasion stage 6 is 101 (the +1).
// ---------------------------------------------------------------------------
describe('EFFECT_DEFOG partner-hazard pre-empt (battle_ai_main.c:3386-3395)', () => {
  const HAZARD_MOVES = ['MOVE_STEALTH_ROCK', 'MOVE_SPIKES', 'MOVE_TOXIC_SPIKES', 'MOVE_STICKY_WEB'] as const

  it.each(HAZARD_MOVES)('%s: partner faster pre-empts the evasion bonus (101 -> 100)', (partnerMove) => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_DEFOG', null, null, null], partnerMoves: [partnerMove, null, null, null] })
    setSpeed(state, aiId, 50) // battler 3
    setSpeed(state, 1, 200) // partner goes first
    expect(aiCheckViability(state, aiId, 0, 'MOVE_DEFOG', 100, deps).score).toBe(100)
  })

  it('partner slower: no pre-empt, the +1 evasion bonus stands (101)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_DEFOG', null, null, null], partnerMoves: ['MOVE_STEALTH_ROCK', null, null, null] })
    setSpeed(state, aiId, 200)
    setSpeed(state, 1, 50)
    expect(aiCheckViability(state, aiId, 0, 'MOVE_DEFOG', 100, deps).score).toBe(101)
  })

  it('partner faster but chose a non-hazard move: normal score (101)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_DEFOG', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null] })
    setSpeed(state, aiId, 50)
    setSpeed(state, 1, 200)
    expect(aiCheckViability(state, aiId, 0, 'MOVE_DEFOG', 100, deps).score).toBe(101)
  })

  it('non-pre-empted score with the defender at evasion +2: +2 instead of +1 (102)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_DEFOG', null, null, null], partnerMoves: ['MOVE_STEALTH_ROCK', null, null, null] })
    setSpeed(state, aiId, 200)
    setSpeed(state, 1, 50)
    setStat(state, 0, STAT_EVASION, 8) // statStages[STAT_EVASION] > 7
    expect(aiCheckViability(state, aiId, 0, 'MOVE_DEFOG', 100, deps).score).toBe(102)
  })

  it('partner faster + hazard, but the target side already has Spikes: the earlier branch wins (100)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_DEFOG', null, null, null], partnerMoves: ['MOVE_STEALTH_ROCK', null, null, null] })
    setSpeed(state, aiId, 50)
    setSpeed(state, 1, 200)
    state.sides[0].statuses |= SIDE_STATUS_SPIKES
    expect(aiCheckViability(state, aiId, 0, 'MOVE_DEFOG', 100, deps).score).toBe(100)
  })

  it('singles: no partner, no pre-empt (+1 evasion bonus = 101)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_DEFOG', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_DEFOG', 100, deps).score).toBe(101)
  })
})

// ---------------------------------------------------------------------------
// 2. MOVE_WIDE_GUARD partner branch, battle_ai_main.c:3161-3166.
//   else if (isDoubleBattle && gBattleMoves[AI_DATA->partnerMove].target & MOVE_TARGET_FOES_AND_ALLY) {
//       if (!BattlerHasAbility(battlerAtk, ABILITY_TELEPATHY, TRUE))
//           ProtectChecks(battlerAtk, battlerDef, move, predictedMove, &score);
//   }
// ProtectChecks with predictedMove MOVE_NONE and protectUses 0: `Random() % 256
// < 100` -> +1. A non-empty damaging predicted move: +2, no draw.
// ---------------------------------------------------------------------------
describe('MOVE_WIDE_GUARD partner branch (battle_ai_main.c:3161-3166)', () => {
  it('partner chose Earthquake (FOES_AND_ALLY), no predicted move: ProtectChecks rolls +1 (101)', () => {
    const rng = scriptedRng([0]) // 0 % 256 < 100
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null], partnerMoves: ['MOVE_EARTHQUAKE', null, null, null], rng })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WIDE_GUARD', 100, deps).score).toBe(101)
    expect(rng.calls).toBe(1) // ProtectChecks' own `Random() % 256`
  })

  it('the same draw fails the 100 threshold: no score change (100)', () => {
    const rng = scriptedRng([100]) // 100 % 256 is not < 100
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null], partnerMoves: ['MOVE_EARTHQUAKE', null, null, null], rng })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WIDE_GUARD', 100, deps).score).toBe(100)
    expect(rng.calls).toBe(1)
  })

  it('attacker has Telepathy: the partner branch is skipped, no draw (100)', () => {
    const rng = scriptedRng([0])
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null], partnerMoves: ['MOVE_EARTHQUAKE', null, null, null], rng })
    state.battlers[aiId]!.mon.abilities.ability = 'ABILITY_TELEPATHY'
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WIDE_GUARD', 100, deps).score).toBe(100)
    expect(rng.calls).toBe(0)
  })

  it('partner chose a single-target move: no branch taken (100)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WIDE_GUARD', 100, deps).score).toBe(100)
  })

  it('a predicted BOTH-target move still takes the first branch (+2, Telepathy ignored)', () => {
    const rng = scriptedRng([0])
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null], rng })
    state.battlers[0]!.lastMove = 'MOVE_ACID' // target BOTH, damaging
    state.battlers[aiId]!.mon.abilities.ability = 'ABILITY_TELEPATHY' // first branch ignores it
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WIDE_GUARD', 100, deps).score).toBe(102)
    expect(rng.calls).toBe(0) // predicted move is damaging, ProtectChecks does not roll
  })

  it('singles: no partner branch (100)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WIDE_GUARD', 100, deps).score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 3. IncreaseConfusionScore partner term, battle_ai_util.c:2733-2746.
//   CanBeConfused(def) && !IsConfusionMoveEffect(gBattleMoves[partnerMove].effect)
//   && ... -> +2 (or +3 vs paralysis / Serene Grace + flinch).
// Base with a non-confusion partner move is 100 + 2 = 102.
// ---------------------------------------------------------------------------
describe('IncreaseConfusionScore partner term (battle_ai_util.c:2733-2746)', () => {
  it.each(['MOVE_SWAGGER', 'MOVE_FLATTER', 'MOVE_TEETER_DANCE'])('%s as the partner move suppresses the +2 (100)', (partnerMove) => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_SWAGGER', null, null, null], partnerMoves: [partnerMove, null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_SWAGGER', 100, deps).score).toBe(100)
  })

  it('a non-confusion partner move keeps the +2 (102)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_SWAGGER', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_SWAGGER', 100, deps).score).toBe(102)
  })

  it('partner chose Confuse Ray (EFFECT_CONFUSE, deliberately NOT a confusion effect): +2 still scores (102)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_SWAGGER', null, null, null], partnerMoves: ['MOVE_CONFUSE_RAY', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_SWAGGER', 100, deps).score).toBe(102)
  })

  it('singles: no partner, the +2 stands (102)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_SWAGGER', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_SWAGGER', 100, deps).score).toBe(102)
  })
})

// ---------------------------------------------------------------------------
// 4. AI_CanBurn partnerMove term, battle_ai_util.c:2079-2084 + 2688-2699.
//   AI_CanBurn = CanBeBurned(def) && partnerMove effect != EFFECT_WILL_O_WISP.
//   IncreaseBurnScore adds +1 (then +2 if the target is Physical and can KO).
// Bad-move side, battle_ai_main.c:1395: !AI_CanBurn(...) -> -10.
// ---------------------------------------------------------------------------
describe('AI_CanBurn partnerMove term (battle_ai_util.c:2079-2084)', () => {
  it('increaseBurnScore: doubles, partner already chose Will-O-Wisp: no +1 (100)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WILL_O_WISP', null, null, null], partnerMoves: ['MOVE_WILL_O_WISP', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WILL_O_WISP', 100, deps).score).toBe(100)
  })

  it('increaseBurnScore: doubles, partner chose another move: +1 stands (101)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WILL_O_WISP', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WILL_O_WISP', 100, deps).score).toBe(101)
  })

  it('aiCheckBadMove: doubles, partner already chose Will-O-Wisp: -10 (100 -> 90)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WILL_O_WISP', null, null, null], partnerMoves: ['MOVE_WILL_O_WISP', null, null, null] })
    expect(aiCheckBadMove(state, aiId, 0, 'MOVE_WILL_O_WISP', 100, deps).score).toBe(90)
  })

  it('aiCheckBadMove: doubles, partner chose another move: no penalty (100)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WILL_O_WISP', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null] })
    expect(aiCheckBadMove(state, aiId, 0, 'MOVE_WILL_O_WISP', 100, deps).score).toBe(100)
  })

  it('increaseBurnScore: the same call in singles keeps the +1 (101)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_WILL_O_WISP', null, null, null] })
    expect(aiCheckViability(state, aiId, 0, 'MOVE_WILL_O_WISP', 100, deps).score).toBe(101)
  })
})
