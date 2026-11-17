/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// Cycle d5-2: the player level cap in the party builder and its first production caller.
//
// Hand-derived from the C at the pinned SHA
// (pipeline/.upstream/eliteredux-source):
//   - src/pokemon.c:4633-4647 getHighestBadge() returns the highest
//     FLAG_BADGE0x_GET held (9 for FLAG_SYS_GAME_CLEAR, 0 for none) -- NOT a badge count.
//   - src/pokemon.c:4649-4671 GetLevelCap():
//       static const u8 levelCapsStrict[] = {16, 23, 36, 45, 50, 55, 60, 70, 80, 100}; // Elite
//     indexed by that number.
//   - src/battle_main.c:1819-1827: an opponent mon's level is
//     GetHighestLevelInPlayerParty() + partyData[i].lvl + extraLevels, so it
//     follows the player's level; the tier change below therefore does not move it.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createRandomSource } from './rng'
import { buildMoveAction, createSession, stepTurn } from './driver/session'
import { buildPlayerParty } from './driver/buildParty'
import { levelCapForTrainer, type FightRow } from './driver/fights'
import { loadSimData, type TrainerData, type TrainerMonData } from './driver/loadSimData'

const data = loadSimData()

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

const tackleSpec = { species: 'SPECIES_VENUSAUR', moves: ['MOVE_TACKLE'] }

describe('cycle d5-2 - buildPlayerParty level cap', () => {
  it('defaults a level-less spec to the cap, not to defaultLevel', () => {
    const atCap = buildPlayerParty([tackleSpec], 50, data, { levelCap: 16 })
    const explicit16 = buildPlayerParty([{ ...tackleSpec, level: 16 }], 50, data)
    const default50 = buildPlayerParty([tackleSpec], 50, data)

    expect(atCap[0]!.level).toBe(16)
    expect(atCap[0]!.maxHp).toBe(explicit16[0]!.maxHp)
    expect(atCap[0]!.maxHp).not.toBe(default50[0]!.maxHp)
    // No options is exactly the old behaviour: defaultLevel applies and nothing throws.
    expect(default50[0]!.level).toBe(50)
  })

  it('keeps a level below the cap as given', () => {
    const party = buildPlayerParty([{ ...tackleSpec, level: 10 }], 50, data, { levelCap: 16 })
    expect(party[0]!.level).toBe(10)
  })

  it('accepts the cap exactly and throws above it (no clamping)', () => {
    const atCap = buildPlayerParty([{ ...tackleSpec, level: 16 }], 50, data, { levelCap: 16 })
    expect(atCap[0]!.level).toBe(16)

    expect(() => buildPlayerParty([{ ...tackleSpec, level: 17 }], 50, data, { levelCap: 16 })).toThrow(
      /SPECIES_VENUSAUR/,
    )
  })

  it('ignoreCap builds over the cap at the spec level', () => {
    const party = buildPlayerParty([{ ...tackleSpec, level: 17 }], 50, data, {
      levelCap: 16,
      ignoreCap: true,
    })
    expect(party[0]!.level).toBe(17)
  })

  it('ignoreCap without a levelCap changes nothing', () => {
    const party = buildPlayerParty([tackleSpec], 50, data, { ignoreCap: true })
    expect(party[0]!.level).toBe(50)
  })
})

/** Narrows a lookup result to a placed row, failing the test on the tagged/absent outcomes. */
function placed(trainerId: string): { cap: number; row: FightRow; evidence: string } {
  const found = levelCapForTrainer(trainerId)
  if (!found || 'awaiting' in found) {
    throw new Error(`expected a placed row for ${trainerId}`)
  }
  return found
}

describe('cycle d5-2 - levelCapForTrainer', () => {
  it('finds a row by any trainer id, not just fightId', () => {
    // Juan's row (fightId TRAINER_JUAN_1) also lists TRAINER_WALLACE.
    // requiredBefore [1, 2, 3, 4, 5, 7] -> highest required gym 7
    // -> levelCapsStrict[7] = 70 (src/pokemon.c:4661:
    // {16, 23, 36, 45, 50, 55, 60, 70, 80, 100}).
    const found = placed('TRAINER_WALLACE')
    expect(found.cap).toBe(70)
    expect(found.row.fightId).toBe('TRAINER_JUAN_1')
  })

  it('returns the { cap, row, evidence } shape', () => {
    // TRAINER_GRUNT_PETALBURG_WOODS: requiredBefore [] -> badge 0
    // -> levelCapsStrict[0] = 16.
    const found = placed('TRAINER_GRUNT_PETALBURG_WOODS')
    expect(found.cap).toBe(16)
    expect(found.row.fightId).toBe('TRAINER_GRUNT_PETALBURG_WOODS')
    expect(found.evidence).toBe(found.row.evidence)
    expect(found.evidence.length).toBeGreaterThan(0)
  })

  it('returns undefined (not a throw) for a trainer id in no row', () => {
    expect(levelCapForTrainer('TRAINER_NOT_A_FIGHT')).toBeUndefined()
  })

  it('feeds the cap into the builder default level', () => {
    // TRAINER_MAY_ROUTE_110_TORCHIC: requiredBefore [1] -> badge 1 -> 23.
    const cap = placed('TRAINER_MAY_ROUTE_110_TORCHIC').cap
    expect(cap).toBe(23)
    const party = buildPlayerParty([tackleSpec], 50, data, { levelCap: cap })
    expect(party[0]!.level).toBe(23)
  })
})

interface AbilityHookEntry {
  hooks?: Record<string, { form?: string; source?: string }>
}

describe('cycle d5-2 - Elite versus Ace at the same level isolate the innate gate', () => {
  it('gates slots 2 and 3 at level 16 under Elite but not Ace', () => {
    const elite = playerSession(16, 'elite')
    const ace = playerSession(16, 'ace')
    expect(elite.state.battlers[0]!.mon.abilities.innates).not.toEqual(
      ace.state.battlers[0]!.mon.abilities.innates,
    )
  })

  const abilityHooks = JSON.parse(
    readFileSync(resolve(process.cwd(), '../data/v2.65beta/abilityHooks.json'), 'utf8'),
  ) as Record<string, AbilityHookEntry>

  // The scan asserts the rule rather than trusting memory of the dex: innate slots 2
  // and 3 (innates[1] / innates[2]) are both populated, and the slot-3 ability has an
  // onOffensiveMultiplier hook that boosts the Water move used below.
  const candidates = [...data.speciesById.values()]
    .filter((species) => {
      const innates = (species.innates ?? []) as (string | null)[]
      if (!innates[1] || !innates[2]) return false
      const hook = abilityHooks[innates[2]]?.hooks?.onOffensiveMultiplier
      const source = hook?.source ?? ''
      return source.includes('moveType == TYPE_WATER') && source.includes('MUL(')
    })
    .map((species) => species.id)
    .sort()

  function sessionAt(tier: 'ace' | 'elite', species: string) {
    return createSession({
      data,
      playerParty: buildPlayerParty([{ species, level: 16, moves: ['MOVE_BRINE'] }], 16, data),
      opponentTrainer: opponent(opponentMon('SPECIES_VENUSAUR')),
      tier,
      rng: createRandomSource(1),
    })
  }

  function opponentHpAfterBrine(tier: 'ace' | 'elite', species: string): number {
    const session = sessionAt(tier, species)
    stepTurn(session, buildMoveAction(session.state, data, 0, 'MOVE_BRINE'), null)
    return session.state.battlers[1]!.mon.hp
  }

  it('a scanned species deals different damage under Elite and Ace at level 16', () => {
    expect(candidates.length).toBeGreaterThan(0)
    const speciesId = candidates[0]!
    const innates = (data.speciesById.get(speciesId)!.innates ?? []) as (string | null)[]
    expect(innates[1]).not.toBeNull()
    expect(innates[2]).not.toBeNull()

    // The synthetic opponent's ace and elite parties are identical, so the only
    // difference between the two sessions is the player's innate gating.
    const trainer = opponent(opponentMon('SPECIES_VENUSAUR'))
    expect(trainer.parties.ace).toEqual(trainer.parties.elite)

    const eliteHp = opponentHpAfterBrine('elite', speciesId)
    const aceHp = opponentHpAfterBrine('ace', speciesId)
    expect(eliteHp).not.toBe(aceHp)
  })
})
