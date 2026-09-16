// Integration test against the real committed data snapshot, same shape as
// lib/randomizer.integration.test.ts -- catches a mistake the synthetic unit tests
// structurally can't: nothing anywhere else imports features/damageCalc/scenario.ts
// AND lib/matchupReport.ts together, and that composition (buildBattlerState ->
// toMoveData -> buildMatchupReport) is exactly what routes/TrainerMatchup.tsx
// depends on. Lives under features/, not lib/, because a test in lib/ importing
// scenario.ts (a features/ module) would invert the layering lib/matchupReport.ts
// itself was written to keep -- see that module's own doc.
//
// Honest limit: this is a headless composition test, not a rendered one, so it does
// NOT reach render-time properties. It would NOT have caught the review finding that
// routes/TrainerMatchup.tsx called useMemo after two conditional early returns --
// hook-ordering is a property of React's render cycle across multiple renders, which
// nothing here (or anywhere else in this project's test suite -- there are no
// `*.test.tsx` files at all) exercises.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBattlerState, defaultBattlerConfig, toMoveData } from '../damageCalc/scenario'
import { buildMatchupReport } from '../../lib/matchupReport'
import { buildFormIndex } from '../../lib/formResolution'
import type { BattleConstants, Encounters, Item, Move, MoveBehaviorsFile, Species, Trainer, TypeChart } from '../../lib/types'
import type { MoveBehaviors } from '../../engine/basePower'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'data', 'v2.65beta')
const load = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf-8')) as T

const species = load<Species[]>('species.json')
const items = load<Item[]>('items.json')
const moves = load<Move[]>('moves.json')
const natures = load<BattleConstants>('natures.json')
const typeChart = load<TypeChart>('types.json')
const inverseTypeChart = load<TypeChart>('typesInverse.json')
const moveBehaviorsFile = load<MoveBehaviorsFile>('moveBehaviors.json')
const trainers = load<Trainer[]>('trainers.json')
const encounters = load<Encounters>('encounters.json')

const speciesById = new Map(species.map((s) => [s.id, s]))
const itemsById = new Map(items.map((i) => [i.id, i]))
const movesById = new Map(moves.map((m) => [m.id, m]))

const ctx = {
  speciesById,
  itemsById,
  movesById,
  typeChart,
  inverseTypeChart,
  moveBehaviors: moveBehaviorsFile.behaviors as unknown as MoveBehaviors,
  natures,
  fieldEffects: encounters.fieldEffects,
  inverseBattles: encounters.inverseBattles,
  formIndex: buildFormIndex(species),
}

describe('features/matchupReport composition: scenario.ts -> lib/matchupReport.ts, the exact seam routes/TrainerMatchup.tsx depends on', () => {
  it('builds a full report end to end for a default-config player against a real trainer', () => {
    const playerConfig = defaultBattlerConfig('SPECIES_GARCHOMP')
    playerConfig.moveIds = ['MOVE_EARTHQUAKE', 'MOVE_DRAGON_CLAW', null, null]
    const battler = buildBattlerState(playerConfig, ctx)
    const playerMoves = playerConfig.moveIds.filter((id): id is string => id !== null).map((id) => toMoveData(ctx.movesById.get(id)!))

    const trainer = trainers.find((t) => t.id === 'TRAINER_SAWYER_1')!
    const report = buildMatchupReport({
      player: { speciesId: playerConfig.speciesId, battler, moves: playerMoves },
      trainer,
      tier: 'ace',
      playerHighestLevel: 100,
      ctx,
    })

    expect(report.mons.length).toBe(trainer.parties.ace.length)
    expect(report.speedTiers.length).toBe(trainer.parties.ace.length + 1)
    for (const mon of report.mons) {
      expect(mon.yourMoves.length).toBe(2)
      expect(mon.itsMoves.length).toBeGreaterThan(0)
    }

    // Dragon Claw into the Rock/Fairy Carbink is a real chart immunity (Fairy blocks
    // Dragon) -- a sanity check that the composed pipeline reaches the real type
    // chart, not a stub.
    const carbink = report.mons.find((m) => m.speciesId === 'SPECIES_CARBINK')!
    const dragonClaw = carbink.yourMoves.find((m) => m.moveId === 'MOVE_DRAGON_CLAW')!
    expect(dragonClaw.isImmune).toBe(true)
  })

  it('resolves an empty tier with the default player config against a trainer with no configured party', () => {
    const emptyTierTrainer = trainers.find((t) => t.parties.ace.length === 0 && t.parties.elite.length === 0 && t.parties.hell.length === 0)!
    const playerConfig = defaultBattlerConfig('SPECIES_GARCHOMP')
    const battler = buildBattlerState(playerConfig, ctx)

    const report = buildMatchupReport({
      player: { speciesId: playerConfig.speciesId, battler, moves: [] },
      trainer: emptyTierTrainer,
      tier: 'hell',
      playerHighestLevel: 100,
      ctx,
    })
    expect(report.mons).toEqual([])
  })
})
