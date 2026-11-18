/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4d (dbl-4d): GetAIPartyIndexes and the multi-battler party range it
// feeds, plus the TWO_OPPONENTS AI-flag branch.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_ai_switch_items.c:30-47   GetAIPartyIndexes
//   battle_ai_switch_items.c:1004    GetMostSuitableMonToSwitchInto's range
//   battle_ai_switch_items.c:768-797 GetBestMonBatonPass's rejection draw
//   battle_ai_switch_items.c:643,732 ShouldSwitch availableToSwitch; AI_TrySwitchOrUseItem fallback
//   battle_controller_opponent.c:1652-1683 OpponentHandleChoosePokemon fallback
//   battle_ai_main.c:144-145,152-154 BattleAI_SetupFlags TWO_OPPONENTS + DOUBLE_BATTLE
//
// LAYOUT: two-opponent format. buildBattleState lays trainer A's party in the
// opponent roster's slots 0-2 and trainer B's in 3-5 (battleFormat.ts:
// twoTrainerRoster), with battler 1 at slot 0 and battler 3 at slot 3
// (startingPartyIndexes' TWO_OPPONENTS override). The AI battlers are 1 and 3;
// battler 3's flank is right (`3 & BIT_FLANK` = 2) so its range is [3,6), and
// battler 1's is [0,3).

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import { createRandomSource } from './rng'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import {
  BATTLE_TYPE_DOUBLE,
  BATTLE_TYPE_INGAME_PARTNER,
  BATTLE_TYPE_TRAINER,
  BATTLE_TYPE_TWO_OPPONENTS,
  PARTY_SIZE,
} from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { createAiOpponentReplacement, getAiPartyIndexes, getMostSuitableMonToSwitchInto } from './ai/aiSwitching'
import { aiTrySwitchOrUseItem } from './ai/aiShouldSwitch'
import {
  AI_FLAG_CHECK_BAD_MOVE,
  AI_FLAG_CHECK_FOE,
  AI_FLAG_CHECK_VIABILITY,
  AI_FLAG_DOUBLE_BATTLE,
  AI_FLAG_TRY_TO_FAINT,
  battleAiSetupFlags,
  trainerAiFlags,
  type TrainerAiRow,
} from './ai/aiFlags'

const data = loadSimData()
const trainerA = data.trainersById.get('TRAINER_SAWYER_1')!
const trainerB = data.trainersById.get('TRAINER_ROXANNE_1')!

const SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

/** A two-opponent state: trainer A in opponent slots 0-2, trainer B in 3-5. */
function makeMulti(rng: RandomSource): BattleState {
  return buildBattleState(
    { opponents: [trainerA, trainerB] },
    {
      data,
      tier: 'elite',
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentParties: [buildOpponentParty(trainerA, 'elite', 50, data), buildOpponentParty(trainerB, 'elite', 50, data)],
      rng,
    },
  )
}

function makeSingles(rng: RandomSource): BattleState {
  return buildBattleState(
    { opponents: [trainerA], forcedDouble: false },
    {
      data,
      tier: 'elite',
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentParties: [buildOpponentParty(trainerA, 'elite', 50, data)],
      rng,
    },
  )
}

/** Every battler full HP, no status, no item, plain Blaze, Normal/Mystery types
 * -- each test then varies only the fields it is about. Same fixture shape as
 * cycle4c8SwitchDoubles.test.ts. */
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

/** A scripted RandomSource that also counts draws. */
function scripted(...values: number[]): { rng: RandomSource; draws: () => number } {
  let i = 0
  return { rng: { random16: () => values[i++] ?? 0 }, draws: () => i }
}

function deps(state: BattleState): AiDamageDeps {
  return aiDamageDepsFor(data, state)
}

const opponentParty = (state: BattleState): SimPartyMon[] => state.sides[1].party

function setSlot(party: SimPartyMon[], index: number, opts: { moves?: Slot4<string | null>; types?: [string, string, string] }): void {
  const mon = party[index]!
  mon.hp = mon.maxHp
  mon.moves = opts.moves ?? ['MOVE_TACKLE', null, null, null]
  mon.abilities = { ability: null, innates: [null, null, null] }
  mon.types = opts.types ?? ['NORMAL', 'MYSTERY', 'MYSTERY']
}

describe('getAiPartyIndexes (battle_ai_switch_items.c:30-47)', () => {
  function withFlags(flags: number): BattleState {
    const state = makeMulti(createRandomSource(1))
    state.battleTypeFlags = flags
    return state
  }

  it('no multi flag -> the else branch [0,6) for every battler (:43-46)', () => {
    const none = withFlags(0)
    for (const id of [0, 1, 2, 3]) expect(getAiPartyIndexes(none, id)).toEqual([0, PARTY_SIZE])
    // BATTLE_TYPE_DOUBLE alone is still the else branch (it is not in the mask).
    const dbl = withFlags(BATTLE_TYPE_DOUBLE)
    for (const id of [0, 1, 2, 3]) expect(getAiPartyIndexes(dbl, id)).toEqual([0, PARTY_SIZE])
  })

  it('TWO_OPPONENTS splits BOTH sides by flank (:36-42)', () => {
    // The test is `battlerId & BIT_FLANK`, not the side: 0/1 are left-flank
    // (bit clear) -> [0,3); 2/3 are right-flank -> [3,6).
    const state = withFlags(BATTLE_TYPE_TWO_OPPONENTS)
    expect(getAiPartyIndexes(state, 0)).toEqual([0, 3])
    expect(getAiPartyIndexes(state, 1)).toEqual([0, 3])
    expect(getAiPartyIndexes(state, 2)).toEqual([3, 6])
    expect(getAiPartyIndexes(state, 3)).toEqual([3, 6])
  })

  it('INGAME_PARTNER|TWO_OPPONENTS takes the same branch', () => {
    const state = withFlags(BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_INGAME_PARTNER)
    expect(getAiPartyIndexes(state, 0)).toEqual([0, 3])
    expect(getAiPartyIndexes(state, 1)).toEqual([0, 3])
    expect(getAiPartyIndexes(state, 2)).toEqual([3, 6])
    expect(getAiPartyIndexes(state, 3)).toEqual([3, 6])
  })

  it('TOWER_LINK_MULTI alone takes the same branch', () => {
    // include/constants/battle.h:73 -- BATTLE_TYPE_TOWER_LINK_MULTI is 1 << 23.
    const state = withFlags(1 << 23)
    expect(getAiPartyIndexes(state, 0)).toEqual([0, 3])
    expect(getAiPartyIndexes(state, 1)).toEqual([0, 3])
    expect(getAiPartyIndexes(state, 2)).toEqual([3, 6])
    expect(getAiPartyIndexes(state, 3)).toEqual([3, 6])
  })
})

/** Board for battler 3: trainer A's slot 1 is a Fire/Ember candidate OUTSIDE
 * [3,6); trainer B's slots 3-5 are all plain Normal/Tackle. Battler 2 (the
 * BATTLE_OPPOSITE battler 3 attacks into) is Bug-typed, so slot 1 is the
 * objectively better offensive pick. */
function battlerThreeBoard(rng: RandomSource): BattleState {
  const state = makeMulti(rng)
  normaliseBattlers(state)
  const party = opponentParty(state)
  for (let i = 0; i < 6; i++) setSlot(party, i, {})
  setSlot(party, 1, { moves: ['MOVE_EMBER', null, null, null], types: ['FIRE', 'FIRE', 'MYSTERY'] })
  state.battlers[2]!.mon.types = ['BUG', 'BUG', 'MYSTERY']
  return state
}

/** Board for battler 1: trainer A's slots 1/2 are plain Normal/Tackle (inside
 * [0,3)); trainer B's slots 4/5 are Fire/Ember candidates OUTSIDE [0,3).
 * Battler 0 (BATTLE_OPPOSITE(1)) is Bug-typed, so 4/5 are the better offensive
 * picks. */
function battlerOneBoard(rng: RandomSource): BattleState {
  const state = makeMulti(rng)
  normaliseBattlers(state)
  const party = opponentParty(state)
  for (let i = 0; i < 6; i++) setSlot(party, i, {})
  for (const i of [4, 5]) setSlot(party, i, { moves: ['MOVE_EMBER', null, null, null], types: ['FIRE', 'FIRE', 'MYSTERY'] })
  state.battlers[0]!.mon.types = ['BUG', 'BUG', 'MYSTERY']
  return state
}

describe('getMostSuitableMonToSwitchInto: multi range (:1004)', () => {
  it('battler 3 only considers [3,6) -- an out-of-range better candidate is ignored', () => {
    const state = battlerThreeBoard(createRandomSource(1))
    expect(state.battlers[3]!.partyIndex).toBe(3)
    expect(state.battlers[3]!.monToSwitchIntoId).toBe(PARTY_SIZE)
    // [3,6): slot 3 is the active partyIndex (:1011), slots 4/5 are Normal vs
    // Bug; Offensive finds no super-effective move, Dmg picks one of them. If
    // the range were still 0..6, slot 1's Fire/Ember (2x vs Bug) would win.
    const pick = getMostSuitableMonToSwitchInto(state, 3, deps(state)).partyIndex
    expect(pick).toBeGreaterThanOrEqual(3)
    expect(pick).toBeLessThan(6)
  })

  it('battler 1 only considers [0,3) -- an out-of-range better candidate is ignored', () => {
    const state = battlerOneBoard(createRandomSource(1))
    expect(state.battlers[1]!.partyIndex).toBe(0)
    // [0,3): slot 0 active, slots 1/2 Normal vs Bug -> Dmg picks one of them. If
    // the range were 0..6, trainer B's Fire/Ember at slot 4 (2x vs Bug) would win.
    const pick = getMostSuitableMonToSwitchInto(state, 1, deps(state)).partyIndex
    expect(pick).toBeGreaterThanOrEqual(1)
    expect(pick).toBeLessThan(3)
  })

  it('negative: the same board as a plain double is free to pick across 0-5', () => {
    // Control: clearing TWO_OPPONENTS (DOUBLE stays set) restores the else
    // branch [0,6); the same battler-1 board now chooses the out-of-range slot 4.
    const state = battlerOneBoard(createRandomSource(1))
    state.battleTypeFlags &= ~BATTLE_TYPE_TWO_OPPONENTS
    expect(getMostSuitableMonToSwitchInto(state, 1, deps(state)).partyIndex).toBe(4)
  })
})

describe('Baton Pass rejection draw is % (lastId - firstId) (:791)', () => {
  it('in a [3,6) range the draw is % 3 and lands at firstId + 1', () => {
    // Every opponent slot carries Baton Pass, so the rejection loop's only
    // degree of freedom is the modulus. Battler 3's range is [3,6): slot 3 is
    // its own active partyIndex, so aliveCount == 2 (:1012-1024) and the
    // aliveCount % 3 gate (:776) is skipped -- the ONE remaining draw is the
    // rejection loop's. Value 1: (1 % 3) + 3 = 4. If the range were 0..6 the
    // old code would draw (1 % 6) + 0 = 1 instead.
    const counter = scripted(1)
    const state = makeMulti(counter.rng)
    normaliseBattlers(state)
    const party = opponentParty(state)
    for (let i = 0; i < 6; i++) setSlot(party, i, { moves: ['MOVE_BATON_PASS', null, null, null] })

    const result = getMostSuitableMonToSwitchInto(state, 3, deps(state))
    expect(result.partyIndex).toBe(4)
    expect(counter.draws()).toBe(1)
  })
})

describe('aiTrySwitchOrUseItem fallback loop respects the range (:732)', () => {
  const stubGetMostSuitable = () => ({ partyIndex: PARTY_SIZE, unmodelled: [] })

  it('battler 3 scans [3,6): live reserves in trainer A slots 0-2 are not chosen', () => {
    const state = makeMulti(createRandomSource(1))
    normaliseBattlers(state)
    const party = opponentParty(state)
    for (let i = 0; i < 6; i++) setSlot(party, i, {})
    party[5]!.hp = 0
    state.aiSwitchMon = true
    // availableToSwitch counts slot 4 (in [3,6), :643), so ShouldSwitch proceeds;
    // ShouldSwitchIfAllBadMoves (:49-62) decides TRUE with a PARTY_SIZE target;
    // the stub then returns PARTY_SIZE and the fallback runs. :732's
    // GetAIPartyIndexes gives [3,6); slot 3 is the own partyIndex (:737), slot
    // 4 is the first live in range.
    const result = aiTrySwitchOrUseItem(state, 3, deps(state), stubGetMostSuitable, 0, { kind: 'move', moveIndex: 0 }, null)
    expect(result.switched).toBe(true)
    expect(state.battlers[3]!.aiMonToSwitchIntoId).toBe(4)
    expect(state.battlers[3]!.monToSwitchIntoId).toBe(4)
  })

  it('only out-of-range live reserves -> availableToSwitch is 0 and no switch happens (:643)', () => {
    const state = makeMulti(createRandomSource(1))
    normaliseBattlers(state)
    const party = opponentParty(state)
    for (let i = 0; i < 6; i++) setSlot(party, i, {})
    for (const i of [3, 4, 5]) party[i]!.hp = 0
    state.aiSwitchMon = true
    const result = aiTrySwitchOrUseItem(state, 3, deps(state), stubGetMostSuitable, 0, { kind: 'move', moveIndex: 0 }, null)
    // availableToSwitch over [3,6) is 0 (:643-652), so ShouldSwitch returns
    // FALSE before ever consulting the AI's own switchMon flag. With the range
    // at 0..6 the three live trainer-A slots would have made it TRUE.
    expect(result.switched).toBe(false)
    expect(state.battlers[3]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)
  })
})

describe('createAiOpponentReplacement fallback (:1652-1683)', () => {
  it('battler 3 returns the first live slot in [3,6), excluding battlers 1 and 3', () => {
    const state = makeMulti(createRandomSource(1))
    normaliseBattlers(state)
    const party = opponentParty(state)
    for (let i = 0; i < 6; i++) setSlot(party, i, {})
    party[5]!.hp = 0
    // The partner (battler 1) has queued slot 4, so GetMostSuitableMonToSwitchInto
    // invalidates it (:1014) and returns PARTY_SIZE; the C fallback does NOT
    // test monToSwitchIntoId (:1672-1674), only HP and the two active slots, so
    // it still picks 4. battler1/battler3 are party indexes 0 and 3.
    state.battlers[1]!.monToSwitchIntoId = 4
    const chosen = createAiOpponentReplacement(deps(state)).chooseReplacement(state, 3, [])
    expect(chosen).toBe(4)
  })

  it('battler 1 falls out of the loop at lastId (3), not PARTY_SIZE', () => {
    const state = makeMulti(createRandomSource(1))
    normaliseBattlers(state)
    const party = opponentParty(state)
    for (let i = 0; i < 6; i++) setSlot(party, i, {})
    for (const i of [1, 2, 3]) party[i]!.hp = 0
    // GetMostSuitableMonToSwitchInto's [0,3) pass has no live reserve -> PARTY_SIZE.
    // The fallback's own loop over [0,3) excludes slot 0 (battler 1's active
    // slot) and skips the dead 1/2, then exits with chosenMonId == lastId == 3
    // (:1670-1678). Trainer B's live slots 4/5 are outside the range.
    const chosen = createAiOpponentReplacement(deps(state)).chooseReplacement(state, 1, [])
    expect(chosen).toBe(3)
  })

  it('singles is unchanged: first live slot, or PARTY_SIZE when none', () => {
    const state = makeSingles(createRandomSource(1))
    normaliseBattlers(state)
    // Singles keeps the caller's party untouched (layoutRosters), so SAWYER's
    // five mons fill slots 0-4 and slot 5 does not exist.
    const party = state.sides[1].party
    for (let i = 0; i < party.length; i++) setSlot(party, i, {})
    for (let i = 2; i < party.length; i++) party[i]!.hp = 0
    // Slot 1 is the only live reserve but is Truant, and battler 0 has Protect,
    // so IsTruantMonVulnerable (:587-596) makes GetMostSuitableMonToSwitchInto
    // return PARTY_SIZE (:1020). The fallback then takes slot 1 over [0,PARTY_SIZE).
    party[1]!.abilities = { ability: 'ABILITY_TRUANT', innates: [null, null, null] }
    state.battlers[0]!.mon.moves = ['MOVE_PROTECT', null, null, null]
    const chosen = createAiOpponentReplacement(deps(state)).chooseReplacement(state, 1, [])
    expect(chosen).toBe(1)

    // Nothing alive at all: the loop falls out at lastId == PARTY_SIZE == 6,
    // which is the same value the pre-change sim returned.
    party[1]!.hp = 0
    const none = createAiOpponentReplacement(deps(state)).chooseReplacement(state, 1, [])
    expect(none).toBe(PARTY_SIZE)
  })
})

describe('battleAiSetupFlags: the TWO_OPPONENTS branch (battle_ai_main.c:144-145)', () => {
  const trainer: TrainerAiRow = { risky: true, preferStall: true, preferStatus: true, noSwitching: true, forcedDouble: false }

  it('replaces the trainer-derived set entirely, then DOUBLE_BATTLE is ORed in', () => {
    // :144-145 selects the fixed four flags; :152-154 ORs AI_FLAG_DOUBLE_BATTLE
    // because TWO_OPPONENTS (and DOUBLE) are set.
    expect(battleAiSetupFlags(trainer, BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TRAINER)).toBe(
      AI_FLAG_CHECK_BAD_MOVE | AI_FLAG_TRY_TO_FAINT | AI_FLAG_CHECK_VIABILITY | AI_FLAG_CHECK_FOE | AI_FLAG_DOUBLE_BATTLE,
    )
  })

  it('negative: plain DOUBLE keeps the full trainer-derived set', () => {
    // :147's else branch: gTrainers[].aiFlags, which trainerAiFlags reproduces.
    expect(battleAiSetupFlags(trainer, BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TRAINER)).toBe(trainerAiFlags(trainer) | AI_FLAG_DOUBLE_BATTLE)
  })
})
