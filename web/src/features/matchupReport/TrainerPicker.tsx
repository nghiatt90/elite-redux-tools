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

// Re-measured directly against the committed snapshot: "Grunt" alone matches 56
// trainers (30 Team Magma + 26 Team Aqua). The old cap of 20 hid 36 of those with no
// indication anything was cut off -- unreachable by search unless the user already
// knew an id, which defeats the whole point of the fix below (an id only
// disambiguates a collision if the colliding row is actually shown). Raised past
// the worst case in today's data, but still finite -- results.length !== allMatches
// .length is shown explicitly rather than assumed away, since a future trainer
// addition could exceed even this.
const RESULT_CAP = 60

/** A search-filter picker over all 932 trainers, same interaction shape as
 * BattlerPanel's species search -- a plain 932-option <select> is technically
 * correct but unusable, and there's no existing "trainer name" concept worth a
 * dedicated search index the way species/moves get (pokedex/search.ts) for a
 * single picker used on one route.
 *
 * Trainer (name, class) pairs collide, badly and measured directly against the
 * committed snapshot rather than assumed from the one case that was noticed by eye
 * (Tate & Liza's 5 entries, all reading identically as "Tate&Liza -- LEADER"): 94
 * distinct (name, class) pairs are shared by 2+ trainers, covering 487 of 932
 * trainers total -- Grunt/Team Magma alone is 30-way. So name+class is nowhere near
 * enough to identify a result; the id is the only field that's actually unique
 * (TrainerEnum), and is shown alongside the name/class in every result row and in
 * the selected-value line below, not just used silently as the onChange payload
 * (an earlier version of this component's own comment claimed the id was shown when
 * the JSX never rendered it at all). See RESULT_CAP's own comment for the other half
 * of this fix: the id disambiguates nothing for a row the list never shows. */
export default function TrainerPicker({ trainers, value, onChange }: Props) {
  const [query, setQuery] = useState('')

  const allMatches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return trainers.filter((t) => t.name.toLowerCase().includes(q) || trainerClassLabel(t).toLowerCase().includes(q) || t.id.toLowerCase().includes(q))
  }, [trainers, query])
  const results = allMatches.slice(0, RESULT_CAP)
  const hiddenCount = allMatches.length - results.length

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
              <span className="block text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {t.id}
              </span>
            </button>
          ))}
          {hiddenCount > 0 && (
            <div className="px-2 py-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              +{hiddenCount} more match{hiddenCount === 1 ? '' : 'es'} not shown -- narrow your search (e.g. add the trainer's
              class or id).
            </div>
          )}
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
          <span className="block text-xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
            {value.id}
          </span>
        </div>
      )}
    </div>
  )
}
