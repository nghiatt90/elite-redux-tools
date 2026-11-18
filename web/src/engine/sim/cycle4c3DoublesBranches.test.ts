/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4c3 (dbl-4c3, first slice): the doubles halves of five AI_CheckBadMove
// branches that were previously singles-only or untranscribed.
//
// C lines checked (pipeline/.upstream/eliteredux-source):
//   IsValidDoubleBattle                       battle_ai_util.c:2270-2280
//   BATTLER_HAS_ABILITY_AND_ALIVE              include/battle_util.h:74
//   IsMoveRedirectionPrevented                 battle_ai_util.c:1130-1135
//   IsAbilityStatusProtected(CHECK_REDIRECTION) battle_script_commands.c:6579-6591
//     (redirection abilities: abilities.cc:10603-10609, :10612-10620)
//   AI_IsBattlerGrounded -> IsBattlerGrounded  battle_ai_util.c:1044, battle_util.c:6679-6683
//   def-partner ability block                  battle_ai_main.c:674-706
//   EFFECT_ROTOTILLER                          battle_ai_main.c:947-960
//   EFFECT_GEAR_UP                             battle_ai_main.c:961-982
//   EFFECT_MAGNETIC_FLUX                       battle_ai_main.c:986-1005
//   EFFECT_PERISH_SONG                         battle_ai_main.c:1281-1298
//   CountUsablePartyMons                       battle_ai_util.c:2447-2474
//   IsSoundproof                               battle_util.c:8864-8866
//   DoesPartnerHaveSameMoveEffect              battle_ai_util.c:2295-2304
//
// LAYOUT (same as cycle4c1/4c2): doubles, battlers 0/2 player side, 1/3
// opponent side. The AI is battler 3 and its ally is battler 1; battlerDef is
// battler 0, so BATTLE_PARTNER(battlerDef) is battler 2. In singles the AI is
// battler 1 and the foe battler 0.
//
// Every expected score starts at 100 and shows the arithmetic from the C.
// RNG: no case here draws.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, SimPartyMon, Slot4 } from './state'
import { STATUS3_PERISH_SONG } from './constants'
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

function setAbility(state: BattleState, id: number, ability: string, innates: [string | null, string | null, string | null] = [null, null, null]): void {
  state.battlers[id]!.mon.abilities = { ability, innates }
}

function setTypes(state: BattleState, id: number, types: [string, string, string]): void {
  state.battlers[id]!.mon.types = types
}

function setStat(state: BattleState, id: number, stat: number, value: number): void {
  state.battlers[id]!.mon.statStages[stat] = value
}

// ---------------------------------------------------------------------------
// 1. Def-partner ability checks, battle_ai_main.c:674-706 (inside
// `if (isDoubleBattle)` after the defender's own ability slot loop).
//   Magic Bounce :676-681  -> RETURN_SCORE_MINUS(20)
//     on BATTLER_HAS_ABILITY_AND_ALIVE(partner, MAGIC_BOUNCE, TRUE) &&
//        TestMoveFlags(move, FLAG_MAGIC_COAT_AFFECTED) &&
//        moveTarget & (BOTH | FOES_AND_ALLY | OPPONENTS_FIELD)
//   Sweet Veil   :683-686  -> RETURN_SCORE_MINUS(10) on EFFECT_SLEEP/YAWN
//   slot loop    :688-705  -> Lightning Rod/Electric or Reservoir|Storm
//     Drain/Water, each `&& !IsMoveRedirectionPrevented(move, partner)` -> -20;
//     Flower Veil + IS_BATTLER_OF_TYPE(battlerDef, GRASS) + a status-lowering
//     effect -> -10.
// The partner here is BATTLE_PARTNER(battlerDef) = battler 2.
// ---------------------------------------------------------------------------
describe('def-partner ability checks (battle_ai_main.c:674-706)', () => {
  it('doubles, def-partner Magic Bounce + Leer (BOTH, magicCoatAffected): 100 - 20 = 80', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_LEER', null, null, null] })
    setAbility(state, 2, 'ABILITY_MAGIC_BOUNCE')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LEER').score).toBe(80)
  })

  it('doubles, def-partner Magic Bounce + Earthquake (FOES_AND_ALLY but not magicCoatAffected): 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_EARTHQUAKE', null, null, null] })
    setAbility(state, 2, 'ABILITY_MAGIC_BOUNCE')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_EARTHQUAKE').score).toBe(100)
  })

  it('doubles, def-partner Sweet Veil + Spore (EFFECT_SLEEP): 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_SPORE', null, null, null] })
    setAbility(state, 2, 'ABILITY_SWEET_VEIL')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_SPORE').score).toBe(90)
  })

  it('doubles, def-partner Sweet Veil + Leer (not a sleep/yawn effect): 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_LEER', null, null, null] })
    setAbility(state, 2, 'ABILITY_SWEET_VEIL')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LEER').score).toBe(100)
  })

  it('doubles, def-partner Lightning Rod + Thunder Shock (Electric): 100 - 20 = 80', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_THUNDER_SHOCK', null, null, null] })
    setAbility(state, 2, 'ABILITY_LIGHTNING_ROD')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_THUNDER_SHOCK').score).toBe(80)
  })

  it('doubles, def-partner Lightning Rod but redirection prevented (Propeller Tail innate): 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_THUNDER_SHOCK', null, null, null] })
    setAbility(state, 2, 'ABILITY_LIGHTNING_ROD', ['ABILITY_PROPELLER_TAIL', null, null])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_THUNDER_SHOCK').score).toBe(100)
  })

  it('doubles, def-partner Storm Drain + Water Gun: 100 - 20 = 80', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_WATER_GUN', null, null, null] })
    setAbility(state, 2, 'ABILITY_STORM_DRAIN')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_WATER_GUN').score).toBe(80)
  })

  it('doubles, def-partner Flower Veil + Grass defender + Leer (stat lowering): 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_LEER', null, null, null] })
    setAbility(state, 2, 'ABILITY_FLOWER_VEIL')
    setTypes(state, 0, ['GRASS', 'MYSTERY', 'MYSTERY'])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LEER').score).toBe(90)
  })

  it('doubles, def-partner Flower Veil but the defender is not Grass: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_LEER', null, null, null] })
    setAbility(state, 2, 'ABILITY_FLOWER_VEIL')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LEER').score).toBe(100)
  })

  it('doubles, dead def-partner with Magic Bounce (BATTLER_HAS_ABILITY_AND_ALIVE fails): 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_LEER', null, null, null] })
    setAbility(state, 2, 'ABILITY_MAGIC_BOUNCE')
    state.battlers[2]!.mon.hp = 0
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LEER').score).toBe(100)
  })

  it('singles, Leer with a partner-shaped battler 2 absent: 100 (block gated on IsValidDoubleBattle)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_LEER', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_LEER').score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 2. EFFECT_ROTOTILLER, battle_ai_main.c:947-960.
//   doubles (:948-955): -10 unless the attacker OR its partner is
//     Grass && grounded && (ATK or SPATK can rise), the partner also
//     && !BattlerHasAbility(partner, CONTRARY, TRUE).
//   singles (:956-960): -10 unless Grass && grounded && (ATK or SPATK can rise).
// ---------------------------------------------------------------------------
describe('EFFECT_ROTOTILLER (battle_ai_main.c:947-960)', () => {
  it('doubles, attacker Grass + grounded + ATK can rise: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_ROTOTILLER', null, null, null] })
    setTypes(state, aiId, ['GRASS', 'MYSTERY', 'MYSTERY'])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_ROTOTILLER').score).toBe(100)
  })

  it('doubles, neither attacker nor partner qualifies: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_ROTOTILLER', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_ROTOTILLER').score).toBe(90)
  })

  it('doubles, only the partner qualifies (Grass, grounded, no Contrary, can rise): 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_ROTOTILLER', null, null, null] })
    setTypes(state, 1, ['GRASS', 'MYSTERY', 'MYSTERY'])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_ROTOTILLER').score).toBe(100)
  })

  it('doubles, partner qualifies but has Contrary: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_ROTOTILLER', null, null, null] })
    setTypes(state, 1, ['GRASS', 'MYSTERY', 'MYSTERY'])
    setAbility(state, 1, 'ABILITY_CONTRARY')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_ROTOTILLER').score).toBe(90)
  })

  it('singles, attacker Grass + grounded + ATK can rise: 100 (singles half now includes grounding)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_ROTOTILLER', null, null, null] })
    setTypes(state, aiId, ['GRASS', 'MYSTERY', 'MYSTERY'])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_ROTOTILLER').score).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// 3. EFFECT_GEAR_UP, battle_ai_main.c:961-982.
//   attacker PLUS/MINUS (:962-968): growth-style -10/-8 (unchanged, and its
//     `break` skips the doubles block).
//   otherwise (`!isDoubleBattle`, :969-971) -> -10, singles only.
//   doubles (:973-981):
//     if (!partnerHas(PLUS) || !partnerHas(MINUS))   // quirk: `||` as written
//       if ((!partnerCanRise(ATK) || !hasPhys(atk)) &&
//           (!partnerCanRise(SPATK) || !hasSpec(atk))) score -= 10;
//     else if (!atkHas(PLUS) && !atkHas(MINUS)) score -= 10;
// ---------------------------------------------------------------------------
describe('EFFECT_GEAR_UP (battle_ai_main.c:961-982)', () => {
  it('doubles, attacker has Plus and can raise ATK/SPATK with both splits present: 100 (unchanged)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_GEAR_UP', 'MOVE_TACKLE', 'MOVE_WATER_GUN', null] })
    setAbility(state, aiId, 'ABILITY_PLUS')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GEAR_UP').score).toBe(100)
  })

  it('doubles, attacker without Plus/Minus but the partner can rise and the attacker has a physical move: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_GEAR_UP', 'MOVE_TACKLE', null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GEAR_UP').score).toBe(100)
  })

  it('doubles (partner case 1), partner has neither Plus nor Minus, attacker has no usable split: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_GEAR_UP', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GEAR_UP').score).toBe(90)
  })

  it('doubles (partner case 2), partner has BOTH Plus and Minus (ability + innate), attacker neither: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_GEAR_UP', null, null, null] })
    setAbility(state, 1, 'ABILITY_PLUS', ['ABILITY_MINUS', null, null])
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GEAR_UP').score).toBe(90)
  })

  it('singles, attacker without Plus/Minus still takes the unconditional -10: 90 (unchanged)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_GEAR_UP', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_GEAR_UP').score).toBe(90)
  })
})

// ---------------------------------------------------------------------------
// 4. EFFECT_MAGNETIC_FLUX, battle_ai_main.c:986-1005.
//   attacker PLUS/MINUS (:987-991): DEF -10 else SPDEF -8.
//   otherwise (`!isDoubleBattle`, :992-994) -> -10, singles only.
//   doubles (:996-1004): same shape as Gear Up but the partner's DEF/SPDEF.
// ---------------------------------------------------------------------------
describe('EFFECT_MAGNETIC_FLUX (battle_ai_main.c:986-1005)', () => {
  it('doubles, attacker has Plus and can raise DEF: 100 (the attacker branch does not break)', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_MAGNETIC_FLUX', null, null, null] })
    setAbility(state, aiId, 'ABILITY_PLUS')
    expect(scoreDoubles(state, deps, aiId, 'MOVE_MAGNETIC_FLUX').score).toBe(100)
  })

  it('doubles, attacker without Plus/Minus and partner can raise DEF: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_MAGNETIC_FLUX', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_MAGNETIC_FLUX').score).toBe(100)
  })

  it('doubles, partner cannot raise DEF: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_MAGNETIC_FLUX', null, null, null] })
    setStat(state, 1, 2, 12)
    expect(scoreDoubles(state, deps, aiId, 'MOVE_MAGNETIC_FLUX').score).toBe(90)
  })

  it('doubles, partner DEF can rise but SPDEF is maxed: 100 - 8 = 92', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_MAGNETIC_FLUX', null, null, null] })
    setStat(state, 1, 5, 12)
    expect(scoreDoubles(state, deps, aiId, 'MOVE_MAGNETIC_FLUX').score).toBe(92)
  })

  it('singles, attacker without Plus/Minus takes the unconditional -10: 90 (unchanged)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_MAGNETIC_FLUX', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_MAGNETIC_FLUX').score).toBe(90)
  })
})

// ---------------------------------------------------------------------------
// 5. EFFECT_PERISH_SONG doubles half, battle_ai_main.c:1282-1292.
//   if (CountUsablePartyMons(atk) == 0 && !IsSoundproof(atk) &&
//       !IsSoundproof(partner) && CountUsablePartyMons(FOE(atk)) >= 1) -10
//   else if ((!IsBattlerAlive(foe) || IsSoundproof(foe) || foe perish-songed) &&
//            (!IsBattlerAlive(foePartner) || IsSoundproof(foePartner) || foePartner perish-songed)) -10
//   else if (DoesPartnerHaveSameMoveEffect(partner, battlerDef, move, partnerMove)) -10
// The singles `else` (:1293-1297) is unchanged.
// ---------------------------------------------------------------------------
describe('EFFECT_PERISH_SONG doubles half (battle_ai_main.c:1282-1292)', () => {
  it('doubles, attacker has no usable party mons left and the foe side has one: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_PERISH_SONG', null, null, null] })
    for (const mon of state.sides[1].party) {
      if (mon) mon.hp = 0
    }
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PERISH_SONG').score).toBe(90)
  })

  it('doubles, both foes already Perish Songed: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_PERISH_SONG', null, null, null] })
    state.battlers[0]!.statuses3 |= STATUS3_PERISH_SONG
    state.battlers[2]!.statuses3 |= STATUS3_PERISH_SONG
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PERISH_SONG').score).toBe(90)
  })

  it('doubles, partner chose Perish Song at the same defender: 100 - 10 = 90', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_PERISH_SONG', null, null, null],
      partnerMoves: ['MOVE_PERISH_SONG', null, null, null],
      partnerTarget: 0,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PERISH_SONG').score).toBe(90)
  })

  it('doubles, partner chose Perish Song aimed at the other foe: 100', () => {
    const { state, deps, aiId } = doublesFixture({
      aiMoves: ['MOVE_PERISH_SONG', null, null, null],
      partnerMoves: ['MOVE_PERISH_SONG', null, null, null],
      partnerTarget: 2,
    })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PERISH_SONG').score).toBe(100)
  })

  it('doubles, none of the three conditions fires: 100', () => {
    const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_PERISH_SONG', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PERISH_SONG').score).toBe(100)
  })

  it('singles, nobody Soundproof and party mons remain: 100 (singles else branch unchanged)', () => {
    const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_PERISH_SONG', null, null, null] })
    expect(scoreDoubles(state, deps, aiId, 'MOVE_PERISH_SONG').score).toBe(100)
  })
})
