import { useGameData } from '../../lib/GameDataContext'
import { typeColor } from '../../lib/typeColors'
import { ALL_TYPES, type FilterState } from './filters'
import MultiSelectFilter from './MultiSelectFilter'

const STAT_LABELS: Record<string, string> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spatk: 'SpA',
  spdef: 'SpD',
  spe: 'Spe',
  bst: 'BST',
}

interface Props {
  filters: FilterState
  onChange: (filters: FilterState) => void
  className?: string
}

export default function FilterRail({ filters, onChange, className = 'w-56 shrink-0' }: Props) {
  const { abilities, moves } = useGameData()

  function cycleType(type: string) {
    const current = filters.types[type]
    const next = { ...filters.types }
    if (!current) next[type] = 'include'
    else if (current === 'include') next[type] = 'exclude'
    else delete next[type]
    onChange({ ...filters, types: next })
  }

  function setStatMin(key: keyof FilterState['statMin'], value: number) {
    const next = { ...filters.statMin }
    if (value > 0) next[key] = value
    else delete next[key]
    onChange({ ...filters, statMin: next })
  }

  return (
    <div className={`${className} overflow-y-auto p-3 space-y-4 text-sm`}>
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
        <h2 className="font-semibold mb-1.5">Minimum stats</h2>
        <div className="space-y-1.5">
          {(['hp', 'atk', 'def', 'spatk', 'spdef', 'spe', 'bst'] as const).map((key) => (
            <label key={key} className="flex items-center gap-2">
              <span className="w-9 shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {STAT_LABELS[key]}
              </span>
              <input
                type="range"
                min={0}
                max={key === 'bst' ? 1000 : 255}
                step={key === 'bst' ? 10 : 5}
                value={filters.statMin[key] ?? 0}
                onChange={(e) => setStatMin(key, Number(e.target.value))}
                className="flex-1 min-w-0"
              />
              <span className="w-8 shrink-0 text-right text-xs tabular-nums">{filters.statMin[key] ?? 0}</span>
            </label>
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
