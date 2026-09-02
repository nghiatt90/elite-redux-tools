import { useMemo } from 'react'
import { Link } from 'react-router'
import { useGameData } from '../../lib/GameDataContext'
import { spriteUrl } from '../../lib/data'
import { displayName } from '../../lib/displayName'
import type { Species } from '../../lib/types'
import { buildEvolutionChain, findOtherForms, type ChainNode } from './evolutionChain'

function SpeciesChip({
  node,
  current,
  speciesById,
}: {
  node: ChainNode
  current: Species
  speciesById: Map<string, Species>
}) {
  return (
    <Link
      to={`/pokemon/${node.species.id}`}
      className="flex items-center gap-1.5 rounded-md border px-2 py-1"
      style={{
        borderColor: node.species.id === current.id ? 'var(--color-accent)' : 'var(--color-border)',
        background: node.species.id === current.id ? 'var(--color-bg-hover)' : undefined,
      }}
    >
      <img
        src={spriteUrl(node.species.id, 'icon')}
        alt=""
        width={32}
        height={32}
        className="pixelated shrink-0"
        loading="lazy"
      />
      <div className="text-xs">
        <div className="font-medium">{node.label ?? displayName(node.species, speciesById)}</div>
        {node.condition && <div style={{ color: 'var(--color-text-muted)' }}>{node.condition}</div>}
      </div>
    </Link>
  )
}

export default function EvolutionChain({ species }: { species: Species }) {
  const { speciesById, movesById, itemsById } = useGameData()
  const stages = useMemo(() => buildEvolutionChain(species, speciesById), [species, speciesById])
  const otherForms = useMemo(
    () => findOtherForms(species, speciesById, movesById, itemsById),
    [species, speciesById, movesById, itemsById],
  )

  const noRegularEvolution = stages.length <= 1 && stages[0]?.length === 1

  if (noRegularEvolution && otherForms.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        Does not evolve.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {!noRegularEvolution && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {stages.map((stage, i) => (
            <div key={i} className="flex items-center gap-2 shrink-0">
              {i > 0 && (
                <span className="text-lg" style={{ color: 'var(--color-text-muted)' }}>
                  →
                </span>
              )}
              <div className="flex flex-col gap-2">
                {stage.map((node) => (
                  <SpeciesChip key={node.species.id} node={node} current={species} speciesById={speciesById} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {otherForms.length > 0 && (
        <div>
          <h3
            className="text-xs font-semibold uppercase tracking-wide mb-1.5"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Other forms
          </h3>
          <div className="flex flex-wrap gap-2">
            {otherForms.map((node) => (
              <SpeciesChip key={node.species.id} node={node} current={species} speciesById={speciesById} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
