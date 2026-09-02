import { useMemo } from 'react'
import { useGameData } from '../../lib/GameDataContext'
import TypeChip from '../../components/TypeChip'
import { defensiveMatchups, groupByMultiplier } from './typeEffectiveness'

function label(multiplier: number) {
  if (multiplier === 0) return 'Immune'
  if (multiplier < 1) return `${multiplier}× damage taken`
  return `${multiplier}× damage taken`
}

export default function DefensiveMatchupGrid({ types }: { types: string[] }) {
  const { typeChart } = useGameData()
  const groups = useMemo(() => groupByMultiplier(defensiveMatchups(types, typeChart)), [types, typeChart])

  if (groups.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
        No type advantages or disadvantages.
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {groups.map(([multiplier, typeList]) => (
        <div key={multiplier} className="flex items-center gap-2">
          <span
            className="w-32 shrink-0 text-xs"
            style={{ color: multiplier > 1 ? 'var(--color-danger)' : 'var(--color-text-muted)' }}
          >
            {label(multiplier)}
          </span>
          <div className="flex flex-wrap gap-1">
            {typeList.map((t) => (
              <TypeChip key={t} type={t} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
