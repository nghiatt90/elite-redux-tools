import { useGameData } from '../../lib/GameDataContext'
import { typeColor } from '../../lib/typeColors'
import { ALL_TYPES, STAT_KEYS, STAT_LABELS, type FilterState } from './filters'
import MultiSelectFilter from './MultiSelectFilter'
import SortSection from './SortSection'
import type { SortState } from './sort'
import StatRangeRow from './StatRangeRow'

interface Props {
  filters: FilterState
  onChange: (filters: FilterState) => void
  sort: SortState
  onSortChange: (sort: SortState) => void
  className?: string
}

export default function FilterRail({ filters, onChange, sort, onSortChange, className = 'w-56 shrink-0' }: Props) {
  const { abilities, moves } = useGameData()

  function cycleType(type: string) {
    const current = filters.types[type]
    const next = { ...filters.types }
    if (!current) next[type] = 'include'
    else if (current === 'include') next[type] = 'exclude'
    else delete next[type]
    onChange({ ...filters, types: next })
  }

  function setStatRange(key: keyof FilterState['statMin'], value: { min?: number; max?: number }) {
    const statMin = { ...filters.statMin }
    const statMax = { ...filters.statMax }
    if (value.min !== undefined) statMin[key] = value.min
    else delete statMin[key]
    if (value.max !== undefined) statMax[key] = value.max
    else delete statMax[key]
    onChange({ ...filters, statMin, statMax })
  }

  return (
    <div className={`${className} overflow-y-auto p-3 space-y-4 text-sm`}>
      <SortSection sort={sort} onChange={onSortChange} />

      <section>
        <h2 className="font-semibold mb-1.5">Type</h2>
        <div className="flex flex-wrap gap-1">
          {ALL_TYPES.map((type) => {
            const state = filters.types[type]
            const { bg, fg } = typeColor(type)
            return (
              <button
                key={type}
                type="button"
                onClick={() => cycleType(type)}
                title={
                  state === 'exclude'
                    ? `Excluding ${type} — click to clear`
                    : state === 'include'
                      ? `Including ${type} — click to exclude`
                      : `Click to include ${type}, shift-click-equivalent (click twice) to exclude`
                }
                className="rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide"
                style={{
                  background: state === 'exclude' ? 'transparent' : bg,
                  color: state === 'exclude' ? 'var(--color-text-muted)' : fg,
                  border: state ? `1px solid ${state === 'exclude' ? 'var(--color-danger)' : bg}` : '1px solid transparent',
                  textDecoration: state === 'exclude' ? 'line-through' : undefined,
                  opacity: state === 'exclude' ? 0.6 : 1,
                }}
              >
                {type}
              </button>
            )
          })}
        </div>
      </section>

      <section>
        <h2 className="font-semibold mb-1.5">Stats</h2>
        <div className="space-y-1.5">
          {STAT_KEYS.map((key) => (
            <StatRangeRow
              key={key}
              label={STAT_LABELS[key]}
              domainMin={0}
              domainMax={key === 'bst' ? 1000 : 255}
              step={key === 'bst' ? 10 : 5}
              min={filters.statMin[key]}
              max={filters.statMax[key]}
              onChange={(value) => setStatRange(key, value)}
            />
          ))}
        </div>
      </section>

      <MultiSelectFilter
        label="Ability / Innate"
        placeholder="Add an ability or innate…"
        options={abilities}
        selected={filters.abilityOrInnate}
        onChange={(ids) => onChange({ ...filters, abilityOrInnate: ids })}
      />

      <MultiSelectFilter
        label="Moves"
        placeholder="Add a move…"
        options={moves}
        selected={filters.moves}
        onChange={(ids) => onChange({ ...filters, moves: ids })}
      />
    </div>
  )
}
