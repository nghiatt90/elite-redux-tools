import { useGameData } from '../../lib/GameDataContext'
import AbilityPopover from './AbilityPopover'

function AbilityCard({ id, align }: { id: string; align: 'left' | 'right' }) {
  const { abilitiesById } = useGameData()
  const ability = abilitiesById.get(id)
  if (!ability) return null
  return (
    <div className="rounded-md border p-2" style={{ borderColor: 'var(--color-border)' }}>
      <AbilityPopover ability={ability} align={align}>
        <div className="text-sm font-semibold underline decoration-dotted">{ability.name}</div>
      </AbilityPopover>
      <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
        {ability.description}
      </p>
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
    <div className="grid grid-cols-2 gap-3">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
          Abilities
        </h3>
        <div className="space-y-1.5">
          {abilities.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              None
            </p>
          ) : (
            abilities.map((id) => <AbilityCard key={id} id={id} align="left" />)
          )}
        </div>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
          Innates
        </h3>
        <div className="space-y-1.5">
          {innates.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              None
            </p>
          ) : (
            innates.map((id) => <AbilityCard key={id} id={id} align="right" />)
          )}
        </div>
      </div>
    </div>
  )
}
