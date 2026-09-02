import type { FilterState } from './filters'
import { EMPTY_FILTERS } from './filters'

const STAT_LABELS: Record<string, string> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spatk: 'SpA',
  spdef: 'SpD',
  spe: 'Spe',
  bst: 'BST',
}

interface Pill {
  key: string
  label: string
  clear: (f: FilterState) => FilterState
}

function buildPills(filters: FilterState): Pill[] {
  const pills: Pill[] = []
  for (const [type, state] of Object.entries(filters.types)) {
    pills.push({
      key: `type-${type}`,
      label: `${state === 'exclude' ? 'not ' : ''}${type}`,
      clear: (f) => ({ ...f, types: Object.fromEntries(Object.entries(f.types).filter(([t]) => t !== type)) }),
    })
  }
  for (const key of Object.keys(filters.statMin) as (keyof FilterState['statMin'])[]) {
    pills.push({
      key: `stat-${key}`,
      label: `${STAT_LABELS[key]} ≥ ${filters.statMin[key]}`,
      clear: (f) => ({ ...f, statMin: { ...f.statMin, [key]: undefined } }),
    })
  }
  if (filters.ability) {
    pills.push({ key: 'ability', label: `ability: ${filters.ability}`, clear: (f) => ({ ...f, ability: '' }) })
  }
  if (filters.innate) {
    pills.push({ key: 'innate', label: `innate: ${filters.innate}`, clear: (f) => ({ ...f, innate: '' }) })
  }
  return pills
}

export default function FilterPills({
  filters,
  onChange,
}: {
  filters: FilterState
  onChange: (f: FilterState) => void
}) {
  const pills = buildPills(filters)
  if (pills.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
      {pills.map((pill) => (
        <button
          key={pill.key}
          type="button"
          onClick={() => onChange(pill.clear(filters))}
          className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
        >
          {pill.label}
          <span aria-hidden>×</span>
        </button>
      ))}
      <button
        type="button"
        onClick={() => onChange(EMPTY_FILTERS)}
        className="text-xs underline"
        style={{ color: 'var(--color-text-muted)' }}
      >
        clear all
      </button>
    </div>
  )
}
