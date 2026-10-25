// Smoke test over boss fights (plan step 3).
// Runs trainer IDs parsed from docs/battle-sim/boss-fight-coverage.md lines 57-250
// at elite tier against a fixed generic player team across multiple seeds.
// Skipped unless SIM_SMOKE === '1'.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRandomSource } from '../rng'
import { loadSimData } from './loadSimData'
import { buildPlayerParty, type PlayerMonSpec } from './buildParty'
import { runBattle } from './runBattle'

/**
 * Fixed generic player team: six level-matched (Lv 50) Pokemon chosen from the data:
 * 1. Swampert (SPECIES_SWAMPERT): bulky physical water/ground attacker (Leftovers, Torrent).
 * 2. Garchomp (SPECIES_GARCHOMP): fast physical dragon/ground sweeper (Life Orb, Rough Skin).
 * 3. Scizor (SPECIES_SCIZOR): physical bug/steel priority pivot (Metal Coat, Technician).
 * 4. Gengar (SPECIES_GENGAR): fast special ghost/poison sweeper (Focus Sash, Levitate).
 * 5. Tyranitar (SPECIES_TYRANITAR): rock/dark tank with weather setter (Smooth Rock, Sand Stream).
 * 6. Blissey (SPECIES_BLISSEY): normal special wall and cleric (Heavy-Duty Boots, Natural Cure).
 */
const GENERIC_PLAYER_SPECS: PlayerMonSpec[] = [
  {
    species: 'SPECIES_SWAMPERT',
    level: 50,
    nature: 'NATURE_ADAMANT',
    evs: { hp: 252, atk: 252, spe: 4 },
    ability: 'ABILITY_TORRENT',
    item: 'ITEM_LEFTOVERS',
    moves: ['MOVE_WATERFALL', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH', 'MOVE_ROCK_SLIDE'],
  },
  {
    species: 'SPECIES_GARCHOMP',
    level: 50,
    nature: 'NATURE_JOLLY',
    evs: { atk: 252, spe: 252, hp: 4 },
    ability: 'ABILITY_ROUGH_SKIN',
    item: 'ITEM_LIFE_ORB',
    moves: ['MOVE_DRAGON_CLAW', 'MOVE_EARTHQUAKE', 'MOVE_POISON_JAB', 'MOVE_SWORDS_DANCE'],
  },
  {
    species: 'SPECIES_SCIZOR',
    level: 50,
    nature: 'NATURE_ADAMANT',
    evs: { hp: 252, atk: 252, def: 4 },
    ability: 'ABILITY_TECHNICIAN',
    item: 'ITEM_METAL_COAT',
    moves: ['MOVE_BULLET_PUNCH', 'MOVE_BUG_BITE', 'MOVE_SWORDS_DANCE', 'MOVE_ROOST'],
  },
  {
    species: 'SPECIES_GENGAR',
    level: 50,
    nature: 'NATURE_TIMID',
    evs: { spatk: 252, spe: 252, hp: 4 },
    ability: 'ABILITY_LEVITATE',
    item: 'ITEM_FOCUS_SASH',
    moves: ['MOVE_SHADOW_BALL', 'MOVE_SLUDGE_BOMB', 'MOVE_THUNDERBOLT', 'MOVE_FOCUS_BLAST'],
  },
  {
    species: 'SPECIES_TYRANITAR',
    level: 50,
    nature: 'NATURE_ADAMANT',
    evs: { hp: 252, atk: 252, spdef: 4 },
    ability: 'ABILITY_SAND_STREAM',
    item: 'ITEM_SMOOTH_ROCK',
    moves: ['MOVE_STONE_EDGE', 'MOVE_CRUNCH', 'MOVE_EARTHQUAKE', 'MOVE_ICE_PUNCH'],
  },
  {
    species: 'SPECIES_BLISSEY',
    level: 50,
    nature: 'NATURE_BOLD',
    evs: { hp: 252, def: 252, spdef: 4 },
    ability: 'ABILITY_NATURAL_CURE',
    item: 'ITEM_HEAVY_DUTY_BOOTS',
    moves: ['MOVE_SEISMIC_TOSS', 'MOVE_SOFT_BOILED', 'MOVE_TOXIC', 'MOVE_THUNDER_WAVE'],
  },
]

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
