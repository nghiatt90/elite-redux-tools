/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4c6 (dbl-4c6, first slice): the doubles halves of AI_CheckViability's
// ROAR/CLEAR_SMOG stat count and of the four already-transcribed cases whose
// `isDoubleBattle` branch had no reaching test (Magic Room, Quash, Tailwind,
// Lucky Chant).
//
// C lines checked (pipeline/.upstream/eliteredux-source):
//   EFFECT_ROAR / EFFECT_CLEAR_SMOG (doubles cap 7)   battle_ai_main.c:2835-2842
//   EFFECT_MAGIC_ROOM partner term                    battle_ai_main.c:3750-3756
//   EFFECT_QUASH partner-vs-target order              battle_ai_main.c:3852-3855
//   EFFECT_TAILWIND side speed average                battle_ai_main.c:3856-3858
//   EFFECT_LUCKY_CHANT doubles reserve gate           battle_ai_main.c:3859-3865
//   GetWhoStrikesFirst (1 = 2nd arg fast)             battle_main.c:4386-4398
//   GetBattlerSideSpeedAverage (doubles average)      battle_ai_util.c:2181-2196
//   CountUsablePartyMons (both field slots excluded)  battle_ai_util.c:2447-2474
//
// LAYOUT (same as cycle4c3/4c4/4c5): doubles, battlers 0/2 player side, 1/3
// opponent side. The AI is battler 3 and its ally is battler 1; battlerDef is
// battler 0 and the defender's partner is battler 2. In singles the AI is
// battler 1 and the foe battler 0.
//
// Every expected number starts from a base derived by running the SAME call
// with the effect's trigger disabled (no raised stages, no items, the partner
// on the other side of the speed comparison, or the reserve fainted), and the
// C arithmetic is in the assertion message. No call here draws RNG for the
// scoring term under test: QUASH passes noRng=TRUE (battle_ai_main.c:3853) and
// the rest are status moves. Separate fixtures are built for each call so the
// seeded RNG stream starts identically in both.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import { STAT_ACC, STAT_ATK, STAT_DEF, STAT_SPATK, STAT_SPEED } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiCheckViability as aiCheckViabilityAt } from './ai/aiCheckViability'

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

function setStages(state: BattleState, id: number, stats: readonly number[]): void {
  for (const stat of stats) setStat(state, id, stat, 8) // > DEFAULT_STAT_STAGE (6)
}

// ---------------------------------------------------------------------------
// 1. EFFECT_ROAR / EFFECT_CLEAR_SMOG, battle_ai_main.c:2835-2842.
//   if (isDoubleBattle)
//       score += min(CountPositiveStatStages(battlerDef)
//                    + CountPositiveStatStages(BATTLE_PARTNER(battlerDef)), 7);
//   else
//       score += min(CountPositiveStatStages(battlerDef), 4);
// The doubles half reads the partner's stats even when it is fainted (stages
// persist), so the sim only guards the slot, not liveness.
// ---------------------------------------------------------------------------
const ROAR_MOVES = ['MOVE_ROAR', 'MOVE_CLEAR_SMOG'] as const
const THREE = [STAT_ATK, STAT_DEF, STAT_ACC]
const TWO = [STAT_ATK, STAT_DEF]
const FOUR = [STAT_ATK, STAT_DEF, STAT_ACC, STAT_SPEED]
const FIVE = [STAT_ATK, STAT_DEF, STAT_ACC, STAT_SPEED, STAT_SPATK]

describe('EFFECT_ROAR / EFFECT_CLEAR_SMOG doubles stat count (battle_ai_main.c:2835-2842)', () => {
  it.each(ROAR_MOVES)('%s: defender 3 + partner 2 in doubles = +min(3+2,7)=5', (moveId) => {
    const on = doublesFixture({ aiMoves: [moveId, null, null, null] })
    setStages(on.state, 0, THREE) // battlerDef
    setStages(on.state, 2, TWO) // BATTLE_PARTNER(battlerDef)
    const onScore = aiCheckViability(on.state, on.aiId, 0, moveId, 100, on.deps).score

    const base = doublesFixture({ aiMoves: [moveId, null, null, null] })
    const baseScore = aiCheckViability(base.state, base.aiId, 0, moveId, 100, base.deps).score

    expect(onScore - baseScore, 'doubles: min(3 + 2, 7) = 5 over the all-stages-6 base').toBe(5)
  })

  it.each(ROAR_MOVES)('%s: the same 3 raised stats in singles = +min(3,4)=3', (moveId) => {
    const on = singlesFixture({ aiMoves: [moveId, null, null, null] })
    setStages(on.state, 0, THREE)
    const onScore = aiCheckViability(on.state, on.aiId, 0, moveId, 100, on.deps).score

    const base = singlesFixture({ aiMoves: [moveId, null, null, null] })
    const baseScore = aiCheckViability(base.state, base.aiId, 0, moveId, 100, base.deps).score

    expect(onScore - baseScore, 'singles: min(3, 4) = 3 -- no partner term').toBe(3)
  })

  it.each(ROAR_MOVES)('%s: doubles cap is 7, not 4+5=9', (moveId) => {
    const on = doublesFixture({ aiMoves: [moveId, null, null, null] })
    setStages(on.state, 0, FOUR)
    setStages(on.state, 2, FIVE)
    const onScore = aiCheckViability(on.state, on.aiId, 0, moveId, 100, on.deps).score

    const base = doublesFixture({ aiMoves: [moveId, null, null, null] })
    const baseScore = aiCheckViability(base.state, base.aiId, 0, moveId, 100, base.deps).score

    expect(onScore - baseScore, 'doubles: min(4 + 5, 7) = 7, not 9').toBe(7)
  })

  it.each(ROAR_MOVES)('%s: singles cap is 4, not 5', (moveId) => {
    const on = singlesFixture({ aiMoves: [moveId, null, null, null] })
    setStages(on.state, 0, FIVE)
    const onScore = aiCheckViability(on.state, on.aiId, 0, moveId, 100, on.deps).score

    const base = singlesFixture({ aiMoves: [moveId, null, null, null] })
    const baseScore = aiCheckViability(base.state, base.aiId, 0, moveId, 100, base.deps).score

    expect(onScore - baseScore, 'singles: min(5, 4) = 4').toBe(4)
  })

  it.each(ROAR_MOVES)('%s: doubles with the partner at default stages = +min(2+0,7)=2', (moveId) => {
    const on = doublesFixture({ aiMoves: [moveId, null, null, null] })
    setStages(on.state, 0, TWO)
    const onScore = aiCheckViability(on.state, on.aiId, 0, moveId, 100, on.deps).score

    const base = doublesFixture({ aiMoves: [moveId, null, null, null] })
    const baseScore = aiCheckViability(base.state, base.aiId, 0, moveId, 100, base.deps).score

    expect(onScore - baseScore, 'doubles: min(2 + 0, 7) = 2').toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 2. EFFECT_MAGIC_ROOM, battle_ai_main.c:3750-3756.
//   score++;
//   if (holdEffects[atk] == NONE && holdEffects[def] != NONE) score++;
//   if (isDoubleBattle && holdEffects[partner(atk)] == NONE &&
//       holdEffects[partner(def)] != NONE) score++;
// `holdEffects[]` is filled from ItemId_GetHoldEffectParam, and HOLD_EFFECT_NONE
// is the numeric id 0; ITEM_ORAN_BERRY's holdEffectStrength is 10, so it reads
// as "not NONE" (aiCalcDamage.ts's aiHoldEffectParam).
// ---------------------------------------------------------------------------
const ORAN = 'ITEM_ORAN_BERRY'

function magicRoomDoubles(defItem: boolean, defPartnerItem: boolean, aiPartnerItem: boolean): number {
  const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_MAGIC_ROOM', null, null, null] })
  if (defItem) state.battlers[0]!.mon.itemId = ORAN
  if (defPartnerItem) state.battlers[2]!.mon.itemId = ORAN
  if (aiPartnerItem) state.battlers[1]!.mon.itemId = ORAN
  return aiCheckViability(state, aiId, 0, 'MOVE_MAGIC_ROOM', 100, deps).score
}

function magicRoomSingles(defItem: boolean): number {
  const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_MAGIC_ROOM', null, null, null] })
  if (defItem) state.battlers[0]!.mon.itemId = ORAN
  return aiCheckViability(state, aiId, 0, 'MOVE_MAGIC_ROOM', 100, deps).score
}

describe('EFFECT_MAGIC_ROOM partner item term (battle_ai_main.c:3750-3756)', () => {
  it('doubles: attacker + partner itemless, both defenders holding = +2 over the itemless base', () => {
    // The itemless base is 101 (pre-effect 100 + the unconditional score++); the
    // full setup is 103 = 100 + 1 (line 3751) + 1 (3752) + 1 (3753-3755).
    const base = magicRoomDoubles(false, false, false) // score++ only
    const full = magicRoomDoubles(true, true, false)
    expect(full - base, 'second line +1, third line +1 -> 103 over the itemless 101').toBe(2)
  })

  it('doubles: the defender partner holding nothing removes the third point', () => {
    // 102 = 100 + score++ + the defender-item line; the partner condition fails.
    const base = magicRoomDoubles(false, false, false)
    const noPartnerItem = magicRoomDoubles(true, false, false)
    expect(noPartnerItem - base, 'only the defender-item line fires -> +1 over the itemless base').toBe(1)
  })

  it('doubles: the AI partner holding an item removes the third point', () => {
    // 102 = 100 + score++ + the defender-item line; holdEffects[partner(atk)] is not NONE.
    const base = magicRoomDoubles(false, false, false)
    const aiItem = magicRoomDoubles(true, true, true)
    expect(aiItem - base, 'third line fails on the AI partner -> +1 over the itemless base').toBe(1)
  })

  it('singles: the partner term cannot run, +1 over the itemless base', () => {
    // 102 = 100 + score++ + the defender-item line; no isDoubleBattle third line.
    const base = magicRoomSingles(false)
    const defItem = magicRoomSingles(true)
    expect(defItem - base, 'singles: only the defender-item line fires -> +1').toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 3. EFFECT_QUASH, battle_ai_main.c:3852-3855.
//   if (isDoubleBattle && GetWhoStrikesFirst(BATTLE_PARTNER(battlerAtk), battlerDef, TRUE) == 1)
//       score++;  // Attacker partner wouldn't go before target
// getWhoStrikesFirst returns 0 when its first argument is faster, 1 when the
// second is (turnOrder.ts:557-572), and ignoreChosenMoves=TRUE means no
// chosen-move lookup and no speed-tie draw for unequal speeds.
// ---------------------------------------------------------------------------
function quashDoubles(partnerSpeed: number, defSpeed: number): number {
  // The ally's chosen move stays absent and Trick Room stays off (the fixture's
  // defaults), so GetWhoStrikesFirst compares raw speed -- ignoreChosenMoves=TRUE
  // means neither is read anyway.
  const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_QUASH', null, null, null] })
  setSpeed(state, 1, partnerSpeed) // BATTLE_PARTNER(battlerAtk=3)
  setSpeed(state, 0, defSpeed) // battlerDef
  return aiCheckViability(state, aiId, 0, 'MOVE_QUASH', 100, deps).score
}

function quashSingles(defSpeed: number): number {
  const { state, deps, aiId } = singlesFixture({ aiMoves: ['MOVE_QUASH', null, null, null] })
  setSpeed(state, 0, defSpeed)
  return aiCheckViability(state, aiId, 0, 'MOVE_QUASH', 100, deps).score
}

describe('EFFECT_QUASH partner-vs-target order (battle_ai_main.c:3852-3855)', () => {
  it('doubles: a slower partner (10 vs 200) adds +1', () => {
    const slowPartner = quashDoubles(10, 200) // GetWhoStrikesFirst -> 1
    const fastPartner = quashDoubles(200, 10) // GetWhoStrikesFirst -> 0 (trigger off)
    expect(slowPartner - fastPartner, 'partner 10 < target 200 -> returns 1 -> +1').toBe(1)
  })

  it('doubles: a faster partner (200 vs 10) adds nothing', () => {
    const fastPartner = quashDoubles(200, 10)
    const slowPartner = quashDoubles(10, 200)
    expect(fastPartner - slowPartner, 'partner 200 > target 10 -> returns 0 -> no bonus (-1 vs the slow case)').toBe(-1)
  })

  it('singles: the isDoubleBattle guard makes the target speed irrelevant', () => {
    const fastTarget = quashSingles(200)
    const slowTarget = quashSingles(10)
    expect(fastTarget - slowTarget, 'singles: no partner, GetWhoStrikesFirst is never called -> 0 difference').toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4. EFFECT_TAILWIND, battle_ai_main.c:3856-3858.
//   if (GetBattlerSideSpeedAverage(battlerAtk) < GetBattlerSideSpeedAverage(battlerDef))
//       score += 2;
// GetBattlerSideSpeedAverage (battle_ai_util.c:2181-2196) averages the battler
// and, in a double, a LIVING partner: (own + partner) / numBattlersAlive.
// ---------------------------------------------------------------------------
interface TailwindSpeeds {
  ai: number
  aiAlly: number
  def: number
  defAlly: number
  allyFainted?: boolean
}

function tailwindScore(speeds: TailwindSpeeds): number {
  const { state, deps, aiId } = doublesFixture({
    aiMoves: ['MOVE_TAILWIND', null, null, null],
    partnerAlive: !speeds.allyFainted,
  })
  setSpeed(state, aiId, speeds.ai) // battler 3
  setSpeed(state, 1, speeds.aiAlly) // battler 1, the AI's ally
  setSpeed(state, 0, speeds.def) // battler 0, battlerDef
  setSpeed(state, 2, speeds.defAlly) // battler 2, the defender's ally
  return aiCheckViability(state, aiId, 0, 'MOVE_TAILWIND', 100, deps).score
}

describe('EFFECT_TAILWIND side speed average (battle_ai_main.c:3856-3858)', () => {
  it('doubles: AI side average (100+20)/2=60 < defender side 100 -> +2', () => {
    const slower = tailwindScore({ ai: 100, aiAlly: 20, def: 100, defAlly: 100 })
    const equal = tailwindScore({ ai: 100, aiAlly: 100, def: 100, defAlly: 100 }) // 100 < 100 false
    expect(slower - equal, '60 < 100 -> +2; the equal-average base adds nothing').toBe(2)
  })

  it('doubles: AI average 60 vs defender average 50 is not less -> no bonus', () => {
    const above = tailwindScore({ ai: 100, aiAlly: 20, def: 50, defAlly: 50 })
    const equal = tailwindScore({ ai: 100, aiAlly: 100, def: 50, defAlly: 50 })
    expect(above - equal, '60 < 50 false; the 100-vs-50 base is also false -> 0 difference').toBe(0)
  })

  it('doubles: an AI average of 50 vs 50 is not strictly less -> no bonus', () => {
    const equal = tailwindScore({ ai: 100, aiAlly: 0, def: 50, defAlly: 50 })
    const above = tailwindScore({ ai: 100, aiAlly: 20, def: 50, defAlly: 50 })
    expect(equal - above, '(100+0)/2 = 50 < 50 false, same as the 60-vs-50 no-bonus case -> 0').toBe(0)
  })

  it('doubles: a fainted partner is excluded, so the average is the battler alone', () => {
    const faintedAlly = tailwindScore({ ai: 50, aiAlly: 200, def: 100, defAlly: 100, allyFainted: true }) // 50 < 100 -> +2
    const livingAlly = tailwindScore({ ai: 50, aiAlly: 200, def: 100, defAlly: 100 }) // (50+200)/2 = 125 < 100 false
    expect(faintedAlly - livingAlly, 'IsBattlerAlive(partner) false -> numBattlersAlive 1 -> 50; alive -> 125').toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 5. EFFECT_LUCKY_CHANT, battle_ai_main.c:3859-3865.
//   if (!isDoubleBattle) score++;
//   else if (CountUsablePartyMons(battlerDef) > 0) score += 8;
// CountUsablePartyMons (battle_ai_util.c:2447-2474) excludes BOTH on-field
// party slots in a double; the fixture's player party has three mons and
// battlers 0/2 occupy slots 0/1, so slot 2 is the reserve.
// ---------------------------------------------------------------------------
function luckyChantDoubles(reserveAlive: boolean): number {
  const { state, deps, aiId } = doublesFixture({ aiMoves: ['MOVE_LUCKY_CHANT', null, null, null] })
  if (!reserveAlive) state.sides[0].party[2]!.hp = 0 // player side (battlerDef 0), third slot
  return aiCheckViability(state, aiId, 0, 'MOVE_LUCKY_CHANT', 100, deps).score
}

function luckyChantSingles(moveId: 'MOVE_LUCKY_CHANT' | 'MOVE_CELEBRATE'): number {
  const { state, deps, aiId } = singlesFixture({ aiMoves: [moveId, null, null, null] })
  return aiCheckViability(state, aiId, 0, moveId, 100, deps).score
}

describe('EFFECT_LUCKY_CHANT doubles reserve gate (battle_ai_main.c:3859-3865)', () => {
  it('doubles: a usable reserve in the defender party adds +8', () => {
    const withReserve = luckyChantDoubles(true)
    const noReserve = luckyChantDoubles(false) // trigger disabled
    expect(withReserve - noReserve, 'CountUsablePartyMons(def) = 1 > 0 -> +8 (line 3864)').toBe(8)
  })

  it('doubles: all reserves fainted -> CountUsablePartyMons == 0 -> +0', () => {
    const noReserve = luckyChantDoubles(false)
    const withReserve = luckyChantDoubles(true)
    expect(noReserve - withReserve, 'CountUsablePartyMons(def) = 0 -> the else-if body is skipped (-8 vs the reserve case)').toBe(-8)
  })

  it('singles: +1, and the reserve count is never read', () => {
    // MOVE_CELEBRATE (EFFECT_DO_NOTHING) is the same STATUS/USER/power-0/accuracy-0
    // shape, so it isolates the effect-case +1 from every pre-switch term.
    const luckyChant = luckyChantSingles('MOVE_LUCKY_CHANT')
    const celebrate = luckyChantSingles('MOVE_CELEBRATE')
    expect(luckyChant - celebrate, 'singles: the !isDoubleBattle branch adds exactly 1 (line 3861)').toBe(1)
  })
})
