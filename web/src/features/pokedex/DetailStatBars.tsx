import { useMemo } from 'react'
import { useGameData } from '../../lib/GameDataContext'
import type { BaseStats } from '../../lib/types'
import { bst } from './filters'
import { buildPercentileIndex, percentileOf, type StatKey } from './percentiles'

const ROWS: { key: StatKey; label: string }[] = [
  { key: 'hp', label: 'HP' },
  { key: 'atk', label: 'Attack' },
  { key: 'def', label: 'Defense' },
  { key: 'spatk', label: 'Sp. Atk' },
  { key: 'spdef', label: 'Sp. Def' },
  { key: 'spe', label: 'Speed' },
]

const STAT_MAX = 200 // generous headroom for display purposes; a few legendaries cap visually

export default function DetailStatBars({ stats }: { stats: BaseStats }) {
  const { species } = useGameData()
  const index = useMemo(() => buildPercentileIndex(species), [species])
  const total = bst(stats)

  return (
    <div className="space-y-1.5">
      {ROWS.map(({ key, label }) => {
        const value = key === 'bst' ? total : stats[key as keyof BaseStats]
        const pct = percentileOf(index, key, value)
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {label}
            </span>
            <span className="w-8 shrink-0 text-sm font-semibold tabular-nums text-right">{value}</span>
            <div
              className="flex-1 h-3 rounded-sm overflow-hidden"
              style={{ background: 'var(--color-bg-hover)' }}
            >
              <div
                className="h-full rounded-sm"
                style={{
                  width: `${Math.min(100, (value / STAT_MAX) * 100)}%`,
                  background: 'var(--color-accent)',
                }}
              />
            </div>
            <span className="w-24 shrink-0 text-xs text-right" style={{ color: 'var(--color-text-muted)' }}>
              top {100 - pct}%
            </span>
          </div>
        )
      })}
      <div className="flex items-center gap-2 pt-1 border-t" style={{ borderColor: 'var(--color-border)' }}>
        <span className="w-16 shrink-0 text-xs font-semibold">BST</span>
        <span className="flex-1 text-sm font-semibold tabular-nums">{total}</span>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          top {100 - percentileOf(index, 'bst', total)}%
        </span>
      </div>
    </div>
  )
}
