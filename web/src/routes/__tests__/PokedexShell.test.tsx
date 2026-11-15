import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'
import type { Species } from '../../lib/types'
import PokedexShell from '../PokedexShell'
import FilterRail from '../../features/pokedex/FilterRail'
import { EMPTY_FILTERS } from '../../features/pokedex/filters'
import { DEFAULT_SORT } from '../../features/pokedex/sort'

const mockSpecies: Species = {
  id: 'SPECIES_BULBASAUR',
  speciesNum: 1,
  name: 'Bulbasaur',
  category: 'Seed',
  description: 'A strange seed was planted on its back at birth.',
  nationalDexNum: 1,
  height: 7,
  weight: 69,
  isForm: false,
  formOf: null,
  types: ['Grass', 'Poison'],
  baseStats: { hp: 45, atk: 49, def: 49, spatk: 65, spdef: 65, spe: 45 },
  abilities: ['Overgrow'],
  innates: ['Chlorophyll'],
  gender: { percentFemale: 12.5 },
  evolutions: [],
  megas: [],
  primals: [],
  learnset: { levelUp: [], tutor: [] },
}

vi.mock('../../lib/GameDataContext', async () => {
  const actual = await vi.importActual<typeof import('../../lib/GameDataContext')>('../../lib/GameDataContext')
  return {
    ...actual,
    useGameData: () => ({
      version: 'v2.65.5',
      species: [mockSpecies],
      speciesById: new Map([[mockSpecies.id, mockSpecies]]),
      moves: [],
      movesById: new Map(),
      abilities: [],
      abilitiesById: new Map(),
      items: [],
      itemsById: new Map(),
      typeChart: {},
      meta: {
        generatedAt: '2026-11-15',
        sources: {
          'er-config': { repo: 'er-config', sha: '0572570b' },
          'eliteredux-source': { repo: 'eliteredux-source', sha: '60f7d528' },
        },
      },
    }),
  }
})

describe('PokedexShell and FilterRail desktop layout', () => {
  it('renders root container with h-full min-h-0 flex overflow-hidden and desktop wrapper with h-full min-h-0', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<PokedexShell />}>
            <Route path="pokemon/:id" element={<div>Detail Pane</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    // Root container has h-full min-h-0 flex overflow-hidden
    expect(html).toContain('class="h-full min-h-0 flex overflow-hidden"')
    // Desktop wrapper around FilterRail has hidden md:block h-full min-h-0
    expect(html).toContain('class="hidden md:block h-full min-h-0"')
    // FilterRail inside desktop wrapper has h-full overflow-y-auto thin-scrollbar
    expect(html).toContain('thin-scrollbar')
    expect(html).toContain('w-56 shrink-0 h-full overflow-y-auto thin-scrollbar')
  })

  it('renders detail pane with lg:w-[560px] xl:w-[640px] when a pokemon detail route is active', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/pokemon/SPECIES_BULBASAUR']}>
        <Routes>
          <Route path="/" element={<PokedexShell />}>
            <Route path="pokemon/:id" element={<div>Detail Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )

    expect(html).toContain('lg:w-[560px] xl:w-[640px]')
    expect(html).toContain(
      'flex-1 lg:flex-none lg:w-[560px] xl:w-[640px] lg:shrink-0 h-full overflow-y-auto lg:border-l',
    )
    expect(html).toContain('Detail Content')
  })

  it('FilterRail renders scrollable container with h-full, overflow-y-auto, and thin-scrollbar', () => {
    const html = renderToString(
      <FilterRail
        filters={EMPTY_FILTERS}
        onChange={() => {}}
        sort={DEFAULT_SORT}
        onSortChange={() => {}}
      />,
    )

    expect(html).toContain('h-full')
    expect(html).toContain('overflow-y-auto')
    expect(html).toContain('thin-scrollbar')
    expect(html).toContain('w-56 shrink-0 h-full overflow-y-auto thin-scrollbar p-3 space-y-4 text-sm')
  })
})
