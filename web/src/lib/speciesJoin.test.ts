// The join answers the same question as running searchSpecies over every species, so
// the tests that matter are equality tests against exactly that -- on a species subset
// small enough to compute the ground truth directly.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildAbilityGroups,
  buildCondition,
  buildSpeciesEntry,
  contextFromGroups,
  evaluateSpeciesAtPid,
  searchSpecies,
  type AcceptSetOptions,
  type SpeciesEntry,
} from './randomizer'
import { canJoin, joinSearchSpecies } from './speciesJoin'
import type { Ability, Meta, Species } from './types'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', 'data', 'v2.65beta')
const load = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf-8')) as T

const abilities = load<Ability[]>('abilities.json')
const species = load<Species[]>('species.json')
const meta = load<Meta>('meta.json')
const groups = buildAbilityGroups(abilities, meta.abilitiesCount)
const ctx = contextFromGroups(groups)
const MODES = { abilityRandomized: true, innateRandomized: true }
const ALL_OFF: AcceptSetOptions = { compounds: false, exactGroups: false, curatedGroups: false }

const abilityNum = (name: string) => abilities.find((a) => a.name === name)!.abilityNum
const speciesById = new Map(species.map((s) => [s.id, s]))
const entryOf = (id: string) => buildSpeciesEntry(speciesById.get(id)!, groups)

const SUBSET = ['SPECIES_BLISSEY_REDUX', 'SPECIES_PIKACHU', 'SPECIES_GARDEVOIR'].map(entryOf)
const conditionsFor = (names: string[]) => names.map((n) => buildCondition(abilityNum(n), groups, ALL_OFF))

function groundTruth(entries: SpeciesEntry[], names: string[]) {
  const conditions = conditionsFor(names)
  let total = 0
  const bySlotCost = new Map<number, number>()
  const matched = new Set<number>()
  for (const entry of entries) {
    const r = searchSpecies(entry, conditions, ctx, MODES)
    if (r.kind !== 'complete') throw new Error('unexpected trivial-all-match in fixture')
    total += r.total
    if (r.total > 0) matched.add(entry.num)
    for (const [cost, count] of r.bySlotCost) bySlotCost.set(cost, (bySlotCost.get(cost) ?? 0) + count)
  }
  return { total, bySlotCost, matched }
}

describe('canJoin', () => {
  it('needs at least two locked abilities', () => {
    expect(canJoin(conditionsFor(['Coil Up']), ctx, MODES)).toBe(false)
    expect(canJoin(conditionsFor(['Coil Up', 'Neuroforce']), ctx, MODES)).toBe(true)
  })

  it('declines when a randomizer mode is off -- every slot of that class is then a\n     PID-independent constant, which constrains no seed', () => {
    const conditions = conditionsFor(['Coil Up', 'Neuroforce'])
    expect(canJoin(conditions, ctx, { abilityRandomized: false, innateRandomized: true })).toBe(false)
    expect(canJoin(conditions, ctx, { abilityRandomized: true, innateRandomized: false })).toBe(false)
  })

  it('declines a banned locked ability -- it can only ever appear as a fixed slot', () => {
    const wonderGuard = abilities.find((a) => a.randomizerBanned && a.abilityNum !== 0)!
    const conditions = [
      buildCondition(abilityNum('Coil Up'), groups, ALL_OFF),
      buildCondition(wonderGuard.abilityNum, groups, ALL_OFF),
    ]
    expect(canJoin(conditions, ctx, MODES)).toBe(false)
  })
})

describe('join agrees with the per-species search', () => {
  it('three locks: same total, same slot-cost breakdown, same species', () => {
    const names = ['Coil Up', 'Neuroforce', 'Air Lock']
    const truth = groundTruth(SUBSET, names)
    const result = joinSearchSpecies(SUBSET, conditionsFor(names), ctx, MODES)

    expect(result.exact).toBe(true)
    expect(result.coverage).toBe(1)
    expect(result.total).toBe(truth.total)
    expect(result.total).toBeGreaterThan(0)
    expect([...result.bySlotCost.entries()].sort()).toEqual([...truth.bySlotCost.entries()].sort())
    expect([...result.matchedSpecies].sort()).toEqual([...truth.matched].sort())
  }, 300000)

  it('two locks: same total -- the case where one PID is reachable through several\n     source slots, so the canonical-assignment rule is what stops double counting', () => {
    const names = ['Coil Up', 'Neuroforce']
    const truth = groundTruth(SUBSET, names)
    const result = joinSearchSpecies(SUBSET, conditionsFor(names), ctx, MODES)

    expect(result.exact).toBe(true)
    expect(result.total).toBe(truth.total)
  }, 300000)

  it('every reported match is real, and the golden in-game PID is among them', () => {
    const names = ['Coil Up', 'Neuroforce', 'Air Lock']
    const conditions = conditionsFor(names)
    const result = joinSearchSpecies(SUBSET, conditions, ctx, MODES, { reservoirSize: 200_000 })

    const bySpecies = new Map(SUBSET.map((e) => [e.num, e]))
    for (const m of [...result.promoted, ...result.sample]) {
      const entry = bySpecies.get(m.speciesNum)!
      const check = evaluateSpeciesAtPid(entry, m.pid, conditions, ctx, MODES)
      expect(check).not.toBeNull()
      expect(check!.slotCost).toBe(m.slotCost)
    }

    const blissey = SUBSET[0].num
    expect(result.sample.some((m) => m.speciesNum === blissey && m.pid === 0xdbe0ca02)).toBe(true)
  }, 300000)

  it('a budgeted run estimates the same total from a fraction of the seed space', () => {
    const names = ['Coil Up', 'Neuroforce']
    const truth = groundTruth(SUBSET, names)
    const result = joinSearchSpecies(SUBSET, conditionsFor(names), ctx, MODES, { budget: 60_000 })

    expect(result.exact).toBe(false)
    expect(result.coverage).toBeLessThan(1)
    // Buckets partition the seed space and are visited in random order, so this is a
    // uniform sample -- generous bounds, since the point is that it is unbiased, not
    // that a small sample is precise.
    expect(result.total).toBeGreaterThan(truth.total * 0.5)
    expect(result.total).toBeLessThan(truth.total * 1.5)
  }, 300000)
})
