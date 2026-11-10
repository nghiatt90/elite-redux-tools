/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
import { describe, expect, it } from 'vitest'
import { buildPlayerParty } from './driver/buildParty'
import {
  DIFFICULTY_FLAG_SPECS,
  classifyToken,
  loadEngineProductionFiles,
  loadEngineTestFiles,
  runInventory,
} from './driver/environmentInventory'
import { loadSimData } from './driver/loadSimData'
import { createSession } from './driver/session'
import { createRandomSource } from './rng'

const data = loadSimData()
const productionFiles = loadEngineProductionFiles()
const testFiles = loadEngineTestFiles()

const SPECS = [
  {
    species: 'SPECIES_TYRANITAR',
    level: 50,
    nature: 'NATURE_ADAMANT',
    evs: { hp: 252, atk: 252, spdef: 4 },
    ability: 'ABILITY_SAND_STREAM',
    item: 'ITEM_SMOOTH_ROCK',
    moves: ['MOVE_STONE_EDGE', 'MOVE_CRUNCH', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH'],
  },
]

describe('cycle 154 environment units', () => {
  it('gameDifficulty: createSession builds the requested difficulty tier (battle_main.c:1735)', () => {
    const trainer = data.trainersById.get('TRAINER_GRUNT_AQUA_HIDEOUT_1')!
    const parties = trainer.parties!

    // Two real tiers with different leads, so the assertion cannot pass by accident.
    expect(parties.ace?.[0].species).toBe('SPECIES_MIGHTYENA')
    expect(parties.elite?.[0].species).toBe('SPECIES_SKULBERUS')

    const aceSession = createSession({
      data,
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentTrainer: trainer,
      tier: 'ace',
      rng: createRandomSource(1),
    })
    const eliteSession = createSession({
      data,
      playerParty: buildPlayerParty(SPECS, 50, data),
      opponentTrainer: trainer,
      tier: 'elite',
      rng: createRandomSource(1),
    })

    expect(aceSession.state.sides[1].party[0].speciesId).toBe('SPECIES_MIGHTYENA')
    expect(eliteSession.state.sides[1].party[0].speciesId).toBe('SPECIES_SKULBERUS')
    expect(aceSession.state.tier).toBe('ace')
    expect(eliteSession.state.tier).toBe('elite')
  })

  it('gameDifficulty is ported through the buildParty.ts tier read', () => {
    const unit = runInventory().units.find(
      (candidate) => candidate.kind === 'difficulty-flag' && candidate.key === 'gameDifficulty',
    )
    expect(unit).toBeDefined()
    expect(unit?.status).toBe('ported')
    expect(unit?.token).toBe('parties')
    expect(unit?.productionEvidence?.startsWith('web/src/engine/sim/driver/buildParty.ts:')).toBe(
      true,
    )
    expect(unit?.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_main.c:1735')
  })

  it('gameDifficulty flips to unported when the parties?.[tier] read is deleted', () => {
    const spec = DIFFICULTY_FLAG_SPECS.find((candidate) => candidate.key === 'gameDifficulty')
    expect(spec).toBeDefined()
    if (!spec) return

    const mutatedFiles = productionFiles.map((file) => {
      if (!file.file.endsWith('web/src/engine/sim/driver/buildParty.ts')) return file
      const source = file.source.replace(/parties\?\.\[tier\]/g, 'parties?.ace')
      expect(source).not.toBe(file.source)
      return { file: file.file, source }
    })

    const mutated = classifyToken(spec.token, mutatedFiles, testFiles, spec.evidence)
    expect(mutated.status).toBe('unported')
  })
})
