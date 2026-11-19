/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 5g: fight specs for the two multi_2_vs_2 fights (Meteor Falls & Space Center).
//
// C / script lines checked:
//   pipeline/.upstream/eliteredux-source/data/maps/MeteorFalls_1F_1R/scripts.pory:193,202,211,220,229,238
//     multi_2_vs_2 TRAINER_COURTNEY_METEOR_FALLS, ..., TRAINER_GRUNT_METEOR_FALLS, ..., <PARTNER>, ...
//   pipeline/.upstream/eliteredux-source/data/maps/MossdeepCity_SpaceCenter_2F/scripts.pory:274
//     multi_2_vs_2 TRAINER_MAXIE_MOSSDEEP, ..., TRAINER_COURTNEY_MOSSDEEP, ..., TRAINER_STEVEN_MOSSDEEP, ...
//   pipeline/.upstream/eliteredux-source/src/battle_tower.c:1645-1652
//     MULTI_BATTLE_2_VS_2 sets BATTLE_TYPE_TRAINER | BATTLE_TYPE_DOUBLE | BATTLE_TYPE_TWO_OPPONENTS | BATTLE_TYPE_MULTI | BATTLE_TYPE_INGAME_PARTNER
//   pipeline/.upstream/eliteredux-source/src/battle_tower.c:2394-2461
//     FillPartnerParty: custom partner trainer data populates gPlayerParty[3..5].

import { describe, expect, it } from 'vitest'

import {
  BATTLE_TYPE_DOUBLE,
  BATTLE_TYPE_INGAME_PARTNER,
  BATTLE_TYPE_MULTI,
  BATTLE_TYPE_TRAINER,
  BATTLE_TYPE_TWO_OPPONENTS,
} from './constants'
import { battleTypeFlagsFor, buildBattleState, trainerForBattler } from './driver/battleFormat'
import { buildOpponentParty, buildPlayerParty } from './driver/buildParty'
import { fightSpecFor } from './driver/fightSpec'
import { loadSimData } from './driver/loadSimData'
import { createRandomSource } from './rng'

const data = loadSimData()

const PLAYER_SPECS = [
  { species: 'SPECIES_TYRANITAR', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_METAGROSS', level: 50, moves: ['MOVE_TACKLE'] },
  { species: 'SPECIES_SWAMPERT', level: 50, moves: ['MOVE_TACKLE'] },
]

describe('cycle 5g: multi_2_vs_2 fight specs', () => {
  it('1. Meteor Falls default partner and battle type flags', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    expect(spec.format.opponents.map((t) => t.id)).toEqual([
      'TRAINER_COURTNEY_METEOR_FALLS',
      'TRAINER_GRUNT_METEOR_FALLS',
    ])
    expect(spec.format.partner?.id).toBe('MAY_TORCHIC_METEOR_FALLS')
    expect(spec.opponentTrainer.id).toBe('TRAINER_COURTNEY_METEOR_FALLS')

    const flags = battleTypeFlagsFor(spec.format)
    expect((flags & BATTLE_TYPE_TRAINER) !== 0).toBe(true)
    expect((flags & BATTLE_TYPE_DOUBLE) !== 0).toBe(true)
    expect((flags & BATTLE_TYPE_TWO_OPPONENTS) !== 0).toBe(true)
    expect((flags & BATTLE_TYPE_MULTI) !== 0).toBe(true)
    expect((flags & BATTLE_TYPE_INGAME_PARTNER) !== 0).toBe(true)
    expect(flags).toBe(
      BATTLE_TYPE_TRAINER |
        BATTLE_TYPE_DOUBLE |
        BATTLE_TYPE_TWO_OPPONENTS |
        BATTLE_TYPE_MULTI |
        BATTLE_TYPE_INGAME_PARTNER,
    )
  })

  it('2. all six Meteor Falls partner ids resolve with partnerId and trainerForBattler', () => {
    const partnerIds = [
      'MAY_TREECKO_METEOR_FALLS',
      'MAY_TORCHIC_METEOR_FALLS',
      'MAY_MUDKIP_METEOR_FALLS',
      'BRENDAN_TREECKO_METEOR_FALLS',
      'BRENDAN_TORCHIC_METEOR_FALLS',
      'BRENDAN_MUDKIP_METEOR_FALLS',
    ]
    for (const partnerId of partnerIds) {
      const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS', { partnerId })
      expect(spec.format.partner?.id).toBe(partnerId)
      expect(trainerForBattler(spec.format, 1).id).toBe('TRAINER_COURTNEY_METEOR_FALLS')
      expect(trainerForBattler(spec.format, 2).id).toBe(partnerId)
      expect(trainerForBattler(spec.format, 3).id).toBe('TRAINER_GRUNT_METEOR_FALLS')
    }
  })

  it('3. Space Center multi fight resolves Maxie + Courtney with Steven partner', () => {
    const spec = fightSpecFor(data, 'TRAINER_MAXIE_MOSSDEEP')
    expect(spec.format.opponents.map((t) => t.id)).toEqual([
      'TRAINER_MAXIE_MOSSDEEP',
      'TRAINER_COURTNEY_MOSSDEEP',
    ])
    expect(spec.format.partner?.id).toBe('TRAINER_STEVEN_MOSSDEEP')
    expect(spec.opponentTrainer.id).toBe('TRAINER_MAXIE_MOSSDEEP')
    expect(trainerForBattler(spec.format, 2).id).toBe('TRAINER_STEVEN_MOSSDEEP')
    expect(trainerForBattler(spec.format, 3).id).toBe('TRAINER_COURTNEY_MOSSDEEP')
  })

  it('4. negative: mismatched partnerId throws; non-multi trainers are unchanged', () => {
    expect(() =>
      fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS', {
        partnerId: 'TRAINER_STEVEN_MOSSDEEP',
      }),
    ).toThrow('fightSpecFor: TRAINER_STEVEN_MOSSDEEP is not a partner of TRAINER_COURTNEY_METEOR_FALLS')

    const roxanne = fightSpecFor(data, 'TRAINER_ROXANNE_1')
    expect(roxanne.format.partner).toBeUndefined()
    expect(roxanne.format.opponents).toHaveLength(1)

    const tateAndLiza = fightSpecFor(data, 'TRAINER_TATE_AND_LIZA_1')
    expect(tateAndLiza.format.partner).toBeUndefined()
    expect(tateAndLiza.format.opponents).toHaveLength(1)

    const juan = fightSpecFor(data, 'TRAINER_JUAN_1')
    expect(juan.format.partner).toBeUndefined()
    expect(juan.format.opponents).toHaveLength(2)
  })

  it('5. buildBattleState with multi fight spec sets battleTypeFlags matching battleTypeFlagsFor', () => {
    const spec = fightSpecFor(data, 'TRAINER_COURTNEY_METEOR_FALLS')
    const playerParty = buildPlayerParty(PLAYER_SPECS, 50, data)
    const opponentParties = spec.format.opponents.map((t) => buildOpponentParty(t, 'elite', 50, data))
    const partnerParty = buildOpponentParty(spec.format.partner!, 'ace', 50, data)

    const state = buildBattleState(spec.format, {
      data,
      tier: 'elite',
      playerParty,
      opponentParties,
      partnerParty,
      rng: createRandomSource(1),
    })

    expect(state.battleTypeFlags).toBe(battleTypeFlagsFor(spec.format))
    expect(state.battlersCount).toBe(4)
  })
})
