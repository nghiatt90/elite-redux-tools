import { DEFAULT_SORT, SORT_KEYS, SORT_LABELS, type SortState } from './sort'

interface Props {
  sort: SortState
  onChange: (sort: SortState) => void
}

/** Same click-to-cycle language as the Type buttons in FilterRail: click an
 * inactive criterion to sort by it ascending, click the active one to flip to
 * descending, click it again to clear back to the default (search-relevance /
 * dex-order) list order. Only one criterion is active at a time. */
export default function SortSection({ sort, onChange }: Props) {
  function cycle(key: (typeof SORT_KEYS)[number]) {
    if (sort.key !== key) onChange({ key, direction: 'asc' })
    else if (sort.direction === 'asc') onChange({ key, direction: 'desc' })
    else onChange(DEFAULT_SORT)
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
                  ? `Sorting by ${SORT_LABELS[key]} (${sort.direction === 'asc' ? 'ascending' : 'descending'}) — click to ${sort.direction === 'asc' ? 'reverse' : 'clear'}`
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
