import { useGameData } from '../../lib/GameDataContext'
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

function buildPills(
  filters: FilterState,
  resolveAbilityName: (id: string) => string,
  resolveMoveName: (id: string) => string,
): Pill[] {
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
  for (const id of filters.abilityOrInnate) {
    pills.push({
      key: `ability-${id}`,
      label: resolveAbilityName(id),
      clear: (f) => ({ ...f, abilityOrInnate: f.abilityOrInnate.filter((a) => a !== id) }),
    })
  }
  for (const id of filters.moves) {
    pills.push({
      key: `move-${id}`,
      label: resolveMoveName(id),
      clear: (f) => ({ ...f, moves: f.moves.filter((m) => m !== id) }),
    })
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
  const { abilitiesById, movesById } = useGameData()
  const resolveAbilityName = (id: string) => abilitiesById.get(id)?.name ?? id
  const resolveMoveName = (id: string) => movesById.get(id)?.name ?? id

  const pills = buildPills(filters, resolveAbilityName, resolveMoveName)
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
