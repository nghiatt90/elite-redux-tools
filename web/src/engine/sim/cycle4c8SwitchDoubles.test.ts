/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4c8 (dbl-4c8, final doubles slice): the BATTLE_TYPE_DOUBLE branches of
// AI_TrySwitchOrUseItem's local fallback loop (aiShouldSwitch.ts) and
// GetMostSuitableMonToSwitchInto (aiSwitching.ts).
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/battle_ai_switch_items.c):
//   AI_TrySwitchOrUseItem fallback loop battlerIn1/battlerIn2 + skips :721-742
//   GetMostSuitableMonToSwitchInto battlerIn1/battlerIn2 + opposing flip :985-999
//   GetMostSuitableMonToSwitchInto invalid-slot test incl. battlerIn2 :1007-1021
//
// LAYOUT (same as cycle4c3..4c7): doubles, battlers 0/2 player side, 1/3
// opponent side. The AI is battler 3 and its ally is battler 1, so its flank
// partner is `3 ^ BIT_FLANK = 1`, BATTLE_OPPOSITE(3) = 2, and the flipped
// opposing battler after an absent bit is `2 ^ BIT_FLANK = 0`. GetBattlerAtPosition
// is the identity for these non-multi battles, so the sim's battler ids ARE the
// C's positions. BATTLE_OPPOSITE(id) = id ^ 1 and BIT_FLANK = 2.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import { BATTLE_TYPE_DOUBLE, BATTLE_TYPE_TWO_OPPONENTS, PARTY_SIZE } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { aiTrySwitchOrUseItem } from './ai/aiShouldSwitch'
import { getMostSuitableMonToSwitchInto } from './ai/aiSwitching'

const data = loadSimData()
const trainer = data.trainersById.get('TRAINER_SAWYER_1')!

const SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

function makeState(forcedDouble: boolean, rng: RandomSource): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble },
    {
      data,
      tier: 'elite',
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentParties: [buildOpponentParty(trainer, 'elite', 50, data)],
      rng,
    },
  )
}

/** Every battler full HP, no status, no item, plain Blaze, Normal/Mystery types
 * -- each test then varies only the fields it is about. Exact copy of the
 * cycle4c7 fixture. */
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

/** Same state, DOUBLE cleared: the "in singles (battleTypeFlags without
 * DOUBLE)" control. `isDoubleBattle` is the only reader of this bit here. */
function asSinglesFlags(state: BattleState): BattleState {
  state.battleTypeFlags &= ~BATTLE_TYPE_DOUBLE
  return state
}

/** A scripted RandomSource that also counts draws, so the tests can assert the
 * exact C draw order rather than relying on seeds. */
function scripted(...values: number[]): { rng: RandomSource; draws: () => number } {
  let i = 0
  return { rng: { random16: () => values[i++] ?? 0 }, draws: () => i }
}

function deps(state: BattleState): AiDamageDeps {
  return aiDamageDepsFor(data, state)
}

const opponentParty = (state: BattleState): SimPartyMon[] => state.sides[1].party

function setSlot(party: SimPartyMon[], index: number, opts: { ability?: string | null; moves?: Slot4<string | null>; types?: [string, string, string] }): void {
  const mon = party[index]!
  mon.hp = mon.maxHp
  mon.moves = opts.moves ?? ['MOVE_TACKLE', null, null, null]
  mon.abilities = { ability: opts.ability ?? null, innates: [null, null, null] }
  if (opts.types) mon.types = opts.types
}

/** The fixture must leave both battlers' `monToSwitchIntoId` at the PARTY_SIZE
 * sentinel: the pre-set short-circuit at :971-972 would return before any of
 * the doubles logic below runs. */
function expectSentinels(state: BattleState): void {
  expect(state.battlers[3]!.monToSwitchIntoId).toBe(PARTY_SIZE)
  expect(state.battlers[1]!.monToSwitchIntoId).toBe(PARTY_SIZE)
}

const stubGetMostSuitable = () => ({ partyIndex: PARTY_SIZE, unmodelled: [] })

describe('aiTrySwitchOrUseItem: doubles fallback loop (:721-742)', () => {
  /** AI battler 3 from party slot 0, partner battler 1 from party slot 1, all
   * five real opponent slots alive at full HP (set here with `setSlot`, not left
   * to the trainer fixture; slot 5 is layoutRosters' empty pad). `aiSwitchMon`
   * forces ShouldSwitch's very first helper (ShouldSwitchIfAllBadMoves, :49-62)
   * to decide TRUE with a PARTY_SIZE target, and the stub returns PARTY_SIZE,
   * so the local fallback loop is the one that picks the slot. */
  function setup(): BattleState {
    const state = makeState(true, scripted().rng)
    normaliseBattlers(state)
    const party = opponentParty(state)
    for (let i = 0; i < 5; i++) setSlot(party, i, {})
    state.battlers[3]!.partyIndex = 0
    state.battlers[1]!.partyIndex = 1
    state.aiSwitchMon = true
    return state
  }

  it('excludes the partner\'s party slot in doubles; the singles control still sees it', () => {
    const doubles = setup()
    const result = aiTrySwitchOrUseItem(doubles, 3, deps(doubles), stubGetMostSuitable, 0, { kind: 'move', moveIndex: 0 }, null)
    // Doubles (:723-742): slots are AI=0, partner=1. i=0 ==
    // gBattlerPartyIndexes[battlerIn1] -> skip; i=1 ==
    // gBattlerPartyIndexes[battlerIn2] -> skip; i=2 is the first live slot
    // neither names, so monToSwitchId = 2.
    expect(result.switched).toBe(true)
    expect(doubles.battlers[3]!.aiMonToSwitchIntoId).toBe(2)
    expect(doubles.battlers[3]!.monToSwitchIntoId).toBe(2)

    // Singles control (:721-724): battlerIn2 = battlerIn1 = 3, so the partner
    // check does not exist. i=0 == the AI's own slot -> skip; i=1 -> 1.
    const single = asSinglesFlags(setup())
    aiTrySwitchOrUseItem(single, 3, deps(single), stubGetMostSuitable, 0, { kind: 'move', moveIndex: 0 }, null)
    expect(single.battlers[3]!.aiMonToSwitchIntoId).toBe(1)
    expect(single.battlers[3]!.monToSwitchIntoId).toBe(1)
  })

  it('excludes a slot the partner has already queued (monToSwitchIntoId); singles ignores it', () => {
    const doubles = setup()
    const party = opponentParty(doubles)
    // Every real slot is alive: 0 AI, 1 partner, 2/3/4 reserves; 5 is the
    // empty pad. hp was set by setSlot, not by the trainer fixture.
    expect(party.length).toBe(6)
    expect([0, 1, 2, 3, 4].every((i) => party[i]!.hp > 0)).toBe(true)
    doubles.battlers[1]!.monToSwitchIntoId = 2
    // Doubles: i=0 own slot -> skip; i=1 partner party slot -> skip;
    // i=2 == monToSwitchIntoId[battlerIn2] (:735-736) -> skip; i=3 -> picked.
    aiTrySwitchOrUseItem(doubles, 3, deps(doubles), stubGetMostSuitable, 0, { kind: 'move', moveIndex: 0 }, null)
    expect(doubles.battlers[3]!.aiMonToSwitchIntoId).toBe(3)
    expect(doubles.battlers[3]!.monToSwitchIntoId).toBe(3)

    // Singles control: battlerIn2 = battlerIn1, so the partner's queued slot is
    // never read. i=0 own slot -> skip; i=1 -> 1.
    const single = asSinglesFlags(setup())
    single.battlers[1]!.monToSwitchIntoId = 2
    aiTrySwitchOrUseItem(single, 3, deps(single), stubGetMostSuitable, 0, { kind: 'move', moveIndex: 0 }, null)
    expect(single.battlers[3]!.aiMonToSwitchIntoId).toBe(1)
    expect(single.battlers[3]!.monToSwitchIntoId).toBe(1)
  })

  it('does NOT relax the partner-slot exclusion when the partner is absent (no gAbsentBattlerFlags test here)', () => {
    const absent = setup()
    absent.absentBattlerFlags |= 1 << 1
    // :723-742 has no absent check: i=0 own slot -> skip; i=1 is still
    // gBattlerPartyIndexes[battlerIn2] -> skip; i=2 -> picked. If this site had
    // the collapse the other sites use, i=1 would have been chosen instead.
    aiTrySwitchOrUseItem(absent, 3, deps(absent), stubGetMostSuitable, 0, { kind: 'move', moveIndex: 0 }, null)
    expect(absent.battlers[3]!.aiMonToSwitchIntoId).toBe(2)
    expect(absent.battlers[3]!.monToSwitchIntoId).toBe(2)

    // Control: the same state WITHOUT the absent bit gives the same slot 2 --
    // the flag changes nothing at this site.
    const present = setup()
    aiTrySwitchOrUseItem(present, 3, deps(present), stubGetMostSuitable, 0, { kind: 'move', moveIndex: 0 }, null)
    expect(present.battlers[3]!.aiMonToSwitchIntoId).toBe(2)
  })
})

/** Base doubles state for the GetMostSuitableMonToSwitchInto tests: AI battler
 * 3 on party slot 0, partner battler 1 on party slot 1, all five real slots
 * alive at full HP (set here with `setSlot`). */
function doublesState(rng: RandomSource): BattleState {
  const state = makeState(true, rng)
  normaliseBattlers(state)
  const party = opponentParty(state)
  for (let i = 0; i < 5; i++) setSlot(party, i, {})
  state.battlers[3]!.partyIndex = 0
  state.battlers[1]!.partyIndex = 1
  return state
}

describe('getMostSuitableMonToSwitchInto: doubles partner exclusion (:1007-1021)', () => {
  /** Live slots 0 (AI), 1 (partner), 3 (the only real candidate); 2 and 4 are
   * dead, 5 is the empty pad. Slot 1 is made the objectively better offensive
   * pick (FIRE vs a Bug defender, with Ember) so the singles control provably
   * chooses it and the doubles exclusion is what changes the answer. */
  function partnerSlotState(rng: RandomSource): BattleState {
    const state = doublesState(rng)
    const party = opponentParty(state)
    setSlot(party, 1, { types: ['FIRE', 'FIRE', 'MYSTERY'], moves: ['MOVE_EMBER', null, null, null] })
    setSlot(party, 3, {})
    party[2]!.hp = 0
    party[4]!.hp = 0
    state.battlers[2]!.mon.types = ['BUG', 'BUG', 'MYSTERY']
    return state
  }

  it('skips the partner party slot in doubles; the same state in singles picks it', () => {
    const counter = scripted()
    const doubles = partnerSlotState(counter.rng)
    expectSentinels(doubles)
    // Offensive product (UQ_ONE = 1024, :904-918): slot 1 FIRE vs BUG =
    // 1024 * 2048 = 2097152; slot 3 NORMAL vs BUG = 1024. Doubles also makes
    // i == gBattlerPartyIndexes[battlerIn2] = 1 invalid (:1011), so slot 3 is
    // the only live candidate; its Tackle is not super-effective against Bug,
    // so Offensive returns PARTY_SIZE and Dmg picks slot 3.
    expect(getMostSuitableMonToSwitchInto(doubles, 3, deps(doubles)).partyIndex).toBe(3)
    expect(counter.draws()).toBe(0) // no Baton Pass in the fixture, no Truant/rejection draws

    const single = asSinglesFlags(partnerSlotState(scripted().rng))
    expectSentinels(single)
    // Singles (:996-1000): battlerIn2 = battlerIn1 = 3, so slot 1 is a plain
    // reserve. 2097152 > 1024 and Ember is 2x vs Bug -> Offensive returns 1.
    expect(getMostSuitableMonToSwitchInto(single, 3, deps(single)).partyIndex).toBe(1)
  })

  it('excludes a slot the partner has queued in monToSwitchIntoId; singles ignores it', () => {
    function queuedState(rng: RandomSource): BattleState {
      const state = doublesState(rng)
      const party = opponentParty(state)
      // Partner's own party slot is dead, so slot 3 is the only live reserve.
      party[1]!.hp = 0
      setSlot(party, 3, {})
      party[2]!.hp = 0
      party[4]!.hp = 0
      expect(state.battlers[3]!.monToSwitchIntoId).toBe(PARTY_SIZE)
      expect(state.battlers[1]!.monToSwitchIntoId).toBe(PARTY_SIZE)
      state.battlers[1]!.monToSwitchIntoId = 3
      return state
    }

    const doubles = queuedState(scripted().rng)
    // Doubles: slot 0 own partyIndex; slot 3 == monToSwitchIntoId[battlerIn2]
    // (:1015); slots 1/2/4 dead and 5 empty -> no candidate -> PARTY_SIZE.
    expect(getMostSuitableMonToSwitchInto(doubles, 3, deps(doubles)).partyIndex).toBe(PARTY_SIZE)

    // Control: without the partner's queued id, slot 3 is valid again -> Dmg.
    const notQueued = queuedState(scripted().rng)
    notQueued.battlers[1]!.monToSwitchIntoId = PARTY_SIZE
    expect(getMostSuitableMonToSwitchInto(notQueued, 3, deps(notQueued)).partyIndex).toBe(3)

    // Singles control: battlerIn2 = battlerIn1, so the partner's queued id is
    // never read; slot 3 (the only live reserve) is still eligible.
    const single = asSinglesFlags(queuedState(scripted().rng))
    expect(getMostSuitableMonToSwitchInto(single, 3, deps(single)).partyIndex).toBe(3)
  })

  it('an absent partner collapses battlerIn2 onto the AI (:988-991), so its party slot is eligible', () => {
    const present = partnerSlotState(scripted().rng)
    expectSentinels(present)
    // Present partner: slot 1 is invalid at :1011, leaving slot 3 -> 3.
    expect(getMostSuitableMonToSwitchInto(present, 3, deps(present)).partyIndex).toBe(3)

    const absent = partnerSlotState(scripted().rng)
    absent.absentBattlerFlags |= 1 << 1
    // battlerIn2 = gActiveBattler = 3, so slot 1 is a plain reserve.
    // FIRE 2097152 > NORMAL 1024 and Ember is 2x vs Bug -> Offensive returns 1.
    expect(getMostSuitableMonToSwitchInto(absent, 3, deps(absent)).partyIndex).toBe(1)
  })
})

describe('getMostSuitableMonToSwitchInto: the opposing battler flip (:993-995)', () => {
  /** Slots 3 (Fire/Ember) and 4 (Water/Surf) are the two candidates; slot 1 is
   * the partner's party slot (invalid in doubles), 2 is dead, 5 empty. Battler
   * 2 is Bug-typed and battler 0 Fire-typed, so the best candidate flips with
   * `opposingBattler`. */
  function flipState(rng: RandomSource): BattleState {
    const state = doublesState(rng)
    const party = opponentParty(state)
    setSlot(party, 3, { types: ['FIRE', 'FIRE', 'MYSTERY'], moves: ['MOVE_EMBER', null, null, null] })
    setSlot(party, 4, { types: ['WATER', 'WATER', 'MYSTERY'], moves: ['MOVE_SURF', null, null, null] })
    party[2]!.hp = 0
    state.battlers[2]!.mon.types = ['BUG', 'BUG', 'MYSTERY']
    state.battlers[0]!.mon.types = ['FIRE', 'FIRE', 'MYSTERY']
    return state
  }

  it('a set absent bit on BATTLE_OPPOSITE flips it with BIT_FLANK and changes the pick', () => {
    const present = flipState(scripted().rng)
    expectSentinels(present)
    // Opposing = BATTLE_OPPOSITE(3) = 2, Bug-typed. Offensive: slot 3 FIRE
    // 1024 * 2048 = 2097152 > slot 4 WATER 1024 * 1 = 1024, Ember 2x -> 3.
    expect(getMostSuitableMonToSwitchInto(present, 3, deps(present)).partyIndex).toBe(3)

    const flipped = flipState(scripted().rng)
    flipped.absentBattlerFlags |= 1 << 2
    // :993-995: 2 is absent, so opposingBattler = 2 ^ BIT_FLANK = 0, Fire-typed.
    // Now slot 4 WATER 2097152 > slot 3 FIRE 524288, Surf 2x -> 4.
    expect(getMostSuitableMonToSwitchInto(flipped, 3, deps(flipped)).partyIndex).toBe(4)
  })

  it('the Truant exclusion follows the flipped opposing battler (:1020)', () => {
    function truantState(rng: RandomSource): BattleState {
      const state = doublesState(rng)
      const party = opponentParty(state)
      setSlot(party, 3, { ability: 'ABILITY_TRUANT', types: ['FIRE', 'FIRE', 'MYSTERY'], moves: ['MOVE_EMBER', null, null, null] })
      setSlot(party, 4, {}) // neutral fallback
      party[2]!.hp = 0
      state.battlers[2]!.mon.types = ['BUG', 'BUG', 'MYSTERY'] // no Protect (Tackle)
      state.battlers[0]!.mon.types = ['BUG', 'BUG', 'MYSTERY']
      state.battlers[0]!.mon.moves = ['MOVE_PROTECT', null, null, null]
      return state
    }

    const present = truantState(scripted().rng)
    expectSentinels(present)
    // Opposing = 2, which has no Protect, so IsTruantMonVulnerable is false and
    // Truant slot 3 stays valid: FIRE 2097152 > NORMAL 1024, Ember 2x -> 3.
    expect(getMostSuitableMonToSwitchInto(present, 3, deps(present)).partyIndex).toBe(3)

    const flipped = truantState(scripted().rng)
    flipped.absentBattlerFlags |= 1 << 2
    // Opposing flips to 0 (:993-995), whose MOVE_PROTECT makes
    // IsTruantMonVulnerable true (:587-596), so slot 3 is invalid at :1020;
    // slot 4 is the only candidate -> Offensive finds no super-effective move,
    // Dmg picks it.
    expect(getMostSuitableMonToSwitchInto(flipped, 3, deps(flipped)).partyIndex).toBe(4)
  })
})

describe('getMostSuitableMonToSwitchInto: the multi-format throw', () => {
  it('DOUBLE alone no longer throws; TWO_OPPONENTS still does', () => {
    const state = doublesState(scripted().rng)
    expect(() => getMostSuitableMonToSwitchInto(state, 3, deps(state))).not.toThrow()
    state.battleTypeFlags |= BATTLE_TYPE_TWO_OPPONENTS
    expect(() => getMostSuitableMonToSwitchInto(state, 3, deps(state))).toThrow(/two-opponent/)
  })
})
