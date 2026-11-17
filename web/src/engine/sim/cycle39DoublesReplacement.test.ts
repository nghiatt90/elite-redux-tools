/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 39 (dbl-2b): the doubles replacement flow, absent battlers and the outcome
// slot-range rule. Singles must stay bit-identical.
//
//   (A) applyEndOfTurnReplacements prompts battlers 0, 2, 1, 3 in a double
//       (Cmd_openpartyscreen, src/battle_script_commands.c:5226-5319, and the second
//       prompt for a side whose both battlers fainted at :5321-5350); singles keeps 0, 1.
//   (B) playerReplacement takes the fainting battler id, and firstLiveReplacement reads
//       that battler's own slot range.
//   (C) HasNoMonsToSwitch (src/battle_util.c:3607-3704) and the absent marking
//       `gAbsentBattlerFlags |= gBitTable[gActiveBattler]` (:5234).
//   (D) NoAliveMonsForPlayer's MULTI_PARTY_SIZE branch (battle_script_commands.c:3690-3694).
//   (E) assertRosterHoldsActiveBattlers checks slot ranges and duplicate partyIndexes.

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  BATTLE_TYPE_DOUBLE,
  BATTLE_TYPE_INGAME_PARTNER,
  BATTLE_TYPE_MULTI,
  BATTLE_TYPE_TRAINER,
  BATTLE_TYPE_TWO_OPPONENTS,
  PARTY_SIZE,
} from './constants'
import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState, toBattleMon } from './driver/battleFormat'
import { cloneSession, createSession, firstLiveReplacement, groundingFor, type BattleSession } from './driver/session'
import { hasNoMonsToSwitch, partySlotsFor } from './partySlots'
import { applyEndOfTurnReplacements, hasLiveReserve, type ReplacementDeps } from './switchIn'
import type { HazardDeps } from './hazards'
import { isBattlerAlive } from './turn'
import { computeBattleOutcome, syncPartyHp } from './outcome'
import { createRandomSource } from './rng'
import type { BattleState, SimPartyMon } from './state'

const data = loadSimData()

const SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_STONE_EDGE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_METEOR_MASH'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_EARTHQUAKE'] },
]

const trainer = data.trainersById.get('TRAINER_SAWYER_1')!
const secondTrainer = data.trainersById.get('TRAINER_ROXANNE_1')!
const partnerTrainer = data.trainersById.get('TRAINER_STEVEN_MOSSDEEP')!

/** `count` plain party entries -- only `speciesId` and `hp` matter to the roster scans
 * (and to HasNoMonsToSwitch's own SPECIES_NONE/HP tests). */
function party(count: number): SimPartyMon[] {
  return buildPlayerParty(
    Array.from({ length: count }, () => ({ species: 'SPECIES_MUDKIP', moves: [] as string[] })),
    50,
    data,
  )
}

function slotMon(kind: 'valid' | 'dead'): SimPartyMon {
  const base = party(1)[0]!
  return { ...base, hp: kind === 'valid' ? 20 : 0 }
}

const roster = (...kinds: Array<'valid' | 'dead'>): SimPartyMon[] => kinds.map(slotMon)

function opponentParty(): SimPartyMon[] {
  return buildOpponentParty(trainer, 'elite', 50, data)
}

/** A faint writes BOTH the battler's HP and its own party slot (outcome.ts's
 * syncPartyHp), because every roster scan reads the party. */
function faint(state: BattleState, battlerId: number): void {
  state.battlers[battlerId]!.mon.hp = 0
  syncPartyHp(state, battlerId)
}

function hazardDeps(state: BattleState): HazardDeps {
  return { dataContext: data.dataContext, grounding: groundingFor(data, state) }
}

function doubleState(player: SimPartyMon[], opponent = opponentParty()): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    { data, tier: 'elite', playerParty: player, opponentParties: [opponent], rng: createRandomSource(1) },
  )
}

function singlesState(player: SimPartyMon[]): BattleState {
  return buildBattleState(
    { opponents: [trainer] },
    { data, tier: 'elite', playerParty: player, opponentParties: [opponentParty()], rng: createRandomSource(1) },
  )
}

function twoOpponentState(opponentA: SimPartyMon[], opponentB: SimPartyMon[], player: SimPartyMon[]): BattleState {
  return buildBattleState(
    { opponents: [trainer, secondTrainer] },
    { data, tier: 'elite', playerParty: player, opponentParties: [opponentA, opponentB], rng: createRandomSource(1) },
  )
}

function partnerState(player = party(3), partner = buildOpponentParty(partnerTrainer, 'ace', 50, data)): BattleState {
  return buildBattleState(
    { opponents: [secondTrainer, trainer], partner: partnerTrainer },
    {
      data,
      tier: 'elite',
      playerParty: player,
      opponentParties: [buildOpponentParty(secondTrainer, 'elite', 50, data), opponentParty()],
      partnerParty: partner,
      rng: createRandomSource(1),
    },
  )
}

/** A session around an arbitrary state, so `turnDeps.replacement` is the buildDeps
 * closure that threads `playerReplacement` -- the thing item B changes. */
function sessionWith(state: BattleState, playerReplacement: (state: BattleState, battlerId: number) => number): BattleSession {
  const base = createSession({
    data,
    playerParty: buildPlayerParty(SPECS, 50, data),
    opponentTrainer: trainer,
    rng: createRandomSource(1),
    playerReplacement,
  })
  base.state = state
  return cloneSession(base, 3)
}

/** Records every battler `chooseReplacement` is asked about. */
function spyDeps(choose: (state: BattleState, battlerId: number) => number): ReplacementDeps & { calls: number[] } {
  const calls: number[] = []
  return {
    calls,
    chooseReplacement(state, battlerId) {
      calls.push(battlerId)
      return choose(state, battlerId)
    },
  }
}

const noReplacement: (state: BattleState, battlerId: number) => number = () => {
  throw new Error('chooseReplacement must not be called here')
}

describe('(A) replacement order is 0, 2, 1, 3 in a double (battle_script_commands.c:5226-5350)', () => {
  it('four fainted battlers are replaced left-side-left, right-side-left, ...', () => {
    // C: the BS_FAINTED_LINK_MULTIPLE_1 branch prompts 0 (:5231), then 2 (:5247), then
    // 1 (:5262), then 3 (:5278). When BOTH of a side's battlers fainted, that side's
    // second prompt comes from BS_FAINTED_LINK_MULTIPLE_2 (:5321-5350): 2 if 0 fainted
    // too, then 3 if 1 fainted too -- the same 0-before-2 order, so one pass over
    // [0, 2, 1, 3] models both branches.
    const state = doubleState(party(4))
    expect(state.battlers.map((b) => b?.partyIndex)).toEqual([0, 0, 1, 1])
    for (let id = 0; id < 4; id++) faint(state, id)
    // Both sides still have a live reserve at slots 2 and 3.
    expect(state.sides[0].party[2]!.hp).toBeGreaterThan(0)
    expect(state.sides[1].party[2]!.hp).toBeGreaterThan(0)

    const deps = spyDeps((s, battlerId) => firstLiveReplacement(s, battlerId))
    applyEndOfTurnReplacements(state, deps, hazardDeps(state), [])

    expect(deps.calls).toEqual([0, 2, 1, 3])
  })

  it('singles keeps [0, 1]', () => {
    const state = singlesState(party(2))
    faint(state, 0)
    faint(state, 1)
    expect(state.sides[0].party[1]!.hp).toBeGreaterThan(0)
    expect(state.sides[1].party[1]!.hp).toBeGreaterThan(0)

    const deps = spyDeps((s, battlerId) => firstLiveReplacement(s, battlerId))
    applyEndOfTurnReplacements(state, deps, hazardDeps(state), [])

    expect(deps.calls).toEqual([0, 1])
  })
})

describe('(B) playerReplacement receives the fainting battler id', () => {
  it('a doubles battler 2 faint passes battlerId 2 through buildDeps', () => {
    const state = doubleState(party(4))
    faint(state, 2)

    const seen: number[] = []
    const session = sessionWith(state, (s, battlerId) => {
      seen.push(battlerId)
      return firstLiveReplacement(s, battlerId)
    })
    applyEndOfTurnReplacements(state, session.turnDeps.replacement!, hazardDeps(state), [])

    expect(seen).toEqual([2])
    // Battler 2 started at slot 1, next to battler 0's slot 0; with both active, the
    // first live reserve in the plain-double range [0, PARTY_SIZE) is slot 2.
    expect(state.battlers[2]!.partyIndex).toBe(2)
    expect(state.battlers[2]!.mon.hp).toBeGreaterThan(0)
  })

  it('firstLiveReplacement reads the given battler\'s own slot range (battle_util.c:3629-3641)', () => {
    const state = partnerState()
    expect(partySlotsFor(state, 0)).toEqual([0, 3])
    expect(partySlotsFor(state, 2)).toEqual([3, 6])

    // Battlers 0 and 2 start at slots 0 and 3, so battler 2's first reserve is 4.
    const ownHalf = firstLiveReplacement(state, 0)
    const partnerHalf = firstLiveReplacement(state, 2)
    expect(ownHalf).toBeGreaterThanOrEqual(0)
    expect(ownHalf).toBeLessThan(3)
    expect(partnerHalf).toBeGreaterThanOrEqual(3)
    expect(partnerHalf).toBeLessThan(6)
    // Negative: the old one-argument form always answered for battler 0.
    expect(firstLiveReplacement(state)).toBe(ownHalf)
    expect(partnerHalf).not.toBe(ownHalf)
  })
})

describe('(C) HasNoMonsToSwitch and absent marking (battle_util.c:3607-3704)', () => {
  it('(a) a plain double with only the two active player mons marks battler 2 absent', () => {
    // branch 4, :3686-3704: a slot is a reserve only if it is neither active battler's
    // party slot. Slots 2-5 are SPECIES_NONE here, so 0 and 1 are all the party has.
    const state = doubleState(party(2))
    expect(state.sides[0].party).toHaveLength(PARTY_SIZE)
    expect(state.sides[0].party[2]!.speciesId).toBeNull()
    faint(state, 2)

    expect(hasNoMonsToSwitch(state, 2)).toBe(true)
    const deps = spyDeps(noReplacement)
    applyEndOfTurnReplacements(state, deps, hazardDeps(state), [])
    expect(deps.calls).toEqual([])

    // :5234 -- gAbsentBattlerFlags |= gBitTable[gActiveBattler].
    expect(state.absentBattlerFlags & (1 << 2)).toBe(1 << 2)
    // The absent battler keeps hp 0, so an `hp == 0` target scan skips it
    // (battle_ai_main.c:354), and isBattlerAlive reads the flag (turn.ts:336).
    expect(state.battlers[2]!.mon.hp).toBe(0)
    expect(isBattlerAlive(state, 2)).toBe(false)
    // Battler 0 is untouched.
    expect(state.battlers[0]!.mon.hp).toBeGreaterThan(0)
    expect(isBattlerAlive(state, 0)).toBe(true)
  })

  it('(b) a third live player mon is a reserve, so battler 2 is replaced and stays present', () => {
    const state = doubleState(party(3))
    faint(state, 2)
    expect(hasNoMonsToSwitch(state, 2)).toBe(false)

    const deps = spyDeps((s, battlerId) => firstLiveReplacement(s, battlerId))
    applyEndOfTurnReplacements(state, deps, hazardDeps(state), [])

    expect(deps.calls).toEqual([2])
    expect(state.battlers[2]!.partyIndex).toBe(2)
    expect(state.battlers[2]!.mon.hp).toBeGreaterThan(0)
    expect(state.absentBattlerFlags).toBe(0)
    // Never battler 0's active slot.
    expect(state.battlers[2]!.partyIndex).not.toBe(state.battlers[0]!.partyIndex)
  })

  it('(c) TWO_OPPONENTS: trainer B has nothing left and does not take trainer A\'s mon', () => {
    // :3672-3685 -- battler 3 scans [3,6) (trainer B) and battler 1 scans [0,3).
    const rosterB = party(3).map((mon) => ({ ...mon, hp: 0 }))
    const state = twoOpponentState(party(3), rosterB, party(2))
    // battler 3 starts at slot 3 (battle_controllers.c:672-673) with hp 0.
    expect(state.battlers[3]!.partyIndex).toBe(3)
    expect(state.battlers[3]!.mon.hp).toBe(0)
    expect(state.sides[1].party[3]!.hp).toBe(0)

    expect(hasNoMonsToSwitch(state, 3)).toBe(true)
    // Negative: trainer A's half is alive, so battler 1 has a reserve.
    expect(hasNoMonsToSwitch(state, 1)).toBe(false)

    const deps = spyDeps(noReplacement)
    applyEndOfTurnReplacements(state, deps, hazardDeps(state), [])
    expect(deps.calls).toEqual([])

    expect(state.absentBattlerFlags & (1 << 3)).toBe(1 << 3)
    expect(state.battlers[3]!.mon.hp).toBe(0)
    expect(state.battlers[3]!.partyIndex).toBe(3)
  })

  it('(d) INGAME_PARTNER: the partner flank rule, not the whole six-slot party', () => {
    // :3629-3641 -- battler 2 (flank 1) scans [3,6) only.
    const state = partnerState()
    expect(state.battlers.map((b) => b?.partyIndex)).toEqual([0, 0, 3, 3])
    faint(state, 2) // battler 2's own slot 3
    state.sides[0].party[4]!.hp = 0
    state.sides[0].party[5]!.hp = 0

    expect(hasNoMonsToSwitch(state, 2)).toBe(true)
    // Negative: the player's own half still has a live reserve, which the flank rule
    // must NOT offer to battler 2.
    expect(hasLiveReserve(state, 0)).toBe(true)
    expect(hasNoMonsToSwitch(state, 0)).toBe(false)

    const deps = spyDeps(noReplacement)
    applyEndOfTurnReplacements(state, deps, hazardDeps(state), [])
    expect(deps.calls).toEqual([])

    expect(state.absentBattlerFlags & (1 << 2)).toBe(1 << 2)
    expect(state.battlers[2]!.mon.hp).toBe(0)
    expect(hasLiveReserve(state, 2)).toBe(false)
  })

  it('(e) singles never marks anyone absent (:3611)', () => {
    const state = singlesState(party(2))
    faint(state, 0)

    const deps = spyDeps((s, battlerId) => firstLiveReplacement(s, battlerId))
    applyEndOfTurnReplacements(state, deps, hazardDeps(state), [])

    expect(deps.calls).toEqual([0])
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.absentBattlerFlags).toBe(0)
  })
})

describe('(D) NoAliveMonsForPlayer slot range (battle_script_commands.c:3690-3694)', () => {
  it('an INGAME_PARTNER player loses when its own three mons are down, partner alive', () => {
    const state = partnerState()
    for (let i = 0; i < 3; i++) state.sides[0].party[i]!.hp = 0
    expect(state.sides[0].party[3]!.hp).toBeGreaterThan(0)
    expect(state.sides[1].party[0]!.hp).toBeGreaterThan(0)

    expect(computeBattleOutcome(state)).toBe('LOST')
    // Negative: the same party without the flag sums all six slots and finds the
    // partner's live mons.
    const withoutFlag = partnerState()
    for (let i = 0; i < 3; i++) withoutFlag.sides[0].party[i]!.hp = 0
    withoutFlag.battleTypeFlags &= ~BATTLE_TYPE_INGAME_PARTNER
    expect(computeBattleOutcome(withoutFlag)).toBeNull()
  })

  it('NoAliveMonsForOpponent always sums all six slots (:3707-3719)', () => {
    const state = twoOpponentState(party(3), party(3), party(2))
    for (let i = 0; i < 3; i++) state.sides[1].party[i]!.hp = 0
    expect(state.sides[1].party[3]!.hp).toBeGreaterThan(0)
    expect(computeBattleOutcome(state)).toBeNull()

    // Negative: once trainer B's half is down too, the opponent has lost.
    for (let i = 3; i < 6; i++) state.sides[1].party[i]!.hp = 0
    expect(computeBattleOutcome(state)).toBe('WON')
  })

  it('singles is unchanged', () => {
    const state = singlesState(party(2))
    state.sides[0].party[0]!.hp = 0
    expect(computeBattleOutcome(state)).toBeNull()
    state.sides[0].party[1]!.hp = 0
    expect(computeBattleOutcome(state)).toBe('LOST')
  })
})

describe('(E) the roster assertion covers the 4-battler layouts', () => {
  const partnerFlags = BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER

  it('rejects two battlers of one side sharing a partyIndex', () => {
    const player = roster('valid', 'valid', 'valid', 'valid', 'valid', 'valid')
    // The array position IS the battler id (state.battlers[id]), so battler 2 sits at
    // index 2 with index 1 left empty.
    const battlers = [
      createBattlerState(0, toBattleMon(player[0]!), 0),
      null,
      createBattlerState(2, toBattleMon(player[1]!), 0),
      null,
    ]
    expect(() =>
      createBattleState({
        battlers,
        playerParty: player,
        battleTypeFlags: BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE,
        rng: createRandomSource(1),
      }),
    ).toThrow(/side 0: battler 2 has partyIndex 0, already held by another active battler/)
    // Negative: without the format the checks cannot run -- the pre-dbl-2b behaviour.
    expect(() =>
      createBattleState({ battlers, playerParty: player, rng: createRandomSource(1) }),
    ).not.toThrow()
  })

  it('rejects a partner-side battler outside [3, 6) (battle_util.c:3629-3641)', () => {
    const player = roster('valid', 'valid', 'valid', 'valid', 'valid', 'valid')
    const battlers = [
      createBattlerState(0, toBattleMon(player[0]!), 0),
      null,
      createBattlerState(2, toBattleMon(player[1]!), 1),
      null,
    ]
    expect(() =>
      createBattleState({ battlers, playerParty: player, battleTypeFlags: partnerFlags, rng: createRandomSource(1) }),
    ).toThrow(/side 0: battler 2 has partyIndex 1, outside its \[3, 6\) slot range/)
  })

  it('accepts the real partner layout: battlers 0/1 -> 0 and 2/3 -> 3', () => {
    // battle_controllers.c:160-171 -- the two controllers on each side start from slot
    // 0 and slot 3. Both sides use the same layout; only a SAME-side duplicate is wrong.
    const player = roster('valid', 'valid', 'valid', 'valid', 'valid', 'valid')
    const opponent = roster('valid', 'valid', 'valid', 'valid', 'valid', 'valid')
    const battlers = [
      createBattlerState(0, toBattleMon(player[0]!), 0),
      createBattlerState(1, toBattleMon(opponent[0]!), 0),
      createBattlerState(2, toBattleMon(player[3]!), 3),
      createBattlerState(3, toBattleMon(opponent[3]!), 3),
    ]
    const state = createBattleState({
      battlers,
      playerParty: player,
      opponentParty: opponent,
      battleTypeFlags: partnerFlags,
      rng: createRandomSource(1),
    })
    expect(state.battlersCount).toBe(4)
    expect(state.battlers.map((b) => b?.partyIndex)).toEqual([0, 0, 3, 3])
  })
})
