import { describe, expect, it } from 'vitest'
import { createRandomSource } from '../rng'
import { loadSimData } from './loadSimData'
import { buildOpponentParty, buildPlayerParty } from './buildParty'
import { runBattle } from './runBattle'

describe('Battle driver and party builder', () => {
  const data = loadSimData()

  it('buildOpponentParty: hand-computed stats for TRAINER_SAWYER_1 elite slot 0 (Carbink)', () => {
    // TRAINER_SAWYER_1, elite tier slot 0:
    // Species: SPECIES_CARBINK
    // Nature: NATURE_MODEST
    // EVs: hp 252, atk 0, def 124, spatk 128, spdef 4, spe 0
    // ironPill: false (IV 31 on all stats)
    // Level: 50
    //
    // C formula citations:
    //   - IVs: src/pokemon.c:988-994 (CalculateMonStatsMaster forces all IVs to 31 when ironPill is false)
    //   - HP: src/pokemon.c:1003-1008
    //       floor((2 * baseHp + iv + floor(ev/4)) * level / 100) + level + 10
    //       = floor((2 * 50 + 31 + floor(252/4)) * 50 / 100) + 50 + 10
    //       = floor((100 + 31 + 63) * 50 / 100) + 60
    //       = floor(194 * 50 / 100) + 60 = 97 + 60 = 157
    //   - Out-of-battle stats: src/pokemon.c:955-960 (CALC_STAT) & 3485-3506 (ModifyStatByNature)
    //       n = floor((2 * base + iv + floor(ev/4)) * level / 100) + 5
    //       Def: base 150, iv 31, ev 124 -> floor(124/4) = 31
    //            n = floor((300 + 31 + 31) * 50 / 100) + 5 = floor(362 * 50 / 100) + 5 = 181 + 5 = 186
    //            Nature delta for DEF under NATURE_MODEST is 0 -> def = 186
    //       Atk: base 50, iv 31, ev 0
    //            n = floor((100 + 31 + 0) * 50 / 100) + 5 = 65 + 5 = 70
    //            Nature delta -1 -> floor(70 * 90 / 100) = 63
    //       SpAtk: base 50, iv 31, ev 128 -> floor(128/4) = 32
    //            n = floor((100 + 31 + 32) * 50 / 100) + 5 = floor(163 * 50 / 100) + 5 = 81 + 5 = 86
    //            Nature delta +1 -> floor(86 * 110 / 100) = 94
    //       SpDef: base 150, iv 31, ev 4 -> floor(4/4) = 1
    //            n = floor((300 + 31 + 1) * 50 / 100) + 5 = floor(332 * 50 / 100) + 5 = 166 + 5 = 171
    //            Nature delta 0 -> spdef = 171
    //       Speed: base 50, iv 31, ev 0
    //            n = floor((100 + 31 + 0) * 50 / 100) + 5 = 65 + 5 = 70
    //            Nature delta 0 -> spe = 70

    const trainer = data.trainersById.get('TRAINER_SAWYER_1')
    expect(trainer).toBeDefined()

    const party = buildOpponentParty(trainer!, 'elite', 50, data)
    expect(party.length).toBeGreaterThan(0)

    const carbink = party[0]
    expect(carbink.speciesId).toBe('SPECIES_CARBINK')
    expect(carbink.level).toBe(50)
    expect(carbink.hp).toBe(157)
    expect(carbink.maxHp).toBe(157)
    expect(carbink.rawStats.def).toBe(186)
    expect(carbink.rawStats.atk).toBe(63)
    expect(carbink.rawStats.spatk).toBe(94)
    expect(carbink.rawStats.spdef).toBe(171)
    expect(carbink.rawStats.spe).toBe(70)

    expect(carbink.abilities.ability).toBe('ABILITY_STURDY')
    expect(carbink.abilities.innates).toEqual(['ABILITY_CLEAR_BODY', 'ABILITY_IMPENETRABLE', 'ABILITY_STALL'])
    expect(carbink.types).toEqual(['ROCK', 'FAIRY', 'MYSTERY'])
    expect(carbink.itemId).toBe('ITEM_LIGHT_CLAY')
  })

  it('runs a small deterministic fight to a terminal outcome or maxTurns with unmodelled Map', () => {
    const trainer = data.trainersById.get('TRAINER_MAY_ROUTE_103_TORCHIC') ?? data.trainers[0]
    expect(trainer).toBeDefined()

    const playerParty = buildPlayerParty(
      [
        {
          species: 'SPECIES_SWAMPERT',
          level: 50,
          nature: 'NATURE_ADAMANT',
          evs: { hp: 252, atk: 252, spe: 4 },
          moves: ['MOVE_WATERFALL', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH', 'MOVE_ROCK_SLIDE'],
        },
        {
          species: 'SPECIES_GARCHOMP',
          level: 50,
          nature: 'NATURE_JOLLY',
          evs: { atk: 252, spe: 252, hp: 4 },
          moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
        },
      ],
      50,
      data,
    )

    const rng = createRandomSource(42)
    const result = runBattle({
      data,
      playerParty,
      opponentTrainer: trainer!,
      tier: 'elite',
      rng,
      maxTurns: 60,
    })

    expect(result.error).toBeUndefined()
    expect(result.turns).toBeGreaterThan(0)
    expect(result.turns).toBeLessThanOrEqual(60)
    expect(['WON', 'LOST', 'DREW', 'MAX_TURNS']).toContain(result.outcome)
    expect(result.unmodelled).toBeInstanceOf(Map)
    expect(result.log.length).toBe(result.turns)
  })
})
