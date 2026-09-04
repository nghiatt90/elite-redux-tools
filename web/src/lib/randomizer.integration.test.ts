// Integration tests against the real committed data snapshot (data/v2.65beta/), not
// the synthetic table in randomizer.test.ts -- these catch mistakes the synthetic
// tests structurally can't, like an off-by-one in the real 1044 modulus or a curated
// group that doesn't actually resolve against real ability names.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildAbilityGroups,
  buildCondition,
  buildSpeciesEntry,
  contextFromGroups,
  searchSpecies,
  type AcceptSetOptions,
} from './randomizer'
import type { Ability, Meta, Species } from './types'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', 'data', 'v2.65beta')

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(DATA_DIR, name), 'utf-8')) as T
}

const abilities = loadJson<Ability[]>('abilities.json')
const species = loadJson<Species[]>('species.json')
const meta = loadJson<Meta>('meta.json')
const groups = buildAbilityGroups(abilities, meta.abilitiesCount)
const ctx = contextFromGroups(groups)
const MODES = { abilityRandomized: true, innateRandomized: true }
const ALL_OFF: AcceptSetOptions = { compounds: false, exactGroups: false, curatedGroups: false }
const ALL_ON: AcceptSetOptions = { compounds: true, exactGroups: true, curatedGroups: true }

const abilityNum = (name: string) => abilities.find((a) => a.name === name)!.abilityNum
const speciesById = new Map(species.map((s) => [s.id, s]))

describe('real data sanity', () => {
  it('abilitiesCount matches the modulus baked into meta.json', () => {
    expect(meta.abilitiesCount).toBe(1044)
  })

  it('Mold Breaker curated group only expands with the curated toggle on', () => {
    const moldBreaker = abilityNum('Mold Breaker')
    const teravolt = abilityNum('Teravolt')
    const on = buildCondition(moldBreaker, groups, ALL_ON).acceptSet
    const off = buildCondition(moldBreaker, groups, ALL_OFF).acceptSet
    expect(on[teravolt]).toBe(1)
    expect(off[teravolt]).toBe(0)
  })

  it('Filter exact group expands to its 6 siblings', () => {
    const filter = abilityNum('Filter')
    const set = buildCondition(filter, groups, ALL_ON).acceptSet
    for (const name of ['Solid Rock', 'Prism Armor', 'Permafrost', 'Thick Skin', 'Flame Shield']) {
      expect(set[abilityNum(name)]).toBe(1)
    }
  })
})

describe('real data match-count density', () => {
    // Table from the plan, singleton accept-sets, unbanned fixed target, all slots free:
    //   1 locked ability  -> ~25,000,000 expected matching PIDs
    // Pikachu's declared abilities/innates are all distinct real (non-banned) sources,
    // so this exercises the full up-to-6-source-slot generation path.
  it('one locked ability on a real species lands in the expected order of magnitude', () => {
    const pikachu = speciesById.get('SPECIES_PIKACHU')!
    const entry = buildSpeciesEntry(pikachu, groups)
    const target = abilityNum('Volt Absorb') // an ordinary, non-banned, group-free ability
    expect(groups.equivalenceGroupByNum.has(target)).toBe(false)
    expect(groups.nearEquivalentGroupByNum.has(target)).toBe(false)
    expect(groups.compoundsContainingByNum.has(target)).toBe(false)

    const result = searchSpecies(entry, [buildCondition(target, groups, ALL_OFF)], ctx, MODES)
    expect(result.kind).toBe('complete')
    if (result.kind !== 'complete') return

    // Order-of-magnitude check, not an exact match -- the plan's own table is an
    // approximation ("groups and compounds push these up, fixed slots push them
    // down"). This is the modulus/off-by-one smoke test: a wrong modulus would land
    // an order of magnitude off, not within a factor of 2-3.
    expect(result.total).toBeGreaterThan(5_000_000)
    expect(result.total).toBeLessThan(60_000_000)
  }, 30000)
})
