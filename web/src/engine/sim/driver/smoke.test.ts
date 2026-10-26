// Smoke test over boss fights (plan step 3).
// Runs trainer IDs parsed from docs/battle-sim/boss-fight-coverage.md lines 57-250
// at elite tier against a fixed generic player team across multiple seeds.
// Skipped unless SIM_SMOKE === '1'.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRandomSource } from '../rng'
import { loadSimData } from './loadSimData'
import { buildPlayerParty } from './buildParty'
import { GENERIC_PLAYER_SPECS } from './genericTeam'
import { runBattle } from './runBattle'

describe.skipIf(process.env.SIM_SMOKE !== '1')('Simulation smoke run over boss fights', () => {
  it('runs boss fights and tallies unmodelled mechanics', { timeout: 900_000 }, () => {
    const data = loadSimData()
    const playerParty = buildPlayerParty(GENERIC_PLAYER_SPECS, 50, data)

    const coveragePath = resolve(import.meta.dirname, '../../../../../docs/battle-sim/boss-fight-coverage.md')
    const fullContent = readFileSync(coveragePath, 'utf8')
    const coverageLines = fullContent.split('\n').slice(56, 250).join('\n')

    const regex = /TRAINER_[A-Z0-9_]+/g
    const matches = coverageLines.matchAll(regex)
    const seenIds = new Set<string>()
    const trainerIds: string[] = []

    for (const match of matches) {
      const id = match[0]
      if (!seenIds.has(id)) {
        seenIds.add(id)
        if (data.trainersById.has(id)) {
          trainerIds.push(id)
        }
      }
    }

    expect(trainerIds.length).toBeGreaterThan(0)

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

    console.log('\nTop 60 unmodelled strings by frequency:')
    console.log('-'.repeat(80))
    const sortedUnmodelled = Array.from(globalUnmodelled.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)

    console.log(`${'Rank'.padEnd(6)}${'Count'.padEnd(8)}Unmodelled Note`)
    console.log('-'.repeat(80))
    sortedUnmodelled.forEach(([note, count], idx) => {
      console.log(`${String(idx + 1).padEnd(6)}${String(count).padEnd(8)}${note}`)
    })
    console.log('='.repeat(80) + '\n')

    expect(fightsRun).toBe(trainerIds.length * seeds.length)
  })
})
