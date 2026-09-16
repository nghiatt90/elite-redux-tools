// Loads the real committed data snapshot, same pattern as matchupReport.test.ts --
// mega/primal resolution is only meaningful against real species and trainer data.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFormIndex, resolveForm } from './formResolution'
import type { Species, Trainer } from './types'

const DATA_DIR = join(import.meta.dirname, '..', '..', '..', 'data', 'v2.65beta')
const load = <T,>(name: string) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf-8')) as T

const species = load<Species[]>('species.json')
const trainers = load<Trainer[]>('trainers.json')
const speciesById = new Map(species.map((s) => [s.id, s]))
const trainersById = new Map(trainers.map((t) => [t.id, t]))

// The battle-sim plan's 40 target fights resolve to these 55 distinct trainer ids --
// docs/battle-sim/boss-fight-coverage.md's own "The fights, resolved to trainer ids"
// tables, transcribed by call site the way that doc requires (never by name). This
// list is the scope decision itself (which fights count), not data a repin moves --
// what a repin CAN move is which of these parties hold a Mega Stone/Primal Orb and
// what species.json says that resolves to, which is exactly what the test below reads
// live from trainers.json/species.json rather than hand-copying the doc's own 70-row
// table.
const TARGET_TRAINER_IDS = [
  // Rival
  'TRAINER_MAY_ROUTE_103_TORCHIC',
  'TRAINER_MAY_RUSTBORO_TORCHIC',
  'TRAINER_MAY_ROUTE_110_TORCHIC',
  'TRAINER_MAY_ROUTE_119_TORCHIC',
  // Gym leaders (11 ids, 8 fights -- Gym 8 is two tag battles, 4 ids)
  'TRAINER_ROXANNE_1',
  'TRAINER_BRAWLY_1',
  'TRAINER_WATTSON_1',
  'TRAINER_FLANNERY_1',
  'TRAINER_NORMAN_1',
  'TRAINER_WINONA_1',
  'TRAINER_TATE_AND_LIZA_1',
  'TRAINER_JUAN_1',
  'TRAINER_WALLACE',
  'TRAINER_JUAN_5',
  'TRAINER_WALLACE_5',
  // Team Aqua
  'TRAINER_GRUNT_PETALBURG_WOODS',
  'TRAINER_GRUNT_RUSTURF_TUNNEL',
  'TRAINER_SHELLY_WEATHER_INSTITUTE',
  'TRAINER_MATT',
  // Archie
  'TRAINER_GRUNT_MUSEUM_1',
  'TRAINER_GRUNT_MUSEUM_2',
  'TRAINER_ARCHIE_SLATEPORT',
  'TRAINER_ARCHIE_MT_PYRE',
  'TRAINER_ARCHIE',
  // Team Magma
  'TRAINER_COURTNEY_METEOR_FALLS',
  'TRAINER_GRUNT_METEOR_FALLS',
  'TRAINER_GRUNT_SUNHOLLOW_1',
  'TRAINER_COURTNEY_SUNHOLLOW',
  'TRAINER_GRUNT_SPACE_CENTER_2',
  'TRAINER_GRUNT_SPACE_CENTER_5',
  'TRAINER_GRUNT_SPACE_CENTER_6',
  'TRAINER_GRUNT_SPACE_CENTER_7',
  // Maxie
  'TRAINER_MAXIE_MT_CHIMNEY',
  'TRAINER_MAXIE_MAGMA_HIDEOUT',
  'TRAINER_MAXIE_MOSSDEEP',
  'TRAINER_COURTNEY_MOSSDEEP',
  // Steven
  'TRAINER_STEVEN_GRANITE_CAVE',
  'TRAINER_STEVEN_ROUTE118',
  'TRAINER_STEVEN',
  // Wally
  'TRAINER_WALLY_VR_1',
  'TRAINER_WALLY_VR_2',
  // Gym 8's own trainers
  'TRAINER_TIFFANY',
  'TRAINER_BRIDGET',
  'TRAINER_CRISSY',
  'TRAINER_BETHANY',
  'TRAINER_DAPHNE',
  'TRAINER_CONNIE',
  'TRAINER_ANDREA',
  'TRAINER_OLIVIA',
  'TRAINER_BRIANNA',
  'TRAINER_ANNIKA',
  // Elite Four
  'TRAINER_SIDNEY',
  'TRAINER_PHOEBE',
  'TRAINER_GLACIA',
  'TRAINER_DRAKE',
]

describe('formResolution against the boss-fight target set', () => {
  it('resolves to exactly 55 distinct trainer ids, all present in trainers.json', () => {
    expect(new Set(TARGET_TRAINER_IDS).size).toBe(55)
    for (const id of TARGET_TRAINER_IDS) expect(trainersById.get(id), id).toBeDefined()
  })

  it('every one of the 70 party slots holding a Mega Stone or Primal Orb resolves, and there are 59 distinct forms', () => {
    const index = buildFormIndex(species)
    const resolvedForms = new Set<string>()
    let heldSlots = 0
    let resolvedSlots = 0

    for (const id of TARGET_TRAINER_IDS) {
      const party = trainersById.get(id)!.parties.elite
      for (const mon of party) {
        // Only count slots whose item is a REAL mega/primal trigger somewhere in the
        // species list -- an ordinary held item (Leftovers, etc.) correctly resolves
        // to null and isn't part of this measurement.
        const isTransformItem = species.some(
          (s) => s.megas.some((m) => m.item === mon.item) || s.primals.some((p) => p.item === mon.item),
        )
        if (!isTransformItem) continue
        heldSlots++
        const result = resolveForm(index, mon.species, mon.item)
        expect(result, `${id}: ${mon.species} holding ${mon.item}`).not.toBeNull()
        resolvedSlots++
        resolvedForms.add(result!.formId)
      }
    }

    // Re-measured directly against the pinned data (see this file's own header doc
    // for the method) -- matches docs/battle-sim/boss-fight-coverage.md's "70 of the
    // 285 party slots... resolving to 59 distinct post-change forms" exactly.
    expect(heldSlots).toBe(70)
    expect(resolvedSlots).toBe(70)
    expect(resolvedForms.size).toBe(59)
  })

  it("resolved forms' stats, types and abilities match species.json (the resolver returns species.json's own id)", () => {
    const index = buildFormIndex(species)
    for (const id of TARGET_TRAINER_IDS) {
      for (const mon of trainersById.get(id)!.parties.elite) {
        const result = resolveForm(index, mon.species, mon.item)
        if (!result) continue
        const form = speciesById.get(result.formId)
        expect(form, result.formId).toBeDefined()
        expect(form!.isForm).toBe(true)
        // A mega/primal form's declared origin species matches the party mon that
        // becomes it -- the whole point of the reverse lookup.
        const originList = result.kind === 'mega' ? form!.megas : form!.primals
        expect(originList.some((o) => o.from === mon.species && o.item === mon.item)).toBe(true)
        expect(form!.baseStats).toBeDefined()
        expect(form!.types.length).toBeGreaterThan(0)
        expect(form!.abilities.length).toBeGreaterThan(0)
      }
    }
  })

  it('ITEM_URSHIFITE resolves differently depending on the base species', () => {
    const index = buildFormIndex(species)
    expect(resolveForm(index, 'SPECIES_URSHIFU', 'ITEM_URSHIFITE')?.formId).toBe('SPECIES_URSHIFU_MEGA')
    expect(resolveForm(index, 'SPECIES_URSHIFU_RAPID_STRIKE_STYLE', 'ITEM_URSHIFITE')?.formId).toBe(
      'SPECIES_URSHIFU_RAPID_STRIKE_STYLE_MEGA',
    )
  })
})

describe('formResolution: move-triggered megas are deliberately unreachable', () => {
  it('SPECIES_RAYQUAZA_MEGA has no item-keyed megas[] entry, so nothing resolves it', () => {
    const rayquazaMega = speciesById.get('SPECIES_RAYQUAZA_MEGA')!
    expect(rayquazaMega.megas).toHaveLength(1)
    expect(rayquazaMega.megas[0]).toMatchObject({ from: 'SPECIES_RAYQUAZA', move: 'MOVE_DRAGON_ASCENT' })
    expect(rayquazaMega.megas[0].item).toBeUndefined()

    const index = buildFormIndex(species)
    // No item at all resolves Rayquaza to its mega form through this index.
    for (const [key, value] of index) {
      if (value.formId === 'SPECIES_RAYQUAZA_MEGA') throw new Error(`unexpected index entry ${key}`)
    }
    expect(resolveForm(index, 'SPECIES_RAYQUAZA', 'ITEM_LEFTOVERS')).toBeNull()
  })

  it('the resolved form never appears in the 40 target fights (docs/battle-sim/boss-fight-coverage.md)', () => {
    // Base Rayquaza itself DOES appear here (TRAINER_DRAKE's Life Orb Rayquaza) --
    // the doc's claim is narrower: no party mon in this set holds an item that
    // resolves to the mega form, since that form can only be reached by using
    // Dragon Ascent in battle, not by holding anything.
    const index = buildFormIndex(species)
    for (const id of TARGET_TRAINER_IDS) {
      for (const mon of trainersById.get(id)!.parties.elite) {
        expect(resolveForm(index, mon.species, mon.item)?.formId).not.toBe('SPECIES_RAYQUAZA_MEGA')
      }
    }
  })
})

describe('formResolution unit behaviour', () => {
  it('returns null for a null item', () => {
    const index = buildFormIndex(species)
    expect(resolveForm(index, 'SPECIES_VENUSAUR', null)).toBeNull()
  })

  it('returns null for an item that is not a mega/primal trigger', () => {
    const index = buildFormIndex(species)
    expect(resolveForm(index, 'SPECIES_VENUSAUR', 'ITEM_LEFTOVERS')).toBeNull()
  })

  it('resolves an ordinary mega and a primal the same way, distinguished by kind', () => {
    const index = buildFormIndex(species)
    expect(resolveForm(index, 'SPECIES_VENUSAUR', 'ITEM_VENUSAURITE')).toEqual({
      formId: 'SPECIES_VENUSAUR_MEGA',
      kind: 'mega',
    })
    expect(resolveForm(index, 'SPECIES_KYOGRE', 'ITEM_BLUE_ORB')).toEqual({
      formId: 'SPECIES_KYOGRE_PRIMAL',
      kind: 'primal',
    })
  })
})
