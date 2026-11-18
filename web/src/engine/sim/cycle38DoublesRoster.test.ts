/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 38 (dbl-2a): the doubles roster scaffolding, with every singles result unchanged.
//
//   (1) battleTypeFlagsFor mirrors battle_main.c:1757-1762 / :1910-1913 (single trainer)
//       and battle_tower.c:1627-1628 / :1645-1647 (two opponents / partner).
//   (2) startingPartyIndexes is SetBattlePartyIds (battle_controllers.c:615-675) and the
//       partner branch at :160-171, ported line for line including the in-loop fallback.
//   (3) buildBattleState lays one 6-slot party per side (battle_main.c:613-615,
//       FillPartnerParty battle_tower.c:2394-2399) and, for singles, produces exactly the
//       createBattleState literal createSession built before this change.
//   (4) partySlotsFor is the HasNoMonsToSwitch split (battle_util.c:3629-3641, :3672-3685).
//   (5) The four reserve scans must never offer a partner's ACTIVE party slot.

import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import { BATTLE_TYPE_DOUBLE, BATTLE_TYPE_INGAME_PARTNER, BATTLE_TYPE_MULTI, BATTLE_TYPE_TRAINER, BATTLE_TYPE_TWO_OPPONENTS, PARTY_SIZE } from './constants'
import { loadSimData, type TrainerData } from './driver/loadSimData'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { battleTypeFlagsFor, buildBattleState, startingPartyIndexes, toBattleMon } from './driver/battleFormat'
import { cloneSession, createSession, firstLiveReplacement, type BattleSession } from './driver/session'
import { defaultPlayerPolicy } from './driver/runBattle'
import { legalChoices } from './driver/expectimax'
import { hasLiveReserve } from './switchIn'
import { partySlotsFor } from './partySlots'
import { battleAiSetupFlags } from './ai/aiFlags'
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

const forcedTrainer: TrainerData = { ...trainer, forcedDouble: true }

/** One real party entry, then hp overridden -- the roster scans only read speciesId/hp. */
function mon(hp: number): SimPartyMon {
  const base = buildPlayerParty([{ species: 'SPECIES_MUDKIP', moves: [] }], 50, data)[0]!
  return { ...base, hp: hp > 0 ? hp : 0, maxHp: base.maxHp }
}

function slot(kind: 'valid' | 'dead' | 'empty'): SimPartyMon {
  if (kind === 'empty') return { ...mon(0), speciesId: null }
  return mon(kind === 'valid' ? 20 : 0)
}

const roster = (...kinds: Array<'valid' | 'dead' | 'empty'>): SimPartyMon[] => kinds.map(slot)

/** The rng closure is not part of the state comparison: cloneSession already gives a
 * copy its own generator, and every other field is plain data. */
const strip = (state: BattleState) => JSON.parse(JSON.stringify(state, (k, v) => (k === 'rng' ? undefined : v)))

function singlesState(specs = SPECS): BattleState {
  return buildBattleState(
    { opponents: [trainer] },
    {
      data,
      tier: 'elite',
      playerParty: buildPlayerParty(specs, 50, data),
      opponentParties: [buildOpponentParty(trainer, 'elite', 50, data)],
      rng: createRandomSource(1),
    },
  )
}

function doubleState(): BattleState {
  return buildBattleState(
    { opponents: [trainer], forcedDouble: true },
    {
      data,
      tier: 'elite',
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentParties: [buildOpponentParty(trainer, 'elite', 50, data)],
      rng: createRandomSource(1),
    },
  )
}

function partnerState(): BattleState {
  return buildBattleState(
    { opponents: [secondTrainer, trainer], partner: partnerTrainer },
    {
      data,
      tier: 'elite',
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentParties: [
        buildOpponentParty(secondTrainer, 'elite', 50, data),
        buildOpponentParty(trainer, 'elite', 50, data),
      ],
      partnerParty: buildOpponentParty(partnerTrainer, 'ace', 50, data),
      rng: createRandomSource(1),
    },
  )
}

/** A real session around an arbitrary state: createSession builds the data/deps, then
 * cloneSession rebuilds the turn/AI deps around the state we care about. */
function sessionFor(state: BattleState): BattleSession {
  const base = createSession({
    data,
    playerParty: buildPlayerParty(SPECS, 50, data),
    opponentTrainer: trainer,
    rng: createRandomSource(1),
  })
  base.state = state
  return cloneSession(base, 3)
}

describe('battle type flags', () => {
  it('a forced-double single trainer is TRAINER | DOUBLE (battle_main.c:1910-1913)', () => {
    // `isDoubleBattle` sets DOUBLE; the else branch ORs gTrainers[].doubleBattle, so the
    // forced flag keeps DOUBLE regardless of the player's usable-mon count.
    expect(battleTypeFlagsFor({ opponents: [forcedTrainer] })).toBe(BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE)
    expect(battleTypeFlagsFor({ opponents: [forcedTrainer] })).toBe(9)
  })

  it('a non-forced single trainer with a multi-mon party stays TRAINER only (battle_main.c:1910-1913)', () => {
    // Negative: nothing ORs DOUBLE in; the C's else branch ORs a FALSE doubleBattle.
    expect(battleTypeFlagsFor({ opponents: [trainer] })).toBe(BATTLE_TYPE_TRAINER)
    expect(battleTypeFlagsFor({ opponents: [trainer] }) & BATTLE_TYPE_DOUBLE).toBe(0)
  })

  it('two opponents add DOUBLE | TWO_OPPONENTS (battle_tower.c:1627-1628)', () => {
    expect(battleTypeFlagsFor({ opponents: [trainer, secondTrainer] })).toBe(
      BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS,
    )
  })

  it('a partner adds MULTI | INGAME_PARTNER (battle_tower.c:1645-1647)', () => {
    expect(battleTypeFlagsFor({ opponents: [trainer, secondTrainer], partner: partnerTrainer })).toBe(
      BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER,
    )
  })

  it('the explicit forcedDouble input overrides the trainer row', () => {
    expect(battleTypeFlagsFor({ opponents: [trainer], forcedDouble: true })).toBe(BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE)
    expect(battleTypeFlagsFor({ opponents: [forcedTrainer], forcedDouble: false })).toBe(BATTLE_TYPE_TRAINER)
  })
})

describe('starting party indexes: SetBattlePartyIds (battle_controllers.c:615-675)', () => {
  const double = { opponents: [trainer], forcedDouble: true }

  it('battlers 0 and 2 take the first two valid player slots', () => {
    // roster [dead, valid, valid]: i=0 -> 1; i=2 skips j=0 (dead), j=1 (is i-2's slot)
    // and breaks at j=2.
    const player = roster('dead', 'valid', 'valid', 'empty', 'empty', 'empty')
    const opponent = roster('valid', 'valid')
    const indexes = startingPartyIndexes(double, player, opponent, 4)
    expect(indexes[0]).toBe(1)
    expect(indexes[2]).toBe(2)
  })

  it('two valid mons at slots 0 and 4 start at 0 and 4', () => {
    const player = roster('valid', 'dead', 'dead', 'dead', 'valid', 'dead')
    const opponent = roster('valid', 'valid')
    const indexes = startingPartyIndexes(double, player, opponent, 4)
    expect(indexes[0]).toBe(0)
    expect(indexes[2]).toBe(4)
  })

  it('the in-loop fallback assigns 1 when the flank-mate is slot 0 (battle_controllers.c:663-667)', () => {
    // Only slot 0 is valid, so j=0 fails the `i-2 != j` test and the fallback runs on
    // every j: 0 -> 1, 1 -> 0, ... ending at 0. The C then breaks at no j, so the last
    // fallback wins. (buildBattleState rejects this roster; the pure port still shows it.)
    const player = roster('valid', 'dead', 'dead', 'dead', 'dead', 'dead')
    const opponent = roster('valid', 'valid')
    const indexes = startingPartyIndexes(double, player, opponent, 4)
    expect(indexes[0]).toBe(0)
    expect(indexes[2]).toBe(1)
  })

  it('TWO_OPPONENTS forces battlers 1 and 3 to slots 0 and 3 (battle_controllers.c:672-673)', () => {
    // The first valid enemy slot is 1, so the scan alone would give [1] = 1 and [3] = 2;
    // the post-loop force overwrites both.
    const player = roster('valid', 'valid', 'empty', 'empty', 'empty', 'empty')
    const opponent = roster('dead', 'valid', 'valid', 'empty', 'empty', 'empty')
    const indexes = startingPartyIndexes({ opponents: [trainer, secondTrainer] }, player, opponent, 4)
    expect(indexes[1]).toBe(0)
    expect(indexes[3]).toBe(3)
  })

  it('a partner format starts [0, 0, 3, 3] (battle_controllers.c:160-171)', () => {
    const indexes = startingPartyIndexes(
      { opponents: [trainer, secondTrainer], partner: partnerTrainer },
      roster('valid', 'valid', 'valid', 'valid', 'valid', 'valid'),
      roster('valid', 'valid', 'valid', 'valid', 'valid', 'valid'),
      4,
    )
    expect(indexes).toEqual([0, 0, 3, 3])
  })

  it('buildBattleState refuses a double side with fewer than two valid mons', () => {
    expect(() =>
      buildBattleState(
        { opponents: [trainer], forcedDouble: true },
        {
          data,
          tier: 'elite',
          playerParty: [mon(20)],
          opponentParties: [buildOpponentParty(trainer, 'elite', 50, data)],
          rng: createRandomSource(1),
        },
      ),
    ).toThrow(/player side has 1 valid mon/)
  })

  it('buildBattleState lays a fainted player slot out by the same scan', () => {
    const playerParty = buildPlayerParty(SPECS, 50, data)
    playerParty[0]!.hp = 0
    const state = buildBattleState(
      { opponents: [trainer], forcedDouble: true },
      {
        data,
        tier: 'elite',
        playerParty,
        opponentParties: [buildOpponentParty(trainer, 'elite', 50, data)],
        rng: createRandomSource(1),
      },
    )
    expect(state.battlers[0]!.partyIndex).toBe(1)
    expect(state.battlers[2]!.partyIndex).toBe(2)
    expect(state.battlersCount).toBe(4)
  })

  it('a partner fight places the partner in player slots 3-5', () => {
    const state = partnerState()
    expect(state.battleTypeFlags & BATTLE_TYPE_INGAME_PARTNER).toBe(BATTLE_TYPE_INGAME_PARTNER)
    expect(state.battlers.map((b) => b?.partyIndex)).toEqual([0, 0, 3, 3])
  })
})

describe('buildBattleState: singles is deep-equal to the pre-change literal', () => {
  it('matches createBattleState shape for createSession\'s singles call', () => {
    // The literal createSession used at session.ts:277-305 before this cycle: battler 0
    // is the lead (slot 0), battler 1 the opponent's slot 0, TRAINER only.
    const playerParty = buildPlayerParty(SPECS, 50, data)
    const opponentParty = buildOpponentParty(trainer, 'elite', 50, data)
    const rng = createRandomSource(1)
    const expected = createBattleState({
      battlers: [
        createBattlerState(0, toBattleMon(playerParty[0]!), 0),
        createBattlerState(1, toBattleMon(opponentParty[0]!), 0),
      ],
      playerParty,
      opponentParty,
      battleTypeFlags: BATTLE_TYPE_TRAINER,
      aiFlags: battleAiSetupFlags(trainer, 0),
      tier: 'elite',
      rng,
    })
    const actual = buildBattleState(
      { opponents: [trainer] },
      { data, tier: 'elite', playerParty, opponentParties: [opponentParty], rng },
    )

    expect(strip(actual)).toEqual(strip(expected))
    expect(actual.battleTypeFlags).toBe(BATTLE_TYPE_TRAINER)
    expect(actual.battlersCount).toBe(2)
    expect(actual.battlers[0]!.partyIndex).toBe(0)
    expect(actual.battlers[1]!.partyIndex).toBe(0)
  })
})

describe('createSession: a forced-double trainer starts a double (dbl-5b)', () => {
  it('builds four battlers instead of refusing the trainer', () => {
    // battle_main.c:1757-1762 sets `isDoubleBattle` from `gTrainers[].doubleBattle`,
    // and :1910-1913 ORs that bit into `gBattleTypeFlags`; the action-selection loop
    // then runs gActiveBattler 0..gBattlersCount-1 (:3629), i.e. four battlers. dbl-3
    // landed the doubles turn loop, so dbl-5b lets createSession reach it rather than
    // refusing the trainer.
    const session = createSession({
      data,
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentTrainer: forcedTrainer,
      rng: createRandomSource(1),
    })
    expect(session.state.battlersCount).toBe(4)
    expect(session.state.battleTypeFlags & BATTLE_TYPE_DOUBLE).toBe(BATTLE_TYPE_DOUBLE)
    expect(session.state.battleTypeFlags & BATTLE_TYPE_TRAINER).toBe(BATTLE_TYPE_TRAINER)
  })
})

describe('partySlotsFor (battle_util.c:3629-3641, :3672-3685)', () => {
  const stateWith = (battleTypeFlags: number) => createBattleState({ battlers: [], battleTypeFlags, rng: createRandomSource(1) })

  it('singles and a plain double give every battler [0, PARTY_SIZE)', () => {
    for (const flags of [BATTLE_TYPE_TRAINER, BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE]) {
      const state = stateWith(flags)
      for (let id = 0; id < 4; id++) expect(partySlotsFor(state, id)).toEqual([0, PARTY_SIZE])
    }
  })

  it('a partner fight splits BOTH sides by flank: 0/1 -> [0,3), 2/3 -> [3,6)', () => {
    const state = stateWith(BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER)
    expect(partySlotsFor(state, 0)).toEqual([0, 3])
    expect(partySlotsFor(state, 1)).toEqual([0, 3])
    expect(partySlotsFor(state, 2)).toEqual([3, 6])
    expect(partySlotsFor(state, 3)).toEqual([3, 6])
  })

  it('two opponents split the opponent side only (battle_util.c:3672-3685)', () => {
    const state = stateWith(BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS)
    expect(partySlotsFor(state, 0)).toEqual([0, PARTY_SIZE])
    expect(partySlotsFor(state, 1)).toEqual([0, 3])
    expect(partySlotsFor(state, 2)).toEqual([0, PARTY_SIZE])
    expect(partySlotsFor(state, 3)).toEqual([3, 6])
  })
})

describe('reserve scans exclude every active slot of the side (the dbl-2a defect)', () => {
  it('hasLiveReserve does not count the partner active slot', () => {
    const state = doubleState()
    // Player battlers are at slots 0 and 1; slot 2 is a free reserve.
    expect(hasLiveReserve(state, 0)).toBe(true)

    state.sides[0].party[2]!.hp = 0
    // Slot 1 is alive but held by battler 2 -- the old rule offered it because it only
    // excluded battler 0's own index.
    expect(state.sides[0].party[1]!.speciesId).not.toBeNull()
    expect(state.sides[0].party[1]!.hp).toBeGreaterThan(0)
    expect(hasLiveReserve(state, 0)).toBe(false)
  })

  it('firstLiveReplacement skips the partner active slot', () => {
    const state = doubleState()
    expect(firstLiveReplacement(state)).toBe(2)
    state.sides[0].party[2]!.hp = 0
    expect(firstLiveReplacement(state)).toBe(PARTY_SIZE)
  })

  it('defaultPlayerPolicy skips the partner active slot', () => {
    const state = doubleState()
    state.battlers[0]!.mon.hp = 0
    defaultPlayerPolicy(state, data)
    expect(state.battlers[0]!.monToSwitchIntoId).toBe(2)

    state.sides[0].party[2]!.hp = 0
    state.battlers[0]!.monToSwitchIntoId = -1
    defaultPlayerPolicy(state, data)
    expect(state.battlers[0]!.monToSwitchIntoId).toBe(PARTY_SIZE)
  })

  it('the expectimax switch list never offers the partner active slot', () => {
    const state = doubleState()
    const session = sessionFor(state)
    const switchTargets = (s: BattleSession) =>
      legalChoices(s)
        .filter((choice) => choice.action.action === 'SWITCH')
        .map((choice) => choice.switchTo)

    expect(switchTargets(session)).toEqual([2])
    expect(switchTargets(session)).not.toContain(0)
    expect(switchTargets(session)).not.toContain(1)

    session.state.sides[0].party[2]!.hp = 0
    expect(switchTargets(session)).toEqual([])
  })

  it('singles keeps the old results exactly', () => {
    // Same pair of cases in a 1-vs-1 format: only battler 0's own slot is excluded.
    const state = singlesState(SPECS.slice(0, 2))
    expect(hasLiveReserve(state, 0)).toBe(true)
    expect(firstLiveReplacement(state)).toBe(1)

    state.sides[0].party[1]!.hp = 0
    expect(hasLiveReserve(state, 0)).toBe(false)
    expect(firstLiveReplacement(state)).toBe(PARTY_SIZE)

    const policy = singlesState(SPECS.slice(0, 2))
    policy.battlers[0]!.mon.hp = 0
    defaultPlayerPolicy(policy, data)
    expect(policy.battlers[0]!.monToSwitchIntoId).toBe(1)
    policy.sides[0].party[1]!.hp = 0
    policy.battlers[0]!.monToSwitchIntoId = -1
    defaultPlayerPolicy(policy, data)
    expect(policy.battlers[0]!.monToSwitchIntoId).toBe(PARTY_SIZE)
  })

  it('a partner fight never treats player slots 3-5 as reserves (battle_util.c:3629-3641)', () => {
    const state = partnerState()
    expect(partySlotsFor(state, 0)).toEqual([0, 3])
    expect(partySlotsFor(state, 2)).toEqual([3, 6])

    // Kill the player's own reserves; the partner's three mons stay alive at 3-5.
    state.sides[0].party[1]!.hp = 0
    state.sides[0].party[2]!.hp = 0
    expect(state.sides[0].party[4]!.hp).toBeGreaterThan(0)
    expect(hasLiveReserve(state, 0)).toBe(false)
    expect(firstLiveReplacement(state)).toBe(PARTY_SIZE)

    const fresh = partnerState()
    expect(firstLiveReplacement(fresh)).toBe(1)
  })
})
