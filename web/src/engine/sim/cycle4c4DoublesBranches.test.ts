/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4c4 (dbl-4c4, first slice): the doubles halves of seven
// AI_CheckBadMove branches that were previously singles-only or untranscribed.
//
// C lines checked (pipeline/.upstream/eliteredux-source):
//   isDoubleBattle = IsValidDoubleBattle    battle_ai_main.c:497
//   IsValidDoubleBattle                     battle_ai_util.c:2270-2280
//   EFFECT_FLOWER_SHIELD                    battle_ai_main.c:1471-1473
//   EFFECT_AROMATIC_MIST                    battle_ai_main.c:1474-1476
//   IsConfusionMoveEffect                   battle_ai_util.c:1084-1094
//   EFFECT_CONFUSE/SWAGGER/FLATTER          battle_ai_main.c:1166-1169
//   EFFECT_PROTECT guards                   battle_ai_main.c:1608-1620
//   EFFECT_PROTECT protectUses              battle_ai_main.c:1637-1645
//   EFFECT_DEFOG                            battle_ai_main.c:1661-1690
//   IsHazardMoveEffect                      battle_ai_util.c:1118-1127
//   GetWhoStrikesFirst                      battle_main.c:4386-4398
//   EFFECT_PLEDGE                           battle_ai_main.c:1901-1910
//
// LAYOUT (same as cycle4c3): doubles, battlers 0/2 player side, 1/3 opponent
// side. The AI is battler 3 and its ally is battler 1; battlerDef is battler 0,
// so BATTLE_PARTNER(battlerDef) is battler 2. In singles the AI is battler 1
// and the foe battler 0.
//
// Every expected score starts at 100 and shows the arithmetic from the C.
// RNG: Protect's `Random() % 100 < 50` (:1638) is the only draw these cases
// make; the scripted source below drives it and counts calls.
//
// TWO EFFECT REMAPS, deliberate and data-justified: moves.json declares
// MOVE_QUICK_GUARD as EFFECT_QUICK_GUARD (:8355-8360) and the three pledge
// moves as EFFECT_ARGUMENT_HIT (:8667-8679), so the C's `case EFFECT_PROTECT`
// sub-switch on MOVE_QUICK_GUARD and its `case EFFECT_PLEDGE` are dead against
// released data -- exactly as in the compiled C, which switches on the same
// effect. `overrideEffect` re-labels the data for those tests so the
// transcribed branch itself is exercised; the production code keeps the C's
// own labels, it does not add EFFECT_QUICK_GUARD/EFFECT_ARGUMENT_HIT aliases.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import { STATUS1_SLEEP, STATUS1_FREEZE, MIN_STAT_STAGE } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
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

function setTypes(state: BattleState, id: number, types: [string, string, string]): void {
  state.battlers[id]!.mon.types = types
}

function setStat(state: BattleState, id: number, stat: number, value: number): void {
  state.battlers[id]!.mon.statStages[stat] = value
}

function setSpeed(state: BattleState, id: number, speed: number): void {
  state.battlers[id]!.mon.rawStats.spe = speed
}

/** Re-label one move's declared effect for the duration of a test. Used only
 * where the C's case label no longer matches released data (see header). */
function overrideEffect(deps: AiDamageDeps, moveId: string, effect: string): void {
  const base = deps.moveData
  deps.moveData = (id: string) => {
    const move = base(id)
    return id === moveId && move ? { ...move, effect } : move
  }
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
// 1. EFFECT_FLOWER_SHIELD, battle_ai_main.c:1471-1473.
//   if (!GRASS(attacker) && !(isDoubleBattle && GRASS(partner))) -10
// ---------------------------------------------------------------------------
describe('EFFECT_FLOWER_SHIELD (battle_ai_main.c:1471-1473)', () => {
  it('doubles, attacker not Grass but its partner is Grass: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_FLOWER_SHIELD', null, null, null] })
    setTypes(state, 1, ['GRASS', 'MYSTERY', 'MYSTERY'])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_FLOWER_SHIELD').score).toBe(100)
  })

  it('doubles, neither attacker nor partner Grass: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_FLOWER_SHIELD', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_FLOWER_SHIELD').score).toBe(90)
  })

  it('singles, attacker not Grass: 100 - 10 = 90 (no partner operand can apply)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_FLOWER_SHIELD', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_FLOWER_SHIELD').score).toBe(90)
  })

  it('doubles layout with both foes and the partner dead (IsValidDoubleBattle false), partner Grass: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_FLOWER_SHIELD', null, null, null], partnerAlive: false })
    setTypes(state, 1, ['GRASS', 'MYSTERY', 'MYSTERY'])
    state.battlers[0]!.mon.hp = 0
    state.battlers[2]!.mon.hp = 0
    expect(scoreDoubles(state, deps, aiId, 'MOVE_FLOWER_SHIELD').score).toBe(90)
  })
})

// ---------------------------------------------------------------------------
// 2. EFFECT_AROMATIC_MIST, battle_ai_main.c:1474-1476.
//   if (!isDoubleBattle || partner hp == 0 || !BattlerStatCanRise(partner, SPDEF)) -10
// ---------------------------------------------------------------------------
describe('EFFECT_AROMATIC_MIST (battle_ai_main.c:1474-1476)', () => {
  it('doubles, partner alive and SpDef can rise: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_AROMATIC_MIST', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_AROMATIC_MIST').score).toBe(100)
  })

  it('doubles, partner at 0 HP: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_AROMATIC_MIST', null, null, null], partnerAlive: false })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_AROMATIC_MIST').score).toBe(90)
  })

  it('doubles, partner SpDef already +6 (statStages[5] == MAX_STAT_STAGE): 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_AROMATIC_MIST', null, null, null] })
    setStat(state, 1, 5, 12)
    expect(scoreDoubles(state, deps, aiId, 'MOVE_AROMATIC_MIST').score).toBe(90)
  })

  it('singles (!isDoubleBattle is the first OR operand): 100 - 10 = 90', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_AROMATIC_MIST', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_AROMATIC_MIST').score).toBe(90)
  })
})

// ---------------------------------------------------------------------------
// 3. EFFECT_PROTECT, MOVE_QUICK_GUARD/WIDE_GUARD/CRAFTY_SHIELD,
//    battle_ai_main.c:1608-1620.
//   if (!isDoubleBattle) { score -= 10; decreased = TRUE; }
//   In doubles `decreased` stays false, so the incapacitated-defender check
//   below still runs (:1624-1627) and the protectUses block is skipped (:1630).
// ---------------------------------------------------------------------------
describe('EFFECT_PROTECT guards (battle_ai_main.c:1608-1620)', () => {
  it('doubles, Wide Guard: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_WIDE_GUARD').score).toBe(100)
  })

  it('doubles, Crafty Shield: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_CRAFTY_SHIELD', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_CRAFTY_SHIELD').score).toBe(100)
  })

  it('doubles, Wide Guard with an incapacitated defender still takes the shared -10: 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null] })
    state.battlers[0]!.mon.status1 = STATUS1_SLEEP
    expect(scoreDoubles(state, deps, aiId, 'MOVE_WIDE_GUARD').score).toBe(90)
  })

  it('singles, Wide Guard: 100 - 10 = 90', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_WIDE_GUARD', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_WIDE_GUARD').score).toBe(90)
  })

  it('singles, Crafty Shield: 100 - 10 = 90', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_CRAFTY_SHIELD', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_CRAFTY_SHIELD').score).toBe(90)
  })

  it('singles, Quick Guard (data effect EFFECT_QUICK_GUARD remapped to EFFECT_PROTECT): 90', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_QUICK_GUARD', null, null, null] })
    overrideEffect(deps, 'MOVE_QUICK_GUARD', 'EFFECT_PROTECT')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_QUICK_GUARD').score).toBe(90)
  })

  it('doubles, Quick Guard (same remap): 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_QUICK_GUARD', null, null, null] })
    overrideEffect(deps, 'MOVE_QUICK_GUARD', 'EFFECT_PROTECT')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_QUICK_GUARD').score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 4. EFFECT_PROTECT protectUses, battle_ai_main.c:1637-1645.
//   else if (protectUses == 1 && Random() % 100 < 50) {
//       if (!isDoubleBattle) score -= 6; else score -= 10;
//   } else if (protectUses >= 2) score -= 10;
// ---------------------------------------------------------------------------
describe('EFFECT_PROTECT protectUses (battle_ai_main.c:1637-1645)', () => {
  it('doubles, protectUses 1 and the draw is true: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_PROTECT', null, null, null] })
    state.battlers[aiId]!.volatiles.protectUses = 1
    const rng = scriptedRng([0]) // 0 % 100 < 50
    state.rng = rng
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PROTECT').score).toBe(90)
    expect(rng.calls).toBe(1)
  })

  it('singles, protectUses 1 and the draw is true: 100 - 6 = 94', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_PROTECT', null, null, null] })
    state.battlers[aiId]!.volatiles.protectUses = 1
    const rng = scriptedRng([0])
    state.rng = rng
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PROTECT').score).toBe(94)
    expect(rng.calls).toBe(1)
  })

  it('doubles, protectUses 1 and the draw is false: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_PROTECT', null, null, null] })
    state.battlers[aiId]!.volatiles.protectUses = 1
    state.rng = scriptedRng([60]) // 60 % 100 is not < 50
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PROTECT').score).toBe(100)
  })

  it('singles, protectUses 1 and the draw is false: 100', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_PROTECT', null, null, null] })
    state.battlers[aiId]!.volatiles.protectUses = 1
    state.rng = scriptedRng([60])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PROTECT').score).toBe(100)
  })

  it('doubles, protectUses >= 2: 100 - 10 = 90 (no draw)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_PROTECT', null, null, null] })
    state.battlers[aiId]!.volatiles.protectUses = 2
    const rng = scriptedRng([])
    state.rng = rng
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PROTECT').score).toBe(90)
    expect(rng.calls).toBe(0)
  })

  it('singles, protectUses >= 2: 100 - 10 = 90', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_PROTECT', null, null, null] })
    state.battlers[aiId]!.volatiles.protectUses = 2
    state.rng = scriptedRng([])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PROTECT').score).toBe(90)
  })
})

// ---------------------------------------------------------------------------
// 5. EFFECT_DEFOG, battle_ai_main.c:1676-1683.
//   if (isDoubleBattle) {
//       if (IsHazardMoveEffect(partnerMove.effect) &&
//           GetWhoStrikesFirst(PARTNER, battlerAtk, FALSE)) { score -= 10; break; }
//   }
// GetWhoStrikesFirst returns 1 when its SECOND argument is faster
// (battle_main.c:4391-4396: 1 if battler1Speed < battler2Speed), so the sim's
// truthiness is `=== 1` with (partner, battlerAtk): truthy = the Defog user is
// faster. `FALSE` for ignoreChosenMoves is the sim's `false` with no staged
// actions (the caller is scoring a hypothetical move; the C has no chosen
// action for it either).
// ---------------------------------------------------------------------------
describe('EFFECT_DEFOG partner-hazard pre-empt (battle_ai_main.c:1676-1683)', () => {
  it('doubles, partner chose Spikes and the AI strikes first: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_DEFOG', null, null, null],
      partnerMoves: ['MOVE_SPIKES', null, null, null],
      partnerChosen: 0,
    })
    setSpeed(state, 1, 1) // partner slower
    setSpeed(state, 3, 200) // AI faster -> getWhoStrikesFirst(1, 3) === 1
    expect(scoreDoubles(state, deps, aiId, 'MOVE_DEFOG').score).toBe(90)
  })

  it('doubles, partner chose Spikes but the partner strikes first: falls through to the evasion check: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_DEFOG', null, null, null],
      partnerMoves: ['MOVE_SPIKES', null, null, null],
      partnerChosen: 0,
    })
    setSpeed(state, 1, 200) // partner faster -> getWhoStrikesFirst(1, 3) === 0
    setSpeed(state, 3, 1)
    // The evasion check (:1687-1690) only fires at MIN_STAT_STAGE or vs Contrary.
    expect(state.battlers[0]!.mon.statStages[7]).not.toBe(MIN_STAT_STAGE)
    expect(scoreDoubles(state, deps, aiId, 'MOVE_DEFOG').score).toBe(100)
  })

  it('doubles, partner chose a non-hazard move (Tackle): 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_DEFOG', null, null, null],
      partnerMoves: ['MOVE_TACKLE', null, null, null],
      partnerChosen: 0,
    })
    setSpeed(state, 1, 1)
    setSpeed(state, 3, 200)
    expect(scoreDoubles(state, deps, aiId, 'MOVE_DEFOG').score).toBe(100)
  })

  it('singles: 100 (the block is isDoubleBattle-gated)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_DEFOG', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_DEFOG').score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 6. EFFECT_CONFUSE/SWAGGER/FLATTER, battle_ai_main.c:1166-1169.
//   if (!CanBeConfused(battlerDef) || IsConfusionMoveEffect(partnerMove.effect)) -20
// IsConfusionMoveEffect, battle_ai_util.c:1084-1094: SWAGGER / FLATTER /
// TEETER_DANCE (EFFECT_CONFUSE_HIT commented out).
// ---------------------------------------------------------------------------
describe('EFFECT_CONFUSE/SWAGGER/FLATTER partnerMove (battle_ai_main.c:1166-1169)', () => {
  it('doubles, partner chose Swagger, defender can still be confused: 100 - 20 = 80', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_SWAGGER', null, null, null],
      partnerMoves: ['MOVE_SWAGGER', null, null, null],
      partnerChosen: 0,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_SWAGGER').score).toBe(80)
  })

  it('doubles, partner chose Teeter Dance: 100 - 20 = 80', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_SWAGGER', null, null, null],
      partnerMoves: ['MOVE_TEETER_DANCE', null, null, null],
      partnerChosen: 0,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_SWAGGER').score).toBe(80)
  })

  it('doubles, partner chose Confuse Ray (EFFECT_CONFUSE is not an IsConfusionMoveEffect): 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_SWAGGER', null, null, null],
      partnerMoves: ['MOVE_CONFUSE_RAY', null, null, null],
      partnerChosen: 0,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_SWAGGER').score).toBe(100)
  })

  it('singles, no partner move (MOVE_NONE): 100', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_SWAGGER', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_SWAGGER').score).toBe(100)
  })

  it('the removed IsConfusionMoveEffect gap note is gone', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_SWAGGER', null, null, null],
      partnerMoves: ['MOVE_SWAGGER', null, null, null],
      partnerChosen: 0,
    })
    const result = scoreDoubles(state, deps, aiId, 'MOVE_SWAGGER')
    expect(result.unmodelled.some((u) => u.includes('IsConfusionMoveEffect'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 7. EFFECT_PLEDGE, battle_ai_main.c:1901-1910.
//   if (isDoubleBattle && partner hp > 0) {
//     if (partnerMove != MOVE_NONE && partnerMove.effect == EFFECT_PLEDGE &&
//         move != partnerMove)
//       if (partner.status1 & (SLEEP | FREEZE)) -10;
//   }
// Released pledge moves are EFFECT_ARGUMENT_HIT (MoveList.textproto
// :8667-8679), so the effect is remapped to EFFECT_PLEDGE for this branch --
// see the file header.
// ---------------------------------------------------------------------------
describe('EFFECT_PLEDGE combo (battle_ai_main.c:1901-1910)', () => {
  function pledgeFixture(partnerMoves: Slot4<string | null>, partnerStatus = 0) {
    const fixture = doublesFixture({ aiMoves: ['MOVE_GRASS_PLEDGE', null, null, null], partnerMoves, partnerChosen: 0 })
    overrideEffect(fixture.deps, 'MOVE_GRASS_PLEDGE', 'EFFECT_PLEDGE')
    overrideEffect(fixture.deps, 'MOVE_FIRE_PLEDGE', 'EFFECT_PLEDGE')
    if (partnerStatus) fixture.state.battlers[1]!.mon.status1 = partnerStatus
    return fixture
  }

  it('doubles, partner chose a different pledge and is asleep: 100 - 10 = 90', () => {
    const { state, deps, aiId } = pledgeFixture(['MOVE_FIRE_PLEDGE', null, null, null], STATUS1_SLEEP)
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASS_PLEDGE').score).toBe(90)
  })

  it('doubles, partner chose a different pledge and is frozen: 100 - 10 = 90', () => {
    const { state, deps, aiId } = pledgeFixture(['MOVE_FIRE_PLEDGE', null, null, null], STATUS1_FREEZE)
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASS_PLEDGE').score).toBe(90)
  })

  it('doubles, partner chose a different pledge but is awake: 100', () => {
    const { state, deps, aiId } = pledgeFixture(['MOVE_FIRE_PLEDGE', null, null, null])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASS_PLEDGE').score).toBe(100)
  })

  it('doubles, partner chose the same pledge move: 100', () => {
    const { state, deps, aiId } = pledgeFixture(['MOVE_GRASS_PLEDGE', null, null, null], STATUS1_SLEEP)
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASS_PLEDGE').score).toBe(100)
  })

  it('doubles, partner at 0 HP: 100 (no partner move is read)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_GRASS_PLEDGE', null, null, null], partnerAlive: false })
    overrideEffect(deps, 'MOVE_GRASS_PLEDGE', 'EFFECT_PLEDGE')
    state.battlers[1]!.mon.status1 = STATUS1_SLEEP
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASS_PLEDGE').score).toBe(100)
  })

  it('singles: 100 (isDoubleBattle gate)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_GRASS_PLEDGE', null, null, null] })
    overrideEffect(deps, 'MOVE_GRASS_PLEDGE', 'EFFECT_PLEDGE')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GRASS_PLEDGE').score).toBe(100)
  })

  it('the removed EFFECT_PLEDGE combo gap note is gone', () => {
    const { state, deps, aiId } = pledgeFixture(['MOVE_FIRE_PLEDGE', null, null, null], STATUS1_SLEEP)
    const result = scoreDoubles(state, deps, aiId, 'MOVE_GRASS_PLEDGE')
    expect(result.unmodelled.some((u) => u.includes('EFFECT_PLEDGE combo'))).toBe(false)
  })
})
