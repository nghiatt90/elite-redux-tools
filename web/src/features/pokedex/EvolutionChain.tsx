import { useMemo } from 'react'
import { Link } from 'react-router'
import { useGameData } from '../../lib/GameDataContext'
import { spriteUrl } from '../../lib/data'
import type { Species } from '../../lib/types'
import { buildEvolutionChain } from './evolutionChain'

export default function EvolutionChain({ species }: { species: Species }) {
  const { speciesById } = useGameData()
  const stages = useMemo(() => buildEvolutionChain(species, speciesById), [species, speciesById])

  if (stages.length <= 1 && stages[0]?.length === 1) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        Does not evolve.
      </p>
    )
  }

  return (
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
              <Link
                key={node.species.id}
                to={`/pokemon/${node.species.id}`}
                className="flex items-center gap-1.5 rounded-md border px-2 py-1"
                style={{
                  borderColor:
                    node.species.id === species.id ? 'var(--color-accent)' : 'var(--color-border)',
                  background: node.species.id === species.id ? 'var(--color-bg-hover)' : undefined,
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
                  <div className="font-medium">{node.species.name}</div>
                  {node.condition && (
                    <div style={{ color: 'var(--color-text-muted)' }}>{node.condition}</div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
