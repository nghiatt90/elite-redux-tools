/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle 144: the player-only innate gate and the strict level-cap table.
//
// Hand-derived from the C at the pinned SHA:
//   - include/constants/pokemon_config.h:21-31 -- Elite thresholds 1/17/24, Hell 10/17/24
//   - src/pokemon.c:6235 CanDisableInnates -- gating starts at DIFFICULTY_ELITE, so 'ace' never gates
//   - src/pokemon.c:6237-6262 getInnateDisableLevel -- per-slot threshold for the current difficulty
//   - src/battle_util.c:8799-8802 GetInnateInSlot -- only the PLAYER is gated; the AI keeps all three
//   - src/battle_util.c:8805-8815 UpdateAbilityStateIndicesForNewSpecies -- form change re-fetches
//     the new species' innates for the player with the mon's own level (slot 0 is never gated)
//   - src/pokemon.c:4633-4668 GetLevelCap -- levelCapsStrict {16,23,36,45,50,55,60,70,80,100}
import { describe, expect, it } from 'vitest'

import { buildPlayerParty } from './driver/buildParty'
import { createSession, groundingFor } from './driver/session'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'
import { gateInnates, innateSlotsFor, levelCapFor } from './innateGate'
import { megaEvolveBattler, undoMegaEvolution, type FormChangeDeps } from './formChange'
import { createRandomSource } from './rng'

const data = loadSimData()

type Innates = [string | null, string | null, string | null]
type Slots = [boolean, boolean, boolean]

const HELL_TABLE: [number, Slots][] = [
  [9, [false, false, false]],
  [10, [true, false, false]],
  [16, [true, false, false]],
  [17, [true, true, false]],
  [23, [true, true, false]],
  [24, [true, true, true]],
]

const ELITE_TABLE: [number, Slots][] = [
  [1, [true, false, false]],
  [16, [true, false, false]],
  [17, [true, true, false]],
  [23, [true, true, false]],
  [24, [true, true, true]],
]

function innatesOf(speciesId: string): Innates {
  const species = data.speciesById.get(speciesId)
  if (!species) throw new Error(`species.json has no ${speciesId}`)
  const innates = (species.innates ?? []) as (string | null)[]
  return [innates[0] ?? null, innates[1] ?? null, innates[2] ?? null]
}

/** Applies the hand-written slot table to the species' real innate ids. */
function expectedInnates(innates: Innates, slots: Slots): Innates {
  return [slots[0] ? innates[0] : null, slots[1] ? innates[1] : null, slots[2] ? innates[2] : null]
}

const opponentMon = (species: string, item = 'ITEM_NONE'): TrainerMonData => ({
  species,
  item,
  nature: 'NATURE_HARDY',
  ability: 'ABILITY_GUTS',
  evs: { hp: 0, atk: 0, def: 0, spatk: 0, spdef: 0, spe: 0 },
  moves: ['MOVE_TACKLE'],
  ironPill: false,
  hiddenPowerType: 'TYPE_NORMAL',
})

const opponent = (lead: TrainerMonData): TrainerData => {
  const mons = [lead]
  return {
    ...data.trainersById.get('TRAINER_SAWYER_1')!,
    noSwitching: true,
    parties: { ace: mons, elite: mons, hell: mons },
  }
}

function playerSession(level: number, tier?: 'ace' | 'elite' | 'hell', item = 'ITEM_NONE') {
  return createSession({
    data,
    playerParty: buildPlayerParty(
      [{ species: 'SPECIES_VENUSAUR', level, item, moves: ['MOVE_TACKLE'] }],
      level,
      data,
    ),
    opponentTrainer: opponent(opponentMon('SPECIES_VENUSAUR')),
    tier,
    rng: createRandomSource(1),
  })
}

describe('cycle 144 - innateSlotsFor hand table', () => {
  it('hell thresholds 10/17/24', () => {
    for (const [level, slots] of HELL_TABLE) {
      expect(innateSlotsFor(level, 'hell'), `hell level ${level}`).toEqual(slots)
    }
  })

  it('elite thresholds 1/17/24', () => {
    for (const [level, slots] of ELITE_TABLE) {
      expect(innateSlotsFor(level, 'elite'), `elite level ${level}`).toEqual(slots)
    }
  })

  it('ace never gates', () => {
    expect(innateSlotsFor(1, 'ace')).toEqual([true, true, true])
    expect(innateSlotsFor(9, 'ace')).toEqual([true, true, true])
  })
})

describe('cycle 144 - createSession gates the player party', () => {
  const venusaur = innatesOf('SPECIES_VENUSAUR')

  it.each(HELL_TABLE)('hell level %i', (level, slots) => {
    const session = playerSession(level, 'hell')
    const expected = expectedInnates(venusaur, slots)
    expect(session.state.battlers[0]!.mon.abilities.innates, 'active mon').toEqual(expected)
    expect(session.state.sides[0].party[0]!.abilities.innates, 'party mon').toEqual(expected)
    // GetInnateInSlot gates only innate slots; the chosen ability is never touched.
    expect(session.state.battlers[0]!.mon.abilities.ability).toBe(
      (data.speciesById.get('SPECIES_VENUSAUR')!.abilities as string[])[0],
    )
  })

  it.each(ELITE_TABLE)('elite level %i', (level, slots) => {
    const session = playerSession(level, 'elite')
    const expected = expectedInnates(venusaur, slots)
    expect(session.state.battlers[0]!.mon.abilities.innates).toEqual(expected)
    expect(session.state.sides[0].party[0]!.abilities.innates).toEqual(expected)
  })

  it('defaults to elite when no tier is supplied', () => {
    const session = playerSession(9)
    expect(session.state.tier).toBe('elite')
    expect(session.state.battlers[0]!.mon.abilities.innates).toEqual(
      expectedInnates(venusaur, [true, false, false]),
    )
  })

  it('ace keeps all three innates at level 5', () => {
    const session = playerSession(5, 'ace')
    expect(session.state.battlers[0]!.mon.abilities.innates).toEqual(venusaur)
    expect(session.state.sides[0].party[0]!.abilities.innates).toEqual(venusaur)
  })

  it.each(['ace', 'elite', 'hell'] as const)('opponent (AI) keeps all three at %s', (tier) => {
    const session = playerSession(9, tier)
    expect(session.state.battlers[1]!.mon.abilities.innates).toEqual(venusaur)
    expect(session.state.sides[1].party[0]!.abilities.innates).toEqual(venusaur)
  })
})

describe('cycle 144 - form change gate', () => {
  const baseInnates = innatesOf('SPECIES_VENUSAUR')
  const megaInnates = innatesOf('SPECIES_VENUSAUR_MEGA')

  function formChangeDeps(session: ReturnType<typeof playerSession>): FormChangeDeps {
    return {
      dataContext: data.dataContext,
      grounding: groundingFor(data, session.state),
      hazardTypes: {
        typeChart: data.typeChart,
        inverseTypeChart: data.inverseTypeChart,
        inverseBattle: false,
      },
    }
  }

  it('player Mega below the thresholds keeps only the ungated slots, and undo re-gates the base species', () => {
    const session = playerSession(10, 'hell', 'ITEM_VENUSAURITE')
    expect(megaEvolveBattler(session.state, 0, formChangeDeps(session), [])).toBe('SPECIES_VENUSAUR_MEGA')

    // Hell level 10 -> [t,f,f]; Mega Venusaur's slot 0 differs from base Venusaur's.
    const gatedMega = expectedInnates(megaInnates, [true, false, false])
    expect(gatedMega[0]).not.toBe(baseInnates[0])
    expect(session.state.battlers[0]!.mon.abilities.innates).toEqual(gatedMega)
    expect(session.state.sides[0].party[0]!.abilities.innates).toEqual(gatedMega)

    undoMegaEvolution(session.state, 0, 0, data.dataContext)
    expect(session.state.sides[0].party[0]!.speciesId).toBe('SPECIES_VENUSAUR')
    expect(session.state.sides[0].party[0]!.abilities.innates).toEqual(expectedInnates(baseInnates, [true, false, false]))
  })

  it('the same Mega on the opponent side keeps all three', () => {
    const session = createSession({
      data,
      playerParty: buildPlayerParty(
        [{ species: 'SPECIES_VENUSAUR', level: 10, moves: ['MOVE_TACKLE'] }],
        10,
        data,
      ),
      opponentTrainer: opponent(opponentMon('SPECIES_VENUSAUR', 'ITEM_VENUSAURITE')),
      tier: 'hell',
      rng: createRandomSource(1),
    })
    expect(megaEvolveBattler(session.state, 1, formChangeDeps(session), [])).toBe('SPECIES_VENUSAUR_MEGA')
    expect(session.state.battlers[1]!.mon.abilities.innates).toEqual(megaInnates)
  })
})

describe('cycle 144 - levelCapFor (levelCapsStrict)', () => {
  it('maps badges 0..9 to the strict table', () => {
    const table = [16, 23, 36, 45, 50, 55, 60, 70, 80, 100]
    table.forEach((cap, badges) => expect(levelCapFor(badges)).toBe(cap))
  })

  it('rejects out-of-range and non-integer input', () => {
    expect(() => levelCapFor(-1)).toThrow(RangeError)
    expect(() => levelCapFor(10)).toThrow(RangeError)
    expect(() => levelCapFor(1.5)).toThrow(RangeError)
  })

  it('gateInnates nulls the disabled slots', () => {
    expect(gateInnates(['A', 'B', 'C'], 10, 'hell')).toEqual(['A', null, null])
    expect(gateInnates(['A', 'B', 'C'], 5, 'ace')).toEqual(['A', 'B', 'C'])
  })
})
