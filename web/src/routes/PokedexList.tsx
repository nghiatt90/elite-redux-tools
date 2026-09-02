import { useMemo } from 'react'
import { useGameData } from '../lib/GameDataContext'
import SpeciesListView from '../features/pokedex/SpeciesListView'

export default function PokedexList() {
  const { species } = useGameData()

  // 777 of 1907 entries are forms (e.g. every mega/regional/battle form) -- listing
  // them as peers would flood the list with duplicate names. The primary list shows
  // base species only; forms are reachable from the base species' detail view.
  const baseSpecies = useMemo(() => species.filter((s) => !s.isForm), [species])

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 text-sm shrink-0" style={{ color: 'var(--color-text-muted)' }}>
        {baseSpecies.length} species
      </div>
      <div className="flex-1 min-h-0">
        <SpeciesListView species={baseSpecies} />
      </div>
    </div>
  )
}
