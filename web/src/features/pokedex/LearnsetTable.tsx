import { useMemo, useState } from 'react'
import { useGameData } from '../../lib/GameDataContext'
import TypeChip from '../../components/TypeChip'
import type { Species } from '../../lib/types'

type Tab = 'levelUp' | 'tutor'

const SPLIT_LABEL: Record<string, string> = { PHYSICAL: 'Phys', SPECIAL: 'Spec', STATUS: 'Status' }

export default function LearnsetTable({ learnset }: { learnset: Species['learnset'] }) {
  const { movesById } = useGameData()
  const [tab, setTab] = useState<Tab>('levelUp')

  const rows = useMemo(() => {
    if (tab === 'levelUp') {
      return learnset.levelUp
        .flatMap((entry) => entry.moves.map((moveId) => ({ level: entry.level, moveId })))
        .sort((a, b) => a.level - b.level)
    }
    return learnset.tutor
      .map((moveId) => ({ level: null as number | null, moveId }))
      .sort((a, b) => {
        const na = movesById.get(a.moveId)?.name ?? ''
        const nb = movesById.get(b.moveId)?.name ?? ''
        return na.localeCompare(nb)
      })
  }, [tab, learnset, movesById])

  return (
    <div>
      <div className="flex gap-1 mb-2">
        {(['levelUp', 'tutor'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="rounded-md px-2 py-1 text-xs font-medium"
            style={{
              background: tab === t ? 'var(--color-accent)' : 'var(--color-bg-hover)',
              color: tab === t ? 'var(--color-accent-contrast)' : 'var(--color-text)',
            }}
          >
            {t === 'levelUp' ? `Level-up (${learnset.levelUp.reduce((n, e) => n + e.moves.length, 0)})` : `Tutor (${learnset.tutor.length})`}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--color-border)' }}>
        <table className="w-full text-xs min-w-[420px]">
          <thead>
            <tr style={{ color: 'var(--color-text-muted)' }} className="border-b" >
              {tab === 'levelUp' && <th className="text-left px-2 py-1 w-12">Lv.</th>}
              <th className="text-left px-2 py-1">Move</th>
              <th className="text-left px-2 py-1 w-20">Type</th>
              <th className="text-left px-2 py-1 w-14">Cat.</th>
              <th className="text-right px-2 py-1 w-12">Pwr</th>
              <th className="text-right px-2 py-1 w-12">Acc</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const move = movesById.get(row.moveId)
              if (!move) return null
              return (
                <tr key={`${row.moveId}-${i}`} className="border-b" style={{ borderColor: 'var(--color-border)' }}>
                  {tab === 'levelUp' && <td className="px-2 py-1 tabular-nums">{row.level}</td>}
                  <td className="px-2 py-1 font-medium">{move.name}</td>
                  <td className="px-2 py-1">{move.type && <TypeChip type={move.type} />}</td>
                  <td className="px-2 py-1" style={{ color: 'var(--color-text-muted)' }}>
                    {move.split ? SPLIT_LABEL[move.split] : '—'}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{move.power || '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{move.accuracy || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
