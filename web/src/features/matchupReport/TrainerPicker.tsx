import { useMemo, useState } from 'react'
import type { Trainer } from '../../lib/types'

function trainerClassLabel(trainer: Trainer): string {
  return trainer.class ? trainer.class.replace('TRAINER_CLASS_', '').replace(/_/g, ' ') : ''
}

interface Props {
  trainers: Trainer[]
  value: Trainer | null
  onChange: (trainer: Trainer) => void
}

/** A search-filter picker over all 932 trainers, same interaction shape as
 * BattlerPanel's species search -- a plain 932-option <select> is technically
 * correct but unusable, and there's no existing "trainer name" concept worth a
 * dedicated search index the way species/moves get (pokedex/search.ts) for a
 * single picker used on one route. Trainer NAMES collide constantly (e.g. dozens
 * of plain "Grunt"s across different classes), so results show class + id
 * alongside the name and the id is what actually gets selected. */
export default function TrainerPicker({ trainers, value, onChange }: Props) {
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return trainers.filter((t) => t.name.toLowerCase().includes(q) || trainerClassLabel(t).toLowerCase().includes(q) || t.id.toLowerCase().includes(q)).slice(0, 20)
  }, [trainers, query])

  return (
    <div>
      <input
        className="rounded-md border px-2 py-1 text-sm w-full"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)', color: 'var(--color-text)' }}
        placeholder="Search trainers by name or class..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && results.length > 0 && (
        <div className="mt-1 max-h-48 overflow-y-auto rounded-md border" style={{ borderColor: 'var(--color-border)' }}>
          {results.map((t) => (
            <button
              key={t.id}
              className="block w-full text-left px-2 py-1 text-sm hover:bg-[var(--color-bg-hover)]"
              onClick={() => {
                onChange(t)
                setQuery('')
              }}
            >
              {t.name}
              <span style={{ color: 'var(--color-text-muted)' }}> — {trainerClassLabel(t)}</span>
            </button>
          ))}
        </div>
      )}
      {query && results.length === 0 && (
        <div className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          No trainer matches "{query}".
        </div>
      )}
      {value && (
        <div className="text-sm font-medium mt-1">
          {value.name} <span style={{ color: 'var(--color-text-muted)' }}>— {trainerClassLabel(value)}</span>
        </div>
      )}
    </div>
  )
}
