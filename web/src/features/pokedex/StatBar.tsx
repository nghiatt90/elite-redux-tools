import { statColor } from '../../lib/statColor'
import type { BaseStats } from '../../lib/types'

const STAT_ORDER: (keyof BaseStats)[] = ['hp', 'atk', 'def', 'spatk', 'spdef', 'spe']
const STAT_MAX = 200 // generous headroom; a handful of legendaries exceed this and just cap visually

export default function StatBar({ stats, className }: { stats: BaseStats; className?: string }) {
  return (
    <div className={`flex items-end gap-px h-5 w-14 ${className ?? ''}`} title={statTitle(stats)}>
      {STAT_ORDER.map((key) => {
        const value = stats[key]
        const pct = Math.min(100, (value / STAT_MAX) * 100)
        return (
          <span
            key={key}
            className="w-1.5 rounded-sm"
            style={{
              height: `${Math.max(8, pct)}%`,
              background: statColor(value),
            }}
          />
        )
      })}
    </div>
  )
}

function statTitle(stats: BaseStats) {
  const bst = STAT_ORDER.reduce((sum, k) => sum + stats[k], 0)
  return `HP ${stats.hp} / Atk ${stats.atk} / Def ${stats.def} / SpA ${stats.spatk} / SpD ${stats.spdef} / Spe ${stats.spe} — BST ${bst}`
}

export function bst(stats: BaseStats) {
  return STAT_ORDER.reduce((sum, k) => sum + stats[k], 0)
}
