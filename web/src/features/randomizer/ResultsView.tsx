import { useMemo, useState } from 'react'
import AbilitiesPanel from '../pokedex/AbilitiesPanel'
import { formatHex } from '../../lib/hex'

export interface DisplayMatch {
  key: string
  pid: number
  abilityNum: number // 0-based declared ability-slot index the player must pick
  slotCost: number
  resultAbilities: string[] // AbilityEnum ids: [active, ...innates]
  speciesName?: string
}

const DISPLAY_COUNT = 20

function pickRandom<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr
  const copy = [...arr]
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

function MatchRow({ match, promoted }: { match: DisplayMatch; promoted: boolean }) {
  return (
    <div
      className="rounded-md border p-2.5"
      style={{
        borderColor: promoted ? 'var(--color-accent, var(--color-border))' : 'var(--color-border)',
        background: promoted ? 'var(--color-bg-hover)' : undefined,
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono font-semibold">{formatHex(match.pid)}</span>
          {match.speciesName && <span>{match.speciesName}</span>}
          <span style={{ color: 'var(--color-text-muted)' }}>ability slot {match.abilityNum + 1}</span>
        </div>
        <span
          className="text-xs rounded-full px-2 py-0.5 border"
          style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
        >
          slot cost {match.slotCost}
        </span>
      </div>
      <AbilitiesPanel abilities={[match.resultAbilities[0]]} innates={match.resultAbilities.slice(1)} />
    </div>
  )
}

export default function ResultsView({
  total,
  exact,
  bySlotCost,
  promoted,
  sample,
}: {
  total: number | null
  exact: boolean
  bySlotCost: [number, number][]
  promoted: DisplayMatch[]
  sample: DisplayMatch[]
}) {
  const [rerollSeed, setRerollSeed] = useState(0)

  const displayedSample = useMemo(() => {
    if (total !== null && total <= DISPLAY_COUNT) return sample
    return pickRandom(sample, DISPLAY_COUNT)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, total, rerollSeed])

  const sortedBreakdown = [...bySlotCost].sort((a, b) => a[0] - b[0])
  const showAll = total !== null && total <= DISPLAY_COUNT

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm">
          {total === null ? (
            <span style={{ color: 'var(--color-text-muted)' }}>No matches found.</span>
          ) : (
            <>
              <span className="font-semibold">{total.toLocaleString()}</span>{' '}
              {exact ? 'matching PIDs' : '(estimated) matching PIDs'}
            </>
          )}
        </p>
        {sortedBreakdown.length > 0 && (
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            {sortedBreakdown.map(([cost, count], i) => (
              <span key={cost}>
                {i > 0 && ' · '}
                {count.toLocaleString()} use {cost} slot{cost === 1 ? '' : 's'}
              </span>
            ))}
          </p>
        )}
      </div>

      {promoted.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
            Most efficient matches
          </h3>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {promoted.map((m) => (
              <MatchRow key={m.key} match={m} promoted />
            ))}
          </div>
        </section>
      )}

      {sample.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
              {showAll ? 'All matches' : `${DISPLAY_COUNT} random matches`}
            </h3>
            {!showAll && (
              <button
                type="button"
                onClick={() => setRerollSeed((s) => s + 1)}
                className="text-xs rounded-md border px-2 py-1"
                style={{ borderColor: 'var(--color-border)' }}
              >
                🎲 Reroll
              </button>
            )}
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {displayedSample.map((m) => (
              <MatchRow key={m.key} match={m} promoted={false} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
