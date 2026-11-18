/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 3d3q (dbl-4b first slice): AI_DoubleBattle (battle_ai_main.c:2213-2511)
// minus the partner-target branch body (:2303-2483, ported later: ability loop
// in cycle 3d3r, attack-effect switch in cycle 3d3s), plus
// GetAllyChosenMove (battle_ai_util.c:2277-2287).
//
// C lines checked:
//   AI_DoubleBattle              battle_ai_main.c:2213-2511
//     prologue                   :2214-2233
//     partner-move-effect switch :2236-2254
//     own-effect switch          :2257-2272
//     global-weather switch      :2274-2301
//     partner-target branch tail :2484 (ability loop :2303-2398 ported in
//                                 cycle 3d3r; effect switch :2395-2482 ported
//                                 in cycle 3d3s)
//     opponent branch            :2485-2510
//   GetAllyChosenMove            battle_ai_util.c:2277-2287
//   IsTrappingMoveEffect         battle_ai_util.c:1501-1513
//   HasTrappingMoveEffect        battle_ai_util.c:1515-1522
//   IsUngroundingEffect          battle_ai_util.c:1537-1544
//   IsAttackBoostMoveEffect      battle_ai_util.c:1547-1560
//   HasDamagingMove              battle_ai_util.c:1631-1639
//   GetBattlerAbility            battle_util.c:9327
//
// LAYOUT. Doubles, so battlers 0/2 are the player side (the AI's foes) and 1/3
// the opponent side. Most cases put the AI at battler 3 and its ally at battler
// 1: the ally then has the LOWER id, which is the only way GetAllyChosenMove
// returns a move at all (`partnerBattler > sBattler_AI` -> MOVE_NONE). The
// wiring case uses the production orientation instead (AI 1, ally 3) so the
// ally's row is scored (its rng draws appear) and disappears when it faints.
//
// RNG: AI_DoubleBattle itself draws nothing except getWhoStrikesFirst's
// speed-tie break. Every fixture below gives the two battlers distinct speeds,
// so no test here scripts rng except the chooseMoveOrAction_Doubles wiring
// case, which is the chooser's own draws.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import { STATUS2_ESCAPE_PREVENTION, STATUS2_WRAPPED, STATUS4_COMMANDED } from './constants'
import { AI_FLAG_DOUBLE_BATTLE } from './ai/aiFlags'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiDoubleBattle, getAllyChosenMove } from './ai/aiDoubleBattle'
import { chooseMoveOrActionDoubles } from './ai/aiPipeline'

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
  aiPp?: Slot4<number>
  partnerMoves: Slot4<string | null>
  partnerChosen: number
}

/** Doubles state with the AI at battler 3 and its ally at battler 1. Every
 * battler starts at full HP with no status, no item and plain Blaze abilities
 * so the weather/type/ability checks below are decided by the fields each test
 * sets, not by the trainer's real sets. */
function allyFixture(opts: FixtureOptions): { state: BattleState; deps: AiDamageDeps } {
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
  ai.pp = opts.aiPp ?? [35, 35, 35, 35]
  ai.types = ['WATER', 'MYSTERY', 'MYSTERY'] // grounded, no Levitate/Air Balloon

  const partner = state.battlers[1]!.mon
  partner.moves = opts.partnerMoves
  partner.pp = [35, 35, 35, 35]
  state.chosenMovePositions[1] = opts.partnerChosen

  return { state, deps: aiDamageDepsFor(data, state) }
}

/** `AI_DoubleBattle(AI=3, battlerDef, move, score)` with the default score 100. */
function scoreAgainst(state: BattleState, deps: AiDamageDeps, moveId: string, battlerDef = 0, score = 100) {
  return aiDoubleBattle(state, 3, battlerDef, moveId, 0, score, deps)
}

/** A deps whose move table reports EFFECT_ALWAYS_CRIT for Frost Breath.
 *
 * The released ER moves table has NO move with `effect: EFFECT_ALWAYS_CRIT`:
 * Frost Breath, Storm Throw, Wicked Blow and Surging Strikes carry `crit:
 * ALWAYS`, which the game reads through `gBattleMoves[m].alwaysCrit`
 * (battle_script_commands.c:1540), not through the effect enum (the textproto
 * leaves `effect` at Frost Breath's `EFFECT_FROSTBITE_HIT`). The C's
 * `case EFFECT_ALWAYS_CRIT` at :2241 is therefore unreachable with this data;
 * this override exists only to exercise the ported transcription. */
function withAlwaysCritDeps(deps: AiDamageDeps): AiDamageDeps {
  const real = deps.moveData
  return {
    ...deps,
    moveData: (id) => {
      const move = real(id)
      if (id !== 'MOVE_FROST_BREATH' || !move) return move
      return { ...move, effect: 'EFFECT_ALWAYS_CRIT' }
    },
  }
}

function setSpeed(state: BattleState, battlerId: number, speed: number): void {
  state.battlers[battlerId]!.mon.rawStats.spe = speed
}

/** Records every draw in order; `overrun` trips if the caller asks for more
 * values than supplied (copied from cycle3d3pChooseDoubles.test.ts). */
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

describe('GetAllyChosenMove (battle_ai_util.c:2277-2287)', () => {
  it('returns the ally\'s chosen slot move when the ally is alive, AI-controlled and lower id', () => {
    const state = doublesState()
    state.battlers[1]!.mon.moves = ['MOVE_TACKLE', 'MOVE_SURF', null, null]
    state.chosenMovePositions[1] = 1

    expect(getAllyChosenMove(state, 3)).toBe(state.battlers[1]!.mon.moves[1])
    expect(getAllyChosenMove(state, 3)).toBe('MOVE_SURF')
  })

  it('returns MOVE_NONE when the ally has the higher id (it has not chosen yet)', () => {
    const state = doublesState()
    state.battlers[3]!.mon.moves = ['MOVE_SURF', null, null, null]
    state.chosenMovePositions[3] = 0

    // battler 3 is battler 1's partner but chooses second
    expect(getAllyChosenMove(state, 1)).toBeNull()
  })

  it('returns MOVE_NONE when the ally is fainted', () => {
    const state = doublesState()
    state.battlers[1]!.mon.moves = ['MOVE_SURF', null, null, null]
    state.chosenMovePositions[1] = 0
    state.battlers[1]!.mon.hp = 0

    expect(getAllyChosenMove(state, 3)).toBeNull()
  })

  it('returns MOVE_NONE for an empty chosen slot', () => {
    const state = doublesState()
    state.battlers[1]!.mon.moves = [null, null, null, null]
    state.chosenMovePositions[1] = 0

    expect(getAllyChosenMove(state, 3)).toBeNull()
  })
})

describe('partner-move-effect switch (:2236-2254)', () => {
  it('Helping Hand: +5 on our status move, no change on our damaging move', () => {
    const { state, deps } = allyFixture({
      aiMoves: ['MOVE_SWORDS_DANCE', 'MOVE_TACKLE', null, null],
      partnerMoves: [null, null, 'MOVE_HELPING_HAND', null],
      partnerChosen: 2,
    })

    expect(scoreAgainst(state, deps, 'MOVE_SWORDS_DANCE').score).toBe(105)
    expect(scoreAgainst(state, deps, 'MOVE_TACKLE').score).toBe(100)
  })

  it('Perish Song: +1 for a trapping move against an untrapped defender, 0 when wrapped or commanded', () => {
    const mk = () =>
      allyFixture({
        aiMoves: ['MOVE_MEAN_LOOK', null, null, null],
        partnerMoves: ['MOVE_PERISH_SONG', null, null, null],
        partnerChosen: 0,
      })

    const open = mk()
    expect(scoreAgainst(open.state, open.deps, 'MOVE_MEAN_LOOK').score).toBe(101)

    const wrapped = mk()
    wrapped.state.battlers[0]!.mon.status2 |= STATUS2_WRAPPED
    expect(scoreAgainst(wrapped.state, wrapped.deps, 'MOVE_MEAN_LOOK').score).toBe(100)

    const escapePrevented = mk()
    escapePrevented.state.battlers[0]!.mon.status2 |= STATUS2_ESCAPE_PREVENTION
    expect(scoreAgainst(escapePrevented.state, escapePrevented.deps, 'MOVE_MEAN_LOOK').score).toBe(100)

    const commanded = mk()
    commanded.state.battlers[0]!.statuses4 |= STATUS4_COMMANDED
    expect(scoreAgainst(commanded.state, commanded.deps, 'MOVE_MEAN_LOOK').score).toBe(100)
  })

  it('Always-crit ally: -3 on our attack boost when Anger Point is ours and the ally moves first', () => {
    const mk = () =>
      allyFixture({
        aiMoves: ['MOVE_SWORDS_DANCE', 'MOVE_EARTHQUAKE', null, null],
        partnerMoves: [null, 'MOVE_FROST_BREATH', null, null],
        partnerChosen: 1,
      })

    const boosted = mk()
    boosted.state.battlers[3]!.mon.abilities = { ability: 'ABILITY_ANGER_POINT', innates: [null, null, null] }
    setSpeed(boosted.state, 3, 10)
    setSpeed(boosted.state, 1, 200) // partner moves first -> GetWhoStrikesFirst == 1
    const alwaysCrit = withAlwaysCritDeps(boosted.deps)
    expect(scoreAgainst(boosted.state, alwaysCrit, 'MOVE_SWORDS_DANCE').score).toBe(97)
    // and the multi-target half: Earthquake-style FOES_AND_ALLY is +3
    expect(scoreAgainst(boosted.state, alwaysCrit, 'MOVE_EARTHQUAKE').score).toBe(103)

    const noAngerPoint = mk()
    setSpeed(noAngerPoint.state, 3, 10)
    setSpeed(noAngerPoint.state, 1, 200)
    expect(scoreAgainst(noAngerPoint.state, withAlwaysCritDeps(noAngerPoint.deps), 'MOVE_SWORDS_DANCE').score).toBe(100)

    const faster = mk()
    faster.state.battlers[3]!.mon.abilities = { ability: 'ABILITY_ANGER_POINT', innates: [null, null, null] }
    setSpeed(faster.state, 3, 200)
    setSpeed(faster.state, 1, 10) // we move first -> no adjustment
    expect(scoreAgainst(faster.state, withAlwaysCritDeps(faster.deps), 'MOVE_SWORDS_DANCE').score).toBe(100)
  })
})

describe('own-effect switch (:2257-2272)', () => {
  it('Helping Hand: -5 when the ally has no damaging move, 0 when it has one or is unknown', () => {
    const damaging = allyFixture({
      aiMoves: ['MOVE_HELPING_HAND', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerChosen: 0,
    })
    expect(scoreAgainst(damaging.state, damaging.deps, 'MOVE_HELPING_HAND').score).toBe(100)

    const onlyStatus = allyFixture({
      aiMoves: ['MOVE_HELPING_HAND', null, null, null],
      partnerMoves: ['MOVE_SWORDS_DANCE', null, null, null],
      partnerChosen: 0,
    })
    expect(scoreAgainst(onlyStatus.state, onlyStatus.deps, 'MOVE_HELPING_HAND').score).toBe(95)

    const noPartnerMove = allyFixture({
      aiMoves: ['MOVE_HELPING_HAND', null, null, null],
      partnerMoves: [null, null, null, null],
      partnerChosen: 0,
    })
    expect(scoreAgainst(noPartnerMove.state, noPartnerMove.deps, 'MOVE_HELPING_HAND').score).toBe(100)
  })

  it('Perish Song: +1 when the ally has a trapping move, 0 when it has not', () => {
    const trapping = allyFixture({
      aiMoves: ['MOVE_PERISH_SONG', null, null, null],
      partnerMoves: ['MOVE_MEAN_LOOK', null, null, null],
      partnerChosen: 0,
    })
    expect(scoreAgainst(trapping.state, trapping.deps, 'MOVE_PERISH_SONG').score).toBe(101)

    const plain = allyFixture({
      aiMoves: ['MOVE_PERISH_SONG', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerChosen: 0,
    })
    expect(scoreAgainst(plain.state, plain.deps, 'MOVE_PERISH_SONG').score).toBe(100)
  })

  it('Magnet Rise: +2 and an immediate return when the grounded ally carries Earthquake', () => {
    const grounded = allyFixture({
      aiMoves: ['MOVE_MAGNET_RISE', null, null, null],
      partnerMoves: ['MOVE_EARTHQUAKE', null, null, null],
      partnerChosen: 0,
    })
    // battlerDef is the PARTNER here: a fall-through would reach the target
    // branch and subtract 30, so 102 proves RETURN_SCORE_PLUS returned first.
    expect(scoreAgainst(grounded.state, grounded.deps, 'MOVE_MAGNET_RISE', 1).score).toBe(102)

    const flying = allyFixture({
      aiMoves: ['MOVE_MAGNET_RISE', null, null, null],
      partnerMoves: ['MOVE_EARTHQUAKE', null, null, null],
      partnerChosen: 0,
    })
    flying.state.battlers[1]!.mon.types = ['FLYING', 'MYSTERY', 'MYSTERY'] // Earthquake effectiveness x0
    const flyingDeps = aiDamageDepsFor(data, flying.state)
    expect(scoreAgainst(flying.state, flyingDeps, 'MOVE_MAGNET_RISE', 0).score).toBe(100)
  })
})

describe('global-weather switch (:2274-2301)', () => {
  it('Sandstorm: +1 for a Rock-type ally, 0 otherwise', () => {
    const sand = allyFixture({ aiMoves: ['MOVE_SANDSTORM', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null], partnerChosen: 0 })
    sand.state.battlers[1]!.mon.types = ['ROCK', 'MYSTERY', 'MYSTERY']
    const sandDeps = aiDamageDepsFor(data, sand.state)
    expect(scoreAgainst(sand.state, sandDeps, 'MOVE_SANDSTORM').score).toBe(101)

    const plain = allyFixture({ aiMoves: ['MOVE_SANDSTORM', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null], partnerChosen: 0 })
    expect(scoreAgainst(plain.state, plain.deps, 'MOVE_SANDSTORM').score).toBe(100)
  })

  it('Rain Dance: +1 for a Water-move ally, 0 otherwise', () => {
    const rain = allyFixture({ aiMoves: ['MOVE_RAIN_DANCE', null, null, null], partnerMoves: ['MOVE_SURF', null, null, null], partnerChosen: 0 })
    expect(scoreAgainst(rain.state, rain.deps, 'MOVE_RAIN_DANCE').score).toBe(101)

    const plain = allyFixture({ aiMoves: ['MOVE_RAIN_DANCE', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null], partnerChosen: 0 })
    expect(scoreAgainst(plain.state, plain.deps, 'MOVE_RAIN_DANCE').score).toBe(100)
  })

  it('Sunny Day: +1 for a Fire-move ally, 0 otherwise', () => {
    const sun = allyFixture({ aiMoves: ['MOVE_SUNNY_DAY', null, null, null], partnerMoves: ['MOVE_FLAMETHROWER', null, null, null], partnerChosen: 0 })
    expect(scoreAgainst(sun.state, sun.deps, 'MOVE_SUNNY_DAY').score).toBe(101)

    const plain = allyFixture({ aiMoves: ['MOVE_SUNNY_DAY', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null], partnerChosen: 0 })
    expect(scoreAgainst(plain.state, plain.deps, 'MOVE_SUNNY_DAY').score).toBe(100)
  })

  it('Hail: +2 for an Ice-type ally, 0 otherwise and 0 for a fainted ally', () => {
    const hail = allyFixture({ aiMoves: ['MOVE_HAIL', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null], partnerChosen: 0 })
    hail.state.battlers[1]!.mon.types = ['ICE', 'MYSTERY', 'MYSTERY']
    const hailDeps = aiDamageDepsFor(data, hail.state)
    expect(scoreAgainst(hail.state, hailDeps, 'MOVE_HAIL').score).toBe(102)

    const plain = allyFixture({ aiMoves: ['MOVE_HAIL', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null], partnerChosen: 0 })
    expect(scoreAgainst(plain.state, plain.deps, 'MOVE_HAIL').score).toBe(100)

    // :2295 -- only HAIL has the IsBattlerAlive guard
    const fainted = allyFixture({ aiMoves: ['MOVE_HAIL', null, null, null], partnerMoves: ['MOVE_TACKLE', null, null, null], partnerChosen: 0 })
    fainted.state.battlers[1]!.mon.types = ['ICE', 'MYSTERY', 'MYSTERY']
    fainted.state.battlers[1]!.mon.hp = 0
    const faintedDeps = aiDamageDepsFor(data, fainted.state)
    expect(scoreAgainst(fainted.state, faintedDeps, 'MOVE_HAIL').score).toBe(100)
  })
})

describe('opponent branch (:2485-2510)', () => {
  it('Skill Swap: +5 on a Truant attacker, +2 on a non-negative-rated attacker ability, 0 otherwise', () => {
    const truant = allyFixture({ aiMoves: ['MOVE_SKILL_SWAP', null, null, null], partnerMoves: [null, null, null, null], partnerChosen: 0 })
    truant.state.battlers[3]!.mon.abilities = { ability: 'ABILITY_TRUANT', innates: [null, null, null] }
    expect(scoreAgainst(truant.state, truant.deps, 'MOVE_SKILL_SWAP').score).toBe(105)

    // IsAbilityOfRating(attacker, 0): rating >= 0. ABILITY_BLAZE is rated 5.
    const rated = allyFixture({ aiMoves: ['MOVE_SKILL_SWAP', null, null, null], partnerMoves: [null, null, null, null], partnerChosen: 0 })
    expect(scoreAgainst(rated.state, rated.deps, 'MOVE_SKILL_SWAP').score).toBe(102)

    // negative-rated attacker and an ordinary defender -> neither clause holds
    const both = allyFixture({ aiMoves: ['MOVE_SKILL_SWAP', null, null, null], partnerMoves: [null, null, null, null], partnerChosen: 0 })
    both.state.battlers[3]!.mon.abilities = { ability: 'ABILITY_DEFEATIST', innates: [null, null, null] } // -1
    both.state.battlers[0]!.mon.abilities = { ability: 'ABILITY_BLAZE', innates: [null, null, null] }
    expect(scoreAgainst(both.state, both.deps, 'MOVE_SKILL_SWAP').score).toBe(100)

    // ...but a top-rated defender (ABILITY_DELTA_STREAM is 10) still earns +2
    both.state.battlers[0]!.mon.abilities = { ability: 'ABILITY_DELTA_STREAM', innates: [null, null, null] }
    expect(scoreAgainst(both.state, both.deps, 'MOVE_SKILL_SWAP').score).toBe(102)
  })

  it('Magnitude: -10 on a grounded Fire ally, -3 on a grounded Water ally, +2 on an ungrounded ally', () => {
    const fire = allyFixture({ aiMoves: ['MOVE_MAGNITUDE', null, null, null], partnerMoves: [null, null, null, null], partnerChosen: 0 })
    fire.state.battlers[1]!.mon.types = ['FIRE', 'MYSTERY', 'MYSTERY']
    setSpeed(fire.state, 3, 200) // no speed tie -> getWhoStrikesFirst draws nothing
    setSpeed(fire.state, 1, 10)
    const fireDeps = aiDamageDepsFor(data, fire.state)
    expect(scoreAgainst(fire.state, fireDeps, 'MOVE_MAGNITUDE').score).toBe(90)

    const water = allyFixture({ aiMoves: ['MOVE_MAGNITUDE', null, null, null], partnerMoves: [null, null, null, null], partnerChosen: 0 })
    water.state.battlers[1]!.mon.types = ['WATER', 'MYSTERY', 'MYSTERY']
    setSpeed(water.state, 3, 200)
    setSpeed(water.state, 1, 10)
    const waterDeps = aiDamageDepsFor(data, water.state)
    expect(scoreAgainst(water.state, waterDeps, 'MOVE_MAGNITUDE').score).toBe(97)

    const flying = allyFixture({ aiMoves: ['MOVE_MAGNITUDE', null, null, null], partnerMoves: [null, null, null, null], partnerChosen: 0 })
    flying.state.battlers[1]!.mon.types = ['FLYING', 'MYSTERY', 'MYSTERY']
    const flyingDeps = aiDamageDepsFor(data, flying.state)
    expect(scoreAgainst(flying.state, flyingDeps, 'MOVE_MAGNITUDE').score).toBe(102)
  })
})

describe('partner-target branch tail (:2484)', () => {
  it('subtracts 30 with no dbl-4b3 gap note left', () => {
    const { state, deps } = allyFixture({
      aiMoves: ['MOVE_TACKLE', null, null, null],
      partnerMoves: [null, null, null, null],
      partnerChosen: 0,
    })

    const result = scoreAgainst(state, deps, 'MOVE_TACKLE', 1) // battlerDef == our ally
    expect(result.score).toBe(70)
    // The attack-effect switch at battle_ai_main.c:2395-2482 is ported (cycle
    // 3d3s); Tackle's effect is 0 (EFFECT_HIT), which matches no case, so the
    // unconditional score -= 30 at :2484 is the only movement.
    expect(result.unmodelled.some((line) => line.startsWith('AI_DoubleBattle: partner-target attack-effect switch'))).toBe(false)
  })
})

describe('DISPATCH wiring (AI_FLAG_DOUBLE_BATTLE, bit 7)', () => {
  function wiringFixture(): { state: BattleState; deps: AiDamageDeps } {
    const state = doublesState()
    state.aiFlags = AI_FLAG_DOUBLE_BATTLE
    for (const battler of state.battlers) {
      if (battler) battler.mon.hp = battler.mon.maxHp
    }
    const ai = state.battlers[1]!.mon
    ai.moves = ['MOVE_TACKLE', null, null, null]
    ai.pp = [35, 0, 0, 0]
    return { state, deps: aiDamageDepsFor(data, state) }
  }

  const NOTE_PREFIX = 'AI_DoubleBattle: partner-target attack-effect switch'

  it('runs through chooseMoveOrActionDoubles with no partner gap note for the allied row', () => {
    const { state, deps } = wiringFixture()
    const rng = scriptedRng([0, 0, 0, 0, 0, 0, 0]) // 3 scored targets x 2 + 1 final
    state.rng = rng

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    expect(result.moveIndex).toBe(0)
    // battle_ai_main.c:2395-2482 is ported as of cycle 3d3s; the former
    // placeholder note is gone. Tackle matches no case, so :2484's -30 applies.
    expect(result.unmodelled.filter((line) => line.startsWith(NOTE_PREFIX))).toHaveLength(0)
    expect(rng.overrun).toBe(false)
  })

  it('reports no partner note when the ally is fainted (its row is not scored)', () => {
    const { state, deps } = wiringFixture()
    state.battlers[3]!.mon.hp = 0
    const rng = scriptedRng([0, 0, 0, 0, 0]) // 2 scored targets x 2 + 1 final
    state.rng = rng

    const result = chooseMoveOrActionDoubles(state, 1, deps)

    expect(result.moveIndex).toBe(0)
    expect(result.unmodelled.filter((line) => line.startsWith(NOTE_PREFIX))).toHaveLength(0)
    expect(rng.overrun).toBe(false)
  })
})
