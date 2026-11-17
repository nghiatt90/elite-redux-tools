/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import { createRandomSource } from '../rng'
import type { BattleState } from '../state'
import { buildPlayerParty, type PlayerMonSpec } from './buildParty'
import { playExpectimaxBattle } from './expectimax'
import { loadSimData } from './loadSimData'
import { defaultPlayerPolicy, runBattle } from './runBattle'
import { createSession } from './session'

const data = loadSimData()

// TRAINER_MAY_ROUTE_103_TORCHIC (elite) is the small two-mon fight the driver test
// already uses: Mudkip (Aqua Tail / Rock Throw / Life Dew / Bulk Up) then Goomy
// (Hidden Power / Mega Drain / Water Pulse / Protect). A Garchomp lead outspeeds
// and KOs it; neither foe's Water/Grass damage comes close to Garchomp's HP.
const WEAK_FIGHT = 'TRAINER_MAY_ROUTE_103_TORCHIC'
// TRAINER_WATTSON_1's elite lead is Tapu Koko with Life Orb and three attacks.
const STRONG_FIGHT = 'TRAINER_WATTSON_1'

const GARCHOMP: PlayerMonSpec = {
  species: 'SPECIES_GARCHOMP',
  level: 50,
  nature: 'NATURE_JOLLY',
  evs: { atk: 252, spe: 252, hp: 4 },
  moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
}

const BLISSEY: PlayerMonSpec = {
  species: 'SPECIES_BLISSEY',
  level: 50,
  nature: 'NATURE_BOLD',
  evs: { hp: 252, def: 252, spdef: 4 },
  moves: ['MOVE_SEISMIC_TOSS', 'MOVE_SOFT_BOILED', 'MOVE_TOXIC', 'MOVE_THUNDER_WAVE'],
}

const MAGIKARP: PlayerMonSpec = {
  species: 'SPECIES_MAGIKARP',
  level: 50,
  nature: 'NATURE_HARDY',
  moves: ['MOVE_TACKLE'],
}

const trainer = (id: string) => data.trainersById.get(id)!

const session = (playerParty: ReturnType<typeof buildPlayerParty>, leadIndex?: number) =>
  createSession({
    data,
    playerParty,
    opponentTrainer: trainer(WEAK_FIGHT),
    rng: createRandomSource(5),
    leadIndex,
  })

describe('cycle d3-1: leadIndex and finalParty', () => {
  it('no leadIndex is bit-identical to leadIndex 0', { timeout: 120_000 }, () => {
    const party = buildPlayerParty([GARCHOMP], 50, data)
    const base = { data, playerParty: party, opponentTrainer: trainer(WEAK_FIGHT), seed: 11 }

    const exDefault = playExpectimaxBattle(base)
    const exZero = playExpectimaxBattle({ ...base, leadIndex: 0 })
    expect(exDefault.turns).toBeGreaterThan(0)
    expect(exZero.turns).toBeGreaterThan(0)
    expect(exDefault.outcome).toBe(exZero.outcome)
    expect(exDefault.turns).toBe(exZero.turns)
    expect(exDefault.finalScore).toBe(exZero.finalScore)
    expect(exDefault.finalParty).toEqual(exZero.finalParty)

    const runDefault = runBattle({ data, playerParty: party, opponentTrainer: trainer(WEAK_FIGHT), rng: createRandomSource(11) })
    const runZero = runBattle({ data, playerParty: party, opponentTrainer: trainer(WEAK_FIGHT), rng: createRandomSource(11), leadIndex: 0 })
    expect(runDefault.error).toBeUndefined()
    expect(runDefault.turns).toBeGreaterThan(0)
    expect(runDefault.outcome).toBe(runZero.outcome)
    expect(runDefault.turns).toBe(runZero.turns)
    expect(runDefault.finalParty).toEqual(runZero.finalParty)
  })

  it('finalParty is a deep copy of the end-state party and leaves a benched mon alone', () => {
    const party = buildPlayerParty([GARCHOMP, BLISSEY], 50, data)
    let lastState: BattleState | null = null
    const result = runBattle({
      data,
      playerParty: party,
      opponentTrainer: trainer(WEAK_FIGHT),
      rng: createRandomSource(21),
      maxTurns: 3,
      playerPolicy: (state) => {
        lastState = state
        return defaultPlayerPolicy(state, data)
      },
    })
    expect(result.error).toBeUndefined()
    expect(result.finalParty).toBeDefined()
    expect(result.finalParty).toHaveLength(party.length)
    expect(lastState).not.toBeNull()
    expect(result.finalParty).toEqual(lastState!.sides[0].party)

    const before = JSON.stringify(lastState!.sides[0].party)
    result.finalParty![0].hp = 1234
    result.finalParty![0].moves[0] = 'MOVE_SPLASH'
    result.finalParty![1].abilities.innates[0] = null
    expect(JSON.stringify(lastState!.sides[0].party)).toBe(before)

    // The lead never left the field, so the bench slot's HP must be its input HP.
    expect(lastState!.battlers[0]!.partyIndex).toBe(0)
    expect(result.finalParty![1].hp).toBe(party[1].hp)
  })

  it('a party mon that fainted in the battle ends at hp 0', () => {
    const party = buildPlayerParty([MAGIKARP], 50, data)
    const result = runBattle({
      data,
      playerParty: party,
      opponentTrainer: trainer(STRONG_FIGHT),
      rng: createRandomSource(3),
      maxTurns: 20,
    })
    expect(result.error).toBeUndefined()
    expect(result.outcome).toBe('LOST')
    expect(result.finalParty![0].hp).toBe(0)
  })

  it('leadIndex 1 sends party slot 1 out and leaves slot 0 in the party', () => {
    const party = buildPlayerParty([GARCHOMP, BLISSEY], 50, data)
    const s = session(party, 1)
    expect(s.state.battlers[0]!.partyIndex).toBe(1)
    expect(s.state.battlers[0]!.mon.speciesId).toBe(party[1].speciesId)
    expect(s.state.sides[0].party[0].speciesId).toBe(party[0].speciesId)
    expect(s.state.sides[0].party[0].hp).toBe(party[0].hp)
  })

  it('rejects an out-of-range or fainted lead, and undefined behaves as 0', () => {
    const party = buildPlayerParty([GARCHOMP, BLISSEY], 50, data)
    expect(() => session(party, party.length)).toThrow()
    expect(() => session(party, -1)).toThrow()

    const fainted = buildPlayerParty([GARCHOMP, BLISSEY], 50, data)
    fainted[1].hp = 0
    expect(() => session(fainted, 1)).toThrow()

    expect(session(party, undefined).state.battlers[0]!.partyIndex).toBe(0)
  })
})
