// Integration tests against the real committed data snapshot (data/v2.65beta/), not
// the synthetic table in randomizer.test.ts -- these catch mistakes the synthetic
// tests structurally can't, like a curated group that doesn't actually resolve against
// real ability names, or the snapshot being built from a game build nobody plays.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildAbilityGroups,
  buildCondition,
  buildSpeciesEntry,
  contextFromGroups,
  evaluateSpeciesAtPid,
  randomizeOne,
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
  // The modulus is `abilitiesCount - 1`, and it is the entire randomizer -- being one
  // off doesn't skew results, it decorrelates them completely. It must describe the
  // build players actually run, not the tip of upstream's `upcoming` branch (which had
  // 1044 abilities and produced results matching no ROM in existence). The pipeline
  // asserts the same number against ER-nextdex's released-game data; see
  // sources.lock.json's pin_policy.
  it('abilitiesCount matches the released game, not upstream HEAD', () => {
    expect(meta.abilitiesCount).toBe(1034)
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
    // down"). NOTE this is *not* a modulus check, despite once being described as one:
    // the match count is ~2^32/modulus per source slot, so any plausible modulus lands
    // inside this band. Only the golden case below actually pins the modulus.
    expect(result.total).toBeGreaterThan(5_000_000)
    expect(result.total).toBeLessThan(60_000_000)
  }, 30000)
})

describe('a banned locked ability', () => {
  // Candidates are enumerated from one condition, and a banned ability is never rolled,
  // so a condition accepting only banned abilities can enumerate nothing. Ranking the
  // generating condition on raw accept-set size let such a condition (size 1, so it
  // always won) be chosen, which reported zero matches -- and only when the user
  // happened to list it first, making the result depend on lock order.
  const APE_SHIFT = 'Ape Shift' // banned, and declared by Slaking Mega
  const SLAKING_MEGA = 'SPECIES_SLAKING_MEGA'

  it('is order-independent when paired with a reachable one', () => {
    const entry = buildSpeciesEntry(speciesById.get(SLAKING_MEGA)!, groups)
    expect(abilities.find((a) => a.name === APE_SHIFT)!.randomizerBanned).toBe(true)

    const variable = entry.innateSources.find((s) => !ctx.bannedByNum[s])!
    const reachable = randomizeOne(variable, entry.num, 0x1234abcd, ctx, true)
    const banned = buildCondition(abilityNum(APE_SHIFT), groups, ALL_OFF)
    const normal = buildCondition(reachable, groups, ALL_OFF)

    const first = searchSpecies(entry, [banned, normal], ctx, MODES)
    const second = searchSpecies(entry, [normal, banned], ctx, MODES)
    expect(first.kind).toBe('complete')
    expect(second.kind).toBe('complete')
    if (first.kind !== 'complete' || second.kind !== 'complete') return

    expect(first.total).toBe(second.total)
    expect(first.total).toBeGreaterThan(0)
    // The species really does have that PID among its matches.
    expect(evaluateSpeciesAtPid(entry, 0x1234abcd, [banned, normal], ctx, MODES)).not.toBeNull()
  }, 60000)

  it('matches nothing on a species that does not declare it', () => {
    // Nothing can roll a banned ability, so only a species carrying it natively -- as an
    // untouched fixed slot -- can ever satisfy that lock.
    const entry = buildSpeciesEntry(speciesById.get('SPECIES_PIKACHU')!, groups)
    const conditions = [
      buildCondition(abilityNum(APE_SHIFT), groups, ALL_OFF),
      buildCondition(abilityNum('Volt Absorb'), groups, ALL_OFF),
    ]
    const result = searchSpecies(entry, conditions, ctx, MODES)
    expect(result.kind).toBe('complete')
    if (result.kind !== 'complete') return
    expect(result.total).toBe(0)
  }, 60000)
})

// The only test here anchored to the real ROM rather than to our own data snapshot.
// Everything else is self-consistent by construction and stayed green while the finder
// was returning PIDs for a game build that was never released; this case came from a
// player reading the spread off an actual save.
describe('golden case: observed in game', () => {
  const PID = 0xdbe0ca02
  const BLISSEY_REDUX = 'SPECIES_BLISSEY_REDUX'
  const OBSERVED_ABILITIES = ['Coil Up', 'Sand Fiend', 'Dancer']
  const OBSERVED_INNATES = ['Neuroforce', 'Air Lock', 'Pickpocket']

  const entry = () => buildSpeciesEntry(speciesById.get(BLISSEY_REDUX)!, groups)

  it('forward: rolls the exact spread seen on the cartridge', () => {
    const e = entry()
    const roll = (src: number) => randomizeOne(src, e.num, PID, ctx, true)
    expect(e.abilityOptions.map(roll)).toEqual(OBSERVED_ABILITIES.map(abilityNum))
    expect(e.innateSources.map(roll)).toEqual(OBSERVED_INNATES.map(abilityNum))
  })

  it('reverse: searching three of those abilities finds that PID', () => {
    const conditions = ['Coil Up', 'Neuroforce', 'Air Lock'].map((n) =>
      buildCondition(abilityNum(n), groups, ALL_OFF),
    )
    // Three locks land in the low hundreds of matches, so a reservoir this size holds
    // the complete solution set and containment is a real assertion, not a lucky draw.
    const result = searchSpecies(entry(), conditions, ctx, MODES, { reservoirSize: 100_000 })
    expect(result.kind).toBe('complete')
    if (result.kind !== 'complete') return
    expect(result.total).toBeLessThan(100_000)

    const hit = result.sample.find((m) => m.pid === PID)
    expect(hit).toBeDefined()
    // A match carries the *whole* in-game ability picker, not just the slot it needed
    // -- the UI shows all three so you can see what you'd be giving up by picking the
    // matching one.
    expect(hit!.abilityResults).toEqual(OBSERVED_ABILITIES.map(abilityNum))
    expect(hit!.abilityResults[hit!.abilityNum]).toBe(hit!.resultAbilities[0])
    expect(hit!.resultAbilities.slice(1)).toEqual(OBSERVED_INNATES.map(abilityNum))
  }, 60000)
})
