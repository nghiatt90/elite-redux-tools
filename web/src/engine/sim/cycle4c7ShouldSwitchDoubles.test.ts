/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 4c7 (dbl-4c7, first slice): the BATTLE_TYPE_DOUBLE branches of
// web/src/engine/sim/ai/aiShouldSwitch.ts.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/battle_ai_switch_items.c):
//   isInvalidReserveSlot duplicate checks, FindMonThatAbsorbsOpponentsMove
//       battlerIn1/battlerIn2 choice :166-177, reserve skip :238-244
//   isInvalidReserveSlot duplicate checks, FindMonWithFlagsAndSuperEffective
//       battlerIn1/battlerIn2 choice :432-443, reserve skip :465-471
//   isInvalidReserveSlot duplicate checks, ShouldSwitch's availableToSwitch
//       battlerIn1/battlerIn2 choice :629-640, reserve skip :658-664
//   HasSuperEffectiveMoveAgainstOpponents first-foe/partner-foe loops :320-373
//   ShouldSwitchIfWonderGuard doubles early return                    :89-90
//
// GetBattlerAtPosition is the identity for a non-multi battle
// (battle_anim_mons.c:677-684 -- it returns the index whose gBattlerPositions
// entry equals the requested position, and the sim's battler ids ARE the
// positions: 0/2 player, 1/3 opponent). BATTLE_OPPOSITE is `id ^ 1` and
// BATTLE_PARTNER is `id ^ 2` (include/constants/battle.h:36-37); BIT_FLANK is
// 2 (:46), so ShouldSwitch's `GetBattlerPosition(b) ^ BIT_FLANK` names the same
// battler as the other two sites' BATTLE_PARTNER call.
//
// LAYOUT (same as cycle4c3/4c4/4c5/4c6): doubles, battlers 0/2 player side,
// 1/3 opponent side. The AI is battler 3 and its ally is battler 1; the AI's
// BATTLE_OPPOSITE is battler 2, and BATTLE_PARTNER(2) is battler 0 -- i.e. for
// gActiveBattler 3 the FIRST foe loop targets battler 2 and the partner-foe
// loop targets battler 0. `asSinglesFlags` clears BATTLE_TYPE_DOUBLE in the
// same state (the brief's "battleTypeFlags without DOUBLE"), so a test can
// change only the one condition under test.

import { describe, expect, it } from 'vitest'

import { loadSimData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { buildBattleState } from './driver/battleFormat'
import { aiDamageDepsFor } from './driver/session'
import type { BattleState, RandomSource, SimPartyMon, Slot4 } from './state'
import { BATTLE_TYPE_DOUBLE, PARTY_SIZE, STATUS3_PERISH_SONG } from './constants'
import type { AiDamageDeps } from './ai/aiCalcDamage'
import { hasSuperEffectiveMoveAgainstOpponents, shouldSwitch } from './ai/aiShouldSwitch'

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
 * cycle4c6 fixture. */
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

/** Same state, DOUBLE cleared: the brief's "in singles (battleTypeFlags without
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

function killSlotsFrom(party: SimPartyMon[], from: number): void {
  for (let i = from; i < party.length; i++) party[i]!.hp = 0
}

describe('hasSuperEffectiveMoveAgainstOpponents: doubles partner-foe loop (:320-373)', () => {
  /** AI = battler 3. BATTLE_OPPOSITE(3) = 2 is the first foe; BATTLE_PARTNER(2)
   * = 0 is the partner foe. Thunderbolt is 2x vs WATER and 0.5x vs GRASS
   * (data/v2.65beta/types.json), so a Water partner foe and a Grass first foe
   * make the move super-effective ONLY against the partner foe. */
  function thunderboltState(rng: RandomSource): BattleState {
    const state = makeState(true, rng)
    normaliseBattlers(state)
    state.battlers[2]!.mon.types = ['GRASS', 'MYSTERY', 'MYSTERY']
    state.battlers[0]!.mon.types = ['WATER', 'MYSTERY', 'MYSTERY']
    state.battlers[3]!.mon.moves = ['MOVE_THUNDERBOLT', null, null, null]
    return state
  }

  it('noRng=true finds a super-effective move against the partner foe only', () => {
    const state = thunderboltState(scripted().rng)
    // First foe (battler 2, GRASS): Thunderbolt is 0.5x, not >= 2. Partner foe
    // (battler 0, WATER): 2x -> the :350-368 loop returns TRUE.
    expect(hasSuperEffectiveMoveAgainstOpponents(state, 3, true, deps(state)).result).toBe(true)
  })

  it('noRng=true returns FALSE when the partner foe is in absentBattlerFlags (:352)', () => {
    const state = thunderboltState(scripted().rng)
    state.absentBattlerFlags |= 1 << 0 // BATTLE_PARTNER(2)
    expect(hasSuperEffectiveMoveAgainstOpponents(state, 3, true, deps(state)).result).toBe(false)
  })

  it('without BATTLE_TYPE_DOUBLE returns FALSE at :347-348 before the partner loop', () => {
    const state = asSinglesFlags(thunderboltState(scripted().rng))
    expect(hasSuperEffectiveMoveAgainstOpponents(state, 3, true, deps(state)).result).toBe(false)
  })

  it('noRng=false draws Random() % 10 in C order: first foe\'s move slots, then the partner foe\'s', () => {
    // First foe (battler 2) is FIRE: Ground (Earthquake) is 2x, Thunderbolt 1x.
    // Partner foe (battler 0) is WATER: Ground 1x, Thunderbolt 2x.
    const counter = scripted(0, 5)
    const state = makeState(true, counter.rng)
    normaliseBattlers(state)
    state.battlers[2]!.mon.types = ['FIRE', 'MYSTERY', 'MYSTERY']
    state.battlers[0]!.mon.types = ['WATER', 'MYSTERY', 'MYSTERY']
    state.battlers[3]!.mon.moves = ['MOVE_EARTHQUAKE', 'MOVE_THUNDERBOLT', null, null]
    // Draw 1: Earthquake vs battler 2 (FIRE) is 2x -> 0 % 10 == 0 misses and
    // the move loop keeps scanning. Draw 2: Thunderbolt vs battler 0 (WATER)
    // is 2x -> 5 % 10 != 0 hits. Exactly two draws.
    expect(hasSuperEffectiveMoveAgainstOpponents(state, 3, false, deps(state)).result).toBe(true)
    expect(counter.draws()).toBe(2)
  })

  it('first foe absent: its whole loop is skipped, so only the partner foe draws (:330, :352)', () => {
    // First foe (battler 2) and partner foe (battler 0) are both GRASS-weak to
    // Fire; three Fire moves make each present loop draw twice and once.
    function fireState(rng: RandomSource): BattleState {
      const state = makeState(true, rng)
      normaliseBattlers(state)
      state.battlers[2]!.mon.types = ['GRASS', 'MYSTERY', 'MYSTERY']
      state.battlers[0]!.mon.types = ['WATER', 'MYSTERY', 'MYSTERY']
      state.battlers[3]!.mon.moves = ['MOVE_EMBER', 'MOVE_FLAMETHROWER', 'MOVE_THUNDERBOLT', null]
      return state
    }
    // Present: Ember and Flamethrower are both 2x vs the Grass first foe (two
    // draws, both 0 -> miss), then Thunderbolt is 2x vs the Water partner foe
    // (draw 5 -> hit). C order means 3 draws.
    const presentCounter = scripted(0, 0, 5)
    const present = fireState(presentCounter.rng)
    expect(hasSuperEffectiveMoveAgainstOpponents(present, 3, false, deps(present)).result).toBe(true)
    expect(presentCounter.draws()).toBe(3)
    // First foe absent: its loop never runs, so the Water partner foe's
    // Thunderbolt is the FIRST draw and 5 hits. One draw, still TRUE.
    const absentCounter = scripted(5)
    const absent = fireState(absentCounter.rng)
    absent.absentBattlerFlags |= 1 << 2 // BATTLE_OPPOSITE(3)
    expect(hasSuperEffectiveMoveAgainstOpponents(absent, 3, false, deps(absent)).result).toBe(true)
    expect(absentCounter.draws()).toBe(1)
  })
})

describe('isInvalidReserveSlot: partner duplicate checks (:166-177/:238-244, :432-443/:465-471, :629-640/:658-664)', () => {
  it('availableToSwitch does not count the partner battler\'s partyIndex slot in doubles', () => {
    // Battler 3 (AI) started from party slot 1, battler 1 (partner) from slot 0
    // (startingPartyIndexes, battleFormat.ts). Kill slots 2-5: the only other
    // live slot is the partner's own. Perish Song (:64-77) is the switch
    // trigger, so the result flips exactly when a reserve is counted.
    function setup(): BattleState {
      const state = makeState(true, scripted().rng)
      normaliseBattlers(state)
      killSlotsFrom(opponentParty(state), 2)
      state.battlers[3]!.statuses3 = STATUS3_PERISH_SONG
      state.battlers[3]!.volatiles.perishSongTimer = 0
      return state
    }
    // Doubles: slot 0 is gBattlerPartyIndexes[battlerIn2] (:660), slot 1 is
    // gBattlerPartyIndexes[battlerIn1] (:658) -> availableToSwitch === 0 -> FALSE.
    const doubles = setup()
    expect(shouldSwitch(doubles, 3, deps(doubles)).shouldSwitch).toBe(false)
    // Partner absent: battlerIn2 collapses onto battlerIn1 (:632-635), slot 0 is
    // a plain reserve -> the count is 1 and Perish Song decides.
    const partnerAbsent = setup()
    partnerAbsent.absentBattlerFlags |= 1 << 1
    expect(shouldSwitch(partnerAbsent, 3, deps(partnerAbsent)).shouldSwitch).toBe(true)
    // Singles flags: same state, no partner check at all -> slot 0 counts.
    const single = asSinglesFlags(setup())
    expect(shouldSwitch(single, 3, deps(single)).shouldSwitch).toBe(true)
  })

  it('availableToSwitch does not count a slot named by the partner battler\'s monToSwitchIntoId', () => {
    // Slot 2 is the only live reserve; battler 1 (partner) has it queued at
    // monToSwitchIntoId, which the C skips at :664 in doubles.
    function setup(): BattleState {
      const state = makeState(true, scripted().rng)
      normaliseBattlers(state)
      const party = opponentParty(state)
      for (let i = 0; i < party.length; i++) party[i]!.hp = 0
      setSlot(party, 2, {})
      state.battlers[1]!.monToSwitchIntoId = 2
      state.battlers[3]!.statuses3 = STATUS3_PERISH_SONG
      state.battlers[3]!.volatiles.perishSongTimer = 0
      return state
    }
    const excluded = setup()
    // availableToSwitch === 0 (slot 2 is monToSwitchIntoId[battlerIn2]) -> FALSE.
    expect(shouldSwitch(excluded, 3, deps(excluded)).shouldSwitch).toBe(false)
    const notQueued = setup()
    notQueued.battlers[1]!.monToSwitchIntoId = PARTY_SIZE
    // Nothing excludes slot 2 now -> count 1 -> Perish Song decides.
    expect(shouldSwitch(notQueued, 3, deps(notQueued)).shouldSwitch).toBe(true)
  })

  it('FindMonThatAbsorbsOpponentsMove skips the partner\'s partyIndex slot in doubles', () => {
    // A Fire move landed on the AI; the only Flash Fire mon is the partner's
    // own party slot 0. With no super-effective move of its own the AI's
    // HasSuperEffectiveMoveAgainstOpponents(TRUE) guard (:157) draws nothing.
    function setup(): BattleState {
      const state = makeState(true, scripted(1).rng)
      normaliseBattlers(state)
      state.battlers[3]!.mon.moves = ['MOVE_TACKLE', null, null, null]
      state.battlers[3]!.lastLandedMove = 'MOVE_EMBER'
      setSlot(opponentParty(state), 0, { ability: 'ABILITY_FLASH_FIRE', types: ['NORMAL', 'MYSTERY', 'MYSTERY'] })
      setSlot(opponentParty(state), 1, { ability: null })
      killSlotsFrom(opponentParty(state), 2)
      return state
    }
    const doubles = setup()
    // Slot 0 is gBattlerPartyIndexes[battlerIn2] (:240) and slot 1 is
    // gBattlerPartyIndexes[battlerIn1] (:238) -> no absorber -> FALSE.
    expect(shouldSwitch(doubles, 3, deps(doubles)).shouldSwitch).toBe(false)
    // Partner absent -> battlerIn2 === battlerIn1 (:170-174), slot 0 is a real
    // reserve; its Flash Fire match draws Random() & 1 == 1 (:253) -> switch.
    const partnerAbsent = setup()
    partnerAbsent.absentBattlerFlags |= 1 << 1
    expect(shouldSwitch(partnerAbsent, 3, deps(partnerAbsent)).shouldSwitch).toBe(true)
    expect(partnerAbsent.battlers[3]!.aiMonToSwitchIntoId).toBe(0)
    // Singles flags: no battlerIn2 check at all; slot 0 is found too.
    const single = asSinglesFlags(setup())
    expect(shouldSwitch(single, 3, deps(single)).shouldSwitch).toBe(true)
    expect(single.battlers[3]!.aiMonToSwitchIntoId).toBe(0)
  })

  it('FindMonWithFlagsAndSuperEffective skips the partner\'s partyIndex slot in doubles', () => {
    // Ember (Fire) landed on the AI; the only reserve whose own typing is
    // NOT_VERY_EFFECTIVE against it is the partner's slot 0 (WATER: 0.5x),
    // and that mon knows Absorb, 2x against the battler named by gLastHitBy.
    function setup(): BattleState {
      const state = makeState(true, scripted(0).rng)
      normaliseBattlers(state)
      state.battlers[3]!.mon.moves = ['MOVE_TACKLE', null, null, null]
      state.battlers[3]!.lastLandedMove = 'MOVE_EMBER'
      state.battlers[3]!.lastHitBy = 2
      state.battlers[2]!.mon.types = ['WATER', 'MYSTERY', 'MYSTERY']
      setSlot(opponentParty(state), 0, { ability: null, moves: ['MOVE_ABSORB', null, null, null], types: ['WATER', 'MYSTERY', 'MYSTERY'] })
      setSlot(opponentParty(state), 1, { ability: null })
      killSlotsFrom(opponentParty(state), 2)
      return state
    }
    const doubles = setup()
    // Slot 0 skipped at :471 -> neither final flag search (:692-693) can
    // find the only candidate -> FALSE, and nothing drew RNG.
    const doublesResult = shouldSwitch(doubles, 3, deps(doubles))
    expect(doublesResult.shouldSwitch).toBe(false)
    // Partner absent -> slot 0 is scanned; its 0.5x Fire matchup is
    // NOT_VERY_EFFECTIVE, so the second search (:693, moduloPercent 3) reaches
    // AI_GetTypeEffectiveness for Absorb (2x vs Water) and Random() % 3 == 0
    // decides (:490).
    const partnerAbsent = setup()
    partnerAbsent.absentBattlerFlags |= 1 << 1
    expect(shouldSwitch(partnerAbsent, 3, deps(partnerAbsent)).shouldSwitch).toBe(true)
    expect(partnerAbsent.battlers[3]!.aiMonToSwitchIntoId).toBe(0)
    // Singles flags: slot 0 is an ordinary reserve and decides the same way.
    const single = asSinglesFlags(setup())
    expect(shouldSwitch(single, 3, deps(single)).shouldSwitch).toBe(true)
    expect(single.battlers[3]!.aiMonToSwitchIntoId).toBe(0)
  })
})

describe('ShouldSwitchIfWonderGuard: doubles early return (:89-90)', () => {
  function wonderGuardState(rng: RandomSource): BattleState {
    const state = makeState(true, rng)
    normaliseBattlers(state)
    // The AI's BATTLE_OPPOSITE is battler 2 (:327-328's opposingPosition).
    state.battlers[2]!.mon.abilities = { ability: 'ABILITY_WONDER_GUARD', innates: [null, null, null] }
    state.battlers[2]!.mon.types = ['WATER', 'MYSTERY', 'MYSTERY']
    state.battlers[3]!.mon.moves = ['MOVE_TACKLE', null, null, null]
    const party = opponentParty(state)
    for (let i = 0; i < party.length; i++) {
      setSlot(party, i, { ability: null, moves: ['MOVE_TACKLE', null, null, null] })
    }
    // Only reserve slot 2 is super-effective against the Wonder Guard foe:
    // Absorb is 2x vs WATER (types.json).
    setSlot(party, 2, { ability: null, moves: ['MOVE_ABSORB', null, null, null] })
    return state
  }

  it('doubles draws no RNG and writes no chosenPartyIndex; singles still decides slot 2', () => {
    const doublesCounter = scripted()
    const doubles = wonderGuardState(doublesCounter.rng)
    const doublesResult = shouldSwitch(doubles, 3, deps(doubles))
    expect(doublesResult.shouldSwitch).toBe(false)
    expect(doublesCounter.draws()).toBe(0)
    expect(doubles.battlers[3]!.aiMonToSwitchIntoId).toBe(PARTY_SIZE)

    // Singles flags: the reserve loop's `Random() % 3 < 2` (:133) is the first
    // and only draw, 0 % 3 < 2 -> switch into slot 2.
    const singleCounter = scripted(0)
    const single = asSinglesFlags(wonderGuardState(singleCounter.rng))
    const singleResult = shouldSwitch(single, 3, deps(single))
    expect(singleResult.shouldSwitch).toBe(true)
    expect(single.battlers[3]!.aiMonToSwitchIntoId).toBe(2)
    expect(singleCounter.draws()).toBe(1)
  })
})
