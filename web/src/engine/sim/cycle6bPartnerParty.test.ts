/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 6b (dbl-6b slice 1, items 6.3 + 6.4 of docs/battle-sim/doubles-plan.md):
// partner party build and 3-mon player cap inside createSession.
//
// C lines checked (pipeline/.upstream/eliteredux-source/src/):
//   battle_tower.c:2394-2461  FillPartnerParty: custom partner trainer data builds
//                             gPlayerParty[3..5] from the partner trainer's base (ace)
//                             party, with level = GetHighestLevelInPlayerParty()
//                             clamped to [1, 100], IV 31, and no innate gate.
//   party_menu.c:5954-5963    GetMaxBattleEntries: returns MULTI_PARTY_SIZE (3) for
//                             FACILITY_MULTI_OR_EREADER.
//   battle_controllers.c:160-171  Partner formats: battler 0 is slot 0, battler 2 is slot 3.
//   battle_controller_player_partner.c:678-680  Partner mons are built with isPlayer == FALSE;
//                             they are not innate-gated.

import { describe, expect, it } from 'vitest'

import {
  BATTLE_TYPE_INGAME_PARTNER,
} from './constants'
import { buildPlayerParty } from './driver/buildParty'
import { fightSpecFor } from './driver/fightSpec'
import { loadSimData, type TrainerData } from './driver/loadSimData'
import { createRandomSource } from './rng'
import { createSession } from './driver/session'
import { calcHp } from '../stats'
import { gateInnates } from './innateGate'
import { loadBossTrainerIds } from './driver/bossSet'

const data = loadSimData()

const PLAYER_3_MONS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

describe('cycle 6b: partner party build and 3-mon cap in createSession', () => {
  it('1. Meteor Falls builds 4-battler session with partner in slots 3-5 and battler 2 in slot 3', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const playerParty = buildPlayerParty(PLAYER_3_MONS, 50, data)
    const session = createSession({
      data,
      playerParty,
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })

    const { state } = session
    expect(state.battlersCount).toBe(4)
    expect((state.battleTypeFlags & BATTLE_TYPE_INGAME_PARTNER) !== 0).toBe(true)

    // Side 0 slots 3-5 are the partner's species in the order of MAY_TORCHIC_METEOR_FALLS.parties.ace
    const partnerTrainer = data.trainersById.get('MAY_TORCHIC_METEOR_FALLS')!
    const expectedSpecies = partnerTrainer.parties.ace.map((m) => m.species)
    expect(expectedSpecies).toEqual([
      'SPECIES_PIKACHU_POP_STAR',
      'SPECIES_SLIGGOO_HISUIAN',
      'SPECIES_BLAZIKEN',
    ])

    expect(state.sides[0].party[3]?.speciesId).toBe(expectedSpecies[0])
    expect(state.sides[0].party[4]?.speciesId).toBe(expectedSpecies[1])
    expect(state.sides[0].party[5]?.speciesId).toBe(expectedSpecies[2])

    // Battler 2 is slot 3 (battle_controllers.c:160-171), battler 0 is player slot 0
    expect(state.battlers[2]?.partyIndex).toBe(3)
    expect(state.battlers[2]?.mon.speciesId).toBe(expectedSpecies[0])
    expect(state.battlers[0]?.partyIndex).toBe(0)
    expect(state.battlers[0]?.mon.speciesId).toBe('SPECIES_TYRANITAR')
  })

  it('2. level: partner and opponent levels equal max level of first 3 player mons, ignoring cut mons', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')

    // Case 1: 3-mon party with levels 40, 50, 62 -> partner is 62
    const party3 = buildPlayerParty(
      [
        { species: 'SPECIES_TYRANITAR', level: 40, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_SWAMPERT', level: 62, moves: ['MOVE_TACKLE'] },
      ],
      50,
      data,
    )
    const session1 = createSession({
      data,
      playerParty: party3,
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })
    expect(session1.state.sides[0].party[3]?.level).toBe(62)
    expect(session1.state.sides[0].party[4]?.level).toBe(62)
    expect(session1.state.sides[0].party[5]?.level).toBe(62)

    // Case 2: 5-mon party whose 4th mon is level 100 -> capped to first 3, max is 62
    const party5 = buildPlayerParty(
      [
        { species: 'SPECIES_TYRANITAR', level: 40, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_SWAMPERT', level: 62, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_SALAMENCE', level: 100, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_GARDEVOIR', level: 70, moves: ['MOVE_TACKLE'] },
      ],
      50,
      data,
    )
    const session2 = createSession({
      data,
      playerParty: party5,
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })
    // Partner stays at max of first 3 mons (62)
    expect(session2.state.sides[0].party[3]?.level).toBe(62)
    expect(session2.state.sides[0].party[4]?.level).toBe(62)
    expect(session2.state.sides[0].party[5]?.level).toBe(62)
    // Opponent mons also derive from the capped max level (62)
    for (const opponentMon of session2.state.sides[1].party) {
      if (opponentMon.speciesId) {
        expect(opponentMon.level).toBe(62)
      }
    }
  })

  it('3. level clamp: level 100 asserts 100', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const party = buildPlayerParty(
      [
        { species: 'SPECIES_TYRANITAR', level: 100, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_METAGROSS', level: 100, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_SWAMPERT', level: 100, moves: ['MOVE_TACKLE'] },
      ],
      100,
      data,
    )
    const session = createSession({
      data,
      playerParty: party,
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })
    expect(session.state.sides[0].party[3]?.level).toBe(100)
    expect(session.state.sides[0].party[4]?.level).toBe(100)
    expect(session.state.sides[0].party[5]?.level).toBe(100)
  })

  it('4. IV 31 and stats: partner maxHp recomputed with calcHp matches state', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const playerParty = buildPlayerParty(PLAYER_3_MONS, 50, data)
    const session = createSession({
      data,
      playerParty,
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })

    const partnerTrainer = data.trainersById.get('MAY_TORCHIC_METEOR_FALLS')!
    const mon0 = partnerTrainer.parties.ace[0]!
    const species0 = data.speciesById.get(mon0.species)!
    const isShedinja = species0.id === 'SPECIES_SHEDINJA' || species0.id === 'SPECIES_SHEDINJA_MEGA'
    const expectedHp = calcHp(species0.baseStats.hp, 31, mon0.evs?.hp ?? 0, 50, isShedinja)

    const partnerMonInParty = session.state.sides[0].party[3]!
    expect(partnerMonInParty.maxHp).toBe(expectedHp)
    expect(partnerMonInParty.hp).toBe(expectedHp)
  })

  it('5. innates: partner keeps full innate list even when player tier is ace or elite', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    // At level 20 with tier: 'elite', the player's 3rd innate (threshold 24) is gated to null
    const playerParty = buildPlayerParty(
      [
        { species: 'SPECIES_TYRANITAR', level: 20, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_METAGROSS', level: 20, moves: ['MOVE_TACKLE'] },
        { species: 'SPECIES_SWAMPERT', level: 20, moves: ['MOVE_TACKLE'] },
      ],
      20,
      data,
    )
    const session = createSession({
      data,
      playerParty,
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      tier: 'elite',
      rng: createRandomSource(1),
    })

    const partnerMon = session.state.sides[0].party[3]!
    const partnerSpecies = data.speciesById.get(partnerMon.speciesId!)!
    // Partner mon has all 3 innates ungated
    expect(partnerMon.abilities.innates).toEqual([
      partnerSpecies.innates?.[0] ?? null,
      partnerSpecies.innates?.[1] ?? null,
      partnerSpecies.innates?.[2] ?? null,
    ])
    expect(partnerMon.abilities.innates[2]).not.toBeNull()

    // Negative: player mon IS gated at this tier under level 24
    const playerMon = session.state.sides[0].party[0]!
    const playerSpecies = data.speciesById.get(playerMon.speciesId!)!
    const expectedPlayerInnates = gateInnates(
      [playerSpecies.innates?.[0] ?? null, playerSpecies.innates?.[1] ?? null, playerSpecies.innates?.[2] ?? null],
      20,
      'elite',
    )
    expect(expectedPlayerInnates[2]).toBeNull()
    expect(playerMon.abilities.innates).toEqual(expectedPlayerInnates)

    // With tier: 'ace', partner also retains full innates
    const sessionAce = createSession({
      data,
      playerParty,
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      tier: 'ace',
      rng: createRandomSource(1),
    })
    const partnerMonAce = sessionAce.state.sides[0].party[3]!
    expect(partnerMonAce.abilities.innates).toEqual([
      partnerSpecies.innates?.[0] ?? null,
      partnerSpecies.innates?.[1] ?? null,
      partnerSpecies.innates?.[2] ?? null,
    ])
  })

  it('6. negative: empty ace party throws createSession error; single opponent throws buildBattleState error', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const playerParty = buildPlayerParty(PLAYER_3_MONS, 50, data)

    // Partner with empty parties.ace
    const badPartner: TrainerData = {
      ...spec.format.partner!,
      parties: {
        ...spec.format.partner!.parties,
        ace: [],
      },
    }
    expect(() =>
      createSession({
        data,
        playerParty,
        opponentTrainer: spec.opponentTrainer,
        format: { ...spec.format, partner: badPartner },
        rng: createRandomSource(1),
      }),
    ).toThrow(`createSession: partner ${badPartner.id} has no ace party`)

    // Partner format with only 1 opponent throws from buildBattleState
    expect(() =>
      createSession({
        data,
        playerParty,
        opponentTrainer: spec.opponentTrainer,
        format: { opponents: [spec.opponentTrainer], partner: spec.format.partner },
        rng: createRandomSource(1),
      }),
    ).toThrow('buildBattleState: an in-game partner needs a two-opponent fight')
  })

  it('7. singles regression: createSession with no format on the same trainer data is 2 battlers', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const playerParty = buildPlayerParty(PLAYER_3_MONS, 50, data)
    const session = createSession({
      data,
      playerParty,
      opponentTrainer: spec.opponentTrainer,
      rng: createRandomSource(1),
    })
    expect(session.state.battlersCount).toBe(2)
  })

  it('8. Space Center (TRAINER_MAXIE_MOSSDEEP, partner TRAINER_STEVEN_MOSSDEEP) shape check', () => {
    const spec = fightSpecFor(data, 'TRAINER_MAXIE_MOSSDEEP')
    const playerParty = buildPlayerParty(PLAYER_3_MONS, 50, data)
    const session = createSession({
      data,
      playerParty,
      opponentTrainer: spec.opponentTrainer,
      format: spec.format,
      rng: createRandomSource(1),
    })

    const { state } = session
    expect(state.battlersCount).toBe(4)
    expect((state.battleTypeFlags & BATTLE_TYPE_INGAME_PARTNER) !== 0).toBe(true)

    // Steven's ace party species in slots 3-5
    const partnerTrainer = data.trainersById.get('TRAINER_STEVEN_MOSSDEEP')!
    const expectedSpecies = partnerTrainer.parties.ace.map((m) => m.species)
    expect(expectedSpecies).toEqual([
      'SPECIES_AGGRON',
      'SPECIES_GENESECT',
      'SPECIES_METAGROSS',
    ])

    expect(state.sides[0].party[3]?.speciesId).toBe('SPECIES_AGGRON')
    expect(state.sides[0].party[4]?.speciesId).toBe('SPECIES_GENESECT')
    expect(state.sides[0].party[5]?.speciesId).toBe('SPECIES_METAGROSS')
  })

  it('9. 6.4: bossSet keeps dropping partner ids from opponent union while fightSpec carries them', () => {
    const bossIds = loadBossTrainerIds()
    expect(bossIds).not.toContain('MAY_TORCHIC_METEOR_FALLS')
    expect(bossIds).not.toContain('TRAINER_STEVEN_MOSSDEEP')

    const courtneySpec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    expect(courtneySpec.format.partner?.id).toBe('MAY_TORCHIC_METEOR_FALLS')

    const maxieSpec = fightSpecFor(data, 'TRAINER_MAXIE_MOSSDEEP')
    expect(maxieSpec.format.partner?.id).toBe('TRAINER_STEVEN_MOSSDEEP')
  })
})
