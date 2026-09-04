import { useMemo, useState } from 'react'
import AbilitiesPanel from '../pokedex/AbilitiesPanel'
import AbilityPopover from '../pokedex/AbilityPopover'
import { useGameData } from '../../lib/GameDataContext'
import { formatPid } from '../../lib/hex'

export interface DisplayMatch {
  key: string
  pid: number
  abilityNum: number // 0-based declared ability-slot index the player must pick
  slotCost: number
  /** AbilityEnum ids for every declared ability slot, in slot order -- the whole
   * in-game ability picker, not just the one `abilityNum` selects. */
  abilityResults: string[]
  /** AbilityEnum ids for the innates (all live at once). */
  innates: string[]
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

/** One row of ability names as inline chips. Names only -- the description is a hover
 * away via AbilityPopover and the full cards are behind the row's Details toggle;
 * printing every description inline made a 20-result list unreadably tall. */
function ChipRow({
  label,
  ids,
  selectedIndex,
}: {
  label: string
  ids: string[]
  /** Ability row only: the slot this result was solved against. Not always a forced
   * pick -- when an innate satisfies the lock, every ability option works and this is
   * just the one the search settled on (the lowest index). */
  selectedIndex?: number
}) {
  const { abilitiesById } = useGameData()
  // A species whose declared slots are all the same ability is a real pattern, not a
  // pipeline bug -- collapse those to one chip. Partial repeats stay, since "slots 1
  // and 3 both give X, slot 2 gives Y" is information.
  const allSame = ids.length > 1 && ids.every((id) => id === ids[0])
  const shown = allSame ? [ids[0]] : ids

  return (
    <div className="flex items-baseline gap-1.5 flex-wrap">
      <span
        className="text-[10px] uppercase tracking-wide shrink-0 w-14"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {label}
      </span>
      {shown.length === 0 && (
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          None
        </span>
      )}
      {shown.map((id, i) => {
        const ability = abilitiesById.get(id)
        if (!ability) return null
        const selected = selectedIndex !== undefined && (allSame || i === selectedIndex)
        return (
          <AbilityPopover
            key={`${id}-${i}`}
            ability={ability}
            align={i > 0 && i === shown.length - 1 ? 'right' : 'left'}
          >
            <span
              className="text-xs rounded px-1.5 py-0.5 border inline-block"
              style={{
                borderColor: selected ? 'var(--color-accent, var(--color-text))' : 'var(--color-border)',
                fontWeight: selected ? 600 : undefined,
              }}
              title={selected ? `Ability slot ${i + 1} -- the option this result assumes you pick` : undefined}
            >
              {ability.name}
            </span>
          </AbilityPopover>
        )
      })}
    </div>
  )
}

function MatchRow({ match }: { match: DisplayMatch }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--color-border)' }}>
      <div className="flex items-center justify-between gap-2 mb-1 flex-wrap text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold">{formatPid(match.pid)}</span>
          {match.speciesName && <span>{match.speciesName}</span>}
          <span style={{ color: 'var(--color-text-muted)' }}>slot {match.abilityNum + 1}</span>
        </div>
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--color-text-muted)' }}>
            {match.slotCost} slot{match.slotCost === 1 ? '' : 's'} used
          </span>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded border px-1.5 py-0.5"
            style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
            aria-expanded={open}
          >
            {open ? 'Less' : 'Details'}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <ChipRow label="Abilities" ids={match.abilityResults} selectedIndex={match.abilityNum} />
        <ChipRow label="Innates" ids={match.innates} />
      </div>

      {open && (
        <div className="mt-2 pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
          <AbilitiesPanel abilities={match.abilityResults} innates={match.innates} />
        </div>
      )}
    </div>
  )
}

export default function ResultsView({
  total,
  exact,
  bySlotCost,
  ranked,
  sample,
}: {
  total: number | null
  exact: boolean
  bySlotCost: [number, number][]
  /** Up to DISPLAY_COUNT matches already ordered by slot cost -- shown as-is on the
   * first render, so the most efficient spreads are what you see first. */
  ranked: DisplayMatch[]
  /** Reservoir of matches to draw fresh random rows from on reroll. */
  sample: DisplayMatch[]
}) {
  const [rerolls, setRerolls] = useState(0)

  // Reroll deliberately abandons the slot-cost ordering: the first view answers "what
  // is the best I can do", every reroll after it answers "show me something else".
  const displayed = useMemo(() => {
    if (rerolls === 0) return ranked
    return pickRandom(sample, DISPLAY_COUNT)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranked, sample, rerolls])

  const sortedBreakdown = [...bySlotCost].sort((a, b) => a[0] - b[0])
  const canReroll = total !== null && total > ranked.length && sample.length > 0

  return (
    <div className="flex flex-col gap-3">
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

      {displayed.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {!canReroll ? 'All matches' : rerolls === 0 ? 'Fewest slots used' : 'Random matches'}
            </h3>
            {canReroll && (
              <button
                type="button"
                onClick={() => setRerolls((s) => s + 1)}
                className="text-xs rounded-md border px-2 py-1"
                style={{ borderColor: 'var(--color-border)' }}
              >
                🎲 Reroll
              </button>
            )}
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
            {displayed.map((m) => (
              <MatchRow key={m.key} match={m} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
