import { useGameData } from '../../lib/GameDataContext'
import AbilityPopover from './AbilityPopover'

function AbilityCard({ id, align, fill }: { id: string; align: 'left' | 'right'; fill: boolean }) {
  const { abilitiesById } = useGameData()
  const ability = abilitiesById.get(id)
  if (!ability) return null
  return (
    <div
      className={`rounded-md border p-2 ${fill ? 'flex-1 flex flex-col justify-center' : ''}`}
      style={{ borderColor: 'var(--color-border)' }}
    >
      <AbilityPopover ability={ability} align={align}>
        <div className="text-sm font-semibold underline decoration-dotted">{ability.name}</div>
      </AbilityPopover>
      <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
        {ability.description}
      </p>
    </div>
  )
}

/** One column of ability/innate cards. When there's exactly one unique entry, that
 * card stretches (`fill`) to match the sibling column's full height instead of
 * sitting at its own natural (shorter) height with dead space below it -- e.g. a
 * species whose 3 declared ability slots are all the same ability (a real pattern in
 * the data, not a pipeline bug -- see dedupe below) shows one card as tall as the 3
 * stacked innate cards next to it, rather than 3 identical duplicate cards.
 */
function AbilityColumn({ label, ids, align }: { label: string; ids: string[]; align: 'left' | 'right' }) {
  const unique = [...new Set(ids)]
  const fill = unique.length === 1

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <h3 className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </h3>
      <div className="flex-1 flex flex-col gap-1.5">
        {unique.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            None
          </p>
        ) : (
          unique.map((id) => <AbilityCard key={id} id={id} align={align} fill={fill} />)
        )}
      </div>
    </div>
  )
}

export default function AbilitiesPanel({
  abilities,
  innates,
}: {
  abilities: string[]
  innates: string[]
}) {
  return (
    <div className="flex gap-3 items-stretch">
      <AbilityColumn label="Abilities" ids={abilities} align="left" />
      <AbilityColumn label="Innates" ids={innates} align="right" />
    </div>
  )
}
