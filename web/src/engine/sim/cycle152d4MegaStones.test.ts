/* eslint-disable react-hooks/rules-of-hooks -- useMove is the sim's action builder, not a React hook */
// MEGA_STONE_SWEEP: GetMegaEvolutionSpecies (battle_util.c:8092-8100), CanMegaEvolve (:8124-8185), VARIOUS_HANDLE_MEGA_EVO (battle_script_commands.c:7374-7426).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createBattleState, createBattlerState } from './create'
import {
  loadEngineProductionFiles,
  loadEngineTestFiles,
  loadItems,
  runInventory,
  type ItemUnit,
  type SourceFile,
} from './driver/itemInventory'
import { loadSimData } from './driver/loadSimData'
import { groundingFor } from './driver/session'
import {
  canMegaEvolve,
  getMegaEvolutionSpecies,
  megaEvolveBattler,
  type FormChangeDeps,
} from './formChange'
import type { BattleState, RandomSource, SimBattleMon } from './state'

// Sweep token retained in cleaned test source so the inventory credits the 266 stone units.
export const MEGA_STONE_SWEEP = 'MEGA_STONE_SWEEP'

const simData = loadSimData()
const DATA_CONTEXT = simData.dataContext

const noAbility: SimBattleMon['abilities'] = { ability: null, innates: [null, null, null] }

function monFor(speciesId: string, overrides: Partial<SimBattleMon> = {}): SimBattleMon {
  const s = simData.speciesById.get(speciesId) as { types: string[] } | undefined
  if (!s) throw new Error(`species.json has no ${speciesId}`)
  const types = s.types.map((t) => t.replace(/^TYPE_/, ''))
  return {
    speciesId,
    rawStats: { atk: 100, def: 100, spatk: 100, spdef: 100, spe: 100 },
    moves: ['MOVE_TACKLE', null, null, null],
    pp: [35, 0, 0, 0],
    hp: 100,
    maxHp: 100,
    itemId: null,
    statStages: [],
    types: [types[0] ?? 'MYSTERY', types[1] ?? 'MYSTERY', types[2] ?? 'MYSTERY'],
    level: 50,
    nature: 'NATURE_HARDY',
    hiddenPowerType: null,
    speedDown: false,
    abilities: noAbility,
    gender: 'MALE',
    status1: 0,
    status2: 0,
    ...overrides,
  }
}

function countRng(): RandomSource & { calls: number } {
  const rng = {
    calls: 0,
    random16: () => {
      rng.calls++
      return 0
    },
  }
  return rng
}

function battle(a: SimBattleMon, b: SimBattleMon, rng: RandomSource): BattleState {
  return createBattleState({
    battlers: [createBattlerState(0, a, 0), createBattlerState(1, b, 0)],
    rng,
  })
}

function unitFor(
  result: ReturnType<typeof runInventory>,
  kind: string,
  key: string,
  site?: string,
): ItemUnit | undefined {
  return result.units.find(
    (unit) => unit.kind === kind && unit.key === key && (site === undefined || unit.site === site),
  )
}

function testSourcesWithout(tokens: string[]): SourceFile[] {
  return loadEngineTestFiles().filter((file) => !tokens.some((token) => file.source.includes(token)))
}

function stubProductionFile(fileToStub: string, token: string, replacement: string): SourceFile[] {
  return loadEngineProductionFiles().map((file) =>
    file.file === fileToStub
      ? { file: file.file, source: file.source.replace(new RegExp(token, 'g'), replacement) }
      : file,
  )
}

describe('cycle 152d4 - Mega Stones per stone in held-item inventory', () => {
  it('sweeps every stone with a table row across every valid pre-evolution species', () => {
    // 270 mega stones in items.json; 266 appear in species.json megas[] across 285 (stone, from) pairs.
    // 4 stones have no table row (BRUXISHITE, EXCADRILLITE_R, EYE_OF_ENDER, JELLICENTITE) and are allowlisted.
    const speciesList = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../data/v2.65beta/species.json', import.meta.url)),
        'utf-8',
      ),
    ) as Array<{ id: string; megas?: Array<{ from?: string; item?: string }> }>
    const itemsList = loadItems()
    const megaStoneIds = new Set(
      itemsList.filter((i) => i.resolvedHoldEffect === 'HOLD_EFFECT_MEGA_STONE').map((i) => i.id),
    )

    const stoneToPairs = new Map<string, Array<{ from: string; to: string }>>()
    for (const sp of speciesList) {
      for (const m of sp.megas ?? []) {
        if (m.item && megaStoneIds.has(m.item)) {
          const list = stoneToPairs.get(m.item) ?? []
          list.push({ from: m.from ?? sp.id, to: sp.id })
          stoneToPairs.set(m.item, list)
        }
      }
    }

    expect(stoneToPairs.size).toBe(266)
    let pairCount = 0
    for (const pairs of stoneToPairs.values()) pairCount += pairs.length
    // Pinned count: 285 total (stone, from) pairs across 266 stones.
    expect(pairCount).toBe(285)

    for (const [item, pairs] of stoneToPairs.entries()) {
      for (const { from, to } of pairs) {
        expect(getMegaEvolutionSpecies(from, item, DATA_CONTEXT)).toBe(to)

        const state = battle(monFor(from, { itemId: item }), monFor('SPECIES_MUDKIP'), countRng())
        const deps: FormChangeDeps = {
          dataContext: DATA_CONTEXT,
          grounding: groundingFor(simData, state),
          hazardTypes: {
            typeChart: simData.typeChart,
            inverseTypeChart: simData.inverseTypeChart,
            inverseBattle: false,
          },
        }

        expect(canMegaEvolve(state, 0, DATA_CONTEXT)).toBe(true)

        const unmodelled: string[] = []
        expect(megaEvolveBattler(state, 0, deps, unmodelled)).toBe(to)
        expect(state.battlers[0]!.mon.speciesId).toBe(to)
        expect(state.battlers[0]!.mon.itemId).toBe(item)
        expect(state.mega.alreadyEvolved[0]).toBe(true)
      }
    }
  })

  it('negative: stones with no table row return null and cannot mega evolve', () => {
    // 1. ITEM_BRUXISHITE -> SPECIES_BRUXISH
    expect(getMegaEvolutionSpecies('SPECIES_BRUXISH', 'ITEM_BRUXISHITE', DATA_CONTEXT)).toBeNull()
    const bruxishState = battle(
      monFor('SPECIES_BRUXISH', { itemId: 'ITEM_BRUXISHITE' }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    expect(canMegaEvolve(bruxishState, 0, DATA_CONTEXT)).toBe(false)

    // 2. ITEM_JELLICENTITE -> SPECIES_JELLICENT
    expect(getMegaEvolutionSpecies('SPECIES_JELLICENT', 'ITEM_JELLICENTITE', DATA_CONTEXT)).toBeNull()
    const jelliState = battle(
      monFor('SPECIES_JELLICENT', { itemId: 'ITEM_JELLICENTITE' }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    expect(canMegaEvolve(jelliState, 0, DATA_CONTEXT)).toBe(false)

    // 3. ITEM_EXCADRILLITE_R -> SPECIES_EXCADRILL_REDUX
    expect(
      getMegaEvolutionSpecies('SPECIES_EXCADRILL_REDUX', 'ITEM_EXCADRILLITE_R', DATA_CONTEXT),
    ).toBeNull()
    const excaState = battle(
      monFor('SPECIES_EXCADRILL_REDUX', { itemId: 'ITEM_EXCADRILLITE_R' }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    expect(canMegaEvolve(excaState, 0, DATA_CONTEXT)).toBe(false)

    // 4. ITEM_EYE_OF_ENDER -> holder cannot mega evolve
    expect(getMegaEvolutionSpecies('SPECIES_MUDKIP', 'ITEM_EYE_OF_ENDER', DATA_CONTEXT)).toBeNull()
    const enderState = battle(
      monFor('SPECIES_MUDKIP', { itemId: 'ITEM_EYE_OF_ENDER' }),
      monFor('SPECIES_MUDKIP'),
      countRng(),
    )
    expect(canMegaEvolve(enderState, 0, DATA_CONTEXT)).toBe(false)
  })

  it('negative: correct stone on wrong species returns null, non-stone item returns null', () => {
    expect(getMegaEvolutionSpecies('SPECIES_MUDKIP', 'ITEM_METAGROSSITE', DATA_CONTEXT)).toBeNull()
    expect(getMegaEvolutionSpecies('SPECIES_VENUSAUR', 'ITEM_SITRUS_BERRY', DATA_CONTEXT)).toBeNull()
  })

  it('multi-from cross-check: ITEM_PIKANITE resolves from all nine Pikachu cap/partner forms', () => {
    const pikaForms = [
      'SPECIES_PIKACHU_PARTNER',
      'SPECIES_PIKACHU_WORLD_CAP',
      'SPECIES_PIKACHU_ORIGINAL_CAP',
      'SPECIES_PIKACHU_HOENN_CAP',
      'SPECIES_PIKACHU_SINNOH_CAP',
      'SPECIES_PIKACHU_UNOVA_CAP',
      'SPECIES_PIKACHU_KALOS_CAP',
      'SPECIES_PIKACHU_ALOLA_CAP',
      'SPECIES_PIKACHU_PARTNER_CAP',
    ]
    for (const form of pikaForms) {
      expect(getMegaEvolutionSpecies(form, 'ITEM_PIKANITE', DATA_CONTEXT)).toBe(
        'SPECIES_PIKACHU_PARTNER_MEGA',
      )
    }
  })

  it('inventory: classifies 270 mega-stone units (266 ported, 4 allowlisted)', () => {
    const items = loadItems()
    const result = runInventory(items)
    const megaUnits = result.units.filter((u) => u.kind === 'mega-stone')

    expect(megaUnits).toHaveLength(270)

    const ported = megaUnits.filter((u) => u.status === 'ported')
    expect(ported).toHaveLength(266)
    for (const u of ported) {
      expect(u.testFile).toBe('web/src/engine/sim/cycle152d4MegaStones.test.ts')
      expect(u.citation).toBe('pipeline/.upstream/eliteredux-source/src/battle_util.c:8092-8100')
      expect(u.registeredUntested).toBe(false)
    }

    const allowlisted = megaUnits.filter((u) => u.status === 'allowlisted')
    expect(allowlisted).toHaveLength(4)
    const allowlistedIds = allowlisted.map((u) => u.key).sort()
    expect(allowlistedIds).toEqual([
      'ITEM_BRUXISHITE',
      'ITEM_EXCADRILLITE_R',
      'ITEM_EYE_OF_ENDER',
      'ITEM_JELLICENTITE',
    ])
    for (const u of allowlisted) {
      expect(u.citation).toBe(
        'pipeline/.upstream/eliteredux-source/tools/codegen/src/er/data/EvolutionsGenerator.kt:111-124',
      )
      expect(u.registeredUntested).toBe(false)
    }

    const unported = megaUnits.filter((u) => u.status === 'unported')
    expect(unported).toHaveLength(0)

    const unclassified = megaUnits.filter((u) => u.status === 'unclassified')
    expect(unclassified).toHaveLength(0)

    // Existing hold-trigger units are untouched
    const canBattlerGetOrLose = unitFor(
      result,
      'hold-trigger',
      'HOLD_EFFECT_MEGA_STONE@battle_util.c:CanBattlerGetOrLoseItem',
    )
    expect(canBattlerGetOrLose?.status).toBe('ported')

    const aiDouble = unitFor(
      result,
      'ai-trigger',
      'HOLD_EFFECT_MEGA_STONE@battle_ai_main.c:AI_DoubleBattle',
    )
    expect(aiDouble?.status).toBe('unported')
  })

  it('mutation: removing production evidence or test evidence un-ports the 266 units', () => {
    const items = loadItems()

    // 1. Production mutation: replace megaEvolveBattler in formChange.ts
    const stubbedProduction = stubProductionFile(
      'web/src/engine/sim/formChange.ts',
      'megaEvolveBattler',
      'disabledMegaEvolveBattler',
    )
    const prodMutatedResult = runInventory(items, { productionFiles: stubbedProduction })
    const prodMutatedStones = prodMutatedResult.units.filter((u) => u.kind === 'mega-stone')
    expect(prodMutatedStones.filter((u) => u.status === 'ported')).toHaveLength(0)
    expect(prodMutatedStones.filter((u) => u.status === 'unported')).toHaveLength(266)

    // 2. Test mutation: strip MEGA_STONE_SWEEP from test sources
    const strippedTests = testSourcesWithout(['MEGA_STONE_SWEEP'])
    const testMutatedResult = runInventory(items, { testSources: strippedTests })
    const testMutatedStones = testMutatedResult.units.filter((u) => u.kind === 'mega-stone')
    expect(testMutatedStones.filter((u) => u.status === 'ported')).toHaveLength(0)
    expect(testMutatedStones.filter((u) => u.status === 'unported')).toHaveLength(266)
    expect(testMutatedStones.filter((u) => u.registeredUntested)).toHaveLength(266)
  })
})
