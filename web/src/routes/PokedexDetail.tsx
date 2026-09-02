import { Link, useParams } from 'react-router'
import { useGameData } from '../lib/GameDataContext'
import TypeChip from '../components/TypeChip'
import AbilitiesPanel from '../features/pokedex/AbilitiesPanel'
import DefensiveMatchupGrid from '../features/pokedex/DefensiveMatchupGrid'
import DetailStatBars from '../features/pokedex/DetailStatBars'
import SpeciesSprite from '../features/pokedex/SpeciesSprite'

export default function PokedexDetail() {
  const { id } = useParams<{ id: string }>()
  const { speciesById } = useGameData()
  const species = id ? speciesById.get(id.toUpperCase()) : undefined

  if (!species) {
    return (
      <div className="p-4">
        <p>Unknown species: {id}</p>
        <Link className="underline" to="/">
          Back
        </Link>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4 max-w-3xl mx-auto">
      <Link className="text-sm underline" to="/">
        ← Back to list
      </Link>

      <div className="flex gap-4 mt-3">
        <SpeciesSprite speciesId={species.id} />
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold">{species.name}</h1>
          {species.longName && (
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              {species.longName}
            </p>
          )}
          <p className="text-sm mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {species.category} · #{species.nationalDexNum.toString().padStart(4, '0')}
          </p>
          <div className="flex gap-1 mt-2">
            {species.types.map((t) => (
              <TypeChip key={t} type={t} />
            ))}
          </div>
          <p className="text-sm mt-3 leading-relaxed">{species.description}</p>
        </div>
      </div>

      <section className="mt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>
          Defensive matchups
        </h2>
        <DefensiveMatchupGrid types={species.types} />
      </section>

      <section className="mt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>
          Base stats
        </h2>
        <DetailStatBars stats={species.baseStats} />
      </section>

      <section className="mt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--color-text-muted)' }}>
          Abilities &amp; Innates
        </h2>
        <AbilitiesPanel abilities={species.abilities} innates={species.innates} />
      </section>
    </div>
  )
}
