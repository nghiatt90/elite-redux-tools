/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3s (dbl-4b3): the partner-target attack-effect switch of
// AI_DoubleBattle, battle_ai_main.c:2395-2482.
//
// C lines checked:
//   AI_DoubleBattle prologue locals   battle_ai_main.c:2220-2223
//     (`atkPartnerHoldEffect` :2220, `partnerProtecting` :2221,
//      `attackerHasBadAbility` :2222, `partnerHasBadAbility` :2223)
//   `if (!partnerProtecting)` gate    battle_ai_main.c:2396
//   EFFECT_PURIFY                     battle_ai_main.c:2398-2402
//   EFFECT_SWAGGER                    battle_ai_main.c:2403-2409
//   EFFECT_FLATTER                    battle_ai_main.c:2410-2416
//   EFFECT_BEAT_UP                    battle_ai_main.c:2417-2424
//   EFFECT_SKILL_SWAP                 battle_ai_main.c:2425-2436
//   EFFECT_ROLE_PLAY                  battle_ai_main.c:2437-2440
//   EFFECT_WORRY_SEED/GASTRO_ACID/SIMPLE_BEAM battle_ai_main.c:2441-2446
//   EFFECT_ENTRAINMENT                battle_ai_main.c:2447-2450
//   EFFECT_SOAK                       battle_ai_main.c:2451-2457
//   EFFECT_INSTRUCT                   battle_ai_main.c:2458-2468
//   EFFECT_AFTER_YOU                  battle_ai_main.c:2469-2477
//   branch tail `score -= 30`         battle_ai_main.c:2484
//   FOE / BATTLE_PARTNER macros       include/battle_ai_util.h:10,
//                                     include/constants/battle.h:37
//
// LAYOUT (same as cycle3d3r): doubles, battlers 0/2 player side (the AI's
// foes), 1/3 opponent side. The AI is battler 3 and its ally (the scored
// target) is battler 1, so GetAllyChosenMove can return a move
// (`partnerBattler > sBattler_AI` -> MOVE_NONE). `battlerDef` is always 1.
//
// This switch is reached for ANY move scored against the partner: the damage
// gate at :2304 only guards the ability loop above it. A case that does not
// fire (or a `break`) falls through to :2484, so an unhandled effect scores
// 100 - 30 = 70.
//
// RNG: the partner branch draws nothing except getWhoStrikesFirst's tie-break
// in Instruct/After You. Every fixture keeps the two speeds strictly unequal
// unless the test says otherwise; the Instruct/After You tests assert
// `rng.calls === 0` in the tie-free cases.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import { MAX_STAT_STAGE, STAT_ATK, STAT_SPATK, STATUS1_BURN, STATUS2_CONFUSION } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiDoubleBattle } from './ai/aiDoubleBattle'

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

/** Doubles (BATTLE_TYPE_DOUBLE set) with the four standard battler slots: 0/2
 * player, 1/3 opponent. Built through the production layout path. */
function doublesState(): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: playerParty(), opponentParties: [opponentParty()], rng: createRandomSource(1) },
  )
}

interface FixtureOptions {
  aiMoves: Slot4<string | null>
  aiAbility?: string | null
  partnerMoves?: Slot4<string | null>
  partnerChosen?: number
  partnerAbility?: string | null
  partnerInnates?: [string | null, string | null, string | null]
}

/** Doubles state with the AI at battler 3 and its ally at battler 1. Every
 * battler starts at full HP with no status, no item and plain Blaze abilities
 * so the switch is decided only by the fields each test sets. */
function partnerFixture(opts: FixtureOptions): { state: BattleState; deps: AiDamageDeps } {
  const state = doublesState()
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

  const ai = state.battlers[3]!.mon
  ai.moves = opts.aiMoves
  ai.pp = [35, 35, 35, 35]
  ai.abilities.ability = opts.aiAbility ?? 'ABILITY_BLAZE'

  const partner = state.battlers[1]!
  partner.mon.moves = opts.partnerMoves ?? [null, null, null, null]
  partner.mon.pp = [35, 35, 35, 35]
  partner.mon.abilities = { ability: opts.partnerAbility ?? 'ABILITY_BLAZE', innates: opts.partnerInnates ?? [null, null, null] }
  state.chosenMovePositions[1] = opts.partnerChosen ?? 0

  return { state, deps: aiDamageDepsFor(data, state) }
}

/** `AI_DoubleBattle(AI=3, battlerDef=1 the ally, move, score)` with score 100. */
function scoreAgainstPartner(state: BattleState, deps: AiDamageDeps, moveId: string) {
  return aiDoubleBattle(state, 3, 1, moveId, 0, 100, deps)
}

function setStatStage(state: BattleState, battlerId: number, stat: number, stage: number): void {
  state.battlers[battlerId]!.mon.statStages[stat] = stage
}

/** Forces a strict speed order without relying on the species' raw Speed. */
function setRawSpeed(state: BattleState, battlerId: number, speed: number): void {
  state.battlers[battlerId]!.mon.rawStats.spe = speed
}

/** Records every draw in order; `overrun` trips if more values are asked for
 * than supplied. */
function scriptedRng(values: number[]): RandomSource & { calls: number; overrun: boolean } {
  let index = 0
  const rng = {
    calls: 0,
    overrun: false,
    random16: () => {
      rng.calls++
      if (index >= values.length) rng.overrun = true
      return values[index++] ?? 0
    },
  }
  return rng
}

const DBL43_NOTE_PREFIX = 'AI_DoubleBattle: partner-target attack-effect switch'

describe('EFFECT_PURIFY (:2398-2402)', () => {
  it('+1 when the partner has any status: 101', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_PURIFY', null, null, null] })
    state.battlers[1]!.mon.status1 = STATUS1_BURN // STATUS1_ANY & STATUS1_BURN
    expect(scoreAgainstPartner(state, deps, 'MOVE_PURIFY').score).toBe(101)
  })

  it('no bonus when the partner is statusless: 70', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_PURIFY', null, null, null] })
    expect(scoreAgainstPartner(state, deps, 'MOVE_PURIFY').score).toBe(70)
  })
})

describe('EFFECT_SWAGGER (:2403-2409)', () => {
  // Atk below MAX, a physical move, and !CanBeConfused (a confused mon cannot
  // be confused again, so CanBeConfused returns FALSE and the `||` holds).
  it('+1 for a confused physical partner below the Atk cap: 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SWAGGER', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    setStatStage(state, 1, STAT_ATK, MAX_STAT_STAGE - 1)
    state.battlers[1]!.mon.status2 = STATUS2_CONFUSION
    expect(scoreAgainstPartner(state, deps, 'MOVE_SWAGGER').score).toBe(101)
  })

  it('an unconfused, itemless partner is still confusable: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SWAGGER', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SWAGGER').score).toBe(70)
  })

  it('Atk already at MAX_STAT_STAGE: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SWAGGER', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    setStatStage(state, 1, STAT_ATK, MAX_STAT_STAGE)
    state.battlers[1]!.mon.status2 = STATUS2_CONFUSION
    expect(scoreAgainstPartner(state, deps, 'MOVE_SWAGGER').score).toBe(70)
  })

  it('no physical move: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SWAGGER', null, null, null],
      partnerMoves: ['MOVE_SURF', null, null, null], // SPECIAL
    })
    state.battlers[1]!.mon.status2 = STATUS2_CONFUSION
    expect(scoreAgainstPartner(state, deps, 'MOVE_SWAGGER').score).toBe(70)
  })
})

describe('EFFECT_FLATTER (:2410-2416)', () => {
  it('+1 for a confused special partner below the Sp. Atk cap: 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_FLATTER', null, null, null],
      partnerMoves: ['MOVE_SURF', null, null, null],
    })
    setStatStage(state, 1, STAT_SPATK, MAX_STAT_STAGE - 1)
    state.battlers[1]!.mon.status2 = STATUS2_CONFUSION
    expect(scoreAgainstPartner(state, deps, 'MOVE_FLATTER').score).toBe(101)
  })

  it('no special move: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_FLATTER', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null], // PHYSICAL
    })
    setStatStage(state, 1, STAT_SPATK, MAX_STAT_STAGE - 1)
    state.battlers[1]!.mon.status2 = STATUS2_CONFUSION
    expect(scoreAgainstPartner(state, deps, 'MOVE_FLATTER').score).toBe(70)
  })
})

describe('EFFECT_BEAT_UP (:2417-2424)', () => {
  // Beat Up is DARK (moves.json "type":"TYPE_DARK") and damaging, so
  // !IS_MOVE_STATUS and moveType == TYPE_DARK both hold.
  it('+1 for a Justified physical partner that survives: 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_BEAT_UP', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerAbility: 'ABILITY_JUSTIFIED',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_BEAT_UP').score).toBe(101)
  })

  it('no bonus when the partner Atk is already at MAX_STAT_STAGE: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_BEAT_UP', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerAbility: 'ABILITY_JUSTIFIED',
    })
    setStatStage(state, 1, STAT_ATK, MAX_STAT_STAGE)
    expect(scoreAgainstPartner(state, deps, 'MOVE_BEAT_UP').score).toBe(70)
  })

  // The C's last operand is `!CanIndexMoveFaintTarget(...)`, but its preceding
  // Justified gate makes that operand unreachable: ER's Justified is an
  // onAbsorb ability (src/abilities.cc:2177), so a Dark move deals 0 to the
  // holder and the partner cannot faint from Beat Up even at 1 HP. The same
  // finding pins cycle3d3r's Justified test. Transcribed as written; the 1 HP
  // case still scores +1.
  it('1 HP cannot trip the faint check because Justified absorbs Dark: 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_BEAT_UP', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerAbility: 'ABILITY_JUSTIFIED',
    })
    state.battlers[1]!.mon.hp = 1
    expect(scoreAgainstPartner(state, deps, 'MOVE_BEAT_UP').score).toBe(101)
  })
})

describe('EFFECT_SKILL_SWAP (:2425-2436)', () => {
  it("+10 when the abilities differ and the attacker's is not bad: 110", () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SKILL_SWAP', null, null, null],
      aiAbility: 'ABILITY_TORRENT',
      partnerAbility: 'ABILITY_BLAZE',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SKILL_SWAP').score).toBe(110)
  })

  it('the same ability on both sides: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SKILL_SWAP', null, null, null],
      aiAbility: 'ABILITY_BLAZE',
      partnerAbility: 'ABILITY_BLAZE',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SKILL_SWAP').score).toBe(70)
  })

  it("the attacker's ability is bad-rated: 70", () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SKILL_SWAP', null, null, null],
      aiAbility: 'ABILITY_DEFEATIST', // rating -1 in aiAbilityRatings.ts
      partnerAbility: 'ABILITY_BLAZE',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SKILL_SWAP').score).toBe(70)
  })

  it('+3 for a Truant partner when the attacker has Compound Eyes and a low-accuracy move: 103', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SKILL_SWAP', null, null, null],
      aiAbility: 'ABILITY_COMPOUND_EYES',
      partnerAbility: 'ABILITY_TRUANT',
      partnerMoves: ['MOVE_FOCUS_BLAST', null, null, null], // 75 accuracy
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SKILL_SWAP').score).toBe(103)
  })

  it('a Truant partner without Compound Eyes on the attacker: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_SKILL_SWAP', null, null, null],
      aiAbility: 'ABILITY_TORRENT',
      partnerAbility: 'ABILITY_TRUANT',
      partnerMoves: ['MOVE_FOCUS_BLAST', null, null, null],
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SKILL_SWAP').score).toBe(70)
  })
})

describe('EFFECT_ROLE_PLAY (:2437-2440)', () => {
  it('+1 when the attacker is bad and the partner is not: 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_ROLE_PLAY', null, null, null],
      aiAbility: 'ABILITY_DEFEATIST',
      partnerAbility: 'ABILITY_BLAZE',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_ROLE_PLAY').score).toBe(101)
  })

  it('both abilities bad-rated: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_ROLE_PLAY', null, null, null],
      aiAbility: 'ABILITY_DEFEATIST',
      partnerAbility: 'ABILITY_SLOW_START',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_ROLE_PLAY').score).toBe(70)
  })
})

describe('EFFECT_WORRY_SEED / GASTRO_ACID / SIMPLE_BEAM (:2441-2446)', () => {
  it('+2 for a bad-rated partner ability: 102 (Gastro Acid and Simple Beam)', () => {
    for (const moveId of ['MOVE_GASTRO_ACID', 'MOVE_SIMPLE_BEAM']) {
      const { state, deps } = partnerFixture({ aiMoves: [moveId, null, null, null], partnerAbility: 'ABILITY_DEFEATIST' })
      expect(scoreAgainstPartner(state, deps, moveId).score).toBe(102)
    }
  })

  it('no bonus for a neutral partner ability: 70 (Worry Seed)', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_WORRY_SEED', null, null, null], partnerAbility: 'ABILITY_BLAZE' })
    expect(scoreAgainstPartner(state, deps, 'MOVE_WORRY_SEED').score).toBe(70)
  })
})

describe('EFFECT_ENTRAINMENT (:2447-2450)', () => {
  it("+1 when the partner is bad and the attacker's rating is >= 0: 101", () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_ENTRAINMENT', null, null, null],
      aiAbility: 'ABILITY_TORRENT',
      partnerAbility: 'ABILITY_DEFEATIST',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_ENTRAINMENT').score).toBe(101)
  })

  it('a partner with a neutral ability: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_ENTRAINMENT', null, null, null],
      aiAbility: 'ABILITY_TORRENT',
      partnerAbility: 'ABILITY_BLAZE',
    })
    expect(scoreAgainstPartner(state, deps, 'MOVE_ENTRAINMENT').score).toBe(70)
  })
})

describe('EFFECT_SOAK (:2451-2457)', () => {
  it('+1 for a Wonder Guard partner that is not Water/Water/Water: 101', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SOAK', null, null, null], partnerAbility: 'ABILITY_WONDER_GUARD' })
    expect(state.battlers[1]!.mon.types).toEqual(['NORMAL', 'MYSTERY', 'MYSTERY'])
    expect(scoreAgainstPartner(state, deps, 'MOVE_SOAK').score).toBe(101)
  })

  it('a partner without Wonder Guard: 70', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_SOAK', null, null, null], partnerAbility: 'ABILITY_BLAZE' })
    expect(scoreAgainstPartner(state, deps, 'MOVE_SOAK').score).toBe(70)
  })
})

describe('EFFECT_INSTRUCT (:2458-2468)', () => {
  it('AI strictly faster: reads the partner chosen move; Earthquake (FOES_AND_ALLY) scores 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_INSTRUCT', null, null, null],
      partnerMoves: ['MOVE_EARTHQUAKE', null, null, null],
    })
    setRawSpeed(state, 3, 300) // GetWhoStrikesFirst(battlerAtk, partner) == 0
    setRawSpeed(state, 1, 10)
    const rng = scriptedRng([])
    state.rng = rng
    expect(scoreAgainstPartner(state, deps, 'MOVE_INSTRUCT').score).toBe(101)
    expect(rng.calls).toBe(0)
  })

  it('AI strictly faster with a SELECTED-target chosen move: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_INSTRUCT', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    setRawSpeed(state, 3, 300)
    setRawSpeed(state, 1, 10)
    expect(scoreAgainstPartner(state, deps, 'MOVE_INSTRUCT').score).toBe(70)
  })

  it('AI strictly faster with a STATUS chosen move: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_INSTRUCT', null, null, null],
      partnerMoves: ['MOVE_SCREECH', null, null, null],
    })
    setRawSpeed(state, 3, 300)
    setRawSpeed(state, 1, 10)
    expect(scoreAgainstPartner(state, deps, 'MOVE_INSTRUCT').score).toBe(70)
  })

  it('AI strictly slower: reads partner.lastMove; a multi-target last move scores 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_INSTRUCT', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    setRawSpeed(state, 3, 10) // GetWhoStrikesFirst(...) == 1
    setRawSpeed(state, 1, 300)
    state.battlers[1]!.lastMove = 'MOVE_EARTHQUAKE'
    const rng = scriptedRng([])
    state.rng = rng
    expect(scoreAgainstPartner(state, deps, 'MOVE_INSTRUCT').score).toBe(101)
    expect(rng.calls).toBe(0)
  })
})

describe('EFFECT_AFTER_YOU (:2469-2477)', () => {
  it('+1 when foe battler 0 goes before the partner: 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_AFTER_YOU', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    setRawSpeed(state, 0, 300) // FOE(1) == 0
    setRawSpeed(state, 1, 10)
    expect(scoreAgainstPartner(state, deps, 'MOVE_AFTER_YOU').score).toBe(101)
  })

  it('a chosen Counter is a "goes last" move: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_AFTER_YOU', null, null, null],
      partnerMoves: ['MOVE_COUNTER', null, null, null],
    })
    setRawSpeed(state, 0, 300)
    setRawSpeed(state, 1, 10)
    expect(scoreAgainstPartner(state, deps, 'MOVE_AFTER_YOU').score).toBe(70)
  })

  it('+1 when the first foe is slower but the second goes first: 101', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_AFTER_YOU', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    setRawSpeed(state, 1, 100)
    setRawSpeed(state, 0, 10) // first comparison == 0
    setRawSpeed(state, 2, 300) // BATTLE_PARTNER(FOE(1)) == 2, second comparison == 1
    expect(scoreAgainstPartner(state, deps, 'MOVE_AFTER_YOU').score).toBe(101)
  })

  it('partner faster than both foes: 70 and no rng draw', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_AFTER_YOU', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
    })
    setRawSpeed(state, 1, 300)
    setRawSpeed(state, 0, 10)
    setRawSpeed(state, 2, 10)
    const rng = scriptedRng([])
    state.rng = rng
    expect(scoreAgainstPartner(state, deps, 'MOVE_AFTER_YOU').score).toBe(70)
    expect(rng.calls).toBe(0)
  })
})

describe('gates and unrelated effects', () => {
  it('partner chose Protect: the whole switch is skipped, even with a Purify-able status: 70', () => {
    const { state, deps } = partnerFixture({
      aiMoves: ['MOVE_PURIFY', null, null, null],
      partnerMoves: ['MOVE_PROTECT', null, null, null],
      partnerChosen: 0,
    })
    state.battlers[1]!.mon.status1 = STATUS1_BURN
    const result = scoreAgainstPartner(state, deps, 'MOVE_PURIFY')
    expect(result.score).toBe(70)
    expect(result.unmodelled.some((line) => line.startsWith(DBL43_NOTE_PREFIX))).toBe(false)
  })

  it('an effect outside the switch (Tackle): 70 and no dbl-4b3 gap note', () => {
    const { state, deps } = partnerFixture({ aiMoves: ['MOVE_TACKLE', null, null, null] })
    const result = scoreAgainstPartner(state, deps, 'MOVE_TACKLE')
    expect(result.score).toBe(70)
    expect(result.unmodelled.some((line) => line.startsWith(DBL43_NOTE_PREFIX))).toBe(false)
  })
})
