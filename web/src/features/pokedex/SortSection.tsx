import { SORT_KEYS, SORT_LABELS, type SortState } from './sort'

interface Props {
  sort: SortState
  onChange: (sort: SortState) => void
}

/** Dex No ascending is the default -- always exactly one criterion active. Click a
 * different criterion to sort by it ascending; click the active one again to flip
 * between ascending and descending. */
export default function SortSection({ sort, onChange }: Props) {
  function cycle(key: (typeof SORT_KEYS)[number]) {
    if (sort.key !== key) onChange({ key, direction: 'asc' })
    else onChange({ key, direction: sort.direction === 'asc' ? 'desc' : 'asc' })
  }

  return (
    <section>
      <h2 className="font-semibold mb-1.5">Sort by</h2>
      <div className="flex flex-wrap gap-1">
        {SORT_KEYS.map((key) => {
          const active = sort.key === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => cycle(key)}
              title={
                active
                  ? `Sorting by ${SORT_LABELS[key]} (${sort.direction === 'asc' ? 'ascending' : 'descending'}) — click to reverse`
                  : `Sort by ${SORT_LABELS[key]}`
              }
              className="rounded px-1.5 py-0.5 text-xs font-medium"
              style={{
                background: active ? 'var(--color-accent)' : 'transparent',
                color: active ? 'var(--color-accent-contrast)' : 'var(--color-text)',
                border: `1px solid ${active ? 'var(--color-accent)' : 'var(--color-border)'}`,
              }}
            >
              {SORT_LABELS[key]}
              {active ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
            </button>
          )
        })}
      </div>
    </section>
  )
}
