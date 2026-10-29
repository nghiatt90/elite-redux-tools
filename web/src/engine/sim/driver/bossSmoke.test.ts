import { describe, expect, it } from 'vitest'
import { createRandomSource } from '../rng'
import { loadBossTrainerIds, parseBossTrainerIds } from './bossSet'
import { buildPlayerParty } from './buildParty'
import { GENERIC_PLAYER_SPECS } from './genericTeam'
import { loadSimData } from './loadSimData'
import { runBattle } from './runBattle'

describe('bossSet', () => {
  it('parses synthetic markdown between headings, deduplicating, dropping, and expanding Space Center grunts', () => {
    const md = [
      '# Header',
      'Before heading: TRAINER_OUTSIDE_BEFORE',
      '## The fights, resolved to trainer ids',
      'Intro mentions TRAINER_CLASS_TEAM_MAGMA and TRAINER_MAY_ROUTE_103_TORCHIC.',
      '| Fight | Trainer id |',
      '| Rival | TRAINER_MAY_ROUTE_103_TORCHIC |',
      'Excluded: TRAINER_MAY_LILYCOVE_TORCHIC and partner TRAINER_STEVEN_MOSSDEEP.',
      '| Space Center | TRAINER_GRUNT_SPACE_CENTER_5/6/7 |',
      '| Roxanne | TRAINER_ROXANNE_1 |',
      '## Unresolved',
      'After heading: TRAINER_OUTSIDE_AFTER and TRAINER_MAY_LILYCOVE_TORCHIC',
    ].join('\n')

    expect(parseBossTrainerIds(md)).toEqual([
      'TRAINER_MAY_ROUTE_103_TORCHIC',
      'TRAINER_GRUNT_SPACE_CENTER_5',
      'TRAINER_GRUNT_SPACE_CENTER_6',
      'TRAINER_GRUNT_SPACE_CENTER_7',
      'TRAINER_ROXANNE_1',
    ])
  })

  it('loads the 55 boss trainer ids and 285 elite party slots from coverage doc', () => {
    const trainerIds = loadBossTrainerIds()
    expect(trainerIds).toHaveLength(55)
    expect(trainerIds).not.toContain('TRAINER_MAY_LILYCOVE_TORCHIC')
    expect(trainerIds).not.toContain('TRAINER_STEVEN_MOSSDEEP')
    expect(trainerIds).not.toContain('TRAINER_CLASS_TEAM_MAGMA')
    expect(trainerIds).toContain('TRAINER_GRUNT_SPACE_CENTER_6')
    expect(trainerIds).toContain('TRAINER_GRUNT_SPACE_CENTER_7')

    const data = loadSimData()
    let eliteSlots = 0
    for (const id of trainerIds) {
      const trainer = data.trainersById.get(id)
      expect(trainer, `missing trainer ${id}`).toBeDefined()
      eliteSlots += trainer!.parties.elite.length
    }
    expect(eliteSlots).toBe(285)
  })
})

describe.skipIf(process.env.SIM_SMOKE !== '1')('Simulation smoke run over 55 boss trainers', () => {
  it('runs boss fights and tallies unmodelled mechanics', { timeout: 900_000 }, () => {
    const data = loadSimData()
    const playerParty = buildPlayerParty(GENERIC_PLAYER_SPECS, 50, data)
    const trainerIds = loadBossTrainerIds()

    expect(trainerIds).toHaveLength(55)

    let eliteSlots = 0
    for (const id of trainerIds) {
      const trainer = data.trainersById.get(id)
      expect(trainer, `missing trainer ${id}`).toBeDefined()
      eliteSlots += trainer!.parties.elite.length
    }
    expect(eliteSlots).toBe(285)

    const seeds = [1, 2, 3]
    let fightsRun = 0
    let megaEvolutionsTotal = 0
    const threwList: Array<{ trainerId: string; seed: number; error: string }> = []
    const outcomeCounts: Record<string, number> = {
      WON: 0,
      LOST: 0,
      DREW: 0,
      MAX_TURNS: 0,
      ERROR: 0,
    }
    const globalUnmodelled = new Map<string, number>()

    for (const trainerId of trainerIds) {
      const trainer = data.trainersById.get(trainerId)!
      for (const seed of seeds) {
        fightsRun++
        const rng = createRandomSource(seed)
        const result = runBattle({
          data,
          playerParty,
          opponentTrainer: trainer,
          tier: 'elite',
          rng,
          maxTurns: 60,
        })
        megaEvolutionsTotal += result.megaEvolutions

        if (result.error) {
          threwList.push({ trainerId, seed, error: result.error })
          outcomeCounts.ERROR = (outcomeCounts.ERROR ?? 0) + 1
        } else {
          const outcomeKey = String(result.outcome)
          outcomeCounts[outcomeKey] = (outcomeCounts[outcomeKey] ?? 0) + 1
        }

        for (const [note, count] of result.unmodelled) {
          globalUnmodelled.set(note, (globalUnmodelled.get(note) ?? 0) + count)
        }
      }
    }

    const topN = Number(process.env.SMOKE_TOP) || 60

    console.log('\n' + '='.repeat(80))
    console.log('SIMULATION SMOKE RUN REPORT (ELITE TIER)')
    console.log('='.repeat(80))
    console.log(`Trainer IDs found: ${trainerIds.length}`)
    console.log(`Fights run: ${fightsRun}`)
    console.log(`Fights threw: ${threwList.length}`)
    console.log(`Mega evolutions / primal reversions-by-turn-action: ${megaEvolutionsTotal}`)
    console.log('\nOutcome counts:')
    for (const [outcome, count] of Object.entries(outcomeCounts)) {
      console.log(`  ${outcome.padEnd(12)}: ${count}`)
    }

    if (threwList.length > 0) {
      console.log('\nFights that threw:')
      for (const t of threwList) {
        console.log(`  [${t.trainerId} | seed ${t.seed}]: ${t.error}`)
      }
    }

    console.log(`\nTop ${topN} unmodelled strings by frequency:`)
    console.log('-'.repeat(80))
    const sortedUnmodelled = Array.from(globalUnmodelled.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)

    console.log(`${'Rank'.padEnd(6)}${'Count'.padEnd(8)}Unmodelled Note`)
    console.log('-'.repeat(80))
    sortedUnmodelled.forEach(([note, count], idx) => {
      console.log(`${String(idx + 1).padEnd(6)}${String(count).padEnd(8)}${note}`)
    })
    console.log('='.repeat(80) + '\n')

    expect(fightsRun).toBe(55 * seeds.length)
  })
})
